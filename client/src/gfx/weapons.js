// Procedural weapon models: sword, claymore, polearm, bow, catalyst.
//
// Everything is built from two solid-modelling primitives — `loft` (a closed
// cross-section swept along +Y with a varying width/depth profile) and `sweep`
// (the same section carried along an arbitrary space curve with a proper
// orthonormal frame). That combination is what makes a blade read as a blade:
// a box has one width and one thickness, while a real blade has a lenticular
// cross-section with a central fuller, widens just past the guard, and tapers
// in *both* width and thickness toward the point.
//
// Every weapon is merged down to one mesh per material (4-6 draw calls, doubled
// by the outline shells) and gets the same inverted-hull outline as characters,
// otherwise the weapon reads as a different art style to the hand holding it.

import * as THREE from 'three';
import { metalMaterial, clothMaterial, glowMaterial, addOutline, setAura } from './toon.js';
import { SEC, sweep, loft, bar, trs, Parts, UP_REF, X_REF } from './solid.js';
import { WEAPONS } from '@teyvat/shared/data/items.js';
import { ELEMENTS } from '@teyvat/shared/data/elements.js';

/* ------------------------------------------------------------------ palettes -- */

/** Per-type base palette; `SKINS` overrides individual weapons on top of it. */
const BASE = {
  sword:    { metal: 0xd8dde8, dark: 0x5d6580, trim: 0xc9a961, grip: 0x4a3f5c, gem: 0x8fd6ff, wood: 0x6b5240 },
  claymore: { metal: 0xc8ccd8, dark: 0x4d5468, trim: 0xa8823c, grip: 0x3f3a4a, gem: 0xffb066, wood: 0x5e4636 },
  polearm:  { metal: 0xd2d7e2, dark: 0x585f76, trim: 0xb99a4e, grip: 0x3c4356, gem: 0xe0b8ff, wood: 0x6f5439 },
  bow:      { metal: 0xdfe4ee, dark: 0x525a72, trim: 0xbfa25a, grip: 0x45405a, gem: 0xd6fbff, wood: 0x74563c },
  catalyst: { metal: 0xd9c98f, dark: 0x3d3a58, trim: 0xc0a256, grip: 0xf2ecdc, gem: 0x8fd6ff, wood: 0x5b4a6e },
};

/** Per-weapon overrides. Rarity drives ornament count; these drive the colour. */
const SKINS = {
  travelersBlade: { metal: 0xcfd6e2, dark: 0x5a6278, trim: 0x9aa4bd, grip: 0x3f4c66, gem: 0xbcd2ef },
  windriderEdge:  { metal: 0xe4f4ec, dark: 0x3f6f60, trim: 0x7fe0bd, grip: 0x2f5a4e, gem: 0x4fe0b0 },
  dawnbreaker:    { metal: 0xfff6dd, dark: 0x8a6f34, trim: 0xffd97a, grip: 0x6d5320, gem: 0xfff3c4 },
  ironGreatsword: { metal: 0xb9bec9, dark: 0x474d5c, trim: 0x8d8f9b, grip: 0x35323c, gem: 0x9aa4bd },
  emberCleaver:   { metal: 0xe9cfbd, dark: 0x6d3524, trim: 0xff8a4a, grip: 0x40241c, gem: 0xff6a2b },
  forgeheartMaul: { metal: 0xf0d9c4, dark: 0x7a2f18, trim: 0xffab5c, grip: 0x3a1c14, gem: 0xffb066 },
  huntersBow:     { metal: 0xc8cdd8, dark: 0x4f4436, trim: 0x9c8256, grip: 0x3e3428, wood: 0x7a5c3c, gem: 0xc9d6e8 },
  frostfeather:   { metal: 0xe6f6fb, dark: 0x46708a, trim: 0xa8ecff, grip: 0x35566b, wood: 0x6f8ea3, gem: 0x8fe3f0 },
  polarSight:     { metal: 0xf2fbff, dark: 0x3d5f86, trim: 0xd6fbff, grip: 0x2b4763, wood: 0x5d7f9e, gem: 0xd6fbff },
  ironSpear:      { metal: 0xc2c7d2, dark: 0x4a5060, trim: 0x8e9099, grip: 0x3a4050, wood: 0x6b5240, gem: 0xa8b0c4 },
  stormPike:      { metal: 0xdcd4f2, dark: 0x4b3a75, trim: 0xc79aff, grip: 0x352a52, wood: 0x4f4468, gem: 0xb46cff },
  skyPiercer:     { metal: 0xf4f0ff, dark: 0x554080, trim: 0xe0c8ff, grip: 0x2f2748, wood: 0x584a78, gem: 0xe0b8ff },
  apprenticeTome: { metal: 0xb9a06a, dark: 0x4a4055, trim: 0x9c8a5a, grip: 0xefe6d2, gem: 0xbcd2ef },
  tidalGrimoire:  { metal: 0xa9d8f2, dark: 0x27506e, trim: 0x6fc2f0, grip: 0xdcefff, gem: 0x3aa7ff },
  abyssalCodex:   { metal: 0xd9c98f, dark: 0x2a2340, trim: 0xffe08a, grip: 0xc9bde0, gem: 0xb46cff },
};

function paletteFor(spec) {
  return { ...BASE[spec.type], ...(SKINS[spec.id] ?? {}) };
}

function materialsFor(spec) {
  const P = paletteFor(spec);
  return {
    metal: metalMaterial(P.metal, { roughness: spec.rarity >= 5 ? 0.18 : 0.3 }),
    dark: metalMaterial(P.dark, { metalness: 0.6, roughness: 0.45, rimStrength: 0.35 }),
    trim: metalMaterial(P.trim, { metalness: 0.85, roughness: 0.22, specStep: 0.24 }),
    grip: clothMaterial(P.grip, { roughness: 0.95, rimStrength: 0.18 }),
    wood: clothMaterial(P.wood ?? P.dark, { roughness: 0.92, rimStrength: 0.16 }),
    gem: glowMaterial(P.gem, spec.rarity >= 5 ? 1.7 : 1.15),
  };
}

/* -------------------------------------------------------------------- models -- */

/** Grip wrap: a stack of thin rings, so the hand grips something with texture. */
function wrapRings(parts, mat, y0, y1, count, r) {
  for (let i = 0; i < count; i++) {
    const y = y0 + (y1 - y0) * ((i + 0.5) / count);
    parts.add(new THREE.TorusGeometry(r, r * 0.16, 5, 12), mat,
      trs(0, y, 0, Math.PI / 2, 0, 0.22));
  }
}

/** A faceted gem — an octahedron reads as cut stone under the cel ramp. */
function gemGeo(r, stretch = 1.3) {
  const g = new THREE.OctahedronGeometry(r, 0);
  g.scale(1, stretch, 0.72);
  return g;
}

function buildSword(spec, M) {
  const p = new Parts();
  const r5 = spec.rarity >= 5, r4 = spec.rarity >= 4;
  const bladeLen = 0.69, bw = r5 ? 0.028 : 0.026;

  // Grip, origin-centred: the hand closes around y = 0.
  p.add(loft(SEC.oct, -0.058, 0.062, (t) => {
    const w = 0.0135 + 0.0032 * Math.sin(t * Math.PI);
    return { w, d: w * 0.78 };
  }, 8), M.grip);
  wrapRings(p, M.dark, -0.05, 0.05, 4, 0.0172);

  // Pommel + counterweight.
  p.add(bar(SEC.oct, -0.070, -0.056, 0.020, 0.016), M.trim);
  p.add(gemGeo(0.023, 1.25), M.trim, trs(0, -0.086, 0));
  if (r4) p.add(gemGeo(0.010, 1.0), M.gem, trs(0, -0.086, 0.014));

  // Swept crossguard: quillons rise toward the tip and *narrow* at the ends. An
  // end flare here reads as two white lumps either side of the fist, not as a
  // guard — the eye wants the bar to be widest where the blade passes through it.
  const gHalf = r5 ? 0.122 : 0.108;
  const gp = new THREE.Vector3();
  p.add(sweep(SEC.lens, (t) => {
    const u = t * 2 - 1;
    gp.set(u * gHalf, 0.074 + 0.026 * u * u, -0.005 * u * u);
    const taper = 1 - 0.45 * u * u;
    return { p: gp, w: 0.026 * taper, d: 0.0105 * taper, ref: UP_REF };
  }, 16), M.metal);
  // Quillon knobs, which is where the ornament belongs.
  for (const sgn of [-1, 1]) {
    p.add(gemGeo(0.0115, 1.35), r4 ? M.gem : M.trim, trs(sgn * gHalf, 0.100, -0.005, 0, 0, sgn * 0.5));
  }
  // Collar between guard and blade.
  p.add(loft(SEC.rect, 0.070, 0.098, (t) => ({ w: 0.020 - 0.004 * t, d: 0.011 - 0.002 * t }), 2), M.trim);

  // Blade: widens slightly past the collar, then tapers in width and thickness.
  p.add(loft(SEC.blade, 0.098, 0.098 + bladeLen, (t) => {
    const swell = 1 + 0.06 * Math.sin(Math.min(1, t / 0.18) * Math.PI * 0.5);
    const point = t < 0.80 ? 1 : 1 - Math.pow((t - 0.80) / 0.20, 0.75) * 0.94;
    return { w: bw * swell * (1 - 0.14 * t) * point, d: 0.0058 * (1 - 0.42 * t) * (0.35 + 0.65 * point) };
  }, 20), M.metal);

  // Fuller inlay: sits just proud of the section's groove so it catches its own
  // highlight instead of disappearing into the blade.
  if (r4) {
    p.add(loft(SEC.quad, 0.115, 0.098 + bladeLen * 0.86, (t) => ({
      w: 0.0042 * (1 - 0.5 * t), d: 0.0040 * (1 - 0.5 * t),
    }), 8), r5 ? M.gem : M.trim, trs(0, 0, 0));
    p.add(loft(SEC.quad, 0.115, 0.098 + bladeLen * 0.86, (t) => ({
      w: 0.0042 * (1 - 0.5 * t), d: 0.0040 * (1 - 0.5 * t),
    }), 8), r5 ? M.gem : M.trim, trs(0, 0, -0.0001, 0, Math.PI, 0));
  }
  return p.build('sword');
}

function buildClaymore(spec, M) {
  const p = new Parts();
  const r5 = spec.rarity >= 5, r4 = spec.rarity >= 4;

  // Long two-handed grip; the right hand sits at y = 0, the left below it.
  p.add(loft(SEC.oct, -0.155, 0.030, (t) => {
    const w = 0.0175 + 0.0030 * Math.sin(t * Math.PI);
    return { w, d: w * 0.80 };
  }, 10), M.grip);
  wrapRings(p, M.dark, -0.145, 0.020, 6, 0.0215);
  p.add(bar(SEC.rect, -0.190, -0.155, 0.030, 0.024, 2), M.dark);
  p.add(gemGeo(0.030, 0.9), M.trim, trs(0, -0.206, 0));

  // Heavy angular guard: a straight bar with forward-raked prongs.
  const gp = new THREE.Vector3();
  p.add(sweep(SEC.rect, (t) => {
    const u = t * 2 - 1;
    gp.set(u * 0.150, 0.038 + 0.010 * u * u, 0);
    return { p: gp, w: 0.052 * (1 - 0.25 * u * u), d: 0.021 * (1 - 0.30 * u * u), ref: UP_REF };
  }, 14), M.dark);
  for (const sgn of [-1, 1]) {
    const cp = new THREE.Vector3();
    p.add(sweep(SEC.lens, (t) => {
      cp.set(sgn * (0.142 + 0.072 * t), 0.046 + 0.130 * t - 0.030 * t * t, 0);
      return { p: cp, w: 0.038 * (1 - 0.6 * t), d: 0.019 * (1 - 0.8 * t), ref: UP_REF };
    }, 8), M.metal);
  }
  if (r4) p.add(gemGeo(0.030, 1.1), M.gem, trs(0, 0.050, 0.034));

  // Blade: a broad slab — 20 cm across, which is what separates a claymore from
  // a big sword. Chisel tip: the point is biased to one side with `ox` so one
  // edge runs straight into it and the other is clipped. A symmetric taper on
  // something this wide just looks like a giant leaf.
  const len = 0.76;
  p.add(loft(SEC.blade, 0.058, 0.058 + len, (t) => {
    const belly = 0.088 + 0.038 * Math.sin(Math.min(1, t / 0.24) * Math.PI * 0.5) - 0.016 * t;
    const point = t < 0.70 ? 1 : 1 - Math.pow((t - 0.70) / 0.30, 0.85) * 0.86;
    const w = belly * point;
    return {
      w, d: 0.0175 * (1 - 0.32 * t) * (0.32 + 0.68 * point),
      ox: t < 0.70 ? 0 : (belly - w) * 0.85,
    };
  }, 22), M.metal);

  // Recessed fuller, drawn as a proud dark strip (a real groove would need the
  // section to change, which would break the merge into one blade solid).
  p.add(loft(SEC.rect, 0.085, 0.058 + len * 0.76, (t) => ({
    w: 0.026 * (1 - 0.42 * t), d: 0.0182 * (1 - 0.34 * t),
  }), 8), r5 ? M.gem : M.dark);

  // Rivets along the base of the blade.
  for (let i = 0; i < 3; i++) {
    const y = 0.086 + i * 0.056;
    for (const sgn of [-1, 1]) {
      p.add(new THREE.SphereGeometry(0.0062, 7, 5), M.trim, trs(sgn * 0.042, y, 0.0145));
    }
  }
  return p.build('claymore');
}

function buildPolearm(spec, M) {
  const p = new Parts();
  const r5 = spec.rarity >= 5, r4 = spec.rarity >= 4;
  const butt = -0.86, headY = 1.16;

  // Shaft: slightly thicker at the middle, which is where the grip is.
  p.add(loft(SEC.oct, butt, headY, (t) => {
    const w = 0.0150 + 0.0026 * Math.sin(t * Math.PI * 0.9);
    return { w, d: w };
  }, 14), M.wood);
  for (const y of [-0.78, -0.42, 0.30, 0.86, 1.10]) {
    p.add(new THREE.TorusGeometry(0.0182, 0.0034, 6, 14), M.trim, trs(0, y, 0, Math.PI / 2, 0, 0));
  }
  // Grip wrap around the hand.
  p.add(loft(SEC.oct, -0.12, 0.16, () => ({ w: 0.0178, d: 0.0178 }), 3), M.grip);
  wrapRings(p, M.dark, -0.11, 0.15, 7, 0.0192);
  // Butt spike.
  p.add(loft(SEC.oct, butt - 0.070, butt, (t) => ({ w: 0.0035 + 0.0125 * t, d: 0.0035 + 0.0125 * t }), 3), M.dark);

  // Socket, then a leaf blade. Both are oversized relative to the real thing:
  // at true scale a spearhead on a 2.2 m shaft is a few pixels at gameplay
  // camera distance and the weapon reads as a broom.
  p.add(loft(SEC.oct, headY, headY + 0.095, (t) => ({ w: 0.0245 - 0.0055 * t, d: 0.0245 - 0.0055 * t }), 3), M.dark);
  const bl = 0.46;
  p.add(loft(SEC.blade, headY + 0.082, headY + 0.082 + bl, (t) => {
    const belly = Math.sin(Math.min(1, (t + 0.06) / 0.32) * Math.PI * 0.5);
    const point = t < 0.60 ? 1 : 1 - Math.pow((t - 0.60) / 0.40, 0.9) * 0.94;
    return { w: (0.012 + 0.033 * belly) * point, d: 0.0092 * (1 - 0.32 * t) * (0.3 + 0.7 * point) };
  }, 18), M.metal);
  // Side flanges hooking back off the socket.
  for (const sgn of [-1, 1]) {
    const fp = new THREE.Vector3();
    p.add(sweep(SEC.lens, (t) => {
      fp.set(sgn * 0.078 * Math.sin(t * 1.35), headY + 0.070 + 0.195 * t - 0.075 * t * t, 0);
      return { p: fp, w: 0.021 * (1 - 0.5 * t), d: 0.0125 * (1 - 0.75 * t) };
    }, 10), M.metal);
  }
  if (r4) {
    p.add(gemGeo(0.017, 1.5), M.gem, trs(0, headY + 0.115, 0));
    // Tassel below the head: a ring plus hanging cords.
    p.add(new THREE.TorusGeometry(0.0215, 0.0048, 6, 14), M.trim, trs(0, headY - 0.035, 0, Math.PI / 2, 0, 0));
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const cp = new THREE.Vector3();
      const len = 0.085 + (i % 3) * 0.022;
      p.add(sweep(SEC.quad, (t) => {
        cp.set(Math.cos(a) * (0.020 + 0.012 * t * t), headY - 0.040 - len * t, Math.sin(a) * (0.020 + 0.012 * t * t));
        return { p: cp, w: 0.0042 * (1 - 0.5 * t), d: 0.0042 * (1 - 0.5 * t) };
      }, 5), r5 ? M.gem : M.trim);
    }
  }
  return p.build('polearm');
}

function buildBow(spec, M) {
  const p = new Parts();
  const r5 = spec.rarity >= 5, r4 = spec.rarity >= 4;

  // Riser: held at y = 0, string side is +Z (the attach transform turns it to
  // face the archer).
  p.add(loft(SEC.rect, -0.115, 0.115, (t) => {
    const u = t * 2 - 1;
    return { w: 0.0140 + 0.0030 * (1 - u * u), d: 0.026 + 0.009 * (1 - u * u), oz: -0.004 };
  }, 8), M.grip);
  p.add(loft(SEC.rect, -0.085, 0.085, () => ({ w: 0.019, d: 0.013, oz: -0.026 }), 3), M.dark);
  // Arrow shelf.
  p.add(bar(SEC.lens, 0.020, 0.036, 0.030, 0.012, 1), M.dark, trs(0.014, 0, 0.006));
  if (r4) p.add(gemGeo(0.019, 1.4), M.gem, trs(0, 0, -0.034));

  // Recurve limbs: sweep away from the archer, then hook back so the string has
  // a real brace height instead of lying flat against the riser.
  const tipY = 0.115 + 0.575;
  const tipZ = 0.098;
  const limbZ = (t) => -0.255 * t + (0.255 + tipZ) * Math.pow(t, 2.7);
  for (const sgn of [-1, 1]) {
    const lp = new THREE.Vector3();
    p.add(sweep(SEC.lens, (t) => {
      lp.set(0, sgn * (0.115 + 0.575 * t), limbZ(t));
      return {
        p: lp, w: 0.0105 * (1 - 0.45 * t), d: 0.0245 * (1 - 0.48 * t),
        ref: X_REF,
      };
    }, 16), M.wood);
    // Limb facing strip + nock.
    const fp = new THREE.Vector3();
    p.add(sweep(SEC.quad, (t) => {
      fp.set(0, sgn * (0.130 + 0.548 * t), limbZ(0.026 + 0.974 * t) - 0.0110 * (1 - 0.45 * t));
      return { p: fp, w: 0.0048 * (1 - 0.5 * t), d: 0.0062 * (1 - 0.5 * t), ref: X_REF };
    }, 12), M.trim);
    p.add(new THREE.SphereGeometry(0.0090, 8, 6), M.dark, trs(0, sgn * tipY, tipZ));
    if (r5) {
      // Feather blades: the 5-star bows read as "winged" in the art. They lie
      // *along* the limb — angled off it they turn the bow into a garden fork.
      for (let i = 0; i < 3; i++) {
        const u = 0.30 + i * 0.16;
        const wp = new THREE.Vector3();
        p.add(sweep(SEC.lens, (t) => {
          wp.set(0, sgn * (0.115 + 0.575 * (u + 0.16 * t)),
            limbZ(u + 0.16 * t) - 0.014 - 0.030 * t);
          return { p: wp, w: 0.013 * (1 - 0.8 * t) + 0.002, d: 0.0026, ref: X_REF };
        }, 6), M.trim);
        p.add(gemGeo(0.0075, 1.0), M.gem,
          trs(0, sgn * (0.115 + 0.575 * u), limbZ(u) - 0.020));
      }
    }
  }
  // String, tip to tip.
  p.add(loft(SEC.quad, -tipY, tipY, () => ({ w: 0.0022, d: 0.0022, oz: tipZ }), 1), M.dark);
  return p.build('bow');
}

/**
 * Catalyst: an *open* floating tome, spine vertical, pages facing the viewer.
 *
 * A closed book is the wrong choice here — from any gameplay camera angle it is
 * a featureless rectangle, and read as a silhouette it is indistinguishable from
 * a shield. Open, the two splayed covers and the page block give it a shape that
 * survives at distance.
 */
function buildCatalyst(spec, M) {
  const p = new Parts();
  const r5 = spec.rarity >= 5, r4 = spec.rarity >= 4;
  const W = 0.132;            // half-width of one leaf
  const H = 0.172;            // half-height
  const OPEN = 0.34;          // splay of each leaf about the spine, radians

  for (const sgn of [-1, 1]) {
    const yaw = -sgn * OPEN;
    const half = (geo, mat) => p.add(geo, mat, trs(0, 0, 0, 0, yaw, 0));
    // Cover: offset out along X inside the profile, then rotated about the spine.
    half(loft(SEC.rect, -H, H, () => ({ w: W, d: 0.0072, ox: sgn * (W + 0.006) }), 2), M.dark);
    // Page block, slightly smaller, sitting on the inner face of the cover.
    half(loft(SEC.rect, -H * 0.94, H * 0.94, (t) => ({
      w: W * 0.94, d: 0.0125 - 0.0035 * Math.abs(t * 2 - 1),
      ox: sgn * (W + 0.004), oz: 0.019,
    }), 4), M.grip);
    // Loose leaves at intermediate splay angles. Pages of an upright book are
    // *vertical* rectangles hinged on the spine, so they are built exactly like
    // the cover and only the splay angle differs; a staggered fore-edge width
    // gives the fan without needing a curved sheet.
    for (let i = 0; i < 3; i++) {
      const leafYaw = -sgn * OPEN * (0.70 - i * 0.19);
      const lw = W * (0.93 - i * 0.05);
      p.add(loft(SEC.rect, -H * (0.90 - i * 0.02), H * (0.90 - i * 0.02),
        () => ({ w: lw, d: 0.0020, ox: sgn * (lw + 0.008) }), 2),
      M.grip, trs(0, 0, 0, 0, leafYaw, 0));
    }
    // Corner caps on the outer corners of the cover. The splay is a rotation
    // about Y and the placement is a translation along Y, so they commute and
    // the offset can go straight into the loft's span.
    for (const cy of [-1, 1]) {
      const cyy = cy * (H - 0.017);
      half(loft(SEC.rect, cyy - 0.017, cyy + 0.017, () => ({
        w: 0.014, d: 0.0086, ox: sgn * (2 * W - 0.004),
      }), 1), M.trim);
    }
  }
  // Spine: a curved band bridging the two covers.
  const sp = new THREE.Vector3();
  p.add(sweep(SEC.lens, (t) => {
    const a = (t * 2 - 1) * OPEN * 1.9;
    sp.set(Math.sin(a) * 0.020, 0, -Math.cos(a) * 0.020 + 0.020);
    return { p: sp, w: 0.008, d: 0.006, ref: UP_REF };
  }, 10, { smooth: true }), M.trim);
  p.add(loft(SEC.rect, -H, H, () => ({ w: 0.010, d: 0.020, oz: 0.006 }), 2), M.trim);

  // Ribbon bookmark hanging out of the bottom of the spine.
  const bp = new THREE.Vector3();
  p.add(sweep(SEC.rect, (t) => {
    bp.set(0.006 * Math.sin(t * 3.0), -H - 0.075 * t, 0.012 + 0.020 * t * t);
    return { p: bp, w: 0.0016, d: 0.011 * (1 - 0.25 * t), ref: UP_REF };
  }, 8), r4 ? M.gem : M.trim);

  // Emblem floating in front of the open pages.
  p.add(gemGeo(0.030, 1.15), M.gem, trs(0, 0.006, 0.085));
  p.add(new THREE.TorusGeometry(0.044, 0.0048, 6, 20), M.trim, trs(0, 0.006, 0.078));

  // Orbiting rings — driven by the handle's update(), which is where a catalyst
  // gets its "floating grimoire" read from.
  const rings = new THREE.Group();
  rings.name = 'orbit';
  const ringCount = r5 ? 3 : r4 ? 2 : 0;
  for (let i = 0; i < ringCount; i++) {
    const rp = new Parts();
    const rr = 0.108 + i * 0.024;
    rp.add(new THREE.TorusGeometry(rr, 0.0034, 5, 24), M.trim);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + i;
      rp.add(gemGeo(0.0095, 1.2), M.gem, trs(Math.cos(a) * rr, Math.sin(a) * rr, 0));
    }
    const g = rp.build(`ring${i}`);
    g.rotation.set(1.1 + i * 0.5, i * 0.8, i * 0.4);
    g.userData.spin = (i % 2 ? -1 : 1) * (0.5 + i * 0.25);
    rings.add(g);
  }

  const group = p.build('catalyst');
  if (ringCount) {
    rings.position.z = 0.03;
    group.add(rings);
  }
  return group;
}

const BUILDERS = { sword: buildSword, claymore: buildClaymore, polearm: buildPolearm, bow: buildBow, catalyst: buildCatalyst };

/* ------------------------------------------------------------------- attach -- */

/**
 * Grip transforms, in the hand slot's local frame.
 *
 * The hand bone's local −Y runs out along the hand, so a weapon built along +Y
 * needs roughly a quarter turn past that to sit in a hammer grip: the grip axis
 * of a sword crosses the palm, it does not continue the forearm.
 *
 * Both tables were chosen by measurement rather than by eye, because "the blade
 * hangs down beside the leg" turns out to mean two different things depending on
 * how tall the leg is. Every candidate was scored on the model, on the *two most
 * different bodies* that carry that weapon type (1.58 m 娜依达 vs 1.62 m 莉拉 for
 * swords, 1.72 m 泰拉 vs 1.86 m 伊格纳 for claymores, …) and judged on the worse
 * of the two, on three numbers:
 *
 *   - `clearance` — lowest weapon vertex above the soles. The shipped numbers were
 *     **−0.010 m** for 莉拉's sword, **−0.066 m** for 伊格纳's claymore and
 *     **0.000 m** for 凯伦's bow: the tip was in the dirt, or under it.
 *   - `pierce` — weapon vertices inside the body capsules (thighs, shins, torso,
 *     head). Shipped: 7.7% of the sword, **53.8%** of the claymore, **61.6%** of
 *     the bow.
 *   - `gap` — distance from the nearest vertex to the body *surface*, for the
 *     stowed poses only: a scabbard has to touch the back, and a large positive
 *     gap is a weapon floating behind someone.
 *
 * The key finding was that rotation alone cannot fix a held pose. Lifting the tip
 * off the floor by rolling the wrist swings the blade into the near thigh — the
 * best rotation-only sword candidate that cleared the soles still had 42% of its
 * vertices inside the leg. The grip has to move *out* from the palm as well, so
 * every held entry now carries a small `pos`.
 */
const ATTACH = {
  // Held out and forward at ~65° off the arm line, offset 8 cm outboard of the
  // palm: 0.0% pierce, tip 0.47 m above the soles, grip still 0.11 m from the
  // hand bone so it reads as gripped rather than magnetically trailing.
  sword:    { slot: 'weaponSlot', rot: [2.00, 0, 0.55], pos: [0.08, 0, 0.06] },
  // Same idea, further out and yawed away from the hip — a 0.76 m slab needs the
  // room. 1.9% pierce (a rivet clipping the glove), clearance 0.34 m.
  claymore: { slot: 'weaponSlot', rot: [2.15, -0.20, 0.40], pos: [0.10, 0.04, 0.08] },
  // A polearm cannot hang: gripped 40% up a 2.7 m shaft, blade-down puts the head
  // through the floor. Held head-up and forward instead — 1.1% / 0.49 m.
  polearm:  { slot: 'weaponSlot', rot: [1.35, 0, 0.20], pos: [0.08, 0, 0.01] },
  // The bow's limb plane has to stay vertical with the string toward the archer,
  // so the yaw is a half turn and the only freedom is the roll that keeps the
  // lower limb clear of the leg. Rolled to 1.20 rad it carries across the hips:
  // 4.6% / 0.36 m, against 61.6% / 0.000 m for the near-vertical shipped pose.
  bow:      { slot: 'offhandSlot', rot: [0.20, 2.94, 1.20], pos: [0.04, 0, 0.08] },
  // Catalysts float outboard of the offhand rather than being gripped, which is
  // why this one needed no change: 0.0% pierce, 0.43 m clearance as authored.
  catalyst: { slot: 'offhandSlot', rot: [0, -0.5, 0], pos: [-0.10, 0.04, 0.13] },
};

/**
 * Sheathed/stowed transforms — the pose a character is in whenever nobody is
 * fighting, which is most of the time (see `_driveSheath` in game/actors.js).
 *
 * Everything goes on the back, including the sword. The hip carry it used to have
 * had never been rendered and does not survive being looked at: 41.0% of the
 * blade's vertices were inside 莉拉's own torso and left thigh, and the whole
 * weapon photographed as a single gold speck at her waist. On the back the same
 * sword reads as a sword from every angle, at 0.0% pierce and a 0.009 m gap.
 */
const STOW = {
  sword:    { slot: 'backSlot', rot: [0.28, 0.10, -0.62], pos: [0.06, -0.10, -0.07] },
  claymore: { slot: 'backSlot', rot: [0.24, 0.08, -0.40], pos: [0.08, -0.16, -0.10] },
  polearm:  { slot: 'backSlot', rot: [0.20, 0.06, -0.55], pos: [0.02, 0.10, -0.05] },
  bow:      { slot: 'backSlot', rot: [0.22, Math.PI, 0.85], pos: [-0.05, 0, -0.09] },
  catalyst: { slot: 'backSlot', rot: [0.20, 0.40, 0], pos: [0, -0.02, -0.11] },
};

/** Resolve a weapon id or a loose `{type, rarity, element}` spec. */
export function weaponSpec(idOrSpec) {
  if (typeof idOrSpec === 'string') {
    const w = WEAPONS[idOrSpec];
    if (w) return { id: w.id, type: w.type, rarity: w.rarity, name: w.name };
    // A bare type also works, so a character can be drawn before it has a weapon.
    if (BUILDERS[idOrSpec]) return { id: null, type: idOrSpec, rarity: 3, name: idOrSpec };
    return { id: null, type: 'sword', rarity: 3, name: idOrSpec };
  }
  return { id: null, rarity: 3, type: 'sword', ...idOrSpec };
}

/**
 * Build a standalone weapon model. The grip sits at the origin with the weapon
 * pointing along +Y, so it can be dropped into a hand slot or stood upright in
 * an inventory preview without extra bookkeeping.
 */
export function buildWeapon(idOrSpec, opts = {}) {
  const spec = weaponSpec(idOrSpec);
  const M = materialsFor(spec);
  const group = BUILDERS[spec.type](spec, M);
  group.userData.spec = spec;
  group.userData.materials = M;
  if (opts.outline !== false) addOutline(group, opts.outlineColor ?? 0x14121c, opts.outlineWidth ?? 1.5);
  if (opts.element) {
    const e = ELEMENTS[opts.element];
    if (e) setAura(group, e.glow, spec.rarity >= 5 ? 0.35 : 0.2);
  }
  return group;
}

/**
 * Attach a weapon to a rig from `buildHumanoid`. Returns a handle that can be
 * sheathed, animated (catalyst rings, elemental glow pulse) and disposed.
 */
export function attachWeapon(rig, idOrSpec, opts = {}) {
  const spec = weaponSpec(idOrSpec);
  const group = buildWeapon(spec, opts);
  const a = ATTACH[spec.type], s = STOW[spec.type];
  const orbit = group.getObjectByName('orbit');
  // Scale with the character: a 1.86 m fighter holding the same 0.86 m sword as
  // a 1.60 m one looks like they borrowed it.
  const k = (rig.height ?? 1.7) / 1.72;
  group.scale.setScalar(k);

  const place = (cfg) => {
    const slot = rig[cfg.slot] ?? rig.weaponSlot;
    slot.add(group);
    group.position.set(cfg.pos[0] * k, cfg.pos[1] * k, cfg.pos[2] * k);
    group.rotation.set(cfg.rot[0], cfg.rot[1], cfg.rot[2]);
  };
  place(opts.sheathed ? s : a);

  return {
    group, spec,
    sheathed: !!opts.sheathed,
    setSheathed(v) {
      if (this.sheathed === !!v) return;
      this.sheathed = !!v;
      place(v ? s : a);
    },
    update(dt, t) {
      if (!orbit) return;
      for (const ring of orbit.children) ring.rotation.z += ring.userData.spin * dt;
      orbit.position.y = Math.sin(t * 1.6) * 0.012;
    },
    dispose() {
      group.removeFromParent();
      group.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
    },
  };
}

export { BUILDERS as WEAPON_BUILDERS };
