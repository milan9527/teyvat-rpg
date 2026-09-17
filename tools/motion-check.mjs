// Animation gate: every clip the animator can play, measured as a silhouette on screen.
//
// The hole this closes. `tools/prop-check.mjs` gates props, `tour` the ground, `vault-cam` the
// ceiling, `npc-cam`/`enemy-cam` the characters — but every one of those photographs a *stopped*
// game. Motion had no gate at all, and the cost showed up the moment anyone looked: of the 24
// clips in `gfx/animator.js`, three (`hit`, `sit`, `aim`) were fully authored, listed in the
// `ACTION` enum so a remote client would have shown them, and **played by nobody**. Taking a hit
// was a red screen flash and a colour flash on the material while the character kept walking
// through it; the bow aim mode moved the camera and nothing else; sitting did not exist.
//
// So this probe asserts three different kinds of thing, and needs all three:
//
//  1. **Vocabulary, both directions** (no browser). `CLIPS` ↔ `ACTION` must be the same set, or a
//     pose exists that cannot travel over the wire, or a wire value arrives that maps to nothing.
//  2. **A named consumer for every clip** (no browser). A clip with no `play()` caller anywhere in
//     `client/src` is dead data — that is exactly how `hit`/`sit`/`aim` rotted — and a caller that
//     names a clip which does not exist is a silent no-op, because `Animator.play` returns false
//     for an unknown name and nothing checks the return.
//  3. **Pixels** (browser). Wiring proves a clip is *reachable*; it does not prove the pose is
//     different from standing still. Each clip is posed on the real local player through the real
//     `Animator`, and its silhouette is measured by hiding the avatar and diffing — the same
//     hide-and-diff `prop-check` uses, for the same reason (no hand-typed rect can survive a
//     camera change, and an empty mask is both the "not drawn" control and the staleness control).
//     Two silhouettes that agree to within 3% are the same pose, whatever the clip is called.
//
// Method notes, all learned the hard way in this repo:
//  * The game loop is stopped before framing (the third-person rig lerps `fov` and position back
//    every frame) and the animator is stepped by hand with `auto: false`, so a phase is exact
//    rather than whatever llvmpipe's 3 fps happened to land on.
//  * The "avatar hidden" frame is shot **once**: with the loop stopped and the camera fixed, the
//    world behind the character is identical for every clip, so 24 clips cost 25 renders instead
//    of 48. Shot twice at the start to prove it (the frames must agree), which is also this
//    probe's staleness control.
//  * The avatar's shadow is switched off for the measurement. It moves with the pose, so leaving
//    it in would make every mask bigger and the *ground* would be carrying part of the evidence;
//    the claim here is about the body.
//  * Quality is pinned to `high` (llvmpipe boots every browser at `low`, where there is no bloom
//    and no shadow) and the tier is re-checked after the zone change.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import * as THREE from '../client/node_modules/three/build/three.module.js';
import { CLIPS } from '../client/src/gfx/animator.js';
import { ActorSystem, SPEED_TAU, smoothSpeed } from '../client/src/game/actors.js';
import { ACTION } from '../shared/src/protocol.js';
import { ENEMIES } from '../shared/src/data/enemies.js';
import { decodePng, diffMask, largestBlob, pixelsDiffering } from './lib/png.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/motioncheck'; })();
const W = 1000, H = 700;
fs.mkdirSync(outDir, { recursive: true });
const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Thresholds. Calibrated on the first full run; see README's 动作门禁 section. */
const MIN_PX = 4000;        // px of 700 000: the avatar at this framing is ~30 000
const MAX_SELF_IOU = 0.90;  // a clip whose silhouette agrees with idle this closely is not a pose
const MIN_STABLE = 0.985;   // idle re-rendered against itself: the measurement's own noise floor
const MAX_PAIR_IOU = 0.97;  // two clips this similar are the same pose under two names
const MAX_WORLD_DRIFT = 400; // px allowed to differ between the two "avatar hidden" frames

/**
 * How each clip is driven. `speed` matters because walk/run/sprint are *distance*-driven (one
 * cycle per stride, which is what stops the feet sliding), so a `paced` clip stepped at speed 0
 * never advances its phase at all and would photograph as the bind pose.
 * `phase` is where in the clip to shoot: 0.5 through a one-shot is the pose the blend envelope
 * gives full weight to, while the interesting frame of a snap like `hit` is early.
 */
const DRIVE = {
  idle: { speed: 0, phase: 0.25 },
  walk: { speed: 2.0, phase: 0.25 },
  run: { speed: 4.6, phase: 0.25 },
  sprint: { speed: 8.0, phase: 0.25 },
  fall: { speed: 1.0, phase: 0.4, grounded: false },
  glide: { speed: 6.0, phase: 0.4, grounded: false },
  swim: { speed: 2.0, phase: 0.3, swimming: true },
  climb: { speed: 1.4, phase: 0.3, climbing: true },
  sit: { speed: 0, phase: 0.3 },
  down: { speed: 0, phase: 0.3 },
  aim: { speed: 0, phase: 0.3 },
  jump: { speed: 1.0, phase: 0.35, grounded: false },
  dash: { speed: 5.0, phase: 0.4 },
  plunge: { speed: 1.0, phase: 0.55, grounded: false },
  hit: { speed: 0, phase: 0.12 },
  gather: { speed: 0, phase: 0.5 },
  attack1: { speed: 0, phase: 0.45 },
  attack2: { speed: 0, phase: 0.45 },
  attack3: { speed: 0, phase: 0.45 },
  attack4: { speed: 0, phase: 0.45 },
  attack5: { speed: 0, phase: 0.45 },
  charged: { speed: 0, phase: 0.55 },
  skill: { speed: 0, phase: 0.5 },
  burst: { speed: 0, phase: 0.5 },
};

/** The four numbers the page needs to step a clip by hand; the clip's `fn` cannot cross over. */
const meta = (name) => {
  const c = CLIPS[name];
  return { locomotion: !!c.locomotion, loop: c.loop ?? null, paced: !!c.paced, dur: c.dur ?? null };
};

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); } else {
    fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
};
const skipped = (name, why) => { skip++; console.log(`  SKIP ${name} — ${why}`); };

/* ------------------------------------------------------- 1. vocabulary + wiring -- */

console.log('=== vocabulary');
const clipNames = Object.keys(CLIPS);
const actionNames = Object.keys(ACTION);
const clipOnly = clipNames.filter((k) => !(k in ACTION));
const actionOnly = actionNames.filter((k) => !(k in CLIPS));
check('every animator clip has an ACTION value, so remote players can be shown it',
  clipOnly.length === 0, clipOnly.length ? `no ACTION for ${clipOnly.join(', ')}` : `${clipNames.length} clips`);
check('every ACTION value has an animator clip, so no snapshot decodes to nothing',
  actionOnly.length === 0, actionOnly.length ? `no clip for ${actionOnly.join(', ')}` : `${actionNames.length} actions`);

// Who plays what. Three shapes of caller, and the last two are the ones a plain grep for
// `play('name')` misses — which is why this scan exists rather than a hand-kept list.
const SRC = '/home/ec2-user/project/game/client/src';
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(`${dir}/${e.name}`);
    else if (e.name.endsWith('.js')) files.push(`${dir}/${e.name}`);
  }
})(SRC);
check('the source scan actually found the client', files.length > 15, `${files.length} .js files`);

const callers = new Map();   // clip -> [ "file:line" ]
const bogus = [];            // play('name') where `name` is not a clip
let autoBody = '';
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const rel = f.replace('/home/ec2-user/project/game/', '');
  const lines = text.split('\n');
  lines.forEach((ln, i) => {
    // Every quoted name inside a `play(...)` / `playAction(...)` argument list, not just one at
    // the front of it: `playAction(d.action === 'charged' ? 'charged' : …)` is a real caller, and
    // an anchored regex reported `charged` as an orphan when three places play it. `.play(` has
    // exactly one implementation in client/src (the animator's), so an unknown name here is a
    // typo rather than some other subsystem's play method.
    for (const call of ln.matchAll(/\b(?:play|playAction)\(([^)]*)\)/g)) {
      for (const m of call[1].matchAll(/'([a-zA-Z0-9]+)'/g)) {
        const nm = m[1];
        if (!(nm in CLIPS)) { bogus.push(`${rel}:${i + 1} plays '${nm}'`); continue; }
        if (!callers.has(nm)) callers.set(nm, []);
        callers.get(nm).push(`${rel}:${i + 1}`);
      }
    }
  });
  if (rel.endsWith('gfx/animator.js')) {
    const ix = text.indexOf('autoLocomotion(state)');
    autoBody = ix >= 0 ? text.slice(ix, text.indexOf('\n  }', ix)) : '';
  }
  // The combo runs `attack${(this.combo % 5) + 1}`, so attack1..attack5 have a producer that
  // names none of them. Accepted, but only against the count it actually produces.
  for (const m of text.matchAll(/attack\$\{\(?[^}]*%\s*(\d+)\)?\s*\+\s*1\}/g)) {
    const n = Number(m[1]);
    for (let k = 1; k <= n; k++) {
      const nm = `attack${k}`;
      if (!(nm in CLIPS)) { bogus.push(`${rel} builds '${nm}' from a template`); continue; }
      if (!callers.has(nm)) callers.set(nm, []);
      callers.get(nm).push(`${rel} (template attack\${…%${n}+1})`);
    }
  }
}
for (const m of autoBody.matchAll(/return '([a-zA-Z0-9]+)'/g)) {
  const nm = m[1];
  if (!(nm in CLIPS)) { bogus.push(`autoLocomotion returns '${nm}'`); continue; }
  if (!callers.has(nm)) callers.set(nm, []);
  callers.get(nm).push('gfx/animator.js autoLocomotion');
}
check('autoLocomotion was found and read', autoBody.length > 100, `${autoBody.length} chars`);
const orphans = clipNames.filter((k) => !callers.has(k));
check('every clip has a caller that can select it', orphans.length === 0,
  orphans.length ? `nothing plays ${orphans.join(', ')}` : `${callers.size} clips wired`);
check('no caller names a clip that does not exist', bogus.length === 0,
  bogus.length ? bogus.join('; ') : 'none');
// The states `autoLocomotion` branches on have to be states the caller actually *varies*, or the
// branch is unreachable — which is what kept `sit`/`aim` invisible even though both were in the
// enum and both had a clip. Note what the weak version of this check would be: "is the key
// present in the state object". `climbing: false` is present, and passes it, while the climb clip
// stays as dead as it ever was. So the value has to be an expression, not a literal.
const lpSrc = fs.readFileSync(`${SRC}/game/localPlayer.js`, 'utf8');
const stateIx = lpSrc.indexOf('this.actor.update(dt, t, {\n');
const stateBody = stateIx >= 0 ? lpSrc.slice(stateIx, lpSrc.indexOf('\n    });', stateIx)) : '';
check('the animator state object was found in localPlayer', stateBody.length > 60, `${stateBody.length} chars`);
for (const key of ['sitting', 'aiming', 'climbing', 'gliding', 'swimming', 'grounded', 'speed']) {
  const m = stateBody.match(new RegExp(`\\n\\s*${key}:\\s*([^,\\n]+)`));
  const val = m ? m[1].trim() : null;
  const live = !!val && !/^(false|true|0|null|undefined)$/.test(val);
  check(`localPlayer varies '${key}' rather than pinning it`, live,
    val === null ? 'not passed at all' : `${key}: ${val}`);
}

/* ------------------------------- 1b. a remote actor's legs against its own ground -- */

/**
 * A teammate or a creature you did not simulate has **two clocks**, and this section is about
 * making them agree.
 *
 * Its body comes out of `Socket.sampleWindow()`: a position interpolated between the two
 * snapshots bracketing the render time, i.e. denominated in the *wall clock*. Its legs used to be
 * advanced by `speed × dt` with the loop's `dt`, which `game.js` clamps to 50 ms so one long frame
 * cannot throw the world — and a clamped dt is not a clock (see the respawn countdown that froze
 * at 「8 秒后」). The two agree only above 20 fps. Below it the body covers ground the legs are
 * never told about, and the model skates by construction.
 *
 * And `speed` itself was `speed * 0.7 + inst * 0.3` — a blend per *drawn frame*, which is a time
 * constant of 47 ms at 60 fps and 933 ms at 3 fps. The same ghost running at a steady 6 m/s was
 * drawn `sprint` on a fast client and `run` on every slower one, because on the slower one the
 * smoother had not reached the speed yet on the frame the clip was picked.
 *
 * Both are measured here by driving the real `ActorSystem` against a synthetic 10 Hz stream, in
 * node, with no browser: one player accelerating from rest to a fixed speed in a straight line and
 * stopping. Nothing about the animator is written down below — the stride comes off the rig
 * (`animator.ctx.gait.stride`), the clip a speed implies comes from `animator.autoLocomotion`, and
 * the foot comes from `rig.bones.footL/R.matrixWorld`.
 */
const SNAP_MS = 100, LAG = 0.1;
const RATES = [60, 30, 20, 12, 6];
const ghostAt = (i, mps, run) => {
  const d = Math.min(run, (i * SNAP_MS) / 1000) * mps;
  return {
    serverNow: i * SNAP_MS,
    data: { players: [{ id: 7, x: 0, y: 0, z: d, ry: 0, hp: 1000, mhp: 1000, a: 0,
      n: 'ghost', c: 'lyra', au: null, sh: 0, she: null, pt: null, al: 1 }] },
  };
};

const remote = (fps, mps, run = 2) => {
  const sys = new ActorSystem(new THREE.Scene(), null, null);
  sys.setLocalId(1);
  const dtReal = 1 / fps, dt = Math.min(0.05, dtReal);   // the clamp game.js applies
  let ground = 0, px = null, pz = null, stride = 0, atSpeed = 0, moving = null, clip = null;
  const feet = { footL: [], footR: [] };
  for (let f = 0; f * dtReal < run + 0.3; f++) {
    const t = f * dtReal, rt = Math.max(0, t - LAG);
    const ia = Math.floor((rt * 1000) / SNAP_MS);
    sys.update(dt, t, { a: ghostAt(ia, mps, run), b: ghostAt(ia + 1, mps, run),
      u: ((rt * 1000) % SNAP_MS) / SNAP_MS });
    const e = sys.players.get(7);
    if (!e) continue;
    if (px !== null) {
      const step = Math.hypot(e.x - px, e.z - pz);
      ground += step;
      if (moving === null && step > 0.01) moving = e.actor.animator?.base;
    }
    px = e.x; pz = e.z;
    // The stride this rig reaches at the true speed, read off the rig on a frame where the
    // derived speed happens to be right — never written down here.
    if (Math.abs(e.speed - mps) < 0.1) {
      stride = e.actor.animator?.ctx?.gait?.stride || stride;
      clip = e.actor.animator.base;
      atSpeed = e.speed;
    }
    e.actor.group.updateMatrixWorld(true);
    for (const foot of Object.keys(feet)) {
      const el = e.actor.rig.bones[foot].matrixWorld.elements;
      feet[foot].push({ world: el[14], model: el[14] - e.actor.group.position.z,
        body: e.actor.group.position.z,
        // Frames where the derived speed is the one the ghost is really running at. On those the
        // clip, the amplitude and the stride are all pinned, so the *only* thing left that can
        // move the foot within the model is the gait clock.
        held: Math.abs(e.speed - mps) < 0.1 });
    }
  }
  const held = feet.footL.filter((s) => s.held).map((s) => s.model);
  // Stance = a run of frames over which the contact point travels *backwards through the model*,
  // which is what a foot does while the body passes over it (boss-check detects it the same way).
  // Taken over the most ground rather than the most frames: the longest run of frames in any trace
  // is the one after the actor stops, where the legs cycle over no ground at all — a defect of its
  // own, but not one a ratio whose denominator is zero can express.
  let best = null;
  for (const [foot, tr] of Object.entries(feet)) {
    let cur = null;
    const keep = (c) => {
      if (!c) return;
      const over = Math.abs(tr[c.to].body - tr[c.from].body);
      if (over < 0.3 || (best && over <= best.over)) return;
      best = { foot, frames: c.to - c.from, over,
        slid: Math.abs(tr[c.to].world - tr[c.from].world) / over };
    };
    for (let i = 1; i < tr.length; i++) {
      if (tr[i].model < tr[i - 1].model) cur = cur ? { from: cur.from, to: i } : { from: i - 1, to: i };
      else { keep(cur); cur = null; }
    }
    keep(cur);
  }
  const e = sys.players.get(7);
  return { fps, mps, ground, stride, atSpeed, clip, moving, stance: best,
    // How far the foot travelled inside the model over the pinned-speed frames, and how many
    // there were. Zero over several frames means the pose never changed.
    poseSpread: held.length > 2 ? Math.max(...held) - Math.min(...held) : null, heldFrames: held.length,
    cycles: e.actor.animator.basePhase, speed: e.speed,
    // Which clip that speed implies, asked of the animator instead of restated here.
    band: e.actor.animator.autoLocomotion({ speed: mps, grounded: true }),
    // Frames per gait cycle: the resolution this trace was sampled at. A stance is about a third
    // of a cycle, so below ~4 samples per cycle there is no stance left to measure.
    perCycle: (stride / mps) * fps };
};

// The smoother's own arithmetic first, because everything below is measured through it: the new
// time constant has to reproduce the pair it replaces at the frame rate that pair was authored
// against, or this is a re-tuning wearing a bug fix's clothes.
check('the derived-speed smoother is the old 0.7/0.3 blend at 60 fps, to the last bit',
  Math.abs(smoothSpeed(0, 1, 1 / 60) - 0.3) < 1e-15 && Math.abs(SPEED_TAU - 0.0467) < 1e-4,
  `τ ${SPEED_TAU.toFixed(6)} s → k ${smoothSpeed(0, 1, 1 / 60)} at dt = 1/60,`
  + ` ${smoothSpeed(0, 1, 1 / 6).toFixed(3)} at dt = 1/6 (the old blend spent 0.3 either way)`);

const SPRINT = 6;
const runs = RATES.map((fps) => remote(fps, SPRINT));
for (const r of runs) {
  console.log(`  (fps ${String(r.fps).padStart(2)}: ${r.cycles.toFixed(2)} cycle(s) over`
    + ` ${r.ground.toFixed(2)} m, stride ${r.stride.toFixed(2)} m, first moving frame '${r.moving}',`
    + ` ${r.perCycle.toFixed(1)} frames per cycle)`);
}
// A precondition, not a claim: the stride below is read off the rig on a frame where the derived
// speed is right, so a rate that never reached the speed has no denominator and every percentage
// after it would be arithmetic about zero.
check('every frame rate derived the speed the ghost was actually moving at',
  runs.every((r) => r.stride > 0),
  runs.map((r) => `${r.fps}: stride ${r.stride.toFixed(2)} m, read on a frame where the`
    + ` derived speed was ${r.atSpeed.toFixed(2)} m/s`).join('; '));
// Cycles per metre, against the stride the rig itself reaches at that speed. Not a tautology: the
// left side is the animator's own odometer (`basePhase`, in cycles), the right side is the ground
// the *body* was interpolated across divided by the rig's measured stride. The band is wide on
// purpose — the trace includes the ramp up and down, where a shorter stride buys more cycles per
// metre honestly — and the claim that actually bites is the spread below it.
for (const r of runs) {
  const want = r.ground / r.stride;
  check(`at ${r.fps} fps the legs cycle once per stride of ground covered`,
    r.stride > 0 && r.cycles / want > 0.85 && r.cycles / want < 1.2,
    `${r.cycles.toFixed(2)} cycles against ${want.toFixed(2)} (${(r.cycles / want * 100).toFixed(0)}%)`);
}
const ratios = runs.map((r) => r.cycles / (r.ground / r.stride));
const spread = Math.max(...ratios) / Math.min(...ratios);
check('...and the same walk costs the same number of steps whatever frame rate is watching',
  spread < 1.08,
  `${ratios.map((v, i) => `${RATES[i]}: ${(v * 100).toFixed(0)}%`).join(', ')}`
  + ` — a spread of ${((spread - 1) * 100).toFixed(0)}%`);
// Which clip is not a matter of taste: `autoLocomotion` picks it from the speed, so the same
// teammate must be drawn in the same clip on the first frame they move at every frame rate.
check(`a teammate moving at ${SPRINT} m/s is drawn in the '${runs[0].band}' clip on the first frame`
  + ' they move, at every frame rate',
  runs.every((r) => r.moving === r.band),
  runs.map((r) => `${r.fps}: ${r.moving}`).join(', '));

// The planted foot itself, on the clip most of the world is watched at (a teammate crossing camp
// at 1.5 m/s walks). `gait-check` holds a *local* walker to 4 % of the ground; a remote one is
// interpolated between snapshots on top of that, so the bar here is looser — but only where the
// stance is sampled often enough to exist. At 6 fps a sprint cycle lasts 3 frames: the two
// endpoints of a "stance" that short are half a swing apart and the ratio measures aliasing, not
// sliding, which is why this reports its own resolution and skips instead of guessing.
for (const mps of [1.5, 3.5]) {
  for (const fps of RATES) {
    const r = remote(fps, mps);
    const name = `the planted foot holds the ground at ${mps} m/s, ${fps} fps`;
    if (!r.stance) { skipped(name, 'no stance covered enough ground to measure'); continue; }
    if (r.stance.frames < 5) {
      skipped(name, `the longest stance was ${r.stance.frames} frame(s) of a`
        + ` ${r.perCycle.toFixed(1)}-frame cycle — too coarse to tell a slide from an alias`);
      continue;
    }
    check(name, r.stance.slid < 0.15,
      `${r.stance.foot} slid ${(r.stance.slid * 100).toFixed(0)}% of the ${r.stance.over.toFixed(2)} m`
      + ` the body covered over ${r.stance.frames} frame(s) of stance`);
  }
}

// A creature's legs are a *different* odometer: `gfx/enemies.js` integrates its own gait clock in
// radians from a stride it measured off the rig, and it never went through `Animator` at all. Same
// two clocks, same fix, so the same reading — on the creature's own authored speed, which is what
// it chases you at. (`gait-check` holds the same models to 4 % as *local* walkers at 60 fps; the
// point here is only that the network path does not add a slide of its own.)
const CREATURE = 'hilichurl';
const beast = (fps, run = 2.4) => {
  const mps = ENEMIES[CREATURE].speed;
  const sys = new ActorSystem(new THREE.Scene(), null, null);
  const dtReal = 1 / fps, dt = Math.min(0.05, dtReal);
  const snap = (i) => ({
    serverNow: i * SNAP_MS,
    data: { enemies: [{ id: 11, t: CREATURE, x: 0, y: 0, z: Math.min(run, (i * SNAP_MS) / 1000) * mps,
      ry: 0, hp: 500, mhp: 500, lv: 20, sh: 0, shm: 0, au: null, fz: 0, a: 1, ph: 1, st: 'chase',
      mv: null }] },
  });
  const tr = [];
  let peak = 0;
  for (let f = 0; f * dtReal < run + 0.3; f++) {
    const t = f * dtReal, rt = Math.max(0, t - LAG);
    const ia = Math.floor((rt * 1000) / SNAP_MS);
    sys.update(dt, t, { a: snap(ia), b: snap(ia + 1), u: ((rt * 1000) % SNAP_MS) / SNAP_MS });
    const e = sys.enemies.get(11);
    if (!e) continue;
    peak = Math.max(peak, e.speed);
    e.actor.group.updateMatrixWorld(true);
    const el = e.actor.view.bones.footL.matrixWorld.elements;
    tr.push({ world: el[14], model: el[14] - e.actor.group.position.z, body: e.actor.group.position.z,
      held: Math.abs(e.speed - mps) < 0.1,
      // The rig's own divisor at this speed, asked of the model rather than restated here.
      stride: e.actor.view.strideAt?.(e.speed) ?? 0 });
  }
  const held = tr.filter((s) => s.held);
  let best = null, cur = null;
  const keep = (c) => {
    if (!c) return;
    const over = Math.abs(tr[c.to].body - tr[c.from].body);
    if (over < 0.3 || (best && over <= best.over)) return;
    best = { frames: c.to - c.from, over, slid: Math.abs(tr[c.to].world - tr[c.from].world) / over };
  };
  for (let i = 1; i < tr.length; i++) {
    if (tr[i].model < tr[i - 1].model) cur = cur ? { from: cur.from, to: i } : { from: i - 1, to: i };
    else { keep(cur); cur = null; }
  }
  keep(cur);
  return { fps, mps, peak, stance: best,
    stride: held.length ? held[held.length - 1].stride : 0,
    poseSpread: held.length > 2
      ? Math.max(...held.map((s) => s.model)) - Math.min(...held.map((s) => s.model)) : null,
    heldFrames: held.length };
};
for (const fps of RATES) {
  const r = beast(fps);
  const name = `a ${CREATURE} chasing at ${r.mps} m/s keeps its foot on the ground, ${fps} fps`;
  if (!r.stance) { skipped(name, 'no stance covered enough ground to measure'); continue; }
  if (r.stance.frames < 5) {
    skipped(name, `the longest stance was ${r.stance.frames} frame(s) — too coarse to tell a`
      + ` slide from an alias (the creature covers ${(r.mps / fps).toFixed(2)} m per frame)`);
    continue;
  }
  check(name, r.stance.slid < 0.2,
    `the foot slid ${(r.stance.slid * 100).toFixed(0)}% of the ${r.stance.over.toFixed(2)} m the body`
    + ` covered over ${r.stance.frames} frame(s) of stance, at a derived ${r.peak.toFixed(2)} m/s`);
}

// A frame that covers more ground than one stride. Feeding the odometer the ground covered came
// with a cap — `min(advance, stride)` — to keep a teleport from being walked through, and one
// stride is exactly one *cycle*: on every frame whose ground reached the stride the phase turned a
// whole revolution and the pose came out bit-identical, so the legs froze mid-stride while the body
// slid. It is the very defect this path exists to fix, put back at low frame rates only, and no
// assertion above could see it (at 6 fps a sprint still covers 1.0 m against a 1.8 m stride).
// A live chase at llvmpipe's ~3 fps measured 0.0000 rad of thigh spread over 15 walking frames.
//
// Read on the frames where the derived speed is pinned to the ghost's own, so the clip, the swing
// amplitude and the stride are all constant and the clock is the only thing left that can move the
// foot inside the model. The precondition is the rig's own stride against the ground per frame:
// where the frame is shorter than a stride there is nothing to cap and the gate would be vacuous.
// The frame rates are low because that is what it takes to outrun a *sprint* stride (3.2 m) — but
// the frame rate is only the vehicle. A stream that stalls for a second and resyncs hands the same
// oversized step to a body drawn at 60 fps.
// Against a control, not against zero: the reading is the excursion of the same foot in the same
// model at the same speed, sampled finely at 60 fps, which is the whole travel a gait cycle has to
// offer. A bare "it moved a bit" bar would have passed the clamp — at 1 fps the clamped phase turns
// 1.00 ± the wobble in a stride read at a speed pinned to 0.1 m/s, and that wobble alone moved the
// foot 0.19 m of its 0.86 m travel.
const longStep = (who, r, perFrame, ref) => {
  const name = `${who} covering ${perFrame.toFixed(2)} m in one frame — more than a whole stride —`
    + ' is not left frozen mid-stride';
  if (r.poseSpread == null || !(r.stride > 0) || !(ref > 0.1)) {
    skipped(name, `at ${r.fps} fps the derived speed held for ${r.heldFrames} frame(s), too few to`
      + ` read a pose from (the 60 fps control travels ${ref?.toFixed?.(3) ?? '?'} m)`);
  } else if (perFrame < r.stride) {
    skipped(name, `at ${r.fps} fps a frame covers ${perFrame.toFixed(2)} m, inside the`
      + ` ${r.stride.toFixed(2)} m stride — nothing for a cap to clamp`);
  } else {
    const frac = r.poseSpread / ref;
    check(name, frac > 0.5,
      `the foot moved ${r.poseSpread.toFixed(3)} m inside the model over ${r.heldFrames} such frames`
      + ` at ${r.fps} fps — ${(frac * 100).toFixed(0)}% of the ${ref.toFixed(3)} m it travels at`
      + ` 60 fps, against a ${r.stride.toFixed(2)} m stride`);
  }
};
const refPlayer = remote(60, SPRINT, 6).poseSpread;
for (const fps of [1.5, 1]) longStep('a teammate', remote(fps, SPRINT, 6), SPRINT / fps, refPlayer);
const refBeast = beast(60, 4).poseSpread;
for (const fps of [3, 2]) {
  longStep(`a ${CREATURE}`, beast(fps, 4), ENEMIES[CREATURE].speed / fps, refBeast);
}

/* ------------------------------------------------------------------ 2. pixels -- */

const tokFile = '/tmp/world-token.txt';
let token = fs.existsSync(tokFile) ? fs.readFileSync(tokFile, 'utf8').trim() : '';
if (!token) {
  const r = await fetch(`${API}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  token = (await r.json()).token;
  fs.writeFileSync(tokFile, token);
  console.log('minted a guest token ->', tokFile);
}

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
  },
  defaultViewport: { width: W, height: H },
});
const p = await b.newPage();
const errs = [];
const hmr = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
p.on('console', (m) => {
  const t = m.text().slice(0, 250);
  if (/\[vite\].*(hot updated|hmr update|page reload)/i.test(t)) { hmr.push(t); console.log('[HMR]', t); }
  if (m.type() === 'error') { errs.push(t.slice(0, 200)); console.log('[err]', t); }
});

await p.goto(origin, { waitUntil: 'domcontentloaded' });
await p.evaluate((t) => localStorage.setItem('teyvat.token', t), token);
await p.reload({ waitUntil: 'domcontentloaded' });
await sleep(5000);
await p.click('[data-act="resume"]');
let up = false;
for (let i = 0; i < 90; i++) {
  if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) { up = true; break; }
  await sleep(1000);
}
if (!up) {
  console.log('window.game never started running — check ./tools/daemon.sh status');
  await b.close();
  process.exit(1);
}
await sleep(4000);
await p.evaluate(() => {
  window.game.setAutoQuality(false);
  window.game.setQuality('high');
  // Noon, pinned: the world clock moves the sun 15° a real minute, and every threshold in this
  // file was calibrated on the authored sky, which is exactly what daylight() returns at 12:00.
  window.game.setWorldTime(12);
});
await sleep(2500);
const tier = await p.evaluate(() => window.game.quality);
console.log('quality pinned ->', tier);

/* ------------------------------------------------------- 3. input path, live -- */

// Done while the loop is still running, because this half is about the *chain*: a real key press
// through the real input map, and the pose the rest of the world is told about. A probe that
// calls `setSitting` directly passes on a build where the key is unbound.
console.log('\n=== the input path');
// No click anywhere. The first version of this probe clicked the canvas at (500, 640) "to focus
// it" and hit the HUD button stack underneath the pointer instead: the map panel opened, covered
// the world, disabled world input and left the animator holding a `gather` overlay — which made
// every later sit assertion and *every* silhouette wrong at once. Key events are bound on
// `window`, so nothing needs focusing; all that matters is that no text field owns the caret and
// no panel is open, and both of those are asserted rather than assumed.
const clear = await p.evaluate(() => {
  document.activeElement?.blur?.();
  if (window.ui?.panels?.isOpen) window.ui.panels.close();
  const me = window.game.me;
  me.clearGoal?.();
  me.setTarget?.(null);
  return { panel: !!window.ui?.panels?.isOpen, typing: document.activeElement?.tagName || 'none' };
});
check('no panel is covering the world', clear.panel === false, `panel open ${clear.panel}`);
check('no text field owns the keyboard', !/INPUT|TEXTAREA/.test(clear.typing), clear.typing);
// A one-shot overlay pins `auto` off, so a stray gather/attack in flight would keep the base
// clip on whatever it was. Wait it out rather than racing it.
let idleReady = false;
for (let i = 0; i < 40; i++) {
  if (await p.evaluate(() => !window.game.me.actor.animator.busy)) { idleReady = true; break; }
  await sleep(250);
}
check('the animator is free of one-shots before the sit test', idleReady);
const before = await p.evaluate(() => ({
  sitting: window.game.me.sitting, action: window.game.me.currentAction(),
}));
await p.keyboard.press('KeyX');
await sleep(1200);
const afterSit = await p.evaluate(() => ({
  sitting: window.game.me.sitting,
  base: window.game.me.actor.animator.base,
  action: window.game.me.currentAction(),
}));
check('a real KeyX press sits the character down', afterSit.sitting === true && before.sitting === false,
  `sitting ${before.sitting} -> ${afterSit.sitting}`);
check('the animator picked the sit clip from that state', afterSit.base === 'sit', `base ${afterSit.base}`);
check('the snapshot the other players get says sit', afterSit.action === ACTION.sit,
  `action ${afterSit.action} (want ${ACTION.sit}, was ${before.action})`);
// Walking has to stand you up, or the pose lies about what the body is doing.
await p.keyboard.down('KeyW');
await sleep(900);
const walking = await p.evaluate(() => ({
  sitting: window.game.me.sitting, base: window.game.me.actor.animator.base,
}));
await p.keyboard.up('KeyW');
check('pressing forward stands the character up again', walking.sitting === false, `sitting ${walking.sitting}`);
check('and the clip left sit with it', walking.base !== 'sit', `base ${walking.base}`);

// The hit reaction's own two rules, through the product's method rather than around it.
const flinch = await p.evaluate(async () => {
  const me = window.game.me;
  const an = me.actor.animator;
  me._flinchAt = -10;
  const first = me.flinch(me._t);
  const during = an.currentAction;
  const again = me.flinch(me._t);            // same instant: the rate limit must refuse
  an.overlay = 'burst'; an.overlayTime = 0.1; me._flinchAt = -10;
  const inCast = me.flinch(me._t);           // committed cast: must refuse
  an.overlay = null;
  return { first, during, again, inCast };
});
check('flinch() plays the hit clip', flinch.first === true && flinch.during === 'hit',
  `play ${flinch.first}, action ${flinch.during}`);
check('a second hit in the same instant does not restart it', flinch.again === false);
check('a hit during a burst does not interrupt the cast', flinch.inCast === false);
check('the damage handler is the thing that calls it',
  /this\.me\.flinch\(\)/.test(fs.readFileSync(`${SRC}/game/game.js`, 'utf8')), 'game.js damage path');

/* --------------------------------------------- 3a2. 横移落在屏幕的哪一侧 -- */

// `camera.js:basis()` returned (-cos, +sin) as the right vector for a long time — the negation of
// forward × up — so D and → strafed *left*. It shipped because the only test of a side derived its
// subject through `basis()` and then measured the result by dotting against `basis()` again, and a
// sign that appears on both ends of a comparison cancels. So this one never mentions the basis:
// it holds a real key and asks where the character ended up **on screen**.
//
// Two details it cannot do without:
//  * The camera is snapshotted at t0 and both positions are projected through *that* clone. The
//    live rig is a spring bolted to the character, so it re-centres them within a few tenths of a
//    second and the live projection of a successful strafe is ~0. Freezing the viewpoint is what
//    makes "which side" a question at all.
//  * The key is held until the character has actually covered ground, not for a wall-clock
//    duration: llvmpipe renders 2–6 fps here and dt is clamped to 50 ms. If they never cover it,
//    the run SKIPs — a strafe into a rock is not evidence about a sign.
console.log('\n=== 横移落在屏幕的哪一侧');
const strafe = async (key, yaw) => {
  await p.evaluate((y) => {
    const g = window.game;
    g.me.clearGoal?.();
    g.rig.yaw = y;
    // `snapToFocus`, not one `update()`: the pivot is a critically-damped spring, so a single
    // 16 ms step after a yaw change leaves it metres behind and the character starts the run
    // outside the frame — which is what the first version of this section SKIPped on.
    g.rig.snapToFocus({ x: g.me.x, y: g.me.y, z: g.me.z }, 1.7);
    g.camera.updateMatrixWorld(true);
    window.__cam0 = g.camera.clone();
    window.__cam0.updateMatrixWorld(true);
    window.__p0 = { x: g.me.x, y: g.me.y, z: g.me.z };
  }, yaw);
  await p.keyboard.down(key);
  let moved = 0;
  for (let i = 0; i < 25; i++) {
    await sleep(220);
    moved = await p.evaluate(() => Math.hypot(window.game.me.x - window.__p0.x, window.game.me.z - window.__p0.z));
    if (moved > 1.6) break;
  }
  await p.keyboard.up(key);
  return p.evaluate(() => {
    const g = window.game, c = window.__cam0, p0 = window.__p0;
    const at = (x, y, z) => g.me.actor.group.position.clone().set(x, y, z).project(c);
    const a = at(p0.x, p0.y, p0.z), b = at(g.me.x, g.me.y, g.me.z);
    return {
      dx: +(b.x - a.x).toFixed(3),
      metres: +Math.hypot(g.me.x - p0.x, g.me.z - p0.z).toFixed(2),
      onScreen: Math.abs(a.x) < 1 && Math.abs(a.y) < 1 && Math.abs(b.x) < 1.6,
    };
  });
};
// Two camera angles, because a single yaw can be right by accident: at yaw 0 the world +X axis is
// screen right, so a basis that ignored yaw entirely would still pass there.
for (const [label, yaw] of [['相机朝北 (yaw 0)', 0], ['相机转过 126° (yaw 2.2)', 2.2]]) {
  const right = await strafe('KeyD', yaw);
  const left = await strafe('KeyA', yaw);
  const arrowR = await strafe('ArrowRight', yaw);
  const detail = (r) => `Δscreen ${r.dx >= 0 ? '+' : ''}${r.dx} over ${r.metres} m`;
  if (right.metres < 1.0 || left.metres < 1.0 || arrowR.metres < 1.0) {
    skipped(`横移方向 · ${label}`,
      `blocked here (D ${right.metres} m, A ${left.metres} m, → ${arrowR.metres} m) — no claim about a side`);
  } else if (!right.onScreen || !left.onScreen) {
    skipped(`横移方向 · ${label}`, 'the character left the frame, so a projected x means nothing');
  } else {
    check(`D 把角色移向屏幕右侧 · ${label}`, right.dx > 0.02, detail(right));
    check(`A 把角色移向屏幕左侧 · ${label}`, left.dx < -0.02, detail(left));
    check(`→ 与 D 同向 · ${label}`, arrowR.dx > 0.02, detail(arrowR));
    // The both-sided half: "D went right" is also true of a basis that sends every key right.
    check(`左右不是同一个方向 · ${label}`, right.dx > 0 && left.dx < 0,
      `D ${right.dx} vs A ${left.dx}`);
  }
}

/* ------------------------------------------------------------- 3b. climbing -- */

// The clip that had no state at all. Driven the way a player drives it: put the character at the
// foot of a face the walk rules refuse, point the camera at it (WASD is camera-relative, so the
// camera *is* the steering), and hold W. Nothing here calls a climb method, because there isn't
// one — climbing is a consequence of pushing into a slope, and that is exactly the part that was
// missing and could not be tested by inspection.
console.log('\n=== climbing');
// `world.slopeAt` is `1 - normal.y`, i.e. 0 flat and 1 vertical, so the walk limit of 0.68 is a
// 71° face and everything climbable is steeper than that. Nothing near the mondstadt spawn
// qualifies (the meadow is deliberately gentle: 0 of the cells within 70 m), so the probe has to
// travel — through `enterZone`, the same door the map's teleport uses, because a client-side
// `teleportTo` of 100 m trips the server's anti-teleport check and gets corrected straight back.
const wall = await p.evaluate(async () => {
  const g = window.game, w = g.world;
  const half = g.world.zone.size / 2 - 12;
  let best = null;
  for (let x = -half; x <= half; x += 4) {
    for (let z = -half; z <= half; z += 4) {
      const s = w.slopeAt(x, z);
      if (s > 0.68 && (!best || s > best.s)) best = { x, z, s: +s.toFixed(3) };
    }
  }
  if (!best) return null;
  // The face's downhill direction, by finite difference: that is where its base is, and standing
  // a few metres out means the hold starts as a walk and *becomes* a climb.
  const e = 1.5;
  const gx = w.heightAt(best.x + e, best.z) - w.heightAt(best.x - e, best.z);
  const gz = w.heightAt(best.x, best.z + e) - w.heightAt(best.x, best.z - e);
  const l = Math.hypot(gx, gz) || 1;
  const bx = best.x - (gx / l) * 4.5, bz = best.z - (gz / l) * 4.5;
  await g.enterZone(g.zoneId, { x: bx, z: bz });
  await new Promise((r) => setTimeout(r, 6000));
  return { ...best, base: { x: +bx.toFixed(1), z: +bz.toFixed(1), y: +w.heightAt(bx, bz).toFixed(2) } };
});
if (!wall) {
  skipped('climbing', 'no slope over the 0.68 walk limit anywhere in this zone');
} else {
  // Point the camera uphill from wherever the zone entry actually put us. WASD is camera-relative
  // (`basis()` forward is (-sin yaw, -cos yaw)), so the camera *is* the steering, and aiming it
  // from the live gradient rather than from the pre-computed spot survives a few metres of drift.
  const aim = await p.evaluate(() => {
    const g = window.game, me = g.me, w = g.world, e = 1.5;
    const gx = w.heightAt(me.x + e, me.z) - w.heightAt(me.x - e, me.z);
    const gz = w.heightAt(me.x, me.z + e) - w.heightAt(me.x, me.z - e);
    const l = Math.hypot(gx, gz) || 1;
    const ux = gx / l, uz = gz / l;                 // uphill
    g.rig.yaw = Math.atan2(-ux, -uz);
    return { x: +me.x.toFixed(1), z: +me.z.toFixed(1), uphillSlope: +w.slopeAt(me.x + ux * 3, me.z + uz * 3).toFixed(3) };
  });
  console.log(`  wall slope ${wall.s} at ${wall.x},${wall.z}; standing at ${aim.x},${aim.z}`
    + ` facing a ${aim.uphillSlope} face`);
  await sleep(1500);
  const start = await p.evaluate(() => ({
    y: window.game.me.y, stamina: window.game.me.stamina, climbing: window.game.me.climbing,
  }));
  // Held for *frames*, not seconds: llvmpipe renders 2–6 fps here and dt is clamped to 50 ms, so
  // a wall-clock hold of 2 s advances the simulation by a tenth of that. Poll for the height
  // gain instead of guessing a duration.
  await p.keyboard.down('KeyW');
  let climbState = null;
  for (let i = 0; i < 60; i++) {
    await sleep(600);
    climbState = await p.evaluate(() => {
      const g = window.game, me = g.me, w = g.world, e = 1.5;
      // Keep steering uphill: the rig re-aligns behind the character as it turns, and a camera
      // that drifts 30° turns "push into the wall" into "traverse along it".
      if (!me.climbing) {
        const gx = w.heightAt(me.x + e, me.z) - w.heightAt(me.x - e, me.z);
        const gz = w.heightAt(me.x, me.z + e) - w.heightAt(me.x, me.z - e);
        const l = Math.hypot(gx, gz) || 1;
        g.rig.yaw = Math.atan2(-gx / l, -gz / l);
      }
      return {
        y: me.y, climbing: me.climbing, grounded: me.grounded, stamina: me.stamina,
        base: me.actor.animator.base, action: me.currentAction(), speed: +me.speed.toFixed(2),
      };
    });
    if (climbState.climbing && climbState.y - start.y > 1.6) break;
  }
  await p.keyboard.up('KeyW');
  console.log(`  after the hold: y ${start.y.toFixed(2)} -> ${climbState.y.toFixed(2)}, `
    + `climbing ${climbState.climbing}, base ${climbState.base}, action ${climbState.action}, `
    + `stamina ${start.stamina.toFixed(0)} -> ${climbState.stamina.toFixed(0)}`);
  check('pushing into a steep face starts a climb', climbState.climbing === true,
    `climbing ${start.climbing} -> ${climbState.climbing}`);
  check('the climb actually gains height', climbState.y - start.y > 1.6,
    `+${(climbState.y - start.y).toFixed(2)} m`);
  check('the animator is on the climb clip', climbState.base === 'climb', `base ${climbState.base}`);
  check('the other players are told it is a climb', climbState.action === ACTION.climb,
    `action ${climbState.action} (want ${ACTION.climb})`);
  check('climbing spends stamina', climbState.stamina < start.stamina - 5,
    `${start.stamina.toFixed(0)} -> ${climbState.stamina.toFixed(0)}`);
  // Hanging: no input, still on the wall, and no longer paying for it.
  await sleep(2000);
  const hang = await p.evaluate(() => {
    const me = window.game.me;
    return { climbing: me.climbing, y: me.y, stamina: me.stamina };
  });
  await sleep(2000);
  const hang2 = await p.evaluate(() => ({ y: window.game.me.y, stamina: window.game.me.stamina }));
  check('letting go of the key hangs on the wall instead of dropping', hang.climbing === true);
  check('and hanging holds height', Math.abs(hang2.y - hang.y) < 0.2,
    `${hang.y.toFixed(2)} -> ${hang2.y.toFixed(2)}`);
  check('hanging does not keep draining stamina', hang2.stamina >= hang.stamina,
    `${hang.stamina.toFixed(0)} -> ${hang2.stamina.toFixed(0)}`);
  // Out of grip. Constructing the state is the only way to reach this branch: draining 240
  // stamina through the real drain would take 24 s of *simulated* time, minutes at this framerate.
  const dropped = await p.evaluate(async () => {
    const me = window.game.me;
    const y0 = me.y;
    me.stamina = 0;
    let at = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      // The state on the *release frame* — a few frames later the body has already landed at
      // the foot of the cliff, and "grounded" would be true for an honest reason.
      if (!me.climbing) { at = { grounded: me.grounded, action: me.currentAction(), y: me.y }; break; }
    }
    if (!at) return { climbing: me.climbing, timeout: true };
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    return { climbing: me.climbing, ...at, y0, yLater: me.y };
  });
  check('running out of stamina lets go of the wall', dropped.climbing === false,
    `climbing ${dropped.climbing}${dropped.timeout ? ' (never released)' : ''}`);
  // Strictly `grounded === false`: the loose `|| action === idle` form this check used to carry
  // passed while the character was parked on the face, because the landing snap counts standing
  // on a 79° cliff as standing on ground. The release has to put air under them.
  check('and the body is off the wall and falling', dropped.grounded === false,
    `grounded ${dropped.grounded}, action ${dropped.action}`);
  check('and it keeps losing height', dropped.yLater < dropped.y - 0.05,
    `${dropped.y?.toFixed(2)} -> ${dropped.yLater?.toFixed(2)}`);
  // Attacks are refused with both hands on the rock; the rule and the clip have to agree.
  const onWall = await p.evaluate(() => {
    const me = window.game.me;
    me.stamina = 200; me.climbing = true;
    const r = { attack: me.attack(window.game.actors), skill: me.useSkill(window.game.actors) };
    me.climbing = false;
    return r;
  });
  check('no attacking from a wall', onWall.attack === false && onWall.skill === false,
    `attack ${onWall.attack}, skill ${onWall.skill}`);
}

/* ------------------------------------------------------------ 4. the silhouettes -- */

await p.evaluate(async () => {
  const g = window.game;
  // A flat, well-lit spot with ground (not sky) behind the body at this framing.
  await g.enterZone('mondstadt', { x: 0, z: 14 });
  // Long enough for the zone-title card to finish its fade: it is drawn over the world, so a
  // shot taken under it measures the card.
  await new Promise((r) => setTimeout(r, 7000));
  if (g.quality !== 'high') { g.setAutoQuality(false); g.setQuality('high'); }
  if (window.ui?.panels?.isOpen) window.ui.panels.close();
  await new Promise((r) => setTimeout(r, 1500));
  g.stop();

  const me = g.me;
  const rig = me.actor.rig;
  // `actor.group` rather than `rig.group`: the actor is what the scene holds, so anything the
  // actor hangs beside the skeleton (aura, outline shell, weapon) goes with it.
  window.__mc = { rig, an: me.actor.animator, group: me.actor.group };
  // The shadow moves with the pose; leaving it in would let the ground carry part of the
  // evidence for a claim that is about the body.
  rig.group.traverse((o) => { if (o.isMesh) { o._cast = o.castShadow; o.castShadow = false; } });

  const h = me.actor.height;
  const cam = g.camera;
  const aimY = me.y + h * 0.70;
  const ang = me.ry + 0.6;                    // three-quarter view: arms and legs both read
  // Framed so nothing touches an edge, which took three tries and one measurement. At 2.3 body
  // heights six poses (climb, fall, plunge, aim, skill, attack2/5 — everything that reaches
  // overhead) had their box top pinned to y = 0, and a clipped silhouette is a *clamped
  // measurement*: the height and top-of-box comparisons below were reporting the viewport, not the
  // body. Pulling back to 2.8 fixed none of them, because the distance was never the problem — the
  // 0.30 h camera lift over a 0.52 h aim point tilted the view 6° down, and 6° of a 17° half-angle
  // is a third of the headroom.
  //
  // Levelling the shot (2° now) fixed five of the six; `climb` is the tallest silhouette in the
  // set — a full overhead reach at ~1.67 h against idle's 1.0 h — so the last numbers come from
  // that measurement rather than another nudge: at 3.9 h the visible span is 2.39 h (293 px per
  // body height) and aiming at 0.70 h puts the feet at ~555 px and that reach at ~66 px, clear at
  // both ends. Costs two thirds of the pixel count (~17k against a 4000 floor) and every geometric
  // claim here is a ratio, so none of them move.
  const dist = h * 3.9;
  cam.fov = 34;
  cam.position.set(me.x + Math.sin(ang) * dist, aimY + h * 0.12, me.z + Math.cos(ang) * dist);
  cam.lookAt(me.x, aimY, me.z);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  window.__mc.frame = { h, dist: +dist.toFixed(2) };

  // Pose a clip exactly: play it, then step the animator by hand with `auto:false` so the phase
  // is chosen rather than sampled. Locomotion clips get 0.45 s first so their cross-fade from
  // whatever was playing has finished — a half-faded pose is a blend, not the clip.
  // `cl` is the clip's metadata, handed in from node — the page has no export of `CLIPS` on
  // `window`, and adding one just for a probe would be product code that only a probe reads.
  window.__mcPose = (name, drive, cl) => {
    const S = window.__mc, an = S.an;
    const st = {
      auto: false, speed: drive.speed || 0,
      grounded: drive.grounded !== false, swimming: !!drive.swimming,
      gliding: !!drive.gliding, climbing: !!drive.climbing,
    };
    an.overlay = null; an.overlayWeight = 0; an.fadeFrom = null;
    an.base = 'idle'; an.baseTime = 0; an.basePhase = 0;
    an.play(name, { restart: true });
    const step = 1 / 60;
    let settle = cl.locomotion ? 0.45 : 0;
    for (let t = 0; t < settle; t += step) an.update(step, st);
    if (cl.locomotion) {
      // Distance-driven clips advance on metres, time-driven ones on seconds.
      const want = drive.phase * (cl.loop || 1);
      an.baseTime = 0; an.basePhase = 0;
      // A paced clip's stride is the character's own, so ask the animator for it rather than
      // carrying a copy: one cycle per stride metres at this speed.
      const secs = cl.paced ? (drive.phase * an.strideAt(st.speed)) / Math.max(0.01, st.speed) : want;
      for (let t = 0; t < secs; t += step) an.update(step, st);
    } else {
      const secs = drive.phase * cl.dur;
      for (let t = 0; t < secs; t += step) an.update(step, st);
    }
    for (let i = 0; i < 3; i++) window.game.r.render(0.016);
    return {
      base: an.base, overlay: an.overlay,
      weight: +(an.overlayWeight || 0).toFixed(2),
      hipsY: +window.__mc.rig.bones.hips.position.y.toFixed(3),
    };
  };
  window.__mcHide = (on) => { window.__mc.group.visible = !on; for (let i = 0; i < 3; i++) window.game.r.render(0.016); };
});
const info = await p.evaluate(() => ({
  zone: window.game.zoneId, quality: window.game.quality, frame: window.__mc.frame,
  panel: !!window.ui?.panels?.isOpen, running: window.game._running,
}));
console.log(`\n=== silhouettes in ${info.zone} @ ${info.quality}, camera ${info.frame.dist}m`);
check('the tier is still pinned after the zone change', info.quality === 'high', info.quality);
check('nothing is drawn over the world while shooting', info.panel === false, `panel ${info.panel}`);
check('the game loop is stopped, so the camera cannot drift between shots', info.running === false);

const shoot = async (file) => {
  await p.screenshot({ path: file });
  return decodePng(fs.readFileSync(file));
};

// The world behind the character, shot twice. Identical frames are what makes one hidden frame
// good for all 24 clips — and a frozen page would make them identical *and* every mask empty,
// which the per-clip pixel floor catches.
//
// Two shots 700 ms apart are a *short* baseline, though, and this one has come back 0 px while the
// run as a whole still moved: the poses take half a minute, and by the last of them a few pixels of
// sky had changed by more than the tolerance. `_world-c.png` at the end of the run measures that
// long baseline, and `largestBlob` below is what makes it harmless.
await p.evaluate(() => window.__mcHide(true));
await sleep(900);
const bg1 = await shoot(`${outDir}/_world-a.png`);
await sleep(700);
const bg2 = await shoot(`${outDir}/_world-b.png`);
const drift = pixelsDiffering(bg1, bg2, 8);
check('the world behind the character holds still between frames', drift <= MAX_WORLD_DRIFT,
  `${drift}px differ`);
await p.evaluate(() => window.__mcHide(false));

/**
 * The dense part of a mask: rows and columns holding less than `frac` of the peak row/column are
 * dropped. Used for `body` below, not for the silhouette.
 */
const denseBox = (m, frac) => {
  const rows = new Array(H).fill(0), cols = new Array(W).fill(0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m.mask[y * W + x]) { rows[y]++; cols[x]++; }
  const rowFloor = Math.max(4, Math.max(...rows) * frac);
  const colFloor = Math.max(4, Math.max(...cols) * frac);
  const span = (arr, floor) => {
    let lo = -1, hi = -1;
    for (let i = 0; i < arr.length; i++) if (arr[i] >= floor) { if (lo < 0) lo = i; hi = i; }
    return lo < 0 ? [0, -1] : [lo, hi];
  };
  const [y0, y1] = span(rows, rowFloor);
  const [x0, x1] = span(cols, colFloor);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};

/**
 * Two boxes per pose, because "the topmost differing pixel" has been the wrong thing twice.
 *
 * `box` is the silhouette: `largestBlob` of the mask, so pixels that are not attached to the
 * character are gone. A density floor cannot do that job — a 4-px scrap of drifting sky 177 px
 * above the head clears 2 % of a 90-px peak row, and it moved the idle box from `95x305 @456,261`
 * to `95x482 @456,84` at an unchanged pixel count, which failed `climb reaches above where
 * standing puts the head` by one pixel against a box top that was cloud.
 *
 * `body` is the same mask with thin extremities trimmed at 15 %, and it exists because the
 * silhouette's top is not the head either: the climb clip raises the sword, so climb's blob starts
 * 180 px above idle's — a claim about *the head* that would pass on a weapon alone. Measured on
 * the body, the reach is a real 61 px. So: width, aspect, framing and pixel counts read the
 * silhouette (a drawn weapon is part of the shape); anything that says "head" reads the body.
 */
const boxesOf = (m) => ({ box: m.box || { x: 0, y: 0, w: 0, h: 0 }, body: denseBox(m, 0.15) });

const iou = (a, c) => {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.mask.length; i++) {
    const x = a.mask[i], y = c.mask[i];
    if (x && y) inter++;
    if (x || y) uni++;
  }
  return uni ? inter / uni : 0;
};
const shots = new Map();
for (const name of clipNames) {
  const drive = DRIVE[name];
  if (!drive) { skipped(`${name}`, 'no drive recipe — add one to DRIVE'); continue; }
  const st = await p.evaluate(([n, d, c]) => window.__mcPose(n, d, c), [name, drive, meta(name)]);
  await sleep(700);
  const img = await shoot(`${outDir}/${name}.png`);
  const raw = diffMask(img, bg1, 8);
  const m = largestBlob(raw);
  const { box: bx, body } = boxesOf(m);
  shots.set(name, { m, st, box: bx, body, dropped: raw.count - m.count, raw: raw.count });
  console.log(`  ${name.padEnd(9)} ${String(m.count).padStart(6)}px  box ${bx.w}x${bx.h} @${bx.x},${bx.y}`
    + `  body ${body.w}x${body.h} @${body.x},${body.y}  -${raw.count - m.count}px in ${m.blobs - m.kept} specks`
    + `  base ${st.base}${st.overlay ? ` overlay ${st.overlay} w${st.weight}` : ''} hipsY ${st.hipsY}`);
  check(`${name}: the character is on screen in this pose`, m.count >= MIN_PX, `${m.count}px`);
  // …and that it is the character, not a HUD element that happened to repaint. The camera is
  // aimed at the body, so the silhouette's own centre has to be near the middle of the frame:
  // the run that had the map panel open produced 500–2000 px masks parked in the corners and
  // would otherwise have satisfied any bare pixel floor.
  if (m.count >= MIN_PX) {
    const cx = bx.x + bx.w / 2, cy = bx.y + bx.h / 2;
    check(`${name}: that silhouette is where the camera is pointed`,
      Math.abs(cx - W / 2) < 200 && Math.abs(cy - H / 2) < 200,
      `centre ${cx.toFixed(0)},${cy.toFixed(0)}`);
    // Whole body in frame, or every measurement below is reporting the frame edge. This is the
    // check that would have caught the 2.3-body-height framing, where six overhead poses had
    // their box top pinned to 0 and their measured height capped by the viewport.
    check(`${name}: the whole pose is inside the frame, not cut off by an edge`,
      bx.y > 0 && bx.y + bx.h < H - 1 && bx.x > 0 && bx.x + bx.w < W - 1,
      `box ${bx.w}x${bx.h} @${bx.x},${bx.y} in ${W}x${H}`);
  }
}

// The control: idle, posed and shot a second time. If this does not come back as the same
// silhouette, none of the comparisons below mean anything.
const st2 = await p.evaluate(([n, d, c]) => window.__mcPose(n, d, c), ['idle', DRIVE.idle, meta('idle')]);
await sleep(700);
const idle2 = largestBlob(diffMask(await shoot(`${outDir}/_idle-again.png`), bg1, 8));
const stable = shots.has('idle') ? iou(shots.get('idle').m, idle2) : 0;
check('the same pose measured twice is the same silhouette', stable >= MIN_STABLE,
  `IoU ${stable.toFixed(4)} (base ${st2.base})`);

// What the speck filter threw away, over the whole run, and how much the world moved while it ran.
// The drift is a diagnostic, not a gate — a live world is allowed to move, and it read 0 px in the
// run that first went green here while every pose still shed 37–101 unattached scraps to llvmpipe's
// dither, so the filter is never idle. The assertion is the other side: it must not be eating the
// character, which is what would happen if a pose ever photographed as two separate islands.
await p.evaluate(() => window.__mcHide(true));
await sleep(700);
const drift2 = pixelsDiffering(bg1, await shoot(`${outDir}/_world-c.png`), 8);
await p.evaluate(() => window.__mcHide(false));
const worst = [...shots.values()].reduce((a, s) => Math.max(a, s.dropped / Math.max(1, s.raw)), 0);
console.log(`  world drift over the whole run: ${drift2}px (700ms baseline was ${drift}px)`);
check('the speck filter kept the character and only dropped scraps',
  worst < 0.03, `worst pose lost ${(worst * 100).toFixed(2)}% of its mask`);

console.log('\n=== each pose against standing still');
const idleShot = shots.get('idle');
for (const [name, s] of shots) {
  if (name === 'idle') continue;
  const v = iou(idleShot.m, s.m);
  check(`${name}: is a different shape from idle`, v <= MAX_SELF_IOU, `IoU ${v.toFixed(3)}`);
}

// Two clips that photograph the same are one clip with two names — the failure mode where a new
// clip is added, wired, and quietly falls back to the pose it was copied from.
console.log('\n=== pose collisions');
const names = [...shots.keys()];
const twins = [];
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const v = iou(shots.get(names[i]).m, shots.get(names[j]).m);
    if (v >= MAX_PAIR_IOU) twins.push(`${names[i]}≈${names[j]} (${v.toFixed(3)})`);
  }
}
check('no two clips photograph as the same pose', twins.length === 0,
  twins.length ? twins.join(', ') : `${(names.length * (names.length - 1)) / 2} pairs compared`);

// Direction, not just difference: a pose can differ from idle and still be wrong. These four are
// the ones with an unambiguous geometric promise, and they are the four that were dead.
console.log('\n=== the four that nothing used to play');
// `S` = silhouette (widths, aspects — a raised sword is part of the shape the player sees),
// `B` = body (tops, heights — see `boxesOf`: the silhouette's top is whatever is topmost, and for
// climb and aim that is a weapon 100–180 px above the head).
const S = (n) => shots.get(n)?.box || null;
const B = (n) => shots.get(n)?.body || null;
const aspect = (b) => b.w / Math.max(1, b.h);
if (B('idle') && B('sit')) {
  check('sit puts the head well below where standing puts it',
    B('sit').y > B('idle').y + 60, `top ${B('sit').y} vs idle ${B('idle').y}`);
  // 0.85, measured: sitting came back 229 px of body against a standing 299 (0.77). The head-drop
  // check above carries the strong form of the claim; this one only has to reject
  // «standing still, relabelled», so it is not worth being 8 px from its own bound.
  check('and the body is shorter on screen without lying down',
    B('sit').h <= B('idle').h * 0.85 && aspect(S('sit')) < 1,
    `height ${B('sit').h} vs idle ${B('idle').h}, aspect ${aspect(S('sit')).toFixed(2)}`);
} else skipped('sit geometry', 'no silhouette');
if (S('idle') && S('down')) {
  // Prone, not merely crouched: the clip rolls the hips 81° and drops them half a body height,
  // so the silhouette has to come out wider than it is tall. Standing is ~0.3.
  check('down photographs as a body on the ground, wider than it is tall',
    aspect(S('down')) >= 1.0 && aspect(S('down')) >= aspect(S('idle')) * 2.5,
    `aspect ${aspect(S('down')).toFixed(2)} vs idle ${aspect(S('idle')).toFixed(2)}`);
  check('and its head is lower than the sitting pose puts it',
    B('sit') ? B('down').y > B('sit').y : false, `top ${B('down').y} vs sit ${B('sit')?.y}`);
} else skipped('down geometry', 'no silhouette');
if (S('idle') && S('aim')) {
  check('aim reaches wider than standing (bow arm out, draw hand back)',
    S('aim').w >= S('idle').w * 1.15, `width ${S('aim').w} vs idle ${S('idle').w}`);
  check('and it is still a standing pose, not a crouch',
    B('aim').h >= B('idle').h * 0.85, `height ${B('aim').h} vs idle ${B('idle').h}`);
} else skipped('aim geometry', 'no silhouette');
if (S('idle') && S('climb')) {
  // A climb is a body pressed flat against rock with one arm reaching for the next hold: taller
  // than standing (the reach), and *narrower relative to its height* than a walk, whose arms and
  // legs swing out sideways. Both directions matter — "differs from idle" was already true of the
  // pose before the clip existed, because falling differs from idle too.
  check('climb reaches above where standing puts the head',
    B('climb').y < B('idle').y - 40 && B('climb').h > B('idle').h,
    `top ${B('climb').y} vs idle ${B('idle').y}, height ${B('climb').h} vs ${B('idle').h}`);
  check('and hugs the face instead of swinging its limbs out',
    aspect(S('climb')) < 0.55 && (S('walk') ? aspect(S('climb')) < aspect(S('walk')) : true),
    `aspect ${aspect(S('climb')).toFixed(2)} vs walk ${S('walk') ? aspect(S('walk')).toFixed(2) : 'n/a'}`);
} else skipped('climb geometry', 'no silhouette');

/* ------------------------------------------------------------------- tally -- */

console.log(`\nerrors -> ${errs.length ? errs.slice(0, 4).join(' | ') : 'none'}`);
console.log(`hmr    -> ${hmr.length ? hmr.length : 'none'}`);
check('no page errors while posing', errs.length === 0, errs.slice(0, 2).join(' | '));
check('client/src was not hot-updated mid-run', hmr.length === 0, `${hmr.length} HMR events`);

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
console.log(`shots -> ${outDir}`);
await b.close();
process.exit(fail === 0 && pass >= 60 ? 0 : 1);
