// Do the characters' feet stay on the ground they are standing on?
//
//   DISPLAY=:99 node tools/gait-check.mjs [baseUrl]
//
// Every other motion probe in this repo asks whether a pose *differs* from another pose:
// `motion-check` photographs 23 clips and compares silhouettes, which catches a clip that
// was never wired and a clip that is secretly another clip, and cannot see the defect this
// probe was written for. A walk cycle can be a perfectly good silhouette at every phase and
// still skate, because skating is not a property of any single frame — it is the relationship
// between the phase rate and how far the body moved, and you have to march the character to
// see it.
//
// Marching it found this, and it was not subtle. The three locomotion clips each carried a
// hand-written stride (1.55 / 2.30 / 2.85 metres per cycle) while the legs they drive only
// swept the ankle 0.51-0.58 m: 30-50% of the ground every character covered was covered by
// sliding, and the error grew with height, because the stride was a constant in metres and
// the sweep is a property of the leg. The dump of the ankle's own trajectory showed why
// nobody could fix that by re-tuning the constant: the ankle was *highest* at its furthest
// point back and dipped twice per cycle while moving forward the whole time. There was no
// stance phase at all. It was a pendulum, not a gait, and a pendulum has no speed at which
// its foot is still.
//
// So the assertions here are about the one thing a gait has to do:
//
//   * the foot the gait says is planted does not move in the world while it is planted
//   * ...and it is on the ground while it is planted, and off it while it swings
//   * the stride is the identity `sweep / duty` rather than a number anyone typed
//   * the pelvis is lower at each footfall than between them, and does not sink to a crouch
//   * a footfall event happens twice per cycle, from the same phase that placed the feet
//
// Two things worth knowing about the measurement:
//
//   * **One stance window, not all of them.** The first version filtered every sample whose
//     phase fraction was inside the duty cycle and took max-min of the ankle's world z. That
//     spans several footfalls, so it reported a "slide" of exactly two strides — 0.98 of the
//     body's travel — on a build whose feet were already planted to the millimetre. The
//     window has to be a single contiguous stance.
//   * **The product's own pairing.** The rig group is advanced by `speed * dt` exactly as
//     `localPlayer` does through `actor.setPose`, and the animator is handed the same
//     `speed` exactly as `actor.update` does. A probe that advances one and not the other is
//     measuring itself. The mutation test at the end is that same march with the body moved
//     30% further than the animator was told about — the defect this probe exists to catch —
//     and the slide assertion has to go red for it.
//
// No rendering, no tier, no screenshots: this reads bone matrices off rigs built in a page
// that has the modules. Exit code is the number of failed assertions.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { CHARACTERS } from '../shared/src/data/characters.js';

const APP = process.env.GAME_APP || process.argv[2] || 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passes = 0, fails = 0, skips = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); } else {
    fails++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
  return !!ok;
}
function skip(name, why) { skips++; console.log(`  SKIP ${name} — ${why}`); }

// The speeds the product actually produces: WALK 2.3, RUN 5.2, SPRINT 8.2 from localPlayer,
// plus a stroll and the two band boundaries autoLocomotion switches on (2.6 / 5.4).
const SPEEDS = [1.0, 1.4, 2.3, 2.6, 4.0, 5.2, 5.4, 8.2];

// --- bars, all set after the first green run ---------------------------------------------
// Worst measured slide was 1.0% of the body's travel (8.3 mm) at 8.2 m/s, and 0.2-0.4% at
// walking speeds; the residue is the pelvis roll's lateral component, which the sagittal leg
// solver cannot cancel, plus the integration step. 4% is four times the worst case and still
// an eighth of what the old constant-stride cycle produced.
const MAX_SLIDE_FRAC = 0.04;
const MAX_SLIDE_M = 0.03;
// The ankle rides up onto heel and toe at the ends of a stance (ANKLE_ROLL = 3.5% of a leg,
// measured 2.6-3.5 cm at the strike), and must be flat on the ground in the middle of it. Both
// ends are asserted: no roll at all is a rigid slab of a foot pivoting about nothing, and too
// much is a character walking on stilts. The first version of this bar said 8 mm at the strike
// and was simply an opinion — it contradicted the roll the gait deliberately authors, and the
// only thing it caught was ignar's 34.5 mm heel at 8.2 m/s, which is the model working.
const MAX_STANCE_Y = 0.05;
const ROLL_AT_STRIKE = [0.015, 0.05];
const MAX_MID_Y = 0.008;
// A swing that does not clear the ground is a drag. Measured 10-21 cm, i.e. 0.12-0.23 of a leg.
const MIN_SWING_LIFT = 0.06;
// Cadence: measured 1.20-1.97 cycles/s over 1.0-8.2 m/s. Below 0.7 the character moon-walks
// between footfalls; above 2.4 the legs blur.
const CADENCE = [0.7, 2.4];
// The pelvis: measured 1.7-2.0 cm of bob at a walk and 5.4-5.9 at a sprint, sitting 4.6 cm
// (walk) to 15 cm (sprint) below standing hip height. Both ends matter — no bob is a floating
// mannequin, and a crouch past a fifth of the leg is a stealth pose.
const MIN_BOB = 0.006;
const MAX_CROUCH = 0.20;

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: { 'webgl.force-enabled': true, 'webgl.disable-fail-if-major-performance-caveat': true },
  defaultViewport: { width: 900, height: 600 },
});
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
await p.goto(APP, { waitUntil: 'domcontentloaded' });
await sleep(4500);

const DEFS = Object.entries(CHARACTERS).map(([id, d]) => ({ id, def: d, h: d.body.height }));

const data = await p.evaluate(async (defs, speeds) => {
  const { buildHumanoid } = await import('/src/gfx/humanoid.js');
  const { Animator, CLIPS } = await import('/src/gfx/animator.js');

  /**
   * March one character at one speed and report what the feet and pelvis did.
   * `bodyScale` is the mutation knob: 1 marches the body exactly as fast as the animator
   * was told, and anything else is the "authored stride is wrong" defect.
   */
  const march = (def, speed, bodyScale = 1) => {
    const rig = buildHumanoid(def, { outline: false });
    const G = rig.group.constructor, V = rig.group.position.constructor;
    const an = new Animator(rig);
    const group = new G();
    group.add(rig.group);
    const clip = an.autoLocomotion({ speed, grounded: true });
    an.base = clip; an.basePhase = 0; an.baseTime = 0; an.fadeFrom = null;
    const dt = 0.005;
    const s = [];
    let x = 0, steps = 0;
    for (let i = 0; i < 80000 && an.basePhase < 4.05; i++) {
      x += speed * bodyScale * dt;
      group.position.set(0, 0, x);                 // +Z is the rig's forward
      an.update(dt, { speed, grounded: true, auto: false });
      steps += an.takeSteps().n;
      group.updateMatrixWorld(true);
      if (an.basePhase < 2) { steps = 0; continue; }  // two cycles to settle
      const l = new V().setFromMatrixPosition(rig.bones.footL.matrixWorld);
      const r = new V().setFromMatrixPosition(rig.bones.footR.matrixWorld);
      s.push({ ph: an.basePhase, x, hipY: rig.bones.hips.position.y, l: [l.z, l.y], r: [r.z, r.y] });
    }
    const g = an.ctx.gait;
    const cyc = Math.floor(s[Math.floor(s.length / 2)].ph);

    // One contiguous stance window per foot, trimmed 2% at each end so the sample straddling
    // the strike or the toe-off cannot leak in.
    const foot = (key, off) => {
      const win = [], swing = [];
      for (const q of s) {
        const u = q.ph + off;
        if (Math.floor(u) !== cyc) continue;
        const t = u - cyc;
        if (t > g.duty * 0.02 && t < g.duty * 0.98) win.push(q);
        else if (t > g.duty) swing.push(q);
      }
      if (win.length < 8) return null;
      const z = win.map((q) => q[key][0]), y = win.map((q) => q[key][1]);
      const body = win[win.length - 1].x - win[0].x;
      const mid = win[Math.floor(win.length / 2)][key][1];
      return {
        n: win.length,
        slide: Math.max(...z) - Math.min(...z),
        body,
        yHi: Math.max(...y), yMid: mid,
        strikeY: win[0][key][1],
        swingLift: swing.length ? Math.max(...swing.map((q) => q[key][1])) : 0,
      };
    };

    // The pelvis over the same cycle: how it sits at each footfall versus between them.
    const cycle = s.filter((q) => Math.floor(q.ph) === cyc);
    // Over a neighbourhood, not at a sample: the drop has a kink at every footfall (the
    // constraint changes legs there), so the nearest sample to the strike can sit millimetres
    // up the V and report a left/right asymmetry that the curve does not have.
    const near = (u, w) => cycle.filter((q) => Math.abs(q.ph - cyc - u) < w).map((q) => q.hipY);
    const dip = (u) => Math.min(...near(u, 0.05));
    const crest = (u) => Math.max(...near(u, 0.06));
    const hips = cycle.map((q) => q.hipY);
    const travel = (() => {
      // Ground covered over exactly one cycle: the measured stride.
      const a = cycle[0], z = cycle[cycle.length - 1];
      return (z.x - a.x) / (z.ph - a.ph);
    })();

    return {
      clip, legLen: an.legLen, height: rig.height,
      stride: g.stride, duty: g.duty, sweep: g.sweep, lift: g.lift,
      cadence: speed / g.stride, travel,
      L: foot('l', 0), R: foot('r', 0.5),
      hipHi: Math.max(...hips), hipLo: Math.min(...hips),
      atStrikeL: dip(0.0001), atMidL: crest(g.duty * 0.5),
      atStrikeR: dip(0.5), atMidR: crest(0.5 + g.duty * 0.5),
      cycles: s[s.length - 1].ph - s[0].ph, steps,
      strideAt: an.strideAt(speed),
    };
  };

  const rows = [];
  for (const d of defs) {
    for (const speed of speeds) rows.push({ id: d.id, speed, ...march(d.def, speed) });
  }
  // The mutation: the same march with the body moved 30% further than the animator knows.
  const mutant = march(defs[0].def, 5.2, 1.3);
  const clips = Object.entries(CLIPS)
    .filter(([, c]) => c.paced).map(([n]) => n);
  return { rows, mutant, paced: clips };
}, DEFS, SPEEDS);

/* ------------------------------------------------------------------ the feet -- */

console.log(`\n=== ${data.rows.length} marches: ${DEFS.length} characters × ${SPEEDS.length} speeds`);
const rows = data.rows;
const bad = rows.filter((r) => !r.L || !r.R);
if (bad.length) {
  check('every march produced a stance window for both feet', false,
    `${bad.length} without one, e.g. ${bad[0].id}@${bad[0].speed}`);
} else {
  passes++; console.log(`  PASS every march produced a stance window for both feet`);
}
const feet = rows.flatMap((r) => [['L', r.L, r], ['R', r.R, r]]).filter(([, f]) => f);

const worst = (pick) => feet.reduce((a, f) => (pick(f) > pick(a) ? f : a), feet[0]);
const label = ([side, f, r]) => `${r.id} ${r.clip}@${r.speed} ${side}`;

{
  const w = worst(([, f]) => f.slide / Math.max(1e-6, f.body));
  const frac = w[1].slide / w[1].body;
  check('the planted foot stays where it was planted',
    frac <= MAX_SLIDE_FRAC,
    `worst ${label(w)}: ${(100 * frac).toFixed(2)}% of the ${w[1].body.toFixed(2)} m the body`
    + ` covered (bar ${100 * MAX_SLIDE_FRAC}%)`);
  const wa = worst(([, f]) => f.slide);
  check('...in centimetres as well as in percent',
    wa[1].slide <= MAX_SLIDE_M,
    `worst ${label(wa)}: ${(100 * wa[1].slide).toFixed(2)} cm over one stance (bar ${100 * MAX_SLIDE_M} cm)`);
}
{
  const w = worst(([, f, r]) => f.yHi / r.legLen);
  check('the planted foot is on the ground, not floating above it',
    w[1].yHi <= MAX_STANCE_Y * w[2].legLen,
    `worst ${label(w)}: ankle ${(100 * w[1].yHi).toFixed(1)} cm up,`
    + ` ${(100 * w[1].yHi / w[2].legLen).toFixed(1)}% of a ${w[2].legLen.toFixed(2)} m leg`);
  const hiS = worst(([, f, r]) => f.strikeY / r.legLen);
  const loS = feet.reduce((a, f) => (f[1].strikeY / f[2].legLen < a[1].strikeY / a[2].legLen ? f : a), feet[0]);
  check('...and it rolls over heel and toe at the ends of the stance',
    loS[1].strikeY >= ROLL_AT_STRIKE[0] * loS[2].legLen
    && hiS[1].strikeY <= ROLL_AT_STRIKE[1] * hiS[2].legLen,
    `${(100 * loS[1].strikeY / loS[2].legLen).toFixed(1)}% of a leg (${label(loS)})`
    + ` … ${(100 * hiS[1].strikeY / hiS[2].legLen).toFixed(1)}% (${label(hiS)}),`
    + ` band ${ROLL_AT_STRIKE.map((v) => 100 * v).join('-')}%`);
  const m = worst(([, f]) => f.yMid);
  check('...with the sole down through the middle of the stance',
    m[1].yMid <= MAX_MID_Y,
    `worst ${label(m)}: ${(1000 * m[1].yMid).toFixed(1)} mm at mid-stance`);
}
{
  // Both directions: a swing that never clears the ground is a drag, and the same number
  // proves the two feet are not simply frozen at ground level all cycle.
  const low = feet.reduce((a, f) => (f[1].swingLift / f[2].legLen < a[1].swingLift / a[2].legLen ? f : a), feet[0]);
  check('the swinging foot clears the ground',
    low[1].swingLift >= MIN_SWING_LIFT * low[2].legLen,
    `lowest ${label(low)}: ${(100 * low[1].swingLift).toFixed(1)} cm,`
    + ` ${(100 * low[1].swingLift / low[2].legLen).toFixed(0)}% of a leg (bar ${100 * MIN_SWING_LIFT}%)`);
}

/* ---------------------------------------------------------------- the stride -- */

{
  // The identity the whole design rests on: over a stance of duty d the body covers d·stride
  // while the planted ankle sweeps back S, so stride = S/d. If the measured ground covered per
  // cycle drifts from that, something is driving the phase from a different number.
  const w = rows.reduce((a, r) =>
    (Math.abs(r.travel / r.stride - 1) > Math.abs(a.travel / a.stride - 1) ? r : a), rows[0]);
  check('a cycle covers exactly sweep / duty metres of ground',
    Math.abs(w.travel / w.stride - 1) <= 0.015,
    `worst ${w.id}@${w.speed}: marched ${w.travel.toFixed(3)} m/cycle against`
    + ` ${w.sweep.toFixed(3)}/${w.duty.toFixed(3)} = ${w.stride.toFixed(3)}`);
  const q = rows.reduce((a, r) =>
    (Math.abs(r.strideAt - r.stride) > Math.abs(a.strideAt - a.stride) ? r : a), rows[0]);
  check('...and strideAt() is the same number the cycle used',
    Math.abs(q.strideAt - q.stride) < 1e-6, `${q.id}@${q.speed}: ${q.strideAt.toFixed(4)} vs ${q.stride.toFixed(4)}`);
}
{
  const lo = rows.reduce((a, r) => (r.cadence < a.cadence ? r : a), rows[0]);
  const hi = rows.reduce((a, r) => (r.cadence > a.cadence ? r : a), rows[0]);
  check('the cadence stays in a range legs can actually turn over',
    lo.cadence >= CADENCE[0] && hi.cadence <= CADENCE[1],
    `${lo.cadence.toFixed(2)} cyc/s (${lo.id}@${lo.speed}) … ${hi.cadence.toFixed(2)} (${hi.id}@${hi.speed}),`
    + ` band ${CADENCE.join('-')}`);
}
{
  // Monotone in speed, per character: a stride that stops growing means the extra speed is
  // going into cadence alone, and one that shrinks is a band boundary with a discontinuity.
  let worstId = null, worstGap = Infinity;
  for (const d of DEFS) {
    const mine = rows.filter((r) => r.id === d.id).sort((a, c) => a.speed - c.speed);
    for (let i = 1; i < mine.length; i++) {
      const gap = mine[i].stride / mine[i - 1].stride;
      if (gap < worstGap) { worstGap = gap; worstId = `${d.id} ${mine[i - 1].speed}→${mine[i].speed}`; }
    }
  }
  // `worstGap` starts at Infinity, not at 1: seeded with the bar's own value it could only ever
  // report the bar back, which is a check that cannot pass.
  check('a faster character takes a longer stride, with no step at the band boundaries',
    worstId !== null && worstGap > 1.0, `tightest ${worstId}: ×${worstGap.toFixed(3)}`);
}
{
  // The reason the table is in leg-lengths: the same speed has to mean a proportionally
  // longer step for a taller character, or a 1.86 m body walks like a 1.54 m one.
  const at = rows.filter((r) => r.speed === 2.3).sort((a, c) => a.legLen - c.legLen);
  const shortest = at[0], tallest = at[at.length - 1];
  check('a longer leg takes a longer stride at the same speed',
    tallest.stride > shortest.stride * 1.02,
    `${tallest.id} (${tallest.legLen.toFixed(2)} m leg) ${tallest.stride.toFixed(3)} m/cycle`
    + ` vs ${shortest.id} (${shortest.legLen.toFixed(2)}) ${shortest.stride.toFixed(3)}`);
}

/* ---------------------------------------------------------------- the pelvis -- */

{
  const w = rows.reduce((a, r) => (r.hipHi - r.hipLo < a.hipHi - a.hipLo ? r : a), rows[0]);
  check('the pelvis bobs',
    w.hipHi - w.hipLo >= MIN_BOB,
    `flattest ${w.id}@${w.speed}: ${(100 * (w.hipHi - w.hipLo)).toFixed(1)} cm (bar ${100 * MIN_BOB} cm)`);
  const c = rows.reduce((a, r) =>
    ((r.legLen - r.hipLo) / r.legLen > (a.legLen - a.hipLo) / a.legLen ? r : a), rows[0]);
  check('...without sinking into a crouch',
    (c.legLen - c.hipLo) / c.legLen <= MAX_CROUCH,
    `deepest ${c.id}@${c.speed}: hip ${c.hipLo.toFixed(3)} m,`
    + ` ${(100 * (c.legLen - c.hipLo) / c.legLen).toFixed(0)}% below a ${c.legLen.toFixed(2)} m leg`);
  // Phase, not just amplitude: the dip has to land on the footfalls. This is the assertion
  // that the bob is derived from the stance leg's reach rather than authored as a sine.
  const w2 = rows.reduce((a, r) => {
    const m = (x) => Math.min(x.atMidL - x.atStrikeL, x.atMidR - x.atStrikeR) / (x.hipHi - x.hipLo);
    return m(r) < m(a) ? r : a;
  }, rows[0]);
  // Scale-free: the rise into mid-stance is measured against that speed's own bob, so the bar
  // means "the dips are on the footfalls" at 1 m/s and at 8.2 m/s alike. An authored sine at the
  // wrong phase reads about -1 here, and a flat pelvis is caught by MIN_BOB above.
  const rise = Math.min(w2.atMidL - w2.atStrikeL, w2.atMidR - w2.atStrikeR) / (w2.hipHi - w2.hipLo);
  check('...and sits lower at each footfall than between them',
    rise >= 0.6,
    `weakest ${w2.id}@${w2.speed}: ${(100 * rise).toFixed(0)}% of its ${(100 * (w2.hipHi - w2.hipLo)).toFixed(1)} cm bob`
    + ` (L ${(1000 * (w2.atMidL - w2.atStrikeL)).toFixed(1)} mm, R ${(1000 * (w2.atMidR - w2.atStrikeR)).toFixed(1)} mm)`);
}
{
  // Two footfalls per cycle, from the phase that placed the feet — the cue localPlayer hangs
  // its dust and its step sound on.
  // Counted over a window that starts and ends mid-cycle, so the count is 2·cycles ± the one
  // footfall the window's own edges can swallow.
  const err = (r) => Math.abs(r.steps - 2 * r.cycles);
  const w = rows.reduce((a, r) => (err(r) > err(a) ? r : a), rows[0]);
  check('a footfall is reported twice per cycle',
    err(w) <= 1.05,
    `worst ${w.id}@${w.speed}: ${w.steps} footfalls over ${w.cycles.toFixed(2)} cycles`
    + ` = ${(w.steps / w.cycles).toFixed(2)}/cycle`);
}

/* -------------------------------------------------------------- the mutation -- */

// The bar above is only worth anything if the defect it was written for turns it red. Same
// march, body moved 30% further than the animator was told: that is exactly a per-clip stride
// constant that does not match the legs, which is what this whole probe replaced.
{
  const m = data.mutant;
  const frac = m.L ? m.L.slide / m.L.body : 0;
  check('a stride 30% too long makes the slide assertion fail',
    m.L && frac > MAX_SLIDE_FRAC * 3,
    `mutant slid ${(100 * frac).toFixed(1)}% of the body's travel`
    + ` (${(100 * (m.L?.slide ?? 0)).toFixed(1)} cm) against a ${100 * MAX_SLIDE_FRAC}% bar`);
}

/* ----------------------------------------------------------------- the source -- */

// Where a number lives is part of whether it can drift. These gates are two-way: the stride
// has to exist in exactly one place, and that place has to have callers.
const src = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const anim = src('../client/src/gfx/animator.js');
const lp = src('../client/src/game/localPlayer.js');
const mc = src('./motion-check.mjs');

check('the locomotion clips carry no stride constant of their own',
  !/stride:\s*[\d.]/.test(anim),
  (anim.match(/stride:\s*[\d.]+/g) || []).join(' ') || 'no `stride: <number>` anywhere in animator.js');
check('...and all three of them are paced by the gait table instead',
  data.paced.length === 3 && /baseClip\.paced/.test(anim) && /gaitAt\(ctx\.speed, this\.legLen\)/.test(anim),
  `paced clips: ${data.paced.join(', ')}`);
{
  // The table has to be in leg-lengths, not metres, or the tall characters are back to
  // borrowing the short ones' steps. Two halves: every entry is a ratio in a plausible range,
  // and the only place metres appear is where the leg multiplies them.
  const table = anim.split('const GAIT = [')[1]?.split('];')[0] ?? '';
  const nums = [...table.matchAll(/duty:\s*([\d.]+),\s*sweep:\s*([\d.]+)/g)]
    .map((m) => [+m[1], +m[2]]);
  const ok = nums.length >= 5
    && nums.every(([d, s]) => d > 0.1 && d < 0.9 && s > 0.1 && s < 1.5)
    && /sweep: sweepN \* L/.test(anim) && /stride: \(sweepN \/ duty\) \* L/.test(anim);
  check('the gait table is in leg-lengths, so one curve serves every height', ok,
    `${nums.length} rows, duty ${Math.min(...nums.map((n) => n[0]))}-${Math.max(...nums.map((n) => n[0]))},`
    + ` sweep ${Math.min(...nums.map((n) => n[1]))}-${Math.max(...nums.map((n) => n[1]))} of a leg`);
}
{
  // Consumer gate, both directions: an API nobody calls is dead, and a caller of an API that
  // does not exist is worse. localPlayer's footstep cue and motion-check's phase stepping are
  // the two consumers this design promised.
  const callers = (name) => [
    ['localPlayer.js', lp], ['motion-check.mjs', mc],
  ].filter(([, s]) => s.includes(`${name}(`)).map(([n]) => n);
  const step = callers('takeSteps'), stride = callers('strideAt');
  check('takeSteps() has a consumer in the product',
    step.includes('localPlayer.js') && /takeSteps\(\)/.test(anim), step.join(', ') || 'none');
  check('strideAt() has a consumer',
    stride.length >= 1 && /strideAt\(/.test(anim), stride.join(', ') || 'none');
}
check('the footstep cue no longer carries its own idea of a stride',
  !/_stepAcc/.test(lp) && !/const stride =/.test(lp) && /takeSteps\(\)/.test(lp),
  'localPlayer emits a footstep per landed foot, from the animator\'s phase');
check('the leg solver is wired into the pose application',
  /this\.solveLegs\(pose\)/.test(anim) && /solveLegs\(pose\)\s*\{/.test(anim),
  'applyPose calls solveLegs');

check('no page errors through any of it', errs.length === 0, errs.slice(0, 3).join(' | '));

/* ------------------------------------------------------------------ evidence -- */

console.log('\n    speed   clip      stride  duty  sweep  cad   bob    hip     slide L/R');
for (const speed of SPEEDS) {
  const r = rows.find((q) => q.id === DEFS[0].id && q.speed === speed);
  if (!r) continue;
  console.log(`  ${String(speed).padStart(6)}   ${r.clip.padEnd(8)} ${r.stride.toFixed(3)}`
    + ` ${r.duty.toFixed(3)} ${r.sweep.toFixed(3)} ${r.cadence.toFixed(2)}`
    + ` ${(100 * (r.hipHi - r.hipLo)).toFixed(1)}cm ${r.hipLo.toFixed(3)}`
    + `  ${(1000 * (r.L?.slide ?? 0)).toFixed(1)}/${(1000 * (r.R?.slide ?? 0)).toFixed(1)} mm`);
}
console.log(`  (${DEFS[0].id}, leg ${rows[0].legLen.toFixed(2)} m; the other ${DEFS.length - 1}`
  + ` characters are gated by the worst-case assertions above)`);

console.log(`\ngait-check: ${passes} passed, ${fails} failed, ${skips} skipped`);
await b.close();
process.exit(fails);
