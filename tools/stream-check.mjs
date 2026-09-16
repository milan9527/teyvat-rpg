// How much ground is there in front of a walking player, and does it stay there?
//
//   DISPLAY=:99 node tools/stream-check.mjs [baseUrl] [--mutate]
//
// Every other art probe in this repo photographs the world from a *standstill*. That is the one
// state in which scatter streaming cannot be wrong: whatever is resident when the shutter opens
// is what gets graded, and 48 probes have graded it. Walking is a different question, and
// nothing was asking it.
//
// What walking found (.run/grass-stream-lab.mjs, +x through Mondstadt at `high`): `STREAM.grass`
// kept a 3x3 block of 24 m cells about the player's own cell, but `update()` only recomputed
// residency when `floor(px / 32)` changed. 32 is larger than 24, so the block could lag a whole
// cell, and the tuft carpet directly ahead of the player ran out **9.0 metres** in front of her
// feet — then snapped back to 31.9 m in a single step, tripling the tufts inside 30 m (161 →
// 1678) every 32 m walked. A +/-12 degree wedge could not see it: the wedge reported 32.7 m at
// that same worst step, because a wedge measures its *diagonal* reach and the diagonals were
// still covered. The corridor straight ahead is what a walking player reads.
//
// So the assertions are about a floor and a derivative:
//
//   * the grass carpet reaches at least MIN_AHEAD metres straight ahead at *every* step, from
//     every sub-cell offset the walk lands on — a guarantee, not an average
//   * the number of tufts inside 30 m ahead does not jump between steps, and does not swing
//     across the walk (this is what "the grass pops in" is, measured)
//   * residency is a radius in metres, not a block of cell indices: every grass cell within
//     `reach` is resident, and nothing far past it is
//   * the player is never far from where residency was last computed, which is the defect above
//     stated as a property rather than as a symptom
//   * and the price of all that is bounded: resident instances, batched meshes, draw calls
//
// Two authoring rules come with it, read off the exported table rather than out of a comment: a
// group takes `rings` or `reach` and not both, and `RESTREAM_STEP` must be finer than every cell
// a `reach` group moves — that inequality *is* the bug, and 32 > 24 is what it looked like.
//
// `--mutate` flips grass back to `rings: 1` in `STREAM` and re-walks. It must red the reach
// floor: that is the difference between a measurement and a coincidence.
//
// Pins `high` (llvmpipe boots probes at `low`, which scatters 30 % of the tufts) and stops the
// game loop, driving `world.update` with the position under test so a 3 fps browser cannot
// decide how far the party walked. No screenshots: this reads instance matrices.
import puppeteer from 'puppeteer';
import { bootWorld } from './lib/probe-world.mjs';

const APP = process.env.GAME_APP || process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5173';
const MUTATE = process.argv.includes('--mutate');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passes = 0, fails = 0, skips = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passes++; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); } else {
    fails++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
  return !!ok;
};
const skip = (name, why) => { skips++; console.log(`  SKIP ${name} — ${why}`); };

// --- bars, all set after the first green run ----------------------------------------------
// `STREAM.grass` is `{ cell: 24, reach: 32 }` and the trigger is 3 m of walking, so the floor
// the design guarantees is 32 - 3 = 29 m in the worst direction from the worst sub-cell offset.
// Measured over two headings at 0.5 m steps, 194 steps: 31.0-60.0 m, and a 3x3 block scores
// exactly 24.0 m on the same walk. 28 sits between the two: under the guarantee, and three times
// what the 32 m grid left ahead of a walking player (9.0 m).
const MIN_AHEAD = 28;
// A guarantee that is also a ceiling: a reach so large that the carpet never ends is not this
// probe going green, it is somebody having spent the frame budget. The far edge is invisible
// anyway — .run/grass-fade-lab.mjs measured tuft coverage down to 5-9 % by 33-44 m.
const MAX_AHEAD = 70;
// The pop, as a ratio of tuft counts inside 30 m between consecutive 0.7 m steps. The old
// trigger's worst was 10.4x (161 → 1678). Measured now: 1.09x. Deliberately a loose bar: it is
// here to refuse a carpet that materialises in one frame, and a 3x3 block recentred every 3 m
// scores 1.24x on it — near enough to the bar that the reach floor above, not this, is the
// assertion the mutation test holds responsible.
const MAX_POP = 1.25;
// And across the whole walk, which is the same defect at a lower frequency: 11.0x before,
// 1.23x now, 1.42x under the mutation. The residue is not streaming — it is the ground, because tuft density is a
// function of slope and the walk climbs — so this bar is deliberately the looser of the two
// and the step-to-step ratio above is the one that speaks about popping.
const MAX_SWING = 1.5;
// How far the player may be from where residency was last computed. RESTREAM_STEP is 3 m and
// the walk steps 0.5 m, so 3.5 m is the true worst case (measured 3.00); the old grid, which
// only recomputed when `floor(px / 32)` changed, reached 45 m.
const MAX_LAG = 3.8;
// The price. Resident grass instances went 44.4-44.7k (a 3x3 block) → 49.1-68.9k (a 32 m
// radius, 10-14 cells), and the pooled batches mean it costs *no* extra draw calls: the tuft
// mesh count is a property of the zone's recipes, not of how many cells are resident.
const MAX_GRASS_INST = 85000;
const MAX_TUFT_MESHES = 60;
const MAX_CALLS = 400;

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: { 'webgl.force-enabled': true, 'webgl.disable-fail-if-major-performance-caveat': true },
  args: ['--width=1024', '--height=640'],
  defaultViewport: { width: 1024, height: 640 },
});
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));

await bootWorld(p, { base: APP, check, label: 'a fresh guest' });
const tier = await p.evaluate(() => {
  const g = window.game;
  g.setAutoQuality(false);
  g.setQuality('high');
  g.setWorldTime(12);
  g.stop();
  return { quality: g.quality, zone: g.world?.zone?.id ?? null };
});
check('the probe grades the tier the player is shown', tier.quality === 'high',
  `${tier.quality} in ${tier.zone}`);
await sleep(3000);

/* ------------------------------------------------------- the authoring rules -- */

// Off the running world's own `stream`, not off a fresh `import()` of the module: Vite serves
// `world.js?t=…` after any edit, so an imported `STREAM` can be a second copy of the table with
// the same numbers and no connection to the world under test. `RESTREAM_STEP` is a number, so
// the import is safe for that one.
const tune = await p.evaluate(async () => {
  const m = await import('/src/game/world.js');
  return { step: m.RESTREAM_STEP, stream: JSON.parse(JSON.stringify(window.game.world.stream)) };
});
const groups = Object.entries(tune.stream);
const both = groups.filter(([, c]) => (c.rings != null) === (c.reach != null));
check('every scatter group answers residency exactly one way', both.length === 0,
  both.length ? both.map(([g, c]) => `${g}: rings ${c.rings} + reach ${c.reach}`).join(', ')
    : groups.map(([g, c]) => `${g} ${c.reach != null ? `reach ${c.reach}` : `rings ${c.rings}`}`).join(', '));
const reachGroups = groups.filter(([, c]) => c.reach != null);
const coarse = reachGroups.filter(([, c]) => tune.step >= c.cell);
check('the restream trigger is finer than every cell it recentres',
  reachGroups.length > 0 && coarse.length === 0,
  coarse.length ? `step ${tune.step} m vs ${coarse.map(([g, c]) => `${g} cell ${c.cell}`).join(', ')}`
    : `step ${tune.step} m under ${reachGroups.map(([g, c]) => `${g} ${c.cell}`).join(' / ')} m cells`);
const shallow = reachGroups.filter(([, c]) => c.reach <= tune.step * 4);
check('...and every reach is worth more than the lag it carries', shallow.length === 0,
  shallow.length ? shallow.map(([g, c]) => `${g} reach ${c.reach} vs step ${tune.step}`).join(', ')
    : reachGroups.map(([g, c]) => `${g}: ${c.reach} - ${tune.step} = ${c.reach - tune.step} m guaranteed`).join(', '));

/* ------------------------------------------------------------- the walk rig -- */

await p.evaluate(() => {
  const g = window.game;
  const TUFT = /^(grassTuft|sweetFlower|mint|windwheelAster)/;
  // `budget`-limited builds take 2.5 ms a call, so one update cannot finish a cell. Drive until
  // the queue is empty and report how many calls it took — that count is the transient the
  // player would see as a hitch, and it is asserted below.
  window.__step = (x, z, calls = 600) => {
    const w = g.world;
    g.me.x = x; g.me.z = z;
    g.me.y = w.terrain.heightAt(x, z);
    let i = 0;
    for (; i < calls; i++) {
      w.update(0.016, i * 0.016, x, g.me.y, z, g.camera);
      if (!w.pending.length) break;
    }
    return { calls: i, pending: w.pending.length };
  };
  /**
   * The corridor straight ahead: how far the *grass* group reaches within `halfWidth` metres of
   * the direction of travel, and how much of it stands inside 30 m. A wedge is the wrong shape —
   * it answers with its diagonals, which are exactly what a lagging block still covers.
   */
  // One traverse, both readings: the scene holds ~70k tuft instances and each pass over it
  // costs more than everything else this probe does.
  window.__ahead = (fx, fz, halfWidth = 3) => {
    const m = new g.camera.matrixWorld.constructor();
    let far = 0, n = 0, near = 0, all = 0, grassInst = 0, meshes = 0;
    g.scene.updateMatrixWorld(true);
    g.scene.traverse((o) => {
      if (!o.isInstancedMesh || !TUFT.test(o.name || '')) return;
      const grass = /^grassTuft/.test(o.name);
      meshes++;
      if (grass) grassInst += o.count;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        m.premultiply(o.matrixWorld);
        const dx = m.elements[12] - g.me.x, dz = m.elements[14] - g.me.z;
        const along = dx * fx + dz * fz;
        if (along <= 0 || Math.abs(dx * -fz + dz * fx) > halfWidth) continue;
        all++;
        if (!grass) continue;
        n++;
        if (along > far) far = along;
        if (along < 30) near++;
      }
    });
    g.r.render(0.016);
    return { far: +far.toFixed(2), n, near, all,
      cost: { grass: grassInst, meshes, calls: g.r.renderer.info.render.calls } };
  };
  /**
   * Residency as the metre question, checked both ways: the worst-covered direction, any cell
   * inside `reach` that is missing, and the furthest cell still being paid for.
   */
  window.__residency = async () => {
    const { RESTREAM_STEP } = await import('/src/game/world.js');
    const w = g.world;
    const STREAM = w.stream;
    const out = {};
    const lagX = w._streamAt ? g.me.x - w._streamAt[0] : NaN;
    const lagZ = w._streamAt ? g.me.z - w._streamAt[1] : NaN;
    out.lag = +Math.hypot(lagX, lagZ).toFixed(2);
    // Counted off the cell map rather than off the loop below, so it is still reported for a
    // group that has no `reach` at all — which is what the mutation turns grass into.
    out.grassCells = [...w.cells.keys()].filter((k) => k.startsWith('grass:')).length;
    for (const rec of w.recipes) {
      const cfg = STREAM[rec.group];
      if (!cfg.reach || out[rec.group]) continue;
      const sx = w._streamAt ? w._streamAt[0] : g.me.x, sz = w._streamAt ? w._streamAt[1] : g.me.z;
      let missing = 0, worst = Infinity, farthest = 0, resident = 0;
      const span = Math.ceil(cfg.reach / cfg.cell) + 2;
      const cx = Math.floor(sx / cfg.cell), cz = Math.floor(sz / cfg.cell);
      const dist2 = (gx, gz, px, pz) => {
        const ex = Math.max(gx * cfg.cell - px, px - (gx + 1) * cfg.cell, 0);
        const ez = Math.max(gz * cfg.cell - pz, pz - (gz + 1) * cfg.cell, 0);
        return ex * ex + ez * ez;
      };
      for (let dz = -span; dz <= span; dz++) {
        for (let dx = -span; dx <= span; dx++) {
          const gx = cx + dx, gz = cz + dz;
          const has = w.cells.has(`${rec.group}:${gx},${gz}`);
          const d = Math.sqrt(dist2(gx, gz, sx, sz));
          if (d <= cfg.reach - 0.01 && !has) { missing++; worst = Math.min(worst, d); }
          if (has) { resident++; farthest = Math.max(farthest, d); }
        }
      }
      out[rec.group] = { reach: cfg.reach, cell: cfg.cell, missing, resident,
        worst: Number.isFinite(worst) ? +worst.toFixed(1) : null, farthest: +farthest.toFixed(1),
        step: RESTREAM_STEP };
    }
    return out;
  };
  // Forget every resident cell, so a walk owes nothing to the walk before it. Both walks and
  // both configurations then traverse the same ground from the same cold start, which is the
  // only way the mutant numbers can be compared with the baseline ones.
  window.__reset = () => { g.world.setQuality(g.world.quality); return g.world.cells.size; };
  /**
   * What a frame costs, in milliseconds the player waits for.
   *
   * `render()` returns when the commands are queued, not when the picture exists — timed that way
   * a Mondstadt frame reads 4 ms on a browser whose own HUD says 2 fps. A 1x1 `readPixels` after
   * the frame blocks until the driver has drawn it. Median of `n`, because llvmpipe's first frame
   * after a camera move pays for shader and texture warm-up that no later frame pays again.
   */
  window.__cost = (n = 16) => {
    const gl = g.r.renderer.getContext();
    const px = new Uint8Array(4);
    const t = [];
    for (let i = 0; i < n + 4; i++) {
      const t0 = performance.now();
      g.r.render(0.016);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (i >= 4) t.push(performance.now() - t0);       // the first four are warm-up
    }
    t.sort((a, b) => a - b);
    let grass = 0;
    g.scene.traverse((o) => { if (o.isInstancedMesh && /^grassTuft/.test(o.name || '')) grass += o.count; });
    return { med: +t[t.length >> 1].toFixed(1), min: +t[0].toFixed(1), max: +t[t.length - 1].toFixed(1),
      tris: g.r.renderer.info.render.triangles, calls: g.r.renderer.info.render.calls, grass };
  };
  // The mutation: residency by cell index again, from the same table the product reads. A whole
  // re-stream has to follow, because every resident cell was chosen under the old rule.
  window.__mutate = () => {
    const s = g.world.stream;
    const was = { ...s.grass };
    delete s.grass.reach;
    s.grass.rings = 1;
    return { was: was.reach, now: s.grass.rings };
  };
  return true;
});

// Where the walks start, captured once. Every walk is driven from this anchor rather than from
// wherever the last one stopped: the claim is a *floor over sub-cell offsets*, and a mutant that
// walks 100 m further along has been handed a different set of offsets to be lucky with. The
// first version of this probe let the walks chain, and the 3x3 mutation came back green because
// its walk happened to miss every offset near the far edge of a cell.
const ORIGIN = await p.evaluate(() => [+window.game.me.x.toFixed(2), +window.game.me.z.toFixed(2)]);

/**
 * Walk one heading in STEP-metre steps from the anchor.
 *
 * STEP divides 24 and 32, which is the point: 0.5 m steps visit offsets 0, 0.5 … 23.5 of the
 * grass cell exactly, so the worst sub-cell position a `rings` block can be caught in is
 * actually *in the sample*. A step that does not divide the cell samples offsets by luck.
 */
const STEP = 0.5;
const walk = async (label, fx, fz, steps = 96) => {
  await p.evaluate(() => window.__reset());
  const rows = [];
  for (let s = 0; s <= steps; s++) {
    const x = ORIGIN[0] + fx * STEP * s, z = ORIGIN[1] + fz * STEP * s;
    const drv = await p.evaluate((a) => window.__step(a[0], a[1]), [x, z]);
    const ahead = await p.evaluate((a) => window.__ahead(a[0], a[1]), [fx, fz]);
    const res = await p.evaluate(() => window.__residency());
    rows.push({ label, s, x, z, ...ahead, res, grassCells: res.grassCells, ...drv });
  }
  return rows;
};

const HEADINGS = [['+x', 1, 0], ['diagonal', Math.SQRT1_2, Math.SQRT1_2]];
const rows = [];
for (const [label, fx, fz] of HEADINGS) rows.push(...await walk(label, fx, fz));

/* ------------------------------------------------------------- assertions -- */

// `sink` is where the verdicts go. The mutant walk grades into a local tally instead of the
// probe's own, because a mutation that works produces reds on purpose and a probe whose summary
// line counts them is a probe nobody can read.
const grade = (all, tag, sink = check) => {
  const far = all.map((r) => r.far);
  const near = all.map((r) => r.near);
  const lag = all.map((r) => r.res.lag);
  const worstRow = all.reduce((a, r) => (r.far < a.far ? r : a), all[0]);
  let pop = 1;
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1].near, b2 = all[i].near;
    if (a > 0 && b2 > 0) pop = Math.max(pop, a / b2, b2 / a);
  }
  const swing = Math.min(...near) > 0 ? Math.max(...near) / Math.min(...near) : Infinity;
  const ok = sink(`${tag}the grass carpet reaches ${MIN_AHEAD} m straight ahead at every step`,
    Math.min(...far) >= MIN_AHEAD,
    `worst ${Math.min(...far).toFixed(1)} m at ${worstRow.label} x=${worstRow.x.toFixed(1)},`
    + ` z=${worstRow.z.toFixed(1)} (${worstRow.n} tufts in the corridor); best ${Math.max(...far).toFixed(1)} m`);
  sink(`${tag}...and does not reach so far that residency is paying for fog`,
    Math.max(...far) <= MAX_AHEAD, `${Math.max(...far).toFixed(1)} m of ${MAX_AHEAD} allowed`);
  const okPop = sink(`${tag}the tufts inside 30 m do not pop in as the player walks`,
    pop <= MAX_POP, `worst step-to-step ratio ${pop.toFixed(2)}x, bar ${MAX_POP}x`);
  sink(`${tag}...and the count does not swing across the walk`,
    swing <= MAX_SWING,
    `${Math.min(...near)}-${Math.max(...near)} tufts, ${swing.toFixed(2)}x, bar ${MAX_SWING}x`);
  sink(`${tag}the player is never far from where residency was computed`,
    Math.max(...lag) <= MAX_LAG,
    `worst ${Math.max(...lag).toFixed(2)} m, step ${all[0].res.grass?.step ?? '?'} m`);
  // Both halves, and the radius-group count is inside the condition rather than beside it: with
  // no group answering residency in metres there is nothing here to be right about, and a
  // vacuous green is what this repo keeps catching itself at.
  const radius = Object.values(all[0].res).filter((v) => v && v.reach != null).length;
  const missing = all.filter((r) => Object.values(r.res).some((v) => v && v.missing > 0));
  sink(`${tag}every cell inside a group's reach is resident`, radius >= 1 && missing.length === 0,
    missing.length ? `${missing.length} step(s), worst gap at ${missing[0].res.grass?.worst} m`
      : `${all.length} steps x ${radius} radius group(s)`);
  const over = all.filter((r) => Object.values(r.res)
    .some((v) => v && v.farthest > v.reach + v.cell + v.step));
  sink(`${tag}...and nothing much past it is`, radius >= 1 && over.length === 0,
    over.length ? `${over.length} step(s), farthest ${over[0].res.grass?.farthest} m`
      : `farthest resident cell ${Math.max(...all.map((r) => r.res.grass?.farthest ?? 0)).toFixed(1)} m`
        + ` of a ${all[0].res.grass?.reach} m reach on ${all[0].res.grass?.cell} m cells`);
  return { ok, okPop, far, near, pop, swing, lag };
};

const g1 = grade(rows, '');
const inst = rows.map((r) => r.cost.grass);
const meshes = rows.map((r) => r.cost.meshes);
const calls = rows.map((r) => r.cost.calls);
check('the carpet is paid for in instances, not in draw calls',
  Math.max(...inst) <= MAX_GRASS_INST && Math.max(...meshes) <= MAX_TUFT_MESHES,
  `${Math.min(...inst)}-${Math.max(...inst)} grass instances in ${Math.min(...meshes)}-${Math.max(...meshes)}`
  + ` batched meshes, ${Math.min(...calls)}-${Math.max(...calls)} draw calls`);
check('a restream never queues more than the frame budget can absorb',
  Math.max(...rows.map((r) => r.calls)) <= MAX_CALLS && rows.every((r) => r.pending === 0),
  `worst ${Math.max(...rows.map((r) => r.calls))} budgeted drains of ${MAX_CALLS} allowed`);
check('no page errors through any of it', errs.length === 0, errs.slice(0, 3).join(' | '));

/* --------------------------------------------------------------- mutation -- */

let died = null;
if (MUTATE) {
  const m = await p.evaluate(() => window.__mutate());
  console.log(`\n  mutation: STREAM.grass reach ${m.was} -> rings ${m.now}`);
  const mrows = [];
  for (const [label, fx, fz] of HEADINGS) mrows.push(...await walk(label, fx, fz));
  const mut = [];
  const g2 = grade(mrows, 'MUTANT: ', (n, ok, d) => {
    mut.push(ok); console.log(`  ${ok ? 'green' : 'RED  '} ${n}${d ? ' — ' + d : ''}`); return !!ok;
  });
  // Did the mutation reach the world, or only a copy of its table? A 3x3 block is at most 9
  // cells; the radius keeps 10-14. Without this the run above reported the mutant scoring
  // *identically* to the baseline, tuft for tuft, and called it a surviving mutant.
  const cellsOf = (all) => all.map((r) => r.grassCells);
  const landed = Math.max(...cellsOf(mrows)) <= 9 && Math.max(...cellsOf(rows)) > 9;
  check('the mutation reaches the world, not a second copy of its table', landed,
    `${Math.min(...cellsOf(rows))}-${Math.max(...cellsOf(rows))} grass cells by radius vs`
    + ` ${Math.min(...cellsOf(mrows))}-${Math.max(...cellsOf(mrows))} in a 3x3 block`);
  // The reach floor is the assertion that owns this defect, so it is the one the mutation has to
  // kill. The pop gate is a symptom whose amplitude depends on where the walk starts — under a
  // 3x3 block it measured 1.24x against a 1.25x bar, which is a coin toss, and under the old
  // 32 m trigger it was 10.4x, which is not. Reporting both and requiring one says which is which.
  died = landed && !g2.ok;
  console.log(`\n  under a 3x3 block the reach floor ${g2.ok ? 'stayed green' : 'went red'}`
    + ` and the pop gate ${g2.okPop ? 'stayed green' : 'went red'}`
    + ` — worst ${Math.min(...g2.far).toFixed(1)} m ahead (was ${Math.min(...g1.far).toFixed(1)} m),`
    + ` pop ${g2.pop.toFixed(2)}x (was ${g1.pop.toFixed(2)}x);`
    + ` ${mut.filter((x) => !x).length} of ${mut.length} mutant assertions red`);
} else {
  skip('the reach floor is red under a 3x3 block', 'run with --mutate');
}

/* ------------------------------------------------------------ the frame bill -- */

// Instances, meshes and draw calls were all flat or nearly so, and none of them is time. Time is
// what two other probes found: weather-check's dome shot went back to capturing the previous
// camera and puzzle-check's follow camera stopped catching up, both because the frame got longer.
// So the same A/B the mutation uses, priced in milliseconds: settle here, time the frames, put
// grass back on a 3x3 block, settle again, time again. The bar is the *ratio*, which is the only
// scale-free part of a number that belongs to this machine's software renderer.
const MAX_FRAME_RATIO = 1.2;
if (!MUTATE) {
  await p.evaluate((a) => window.__step(a[0], a[1]), ORIGIN);
  const reachCost = await p.evaluate(() => window.__cost());
  await p.evaluate(() => { window.__mutate(); window.game.world._streamAt = null; });
  await p.evaluate((a) => window.__step(a[0], a[1]), ORIGIN);
  const ringCost = await p.evaluate(() => window.__cost());
  const ratio = reachCost.med / ringCost.med;
  console.log(`\n  frame ${reachCost.med} ms with the 32 m radius (${reachCost.grass} tufts,`
    + ` ${(reachCost.tris / 1000).toFixed(0)}k tris) vs ${ringCost.med} ms on a 3x3 block`
    + ` (${ringCost.grass} tufts, ${(ringCost.tris / 1000).toFixed(0)}k tris)`);
  // Both halves: the ratio has to be small, and the A/B has to have moved the thing being priced.
  // A mutation that changed no instances would report a lovely 1.00x about nothing.
  check('the carpet costs a fraction of a frame, not a frame',
    ratio <= MAX_FRAME_RATIO && reachCost.grass > ringCost.grass * 1.05,
    `${ratio.toFixed(2)}x of a 3x3 block's frame (bar ${MAX_FRAME_RATIO}x) for`
    + ` ${(reachCost.grass / ringCost.grass).toFixed(2)}x the tufts`);
} else {
  skip('the carpet costs a fraction of a frame', 'the table is already mutated');
}

/* --------------------------------------------------------------- evidence -- */

console.log('\n  heading      x       z | grass ahead | inside 30 m | resident | lag  | instances');
for (const r of rows.filter((q, i) => i % 12 === 0)) {
  console.log(`  ${r.label.padEnd(9)} ${r.x.toFixed(1).padStart(6)} ${r.z.toFixed(1).padStart(7)} |`
    + ` ${r.far.toFixed(1).padStart(8)} m |`
    + ` ${String(r.near).padStart(11)} |`
    + ` ${String(r.res.grass?.resident ?? '?').padStart(8)} |`
    + ` ${r.res.lag.toFixed(2).padStart(4)} |`
    + ` ${String(r.cost.grass).padStart(9)}`);
}

console.log(`\nstream-check: ${passes} passed, ${fails} failed, ${skips} skipped`);
await b.close();
// In `--mutate` the mutant reds are the point, so the exit code asks the only question left:
// did the mutation actually land? A mutation that cannot kill the gate means the gate is
// measuring something else.
process.exit(MUTATE ? (died ? 0 : 1) : fails);
