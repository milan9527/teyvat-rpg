// BOSS 阶段 probe: does the fight tell the player it just changed?
//
//   DISPLAY=:99 node tools/boss-check.mjs [baseUrl] [outDir]
//
// Two defects lived in the same word, and this file exists because of both.
//
// 1) `Entity.serialize()` has always shipped `ph`, the boss's battle phase. Crossing an hp
//    threshold steps it up (`takeDamage`: `wanted = phases - floor(frac*phases)`), staggers the
//    creature for 1.2 s, opens the rest of its move pool (`chooseMove`) and shortens every
//    windup and cooldown by 15-40% (`zoneInstance`). Nothing on the client read it. The fight
//    got faster and the player was told nothing — no sound, no text, no light. `phase2` (the
//    herald's hunch) was the only consumer, and it cannot be seen from behind or in the dark.
//
// 2) `ActorSystem` passed that same integer into `EnemyActor.update` under the key `phase`,
//    which is what every `pose()` in `gfx/enemies.js` calls its **gait clock**:
//    `st.phase ?? t * rate`. An integer is not nullish, so the fallback never ran and the clock
//    never advanced. Every walker in the game — hilichurl ×3, ruin guard, wolf, vishap — slid
//    across the ground with its legs frozen at sin(1), left leg permanently forward.
//
// So the assertions come in pairs, and each pair is pinned from both sides:
//
//   §1 the gait clock advances with the *ground the creature covers* — so the planted foot
//      stays planted (measured off the rig at two speeds), it stops dead at speed 0, it is
//      repeatable at a pinned value, a per-actor `gaitOffset` really separates two creatures of
//      the same kind, and — the regression lock, read off disk — no file puts a battle phase
//      into the pose state any more and no kind hides its stride geometry from the `GAIT` table.
//      (Making the legs move was round one; a time-driven clock made all five walkers skate
//      1.5-2.4× further than their feet could reach, which is round two.)
//   §2 a phase change reaches the player through four channels (banner, plate pips, threshold
//      ticks, sound), each measured in pixels or as a recorded call, each with a control that
//      must *not* fire: damage that stops short of the threshold, and an ordinary enemy.
//
// One thing §1 would get wrong if it were careless, and it is why it reads *thighs only*: every
// pose also has terms driven straight off `t` (a wolf's tail, a hilichurl's head sweep), so
// "some bone moved between two times" was true throughout the whole life of the bug. Thigh
// rotation.x is a pure function of the gait clock and the speed blend, and nothing else.
//
// The canvas is hidden for every pixel read: these are 5-pixel bars and 10-pixel glyphs over a
// lit 3D frame, and this repo has already read a violet HUD line as grey through one.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { ENEMIES } from '../shared/src/data/enemies.js';
import { decodePng, rectStats, pixelsDiffering } from './lib/png.mjs';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/boss-check';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.png')) rmSync(`${outDir}/${f}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0, skip = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}
function skipped(name, why) { skip++; console.log(`  SKIP ${name} — ${why}`); }

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
    'media.autoplay.default': 0,
  },
  defaultViewport: { width: W, height: H },
});
const p = await b.newPage();
const errors = [];
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

let step = 0;
async function shot(name) {
  step++;
  const file = `${outDir}/${String(step).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file });
  return { img: decodePng(readFileSync(file)), file };
}

const frameCount = () => p.evaluate(() => window.__bcFrames || 0);
/** Wait for real rendered frames: llvmpipe runs this page at ~3 fps and a sleep is a hope. */
async function frames(n = 2) {
  const from = await frameCount();
  for (let i = 0; i < 400; i++) {
    const now = await frameCount();
    if (now - from >= n) return now - from;
    await sleep(100);
  }
  return -1;
}
const hideCanvas = (h) => p.evaluate((hid) => {
  for (const c of document.querySelectorAll('canvas')) c.style.visibility = hid ? 'hidden' : '';
}, h);
const inset = (r, label) => ({
  x: Math.round(r.x) + 1, y: Math.round(r.y) + 1,
  w: Math.max(2, Math.round(r.w) - 2), h: Math.max(2, Math.round(r.h) - 2), label,
});
const onScreen = (r) => r && r.w > 1 && r.h > 1 && r.x > 0 && r.y > 0
  && r.x + r.w < W - 1 && r.y + r.h < H - 1;

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await (await p.$('[data-act="solo"]')).click();
  await sleep(300);
  const guest = await p.$('[data-act="guest"]') || await p.$('[data-act="resume"]');
  await guest.click();
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  const boot = await p.evaluate(() => {
    const g = window.game;
    if (!g) return null;
    window.__bcFrames = 0;
    g.on('frame', () => { window.__bcFrames++; });
    // Every phase change the client announces, in order, as the *game* reports it.
    window.__phaseUps = [];
    g.on('bossPhase', (d) => window.__phaseUps.push({ ...d, at: performance.now() }));
    // Every sound the game asks for. A container has no audio device, but the request is
    // routed all the same, and "what was the player told" is exactly the question here.
    window.__cues = [];
    const real = g.audio.sfx.bind(g.audio);
    g.audio.sfx = (name, opts) => { window.__cues.push({ name, opts: opts || null }); return real(name, opts); };
    g.setAutoQuality(false);
    g.setQuality('high');
    g.setWorldTime(12);
    g.tutorial?.skip?.();
    g.settings.showNames = true;   // nameplates are the surface under test in §2
    return { running: !!g._running, inst: !!g.socket?.inst, quality: g.quality, names: g.settings.showNames };
  });
  check('the solo world booted with its own simulation in the tab',
    !!boot && boot.running && boot.inst === true, boot ? `quality ${boot.quality}` : 'no game');
  check('the tier is pinned to high and nameplates are on',
    boot?.quality === 'high' && boot?.names === true, `${boot?.quality}, names ${boot?.names}`);

  /* =============================================================== 1) 步态 == */

  console.log('\n--- 1. the gait clock advances (it used to be pinned to the battle phase)');

  // One id per model kind that walks, plus a second hilichurl variant.
  const WALKERS = ['hilichurl', 'hilichurlPyro', 'ruinGuard', 'frostWolf', 'geoVishap'];
  const walkers = WALKERS.filter((id) => ENEMIES[id]);
  check('the walking bestiary is what this file thinks it is',
    walkers.length === WALKERS.length, `${walkers.length}/${WALKERS.length}: ${walkers.join(' ')}`);

  // Driven through the product's own call — `EnemyActor.update(dt, t, st)` with the state
  // object `ActorSystem.update` builds — and read out of the live scene graph, so this is the
  // pose that would be rendered rather than a re-implementation of it.
  //
  // The headline reading is **foot slip**, in metres, because that is the defect a player sees:
  // the clock used to be time-driven (`t * rate`), so the ground a creature covered in one
  // stride was `speed / rate` — whatever that happened to be — and it was 1.5-2.4× further than
  // its legs could reach in every one of these five. The feet skated. It is now driven by the
  // distance actually travelled (`4 · hip · sin(amp · run)` metres per cycle), so the planted
  // foot should stay planted, and *that* is measurable from the rig itself.
  const gait = await p.evaluate(async (spec) => {
    const g = window.game, inst = g.socket.inst;
    const out = {};
    for (const { id, speed } of spec) {
      const yaw = g.rig?.yaw ?? 0;
      const ent = inst.spawnEnemy(id, 20, g.me.x - Math.sin(yaw) * 14, g.me.z - Math.cos(yaw) * 14);
      if (!ent) { out[id] = { error: 'spawn refused' }; continue; }
      ent.y = g.me.y; ent.state = 'idle'; ent.ai = null; ent.stunned = 1e9;
      // The actor is created when the snapshot carrying this id arrives; match on the id, not
      // on the kind, so a hilichurl that was already wandering the field cannot be measured
      // instead of this one.
      let a = null;
      for (let i = 0; i < 200 && !a; i++) {
        a = g.actors.enemies.get(ent.id) || null;
        if (!a) await new Promise((r) => setTimeout(r, 50));
      }
      if (!a) { out[id] = { error: 'no actor for the spawned id' }; continue; }
      const view = a.actor.view, bones = view.bones, dims = view.dims || {};
      // The point that touches the ground. The bipeds' `place()` lands the ankle bone exactly on
      // the ground, so the foot bone's own origin is the contact point; the wolf has no foot
      // bone at all, so its paw is the shin extended by its own length.
      const legs = bones.footL
        ? [{ bone: 'footL' }, { bone: 'footR' }]
        : [{ bone: 'fShinL', ext: dims.shin || 0 }, { bone: 'bShinL', ext: dims.shin || 0 }];
      if (legs.some((l) => !bones[l.bone])) { out[id] = { error: `no contact bone (${legs.map((l) => l.bone)})` }; continue; }
      const thigh = ['thighL', 'fThighL', 'bThighL'].find((n) => bones[n]);
      if (!thigh) { out[id] = { error: 'no thigh bone' }; continue; }

      const grp = view.group;
      // Measure in the model's own frame: park the group at the origin, unrotated, so +Z is
      // forward and a bone's world matrix reads as model-space metres. Nothing can interleave —
      // this whole block is synchronous, and the frame loop only writes the group's transform.
      const keep = { x: grp.position.x, y: grp.position.y, z: grp.position.z, ry: grp.rotation.y };
      grp.position.set(0, 0, 0); grp.rotation.y = 0;
      /** World-space contact point of one leg, in metres. */
      const contact = (l) => {
        const e = bones[l.bone].matrixWorld.elements;
        // e[12..14] is the bone origin. Column 1 (e[4..6]) is its local +Y axis *including* the
        // model scale, and bones point down -Y, so the tip is the origin minus ext·that.
        return e[14] - (l.ext ? e[6] * l.ext : 0);
      };
      /**
       * Walk the rig at a constant speed for `secs` and report how far the planted foot slid.
       *
       * Stance is the run of frames where the contact point travels *backwards* through the
       * model, which is exactly what a foot does while the body moves over it. Over one stance
       * the foot should travel back by as much ground as the creature covered forward: a ratio
       * of 1 is a planted foot, 0.4 is a foot sliding 60% of the way.
       */
      const walk = (v, secs = 4, dt = 1 / 60) => {
        const steps = Math.round(secs / dt);
        const z = [], th = [];
        for (let i = 0; i < steps; i++) {
          a.actor.update(dt, 100 + i * dt, { speed: v, attack: 0, gaitOffset: 0, phase2: false });
          grp.updateMatrixWorld(true);
          z.push(contact(legs[0]));
          th.push(bones[thigh].rotation.x);
        }
        let best = null, cur = null, stances = 0, prevBack = false;
        for (let i = 1; i < z.length; i++) {
          const back = z[i] < z[i - 1];
          if (back && !prevBack) stances++;
          if (back) cur = cur ? { from: cur.from, to: i } : { from: i - 1, to: i };
          else if (cur) { if (!best || cur.to - cur.from > best.to - best.from) best = cur; cur = null; }
          prevBack = back;
        }
        if (cur && (!best || cur.to - cur.from > best.to - best.from)) best = cur;
        if (!best) return { ratio: 0, stances, cadence: 0, foot: 0, ground: 0, frames: 0 };
        const foot = z[best.from] - z[best.to];
        const ground = (best.to - best.from) * v * dt;
        return {
          ratio: +(foot / Math.max(1e-6, ground)).toFixed(3),
          foot: +foot.toFixed(3), ground: +ground.toFixed(3), frames: best.to - best.from,
          stances, cadence: +(stances / secs).toFixed(2),
          swing: +(Math.max(...th) - Math.min(...th)).toFixed(4),
        };
      };

      const full = walk(speed);
      const half = walk(speed * 0.5);
      // Standing still: the clock must not advance at all, or a creature waiting for the player
      // paddles its legs on the spot.
      const idle0 = (() => {
        const th = [];
        for (let i = 0; i < 30; i++) {
          a.actor.update(1 / 60, 200 + i / 60, { speed: 0, attack: 0, gaitOffset: 0, phase2: false });
          th.push(bones[thigh].rotation.x);
        }
        return +(Math.max(...th) - Math.min(...th)).toFixed(6);
      })();
      /** Pose the rig at a pinned clock — the contract every screenshot tool relies on. */
      const at = (gaitRad, offset = 0) => {
        a.actor.update(1 / 60, 300, { speed: speed, attack: 0, gait: gaitRad, gaitOffset: offset, phase2: false });
        return +bones[thigh].rotation.x.toFixed(6);
      };
      const pinA = at(1.0), pinB = at(1.0), pinC = at(1.0 + Math.PI / 2), pinOff = at(1.0, Math.PI / 2);

      grp.position.set(keep.x, keep.y, keep.z); grp.rotation.y = keep.ry;
      out[id] = {
        full, half, idle0,
        pinRepeat: +Math.abs(pinA - pinB).toFixed(6),
        pinMoves: +Math.abs(pinA - pinC).toFixed(4),
        byOffset: +Math.abs(pinA - pinOff).toFixed(4),
        gaitOffset: +(a.gaitOffset ?? -1).toFixed(3),
        contact: legs[0].bone, hip: +(dims.leg ?? dims.back ?? dims.hipY ?? 0).toFixed(3),
      };
      ent.alive = false; ent.hp = 0; inst.enemies.delete(ent.id);
    }
    return out;
  }, walkers.map((id) => ({ id, speed: ENEMIES[id].speed })));

  for (const id of walkers) {
    const r = gait[id] || {};
    console.log(`  ${id}: ${JSON.stringify(r)}`);
    const nm = ENEMIES[id].name;
    if (r.error) { skipped(`${nm} — the planted foot stays planted`, r.error); continue; }
    // Both sides, and the same band at two speeds. 1.0 is a foot that does not slide at all;
    // the floor is what the *old* time-driven clock could not reach (it measured 0.41-0.66 in
    // these five kinds), and the ceiling catches the opposite mistake — a clock running too
    // fast makes the feet paddle backwards faster than the ground, which reads as scrabbling.
    // The band is tight because these are sim-side reads (update() driven at a fixed dt, no
    // renderer in the loop): the five clean kinds sit in 0.978-1.067 at both speeds. It was
    // 0.75-1.30 until a mutation run dropped the `mScale` factor from the stride and the
    // 火斧丘丘人 — model scale 1.12 — stayed green at 1.17. A 12% stride error is visible.
    const band = (v) => v >= 0.88 && v <= 1.15;
    check(`${nm} — the planted foot stays planted at full speed`,
      band(r.full?.ratio), `foot travelled ${r.full?.foot} m over ${r.full?.ground} m of ground`
      + ` (ratio ${r.full?.ratio}, ${r.full?.frames} frames of stance, contact bone ${r.contact})`);
    check(`${nm} — ...and at half speed, where the stride is shorter`,
      band(r.half?.ratio), `ratio ${r.half?.ratio}: ${r.half?.foot} m of foot over ${r.half?.ground} m`);
    // Cadence is no longer authored — it falls out of the leg geometry — so it needs a sanity
    // band of its own: below this a run reads as slow motion, above it as a blur.
    check(`${nm} — its cadence is believable for its size`,
      r.full?.cadence >= 0.6 && r.full?.cadence <= 3.2,
      `${r.full?.cadence} Hz at ${ENEMIES[id].speed} m/s (hip ${r.hip} model units), ${r.half?.cadence} Hz at half speed`);
    check(`${nm} — the legs do not cycle while it stands still`,
      r.idle0 < 1e-6, `thigh pitch over 30 frames at speed 0: ${r.idle0} rad`);
    check(`${nm} — a pinned clock still holds one exact pose`,
      r.pinRepeat < 1e-6 && r.pinMoves > 0.05,
      `same gait twice: ${r.pinRepeat} rad apart; a quarter cycle later: ${r.pinMoves} rad`);
    check(`${nm} — a per-actor offset changes where in the stride it is`,
      r.byOffset > 0.05, `quarter-cycle offset: ${r.byOffset} rad`);
    check(`${nm} — and the actor was actually given an offset`,
      r.gaitOffset >= 0 && r.gaitOffset <= Math.PI * 2, `gaitOffset ${r.gaitOffset} rad`);
  }

  // The regression lock, read off disk. The bug was a *name*: two quantities sharing the key
  // `phase` on one state object. Either half coming back re-freezes every walker in the game,
  // and no pixel test can tell a frozen leg from a slow one at 3 fps.
  const src = (rel) => readFileSync(new URL(`../client/src/${rel}`, import.meta.url), 'utf8');
  // Comments stripped before the lock is applied: the fix documents the bug it fixed, in prose,
  // right above the helper, and the first version of this check failed on its own explanation.
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const enemiesSrc = code(src('gfx/enemies.js'));
  const actorsSrc = code(src('game/actors.js'));
  check('no pose function reads a key called `phase` for its clock',
    !/st\.phase\s*\?\?/.test(enemiesSrc) && /function gaitPhase\(/.test(enemiesSrc),
    `${(enemiesSrc.match(/gaitPhase\(st, t,/g) || []).length} kinds go through gaitPhase()`);
  const loopFrom = actorsSrc.indexOf('for (const e of this.enemies.values())');
  const enemyLoop = loopFrom < 0 ? '' : actorsSrc.slice(loopFrom, loopFrom + 600);
  const passesPhase = /actor\.update\([^)]*\bphase:/s.test(enemyLoop);
  check('and ActorSystem hands the pose a gaitOffset, never a battle phase',
    loopFrom > 0 && !passesPhase && /gaitOffset: e\.gaitOffset/.test(enemyLoop),
    passesPhase ? 'actor.update is being given a `phase:` again' : 'gaitOffset + phase2 only');
  // The stride length and the swing amplitude are one number in two places by nature — the pose
  // draws the leg, the clock decides how much ground that leg is worth. They live in `GAIT` and
  // the poses read them back; a literal creeping into either is how the feet start skating
  // again, silently, in one kind only.
  const kindsWithGait = (enemiesSrc.match(/gait: GAIT\./g) || []).length;
  check('every walking kind declares its gait geometry in one table',
    kindsWithGait === 4 && /const GAIT = \{/.test(enemiesSrc)
    && !/rotation\.x = d \* 0\.\d+ \* run/.test(enemiesSrc),
    `${kindsWithGait} kinds carry a GAIT entry, and no pose hardcodes a thigh amplitude`);
  check('and the clock is integrated from ground covered, not from t',
    /gait \+= \(v \* dt \/ stride\) \* Math\.PI \* 2/.test(enemiesSrc)
    && /strideRef \* mScale \* \(Math\.sin\(K\.gait\.amp \* run\) \/ strideSin\)/.test(enemiesSrc)
    && /function measureStride\(/.test(enemiesSrc),
    'buildRigged integrates speed·dt / stride, and the stride is measured off the rig');

  // Everything above poses the rig by hand, which means it would still pass with the bug put
  // back: the state object `ActorSystem.update` builds is never involved. So one more, through
  // the real frame loop — an unpinned hilichurl left to walk in at the player under its own AI,
  // sampled over a dozen rendered frames. Under the bug the pose state carried `phase: 1`, a
  // constant, and this number was flat while the creature crossed the ground.
  const live = await p.evaluate(() => {
    const g = window.game, inst = g.socket.inst;
    inst.enemies.clear();
    const yaw = g.rig?.yaw ?? 0;
    // Inside aggro range, and *not* pinned: no `state`, no `ai = null`, no `stunned`.
    const ent = inst.spawnEnemy('hilichurl', 20, g.me.x - Math.sin(yaw) * 12, g.me.z - Math.cos(yaw) * 12);
    if (!ent) return null;
    window.__walker = ent.id;
    return { id: ent.id };
  });
  if (!live) {
    skipped('a hilichurl walking under its own AI swings its legs as it goes', 'spawn refused');
  } else {
    const samples = [];
    for (let i = 0; i < 16; i++) {
      samples.push(await p.evaluate(() => {
        const g = window.game, inst = g.socket.inst;
        // Keep it walking. Left alone it covers the 12 m in four frames at 3 fps and then
        // stands there swinging, and an attack pose overwrites the thigh pitch — so when it
        // gets close, put it back out at 13 m and let it come in again. Same chase, more of it.
        const ent = inst.enemies.get(window.__walker);
        if (ent && Math.hypot(ent.x - g.me.x, ent.z - g.me.z) < 8) {
          const yaw = g.rig?.yaw ?? 0;
          ent.x = g.me.x - Math.sin(yaw) * 13;
          ent.z = g.me.z - Math.cos(yaw) * 13;
          ent.dirty = true;
        }
        const e = g.actors.enemies.get(window.__walker);
        const bn = e?.actor?.view?.bones?.thighL;
        return e && bn
          ? { speed: +e.speed.toFixed(2), atk: e.attacking != null, th: +bn.rotation.x.toFixed(4) }
          : null;
      }));
      await frames(1);
    }
    // Only frames where it was actually walking and not swinging: `st.attack` overrides the
    // thigh pitch outright, and at speed 0 every gait term is multiplied by a `run` of 0, so
    // both would answer a different question.
    const walking = samples.filter((s) => s && !s.atk && s.speed > 1.2);
    const th = walking.map((s) => s.th);
    if (walking.length < 6) {
      skipped('a hilichurl walking under its own AI swings its legs as it goes',
        `only ${walking.length} of ${samples.length} frames had it walking and not attacking`
        + ` (speeds ${samples.map((s) => s?.speed ?? 'x').join(',')})`);
    } else {
      const spread = +(Math.max(...th) - Math.min(...th)).toFixed(4);
      // Raw spread is *not* the test, and the first version of this probe was wrong about that:
      // the hilichurl's thigh pitch is `sin(ph) * 0.62 * run`, and `run` climbs from 0.5 to 1.0
      // as the creature accelerates into its chase. With the bug restored — a constant `ph` —
      // that ramp alone moved the raw number by 0.25 rad and the assertion passed on the defect.
      // Two amplitude-free readings instead:
      //
      //  * sign flips of the pitch. A live clock crosses zero over four seconds of rendering; a
      //    frozen one holds sin(ph) at one value and one sign forever, so 0 flips is the
      //    signature of the bug. The gate is only `>= 1` because llvmpipe renders at ~3 fps and
      //    the stride runs at ~5.9 rad/s: the samples alias badly, and a clean run has measured
      //    as few as 2 flips in 13 pairs. The spread below is the reading with the margin.
      //  * the pitch with `run` divided back out (the pose's own `min(1, speed/3.2)`), which
      //    leaves `sin(ph) * 0.62` — flat to three decimals under the bug, ±0.62 when it works.
      const run = (sp) => Math.min(1, sp / 3.2);
      const norm = walking.map((s) => s.th / Math.max(0.15, run(s.speed)));
      let flips = 0;
      for (let i = 1; i < th.length; i++) if (th[i - 1] * th[i] < 0) flips++;
      const normSpread = +(Math.max(...norm) - Math.min(...norm)).toFixed(4);
      const detail = `thighL over ${walking.length} walking frames: ${flips} sign flip(s),`
        + ` spread ${normSpread} rad with speed divided out (raw ${spread}),`
        + ` speeds ${walking.map((s) => s.speed).join(',')}`;
      check('a hilichurl walking under its own AI swings its legs through the frame loop',
        flips >= 1, detail);
      check('...and the swing is the clock moving, not just the creature speeding up',
        normSpread > 0.2, detail);
    }
  }

  /* ============================================== 2) 换阶段的四个通道 ====== */

  console.log('\n--- 2. a phase change is announced (banner, pips, ticks, sound)');

  const BOSS = 'stormTyrant';   // 3 phases: the only enemy in the game with more than 2
  const bossDef = ENEMIES[BOSS];
  check('the boss under test has phases to change between',
    bossDef?.boss === true && bossDef?.phases >= 3,
    `${BOSS}: boss ${bossDef?.boss}, phases ${bossDef?.phases}`);

  /**
   * Clear the field and put one pinned boss in front of the camera.
   *
   * Pinned because a boss that charges between the rect read and the screenshot takes its own
   * nameplate out of frame, and cleared because §2 finds that plate by the creature's name.
   */
  const spawnBoss = (id, dist) => p.evaluate(([bid, d]) => {
    const g = window.game, inst = g.socket.inst;
    inst.enemies.clear();
    const yaw = g.rig?.yaw ?? 0;
    const ent = inst.spawnEnemy(bid, 40, g.me.x - Math.sin(yaw) * d, g.me.z - Math.cos(yaw) * d);
    if (!ent) return null;
    ent.y = g.me.y; ent.state = 'idle'; ent.ai = null; ent.stunned = 1e9;
    ent.shield = null;   // a shield would eat the damage that is supposed to cross a threshold
    window.__boss = ent.id;
    return { id: ent.id, hp: Math.round(ent.hp), maxHp: Math.round(ent.maxHp), phase: ent.phase };
  }, [id, dist]);

  /**
   * Bring the boss down to an exact hp fraction through the door that steps the phase:
   * `Enemy.takeDamage`, which is what `playerHitEnemy` calls once it has a number.
   *
   * Not through `playerHitEnemy` itself, for these hits: that number runs through crit rng,
   * level scaling and resistances, so "land exactly one side of 2/3" is not something a caller
   * can ask for. The real player path is exercised separately below, on the herald.
   */
  const hitTo = (frac) => p.evaluate((f) => {
    const g = window.game, inst = g.socket.inst;
    const ent = inst.enemies.get(window.__boss);
    if (!ent) return null;
    const pinned = ent.stunned;
    const was = ent.phase;
    ent.takeDamage(ent.hp - ent.maxHp * f, g.playerId, inst.now, 'physical');
    // Read the stagger the announcement promises *before* re-pinning: the phase change is
    // what wrote it, as a plain assignment, so the 1e9 pin is gone iff it fired.
    const stun = +(ent.stunned - inst.now).toFixed(2);
    ent.stunned = pinned;
    return {
      hp: Math.round(ent.hp), frac: +(ent.hp / ent.maxHp).toFixed(3),
      phase: ent.phase, stepped: ent.phase > was, stun,
    };
  }, frac);
  /** Put the dummy back to full hp and phase 1 so another threshold can be crossed. */
  const resetBoss = () => p.evaluate(() => {
    const e = window.game.socket.inst.enemies.get(window.__boss);
    if (!e) return null;
    e.hp = e.maxHp; e.phase = 1; e.alive = true; e.dirty = true;
    return { phase: e.phase };
  });

  const drain = () => p.evaluate(() => {
    const ups = window.__phaseUps, cues = window.__cues;
    window.__phaseUps = []; window.__cues = [];
    return { ups, cues };
  });
  /**
   * Collect what the client announced. Waits for the first announcement, then one more frame,
   * so "exactly once" is a claim about a window that had room for a second one.
   */
  const announcements = async () => {
    let got = { ups: [], cues: [] };
    for (let i = 0; i < 10 && !got.ups.length; i++) {
      const d = await drain();
      got = { ups: [...got.ups, ...d.ups], cues: [...got.cues, ...d.cues] };
      if (!got.ups.length) await frames(1);
    }
    await frames(2);
    const tail = await drain();
    return { ups: [...got.ups, ...tail.ups], cues: [...got.cues, ...tail.cues] };
  };
  /** The boss's own plate, by name, with the three things §2 measures on it. */
  const plateOf = (name) => p.evaluate((nm) => {
    const all = [...document.querySelectorAll('.wlabel')]
      .filter((n) => n.style.display !== 'none' && (n.querySelector('.who')?.textContent || '') === nm);
    if (!all.length) return { found: false, count: 0 };
    const n = all[0];
    const pips = n.querySelector('.pips');
    const bar = n.querySelector('.ebar');
    const tk = n.querySelector('.ebar > i.tk');
    const fill = n.querySelector('.ebar > i:first-child');
    const pr = pips.getBoundingClientRect(), br = bar.getBoundingClientRect();
    return {
      found: true, count: all.length, boss: n.classList.contains('boss'),
      pipText: pips.textContent, pipShown: getComputedStyle(pips).display !== 'none',
      pips: { x: pr.x, y: pr.y, w: pr.width, h: pr.height },
      bar: { x: br.x, y: br.y, w: br.width, h: br.height },
      ticks: tk ? (tk.style.backgroundImage || '') : '',
      fillPct: fill ? fill.style.width : '',
    };
  }, name);
  const bannerNow = () => p.evaluate(() => {
    const el = document.querySelector('.banner');
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return {
      found: true, phase: el.classList.contains('phase'),
      title: el.querySelector('.t')?.textContent || '', sub: el.querySelector('.s')?.textContent || '',
      opacity: +getComputedStyle(el).opacity,
      x: r.x, y: r.y, w: r.width, h: r.height,
    };
  });

  // 暴风之主 stands 9.9 m tall and flies, and a plate is pinned above its creature's head: at
  // *every* distance a player would fight it from, the projected anchor is above the top of the
  // frame (the first run of this file measured y = -120 at 40 m and -160 at 58 m, with the
  // camera at its highest legal pitch). The plate is the only place this game shows a boss's hp,
  // shield element and battle phase, so `label()` now slides a boss plate down to the top edge
  // rather than letting it leave the screen. Both halves of that are gated below.
  const born = await spawnBoss(BOSS, 26);
  if (!check('the boss is in the world', !!born,
    born ? `hp ${born.hp}, phase ${born.phase}` : 'spawn refused')) throw new Error('no boss to test');
  await frames(5);
  await drain();

  // Where the plate would have gone. Called with the *default* top margin — the one every
  // ordinary label still uses — so `null` here means "an ordinary label at this anchor would
  // have been culled outright", which is exactly the case the clamp exists for.
  const anchor = await p.evaluate(() => {
    const g = window.game;
    const e = g.actors.enemies.get(window.__boss);
    if (!e) return null;
    const y = e.y + e.actor.height + 0.42;
    const raw = g.overlay.project(e.x, y, e.z, 160);
    const uncapped = g.overlay.project(e.x, y, e.z, 160, Infinity);
    return {
      raw: raw ? Math.round(raw.y) : null,
      uncapped: uncapped ? Math.round(uncapped.y) : null,
      height: +e.actor.height.toFixed(2), dist: Math.round(uncapped?.dist ?? -1),
    };
  });
  const plate1 = await plateOf(bossDef.name);
  if (!anchor || anchor.uncapped === null) {
    skipped('a boss plate that would leave the top of the frame is held at the edge',
      `no projection at all: ${JSON.stringify(anchor)}`);
  } else if (anchor.raw !== null && anchor.raw >= 46) {
    // Nothing to hold: the assertion has no subject, and calling it green would be the same
    // free pass as exempting the one case it was written for.
    skipped('a boss plate that would leave the top of the frame is held at the edge',
      `the anchor was already in frame at y=${anchor.raw} (${anchor.height} m tall, ${anchor.dist} m away)`);
  } else {
    check('a boss plate that would leave the top of the frame is held at the edge',
      plate1.found && plate1.pips.y >= 0 && plate1.bar.y >= 0 && plate1.bar.y < 60,
      `${anchor.height} m boss at ${anchor.dist} m: anchor projects to y=${anchor.uncapped}`
      + `${anchor.raw === null ? ' (culled at the default margin)' : ''}, plate`
      + `${plate1.found ? ` drawn with its bar at y=${Math.round(plate1.bar.y)}` : ' not drawn'}`);
  }

  if (!plate1.found || !onScreen(plate1.pips) || !onScreen(plate1.bar)) {
    skipped('at full hp the plate says phase 1 of 3',
      `found ${plate1.found}, pips ${JSON.stringify(plate1.pips)}`);
    skipped('and its bar carries a threshold tick for each phase change to come', 'no plate in frame');
  } else {
    check('at full hp the plate says phase 1 of 3',
      plate1.count === 1 && plate1.boss && plate1.pipShown && plate1.pipText === '◆◇◇',
      `"${plate1.pipText}", boss class ${plate1.boss}, ${plate1.count} plate(s) with that name`);
    check('and its bar carries a threshold tick for each phase change to come',
      (plate1.ticks.match(/linear-gradient/g) || []).length === bossDef.phases - 1,
      `${(plate1.ticks.match(/linear-gradient/g) || []).length} tick(s) for ${bossDef.phases} phases`);
  }

  // ---- the control. `wanted = 3 - floor(frac*3)`, so phase 2 begins strictly below 2/3:
  // a hit down to 0.70 is the largest interesting hit that must announce nothing at all.
  const shortOf = await hitTo(0.70);
  await frames(4);
  const q0 = await drain();
  check('a hit that stops short of the threshold announces nothing',
    shortOf.phase === 1 && !shortOf.stepped && q0.ups.length === 0
    && !q0.cues.some((c) => c.name === 'bossPhase'),
    `frac ${shortOf.frac} → phase ${shortOf.phase}, ${q0.ups.length} announcement(s),`
    + ` ${q0.cues.filter((c) => c.name === 'bossPhase').length} cue(s)`);
  const platePre = await plateOf(bossDef.name);
  check('...and the plate still shows one filled lozenge',
    platePre.pipText === '◆◇◇', `"${platePre.pipText}" at frac ${shortOf.frac}`);
  check('...while the bar it is drawn on did move',
    parseFloat(platePre.fillPct) > 65 && parseFloat(platePre.fillPct) < 75,
    `fill ${platePre.fillPct} at hp frac ${shortOf.frac}`);

  // A clean before-frame for the banner rect, taken with the canvas already hidden so that
  // the crossing below needs no setup at all inside the banner's opaque window.
  await hideCanvas(true);
  await frames(2);
  const before = await shot('no-banner');

  // ---- cross into phase 2.
  const cross = await hitTo(0.60);
  check('the simulation moved the boss into phase 2',
    cross.phase === 2 && cross.stepped, `hp frac ${cross.frac} → phase ${cross.phase}`);
  // `bannerIn` runs for 3.4 s and is only fully opaque between 14% and 78% of it — about 0.5 s
  // to 2.6 s after the change. A `frames(2)` wait plus a 1600×900 llvmpipe screenshot spent
  // most of that window and the first run of this file photographed the banner at opacity 0.52.
  // So poll for the opaque window instead of assuming it, and shoot the moment it opens.
  let bn = { found: false, opacity: 0 };
  for (let i = 0; i < 80; i++) {
    bn = await bannerNow();
    if (bn.found && bn.opacity > 0.98) break;
    await sleep(50);
  }
  const withBanner = await shot('banner');
  const q1 = await announcements();
  const phaseCues = q1.cues.filter((c) => c.name === 'bossPhase');

  check('the client announced it exactly once',
    q1.ups.length === 1 && q1.ups[0].phase === 2 && q1.ups[0].phases === 3
    && q1.ups[0].name === bossDef.name,
    `${q1.ups.length} announcement(s): ${JSON.stringify(q1.ups.map((u) => [u.name, u.phase, u.phases]))}`);
  check('the sound was asked for exactly once, positioned in the world',
    phaseCues.length === 1 && Array.isArray(phaseCues[0]?.opts?.at),
    `${phaseCues.length} bossPhase cue(s), at ${JSON.stringify(phaseCues[0]?.opts?.at)}`);
  const bossPos = await p.evaluate(() => {
    const e = window.game.socket.inst.enemies.get(window.__boss);
    return e ? [+e.x.toFixed(1), +e.z.toFixed(1)] : null;
  });
  if (!phaseCues[0]?.opts?.at || !bossPos) {
    skipped('...at the boss rather than at the camera', 'no positioned cue to check');
  } else {
    const [ax, , az] = phaseCues[0].opts.at;
    const d = Math.hypot(ax - bossPos[0], az - bossPos[1]);
    check('...at the boss rather than at the camera',
      d < 3, `cue ${ax.toFixed(1)},${az.toFixed(1)} vs boss ${bossPos.join(',')} — ${d.toFixed(1)} m apart`);
  }
  check('the stagger the banner promises is really applied',
    Math.abs(cross.stun - 1.2) < 0.25, `stunned for ${cross.stun}s after the change`);

  // ---- the banner, in pixels.
  if (!bn.found) {
    check('a banner is on screen for the phase change', false, 'no .banner element');
    skipped('and it is painted, not just present in the DOM', 'no banner element to measure');
  } else {
    check('a banner is on screen for the phase change',
      bn.phase && bn.title === bossDef.name && /第 2 \/ 3 阶段/.test(bn.sub),
      `"${bn.title}" / "${bn.sub}", phase class ${bn.phase}`);
    const r = inset(bn, 'banner');
    if (!onScreen(r) || bn.opacity < 0.95) {
      // Not a pass and not a failure: the screenshot landed outside the animation's opaque
      // window, so there is nothing to measure. At 3 fps that is a real possibility, and
      // calling the rect dark would be a lie in the other direction.
      skipped('and it is painted, not just present in the DOM',
        `opacity ${bn.opacity} when read, rect ${JSON.stringify(r)}`);
    } else {
      const lit = rectStats(withBanner.img, r);
      const dark = rectStats(before.img, r);
      const moved = pixelsDiffering(withBanner.img, before.img, 12);
      console.log(`  banner rect lum ${lit.lum} vs ${dark.lum} before · p95 ${lit.p95}/${dark.p95}`
        + ` · ${moved} px differ in the frame`);
      // Both directions: the same rect is brighter with the banner in it than without, and
      // the glyph strokes are bright enough to read rather than a faint wash.
      check('and it is painted, not just present in the DOM',
        lit.lum > dark.lum + 5 && lit.p95 > dark.p95 + 24,
        `lum ${dark.lum} → ${lit.lum}, p95 ${dark.p95} → ${lit.p95}`);
    }
  }

  // ---- the plate, in pixels: the pips changed, and they are actually drawn.
  const plate2 = await plateOf(bossDef.name);
  check('the plate now shows two filled lozenges of three',
    plate2.pipText === '◆◆◇' && plate2.pipShown, `"${plate2.pipText}", shown ${plate2.pipShown}`);
  if (!onScreen(plate2.pips) || plate2.pips.w < 10) {
    skipped('the pips are drawn on screen', `rect ${JSON.stringify(plate2.pips)}`);
    skipped('...in the phase colour rather than the hp bar\'s red', 'no pip rect');
  } else {
    await frames(2);
    const withPips = await shot('plate-phase2');
    const pr = inset(plate2.pips, 'pips');
    const lit = rectStats(withPips.img, pr);
    // Hide the pips and re-read the *same* rect: what is left is whatever the plate draws
    // behind them, which is the only honest control for "is this glyph on the screen".
    await p.evaluate(() => { for (const n of document.querySelectorAll('.wlabel .pips')) n.style.visibility = 'hidden'; });
    await frames(2);
    const withoutPips = await shot('plate-nopips');
    const bare = rectStats(withoutPips.img, pr);
    await p.evaluate(() => { for (const n of document.querySelectorAll('.wlabel .pips')) n.style.visibility = ''; });
    console.log(`  pips rect rgb ${JSON.stringify(lit.rgb)} lum ${lit.lum} p95 ${lit.p95}`
      + ` · hidden rgb ${JSON.stringify(bare.rgb)} lum ${bare.lum} p95 ${bare.p95}`);
    check('the pips are drawn on screen',
      lit.lum > bare.lum + 3 && lit.p95 > bare.p95 + 18,
      `lum ${bare.lum} → ${lit.lum}, p95 ${bare.p95} → ${lit.p95}`);
    // Warm gold (#ffcf7a), not the bar's red and not the plate's grey: a phase read that
    // looks like hp is not a phase read.
    check('...in the phase colour rather than the hp bar\'s red',
      lit.rgb[0] >= lit.rgb[1] && lit.rgb[1] > lit.rgb[2] + 4, `rgb ${JSON.stringify(lit.rgb)}`);
  }

  // ---- the threshold ticks, in pixels: bright columns at 1/3 and 2/3 of the bar, drawn over
  // the hp fill, with the fill itself still red between them.
  if (!onScreen(plate2.bar) || plate2.bar.w < 40) {
    skipped('the phase thresholds are marked on the bar', `bar ${JSON.stringify(plate2.bar)}`);
    skipped('...and the bar between them is still the hp fill', 'no bar rect');
  } else {
    await frames(2);
    const barShot = await shot('bar-ticks');
    const col = (frac, label) => ({
      x: Math.round(plate2.bar.x + plate2.bar.w * frac) - 1, y: Math.round(plate2.bar.y) + 1,
      w: 3, h: Math.max(2, Math.round(plate2.bar.h) - 2), label,
    });
    const t1 = rectStats(barShot.img, col(1 / 3, 'tick 1/3'));
    const t2 = rectStats(barShot.img, col(2 / 3, 'tick 2/3'));
    const mid = rectStats(barShot.img, col(0.5, 'fill 1/2'));
    console.log(`  bar 1/3 ${JSON.stringify(t1.rgb)} · 2/3 ${JSON.stringify(t2.rgb)}`
      + ` · half ${JSON.stringify(mid.rgb)} (bar ${Math.round(plate2.bar.w)}×${Math.round(plate2.bar.h)}px)`);
    // The tick is rgba(255,232,196) and the fill is a red gradient, so blue is the channel
    // that cannot be confused. The column between the two ticks is the control.
    check('the phase thresholds are marked on the bar',
      t1.rgb[2] > mid.rgb[2] + 20 && t2.rgb[2] > mid.rgb[2] + 20,
      `blue at 1/3 ${t1.rgb[2]}, at 2/3 ${t2.rgb[2]}, between them ${mid.rgb[2]}`);
    check('...and the bar between them is still the hp fill',
      mid.rgb[0] > mid.rgb[2] + 20, `rgb ${JSON.stringify(mid.rgb)} halfway along the bar`);
  }
  await hideCanvas(false);

  // ---- one hit past two thresholds at once is still one announcement, and it names the
  // phase actually reached rather than walking up through the ones it skipped.
  await resetBoss();
  await frames(3);
  await drain();
  const jump = await hitTo(0.20);
  const q2 = await announcements();
  const jumpCues = q2.cues.filter((c) => c.name === 'bossPhase');
  check('a hit past both thresholds announces phase 3 once, not twice',
    jump.phase === 3 && q2.ups.length === 1 && q2.ups[0].phase === 3 && jumpCues.length === 1,
    `frac ${jump.frac} → phase ${jump.phase}, ${q2.ups.length} announcement(s), ${jumpCues.length} cue(s)`);
  const plate3 = await plateOf(bossDef.name);
  check('...and the plate fills all three lozenges',
    plate3.pipText === '◆◆◆', `"${plate3.pipText}"`);

  // ---- the real player path reaches the same door. Everything above drove `takeDamage`
  // directly in order to land on an exact hp fraction; this one goes through the route an
  // actual attack takes, on the two-phase boss, with enough damage that no roll can miss.
  //
  // Spawning and hitting have to be two separate round trips with rendered frames between
  // them: an actor is created with `phase: nb.ph || 1`, so a creature that streams in *already*
  // in phase 2 announces nothing — which is right (a camp 110 m away changing phase before you
  // ever saw it is not an event) and which silently swallowed this assertion when the spawn and
  // the hits shared one evaluate.
  const heraldBorn = await p.evaluate(() => {
    const g = window.game, inst = g.socket.inst;
    inst.enemies.clear();
    const yaw = g.rig?.yaw ?? 0;
    const ent = inst.spawnEnemy('abyssHerald', 40, g.me.x - Math.sin(yaw) * 18, g.me.z - Math.cos(yaw) * 18);
    if (!ent) return null;
    ent.y = g.me.y; ent.state = 'idle'; ent.ai = null; ent.stunned = 0; ent.shield = null;
    window.__herald = ent.id;
    return { id: ent.id, phases: ent.def.phases };
  });
  await frames(5);
  const seenAtOne = await p.evaluate(() => {
    const e = window.game.actors.enemies.get(window.__herald);
    return e ? e.phase : null;
  });
  check('the client saw the herald at phase 1 before it was hit',
    !!heraldBorn && seenAtOne === 1,
    `spawned ${heraldBorn ? `with ${heraldBorn.phases} phases` : 'nothing'}, client-side phase ${seenAtOne}`);
  await drain();
  const viaPlayer = await p.evaluate(() => {
    const g = window.game, inst = g.socket.inst;
    const ent = inst.enemies.get(window.__herald);
    const me = inst.players.get(g.playerId) || [...inst.players.values()][0];
    if (!ent || !me) return null;
    // Repeated hits rather than one big one. `flatDamage` is not damage: it goes through crit
    // rng, level scaling and the target's resistance, and 45% of max hp arrived as 14% — so a
    // single hit sized to land just under 1/2 either misses the threshold or kills outright,
    // depending on a die roll. Small hits until the threshold is crossed cross it exactly once.
    let hits = 0, killed = false;
    while (ent.phase < 2 && ent.alive && hits < 12) {
      hits++;
      const res = inst.playerHitEnemy(me, ent, {
        flatDamage: ent.maxHp * 0.25, element: 'physical', gauge: 0, kind: 'normal', charId: me.charId,
      });
      killed = killed || !!res?.killed;
    }
    return {
      phase: ent.phase, frac: +(ent.hp / ent.maxHp).toFixed(3), hits, killed,
      stun: +(ent.stunned - inst.now).toFixed(2),
      phases: ent.def.phases, name: ent.def.name,
    };
  });
  if (!viaPlayer || viaPlayer.killed || viaPlayer.phase !== 2) {
    // A hit that either missed the threshold or overshot into a corpse proves nothing about
    // the announcement, and 45% of max hp through crit rng and level scaling can do both.
    skipped('a real player hit crosses the threshold the same way',
      viaPlayer ? `killed ${viaPlayer.killed}, frac ${viaPlayer.frac}, phase ${viaPlayer.phase}`
        + ` after ${viaPlayer.hits} hit(s)` : 'spawn refused');
    skipped('...and a two-phase boss reports two, not the tyrant\'s three', 'no phase change to read');
  } else {
    const q3 = await announcements();
    check('a real player hit crosses the threshold the same way',
      q3.ups.length === 1 && q3.ups[0].phase === 2,
      `${viaPlayer.name} at frac ${viaPlayer.frac} → phase ${viaPlayer.phase} after`
      + ` ${viaPlayer.hits} hit(s), ${q3.ups.length} announcement(s), stunned ${viaPlayer.stun}s`);
    check('...and a two-phase boss reports two, not the tyrant\'s three',
      q3.ups[0]?.phases === viaPlayer.phases && viaPlayer.phases === 2,
      `phases reported ${q3.ups[0]?.phases}, authored ${viaPlayer.phases}`);
  }

  // ---- the control that costs nothing to get wrong: an ordinary enemy has no phase read.
  const dull = await p.evaluate(() => {
    const g = window.game, inst = g.socket.inst;
    inst.enemies.clear();
    const yaw = g.rig?.yaw ?? 0;
    const ent = inst.spawnEnemy('hilichurl', 20, g.me.x - Math.sin(yaw) * 11, g.me.z - Math.cos(yaw) * 11);
    if (!ent) return null;
    ent.y = g.me.y; ent.state = 'idle'; ent.ai = null; ent.stunned = 1e9;
    window.__dull = ent.id;
    return { id: ent.id, maxHp: Math.round(ent.maxHp), phases: ent.def.phases || 1 };
  });
  if (!dull) {
    skipped('an ordinary enemy has no phase to announce', 'hilichurl spawn refused');
    skipped('...and its plate draws no lozenges and no ticks', 'no hilichurl');
  } else {
    await frames(4);
    await drain();
    const hit = await p.evaluate(() => {
      const g = window.game, inst = g.socket.inst;
      const ent = inst.enemies.get(window.__dull);
      if (!ent) return null;
      const pinned = ent.stunned;
      ent.takeDamage(ent.maxHp * 0.6, g.playerId, inst.now, 'physical');
      ent.stunned = pinned;
      return { frac: +(ent.hp / ent.maxHp).toFixed(2), phase: ent.phase };
    });
    await frames(4);
    const q4 = await drain();
    const dullPlate = await plateOf(ENEMIES.hilichurl.name);
    check('an ordinary enemy has no phase to announce',
      hit?.phase === 1 && q4.ups.length === 0 && !q4.cues.some((c) => c.name === 'bossPhase'),
      `frac ${hit?.frac}, phase ${hit?.phase}, ${q4.ups.length} announcement(s)`);
    check('...and its plate draws no lozenges and no ticks',
      dullPlate.found && !dullPlate.pipShown && dullPlate.pipText === '' && dullPlate.ticks === '',
      `found ${dullPlate.found}, pips "${dullPlate.pipText}" shown ${dullPlate.pipShown},`
      + ` ticks "${dullPlate.ticks.slice(0, 20)}"`);

    // The other half of the top-edge clamp: it is for bosses only, and the way to put an
    // *ordinary* enemy's anchor above the frame is not to make it taller — the tallest non-boss
    // in the game is a 3.6 m ruin guard, and the simulation drops a levitated creature back onto
    // the terrain within a tick — it is to look down. Pitching the camera towards top-down (a
    // real mouse input, clamped by the camera at 1.16 rad) sends everything at eye level up and
    // off the top, and then one frame shows both halves at once: the hilichurl's plate has to go
    // with it, and the tyrant's has to stay.
    const pitched = await p.evaluate(() => {
      const g = window.game, inst = g.socket.inst;
      const yaw = g.rig?.yaw ?? 0;
      const boss = inst.spawnEnemy('stormTyrant', 40, g.me.x - Math.sin(yaw) * 30, g.me.z - Math.cos(yaw) * 30);
      if (boss) { boss.y = g.me.y; boss.state = 'idle'; boss.ai = null; boss.stunned = 1e9; window.__boss = boss.id; }
      g.rig.orbit(0, 900);   // dy × sens = +2.88 rad, clamped by the camera to MAX_PITCH
      return { pitch: +g.rig.pitch.toFixed(3), boss: !!boss };
    });
    await frames(6);
    const overhead = await p.evaluate(() => {
      const g = window.game;
      const read = (id, maxDist) => {
        const e = g.actors.enemies.get(id);
        if (!e) return null;
        const y = e.y + e.actor.height + 0.42;
        const raw = g.overlay.project(e.x, y, e.z, maxDist);
        const uncapped = g.overlay.project(e.x, y, e.z, maxDist, Infinity);
        return {
          raw: raw ? Math.round(raw.y) : null,
          uncapped: uncapped ? Math.round(uncapped.y) : null,
          height: +e.actor.height.toFixed(2), dist: Math.round(uncapped?.dist ?? -1),
        };
      };
      return { dull: read(window.__dull, 95), boss: read(window.__boss, 160) };
    });
    const dullHigh = await plateOf(ENEMIES.hilichurl.name);
    const bossHigh = await plateOf(bossDef.name);
    console.log(`  pitch ${pitched.pitch} rad · hilichurl ${JSON.stringify(overhead.dull)}`
      + ` · tyrant ${JSON.stringify(overhead.boss)}`);
    const od = overhead.dull;
    if (!od || od.uncapped === null || od.uncapped >= 46) {
      skipped('...and an ordinary enemy whose plate leaves the frame is not held at the edge',
        `anchor ${JSON.stringify(od)} at pitch ${pitched.pitch} — it never left the frame`);
    } else {
      check('...and an ordinary enemy whose plate leaves the frame is not held at the edge',
        !dullHigh.found || dullHigh.bar.y < 0,
        `${od.height} m non-boss at ${od.dist} m: anchor projects to y=${od.uncapped}, plate`
        + `${dullHigh.found ? ` drawn at y=${Math.round(dullHigh.bar.y)}` : ' not drawn'}`);
    }
    const ob = overhead.boss;
    if (!ob || ob.uncapped === null || (ob.raw !== null && ob.raw >= 46)) {
      skipped('...while the boss beside it keeps its plate at the top edge',
        `anchor ${JSON.stringify(ob)} at pitch ${pitched.pitch}`);
    } else {
      check('...while the boss beside it keeps its plate at the top edge',
        bossHigh.found && bossHigh.bar.y >= 0 && bossHigh.bar.y < 60,
        `anchor projects to y=${ob.uncapped}, plate`
        + `${bossHigh.found ? ` drawn at y=${Math.round(bossHigh.bar.y)}` : ' not drawn'}`);
    }
  }

  /* --------------------------------------------------------- 3) 两端都在 --- */

  console.log('\n--- 3. both ends of the wire still exist');
  const entitySrc = readFileSync(new URL('../shared/src/world/entity.js', import.meta.url), 'utf8');
  check('the simulation still ships the phase in its snapshot',
    /ph:\s*this\.phase/.test(entitySrc), 'entity.js serialize() → ph');
  check('the simulation still steps it at the hp thresholds',
    /wanted\s*>\s*this\.phase/.test(entitySrc) && /this\.stunned\s*=\s*now\s*\+\s*1\.2/.test(entitySrc),
    'entity.js takeDamage() → phase + 1.2 s stagger');
  const gameSrc = src('game/game.js');
  check('and the client has a consumer for every channel',
    /takePhaseUps\(\)/.test(gameSrc) && /_onBossPhase/.test(gameSrc)
    && /sfx\('bossPhase'/.test(gameSrc) && /emit\('bossPhase'/.test(gameSrc),
    'game.js drains ActorSystem.phaseUps → banner + world note + vfx + sfx');
} catch (e) {
  fail++;
  console.log(`  FAIL harness — ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`);
} finally {
  console.log('\nerrors ->', errors.length ? JSON.stringify([...new Set(errors)].slice(0, 6)) : 'none');
  console.log(`shots  -> ${step} in ${outDir}`);
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  await b.close();
  // A green run has to have counted something: a `check` left inside a branch that never ran
  // once let a whole section vanish from this suite while the tally still said "0 failed".
  if (pass + fail + skip < 30) {
    console.log(`only ${pass + fail + skip} assertions reached — expected at least 30`);
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
}
