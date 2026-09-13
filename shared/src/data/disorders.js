// 地脉异常 (ley-line disorders): the one line of data that makes two floors with the same
// enemy list two different fights.
//
// Every one of the game's fourteen chamber floors used to be the same encounter — one wave,
// kill everything before the timer — and `tools/balance-check.mjs` measured what that was
// worth: a parity party spent 5–25 % of the time limit and three stars was free on all of
// them. A dungeon with no failure mode is a loot button, not a level.
//
// A disorder is a rule for the whole run, not a buff on one enemy, and every entry pairs an
// upside with a downside so the answer is a *different party* rather than a bigger sword:
// 凝霜地脉 hands the floor 35 % more hp and 40 % physical resistance while paying 40 % extra
// ice/water damage. Same eight enemies, eight different questions.
//
// Two rules hold this file together, both gated by `tools/chamber-check.mjs`:
//
//   1. every effect key must appear in `DISORDER_FIELDS`, which names the single line of
//      code that reads it. Effect data with no consumer is the failure this repo keeps
//      rediscovering (nine weapon passives, nine sfx recipes): it passes every test,
//      because a promise nobody consumes cannot fail.
//   2. the player-facing text is *derived* (`disorderHint`), never authored beside the
//      numbers. A hand-written 「+30%」 next to a `1.3` is two things to keep in sync, and
//      the one that rots is the one the player reads.

import { ELEMENTS } from './elements.js';

/** Effect key -> the one consumer that reads it. Both directions are asserted. */
export const DISORDER_FIELDS = {
  enemyHpMul: 'zoneInstance._spawnWave -> spawnEnemy({ hpMul })',
  enemyDmgMul: 'zoneInstance.damagePlayer',
  enemyRes: 'zoneInstance.playerHitEnemy -> targetRes',
  playerElemBonus: 'zoneInstance.playerHitEnemy -> bonus',
  reactionBonus: 'zoneInstance.playerHitEnemy -> reactionBonus',
};

/** Keys that describe the disorder rather than change the fight. */
export const DISORDER_META_KEYS = ['id', 'name'];

export const DISORDERS = {
  // Glass cannons: the floor kills fast and dies fast, and a pyro carry turns the
  // downside into the shortest run in the dungeon.
  emberVein: {
    id: 'emberVein', name: '炽炎地脉',
    enemyDmgMul: 1.3,
    enemyRes: { fire: -0.4 },
  },
  // The anti-physical floor. A claymore party feels this one as a wall; an ice or water
  // carry barely notices it.
  frostVein: {
    id: 'frostVein', name: '凝霜地脉',
    enemyHpMul: 1.35,
    enemyRes: { physical: 0.4 },
    playerElemBonus: { ice: 0.4, water: 0.4 },
  },
  // Pays for team composition instead of for one carry: +60 % transformative reaction
  // damage is only collectable by a party that brings two elements.
  stormVein: {
    id: 'stormVein', name: '雷鸣地脉',
    reactionBonus: 0.6,
    enemyDmgMul: 1.15,
  },
  // A damage check with no time pressure of its own: nothing hits harder, there is just a
  // lot more of it, and the two damage types that answer are the ones a physical build has.
  stoneVein: {
    id: 'stoneVein', name: '磐岩地脉',
    enemyHpMul: 1.6,
    playerElemBonus: { earth: 0.5, physical: 0.5 },
  },
  galeVein: {
    id: 'galeVein', name: '烈风地脉',
    enemyDmgMul: 1.2,
    enemyRes: { wind: -0.3 },
    playerElemBonus: { wind: 0.5, lightning: 0.5 },
  },
};

export const DISORDER_IDS = Object.keys(DISORDERS);

export function disorderById(id) {
  return (id && DISORDERS[id]) || null;
}

const pct = (v) => `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`;
const elName = (el) => ELEMENTS[el]?.name || el;

/**
 * The player-facing description, built from the numbers the fight actually uses.
 *
 * One clause per effect term, in the order `DISORDER_FIELDS` declares them, so the HUD
 * chip and the map panel cannot describe a floor the simulation is not running.
 */
export function disorderHint(d) {
  if (!d) return '';
  const out = [];
  if (d.enemyHpMul) out.push(`敌人生命 ${pct(d.enemyHpMul - 1)}`);
  if (d.enemyDmgMul) out.push(`敌人伤害 ${pct(d.enemyDmgMul - 1)}`);
  for (const [el, v] of Object.entries(d.enemyRes || {})) {
    out.push(`敌人${elName(el)}抗性 ${pct(v)}`);
  }
  // Elements that share a bonus share a clause: 「冰/水伤害 +40%」 rather than two lines
  // saying the same thing.
  const byValue = new Map();
  for (const [el, v] of Object.entries(d.playerElemBonus || {})) {
    byValue.set(v, (byValue.get(v) || []).concat(elName(el)));
  }
  for (const [v, els] of byValue) out.push(`${els.join('/')}伤害 ${pct(v)}`);
  if (d.reactionBonus) out.push(`元素反应伤害 ${pct(d.reactionBonus)}`);
  return out.join(' · ');
}

/** How many effect terms a disorder has — the count `disorderHint` must produce. */
export function disorderTerms(d) {
  if (!d) return 0;
  let n = 0;
  if (d.enemyHpMul) n++;
  if (d.enemyDmgMul) n++;
  n += Object.keys(d.enemyRes || {}).length;
  n += new Set(Object.values(d.playerElemBonus || {})).size;
  if (d.reactionBonus) n++;
  return n;
}

/** Everything the client needs to name a disorder, in one snapshot-sized object. */
export function disorderInfo(id) {
  const d = disorderById(id);
  return d ? { id: d.id, name: d.name, hint: disorderHint(d) } : null;
}
