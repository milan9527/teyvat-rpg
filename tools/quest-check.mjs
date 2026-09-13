// 任务 probe: the quest panel, in a real browser.
//
//   DISPLAY=:99 node tools/quest-check.mjs [baseUrl] [outDir]
//
// `api-check.mjs` proves the wiring: only a validating route can advance a stage, the four
// commissions roll over by period key, and `GET /api/quests` carries the moment today ends.
// None of that is visible to a player, and the part that *is* visible is new: the panel now
// prints how long today's 委托 last. That string is the only thing telling an offline player
// crossing 04:00 that the four commissions they see are today's, so it is worth a probe.
//
// What is asserted here: the panel opens on J, story and daily quests are both listed and
// labelled, a staged quest draws its progress as real geometry (read with
// `getBoundingClientRect`, because a collapsed container is exactly the bug an inline
// `width: 33%` would hide), the daily countdown is present and parses to a plausible number of
// hours, and reopening the panel does not lose it. Nothing pins a quality tier: every
// assertion reads the DOM, so llvmpipe's frame behind the panel is irrelevant.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { QUESTS, DAILY_IDS, questGateReport } from '../shared/src/data/quests.js';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/quest';
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
  if (drained.length) console.log(drained.slice(-10).join('\n'));
}

const panelTitle = () => p.evaluate(() => document.querySelector('.panel h2')?.textContent ?? null);

/** The quest cards, with each stage bar read as real geometry. */
const cards = () => p.evaluate(() => [...document.querySelectorAll('.panel .quest')].map((c) => ({
  type: c.querySelector('.type')?.textContent || '',
  name: c.querySelector('[data-f="nm"]')?.textContent || '',
  done: c.classList.contains('done'),
  stages: [...c.querySelectorAll('.prog')].map((r) => {
    const bar = r.querySelector('.bar');
    const fill = r.querySelector('.bar > i');
    return {
      label: r.children[0]?.textContent?.trim() || '',
      num: r.querySelector('.num')?.textContent || '',
      barW: bar ? bar.getBoundingClientRect().width : 0,
      fillW: fill ? fill.getBoundingClientRect().width : 0,
    };
  }),
  rewards: c.querySelector('.tiny.muted')?.textContent || '',
})));

const footNote = () => p.evaluate(() => document.querySelector('.panel footer span')?.textContent || '');

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
  check('the solo world booted', await p.evaluate(() => !!window.game?._running));

  await p.keyboard.press('KeyJ');
  await sleep(2000);
  check('J opens 任务', (await panelTitle()) === '任务');
  const cs = await cards();
  check('the panel lists quests', cs.length > 0, `${cs.length} cards`);
  await shot('panel');

  // Both kinds have to be on screen: a panel that only renders the story chain would still
  // look right, and the dailies are the half the rollover is about.
  const daily = cs.filter((c) => c.type === '每日委托');
  const story = cs.filter((c) => c.type === '魔神任务');
  check('the four commissions are listed', daily.length === DAILY_IDS.length,
    daily.map((c) => c.name).join(' | ') || 'none');
  check('and the story chain is too', story.length > 0,
    story.map((c) => c.name).slice(0, 3).join(' | ') || 'none');

  // A fresh guest has q_intro active at stage 1 of 3: the first bar must be a real fraction of
  // a real container, not a zero-width sliver in a collapsed row.
  const intro = cs.find((c) => c.name.includes(QUESTS.q_intro.name));
  check('a staged quest lists all of its stages',
    !!intro && intro.stages.length === QUESTS.q_intro.stages.length,
    intro ? `${intro.stages.length} stages: ${intro.stages.map((s) => s.num).join(' ')}` : 'no card');
  check('and every stage bar has a measurable container',
    !!intro && intro.stages.every((s) => s.barW > 20)
    && intro.stages.every((s) => s.fillW >= 0 && s.fillW <= s.barW + 1),
    intro ? intro.stages.map((s) => `${s.fillW.toFixed(0)}/${s.barW.toFixed(0)}px`).join(' ') : 'no card');
  check('a commission shows what it pays',
    daily.every((c) => /原石|摩拉/.test(c.rewards)),
    daily.map((c) => c.rewards.slice(0, 24)).join(' | '));

  // The countdown: the whole point of the new rollover being legible.
  const note = await footNote();
  const hrs = Number(/每日委托 (\d+)小时/.exec(note)?.[1] ?? NaN);
  const mins = Number(/每日委托 (\d+)分后/.exec(note)?.[1] ?? NaN);
  check('the footer says when today\'s commissions refresh',
    /^每日委托 .+后刷新/.test(note), note || 'empty');
  check('and the number is a plausible slice of one day',
    (Number.isFinite(hrs) && hrs >= 0 && hrs < 24) || (Number.isFinite(mins) && mins >= 0 && mins <= 60),
    note);

  // Reopening rebuilds the panel from a fresh GET; the countdown must survive that.
  await p.keyboard.press('Escape');
  await sleep(600);
  await p.keyboard.press('KeyJ');
  await sleep(2200);
  const note2 = await footNote();
  check('reopening keeps the countdown', /^每日委托 .+后刷新/.test(note2), note2 || 'empty');
  check('and still lists both kinds of quest',
    (await cards()).some((c) => c.type === '每日委托') && (await cards()).some((c) => c.type === '魔神任务'));
  await shot('reopened');

  check('the quest catalogue passes its own gate', questGateReport().length === 0,
    questGateReport().join(' | '));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('probe ran to completion', false, e?.message || String(e));
  await shot('crash').catch(() => {});
} finally {
  await b.close().catch(() => {});
}

// A probe that asserts nothing is worse than a red one; the count is part of the verdict.
console.log(`\n${pass} passed, ${fail} failed`);
if (pass < 12) { console.log('too few assertions ran — treat this as a failure'); process.exit(1); }
process.exit(fail);
