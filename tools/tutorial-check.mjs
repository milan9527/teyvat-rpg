// 新手引导 probe: is the guide wired to outcomes, does it advance from real input, and does
// the progress survive a reload?
//
//   DISPLAY=:99 node tools/tutorial-check.mjs [baseUrl] [outDir]
//
// The feature it checks exists because the game had no onboarding at all: every control was
// reachable and none of it was findable, and the only text naming a key was one line of prose
// in the settings panel that never mentioned the mouse — in a game whose primary control
// scheme *is* the mouse. So this probe cares about three separate things, and a green on one
// says nothing about the others:
//
//   1. **The vocabulary is closed, both ways.** Every step in the shared list is marked
//      somewhere in the client, and every `mark(…)` in the client names a step that exists. A
//      step nobody can complete is a guide that never ends; a mark for a deleted step is a
//      typo that fails silently. Same gate the audio cues and the effect keys in this repo
//      already have, for the same reason.
//   2. **Steps complete on outcomes, not keypresses.** Asserted structurally (no `mark` in
//      `_handleKeys`; skill/burst/dash marked from the LocalPlayer's success-only events) and
//      then behaviourally: a burst with no energy must *not* advance the guide, and the same
//      call with energy must. That negative is the whole point — pressing Q on empty energy
//      teaches the player nothing, so a guide that ticks the step off is lying to them.
//   3. **It is on screen.** The card is measured in pixels with the canvas hidden, against
//      the same rect with the card hidden as the control, because a `.show` class passes on a
//      card painted in the background colour. And `elementFromPoint` over the card must find
//      the canvas, not the card: the guide sits on the left edge for a whole session, and a
//      card that eats click-to-move orders would break the control it is teaching.
//
// The browser half plays as a guest, so nothing here spends the register rate limit, and the
// reload leg re-enters through 继续冒险 with the same token — which is what makes it a real
// round trip through Postgres rather than a read of the tab's own memory.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';
import { TUTORIAL_STEPS, TUTORIAL_IDS, tutorialView } from '../shared/src/data/tutorial.js';
import {
  KEYMAP, ACTION_INFO, MOUSE_CONTROLS, PANEL_ACTIONS, keyGlyph, controlGroups,
} from '../client/src/game/input.js';
import { decodePng } from './lib/png.mjs';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/tutorial-check';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0, skip = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}
function note(name, why) { skip++; console.log(`  SKIP ${name} — ${why}`); }

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const code = {
  game: read('client/src/game/game.js'),
  panels: read('client/src/ui/panels.js'),
  tutorial: read('client/src/game/tutorial.js'),
  hud: read('client/src/ui/hud.js'),
  css: read('client/src/ui/style.css'),
  input: read('client/src/game/input.js'),
};

/** Every id named by a `mark(...)` call in `src`, ternaries included. */
function marksIn(src) {
  const out = [];
  for (const m of src.matchAll(/\.mark\(([^)]*)\)/g)) {
    for (const s of m[1].matchAll(/'([A-Za-z]+)'/g)) out.push(s[1]);
  }
  return out;
}
/** The body of a method, from its signature to the matching brace at method indentation. */
function bodyOf(src, signature) {
  const i = src.indexOf(signature);
  if (i < 0) return '';
  const end = src.indexOf('\n  }', i);
  return end < 0 ? '' : src.slice(i, end);
}

/* ===================================================== 1. the step vocabulary ==== */

console.log('--- 1. the steps, and who marks them');

const marks = {
  game: marksIn(code.game),
  panels: marksIn(code.panels),
  tutorial: marksIn(code.tutorial),
  hud: marksIn(code.hud),
};
const marked = [...new Set(Object.values(marks).flat())];
// A scan that matched nothing would make every "every id is marked" test below vacuous in
// one direction and trivially true in the other. Pin the scan itself first.
check('the scan found mark() calls to reason about', marked.length > 0 && Object.values(marks).flat().length >= TUTORIAL_IDS.length,
  `${Object.values(marks).flat().length} calls naming ${marked.length} ids across ${Object.entries(marks).filter(([, v]) => v.length).map(([k]) => k).join(', ')}`);

check('every step in the shared list is marked somewhere in the client',
  TUTORIAL_IDS.every((id) => marked.includes(id)),
  TUTORIAL_IDS.filter((id) => !marked.includes(id)).join(' ') || `all ${TUTORIAL_IDS.length}`);
check('...and every mark() names a step that exists',
  marked.every((id) => TUTORIAL_IDS.includes(id)),
  marked.filter((id) => !TUTORIAL_IDS.includes(id)).join(' ') || 'no strays');

check('every step has a title and a hint', TUTORIAL_STEPS.every((s) => s.title?.length > 1 && s.hint?.length > 8),
  TUTORIAL_STEPS.filter((s) => !(s.hint?.length > 8)).map((s) => s.id).join(' ') || `${TUTORIAL_STEPS.length} steps`);
check('...and says how to do it, with keys or with the mouse',
  TUTORIAL_STEPS.every((s) => (s.keys?.length || 0) + (s.mouse ? 1 : 0) > 0),
  TUTORIAL_STEPS.filter((s) => !s.keys?.length && !s.mouse).map((s) => s.id).join(' ') || 'all teachable');
check('...and the ids are unique', new Set(TUTORIAL_IDS).size === TUTORIAL_IDS.length, TUTORIAL_IDS.join(' '));

// The goal for this game names 鼠标点击 explicitly, and mouse-only play is the thing a
// keyboard-shaped tutorial would silently drop.
const mouseSteps = TUTORIAL_STEPS.filter((s) => s.mouse);
check('the guide teaches the mouse, not just the keyboard', mouseSteps.length >= 3,
  `${mouseSteps.length} steps with a mouse gesture: ${mouseSteps.map((s) => s.id).join(' ')}`);
check('...including walking and attacking by clicking',
  ['clickMove', 'attack'].every((id) => TUTORIAL_STEPS.find((s) => s.id === id)?.mouse),
  TUTORIAL_STEPS.filter((s) => s.mouse).map((s) => `${s.id}:${s.mouse}`).join(' | '));

// Every key glyph the card prints has to be a key the game actually binds. A guide is a
// promise about the keymap, and this is the only thing that keeps the two honest.
const boundGlyphs = new Set(Object.values(KEYMAP).flat().map(keyGlyph));
const promised = TUTORIAL_STEPS.flatMap((s) => (s.keys || []).map((k) => [s.id, k]));
check('every key the guide prints is really bound', promised.every(([, k]) => boundGlyphs.has(k)),
  promised.filter(([, k]) => !boundGlyphs.has(k)).map(([id, k]) => `${id}:${k}`).join(' ')
  || `${promised.length} glyphs, all in KEYMAP`);

/* ------------------------------------------- marked from outcomes, not keypresses -- */

const handleKeys = bodyOf(code.game, '_handleKeys(dt) {');
const bindLocal = bodyOf(code.game, '_bindLocal() {');
check('the key handler was found, so the next test can fail', handleKeys.includes("justPressed('skill')"),
  `${handleKeys.split('\n').length} lines`);
check('no step is marked from the key handler', !/tutorial\.mark\(/.test(handleKeys),
  handleKeys.split('\n').filter((l) => l.includes('mark(')).join(' ') || 'none — presses do not count');
check('skill / burst / dash are marked from the LocalPlayer events that mean it happened',
  ['skill', 'burst', 'dash'].every((id) => bindLocal.includes(`mark('${id}')`)),
  ['skill', 'burst', 'dash'].filter((id) => !bindLocal.includes(`mark('${id}')`)).join(' ') || 'all three');
check('...and attack is marked from the swing, not from the click',
  bindLocal.includes("mark('attack')") && !/mark\('attack'\)/.test(bodyOf(code.game, '_leftClick(c) {')),
  'swing event only');
check('the panel steps are marked where a panel actually opens', /mark\(name === 'map' \? 'map' : 'panel'\)/.test(code.panels),
  'panels.open()');

/* ------------------------------------------------------ the HUD is the consumer -- */

check('the HUD subscribes to the tutorial event', /g\.on\('tutorial'/.test(code.hud), "g.on('tutorial', …)");
check('...and draws a card for it', /setGuide\(/.test(code.hud) && /data-f="guide"/.test(code.hud), 'setGuide + [data-f=guide]');
check('...and the card has styling that can show it', /\.guide\.show/.test(code.css) && /\.guide \.gk\.mouse/.test(code.css),
  '.guide.show, .guide .gk.mouse');
check('progress is persisted through the settings document', /settings\.tutorial/.test(code.tutorial) && /api\.save/.test(code.tutorial),
  'players.settings.tutorial');

/* ================================================= 2. tutorialView, the state ==== */

console.log('\n--- 2. tutorialView derives the card');

const v0 = tutorialView({});
check('a new player is shown the first step', v0.step?.id === TUTORIAL_IDS[0] && v0.at === 1 && !v0.complete,
  `${v0.step?.id} ${v0.at}/${v0.total}`);
const v1 = tutorialView({ done: [TUTORIAL_IDS[0], TUTORIAL_IDS[1]] });
check('...and the next unfinished one after that', v1.step?.id === TUTORIAL_IDS[2] && v1.at === 3,
  `${v1.step?.id} ${v1.at}/${v1.total}`);
// Out of order on purpose: a player who dashes before the guide asks must not be shown a
// step they already did.
const v2 = tutorialView({ done: [TUTORIAL_IDS[3]] });
check('a step done early stays done', !v2.step || v2.step.id !== TUTORIAL_IDS[3],
  `showing ${v2.step?.id}, done ${v2.done.join(' ')}`);
const vAll = tutorialView({ done: [...TUTORIAL_IDS] });
check('finishing every step ends the guide', vAll.step === null && vAll.complete === true && vAll.done.length === TUTORIAL_IDS.length,
  `complete=${vAll.complete}`);
const vSkip = tutorialView({ done: [TUTORIAL_IDS[0]], skipped: true });
check('跳过 ends it too, without claiming completion',
  vSkip.step === null && vSkip.skipped === true && vSkip.complete === false, 'step null, complete false');
const vJunk = tutorialView({ done: ['move', 'thisStepWasDeleted', 42, null] });
check('ids the list no longer has are dropped, so the count cannot exceed the total',
  vJunk.done.length === 1 && vJunk.done[0] === 'move' && vJunk.at === 2,
  `done ${JSON.stringify(vJunk.done)} at ${vJunk.at}/${vJunk.total}`);
check('a garbage state does not throw', (() => {
  try { tutorialView(null); tutorialView({ done: 'move' }); return true; } catch { return false; }
})(), 'null and a string are both survivable');

/* ============================================== 3. the control reference table ==== */

console.log('\n--- 3. 操作说明 is derived from the keymap');

const infoKeys = Object.keys(ACTION_INFO).sort();
const mapKeys = Object.keys(KEYMAP).sort();
check('every bound action is described', mapKeys.every((a) => ACTION_INFO[a]),
  mapKeys.filter((a) => !ACTION_INFO[a]).join(' ') || `${mapKeys.length} actions`);
check('...and every description belongs to a bound action', infoKeys.every((a) => KEYMAP[a]),
  infoKeys.filter((a) => !KEYMAP[a]).join(' ') || 'no orphans');
const groups = controlGroups();
check('the table is grouped, and the mouse is one of the groups',
  groups.length >= 3 && groups.some((g) => g.group === '鼠标'),
  groups.map((g) => `${g.group}(${g.rows.length})`).join(' '));
check('...and the mouse group covers walking, attacking and the camera',
  MOUSE_CONTROLS.length >= 6 && MOUSE_CONTROLS.some((r) => r.keys[0].includes('地面'))
  && MOUSE_CONTROLS.some((r) => r.keys[0].includes('敌人')) && MOUSE_CONTROLS.some((r) => r.what.includes('镜头')),
  `${MOUSE_CONTROLS.length} gestures`);
check('every row has at least one glyph and a description',
  groups.every((g) => g.rows.every((r) => r.keys.length >= 1 && r.what?.length > 1)),
  `${groups.reduce((n, g) => n + g.rows.length, 0)} rows`);
// ShiftLeft and ShiftRight are one key to a player; a table printing both would be noise.
const sprint = groups.flatMap((g) => g.rows).find((r) => r.what.includes('冲刺'));
check('duplicate glyphs are collapsed', sprint?.keys.length === 1 && sprint.keys[0] === 'Shift',
  JSON.stringify(sprint?.keys));
// A key bound to a panel is only real if something opens that panel. `game.js` used to repeat one
// `if (justPressed(…))` line per panel — a fourth list to edit, and the one whose omission is
// invisible: the settings table would advertise G and nothing would happen. It is now a loop over
// `PANEL_ACTIONS`, so the gate is that the derivation is non-empty, every name in it is a real
// binding described as 界面, and the three 界面 actions that are *not* panels stay out of it.
check('every panel key is dispatched by the derived loop',
  PANEL_ACTIONS.length >= 12 && PANEL_ACTIONS.every((a) => KEYMAP[a] && ACTION_INFO[a]?.group === '界面'),
  `${PANEL_ACTIONS.length}: ${PANEL_ACTIONS.join(' ')}`);
check('...and chat / emote / 设置 are not treated as panels of their own',
  ['chat', 'emote', 'settings'].every((a) => !PANEL_ACTIONS.includes(a)),
  PANEL_ACTIONS.filter((a) => ['chat', 'emote', 'settings'].includes(a)).join(' ') || 'none of the three');
check('...and game.js loops over it instead of listing panels one by one',
  /for \(const action of PANEL_ACTIONS\)/.test(code.game)
  && (code.game.match(/justPressed\('(map|mail|achievements)'\)/g) || []).length === 0,
  'game.js:_handlePanelKeys');
check('the panel prints the derived table instead of prose', /controlGroups\(\)/.test(code.panels)
  && !/键位：WASD/.test(code.panels), 'panels.js renders .keyref');
check('...and the glyph function is not the identity', keyGlyph('KeyW') === 'W' && keyGlyph('Space') === '空格'
  && keyGlyph('Digit3') === '3' && keyGlyph('ArrowUp') === '↑',
  'KeyW→W, Space→空格, Digit3→3, ArrowUp→↑');

/* ======================================================== 4. in the browser ==== */

console.log('\n--- 4. the card in a running game');

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
  console.log(`  (shot ${file})`);
  return decodePng(readFileSync(file));
}
/**
 * Wait for `n` rendered frames, not for a wall-clock delay: llvmpipe runs this scene at a few
 * frames a second, and every stale-pixel bug this repo has had came from a probe that slept
 * instead of waiting on the frame counter.
 */
async function frames(n = 3) {
  const from = await p.evaluate(() => window.__probeFrames || 0);
  for (let i = 0; i < 400; i++) {
    const now = await p.evaluate(() => window.__probeFrames || 0);
    if (now - from >= n) return now - from;
    await sleep(120);
  }
  return -1;
}
const guide = () => p.evaluate(() => {
  const el = document.querySelector('[data-f="guide"]');
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const one = (sel) => {
    const n = el.querySelector(sel);
    if (!n) return null;
    const rb = n.getBoundingClientRect();
    return {
      text: n.textContent.trim(), color: getComputedStyle(n).color,
      rect: { x: Math.round(rb.x), y: Math.round(rb.y), w: Math.round(rb.width), h: Math.round(rb.height) },
    };
  };
  return {
    shown: cs.display !== 'none',
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    title: one('[data-f="guidetitle"]'),
    hint: one('[data-f="guidehint"]'),
    n: one('[data-f="guiden"]'),
    keys: [...el.querySelectorAll('.gk')].map((k) => ({ t: k.textContent, mouse: k.classList.contains('mouse') })),
    barWidth: el.querySelector('[data-f="guidebar"]')?.getBoundingClientRect().width || 0,
    view: window.game?.tutorial?.view?.() ? (() => {
      const v = window.game.tutorial.view();
      return { id: v.step?.id || null, at: v.at, total: v.total, done: v.done, complete: v.complete, skipped: v.skipped };
    })() : null,
  };
});
/** Wait until the guide is showing `id` (or is gone, for `null`). */
async function waitStep(id) {
  for (let i = 0; i < 60; i++) {
    const g = await guide();
    if ((g?.view?.id || null) === id) return g;
    await sleep(250);
  }
  return guide();
}
/** Wait until `id` is recorded as done. */
async function waitDone(id) {
  for (let i = 0; i < 60; i++) {
    const g = await guide();
    if (g?.view?.done.includes(id)) return g;
    await sleep(250);
  }
  return guide();
}
/**
 * "That action finished that step, and the card is now showing the right one."
 *
 * The expected next step is *derived* from what is done rather than written out per call:
 * some actions finish more than one step (opening a chest can open a panel), and a probe with
 * a hand-written chain of next-ids would go red on a correct game the first time that
 * happened. The claim being made is the one that matters — the card always shows the first
 * unfinished step.
 */
async function expectDone(label, id) {
  const g = await waitDone(id);
  const want = TUTORIAL_IDS.find((x) => !g.view.done.includes(x)) || null;
  check(label, g.view.done.includes(id) && (g.view.id || null) === want,
    `done ${g.view.done.length}/${g.view.total}${g.view.done.includes(id) ? '' : ` — ${id} MISSING`}, card shows ${g.view.id || 'nothing'} (want ${want || 'nothing'})`);
  return g;
}
/** The mean colour of the brightest slice of a rect — a card's ink plus its wash. */
function ink(img, r, frac = 0.2) {
  const px = [];
  for (let y = Math.max(0, r.y); y < Math.min(img.height, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(img.width, r.x + r.w); x++) {
      const i = (y * img.width + x) * 4, d = img.data;
      px.push([d[i], d[i + 1], d[i + 2], 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]]);
    }
  }
  if (!px.length) return { rgb: [0, 0, 0], lum: 0 };
  px.sort((a, c) => c[3] - a[3]);
  const top = px.slice(0, Math.max(1, Math.round(px.length * frac)));
  const mean = (k) => Math.round(top.reduce((a, v) => a + v[k], 0) / top.length);
  return { rgb: [mean(0), mean(1), mean(2)], lum: Math.round(top.reduce((a, v) => a + v[3], 0) / top.length) };
}
const warm = (rgb) => rgb[0] - rgb[2] > 15 && rgb[1] > rgb[2];
const setCanvasVisible = (v) => p.evaluate((vis) => {
  const c = document.querySelector('canvas');
  if (c) c.style.visibility = vis ? '' : 'hidden';
}, v);

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  // Guest, so the probe never spends the register rate limit — and the token is kept by the
  // profile, which is what makes the reload leg below re-enter the *same* account.
  await (await p.$('[data-act="solo"]')).click();
  await sleep(400);
  const enter = await p.$('[data-act="guest"]') || await p.$('[data-act="resume"]');
  await enter.click();
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  check('the solo world booted', await p.evaluate(() => !!window.game?._running && !!window.game?.playerId));
  // A frame counter of our own: the probe needs "the game rendered again", and nothing in the
  // client counts frames.
  await p.evaluate(() => {
    window.__probeFrames = 0;
    window.game.on('frame', () => { window.__probeFrames++; });
  });
  // llvmpipe boots every probe at `low`; pin the tier so the pixels below are a frame the
  // target hardware actually shows.
  await p.evaluate(() => {
    window.game.setAutoQuality(false);
    window.game.setQuality('high');
    // Noon, pinned: see daylight-check.mjs — the authored sky is what 12:00 returns.
    window.game.setWorldTime(12);
  });
  await sleep(2500);
  check('the quality tier is pinned to high', await p.evaluate(() => window.game.quality) === 'high');
  const advanced = await frames(4);
  check('the game is rendering, so a stale frame cannot pass for a fresh one', advanced >= 4,
    `${advanced} frames`);

  // A guest is brand new, but the browser profile is reused within a run — reset so the
  // sequence below starts from step 1 whatever happened before.
  await p.evaluate(() => window.game.tutorial.reset());
  const g0 = await waitStep(TUTORIAL_IDS[0]);
  check('a new player sees the first step', g0.shown === true && g0.view.id === TUTORIAL_IDS[0],
    `${g0.title?.text} ${g0.n?.text}`);
  check('...with the step text from the shared list, not the panel',
    g0.title.text === TUTORIAL_STEPS[0].title && g0.hint.text === TUTORIAL_STEPS[0].hint,
    g0.hint.text);
  check('...and its keys as key caps', g0.keys.map((k) => k.t).join('') === (TUTORIAL_STEPS[0].keys || []).join(''),
    g0.keys.map((k) => `${k.t}${k.mouse ? '(mouse)' : ''}`).join(' '));
  check('...and the progress bar starts empty', g0.barWidth < 2, `${Math.round(g0.barWidth)}px`);

  /* ------------------------------------------------------- the card in pixels -- */
  await setCanvasVisible(false);
  await frames(2);
  const imgOn = await shot('guide-step1');
  const titleRect = g0.title.rect;
  const inkOn = ink(imgOn, titleRect, 0.25);
  check('the card is a real block of screen, not a collapsed div',
    g0.rect.w > 180 && g0.rect.h > 80 && g0.rect.x >= 0 && g0.rect.y > 0,
    `${g0.rect.w}×${g0.rect.h} at ${g0.rect.x},${g0.rect.y}`);
  check('its title is painted gold', warm(inkOn.rgb), `rgb ${inkOn.rgb.join(',')} lum ${inkOn.lum}`);
  // The control that must move: the same rect with the card hidden. Without it, "gold" could
  // be describing whatever was behind the card.
  await p.evaluate(() => { document.querySelector('[data-f="guide"]').style.visibility = 'hidden'; });
  await frames(2);
  const imgOff = await shot('guide-hidden');
  const inkOff = ink(imgOff, titleRect, 0.25);
  check('...and hiding the card changes those pixels', Math.abs(inkOn.lum - inkOff.lum) > 20 || !warm(inkOff.rgb),
    `on lum ${inkOn.lum} rgb ${inkOn.rgb.join(',')} / off lum ${inkOff.lum} rgb ${inkOff.rgb.join(',')}`);
  await p.evaluate(() => { document.querySelector('[data-f="guide"]').style.visibility = ''; });
  await setCanvasVisible(true);
  await frames(2);

  // The card lives on screen for a whole session, over the ground the player clicks to walk.
  const hits = await p.evaluate(() => {
    const el = document.querySelector('[data-f="guide"]');
    const r = el.getBoundingClientRect();
    const mid = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height * 0.35));
    const btn = el.querySelector('.gskip').getBoundingClientRect();
    const onBtn = document.elementFromPoint(Math.round(btn.x + btn.width / 2), Math.round(btn.y + btn.height / 2));
    return { mid: mid?.tagName?.toLowerCase() || null, btn: onBtn?.className || null };
  });
  check('a click through the card reaches the world, not the card', hits.mid === 'canvas', `elementFromPoint → ${hits.mid}`);
  check('...but the 跳过 button is still clickable', /gskip/.test(hits.btn || ''), `elementFromPoint → ${hits.btn}`);

  /* ------------------------------------------- real input, one step at a time -- */
  console.log('\n  · 移动 / 视角 / 点地面 — driven as a player drives them');

  const from0 = await p.evaluate(() => ({ x: window.game.me.x, z: window.game.me.z }));
  // Held for *frames*, not for seconds. The frame loop clamps `dt` to 50 ms, so on llvmpipe
  // at three frames a second one wall second advances the simulation by 150 ms — a two-second
  // hold walks 40 cm and the first run of this probe went red on exactly that. Walking 4 m at
  // ~5 m/s needs ~16 simulated frames whatever the frame rate is.
  await p.keyboard.down('KeyW');
  await frames(30);
  await p.keyboard.up('KeyW');
  const from1 = await p.evaluate(() => ({ x: window.game.me.x, z: window.game.me.z }));
  check('holding W moved the character', Math.hypot(from1.x - from0.x, from1.z - from0.z) > 3,
    `${Math.hypot(from1.x - from0.x, from1.z - from0.z).toFixed(1)} m`);
  const gLook = await expectDone('walking with WASD finishes 先走两步', 'move');
  check('...and the card moved on to the next step text', gLook.title.text === TUTORIAL_STEPS[1].title,
    `${gLook.title.text} ${gLook.n?.text}`);
  check('...and the progress bar grew', gLook.barWidth > 2, `${Math.round(gLook.barWidth)}px`);
  check('...and the mouse step prints a phrase, not a key cap',
    gLook.keys.length === 1 && gLook.keys[0].mouse === true, gLook.keys.map((k) => k.t).join(' '));

  // A right-button drag is what orbits the camera (left click is a world click).
  const yaw0 = await p.evaluate(() => window.game.rig.yaw);
  await p.mouse.move(W / 2, H / 2);
  await p.mouse.down({ button: 'right' });
  for (let i = 1; i <= 12; i++) await p.mouse.move(W / 2 + i * 30, H / 2);
  await p.mouse.up({ button: 'right' });
  await frames(3);
  const yaw1 = await p.evaluate(() => window.game.rig.yaw);
  check('the drag actually turned the camera', Math.abs(yaw1 - yaw0) > 0.2, `yaw ${yaw0.toFixed(2)} → ${yaw1.toFixed(2)}`);
  await expectDone('...and that finishes 转一圈看看', 'look');

  // A left click on the ground, well away from the HUD, is 点哪走哪.
  await p.mouse.click(Math.round(W * 0.62), Math.round(H * 0.72));
  await expectDone('clicking the ground finishes 点哪走哪', 'clickMove');
  const goal = await p.evaluate(() => !!window.game.me.goal || window.game.me.goalKind);
  check('...and the click really issued a walk order', !!goal, `goal ${JSON.stringify(goal)}`);

  /* ------------------------------------ outcomes, including one that must not -- */
  console.log('\n  · 战斗: the steps that only count when the move happens');
  // The call `_leftClick` makes when the cursor is over an enemy; there is no enemy in reach
  // of the spawn, so it is made directly rather than faked with a mark().
  await p.evaluate(() => window.game.me.attack(window.game.actors));
  await expectDone('a swing finishes 打一下试试', 'attack');
  await p.evaluate(() => window.game.me.useSkill(window.game.actors));
  await expectDone('a cast finishes 元素战技', 'skill');

  // The negative that gives the whole design its meaning: a burst with no energy is refused
  // by LocalPlayer, so the guide must not advance — and the next step must still be 换人.
  const empty = await p.evaluate(() => {
    window.game.me.energy = 0;
    return window.game.me.useBurst(window.game.actors);
  });
  check('a burst with no energy is refused', empty === false, `useBurst → ${empty}`);
  const still = await guide();
  check('...and a refused move does not advance the guide', !still.view.done.includes('burst'),
    `showing ${still.view.id}, done ${still.view.done.join(' ')}`);

  const switched = await p.evaluate(() => {
    const g = window.game;
    if (g.party.length < 2) return { ok: false, why: `party of ${g.party.length}` };
    const to = (g.activeSlot + 1) % g.party.length;
    const card = document.querySelector(`.pcard[data-slot="${to}"]`);
    if (card) { card.click(); return { ok: true, how: 'clicked the portrait', to }; }
    g.switchTo(to);
    return { ok: true, how: 'switchTo', to };
  });
  if (switched.ok) {
    await expectDone(`switching characters finishes 换人打反应 (${switched.how})`, 'switch');
  } else {
    note('换人打反应', `a guest starts with ${switched.why} — nothing to switch to`);
    await p.evaluate(() => window.game.tutorial.mark('switch'));
  }

  // C, the key, rather than `me.dash()` — and retried, because a dash is refused while the
  // character is rooted by the cast just before it and that root runs on *simulated* time.
  let dashState = null;
  for (let i = 0; i < 6; i++) {
    dashState = await p.evaluate(() => {
      const me = window.game.me;
      return { rooted: +me.rooted.toFixed(2), stamina: Math.round(me.stamina), swimming: !!me.swimming, alive: me.alive };
    });
    await p.keyboard.press('KeyC');
    await frames(3);
    if ((await guide()).view.done.includes('dash')) break;
  }
  await expectDone(`pressing C finishes 冲刺闪避 (last try: ${JSON.stringify(dashState)})`, 'dash');
  const burst = await p.evaluate(() => {
    const me = window.game.me;
    me.energy = me.energyMax;
    me.burstCd = 0;
    return me.useBurst(window.game.actors);
  });
  if (burst) {
    await expectDone('...and a burst with full energy does finish 元素爆发', 'burst');
  } else {
    note('元素爆发', 'useBurst refused even at full energy — cannot drive the step');
    await p.evaluate(() => window.game.tutorial.mark('burst'));
    await waitDone('burst');
  }

  // Interact: walk the player onto the nearest interactable and press F, the way the prompt
  // tells them to. Teleporting there is fine — the step is about the interaction.
  // `nearestInteractable` only looks inside each entry's own prompt radius, so it is null from
  // anywhere the player is not already standing — the zone's own list is what has to be
  // searched to find something to walk to.
  const inter = await p.evaluate(() => {
    const g = window.game;
    const list = (g.world.interactables || []).filter((it) => !(it.type === 'gather' && (it.done || !it.prop)));
    if (!list.length) return null;
    let best = list[0], bd = Infinity;
    for (const it of list) {
      const d = Math.hypot(it.x - g.me.x, it.z - g.me.z);
      if (d < bd) { bd = d; best = it; }
    }
    g.me.x = best.x + 1.0;
    g.me.z = best.z + 1.0;
    g.me.y = best.y ?? g.me.y;
    g.me.clearGoal();
    return { type: best.type, id: best.id, was: Math.round(bd) };
  });
  if (inter) {
    await frames(3);
    await p.keyboard.press('KeyF');
    await expectDone(`pressing F on a ${inter.type} finishes 伸手拿东西`, 'interact');
  } else {
    note('伸手拿东西', 'no interactable in this zone to walk to');
    await p.evaluate(() => window.game.tutorial.mark('interact'));
    await waitDone('interact');
  }

  console.log('\n  · 界面: the last two steps, opened with their own keys');
  await p.keyboard.press('KeyB');            // 背包
  await sleep(900);
  await expectDone('opening the bag with B finishes 打开一个面板', 'panel');
  await p.keyboard.press('Escape');          // close the bag
  await sleep(500);
  await p.keyboard.press('KeyM');            // 大地图
  await sleep(900);
  await expectDone('opening the map with M finishes 地图与传送', 'map');

  // Steps this probe structurally cannot perform where the character stands, each owed to the
  // probe that *does* perform it. `climb` is the case that forced the table: the nearest face
  // steep enough to climb is ~200 m from the 蒙德 spawn (the zone has 1520 climbable cells and
  // none within 70 m of spawn), so driving it here would mean a zone transit and a 30 s hold —
  // which `motion-check.mjs` already does, with the real key on a real cliff. Marking it directly
  // is an exemption, so it has to carry an obligation: the id must be named here, the probe that
  // covers it must exist, and that probe must mention the id. Anything unfinished and *not* in
  // this table is a step the guide can never complete, which is the defect a fresh player hits.
  const OFF_PATH = {
    climb: 'motion-check.mjs — holds W into a 0.807 face and asserts the climb event fires',
  };
  const gBefore = await guide();
  const left = TUTORIAL_IDS.filter((id) => !gBefore.view.done.includes(id));
  check('every step the guide still wants is either drivable here or owed to a named probe',
    left.every((id) => OFF_PATH[id]), left.filter((id) => !OFF_PATH[id]).join(' ') || `${left.length} left`);
  check('...and the exemption table has no stale entries',
    Object.keys(OFF_PATH).every((id) => TUTORIAL_IDS.includes(id)),
    Object.keys(OFF_PATH).filter((id) => !TUTORIAL_IDS.includes(id)).join(' ') || 'no strays');
  for (const id of left) {
    const owed = OFF_PATH[id];
    const file = owed?.split(' ')[0];
    let covered = false;
    try { covered = read(`tools/${file}`).includes(id); } catch { covered = false; }
    check(`the probe owed for '${id}' exists and drives it — ${owed}`, covered, `tools/${file}`);
    note(`${id} in this probe`, `driven by ${owed}`);
    await p.evaluate((x) => window.game.tutorial.mark(x), id);
    await waitDone(id);
  }
  const gEnd = await guide();
  check('with every step done the guide is finished', gEnd.view.complete === true && gEnd.view.id === null,
    `complete=${gEnd.view.complete}, done ${gEnd.view.done.length}/${gEnd.view.total}`);
  check('...and the card is gone', gEnd.shown === false, `display shown=${gEnd.shown}`);
  await p.keyboard.press('Escape');
  await sleep(500);

  /* ------------------------------------------------ it survived a round trip -- */
  console.log('\n  · the progress is in the database, not in the tab');
  await p.evaluate(() => window.game.tutorial.flush());
  await sleep(1200);
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  const resumed = await p.$('[data-act="resume"]') || await p.$('[data-act="guest"]');
  await resumed.click();
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  const after = await guide();
  check('after a reload the guide is still finished',
    after?.view?.complete === true && after.view.done.length === TUTORIAL_IDS.length,
    `done ${after?.view?.done.length}/${TUTORIAL_IDS.length}, complete=${after?.view?.complete}`);
  check('...and the card stays hidden', after.shown === false, `shown=${after.shown}`);

  /* ------------------------------------------------------- 跳过 and 重新引导 -- */
  console.log('\n  · the two controls a player has over the guide');
  await p.evaluate(() => window.game.tutorial.reset());
  const back = await waitStep(TUTORIAL_IDS[0]);
  check('重新引导 (reset) brings the card back at step 1', back.shown === true && back.view.at === 1,
    `${back.view.id} ${back.n?.text}`);
  const clicked = await p.evaluate(() => {
    const btn = document.querySelector('[data-f="guide"] .gskip');
    if (!btn) return false;
    btn.click();
    return true;
  });
  check('the 跳过 button exists and can be clicked', clicked === true);
  const skipped = await waitStep(null);
  check('...and skipping hides the card without claiming completion',
    skipped.shown === false && skipped.view.skipped === true && skipped.view.complete === false,
    `shown=${skipped.shown} skipped=${skipped.view.skipped} complete=${skipped.view.complete}`);

  // And the settings panel is the way back: it reports the state and offers the replay.
  await p.evaluate(() => window.game.emit('togglePanel', { panel: 'settings', open: true }));
  await sleep(800);
  const row = await p.evaluate(() => {
    const btn = document.querySelector('[data-act="guide-replay"]');
    if (!btn) return null;
    const setting = btn.closest('.setting');
    const table = document.querySelector('.keyref');
    return {
      label: setting?.querySelector('label')?.firstChild?.textContent?.trim() || '',
      hint: setting?.querySelector('small')?.textContent || '',
      btn: btn.textContent,
      caps: table ? [...table.querySelectorAll('.kcap')].map((k) => k.textContent) : [],
      words: table ? [...table.querySelectorAll('.kcap.word')].map((k) => k.textContent) : [],
      groups: table ? [...table.querySelectorAll('.kgroup')].map((k) => k.textContent) : [],
      tableRect: table ? Math.round(table.getBoundingClientRect().height) : 0,
    };
  });
  check('the settings panel has a 新手引导 row that says where the player is',
    !!row && row.label.includes('新手引导') && row.hint.includes('跳过'),
    row ? `${row.label} — ${row.hint} [${row.btn}]` : 'no row');
  check('...and prints the whole control reference, keys and mouse',
    row.groups.includes('鼠标') && row.caps.includes('W') && row.caps.includes('Esc')
    && row.words.some((w) => w.includes('地面')) && row.tableRect > 200,
    `${row.groups.join('/')} · ${row.caps.length} caps, ${row.words.length} gestures, ${row.tableRect}px tall`);
  // The phrase pill is for gestures only: 空格 is a key cap, and one round of this probe had it
  // styled as a mouse gesture because the class was chosen by testing the glyph for CJK.
  check('...and every phrase pill is a mouse gesture, not a key',
    row.words.length === MOUSE_CONTROLS.length && row.caps.includes('空格'),
    `${row.words.length} pills for ${MOUSE_CONTROLS.length} gestures: ${row.words.join(' ')}`);
  const replayed = await p.evaluate(() => {
    document.querySelector('[data-act="guide-replay"]').click();
    return true;
  });
  await sleep(900);
  const again = await waitStep(TUTORIAL_IDS[0]);
  check('...and 重新引导 restarts it from the first step',
    replayed && again.shown === true && again.view.at === 1 && again.view.skipped === false,
    `${again.view.id} ${again.n?.text}, skipped=${again.view.skipped}`);

  const shots = await guide();
  await shot('guide-restarted');
  check('no page errors through any of it', !errors.length, errors.slice(0, 3).join(' | ') || `card at ${shots.rect.x},${shots.rect.y}`);
} catch (e) {
  fail++;
  console.log(`  FAIL probe threw — ${e?.stack || e}`);
} finally {
  await b.close();
}

console.log(`\ntutorial-check: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail);
