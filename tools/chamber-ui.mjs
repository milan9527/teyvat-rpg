// 秘境呈现层 probe: does a player ever *see* the waves and the ley-line disorder?
//
//   DISPLAY=:99 node tools/chamber-ui.mjs [baseUrl] [outDir]
//
// `chamber-check.mjs` proves the simulation half — the breather between waves, and each
// disorder field measured against a control that must not move. It cannot prove the half
// that decides whether any of it is *playable*: a floor whose modifier is invisible is a
// floor the player loses to for no stated reason. The three surfaces this drives are the
// opening banner (the one moment before the first swing), the HUD chip (during), and the
// change-of-wave toast.
//
// It plays two floors for real, in 单机 mode where this tab hosts the instance: floor 1
// (no disorder) as the control, then floor 2 (凝霜地脉, 2 waves) — entering the dungeon,
// `startChamber`, and killing each wave through `applyDamageToEnemy` so every hook a real
// kill runs, runs. Writing `game.chamber` by hand does not work and is the reason this
// probe exists in this shape: the snapshot arrives 20 times a second and overwrites it, so
// a hand-written state is on screen for one frame and the probe grades an empty chip.
//
// Incoming damage is switched off for the run, because a level-1 guest cannot live through
// a level-24 floor and `balance-check` is what owns "can it be beaten at parity".
//
// Every assertion has a control that must *not* move: floor 1's chip for the disorder
// line, the line above it for the colour, the toast strip cleared before the wave fires.
// Expected text comes from `ZONES` and `disorderHint` rather than a copy of the wording,
// and the violet is checked in pixels — a `textContent` assertion passes while the line is
// painted in the background colour.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';
import { ZONES } from '../shared/src/data/zones.js';
import { DISORDERS, disorderHint } from '../shared/src/data/disorders.js';
import { decodePng } from './lib/png.mjs';

// Every expected string comes from the data, not from a copy of it: the floor the probe
// plays decides the limit, the enemy counts, the wave count and which disorder to expect,
// and `disorderHint` writes the wording. Retuning a floor must not need a probe edit.
const DZ = 'abyssTrial';                      // the one dungeon open to a fresh guest
const f1 = ZONES[DZ].chambers[0];             // deliberately has no disorder
const f2 = ZONES[DZ].chambers.find((c) => c.disorder);

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/chamber-ui';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}

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

let logs = [];
const errors = [];
p.on('console', (m) => {
  const line = `[${m.type()}] ${m.text()}`;
  logs.push(line);
  if (m.type() === 'error') errors.push(line);
});
p.on('pageerror', (e) => { const l = `[pageerror] ${e.message}`; logs.push(l); errors.push(l); });

let step = 0;
async function shot(name) {
  step++;
  const file = `${outDir}/${String(step).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file });
  const drained = logs; logs = [];
  console.log(`\n=== ${step}. ${name} → ${file}`);
  if (drained.length) console.log(drained.slice(-8).join('\n'));
  return decodePng(readFileSync(file));
}

/** Wait for the HUD to have run at least two frames, so the latest snapshot is on screen. */
const settle = () => p.evaluate(() => new Promise((r) => {
  requestAnimationFrame(() => requestAnimationFrame(() => r(true)));
}));

/** Everything the HUD chip says, plus the geometry and colour of the disorder line. */
const chip = () => p.evaluate(() => {
  const el = document.querySelector('.chamber');
  if (!el) return null;
  const one = (sel) => {
    const n = el.querySelector(sel);
    if (!n) return null;
    const cs = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    return { text: n.textContent, display: cs.display, color: cs.color,
             rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  };
  return { show: el.classList.contains('show'), clock: one('.clock'), sub: one('.sub'), dis: one('.dis') };
});

/**
 * Every banner raised since the last `clearTransients`, not "the banner on screen now".
 * A banner lives 3.5 s and the next one replaces it: clearing floor 1 raises 挑战成功 and
 * then 冒险等阶 6 right behind it, so a DOM read a second later grades the rank-up.
 */
const banners = () => p.evaluate(() => window.__banners || []);

const toasts = () => p.evaluate(() => [...document.querySelectorAll('.toast')]
  .map((t) => ({ text: t.textContent, cls: [...t.classList].filter((c) => c !== 'toast').join(' ') })));

/**
 * Clear both transient surfaces before each action. `banner()` and `toasts()` read
 * whatever is on screen, and the boot sequence leaves its own banner up for 3.5 s — a
 * find over "everything still visible" answers with the *previous* event.
 */
const clearTransients = () => p.evaluate(() => {
  // Removing the nodes is enough: `Hud.banner` only ever calls `this._banner?.remove()`
  // on its stale reference, which is a no-op once the node is detached. (The Hud itself is
  // not reachable from `window` — `Ui` owns it and only `game` is exported for consoles.)
  document.querySelectorAll('.banner, .toast').forEach((n) => n.remove());
  window.__sfx = [];
  window.__banners = [];
});

/**
 * Dismiss the 挑战奖励 modal the way a player does, by clicking 确定.
 *
 * It matters for more than tidiness: `panels._modal` puts a `.scrim` over the whole screen,
 * which dims the HUD behind it. The first version of this probe measured the disorder line
 * *through* that scrim and read it as grey (85,83,84) — the colour assertion was failing on
 * a line that is violet, because the frame was of a paused, dimmed game.
 */
const closeModal = () => p.evaluate(() => {
  const s = document.querySelector('.scrim');
  if (!s) return 'none';
  const btn = [...s.querySelectorAll('footer button')].find((x) => /确定/.test(x.textContent))
    || s.querySelector('.close');
  btn?.click();
  return document.querySelector('.scrim') ? 'still-open' : 'closed';
});

/** A rect grown by a couple of pixels, so text antialiasing is inside the measured box. */
const pad = (r, label) => ({ x: Math.max(0, r.x - 2), y: Math.max(0, r.y - 2), w: r.w + 4, h: r.h + 4, label });

/** Poll a page-side reader until it answers non-null. Returns null on timeout. */
async function waitFor(what, fn, timeout = 15000, arg = undefined) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const v = await p.evaluate(fn, arg);
    if (v !== null && v !== undefined && v !== false) return v;
    await sleep(200);
  }
  console.log(`  (timed out waiting for ${what})`);
  return null;
}

/**
 * Open the 地图 panel with the key a player presses (`KEYMAP.map` is `KeyM`), not by calling
 * `panels.open`. Pressing it again closes it — the same toggle.
 */
async function pressMap() {
  await p.keyboard.press('KeyM');
  await sleep(350);
  return p.evaluate(() => window.ui?.panels?.name || null);
}

/**
 * The 深境层数 rows as a player sees them: what the title says, whether the row is marked
 * locked, and the colour the title is actually painted in.
 *
 * `data-locked` is the probe's handle, but it is never the evidence on its own — a dataset
 * attribute is exactly the kind of claim that stays true while the pixels say nothing. The
 * computed colour of the row's own `<b>` and the 🔒 in its text are what a player reads.
 */
const floorRows = () => p.evaluate(() => [...document.querySelectorAll('[data-floor]')].map((r) => {
  const bEl = r.querySelector('b');
  const box = (n) => {
    const rc = n.getBoundingClientRect();
    return { x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.width), h: Math.round(rc.height) };
  };
  return {
    floor: Number(r.dataset.floor),
    locked: r.dataset.locked || null,
    title: bEl?.textContent || '',
    hover: r.title || '',
    color: getComputedStyle(bEl || r).color,
    opacity: Number(getComputedStyle(r).opacity),
    rect: box(r),
    bRect: bEl ? box(bEl) : null,
    // Visible *in the column that scrolls*, not merely inside the window. A row clipped by
    // `overflow: auto` still has a real bounding rect, so "inside the viewport" said yes about
    // rows nobody can see — and a click at that y landed outside the panel and closed it.
    // This is also a claim worth asserting: the floor list is the only way into a 秘境, so it
    // has to be reachable without scrolling an unmarked column.
    visible: (() => {
      const box2 = r.closest('.col.side') || r.parentElement;
      const c = box2.getBoundingClientRect(), rc = r.getBoundingClientRect();
      return rc.top >= c.top - 1 && rc.bottom <= c.bottom + 1
        && rc.bottom <= window.innerHeight && rc.top >= 0;
    })(),
  };
}));

/** The live run as the *simulation* holds it — the ids are what a restart would replace. */
const runState = () => p.evaluate(() => {
  const inst = window.game.socket?.inst;
  if (!inst?.chamber) return null;
  return {
    floor: inst.chamber.floor, state: inst.chamber.state, startedAt: inst.chamber.startedAt,
    wave: inst.chamber.wave, ids: [...inst.enemies.keys()].join(','),
  };
});

/** Click a floor row with the real mouse, at the row's own on-screen rect. */
async function clickFloor(floor) {
  const row = (await floorRows()).find((r) => r.floor === floor);
  if (!row) return { err: `no row for floor ${floor}` };
  const onScreen = row.visible && row.rect.w > 0 && row.rect.h > 0;
  await clearTransients();
  if (onScreen) await p.mouse.click(row.rect.x + Math.min(60, row.rect.w / 2), row.rect.y + row.rect.h / 2);
  await sleep(500);
  return {
    row, onScreen, panel: await p.evaluate(() => window.ui?.panels?.name || null), toasts: await toasts(),
  };
}

/** Wait for the snapshot to carry a running floor. */
async function awaitRunning(floor) {
  // Both halves of the predicate matter: the block from the *previous* floor is still in
  // the snapshot (state 'cleared'), so "chamber is non-null" is answered by the old run.
  const c = await waitFor(`floor ${floor} to be running`, (f) => {
    const cc = window.game.chamber;
    return cc && cc.state === 'running' && cc.floor === f ? { ...cc } : null;
  }, 12000, floor);
  await settle();
  return { ok: !!c, chamber: c, refused: c ? null : await toasts() };
}

/** Ask the client to start a floor and wait for the snapshot to carry it. */
async function startFloor(floor) {
  await p.evaluate((f) => { window.game.startChamber(f); }, floor);
  return awaitRunning(floor);
}

/**
 * Kill the enemies of the current wave through the instance's own damage path, so the
 * clear runs every hook a real kill would (`ENEMY_DIED`, loot, the chamber bookkeeping).
 */
const killWave = () => p.evaluate(() => {
  const g = window.game, inst = g.socket.inst;
  let n = 0;
  for (const e of inst.enemies.values()) {
    if (!e.alive) continue;
    inst.applyDamageToEnemy(e, 1e9, 'physical', 0, g.playerId, 'skill');
    n++;
  }
  return n;
});

/**
 * Kill wave after wave until the floor ends, counting the waves that actually spawned.
 *
 * "Ended" is `state !== 'running'`, not `chamber == null`: the instance keeps the block
 * around after the clear (that is what stops a second settlement), so waiting for it to
 * disappear waits forever.
 */
async function clearFloor(maxWaves = 6) {
  let wavesSeen = 0;
  for (let i = 0; i < maxWaves; i++) {
    const alive = await waitFor('the next wave to spawn', () => {
      const c = window.game.chamber;
      if (!c || c.state !== 'running') return 0;   // 0 = the floor is over, not "keep waiting"
      let n = 0;
      for (const e of window.game.socket.inst.enemies.values()) if (e.alive) n++;
      return n || null;
    }, 12000);
    if (!alive) break;                     // floor over, or nothing left to kill
    wavesSeen++;
    await killWave();
    await sleep(600);
  }
  const state = await waitFor('the floor to end',
    () => (window.game.chamber?.state !== 'running' ? (window.game.chamber?.state || 'gone') : null), 12000);
  await settle();
  return { wavesSeen, state, ended: !!state };
}

/**
 * The mean colour of the brightest `frac` of a rect — its ink, once the 3D scene behind the
 * HUD is out of the way (see `setCanvasVisible`).
 *
 * Measuring over the live scene does not work in either obvious form. A plain rect mean is
 * dominated by the lit dungeon and by the bright fog band that happens to sit behind this
 * chip: measured that way the violet line and the gold line above it both read 220,215,203.
 * Diffing two frames to isolate the glyphs does not work either — fog and particles move, so
 * a third of the rect changes between any two frames and the "ink" comes out as scene.
 */
function ink(img, r, frac = 0.12) {
  const px = [];
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * img.width + x) * 4;
      const d = img.data;
      px.push([d[i], d[i + 1], d[i + 2], 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]]);
    }
  }
  px.sort((a, c) => c[3] - a[3]);
  const top = px.slice(0, Math.max(1, Math.round(px.length * frac)));
  const mean = (k) => Math.round(top.reduce((a, v) => a + v[k], 0) / top.length);
  return { rgb: [mean(0), mean(1), mean(2)], lum: Math.round(top.reduce((a, v) => a + v[3], 0) / top.length) };
}

/**
 * How far a text box's glyphs stand out from their own background, in luminance.
 *
 * A plain brightest-tail mean cannot grade a dimmed row: the panel behind it is dark and the
 * tail is glyph peaks either way (89 vs 85 for a row at half alpha — a true difference, and one
 * no player would see). Subtracting the box's own median background makes it a contrast, which
 * is what dimming actually changes.
 */
function inkContrast(img, r) {
  const lums = [];
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * img.width + x) * 4;
      lums.push(0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]);
    }
  }
  lums.sort((a, c) => c - a);
  const top = lums.slice(0, Math.max(1, Math.round(lums.length * 0.1)));
  const bg = lums[Math.floor(lums.length / 2)];
  return Math.round(top.reduce((a, v) => a + v, 0) / top.length - bg);
}

/** Hide or show one child of the chamber chip, so its own pixels can be isolated. */
const setChipVisible = (sel, visible) => p.evaluate((s2, v) => {
  const n = document.querySelector(`.chamber ${s2}`);
  if (n) n.style.visibility = v ? '' : 'hidden';
  return !!n;
}, sel, visible);

/**
 * Hide the WebGL canvas, leaving the HUD over a static page background.
 *
 * The claim under test is about the HUD's own pixels ("this line is drawn, in violet"), and
 * the moving scene is the only reason that claim is hard to measure. With the canvas hidden
 * the frames are deterministic, so the same rect can be read with the line present and with
 * it hidden and the difference is entirely the line.
 */
const setCanvasVisible = (visible) => p.evaluate((v) => {
  const c = document.querySelector('canvas');
  if (c) c.style.visibility = v ? '' : 'hidden';
  return !!c;
}, visible);

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await shot('title');

  check('the login screen offers 单机模式', await p.evaluate(() => {
    const btn = document.querySelector('[data-act="solo"]');
    if (!btn) return false;
    btn.click();
    return true;
  }));
  await sleep(400);
  await (await p.$('[data-act="guest"]')).click();
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  const me = await p.evaluate(() => ({ running: !!window.game?._running, mode: window.game?.mode }));
  check('the solo world booted', me.running === true && me.mode === 'solo', `mode ${me.mode}`);

  // Record the cues instead of listening for them: `audio-check` owns whether a cue makes
  // a sound, this owns whether the wave path asks for one.
  await p.evaluate(() => {
    window.__sfx = [];
    const a = window.game.audio;
    const orig = a.sfx.bind(a);
    a.sfx = (name, ...rest) => { window.__sfx.push(name); return orig(name, ...rest); };
    // Record the banner stream through the same event the HUD listens on, so a banner that
    // was replaced 200 ms later is still evidence.
    window.__banners = [];
    window.game.on('banner', (bn) => window.__banners.push(bn));
  });

  /* -------------------------------------------------- 1. floor 1: no disorder ---- */
  // The starter floor is the control for the whole probe: a real running chamber, two real
  // waves, and deliberately no disorder — so every disorder read below has a same-chip,
  // same-scene counterpart that must stay empty.
  console.log(`\n=== 1. ${DZ} floor ${f1.floor}: a real run with no disorder`);
  const entered = await p.evaluate(async (z) => {
    try { await window.game.enterZone(z); } catch (e) { return { err: e?.message || String(e) }; }
    return { zone: window.game.zoneId, inst: !!window.game.socket?.inst };
  }, DZ);
  check('the probe reached the dungeon', entered.zone === DZ && entered.inst === true,
    JSON.stringify(entered));

  // A level-1 guest cannot survive a level-24 floor, and this probe is about four DOM
  // nodes, not about balance (`balance-check` owns "can it be beaten at parity", and
  // `chamber-check` owns the disorder's damage multiplier). So incoming damage is switched
  // off at the one method that applies it — nothing reads its return value — and the
  // enemies die through the instance's own kill path.
  await p.evaluate(() => { window.game.socket.inst.damagePlayer = () => 0; });

  await clearTransients();

  /* ------------------------- 1a. the floor list is how a player picks a floor ---- */
  // The list in the 地图 panel is the *only* way in, and until `chamberEntry` it offered all
  // of the floors: every row was clickable, and floors 2+ answered with a red toast from the
  // server. Nothing had ever driven this list — the probe itself used to call
  // `game.startChamber` — so the panel could offer anything and stay green.
  console.log('\n=== 1a. the 深境层数 list, before anything is cleared');
  check('M opens the map panel', await pressMap() === 'map');
  const rowsFresh = await floorRows();
  const mapShot = await shot('map-floors-locked');
  check(`the list shows all ${ZONES[DZ].chambers.length} floors`,
    rowsFresh.length === ZONES[DZ].chambers.length
    && rowsFresh.every((r, i) => r.floor === ZONES[DZ].chambers[i].floor),
    rowsFresh.map((r) => r.floor).join(','));
  // The list used to sit *below* the region list, which filled the column: all eight rows were
  // off the bottom of an unmarked scrolling box, and the only way into a 秘境 was invisible.
  check('...and the first floors are on screen without scrolling',
    rowsFresh.filter((r) => r.visible).length >= 3,
    `${rowsFresh.filter((r) => r.visible).length}/${rowsFresh.length} visible; row 1 at y=${rowsFresh[0].rect.y}`);
  const first = rowsFresh.find((r) => r.floor === f1.floor);
  const rest = rowsFresh.filter((r) => r.floor !== f1.floor);
  check('the first floor is offered', first.locked === null && !/🔒/.test(first.title), first.title);
  check('...and every later floor is marked locked, with the reason on hover',
    rest.length > 0 && rest.every((r) => r.locked === 'previous_floor_locked'
      && /🔒/.test(r.title) && r.hover === '需要先通过前一层'),
    rest.map((r) => `${r.floor}:${r.locked}/${r.hover}`).join(' '));
  // Style, not class: the locked rows are painted in a different colour from the open one,
  // and the pixels of their titles are dimmer. Both directions — an assertion that only reads
  // the locked row would also pass if *every* row were dimmed.
  // Only rows that are actually on screen can be read in pixels; the ones scrolled out of the
  // column have a rect but no pixels, and measuring those is how a locked-looking NaN gets
  // mistaken for evidence.
  const shownLocked = rest.filter((r) => r.visible);
  const lockedInk = shownLocked.map((r) => inkContrast(mapShot, pad(r.bRect, `f${r.floor}`)));
  const openInk = inkContrast(mapShot, pad(first.bRect, 'f1'));
  check('...and the lock is painted, not only in the DOM',
    first.visible && shownLocked.length > 0
    && first.opacity === 1 && rest.every((r) => r.opacity < 0.6)
    // Measured 109 for the open row against 75 and 71 for the locked ones (0.65-0.69×). The bar
    // is 0.85× rather than the authored 0.45: the tail of a padded text box picks up some of the
    // row's own furniture, so this half only has to prove the dimming *reached the screen* —
    // the authored amount is the `opacity` assertion beside it.
    && lockedInk.every((l) => l < openInk * 0.85),
    `open opacity ${first.opacity} contrast ${openInk} vs locked ${rest[0].opacity} / ${lockedInk.join(',')}`);

  // Clicking a locked row must refuse *here*, with the same wording the server would send,
  // and must leave the panel open — the player is still choosing a floor.
  const denied = await clickFloor(shownLocked[0].floor);
  check(`clicking a locked floor (${shownLocked[0].floor}) starts nothing`,
    denied.onScreen === true && await p.evaluate(() => window.game.chamber) === null,
    JSON.stringify(await p.evaluate(() => window.game.chamber)));
  check('...and says why, without closing the list',
    denied.panel === 'map' && denied.toasts.some((t) => /需要先通过前一层/.test(t.text) && /bad/.test(t.cls)),
    `panel ${denied.panel} toasts ${JSON.stringify(denied.toasts)}`);

  // The panel's refusal is the polite half. The host has to refuse too, or the lock is a
  // decoration a stale panel walks through — and in 单机 the host is `localSocket`, which no
  // request from `api-check` or `mp-check` can reach. So ask it the way a stale panel would:
  // `game.startChamber` straight past the list.
  await clearTransients();
  await p.evaluate((f) => window.game.startChamber(f), rest[0].floor);
  await sleep(400);
  const hostSaid = await toasts();
  check(`the 单机 host refuses floor ${rest[0].floor} on its own, not just the list`,
    await p.evaluate(() => window.game.chamber) === null
    && hostSaid.some((t) => /需要先通过前一层/.test(t.text) && /bad/.test(t.cls)),
    JSON.stringify(hostSaid));

  await clearTransients();
  const opened = await clickFloor(f1.floor);
  check(`clicking floor ${f1.floor} closes the list and starts the run`, opened.panel === null,
    `panel ${opened.panel} toasts ${JSON.stringify(opened.toasts)}`);
  const start1 = await awaitRunning(f1.floor);
  check(`floor ${f1.floor} started`, start1.ok === true, JSON.stringify(start1));
  const b1 = (await banners()).find((x) => /第 \d+ 间/.test(x.title)) || {};
  const chip1 = await chip();
  const shot1 = await shot(`floor${f1.floor}-plain`);
  check('the opening banner names the floor and its shape',
    b1.title === `第 ${f1.floor} 间`
      && b1.sub?.includes(`限时 ${f1.timeLimit} 秒`) && b1.sub.includes(`${f1.waves[0].length} 名敌人`)
      && b1.sub.includes(`共 ${f1.waves.length} 波`), `${b1.title} | ${b1.sub}`);
  check('...and says nothing about a disorder it does not have', !/地脉/.test(b1.sub || ''), b1.sub);
  check('the chamber chip is on screen', chip1?.show === true, JSON.stringify(chip1?.clock?.text));
  check('the chip counts the waves', new RegExp(`第 1/${f1.waves.length} 波`).test(chip1.sub.text || ''),
    chip1.sub.text);
  check('a floor with no disorder shows no disorder line',
    chip1.dis.text === '' && chip1.dis.display === 'none' && chip1.dis.rect.h === 0,
    `"${chip1.dis.text}" ${chip1.dis.display} h=${chip1.dis.rect.h}`);
  check('...and it does say how many enemies are left',
    new RegExp(`剩余敌人 ${f1.waves[0].length}`).test(chip1.sub.text || ''), chip1.sub.text);

  /* ---------------------- 1b. the same list, with a run already going ------------ */
  // `startChamber` *is* the reset: it empties the arena and respawns wave 1. So a row that
  // stays clickable during a run is a button that throws the run away — in 联机 somebody
  // else's. The row now says 进行中 and refuses, and the receipt is that the *simulation* did
  // not move: same `startedAt`, same enemy **ids** (a count is equal across a respawn).
  console.log('\n=== 1b. the list while the floor is running');
  const beforeClick = await runState();
  check('the map opens on top of a live run', await pressMap() === 'map', JSON.stringify(beforeClick));
  const rowsLive = await floorRows();
  const liveRow = rowsLive.find((r) => r.floor === f1.floor);
  check('the running floor is marked 进行中, not offered again',
    liveRow.locked === 'chamber_in_progress' && /进行中/.test(liveRow.title)
    && liveRow.hover === '挑战正在进行中，先打完这一层', `${liveRow.title} | ${liveRow.hover}`);
  // No row at all is offered while a run is live. The deeper floors report the *earlier* reason
  // (`previous_floor_locked` — they are shut for a better reason than the run), which is the
  // order `chamberEntry` promises; that a floor which would otherwise be open reports
  // `chamber_in_progress` is asserted in `chamber-check`'s truth table.
  check('...and no other floor is offered either, since any of them would reset this one',
    rowsLive.every((r) => r.locked !== null) && rowsLive.every((r) => r.opacity < 0.6),
    rowsLive.map((r) => `${r.floor}:${r.locked}`).join(' '));
  const clickedLive = await clickFloor(f1.floor);
  const afterClick = await runState();
  check('clicking it refuses instead of restarting',
    clickedLive.panel === 'map'
    && clickedLive.toasts.some((t) => /挑战正在进行中/.test(t.text) && /bad/.test(t.cls)),
    `panel ${clickedLive.panel} toasts ${JSON.stringify(clickedLive.toasts)}`);
  check('...and the run kept its clock and its own wave',
    !!beforeClick && afterClick?.startedAt === beforeClick.startedAt
    && afterClick.wave === beforeClick.wave && afterClick.ids === beforeClick.ids
    && afterClick.state === 'running',
    `${JSON.stringify(beforeClick)} -> ${JSON.stringify(afterClick)}`);
  check('the map closes again on M', await pressMap() === null);

  const cleared1 = await clearFloor();
  check(`floor ${f1.floor} cleared, all ${f1.waves.length} waves`,
    cleared1.wavesSeen === f1.waves.length && cleared1.state === 'cleared', JSON.stringify(cleared1));
  check('...which unlocks the next floor', await p.evaluate((z, f) =>
    (window.game.player.abyss?.[z]?.[f]?.stars ?? 0) > 0, DZ, f1.floor),
    JSON.stringify(await p.evaluate((z) => window.game.player.abyss?.[z], DZ)));

  // Clearing a floor opens the 挑战奖励 modal, which pauses the game and dims the HUD
  // behind a scrim. A player clicks 确定; so does this.
  check('the reward modal opened and closes on 确定', await closeModal() === 'closed');

  /* ------------------------------------------- 2. floor 2: the disorder on screen -- */
  const dz = DISORDERS[f2.disorder];
  const hint = disorderHint(dz);
  console.log(`\n=== 2. floor ${f2.floor}: ${dz.name}`);
  await clearTransients();
  // The other direction of 1a: the star on floor 1 has to *open* this row, and the row after
  // it has to stay shut. Cleared floors are also startable again, so floor 1 is offered too.
  check('the map reopens now that a floor is starred', await pressMap() === 'map');
  const rowsAfter = await floorRows();
  const nextRow = rowsAfter.find((r) => r.floor === f2.floor);
  const stillShut = rowsAfter.filter((r) => r.floor > f2.floor);
  check(`floor ${f2.floor} is no longer locked`,
    nextRow.locked === null && !/🔒/.test(nextRow.title) && /★/.test(await p.evaluate(
      () => document.querySelector('[data-floor="1"] .stars')?.textContent || '')),
    `${nextRow.title} | locked ${nextRow.locked}`);
  check('...and the floor after it still is',
    stillShut.length > 0 && stillShut.every((r) => r.locked === 'previous_floor_locked'),
    stillShut.map((r) => `${r.floor}:${r.locked}`).join(' '));
  const opened2 = await clickFloor(f2.floor);
  check('...and clicking it starts the run', opened2.panel === null,
    `panel ${opened2.panel} toasts ${JSON.stringify(opened2.toasts)}`);
  const start2 = await awaitRunning(f2.floor);
  check(`floor ${f2.floor} started`, start2.ok === true, JSON.stringify(start2));
  const b2 = (await banners()).find((x) => /第 \d+ 间/.test(x.title)) || {};
  const chip2 = await chip();
  const shot2 = await shot(`floor${f2.floor}-${dz.id}`);

  check('the banner titles the floor with its disorder', b2.title === `第 ${f2.floor} 间 · ${dz.name}`,
    JSON.stringify(b2.title));
  check('...and its subtitle carries limit, count, waves and the disorder numbers',
    b2.sub?.includes(`限时 ${f2.timeLimit} 秒`) && b2.sub.includes(`${f2.waves[0].length} 名敌人`)
      && b2.sub.includes(`共 ${f2.waves.length} 波`) && b2.sub.includes(hint), b2.sub);
  check('starting a floor asks for the chamber cue',
    (await p.evaluate(() => window.__sfx)).includes('chamberStart'));
  check('the chip names the disorder and states its numbers',
    chip2.dis.text === `${dz.name} · ${hint}`, chip2.dis.text);
  check('...and the line is actually laid out',
    chip2.dis.display !== 'none' && chip2.dis.rect.h > 0,
    `${chip2.dis.display} h=${chip2.dis.rect.h}`);

  /* -------------------------------------------- 3. the disorder line in pixels ---- */
  // `textContent` is equally true of text painted in the background colour, and the chip
  // sits over a lit 3D scene. So the line is measured where it is drawn, against two
  // controls: the same rect in the floor-1 frame (where the line is not there) and the
  // line directly above it in this same frame (same font, same background).
  console.log('\n=== 3. the same line, measured in pixels');
  check('the HUD is unobstructed while its pixels are read',
    await p.evaluate(() => !document.querySelector('.scrim')));
  const rDis = pad(chip2.dis.rect, 'disorder line');
  const rSub = pad(chip2.sub.rect, 'sub line');

  check('the canvas can be taken out of the way', await setCanvasVisible(false) === true);
  const flat = await shot(`floor${f2.floor}-hud-only`);
  await setChipVisible('.dis', false);
  const flatNoDis = await shot(`floor${f2.floor}-hud-only-no-dis`);
  await setChipVisible('.dis', true);
  await setCanvasVisible(true);

  // #d9b6ff is 217,182,255 — blue over green *and* red over green. The line above it is gold
  // (232,197,106), which fails the first half by a mile.
  const disInk = ink(flat, rDis);
  const subInk = ink(flat, rSub);
  const emptyInk = ink(flatNoDis, rDis);
  const violet = (s2) => s2.rgb[2] - s2.rgb[1] > 25 && s2.rgb[0] - s2.rgb[1] > 8;
  check('the disorder line is drawn in the violet the stylesheet asks for', violet(disInk),
    `ink rgb ${disInk.rgb.join(',')} lum ${disInk.lum}`);
  check('...and hiding it takes those pixels away', disInk.lum - emptyInk.lum > 40,
    `lum ${disInk.lum} -> ${emptyInk.lum}`);
  check('the gold line above it is measured the same way and is not violet', !violet(subInk),
    `ink rgb ${subInk.rgb.join(',')} lum ${subInk.lum}`);
  check('...and is the warm one of the pair',
    subInk.rgb[0] - subInk.rgb[2] > 20 && disInk.rgb[2] > disInk.rgb[0],
    `sub ${subInk.rgb.join(',')} vs dis ${disInk.rgb.join(',')}`);
  // A control on the other axis: the same rect on the floor that has no disorder — with the
  // scene visible there, so this one is only allowed to say "not a violet line".
  const off = ink(shot1, rDis);
  check('the same rect on the floor with no disorder holds no violet line', !violet(off),
    `floor ${f1.floor} ink rgb ${off.rgb.join(',')}`);

  /* --------------------------------------------------- 4. the change of wave ------ */
  console.log('\n=== 4. the breather and the toast that says the fight is not over');
  await clearTransients();
  const before = await toasts();
  check('the probe cleared the toast strip first', before.length === 0, `${before.length} left`);
  const killed = await killWave();
  check(`wave 1 of floor ${f2.floor} is gone`, killed === f2.waves[0].length, `${killed} killed`);

  const gap = await waitFor('the breather', () => {
    const c = window.game.chamber;
    return c && c.waveIn > 0 ? { waveIn: c.waveIn, remaining: c.remaining } : null;
  }, 8000);
  const gapChip = await chip();
  await shot(`floor${f2.floor}-breather`);
  check('the breather counts down to the next wave', /下一波 \ds/.test(gapChip.sub.text || ''),
    `${gapChip.sub.text} (snapshot waveIn ${gap?.waveIn})`);
  check('...instead of claiming 0 enemies remain', !/剩余敌人/.test(gapChip.sub.text || ''),
    gapChip.sub.text);
  check('...and the disorder line survives the breather', gapChip.dis.text === `${dz.name} · ${hint}`,
    gapChip.dis.text);

  await waitFor('wave 2', () => (window.game.chamber?.wave === 2 ? window.game.chamber.wave : null), 12000);
  const after = await toasts();
  const waveChip = await chip();
  await shot(`floor${f2.floor}-wave2`);
  const waveToast = after.find((t) => new RegExp(`第 2/${f2.waves.length} 波`).test(t.text));
  check('a new wave toasts its number and its size',
    !!waveToast && new RegExp(`${f2.waves[1].length} 名敌人`).test(waveToast.text || ''),
    JSON.stringify(after));
  check('...styled as the gold "something happened" toast', waveToast?.cls === 'gold', waveToast?.cls);
  check('...and it reuses the chamber cue',
    (await p.evaluate(() => window.__sfx)).includes('chamberStart'));
  check('the chip advances its wave counter',
    new RegExp(`第 2/${f2.waves.length} 波`).test(waveChip.sub.text || ''), waveChip.sub.text);

  /* ------------------------------------------------------- 5. leaving the floor --- */
  console.log('\n=== 5. the floor ends and takes its chip with it');
  await clearTransients();
  const cleared2 = await clearFloor();
  check(`floor ${f2.floor} cleared`, cleared2.state === 'cleared', JSON.stringify(cleared2));
  const endBanner = (await banners()).find((x) => /挑战/.test(x.title)) || {};
  const gone = await chip();
  await shot(`floor${f2.floor}-cleared`);
  check('the clear banner grades the run', /挑战成功/.test(endBanner.title || '')
    && /[★☆]{3}/.test(endBanner.sub || ''), `${endBanner.title} | ${endBanner.sub}`);
  // The two-sided half of the HUD's new rule: the snapshot *still carries* the chamber
  // block (that is what refuses a second settlement), and the chip must be gone anyway.
  check('the instance still remembers the finished floor',
    (await p.evaluate(() => window.game.chamber?.state)) === 'cleared');
  check('...and the chip is gone all the same', gone?.show === false, JSON.stringify(gone?.show));
  check('...so no stale ley line follows the player out of the floor',
    gone.dis.rect.h === 0 || gone.dis.display === 'none',
    `"${gone.dis.text}" ${gone.dis.display} h=${gone.dis.rect.h}`);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL probe threw — ${e.message}`);
} finally {
  await b.close();
  console.log(`\nchamber-ui: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
