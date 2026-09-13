// Entity model for the authoritative simulation: enemies with AI state machines,
// projectiles, players.
//
// This lives in `shared/` because the simulation has two hosts. Online, it runs in
// the server's zone instances. In 单机 (solo) mode it runs *in the browser*, so a
// player with no reachable gateway still gets the same enemies, the same AI and the
// same damage numbers. Nothing in this file may touch the database, Redis, or any
// Node built-in.

import { AuraState, shieldBreakMul } from '../data/elements.js';
import { CHARACTERS } from '../data/characters.js';
import { ENEMIES, ATTACK_MOVES, AI } from '../data/enemies.js';
import { enemyStatAtLevel } from '../sim/formulas.js';
import { heightAt, slopeAt } from '../data/zones.js';
import { Rand, clamp } from '../sim/rng.js';

/** Health a free revive (a teammate, the respawn timer, a burst) hands back. */
export const REVIVE_HP_PCT = 0.5;

/**
 * How many charges a multi-charge skill has back by `now`, and when that count started.
 *
 * The regeneration rule for `skill.charges` — one charge per `cd` since `state.at`. It lives here
 * because two places have to agree about it: `handleSkill`, which spends a charge, and
 * `Player.cooldownLeft`, which tells the client whether pressing E would do anything. A second
 * copy of this arithmetic is a HUD that says 冷却 while the sim happily casts, or a ring that
 * reads ready against a sim that refuses.
 */
export function regenCharges(state, charges, cd, now) {
  const regen = Math.floor((now - state.at) / cd);
  return {
    n: Math.min(charges, state.n + Math.max(0, regen)),
    at: regen > 0 ? state.at + regen * cd : state.at,
  };
}

/**
 * How close you must stand to pick a teammate up.
 *
 * Shared so the click that sends the request and the gateway check that answers it use one
 * number: a client that thought the range was 6 would send a request the server calls `too_far`,
 * and the player would be clicking a body that never gets up.
 */
export const REVIVE_RANGE = 4;

let nextId = 1;
export function newId(prefix = 'e') {
  return `${prefix}${(nextId++).toString(36)}`;
}

export class Enemy {
  constructor(defId, level, x, y, z, zone, opts = {}) {
    const def = ENEMIES[defId];
    this.id = newId('e');
    this.defId = defId;
    this.def = def;
    this.level = level;
    this.zone = zone;
    this.maxHp = enemyStatAtLevel(def.base.hp, level) * (opts.hpMul || 1);
    this.hp = this.maxHp;
    this.atk = enemyStatAtLevel(def.base.atk, level);
    this.defence = enemyStatAtLevel(def.base.def, level);
    this.x = x; this.y = y; this.z = z;
    this.spawn = { x, y, z };
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.ry = opts.ry ?? 0;
    this.aura = new AuraState();
    this.state = 'idle';         // idle | chase | windup | active | recover | stagger | dead
    this.stateUntil = 0;
    this.move = null;
    this.targetId = null;
    this.attackCd = 0;
    this.alive = true;
    this.deadAt = 0;
    this.shield = def.shield ? { hp: enemyStatAtLevel(def.shield.hp, level), max: enemyStatAtLevel(def.shield.hp, level), element: def.shield.element } : null;
    this.phase = 1;
    this.rooted = 0;
    this.stunned = 0;
    this.knockback = null;
    this.homeRadius = opts.homeRadius ?? 26;
    this.camp = opts.camp ?? null;
    this.rand = new Rand((nextId * 2654435761) >>> 0);
    this.lastDamageBy = null;
    this.threat = new Map();     // playerId -> threat value
    this.tauntedBy = null;
    this.tauntUntil = 0;
    this.dirty = true;
    this.moveIndex = 0;
    this.summonedBy = opts.summonedBy || null;
    this.elite = !!def.elite;
    this.boss = !!def.boss;
    this.flying = !!def.flying;
    this.hitAt = 0;
  }

  get resFor() { return this.def.res || {}; }

  /**
   * The authored weak point in world space, or null. `def.weakspot.offset` is written in
   * the creature's own frame (+Z forward, origin at the feet), which is the frame the model
   * is built in — `ry` is applied here the same way `group.rotation.y = ry` applies it in
   * the client, so a machine that has turned its back presents its armour and not its eye.
   */
  weakspotWorld() {
    const w = this.def.weakspot;
    if (!w) return null;
    const [ox, oy, oz] = w.offset;
    const cos = Math.cos(this.ry), sin = Math.sin(this.ry);
    return {
      x: this.x + ox * cos + oz * sin,
      y: this.y + oy,
      z: this.z - ox * sin + oz * cos,
      r: w.r,
    };
  }

  /**
   * Did a projectile's travel *this tick* pass through the weak point?
   *
   * A segment and not a point on purpose: the tick is 50 ms and an aimed arrow flies at
   * 70 m/s, so it advances 3.5 m per step — further than the ruin guard is wide. Testing
   * the endpoint would ask whether the arrow happened to stop inside a 50 cm sphere, which
   * at that speed is a 14% chance even for a perfect shot, and the answer would depend on
   * how far away the bow was fired from.
   */
  weakspotSweep(x0, y0, z0, x1, y1, z1, pad = 0) {
    const w = this.weakspotWorld();
    if (!w) return false;
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len2 = dx * dx + dy * dy + dz * dz;
    let t = len2 > 0 ? ((w.x - x0) * dx + (w.y - y0) * dy + (w.z - z0) * dz) / len2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(x0 + dx * t - w.x, y0 + dy * t - w.y, z0 + dz * t - w.z) <= w.r + pad;
  }

  resistance(element) {
    const r = this.def.res || {};
    if (r[element] !== undefined) return r[element];
    return 0.1;
  }

  /**
   * `element` is what decides how much of the hit the shield eats (`shieldBreakMul`), so it is
   * not optional in spirit even though it defaults: a caller that forgets it charges the shield
   * at the physical rate, which is the neutral one, so the mistake shows up as a mechanic that
   * quietly stops rewarding the right element rather than as a crash.
   */
  takeDamage(amount, sourceId, now, element = 'physical') {
    if (!this.alive) return { dealt: 0, killed: false, shieldBroke: false, absorbed: 0, shieldMul: 0 };
    let dealt = amount;
    let shieldBroke = false;
    let absorbed = 0;
    let shieldMul = 0;
    if (this.shield && this.shield.hp > 0) {
      // The multiplier is charged against the shield, not against the damage: a 1000-point fire
      // hit spends 2000 of an ice shield's 900 and the *overflow* is converted back before it
      // reaches hp, so a hit that exactly empties a shield does exactly nothing to the body.
      shieldMul = shieldBreakMul(element, this.shield.element);
      const charged = dealt * shieldMul;
      const eaten = Math.min(this.shield.hp, charged);
      this.shield.hp -= eaten;
      absorbed = eaten / shieldMul;
      dealt -= absorbed;
      if (this.shield.hp <= 0) { shieldBroke = true; this.stunned = now + 2.0; }
    }
    this.hp -= dealt;
    this.hitAt = now;
    if (sourceId) {
      this.lastDamageBy = sourceId;
      this.threat.set(sourceId, (this.threat.get(sourceId) || 0) + amount);
    }
    this.dirty = true;
    let killed = false;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.state = 'dead';
      this.deadAt = now;
      killed = true;
    } else if (this.boss && this.def.phases) {
      const frac = this.hp / this.maxHp;
      const wanted = this.def.phases - Math.floor(frac * this.def.phases);
      if (wanted > this.phase) { this.phase = wanted; this.stunned = now + 1.2; }
    }
    // `dealt` reports the whole hit (that is the number the player sees and the leaderboard
    // reads); `absorbed` is how much of it never reached hp, which is what a client needs to
    // predict the hp bar without fighting the next snapshot.
    return { dealt: amount, killed, shieldBroke, absorbed, shieldMul };
  }

  /** Pick the highest-threat live target within aggro range. */
  pickTarget(players, now) {
    if (this.tauntedBy && now < this.tauntUntil) {
      const t = players.get(this.tauntedBy);
      if (t && t.alive) return t;
      this.tauntedBy = null;
    }
    let best = null, bestScore = -Infinity;
    for (const p of players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - this.x, p.z - this.z);
      const aggro = this.def.aggro * (this.state === 'idle' ? 1 : 1.8);
      if (d > aggro) continue;
      const threat = this.threat.get(p.playerId) || 0;
      const score = threat / 100 - d;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  chooseMove() {
    const list = this.def.attacks;
    if (!list || !list.length) {
      return this.def.ai === AI.ranged ? 'basicRanged' : this.def.ai === AI.caster ? 'basicCast' : 'basic';
    }
    // Bosses cycle with weighting toward phase-appropriate moves.
    const pool = this.phase >= 2 ? list : list.slice(0, Math.max(2, list.length - 1));
    this.moveIndex = (this.moveIndex + 1 + this.rand.int(0, 1)) % pool.length;
    return pool[this.moveIndex];
  }

  serialize() {
    return {
      id: this.id, t: this.defId, lv: this.level,
      x: r2(this.x), y: r2(this.y), z: r2(this.z), ry: r2(this.ry),
      hp: Math.round(this.hp), mhp: Math.round(this.maxHp),
      st: this.state, mv: this.move || null,
      sh: this.shield ? Math.round(this.shield.hp) : 0,
      shm: this.shield ? Math.round(this.shield.max) : 0,
      au: this.aura.dominant() || null,
      fz: this.aura.frozenUntil > 0 ? r2(this.aura.frozenUntil) : 0,
      ph: this.phase,
      a: this.alive ? 1 : 0,
    };
  }
}

export class Projectile {
  constructor({ owner, ownerType, x, y, z, dx, dy, dz, speed, damage, element, gauge, radius, life, kind }) {
    this.id = newId('p');
    this.owner = owner;
    this.ownerType = ownerType;  // 'player' | 'enemy'
    this.x = x; this.y = y; this.z = z;
    const len = Math.hypot(dx, dy, dz) || 1;
    this.dx = dx / len; this.dy = dy / len; this.dz = dz / len;
    this.speed = speed;
    this.damage = damage;
    this.element = element || 'physical';
    this.gauge = gauge || 0;
    this.radius = radius || 0.9;
    this.life = life ?? 3.0;
    this.kind = kind || 'arrow';
    this.dead = false;
  }
  step(dt) {
    this.x += this.dx * this.speed * dt;
    this.y += this.dy * this.speed * dt;
    this.z += this.dz * this.speed * dt;
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }
  serialize() {
    return { id: this.id, x: r2(this.x), y: r2(this.y), z: r2(this.z),
      dx: r2(this.dx), dy: r2(this.dy), dz: r2(this.dz), s: this.speed, k: this.kind, e: this.element };
  }
}

export class PlayerEntity {
  constructor(playerId, nickname, save, stats) {
    this.playerId = Number(playerId);
    this.nickname = nickname;
    this.save = save;
    this.stats = stats;             // { charId: builtStats }
    this.charId = save.party?.[save.activeSlot || 0] || save.party?.[0] || 'lyra';
    this.x = save.pos?.x || 0;
    this.y = save.pos?.y || 4;
    this.z = save.pos?.z || 0;
    this.ry = save.pos?.ry || 0;
    this.vy = 0;
    this.action = 0;
    this.alive = true;
    this.hp = this.maxHp();
    this.energy = {};
    this.aura = new AuraState();
    this.lastInput = Date.now();
    this.cooldowns = {};            // `${charId}:skill` -> readyAt (seconds)
    this.buffs = [];
    this.shieldHp = 0;
    this.shieldUntil = 0;
    this.shieldElement = null;      // 结晶's shard element, or the caster's own — see grantShield
    this.zone = save.zone || 'mondstadt';
    this.downedAt = 0;
    this.sequence = 0;
    this.chargeStart = 0;
    this.kills = 0;
    this.maxDamage = 0;
    this.cold = 0;
    this.stamina = 240;
    this.dirty = true;
    this.party = save.party || [];
    for (const c of this.party) this.energy[c] = 0;
    this.hpByChar = {};
    for (const c of this.party) this.hpByChar[c] = this.maxHpOf(c);
  }

  maxHpOf(charId) { return this.stats[charId]?.maxHp || 1000; }
  maxHp() { return this.maxHpOf(this.charId); }
  cur() { return this.stats[this.charId] || null; }

  /**
   * A build changed while the player is standing in the world.
   *
   * `stats` and `party` are snapshots taken at zone entry: `this.stats` is the object
   * `derivedStats` built when the socket joined and `this.party` is a *copy* of
   * `save.party`. Everything the game asks the player to do between two zone loads —
   * level a character, ascend, raise a talent, equip a weapon, enhance an artifact,
   * refine, or edit the party — happens over HTTP and mutates the saved document, not
   * these. So the whole progression loop used to be cosmetic until the next zone load:
   * a measured case is a starter 伊格纳 taken from Lv.1 to Lv.17 (maxHp 1290 → 2460) who
   * kept fighting with 1290 hp and the old attack, and a character dropped from the party
   * who could still be switched to. Both halves are the same missing step, which is this
   * method — and it lives on the entity because the simulation has two hosts (the
   * gateway's `WorldManager` and the browser's `localSocket`) and a build that only
   * updates online is a balance fork.
   *
   * `heal` is the small top-up a level-up hands back (the kill path has always given
   * 200); it never revives a character who is at 0.
   *
   * @returns {{party:string[], charId:string, switched:boolean, maxHp:number}}
   */
  applyBuild(stats, party = null, { heal = 0 } = {}) {
    if (stats) this.stats = stats;
    // The active character's hp lives in `this.hp`; `hpByChar` is only written on a
    // switch, so it has to be brought up to date before the roster is rebuilt from it.
    this.hpByChar[this.charId] = this.hp;
    // A roster entry with no stat block cannot be fought with (`switchTo` refuses it),
    // and an empty result means the caller sent something unusable — keep the old team
    // rather than leaving the player with nobody to control.
    const wanted = (party?.length ? party : this.party).filter((c) => this.stats[c]);
    const roster = wanted.length ? wanted : this.party.filter((c) => this.stats[c]);
    for (const c of this.party) {
      if (!roster.includes(c)) { delete this.energy[c]; delete this.hpByChar[c]; }
    }
    this.party = [...roster];
    for (const c of roster) {
      if (this.energy[c] === undefined) this.energy[c] = 0;
      const max = this.maxHpOf(c);
      const cur = this.hpByChar[c];
      // Someone who was not on the team arrives at full health; someone who was keeps
      // the hp they had, under whatever ceiling the new build gives them.
      this.hpByChar[c] = cur === undefined ? max : Math.min(max, cur > 0 ? cur + heal : cur);
    }
    let switched = false;
    if (!roster.includes(this.charId)) {
      this.charId = roster.find((c) => (this.hpByChar[c] ?? 0) > 0) || roster[0];
      switched = true;
    }
    this.hp = Math.min(this.maxHp(), this.hpByChar[this.charId] ?? this.maxHp());
    this.dirty = true;
    return { party: [...this.party], charId: this.charId, switched, maxHp: this.maxHp() };
  }

  switchTo(charId) {
    if (!this.party.includes(charId)) return false;
    if (!this.stats[charId]) return false;
    this.hpByChar[this.charId] = this.hp;
    this.charId = charId;
    this.hp = this.hpByChar[charId] ?? this.maxHpOf(charId);
    if (this.hp <= 0) this.hp = Math.max(1, Math.round(this.maxHpOf(charId) * 0.3));
    return true;
  }

  /**
   * Seconds until `charId` could cast `which` ('skill' | 'burst') again.
   *
   * 冷却 has always been per character *here* — `cooldowns` is keyed `${charId}:skill` — and the
   * client kept a single `skillCd` for whoever stood on the field, corrected by nothing: no
   * packet carried a cooldown, so `setCharacter`'s promise that "the HUD gets the truth from the
   * next snapshot" was a comment about a wire field that did not exist. Switching characters
   * therefore handed the incoming one the outgoing one's cooldown, and `useSkill` refused a cast
   * the simulation would have allowed. That is the whole 元素反应 rotation: 附着 with one
   * character, switch, 触发 with the next, inside the aura's few seconds.
   *
   * Charge skills answer through `regenCharges`, so "ready" means the same thing here as in
   * `handleSkill`, and `cdReduction` is applied because the server's cooldown is the shorter one
   * an artifact bought.
   */
  cooldownLeft(charId, which, now) {
    const skill = which === 'skill' ? CHARACTERS[charId]?.skill : null;
    const charges = skill?.charges || 1;
    if (charges > 1) {
      const state = this._skillCharges?.[charId];
      if (!state) return 0;
      const cd = skill.cd * (1 - (this.stats[charId]?.cdReduction || 0));
      const { n, at } = regenCharges(state, charges, cd, now);
      return n > 0 ? 0 : Math.max(0, at + cd - now);
    }
    return Math.max(0, (this.cooldowns[`${charId}:${which}`] || 0) - now);
  }

  /**
   * Every party member's remaining cooldowns, for the snapshot. Ready ones are left out: a key
   * that is absent is a skill that can be cast, which is also what a client that has never heard
   * of a character should assume.
   */
  cooldownMap(now) {
    const out = {};
    for (const c of this.party) {
      for (const which of ['skill', 'burst']) {
        const left = this.cooldownLeft(c, which, now);
        if (left > 0.05) out[`${c}:${which}`] = r2(left);
      }
    }
    return out;
  }

  addEnergy(charId, amount) {
    const cap = charId === this.charId ? 1 : 0.6;   // off-field gains less
    const er = this.stats[charId]?.er || 1;
    this.energy[charId] = clamp((this.energy[charId] || 0) + amount * er * cap, 0, 120);
  }

  /**
   * A shield replaces a weaker one instead of stacking — and the element goes with whichever one
   * wins, because that is what the next hit is charged against. Splitting the three lines out of
   * the four places that granted a shield (`actions.handleSkill`, `procs.healOverflowToShield`,
   * `zoneInstance.applyReactionEffects` for 结晶, and the burst path through the first) is what
   * makes «which element is this shield made of» a question with one answer: a 800-point crystal
   * shard must not relabel a 4000-point geo shield and get it charged at the shard's rate for the
   * rest of its 12 seconds.
   */
  grantShield(hp, until, element = null, now = 0) {
    // A weaker shield while a stronger one *still stands* changes nothing at all, timer included:
    // the old code reset `shieldUntil` unconditionally, so a 200-point shard could shorten a
    // 12-second geo shield to its own duration. `now` is what makes "stands" checkable — an
    // expired shield whose hp the tick has not zeroed yet must not block the new one.
    if (this.shieldHp > hp && this.shieldUntil > now) return false;
    this.shieldHp = hp;
    this.shieldUntil = until;
    this.shieldElement = element;
    this.dirty = true;
    return true;
  }

  clearShield() {
    if (!this.shieldHp && !this.shieldElement) return;
    this.shieldHp = 0;
    this.shieldElement = null;
    this.dirty = true;
  }

  /**
   * `element` decides how much of the hit the shield eats, exactly as it does for an enemy's
   * elemental shield (`shieldBreakMul`): a cryo crystal shard resists 龙脊雪山's cold at half
   * rate and a pyro attack shatters it twice as fast. `out`, when passed, receives
   * `{ absorbed, shieldMul, shieldBroke }` — the numbers the client needs to explain what just
   * happened, kept off the return value so the four probes that call this for its HP arithmetic
   * keep reading a number.
   */
  takeDamage(amount, now, element = 'physical', out = null) {
    if (!this.alive) return 0;
    let dmg = amount;
    const st = this.cur();
    const shielded = this.shieldUntil > now && this.shieldHp > 0;
    // 大地之盾: "护盾存在时受到的伤害降低 15%". The condition can only be judged here, one
    // line before the shield is spent, which is why the talent value rides on the stat
    // block — it was in `characters.js` and read by nothing at all until now.
    const dr = (st?.dr || 0) + (shielded ? (st?.shieldDR || 0) : 0);
    if (dr) dmg *= 1 - dr;
    if (shielded) {
      const mul = shieldBreakMul(element, this.shieldElement);
      const eaten = Math.min(this.shieldHp, dmg * mul);
      this.shieldHp -= eaten;
      const abs = eaten / mul;      // back into damage, so emptying a shield exactly costs 0 hp
      dmg -= abs;
      if (out) { out.absorbed = abs; out.shieldMul = mul; out.shieldBroke = this.shieldHp <= 0; }
      if (this.shieldHp <= 0) this.clearShield();
    }
    this.hp -= dmg;
    this.dirty = true;
    if (this.hp <= 0) {
      this.hp = 0;
      // Auto-swap to next living character; only fully down when all are out.
      const next = this.party.find((c) => c !== this.charId && (this.hpByChar[c] ?? this.maxHpOf(c)) > 0);
      if (next) {
        this.hpByChar[this.charId] = 0;
        this.charId = next;
        this.hp = this.hpByChar[next] ?? this.maxHpOf(next);
      } else {
        this.alive = false;
        this.downedAt = now;
      }
    }
    return dmg;
  }

  heal(amount) {
    const max = this.maxHp();
    const before = this.hp;
    this.hp = Math.min(max, this.hp + amount);
    this.hpByChar[this.charId] = this.hp;
    return this.hp - before;
  }

  /**
   * Stand back up with `hpPct` of each party member's maximum.
   *
   * The fraction is an argument because the sources disagree on it and one of them is
   * *printed in the game*: 提神醒脑的汤 carries `revive: { hpPct: 0.4 }` and the inventory
   * panel promises "恢复 40% 生命值", while this function used to hardcode 0.5 and read
   * nothing — the dish's own number was authored data with no consumer. The free revives
   * (a teammate's hand, the 8-second respawn, a burst that revives) keep the old default.
   *
   * `Math.max` because a revive must never *lower* anyone: after a wipe every slot is at 0,
   * but a burst with `revive` can land on a party whose bench is still healthy.
   */
  revive(hpPct = REVIVE_HP_PCT) {
    this.alive = true;
    for (const c of this.party) {
      this.hpByChar[c] = Math.max(this.hpByChar[c] || 0, Math.round(this.maxHpOf(c) * hpPct));
    }
    this.hp = this.hpByChar[this.charId];
    this.aura.clear();
    this.dirty = true;
  }

  serialize() {
    return {
      id: this.playerId, n: this.nickname, c: this.charId,
      x: r2(this.x), y: r2(this.y), z: r2(this.z), ry: r2(this.ry),
      a: this.action, hp: Math.round(this.hp), mhp: Math.round(this.maxHp()),
      en: Math.round(this.energy[this.charId] || 0),
      al: this.alive ? 1 : 0,
      // `shieldUntil` is on the *instance* clock ("seconds since instance start", from 0),
      // and this used to compare it against `Date.now() / 1000` — an epoch 1.7e9 seconds
      // larger. The test was therefore false for every shield that has ever existed, so the
      // HUD bar was 0 % wide whatever 结晶/磐岩壁垒/圣咏回响 put on the player. Nothing else
      // had to be wrong for the shield to be invisible, which is why the whole feature could
      // be simulated, gated and unit-tested for months without anyone seeing it;
      // `tools/shield-ui.mjs` measures the pixels and found it in one run.
      // No clock here at all now: `updatePlayer` clears an expired shield on the very next
      // tick (50 ms), and a shield the simulation still counts is a shield the bar must show.
      sh: Math.round(this.shieldHp > 0 ? this.shieldHp : 0),
      // Which element the shield is made of, for the bar's colour and for the shell VFX that
      // plays when it goes up — on my own HUD and on every other player's nameplate alike.
      she: this.shieldHp > 0 ? this.shieldElement : null,
      au: this.aura.dominant() || null,
      pt: this.party,
    };
  }
}

export function r2(v) {
  return Math.round(v * 100) / 100;
}

/** Clamp an entity onto terrain, keeping it out of unwalkable slopes. */
export function groundEntity(zone, ent, dt, gravity = -24) {
  const gh = heightAt(zone, ent.x, ent.z);
  if (ent.flying) {
    const target = gh + 5.5;
    ent.y += (target - ent.y) * Math.min(1, dt * 2.4);
    return;
  }
  ent.vy = (ent.vy || 0) + gravity * dt;
  ent.y += ent.vy * dt;
  if (ent.y <= gh) { ent.y = gh; ent.vy = 0; }
}

export function moveToward(zone, ent, tx, tz, speed, dt, maxSlope = 0.72) {
  const dx = tx - ent.x, dz = tz - ent.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.001) return 0;
  const step = Math.min(d, speed * dt);
  const nx = ent.x + (dx / d) * step;
  const nz = ent.z + (dz / d) * step;
  if (slopeAt(zone, nx, nz) <= maxSlope || ent.flying) {
    ent.x = nx; ent.z = nz;
  } else {
    // Slide along the obstacle rather than sticking.
    const perp = [-dz / d, dx / d];
    const sx = ent.x + perp[0] * step * 0.8;
    const sz = ent.z + perp[1] * step * 0.8;
    if (slopeAt(zone, sx, sz) <= maxSlope) { ent.x = sx; ent.z = sz; }
  }
  ent.ry = Math.atan2(dx, dz);
  return d - step;
}
