// Procedural world props: everything that dresses a zone but is not terrain,
// water, sky, a character or an enemy.
//
// Two very different requirements meet here, so there are two entry points:
//
//   buildPropField(kind, placements)  — scattered dressing (trees, rocks, grass,
//       flowers, bushes, crystals, lanterns, ruins). One InstancedMesh per
//       (variant, material), so ten thousand grass tufts cost a handful of draw
//       calls. Nothing in a field is individually interactive.
//
//   buildProp(kind, opts)             — the handful of props the player touches or
//       that own a light: chests, braziers, waypoints, statues, monuments, dungeon
//       gates. These get their own Group and an update(dt, t).
//
// Variety inside a field comes from seeded *variants* — 3 different oaks built
// once and then instanced — plus per-instance yaw, tilt and scale. That is far
// cheaper than unique geometry per tree and, at the distances props are seen from,
// indistinguishable.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  SEC, sweep, ribbon, loft, bar, trs, sphere, blob, spike, ring, along,
  UP_REF, Parts, mergeParts,
} from './solid.js';
import {
  toonMaterial, hideMaterial, clothMaterial, metalMaterial, glowMaterial,
  addOutline, outlineMaterial,
} from './toon.js';
import { Rand, lerp, TAU } from '@teyvat/shared/sim/rng.js';
import { ELEMENTS } from '@teyvat/shared/data/elements.js';

/* ------------------------------------------------------------------ sections -- */

/**
 * Half-disc with a flat bottom: barrel lids. Closed, unlike a partial
 * CylinderGeometry, which leaves the cut face open — and an open shape gives the
 * inverted-hull outline a visible backface arc, so a chest lid built that way
 * acquires a black handle looping over the top of it.
 */
const SEC_DOME = (() => {
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    pts.push([Math.cos(a), Math.sin(a)]);
  }
  return pts;   // (1,0) … (-1,0); the closing edge along the bottom is implicit
})();

/** Hexagonal prism section: crystals, gems, obelisks. */
const SEC_HEX = [
  [1, 0], [0.5, 0.866], [-0.5, 0.866], [-1, 0], [-0.5, -0.866], [0.5, -0.866],
];
/**
 * Fluted column: 6 lobes cut by 6 grooves, which is what makes stone read as carved.
 *
 * Six, not the sixteen a first pass used, and cut to 0.76 rather than 0.86. A
 * flat-shaded 16-gon with shallow grooves is visually a smooth cylinder — the facets
 * are too small to catch different bands of the cel ramp, so the whole shaft ends up
 * one flat tone and the column reads as a plain post.
 */
const SEC_FLUTE = (() => {
  const pts = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    const r = i % 2 === 0 ? 1 : 0.76;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
})();

/* ----------------------------------------------------------------- materials -- */

// Materials are shared process-wide, not per prop and not per zone. Two reasons:
// a toon material compiles one shader program per variant it is used in, and an
// InstancedMesh can only batch draws that share a material. A forest of 400 trees
// built with 400 bark materials would be 400 draw calls and 400 programs.
const memo = new Map();
const once = (key, make) => {
  if (!memo.has(key)) memo.set(key, make());
  return memo.get(key);
};

/**
 * Darken a packed hex in display space: `shade(0x9a5040, 0.55)` is the same paint in
 * shadow. Used where a recipe needs a plinth and a fillet in the *authored* wall colour
 * rather than in some second colour the zone would then have to keep in sync — three
 * shades of one hue read as one material worked three ways, which is the point.
 */
const shade = (hex, k) => (
  (Math.round(((hex >> 16) & 255) * k) << 16)
  | (Math.round(((hex >> 8) & 255) * k) << 8)
  | Math.round((hex & 255) * k)
);

/** Per-channel lerp of two packed hexes in display space. */
const lerpHex = (a, b, k) => {
  const ch = (sh) => Math.round((((a >> sh) & 255) * (1 - k)) + (((b >> sh) & 255) * k));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

// The two blade colours Mondstadt's meadow was tuned on, kept as the defaults for callers
// with no zone in hand (a haystack, a planter) and as the values that zone now authors.
const BLADE_A = 0x648944, BLADE_B = 0x486833;
// Everything that is not colour: the surface treatment is the same blade everywhere.
const BLADE_SURFACE = {
  side: THREE.DoubleSide, rootDark: 0.42, rootH: 0.42, mottle: 0.55, mottleScale: 2.5, mottleSpeck: 0,
};
// The light blade and the strawy one, both struck from A on one axis — toward a pale
// yellow-green for the highlight, mostly *into* straw for the dry tuft with a quarter of the
// zone's own colour left in it, so dead grass on a snowfield stays cool and dead grass in
// Liyue stays warm. On Mondstadt's A these reproduce the two constants they replace to
// within a few counts per channel (0x829b4e vs 0x7c9d4e, 0x979650 vs 0xa89b54).
const lightBlade = (a) => lerpHex(a, 0xd8cf6a, 0.26);
const dryBlade = (a) => lerpHex(0xa89b54, a, 0.25);

export const MATS = {
  // Bark takes the same near-field grain as stone at a much finer scale: a trunk is an
  // 8-gon loft, so the only thing distinguishing it from a painted dowel up close is
  // what the fragment shader puts on it. 5.5 cycles/m puts the fine octave near 3 cm,
  // about the width of a bark ridge.
  bark: () => once('bark', () => hideMaterial(0x6a4b30, { bands: 2, rimStrength: 0.20, mottle: 0.13, mottleScale: 5.5 })),
  barkPine: () => once('barkPine', () => hideMaterial(0x54402c, { bands: 2, rimStrength: 0.18, mottle: 0.14, mottleScale: 6.2 })),
  barkDead: () => once('barkDead', () => hideMaterial(0x8c8578, { bands: 2, rimStrength: 0.24, mottle: 0.15, mottleScale: 5.0 })),
  bamboo: () => once('bamboo', () => hideMaterial(0x9ab455, { bands: 2 })),

  // Foliage carries the sway. Three values, not one: a canopy lit by a single
  // stepped ramp needs its own internal variation or it reads as a green balloon.
  // Spread wide on purpose — the darkest is barely half the lightest's luminance,
  // because the ramp only gives two bands and everything else has to come from the
  // albedo differences between neighbouring clusters.
  // vertexColors: the canopy tone is baked per vertex (see `foliageTone`). Recipes
  // that use these without baking are backfilled with white, so they are unchanged.
  // `mottle`: `leafClump` gets the lobe's *outline* right, but its facets are 50-80 cm
  // across, so from ten metres a lobe is still half a dozen flat green plates. The
  // 12/5/2.6 cm grain the fragment shader adds is what a canopy at arm's length is made
  // of, and it costs no triangles. `mottleSpeck: 0` drops the mica sparkle — see toon.js.
  //
  // 0.48, not the 0.15 this was first set to. `tools/mat-probe.mjs` confirmed the uniform
  // was reaching the shader correctly (`oak:v0 mottle=0.15 scale=4 speck=0`) and the crown
  // still photographed as flat green, because `uMottle` is not the amplitude anyone would
  // guess: the three octaves are *averaged*, so the field's spread is only about 0.116,
  // and 0.15 bought a ±3.5 % wobble — under the 8-bit noise floor of a mid green. See the
  // arithmetic in toon.js. Leaves therefore need a number that looks alarming next to the
  // rock's 0.11 and is in fact about three times its visible effect.
  //
  // Desaturated slightly, because ACES could not reproduce these greens. The originals
  // 0x4e7a30 / 0x365a22 / 0x6b9540 rendered with blue clamped to *exactly zero* over most
  // of the working light range — 0x365a22 at all five levels, 0x4e7a30 at three — and a
  // surface missing a channel has no hue left to shade. `node tools/gamut-check.mjs`
  // reproduces three.js's tonemap exactly and reports it; run it before adding a colour.
  //
  // The amount is the measured minimum plus about five points of margin (11/14/8 %), not a
  // round number chosen by eye. That distinction cost real saturation once already: these
  // were first taken 35 % toward their own luma, four to six times further than the gamut
  // actually requires, on the theory that saturation the tonemap "was going to throw away
  // anyway" is free. It is not — everything up to the clamp survives, and over-desaturating
  // a canopy is exactly how a forest goes grey. Desaturate to clear the clamp, no further.
  leafA: () => once('leafA', () => leafMat(0x52793b, 0.020, { vertexColors: true, mottle: 0.48, mottleScale: 4.0, mottleSpeck: 0 })),
  leafB: () => once('leafB', () => leafMat(0x3b592c, 0.016, { vertexColors: true, mottle: 0.48, mottleScale: 4.0, mottleSpeck: 0 })),
  leafC: () => once('leafC', () => leafMat(0x6e9449, 0.024, { vertexColors: true, mottle: 0.48, mottleScale: 4.0, mottleSpeck: 0 })),
  // Needles are finer than leaves, so the grain is too: 7 cycles/m puts the fine octave
  // near 1.5 cm, about one needle.
  //
  // Brightened from 0x2f5a3a / 0x21432b (x1.95 and x2.55 in *linear* light, never by scaling
  // the sRGB bytes — that lifts darks far more than lights and washes the hue out). A pine
  // measured luma 42 against grass at 127, which is a nine-metre tree reading as a black
  // cone in a bright field; the albedo's own *ceiling*, its luma if lit to pure white, was
  // only 81. Nothing in the shade path can lift a surface past its albedo, so the paint had
  // to change. Ceilings are now 111 and 95, keeping a conifer clearly darker than grass
  // without making it a silhouette.
  //
  // Deliberately *not* desaturated, unlike the leaves above. These greens were checked with
  // `node tools/gamut-check.mjs 2f5a3a 21432b 437b51 376a46` and all four come back in
  // gamut — no channel ever clamps, at any light level. A conifer at half light renders
  // [21,88,31]: little red, but legitimately little, because that is what ACES does to a
  // dark saturated green that it *can* still represent. Three separate attempts have now
  // read that small red channel as a bug — first the cel shadow floor, then a doubled
  // `shadowTint`, then a blanket 35 % desaturation applied here on the leaves' evidence —
  // and each moved the luma by under two while costing the needles their colour. A dark
  // green with a dark red channel is not a clamp. Check before treating it as one.
  needleA: () => once('needleA', () => leafMat(0x437b51, 0.010, { vertexColors: true, mottle: 0.42, mottleScale: 7.0, mottleSpeck: 0 })),
  needleB: () => once('needleB', () => leafMat(0x376a46, 0.008, { vertexColors: true, mottle: 0.42, mottleScale: 7.0, mottleSpeck: 0 })),
  // Bamboo, grass and the blade strips below hit the same blue clamp the leaves did, and
  // are corrected the same way: minimum desaturation plus a small margin, per gamut-check.
  bambooLeaf: () => once('bambooLeaf', () => leafMat(0x83ad56, 0.030)),

  grassA: () => once('grassA', () => leafMat(0x73994c, 0.075)),
  grassB: () => once('grassB', () => leafMat(0x54783b, 0.062)),
  grassDry: () => once('grassDry', () => leafMat(0xa89b54, 0.070)),
  // Blades are flat strips (see `ribbon`), so they need both faces — and their own
  // materials rather than a `side` tweak on the shared ones, or every leaf in the
  // zone would start drawing twice.
  // `rootDark`: no light reaches the bottom of a meadow. Without it the canopy is a
  // flat green sheet at every distance — see the note in toon.js for why this is a
  // vertex gradient and not a cast shadow. rootH is the proto's nominal 0.42 m, so
  // only the top of the tallest blades reads at full albedo.
  // `mottle` on a blade does something different from what it does on a boulder, and the
  // difference is why it is worth the uniform. The noise is sampled in *world* space and a
  // blade is 1-2 cm wide, so a blade spans well under one cycle of even the finest octave:
  // each blade therefore comes out a single slightly different shade rather than acquiring
  // a texture. That is per-blade colour jitter for no extra attribute and no extra
  // triangle, on the most numerous object in the game.
  //
  // mottleScale 2.5 puts the coarsest octave at 5 cycles/m, a 20 cm wavelength, which is
  // the scale that matters: blades inside one tuft sit 5-15 cm apart, so neighbours have to
  // decorrelate across roughly that distance or a whole tuft shifts as one and nothing is
  // gained. Speck off — mica on grass would be dew at best and glitter at worst.
  //
  // Three flat greens over tens of thousands of instances is what made the Mondstadt plain
  // read as one sheet of colour in the gameplay camera even after the terrain underneath it
  // was given genuine hue variation: the grass was covering the ground that had just been
  // fixed.
  //
  // Colour comes from the zone, not from here. `terrain.grassColorA/B` was authored on all
  // six zones and read by nobody, so 龙脊雪山's snowfields and 深渊 grew the same meadow green
  // as Mondstadt — an authored key with no consumer, the failure this project keeps finding
  // (see shared/src/data/zoneGate.js). `blade()` is keyed by colour rather than by zone so
  // two zones with the same pair still share one material, and `protoKey` carries `color`
  // and `colorB` so the proto cache cannot serve one zone's blades to the next.
  blade: (hex, sway) => once(`blade:${hex}:${sway}`, () => leafMat(hex, sway, BLADE_SURFACE)),
  bladeA: () => MATS.blade(BLADE_A, 0.075),
  bladeB: () => MATS.blade(BLADE_B, 0.062),
  // A third blade colour, warmer and lighter than either authored one: two shades read as
  // a two-tone carpet, three read as a field. The cost is one more instanced draw
  // call per streamed cell. Derived from A rather than authored — a zone that has to keep
  // four blade colours in agreement will not.
  bladeC: () => MATS.blade(lightBlade(BLADE_A), 0.082),
  bladeDry: () => MATS.blade(dryBlade(BLADE_A), 0.070),
  // Shrub foliage gets its own three shades rather than borrowing the trees', purely
  // so it can carry the same root gradient at shrub scale: the underside of a bush is
  // the darkest thing on a lawn, and sharing the canopy materials would apply a 0.9 m
  // falloff to a 6 m oak.
  // Same three paints as leafA/B/C above, so they carry the same ACES desaturation.
  //
  // rootDark 0.22, not 0.40, because the old value was double-counting: SCATTER.bush already
  // bakes a vertical gradient per lobe through `foliageTone` (base 0.82-1.06, ao 0.26), and
  // the two together left the underside at 0.48 of its albedo before a single light was
  // applied — which is most of why it rendered at luma 17 against grass at 117.
  //
  // Halving it while *keeping* the 0.85 m reach is deliberate, and the first attempt got this
  // wrong in an instructive way: 0.10 over 0.40 m looks like the same total darkening spent
  // more locally, but a bush's lobes sit at 0.5-1.4 m, so a 0.40 m falloff saturates to 1.0
  // across the entire plant and only the ground contact keeps any gradient at all. The
  // measured result was a shrub brighter than the meadow (top 131 against grass 116) with no
  // form left in it. The gradient has to span the plant to read as a canopy; what it must not
  // do is span it *twice*.
  bushLeafA: () => once('bushLeafA', () => leafMat(0x52793b, 0.020, { rootDark: 0.22, rootH: 0.85, vertexColors: true, mottle: 0.48, mottleScale: 5.0, mottleSpeck: 0 })),
  bushLeafB: () => once('bushLeafB', () => leafMat(0x3b592c, 0.016, { rootDark: 0.22, rootH: 0.85, vertexColors: true, mottle: 0.48, mottleScale: 5.0, mottleSpeck: 0 })),
  bushLeafC: () => once('bushLeafC', () => leafMat(0x6e9449, 0.024, { rootDark: 0.22, rootH: 0.85, vertexColors: true, mottle: 0.48, mottleScale: 5.0, mottleSpeck: 0 })),

  // Cooking ingredients. The caps are the one place in the flora palette where a
  // warm hue is wanted: a brown-red mushroom is the only thing on a green hillside
  // the eye picks out without help, which is exactly what a gatherable needs.
  mushCapA: () => once('mushCapA', () => hideMaterial(0xb4562f, { bands: 2, roughness: 0.86, rampSoft: 0.10, shadowTint: 0x7a4a5e })),
  mushCapB: () => once('mushCapB', () => hideMaterial(0xd88a4a, { bands: 2, roughness: 0.86, rampSoft: 0.10, shadowTint: 0x8a5a62 })),
  mushStem: () => once('mushStem', () => hideMaterial(0xe8ddc4, { bands: 2, roughness: 0.90, rampSoft: 0.12, shadowTint: 0x9a9ab0 })),
  grain: () => once('grain', () => hideMaterial(0xd9b653, { bands: 2, roughness: 0.82, rampSoft: 0.08, specStep: 0.66, shadowTint: 0x8f7a54 })),

  snow: () => once('snow', () => hideMaterial(0xf2f7fc, { bands: 3, rampSoft: 0.12, shadowTint: 0x9fb4d8 })),
  // Greyer than it looks like it wants to be: 0x8a8378 has enough yellow in it that
  // a lit boulder under a warm sun comes out sand-coloured.
  // Three bands, not two. A boulder is a smooth-shaded solid of eighty faces, so a
  // two-band ramp gives it exactly two tones: measured on the Mondstadt plain the lit
  // faces sat at sRGB 188 and the ones beside them at 60, a 3x step with nothing
  // between, and the rock read as plastic. Two tones are what makes a *character* look
  // drawn; a rock needs the middle tone to have a form at all. The shadow tints are
  // also lifted and desaturated from 0x5a6480, which was dark enough that the shaded
  // half went blue-black next to grass the terrain shader lights with three bands of
  // its own.
  // `mottle` is the other half of the same argument, at a scale vertex colour cannot
  // reach: the sunlit face of a six-metre boulder measured 144-152 across four metres,
  // and an icosahedron that size has a vertex every 80 cm, so the 10-50 cm grain has to
  // come out of the fragment shader (see `uMottle` in toon.js). Near-field only.
  stone: () => once('stone', () => hideMaterial(0x76756f, {
    bands: 3, roughness: 0.98, rampSoft: 0.06, rimStrength: 0.22, shadowTint: 0x6d7796,
    mottle: 0.11,
  })),
  stoneDark: () => once('stoneDark', () => hideMaterial(0x4e4d4a, {
    bands: 3, roughness: 0.98, rampSoft: 0.06, shadowTint: 0x646d8a, mottle: 0.11,
  })),
  // Same two stones with per-vertex tone enabled; see `stoneTone`.
  stoneVaried: () => once('stoneVaried', () => hideMaterial(0x76756f, {
    bands: 3, roughness: 0.98, rampSoft: 0.06, rimStrength: 0.22, shadowTint: 0x6d7796,
    vertexColors: true, mottle: 0.11,
  })),
  stoneVariedDark: () => once('stoneVariedDark', () => hideMaterial(0x4e4d4a, {
    bands: 3, roughness: 0.98, rampSoft: 0.06, shadowTint: 0x646d8a, vertexColors: true,
    mottle: 0.11,
  })),
  // Cut and dressed stone: the same grain, weaker and finer, because a mason's block
  // is worked rather than broken. Dropping it entirely is what made plinths and pillars
  // read as painted plaster next to the boulders.
  stonePale: () => once('stonePale', () => hideMaterial(0xbdb6a4, {
    bands: 3, roughness: 0.92, mottle: 0.055, mottleScale: 3.1,
  })),
  /**
   * Lacquered plaster — a palace wall, painted rather than dressed.
   *
   * It exists because 黄金屋 photographed as one colour. Every large surface in that hall
   * was either gold (floor, columns, courses, ceiling trim) or `stonePale`, and 0xbdb6a4
   * under a 0xffdca0 sun and a 0x9a8558 ambient is *also* gold — albedo 0.71 luma, i.e.
   * the pale wall came out as bright as the sunlit floor, and a frame with no value
   * contrast has no depth however much geometry is in it. The fix has to be albedo:
   * a hue rotation cannot survive being multiplied by a gold light ([[divide-the-light-out]]),
   * but half the luminance survives anything.
   *
   * `hex` is a parameter for the same reason `vault`'s is: the colour *is* the material
   * here, and the zone that owns the wall is the only thing that knows what it should be.
   * Two bands, not three, because lacquer is glossy — its terminator is a hard line —
   * and a coarse mottle, which is the flaking that keeps a 4.6 m band of one colour from
   * reading as a painted flat.
   */
  lacquer: (hex, tint = 0x7a5a4c) => once(`lacquer:${hex}:${tint}`, () => hideMaterial(hex, {
    bands: 2, roughness: 0.55, rampSoft: 0.05, rimStrength: 0.30, shadowTint: tint,
    specStep: 0.72, specSharp: 0.55, mottle: 0.085, mottleScale: 1.6,
  })),
  // Ceiling stone (see `buildVaultCeiling`). Two things separate it from the wall stones
  // above: `vertexColors`, because the shell bakes its slab-to-slab tone per facet and a
  // ceiling has no other source of contrast, and a *coarse* mottle — 0.42 cycles/m puts
  // the grain at ~2.4 m, which is what a surface 25-40 m overhead can actually resolve.
  // `stone`'s 11 cm grain at that distance is sub-pixel noise, i.e. shimmer.
  // The shadow tint is a *parameter* here, unlike every other stone: `shadowCol = albedo *
  // uShadowTint` (gfx/toon.js) and a ceiling is in the dark band over its whole area, so
  // that one colour is what the ceiling *is*. The 0x6a7488 the other stones share turned
  // 黄金屋's warm 0xb5a88f vault into a cold grey dome hanging over a gold hall — the
  // albedo was right and never reached the screen unmultiplied.
  // `fill` is the one place in the game that switches on the second directional light (see
  // the fill block in gfx/toon.js). It exists for these two materials: a ceiling face points
  // away from a near-vertical dungeon sun, so its cel ramp is pinned in the shadow band and
  // the *only* thing that can distinguish one facet from the next is a light from below —
  // which is also the physically right answer, since the light in these rooms is braziers on
  // the floor.
  vault: (hex, tint = 0x6a7488) => once(`vault:${hex}:${tint}`, () => hideMaterial(hex, {
    bands: 3, roughness: 0.96, rampSoft: 0.07, rimStrength: 0.26, shadowTint: tint,
    vertexColors: true, mottle: 0.16, mottleScale: 0.42, fill: 0.34,
  })),
  vaultTrim: (hex, tint = 0x6a7488) => once(`vaultTrim:${hex}:${tint}`, () => hideMaterial(hex, {
    bands: 3, roughness: 0.9, rampSoft: 0.08, rimStrength: 0.32, shadowTint: tint,
    mottle: 0.10, mottleScale: 0.7, fill: 0.45,
  })),
  abyssStone: () => once('abyssStone', () => hideMaterial(0x3a3550, { bands: 3, roughness: 0.9 })),
  // Lighter than `abyssStone`, same hue. The enclosure's faces are vertical and this
  // zone's sun is near-vertical (sunDir y = 0.94), so they catch almost no direct light
  // and the ambient alone left a 0x3a3550 wall indistinguishable from the 0x14142a fog:
  // the first build of the arcade read as thin glowing ribs floating in a void.
  abyssWall: () => once('abyssWall', () => hideMaterial(0x5c5590, {
    bands: 3, roughness: 0.85, rampSoft: 0.09, mottle: 0.09, mottleScale: 2.4,
  })),
  /**
   * A cave's wall rock, and the same argument `abyssWall` makes one zone over.
   *
   * 冰封洞窟's enclosure was built out of `stoneDark` (0x4e4d4a, 0.30 luma), and
   * `tools/prop-check.mjs` photographed one curtain module at 20 m: rgb [24,34,50], p5..p95
   * spanning **31..37**. Six counts of range over a seventeen-metre wall — a navy sheet of
   * paper — while the floor of the same room measures 166-182. Mottle cannot rescue that and
   * neither can a light: the swing `uMottle` produces is a *multiplier* (≈0.23×uMottle, see
   * gfx/toon.js), so 0.11 on a surface sitting at luma 33 is ±0.8 of an 8-bit level, and the
   * faces are vertical under a sun that points almost straight down. The albedo is what has to
   * change, exactly as it did when `abyssStone` was lifted to `abyssWall` for the same reason.
   *
   * `fill` for the same reason the vault materials have it: the light in a cave is braziers on
   * the floor, and it is the only term that separates one vertical face from the next when the
   * sun is overhead. `hex` is a parameter because the rock colour belongs to the zone —
   * frostCavern already authors `props.ceiling.rockColor`, and a wall of a different colour to
   * its own ceiling is the tell that the two were built by different hands.
   */
  caveWall: (hex, tint = 0x6a7488) => once(`caveWall:${hex}:${tint}`, () => hideMaterial(hex, {
    bands: 3, roughness: 0.95, rampSoft: 0.07, rimStrength: 0.24, shadowTint: tint,
    mottle: 0.13, mottleScale: 1.1, fill: 0.30,
  })),
  wood: () => once('wood', () => hideMaterial(0x7a5533, { bands: 2 })),
  woodDark: () => once('woodDark', () => hideMaterial(0x4a3320, { bands: 2 })),
  iron: () => once('iron', () => metalMaterial(0x6e6f74)),
  silver: () => once('silver', () => metalMaterial(0xc2c8d2)),
  gold: () => once('gold', () => metalMaterial(0xd8ab4a, { rimColor: 0xfff0c0 })),
  goldDeep: () => once('goldDeep', () => metalMaterial(0x997639)),
  cloth: () => once('cloth', () => clothMaterial(0xb63a34)),
  clothBlue: () => once('clothBlue', () => clothMaterial(0x3f5a80)),
  paper: () => once('paper', () => clothMaterial(0xe8654a, { emissive: 0x6a1c10 })),
  /**
   * Glazed roof tile, dark teal-green. Liyue roofs are *not* the same red as the
   * banners — a pagoda tiled in the banner red comes out a solid scarlet cone that
   * blows out under bloom, and the red beams underneath lose all contrast against
   * it. The green also separates the roof from the grass, which sits much lighter
   * and yellower.
   */
  tile: () => once('tile', () => clothMaterial(0x35564a, {
    bands: 2, roughness: 0.6, specStep: 0.62, specSharp: 0.7, shadowTint: 0x5d6a90,
  })),
  tileRed: () => once('tileRed', () => clothMaterial(0x9c4034, { bands: 2 })),
  ice: () => once('ice', () => toonMaterial({
    color: 0xa8d8ee, bands: 2, roughness: 0.12, transparent: true, opacity: 0.78,
    emissive: 0x1a3c52, specStep: 0.3, specSharp: 0.92, rimStrength: 0.9,
    rimColor: 0xdff4ff, shadowTint: 0x8fb4d8,
  })),
  ember: () => once('ember', () => glowMaterial(0xff8a3c, 1.9)),

  /** Elemental crystal / glowing shard, cached per colour. */
  crystal: (hex) => once(`crystal:${hex}`, () => toonMaterial({
    color: hex, bands: 2, roughness: 0.15, transparent: true, opacity: 0.86,
    emissive: new THREE.Color(hex).multiplyScalar(0.55),
    specStep: 0.28, specSharp: 0.95, rimStrength: 1.15, rimColor: hex,
    shadowTint: 0x9fb0d8,
  })),
  glow: (hex, k = 1.5) => once(`glow:${hex}:${k}`, () => glowMaterial(hex, k)),
};

/**
 * Foliage: extra-soft ramp (leaves scatter light) plus wind sway.
 *
 * Specular is switched off outright rather than merely stepped high. Leaves are
 * modelled here as smooth ellipsoids, and any tight highlight on a sphere lands as
 * a single white pixel-dot in the middle of the blob — which reads as a hole in the
 * canopy, not as a glint. The soft rim does the shaping instead.
 */
function leafMat(color, sway, extra = null) {
  return toonMaterial({
    color,
    bands: 2.0,
    rampSoft: 0.14,
    roughness: 1.0,
    specStep: 1.1,
    specSharp: 0.2,
    rimStrength: 0.22,
    rimWidth: 0.40,
    rimColor: 0xbcd884,
    // 0x646a73 rather than 0x516e7a: identical darkness (both have a linear luma of 0.143,
    // so nothing else here needs retuning) with much less saturation. Kept because a tint
    // that darkens without also acting as a narrow per-channel filter is simply the safer
    // shape for this parameter — but read the next paragraph before crediting it with
    // anything, because it did *not* fix what it was aimed at.
    //
    // What it was aimed at: an isolated pine (tools/prop-cam.mjs) measures rgb [3,106,48] on
    // its needle mass — a vivid green with essentially no red. Modelling `albedo *
    // uShadowTint` through three.js's exact tonemap reproduces that to three levels
    // ([0,105,51]), because 0x516e7a's linear red is 0.082 against its green of 0.156, and
    // multiplying that into an albedo whose red is already 0.056 lands inside the region
    // where ACES's output matrix — r = 1.60475r - 0.53108g - 0.07367b — goes negative and
    // clamps. The model predicted this tint would restore red to about 22.
    //
    // It restored it to 4. The model was incomplete: `shadowCol` is only one of several
    // albedo-proportional terms in toon.js, which also adds `albedo * skyAmbient * 0.24` and
    // `albedo * ambientLightColor * 0.32`. The effective multiplier is the *sum* of all of
    // them, the sky term is strongly blue, and it dominates — so neutralising the shadow
    // tint alone moves the result by one level. Anyone wanting the red back has to work on
    // that sum, not on this constant, and should predict the answer with the whole
    // expression first. Four attempts were spent on this single channel (shadow floor,
    // doubled tint, albedo brightening, this), all of which moved it by about two, and the
    // conclusion recorded here was that a saturated green under a blue sky ambient simply
    // has very little red once ACES is done — correct rather than broken.
    //
    // That conclusion was wrong, and the fifth attempt is `rampFloor` below. All four earlier
    // ones worked on the *coefficients* of that sum while the whole sum was being multiplied
    // by a ramp that was exactly zero on the surfaces in question; no coefficient can move a
    // product through a zero factor. Re-measured on an isolated pine afterwards, the shaded
    // needle red reads 16 on the bottom skirt and 75 mid-tree against the 4 recorded above.
    // The lesson is about the shape of the model, not the constant: check which factors can
    // be zero before tuning any of the others.
    shadowTint: 0x646a73,
    // A canopy under a genuine cast shadow — a cliff, a wall — should not crush as far as an
    // opaque boulder can afford to, so foliage lifts the shared 0.14 floor. Worth knowing
    // that this is reasoning, not measurement: it was originally raised to chase a pine that
    // sampled at luma 38-52 from the gameplay camera, and it moved that number by two, as
    // did doubling `shadowTint` afterwards. Both were dead ends for a good reason — the
    // sampled rectangles were not on the tree. Rendered isolated (tools/prop-cam.mjs pine)
    // the pine is a *bright* saturated green, and its real fault is silhouette, not value.
    // See the note in tools/pixstd.mjs: percentile spreads cannot tell you what you hit.
    shadowFloor: 0.45,
    // The term the four attempts above were missing. `shadowFloor` only caps the ramp in a
    // *cast* shadow; nothing stopped the N·L ramp itself reaching exactly 0, which with
    // `bands: 2` it does for every facet more than ~130 degrees from the sun — the entire
    // underside of any foliage lobe, lit by the shadow tint and a hemisphere ground colour
    // and nothing else. Measured on the isolated bush: lit top luma 114 (the grass beside it
    // is 117, so the top is right) against a lower mass at 17, p95 43.
    //
    // 0.14, and measurement is why it is not higher. 0.26 was tried first, on the arithmetic
    // that it would put the bush's underside in the high 40s; the underside went to 74 and
    // the *top* went from 114 to 131 — brighter than the grass beside it — because far more
    // of a flat-shaded lobe sits in the deepest band than just its underside, so lifting the
    // band to 43 % of full light does not brighten a dark edge, it erases the cel step. At
    // 0.14 the darkest band is 33 % of full light against the 21 % it was, worth about 1.5x
    // on the underside, and the rest of the lift comes from not double-baking it (below).
    rampFloor: 0.14,
    sway,
    ...extra,
  });
}

/* -------------------------------------------------------------- prototypes -- */

const V = new THREE.Vector3();
const V2 = new THREE.Vector3();

/**
 * A tapering branch/stem from `p0` heading along `dir`, bending toward `bend`.
 *
 * The reference vector is chosen from the direction rather than passed in: a
 * near-vertical spine wants the default +Z roll reference, but a branch reaching
 * out horizontally has to take +Y or the frame collapses where the tangent lines
 * up with the reference.
 */
function bough(P, mat, p0, dir, bend, len, r0, r1, steps = 5) {
  const d = V2.copy(dir).normalize().clone();
  const ref = Math.abs(d.y) > 0.7 ? undefined : UP_REF;
  P.add(sweep(SEC.oct, (t) => {
    V.copy(d).multiplyScalar(len * t);
    V.x += bend.x * len * t * t; V.y += bend.y * len * t * t; V.z += bend.z * len * t * t;
    V.add(p0);
    const r = lerp(r0, r1, t);
    return { p: V, w: r, d: r, ref };
  }, steps), mat);
}

/** Random unit-ish direction in a cone around +Y. `spread` 0 = straight up. */
function coneDir(rand, spread, az = rand.angle()) {
  const s = Math.sin(spread);
  return new THREE.Vector3(Math.cos(az) * s, Math.cos(spread), Math.sin(az) * s);
}

const TAN_A = new THREE.Vector3();
const TAN_B = new THREE.Vector3();
const TAN_X = new THREE.Vector3(1, 0, 0);
const TAN_Y = new THREE.Vector3(0, 1, 0);
/** A unit vector perpendicular to `n`, at azimuth `az` around it. */
function tangentTo(n, az) {
  TAN_A.crossVectors(n, Math.abs(n.y) > 0.9 ? TAN_X : TAN_Y).normalize();
  TAN_B.crossVectors(n, TAN_A);
  return new THREE.Vector3()
    .addScaledVector(TAN_A, Math.cos(az))
    .addScaledVector(TAN_B, Math.sin(az));
}

/* --- trees ------------------------------------------------------------------ */

const SCATTER = {};

/**
 * Bake canopy tone into one foliage clump.
 *
 * A tree's canopy is a dozen smooth-shaded near-spheres, so lighting alone gives each
 * of them a bright side and a dark side and the crown reads as a bunch of balloons.
 * What a real canopy has instead is *depth*: almost no light reaches the underside of a
 * clump or the clumps low down inside the crown, and the leaves at the top are
 * sun-bleached and yellower. None of that depends on the light direction, so it can be
 * baked — the same argument as `stoneTone` and the grass root gradient.
 *
 * `base` is the clump's own multiplier, which the caller derives from how high the
 * clump sits in the crown; `ao` is the extra darkening under each clump.
 *
 * `radial` switches which axis counts as "exposed" for cone-shaped foliage. A conifer
 * skirt is a cone whose apex is buried under the layer above and whose base ring is the
 * needle tips out in the open, so for those the gradient has to run outward from the
 * axis; measured down the y axis instead it would brighten exactly the part of the
 * skirt no light reaches.
 */
function foliageTone(geo, rand, { base = 1, ao = 0.30, radial = false } = {}) {
  const pos = geo.attributes.position;
  let lo = Infinity, hi = -Infinity, rmax = 1e-4;
  for (let i = 0; i < pos.count; i++) {
    lo = Math.min(lo, pos.getY(i));
    hi = Math.max(hi, pos.getY(i));
    rmax = Math.max(rmax, Math.hypot(pos.getX(i), pos.getZ(i)));
  }
  const span = Math.max(hi - lo, 1e-4);
  const ph = rand.float(0, TAU);
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const up = radial ? Math.hypot(x, z) / rmax : (y - lo) / span;
    let v = base * (1 - (1 - up) * ao);
    // Leaf-mass variation. Smooth in object space so a corner shared by several
    // triangles gets one value from all of them.
    v *= 1 + Math.sin(x * 3.4 + z * 2.6 + ph) * 0.05
           + Math.cos(y * 4.1 - x * 2.2 + ph * 1.6) * 0.04;
    col[i * 3] = v * (1 + up * 0.10);
    col[i * 3 + 1] = v * (1 + up * 0.05);
    col[i * 3 + 2] = v * (1 - up * 0.07);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/**
 * One foliage lobe: an ellipsoid deformed into an irregular mass, so its outline is
 * lumpy rather than circular.
 *
 * `foliageTone` fixed the *value* problem in the crown — each lobe was lit half-bright
 * half-dark and the tree read as a bunch of balloons — but photographing an oak at four
 * metres showed the other half of that complaint is the silhouette. A smooth ellipsoid
 * has a perfectly round edge at every angle, and nothing about a round edge says foliage.
 *
 * The frequencies here are bounded by the mesh, and that bound is the whole lesson. The
 * first version of this function used three octaves at 5.3 / 6.1 / 9.7 cycles per unit of
 * direction, hoping for 20-40 cm scallops. Photographed at four metres the bush came back
 * looking like crumpled paper — a ball of large flat plates with black concave pockets.
 * The arithmetic says why: `seg` segments around means a facet spans 2π/seg of direction
 * space, at seg 9 about 0.7 units, so a term at 5.3 advances 3.7 rad ≈ 0.6 *cycles per
 * facet*. That is past Nyquist, so the field was not being sampled, it was being aliased —
 * neighbouring vertices got uncorrelated offsets and every quad ended up steeply tilted
 * against its neighbours. No amount of retuning the amplitude fixes an aliased field.
 *
 * So the displacement is now strictly band-limited: two terms near 2 and 3 cycles, i.e.
 * about a quarter cycle per facet, which the mesh can actually represent. What that buys
 * is a lobe with a pear-or-kidney profile — an outline no longer a circle — while the
 * shading across it stays continuous. Leaf-scale detail (3-15 cm) does not belong in
 * geometry at this budget at all; it comes from the `mottle` grain in the fragment shader
 * and from the fringe tufts, which is the same division of labour the boulders use.
 */
function leafClump(r, sx, sy, sz, rand, seg = 9, amp = 1) {
  const g = sphere(r, seg);
  const pos = g.attributes.position;
  const ph = rand.float(0, TAU);
  // Keep the highest term at or under ~0.25 cycles per facet.
  const fMax = seg * 0.25;
  const f1 = Math.min(2.0, fMax), f2 = Math.min(3.1, fMax);
  // `amp` scales the deformation without touching the frequencies, which is the only knob
  // left once the field is band-limited: at seg 9 both terms are already clamped to 2.25
  // cycles, so finer detail would need more segments (a bush lobe at seg 13 is 234 triangles
  // against 108, times six lobes times ninety bushes a cell). Deeper dents at the same
  // frequency still change the outline, and cost nothing. Trees keep 1.0 — a 6 m crown lobe
  // deformed 40 % stops reading as a mass of leaves and starts reading as a rock.
  const a1 = 0.17 * amp, a2 = 0.12 * amp;
  // Published on the geometry so a caller can ask where the surface ended up. The fringe
  // tufts need it: they are seated along a direction at a fraction of the radius, and with
  // the field applied that radius is anywhere from 0.6 to 1.4 of the nominal one, so a
  // fraction of the *undeformed* ellipsoid lands a tuft deep inside the lobe on a bulge and
  // completely outside it in a dent. `foliageTone` returns the same geometry, so this
  // survives the wrapping.
  g.userData.clump = { ph, f1, f2, a1, a2 };
  for (let i = 0; i < pos.count; i++) {
    V.fromBufferAttribute(pos, i);
    // Displace as a function of the *unit* direction, not the scaled position: the seam
    // and pole vertices of a sphere are duplicated at identical coordinates, so a
    // positional field gives them identical offsets and the solid stays closed.
    const k = clumpK(g.userData.clump, V.x / r, V.y / r, V.z / r);
    pos.setXYZ(i, V.x * k, V.y * k, V.z * k);
  }
  g.scale(sx, sy, sz);
  g.computeVertexNormals();
  return g;
}

/** The radial factor `leafClump` applied at unit sphere-direction (nx, ny, nz). */
function clumpK({ ph, f1, f2, a1, a2 }, nx, ny, nz) {
  return 1
    + Math.sin(nx * f1 + ny * f1 * 0.8 + ph) * a1
    + Math.cos(nz * f2 - nx * f2 * 0.7 + ph * 1.4) * a2;
}

SCATTER.oak = (P, rand, o) => {
  const h = rand.float(4.4, 6.0);
  const lean = rand.float(-0.08, 0.08);
  const az = rand.angle();
  // Trunk. Reaches 0.55h before it forks: a canopy sitting at 0.6h on a trunk that
  // stopped at 0.45h reads as a mushroom, because the foliage mass ends up wider
  // than the clear trunk beneath it is tall.
  const trunkH = h * 0.55;
  const lx = (t) => Math.cos(az) * lean * h * t * t;
  const lz = (t) => Math.sin(az) * lean * h * t * t;
  P.add(sweep(SEC.oct, (t) => {
    V.set(lx(t), t * trunkH, lz(t));
    const r = lerp(0.30, 0.115, t) + (t < 0.16 ? (0.16 - t) * 0.9 : 0);
    return { p: V, w: r, d: r };
  }, 7), MATS.bark());

  // Boughs, then foliage clusters on the end of each so the canopy sits where the
  // branches actually reach instead of floating as a ball above the trunk.
  const n = rand.int(5, 6);
  const leaves = [MATS.leafA(), MATS.leafB(), MATS.leafC()];
  const clumps = [];
  for (let i = 0; i < n; i++) {
    const a = az + (i / n) * TAU + rand.float(-0.35, 0.35);
    const ty = rand.float(0.62, 1.0);
    const y = trunkH * ty;
    const dir = new THREE.Vector3(Math.cos(a) * rand.float(0.8, 1.2),
      rand.float(0.85, 1.5), Math.sin(a) * rand.float(0.8, 1.2));
    const len = h * rand.float(0.24, 0.34);
    const p0 = new THREE.Vector3(lx(ty), y, lz(ty));
    bough(P, MATS.bark(), p0, dir, new THREE.Vector3(0, 0.30, 0), len, 0.10, 0.04, 4);
    const tip = dir.clone().normalize().multiplyScalar(len).add(p0).add(V2.set(0, len * 0.30, 0));
    clumps.push({ p: tip, r: h * rand.float(0.15, 0.20), m: leaves[i % 3] });
  }
  // Crown clumps filling the middle and top, so the mass is lumpy rather than one
  // smooth dome. Each is a near-sphere — the flattened discs an earlier pass used
  // stacked into something closer to a parasol than a tree.
  const crownY = trunkH + h * 0.24;
  clumps.push({ p: new THREE.Vector3(lx(1) * 0.6, crownY, lz(1) * 0.6), r: h * 0.20, m: leaves[1] });
  for (let i = 0; i < 4; i++) {
    const a = rand.angle();
    const d = h * rand.float(0.05, 0.16);
    clumps.push({
      p: new THREE.Vector3(Math.cos(a) * d, crownY + rand.float(-0.1, 0.16) * h, Math.sin(a) * d),
      r: h * rand.float(0.12, 0.18), m: leaves[i % 3],
    });
  }
  let top = 0;
  // The tone gradient spans the canopy, not the tree: the trunk below is bark, and
  // measuring from the ground would spend most of the range on it.
  const canLo = trunkH * 0.55, canHi = crownY + h * 0.20;
  for (const c of clumps) {
    const t = THREE.MathUtils.clamp((c.p.y - canLo) / Math.max(canHi - canLo, 1e-4), 0, 1);
    P.add(foliageTone(
      leafClump(c.r, rand.float(1.0, 1.2), rand.float(0.80, 1.0), rand.float(1.0, 1.2), rand, 10),
      rand, { base: 0.74 + t * 0.34 },
    ), c.m, trs(c.p.x, c.p.y, c.p.z, rand.float(-0.2, 0.2), rand.angle(), rand.float(-0.2, 0.2)));
    // Fringe tufts, the same trick the bush has always used and the crown never had.
    //
    // Measuring the crown settled an argument I had been having with the photographs. A
    // 40x40 patch inside a lobe comes back at sd 10-29 on the green channel against sd 4
    // on a boulder face, so the canopy is not short of tonal detail at all — the mottle
    // and the baked gradient are doing their job. What it was short of is an *edge*: at
    // seg 10 a lobe's outline against the sky is a visible ten-sided polygon, and no
    // amount of surface detail fixes an outline. Displacement cannot fix it either, since
    // the mesh can only carry frequencies up to about a quarter cycle per facet (see
    // `leafClump`) and leaf clusters are far finer than that.
    //
    // So the geometry goes where it is actually visible: ~35 cm blunt tufts seated just
    // inside the lobe's surface and laid over tangentially, so they break the profile
    // without turning it into a sea urchin. They reuse the lobe's own material, so this
    // adds triangles but not a single draw call.
    // Count set by the rim, not by the surface: only tufts near the visible edge do the
    // job, and the edge is a great circle ~8 m round on a 1.25 m lobe, so a dozen spread
    // over the whole upper hemisphere puts only three or four where they count.
    for (let i = 0; i < 22; i++) {
      // Uniform over the *area* of the upper surface, which means uniform in cos of the
      // polar angle, not in the angle itself. Drawing the angle flat — the obvious thing,
      // and what the first version did — concentrates tufts at the pole, because a band
      // of constant dθ near the top covers a solid angle proportional to sin θ. It
      // photographed exactly that way: the crown grew a tufted cap while the left and
      // lower-left profile stayed a bare ten-sided arc, i.e. the fringe was densest where
      // there was least silhouette to break and absent where there was most.
      const nrm = coneDir(rand, Math.acos(rand.float(Math.cos(1.95), Math.cos(0.12))));
      // What matters for the silhouette is how far the tip clears the lobe *radially*,
      // and the lean means that is not the tuft's length. With a 0.86 tangential and 0.50
      // normal blend only ~0.5 of the length points outward, so radial reach is
      // `surf + 0.5 * len`. Two passes got this wrong in opposite directions before the
      // arithmetic got written down: 0.80-0.95 seating with 0.26-0.46 lengths reached
      // 1.4 r and left shards floating clear of the canopy, then 0.72-0.88 with 0.15-0.28
      // reached 0.80-1.02 r — at or *inside* the surface, so the fringe vanished entirely
      // and the outline went back to a bare polygon. It has to be positive and small.
      //
      // A little more normal lean (0.62 against 0.50) to buy reach without lengthening the
      // tufts, since a long tuft is what looked like a chisel mark. Still tangential
      // enough not to become the sea urchin the bush's comment warns about — these are
      // blunt, a ~40 deg half-angle, and a blunt cone leaning out reads as a lump.
      const d = tangentTo(nrm, rand.angle()).multiplyScalar(0.78)
        .addScaledVector(nrm, 0.62).normalize();
      const len = c.r * rand.float(0.36, 0.50);
      const w = len * rand.float(0.62, 0.88);
      // Base stays under the surface at every draw, so the open cone never shows its
      // hollow. Radial reach therefore lands in 1.06-1.23 r: 7-29 cm proud of a 1.25 m
      // lobe, which is leaf-cluster scale.
      const surf = c.r * rand.float(0.84, 0.92);
      P.add(spike(len, w, 4, true), c.m,
        along(c.p.x + nrm.x * surf, c.p.y + nrm.y * surf * 0.90, c.p.z + nrm.z * surf,
          d.x, d.y, d.z));
    }
    top = Math.max(top, c.p.y + c.r);
    if (o.snowy && c.p.y > crownY - h * 0.05) {
      P.add(blob(c.r * 0.92, 1.05, 0.40, 1.05, 8), MATS.snow(),
        trs(c.p.x, c.p.y + c.r * 0.52, c.p.z));
    }
  }
  return { height: top, radius: h * 0.34 };
};

/**
 * One skirt of needles: a cone whose rim is a sawtooth rather than a circle.
 *
 * A conifer built from `spike` cones reads as a stack of paper party hats, and the
 * reason is the silhouette, not the shading — every edge is a straight line from apex to
 * a perfect circle. What the eye actually uses to identify a spruce at fifty metres is
 * the ragged outline: branches at each whorl reach different distances, and the ones in
 * between fall short. So the rim radius is jittered per radial segment, alternating long
 * and short so the sawtooth survives even where the jitter happens to agree, and the rim
 * height is jittered too, since a branch droops as much as it splays.
 *
 * The rim jitter fixes the *outline*, and on its own that was not enough: photographed in
 * Mondstadt the pine still read as six stacked paper plates. The reason is the faces rather
 * than the edge. A skirt built as a single fan is `seg` triangles from apex straight to rim,
 * each one about 1.5 m across, non-indexed and therefore flat-normalled — so the cel ramp
 * paints each whole plate a single band, and nine hard-edged plates per whorl is precisely
 * the party-hat look the ragged rim was meant to cure.
 *
 * So the skirt is a two-ring surface now. The mid ring sits at just over half the rim
 * radius but is lifted above the straight apex-to-rim line, which makes the profile convex:
 * a branch that leaves the trunk shallow and falls away steeply at the tip, the way a spruce
 * whorl actually hangs. That both breaks each plate into three smaller facets and gives the
 * skirt a curved cross-section, so successive facets land in different bands and the whorl
 * shades as a drooping mass instead of a lid.
 *
 * Cost: 4 triangles per segment rather than 2, and `seg` 12 rather than 9 for an outline
 * that is a 12-gon instead of a 9-gon — 48 per skirt against 18, so roughly 430 per tree
 * against 160. That is affordable precisely because a conifer is cheap to begin with; the
 * grass in the same frame costs five figures.
 */
function needleSkirt(len, r, rand, seg = 12) {
  const pos = [];
  const rim = [];
  const mid = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * TAU;
    // Alternating long/short so the sawtooth survives even where the jitter happens to
    // agree between neighbours. `seg` must stay even or the alternation collides with
    // itself at the seam and one tooth goes missing.
    const long = i % 2 === 0 ? 1.0 : 0.74;
    const rr = r * long * rand.float(0.86, 1.14);
    const ry = len * rand.float(-0.14, 0.06);
    rim.push([Math.cos(a) * rr, ry, Math.sin(a) * rr]);
    // Lifted off the chord by ~0.11 len: this is the whole droop. Interpolating linearly
    // here would leave the profile straight and put the plates back.
    const f = 0.52;
    mid.push([Math.cos(a) * rr * f, lerp(len, ry, f) + len * rand.float(0.08, 0.14), Math.sin(a) * rr * f]);
  }
  const apex = [0, len, 0];
  // A shallow cup rather than a flat disc: the underside of a whorl is visible from
  // below and a flat cap there catches the light as one hard grey lid.
  const nave = [0, len * 0.16, 0];
  // Winding: rim points advance from +x toward +z, which makes (upper, next, current)
  // the *outward* face. Got that backwards first time round and every pine in Mondstadt
  // rendered solid black — front-face culling left only the inside of the cone visible,
  // which is unlit by construction. The underside fan is the mirror of the sides.
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    pos.push(...apex, ...mid[j], ...mid[i]);
    pos.push(...mid[i], ...rim[j], ...rim[i]);
    pos.push(...mid[i], ...mid[j], ...rim[j]);
    pos.push(...nave, ...rim[i], ...rim[j]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}

SCATTER.pine = (P, rand, o) => {
  const h = rand.float(6.0, 8.5);
  P.add(loft(SEC.oct, 0, h * 0.96, (t) => {
    const r = lerp(0.26, 0.05, t) + (t < 0.10 ? (0.10 - t) * 0.9 : 0);
    return { w: r, d: r };
  }, 6), MATS.barkPine());

  // Stacked skirts. Each layer overlaps the one below by ~40% of its own height,
  // which is what gives a conifer its shingled silhouette instead of a plain cone.
  // 8-10, not 6-8, and the upper skirts no longer shrink to 0.10h: photographed at ten
  // metres the old stack had daylight between every whorl above the midpoint, because
  // there the layer spacing (0.11h) had overtaken the skirt length. A spruce is opaque.
  const layers = rand.int(8, 10);
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const y = h * lerp(0.22, 0.90, t);
    const r = h * lerp(0.20, 0.035, t) * rand.float(0.92, 1.08);
    const len = h * lerp(0.21, 0.14, t);
    // Two gradients, both baked: down the tree, because the bottom skirts of a spruce
    // sit under six layers of needles and are nearly black in daylight; and out from
    // the axis of each skirt, because that is the direction the light gets in from.
    // Without them the stack is eight identically-lit cones and the tree reads as a
    // pagoda — the same failure the oak crown had before `foliageTone`.
    // 0.80..1.10, not 0.66..1.08: needleB is already 0x21432b, and multiplying a colour
    // that dark by 0.66 and then by the radial term put the bottom two skirts at pure
    // black on screen. A spruce's lower whorls are dark, not absent.
    P.add(foliageTone(needleSkirt(len, r, rand), rand,
      { base: 0.80 + t * 0.30, ao: 0.24, radial: true }),
      i % 2 ? MATS.needleA() : MATS.needleB(),
      trs(0, y, 0, 0, rand.angle(), 0));
    if (o.snowy) {
      // Snow follows the branch tips it settles on, so it gets the ragged rim too —
      // a clean cone of snow on a ragged skirt reads as a hat sitting on the tree.
      P.add(needleSkirt(len * 0.42, r * 0.90, rand), MATS.snow(),
        trs(0, y + len * 0.52, 0, 0, rand.angle(), 0));
    }
  }
  return { height: h, radius: h * 0.20 };
};

SCATTER.bamboo = (P, rand) => {
  const culms = rand.int(3, 5);
  let top = 0;
  for (let c = 0; c < culms; c++) {
    const h = rand.float(5.0, 7.5);
    const r = rand.float(0.045, 0.070);
    const a = rand.angle();
    const off = rand.float(0.1, 0.5);
    const lean = rand.float(0.02, 0.09);
    const ox = Math.cos(a) * off, oz = Math.sin(a) * off;
    P.add(sweep(SEC.oct, (t) => {
      V.set(ox + Math.cos(a) * lean * h * t * t, t * h, oz + Math.sin(a) * lean * h * t * t);
      return { p: V, w: r * (1 - t * 0.35), d: r * (1 - t * 0.35) };
    }, 8), MATS.bamboo());
    // Nodes: the joint rings are most of what identifies bamboo at a distance.
    const nodes = Math.floor(h / 0.85);
    for (let i = 1; i <= nodes; i++) {
      const t = i / (nodes + 1);
      P.add(ring(r * (1 - t * 0.3) * 1.15, r * 0.22, 5, 8), MATS.bamboo(),
        trs(ox + Math.cos(a) * lean * h * t * t, t * h,
          oz + Math.sin(a) * lean * h * t * t, Math.PI / 2, 0, 0));
    }
    // Leaf sprays near the top.
    for (let i = 0; i < 7; i++) {
      const t = rand.float(0.62, 0.98);
      const la = rand.angle();
      const dir = new THREE.Vector3(Math.cos(la), rand.float(0.1, 0.6), Math.sin(la)).normalize();
      const len = rand.float(0.45, 0.85);
      const px = ox + Math.cos(a) * lean * h * t * t, py = t * h;
      const pz = oz + Math.sin(a) * lean * h * t * t;
      P.add(sweep(SEC.lens, (u) => {
        V.set(px + dir.x * len * u, py + dir.y * len * u - u * u * len * 0.5,
          pz + dir.z * len * u);
        return { p: V, w: 0.055 * Math.sin(u * Math.PI) + 0.004, d: 0.008, ref: UP_REF };
      }, 4), MATS.bambooLeaf());
    }
    top = Math.max(top, h);
  }
  return { height: top, radius: 0.9 };
};

SCATTER.deadTree = (P, rand, o) => {
  const h = rand.float(4.0, 6.0);
  const az = rand.angle();
  P.add(sweep(SEC.oct, (t) => {
    V.set(Math.cos(az) * 0.16 * h * t * t, t * h * 0.72, Math.sin(az) * 0.16 * h * t * t);
    const r = lerp(0.26, 0.06, t) + (t < 0.12 ? (0.12 - t) * 0.8 : 0);
    return { p: V, w: r, d: r };
  }, 7), MATS.barkDead());
  // Bare forks, each splitting once — a dead tree is read entirely by its branching.
  for (let i = 0; i < 5; i++) {
    const y = h * rand.float(0.34, 0.66);
    const a = rand.angle();
    const dir = new THREE.Vector3(Math.cos(a), rand.float(0.6, 1.3), Math.sin(a));
    const len = h * rand.float(0.20, 0.34);
    const p0 = new THREE.Vector3(Math.cos(az) * 0.16 * h * 0.4, y, Math.sin(az) * 0.16 * h * 0.4);
    bough(P, MATS.barkDead(), p0, dir, new THREE.Vector3(0, -0.25, 0), len, 0.085, 0.02, 4);
    const tip = dir.clone().normalize().multiplyScalar(len * 0.9).add(p0);
    bough(P, MATS.barkDead(), tip,
      new THREE.Vector3(Math.cos(a + 1.1), rand.float(0.8, 1.5), Math.sin(a + 1.1)),
      new THREE.Vector3(0, -0.2, 0), len * 0.6, 0.03, 0.010, 3);
  }
  if (o.snowy) P.add(blob(h * 0.09, 1.4, 0.5, 1.4, 8), MATS.snow(), trs(0, h * 0.72, 0));
  return { height: h * 0.8, radius: h * 0.25 };
};

/* --- rocks ------------------------------------------------------------------ */

/**
 * Bake a per-vertex stone tone into a rock geometry.
 *
 * Cel bands cannot do this job, and measuring is what showed it: a boulder is a
 * smooth-shaded solid whose side facets all point outward, so under a high sun they
 * share one N·L and the ramp gives them one tone however many bands it has — the lit
 * crown came out at sRGB 188 and every side facet within a few counts of 60, with
 * nothing between. Broken stone varies face to face because the rock *is* different
 * colours there, so the variation belongs in the albedo. Same reasoning as the grass
 * canopy's root gradient: put it in the surface, not in the light.
 *
 * The tone field is smooth in object space rather than per-face, so a corner shared by
 * five triangles gets one value from all of them and the solid does not turn to
 * confetti. `dirt` scales the darkening at the ground line.
 */
function stoneTone(geo, rand, dirt = 1.0) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    lo = Math.min(lo, pos.getY(i));
    hi = Math.max(hi, pos.getY(i));
  }
  const span = Math.max(hi - lo, 1e-4);
  const ph = rand.float(0, TAU);
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let v = 1
      + Math.sin(x * 2.7 + y * 1.9 + ph) * 0.055
      + Math.cos(z * 3.3 - x * 2.1 + ph * 1.7) * 0.045;
    // Dust and shade collect where stone meets soil, over roughly the bottom 40 %.
    const up = Math.min(1, (y - lo) / span / 0.42);
    v *= 1 - (1 - up) * dirt * 0.30;
    // Weathered crowns: what faces the sky is bleached and warm, the rest is not.
    const bleach = Math.max(0, nrm.getY(i)) ** 2 * 0.085;
    col[i * 3] = v + bleach;
    col[i * 3 + 1] = v + bleach * 0.85;
    col[i * 3 + 2] = v + bleach * 0.5;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

SCATTER.rock = (P, rand, o) => {
  const r = rand.float(0.7, 1.5);
  // An icosahedron with its vertices pushed along their own normals. Displacing the
  // *indexed* geometry means shared corners move together, so the solid stays
  // closed; flattening to non-indexed afterwards is what keeps the facets crisp.
  const g = new THREE.IcosahedronGeometry(r, 1);
  const pos = g.attributes.position;
  const ph = rand.float(0, TAU);
  for (let i = 0; i < pos.count; i++) {
    V.fromBufferAttribute(pos, i);
    // Two frequencies. One alone gives a smoothly swollen ball; the second, finer
    // and phase-shifted, is what breaks the profile into the flat faces and sharp
    // corners that read as fractured stone.
    const k = 1
      + Math.sin(V.x * 3.1 + V.y * 2.3 + ph) * 0.17
      + Math.cos(V.z * 2.7 - V.y * 1.9 + ph) * 0.15
      + Math.sin(V.x * 7.4 - V.z * 6.1 + ph * 2) * 0.085
      + Math.cos(V.y * 8.3 + V.x * 5.7) * 0.07;
    V.multiplyScalar(k);
    pos.setXYZ(i, V.x, V.y * 0.78, V.z);
  }
  g.computeVertexNormals();
  const stone = o.dark ? MATS.stoneVariedDark() : MATS.stoneVaried();
  P.add(stoneTone(g, rand), stone,
    trs(0, r * 0.52, 0, rand.float(-0.2, 0.2), rand.angle(), rand.float(-0.2, 0.2),
      rand.float(0.85, 1.25), rand.float(0.7, 1.1), rand.float(0.85, 1.25)));
  // A couple of chips at the base tie the boulder to the ground. Heavier dirt on
  // these: a chip is half buried, where the boulder only rests.
  for (let i = 0; i < rand.int(1, 3); i++) {
    const a = rand.angle(), d = r * rand.float(0.7, 1.1), s = r * rand.float(0.16, 0.30);
    P.add(stoneTone(new THREE.IcosahedronGeometry(s, 0), rand, 1.6), stone,
      trs(Math.cos(a) * d, s * 0.5, Math.sin(a) * d, rand.angle(), rand.angle(), rand.angle()));
  }
  if (o.snowy) {
    P.add(blob(r * 0.92, 1.0, 0.34, 1.0, 10), MATS.snow(),
      trs(0, r * 0.86, 0, rand.float(-0.12, 0.12), 0, rand.float(-0.12, 0.12)));
  }
  return { height: r * 1.2, radius: r * 1.1 };
};

/* --- ground cover ----------------------------------------------------------- */

SCATTER.grassTuft = (P, rand, o) => {
  // Fixed nominal height, not a random one: the scatter converts a target height in
  // metres into a scale by dividing by an assumed proto height, so randomising the
  // proto here multiplies two unknowns and a "0.5 m" tuft comes out anywhere between
  // 0.35 and 0.65. Per-tuft variety belongs in the placement scale, where it is
  // free; blade-to-blade variety inside the tuft is still random below.
  const h = o.height ?? 0.5;
  // A tuft has to cover ground, not just stand on it. At a plausible scatter density
  // — one or two per square metre — a five-blade rosette 20 cm across leaves the
  // ground bare between tufts, and the eye reads the *gaps*, so the meadow looks
  // like weeds on a lawn. Ten to fifteen blades fanning out to ~40 cm, each rooted
  // at its own offset from the centre rather than all from one point, closes the
  // canopy at the same instance count. Strips are cheap enough to afford it.
  const blades = rand.int(10, 14);
  // Roughly one tuft in five is strawy even in a lush zone. A meadow of one green,
  // however many shades of it, is a carpet; the dry patches are what make the eye
  // read *plants*. Chosen per tuft rather than per blade, because a single shoot
  // going yellow inside a green clump is a diseased plant, not a dry one.
  const dry = o.dry || rand.float(0, 1) < 0.20;
  // Three shades struck from the zone's own pair (`terrain.grassColorA/B`, passed through by
  // world.js#_recipes) and falling back to Mondstadt's greens for callers with no zone. The
  // light and strawy shades are derived rather than authored, so a zone only has to keep two
  // colours honest; see lightBlade/dryBlade above.
  const cA = o.color ?? BLADE_A, cB = o.colorB ?? BLADE_B;
  const mats = dry
    ? [MATS.blade(dryBlade(cA), 0.070), MATS.blade(dryBlade(cA), 0.070),
      o.dry ? MATS.blade(cA, 0.075) : MATS.blade(cB, 0.062)]
    : [MATS.blade(cA, 0.075), MATS.blade(cB, 0.062), MATS.blade(lightBlade(cA), 0.082)];
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * TAU + rand.float(-0.55, 0.55);
    const len = h * rand.float(0.55, 1.15);
    // Spread relative to length, and deliberately wide. The scatter scales the whole
    // tuft uniformly from its target *height*, so a 25 cm meadow tuft is also a
    // narrow one — and at knee height the ground between narrow tufts is what the
    // eye lands on. Splaying to ~1.4x the blade length keeps the canopy closed as
    // the grass gets shorter, which is how real turf works: short grass leans over.
    const outward = rand.float(0.55, 1.45);
    // 3-5 cm across at half a metre tall. The previous 8 % of length gave a 6 cm
    // blade, which at this height is a maize leaf: the field read as a crop, and
    // fineness is most of what separates meadow grass from foliage.
    const w = len * rand.float(0.020, 0.038);
    // Root offset: a fan sharing one origin is a shuttlecock, and a real tuft is
    // several shoots from a patch of soil.
    const rr = rand.float(0, 0.11);
    const rx = Math.cos(a) * rr;
    const rz = Math.sin(a) * rr;
    // Each blade arcs outward and droops at the tip: a fan of straight spikes
    // reads as a sea urchin, and the droop is the whole difference.
    //
    // Flat strips, not swept tubes. A tuft is the most numerous object in the game
    // — tens of thousands are resident — so its cost sets the whole scene's
    // budget, and blade *thickness* is the one detail that is never visible.
    // Facing the width across the blade's own outward direction keeps a tuft from
    // vanishing when it is viewed edge-on: each blade lies in its own plane.
    const ref = V2.set(-Math.sin(a), 0, Math.cos(a));
    P.add(ribbon((t) => {
      V.set(rx + Math.cos(a) * outward * len * t * t, len * t * (1 - t * 0.22),
        rz + Math.sin(a) * outward * len * t * t);
      return { p: V, w: w * (1 - t * 0.92) + 0.002, ref };
    }, 3), mats[rand.int(0, mats.length - 1)]);
  }
  return { height: h, radius: h * 0.6 };
};

/** Shared flower body: a stem, a ring of petals and a centre. */
function flower(P, rand, spec) {
  const stemH = spec.stemH * rand.float(0.85, 1.15);
  const lean = rand.float(0, 0.10);
  const az = rand.angle();
  P.add(sweep(SEC.quad, (t) => {
    V.set(Math.cos(az) * lean * stemH * t * t, stemH * t, Math.sin(az) * lean * stemH * t * t);
    return { p: V, w: 0.010, d: 0.010 };
  }, 3), MATS.grassB());
  // Two leaves low on the stem.
  for (const s of [-1, 1]) {
    P.add(sweep(SEC.lens, (t) => {
      V.set(s * t * 0.10, stemH * 0.30 + t * 0.05, 0);
      return { p: V, w: 0.030 * Math.sin(t * Math.PI) + 0.003, d: 0.005, ref: UP_REF };
    }, 3), MATS.grassA(), trs(0, 0, 0, 0, rand.angle(), 0));
  }

  const top = new THREE.Vector3(Math.cos(az) * lean * stemH, stemH, Math.sin(az) * lean * stemH);
  const n = spec.petals;
  const pitch = spec.pitch ?? 0.5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rand.float(-0.12, 0.12);
    const d = coneDir(rand, pitch, a);
    const geo = spec.pointed
      ? spike(spec.petalLen, spec.petalW, 4)
      : blob(spec.petalW, 1.0, 0.34, spec.petalLen / spec.petalW, 8);
    // A round petal is a flattened blob whose long axis has to end up along the
    // outward direction, so it is built along +Y and aimed like a spike.
    const m = along(top.x, top.y, top.z, d.x, d.y, d.z);
    if (!spec.pointed) m.multiply(trs(0, spec.petalLen * 0.45, 0));
    P.add(geo, spec.petal, m);
  }
  P.add(sphere(spec.coreR, 8), spec.core, trs(top.x, top.y + spec.coreR * 0.4, top.z));
  return { height: stemH + spec.petalLen, radius: spec.petalLen * 1.4 };
}

SCATTER.sweetFlower = (P, rand) => flower(P, rand, {
  stemH: 0.24, petals: 5, petalLen: 0.085, petalW: 0.045, coreR: 0.024, pitch: 0.75,
  petal: once('petal:sweet', () => leafMat(0xe8628c, 0.03)),
  core: once('core:sweet', () => leafMat(0xffd75e, 0.03)),
});

SCATTER.windwheelAster = (P, rand) => flower(P, rand, {
  stemH: 0.34, petals: 5, petalLen: 0.10, petalW: 0.028, coreR: 0.020, pitch: 0.95,
  pointed: true,
  petal: once('petal:aster', () => leafMat(0xa8d8f0, 0.035)),
  core: once('core:aster', () => leafMat(0xf0f8ff, 0.035)),
});

SCATTER.qingxin = (P, rand) => flower(P, rand, {
  stemH: 0.30, petals: 5, petalLen: 0.075, petalW: 0.040, coreR: 0.020, pitch: 0.62,
  petal: once('petal:qingxin', () => leafMat(0xeef4f8, 0.03)),
  core: once('core:qingxin', () => leafMat(0x7fb8e0, 0.03)),
});

SCATTER.mint = (P, rand) => {
  // No bloom: mint is a leaf cluster, and giving it petals made it read as a
  // generic weed indistinguishable from the asters next to it.
  const h = rand.float(0.22, 0.32);
  // Leaves in two whorls, both angled well above horizontal. Splayed nearly flat, as
  // a first pass had them, mint ends up a green splat lying on the ground that is
  // invisible against the terrain from player camera height.
  for (let ring = 0; ring < 2; ring++) {
    const n = ring ? 5 : 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + ring * 0.5 + rand.float(-0.2, 0.2);
      const up = ring ? rand.float(1.5, 2.4) : rand.float(0.85, 1.5);
      const len = h * rand.float(0.85, 1.35) * (ring ? 0.75 : 1);
      const base = ring ? h * 0.42 : h * 0.10;
      const d = new THREE.Vector3(Math.cos(a), up, Math.sin(a)).normalize();
      P.add(sweep(SEC.lens, (t) => {
        V.set(d.x * len * t, base + d.y * len * t - t * t * len * 0.20, d.z * len * t);
        return { p: V, w: len * 0.34 * Math.sin(t * Math.PI) + 0.004, d: 0.006, ref: UP_REF };
      }, 4), i % 2 ? MATS.leafC() : MATS.leafA());
    }
  }
  return { height: h, radius: h * 1.0 };
};

/**
 * A mushroom cluster: two or three caps of different sizes on short stems.
 *
 * A single cap reads as a golf ball on a stick from player camera height, and the
 * whole reason to draw a gatherable is that it is recognisable at ten metres — so
 * the recipe is a *cluster*, with one clearly dominant cap and a couple of smaller
 * ones leaning away from it.
 */
SCATTER.mushroom = (P, rand) => {
  const caps = rand.int(2, 4);
  let top = 0;
  for (let i = 0; i < caps; i++) {
    // The first cap is the big one and sits at the centre; the rest are satellites.
    const big = i === 0;
    const capR = (big ? rand.float(0.085, 0.115) : rand.float(0.045, 0.075));
    const stemH = capR * rand.float(1.5, 2.2);
    const a = rand.angle();
    const off = big ? 0 : rand.float(0.06, 0.13);
    const cx = Math.cos(a) * off, cz = Math.sin(a) * off;
    const lean = big ? 0 : rand.float(0, 0.22);
    // Stem: a slightly bulging column. Straight cylinders read as furniture legs.
    P.add(loft(SEC.oct, 0, stemH, (t) => ({
      w: capR * (0.30 - t * 0.08 + Math.max(0.0, 0.10 - t) * 0.5),
      d: capR * (0.30 - t * 0.08 + Math.max(0.0, 0.10 - t) * 0.5),
    }), 4), MATS.mushStem(), trs(cx, 0, cz, lean * Math.sin(a), 0, -lean * Math.cos(a)));
    // Cap: a squashed dome, wider than tall, with a lip that hangs below the join.
    const tipx = cx + Math.sin(lean) * stemH * Math.sin(a);
    const tipz = cz - Math.sin(lean) * stemH * Math.cos(a);
    P.add(blob(capR, 1.0, rand.float(0.52, 0.74), 1.0, 9),
      i % 2 ? MATS.mushCapB() : MATS.mushCapA(),
      trs(tipx, stemH * 0.96, tipz, 0, rand.angle(), 0));
    top = Math.max(top, stemH + capR * 0.7);
  }
  return { height: top, radius: 0.20 };
};

/**
 * A wheat clump: straight stalks with a heavy grain head that bends the tip over.
 *
 * Deliberately taller and stiffer than a grass tuft, because the two are drawn in
 * the same fields and a cereal that droops like meadow grass is invisible in it.
 */
SCATTER.wheat = (P, rand) => {
  const stalks = rand.int(5, 8);
  const h = rand.float(0.55, 0.78);
  for (let i = 0; i < stalks; i++) {
    const a = (i / stalks) * TAU + rand.float(-0.4, 0.4);
    const len = h * rand.float(0.8, 1.1);
    const bend = rand.float(0.10, 0.26);
    const rr = rand.float(0, 0.055);
    const rx = Math.cos(a) * rr, rz = Math.sin(a) * rr;
    // Stalk: nearly vertical, curving over only in the top third under the head.
    P.add(sweep(SEC.quad, (t) => {
      const drop = t * t * t * bend;
      V.set(rx + Math.cos(a) * drop * len, len * t * (1 - t * 0.06),
        rz + Math.sin(a) * drop * len);
      return { p: V, w: 0.007 * (1 - t * 0.4) + 0.002, d: 0.007 * (1 - t * 0.4) + 0.002 };
    }, 4), MATS.bladeDry());
    // Grain head: a spindle at the tip, aimed along the stalk's final direction.
    const hx = rx + Math.cos(a) * bend * len, hz = rz + Math.sin(a) * bend * len;
    const dir = new THREE.Vector3(Math.cos(a) * bend * 2.2, 1.0, Math.sin(a) * bend * 2.2).normalize();
    const hl = len * rand.float(0.20, 0.30);
    P.add(loft(SEC_HEX, 0, hl, (t) => {
      const w = Math.sin(Math.max(t, 0.04) * Math.PI) * hl * 0.19 + 0.004;
      return { w, d: w, roll: t * 3.0 };
    }, 5), MATS.grain(), along(hx, len * 0.94, hz, dir.x, dir.y, dir.z));
  }
  return { height: h, radius: 0.22 };
};

SCATTER.bush = (P, rand, o) => {
  const r = rand.float(0.60, 0.95);
  const lobes = rand.int(5, 7);
  // Lobe centres are lifted to ~0.8r and only mildly flattened. Sitting them at
  // 0.55r with sy 0.86, as a first pass did, buried the lower half of every lobe in
  // the ground and left a green pancake with no dome to it.
  let top = 0;
  const masses = [];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * TAU + rand.float(-0.3, 0.3);
    // Wide spread of lobe sizes: equal spheres in a tight ring fuse into one smooth
    // ball, and it is the size difference between neighbours that keeps the clumps
    // readable as separate masses.
    const d = r * rand.float(0.28, 0.60);
    const lr = r * rand.float(0.32, 0.54);
    const y = r * rand.float(0.55, 0.95) - d * 0.35;
    const c = new THREE.Vector3(Math.cos(a) * d, y, Math.sin(a) * d);
    // Unequal horizontal axes and a lean, both per lobe — and this, not the displacement
    // noise, is what breaks the circle.
    //
    // `leafClump` displaces a sphere and was being scaled (1.10, 0.94, 1.10): a body of
    // revolution about Y. Its outline is then *identical* from every horizontal angle, and
    // the `rand.angle()` yaw it used to be placed with spun it about its own axis of
    // revolution, so by construction that randomisation could not change the profile at
    // all. Measured on tools/prop-cam.mjs shot 2 (a long lens, where perspective stops
    // disguising it): a near-perfect dark disc. Six ellipsoids each leaning a different
    // way present six different ellipses from any one viewpoint, for no extra triangle.
    // Kept under 1.22 because the lobe ring already reaches 0.60r and the returned
    // `radius` has to contain it.
    const s = new THREE.Vector3(1.10 * rand.float(0.86, 1.22), 0.94, 1.10 * rand.float(0.86, 1.22));
    const ta = rand.angle();
    const tilt = rand.float(0.14, 0.40);
    const rx = Math.cos(ta) * tilt, rz = Math.sin(ta) * tilt;
    const ry = rand.angle();
    // The tufts below are placed in bush space, so they need the same rotation the lobe
    // got; keeping it as a quaternion beside the lobe is what stops the two drifting apart.
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
    // Same treatment as the oak's crown, for the same two reasons: a scalloped outline
    // instead of a circular one, and a baked gradient so the underside of the shrub is
    // dark whichever way the sun happens to be. The leafy fringe below already breaks
    // the *top* of each lobe; what it cannot do is fix the profile against the sky.
    const lobe = foliageTone(leafClump(lr, s.x, s.y, s.z, rand, 9, 1.45), rand,
      { base: 0.82 + THREE.MathUtils.clamp(y / Math.max(r, 1e-4), 0, 1) * 0.24, ao: 0.26 });
    P.add(lobe,
      i % 3 === 0 ? MATS.bushLeafC() : (i % 2 ? MATS.bushLeafB() : MATS.bushLeafA()),
      trs(c.x, c.y, c.z, rx, ry, rz));
    masses.push({ c, lr, s, q, k: lobe.userData.clump });
    top = Math.max(top, y + lr * (s.y * Math.cos(tilt) + Math.max(s.x, s.z) * Math.sin(tilt)));
  }
  // Leafy fringe, distributed over *each lobe's own surface* rather than around one
  // shared centre. This is the part that decides whether the thing reads as a shrub
  // or as a melon. Three earlier passes failed here: a handful of long thin spines
  // gave a cactus; thirty leaves aimed from the middle all surfaced through the top,
  // leaving the lower two thirds a bald ball; and aiming each tuft straight *out*
  // along the lobe normal — the obvious thing — turned the silhouette into a sea
  // urchin, every tuft reading as a thorn against the sky.
  // Eleven small tufts per lobe rather than seven big ones. At 0.46-0.78 of the lobe radius
  // a tuft on a 0.9 m shrub is a 40 cm four-sided cone — four triangles that size read as
  // folded card, which is exactly what the close-up showed: a smooth ball with a handful of
  // paper aeroplanes stuck in it. The fringe only works if a tuft is small enough to be a
  // clump of leaves rather than a feature of the silhouette.
  //
  // Measured cost of this whole pass (more tufts, closed bases): 66 triangles a lobe against
  // 28, and Mondstadt went from 902 k triangles to 946 k with the same draw calls and the
  // same framerate — about 5 %, on the one zone that scatters bushes at full density.
  for (const m of masses) {
    for (let i = 0; i < 11; i++) {
      // Down to ~0.35 rad below horizontal, so the sides and the underskirt get
      // leaves too and the mass is fringed all the way round.
      //
      // Stratified rather than uniformly random, in both angles. Eleven independent
      // directions on a sphere leave gaps the size of the samples — the close-up showed one
      // lobe fringed across its top and right and bald down its whole left face, which is
      // not bad luck, it is what eleven uniform samples look like. One tuft per 1/11 of the
      // azimuth, jittered by less than half a slot, and the polar angle marched through
      // three bands so top, side and underskirt each get their share.
      const nrm = coneDir(rand, 0.30 + 1.62 * ((i % 3) + rand.float(0, 1)) / 3,
        (i / 11) * TAU + rand.float(-0.14, 0.14) * TAU);
      // Where the lobe's surface actually is along that direction: displace the unit
      // sphere by the lobe's own field, then apply the lobe's axis lengths. Both steps
      // matter and each was got wrong in turn. Sizing tufts off `m.lr` alone left the big
      // front lobes bald, because a 0.2 m leaf sunk into a 0.7 m lobe leaves a centimetre
      // showing; sizing them off the *undeformed* ellipsoid then left the dents bald and
      // pushed the bulges' tufts right out of the mass, because at amp 1.45 the field moves
      // the surface between 0.58 and 1.42 of nominal — a bigger error than the one before it.
      const sp = new THREE.Vector3(nrm.x * m.s.x, nrm.y * m.s.y, nrm.z * m.s.z)
        .multiplyScalar(m.lr * clumpK(m.k, nrm.x, nrm.y, nrm.z));
      const lr = sp.length();
      // Outward *from the lobe*, which on an ellipsoid is not the sphere direction.
      const out = sp.clone().normalize();
      // Then lay the tuft *along* the surface: mostly tangential with only a little
      // lift off it. Foliage grows outward from a branch and then falls over, so the
      // edge of a shrub is a row of lumps, not a ring of points.
      const d = tangentTo(out, rand.angle()).multiplyScalar(0.88)
        .addScaledVector(out, 0.48).normalize();
      const len = lr * rand.float(0.30, 0.52);
      // Blunt: a base radius of 0.62-0.84 of the length is a ~35° half-angle, against
      // ~23° before. Together with the tangential lean this is what turns a spine
      // into a clump of leaves.
      const w = len * rand.float(0.62, 0.84);
      // Into the lobe's own frame, then out to bush space: position *and* direction take
      // the lobe's rotation, or a leaning lobe drags its fringe out through one side.
      const p = sp.multiplyScalar(rand.float(0.78, 0.92)).applyQuaternion(m.q).add(m.c);
      d.applyQuaternion(m.q);
      // Closed base, and three sides rather than four to hold the cost down: six triangles
      // against the open four-sided cone's four (a closed four-sided one is eight). The old comment here read "open base: it is seated inside the lobe, so the
      // cap is never visible", and that was simply false: the tuft is laid *tangentially*,
      // so its base disc stands perpendicular to the surface and its rim reaches `w` back
      // out through it — with w up to 0.44 of the local radius against a seating depth of
      // 0.1-0.2, the base is exposed on most tufts. An exposed open base does not read as a
      // gap, it reads as a black hole, because the only thing behind it is the inverted-hull
      // outline shell drawing its backfaces. Those black quads are visible in every close-up
      // of this prop ever taken, including the ones from before this pass touched it.
      P.add(spike(len, w, 3, false),
        i % 3 === 0 ? MATS.bushLeafC() : (i % 2 ? MATS.bushLeafA() : MATS.bushLeafB()),
        along(p.x, p.y, p.z, d.x, d.y, d.z));
    }
  }
  if (o.snowy) P.add(blob(r * 0.80, 1.15, 0.36, 1.15, 9), MATS.snow(), trs(0, top * 0.92, 0));
  // 1.32r, not 1.25r: the outermost lobe centre is at 0.60r and a lobe now reaches
  // 0.54r * 1.10 * 1.22 along its long axis. The number is a collider and a scatter
  // spacing, so it has to contain the geometry rather than describe the average.
  return { height: top + r * 0.25, radius: r * 1.32 };
};

SCATTER.crystal = (P, rand, o) => {
  const hex = o.color ?? 0x8fe3f0;
  const mat = MATS.crystal(hex);
  const h = rand.float(0.9, 1.8);
  const shards = rand.int(3, 5);
  // Rock collar first: a crystal growing straight out of flat ground looks stuck on.
  P.add(new THREE.IcosahedronGeometry(h * 0.26, 0), MATS.stoneDark(),
    trs(0, h * 0.10, 0, rand.angle(), rand.angle(), rand.angle(), 1.3, 0.6, 1.3));
  for (let i = 0; i < shards; i++) {
    const a = (i / shards) * TAU + rand.float(-0.3, 0.3);
    const tilt = rand.float(0.12, 0.42);
    const len = h * (i === 0 ? 1.0 : rand.float(0.45, 0.85));
    const w = len * rand.float(0.12, 0.20);
    const d = coneDir(rand, tilt, a);
    const off = i === 0 ? 0 : h * rand.float(0.10, 0.26);
    P.add(loft(SEC_HEX, 0, len, (t) => ({
      // Two-stage taper: a prism most of the way, then a fast point. A cone that
      // tapers evenly reads as a spike of ice, not a faceted crystal.
      w: w * (t < 0.72 ? 1 - t * 0.18 : (1 - t) / 0.28 * 0.87),
      d: w * (t < 0.72 ? 1 - t * 0.18 : (1 - t) / 0.28 * 0.87),
      roll: 0.2,
    }), 4), mat, along(Math.cos(a) * off, 0, Math.sin(a) * off, d.x, d.y, d.z));
  }
  P.add(sphere(h * 0.10, 8), MATS.glow(hex, 2.2), trs(0, h * 0.22, 0));
  return { height: h, radius: h * 0.5, glowColor: hex };
};

/**
 * A gatherable ore outcrop: a low boulder with faceted ore growing out of one side.
 *
 * Built as a rock plus crystal prisms rather than a glowing lump, because the player
 * has to be able to tell a node they can mine from the hundreds of scatter rocks
 * they cannot. The ore's own colour does that job at distance; the size difference
 * does it up close (a node is deliberately smaller than a scatter boulder).
 */
SCATTER.oreNode = (P, rand, o) => {
  const hex = o.color ?? 0x8a7a68;
  const h = rand.float(0.42, 0.62);
  // Host rock: two overlapping low icosahedra, squashed so it sits in the ground.
  P.add(new THREE.IcosahedronGeometry(h * 0.62, 0), MATS.stoneDark(),
    trs(0, h * 0.16, 0, rand.angle(), rand.angle(), rand.angle(), 1.25, 0.68, 1.15));
  P.add(new THREE.IcosahedronGeometry(h * 0.40, 0), MATS.stone(),
    trs(h * 0.34, h * 0.10, -h * 0.22, rand.angle(), rand.angle(), rand.angle(), 1.1, 0.7, 1.0));
  const veins = rand.int(3, 5);
  for (let i = 0; i < veins; i++) {
    const a = (i / veins) * TAU + rand.float(-0.35, 0.35);
    const len = h * rand.float(0.55, 1.0);
    const w = len * rand.float(0.20, 0.32);
    const d = coneDir(rand, rand.float(0.10, 0.40), a);
    const off = h * rand.float(0.05, 0.30);
    P.add(loft(SEC_HEX, 0, len, (t) => ({
      w: w * (t < 0.70 ? 1 - t * 0.22 : (1 - t) / 0.30 * 0.83),
      d: w * (t < 0.70 ? 1 - t * 0.22 : (1 - t) / 0.30 * 0.83),
      roll: 0.25,
    }), 3), MATS.crystal(hex),
    along(Math.cos(a) * off, h * 0.24, Math.sin(a) * off, d.x, d.y, d.z));
  }
  P.add(sphere(h * 0.09, 6), MATS.glow(hex, 1.6), trs(0, h * 0.44, 0));
  return { height: h + 0.2, radius: h * 0.9, glowColor: hex };
};

/* --- built props (instanced but inert) -------------------------------------- */

SCATTER.lantern = (P, rand) => {
  const h = 3.1;
  // Post, on a small stone footing so it does not look driven into bare turf.
  P.add(loft(SEC.oct, 0, 0.14, (t) => ({ w: lerp(0.20, 0.14, t), d: lerp(0.20, 0.14, t) }), 1),
    MATS.stoneDark());
  P.add(loft(SEC.oct, 0.08, h, (t) => ({ w: lerp(0.085, 0.055, t), d: lerp(0.085, 0.055, t) }), 3),
    MATS.woodDark());
  // Arm: a curve reaching out and dipping at the end, which is most of what makes a
  // street lantern read as one rather than as a signpost with a ball on it.
  const reach = 0.62;
  P.add(sweep(SEC.oct, (t) => {
    V.set(reach * t, h - 0.04 - t * t * 0.16, 0);
    return { p: V, w: lerp(0.055, 0.030, t), d: lerp(0.055, 0.030, t), ref: UP_REF };
  }, 6), MATS.woodDark());
  // Diagonal brace back to the post — the detail that makes it look built.
  P.add(bar(SEC.quad, 0, 0.50, 0.024, 0.024), MATS.woodDark(),
    along(0.02, h - 0.44, 0, 0.62, 0.44, 0));

  // Paper lantern. Big: at 0.19 m radius hanging off a 3 m post it read as a stray
  // orange marble, and the lit body has to be the thing the eye lands on.
  const lx = reach - 0.02, ly = h - 0.20 - 0.34;
  P.add(bar(SEC.quad, 0, -0.14, 0.009, 0.009), MATS.woodDark(), trs(lx, h - 0.20, 0));
  P.add(loft(SEC.oct, -0.30, 0.30, (t) => {
    // Barrel profile with flat ends, i.e. an actual paper lantern rather than an
    // ellipsoid: the hoops need somewhere parallel to sit.
    const w = 0.28 * (0.42 + 0.58 * Math.sin(Math.min(1, Math.max(0, t)) * Math.PI) ** 0.55);
    return { w, d: w };
  }, 8), MATS.paper(), trs(lx, ly, 0));
  for (const dy of [0.30, -0.30]) {
    P.add(ring(0.135, 0.020, 5, 12), MATS.woodDark(), trs(lx, ly + dy, 0, Math.PI / 2, 0, 0));
  }
  P.add(sphere(0.10, 8), MATS.glow(0xffb45e, 2.4), trs(lx, ly, 0));
  // Tassel: a cord and a knot below the bottom hoop.
  P.add(bar(SEC.quad, ly - 0.32, ly - 0.52, 0.014, 0.014), MATS.cloth(), trs(lx, 0, 0));
  P.add(spike(0.14, 0.05, 5), MATS.cloth(), trs(lx, ly - 0.66, 0));
  return { height: h + 0.06, radius: 0.75 };
};

/* --- ruins ------------------------------------------------------------------ */

/**
 * Stepped stone plinth, shared by every ruin kind. `at` optionally offsets the
 * whole stack, so a two-legged ruin can reuse it per leg.
 */
function plinth(P, mat, r, h, steps = 2, at = null) {
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const rr = r * (1 - t * 0.18);
    const m = trs(0, (h / steps) * i, 0);
    P.add(loft(SEC.rect, 0, h / steps, () => ({ w: rr, d: rr }), 1), mat,
      at ? at.clone().multiply(m) : m);
  }
}

SCATTER.pillar = (P, rand) => {
  const h = rand.float(3.4, 5.4);
  const r = 0.42;
  plinth(P, MATS.stonePale(), r * 1.7, 0.34);
  // Broken off at a slant: the shaft stops early and a wedge caps it, which is
  // what separates "ruin" from "unfinished column".
  const brk = rand.float(0.55, 0.85);
  const shaftTop = 0.34 + h * brk;
  P.add(loft(SEC_FLUTE, 0.34, shaftTop, (t) => {
    const rr = r * lerp(1.0, 0.90, t);
    return { w: rr, d: rr };
  }, 4), MATS.stonePale());
  // The fracture is a wedge that tapers to nothing on one side, tilted hard enough
  // to read as a break. A gently sloped cap of even thickness just looks like the
  // column has a lid on it.
  const tilt = rand.float(0.30, 0.55);
  P.add(loft(SEC_FLUTE, 0, r * 1.5, (t) => ({
    w: r * 0.90 * (1 - t * 0.96) + 0.004, d: r * 0.90 * (1 - t * 0.35),
  }), 3), MATS.stonePale(), trs(0, shaftTop - 0.05, 0, tilt, rand.angle(), 0));
  // Fallen drums beside it — the piece that snapped off, lying where it landed.
  for (let i = 0; i < rand.int(2, 3); i++) {
    const a = rand.angle(), d = rand.float(0.9, 1.9);
    P.add(loft(SEC_FLUTE, 0, rand.float(0.5, 0.9), () => ({ w: r * 0.88, d: r * 0.88 }), 1),
      MATS.stonePale(),
      trs(Math.cos(a) * d, r * 0.86, Math.sin(a) * d,
        Math.PI / 2 + rand.float(-0.2, 0.2), rand.angle(), rand.float(-0.3, 0.3)));
  }
  return { height: shaftTop + r * 1.2, radius: 2.2 };
};

SCATTER.ancientArch = (P, rand) => {
  const span = rand.float(3.0, 4.2);
  const h = rand.float(3.6, 4.8);
  const r = 0.34;
  const rise = span * 0.34;
  for (const s of [-1, 1]) {
    plinth(P, MATS.stone(), r * 1.9, 0.30, 2, trs(s * span * 0.5, 0, 0));
    // Columns wobble in and out along their length rather than being true cylinders;
    // a perfectly straight shaft reads as new masonry, not as something weathered.
    const ph = rand.float(0, TAU);
    P.add(loft(SEC.oct, 0.30, h, (t) => {
      const rr = r * (1 + Math.sin(t * 5.1 + ph) * 0.055 - t * 0.06);
      return { w: rr, d: rr };
    }, 6), MATS.stone(), trs(s * span * 0.5, 0, 0));
  }

  // The arch is a ruin, so most of the time the crown is missing: two stubs of the
  // lintel spring from the columns and stop, with the collapsed blocks lying below.
  // A pristine semicircle with a keystone in it looks maintained, which is the wrong
  // story for Dragonspine.
  const arcAt = (u) => {
    const a = Math.PI * u;
    V.set(-Math.cos(a) * span * 0.5, h + Math.sin(a) * rise, 0);
    // Lintel in the XY plane, so the default +Z roll reference is the right one.
    return { p: V, w: r * 0.9, d: r * 1.05 };
  };
  const arc = (u0, u1, steps) => P.add(
    sweep(SEC.rect, (t) => arcAt(u0 + (u1 - u0) * t), steps), MATS.stone());

  const broken = rand.float(0, 1) < 0.7;
  if (broken) {
    // Asymmetric gap: equal stubs either side look deliberate, like a gateway.
    const gapA = rand.float(0.26, 0.44);
    const gapB = rand.float(0.58, 0.80);
    arc(0, gapA, Math.max(2, Math.round(gapA * 12)));
    arc(gapB, 1, Math.max(2, Math.round((1 - gapB) * 12)));
    // Rubble from the missing span, scattered near the foot of the arch.
    for (let i = 0; i < rand.int(3, 5); i++) {
      const rr = r * rand.float(0.45, 0.95);
      P.add(blob(rr, rand.float(0.8, 1.4), rand.float(0.6, 1.0), rand.float(0.8, 1.3), 6),
        MATS.stone(),
        trs(rand.float(-1, 1) * span * 0.42, rr * 0.55, rand.float(-1, 1) * span * 0.30,
          rand.float(0, TAU), rand.angle(), rand.float(0, TAU)));
    }
  } else {
    arc(0, 1, 12);
    P.add(loft(SEC.rect, 0, 0.42, (t) => ({ w: r * (1.1 - t * 0.25), d: r * 1.2 }), 1),
      MATS.stone(), trs(0, h + rise - 0.06, 0));
  }
  return { height: h + rise + (broken ? 0.1 : 0.4), radius: span * 0.7 };
};

SCATTER.pagoda = (P, rand) => {
  const tiers = rand.int(2, 3);
  const base = 1.9;
  let y = 0;
  plinth(P, MATS.stonePale(), base * 1.15, 0.44, 2);
  y = 0.44;
  for (let i = 0; i < tiers; i++) {
    const w = base * (1 - i * 0.20);
    const bodyH = 1.5 - i * 0.18;
    // Four corner posts and a railing, then a flared roof over them.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        P.add(loft(SEC.oct, 0, bodyH, () => ({ w: 0.085, d: 0.085 }), 1), MATS.woodDark(),
          trs(sx * w * 0.82, y, sz * w * 0.82));
      }
    }
    P.add(loft(SEC.rect, 0, bodyH * 0.30, () => ({ w: w * 0.92, d: w * 0.92 }), 1),
      MATS.tileRed(), trs(0, y, 0));
    P.add(loft(SEC.rect, 0, bodyH * 0.62, () => ({ w: w * 0.66, d: w * 0.66 }), 1),
      MATS.stonePale(), trs(0, y + bodyH * 0.20, 0));
    // Roof: a square pyramid whose eaves overhang, drawn as two stacked lofts so
    // the brim can flare back out at the bottom the way a tiled roof does.
    P.add(loft(SEC.rect, 0, 0.16, (t) => ({ w: w * lerp(1.34, 1.16, t), d: w * lerp(1.34, 1.16, t) }), 1),
      MATS.tileRed(), trs(0, y + bodyH, 0));
    P.add(loft(SEC.rect, 0, 0.62, (t) => ({ w: w * lerp(1.16, 0.10, t), d: w * lerp(1.16, 0.10, t) }), 3),
      MATS.tile(), trs(0, y + bodyH + 0.16, 0));
    // Upturned corner eaves — the one detail that separates a pagoda from a shed
    // with a pointy lid. Swept out along the diagonal and hooked upward at the tip.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const ex = sx * w * 1.16, ez = sz * w * 1.16;
        P.add(sweep(SEC.quad, (t) => {
          V.set(ex * (1 + t * 0.30), y + bodyH + 0.10 + t * t * 0.34, ez * (1 + t * 0.30));
          return { p: V, w: 0.075 * (1 - t * 0.55) + 0.004, d: 0.055, ref: UP_REF };
        }, 5), MATS.tileRed());
      }
    }
    y += bodyH + 0.66;
  }
  P.add(loft(SEC.oct, 0, 0.5, (t) => ({ w: 0.08 * (1 - t * 0.7), d: 0.08 * (1 - t * 0.7) }), 2),
    MATS.gold(), trs(0, y, 0));
  P.add(sphere(0.11, 8), MATS.gold(), trs(0, y + 0.12, 0));
  return { height: y + 0.6, radius: base * 1.4 };
};

SCATTER.abyssPillar = (P, rand, o) => {
  const hex = o.color ?? 0xb46cff;
  const h = rand.float(4.0, 5.6);
  plinth(P, MATS.abyssStone(), 0.85, 0.36, 2);
  // Twisted obelisk: the roll term is what makes it feel abyssal rather than civic.
  P.add(loft(SEC_HEX, 0.36, h, (t) => ({
    w: lerp(0.44, 0.13, t), d: lerp(0.44, 0.13, t), roll: t * 1.9,
  }), 8), MATS.abyssStone());
  for (let i = 0; i < 4; i++) {
    const t = 0.22 + i * 0.19;
    P.add(ring(lerp(0.44, 0.16, t) * 1.12, 0.028, 4, 6), MATS.glow(hex, 1.7),
      trs(0, 0.36 + (h - 0.36) * t, 0, Math.PI / 2, t * 1.9, 0));
  }
  P.add(loft(SEC_HEX, 0, 0.55, (t) => ({
    w: 0.16 * (1 - t) + 0.01, d: 0.16 * (1 - t) + 0.01,
  }), 2), MATS.crystal(hex), trs(0, h + 0.22, 0));
  P.add(loft(SEC_HEX, 0, -0.30, (t) => ({
    w: 0.16 * (1 - t) + 0.01, d: 0.16 * (1 - t) + 0.01,
  }), 2), MATS.crystal(hex), trs(0, h + 0.22, 0));
  return { height: h + 0.8, radius: 0.9, glowColor: hex };
};

SCATTER.iceSpire = (P, rand, o) => {
  const hex = o.color ?? 0x8fe3f0;
  const h = rand.float(3.6, 5.6);
  P.add(new THREE.IcosahedronGeometry(0.9, 0), MATS.snow(),
    trs(0, 0.18, 0, 0, rand.angle(), 0, 1.4, 0.42, 1.4));
  for (let i = 0; i < 3; i++) {
    const len = h * (i === 0 ? 1 : rand.float(0.4, 0.7));
    const a = (i / 3) * TAU + rand.float(-0.4, 0.4);
    const off = i === 0 ? 0 : rand.float(0.35, 0.75);
    const d = coneDir(rand, i === 0 ? rand.float(0.02, 0.10) : rand.float(0.18, 0.36), a);
    P.add(loft(SEC_HEX, 0, len, (t) => ({
      w: lerp(0.34, 0.02, t * t), d: lerp(0.34, 0.02, t * t), roll: 0.3,
    }), 5), MATS.ice(), along(Math.cos(a) * off, 0.1, Math.sin(a) * off, d.x, d.y, d.z));
  }
  P.add(sphere(0.16, 8), MATS.glow(hex, 1.4), trs(0, h * 0.3, 0));
  return { height: h, radius: 1.1, glowColor: hex };
};

SCATTER.goldPillar = (P, rand) => {
  const h = rand.float(4.4, 5.4);
  plinth(P, MATS.goldDeep(), 0.72, 0.40, 2);
  P.add(loft(SEC_FLUTE, 0.40, h * 0.88, (t) => {
    const r = 0.36 * lerp(1.0, 0.88, t);
    return { w: r, d: r };
  }, 4), MATS.gold());
  // Capital: a flare, a torus and an abacus slab.
  P.add(loft(SEC.rect, 0, 0.30, (t) => ({ w: lerp(0.34, 0.52, t), d: lerp(0.34, 0.52, t) }), 2),
    MATS.gold(), trs(0, h * 0.88, 0));
  P.add(ring(0.42, 0.075, 6, 14), MATS.goldDeep(), trs(0, h * 0.88 + 0.30, 0, Math.PI / 2, 0, 0));
  P.add(loft(SEC.rect, 0, 0.22, () => ({ w: 0.56, d: 0.56 }), 1), MATS.gold(),
    trs(0, h * 0.88 + 0.36, 0));
  for (let i = 0; i < 3; i++) {
    P.add(ring(0.38, 0.030, 4, 12), MATS.goldDeep(),
      trs(0, 0.40 + (h * 0.88 - 0.40) * (0.2 + i * 0.3), 0, Math.PI / 2, 0, 0));
  }
  return { height: h * 0.88 + 0.6, radius: 0.8 };
};

/* --------------------------------------------------------- arena enclosure -- */
// A dungeon needs a wall the eye can read, and until now none of the three had one.
// `heightAt` ramps the height field 44 m up outside `terrain.arena.radius`, but from
// inside the arena that is an unlit mass sitting at the fog line, so all three halls
// photographed as an infinite plane with a haze at the edge — no vertical scale, no
// sense of being in a room. These recipes are *wall segments*, placed by
// `World._buildEnclosure` at exact angular intervals facing the arena centre.
//
// Shared local frame: +X is tangential (the span), +Z points at the arena centre,
// y = 0 is the floor. `o.span` is the arc between neighbours; the caller derives it
// from the count rather than choosing both, because a segment narrower than its
// spacing leaves forty vertical slots of nothing and a wider one drives its arch
// through the neighbour's pier.
//
// Each recipe puts its pier/column at x = -span/2 only. The neighbour supplies the
// other one, so an arch spans exactly one bay and the ring has no doubled piers.

SCATTER.abyssArch = (P, rand, o) => {
  const span = o.span ?? 8;
  const half = span / 2;
  const hex = o.color ?? 0xb46cff;
  const spring = 7.6;            // height the arch leaves the pier at
  const rise = 3.2;
  const crown = spring + rise;

  // Backing wall, leaning back as it rises: the top edge then catches the vault glow
  // while the face stays in shadow, which is what separates a wall from a backdrop.
  P.add(loft(SEC.rect, 0, crown * 0.62, (t) => ({
    w: half, d: 0.34, oz: -0.62 - t * 0.55,
  }), 2), MATS.abyssWall());
  // Upper storey, carried well above the arch crown. At 11 m and 50 m out the arcade
  // subtended 12° of frame — a horizon strip, not a room. Height is what says "indoors",
  // and a box costs 12 triangles.
  P.add(bar(SEC.rect, crown * 0.62 - 0.2, 17.5, half, 0.34), MATS.abyssWall(), trs(0, 0, -1.0));
  // Skirting. A wall meeting a floor along a single line reads as a cardboard flat.
  P.add(bar(SEC.rect, 0, 0.55, half, 0.95), MATS.abyssStone(), trs(0, 0, -0.38));

  // Pier, twisted the same way as the zone's free-standing obelisks so that the
  // architecture and the props look like they came from one culture.
  P.add(loft(SEC_HEX, 0, spring, (t) => ({
    w: lerp(0.80, 0.62, t), d: lerp(0.80, 0.62, t), roll: t * 0.55,
  }), 4), MATS.abyssStone(), trs(-half, 0, 0.12));
  P.add(loft(SEC_HEX, 0, 0.42, (t) => ({ w: 0.62 + t * 0.22, d: 0.62 + t * 0.22 }), 1),
    MATS.abyssStone(), trs(-half, spring, 0.12));

  // Pointed arch. The cusp comes from |2t-1|^1.7; a sine would give the Roman half
  // circle that belongs to the golden hall, not to the abyss.
  P.add(sweep(SEC.rect, (t) => {
    V.set(lerp(-half, half, t), spring + rise * (1.0 - Math.pow(Math.abs(2 * t - 1), 1.7)), 0.12);
    return { p: V, w: 0.44, d: 0.42 };
  }, 9), MATS.abyssStone());

  // The abyss lights its own architecture — no sun reaches in here, so the rune work is
  // the only thing giving the wall internal contrast, and at 50 m it is the *only* thing
  // that survives: the glowing course reads across the whole ring where the stone does not.
  P.add(ring(0.66, 0.075, 4, 12), MATS.glow(hex, 1.5), trs(0, spring + rise * 0.5, -0.22));
  P.add(ring(0.30, 0.05, 4, 10), MATS.glow(hex, 1.15), trs(0, spring + rise * 0.5, -0.18));
  P.add(bar(SEC.quad, spring - 0.12, spring + 0.05, half * 0.9, 0.10),
    MATS.glow(hex, 0.85), trs(0, 0, 0.26));
  // Vertical flute up the pier. A horizontal band alone gives the ring one continuous
  // line and no rhythm, so the count of bays — the thing that tells the eye how big the
  // room is — is invisible from the middle of the floor.
  P.add(bar(SEC.quad, 0.6, spring - 0.3, 0.09, 0.09), MATS.glow(hex, 0.7), trs(-half, 0, 0.52));

  // 上层 — the storey above the arch, which was 10.6 m of bare `abyssWall`.
  //
  // Every element above is tied to the arch, i.e. to 7-11 m, and the box carrying the wall to
  // 17.5 m had nothing on it at all: prop-check measured this module at rgb [35,45,141] with
  // p5..p95 = **48..51**, three counts of range across a 271 000 px silhouette. A wall this
  // dark cannot be broken up by its mottle (a multiplier of ±2 % on luma 50 is half a level)
  // and its faces are vertical under a sun 0.94 up, so the only two instruments left are a
  // *step* — which the cel ramp quantises into a real edge — and an albedo change. `abyssStone`
  // is the darker of the zone's two wall stones, so a proud course of it reads as a shadow line
  // without needing a light, and the glow course continues the rune vocabulary the lower storey
  // already speaks in.
  const upFace = -1.0 + 0.34;                       // the upper storey's front plane
  const band = (y0, y1, w, d, proud, mat) => P.add(bar(SEC.rect, y0, y1, w, d), mat,
    trs(0, 0, upFace + proud - d));
  band(10.30, 10.70, half - 0.04, 0.30, 0.14, MATS.abyssStone());
  band(10.70, 11.25, half, 0.40, 0.30, MATS.abyssWall());
  P.add(bar(SEC.quad, 10.12, 10.28, half * 0.92, 0.09), MATS.glow(hex, 0.6),
    trs(0, 0, upFace + 0.30));
  band(16.55, 17.25, half, 0.42, 0.26, MATS.abyssStone());
  // Pilasters carrying the pier rhythm up past the arch, so the bay count stays legible from
  // the floor instead of stopping at the springing line.
  for (const s of [-0.52, 0.52]) {
    P.add(bar(SEC.rect, spring - 0.4, 16.4, 0.30, 0.34), MATS.abyssStone(),
      trs(half * s, 0, upFace + 0.20 - 0.34));
  }
  // One rune boss per bay in the upper storey. At the far side of the arena the stone is fog and
  // this is the only thing left of the wall, which is the same reason the lower course glows.
  P.add(ring(0.52, 0.065, 4, 12), MATS.glow(hex, 1.1), trs(0, 13.6, upFace + 0.26));
  P.add(sphere(0.17, 8), MATS.abyssStone(), trs(0, 13.6, upFace + 0.20));
  return { height: 17.5, radius: half + 0.9, glowColor: hex };
};

SCATTER.iceCurtain = (P, rand, o) => {
  const span = o.span ?? 7;
  const half = span / 2;
  const hex = o.color ?? 0x8fe3f0;
  // The rock, authored by the zone (`props.enclosure.wallColor`). See `MATS.caveWall` for the
  // measurement that took this off `stoneDark`; the default is a shade lighter than
  // frostCavern's own ceiling rock, because a wall is what the player stands next to and the
  // ceiling is 25 m away through fog.
  const rockHex = o.wallColor ?? 0x7b8b9e;
  const rock = MATS.caveWall(rockHex);

  // Continuous backing first, then the broken face in front of it. The backing exists
  // purely so that no gap between two stepped panels can ever show the terrain ramp
  // through the wall — which is the one failure mode that turns a cave back into a plain.
  P.add(bar(SEC.rect, 0, 17.0, half, 0.45), MATS.stoneDark(), trs(0, 0, -1.9));

  // Three vertical rock panels at staggered heights and depths, together spanning the
  // whole bay. A single flat slab is what a cave wall is not: the eye reads a cave from
  // the vertical break-up, and stepping the panels also gives the stalactites below
  // something to hang from at three different heights.
  const nP = 3;
  const pw = half / nP;                 // half-width of one panel
  const tops = [];
  for (let i = 0; i < nP; i++) {
    const cx = -half + pw * (2 * i + 1);
    const top = rand.float(12.5, 16.5);
    const dz = rand.float(-1.5, -0.6);
    tops.push([cx, top, dz]);
    // Wider than its share of the bay, so neighbours overlap. At exactly `pw` the three
    // panels meet along a line and their different `dz` opens a slot straight through to the
    // backing 1.3 m behind — which photographs as a black stripe, and a wall with black
    // stripes in it reads as a picket fence rather than as rock.
    P.add(loft(SEC.rect, 0, top, (t) => ({
      w: pw * lerp(1.12, 0.96, t), d: 0.62, oz: dz - t * 0.5,
    }), 3), rock);
  }

  // 中段：冰檐、霜带与裂脊 — the storey the player actually looks at.
  //
  // Everything else in this recipe decorates the *ends* of the wall: the snow bank and the
  // stalagmites are under 5 m, the snow caps and the stalactites hang off the tops at 12-16 m.
  // A third-person camera at 20 m aims at 8.5 m, i.e. squarely between them, and prop-check
  // measured that band as a flat wash (std 4.2 over a 240 000 px silhouette). Relief and albedo
  // are the only two things that can break a cel-shaded vertical face — the toon shell draws no
  // outline *inside* a silhouette and the sun is overhead — so each panel gets one horizontal
  // (a shelf with a snow cap and a darker course under it, which is where the value step comes
  // from) and two verticals (ice fracture ribs, which are the brightest material in the room).
  for (const [cx, top, dz] of tops) {
    // The panel's front plane at height y, rather than a constant: the loft leans back by
    // 0.5 m over its full height, so decoration placed off a fixed z is buried at the bottom
    // and floating at the top, and nothing in the picture says which.
    const faceZ = (y) => dz - (Math.min(1, y / top)) * 0.5 + 0.62;
    const shelfY = 7.4 + (cx / half) * 0.6;          // stepped between panels, never one line
    const front = (y, d, proud) => faceZ(y) + proud - d;
    P.add(bar(SEC.rect, shelfY - 0.30, shelfY, pw * 0.90, 0.34),
      MATS.stoneDark(), trs(cx, 0, front(shelfY, 0.34, 0.10)));
    P.add(loft(SEC.rect, shelfY, shelfY + 0.55, (t) => ({
      w: pw * (0.94 - t * 0.22), d: 0.44 - t * 0.20,
    }), 2), rock, trs(cx, 0, front(shelfY, 0.44, 0.30)));
    P.add(loft(SEC.rect, shelfY + 0.55, shelfY + 0.78, (t) => ({
      w: pw * (0.80 - t * 0.18), d: 0.34 - t * 0.16,
    }), 2), MATS.snow(), trs(cx, 0, front(shelfY, 0.34, 0.26)));
    // Ribs: veins in the rock, not cladding over it. `MATS.ice()` is the brightest material in
    // the room (p95 202 against rock at 26), so a rib wide enough to see from the far wall is
    // already wide enough to become the surface — the first pass at 0.40 m across a 2.3 m panel
    // turned the bay into pale stripes. Asymmetric offsets for the same reason the shelf is
    // stepped: two ribs at ±0.52 pw on every panel is a pattern, and a pattern reads as tiling.
    for (const s of [-1, 1]) {
      const rx = cx + s * pw * rand.float(0.34, 0.62);
      const y0 = 1.6 + rand.float(0, 1.2);
      const y1 = shelfY - 0.5 + rand.float(0, 0.4);
      P.add(loft(SEC.lens, y0, y1, (t) => ({
        w: 0.13 * (1 - t * 0.35), d: 0.22 - t * 0.09,
      }), 3), MATS.ice(), trs(rx, 0, front((y0 + y1) / 2, 0.22, 0.13)));
      P.add(loft(SEC.lens, shelfY + 0.9, shelfY + 0.9 + rand.float(2.2, 3.6), (t) => ({
        w: 0.11 * (1 - t * 0.5), d: 0.19 - t * 0.10,
      }), 3), MATS.ice(), trs(rx, 0, front(shelfY + 2, 0.19, 0.12)));
    }
  }
  // Snow bank at the foot, wider than the wall so the join is buried. A wall meeting a
  // floor along one straight line reads as a flat, whatever is above it.
  P.add(loft(SEC.rect, 0, 1.05, (t) => ({ w: half * (1.0 - t * 0.2), d: 1.7 - t * 1.15 }), 2),
    MATS.snow(), trs(0, 0, -0.2));
  // Snow along the panel tops, catching the shaft light the vertical faces cannot.
  for (const [cx, top, dz] of tops) {
    P.add(loft(SEC.rect, top - 0.5, top + 0.35, (t) => ({ w: pw * (0.94 - t * 0.25), d: 0.72 - t * 0.3 }), 2),
      MATS.snow(), trs(cx, 0, dz));
  }

  // Stalactites hang from a panel edge, never from thin air. The first build put them at
  // a fixed y = 12.2 with nothing above, so a ring of them read as a picket fence
  // floating at head height rather than as a ceiling coming down.
  for (const [cx, top, dz] of tops) {
    // Every random value is drawn out here, never inside a profile callback: `sweep`
    // calls the callback three times per step for its central-difference tangent, so a
    // `rand` inside it would hand a different radius to each probe and tear the surface.
    const drop = rand.float(3.4, 7.0);
    const w1 = rand.float(0.34, 0.62);
    const ox = rand.float(-pw * 0.4, pw * 0.4);
    P.add(loft(SEC_HEX, top - 0.4, top - 0.4 - drop, (t) => ({
      w: lerp(w1, 0.03, t * t), d: lerp(w1, 0.03, t * t), roll: 0.2,
    }), 4), MATS.ice(), trs(cx + ox, 0, dz + 0.55));
  }
  // Two stalagmites, at x offsets related to the stalactites above so a pair nearly
  // meets. That near-miss is what makes a cave read as one space rather than as a floor
  // with spikes and a ceiling with spikes.
  for (let i = 0; i < 2; i++) {
    const [cx, , dz] = tops[i * 2];
    const up = rand.float(2.6, 5.6);
    const w0 = rand.float(0.40, 0.72);
    const ox = rand.float(-pw * 0.5, pw * 0.5);
    P.add(loft(SEC_HEX, 0, up, (t) => ({
      w: lerp(w0, 0.04, t * t), d: lerp(w0, 0.04, t * t), roll: 0.35,
    }), 4), MATS.ice(), trs(cx + ox, 0, dz + 1.15));
  }
  // One frozen fall against the rock: a flattened ice lens, which is the only element
  // here that is wider than it is tall and so the only one that breaks the vertical grain.
  P.add(loft(SEC.lens, 1.0, 6.4, (t) => ({ w: pw * (0.8 - t * 0.35), d: 0.5 - t * 0.2 }), 3),
    MATS.ice(), trs(tops[1][0], 0, tops[1][2] + 0.5));
  P.add(sphere(0.22, 8), MATS.glow(hex, 1.2), trs(tops[1][0], 3.4, tops[1][2] + 0.85));
  return { height: 17.0, radius: half + 1.4, glowColor: hex };
};

SCATTER.goldArcade = (P, rand, o) => {
  const span = o.span ?? 8.6;
  const half = span / 2;
  const colH = 7.4;
  // The lower storey's colour, authored per zone (`props.enclosure.wallColor`). It is the
  // only large non-gold surface in the room, so it is the frame's value anchor and the one
  // thing a zone must be able to choose. The default is a plain darker stone: an arcade
  // that authors nothing still gets a two-tone wall rather than 16 m of one pale slab.
  const wallHex = o.wallColor ?? 0x9a8f7a;

  // Ashlar backing wall with a string course, so the hall has a surface behind its
  // columns instead of fog.
  P.add(bar(SEC.rect, 0, 16.2, half, 0.42), MATS.stonePale(), trs(0, 0, -0.85));
  // Dado: the ashlar's lower 4.6 m faced in lacquer, standing 0.2 m proud of it. One band
  // does three things. It halves the luminance of the surface the player is actually
  // standing in front of — `stonePale` is 0.71 luma and under this zone's gold sun the
  // wall photographed as bright as the sunlit floor. Its top edge is a real step, so the
  // shader draws a terminator across the wall, which an outline pass cannot: the toon
  // shell only draws on a silhouette. And its plinth and fillet are shades of the same
  // hue, so the storey reads as one material worked three ways.
  // 2 cm narrower and 7 cm shallower than the slab behind it, which is not a detail: at
  // exactly `half` the two boxes' side faces and back faces are *coplanar*, and a close
  // shot of the first build came back stippled with z-fight along every one of them. The
  // 4 cm it leaves between neighbouring modules reads as the joint between two panels.
  P.add(bar(SEC.rect, 0, 4.60, half - 0.02, 0.485), MATS.lacquer(wallHex), trs(0, 0, -0.715));
  P.add(bar(SEC.rect, 0, 0.62, half, 1.10), MATS.lacquer(shade(wallHex, 0.55)), trs(0, 0, -0.45));

  // 嵌板与描金团花 — the dado's panelling.
  //
  // The band above was a plain 4.6 m slab of one colour across the whole ring, and it is
  // the surface the player stands in front of for the entire dungeon. Lighting cannot
  // break it up: the wall faces the arena centre while this zone's sun is 0.92 up, so the
  // whole face sits in one cel band, and the toon shell only draws on a silhouette, so
  // there is no outline inside it either. That leaves relief and albedo, which is what
  // panelling is: raised 框 standing 7 cm proud with the slab's own face left as the
  // recessed 堂心 between them, a gilt line inside each, and a gilt 团花 on the middle.
  //
  // `faceZ` rather than a constant: every one of these sits on the lacquer slab's front
  // plane, and that plane is `trs(...).z + d` of the bar above. Writing -0.23 here works
  // exactly until someone moves the dado 3 cm, and then the decoration is either buried or
  // floating and nothing says which.
  const faceZ = -0.715 + 0.485;
  const frameHex = lerpHex(wallHex, 0xffffff, 0.17);
  const np = Math.max(2, Math.round(span / 4.3));
  const marg = 0.55;                       // clear of the module joint and the column
  const pitch = (span - marg * 2) / np;
  const pw = pitch / 2 - 0.30;             // panel half-width; the 0.30 is the gap between
  const st = 0.10;                         // stile/rail half-thickness
  const py0 = 0.95, py1 = 3.95;            // above the plinth, below the fillet
  for (let i = 0; i < np; i++) {
    const cx = -half + marg + pitch * (i + 0.5);
    // Frame. Back face 1 cm *inside* the slab, because coplanar faces on this recipe have
    // already cost one round of z-fight stipple (see the note on the slab above).
    P.add(bar(SEC.rect, py0, py1, st, 0.04), MATS.lacquer(frameHex), trs(cx - pw, 0, faceZ + 0.03));
    P.add(bar(SEC.rect, py0, py1, st, 0.04), MATS.lacquer(frameHex), trs(cx + pw, 0, faceZ + 0.03));
    P.add(bar(SEC.rect, py0, py0 + st * 2, pw + st, 0.04), MATS.lacquer(frameHex), trs(cx, 0, faceZ + 0.03));
    P.add(bar(SEC.rect, py1 - st * 2, py1, pw + st, 0.04), MATS.lacquer(frameHex), trs(cx, 0, faceZ + 0.03));
    // The gilt line inside the frame: less proud than the frame, so the two do not read as
    // one thick moulding, and gold rather than a third lacquer shade because the room's
    // vocabulary for "a drawn line" is already gold everywhere else on this wall.
    const gx = pw - st - 0.08, gy0 = py0 + st * 2 + 0.10, gy1 = py1 - st * 2 - 0.10;
    P.add(bar(SEC.rect, gy0, gy1, 0.032, 0.022), MATS.gold(), trs(cx - gx, 0, faceZ + 0.015));
    P.add(bar(SEC.rect, gy0, gy1, 0.032, 0.022), MATS.gold(), trs(cx + gx, 0, faceZ + 0.015));
    P.add(bar(SEC.rect, gy0, gy0 + 0.064, gx, 0.022), MATS.gold(), trs(cx, 0, faceZ + 0.015));
    P.add(bar(SEC.rect, gy1 - 0.064, gy1, gx, 0.022), MATS.gold(), trs(cx, 0, faceZ + 0.015));
    // 团花: a ring, eight petals filling it, and a boss. A torus already lies in the XY
    // plane, which is the wall's plane here, so it needs no rotation — the same reason the
    // rosette over the bay below does not have one, while the collar around the column does.
    const my = (py0 + py1) / 2;
    P.add(ring(0.40, 0.038, 4, 14), MATS.goldDeep(), trs(cx, my, faceZ + 0.05));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      P.add(spike(0.20, 0.075, 4, true), MATS.gold(),
        along(cx + Math.cos(a) * 0.19, my + Math.sin(a) * 0.19, faceZ + 0.05,
          Math.cos(a), Math.sin(a), 0));
    }
    P.add(sphere(0.105, 8), MATS.gold(), trs(cx, my, faceZ + 0.075));
  }
  // 回纹: a key fret under the fillet, two heights alternating. At 60 m across the hall this
  // is a dotted gold line and at 3 m it is a moulding, which is the whole point of putting
  // detail at two scales on the same course.
  const nf = Math.max(6, Math.round(span / 0.62));
  for (let i = 0; i < nf; i++) {
    const x = lerp(-half + 0.34, half - 0.34, i / (nf - 1));
    const tall = i % 2 === 0;
    P.add(bar(SEC.rect, tall ? 4.02 : 4.10, tall ? 4.26 : 4.18, 0.072, 0.026),
      MATS.goldDeep(), trs(x, 0, faceZ + 0.018));
  }
  // The fillet under the gold course, overhung by 0.11 m. Nothing in the lighting will
  // produce that line: the wall faces the arena centre and the dungeon sun is 0.92 up, so
  // the entire surface sits in the cel ramp's shadow band and every course on it comes out
  // the same value. A dark inset is the only way a cel-shaded wall gets a horizontal.
  P.add(bar(SEC.rect, 4.34, 4.62, half - 0.06, 0.54), MATS.lacquer(shade(wallHex, 0.34)), trs(0, 0, -0.65));
  P.add(bar(SEC.rect, 4.6, 4.98, half, 0.60), MATS.goldDeep(), trs(0, 0, -0.55));
  // Upper storey above the entablature: at 10.6 m the wall stopped level with the
  // cornice, so from the floor the hall had a ceiling of fog. A clerestory band and a
  // second course carry the eye up, for 24 triangles.
  P.add(bar(SEC.rect, 12.6, 13.0, half, 0.58), MATS.goldDeep(), trs(0, 0, -0.6));
  P.add(bar(SEC.quad, 13.4, 15.3, half * 0.30, 0.30), MATS.gold(), trs(0, 0, -0.55));

  // 中层 — the 5-to-12.6 m band, which had the dado's whole vocabulary below it, the
  // clerestory above it, and nothing on it.
  //
  // That is the band a third-person camera aims at from anywhere in the room: prop-check
  // photographed one module at 20 m and got p5..p95 = **163..166** over 300 000 px, i.e. a sheet
  // of sand-coloured paper with a seam down it. `stonePale` is 0.71 luma under a 0xffdca0 sun, so
  // the surface is also *bright*, and a bright flat is worse than a dark one. Two pilasters give
  // the bay its vertical division, a gold course over a dark fillet gives the one horizontal that
  // cel shading cannot produce by itself, and the field between them is lacquer — the same
  // half-luma albedo that fixed the dado, so the storey reads as panelled rather than plastered.
  const midFace = -0.85 + 0.42;                    // the ashlar's front plane
  const mid = (y0, y1, w, d, proud, mat) => P.add(bar(SEC.rect, y0, y1, w, d), mat,
    trs(0, 0, midFace + proud - d));
  mid(8.20, 8.55, half - 0.05, 0.34, 0.10, MATS.lacquer(shade(wallHex, 0.34)));
  mid(8.55, 9.00, half, 0.44, 0.26, MATS.goldDeep());
  mid(5.05, 5.45, half, 0.40, 0.22, MATS.stonePale());
  for (const s of [-0.62, 0.62]) {
    P.add(bar(SEC.rect, 5.45, 12.5, 0.34, 0.40), MATS.stonePale(),
      trs(half * s, 0, midFace + 0.20 - 0.40));
  }
  // Two lacquer fields, one per storey half, each with a gilt line and a 团花 — the dado's
  // pattern at the larger scale the storey wants, and cheap: the frames are the pilasters and
  // the courses that are already there.
  for (const [fy0, fy1] of [[5.7, 8.0], [9.3, 12.2]]) {
    P.add(bar(SEC.rect, fy0, fy1, half * 0.50, 0.42), MATS.lacquer(wallHex),
      trs(0, 0, midFace + 0.12 - 0.42));
    const fmy = (fy0 + fy1) / 2;
    for (const s of [-1, 1]) {
      P.add(bar(SEC.rect, fy0 + 0.22, fy1 - 0.22, 0.035, 0.024), MATS.gold(),
        trs(half * 0.50 * s * 0.82, 0, midFace + 0.14));
    }
    P.add(ring(0.46, 0.045, 4, 14), MATS.goldDeep(), trs(0, fmy, midFace + 0.16));
    P.add(sphere(0.12, 8), MATS.gold(), trs(0, fmy, midFace + 0.19));
  }

  // Engaged column: plinth, fluted shaft, and the same capital the free-standing
  // `goldPillar` uses, because they are meant to be the same order of architecture.
  plinth(P, MATS.goldDeep(), 0.95, 0.45, 2, trs(-half, 0, 0.18));
  P.add(loft(SEC_FLUTE, 0.45, colH, (t) => {
    const r = 0.46 * lerp(1.0, 0.88, t);
    return { w: r, d: r };
  }, 4), MATS.gold(), trs(-half, 0, 0.18));
  P.add(loft(SEC.rect, 0, 0.34, (t) => ({ w: lerp(0.44, 0.68, t), d: lerp(0.44, 0.68, t) }), 2),
    MATS.gold(), trs(-half, colH, 0.18));
  P.add(ring(0.56, 0.09, 6, 14), MATS.goldDeep(),
    trs(-half, colH + 0.36, 0.18, Math.PI / 2, 0, 0));

  // Entablature and dentils. The repeated small block under a cornice is the detail
  // that makes a colonnade read as built rather than extruded, and it is the cheapest
  // geometry in the recipe.
  P.add(bar(SEC.rect, colH + 0.52, colH + 1.30, half, 0.72), MATS.stonePale(), trs(0, 0, 0.05));
  const nd = Math.max(4, Math.round(span / 0.95));
  for (let i = 0; i < nd; i++) {
    const x = lerp(-half + 0.4, half - 0.4, i / (nd - 1));
    P.add(bar(SEC.rect, colH + 0.30, colH + 0.52, 0.17, 0.22), MATS.goldDeep(), trs(x, 0, 0.40));
  }
  // Rosette over the bay, low enough to be inside the fog-free near field.
  P.add(ring(0.52, 0.085, 5, 12), MATS.gold(), trs(0, colH + 2.0, -0.34));
  P.add(sphere(0.21, 8), MATS.goldDeep(), trs(0, colH + 2.0, -0.30));
  return { height: 16.2, radius: half + 1.0 };
};

/* ------------------------------------------------------------- ceilings -- */

/**
 * The lid of a dungeon, as geometry.
 *
 * `VAULT_FRAG` in gfx/sky.js paints a rock vault on the sky dome, and every claim in
 * its comment is true of the shader and false of the screen: `tools/vault-cam.mjs`
 * pitched the *gameplay* camera to its own MIN_PITCH in all three dungeons and found a
 * flat wash overhead (std 1.0 in 深渊试炼场, 2.3 in 黄金屋, 3.3 in 冰封洞窟). Tinting
 * `uVaultCol` magenta moved those pixels by **0** counts, and hiding `terrain.group`
 * moved 黄金屋's top band from [86,57,37] to [37,32,31]: what fills the top of frame is
 * the height field, which `heightAt` ramps 44 m up outside the arena and fog then
 * flattens. A shader behind an occluder cannot be fixed by rewriting the shader — the
 * previous full rewrite of this one produced byte-identical measurements.
 *
 * So the room gets a real ceiling: a faceted shell of revolution from the top of the
 * wall ring up to an apex over the middle of the floor, with ribs hanging under it,
 * pendants coming down off it and a boss at the crown.
 *
 * Why it seals. The shell's rim sits *outside* the wall ring (`radius` > the wall's) and
 * *below* the wall's top, so the two surfaces intersect and the wall's upper storey
 * pierces the shell. Any ray leaving the arena centre either passes under the rim — and
 * then hits the wall, which is 16-20 m of solid module — or crosses the shell somewhere
 * inside it, because the shell's height falls monotonically outward while the ray's
 * rises. There is no elevation left over for the ramp to show through.
 *
 * Why it is lit by albedo. The dungeon "sun" is near-vertical (sunDir y 0.90-0.94) and
 * every face of a ceiling points *down*, so the direct term is zero over the whole
 * shell — the same trap `MATS.abyssWall` was widened for. Form here comes from three
 * things that do not need a light: per-facet vertex tone (hard-edged, so the cel ramp
 * has slabs to quantise), a radial gradient that is dark at the crown and bright at the
 * springing, and real relief — ribs and pendants whose silhouettes read against it.
 * gfx/sky.js also turns its fill light upward indoors, which is the brazier bounce.
 */
export function buildVaultCeiling(o = {}) {
  const radius = o.radius ?? 50;
  const rimY = o.rimY ?? 15;
  const rise = Math.max(2, o.rise ?? 9);
  const apexY = rimY + rise;
  const rand = new Rand(o.seed ?? 0x5ec1);
  const AN = o.segments ?? 72;          // facets around
  const RN = o.rings ?? 9;              // courses out from the crown
  const style = o.style ?? 'cave';
  const crownShade = o.crownShade ?? 0.62;
  const P = new Parts();
  const shadowHex = o.shadowColor ?? 0x6a7488;
  const rock = MATS.vault(o.rockColor ?? 0x8b8577, shadowHex);
  const trim = MATS.vaultTrim(o.trimColor ?? 0x6b675e, shadowHex);
  const glowHex = o.glowColor ?? 0xffc98a;

  // Saucer profile, not a cone: flat over the middle of the floor where the player
  // fights and steep where it lands on the wall, so the ceiling line is a curve.
  const domeY = (r) => apexY - rise * Math.pow(Math.min(1, r / radius), 1.7);
  // Low-frequency lobes, so the shell is quarried rock and not a lathe part. Drawn out
  // here and never inside a profile callback: `sweep` probes its callback three times
  // per step for the central-difference tangent, and a `rand` in there tears the surface.
  const lobes = [];
  for (let k = 0; k < 5; k++) {
    lobes.push({
      fx: rand.float(0.045, 0.135), fz: rand.float(0.045, 0.135),
      px: rand.angle(), pz: rand.angle(), a: rand.float(0.5, 1.5) * (o.bump ?? 1),
    });
  }
  const surfaceY = (a, r) => {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    // Faded to nothing at the rim. The seam with the wall has to stay a clean circle:
    // one lobe dipping across it opens a slot straight onto the terrain ramp behind.
    const fade = 1 - Math.pow(Math.min(1, r / radius), 3);
    let s = 0;
    for (const l of lobes) s += l.a * Math.sin(x * l.fx + l.px) * Math.cos(z * l.fz + l.pz);
    return domeY(r) + s * fade;
  };

  // --- shell ---------------------------------------------------------------
  // Built by hand rather than with `loft`, because a surface of revolution wants its
  // tone per *facet*: three vertices of one triangle share a value, the neighbour gets
  // another, and the cel ramp then has slabs instead of a smooth field. Courses are
  // spread with pow 0.82 so they crowd toward the rim, which is where perspective
  // compresses them most.
  const ringR = [];
  for (let j = 0; j <= RN; j++) ringR.push(radius * Math.pow(j / RN, 0.82));
  const quads = AN * RN;
  const pos = new Float32Array(quads * 18);
  const col = new Float32Array(quads * 18);
  let k = 0;
  for (let j = 0; j < RN; j++) {
    const r0 = ringR[j], r1 = ringR[j + 1];
    const mid = (r0 + r1) / 2 / radius;
    for (let i = 0; i < AN; i++) {
      const a0 = (i / AN) * TAU, a1 = ((i + 1) / AN) * TAU;
      const A = [Math.cos(a0) * r0, surfaceY(a0, r0), Math.sin(a0) * r0];
      const B = [Math.cos(a0) * r1, surfaceY(a0, r1), Math.sin(a0) * r1];
      const C = [Math.cos(a1) * r0, surfaceY(a1, r0), Math.sin(a1) * r0];
      const D = [Math.cos(a1) * r1, surfaceY(a1, r1), Math.sin(a1) * r1];
      // Dark at the crown, bright where it springs off the wall: a dungeon is dark above
      // and lit below, and this is the term that carries it, since no light reaches a
      // downward face. `crownShade` is per zone because the thing the crown has to be
      // distinguishable from is the zone's *fog*, and the three fogs are nowhere near
      // each other — 深渊's is luma 21.6, 冰封洞窟's is 137.2. A ceiling that lands on its
      // own fog colour is the exact defect this geometry exists to fix, so the value is
      // tuned per zone against a measurement, not shared for tidiness.
      let tone = lerp(crownShade, 1.18, mid);
      // Two scales of slab tone, because one facet-sized scale is invisible at 30 m:
      // 3x2 blocks of facets carry the patchwork the eye reads from the floor, the
      // per-facet term keeps the blocks from looking like tiles.
      //
      // The amplitudes are wide because two *uniform* terms are much flatter than their
      // range suggests — std is (hi-lo)/sqrt(12), so the first cut of this, 0.84 + 0.20 +
      // 0.18, looked like a ±19 % swing and measured 7 %: 黄金屋's crown came out std 3.8
      // against a flat-wash threshold of 4. Fog then dilutes what is left by another
      // fifth. Read these as ±11 %, not ±27 %.
      tone *= 0.72 + 0.28 * jhash(i * 3.17, j * 7.71, 1)
        + 0.26 * jhash(Math.floor(i / 3) * 11.3, Math.floor(j / 2) * 5.9, 2);
      tone *= j % 2 ? 0.90 : 1.0;                            // bedding courses
      for (const v of [A, B, C, B, D, C]) {
        pos[k] = v[0]; pos[k + 1] = v[1]; pos[k + 2] = v[2];
        col[k] = tone; col[k + 1] = tone; col[k + 2] = tone;
        k += 3;
      }
    }
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  shell.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // Winding is (A,B,C) with B one course further out and C one facet round, which puts
  // the face normal at -Y — the ceiling is seen from below and nowhere else, so a
  // single-sided shell is right and a flipped one would be invisible.
  shell.computeVertexNormals();
  P.add(shell, rock);

  // --- ribs ----------------------------------------------------------------
  // Hung *under* the shell (-0.34, half-depth 0.5) so each one is a plane change and a
  // silhouette, not a texture. They stop short of the crown and hand off to the boss.
  const ribs = o.ribs ?? 12;
  for (let i = 0; i < ribs; i++) {
    const a = (i / ribs) * TAU;
    const wob = style === 'cave' ? rand.float(-0.06, 0.06) : 0;
    const path = (t, dy) => {
      const r = lerp(radius * 0.99, radius * 0.07, t);
      const aa = a + wob * Math.sin(t * Math.PI);
      V.set(Math.cos(aa) * r, surfaceY(aa, r) - dy, Math.sin(aa) * r);
      return V;
    };
    // `ref: UP_REF` is not decoration: for a near-horizontal radial spine the default
    // +Z reference makes `w` the *vertical* extent at azimuth 0 and the horizontal one
    // at 90°, so a rib tuned as 0.6 wide × 0.5 deep would come out on its side across
    // half the ring (see the frame note above `sweep` in gfx/solid.js).
    P.add(sweep(SEC.rect, (t) => ({
      p: path(t, 0.34), w: lerp(0.62, 0.34, t), d: lerp(0.52, 0.34, t), ref: UP_REF,
    }), 14), trim);
    if (style === 'rune') {
      // A glowing vein under each rib. The abyss lights its own architecture, and
      // these converge on the crown, which is the one place a player looking up is
      // guaranteed to be looking at.
      P.add(sweep(SEC.quad, (t) => ({
        p: path(t, 0.92), w: 0.13, d: 0.13, ref: UP_REF,
      }), 14), MATS.glow(glowHex, 1.15));
    }
  }

  // --- hoops ---------------------------------------------------------------
  // Parallels to go with the ribs' meridians, which is what a vault actually has — and
  // the one piece of relief guaranteed to cross the *top* of a frame. A player looking up
  // sees 14 ribs converge at a point, so from the middle of the floor a rib is a thin
  // radial line near the vanishing point and a 370 px band may contain one; a hoop is a
  // band right across it, so the ceiling has a legible scale wherever you stand.
  for (const rf of o.hoops ?? [0.62, 0.34]) {
    const r = radius * rf;
    P.add(sweep(SEC.rect, (t) => {
      const th = t * TAU;
      V.set(Math.cos(th) * r, surfaceY(th, r) - 0.30, Math.sin(th) * r);
      // w is radial and d vertical here, for the same reason as the ribs.
      return { p: V, w: 0.52, d: 0.42, ref: UP_REF };
    }, AN), trim);
  }

  // --- pendants ------------------------------------------------------------
  // Stalactites in a cave, bosses in a hall: the same cone, hung off the shell at its
  // own surface height. Fixed heights are what made the first ring of ice spikes read
  // as a floating picket fence, so every one of these starts 0.2 m *inside* the shell.
  const pendants = o.pendants ?? 16;
  const pendantMat = style === 'cave' ? MATS.ice() : trim;
  for (let i = 0; i < pendants; i++) {
    const a = rand.angle();
    const r = radius * Math.sqrt(rand.float(0.02, 0.78));   // sqrt: even over the area
    const y0 = surfaceY(a, r) + 0.2;
    const drop = rand.float(2.2, 6.4) * (o.pendantScale ?? 1);
    const w0 = rand.float(0.34, 0.78);
    const roll = rand.angle();
    P.add(loft(SEC_HEX, y0, y0 - drop, (t) => ({
      w: lerp(w0, 0.04, t * t), d: lerp(w0, 0.04, t * t), roll,
    }), 4), pendantMat, trs(Math.cos(a) * r, 0, Math.sin(a) * r));
  }

  // --- crown ---------------------------------------------------------------
  // Where the ribs meet. Without it they converge into a pile of interpenetrating
  // boxes at the apex, which is the first thing the eye lands on when you look up.
  const cy = surfaceY(0, 0);
  P.add(loft(SEC_HEX, cy + 0.3, cy - 1.5, (t) => ({ w: 2.0 - t * 0.9, d: 2.0 - t * 0.9 }), 2), trim);
  P.add(ring(2.3, 0.30, 5, 16), trim, trs(0, cy - 0.5, 0, Math.PI / 2, 0, 0));
  P.add(sphere(0.9, 10), MATS.glow(glowHex, 1.3), trs(0, cy - 2.1, 0));

  if (style === 'coffer') {
    // One rosette per bay, on the shell between the ribs: a hall's ceiling is coffered,
    // and this is the detail that says the room was built rather than dug.
    for (let i = 0; i < ribs; i++) {
      const a = ((i + 0.5) / ribs) * TAU;
      const r = radius * 0.52;
      const y = surfaceY(a, r);
      P.add(ring(1.15, 0.16, 5, 14), trim,
        trs(Math.cos(a) * r, y - 0.25, Math.sin(a) * r, Math.PI / 2, 0, 0));
      P.add(sphere(0.42, 9), MATS.glow(glowHex, 0.9), trs(Math.cos(a) * r, y - 0.6, Math.sin(a) * r));
    }
  }

  const group = P.build('ceiling');
  for (const m of group.children) {
    // The sun is above the shell, so a shadow-casting ceiling puts the entire arena
    // floor — every prop, every enemy, the player — into one flat shadow, and the
    // dungeons lose the shaft light they are lit by. It receives nothing either:
    // nothing in the room is between it and the sun.
    m.castShadow = false;
    m.receiveShadow = false;
  }
  return {
    group,
    apexY, rimY, radius,
    dispose() { for (const m of group.children) m.geometry.dispose(); },
  };
}

/* ------------------------------------------------------- interactive props -- */

const SINGLE = {};

/** Treasure chest. `tier` drives the material set; `open()` runs the lid. */
SINGLE.chest = (opts = {}) => {
  const tier = opts.tier ?? 'common';
  const TIERS = {
    common: { shell: MATS.wood(), trim: MATS.iron(), gem: null },
    exquisite: { shell: MATS.wood(), trim: MATS.silver(), gem: 0x7fd4f0 },
    precious: { shell: MATS.woodDark(), trim: MATS.gold(), gem: 0xffd75e },
    luxurious: { shell: MATS.goldDeep(), trim: MATS.gold(), gem: 0xff8fd8 },
  };
  const T = TIERS[tier] ?? TIERS.common;
  const W = 0.42, D = 0.30, H = 0.30;

  const body = new Parts();
  body.add(loft(SEC.rect, 0.05, H, () => ({ w: W, d: D }), 1), T.shell);
  for (const s of [-1, 1]) {
    body.add(loft(SEC.rect, 0, 0.07, () => ({ w: 0.06, d: 0.06 }), 1), MATS.woodDark(),
      trs(s * W * 0.78, 0, D * 0.66));
    body.add(loft(SEC.rect, 0, 0.07, () => ({ w: 0.06, d: 0.06 }), 1), MATS.woodDark(),
      trs(s * W * 0.78, 0, -D * 0.66));
    // Corner straps.
    body.add(loft(SEC.rect, 0.05, H, () => ({ w: 0.035, d: D * 1.02 }), 1), T.trim,
      trs(s * W * 0.86, 0, 0));
  }
  const bodyGroup = body.build(`chest:${tier}:body`);

  // Lid as a barrel: swept along X with the half-disc section, so `w` becomes the
  // chord in Z and `d` the height in Y (which is why the sweep needs UP_REF — with
  // the default +Z reference the dome would face sideways). Slightly domed at the
  // ends rather than a straight extrusion.
  const lidParts = new Parts();
  lidParts.add(sweep(SEC_DOME, (t) => {
    V.set(-W * 1.02 + 2 * W * 1.02 * t, 0, 0);
    const k = 0.90 + 0.10 * Math.sin(t * Math.PI);
    return { p: V, w: D * 1.02 * k, d: D * 1.02 * k, ref: UP_REF };
  }, 8), T.shell);
  lidParts.add(ring(D * 1.03, 0.022, 5, 12), T.trim, trs(W * 0.86, 0, 0, 0, 0, Math.PI / 2));
  lidParts.add(ring(D * 1.03, 0.022, 5, 12), T.trim, trs(-W * 0.86, 0, 0, 0, 0, Math.PI / 2));
  if (T.gem) {
    lidParts.add(loft(SEC_HEX, 0, 0.10, (t) => ({ w: 0.05 * (1 - t), d: 0.05 * (1 - t) }), 2),
      MATS.crystal(T.gem), trs(0, D * 1.0, 0));
  }
  const lid = lidParts.build(`chest:${tier}:lid`);
  // Pivot at the back edge of the box, so the lid hinges instead of rotating in
  // place — a lid rotated about its own centre sinks through the body.
  const hinge = new THREE.Group();
  hinge.position.set(0, H, -D);
  lid.position.set(0, 0, D);
  hinge.add(lid);

  const lock = new Parts();
  lock.add(loft(SEC.rect, 0, 0.09, () => ({ w: 0.055, d: 0.03 }), 1), T.trim,
    trs(0, H - 0.05, D * 1.0));
  const lockG = lock.build('chest:lock');

  const group = new THREE.Group();
  group.name = `prop:chest:${tier}`;
  group.add(bodyGroup, hinge, lockG);
  addOutline(group, 0x1a1410, 1.6);

  let open = 0, target = 0;
  return {
    group, height: H + D * 1.05, radius: W * 1.2, interactive: 'chest', tier,
    open() { target = 1; },
    isOpen: () => open > 0.98,
    update(dt) {
      if (open === target) return;
      // Ease out, and overshoot slightly: the little bounce at the top is most of
      // what makes opening a chest feel good.
      open = Math.min(1, open + dt * 2.2);
      const e = 1 - (1 - open) * (1 - open);
      hinge.rotation.x = -e * 2.0 + Math.sin(e * Math.PI) * 0.18;
      lockG.visible = open < 0.15;
    },
  };
};

/** Brazier: geometry, an animated flame and a real point light. */
SINGLE.brazier = (opts = {}) => {
  const hex = opts.color ?? 0xff8a3c;
  const P = new Parts();
  const H = 0.95;
  // Tripod legs: splayed out at the foot and gathered under the bowl, aimed with
  // `along` rather than Euler pairs — a `trs(..., rx, 0, rz)` fan folds flat at the
  // azimuth 90 degrees from where it was tuned. Thick and tapered, because three
  // 4 cm sticks under a 34 cm iron bowl read as a plant stand.
  const footR = 0.34, topR = 0.11;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    const c = Math.cos(a), s = Math.sin(a);
    const dx = (topR - footR) * c, dz = (topR - footR) * s;
    const len = Math.hypot(dx, dz, H);
    P.add(loft(SEC.oct, 0, len, (t) => {
      const r = lerp(0.075, 0.05, t);
      return { w: r, d: r };
    }, 2), MATS.iron(), along(c * footR, 0.03, s * footR, dx, H, dz));
    // Clawed foot, so the leg meets the ground on something.
    P.add(blob(0.075, 1.25, 0.55, 1.25, 8), MATS.iron(), trs(c * footR, 0.035, s * footR));
  }
  // Brace hoop tying the legs together at a third height.
  P.add(ring(footR * 0.72, 0.022, 5, 14), MATS.iron(), trs(0, H * 0.34, 0, Math.PI / 2, 0, 0));
  P.add(loft(SEC.oct, H, H + 0.26, (t) => ({ w: lerp(0.16, 0.34, t), d: lerp(0.16, 0.34, t) }), 2),
    MATS.iron());
  P.add(ring(0.34, 0.035, 5, 14), MATS.iron(), trs(0, H + 0.26, 0, Math.PI / 2, 0, 0));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    P.add(sphere(0.075, 7), MATS.ember(),
      trs(Math.cos(a) * 0.14, H + 0.20, Math.sin(a) * 0.14));
  }
  const group = P.build('prop:brazier');
  addOutline(group, 0x14121c, 1.6);

  // Flame: three nested cones on a transparent glow material, counter-rotating and
  // breathing. Cheap, and reads as fire because the layers disagree.
  const flame = new THREE.Group();
  flame.position.y = H + 0.24;
  const tips = [];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(
      spike(0.52 - i * 0.11, 0.20 - i * 0.045, 6),
      MATS.glow(i === 0 ? hex : 0xffd9a0, 2.2 + i * 0.5),
    );
    m.userData.noOutline = true;
    flame.add(m);
    tips.push(m);
  }
  group.add(flame);

  const light = new THREE.PointLight(hex, 3.2, 14, 2);
  light.position.set(0, H + 0.5, 0);
  group.add(light);

  return {
    group, height: H + 0.8, radius: 0.5, light,
    update(dt, t) {
      for (let i = 0; i < tips.length; i++) {
        const p = t * (3.1 + i * 1.7) + i * 2.0;
        tips[i].scale.set(1 + Math.sin(p) * 0.14, 1 + Math.sin(p * 1.3) * 0.22, 1 + Math.cos(p) * 0.14);
        tips[i].rotation.y = t * (0.9 + i * 0.5);
        tips[i].position.set(Math.sin(p * 0.7) * 0.02, 0, Math.cos(p * 0.6) * 0.02);
      }
      light.intensity = 3.2 + Math.sin(t * 7.3) * 0.5 + Math.sin(t * 3.1) * 0.3;
    },
  };
};

/** Teleport waypoint: a stone dais with floating shards and a light column. */
SINGLE.waypoint = (opts = {}) => {
  const hex = opts.color ?? 0x8fe3f0;
  const P = new Parts();
  P.add(loft(SEC_FLUTE, 0, 0.16, () => ({ w: 1.35, d: 1.35 }), 1), MATS.stonePale());
  P.add(loft(SEC_FLUTE, 0.16, 0.30, (t) => ({ w: lerp(1.15, 1.02, t), d: lerp(1.15, 1.02, t) }), 1),
    MATS.stonePale());
  P.add(ring(1.0, 0.05, 5, 24), MATS.glow(hex, 1.6), trs(0, 0.32, 0, Math.PI / 2, 0, 0));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    P.add(loft(SEC.rect, 0, 0.5, (t) => ({ w: 0.14 * (1 - t * 0.5), d: 0.07 }), 1),
      MATS.stonePale(), trs(Math.cos(a) * 0.92, 0.16, Math.sin(a) * 0.92, 0, -a, 0.22));
  }
  const group = P.build('prop:waypoint');
  addOutline(group, 0x1a2030, 1.6);

  // Floating shards + a soft column of light. The column is a cylinder with no
  // depth write so it never occludes the player standing inside it.
  const shards = new THREE.Group();
  shards.position.y = 1.5;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    const m = new THREE.Mesh(
      loft(SEC_HEX, -0.16, 0.30, (t) => ({ w: 0.075 * Math.sin(t * Math.PI) + 0.01, d: 0.075 * Math.sin(t * Math.PI) + 0.01 }), 3),
      MATS.crystal(hex),
    );
    m.position.set(Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42);
    m.userData.noOutline = true;
    shards.add(m);
  }
  group.add(shards);

  // Brightest just above the dais and gone by the top, so the shaft has no upper
  // edge to give itself away as geometry.
  const col = glowVolume(
    new THREE.CylinderGeometry(0.62, 0.86, 6.0, 18, 6, true),
    hex, 0.085, (u) => Math.max(0, 1 - u) ** 1.7 * (0.35 + 0.65 * Math.min(1, u * 8)),
  );
  col.position.y = 3.0;
  group.add(col);

  const light = new THREE.PointLight(hex, 2.0, 12, 2);
  light.position.y = 1.2;
  group.add(light);

  return {
    group, height: 2.2, radius: 1.4, interactive: 'waypoint', light,
    update(dt, t) {
      shards.rotation.y = t * 0.55;
      shards.position.y = 1.5 + Math.sin(t * 1.3) * 0.10;
      for (let i = 0; i < shards.children.length; i++) {
        shards.children[i].rotation.set(0, t * 1.1 + i, Math.sin(t * 0.9 + i) * 0.3);
      }
      light.intensity = 2.0 + Math.sin(t * 2.2) * 0.4;
    },
  };
};

/** Statue of the Seven: pedestal, robed figure, wings, elemental gem. */
SINGLE.statue = (opts = {}) => {
  const el = opts.element ?? 'wind';
  const hex = ELEMENTS[el]?.color ?? 0x8fe3f0;
  const P = new Parts();
  // Pedestal.
  P.add(loft(SEC_FLUTE, 0, 0.34, () => ({ w: 2.0, d: 2.0 }), 1), MATS.stonePale());
  P.add(loft(SEC_FLUTE, 0.34, 0.62, (t) => ({ w: lerp(1.75, 1.55, t), d: lerp(1.75, 1.55, t) }), 1),
    MATS.stonePale());
  P.add(ring(1.5, 0.07, 5, 26), MATS.glow(hex, 1.4), trs(0, 0.66, 0, Math.PI / 2, 0, 0));
  P.add(loft(SEC.rect, 0.62, 1.10, (t) => ({ w: lerp(1.0, 0.82, t), d: lerp(1.0, 0.82, t) }), 1),
    MATS.stonePale());

  const y0 = 1.10;
  const shoulderY = y0 + 1.72;
  // Skirt: narrow through the hips and only flaring below the knee. A profile that
  // widens steadily from the shoulders straight down to a 1.8 m hem — which the first
  // pass had — is geometrically a traffic cone, and no amount of detail on top of it
  // recovers a figure.
  // `loft`'s t runs from y0 upward, so t = 0 is the hem and has to be the wide end.
  P.add(loft(SEC.oct, 0, 1.30, (t) => {
    const w = 0.34 + 0.52 * Math.max(0, 1 - t * 1.7) ** 1.5;
    return { w, d: w * 0.88 };
  }, 8), MATS.stonePale(), trs(0, y0, 0));
  // Torso, waist to shoulders, slightly barrelled.
  P.add(loft(SEC.oct, y0 + 1.24, shoulderY + 0.06, (t) => {
    const w = 0.33 + 0.06 * Math.sin(t * Math.PI);
    return { w, d: w * 0.78 };
  }, 4), MATS.stonePale());
  // Sash at the waist and a mantle over the shoulders — the two horizontals that
  // break the column into a body.
  P.add(ring(0.36, 0.055, 5, 14), MATS.gold(), trs(0, y0 + 1.28, 0, Math.PI / 2, 0, 0));
  // Kept narrow (0.46 at the hem) so the arms hanging at ±0.46 stay outside it. A
  // wider mantle swallows them and the figure loses its arms entirely.
  P.add(loft(SEC.oct, 0, 0.34, (t) => {
    const w = lerp(0.46, 0.28, t);
    return { w, d: w * 0.86 };
  }, 2), MATS.stonePale(), trs(0, shoulderY - 0.14, 0));

  // Neck, then the head clear of the shoulders, with the cowl behind it rather
  // than over it. Sunk into the mantle the head disappears and the statue reads as
  // a cone with a point on top.
  P.add(bar(SEC.oct, shoulderY + 0.04, shoulderY + 0.26, 0.115, 0.105, 1), MATS.stonePale());
  P.add(blob(0.27, 0.95, 1.12, 1.0, 12), MATS.stonePale(), trs(0, shoulderY + 0.52, 0));
  P.add(blob(0.32, 1.05, 0.95, 0.78, 12), MATS.stonePale(),
    trs(0, shoulderY + 0.48, -0.19));
  // Hair/veil falling behind the shoulders. Aimed with `along` rather than placed
  // with a negative Y scale: mirroring a geometry flips its winding, which inverts
  // the normals and turns the inverted-hull outline inside out.
  P.add(loft(SEC.lens, 0, 0.70, (t) => ({ w: lerp(0.26, 0.10, t), d: lerp(0.13, 0.05, t) }), 3),
    MATS.stonePale(), along(0, shoulderY + 0.38, -0.22, 0, -1, -0.20));

  // Arms: upper arm out and down from the shoulder, forearm folded across the chest
  // so the two together frame the gem. Seated at ±0.42, just outside the mantle hem.
  for (const s of [-1, 1]) {
    P.add(loft(SEC.oct, 0, 0.52, (t) => ({ w: lerp(0.115, 0.095, t), d: lerp(0.115, 0.095, t) }), 2),
      MATS.stonePale(), along(s * 0.42, shoulderY - 0.04, 0, s * 0.34, -1, 0.06));
    P.add(loft(SEC.oct, 0, 0.46, (t) => ({ w: lerp(0.095, 0.075, t), d: lerp(0.095, 0.075, t) }), 2),
      MATS.stonePale(),
      along(s * 0.46, shoulderY - 0.56, 0.06, -s * 0.85, 0.36, 0.38));
  }
  // Wings: four plates per side, swept back and up.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const len = 1.5 - i * 0.22;
      const a = 0.35 + i * 0.28;
      P.add(loft(SEC.lens, 0, len, (t) => ({
        w: lerp(0.16, 0.05, t), d: lerp(0.055, 0.02, t),
      }), 3), MATS.stonePale(),
        along(s * 0.40, shoulderY + 0.02, -0.20, s * Math.sin(a), Math.cos(a) * 0.85, -0.45));
    }
  }
  // The elemental gem, cupped between the hands.
  P.add(loft(SEC_HEX, -0.22, 0.30, (t) => ({
    w: 0.15 * Math.sin(t * Math.PI) + 0.012, d: 0.15 * Math.sin(t * Math.PI) + 0.012,
  }), 4), MATS.crystal(hex), trs(0, shoulderY - 0.34, 0.36));

  const group = P.build('prop:statue');
  addOutline(group, 0x1a2030, 1.8);
  const light = new THREE.PointLight(hex, 2.4, 16, 2);
  light.position.set(0, y0 + 1.7, 0.6);
  group.add(light);
  return {
    group, height: y0 + 2.8, radius: 2.2, interactive: 'statue', light,
    update(dt, t) { light.intensity = 2.4 + Math.sin(t * 1.7) * 0.35; },
  };
};

/** Elemental monument (puzzle target). `setLit` fires when it is solved. */
SINGLE.monument = (opts = {}) => {
  const el = opts.element ?? 'wind';
  const hex = ELEMENTS[el]?.color ?? 0x8fe3f0;
  const P = new Parts();
  // Dressed stone, not a post. The first version was a stepped plinth, one loft from
  // half-extent 0.34 to 0.20, and a small pyramid, all in `MATS.stone()`; prop-cam's
  // full-figure shot of it is a featureless grey pencil. Nothing was wrong with any single
  // number — there was simply nothing in the shape for light to break on. A cel ramp needs
  // either a change of plane or a change of albedo, and a straight taper in one material
  // offers neither: the silhouette is one line from plinth to tip and each of the three
  // visible faces is one flat tone from bottom to top.
  //
  // So: three base courses in alternating stones, two carved collars, a cornice that
  // overhangs, and the sigil sunk into a dark cartouche. Everything below is still one
  // merged geometry per material (three draw calls), because `Parts` batches by material.
  const Y0 = 0.42, Y1 = 2.34;     // the shaft: above the base courses, below the cornice
  const W0 = 0.345, W1 = 0.215;   // its half-extents (`SEC_HEX` is a *unit* hexagon)
  const hw = (y) => lerp(W0, W1, (y - Y0) / (Y1 - Y0));
  // A unit hexagon lofted to half-extent w puts its +Z face at 0.866w, spanning ±0.5w.
  // Every part stuck to that face is placed off this function rather than off a number
  // copied from a comment, so re-proportioning the shaft moves the decoration with it.
  const faceZ = (y) => hw(y) * 0.866;

  P.add(bar(SEC.rect, 0, 0.13, 0.62, 0.62), MATS.stoneDark());
  P.add(bar(SEC.rect, 0.13, 0.27, 0.54, 0.54), MATS.stone());
  // The course that turns a square base into a hexagonal shaft; pale, so the eye reads
  // three separate stones at the foot instead of one 1.2 m block.
  P.add(loft(SEC_HEX, 0.27, Y0, (t) => { const w = lerp(0.46, W0, t); return { w, d: w }; }, 2),
    MATS.stonePale());
  P.add(loft(SEC_HEX, Y0, Y1, (t) => { const w = lerp(W0, W1, t); return { w, d: w }; }, 3),
    MATS.stone());
  // Carved collars, diamond in profile (out to the middle, back in) so the upper slope
  // catches the sun and the underside holds a hard shadow line across all six faces.
  // A band flush with the shaft would only be a change of albedo; this is also a change
  // of plane, which is what survives at gameplay distance.
  for (const [y, h] of [[0.74, 0.10], [2.04, 0.09]]) {
    P.add(loft(SEC_HEX, y, y + h, (t) => {
      const w = hw(y + h * t) + 0.018 + 0.030 * (1 - Math.abs(t * 2 - 1));
      return { w, d: w };
    }, 4), MATS.stoneDark());
  }
  P.add(loft(SEC_HEX, Y1, 2.44, (t) => { const w = lerp(W1 + 0.02, 0.255, t); return { w, d: w }; }, 2),
    MATS.stonePale());
  P.add(loft(SEC_HEX, 2.44, 2.92, (t) => { const w = lerp(0.235, 0.03, t); return { w, d: w }; }, 3),
    MATS.stone());
  // The cartouche the sigil is set into. `oz` per step, not one z for the whole slab: a
  // panel laid at a single depth against a *tapering* face is buried at the bottom and
  // floating clear of the stone at the top. It narrows with the face for the same reason.
  P.add(loft(SEC.rect, 1.14, 1.98, (t) => {
    const y = lerp(1.14, 1.98, t);
    return { w: lerp(0.132, 0.110, t), d: 0.020, oz: faceZ(y) - 0.006 };
  }, 3), MATS.stoneDark());
  const group = P.build('prop:monument');
  addOutline(group, 0x1a2030, 1.6);

  // The sigil is a separate mesh so it can be switched from dead stone to lit.
  //
  // It sits *in* the cartouche on the shaft's front face — `faceZ(1.6) ≈ 0.230` is the stone,
  // the panel stands 0.014 proud of it, and the torus' centre goes 0.026 further out so its
  // back half stays embedded in the panel and it reads as an inlay rather than a badge glued
  // on. Its outer radius (0.095 + 0.026 = 0.121) is sized to the cartouche, which is itself
  // sized to the face: at y 1.6 the face spans only ±0.5 × 0.265 = ±0.133. The first
  // version was a 0.20-radius torus at z 0.22 laid *flat* (`rotation.x = π/2`) — wider than
  // the face it was supposed to decorate and turned 90° out of it, so `tools/prop-cam.mjs`
  // photographed a white ellipse hovering off the side of the obelisk with nothing joining
  // the two. An unlit puzzle marker that already reads as a glowing disc also destroys the
  // one piece of feedback the puzzle has (dead stone → lit sigil), which is worse than the
  // geometry being wrong. `ring` faces +Z like `TorusGeometry` — the flat-laying call sites
  // all pass `trs(..., π/2, 0, 0)`, which is what that rotation was copied from — and facing
  // +Z is also what makes `update`'s `rotation.z` spin visible once it is lit.
  const sigil = new THREE.Mesh(
    ring(0.095, 0.026, 4, 6),
    MATS.stoneDark(),
  );
  sigil.position.set(0, 1.6, faceZ(1.6) + 0.026);
  // Named because `tools/puzzle-check.mjs` measures these two meshes' pixels before and after
  // `setLit`, and a rectangle aimed at a guessed height is a confident measurement of the
  // wrong thing.
  sigil.name = 'monument:sigil';
  group.add(sigil);
  // The elemental orb floats *above* the tip (2.92), clear of it by 0.26. It used to sit at
  // y 2.62 inside the capstone: the cap tapers to 0.03 at its point, so at 2.62 the stone
  // around it was 0.15 wide and the 0.10 sphere was entirely buried. Nobody ever saw the
  // second half of "this monument is lit" — the probe measured 96.8 → 95.1 luma there, i.e. no
  // change at all, which is how a mesh that is drawn but occluded reads.
  const core = new THREE.Mesh(sphere(0.11, 10), MATS.glow(hex, 2.0));
  core.position.set(0, 3.18, 0);
  core.visible = false;
  core.userData.noOutline = true;
  core.name = 'monument:core';
  group.add(core);

  let lit = false;
  return {
    group, height: 3.4, radius: 0.7, interactive: 'monument', element: el,
    setLit(v) {
      lit = v;
      sigil.material = v ? MATS.glow(hex, 1.8) : MATS.stoneDark();
      core.visible = v;
    },
    update(dt, t) {
      if (!lit) return;
      sigil.rotation.z = t * 0.8;
      core.position.y = 3.18 + Math.sin(t * 2.0) * 0.07;
    },
  };
};

/** Dungeon entrance: a dark arch around a swirling portal disc. */
SINGLE.dungeonGate = (opts = {}) => {
  const hex = opts.color ?? 0x9a6cff;
  const P = new Parts();
  const span = 3.2, h = 3.4, r = 0.40;
  for (const s of [-1, 1]) {
    P.add(loft(SEC_FLUTE, 0, h, () => ({ w: r, d: r }), 3), MATS.abyssStone(),
      trs(s * span * 0.5, 0, 0));
    P.add(loft(SEC.rect, 0, 0.34, () => ({ w: r * 1.9, d: r * 1.9 }), 1), MATS.abyssStone(),
      trs(s * span * 0.5, 0, 0));
  }
  P.add(sweep(SEC.rect, (t) => {
    const a = Math.PI * t;
    V.set(-Math.cos(a) * span * 0.5, h + Math.sin(a) * span * 0.42, 0);
    return { p: V, w: r * 0.95, d: r * 1.1 };
  }, 14), MATS.abyssStone());
  for (let i = 0; i < 5; i++) {
    const a = Math.PI * (0.18 + i * 0.16);
    P.add(loft(SEC_HEX, 0, 0.34, (t) => ({ w: 0.09 * (1 - t * 0.8), d: 0.09 * (1 - t * 0.8) }), 2),
      MATS.crystal(hex),
      along(-Math.cos(a) * span * 0.5, h + Math.sin(a) * span * 0.42, 0,
        -Math.cos(a), Math.sin(a), 0));
  }
  const group = P.build('prop:dungeonGate');
  addOutline(group, 0x0e0c18, 1.8);

  // Portal: bright in the middle, feathered to nothing at the rim. Flat opacity gave
  // an opaque purple coin filling the arch rather than something to walk into.
  const disc = glowVolume(
    new THREE.CircleGeometry(span * 0.46, 28, 0, TAU),
    hex, 0.55, (u) => (1 - u) ** 1.4 * 0.9 + 0.10, true,
  );
  disc.position.set(0, h * 0.55, 0);
  group.add(disc);
  const light = new THREE.PointLight(hex, 3.0, 18, 2);
  light.position.set(0, h * 0.6, 0.4);
  group.add(light);

  return {
    group, height: h + span * 0.5, radius: span * 0.7, interactive: 'dungeon', light,
    update(dt, t) {
      disc.rotation.z = t * 0.35;
      disc.scale.setScalar(1 + Math.sin(t * 1.6) * 0.04);
      light.intensity = 3.0 + Math.sin(t * 2.6) * 0.6;
    },
  };
};

/* --------------------------------------------------------------- glow volumes -- */

/**
 * Additive glow volume with a baked per-vertex alpha fade.
 *
 * A constant-alpha additive tube is the wrong primitive for a light shaft no matter
 * how low the opacity goes: the top of the cylinder ends in a hard horizontal edge,
 * and a hard edge is read as the boundary of a solid object, so the beam looks like a
 * teal pillar standing in the way. Fading the alpha out along the axis is what turns
 * the same geometry into light. `fade(u)` gets 0 at the base and 1 at the tip.
 *
 * Depth-write is off so the player can stand inside it, and `noOutline` keeps the
 * inverted hull from drawing a black ring around thin air.
 */
function glowVolume(geo, hex, opacity, fade, radial = false) {
  const pos = geo.attributes.position;
  // `radial` measures out from the centre in the geometry's own XY plane, which is
  // where CircleGeometry builds its disc; otherwise the fade runs along Y.
  const coord = radial
    ? (i) => Math.hypot(pos.getX(i), pos.getY(i))
    : (i) => pos.getY(i);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    lo = Math.min(lo, coord(i));
    hi = Math.max(hi, coord(i));
  }
  const col = new Float32Array(pos.count * 4);
  const c = new THREE.Color(hex).convertSRGBToLinear();
  for (let i = 0; i < pos.count; i++) {
    const u = hi > lo ? (coord(i) - lo) / (hi - lo) : 0;
    col[i * 4] = c.r; col[i * 4 + 1] = c.g; col[i * 4 + 2] = c.b;
    col[i * 4 + 3] = fade(u);
  }
  // itemSize 4 is what makes three compile the vertex-alpha path; a 3-component
  // colour attribute would silently drop the fade.
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }));
  mesh.userData.noOutline = true;
  return mesh;
}

/* --------------------------------------------------------------- assembly -- */

/** Merge a Parts collection down to one geometry per material. */
function mergedPieces(parts) {
  const out = [];
  for (const [mat, list] of parts.byMat) {
    out.push({ mat, geo: mergeParts(list, mat) });
  }
  return out;
}

/**
 * Build one prototype of a scattered prop: merged geometry per material plus the
 * measurements the scene layer needs for placement and collision.
 */
export function makeProto(kind, opts = {}) {
  const build = SCATTER[kind];
  if (!build) throw new Error(`unknown prop kind: ${kind}`);
  const P = new Parts();
  const info = build(P, new Rand(opts.seed ?? 1), opts) ?? {};
  return { kind, pieces: mergedPieces(P), height: 1, radius: 0.5, ...info };
}

/**
 * Prototype cache.
 *
 * Building a proto means running the recipe and merging its geometry — tens of
 * thousands of vertex writes for a tree. Streaming used to do that for every
 * (cell, kind, variant) triple, so walking across a zone rebuilt the same handful
 * of shapes hundreds of times and re-uploaded each one to the GPU. Geometry is
 * immutable once merged and InstancedMesh keeps placement in its own buffer, so
 * one proto can back every field that wants it.
 *
 * The cache is only bounded because callers keep the seed space small (see the
 * `cx & 1` seeding in world.js): a per-cell seed would put one entry in here per
 * cell of the map and leak the lot.
 */
const PROTO_CACHE = new Map();

function protoKey(kind, opts) {
  let k = kind;
  // Only the values that reach a recipe matter, and they are all primitives —
  // stringifying the whole opts object would key on `variants`/`outline` too and
  // fragment the cache for no reason.
  // 'span' matters as much as 'height': the enclosure recipes size their arch and
  // backing wall from it, so two arenas of different radius must not share a proto.
  // 'wallColor' for the same reason as 'color': it picks the material a recipe bakes into
  // its proto, and two protos with different materials cannot share an InstancedMesh —
  // leaving it out would serve the first zone's wall colour to every later one.
  for (const name of ['seed', 'snowy', 'dry', 'color', 'colorB', 'wallColor', 'height', 'span', 'element', 'tier']) {
    if (opts[name] !== undefined) k += `|${name}=${opts[name]}`;
  }
  return k;
}

let PROTO_UID = 0;

export function getProto(kind, opts = {}) {
  const key = protoKey(kind, opts);
  let proto = PROTO_CACHE.get(key);
  if (!proto) {
    proto = makeProto(kind, opts);
    // Identity for batch keying: two protos of the same kind that came from
    // different seeds share neither geometry nor material, so they cannot share an
    // InstancedMesh, and the option string is a clumsy thing to key a Map on.
    proto.uid = ++PROTO_UID;
    PROTO_CACHE.set(key, proto);
  }
  return proto;
}

/** Drop every cached proto — on a zone change, where none of them recur. */
export function clearProtoCache() {
  for (const proto of PROTO_CACHE.values()) {
    for (const piece of proto.pieces) piece.geo.dispose();
  }
  PROTO_CACHE.clear();
}

const M4 = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const T = new THREE.Vector3();
const S3 = new THREE.Vector3();

/**
 * Instanced field of one scattered prop kind.
 *
 * `placements` are `{ x, y, z, rot?, scale?, scaleY?, tilt? }`. Variants let the
 * same kind be built a few times from different seeds and dealt out across the
 * placements, which is the difference between a forest and a wallpaper pattern.
 */
export function buildPropField(kind, placements, opts = {}) {
  const variants = Math.max(1, opts.variants ?? 1);
  const protos = [];
  for (let i = 0; i < variants; i++) {
    protos.push(getProto(kind, { ...opts, seed: (opts.seed ?? 1) * 7919 + i * 131 }));
  }

  // Bucket placements per variant first: an InstancedMesh needs its final count up
  // front, and growing one means reallocating the whole attribute.
  const buckets = protos.map(() => []);
  placements.forEach((p, i) => {
    const v = p.variant != null ? p.variant % variants : i % variants;
    buckets[v].push(p);
  });

  const group = new THREE.Group();
  group.name = `props:${kind}`;
  const meshes = [];
  let instances = 0;

  protos.forEach((proto, vi) => {
    const list = buckets[vi];
    if (!list.length) return;
    for (const piece of proto.pieces) {
      const im = new THREE.InstancedMesh(piece.geo, piece.mat, list.length);
      im.castShadow = opts.castShadow !== false;
      im.receiveShadow = true;
      // Scattered props are placed across a whole zone, so the field's own bounding
      // sphere covers everything; per-object frustum culling would cull all or
      // nothing anyway and three cannot cull individual instances.
      im.frustumCulled = false;
      im.name = `${kind}:v${vi}`;
      list.forEach((p, i) => {
        const s = p.scale ?? 1;
        E.set(p.tilt?.[0] ?? 0, p.rot ?? 0, p.tilt?.[1] ?? 0);
        M4.compose(T.set(p.x, p.y, p.z), Q.setFromEuler(E), S3.set(s, s * (p.scaleY ?? 1), s));
        im.setMatrixAt(i, M4);
      });
      im.instanceMatrix.needsUpdate = true;
      group.add(im);
      meshes.push(im);
    }
    instances += list.length;
  });

  if (opts.outline !== false) {
    addOutline(group, opts.outlineColor ?? 0x1a1a20, opts.outlineWidth ?? 2.1);
  }

  return {
    kind, group, meshes, protos, instances,
    height: protos[0]?.height ?? 1,
    radius: protos[0]?.radius ?? 0.5,
    dispose() {
      // Geometry belongs to the proto cache and outlives the field; only the
      // per-instance buffers are ours to release.
      for (const m of meshes) m.dispose();
      group.clear();
    },
  };
}

/* ------------------------------------------------------------- prop pool -- */

/**
 * Zone-wide instanced batches for streamed scatter.
 *
 * `buildPropField` allocates its own InstancedMesh per (variant, material), which
 * means a streamed world pays that cost *per cell*: 25 resident tree cells × 3
 * variants × 3 materials is 225 draw calls (450 with outline shells) to draw a few
 * hundred trees. Measured on the Mondstadt plain that pattern was 1963 draw calls
 * for 3 M triangles, and the two worst buckets were oaks at 120 meshes for 168
 * instances and bushes at 162 meshes for ~1750 — almost one draw call per prop,
 * which is the exact thing instancing exists to avoid.
 *
 * The geometry is already shared (see the proto cache) and the meshes are already
 * `frustumCulled = false`, so per-cell meshes buy nothing at all: they are not
 * culled separately and they do not save memory. This pool keeps one InstancedMesh
 * per (proto, material) for the whole zone and hands cells *instance slots* in it.
 * Draw calls then depend only on how many distinct protos a zone uses, not on how
 * far the player can see.
 *
 * Slots stay packed: releasing a cell moves the pool's last instance into each
 * freed slot and tells its owner where it went, so `count` always equals the number
 * of live instances and no vertex work is spent on collapsed leftovers.
 */
const C3 = new THREE.Color();

/** Hash in [0,1) from a world position and a channel index. */
function jhash(x, z, k) {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 3.717) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * A per-instance albedo multiplier for the prop at (x, z).
 *
 * Value *and* warmth, not value alone: a field where every tuft is a different
 * brightness of the same hue still reads as one material under a dappled light,
 * whereas real foliage differs in how yellow or how blue-green it is — which is what
 * makes a hedge look like many plants. Warmth moves red up and blue down together so
 * the shift stays on the natural yellow-green ↔ blue-green axis instead of wandering
 * off into pink.
 *
 * Keyed on position rather than slot index, because a slot is reused by whatever cell
 * loads next: an index-keyed tint would make the whole field change colour as the
 * player walks.
 */
function instanceTint(x, z, amt) {
  const v = 1 + (jhash(x, z, 1) - 0.5) * 2 * amt;
  const w = (jhash(x, z, 2) - 0.5) * 1.1 * amt;
  return C3.setRGB(Math.max(0, v + w), Math.max(0, v), Math.max(0, v - w * 0.85));
}

export class PropPool {
  /** @param parent object3d the batches are attached to (the world's prop group) */
  constructor(parent) {
    this.parent = parent;
    this.batches = new Map();
  }

  _batch(key, piece, name, opts) {
    let b = this.batches.get(key);
    if (!b) {
      b = {
        piece, name, used: 0, cap: 0, mesh: null, outline: null, outlineMat: null,
        // Claim + local index per slot, so a swap-remove can repoint the instance
        // it moves without searching anyone's slot list.
        ownerClaim: [], ownerLi: [],
        shadow: opts.castShadow !== false,
        outlined: opts.outline !== false,
        outlineColor: opts.outlineColor ?? 0x1a1a20,
        outlineWidth: opts.outlineWidth ?? 2.1,
      };
      this.batches.set(key, b);
    }
    return b;
  }

  /** Make room for `need` live instances, reallocating the buffer if necessary. */
  _grow(b, need) {
    if (b.cap >= need) return;
    // 1.6× headroom: streaming pushes a batch up to its steady-state size in a
    // handful of cells, and growing by exactly what was asked reallocates on nearly
    // every cell load.
    const cap = Math.max(need, Math.ceil(b.cap * 1.6), 48);
    const im = new THREE.InstancedMesh(b.piece.geo, b.piece.mat, cap);
    im.name = b.name;
    im.castShadow = b.shadow;
    im.receiveShadow = true;
    // The batch spans the zone, so its bounding sphere covers everything; three
    // cannot cull individual instances, and culling all-or-nothing is worse than
    // not culling.
    im.frustumCulled = false;
    const old = b.mesh;
    if (b.mesh) {
      im.instanceMatrix.array.set(b.mesh.instanceMatrix.array);
      this.parent.remove(b.mesh);
      b.mesh.dispose();
      // The old shell went out of the scene with its parent; its buffer is the one
      // just disposed above, but it still holds a GPU handle of its own.
      b.outline?.dispose();
      b.outline = null;
    }
    // Per-instance tint. Always allocated, so every pooled batch compiles the same
    // USE_INSTANCING_COLOR variant of its material instead of two.
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    if (old?.instanceColor) im.instanceColor.array.set(old.instanceColor.array);
    im.instanceColor.needsUpdate = true;
    im.count = b.used;
    im.instanceMatrix.needsUpdate = true;
    this.parent.add(im);
    b.mesh = im;
    b.cap = cap;

    if (b.outlined) {
      // One outline material per batch, kept across reallocations. The shell shares
      // the source's instanceMatrix so every instance's hull follows it for free.
      b.outlineMat ||= outlineMaterial(
        b.outlineColor, b.outlineWidth,
        b.piece.mat?.userData?.toon?.uSway?.value ?? 0,
      );
      const shell = new THREE.InstancedMesh(b.piece.geo, b.outlineMat, cap);
      shell.instanceMatrix = im.instanceMatrix;
      shell.count = b.used;
      shell.castShadow = false;
      shell.receiveShadow = false;
      shell.frustumCulled = false;
      shell.renderOrder = -1;
      shell.userData.noOutline = true;
      shell.userData.isOutline = true;
      im.add(shell);
      b.outline = shell;
    }
  }

  /**
   * Claim slots for one cell's worth of one kind. Same `placements` and `opts` as
   * `buildPropField`; returns a handle whose only job is to give the slots back.
   */
  acquire(kind, placements, opts = {}) {
    const variants = Math.max(1, opts.variants ?? 1);
    const protos = [];
    for (let i = 0; i < variants; i++) {
      protos.push(getProto(kind, { ...opts, seed: (opts.seed ?? 1) * 7919 + i * 131 }));
    }

    const buckets = protos.map(() => []);
    placements.forEach((p, i) => {
      const v = p.variant != null ? p.variant % variants : i % variants;
      buckets[v].push(p);
    });

    // How far each instance's albedo may drift from the material's. No two shrubs in
    // a hedge are the same green, and a batch that shares one material has no other
    // way to say so — this is the whole visual difference between "instanced" and
    // "copy-pasted". 0 for anything whose colour carries meaning.
    const tint = opts.tint ?? 0.10;

    const claims = [];
    let instances = 0;
    protos.forEach((proto, vi) => {
      const list = buckets[vi];
      if (!list.length) return;
      proto.pieces.forEach((piece, pi) => {
        const key = `${proto.uid}|${pi}|${opts.castShadow !== false ? 1 : 0}|${opts.outline !== false ? 1 : 0}`;
        const b = this._batch(key, piece, `${kind}:v${vi}`, opts);
        this._grow(b, b.used + list.length);
        const claim = { b, slots: [] };
        for (const p of list) {
          const at = b.used++;
          const s = p.scale ?? 1;
          E.set(p.tilt?.[0] ?? 0, p.rot ?? 0, p.tilt?.[1] ?? 0);
          M4.compose(T.set(p.x, p.y, p.z), Q.setFromEuler(E), S3.set(s, s * (p.scaleY ?? 1), s));
          b.mesh.setMatrixAt(at, M4);
          if (tint > 0) b.mesh.setColorAt(at, instanceTint(p.x, p.z, tint));
          b.ownerClaim[at] = claim;
          b.ownerLi[at] = claim.slots.length;
          claim.slots.push(at);
        }
        b.mesh.count = b.used;
        b.mesh.instanceMatrix.needsUpdate = true;
        if (tint > 0) b.mesh.instanceColor.needsUpdate = true;
        b.mesh.visible = b.used > 0;
        if (b.outline) b.outline.count = b.used;
        claims.push(claim);
      });
      instances += list.length;
    });

    const release = () => this._release(claims);
    return {
      kind, protos, instances,
      height: protos[0]?.height ?? 1,
      radius: protos[0]?.radius ?? 0.5,
      release,
      dispose: release,
    };
  }

  _release(claims) {
    for (const claim of claims) {
      const b = claim.b;
      const slots = claim.slots;
      while (slots.length) {
        const li = slots.length - 1;
        const at = slots[li];
        const last = b.used - 1;
        if (at !== last) {
          // Swap-remove. The moved instance can belong to this same claim; its
          // local index is necessarily below `li` (it points at `last`, not at
          // `at`), so writing through the back pointer is safe before the pop.
          b.mesh.getMatrixAt(last, M4);
          b.mesh.setMatrixAt(at, M4);
          b.mesh.getColorAt(last, C3);
          b.mesh.setColorAt(at, C3);
          const oc = b.ownerClaim[last], ol = b.ownerLi[last];
          b.ownerClaim[at] = oc;
          b.ownerLi[at] = ol;
          oc.slots[ol] = at;
        }
        b.ownerClaim[last] = null;
        b.used = last;
        slots.pop();
      }
      b.mesh.count = b.used;
      b.mesh.instanceMatrix.needsUpdate = true;
      b.mesh.instanceColor.needsUpdate = true;
      // An emptied batch stays in the pool — the player usually walks back — but it
      // must not stay in the render list: a zero-count InstancedMesh is still a
      // material bind and a draw submission, and a quality change can leave dozens.
      b.mesh.visible = b.used > 0;
      if (b.outline) b.outline.count = b.used;
    }
    claims.length = 0;
  }

  /** Draw-call accounting, for the scene probes. */
  stats() {
    let draws = 0, instances = 0, capacity = 0;
    for (const b of this.batches.values()) {
      draws += b.outline ? 2 : 1;
      instances += b.used;
      capacity += b.cap;
    }
    return { batches: this.batches.size, draws, instances, capacity };
  }

  dispose() {
    for (const b of this.batches.values()) {
      // Geometry and material belong to the proto cache; the outline material and
      // the instance buffers are the pool's own.
      if (b.mesh) {
        this.parent.remove(b.mesh);
        b.mesh.dispose();
      }
      b.outline?.dispose();
      b.outlineMat?.dispose();
    }
    this.batches.clear();
  }
}

/** A single prop: interactive/lit kinds get their own builder, others fall back. */
export function buildProp(kind, opts = {}) {
  if (SINGLE[kind]) return SINGLE[kind](opts);
  const proto = makeProto(kind, opts);
  const group = new THREE.Group();
  group.name = `prop:${kind}`;
  for (const piece of proto.pieces) {
    const mesh = new THREE.Mesh(piece.geo, piece.mat);
    mesh.castShadow = true;
    // A waypoint platform or a chest is exactly where the player stands, so it is
    // the surface their own shadow has to land on.
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (opts.outline !== false) addOutline(group, opts.outlineColor ?? 0x1a1a20, opts.outlineWidth ?? 2.1);
  return {
    kind, group, height: proto.height, radius: proto.radius,
    update() {},
    dispose() { for (const p of proto.pieces) p.geo.dispose(); },
  };
}

export const SCATTER_KINDS = Object.keys(SCATTER);
export const SINGLE_KINDS = Object.keys(SINGLE);
