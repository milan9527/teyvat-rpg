// 商店 probe: the shop panel, clicked through a real browser.
//
//   DISPLAY=:99 node tools/shop-check.mjs [baseUrl] [outDir]
//
// `api-check.mjs` already proves `/api/shop` and `/api/shop/buy` — the price, the clamp,
// the period-keyed limit, the weapon mint. What it cannot prove is that a player can
// *reach* any of it: that N opens a counter, that a row prices its goods against what the
// player is actually holding, that pressing 购买 moves both the purse and the stock label
// without reopening the panel, that a sold-out row stops offering a button, that a
// rank-locked counter reads as locked rather than as empty, and that a shopkeeper NPC
// opens *his* tab rather than the first one.
//
// Runs in 单机 so the seeding below can go straight through REST; see bag-check.mjs for
// why an online browser makes its own setup impossible.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { SHOPS, SHOP_IDS } from '../shared/src/data/shop.js';
import { MATERIALS } from '../shared/src/data/items.js';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/shop';
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
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
  if (drained.length) console.log(drained.slice(-12).join('\n'));
}

const panelTitle = () => p.evaluate(() => document.querySelector('.panel h2')?.textContent ?? null);

/** The counter list down the left, as the player sees it. */
const counters = () => p.evaluate(() => [...document.querySelectorAll('.panel .col.side .list-row')].map((r) => ({
  id: r.dataset.shop || null,
  name: r.querySelector('b')?.textContent || '',
  sub: r.querySelector('small')?.textContent || '',
  badge: r.querySelector('.qty')?.textContent || '',
  sel: r.classList.contains('sel'),
  dim: r.classList.contains('dim'),
})));

/** Every shelf row, including which of its buttons are live. */
const rows = () => p.evaluate(() => [...document.querySelectorAll('.panel .shop-row')].map((r) => ({
  id: r.dataset.entry || null,
  name: r.querySelector('.t b')?.textContent || '',
  // The colour is read from `getComputedStyle`, not inferred from the class: `.chip` was
  // already the leaderboard tab's class, so the first version of these price chips
  // inherited a hover lift and a pointer cursor and lost their own colour to a later rule.
  // The class being right proves nothing about what the player sees.
  cost: [...r.querySelectorAll('.cost .pchip')].map((c) => ({
    text: c.textContent.trim(), afford: c.classList.contains('up'), short: c.classList.contains('down'),
    color: getComputedStyle(c).color, cursor: getComputedStyle(c).cursor,
  })),
  stock: r.querySelector('.stk .n')?.textContent || '',
  note: r.querySelector('.stk .rs')?.textContent || '',
  acts: [...r.querySelectorAll('.acts button')].map((x) => ({ label: x.textContent, dis: x.disabled })),
  dim: r.classList.contains('dim'),
})));

const purse = () => p.evaluate(() => [...document.querySelectorAll('.panel footer .pchip')].map((c) => c.textContent.trim()));

const clickCounter = (id) => p.evaluate((k) => {
  const r = document.querySelector(`.panel .col.side .list-row[data-shop="${k}"]`);
  if (!r) return false;
  r.click();
  return true;
}, id);

/** Press a row's nth live button (0 = 购买, 1 = the bulk button when it exists). */
const clickRowBtn = (entryId, idx) => p.evaluate((id, i) => {
  const r = document.querySelector(`.panel .shop-row[data-entry="${id}"]`);
  if (!r) return false;
  const btn = [...r.querySelectorAll('.acts button')][i];
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}, entryId, idx);

const money = () => p.evaluate(() => ({
  mora: window.game?.player?.mora ?? 0,
  primogem: window.game?.player?.primogem ?? 0,
  wishTicket: window.game?.player?.wishTicket ?? 0,
  inv: { ...(window.game?.player?.inventory || {}) },
}));

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
  const me = await p.evaluate(() => ({
    running: !!window.game?._running, mode: window.game?.mode,
    playerId: window.game?.playerId, mora: window.game?.player?.mora,
    ar: window.game?.player?.adventureRank,
  }));
  check('the solo world booted', me.running === true && me.mode === 'solo' && !!me.playerId,
    `player ${me.playerId}, AR ${me.ar}, ${me.mora} mora`);

  // --- the panel opens -----------------------------------------------------
  await p.keyboard.press('KeyN');
  // The catalogue is a fetch, so the first frame of the panel says "盘点中" by design;
  // the assertion below is about what it settles on.
  await sleep(1800);
  check('N opens the shop', (await panelTitle()) === '商店');
  const cs = await counters();
  check('every counter is listed', cs.length === SHOP_IDS.length,
    cs.map((c) => `${c.name}${c.dim ? '(锁)' : ''}`).join(' '));
  check('a counter names its keeper and where he stands',
    cs.every((c) => c.sub.includes('·')), cs[0]?.sub);
  await shot('shop-open');

  const shelf = await rows();
  const general = SHOPS.general;
  check('the open counter shows its shelves', shelf.length === general.entries.length,
    `${shelf.length} rows, e.g. ${shelf[0]?.name} ${shelf[0]?.cost[0]?.text}`);
  check('every row prices its goods', shelf.every((r) => r.cost.length > 0),
    shelf.map((r) => r.cost.map((c) => c.text).join('+')).join(' '));
  check('a limited row says which period the limit belongs to',
    shelf.every((r) => /今日|本周|本月|不限量/.test(r.stock)),
    shelf.map((r) => r.stock).join(' '));
  check('and when it restocks', shelf.some((r) => /后补货/.test(r.note)),
    shelf.find((r) => r.note)?.note || '(none)');
  check('the purse is on screen', (await purse()).length === 3, (await purse()).join(' '));

  // Affordable and unaffordable have to *look* different, and neither may look clickable.
  {
    const chips = shelf.flatMap((r) => r.cost);
    const green = chips.filter((c) => c.afford);
    const red = chips.filter((c) => c.short);
    check('an affordable price is drawn green',
      green.length > 0 && green.every((c) => c.color === 'rgb(168, 234, 146)'),
      `${green.length} chips, e.g. ${green[0]?.text} ${green[0]?.color}`);
    // No `red` assertion here on purpose: on this shelf the guest can afford everything,
    // and `[].every(...)` is true — a vacuous pass. The red half is asserted on the abyss
    // trader's shelf below, where the chips are genuinely short.
    check('nothing on the opening shelf is out of reach', red.length === 0,
      red.map((c) => c.text).join(' '));
    check('and a price does not pretend to be a button',
      chips.every((c) => c.cursor !== 'pointer'), chips[0]?.cursor);
  }

  // --- one purchase moves the purse, the bag and the label -----------------
  const target = 'gen_sweetFlower';
  const entry = general.entries.find((e) => e.id === target);
  const row0 = shelf.find((r) => r.id === target);
  const m0 = await money();
  if (check('the shelf row for 甜甜花 is buyable',
    !!row0 && row0.acts[0] && !row0.acts[0].dis, `${row0?.stock} · ${row0?.acts.map((a) => a.label).join('/')}`)) {
    check('购买 is clickable', await clickRowBtn(target, 0));
    await sleep(2200);
    const m1 = await money();
    check('the purchase debits exactly the listed price',
      m0.mora - m1.mora === entry.cost.mora, `${m0.mora} → ${m1.mora} (price ${entry.cost.mora})`);
    check('and credits the goods',
      (m1.inv[entry.item] || 0) - (m0.inv[entry.item] || 0) === entry.count,
      `${MATERIALS[entry.item]?.name} ${m0.inv[entry.item] || 0} → ${m1.inv[entry.item] || 0}`);
    const row1 = (await rows()).find((r) => r.id === target);
    check('the row redraws its own stock without reopening the panel',
      row1.stock !== row0.stock && row1.stock.includes(`1/${entry.limit}`),
      `${row0.stock} → ${row1.stock}`);
    const p1 = await purse();
    check('the purse redraws too', p1.some((c) => c.includes(String(m1.mora).replace(/\B(?=(\d{3})+(?!\d))/g, ','))),
      p1.join(' '));
    await shot('bought-one');

    // --- the bulk button empties the period's stock ------------------------
    if (check('a bulk button appears while stock is left',
      (row1.acts[1]?.label || '').startsWith('×'), row1.acts.map((a) => a.label).join('/'))) {
      check('the bulk button is clickable', await clickRowBtn(target, 1));
      await sleep(2500);
      const row2 = (await rows()).find((r) => r.id === target);
      check('buying out the period leaves the row sold out',
        row2.stock.includes(`${entry.limit}/${entry.limit}`) && row2.acts[0].dis === true
        && row2.acts.length === 1,
        `${row2.stock}, buttons ${row2.acts.map((a) => `${a.label}${a.dis ? '(off)' : ''}`).join('/')}`);
      const m2 = await money();
      check('and the debit matches the whole remaining stock',
        m1.mora - m2.mora === entry.cost.mora * (entry.limit - 1),
        `${m1.mora} → ${m2.mora} for ${entry.limit - 1}×${entry.cost.mora}`);
      await shot('sold-out');
    }
  }

  // --- a price the player cannot pay reads as short ------------------------
  {
    await clickCounter('abyssTrader');
    await sleep(700);
    const cs2 = await counters();
    const tab = cs2.find((c) => c.id === 'abyssTrader');
    check('a rank-locked counter reads as locked',
      tab.dim === true && tab.badge.includes('🔒'), `badge ${tab.badge}`);
    const shelf2 = await rows();
    check('its shelves are visible but every button is dead',
      shelf2.length === SHOPS.abyssTrader.entries.length && shelf2.every((r) => r.acts[0].dis),
      `${shelf2.length} rows, all disabled`);
    check('and the whole shelf greys out, not just the rank-gated rows',
      await p.evaluate(() => {
        const list = document.querySelector('.panel .shop-list');
        return !!list && list.classList.contains('locked')
          && Number(getComputedStyle(list.querySelector('.shop-row')).opacity) < 0.6;
      }));
    check('a barter price shows every material it wants',
      shelf2.every((r) => r.cost.length === Object.keys(
        SHOPS.abyssTrader.entries.find((e) => e.id === r.id).cost).length),
      shelf2.map((r) => r.cost.length).join(''));
    const short2 = shelf2.flatMap((r) => r.cost).filter((c) => c.short);
    check('and marks the ones the player is short of',
      shelf2.every((r) => r.cost.some((c) => c.short)) && short2.length >= shelf2.length,
      shelf2[0]?.cost.map((c) => `${c.text}${c.short ? '(short)' : ''}`).join(' '));
    check('an unaffordable price is drawn red',
      short2.length > 0 && short2.every((c) => c.color === 'rgb(255, 154, 134)'),
      `${short2.length} chips, e.g. ${short2[0]?.text} ${short2[0]?.color}`);
    await shot('abyss-locked');
  }

  // --- primogems buy a wish, which lands in a column and not the bag ------
  {
    await clickCounter('bargains');
    await sleep(700);
    const m0b = await money();
    const shelf3 = await rows();
    const wishRow = shelf3.find((r) => r.id === 'bar_wish');
    check('the unlimited wish entry has no stock counter',
      wishRow.stock === '不限量' && wishRow.note === '', `${wishRow.stock} ${wishRow.note}`);
    if (check('购买 is live on it', await clickRowBtn('bar_wish', 0))) {
      await sleep(2200);
      const m1b = await money();
      check('primogems become a wish ticket, not an inventory row',
        m1b.wishTicket - m0b.wishTicket === 1 && m0b.primogem - m1b.primogem === 160
        && (m1b.inv.wishTicket || 0) === (m0b.inv.wishTicket || 0),
        `${m0b.primogem}→${m1b.primogem} gems, ${m0b.wishTicket}→${m1b.wishTicket} tickets`);
      await shot('wish-bought');
    }
  }

  // --- the keeper opens his own counter -----------------------------------
  {
    await p.keyboard.press('Escape');
    await sleep(600);
    const npc = await p.evaluate(() => {
      const n = (window.game?.world?.npcs || []).map((x) => x.npc).find((x) => x.shop === 'general');
      return n ? { id: n.id, name: n.name, shop: n.shop, lines: n.lines?.length || 0 } : null;
    });
    if (check('the world places a keeper for 万有铺', !!npc, `${npc?.name} (${npc?.id}), ${npc?.lines} lines`)) {
      // Driving the dialogue event rather than walking there: pathing to an NPC is
      // `tools/play.mjs`'s job, and what is under test here is the button in the modal.
      await p.evaluate((n) => window.game.emit('dialogue', {
        npc: n, lines: n.lines, started: null,
      }), await p.evaluate(() => (window.game.world.npcs.map((x) => x.npc).find((x) => x.shop === 'general'))));
      await sleep(800);
      const modal = await p.evaluate(() => ({
        title: document.querySelector('.panel h2')?.textContent || '',
        who: document.querySelector('.panel h3')?.textContent || '',
        body: document.querySelector('.panel .col.main p')?.textContent || '',
        btns: [...document.querySelectorAll('.panel footer button')].map((x) => x.textContent),
      }));
      check('the keeper actually says something',
        modal.title === '对话' && modal.body.length > 1 && modal.body !== '……',
        `${modal.who}: ${modal.body}`);
      check('and his role reads in Chinese, not as a slug',
        !/guild|forge|quest|shop/.test(modal.who), modal.who);
      check('the conversation offers his counter', modal.btns.includes('看看货'),
        modal.btns.join('/'));
      await shot('keeper-dialogue');

      await p.evaluate(() => [...document.querySelectorAll('.panel footer button')]
        .find((x) => x.textContent === '看看货')?.click());
      await sleep(2000);
      check('and it opens at his shop, not the first tab',
        (await panelTitle()) === '商店'
        && (await counters()).find((c) => c.sel)?.id === 'general',
        `${await panelTitle()} · ${(await counters()).find((c) => c.sel)?.name}`);
      await shot('keeper-shop');
    }
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('probe ran to completion', false, e?.message || String(e));
  await shot('crash').catch(() => {});
} finally {
  await b.close().catch(() => {});
}

// A probe that asserts nothing is worse than a red one; the count is part of the verdict.
console.log(`\n${pass} passed, ${fail} failed`);
if (pass < 30) { console.log('too few assertions ran — treat this as a failure'); process.exit(1); }
process.exit(fail);
