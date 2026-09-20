// Does the hair cover the forehead, and is there a face under it?
//
//   node tools/face-check.mjs
//
// No WebGL and no browser: `buildHumanoid` bakes its skinned mesh in plain Node, and
// everything asked here is a question about geometry, so every body is measured by casting
// rays out of the head bone and asking which material they land on first.
//
// What shipped, photographed at portrait size (700 px across a 0.115 m head):
//
//   * The fringe was nine evenly spaced wedges and nothing else, so the forehead showed
//     **through** it: 43.2 % of the band between the brow line and the skull cap was bare
//     skin, in 29 interior gaps, the largest 147 grid cells. It read as a comb.
//   * Widening the wedges to close those gaps is what the comment in the source already
//     claimed they did ("blunt-ended wedges (not points) so the fringe reads as one mass"),
//     and it cannot work: wedges wide enough to touch weld into one paddle. So the fix
//     splits the two jobs — a `fringeSheet` carries the coverage, and the locks over it
//     carry the silhouette and can therefore taper to points.
//   * Those locks then hung as a row of equal-length blunt cylinders whose flat end discs
//     faced the camera: mean depth difference between neighbouring hem teeth 0.055 rad, a
//     level row of bright bars. Authored clumps of six different lengths read 0.159.
//   * The eyebrow was one `BoxGeometry` — a black rectangle, the one shape a face never
//     has. A bar has no arch (the middle cannot ride above both ends) and no taper.
//
// So the gates come in two-sided pairs, because each one alone has a cheap wrong answer:
// hair must cover the forehead (or the fringe is a comb) but must never cover the iris (or
// the "coverage" fix is a curtain over the eyes); the hem must not be level (or the locks
// are corrugation) but must stay a hem (tips still present); the brow must arch and taper
// but stay inside a sane span and thickness (or "not a bar" is satisfied by a blob).
//
// Bars are set after measuring both the fix and the defect, and the defect is re-measured
// by reverting the product — see 开发日志 for the mutation run.
import { buildHumanoid } from '../client/src/gfx/humanoid.js';
import { CHARACTERS } from '../shared/src/data/characters.js';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* ------------------------------------------------------------------ ray casting -- */

function triangles(rig, want) {
  const geo = rig.skinned.geometry;
  const mats = Array.isArray(rig.skinned.material) ? rig.skinned.material : [rig.skinned.material];
  const pos = geo.attributes.position, idx = geo.index;
  const out = [];
  for (const g of geo.groups) {
    // One mesh per material *array*: the group's materialIndex is the only way back to
    // the material a triangle was authored with.
    if (!want.includes(mats[g.materialIndex])) continue;
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const t = [];
      for (let k = 0; k < 3; k++) {
        const v = idx ? idx.getX(i + k) : i + k;
        t.push([pos.getX(v), pos.getY(v), pos.getZ(v)]);
      }
      out.push(t);
    }
  }
  return out;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Möller-Trumbore, origin `o`, unit direction `d`; returns the hit distance or -1. */
function hit(o, d, tri) {
  const e1 = sub(tri[1], tri[0]), e2 = sub(tri[2], tri[0]);
  const h = cross(d, e2), a = dot(e1, h);
  if (Math.abs(a) < 1e-12) return -1;
  const f = 1 / a, s = sub(o, tri[0]);
  const u = f * dot(s, h);
  if (u < 0 || u > 1) return -1;
  const q = cross(s, e1), v = f * dot(d, q);
  if (v < 0 || u + v > 1) return -1;
  const t = f * dot(e2, q);
  return t > 1e-6 ? t : -1;
}
const dirOf = (yaw, pitch) => {
  const cp = Math.cos(pitch);
  const d = [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
  const n = Math.hypot(...d);
  return [d[0] / n, d[1] / n, d[2] / n];
};
const far = (o, dir, tris) => { let m = -1; for (const t of tris) { const x = hit(o, dir, t); if (x > m) m = x; } return m; };
const near = (o, dir, tris) => { let m = 1e9; for (const t of tris) { const x = hit(o, dir, t); if (x > 0 && x < m) m = x; } return m; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const std = (a) => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));

/* ------------------------------------------------------------------- the bands -- */

// The forehead: from the brow line (the brow sits at pitch EYE_PITCH + 0.40 = 0.33) up to
// the front skull cap's lower edge (thetaStart 0.26*PI, i.e. pitch 0.75), across the yaw the
// fringe spans. The cap covers pitch >= 0.41 for free, so the band the *fringe* owns is
// bounded separately — a bar over the whole band would mostly be measuring the cap.
const P0 = 0.33, P1 = 0.75, YW = 0.92, FRINGE_P = 0.46;
const NY = 46, NP = 24;
// The hem sweep: fine steps, from above the hairline down past the eyes.
const HNY = 61, HTOP = 0.60, HBOT = -0.30, HSTEP = 0.005;

function measure(def) {
  const rig = buildHumanoid(def, { outline: false });
  rig.group.updateMatrixWorld(true);
  // The skinned geometry is in bind space and the bones were bound in that same space, so
  // the head bone's world matrix *is* the head centre in vertex coordinates.
  const e = rig.bones.head.matrixWorld.elements;
  const o = [e[12], e[13], e[14]];
  const hair = triangles(rig, [rig.materials.matHair, rig.materials.matHairB]);
  const skin = triangles(rig, [rig.materials.matSkin]);
  const iris = triangles(rig, [rig.materials.matEye]);

  // Covered = the *farthest* hair hit lies outside the *nearest* skin hit. Asking for the
  // nearest hair instead reads the inside face of a strand buried in the skull and calls
  // the forehead bare right under the cap.
  const covered = (yaw, pitch) => {
    const dir = dirOf(yaw, pitch);
    const th = far(o, dir, hair);
    const ts = near(o, dir, skin);
    return th > 0 && (ts === 1e9 || th > ts - 1e-4);
  };

  /* coverage grid + interior comb gaps */
  const grid = [];
  let cov = 0, tot = 0, lowCov = 0, lowTot = 0, gapRuns = 0, gapCells = 0;
  for (let j = 0; j < NP; j++) {
    const pitch = P0 + (P1 - P0) * ((j + 0.5) / NP);
    const row = [];
    for (let i = 0; i < NY; i++) {
      const yaw = -YW + 2 * YW * (i / (NY - 1));
      const ok = covered(yaw, pitch);
      row.push(ok ? 1 : 0);
      tot++; if (ok) cov++;
    }
    grid.push(row);
    if (pitch > FRINGE_P) continue;
    for (const v of row) { lowTot++; if (v) lowCov++; }
    // Interior gaps only: a bare run with hair on *both* sides of it in the same row is the
    // space between two locks, which is the comb. Bare cells at the ends of a row are the
    // face opening, not a defect.
    let i = 0;
    while (i < NY) {
      if (row[i]) { i++; continue; }
      let k = i; while (k < NY && !row[k]) k++;
      if (i > 0 && k < NY) { gapRuns++; gapCells += k - i; }
      i = k;
    }
  }
  // Biggest bare patch, as a connected component (4-neighbour) of uncovered cells.
  const seen = grid.map((r) => r.map(() => false));
  let biggest = 0;
  for (let j = 0; j < NP; j++) {
    for (let i = 0; i < NY; i++) {
      if (grid[j][i] || seen[j][i]) continue;
      let n = 0; const st = [[j, i]]; seen[j][i] = true;
      while (st.length) {
        const [y, x] = st.pop(); n++;
        for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || nx < 0 || ny >= NP || nx >= NY || grid[ny][nx] || seen[ny][nx]) continue;
          seen[ny][nx] = true; st.push([ny, nx]);
        }
      }
      biggest = Math.max(biggest, n);
    }
  }

  /* the hem line: walking down from above the hairline, where the solid mass first breaks */
  const profAll = [];
  for (let i = 0; i < HNY; i++) {
    const yaw = -YW + 2 * YW * (i / (HNY - 1));
    let p = HTOP;
    while (p > HBOT && covered(yaw, p)) p -= HSTEP;
    profAll.push(+p.toFixed(4));
  }
  // Columns that never broke out of hair carry no hem (the long side masses run past the
  // bottom of the sweep); they would otherwise all register as teeth at exactly HBOT.
  const prof = profAll.filter((v) => v > HBOT + 1e-6);
  const tipIdx = [];
  for (let i = 1; i < prof.length - 1; i++) {
    let lo = true;
    for (let k = Math.max(0, i - 2); k <= Math.min(prof.length - 1, i + 2); k++) {
      if (prof[k] < prof[i] - 1e-9) lo = false;
    }
    if (lo && !(tipIdx.length && i - tipIdx[tipIdx.length - 1] < 3)) tipIdx.push(i);
  }
  const depths = tipIdx.map((i) => prof[i]);
  const adj = depths.slice(1).map((d, k) => Math.abs(d - depths[k]));

  /* the iris must not be behind hair, from where the player is standing */
  //
  // This one cannot be cast radially out of the head. Occlusion is a property of the *view*
  // direction, and a ray from the head centre to the top of the iris leaves at an upward
  // angle, straight through the fringe hanging in front of the forehead above the eye: cast
  // that way, 沃特 reported 38 of 120 iris cells "behind hair" in a photograph where both
  // eyes are plainly clear. So the rays are parallel, from in front of the face, and the
  // grid is derived from the iris geometry's own bounding box rather than guessed in angles.
  let irisCells = 0, irisHidden = 0;
  {
    const bb = [1e9, 1e9, -1e9, -1e9, -1e9];   // minX minY maxX maxY maxZ
    for (const t of iris) for (const v of t) {
      bb[0] = Math.min(bb[0], v[0]); bb[1] = Math.min(bb[1], v[1]);
      bb[2] = Math.max(bb[2], v[0]); bb[3] = Math.max(bb[3], v[1]);
      bb[4] = Math.max(bb[4], v[2]);
    }
    const z0 = bb[4] + rig.P.headR * 2, dir = [0, 0, -1];
    const N = 16;
    for (let j = 0; j < N; j++) {
      const y = bb[1] + (bb[3] - bb[1]) * ((j + 0.5) / N);
      for (let i = 0; i < N * 2; i++) {
        const x = bb[0] + (bb[2] - bb[0]) * ((i + 0.5) / (N * 2));
        const org = [x, y, z0];
        const ti = near(org, dir, iris);
        if (ti === 1e9) continue;
        irisCells++;
        if (near(org, dir, hair) < ti - 1e-4) irisHidden++;
      }
    }
  }

  /* the brow, per side, in its own yaw/height frame */
  const browTris = triangles(rig, [rig.materials.matBrow]);
  const R = rig.P.headR;
  const brows = [-1, 1].map((s) => {
    const pts = [];
    for (const t of browTris) for (const v of t) if (Math.sign(v[0]) === s) pts.push(v);
    if (pts.length < 12) return null;
    const yaws = pts.map((v) => Math.atan2(v[0], v[2]) * s);   // signed outward
    const y0 = Math.min(...yaws), y1 = Math.max(...yaws);
    const NB = 10;
    const bins = Array.from({ length: NB }, () => []);
    pts.forEach((p, i) => {
      const u = (yaws[i] - y0) / (y1 - y0 || 1);
      bins[Math.min(NB - 1, Math.floor(u * NB))].push(p[1]);
    });
    const cen = [], thick = [];
    for (const b of bins) {
      if (!b.length) { cen.push(null); thick.push(null); continue; }
      const lo = Math.min(...b), hi = Math.max(...b);
      cen.push((lo + hi) / 2); thick.push(hi - lo);
    }
    const val = (a) => a.filter((v) => v !== null);
    const inner = val(cen.slice(0, 2)), outer = val(cen.slice(-2)), mid = val(cen.slice(2, -2));
    return {
      span: y1 - y0,
      // How far the middle of the brow rides above the higher of its two ends, in head
      // radii. One straight bar, at any roll, gives <= 0 — that is the whole test. A single
      // box has vertices only at its eight corners, so the middle bins come back empty:
      // that is the same answer (no brow between the ends), reported as a number rather
      // than as arithmetic on -Infinity.
      arch: mid.length
        ? (Math.max(...mid) - Math.max(Math.max(...inner), Math.max(...outer))) / R
        : -1,
      taper: mean(val(thick.slice(-3))) / mean(val(thick.slice(0, 3))),
      thick: mean(val(thick)) / R,
    };
  });

  return {
    frac: cov / tot, low: lowCov / lowTot, lowTot, gapRuns, gapCells, biggest,
    tips: depths.length, depths, adjMean: mean(adj), rough: std(prof),
    lowest: depths.length ? Math.min(...depths) : 99,
    irisCells, irisHidden, brows, hairTris: hair.length,
  };
}

/* ----------------------------------------------------------------------- bars -- */

// Every bar below was set after running this file against both the fix and the shipped
// geometry (fix, then shipped): band 99.6 % / 93.4, the fringe's own band 98.8 / 77.3, comb
// gap runs 2 / 29, biggest bare patch 2 / 29 cells, neighbouring-tooth depth difference
// 0.159 / 0.072 rad, lowest tooth pitch 0.050 / 0.175, iris cells behind hair 0 / 55 (沃特).
//
// The two coverage percentages are sampling-sensitive on the *defect*: a scratch pass whose
// yaw samples sat half a cell over read the same shipped fringe as 43.2 % rather than 77.3 %,
// because the gaps between the wedges were about as wide as the grid. The gap *count* (29
// runs) is stable under that shift, which is why the comb is named by its gaps.
const MIN_BAND = 0.95;
const MIN_FRINGE = 0.95;
const MAX_GAP_RUNS = 4;
const MAX_BARE = 10;
const MIN_TIPS = 4;
// The hem must not be level: neighbouring teeth differ in depth by at least this much. The
// bar sits between the shipped 0.055 rad and the fix's 0.159, so it kills the defect by 1.8x
// and leaves the fix 1.6x of headroom. (An earlier draft also accepted a rough hem line as
// an alternative, because 沃特's spiky style used to hang its own locks past the fringe and
// read 0.060 here. Raising those spikes off his eyes put his hem back under the fringe's
// control, so the alternative had no user left and an OR-ed gate nothing satisfies through
// its second term is a gate that can rot unnoticed.)
const MIN_ADJ = 0.10;
// The fringe has to reach down the forehead, and the eyes have to stay out from under it.
const MAX_LOWEST = 0.15;
const MIN_IRIS_CELLS = 40;
// Brow: arched, tapering outward, and still a brow.
const MIN_ARCH = 0.006, MAX_TAPER = 0.75;
const SPAN = [0.25, 0.55], THICK = [0.020, 0.090];

/* ----------------------------------------------------------------------- run -- */

// One body per hair style `buildHair` switches on, so a fringe defect cannot hide in the
// one style nobody measured.
const WHO = ['lyra', 'ignar', 'seris', 'kaelen', 'volt', 'terra', 'nyx'];
const styles = new Set();
const rows = [];
for (const id of WHO) {
  const def = CHARACTERS[id];
  if (!def) { check(`character ${id} exists`, false); continue; }
  styles.add(def.body.hair);
  const m = measure(def);
  rows.push({ id, style: def.body.hair, ...m });
  console.log(`\n${id} (${def.body.hair}, ${m.hairTris} hair tris)`);
  check(`${id}: forehead band covered`, m.frac >= MIN_BAND,
    `${(m.frac * 100).toFixed(1)}% >= ${MIN_BAND * 100}%`);
  check(`${id}: fringe's own band covered`, m.low >= MIN_FRINGE,
    `${(m.low * 100).toFixed(1)}% of ${m.lowTot} cells below pitch ${FRINGE_P}`);
  check(`${id}: no comb between the locks`, m.gapRuns <= MAX_GAP_RUNS,
    `${m.gapRuns} interior gap run(s), ${m.gapCells} cell(s) <= ${MAX_GAP_RUNS}`);
  check(`${id}: no bare patch of forehead`, m.biggest <= MAX_BARE,
    `biggest ${m.biggest} cell(s) <= ${MAX_BARE}`);
  check(`${id}: the hem has teeth`, m.tips >= MIN_TIPS, `${m.tips} >= ${MIN_TIPS}`);
  check(`${id}: the hem is not level`, m.adjMean >= MIN_ADJ,
    `neighbouring teeth differ by ${m.adjMean.toFixed(3)} >= ${MIN_ADJ} rad`
    + ` (hem roughness ${m.rough.toFixed(3)})`);
  check(`${id}: the fringe reaches the brow`, m.lowest <= MAX_LOWEST,
    `lowest tooth at pitch ${m.lowest.toFixed(3)} <= ${MAX_LOWEST}`);
  check(`${id}: the iris is not under the hair`, m.irisCells >= MIN_IRIS_CELLS && m.irisHidden === 0,
    `${m.irisHidden} of ${m.irisCells} iris cell(s) behind hair`);
  m.brows.forEach((b, k) => {
    const side = k ? 'right' : 'left';
    if (!b) { check(`${id}: ${side} brow found`, false, 'no matBrow triangles on this side'); return; }
    check(`${id}: ${side} brow arches`, b.arch >= MIN_ARCH,
      `middle rides ${b.arch.toFixed(4)} R above its ends (>= ${MIN_ARCH})`);
    check(`${id}: ${side} brow tapers outward`, b.taper <= MAX_TAPER,
      `outer/inner thickness ${b.taper.toFixed(2)} <= ${MAX_TAPER}`);
    check(`${id}: ${side} brow span sane`, b.span >= SPAN[0] && b.span <= SPAN[1],
      `${b.span.toFixed(3)} rad in [${SPAN}]`);
    check(`${id}: ${side} brow weight sane`, b.thick >= THICK[0] && b.thick <= THICK[1],
      `${b.thick.toFixed(3)} R in [${THICK}]`);
  });
}

console.log('\n--- every hair style got measured');
const HAIRS = ['short', 'longWave', 'longStraight', 'ponytail', 'twinTail', 'bun', 'spiky'];
for (const h of HAIRS) check(`style ${h} measured`, styles.has(h), [...styles].join(','));

console.log('\n  worst-first, fringe band coverage:');
for (const r of [...rows].sort((a, b) => a.low - b.low)) {
  console.log(`   ${r.id.padEnd(8)} ${r.style.padEnd(13)} band ${(r.frac * 100).toFixed(1)}%`
    + ` fringe ${(r.low * 100).toFixed(1)}% gaps ${String(r.gapRuns).padStart(2)}`
    + ` bare ${String(r.biggest).padStart(3)} teeth ${r.tips}`
    + ` Δ ${r.adjMean.toFixed(3)} rough ${r.rough.toFixed(3)} lowest ${r.lowest.toFixed(3)}`
    + ` iris hidden ${r.irisHidden}/${r.irisCells}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
// 16 per body plus one per hair style: a green run that measured nothing is the failure
// mode this count exists for.
const want = WHO.length * 16 + HAIRS.length;
if (pass + fail < want) {
  console.log(`only ${pass + fail} assertions ran — expected ${want}`);
  process.exit(1);
}
process.exit(fail ? 1 : 0);
