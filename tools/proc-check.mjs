// Conditional gear effects: do the triggers in `shared/src/world/procs.js` actually fire,
// and does the number in the tooltip arrive?
//
//   node tools/proc-check.mjs
//   node tools/proc-check.mjs --verbose
//
// No server and no browser: this drives a real `ZoneInstance` in-process with real
// `handleSkill`/`handleBurst`/`playerHitEnemy` calls, which is the same code the gateway
// runs online and the same code `localSocket` runs for 单机. The instance's own 20 Hz
// timer is stopped immediately and `inst.now` is advanced by hand, so every assertion is
// deterministic — no sleeping, no wall clock, and crit is pinned by setting `critRate` to
// 0 or 1 on the stat block rather than by re-rolling until the dice cooperate.
//
// The reason this probe exists at all: nine of the fifteen weapon passives and six of the
// eight 4-piece set bonuses were *data only*. `items.js` described them, `buildCharacterStats`
// dropped their keys on the floor (they are absent from `ZERO()`, and `addStat` ignores
// unknown keys), and nothing else read them. Every one of those effects passed every test
// the repo had, because a promise nobody consumes cannot fail. Section 1 is the gate that
// makes the whole class impossible from now on: every key in every passive must be either
// a stat the build folds in or a trigger `procs.js` fires.
//
// Exit code is the number of failed assertions.

import { CHARACTERS } from '../shared/src/data/characters.js';
import { WEAPONS, ARTIFACT_SETS, ARTIFACT_SLOTS } from '../shared/src/data/items.js';
import { buildCharacterStats, makeWeapon, STAT_KEYS, STATIC_PASSIVE_KEYS } from '../shared/src/sim/loot.js';
import { refineMul, WEAPON_REFINE_MAX } from '../shared/src/sim/loot.js';
import {
  masteryBonus, REACTIONS, shieldBreakMul, SHIELD_SAME_ELEMENT_MUL,
} from '../shared/src/data/elements.js';
import { ZoneInstance } from '../shared/src/world/zoneInstance.js';
import { handleSkill, handleBurst, handleAttack } from '../shared/src/world/actions.js';
import {
  gearProcs, procSum, liveStats, hitMods, fireProcs,
  PROC_KEYS, PROC_SHAPE_KEYS, PROC_DURATION, SKILL_FOLLOW_GAP, LOW_HP,
} from '../shared/src/world/procs.js';
import { S2C } from '../shared/src/protocol.js';

const VERBOSE = process.argv.includes('--verbose');
let passes = 0, fails = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else {
    fails++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`);
  }
  return !!ok;
}
const fmt = (v, d = 2) => Number(v).toFixed(d);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ------------------------------------------------------------------ fixtures -- */

const LEVEL = 60;

/**
 * A stat block with *no noise*: five artifacts of one set whose main stat and subs are
 * all zero. The set bonus is then the only thing the artifacts contribute, so a measured
 * difference between two builds is the effect under test and nothing else.
 */
function statsFor(charId, weaponId, { refinement = 1, setId = null, level = LEVEL } = {}) {
  const artifacts = {};
  if (setId) {
    for (const slot of ARTIFACT_SLOTS) {
      artifacts[slot] = { setId, slot, rarity: 5, level: 0, main: { key: 'atk', value: 0 }, subs: [] };
    }
  }
  return buildCharacterStats({
    charId, level, ascension: 4, talents: { normal: 1, skill: 1, burst: 1 }, dupes: 0,
    weapon: weaponId ? makeWeapon(weaponId, level, refinement) : null,
    artifacts,
  });
}

/** A stopped instance with one or two players in it and no ambient enemies. */
function world(builds) {
  const inst = new ZoneInstance('mondstadt', 99, { broadcast: () => {} });
  inst.camps.length = 0;
  const players = builds.map((b, i) => {
    const st = b.stats;
    const save = {
      playerId: i + 1, party: [st.charId], activeSlot: 0, zone: 'mondstadt',
      pos: { x: i * 2, y: 6, z: 0, ry: 0 },
    };
    const p = inst.addPlayer(i + 1, `p${i + 1}`, save, { [st.charId]: st });
    p.x = i * 2; p.z = 0; p.y = 6;
    return p;
  });
  inst.stop();                 // drive time by hand from here on
  inst.enemies.clear();
  inst.now = 100;
  inst.events.length = 0;
  return { inst, players, p: players[0] };
}

/** A dummy in front of the player, with enough HP that nothing under test kills it. */
function dummy(inst, p, { level = LEVEL, dx = 1.2 } = {}) {
  const e = inst.spawnEnemy('hilichurl', level, p.x + dx, p.z);
  e.maxHp = 1e9; e.hp = 1e9;
  e.x = p.x + dx; e.z = p.z; e.y = p.y;
  e.state = 'idle'; e.stunned = 0;
  return e;
}

/** Advance the clock and run the per-player upkeep that expires buffs. */
function advance(inst, seconds) {
  inst.now += seconds;
  for (const p of inst.players.values()) inst.updatePlayer(p, seconds);
}

/** Deterministic damage: no crit, no reaction unless the caller asks for one. */
function flatHit(inst, p, e, opts = {}) {
  const st = p.cur();
  const savedCr = st.critRate;
  st.critRate = 0;
  const res = inst.playerHitEnemy(p, e, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: st.charId, ...opts });
  st.critRate = savedCr;
  return res;
}

const buffsFor = (p, tagPart) => p.buffs.filter((b) => (b.tag || '').includes(tagPart));

/* ============================================================================
   1. nothing in items.js is dead: every key is a stat or a trigger
   ========================================================================== */

console.log('\n=== 1. every authored effect has a consumer');
{
  const known = new Set([...STAT_KEYS, ...STATIC_PASSIVE_KEYS, ...PROC_KEYS, ...PROC_SHAPE_KEYS]);
  const orphanW = [];
  for (const w of Object.values(WEAPONS)) {
    for (const k of Object.keys(w.passive || {})) if (!known.has(k)) orphanW.push(`${w.id}.${k}`);
  }
  check('every weapon passive key is either a folded stat or a fired trigger',
    orphanW.length === 0, orphanW.join(', ') || `${Object.keys(WEAPONS).length} weapons clean`);

  const orphanS = [];
  for (const s of Object.values(ARTIFACT_SETS)) {
    for (const part of ['two', 'four']) {
      for (const k of Object.keys(s[part] || {})) if (!known.has(k)) orphanS.push(`${s.id}.${part}.${k}`);
    }
  }
  check('every artifact set bonus key is either a folded stat or a fired trigger',
    orphanS.length === 0, orphanS.join(', ') || `${Object.keys(ARTIFACT_SETS).length} sets clean`);

  // The inverse direction: a trigger this module claims to fire must be claimed by at
  // least one piece of gear, or `procs.js` is carrying code for an effect nobody has.
  const authored = new Set();
  for (const w of Object.values(WEAPONS)) for (const k of Object.keys(w.passive || {})) authored.add(k);
  for (const s of Object.values(ARTIFACT_SETS)) for (const k of [...Object.keys(s.two || {}), ...Object.keys(s.four || {})]) authored.add(k);
  for (const c of Object.values(CHARACTERS)) for (const k of Object.keys(c.passive || {})) authored.add(k);
  const unused = PROC_KEYS.filter((k) => !authored.has(k));
  check('every trigger procs.js implements is claimed by some weapon, set or talent',
    unused.length === 0, unused.join(', ') || `${PROC_KEYS.length} triggers all in use`);

  // And the conditional keys must stay out of the static path, or they would be paid
  // unconditionally — the failure mode that is worse than a missing effect.
  const leaked = PROC_KEYS.filter((k) => STAT_KEYS.includes(k) || STATIC_PASSIVE_KEYS.includes(k));
  check('no conditional key is also a static stat key', leaked.length === 0, leaked.join(', ') || 'clean');

  const conditionalWeapons = Object.values(WEAPONS)
    .filter((w) => Object.keys(w.passive || {}).some((k) => PROC_KEYS.includes(k)));
  check('the nine conditional weapons are all reachable through gearProcs',
    conditionalWeapons.every((w) => {
      const st = statsFor(Object.values(CHARACTERS).find((c) => c.weapon === w.type).id, w.id);
      return gearProcs(st).some((g) => g.src === `w:${w.id}`);
    }), `${conditionalWeapons.length} weapons`);
  if (VERBOSE) console.log('       ' + conditionalWeapons.map((w) => w.id).join(', '));

  // Character talents are the third source and were dead in exactly the same way, so they
  // get exactly the same gate. Every key names the code that reads it: if a talent grows a
  // new key, this map is where the author is forced to say who consumes it.
  const TALENT_CONSUMERS = {
    name: 'ui', desc: 'ui',
    bonus: 'loot.buildCharacterStats', atkSpeed: 'loot.buildCharacterStats',
    healPerHp: 'loot.buildCharacterStats -> healBonus',
    dr: 'entity.takeDamage', shieldDR: 'entity.takeDamage',
    shieldStrength: 'loot.buildCharacterStats',
    staminaMul: 'client/localPlayer',
    headshotBonus: 'zoneInstance.playerHitEnemy',
    lowHpDef: 'procs.liveStats', overhealShield: 'procs.healOverflowToShield',
    energyOnReaction: 'procs.fireProcs', onReactions: 'procs.fireProcs',
    critMoveSpeed: 'procs.fireProcs -> client', duration: 'procs.grant',
    em: 'loot.buildCharacterStats', critRate: 'loot.buildCharacterStats',
    elementalDmg: 'loot.buildCharacterStats',
  };
  const orphanT = [];
  for (const c of Object.values(CHARACTERS)) {
    for (const k of Object.keys(c.passive || {})) if (!TALENT_CONSUMERS[k]) orphanT.push(`${c.id}.${k}`);
  }
  check('every character talent key names the code that consumes it',
    orphanT.length === 0, orphanT.join(', ') || `${Object.keys(CHARACTERS).length} talents clean`);
  check('every character talent is reachable through gearProcs',
    Object.values(CHARACTERS).every((c) => {
      const st = statsFor(c.id, Object.values(WEAPONS).find((w) => w.type === c.weapon).id);
      return gearProcs(st).some((g) => g.src === `c:${c.id}`);
    }), `${Object.keys(CHARACTERS).length} characters`);
}

/* ============================================================================
   2. 施放元素战技后 (windriderEdge, emberCrown 4)
   ========================================================================== */

console.log('\n=== 2. 施放元素战技后攻击力提升');
{
  const st = statsFor('lyra', 'windriderEdge');
  const { inst, p } = world([{ stats: st }]);
  dummy(inst, p);
  const before = liveStats(p, st, inst.now).atk;
  handleSkill(p, inst, { dir: [1, 0, 0] }, () => {});
  const buff = buffsFor(p, 'onSkillAtk')[0];
  check('casting the skill grants the passive as a timed buff', !!buff, buff?.tag);
  check('the buff carries exactly the passive value',
    near(buff?.atkPct, WEAPONS.windriderEdge.passive.onSkillAtk), `${fmt(buff?.atkPct * 100, 1)}%`);
  const after = liveStats(p, st, inst.now).atk;
  check('the wielder\'s live attack rises by that much',
    near(after, before * (1 + buff.atkPct), 0.001), `${fmt(before, 0)} -> ${fmt(after, 0)}`);
  check('the duration is the passive\'s own, not the default',
    near(buff.until - inst.now, WEAPONS.windriderEdge.passive.duration),
    `${fmt(buff.until - inst.now, 1)}s vs default ${PROC_DURATION}s`);

  // Re-casting refreshes rather than stacks: no `stacks` on this passive.
  advance(inst, 3);
  p.cooldowns[`${st.charId}:skill`] = 0;
  handleSkill(p, inst, { dir: [1, 0, 0] }, () => {});
  check('a second cast refreshes one buff instead of stacking two',
    buffsFor(p, 'onSkillAtk').length === 1, `${buffsFor(p, 'onSkillAtk').length} entry`);
  check('the refresh restored the full duration',
    near(buffsFor(p, 'onSkillAtk')[0].until - inst.now, WEAPONS.windriderEdge.passive.duration));

  advance(inst, WEAPONS.windriderEdge.passive.duration + 0.1);
  check('the buff expires on its own clock', buffsFor(p, 'onSkillAtk').length === 0);
  check('attack returns to the unbuffed value',
    near(liveStats(p, st, inst.now).atk, before, 0.001), fmt(liveStats(p, st, inst.now).atk, 0));

  // Refinement has to move the conditional part too, not only static passives.
  const r5 = statsFor('lyra', 'windriderEdge', { refinement: WEAPON_REFINE_MAX });
  check('refinement scales the triggered bonus by refineMul',
    near(procSum(r5, 'onSkillAtk'), procSum(st, 'onSkillAtk') * refineMul(WEAPON_REFINE_MAX), 1e-4),
    `R1 ${fmt(procSum(st, 'onSkillAtk') * 100, 1)}% -> R5 ${fmt(procSum(r5, 'onSkillAtk') * 100, 1)}%`);

  // A set with the same trigger must stack with the weapon's.
  const both = statsFor('lyra', 'windriderEdge', { setId: 'emberCrown' });
  check('a weapon and a 4-piece set with the same trigger both fire and both count',
    near(procSum(both, 'onSkillAtk'),
      WEAPONS.windriderEdge.passive.onSkillAtk + ARTIFACT_SETS.emberCrown.four.onSkillAtk, 1e-4),
    `${fmt(procSum(both, 'onSkillAtk') * 100, 1)}%`);
  const w2 = world([{ stats: both }]);
  dummy(w2.inst, w2.p);
  handleSkill(w2.p, w2.inst, { dir: [1, 0, 0] }, () => {});
  check('and they arrive as two separately-timed entries', buffsFor(w2.p, 'onSkillAtk').length === 2);
}

/* ============================================================================
   3. 击败敌人后, 可叠加 N 层 (emberCleaver)
   ========================================================================== */

console.log('\n=== 3. 击败敌人后攻击力提升，可叠加');
{
  const st = statsFor('ignar', 'emberCleaver');
  const pass = WEAPONS.emberCleaver.passive;
  const { inst, p } = world([{ stats: st }]);
  const base = liveStats(p, st, inst.now).atk;
  for (let i = 0; i < 3; i++) {
    const e = inst.spawnEnemy('hilichurl', LEVEL, p.x + 1, p.z);
    e.hp = 1; e.maxHp = 1;
    inst.onEnemyKilled(e, p);
    advance(inst, 0.5);
    if (i === 0) check('the first kill grants one stack', buffsFor(p, 'onKillAtk').length === 1);
    if (i === 1) check('the second kill grants a second stack', buffsFor(p, 'onKillAtk').length === 2);
  }
  check('a third kill is capped at the passive\'s stack limit',
    buffsFor(p, 'onKillAtk').length === pass.stacks, `${buffsFor(p, 'onKillAtk').length} of ${pass.stacks}`);
  const atk = liveStats(p, st, inst.now).atk;
  check('two stacks multiply, they do not merely add once',
    near(atk, base * (1 + pass.onKillAtk) ** pass.stacks, 0.001),
    `${fmt(base, 0)} -> ${fmt(atk, 0)} (x${fmt(atk / base, 3)})`);
  // Kills at t, t+0.5, t+1, with the clock now at t+1.5. At the ceiling the third kill
  // refreshed the stack expiring soonest (the one from t), so that entry was granted 0.5s
  // ago and the untouched one 1.0s ago — the first kill's timer is gone, not the third's.
  {
    const left = buffsFor(p, 'onKillAtk').map((b) => b.until - inst.now).sort((a, b) => b - a);
    check('the capped kill refreshed the soonest-expiring stack rather than being dropped',
      left.length === pass.stacks && near(left[0], pass.duration - 0.5, 1e-6)
        && near(left[1], pass.duration - 1, 1e-6),
      left.map((v) => fmt(v, 1)).join('/') + `s of ${pass.duration}s`);
  }
  advance(inst, pass.duration + 0.1);
  check('all stacks expire together once no kill refreshes them',
    buffsFor(p, 'onKillAtk').length === 0 && near(liveStats(p, st, inst.now).atk, base, 0.001));
}

/* ============================================================================
   4. 受到伤害后 (ironSpear) and the mitigation it feeds
   ========================================================================== */

console.log('\n=== 4. 受到伤害后防御力提升');
{
  const st = statsFor('volt', 'ironSpear');
  const { inst, p } = world([{ stats: st }]);
  const e = dummy(inst, p);
  const before = liveStats(p, st, inst.now).def;
  const first = inst.damagePlayer(p, 4000, 'physical', 0, e, {});
  check('taking a hit grants the defence buff', buffsFor(p, 'onHitDef').length === 1);
  const after = liveStats(p, st, inst.now).def;
  check('live defence rises by the passive amount',
    near(after, before * (1 + WEAPONS.ironSpear.passive.onHitDef), 0.001),
    `${fmt(before, 0)} -> ${fmt(after, 0)}`);
  const second = inst.damagePlayer(p, 4000, 'physical', 0, e, {});
  check('the *next* hit is mitigated harder because of it', second < first,
    `${fmt(first, 0)} -> ${fmt(second, 0)} damage taken`);
  check('the second hit refreshed rather than stacked the buff',
    buffsFor(p, 'onHitDef').length === 1);
}

/* ============================================================================
   5. 元素爆发后攻速提升 (stormPike) — a buff that changes the attack *cadence*
   ========================================================================== */

console.log('\n=== 5. 元素爆发后攻速提升');
{
  const st = statsFor('volt', 'stormPike');
  const def = CHARACTERS.volt;
  const { inst, p } = world([{ stats: st }]);
  dummy(inst, p);
  p.energy[st.charId] = 999;
  const slow = def.normal.frameTime / liveStats(p, st, inst.now).atkSpeed * 0.85;
  handleBurst(p, inst, {}, () => {});
  const buff = buffsFor(p, 'onBurstSpeed')[0];
  check('the burst grants the attack-speed buff', !!buff, `+${fmt((buff?.atkSpeed || 0) * 100, 1)}%`);
  const fast = def.normal.frameTime / liveStats(p, st, inst.now).atkSpeed * 0.85;
  check('the normal-attack interval actually shortens', fast < slow,
    `${fmt(slow, 3)}s -> ${fmt(fast, 3)}s`);
  p.cooldowns[`${st.charId}:atk`] = 0;
  handleAttack(p, inst, {}, () => {});
  const gap = p.cooldowns[`${st.charId}:atk`] - inst.now;
  check('handleAttack throttles at the buffed rate, not the sheet rate',
    near(gap, fast, 1e-6), `${fmt(gap, 3)}s`);
  advance(inst, WEAPONS.stormPike.passive.duration + 0.1);
  p.cooldowns[`${st.charId}:atk`] = 0;
  handleAttack(p, inst, {}, () => {});
  check('and back to the sheet rate when it expires',
    near(p.cooldowns[`${st.charId}:atk`] - inst.now, slow, 1e-6));
}

/* ============================================================================
   6. 暴击时恢复元素能量 (dawnbreaker)
   ========================================================================== */

console.log('\n=== 6. 暴击时恢复元素能量');
{
  const st = statsFor('lyra', 'dawnbreaker');
  const ctrl = statsFor('lyra', 'travelersBlade');
  for (const s of [st, ctrl]) s.critRate = 1;           // pin the dice
  const runs = [st, ctrl].map((s) => {
    const { inst, p } = world([{ stats: s }]);
    const e = dummy(inst, p);
    p.energy[s.charId] = 0;
    inst.playerHitEnemy(p, e, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: s.charId });
    return p.energy[s.charId];
  });
  const gain = WEAPONS.dawnbreaker.passive.energyOnCrit * (st.er || 1);
  check('a critical hit pays the extra energy the passive promises',
    near(runs[0] - runs[1], gain, 0.01), `${fmt(runs[1], 2)} -> ${fmt(runs[0], 2)} (+${fmt(gain, 2)})`);

  // No crit, no energy: the condition has to be real in both directions.
  st.critRate = 0;
  const { inst, p } = world([{ stats: st }]);
  const e = dummy(inst, p);
  p.energy[st.charId] = 0;
  inst.playerHitEnemy(p, e, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: st.charId });
  check('a non-crit pays only the ordinary on-hit energy',
    near(p.energy[st.charId], 0.8 * (st.er || 1), 0.01), fmt(p.energy[st.charId], 2));
}

/* ============================================================================
   7. 对被冻结/受冰附着的敌人 (frostfeather + frostveil), 瞄准弱点 (polarSight)
   ========================================================================== */

console.log('\n=== 7. per-hit conditions: frozen targets and weak points');
{
  const st = statsFor('kaelen', 'frostfeather');
  const { inst, p } = world([{ stats: st }]);
  const e = dummy(inst, p);

  const clean = flatHit(inst, p, e).total;
  e.aura.auras.set('ice', { gauge: 2, decay: 7.5 });
  const iced = flatHit(inst, p, e).total;
  check('an ice aura alone is enough for 受冰附着',
    near(iced / clean, 1 + WEAPONS.frostfeather.passive.vsFrozen, 0.02), `x${fmt(iced / clean, 3)}`);
  e.aura.auras.clear();
  e.aura.frozenUntil = inst.now + 3;
  const frozen = flatHit(inst, p, e).total;
  check('and the frozen state is too', near(frozen / clean, iced / clean, 0.02), `x${fmt(frozen / clean, 3)}`);
  e.aura.frozenUntil = 0;
  check('a target that is neither gets nothing extra',
    near(flatHit(inst, p, e).total, clean, 1), fmt(clean, 0));

  const both = statsFor('kaelen', 'frostfeather', { setId: 'frostveil' });
  const m = hitMods(both, { aura: { isFrozen: () => true, dominant: () => 'ice' } }, {}, inst.now);
  check('weapon and set stack their frozen damage bonus',
    near(m.bonus, WEAPONS.frostfeather.passive.vsFrozen + ARTIFACT_SETS.frostveil.four.vsFrozen, 1e-6),
    `+${fmt(m.bonus * 100, 0)}%`);
  check('the set also raises crit rate, but only against a truly frozen target',
    near(m.critRate, ARTIFACT_SETS.frostveil.four.critVsFrozen)
    && near(hitMods(both, { aura: { isFrozen: () => false, dominant: () => 'ice' } }, {}, inst.now).critRate, 0),
    `+${fmt(m.critRate * 100, 0)}% crit`);

  const polar = statsFor('kaelen', 'polarSight');
  check('a weak-point hit adds the bow\'s crit damage, an ordinary hit does not',
    near(hitMods(polar, e, { headshot: true }, inst.now).critDmg, WEAPONS.polarSight.passive.headshotCritDmg)
    && near(hitMods(polar, e, {}, inst.now).critDmg, 0),
    `+${fmt(WEAPONS.polarSight.passive.headshotCritDmg * 100, 0)}% crit dmg`);
}

/* ============================================================================
   8. 元素战技命中后的额外范围伤害 (skyPiercer)
   ========================================================================== */

console.log('\n=== 8. 元素战技命中后造成额外范围伤害');
{
  const st = statsFor('volt', 'skyPiercer');
  const ctrl = statsFor('volt', 'ironSpear');
  const totals = [st, ctrl].map((s) => {
    s.critRate = 0;
    const { inst, p } = world([{ stats: s }]);
    const e = dummy(inst, p, { dx: 2 });
    const before = e.hp;
    handleSkill(p, inst, { dir: [1, 0, 0] }, () => {});
    return before - e.hp;
  });
  const expect = liveStats({ buffs: [] }, st, 0).atk * WEAPONS.skyPiercer.passive.skillBurst;
  check('the skill deals its follow-up damage on top of its own hit',
    totals[0] > totals[1], `${fmt(totals[1], 0)} -> ${fmt(totals[0], 0)}`);
  check('the extra is the promised share of attack (within the res/def multipliers)',
    totals[0] - totals[1] > expect * 0.25 && totals[0] - totals[1] < expect * 1.05,
    `+${fmt(totals[0] - totals[1], 0)} vs ${fmt(expect, 0)} raw`);

  // The gate that keeps it from becoming a damage aura: a lingering field reports
  // `kind: 'skill'` every half second and must not be treated as a cast.
  {
    const { inst, p } = world([{ stats: st }]);
    const e = dummy(inst, p);
    const first = flatHit(inst, p, e, { kind: 'skill', element: 'lightning' }).total;
    const followed = p._skillFollowAt;
    check('a field tick that is not a cast triggers no follow-up', followed === undefined,
      `hit for ${fmt(first, 0)}`);
    // ...and two casts inside the gap pay once.
    handleSkill(p, inst, { dir: [1, 0, 0] }, () => {});
    const at = p._skillFollowAt;
    inst.now += SKILL_FOLLOW_GAP / 2;
    p.cooldowns[`${p.cur().charId}:skill`] = 0;
    handleSkill(p, inst, { dir: [1, 0, 0] }, () => {});
    check('two casts inside the follow-up gap pay for one follow-up',
      p._skillFollowAt === at, `${fmt(SKILL_FOLLOW_GAP, 2)}s gap`);
  }
}

/* ============================================================================
   9. 触发元素反应时 (abyssalCodex teamEm, windSong, thunderCall, emberCrown)
   ========================================================================== */

console.log('\n=== 9. 触发元素反应时的全队效果');
{
  // Two players, one instance: 全队 in co-op means everyone here.
  const a = statsFor('seris', 'abyssalCodex');
  const b = statsFor('lyra', 'travelersBlade');
  const { inst, players, p } = world([{ stats: a }, { stats: b }]);
  const e = dummy(inst, p);
  e.aura.auras.set('fire', { gauge: 2, decay: 6 });
  const emBefore = players.map((pl) => liveStats(pl, pl.cur(), inst.now).em);
  const res = flatHit(inst, p, e, { element: 'water', gauge: 1 });
  check('the hit really did react', res.reaction === 'vaporize', res.reaction);
  check('the catalyst\'s passive buffs the whole instance, not just its wielder',
    players.every((pl) => buffsFor(pl, 'teamEm').length === 1));
  const emAfter = players.map((pl) => liveStats(pl, pl.cur(), inst.now).em);
  check('every party member gains the promised mastery',
    players.every((_, i) => near(emAfter[i] - emBefore[i], WEAPONS.abyssalCodex.passive.teamEm)),
    `${fmt(emBefore[1], 0)} -> ${fmt(emAfter[1], 0)} on the teammate`);
  advance(inst, WEAPONS.abyssalCodex.passive.duration + 0.1);
  check('and loses it again when the window closes',
    players.every((pl) => buffsFor(pl, 'teamEm').length === 0));

  // windSong: swirl only, and the swirl damage itself is stronger.
  const wind = statsFor('lyra', 'travelersBlade', { setId: 'windSong' });
  wind.critRate = 0;
  const plain = statsFor('lyra', 'travelersBlade');
  plain.critRate = 0;
  const swirlDmg = [wind, plain].map((s) => {
    const w = world([{ stats: s }]);
    const en = dummy(w.inst, w.p);
    en.aura.auras.set('fire', { gauge: 2, decay: 6 });
    const r = w.inst.playerHitEnemy(w.p, en, { scaling: 0, flatDamage: 0, element: 'wind', gauge: 1, kind: 'normal', charId: s.charId });
    return { total: r.total, reaction: r.reaction, buffs: w.p.buffs.length, p: w.p };
  });
  check('a wind hit on a fire aura swirls', swirlDmg.every((r) => r.reaction === 'swirl'));
  const emTerm = 1 + masteryBonus(plain.em, 'transform');
  const want = (emTerm + ARTIFACT_SETS.windSong.four.swirlBonus) / emTerm;
  check('风歌者之诗 raises the swirl damage itself by its stated amount',
    near(swirlDmg[0].total / swirlDmg[1].total, want, 0.02),
    `x${fmt(swirlDmg[0].total / swirlDmg[1].total, 3)} vs x${fmt(want, 3)}`);
  check('and grants the swirl mastery buff to the team',
    buffsFor(swirlDmg[0].p, 'emOnSwirl').length === 1
    && near(buffsFor(swirlDmg[0].p, 'emOnSwirl')[0].em, ARTIFACT_SETS.windSong.four.emOnSwirl));

  // emberCrown: vaporize/melt only.
  const ember = statsFor('ignar', 'ironGreatsword', { setId: 'emberCrown' });
  const emberCtrl = statsFor('ignar', 'ironGreatsword');
  const vap = [ember, emberCtrl].map((s) => {
    s.critRate = 0;
    const w = world([{ stats: s }]);
    const en = dummy(w.inst, w.p);
    en.aura.auras.set('fire', { gauge: 2, decay: 6 });
    return w.inst.playerHitEnemy(w.p, en, { scaling: 1, element: 'water', gauge: 1, kind: 'normal', charId: s.charId });
  });
  const amp = 1 + masteryBonus(emberCtrl.em, 'amplify');
  const wantVap = (amp + ARTIFACT_SETS.emberCrown.four.vaporizeBonus) / amp;
  check('炽焰之冠 raises 蒸发 damage by its stated amount, on the amplifying term',
    vap[0].reaction === 'vaporize' && near(vap[0].total / vap[1].total, wantVap, 0.02),
    `x${fmt(vap[0].total / vap[1].total, 3)} vs x${fmt(wantVap, 3)}`);

  // thunderCall and volt's own 导电体质 both hand out energy on a reaction and each names a
  // *different* list of reactions, so the energy has to be measured as a delta against a
  // control build without the set. An absolute threshold cannot tell the two apart — and
  // that is precisely how volt's talent was caught paying out on every reaction while its
  // description named 感电/超导.
  const thunder = statsFor('volt', 'ironSpear', { setId: 'thunderCall' });
  const control = statsFor('volt', 'ironSpear');
  const talentE = CHARACTERS.volt.passive.energyOnReaction;
  const setE = ARTIFACT_SETS.thunderCall.four.energyOnReaction;
  const reactEnergy = (st, aura, element) => {
    const w = world([{ stats: st }]);
    const en = dummy(w.inst, w.p);
    if (aura) en.aura.auras.set(aura, { gauge: 2, decay: 6 });
    w.p.energy[st.charId] = 0;
    const r = flatHit(w.inst, w.p, en, { element, gauge: 1 });
    return { key: r.reaction, energy: w.p.energy[st.charId], speed: buffsFor(w.p, 'onReactionSpeed').length };
  };
  // Landing an elemental hit is itself worth energy, and every gain passes through the
  // wielder's 元素充能效率, so both expectations are stated in the same currency: measured
  // against a no-aura hit on the same build, times `er`.
  const baseline = reactEnergy(control, null, 'lightning').energy;
  const er = control.er || 1;
  const rows = [
    // aura,   element,     set fires, talent fires
    ['ice', 'lightning', true, true],    // 超导: on both lists
    ['fire', 'lightning', true, false],  // 超载: the set's list only
    ['fire', 'water', false, false],     // 蒸发: neither
  ];
  for (const [aura, element, setFires, talentFires] of rows) {
    const withSet = reactEnergy(thunder, aura, element);
    const bare = reactEnergy(control, aura, element);
    const fromSet = withSet.energy - bare.energy;
    check(`雷鸣的召唤 ${setFires ? 'fires on' : 'ignores'} ${withSet.key}`,
      withSet.speed === (setFires ? 1 : 0) && near(fromSet, (setFires ? setE : 0) * er, 0.05),
      `speed=${withSet.speed} setEnergy=${fmt(fromSet, 1)} of ${fmt(setE * er, 1)}`);
    check(`导电体质 ${talentFires ? 'fires on' : 'ignores'} ${bare.key}`,
      near(bare.energy - baseline, (talentFires ? talentE : 0) * er, 0.05),
      `talentEnergy=${fmt(bare.energy - baseline, 1)} of ${fmt(talentE * er, 1)}`);
  }
}

/* ============================================================================
   10. 治疗队友后 (dawnHymn)
   ========================================================================== */

console.log('\n=== 10. 治疗队友后全队攻击力提升');
{
  const st = statsFor('aurel', 'travelersBlade', { setId: 'dawnHymn' });
  const mate = statsFor('lyra', 'travelersBlade');
  const { inst, players, p } = world([{ stats: st }, { stats: mate }]);
  dummy(inst, p);
  for (const pl of players) pl.hp = pl.maxHp() * 0.4;
  const before = players.map((pl) => liveStats(pl, pl.cur(), inst.now).atk);
  handleSkill(p, inst, { dir: [1, 0, 0] }, () => {});
  check('the heal fired the set effect', buffsFor(p, 'teamAtk').length === 1);
  check('and it landed on the teammate as well', buffsFor(players[1], 'teamAtk').length === 1);
  const after = players.map((pl) => liveStats(pl, pl.cur(), inst.now).atk);
  check('the whole team\'s attack rises by the stated amount',
    players.every((_, i) => near(after[i] / before[i], 1 + ARTIFACT_SETS.dawnHymn.four.teamAtk, 0.001)),
    `x${fmt(after[1] / before[1], 3)}`);

  // A heal that heals nobody must not pay: everyone at full HP.
  const w = world([{ stats: st }]);
  dummy(w.inst, w.p);
  w.p.hp = w.p.maxHp();
  handleSkill(w.p, w.inst, { dir: [1, 0, 0] }, () => {});
  check('a heal with nothing to heal does not trigger it', buffsFor(w.p, 'teamAtk').length === 0);
}

/* ============================================================================
   11. conditions printed in a tooltip must be enforced (gladiator)
   ========================================================================== */

console.log('\n=== 11. 装备条件: 角斗士的终幕礼');
{
  const sword = statsFor('lyra', 'travelersBlade', { setId: 'gladiator' });
  const catalyst = statsFor('seris', 'apprenticeTome', { setId: 'gladiator' });
  check('a sword user gets the 4-piece normal-attack bonus',
    near(sword.typeBonus.normal - statsFor('lyra', 'travelersBlade').typeBonus.normal,
      ARTIFACT_SETS.gladiator.four.normalDmg, 1e-6),
    `+${fmt(sword.typeBonus.normal * 100, 0)}%`);
  check('a catalyst user does not, because the tooltip says so',
    near(catalyst.typeBonus.normal, statsFor('seris', 'apprenticeTome').typeBonus.normal, 1e-6),
    `+${fmt(catalyst.typeBonus.normal * 100, 0)}%`);
  check('and the panel is told the bonus is inactive rather than silently lying',
    catalyst.activeSets.find((s) => s.setId === 'gladiator')?.fourActive === false
    && sword.activeSets.find((s) => s.setId === 'gladiator')?.fourActive === true);
  check('an inactive 4-piece contributes no triggers either',
    gearProcs(catalyst).every((g) => g.src !== 's:gladiator'));
}

/* ============================================================================
   12. the client is told: one BUFF event per proc, tagged and named
   ========================================================================== */

console.log('\n=== 12. the HUD gets told');
{
  const st = statsFor('lyra', 'windriderEdge');
  const { inst, p } = world([{ stats: st }]);
  dummy(inst, p);
  inst.events.length = 0;
  handleSkill(p, inst, { dir: [1, 0, 0] }, () => {});
  const buffEvents = inst.events.filter((ev) => ev.t === S2C.BUFF);
  check('firing a proc emits exactly one BUFF event', buffEvents.length === 1);
  const d = buffEvents[0]?.d || {};
  check('it is marked as gear so the client never mistakes it for food', d.kind === 'gear', d.kind);
  check('it names the weapon, so the chip is readable', d.name === WEAPONS.windriderEdge.name, d.name);
  check('it carries the tag the client dedupes on, and the stack count',
    !!d.tag && d.n === 1, `${d.tag} x${d.n}`);
  check('and the duration in seconds, not an absolute server time',
    d.duration === WEAPONS.windriderEdge.passive.duration, `${d.duration}s`);

  // Stack counts have to reach the HUD too, or the chip cannot say x2.
  const cleaver = statsFor('ignar', 'emberCleaver');
  const w = world([{ stats: cleaver }]);
  const ns = [];
  for (let i = 0; i < 2; i++) {
    w.inst.events.length = 0;
    const en = w.inst.spawnEnemy('hilichurl', LEVEL, w.p.x + 1, w.p.z);
    en.hp = 1;
    w.inst.onEnemyKilled(en, w.p);
    ns.push(w.inst.events.filter((ev) => ev.t === S2C.BUFF)[0]?.d?.n);
  }
  check('the stack count the client shows counts up', ns.join(',') === '1,2', ns.join(','));
}

/* ============================================================================
   13. nothing regressed: food buffs and skill buffs still compose
   ========================================================================== */

console.log('\n=== 13. the pre-existing buff sources still work the same');
{
  const st = statsFor('lyra', 'windriderEdge');
  const { inst, p } = world([{ stats: st }]);
  const base = liveStats(p, st, inst.now).atk;
  p.buffs.push({ kind: 'food', source: 'sweetMadame', until: inst.now + 180, atkPct: 0.2, critRate: 0.1 });
  const fed = liveStats(p, st, inst.now);
  check('a food buff still multiplies attack the way it always did',
    near(fed.atk, base * 1.2, 0.001), `${fmt(base, 0)} -> ${fmt(fed.atk, 0)}`);
  check('and still adds crit rate', near(fed.critRate, st.critRate + 0.1, 1e-9));
  handleSkill(p, inst, { dir: [1, 0, 0] }, () => {});
  const both = liveStats(p, st, inst.now).atk;
  check('food and gear compose multiplicatively, as the old loop did',
    near(both, base * 1.2 * (1 + WEAPONS.windriderEdge.passive.onSkillAtk), 0.001),
    `x${fmt(both / base, 3)}`);
  check('eating does not clear a gear buff', buffsFor(p, 'onSkillAtk').length === 1);
}

/* ============================================================================
   14. 角色天赋: the four that were written in characters.js and read nowhere
   ========================================================================== */

console.log('\n=== 14. 角色天赋的条件效果');
{
  // 烈焰淬炼 (ignar): a *state*, not a trigger — it has to appear and vanish with the bar.
  const ig = statsFor('ignar', 'emberCleaver');
  const w1 = world([{ stats: ig }]);
  const full = liveStats(w1.p, ig, w1.inst.now);
  check('生命值低于 50% 之前防御力不变',
    near(full.def, ig.def, 1e-9) && !full.lowHp, fmt(full.def, 0));
  w1.p.hp = w1.p.maxHp() * (LOW_HP - 0.05);
  const hurt = liveStats(w1.p, ig, w1.inst.now);
  check('烈焰淬炼 raises defence once the bar drops below its stated threshold',
    near(hurt.def, ig.def * (1 + CHARACTERS.ignar.passive.lowHpDef), 0.001) && hurt.lowHp,
    `${fmt(full.def, 0)} -> ${fmt(hurt.def, 0)}`);
  w1.p.hp = w1.p.maxHp();
  check('and it goes away again when healed back up',
    near(liveStats(w1.p, ig, w1.inst.now).def, ig.def, 1e-9));
  const other = statsFor('lyra', 'windriderEdge');
  const w1b = world([{ stats: other }]);
  w1b.p.hp = w1b.p.maxHp() * 0.2;
  check('a character without the talent gets nothing for being nearly dead',
    near(liveStats(w1b.p, other, w1b.inst.now).def, other.def, 1e-9));

  // 潮汐共鸣 (seris): 生命值上限每 1000 点提升 2% 治疗加成.
  const se = statsFor('seris', 'tidecaller');
  const want = (se.maxHp / 1000) * CHARACTERS.seris.passive.healPerHp;
  check('潮汐共鸣 turns max HP into healing bonus at the stated rate',
    se.healBonus >= want - 1e-6, `healBonus ${fmt(se.healBonus * 100, 1)}% >= ${fmt(want * 100, 1)}% from ${fmt(se.maxHp, 0)} HP`);
  const w2 = world([{ stats: se }]);
  w2.p.hp = 1;
  const heal = CHARACTERS.seris.skill.heal;
  const raw = (heal.hpScaling || 0) * se.maxHp + (heal.atkScaling || 0) * se.atk + (heal.flat || 0);
  handleSkill(w2.p, w2.inst, { dir: [1, 0, 0] }, () => {});
  check('and the bonus is really applied to the heal the skill performs',
    w2.p.hp - 1 > raw * (1 + want) - 1, `healed ${fmt(w2.p.hp - 1, 0)} vs raw ${fmt(raw, 0)}`);

  // 大地之盾 (terra): only while a shield stands.
  const te = statsFor('terra', 'stonebreaker');
  const w3 = world([{ stats: te }]);
  const bare = w3.p.takeDamage(1000, w3.inst.now);
  check('大地之盾 does nothing without a shield',
    near(bare, 1000 * (1 - (te.dr || 0)), 0.001), `${fmt(bare, 0)} to HP`);
  w3.p.shieldHp = 100; w3.p.shieldUntil = w3.inst.now + 10;
  const shielded = w3.p.takeDamage(1000, w3.inst.now);
  const wantShielded = 1000 * (1 - (te.dr || 0) - CHARACTERS.terra.passive.shieldDR) - 100;
  check('with a shield up the hit is reduced by the stated amount before the shield eats it',
    near(shielded, wantShielded, 0.001), `${fmt(bare, 0)} -> ${fmt(shielded, 0)} to HP`);
  check('and the shield absorbed the post-reduction damage, not the raw amount',
    near(w3.p.shieldHp, 0, 1e-9));

  // 圣咏回响 (aurel): the wasted half of a heal becomes a team shield.
  const au = statsFor('aurel', 'travelersBlade');
  const mate = statsFor('lyra', 'windriderEdge');
  const w4 = world([{ stats: au }, { stats: mate }]);
  for (const pl of w4.players) { pl.x = 0; pl.z = 0; pl.hp = pl.maxHp(); }
  const h = CHARACTERS.aurel.skill.heal;
  const total = ((h.hpScaling || 0) * au.maxHp + (h.atkScaling || 0) * au.atk + (h.flat || 0)) * (1 + (au.healBonus || 0));
  handleSkill(w4.p, w4.inst, { dir: [1, 0, 0] }, () => {});
  const overflow = total * w4.players.length;   // nobody was missing any HP
  const wantShield = overflow * CHARACTERS.aurel.passive.overhealShield * (1 + (au.shieldStrength || 0));
  check('healing a full-HP team is not wasted: 圣咏回响 converts the overflow',
    w4.p.shieldHp > 0 && near(w4.p.shieldHp, wantShield, 1),
    `${fmt(w4.p.shieldHp, 0)} shield from ${fmt(overflow, 0)} overflow`);
  check('and the shield covers the teammate too, because the text says 全队',
    near(w4.players[1].shieldHp, w4.p.shieldHp, 1e-9));
  const w5 = world([{ stats: au }]);
  w5.p.hp = 1;
  handleSkill(w5.p, w5.inst, { dir: [1, 0, 0] }, () => {});
  check('a heal that is actually needed heals instead of shielding',
    w5.p.hp > 1 && w5.p.shieldHp < wantShield, `hp ${fmt(w5.p.hp, 0)}, shield ${fmt(w5.p.shieldHp, 0)}`);

  // 疾影 (nyx): move speed is the client's number, so it travels as a buff.
  const ny = statsFor('nyx', 'travelersBlade');
  const w6 = world([{ stats: ny }]);
  const en = dummy(w6.inst, w6.p);
  ny.critRate = 1;
  w6.inst.events.length = 0;
  w6.inst.playerHitEnemy(w6.p, en, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: ny.charId });
  const ms = buffsFor(w6.p, 'critMoveSpeed')[0];
  check('a crit grants 疾影 as a move-speed buff', !!ms && near(ms.moveSpeed, CHARACTERS.nyx.passive.critMoveSpeed),
    `${fmt((ms?.moveSpeed || 0) * 100, 0)}% for ${fmt((ms?.until || 0) - w6.inst.now, 1)}s`);
  check('for the duration the talent names, not the default',
    near(ms.until - w6.inst.now, CHARACTERS.nyx.passive.duration));
  const ev = w6.inst.events.find((e) => e.t === S2C.BUFF && e.d.moveSpeed);
  check('and it is broadcast, because the browser owns the character\'s motion',
    !!ev && near(ev.d.moveSpeed, CHARACTERS.nyx.passive.critMoveSpeed), ev?.d?.name);
  advance(w6.inst, CHARACTERS.nyx.passive.duration + 0.1);
  check('the speed buff expires like any other', buffsFor(w6.p, 'critMoveSpeed').length === 0);
}

/* ============================================================================
   15. 结晶护盾是有元素的: the shard remembers what it was made of

   The same defect as section 1, one layer up. `resolveReaction()` returned
   `shieldElement` from two branches — the aura for an incoming geo hit, the incoming
   element for a geo aura — and *nobody read it*. Every crystallize shard, every geo
   skill shield and every 圣咏回响 overflow shield was therefore the same element-blind
   gold bar that ate physical, fire and its own element at exactly the same rate, which
   is the mirror image of the enemy shield bug `tools/enemy-check.mjs` section 7 covers.
   Both directions now go through one function, `shieldBreakMul`, so «a shield resists
   the element it is made of and gives way to what reacts with it» is one rule.
   ========================================================================== */

console.log('\n=== 15. 结晶护盾的元素');
{
  const ly = statsFor('lyra', 'windriderEdge');   // no dr, no shieldDR: the shield is the only term

  /** Aura the dummy up with one element, then crystallise it with a geo hit. */
  const shard = (aura) => {
    const w = world([{ stats: ly }]);
    const e = dummy(w.inst, w.p);
    if (aura) flatHit(w.inst, w.p, e, { element: aura, gauge: 1 });
    flatHit(w.inst, w.p, e, { element: 'earth', gauge: 1 });
    return w;
  };

  const wf = shard('fire');
  const wantShard = ly.maxHp * REACTIONS.crystallize.shield * (1 + (ly.shieldStrength || 0));
  check('a geo hit on a burning enemy grants a shield',
    wf.p.shieldHp > 0 && near(wf.p.shieldHp, wantShard, 1),
    `${fmt(wf.p.shieldHp, 0)} shield (28% of ${fmt(ly.maxHp, 0)} HP)`);
  check('...made of the element it crystallised, not of nothing',
    wf.p.shieldElement === 'fire', `shieldElement ${wf.p.shieldElement}`);
  check('...and freezing the same enemy instead gives an ice shard, so it is the aura that decides',
    shard('ice').p.shieldElement === 'ice');
  const wnone = shard(null);
  check('a geo hit on a clean enemy grants nothing at all (the control)',
    wnone.p.shieldHp === 0 && wnone.p.shieldElement === null,
    `${fmt(wnone.p.shieldHp, 0)} shield`);

  // The consumer. Without this the label above is decoration.
  const rate = (element, hp = 100, dmg = 40) => {
    const w = world([{ stats: ly }]);
    w.p.grantShield(hp, w.inst.now + 12, 'fire', w.inst.now);
    const hp0 = w.p.hp;
    const out = {};
    const toBody = w.p.takeDamage(dmg, w.inst.now, element, out);
    return { w, out, toBody, drained: hp - w.p.shieldHp, bodyMoved: hp0 - w.p.hp };
  };
  for (const [el, want] of [['fire', 0.5], ['water', 2.0], ['physical', 1.0]]) {
    const r = rate(el);
    check(`a ${el} hit of 40 charges a fire shield at x${want}`,
      near(r.drained, 40 * want, 1e-6) && near(r.out.shieldMul, want, 1e-9),
      `drained ${fmt(r.drained, 1)}, mul ${fmt(r.out.shieldMul, 2)}`);
    check('...and the rate is the one shieldBreakMul states, from the reaction table',
      near(shieldBreakMul(el, 'fire'), want, 1e-9));
    check('...while the body took nothing, because the shield still stands',
      near(r.bodyMoved, 0, 1e-9) && near(r.toBody, 0, 1e-9) && r.w.p.shieldHp > 0,
      `hp -${fmt(r.bodyMoved, 1)}`);
  }
  check('the same element is the cheapest and a reacting one the dearest, or the label buys nothing',
    shieldBreakMul('fire', 'fire') === SHIELD_SAME_ELEMENT_MUL
    && shieldBreakMul('fire', 'fire') < 1 && shieldBreakMul('water', 'fire') >= 1.5,
    `same x${fmt(shieldBreakMul('fire', 'fire'), 2)}, vaporize x${fmt(shieldBreakMul('water', 'fire'), 2)}`);

  const exact = rate('water', 100, 50);   // 50 x2.0 = exactly the 100 points on the bar
  check('a hit that empties the shield exactly costs no HP, because absorbed is converted back',
    near(exact.bodyMoved, 0, 1e-9) && exact.w.p.shieldHp === 0,
    `hp -${fmt(exact.bodyMoved, 2)}, absorbed ${fmt(exact.out.absorbed, 1)}`);
  check('...and the break is reported, so the client can play 护盾破碎',
    exact.out.shieldBroke === true);
  check('...and the broken shield forgets its element rather than tinting the next one',
    exact.w.p.shieldElement === null);
  const over = rate('water', 100, 100);   // 100 x2.0 = 200 vs a 100-point bar
  check('the overflow of a shield-breaking hit reaches HP, once, at the normal rate',
    near(over.bodyMoved, 50, 1e-6) && near(over.out.absorbed, 50, 1e-6),
    `${fmt(over.out.absorbed, 0)} absorbed, ${fmt(over.bodyMoved, 0)} to HP`);

  // A geo character's own shield: their element, through the same door.
  const te = statsFor('terra', 'stonebreaker');
  const w7 = world([{ stats: te }]);
  handleSkill(w7.p, w7.inst, { dir: [1, 0, 0] }, () => {});
  check('磐岩壁垒 puts up a shield made of 忒拉\'s own element',
    w7.p.shieldHp > 0 && w7.p.shieldElement === 'earth',
    `${fmt(w7.p.shieldHp, 0)} ${w7.p.shieldElement} shield`);
  const strong = w7.p.shieldHp;
  check('a weaker shard does not replace the standing shield...',
    w7.p.grantShield(strong * 0.2, w7.inst.now + 12, 'fire', w7.inst.now) === false);
  check('...nor relabel it, which would silently change what the next hit costs',
    w7.p.shieldElement === 'earth' && near(w7.p.shieldHp, strong, 1e-9));
  check('a stronger one does both',
    w7.p.grantShield(strong * 2, w7.inst.now + 12, 'fire', w7.inst.now) === true
    && w7.p.shieldElement === 'fire');

  // Expiry, and the wire.
  const w8 = world([{ stats: ly }]);
  w8.p.grantShield(500, w8.inst.now + 2, 'ice', w8.inst.now);
  advance(w8.inst, 3);
  check('an expired shield is cleared by the upkeep, element and all',
    w8.p.shieldHp === 0 && w8.p.shieldElement === null,
    `${fmt(w8.p.shieldHp, 0)} / ${w8.p.shieldElement}`);
  // The wire, on the instance's own clock. `serialize` used to gate both shield fields on
  // `this.shieldUntil > Date.now() / 1000`, and `inst.now` is *seconds since instance start*
  // — so the comparison was false for every shield that has ever existed and the HUD bar was
  // 0 % wide no matter what the simulation said. `tools/shield-ui.mjs` measured the pixels
  // and found it; this is the assertion that keeps it found.
  const wire = world([{ stats: ly }]);
  wire.p.grantShield(500, wire.inst.now + 30, 'lightning', wire.inst.now);
  const wired = wire.p.serialize();
  check('a shield the simulation counts is on the wire, in instance time, not wall-clock time',
    wired.sh === 500 && wired.she === 'lightning', `sh=${wired.sh} she=${wired.she}`);
  check('...and the instance clock really is small, which is what the old wall-clock gate got wrong',
    wire.inst.now < 1e6 && Date.now() / 1000 > 1e9, `inst.now=${fmt(wire.inst.now, 0)}`);
  advance(wire.inst, 31);
  const expired = wire.p.serialize();
  check('...and once the upkeep clears it the wire reports no shield and no element',
    expired.sh === 0 && expired.she === null);

  // The event. A fully absorbed hit used to emit *nothing*.
  const w9 = world([{ stats: ly }]);
  const foe = dummy(w9.inst, w9.p);
  w9.p.grantShield(4000, w9.inst.now + 12, 'fire', w9.inst.now);
  const hp0 = w9.p.hp;
  w9.inst.events.length = 0;
  w9.inst.damagePlayer(w9.p, 300, 'water', 0, foe, {});
  const dmgEv = w9.inst.events.find((e) => e.t === S2C.DAMAGE)?.d ?? null;
  check('a hit the shield eats whole still tells the client something happened',
    !!dmgEv && dmgEv.absorbed > 0, dmgEv ? `amount ${dmgEv.amount}, absorbed ${dmgEv.absorbed}` : 'no event');
  check('...with amount 0 and the multiplier, so the HUD shows 护盾被克制 instead of a bare 0',
    !!dmgEv && dmgEv.amount === 0 && near(dmgEv.shieldMul, 2.0, 1e-9) && !dmgEv.shieldBroke);
  check('...and the health bar did not move',
    near(w9.p.hp, hp0, 1e-9) && w9.p.shieldHp < 4000, `shield ${fmt(w9.p.shieldHp, 0)}`);
  const w10 = world([{ stats: ly }]);
  const foe2 = dummy(w10.inst, w10.p);
  w10.inst.events.length = 0;
  w10.inst.damagePlayer(w10.p, 300, 'water', 0, foe2, {});
  const bareEv = w10.inst.events.find((e) => e.t === S2C.DAMAGE)?.d ?? null;
  check('an unshielded hit carries no shield fields at all (the control)',
    !!bareEv && bareEv.amount > 0 && bareEv.absorbed === undefined
    && bareEv.shieldMul === undefined && bareEv.shieldBroke === undefined,
    bareEv ? `amount ${bareEv.amount}` : 'no event');

  // 圣咏回响's overflow shield goes through the same grant, so it is labelled too.
  const au = statsFor('aurel', 'travelersBlade');
  const w11 = world([{ stats: au }, { stats: statsFor('lyra', 'windriderEdge') }]);
  for (const pl of w11.players) { pl.x = 0; pl.z = 0; pl.hp = pl.maxHp(); }
  handleSkill(w11.p, w11.inst, { dir: [1, 0, 0] }, () => {});
  check('the overflow shield is made of the healer\'s element, on every player it covers',
    w11.p.shieldElement === CHARACTERS.aurel.element
    && w11.players[1].shieldElement === CHARACTERS.aurel.element,
    `${w11.p.shieldElement} / ${w11.players[1].shieldElement}`);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails);
