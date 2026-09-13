// 探索度 probe: the percentage a player reads, and the two events that move it.
//
//   DISPLAY=:99 node tools/explore-check.mjs [baseUrl] [outDir]
//
// `api-check.mjs` proves the *derivation*: 探索度 is a query over the `world_progress` rows three
// routes have been writing since the first commit, a 秘境 reports none, an anchor counts through
// `isAnchorUnlocked`, and the achievement reads the best zone. None of that is a player-visible
// fact. What a player sees is a number on the zone row of the map, a line in the footer saying
// what is left, and a toast at the moment a chest moves it — and the first run of this file found
// that the last of those could not possibly have worked: `_openChest` ended with
// `this._reportLoot(res.loot, it)` and **no such method existed**, so every chest open threw a
// TypeError into `_interact`'s catch. Red 「未知错误」 toast, no loot line, and (the throw skipped
// the next statement) `_applyQuestUpdates` never ran. The server was right the whole time; 44
// probes and a REST-level chest test all passed. Nothing had ever photographed opening a chest.
//
// So this probe drives the product's own input path and reads the product's own output:
//   * the map's zone rows print a percentage for every 开放世界 zone and none for a 秘境, and each
//     one equals `zoneExploration` recomputed here from the save the page is holding;
//   * the footer's breakdown is the same numbers spelled out, per type;
//   * a *mouse click* on a chest 6 m away opens it, names the loot, and toasts the 探索度 it just
//     moved — with the delta the rows say, not a number the client invented;
//   * the last find in a zone reports 探索完成 as a banner instead of a toast (both halves: the
//     mid-zone chest must NOT banner, the last one must NOT toast);
//   * at 100% the row's percentage is gold — asserted as a computed colour against the colour of
//     an unfinished zone's row on the same screen, because a `classList` check passes while the
//     pixels are wrong;
//   * and `/api/achievements` reports the same 100 the panel is printing, so 踏遍此地 and the map
//     cannot disagree.
//
// Second half: the **milestone ladder** the percentage pays (`EXPLORE_MILESTONES`). Until it
// existed 探索度 paid only through two *global* achievements (best zone, finished zones), so the
// second and third zone paid nothing at all for the same walk. The reward is a per-zone ladder,
// priced off that zone's own chests, and *claimed* — which means there is a button, and a button
// has two states that both have to be photographed:
//   * nothing to collect → disabled, and it still prices the next step (「下一档 20% · 摩拉 ×1,417
//     · 原石 ×1」), because a disabled button with no number is a dead end;
//   * something to collect → the zone row grows a 🎁 in its *text* and turns cyan, the button
//     names the total, pressing it moves the purse by exactly that total, and the 🎁 goes away.
// The cyan is load-bearing and asserted against gold: a zone at 100% with an unclaimed step
// carries both `.full` and `.ready`, so if the two shared a colour the biggest reward in the game
// would be invisible on exactly the zone that has it.
//
// The zone is finished through the same REST routes the client calls, folded in with the same
// `_applyPlayer` the panels use — walking 440 m to nine POIs would take the probe half an hour —
// except for the *last* find, which is a real click in the world, because the 100% banner is the
// thing being tested.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { ZONES, puzzleNodes } from '../shared/src/data/zones.js';
import {
  zoneExploration, explorables, exploreText, exploreClaim, exploreClaims, milestoneRewards,
  zoneChestValue, EXPLORE_TYPES, EXPLORED_KINDS, EXPLORE_MILESTONES, MILESTONE_KEY,
} from '../shared/src/data/exploration.js';
import { rewardList } from '../shared/src/data/items.js';
import { ACH_BY_ID, achState } from '../shared/src/data/achievements.js';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/explore';
const W = 1200, H = 800;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}

/* ------------------------------------------------------- the zone, in Node -- */

const zone = ZONES.mondstadt;
// The chest the click test opens (ungated, 55,72) and the chest held back to be the *last*
// find in the zone, so the 100% banner has a real interaction behind it.
const clickChest = (zone.poi || []).find((x) => x.id === 'mond_chest1');
const lastChest = (zone.poi || []).find((x) => x.id === 'mond_chest3');
const openZones = Object.values(ZONES).filter((z) => EXPLORED_KINDS.has(z.kind));
const dungeonZones = Object.values(ZONES).filter((z) => !EXPLORED_KINDS.has(z.kind));

/**
 * The panel's own label for a reward block, rebuilt here from the two shared functions the panel
 * uses (`rewardList` for the order and the names, `num` for the grouping comma). The *amounts*
 * still come from `milestoneRewards`, so what this pins is that the button prints the block the
 * server pays — a label built by hand would drift the day 原石 gets renamed.
 */
const price = (r) => rewardList(r)
  .map((row) => `${row.name} ×${Math.round(row.n).toLocaleString('en-US')}`).join(' · ');
const stepOf = (pct) => milestoneRewards(zone).find((s) => s.pct === pct)?.rewards || {};
/** The same, for any zone — the chip's routing test owes a *second* zone's ladder. */
const stepOfZone = (zdef, pct) => milestoneRewards(zdef).find((s) => s.pct === pct)?.rewards || {};
/** The HUD chip's tooltip line for one owing zone, rebuilt from the same two numbers. */
const giftLine = (zdef, cl) => `${zdef.name} ${cl.pct}% · ${cl.claimable.length} 档 · `
  + `摩拉 ${cl.reward.mora.toLocaleString('en-US')} · 原石 ${cl.reward.primogem.toLocaleString('en-US')}`;
/** The sum of a set of steps, the way both the route and the button add them up. */
const sumSteps = (pcts) => pcts.reduce((a, pct) => ({
  mora: a.mora + (stepOf(pct).mora || 0), primogem: a.primogem + (stepOf(pct).primogem || 0),
}), { mora: 0, primogem: 0 });

/** Every explorable in the zone except the two chests this probe opens by hand. */
function restPlan() {
  const plan = [];
  for (const poi of explorables(zone)) {
    if (poi.id === clickChest.id || poi.id === lastChest.id) continue;
    const spec = EXPLORE_TYPES[poi.type];
    if (spec.writer.endsWith('/unlock')) plan.push({ kind: 'unlock', poiId: poi.id });
    else if (poi.type === 'chest') plan.push({ kind: 'chest', poiId: poi.id });
    else if (poi.type === 'puzzle') {
      for (const n of puzzleNodes(zone, poi)) plan.push({ kind: 'puzzle', poiId: poi.id, nodeId: n.id });
    }
  }
  // Chests last: `mond_chest4` is gated on `puzzle:mond_puzzle1`, and the server enforces it.
  return plan.sort((a, b) => (a.kind === 'chest' ? 1 : 0) - (b.kind === 'chest' ? 1 : 0));
}

/* ----------------------------------------------------------------- the page -- */

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
}

/** The save the page is holding, plus whatever the two announcement channels have said. */
const state = () => p.evaluate(() => ({
  zone: window.game.zoneId,
  progress: JSON.parse(JSON.stringify(window.game.player?.worldProgress || {})),
  toasts: window.__toasts.slice(),
  banners: window.__banners.slice(),
  chat: [...document.querySelectorAll('.chatlog .ln')].map((n) => n.textContent),
  me: { x: +window.game.me.x.toFixed(2), z: +window.game.me.z.toFixed(2) },
}));

const clearSaid = () => p.evaluate(() => { window.__toasts.length = 0; window.__banners.length = 0; });

/** Move the way fast travel does — the server owns the position and corrects a bare teleport. */
async function hopTo(x, z, ry = null) {
  await p.evaluate(([tx, tz, r]) => {
    const g = window.game;
    const y = g.world.heightAt(tx, tz);
    g.me.teleportTo(tx, y, tz, r ?? g.me.ry);
    g.rig.snapToFocus({ x: tx, y, z: tz }, g.me.height);
    g.socket.joinZone(g.zoneId, { x: tx, z: tz });
  }, [x, z, ry]);
  await sleep(2500);
  const at = await p.evaluate(() => ({ x: window.game.me.x, z: window.game.me.z }));
  return { dist: Math.hypot(at.x - x, at.z - z), at };
}

/** Open the map with the key a player presses, and wait for the pins to be laid out. */
async function openMap() {
  await p.evaluate(() => document.querySelector('canvas')?.focus());
  await p.keyboard.press('KeyM');
  await sleep(1500);
  return p.evaluate(() => document.querySelectorAll('.list-row[data-zone]').length);
}
async function closeMap() {
  await p.keyboard.press('KeyM');
  await sleep(700);
}

/** What the map panel is *showing* about exploration, read out of the DOM. */
const mapDom = () => p.evaluate(() => {
  const rows = [...document.querySelectorAll('.list-row[data-zone]')].map((r) => {
    const tag = r.querySelector('.explore');
    const cs = tag ? getComputedStyle(tag) : null;
    const box = tag ? tag.getBoundingClientRect() : null;
    return {
      zone: r.dataset.zone,
      pct: r.dataset.explore ?? null,
      text: tag ? tag.textContent : null,
      title: tag ? tag.title : null,
      full: tag ? tag.classList.contains('full') : null,
      ready: r.dataset.exploreReady ?? null,
      color: cs ? cs.color : null,
      w: box ? Math.round(box.width) : 0,
      h: box ? Math.round(box.height) : 0,
    };
  });
  const foot = [...document.querySelectorAll('footer span')].map((n) => n.textContent);
  const btn = document.querySelector('[data-act="explore-claim"]');
  const claim = btn ? {
    text: btn.textContent, disabled: !!btn.disabled, ready: btn.dataset.ready,
    zone: btn.dataset.zone, title: btn.title,
    w: Math.round(btn.getBoundingClientRect().width),
    h: Math.round(btn.getBoundingClientRect().height),
  } : null;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const purse = { mora: window.game.player?.mora ?? 0, primogem: window.game.player?.primogem ?? 0 };
  return {
    rows, foot, claim, purse, gold: css('--gold'), accent: css('--accent'),
    selected: document.querySelector('.list-row[data-zone].sel')?.dataset.zone || null,
  };
});

/**
 * The colour a theme variable actually paints. `classList` is not evidence — a renamed variable or
 * a losing selector leaves the class on and the pixels wrong — so every colour claim in this file
 * is a computed `rgb()` compared against another row on the same screen.
 */
const cssRgb = (hex) => p.evaluate((v) => {
  const el = document.createElement('span');
  el.style.color = v; document.body.appendChild(el);
  const c = getComputedStyle(el).color; el.remove(); return c;
}, hex);

/**
 * The HUD's 探索奖励 chip, read out of the currency row. `hidden` *and* the rect: a chip that lost
 * its `hidden` class but is 0 px wide is invisible, and one that kept the class while the rule was
 * renamed is a badge nobody can miss on a save that owes nothing.
 */
const hudGift = () => p.evaluate(() => {
  const el = document.querySelector('[data-act="explore"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const mail = document.querySelector('[data-act="mail"]');
  return {
    n: el.querySelector('b')?.textContent ?? null,
    hiddenClass: el.classList.contains('hidden'),
    w: Math.round(r.width), h: Math.round(r.height),
    color: getComputedStyle(el).color, title: el.title, text: el.textContent,
    // The control for the colour claim: the same `.mail-chip` box, one class less. `.gift` has to
    // *win* — three chips in one row that share a colour read as one errand.
    mailColor: mail ? getComputedStyle(mail).color : null,
  };
});

/** Press 「领取探索奖励」 the way a player does, and wait for the panel to redraw. */
async function pressClaim() {
  const before = await p.evaluate(() => window.game.player?.mora ?? 0);
  await p.click('[data-act="explore-claim"]');
  for (let i = 0; i < 40; i++) {
    const now = await p.evaluate(() => window.game.player?.mora ?? 0);
    if (now !== before) break;
    await sleep(400);
  }
  await sleep(900);
}

/** The same percentage, computed here, from the save the page just handed over. */
function derive(z, progress) {
  return zoneExploration(z, progress?.[z.id] || {});
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
  await (await p.$('[data-act="guest"]')).click();
  for (let i = 0; i < 90; i++) {
    if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) break;
    await sleep(1000);
  }
  check('the solo world booted on a fresh guest save', await p.evaluate(() => !!window.game?._running));
  const token = await p.evaluate(() => localStorage.getItem('teyvat.token'));

  // Both announcement channels, recorded from before anything can fire them: `toast` and
  // `banner` are fire-and-forget DOM that removes itself on `animationend`, so a probe that
  // screenshots afterwards has no way to see what they said. The panel manager is captured too
  // — `openMap` has to be able to prove the map is the panel that opened.
  await p.evaluate(() => {
    window.__toasts = [];
    window.__banners = [];
    window.game.on('toast', (t) => window.__toasts.push({ text: t.text, kind: t.kind || '' }));
    window.game.on('banner', (t) => window.__banners.push({ title: t.title, sub: t.sub || '' }));
  });

  await p.evaluate(() => {
    window.game.setAutoQuality(false);
    window.game.setQuality('high');
    window.game.setWorldTime(12);
  });
  await sleep(2000);
  check('the quality tier is pinned high', (await p.evaluate(() => window.game.quality)) === 'high',
    await p.evaluate(() => window.game.quality));

  /* --------------------------------------- the HUD chip owes nothing, yet -- */

  // The ladder's two surfaces are both *inside* the map panel — the zone row and the footer
  // button — so the reward existed only for a player who reopened the map. The 🎁 chip is the
  // door, and its first obligation is silence: a save that owes nothing must not wear a badge.
  // Rect as well as class, because `display:none` is what makes it invisible and a renamed rule
  // would leave the class check green (`assert-style-not-class`).
  const gift0 = await hudGift();
  check('the HUD carries a 探索奖励 chip, silent while nothing is owed',
    !!gift0 && gift0.hiddenClass === true && gift0.w === 0 && gift0.h === 0 && gift0.n === '0',
    JSON.stringify(gift0));

  /* ------------------------------------------- the percentage on a fresh save -- */

  const opened = await openMap();
  check('the M key opens the map', opened > 0, `${opened} zone rows`);
  await shot('map-fresh');

  const s0 = await state();
  const dom0 = await mapDom();
  check('the map lists every zone', dom0.rows.length === Object.keys(ZONES).length,
    `${dom0.rows.length} rows, ${Object.keys(ZONES).length} zones`);

  // Both directions of the same rule: an open-world zone carries a percentage, a 秘境 carries
  // none. One-sided ("every row I look at has a number") would pass on a build that printed a
  // meaningless 50% on every dungeon door.
  const openRows = dom0.rows.filter((r) => openZones.some((z) => z.id === r.zone));
  const dungRows = dom0.rows.filter((r) => dungeonZones.some((z) => z.id === r.zone));
  // `.every` over an empty list is true, and both lists come from `EXPLORED_KINDS` — the very
  // thing under test. Widening that set to `['open','dungeon']` empties `dungeonZones`, and the
  // second check below would then pass by having nothing to look at (the MUT4 run showed exactly
  // that: it was the fresh-save interval, not this pair, that went red). So each side asserts
  // its own list is populated first.
  check('every 开放世界 zone row prints a 探索度',
    openZones.length >= 3 && openRows.length === openZones.length
    && openRows.every((r) => /^\d+%$/.test(r.text || '')),
    openRows.map((r) => `${r.zone} ${r.text}`).join(' '));
  check('and no 秘境 row does',
    dungeonZones.length >= 1 && dungRows.length === dungeonZones.length
    && dungRows.every((r) => !r.text && r.pct === null),
    `${dungeonZones.length} 秘境 · ${dungRows.map((r) => `${r.zone} ${JSON.stringify(r.text)}`).join(' ')}`);
  check('the percentage is rendered, not a zero-size element',
    openRows.every((r) => r.w > 8 && r.h > 6), openRows.map((r) => `${r.w}×${r.h}`).join(' '));

  let ok = true, why = [];
  for (const z of openZones) {
    const want = derive(z, s0.progress);
    const row = dom0.rows.find((r) => r.zone === z.id);
    if (row?.text !== `${want.pct}%` || row?.pct !== String(want.pct)) {
      ok = false; why.push(`${z.id} dom ${row?.text} derived ${want.pct}%`);
    }
    if (row?.title !== `探索度 ${want.found}/${want.total}${want.byType.map((t) => ` · ${t.label} ${t.found}/${t.total}`).join('')}`) {
      ok = false; why.push(`${z.id} title ${JSON.stringify(row?.title)}`);
    }
  }
  check('each row is the derivation over the rows this save actually has', ok,
    why.length ? why.join('; ') : openZones.map((z) => `${z.id} ${derive(z, s0.progress).pct}%`).join(' '));

  // A fresh save has walked into exactly one anchor (the zone entry, free by definition), so
  // every zone must read low — bounded from both sides, because "no zone is at 100%" is also
  // true of a build that reports 0% forever, and "the number is above 0" is also true of a
  // build that hands out a free 50% for the dungeon door it should not be counting.
  const fresh = openZones.map((z) => derive(z, s0.progress).pct);
  check('a fresh save is barely explored, but not at zero either',
    fresh.every((v) => v > 0 && v <= 20), fresh.map((v) => `${v}%`).join(' '));

  const wantFoot = (() => {
    const r = derive(zone, s0.progress);
    return `探索度 ${r.pct}% (${r.found}/${r.total})${r.byType.map((t) => ` · ${t.label} ${t.found}/${t.total}`).join('')}`;
  })();
  check('the footer spells the selected zone out, per type',
    dom0.selected === zone.id && dom0.foot.some((t) => t === wantFoot),
    `want ${wantFoot} · got ${JSON.stringify(dom0.foot)}`);

  // The ladder's *disabled* state — where this button spends most of its life, and the state a
  // build with no reward at all also produces. So it is not enough that the press does nothing:
  // it has to price the rung it is waiting for, off the zone's own chests.
  const rung0 = EXPLORE_MILESTONES[0];
  check('the map footer prices the first rung before it can be claimed',
    !!dom0.claim && dom0.claim.zone === zone.id && dom0.claim.disabled && dom0.claim.ready === '0'
    && dom0.claim.text === `下一档 ${rung0}% · ${price(stepOf(rung0))}`
    && dom0.claim.w > 60 && dom0.claim.h > 12,
    JSON.stringify(dom0.claim));
  // And the other side: arrival is below the first rung, so *no* zone may offer a claim. A build
  // that paid the ladder on arrival (or forgot the high-water mark) lights every row here.
  check('and a fresh save has nothing to collect anywhere',
    dom0.rows.every((r) => !(r.text || '').includes('🎁'))
    && dom0.rows.every((r) => r.ready === null || r.ready === '0'),
    dom0.rows.map((r) => `${r.zone} ${JSON.stringify(r.text)}/${r.ready}`).join(' '));
  // The title is the whole ladder, so a player can see what the walk is worth before walking it.
  check('the button hovers the whole ladder, and it sums to the zone chest value',
    EXPLORE_MILESTONES.every((m) => (dom0.claim?.title || '').includes(`${m}% ${price(stepOf(m))}`))
    && price(sumSteps(EXPLORE_MILESTONES)) === price(zoneChestValue(zone)),
    `${JSON.stringify(dom0.claim?.title)} · Σ ${price(sumSteps(EXPLORE_MILESTONES))} vs chests ${price(zoneChestValue(zone))}`);

  await closeMap();
  check('the map closes again on the same key',
    await p.evaluate(() => !document.querySelector('.list-row[data-zone]')));

  /* ------------------------------------------------- a chest, opened by hand -- */

  await clearSaid();
  const before = await state();
  const pctBefore = derive(zone, before.progress);

  // Six metres away, so the click has to walk there and interact on arrival — a different code
  // path from pressing F in range, and the one a mouse-first game is played through.
  const away = 6;
  const ang = Math.atan2(clickChest.at[0] - 20, clickChest.at[1] - 20) || 0.6;
  const stand = { x: clickChest.at[0] - Math.sin(ang) * away, z: clickChest.at[1] - Math.cos(ang) * away };
  const hop = await hopTo(stand.x, stand.z, ang);
  check('the player is standing six metres from the chest', hop.dist < 1.5, `${hop.dist.toFixed(1)} m off`);
  await p.evaluate(([fx, fz]) => {
    window.game.rig.faceDirection(fx, fz);
    window.game.rig.pitch = 0.25;
  }, [Math.sin(ang), Math.cos(ang)]);
  await sleep(900);

  // The aim point is derived from the world through the camera and re-derived per attempt: a
  // fixed screen fraction clicks whatever happens to be under it. The click path raycasts the
  // *terrain* and then looks for an interactable near the hit, so aim at the ground a metre in
  // front of the chest, inside its interact radius.
  let target = null, usedPitch = null;
  for (const pitch of [0.25, 0.08, -0.1, 0.42, -0.26]) {
    await p.evaluate((v) => { window.game.rig.pitch = v; }, pitch);
    await sleep(600);
    target = await p.evaluate(([cx, cz, sx, sz]) => {
      const g = window.game;
      const gx = cx - sx * 0.9, gz = cz - sz * 0.9;
      const pt = g.overlay.project(gx, g.world.heightAt(gx, gz) + 0.05, gz, 999);
      if (!pt) return null;
      const inside = pt.x > 60 && pt.x < g.overlay._w - 60 && pt.y > 60 && pt.y < g.overlay._h - 60;
      return inside ? { x: pt.x, y: pt.y } : null;
    }, [clickChest.at[0], clickChest.at[1], Math.sin(ang), Math.cos(ang)]);
    if (target) { usedPitch = pitch; break; }
  }
  check('the chest can be brought under the cursor', !!target,
    target ? `pitch ${usedPitch} -> ${target.x.toFixed(0)},${target.y.toFixed(0)}` : 'never on screen');
  if (target) await p.mouse.click(target.x, target.y);

  // Poll for the row, not for a fixed sleep: llvmpipe runs this page at 2-3 fps and the walk is
  // metres of it.
  let openedChest = false;
  for (let i = 0; i < 50; i++) {
    openedChest = await p.evaluate((id) => !!window.game.player?.worldProgress?.mondstadt?.[id]?.opened, clickChest.id);
    if (openedChest) break;
    await sleep(600);
  }
  await sleep(1500);
  const after = await state();
  await shot('after-chest');
  check('a click on a distant chest walks over and opens it', openedChest,
    `walked ${Math.hypot(after.me.x - hop.at.x, after.me.z - hop.at.z).toFixed(1)} m`);

  // The regression this file was written for. A chest that pays out and then throws looks like
  // this: a `bad` toast, an uncaught TypeError in the console, and nothing naming the loot.
  const bad = after.toasts.filter((t) => t.kind === 'bad');
  check('opening a chest raises no error toast', bad.length === 0, JSON.stringify(bad));
  check('and no page error', errors.length === 0, errors.slice(-3).join(' | '));
  const lootToast = after.toasts.find((t) => t.text.startsWith('获得'));
  check('the chest says what it paid', !!lootToast && /摩拉|×/.test(lootToast.text),
    JSON.stringify(after.toasts.map((t) => t.text)));
  check('and it lands in the chat log too',
    after.chat.some((l) => l.includes('获得')), JSON.stringify(after.chat.slice(-3)));

  const pctAfter = derive(zone, after.progress);
  const gained = pctAfter.pct - pctBefore.pct;
  const exploreToast = after.toasts.find((t) => t.text.startsWith('探索度'));
  // The suffix is derived, not spelled out: this chest happens to cross the first rung (11% → 22%),
  // and the toast has to say so — a reward nobody is told about is a reward nobody collects. Asking
  // `exploreClaim` for the suffix keeps the assertion honest if the ladder is ever re-priced.
  const claimAt22 = exploreClaim(zone, after.progress?.[zone.id] || {});
  const wantToast = `探索度 ${pctAfter.pct}%（+${gained}%）`
    + (claimAt22.claimable.length ? ' · 探索奖励可领取（M 键 → 领取）' : '');
  check('the chest reports the 探索度 it moved, with the number the rows say',
    !!exploreToast && exploreToast.text === wantToast,
    `${JSON.stringify(exploreToast?.text)} want ${JSON.stringify(wantToast)} · rows ${pctAfter.found}/${pctAfter.total} = ${pctAfter.pct}%, was ${pctBefore.pct}%`);
  check('and crossing the first rung is what it announced',
    claimAt22.claimable.length === 1 && claimAt22.claimable[0] === rung0 && pctAfter.pct >= rung0,
    `${pctAfter.pct}% claimable ${JSON.stringify(claimAt22.claimable)}`);
  check('a mid-zone find is a toast and not a 探索完成 banner',
    pctAfter.pct < 100 && !after.banners.some((x) => x.title === '探索完成'),
    JSON.stringify(after.banners));

  // The chest crossed a rung with every panel closed — which is where a player actually is when it
  // happens. The toast says so once and then removes itself; the chip is what is still there a
  // minute later, and it is the only surface outside the map panel that says anything at all.
  const gift1 = await hudGift();
  const accent0 = await cssRgb(await p.evaluate(() => getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim()));
  await shot('hud-gift-lit');
  check('crossing a rung lights the chip, with the rung count on it',
    !!gift1 && gift1.hiddenClass === false && gift1.w > 12 && gift1.h > 8
    && gift1.n === String(claimAt22.claimable.length) && gift1.text.includes('🎁'),
    JSON.stringify(gift1));
  check('the chip names the zone to walk to and what the press is worth',
    gift1.title.startsWith(`有 ${claimAt22.claimable.length} 档探索奖励可领取`)
    && gift1.title.includes(giftLine(zone, claimAt22)),
    `${JSON.stringify(gift1.title)} want line ${JSON.stringify(giftLine(zone, claimAt22))}`);
  check('and it is the map row’s cyan, not the mail chip’s gold',
    gift1.color === accent0 && gift1.mailColor && gift1.color !== gift1.mailColor,
    `gift ${gift1.color} · --accent ${accent0} · mail ${gift1.mailColor}`);

  await openMap();
  const dom1 = await mapDom();
  await shot('map-after-chest');
  const row1 = dom1.rows.find((r) => r.zone === zone.id);
  check('the map row has moved to the same percentage',
    row1?.pct === String(pctAfter.pct) && row1.text.startsWith(`${pctAfter.pct}%`) && row1.full === false,
    `${JSON.stringify(row1?.text)} (was ${pctBefore.pct}%), full ${row1?.full}`);
  check('and the footer counts one more 宝箱',
    dom1.foot.some((t) => t.includes(`宝箱 ${pctAfter.byType.find((x) => x.label === '宝箱').found}/`)),
    JSON.stringify(dom1.foot.filter((t) => t.includes('探索度'))));

  // A crossed rung is announced three ways, and this is the one that survives the toast fading: the
  // row grows a 🎁 in its *text* (colour alone is not a message), and the number turns cyan.
  const accentRgb = await cssRgb(dom1.accent);
  const otherRows = dom1.rows.filter((r) => r.zone !== zone.id && openZones.some((z) => z.id === r.zone));
  check('the zone with an unclaimed rung is marked in text, not only in colour',
    row1?.text === `${pctAfter.pct}% 🎁` && row1.ready === '1'
    && row1.title.includes(`有 1 档探索奖励可领取`),
    `${JSON.stringify(row1?.text)} ready ${row1?.ready} · ${JSON.stringify(row1?.title)}`);
  check('and it is cyan, where a zone with nothing to collect is not',
    row1?.color === accentRgb && otherRows.length >= 2
    && otherRows.every((r) => r.color !== accentRgb && !r.text.includes('🎁') && r.ready === '0'),
    `${zone.id} ${row1?.color} = --accent ${dom1.accent} · others ${otherRows.map((r) => `${r.zone} ${JSON.stringify(r.text)} ${r.color}`).join(' ')}`);
  check('the footer button now offers exactly that rung, at the price the table says',
    dom1.claim?.disabled === false && dom1.claim.ready === '1'
    && dom1.claim.text === `领取探索奖励 · ${price(stepOf(rung0))}`
    && dom1.claim.title.includes(`${rung0}% ${price(stepOf(rung0))} ←可领取`),
    `${JSON.stringify(dom1.claim?.text)} disabled ${dom1.claim?.disabled}`);
  await closeMap();

  /* ------------------------------------- everything but the last find, by REST -- */

  const plan = restPlan();
  const restRes = await p.evaluate(async ([tok, zid, steps]) => {
    const out = [];
    for (const s of steps) {
      const path = s.kind === 'unlock' ? '/api/world/unlock' : s.kind === 'chest' ? '/api/world/chest' : '/api/world/puzzle';
      const body = { zone: zid, poiId: s.poiId };
      if (s.nodeId) body.nodeId = s.nodeId;
      const r = await fetch(`http://127.0.0.1:8787${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      // Folded in the way the panels fold a REST reply in, so the map reads the same save the
      // server just wrote.
      if (j.player) window.game._applyPlayer(j.player, false);
      out.push({ ...s, status: r.status, pct: j.explore?.pct ?? null });
    }
    return out;
  }, [token, zone.id, plan]);
  check('the rest of the zone can be found through the same routes the client calls',
    restRes.every((r) => r.status === 200), restRes.filter((r) => r.status !== 200)
      .map((r) => `${r.kind}:${r.poiId}=${r.status}`).join(' ') || `${restRes.length} calls, all 200`);

  await clearSaid();
  const s2 = await state();
  const pre100 = derive(zone, s2.progress);
  check('one find short of the whole zone', pre100.found === pre100.total - 1 && pre100.pct < 100,
    exploreText(pre100));

  // The chip counts rungs, not zones: four owed by one zone is a 4, or a player who walked past
  // three rungs in one session would see the same 1 they saw after the first.
  const gift2 = await hudGift();
  check('the chip counts every rung the walk passed, not the zones',
    gift2.hiddenClass === false && gift2.n === '4' && gift2.w > 12,
    JSON.stringify({ n: gift2.n, hidden: gift2.hiddenClass, w: gift2.w }));

  await openMap();
  const dom2 = await mapDom();
  const row2 = dom2.rows.find((r) => r.zone === zone.id);
  const other = dom2.rows.find((r) => r.zone !== zone.id && openZones.some((z) => z.id === r.zone));
  check('99% is not 100%: the row has not gone gold',
    row2?.pct === String(pre100.pct) && row2.text.startsWith(`${pre100.pct}%`) && row2.full === false,
    `${JSON.stringify(row2?.text)} full ${row2?.full}`);
  // The control every colour claim below is measured against: an open-world zone that is neither
  // finished nor holding a reward. It cannot be 蒙德 — 蒙德 is cyan right now, which is the point.
  const plainColor = other?.color;
  await shot('map-one-short');

  /* ----------------------------------------- four rungs at once, by button -- */

  // A ladder is a high-water mark, not a queue: 89% owes 20/40/60/80 and one press must settle all
  // four. (Four presses would be the same money, but it is the kind of UI that makes a player think
  // they lost one.) The label, the toast and the purse are all asserted against the same sum.
  const owed = exploreClaim(zone, s2.progress?.[zone.id] || {});
  const owedSum = sumSteps(owed.claimable);
  check('one press owes every rung the walk passed', owed.claimable.length === 4
    && owed.claimable.join(',') === '20,40,60,80' && owed.paid === 0,
    `claimable ${JSON.stringify(owed.claimable)} paid ${owed.paid} at ${owed.pct}%`);
  check('the button names all four and their total',
    dom2.claim?.disabled === false && dom2.claim.ready === '4'
    && dom2.claim.text === `领取探索奖励 ×4 · ${price(owedSum)}`,
    `${JSON.stringify(dom2.claim?.text)} want ×4 · ${price(owedSum)}`);

  await clearSaid();
  const purseBefore = dom2.purse;
  await pressClaim();
  const dom4 = await mapDom();
  const s4 = await state();
  await shot('map-claimed');
  const paidPct = await p.evaluate(([zid, key]) =>
    window.game.player?.worldProgress?.[zid]?.[key]?.pct ?? null, [zone.id, MILESTONE_KEY]);
  check('the purse moves by exactly the sum on the button',
    dom4.purse.mora - purseBefore.mora === owedSum.mora
    && dom4.purse.primogem - purseBefore.primogem === owedSum.primogem,
    `+${dom4.purse.mora - purseBefore.mora} 摩拉 +${dom4.purse.primogem - purseBefore.primogem} 原石, want ${price(owedSum)}`);
  check('the toast lists the rungs it settled',
    s4.toasts.some((t) => t.text === `探索奖励 ${owed.claimable.map((v) => `${v}%`).join('、')}：${price(owedSum)}`
      && t.kind === 'gold'),
    JSON.stringify(s4.toasts.map((t) => `${t.kind}:${t.text}`)));
  check('the paid mark is one world_progress row, and nothing else',
    paidPct === 80 && derive(zone, s4.progress).pct === pre100.pct
    && derive(zone, s4.progress).total === pre100.total,
    `${MILESTONE_KEY} = ${paidPct} · ${exploreText(derive(zone, s4.progress))}`);
  const row4 = dom4.rows.find((r) => r.zone === zone.id);
  check('the 🎁 goes away and the row returns to a plain colour',
    row4?.text === `${pre100.pct}%` && row4.ready === '0' && row4.color === plainColor
    && !row4.title.includes('可领取'),
    `${JSON.stringify(row4?.text)} ${row4?.color} vs plain ${plainColor}`);
  check('and the button prices the last rung it cannot pay yet',
    dom4.claim?.disabled === true && dom4.claim.ready === '0'
    && dom4.claim.text === `下一档 100% · ${price(stepOf(100))}`
    && dom4.claim.title.includes(`80% ${price(stepOf(80))} ✓`),
    `${JSON.stringify(dom4.claim?.text)} disabled ${dom4.claim?.disabled}`);
  await closeMap();
  // The other direction, on the same save that just wore a 4: paying the ladder off has to put the
  // chip away. A badge that never clears is worse than no badge — it trains the player to ignore it.
  const gift4 = await hudGift();
  check('paying the rungs puts the chip away again',
    gift4.hiddenClass === true && gift4.w === 0 && gift4.n === '0',
    JSON.stringify({ n: gift4.n, hidden: gift4.hiddenClass, w: gift4.w }));

  /* ------------------------------------------------ the last find, by hand -- */

  const ang2 = Math.atan2(lastChest.at[0] - 60, lastChest.at[1] - 60) || 0.6;
  // Inside the chest's own interactable radius this time, so F is in range on arrival.
  const stand2 = { x: lastChest.at[0] - Math.sin(ang2) * 1.6, z: lastChest.at[1] - Math.cos(ang2) * 1.6 };
  const hop2 = await hopTo(stand2.x, stand2.z, ang2);
  check('the player reaches the last chest in the zone', hop2.dist < 1.5, `${hop2.dist.toFixed(1)} m off`);
  await sleep(1200);
  await p.evaluate(() => document.querySelector('canvas')?.focus());
  const prompt = await p.evaluate(() => (window.game.prompt ? {
    id: window.game.prompt.entry.id, txt: window.game.prompt.txt, disabled: !!window.game.prompt.disabled,
  } : null));
  check('it prompts to open it', prompt?.id === lastChest.id && !prompt.disabled, JSON.stringify(prompt));
  await p.keyboard.press('KeyF');
  let done100 = false;
  for (let i = 0; i < 40; i++) {
    done100 = await p.evaluate((id) => !!window.game.player?.worldProgress?.mondstadt?.[id]?.opened, lastChest.id);
    if (done100) break;
    await sleep(600);
  }
  await sleep(1500);
  const s3 = await state();
  await shot('after-last-chest');
  const full = derive(zone, s3.progress);
  check('the last chest opens and the zone is fully explored', done100 && full.pct === 100,
    exploreText(full));
  // The other half of the pair asserted above: the completing find banners, and does *not*
  // spend the moment on a 「探索度 100%（+11%）」 toast.
  check('finishing a zone is announced as 探索完成',
    s3.banners.some((x) => x.title === '探索完成' && x.sub.includes(zone.name) && x.sub.includes('100%')),
    JSON.stringify(s3.banners));
  check('and not as another 探索度 toast',
    !s3.toasts.some((t) => t.text.startsWith('探索度')),
    JSON.stringify(s3.toasts.map((t) => t.text)));
  // The banner is the one moment the biggest rung in the zone is worth mentioning, and it is also
  // the moment the toast channel is *not* used — so if the prize line only lived in the toast
  // branch, the last and largest reward would be the only one never announced.
  check('the 100% banner also says a reward is waiting',
    s3.banners.some((x) => x.title === '探索完成' && x.sub.includes('探索奖励可领取（M 键 → 领取）')),
    JSON.stringify(s3.banners.map((x) => x.sub)));

  await openMap();
  const dom3 = await mapDom();
  await shot('map-complete');
  const row3 = dom3.rows.find((r) => r.zone === zone.id);
  check('the map row reads 100%', row3?.text.startsWith('100%') && row3.pct === '100', JSON.stringify(row3));
  check('the footer says every type is found',
    dom3.foot.some((t) => t.startsWith(`探索度 100% (${full.total}/${full.total})`)
      && full.byType.every((x) => t.includes(`${x.label} ${x.total}/${x.total}`))),
    JSON.stringify(dom3.foot.filter((t) => t.includes('探索度'))));

  /* ------------------------------- 100% with the last rung still unclaimed -- */

  // The one state where both classes are on the same element. If `.ready` and `.full` shared a
  // colour, the largest reward in the game would be invisible on exactly the zone that has it —
  // so here the row must read as *claimable*, cyan, and specifically NOT gold yet.
  const goldRgb = await cssRgb(dom3.gold);
  check('a finished-but-unclaimed zone is cyan, not gold',
    row3?.full === true && row3.ready === '1' && row3.text === '100% 🎁'
    && row3.color === accentRgb && row3.color !== goldRgb && goldRgb !== accentRgb,
    `${JSON.stringify(row3?.text)} ${row3?.color} · --accent ${accentRgb} · --gold ${goldRgb}`);
  check('and the button offers the last rung, priced',
    dom3.claim?.disabled === false && dom3.claim.ready === '1'
    && dom3.claim.text === `领取探索奖励 · ${price(stepOf(100))}`,
    JSON.stringify(dom3.claim?.text));

  const purse3 = dom3.purse;
  await clearSaid();
  await pressClaim();
  const dom5 = await mapDom();
  const s5 = await state();
  await shot('map-claimed-full');
  const row5 = dom5.rows.find((r) => r.zone === zone.id);
  check('the last rung pays the rest of the ladder',
    dom5.purse.mora - purse3.mora === stepOf(100).mora
    && dom5.purse.primogem - purse3.primogem === stepOf(100).primogem
    && s5.toasts.some((t) => t.text === `探索奖励 100%：${price(stepOf(100))}`),
    `+${dom5.purse.mora - purse3.mora} 摩拉 +${dom5.purse.primogem - purse3.primogem} 原石 · ${JSON.stringify(s5.toasts.map((t) => t.text))}`);
  // Style, not class: `.full` can be present while the colour rule never applied (a renamed
  // variable, a losing selector), and then the number a player is meant to notice looks exactly
  // like the ones they have not finished. Pinned from both sides — the finished row must differ
  // from an unfinished row on the same screen, and must be the gold the theme defines.
  check('a finished zone is gold, an unfinished one is not',
    !!row5?.full && row5.text === '100%' && row5.ready === '0'
    && row5.color === goldRgb && other && row5.color !== plainColor,
    `full ${row5?.color} vs plain ${plainColor} vs --gold ${dom5.gold} = ${goldRgb}`);
  check('and the button says the ladder is finished, with nothing left to press',
    dom5.claim?.disabled === true && dom5.claim.ready === '0'
    && dom5.claim.text === '探索奖励已全部领取'
    && EXPLORE_MILESTONES.every((m) => dom5.claim.title.includes(`${m}% ${price(stepOf(m))} ✓`)),
    `${JSON.stringify(dom5.claim?.text)} · ${JSON.stringify(dom5.claim?.title)}`);
  // The two presses together are the sentence the pricing was derived from: 「走完一个地区的探索度
  // = 付这个地区宝箱那一份」. And the paid row must still be invisible to the percentage.
  // Summed from the two *measured* deltas, not from `purseBefore` to now: the last chest was opened
  // by hand in between and paid its own loot into the same purse.
  const totalPaid = {
    mora: (dom4.purse.mora - purseBefore.mora) + (dom5.purse.mora - purse3.mora),
    primogem: (dom4.purse.primogem - purseBefore.primogem) + (dom5.purse.primogem - purse3.primogem),
  };
  const chests = zoneChestValue(zone);
  check('the whole ladder paid one zone of chests, and never touched the percentage',
    totalPaid.mora === chests.mora && totalPaid.primogem === chests.primogem
    && derive(zone, s5.progress).pct === 100 && derive(zone, s5.progress).total === full.total,
    `paid ${price(totalPaid)} vs chests ${price(chests)} · ${exploreText(derive(zone, s5.progress))}`);
  await closeMap();

  /* --------------------------------------- the achievement reads the same fact -- */

  const ach = await p.evaluate(async (tok) => (await fetch('http://127.0.0.1:8787/api/achievements', {
    headers: { authorization: `Bearer ${tok}` },
  })).json(), token);
  check('the achievement snapshot is the number the map is showing',
    ach.progress?.exploreBest === 100 && ach.progress?.zonesExplored >= 1,
    `exploreBest ${ach.progress?.exploreBest} zonesExplored ${ach.progress?.zonesExplored}`);
  // The same `achState` the panel draws with, over the server's own snapshot: 100% clears all
  // three tiers of 踏遍此地, and 大地的图册 has its first.
  const survey = achState(ACH_BY_ID.survey, ach.progress, ach.claimed?.survey || 0);
  const atlas = achState(ACH_BY_ID.atlas, ach.progress, ach.claimed?.atlas || 0);
  check('踏遍此地 is fully earned and claimable, 大地的图册 has its first tier',
    survey.earned === ACH_BY_ID.survey.targets.length && survey.claimable > 0 && atlas.earned >= 1,
    `survey ${survey.earned}/${ACH_BY_ID.survey.targets.length} claimable ${survey.claimable} · atlas ${atlas.earned} (have ${atlas.have})`);

  /* --------------------------- one click from the HUD to the reward, cross-zone -- */

  // The hole the chip was built for is not the first zone, it is the second: 蒙德's ladder is
  // announced by every chest the tutorial hands you, while 龙脊雪山 at 40% says nothing unless the
  // map is reopened. And the routing claim needs a control, because in 蒙德 there is none — the map
  // opens on the zone you are standing in, so a chip that carried no zone at all would look right.
  // So the only owing zone is made to be a different one, pushed past its first rung through the
  // same `/api/world/unlock` the client calls (that route has no rank gate; this guest is AR 1).
  const dz = ZONES.dragonspine;
  const dzPlan = explorables(dz)
    .filter((e) => EXPLORE_TYPES[e.type].writer.endsWith('/unlock')).slice(0, 2)
    .map((e) => e.id);
  const giftPaid = await hudGift();
  check('with 蒙德’s whole ladder paid, the chip is gone', giftPaid.hiddenClass === true
    && giftPaid.w === 0 && giftPaid.n === '0', JSON.stringify({ n: giftPaid.n, w: giftPaid.w }));

  const restUnlock = (ids) => p.evaluate(async ([tok, zid, list]) => {
    const out = [];
    for (const poiId of list) {
      const r = await fetch('http://127.0.0.1:8787/api/world/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
        body: JSON.stringify({ zone: zid, poiId }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.player) window.game._applyPlayer(j.player, false);
      out.push({ poiId, status: r.status });
    }
    return out;
  }, [token, dz.id, ids]);
  const dzRes = await restUnlock(dzPlan);
  check('a second zone can be pushed past its first rung', dzRes.every((r) => r.status === 200),
    dzRes.map((r) => `${r.poiId}=${r.status}`).join(' '));

  const s6 = await state();
  const dzClaim = exploreClaim(dz, s6.progress?.[dz.id] || {});
  const gift6 = await hudGift();
  await shot('hud-gift-other-zone');
  check('the second zone owes exactly one rung', dzClaim.claimable.length === 1
    && dzClaim.claimable[0] === EXPLORE_MILESTONES[0] && derive(zone, s6.progress).pct === 100,
    `${dz.id} ${dzClaim.pct}% claimable ${JSON.stringify(dzClaim.claimable)}`);
  check('the chip lights for a zone the player is nowhere near, and names it',
    gift6.hiddenClass === false && gift6.n === '1' && gift6.w > 12
    && gift6.title.includes(giftLine(dz, dzClaim)) && !gift6.title.includes(zone.name),
    `${JSON.stringify(gift6.title)} want ${JSON.stringify(giftLine(dz, dzClaim))}`);

  // The control: the map key alone still opens where the player is standing. Without this line, a
  // chip that emitted `togglePanel` with no zone at all would pass the assertion below.
  await openMap();
  const domCtl = await mapDom();
  check('the map key alone selects the zone the player is in, not the owing one',
    domCtl.selected === zone.id && domCtl.claim?.zone === zone.id
    && domCtl.claim.text === '探索奖励已全部领取',
    `sel ${domCtl.selected} · ${JSON.stringify(domCtl.claim?.text)}`);
  await closeMap();

  // …and the chip's click is one press from the reward: the map opens *and* selects 龙脊雪山, with
  // its own footer button live and priced. `open()` resets the selection to the current zone, so
  // this only works if the named zone is applied after the panel opens.
  await clearSaid();
  await p.click('[data-act="explore"]');
  await sleep(1200);
  const domGift = await mapDom();
  await shot('map-routed-by-chip');
  check('a click on the chip opens the map on the owing zone',
    domGift.selected === dz.id && domGift.claim?.zone === dz.id,
    `sel ${domGift.selected} · claim zone ${domGift.claim?.zone}`);
  check('with that zone’s rung live and priced, one press away',
    domGift.claim?.disabled === false && domGift.claim.ready === '1'
    && domGift.claim.text === `领取探索奖励 · ${price(stepOfZone(dz, EXPLORE_MILESTONES[0]))}`,
    `${JSON.stringify(domGift.claim?.text)} want 领取探索奖励 · ${price(stepOfZone(dz, EXPLORE_MILESTONES[0]))}`);

  const purse6 = domGift.purse;
  await pressClaim();
  const dom7 = await mapDom();
  await closeMap();
  const gift7 = await hudGift();
  check('and that press pays the second zone and clears the chip',
    dom7.purse.mora - purse6.mora === stepOfZone(dz, EXPLORE_MILESTONES[0]).mora
    && dom7.purse.primogem - purse6.primogem === stepOfZone(dz, EXPLORE_MILESTONES[0]).primogem
    && gift7.hiddenClass === true && gift7.w === 0,
    `+${dom7.purse.mora - purse6.mora} 摩拉 +${dom7.purse.primogem - purse6.primogem} 原石 · chip n ${gift7.n} w ${gift7.w}`);

  /* -------------------------------- and it is there at login, before any event -- */

  // The failure mode this chip was most likely to have (`state-ui-needs-a-mount-write`): an
  // event-only badge. Everything above moved through `playerState`, so a chip wired to that event
  // *only* passes all of it — and then a player who walked 龙脊雪山 to 44% last session logs in to
  // an empty corner and never learns the reward is sitting there. So: push the zone past its next
  // rung, reload, come back through 继续冒险, and read the chip before anything can fire.
  const dzPlan2 = explorables(dz)
    .filter((e) => EXPLORE_TYPES[e.type].writer.endsWith('/unlock') && !dzPlan.includes(e.id))
    .slice(0, 2).map((e) => e.id);
  const dzRes2 = await restUnlock(dzPlan2);
  const dzOwed = await p.evaluate((zid) => window.game.player?.worldProgress?.[zid] || {}, dz.id);
  const dzClaim2 = exploreClaim(dz, dzOwed);
  check('the second zone crosses its next rung, with the first one already paid',
    dzRes2.every((r) => r.status === 200) && dzClaim2.paid === EXPLORE_MILESTONES[0]
    && dzClaim2.claimable.length === 1 && dzClaim2.claimable[0] === EXPLORE_MILESTONES[1],
    `${dz.id} ${dzClaim2.pct}% paid ${dzClaim2.paid} claimable ${JSON.stringify(dzClaim2.claimable)}`);

  await p.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  // The token is still in localStorage, so this lands on 继续冒险 — and the mode buttons reset to
  // 多人在线, which would put the probe in someone else's world.
  await p.evaluate(() => document.querySelector('[data-act="solo"]')?.click());
  await sleep(400);
  await p.evaluate(() => (document.querySelector('[data-act="resume"]')
    || document.querySelector('[data-act="guest"]'))?.click());
  for (let i = 0; i < 90; i++) {
    if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) break;
    await sleep(1000);
  }
  await sleep(2500);
  const reloaded = await p.evaluate(() => ({
    running: !!window.game?._running, mode: window.game?.mode,
    mora: window.game?.player?.mora ?? 0,
  }));
  const giftBoot = await hudGift();
  await shot('hud-gift-at-login');
  check('the session comes back solo, on the same save',
    reloaded.running === true && reloaded.mode === 'solo' && reloaded.mora > 20000,
    JSON.stringify(reloaded));
  check('logging in with an owed rung shows the chip, with no event to light it',
    giftBoot.hiddenClass === false && giftBoot.w > 12 && giftBoot.n === '1'
    && giftBoot.title.includes(giftLine(dz, dzClaim2)),
    `n ${giftBoot.n} w ${giftBoot.w} · ${JSON.stringify(giftBoot.title)} want ${JSON.stringify(giftLine(dz, dzClaim2))}`);
} catch (e) {
  fail++;
  console.log(`  FAIL probe threw — ${e.stack || e.message}`);
  try { await shot('crash'); } catch { /* the page may be gone */ }
} finally {
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`artifacts: ${outDir}`);
  process.exit(fail ? 1 : 0);
}
