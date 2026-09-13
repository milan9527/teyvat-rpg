// The player's own avatar: movement, terrain physics, click-to-move, stamina,
// and the local half of combat.
//
// The server is authoritative, but the client simulates the local character
// immediately and reconciles when corrected. Waiting for a round trip before the
// character moves makes even 40 ms of latency feel like mud, and the server's own
// anti-teleport check (14 m/s + slack) is exactly the budget this controller stays
// inside, so corrections are rare in practice.
//
// Click-to-move is a first-class control path, not a convenience: the whole game
// is playable with a mouse. A left click on the ground sets a move goal; a left
// click on an enemy sets a target and closes to weapon range before swinging.

import * as THREE from 'three';
import {
  CHARACTERS, WEAPON_TYPES, SKILL_RADIUS, playerAttackShape,
} from '@teyvat/shared/data/characters.js';
import { blinkDestination } from '@teyvat/shared/world/actions.js';
import { STAMINA } from '@teyvat/shared/sim/formulas.js';
import { ACTION } from '@teyvat/shared/protocol.js';
import { REVIVE_RANGE } from '@teyvat/shared/world/entity.js';
import { clamp, lerp } from '@teyvat/shared/sim/rng.js';
import { CharacterActor } from './actors.js';
import { elementColor } from './vfx.js';

const GRAVITY = -24;
const JUMP_V = 8.4;
const WALK = 2.3;
const RUN = 5.2;
const SPRINT = 8.2;
const SWIM = 2.6;
const GLIDE_FALL = -2.4;
const GLIDE_FORWARD = 6.2;
const MAX_SLOPE = 0.68;        // matches the server's moveToward default
// Climbing. `CLIMB` is a speed *along the face*, not a horizontal one. `world.slopeAt` returns
// `1 - normal.y`, so the surface normal's vertical component is `1 - slope` and the horizontal
// speed that yields `CLIMB` along a face is exactly `CLIMB * (1 - slope)` — the projection falls
// out of the metric with no second constant to disagree with the geometry. MAX_SLOPE 0.68 is a
// 71° face, so everything climbable here is between 71° and vertical: 0.20–0.55 m/s across the
// ground, 1.6–1.7 m/s up it.
const CLIMB = 1.75;
const CLIMB_LUNGE = 5.4;       // jump while on a wall: a short surge up the face
const CLIMB_LUNGE_COST = 12;
const TURN_RATE = 12.0;        // rad/s
const ARRIVE = 0.55;           // click-to-move goal tolerance
const COMBO_WINDOW = 1.4;      // matches the server's sequence reset
const CHARGE_TIME = 0.32;      // hold before a normal becomes a charged attack
// One flinch per `hit` clip length (0.34 s) plus a little: 燃烧 ticks at 4 Hz and a reaction
// restarted on every tick is a vibrating character, not a hit reaction.
const FLINCH_GAP = 0.42;
// Casts the combat rules already treat as committed — the animation must not promise an
// interrupt the damage model does not deliver.
const UNINTERRUPTIBLE = new Set(['skill', 'burst', 'charged', 'plunge', 'down']);

const V = new THREE.Vector3();
const V2 = new THREE.Vector3();

export class LocalPlayer {
  constructor(scene, world, camera, socket, vfx, opts = {}) {
    this.scene = scene;
    this.world = world;
    this.camera = camera;
    this.socket = socket;
    this.vfx = vfx;

    this.charId = opts.charId || 'lyra';
    this.actor = new CharacterActor(this.charId, scene, { local: true });
    this.def = CHARACTERS[this.charId];

    this.x = 0; this.y = 0; this.z = 0;
    this.ry = 0;
    this.vy = 0;
    this.speed = 0;
    this.grounded = true;
    this.swimming = false;
    this.gliding = false;
    this.climbing = false;
    this._climbSlope = 0.7;     // `1 - normal.y` of the face we are on, for the speed projection
    this.alive = true;

    this.stamina = STAMINA.max;
    this.staminaBlocked = 0;    // seconds of lockout after hitting zero

    // Click-to-move
    this.goal = null;           // { x, z }
    this.goalKind = null;       // 'move' | 'approach' | 'interact' | 'rescue'
    this.goalPayload = null;
    // 双击 = 冲刺前往. The mouse had no sprint at all: a keyboard player holds Shift, and a
    // mouse player was capped at RUN however far they clicked, which is the one place the
    // primary control scheme was strictly weaker than the secondary one. It is a *flag on the
    // order*, not a second movement rule — `sprintHeld` below is the only definition of
    // "sprinting", so the drain, the stamina lockout, the speed cap, the regen block and the
    // broadcast pose cannot disagree between the two ways of asking for it.
    this.goalSprint = false;
    this.target = null;         // enemy id we are locked to
    this.lockOn = false;

    // Combat
    this.combo = 0;
    this.lastAttackAt = -10;
    this.attackCooldown = 0;
    this.charging = 0;
    this.aiming = false;
    // Sitting is a *pose*, not a state the server arbitrates: it costs nothing, blocks nothing,
    // and is broadcast for free because `currentAction()` already goes out with every snapshot.
    this.sitting = false;
    this._flinchAt = -10;       // last hit-reaction, so a DoT tick cannot flinch every frame
    this.skillCd = 0;
    this.burstCd = 0;
    this._castAt = -10;         // last local skill/burst prediction, so a stale snapshot cannot undo it
    this.energy = 0;
    this.energyMax = this.def.burst?.cost ?? 60;
    this.rooted = 0;            // seconds during which movement is locked
    this.speedBonus = 0;        // 疾影-style 移动速度 buffs, kept in sync by `game._syncSpeedBonus`

    this.hp = 1; this.maxHp = 1; this.shield = 0; this.shieldElement = null;
    this.aura = null;                // 元素附着, from the snapshot's `au` (see applyServer)
    this.cold = 0;

    this._t = 0;
    this._spinUntil = -1;        // while a claymore spin is draining, stamina must not regen
    this._wasGrounded = true;
    this._corrLerp = null;
    this.events = new Map();    // local event bus for the HUD
  }

  on(type, fn) {
    if (!this.events.has(type)) this.events.set(type, new Set());
    this.events.get(type).add(fn);
  }

  emit(type, d) {
    const s = this.events.get(type);
    if (s) for (const fn of s) fn(d);
  }

  /* ------------------------------------------------------------ character -- */

  setCharacter(charId, weaponId) {
    this.charId = charId;
    this.def = CHARACTERS[charId] || CHARACTERS.lyra;
    this.actor.setCharacter(charId, weaponId);
    this.energyMax = this.def.burst?.cost ?? 60;
    this.combo = 0;
    // Cooldowns are per character in the simulation, and this character's own are whatever the
    // next snapshot's `cds` says — usually zero, which is the point: 附着 then switch then 触发 is
    // the elemental-reaction rotation, and it needs the incoming character's skill to be ready.
    // Cleared here rather than waited for so the press in the same second as the switch works;
    // the snapshot corrects it either way (`applyServer`).
    this.skillCd = 0;
    this.burstCd = 0;
    this._castAt = -10;
    this.emit('character', { charId });
  }

  /** The weapon's own length, metres — how far the *model* reaches, for the swing arc. */
  get weaponReach() {
    return WEAPON_TYPES[this.def.weapon]?.reach ?? WEAPON_TYPES.sword.reach;
  }

  /**
   * How far this character's normal attack actually lands, metres.
   *
   * `playerAttackShape('normal', def).hit` — i.e. the boundary `handleAttack` sweeps, slack
   * included — so closing to it is closing to where the hit happens. A bow or a catalyst has no
   * shape, and for those it is the weapon's authored range (34 m / 12 m), which until this getter
   * existed nothing read: the auto-attack acquired at a hardcoded 26 m for both.
   */
  get attackReach() {
    return playerAttackShape('normal', this.def)?.hit ?? this.weaponReach;
  }

  get isRanged() {
    return this.def.weapon === 'bow' || this.def.weapon === 'catalyst';
  }

  get height() { return this.actor.height; }

  /* ------------------------------------------------------------- placement -- */

  teleportTo(x, y, z, ry = this.ry) {
    this.x = x; this.z = z;
    this.y = Math.max(y, this.world.heightAt(x, z));
    this.ry = ry;
    this.vy = 0;
    this.goal = null;
    this.target = null;
    this._corrLerp = null;
    this.actor.setPose(this.x, this.y, this.z, this.ry);
  }

  /** Server said we are somewhere else. Blend rather than snap when it is close. */
  correct(x, y, z) {
    const d = Math.hypot(x - this.x, z - this.z);
    if (d > 8) {
      this.teleportTo(x, y, z);
      this.vfx.teleport(x, y, z, false);
    } else {
      // Smooth over ~0.25 s; a hard snap on a routine correction reads as lag
      // even when the correction is only tens of centimetres.
      this._corrLerp = { x, y, z, t: 0.25 };
    }
  }

  /* --------------------------------------------------------------- targets -- */

  setGoal(x, z, kind = 'move', payload = null, { sprint = false } = {}) {
    this.goal = { x, z };
    this.goalKind = kind;
    this.goalPayload = payload;
    this.goalSprint = !!sprint;
  }

  clearGoal() {
    this.goal = null;
    this.goalKind = null;
    this.goalPayload = null;
    this.goalSprint = false;
  }

  setTarget(id) {
    this.target = id;
    this.emit('target', { id });
  }

  /**
   * Sit down / stand up. Refused in every state where the pose would be a lie (airborne, in
   * water, gliding, dead), and dropped again by the first movement input — the same rule a
   * click order follows, because a player who presses W expects to walk, not to be told no.
   */
  setSitting(v) {
    const want = !!v && this.alive && this.grounded && !this.swimming && !this.gliding;
    if (want === this.sitting) return this.sitting;
    this.sitting = want;
    if (want) { this.clearGoal(); this.speed = 0; }
    this.emit('sitting', { on: this.sitting });
    return this.sitting;
  }

  /**
   * Play the hit reaction. Rate-limited to the clip's own length, because a burning DoT ticks
   * four times a second and a flinch restarted every tick is a character vibrating in place;
   * and never on top of a cast — in this game a skill or a burst is committed once it starts,
   * so interrupting the animation would promise an interrupt the combat rules do not give.
   */
  flinch(t = this._t) {
    if (!this.alive) return false;
    if (t - this._flinchAt < FLINCH_GAP) return false;
    const an = this.actor?.animator;
    if (!an) return false;
    if (an.busy && UNINTERRUPTIBLE.has(an.currentAction)) return false;
    this._flinchAt = t;
    this.sitting = false;
    return an.play('hit');
  }

  /* ------------------------------------------------------------- raycasting -- */

  /**
   * Ray-march a screen ray against the terrain height field.
   *
   * Analytic rather than a mesh raycast on purpose: terrain chunks stream in and
   * out, so a mesh raycast fails on ground the player can plainly see but which
   * has not been built yet, and it also misses the LOD seams. Marching heightAt
   * always agrees with the collision the character actually uses.
   */
  raycastGround(raycaster, maxDist = 300) {
    const o = raycaster.ray.origin, d = raycaster.ray.direction;
    // Coarse march, then bisect the crossing interval. 1.5 m steps with 12
    // bisections lands within a couple of centimetres at any practical range.
    let prevT = 0;
    let prevAbove = o.y - this.world.heightAt(o.x, o.z);
    const step = 1.2;
    for (let t = step; t < maxDist; t += Math.min(6, step * (1 + t * 0.05))) {
      const px = o.x + d.x * t, py = o.y + d.y * t, pz = o.z + d.z * t;
      const above = py - this.world.heightAt(px, pz);
      if (above <= 0 && prevAbove > 0) {
        let lo = prevT, hi = t;
        for (let i = 0; i < 14; i++) {
          const m = (lo + hi) * 0.5;
          const mx = o.x + d.x * m, my = o.y + d.y * m, mz = o.z + d.z * m;
          if (my - this.world.heightAt(mx, mz) > 0) lo = m; else hi = m;
        }
        const ft = (lo + hi) * 0.5;
        return {
          x: o.x + d.x * ft,
          y: this.world.heightAt(o.x + d.x * ft, o.z + d.z * ft),
          z: o.z + d.z * ft,
          dist: ft,
        };
      }
      prevT = t;
      prevAbove = above;
    }
    return null;
  }

  /* ---------------------------------------------------------------- combat -- */

  /** Direction the attack should go: locked target, else facing. */
  attackDir(actors) {
    if (this.target) {
      const e = actors.enemyById(this.target);
      if (e && e.alive) {
        V.set(e.x - this.x, (e.y + e.actor.height * 0.5) - (this.y + 1.2), e.z - this.z);
        if (V.lengthSq() > 1e-6) return V.normalize();
      }
    }
    return V.set(Math.sin(this.ry), 0, Math.cos(this.ry));
  }

  canAttack() {
    // Hands are on the wall. Swinging from a climb would also hand the animator a one-shot
    // overlay, which turns `auto` off and freezes the climb cycle mid-reach.
    return this.alive && this.attackCooldown <= 0 && this.rooted <= 0 && !this.climbing;
  }

  /** Normal attack. Advances the local combo counter for animation variety. */
  attack(actors) {
    if (!this.canAttack()) return false;
    this.setSitting(false);
    const hits = this.def.normal.hits.length;
    if (this._t - this.lastAttackAt > COMBO_WINDOW) this.combo = 0;
    else this.combo = (this.combo + 1) % hits;
    this.lastAttackAt = this._t;
    const interval = this.def.normal.frameTime;
    this.attackCooldown = interval * 0.9;

    const dir = this.attackDir(actors).clone();
    this.faceDirection(dir.x, dir.z, 0.7);
    // Animator clips are attack1..attack5; the combo can run to 6 hits on some
    // characters, so wrap into the available clips.
    const clip = `attack${(this.combo % 5) + 1}`;
    this.actor.animator.play(clip);
    this.socket.attack([dir.x, dir.y, dir.z], false);
    this._swingVfx(dir, false);
    this.emit('swing', { charged: false, ranged: this.isRanged });
    // Melee attacks step into the swing, which is most of what makes a combo feel
    // connected rather than played on the spot.
    if (!this.isRanged && this.grounded) {
      this._lunge = { x: dir.x, z: dir.z, t: 0.16, speed: 3.4 };
    }
    return true;
  }

  /**
   * How long the button has to be held before the swing becomes a charged one.
   *
   * A bow's aimed shot is a *draw*, not a flick: 凯伦 asks for 1.1 s and 泽菲拉 for 0.9,
   * and that difference is the whole feel of the weapon class. It was authored as
   * `charged.chargeTime` and read by nothing, so every character charged in 0.32 s.
   */
  get chargeTime() { return this.def.charged?.chargeTime ?? CHARGE_TIME; }

  /**
   * 大剑蓄力是持续旋斩: this weapon's charged attack is *held*, not released.
   *
   * A non-zero `charged.spinDrain` is the whole statement: a cost *per second* only means
   * anything for an attack that lasts. It was authored on the two claymores and read
   * nowhere, so their charge behaved exactly like a sword's single swing.
   */
  get heldSpin() { return this.spinDrain > 0; }

  /** Stamina per second while the spin is held. */
  get spinDrain() { return this.def.charged?.spinDrain ?? 0; }

  /**
   * Charged attack (held left button / released bow shot).
   *
   * `spin` is the claymore's held spin: the flat stamina cost is skipped because
   * `drainSpin` is already charging per second, and the swings come faster so the spin
   * reads as one continuous attack instead of a stutter of separate ones.
   */
  chargedAttack(actors, { spin = false } = {}) {
    if (!this.canAttack()) return false;
    this.setSitting(false);
    const cost = spin ? 0 : (this.def.charged?.stamina ?? 20);
    if (this.stamina < cost) {
      this.emit('nostamina');
      return false;
    }
    this.stamina -= cost;
    this.attackCooldown = spin ? 0.34 : 0.6;
    this.combo = 0;
    const dir = this.attackDir(actors).clone();
    this.faceDirection(dir.x, dir.z, 0.9);
    // 长柄武器的重击是突刺 — `attack3` is the lunging thrust clip, and `charged.thrust`
    // is the character data that says this weapon uses it.
    this.actor.animator.play(this.def.charged?.thrust ? 'attack3' : 'charged');
    this.socket.attack([dir.x, dir.y, dir.z], true);
    this._swingVfx(dir, true);
    this.emit('swing', { charged: true, ranged: this.isRanged, spin });
    return true;
  }

  /**
   * Pay for one frame of a held spin. Returns false when the stamina runs out, which is
   * the signal to end the spin — a spin that costs nothing is an infinite attack.
   */
  drainSpin(dt) {
    const rate = this.spinDrain;
    if (!rate) return false;
    if (this.stamina <= 0) { this.emit('nostamina'); return false; }
    this.stamina = Math.max(0, this.stamina - rate * dt);
    this._spinUntil = this._t + 0.15;   // blocks regen, or the drain fights it
    return this.stamina > 0;
  }

  useSkill(actors) {
    if (!this.alive || this.rooted > 0 || this.climbing) return false;
    this.setSitting(false);
    if (this.skillCd > 0) { this.emit('cooldown', { which: 'skill', left: this.skillCd }); return false; }
    const skill = this.def.skill;
    const dir = this.attackDir(actors).clone();
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(Math.sin(this.ry), 0, Math.cos(this.ry));
    dir.normalize();
    this.faceDirection(dir.x, dir.z, 1);
    this.actor.animator.play('skill');
    this.actor.pulseAura(0.8, 1.0);
    this.socket.skill([dir.x, 0, dir.z]);
    // Predict the cooldown so the HUD ring starts immediately; the server's value — this
    // character's own, `cdReduction` included — arrives in the next snapshot's `cds` and
    // overrides it. `_castAt` keeps the packets already in flight from undoing the prediction.
    this.skillCd = skill.cd;
    this._castAt = this._t;
    // Move first, draw second. A dash or a blink repositions the caster *before* the skill
    // resolves — the sim damages the ground it ends on — so drawing here left lyra's sigil up to
    // 7.5 m behind her own damage. A dash skill also has to move us locally at all, or the
    // character stands still for a whole round trip while the VFX plays somewhere else.
    if (skill.dash) this._dashTo(dir, skill.dash);
    else if (skill.teleport) this._blinkTo(actors, skill.teleport);
    const sh = playerAttackShape('skill', this.def);
    if (sh) {
      this.vfx.strike(sh, this.x, this.z, Math.atan2(dir.x, dir.z), elementColor(skill.element),
        0.5, (x, z) => this.world.heightAt(x, z), 0.95);
    }
    this.vfx.cast(this.x, this.y, this.z, skill.element, sh?.radius ?? SKILL_RADIUS);
    this.rooted = 0.28;
    this.emit('skillCast', { charId: this.charId, element: skill.element });
    return true;
  }

  useBurst(actors) {
    if (!this.alive || this.climbing) return false;
    this.setSitting(false);
    if (this.burstCd > 0) { this.emit('cooldown', { which: 'burst', left: this.burstCd }); return false; }
    if (this.energy < this.energyMax) { this.emit('noenergy'); return false; }
    const burst = this.def.burst;
    const dir = this.attackDir(actors).clone();
    dir.y = 0;
    if (dir.lengthSq() > 1e-6) { dir.normalize(); this.faceDirection(dir.x, dir.z, 1); }
    this.actor.animator.play('burst');
    this.actor.pulseAura(1.6, 2.0);
    this.socket.burst([dir.x, 0, dir.z]);
    this.burstCd = burst.cd;
    this._castAt = this._t;
    this.energy = 0;
    const sh = playerAttackShape('burst', this.def);
    if (sh) {
      this.vfx.strike(sh, this.x, this.z, this.ry, elementColor(burst.element), 0.75,
        (x, z) => this.world.heightAt(x, z));
    }
    this.vfx.burst(this.x, this.y, this.z, burst.element, sh?.radius);
    this.rooted = 0.85;
    this.emit('burstCast', { charId: this.charId, element: burst.element });
    return true;
  }

  dash() {
    if (!this.alive || this.rooted > 0 || this.swimming || this.climbing) return false;
    this.setSitting(false);
    const cost = STAMINA.dash * (this.def.passive?.staminaMul ?? 1);
    if (this.stamina < cost) { this.emit('nostamina'); return false; }
    this.stamina -= cost;
    const dir = V2.set(Math.sin(this.ry), 0, Math.cos(this.ry));
    this._dashTo(dir, 5.2);
    this.actor.animator.play('dash');
    this.vfx.dust(this.x, this.y, this.z, this.world.groundColor(this.x, this.z), 1.4);
    this.emit('dash');
    return true;
  }

  /**
   * Blink behind the nearest enemy in range, by the sim's own rule (`blinkDestination`).
   *
   * The server applies that rule to its copy of the character and broadcasts the new position;
   * with nothing running it locally, the player's own view stayed where it was and the reposition
   * arrived a round trip later as a correction. So nyx's blink — and the `backstab` bonus that
   * depends on ending up behind the target — happened somewhere the player could not see.
   */
  _blinkTo(actors, range) {
    const dest = blinkDestination(this.x, this.z, range, actors.enemies.values(),
      (x, z) => this.world.slopeAt(x, z));
    if (!dest) return;
    this.x = dest.x; this.z = dest.z;
    this.y = Math.max(this.y, this.world.heightAt(dest.x, dest.z));
    this.faceDirection(dest.target.x - this.x, dest.target.z - this.z, 1);
  }

  _dashTo(dir, distance) {
    // Step along in a few increments and stop at the first blocked sample, so a
    // dash cannot punch through a cliff face.
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const nx = this.x + dir.x * (distance / steps);
      const nz = this.z + dir.z * (distance / steps);
      if (this.world.slopeAt(nx, nz) > 0.78) break;
      this.x = nx; this.z = nz;
    }
    this.y = Math.max(this.y, this.world.heightAt(this.x, this.z));
  }

  _swingVfx(dir, charged) {
    const el = charged
      ? (this.def.charged?.element ?? 'physical')
      : (this.def.normal?.element ?? 'physical');
    // A colour, not the element's *name*. Both calls below take a hex, and
    // `THREE.Color.set('water')` is not a colour — so an infused or elemental swing was drawn in
    // whatever colour the pooled mesh happened to be carrying from its last use.
    const col = el === 'physical' ? 0xfff0d0 : elementColor(el);
    if (this.isRanged) {
      this.vfx.coneSparks(
        this.x + dir.x * 0.6, this.y + 1.3, this.z + dir.z * 0.6,
        dir.x, dir.y, dir.z, col, charged ? 16 : 8, 9, 0.22,
      );
      return;
    }
    // The ground the sweep is about to test, drawn where it is tested: `sh` is the same object
    // `handleAttack` measures against, so a player who watches their feet learns their own reach.
    // Dim (a combo draws this five times) and gone in a fifth of a second.
    const sh = playerAttackShape(charged ? 'charged' : 'normal', this.def);
    if (sh) {
      this.vfx.strike(sh, this.x, this.z, Math.atan2(dir.x, dir.z), col, 0.2,
        (x, z) => this.world.heightAt(x, z), 0.5);
    }
    // Alternate the swing plane per combo step so a five-hit chain does not draw
    // the same arc five times.
    const roll = (this.combo % 3) * 0.7 - 0.7;
    const reach = sh ? sh.hit : this.attackReach;
    this.vfx.slash(
      this.x + dir.x * reach * 0.45, this.y + 1.05, this.z + dir.z * reach * 0.45,
      dir.x, dir.z, col,
      reach * (charged ? 0.62 : 0.5), charged ? 0 : roll,
      charged ? 0.3 : 0.2,
    );
  }

  /* -------------------------------------------------------------- movement -- */

  faceDirection(dx, dz, blend = 1) {
    if (!dx && !dz) return;
    const want = Math.atan2(dx, dz);
    let d = want - this.ry;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.ry += d * clamp(blend, 0, 1);
  }

  /**
   * Try to move to (nx, nz). Returns true if it happened.
   *
   * When the direct step is blocked by slope, slide along the obstacle instead of
   * stopping dead: without this, click-to-move gets stuck on every boulder and
   * the player has to steer manually, which defeats the point.
   */
  _step(nx, nz) {
    if (this.world.slopeAt(nx, nz) <= MAX_SLOPE) {
      this.x = nx; this.z = nz;
      return true;
    }
    const dx = nx - this.x, dz = nz - this.z;
    // Four candidate slides, rotating the step away from the wall, nearest first.
    for (const a of [0.9, -0.9, 1.5, -1.5]) {
      const c = Math.cos(a), s = Math.sin(a);
      const sx = this.x + (dx * c - dz * s) * 0.8;
      const sz = this.z + (dx * s + dz * c) * 0.8;
      if (this.world.slopeAt(sx, sz) <= MAX_SLOPE) {
        this.x = sx; this.z = sz;
        return true;
      }
    }
    return false;
  }

  /* ----------------------------------------------------------------- frame -- */

  update(dt, t, input, camRig, actors) {
    this._t = t;
    const wl = this.world.waterLevel;

    if (this.rooted > 0) this.rooted -= dt;
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.skillCd > 0) this.skillCd = Math.max(0, this.skillCd - dt);
    if (this.burstCd > 0) this.burstCd = Math.max(0, this.burstCd - dt);
    if (this.staminaBlocked > 0) this.staminaBlocked -= dt;

    // --- pending correction ------------------------------------------------
    if (this._corrLerp) {
      const c = this._corrLerp;
      const k = Math.min(1, dt / Math.max(dt, c.t));
      this.x = lerp(this.x, c.x, k);
      this.y = lerp(this.y, c.y, k);
      this.z = lerp(this.z, c.z, k);
      c.t -= dt;
      if (c.t <= 0) this._corrLerp = null;
    }

    if (!this.alive) {
      this.speed = 0;
      this.actor.setPose(this.x, this.y, this.z, this.ry);
      this.actor.update(dt, t, { speed: 0, grounded: true, auto: false });
      return;
    }

    // --- intent -----------------------------------------------------------
    const axis = input.moveAxis();
    const keyboardMoving = axis.len > 0.01;
    // Any keyboard input cancels a click order: the player has taken over.
    if (keyboardMoving && this.goal) this.clearGoal();
    // …and it stands us up. Anything that produces movement intent — a key, a click order, a
    // jump — ends the sit, so there is no way to end up walking around in a sitting pose.
    if (this.sitting && (keyboardMoving || this.goal || input.isDown('jump'))) this.setSitting(false);

    // Chasing a live target: refresh the goal before steering, or we always aim a
    // frame behind and never quite close the distance on a fleeing enemy.
    if (this.goalKind === 'approach') {
      const e = this.target ? actors.enemyById(this.target) : null;
      if (e && e.alive) this.goal = { x: e.x, z: e.z };
      else this.clearGoal();
    }

    let wishX = 0, wishZ = 0, wish = 0;
    if (keyboardMoving) {
      const b = camRig.basis();
      wishX = b.fx * axis.y + b.rx * axis.x;
      wishZ = b.fz * axis.y + b.rz * axis.x;
      const l = Math.hypot(wishX, wishZ) || 1;
      wishX /= l; wishZ /= l;
      wish = axis.len;
    } else if (this.goal) {
      const dx = this.goal.x - this.x, dz = this.goal.z - this.z;
      const d = Math.hypot(dx, dz);
      // 'approach' stops at weapon range, 'move' at the marker, 'interact' at the
      // interactable's own radius.
      let stopAt = ARRIVE;
      // Stop inside the reach that will actually connect, not inside the weapon's own length.
      if (this.goalKind === 'approach') {
        stopAt = Math.max(1.2, (this.goalPayload?.reach ?? this.attackReach) * 0.75);
      }
      else if (this.goalKind === 'interact') stopAt = Math.max(1.4, (this.goalPayload?.radius ?? 2) * 0.6);
      // Inside the range the gateway checks, with room for the body drifting on interpolation.
      else if (this.goalKind === 'rescue') stopAt = REVIVE_RANGE * 0.7;
      if (d <= stopAt) {
        const reached = { kind: this.goalKind, payload: this.goalPayload };
        this.clearGoal();
        this.emit('arrived', reached);
      } else {
        wishX = dx / d; wishZ = dz / d;
        // Ease off over the last couple of metres so the character settles onto
        // the marker instead of skidding past and jittering back.
        wish = clamp(d / 2.4, 0.34, 1);
      }
    }

    // --- state: swimming / climbing / gliding / grounded -------------------
    const gh = this.world.heightAt(this.x, this.z);
    const inWater = wl > -900 && this.y < wl - 0.3;
    this.swimming = inWater;

    const wantJump = input.justPressed('jump');
    const holdJump = input.isDown('jump');

    /*
     * Climbing.
     *
     * Every cliff in these zones is a slope the walk code refuses (`_step` rejects anything over
     * MAX_SLOPE and slides along it instead), so before this existed the terrain's whole vertical
     * dimension was a wall of "no" — and the pieces of climbing were all already in the repo,
     * unused: a `climb` clip, `ACTION.climb` in the wire enum, and `STAMINA.climbDrain`. The
     * animator was even being handed `climbing: false` as a literal, which is what
     * `tools/motion-check.mjs` now refuses to accept.
     *
     * The model is deliberately the heightfield's own: climbing keeps the feet *on the surface*
     * (`y === heightAt`), so it is a slow walk up a face the walk rules would not allow. That is
     * also what keeps the server agreeing without a single new message — `handleInput` clamps y
     * to the terrain and checks horizontal speed, and a climb is slower than a walk.
     *
     * Keyboard only, and on purpose: a click order is a path over the ground, and letting one
     * grab a cliff would strand the player halfway up something they only clicked past.
     */
    const climbProbe = 0.55;
    const aheadX = this.x + wishX * climbProbe, aheadZ = this.z + wishZ * climbProbe;
    const aheadSlope = wish > 0.05 ? this.world.slopeAt(aheadX, aheadZ) : 0;
    const footSlope = this.world.slopeAt(this.x, this.z);
    // A face worth grabbing: too steep to walk, and rising above the feet rather than dropping
    // away (otherwise the lip of a descent would read as a wall).
    const facingWall = keyboardMoving && wish > 0.05 && !this.swimming
      && aheadSlope > MAX_SLOPE && this.world.heightAt(aheadX, aheadZ) > this.y + 0.3;
    if (this.climbing) {
      this._climbSlope = Math.max(footSlope, aheadSlope, 0.5);
      if (this.swimming) {
        // Climbed down into water: the swim state owns the body from here.
        this.climbing = false;
        this.emit('climb', { on: false, reason: 'water' });
      } else if (wantJump && this.stamina > CLIMB_LUNGE_COST) {
        // The controls table promises 「跳跃 / 攀爬时向上」, so jump on a wall is a surge upward,
        // not a release. Reusing the dash lunge means the surge is the same code the ground
        // dash uses — and because climbing sticks to the surface, moving up the face *is* up.
        this.stamina -= CLIMB_LUNGE_COST;
        this._lunge = { x: Math.sin(this.ry), z: Math.cos(this.ry), speed: CLIMB_LUNGE, t: 0.2 };
        this.emit('jump');
      } else if (this.stamina <= 0) {
        // Out of grip. Letting go has to *push off the face*, not just clear the flag: the feet
        // are exactly on the surface, and the landing snap treats standing on a 79° cliff as
        // standing on ground — so clearing the flag alone left the character parked on the wall,
        // unable to move (every lateral step is refused as too steep) and waiting for stamina.
        // A step downhill puts air under them and gravity does the rest.
        const e = 1.2;
        const gx = this.world.heightAt(this.x + e, this.z) - this.world.heightAt(this.x - e, this.z);
        const gz = this.world.heightAt(this.x, this.z + e) - this.world.heightAt(this.x, this.z - e);
        const l = Math.hypot(gx, gz) || 1;
        this.x -= (gx / l) * 0.9;
        this.z -= (gz / l) * 0.9;
        this.climbing = false;
        this.grounded = false;
        this.vy = -1.5;
        this.emit('climb', { on: false, reason: 'stamina' });
      } else if (!facingWall && footSlope <= MAX_SLOPE) {
        // Topped out, or slid back down to ground we can stand on.
        this.climbing = false;
        this.grounded = true;
        this.vy = 0;
        this.emit('climb', { on: false, reason: 'ground' });
      }
    } else if (facingWall && this.stamina > 0 && this.staminaBlocked <= 0 && this.rooted <= 0
      && !this.gliding && (this.grounded || this.vy <= 0.5)) {
      this.climbing = true;
      this.gliding = false;
      this.grounded = false;
      this.vy = 0;
      this._climbSlope = Math.max(footSlope, aheadSlope, 0.5);
      this.clearGoal();
      this.emit('climb', { on: true });
    }

    if (this.swimming) {
      this.gliding = false;
      this.vy = lerp(this.vy, 0, 1 - Math.exp(-6 * dt));
      // Bob at the surface.
      this.y = lerp(this.y, wl - 0.35, 1 - Math.exp(-8 * dt));
      if (wish > 0) this.stamina -= STAMINA.swimDrain * dt;
    } else if (this.climbing) {
      // Hanging still costs nothing; hauling yourself up does. Genshin's rule, and it is the one
      // that lets a player stop and look around halfway up a cliff.
      this.gliding = false;
      this.vy = 0;
      if (wish > 0) this.stamina -= STAMINA.climbDrain * dt;
    } else if (this.grounded) {
      this.gliding = false;
      if (wantJump && this.rooted <= 0) {
        this.vy = JUMP_V;
        this.grounded = false;
        this.actor.animator.play('jump');
        this.vfx.dust(this.x, this.y, this.z, this.world.groundColor(this.x, this.z), 0.7);
        this.emit('jump');
      }
    } else {
      // Airborne. Holding jump while descending opens the glider.
      if (holdJump && this.vy < -1.5 && this.y - gh > 2.5 && this.stamina > 1) {
        if (!this.gliding) {
          this.gliding = true;
          this.actor.animator.play('glide');
        }
      } else if (!holdJump) {
        this.gliding = false;
      }
      if (this.gliding) {
        this.stamina -= STAMINA.glideDrain * dt;
        if (this.stamina <= 0) this.gliding = false;
      }
    }

    // --- horizontal speed --------------------------------------------------
    // The one definition of "sprinting": Shift, or a walk order that was double-clicked. Both
    // consumers below (the speed cap and the stamina regen block) read this and nothing else,
    // so a mouse sprint is the same sprint — same drain, same lockout, same broadcast pose.
    const sprintHeld = input.isDown('sprint') || (this.goalSprint && !!this.goal);
    let maxSpeed;
    if (this.swimming) {
      maxSpeed = SWIM;
    } else if (this.climbing) {
      // Speed along the face, projected onto the ground: see `CLIMB`. Floored so a dead-vertical
      // wall still moves rather than pinning the character in place at 0 m/s.
      maxSpeed = CLIMB * Math.max(0.1, 1 - this._climbSlope);
    } else if (this.gliding) {
      maxSpeed = GLIDE_FORWARD;
    } else {
      const sprinting = sprintHeld && wish > 0.4 && this.staminaBlocked <= 0
        && this.stamina > 0 && this.grounded;
      if (sprinting) {
        this.stamina -= STAMINA.sprintDrain * (this.def.passive?.staminaMul ?? 1) * dt;
        maxSpeed = SPRINT;
      } else {
        maxSpeed = sprintHeld ? RUN : (wish < 0.55 ? WALK + (RUN - WALK) * wish / 0.55 : RUN);
      }
    }
    // Gear/talent move-speed buffs. Gliding is excluded: its forward speed is set by the
    // wing's aerodynamics, not by how fast the character can run.
    if (this.speedBonus && !this.gliding) maxSpeed *= 1 + this.speedBonus;
    // Attacks and casts plant the feet.
    if (this.rooted > 0) maxSpeed *= 0.12;

    const targetSpeed = wish > 0 ? maxSpeed * wish : 0;
    // Accelerate fast, decelerate a touch slower — the small overshoot on stop is
    // what makes the character feel like it has mass.
    const accel = targetSpeed > this.speed ? 26 : 18;
    this.speed = this.speed + clamp(targetSpeed - this.speed, -accel * dt, accel * dt);

    if (wish > 0) {
      // In the air the character keeps its heading; on the ground it turns.
      this.faceDirection(wishX, wishZ, 1 - Math.exp(-TURN_RATE * dt));
    }

    if (this._lunge) {
      this._lunge.t -= dt;
      if (this._lunge.t <= 0) this._lunge = null;
    }

    // --- integrate --------------------------------------------------------
    let mvx = 0, mvz = 0;
    if (this.speed > 0.01) {
      // Airborne keeps its heading; on the ground — and on a wall — the step follows the input, so
      // A/D traverse the face immediately instead of waiting for the body to finish turning.
      const freeFlight = this.gliding || (!this.grounded && !this.climbing);
      const dirX = freeFlight ? Math.sin(this.ry) : wishX;
      const dirZ = freeFlight ? Math.cos(this.ry) : wishZ;
      mvx += dirX * this.speed * dt;
      mvz += dirZ * this.speed * dt;
    }
    if (this._lunge) {
      mvx += this._lunge.x * this._lunge.speed * dt;
      mvz += this._lunge.z * this._lunge.speed * dt;
    }
    if (mvx || mvz) {
      // `_step` exists to refuse steep ground; on a wall that refusal is the thing being
      // overridden, so climbing moves straight and lets the surface decide the height.
      if (this.climbing) { this.x += mvx; this.z += mvz; }
      else if (!this._step(this.x + mvx, this.z + mvz)) this.speed *= 0.4;
    }

    // Vertical
    if (this.climbing) {
      // Stuck to the face. On a heightfield the surface *is* the wall, so there is no separate
      // vertical integration to keep in sync with the horizontal one — and the landing block
      // below has to be skipped entirely, because standing exactly on the surface is precisely
      // what it reads as touching down (it would fire a landing thud every frame of the climb).
      this.y = this.world.heightAt(this.x, this.z);
      this.vy = 0;
    } else if (!this.swimming) {
      if (this.gliding) {
        this.vy = lerp(this.vy, GLIDE_FALL, 1 - Math.exp(-5 * dt));
      } else if (!this.grounded) {
        this.vy += GRAVITY * dt;
      }
      this.y += this.vy * dt;
      const g2 = this.world.heightAt(this.x, this.z);
      // Sticking to the surface and landing on it are the *same* event, and they used to
      // be two branches: below the ground meant a landing (thud, dust, shake), while
      // inside the 35 cm step tolerance meant "small bump, snap down quietly". But `dt`
      // is clamped to 0.05 s and a fall reaches 8.4 m/s, so a descending frame covers
      // 0.42 m — the frame that ends inside a 0.35 m band is, four times out of five,
      // the frame the fall ended. Landing feedback therefore fired on roughly one jump
      // in five, which is invisible in code review and reads as "the jump feels floaty".
      const snapping = this.y <= g2 + 0.35 && (this.grounded || this.vy <= 0);
      if (this.y <= g2 || snapping) {
        const landingSpeed = -this.vy;
        this.y = g2;
        this.vy = 0;
        if (!this.grounded) {
          this.grounded = true;
          this.gliding = false;
          // Stepping over a bump arrives here with almost no downward speed, so the
          // thresholds are what separate a landing from a stride, not the branch.
          if (landingSpeed > 3.5) this.emit('land', { speed: landingSpeed });
          if (landingSpeed > 9) {
            this.vfx.dust(this.x, this.y, this.z, this.world.groundColor(this.x, this.z),
              Math.min(2.2, landingSpeed / 8));
            camRig.addShake(Math.min(0.5, landingSpeed / 40));
            if (landingSpeed > 18) this.actor.animator.play('plunge');
          }
        }
      } else if (this.grounded) {
        // Walked off a ledge.
        this.grounded = false;
        this.vy = Math.min(this.vy, 0);
      }
    }

    // --- stamina ----------------------------------------------------------
    const regenBlocked = (sprintHeld && this.speed > RUN * 0.9) || this.gliding
      || (this.swimming && wish > 0) || (this.climbing && wish > 0) || this._spinUntil > this._t;
    if (!regenBlocked) {
      this.stamina = Math.min(STAMINA.max, this.stamina + STAMINA.regen * dt);
    }
    if (this.stamina <= 0) {
      this.stamina = 0;
      // A mouse sprint ends when the bar does, rather than staying armed for the rest of the
      // order: a Shift player lets go, and `sprintHeld` would otherwise hold `regenBlocked`
      // true at RUN speed (RUN > RUN × 0.9) and the bar would never refill on the walk home.
      this.goalSprint = false;
      if (this.staminaBlocked <= 0) {
        this.staminaBlocked = 1.2;
        this.emit('nostamina');
      }
      if (this.swimming) {
        // Out of stamina in deep water: the server will drown us; surface first.
        this.y = wl - 0.2;
      }
    }

    if (this.swimming && this.speed > 0.5 && Math.random() < dt * 6) {
      this.vfx.splash(this.x, wl, this.z, 0.5);
    }

    // --- animation --------------------------------------------------------
    this.actor.setPose(this.x, this.y, this.z, this.ry);
    this.actor.update(dt, t, {
      speed: this.speed,
      grounded: this.grounded && !this.swimming,
      swimming: this.swimming,
      gliding: this.gliding,
      climbing: this.climbing,
      sitting: this.sitting,
      // The draw stance is a bow pose. A sword character in aim mode gets the camera change
      // and nothing else, because holding an invisible bow is worse than holding nothing.
      aiming: this.aiming && this.isRanged,
      auto: !this.actor.animator.busy,
    });

    // --- footsteps --------------------------------------------------------
    // The cue comes from the gait itself, after the animator has advanced: a dust puff per
    // foot that actually lands, on the frame it lands. The old version accumulated distance
    // against a hand-written 1.5 m / 2.1 m "stride" — a fourth copy of a number the legs
    // already imply, one that fired once per *cycle* while two feet were hitting the ground.
    const steps = this.grounded && this.speed > 1.2 ? this.actor.animator?.takeSteps() : null;
    if (steps?.n) {
      this.vfx.dust(this.x, this.y, this.z, this.world.groundColor(this.x, this.z), 0.45);
      this.emit('footstep', { speed: this.speed, side: steps.side });
    }
    this._wasGrounded = this.grounded;
  }

  /* ------------------------------------------------------------ networking -- */

  /** The ACTION enum value that best describes the current state. */
  currentAction() {
    if (!this.alive) return ACTION.down;
    // A one-shot clip in flight is what remote clients should see; Animator clip
    // names and the ACTION enum share their vocabulary deliberately.
    const anim = this.actor.animator;
    if (anim?.busy) {
      const v = ACTION[anim.currentAction];
      if (v != null) return v;
    }
    // `climbing` outranks the airborne test for the same reason it does in `autoLocomotion`: a
    // climber is not grounded, so without this line every other player would see them falling
    // up the cliff.
    if (this.climbing) return ACTION.climb;
    if (this.swimming) return ACTION.swim;
    if (this.gliding) return ACTION.glide;
    if (!this.grounded) return this.vy > 0 ? ACTION.jump : ACTION.fall;
    // Same order as `Animator.autoLocomotion`, and for the same reason: what the other players
    // see has to be what this client is drawing, or a sitting character walks on their screen.
    if (this.sitting) return ACTION.sit;
    if (this.aiming && this.isRanged && this.speed < 0.25) return ACTION.aim;
    if (this.speed > SPRINT * 0.85) return ACTION.sprint;
    if (this.speed > RUN * 0.7) return ACTION.run;
    if (this.speed > 0.3) return ACTION.walk;
    return ACTION.idle;
  }

  netSnapshot() {
    return {
      x: Math.round(this.x * 100) / 100,
      y: Math.round(this.y * 100) / 100,
      z: Math.round(this.z * 100) / 100,
      ry: Math.round(this.ry * 100) / 100,
      a: this.currentAction(),
      st: Math.round(this.stamina),
    };
  }

  /** Apply authoritative values from a snapshot. */
  applyServer(you, snap) {
    if (!you) return;
    const wasAlive = this.alive;
    const shieldBefore = this.shield;
    this.hp = you.hp;
    this.maxHp = you.mhp;
    this.shield = you.sh || 0;
    this.shieldElement = you.she || null;
    // A shield that grew is a shield that was just granted — the only other way this number moves
    // is down. Detected here rather than at the four grant sites because two of them are in
    // shared/ (skill, 结晶) and one fires for the whole party: the snapshot is where all of them
    // become visible to the client, 单机 included.
    if (this.shield > shieldBefore + 1) this.emit('shield', { element: this.shieldElement });
    // 元素附着 on me. `au` is in every snapshot (`Player.serialize`) and was read by nobody:
    // the enemy path has always fed it to `setElementAura`, so a wet slime glows and carries a
    // pip, while the traveller it just soaked looked exactly like a dry one — no glow, no HUD,
    // nothing to tell you that the next 雷 orb is a 感电 rather than a bruise. Two consumers
    // from here: the 3D shell on the model, and the party card's pip through `hudState()`.
    const auraBefore = this.aura;
    this.aura = you.au || null;
    this.actor?.setElementAura(this.aura, false);
    if (this.aura !== auraBefore) this.emit('aura', { element: this.aura, was: auraBefore });
    this.alive = you.al !== 0;
    if (wasAlive && !this.alive) {
      this.sitting = false;      // `down` is also a base clip; two of them cannot both be it
      this.actor.animator.play('down');
      this.emit('down');
    } else if (!wasAlive && this.alive) {
      this.emit('revived');
    }
    if (snap) {
      if (snap.energy && snap.energy[this.charId] != null) this.energy = snap.energy[this.charId];
      // 冷却, from the simulation that actually refuses the cast. A missing key is a ready skill
      // (`Player.cooldownMap` leaves those out), so this also *clears* a local prediction the
      // server never charged us for — which is the fix: the prediction below is one number for
      // the whole party, and a switch used to carry it to the incoming character.
      //
      // A cast within the last round trip is exempt: the snapshot in flight was built before the
      // press reached the sim, and taking its `0` would re-arm a skill the next packet charges,
      // letting the HUD flicker ready and the player press into an `on_cooldown` refusal.
      if (snap.cds) {
        const fresh = this._t - this._castAt < 0.6;
        const skill = snap.cds[`${this.charId}:skill`] || 0;
        const burst = snap.cds[`${this.charId}:burst`] || 0;
        this.skillCd = fresh ? Math.max(this.skillCd, skill) : skill;
        this.burstCd = fresh ? Math.max(this.burstCd, burst) : burst;
      }
      if (typeof snap.stamina === 'number') {
        // Trust the server when it disagrees by a lot (it clamps cheating), but do
        // not fight it over rounding — the client is the one draining it.
        if (Math.abs(snap.stamina - this.stamina) > 40) this.stamina = snap.stamina;
      }
      if (typeof snap.cold === 'number') this.cold = snap.cold;
    }
  }

  dispose() {
    this.actor.dispose();
  }
}
