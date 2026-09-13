// Loot rolls, artifact generation, stat aggregation, wish resolution.
// Shared so the client can preview and the server can authorise identically.

import { Rand } from './rng.js';
import { ENEMIES } from '../data/enemies.js';
import { CHEST_TIERS } from '../data/zones.js';
import {
  ARTIFACT_SETS, ARTIFACT_SLOTS, ARTIFACT_MAIN_STATS, ARTIFACT_SUB_STATS,
  WEAPONS, WISH_POOL,
} from '../data/items.js';
import { CHARACTERS, dupeBonus, talentScale } from '../data/characters.js';
import { GLITTER_PER_WISH } from '../data/shop.js';
import { partyResonances, resonanceHint } from '../data/resonance.js';
import { statAtLevel, xpForLevel, totalXpTo, arCap } from './formulas.js';

let uidCounter = 1;
export function uid(prefix = 'i') {
  return `${prefix}_${(uidCounter++).toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/* ------------------------------------------------------------- enemy loot -- */

/**
 * XP for one kill, denominated in the *level's own* requirement rather than in
 * absolute points, so a kill is always worth roughly the same fraction of a level.
 *
 * The old form was `def.xp * (1 + level * 0.05)`: linear in level while `xpForLevel`
 * is super-linear, so the number of kills per level exploded with progress — a level
 * 55 hilichurl paid 150 xp toward a 83 540 xp level. Measured end to end
 * (`tools/balance-check.mjs`), playing every camp, chamber, chest and quest the game
 * contains exactly once left the party at level 42 while the last dungeon wants 55,
 * and closing that gap meant 156 more camp clears.
 *
 * The anchor is a level-appropriate hilichurl (`xp: 40`) at a twentieth of a level, so
 * roughly 20 kills of trash buys a level anywhere on the ladder, and a level 3 hilichurl
 * still pays 49 where it used to pay 46. `def.xp` spans 24 to 4200, and taking that
 * ratio straight made a boss worth five levels in one kill; the 0.6 exponent compresses
 * it to a sane spread — 27 kills a level for a slime, 5 for a ruin guard, and 0.8 of a
 * level for the storm tyrant.
 */
export function enemyXp(enemyId, level) {
  const def = ENEMIES[enemyId];
  if (!def) return 0;
  return Math.round(xpForLevel(level) * 0.05 * Math.pow(def.xp / 40, 0.6));
}

export function rollEnemyLoot(enemyId, level, seed = 12345) {
  const def = ENEMIES[enemyId];
  if (!def) return { items: {}, xp: 0, mora: 0 };
  const rand = new Rand(seed);
  const items = {};
  let mora = 0;
  for (const [id, chance] of def.loot || []) {
    if (id === 'mora') {
      mora += Math.round((40 + level * 12) * rand.float(0.8, 1.3));
      continue;
    }
    if (rand.chance(chance)) {
      items[id] = (items[id] || 0) + rand.int(1, def.elite ? 3 : 2);
    }
  }
  return { items, mora, xp: enemyXp(enemyId, level) };
}

/* ----------------------------------------------------------------- chests -- */

export function rollChest(tier, level, seed = 999) {
  const t = CHEST_TIERS[tier] || CHEST_TIERS.common;
  const rand = new Rand(seed);
  const items = {};
  const artifacts = [];
  const weapons = [];
  const mora = rand.int(t.mora[0], t.mora[1]);
  for (let i = 0; i < t.rolls; i++) {
    const id = rand.weighted([
      ['adventurerXp', 4], ['heroWit', 1], ['sweetFlower', 2], ['mint', 2],
      ['crystalCore', 1.5], ['slimeCondensate', 2], ['sweetMadame', 1.5],
    ]);
    items[id] = (items[id] || 0) + rand.int(1, 3);
  }
  if (rand.chance(t.artifactChance)) {
    artifacts.push(generateArtifact(level, rand.int(0, 1e9), tier === 'luxurious' ? 5 : 4));
  }
  if (t.weaponChance && rand.chance(t.weaponChance)) {
    const pool = Object.values(WEAPONS).filter((w) => w.rarity === 4);
    weapons.push(makeWeapon(rand.pick(pool).id));
  }
  return { mora, primogem: t.primogem, items, artifacts, weapons };
}

/* ------------------------------------------------------------- domain drop -- */

/**
 * The drop one 秘境 run pays for its resin — artifacts from that domain's own set list
 * plus the talent materials `TALENT_COST` asks for.
 *
 * Deliberately *not* scaled by star count: stars are the one-time milestone reward, and
 * paying the farm drop per star as well would mean the same clear could be worth three
 * times as much on the first run as on every run after it, which is the "one fight paid
 * twice" shape this file's callers have already been burned by. The floor's own level is
 * the only scale, so a run is worth what its enemies were worth to beat.
 */
export function rollDomainReward(zone, floor, level, seed = 4242) {
  const dom = zone?.domain;
  if (!dom) return null;
  const rand = new Rand(seed >>> 0);
  const artifacts = [];
  // Two pieces from the sixth floor on, and the fifth star only from level 40 — below
  // that a 5★ piece is a level-4 shell whose sub-stats are worse than the 4★ it replaces.
  const count = floor >= 6 ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const rarity = level >= 40 || rand.chance(0.3) ? 5 : 4;
    artifacts.push(generateArtifact(level, rand.int(0, 1e9), rarity, rand.pick(dom.sets)));
  }
  const items = {};
  for (let i = 0; i < 2 + Math.floor(floor / 3); i++) {
    const id = rand.pick(dom.mats);
    items[id] = (items[id] || 0) + rand.int(1, 3);
  }
  // Character xp is the other thing a run is farmed for, and the books are the only way
  // to spend it on a character who is not in the active party.
  items[level >= 40 ? 'heroWit' : 'adventurerXp'] = rand.int(1, 3);
  return { artifacts, items, mora: Math.round((1200 + level * 55) * rand.float(0.9, 1.15)) };
}

/* -------------------------------------------------------------- artifacts -- */

export function generateArtifact(level = 1, seed = 1, rarity = 5, forceSet = null, forceSlot = null) {
  const rand = new Rand(seed >>> 0);
  const setIds = Object.keys(ARTIFACT_SETS);
  const setId = forceSet || rand.pick(setIds);
  const slot = forceSlot || rand.pick(ARTIFACT_SLOTS);
  const mainPool = ARTIFACT_MAIN_STATS[slot];
  const [mainKey, mainMax] = rand.pick(mainPool);
  const artLevel = Math.min(20, Math.max(0, Math.floor(level / 4.5) + rand.int(0, 3)));
  const lvlFrac = 0.2 + 0.8 * (artLevel / 20);
  const rarityMul = rarity === 5 ? 1 : 0.78;

  const subCount = Math.min(4, (rarity === 5 ? 3 : 2) + Math.floor(artLevel / 6));
  const subs = [];
  const used = new Set([mainKey]);
  for (let i = 0; i < subCount; i++) {
    const pool = ARTIFACT_SUB_STATS.filter((s) => !used.has(s[0]));
    if (!pool.length) break;
    const pick = rand.weighted(pool.map((s) => [s, s[2]]));
    used.add(pick[0]);
    const rolls = 1 + Math.floor(artLevel / 4);
    let val = 0;
    for (let r = 0; r < rolls; r++) val += pick[1] * rand.float(0.7, 1.0);
    subs.push({ key: pick[0], value: round4(val * rarityMul) });
  }

  return {
    uid: uid('art'),
    kind: 'artifact',
    setId, slot, rarity, level: artLevel,
    main: { key: mainKey, value: round4(mainMax * lvlFrac * rarityMul) },
    subs,
    name: `${ARTIFACT_SETS[setId].name}·${slot}`,
    locked: false,
  };
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/* ------------------------------------------------ artifact enhancement -- */

/**
 * Levelling an artifact you already own, paid for with the ones you don't want.
 *
 * Before this the only thing a spare piece was good for was `POST /api/inventory/salvage`,
 * which turns it into mora — so a domain that rains artifacts produced a bag of pieces the
 * player could look at and sell, but never a *better* piece. Enhancement is the half that
 * makes farming mean something: the drop decides the set, the slot and the main stat, and
 * the fodder decides how far you take it.
 *
 * The numbers are pinned to `generateArtifact` rather than invented next to it, which is
 * the whole reason this lives in the same file. A piece enhanced to +N must be worth the
 * same as a piece that *dropped* at +N, or the two sources would disagree about what a
 * level means: the main stat is recomputed from the slot's own table with the generator's
 * `0.2 + 0.8 * level/20` fraction, every 4 levels adds one roll to each existing sub-stat
 * (the generator gives every sub `1 + floor(level/4)` rolls), and every 6 levels unlocks
 * one more sub up to four, rolled with the full complement so it does not arrive stunted.
 *
 * The price is derived from one statement instead of a second table: **a full 0 -> 20
 * climb costs `ARTIFACT_CLIMB_FODDER` +0 pieces of the same rarity**. Everything else
 * follows — the per-level step, the cross-rarity exchange rate, the mora. Writing both a
 * cost curve and a fodder value independently is how the rest of this game's balance bugs
 * were born: a constant paid into a curve that has moved on without it.
 */
export const ARTIFACT_LEVEL_CAP = 20;
/** What a +0 piece is worth when it is fed to another one. */
export const ARTIFACT_FODDER_XP = { 3: 500, 4: 1000, 5: 2000 };
/** A full climb costs this many +0 pieces of the same rarity. */
export const ARTIFACT_CLIMB_FODDER = 8;
/**
 * Mora per xp — deliberately 7.5x the 0.2/xp `levelUpCharacter` charges for books, not
 * the same rate. Artifact xp is a much smaller unit (a whole 5* climb is 16 000 against a
 * character's 6.27 M to level 90), so charging the book rate would price a maxed piece at
 * 3 200 mora and make the mora side of enhancement invisible.
 */
export const ARTIFACT_MORA_PER_XP = 1.5;
/** How much steeper the last level is than the first. */
const ARTIFACT_STEP_SLOPE = 0.55;

const STEP_SUM = (() => {
  let t = 0;
  for (let l = 0; l < ARTIFACT_LEVEL_CAP; l++) t += 1 + ARTIFACT_STEP_SLOPE * l;
  return t;
})();

/** XP to take a piece from `level` to `level + 1`. */
export function artifactLevelCost(rarity, level) {
  const base = ARTIFACT_FODDER_XP[rarity] ?? ARTIFACT_FODDER_XP[4];
  return Math.round((base * ARTIFACT_CLIMB_FODDER / STEP_SUM) * (1 + ARTIFACT_STEP_SLOPE * level));
}

/** XP already sunk into a piece sitting at `level`. */
export function artifactXpToLevel(rarity, level) {
  let t = 0;
  for (let l = 0; l < Math.min(level, ARTIFACT_LEVEL_CAP); l++) t += artifactLevelCost(rarity, l);
  return t;
}

/**
 * What `a` is worth as fodder: its rarity's base plus 80% of what was put into it.
 *
 * The 20% haircut is what stops a piece being a lossless xp bank — feed A into B and B
 * back into A and you are down a fifth plus the mora, so there is no cycle to farm.
 */
export function artifactFodderXp(a) {
  if (!a || a.kind !== 'artifact') return 0;
  const base = ARTIFACT_FODDER_XP[a.rarity] ?? ARTIFACT_FODDER_XP[4];
  return base + Math.round(0.8 * artifactXpToLevel(a.rarity, a.level || 0));
}

/** XP still needed to take `a` all the way to the cap. */
export function artifactXpToCap(a) {
  return Math.max(0, artifactXpToLevel(a.rarity, ARTIFACT_LEVEL_CAP) - artifactXpToLevel(a.rarity, a.level || 0));
}

/**
 * Spend `xp` on `a`. Returns a *new* artifact plus what changed; `a` is untouched.
 * Overflow past the cap is reported in `xpLeft` — callers stop feeding before it happens.
 */
export function enhanceArtifact(a, xp, seed = 7) {
  const out = { ...a, main: { ...a.main }, subs: (a.subs || []).map((s) => ({ ...s })) };
  const from = out.level || 0;
  let level = from, left = xp, spent = 0;
  while (level < ARTIFACT_LEVEL_CAP) {
    const cost = artifactLevelCost(out.rarity, level);
    if (left < cost) break;
    left -= cost;
    spent += cost;
    level++;
  }
  const gains = [];
  const newSubs = [];
  if (level === from) return { artifact: out, from, level, levels: 0, gains, newSubs, spent, xpLeft: left };

  const rand = new Rand(seed >>> 0);
  const rarityMul = out.rarity === 5 ? 1 : 0.78;
  const rollsBefore = 1 + Math.floor(from / 4);
  const rollsAfter = 1 + Math.floor(level / 4);
  for (const s of out.subs) {
    const def = ARTIFACT_SUB_STATS.find((d) => d[0] === s.key);
    if (!def) continue;
    let add = 0;
    for (let r = rollsBefore; r < rollsAfter; r++) add += def[1] * rand.float(0.7, 1.0);
    if (add <= 0) continue;
    add = round4(add * rarityMul);
    s.value = round4(s.value + add);
    gains.push({ key: s.key, add });
  }
  const wantSubs = Math.min(4, (out.rarity === 5 ? 3 : 2) + Math.floor(level / 6));
  while (out.subs.length < wantSubs) {
    const used = new Set([out.main.key, ...out.subs.map((s) => s.key)]);
    const pool = ARTIFACT_SUB_STATS.filter((s) => !used.has(s[0]));
    if (!pool.length) break;
    const pick = rand.weighted(pool.map((s) => [s, s[2]]));
    let val = 0;
    for (let r = 0; r < rollsAfter; r++) val += pick[1] * rand.float(0.7, 1.0);
    const sub = { key: pick[0], value: round4(val * rarityMul) };
    out.subs.push(sub);
    newSubs.push(sub);
  }
  const mdef = (ARTIFACT_MAIN_STATS[out.slot] || []).find((m) => m[0] === out.main.key);
  if (mdef) out.main.value = round4(mdef[1] * (0.2 + 0.8 * (level / ARTIFACT_LEVEL_CAP)) * rarityMul);
  out.level = level;
  return { artifact: out, from, level, levels: level - from, gains, newSubs, spent, xpLeft: left };
}

export function makeWeapon(weaponId, level = 1, refinement = 1) {
  const def = WEAPONS[weaponId];
  if (!def) return null;
  return { uid: uid('wpn'), kind: 'weapon', weaponId, level, xp: 0, refinement, locked: false };
}

export function weaponStats(weapon) {
  const def = WEAPONS[weapon.weaponId];
  if (!def) return { atk: 0, sub: null };
  const t = (weapon.level - 1) / 89;
  const atk = Math.round(def.baseAtk * (1 + 5.4 * Math.pow(t, 1.08)));
  const sub = def.sub ? { key: def.sub.key, value: def.sub.value * (0.35 + 0.65 * (weapon.level / 90)) } : null;
  return { atk, sub, passive: refinePassive(def.passive, weapon.refinement || 1), def };
}

/* ------------------------------------------------------- weapon growth -- */

/**
 * Levelling and refining a weapon: the other half of the curve the enemies are sized on.
 *
 * `enemyStatAtLevel` is defined as *the product of the player's two growth curves* —
 * `statAtLevel` for the character and `weaponStats` for the weapon — on the argument that
 * a player's offence advances on both axes at once. Only one of those axes existed. Every
 * weapon in the game was minted at level 1 by `makeWeapon` and nothing could ever raise
 * it, so the second factor was frozen while enemy hp kept paying for it: at level 90 a
 * party with level-1 weapons has 76 % of the attack the enemy curve was sized against
 * (measured across levels 1/20/50/80/90: 1.00, 0.87, 0.80, 0.77, 0.76), i.e. a permanent
 * quarter cut off every kill-time margin `balance-check` reports. That audit even set
 * `weaponLevel = level` by default, so it was grading the game on gear the game did not
 * hand out — the same mistake as pricing a repeat chamber run at its one-time milestone.
 *
 * `refinement` was dead in the same way: the field was on every weapon from the moment it
 * was generated, `makeWeapon` took it as an argument, the README promised "15 把武器可精炼",
 * and nothing read it. Duplicate weapons from the wish pool simply piled up in the bag.
 *
 * The price is derived from **one** authored statement, as with artifacts: *a full climb
 * on a 3-star weapon costs `WEAPON_CLIMB_ORE` chunks of the commonest ore*. From that:
 *
 * - the *shape* of the cost curve is not invented at all, it is `xpForLevel` — the
 *   character curve — normalised to fit the total. That is the point: the two factors in
 *   `enemyStatAtLevel` have to be climbable in step, and the only way to guarantee that
 *   without a second table drifting is to make the weapon's climb literally the same
 *   shape as the character's.
 * - the ore ladder and the rarity ladder are the *same* ladder, `RARITY_STEP`, already
 *   authored once as `ARTIFACT_FODDER_XP` (500/1000/2000). One step up in ore tier and
 *   one step up in weapon rarity are both worth 2x.
 * - mora is `WEAPON_MORA_PER_XP`, which really is the rate `levelUpCharacter` charges for
 *   experience books, because weapon xp is denominated in the same curve as character xp.
 *
 * Ore is the fodder rather than spare weapons, and that is what finally gives the four
 * ore kinds a sink: they are gatherable from `oreNode` clusters in all three open worlds
 * (18+8 in Mondstadt, 18+14 in Dragonspine, 18+10 in Liyue), regrow on the 6 h
 * `REGROW_MS` window, and until now appeared in no recipe, no ascension cost and no route.
 * Mining was scenery with an inventory counter attached.
 */

/** One step of every ladder in this file: ore tier, and weapon rarity. */
const RARITY_STEP = 2;
/** XP in one chunk of the commonest ore. A unit of account; only ratios matter. */
export const WEAPON_ORE_BASE_XP = 1000;
/** A full climb on a 3-star weapon costs this many chunks of the commonest ore. */
export const WEAPON_CLIMB_ORE = 120;
/** Mora per xp, the rate `levelUpCharacter` charges for experience books. */
export const WEAPON_MORA_PER_XP = 0.2;
/**
 * The ore that can be fed to a weapon, cheapest first.
 *
 * The order *is* the tier: entry `i` is worth `RARITY_STEP ** i` base chunks. Iron is the
 * starter zone's ore, white iron and crystal sit in Liyue and Mondstadt, and starsilver
 * is only in Dragonspine, which is adventure-rank gated — so the ladder already has a
 * difficulty gate behind it and does not need a second one.
 */
export const WEAPON_ORE = ['ironChunk', 'whiteIronChunk', 'crystalChunk', 'starsilver'];

/** XP a single chunk of `oreId` is worth, or 0 if it is not weapon ore. */
export function oreXp(oreId) {
  const tier = WEAPON_ORE.indexOf(oreId);
  return tier < 0 ? 0 : WEAPON_ORE_BASE_XP * Math.pow(RARITY_STEP, tier);
}

/**
 * Hard level ceiling by rarity: a 3-star weapon stops at 70.
 *
 * Rarity previously bought nothing but a higher `baseAtk` and a better passive; with a
 * climb to spend ore on it also buys 20 more levels of it, which is what makes replacing
 * a 3-star you have invested in the right call rather than a sunk-cost trap.
 */
export const WEAPON_LEVEL_CAP = { 3: 70, 4: 90, 5: 90 };

export function weaponLevelCap(weapon) {
  const def = WEAPONS[weapon?.weaponId];
  return WEAPON_LEVEL_CAP[def?.rarity] ?? 90;
}

/**
 * The cap a given player may actually take this weapon to.
 *
 * Gated by `arCap` exactly as character level is. A fresh guest who happened to pull a
 * 5-star must not be able to mine it to 90 in the starter valley — and reusing `arCap`
 * rather than inventing a weapon-side gate is the lesson from `rankForLevel`: two rules
 * encoding the same pacing decision will disagree.
 */
export function weaponCapFor(weapon, adventureRank) {
  return Math.min(weaponLevelCap(weapon), arCap(adventureRank || 1));
}

/** Total xp a full 1 -> cap climb costs at this rarity. */
export function weaponClimbXp(rarity) {
  const r = WEAPON_LEVEL_CAP[rarity] ? rarity : 4;
  return WEAPON_CLIMB_ORE * WEAPON_ORE_BASE_XP * Math.pow(RARITY_STEP, r - 3);
}

/** XP to take a weapon of `rarity` from `level` to `level + 1`. */
export function weaponXpForLevel(rarity, level) {
  const cap = WEAPON_LEVEL_CAP[rarity] ?? 90;
  if (level >= cap) return 0;
  return Math.round(weaponClimbXp(rarity) * xpForLevel(level) / totalXpTo(cap));
}

/** XP already sunk into a weapon of `rarity` sitting at `level`. */
export function weaponXpToLevel(rarity, level) {
  let t = 0;
  for (let l = 1; l < level; l++) t += weaponXpForLevel(rarity, l);
  return t;
}

/**
 * Feed `xpGain` to a weapon, banking the remainder.
 *
 * Banking (rather than the artifact module's "whole levels only, surplus wasted") is not a
 * stylistic choice: the top levels cost around 90 000 xp and the commonest ore carries
 * 1 000, so without a bank a player mining iron would hand over chunk after chunk and get
 * nothing back forever. This is the same shape as `levelUpCharacter`, which banks into
 * `inst.xp` and zeroes it at the cap, and mora is likewise charged on xp *handed over*
 * rather than on levels gained.
 */
export function levelUpWeapon(weapon, xpGain, cap) {
  const def = WEAPONS[weapon.weaponId];
  const rarity = def?.rarity ?? 4;
  const out = { ...weapon };
  const from = out.level || 1;
  let level = from;
  let xp = (out.xp || 0) + xpGain;
  while (level < cap) {
    const need = weaponXpForLevel(rarity, level);
    if (xp < need) break;
    xp -= need;
    level++;
  }
  if (level >= cap) xp = 0;
  out.level = level;
  out.xp = xp;
  return {
    weapon: out, from, level, xp, levels: level - from,
    xpToNext: weaponXpForLevel(rarity, level), cap,
  };
}

/**
 * How much a passive is amplified at refinement rank `r`.
 *
 * `WEAPON_REFINE_MAX` ranks, and rank 5 doubles the passive — one authored statement, from
 * which the per-rank step falls out. Genshin's own weapons land a little under 2x at R5;
 * exactly 2x is chosen here because it makes the promise legible on the tooltip ("满精炼
 * 翻倍") instead of being a number the player has to measure.
 */
export const WEAPON_REFINE_MAX = 5;
export function refineMul(r) {
  const rank = Math.min(WEAPON_REFINE_MAX, Math.max(1, r || 1));
  return 1 + (rank - 1) / (WEAPON_REFINE_MAX - 1);
}

/**
 * Keys of a weapon passive that refinement must *not* scale.
 *
 * `element` is a string; `duration` and `stacks` are the shape of an effect rather than
 * its size, and doubling `stacks` from 2 to 4 is a different passive, not a stronger one.
 */
const REFINE_SKIP = new Set(['element', 'duration', 'stacks']);

export function refinePassive(passive, r) {
  if (!passive) return passive;
  const mul = refineMul(r);
  if (mul === 1) return passive;
  const out = {};
  for (const [k, v] of Object.entries(passive)) {
    out[k] = (REFINE_SKIP.has(k) || typeof v !== 'number') ? v : round4(v * mul);
  }
  return out;
}

/** Whether `fodder` may be fed to `target` to raise its refinement. */
export function canRefineWith(target, fodder) {
  if (!target || !fodder || target.uid === fodder.uid) return false;
  if (target.kind !== 'weapon' || fodder.kind !== 'weapon') return false;
  if (fodder.weaponId !== target.weaponId) return false;
  if (fodder.equippedBy || fodder.locked) return false;
  return (target.refinement || 1) < WEAPON_REFINE_MAX;
}

/**
 * The elements a bare `elementalDmg` passive covers: every element, but not physical.
 * "元素伤害提升 20%" on `dawnbreaker` means the elemental kinds; `forgeheartMaul` names
 * its own (`element: 'fire'`) and gets only that one.
 */
const ELEM_KEYS = ['fire', 'water', 'ice', 'lightning', 'wind', 'earth', 'light'];

/**
 * Fold the *unconditional* part of a weapon passive into a character's stat bonuses.
 *
 * `weaponPassive` was on the stats object from the beginning and read by nothing at all —
 * every weapon's `desc` in `items.js` described an effect the game did not have. Six of
 * the fifteen are plain always-on stat bonuses whose keys `addStat` already carries, and
 * those are applied here, which is also what makes `refinement` observable: refining a
 * 旅者之剑 to R3 moves its wielder's `typeBonus.normal` from 0.08 to 0.12 in the panel.
 *
 * The other nine need a trigger — 施放战技后, 击败敌人后, 受到伤害后, 瞄准命中弱点,
 * 对被冻结的敌人, 触发反应时 — and live in `shared/src/world/procs.js`, which hangs them
 * on the `player.buffs` array the simulation already expires every tick. They are
 * deliberately *not* faked as always-on here: a conditional bonus counted unconditionally
 * is worse than one that is missing, because it silently inflates every number
 * `balance-check` reports. That is also why the conditional keys are absent from `ZERO()`
 * — `addStat` drops them, so the only way to make one of them real is to write the
 * trigger, not to leak it into a stat.
 */
export const STATIC_PASSIVE_KEYS = Object.freeze([
  'normalDmg', 'chargedDmg', 'aimedDmg', 'skillDmg', 'burstDmg', 'healBonus', 'em',
  'elementalDmg',
]);

function applyStaticWeaponPassive(bonus, passive) {
  if (!passive) return;
  for (const key of STATIC_PASSIVE_KEYS) {
    if (key !== 'elementalDmg' && passive[key]) addStat(bonus, key, passive[key]);
  }
  if (passive.elementalDmg) {
    const keys = passive.element ? [passive.element] : ELEM_KEYS;
    for (const k of keys) addStat(bonus, k, passive.elementalDmg);
  }
}

/* --------------------------------------------------- character stat build -- */

const ZERO = () => ({
  hp: 0, atk: 0, def: 0, hpPct: 0, atkPct: 0, defPct: 0,
  critRate: 0, critDmg: 0, em: 0, er: 0, healBonus: 0,
  physical: 0, fire: 0, water: 0, ice: 0, lightning: 0, wind: 0, earth: 0, light: 0,
  normalDmg: 0, chargedDmg: 0, skillDmg: 0, burstDmg: 0, aimedDmg: 0,
  atkSpeed: 0, cdReduction: 0, shieldStrength: 0, dr: 0, defShred: 0,
});

/**
 * The stat keys a bonus block can carry. Exported so `tools/proc-check.mjs` can assert
 * the property that this whole family of bugs violated: every key written in `items.js`
 * is either one of these (folded in statically) or one `procs.js` triggers. A key in
 * neither list is a promise in a tooltip that nothing will ever pay.
 */
export const STAT_KEYS = Object.freeze(Object.keys(ZERO()));

function addStat(acc, key, value) {
  if (key === 'hp' || key === 'atk' || key === 'def') acc[key] += value;
  else if (acc[key] !== undefined) acc[key] += value;
}

/**
 * Build the effective combat stats of a character instance.
 * @param inst { charId, level, ascension, talents:{normal,skill,burst}, dupes,
 *               weapon, artifacts: {slot: artifact} }
 */
export function buildCharacterStats(inst) {
  const def = CHARACTERS[inst.charId];
  if (!def) return null;
  const level = inst.level || 1;
  const asc = inst.ascension || 0;
  const bonus = ZERO();

  const baseHp = statAtLevel(def.base.hp, level, asc);
  const baseAtk = statAtLevel(def.base.atk, level, asc) * 3.2; // character atk contribution
  const baseDef = statAtLevel(def.base.def, level, asc);

  // Ascension special stat
  if (asc >= 1 && def.ascensionStat) {
    const frac = Math.min(1, asc / 6);
    addStat(bonus, def.ascensionStat.key, def.ascensionStat.value * frac);
  }

  // Weapon
  let weaponAtk = 0;
  let weaponPassive = null;
  if (inst.weapon) {
    const ws = weaponStats(inst.weapon);
    weaponAtk = ws.atk;
    if (ws.sub) addStat(bonus, ws.sub.key, ws.sub.value);
    weaponPassive = ws.passive || null;
    applyStaticWeaponPassive(bonus, weaponPassive);
  }

  // Artifacts
  const setCount = {};
  for (const slot of ARTIFACT_SLOTS) {
    const art = inst.artifacts && inst.artifacts[slot];
    if (!art) continue;
    setCount[art.setId] = (setCount[art.setId] || 0) + 1;
    addStat(bonus, art.main.key, art.main.value);
    for (const s of art.subs) addStat(bonus, s.key, s.value);
  }
  const activeSets = [];
  for (const [setId, count] of Object.entries(setCount)) {
    const set = ARTIFACT_SETS[setId];
    if (!set) continue;
    if (count >= 2) { for (const [k, v] of Object.entries(set.two)) addStat(bonus, k, v); activeSets.push({ setId, pieces: 2 }); }
    if (count >= 4) {
      // `fourIf` is the set's own precondition. 角斗士的终幕礼 says "装备单手剑/双手剑/
      // 长柄武器时", and for as long as nothing checked that, a catalyst user got the
      // +35 % normal damage anyway — a condition printed in the tooltip and enforced
      // nowhere, which is the same defect as a passive nothing reads, just inverted.
      const ok = !set.fourIf?.weaponType || set.fourIf.weaponType.includes(def.weapon);
      if (ok) for (const [k, v] of Object.entries(set.four)) addStat(bonus, k, v);
      activeSets[activeSets.length - 1].pieces = 4;
      activeSets[activeSets.length - 1].fourActive = ok;
    }
  }

  // Duplicates (constellation-like)
  const dupe = dupeBonus(inst.dupes || 0);
  addStat(bonus, 'atkPct', dupe.atkPct);
  addStat(bonus, 'critRate', dupe.critRate);
  addStat(bonus, 'cdReduction', dupe.cdReduction);

  // Passive talent
  if (def.passive) {
    if (def.passive.bonus) for (const [k, v] of Object.entries(def.passive.bonus)) addStat(bonus, k, v);
    if (def.passive.atkSpeed) addStat(bonus, 'atkSpeed', def.passive.atkSpeed);
  }

  const maxHp = Math.round(baseHp * (1 + bonus.hpPct) + bonus.hp);
  const atk = Math.round((baseAtk + weaponAtk) * (1 + bonus.atkPct) + bonus.atk);
  const defence = Math.round(baseDef * (1 + bonus.defPct) + bonus.def);

  return {
    charId: inst.charId, level, ascension: asc,
    maxHp, atk, def: defence,
    critRate: def.base.critRate + bonus.critRate,
    critDmg: def.base.critDmg + bonus.critDmg,
    em: def.base.em + bonus.em,
    er: def.base.er + bonus.er,
    // 潮汐共鸣: "生命值上限每 1000 点提升 2% 治疗加成" — a static talent, but one that
    // depends on a stat computed above, which is why it lands here rather than in the
    // bonus block. It was written in `characters.js` and read by nothing.
    healBonus: bonus.healBonus + (def.passive?.healPerHp ? (maxHp / 1000) * def.passive.healPerHp : 0),
    elemBonus: {
      physical: bonus.physical, fire: bonus.fire, water: bonus.water, ice: bonus.ice,
      lightning: bonus.lightning, wind: bonus.wind, earth: bonus.earth, light: bonus.light,
    },
    typeBonus: {
      normal: bonus.normalDmg, charged: bonus.chargedDmg, skill: bonus.skillDmg,
      burst: bonus.burstDmg, aimed: bonus.aimedDmg,
    },
    atkSpeed: 1 + bonus.atkSpeed,
    cdReduction: bonus.cdReduction,
    shieldStrength: bonus.shieldStrength,
    dr: bonus.dr,
    // Conditional talent values the simulation reads where the condition can be judged:
    // `shieldDR` in `PlayerEntity.takeDamage` (it knows whether a shield is up),
    // `lowHpDef` in `procs.liveStats`, `overhealShield` wherever a heal overflows.
    shieldDR: def.passive?.shieldDR || 0,
    lowHpDef: def.passive?.lowHpDef || 0,
    overhealShield: def.passive?.overhealShield || 0,
    talentMul: {
      normal: talentScale(inst.talents?.normal || 1),
      skill: talentScale(inst.talents?.skill || 1),
      burst: talentScale(inst.talents?.burst || 1),
    },
    activeSets, weaponPassive, raw: bonus,
    // `procs.js` needs the weapon's identity to name the buff it grants, and the panel
    // uses it to caption the passive line.
    weaponId: inst.weapon?.weaponId || null,
    element: def.element, weaponType: def.weapon,
  };
}

/* -------------------------------------------------------------- resonance -- */

/**
 * Fold the party's 元素共鸣 into the stat blocks of the characters standing in it.
 *
 * Resonance is the only bonus in the game that is not a property of one character, so it
 * cannot live in `buildCharacterStats` — that function is handed one instance and has no
 * idea who else is on the team. It lands here instead, one layer up, where the party list
 * is known, and it lands on **exactly** the characters in the party: a benched character's
 * numbers must not move, or the panel would credit a build with a bonus it does not have.
 *
 * Six of the eight fields are folded into the block (so every existing consumer — damage,
 * heals, cooldowns, shields, `takeDamage` — reads them with no new code), and the whole
 * active list rides along as `st.resonance`, which is both what `procs.gearProcs` treats
 * as a fourth effect source and what the UI captions the team screen with.
 */
export function applyPartyResonance(stats, party = []) {
  const active = partyResonances(party);
  if (!active.length) return stats;
  const mods = {};
  for (const r of active) {
    for (const [k, v] of Object.entries(r.effect)) {
      if (typeof v === 'number') mods[k] = (mods[k] || 0) + v;
    }
  }
  const sources = active.map((r) => ({
    id: `r:${r.id}`, name: r.name, hint: resonanceHint(r), e: r.effect,
  }));
  const inParty = new Set(party);
  const out = {};
  for (const [charId, s] of Object.entries(stats)) {
    if (!s || !inParty.has(charId)) { out[charId] = s; continue; }
    out[charId] = {
      ...s,
      atk: mods.atkPct ? Math.round(s.atk * (1 + mods.atkPct)) : s.atk,
      em: s.em + (mods.em || 0),
      healBonus: s.healBonus + (mods.healBonus || 0),
      cdReduction: s.cdReduction + (mods.cdReduction || 0),
      shieldStrength: s.shieldStrength + (mods.shieldStrength || 0),
      dr: s.dr + (mods.dr || 0),
      resonance: sources,
    };
  }
  return out;
}

/**
 * Every owned character's stats, with the party's resonance folded in.
 *
 * The one function all three stat-building paths call — the gateway handshake and
 * `publishStats` on the server, `_refreshStats` in the browser's 单机 host. They used to
 * each run their own `buildCharacterStats` loop, and a party-level bonus added to one of
 * those loops and not the others would be a balance fork between 单机 and 联机.
 */
export function partyStats(characters = {}, party = []) {
  const out = {};
  for (const [charId, inst] of Object.entries(characters)) {
    const s = buildCharacterStats(inst);
    if (s) out[charId] = s;
  }
  return applyPartyResonance(out, party);
}

/* ------------------------------------------------------------------ wishes -- */

/**
 * Where the 5★ rate stops being the published rate.
 *
 * Exported because two places have to agree about it: `pullWish` rolls with it, and the
 * wish panel *prints* it. A banner that says 「五星基础概率 0.60%」 to a player sitting on
 * 80 pity is quoting a number the simulation stopped using six pulls ago.
 */
export const SOFT_PITY = { start: 74, step: 0.06 };

/**
 * The 5★ chance of pull number `n` since the last one (1-based, so the pull about to
 * happen at `pity5 = 79` is `n = 80`).
 *
 * Takes the flat `{ rate, pity }` descriptor rather than a pool, because that is the shape
 * `GET /api/wish/pools` publishes — the client computing this from the server's own numbers
 * is what keeps the printed curve and the rolled curve the same curve.
 */
export function wishRate5({ rate = 0.006, pity = 90 } = {}, n = 1) {
  const k = Math.max(1, Math.floor(n));
  if (k >= pity) return 1;
  const r = k >= SOFT_PITY.start ? rate + (k - SOFT_PITY.start + 1) * SOFT_PITY.step : rate;
  return Math.min(1, r);
}

/**
 * Wish change: what one pull hands back besides the item.
 *
 * The hole this closes: a 5★ character already at C6 used to give *nothing at all*. The
 * grant clamped `dupes` to 6, no constellation moved, no currency existed to receive the
 * overflow — so the single luckiest outcome in the game was also the emptiest, and the same
 * was true of the 170th 三星武器. Now every pull pays out, and the payout is the only thing
 * that makes 派蒙的十日谈's 星辉/星尘 counters buyable.
 *
 * The two maxed rates are *derived* from the shop price rather than typed next to it: a 4★
 * that can no longer raise its constellation returns `GLITTER_PER_WISH` — exactly the pull
 * it cost — and a 5★ returns five pulls' worth. The base rates are the floor, deliberately
 * well under the price so ordinary pulling is a slow rebate and not an income.
 */
export const WISH_CONVERSION = {
  3: { stardust: 15 },
  4: { starglitter: 2 },
  5: { starglitter: 10 },
  maxed: { 4: { starglitter: GLITTER_PER_WISH }, 5: { starglitter: 5 * GLITTER_PER_WISH } },
};

/**
 * @param result   one entry of `pullWish().result`
 * @param grant    what the grant said happened: `{ dupe, dupes, capped }` for a character,
 *                 nothing for a weapon. `capped` means the duplicate could not raise the
 *                 constellation — that is the case worth paying extra for, and it is a fact
 *                 only the store knows, which is why it is passed in rather than inferred.
 * @returns an item map to add to the inventory (never null; always at least one entry).
 */
export function wishConversion(result, grant = {}) {
  const r = result?.rarity ?? 3;
  const maxed = !!grant.capped && result?.type === 'character';
  return { ...((maxed ? WISH_CONVERSION.maxed[r] : null) || WISH_CONVERSION[r] || WISH_CONVERSION[3]) };
}

/** Sum a list of conversion maps into one, for a ten-pull's total. */
export function sumConversion(maps) {
  const out = {};
  for (const m of maps || []) for (const [k, v] of Object.entries(m || {})) out[k] = (out[k] || 0) + v;
  return out;
}

/**
 * Resolve a wish pull. Mutates and returns updated pity counters.
 * @param state { pity5, pity4, guaranteed5, guaranteed4, total }
 */
export function pullWish(poolId, state, seed) {
  const pool = WISH_POOL[poolId] || WISH_POOL.standard;
  const rand = new Rand(seed >>> 0);
  const s = {
    pity5: state.pity5 || 0, pity4: state.pity4 || 0,
    guaranteed5: !!state.guaranteed5, guaranteed4: !!state.guaranteed4,
    total: state.total || 0,
  };
  s.pity5++; s.pity4++; s.total++;

  // Soft pity from 74, hard pity at 90 — the curve itself lives in `wishRate5` so the
  // panel can print the number this line is about to roll against.
  const rate5 = wishRate5(pool.fiveStar, s.pity5);
  const hit5 = s.pity5 >= pool.fiveStar.pity || rand.chance(rate5);
  const hit4 = !hit5 && (s.pity4 >= pool.fourStar.pity || rand.chance(pool.fourStar.rate));

  let result;
  if (hit5) {
    s.pity5 = 0; s.pity4 = Math.min(s.pity4, pool.fourStar.pity - 1);
    if (pool.featuredFive) {
      const win = s.guaranteed5 || rand.chance(pool.fiveStar.featuredChance ?? 0.5);
      if (win) { result = char5(pool.featuredFive); s.guaranteed5 = false; }
      else {
        const others = pool.fiveStar.chars.filter((c) => c !== pool.featuredFive);
        result = char5(rand.pick(others.length ? others : pool.fiveStar.chars));
        s.guaranteed5 = true;
      }
    } else {
      const all = [...pool.fiveStar.chars.map((c) => ({ t: 'char', id: c })),
                   ...pool.fiveStar.weapons.map((w) => ({ t: 'weapon', id: w }))];
      const pick = rand.pick(all);
      result = pick.t === 'char' ? char5(pick.id) : wpn(pick.id, 5);
    }
  } else if (hit4) {
    s.pity4 = 0;
    const four = pool.fourStar;
    const feat = pool.featuredFour || null;
    if (feat?.length) {
      // The 4★ twin of 大保底, and the consumer `featuredChance`/`guaranteed4` were missing:
      // the branch used to pick uniformly from `fourStar.chars`, so the rate-up the banner
      // advertises was decided by whatever happened to be in that array.
      const win = s.guaranteed4 || rand.chance(four.featuredChance ?? 0.5);
      if (win) {
        s.guaranteed4 = false;
        result = char4(rand.pick(feat));
      } else {
        s.guaranteed4 = true;
        const others = four.chars.filter((c) => !feat.includes(c));
        const useChar = others.length > 0 && (four.weapons.length === 0 || rand.chance(0.55));
        result = useChar ? char4(rand.pick(others)) : wpn(rand.pick(four.weapons), 4);
      }
    } else {
      const useChar = four.weapons.length === 0 || rand.chance(0.55);
      result = useChar ? char4(rand.pick(four.chars)) : wpn(rand.pick(four.weapons), 4);
    }
  } else {
    result = wpn(rand.pick(pool.threeStar.weapons), 3);
  }
  return { result, state: s };
}

function char5(id) { return { type: 'character', id, rarity: CHARACTERS[id]?.rarity ?? 5, name: CHARACTERS[id]?.name ?? id }; }
function char4(id) { return { type: 'character', id, rarity: CHARACTERS[id]?.rarity ?? 4, name: CHARACTERS[id]?.name ?? id }; }
function wpn(id, rarity) { return { type: 'weapon', id, rarity, name: WEAPONS[id]?.name ?? id }; }

/** Gathering nodes give materials per zone. */
export function rollGather(kind, seed) {
  const rand = new Rand(seed >>> 0);
  return { [kind]: rand.int(1, 3) };
}
