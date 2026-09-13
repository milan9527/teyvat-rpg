// 料理: gather → cook → eat. Does a dish do what its own line of data says?
//
//   node tools/food-check.mjs --no-browser     # sections 0-1 only, no display needed
//   DISPLAY=:99 node tools/food-check.mjs [baseUrl] [outDir]
//
// Cooking was already covered on the REST side (`api-check` gathers, cooks a batch and
// checks the tally). *Eating* was covered by one assertion: `POST /api/inventory/use`
// returns 200 and the count drops. That route is only the decrement — the effect belongs to
// the live entity — so what nobody tested was the half a player actually feels. Two bugs
// were sitting in that gap, and both of them destroyed an item:
//
//   * 北地烟熏鸡 at full health: `entity.heal()` returned 0, the dish was gone anyway.
//   * 提神醒脑的汤 standing up: it carries `revive` and no `heal`, so the only branch that
//     could have done anything (`if (def.revive && !entity.alive)`) did not run at all.
//
// and a third that was a printed lie: the dish says `revive: { hpPct: 0.4 }` and the panel
// promised "恢复 40% 生命值", while `entity.revive()` hardcoded 0.5 and read the dish's
// number nowhere.
//
// So the three sections are the three layers the fix touches:
//
//   0. the vocabulary, both ways — every effect key a consumable carries is declared in
//      `CONSUMABLE_EFFECTS` and named to a consumer that exists and reads it, every
//      declared key is carried by some dish, and a fabricated key is reported dead (a
//      scanner that cannot fail makes a green run mean nothing); plus the refusal table for
//      every dish in every state, each rule pinned from both sides.
//   1. the simulation — a real `ZoneInstance`: the revive fraction comes from the dish, the
//      free revive keeps its own default, a revive never *lowers* anyone, `liveStats` folds
//      the food buff and the instance drops it at `until`.
//   2. the browser — the cooking panel drawn from `RECIPES`/`cookOdds`/`maxPortions`, a dish
//      cooked by clicking, the 使用 button greyed with the reason at full health (and the
//      item still there after asking anyway), the same dish eaten after taking damage with
//      the party card's HP fill measured in pixels, and the buff chip with its countdown.
//
// Everything expected is derived from `shared/src/data/*`: this file states no dish's
// numbers of its own, because a probe that restates them only proves someone typed twice.
//
// Exit code is the number of failed assertions.

import { readFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MATERIALS } from '../shared/src/data/items.js';
import { RECIPES, RECIPE_IDS, QUALITY, cookOdds, maxPortions, ingredientText } from '../shared/src/data/recipes.js';
import { CONSUMABLE_EFFECTS, consumableRefusal, consumableEffect } from '../shared/src/world/consumables.js';
import { ZoneInstance } from '../shared/src/world/zoneInstance.js';
import { REVIVE_HP_PCT } from '../shared/src/world/entity.js';
import { liveStats } from '../shared/src/world/procs.js';
import { partyStats, makeWeapon } from '../shared/src/sim/loot.js';
import { STARTER_PARTY } from '../shared/src/data/characters.js';
import { ZONES, gatherNodes } from '../shared/src/data/zones.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NO_BROWSER = process.argv.includes('--no-browser');
const VERBOSE = process.argv.includes('--verbose');
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const base = argv[0] || 'http://127.0.0.1:5173';
const outDir = argv[1] || '/tmp/food-check';
const apiBase = process.env.API_BASE || 'http://127.0.0.1:8787';
const PROBE_PASS = 'probe-pass-1';
const W = 1600, H = 900;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); } else {
    fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONSUMABLES = Object.values(MATERIALS).filter((d) => d.kind === 'consumable');

/* ============================================ 0. the vocabulary, both ways ==== */

console.log('--- 0. consumable effect vocabulary');

const META_KEYS = ['id', 'name', 'icon', 'stack', 'kind', 'desc', 'rarity'];
const strayKeys = [];
for (const def of CONSUMABLES) {
  for (const k of Object.keys(def)) {
    if (!META_KEYS.includes(k) && !CONSUMABLE_EFFECTS[k]) strayKeys.push(`${def.id}.${k}`);
  }
}
check('the scan found the menu it is meant to scan',
  CONSUMABLES.length >= 7 && Object.keys(CONSUMABLE_EFFECTS).length >= 4,
  `${CONSUMABLES.length} consumables, ${Object.keys(CONSUMABLE_EFFECTS).length} declared effect keys`);
check('every effect key a consumable carries is declared', !strayKeys.length, strayKeys.join(' '));
const unusedKeys = Object.keys(CONSUMABLE_EFFECTS).filter((k) => !CONSUMABLES.some((d) => d[k] !== undefined));
check('...and every declared key is carried by some dish', !unusedKeys.length,
  unusedKeys.join(' ') || Object.keys(CONSUMABLE_EFFECTS).join(' '));

// The consumer half. `revive.hpPct` is the reason this section exists: it was authored,
// printed to the player, and read by nobody for as long as the item existed.
const MODULES = {
  'world/consumables': 'shared/src/world/consumables.js',
  'world/entity': 'shared/src/world/entity.js',
  'ws/gateway': 'server/src/ws/gateway.js',
  'net/localSocket': 'client/src/net/localSocket.js',
  'routes/player': 'server/src/routes/player.js',
  'ui/panels': 'client/src/ui/panels.js',
};
const code = {};
for (const [mod, rel] of Object.entries(MODULES)) {
  code[mod] = readFileSync(path.join(ROOT, rel), 'utf8').split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}
check('every consumer file was read', Object.values(code).every((s) => s.length > 1000),
  `${Object.keys(MODULES).length} files`);

/** Is `key` read in a non-comment line of every module the declaration names? */
function keyProblem(key, where) {
  const mods = Object.keys(MODULES).filter((m) => where.includes(m));
  if (!mods.length) return `no known module in "${where}"`;
  for (const m of mods) if (!new RegExp(`\\b${key}\\b`).test(code[m])) return `${key} unread in ${m}`;
  return null;
}
const deadKeys = [];
for (const [key, where] of Object.entries(CONSUMABLE_EFFECTS)) {
  const why = keyProblem(key, where);
  if (why) deadKeys.push(why);
}
check('every declared key is read by the consumer it names', !deadKeys.length, deadKeys.join(' | '));
check('the scan can tell a dead key from a live one',
  keyProblem('notAnEffectKey', 'world/consumables') === 'notAnEffectKey unread in world/consumables'
  && keyProblem('heal', 'nope/nope') === 'no known module in "nope/nope"',
  'fabricated key and fabricated module both reported');

// One level down: a dish's `revive.hpPct` and `buff.duration` are as authorable — and were
// as dead — as the keys above.
for (const [key, sub] of [['revive', 'hpPct'], ['buff', 'duration'], ['heal', 'hpPct']]) {
  const carriers = CONSUMABLES.filter((d) => d[key]?.[sub] !== undefined).map((d) => d.id);
  const readers = Object.keys(MODULES).filter((m) => new RegExp(`\\b${sub}\\b`).test(code[m]));
  check(`${key}.${sub} is authored and read`, carriers.length > 0 && readers.length > 0,
    `${carriers.join(' ')} → read in ${readers.join(', ') || 'nowhere'}`);
}

/* ------------------------------------------- the refusal table, exhaustively -- */

console.log('\n--- 0b. what may be eaten, in every state');

const STATES = {
  full:    { hp: 10000, maxHp: 10000, alive: true },
  wounded: { hp: 3000, maxHp: 10000, alive: true },
  downed:  { hp: 0, maxHp: 10000, alive: false },
};
const matrix = {};
for (const def of CONSUMABLES) {
  matrix[def.id] = Object.fromEntries(
    Object.entries(STATES).map(([k, who]) => [k, consumableRefusal(def, who)]));
}
if (VERBOSE) {
  for (const [id, row] of Object.entries(matrix)) {
    console.log(`     ${id.padEnd(18)} ${Object.entries(row).map(([k, v]) => `${k}:${v || 'ok'}`).join('  ')}`);
  }
}
// Every dish must be usable in some state, or it is an item that can only be sold.
const useless = Object.entries(matrix)
  .filter(([id, row]) => !MATERIALS[id].resin && Object.values(row).every((v) => v !== null));
check('every dish can be eaten in at least one state', !useless.length,
  useless.map(([id]) => id).join(' ') || `${CONSUMABLES.length - 1} dishes`);
// Each rule stated as the state that must refuse *and* the state that must not: "the tint
// did not move it" is equally true of everything that was never going to move.
const healOnly = CONSUMABLES.filter((d) => d.heal && !d.buff && !d.revive);
check('a heal-only dish is refused at full health and allowed when wounded',
  healOnly.length >= 3 && healOnly.every((d) => matrix[d.id].full === 'hp_full' && matrix[d.id].wounded === null),
  healOnly.map((d) => `${d.id}:${matrix[d.id].full}`).join(' '));
const reviveOnly = CONSUMABLES.filter((d) => d.revive && !d.heal && !d.buff);
check('a revive-only dish is refused standing up and allowed when downed',
  reviveOnly.length >= 1 && reviveOnly.every((d) => matrix[d.id].full === 'not_downed'
    && matrix[d.id].wounded === 'not_downed' && matrix[d.id].downed === null),
  reviveOnly.map((d) => `${d.id}: full ${matrix[d.id].full} / downed ${matrix[d.id].downed || 'ok'}`).join(' '));
const buffDishes = CONSUMABLES.filter((d) => d.buff);
check('a buff dish is allowed at full health (the bonus lands either way)',
  buffDishes.length >= 2 && buffDishes.every((d) => matrix[d.id].full === null),
  buffDishes.map((d) => d.id).join(' '));
check('nothing may be eaten while downed except a revive',
  Object.entries(matrix).every(([id, row]) => (row.downed === null) === !!MATERIALS[id].revive),
  Object.entries(matrix).filter(([, r]) => r.downed === null).map(([id]) => id).join(' ') || 'none');
const resinItems = CONSUMABLES.filter((d) => d.resin);
check('a resin potion is sent to the menu instead of the world',
  resinItems.length >= 1 && resinItems.every((d) => Object.values(matrix[d.id]).every((v) => v === 'use_via_menu')),
  resinItems.map((d) => d.id).join(' '));
check('the effect the gate hands back drops the no-op branches',
  consumableEffect(MATERIALS.sweetMadame, STATES.full).heal === null
  && consumableEffect(MATERIALS.sweetMadame, STATES.wounded).heal === MATERIALS.sweetMadame.heal
  && consumableEffect(MATERIALS.reviveDish, STATES.downed).revive === MATERIALS.reviveDish.revive
  && consumableEffect(MATERIALS.reviveDish, STATES.full).revive === null,
  'sweetMadame heal null at full / present when wounded; reviveDish revive present only when downed');

/* ================================================== 1. in the simulation ====== */

console.log('\n--- 1. the live entity');

const LEVEL = 60;
function arena(party = STARTER_PARTY.slice(0, 4)) {
  const inst = new ZoneInstance('mondstadt', 99, { broadcast: () => {} });
  inst.camps.length = 0;
  const chars = {};
  for (const id of party) {
    chars[id] = {
      charId: id, level: LEVEL, ascension: 4, talents: { normal: 1, skill: 1, burst: 1 },
      dupes: 0, weapon: makeWeapon('travelersBlade', LEVEL, 1), artifacts: {},
    };
  }
  const stats = partyStats(chars, party);
  const save = { playerId: 1, party: [...party], activeSlot: 0, zone: 'mondstadt', pos: { x: 0, y: 6, z: 0, ry: 0 } };
  const p = inst.addPlayer(1, 'p1', save, stats);
  inst.stop();
  inst.enemies.clear();
  inst.now = 100;
  inst.events.length = 0;
  return { inst, p, stats };
}

/** Knock the whole party out, the way a wipe leaves it. */
function knockOut(p) {
  p.alive = false;
  for (const c of p.party) p.hpByChar[c] = 0;
  p.hp = 0;
}

// (a) the fraction comes from the dish, not from a constant next to it.
{
  const { p } = arena();
  const max = p.maxHp();
  knockOut(p);
  const dish = MATERIALS.reviveDish;
  const eff = consumableEffect(dish, { hp: p.hp, maxHp: max, alive: p.alive });
  p.revive(eff.revive.hpPct);
  const want = Math.round(max * dish.revive.hpPct);
  check('a revive dish hands back the fraction printed on the dish',
    p.alive && p.hp === want && want !== Math.round(max * REVIVE_HP_PCT),
    `hp ${p.hp} = ${(dish.revive.hpPct * 100).toFixed(0)}% of ${max}; a free revive would give ${Math.round(max * REVIVE_HP_PCT)}`);
  check('...and every party member stands up with it',
    p.party.every((c) => p.hpByChar[c] === Math.round(p.maxHpOf(c) * dish.revive.hpPct)),
    p.party.map((c) => `${c} ${p.hpByChar[c]}/${p.maxHpOf(c)}`).join(' '));
}
// (b) the free revive keeps its own default, so the two sources cannot drift into one.
{
  const { p } = arena();
  const max = p.maxHp();
  knockOut(p);
  p.revive();
  check('a free revive (teammate, respawn) still gives its own default',
    p.hp === Math.round(max * REVIVE_HP_PCT), `hp ${p.hp} of ${max} = ${REVIVE_HP_PCT}`);
}
// (c) a revive must never lower anyone: it lands on the whole party, bench included.
{
  const { p } = arena();
  const bench = p.party[1];
  const benchMax = p.maxHpOf(bench);
  knockOut(p);
  p.hpByChar[bench] = benchMax;
  p.revive(MATERIALS.reviveDish.revive.hpPct);
  check('a revive never lowers a character who is already healthier than the fraction',
    p.hpByChar[bench] === benchMax, `bench ${p.hpByChar[bench]} of ${benchMax}`);
}
// (d) the buff folds into the stats the damage formula reads, and leaves at `until`.
{
  const { inst, p, stats } = arena();
  const st = stats[p.charId];
  const dish = MATERIALS.mintJelly;
  const before = liveStats(p, st, inst.now);
  p.buffs.push({
    kind: 'food', source: dish.id, until: inst.now + dish.buff.duration,
    atkPct: dish.buff.atkPct, critRate: dish.buff.critRate,
  });
  const during = liveStats(p, st, inst.now);
  check('a food buff multiplies the attack the damage formula reads',
    Math.abs(during.atk / before.atk - (1 + dish.buff.atkPct)) < 1e-9,
    `${Math.round(before.atk)} -> ${Math.round(during.atk)} = ${(during.atk / before.atk).toFixed(3)}x, want ${(1 + dish.buff.atkPct).toFixed(3)}x`);
  check('...and adds its crit rate',
    Math.abs(during.critRate - (before.critRate + dish.buff.critRate)) < 1e-9,
    `${before.critRate.toFixed(3)} -> ${during.critRate.toFixed(3)}`);
  const after = liveStats(p, st, inst.now + dish.buff.duration + 1);
  check('...and is gone one second after it ends',
    Math.abs(after.atk - before.atk) < 1e-9 && after.critRate === before.critRate,
    `atk ${Math.round(after.atk)} back to ${Math.round(before.atk)}`);
  // The instance's own expiry: the thing that makes the line above happen by itself.
  p.buffs[0].until = inst.now - 1;
  inst.updatePlayer(p, 0.05);
  check('the instance drops an expired buff on its own tick', p.buffs.length === 0,
    `${p.buffs.length} buffs left`);
}
// (e) one dish at a time: a second meal replaces the first rather than stacking.
{
  const { inst, p, stats } = arena();
  const st = stats[p.charId];
  const base = liveStats(p, st, inst.now);
  const a = MATERIALS.mintJelly, b = MATERIALS.adeptusTemptation;
  for (const dish of [a, b]) {
    p.buffs = p.buffs.filter((x) => x.kind !== 'food');
    p.buffs.push({
      kind: 'food', source: dish.id, until: inst.now + dish.buff.duration,
      atkPct: dish.buff.atkPct, critRate: dish.buff.critRate,
    });
  }
  const two = liveStats(p, st, inst.now);
  check('two dishes do not stack — the newer one replaces the older',
    p.buffs.filter((x) => x.kind === 'food').length === 1
    && Math.abs(two.atk / base.atk - (1 + b.buff.atkPct)) < 1e-9,
    `${(two.atk / base.atk).toFixed(3)}x = ${b.id} alone; stacked would be ${((1 + a.buff.atkPct) * (1 + b.buff.atkPct)).toFixed(3)}x`);
}

if (NO_BROWSER) {
  console.log(`\nfood-check: ${pass} passed, ${fail} failed  (sections 0-1 only)`);
  process.exit(fail);
}

/* ================================================== 2. in the browser ========= */

const { default: puppeteer } = await import('puppeteer');
const { decodePng, rectStats } = await import('./lib/png.mjs');

/** Pixels differing by more than `tol` inside one rect, as a fraction of the rect. */
function rectDiff(a, b, r, tol = 6) {
  let n = 0, total = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * a.width + x) * 4;
      total++;
      if (Math.abs(a.data[i] - b.data[i]) > tol
        || Math.abs(a.data[i + 1] - b.data[i + 1]) > tol
        || Math.abs(a.data[i + 2] - b.data[i + 2]) > tol) n++;
    }
  }
  return total ? n / total : 0;
}

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.png')) rmSync(`${outDir}/${f}`);

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
 * An account with ingredients in the bag, prepared over REST.
 *
 * Named and reused (`foodui1`…`foodui3`) rather than freshly registered, because
 * `/api/register` is rate-limited per IP and a probe that burns the budget makes the next
 * run fail for a reason that has nothing to do with food. Ingredients come from the real
 * gather route on 蒙德 nodes — the same door a walking player uses, and the only source of
 * 甜甜花/薄荷/麦子 in the game. Nodes regrow on a 6 h window, so the fixture walks the whole
 * list until the counts are met and moves to the next account if a run lands inside that
 * window twice. (No live entity exists yet at this point, which is why the route's 14 m
 * reach check does not apply — see `POST /api/world/gather`.)
 */
const NEED = { sweetFlower: 8, mint: 9, wheat: 4 };
async function buildFixture() {
  const nodes = gatherNodes(ZONES.mondstadt);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const username = `foodui${attempt}`;
    let auth = await rest('/api/login', { body: { username, password: PROBE_PASS } });
    if (!auth.token) auth = await rest('/api/register', { body: { username, password: PROBE_PASS, nickname: 'FoodProbe' } });
    const token = auth.token;
    if (!token) { console.log(`  (${username}: no token — ${auth.error || auth.status})`); continue; }
    let inv = (await rest('/api/player/state', { token })).player?.inventory || {};
    let gathered = 0;
    for (const n of nodes) {
      if (Object.entries(NEED).every(([k, v]) => (inv[k] || 0) >= v)) break;
      if (!(n.kind in NEED) || (inv[n.kind] || 0) >= NEED[n.kind]) continue;
      const r = await rest('/api/world/gather', { token, body: { zone: 'mondstadt', nodeId: n.id } });
      if (r.status === 200) { gathered++; inv = r.player?.inventory || inv; }
    }
    const short = Object.entries(NEED).filter(([k, v]) => (inv[k] || 0) < v);
    if (!short.length) return { username, token, inv, gathered };
    console.log(`  (${username}: gathered ${gathered}, still short ${short.map(([k, v]) => `${k} ${inv[k] || 0}/${v}`).join(', ')})`);
  }
  return null;
}

console.log('\n--- 2. fixture: an account with a full larder');
const fx = await buildFixture();
check('the gather route stocked the ingredients cooking needs', !!fx,
  fx ? `${fx.username}: ${Object.keys(NEED).map((k) => `${k} ${fx.inv[k]}`).join(', ')} (${fx.gathered} nodes this run)` : 'three accounts tried');
if (!fx) { console.log(`\nfood-check: ${pass} passed, ${fail} failed`); process.exit(fail || 1); }

const browser = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
    'media.autoplay.default': 0,
  },
  defaultViewport: { width: W, height: H },
});
const page = (await browser.pages())[0] || await browser.newPage();
const NOISE = /WebGL|EGL|GL_|Content Security|favicon|downloadable font|autoplay/i;
const errors = [];
page.on('pageerror', (e) => { const s = String(e).slice(0, 200); if (!NOISE.test(s)) errors.push(s); });
page.on('console', (m) => { if (m.type() === 'error') { const s = m.text().slice(0, 200); if (!NOISE.test(s)) errors.push(s); } });

/** Two rAFs plus a beat: llvmpipe runs this page at ~2 fps, so a screenshot taken any
 *  sooner is the frame from *before* the click, and a stale frame reads every diff as 0. */
async function settle(extra = 400) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
  await sleep(extra);
}
const shot = async (name) => {
  const file = `${outDir}/${name}.png`;
  await page.screenshot({ path: file });
  console.log(`  → ${file}`);
  return decodePng(readFileSync(file));
};
/** Hide the 3D canvas, then shoot.
 *
 *  Every HUD element sits over a live scene: clouds drift, the character breathes, and
 *  `.zone-name` is drawn on top of all of it. Measured against a moving background no HUD
 *  rect is ever static, so the "a control rect did *not* change" half of a diff fails for
 *  reasons that have nothing to do with the HUD. With the canvas hidden both frames share
 *  a flat backdrop and the only thing that can move is the DOM. */
const hudShot = async (name) => {
  await page.evaluate(() => {
    for (const c of document.querySelectorAll('canvas')) c.style.visibility = 'hidden';
  });
  await settle(250);
  const png = await shot(name);
  await page.evaluate(() => {
    for (const c of document.querySelectorAll('canvas')) c.style.visibility = '';
  });
  return png;
};

try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  check('the login screen offers 单机模式', await page.evaluate(() => {
    const btn = document.querySelector('[data-act="solo"]');
    if (!btn) return false;
    btn.click();
    return true;
  }));
  await sleep(400);
  await page.type('[data-f="user"]', fx.username);
  await page.type('[data-f="pass"]', PROBE_PASS);
  await (await page.$('[data-act="login"]')).click();
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  const boot = await page.evaluate(() => ({ running: !!window.game?._running, mode: window.game?.mode }));
  check('the solo world booted on the prepared account', boot.running === true && boot.mode === 'solo',
    `mode ${boot.mode}`);
  // Pin the quality tier: llvmpipe boots every probe at `low` and the governor keeps walking
  // it down, which changes how long a frame takes to arrive even when the DOM is the subject.
  await page.evaluate(() => { window.game.setAutoQuality?.(false); window.game.setQuality?.('high'); });
  await sleep(600);

  /* ------------------------------------------------- 2a. the cooking panel ---- */

  console.log('\n--- 2a. the cooking panel is the shared table');
  await page.evaluate(() => window.game.emit('togglePanel', { panel: 'cook', open: true }));
  await sleep(700);
  await settle();

  const panel = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-recipe]')].map((el) => ({
      id: el.dataset.recipe,
      sel: el.classList.contains('sel'),
      dim: el.classList.contains('dim'),
      name: el.querySelector('b')?.textContent || '',
      sub: el.querySelector('small')?.textContent || '',
      qty: el.querySelector('.qty')?.textContent || '',
    }));
    const ing = [...document.querySelectorAll('.cook-ing .ing')].map((el) => ({
      name: el.querySelector('.nm')?.textContent || '',
      n: el.querySelector('.n')?.textContent || '',
      cls: el.querySelector('.n')?.className || '',
    }));
    const barEl = document.querySelector('.cook-odds');
    const segs = [...document.querySelectorAll('.cook-odds .seg')].map((el) => ({
      key: [...el.classList].find((c) => c !== 'seg'),
      w: el.getBoundingClientRect().width,
    }));
    return {
      rows, ing, segs,
      legend: [...document.querySelectorAll('.cook-legend .lg')].map((el) => el.textContent),
      barW: barEl?.getBoundingClientRect().width || 0,
      foot: (document.querySelector('.panel footer')?.textContent || '').replace(/\s+/g, ' ').trim(),
      ar: window.game.player?.adventureRank ?? 1,
      inv: { ...(window.game.player?.inventory || {}) },
    };
  });
  await shot('01-cook-panel');

  const wantIds = RECIPE_IDS.slice().sort((a, b) => RECIPES[a].rank - RECIPES[b].rank);
  check('every recipe in the table has a row, in rank order',
    panel.rows.map((r) => r.id).join(',') === wantIds.join(','),
    panel.rows.map((r) => r.id).join(' '));
  check('...and each row is named by the dish it makes',
    panel.rows.length > 0 && panel.rows.every((r) => r.name.includes(MATERIALS[r.id].name)),
    panel.rows.map((r) => r.name).join(' | '));
  check('at the account\'s own rank nothing is dimmed that the table says is unlocked',
    panel.rows.every((r) => r.dim === (panel.ar < RECIPES[r.id].rank)),
    `AR ${panel.ar}: locked ${wantIds.filter((id) => panel.ar < RECIPES[id].rank).join(' ') || 'none'} of ${wantIds.length}`);
  // Both halves of the lock rule need a rank *between* the cheapest and the dearest recipe, and
  // the probe account's rank only goes up: the highest recipe is rank 5, the account reached AR 5
  // and 「上面那条锁着、下面那条没锁」 became unprovable — 「locked none of 6」. So the rank is
  // constructed instead of waited for. The panel computes the lock from `game.player`, which is
  // the same read the product does on login, and it is put back afterwards.
  const midRank = Math.max(2, Math.min(...wantIds.map((id) => RECIPES[id].rank))
    + Math.round((Math.max(...wantIds.map((id) => RECIPES[id].rank))
      - Math.min(...wantIds.map((id) => RECIPES[id].rank))) / 2));
  const pinned = await page.evaluate((ar) => {
    const g = window.game;
    const was = g.player.adventureRank;
    g.player.adventureRank = ar;
    window.ui.panels.open('cook');
    return { was, rows: [...document.querySelectorAll('[data-recipe]')].map((el) => ({
      id: el.dataset.recipe,
      dim: el.classList.contains('dim'),
      qty: el.querySelector('.qty')?.textContent || '',
    })) };
  }, midRank);
  check(`...and pinned at AR ${midRank} the rule holds in both directions`,
    pinned.rows.length === wantIds.length
    && pinned.rows.every((r) => r.dim === (midRank < RECIPES[r.id].rank))
    && pinned.rows.filter((r) => r.dim).every((r) => r.qty === '🔒')
    && pinned.rows.some((r) => r.dim) && pinned.rows.some((r) => !r.dim),
    `locked ${pinned.rows.filter((r) => r.dim).map((r) => r.id).join(' ') || 'none'},`
    + ` open ${pinned.rows.filter((r) => !r.dim).map((r) => r.id).join(' ') || 'none'}`);
  await page.evaluate((ar) => {
    window.game.player.adventureRank = ar;
    window.ui.panels.open('cook');
  }, pinned.was);
  await sleep(400);
  check('...and an unlocked row offers the batch maxPortions reads off the same bag',
    panel.rows.filter((r) => !r.dim).every((r) => {
      const can = maxPortions(r.id, panel.inv, 20);
      return r.qty === (can > 0 ? `×${can}` : '—');
    }),
    panel.rows.map((r) => `${r.id}${r.qty}`).join(' '));
  check('...and its sub-line is the shared ingredient text',
    panel.rows.filter((r) => !r.dim).every((r) => r.sub === ingredientText(r.id)),
    panel.rows.filter((r) => !r.dim).map((r) => `${r.id}: ${r.sub}`)[0] || '');

  const selId = panel.rows.find((r) => r.sel)?.id;
  const selRecipe = RECIPES[selId];
  check('the selected recipe lists its own ingredients with have/need',
    !!selRecipe && panel.ing.length === Object.keys(selRecipe.ingredients).length
    && Object.entries(selRecipe.ingredients).every(([id, need], i) =>
      panel.ing[i].name === MATERIALS[id].name
      && panel.ing[i].n.replace(/[\s,]/g, '') === `${panel.inv[id] || 0}/${need}`),
    `${selId}: ${panel.ing.map((r) => `${r.name} ${r.n}`).join(', ')}`);
  check('...and marks each line up or down against what the bag holds',
    Object.entries(selRecipe.ingredients).every(([id, need], i) =>
      panel.ing[i].cls.includes((panel.inv[id] || 0) >= need ? 'up' : 'down')),
    panel.ing.map((r) => r.cls.replace('n ', '')).join(' '));

  // The odds bar is the one place the panel could quietly lie in pixels: the segments are
  // authored as percentage widths, so their *rendered* widths have to be the odds.
  const odds = cookOdds(selRecipe, panel.ar);
  check('the odds bar is drawn to the odds the shared table computes',
    panel.barW > 100 && panel.segs.length === 3
    && panel.segs.every((s) => Math.abs(s.w / panel.barW - odds[s.key]) < 0.02),
    panel.segs.map((s) => `${s.key} ${(s.w / panel.barW * 100).toFixed(1)}% vs ${(odds[s.key] * 100).toFixed(1)}%`).join(', '));
  check('...and the legend spells the same three numbers',
    panel.legend.join(' ') === ['perfect', 'normal', 'ruined']
      .map((k) => `${QUALITY[k].name} ${(odds[k] * 100).toFixed(0)}%`).join(' '),
    panel.legend.join(' '));
  check('the footer offers exactly the batch the ingredients afford',
    panel.foot.includes(`可制作 ${maxPortions(selId, panel.inv, 20)} 份`), panel.foot);

  /* ------------------------------------------------------ 2b. cook by hand ---- */

  console.log('\n--- 2b. cooking by clicking');
  // Two dishes, because the eating half needs one of each shape: 薄荷凉糕 (a buff, may be
  // eaten at full health) and 甜甜花酿鸡 (a heal, must not be). Both are rank 1 and both are
  // made from what the fixture gathered. `最多` rather than one portion: a single attempt
  // comes out 奇怪的料理 about 8% of the time, and a probe that fails one run in twelve for
  // an authored dice roll teaches nobody anything.
  async function cookMax(recipeId) {
    const before = await page.evaluate(() => ({ ...(window.game.player?.inventory || {}) }));
    const sel = await page.evaluate((id) => {
      const row = document.querySelector(`[data-recipe="${id}"]`);
      if (!row) return false;
      row.click();
      return true;
    }, recipeId);
    await sleep(500);
    await page.evaluate(() => [...document.querySelectorAll('.panel footer .btn')]
      .find((b) => b.textContent.trim() === '最多')?.click());
    await sleep(400);
    const go = await page.evaluate(() => {
      const btn = document.querySelector('.panel footer .btn.primary');
      if (!btn || btn.disabled) return { clicked: false, label: btn?.textContent.trim() || 'no button' };
      btn.click();
      return { clicked: true, label: btn.textContent.trim() };
    });
    let after = before;
    for (let i = 0; i < 40; i++) {
      after = await page.evaluate(() => ({ ...(window.game.player?.inventory || {}) }));
      if (JSON.stringify(after) !== JSON.stringify(before)) break;
      await sleep(250);
    }
    const toasts = await page.evaluate(() =>
      [...document.querySelectorAll('.toasts .toast')].map((el) => el.textContent.trim()));
    return { sel, before, after, go, toasts };
  }

  const jelly = await cookMax('mintJelly');
  await settle();
  await shot('02-cooked-jelly');
  const jellyQty = Number(/×(\d+)/.exec(jelly.go.label)?.[1] || 0);
  const jellyAfford = maxPortions('mintJelly', jelly.before, 20);
  check('a recipe row can be selected and 开始烹饪 offers the whole batch',
    jelly.sel && jelly.go.clicked && jellyQty === jellyAfford && jellyQty > 1,
    `${jelly.go.label}, afford ${jellyAfford}`);
  const madeJelly = (jelly.after.mintJelly || 0) - (jelly.before.mintJelly || 0);
  const madeRuined = (jelly.after.suspiciousFood || 0) - (jelly.before.suspiciousFood || 0);
  check('the click produced portions', madeJelly + madeRuined > 0,
    `薄荷凉糕 +${madeJelly}, 奇怪的料理 +${madeRuined} from ${jellyQty} attempts`);
  check('...and charged the ingredients for exactly that batch',
    Object.entries(RECIPES.mintJelly.ingredients).every(([id, need]) =>
      (jelly.after[id] || 0) === (jelly.before[id] || 0) - need * jellyQty),
    Object.keys(RECIPES.mintJelly.ingredients).map((id) => `${id} ${jelly.before[id] || 0}->${jelly.after[id] || 0}`).join(' '));
  check('...and a toast said what came out of the pot',
    jelly.toasts.some((t) => /完美|普通|失败/.test(t)), jelly.toasts.slice(-2).join(' | '));

  const stew = await cookMax('sweetMadame');
  await settle();
  await shot('03-cooked-stew');
  const HEAL_DISH = (stew.after.sweetMadame || 0) > 0 ? 'sweetMadame'
    : (stew.after.suspiciousFood || 0) > 0 ? 'suspiciousFood' : null;
  check('the bag now holds one dish of each shape: a heal and a buff',
    !!HEAL_DISH && (stew.after.mintJelly || 0) > 0,
    `heal dish ${HEAL_DISH} ×${stew.after[HEAL_DISH] || 0}, 薄荷凉糕 ×${stew.after.mintJelly || 0}`);
  if (!HEAL_DISH || !(stew.after.mintJelly > 0)) throw new Error('cooking produced nothing edible');

  /* ------------------------------------------- 2c. the bag refuses a no-op ---- */

  console.log('\n--- 2c. a dish that would do nothing is not spent');

  /** Open the bag on the 食物 tab and click a dish, the way a player does. */
  async function selectFood(itemId) {
    await page.evaluate(() => {
      document.querySelector('.panel .close')?.click();
      window.game.emit('togglePanel', { panel: 'inventory', open: true });
    });
    await sleep(500);
    await page.evaluate(() => document.querySelector('.panel [data-tab="consumable"]')?.click());
    await sleep(400);
    const clicked = await page.evaluate((id) => {
      const slot = document.querySelector(`.panel .slot[data-item="${id}"]`);
      if (!slot) return false;
      slot.click();
      return true;
    }, itemId);
    await sleep(400);
    await settle(200);
    return page.evaluate((ok) => {
      // The detail pane is the last block of the side column (see `Panels._bag`).
      const detail = document.querySelector('.panel .col.side')?.lastElementChild;
      const btn = [...(detail?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === '使用');
      return {
        clicked: ok,
        text: (detail?.textContent || '').replace(/\s+/g, ' ').trim(),
        hasButton: !!btn,
        disabled: !!btn?.disabled,
        hint: [...(detail?.querySelectorAll('p.down') || [])].map((el) => el.textContent).join(' '),
        hp: window.game.me?.hp, maxHp: window.game.me?.maxHp,
      };
    }, clicked);
  }

  /** Click 使用 in the open detail pane and wait for `done()` to come true. */
  function eatSelected(itemId, kind) {
    return page.evaluate(async (id, mode) => {
      const g = window.game;
      const hp0 = g.me.hp, inv0 = g.player.inventory[id] || 0;
      const detail = document.querySelector('.panel .col.side')?.lastElementChild;
      [...(detail?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === '使用')?.click();
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (mode === 'heal' ? g.me.hp > hp0 + 1 : g.buffs.some((b) => b.item === id)) break;
      }
      return {
        hp0, hp1: g.me.hp, max: g.me.maxHp,
        inv0, inv1: g.player.inventory[id] || 0,
        buffs: g.buffs.map((b) => ({ item: b.item, kind: b.kind, atkPct: b.atkPct, critRate: b.critRate, left: b.endsAt - performance.now() / 1000 })),
        hostBuffs: (g.socket.entity?.buffs || []).map((b) => ({ source: b.source, kind: b.kind, atkPct: b.atkPct, critRate: b.critRate })),
      };
    }, itemId, kind);
  }

  const full = await selectFood(HEAL_DISH);
  await shot('04-full-hp-refused');
  check('the 食物 tab holds the dish and it can be clicked', full.clicked && full.hasButton,
    full.text.slice(0, 60));
  check('at full health the 使用 button for a heal dish is disabled',
    full.disabled && full.hp >= full.maxHp - 1,
    `hp ${Math.round(full.hp)}/${Math.round(full.maxHp)}, disabled ${full.disabled}`);
  check('...and the panel says why, in words the player can read',
    full.hint.includes('生命值已满'), full.hint || `(no hint) ${full.text.slice(0, 60)}`);
  // The button being grey is only half of it: the host has to refuse the same eat, or a
  // player who reaches the action any other way still loses the dish. Ask it directly.
  const asked = await page.evaluate(async (id) => {
    const g = window.game;
    const seen = [];
    const off = g.on('toast', (d) => seen.push(d.text));
    const inv0 = g.player.inventory[id] || 0;
    try { await g.useConsumable(id); } catch (e) { seen.push(`threw ${e?.code || e}`); }
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 200)); if (seen.length) break; }
    off();
    return { inv0, inv1: g.player.inventory[id] || 0, seen };
  }, HEAL_DISH);
  check('the host refuses the same eat with the same reason',
    asked.seen.some((t) => String(t).includes('生命值已满')), asked.seen.join(' | ') || 'nothing said');
  check('...and the dish is still in the bag afterwards', asked.inv1 === asked.inv0,
    `${asked.inv0} -> ${asked.inv1}`);

  /* --------------------------------------------- 2d. wounded: the dish heals -- */

  console.log('\n--- 2d. wounded, the same dish heals and is spent');
  await page.evaluate(() => document.querySelector('.panel .close')?.click());
  await sleep(300);
  const hurt = await page.evaluate(() => {
    // Solo mode hosts the simulation in this tab, so this is the authoritative entity —
    // the same object the gateway would own online.
    const e = window.game.socket.entity;
    if (!e) return null;
    const max = e.maxHp();
    e.hp = Math.round(max * 0.35);
    e.hpByChar[e.charId] = e.hp;
    e.dirty = true;
    return { hp: e.hp, max };
  });
  check('the host entity can be wounded', !!hurt && hurt.hp < hurt.max * 0.4,
    hurt ? `${hurt.hp}/${hurt.max}` : 'no entity');
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => window.game.me.hp < window.game.me.maxHp * 0.5)) break;
    await sleep(250);
  }
  // The party card's HP fill is the pixel the player reads. Measure it now and again after
  // eating: an assertion on `me.hp` alone would pass with the bar frozen.
  // Read the card belonging to the character we actually wounded, not slot 0: the save
  // remembers `activeSlot`, so the fixture can boot with its third character out front and
  // slot 0's bar then sits at full width through the whole test — which looks exactly like
  // a HUD that never redraws.
  const fillRect = () => page.evaluate(async () => {
    const g = window.game;
    const st = g.hudState();
    const slot = Math.max(0, st.party.findIndex((p) => p.charId === g.socket.entity?.charId));
    const bar = document.querySelector(`.pcard[data-slot="${slot}"] .bar.hp`);
    const el = bar?.firstElementChild;
    // `.bar > i` has `transition: width 0.2s`, so the frame that *sets* 35% still measures
    // 100% wide: a rect read the instant after the HUD update returns the width the bar is
    // animating away from. Let the running transitions land first — that is the whole
    // difference between "the bar never moved" and "we looked too early".
    if (el?.getAnimations) {
      await Promise.race([
        Promise.allSettled(el.getAnimations().map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    }
    const r = el?.getBoundingClientRect();
    return {
      slot,
      w: r ? Math.round(r.width) : null,
      barW: bar ? Math.round(bar.getBoundingClientRect().width) : null,
      // What the HUD was told, alongside what it drew: a fill that never moves is either a
      // dead `css()` call or a party row that is not reading the snapshot, and the two look
      // identical from the outside.
      style: el?.style.width || '(none)',
      card: st.party?.[slot] ? `${Math.round(st.party[slot].hp)}/${st.party[slot].maxHp}` : 'no card',
      snap: JSON.stringify(g.socket.latest()?.hpByChar || null),
    };
  });
  const fillLow = await fillRect();
  await settle();
  await shot('05-wounded');

  const wounded = await selectFood(HEAL_DISH);
  check('now the 使用 button is live and the warning is gone',
    wounded.hasButton && !wounded.disabled && !wounded.hint,
    `hp ${Math.round(wounded.hp)}/${Math.round(wounded.maxHp)}, hint "${wounded.hint}"`);
  const ate = await eatSelected(HEAL_DISH, 'heal');
  await page.evaluate(() => document.querySelector('.panel .close')?.click());
  await sleep(400);
  const fillHigh = await fillRect();
  await settle();
  await shot('06-healed');
  const healDef = MATERIALS[HEAL_DISH].heal;
  const wantHeal = Math.min(ate.max - ate.hp0, healDef.flat + healDef.hpPct * ate.max);
  check('eating it restored the amount the dish promises',
    ate.hp1 - ate.hp0 > 0 && Math.abs((ate.hp1 - ate.hp0) - wantHeal) < Math.max(20, wantHeal * 0.1),
    `+${Math.round(ate.hp1 - ate.hp0)} hp, want ${Math.round(wantHeal)} (${healDef.flat} + ${(healDef.hpPct * 100).toFixed(0)}% of ${Math.round(ate.max)})`);
  check('...and this time the dish was spent', ate.inv1 === ate.inv0 - 1, `${ate.inv0} -> ${ate.inv1}`);
  // Pinned from both ends: wounded the fill must be visibly short of the track, healed it must
  // reach it. "It grew" alone would pass on a bar that crept one pixel.
  check('...and the party card\'s HP fill grew with it, in pixels',
    !!fillLow && !!fillHigh && fillHigh.w > fillLow.w + 2
    && fillLow.w < fillLow.barW * 0.55 && fillHigh.w > fillHigh.barW * 0.9,
    `slot ${fillLow?.slot}: ${fillLow?.w}px -> ${fillHigh?.w}px of ${fillHigh?.barW}px`
    + ` across ${Math.round(ate.hp0)}→${Math.round(ate.hp1)} hp`
    + ` (style ${fillLow?.style} -> ${fillHigh?.style}, card ${fillLow?.card} -> ${fillHigh?.card},`
    + ` snap ${fillLow?.snap} -> ${fillHigh?.snap})`);
  if (VERBOSE) {
    console.log('     fill low ', JSON.stringify(fillLow));
    console.log('     fill high', JSON.stringify(fillHigh));
  }

  /* ---------------------------------------------------- 2e. the buff chip ----- */

  console.log('\n--- 2e. the buff dish, and the chip that counts it down');
  const DISH = 'mintJelly';
  const dishBuff = MATERIALS[DISH].buff;
  const jellyPane = await selectFood(DISH);
  check('a buff dish is offered even at the health it was just topped up to',
    jellyPane.hasButton && !jellyPane.disabled && !jellyPane.hint,
    `hp ${Math.round(jellyPane.hp)}/${Math.round(jellyPane.maxHp)}, hint "${jellyPane.hint}"`);
  const buffed = await eatSelected(DISH, 'buff');
  const mine = buffed.buffs.find((b) => b.item === DISH);
  check('the dish was spent for the buff', buffed.inv1 === buffed.inv0 - 1,
    `${buffed.inv0} -> ${buffed.inv1}`);
  check('the buff the client tracks carries the dish\'s own numbers',
    !!mine && mine.atkPct === dishBuff.atkPct && mine.critRate === dishBuff.critRate
    && Math.abs(mine.left - dishBuff.duration) < 10,
    mine ? `atk +${(mine.atkPct * 100).toFixed(0)}%, crit +${(mine.critRate * 100).toFixed(0)}%, ${mine.left.toFixed(0)}s of ${dishBuff.duration}s` : 'no buff');
  check('...and the host hung the same buff on the live entity',
    buffed.hostBuffs.some((b) => b.kind === 'food' && b.source === DISH
      && b.atkPct === dishBuff.atkPct && b.critRate === dishBuff.critRate),
    JSON.stringify(buffed.hostBuffs));

  await page.evaluate(() => document.querySelector('.panel .close')?.click());
  await sleep(400);
  await settle();
  const readChip = () => page.evaluate((name) => {
    const chips = [...document.querySelectorAll('.buffs .buff')];
    const el = chips.find((c) => (c.querySelector('b')?.textContent || '').includes(name));
    if (!el) return { n: chips.length, found: false, all: chips.map((c) => c.querySelector('b')?.textContent) };
    const r = el.getBoundingClientRect();
    return {
      n: chips.length, found: true,
      name: el.querySelector('b')?.textContent || '',
      left: el.querySelector('small')?.textContent || '',
      icon: el.querySelector('.ico')?.textContent || '',
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }, MATERIALS[DISH].name);
  const chip1 = await readChip();
  const framePresent = await hudShot('07-buff-chip');
  check('the HUD grew a chip for the meal', chip1.found,
    chip1.found ? `${chip1.n} chip(s): ${chip1.icon} ${chip1.name} ${chip1.left}` : JSON.stringify(chip1.all));
  check('...iconed by the dish itself and big enough to read',
    chip1.found && chip1.icon === MATERIALS[DISH].icon && chip1.rect.w > 40 && chip1.rect.h > 14,
    `${chip1.icon} ${chip1.rect?.w}×${chip1.rect?.h}px`);
  check('...and it reads as a five-minute countdown, not a stopwatch',
    /^\d:\d\d$/.test(chip1.left || ''), `"${chip1.left}" for a ${dishBuff.duration}s buff`);
  await sleep(3000);
  await settle(200);
  const chip2 = await readChip();
  const secs = (t) => { const m = /^(\d):(\d\d)$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : NaN; };
  check('...and the countdown actually counts down', secs(chip2.left) < secs(chip1.left),
    `${chip1.left} -> ${chip2.left}`);

  // Expiry through the mechanism that really expires it: `activeBuffs()` drops anything past
  // `endsAt`, `ZoneInstance.updatePlayer` drops anything past `until`. Moving both clocks is
  // the whole test. The screenshot pair is then measured on the chip's own rect, against a
  // static control rect that must *not* move — a HUD that simply stopped redrawing would
  // otherwise read exactly like a chip that vanished.
  const control = await page.evaluate(() => {
    const r = document.querySelector('.zone-name')?.getBoundingClientRect();
    return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
  });
  const gone = await page.evaluate(async (name) => {
    const g = window.game;
    for (const b of g.buffs) b.endsAt = performance.now() / 1000 - 1;
    for (const b of (g.socket.entity?.buffs || [])) b.until = (g.socket.inst?.now || 0) - 1;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const still = [...document.querySelectorAll('.buffs .buff')]
        .some((c) => (c.querySelector('b')?.textContent || '').includes(name));
      if (!still) break;
    }
    return {
      chips: document.querySelectorAll('.buffs .buff').length,
      clientBuffs: g.buffs.length, hostBuffs: (g.socket.entity?.buffs || []).length,
    };
  }, MATERIALS[DISH].name);
  await settle();
  const frameGone = await hudShot('08-buff-expired');
  check('when the buff ends the chip goes with it',
    gone.chips === 0 && gone.clientBuffs === 0,
    `chips ${gone.chips}, client buffs ${gone.clientBuffs}`);
  check('...and the host let go of it too', gone.hostBuffs === 0, `${gone.hostBuffs} on the entity`);
  if (chip1.found && control) {
    const chipDiff = rectDiff(framePresent, frameGone, chip1.rect);
    const ctrlDiff = rectDiff(framePresent, frameGone, control);
    check('the chip was really on screen: its rect changed, a static HUD rect did not',
      chipDiff > 0.15 && ctrlDiff < 0.05,
      `chip rect ${(chipDiff * 100).toFixed(1)}% of pixels changed, 区域名 control ${(ctrlDiff * 100).toFixed(1)}%`);
    if (VERBOSE) {
      console.log('     chip present', JSON.stringify(rectStats(framePresent, { ...chip1.rect, label: 'chip' })));
      console.log('     chip gone   ', JSON.stringify(rectStats(frameGone, { ...chip1.rect, label: 'chip' })));
    }
  } else {
    check('the chip was really on screen (needs a chip and a control rect)', false,
      `chip ${chip1.found}, control ${!!control}`);
  }

  check('no page errors through any of it', !errors.length, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(`\nfood-check: ${pass} passed, ${fail} failed  (frames in ${outDir})`);
process.exit(fail);
