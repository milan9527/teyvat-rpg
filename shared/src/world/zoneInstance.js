// One authoritative simulation instance per (zone, shard). Runs at 20Hz:
// enemy AI, projectiles, damage resolution, elemental reactions, loot, respawns.
//
// Isomorphic on purpose: the server hosts it for online play, and the browser hosts
// it for 单机 mode (see `client/src/net/localSocket.js`). Side effects that need the
// database go out through `hooks`, so the host decides whether "grant this loot"
// means a SQL write or an HTTP call.

import { Enemy, Projectile, PlayerEntity, groundEntity, moveToward, r2 } from './entity.js';
import { ENEMIES, ATTACK_MOVES, AI, attackShape } from '../data/enemies.js';
import { ZONES, heightAt, findWalkable, CHAMBER_WAVE_GAP, chamberStars } from '../data/zones.js';
import { disorderById, disorderInfo } from '../data/disorders.js';
import { computeDamage, defMultiplier, resMultiplier } from '../sim/formulas.js';
import { AMPLIFYING, resolveReaction, REACTIONS } from '../data/elements.js';
import { CHARACTERS } from '../data/characters.js';
import { rollEnemyLoot } from '../sim/loot.js';
import { fireProcs, liveStats, hitMods, procSum, healOverflowToShield, SKILL_FOLLOW_GAP } from './procs.js';
import { S2C, TICK_MS, AOI_RADIUS } from '../protocol.js';
import { nearestAnchor, zoneProgress } from '../data/anchors.js';
import { Rand, clamp } from '../sim/rng.js';
import { weatherAt } from './weather.js';

const MAX_ENEMIES = 90;

/**
 * How far from the corpse a helper can be and still be paid for it.
 *
 * Sized off the fight, not off the network: `AOI_RADIUS` is 130 m (what you can *see*),
 * a bow's arrows die at 70 m/s over a couple of seconds, and the widest burst in the
 * game is a few metres across. 45 m is "you are in this fight"; it is deliberately far
 * short of AOI so that watching a stranger's fight from a ridge pays nothing.
 */
export const ASSIST_RADIUS = 45;

/**
 * Seconds a downed player lies there before the sim stands them up at an anchor.
 *
 * Exported because the HUD counts this down on screen: a panel that says 「8 秒后自动返回」 while
 * the sim uses some other number is a worse lie than saying nothing.
 */
export const AUTO_RESPAWN_SEC = 8;

export class ZoneInstance {
  constructor(zoneId, shard = 0, hooks = {}) {
    this.zoneId = zoneId;
    this.zone = ZONES[zoneId];
    this.shard = shard;
    this.key = `${zoneId}#${shard}`;
    this.players = new Map();     // playerId -> PlayerEntity
    this.enemies = new Map();     // id -> Enemy
    this.projectiles = new Map();
    this.fields = [];             // lingering AoE: { x,z,r,element,dmg,gauge,until,nextTick,interval,owner }
    this.now = 0;                 // seconds since instance start
    this.tick = 0;
    this.hooks = hooks;           // { broadcast, onKill, onDamage, onChamberClear }
    this.camps = [];
    this.rand = new Rand((this.zone?.seed ?? 1) ^ (shard * 7919));
    this.chamber = null;          // active dungeon chamber
    this.timer = null;
    this.lastTickAt = Date.now();
    this.events = [];             // queued outbound events for this tick
    if (this.zone?.kind === 'open') this.initCamps();
  }

  /* ------------------------------------------------------------- lifecycle -- */

  start() {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.step(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get empty() { return this.players.size === 0; }

  initCamps() {
    for (const s of this.zone.spawns || []) {
      const [x, y, z] = findWalkable(this.zone, s.at[0], s.at[1]);
      this.camps.push({
        def: s, x, y, z, radius: s.radius || 10,
        respawnAt: 0, aliveIds: new Set(), spawned: false,
      });
    }
  }

  /* ---------------------------------------------------------------- players -- */

  addPlayer(playerId, nickname, save, stats) {
    const p = new PlayerEntity(playerId, nickname, save, stats);
    const [x, y, z] = findWalkable(this.zone, save.pos?.x ?? 0, save.pos?.z ?? 0);
    if (!Number.isFinite(save.pos?.x)) { p.x = x; p.z = z; }
    p.y = Math.max(p.y, heightAt(this.zone, p.x, p.z) + 0.1);
    p.zone = this.zoneId;
    this.players.set(p.playerId, p);
    this.start();
    return p;
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    this.players.delete(Number(playerId));
    // Clear threat referencing the departed player.
    for (const e of this.enemies.values()) {
      e.threat.delete(Number(playerId));
      if (e.targetId === Number(playerId)) { e.targetId = null; e.state = 'idle'; }
    }
    if (this.empty) {
      this.stop();
      this.enemies.clear();
      this.projectiles.clear();
      this.fields.length = 0;
      for (const c of this.camps) { c.spawned = false; c.aliveIds.clear(); c.respawnAt = 0; }
      this.chamber = null;
    }
    return p;
  }

  /* ----------------------------------------------------------------- spawns -- */

  spawnEnemy(defId, level, x, z, opts = {}) {
    if (this.enemies.size >= MAX_ENEMIES) return null;
    if (!ENEMIES[defId]) return null;
    const [wx, wy, wz] = findWalkable(this.zone, x, z, 0.6, 24, this.enemies.size);
    const scaled = Math.max(1, Math.round(level * (1 + 0.06 * this.worldLevel())));
    const e = new Enemy(defId, scaled, wx, wy, wz, this.zone, opts);
    this.enemies.set(e.id, e);
    this.emit(S2C.ENEMY_SPAWN, { enemy: e.serialize() });
    return e;
  }

  worldLevel() {
    let max = 0;
    for (const p of this.players.values()) max = Math.max(max, p.save.worldLevel || 0);
    return max;
  }

  updateCamps() {
    for (const camp of this.camps) {
      // Prune dead references.
      for (const id of [...camp.aliveIds]) {
        const e = this.enemies.get(id);
        if (!e || !e.alive) camp.aliveIds.delete(id);
      }
      const anyNearby = [...this.players.values()].some(
        (p) => Math.hypot(p.x - camp.x, p.z - camp.z) < 110,
      );
      if (!anyNearby) {
        // Despawn far camps to keep the sim cheap.
        if (camp.spawned && camp.aliveIds.size) {
          for (const id of camp.aliveIds) {
            const e = this.enemies.get(id);
            if (e && Math.hypot(e.x - camp.x, e.z - camp.z) < camp.radius * 3) this.enemies.delete(id);
          }
          camp.aliveIds.clear();
          camp.spawned = false;
        }
        continue;
      }
      if (camp.spawned && camp.aliveIds.size > 0) continue;
      if (camp.spawned && camp.aliveIds.size === 0) {
        if (camp.respawnAt === 0) camp.respawnAt = this.now + (camp.def.respawn || 90);
        if (this.now < camp.respawnAt) continue;
      }
      // (Re)spawn the camp.
      camp.spawned = true;
      camp.respawnAt = 0;
      const lvl = camp.def.level || this.zone.recommendedLevel || 1;
      camp.def.enemies.forEach((id, i) => {
        const a = (i / camp.def.enemies.length) * Math.PI * 2 + this.rand.float(0, 1);
        const r = camp.radius * 0.45 + this.rand.float(0, camp.radius * 0.4);
        const e = this.spawnEnemy(id, lvl, camp.x + Math.cos(a) * r, camp.z + Math.sin(a) * r,
          { camp, homeRadius: camp.radius * 2.6 });
        if (e) camp.aliveIds.add(e.id);
      });
    }
  }

  /* ---------------------------------------------------------------- chamber -- */

  /**
   * The 地脉异常 in force right now, or null.
   *
   * Gated on `state === 'running'`: a disorder is a property of a fight in progress, and
   * without the state test a cleared floor would keep buffing the enemies of whatever the
   * player does next in the same instance.
   */
  disorder() {
    const c = this.chamber;
    return c && c.state === 'running' ? c.disorder : null;
  }

  /** Spawn the chamber's current wave into the arena and take ownership of its ids. */
  _spawnWave(c) {
    const list = c.waves[c.wave] || [];
    const hpMul = c.disorder?.enemyHpMul || 1;
    const ids = [];
    list.forEach((id, i) => {
      // Each wave is rotated a little so the second one does not walk in along the exact
      // footsteps of the first.
      const a = (i / list.length) * Math.PI * 2 + c.wave * 0.7;
      const r = list.length > 1 ? 14 : 0;
      const e = this.spawnEnemy(id, c.def.level, Math.cos(a) * r, Math.sin(a) * r - 8,
        { homeRadius: 60, hpMul });
      if (e) ids.push(e.id);
    });
    c.ids = new Set(ids);
    return ids;
  }

  startChamber(floor) {
    const def = (this.zone.chambers || []).find((c) => c.floor === floor);
    if (!def) return { error: 'no_such_chamber' };
    // A run in progress is not restartable. This function *is* the reset — it empties the
    // arena, respawns wave 1 and re-anchors `startedAt` — so a second request while a run
    // is live hands out a brand-new clock and throws away the progress. Solo it is one
    // stray click (the map panel's floor list stays clickable during a run); in co-op it is
    // worse, because the presser need not be the player whose run it is: any teammate could
    // wipe a party's 80th second, and the floor they pick need not even be the one being
    // fought. The refusal is here rather than in the two callers (gateway, `localSocket`)
    // because both of them would have to remember it, and the browser sim is the one where
    // there is nobody else to notice.
    if (this.chamber?.state === 'running') {
      return { error: 'chamber_in_progress', floor: this.chamber.floor };
    }
    // Clear the arena and spawn the first wave.
    this.enemies.clear();
    this.projectiles.clear();
    this.fields.length = 0;
    const disorder = disorderById(def.disorder);
    this.chamber = {
      floor, def, startedAt: this.now, ids: new Set(),
      waves: def.waves, wave: 0, nextWaveAt: 0, disorder,
      timeLimit: def.timeLimit, state: 'running',
    };
    const ids = this._spawnWave(this.chamber);
    this.emit(S2C.CHAMBER, {
      state: 'start', floor, timeLimit: def.timeLimit, enemies: ids.length,
      wave: 1, waves: def.waves.length, disorder: disorderInfo(def.disorder),
    });
    return {
      ok: true, floor, timeLimit: def.timeLimit,
      waves: def.waves.length, disorder: def.disorder || null,
    };
  }

  updateChamber() {
    const c = this.chamber;
    if (!c || c.state !== 'running') return;
    const elapsed = this.now - c.startedAt;
    for (const id of [...c.ids]) {
      const e = this.enemies.get(id);
      if (!e || !e.alive) c.ids.delete(id);
    }
    if (c.ids.size === 0 && c.wave + 1 < c.waves.length) {
      // A breather, not a hard cut. Without it the next wave lands on a player still
      // mid-swing at the last corpse, and the HUD never gets a frame to say what is
      // coming. The clock keeps running through it, which is why `CHAMBER_WAVE_GAP` is
      // shared with the audit that derives the star thresholds.
      if (!c.nextWaveAt) c.nextWaveAt = this.now + CHAMBER_WAVE_GAP;
      if (this.now >= c.nextWaveAt) {
        c.wave++;
        c.nextWaveAt = 0;
        const ids = this._spawnWave(c);
        this.emit(S2C.CHAMBER, {
          state: 'wave', floor: c.floor, wave: c.wave + 1, waves: c.waves.length, enemies: ids.length,
        });
      }
    } else if (c.ids.size === 0) {
      c.state = 'cleared';
      const time = Math.round(elapsed * 10) / 10;
      const stars = chamberStars(c.def, time);
      this.emit(S2C.CHAMBER, { state: 'cleared', floor: c.floor, time, stars });
      this.hooks.onChamberClear?.(this, c.floor, time, stars);
      return;
    }
    if (elapsed > c.timeLimit) {
      c.state = 'failed';
      this.emit(S2C.CHAMBER, { state: 'failed', floor: c.floor, remaining: c.ids.size });
      this.enemies.clear();
    }
    const allDown = this.players.size > 0 && [...this.players.values()].every((p) => !p.alive);
    if (allDown) {
      c.state = 'failed';
      this.emit(S2C.CHAMBER, { state: 'failed', floor: c.floor, reason: 'wiped' });
      // Same cleanup as the time-out above, which is the point: a failed run is over, and
      // it used to be over only for the clock. A wipe left the whole wave alive in the
      // arena, so the party respawned at the entry of a dungeon that still had eight
      // level-40 enemies hunting them — and nothing could reset it but leaving the zone.
      this.enemies.clear();
      this.projectiles.clear();
    }
  }

  /* ------------------------------------------------------------------- tick -- */

  step() {
    const realNow = Date.now();
    let dt = (realNow - this.lastTickAt) / 1000;
    this.lastTickAt = realNow;
    dt = clamp(dt, 0.001, 0.25);
    this.now += dt;
    this.tick++;
    // NOTE: events are NOT cleared here — the WS gateway emits into this queue
    // between ticks (player attacks/skills), and those must survive to the flush
    // at the end of this tick.

    if (this.zone.kind === 'open') this.updateCamps();

    for (const p of this.players.values()) this.updatePlayer(p, dt);
    for (const e of this.enemies.values()) this.updateEnemy(e, dt);
    this.updateProjectiles(dt);
    this.updateFields(dt);
    this.updateChamber();
    this.cleanup();

    // Snapshot at SNAPSHOT_RATE (every other tick at 20Hz -> 10Hz).
    if (this.tick % 2 === 0) this.broadcastSnapshot();
    this.flushEvents();
  }

  /** Send and clear the queued outbound events. Safe to call between ticks. */
  flushEvents() {
    if (!this.events.length) return;
    const batch = this.events.splice(0, this.events.length);
    this.hooks.broadcast?.(this, batch);
  }

  emit(type, data) {
    this.events.push({ t: type, d: data });
    // Cap the queue so a pathological burst can't grow unbounded before the flush.
    if (this.events.length > 600) this.flushEvents();
  }

  /**
   * The anchor a downed `p` would come back at: the nearest one *they* have activated.
   *
   * Read off the player's own live save (`playerCache` hands both hosts the same document), so
   * two people downed in the same fight can wake up at different statues.
   */
  respawnAnchor(p) {
    return nearestAnchor(this.zone, p.x, p.z, zoneProgress(p.save?.worldProgress, this.zoneId));
  }

  /**
   * Stand a downed player up at an anchor. Called by the 8 s timer and by C2S.RESPAWN, which is
   * the whole reason it is a method: 「返回最近的锚点」 must land the player exactly where waiting
   * would have, or the button is a different mechanic wearing the same words.
   */
  respawnAtAnchor(p, { auto = false } = {}) {
    const poi = this.respawnAnchor(p);
    const at = poi ? poi.at : [0, 0];
    const [x, y, z] = findWalkable(this.zone, at[0], at[1]);
    p.x = x; p.y = y + 1; p.z = z;
    p.vy = 0;
    p.revive();
    this.emit(S2C.REVIVED, {
      playerId: p.playerId, x: r2(p.x), y: r2(p.y), z: r2(p.z),
      auto, anchor: poi?.id || null, anchorName: poi?.name || null,
    });
    return poi;
  }

  updatePlayer(p, dt) {
    p.aura.update(dt, this.now);
    // 感电's damage over time, on the player's side of the same `AuraState`.
    //
    // `updateEnemy` has ticked `e.aura.dots` since the reaction table was written; the player's
    // copy of the identical structure was ticked by nobody, so 感电 on your own party was a
    // popup and a number for the triggering hit and then nothing — the half of the reaction that
    // makes standing in a puddle beside a 雷史莱姆 a mistake. It was unreachable until
    // `ATTACK_MOVES.basic` stopped overriding every melee creature's element with `physical`
    // (see the comment there): nothing in the open world could make a player 湿身.
    //
    // Same fraction and same 1 s cadence as the enemy loop, and it deliberately does **not** go
    // through `damagePlayer`: gauge 0 there would still spend a `mitig` roll on a tick that is
    // already a fraction of max hp, and re-entering the damage path would re-emit a reaction.
    // 严寒 above is the precedent for a self-emitted player tick.
    for (const dot of p.aura.dots) {
      dot.tick = (dot.tick || 0) + dt;
      if (dot.tick < 1.0) continue;
      dot.tick = 0;
      const dealt = p.takeDamage(p.maxHp() * dot.frac * 0.35, this.now, dot.element);
      if (dealt > 0) {
        this.emit(S2C.DAMAGE, {
          target: 'player', id: p.playerId, amount: Math.round(dealt),
          element: dot.element, kind: 'dot',
        });
      }
      if (!p.alive) {
        this.emit(S2C.PLAYER_DOWN, { playerId: p.playerId, x: r2(p.x), y: r2(p.y), z: r2(p.z) });
        break;
      }
    }
    // Downed players return to their nearest anchor if nobody picks them up — but not while a
    // 秘境 run is live. Standing up for free is the difference between a challenge that can be
    // lost and one that cannot: `updateChamber` fails the run when *every* player is down, and
    // with an 8-second timer the first player to fall was always back on their feet (52 m away,
    // at the entry anchor) before the second one did, so in co-op the wipe was unreachable and
    // the only way to lose was the clock. It is also what `C2S.REVIVE` is *for* — a teammate's
    // hand is worth nothing if the sim hands out the same thing on a timer. The failed run
    // clears the arena, and the very next tick stands everybody up.
    const inRun = this.chamber?.state === 'running';
    if (!p.alive && !inRun && this.now - p.downedAt > AUTO_RESPAWN_SEC) {
      this.respawnAtAnchor(p, { auto: true });
    }
    // Shield expiry. `clearShield` because the element has to go with it: a stale 'ice' left on a
    // spent shield would charge the next shard's first hit at the wrong rate.
    if (p.shieldUntil <= this.now) p.clearShield();
    // Buff expiry
    if (p.buffs.length) p.buffs = p.buffs.filter((b) => b.until > this.now);
    // Sheer cold mechanic
    const mech = this.zone.mechanic;
    if (mech?.sheerCold && p.alive) {
      const warm = (this.zone.poi || []).some(
        (poi) => poi.type === 'warmth' && Math.hypot(p.x - poi.at[0], p.z - poi.at[1]) < mech.warmRadius,
      );
      // The weather is the same pure function of the wall clock the client draws the snow from
      // (`weatherAt`), so a blizzard you can *see* is the blizzard that chills you, in 单机 and
      // 多人 alike, with nothing about it on the wire. `coldMul` is exactly 1 at the zone's authored
      // baseline — 龙脊雪山's steady snow — so this changes no balance until a storm rolls in.
      const coldMul = weatherAt(this.zone, Date.now()).coldMul;
      p.cold = clamp(p.cold + (warm ? -mech.coldRate * 2.5 : mech.coldRate * coldMul * 0.35) * dt, 0, 100);
      if (p.cold >= 100) {
        const dmg = p.maxHp() * 0.02 * dt * 10;
        // Sheer cold is ice damage, and now that a shield is made of something, a cryo shard is
        // the right thing to be wearing on the mountain: it eats the tick at half rate.
        const dealt = p.takeDamage(dmg, this.now, 'ice');
        if (dealt > 0 && this.tick % 20 === 0) {
          this.emit(S2C.DAMAGE, { target: 'player', id: p.playerId, amount: Math.round(dealt), element: 'ice', kind: 'cold' });
        }
      }
    } else if (p.cold > 0) {
      p.cold = Math.max(0, p.cold - dt * 6);
    }
    // Passive energy trickle so bursts stay available even when solo-idling in combat.
    const inCombat = [...this.enemies.values()].some(
      (e) => e.alive && Math.hypot(e.x - p.x, e.z - p.z) < 30,
    );
    if (inCombat) for (const c of p.party) p.addEnergy(c, 0.35 * dt);
  }

  updateEnemy(e, dt) {
    if (!e.alive) return;
    e.aura.update(dt, this.now);

    // Electro-charged style DoTs.
    for (const dot of e.aura.dots) {
      dot.tick = (dot.tick || 0) + dt;
      if (dot.tick >= 1.0) {
        dot.tick = 0;
        const dmg = Math.round(e.maxHp * dot.frac * 0.35);
        const res = this.applyDamageToEnemy(e, dmg, dot.element, 0, e.lastDamageBy, 'dot');
        if (res?.killed) return;
      }
    }

    if (e.aura.isFrozen(this.now) || this.now < e.stunned) {
      e.state = 'stagger';
      groundEntity(this.zone, e, dt);
      return;
    }
    if (e.knockback) {
      const k = e.knockback;
      const step = k.speed * dt;
      e.x += k.dx * step; e.z += k.dz * step;
      k.time -= dt;
      k.speed *= 0.86;
      if (k.time <= 0) e.knockback = null;
      groundEntity(this.zone, e, dt);
      return;
    }

    const target = e.targetId ? this.players.get(e.targetId) : null;
    const valid = target && target.alive && Math.hypot(target.x - e.x, target.z - e.z) < e.def.aggro * 2.2;
    if (!valid) {
      const t = e.pickTarget(this.players, this.now);
      e.targetId = t ? t.playerId : null;
      if (!e.targetId && e.state !== 'idle') e.state = 'idle';
    }
    const tgt = e.targetId ? this.players.get(e.targetId) : null;

    switch (e.state) {
      case 'idle': {
        if (tgt) { e.state = 'chase'; break; }
        // Wander near spawn.
        if (!e._wander || this.now > e._wander.until) {
          const a = e.rand.angle();
          const r = e.rand.float(2, 8);
          e._wander = { x: e.spawn.x + Math.cos(a) * r, z: e.spawn.z + Math.sin(a) * r, until: this.now + e.rand.float(3, 7) };
        }
        moveToward(this.zone, e, e._wander.x, e._wander.z, e.def.speed * 0.35, dt);
        break;
      }
      case 'chase': {
        if (!tgt) { e.state = 'idle'; break; }
        const d = Math.hypot(tgt.x - e.x, tgt.z - e.z);
        const range = e.def.attackRange;
        const wantRange = e.def.ai === AI.ranged || e.def.ai === AI.caster ? range * 0.75 : range * 0.8;
        if (d > wantRange) {
          const spd = e.def.speed * (e.def.ai === AI.charger ? 1.25 : 1.0);
          moveToward(this.zone, e, tgt.x, tgt.z, spd, dt);
        } else if (e.def.ai === AI.ranged && d < range * 0.35) {
          // Kite backwards.
          const dx = e.x - tgt.x, dz = e.z - tgt.z;
          const len = Math.hypot(dx, dz) || 1;
          moveToward(this.zone, e, e.x + (dx / len) * 4, e.z + (dz / len) * 4, e.def.speed * 0.8, dt);
          e.ry = Math.atan2(tgt.x - e.x, tgt.z - e.z);
        } else {
          e.ry = Math.atan2(tgt.x - e.x, tgt.z - e.z);
          if (this.now >= e.attackCd) {
            const moveKey = e.chooseMove();
            const mv = ATTACK_MOVES[moveKey];
            if (mv) {
              e.move = moveKey;
              e.state = 'windup';
              e.stateUntil = this.now + mv.windup / (e.phase >= 3 ? 1.35 : e.phase >= 2 ? 1.15 : 1);
              e._activeTicks = 0;
              this.emit(S2C.ENEMY_ATTACK, {
                id: e.id, move: moveKey, phase: 'windup',
                duration: r2(mv.windup), x: r2(e.x), y: r2(e.y), z: r2(e.z), ry: r2(e.ry),
                tx: r2(tgt.x), tz: r2(tgt.z),
              });
            }
          }
        }
        break;
      }
      case 'windup': {
        if (tgt) e.ry = lerpAngle(e.ry, Math.atan2(tgt.x - e.x, tgt.z - e.z), dt * 3.2);
        if (this.now >= e.stateUntil) {
          const mv = ATTACK_MOVES[e.move];
          e.state = 'active';
          e.stateUntil = this.now + (mv.active || 0.2);
          e._nextTickAt = this.now;
          e._ticksDone = 0;
          this.emit(S2C.ENEMY_ATTACK, { id: e.id, move: e.move, phase: 'active', duration: r2(mv.active || 0.2) });
        }
        break;
      }
      case 'active': {
        const mv = ATTACK_MOVES[e.move];
        this.resolveEnemyAttack(e, mv, dt);
        if (this.now >= e.stateUntil) {
          e.state = 'recover';
          e.stateUntil = this.now + (mv.recover || 0.5);
        }
        break;
      }
      case 'recover': {
        if (this.now >= e.stateUntil) {
          e.state = tgt ? 'chase' : 'idle';
          e.attackCd = this.now + e.def.attackCd / (e.phase >= 3 ? 1.4 : e.phase >= 2 ? 1.2 : 1);
          e.move = null;
        }
        break;
      }
      case 'stagger': {
        e.state = tgt ? 'chase' : 'idle';
        break;
      }
    }
    // Leash back home if dragged too far.
    if (!tgt && Math.hypot(e.x - e.spawn.x, e.z - e.spawn.z) > e.homeRadius) {
      moveToward(this.zone, e, e.spawn.x, e.spawn.z, e.def.speed, dt);
    }
    groundEntity(this.zone, e, dt);
  }

  resolveEnemyAttack(e, mv, dt) {
    if (!mv) return;
    // One description of the move's geometry, shared with the client's telegraph
    // (`client/src/game/game.js#_onEnemyAttack`): the shape drawn during the wind-up is the
    // shape tested here, so a player who steps out of the ring steps out of the damage.
    const shape = attackShape(mv, e.def);
    const ticks = mv.ticks || 1;
    const interval = (mv.active || 0.2) / ticks;
    if (this.now < (e._nextTickAt ?? 0)) {
      if (mv.dash) this.applyDash(e, mv, dt);
      if (mv.pull) this.applyPull(e, mv, shape, dt);
      return;
    }
    if ((e._ticksDone ?? 0) >= ticks) return;
    e._ticksDone = (e._ticksDone || 0) + 1;
    e._nextTickAt = this.now + interval;

    if (mv.summon) {
      for (const id of mv.summon) {
        const a = this.rand.angle();
        const r = shape.radius;    // the circle the telegraph drew, so they arrive where it said
        this.spawnEnemy(id, Math.max(1, e.level - 6), e.x + Math.cos(a) * r, e.z + Math.sin(a) * r, { summonedBy: e.id });
      }
      return;
    }
    if (mv.selfShield) {
      if (!e.shield) e.shield = { hp: 0, max: mv.selfShield, element: e.def.element };
      e.shield.max = Math.max(e.shield.max, mv.selfShield);
      e.shield.hp = Math.min(e.shield.max, e.shield.hp + mv.selfShield);
    }
    const element = mv.element || e.def.element || 'physical';
    const baseDmg = e.atk * (mv.mult || 1);

    if (mv.projectile) {
      const tgt = this.players.get(e.targetId);
      if (!tgt) return;
      const spread = mv.ticks > 1 ? 0.12 : 0;
      const dx = tgt.x - e.x + this.rand.float(-spread, spread) * 10;
      const dy = (tgt.y + 1.0) - (e.y + 1.4);
      const dz = tgt.z - e.z + this.rand.float(-spread, spread) * 10;
      const speed = mv.projectileSpeed || e.def.projectileSpeed || 18;
      const pr = new Projectile({
        owner: e.id, ownerType: 'enemy', x: e.x, y: e.y + 1.4, z: e.z,
        dx, dy, dz, speed,
        damage: baseDmg, element, gauge: e.def.gauge || 0, radius: shape.radius,
        // Life is the authored range divided by the speed, because those two are the same
        // fact stated twice. It used to be a flat 4 s: at 22 m/s a tideLance that missed
        // carried 88 m past its 16 m range, still armed, and the range reached nothing.
        life: shape.length / speed,
        kind: element === 'physical' ? 'arrow' : 'orb',
      });
      this.projectiles.set(pr.id, pr);
      return;
    }

    // Melee / AoE — `shape.hit` is the authored radius plus HIT_SLACK, and `shape.arc` is only
    // set for the kinds that have one, so a `disc` cannot accidentally inherit a facing test.
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - e.x, p.z - e.z);
      if (d > shape.hit) continue;
      if (shape.arc) {
        const ang = Math.atan2(p.x - e.x, p.z - e.z);
        if (Math.abs(angleDiff(ang, e.ry)) > shape.arc / 2) continue;
      }
      this.damagePlayer(p, baseDmg, element, e.def.gauge || 0, e, mv);
    }
    if (mv.root) {
      for (const p of this.players.values()) {
        if (Math.hypot(p.x - e.x, p.z - e.z) < shape.radius) {
          this.emit(S2C.PLAYER_ACTION, { playerId: p.playerId, action: 'rooted', duration: mv.root });
        }
      }
    }
  }

  applyDash(e, mv, dt) {
    const tgt = this.players.get(e.targetId);
    if (!tgt) return;
    const dx = tgt.x - e.x, dz = tgt.z - e.z;
    const len = Math.hypot(dx, dz) || 1;
    moveToward(this.zone, e, e.x + (dx / len) * 6, e.z + (dz / len) * 6, mv.dash, dt, 0.85);
  }

  applyPull(e, mv, shape, dt) {
    for (const p of this.players.values()) {
      const dx = e.x - p.x, dz = e.z - p.z;
      const d = Math.hypot(dx, dz);
      // The pull reaches exactly as far as the drawn disc, and no further.
      if (d > shape.radius || d < 0.5) continue;
      const f = (mv.pull * dt) / Math.max(1, d);
      p.x += dx * f; p.z += dz * f;
      p.dirty = true;
    }
  }

  /* ------------------------------------------------------------ projectiles -- */

  updateProjectiles(dt) {
    for (const pr of this.projectiles.values()) {
      const x0 = pr.x, y0 = pr.y, z0 = pr.z;
      pr.step(dt);
      const gh = heightAt(this.zone, pr.x, pr.z);
      if (pr.y < gh - 0.2) { pr.dead = true; continue; }
      if (pr.ownerType === 'enemy') {
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          if (Math.hypot(p.x - pr.x, p.z - pr.z) < pr.radius + 0.6 && Math.abs(p.y + 0.9 - pr.y) < 1.6) {
            const owner = this.enemies.get(pr.owner);
            this.damagePlayer(p, pr.damage, pr.element, pr.gauge, owner, { projectile: true });
            pr.dead = true;
            break;
          }
        }
      } else {
        for (const e of this.enemies.values()) {
          if (!e.alive) continue;
          const hb = e.def.hitbox || { r: 0.7, h: 1.8 };
          if (Math.hypot(e.x - pr.x, e.z - pr.z) < pr.radius + hb.r && pr.y > e.y - 0.5 && pr.y < e.y + hb.h + 0.6) {
            const meta = pr.meta || {};
            // 弱点. Two different things are called a weak point here, and they do not
            // stack. An enemy with an authored `weakspot` has a *place* — the ruin guard's
            // eye — and hitting it is the only way to get the bonus, which is why aiming at
            // one is worth doing; everything else keeps the old shape, "an aimed shot into
            // the top third", because a slime has no anatomy to aim at. Without the `!ws`
            // the machine's shoulder would pay exactly what its eye pays.
            // 0.15 m of arrowhead, not the projectile's own 0.9 m collision radius: that
            // radius exists so a fast shot cannot slip between ticks, and spending it on
            // the weak point too would turn a 50 cm eye into a 1.4 m sphere covering most
            // of the head and one shoulder.
            const weak = e.weakspotSweep(x0, y0, z0, pr.x, pr.y, pr.z, 0.15);
            this.playerHitEnemy(this.players.get(pr.owner), e, {
              scaling: meta.scaling ?? 0, flatDamage: pr.damage, element: pr.element,
              gauge: pr.gauge, kind: meta.kind || 'normal', cast: !!meta.cast,
              weakspot: weak,
              headshot: weak || (!e.def.weakspot && meta.aimed && pr.y > e.y + hb.h * 0.65),
            });
            pr.dead = true;
            break;
          }
        }
      }
    }
    for (const [id, pr] of this.projectiles) if (pr.dead) this.projectiles.delete(id);
  }

  updateFields(dt) {
    for (const f of this.fields) {
      if (this.now > f.until) continue;
      if (this.now < f.nextTick) continue;
      f.nextTick = this.now + f.interval;
      if (f.hostile) {
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          if (Math.hypot(p.x - f.x, p.z - f.z) < f.r) {
            this.damagePlayer(p, f.damage, f.element, f.gauge, null, { field: true });
          }
        }
      } else {
        const owner = this.players.get(f.owner);
        for (const e of this.enemies.values()) {
          if (!e.alive) continue;
          if (Math.hypot(e.x - f.x, e.z - f.z) < f.r + (e.def.hitbox?.r || 0.7)) {
            this.playerHitEnemy(owner, e, {
              scaling: 0, flatDamage: f.damage, element: f.element, gauge: f.gauge, kind: f.kind || 'skill',
            });
          }
        }
        if (f.heal && owner) {
          let anyHealed = false, over = 0;
          for (const p of this.players.values()) {
            if (Math.hypot(p.x - f.x, p.z - f.z) < f.r + 1.5) {
              const healed = p.heal(f.heal);
              over += f.heal - healed;
              if (healed > 0) {
                anyHealed = true;
                this.emit(S2C.DAMAGE, { target: 'player', id: p.playerId, amount: -Math.round(healed), element: 'light', kind: 'heal' });
              }
            }
          }
          const ost = owner.cur();
          if (anyHealed && ost) fireProcs(this, owner, ost, 'heal', { charId: ost.charId });
          if (ost) healOverflowToShield(this, owner, ost, over);
        }
      }
    }
    this.fields = this.fields.filter((f) => this.now <= f.until);
  }

  cleanup() {
    for (const [id, e] of this.enemies) {
      if (!e.alive && this.now - e.deadAt > 3.5) this.enemies.delete(id);
    }
  }

  /* -------------------------------------------------------------- damage in -- */

  damagePlayer(p, baseDamage, element, gauge, sourceEnemy, mv = {}) {
    if (!p.alive) return 0;
    const st = p.cur();
    const level = st?.level || 1;
    const eLevel = sourceEnemy?.level || this.zone.recommendedLevel || 1;
    // Player defence mitigation, mirroring the enemy formula. `liveStats` rather than
    // `st` so 铁尖枪's "受到伤害后防御力提升 10%" is felt by the *next* hit.
    const live = st ? liveStats(p, st, this.now) : null;
    // 超导's 减防 applies to whoever carries the reaction. `enemy.aura.defShred` has always been
    // read on the way out (`playerHitEnemy`); the player's own copy was read by nobody, so a
    // superconduct on your party was 1.0× damage and a name in the corner.
    const shred = 1 - Math.min(0.8, p.aura.defShred || 0);
    const mitig = (level + 100) / (level + 100 + (live?.def || 100) * shred * 1.4);
    // 地脉异常: every source of enemy damage lands here, so one multiplier covers melee,
    // projectiles and lingering fields alike.
    let dmg = baseDamage * mitig * (this.disorder()?.enemyDmgMul || 1);
    const reaction = gauge > 0 ? p.aura.apply(element, gauge, this.now) : null;
    if (reaction && AMPLIFYING.has(reaction.key)) dmg *= reaction.mult * 0.8;
    const sh = {};
    const dealt = p.takeDamage(dmg, this.now, element, sh);
    // Emitted when the shield ate the hit as well, not only when hp moved: a fully absorbed hit
    // used to produce *no event at all*, so wearing a shield turned the whole fight silent — no
    // number, no screen flash, no flinch, nothing to tell the player the shield was working.
    if (dealt > 0 || sh.absorbed > 0) {
      this.emit(S2C.DAMAGE, {
        target: 'player', id: p.playerId, amount: Math.round(dealt),
        element, kind: mv.projectile ? 'projectile' : mv.field ? 'field' : 'melee',
        reaction: reaction?.key || null, src: sourceEnemy?.id || null,
        shieldMul: sh.shieldMul || undefined,
        absorbed: sh.absorbed ? Math.round(sh.absorbed) : undefined,
        shieldBroke: sh.shieldBroke || undefined,
      });
    }
    if (dealt > 0 && st) fireProcs(this, p, st, 'hurt', { charId: st.charId });
    if (!p.alive) {
      this.emit(S2C.PLAYER_DOWN, { playerId: p.playerId, x: r2(p.x), y: r2(p.y), z: r2(p.z) });
    }
    return dealt;
  }

  /* ------------------------------------------------------------- damage out -- */

  /**
   * Authoritative player→enemy damage. The client requests an action; the server
   * validates cooldowns/range and computes the number.
   */
  playerHitEnemy(player, enemy, opts) {
    if (!player || !enemy?.alive) return null;
    const st = player.stats[opts.charId || player.charId];
    if (!st) return null;
    const element = opts.element || 'physical';
    const gauge = opts.gauge || 0;

    const reaction = gauge > 0 ? enemy.aura.apply(element, gauge, this.now) : null;
    const bonusElem = st.elemBonus?.[element] || 0;
    const typeBonus = st.typeBonus?.[opts.kind === 'aimed' ? 'aimed' : opts.kind] || 0;
    // Food, skill and gear buffs all live on `player.buffs`; `liveStats` is the one place
    // that folds them in, so atk/def/em/crit compose the same way for every source.
    const live = liveStats(player, st, this.now);
    // Conditions that only this hit can answer: is the target frozen, was it a weak
    // point, which reaction just fired.
    const gear = hitMods(st, enemy, { ...opts, reaction: reaction?.key || null }, this.now);
    let critRate = live.critRate + gear.critRate;
    let critDmg = live.critDmg + gear.critDmg;
    if (opts.headshot) critDmg += (CHARACTERS[st.charId]?.passive?.headshotBonus || 0.4);

    // 弱点倍率. Multiplied into the base rather than added to `bonus`, because ×3 is a
    // different claim from +200%: a bonus would compose with elemental and type bonuses
    // (and with the reaction's own multiplier) as one big sum, so the same shot would be
    // worth wildly different amounts depending on the character's build. Scaling the base
    // keeps "three times the hit you would otherwise have landed" literally true.
    const wmul = opts.weakspot ? (enemy.def.weakspot?.mult || 1) : 1;

    // 地脉异常, the outgoing half: a resistance shift on the target, a damage bonus for the
    // elements the floor rewards, and a reaction bonus. Each term is added to the one the
    // build already contributes rather than multiplied on top of the result, so a disorder
    // composes exactly like a piece of gear that granted the same thing.
    const dz = this.disorder();

    const res = computeDamage({
      atk: live.atk,
      scaling: (opts.scaling || 0) * wmul,
      flat: (opts.flatDamage || 0) * wmul,
      bonus: bonusElem + typeBonus + gear.bonus + (dz?.playerElemBonus?.[element] || 0),
      critRate, critDmg,
      level: st.level,
      targetLevel: enemy.level,
      targetRes: enemy.resistance(element) + (dz?.enemyRes?.[element] || 0),
      defShred: enemy.aura.defShred,
      mastery: live.em,
      reaction,
      reactionBonus: gear.reactionBonus + (dz?.reactionBonus || 0),
      rng: Math.random,
    });

    // The stagger is the other half of the mechanic, and the half that changes how the
    // fight is played: a ruin guard whose eye has just been shot stops mid-swing, which is
    // what makes carrying a bow into that fight a decision rather than a damage rounding.
    if (opts.weakspot && enemy.def.weakspot?.stun) {
      enemy.stunned = Math.max(enemy.stunned, this.now + enemy.def.weakspot.stun);
      enemy.dirty = true;
    }

    const applied = enemy.takeDamage(res.damage, player.playerId, this.now, element);
    let total = res.damage;
    if (res.reactionDamage > 0) {
      // Transformative damage is charged at the same rate as the hit that caused it: it is the
      // same element arriving, and a second `shieldBreakMul` on the reaction's own key would be
      // a second table (`swirl` has no element of its own to look up).
      const r2res = enemy.takeDamage(res.reactionDamage, player.playerId, this.now, element);
      total += res.reactionDamage;
      applied.absorbed += r2res.absorbed;
      applied.shieldBroke = applied.shieldBroke || r2res.shieldBroke;
      if (r2res.killed) applied.killed = true;
    }
    player.maxDamage = Math.max(player.maxDamage, total);

    // Reaction side effects
    if (reaction) this.applyReactionEffects(reaction, enemy, player, st);
    // Gear triggers that read the outcome of the hit rather than its target.
    if (res.crit) fireProcs(this, player, st, 'crit', { charId: st.charId });
    if (reaction) fireProcs(this, player, st, 'reaction', { charId: st.charId, reaction: reaction.key });
    // Energy on hit
    if (element !== 'physical') player.addEnergy(st.charId, opts.kind === 'burst' ? 0 : 2.4);
    else player.addEnergy(st.charId, 0.8);

    this.emit(S2C.DAMAGE, {
      target: 'enemy', id: enemy.id, amount: total, crit: res.crit,
      element, reaction: reaction?.key || null, kind: opts.kind || 'normal',
      weak: opts.weakspot || undefined,
      shieldBroke: applied.shieldBroke, by: player.playerId,
      // Only when a shield actually ate something: `shieldMul` is what the client turns into
      // 「护盾 ×2.0」/「护盾吸收」, and `absorbed` is what it must *not* subtract from the hp bar.
      shieldMul: applied.shieldMul || undefined,
      absorbed: applied.absorbed ? Math.round(applied.absorbed) : undefined,
      x: r2(enemy.x), y: r2(enemy.y + (enemy.def.hitbox?.h || 1.8) * 0.7), z: r2(enemy.z),
    });

    if (applied.killed) this.onEnemyKilled(enemy, player);
    if (opts.cast) this.skillFollowUp(player, st, enemy, element);
    return { total, crit: res.crit, reaction: reaction?.key || null, killed: applied.killed };
  }

  /**
   * 穿云之枪: "元素战技命中后造成额外 80% 攻击力的范围伤害".
   *
   * Driven from the hit rather than from `handleSkill` so it covers all three shapes an
   * elemental skill takes — direct radius, pierce line, and a projectile that lands a
   * second later — and gated on `opts.cast`, which only the cast itself sets. A lingering
   * field also reports `kind: 'skill'`, once every 0.5 s for ten seconds; without that
   * gate an 80 % burst would become a permanent damage aura. The per-player gap is what
   * keeps a five-target sweep paying once instead of five times.
   */
  skillFollowUp(player, st, enemy, element) {
    const mul = procSum(st, 'skillBurst');
    if (!mul) return;
    if (this.now - (player._skillFollowAt ?? -99) < SKILL_FOLLOW_GAP) return;
    player._skillFollowAt = this.now;
    const flat = liveStats(player, st, this.now).atk * mul;
    for (const e of this.enemies.values()) {
      if (!e.alive) continue;
      if (Math.hypot(e.x - enemy.x, e.z - enemy.z) > 3.6 + (e.def.hitbox?.r || 0.7)) continue;
      // gauge 0: the follow-up is extra damage, not a second elemental application, so it
      // cannot chain reactions off the hit that spawned it.
      this.playerHitEnemy(player, e, {
        scaling: 0, flatDamage: flat, element, gauge: 0, kind: 'skill', charId: st.charId,
      });
    }
  }

  applyDamageToEnemy(enemy, flat, element, gauge, byPlayerId, kind) {
    const player = byPlayerId ? this.players.get(byPlayerId) : null;
    if (player) return this.playerHitEnemy(player, enemy, { scaling: 0, flatDamage: flat, element, gauge, kind });
    const applied = enemy.takeDamage(flat, null, this.now, element);
    this.emit(S2C.DAMAGE, {
      target: 'enemy', id: enemy.id, amount: flat, element, kind,
      // An unowned source (a lingering field left by a dead player's burst, a hazard) can break
      // a shield too, and `_onDamage` hangs the shell and 「护盾破碎」 off this flag alone: without
      // it the mage's 900 points of ice would end with the gold bar simply vanishing.
      shieldBroke: applied.shieldBroke || undefined,
      shieldMul: applied.shieldMul || undefined,
      absorbed: applied.absorbed ? Math.round(applied.absorbed) : undefined,
    });
    if (applied.killed) this.onEnemyKilled(enemy, null);
    return applied;
  }

  applyReactionEffects(reaction, enemy, player, st) {
    const key = reaction.key;
    const def = REACTIONS[key];
    if (!def) return;
    if (reaction.aoe) {
      // Transformative AoE splash to nearby enemies.
      const splash = Math.round(st.atk * 0.35 * reaction.mult);
      for (const other of this.enemies.values()) {
        if (other === enemy || !other.alive) continue;
        if (Math.hypot(other.x - enemy.x, other.z - enemy.z) > reaction.aoe) continue;
        // Same element the splash is reported as, so a swirl that spreads fire is charged
        // against a neighbouring ice shield as fire.
        const splashElement = reaction.spreadElement || 'physical';
        const sp = other.takeDamage(splash, player.playerId, this.now, splashElement);
        if (reaction.spread && reaction.spreadElement) other.aura.apply(reaction.spreadElement, 1, this.now);
        this.emit(S2C.DAMAGE, {
          target: 'enemy', id: other.id, amount: splash, element: splashElement, reaction: key, kind: 'reaction',
          shieldMul: sp.shieldMul || undefined, absorbed: sp.absorbed ? Math.round(sp.absorbed) : undefined,
        });
        if (!other.alive) this.onEnemyKilled(other, player);
      }
    }
    if (reaction.knock) {
      const dx = enemy.x - player.x, dz = enemy.z - player.z;
      const len = Math.hypot(dx, dz) || 1;
      enemy.knockback = { dx: dx / len, dz: dz / len, speed: reaction.knock, time: 0.35 };
    }
    if (key === 'crystallize') {
      // `reaction.shieldElement` is the element the geo hit crystallised — `resolveReaction`
      // returned it from two branches and nobody read it, so every shard was the same
      // element-blind gold bar. It is what the shield is *made of*, so it decides both the
      // colour and how much of the next hit it eats (`Player.takeDamage`).
      player.grantShield(st.maxHp * REACTIONS.crystallize.shield * (1 + st.shieldStrength),
        this.now + 12, reaction.shieldElement || null, this.now);
    }
    if (key === 'freeze') enemy.state = 'stagger';
  }

  /**
   * Who gets paid for a corpse.
   *
   * The last hit used to be the whole answer, which made co-op combat pointless for
   * everybody except whoever landed it: a teammate could spend a minute of a boss's
   * health bar and walk away with no xp, no drops and no progress on 「讨伐 ×3」. The
   * fix does not need a new ledger — `Enemy.takeDamage` has been recording
   * `threat: Map<playerId, damage>` all along for its own aggro, so the receipt for
   * "I fought this" already exists and is authoritative on the server.
   *
   * Two conditions, both of them things a player can see themselves doing:
   * 1. their damage is in `enemy.threat` — a leech who never swung gets nothing, which
   *    is why this is threat-based rather than "everyone in the party";
   * 2. they are still within `ASSIST_RADIUS` of the corpse — tagging a camp and walking
   *    to the next valley is not helping.
   *
   * The killer is always paid (they are in `threat` too, but a kill by a lingering field
   * whose owner has switched characters is not, and `applyDamageToEnemy` can also pass
   * `byPlayer = null`, in which case the threat holders are the only claimants).
   */
  killCredit(enemy, byPlayer) {
    const paid = [];
    if (byPlayer) paid.push(byPlayer);
    for (const [pid, dmg] of enemy.threat || []) {
      if (!(dmg > 0)) continue;
      const p = this.players.get(Number(pid));
      if (!p || paid.includes(p)) continue;
      if (Math.hypot(p.x - enemy.x, p.z - enemy.z) > ASSIST_RADIUS) continue;
      paid.push(p);
    }
    return paid;
  }

  onEnemyKilled(enemy, byPlayer) {
    enemy.alive = false;
    enemy.deadAt = this.now;
    this.emit(S2C.ENEMY_DIED, {
      id: enemy.id, t: enemy.defId, x: r2(enemy.x), y: r2(enemy.y), z: r2(enemy.z),
      by: byPlayer?.playerId || null, elite: enemy.elite, boss: enemy.boss,
    });
    if (byPlayer) {
      byPlayer.kills++;
      const st = byPlayer.cur();
      // 击败 procs belong to the player who actually finished it: an assist is not a kill.
      if (st) fireProcs(this, byPlayer, st, 'kill', { charId: st.charId });
    }
    // One roll per claimant rather than one roll shared out: each player's drops are their
    // own, the way a co-op world hands every visitor their own pickup, so joining a fight
    // never costs the host anything. `assist` rides along so the host can pay a helper
    // without crediting them with the kill on the leaderboard.
    for (const p of this.killCredit(enemy, byPlayer)) {
      const loot = rollEnemyLoot(enemy.defId, enemy.level, (Math.random() * 2 ** 31) | 0);
      this.hooks.onKill?.(this, p, enemy, loot, { assist: p !== byPlayer });
    }
  }

  /* -------------------------------------------------------------- snapshots -- */

  broadcastSnapshot() {
    const players = [...this.players.values()].map((p) => p.serialize());
    for (const viewer of this.players.values()) {
      const enemies = [];
      for (const e of this.enemies.values()) {
        if (Math.hypot(e.x - viewer.x, e.z - viewer.z) > AOI_RADIUS) continue;
        enemies.push(e.serialize());
      }
      const projectiles = [];
      for (const pr of this.projectiles.values()) {
        if (Math.hypot(pr.x - viewer.x, pr.z - viewer.z) > AOI_RADIUS) continue;
        projectiles.push(pr.serialize());
      }
      this.hooks.sendTo?.(viewer.playerId, {
        t: S2C.SNAPSHOT,
        d: {
          tick: this.tick, now: r2(this.now),
          players: players.filter((pp) => pp.id === viewer.playerId
            || Math.hypot(pp.x - viewer.x, pp.z - viewer.z) < AOI_RADIUS * 1.6),
          enemies, projectiles,
          fields: this.fields.filter((f) => this.now <= f.until).map((f) => ({
            x: r2(f.x), z: r2(f.z), r: f.r, e: f.element, u: r2(f.until), h: f.hostile ? 1 : 0,
          })),
          cold: Math.round(viewer.cold),
          energy: Object.fromEntries(Object.entries(viewer.energy).map(([k, v]) => [k, Math.round(v)])),
          // 冷却, per character, keyed `${charId}:skill|burst` — the same map the sim gates casts
          // on. Beside `energy` and `hpByChar` because it is the same kind of thing: state that
          // belongs to a party member who is not on the field, which the client can only guess at
          // and used to guess wrong (see `Player.cooldownLeft`).
          cds: viewer.cooldownMap(this.now),
          hpByChar: Object.fromEntries(Object.entries(viewer.hpByChar).map(([k, v]) => [k, Math.round(v)])),
          stamina: Math.round(viewer.stamina),
          chamber: this.chamber ? {
            floor: this.chamber.floor, state: this.chamber.state,
            remaining: this.chamber.ids.size,
            timeLeft: r2(Math.max(0, this.chamber.timeLimit - (this.now - this.chamber.startedAt))),
            // Waves and the disorder ride the snapshot as well as the CHAMBER event: a
            // player who reloads mid-run, or joins a shard already fighting, has no event
            // to have missed and would otherwise see 「第 1 间」 with no idea what is
            // modifying the fight.
            wave: this.chamber.wave + 1, waves: this.chamber.waves.length,
            waveIn: this.chamber.nextWaveAt ? r2(Math.max(0, this.chamber.nextWaveAt - this.now)) : 0,
            disorder: this.chamber.disorder?.id || null,
          } : null,
        },
      });
    }
  }

  zoneStateFor(player) {
    return {
      zone: this.zoneId, shard: this.shard, tick: this.tick, now: r2(this.now),
      you: player.serialize(),
      players: [...this.players.values()].filter((p) => p !== player).map((p) => p.serialize()),
      enemies: [...this.enemies.values()].map((e) => e.serialize()),
    };
  }
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function lerpAngle(a, b, t) {
  return a + angleDiff(b, a) * clamp(t, 0, 1);
}
