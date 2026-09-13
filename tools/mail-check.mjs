// 邮件 probe: the mailbox, clicked through a real browser.
//
//   DISPLAY=:99 node tools/mail-check.mjs [baseUrl] [outDir]
//
// `api-check.mjs` already proves the routes: the sign-in gift is derived from the day, a
// second GET mints nothing, a claim pays exactly the attachment, and a binned letter does not
// come back. None of that says a *player* can find the mailbox. What is under test here is the
// path they actually take — that the badge in the HUD appears on its own (the boot fetch, not
// a keypress, is what delivers the letter), that I opens the box, that a letter shows its text
// and its attachments rather than an empty shell, that 领取 moves the purse and then stops
// offering itself, and that 删除已读 leaves a box that stays empty when reopened.
//
// No quality tier is pinned and no pixels are measured: every assertion below reads the DOM or
// `getComputedStyle`, so what llvmpipe does with the scene behind the panel is irrelevant.
// Colours are read as computed values rather than class names — a class can be right while a
// later rule wins (see the `.chip`/`.pchip` collision in tools/shop-check.mjs).
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { LOGIN_GIFTS, loginMail, attachLines } from '../shared/src/data/mail.js';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/mail';
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

/** The HUD badge: whether it is on screen at all, and the number on it. */
const badge = () => p.evaluate(() => {
  const el = document.querySelector('[data-f="mailbtn"]');
  if (!el) return null;
  const st = getComputedStyle(el);
  return {
    shown: st.display !== 'none',
    n: Number(el.querySelector('[data-f="mailn"]')?.textContent || 0),
    cursor: st.cursor,
  };
});

/** Letter rows down the left, with the unread marker read as a computed colour. */
const letters = () => p.evaluate(() => [...document.querySelectorAll('.panel .mail-row')].map((r) => {
  const st = getComputedStyle(r);
  const sm = r.querySelector('small');
  return {
    id: Number(r.dataset.mail || 0),
    subject: r.querySelector('b')?.textContent || '',
    sub: r.querySelector('small')?.textContent || '',
    date: r.querySelector('.dt')?.textContent || '',
    // The sender is truncated with an ellipsis rather than wrapped, so the assertion below
    // reads the overflow rule too: a row that wraps is a row whose date has been cut in half.
    wrap: sm ? getComputedStyle(sm).whiteSpace : '',
    badge: r.querySelector('.qty')?.textContent || '',
    sel: r.classList.contains('sel'),
    mark: st.borderLeftColor,
  };
}));

/** The open letter: its text, its attachment cells, and the state of its 领取 button. */
const open = () => p.evaluate(() => {
  const main = document.querySelector('.panel .col.main');
  if (!main) return null;
  const grid = main.querySelector('.mail-attach');
  const take = main.querySelector('[data-act="claim-one"]');
  return {
    subject: main.querySelector('h3')?.textContent || '',
    who: main.querySelector('p.muted')?.textContent || '',
    expiry: main.querySelector('p.gold')?.textContent || '',
    body: main.querySelector('.mail-body')?.textContent || '',
    section: [...main.querySelectorAll('h3.sec')].map((x) => x.textContent),
    atts: grid ? [...grid.querySelectorAll('.att')].map((c) => ({
      icon: c.querySelector('.ico')?.textContent || '',
      n: c.querySelector('.n')?.textContent || '',
      name: c.querySelector('.nm')?.textContent || '',
    })) : [],
    gridOpacity: grid ? Number(getComputedStyle(grid).opacity) : null,
    take: take ? { label: take.textContent, dis: take.disabled } : null,
  };
});

const footBtns = () => p.evaluate(() => [...document.querySelectorAll('.panel footer button')]
  .map((x) => ({ label: x.textContent, dis: x.disabled, act: x.dataset.act || '' })));

const clickLetter = (id) => p.evaluate((k) => {
  const r = document.querySelector(`.panel .mail-row[data-mail="${k}"]`);
  if (!r) return false;
  r.click();
  return true;
}, id);

const clickAct = (act) => p.evaluate((a) => {
  const btn = document.querySelector(`.panel [data-act="${a}"]`);
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}, act);

const money = () => p.evaluate(() => ({
  mora: window.game?.player?.mora ?? 0,
  primogem: window.game?.player?.primogem ?? 0,
  inv: { ...(window.game?.player?.inventory || {}) },
}));

const emptyText = () => p.evaluate(() => document.querySelector('.panel .body p.muted')?.textContent || '');

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
    running: !!window.game?._running, mode: window.game?.mode, playerId: window.game?.playerId,
  }));
  check('the solo world booted', me.running === true && !!me.playerId, `player ${me.playerId}`);

  // --- the badge announces the mailbox before anything is clicked ----------
  // This is the whole reason the fetch happens at boot: a sign-in gift the player has to go
  // looking for is not a gift. A fresh guest is owed the welcome letter and today's sign-in,
  // and nothing else — no score yet, so no ladder payout.
  await sleep(2500);
  const bg0 = await badge();
  check('the HUD grows a mail badge on its own',
    !!bg0 && bg0.shown === true && bg0.n === 2, JSON.stringify(bg0));
  check('and the badge is clickable', bg0?.cursor === 'pointer', bg0?.cursor);
  await shot('badge');

  // --- the panel ----------------------------------------------------------
  await p.keyboard.press('KeyI');
  // The box may already be cached from the boot fetch, so the panel can paint either before or
  // after the background refresh lands; both orderings have to settle before anything is read.
  await sleep(1800);
  check('I opens the mailbox', (await panelTitle()) === '邮件');
  const ls = await letters();
  check('both letters are listed', ls.length === 2,
    ls.map((l) => `${l.subject}${l.badge}`).join(' | '));
  const gift = loginMail();
  const giftRow = ls.find((l) => l.subject === gift.subject);
  const hello = ls.find((l) => l.subject === '欢迎来到提瓦特');
  check("today's sign-in letter is one of them", !!giftRow, giftRow?.subject);
  check('a row names its sender and when it arrived',
    ls.every((l) => l.sub.length > 1 && /^\d+\/\d+ \d\d:\d\d$/.test(l.date)),
    `${ls[0]?.sub} / ${ls[0]?.date}`);
  check('and the sender is truncated rather than wrapped',
    ls.every((l) => l.wrap === 'nowrap'), ls[0]?.wrap);
  check('a letter with something on it is badged',
    ls.every((l) => l.badge === '🎁'), ls.map((l) => l.badge).join(''));
  // Unread is marked with a gold left edge; the *claimed* state dims the row, so marking
  // unread with a colour on the same text would cancel out. Read the computed value.
  check('an unread letter is marked on its edge',
    ls.every((l) => l.mark === 'rgb(232, 197, 106)'), ls.map((l) => l.mark).join(' '));
  await shot('mailbox');

  // --- the open letter ----------------------------------------------------
  // The panel defaults to the newest letter that still owes something, which is today's gift
  // rather than the welcome letter underneath it — opening on a claimed letter would be the
  // bug, so assert *which* one it picked and not merely that one is selected.
  check('the panel opens the newest letter that still owes something',
    !!giftRow && giftRow.sel === true && hello?.sel === false,
    `selected ${ls.find((l) => l.sel)?.subject}`);
  check('the welcome letter can be opened', await clickLetter(hello.id));
  await sleep(600);
  const o0 = await open();
  check('the panel shows the letter that was clicked', o0.subject === '欢迎来到提瓦特', o0.subject);
  check('the letter has real text, not a placeholder',
    o0.body.length > 20 && !o0.body.includes('undefined'), o0.body.slice(0, 40));
  check('it says who sent it and when', /·/.test(o0.who), o0.who);
  check('and how long the attachment lasts', /后过期$/.test(o0.expiry), o0.expiry);
  check('the attachment grid draws one cell per item',
    o0.atts.length === 4 && o0.atts.every((a) => a.icon && /^×/.test(a.n) && a.name),
    o0.atts.map((a) => `${a.icon}${a.n} ${a.name}`).join(' '));
  check('an unclaimed attachment is not dimmed', o0.gridOpacity === 1, String(o0.gridOpacity));
  check('领取 is offered', o0.take?.label === '领取' && o0.take.dis === false,
    JSON.stringify(o0.take));

  // --- claiming -----------------------------------------------------------
  const m0 = await money();
  if (check('领取 is clickable', await clickAct('claim-one'))) {
    await sleep(2200);
    const m1 = await money();
    check('the attachment lands in the purse and the bag',
      m1.mora - m0.mora === 30000 && m1.primogem - m0.primogem === 300
      && (m1.inv.condensedResin || 0) - (m0.inv.condensedResin || 0) === 2,
      `mora ${m0.mora}→${m1.mora}, gems ${m0.primogem}→${m1.primogem}`);
    const o1 = await open();
    check('the letter turns into a receipt, not a second reward',
      o1.take?.dis === true && o1.take.label === '已领取' && o1.section.includes('已领取'),
      `${JSON.stringify(o1.take)} ${o1.section.join('/')}`);
    check('and its attachments are visibly spent',
      o1.gridOpacity !== null && o1.gridOpacity < 0.6, String(o1.gridOpacity));
    const ls1 = await letters();
    check('the row swaps its gift badge for a tick',
      ls1.find((l) => l.id === hello.id)?.badge === '✓',
      ls1.map((l) => `${l.subject}${l.badge}`).join(' | '));
    const bg1 = await badge();
    check('the HUD badge counts down', bg1.shown === true && bg1.n === 1, JSON.stringify(bg1));
    await shot('claimed-one');
  }

  // --- the other letter, and 一键领取 --------------------------------------
  if (check('the sign-in letter can be opened', await clickLetter(giftRow.id))) {
    await sleep(600);
    const o2 = await open();
    // Compared as a set: the attachment map round-trips through JSONB, which does not keep
    // key order, so an index-by-index comparison would be a coin flip on a two-item gift.
    const want = attachLines(gift.attach);
    check('it carries exactly the gift the shared rotation derives',
      // The count is compared as a number, not as the string the panel prints: `dom.js:num`
      // groups thousands ('1,240,000 reads, 1240000 does not'), so the day the rotation handed
      // out 摩拉×30,000 this read 「×30,000 vs ×30000」 and failed on a comma.
      o2.atts.length === want.length
      && want.every((w) => o2.atts.some((a) => a.name === w.name
        && Number(String(a.n).replace(/[^\d]/g, '')) === w.count)),
      `${o2.atts.map((a) => `${a.name}${a.n}`).join(' ')} vs ${want.map((w) => `${w.name}×${w.count}`).join(' ')}`);
    const foot0 = await footBtns();
    check('一键领取 offers the count that is left',
      foot0.some((x) => x.act === 'claim-all' && x.label === '一键领取 (1)' && !x.dis),
      foot0.map((x) => `${x.label}${x.dis ? '(off)' : ''}`).join(' | '));
    const m2 = await money();
    check('一键领取 is clickable', await clickAct('claim-all'));
    await sleep(2200);
    const m3 = await money();
    // The gift rotates by day, so the probe cannot hardcode an amount — it asserts against
    // the same table the server derived the letter from.
    const wantGem = gift.attach.primogem || 0;
    check('and it pays the rotation gift',
      m3.primogem - m2.primogem === wantGem && (m3.mora - m2.mora) === (gift.attach.mora || 0),
      `gems +${m3.primogem - m2.primogem} (want ${wantGem}), mora +${m3.mora - m2.mora}`);
    const bg2 = await badge();
    check('the badge disappears when nothing is left to collect',
      bg2.shown === false, JSON.stringify(bg2));
    const foot1 = await footBtns();
    check('and 一键领取 goes dead',
      foot1.find((x) => x.act === 'claim-all')?.dis === true,
      foot1.map((x) => `${x.label}${x.dis ? '(off)' : ''}`).join(' | '));
    await shot('claimed-all');
  }

  // --- 删除已读, and the letter that must not come back --------------------
  {
    const foot = await footBtns();
    check('删除已读 counts what it will bin',
      foot.some((x) => x.act === 'delete-read' && x.label === '删除已读 (2)' && !x.dis),
      foot.map((x) => x.label).join(' | '));
    check('删除已读 is clickable', await clickAct('delete-read'));
    await sleep(2200);
    check('the box empties', (await letters()).length === 0 && /信箱是空的/.test(await emptyText()),
      await emptyText());
    await shot('emptied');

    // The regression that soft deletion exists for: a hard DELETE would drop the dedupe row
    // that proves today's gift was handed out, so reopening would mint it again — 删除已读
    // would print primogems.
    await p.keyboard.press('Escape');
    await sleep(700);
    await p.keyboard.press('KeyI');
    await sleep(2500);
    check('reopening does not re-mint the letters just binned',
      (await letters()).length === 0, `${(await letters()).length} rows`);
    const bg3 = await badge();
    check('and the badge stays away', bg3.shown === false, JSON.stringify(bg3));
    await shot('reopened-empty');
  }

  check('the rotation has one gift per weekday', LOGIN_GIFTS.length === 7, String(LOGIN_GIFTS.length));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('probe ran to completion', false, e?.message || String(e));
  await shot('crash').catch(() => {});
} finally {
  await b.close().catch(() => {});
}

// A probe that asserts nothing is worse than a red one; the count is part of the verdict.
console.log(`\n${pass} passed, ${fail} failed`);
if (pass < 24) { console.log('too few assertions ran — treat this as a failure'); process.exit(1); }
process.exit(fail);
