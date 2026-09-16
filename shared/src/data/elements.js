// Elemental system: application, auras, gauge decay and reactions.
// Original ruleset inspired by the action-RPG genre (not a copy of any one game's tables).

export const ELEMENTS = {
  physical: { id: 'physical', name: '物理', color: 0xd8d8d8, glow: 0xffffff },
  fire:     { id: 'fire',     name: '炎',   color: 0xff6a2b, glow: 0xffb066 },
  water:    { id: 'water',    name: '水',   color: 0x3aa7ff, glow: 0x8fd6ff },
  ice:      { id: 'ice',      name: '冰',   color: 0x8fe3f0, glow: 0xd6fbff },
  lightning:{ id: 'lightning',name: '雷',   color: 0xb46cff, glow: 0xe0b8ff },
  wind:     { id: 'wind',     name: '风',   color: 0x4fe0b0, glow: 0xb9ffe8 },
  earth:    { id: 'earth',    name: '岩',   color: 0xf0c04a, glow: 0xffe9a8 },
  light:    { id: 'light',    name: '光',   color: 0xfff3c4, glow: 0xffffff },
};

export const ELEMENT_IDS = Object.keys(ELEMENTS);

// How long 1 unit of aura gauge persists, in seconds.
const AURA_DECAY = {
  fire: 6.0, water: 7.0, ice: 7.5, lightning: 5.0, wind: 3.0, earth: 6.5, light: 5.0,
};

export const REACTIONS = {
  vaporize:      { name: '蒸发',   color: 0xff9a5c, mult: 2.0 },
  melt:          { name: '融化',   color: 0xffc07a, mult: 2.0 },
  overload:      { name: '超载',   color: 0xff5a3c, mult: 1.6, aoe: 4.2, knock: 9 },
  freeze:        { name: '冻结',   color: 0xa8ecff, mult: 1.0, freeze: 3.0 },
  shatter:       { name: '碎冰',   color: 0xd8f6ff, mult: 1.5 },
  electroCharged:{ name: '感电',   color: 0xc07aff, mult: 1.2, dot: 4.0 },
  superconduct:  { name: '超导',   color: 0xa0a0ff, mult: 1.0, aoe: 3.6, defShred: 0.4, defShredTime: 8 },
  swirl:         { name: '扩散',   color: 0x7affd8, mult: 1.2, aoe: 4.8, spread: true },
  crystallize:   { name: '结晶',   color: 0xffd979, mult: 1.0, shield: 0.28 },
  bloom:         { name: '绽放',   color: 0x7cff8a, mult: 1.4, aoe: 3.0 },
  radiance:      { name: '辉耀',   color: 0xfff7d0, mult: 1.8, heal: 0.05 },
};

/**
 * Resolve a reaction between an incoming element and an existing aura.
 * Returns { key, ...def } or null.
 */
export function resolveReaction(incoming, aura) {
  if (!aura || incoming === aura || incoming === 'physical') return null;
  const pair = (a, b) => (incoming === a && aura === b) || (incoming === b && aura === a);

  if (pair('fire', 'water')) {
    // Water onto fire aura vaporizes harder than fire onto water.
    return { key: 'vaporize', ...REACTIONS.vaporize, mult: incoming === 'water' ? 2.0 : 1.5 };
  }
  if (pair('fire', 'ice')) {
    return { key: 'melt', ...REACTIONS.melt, mult: incoming === 'fire' ? 2.0 : 1.5 };
  }
  if (pair('fire', 'lightning')) return { key: 'overload', ...REACTIONS.overload };
  if (pair('water', 'ice')) return { key: 'freeze', ...REACTIONS.freeze };
  if (pair('water', 'lightning')) return { key: 'electroCharged', ...REACTIONS.electroCharged };
  if (pair('ice', 'lightning')) return { key: 'superconduct', ...REACTIONS.superconduct };
  if (incoming === 'wind') return { key: 'swirl', ...REACTIONS.swirl, spreadElement: aura };
  if (incoming === 'earth') return { key: 'crystallize', ...REACTIONS.crystallize, shieldElement: aura };
  if (aura === 'wind') return { key: 'swirl', ...REACTIONS.swirl, spreadElement: incoming };
  if (aura === 'earth') return { key: 'crystallize', ...REACTIONS.crystallize, shieldElement: incoming };
  if (incoming === 'light' || aura === 'light') return { key: 'radiance', ...REACTIONS.radiance };
  return null;
}

/** Amplifying reactions scale the triggering hit; transformative ones add separate damage. */
export const AMPLIFYING = new Set(['vaporize', 'melt', 'radiance']);

/**
 * Pouring more of the same element onto a shield made of it. Half, not zero: a water shield
 * still gives way to enough water, it is just the worst answer in the party.
 */
export const SHIELD_SAME_ELEMENT_MUL = 0.5;

/**
 * 元素护盾: how much of a hit is charged against an enemy's elemental shield, per point of
 * damage. `abyssMage` carries 900 points of ice and `abyssHerald` 3200 of water — and until
 * this function existed, `shield.element` was authored on both, validated by `enemyGate`
 * («shield has no valid element»), serialised to every client as part of the nameplate, and
 * **read by nothing**: a shield absorbed physical, fire and its own element at exactly the
 * same rate, so the only correct play against a mage was «keep hitting it».
 *
 * The table is *derived*, not written a second time: a shield is treated as an aura, and the
 * multiplier is the multiplier of the reaction the incoming element would have caused
 * (`resolveReaction`). Fire onto ice is melt, so it is 2.0; water onto that ice freezes, so it
 * is 1.0; wind swirls it at 1.2; light radiates at 1.8. Writing a second `SHIELD_MUL` table
 * would let the two drift, and the pair «what reads as strong» / «what is strong» is exactly
 * the pair a player learns by playing — cf. the `refineMul` note in weapons.
 *
 * The shield does **not** also apply its element as an aura. Reaction multipliers already ride
 * on the damage when the target carries an aura, so an aura here would pay the same 2× twice,
 * and a cryo shield would hand every pyro character a free melt on the first hit of the fight.
 *
 * The *player's* shield is charged by the same function, and that is the point: 结晶 hands out a
 * shield made of the element the geo hit reacted with (`resolveReaction().shieldElement`, which
 * was produced by two branches above and read by nobody), a geo character's skill shield is made
 * of their own element, and «a shield resists the element it is made of and gives way to the
 * elements that react with it» is one rule the player learns once and applies in both
 * directions — offence against a mage, defence with a crystal shard.
 */
export function shieldBreakMul(incoming, shieldElement) {
  if (!shieldElement) return 1;
  if (incoming === shieldElement) return SHIELD_SAME_ELEMENT_MUL;
  const r = resolveReaction(incoming, shieldElement);
  return r ? r.mult : 1;
}

/** Reaction bonus from elemental mastery, following a diminishing curve. */
export function masteryBonus(mastery, kind) {
  if (kind === 'amplify') return (2.78 * mastery) / (mastery + 1400);
  return (16 * mastery) / (mastery + 2000);
}

export function auraDecayFor(element) {
  return AURA_DECAY[element] ?? 5.0;
}

/**
 * Mutable aura state on an entity.
 * gauge decays over time; strongest aura wins.
 */
export class AuraState {
  constructor() {
    this.auras = new Map(); // element -> { gauge, decay }
    this.frozenUntil = 0;
    this.defShredUntil = 0;
    this.defShred = 0;
    this.dots = []; // { element, dps, until, sourceId }
  }

  apply(element, units = 1, now = 0) {
    if (element === 'physical') return null;
    const existing = this.dominant();
    const reaction = resolveReaction(element, existing);
    if (reaction) {
      // Reactions consume aura.
      const consumed = element === 'wind' || element === 'earth' ? 1.0 : 0.8;
      const a = this.auras.get(existing);
      if (a) {
        a.gauge -= consumed * units;
        if (a.gauge <= 0.01) this.auras.delete(existing);
      }
      if (reaction.key === 'freeze') {
        this.frozenUntil = Math.max(this.frozenUntil, now + reaction.freeze);
        this.auras.delete('water');
        this.auras.delete('ice');
      }
      if (reaction.key === 'superconduct') {
        this.defShred = reaction.defShred;
        this.defShredUntil = now + reaction.defShredTime;
      }
      if (reaction.key === 'electroCharged') {
        // One dot per element, its window **refreshed** — not one independent dot per application.
        //
        // `updatePlayer`/`updateEnemy` tick every entry in this list, and each entry costs a fixed
        // fraction of max hp per second, so pushing meant the drain was really
        // `applications-in-the-last-4-s × the authored rate`. The camp player-aura-check walks into
        // (two 雷史莱姆 at attackCd 2.6 and one 水史莱姆 at 2.0) alternates the pair about once a
        // second, which holds a mean of 4 dots: 6.09 %/s instead of the 2.10 %/s written here, and
        // a full-health Lv.30 party dead in 17.7 s. It scales with the size of the camp and nothing
        // caps it. `tick` is deliberately carried over rather than reset, so a re-application
        // neither grants a free tick nor starves the next one by pushing its phase back.
        const live = this.dots.find((d) => d.element === 'lightning');
        if (live) live.until = Math.max(live.until, now + reaction.dot);
        else this.dots.push({ element: 'lightning', frac: 0.06, until: now + reaction.dot, tick: 0 });
      }
      // Wind/earth do not leave their own aura.
      if (element !== 'wind' && element !== 'earth') {
        this.auras.set(element, { gauge: units * 0.5, decay: auraDecayFor(element) });
      }
      return reaction;
    }
    // Wind and earth never leave an aura, here as well as in the reaction branch above.
    // They used to: this else-branch gave them a 0.4 gauge, so wind on a clean target
    // registered a wind aura, and the *next* hit of any element then matched the
    // `aura === 'wind'` rule and came back as swirl. Swirl exists to spread an aura that
    // is already there, so the player got transformative damage and a reaction popup out
    // of nothing — and earth the same way, handing out a free crystallize shield. Anemo
    // and geo are the two carriers with no aura of their own; that has to hold on an
    // un-auraed target too, which is precisely the case that reaches this branch.
    if (element === 'wind' || element === 'earth') return null;
    const cur = this.auras.get(element);
    if (cur) cur.gauge = Math.min(4, cur.gauge + units * 0.8);
    else this.auras.set(element, { gauge: units, decay: auraDecayFor(element) });
    return null;
  }

  dominant() {
    let best = null, bestG = 0;
    for (const [el, a] of this.auras) {
      if (a.gauge > bestG) { bestG = a.gauge; best = el; }
    }
    return best;
  }

  isFrozen(now) {
    return now < this.frozenUntil;
  }

  update(dt, now) {
    for (const [el, a] of this.auras) {
      a.gauge -= dt / a.decay;
      if (a.gauge <= 0) this.auras.delete(el);
    }
    if (now >= this.defShredUntil) this.defShred = 0;
    this.dots = this.dots.filter((d) => d.until > now);
  }

  clear() {
    this.auras.clear();
    this.dots.length = 0;
    this.frozenUntil = 0;
    this.defShred = 0;
  }

  serialize() {
    const el = this.dominant();
    return el ? { e: el, f: this.frozenUntil } : null;
  }
}
