// 祈愿 (gacha) audit: the pity curve, the rate-up guarantees, the money, and the panel.
//
//   node tools/wish-check.mjs                     # sections 0-2, no browser needed
//   DISPLAY=:99 node tools/wish-check.mjs         # + the panel, in a real page
//   node tools/wish-check.mjs --pulls 400000      # longer statistical run
//   node tools/wish-check.mjs --verbose
//
// Exit code is the number of failed assertions.
//
// Why this exists: `api-check.mjs` proves a ten-pull costs ten tickets and returns ten
// results, which is a *transport* claim. Everything that makes a gacha a gacha — soft pity,
// hard pity, the 50/50 and its guarantee, the 4★ rate-up — is a claim about a distribution,
// and a distribution cannot be checked by one call. Nor can it be checked against
// hand-written constants: "16 in 1000" is a number somebody typed. So every expected value
// here is *derived from the same table the simulation rolls with* —
// `wishRate5` gives the per-pull curve, and the analytic mean of that curve gives the
// long-run rate the sample has to match. Change the curve and the expectation follows.
//
// The three sections, in order of what they can catch:
//   0. vocabulary — every key in `WISH_POOL` has a named consumer, and every field the
//      route publishes is read by the panel. Both directions, plus a self-test.
//   1. distribution — ~200k simulated pulls per pool against analytic expectations.
//   2. money and state — a fresh guest pulls over REST: tickets, primogem conversion,
//      pity continuity, history rows, the refusal when it can no longer afford it.
//   3. the panel — the printed numbers are the published numbers (needs DISPLAY).

import { readFileSync } from 'node:fs';
import { WISH_POOL, WEAPONS, MATERIALS } from '../shared/src/data/items.js';
import { CHARACTERS, MAX_CONSTELLATION } from '../shared/src/data/characters.js';
import {
  pullWish, wishRate5, SOFT_PITY, WISH_CONVERSION, wishConversion, sumConversion,
} from '../shared/src/sim/loot.js';
import { GEM_PER_WISH, DUST_PER_WISH, SHOPS } from '../shared/src/data/shop.js';

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const NO_BROWSER = argv.includes('--no-browser') || !process.env.DISPLAY;
const PULLS = (() => {
  const i = argv.indexOf('--pulls');
  return i >= 0 ? Math.max(20000, Number(argv[i + 1]) || 0) : 200000;
})();
const ORIGIN = process.env.GAME_API || 'http://127.0.0.1:8787';
const APP = process.env.GAME_APP || 'http://127.0.0.1:5173';

let pass = 0, fail = 0, skip = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); } else {
    fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
  return !!ok;
}
const note = (name, why) => { skip++; console.log(`  SKIP ${name} — ${why}`); };
const pctStr = (v) => `${(v * 100).toFixed(3)}%`;

/* ================================================================ 0. keys ==== */

console.log('\n--- 0. the pool table\'s keys, and the payload the panel reads');

const MODULES = {
  sim: 'shared/src/sim/loot.js',
  route: 'server/src/routes/gacha.js',
  panel: 'client/src/ui/panels.js',
  // Not a reader of any pool key, but the module that decides whether a duplicate raised
  // anything — which is the input to the whole conversion table in section 0b.
  repo: 'server/src/db/repo.js',
};
const code = {};
for (const [k, rel] of Object.entries(MODULES)) {
  // Comments are stripped: a key that survives only inside the paragraph explaining why it
  // was removed is exactly the rot this gate is for.
  code[k] = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Who must read each key of a `WISH_POOL` entry.
 *
 * Keys are leaf names, because a regex cannot tell `fiveStar.featuredChance` from
 * `fourStar.featuredChance` — the tier-specific pairs are pinned separately below.
 */
const KEY_READERS = {
  id: ['route'],
  name: ['route'],
  cost: ['route', 'panel'],
  featuredFive: ['sim', 'route'],
  featuredFour: ['sim', 'route'],
  fiveStar: ['sim', 'route'],
  fourStar: ['sim', 'route'],
  threeStar: ['sim'],
  rate: ['sim'],
  pity: ['sim'],
  featuredChance: ['sim', 'route'],
  chars: ['sim'],
  weapons: ['sim'],
};

/**
 * Every key name that appears inside a pool entry, at any depth.
 *
 * The walk starts at the pool *entries*, not at `WISH_POOL` itself, because the top level's
 * keys are pool ids (`standard`, `featured`) — names, not schema. `cost` is a leaf for the
 * same reason: its keys are currency ids, checked against `MATERIALS` below instead.
 */
const usedKeys = new Set();
const walkKeys = (o) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return;
  for (const [k, v] of Object.entries(o)) { usedKeys.add(k); if (k !== 'cost') walkKeys(v); }
};
for (const p of Object.values(WISH_POOL)) walkKeys(p);

const badCost = Object.values(WISH_POOL).flatMap((p) => Object.keys(p.cost || {}))
  .filter((c) => MATERIALS[c]?.kind !== 'currency');
check('every banner prices itself in a real currency', !badCost.length,
  badCost.length ? badCost.join(', ') : [...new Set(Object.values(WISH_POOL)
    .flatMap((p) => Object.entries(p.cost).map(([k, v]) => `${v} ${MATERIALS[k].name}`)))].join(' / '));

function keyProblem(key, readers) {
  if (!readers?.length) return `${key} has no declared reader`;
  for (const m of readers) {
    if (!MODULES[m]) return `${key} names unknown module ${m}`;
    if (!new RegExp(`\\b${key}\\b`).test(code[m])) return `${key} unread in ${m}`;
  }
  return null;
}

const undeclared = [...usedKeys].filter((k) => !KEY_READERS[k]);
check('every key in WISH_POOL is declared with a consumer', !undeclared.length,
  undeclared.length ? undeclared.join(', ') : `${usedKeys.size} keys`);
const stale = Object.keys(KEY_READERS).filter((k) => !usedKeys.has(k));
check('...and no declaration outlives its key', !stale.length,
  stale.length ? stale.join(', ') : `${Object.keys(KEY_READERS).length} declarations`);
const unread = Object.entries(KEY_READERS).map(([k, r]) => keyProblem(k, r)).filter(Boolean);
check('...and every declared key is read where it says it is', !unread.length,
  unread.length ? unread.join('; ') : 'all readers found');

// The scanner has to be able to fail, in both of its ways.
check('the key scan can fail (fabricated key / wrong module)',
  !!keyProblem('notAPoolKey', ['sim']) && !!keyProblem('rate', ['nope']) && !!keyProblem('x', []),
  `${keyProblem('notAPoolKey', ['sim'])} | ${keyProblem('rate', ['nope'])}`);

// The tier-specific pairs the leaf scan cannot separate.
check('the 5★ rate-up chance is authored and read as the 5★ one',
  WISH_POOL.featured.fiveStar.featuredChance > 0
  && /fiveStar\.featuredChance|pool\.fiveStar\.featuredChance/.test(code.route)
  && /featuredChance/.test(code.sim),
  `featured 5★ ${WISH_POOL.featured.fiveStar.featuredChance}`);
check('the 4★ rate-up chance is authored and read as the 4★ one',
  WISH_POOL.featured.fourStar.featuredChance > 0
  && /four\.featuredChance|fourStar\.featuredChance/.test(code.sim)
  && /fourStar\.featuredChance/.test(code.route),
  `featured 4★ ${WISH_POOL.featured.fourStar.featuredChance}`);
check('the soft-pity curve is one exported function, not two copies',
  /export function wishRate5/.test(code.sim) && /wishRate5\(/.test(code.panel)
  && !/0\.06/.test(code.panel),
  'panel imports wishRate5 and hardcodes no step');
check('the primogem conversion rate is imported, not printed as a literal',
  /GEM_PER_WISH/.test(code.route) && /GEM_PER_WISH|gemPerWish/.test(code.panel)
  && !new RegExp(`（不足时按 ${GEM_PER_WISH}`).test(code.panel),
  `GEM_PER_WISH ${GEM_PER_WISH}`);
check('the ticket price comes from the pool, not from the route',
  /cost\?\.wishTicket|cost\.wishTicket/.test(code.route),
  'route reads pool.cost.wishTicket');

// The other direction: the payload `/api/wish/pools` publishes must be *consumed*. A
// published field nobody reads is either dead weight or, worse, a number the panel is
// inventing for itself while the server offers the real one.
const PAYLOAD_FIELDS = ['id', 'name', 'cost', 'featuredFive', 'featuredFour',
  'rate5', 'pity5', 'rate4', 'pity4', 'featuredChance5', 'featuredChance4',
  'softPity', 'gemPerWish'];
const publishBlock = (code.route.match(/pools:[\s\S]*?\}\)\),/) || [''])[0];
const notPublished = PAYLOAD_FIELDS.filter((f) => !new RegExp(`\\b${f}\\b`).test(publishBlock));
const notPrinted = PAYLOAD_FIELDS.filter((f) => !new RegExp(`\\b${f}\\b`).test(code.panel));
check('every field this list claims is really published', !notPublished.length,
  notPublished.length ? notPublished.join(', ') : `${PAYLOAD_FIELDS.length} fields`);
check('...and every published field is read by the panel', !notPrinted.length,
  notPrinted.length ? `unread: ${notPrinted.join(', ')}` : 'all consumed');

// Rosters have to name things that exist, at the rarity of the tier they sit in.
const rosterProblems = [];
for (const pool of Object.values(WISH_POOL)) {
  const tiers = [[5, pool.fiveStar], [4, pool.fourStar], [3, pool.threeStar]];
  for (const [rarity, tier] of tiers) {
    for (const c of tier?.chars || []) {
      if (!CHARACTERS[c]) rosterProblems.push(`${pool.id} ${rarity}★ char ${c} does not exist`);
      else if (CHARACTERS[c].rarity !== rarity) rosterProblems.push(`${pool.id}: ${c} is ${CHARACTERS[c].rarity}★ in a ${rarity}★ list`);
    }
    for (const w of tier?.weapons || []) {
      if (!WEAPONS[w]) rosterProblems.push(`${pool.id} ${rarity}★ weapon ${w} does not exist`);
      else if (WEAPONS[w].rarity !== rarity) rosterProblems.push(`${pool.id}: ${w} is ${WEAPONS[w].rarity}★ in a ${rarity}★ list`);
    }
  }
  if (pool.featuredFive && !pool.fiveStar.chars.includes(pool.featuredFive)) {
    rosterProblems.push(`${pool.id}: featuredFive ${pool.featuredFive} is not in the 5★ list`);
  }
  for (const c of pool.featuredFour || []) {
    if (!pool.fourStar.chars.includes(c)) rosterProblems.push(`${pool.id}: featuredFour ${c} is not in the 4★ list`);
  }
}
check('every roster entry exists and matches its tier\'s rarity', !rosterProblems.length,
  rosterProblems.length ? rosterProblems.join('; ') : 'standard + featured rosters clean');

// A featured pool whose 4★ list is *only* the featured names has nothing to hand out when
// the rate-up roll is lost, which makes `featuredChance4` unobservable — the exact state
// this pool was in before the rate-up was implemented.
for (const pool of Object.values(WISH_POOL)) {
  if (!pool.featuredFour?.length) continue;
  const others = pool.fourStar.chars.filter((c) => !pool.featuredFour.includes(c));
  check(`${pool.id}: losing the 4★ rate-up has somewhere to land`,
    others.length > 0 || pool.fourStar.weapons.length > 0,
    `${others.length} off-featured chars, ${pool.fourStar.weapons.length} weapons`);
}

/* ============================== 0b. the change a duplicate turns into ======== */

console.log('\n--- 0b. 星辉/星尘: what a duplicate is worth, and where it can be spent');

/**
 * Every currency `WISH_CONVERSION` can pay out, read off the table rather than listed here.
 *
 * The table is two levels deep in one place: rarities map straight to an item map, and
 * `maxed` maps rarities to one. An entry is a leaf when all of its values are numbers.
 */
const CHANGE_CURRENCIES = [...new Set(
  Object.values(WISH_CONVERSION)
    .flatMap((v) => (Object.values(v).every((x) => typeof x === 'number') ? [v] : Object.values(v)))
    .flatMap((m) => Object.keys(m)),
)];

const notAnItem = CHANGE_CURRENCIES.filter((id) => !MATERIALS[id]);
check('every currency the conversion pays out is a real item', !notAnItem.length,
  notAnItem.length ? notAnItem.join(', ')
    : CHANGE_CURRENCIES.map((id) => `${MATERIALS[id].icon}${MATERIALS[id].name}`).join(' / '));
// `kind` is not cosmetic here: 背包 renders only `material` and `consumable`, so change filed
// as anything else is paid into a bag that will never show it.
const wrongKind = CHANGE_CURRENCIES.filter((id) => MATERIALS[id].kind !== 'material');
check('...and is filed as a material, which is the kind the bag renders', !wrongKind.length,
  wrongKind.length ? wrongKind.map((id) => `${id}:${MATERIALS[id].kind}`).join(', ') : 'material');
check('every rarity converts, and the maxed table covers both dupe-able tiers',
  [3, 4, 5].every((r) => WISH_CONVERSION[r]) && !!WISH_CONVERSION.maxed?.[4] && !!WISH_CONVERSION.maxed?.[5],
  `3★/4★/5★ + maxed 4★/5★`);

// The exchange rate is *read out of the shop*, not written here. The entries that sell one
// 纠缠之缘 for change are what make every number below mean anything, and they are the same
// entries the player clicks — so if the shop and the payout ever disagree, this is where it
// shows, rather than in a constant this file happens to repeat.
const wishPrice = {};
for (const e of SHOPS.bargains.entries) {
  const cost = Object.entries(e.cost || {});
  if (e.item !== 'wishTicket' || cost.length !== 1) continue;
  const [cur, qty] = cost[0];
  if (CHANGE_CURRENCIES.includes(cur)) wishPrice[cur] = qty / e.count;
}
const noSink = CHANGE_CURRENCIES.filter((id) => !(id in wishPrice));
check('every change currency buys 纠缠之缘 back in the shop', !noSink.length,
  noSink.length ? noSink.join(', ')
    : Object.entries(wishPrice).map(([k, v]) => `${v} ${MATERIALS[k].name}/抽`).join(', '));

const sinks = {};
for (const shop of Object.values(SHOPS)) {
  for (const e of shop.entries) {
    for (const cur of Object.keys(e.cost || {})) {
      if (CHANGE_CURRENCIES.includes(cur)) (sinks[cur] ||= []).push(e);
    }
  }
}
// Two rules that only make sense together: the wish exchange is capped (change is a rebate,
// not a wish printer), and *because* it is capped every currency needs a second sink — one
// that still takes 星尘 in the last week of the month.
const uncapped = Object.values(sinks).flat().filter((e) => e.item === 'wishTicket' && !(e.limit > 0));
check('the wish exchange is capped, so change is a rebate and not a wish printer', !uncapped.length,
  uncapped.length ? uncapped.map((e) => e.id).join(', ')
    : Object.values(sinks).flat().filter((e) => e.item === 'wishTicket')
      .map((e) => `${e.id} ${e.limit}/${e.period}`).join(', '));
const wishOnly = CHANGE_CURRENCIES.filter((cur) => !(sinks[cur] || []).some((e) => e.item !== 'wishTicket'));
check('...so every currency also has a sink that is not a wish', !wishOnly.length,
  wishOnly.length ? wishOnly.join(', ')
    : CHANGE_CURRENCIES.map((c) => `${MATERIALS[c].name}: ${(sinks[c] || []).length} sinks`).join(', '));

/** A payout in pulls, using the shop's own price — the only unit the two currencies share. */
const inWishes = (m) => Object.entries(m).reduce((s, [id, qty]) => s + qty / wishPrice[id], 0);
const val = { 3: inWishes(WISH_CONVERSION[3]), 4: inWishes(WISH_CONVERSION[4]), 5: inWishes(WISH_CONVERSION[5]) };
const maxedVal = { 4: inWishes(WISH_CONVERSION.maxed[4]), 5: inWishes(WISH_CONVERSION.maxed[5]) };
check('a rarer pull is worth more change', val[3] < val[4] && val[4] < val[5],
  `3★ ${val[3].toFixed(2)} < 4★ ${val[4].toFixed(2)} < 5★ ${val[5].toFixed(2)} 抽`);
// The paired rule, in the direction that makes it derivable rather than invented: a
// duplicate that raised nothing hands the pull back. One pull for a maxed 4★, five for a
// maxed 5★ — which is the whole reason the payout is denominated in the shop's price.
check('a maxed 4★ dupe refunds exactly the pull it cost', maxedVal[4] === 1,
  `${JSON.stringify(WISH_CONVERSION.maxed[4])} = ${maxedVal[4]} 抽`);
check('...and a maxed 5★ dupe refunds five', maxedVal[5] === 5,
  `${JSON.stringify(WISH_CONVERSION.maxed[5])} = ${maxedVal[5]} 抽`);
check('...and a maxed dupe always beats the same pull unmaxed',
  maxedVal[4] > val[4] && maxedVal[5] > val[5],
  `4★ ${val[4].toFixed(2)}→${maxedVal[4]}, 5★ ${val[5].toFixed(2)}→${maxedVal[5]}`);

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('a capped character dupe converts on the maxed table',
  eq(wishConversion({ rarity: 5, type: 'character' }, { dupe: true, capped: true }), WISH_CONVERSION.maxed[5]),
  JSON.stringify(wishConversion({ rarity: 5, type: 'character' }, { dupe: true, capped: true })));
check('...and an uncapped one does not', // the control: same call, one flag flipped
  eq(wishConversion({ rarity: 5, type: 'character' }, { dupe: true, capped: false }), WISH_CONVERSION[5]),
  JSON.stringify(wishConversion({ rarity: 5, type: 'character' }, { dupe: true, capped: false })));
check('a weapon never converts on the maxed table — weapons have no constellation',
  eq(wishConversion({ rarity: 5, type: 'weapon' }, { capped: true }), WISH_CONVERSION[5]),
  JSON.stringify(wishConversion({ rarity: 5, type: 'weapon' }, { capped: true })));
check('a result with no rarity falls back to the 3★ payout rather than to nothing',
  eq(wishConversion({}, {}), WISH_CONVERSION[3]) && eq(wishConversion(null), WISH_CONVERSION[3]),
  JSON.stringify(wishConversion(null)));
const scratch = wishConversion({ rarity: 3 });
scratch.stardust = 999;
check('...and the map it returns is a copy, so a caller cannot edit the table',
  WISH_CONVERSION[3].stardust !== 999, `table still ${JSON.stringify(WISH_CONVERSION[3])}`);
check('sumConversion adds every map and drops nothing',
  eq(sumConversion([{ starglitter: 2 }, { stardust: 15 }, { starglitter: 10 }]), { starglitter: 12, stardust: 15 })
  && eq(sumConversion([]), {}) && eq(sumConversion([undefined, { stardust: 1 }]), { stardust: 1 }),
  JSON.stringify(sumConversion([{ starglitter: 2 }, { stardust: 15 }, { starglitter: 10 }])));

check('the route converts every result and writes the change to the bag',
  /wishConversion\(/.test(code.route) && /sumConversion\(/.test(code.route)
  && /addItems\(/.test(code.route) && /converted/.test(code.route),
  'wishConversion + sumConversion + addItems');
check('...and `capped` is decided where the constellation cap lives, not in the route',
  /MAX_CONSTELLATION/.test(code.repo) && /capped/.test(code.repo)
  && !/>=\s*6|===\s*6/.test(code.route),
  `MAX_CONSTELLATION ${MAX_CONSTELLATION}, read in repo.js`);
check('...and the panel prints the change from the same table', /WISH_CONVERSION/.test(code.panel),
  'panels.js imports WISH_CONVERSION');

/* ======================================================= 1. distribution ==== */

console.log(`\n--- 1. ${PULLS.toLocaleString('en-US')} pulls per pool, against the analytic curve`);

/** Reproducible seed stream (xorshift32) — a flaky statistical probe is worse than none. */
let seedState = 0x2f6e2b1 >>> 0;
const nextSeed = () => {
  seedState ^= seedState << 13; seedState >>>= 0;
  seedState ^= seedState >>> 17;
  seedState ^= seedState << 5; seedState >>>= 0;
  return seedState % (2 ** 31 - 1);
};

/**
 * P(the 5★ arrives on pull n) for n = 1..pity, straight off `wishRate5`.
 * `rateFn` is a seam for the mutation self-test below; production callers pass nothing.
 */
function dist5(fiveStar, rateFn = wishRate5) {
  const p = [];
  let survive = 1;
  for (let n = 1; n <= fiveStar.pity; n++) {
    const r = Math.min(1, Math.max(0, rateFn(fiveStar, n)));
    p.push(survive * r);
    survive *= 1 - r;
  }
  return p;
}
/** Same for a flat-rate tier with a hard pity (the 4★ counter). */
function distFlat(rate, pity) {
  const p = [];
  let survive = 1;
  for (let n = 1; n <= pity; n++) {
    const r = n >= pity ? 1 : rate;
    p.push(survive * r);
    survive *= 1 - r;
  }
  return p;
}
const meanOf = (p) => p.reduce((a, v, i) => a + v * (i + 1), 0);
/** Sample error bound for a proportion: 4σ, so a green run is not luck. */
const band = (p, n) => 4 * Math.sqrt(Math.max(p * (1 - p), 1e-9) / n);

function simulate(poolId, n) {
  const pool = WISH_POOL[poolId];
  let s = { pity5: 0, pity4: 0, guaranteed5: false, guaranteed4: false, total: 0 };
  const out = {
    byRarity: { 3: 0, 4: 0, 5: 0 },
    gaps5: [], gaps4: [],
    hitsAt5: new Map(), trialsAt5: new Map(),
    ids: { 5: new Map(), 4: new Map(), 3: new Map() },
    types5: new Map(),
    feat5: { win: 0, lose: 0, violation: 0, afterLoss: 0, afterLossFeatured: 0 },
    feat4: { win: 0, lose: 0, violation: 0, offChars: 0, offWeapons: 0 },
    guaranteed5Ever: false,
    since5: 0, since4: 0,
    maxCount5: 0, maxCount4: 0, maxRun3: 0,
  };
  let pendingLoss5 = false, pendingLoss4 = false, run3 = 0;
  for (let i = 0; i < n; i++) {
    const before = s.pity5 + 1;
    out.maxCount5 = Math.max(out.maxCount5, before);
    out.maxCount4 = Math.max(out.maxCount4, s.pity4 + 1);
    out.trialsAt5.set(before, (out.trialsAt5.get(before) || 0) + 1);
    const r = pullWish(poolId, s, nextSeed());
    s = r.state;
    const res = r.result;
    out.since5++; out.since4++;
    out.byRarity[res.rarity]++;
    const bag = out.ids[res.rarity];
    bag.set(res.id, (bag.get(res.id) || 0) + 1);
    if (s.guaranteed5) out.guaranteed5Ever = true;

    if (res.rarity === 5) {
      out.hitsAt5.set(before, (out.hitsAt5.get(before) || 0) + 1);
      out.gaps5.push(out.since5); out.since5 = 0;
      out.types5.set(res.type, (out.types5.get(res.type) || 0) + 1);
      if (pool.featuredFive) {
        const isFeat = res.id === pool.featuredFive;
        if (pendingLoss5) {
          out.feat5.afterLoss++;
          if (isFeat) out.feat5.afterLossFeatured++;
          else out.feat5.violation++;
        }
        if (isFeat) { out.feat5.win++; pendingLoss5 = false; } else { out.feat5.lose++; pendingLoss5 = true; }
      }
    } else if (res.rarity === 4) {
      out.gaps4.push(out.since4); out.since4 = 0;
      if (pool.featuredFour?.length) {
        const isFeat = res.type === 'character' && pool.featuredFour.includes(res.id);
        if (pendingLoss4 && !isFeat) out.feat4.violation++;
        if (isFeat) { out.feat4.win++; pendingLoss4 = false; } else {
          out.feat4.lose++; pendingLoss4 = true;
          if (res.type === 'character') out.feat4.offChars++; else out.feat4.offWeapons++;
        }
      }
    }
    if (res.rarity === 3) { run3++; out.maxRun3 = Math.max(out.maxRun3, run3); } else run3 = 0;
  }
  out.total = s.total;
  return { pool, s, out };
}

for (const poolId of Object.keys(WISH_POOL)) {
  const { pool, out } = simulate(poolId, PULLS);
  const p5 = dist5(pool.fiveStar);
  const p4 = distFlat(pool.fourStar.rate, pool.fourStar.pity);
  const want5 = 1 / meanOf(p5);
  const want4 = 1 / meanOf(p4);
  const emp5 = out.byRarity[5] / PULLS;
  const emp4 = out.byRarity[4] / PULLS;
  console.log(`\n  [${poolId}] ${pool.name}`);

  check(`${poolId}: the pull counter counted every pull`, out.total === PULLS,
    `${out.total} of ${PULLS}`);
  check(`${poolId}: 5★ rate matches the curve's own mean`,
    Math.abs(emp5 - want5) < band(want5, PULLS),
    `${pctStr(emp5)} vs ${pctStr(want5)} (±${pctStr(band(want5, PULLS))}, 一发平均 ${meanOf(p5).toFixed(1)} 抽)`);
  // A 5★ pre-empts the 4★ on the same pull, so the observed 4★ rate sits just under the
  // analytic one; a rate *above* it would mean both tiers landed at once.
  check(`${poolId}: 4★ rate sits just under its own curve (5★ pre-empts it)`,
    emp4 <= want4 + band(want4, PULLS) && emp4 > want4 * 0.9,
    `${pctStr(emp4)} vs ${pctStr(want4)}`);
  check(`${poolId}: nothing is rarer than 3★ and the tiers add up`,
    out.byRarity[3] + out.byRarity[4] + out.byRarity[5] === PULLS,
    `3★ ${out.byRarity[3]} / 4★ ${out.byRarity[4]} / 5★ ${out.byRarity[5]}`);

  const maxGap5 = Math.max(...out.gaps5);
  const maxGap4 = Math.max(...out.gaps4);
  check(`${poolId}: neither pity counter ever passes its ceiling`,
    out.maxCount5 <= pool.fiveStar.pity && out.maxCount4 <= pool.fourStar.pity,
    `counters peaked at ${out.maxCount5}/${pool.fiveStar.pity} and ${out.maxCount4}/${pool.fourStar.pity}`);
  check(`${poolId}: and no drought outlives its ceiling`,
    maxGap5 <= pool.fiveStar.pity, `longest 5★ drought ${maxGap5} (${out.gaps5.length} 五星)`);
  // The gap between two 4★s *can* exceed 10: a 5★ pre-empts the 4★ on its pull and only
  // pushes `pity4` back by one, so the player's 4★ arrives on the pull after. The invariant
  // that actually holds — and the one a player feels — is that ten pulls never all come
  // back 3★. Asserting it on `gaps4` instead reported a false defect at 200k pulls.
  check(`${poolId}: ten pulls are never all 3★`,
    out.maxRun3 < pool.fourStar.pity,
    `longest 3★-only run ${out.maxRun3}, 4★ ceiling ${pool.fourStar.pity} (longest 4★-to-4★ gap ${maxGap4}, 5★ interposed)`);

  // Soft pity. Checking each pull index separately needs ~3000 samples *at that index* and
  // only ~2000 cycles even reach 74 in 200k pulls, so the shape is tested as a histogram of
  // "which pity did the 5★ land on", binned so every bin holds at least ~100 expected
  //五星 — bins accumulated from the analytic curve itself, not written down.
  const n5 = out.gaps5.length;
  const binsFor = (masses) => {
    const bins = [];
    let lo = 1, mass = 0;
    const floor = Math.max(100, n5 * 0.01) / n5;
    for (let n = 1; n <= masses.length; n++) {
      mass += masses[n - 1];
      const last = n === masses.length;
      if (mass >= floor || last) {
        if (last && mass < floor && bins.length) {
          bins[bins.length - 1].hi = n; bins[bins.length - 1].mass += mass;
        } else bins.push({ lo, hi: n, mass });
        lo = n + 1; mass = 0;
      }
    }
    return bins;
  };
  const binProblems = (bins) => {
    const bad = [];
    for (const b of bins) {
      let hits = 0;
      for (let n = b.lo; n <= b.hi; n++) hits += out.hitsAt5.get(n) || 0;
      const share = hits / n5;
      if (Math.abs(share - b.mass) > band(b.mass, n5)) bad.push(`${b.lo}-${b.hi}: ${pctStr(share)} vs ${pctStr(b.mass)}`);
    }
    return bad;
  };
  const bins = binsFor(p5);
  if (bins.length < 6) {
    // Every bin has to hold ~100 expected 五星, so a short run collapses the ramp into two or
    // three buckets that no longer distinguish one curve from another. Say so instead of
    // reporting a defect — this is the probe's sample being small, not the game being wrong.
    note(`${poolId}: the 五星 pity histogram`,
      `only ${n5} 五星 in ${PULLS} pulls — ${bins.length} usable bins; run with --pulls 200000`);
  } else {
    const bad = binProblems(bins);
    check(`${poolId}: 五星 land where the published curve says they land`, !bad.length,
      bad.length ? bad.slice(0, 4).join('; ')
        : `${bins.length} bins over ${n5} 五星, soft pity from ${SOFT_PITY.start}: `
          + bins.slice(-4).map((b) => `${b.lo}-${b.hi} ${pctStr(b.mass)}`).join(', '));
    // ...and the histogram must be able to reject a curve. Same sample, same bins, against a
    // ramp that starts three pulls later — if that also passes, the test measures nothing.
    const mutant = binProblems(binsFor(dist5(pool.fiveStar, (fs, n) => wishRate5(fs, n - 3))));
    check(`${poolId}: ...and it rejects a ramp shifted by three pulls`, mutant.length > 0,
      mutant.length ? `${mutant.length} bins rejected, e.g. ${mutant[0]}` : 'the mutant curve fit just as well');
  }

  // Coverage: an id in the table that never drops is unreachable content.
  const missing = [];
  for (const [rarity, tier] of [[5, pool.fiveStar], [4, pool.fourStar], [3, pool.threeStar]]) {
    for (const id of [...(tier.chars || []), ...(tier.weapons || [])]) {
      if (!out.ids[rarity].get(id)) missing.push(`${rarity}★ ${id}`);
    }
  }
  check(`${poolId}: every roster entry actually drops`, !missing.length,
    missing.length ? missing.join(', ') : `${out.ids[5].size}+${out.ids[4].size}+${out.ids[3].size} distinct ids`);
  check(`${poolId}: 3★ are only weapons`,
    [...out.ids[3].keys()].every((id) => !!WEAPONS[id]),
    [...out.ids[3].keys()].join(','));

  if (pool.featuredFive) {
    const c = pool.fiveStar.featuredChance;
    // Long-run share of 5★s that are the featured character, given a guarantee on a loss:
    // per cycle, a win is 1 五星 and a loss is 2, so share = 1/(2−c). c = 0.5 gives the
    // familiar 2/3.
    const wantShare = 1 / (2 - c);
    const share = out.feat5.win / (out.feat5.win + out.feat5.lose);
    check(`${poolId}: the 50/50 plus 大保底 lands on 1/(2−${c}) featured`,
      Math.abs(share - wantShare) < band(wantShare, out.feat5.win + out.feat5.lose),
      `${pctStr(share)} vs ${pctStr(wantShare)} over ${out.feat5.win + out.feat5.lose} 五星`);
    check(`${poolId}: 大保底 never breaks — no two off-featured 5★ in a row`,
      out.feat5.violation === 0 && out.feat5.afterLoss >= 20
      && out.feat5.afterLoss === out.feat5.afterLossFeatured,
      `${out.feat5.afterLossFeatured}/${out.feat5.afterLoss} pulls after a loss were the featured char`);
    check(`${poolId}: a banner with no 5★ weapons never gives one`,
      pool.fiveStar.weapons.length > 0 || !out.types5.get('weapon'),
      `types ${[...out.types5.keys()].join(',')}`);
  } else {
    check(`${poolId}: a pool with no featured character never arms 大保底`,
      !out.guaranteed5Ever, 'guaranteed5 stayed false');
    check(`${poolId}: both 5★ characters and 5★ weapons come out of it`,
      (out.types5.get('character') || 0) > 0 && (out.types5.get('weapon') || 0) > 0,
      `${out.types5.get('character')} chars / ${out.types5.get('weapon')} weapons`);
  }

  if (pool.featuredFour?.length) {
    const c4 = pool.fourStar.featuredChance;
    const wantShare4 = 1 / (2 - c4);
    const n4 = out.feat4.win + out.feat4.lose;
    const share4 = out.feat4.win / n4;
    check(`${poolId}: the 4★ rate-up lands on 1/(2−${c4}) featured`,
      Math.abs(share4 - wantShare4) < band(wantShare4, n4),
      `${pctStr(share4)} vs ${pctStr(wantShare4)} over ${n4} 四星`);
    check(`${poolId}: the 4★ guarantee holds as well`, out.feat4.violation === 0,
      `${out.feat4.violation} violations in ${out.feat4.lose} losses`);
    // Both halves of the off-featured pool must be reachable: before `featuredChance4` had
    // a consumer this branch did not exist at all, and the three featured names were the
    // *whole* 4★ character pool.
    check(`${poolId}: losing the 4★ rate-up gives off-banner chars and weapons`,
      out.feat4.offChars > 0 && out.feat4.offWeapons > 0,
      `${out.feat4.offChars} chars / ${out.feat4.offWeapons} weapons`);
  }

  if (VERBOSE) {
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`     5★: ${top(out.ids[5])}`);
    console.log(`     4★: ${top(out.ids[4])}`);
  }
}

// The two branches a sample cannot reach, driven from a chosen state instead.
//
// By pull 89 the ramp is already at 96.6%, so surviving to 90 has probability ~7e-8 — the
// `k >= pity` clamp will never be observed in any run of this probe, and "the longest drought
// was 87" is not evidence that the guarantee exists. Put the counter *at* the ceiling and
// the branch has to fire on every seed.
console.log('\n  the ceilings, driven from a chosen state');
for (const poolId of Object.keys(WISH_POOL)) {
  const pool = WISH_POOL[poolId];
  const base = { guaranteed5: false, guaranteed4: false, total: 0 };
  const at5 = [], at4 = [];
  for (let i = 0; i < 300; i++) {
    at5.push(pullWish(poolId, { ...base, pity5: pool.fiveStar.pity - 1, pity4: 0 }, nextSeed()).result.rarity);
    at4.push(pullWish(poolId, { ...base, pity5: 0, pity4: pool.fourStar.pity - 1 }, nextSeed()).result.rarity);
  }
  check(`${poolId}: at ${pool.fiveStar.pity - 1} pity the next pull is a 5★, every time`,
    at5.every((r) => r === 5), `rarities seen: ${[...new Set(at5)].join(',')} over 300 seeds`);
  check(`${poolId}: at ${pool.fourStar.pity - 1} the next pull is 4★ or better, every time`,
    at4.every((r) => r >= 4), `rarities seen: ${[...new Set(at4)].join(',')} over 300 seeds`);
  // A 5★ landing on the pull the 4★ was owed must not eat it: `pity4` is pushed back to
  // `pity - 1`, so the 4★ arrives on the very next pull.
  const preempt = pullWish(poolId, { ...base, pity5: pool.fiveStar.pity - 1, pity4: pool.fourStar.pity - 1 }, 12345);
  const next = pullWish(poolId, preempt.state, 999);
  check(`${poolId}: a 5★ on the 4★'s own pull only defers it by one`,
    preempt.result.rarity === 5 && preempt.state.pity4 === pool.fourStar.pity - 1 && next.result.rarity >= 4,
    `5★ then pity4 ${preempt.state.pity4} then ${next.result.rarity}★`);
}

/* ============================================================= 2. money ===== */

console.log('\n--- 2. a fresh guest pulls over REST: tickets, 原石 conversion, pity, history');

let token = '';
async function api(method, path, body) {
  const r = await fetch(ORIGIN + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let b = null;
  try { b = await r.json(); } catch { /* empty body */ }
  return { status: r.status, b: b || {} };
}

const health = await api('GET', '/api/health');
if (health.status !== 200) {
  note('the REST section', `server not answering on ${ORIGIN}`);
} else {
  const guest = await api('POST', '/api/guest', {});
  token = guest.b.token || '';
  check('a fresh traveller was minted', guest.status === 200 && !!token,
    `player ${guest.b.playerId}`);

  const pools = await api('GET', '/api/wish/pools');
  const published = new Map((pools.b.pools || []).map((p) => [p.id, p]));
  check('both banners are published', published.size === Object.keys(WISH_POOL).length,
    [...published.keys()].join(','));
  const mismatches = [];
  for (const [id, def] of Object.entries(WISH_POOL)) {
    const got = published.get(id);
    if (!got) { mismatches.push(`${id} missing`); continue; }
    const want = {
      name: def.name, rate5: def.fiveStar.rate, pity5: def.fiveStar.pity,
      rate4: def.fourStar.rate, pity4: def.fourStar.pity,
      featuredFive: def.featuredFive || null,
      featuredChance5: def.fiveStar.featuredChance ?? null,
      featuredChance4: def.fourStar.featuredChance ?? null,
      gemPerWish: GEM_PER_WISH,
    };
    for (const [k, v] of Object.entries(want)) {
      if (got[k] !== v) mismatches.push(`${id}.${k}: ${JSON.stringify(got[k])} ≠ ${JSON.stringify(v)}`);
    }
    if (got.softPity?.start !== SOFT_PITY.start || got.softPity?.step !== SOFT_PITY.step) {
      mismatches.push(`${id}.softPity ${JSON.stringify(got.softPity)}`);
    }
    if ((got.cost?.wishTicket ?? null) !== (def.cost?.wishTicket ?? null)) {
      mismatches.push(`${id}.cost ${JSON.stringify(got.cost)}`);
    }
  }
  check('...and every number they publish is the table\'s number', !mismatches.length,
    mismatches.length ? mismatches.slice(0, 4).join('; ') : 'name/rates/pity/rate-ups/cost/softPity/gem rate');

  const st0 = (await api('GET', '/api/player/state')).b.player || {};
  check('a new account starts with ten 纠缠之缘 and 1600 原石',
    st0.wishTicket === 10 && st0.primogem === 1600,
    `${st0.wishTicket} tickets, ${st0.primogem} gems`);

  const POOL = 'featured';
  const perPull = WISH_POOL[POOL].cost.wishTicket;
  const ten = await api('POST', '/api/wish/pull', { pool: POOL, count: 10 });
  check('a ten-pull returns ten results', ten.status === 200 && ten.b.results?.length === 10,
    `status ${ten.status}, ${ten.b.results?.length} results`);
  check('...and spends exactly ten tickets, no 原石',
    ten.b.player?.wishTicket === st0.wishTicket - 10 * perPull
    && ten.b.player?.primogem === st0.primogem,
    `${st0.wishTicket}→${ten.b.player?.wishTicket} tickets, ${st0.primogem}→${ten.b.player?.primogem} gems`);
  check('...and the pity block reports both guarantees',
    typeof ten.b.pity?.guaranteed5 === 'boolean' && typeof ten.b.pity?.guaranteed4 === 'boolean',
    JSON.stringify(ten.b.pity));
  check('...and the counter counted ten', ten.b.pity?.total === 10, `total ${ten.b.pity?.total}`);
  const gotFive = ten.b.results.some((r) => r.rarity === 5);
  check('...and pity5 advanced by ten unless a 5★ reset it',
    gotFive ? ten.b.pity.pity5 < 10 : ten.b.pity.pity5 === 10,
    `pity5 ${ten.b.pity.pity5}${gotFive ? ' (a 5★ landed)' : ''}`);
  const badRarity = ten.b.results.filter((r) => ![3, 4, 5].includes(r.rarity));
  check('...and every result is a real item at a real rarity',
    !badRarity.length && ten.b.results.every((r) => (r.type === 'character' ? !!CHARACTERS[r.id] : !!WEAPONS[r.id])),
    ten.b.results.map((r) => `${r.rarity}★${r.id}`).join(' '));
  check('...and a new character comes with an instance, a dupe with a constellation',
    ten.b.results.filter((r) => r.type === 'character')
      .every((r) => (r.dupe ? r.dupes >= 1 : r.dupes === 0 || r.dupes === undefined)),
    ten.b.results.filter((r) => r.type === 'character').map((r) => `${r.id}${r.dupe ? ` C${r.dupes}` : ' new'}`).join(', '));

  // The change, over REST. The expectation is recomputed from the shared table, and `capped`
  // is taken from the *constellation on the card* rather than from the flag printed beside
  // it: if the route ever stopped asking `grantCharacter` whether the duplicate raised
  // anything, reading its own `capped` back would only prove it agrees with itself.
  const expectPer = ten.b.results.map((r) => wishConversion(r, {
    capped: r.type === 'character' && !!r.dupe && r.dupes >= MAX_CONSTELLATION,
  }));
  const perBad = ten.b.results.map((r, i) => (eq(r.converted, expectPer[i])
    ? null : `${r.rarity}★${r.id}: ${JSON.stringify(r.converted)} ≠ ${JSON.stringify(expectPer[i])}`))
    .filter(Boolean);
  check('every card carries the change the shared table says it is worth', !perBad.length,
    perBad.length ? perBad.slice(0, 3).join('; ')
      : ten.b.results.map((r) => `${r.rarity}★${JSON.stringify(r.converted)}`).join(' '));
  check('...and `capped` agrees with the constellation on the same card',
    ten.b.results.filter((r) => r.type === 'character')
      .every((r) => !!r.capped === (!!r.dupe && r.dupes >= MAX_CONSTELLATION)),
    ten.b.results.filter((r) => r.type === 'character')
      .map((r) => `${r.id}${r.dupe ? ` C${r.dupes}` : ' new'}${r.capped ? ' capped' : ''}`).join(', '));
  const expectTotal = sumConversion(expectPer);
  check('...and the total the route publishes is the sum of them', eq(ten.b.converted, expectTotal),
    `${JSON.stringify(ten.b.converted)} vs ${JSON.stringify(expectTotal)}`);
  const invMoves = CHANGE_CURRENCIES.map((id) => {
    const before = st0.inventory?.[id] || 0;
    const after = ten.b.player?.inventory?.[id] || 0;
    return after === before + (expectTotal[id] || 0) ? null : `${id}: ${before}→${after}, expected +${expectTotal[id] || 0}`;
  }).filter(Boolean);
  check('...and the bag moved by exactly that much, no more', !invMoves.length,
    invMoves.length ? invMoves.join('; ')
      : CHANGE_CURRENCIES.map((id) => `${MATERIALS[id].name} ${ten.b.player?.inventory?.[id] || 0}`).join(', '));
  // The response is a mirror; the row is the truth. A change that only exists in the reply
  // is a balance that evaporates on the next login.
  const reread = (await api('GET', '/api/player/state')).b.player || {};
  check('...and it is the stored bag that moved, not just the reply',
    CHANGE_CURRENCIES.every((id) => (reread.inventory?.[id] || 0) === (ten.b.player?.inventory?.[id] || 0)),
    CHANGE_CURRENCIES.map((id) => `${MATERIALS[id].name} ${reread.inventory?.[id] || 0}`).join(', '));
  if (!ten.b.results.some((r) => r.capped)) {
    note('the maxed-dupe payout over REST',
      'no character reached C6 in ten pulls (that needs 7 copies of one 4★); the branch is driven in section 0b');
  }

  // Tickets are gone: the next pull must convert 原石 at the published rate.
  const one = await api('POST', '/api/wish/pull', { pool: POOL, count: 1 });
  check('with no tickets left, one pull converts 原石 at the published rate',
    one.status === 200 && one.b.player?.wishTicket === 0
    && one.b.player?.primogem === ten.b.player.primogem - GEM_PER_WISH * perPull,
    `${ten.b.player.primogem}→${one.b.player?.primogem} gems (${GEM_PER_WISH}/抽)`);
  check('...and the pity carried over instead of restarting', one.b.pity?.total === 11,
    `total ${one.b.pity?.total}`);

  // 1440 gems cannot buy ten pulls (1600); the refusal must cost nothing.
  const broke = await api('POST', '/api/wish/pull', { pool: POOL, count: 10 });
  check('a ten-pull it cannot afford is refused with the shortfall named',
    broke.status === 400 && broke.b.error === 'not_enough_currency'
    && broke.b.needGems === 10 * perPull * GEM_PER_WISH,
    `status ${broke.status} ${broke.b.error} need ${broke.b.needGems} have ${broke.b.haveGems}`);
  const afterBroke = (await api('GET', '/api/player/state')).b.player || {};
  check('...and the refusal charged nothing',
    afterBroke.primogem === one.b.player.primogem && afterBroke.wishTicket === 0,
    `${afterBroke.primogem} gems, ${afterBroke.wishTicket} tickets`);
  check('...and the pity state did not move either',
    afterBroke.wishState?.[POOL]?.total === 11,
    JSON.stringify(afterBroke.wishState?.[POOL]));

  const bad = await api('POST', '/api/wish/pull', { pool: POOL, count: 3 });
  const badPool = await api('POST', '/api/wish/pull', { pool: 'nope', count: 1 });
  check('only 1 and 10 are pullable, and only real pools',
    bad.status === 400 && badPool.status === 400, `${bad.status} / ${badPool.status}`);

  const hist = await api('GET', '/api/wish/history');
  const rows = hist.b.history || [];
  check('the history holds one row per pull', rows.length === 11, `${rows.length} rows`);
  check('...each naming its pool, type, item and rarity',
    rows.every((r) => r.pool === POOL && ['character', 'weapon'].includes(r.item_type)
      && [3, 4, 5].includes(Number(r.rarity))
      && (r.item_type === 'character' ? !!CHARACTERS[r.item_id] : !!WEAPONS[r.item_id])),
    JSON.stringify(rows[0] || null));

  const ach = await api('GET', '/api/achievements');
  check('the 祈愿次数 stat is derived from that history, not tallied separately',
    ach.b.progress?.wishes === 11, `wishes ${ach.b.progress?.wishes}`);

  // The sink, end to end — and the assertion that makes this module worth having. Change
  // that cannot become a pull is just a number going up, which is the dead end 星辉/星尘 was
  // added to close: before it, a C6 duplicate and every surplus 3★ weapon gave literally
  // nothing.
  const preBuy = (await api('GET', '/api/player/state')).b.player || {};
  const dust = preBuy.inventory?.stardust || 0;
  if (dust < DUST_PER_WISH) {
    note('buying a wish back with 星尘', `only ${dust}/${DUST_PER_WISH} 星尘 after eleven pulls — unlucky sample`);
  } else {
    const buy = await api('POST', '/api/shop/buy', { entryId: 'bar_dustWish', count: 1 });
    check('星尘 buys a 纠缠之缘 back at the shop\'s published price',
      buy.status === 200 && buy.b.player?.wishTicket === (preBuy.wishTicket || 0) + 1
      && buy.b.player?.inventory?.stardust === dust - DUST_PER_WISH,
      `status ${buy.status}: ${dust}→${buy.b.player?.inventory?.stardust} 星尘, 纠缠之缘 ${preBuy.wishTicket}→${buy.b.player?.wishTicket}`);
    const spend = await api('POST', '/api/wish/pull', { pool: POOL, count: 1 });
    check('...and the ticket it bought pulls, without touching 原石',
      spend.status === 200 && spend.b.player?.wishTicket === (preBuy.wishTicket || 0)
      && spend.b.player?.primogem === preBuy.primogem,
      `status ${spend.status}, 纠缠之缘 ${spend.b.player?.wishTicket}, 原石 ${spend.b.player?.primogem}`);
    check('...and that pull paid its own change into the bag',
      eq(spend.b.converted, sumConversion(spend.b.results.map((r) => wishConversion(r, { capped: !!r.capped })))),
      `${spend.b.results?.[0]?.rarity}★ → ${JSON.stringify(spend.b.converted)}`);
  }
}

/* ============================================================ 3. the panel == */

if (NO_BROWSER) {
  note('the panel section', 'no DISPLAY (run under Xvfb to include it)');
} else {
  console.log('\n--- 3. the 祈愿 panel prints the published numbers');
  const puppeteer = (await import('puppeteer')).default;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const browser = await puppeteer.launch({
    browser: 'firefox', headless: false,
    args: ['--width=1600', '--height=900'],
    extraPrefsFirefox: { 'webgl.force-enabled': true, 'media.autoplay.default': 0 },
    defaultViewport: { width: 1600, height: 900 },
  });
  const page = (await browser.pages())[0] || await browser.newPage();
  const NOISE = /WebGL|EGL|GL_|Content Security|favicon|downloadable font|autoplay/i;
  const errors = [];
  page.on('pageerror', (e) => { const s = String(e).slice(0, 200); if (!NOISE.test(s)) errors.push(s); });
  page.on('console', (m) => { if (m.type() === 'error') { const s = m.text().slice(0, 200); if (!NOISE.test(s)) errors.push(s); } });
  const settle = async (extra = 400) => {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    await sleep(extra);
  };

  try {
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    // 单机 + 游客: a brand-new account, so the currency assertions below are exact.
    await page.evaluate(() => document.querySelector('[data-act="solo"]')?.click());
    await sleep(300);
    await page.evaluate(() => document.querySelector('[data-act="guest"]')?.click());
    let booted = false;
    for (let i = 0; i < 80; i++) {
      if (await page.evaluate(() => !!window.game?.player)) { booted = true; break; }
      await sleep(500);
    }
    check('a guest session booted into the world', booted);

    // Nothing here is a pixel read, so the tier does not matter — but a governor tier change
    // mid-run disposes every scatter cell and stalls the page for seconds, which is enough to
    // time out a wait. Pin it by turning the governor off, and leave the tier where it booted.
    await page.evaluate(() => window.game.setAutoQuality?.(false));
    await page.evaluate(() => window.game.emit('togglePanel', { panel: 'wish', open: true }));
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => !!document.querySelector('.panel .col.side .stats [data-k]'))) break;
      await sleep(300);
    }
    await settle();

    const read = () => page.evaluate(() => {
      const dl = document.querySelector('.panel .col.side .stats');
      const rows = {};
      if (dl) {
        for (const dd of dl.querySelectorAll('dd[data-k]')) {
          rows[dd.dataset.k] = { text: dd.textContent, up: dd.classList.contains('up') };
        }
      }
      return {
        rows,
        pool: document.querySelector('.panel .col.side .list-row.sel b')?.textContent || '',
        hero: document.querySelector('.wish-hero .txt p')?.textContent || '',
        hint: [...document.querySelectorAll('.panel .col.side p')].map((p) => p.textContent).join(' | '),
        foot: document.querySelector('.panel footer span')?.textContent || '',
        cards: document.querySelectorAll('.pulls .pull').length,
        tickets: window.game.player.wishTicket, gems: window.game.player.primogem,
        // The change, as three separate readings: per card, the line that sums them, and the
        // balances the footer prints. A panel can get any one of the three right on its own.
        cardChange: [...document.querySelectorAll('.pulls .pull')].map((c) => ({
          cls: c.className, tag: c.querySelector('.tag')?.textContent || '',
          cv: c.querySelector('.cv')?.textContent || '',
        })),
        changeTotal: document.querySelector('.pull-change')?.textContent || '',
        inv: { ...(window.game.player.inventory || {}) },
      };
    });
    const before = await read();
    check('the panel opened on a banner with a full odds block',
      Object.keys(before.rows).length >= 6,
      `${before.pool}: ${Object.keys(before.rows).join(',')}`);

    // Which banner is selected decides every expected number, so read it from the panel and
    // look the payload up by name. `/api/wish/pools` sits behind `requireAuth`, so this has to
    // go through the helper that carries section 2's token — a bare fetch gets a 401 and the
    // whole comparison quietly turns into a SKIP.
    const poolsRes = (await api('GET', '/api/wish/pools')).b;
    const shown = (poolsRes.pools || []).find((p) => p.name === before.pool)
      || (poolsRes.pools || [])[0];
    if (!shown) {
      note('the printed-vs-published comparison', 'could not fetch /api/wish/pools');
    } else {
      const want5 = `${(shown.rate5 * 100).toFixed(2)}%`;
      const want4 = `${(shown.rate4 * 100).toFixed(2)}%`;
      check('the printed base rates are the published base rates',
        before.rows.rate5?.text === want5 && before.rows.rate4?.text === want4,
        `5★ "${before.rows.rate5?.text}" want ${want5}, 4★ "${before.rows.rate4?.text}" want ${want4}`);
      check('...and the pity rows print the published ceilings',
        before.rows.pity5?.text.endsWith(`/ ${shown.pity5}`)
        && before.rows.pity4?.text.endsWith(`/ ${shown.pity4}`),
        `"${before.rows.pity5?.text}" · "${before.rows.pity4?.text}"`);
      const pity5Now = Number((before.rows.pity5?.text || '0').split('/')[0].trim());
      const wantNow = `${(wishRate5({ rate: shown.rate5, pity: shown.pity5 }, pity5Now + 1) * 100).toFixed(2)}%`;
      check('...and 当前五星概率 is the curve\'s value for the next pull',
        before.rows.rateNow?.text === wantNow,
        `"${before.rows.rateNow?.text}" want ${wantNow} at pity ${pity5Now}`);
      check('...and the soft-pity hint names the published start and step',
        before.hint.includes(String(shown.softPity.start))
        && before.hint.includes(`${(shown.softPity.step * 100).toFixed(1)}%`),
        `"${before.hint.trim().slice(0, 80)}"`);
      check('...and the footer quotes the published 原石 rate, not a literal',
        before.foot.includes(String(shown.gemPerWish))
        && before.foot.includes(String(shown.cost.wishTicket)),
        `"${before.foot}"`);
      if (shown.featuredChance5 != null) {
        check('the rate-up chances are printed as percentages',
          before.rows.feat5?.text.includes(`${Math.round(shown.featuredChance5 * 100)}%`)
          && before.rows.feat4?.text.includes(`${Math.round(shown.featuredChance4 * 100)}%`),
          `5★ "${before.rows.feat5?.text}", 4★ "${before.rows.feat4?.text}"`);
        const names = (shown.featuredFour || []).length;
        check('...and the banner names its featured 4★ characters',
          names > 0 && before.hero.includes('限定四星'), `"${before.hero}"`);
      } else {
        check('a standard banner prints no rate-up row',
          !before.rows.feat5 && !before.rows.feat4, 'no feat rows');
      }

      // Now pull. This is the half a data check cannot make: the button, the reveal, and
      // the numbers that must move afterwards without a re-render.
      const clicked = await page.evaluate(() => {
        const b = [...document.querySelectorAll('.panel footer .btn')]
          .find((x) => x.textContent.includes('×10'));
        if (!b) return false;
        b.click();
        return true;
      });
      check('the 祈愿 ×10 button is there and clickable', clicked);
      for (let i = 0; i < 60; i++) {
        if (await page.evaluate(() => document.querySelectorAll('.pulls .pull').length >= 10)) break;
        await sleep(300);
      }
      await settle();
      const after = await read();
      check('ten cards were revealed', after.cards === 10, `${after.cards} cards`);
      check('...and the ten tickets left the wallet',
        after.tickets === before.tickets - 10 * shown.cost.wishTicket,
        `${before.tickets} -> ${after.tickets}`);
      check('...and the footer says so without a re-render',
        after.foot.includes(String(after.tickets)) && after.foot !== before.foot,
        `"${after.foot}"`);
      check('...and 累计祈愿 advanced by ten',
        Number(after.rows.total.text.replace(/[^0-9]/g, '')) === Number(before.rows.total.text.replace(/[^0-9]/g, '')) + 10,
        `${before.rows.total.text} -> ${after.rows.total.text}`);
      const cardText = await page.evaluate(() => [...document.querySelectorAll('.pulls .pull')]
        .map((c) => `${c.className}|${c.querySelector('.nm')?.textContent}|${c.querySelector('.tag')?.textContent}`));
      const pityAfter = Number((after.rows.pity5?.text || '0').split('/')[0].trim());
      // A 5★ in the ten resets the counter, so which number is right depends on the cards —
      // asserting `+10` unconditionally would fail on a lucky account roughly one run in six.
      const hitFive = cardText.some((t) => /\br5\b/.test(t.split('|')[0]));
      check('...and 五星保底 moved with it',
        hitFive ? pityAfter >= 0 && pityAfter < 10 : pityAfter === pity5Now + 10,
        `${before.rows.pity5?.text} -> ${after.rows.pity5?.text}${hitFive ? ' (a 5★ reset it)' : ''}`);
      const wantAfter = `${(wishRate5({ rate: shown.rate5, pity: shown.pity5 }, pityAfter + 1) * 100).toFixed(2)}%`;
      check('...and 当前五星概率 was recomputed for the new pity, not left stale',
        after.rows.rateNow?.text === wantAfter,
        `"${after.rows.rateNow?.text}" want ${wantAfter}`);
      check('...and every card names something with a rarity class and a tag',
        cardText.length === 10 && cardText.every((t) => /r[345]\|/.test(t.replace('pull ', ''))
          && t.split('|')[1] && t.split('|')[2]),
        cardText.slice(0, 3).join('  '));

      // 星辉/星尘, in the only place the player actually meets it. The expected strings are
      // rebuilt from the shared table using each card's *own* rarity class and tag — so a
      // panel that printed one currency for everything, or reused the first card's line, is
      // caught rather than averaged away.
      const changeStr = (map) => CHANGE_CURRENCIES.filter((id) => map?.[id])
        .map((id) => `${MATERIALS[id].icon}${MATERIALS[id].name} +${map[id].toLocaleString('en-US')}`)
        .join(' · ');
      const cardMaps = after.cardChange.map((c) => {
        const rarity = Number((c.cls.match(/\br([345])\b/) || [])[1] || 3);
        const isChar = /命之座|新角色/.test(c.tag);
        return wishConversion({ rarity, type: isChar ? 'character' : 'weapon' },
          { capped: /命之座已满/.test(c.tag) });
      });
      const cvBad = after.cardChange
        .map((c, i) => (c.cv === changeStr(cardMaps[i]) ? null
          : `${c.cls}|${c.tag}: "${c.cv}" ≠ "${changeStr(cardMaps[i])}"`))
        .filter(Boolean);
      check('every revealed card prints the change it converted to', !cvBad.length,
        cvBad.length ? cvBad.slice(0, 3).join('; ')
          : [...new Set(after.cardChange.map((c) => c.cv))].join(' / '));
      const totalMap = sumConversion(cardMaps);
      check('...and the line under the reveal is the sum of the ten',
        after.changeTotal === `本次共获得 ${changeStr(totalMap)}`,
        `"${after.changeTotal}" want "本次共获得 ${changeStr(totalMap)}"`);
      // Both directions on the footer: it printed zeroes before the pull and the earned
      // amounts after. Without the first half, a footer that prints a constant 0 would pass.
      check('...and the footer carried both balances all along, from 0 to what was earned',
        CHANGE_CURRENCIES.every((id) => (before.inv[id] || 0) === 0
          && before.foot.includes(`${MATERIALS[id].icon}${MATERIALS[id].name} 0`)
          && (after.inv[id] || 0) === (totalMap[id] || 0)
          && after.foot.includes(`${MATERIALS[id].icon}${MATERIALS[id].name} ${(after.inv[id] || 0).toLocaleString('en-US')}`)),
        `${CHANGE_CURRENCIES.map((id) => `${MATERIALS[id].name} ${before.inv[id] || 0}→${after.inv[id] || 0}`).join(', ')} | "${after.foot}"`);

      // Everything above ran at pity 0-10, where the ramp is flat and 大保底 is off — so
      // 「当前五星概率 0.60%」 and 「限定五星 55%」 would read exactly the same if the panel
      // ignored the curve and both guarantees entirely. Put the client's copy of the state
      // deep in soft pity and reopen: these rows now have to move, and this is also the only
      // way to see the 大保底 wording at all.
      await page.evaluate((p) => {
        window.game.player.wishState = { ...window.game.player.wishState,
          [p]: { pity5: 80, pity4: 3, total: 120, guaranteed5: true, guaranteed4: true } };
        window.game.emit('togglePanel', { panel: 'wish', open: true });
      }, shown.id);
      for (let i = 0; i < 40; i++) {
        if (await page.evaluate(() => !!document.querySelector('.panel .col.side .stats [data-k]'))) break;
        await sleep(300);
      }
      await settle();
      const deep = await read();
      const wantDeep = `${(wishRate5({ rate: shown.rate5, pity: shown.pity5 }, 81) * 100).toFixed(2)}%`;
      check('at 80 pity the panel prints the ramped rate, not the base rate',
        deep.rows.rateNow?.text === wantDeep && deep.rows.rateNow?.up
        && deep.rows.rate5?.text === `${(shown.rate5 * 100).toFixed(2)}%`,
        `当前 "${deep.rows.rateNow?.text}" (want ${wantDeep}, highlighted ${deep.rows.rateNow?.up}) vs 基础 "${deep.rows.rate5?.text}"`);
      check('...and both guarantees say so in words instead of a percentage',
        deep.rows.feat5?.text.includes('大保底') && deep.rows.feat5?.up
        && deep.rows.feat4?.text.includes('必定') && deep.rows.feat4?.up,
        `5★ "${deep.rows.feat5?.text}", 4★ "${deep.rows.feat4?.text}"`);

      // And now the reverse: one real pull, whose response carries the account's true counters,
      // has to overwrite that injected 80/120. If the post-pull patch skipped either row it
      // would still read 80. What the true counters *are* is a draw, not a constant: this pull
      // is a 5★ about one run in 167 and then pity5 resets to 0 instead of stepping to 11, so
      // the expectation is derived from the pre-injection reading plus this card's own rarity,
      // exactly as 「五星保底 moved with it」 does for the ten-pull above. Both derived values
      // are far below the injected ones (pity ≤ 11 vs 80, total 11 vs 120), so the row still
      // fails if the patch leaves either injected number in place.
      await page.evaluate(() => [...document.querySelectorAll('.panel footer .btn')]
        .find((x) => x.textContent.includes('×1'))?.click());
      for (let i = 0; i < 60; i++) {
        if (await page.evaluate(() => document.querySelectorAll('.pulls .pull').length === 1)) break;
        await sleep(300);
      }
      await settle();
      const back = await read();
      const backFive = /\br5\b/.test(back.cardChange[0]?.cls || '');
      const wantBackPity = backFive ? 0 : pityAfter + 1;
      const wantBackTotal = String(Number(after.rows.total.text.replace(/[^0-9]/g, '')) + 1);
      const wantBackRate = `${(wishRate5({ rate: shown.rate5, pity: shown.pity5 }, wantBackPity + 1) * 100).toFixed(2)}%`;
      check('one pull snaps every injected row back to the server\'s own state',
        back.cards === 1 && back.rows.pity5?.text === `${wantBackPity} / ${shown.pity5}`
        && back.rows.total?.text.replace(/[^0-9]/g, '') === wantBackTotal
        && back.rows.rateNow?.text === wantBackRate,
        `pity5 "${back.rows.pity5?.text}" want "${wantBackPity} / ${shown.pity5}"${backFive ? ' (a 5★ reset it)' : ''}, `
        + `累计 "${back.rows.total?.text}" want ${wantBackTotal}, 当前 "${back.rows.rateNow?.text}" want ${wantBackRate}`);
      check('...and it was paid for in 原石 at the published rate',
        back.tickets === 0 && back.gems === after.gems - shown.gemPerWish * shown.cost.wishTicket
        && back.foot.includes(back.gems.toLocaleString('en-US')),
        `${after.gems} -> ${back.gems} 原石, footer "${back.foot}"`);
    }
    check('no page errors through any of it', !errors.length, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
}

console.log(`\nwish-check: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail);
