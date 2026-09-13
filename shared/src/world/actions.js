// Player actions against a live `ZoneInstance`: movement validation, normal and
// charged attacks, elemental skills, elemental bursts.
//
// These used to live inside `server/src/ws/gateway.js`, which made them reachable
// only over a WebSocket. They are pure functions of (entity, instance, payload):
// nothing here reads a socket, a request or the database, so the browser can host
// them for 单机 mode and get bit-identical combat — the same combo rotation, the
// same cooldown throttle, the same anti-teleport rule. The gateway keeps the parts
// that genuinely are transport concerns (auth, rate limits, chat, parties).

import { Projectile, r2, regenCharges } from './entity.js';
import { CHARACTERS, playerAttackShape } from '../data/characters.js';
import { heightAt, slopeAt } from '../data/zones.js';
import { STAMINA } from '../sim/formulas.js';
import { fireProcs, liveStats, healOverflowToShield } from './procs.js';
import { S2C } from '../protocol.js';
import { clamp } from '../sim/rng.js';

export const MAX_SPEED = 14.0;          // hard cap for anti-teleport checks (m/s)
/** How far past the target a blink lands, metres. `blinkDestination`, run by both ends. */
export const BLINK_BEHIND = 1.6;
/** Energy one 元素微粒 is worth, i.e. the unit `skill.particles` is counted in. */
export const ENERGY_PER_PARTICLE = 4;

/* ---------------------------------------------------------------- movement -- */

export function handleInput(entity, inst, d, lastPosAt) {
  if (!d) return;
  const dt = Math.max(0.016, Math.min(0.5, (Date.now() - lastPosAt) / 1000));
  const nx = Number(d.x), nz = Number(d.z), ny = Number(d.y);
  if (!Number.isFinite(nx) || !Number.isFinite(nz) || !Number.isFinite(ny)) return;

  const half = inst.zone.size / 2 + 20;
  if (Math.abs(nx) > half || Math.abs(nz) > half) return;

  // Anti-teleport: reject moves faster than the cap, snap back instead.
  const dist = Math.hypot(nx - entity.x, nz - entity.z);
  const maxDist = MAX_SPEED * dt + 1.5;
  if (dist > maxDist) {
    // Allow if the client claims a dash/skill window (server tracks the grant).
    if (!entity._dashUntil || inst.now > entity._dashUntil) {
      inst.hooks.sendTo?.(entity.playerId, {
        t: S2C.PLAYER_ACTION,
        d: { playerId: entity.playerId, action: 'correction', x: r2(entity.x), y: r2(entity.y), z: r2(entity.z) },
      });
      return;
    }
  }
  const gh = heightAt(inst.zone, nx, nz);
  entity.x = nx;
  entity.z = nz;
  // Keep the player on/above terrain but let them be airborne while jumping/gliding.
  entity.y = clamp(ny, gh - 0.6, gh + 60);
  if (entity.y < gh) entity.y = gh;
  entity.ry = Number(d.ry) || 0;
  entity.action = Number(d.a) || 0;
  entity.stamina = clamp(Number(d.st ?? entity.stamina), 0, STAMINA.max);
  entity.lastInput = Date.now();
  entity.dirty = true;
}

/* ----------------------------------------------------------------- attacks -- */

export function handleAttack(entity, inst, d, send, fail = () => {}) {
  if (!entity.alive) return fail('downed');
  const st = entity.cur();
  if (!st) return fail('no_stats');
  const def = CHARACTERS[st.charId];
  const kind = d?.charged ? 'charged' : 'normal';
  const now = inst.now;

  const cdKey = `${st.charId}:atk`;
  const attackDef = kind === 'charged' ? def.charged : def.normal;
  // Attack speed is a *live* number: 雷鸣长枪's post-burst +15 % and 雷鸣的召唤's
  // post-reaction +10 % both arrive as timed buffs, so reading `st.atkSpeed` here would
  // have made them unobservable even once the trigger fired.
  const live = liveStats(entity, st, now);
  const baseInterval = kind === 'charged' ? 0.65 : (def.normal.frameTime / (live.atkSpeed || 1));
  if (now < (entity.cooldowns[cdKey] || 0)) return; // silently drop spam
  entity.cooldowns[cdKey] = now + baseInterval * 0.85;

  if (kind === 'charged') {
    if (entity.stamina < (attackDef.stamina || 20)) return fail('no_stamina');
    entity.stamina -= attackDef.stamina || 20;
  }

  const comboIdx = kind === 'normal'
    ? (entity.sequence = (now - (entity._lastAtkAt || 0) > 1.4 ? 0 : entity.sequence + 1) % def.normal.hits.length)
    : 0;
  entity._lastAtkAt = now;

  const scaling = (kind === 'charged' ? def.charged.mult : def.normal.hits[comboIdx])
    * (kind === 'charged' ? st.talentMul.normal : st.talentMul.normal);
  const element = kind === 'charged' ? (def.charged.element || 'physical') : (def.normal.element || 'physical');
  const infuse = entity.buffs.find((b) => b.infuse);
  const finalElement = infuse ? infuse.infuse : element;
  const gauge = (kind === 'charged' ? def.charged.gauge : def.normal.gauge) || (infuse ? 1 : 0);

  inst.hooks.broadcast?.(inst, [{
    t: S2C.PLAYER_ACTION,
    d: { playerId: entity.playerId, action: kind, charId: st.charId, combo: comboIdx, element: finalElement },
  }]);

  const isRanged = attackDef.projectile || def.weapon === 'bow' || def.weapon === 'catalyst';
  if (isRanged) {
    const dir = normalizeDir(d?.dir, entity.ry);
    const aimed = kind === 'charged' && def.charged.aim;
    const pr = new Projectile({
      owner: entity.playerId, ownerType: 'player',
      x: entity.x, y: entity.y + 1.35, z: entity.z,
      dx: dir[0], dy: dir[1], dz: dir[2],
      speed: aimed ? 70 : def.weapon === 'catalyst' ? 26 : 44,
      damage: 0, element: finalElement, gauge, radius: 0.8, life: 2.6,
      kind: def.weapon === 'catalyst' ? 'orb' : 'arrow',
    });
    pr.meta = { scaling: aimed ? def.charged.aimedMult * st.talentMul.normal : scaling, kind: aimed ? 'aimed' : kind, aimed };
    pr.damage = 0;
    inst.projectiles.set(pr.id, pr);
    return;
  }

  // Melee: server-side arc sweep, over the ground `playerAttackShape` publishes and the client
  // draws with `vfx.strike` — the weapon reach was written out here a second time (a ternary over
  // `WEAPON_TYPES[…].reach`) and the arc was a literal, so nothing could draw either.
  const sh = playerAttackShape(kind, def);
  // Swept around the aim the client sent, which is the direction it drew the swing in. `entity.ry`
  // is only the facing the last position packet happened to carry.
  const aim = normalizeDir(d?.dir, entity.ry);
  const targets = sweep(inst, entity, sh.hit, sh.arc ?? Math.PI * 2, Math.atan2(aim[0], aim[2]));
  if (!targets.length) return;
  const maxTargets = def.weapon === 'claymore' ? 5 : 3;
  for (const e of targets.slice(0, maxTargets)) {
    inst.playerHitEnemy(entity, e, { scaling, element: finalElement, gauge, kind, charId: st.charId });
  }
}

export function handleSkill(entity, inst, d, send, fail = () => {}) {
  if (!entity.alive) return fail('downed');
  const st = entity.cur();
  if (!st) return fail('no_stats');
  const def = CHARACTERS[st.charId];
  const skill = def.skill;
  // The ground this skill covers: tested below, drawn by `vfx.strike` from the same call.
  const sh = playerAttackShape('skill', def);
  const now = inst.now;
  const key = `${st.charId}:skill`;
  const cd = skill.cd * (1 - (st.cdReduction || 0));
  const charges = skill.charges || 1;
  const cdState = entity.cooldowns[key];

  if (charges > 1) {
    const state = entity._skillCharges?.[st.charId] ?? { n: charges, at: now };
    // Regenerate charges over time. The rule is `regenCharges` because `Player.cooldownLeft`
    // reports it to the HUD and the two must not disagree about "ready".
    let { n, at } = regenCharges(state, charges, cd, now);
    if (n <= 0) return fail('on_cooldown');
    n -= 1;
    if (n === charges - 1) at = now;
    entity._skillCharges = { ...(entity._skillCharges || {}), [st.charId]: { n, at } };
  } else {
    if (cdState && now < cdState) return fail('on_cooldown');
    entity.cooldowns[key] = now + cd;
  }

  const element = skill.element;
  const gauge = skill.gauge || 1;
  const scaling = skill.mult * st.talentMul.skill;
  // 元素微粒: a skill's energy is how many particles it drops, not a flat number for
  // everyone. `skill.particles` was authored on four characters and read nowhere, so a
  // two-particle bow skill charged its burst exactly as fast as a four-particle claymore
  // sweep. The default is 3 — the value the flat 12 used to be — so unauthored kits are
  // untouched.
  entity.addEnergy(st.charId, (skill.particles ?? 3) * ENERGY_PER_PARTICLE);

  // Movement grants (dash / teleport) — the server authorises the window so the
  // anti-teleport check doesn't reject the client's legitimate reposition.
  if (skill.dash || skill.teleport || skill.pierce) {
    entity._dashUntil = now + 0.7;
  }

  const dir = normalizeDir(d?.dir, entity.ry);
  let cx = entity.x, cz = entity.z;

  if (skill.teleport) {
    // Blink behind the nearest enemy. The rule lives in `blinkDestination` because the client has
    // to run the same one: the server moved its copy of the character up to 9 m and broadcast the
    // new position, while the local player stayed put — so nyx's blink relocated her damage, and
    // her `backstab` bonus, to a place her player could not see.
    const dest = blinkDestination(entity.x, entity.z, skill.teleport,
      inst.enemies.values(), (x, z) => slopeAt(inst.zone, x, z));
    if (dest) {
      entity.x = cx = dest.x; entity.z = cz = dest.z;
      entity.y = heightAt(inst.zone, dest.x, dest.z);
    }
  } else if (skill.dash) {
    const nx = entity.x + dir[0] * skill.dash;
    const nz = entity.z + dir[2] * skill.dash;
    if (slopeAt(inst.zone, nx, nz) < 0.78) {
      entity.x = nx; entity.z = nz;
      entity.y = heightAt(inst.zone, nx, nz);
    }
    cx = entity.x; cz = entity.z;
  }

  inst.hooks.broadcast?.(inst, [{
    t: S2C.PLAYER_ACTION,
    d: { playerId: entity.playerId, action: 'skill', charId: st.charId, skillId: skill.id,
      element, x: r2(entity.x), y: r2(entity.y), z: r2(entity.z), ry: r2(entity.ry),
      // No radius on the wire: `charId` is already here, so both ends ask
      // `playerAttackShape('skill', CHARACTERS[charId])` and cannot disagree. They did — this
      // packet said `skill.radius || 4` and the client that drew it said `|| 3`.
      dir: dir.map(r2) },
  }]);

  // 施放元素战技后: gear triggers fire on the cast, before the skill's own damage, so a
  // weapon that promises "攻击力提升 12%" also raises the hit that paid for it.
  fireProcs(inst, entity, st, 'skill', { charId: st.charId });

  // Self buffs / shields / heals
  if (skill.buff) {
    entity.buffs.push({ ...skill.buff, until: now + (skill.buff.duration || 6) });
  }
  if (skill.shield) {
    const amount = (skill.shield.hpScaling || 0) * st.maxHp
      + (skill.shield.defScaling || 0) * st.def;
    // A character's own shield is made of their own element, which is what decides how much of
    // the next hit it eats: 忒拉's earth wall gives way to wind and shrugs off earth, while
    // 瑟莉丝's water shield is the wrong thing to wear against a pyro camp.
    entity.grantShield(amount * (1 + (st.shieldStrength || 0)),
      now + (skill.shield.duration || 10), st.element, now);
  }
  if (skill.heal) {
    const amount = (skill.heal.hpScaling || 0) * st.maxHp
      + (skill.heal.atkScaling || 0) * st.atk + (skill.heal.flat || 0);
    const total = amount * (1 + (st.healBonus || 0));
    let anyHealed = false, over = 0;
    for (const p of inst.players.values()) {
      if (Math.hypot(p.x - entity.x, p.z - entity.z) > (skill.radius || 5) + 2) continue;
      const healed = p.heal(total);
      over += total - healed;   // 圣咏回响 turns exactly this waste into a shield
      if (healed > 0) {
        anyHealed = true;
        inst.hooks.broadcast?.(inst, [{ t: S2C.DAMAGE, d: { target: 'player', id: p.playerId, amount: -Math.round(healed), element: 'light', kind: 'heal' } }]);
      }
    }
    if (anyHealed) fireProcs(inst, entity, st, 'heal', { charId: st.charId });
    healOverflowToShield(inst, entity, st, over);
    if (skill.heal.interval) {
      inst.fields.push({
        x: entity.x, z: entity.z, r: skill.radius || 4.4, element, gauge: 1,
        damage: st.atk * 0.4 * st.talentMul.skill, heal: total * 0.5,
        until: now + (skill.heal.duration || 10), nextTick: now + skill.heal.interval,
        interval: skill.heal.interval, owner: entity.playerId, hostile: false, kind: 'skill',
      });
    }
  }
  if (skill.taunt) {
    for (const e of inst.enemies.values()) {
      if (Math.hypot(e.x - entity.x, e.z - entity.z) < (skill.radius || 4) * 1.6) {
        e.tauntedBy = entity.playerId;
        e.tauntUntil = now + skill.taunt;
        e.targetId = entity.playerId;
        e.state = 'chase';
      }
    }
  }
  if (skill.lingering) {
    inst.fields.push({
      x: cx, z: cz, r: skill.lingering.radius || skill.radius || 4, element, gauge: 1,
      damage: st.atk * skill.lingering.tickMult * st.talentMul.skill,
      until: now + skill.lingering.duration, nextTick: now + skill.lingering.interval,
      interval: skill.lingering.interval, owner: entity.playerId, hostile: false, kind: 'skill',
    });
  }

  // Damage application
  if (skill.projectile) {
    const n = skill.ticks || 1;
    for (let i = 0; i < n; i++) {
      const spread = (i - (n - 1) / 2) * 0.11;
      const cos = Math.cos(spread), sin = Math.sin(spread);
      const dx = dir[0] * cos - dir[2] * sin;
      const dz = dir[0] * sin + dir[2] * cos;
      const pr = new Projectile({
        owner: entity.playerId, ownerType: 'player',
        x: entity.x, y: entity.y + 1.3, z: entity.z,
        dx, dy: dir[1], dz, speed: 52, damage: 0,
        element, gauge, radius: 0.9, life: 2.4, kind: 'orb',
      });
      pr.meta = { scaling, kind: 'skill', cast: true };
      inst.projectiles.set(pr.id, pr);
    }
  } else if (skill.pierce) {
    // Line AoE along facing — the lane `vfx.strike` draws, half-width and length both from it.
    for (const e of inst.enemies.values()) {
      if (!e.alive) continue;
      const rel = [e.x - entity.x, e.z - entity.z];
      const along = rel[0] * dir[0] + rel[1] * dir[2];
      if (along < -1 || along > sh.length) continue;
      const perp = Math.abs(rel[0] * dir[2] - rel[1] * dir[0]);
      if (perp > sh.hit + (e.def.hitbox?.r || 0.7)) continue;
      inst.playerHitEnemy(entity, e, { scaling, element, gauge, kind: 'skill', charId: st.charId, cast: true });
    }
  } else {
    const radius = sh.hit;
    for (const e of inst.enemies.values()) {
      if (!e.alive) continue;
      const d2 = Math.hypot(e.x - cx, e.z - cz);
      if (d2 > radius + (e.def.hitbox?.r || 0.7)) continue;
      let opts = { scaling, element, gauge, kind: 'skill', charId: st.charId, cast: true };
      if (skill.backstab) {
        const ang = Math.atan2(entity.x - e.x, entity.z - e.z);
        const behind = Math.abs(angleDelta(ang, e.ry + Math.PI)) < 1.2;
        if (behind) opts.headshot = true;
      }
      inst.playerHitEnemy(entity, e, opts);
      if (skill.knock) {
        const dx = e.x - cx, dz = e.z - cz;
        const len = Math.hypot(dx, dz) || 1;
        e.knockback = { dx: dx / len, dz: dz / len, speed: skill.knock, time: 0.3 };
      }
      if (skill.pull) {
        const dx = cx - e.x, dz = cz - e.z;
        const len = Math.hypot(dx, dz) || 1;
        e.knockback = { dx: dx / len, dz: dz / len, speed: skill.pull, time: 0.25 };
      }
    }
  }
}

export function handleBurst(entity, inst, d, send, fail = () => {}) {
  if (!entity.alive) return fail('downed');
  const st = entity.cur();
  if (!st) return fail('no_stats');
  const def = CHARACTERS[st.charId];
  const burst = def.burst;
  const now = inst.now;
  const key = `${st.charId}:burst`;
  if (now < (entity.cooldowns[key] || 0)) return fail('on_cooldown');
  if ((entity.energy[st.charId] || 0) < burst.cost) return fail('no_energy');

  entity.energy[st.charId] = 0;
  entity.cooldowns[key] = now + burst.cd * (1 - (st.cdReduction || 0));

  const element = burst.element;
  const gauge = burst.gauge || 1;
  const scaling = burst.mult * st.talentMul.burst;
  // 4 m for nyx, 8 m for aurel — and both ends read it from here, off `charId`.
  const sh = playerAttackShape('burst', def);

  inst.hooks.broadcast?.(inst, [{
    t: S2C.PLAYER_ACTION,
    d: { playerId: entity.playerId, action: 'burst', charId: st.charId, burstId: burst.id,
      element, x: r2(entity.x), y: r2(entity.y), z: r2(entity.z), ry: r2(entity.ry) },
  }]);

  // 元素爆发后: same rule as the skill — the trigger is the cast.
  fireProcs(inst, entity, st, 'burst', { charId: st.charId });

  if (burst.buff) entity.buffs.push({ ...burst.buff, until: now + (burst.buff.duration || 10) });
  if (burst.heal) {
    const amount = ((burst.heal.hpScaling || 0) * st.maxHp
      + (burst.heal.atkScaling || 0) * st.atk + (burst.heal.flat || 0)) * (1 + (st.healBonus || 0));
    let anyHealed = false, over = 0;
    for (const p of inst.players.values()) {
      if (burst.revive && !p.alive) p.revive();
      const healed = p.heal(amount);
      over += amount - healed;
      if (healed > 0) {
        anyHealed = true;
        inst.hooks.broadcast?.(inst, [{ t: S2C.DAMAGE, d: { target: 'player', id: p.playerId, amount: -Math.round(healed), element: 'light', kind: 'heal' } }]);
      }
    }
    if (anyHealed) fireProcs(inst, entity, st, 'heal', { charId: st.charId });
    healOverflowToShield(inst, entity, st, over);
  }

  if (burst.ticks && burst.duration) {
    // Persistent damaging field.
    inst.fields.push({
      x: entity.x, z: entity.z, r: sh.hit, element, gauge,
      damage: st.atk * scaling, until: now + burst.duration,
      nextTick: now, interval: burst.interval || 0.5,
      owner: entity.playerId, hostile: false, kind: 'burst',
    });
  } else if (burst.ticks) {
    // Rapid multi-hit at the caster's position.
    inst.fields.push({
      x: entity.x, z: entity.z, r: sh.hit, element, gauge,
      damage: st.atk * scaling, until: now + burst.ticks * (burst.interval || 0.15),
      nextTick: now, interval: burst.interval || 0.15,
      owner: entity.playerId, hostile: false, kind: 'burst',
    });
  } else {
    for (const e of inst.enemies.values()) {
      if (!e.alive) continue;
      if (Math.hypot(e.x - entity.x, e.z - entity.z) > sh.hit + (e.def.hitbox?.r || 0.7)) continue;
      inst.playerHitEnemy(entity, e, { scaling, element, gauge, kind: 'burst', charId: st.charId });
      if (burst.stun) e.stunned = now + burst.stun;
      if (burst.slow) e.stunned = Math.max(e.stunned, now + 0.3);
    }
  }
}

/* ----------------------------------------------------------------- helpers -- */

/**
 * Every live enemy inside a wedge: `reach` metres of it (plus the target's own body), `arc`
 * radians wide, centred on `yaw`. An arc of nearly the full circle skips the facing test, which
 * is what makes a charged spin hit what is standing behind you.
 */
export function sweep(inst, entity, reach, arc, yaw = entity.ry) {
  const out = [];
  for (const e of inst.enemies.values()) {
    if (!e.alive) continue;
    const dx = e.x - entity.x, dz = e.z - entity.z;
    const d = Math.hypot(dx, dz);
    const hb = e.def.hitbox || { r: 0.7 };
    if (d > reach + hb.r) continue;
    if (arc < Math.PI * 1.9) {
      const ang = Math.atan2(dx, dz);
      if (Math.abs(angleDelta(ang, yaw)) > arc / 2) continue;
    }
    out.push(e);
  }
  out.sort((a, b) => Math.hypot(a.x - entity.x, a.z - entity.z) - Math.hypot(b.x - entity.x, b.z - entity.z));
  return out;
}

/**
 * Where a blink puts the caster: `BLINK_BEHIND` metres past the nearest live enemy within
 * `range`, or `null` if there is nobody to blink to or the far side is a cliff.
 *
 * Takes an iterable of bodies and a slope sampler rather than a `ZoneInstance`, because the
 * client has to reach the same answer from its own actor list — a rule the server applies alone
 * moves its copy of the character and leaves the player standing where they were.
 */
export function blinkDestination(x, z, range, enemies, slope) {
  let best = null, bd = range;
  for (const e of enemies) {
    if (e.alive === false) continue;
    const d = Math.hypot(e.x - x, e.z - z);
    if (d < bd) { bd = d; best = e; }
  }
  if (!best) return null;
  const ang = Math.atan2(best.x - x, best.z - z);
  const nx = best.x + Math.sin(ang) * BLINK_BEHIND;
  const nz = best.z + Math.cos(ang) * BLINK_BEHIND;
  if (slope(nx, nz) >= 0.8) return null;
  return { x: nx, z: nz, target: best };
}

export function normalizeDir(dir, ry) {
  if (Array.isArray(dir) && dir.length === 3 && dir.every(Number.isFinite)) {
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    return [dir[0] / len, clamp(dir[1] / len, -0.8, 0.8), dir[2] / len];
  }
  return [Math.sin(ry), 0, Math.cos(ry)];
}

export function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
