// 任务结算 probe: what a player sees when a chapter ends.
//
//   DISPLAY=:99 node tools/questend-check.mjs [baseUrl] [outDir]
//
// Finishing a story quest used to produce 「任务完成 · 风起之时」 in the banner, a chime, and two
// toasts for mora and primogems. Three things were missing from that, and each of them was
// *authored data with no consumer*:
//
//   1. `outro` — the line the giver says when it is over. Written for two quests, printed by
//      nobody, and absent from the other eight. Data rots both ways, so the gate now demands one
//      for every quest that shows a completion screen and refuses one on every quest that does
//      not (`questHasEnding`).
//   2. The rest of the rewards. 御风之刃 (a 4★ sword), 大英雄的经验 ×2, 纠缠之缘 ×2 were granted
//      silently, because the toasts only covered the two currencies. `rewardList` is now one
//      shared list, so the card and the quest panel cannot name different things — and it is the
//      list this probe compares the DOM against.
//   3. The next chapter. The server activates it in the same transaction and used to tell nobody:
//      the row existed in Postgres and in no session, so the tracker went quiet and the story
//      stalled until the player happened to reload. The completion now travels with the
//      follow-up record, and the assertion for it is the one that matters most here — the arrow
//      has to be pointing at the next objective in the same second the last one finished.
//
// Sections 1–2 are node: the data gate (with mutations that prove the gate can fail) and the
// structural rules that keep one sentence in one place. Section 3 finishes 风起之时 in a real
// browser — talk to 莉莎, walk to the statue, then kill three slimes through the local sim and
// the trusted kill route — and reads the card off the screen: text, reward rows, the next
// objective, painted pixels, and the two design claims (the game keeps running behind it, and a
// 每日委托 gets the banner instead).
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';
import {
  QUESTS, STORY_CHAIN, DAILY_IDS, EXTRA_IDS, questHasEnding, questGateReport,
} from '../shared/src/data/quests.js';
import { rewardList, itemDef } from '../shared/src/data/items.js';
import { trackedQuest } from '../shared/src/data/questNav.js';
import { decodePng } from './lib/png.mjs';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/questend-check';
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
  prog: read('server/src/services/progression.js'),
  game: read('client/src/game/game.js'),
  ui: read('client/src/ui/ui.js'),
  end: read('client/src/ui/questend.js'),
  panels: read('client/src/ui/panels.js'),
  css: read('client/src/ui/style.css'),
  quests: read('shared/src/data/quests.js'),
  items: read('shared/src/data/items.js'),
};
const nocomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/* ==================================== 1. the ending is authored, both ways ======== */

console.log('--- 1. every quest that ends on a card has an ending to show');

check('the quest gate is clean', questGateReport().length === 0,
  questGateReport().join(' | ') || `${Object.keys(QUESTS).length} quests walked`);

const ending = Object.values(QUESTS).filter(questHasEnding);
const plain = Object.values(QUESTS).filter((d) => !questHasEnding(d));
check('the predicate splits the catalogue, so neither branch is empty',
  ending.length > 0 && plain.length > 0, `${ending.length} with a card, ${plain.length} without`);
check('every quest that shows a card has a giver line and a closing line',
  ending.every((d) => d.intro && d.outro),
  ending.filter((d) => !(d.intro && d.outro)).map((d) => d.id).join(' ') || `${ending.length} quests`);
check('...and no quest carries a closing line nothing will print',
  plain.every((d) => !d.outro),
  plain.filter((d) => d.outro).map((d) => d.id).join(' ') || `${plain.length} dailies`);
// The card belongs to the story chain *and* to the 传说/世界任务, which are the quests that end
// on a line of writing; the four commissions get a banner. Spelled out as the union of the three
// authored lists rather than as `type !== 'daily'`, so that adding a quest type without deciding
// whether it closes on a card fails here instead of shipping a blank card.
const carded = [...STORY_CHAIN, ...EXTRA_IDS];
check('...and the ones with a card are the story chain plus the 传说/世界任务, not an accident of typing',
  ending.map((d) => d.id).sort().join(',') === [...carded].sort().join(','),
  `${ending.length} with a card vs ${carded.length} authored (${STORY_CHAIN.length} story + ${EXTRA_IDS.length} extras)`);
check('the closing lines are written, not placeholders',
  ending.every((d) => d.outro.length >= 8 && !/TODO|todo|xxx/.test(d.outro)),
  `shortest ${Math.min(...ending.map((d) => d.outro.length))} chars`);

// Every reward the card will print has to be nameable. This is the assertion that would have
// caught `采集点（sweetFlower）` in the other direction: an id in a rewards list that resolves to
// nothing reaches the player as a latin identifier in the middle of a Chinese sentence.
const rewardRows = Object.values(QUESTS).flatMap((d) => rewardList(d.rewards).map((r) => ({ q: d.id, ...r })));
check('every reward of every quest resolves to a name and a count',
  rewardRows.length > 0 && rewardRows.every((r) => r.name && r.n > 0),
  `${rewardRows.length} reward rows across ${Object.keys(QUESTS).length} quests`);
check('...and no name is an id',
  rewardRows.every((r) => !/[A-Za-z]{4,}/.test(r.name)),
  rewardRows.filter((r) => /[A-Za-z]{4,}/.test(r.name)).map((r) => `${r.q}:${r.name}`).join(' ') || 'all in Chinese');
check('...and the order is fixed, currency first, so two surfaces cannot disagree',
  rewardList({ mora: 1, primogem: 2, xp: 3, items: [['heroWit', 4]] }).map((r) => r.id).join(',')
  === 'mora,primogem,xp,heroWit');
check('...and every reward item is a real material or weapon',
  rewardRows.every((r) => r.id === 'xp' || itemDef(r.id)),
  rewardRows.filter((r) => r.id !== 'xp' && !itemDef(r.id)).map((r) => r.id).join(' ') || 'all in the tables');

// A gate that cannot fail is a comment. Each mutation below is a real defect the sections above
// claim to catch; the catalogue is restored immediately after.
{
  const mutations = [
    ['a story quest with no outro', () => { const was = QUESTS.q_intro.outro; QUESTS.q_intro.outro = ''; return () => { QUESTS.q_intro.outro = was; }; }],
    ['an outro on a daily nothing shows', () => { QUESTS[DAILY_IDS[0]].outro = '委托：辛苦了。'; return () => { delete QUESTS[DAILY_IDS[0]].outro; }; }],
    ['a reward id that names nothing', () => { const was = QUESTS.q_ruins.rewards.items; QUESTS.q_ruins.rewards = { ...QUESTS.q_ruins.rewards, items: [['windriderEdg', 1]] }; return () => { QUESTS.q_ruins.rewards.items = was; }; }],
    ['a broken next link', () => { const was = QUESTS.q_slimes.next; QUESTS.q_slimes.next = 'q_ruins_typo'; return () => { QUESTS.q_slimes.next = was; }; }],
    ['a chain that disagrees with the links', () => { const was = QUESTS.q_ruins.next; QUESTS.q_ruins.next = 'q_liyue'; return () => { QUESTS.q_ruins.next = was; }; }],
  ];
  const caught = [];
  for (const [what, apply] of mutations) {
    const undo = apply();
    const problems = questGateReport();
    if (problems.length) caught.push(what);
    undo();
  }
  check('the gate rejects each defect it exists to catch', caught.length === mutations.length,
    `${caught.length}/${mutations.length} — missed: ${mutations.map((m) => m[0]).filter((w) => !caught.includes(w)).join(', ') || 'none'}`);
  check('...and the catalogue is clean again afterwards', questGateReport().length === 0,
    questGateReport().join(' | ') || 'restored');
}

/* ============================================ 2. one ending, one place ============ */

console.log('\n--- 2. the completion travels whole, and is phrased once');

check('the server sends the closing line with the completion',
  /outro: def\.outro \|\| null/.test(code.prog) && /chapter: def\.chapter \|\| null/.test(code.prog));
check('...and the follow-up quest, record and all',
  /next = \{/.test(code.prog) && /rec: \{ \.\.\.player\.quests\[def\.next\] \}/.test(code.prog),
  'the client can insert the row instead of waiting for a reload');
check('...only on the update that finished a quest',
  /\.\.\.\(questDone \? \{/.test(code.prog), 'a stage advance stays a delta');
check('the client folds the follow-up into the live document',
  /u\.next\?\.id && u\.next\.rec/.test(code.game) && /this\.player\.quests\[u\.next\.id\] =/.test(code.game));
check('...and decides on the card with the shared predicate, not its own type test',
  /questHasEnding\(QUESTS\[id\]\)/.test(code.game)
  && !/type === 'story'/.test(nocomment(code.game)),
  'one rule for which quests end on a card');
check('the card is bound to the game event, in the layer that owns the DOM',
  /g\.on\('questComplete'/.test(code.ui) && /new QuestEnd\(root, game\)/.test(code.ui));
check('...and Escape clears it before it can open the pause menu',
  code.ui.indexOf('this.questEnd.close()') < code.ui.indexOf('this.panels.open(\'settings\')')
  && /this\.questEnd\.close\(\)/.test(code.ui));
// The design claim, asserted as a rule about the code as well as in pixels below: a reward
// screen that pauses the game and eats the keyboard is a way to die to your own reward in
// multiplayer, where the world keeps swinging.
check('the card does not pause the game and is not a scrim',
  !/setPaused|scrim/.test(nocomment(code.end)), 'nothing to die behind');
check('the card prints all four things it exists for',
  /qe-outro/.test(code.end) && /rewardList\(rewards\)/.test(code.end)
  && /next\.stageDesc/.test(code.end) && /qe-chapter/.test(code.end),
  'chapter, outro, rewards, next objective');
check('...and the quest panel prints its reward preview from the same list',
  /rewardList\(qd\.rewards \|\| \{\}\)/.test(code.panels)
  && !/MATERIALS\[id\]\?\.name \|\| WEAPONS\[id\]\?\.name \|\| id/.test(code.panels),
  'no second fallback that can print an id');
// `nocomment`, not the raw file: the claim is that shared data touches no DOM, and prose is not
// code. This went red the day `equipName()` arrived with a comment saying an artifact instance
// "is a document with its own rolls" — a false positive that says nothing about node-testability,
// and the kind that teaches people to write worse comments.
check('...and the list itself lives in shared data, testable in node',
  /export function rewardList/.test(code.items) && !/document|window/.test(nocomment(code.items)));

// Styles, both ways: a class the card writes with no rule is an invisible card, and a rule for a
// class nothing writes is dead CSS. Checking `.qe-*` in both directions costs nothing and is
// exactly the mistake a hand-written stylesheet makes.
{
  const used = [...new Set([...code.end.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/))
    .concat([...code.end.matchAll(/h\('[a-z]+', '([^']+)'/g)].flatMap((m) => m[1].split(/\s+/))))]
    .filter((c) => c.startsWith('qe-') || c === 'questend');
  const styled = [...new Set([...code.css.matchAll(/\.(qe-[a-z-]+|questend)\b/g)].map((m) => m[1]))];
  const unstyled = used.filter((c) => !styled.includes(c));
  const unused = styled.filter((c) => !used.includes(c));
  check('every class the card writes has a rule', used.length >= 8 && unstyled.length === 0,
    `${used.length} classes, missing: ${unstyled.join(' ') || 'none'}`);
  check('...and every rule is for a class the card writes', unused.length === 0,
    `${styled.length} styled, orphaned: ${unused.join(' ') || 'none'}`);
}

/* ================================= 3. finishing 风起之时 in a real browser ========= */

console.log('\n--- 3. finishing the first chapter, and what the screen says about it');

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
/** Wait for `n` rendered frames — llvmpipe runs this scene at a few frames a second. */
async function frames(n = 3) {
  const from = await p.evaluate(() => window.__probeFrames || 0);
  for (let i = 0; i < 400; i++) {
    const now = await p.evaluate(() => window.__probeFrames || 0);
    if (now - from >= n) return now - from;
    await sleep(120);
  }
  return -1;
}
/** Poll a page-side reader until it answers something real. Returns null on timeout. */
async function waitFor(what, fn, timeout = 12000, arg = undefined) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const v = await p.evaluate(fn, arg);
    if (v !== null && v !== undefined && v !== false) return v;
    await sleep(200);
  }
  console.log(`  (timed out waiting for ${what})`);
  return null;
}
/** The quest document, as state rather than as DOM. */
const quests = () => p.evaluate(() => Object.fromEntries(
  Object.entries(window.game.player.quests || {}).map(([k, v]) => [k, { state: v.state, stageIndex: v.stageIndex, counters: v.counters }])));
/**
 * The quest document once `want` is true of it — or after `timeout`, whichever comes first.
 *
 * A stage advance is an HTTP round trip (`POST /api/world/quest`, then the reply rewrites
 * `player.quests`), so reading the document in the same breath as the interaction is a race that
 * the machine wins most of the time and loses under load: this probe reported 「walked 28 m →
 * stage 0」 inside a loaded `check-all` run and 「stage 1」 standing on its own, from the same
 * build. The wait is bounded and the caller still asserts, so a stage that never advances fails
 * — it just fails for the right reason.
 */
async function questsWhen(what, want, timeout = 12000) {
  const until = Date.now() + timeout;
  let q = await quests();
  while (!want(q) && Date.now() < until) {
    await sleep(200);
    q = await quests();
  }
  if (!want(q)) console.log(`  (timed out waiting for ${what})`);
  return q;
}
// `rank` is in here because the quest pays 500 冒险经验 and 冒险等阶 pays *its own* 20 primogems
// per rank (plus 2 纠缠之缘 every fifth rank). Without it the expected purse delta is a guess.
const purse = () => p.evaluate(() => ({
  mora: window.game.player.mora, gem: window.game.player.primogem,
  ticket: window.game.player.wishTicket, wit: window.game.player.inventory?.adventurerXp || 0,
  rank: window.game.player.adventureRank || 0,
}));
/** Everything the completion card is saying. */
const card = () => p.evaluate(() => {
  const el = document.querySelector('.questend');
  if (!el) return null;
  const box = el.querySelector('.qe-card');
  const r = box.getBoundingClientRect();
  return {
    chapter: el.querySelector('.qe-chapter')?.textContent || '',
    name: el.querySelector('.qe-name')?.textContent || '',
    outro: el.querySelector('.qe-outro')?.textContent || '',
    rewards: [...el.querySelectorAll('.qe-item')].map((i) => ({
      icon: i.querySelector('.qe-ico')?.textContent || '',
      name: i.querySelector('.qe-nm')?.textContent || '',
      n: i.querySelector('.qe-n')?.textContent || '',
    })),
    nextShown: !el.querySelector('[data-f="next"]')?.classList.contains('hidden'),
    nextName: el.querySelector('[data-f="nextname"]')?.textContent || '',
    nextIntro: el.querySelector('[data-f="nextintro"]')?.textContent || '',
    nextGoal: el.querySelector('[data-f="nextgoal"]')?.textContent || '',
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    scrim: !!document.querySelector('.scrim'),
    paused: !!window.game._paused,
  };
});
const tracker = () => p.evaluate(() => {
  const tr = document.querySelector('[data-f="tracker"]');
  const nv = document.querySelector('[data-f="qnav"]');
  return {
    shown: tr ? !tr.classList.contains('hidden') : false,
    title: tr?.querySelector('b')?.textContent || '',
    objective: tr?.querySelector('span')?.textContent || '',
    where: nv?.querySelector('[data-f="qwhere"]')?.textContent || '',
  };
});
const ink = (img, r, frac = 0.25) => {
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
};

/**
 * Walk to an interactable and use it, on the product's own click-to-move path.
 *
 * Not a teleport: writing `game.me.x` moves the character for about a second and then the
 * position correction lerps it back, which reads as a passing assertion about a game the player
 * never sees. This is the same call the click handler makes.
 */
async function walkTo(id, capFrames = 420) {
  const order = () => p.evaluate((wanted) => {
    const g = window.game;
    const e = (g.world.interactables || []).find((x) => x.id === wanted);
    if (!e) return null;
    g.me.setGoal(e.x, e.z, 'interact', e);
    // The same stopping distance `LocalPlayer.update` uses for an 'interact' order, so "did it
    // arrive?" is asked in the product's own units instead of a hand-picked 2.5 m.
    return { id: e.id, x: e.x, z: e.z, d: Math.hypot(e.x - g.me.x, e.z - g.me.z),
      stopAt: Math.max(1.4, (e.radius ?? 2) * 0.6) };
  }, id);
  const it = await order();
  if (!it) return null;
  it.was = Math.round(it.d);
  it.frames = 0; it.reissues = 0; it.arrived = false; it.answered = false;
  while (it.frames < capFrames) {
    const got = await frames(3);
    if (got < 0) break;               // the page stopped rendering; the caller's own gate says so
    it.frames += got;
    const s = await p.evaluate((w) => {
      const g = window.game;
      const e = (g.world.interactables || []).find((x) => x.id === w);
      return { d: e ? Math.hypot(e.x - g.me.x, e.z - g.me.z) : 999, goal: !!g.me.goal,
        scrim: !!document.querySelector('.scrim') };
    }, id);
    it.d = s.d;
    if (s.scrim) { it.arrived = true; it.answered = true; break; }
    if (s.d <= it.stopAt + 0.4) { it.arrived = true; break; }
    // The order was dropped without arriving — the walk slid along a slope it refuses, or
    // something else took the goal. A player would click again, so click again: bounded, and
    // counted, because a walk that needs six clicks to cross 28 m of meadow is a product bug.
    if (!s.goal) {
      if (it.reissues >= 6) break;
      it.reissues++;
      await order();
    }
  }
  // Wait for the dialogue the interaction opens rather than for a fixed 1.6 s. Not every
  // interactable opens one (七天神像 is a touch, not a conversation), so a miss is not a failure
  // here — the caller's stage assertion is the gate.
  if (!it.answered) {
    it.answered = !!await waitFor(`${id} to open a dialogue (a touch does not, and need not)`,
      () => !!document.querySelector('.scrim'), 6000);
  }
  // The conversation modal pauses the game; the stage advanced when the request returned, so
  // dismissing it skips nothing. Its own ✕, never Escape — Escape with nothing open is 设置.
  for (let i = 0; i < 4; i++) {
    const closed = await p.evaluate(() => {
      const btn = document.querySelector('.scrim .close');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!closed) break;
    await sleep(500);
  }
  await frames(3);
  it.d = Math.round(it.d * 10) / 10;
  return it;
}
/** What a walk actually did, for the assertion that depends on it. */
const walkLine = (w) => (w
  ? `${w.was} m → ${w.d} m of ${w.stopAt.toFixed(1)} in ${w.frames}f${w.reissues ? `, ${w.reissues} re-clicks` : ''}${w.arrived ? '' : ', never arrived'}${w.answered ? '' : ', no dialogue'}`
  : 'the interactable is not in this world');

/**
 * Kill one level-1 enemy through the local simulation and the trusted kill route.
 *
 * Level 1 on purpose: llvmpipe runs this page at three frames a second and the auto-attack loop
 * swings once per frame, so a camp mob's hit points turn a pass/fail assertion into a stopwatch
 * race (`tools/solo-check.mjs` learned this the hard way). The reward path is the same either
 * way — `POST /api/world/kill` validates the enemy and pays for it, which is what advances the
 * quest stage.
 */
async function killOne(kind, budgetMs = 120000, leaveHp = 70) {
  const spawned = await p.evaluate(([k, hp]) => {
    const g = window.game;
    const a = g.me.ry;
    const e = g.socket.inst.spawnEnemy(k, 1, g.me.x + Math.sin(a) * 3, g.me.z + Math.cos(a) * 3);
    if (!e) return null;
    // Wounded on arrival. A level-1 water slime has 320 hp and the auto-attack loop swings once
    // per frame, so at llvmpipe's three frames a second one slime costs 40 s — and it got worse
    // as the run went on (37 s, then 118 s, then a 120 s timeout with 145 hp left, which is how
    // this was found). What this probe asserts is the completion *screen*; the character's dps is
    // `tools/solo-check.mjs`'s assertion. The kill itself is untouched: the same swings, the same
    // `POST /api/world/kill` validation, the same loot and the same stage counter.
    e.hp = Math.min(e.hp, hp);
    return { id: e.id, hp: Math.round(e.hp) };
  }, [kind, leaveHp]);
  if (!spawned) return null;
  const t0 = Date.now();
  let paused = 0, closed = 0, minD = 99;
  while (Date.now() - t0 < budgetMs) {
    // One poll = one mouse click on the enemy, repeated: lock it, and if it is out of reach walk
    // at it. Everything the swing itself needs is the product's own auto-attack loop in
    // `_handleMouse` — the probe never calls `me.attack`, or it would pass on a build where
    // mouse-only combat is broken.
    //
    // Two things this loop learned the hard way, both of them silent:
    //   * `setTarget` in the same evaluate as `spawnEnemy` clears itself on the next frame. The
    //     actor has not streamed in yet, so the auto-attack block looks up `enemyById` → null and
    //     calls `_clearTarget()`. The lock has to be (re-)taken once the actor exists.
    //   * `_handleMouse` is inside the `if (!this._paused)` gate, so any leftover modal — the
    //     statue's unlock screen, a dialogue — means zero swings for the whole budget. That is
    //     correct for the game and fatal for the probe, so a scrim found here gets closed and
    //     counted.
    const s = await p.evaluate((id) => {
      const g = window.game;
      const live = g.socket.inst.enemies.get(id);
      if (!live || !live.alive) return { gone: true };
      let shut = false;
      if (g._paused) {
        const btn = document.querySelector('.scrim .close');
        if (btn) { btn.click(); shut = true; }
      }
      const e = g.actors.enemyById(id);
      if (!e || !e.alive) return { paused: !!g._paused, shut, actor: false };
      g.setTarget(id);
      g.autoAttack = true;
      const d = Math.hypot(e.x - g.me.x, e.z - g.me.z);
      const reach = g.me.isRanged ? 26 : g.me.weaponReach + 1.2;
      if (d > reach) g.me.setGoal(e.x, e.z, 'approach');
      return { paused: !!g._paused, shut, actor: true, d, hp: Math.round(live.hp) };
    }, spawned.id);
    if (s.gone) return { ...spawned, ms: Date.now() - t0, paused, closed };
    if (s.paused) paused++;
    if (s.shut) closed++;
    if (s.d !== undefined) minD = Math.min(minD, s.d);
    spawned.left = s.hp;
    await sleep(700);
  }
  return { ...spawned, ms: Date.now() - t0, alive: true, paused, closed,
    minD: +minD.toFixed(1) };
}

/** One-line diagnosis of a kill, for the assertion detail — why it took that long, or failed. */
const killLine = (k) => (k
  ? `${k.hp}hp/${(k.ms / 1000).toFixed(0)}s${k.alive ? ` ALIVE left=${k.left} minD=${k.minD}` : ''}`
    + `${k.paused ? ` paused×${k.paused}` : ''}${k.closed ? ` closed×${k.closed}` : ''}`
  : 'no spawn');

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
  check('the solo world booted', await p.evaluate(() => !!window.game?._running && !!window.game?.playerId));
  await p.evaluate(() => {
    window.__probeFrames = 0;
    window.game.on('frame', () => { window.__probeFrames++; });
  });
  await p.evaluate(() => {
    window.game.setAutoQuality(false);
    window.game.setQuality('high');
    // Noon, pinned: see daylight-check.mjs — the authored sky is what 12:00 returns.
    window.game.setWorldTime(12);
  });
  await sleep(2500);
  check('the quality tier is pinned to high', await p.evaluate(() => window.game.quality) === 'high');
  check('the game is rendering, so a stale frame cannot pass for a fresh one', (await frames(4)) >= 4);
  await p.evaluate(() => window.game.tutorial.skip());

  const q0 = await quests();
  check('a fresh traveller starts the first chapter at its first stage',
    q0.q_intro?.state === 'active' && (q0.q_intro?.stageIndex || 0) === 0,
    `q_intro ${q0.q_intro?.state} stage ${q0.q_intro?.stageIndex}`);
  check('...and no completion card is on screen before anything is finished',
    (await card()) === null);

  /* ------------------------------------------------- the three stages, for real -- */
  const walk1 = await walkTo('scholar');
  const q1 = await questsWhen('the first stage to advance', (q) => (q.q_intro?.stageIndex || 0) >= 1);
  check('talking to the giver advances the first stage', (q1.q_intro?.stageIndex || 0) === 1,
    `walked ${walkLine(walk1)} → stage ${q1.q_intro?.stageIndex}`);
  const walk2 = await walkTo('mond_statue');
  const q2 = await questsWhen('the second stage to advance', (q) => (q.q_intro?.stageIndex || 0) >= 2);
  check('...and reaching the statue advances the second', (q2.q_intro?.stageIndex || 0) === 2,
    `walked ${walkLine(walk2)} → stage ${q2.q_intro?.stageIndex}`);
  await shot('two-stages-in');

  const need = QUESTS.q_intro.stages[2].count;
  // The purse is read *here*, not at boot: unlocking 七天神像 pays 30 primogems of its own, so a
  // snapshot taken before the walk turns 「the quest paid 60」 into 「something paid 90」. Kills pay
  // mora and items but never primogems, so the gem delta across the kills is the quest's alone.
  const before = await purse();
  const kills = [];
  for (let i = 0; i < need; i++) {
    const k = await killOne('slimeWater');
    kills.push(k);
    if (!k || k.alive) break;
    // The card lands on the last one; the first two only have to count.
    if (i < need - 1) await frames(2);
  }
  // Found by reading the chat log in the screenshot above: every kill printed 「获得 史莱姆凝液
  // ×2、摩拉 ×50、摩拉 ×50」, because the server's loot map already contains the mora and the
  // client named `d.mora` a second time. Rewards are what this round is about, so it is pinned
  // here — in the chat lines the kills just produced.
  const lootLines = await p.evaluate(() => [...document.querySelectorAll('[data-f="chatlog"] .ln.loot')]
    .map((el) => el.textContent).filter((t) => t.includes('获得')));
  check(`the last stage is finished by killing ${need} slimes, through the kill route`,
    kills.length === need && kills.every((k) => k && !k.alive),
    kills.map(killLine).join(' '));

  check('...and each kill names its mora once, not twice',
    lootLines.length > 0 && lootLines.every((t) => (t.match(/摩拉/g) || []).length <= 1),
    lootLines.slice(-2).join(' | ') || 'no loot lines in the log');

  /* ----------------------------------------------------------------- the card -- */
  let c = null;
  for (let i = 0; i < 24; i++) {
    c = await card();
    if (c) break;
    await sleep(700);
  }
  const def = QUESTS.q_intro;
  if (!check('finishing the chapter puts the completion card on screen', !!c)) {
    note('everything the card says', 'no card to read');
  } else {
    check('...naming the chapter that closed', c.chapter.includes(def.chapter) && c.name === def.name,
      `${c.chapter}${c.name}`);
    check('...and saying what its giver said, instead of ending on a blank line',
      c.outro === def.outro, c.outro);
    const want = rewardList(def.rewards);
    check('...and listing every reward the quest paid, from the shared list',
      c.rewards.length === want.length
      && c.rewards.every((r, i) => r.name === want[i].name && r.n === `×${want[i].n.toLocaleString('en-US')}`),
      c.rewards.map((r) => `${r.icon}${r.name}${r.n}`).join(' '));
    check('...including the ones the old toasts never mentioned',
      c.rewards.some((r) => r.name === '御风之刃' || r.name === '纠缠之缘')
      && c.rewards.some((r) => r.name === '流浪者的经验'),
      'weapons and materials, not just the two currencies');
    check('...with no id anywhere in it',
      !/[A-Za-z]{4,}/.test(c.rewards.map((r) => r.name).join('') + c.outro + c.name));
    check('...and pointing at the next chapter, with its first objective spelled out',
      c.nextShown && c.nextName.includes(QUESTS.q_slimes.name)
      && c.nextIntro === QUESTS.q_slimes.intro
      && c.nextGoal === QUESTS.q_slimes.stages[0].desc,
      `${c.nextName} — ${c.nextGoal}`);
    check('...while the world keeps running behind it, with nothing to die behind',
      c.paused === false && c.scrim === false && (await frames(2)) >= 2,
      'not paused, no scrim, still rendering');
    check('...as a real block of screen, not an empty div',
      c.rect.w > 300 && c.rect.h > 220 && c.rect.x > 0,
      `${c.rect.w}×${c.rect.h} at ${c.rect.x},${c.rect.y}`);

    // Painted, not merely present: the panel ink against the same rectangle with the card
    // hidden. The scene behind it is grass at midday, so the card reads *darker* — the
    // direction matters less than the two readings being different at all.
    const shown = ink(await shot('completion-card'), c.rect);
    await p.evaluate(() => { document.querySelector('.questend').style.visibility = 'hidden'; });
    await frames(2);
    const hidden = ink(await shot('completion-card-hidden'), c.rect);
    await p.evaluate(() => { document.querySelector('.questend').style.visibility = ''; });
    check('...and it is painted, not transparent',
      Math.abs(shown.lum - hidden.lum) > 12,
      `card lum ${shown.lum} rgb ${shown.rgb} / scene lum ${hidden.lum} rgb ${hidden.rgb}`);
  }

  /* ------------------------------------------- the chain hands over immediately -- */
  const q3 = await quests();
  check('the finished quest is done in the live document', q3.q_intro?.state === 'done');
  check('...and the next chapter is active in it, without a reload',
    q3.q_slimes?.state === 'active' && (q3.q_slimes?.stageIndex || 0) === 0,
    `q_slimes ${q3.q_slimes?.state ?? 'missing'}`);
  const tr = await tracker();
  // The row prints the objective *and* its counter (「击败 6 只丘丘人 (0/6)」), which is the point:
  // the follow-up starts at zero and the tracker is already counting it, in the same second the
  // last stage of the previous chapter finished.
  const goal = QUESTS.q_slimes.stages[0];
  check('...so the tracker is already counting the next objective',
    tr.shown && tr.title === QUESTS.q_slimes.name
    && tr.objective.startsWith(goal.desc) && tr.objective.includes(`0/${goal.count}`),
    `${tr.title} — ${tr.objective} — ${tr.where}`);
  check('...which is the quest the shared rule would pick, not whichever row came first',
    trackedQuest(q3)?.id === 'q_slimes' && Object.keys(q3).indexOf('q_slimes') > 0,
    `trackedQuest → ${trackedQuest(q3)?.id} out of ${Object.keys(q3).filter((k) => q3[k].state === 'active').length} active`);

  // What the quest paid, plus what its 冒险经验 paid on top: 500 xp crossed a rank, and a rank is
  // worth 20 原石 (and 2 纠缠之缘 on every fifth). The first version of this assertion read 原石
  // +80 against an expected 60 and called the reward path broken; the extra 20 was the rank the
  // quest itself had just bought. Mora is the one lower bound, because the three kills pay it too.
  const after = await purse();
  const ranks = after.rank - before.rank;
  const fifth = Math.floor(after.rank / 5) > Math.floor(before.rank / 5);
  check('the rewards actually landed in the purse, quest reward plus the rank it bought',
    after.gem - before.gem === def.rewards.primogem + 20 * ranks
    && after.mora - before.mora >= def.rewards.mora
    && after.ticket - before.ticket === 1 + (fifth ? 2 : 0) && after.wit - before.wit === 3,
    `原石 +${after.gem - before.gem} (任务 ${def.rewards.primogem} + 冒险等阶 ${20 * ranks}), `
    + `摩拉 +${after.mora - before.mora} (≥${def.rewards.mora}), 纠缠之缘 +${after.ticket - before.ticket}, `
    + `经验书 +${after.wit - before.wit}`);

  /* --------------------------------------------------------------- dismissing it -- */
  if (c) {
    await p.evaluate(() => document.querySelector('.questend [data-f="ok"]').click());
    await sleep(600);
    check('the 继续 button dismisses the card', (await card()) === null);
    check('...and the game was never paused by it', (await p.evaluate(() => !!window.game._paused)) === false);
  }
  await shot('after-continue');

  /* --------------------------------------------- a 每日委托 gets no card at all -- */
  // The other half of `questHasEnding`, and the only way to test it is to finish one. d_hunt
  // wants twelve kills and three are already banked; the rest are cheap, but if the frame rate
  // makes this too slow the assertion is skipped rather than failed — an unfinished daily proves
  // nothing either way.
  const dailyNeed = QUESTS.d_hunt.stages[0].count;
  // A banner lives 3500 ms (`hud.banner`), and one kill here costs ten seconds, so reading the
  // element after the loop is reading whether the *last* kill happened to be the winning one.
  // It was not: `killOne` returns the moment the local actor dies, the `POST /api/world/kill`
  // round trip that advances the quest lands a beat later, so the poll below saw 'active' on the
  // twelfth kill and paid for a thirteenth — and by then the banner had expired. Record the
  // event instead, from before the first kill. The HUD's own listener is registered at
  // construction and therefore runs first, so by the time this handler sees the event the element
  // is already in the document: one recorder proves both that the game said it and that the HUD
  // drew it. (Same lesson as clearing the log before each action — a window is not evidence.)
  await p.evaluate(() => {
    window.__banners = [];
    window.game.on('banner', (d) => {
      const el = document.querySelector('.banner');
      const r = el?.getBoundingClientRect();
      const rec = {
        title: d.title || '', sub: d.sub || '', t: Math.round(performance.now()),
        el: !!el, w: Math.round(r?.width || 0), h: Math.round(r?.height || 0), opacity: -1,
      };
      window.__banners.push(rec);
      /*
       * `bannerIn` runs 3.4 s `forwards`: opacity 0 → 1 at 14 % → 0 at 100 %, and the end state
       * sticks. So *any* single sample is a lottery ticket on a page llvmpipe runs at three frames
       * a second — an 800 ms timer that lands behind a long frame reads the tail of the animation
       * and calls a banner the player watched for three seconds 「opacity 0」. It did exactly that
       * once, which is the only reason this comment exists.
       *
       * Sample across the whole life and keep the peak: the claim is that the strip is painted at
       * some point, and an element that is never painted peaks at 0 no matter how often it is
       * read. Sampling stops when the next banner takes the element over, so a record never
       * attests to a strip that belongs to a different message.
       */
      if (el) {
        rec.samples = 0;
        const iv = setInterval(() => {
          if (window.__banners[window.__banners.length - 1] !== rec || performance.now() - rec.t > 3600) {
            rec.done = true;
            clearInterval(iv);
            return;
          }
          const o = +getComputedStyle(el).opacity;
          if (Number.isFinite(o)) { rec.opacity = Math.max(rec.opacity, o); rec.samples++; }
          const rr = el.getBoundingClientRect();
          rec.w = Math.max(rec.w, Math.round(rr.width));
          rec.h = Math.max(rec.h, Math.round(rr.height));
        }, 120);
      }
    });
  });
  const banners = () => p.evaluate(() => window.__banners.slice());
  let dq = (await quests()).d_hunt;
  let more = 0;
  const tries = [];
  while ((dq?.state === 'active') && more < dailyNeed) {
    // 120 s a kill: the slime hops, and a lock re-acquired late is the difference between a kill
    // and a SKIP. Nine of these have to fit in the budget, so they arrive wounded like the three
    // above — the daily counts kills, not hit points.
    const k = await killOne('slimeWater', 120000);
    more++;
    tries.push(killLine(k));
    if (!k || k.alive) break;
    // Wait for the server's answer to *this* kill before deciding to buy another one.
    for (let w = 0; w < 12; w++) {
      dq = (await quests()).d_hunt;
      if (dq?.state !== 'active') break;
      await sleep(400);
    }
  }
  console.log(`  daily kills: ${tries.join(' ')} → d_hunt ${dq?.state} ${JSON.stringify(dq?.counters || {})}`);
  if (dq?.state !== 'done') {
    note('a 每日委托 finishes without a card', `d_hunt still ${dq?.state} after ${more} more kills — ${tries.join(' ')}`);
    note('...and says so in the banner instead', 'the daily never finished');
  } else {
    check('a 每日委托 finishes without a card',
      (await card()) === null, `d_hunt done after ${more} more kills`);
    await shot('daily-done');
    // Let the sampler above finish its window rather than guessing how long it needs.
    await waitFor('the banner sampler to finish',
      () => (window.__banners.length && window.__banners.every((x) => !x.el || x.done) ? true : null), 9000);
    const bs = await banners();
    const b = bs.find((x) => /委托完成/.test(x.title) && x.sub.includes(QUESTS.d_hunt.name));
    check('...and says so in the banner instead',
      !!b, b ? `「${b.title} · ${b.sub}」` : bs.map((x) => `${x.title}/${x.sub}`).join(', ') || '(no banner at all)');
    check('...on screen, as a painted strip and not an empty node',
      !!b && b.el && b.w > 200 && b.h > 20 && b.opacity > 0.05,
      b ? `${b.w}×${b.h}, peak opacity ${b.opacity} over ${b.samples} samples` : 'no banner to measure');
    // The other side of that reading: the same recorder, on a banner that is deliberately not
    // painted. A peak over many samples only means something if it can still come out at zero.
    const blind = await p.evaluate(async () => {
      const st = document.createElement('style');
      st.textContent = '.banner { opacity: 0 !important; animation: none !important; }';
      document.head.appendChild(st);
      const at = window.__banners.length;
      window.game.emit('banner', { title: '探针对照', sub: '这一条不该被画出来' });
      await new Promise((r) => setTimeout(r, 1500));
      st.remove();
      const rec = window.__banners[at];
      return rec ? { opacity: rec.opacity, samples: rec.samples, el: rec.el } : null;
    });
    check('...and the same recorder reads an unpainted banner as unpainted',
      !!blind && blind.el && blind.samples > 0 && blind.opacity <= 0.05,
      blind ? `peak opacity ${blind.opacity} over ${blind.samples} samples`
        : 'the control banner never reached the recorder');
  }

  check('no page errors through any of it', errors.length === 0, errors.slice(0, 3).join(' | ') || `card at ${c?.rect.x},${c?.rect.y}`);
} catch (e) {
  check(`the run completed (${e.message})`, false);
  try { await shot('crash'); } catch { /* the page may be gone */ }
} finally {
  await b.close();
}

console.log(`\nquestend-check: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
