// Combat balance audit: is the content actually beatable by the player who is
// allowed to walk into it?
//
//   node tools/balance-check.mjs            # table + verdicts
//   node tools/balance-check.mjs --verbose  # per-enemy detail rows
//
// No server, no browser: the damage pipeline in `shared/src/sim/formulas.js` is the
// same code the gateway runs, so the numbers here are the numbers in the game. What
// this file adds is the *cadence* the server imposes, which is where a "big number"
// turns into a DPS:
//
//   player  — `handleAttack` rate-limits normal attacks to `normal.frameTime * 0.85`
//             and walks the combo array, so sustained normal DPS is
//             mean(hits) * talentMul / (frameTime * 0.85), not hits[0] on demand.
//             Skills come off cooldown; a burst needs 60 energy, and energy only
//             arrives at 0.8 per physical hit / 2.4 per elemental hit
//             (`playerHitEnemy`), so its real period is max(cd, 60/income).
//   enemy   — `updateEnemy` runs windup -> active -> recover and only *then* starts
//             `attackCd`, so a hilichurl's 1.6 s cooldown is really a 2.73 s cycle.
//             Multi-tick moves land every `active/ticks` seconds inside one cycle.
//
// Both sides are then put through the real mitigation: `defMultiplier` for the
// player's hits, and the mirrored `(lv+100)/(lv+100+def*1.4)` from `damagePlayer`
// for the enemy's. Party HP is pooled because `Entity.takeDamage` auto-swaps to the
// next living character instead of downing the player.
//
// Deliberately optimistic for the player: every hit connects, nothing is dodged,
// no time is spent walking between enemies, and enemy shields are counted as plain
// HP. Deliberately pessimistic too: no reactions, no food, no artifact sets beyond
// what `--gear` asks for. A margin of 1.0 therefore means "would lose while playing
// perfectly", not "close fight" -- that is why the thresholds below sit well above 1.
//
// Exit code is the number of failed verdicts.

import { CHARACTERS, STARTER_PARTY, talentScale } from '../shared/src/data/characters.js';
import { ENEMIES, ATTACK_MOVES, AI } from '../shared/src/data/enemies.js';
import { ZONES, DOMAIN_RESIN, gatherNodes, chamberEnemies, CHAMBER_WAVE_GAP, chamberStars } from '../shared/src/data/zones.js';
import { DISORDERS, disorderById, disorderHint } from '../shared/src/data/disorders.js';
import { WEAPONS } from '../shared/src/data/items.js';
import { QUESTS } from '../shared/src/data/quests.js';
import {
  computeDamage, defMultiplier, resMultiplier, enemyStatAtLevel, xpForLevel, chamberXp,
  arCap, rankForLevel,
} from '../shared/src/sim/formulas.js';
import {
  buildCharacterStats, generateArtifact, makeWeapon, enemyXp,
  weaponStats, weaponXpToLevel, oreXp, WEAPON_ORE, WEAPON_LEVEL_CAP, WEAPON_MORA_PER_XP,
} from '../shared/src/sim/loot.js';

const VERBOSE = process.argv.includes('--verbose');

let fails = 0, passes = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; console.log(`ok   ${name}${detail ? '  ' + detail : ''}`); } else {
    fails++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`);
  }
  return !!ok;
}

const WEAPON_FOR = {
  sword: 'travelersBlade', claymore: 'ironGreatsword', bow: 'huntersBow',
  polearm: 'ironSpear', catalyst: 'apprenticeTome',
};

/* --------------------------------------------------------------- the player -- */

/**
 * Build a party the way the game would have built it at a given point.
 *
 * `gear` is the honest variable: a fresh account has level-1 weapons and no
 * artifacts (see `createAccount`), a player who has been playing has both, and the
 * difference between those two is larger than any level difference.
 *
 * `weaponLevel = level` is the assumption every verdict below rests on, and for a long
 * time it was a fiction: weapons were minted at level 1 and no route could raise them,
 * so a level-90 party really had 76 % of the attack this audit credited it with. Section
 * 8 is what keeps the default honest — it asks whether the ore the world actually grows
 * pays for weapons at party level, because an audit that grades the game on gear the
 * game never hands out reports margins nobody can reach.
 */
function party({ chars, level, ascension = 0, talents = 1, weaponLevel = level, artifacts = 0 }) {
  return chars.map((charId, i) => {
    const def = CHARACTERS[charId];
    const inst = {
      charId, level, ascension,
      talents: { normal: talents, skill: talents, burst: talents },
      weapon: makeWeapon(WEAPON_FOR[def.weapon], weaponLevel),
      artifacts: {},
    };
    for (let s = 0; s < artifacts; s++) {
      // Fixed seeds: an audit that moves when nothing changed is not an audit.
      const art = generateArtifact(level, 1000 + i * 97 + s * 13, level >= 40 ? 5 : 4);
      inst.artifacts[art.slot] = art;
    }
    return buildCharacterStats(inst);
  });
}

const critEV = (st) => 1 + Math.min(1, st.critRate) * st.critDmg;

/**
 * Sustained single-target DPS of one character against one enemy.
 *
 * `mods` is a 地脉异常 (`shared/src/data/disorders.js`), folded in exactly where
 * `playerHitEnemy` folds it in: `enemyRes` shifts the target's resistance and
 * `playerElemBonus` is added to the same sum as the build's own elemental bonus. What is
 * *not* modelled is `reactionBonus`, because this audit models no reactions at all — a
 * floor whose disorder pays for reactions is therefore read pessimistically, and the
 * chamber section says so out loud.
 */
function charDps(st, eDef, eLevel, { active = true, mods = null } = {}) {
  const def = CHARACTERS[st.charId];
  const atk = st.atk;
  const ev = critEV(st);
  const dmul = defMultiplier(st.level, eLevel);
  const rmul = (element) => resMultiplier((eDef.res?.[element] ?? 0.1) + (mods?.enemyRes?.[element] || 0));
  const zbonus = (element) => (mods?.playerElemBonus?.[element] || 0);

  // Normals: only the on-field character throws them.
  const hits = def.normal.hits;
  const meanHit = hits.reduce((a, b) => a + b, 0) / hits.length;
  const period = def.normal.frameTime * 0.85 / (st.atkSpeed || 1);
  const nElem = def.normal.element || 'physical';
  const nBonus = 1 + (st.elemBonus?.[nElem] || 0) + (st.typeBonus?.normal || 0) + zbonus(nElem);
  const normal = active
    ? meanHit * st.talentMul.normal * atk * nBonus * ev * dmul * rmul(nElem) / period
    : 0;

  // Skill: off cooldown, all its ticks inside one cast.
  const sk = def.skill;
  const skTicks = sk.lingering ? 1 + Math.floor(sk.lingering.duration / sk.lingering.interval) : 1;
  const skPerCast = (sk.mult + (sk.lingering ? sk.lingering.tickMult * (skTicks - 1) : 0))
    * st.talentMul.skill * atk * (1 + (st.elemBonus?.[sk.element] || 0) + (st.typeBonus?.skill || 0) + zbonus(sk.element))
    * ev * dmul * rmul(sk.element);
  const skCd = sk.cd * (1 - (st.cdReduction || 0));
  const skill = skPerCast / skCd;

  // Burst: gated by energy, not just cooldown. Income is what `playerHitEnemy`
  // grants -- 2.4 per elemental hit, 0.8 per physical -- times ER, and off-field
  // characters bank it at 60 %.
  const bu = def.burst;
  const hitRate = active ? 1 / period : 0;
  const energyPerSec = ((nElem === 'physical' ? 0.8 : 2.4) * hitRate + 2.4 / skCd)
    * (st.er || 1) * (active ? 1 : 0.6);
  const buPeriod = Math.max(bu.cd * (1 - (st.cdReduction || 0)),
    energyPerSec > 0 ? bu.cost / energyPerSec : Infinity);
  const buPerCast = bu.mult * (bu.ticks || 1) * st.talentMul.burst * atk
    * (1 + (st.elemBonus?.[bu.element] || 0) + (st.typeBonus?.burst || 0) + zbonus(bu.element))
    * ev * dmul * rmul(bu.element);
  const burst = Number.isFinite(buPeriod) ? buPerCast / buPeriod : 0;

  return { normal, skill, burst, total: normal + skill + burst };
}

/**
 * Party DPS. Genshin-style rotation: the on-field character does normals, and
 * everyone else contributes skill+burst as they are swapped in. The floor is one
 * character alone -- which is how most players actually fight a single slime.
 */
function partyDps(sts, eDef, eLevel, mods = null) {
  const solo = charDps(sts[0], eDef, eLevel, { mods }).total;
  let rot = solo;
  for (const st of sts.slice(1)) rot += charDps(st, eDef, eLevel, { active: false, mods }).total;
  return { solo, rot };
}

/* ---------------------------------------------------------------- the enemy -- */

/** Sustained DPS of one enemy against the party's on-field character. */
function enemyDps(eDef, eLevel, st) {
  const atk = enemyStatAtLevel(eDef.base.atk, eLevel);
  const moves = eDef.attacks?.length
    ? eDef.attacks
    : [eDef.ai === AI.ranged ? 'basicRanged' : eDef.ai === AI.caster ? 'basicCast' : 'basic'];
  // Mirror of `damagePlayer`: the player's own defence, no res, times the same 1.4.
  const mitig = (st.level + 100) / (st.level + 100 + (st.def || 100) * 1.4);
  let sum = 0;
  for (const key of moves) {
    const mv = ATTACK_MOVES[key];
    if (!mv) continue;
    const cycle = (mv.windup || 0) + (mv.active || 0.2) + (mv.recover || 0.5) + eDef.attackCd;
    const perCycle = atk * (mv.mult || 0) * (mv.ticks || 1);
    sum += perCycle * mitig * (1 - (st.dr || 0)) / cycle;
  }
  return sum / moves.length;
}

const enemyEffHp = (eDef, eLevel) =>
  enemyStatAtLevel(eDef.base.hp, eLevel) + (eDef.shield ? enemyStatAtLevel(eDef.shield.hp, eLevel) : 0);

/* ------------------------------------------------------------- the scenario -- */

/**
 * Fight a wave. Enemies are killed one at a time (no AoE credit) while *all* of
 * them attack, which is what a camp or a chamber actually does.
 */
function wave(sts, list, eLevel, mods = null) {
  const partyHp = sts.reduce((a, s) => a + s.maxHp, 0);
  let hp = 0, dpsIn = 0, ttk = 0;
  const rows = [];
  for (const id of list) {
    const eDef = ENEMIES[id];
    if (!eDef) continue;
    const ehp = enemyEffHp(eDef, eLevel) * (mods?.enemyHpMul || 1);
    const out = partyDps(sts, eDef, eLevel, mods);
    const din = enemyDps(eDef, eLevel, sts[0]) * (mods?.enemyDmgMul || 1);
    hp += ehp;
    dpsIn += din;
    ttk += ehp / out.rot;
    rows.push({ id, name: eDef.name, ehp, dpsOut: out.rot, solo: out.solo, dpsIn: din, ttk: ehp / out.rot });
  }
  // Time to die shortens as nothing dies: use the full incoming DPS for the whole
  // fight, which is the pessimistic-for-the-player reading and the honest one for a
  // ranged pack that never stops shooting.
  const ttd = partyHp / dpsIn;
  return { rows, partyHp, hp, dpsIn, ttk, ttd, margin: ttd / ttk };
}

/**
 * A whole chamber floor: several waves, one after the other, under one disorder.
 *
 * Waves change the arithmetic and not just the amount of content, which is the reason to
 * model them rather than flatten them. In one big pack every enemy shoots for the whole
 * fight, so `wave()` charges the party the full incoming DPS from the first second. Split
 * the same pack in two and the second half is not attacking while the first half is being
 * killed — so the honest cost of a floor is the damage *taken*, summed wave by wave, against
 * one pooled party health bar. Flattening would have reported a harder floor than the game
 * runs, and derived star thresholds nobody could reach.
 *
 * The gaps between waves are dead time: no damage, but the clock keeps running, so they are
 * part of the clear time the thresholds are measured against.
 */
function floorFight(sts, c) {
  const mods = disorderById(c.disorder);
  const waves = c.waves.map((list) => wave(sts, list, c.level, mods));
  const partyHp = waves[0].partyHp;
  const gaps = CHAMBER_WAVE_GAP * (waves.length - 1);
  const ttk = waves.reduce((a, w) => a + w.ttk, 0) + gaps;
  const taken = waves.reduce((a, w) => a + w.dpsIn * w.ttk, 0);
  const hp = waves.reduce((a, w) => a + w.hp, 0);
  // Reported as an average so the printed columns keep meaning what they meant: `die` is
  // still "how long the party survives at this rate", now over the whole run.
  const dpsIn = taken / Math.max(0.001, ttk - gaps);
  return {
    rows: waves.flatMap((w) => w.rows), partyHp, hp, dpsIn, ttk,
    ttd: partyHp / dpsIn, margin: partyHp / Math.max(1, taken), waves, gaps, mods,
  };
}

function fmt(n, d = 1) {
  if (!Number.isFinite(n)) return '∞';
  return n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(d);
}

function report(label, w, extra = '') {
  console.log(`  ${label.padEnd(30)} hp ${String(fmt(w.hp, 0)).padStart(7)}`
    + `  kill ${fmt(w.ttk).padStart(6)}s  die ${fmt(w.ttd).padStart(6)}s`
    + `  margin ${fmt(w.margin, 2).padStart(5)}x${extra}`);
  if (VERBOSE) {
    for (const r of w.rows) {
      console.log(`      ${r.name.padEnd(8)} hp ${String(fmt(r.ehp, 0)).padStart(7)}`
        + `  out ${fmt(r.dpsOut, 0).padStart(6)} (solo ${fmt(r.solo, 0)})`
        + `  in ${fmt(r.dpsIn, 0).padStart(5)}  ttk ${fmt(r.ttk).padStart(6)}s`);
    }
  }
}

/* ------------------------------------------------------- 1. the fresh player -- */

console.log('\n=== fresh account (2 starters, level 1, level-1 weapons, no artifacts)');
const fresh = party({ chars: STARTER_PARTY.slice(0, 2), level: 1, weaponLevel: 1 });
console.log(`  party hp ${fmt(fresh.reduce((a, s) => a + s.maxHp, 0), 0)}`
  + `  atk ${fresh.map((s) => fmt(s.atk, 0)).join('/')}`
  + `  def ${fresh.map((s) => fmt(s.def, 0)).join('/')}`);

const mondCamps = ZONES.mondstadt.spawns;
const firstCamp = mondCamps.reduce((a, b) => (a.level <= b.level ? a : b));
const freshFirst = wave(fresh, firstCamp.enemies, firstCamp.level);
report(`first camp (lv ${firstCamp.level})`, freshFirst);
// A brand-new player fighting the *easiest* camp in the game has to win, and win
// with room to spare, because they have no dodge skill yet and no food.
check('fresh player beats the easiest camp', freshFirst.margin >= 2.0,
  `margin ${fmt(freshFirst.margin, 2)}x (kill ${fmt(freshFirst.ttk)}s, die ${fmt(freshFirst.ttd)}s)`);
check('fresh player kills the first camp in under a minute', freshFirst.ttk <= 60,
  `${fmt(freshFirst.ttk)}s`);

const freshSingle = wave(fresh, [firstCamp.enemies[0]], firstCamp.level);
check('fresh player kills one starter enemy in under 20 s', freshSingle.ttk <= 20,
  `${fmt(freshSingle.ttk)}s for ${ENEMIES[firstCamp.enemies[0]].name} lv ${firstCamp.level}`);

/* ------------------------------------------- 2. the open-world level ladder -- */

/**
 * The party a player plausibly has when the content is at `level`.
 *
 * Parity is the design contract everywhere in this game: a camp is tagged with a
 * level, and the player who fights it is expected to be about that level with gear
 * to match. Ascension follows `ASCENSION_CAPS`, talents follow what the ascension
 * allows, and the artifact count is the one honest guess in here -- five pieces from
 * level 20 up, two before that, none on a brand-new account.
 */
function parityParty(level, { weaponLevel = level } = {}) {
  return party({
    chars: STARTER_PARTY.slice(0, level >= 20 ? 4 : 2),
    level,
    ascension: level > 80 ? 6 : level > 70 ? 5 : level > 60 ? 4
      : level > 50 ? 3 : level > 40 ? 2 : level > 20 ? 1 : 0,
    talents: Math.min(10, 1 + Math.floor(level / 12)),
    weaponLevel,
    artifacts: level >= 20 ? 5 : level >= 10 ? 2 : 0,
  });
}

for (const zoneId of ['mondstadt', 'dragonspine', 'liyue']) {
  const z = ZONES[zoneId];
  console.log(`\n=== ${z.name} (${zoneId}) camps, player at parity`);
  let worst = { margin: Infinity };
  for (const camp of z.spawns) {
    const w = wave(parityParty(camp.level), camp.enemies, camp.level);
    report(`lv ${camp.level}${camp.elite ? ' elite' : ''} ${camp.enemies.length}x`, w);
    if (w.margin < worst.margin) worst = { margin: w.margin, level: camp.level, camp };
  }
  check(`${zoneId}: every camp winnable at level parity`, worst.margin >= 1.2,
    `worst margin ${fmt(worst.margin, 2)}x at lv ${worst.level} (${worst.camp?.enemies.join(', ')})`);
}

/* ------------------------------------------------------------ 3. the levels -- */

// A chamber has a hard contract the open world does not: the waves must die inside
// `timeLimit`, and the star thresholds are only reachable if they die a lot faster.
//
// Each floor is judged at parity with *its own* level, not with the dungeon's single
// `recommendedLevel`: abyssTrial is tagged 20 but runs from level 18 to level 80
// across eight floors, and floors unlock one at a time behind a star on the previous
// one, so the eighth floor is content for a level-80 party by construction.
//
// The star check is two-sided, which is the whole reason this section was rewritten. It
// used to ask only "is three stars reachable?", and every floor answered yes with a parity
// party using 5–25 % of its time limit: a one-sided check on a threshold nobody could miss.
// Reachable *and not free* is the pair of bounds that actually pins a rating, and both ends
// are expressed as multiples of this audit's own measured clear time — a threshold in
// seconds authored by hand is a constant guessing at a curve.
//
//   3★ must sit at or above 1.15x the theoretical clear (or a perfect rotation misses it)
//   3★ must sit at or below 2.00x it       (or a run twice as slow as optimal still gets it)
//
// `--stars` prints the thresholds those bounds imply for each floor, which is how the
// numbers in `zones.js` were derived.
const STAR_MIN = 1.15, STAR_MAX = 2.0;
const SUGGEST = process.argv.includes('--stars');
for (const zoneId of Object.keys(ZONES).filter((z) => ZONES[z].kind === 'dungeon')) {
  const z = ZONES[zoneId];
  console.log(`\n=== ${z.name} (${zoneId}) chambers, player at parity per floor`);
  let worstTime = 0, worstFloor = null, worstMargin = Infinity, marginFloor = null;
  let worstStars = 3, freeStars = [], tightStars = [];
  for (const c of z.chambers) {
    const w = floorFight(parityParty(c.level), c);
    const frac = w.ttk / c.timeLimit;
    const stars = chamberStars(c, w.ttk);
    const dz = disorderById(c.disorder);
    report(`floor ${c.floor} (lv ${c.level})`, w,
      `  limit ${c.timeLimit}s -> ${(frac * 100).toFixed(0)}%  stars ${stars}`);
    console.log(`      ${c.waves.length} waves (${c.waves.map((x) => x.length).join('+')})`
      + `  ${dz ? `${dz.name}: ${disorderHint(dz)}` : '无地脉异常'}`
      + `${dz?.reactionBonus ? '  [reaction bonus not modelled -> read pessimistically]' : ''}`);
    if (SUGGEST) {
      const round5 = (v) => Math.round(v / 5) * 5;
      console.log(`      suggest stars [${round5(w.ttk * 3.2)}, ${round5(w.ttk * 2.2)},`
        + ` ${round5(w.ttk * 1.5)}]  timeLimit ${Math.ceil(w.ttk * 4.5 / 30) * 30}`);
    }
    if (frac > worstTime) { worstTime = frac; worstFloor = c.floor; }
    if (w.margin < worstMargin) { worstMargin = w.margin; marginFloor = c.floor; }
    worstStars = Math.min(worstStars, stars);
    if (c.stars[2] > w.ttk * STAR_MAX) freeStars.push(`${c.floor} (${c.stars[2]}s vs ${fmt(w.ttk)}s)`);
    if (c.stars[2] < w.ttk * STAR_MIN) tightStars.push(`${c.floor} (${c.stars[2]}s vs ${fmt(w.ttk)}s)`);
  }
  check(`${zoneId}: every floor clearable inside its time limit`, worstTime <= 1,
    `worst floor ${worstFloor} uses ${(worstTime * 100).toFixed(0)}% of the limit`);
  check(`${zoneId}: every floor survivable at parity`, worstMargin >= 1.0,
    `worst margin ${fmt(worstMargin, 2)}x on floor ${marginFloor}`);
  check(`${zoneId}: three stars reachable at parity on every floor`,
    worstStars >= 3 && !tightStars.length,
    tightStars.length ? `too tight: floor ${tightStars.join(', ')}` : `worst floor scores ${worstStars}`);
  check(`${zoneId}: three stars is not free`, !freeStars.length,
    freeStars.length ? `floor ${freeStars.join(', ')} allows ${STAR_MAX}x the optimal clear`
      : `every 3★ threshold is inside ${STAR_MIN}–${STAR_MAX}x the optimal clear`);
}

/* --------------------------------------------------- 4. can the player get there -- */

// Everything above assumes parity. Whether parity is *reachable* is a different
// question, and it is the one that decides whether the late zones exist for anyone:
// character levels come from xp, and this walks every xp source the game actually
// has, in the order a player meets them.
//
//   starting inventory  10 adventurerXp + 2 heroWit          (repo.createAccount)
//   story quests        `rewards.items` books + `rewards.xp`  (QUESTS)
//   chests              one xp-book roll each, on average     (rollChest)
//   kills               `rollEnemyLoot().xp` to the party, 35 % of it to AR
//   chamber clears      `chamberXp`, scaled to the floor's level
//
// Books are the dominant term and they are finite, so the interesting number at the
// end is not the level but how much *repeatable* content the remaining levels cost.
const BOOK_XP = { adventurerXp: 5000, heroWit: 20000 };

function economy() {
  let arXp = 0, charXp = 0, charLevel = 1;
  const arLevel = () => {
    let lv = 1, rest = arXp;
    while (lv < 90 && rest >= xpForLevel(lv)) { rest -= xpForLevel(lv); lv++; }
    return lv;
  };
  const cap = () => arCap(arLevel());
  const drain = () => {
    while (charLevel < cap() && charXp >= xpForLevel(charLevel)) {
      charXp -= xpForLevel(charLevel); charLevel++;
    }
  };
  const addChar = (n) => { charXp += n; drain(); };
  const addAr = (n) => { arXp += n; drain(); };
  return {
    get level() { return charLevel; },
    get ar() { return arLevel(); },
    get cap() { return cap(); },
    get charXp() { return charXp; },
    addChar, addAr,
    kill(id, level) {
      const xp = enemyXp(id, level);
      addChar(xp); addAr(Math.round(xp * 0.35));
      return xp;
    },
  };
}

console.log('\n=== progression: the whole game played once through');
const eco = economy();
eco.addChar(10 * BOOK_XP.adventurerXp + 2 * BOOK_XP.heroWit);
console.log(`  starting books                 -> level ${eco.level} (AR ${eco.ar}, cap ${eco.cap})`);

const story = Object.values(QUESTS).filter((q) => q.type === 'story');
for (const q of story) {
  for (const [id, n] of q.rewards.items || []) if (BOOK_XP[id]) eco.addChar(BOOK_XP[id] * n);
  eco.addAr(q.rewards.xp || 0);
}
console.log(`  + all ${story.length} story quests            -> level ${eco.level} (AR ${eco.ar}, cap ${eco.cap})`);

let chests = 0;
for (const z of Object.values(ZONES)) for (const p of z.poi || []) if (p.type === 'chest') chests++;
// `rollChest` picks from a 14-weight table where books are 5 of it, 1..3 at a time.
eco.addChar(Math.round(chests * (5 / 14) * 2 * BOOK_XP.adventurerXp));
console.log(`  + all ${chests} world chests             -> level ${eco.level} (AR ${eco.ar}, cap ${eco.cap})`);

for (const z of Object.values(ZONES)) {
  for (const camp of z.spawns || []) for (const id of camp.enemies) eco.kill(id, camp.level);
}
console.log(`  + one sweep of every camp        -> level ${eco.level} (AR ${eco.ar}, cap ${eco.cap})`);

// Clearing a floor pays twice: every enemy in it dies (handleKill -> rollEnemyLoot.xp)
// and the clear itself grants `chamberXp`. Floors unlock sequentially, so a single pass
// through all of them is exactly what "played once" means for a dungeon.
let floors = 0;
for (const z of Object.values(ZONES)) {
  for (const c of z.chambers || []) {
    floors++;
    for (const id of chamberEnemies(c)) eco.kill(id, c.level);
    const cx = chamberXp(c.level);
    eco.addChar(cx.party); eco.addAr(cx.adventure);
  }
}
console.log(`  + every one of ${floors} dungeon floors  -> level ${eco.level} (AR ${eco.ar}, cap ${eco.cap})`);

const deepest = Math.max(...Object.values(ZONES).flatMap((z) => (z.chambers || []).map((c) => c.level)));
const target = Math.max(...Object.values(ZONES).filter((z) => z.kind === 'dungeon')
  .map((z) => z.recommendedLevel));
console.log(`  the game's deepest content is enemy level ${deepest};`
  + ` its hardest dungeon recommends level ${target}`);

// What is left, and what the repeatable sources charge for it.
const need = (from, to) => { let t = 0; for (let l = from; l < to; l++) t += xpForLevel(l); return t; };
const remaining = need(eco.level, target) - eco.charXp;
const bestCamp = Object.values(ZONES).flatMap((z) => (z.spawns || []))
  .map((c) => ({ c, xp: c.enemies.reduce((a, id) => a + enemyXp(id, c.level), 0) }))
  .reduce((a, b) => (a.xp >= b.xp ? a : b));
// A *re-run* of a floor is worth only its enemies' kill xp: `grantChamberClear` pays
// `chamberMilestone`, which splits `chamberXp` into three shares and hands out only the
// ones a clear newly earns, so a floor's milestone is worth exactly `chamberXp` however
// many visits it takes to reach 3★ — and it was already spent in full in the pass above,
// which assumes a parity party clearing at its measured ttk. Modelling repeats at milestone rates was overstating the best
// chamber by ~30x and letting it answer a question about grinding that only camps can
// actually answer. It also costs `DOMAIN_RESIN` per clear, which is printed alongside
// because a source you can only tap 8 times before waiting an hour a point is not
// interchangeable with a camp that just respawns.
const chamberGrant = (c) => chamberEnemies(c).reduce((a, id) => a + enemyXp(id, c.level), 0);
const bestChamber = Object.values(ZONES).filter((z) => z.kind === 'dungeon')
  .flatMap((z) => z.chambers).reduce((a, b) => (chamberGrant(a) >= chamberGrant(b) ? a : b));
const runs = remaining <= 0 ? 0
  : Math.min(Math.ceil(remaining / bestCamp.xp), Math.ceil(remaining / chamberGrant(bestChamber)));
if (remaining <= 0) {
  console.log(`  level ${target} arrives with ${(-remaining).toLocaleString('en-US')} party xp to spare`
    + ` — no grind needed to meet the recommendation`);
} else {
  console.log(`  reaching level ${target} needs ${remaining.toLocaleString('en-US')} more party xp:`);
  console.log(`    ${Math.ceil(remaining / bestCamp.xp).toLocaleString('en-US')}x the best camp`
    + ` (lv ${bestCamp.c.level}, ${bestCamp.xp.toLocaleString('en-US')} xp a clear,`
    + ` ${bestCamp.c.respawn}s respawn)`);
  console.log(`    ${Math.ceil(remaining / chamberGrant(bestChamber)).toLocaleString('en-US')}x the best chamber`
    + ` (floor ${bestChamber.floor}, ${chamberGrant(bestChamber).toLocaleString('en-US')} xp a re-clear,`
    + ` ${DOMAIN_RESIN} resin for its drop)`);
}

// The contract is two-sided. Too slow and the player is walled out of content the game
// has already unlocked for them; too fast and every fight they were built for is trivial
// by the time they arrive, which is the same defect wearing the other hat. The floor is
// the hardest dungeon's own recommendation; the ceiling is the deepest content's level,
// because outlevelling the final boss on the way to it means nothing is left to play.
check('playing everything once gets within 10 levels of the endgame recommendation',
  eco.level >= target - 10, `level ${eco.level} vs recommended ${target}`);
check('playing everything once does not outlevel the deepest content',
  eco.level <= deepest, `level ${eco.level} vs deepest enemy level ${deepest}`);
check('the endgame level is reachable in <= 25 runs of the best repeatable content',
  runs <= 25, runs === 0 ? 'no grind required' : `${runs.toLocaleString('en-US')} runs`);

/* ----------------------------------------------- 5. the gate the player sees -- */

// `canEnterZone` only asks for adventure rank, and `arCap` then caps character level
// at 20 + 2*AR. So the gate implies a ceiling on how strong the player can possibly
// be when the door opens, and that ceiling has to be enough for floor 1.
console.log('\n=== dungeon entry gates');
for (const zoneId of Object.keys(ZONES).filter((z) => ZONES[z].kind === 'dungeon')) {
  const z = ZONES[zoneId];
  const rank = z.entryRank || 1;
  const ceiling = arCap(rank);
  const floor1 = z.chambers[0];
  const w = floorFight(parityParty(ceiling, { weaponLevel: Math.max(1, Math.round(ceiling * 0.8)) }), floor1);
  console.log(`\n  ${z.name}: gate AR ${rank} -> level cap ${ceiling}, floor 1 is enemy level ${floor1.level}`);
  report('floor 1 at the best the gate allows', w, `  limit ${floor1.timeLimit}s`);
  check(`${zoneId}: floor 1 is beatable at the gate's level ceiling`,
    w.ttk <= floor1.timeLimit && w.margin >= 1.0,
    `level ${ceiling} vs enemy lv ${floor1.level}: kill ${fmt(w.ttk)}s`
    + ` / limit ${floor1.timeLimit}s, margin ${fmt(w.margin, 2)}x`);
}

/* -------------------------------------- 6. the story chain, walked in order -- */

// Sections 4 and 5 look at the game as a bag of content. The story is not a bag: it is
// a linked list through `next`, each link naming a `zone` (so an AR gate) and a
// `minLevel`, and each link's own stages are the content that pays for the next one.
// So the only honest question is whether a player who does *exactly* the story, in
// order, is admitted to every quest when they reach it. Nothing else in the audit can
// catch a gate that is only unreachable at one point in the sequence.
//
// The gate is adventure rank twice over, and neither half is the character level that
// `minLevel` looks like it names: `routes/world.js` will not start a quest unless
// `adventureRank >= minLevel / 2`, and `canEnterZone` wants the zone's `entryRank` on
// top of that. Character level only decides whether the fight is survivable once the
// door opens, so it is printed here but judged by sections 2 and 3.
//
// The player modelled here does the story and *one pass of the zones it sends them
// through* — the camps and chests they walk past on the way to an objective, each
// counted once. That is the line between "no grinding", which the game owes them, and
// "no side content at all", which is a promise no RPG makes: the main quest is not
// supposed to be sufficient preparation for its own final boss. Repeating anything is
// what section 4 measures, and this section must pass without it.
console.log('\n=== the story chain, walked in order');
const storyEco = economy();
storyEco.addChar(10 * BOOK_XP.adventurerXp + 2 * BOOK_XP.heroWit);
const clearedFloors = new Set();
const visited = new Set();
let blocked = null;

// One sweep of a zone the story has just sent the player into.
function sweepZone(zoneId) {
  if (visited.has(zoneId)) return;
  visited.add(zoneId);
  const z = ZONES[zoneId];
  if (!z) return;
  for (const camp of z.spawns || []) for (const id of camp.enemies) storyEco.kill(id, camp.level);
  const n = (z.poi || []).filter((p) => p.type === 'chest').length;
  storyEco.addChar(Math.round(n * (5 / 14) * 2 * BOOK_XP.adventurerXp));
}
for (let q = QUESTS.q_intro; q; q = q.next ? QUESTS[q.next] : null) {
  const z = ZONES[q.zone];
  const needAr = Math.max(z ? (z.entryRank || 1) : 1, rankForLevel(q.minLevel || 1));
  const ok = storyEco.ar >= needAr;
  console.log(`  ${q.name.padEnd(6)} ${q.zone.padEnd(12)} needs AR ${String(needAr).padStart(2)}`
    + `  ->  has AR ${String(storyEco.ar).padStart(2)}`
    + ` (level ${String(storyEco.level).padStart(2)}, cap ${storyEco.cap})  ${ok ? 'ok' : 'BLOCKED'}`);
  if (!ok && !blocked) {
    blocked = `${q.id} wants AR ${needAr}, the story so far pays AR ${storyEco.ar}`
      + ` (at character level ${storyEco.level})`;
  }
  // Passing the gate is what gets them into the zone, so the sweep is credited after it.
  sweepZone(q.zone);

  // Credit the content this quest asks for. Kills name alternatives with `|`; take the
  // first, which is the cheapest reading. A `chamber` stage naming floor N means every
  // floor up to N, since they unlock sequentially — but only counted once per floor.
  for (const s of q.stages || []) {
    if (s.kind === 'kill' && s.target !== 'any') {
      const id = String(s.target).split('|')[0];
      const camp = Object.values(ZONES).flatMap((zz) => zz.spawns || [])
        .filter((c) => c.enemies.includes(id)).sort((a, b) => a.level - b.level)[0];
      const lvl = camp ? camp.level : (q.minLevel || 1);
      for (let i = 0; i < (s.count || 1); i++) storyEco.kill(id, lvl);
    } else if (s.kind === 'chamber') {
      const [zid, top] = String(s.target).split(':');
      for (const c of (ZONES[zid]?.chambers || []).filter((c) => c.floor <= Number(top))) {
        if (clearedFloors.has(`${zid}:${c.floor}`)) continue;
        clearedFloors.add(`${zid}:${c.floor}`);
        for (const id of chamberEnemies(c)) storyEco.kill(id, c.level);
        const cx = chamberXp(c.level);
        storyEco.addChar(cx.party); storyEco.addAr(cx.adventure);
      }
    }
  }
  for (const [id, n] of q.rewards?.items || []) if (BOOK_XP[id]) storyEco.addChar(BOOK_XP[id] * n);
  storyEco.addAr(q.rewards?.xp || 0);
}
check('the story chain is playable in order without side content', !blocked,
  blocked || `finishes at level ${storyEco.level} / AR ${storyEco.ar}`);

/* ------------------------------------------------ 7. the finale, as delivered -- */

// Every fight above is judged at parity, and the finale is the one fight where parity is
// a fiction: the storm tyrant is level 80 wherever it appears, but the last story quest
// asks for its head and section 4 says a complete playthrough delivers a level 58 party.
//
// The contract is deliberately *not* "beatable the moment the story asks for it". An
// endgame boss is supposed to need farming; that is what respawning camps and a repeatable
// abyss tower are for. What the player is owed is that the farm be bounded and that it be
// possible with the content they can already clear — grinding is a cost, being unable to
// grind at all is a wall. So this measures both: the level where the fight turns, and how
// many runs of the best thing they can currently beat it takes to get there.
//
//   --finale prints the whole difficulty sweep by party level.
console.log('\n=== the finale: what it takes to beat the last story quest');
const finale = QUESTS.q_tyrant;
const bossId = (finale.stages || []).map((s) => s.kind === 'kill' && s.target).find(Boolean);
const bossFloor = Object.values(ZONES).flatMap((z) => z.chambers || [])
  .filter((c) => chamberEnemies(c).includes(bossId)).sort((a, b) => a.level - b.level)[0];
const bossFight = (lv) => wave(parityParty(lv), [bossId], bossFloor.level);
const asDelivered = bossFight(eco.level);
console.log(`  ${ENEMIES[bossId].name} lv ${bossFloor.level} vs the level ${eco.level}`
  + ` party a full playthrough delivers:`);
report(`  ${finale.name}`, asDelivered, `  limit ${bossFloor.timeLimit}s`);
if (process.argv.includes('--finale')) {
  for (let lv = eco.level; lv <= 90; lv += 2) {
    const w = bossFight(lv);
    console.log(`  lv ${String(lv).padStart(2)}: kill ${fmt(w.ttk).padStart(6)}s`
      + ` die ${fmt(w.ttd).padStart(6)}s  margin ${fmt(w.margin, 2)}x`);
  }
}

// The level the fight turns at, and the best content clearable *before* getting there.
let turnLevel = null;
for (let lv = eco.level; lv <= 90 && turnLevel === null; lv++) {
  const w = bossFight(lv);
  if (w.ttk <= bossFloor.timeLimit && w.margin >= 1.0) turnLevel = lv;
}
// A chamber's `chamberXp` is a one-time milestone (both grant paths pay it per star
// earned, not per clear), so a *re-run* is worth only its enemies' kill xp. Camps pay
// kill xp every respawn. Farming is therefore kill xp either way.
const farmable = [
  ...Object.values(ZONES).flatMap((z) => (z.chambers || []).map((c) => ({
    what: `${z.name} floor ${c.floor} (lv ${c.level})`, level: c.level,
    enemies: chamberEnemies(c), chamber: c,
    xp: chamberEnemies(c).reduce((a, id) => a + enemyXp(id, c.level), 0),
  }))),
  ...Object.values(ZONES).flatMap((z) => (z.spawns || []).map((c) => ({
    what: `${z.name} camp (lv ${c.level})`, level: c.level, enemies: c.enemies,
    xp: c.enemies.reduce((a, id) => a + enemyXp(id, c.level), 0),
  }))),
  // Clearable now means clearable comfortably: a 1.5x margin, not a coin flip.
].filter((f) => {
  // A floor is farmed the way it is played: wave by wave, under its disorder. Flattening it
  // into one pack would judge a farming route against a fight the game never runs.
  const sts = parityParty(eco.level);
  const w = f.chamber ? floorFight(sts, f.chamber) : wave(sts, f.enemies, f.level);
  return w.margin >= 1.5 && w.ttk <= 300;
}).sort((a, b) => b.xp - a.xp);

if (turnLevel === null) {
  check('the final boss is beatable at some reachable level', false,
    `unbeatable at every level up to 90 (margin ${fmt(bossFight(90).margin, 2)}x at 90)`);
} else if (turnLevel <= eco.level) {
  check('the finale needs no farming beyond a full playthrough', true,
    `winnable at the delivered level ${eco.level}`);
} else {
  const best = farmable[0];
  const gap = need(eco.level, turnLevel) - eco.charXp;
  const runs = best ? Math.ceil(gap / best.xp) : Infinity;
  console.log(`  the fight turns at level ${turnLevel}`
    + ` (${fmt(bossFight(turnLevel).margin, 2)}x, kill ${fmt(bossFight(turnLevel).ttk)}s)`);
  console.log(`  getting there costs ${gap.toLocaleString('en-US')} party xp`
    + (best ? ` = ${runs} runs of ${best.what}, ${best.xp.toLocaleString('en-US')} xp each`
      : ' and nothing clearable pays it'));
  check('the finale is reachable by farming content the player can already clear',
    runs <= 25, best ? `${runs} runs of ${best.what}`
      : `nothing at level ${eco.level} clears with a 1.5x margin`);
}

/* ------------------------------------------ 8. the weapon axis, and who pays -- */

// Every verdict above builds its party with `weaponLevel = level`. That is only a fair
// assumption if the world hands out enough ore to keep weapons at party level, so this
// section prices it: how much strengthening xp a full sweep of the ore nodes in the zones
// a given adventure rank can open is worth, against what four weapons cost to reach the
// level cap that same rank allows (`arCap`).
//
// One sweep is the unit because `oreNode` clusters regrow on a 6 h window (`REGROW_MS`),
// so "one sweep" is a session's worth of mining, not the whole game's supply. Nodes are
// counted at `rollGather`'s mean of 2 chunks, not its best case of 3.
{
  console.log('\n=== the weapon axis: does the ore pay for weapons at party level?');
  const MEAN_CHUNKS = 2;
  const open = Object.entries(ZONES).filter(([, z]) => z.kind !== 'dungeon')
    .sort((a, b) => (a[1].entryRank || 1) - (b[1].entryRank || 1));
  // The starter weapons are what section 1..7 actually equip, so their rarity is the one
  // that sets the bill.
  const rarity = WEAPONS[WEAPON_FOR.sword].rarity;
  let sweepXp = 0;
  for (const [zoneId, z] of open) {
    const nodes = gatherNodes(z).filter((n) => WEAPON_ORE.includes(n.kind));
    sweepXp += nodes.reduce((a, n) => a + MEAN_CHUNKS * oreXp(n.kind), 0);
    const rank = z.entryRank || 1;
    const cap = Math.min(WEAPON_LEVEL_CAP[rarity] ?? 90, arCap(rank));
    // Four weapons: `party()` audits a four-character party everywhere it can.
    const bill = 4 * weaponXpToLevel(rarity, cap);
    const mora = Math.round(bill * WEAPON_MORA_PER_XP);
    console.log(`  by ${z.name} (AR ${rank}): sweep pays ${sweepXp.toLocaleString('en-US')} xp,`
      + ` 4 weapons to Lv.${cap} cost ${bill.toLocaleString('en-US')} xp`
      + ` + ${mora.toLocaleString('en-US')} mora  (${fmt(sweepXp / bill, 2)}x)`);
    check(`${zoneId}: one ore sweep keeps the party's weapons at its level cap`,
      sweepXp >= bill, `${fmt(sweepXp / bill, 2)}x of the bill`);
  }
  // And the end state: a full climb for a full party, which is what section 7's finale
  // party assumes. More than one sweep is fine — that is what the 6 h regrow is for —
  // but it must not be so many that the honest answer is "nobody does this".
  // Priced per rarity, because the bill doubles with each star (`weaponClimbXp`) while
  // the world's supply does not: the 5-star party is the real ceiling, and the starter
  // party is the floor the very first mining trip has to clear.
  for (const r of Object.keys(WEAPON_LEVEL_CAP).map(Number)) {
    const fullCap = WEAPON_LEVEL_CAP[r];
    const sweeps = 4 * weaponXpToLevel(r, fullCap) / sweepXp;
    console.log(`  a full ${r}-star party to Lv.${fullCap}: ${fmt(sweeps, 2)} full-world sweeps`
      + ` (${fmt(sweeps * 6, 1)} h of regrow)`);
    check(`a full ${r}-star party of weapons is a handful of mining trips, not a grind`,
      sweeps <= 4, `${fmt(sweeps, 2)} sweeps`);
  }
  // The attack the assumption is worth, stated once so a future reader can see what
  // breaks if weapon levelling is ever removed again.
  const top = WEAPON_LEVEL_CAP[rarity] ?? 90;
  const w1 = weaponStats(makeWeapon(WEAPON_FOR.sword, 1)).atk;
  const wCap = weaponStats(makeWeapon(WEAPON_FOR.sword, top)).atk;
  console.log(`  ${WEAPON_FOR.sword}: ${w1} atk at Lv.1 -> ${wCap} at Lv.${top}`
    + ` (${fmt(wCap / w1, 2)}x weapon base)`);
}

/* ------------------------------------------------------ 9. the scaling curve -- */

// `--curve` prints the two growth rates side by side, which is the only way to see
// whether a late-game wall is a tuning miss on one enemy or the curves diverging.
// Player offence at parity is measured, not assumed: it is the sum of character stat
// growth (`statAtLevel`, ~7x over 90 levels), weapon growth (~6.4x), artifacts and
// talents.
//
// The dps column is not perfectly monotonic and that is the harness, not the game:
// `generateArtifact` derives `artLevel` from the character level and then spends
// `1 + floor(artLevel/4)` random draws per substat, so a fixed seed walks a different
// roll stream at level 90 than at 80 (crit 0.84 / cd 0.50 there against 0.74 / 1.30
// here). It shows up as a percent or two of wobble between adjacent rows. Read the
// x-multipliers, not the differences between neighbours.
if (process.argv.includes('--curve')) {
  console.log('\n=== scaling: player offence vs enemy bulk, both at parity');
  console.log('  lv    partyDps   hilichurl ehp   ttk      tyrant ehp    ttk');
  let firstDps = 0, firstHp = 0;
  for (const lv of [1, 10, 20, 30, 40, 50, 60, 70, 80, 90]) {
    const sts = parityParty(lv);
    const dps = partyDps(sts, ENEMIES.hilichurl, lv).rot;
    const hp = enemyEffHp(ENEMIES.hilichurl, lv);
    const bossDps = partyDps(sts, ENEMIES.stormTyrant, lv).rot;
    const bossHp = enemyEffHp(ENEMIES.stormTyrant, lv);
    if (!firstDps) { firstDps = dps; firstHp = hp; }
    console.log(`  ${String(lv).padStart(2)}  ${fmt(dps, 0).padStart(9)}`
      + `  ${fmt(hp, 0).padStart(13)}  ${fmt(hp / dps).padStart(6)}s`
      + `  ${fmt(bossHp, 0).padStart(11)}  ${fmt(bossHp / bossDps).padStart(6)}s`
      + `   (dps x${fmt(dps / firstDps, 1)}, hp x${fmt(hp / firstHp, 1)})`);
  }
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails);
