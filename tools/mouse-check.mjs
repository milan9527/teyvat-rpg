// 鼠标操作探针: the whole pointer scheme, driven the way a player drives it.
//
//   xvfb-run -a node tools/mouse-check.mjs [baseUrl] [outDir]
//   DISPLAY=:99 node tools/mouse-check.mjs
//
// Why this probe exists. 「支持鼠标点击」 is one of the headline promises of this game, and
// `client/src/game/input.js` is the file that keeps it: a press is classified *on release*
// into a click, a drag or a hold, and `game.js:_leftClick` turns a click into one of four
// different orders depending on what the ray hit. None of that had a gate. Grepping the 41
// probes for `mouse.down`/`mouse.click` found four call sites in total, all of them a single
// convenience click on a DOM button — so every rule in the scheme (the 320 ms boundary, the
// 5 px drag threshold, "only the right button orbits", the branch order in `_leftClick`, the
// wheel, the modal gate) was held up by nothing but the source reading correctly.
//
// The shape of the probe follows the two lessons this repo keeps relearning:
//
//  * **Drive the product's input path.** Everything below goes through `page.mouse` on the
//    canvas, so a build where `pointerdown` is bound to the wrong element, or where a modal
//    leaves `input.enabled` false, fails here. A probe that called `me.setGoal()` or
//    `game.setTarget()` directly would pass on all of those.
//  * **Bound every rule from both sides.** "A hold does not walk" is worthless without "a
//    click does"; "a right drag orbits" is worthless without "a left drag does not". Each
//    rule below is therefore a pair, driven with the same helper, differing only in the one
//    thing under test.
//
// Wall clock vs frames — both appear here, and they are not interchangeable:
//   · the click/hold classification is `performance.now()` in `input.js`, so the *press
//     duration* is a real sleep;
//   · the charge meter is `this._leftHold += dt` in `game.js`, and `dt` is clamped to 50 ms,
//     so a *charge* is counted in rendered frames — at llvmpipe's ~3 fps a 600 ms wall-clock
//     hold advances the charge by 100 ms and no charged attack ever fires.
// Sleeping where frames are meant, or waiting frames where the wall clock is meant, is the
// failure mode of the last four probes in this directory; see the notes on `press()`.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';
import { MOUSE_CONTROLS } from '../client/src/game/input.js';
// `currentAction()` returns the wire enum, not a clip name — the pose assertion below compares
// against these, imported rather than typed, because that is what other clients receive.
import { ACTION, ACTION_NAMES } from '../shared/src/protocol.js';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/mouse-check';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const px = (v) => Math.min(W - 2, Math.max(2, Math.round(v)));
const py = (v) => Math.min(H - 2, Math.max(2, Math.round(v)));

let pass = 0, fail = 0, skip = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function skipped(name, why) { skip++; console.log(`  SKIP ${name} — ${why}`); }

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const code = {
  input: read('client/src/game/input.js'),
  game: read('client/src/game/game.js'),
  local: read('client/src/game/localPlayer.js'),
  panels: read('client/src/ui/panels.js'),
  css: read('client/src/ui/style.css'),
};
/** Source with comments removed: a rule must be *implemented*, not described. */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const bodyOf = (src, head) => {
  const i = src.indexOf(head);
  if (i < 0) return '';
  let depth = 0, j = i + head.length - 1;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(i, j + 1);
};

/* ==================================================================================
 * 1. the gesture table and the code behind it
 * ================================================================================== */

console.log('=== the gestures this probe drives, against the table the game prints');

/**
 * Every gesture driven below, and the row of `MOUSE_CONTROLS` it belongs to.
 *
 * `MOUSE_CONTROLS` is what the 操作说明 panel shows the player, so it is the closest thing
 * the game has to a specification of the mouse. Gating it against this list in both
 * directions is what stops the two from drifting: a promise added to the panel with nobody
 * driving it fails here, and a gesture driven here that the panel never mentions fails too.
 * `rule: true` marks the negative rules of the scheme — a hold is not a click, a left drag
 * does not orbit, a modal swallows the world — which are not player-facing rows.
 */
const GESTURES = [
  { id: 'clickGround', row: (r) => r.keys[0].includes('点地面') },
  { id: 'doubleGround', row: (r) => r.what.includes('双击') },
  { id: 'clickEnemy', row: (r) => r.keys[0].includes('点敌人') },
  { id: 'holdCharge', row: (r) => r.keys[0].includes('按住左键') },
  { id: 'clickInteractable', row: (r) => r.keys[0].includes('宝箱') },
  { id: 'rightDrag', row: (r) => r.keys[0].includes('按住右键') },
  { id: 'middleDrag', row: (r) => r.what.includes('中键') },
  { id: 'rightClick', row: (r) => r.keys[0].includes('右键单击') },
  { id: 'wheel', row: (r) => r.keys[0].includes('滚轮') },
  { id: 'hudClick', row: (r) => r.keys[0].includes('头像') },
  { id: 'holdIsNotClick', rule: true },
  { id: 'leftDragDoesNotOrbit', rule: true },
  { id: 'modalSwallowsTheWorld', rule: true },
];
const rows = GESTURES.filter((g) => g.row);
check('every gesture this probe drives is a row the game promises the player',
  rows.every((g) => MOUSE_CONTROLS.some(g.row)),
  rows.filter((g) => !MOUSE_CONTROLS.some(g.row)).map((g) => g.id).join(' ') || `${rows.length} gestures`);
const claimed = MOUSE_CONTROLS.filter((r) => rows.some((g) => g.row(r)));
check('...and every row the game promises is driven by one of them',
  claimed.length === MOUSE_CONTROLS.length,
  MOUSE_CONTROLS.filter((r) => !rows.some((g) => g.row(r))).map((r) => r.keys[0]).join(' ')
  || `${MOUSE_CONTROLS.length} rows all covered`);

// The three numbers that decide what a press *was*. They are module-private in input.js, so
// they are parsed out rather than imported — and the browser half below drives the boundaries
// using these values, so the probe cannot describe a threshold the product does not have.
const num = (name) => {
  const m = strip(code.input).match(new RegExp(`const ${name} = (\\d+)`));
  return m ? Number(m[1]) : NaN;
};
const DRAG_THRESHOLD = num('DRAG_THRESHOLD'), CLICK_MAX_MS = num('CLICK_MAX_MS'), DBL_MS = num('DBL_MS');
check('the classification constants were found, so the boundary tests below are the real ones',
  DRAG_THRESHOLD > 0 && CLICK_MAX_MS > 0 && DBL_MS > 0,
  `drag ${DRAG_THRESHOLD}px, click ≤${CLICK_MAX_MS}ms, double <${DBL_MS}ms`);
check('...and they leave room for a human hand', DRAG_THRESHOLD <= 12 && CLICK_MAX_MS >= 200 && CLICK_MAX_MS <= 500
  && DBL_MS >= 200 && DBL_MS <= 400, `${DRAG_THRESHOLD}/${CLICK_MAX_MS}/${DBL_MS}`);

const inputSrc = strip(code.input);
const upBody = bodyOf(inputSrc, "this._on(window, 'pointerup'");
const downBody = bodyOf(inputSrc, "this._on(this.canvas, 'pointerdown'");
check('a click is decided on release, not on press',
  upBody.includes('this.clicks.push') && !downBody.includes('this.clicks.push'),
  'clicks.push lives in pointerup');
check('...and a press that dragged or was held is not a click',
  /p\.dragged \|\| heldMs > CLICK_MAX_MS/.test(upBody), 'the early return in pointerup');
const moveBody = bodyOf(inputSrc, "this._on(window, 'pointermove'");
check('only the right and middle buttons orbit the camera',
  /btn === 2 \|\| btn === 1/.test(moveBody) && !/btn === 0/.test(moveBody),
  'pointermove accumulates dragX for buttons 2 and 1');
check('the wheel listener can actually stop the page scrolling',
  /passive: false/.test(inputSrc) && /preventDefault/.test(bodyOf(inputSrc, "this._on(this.canvas, 'wheel'")),
  'wheel is { passive: false } and preventDefaults');
check('losing the window drops every held button and press',
  /blur/.test(inputSrc) && /this\.buttons\.clear\(\)/.test(bodyOf(inputSrc, "this._on(window, 'blur'")),
  'blur clears buttons and _press');
const enabledBody = bodyOf(inputSrc, 'setEnabled(v) {');
check('suppressing world input drops the queued clicks as well as the buttons',
  /this\.buttons\.clear\(\)/.test(enabledBody) && /this\.clicks\.length = 0/.test(enabledBody),
  'setEnabled(false) clears buttons, presses and clicks');
check('...and it has a named caller: opening a panel pauses the world',
  /this\.input\.setEnabled\(!v\)/.test(strip(code.game)) && /setPaused\(true\)/.test(strip(code.panels)),
  'game.setPaused → input.setEnabled, called by panels.open');

// The branch order in `_leftClick` is the whole priority scheme: an enemy under the cursor
// beats a body, which beats a chest, which beats open ground. Asserted by source position so
// a refactor that reorders them shows up here rather than as "clicks on enemies walk past them".
const leftClick = strip(bodyOf(code.game, '_leftClick(c) {'));
const at = (needle) => leftClick.indexOf(needle);
const order = [at('pickEnemy'), at('pickPlayer'), at('pickInteractable'), at('nearestInteractable'),
  at('setGoal(g.x, g.z, \'move\'')];
check('a left click tries enemy → downed teammate → the thing under the cursor → the thing beside the'
  + ' clicked ground → open ground, in that order',
  order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]),
  order.join(' < '));
check('every one of those branches gives the player a click ring',
  (leftClick.match(/clickRing\(/g) || []).length === order.length,
  `${(leftClick.match(/clickRing\(/g) || []).length} rings for ${order.length} branches`);
check('...and only the open-ground branch pings the party',
  (leftClick.match(/socket\.mark\(/g) || []).length === 1 && at('socket.mark(') > order[3],
  'one mark(), in the ground branch');

// Sprinting is one rule with two triggers, not two rules. The whole point of deriving the
// mouse sprint from the same `sprintHeld` the keyboard sets is that the drain, the stamina
// lockout, the speed cap, the pose and the regen block cannot disagree between the two ways
// of asking for it — this repo has shipped a "weak point" multiplier twice for exactly that
// reason. So: exactly one definition, and no other reader of the raw key.
const localSrc = strip(code.local);
const sprintDefs = (localSrc.match(/const sprintHeld = /g) || []).length;
const rawKeyReads = (localSrc.match(/isDown\('sprint'\)/g) || []).length;
check('sprinting is defined once', sprintDefs === 1, `${sprintDefs} definition(s) of sprintHeld`);
check('...and nothing else reads the sprint key behind its back', rawKeyReads === 1,
  `${rawKeyReads} isDown('sprint') — the one inside the definition`);
check('...and the definition covers the mouse as well as the key',
  /const sprintHeld = [^;]*goalSprint/.test(localSrc), 'sprintHeld includes the click order');
check('the speed cap and the stamina regen block read the same flag',
  /sprintHeld && wish > 0\.4/.test(localSrc) && /regenBlocked = \(sprintHeld/.test(localSrc),
  'one flag, both consumers');
check('a click order that sprints is cleared with the order itself',
  /goalSprint = false/.test(bodyOf(localSrc, 'clearGoal() {')), 'clearGoal resets goalSprint');
check('the click ring has styling that can show it', /\.click-ring/.test(code.css), '.click-ring in style.css');

/* ==================================================================================
 * 2. the same scheme, driven in a running game
 * ================================================================================== */

console.log('\n=== driving the pointer in a live 单机 session');

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
const errors = [], hmr = [];
p.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push(t);
  if (/hmr|hot updated/i.test(t)) hmr.push(t);
});
p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

let step = 0;
async function shot(name) {
  step++;
  await p.screenshot({ path: `${outDir}/${String(step).padStart(2, '0')}-${name}.png` });
}
/** Wait for `n` rendered frames. Never sleep for a frame: llvmpipe runs this scene at ~3 fps. */
async function frames(n = 3) {
  const from = await p.evaluate(() => window.__mpFrames || 0);
  for (let i = 0; i < 500; i++) {
    const now = await p.evaluate(() => window.__mpFrames || 0);
    if (now - from >= n) return now - from;
    await sleep(100);
  }
  return -1;
}
const state = () => p.evaluate(() => {
  const g = window.game;
  return {
    x: g.me.x, z: g.me.z, speed: g.me.speed, stamina: g.me.stamina,
    goal: g.me.goal ? { x: g.me.goal.x, z: g.me.goal.z } : null,
    goalKind: g.me.goalKind, goalSprint: !!g.me.goalSprint, goalPayload: g.me.goalPayload?.id || g.me.goalPayload?.type || null,
    target: g.me.target, autoAttack: !!g.autoAttack, enabled: g.input.enabled,
    yaw: g.rig.yaw, dist: g.rig.dist, paused: !!g._paused, charId: g.me.charId,
    panel: window.ui?.panels?.isOpen ? (window.ui.panels.name || 'open') : null,
    rings: document.querySelectorAll('.click-ring').length,
  };
});
/** Where a world point lands on screen, through the same camera the click ray uses. */
const toScreen = (x, y, z) => p.evaluate(([wx, wy, wz]) => {
  const g = window.game;
  const v = g.camera.position.clone().set(wx, wy, wz).project(g.camera);
  const r = document.querySelector('canvas').getBoundingClientRect();
  return {
    x: r.left + (v.x * 0.5 + 0.5) * r.width,
    y: r.top + (-v.y * 0.5 + 0.5) * r.height,
    onScreen: Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95 && v.z < 1,
  };
}, [x, y, z]);
/** What the player would actually hit at this screen point. A click that lands on the HUD is not a world click. */
const elementAt = (x, y) => p.evaluate(([cx, cy]) => {
  const el = document.elementFromPoint(cx, cy);
  return el ? (el.tagName.toLowerCase() + (el.className ? `.${String(el.className).split(' ')[0]}` : '')) : null;
}, [Math.round(x), Math.round(y)]);

/**
 * A press: move, hold the button for `ms` of *wall clock* (the classifier's own clock) or for
 * `holdFrames` rendered frames (the charge meter's clock), then release.
 */
async function press(x, y, { ms = 90, holdFrames = 0, button = 'left', drag = 0, clickCount } = {}) {
  // Clamped into the viewport: a point outside it makes puppeteer throw
  // `MoveTargetOutOfBounds`, which aborts the whole run instead of failing one assertion.
  x = px(x); y = py(y);
  await p.mouse.move(Math.round(x), Math.round(y));
  await p.mouse.down({ button, ...(clickCount ? { clickCount } : {}) });
  if (drag) {
    for (let i = 1; i <= 8; i++) await p.mouse.move(px(x + (drag * i) / 8), Math.round(y));
  }
  if (holdFrames) await frames(holdFrames);
  else await sleep(ms);
  await p.mouse.up({ button, ...(clickCount ? { clickCount } : {}) });
  await frames(2);
}
/**
 * Two presses inside the double-click window.
 *
 * Both presses are driven back to back with nothing between them but the gap: the first version
 * called `press()`, which waits two rendered frames after the release — ~600 ms at llvmpipe's
 * 3 fps — so the second press landed outside the 280 ms `DBL_MS` window, `double` was false and
 * the probe reported that the product never pings. `DBL_MS` is measured on `performance.now()`,
 * so real sleeps are the right unit here; only the frame waits go afterwards.
 */
async function doublePress(x, y) {
  x = px(x); y = py(y);
  const gap = Math.max(30, Math.round(DBL_MS * 0.25));
  await p.mouse.move(Math.round(x), Math.round(y));
  await p.mouse.down({ button: 'left' });
  await sleep(50);
  await p.mouse.up({ button: 'left' });
  await sleep(gap);
  await p.mouse.down({ button: 'left', clickCount: 2 });
  await sleep(50);
  await p.mouse.up({ button: 'left', clickCount: 2 });
  await frames(2);
}
/** Drag `dx` px with a button held, in steps big enough to pass the drag threshold on the first move. */
async function dragBy(x, y, dx, button) {
  x = px(x); y = py(y);
  await p.mouse.move(Math.round(x), Math.round(y));
  await p.mouse.down({ button });
  for (let i = 1; i <= 12; i++) await p.mouse.move(px(x + (dx * i) / 12), Math.round(y));
  await p.mouse.up({ button });
  await frames(3);
}
/** Start recording per-frame extremes in the page (speed, stamina, poses) and read them back. */
const recStart = () => p.evaluate(() => {
  const g = window.game;
  window.__mpRec = { maxSpeed: 0, minStamina: g.me.stamina, startStamina: g.me.stamina, actions: [] };
});
const recRead = () => p.evaluate(() => window.__mpRec);

/**
 * The screen point that means "that patch of ground, `dist` metres from here".
 *
 * The first version of this probe clicked a fixed 62 % / 70 % of the frame and every distance
 * assertion under it was junk: the follow camera looks steeply down, so the lower half of the
 * frame is the character's own feet, and the walk order came back 1.4 m away — arrived inside
 * one frame, peak speed 0.00 m/s, "it never moved". A click point has to be *derived from the
 * world through the same camera*, and then checked: on screen, on the canvas, far enough away
 * to be a walk, and on ground flat enough that the raycast agrees with `heightAt`.
 */
const groundPoint = (dist = 14, lateral = 0) => p.evaluate(([d, lat]) => {
  const g = window.game, bs = g.rig.basis();
  const wx = g.me.x + bs.fx * d + bs.rx * lat;
  const wz = g.me.z + bs.fz * d + bs.rz * lat;
  const wy = g.world.heightAt(wx, wz);
  const v = g.camera.position.clone().set(wx, wy, wz).project(g.camera);
  const r = document.querySelector('canvas').getBoundingClientRect();
  // How much the ground tilts across the click: a cliff edge makes the ray hit metres away
  // from the point we aimed at, which is a probe artefact, not a product defect.
  let relief = 0;
  for (const [ox, oz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
    relief = Math.max(relief, Math.abs(g.world.heightAt(wx + ox, wz + oz) - wy));
  }
  return {
    wx, wz, wy, relief,
    x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height,
    onScreen: Math.abs(v.x) < 0.85 && Math.abs(v.y) < 0.85 && v.z < 1,
    d: Math.hypot(wx - g.me.x, wz - g.me.z),
  };
}, [dist, lateral]);

/**
 * The same thing, but insisting on a point the pointer can actually be moved to.
 *
 * A fixed distance is not always visible: after a sprint the character can be at the foot of a
 * rise, and 14 m ahead projects 186 px *above* the frame — puppeteer then throws
 * `MoveTargetOutOfBounds` and the run dies mid-section. So try a few distances, keep the first
 * one that is comfortably inside the frame on ground that is not a cliff, and if none is, hand
 * back the last candidate with `onScreen: false` so the caller's own check fails by name
 * instead of the probe crashing.
 */
const findGround = async (want = 14, lateral = 0) => {
  let last = null;
  // Distance first, then swing sideways: on a slope straight ahead is a wall of hillside at
  // every distance, and the point that is both in frame and flat is off to one side.
  const sweep = async () => {
    for (const lat of [lateral, lateral - 8, lateral + 8, lateral - 16, lateral + 16]) {
      for (const mul of [1, 0.8, 1.3, 0.6, 1.6, 0.45]) {
        const gp = await groundPoint(Math.max(6, want * mul), lat);
        last = gp;
        const inFrame = gp.x > 60 && gp.x < W - 60 && gp.y > 80 && gp.y < H - 120;
        if (gp.onScreen && inFrame && gp.relief < 4 && gp.d > 5) return gp;
      }
    }
    return null;
  };
  const found = await sweep();
  if (found) return found;
  // Last resort: turn around. The sections above aim the camera at things (a chest, a
  // hilichurl), and once it is pointed into a hillside there is no walkable ground anywhere in
  // the frame at any distance — under check-all this returned a point at (-1066, -1036) and
  // failed three assertions that had nothing to do with the product. Turning the camera is what
  // a player does with the right button; only the rig is touched.
  const yaw0 = await p.evaluate(() => window.game.rig.yaw);
  for (const turn of [0.9, -0.9, 1.8, -1.8, 2.7, 3.14]) {
    await p.evaluate(([y]) => { window.game.rig.yaw = y; }, [yaw0 + turn]);
    await frames(2);
    const gp = await sweep();
    if (gp) return gp;
  }
  await p.evaluate(([y]) => { window.game.rig.yaw = y; }, [yaw0]);
  await frames(2);
  return { ...last, onScreen: false };
};

/** Rings are removed on `animationend`, so they have to be recorded as they are created. */
const ringsClear = () => p.evaluate(() => { window.__mpRings = []; });
const ringsRead = () => p.evaluate(() => window.__mpRings || []);

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await (await p.$('[data-act="solo"]')).click();
  await sleep(400);
  const enter = await p.$('[data-act="guest"]') || await p.$('[data-act="resume"]');
  await enter.click();
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  check('the 单机 world booted', await p.evaluate(() => !!window.game?._running && !!window.game?.playerId));

  await p.evaluate(() => {
    const g = window.game;
    window.__mpFrames = 0;
    g.on('frame', () => {
      window.__mpFrames++;
      const r = window.__mpRec;
      if (r) {
        r.maxSpeed = Math.max(r.maxSpeed, g.me.speed);
        r.minStamina = Math.min(r.minStamina, g.me.stamina);
        const a = g.me.currentAction?.();
        if (a && !r.actions.includes(a)) r.actions.push(a);
      }
    });
    // Events, not polling: at 3 fps a poll misses everything that happens inside one frame.
    window.__mpEv = { swings: [], charging: [], marks: [], arrived: [] };
    g.me.on('swing', (d) => window.__mpEv.swings.push(d));
    g.me.on('arrived', (d) => window.__mpEv.arrived.push(d?.kind || null));
    g.on('charging', (d) => window.__mpEv.charging.push(d ? Math.round(d.t * 100) / 100 : null));
    g.on('mark', (d) => window.__mpEv.marks.push({ x: Math.round(d.x), z: Math.round(d.z) }));
    // `overlay.clickRing` removes the element on `animationend` (~0.5 s), and at 3 fps every
    // DOM read for it came back empty. Record them at creation instead.
    window.__mpRings = [];
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1 || !n.classList?.contains('click-ring')) continue;
          const cs = getComputedStyle(n);
          window.__mpRings.push({ left: Math.round(parseFloat(cs.left)), top: Math.round(parseFloat(cs.top)) });
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    g.setAutoQuality(false);
    g.setQuality('high');
    g.setWorldTime(12);
  });
  await sleep(2000);
  const evRead = () => p.evaluate(() => window.__mpEv);
  const evClear = () => p.evaluate(() => { window.__mpEv = { swings: [], charging: [], marks: [], arrived: [] }; });
  check('the tier is pinned to high', await p.evaluate(() => window.game.quality) === 'high');
  const advanced = await frames(4);
  check('the game is rendering, so a stale frame cannot pass for a fresh one', advanced >= 4, `${advanced} frames`);
  // 単机 boots with the guide card up; it is transparent to clicks (tutorial-check proves that)
  // but it also *marks* steps, and a step popup mid-run would move the HUD under the cursor.
  await p.evaluate(() => window.game.tutorial.skip?.());
  await frames(2);

  /* --------------------------------------------------- 1) 左键点地面: 点哪走哪 -- */
  console.log('\n--- 左键点地面');

  const g1 = await findGround(14, 4);
  check('the probe aims at real, reachable ground 14 m out', g1.onScreen && g1.relief < 3.5,
    `${g1.d.toFixed(1)} m out, relief ${g1.relief.toFixed(1)} m, at ${Math.round(g1.x)},${Math.round(g1.y)}`);
  const onGround = await elementAt(g1.x, g1.y);
  check('the point the probe clicks is the world, not a HUD element', onGround === 'canvas', `elementFromPoint → ${onGround}`);
  const s0 = await state();
  await ringsClear();
  await press(g1.x, g1.y);
  const s1 = await state();
  check('a short left press on open ground issues a walk order', s1.goalKind === 'move' && !!s1.goal,
    `goalKind ${s1.goalKind} goal ${s1.goal ? `${s1.goal.x.toFixed(1)},${s1.goal.z.toFixed(1)}` : 'null'}`);
  check('...to somewhere else, not to where the character already stands',
    !!s1.goal && Math.hypot(s1.goal.x - s1.x, s1.goal.z - s1.z) > 3,
    s1.goal ? `${Math.hypot(s1.goal.x - s1.x, s1.goal.z - s1.z).toFixed(1)} m away` : 'no goal');
  // The self-validating half: project the order back through the same camera. A goal that is
  // not under the cursor means the ray, the ground raycast or the camera basis is wrong — and
  // "the character walked somewhere" would never have caught it.
  if (s1.goal) {
    const backY = await p.evaluate(([x, z]) => window.game.world.heightAt(x, z), [s1.goal.x, s1.goal.z]);
    const proj = await toScreen(s1.goal.x, backY, s1.goal.z);
    const off = Math.hypot(proj.x - g1.x, proj.y - g1.y);
    check('...and that point is the one under the cursor', off < 70,
      `order projects to ${Math.round(proj.x)},${Math.round(proj.y)} — ${Math.round(off)} px from the click`);
    // Stated in metres as well: the ray hit the ground the probe was aiming at, not some
    // other patch that happens to project nearby.
    check('...within a couple of metres of the ground the probe aimed at',
      Math.hypot(s1.goal.x - g1.wx, s1.goal.z - g1.wz) < 3,
      `${Math.hypot(s1.goal.x - g1.wx, s1.goal.z - g1.wz).toFixed(1)} m from the aim point`);
  } else skipped('the walk order projects back to the cursor', 'no order was issued');
  const rings1 = await ringsRead();
  check('the click leaves a ring where the player clicked',
    rings1.length === 1 && Math.hypot(rings1[0].left - g1.x, rings1[0].top - g1.y) < 10,
    rings1.length ? `ring at ${rings1[0].left},${rings1[0].top} vs click ${Math.round(g1.x)},${Math.round(g1.y)}`
      : 'no .click-ring was created');

  // Walking is the outcome that matters; the order is only the intent.
  const dBefore = s1.goal ? Math.hypot(s1.goal.x - s1.x, s1.goal.z - s1.z) : 0;
  await frames(25);
  const s2 = await state();
  const dAfter = s2.goal ? Math.hypot(s2.goal.x - s2.x, s2.goal.z - s2.z) : 0;
  check('the character walks the order off, and stops when it arrives',
    (!s2.goal && (await evRead()).arrived.includes('move')) || dAfter < dBefore - 1,
    s2.goal ? `${dBefore.toFixed(1)} → ${dAfter.toFixed(1)} m` : `arrived, moved ${Math.hypot(s2.x - s1.x, s2.z - s1.z).toFixed(1)} m`);
  const travelled = Math.hypot(s2.x - s0.x, s2.z - s0.z);
  check('...and it was the click that moved it, with no key ever pressed', travelled > 2,
    `${travelled.toFixed(1)} m from one click`);
  await shot('ground-click');

  // Left of centre vs right of centre: the two orders must land on opposite sides of the
  // camera's own right vector. Without this, a click-to-move that ignored `ndcX` entirely —
  // walking to a fixed point ahead — would pass every assertion above.
  // Each side is measured against the basis *at the moment of its own click*, and immediately:
  // the rig turns to follow the walk, so measuring both against the final basis put both offsets
  // on the same side (+2.3 and +7.7 m) and failed a rule the product was keeping.
  const sideOf = async (lateral) => {
    const gp = await findGround(13, lateral);
    if (!gp.onScreen) return null;
    await press(gp.x, gp.y);
    return p.evaluate(() => {
      const g = window.game, bs = g.rig.basis();
      if (!g.me.goal) return null;
      return (g.me.goal.x - g.me.x) * bs.rx + (g.me.goal.z - g.me.z) * bs.rz;
    });
  };
  const sideL = await sideOf(-8);
  const sideR = await sideOf(8);
  check('a click left of centre and one right of centre point to opposite sides of the camera',
    sideL !== null && sideR !== null && sideL < -1 && sideR > 1,
    `right-axis offsets ${sideL === null ? 'n/a' : sideL.toFixed(1)} vs ${sideR === null ? 'n/a' : sideR.toFixed(1)} m`);

  /* ------------------------------------------- 2) 双击: sprint there, and ping it -- */
  console.log('\n--- 双击地面');

  // Control first: a single click runs (RUN), it does not sprint, and it costs no stamina.
  await evClear();
  await recStart();
  const gSingle = await findGround(22, 0);
  await press(gSingle.x, gSingle.y);
  await frames(22);
  const recSingle = await recRead();
  const evSingle = await evRead();
  await evClear();
  await recStart();
  const gDouble = await findGround(22, 0);
  check('both halves of the sprint comparison aim at the same distance of open ground',
    gSingle.onScreen && gDouble.onScreen && Math.abs(gSingle.d - gDouble.d) < 2,
    `${gSingle.d.toFixed(1)} m vs ${gDouble.d.toFixed(1)} m`);
  await doublePress(gDouble.x, gDouble.y);
  await frames(22);
  const recDouble = await recRead();
  const sDouble = await state();
  const evDouble = await evRead();
  check('a single click runs', recSingle.maxSpeed > 4.4 && recSingle.maxSpeed < 6.2,
    `peak ${recSingle.maxSpeed.toFixed(2)} m/s`);
  check('...and costs no stamina', recSingle.startStamina - recSingle.minStamina < 1,
    `Δstamina ${(recSingle.startStamina - recSingle.minStamina).toFixed(1)}`);
  check('a double click sprints instead — the same sprint the keyboard has',
    recDouble.maxSpeed > recSingle.maxSpeed + 1.5,
    `peak ${recDouble.maxSpeed.toFixed(2)} m/s vs ${recSingle.maxSpeed.toFixed(2)} for one click`);
  check('...and it pays for it in stamina', recDouble.startStamina - recDouble.minStamina > 2,
    `Δstamina ${(recDouble.startStamina - recDouble.minStamina).toFixed(1)}`);
  check('...and the body is in the sprint pose, so other players see it too',
    recDouble.actions.includes(ACTION.sprint),
    `poses ${recDouble.actions.map((a) => ACTION_NAMES[a] ?? a).join(' ')}`);
  check('...which a single click never reaches, so the two are visibly different',
    !recSingle.actions.includes(ACTION.sprint),
    `single-click poses ${recSingle.actions.map((a) => ACTION_NAMES[a] ?? a).join(' ')}`);
  check('...and the order carries the sprint flag rather than a second movement rule',
    sDouble.goalSprint === true || (!sDouble.goal && recDouble.actions.includes('sprint')),
    `goalSprint ${sDouble.goalSprint}, goal ${sDouble.goal ? 'live' : 'arrived'}`);
  check('the double click also pings the spot for the party, through the socket',
    evDouble.marks.length >= 1, `${evDouble.marks.length} mark(s) back from the host`);
  check('...which a single click does not do, so the map is not littered with pings',
    evSingle.marks.length === 0, `${evSingle.marks.length} mark(s) from the single click`);
  await shot('double-click-sprint');

  /* ------------------------------------------------ 3) 按住左键: charge, not walk -- */
  console.log('\n--- 按住左键');

  await evClear();
  const sBeforeHold = await state();
  // Held for frames: the charge meter runs on the clamped `dt`, so a wall-clock hold charges
  // nothing at 3 fps. The same press is ~4 s long in wall clock, which is what makes it a
  // hold and not a click for `input.js`.
  const gHold = await findGround(14, 0);
  await press(gHold.x, gHold.y, { holdFrames: 16 });
  const sAfterHold = await state();
  const evHold = await evRead();
  check('a long press is not a click: no walk order is issued',
    !sAfterHold.goal || (sBeforeHold.goal && sAfterHold.goal
      && sAfterHold.goal.x === sBeforeHold.goal.x && sAfterHold.goal.z === sBeforeHold.goal.z),
    `goalKind ${sAfterHold.goalKind}`);
  check('...it charges instead, and the HUD is told while it charges',
    evHold.charging.some((t) => t !== null), `charging ticks ${evHold.charging.filter((t) => t !== null).join(' ')}`);
  check('...and releasing it swings a charged attack',
    evHold.swings.some((s) => s.charged === true),
    evHold.swings.map((s) => (s.charged ? 'charged' : 'normal')).join(' ') || 'no swing');

  /* ---------------------------------------- 4) 左键拖动 does not orbit the camera -- */
  console.log('\n--- 左键拖动 / 右键拖动 / 中键拖动');

  const sBeforeDrag = await state();
  await dragBy(W * 0.5, H * 0.55, 180, 'left');
  const sAfterLeftDrag = await state();
  check('a left drag does not orbit the camera', Math.abs(sAfterLeftDrag.yaw - sBeforeDrag.yaw) < 0.02,
    `yaw ${sBeforeDrag.yaw.toFixed(3)} → ${sAfterLeftDrag.yaw.toFixed(3)}`);
  check('...and a drag is not a click either, so it issues no walk order',
    !sAfterLeftDrag.goal || sAfterLeftDrag.goalKind !== 'move'
    || (sBeforeDrag.goal && sAfterLeftDrag.goal.x === sBeforeDrag.goal.x),
    `goalKind ${sAfterLeftDrag.goalKind}`);

  const yawA = (await state()).yaw;
  await dragBy(W * 0.5, H * 0.55, 200, 'right');
  const yawB = (await state()).yaw;
  check('a right drag turns the camera', Math.abs(yawB - yawA) > 0.2, `yaw ${yawA.toFixed(2)} → ${yawB.toFixed(2)}`);
  const sAfterRightDrag = await state();
  check('...and cancels nothing by itself — a drag is not the right *click*',
    sAfterRightDrag.goalKind === sAfterLeftDrag.goalKind, `goalKind ${sAfterRightDrag.goalKind}`);
  await dragBy(W * 0.5, H * 0.55, -200, 'middle');
  const yawC = (await state()).yaw;
  check('the middle button turns it too, as the table promises', Math.abs(yawC - yawB) > 0.2,
    `yaw ${yawB.toFixed(2)} → ${yawC.toFixed(2)}`);
  await shot('after-drags');

  /* ----------------------------------------------- 5) 右键单击: cancel everything -- */
  console.log('\n--- 右键单击');

  // The order the right click has to cancel is the *arrange* step, and it needs §1's two guards —
  // a point that is really on screen and really the canvas — or the row measures the wrong thing.
  // Inside check-all this section starts with the camera wherever §4's drags left it: one run
  // pressed a point `findGround` had already given up on (`onScreen: false`) and the row read
  // `goal null → null`, i.e. the arrange step failed under the product's name. So the order is
  // retried sideways, reported on its own line, and if the frame really has no clickable ground
  // both rows SKIP rather than blame the right button for it.
  let gCancel = null, sOrdered = null;
  for (const lat of [0, -10, 10, -18]) {
    const gp = await findGround(16, lat);
    if (!gp.onScreen || (await elementAt(gp.x, gp.y)) !== 'canvas') continue;
    await press(gp.x, gp.y);
    gCancel = gp; sOrdered = await state();
    if (sOrdered.goal) break;
  }
  const arranged = `${gCancel ? `from ${Math.round(gCancel.x)},${Math.round(gCancel.y)}`
    + ` — ${gCancel.d.toFixed(1)} m out, relief ${gCancel.relief.toFixed(1)} m` : 'nowhere clickable'}`;
  if (!gCancel) {
    skipped('a walk order is standing before the right click', 'no on-screen ground in four sweeps');
    skipped('a right click stops the character', 'no walk order could be issued to cancel');
    skipped('...and drops the lock-on', 'no walk order could be issued to cancel');
  } else {
    check('a walk order is standing before the right click', !!sOrdered.goal, arranged);
    await press(W * 0.5, H * 0.5, { ms: 80, button: 'right' });
    const sCancelled = await state();
    check('a right click stops the character', !!sOrdered.goal && sCancelled.goal === null,
      `goal ${sOrdered.goal ? 'set' : 'null'} → ${sCancelled.goal ? 'set' : 'null'} (${arranged})`);
    check('...and drops the lock-on', sCancelled.target === null, `target ${sCancelled.target}`);
  }

  /* -------------------------------------------------------------- 6) 滚轮: zoom -- */
  console.log('\n--- 滚轮');

  const wheelBy = async (dy) => {
    // Firefox + puppeteer has no CDP `Input.dispatchMouseEvent` wheel, so the event is
    // dispatched on the canvas — it still travels through the product's own listener,
    // with the same deltaMode normalisation, which is the thing under test.
    await p.evaluate((d) => {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      c.dispatchEvent(new WheelEvent('wheel', {
        deltaY: d, deltaMode: 0, bubbles: true, cancelable: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
    }, dy);
    await frames(2);
  };
  const dist0 = (await state()).dist;
  await wheelBy(300);
  const dist1 = (await state()).dist;
  await wheelBy(-300);
  const dist2 = (await state()).dist;
  check('the wheel pushes the camera out', dist1 > dist0 + 0.2, `dist ${dist0.toFixed(2)} → ${dist1.toFixed(2)}`);
  check('...and pulls it back in', dist2 < dist1 - 0.2, `dist ${dist1.toFixed(2)} → ${dist2.toFixed(2)}`);
  for (let i = 0; i < 12; i++) await wheelBy(600);
  const distMax = (await state()).dist;
  for (let i = 0; i < 24; i++) await wheelBy(-600);
  const distMin = (await state()).dist;
  check('...and it is clamped at both ends instead of running away',
    distMax <= 13.6 && distMin >= 1.85, `clamped to ${distMin.toFixed(2)} .. ${distMax.toFixed(2)} m`);
  await wheelBy(600);
  await wheelBy(600);

  /* ------------------------------------------------------ 7) 左键点敌人: lock on -- */
  console.log('\n--- 左键点敌人');

  const spawn = await p.evaluate(() => {
    const g = window.game;
    g.me.clearGoal();
    // Put the camera back at its default framing first: the wheel section above left it at a
    // zoom extreme, and where a body lands in the frame is a property of the rig, not of the
    // click. `dist`/`pitch` are exactly what the wheel and a right-drag write.
    g.rig.pitch = 0.30;
    if (g.rig.distWant !== undefined) g.rig.distWant = 7;
    g.rig.dist = 7;
    // In front of the *camera*, using the camera's own forward vector — `sin/cos(rig.yaw)` is a
    // guess about the rig's angle convention, and it put the first spawn behind the character.
    const bs = g.rig.basis();
    // `hpMul` is the product's own knob (深境 disorders spawn waves with it), and it is what
    // makes the death rule below testable: a full 420 hp hilichurl takes between 90 s and seven
    // minutes to fall depending on where llvmpipe's frame rate lands — one run got 420 → 312 in
    // 119 s and reported 「锁定在目标死亡时解除」 broken, then failed the next section too because
    // the survivor was still chasing. What is under test is that *one click* keeps the character
    // swinging until the target is down, and that reads the same at 63 hp.
    const e = g.socket.inst.spawnEnemy('hilichurl', 1, g.me.x + bs.fx * 14, g.me.z + bs.fz * 14,
      { hpMul: 0.15 });
    return e ? { id: e.id, x: e.x, z: e.z, hp: Math.round(e.hp) } : null;
  });
  check('an enemy was spawned into the local sim to click on', !!spawn, JSON.stringify(spawn));
  await frames(4);
  if (spawn) {
    /**
     * Where that enemy's *body* is right now, in the exact terms `actors.pickEnemy` uses:
     * the client-side actor's `y + height * 0.5`, not `heightAt(x, z) + 1`. Two things were
     * wrong with the first version — it aimed at a guessed height, and it aimed at the
     * *spawn* position of a hilichurl that walks toward the player at 3 m/s while llvmpipe
     * renders at 3 fps, so by the time the pointer arrived the body had left the pixel.
     */
    const aimEnemy = () => p.evaluate((id) => {
      const g = window.game;
      const e = g.actors.enemies.get(id);
      if (!e) return null;
      // Face it: a hilichurl closes the distance while llvmpipe renders, and it strafes. Turning
      // the camera is what a player does with the right button; the click stays a real click.
      const dx = e.x - g.me.x, dz = e.z - g.me.z, l = Math.hypot(dx, dz) || 1;
      g.rig.yaw = Math.atan2(-dx / l, -dz / l);
      const cy = e.y + e.actor.height * 0.5;
      const v = g.camera.position.clone().set(e.x, cy, e.z).project(g.camera);
      const r = document.querySelector('canvas').getBoundingClientRect();
      return {
        x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height,
        onScreen: Math.abs(v.x) < 0.9 && Math.abs(v.y) < 0.9 && v.z < 1,
        d: l, radius: Math.max(0.7, e.actor.height * 0.45) + 0.35,
        why: `body y ${e.y.toFixed(1)}+${(e.actor.height * 0.5).toFixed(1)}, cam y ${g.camera.position.y.toFixed(1)},`
          + ` pitch ${g.rig.pitch.toFixed(2)}, dist ${g.rig.dist.toFixed(1)}`,
      };
    }, spawn.id);
    // The yaw write takes a frame to reach the camera matrix, so aim, let it render, aim again.
    let at2 = await aimEnemy();
    for (let i = 0; i < 4 && (!at2 || !at2.onScreen); i++) { await frames(2); at2 = await aimEnemy(); }
    check('the spawned enemy exists on the client and is on screen', !!at2 && at2.onScreen,
      at2 ? `${at2.d.toFixed(1)} m away at ${Math.round(at2.x)},${Math.round(at2.y)} — ${at2.why}`
        : 'no client actor for it');
    if (!at2 || !at2.onScreen) skipped('clicking an enemy locks on to it', 'the spawn did not land on screen');
    else {
      const hit = await elementAt(at2.x, at2.y);
      check('the enemy is under the cursor, on the canvas', hit === 'canvas', `elementFromPoint → ${hit}`);
      await evClear();
      // Re-aim before each attempt: the aim is only valid for the frame it was taken in.
      let sEnemy = null;
      for (let i = 0; i < 4; i++) {
        at2 = await aimEnemy();
        if (!at2 || !at2.onScreen) break;
        await press(at2.x, at2.y);
        sEnemy = await state();
        if (sEnemy.target === spawn.id) break;
      }
      sEnemy = sEnemy || await state();
      check('clicking an enemy locks on to it', sEnemy.target === spawn.id, `target ${sEnemy.target} (want ${spawn.id})`);
      check('...and starts the auto-attack the mouse scheme promises', sEnemy.autoAttack === true,
        `autoAttack ${sEnemy.autoAttack}`);
      check('...and walks up to it rather than issuing a plain move order',
        sEnemy.goalKind === 'approach' || (!sEnemy.goal && sEnemy.target === spawn.id),
        `goalKind ${sEnemy.goalKind}`);
      // The kill, from clicks only: this is the claim 「目标死亡前持续攻击」. 420 hp at llvmpipe's
      // frame rate is about a minute and a half of real swinging, so the budget is generous —
      // the first version gave it 35 s, saw 420 → 258 and called sustained auto-attack broken.
      // Swings are counted from the player's own event, not from polled hp: at 700 ms a poll is
      // coarser than the swing rate, and a 63 hp hilichurl that fell in 4 s showed only two hp
      // steps for what was a whole combo.
      await evClear();
      const t0 = Date.now();
      let hp = spawn.hp, dead = false, drops = 0;
      for (let i = 0; i < 150; i++) {
        const r = await p.evaluate((id) => {
          const live = window.game.socket.inst.enemies.get(id);
          return { hp: live ? Math.round(live.hp) : 0, gone: !live || !live.alive };
        }, spawn.id);
        // Separate hits, not just "hp is lower than it started": one lucky swing followed by a
        // character that stopped fighting would satisfy the second and not the claim.
        if (r.hp < hp) drops++;
        hp = r.hp;
        if (r.gone) { dead = true; break; }
        await sleep(700);
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      const swings = (await evRead()).swings.length;
      check('the one click keeps the character swinging with no further input',
        swings >= 2 || drops >= 2,
        `${swings} swing(s) and ${drops} hp step(s) from that one click, hp ${spawn.hp} → ${hp} after ${secs}s`);
      check('...until the target is down', dead, `hp ${spawn.hp} → ${hp} in ${secs}s`);
      await frames(4);
      const sDead = await state();
      // Only meaningful if the lock happened: `target === null` is also true of a build where
      // clicking an enemy never locked on at all, which is exactly what the first run reported.
      if (sEnemy.target !== spawn.id) skipped('the lock-on clears itself when the target dies', 'nothing was locked');
      else check('...and the lock-on clears itself when the target dies', sDead.target === null,
        `target ${sDead.target}`);
      await shot('enemy-click');
      // However the fight ended, this hilichurl must not still be chasing the character through
      // the sections below. Alive and in reach it turns every later click into a branch-1 click
      // — target set, no order — which is how 「点宝箱」 failed with `goalKind null` while the
      // product was doing exactly what it promises.
      // Through `onEnemyKilled`, not by deleting the row: the client only removes an actor when
      // it is told the enemy died, and a silently deleted enemy leaves a ghost body that
      // `actors.pickEnemy` still hits.
      await p.evaluate((id) => {
        const inst = window.game.socket.inst;
        const e = inst.enemies.get(id);
        if (e && e.alive) { e.hp = 0; inst.onEnemyKilled(e, null); }
        window.game._clearTarget?.();
      }, spawn.id);
      await frames(3);
    }
  }

  /* -------------------------------------------- 8) 左键点宝箱/NPC: walk and use -- */
  console.log('\n--- 左键点宝箱 / NPC');

  // Turn the camera toward the nearest live interactable first. Waiting for one to happen to be
  // in frame made this section SKIP — the character had been walked around by the sections above
  // — and a skipped section proves nothing. Only the *camera* is moved here (the same thing a
  // right-drag does); the click itself still goes through the pointer and the product's ray.
  // Beyond INTERACT_RANGE, parsed from game.js rather than guessed: inside it the click uses the
  // thing on the spot (`_interact`, no order at all), which is correct behaviour but not the
  // 「走过去并交互」 the table promises. A node 4.5 m away made this section fail for that reason.
  const RANGE = Number(strip(code.game).match(/const INTERACT_RANGE = ([\d.]+)/)?.[1]);
  check('INTERACT_RANGE was parsed, so the walk-and-use path is the one driven below',
    RANGE > 0, `INTERACT_RANGE ${RANGE}`);
  const inter = await p.evaluate(async (minD) => {
    const g = window.game;
    let near = null, nd = Infinity;
    for (const it of g.world.interactables || []) {
      if (it.type === 'gather' && (it.done || !it.prop)) continue;
      if (it.done && it.type !== 'npc') continue;
      const d = Math.hypot(it.x - g.me.x, it.z - g.me.z);
      if (d < minD || d > 70 || d > nd) continue;
      nd = d; near = it;
    }
    if (!near) return null;
    // forward = (-sin yaw, -cos yaw), so facing (dx, dz) is yaw = atan2(-dx, -dz).
    const dx = near.x - g.me.x, dz = near.z - g.me.z, l = Math.hypot(dx, dz) || 1;
    g.rig.yaw = Math.atan2(-dx / l, -dz / l);
    g.me.clearGoal();
    return { id: near.id || null, type: near.type, radius: near.radius ?? 2, d: nd, wx: near.x, wz: near.z };
  }, (RANGE || 4.2) + 3);
  if (inter) {
    await frames(3);
    // The aim point is the centre of the sphere `world.pickInteractable` tests, computed the
    // same way — a click that misses that sphere is a probe artefact, not a product defect.
    const aim = await p.evaluate(([x, z, radius]) => {
      const g = window.game;
      const gy = g.world.heightAt(x, z);
      const cy = gy + Math.min(1.4, Math.max(0.5, radius * 0.5));
      const v = g.camera.position.clone().set(x, cy, z).project(g.camera);
      const r = document.querySelector('canvas').getBoundingClientRect();
      return {
        x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height,
        onScreen: Math.abs(v.x) < 0.9 && Math.abs(v.y) < 0.9 && v.z < 1,
      };
    }, [inter.wx, inter.wz, inter.radius]);
    inter.x = aim.x; inter.y = aim.y; inter.onScreen = aim.onScreen;
  }
  if (!inter) skipped('clicking a chest or a node walks over and uses it', 'no live interactable within 70 m');
  else if (!inter.onScreen) skipped('clicking a chest or a node walks over and uses it',
    `the ${inter.type} ${inter.d.toFixed(0)} m away would not project into the frame`);
  else {
    const hit = await elementAt(inter.x, inter.y);
    check('the interactable is under the cursor, on the canvas', hit === 'canvas',
      `${inter.type} ${inter.d.toFixed(1)} m away, elementFromPoint → ${hit}`);
    await evClear();   // a `find` over the whole event log would return the previous order's arrival
    await press(inter.x, inter.y);
    const sIt = await state();
    check('clicking a chest or a node issues an interact order, not a walk order',
      sIt.goalKind === 'interact' || (await evRead()).arrived.includes('interact'),
      `goalKind ${sIt.goalKind} payload ${sIt.goalPayload}`);
    // The order has to be aimed at the *thing*, not at the patch of ground under the cursor:
    // `_leftClick` walks to `it.x, it.z`, so the goal must sit on the interactable itself.
    check('...aimed at the thing that was clicked, not at the ground in front of it',
      !sIt.goal || Math.hypot(sIt.goal.x - inter.wx, sIt.goal.z - inter.wz) < 1.5,
      sIt.goal ? `${Math.hypot(sIt.goal.x - inter.wx, sIt.goal.z - inter.wz).toFixed(2)} m from the ${inter.type}`
        : `already in range (radius ${inter.radius})`);
    // And then the second half of the promise: it walks over and *uses* it, from that one click.
    let used = null;
    for (let i = 0; i < 40; i++) {
      used = await p.evaluate((id) => {
        const g = window.game;
        const it = (g.world.interactables || []).find((o) => o.id === id);
        return {
          done: !!it?.done, arrived: (window.__mpEv.arrived || []).includes('interact'),
          d: it ? Math.round(Math.hypot(it.x - g.me.x, it.z - g.me.z) * 10) / 10 : -1,
          panel: !!document.querySelector('.dialogue, .chest-reward, .panel.open'),
        };
      }, inter.id);
      if (used.done || used.panel) break;
      await frames(3);
    }
    check('...and one click is enough to walk over and use it',
      used.done || used.panel, `${inter.type} ${used.d} m away, arrived ${used.arrived}, done ${used.done}`);
    await shot('interactable-click');
  }

  /* --------------------------------------------- 9) a modal swallows world clicks -- */
  console.log('\n--- 背包打开时，世界收不到点击');

  // Start from a world with nothing open. Harvesting the node above can leave a panel up, and
  // then the first KeyB *closed* that one instead of opening the bag: the section reported
  // 「关掉之后世界收不回点击」 while the product was fine and only the probe's premise was wrong.
  // `window.ui.panels`, not `game.panels` — the game does not own the panel manager, and the
  // first version of this reset read `g.panels?.isOpen`, which is `undefined` forever: the
  // optional chain made a no-op look like a clean world. Asserted below, so a rename fails.
  const hasPanels = await p.evaluate(() => !!window.ui?.panels);
  check('the probe can see the panel manager it is about to drive', hasPanels, `window.ui.panels ${hasPanels}`);
  await p.evaluate(() => {
    window.game.me.clearGoal();
    if (window.ui?.panels?.isOpen) window.ui.panels.close();
  });
  await frames(3);
  const sPre = await state();
  check('nothing is open before the modal gate is tested, so KeyB opens rather than closes',
    sPre.paused === false && sPre.enabled === true && !sPre.panel,
    `paused ${sPre.paused}, input.enabled ${sPre.enabled}, panel ${sPre.panel}`);
  // Derived while the world still runs; the rig is frozen once the panel takes over, so the
  // same screen point means the same patch of ground for both halves of the test. It has to be
  // *on the canvas*: a point that misses the ground raycast leaves no ring and no order, which
  // is indistinguishable from "the modal ate the click" — the failure this section is for.
  // Several candidates, not one: the point also has to be *inert* once the panel covers it.
  // The panel header's tabs are panel navigation (`panels.js` — 「一个在背包里的玩家想看角色
  // 面板，不该先关掉再按键」), so a click that lands on `.tab` switches the open panel, and the
  // KeyB below then re-opens the inventory instead of closing anything. That is the product
  // working; it cost this section two failures until `elementFromPoint → div.tab` said so.
  const cands = [];
  for (const [d, lat] of [[15, 0], [11, 6], [20, -6], [26, 10], [9, -10],
    [13, -4], [18, 8], [30, 0], [22, 14], [8, 4]]) {
    const gp = await findGround(d, lat);
    if (!gp.onScreen) continue;
    if ((await elementAt(gp.x, gp.y)) !== 'canvas') continue;
    cands.push(gp);
  }
  check('the modal test clicks a point that reaches the world when nothing is open',
    cands.length > 0,
    `${cands.length} candidate(s), first ${cands[0] ? `${cands[0].d.toFixed(1)} m out at `
      + `${Math.round(cands[0].x)},${Math.round(cands[0].y)}` : 'none'}`);
  await p.keyboard.press('KeyB');
  await frames(3);
  const sOpen = await state();
  // Pick the candidate the open panel does not turn into a UI click of its own. Two of the
  // panel's own gestures are in the way, and both are correct behaviour: the header tabs are
  // panel navigation, and a `mousedown` on the *scrim* closes the panel (点击外部关闭). A click on
  // either leaves the section testing nothing — the scrim one closed the bag and the KeyB below
  // then re-opened it.
  const panelHit = (x, y) => p.evaluate(([cx, cy]) => {
    const el = document.elementFromPoint(cx, cy);
    return {
      what: el ? el.tagName.toLowerCase() + (el.className ? `.${String(el.className).split(' ')[0]}` : '') : null,
      inert: !!el && !!el.closest('.panel') && !el.closest('.tab') && !el.closest('.close'),
    };
  }, [Math.round(x), Math.round(y)]);
  let gModal = cands[0] || { x: W * 0.5, y: H * 0.6, d: 0, onScreen: false };
  let over = await panelHit(gModal.x, gModal.y);
  for (const c of cands) {
    const hit = await panelHit(c.x, c.y);
    if (hit.inert) { gModal = c; over = hit; break; }
  }
  const overPanel = over.what;
  check('...and one the open panel covers with something inert, not with its tabs or its scrim',
    over.inert, `over ${overPanel} at ${Math.round(gModal.x)},${Math.round(gModal.y)}`);
  await ringsClear();
  await press(gModal.x, gModal.y);
  const sClicked = await state();
  const ringsBlocked = await ringsRead();
  check('opening the bag pauses world input', sOpen.paused === true && sOpen.enabled === false
    && sOpen.panel === 'inventory', `panel ${sOpen.panel}, paused ${sOpen.paused}, input.enabled ${sOpen.enabled}`);
  check('...so a click at the same spot issues no walk order', sClicked.goal === null,
    `goal ${sClicked.goal ? 'set' : 'null'}, elementFromPoint → ${overPanel}`);
  check('...and leaves no click ring behind', ringsBlocked.length === 0, `${ringsBlocked.length} ring(s)`);
  // The same key has to close what it opened, so the panel must still be the one KeyB toggles.
  check('...and the blocked click did not quietly navigate to another panel',
    sClicked.panel === 'inventory', `panel ${sClicked.panel} after the blocked click`);
  await p.keyboard.press('KeyB');
  let sClosed = await state();
  for (let i = 0; i < 6 && (sClosed.panel || !sClosed.enabled); i++) { await frames(2); sClosed = await state(); }
  // The both-sided half. Asserting only on `goal` would be flaky: the order can be walked off
  // and cleared before the read, and "no goal" then looks like "the click was swallowed". A ring
  // is the receipt that `_leftClick` ran at all, and it is recorded at creation.
  await ringsClear();
  await evClear();
  // A fresh point for the reopened world. The one the panel covered was chosen for the panel's
  // sake, and it happened to sit inside the radius of the mint node this probe had just walked
  // to: branch 4 used it on the spot, so there was no walk order to read and 「世界又收到点击了」
  // read false while the ring proved the click had landed. Ask for ground with nothing
  // interactable in reach of it, so the ground branch is the one under test.
  // Branches 1–4 are asked with the product's own pickers, along the ray the product would build
  // from this very screen point: filtering on `nearestInteractable` alone still left a node
  // *under the cursor* (branch 3), which interacts on the spot and sets no order at all — one
  // ring, no goal, and 「世界又收到点击了」 read false for the second time.
  let gBack = gModal;
  for (const [d, lat] of [[16, 0], [13, 8], [20, -8], [24, 6], [10, -12], [28, 4], [18, -14]]) {
    const gp = await findGround(d, lat);
    if (!gp.onScreen || (await elementAt(gp.x, gp.y)) !== 'canvas') continue;
    const clean = await p.evaluate(([x, y, wx, wy, wz]) => {
      const g = window.game;
      const r = document.querySelector('canvas').getBoundingClientRect();
      const ndcX = ((x - r.left) / r.width) * 2 - 1;
      const ndcY = -(((y - r.top) / r.height) * 2 - 1);
      const ray = g._pointerRay({ ndcX, ndcY });
      return !g.actors.pickEnemy(ray, 90)
        && !g.actors.pickPlayer(ray, 90, (pl) => !pl.alive)
        && !g.world.pickInteractable(ray, 90)
        && !g.world.nearestInteractable(wx, wy, wz);
    }, [gp.x, gp.y, gp.wx, gp.wy, gp.wz]);
    if (clean) { gBack = gp; break; }
  }
  await press(gBack.x, gBack.y);
  const sAgain = await state();
  const ringsBack = await ringsRead();
  const evAgain = await evRead();
  // "The world reacted", not "a walk order exists": the click can legitimately land on the node
  // the character is standing next to (branch 3/4 → interact, no goal) or on the hilichurl still
  // chasing it (attack in reach → clearGoal), and the first version of this assertion called
  // both of those a swallowed click. The ring is the receipt that `_leftClick` ran.
  const reacted = !!sAgain.goal || sAgain.goalKind === 'interact' || evAgain.arrived.length > 0
    || evAgain.swings.length > 0 || !!sAgain.target;
  check('closing it gives the world its clicks back',
    sClosed.enabled === true && ringsBack.length === 1 && reacted,
    `input.enabled ${sClosed.enabled}, panel ${sClosed.panel}, ${ringsBack.length} ring(s),`
    + ` goalKind ${sAgain.goalKind}, target ${sAgain.target}, ${evAgain.swings.length} swing(s)`);

  /* ------------------------------------------- 10) 点头像 / 技能图标: the HUD too -- */
  console.log('\n--- 点头像与技能图标');

  // `switchTo` refuses two cases — the slot already on field, and a downed character — so the
  // card is chosen the way the product decides, not by index. Clicking `.pcard[1]` blind
  // reported 「lyra → lyra」 once, which says nothing about whether portraits work.
  const findCard = () => p.evaluate(() => {
    const g = window.game;
    const cards = [...document.querySelectorAll('.pcard')];
    for (const el of cards) {
      const slot = Number(el.dataset.slot);
      if (!Number.isFinite(slot) || slot === g.activeSlot) continue;
      const id = g.party[slot];
      if (!id || g._hpOf(id) <= 0) continue;
      const r = el.getBoundingClientRect();
      // A rect of zeros is a card mid-rerender (the party bar is rebuilt on every `party`
      // event), not a card at the top-left corner — clicking (0, 0) switched nobody.
      if (r.width < 10 || r.height < 10) continue;
      return { slot, id, x: r.x + r.width / 2, y: r.y + r.height / 2, cards: cards.length };
    }
    return { cards: cards.length };
  });
  // The HUD is only clickable with the world in front of it: a panel left over from the section
  // above covers the party bar with its scrim, and both assertions below then fail for a reason
  // that has nothing to do with portraits (`elementFromPoint → div.scrim`).
  await p.evaluate(() => { if (window.ui?.panels?.isOpen) window.ui.panels.close(); });
  await frames(3);
  const sHud = await state();
  check('the HUD is in front of the world, with no panel over the party bar',
    !sHud.panel && sHud.enabled === true, `panel ${sHud.panel}, input.enabled ${sHud.enabled}`);
  let pcard = await findCard();
  for (let i = 0; i < 8 && !pcard.id; i++) { await frames(2); pcard = await findCard(); }
  if (!pcard.id) skipped('clicking a portrait switches character',
    `${pcard.cards} portrait(s), none of them a live off-field slot`);
  else {
    // Wait for the party bar to be reachable rather than assuming it is: a 获得物品 toast from
    // the gather above sits over the portraits for a few seconds, and under check-all it ate the
    // click — the switch never happened and the failure looked like a broken HUD.
    let over = null;
    for (let i = 0; i < 12; i++) {
      over = await p.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return { onCard: !!el?.closest('.pcard'), what: el ? el.tagName.toLowerCase() + (el.className ? `.${String(el.className).split(' ')[0]}` : '') : null };
      }, [Math.round(pcard.x), Math.round(pcard.y)]);
      if (over.onCard) break;
      await frames(2);
      const again = await findCard();      // the bar may have been rebuilt under the cursor
      if (again.id) pcard = again;
    }
    check('the portrait is what the cursor is actually over', over?.onCard,
      `slot ${pcard.slot} (${pcard.id}) at ${Math.round(pcard.x)},${Math.round(pcard.y)},`
      + ` elementFromPoint → ${over?.what}`);
    const before = (await state()).charId;
    await p.mouse.click(Math.round(pcard.x), Math.round(pcard.y));
    let after = before;
    for (let i = 0; i < 6 && after === before; i++) { await frames(2); after = (await state()).charId; }
    check('clicking an off-field portrait switches to that character', after === pcard.id,
      `${before} → ${after} (clicked slot ${pcard.slot}, ${pcard.id})`);
  }
  const skillBox = await p.evaluate(() => {
    const el = document.querySelector('[data-act="skill"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!skillBox) skipped('clicking the skill icon casts the skill', 'no [data-act="skill"] in the HUD');
  else {
    const cd0 = await p.evaluate(() => window.game.me.skillCd);
    await p.mouse.click(Math.round(skillBox.x), Math.round(skillBox.y));
    await frames(6);
    const cd1 = await p.evaluate(() => window.game.me.skillCd);
    check('clicking the skill icon casts the elemental skill', cd1 > cd0 || cd1 > 0,
      `skill cooldown ${cd0.toFixed(1)} → ${cd1.toFixed(1)} s`);
  }
  await shot('hud-clicks');

  /* ------------------------------------------------------------------ the frame -- */
  console.log('');
  console.log(`errors -> ${errors.length ? errors.slice(0, 4).join(' | ') : 'none'}`);
  console.log(`hmr    -> ${hmr.length ? hmr.slice(0, 2).join(' | ') : 'none'}`);
  check('no page errors while the pointer was driven', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('client/src was not hot-updated mid-run', hmr.length === 0, `${hmr.length} HMR events`);
} catch (e) {
  fail++;
  console.log(`  FAIL probe threw — ${e.message}`);
  await shot('crash').catch(() => {});
} finally {
  await b.close();
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
console.log(`shots -> ${outDir}`);
process.exit(fail ? 1 : 0);
