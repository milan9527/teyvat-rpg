// Damage / stat formulas. Imported by BOTH client (prediction, numbers) and
// server (authoritative validation) so results agree.

import { AMPLIFYING, masteryBonus } from '../data/elements.js';
import { clamp } from './rng.js';

/** Character stat growth curve. Level 1..90 */
export function statAtLevel(base, level, ascension = 0) {
  const t = (level - 1) / 89;
  const curve = Math.pow(t, 1.12);
  return Math.round(base * (1 + 6.2 * curve) * (1 + 0.06 * ascension));
}

/**
 * Enemy stat growth: hp, atk, def and shields.
 *
 * Deliberately the *product of the player's two growth curves* rather than a flat
 * geometric. A player's offence at parity grows on two axes at once — character level
 * through `statAtLevel` (about 7x from 1 to 90) and weapon level through
 * `weaponStats` (about 6.4x) — so the honest yardstick for enemy bulk is their
 * product, and anything steeper turns the late game into a wall no gear can climb.
 *
 * This used to be `1.068^(level-1)`, which reaches 340x at level 90 against the
 * player's measured 38x (`tools/balance-check.mjs --curve`). The consequence was not
 * subtle: a level-80 storm tyrant carried 2.53 M effective hp and took 457 s to kill
 * against its chamber's 360 s limit, and every dungeon's last floor was unclearable
 * by construction. Under this curve the same fight is a little over two minutes, a
 * camp mob stays around 2-3 s at every level instead of drifting from 1.9 s to 17.6 s,
 * and — because the curve is slightly *above* the old one below level 30 — the early
 * game gets marginally harder rather than easier, which is where it had margin to
 * spare.
 */
export function enemyStatAtLevel(base, level) {
  const t = (level - 1) / 89;
  return Math.round(base * (1 + 6.2 * Math.pow(t, 1.12)) * (1 + 5.4 * Math.pow(t, 1.08)));
}

/** Enemy defence mitigation. */
export function defMultiplier(attackerLevel, defenderLevel, defShred = 0, defIgnore = 0) {
  const def = (defenderLevel + 100) * (1 - defShred) * (1 - defIgnore);
  return (attackerLevel + 100) / (attackerLevel + 100 + def);
}

/** Elemental resistance mitigation, with the standard negative-res softening. */
export function resMultiplier(res) {
  if (res < 0) return 1 - res / 2;
  if (res < 0.75) return 1 - res;
  return 1 / (4 * res + 1);
}

/**
 * Full damage pipeline.
 * @returns {{damage:number, crit:boolean, reactionDamage:number, reactionKey:string|null}}
 */
export function computeDamage({
  atk = 100,
  scaling = 1.0,          // talent multiplier
  flat = 0,
  bonus = 0,              // elemental / physical dmg bonus
  critRate = 0.05,
  critDmg = 0.5,
  level = 1,
  targetLevel = 1,
  targetRes = 0.1,
  defShred = 0,
  defIgnore = 0,
  mastery = 0,
  reaction = null,
  // Bonus to the reaction itself, from gear that names a reaction as its condition
  // (炽焰之冠's +15 % 蒸发/融化, 风歌者之诗's +40 % 扩散). It sits beside the elemental
  // mastery term rather than multiplying the whole hit, because that is what the tooltip
  // says: the *reaction* is stronger, not the attack that triggered it.
  reactionBonus = 0,
  rng = Math.random,
  guaranteedCrit = false,
}) {
  let base = atk * scaling + flat;
  base *= 1 + bonus;

  let amp = 1;
  if (reaction && AMPLIFYING.has(reaction.key)) {
    amp = reaction.mult * (1 + masteryBonus(mastery, 'amplify') + reactionBonus);
  }

  const crit = guaranteedCrit || rng() < clamp(critRate, 0, 1);
  const critMul = crit ? 1 + critDmg : 1;

  const dmg =
    base * amp * critMul *
    defMultiplier(level, targetLevel, defShred, defIgnore) *
    resMultiplier(targetRes);

  let reactionDamage = 0;
  let reactionKey = reaction ? reaction.key : null;
  if (reaction && !AMPLIFYING.has(reaction.key)) {
    const lvlMul = 4.2 * Math.pow(1.06, level - 1) * (1 + level * 0.9);
    reactionDamage =
      lvlMul * reaction.mult * (1 + masteryBonus(mastery, 'transform') + reactionBonus) *
      resMultiplier(targetRes);
  }

  return {
    damage: Math.max(1, Math.round(dmg)),
    crit,
    reactionDamage: Math.round(reactionDamage),
    reactionKey,
  };
}

export function healAmount({ maxHp, hpScaling = 0, atk = 0, atkScaling = 0, flat = 0, healBonus = 0 }) {
  return Math.round((maxHp * hpScaling + atk * atkScaling + flat) * (1 + healBonus));
}

/** XP needed to go from `level` to `level+1`. */
export function xpForLevel(level) {
  return Math.round(120 * Math.pow(level, 1.62) + 80 * level);
}

export function totalXpTo(level) {
  let t = 0;
  for (let i = 1; i < level; i++) t += xpForLevel(i);
  return t;
}

/**
 * Character level is soft-capped by adventure rank, to keep progression paced.
 *
 * This pair has to live together, and in `shared`, because anything that gates content
 * on "you should be about level L" must ask for `rankForLevel(L)` and no more — `arCap`
 * is what decides whether level L is attainable at all, so a gate demanding a higher
 * rank is gating on a number the player cannot be at. `routes/world.js` used to start
 * story quests on its own private rule (`adventureRank >= minLevel / 2`), which wanted
 * AR 28 for the finale's level 55 where the cap only needs 18.
 */
export function arCap(adventureRank) {
  return Math.min(90, 20 + adventureRank * 2);
}

export function rankForLevel(level) {
  return Math.max(1, Math.ceil((level - 20) / 2));
}

/**
 * Reward for clearing one dungeon chamber, denominated in the chamber's own level so a
 * clear is worth a fixed fraction of a level (about half) wherever it sits on the ladder.
 *
 * This replaces `800 + floor * 400` party / `400 + floor * 220` adventure, which was
 * linear in the *floor index* and so paid an endgame floor barely more than a starter
 * one — floor 8 of the abyss trial was worth 4 000 xp toward a 100 000 xp level. Same
 * reasoning as `enemyXp`; see `tools/balance-check.mjs` for the measurement.
 */
export function chamberXp(level) {
  const need = xpForLevel(level);
  return { party: Math.round(need * 0.5), adventure: Math.round(need * 0.18) };
}

/** Stamina costs. */
export const STAMINA = {
  max: 240,
  regen: 25,            // per second when idle
  sprintDrain: 18,      // per second
  dash: 22,
  climbDrain: 10,
  glideDrain: 4,
  chargedAttack: 20,
  swimDrain: 8,
};

export function levelFromXp(xp) {
  let level = 1;
  let remaining = xp;
  while (level < 90) {
    const need = xpForLevel(level);
    if (remaining < need) break;
    remaining -= need;
    level++;
  }
  return { level, xpIntoLevel: remaining, xpToNext: xpForLevel(level) };
}
