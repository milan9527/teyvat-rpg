// Procedural terrain: chunked LOD mesh built from the SHARED heightAt() so the
// visual ground matches the server's collision exactly, with biome splat blending,
// triplanar-ish detail, cliff striation, snow/wetness and distance haze.

import * as THREE from 'three';
import { heightAt, normalAt, slopeAt } from '@teyvat/shared/data/zones.js';
import { fbm2, valueNoise2 } from '@teyvat/shared/sim/rng.js';

const CHUNK = 64;          // world units per chunk

/**
 * Course of the flagstones on an indoor arena floor, in metres.
 *
 * Exported and interpolated into the fragment shader rather than written as a literal in
 * both places, because `ui/mapview.js#bakeArenaFloor` draws the same grid on the minimap
 * and its comment already promises the two agree. They did, at 3.0, by luck.
 */
export const ARENA_SLAB = 1.5;

// Resolution per LOD ring (verts across a chunk edge).
const LOD_RES = [64, 32, 16, 8];

// The shadow chunks are included by hand because this is a raw-ish ShaderMaterial
// rather than a patched MeshStandardMaterial: `shadowmap_pars_vertex` declares
// vDirectionalShadowCoord and `shadowmap_vertex` fills it, but the latter reads two
// variables by name — `worldPosition` and `transformedNormal` — so both have to
// exist under exactly those names before the include.
const TERRAIN_VERT = /* glsl */`
#include <common>
#include <shadowmap_pars_vertex>
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNrm;
varying float vSlope;
varying float vHeight;
varying vec4 vSplat;
attribute vec4 splat;
attribute float aoBake;
varying float vAO;

void main() {
  vSplat = splat;
  vAO = aoBake;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNrm = normalize(mat3(modelMatrix) * normal);
  vSlope = 1.0 - vNrm.y;
  vHeight = wp.y;
  vec4 worldPosition = wp;
  vec3 transformedNormal = normalMatrix * normal;
  #include <shadowmap_vertex>
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// No backticks in the comments below: this is a template literal, so a `like this` in a GLSL
// comment closes the string and the build fails 200 lines later with "Expected a semicolon".
const TERRAIN_FRAG = /* glsl */`
precision highp float;
#include <common>
#include <packing>
#include <shadowmap_pars_fragment>
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uAmbSky;
uniform vec3  uAmbGround;
uniform float uAmbInt;
uniform vec3  uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uTime;
uniform float uWaterLevel;
uniform vec3  uWaterColor;
uniform vec3  uColA;          // biome colours
uniform vec3  uColB;
uniform vec3  uColC;
uniform vec3  uColD;
uniform vec3  uCliffColor;
uniform float uSnowLine;
uniform float uSnowBlend;
uniform vec3  uSnowColor;
uniform float uBands;
uniform vec3  uShadowTint;
uniform float uDetail;
uniform float uArenaR;        // indoor arena radius, 0 outdoors
uniform vec3  uInlayColor;    // colour of the floor inlay in an indoor arena
uniform float uInlayMix;      // how hard that colour is mixed in (per zone)
uniform vec4  uGloss;         // 1 - biomes[i].rough, per biome, blended by the same splat

varying vec3 vWorld;
varying vec3 vNrm;
varying float vSlope;
varying float vHeight;
varying vec4 vSplat;
varying float vAO;

// --- cheap value noise (hash based) ----------------------------------------
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1, 0));
  float c = hash21(i + vec2(0, 1)), d = hash21(i + vec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

void main() {
  // ---- base biome blend from the vertex splat weights ---------------------
  vec4 w = vSplat;
  float tot = max(w.x + w.y + w.z + w.w, 0.0001);
  w /= tot;
  vec3 base = uColA * w.x + uColB * w.y + uColC * w.z + uColD * w.w;

  // ---- macro variation so large fields aren't flat ------------------------
  float macro = fbm(vWorld.xz * 0.011);
  float meso  = fbm(vWorld.xz * 0.075);
  base *= 0.86 + macro * 0.28;
  base = mix(base, base * vec3(1.06, 1.02, 0.92), meso * 0.35);

  // ---- hue drift and bare earth: the two things multipliers cannot do -------
  //
  // Everything below this point multiplies base, which changes its *value* and leaves
  // its *hue* alone, and a surface that is one hue at twenty brightnesses reads as flat
  // no matter how many octaves are stacked on it. Photographed from the gameplay camera
  // the Mondstadt plain was a single saturated green filling 70 % of the frame, with five
  // octaves of variation already active and none of them visible as anything but shading.
  //
  // The reason there is no second colour to be found is that the biome splat is decided by
  // slope and height alone: grass allows maxSlope 0.55 and any height, so flat ground
  // above the sand line resolves to 100 % grass and the other three biome colours never
  // get a look in on a meadow. So mix them in here, on a mask of their own.
  //
  // First a genuine hue rotation — warm yellow-green against cool blue-green over about
  // 30 m. This is deliberately a per-channel *ratio*, not a scale factor, so it survives
  // the brightness terms below instead of being averaged away by them.
  float hue = fbm(vWorld.xz * 0.034 + 11.3);
  base *= mix(vec3(0.94, 0.99, 1.07), vec3(1.09, 1.03, 0.87), hue);

  // Then bare earth showing through, which is a second material rather than a tint of the
  // first. Masked by the grass weight so it only appears where grass actually won the
  // splat — cliffs, sand and snow keep their own colours untouched. uColD is the fourth
  // biome, chosen because it is the one every zone defines as its ground-level "other":
  // dirt in Mondstadt, karst stone in Liyue, a second snow in Dragonspine, so the term
  // stays plausible everywhere without a per-zone table.
  // The band is wide and the ceiling high on purpose. A first pass used
  // smoothstep(0.58, 0.88) * 0.40, and photographed from the gameplay camera it was almost
  // invisible: fbm only clears 0.88 over a few percent of its area, so the patches were
  // both rare and never more than a light tint. Earth wants to actually reach earth colour
  // somewhere, over a decent fraction of the ground, or it is just another wash.
  float bare = fbm(vWorld.xz * 0.021 + 47.3);
  base = mix(base, uColD, smoothstep(0.48, 0.80, bare) * 0.62 * w.x);

  // ---- clump variation, at the scale of a patch of grass (2-3 m) -----------
  // Without a term at this frequency the ground is smooth between the 13 m meso
  // blotches and the 50 cm grain, and a wide field of it reads as billiard cloth
  // however many tufts get scattered on top. Bleached crowns and damp hollows pull
  // the hue in opposite directions, which is what keeps this from looking like
  // someone turning a brightness knob up and down.
  float clump = fbm(vWorld.xz * 0.42);
  base *= 0.90 + clump * 0.22;
  base = mix(base, base * vec3(1.11, 1.05, 0.80), smoothstep(0.52, 0.88, clump) * 0.45 * uDetail);
  base = mix(base, base * vec3(0.72, 0.92, 0.84), smoothstep(0.48, 0.12, clump) * 0.42 * uDetail);

  // ---- detail grain (per-texel breakup) ----------------------------------
  float grain = fbm(vWorld.xz * 1.9);
  base *= 0.90 + grain * 0.20 * uDetail;
  // One more octave, close to the size of a single blade: at a metre from the eye
  // the grain above is a smooth wash, and this is what stops the ground under the
  // player's feet from being the flattest thing on screen.
  float fine = vnoise(vWorld.xz * 5.5);
  base *= 0.94 + fine * 0.12 * uDetail;

  // ---- near-field turf ----------------------------------------------------
  // Streaks rather than blobs. Grass grows in a direction, and elongated texture is
  // what the eye reads as blades; isotropic noise at any frequency reads as dirt.
  // Two crossed sets so the pattern has no single visible axis.
  //
  // Faded out by 20 m because at 16 cycles/m the screen-space period drops below a
  // pixel almost immediately, and past that this is not detail, it is moire.
  //
  // Not indoors. Every term in this block is shaped like grass — crossed 17 cycles/m
  // streaks and a metre-wide mottle — and driving uDetail to 3.0 in 黄金屋 showed exactly
  // what that looks like on a palace floor: a muddy field with grout lines on it. The
  // arena branch below has its own near-field vocabulary (arris, vein, crack), so this
  // one is switched off rather than turned down.
  float camD = length(cameraPosition - vWorld);
  float indoor = step(1.0, uArenaR);
  float nearW = (1.0 - smoothstep(5.0, 20.0, camD)) * uDetail * (1.0 - indoor);
  float streak = 0.5;
  if (nearW > 0.002) {
    streak = vnoise(vec2(vWorld.x * 17.0 + vWorld.z * 2.5, vWorld.z * 4.5));
    float streak2 = vnoise(vec2(vWorld.x * 4.0, vWorld.z * 15.0 - vWorld.x * 2.5));
    base *= 1.0 + (streak - 0.5) * 0.19 * nearW + (streak2 - 0.5) * 0.14 * nearW;
    // Patchiness at about a metre, which is the one frequency band the ground was
    // missing: below the 2-3 m clumps and above the blade-wide streaks. Standing
    // still, this is the difference between turf and a smooth green gradient, and it
    // is only paid for inside the 20 m near-field window.
    float mottle = fbm(vWorld.xz * 0.95);
    base *= 1.0 + (mottle - 0.5) * 0.17 * nearW;
    base = mix(base, base * vec3(0.86, 0.95, 0.88), smoothstep(0.58, 0.22, mottle) * 0.24 * nearW);
  }

  // ---- indoor arena: inlaid floor ----------------------------------------
  // A dungeon floor is built, not grown, so it gets architecture instead of noise:
  // flagstones, concentric bands and radial spokes struck from the arena centre.
  // Without this the biome blend leaves a 130 m disc of one flat colour, which is
  // what made these halls read as open desert rather than as a room.
  if (uArenaR > 1.0) {
    float rad = length(vWorld.xz);
    float ang = atan(vWorld.z, vWorld.x);
    float floorMask = smoothstep(0.30, 0.10, vSlope);

    // ---- dressed stone ---------------------------------------------------
    //
    // What used to be here was a 3 m mortar grid over a per-cell brightness, and the
    // rest of the floor's texture was whatever the meadow terms above happened to leave
    // on it. Measured from the gameplay camera (tools/pixstd.mjs on a tour frame, quality
    // pinned high) that came to std 3.3 sRGB inside a flagstone and std 1.1 under the
    // inlay — featureless by this project's own rule of thumb, on the surface that fills
    // the bottom third of every frame in a dungeon. Four things were ruled out first, by
    // driving one uniform at a time: uColA magenta proved the rect was on the floor
    // biome, uGloss = 0 moved nothing (std 3.3 -> 3.5, so no specular wash), exposure
    // 1.12 -> 0.75 *lowered* std (3.3 -> 0.9, so unlike 龙脊雪山 this floor is not sitting
    // on the ACES shoulder — see sky.exposure), and uDetail 3.0 tripled it, which is what
    // says the terms are present and simply too small, and too grassy.
    //
    // So a cut slab gets a cut slab's vocabulary. Everything below builds one
    // multiplicative 'dress' factor rather than a colour, for the reason in the inlay
    // comment further down.
    // The course, in metres, interpolated from JS because ui/mapview.js draws the same
    // grid on the minimap and two copies of a number like this drift. It is 1.5 and not
    // the 3.0 it was for a reason the measurements above could not see: a 3 m flagstone
    // is bigger than the entire near field, so a rect 3 m from the eye contains no joint
    // at all and no amount of grain inside the slab fixes that. 1.5 m is also what a
    // palace floor is actually paved in — 方砖 run 0.6-1.2 m — and it puts two joints in
    // the bottom of every frame.
    float slabW = ${ARENA_SLAB.toFixed(2)};
    vec2 tuv = vWorld.xz / slabW;
    vec2 cell = floor(tuv);
    vec2 f = fract(tuv);
    float tid = hash21(cell);
    float tid2 = hash21(cell + 31.7);
    // Fine slab features (the vein highlight, cracks) are 2-10 cm wide, which is past what
    // a pixel holds beyond ~30 m; faded rather than left to alias, the same treatment the
    // cliff grain and the snow sparkle get. The joint and the arris are *not* faded — see
    // the note on 'aa' below, they widen instead, because the grid is the thing that says
    // the floor is paved and it has to survive to the far wall.
    float slabNear = 1.0 - smoothstep(26.0, 62.0, camD);

    // Per-slab tone *and* hue. The hue half is the one that matters: twenty brightnesses
    // of one paint still reads as one paint, which is the same argument as the field hue
    // rotation above, at the scale of a flagstone. Narrower than it was at 3 m courses:
    // the same +-16 % over four times as many slabs reads as a patchwork quilt. Widened
    // once from +-12 % to +-15 % after 深渊试炼场 measured std 2.8 on the same shader that
    // gave 黄金屋 10.2 — a dark floor spends its texture on fewer sRGB counts, so the two
    // halls need the *same* relative swing to be worth different absolute amounts, and
    // this is the cheapest place to pay for it.
    vec3 dress = vec3(0.85 + tid * 0.30);
    dress *= mix(vec3(1.07, 1.00, 0.90), vec3(0.91, 0.98, 1.09), tid2);

    // Veining, in one of four directions per slab so that neighbours do not share a
    // grain — a floor whose every slab veins the same way reads as one printed sheet.
    // Sampled in the slab's own frame and stretched 1:4, because a vein is a line.
    vec2 lp = vWorld.xz - (cell + 0.5) * slabW;
    float va = floor(tid2 * 4.0) * 0.7853982;
    lp = vec2(lp.x * cos(va) - lp.y * sin(va), lp.x * sin(va) + lp.y * cos(va));
    // Stretched across its own range before it is used, which is the trap the snow drift
    // fell into: four octaves of vnoise halving in amplitude concentrate hard around 0.5,
    // so raw fbm lives in roughly 0.25..0.78 and this +-11 % delivered about a third of
    // that. Measured inside one slab at 8 m it was std 2.8 sRGB — still flat — with the
    // joints doing all the work. The crack below rides the same value, so its own width is
    // widened to match the steeper gradient.
    float vein = smoothstep(0.28, 0.72, fbm(vec2(lp.x * 0.85, lp.y * 3.1) + tid * 37.0));
    dress *= 1.0 + (vein - 0.5) * 0.30;
    dress = mix(dress, dress * vec3(1.12, 1.07, 0.97),
                (1.0 - smoothstep(0.0, 0.11, abs(vein - 0.5))) * 0.5 * slabNear);

    // The joint and the arris. A flagstone's cut edge is the *brightest* part of it,
    // because it is the only part whose normal is not the floor's — and this floor is a
    // height field, so no geometry can supply that. It has to be albedo: a 7 cm bright
    // fillet just inside a 4 cm dark joint. That pair is what makes a grid of lines read
    // as slabs with thickness instead of a pattern painted on a slope.
    //
    // In *metres*, not in slab fractions, so that changing the course above does not
    // silently change the width of the joint. And 'aa' grows with distance: a 3 cm line is
    // a third of a pixel at 60 m, which is not a thin line, it is a crawling dotted one.
    // Widening the smoothstep with camD is the whole anti-aliasing strategy here — there is
    // no mip chain on procedural noise — and it costs one multiply.
    float edgeM = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * slabW;
    float aa = 0.012 + camD * 0.0016;
    float joint = 1.0 - smoothstep(aa, aa * 2.8, edgeM);
    float arris = (1.0 - smoothstep(aa * 2.8, aa * 2.8 + 0.07, edgeM)) * (1.0 - joint);
    dress *= 1.0 - joint * 0.40;
    dress *= 1.0 + arris * 0.26;

    // Wear and cracks: 遗迹, not a showroom. The wear mask both desaturates the polish
    // and gates the cracks, so the two agree instead of being scattered independently —
    // a crack through a mirror-polished slab is the tell of two unrelated noises.
    float worn = fbm(vWorld.xz * 0.055 + 9.1);
    dress = mix(dress, dress * vec3(0.90, 0.93, 0.96) * 0.93, smoothstep(0.44, 0.78, worn) * 0.5);
    // The crack rides the *vein*, which is why it is not its own noise. A separate
    // world-space fbm ridge was the first thing here and it photographed as brown worms
    // crawling across the whole disc: a low-frequency ridge is a long sinuous curve, it
    // ignores the joints, and it crosses forty slabs. A crack belongs to one slab, runs
    // with its grain, and stops at its edges — all three come free from a coordinate that
    // is already slab-local and already rotated per slab. Roughly a third of them crack,
    // by slab id, so an intact slab stays intact instead of every slab being 30 % cracked.
    float crack = (1.0 - smoothstep(0.0, 0.062, abs(vein - 0.5)))
                * step(0.70, tid) * smoothstep(0.34, 0.62, worn);
    dress *= 1.0 - crack * 0.34 * slabNear;

    // Near-field grit. Everything above is authored at slab scale (3 m) or vein scale
    // (30 cm), and a rect two metres from the eye inside one slab still measured std 3.7 —
    // the same number the meadow terms used to leave there. Stone at that range is pitted
    // and speckled, and the speckle is *isotropic*: streaks are what made the old near
    // field read as turf, so this one deliberately has no long axis. Windowed to 11 m
    // because 21 cycles/m is past what a pixel holds beyond that, same as the sparkle.
    float grit = (1.0 - smoothstep(2.5, 11.0, camD)) * uDetail;
    if (grit > 0.002) {
      float sp1 = vnoise(vWorld.xz * 7.5);
      float sp2 = vnoise(vWorld.xz * 21.0 + 3.7);
      dress *= 1.0 + (sp1 - 0.5) * 0.26 * grit + (sp2 - 0.5) * 0.16 * grit;
      dress *= 1.0 - smoothstep(0.86, 0.99, sp2) * 0.26 * grit;
    }

    vec3 floorCol = base * dress;

    // Concentric bands + spokes, in the trim colour. Two bands only: the point is a
    // centre to fight in, not a mandala.
    //
    // Flat-topped rather than triangular. 1.0 - smoothstep(0.0, 1.1, d) is a linear ramp
    // from the band's centre line, i.e. a soft smear 2.2 m across, and photographed from
    // the floor 黄金屋's bands read as green stains rather than as stone set into stone.
    // The radii and the widths stay where they are because ui/mapview.js#bakeArenaFloor
    // reproduces them.
    float ring1 = 1.0 - smoothstep(0.62, 0.80, abs(rad - uArenaR * 0.24));
    float ring2 = 1.0 - smoothstep(0.95, 1.15, abs(rad - uArenaR * 0.52));
    float spoke = (1.0 - smoothstep(0.0, 0.030, abs(fract(ang / 6.2831853 * 8.0 + 0.5) - 0.5)))
                * smoothstep(uArenaR * 0.16, uArenaR * 0.22, rad)
                * (1.0 - smoothstep(uArenaR * 0.5, uArenaR * 0.56, rad));
    float inlay = clamp(ring1 + ring2 + spoke, 0.0, 1.0) * floorMask;
    // Per zone ('terrain.inlayStrength', default 0.45), because the right strength is a
    // property of the *colour*: a bright trim at full strength goes straight into the bloom
    // threshold and the spokes flare into a solid cross of light across the near floor,
    // while 黄金屋's dark jade at 0.45 was a pattern that existed in the data and not on the
    // screen. One constant could satisfy one of those two and never both.
    //
    // 'uInlayColor * dress', not 'uInlayColor': an inlay is a second stone set into the
    // first, so the joints, the veins, the arris and the wear all run straight through it.
    // Mixing toward a bare colour instead *erased* them in proportion to the mix, and
    // 黄金屋 mixes at 0.72 — measured std inside a jade spoke was 1.9 against 6.9 for the
    // gold slab beside it, and under the medallion 1.1 against 3.3. The strongest inlay in
    // the game was therefore also the flattest region of its floor, which is the opposite
    // of what authoring a strong inlay is for.
    floorCol = mix(floorCol, uInlayColor * dress, inlay * uInlayMix);

    // Centre medallion, faintly lit: the eye needs a focal point in the arena. Its strength
    // is derived from the band strength rather than authored separately — two numbers a
    // zone has to keep in agreement is two numbers that will disagree.
    float medal = 1.0 - smoothstep(uArenaR * 0.055, uArenaR * 0.075, rad);
    floorCol = mix(floorCol, uInlayColor * dress * 1.05, medal * uInlayMix * 0.9 * floorMask);

    base = mix(base, floorCol, floorMask);
  }

  // ---- cliffs: striated rock on steep faces ------------------------------
  // The rock/turf boundary is noise-perturbed rather than a pure slope threshold. A
  // hillside has grass running up its gullies and rock breaking out through the turf;
  // a clean smoothstep on slope draws a contour line instead, which is what made
  // these hills read as a shaded height map with a green half and a grey half.
  float cliffN = fbm(vWorld.xz * 0.33);
  float cliff = smoothstep(0.32, 0.62, vSlope + (cliffN - 0.5) * 0.17);
  if (cliff > 0.002) {
    // Bedding planes, tilted and warped along their length. Strata struck exactly
    // horizontal look like map contours — real beds are tipped a few degrees and
    // follow a surface that folds.
    float bed = vWorld.y + vWorld.x * 0.14 - vWorld.z * 0.10 + fbm(vWorld.xz * 0.035) * 6.0;
    // Coarse beds (~3 m) carry the form and are safe at any viewing distance.
    float strata = fbm(vec2(bed * 0.34, (vWorld.x + vWorld.z) * 0.055));
    // The fine grain is ~40 cm, and procedural noise has no mip chain: past ~60 m one
    // pixel spans several bands and the whole face shimmers as the camera turns. Fade
    // it out with distance and put its mean back, rather than letting it alias.
    float rockNear = (1.0 - smoothstep(30.0, 75.0, camD)) * uDetail;
    strata = strata * 0.72
           + fbm(vec2(bed * 2.3, (vWorld.x - vWorld.z) * 0.4)) * 0.28 * rockNear
           + 0.14 * (1.0 - rockNear);
    vec3 rock = uCliffColor * (0.70 + strata * 0.58);
    // Two mineral tints drifting across the face at 40-50 m so that a whole wall is
    // not one grey: iron staining warm, shaded stone cool.
    float vein = fbm(vWorld.xz * 0.022 + vec2(bed * 0.01, 0.0));
    rock = mix(rock, rock * vec3(1.14, 0.99, 0.86), smoothstep(0.55, 0.85, vein) * 0.55);
    rock = mix(rock, rock * vec3(0.88, 0.94, 1.08), smoothstep(0.45, 0.15, vein) * 0.45);
    // Ledges: a soft step on the bed coordinate, giving each band a lit top edge.
    float ledge = smoothstep(0.42, 0.50, fract(bed * 0.33 + strata * 0.35));
    rock = mix(rock, rock * vec3(1.12, 1.07, 1.00), ledge * 0.22);
    // Moss on the flatter shelves, below the snow line — the thing that ties a cliff
    // to the meadow it rises out of, since it borrows the meadow's own colour.
    float moss = smoothstep(0.62, 0.34, vSlope)
               * smoothstep(0.62, 0.80, fbm(vWorld.xz * 0.19))
               * (1.0 - smoothstep(uSnowLine - 12.0, uSnowLine, vHeight));
    rock = mix(rock, mix(rock, base * 1.05, 0.6), moss);
    base = mix(base, rock, cliff);
  }

  // ---- snow on high, flat ground -----------------------------------------
  float snow = smoothstep(uSnowLine - uSnowBlend, uSnowLine + uSnowBlend, vHeight)
             * smoothstep(0.55, 0.18, vSlope);
  snow *= 0.7 + fbm(vWorld.xz * 0.09) * 0.5;
  snow = clamp(snow, 0.0, 1.0);
  if (snow > 0.002) {
    // Snow is not flat white. Wind lays it in drifts with a long axis, and the troughs
    // between them see only sky, so they go blue — mixing a single constant colour in
    // left Dragonspine's ground as the one surface in the game with no texture at all,
    // which is also why its slopes were impossible to read while running down them.
    vec3 sc = uSnowColor;
    float drift = vnoise(vec2(vWorld.x * 0.09 + vWorld.z * 0.26, vWorld.z * 0.055)) * 0.62
                + vnoise(vec2(vWorld.x * 0.50 + vWorld.z * 1.20, vWorld.z * 0.30)) * 0.38;
    // Amplitude and *contrast*, both measured rather than chosen. Two things were wrong at
    // 0.93 + drift * 0.10: the swing was tiny, and the surface it swung was sitting on the ACES
    // shoulder (fixed by this zone's exposure, see sky.exposure). What was left after that is
    // the reason a drift can be authored and still not exist — two summed vnoises concentrate
    // around 0.5, so raw 'drift' lives in roughly 0.25..0.78 and a linear scale of it moved the
    // albedo by about +-6 %, which measured as std 4.6 sRGB over a metre-scale patch: a
    // featureless surface by this project's own rule of thumb. Stretching the noise across its
    // own range first is what lets the +-20 % below actually reach +-20 %.
    drift = smoothstep(0.22, 0.78, drift);
    sc *= 0.80 + drift * 0.40;
    sc = mix(sc * vec3(0.86, 0.91, 1.06), sc, smoothstep(0.0, 0.62, drift));
    // Sparkle: sparse, sharp glints, and only within a few metres — the frequency is
    // far past what a pixel can hold at any distance, so it is faded out rather than
    // left to alias into a crawling grey film.
    float spk = vnoise(vWorld.xz * 26.0);
    sc += vec3(0.34) * smoothstep(0.93, 0.995, spk)
        * (1.0 - smoothstep(4.0, 14.0, camD)) * uDetail;
    // Sastrugi: the wind-carved ridges that are what a snowfield actually looks like from
    // standing height. The drift above is an 11 m dune with a 1-2 m second octave, so a metre
    // -scale patch at the player's feet sits *inside* one drift and sees none of it; the
    // sparkle is a sparse glint. Between 30 cm and 2 m there was nothing at all, and that gap
    // is the whole reason this ground measured std 3.9 with every term above it running.
    // Stretched 4:1 along the wind (fast across x+3z, slow along it) so it reads as combed
    // ridges rather than as noise, and stretched across its own range for the reason the
    // drift is — a summed fbm concentrates around 0.5 and a linear scale of the raw value
    // delivers a third of what it says.
    float sast = fbm(vec2(vWorld.x * 0.34 + vWorld.z * 1.35, vWorld.x * 0.40));
    sast = smoothstep(0.30, 0.70, sast);
    float sastW = (1.0 - smoothstep(14.0, 40.0, camD)) * uDetail;
    sc *= 1.0 + (sast - 0.5) * 0.30 * sastW;
    // The lee face of a ridge sees sky and not sun, so it goes blue as it goes dark. This is
    // the same reason the drift troughs are blue, one scale down.
    sc = mix(sc * vec3(0.84, 0.90, 1.06), sc, smoothstep(0.0, 0.55, sast) * sastW + (1.0 - sastW));
    // Crust: the granulation inside one ridge. Snow scatters, so its close-up texture is the
    // little sky-blue shadow pits *between* grains and not bright specks — a bright dot reads
    // as ice, and the sparkle term above already owns that. So the darkening is the term that
    // does the work here and the symmetric wobble only keeps the crust from looking stippled.
    float crust = (1.0 - smoothstep(3.0, 17.0, camD)) * uDetail;
    if (crust > 0.002) {
      float cg = vnoise(vWorld.xz * 4.2);
      float cg2 = vnoise(vWorld.xz * 12.5 + 5.1);
      sc *= 1.0 + (cg - 0.5) * 0.20 * crust + (cg2 - 0.5) * 0.12 * crust;
      sc = mix(sc, sc * vec3(0.78, 0.85, 1.00), smoothstep(0.46, 0.14, cg2) * 0.55 * crust);
    }
    base = mix(base, sc, snow);
  }

  // ---- shoreline wetness + waterline darkening ---------------------------
  float depth = uWaterLevel - vHeight;
  float wet = smoothstep(-1.6, 0.35, depth);
  base = mix(base, base * 0.55 + uWaterColor * 0.16, wet * 0.85);
  // Foam-ish bright rim right at the water edge.
  float edge = 1.0 - smoothstep(0.0, 0.55, abs(depth));
  base += vec3(0.16, 0.19, 0.2) * edge * (0.5 + 0.5 * sin(uTime * 1.7 + vWorld.x * 0.6 + vWorld.z * 0.5));

  // ---- cel lighting ------------------------------------------------------
  vec3 N = normalize(vNrm);
  // Perturb normal with the detail noise for a hand-painted feel.
  float e = 0.35;
  vec2 g = vec2(fbm(vWorld.xz * 1.9 + vec2(e, 0)) - grain, fbm(vWorld.xz * 1.9 + vec2(0, e)) - grain);
  N = normalize(N + vec3(-g.x, 0.0, -g.y) * 1.4 * uDetail);
  // No *near* normal perturbation on purpose. Tilting the normal at 15 cm scale is
  // the obvious way to make ground catch light unevenly, and on a smooth-shaded
  // surface it works — but this shader quantises N·L into three bands, so a wobble
  // large enough to see pushes whole patches across a band edge and the ground grows
  // hard-edged dark puddles. Near-field detail therefore stays in the albedo.

  float ndl = dot(N, normalize(uSunDir));
  float lit = ndl * 0.5 + 0.5;
  float q = floor(lit * uBands) / uBands;
  float fr = fract(lit * uBands);
  float ramp = clamp(q + smoothstep(0.42, 0.58, fr) / uBands, 0.0, 1.0);

  // Cast shadows. The ground is the only surface large enough to show them, so
  // without this the whole world floats: trees, characters and cliffs all had
  // shadow *casting* enabled and nothing to catch it. Folded into the same band
  // ramp as the diffuse term so a shadow edge is a cel edge, not a soft blur.
  float shadowAtten = 1.0;
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
    shadowAtten = getShadow(
      directionalShadowMap[0], directionalLightShadows[0].shadowMapSize,
      directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias,
      directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0]
    );
    shadowAtten = mix(1.0, smoothstep(0.15, 0.65, shadowAtten), 0.94);
  #endif
  ramp = min(ramp, mix(0.0, 1.0, shadowAtten));

  vec3 shadowCol = base * uShadowTint;
  vec3 col = mix(shadowCol, base * uSunColor, ramp);
  // Hemispheric ambient.
  vec3 amb = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5) * uAmbInt;
  // Ambient dims in shadow as well. Sky light does still reach shadowed ground, but
  // at full strength the ambient term alone is bright enough to erase the shadow
  // that the ramp above just carved — the reason cast shadows read as "almost
  // nothing" in a cel scene is nearly always the ambient add, not the shadow map.
  //
  // The 0.38 is a calibration, not a taste knob: with the sun term at 1.0, an add of
  // 0.85 put lit grass at 1.5x albedo, which ACES then rolls off to a pale
  // yellow-green — a bright meadow that has lost the colour it was given. At 0.38
  // the total lands near 1.2x, so the biome colour survives tone mapping.
  col += base * amb * 0.38 * mix(0.34, 1.0, shadowAtten);
  col *= mix(0.72, 1.0, vAO);

  // Grazing-light rim on ridges reads as rim-lit grass.
  float rimSun = pow(clamp(1.0 - abs(ndl), 0.0, 1.0), 3.0);
  col += uSunColor * rimSun * 0.06;

  // Specular sheen, per biome and near water.
  //
  // 'biomes[].rough' was authored on all 24 biomes across the six zones and read by
  // *nothing*: ice at 0.15 and meadow grass at 0.9 both got exactly one highlight term, the
  // wet-ground one below, so a frozen tarn and a lawn returned the same (absent) reflection
  // and 24 numbers looked like a material and were decoration. Inverted into gloss and
  // blended with 'w' — the same normalised splat weights the albedo uses — so the sheen
  // follows the biome boundary instead of needing a second mask, and squared so a rough
  // surface is genuinely matte (grass: 0.1² × 0.5 ≈ 0.005) while ice keeps a real specular
  // lobe (0.8² × 0.5 = 0.32) with a tighter exponent to go with it.
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 H = normalize(normalize(uSunDir) + V);
  float gloss = clamp(dot(w, uGloss), 0.0, 1.0);
  // Wet ground is glossy whatever it is made of; this keeps the shoreline highlight that
  // used to be the only one, and lets it win over a matte biome instead of adding to it.
  gloss = max(gloss, wet * 0.62);
  float sp = pow(max(dot(N, H), 0.0), mix(20.0, 110.0, gloss));
  col += uSunColor * sp * gloss * gloss * 0.5 * shadowAtten;

  // ---- fog ---------------------------------------------------------------
  float fog = smoothstep(uFogNear, uFogFar, camD);
  // Aerial perspective: distant terrain shifts toward the sky colour and desaturates.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, mix(col, vec3(lum), 0.35), fog * 0.6);
  col = mix(col, uFogColor, fog);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Which biome index (0-3) a point belongs to, used for splat weights. */
function biomeIndex(zone, x, z) {
  const t = zone.terrain;
  const y = heightAt(zone, x, z);
  const slope = slopeAt(zone, x, z);
  const list = t.biomes;
  for (let i = 0; i < list.length && i < 4; i++) {
    const b = list[i];
    if (b.minSlope !== undefined && slope < b.minSlope) continue;
    if (b.maxSlope !== undefined && slope > b.maxSlope) continue;
    if (b.maxHeight !== undefined && y > b.maxHeight) continue;
    if (b.minHeight !== undefined && y < b.minHeight) continue;
    return i;
  }
  return 0;
}

/**
 * Write a `daylight()` sRGB triple into a `THREE.Color`. Explicit colour space, because that is
 * what makes noon *identical* to the authored hex rather than a rounding of it.
 */
const srgbInto = (col, rgb) => col.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);

export class Terrain {
  constructor(zone, scene) {
    this.zone = zone;
    this.scene = scene;
    this.chunks = new Map();      // "cx,cz" -> { mesh, lod }
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);

    const t = zone.terrain;
    const cols = (t.biomes || []).map((b) => new THREE.Color(b.color));
    while (cols.length < 4) cols.push(cols[cols.length - 1] || new THREE.Color(0x6d8f41));

    const sky = zone.sky;
    this.uniforms = {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(...sky.sunDir).normalize() },
      uSunColor: { value: new THREE.Color(sky.sunColor) },
      uAmbSky: { value: new THREE.Color(sky.ambientSky) },
      uAmbGround: { value: new THREE.Color(sky.ambientGround) },
      uAmbInt: { value: sky.ambientIntensity },
      uFogColor: { value: new THREE.Color(sky.fogColor) },
      uFogNear: { value: sky.fogNear * 2.2 },
      uFogFar: { value: sky.fogFar * 2.4 },
      uWaterLevel: { value: zone.water?.level ?? -999 },
      uWaterColor: { value: new THREE.Color(zone.water?.color ?? 0x2a6f8f) },
      uColA: { value: cols[0] },
      uColB: { value: cols[1] },
      uColC: { value: cols[2] },
      uColD: { value: cols[3] },
      uCliffColor: { value: new THREE.Color(t.cliffColor ?? cols[Math.min(3, cols.length - 1)]) },
      uSnowLine: { value: t.snowLine ?? 1e9 },
      uSnowBlend: { value: t.snowBlend ?? 12 },
      uSnowColor: { value: new THREE.Color(t.snowColor ?? 0xeef4ff) },
      uBands: { value: 3.0 },
      uShadowTint: { value: new THREE.Color(t.shadowTint ?? 0x6f7ba8) },
      uDetail: { value: 1.0 },
      // Only indoor arenas get a built floor; outdoors this stays 0 and the whole
      // inlay branch is skipped.
      uArenaR: { value: zone.indoor && t.arena ? t.arena.radius : 0 },
      uInlayColor: { value: new THREE.Color(t.inlayColor ?? cols[1]) },
      uInlayMix: { value: t.inlayStrength ?? 0.45 },
      // Gloss per biome, padded exactly like `cols` above so a zone with three biomes does
      // not read an undefined fourth. 0.85 is the default roughness a biome that declares
      // none gets — matte, because every authored value except the ices is 0.5 or above.
      uGloss: {
        value: new THREE.Vector4(...[0, 1, 2, 3].map((i) => 1 - ((t.biomes || [])[i]?.rough
          ?? (t.biomes || [])[Math.min(3, (t.biomes || []).length - 1)]?.rough ?? 0.85))),
      },
    };

    // `lights: true` is what makes the renderer keep the shadow uniforms fresh, and
    // those uniforms have to be present in the material to be filled at all. The
    // lights lib is merged (which deep-clones) *first* and our own uniform objects
    // are assigned over the result, so the references the rest of this class writes
    // to every frame — uTime, uDetail, … — survive the merge.
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights]);
    Object.assign(uniforms, this.uniforms);
    this.uniforms = uniforms;

    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      side: THREE.FrontSide,
      lights: true,
    });
    // Needed so the #include tonemapping/colorspace chunks resolve.
    this.material.onBeforeCompile = () => {};

    // Depth-only material for shadow casting (terrain self-shadows hills).
    this.shadowMat = new THREE.MeshDepthMaterial();
  }

  setQuality(q) {
    this.uniforms.uDetail.value = q === 'low' ? 0.3 : q === 'medium' ? 0.7 : 1.0;
    this.viewRadius = q === 'low' ? 3 : q === 'medium' ? 4 : 5;
  }

  /**
   * Time of day. The ground is the biggest thing on screen and it does *not* go through the
   * DirectionalLight — this shader takes `uSunColor` as its whole direct term — so without this
   * the meadow would still be lit like noon under a midnight sky. `ph.groundSunColor` is the
   * already-dimmed value for exactly that reason.
   */
  applyDaylight(ph, dim = 1) {
    const u = this.uniforms;
    u.uSunDir.value.set(ph.lightDir[0], ph.lightDir[1], ph.lightDir[2]);
    srgbInto(u.uSunColor.value, ph.groundSunColor);
    // The ground is not lit by the DirectionalLight — `uSunColor` *is* its light term — so a storm
    // that only dimmed `sun.intensity` would darken every prop and character and leave the meadow
    // at full noon brightness. `dim` is 1 unless the weather has pushed past the zone's baseline.
    if (dim !== 1) u.uSunColor.value.multiplyScalar(dim);
    srgbInto(u.uAmbSky.value, ph.ambientSky);
    srgbInto(u.uAmbGround.value, ph.ambientGround);
    u.uAmbInt.value = ph.ambientIntensity;
    srgbInto(u.uFogColor.value, ph.fogColor);
  }

  /** Build one chunk's geometry at a given LOD. */
  buildChunk(cx, cz, lod) {
    const res = LOD_RES[Math.min(lod, LOD_RES.length - 1)];
    const zone = this.zone;
    const step = CHUNK / res;
    const ox = cx * CHUNK;
    const oz = cz * CHUNK;

    const vertCount = (res + 1) * (res + 1);
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const splat = new Float32Array(vertCount * 4);
    const ao = new Float32Array(vertCount);

    let vi = 0;
    for (let j = 0; j <= res; j++) {
      for (let i = 0; i <= res; i++) {
        const x = ox + i * step;
        const z = oz + j * step;
        const y = heightAt(zone, x, z);
        positions[vi * 3] = x;
        positions[vi * 3 + 1] = y;
        positions[vi * 3 + 2] = z;

        const n = normalAt(zone, x, z, Math.max(0.6, step * 0.5));
        normals[vi * 3] = n[0];
        normals[vi * 3 + 1] = n[1];
        normals[vi * 3 + 2] = n[2];

        const bi = biomeIndex(zone, x, z);
        // Soft weights: dominant biome plus a bleed into the next so borders blend.
        splat[vi * 4 + 0] = bi === 0 ? 1 : 0.08;
        splat[vi * 4 + 1] = bi === 1 ? 1 : 0.05;
        splat[vi * 4 + 2] = bi === 2 ? 1 : 0.04;
        splat[vi * 4 + 3] = bi === 3 ? 1 : 0.03;

        // Cheap baked AO: compare against the average of a wider neighbourhood —
        // valleys get darker, ridges brighter.
        const r = 3.5;
        const avg = (heightAt(zone, x + r, z) + heightAt(zone, x - r, z)
          + heightAt(zone, x, z + r) + heightAt(zone, x, z - r)) * 0.25;
        ao[vi] = THREE.MathUtils.clamp(0.55 + (y - avg) * 0.16, 0.25, 1.0);
        vi++;
      }
    }

    const indices = [];
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const a = j * (res + 1) + i;
        const b = a + 1;
        const c = a + (res + 1);
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('splat', new THREE.BufferAttribute(splat, 4));
    geo.setAttribute('aoBake', new THREE.BufferAttribute(ao, 1));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
  }

  key(cx, cz) { return `${cx},${cz}`; }

  /** Stream chunks around the camera/player; rebuild when the LOD ring changes. */
  update(px, pz, dt) {
    this.uniforms.uTime.value += dt;
    const radius = this.viewRadius ?? 5;
    const ccx = Math.floor(px / CHUNK);
    const ccz = Math.floor(pz / CHUNK);
    const half = this.zone.size / 2;
    const maxC = Math.ceil(half / CHUNK);

    const wanted = new Set();
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        if (cx < -maxC || cx > maxC - 1 || cz < -maxC || cz > maxC - 1) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dz));
        const lod = d <= 1 ? 0 : d <= 2 ? 1 : d <= 3 ? 2 : 3;
        const k = this.key(cx, cz);
        wanted.add(k);
        const existing = this.chunks.get(k);
        if (existing && existing.lod === lod) continue;
        if (existing) {
          existing.mesh.geometry.dispose();
          existing.mesh.geometry = this.buildChunk(cx, cz, lod);
          existing.lod = lod;
          existing.mesh.castShadow = lod <= 1;
          continue;
        }
        const geo = this.buildChunk(cx, cz, lod);
        const mesh = new THREE.Mesh(geo, this.material);
        mesh.receiveShadow = true;
        mesh.castShadow = lod <= 1;
        mesh.frustumCulled = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        this.group.add(mesh);
        this.chunks.set(k, { mesh, lod, cx, cz });
      }
    }
    // Evict.
    for (const [k, c] of this.chunks) {
      if (wanted.has(k)) continue;
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
      this.chunks.delete(k);
    }
  }

  /** Terrain height — delegates to the shared function (authoritative). */
  heightAt(x, z) { return heightAt(this.zone, x, z); }

  dispose() {
    for (const c of this.chunks.values()) c.mesh.geometry.dispose();
    this.chunks.clear();
    this.group.removeFromParent();
    this.material.dispose();
  }
}

/* -------------------------------------------------------------------- water -- */

const WATER_VERT = /* glsl */`
uniform float uTime;
uniform float uWaveScale;
varying vec3 vWorld;
varying vec2 vUvW;
varying float vWave;

float wave(vec2 p, vec2 dir, float freq, float speed, float t) {
  return sin(dot(p, dir) * freq + t * speed);
}

void main() {
  vec3 pos = position;
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  // Gerstner-ish sum of directional waves.
  float t = uTime;
  float h = 0.0;
  h += wave(wp.xz, normalize(vec2(1.0, 0.35)), 0.16, 1.35, t) * 0.34;
  h += wave(wp.xz, normalize(vec2(-0.4, 1.0)), 0.24, 1.05, t) * 0.22;
  h += wave(wp.xz, normalize(vec2(0.7, -0.7)), 0.51, 1.9, t) * 0.10;
  h += wave(wp.xz, normalize(vec2(-1.0, -0.2)), 0.93, 2.7, t) * 0.045;
  wp.y += h * uWaveScale;
  vWave = h;
  vWorld = wp.xyz;
  vUvW = wp.xz * 0.05;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */`
precision highp float;
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vWorld;
varying vec2 vUvW;
varying float vWave;

float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x), mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y);
}

void main() {
  // Normal from two scrolling noise layers = ripples.
  vec2 p1 = vUvW * 3.0 + vec2(uTime * 0.055, uTime * 0.032);
  vec2 p2 = vUvW * 6.5 - vec2(uTime * 0.041, uTime * 0.068);
  float e = 0.035;
  float n0 = vnoise(p1) + vnoise(p2) * 0.6;
  float nx = vnoise(p1 + vec2(e, 0.0)) + vnoise(p2 + vec2(e, 0.0)) * 0.6;
  float nz = vnoise(p1 + vec2(0.0, e)) + vnoise(p2 + vec2(0.0, e)) * 0.6;
  vec3 N = normalize(vec3(-(nx - n0) * 6.0, 1.0, -(nz - n0) * 6.0));

  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.2);

  // Depth-ish tint: water further from the eye and lower reads deeper.
  vec3 col = mix(uDeep, uColor, clamp(0.35 + fres * 0.8, 0.0, 1.0));

  // Sun glitter: sharp stepped specular for the stylised look.
  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 220.0);
  float glint = smoothstep(0.25, 0.5, spec) + smoothstep(0.02, 0.1, spec) * 0.25;
  col += uSunColor * glint * 1.5;

  // Wave-crest foam.
  float crest = smoothstep(0.34, 0.62, vWave + vnoise(p2 * 2.0) * 0.3);
  col = mix(col, uFoam, crest * 0.5);

  // Sky-ish fresnel brighten near the horizon.
  col += uColor * fres * 0.35;

  float dist = length(cameraPosition - vWorld);
  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, dist));

  float alpha = mix(0.78, 0.97, fres);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function makeWater(zone) {
  const w = zone.water;
  if (!w || w.level <= -900) return null;
  const size = zone.size * 1.6;
  const geo = new THREE.PlaneGeometry(size, size, 128, 128);
  geo.rotateX(-Math.PI / 2);
  const sky = zone.sky;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWaveScale: { value: w.waveScale ?? 1.0 },
      uColor: { value: new THREE.Color(w.color) },
      uDeep: { value: new THREE.Color(w.deepColor) },
      uFoam: { value: new THREE.Color(w.foam) },
      uSunDir: { value: new THREE.Vector3(...sky.sunDir).normalize() },
      uSunColor: { value: new THREE.Color(sky.sunColor) },
      uFogColor: { value: new THREE.Color(sky.fogColor) },
      uFogNear: { value: sky.fogNear * 2.2 },
      uFogFar: { value: sky.fogFar * 2.4 },
    },
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = w.level;
  mesh.renderOrder = 2;
  mesh.name = 'water';
  // Same treatment as the ground: the water's sun glint and its fog are its own uniforms, so a
  // lake would otherwise keep a noon highlight at midnight — the single brightest thing in frame.
  mesh.applyDaylight = (ph, dim = 1) => {
    mat.uniforms.uSunDir.value.set(ph.lightDir[0], ph.lightDir[1], ph.lightDir[2]);
    srgbInto(mat.uniforms.uSunColor.value, ph.groundSunColor);
    if (dim !== 1) mat.uniforms.uSunColor.value.multiplyScalar(dim);
    srgbInto(mat.uniforms.uFogColor.value, ph.fogColor);
  };
  return mesh;
}
