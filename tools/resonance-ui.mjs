// 元素共鸣 presentation probe: can a player see which resonance is on, and what turns the
// others on?
//
//   DISPLAY=:99 node tools/resonance-ui.mjs [baseUrl] [outDir]
//
// `resonance-check.mjs` owns the other half — the table, the fold into `partyStats`, and
// each effect measured in a stopped `ZoneInstance` against a party that activates nothing.
// It cannot see whether any of it reaches the screen, and a bonus nobody can read is a
// bonus nobody plays around: the whole point of the feature is that the *combination* of
// four characters matters, which only becomes a decision if the team screen says so.
//
// Three claims, each with a control that must move:
//
//   1. every row of the table is drawn, and no row that is not in the table
//   2. the party the guest starts with (4 distinct elements → 四象庇护) lights exactly the
//      resonance the shared table says it does, and the other seven read their requirement
//   3. removing a character — by clicking the slot, the way a player does — puts that row
//      back to unlit, and adding them back lights it again; the fire row must not move
//      through any of it, since nothing about the fire pair changed
//
// The lit/unlit difference is measured in pixels as well as in computed style, because
// `classList.contains('on')` passes on a row that is painted in the background colour (this
// repo has shipped that bug: a probe asserted the class while the chip was invisible). The
// canvas is hidden for the pixel reads so the frames are static — the party panel is a
// scrim over a live 3D scene otherwise.
//
// The fixture is built before the browser opens, because a fresh account cannot resonate at
// all: `repo.createAccount` grants `STARTER_PARTY.slice(0, 2)` — lyra (wind) and ignar (fire)
// — and two characters of different elements activate nothing. So the probe registers an
// account over REST and spends its starting 10 wish tickets and 1600 primogems on the gacha
// until the roster can form a resonant party, then plays *that* account in the browser. Two
// new characters are enough for any party (a duplicate element is a pair, and two new
// elements make four distinct), and the 4★ pity is 10 pulls, so 20 pulls almost always do
// it — "almost" is why the fixture retries on a fresh account instead of hoping, the same
// rule `api-check` learned when it drew for a precondition and went red 2 runs in 5.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';
import { RESONANCES, partyResonances, resonanceHint, resonanceCondition } from '../shared/src/data/resonance.js';
import { CHARACTERS } from '../shared/src/data/characters.js';
import { decodePng } from './lib/png.mjs';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/resonance-ui';
const apiBase = process.env.API_BASE || 'http://127.0.0.1:8787';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}

/* ----------------------------------------------------- the fixture, over REST ---- */

async function rest(pathname, { token, body } = {}) {
  const r = await fetch(apiBase + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

/**
 * The best party of ≤4 owned characters, and what it activates.
 *
 * Prefers a party that lights a *same-element* resonance over 四象庇护: the seven pair rows
 * are the ones a player has to build towards, so proving one of them lit is worth more than
 * proving the one the starter line-up would have given for free.
 */
function bestParty(owned) {
  const ids = [...owned];
  let best = null;
  const pick = (start, party) => {
    if (party.length) {
      const res = partyResonances(party);
      const pair = res.find((r) => !r.distinct);
      const score = (pair ? 100 : 0) + res.length * 10 + (4 - party.length);
      if (res.length && (!best || score > best.score)) best = { party: [...party], res, score };
    }
    if (party.length === 4) return;
    for (let i = start; i < ids.length; i++) { party.push(ids[i]); pick(i + 1, party); party.pop(); }
  };
  pick(0, []);
  return best;
}

const PROBE_PASS = 'resonance-probe-1';
const GEM_PER_WISH = 160;                     // shop.js; the wish route buys tickets at this rate

/**
 * An account whose roster can form a resonant party, prepared over REST.
 *
 * The accounts are **named and reused** (`resui1`…`resui6`) rather than freshly registered
 * every run: `/api/register` is rate-limited to 20 per hour per IP, and a run that burns six
 * registrations would take the whole budget from the next two runs. So the fixture logs in
 * first and only registers what does not exist yet — once one of these accounts owns a
 * resonant roster, every later run is one login and no pulls at all.
 *
 * Inside an account it spends everything it legitimately has: the welcome mail and the daily
 * sign-in (+300 primogems), whatever the achievement claims pay, its 10 starting tickets, and
 * then single pulls until the last 160 primogems are gone. Twenty-two pulls yield one or two
 * characters, and *any* two new characters make some party resonate (a repeated element is a
 * pair, two new elements make four distinct) — so this is "buy determinism with in-game
 * currency", the same trick api-check uses, spread over up to six accounts.
 */
async function accountFor(username) {
  let auth = await rest('/api/login', { body: { username, password: PROBE_PASS } });
  if (!auth.token) auth = await rest('/api/register', { body: { username, password: PROBE_PASS, nickname: 'ResProbe' } });
  return auth.token || null;
}

async function buildFixture() {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const username = `resui${attempt}`;
    const token = await accountFor(username);
    if (!token) { console.log(`  (${username}: no token — login and register both refused)`); continue; }
    // Free currency first: the welcome mail, the daily sign-in, and any achievement whose
    // progress the account already has.
    await rest('/api/mail/claim', { token, body: {} });
    await rest('/api/achievements/claim', { token, body: {} });

    let pulls = 0;
    for (;;) {
      const st = await rest('/api/player/state', { token });
      const owned = Object.keys(st.player?.characters || {});
      const best = bestParty(owned);
      if (best) {
        await rest('/api/player/party', { token, body: { party: best.party } });
        return { username, token, owned, ...best, pulls, attempt };
      }
      // The standard pool: nine 4★ characters spread over every element, against the
      // featured pool's three (all fire or lightning) — elements per pull is what this
      // fixture is buying. A 10-pull is guaranteed one 4★ by pity.
      const budget = (st.player?.wishTicket || 0) + Math.floor((st.player?.primogem || 0) / GEM_PER_WISH);
      if (budget < 1) break;
      const count = budget >= 10 ? 10 : 1;
      const r = await rest('/api/wish/pull', { token, body: { pool: 'standard', count } });
      if (r.error) break;
      pulls += count;
      // Wishing moves achievement progress, which pays primogems, which buys more wishes.
      if (count === 10) await rest('/api/achievements/claim', { token, body: {} });
    }
    console.log(`  (${username}: ${pulls} pulls, still no resonant roster — trying the next account)`);
  }
  return null;
}

console.log('--- 0. fixture: an account that can resonate');
const fx = await buildFixture();
check('the gacha produced a roster that can resonate', !!fx,
  fx ? `${fx.username}: owns ${fx.owned.join(' ')} → party ${fx.party.join(' ')} lights ${fx.res.map((r) => r.id).join(',')} (${fx.pulls} pulls this run)` : 'six accounts tried');
if (!fx) { console.log(`\nresonance-ui: ${pass} passed, ${fail} failed`); process.exit(fail); }

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
  console.log(`\n=== ${step}. ${name} → ${file}`);
  return decodePng(readFileSync(file));
}
const settle = () => p.evaluate(() => new Promise((r) => {
  requestAnimationFrame(() => requestAnimationFrame(() => r(true)));
}));
const setCanvasVisible = (v) => p.evaluate((vis) => {
  const c = document.querySelector('canvas');
  if (c) c.style.visibility = vis ? '' : 'hidden';
  return !!c;
}, v);

/** Everything the resonance list says, per row: text, computed colour, rect, DOM order. */
const rows = () => p.evaluate(() => {
  const out = {};
  let order = 0;
  // The list lives in a scrolling column, so "drawn" is not the same as "on screen": a row
  // whose rect is outside the scroller's own box is painted nowhere the player can see.
  const scroller = document.querySelector('.res-list')?.closest('.col') || document.body;
  const box = scroller.getBoundingClientRect();
  for (const el of document.querySelectorAll('.res-row')) {
    const one = (sel) => {
      const n = el.querySelector(sel);
      if (!n) return null;
      const b2 = n.getBoundingClientRect();
      return {
        text: n.textContent, color: getComputedStyle(n).color,
        rect: { x: Math.round(b2.x), y: Math.round(b2.y), w: Math.round(b2.width), h: Math.round(b2.height) },
      };
    };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out[el.dataset.res] = {
      name: one('b'), cond: one('i'), hint: one('small'),
      opacity: Number(cs.opacity), bg: cs.backgroundColor, rule: cs.borderLeftColor,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      order: order++,
      visible: r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
    };
  }
  return out;
});

/** The mean colour of the brightest `frac` of a rect — the row's ink plus its wash. */
function ink(img, r, frac = 0.15) {
  const px = [];
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * img.width + x) * 4, d = img.data;
      px.push([d[i], d[i + 1], d[i + 2], 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]]);
    }
  }
  px.sort((a, c) => c[3] - a[3]);
  const top = px.slice(0, Math.max(1, Math.round(px.length * frac)));
  const mean = (k) => Math.round(top.reduce((a, v) => a + v[k], 0) / top.length);
  return { rgb: [mean(0), mean(1), mean(2)], lum: Math.round(top.reduce((a, v) => a + v[3], 0) / top.length) };
}
/**
 * Warm ink, i.e. gold rather than the panel's pale grey.
 *
 * Deliberately a *hue* test and not "is it bright enough": even over the name element alone
 * the brightest 25% of a 12.5 px glyph run is half antialiasing, so the gold `#e8c56a`
 * (232,197,106) averages out near 150,140,105 — a threshold on the red channel would be
 * tuned to the font, while red-over-blue separates the two states by 50 points and the unlit
 * control sits on the *cool* side of zero (its text is rgba(242,234,214,.5) over a blue-grey
 * panel). Every use below pins both directions.
 */
const warm = (rgb) => rgb[0] - rgb[2] > 15 && rgb[1] > rgb[2];

/** Wait until the panel's party matches `want` (the redraw is a round trip to the API). */
async function waitParty(want) {
  for (let i = 0; i < 40; i++) {
    const got = await p.evaluate(() => [...(window.game?.party || [])]);
    if (got.length === want) return got;
    await sleep(250);
  }
  return p.evaluate(() => [...(window.game?.party || [])]);
}

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  check('the login screen offers 单机模式', await p.evaluate(() => {
    const btn = document.querySelector('[data-act="solo"]');
    if (!btn) return false;
    btn.click();
    return true;
  }));
  await sleep(400);
  // The prepared account, typed into the same two fields a player types into.
  await p.type('[data-f="user"]', fx.username);
  await p.type('[data-f="pass"]', PROBE_PASS);
  await (await p.$('[data-act="login"]')).click();
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  const me = await p.evaluate(() => ({ running: !!window.game?._running, mode: window.game?.mode }));
  check('the solo world booted on the prepared account', me.running === true && me.mode === 'solo',
    `mode ${me.mode}`);

  /* ------------------------------------------------- 1. the list, both ways ---- */
  console.log('\n--- 1. the team screen draws the table');
  await p.keyboard.press('KeyO');            // the key a player presses for 队伍
  await sleep(700);
  await settle();
  const party0 = await p.evaluate(() => [...(window.game?.party || [])]);
  check('the client is playing the party the fixture built', party0.join(',') === fx.party.join(','),
    `${party0.join(' ')} (${party0.map((id) => CHARACTERS[id].element).join('/')})`);
  await setCanvasVisible(false);
  await settle();
  const img1 = await shot('party-panel');
  const r1 = await rows();

  const ids = Object.keys(RESONANCES);
  check('every resonance in the table has a row', ids.every((id) => r1[id]),
    `${Object.keys(r1).length} rows for ${ids.length} resonances`);
  check('...and no row belongs to a resonance that does not exist',
    Object.keys(r1).every((id) => RESONANCES[id]),
    Object.keys(r1).filter((id) => !RESONANCES[id]).join(' ') || 'none');
  check('every row is named by the table, not by the panel',
    ids.every((id) => r1[id]?.name.text === RESONANCES[id].name),
    ids.map((id) => r1[id]?.name.text).join(' '));
  check('every row states what the resonance gives, in the numbers the table holds',
    ids.every((id) => r1[id]?.hint.text === resonanceHint(RESONANCES[id])),
    ids.filter((id) => r1[id]?.hint.text !== resonanceHint(RESONANCES[id])).join(' ')
    || r1[ids[0]].hint.text);
  check('...and every row is on screen, not collapsed',
    ids.every((id) => r1[id].rect.w > 120 && r1[id].rect.h > 20 && r1[id].rect.y > 0),
    `${r1[ids[0]].rect.w}×${r1[ids[0]].rect.h}`);

  /* -------------------------- 2. the party lights exactly the rows it should ---- */
  console.log('\n--- 2. lit and unlit are different pixels, not just a class');
  const wantLit = partyResonances(party0).map((r) => r.id);
  check('the shared table says this party resonates', wantLit.length >= 1,
    `${wantLit.join(' ')} from ${party0.map((id) => CHARACTERS[id].element).join('/')}`);
  const litId = wantLit.find((id) => !RESONANCES[id].distinct) || wantLit[0];
  // The control row has to be one the player can see too, or its "ink" is the page behind
  // the scroller and the comparison is between a row and a background.
  const darkId = ids.find((id) => !wantLit.includes(id) && !RESONANCES[id].distinct && r1[id].visible);

  check(`the lit row says 已激活 (${litId})`, r1[litId].cond.text === '已激活', r1[litId].cond.text);
  check('...and every unlit row says what it needs instead',
    ids.filter((id) => !wantLit.includes(id))
      .every((id) => r1[id].cond.text === resonanceCondition(RESONANCES[id])),
    r1[darkId].cond.text);
  check('the lit row is opaque and the unlit ones are dimmed',
    r1[litId].opacity === 1 && ids.filter((id) => !wantLit.includes(id)).every((id) => r1[id].opacity < 0.8),
    `${r1[litId].opacity} vs ${r1[darkId].opacity}`);
  // Order and visibility: eight rows in a scrolling column means the row that is *on* has to
  // be one the player can actually see without scrolling, so the active ones sort first.
  check('the active rows are the first rows in the list',
    wantLit.every((id) => r1[id].order < ids.filter((x) => !wantLit.includes(x))
      .reduce((m, x) => Math.min(m, r1[x].order), 99)),
    ids.map((id) => `${r1[id].order}:${id}${wantLit.includes(id) ? '*' : ''}`).sort().join(' '));
  check('...and the lit row is inside the scrolling column, not below the fold',
    r1[litId].visible === true, `y ${r1[litId].rect.y}, visible ${r1[litId].visible}`);
  check('the lit row carries a gold rule the unlit one does not',
    /rgba?\(2\d\d, 19[0-9], 10[0-9]/.test(r1[litId].rule) && /transparent|rgba\(0, 0, 0, 0\)/.test(r1[darkId].rule),
    `${r1[litId].rule} | ${r1[darkId].rule}`);

  // The pixels, over the name element of each row: same font, same size, same panel, so the
  // only reason their ink differs is the state — and the unlit row is the control that pins it.
  const nameInk = (img, r) => ink(img, r.name.rect, 0.25);
  const litInk = nameInk(img1, r1[litId]);
  const darkInk = nameInk(img1, r1[darkId]);
  check('the lit row is painted gold on screen', warm(litInk.rgb), `rgb ${litInk.rgb.join(',')}`);
  check('...and the unlit row is not', !warm(darkInk.rgb), `rgb ${darkInk.rgb.join(',')}`);
  check('...and the lit row is the brighter of the two', litInk.lum > darkInk.lum + 15,
    `${litInk.lum} vs ${darkInk.lum}`);

  /* ------------------------- 3. break the resonance the way a player would ---- */
  console.log('\n--- 3. the row follows the party');
  await setCanvasVisible(true);
  // Drop the one character whose removal actually breaks the row under test — for a pair
  // resonance that is one of the two of its element, and for 四象庇护 it is anybody.
  const dropIdx = party0.findIndex((_, i) =>
    !partyResonances(party0.filter((__, j) => j !== i)).some((r) => r.id === litId));
  const removed = party0[dropIdx];
  const clicked = await p.evaluate((i) => {
    const slot = document.querySelector(`.slot[data-slot-index="${i}"]`);
    if (!slot) return false;
    slot.click();
    return true;
  }, dropIdx);
  check('a party slot can be clicked', clicked === true && dropIdx >= 0,
    `dropping ${CHARACTERS[removed]?.name} from slot ${dropIdx}`);
  const party1 = await waitParty(party0.length - 1);
  check('the party lost that character',
    party1.length === party0.length - 1 && !party1.includes(removed), party1.join(' '));
  await setCanvasVisible(false);
  await settle();
  const img2 = await shot('resonance-broken');
  const r2 = await rows();
  const wantLit2 = partyResonances(party1).map((r) => r.id);
  check('the shared table says that resonance is gone', !wantLit2.includes(litId),
    wantLit2.join(' ') || 'none');
  check('the row went back to its requirement',
    r2[litId].cond.text === resonanceCondition(RESONANCES[litId]), r2[litId].cond.text);
  check('...and to dimmed', r2[litId].opacity < 0.8, String(r2[litId].opacity));
  const litInk2 = nameInk(img2, r2[litId]);
  check('...and its pixels lost the gold', !warm(litInk2.rgb),
    `rgb ${litInk2.rgb.join(',')} was ${litInk.rgb.join(',')}`);
  // The control: nothing about the resonance nobody in this party is building towards
  // changed, so nothing about its row may change either.
  check('the row for a resonance nothing touched did not move',
    r2[darkId].cond.text === r1[darkId].cond.text && r2[darkId].opacity === r1[darkId].opacity
    && Math.abs(nameInk(img2, r2[darkId]).lum - darkInk.lum) < 12,
    `${darkId} lum ${nameInk(img2, r2[darkId]).lum} vs ${darkInk.lum}`);

  await setCanvasVisible(true);
  const readded = await p.evaluate((id) => {
    const row = document.querySelector(`[data-add="${id}"]`);
    if (!row) return false;
    row.click();
    return true;
  }, removed);
  check('the character can be put back from 拥有的角色', readded === true, removed);
  const party2 = await waitParty(party0.length);
  check('the party is whole again', party2.length === party0.length && party2.includes(removed),
    party2.join(' '));
  await setCanvasVisible(false);
  await settle();
  const img3 = await shot('resonance-restored');
  const r3 = await rows();
  check('the row lit again', r3[litId].cond.text === '已激活' && r3[litId].opacity === 1,
    `${r3[litId].cond.text} @ ${r3[litId].opacity}`);
  check('...in gold pixels again', warm(nameInk(img3, r3[litId]).rgb),
    `rgb ${nameInk(img3, r3[litId]).rgb.join(',')}`);

  check('no page errors through any of it', !errors.length, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL probe threw — ${e?.stack || e}`);
} finally {
  await b.close();
}

console.log(`\nresonance-ui: ${pass} passed, ${fail} failed`);
process.exit(fail);
