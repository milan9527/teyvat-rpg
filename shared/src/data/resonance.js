// 元素共鸣: what the *composition* of the four characters is worth.
//
// Every other axis in this game is per character — level, ascension, talents, weapon,
// artifacts, constellation dupes. That makes a party a bag of four independent builds:
// the only question the team edit screen ever asked was "who has the biggest numbers",
// and a roster of eight characters across seven elements had exactly one interesting
// answer. Resonance is the one bonus that comes from the *shape* of the team, so picking
// two 雷 characters over one 雷 and one 岩 is a real decision.
//
// Two rules, both read off the party list and nothing else:
//   - two or more characters of the same element  -> that element's resonance
//   - four characters, four different elements    -> 四象庇护
// A party can hold two pairs, and then it gets both resonances.
//
// The effect vocabulary is deliberately *not* new. Six of the eight fields are stat keys
// `buildCharacterStats` already folds and the simulation already reads; the other two are
// `PROC_KEYS` entries, so they ride the same conditional-effect path as a weapon passive
// or a 4-piece set bonus and reuse its consumers. `RESONANCE_FIELDS` names the consumer
// of each one, and `tools/resonance-check.mjs` fails in both directions: a field with no
// consumer, and a consumer nothing sends. That gate exists because this repo has shipped
// the other kind of "system" twice already — `refinement` and `weaponPassive` were fields
// nothing read, and nine weapon descriptions promised effects the game did not have.

import { REACTIONS } from './elements.js';
import { CHARACTERS } from './characters.js';

/** Characters of one element a resonance needs. */
export const RESONANCE_NEED = 2;

/** 四象庇护 asks for four *different* elements, i.e. a full party with no pair at all. */
export const DISTINCT_NEED = 4;

export const RESONANCES = Object.freeze({
  fire: {
    id: 'fire', element: 'fire', name: '炎炎不息',
    effect: { atkPct: 0.25 },
  },
  water: {
    id: 'water', element: 'water', name: '潮涌相闻',
    effect: { healBonus: 0.30 },
  },
  ice: {
    id: 'ice', element: 'ice', name: '霜碎之诫',
    effect: { critVsFrozen: 0.15 },
  },
  lightning: {
    id: 'lightning', element: 'lightning', name: '雷动共振',
    effect: { energyOnReaction: 3, onReactions: ['electroCharged', 'superconduct', 'overload'] },
  },
  wind: {
    id: 'wind', element: 'wind', name: '疾风相引',
    effect: { cdReduction: 0.10 },
  },
  earth: {
    id: 'earth', element: 'earth', name: '磐岩同契',
    effect: { shieldStrength: 0.20 },
  },
  light: {
    id: 'light', element: 'light', name: '皓光同辉',
    effect: { em: 80 },
  },
  protective: {
    id: 'protective', distinct: DISTINCT_NEED, name: '四象庇护',
    effect: { dr: 0.10 },
  },
});

/**
 * Every field a resonance may carry, and the one line that reads it.
 *
 * `fold: 'stat'` means `applyPartyResonance` folds it into the stat block and the named
 * consumer picks it up with no further plumbing; `fold: 'proc'` means it is a `PROC_KEYS`
 * entry fired through `gearProcs`, which treats the resonance as a fourth effect source;
 * `fold: 'shape'` describes another field's condition rather than a bonus of its own.
 */
export const RESONANCE_FIELDS = Object.freeze({
  atkPct:           { fold: 'stat', consumer: 'sim/loot.applyPartyResonance -> st.atk（每一次伤害计算都读）' },
  healBonus:        { fold: 'stat', consumer: 'world/actions.handleSkill/handleBurst 的 heal' },
  em:               { fold: 'stat', consumer: 'world/zoneInstance.playerHitEnemy 的 mastery（喂给 formulas.masteryBonus 的反应伤害）' },
  cdReduction:      { fold: 'stat', consumer: 'world/actions.handleSkill/handleBurst 的 cd' },
  shieldStrength:   { fold: 'stat', consumer: 'world/actions 的 skill.shield 与 procs.healOverflowToShield' },
  dr:               { fold: 'stat', consumer: 'world/entity.PlayerEntity.takeDamage' },
  critVsFrozen:     { fold: 'proc', consumer: 'world/procs.hitMods（目标被冻结时）' },
  energyOnReaction: { fold: 'proc', consumer: "world/procs.fireProcs 的 'reaction' 分支" },
  onReactions:      { fold: 'shape', consumer: "world/procs.fireProcs 用它筛 energyOnReaction 的反应" },
});

/** Stat keys `applyPartyResonance` folds — the numeric half of `RESONANCE_FIELDS`. */
export const RESONANCE_STAT_KEYS = Object.freeze(
  Object.keys(RESONANCE_FIELDS).filter((k) => RESONANCE_FIELDS[k].fold === 'stat'),
);

const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * The player-facing text, written *from the numbers*.
 *
 * Same rule as `disorderHint`: a description authored next to the effect is a second
 * source of truth, and the pair drifts the first time one of them is tuned.
 */
const HINT = {
  atkPct: (v) => `全队攻击力提升 ${pct(v)}`,
  healBonus: (v) => `全队治疗效果提升 ${pct(v)}`,
  em: (v) => `全队元素精通提升 ${v} 点`,
  cdReduction: (v) => `全队元素战技与爆发冷却缩减 ${pct(v)}`,
  shieldStrength: (v) => `全队护盾强效提升 ${pct(v)}`,
  dr: (v) => `全队受到的伤害降低 ${pct(v)}`,
  critVsFrozen: (v) => `攻击被冻结的敌人时暴击率提升 ${pct(v)}`,
  energyOnReaction: (v, e) =>
    `触发${(e.onReactions || []).map((k) => REACTIONS[k]?.name || k).join('/')}时恢复 ${v} 点元素能量`,
};

export function resonanceHint(r) {
  if (!r?.effect) return '';
  return Object.entries(r.effect)
    .filter(([k]) => HINT[k])
    .map(([k, v]) => HINT[k](v, r.effect))
    .join('，');
}

/** 「两名炎元素角色」/「四名不同元素的角色」— the condition, also derived. */
export function resonanceCondition(r) {
  if (r.distinct) return `${r.distinct} 名元素各不相同的角色`;
  return `${RESONANCE_NEED} 名${elementName(r.element)}元素角色`;
}

function elementName(el) {
  return { fire: '炎', water: '水', ice: '冰', lightning: '雷', wind: '风', earth: '岩', light: '光' }[el] || el;
}

/**
 * The resonances a party of character ids activates, in table order.
 *
 * Reads `CHARACTERS[id].element` and nothing else, so both hosts and the UI agree by
 * construction — the party list is the only input either of them has.
 */
export function partyResonances(party = []) {
  const count = {};
  for (const id of party) {
    const el = CHARACTERS[id]?.element;
    if (el) count[el] = (count[el] || 0) + 1;
  }
  const out = [];
  for (const r of Object.values(RESONANCES)) {
    if (r.element) {
      if ((count[r.element] || 0) >= RESONANCE_NEED) out.push(r);
    } else if (r.distinct) {
      const n = Object.values(count).reduce((a, v) => a + v, 0);
      if (n >= r.distinct && Object.keys(count).length >= r.distinct) out.push(r);
    }
  }
  return out;
}

/** Element ids that have an elemental resonance — the reachability gate's left side. */
export const RESONANCE_ELEMENTS = Object.freeze(
  Object.values(RESONANCES).filter((r) => r.element).map((r) => r.element),
);

/** How many playable characters carry each element, i.e. which pairs a player can field. */
export function rosterByElement() {
  const out = {};
  for (const def of Object.values(CHARACTERS)) {
    (out[def.element] = out[def.element] || []).push(def.id);
  }
  return out;
}
