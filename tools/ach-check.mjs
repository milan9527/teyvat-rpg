// 成就 probe: the achievement panel, clicked through a real browser.
//
//   DISPLAY=:99 node tools/ach-check.mjs [baseUrl] [outDir]
//
// `api-check.mjs` proves the derivation: the snapshot serves exactly the declared stats, a
// client-reported event cannot inflate a tally, a tier is priced by the server and paid once.
// What it cannot say is that a *player* ever sees any of it. The panel is where this module
// either exists or does not, so what is under test here is the visible path:
//
//   - the trophy chip appears in the HUD on its own, from the boot fetch, with the number of
//     collectable tiers on it — a fresh guest is owed two (two characters, five artifacts);
//   - H opens 成就, the six categories are listed, and the one with something to collect says so;
//   - a card shows a real progress bar whose width is neither 0 nor 100% for a stat in progress;
//   - 领取 pays primogems, the card stops offering itself and the chip counts down;
//   - 全部领取 empties the queue and the chip disappears;
//   - and reopening the panel does not resurrect anything (progress is derived, so a stale view
//     is the failure mode this module has instead of a desync).
//
// Nothing here measures pixels or pins a quality tier: every assertion reads the DOM or
// `getComputedStyle`, so what llvmpipe does with the scene behind the panel is irrelevant. The
// bar width is read as a computed pixel width rather than as the inline style, because a bar
// whose container has collapsed is exactly the bug an inline `width: 47%` would hide.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { ACH_GROUPS, ACHIEVEMENTS, achGateReport } from '../shared/src/data/achievements.js';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/ach';
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

/** The HUD trophy chip: on screen at all, the number on it, and its colour. */
const chip = () => p.evaluate(() => {
  const el = document.querySelector('[data-f="achbtn"]');
  if (!el) return null;
  const st = getComputedStyle(el);
  return {
    shown: st.display !== 'none',
    n: Number(el.querySelector('[data-f="achn"]')?.textContent || 0),
    cursor: st.cursor,
    // Read as a computed colour: the trophy shares `.mail-chip`'s box and would be
    // indistinguishable from the mail badge if the `.ach` override lost.
    color: st.color,
  };
});

/** The category column. */
const cats = () => p.evaluate(() => [...document.querySelectorAll('.panel .ach-cat')].map((r) => ({
  id: r.dataset.achGroup || '',
  name: r.querySelector('b')?.textContent || '',
  sub: r.querySelector('small')?.textContent || '',
  badge: r.querySelector('.qty')?.textContent || '',
  sel: r.classList.contains('sel'),
})));

/** The cards in the open category, with the bar read as real geometry. */
const cards = () => p.evaluate(() => [...document.querySelectorAll('.panel .ach')].map((c) => {
  const bar = c.querySelector('.bar');
  const fill = c.querySelector('.bar > i');
  const btn = c.querySelector('[data-act="ach-claim"]');
  return {
    id: btn?.dataset.ach || '',
    name: c.querySelector('b')?.textContent || '',
    sub: c.querySelector('small')?.textContent || '',
    tier: c.querySelector('.tier')?.textContent || '',
    num: c.querySelector('.num')?.textContent || '',
    barW: bar ? bar.getBoundingClientRect().width : 0,
    fillW: fill ? fill.getBoundingClientRect().width : 0,
    ready: c.classList.contains('ready'),
    done: c.classList.contains('done'),
    pay: c.querySelector('.pay')?.textContent || '',
    btn: btn ? { label: btn.textContent, dis: btn.disabled } : null,
  };
}));

const footBtns = () => p.evaluate(() => [...document.querySelectorAll('.panel footer button')]
  .map((x) => ({ label: x.textContent, dis: x.disabled, act: x.dataset.act || '' })));

const footNote = () => p.evaluate(() => document.querySelector('.panel footer span')?.textContent || '');

const clickCat = (id) => p.evaluate((k) => {
  const r = document.querySelector(`.panel .ach-cat[data-ach-group="${k}"]`);
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

const gems = () => p.evaluate(() => window.game?.player?.primogem ?? 0);

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
    running: !!window.game?._running, playerId: window.game?.playerId,
  }));
  check('the solo world booted', me.running === true && !!me.playerId, `player ${me.playerId}`);

  // --- the chip announces the module before anything is clicked -------------
  // A brand-new account has never done anything, and is still owed two tiers: two starter
  // characters and five starter artifacts. That is the derived-progress design being visible
  // from the first second of a save, which is the one thing a counter-based build cannot do.
  await sleep(3000);
  const c0 = await chip();
  check('the HUD grows a trophy chip on its own',
    !!c0 && c0.shown === true && c0.n === 2, JSON.stringify(c0));
  check('and it is clickable and not the mail badge',
    c0?.cursor === 'pointer' && c0.color === 'rgb(168, 234, 146)', `${c0?.cursor} ${c0?.color}`);
  await shot('chip');

  // --- the panel -----------------------------------------------------------
  await p.keyboard.press('KeyH');
  await sleep(1800);
  check('H opens 成就', (await panelTitle()) === '成就');
  const cs = await cats();
  check('every category is listed', cs.length === ACH_GROUPS.length,
    cs.map((c) => c.name).join(' | '));
  check('a category says how many of its achievements are fully done',
    cs.every((c) => /^\d+\/\d+ 全数达成$/.test(c.sub)), cs[0]?.sub);
  // Two starter tiers live in 养成 (角色 and 圣遗物), so exactly that category must be badged
  // and the sum of the badges has to equal the number on the chip.
  const badged = cs.filter((c) => c.badge);
  check('only the category with something to collect is badged',
    badged.length === 1 && badged[0].id === 'build' && badged[0].badge === '2',
    badged.map((c) => `${c.name}:${c.badge}`).join(' ') || 'none badged');
  check('the first category opens by default', cs[0]?.sel === true, cs.find((c) => c.sel)?.name);
  await shot('panel');

  // --- a card is a real bar, not a placeholder ------------------------------
  check('冒险之路 lists its achievements', (await cards()).length > 0);
  const adv = await cards();
  check('a card names the achievement and its next threshold',
    adv.every((c) => c.name.length > 1 && /下一档 \d/.test(c.sub) || c.done),
    adv.map((c) => `${c.name} | ${c.sub}`).slice(0, 2).join(' // '));
  check('and shows the progress as a fraction of that threshold',
    adv.every((c) => /^\d[\d,]*\/\d[\d,]*$/.test(c.num) || c.done),
    adv.map((c) => c.num).join(' '));
  // 冒险等阶 is at 1 of 10 on a fresh guest: a bar that is empty *or* full would mean the
  // width is not being computed from the numbers at all.
  const ar = adv.find((c) => c.name === '冒险家的阶梯');
  check('a partly finished bar is drawn partly filled',
    !!ar && ar.barW > 20 && ar.fillW > 0 && ar.fillW < ar.barW * 0.5,
    ar ? `fill ${ar.fillW.toFixed(1)} of ${ar.barW.toFixed(1)}px, ${ar.num}` : 'no card');
  check('an untouched achievement still shows what its first tier pays',
    adv.every((c) => /原石$/.test(c.pay)), adv.map((c) => c.pay).join(' '));
  check('the footer counts the whole catalogue, not just this category',
    new RegExp(`全数达成 0/${ACHIEVEMENTS.length} · 已达成 2/\\d+ 档 · 待领 20 原石`).test(await footNote()),
    await footNote());

  // --- claiming ------------------------------------------------------------
  check('养成 can be opened', await clickCat('build'));
  await sleep(700);
  const built = await cards();
  const ready = built.filter((c) => c.ready);
  check('the collectable cards are the two the starter kit earned',
    ready.length === 2 && ready.every((c) => c.btn && /^领取 \d+原石$/.test(c.btn.label)),
    ready.map((c) => `${c.name} ${c.btn?.label}`).join(' | '));
  check('and they are sorted to the top of the category',
    built[0]?.ready === true && built[1]?.ready === true,
    built.map((c) => `${c.name}${c.ready ? '*' : ''}`).slice(0, 4).join(' '));
  await shot('ready');

  const g0 = await gems();
  const first = ready[0];
  const want = Number(/(\d+)原石/.exec(first.btn.label)?.[1] || 0);
  if (check('领取 is clickable', await p.evaluate((id) => {
    const btn = document.querySelector(`.panel [data-act="ach-claim"][data-ach="${id}"]`);
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }, first.id), `${first.name} for ${want}`)) {
    await sleep(2200);
    const g1 = await gems();
    check('the tier pays the primogems it advertised', g1 - g0 === want, `${g0} -> ${g1} (want +${want})`);
    const after = (await cards()).find((c) => c.name === first.name);
    check('the card stops offering itself',
      !!after && after.ready === false && after.btn === null,
      after ? `ready ${after.ready}, pay "${after.pay}"` : 'card gone');
    const c1 = await chip();
    check('the chip counts down', c1.shown === true && c1.n === 1, JSON.stringify(c1));
    await shot('claimed-one');
  }

  // --- 全部领取 -------------------------------------------------------------
  const f0 = await footBtns();
  check('全部领取 offers the count that is left',
    f0.some((x) => x.act === 'ach-claim-all' && x.label === '全部领取 (1)' && !x.dis),
    f0.map((x) => `${x.label}${x.dis ? '(off)' : ''}`).join(' | '));
  const g2 = await gems();
  check('全部领取 is clickable', await clickAct('ach-claim-all'));
  await sleep(2200);
  const g3 = await gems();
  check('and it pays the rest', g3 > g2, `${g2} -> ${g3}`);
  const c2 = await chip();
  check('the chip disappears when nothing is collectable',
    c2.shown === false, JSON.stringify(c2));
  const f1 = await footBtns();
  check('and 全部领取 goes dead',
    f1.find((x) => x.act === 'ach-claim-all')?.dis === true,
    f1.map((x) => `${x.label}${x.dis ? '(off)' : ''}`).join(' | '));
  // A tiered achievement does not read as "finished" when its first tier is paid — it moves on
  // to the next threshold, which is the point of tiering. So what must be true is that the card
  // advanced: it earned a tier badge, it stopped offering a button, and the price it now shows
  // is the *next* tier's, higher than the one just collected.
  const advanced = (await cards()).find((c) => c.name === first.name);
  check('a paid tier advances the card instead of repeating itself',
    !!advanced && advanced.ready === false && advanced.btn === null
    && advanced.tier === '①' && Number(/(\d+)原石/.exec(advanced.pay)?.[1] || 0) > want,
    advanced ? `tier ${advanced.tier}, pay ${advanced.pay} after paying ${want}` : 'card gone');
  check('and nothing in the category is collectable any more',
    (await cards()).every((c) => c.ready === false),
    (await cards()).map((c) => `${c.name}:${c.pay}`).slice(0, 4).join(' | '));
  await shot('claimed-all');

  // --- reopening -----------------------------------------------------------
  // Progress is derived, so the failure mode is a stale *view*, not a desync: a panel rebuilt
  // from a cached snapshot would offer the reward that was just paid.
  await p.keyboard.press('Escape');
  await sleep(700);
  await p.keyboard.press('KeyH');
  await sleep(2500);
  check('reopening does not re-offer what was just paid',
    (await cards()).every((c) => c.ready === false) && (await chip()).shown === false,
    (await cards()).filter((c) => c.ready).map((c) => c.name).join(',') || 'nothing offered');
  const catsAfter = await cats();
  check('and the category badges are gone with it',
    catsAfter.every((c) => c.badge === ''),
    catsAfter.map((c) => `${c.name}:${c.badge}`).join(' '));
  await shot('reopened');

  check('the catalogue passes its own gate', achGateReport().length === 0,
    achGateReport().join(' | '));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('probe ran to completion', false, e?.message || String(e));
  await shot('crash').catch(() => {});
} finally {
  await b.close().catch(() => {});
}

// A probe that asserts nothing is worse than a red one; the count is part of the verdict.
console.log(`\n${pass} passed, ${fail} failed`);
if (pass < 22) { console.log('too few assertions ran — treat this as a failure'); process.exit(1); }
process.exit(fail);
