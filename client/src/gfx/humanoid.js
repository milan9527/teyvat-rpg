// Procedural rigged humanoid builder.
//
// Builds a real skinned mesh with a 22-bone skeleton from the `body` recipe on each
// character definition. Everything (silhouette, hair, cape, skirt, armour) is
// generated geometry — no external model files, which is what lets the whole game
// ship as source.
//
// Rig layout (all names stable, used by the animator):
//   root > hips > spine > chest > neck > head
//                        chest > shoulderL > armL > forearmL > handL
//                        chest > shoulderR > armR > forearmR > handR
//                 hips  > thighL > shinL > footL
//                 hips  > thighR > shinR > footR

import * as THREE from 'three';
import { bakeSkinned } from './skin.js';
import { skinMaterial, hairMaterial, clothMaterial, metalMaterial, eyeMaterial, glowMaterial, addOutline, setRigOcclusion, IRIS_LID_SHADE } from './toon.js';

/* --------------------------------------------------------------- primitives -- */

/** A tapered, slightly curved limb segment — nicer silhouette than a cylinder. */
function limbGeo(len, rTop, rBot, bend = 0, seg = 8, radial = 10) {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, radial, seg, false);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const t = (y + len / 2) / len;          // 0 bottom .. 1 top
    // Slight S-curve and a taper easing so joints read organically.
    const ease = Math.sin(t * Math.PI) * 0.06;
    p.setX(i, p.getX(i) * (1 + ease));
    p.setZ(i, p.getZ(i) * (1 + ease) + Math.sin(t * Math.PI) * bend);
  }
  g.computeVertexNormals();
  g.translate(0, len / 2, 0);              // origin at the joint
  return g;
}

/**
 * Torso half-width at normalised height t (0 = hip, 1 = shoulder): hips → waist
 * pinch → chest flare → shoulders, with a slight chest volume bump.
 */
function torsoProfile(t, shoulderW, waistW, depth, build) {
  const waist = 0.82 - 0.1 * (1 - build);
  const w = t < 0.42
    ? THREE.MathUtils.lerp(waistW * 1.06, waistW * waist, t / 0.42)
    : THREE.MathUtils.lerp(waistW * waist, shoulderW, (t - 0.42) / 0.58);
  const chest = Math.exp(-Math.pow((t - 0.72) / 0.2, 2)) * 0.06 * (1 - build * 0.5);
  // Round the shoulder line off rather than ending on a hard rim. The divisor is
  // barely above the 0.1 span so the closing cap at t = 1 is small enough to hide
  // under the collar instead of showing as a flat plate across the shoulders.
  const cap = t > 0.9 ? Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.9) / 0.103, 2))) : 1;
  return { w: w * cap, d: w * depth * (1 + chest) * cap };
}

/**
 * A closed band of the torso covering normalised heights t0..t1. Splitting the
 * torso into bands is how garments are made (lower band = trousers/skirt base,
 * upper band = jacket): a separate overlay volume would show its own cap as a
 * flared rim at the shoulders.
 *
 * Y=0 in the returned geometry is the hip line, so every band shares one origin.
 */
/**
 * Front-facing Z of the torso surface at normalised height `t` and lateral offset
 * `x`. Chest-mounted pieces (the elemental emblem) are placed with this so they
 * sit *on* the jacket instead of half inside it.
 */
function torsoFrontZ(P, t, x) {
  const { w, d } = torsoProfile(t, P.shoulderW, P.waistW, 0.68, P.build);
  const k = Math.min(1, Math.abs(x) / Math.max(w, 1e-6));
  return d * Math.sqrt(Math.max(0, 1 - k * k));
}

function torsoGeo(h, shoulderW, waistW, depth, build, t0 = 0, t1 = 1) {
  const span = h * (t1 - t0);
  const rings = Math.max(3, Math.round(14 * (t1 - t0)));
  const g = new THREE.CylinderGeometry(1, 1, span, 20, rings, false);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = THREE.MathUtils.lerp(t0, t1, (p.getY(i) + span / 2) / span);
    const { w, d } = torsoProfile(t, shoulderW, waistW, depth, build);
    p.setX(i, p.getX(i) * w);
    p.setZ(i, p.getZ(i) * d);
    // Flatten the back slightly, round the front.
    if (p.getZ(i) < 0) p.setZ(i, p.getZ(i) * 0.82);
  }
  g.computeVertexNormals();
  g.translate(0, span / 2 + h * t0, 0);
  return g;
}

/**
 * Head silhouette as a function of normalised height (-1 chin .. +1 crown).
 * Kept as a standalone function because the hair caps and every face feature are
 * positioned against it — if the head shape and the placement maths disagree,
 * eyes end up buried inside the skull.
 */
const headTaper = (ny) => (ny < 0 ? 1 + ny * 0.40 : 1 - Math.max(0, ny - 0.62) * 0.22);
const FACE_FLATTEN = 0.94;      // front of the head is slightly flat

/** Stylised head: rounded skull, tapered chin, flat-ish face plane for features. */
function headGeo(r, inflate = 1, opts = {}) {
  const { widthSeg = 24, heightSeg = 20, phiStart = 0, phiLength = Math.PI * 2, thetaStart = 0, thetaLength = Math.PI } = opts;
  const g = new THREE.SphereGeometry(r, widthSeg, heightSeg, phiStart, phiLength, thetaStart, thetaLength);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = headTaper(y / r) * inflate;
    p.setXYZ(i, x * t, y * inflate, z * t * (z > 0 ? FACE_FLATTEN : 1.02));
  }
  g.computeVertexNormals();
  return g;
}

/**
 * A point on the head surface. `yaw`/`pitch` are radians from straight ahead
 * (pitch +) is up; `out` > 1 lifts the point off the skin.
 */
function surfacePoint(R, yaw, pitch, out = 1) {
  const ny = Math.sin(pitch);
  const t = headTaper(ny);
  const cp = Math.cos(pitch);
  return new THREE.Vector3(
    R * t * Math.sin(yaw) * cp * out,
    R * ny * out,
    R * t * FACE_FLATTEN * Math.cos(yaw) * cp * out,
  );
}

/**
 * Transform for a feature lying flush on the head surface, with its local +Z
 * pointing outward — used for the painted-on details (eyes, brows, mouth) that
 * would otherwise sink into the skull.
 */
function faceAt(R, yaw, pitch, out = 1, sx = 1, sy = 1, sz = 1, roll = 0) {
  return M4().compose(
    surfacePoint(R, yaw, pitch, out),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, yaw, roll, 'YXZ')),
    new THREE.Vector3(sx, sy, sz),
  );
}

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);

/**
 * Transform for a Y-axis primitive of height `|b - a|` stretched from `a` to `b`,
 * with its +Y end at `b`. Cones therefore taper toward `b`, which is how hair
 * strands are laid along the skull instead of being poked through it.
 */
function spanMat(a, b, twist = 0, sx = 1, sz = 1) {
  const dir = b.clone().sub(a);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  if (twist) q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, twist));
  return M4().compose(
    a.clone().addScaledVector(dir, 0.5), q, new THREE.Vector3(sx, 1, sz),
  );
}

function sphere(r, seg = 12) { return new THREE.SphereGeometry(r, seg, Math.max(6, seg - 4)); }

const lumOf = (c) => c.r * 0.299 + c.g * 0.587 + c.b * 0.114;

/**
 * Distance between two colours in sRGB bytes — the space the player's screen is in.
 *
 * Linear luminance was the wrong ruler for this job in both directions: it calls a
 * near-black cape and near-black hair 0.01 apart (they are 20 bytes apart, subtle
 * but visible) and it calls two near-whites 0.02 apart when they are 60 (obviously
 * different). It also ignores hue, and a cream shirt on tan skin is exactly the case
 * where hue is doing the work.
 */
const colDist = (a, b) => Math.hypot(
  (a >> 16 & 255) - (b >> 16 & 255), (a >> 8 & 255) - (b >> 8 & 255), (a & 255) - (b & 255),
);

/**
 * Push a garment colour away from the colours it touches.
 *
 * Nothing draws an outline *inside* a silhouette, so wherever two of a character's
 * surfaces meet, the only thing holding the boundary together is the difference
 * between their albedos. Two places on this body need the help:
 *
 *   - cloth sheets (capes, veils, wings) are the largest flat areas on a character
 *     and they hang directly behind the hair, so a near-white sheet on a white-haired
 *     design merges into the head and the character reads as headless from behind;
 *   - the jacket meets bare skin at the collar, at both elbows and — with a skirt —
 *     at the thighs, so a cream shirt on a tan villager reads as a bare chest.
 *     `NPC_PALETTE` entries 0 and 1 (the shirts on every Mondstadt villager) sat 30
 *     and 39 bytes from their own skin; `tools/npc-cam.mjs` photographs the elbow.
 *
 * `refs` is a list of [hex, minimum distance] pairs that must *all* hold, solved
 * together rather than one after another: sequential pushes oscillate when two
 * references box the colour in from both sides (NPC palette 4 has skin at 0.55 and
 * hair at 0.20 luminance). The answer is the nearest brightness scale that clears
 * every reference — darker preferred, since there is no headroom above white and a
 * darker garment reads as a dye or a lining, both plausible. When no scale clears
 * them all, references are dropped from the *end* of the list, which is why callers
 * pass skin first: a near-black cape on near-black hair (ignar) cannot be separated
 * by brightness at all, and the jacket/skin boundary is the larger one to lose.
 */
function separateFrom(colorHex, refs) {
  const c = new THREE.Color(colorHex);
  for (let n = refs.length; n > 0; n--) {
    const use = refs.slice(0, n);
    const clear = (hex) => use.every(([ref, min]) => colDist(hex, ref) >= min);
    if (clear(c.getHex())) return c.getHex();
    let best = null;
    // Scales rather than target luminances: a scale keeps the hue and the saturation
    // the design chose, and the sRGB curve makes the byte distance a non-monotonic
    // function of it in the dark end, so this is a search and not a formula.
    for (let i = 0; i <= 63; i++) {
      const s = 0.25 + i * 0.05;
      const hex = c.clone().multiplyScalar(s).getHex();
      if (!clear(hex)) continue;
      const rank = [s < 1 ? 0 : 1, Math.abs(s - 1)];
      if (!best || rank[0] < best.rank[0]
        || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) best = { hex, rank };
    }
    if (best) return best.hex;
  }
  return c.getHex();
}

// How far a garment has to sit from the skin under it, and from the hair behind it,
// in sRGB bytes. Both are measurements, not preferences: of the five NPC palettes the
// two that read as bare skin in a screenshot are 30 and 39 bytes from their own skin
// and the three that read as clothed are 52, 69 and 73, so 48 splits them while
// leaving every authored character's design alone except aurel's cream-on-cream
// trousers (18). Hair wants more because a cape behind hair has no trim, no belt and
// no hue difference to help it — only value.
const SKIN_GAP = 48;
const HAIR_GAP = 60;

/**
 * A second, offset hair tone.
 * Alternating two tones across the strands of a mass is what makes long hair read
 * as *locks*. With a single colour the strand boundaries are only visible where
 * the smooth normal field happens to bend, so from any distance the whole mass
 * collapses into one solid slab — worst on the pale colours, where the cel ramp
 * has almost no range left to work in. Near-black hair is lightened instead of
 * darkened for the same reason in the other direction.
 */
function hairTone(colorHex, amt = 0.22) {
  const c = new THREE.Color(colorHex);
  // Only true near-black gets lightened, and gently: hairMaterial gives dark hair
  // a full-strength rim (it scales the rim down by luminance), so a lightened
  // strand on a black head blows out to a white streak and reads as a mistake.
  return lumOf(c) > 0.15
    ? c.multiplyScalar(1 - amt).getHex()
    : c.lerp(new THREE.Color(0xffffff), amt * 0.42).getHex();
}

/* --------------------------------------------------------------------- hair -- */

/**
 * The fringe as one continuous sheet laid on the forehead, with a scalloped hem.
 *
 * The locks alone cannot do this job, and the measurement says so: nine tapered wedges
 * spaced 0.23 rad apart cover **43.2 %** of the band between the front cap's lower edge
 * and the brow line, in 29 separate gaps totalling 183 grid cells — a comb, with the
 * forehead showing through between its teeth. Widening the wedges until they overlap at
 * the tips would weld the fringe into one paddle, so the coverage belongs to a surface and
 * the silhouette belongs to the locks that hang over it.
 *
 * Authored in head space off `surfacePoint`, so it inherits the skull's taper and its flat
 * face plane rather than floating off a sphere of its own. Two shells (an outer skin and an
 * inner one a hair's breadth further in) joined along the hem and both side edges: a single
 * sheet is invisible from below, where a camera looking up at a face sees its back faces.
 */
function fringeSheet(r, opts = {}) {
  const {
    yawSpan = 1.02,           // a touch wider than the locks, to reach the sideburns
    top = 0.54,               // tucked under the front cap, which reaches down to pitch 0.41
    hem = 0.28,               // the hem sits just below the brow line (the brows are at 0.33)
    wave = 0.060, waves = 4,  // scallops, so the hem is not one drawn arc
    droop = 0.10,             // ...and hangs lower at the sides, framing the cheekbones
    cols = 22, rows = 4,
    outTop = 1.030, outHem = 1.085,   // the hem lifts off the skull: hair has volume
    thick = 0.030,
  } = opts;
  const hemAt = (u) => hem - wave * Math.cos(waves * 2 * Math.PI * u) - droop * (2 * u - 1) ** 2;
  const pos = [];
  const idx = [];
  const ring = (cols + 1) * (rows + 1);
  for (let shell = 0; shell < 2; shell++) {
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      for (let i = 0; i <= cols; i++) {
        const u = i / cols;
        const yaw = (u * 2 - 1) * yawSpan;
        const pitch = top + (hemAt(u) - top) * t;
        const out = (outTop + (outHem - outTop) * t) - shell * thick;
        const p = surfacePoint(r, yaw, pitch, out);
        pos.push(p.x, p.y, p.z);
      }
    }
  }
  const at = (shell, j, i) => shell * ring + j * (cols + 1) + i;
  for (let shell = 0; shell < 2; shell++) {
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = at(shell, j, i), b = at(shell, j, i + 1), c = at(shell, j + 1, i + 1), d = at(shell, j + 1, i);
        // The inner shell is wound the other way so both sets of normals face outward.
        if (shell === 0) idx.push(a, d, c, a, c, b);
        else idx.push(a, c, d, a, b, c);
      }
    }
  }
  // Rim along the hem, and down both side edges, so the sheet reads as a solid with an edge
  // instead of a pair of surfaces with a gap between them.
  for (let i = 0; i < cols; i++) {
    const o0 = at(0, rows, i), o1 = at(0, rows, i + 1), i0 = at(1, rows, i), i1 = at(1, rows, i + 1);
    idx.push(o0, i0, i1, o0, i1, o1);
  }
  for (const [i, flip] of [[0, true], [cols, false]]) {
    for (let j = 0; j < rows; j++) {
      const o0 = at(0, j, i), o1 = at(0, j + 1, i), n0 = at(1, j, i), n1 = at(1, j + 1, i);
      if (flip) idx.push(o0, o1, n1, o0, n1, n0);
      else idx.push(o0, n1, o1, o0, n0, n1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Emit the hair as bake-ready part descriptors laid out in *head* space. Long
 * masses are driven by the springy hair bones so they lag behind head turns;
 * the skull cap and tight styles ride the head rigidly.
 *
 * `matA`/`matB` are the two hair tones; every emitter takes an optional trailing
 * material so a loop can alternate them (see `hairTone`).
 */
function buildHair(style, r, matA, matTie, matB = matA) {
  const out = [];
  // Alternate tone by loop index — the whole point of matB.
  const alt = (i) => (i % 2 ? matB : matA);
  // `bone` drives the vertices, `parentBone: 'head'` is the space we author in.
  const hp = (geo, bone, x, y, z, rx = 0, ry = 0, rz = 0, mat = matA) =>
    out.push({ geo, mat, bone, parentBone: 'head', matrix: trs(x, y, z, rx, ry, rz) });

  // Skull cap in two pieces, slightly inflated so it sits over the scalp. The
  // lower piece has a wedge cut out of the front — that opening is the face, and
  // it is what stops the hair from swallowing the eyes.
  // Both pieces are built with headGeo so they inherit the skull's chin taper —
  // a plain sphere of the same radius flares out past the jaw and reads as a
  // helmet rather than hair.
  const FACE_WEDGE = 1.45;                      // radians of open face
  hp(headGeo(r, 1.055, { widthSeg: 26, heightSeg: 16, thetaLength: Math.PI * 0.37 }),
    'head', 0, r * 0.03, 0);
  hp(headGeo(r, 1.055, {
    widthSeg: 24, heightSeg: 14,
    phiStart: Math.PI * 0.5 + FACE_WEDGE * 0.5, phiLength: Math.PI * 2 - FACE_WEDGE,
    thetaStart: Math.PI * 0.26, thetaLength: Math.PI * 0.46,
  }), 'head', 0, r * 0.03, 0);

  const hpm = (geo, bone, matrix, mat = matA) => out.push({ geo, mat, bone, parentBone: 'head', matrix });
  // The sheet carries the coverage; the locks laid over it carry the silhouette. Splitting
  // the two jobs is the whole fix: the locks used to be responsible for both and could do
  // neither — nine of them spaced evenly left 29 gaps of bare forehead between their tips
  // (43.2 % of the band covered), and once they were wide enough to close those gaps they
  // welded into one paddle.
  hpm(fringeSheet(r), 'hairFront', trs(0, 0, 0));
  // Authored clumps, not an even fan: lateral position, width scale, tip pitch, tip yaw
  // skew. An even fan of equal-length wedges photographs as corrugation — the eye reads
  // the repeat before it reads the hair — so the widths run 0.8..1.25 and the points sit
  // at six different heights, with the longest ones at the sides framing the cheekbones.
  const LOCKS = [
    [-0.98, 1.00, 0.02, -0.05], [-0.74, 1.25, 0.20, 0.03], [-0.50, 0.82, 0.07, -0.04],
    [-0.24, 1.12, 0.26, 0.05], [0.02, 0.86, 0.13, -0.06], [0.28, 1.22, 0.24, 0.04],
    [0.54, 0.84, 0.05, -0.03], [0.78, 1.08, 0.18, 0.04], [0.98, 0.95, 0.01, -0.05],
  ];
  LOCKS.forEach(([t, ws, tipPitch, skew], i) => {
    const yaw = t * 0.92;
    // Bases tuck up under the skull cap. `out` < 1 on purpose: the lock is a cylinder, so a
    // top placed *on* the cap surface pokes its end disc back out through it and the crown
    // ends up ringed with little rectangular tabs, like a paper crown. The strand then
    // grazes out through the sheet around mid-forehead, which is where it earns its volume.
    const top = surfacePoint(r, yaw, 0.80 - Math.abs(t) * 0.06, 0.99);
    const tip = surfacePoint(r, yaw * 1.18 + skew, tipPitch, 1.12 + (1 - ws) * 0.02);
    const w = r * 0.17 * ws * (1 - Math.abs(t) * 0.10);
    // Very nearly a cone: a blunt tip is a flat disc pointing at the viewer, and a row of
    // them photographs as a crown of bright cannon barrels. Nothing needs the blunt end any
    // more now that the sheet behind carries the coverage the wide wedges used to owe.
    hpm(new THREE.CylinderGeometry(w * 0.05, w, tip.distanceTo(top), 6, 1), 'hairFront',
      spanMat(top, tip, -t * 0.4, 1.25, 0.45), alt(i));
  });
  // Sideburn locks framing the cheeks — cheap, and a big readability win.
  for (const sgn of [-1, 1]) {
    const top = surfacePoint(r, sgn * 1.02, 0.34, 1.07);
    const tip = surfacePoint(r, sgn * 1.10, -0.95, 1.12);
    hpm(new THREE.ConeGeometry(r * 0.19, tip.distanceTo(top), 7, 1), 'hairFront',
      spanMat(top, tip, 0, 1.0, 0.62));
  }

  // Back locks laid over the skull cap. Without them a bare cap is one smooth
  // dome, and on the pale hair colours there is nearly no shading gradient across
  // it — the character reads as bald from behind whatever style is fitted.
  const lockCount = 7;
  for (let i = 0; i < lockCount; i++) {
    const t = (i / (lockCount - 1)) * 2 - 1;
    const yaw = Math.PI + t * 1.12;
    // Tucked *under* the cap (see the fringe note above). The back skull sits
    // further out than surfacePoint reports — it applies the front flatten factor
    // at every yaw — so ~1.14 is the surface here and anything below that is
    // buried, which is where a flat-capped lock end belongs.
    const top = surfacePoint(r, yaw, 0.88, 1.03);
    const tip = surfacePoint(r, yaw, -0.26 - Math.abs(t) * 0.12, 1.17);
    const w = r * 0.23 * (1 - Math.abs(t) * 0.16);
    hpm(new THREE.CylinderGeometry(w * 0.42, w, tip.distanceTo(top), 6, 1), 'head',
      spanMat(top, tip, 0, 1.15, 0.52), alt(i));
  }

  // `bend` is an absolute Z bulge in metres, so it has to be kept in scale with
  // the head: at 0.2 on a head-sized strand the "wave" becomes a 20 cm hook.
  const strand = (len, rad, bend) => limbGeo(len, rad, rad * 0.28, bend, 8, 8);
  const tie = (rad, x, y, z) => out.push({
    geo: sphere(rad, 10), mat: matTie, bone: 'head', parentBone: 'head', matrix: trs(x, y, z),
  });
  /**
   * Place a base-origin +Y primitive (anything from `strand`) pointing along `dir`.
   * Tails are aimed with this rather than with Euler angles: composing a ~PI pitch
   * with a lateral roll under XYZ order sends them off sideways and upward, which
   * is exactly how twin tails end up looking like antennae.
   */
  // `strand` puts its *thick* end at +Y — every Euler-angle caller flips by ~PI,
  // which is what brings the thick end back down to the origin. Aiming +Y straight
  // at `dir` would skip that flip and hand the tail a paddle: pin-thin at the tie,
  // fattest at the tip. So pre-flip the geometry and aim -Y at `dir` instead.
  const DOWN = new THREE.Vector3(0, -1, 0);
  const hang = (geo, bone, base, dir, mat = matA) => hpm(geo.rotateX(Math.PI), bone, M4().compose(
    base, new THREE.Quaternion().setFromUnitVectors(DOWN, dir.clone().normalize()),
    new THREE.Vector3(1, 1, 1),
  ), mat);
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  switch (style) {
    // The long styles are pushed noticeably back (-0.8r .. -0.9r) so the mass
    // hangs *outside* a cape rather than between the cape and the spine, where it
    // would be completely hidden.
    //
    // Watch the X rotation: `strand` grows along +Y, so a rotation of exactly PI
    // hangs it straight down and anything *short* of PI swings the tip FORWARD,
    // into the chest. Back hair therefore wants PI + k, never PI - k.
    case 'longWave': {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const side = Math.cos(a) < 0 ? 'hairBackL' : 'hairBackR';
        // Alternating tone *and* alternating length: two identical-length rows of
        // strands still end in one flat hem, which is the other half of why a long
        // mass looks like a cut sheet of card.
        hp(strand(r * (i % 2 ? 5.8 : 6.25), r * 0.32, 0.10), side,
          Math.cos(a) * r * 0.80, r * 0.28, Math.sin(a) * r * 0.45 - r * 0.80,
          Math.PI + 0.13 + Math.sin(a) * 0.10, 0, Math.cos(a) * 0.16, alt(i));
      }
      break;
    }
    case 'longStraight': {
      for (let i = 0; i < 9; i++) {
        const a = -Math.PI * 0.15 + (i / 8) * Math.PI * 1.3;
        const side = Math.cos(a) < 0 ? 'hairBackL' : 'hairBackR';
        hp(strand(r * (i % 2 ? 6.7 : 7.25), r * 0.28, 0.02), side,
          Math.cos(a) * r * 0.82, r * 0.26, Math.sin(a) * r * 0.40 - r * 0.85,
          Math.PI + 0.07, 0, Math.cos(a) * 0.1, alt(i));
      }
      break;
    }
    case 'ponytail': {
      tie(r * 0.21, 0, r * 0.40, -r * 1.02);
      // Gathered high on the back of the skull. One long strand aimed backwards
      // reads as a plank growing out of the skull, so the tail is a bundle of
      // four: the top strands kick back off the tie, the lower ones fall nearly
      // straight down. That length-and-angle spread is what gives hair weight.
      const TAIL = [
        [3.4, 0.00, -0.88, -0.47, 0.31],
        [2.9, 0.20, -0.94, -0.29, 0.25],
        [2.5, -0.18, -0.95, -0.26, 0.21],
        [1.9, 0.05, -0.99, -0.12, 0.17],
      ];
      TAIL.forEach(([len, dx, dy, dz, rad], i) => {
        hang(strand(r * len, r * rad, -r * 0.38), 'hairTail',
          V3(dx * r * 0.34, r * (0.42 - i * 0.03), -r * (1.02 - i * 0.05)),
          V3(dx, dy, dz), alt(i));
      });
      break;
    }
    case 'twinTail': {
      for (const sgn of [-1, 1]) {
        const bone = sgn < 0 ? 'hairBackL' : 'hairBackR';
        tie(r * 0.24, sgn * r * 0.86, r * 0.42, -r * 0.34);
        hang(strand(r * 4.4, r * 0.32, -r * 0.35), bone,
          V3(sgn * r * 0.90, r * 0.40, -r * 0.38), V3(sgn * 0.40, -0.86, -0.32));
        // Under-strand in the second tone: one cone per side reads as a horn.
        hang(strand(r * 3.2, r * 0.21, -r * 0.26), bone,
          V3(sgn * r * 0.80, r * 0.34, -r * 0.46), V3(sgn * 0.22, -0.93, -0.30), matB);
      }
      break;
    }
    case 'bun': {
      hp(sphere(r * 0.62, 14), 'head', 0, r * 0.92, -r * 0.42);
      out.push({
        geo: new THREE.CylinderGeometry(r * 0.04, r * 0.04, r * 1.5, 6), mat: matTie,
        bone: 'head', parentBone: 'head', matrix: trs(0, r * 0.95, -r * 0.42, 0, 0, 0.9),
      });
      // A couple of loose framing strands so a bun still reads as hair in profile.
      for (const sgn of [-1, 1]) {
        hp(strand(r * 1.9, r * 0.16, 0.06), sgn < 0 ? 'hairBackL' : 'hairBackR',
          sgn * r * 0.84, r * 0.22, r * 0.28, Math.PI - 0.08, 0, sgn * 0.16, matB);
      }
      break;
    }
    case 'spiky': {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        // Deterministic per-index variation — random() here would make every
        // character rebuild look different.
        const up = 0.5 + ((i * 37) % 11) / 11 * 0.5;
        // The front spikes have to stand up instead of out: leaning a 0.23 m cone forward
        // over the face put a quarter of 沃特's own iris behind his hair (55 of 226 cells,
        // upper-outer on both eyes, measured straight from the front). So the forward half
        // is shorter, thinner and raised, and it keeps far more of its lean.
        const fwd = Math.max(0, Math.sin(a));
        hp(new THREE.ConeGeometry(r * 0.2 * (1 - 0.22 * fwd), r * (1.1 + up * 0.7) * (1 - 0.45 * fwd), 5), 'head',
          Math.cos(a) * r * 0.62, r * (0.72 + 0.12 * fwd), Math.sin(a) * r * 0.6,
          -Math.sin(a) * (0.7 - 0.58 * fwd) + 0.1, 0, Math.cos(a) * 0.7, alt(i));
      }
      break;
    }
    case 'short':
    default: {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        hp(strand(r * 1.15, r * 0.26, 0.05), 'head',
          Math.cos(a) * r * 0.8, r * 0.3, Math.sin(a) * r * 0.72,
          Math.PI - 0.2, 0, Math.cos(a) * 0.2, alt(i));
      }
      break;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- skeleton --- */

const BONES = [
  ['root', null], ['hips', 'root'], ['spine', 'hips'], ['chest', 'spine'],
  ['neck', 'chest'], ['head', 'neck'],
  ['shoulderL', 'chest'], ['armL', 'shoulderL'], ['forearmL', 'armL'], ['handL', 'forearmL'],
  ['shoulderR', 'chest'], ['armR', 'shoulderR'], ['forearmR', 'armR'], ['handR', 'forearmR'],
  ['thighL', 'hips'], ['shinL', 'thighL'], ['footL', 'shinL'],
  ['thighR', 'hips'], ['shinR', 'thighR'], ['footR', 'shinR'],
  ['capeA', 'chest'], ['capeB', 'capeA'],
  // Hair is skinned to its own bones so strands get secondary motion without
  // costing extra draw calls.
  ['hairFront', 'head'], ['hairBackL', 'head'], ['hairBackR', 'head'], ['hairTail', 'head'],
];

/** Bones the animator drives with lagged/springy motion rather than keyframes. */
export const SECONDARY_BONES = ['capeA', 'capeB', 'hairFront', 'hairBackL', 'hairBackR', 'hairTail'];

/**
 * Fallbacks for a body recipe that is missing fields. Deliberately drab: this is what an
 * incomplete content entry looks like, and it should be recognisable as unfinished
 * rather than pass for a design.
 */
const DEFAULT_BODY = {
  height: 1.68, build: 0.4, hair: 'short', skin: 0xecc9a6, hairColor: 0x4a3a2c,
  hairTip: 0x4a3a2c, primary: 0x6e6a62, secondary: 0xc4bfb4, accent: 0x9aa0a8,
  eye: 0x4a5a66, boots: 0x33302a, cape: null, skirt: 0,
};

/**
 * Coerce a body field to a usable number.
 *
 * Every length in `proportions` is a multiple of `height`, and every width is a function
 * of `build`, so one non-numeric field poisons the entire skeleton: `1.7 * undefined` is
 * NaN, NaN propagates into every bone matrix and every skinned vertex, and three's
 * bounding-sphere radius comes out NaN. A NaN radius fails every frustum test, so the
 * mesh is culled on every frame and the character is simply *absent* — no exception, no
 * console warning, nothing to debug. `tools/humanoid-check.mjs` caught exactly this for
 * `build: 'average'` (9555 NaN vertices) and a missing `height` (22596, i.e. all of them).
 *
 * Defaults rather than a thrown error, because the callers are content tables — a zone
 * with one malformed NPC should still open, with that villager at average build.
 */
function num(v, dflt, lo, hi) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Proportions derived from height + build, on a 7-head anime canon. The numbers
 * are chosen so they actually add up to `height`: crown = legLen + torsoH +
 * neckH + headR * 0.72 + headR, and head height (2 * headR) = height / 7.
 */
function proportions(body) {
  const h = num(body.height, 1.68, 0.6, 2.6);
  const build = num(body.build, 0.4, 0, 1);
  const headR = h * 0.0715;                 // head radius; 2R = one "head" = h/7
  const legLen = h * 0.50;                  // hip/crotch height
  const thigh = legLen * 0.52;
  const shin = legLen * 0.48;
  const torsoH = h * 0.32;                  // hip line -> shoulder line
  const neckH = h * 0.048;
  const armLen = h * 0.42;
  const upperArm = armLen * 0.47;
  const foreArm = armLen * 0.42;
  const shoulderW = h * (0.093 + build * 0.052);
  const waistW = h * (0.062 + build * 0.030);
  const limbR = h * (0.026 + build * 0.017);
  return { h, build, headR, legLen, thigh, shin, torsoH, neckH, armLen, upperArm, foreArm, shoulderW, waistW, limbR };
}

function makeSkeleton(P) {
  const bones = {};
  for (const [name, parent] of BONES) {
    const b = new THREE.Bone();
    b.name = name;
    bones[name] = b;
    if (parent) bones[parent].add(b);
  }
  const hipY = P.legLen;
  bones.root.position.set(0, 0, 0);
  bones.hips.position.set(0, hipY, 0);
  bones.spine.position.set(0, P.torsoH * 0.34, 0);
  bones.chest.position.set(0, P.torsoH * 0.40, 0);
  bones.neck.position.set(0, P.torsoH * 0.26, 0);
  bones.head.position.set(0, P.neckH + P.headR * 0.72, 0);

  for (const s of [-1, 1]) {
    const L = s < 0 ? 'L' : 'R';
    bones[`shoulder${L}`].position.set(s * P.shoulderW * 0.82, P.torsoH * 0.16, 0);
    bones[`arm${L}`].position.set(s * P.shoulderW * 0.30, 0, 0);
    bones[`forearm${L}`].position.set(0, -P.upperArm, 0);
    bones[`hand${L}`].position.set(0, -P.foreArm, 0);
    bones[`thigh${L}`].position.set(s * P.waistW * 0.46, 0, 0);
    bones[`shin${L}`].position.set(0, -P.thigh, 0);
    bones[`foot${L}`].position.set(0, -P.shin, 0);
    // Relaxed A-pose. Wide enough that the hands clear a flared skirt hem — at a
    // narrower spread they disappear inside it.
    bones[`arm${L}`].rotation.z = -s * 0.24;
    bones[`forearm${L}`].rotation.x = 0.06;
  }
  bones.capeA.position.set(0, P.torsoH * 0.2, -P.waistW * 0.5);
  bones.capeB.position.set(0, -P.torsoH * 0.55, 0);

  // Hair pivots sit where each mass actually hinges from the skull.
  bones.hairFront.position.set(0, P.headR * 0.62, P.headR * 0.55);
  bones.hairBackL.position.set(-P.headR * 0.55, P.headR * 0.40, -P.headR * 0.35);
  bones.hairBackR.position.set(P.headR * 0.55, P.headR * 0.40, -P.headR * 0.35);
  bones.hairTail.position.set(0, P.headR * 0.45, -P.headR * 0.80);

  // Resolve the rest pose. This has to happen *before* the Skeleton is created
  // (its constructor derives boneInverses from bone.matrixWorld) and before the
  // bone hierarchy is parented under the SkinnedMesh, so every matrix here is in
  // the character's own local space — the space the geometry is baked into.
  bones.root.updateMatrixWorld(true);

  const ordered = BONES.map(([n]) => bones[n]);
  const skeleton = new THREE.Skeleton(ordered);
  const bindWorld = {};
  for (const [n] of BONES) bindWorld[n] = bones[n].matrixWorld.clone();
  return { bones, skeleton, ordered, bindWorld };
}

/* ------------------------------------------------- skinned geometry assembly -- */
// Moved to skin.js so the enemy builders can bake their own rigs the same way.


const M4 = () => new THREE.Matrix4();
function trs(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return M4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

/**
 * Build a full character. Returns
 *   { group, skinned, skeleton, bones, parts:{hairGroup, weaponSlot, ...}, height }
 */
export function buildHumanoid(def, opts = {}) {
  // A def with no body at all used to throw on the first property read, and one with no
  // colours produced five `parameter 'color' has value of undefined` warnings and a
  // character in default-white MeshStandardMaterial. Content tables are hand-written and
  // one incomplete entry should cost a plain-looking villager, not the whole zone. Own
  // keys win, including an explicit `cape: null`.
  const body = { ...DEFAULT_BODY, ...(def?.body ?? {}) };
  const P = proportions(body);
  const { bones, skeleton, ordered, bindWorld } = makeSkeleton(P);
  const boneIndexOf = (name) => ordered.indexOf(bones[name]);

  const matSkin = skinMaterial(body.skin);
  const matHair = hairMaterial(body.hairColor, body.hairTip);
  const matHairB = hairMaterial(hairTone(body.hairColor), body.hairTip);
  // The primary colour is the trousers, the skirt and the trims; with a skirt on, the
  // thighs and shins under it are bare skin, and the cuffs sit on bare forearms.
  const primaryHex = separateFrom(body.primary, [[body.skin, SKIN_GAP]]);
  const matPrimary = clothMaterial(primaryHex);
  // The secondary colour is the jacket and both sleeves. It touches skin at the collar
  // and at both elbows, and on the pale-haired designs it is *also* near-white, so the
  // head merges into the shoulders and the character reads as headless from behind.
  // Skin first: see `separateFrom` on which reference gets dropped when they conflict.
  const secondaryHex = separateFrom(body.secondary, [[body.skin, SKIN_GAP], [body.hairColor, HAIR_GAP]]);
  const matSecondary = clothMaterial(secondaryHex);
  const matAccent = glowMaterial(body.accent, 0.5);
  const matBoots = clothMaterial(body.boots ?? 0x2a2a34, { roughness: 0.6 });
  // The iris carries a lid shadow of its own (IRIS_LID_SHADE). Measured at portrait size, the iris
  // owns ~9.5k px of a 700x700 frame and held *one value* — its median and its 95th percentile were
  // 0.1 counts apart. Nothing in the scene can shade it: the lens is 4 mm tall, the sun's shadow map
  // resolves 7.6 cm, and the lash bar above it is flat-shaded with no shadow of its own.
  const matEye = eyeMaterial(body.eye, 0.10, { partShade: IRIS_LID_SHADE });
  const matMetal = metalMaterial(0xbfc6d4);
  // Capes, veils and wings are single-sided sheets, so they need DoubleSide —
  // otherwise the inverted-hull shell is all you see from the back.
  const matSheet = clothMaterial(secondaryHex, { side: THREE.DoubleSide });
  const matSheetAccent = glowMaterial(body.accent, 0.5);
  matSheetAccent.side = THREE.DoubleSide;
  // Face details. Flat-shaded (1 band, no rim) so they read as painted-on
  // features instead of picking up their own highlights and shadows.
  // formShade is the other half of "flat": one band still leaves a continuous lean across the
  // band, and a pupil or a blush that shades by its own normal is exactly the highlight this
  // helper exists to suppress.
  const flat = (color, extra = {}) => clothMaterial(color, {
    bands: 1.0, rimStrength: 0.0, specStep: 1.1, roughness: 0.95, shadowTint: 0xbfc4d8,
    formShade: 0, ...extra,
  });
  const matWhite = flat(0xfbf9ff);
  const matPupil = flat(0x1d1a26);
  const matMouth = flat(new THREE.Color(body.skin).lerp(new THREE.Color(0x8d3a42), 0.62).getHex());
  const matBlush = flat(new THREE.Color(body.skin).lerp(new THREE.Color(0xff8f97), 0.45).getHex());
  // Brows are a shade darker than the hair so they stay visible under the fringe.
  const matBrow = flat(new THREE.Color(body.hairColor).multiplyScalar(0.45).getHex());
  const matNose = flat(new THREE.Color(body.skin).multiplyScalar(0.80).getHex());
  // The ear gets its own tone, a touch cooler than the cheek. That also gives face-check a
  // handle on it: inside one merged skin material an ear is indistinguishable from the skull.
  const matEar = flat(new THREE.Color(body.skin).multiplyScalar(0.94).getHex());

  const parts = [];
  const push = (geo, mat, bone, matrix, soft) => parts.push({ geo, mat, bone, matrix, ...soft });

  // --- torso ---------------------------------------------------------------
  // Two garment bands sharing one profile: hips→waist in the primary colour,
  // waist→shoulders in the secondary. The seam lands under the belt.
  const T = (t0, t1, extra = 0) =>
    torsoGeo(P.torsoH, P.shoulderW * (1 + extra), P.waistW * (1 + extra), 0.68, P.build, t0, t1);
  push(T(0, 0.46), matPrimary, 'hips', trs(0, 0, 0),
    { softBone: 'spine', softLen: P.torsoH * 0.46, softStart: 0.34, softMax: 0.5 });
  push(T(0.44, 1.0), matSecondary, 'spine', trs(0, -P.torsoH * 0.34, 0),
    // The jacket spans spine→chest, so it wants a long gradient: the shoulders
    // should follow the chest almost completely.
    { softBone: 'chest', softLen: P.torsoH, softStart: 0.46, softMax: 0.92 });
  // A thin collar closes off the neck opening and reads as a garment edge.
  push(new THREE.TorusGeometry(P.headR * 0.46, P.h * 0.010, 6, 18), matPrimary,
    'neck', trs(0, -P.neckH * 0.55, 0, Math.PI / 2, 0, 0));

  // Belt
  push(
    new THREE.TorusGeometry(P.waistW * 0.80, P.h * 0.014, 8, 22),
    matBoots, 'hips', trs(0, P.torsoH * 0.42, 0, Math.PI / 2, 0, 0),
  );
  // Buckle
  push(new THREE.BoxGeometry(P.h * 0.030, P.h * 0.026, P.h * 0.010), matMetal,
    'hips', trs(0, P.torsoH * 0.42, P.waistW * 0.62));

  // --- neck + head ---------------------------------------------------------
  push(limbGeo(P.neckH * 1.6, P.headR * 0.36, P.headR * 0.42, 0, 4, 8), matSkin, 'neck', trs(0, -P.neckH * 0.3, 0));
  push(headGeo(P.headR), matSkin, 'head', trs(0, 0, 0));

  // Face. Anime proportions: large almond eyes set slightly below the midline, a
  // heavy lash line, a dark socket ring that outlines the whole eye, and no real
  // nose. Everything is projected onto the head surface with faceAt() so nothing
  // sinks into the skull.
  const R = P.headR;
  const EYE_YAW = 0.44;         // ~25° off centre; wide enough to leave a nose bridge
  const EYE_PITCH = -0.07;
  const face = (geo, mat, ...a) => push(geo, mat, 'head', faceAt(R, ...a));
  for (const s of [-1, 1]) {
    const yaw = s * EYE_YAW;
    const tilt = -s * 0.13;     // outer corner lifted
    // The eye is a stack of flat lenses. Each layer sits a clear step further out
    // than the one behind it — with the layers packed tight the bigger lens behind
    // pokes through around the rim of the smaller one in front and the iris comes
    // out streaked.
    // Socket ring — a hair-dark lens a touch larger than the sclera. This is what
    // makes the eye read at distance; without it pale skin swallows the white.
    face(sphere(R * 0.245, 16), matPupil, yaw, EYE_PITCH, 0.940, 0.98, 1.22, 0.16, tilt);
    // Sclera, inset by the socket's line weight.
    face(sphere(R * 0.215, 16), matWhite, yaw, EYE_PITCH, 0.968, 0.98, 1.18, 0.15, tilt);
    // Iris: tall enough to nearly fill the opening, which is what separates an
    // anime eye from a cartoon googly one — only slivers of white are left.
    face(sphere(R * 0.175, 14), matEye, yaw, EYE_PITCH - 0.012, 1.002, 1.0, 1.42, 0.15, tilt);
    // Pupil.
    face(sphere(R * 0.075, 10), matPupil, yaw, EYE_PITCH - 0.012, 1.032, 1.0, 1.45, 0.13, tilt);
    // Catchlight, upper-outer — the classic anime glint.
    face(sphere(R * 0.046, 8), matWhite, yaw + s * 0.075, EYE_PITCH + 0.10, 1.055, 1.1, 1.0, 0.2);
    // Upper lash line: heavier than the socket ring and flicked outward.
    face(new THREE.BoxGeometry(R * 0.44, R * 0.075, R * 0.045), matPupil,
      yaw, EYE_PITCH + 0.155, 1.02, 1, 1, 1, tilt - s * 0.10);
    // Brow, thin and set well above the lid. Three overlapping segments along an arch
    // rather than one bar: a single box is a horizontal black rectangle at any angle,
    // which is the one shape a face never has. Each segment sits a little further out
    // in yaw, peaks in the middle, and thins toward the outer tail.
    for (let k = 0; k < 3; k++) {
      const u = k / 2;                                   // 0 inner (nose) .. 1 outer tail
      face(new THREE.BoxGeometry(R * 0.150 * (1 - 0.16 * u), R * 0.044 * (1 - 0.50 * u), R * 0.028),
        matBrow, yaw + s * (u - 0.5) * 0.24,
        EYE_PITCH + 0.40 + 0.030 * Math.sin(u * Math.PI),
        1.012, 1, 1, 1, tilt - s * 0.16 + s * (0.5 - u) * 0.22);
    }
    // Blush keeps the cheeks from reading flat.
    face(sphere(R * 0.16, 8), matBlush, s * 0.62, -0.30, 1.004, 1.0, 0.40, 0.10);
  }
  // Nose: a soft shadow dash, not a bump. A raised skin-material nose catches the
  // specular lobe and reads as a white bead at this scale.
  face(sphere(R * 0.055, 8), matNose, 0, -0.19, 1.008, 0.85, 0.55, 0.14);
  // Mouth: a short wide dash, not a dot.
  face(sphere(R * 0.10, 12), matMouth, 0, -0.42, 1.006, 1.30, 0.26, 0.16);
  // Ears, and the one thing they must not do: read as a patch stuck on the hair.
  //
  // The shipped ear was a skin-material sphere at `out` 0.94 — its centre *inside* the skull
  // — so the only part of it anyone ever saw was the sliver standing past the inflated hair
  // cap. Photographed from the side that is a four-cell skin-coloured hexagon floating in the
  // middle of the hair, which is exactly what it looked like.
  //
  // Pushing it out instead only made the patch bigger (16 cells, standing 0.070 R clear of
  // the hair behind it — and still inside the hair's silhouette, so still a decal). Every one
  // of the seven styles `buildHair` can build covers the side of the skull down past the jaw,
  // so there is nowhere on these heads for an ear to *emerge*: it would have to be tucked
  // out from under a notch in the hair, which is a change to the hair, not to the ear.
  // So the ear is a properly shaped shell that the hair covers completely, and face-check
  // gates both halves — the shape exists, and no style lets it through.
  for (const s of [-1, 1]) {
    face(sphere(R * 0.19, 12), matEar, s * 1.34, -0.08, 0.90, 0.80, 1.30, 0.35, -s * 0.14);
  }

  // --- arms ----------------------------------------------------------------
  for (const s of [-1, 1]) {
    const L = s < 0 ? 'L' : 'R';
    // Shoulder: a squashed cap tucked into the torso, plus a short sleeve running
    // down over it. Without the sleeve the cap reads as a bare ball joint, because
    // it is the only jacket-coloured piece on an otherwise darker arm.
    push(sphere(P.limbR * 1.0, 12), matSecondary, `arm${L}`,
      trs(-s * P.limbR * 0.26, P.limbR * 0.06, 0, 0, 0, 0, 1.05, 0.76, 1.0));
    // Upper arm hangs downward from the joint, so flip the limb geo. The whole
    // upper arm is the jacket sleeve — a part-sleeve/part-skin split here just
    // reads as a mismatched bracer.
    push(limbGeo(P.upperArm, P.limbR, P.limbR * 0.90, 0.02, 6, 9), matSecondary,
      `arm${L}`, trs(0, 0, 0, Math.PI, 0, 0),
      { softBone: `forearm${L}`, softLen: P.upperArm });
    // Sleeve trim at the elbow.
    push(new THREE.TorusGeometry(P.limbR * 0.90, P.limbR * 0.13, 6, 14), matPrimary,
      `arm${L}`, trs(0, -P.upperArm * 0.94, 0, Math.PI / 2, 0, 0));
    push(limbGeo(P.foreArm, P.limbR * 0.86, P.limbR * 0.66, 0.02, 6, 9), matSkin,
      `forearm${L}`, trs(0, 0, 0, Math.PI, 0, 0),
      { softBone: `hand${L}`, softLen: P.foreArm });
    // Elbow
    push(sphere(P.limbR * 0.88, 8), matSkin, `forearm${L}`, trs(0, 0, 0));
    // Hand: flattened mitten + thumb.
    push(sphere(P.limbR * 0.82, 10), matSkin, `hand${L}`,
      trs(0, -P.limbR * 0.5, 0, 0, 0, 0, 0.85, 1.25, 0.62));
    push(sphere(P.limbR * 0.30, 6), matSkin, `hand${L}`,
      trs(s * P.limbR * 0.55, -P.limbR * 0.35, P.limbR * 0.15, 0, 0, s * 0.7, 0.7, 1.2, 0.7));
    // Glove cuff
    push(new THREE.TorusGeometry(P.limbR * 0.74, P.limbR * 0.17, 6, 14), matPrimary,
      `forearm${L}`, trs(0, -P.foreArm * 0.94, 0, Math.PI / 2, 0, 0));
  }

  // Pauldrons: two overlapping plates rather than one big dome — a single
  // hemisphere at this size reads as a mushroom cap sitting on the shoulder.
  if (body.pauldrons) {
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      for (let i = 0; i < 2; i++) {
        const rad = P.limbR * (1.34 - i * 0.16);
        const g = new THREE.SphereGeometry(rad, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
        push(g, matMetal, `arm${L}`,
          trs(-s * P.limbR * 0.08, P.limbR * (0.30 - i * 0.52), 0, 0, 0, s * 0.16,
            1.12, 0.62, 1.06));
      }
      // Small upswept spike on the outer edge.
      push(new THREE.ConeGeometry(P.limbR * 0.26, P.limbR * 0.92, 5), matMetal, `arm${L}`,
        trs(s * P.limbR * 1.28, P.limbR * 0.48, 0, 0, 0, s * 0.85));
    }
  }

  // --- legs ----------------------------------------------------------------
  // `skirt` is a length multiplier, so a truthy non-number (a config that says `true`)
  // would flow straight into vertex positions. Read it as a number and treat `true` as
  // the mid-length it was presumably meant to be.
  const skirtAmt = body.skirt === true ? 0.5 : num(body.skirt, 0, 0, 1.2);
  for (const s of [-1, 1]) {
    const L = s < 0 ? 'L' : 'R';
    push(sphere(P.limbR * 1.24, 10), matPrimary, `thigh${L}`, trs(0, 0, 0));
    push(limbGeo(P.thigh, P.limbR * 1.24, P.limbR * 1.0, 0.03, 6, 10),
      skirtAmt > 0.3 ? matSkin : matPrimary, `thigh${L}`, trs(0, 0, 0, Math.PI, 0, 0),
      { softBone: `shin${L}`, softLen: P.thigh });
    push(limbGeo(P.shin, P.limbR * 1.0, P.limbR * 0.62, 0.04, 6, 10),
      skirtAmt > 0.3 ? matSkin : matPrimary, `shin${L}`, trs(0, 0, 0, Math.PI, 0, 0),
      { softBone: `foot${L}`, softLen: P.shin });
    // Knee: same material as the leg above it — a skin-coloured ball on trousers
    // reads as a hole in the garment.
    push(sphere(P.limbR * 0.94, 8), skirtAmt > 0.3 ? matSkin : matPrimary,
      `shin${L}`, trs(0, 0, 0));
    // Boot: shaft + foot.
    const bootH = P.shin * (0.42 + num(body.bootHeight, 0.25, 0, 1));
    push(limbGeo(bootH, P.limbR * 1.12, P.limbR * 0.84, 0, 4, 10), matBoots, `shin${L}`,
      trs(0, -P.shin + bootH * 0.02, 0));
    const foot = new THREE.BoxGeometry(P.limbR * 1.5, P.limbR * 0.7, P.limbR * 3.1);
    foot.translate(0, 0, P.limbR * 0.85);
    push(foot, matBoots, `foot${L}`, trs(0, P.limbR * 0.34, 0));
    // Toe cap
    push(sphere(P.limbR * 0.72, 8), matBoots, `foot${L}`,
      trs(0, P.limbR * 0.34, P.limbR * 2.3, 0, 0, 0, 1.0, 0.9, 1.1));
  }

  // --- skirt / coat tails --------------------------------------------------
  if (skirtAmt > 0.01) {
    const panels = 12;
    const len = P.torsoH * (0.46 + skirtAmt * 0.62);
    for (let i = 0; i < panels; i++) {
      const a = (i / panels) * Math.PI * 2;
      // The waist end has to match the torso's own hip width, otherwise the skirt
      // reads as a second narrower tier stepped in under the jacket.
      const w = P.waistW * 1.02;
      // 7 height segments, not 3: the flare below is a curve, and with too few
      // rings it renders as a stepped cone instead of a bell.
      const g = new THREE.CylinderGeometry(w, w * 1.04, len, 4, 7, true, a, Math.PI * 2 / panels * 1.18);
      const p = g.attributes.position;
      for (let v = 0; v < p.count; v++) {
        // Clamped: a t of 1+1e-7 from float error would make pow() of a negative
        // base NaN, which silently poisons the whole baked position buffer.
        const t = THREE.MathUtils.clamp((p.getY(v) + len / 2) / len, 0, 1);
        const flare = 1 + Math.pow(1 - t, 1.7) * (0.45 + skirtAmt * 0.75);
        p.setX(v, p.getX(v) * flare);
        p.setZ(v, p.getZ(v) * flare);
      }
      g.computeVertexNormals();
      g.translate(0, -len / 2, 0);
      // Hung from just under the belt so the waist seam is hidden.
      push(g, matPrimary, 'hips', trs(0, P.torsoH * 0.40, 0));
    }
  }

  /**
   * A cloak: an *open* sheet curved around the back, flaring toward the hem.
   *
   * Three things matter here. A flat PlaneGeometry with a bent Z reads as a
   * billboard slab from every angle but dead-on behind. The arc must stay under
   * about 0.8π: wrap it further and the sheet closes into a shell, which swallows
   * everything inside its radius — including the back hair, which then vanishes
   * entirely. And an unmodulated sheet is *still* a slab, because a smooth surface
   * lit by one directional light shades almost uniformly; `folds` breaks the radius
   * into vertical creases that each catch the light separately, and `hemDrop`
   * pulls the bottom edge into points so it isn't one hard horizontal rim.
   */
  const cloakGeo = (len, topR, hemR, arc, segs = 16, folds = 7, foldAmt = 0.055, hemDrop = 0.10) => {
    const g = new THREE.CylinderGeometry(1, 1, len, segs, 14, true, Math.PI - arc / 2, arc);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const t = THREE.MathUtils.clamp((y + len / 2) / len, 0, 1);   // 1 at top
      const a = Math.atan2(p.getX(i), p.getZ(i));
      // Creases deepen toward the hem, where the cloth has the most slack.
      const crease = 1 + Math.cos(a * folds) * foldAmt * (1 - t) * (1 - t);
      const r = THREE.MathUtils.lerp(hemR, topR, Math.pow(t, 0.62)) * crease;
      p.setX(i, p.getX(i) * r);
      p.setZ(i, p.getZ(i) * r);
      // Hem points hanging between the creases.
      if (hemDrop) p.setY(i, y - hemDrop * len * (1 - t) * (0.5 - 0.5 * Math.cos(a * folds)));
    }
    g.computeVertexNormals();
    g.translate(0, -len / 2, 0);
    return g;
  };

  // --- cape ----------------------------------------------------------------
  if (body.cape) {
    // Radii are keyed to shoulder width, not waist width: a cape hangs *from the
    // shoulders*, and at waist-relative sizes it ends up wider than the shoulder
    // line on the broad builds and clips straight through the upper arms.
    const capeLen = P.h * 0.36;
    const sw = P.shoulderW;
    push(cloakGeo(capeLen, sw * 0.50, sw * 1.32, Math.PI * 0.74),
      matSheet, 'capeA', trs(0, 0, 0),
      // A cape is cloth, not a limb — let the hem swing fully with capeB.
      { softBone: 'capeB', softLen: capeLen, softStart: 0.12, softMax: 1.0 });
    // Short mantle over the top of it: adds a second silhouette layer and hides
    // the main cape's top edge, which otherwise reads as a hard seam across the back.
    // Radii deliberately sit *outside* the main cape's profile over the mantle's
    // whole span, or it ends up entirely enclosed and invisible.
    push(cloakGeo(P.torsoH * 0.34, sw * 0.58, sw * 0.84, Math.PI * 0.80, 16,
      5, 0.075, 0.30), matPrimary, 'capeA', trs(0, P.torsoH * 0.06, 0));
    // Shoulder clasp.
    for (const s of [-1, 1]) {
      push(sphere(P.headR * 0.17, 8), matMetal, 'chest',
        trs(s * P.shoulderW * 0.66, P.torsoH * 0.20, -P.waistW * 0.1));
    }
  }

  // --- accessories ---------------------------------------------------------
  if (body.veil) {
    // Kept short and narrow, and in the accent material: at cape proportions in
    // matSheet it merges with the cape into one rigid white board covering the
    // whole back (both are the same colour on the characters that have both).
    const veilLen = P.headR * 2.5;
    push(cloakGeo(veilLen, P.headR * 1.10, P.headR * 1.48, Math.PI * 0.78, 18, 6, 0.05, 0.20),
      matSheetAccent, 'head', trs(0, P.headR * 0.55, 0),
      { softBone: 'hairTail', softLen: veilLen, softStart: 0.2, softMax: 0.6 });
  }
  if (body.quiver) {
    // Slung *outside* the cape (z past the cape's top radius) and low enough that
    // the arrow shafts stop around the shoulder line. Tucked in at waist depth it
    // is completely hidden by the cape, and the shafts poke up past the ears.
    const qx = P.shoulderW * 0.46;
    const qz = -P.shoulderW * 0.60;
    push(new THREE.CylinderGeometry(P.limbR * 0.72, P.limbR * 0.56, P.torsoH * 0.56, 10), matBoots,
      'chest', trs(qx, -P.torsoH * 0.16, qz, 0.18, 0, -0.30));
    push(new THREE.TorusGeometry(P.limbR * 0.72, P.limbR * 0.10, 6, 14), matMetal,
      'chest', trs(qx + P.torsoH * 0.08, P.torsoH * 0.10, qz, Math.PI / 2 + 0.18, 0, -0.30));
    for (let i = 0; i < 4; i++) {
      const ax = qx + (i - 1.5) * P.limbR * 0.24;
      push(new THREE.CylinderGeometry(P.h * 0.0035, P.h * 0.0035, P.torsoH * 0.34, 4), matMetal,
        'chest', trs(ax, P.torsoH * 0.16, qz, 0.18, 0, -0.30));
      push(new THREE.ConeGeometry(P.limbR * 0.14, P.torsoH * 0.10, 4), matAccent,
        'chest', trs(ax + P.torsoH * 0.06, P.torsoH * 0.32, qz, 0.18, 0, -0.30));
    }
  }
  // Wings: a fan of tapered feathers per side. A single big quad reads as a flat
  // billboard slab; individual feathers catch the light separately and give the
  // silhouette an actual edge.
  if (body.wings) {
    const featherCount = 5;
    for (const s of [-1, 1]) {
      for (let i = 0; i < featherCount; i++) {
        const u = i / (featherCount - 1);
        const len = P.h * (0.30 - u * 0.10);
        const wide = P.h * (0.032 - u * 0.008);
        const g = new THREE.SphereGeometry(1, 10, 12);
        const p = g.attributes.position;
        for (let v = 0; v < p.count; v++) {
          const ny = p.getY(v);
          // Taper to a point at the tip and flatten into a blade.
          const k = Math.sqrt(Math.max(0, 1 - Math.pow((ny + 1) / 2, 1.6)));
          p.setXYZ(v, p.getX(v) * wide * (0.35 + k), (ny * 0.5 + 0.5) * len, p.getZ(v) * wide * 0.28);
        }
        g.computeVertexNormals();
        push(g, matSheetAccent, 'chest',
          trs(s * P.shoulderW * 0.34, P.torsoH * 0.10, -P.waistW * 0.72,
            0.10 + u * 0.16, s * -0.30, s * (0.55 + u * 0.62)));
      }
    }
  }
  // Elemental emblem, seated on the jacket surface rather than sunk into it (a
  // torus at a guessed Z shows up as a crescent poking through the chest).
  {
    const emT = 0.70;                       // normalised torso height
    const emX = P.shoulderW * 0.44;
    const emZ = torsoFrontZ(P, emT, emX);
    const emY = (emT - 0.74) * P.torsoH;    // chest bone sits at t = 0.74
    const yaw = 0.34;
    push(new THREE.TorusGeometry(P.headR * 0.30, P.headR * 0.075, 8, 16), matMetal,
      'chest', trs(emX, emY, emZ - P.headR * 0.02, 0, yaw, 0));
    push(sphere(P.headR * 0.27, 12), matAccent,
      'chest', trs(emX, emY, emZ - P.headR * 0.05, 0, yaw, 0, 1, 1, 0.22));
  }

  // --- hair ----------------------------------------------------------------
  // Baked into the same skinned mesh (driven by the hair bones) so a character
  // stays a handful of draw calls instead of one per strand.
  parts.push(...buildHair(body.hair, P.headR, matHair, matBoots, matHairB));

  // --- bake ----------------------------------------------------------------
  const { geo, materials, occlusion } = bakeSkinned(parts, ordered, boneIndexOf, bindWorld);
  // The bake wrote an aRigOcc attribute; this is the half that lets the shader read it. A jaw
  // shading a neck and hair shading a scalp have to come from here, because the sun's shadow map
  // is a terrain instrument and cannot resolve anything on a body's scale — see occlusion.js.
  if (occlusion) setRigOcclusion(materials);
  const skinned = new THREE.SkinnedMesh(geo, materials);
  skinned.castShadow = true;
  skinned.receiveShadow = true;
  skinned.frustumCulled = false;
  skinned.add(bones.root);
  // Identity bind matrix: the geometry is already in the skinned mesh's own
  // local bind space, and skeleton.boneInverses were captured in that same space
  // before the bones were parented here. The default 'attached' bind mode then
  // divides out the mesh's world transform each frame, so the character can be
  // moved anywhere in the scene. Do NOT call skeleton.calculateInverses() after
  // this point — the bones now sit under the mesh and would resolve differently.
  skinned.bind(skeleton, new THREE.Matrix4());

  const group = new THREE.Group();
  group.name = `char:${def.id}`;
  group.add(skinned);

  // Weapon attachment point in the right hand.
  const weaponSlot = new THREE.Object3D();
  weaponSlot.name = 'weaponSlot';
  weaponSlot.position.set(0, -P.limbR * 0.9, P.limbR * 0.2);
  bones.handR.add(weaponSlot);

  // Left hand: bows are held in the offhand and drawn with the right, and the
  // catalyst tomes float off this side too.
  const offhandSlot = new THREE.Object3D();
  offhandSlot.name = 'offhandSlot';
  offhandSlot.position.set(0, -P.limbR * 0.9, P.limbR * 0.2);
  bones.handL.add(offhandSlot);

  // Back slot — where every sheathed weapon now hangs, so it is the slot a probe is most
  // likely to look up by name. It was the one of the four with no `name` set.
  const backSlot = new THREE.Object3D();
  backSlot.name = 'backSlot';
  backSlot.position.set(0, -P.torsoH * 0.1, -P.waistW * 0.85);
  bones.chest.add(backSlot);

  // Hip slot (scabbards, pouches) — on the hips bone so it swings with the walk.
  const hipSlot = new THREE.Object3D();
  hipSlot.name = 'hipSlot';
  hipSlot.position.set(-P.waistW * 0.92, P.torsoH * 0.06, 0);
  bones.hips.add(hipSlot);

  if (opts.outline !== false) {
    addOutline(group, body.outline ?? 0x14121c, opts.outlineWidth ?? 1.85);
  }

  return {
    group, skinned, skeleton, bones, weaponSlot, offhandSlot, backSlot, hipSlot,
    materials: {
      matSkin, matHair, matHairB, matPrimary, matSecondary, matAccent, matEye, matMetal,
      matBoots, matSheet, matSheetAccent,
      // Face materials are exported so a geometry probe can pick a feature out of the merged
      // mesh's material groups; tools/face-check.mjs is their consumer.
      matBrow, matEar,
    },
    // What the occlusion bake did: grid size, ray count, cost in ms and the occlusion range it
    // produced. A gate reads it to prove the attribute exists before it measures what it does.
    occlusion,
    P, height: P.h,
  };
}
