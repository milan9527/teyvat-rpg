// Solid-modelling primitives shared by every hand-built model in the game
// (weapons, enemies, props).
//
// Two operations do almost all the work: `loft` sweeps a closed cross-section
// straight along +Y with a varying width/depth profile, and `sweep` carries the
// same section along an arbitrary space curve using a proper orthonormal frame.
// That is what separates a blade from a box, or a dragon's tail from a cone: the
// section can change width, thickness, roll and offset independently along the
// spine.
//
// `Parts` then collects (geometry, material, transform) triples and merges them
// down to one mesh per material, which is what keeps a 40-piece model at 5 draw
// calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';


// Cross-sections, in a roughly ±1 box. x is "width", z is "thickness".
export const SEC = {
  /**
   * Blade: sharp-ish edges at x = ±1 with a small flat so the outline shell has
   * something to sit on, a raised ridge either side of a shallow central fuller.
   */
  blade: [
    [0, 0.58], [0.40, 1.0], [0.90, 0.18], [1.0, 0], [0.90, -0.18], [0.40, -1.0],
    [0, -0.58], [-0.40, -1.0], [-0.90, -0.18], [-1.0, 0], [-0.90, 0.18], [-0.40, 1.0],
  ],
  /** Lens: guards, bow limbs, flanges. */
  lens: [
    [1, 0], [0.6, 0.72], [0, 1], [-0.6, 0.72], [-1, 0], [-0.6, -0.72], [0, -1], [0.6, -0.72],
  ],
  /** Octagon: grips, shafts. */
  oct: [
    [1, 0], [0.707, 0.707], [0, 1], [-0.707, 0.707],
    [-1, 0], [-0.707, -0.707], [0, -1], [0.707, -0.707],
  ],
  /** Rounded rectangle: book covers, heavy slabs. */
  rect: [
    [1, -0.8], [1, 0.8], [0.8, 1], [-0.8, 1], [-1, 0.8], [-1, -0.8], [-0.8, -1], [0.8, -1],
  ],
  /** Diamond: inlays, tassel cords. */
  quad: [[1, 0], [0, 1], [-1, 0], [0, -1]],
};

export const MIN_R = 0.0007;   // never let a profile collapse: zero-area faces give NaN normals

/** Signed area sign of a section, used to force outward-facing winding. */
export function sectionSign(unit) {
  let s = 0;
  for (let i = 0; i < unit.length; i++) {
    const a = unit[i], b = unit[(i + 1) % unit.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

const TMP_D = new THREE.Vector3();
const TMP_X = new THREE.Vector3();
const TMP_Z = new THREE.Vector3();
const TMP_P = new THREE.Vector3();
const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
// Roll references. Which one a spine needs is not cosmetic: `ref` must never be
// parallel to the tangent, or the frame collapses. A spine running along ±Y takes
// UP_REF only if it also has a strong Z component; a curve *in* the YZ plane (a
// bow limb) has to use X_REF, otherwise the frame inverts at the recurve
// inflection where the Z derivative crosses zero.
//
// The mapping is worth remembering when tuning: for a spine along Y, section `w`
// is X and `d` is Z. For a spine along X, `w` becomes Z (depth) and `d` becomes
// Y (height) — a crossguard tuned as if `d` were depth ends up 11 cm tall.
export const REF = new THREE.Vector3(0, 0, 1);
export const UP_REF = new THREE.Vector3(0, 1, 0);
export const X_REF = new THREE.Vector3(1, 0, 0);

/**
 * Sweep a closed cross-section along a curve.
 *
 * `at(t)` returns `{ p: Vector3, w, d, roll?, ref? }` — the spine point, the
 * half-width and half-thickness there, an optional twist, and an optional
 * reference vector fixing the section's roll (defaults to +Z, or +Y for spines
 * that run near-vertically in Z).
 *
 * Faces are flat-shaded on purpose: the cel ramp needs discrete facets, and a
 * smoothed 12-gon blade turns into a soft grey tube under the toon shader.
 */
export function sweep(unit, at, steps, opts = {}) {
  const n = unit.length;
  const src = sectionSign(unit) > 0 ? unit : unit.slice().reverse();
  const pos = new Float32Array((steps + 1) * n * 3);
  const idx = [];
  const EPS = 1e-4;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const f = at(t);
    // Callers hand back a *reused* Vector3, so everything from this frame has to
    // be copied out before `at` is called again for the tangent probes.
    TMP_P.copy(f.p);
    const w = Math.max(MIN_R, f.w), d = Math.max(MIN_R, f.d ?? f.w);
    const roll = f.roll ?? 0;
    const refv = f.ref;
    // Tangent by central difference on the spine — works for any curve without
    // the caller having to supply derivatives.
    TMP_A.copy(at(Math.max(0, t - EPS)).p);
    TMP_B.copy(at(Math.min(1, t + EPS)).p);
    TMP_D.subVectors(TMP_B, TMP_A);
    if (TMP_D.lengthSq() < 1e-14) TMP_D.set(0, 1, 0);
    TMP_D.normalize();
    const ref = refv ?? (Math.abs(TMP_D.z) > 0.98 ? UP_REF : REF);
    TMP_X.crossVectors(TMP_D, ref).normalize();
    TMP_Z.crossVectors(TMP_X, TMP_D).normalize();
    const cr = Math.cos(roll), sr = Math.sin(roll);
    for (let j = 0; j < n; j++) {
      const ux = src[j][0] * w, uz = src[j][1] * d;
      const rx = ux * cr - uz * sr, rz = ux * sr + uz * cr;
      const o = (i * n + j) * 3;
      pos[o] = TMP_P.x + TMP_X.x * rx + TMP_Z.x * rz;
      pos[o + 1] = TMP_P.y + TMP_X.y * rx + TMP_Z.y * rz;
      pos[o + 2] = TMP_P.z + TMP_X.z * rx + TMP_Z.z * rz;
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j, b = i * n + (j + 1) % n;
      idx.push(a, a + n, b, b, a + n, b + n);
    }
  }
  if (opts.caps !== false) {
    // Fans from the section centroid. Winding is the mirror of the side quads.
    const c0 = (steps + 1) * n, c1 = c0 + 1;
    const grown = new Float32Array(pos.length + 6);
    grown.set(pos);
    for (let j = 0; j < n; j++) {
      grown[c0 * 3] += pos[j * 3] / n;
      grown[c0 * 3 + 1] += pos[j * 3 + 1] / n;
      grown[c0 * 3 + 2] += pos[j * 3 + 2] / n;
      const o = (steps * n + j) * 3;
      grown[c1 * 3] += pos[o] / n;
      grown[c1 * 3 + 1] += pos[o + 1] / n;
      grown[c1 * 3 + 2] += pos[o + 2] / n;
    }
    for (let j = 0; j < n; j++) {
      const b = (j + 1) % n;
      idx.push(c0, j, b);
      idx.push(c1, steps * n + b, steps * n + j);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(grown, 3));
    g.setIndex(idx);
    return finish(g, opts);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return finish(g, opts);
}

/** Flat-shaded by default: `toNonIndexed` first makes computeVertexNormals per-face. */
export function finish(g, opts) {
  const out = opts.smooth ? g : g.toNonIndexed();
  out.computeVertexNormals();
  return out;
}

/**
 * A flat, single-sided strip along a spine — one quad per step, no volume.
 *
 * `sweep` is the right tool for anything the player can walk up to, but a blade of
 * grass swept as a closed 4-gon costs 40 triangles for a shape that is two pixels
 * wide on screen, and a field of 13 000 tufts then spends two million triangles
 * per frame (twice that with the shadow pass) on thickness nobody can see. A strip
 * is 6 triangles for the same silhouette. Use it for grass, reeds and leaf cards;
 * pair it with a DoubleSide material, since a strip has no back.
 *
 * `at(t)` returns `{ p, w }` like `sweep`'s, plus an optional `ref` fixing the
 * strip's facing — the width axis is `tangent × ref`, so `ref` is what decides
 * whether a blade faces the camera or edge-on.
 */
export function ribbon(at, steps = 3, opts = {}) {
  const pos = new Float32Array((steps + 1) * 2 * 3);
  const idx = [];
  const EPS = 1e-4;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const f = at(t);
    TMP_P.copy(f.p);
    const w = Math.max(MIN_R, f.w);
    TMP_A.copy(at(Math.max(0, t - EPS)).p);
    TMP_B.copy(at(Math.min(1, t + EPS)).p);
    TMP_D.subVectors(TMP_B, TMP_A);
    if (TMP_D.lengthSq() < 1e-14) TMP_D.set(0, 1, 0);
    TMP_D.normalize();
    const ref = f.ref ?? (Math.abs(TMP_D.z) > 0.98 ? UP_REF : REF);
    TMP_X.crossVectors(TMP_D, ref);
    // A tangent parallel to `ref` leaves a zero-length width axis, and normalising
    // that is how a strip turns into NaN vertices — fall back to any perpendicular.
    if (TMP_X.lengthSq() < 1e-12) TMP_X.crossVectors(TMP_D, X_REF);
    TMP_X.normalize();
    for (let j = 0; j < 2; j++) {
      const s = j === 0 ? -w : w;
      const o = (i * 2 + j) * 3;
      pos[o] = TMP_P.x + TMP_X.x * s;
      pos[o + 1] = TMP_P.y + TMP_X.y * s;
      pos[o + 2] = TMP_P.z + TMP_X.z * s;
    }
  }
  for (let i = 0; i < steps; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return finish(g, opts);
}

/** Straight loft along +Y from y0 to y1. `prof(t)` returns { w, d, ox, oz, roll }. */
export function loft(unit, y0, y1, prof, steps = 10, opts = {}) {
  const p = new THREE.Vector3();
  return sweep(unit, (t) => {
    const f = prof(t);
    p.set(f.ox ?? 0, y0 + (y1 - y0) * t, f.oz ?? 0);
    return { p, w: f.w, d: f.d, roll: f.roll };
  }, steps, opts);
}

/** Constant-profile straight segment — the common case. */
export function bar(unit, y0, y1, w, d, steps = 1) {
  return loft(unit, y0, y1, () => ({ w, d }), steps);
}

export const M4 = () => new THREE.Matrix4();
const EULER = new THREE.Euler();
const QUAT = new THREE.Quaternion();
/**
 * Place a primitive. The scale is one argument that may be split into three, so
 * `trs(x, y, z, 0, 0, 0, 1.4)` stays uniform while `trs(..., 1.4, 0.8, 1.1)`
 * squashes — creature blobs are almost never uniform spheres.
 */
export function trs(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return M4().compose(
    new THREE.Vector3(x, y, z),
    QUAT.setFromEuler(EULER.set(rx, ry, rz)).clone(),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** Rotation-only helper for the common "aim this primitive along a vector" case. */
export function aim(from, to) {
  return new THREE.Quaternion().setFromUnitVectors(
    from.clone().normalize(), to.clone().normalize(),
  );
}

/* ------------------------------------------------- primitive building blocks -- */

export const sphere = (r, seg = 12) =>
  new THREE.SphereGeometry(r, seg, Math.max(6, seg - 4));

/** Ellipsoid — the workhorse for organic volumes (foliage, bellies, rocks). */
export function blob(r, sx, sy, sz, seg = 14) {
  const g = sphere(r, seg);
  g.scale(sx, sy, sz);
  return g;
}

/** Cone growing from the origin along +Y: horns, spikes, claws, blades of grass. */
export function spike(len, r, radial = 5, open = false) {
  // `open` drops the base cap. Worth asking for whenever the cone is seated *inside*
  // another mass — foliage tufts on a lobe, petals in a flower centre — where the cap
  // is geometry that can never be seen: it is a third of the cone's triangles, and a
  // shrub carries forty of them.
  const g = new THREE.ConeGeometry(r, len, radial, 1, open);
  g.translate(0, len / 2, 0);
  return g;
}

export const ring = (r, tube, seg = 7, rseg = 16) =>
  new THREE.TorusGeometry(r, tube, seg, rseg);

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const ALONG_D = new THREE.Vector3();
/**
 * Place a +Y-growing primitive (a `spike`) so that it points along `dir`.
 *
 * Euler angles are the wrong tool for a radial fan: `trs(..., rx, 0, rz)` applies
 * rz first and then rotates the *result* about the world X axis, so a ring of
 * tufts placed that way splays correctly at one azimuth and folds flat at the one
 * 90 degrees away. Composing straight from a direction vector is exact everywhere.
 */
export const along = (x, y, z, dx, dy, dz) => new THREE.Matrix4().compose(
  new THREE.Vector3(x, y, z), aim(UP, ALONG_D.set(dx, dy, dz)), ONE,
);

/** Strip a geometry down to position+normal (+baked colour), non-indexed. */
export function prep(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) {
    if (k === 'position' || k === 'normal') continue;
    // `color` survives so a recipe can bake per-vertex tone into a solid (see
    // `stoneTone` in gfx/props.js). The itemSize test keeps the 4-component
    // vertex-alpha colours the additive glow volumes use out of merges that expect a
    // vec3 — mixing the two silently produces a geometry three cannot merge.
    if (k === 'color' && g.attributes.color.itemSize === 3) continue;
    g.deleteAttribute(k);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

/**
 * Merge one material's geometries into one.
 *
 * A baked `color` attribute only exists on the parts that asked for one, and
 * `mergeGeometries` rejects a set whose attribute names differ — so the plain parts
 * are given white before the merge rather than the whole solid losing its tone. This
 * is exactly what went wrong the first time: `prep` dropped the attribute while the
 * material still declared `vertexColors`, which left the shader reading an undeclared
 * attribute and every boulder rendered black.
 */
export function mergeParts(list, mat) {
  // The material is consulted, not just the geometries: a `vertexColors` material whose
  // piece happens to be a single un-baked geometry would otherwise reach the shader
  // with the attribute undeclared, and undeclared reads black. Asking the material
  // makes that whole class of bug impossible rather than merely unlikely.
  if (mat?.vertexColors === true || list.some((g) => g.attributes.color)) {
    for (const g of list) {
      if (g.attributes.color) continue;
      g.setAttribute('color', new THREE.BufferAttribute(
        new Float32Array(g.attributes.position.count * 3).fill(1), 3));
    }
  }
  return list.length === 1 ? list[0] : mergeGeometries(list, false);
}

/** Collects (geometry, material, transform) triples and merges them per material. */
export class Parts {
  constructor() { this.byMat = new Map(); }
  add(geo, mat, matrix) {
    const g = prep(geo);
    if (matrix) g.applyMatrix4(matrix);
    if (!this.byMat.has(mat)) this.byMat.set(mat, []);
    this.byMat.get(mat).push(g);
    return this;
  }
  build(name) {
    const group = new THREE.Group();
    group.name = name;
    for (const [mat, list] of this.byMat) {
      const merged = mergeParts(list, mat);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      // Receiving matters as much as casting: a prop that only casts sits in its own
      // unshaded light while the ground around it darkens, which reads as a cut-out.
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}
