// The conditional half of gear: weapon passives and 4-piece artifact sets whose effect
// has a *trigger* instead of a constant value.
//
// `buildCharacterStats` can only fold in what is always true — "重击伤害提升 15%" is a
// number it can add to `typeBonus.charged` once and forget. Nine of the fifteen weapons
// and six of the eight artifact sets are not like that: 施放战技后, 击败敌人后, 受到伤害后,
// 瞄准命中弱点, 对被冻结的敌人, 触发反应时, 治疗队友后. Those keys are deliberately absent
// from `ZERO()`, so `addStat` drops them, so for a long time every one of them was a
// promise written in `items.js` and read by nothing — `desc`/`fourDesc` text describing
// effects the simulation did not have. This module is the missing consumer.
//
// Three shapes of effect, three entry points:
//
//   fireProcs(inst, player, st, event, ctx)  an event happened → push a timed buff,
//                                            hand out energy, or buff the whole team
//   liveStats(player, st, now)               fold the timed buffs onto the stat block
//   hitMods(st, enemy, opts, now)            conditions true only for *this* hit
//                                            (target frozen, weak point, reaction kind)
//
// It is deliberately one module for both weapons and sets: `vsFrozen` appears on
// 霜羽长弓 and on 霜华之帷, and a player wearing both should get both. Splitting the
// layer per gear kind is what makes such an overlap accidentally exclusive.
//
// Runs in `shared/` because the simulation has two hosts (server instance and browser
// solo mode) and a conditional bonus that only exists online is a balance fork.

import { WEAPONS, ARTIFACT_SETS } from '../data/items.js';
import { CHARACTERS } from '../data/characters.js';
import { S2C } from '../protocol.js';

/** Duration for a triggered buff whose effect names none. */
export const PROC_DURATION = 6;

/**
 * Every conditional key this module actually consumes.
 *
 * Exported so `tools/proc-check.mjs` can assert the invariant that the whole bug class
 * violated: a key in `items.js` is either a stat `buildCharacterStats` folds in, or a
 * trigger listed here, or one of the three shape fields. Anything else is a promise in a
 * tooltip with no code behind it — which is exactly how nine weapons and six sets came to
 * describe effects the game did not have.
 */
export const PROC_KEYS = Object.freeze([
  'onSkillAtk', 'onBurstSpeed', 'onKillAtk', 'onHitDef', 'energyOnCrit',
  'teamEm', 'emOnSwirl', 'energyOnReaction', 'onReactionSpeed', 'teamAtk',
  'vsFrozen', 'critVsFrozen', 'headshotCritDmg', 'vaporizeBonus', 'swirlBonus',
  'skillBurst',
  // Character talents. Same shape, same triggers, same reason they were dead.
  'lowHpDef', 'overhealShield', 'critMoveSpeed',
]);

/** Fields that describe the *shape* of an effect rather than a bonus. */
export const PROC_SHAPE_KEYS = Object.freeze(['element', 'duration', 'stacks', 'onReactions']);

/** 生命值低于 X 时: the threshold 烈焰淬炼 names in its own description. */
export const LOW_HP = 0.5;

/** Amplifying reactions that 炽焰之冠 boosts. */
const VAPORIZE_REACTIONS = new Set(['vaporize', 'melt']);

/**
 * Every conditional-effect source a character carries: its weapon passive (already
 * scaled by refinement in `weaponStats`) and each 4-piece set bonus.
 *
 * Returned fresh each call rather than memoised on `st`: the stats object is handed to
 * the client as-is by `/api/char`, and a cache field there would ship to the browser.
 * The array is at most two entries long.
 */
export function gearProcs(st) {
  if (!st) return [];
  const out = [];
  // A character's own talent is a third source of exactly the same shape. Four of the
  // eight were dead in exactly the same way the weapons were (`lowHpDef`, `healPerHp`,
  // `shieldDR`, `overhealShield` were written in `characters.js` and read nowhere), and a
  // fifth — volt's 8 energy — fired on every reaction while its text named two.
  const talent = CHARACTERS[st.charId]?.passive;
  if (talent) out.push({ src: `c:${st.charId}`, label: talent.name || '天赋', e: talent });
  if (st.weaponPassive) {
    out.push({ src: `w:${st.weaponId || 'weapon'}`, label: WEAPONS[st.weaponId]?.name || '武器被动', e: st.weaponPassive });
  }
  // 元素共鸣 is a fourth source of the same shape, attached to the stat block by
  // `applyPartyResonance`. Two of the eight resonance effects are conditional
  // (`critVsFrozen`, `energyOnReaction`), and routing them through here means they reuse
  // the consumers a weapon passive already has instead of growing a parallel path.
  for (const r of st.resonance || []) out.push({ src: r.id, label: r.name, e: r.e });
  for (const s of st.activeSets || []) {
    if (s.pieces < 4 || s.fourActive === false) continue;
    const set = ARTIFACT_SETS[s.setId];
    if (set?.four) out.push({ src: `s:${s.setId}`, label: set.name, e: set.four });
  }
  return out;
}

/** Sum one conditional key across every source, so a weapon and a set stack. */
export function procSum(st, key) {
  let total = 0;
  for (const { e } of gearProcs(st)) if (e[key]) total += e[key];
  return total;
}

/* ------------------------------------------------------------- timed buffs -- */

/**
 * Push (or refresh) one timed buff and tell the client about it.
 *
 * `tag` identifies the *source of the effect*, not the instance: that is what makes
 * stacking correct. Below the ceiling a trigger adds an entry; at the ceiling it
 * refreshes the entry that expires soonest, so a "可叠加 2 层" passive is worth exactly
 * two stacks no matter how fast the player kills.
 */
function grant(inst, player, tag, label, stat, dur, maxStacks = 1) {
  const now = inst.now;
  const same = player.buffs.filter((b) => b.tag === tag);
  let n;
  if (same.length >= maxStacks) {
    let soonest = same[0];
    for (const b of same) if (b.until < soonest.until) soonest = b;
    soonest.until = now + dur;
    n = same.length;
  } else {
    player.buffs.push({ kind: 'gear', tag, label, until: now + dur, ...stat });
    n = same.length + 1;
  }
  player.dirty = true;
  inst.emit?.(S2C.BUFF, {
    playerId: player.playerId, kind: 'gear', tag, name: label, n,
    duration: dur, ...stat,
  });
  return tag;
}

/**
 * 全队 effects. In co-op that means every player in the instance, not just the
 * caster's own four characters — the same reading the genre uses, and the reason the
 * buff lands on the `PlayerEntity` (which is per player) rather than per character.
 */
function grantTeam(inst, player, tag, label, stat, dur) {
  if (!inst.players?.size) return grant(inst, player, tag, label, stat, dur);
  for (const p of inst.players.values()) grant(inst, p, tag, label, stat, dur);
  return tag;
}

/**
 * Fire the gear triggers for one event.
 *
 * Events: `skill`, `burst`, `kill`, `hurt`, `crit`, `reaction` (ctx.reaction = key),
 * `heal`. Returns the tags that fired — the engine ignores the return value, the
 * probes assert on it.
 */
export function fireProcs(inst, player, st, event, ctx = {}) {
  if (!inst || !player || !st) return [];
  const charId = ctx.charId || st.charId || player.charId;
  const fired = [];
  for (const { src, label, e } of gearProcs(st)) {
    const dur = e.duration || PROC_DURATION;
    switch (event) {
      case 'skill':
        if (e.onSkillAtk) fired.push(grant(inst, player, `${src}:onSkillAtk`, label, { atkPct: e.onSkillAtk }, dur));
        break;
      case 'burst':
        if (e.onBurstSpeed) fired.push(grant(inst, player, `${src}:onBurstSpeed`, label, { atkSpeed: e.onBurstSpeed }, dur));
        break;
      case 'kill':
        if (e.onKillAtk) fired.push(grant(inst, player, `${src}:onKillAtk`, label, { atkPct: e.onKillAtk }, dur, e.stacks || 1));
        break;
      case 'hurt':
        if (e.onHitDef) fired.push(grant(inst, player, `${src}:onHitDef`, label, { defPct: e.onHitDef }, dur));
        break;
      case 'crit':
        if (e.energyOnCrit) {
          player.addEnergy(charId, e.energyOnCrit);
          fired.push(`${src}:energyOnCrit`);
        }
        // Movement speed is the client's number (`localPlayer` owns the character's
        // motion), so the simulation grants it as a buff and the browser reads the BUFF
        // event. That keeps 疾影's "暴击后移动速度提升" honest without asking the server
        // to authorise footsteps.
        if (e.critMoveSpeed) fired.push(grant(inst, player, `${src}:critMoveSpeed`, label, { moveSpeed: e.critMoveSpeed }, dur));
        break;
      case 'reaction': {
        const key = ctx.reaction;
        if (e.teamEm) fired.push(grantTeam(inst, player, `${src}:teamEm`, label, { em: e.teamEm }, dur));
        if (e.emOnSwirl && key === 'swirl') fired.push(grantTeam(inst, player, `${src}:emOnSwirl`, label, { em: e.emOnSwirl }, dur));
        // `onReactions` is the effect's own list of qualifying reactions, straight from the
        // description. Written as data rather than as an `if` in here so the text and the
        // condition cannot drift: 导电体质 says 感电/超导 and now that is what it checks.
        if (!e.onReactions || e.onReactions.includes(key)) {
          if (e.energyOnReaction) { player.addEnergy(charId, e.energyOnReaction); fired.push(`${src}:energyOnReaction`); }
          if (e.onReactionSpeed) fired.push(grant(inst, player, `${src}:onReactionSpeed`, label, { atkSpeed: e.onReactionSpeed }, dur));
        }
        break;
      }
      case 'heal':
        if (e.teamAtk) fired.push(grantTeam(inst, player, `${src}:teamAtk`, label, { atkPct: e.teamAtk }, dur));
        break;
      default:
        break;
    }
  }
  return fired;
}

/**
 * The stat block as it stands *right now*, with the timed buffs folded in.
 *
 * `atkPct` stays multiplicative because that is what the pre-existing food/skill buff
 * loop in `playerHitEnemy` did, and changing the composition rule while adding sources
 * would have quietly rebalanced every dish in the game.
 */
export function liveStats(player, st, now = 0) {
  const out = {
    atk: st.atk, def: st.def, em: st.em, maxHp: st.maxHp,
    critRate: st.critRate, critDmg: st.critDmg, atkSpeed: st.atkSpeed || 1,
  };
  // 烈焰淬炼: a *state* rather than a trigger, so it is read here instead of being
  // granted as a timed buff — the bonus has to appear and vanish with the health bar.
  if (st.lowHpDef && player && player.hp > 0 && player.hp < LOW_HP * (player.maxHp?.() ?? st.maxHp)) {
    out.def *= 1 + st.lowHpDef;
    out.lowHp = true;
  }
  if (!player?.buffs?.length) return out;
  let atkMul = 1, defMul = 1, speedMul = 1;
  for (const b of player.buffs) {
    if (b.until <= now) continue;
    if (b.atkPct) atkMul *= 1 + b.atkPct;
    if (b.defPct) defMul *= 1 + b.defPct;
    if (b.atkSpeed) speedMul *= 1 + b.atkSpeed;
    if (b.em) out.em += b.em;
    if (b.critRate) out.critRate += b.critRate;
    if (b.critDmg) out.critDmg += b.critDmg;
  }
  out.atk *= atkMul;
  out.def *= defMul;
  out.atkSpeed *= speedMul;
  return out;
}

/* ----------------------------------------------------------- per-hit gates -- */

/**
 * Conditions that can only be judged against the target of a single hit.
 *
 * `vsFrozen` reads "对被冻结或受冰附着的敌人" and so accepts an ice aura as well as the
 * frozen state; `critVsFrozen` reads "攻击被冻结的敌人时" and demands the real thing.
 * Both are summed across sources, so 霜羽长弓 + 霜华之帷 is +40 % on a frozen target.
 */
export function hitMods(st, enemy, opts = {}, now = 0) {
  const mods = { bonus: 0, critRate: 0, critDmg: 0, reactionBonus: 0 };
  if (!st) return mods;
  const frozen = !!enemy?.aura?.isFrozen?.(now);
  const iced = frozen || enemy?.aura?.dominant?.() === 'ice';
  if (iced) mods.bonus += procSum(st, 'vsFrozen');
  if (frozen) mods.critRate += procSum(st, 'critVsFrozen');
  if (opts.headshot) mods.critDmg += procSum(st, 'headshotCritDmg');
  if (VAPORIZE_REACTIONS.has(opts.reaction)) mods.reactionBonus += procSum(st, 'vaporizeBonus');
  if (opts.reaction === 'swirl') mods.reactionBonus += procSum(st, 'swirlBonus');
  return mods;
}

/** Minimum gap between two 穿云之枪-style skill follow-ups on the same player. */
export const SKILL_FOLLOW_GAP = 0.5;

/* ------------------------------------------------------------ heal overflow -- */

/**
 * 圣咏回响: "治疗溢出的部分转化为全队护盾".
 *
 * Called by every place that heals (`handleSkill`, `handleBurst`, the healing field tick)
 * with the overflow it threw away. Overhealing is otherwise pure waste, which is exactly
 * why a healer's talent is written against it — and why the effect was worth implementing
 * rather than deleting from the description.
 *
 * The shield is the same object a crystallize shield uses, so 磐岩之心's 护盾强效 and
 * 大地之盾's shield-DR both apply to it without a second code path.
 */
export function healOverflowToShield(inst, caster, st, overflow) {
  if (!st?.overhealShield || overflow <= 0) return 0;
  const amount = overflow * st.overhealShield * (1 + (st.shieldStrength || 0));
  for (const p of inst.players.values()) {
    // The healer's element, not the receiver's: this shield is made of the overflow of *their*
    // heal, and every player in the radius gets the same one.
    p.grantShield(amount, inst.now + 12, st.element, inst.now);
  }
  return amount;
}
