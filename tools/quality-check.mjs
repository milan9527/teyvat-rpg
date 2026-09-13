// Does the adaptive-quality governor actually converge, and does it stay converged?
//
// This is a unit test in the only form this repo can run one: the governor was written as
// pure arithmetic over frame times (no THREE, no DOM), so node can import it straight out
// of client/src and drive it with a virtual clock. Checking it in a browser instead would
// mean a three-minute Firefox probe per scenario, and the scenario that matters most — a
// machine fast enough for 标准 but not 高 — cannot be produced on demand at all.
//
//   node tools/quality-check.mjs
//
// The machine model is one number: given a tier, how many milliseconds does a frame take.
// `sim` feeds the governor 500 ms buckets from that model until the clock runs out, then
// reports where it ended up and how many times it changed its mind. The oscillation
// scenario is the important one — a controller that flips between two tiers forever is
// worse than one stuck on the wrong tier, because every flip rebuilds the whole scatter.
import { QualityGovernor, TIERS } from '../client/src/engine/perf.js';

/** Run `seconds` of virtual time against a machine model; return the trace. */
function sim(model, { seconds = 120, tier = 'high', ceiling = null, hitchEvery = 0, jitter = 0 } = {}) {
  const changes = [];
  const g = new QualityGovernor({
    tier, ceiling, onChange: (q, { from, reason }) => changes.push([+t.toFixed(1), from, q, reason]),
  });
  let t = 0;
  let nextHitch = hitchEvery;
  const rand = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
  while (t < seconds) {
    let ms = model(g.tier);
    if (jitter) ms *= 1 + (rand() - 0.5) * 2 * jitter;
    // A hitch is one long frame inside an otherwise fine bucket: a shader compile, a GC
    // pause, a streamed cell. The bucket average rises for exactly one sample.
    if (hitchEvery && t >= nextHitch) { ms = (ms * 30 + 400) / 31; nextHitch = t + hitchEvery; }
    // Buckets close at 500 ms *or* one frame, whichever is longer — that is what the
    // renderer does, and it is why a 3 fps machine still produces usable samples.
    t += Math.max(0.5, ms / 1000);
    g.sample(ms, t * 1000);
  }
  return { tier: g.tier, changes, report: g.report() };
}

/** A machine that can hold `best` and everything below it, and nothing above. */
const machine = (best, fast = 16.7, slow = 55) => (tier) =>
  TIERS.indexOf(tier) <= TIERS.indexOf(best) ? fast : slow;

let fails = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) fails++;
}

// 1. Software rendering: 3 fps at every tier. This is the case that motivated the whole
// feature — the scene tour measures exactly this under llvmpipe. It must bottom out at
// 流畅 and stop, not keep trying.
{
  const r = sim(() => 333, { seconds: 120 });
  check('llvmpipe (3 fps) bottoms out at low', r.tier === 'low', `tier=${r.tier} changes=${r.changes.length}`);
  check('...and gets there fast', r.changes.length <= 2 && r.changes[0][0] < 6,
    r.changes.map((c) => `${c[0]}s ${c[1]}->${c[2]}`).join(', '));
}

// 2. A machine that holds the asked-for tier is left alone. A governor that fiddles with a
// fine machine is a bug, not a feature.
{
  const r = sim(() => 16.7, { seconds: 120 });
  check('60 fps at high stays at high', r.tier === 'high' && r.changes.length === 0,
    `tier=${r.tier} changes=${r.changes.length}`);
}

// 3. Recovery: booted at low (say the player saved it there once), machine is fine, ceiling
// is high. It should climb — and stop at the ceiling, never above it.
{
  const r = sim(() => 16.7, { seconds: 180, tier: 'low', ceiling: 'high' });
  check('a fast machine climbs back to the ceiling', r.tier === 'high', `tier=${r.tier}`);
  check('...and does not exceed it', !r.changes.some((c) => c[2] === 'ultra'), JSON.stringify(r.changes));
  // Each step must be earned by a full window of good frames, not by however many buckets
  // fit in two seconds. The first version climbed low → medium → high inside 8 s.
  check('...one window per step, not one every few seconds',
    r.changes.length === 2 && r.changes[0][0] >= 9 && r.changes[1][0] - r.changes[0][0] >= 9,
    r.changes.map((c) => `${c[0]}s ${c[1]}->${c[2]}`).join(', '));
}

// 4. The oscillation trap: fast at 标准, too slow at 高, ceiling 极致. A naive controller
// climbs, drops, climbs, drops forever. This one must give up after a bounded number of
// attempts and hold 标准.
{
  const r = sim(machine('medium'), { seconds: 900, tier: 'medium', ceiling: 'ultra' });
  const late = r.changes.filter((c) => c[0] > 600).length;
  check('cannot hold high: settles on medium', r.tier === 'medium', `tier=${r.tier}`);
  check('...and stops trying (bounded churn)', r.changes.length <= 6 && late === 0,
    `${r.changes.length} changes in 15 min, ${late} of them after t=600s`);
}

// 5. Hitch immunity: 60 fps with a 400 ms stall every three seconds. Median-of-buckets is
// supposed to absorb that; a mean would not.
{
  const r = sim(() => 16.7, { seconds: 120, hitchEvery: 3 });
  check('a stall every 3 s does not trigger a downgrade', r.changes.length === 0,
    JSON.stringify(r.changes));
}

// 6. A machine whose frame time does not depend on the tier at all — pinned at the 25 fps
// line whatever the renderer does, which is what a CPU-bound simulation or a browser with
// no GPU acceleration looks like. Stripping the scene cannot fix that, so the governor must
// notice the first drop bought nothing and stop, rather than strip everything and still be
// at 25 fps. Jittered across the threshold so the decision cannot be knife-edge luck.
{
  const r = sim(() => 40, { seconds: 300, jitter: 0.25, tier: 'high', ceiling: 'high' });
  check('a drop that buys nothing stops the descent', r.changes.length === 1 && r.tier === 'medium',
    `tier=${r.tier} changes=${r.changes.length} floored=${r.report.floored}`);
  check('...and says so in the report', r.report.floored === true);
}

// 7. `busy` really suppresses: a zone load's worth of terrible buckets inside the settle
// window must be discarded, not averaged in.
{
  const g = new QualityGovernor({ tier: 'high', onChange: () => { throw new Error('changed during settle'); } });
  g.busy(6);
  let t = 0;
  for (let i = 0; i < 10; i++) { t += 0.5; g.sample(500, t * 1000); }
  check('samples inside the settle window are ignored', g.tier === 'high');
  // ...and once it is over, the same machine is judged immediately on fresh evidence.
  const seen = [];
  g.onChange = (q) => seen.push(q);
  for (let i = 0; i < 12; i++) { t += 0.5; g.sample(500, t * 1000); }
  check('...and acted on as soon as it closes', seen.length > 0 && g.tier === 'low', `tier=${g.tier}`);
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
