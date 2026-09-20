// Baked ambient occlusion for rigged models, computed on the merged bind-space surface.
//
// Why this exists at all, in numbers: the sun's shadow map is 2048 texels over a 156 m
// frustum, so one texel is 7.6 cm — a third of a character's head *diameter* — and
// `shadow.normalBias` is 4.5 cm, which is 0.39 of a head radius. Nothing on a body's own
// scale can therefore shadow anything: measured with the world hidden and the character's
// own `castShadow` toggled (see the devlog), a head cast **0 px of self-shadow** at five sun
// elevations from 16° to 55°, on a 212 000-265 000 px body, while the same toggle over the
// terrain moves 43 000 px. A jaw cannot shade a neck, a fringe cannot shade a forehead and a
// pauldron cannot shade an arm, so a face photographs as one flat field: 21 counts of
// luminance between p05 and p95 across a whole lit head, with the *neck* reading 214 against
// a mid-face of 202 — brighter than the jaw above it, which is the one thing it can never be.
//
// The gradient that is missing is a property of the geometry, not of the light, so it can be
// baked once at build time and cost nothing per frame — exactly the argument `uRootDark`
// already makes for grass and `foliageTone` for a canopy. This is the same idea with the
// occluders found by tracing instead of guessed from a height.
//
// The method is a voxel occupancy grid plus a short hemisphere march:
//
//   * The grid is sized off the model's own bounding diagonal (`cellScale`), not in metres, so
//     a slime and a 5 m boss get the same number of cells across themselves and the same AO
//     radius in body-lengths. A cell is about 1.1 cm on a 1.6 m character, and no axis can
//     ever exceed `1 / cellScale` cells because no extent exceeds the diagonal.
//   * Occupancy is stamped from *triangles*, subdivided until a patch is under a cell — not
//     from part bounding boxes. A cape or a skirt is a sheet whose box fills the space in
//     front of the legs, and that box would shade everything behind it.
//   * Each vertex fires a fixed cosine-weighted ray set around its normal and marches until
//     it leaves the grid or hits an occupied cell; a hit inside `maxDist` contributes
//     `1 - t / maxDist`.
//
// Two details are not decoration, they are the difference between a gradient and noise. A
// voxelized surface is a slab one cell thick, and *every* cell of that slab is occupied, so a
// ray that leaves a flat wall at a shallow angle crosses a filled cell before it clears the
// slab: it hits the wall it started on. Measured on a flat subdivided plane, which must read
// 0 by definition, the naive version read **0.221** — and a lid 0.4 m overhead then read
// *less* than open sky, because the number was noise, not occlusion. So:
//
//   * rays start one whole cell out along the normal, in the empty cell above the slab, and
//   * no ray leans more than `maxAngle` off the normal (60°, which is three quarters of the
//     cosine-weighted hemisphere by weight), so it clears the slab before crossing a cell.
//
// A hit in the cell the origin itself lands in is also ignored, so a vertex that starts inside
// an occluder — a scalp under a 1 cm fringe — reads its surroundings instead of saturating.
//
// The output is *occlusion*, 0 = open sky, 1 = fully enclosed, so a consumer writes
// `1 - amount * occ` and a zero amount is exactly the old picture.

const MAX_ANGLE = (60 * Math.PI) / 180;

const DIRS = (() => {
  // 12 cosine-weighted directions in a +Z cone, from a golden-ratio spiral: r = sqrt(u) puts
  // more of them near the pole, which is where a cosine-weighted integral has its weight, so
  // a ray count this low still integrates a smooth field instead of banding.
  const n = 12, out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const rMax = Math.sin(MAX_ANGLE);
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const r = rMax * Math.sqrt(u), z = Math.sqrt(Math.max(1e-4, 1 - r * r));
    const a = i * golden;
    out.push([r * Math.cos(a), r * Math.sin(a), z]);
  }
  return out;
})();

/**
 * @param {Float32Array} position  merged vertex positions, bind space
 * @param {Float32Array} normal    merged vertex normals, same order
 * @param {number[]|Uint32Array} index  triangle indices into those vertices
 * @param {object} opts
 *   cellScale  grid cell as a fraction of the bounding diagonal (1/160 ~ 1.1 cm on a character)
 *   radius     AO radius as a fraction of the diagonal (0.17 ~ 30 cm: a shoulder, not a room)
 *   offsetCells  how far along the normal a ray starts, in cells (1 = clear of the surface slab)
 * @returns {{ occ: Float32Array, stats: object }}
 */
export function bakeOcclusion(position, normal, index, opts = {}) {
  const vCount = position.length / 3;

  /* ---------------------------------------------------------------- the grid -- */
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < vCount; i++) {
    const x = position[i * 3], y = position[i * 3 + 1], z = position[i * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  // The model's own scale, from its own geometry: the diagonal, not the height, because a
  // creature that is wider than it is tall (a slime, a spider) must not get a cell ten times
  // finer than a standing character's and a grid a hundred times bigger.
  const size = opts.size || Math.hypot(x1 - x0, y1 - y0, z1 - z0) || 1;
  const cell = size * (opts.cellScale ?? 1 / 160);
  const maxDist = size * (opts.radius ?? 0.17);
  const offset = cell * (opts.offsetCells ?? 1.0);
  const pad = cell * 2;
  x0 -= pad; y0 -= pad; z0 -= pad; x1 += pad; y1 += pad; z1 += pad;
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell));
  const ny = Math.max(1, Math.ceil((y1 - y0) / cell));
  const nz = Math.max(1, Math.ceil((z1 - z0) / cell));
  const grid = new Uint8Array(nx * ny * nz);
  const at = (ix, iy, iz) => grid[(iy * nz + iz) * nx + ix];
  const stamp = (x, y, z) => {
    const ix = ((x - x0) / cell) | 0, iy = ((y - y0) / cell) | 0, iz = ((z - z0) / cell) | 0;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return;
    grid[(iy * nz + iz) * nx + ix] = 1;
  };

  // Triangles, subdivided in barycentric steps until a patch is under a cell across.
  let stamps = 0;
  const tri = index.length / 3;
  for (let t = 0; t < tri; t++) {
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3;
    const ax = position[a], ay = position[a + 1], az = position[a + 2];
    const bx = position[b], by = position[b + 1], bz = position[b + 2];
    const cx = position[c], cy = position[c + 1], cz = position[c + 2];
    const e = Math.max(
      Math.hypot(bx - ax, by - ay, bz - az),
      Math.hypot(cx - bx, cy - by, cz - bz),
      Math.hypot(ax - cx, ay - cy, az - cz),
    );
    const n = Math.min(8, Math.max(1, Math.ceil(e / (cell * 0.7))));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        stamp(ax * w + bx * u + cx * v, ay * w + by * u + cy * v, az * w + bz * u + cz * v);
        stamps++;
      }
    }
  }

  /* ------------------------------------------------------------ the marching -- */
  const occ = new Float32Array(vCount);
  const steps = Math.max(2, Math.ceil(maxDist / (cell * 0.9)));
  let sum = 0, lo = 1, hi = 0;
  for (let i = 0; i < vCount; i++) {
    const px = position[i * 3], py = position[i * 3 + 1], pz = position[i * 3 + 2];
    let nxv = normal[i * 3], nyv = normal[i * 3 + 1], nzv = normal[i * 3 + 2];
    const nl = Math.hypot(nxv, nyv, nzv) || 1;
    nxv /= nl; nyv /= nl; nzv /= nl;
    // A tangent frame around the normal. The pick of `up` only has to be non-parallel.
    let ux = 0, uy = 0, uz = 1;
    if (Math.abs(nzv) > 0.9) { ux = 1; uy = 0; uz = 0; }
    let tx = uy * nzv - uz * nyv, ty = uz * nxv - ux * nzv, tz = ux * nyv - uy * nxv;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const sx = nyv * tz - nzv * ty, sy = nzv * tx - nxv * tz, sz = nxv * ty - nyv * tx;
    // One cell out along the normal: clear of the slab this vertex's own triangles voxelize to.
    const ox = px + nxv * offset, oy2 = py + nyv * offset, oz = pz + nzv * offset;
    const cx0 = ((ox - x0) / cell) | 0, cy0 = ((oy2 - y0) / cell) | 0, cz0 = ((oz - z0) / cell) | 0;
    let acc = 0;
    for (const d of DIRS) {
      const dx = tx * d[0] + sx * d[1] + nxv * d[2];
      const dy = ty * d[0] + sy * d[1] + nyv * d[2];
      const dz = tz * d[0] + sz * d[1] + nzv * d[2];
      for (let s = 1; s <= steps; s++) {
        const t = s * cell * 0.9;
        const gx = ((ox + dx * t - x0) / cell) | 0;
        const gy = ((oy2 + dy * t - y0) / cell) | 0;
        const gz = ((oz + dz * t - z0) / cell) | 0;
        if (gx < 0 || gy < 0 || gz < 0 || gx >= nx || gy >= ny || gz >= nz) break;
        if (gx === cx0 && gy === cy0 && gz === cz0) continue;   // still in the origin's own cell
        if (at(gx, gy, gz)) { acc += 1 - Math.min(t, maxDist) / maxDist; break; }
      }
    }
    const v = acc / DIRS.length;
    occ[i] = v;
    sum += v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }

  return {
    occ,
    stats: {
      size: +size.toFixed(3), cell: +cell.toFixed(4), maxDist: +maxDist.toFixed(3), dims: [nx, ny, nz],
      cells: nx * ny * nz, stamps, filled: grid.reduce((n2, v) => n2 + v, 0),
      verts: vCount, rays: DIRS.length, steps,
      min: +lo.toFixed(3), mean: +(sum / Math.max(vCount, 1)).toFixed(3), max: +hi.toFixed(3),
    },
  };
}
