// 探索派遣 probe: can a player actually send someone out, watch the clock, and collect?
//
//   DISPLAY=:99 node tools/expedition-ui.mjs [baseUrl] [outDir]
//
// `api-check.mjs` owns the rules — every refusal code, the payout basket, the atomic claim. It
// cannot say whether any of it is *reachable*: the whole module could be a working REST surface
// behind a panel that never draws a button, and every assertion there would still be green.
//
// So this drives the product's own input path and nothing else: G opens the panel (which is also
// the only proof that the key loop `game.js` now derives from `PANEL_ACTIONS` reaches a panel
// added after that loop was written), a real mouse click picks a destination, a duration and a
// character, a real click on 派遣 sends them, and a real click on 领取 collects. Nothing here
// calls `panels._startExp` or writes `game.player`.
//
// The two things that make an idle system testable at all:
//
//  * **Time is bought, not waited for.** The shortest trip is four hours, so the probe rewinds
//    `started_at` through `POST /api/dev/expedition-rewind` — the same hook `api-check` uses. It
//    rewinds to *25 seconds left* rather than to zero, because the interesting moment is the
//    crossing: the countdown has to move while nobody clicks anything, and the 领取 button and
//    the HUD chip have to appear by themselves when it reaches zero.
//  * **Every lock is read both ways.** A dimmed row that is dim for everyone proves nothing, so
//    each pixel reading has a control beside it in the same frame: 龙脊雪山 (AR 4) against 蒙德
//    (open) for the destination lock, the ready card's gold against the idle card's grey, the
//    chip's own rect with the chip hidden.
//
// Pixels are read with the WebGL canvas hidden. The claims are about HUD and panel ink, and the
// moving scene behind them is the only reason those claims are hard to measure — with the canvas
// out of the way the same rect can be read with a thing present and absent and the difference is
// entirely the thing.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';
import {
  EXPEDITIONS, EXPEDITION_HOURS, expeditionPayout, expeditionSlots, expeditionTotal,
  expeditionsFor,
} from '../shared/src/data/expeditions.js';
import { KEYMAP, keyGlyph } from '../client/src/game/input.js';
import { decodePng } from './lib/png.mjs';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const outDir = process.argv[3] || '/tmp/expedition-ui';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });

// Every expectation comes from the tables, never from a copy of them: which destination is open
// to a fresh AR-1 guest, which one is not, and what each duration is worth.
// Reassigned once the account's real rank is known: a guest is AR 1 today, and a starter-rank
// change must retune this probe rather than turn one of its two lock readings vacuous.
let OPEN = expeditionsFor(1)[0];
let GATED = Object.values(EXPEDITIONS).filter((d) => d.entryRank > 1)
  .sort((a, b) => a.entryRank - b.entryRank)[0];
const HOURS = EXPEDITION_HOURS[0];
const LONG = EXPEDITION_HOURS[EXPEDITION_HOURS.length - 1];
// The key the panel is opened with, read off the keymap rather than typed — the same reason
// `keyHint` exists at all.
const [PANEL_KEY] = KEYMAP.expedition;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, skipped = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}
function skip(name, why) { skipped++; console.log(`  SKIP ${name} — ${why}`); }

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
  if (drained.length) console.log(drained.slice(-6).join('\n'));
  return decodePng(readFileSync(file));
}

/** Two frames, so the latest state is painted before anything is measured. */
const settle = () => p.evaluate(() => new Promise((r) => {
  requestAnimationFrame(() => requestAnimationFrame(() => r(true)));
}));

/** Toasts recorded at emit time: a find over the DOM answers with the *previous* one. */
const toasts = () => p.evaluate(() => window.__toasts || []);
const clearToasts = () => p.evaluate(() => {
  window.__toasts = [];
  document.querySelectorAll('.toast').forEach((n) => n.remove());
});

/** Hide the WebGL canvas so a rect can be read twice and differ only by what changed in it. */
const setCanvasVisible = (visible) => p.evaluate((v) => {
  const c = document.querySelector('canvas');
  if (c) c.style.visibility = v ? '' : 'hidden';
  return !!c;
}, visible);

const setVisible = (sel, visible) => p.evaluate((s, v) => {
  const n = document.querySelector(s);
  if (n) n.style.visibility = v ? '' : 'hidden';
  return !!n;
}, sel, visible);

const box = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });

/**
 * How far a box's glyphs stand out from their own background, in luminance. A brightest-tail
 * mean on its own cannot grade a dimmed row (89 vs 85 for half alpha — a true difference no
 * player would see); subtracting the box's own median is what makes it a contrast.
 */
function inkContrast(img, r) {
  const lums = [];
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * img.width + x) * 4;
      lums.push(0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]);
    }
  }
  if (!lums.length) return 0;
  lums.sort((a, c) => c - a);
  const top = lums.slice(0, Math.max(1, Math.round(lums.length * 0.1)));
  const bg = lums[Math.floor(lums.length / 2)];
  return Math.round(top.reduce((a, v) => a + v, 0) / top.length - bg);
}

/** The mean colour of the brightest tenth of a rect — its ink. */
function ink(img, r) {
  const px = [];
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * img.width + x) * 4;
      px.push([img.data[i], img.data[i + 1], img.data[i + 2],
        0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]]);
    }
  }
  px.sort((a, c) => c[3] - a[3]);
  const top = px.slice(0, Math.max(1, Math.round(px.length * 0.1)));
  const mean = (k) => Math.round(top.reduce((a, v) => a + v[k], 0) / top.length);
  return [mean(0), mean(1), mean(2)];
}

const pad = (r) => ({ x: Math.max(0, r.x - 2), y: Math.max(0, r.y - 2), w: r.w + 4, h: r.h + 4 });

/* ---------------------------------------------------------------- page readers -- */

/** The destination list as a player sees it: text, lock, colour, and whether it is on screen. */
const destRows = () => p.evaluate(() => [...document.querySelectorAll('[data-exp-dest]')].map((r) => {
  const bEl = r.querySelector('b');
  const rect = (n) => { const c = n.getBoundingClientRect(); return { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) }; };
  return {
    id: r.dataset.expDest,
    locked: r.dataset.locked || null,
    sel: r.classList.contains('sel'),
    title: bEl?.textContent || '',
    sub: r.querySelector('small')?.textContent || '',
    qty: r.querySelector('.qty')?.textContent || '',
    hover: r.title || '',
    opacity: Number(getComputedStyle(r).opacity),
    rect: rect(r),
    bRect: bEl ? rect(bEl) : null,
    // Visible inside the column that scrolls, not merely inside the window: a row clipped by
    // `overflow:auto` still has a real rect, and a click at that y lands outside the panel.
    visible: (() => {
      const col = r.closest('.col.side') || r.parentElement;
      const c = col.getBoundingClientRect(), rc = r.getBoundingClientRect();
      return rc.top >= c.top - 1 && rc.bottom <= c.bottom + 1 && rc.bottom <= window.innerHeight;
    })(),
  };
}));

/** The 派遣队 cards: who is out, where, how long is left, and whether 领取 is offered. */
const cards = () => p.evaluate(() => [...document.querySelectorAll('[data-exp-slot]')].map((c) => {
  const rect = (n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const rem = c.querySelector('.rem');
  const btn = c.querySelector('button');
  return {
    slot: Number(c.dataset.expSlot),
    ready: c.dataset.ready === '1',
    idle: c.classList.contains('idle'),
    title: c.querySelector('b')?.textContent || '',
    sub: c.querySelector('small')?.textContent || '',
    rem: rem?.textContent || '',
    remRect: rem ? rect(rem) : null,
    subRect: c.querySelector('small') ? rect(c.querySelector('small')) : null,
    claim: btn ? { text: btn.textContent, rect: rect(btn) } : null,
    borderColor: getComputedStyle(c).borderTopColor,
  };
}));

const pills = (attr) => p.evaluate((a) => [...document.querySelectorAll(`[data-${a}]`)].map((n) => {
  const r = n.getBoundingClientRect();
  return {
    value: n.dataset[a === 'exp-hours' ? 'expHours' : 'expChar'],
    text: n.textContent,
    sel: n.classList.contains('sel'),
    dim: n.classList.contains('dim'),
    locked: n.dataset.locked || null,
    opacity: Number(getComputedStyle(n).opacity),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
}), attr);

/** The 派遣 button and the sentence beside it. */
const sendBtn = () => p.evaluate(() => {
  const n = document.querySelector('[data-act="exp-start"]');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return {
    text: n.textContent, disabled: n.disabled, locked: n.dataset.locked || null, hover: n.title,
    note: n.parentElement.querySelector('span')?.textContent || '',
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
});

const footBtn = () => p.evaluate(() => {
  const n = document.querySelector('[data-act="exp-claim-all"]');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  // Scoped to the open panel: the level-up modal has a `<footer>` of its own.
  return { text: n.textContent, disabled: n.disabled,
    foot: document.querySelector('.panel footer span')?.textContent || '',
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
});

/** The HUD chip: hidden or not, what it counts, where it is. */
const chip = () => p.evaluate(() => {
  const n = document.querySelector('[data-act="expedition"]');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  const cs = getComputedStyle(n);
  const bEl = n.querySelector('b');
  const br = bEl?.getBoundingClientRect();
  return {
    hidden: n.classList.contains('hidden'), display: cs.display, color: cs.color,
    n: bEl?.textContent || '', hover: n.title,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    // The count alone, for the hue reading: the 🧭 glyph beside it is painted by the font, not
    // by the chip's colour, and its brightest pixels would answer for a rule it never obeyed.
    bRect: br ? { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) } : null,
  };
});

const panelName = () => p.evaluate(() => window.ui?.panels?.name || null);

/** Wait for `n` real frames, the unit the input layer actually reads keys in. */
const frames = (n) => p.evaluate((k) => new Promise((r) => {
  let i = 0;
  const tick = () => (++i >= k ? r(i) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

/**
 * Press the panel's own key, the way a player opens it — and *hold* it for a few frames.
 *
 * `keyboard.press` is a down and an up a few milliseconds apart, and llvmpipe runs this page at
 * single-digit frames per second: `justPressed` samples once a frame, so a tap can land and lift
 * inside one frame and never be seen. Then wait for the panel to actually change rather than for
 * a fixed delay, and only re-press if nothing moved at all.
 */
async function pressPanelKey() {
  const from = await panelName();
  for (let attempt = 0; attempt < 3; attempt++) {
    await p.keyboard.down(PANEL_KEY);
    await frames(4);
    await p.keyboard.up(PANEL_KEY);
    for (let i = 0; i < 10; i++) {
      const now = await panelName();
      if (now !== from) return now;
      await sleep(150);
    }
  }
  return panelName();
}

/** Click something at its own on-screen rect, refusing to click what a player cannot see. */
async function clickRect(rect, label) {
  if (!rect || rect.w <= 0 || rect.h <= 0) return `no rect for ${label}`;
  await p.mouse.click(rect.x + Math.min(50, rect.w / 2), rect.y + rect.h / 2);
  await sleep(450);
  return null;
}

/** Poll a page-side reader until it answers truthy. */
async function waitFor(what, fn, timeout = 20000, arg = undefined) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const v = await p.evaluate(fn, arg);
    if (v !== null && v !== undefined && v !== false) return v;
    await sleep(250);
  }
  console.log(`  (timed out waiting for ${what})`);
  return null;
}

const inventory = () => p.evaluate(() => ({ ...(window.game.player?.inventory || {}) }));

let token = '';
async function rewind(seconds) {
  const r = await fetch(`${API}/api/dev/expedition-rewind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ seconds }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

try {
  /* ================================================================ 0. boot ==== */
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
  for (let i = 0; i < 90; i++) {
    if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) break;
    await sleep(1000);
  }
  const booted = await p.evaluate(() => ({
    running: !!window.game?._running, mode: window.game?.mode,
    rank: window.game?.player?.adventureRank, chars: Object.keys(window.game?.player?.characters || {}).length,
  }));
  if (!check('the solo world booted on a fresh guest',
    booted.running === true && booted.mode === 'solo', JSON.stringify(booted))) {
    throw new Error('no world');
  }
  token = await p.evaluate(() => localStorage.getItem('teyvat.token'));
  {
    const open = expeditionsFor(booted.rank);
    [OPEN] = open;
    GATED = Object.values(EXPEDITIONS).filter((d) => !open.some((o) => o.id === d.id))
      .sort((a, b) => a.entryRank - b.entryRank)[0];
    console.log(`  (AR ${booted.rank}: open ${open.map((d) => d.id).join(',')} · locked ${GATED?.id || 'none'})`);
  }

  await p.evaluate(() => {
    window.__toasts = [];
    window.game.on('toast', (t) => window.__toasts.push({ text: t.text, kind: t.kind || '' }));
    // Pinned so a quality downgrade cannot move a pixel reading mid-run.
    window.game.setAutoQuality?.(false);
  });

  /* ===================================== 1. the snapshot arrives without asking ==== */
  // A chip that only appears once the panel has been opened is a chip nobody sees: 派遣 is the
  // one system whose state advances while the game is closed, so the fetch is on a boot timer.
  // The evidence is that the view is populated on a session where no panel has been opened yet.
  console.log('\n=== 1. the boot fetch, before any panel is opened');
  const mounted = await waitFor('the boot snapshot', () => {
    const v = window.ui?.panels?._expView;
    return v ? { slots: v.slots, entries: v.entries.length, dests: v.destinations.length, opened: window.ui.panels.name } : null;
  }, 15000);
  // The slot count is the rule's, computed from this account's own rank and roster — not a
  // number typed here, which would pass on a build that returned a constant.
  check('the 派遣 snapshot is fetched at boot, with no panel ever opened',
    !!mounted && mounted.opened === null && mounted.slots === expeditionSlots(booted.rank, booted.chars),
    `${JSON.stringify(mounted)} vs rule ${expeditionSlots(booted.rank, booted.chars)} at AR ${booted.rank}, ${booted.chars} chars`);
  const chip0 = await chip();
  check('...and the chip stays hidden while nothing is claimable',
    chip0?.hidden === true && chip0.display === 'none', JSON.stringify(chip0));

  /* ============================================= 2. the panel opens by its key ==== */
  console.log(`\n=== 2. ${PANEL_KEY} opens 派遣, and the list is gated by the shared rule`);
  check(`${PANEL_KEY} opens the 派遣 panel`, await pressPanelKey() === 'expedition');
  await settle();
  const rows = await destRows();
  check(`the list shows all ${Object.keys(EXPEDITIONS).length} destinations, open and locked alike`,
    rows.length === Object.keys(EXPEDITIONS).length,
    rows.map((r) => `${r.id}${r.locked ? '🔒' : ''}`).join(' '));
  check('...and the first rows are reachable without scrolling an unmarked column',
    rows.slice(0, 3).every((r) => r.visible), rows.map((r) => `${r.id}:${r.visible}`).join(' '));

  // The destination this probe sends someone to is deliberately *not* the one the panel opens
  // on: picking it has to be a click, and a click that changes nothing proves nothing. (The
  // panel's own first choice is the first reachable row in table order; `expeditionsFor` sorts
  // by rank then id, so which one that is must be read, never assumed.)
  const openIds = expeditionsFor(booted.rank).map((d) => d.id);
  const wasSel = rows.find((r) => r.sel)?.id;
  OPEN = EXPEDITIONS[openIds.find((id) => id !== wasSel) ?? openIds[0]];
  const openRow = rows.find((r) => r.id === OPEN.id);
  const lockRow = GATED ? rows.find((r) => r.id === GATED.id) : null;
  check(`${OPEN.name} is offered to an AR-${booted.rank} guest`,
    openRow && !openRow.locked && openRow.title.includes(OPEN.name) && !openRow.title.includes('🔒'),
    JSON.stringify(openRow?.title));
  if (!GATED) skip('a rank-gated destination is locked', `every destination is open at AR ${booted.rank}`);
  else {
    check(`${GATED.name} is locked, and says which rank and why`,
      lockRow?.locked === 'rank_too_low' && lockRow.title.includes('🔒')
      && /需要 \d+ 阶/.test(lockRow.sub) && lockRow.sub.includes(`${GATED.entryRank}`),
      `${lockRow?.title} / ${lockRow?.sub}`);
    if (!lockRow || !openRow) throw new Error('the destination list did not draw');
    // Both directions, in one frame: the locked row must be dimmer than the open row, and the
    // open row must not be dim. "The lock did not change anything" would be equally true of a
    // rule that dimmed nothing and of one that dimmed everything.
    check('...and the lock is a property of that row alone',
      lockRow.opacity < openRow.opacity && openRow.opacity > 0.9,
      `${GATED.id} opacity ${lockRow.opacity} vs ${OPEN.id} ${openRow.opacity}`);
  }

  // The pixels, with the scene out of the way: a `classList`/`opacity` reading is a claim about
  // style, and this is the same claim made about ink.
  await setCanvasVisible(false);
  await settle();
  const listImg = await shot('panel-destinations');
  if (lockRow) {
    const lockInk = inkContrast(listImg, pad(lockRow.bRect));
    const openInk = inkContrast(listImg, pad(openRow.bRect));
    check('the locked row is painted fainter than the open one, in pixels',
      lockInk > 0 && openInk > 0 && lockInk < openInk * 0.8,
      `${GATED.id} contrast ${lockInk} vs ${OPEN.id} ${openInk}`);
  }
  await setCanvasVisible(true);

  // A locked row must refuse the click with the server's own sentence rather than silently
  // selecting: the panel is a reader of `expeditionEntry`, and this is the sentence it reads.
  if (lockRow) {
    await clearToasts();
    const err = await clickRect(lockRow.rect, GATED.id);
    check('clicking a locked destination says why, and does not select it',
      !err && (await destRows()).find((r) => r.id === GATED.id)?.sel === false
      && (await toasts()).some((t) => /冒险等阶不足/.test(t.text) && t.kind === 'bad'),
      JSON.stringify(await toasts()));
  }

  // Choosing where to send someone, by clicking the row.
  const noteBefore = (await sendBtn())?.note;
  await clickRect(openRow.rect, OPEN.id);
  const picked = await destRows();
  check(`clicking ${OPEN.name} selects it, and nothing else`,
    picked.filter((r) => r.sel).length === 1 && picked.find((r) => r.sel)?.id === OPEN.id,
    picked.filter((r) => r.sel).map((r) => r.id).join(',') || 'nothing selected');
  const noteAfter = (await sendBtn())?.note;
  // The preview is downstream of the selection, so it has to have moved with it. Two open
  // destinations pay different baskets by construction (矿脉 vs 采集), which is what makes this
  // readable at all; with only one reachable destination there is nothing to compare.
  if (openIds.length > 1) {
    check('...and the 派遣 preview is re-priced for the destination just chosen',
      noteAfter !== noteBefore
      && Object.values(expeditionPayout(OPEN, EXPEDITION_HOURS[0])).every((n) => noteAfter.includes(`×${n}`)),
      `「${noteBefore}」 → 「${noteAfter}」`);
  } else skip('the preview follows the selection', 'only one destination is reachable');

  /* ================================================ 3. the pickers price the trip ==== */
  console.log('\n=== 3. the duration and character pickers');
  const hourPills = await pills('exp-hours');
  check(`every duration in the table is offered (${EXPEDITION_HOURS.join('/')} h)`,
    hourPills.length === EXPEDITION_HOURS.length
    && EXPEDITION_HOURS.every((hv, i) => Number(hourPills[i].value) === hv),
    hourPills.map((x) => x.text).join(' '));
  check(`...with ${HOURS} h selected to begin with`,
    hourPills.find((x) => Number(x.value) === HOURS)?.sel === true,
    hourPills.filter((x) => x.sel).map((x) => x.text).join(','));

  const beforeQty = (await destRows()).find((r) => r.id === OPEN.id).qty;
  const longPill = hourPills.find((x) => Number(x.value) === LONG);
  await clickRect(longPill.rect, `${LONG}h`);
  const afterRows = await destRows();
  const afterQty = afterRows.find((r) => r.id === OPEN.id).qty;
  // The row's count is what makes one destination worth choosing, and it has to answer to the
  // duration: a static number would be the same lie whichever pill is pressed.
  check(`picking ${LONG} h re-prices the whole list from the shared table`,
    beforeQty === `${expeditionTotal(OPEN, HOURS)} 件` && afterQty === `${expeditionTotal(OPEN, LONG)} 件`
    && beforeQty !== afterQty,
    `${HOURS}h → ${beforeQty}, ${LONG}h → ${afterQty}`);
  // Back to the short trip: it is the one the rewind hook can pay for in a probe's lifetime.
  await clickRect(hourPills.find((x) => Number(x.value) === HOURS).rect, `${HOURS}h`);

  const owned = await p.evaluate(() => Object.keys(window.game.player.characters));
  let charPills = await pills('exp-char');
  check('every owned character can be sent, and none of them is out yet',
    charPills.length === owned.length && charPills.every((x) => !x.dim && !x.locked),
    charPills.map((x) => x.text).join(' '));

  // What the button promises has to be the basket the table pays — the same numbers the row's
  // 件 count and the claim are derived from, not a hopeful sentence.
  const wantBits = Object.values(expeditionPayout(OPEN, HOURS)).map((n) => `×${n}`);
  const send0 = await sendBtn();
  check('the 派遣 button is offered, and prices the trip it would start',
    send0 && send0.disabled === false && !send0.locked
    && send0.note.includes('预计带回') && wantBits.every((bit) => send0.note.includes(bit))
    && send0.hover.includes(OPEN.name),
    `${send0?.text} · ${send0?.note} · title「${send0?.hover}」`);

  /* ==================================================== 4. a dispatch, by clicking ==== */
  console.log('\n=== 4. sending someone out');
  const who = charPills[0].value;
  await clearToasts();
  await clickRect((await sendBtn()).rect, '派遣');
  await settle();
  const sentToast = await toasts();
  const afterSend = await cards();
  const filled = afterSend.find((c) => !c.idle);
  check('the click filled a slot with a real trip',
    !!filled && filled.slot === 0 && filled.ready === false
    && filled.title.includes(OPEN.name)
    && filled.sub.startsWith(`${HOURS} 小时`)
    && wantBits.every((bit) => filled.sub.includes(bit)),
    `${filled?.title} · ${filled?.sub}`);
  check('...and said so, naming the character and when they are back',
    sentToast.some((t) => /小时后归来/.test(t.text) && t.kind === 'good'),
    JSON.stringify(sentToast));
  // The whole trip, to the minute: `untilText` stops at minutes, so a just-started 4 h trip
  // reads either 「4小时0分」 or 「3小时59分」 depending on which side of the second it lands.
  check('...and the countdown starts at the whole trip',
    new RegExp(`^剩余 (${HOURS}小时0分|${HOURS - 1}小时5\\d分)$`).test(filled?.rem || ''), filled?.rem);
  check('...and no 领取 is offered while it is in flight',
    filled?.claim === null && (await footBtn())?.disabled === true,
    `${filled?.claim ? 'button present' : 'no button'}, 一键领取 disabled ${(await footBtn())?.disabled}`);

  charPills = await pills('exp-char');
  const outPill = charPills.find((x) => x.value === who);
  const homePill = charPills.find((x) => x.value !== who);
  check('the character who left is marked busy — and the one who stayed is not',
    outPill?.locked === 'character_busy' && outPill.dim === true
    && !homePill?.locked && homePill.dim === false
    && outPill.opacity < homePill.opacity,
    `${outPill?.text} ${outPill?.opacity} vs ${homePill?.text} ${homePill?.opacity}`);
  await clearToasts();
  await clickRect(outPill.rect, who);
  check('...and clicking Ta says why instead of silently selecting',
    (await toasts()).some((t) => /派遣中/.test(t.text) && t.kind === 'bad')
    && (await pills('exp-char')).find((x) => x.value === who)?.sel === false,
    JSON.stringify(await toasts()));
  const idleCard = (await cards()).find((c) => c.idle);
  check('the remaining slot reads as free rather than as an error',
    !!idleCard && /空闲/.test(idleCard.title), idleCard?.title);
  await shot('dispatched');

  /* ============================================== 5. the crossing into 可领取 ==== */
  // Not rewound past the end: the assertions below are about a countdown that moves on its own
  // and a button that appears without a click. A trip that was already finished when the panel
  // first heard of it would be 可领取 on arrival and neither claim would be tested.
  //
  // Nor is the refetch asked for by hand. The panel keeps its snapshot for 30 s and refetches
  // behind the paint on the next open — so the probe rewinds to 60 s left, closes the panel,
  // waits out the staleness window, and re-opens it. Every number below then came through the
  // panel's own path, and the wait doubles as the trip running down.
  console.log('\n=== 5. the countdown moves, and 领取 appears by itself');
  const rw = await rewind(HOURS * 3600 - 60);
  check('the rewind hook moved this account’s trip', rw.status === 200 && rw.body.moved === 1,
    JSON.stringify(rw.body));
  const staleRem = (await cards()).find((c) => !c.idle)?.rem;
  check('the open panel is still counting down from the old snapshot, as it must be',
    /小时/.test(staleRem || ''), `${staleRem} (the rewind is server-side only)`);
  await pressPanelKey();                                   // closed, so the reopen is a fresh draw
  await sleep(32_000);                                     // past the 30 s staleness window
  check('reopening 派遣 after the staleness window shows the trip about to land',
    await pressPanelKey() === 'expedition');
  const nearly = await waitFor('the refetched countdown', () => {
    const t = document.querySelector('[data-exp-slot="0"] .rem')?.textContent || '';
    return /^剩余 \d+ 秒$/.test(t) ? t : null;
  }, 8000);
  check('the card now shows seconds, not hours — the panel refetched on its own',
    !!nearly, JSON.stringify(nearly));
  const before = nearly || '';
  await sleep(2600);
  const moved = (await cards()).find((c) => !c.idle);
  check('...and the number moves with nobody touching anything',
    moved && moved.rem !== before && Number(moved.rem.match(/\d+/)?.[0]) < Number(before.match(/\d+/)?.[0]),
    `${before} → ${moved?.rem}`);

  const crossed = await waitFor('the trip to finish', () => {
    const c = document.querySelector('[data-exp-slot="0"]');
    return c?.dataset.ready === '1' ? c.querySelector('.rem')?.textContent : null;
  }, 40000);
  check('the card crosses into 可领取 on its own', crossed === '可领取', JSON.stringify(crossed));
  const readyCards = await cards();
  const readyCard = readyCards.find((c) => c.slot === 0);
  const idle2 = readyCards.find((c) => c.idle);
  check('...and a 领取 button appears on it, with no redraw asked for',
    readyCard?.claim?.text === '领取' && idle2?.claim === null,
    `${readyCard?.claim?.text} on slot 0, ${idle2?.claim ? 'and one on the idle slot' : 'none on the idle slot'}`);
  const foot2 = await footBtn();
  check('...and the footer offers 一键领取 with a count',
    foot2?.disabled === false && /一键领取 \(1\)/.test(foot2.text) && /可领取 1/.test(foot2.foot),
    `${foot2?.text} · ${foot2?.foot}`);

  // Gold is the panel's word for collectable, and this is the same reading twice: the finished
  // card's countdown against the idle card's grey line in the same frame.
  await setCanvasVisible(false);
  await settle();
  const readyImg = await shot('ready');
  if (readyCard?.remRect && idle2?.subRect) {
    const gold = ink(readyImg, pad(readyCard.remRect));
    const grey = ink(readyImg, pad(idle2.subRect));
    check('可领取 is painted gold, where the idle slot is grey',
      gold[0] > gold[2] + 25 && Math.abs(grey[0] - grey[2]) < 22,
      `ready ${gold.join(',')} vs idle ${grey.join(',')}`);
  }
  await setCanvasVisible(true);

  /* ================================================ 6. the HUD chip, on its own ==== */
  console.log('\n=== 6. the chip that says so with the panel closed');
  check(`${PANEL_KEY} closes the panel again`, await pressPanelKey() === null);
  await settle();
  const chip1 = await chip();
  check('the chip appeared, counting the finished trip',
    chip1?.hidden === false && chip1.n === '1' && /1 支派遣已归来/.test(chip1.hover),
    `${chip1?.n} · ${chip1?.hover}`);
  // A chip that says only 「1」 is a mystery: it has to say how full the slate is and how to get
  // there, and the key comes from the keymap so a rebind cannot leave a lie in the tooltip.
  check('...and its tooltip gives the slate and the key that opens the panel',
    /派遣位 \d+\/\d+/.test(chip1?.hover || '') && chip1.hover.includes(keyGlyph(PANEL_KEY)),
    chip1?.hover);

  await setCanvasVisible(false);
  await settle();
  const chipImg = await shot('hud-chip');
  const chipInk = inkContrast(chipImg, pad(chip1.rect));
  const chipRgb = ink(chipImg, pad(chip1.bRect || chip1.rect));
  await setVisible('[data-act="expedition"]', false);
  await settle();
  const goneImg = await shot('hud-chip-hidden');
  const goneInk = inkContrast(goneImg, pad(chip1.rect));
  await setVisible('[data-act="expedition"]', true);
  check('the chip is really on the screen, not merely in the DOM',
    chipInk > goneInk + 8, `contrast ${chipInk} with it, ${goneInk} without`);
  // Four chips share that corner and they must not read as one widget; 派遣 is the violet one.
  check('...and it is the violet chip, not one of the other three',
    chipRgb[2] > chipRgb[1] + 12 && chipRgb[0] > chipRgb[1] + 8, chipRgb.join(','));
  await setCanvasVisible(true);

  // The chip is a button, and the only thing it is for is getting you there.
  await p.mouse.click(chip1.rect.x + chip1.rect.w / 2, chip1.rect.y + chip1.rect.h / 2);
  await sleep(500);
  check('clicking the chip opens the 派遣 panel', await panelName() === 'expedition');
  // If that route is broken, take the other one: what section 7 grades is the payout, and it
  // should say so on its own line instead of dying on a missing button.
  if (await panelName() !== 'expedition') await pressPanelKey();

  /* ======================================================= 7. 领取, by clicking ==== */
  console.log('\n=== 7. collecting');
  const bag0 = await inventory();
  const want = expeditionPayout(OPEN, HOURS);
  const claimBtn = (await cards()).find((c) => c.slot === 0)?.claim;
  if (!check('the finished trip offers a 领取 button to click', !!claimBtn)) {
    throw new Error('nothing to claim');
  }
  await clearToasts();
  await clickRect(claimBtn.rect, '领取');
  await settle();
  const bag1 = await inventory();
  check('the click paid exactly the basket the card promised',
    Object.entries(want).every(([id, n]) => (bag1[id] || 0) === (bag0[id] || 0) + n),
    Object.keys(want).map((id) => `${id} ${bag0[id] || 0}→${bag1[id] || 0} (+${want[id]})`).join(' '));
  check('...and said what came back',
    (await toasts()).some((t) => /派遣归来/.test(t.text) && t.kind === 'gold'),
    JSON.stringify(await toasts()));
  const emptied = await cards();
  check('...and the slot is free again, with nothing left to collect',
    emptied.every((c) => c.idle) && (await footBtn())?.disabled === true,
    emptied.map((c) => `${c.slot}:${c.idle ? 'idle' : c.title}`).join(' '));
  const chip2 = await chip();
  check('...and the chip went away with it', chip2?.hidden === true,
    `hidden ${chip2?.hidden}, n ${chip2?.n}`);
  // The character is home, so Ta can be sent again — the busy mark is a state, not a one-way door.
  const homeAgain = (await pills('exp-char')).find((x) => x.value === who);
  check('the character who came back can be sent out again',
    homeAgain && !homeAgain.locked && homeAgain.dim === false,
    `${homeAgain?.text} locked=${homeAgain?.locked} dim=${homeAgain?.dim}`);
  await shot('claimed');

  /* ==================================================== 8. the slate can be filled ==== */
  console.log('\n=== 8. the slot cap is real');
  const slots = (await p.evaluate(() => window.ui.panels._expView.slots));
  for (const id of owned) {
    const pill = (await pills('exp-char')).find((x) => x.value === id);
    if (!pill || pill.locked) continue;
    await clickRect(pill.rect, id);
    const btn = await sendBtn();
    if (btn && !btn.disabled) await clickRect(btn.rect, `派遣 ${id}`);
  }
  const full = await cards();
  const inFlight = full.filter((c) => !c.idle).length;
  check(`every slot can be filled (${slots} of them, ${owned.length} characters owned)`,
    inFlight === Math.min(slots, owned.length), `${inFlight}/${slots}`);
  const sendFull = await sendBtn();
  check('...and with nobody left to send, the button says so instead of failing on the server',
    sendFull?.disabled === true && !!sendFull.locked
    && /派遣中|派遣位/.test(sendFull.note),
    `${sendFull?.text} · locked=${sendFull?.locked} · ${sendFull?.note}`);
  await shot('slate-full');

  check('no page errors during the run', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`\nFAIL harness — ${e.message}`);
  await shot('crash').catch(() => {});
} finally {
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail);
}
