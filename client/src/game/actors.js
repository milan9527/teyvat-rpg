// Remote actors: other players, enemies and projectiles, driven from the
// server's 10 Hz snapshot stream.
//
// Everything here is *view* code. It never decides where anything is; it decides
// how to draw where the server says things are, which for a 10 Hz stream means:
//
//  * position/rotation are interpolated between the two snapshots bracketing the
//    render time (see Socket.sampleWindow), so motion is smooth at 60 fps;
//  * speed is *derived* from that interpolation rather than sent, because the
//    animator only needs a magnitude and deriving it costs nothing;
//  * yaw is interpolated the short way around, otherwise an actor turning past
//    ±π spins a full circle;
//  * actors are pooled by id and only disposed after they have been missing from
//    several snapshots, so one dropped packet does not delete and rebuild a
//    skinned mesh (which would cost a shader compile and a visible pop).

import * as THREE from 'three';
import { CHARACTERS } from '@teyvat/shared/data/characters.js';
import { ENEMIES } from '@teyvat/shared/data/enemies.js';
import { ELEMENTS } from '@teyvat/shared/data/elements.js';
import { ACTION_NAMES } from '@teyvat/shared/protocol.js';
import { buildHumanoid } from '../gfx/humanoid.js';
import { Animator } from '../gfx/animator.js';
import { attachWeapon } from '../gfx/weapons.js';
import { buildEnemy } from '../gfx/enemies.js';
import { setAura, setHitFlash } from '../gfx/toon.js';
import { elementColor } from './vfx.js';

const MISSING_GRACE = 4;      // snapshots an actor may be absent before disposal
// How brightly a character's *innate* element glows when nothing is attached to them. It is a
// named constant because `setElementAura` has to be able to return to exactly it: an attachment
// that cleared to 0 would leave the model dimmer than the one the enemy sheet was calibrated on.
const REST_AURA = 0.10;
// How far an *attachment* pulls the body toward the element's own colour. The additive glow above
// cannot do this job on a pale model (a soaked traveller read 3/255 bluer than a dry one), so the
// attachment carries a bounded mix as well — see TOON_FRAG's 元素附着 block. Frozen is heavier
// because 冻结 is meant to stop the model reading as itself at all.
//
// 0.45 rather than a round 0.3: measured on 莉拉 soaked in a camp at noon, over the 8-10k body
// pixels a 4.6 m camera gives her, with the damage flash pinned off — a flash frozen at 0.75 is a
// pink body, and it eats the coat whole (0.45 read 2.7 counts instead of 15). The body's mean
// colour moves toward the element's own hue by 3.5-8 counts on the glow alone, 11-26 at wash 0.30
// and 15-34 at 0.45; the spread is how much room the body already has (a dry mean of 133 has some,
// 196 has less). `player-aura-check` prints the sweep it measured, so this number is a row in a
// table rather than a taste.
const AURA_WASH = 0.45;
const AURA_WASH_FROZEN = 0.62;

const EMPTY = [];

/**
 * Which clips mean "the weapon is in the hand", and how long it stays there.
 *
 * `attachWeapon` has always authored two transforms per weapon type — one in the hand, one on
 * the back or hip — and `setSheathed` had **no caller anywhere in the project**, so every
 * character walked, swam, climbed and stood in town with the weapon out. Photographed against
 * black at noon that is not a small thing: a 0.75 m sword hanging off an idle hand reaches the
 * floor (measured 0.01 m *under* the soles for 莉拉, 0.066 m for 伊格纳's claymore, 0.000 for
 * 凯伦's bow) and crosses the skirt, the near thigh, the knee and the boot on its way down.
 *
 * The state is read off the animator rather than from the call that started the action, because
 * there are three doors into an attack (`LocalPlayer` plays the clip itself, `playAction`
 * decodes a remote action byte, and the combo code re-fires) and only the animator sees all
 * three. `aim` is a locomotion clip, so both layers have to be checked.
 */
const DRAWN_CLIPS = new Set([
  'attack1', 'attack2', 'attack3', 'attack4', 'attack5', 'charged', 'skill', 'burst', 'aim', 'plunge',
]);
/** Clips that put it away at once: nobody swims or climbs with a claymore in their fist. */
const STOW_NOW = new Set(['swim', 'climb', 'glide', 'sit', 'down']);
/** Seconds the weapon stays out after the last combat clip. */
const STOW_DELAY = 4.5;

/**
 * A stable per-actor shift of the gait clock, in radians, derived from the enemy id.
 *
 * A camp spawns three hilichurls in the same frame from the same def, so without this they
 * run at the same frequency from the same t and step in lockstep like a chorus line. Derived
 * from the id rather than random so the same creature keeps its footing across a resync.
 */
function gaitOffsetFor(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 1000 * Math.PI * 2;
}

/**
 * The time constant of the derived-speed smoother, in seconds.
 *
 * Both syncs below used to write `speed = speed * 0.7 + inst * 0.3`, which is not a smoothing
 * *rate* but a smoothing *per drawn frame*: it settles with τ = 47 ms at 60 fps and τ = 933 ms at
 * 3 fps, so the same teammate crossing the same ground is drawn in a different clip on a fast
 * machine than on a slow one (measured: `sprint` at 60 fps, `run` at 30/20/12/6, for one ghost
 * running at a steady 6 m/s). This constant is derived from the pair it replaces rather than
 * chosen: with τ = -(1/60)/ln(0.7), `1 - exp(-dt/τ)` is 0.30000000000000004 at dt = 1/60, so a
 * client running at the rate the old blend was authored against behaves as it always did, and
 * every other rate now behaves like that one instead of like its own frame budget.
 */
export const SPEED_TAU = -(1 / 60) / Math.log(0.7);

/** Approach `inst` from `prev` over `SPEED_TAU`, framerate-independently. */
export function smoothSpeed(prev, inst, dt) {
  return prev + (inst - prev) * (1 - Math.exp(-Math.max(0, dt) / SPEED_TAU));
}

/** Shortest-arc angle lerp. */
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/* ------------------------------------------------------------- player actor -- */

/**
 * A humanoid character in the world. Used for remote players and, with
 * `local: true`, for the player's own avatar — sharing the class keeps the two
 * visually identical, which matters because a party is mostly other people's
 * copies of the same eight characters.
 */
export class CharacterActor {
  constructor(charId, scene, opts = {}) {
    this.charId = null;
    this.scene = scene;
    this.local = !!opts.local;
    this.outline = opts.outline !== false;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.rig = null;
    this.animator = null;
    this.weapon = null;
    this.height = 1.7;
    this.aura = null;
    this.hitFlash = 0;
    // Seconds of "weapon out" left. Starts at 0, so a character walks into the world with the
    // weapon stowed and draws it the first time they swing.
    this._drawT = 0;

    this.setCharacter(charId);
  }

  /** Swap the whole model. Rebuilding is correct here: the eight characters have
   *  different skeleton proportions, so there is nothing to reuse. */
  setCharacter(charId, weaponId = null) {
    if (this.charId === charId && (!weaponId || this.weaponId === weaponId)) return;
    const def = CHARACTERS[charId] || CHARACTERS.lyra;
    if (this.charId !== charId) {
      this._disposeModel();
      this.charId = charId;
      this.def = def;
      this.rig = buildHumanoid(def, { outline: this.outline });
      this.group.add(this.rig.group);
      this.animator = new Animator(this.rig);
      this.height = this.rig.height;
      this.weapon = null;
    }
    const wid = weaponId || def.weapon || def.weaponType || 'sword';
    if (this.weaponId !== wid || !this.weapon) {
      this.weapon?.dispose?.();
      this.weaponId = wid;
      // Built into whichever hand or holster the body is using *now*: pressing 2 mid-fight must
      // not put the incoming character's sword away, and switching in town must not draw it.
      this.weapon = attachWeapon(this.rig, wid, { element: def.element, sheathed: this._drawT <= 0 });
    }
    // The element aura is subtle at rest and pushed up during a burst.
    this.baseAuraStrength = REST_AURA;
    setAura(this.rig.group, ELEMENTS[def.element]?.color ?? 0xffffff, this.baseAuraStrength, 0);
    // ...unless something is *attached* to this body right now. A party switch rebuilds the
    // model, and the aura belongs to the player, not to the character standing on the field —
    // 湿身 does not dry off because you pressed 2.
    if (this.aura) this.setElementAura(this.aura, false, true);
  }

  /**
   * 元素附着 on a character, from the snapshot's own `au` field.
   *
   * `EnemyActor` has had this since the reaction table was written — a wet slime glows blue and
   * carries a pip on its plate — while a character had only the innate glow `setCharacter`
   * writes above, so `au` was in every player snapshot and read by **nobody**: a soaked,
   * shocked or frozen traveller was pixel-identical to a dry one. It became visible the day
   * enemy melee stopped dealing physical (`ATTACK_MOVES.basic`), because until then nothing in
   * the open world could attach anything to a player at all.
   *
   * Cleared goes back to the character's *own* element at the resting strength rather than to
   * nothing: the innate glow is part of how the model is authored.
   */
  setElementAura(el, frozen = false, force = false) {
    const want = frozen ? 'ice' : (el || null);
    if (this.aura === want && !force) return;
    this.aura = want;
    if (!this.rig) return;
    this.baseAuraStrength = want ? (frozen ? 0.85 : 0.42) : REST_AURA;
    // The coat is what makes an attachment legible on a body (see TOON_FRAG's 元素附着 block);
    // the resting glow carries none, so a cleared aura goes back to exactly the authored model.
    setAura(this.rig.group, want ? elementColor(want)
      : (ELEMENTS[this.def?.element]?.color ?? 0xffffff), this.baseAuraStrength,
    want ? (frozen ? AURA_WASH_FROZEN : AURA_WASH) : 0);
  }

  _disposeModel() {
    if (!this.rig) return;
    this.weapon?.dispose?.();
    this.group.remove(this.rig.group);
    this.rig.group.traverse((o) => {
      o.geometry?.dispose?.();
      // Materials are per-character instances (buildHumanoid makes fresh ones),
      // so disposing them here is safe and necessary.
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    this.rig = null;
    this.animator = null;
    this.weapon = null;
  }

  setPose(x, y, z, ry) {
    this.group.position.set(x, y, z);
    this.group.rotation.y = ry;
  }

  playAction(action) {
    if (!this.animator) return;
    const name = typeof action === 'number' ? ACTION_NAMES[action] : action;
    if (!name) return;
    this.animator.play(name);
  }

  flash(v = 1) {
    this.hitFlash = v;
    setHitFlash(this.rig.group, v);
  }

  /**
   * Draw the weapon while there is fighting to do, and put it away afterwards.
   *
   * Both layers are read: the melee strings, the skill, the burst and the plunge are one-shot
   * overlays, while a bow's `aim` is a locomotion clip that replaces the base. The timer is a
   * countdown rather than a "last swing at t" so it needs no clock at all — which matters here,
   * because `dt` is clamped and a remote body's animator is stepped from the render loop.
   */
  _driveSheath(dt) {
    if (!this.weapon) return;
    if (DRAWN_CLIPS.has(this.animator.overlay) || DRAWN_CLIPS.has(this.animator.base)) {
      this._drawT = STOW_DELAY;
    } else if (STOW_NOW.has(this.animator.base)) {
      this._drawT = 0;
    } else {
      this._drawT = Math.max(0, this._drawT - Math.max(0, dt));
    }
    this.weapon.setSheathed(this._drawT <= 0);
  }

  /** Boost the aura for the duration of a skill/burst cast. */
  pulseAura(strength = 0.7, seconds = 1.2) {
    this._auraPulse = strength;
    this._auraPulseT = seconds;
  }

  update(dt, t, state) {
    if (!this.animator) return;
    this.animator.update(dt, state);
    this._driveSheath(dt);
    this.weapon?.update(dt, t);
    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt * 5);
      setHitFlash(this.rig.group, this.hitFlash);
    }
    if (this._auraPulseT > 0) {
      this._auraPulseT -= dt;
      const k = Math.max(0, this._auraPulseT);
      setAura(this.rig.group, null, this.baseAuraStrength + this._auraPulse * Math.min(1, k));
      if (this._auraPulseT <= 0) setAura(this.rig.group, null, this.baseAuraStrength);
    }
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    this._disposeModel();
    this.scene.remove(this.group);
  }
}

/* -------------------------------------------------------------- enemy actor -- */

export class EnemyActor {
  constructor(defId, scene) {
    this.defId = defId;
    this.def = ENEMIES[defId] || ENEMIES.hilichurl;
    this.scene = scene;
    this.view = buildEnemy(defId, {});
    this.group = this.view.group;
    this.height = this.view.height;
    scene.add(this.group);

    this.hp = 1;
    this.maxHp = 1;
    this.aura = null;
    this.hitFlash = 0;
    this.dying = 0;
    this._phase = 1;
    this._auraStrength = 0;
  }

  setPose(x, y, z, ry) {
    this.group.position.set(x, y, z);
    this.group.rotation.y = ry;
  }

  flash(v = 1) {
    this.hitFlash = v;
    setHitFlash(this.group, v);
  }

  /** Aura visual: elemental application shows on the body, frozen tints it. */
  setElementAura(el, frozen) {
    const want = frozen ? 'ice' : el;
    if (this.aura === want) return;
    this.aura = want;
    if (!want) {
      this._auraStrength = 0;
      setAura(this.group, 0xffffff, 0, 0);
    } else {
      this._auraStrength = frozen ? 0.85 : 0.42;
      setAura(this.group, elementColor(want), this._auraStrength,
        frozen ? AURA_WASH_FROZEN : AURA_WASH);
    }
  }

  update(dt, t, st) {
    this.view.update(dt, t, st);
    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt * 5);
      setHitFlash(this.group, this.hitFlash);
    }
    if (this.dying > 0) {
      // Sink and shrink out over ~0.6 s. Simply hiding the model on death makes
      // kills feel unresolved; a short dissolve reads as a defeat.
      this.dying = Math.max(0, this.dying - dt / 0.6);
      const u = 1 - this.dying;
      this.group.scale.setScalar(Math.max(0.02, 1 - u * 0.35));
      this.group.position.y -= dt * 1.6;
      if (this.dying <= 0) this.group.visible = false;
    }
  }

  beginDeath() {
    if (this.dying > 0) return;
    this.dying = 1;
  }

  dispose() {
    this.view.dispose?.();
    this.scene.remove(this.group);
  }
}

/* ---------------------------------------------------------------- projectile -- */

class ProjectileView {
  constructor(scene, element, kind) {
    this.element = element;
    const col = elementColor(element);
    // Arrows are a thin shaft, spells are a glowing bolt. Both are additive so
    // they read against dark dungeon walls as well as a bright sky.
    const geo = kind === 'arrow'
      ? new THREE.CylinderGeometry(0.035, 0.02, 0.9, 6).rotateX(Math.PI / 2)
      : new THREE.SphereGeometry(0.22, 10, 8);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    }));
    this.mesh.userData.noOutline = true;
    this.mesh.renderOrder = 11;
    scene.add(this.mesh);
    this.scene = scene;
  }

  setPose(x, y, z, dx, dy, dz) {
    this.mesh.position.set(x, y, z);
    if (dx || dy || dz) this.mesh.lookAt(x + dx, y + dy, z + dz);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.scene.remove(this.mesh);
  }
}

/* -------------------------------------------------------------- actor system -- */

/**
 * Owns every remote actor and reconciles the pool against each snapshot.
 */
export class ActorSystem {
  constructor(scene, socket, vfx) {
    this.scene = scene;
    this.socket = socket;
    this.vfx = vfx;
    this.players = new Map();     // playerId → { actor, prev, next, missing, ... }
    this.enemies = new Map();     // enemyId  → { actor, prev, next, missing, ... }
    this.projectiles = new Map();
    this.localId = null;
    // Boss phase changes seen in the snapshot stream, drained once per frame by Game.
    // A queue rather than a callback because `_syncEnemies` runs inside the interpolation
    // pass, and the reaction (a banner, a sound, a shockwave) belongs to the game loop.
    this.phaseUps = [];
  }

  /** Hand over the phase changes seen since the last call. */
  takePhaseUps() {
    if (!this.phaseUps.length) return EMPTY;
    const out = this.phaseUps;
    this.phaseUps = [];
    return out;
  }

  setLocalId(id) { this.localId = id; }

  /* ------------------------------------------------------------ per frame -- */

  /**
   * Interpolate every actor. `win` is Socket.sampleWindow(); when it is null
   * (before the first two snapshots) actors simply hold their pose.
   */
  update(dt, t, win) {
    if (win) {
      this._syncPlayers(win, dt);
      this._syncEnemies(win, dt);
      this._syncProjectiles(win);
    }

    // `advance` — the ground this body actually covered since the last frame — is handed over and
    // cleared, because it is a quantity per *drawn frame* and not a state: a frame that draws
    // without a snapshot window (before the stream has two snapshots, or after a stall) moves the
    // body nowhere, and legs that kept stepping on the last known advance would skate for free.
    for (const e of this.players.values()) {
      e.actor.update(dt, t, {
        speed: e.speed,
        grounded: e.grounded,
        auto: e.autoLoco,
        advance: e.advance,
      });
      e.advance = 0;
    }
    for (const e of this.enemies.values()) {
      e.actor.update(dt, t, {
        speed: e.speed,
        attack: e.attacking,
        advance: e.advance,
        // `gaitOffset`, never `gait`: the battle phase used to be passed here under the
        // name `phase`, which is also what the pose functions call their gait clock, and
        // an integer in that slot froze the legs of every walker in the game.
        gaitOffset: e.gaitOffset,
        phase2: e.phase >= 2,
      });
      e.advance = 0;
    }
  }

  /* ------------------------------------------------------------- players -- */

  _syncPlayers(win, dt = 1 / 60) {
    const seen = new Set();
    const listB = win.b.data.players || [];
    const byIdA = new Map((win.a.data.players || []).map((p) => [p.id, p]));

    for (const nb of listB) {
      if (nb.id === this.localId) continue;   // own avatar is the local player
      seen.add(nb.id);
      let e = this.players.get(nb.id);
      if (!e) {
        const actor = new CharacterActor(nb.c, this.scene);
        e = {
          actor, x: nb.x, y: nb.y, z: nb.z, ry: nb.ry,
          // `fresh`: the first pair this actor is seen in *seeds* the speed instead of being
          // blended into a zero nobody measured. A teammate who was already running when they
          // streamed in used to be drawn walking, then running, over the smoother's first few
          // frames — an idle-to-run ramp the server never sent.
          speed: 0, fresh: true, advance: 0, grounded: true, autoLoco: true, missing: 0,
          hp: nb.hp, maxHp: nb.mhp, action: nb.a, nickname: nb.n,
          charId: nb.c, aura: nb.au, shield: nb.sh, shieldElement: nb.she, party: nb.pt,
        };
        this.players.set(nb.id, e);
        actor.setPose(nb.x, nb.y, nb.z, nb.ry);
      }
      e.missing = 0;
      if (e.charId !== nb.c) {
        e.charId = nb.c;
        e.actor.setCharacter(nb.c);
      }

      const na = byIdA.get(nb.id) || nb;
      const u = win.u;
      const px = e.x, pz = e.z;
      e.x = na.x + (nb.x - na.x) * u;
      e.y = na.y + (nb.y - na.y) * u;
      e.z = na.z + (nb.z - na.z) * u;
      e.ry = lerpAngle(na.ry, nb.ry, u);
      // The ground this body just covered, in the same place the position it covered it with is
      // written. The legs are driven from *this* rather than from speed×dt, because the two do not
      // agree: the body is interpolated against the wall clock while `dt` is clamped to 50 ms in
      // the game loop, so below 20 fps the body outruns its own stride count and the planted foot
      // skates (measured on this build: 12 % of the ground slid at 60 fps, 31 % at 20, 90 % at 12).
      e.advance = (e.advance || 0) + Math.hypot(e.x - px, e.z - pz);
      // Speed for the locomotion blend, taken from the *snapshot pair* rather
      // than the frame delta: the frame delta is scaled by the interpolation
      // factor and would read as near-zero on the frames where u barely advances.
      const span = Math.max(0.001, (win.b.serverNow - win.a.serverNow) / 1000);
      const inst = Math.hypot(nb.x - na.x, nb.z - na.z) / span;
      e.speed = Math.min(12, e.fresh ? inst : smoothSpeed(e.speed, inst, dt));
      e.fresh = false;

      e.hp = nb.hp; e.maxHp = nb.mhp; e.shield = nb.sh; e.shieldElement = nb.she;
      e.aura = nb.au; e.nickname = nb.n; e.party = nb.pt;
      // ...and on the model, not only on the record. A teammate standing in a hydro slime's
      // camp is a 感电 waiting to happen, and in co-op the person who can see it coming is the
      // electro character next to them — so the attachment has to be readable at a glance on
      // *someone else's* body too, exactly as it is on an enemy's.
      e.actor.setElementAura(nb.au, false);
      e.alive = nb.al !== 0;

      // A non-locomotion action arriving in the snapshot is played once.
      if (nb.a !== e.action) {
        e.action = nb.a;
        const name = ACTION_NAMES[nb.a];
        if (name && !['idle', 'walk', 'run', 'sprint'].includes(name)) {
          e.actor.playAction(nb.a);
          e.autoLoco = false;
        } else {
          e.autoLoco = true;
        }
      }
      if (!e.actor.animator?.busy) e.autoLoco = true;
      e.grounded = !['fall', 'jump', 'glide'].includes(ACTION_NAMES[nb.a]);
      e.actor.setPose(e.x, e.y, e.z, e.ry);
      // Downed teammates stay on screen. Hiding them made the one thing you are supposed to do
      // about a teammate's death — walk over and pick them up — impossible: there was nothing to
      // walk to and nothing to click. `down` is a pose, not a corpse.
      e.actor.setVisible(true);
    }

    // Anything absent for several snapshots is gone for good.
    for (const [id, e] of this.players) {
      if (seen.has(id)) continue;
      if (++e.missing > MISSING_GRACE) {
        e.actor.dispose();
        this.players.delete(id);
      }
    }
  }

  /** Explicit removal from a PLAYER_LEAVE event, ahead of the grace period. */
  removePlayer(id) {
    const e = this.players.get(id);
    if (!e) return;
    e.actor.dispose();
    this.players.delete(id);
  }

  /* ------------------------------------------------------------- enemies -- */

  _syncEnemies(win, dt = 1 / 60) {
    const seen = new Set();
    const listB = win.b.data.enemies || [];
    const byIdA = new Map((win.a.data.enemies || []).map((p) => [p.id, p]));

    for (const nb of listB) {
      seen.add(nb.id);
      let e = this.enemies.get(nb.id);
      if (!e) {
        const actor = new EnemyActor(nb.t, this.scene);
        e = {
          actor, x: nb.x, y: nb.y, z: nb.z, ry: nb.ry,
          speed: 0, fresh: true, advance: 0, attacking: null, phase: nb.ph || 1, missing: 0,
          hp: nb.hp, maxHp: nb.mhp, level: nb.lv, defId: nb.t,
          shield: nb.sh, shieldMax: nb.shm, aura: nb.au, frozen: nb.fz,
          alive: nb.a !== 0, gaitOffset: gaitOffsetFor(nb.id),
        };
        this.enemies.set(nb.id, e);
        actor.setPose(nb.x, nb.y, nb.z, nb.ry);
      }
      e.missing = 0;

      const na = byIdA.get(nb.id) || nb;
      const u = win.u;
      const px = e.x, pz = e.z;
      e.x = na.x + (nb.x - na.x) * u;
      e.y = na.y + (nb.y - na.y) * u;
      e.z = na.z + (nb.z - na.z) * u;
      e.ry = lerpAngle(na.ry, nb.ry, u);
      // The same two quantities as for a player: the ground covered drives the legs, the snapshot
      // pair drives the blend. (A hilichurl's planted foot slid 1 % of the ground at 60 fps on the
      // old code and 75 % at 6 fps, against `gait-check`'s 4 % bar for a local walker.)
      e.advance = (e.advance || 0) + Math.hypot(e.x - px, e.z - pz);
      const span = Math.max(0.001, (win.b.serverNow - win.a.serverNow) / 1000);
      const inst = Math.hypot(nb.x - na.x, nb.z - na.z) / span;
      e.speed = e.fresh ? inst : smoothSpeed(e.speed, inst, dt);
      e.fresh = false;

      e.hp = nb.hp; e.maxHp = nb.mhp; e.level = nb.lv;
      e.shield = nb.sh; e.shieldMax = nb.shm;
      e.state = nb.st;
      e.attacking = nb.mv || null;
      // 元素附着, on the record and not only on the model. `nb.au` is in every snapshot and was
      // handed straight to `setElementAura` below — the 3D shell tracked the aura correctly —
      // while `e.aura` was written **once, in the constructor above** and never again. An enemy's
      // aura at the moment it streams in is always null (nothing gives a creature an innate one),
      // so every reader of the record read null forever: the nameplate's element pip
      // (`_drawLabels` → `overlay.label({ aura })`) never appeared for any enemy in the game, the
      // 目标 panel (`setTarget`) always said "no aura", and `_onEnemyDied` coloured every death
      // burst 'physical'. Applying an element is the whole first half of a reaction, so this was
      // the mechanic's readout, dead.
      e.aura = nb.au;
      // A boss crossing an hp threshold gets faster attacks, a wider move pool and a 1.2 s
      // stagger (`Entity.damage`), all of which the player has to be *told* about — every one
      // of those is a decision to make. Only an increase, and never on the frame the creature
      // is first seen: joining a fight already in phase 3 is not a transition.
      const ph = nb.ph || 1;
      if (ph > e.phase) {
        const def = ENEMIES[nb.t];
        this.phaseUps.push({
          id: nb.id, defId: nb.t, name: def?.name || nb.t,
          phase: ph, phases: def?.phases || ph,
          x: e.x, y: e.y, z: e.z, height: e.actor.height,
        });
      }
      e.phase = ph;
      const nowAlive = nb.a !== 0;
      if (e.alive && !nowAlive) e.actor.beginDeath();
      e.alive = nowAlive;

      // fz is a server timestamp; treat any future value as frozen.
      const frozen = nb.fz > 0 && nb.fz * 1000 > win.b.serverNow;
      e.frozen = frozen;
      e.actor.setElementAura(nb.au, frozen);
      e.actor.setPose(e.x, e.y, e.z, e.ry);
      // Frozen enemies must not animate — that is the whole read of the status.
      if (frozen) e.speed = 0;
    }

    for (const [id, e] of this.enemies) {
      if (seen.has(id)) continue;
      if (++e.missing > MISSING_GRACE) {
        e.actor.dispose();
        this.enemies.delete(id);
      }
    }
  }

  /** ENEMY_DIED arrives before the enemy drops out of snapshots. */
  killEnemy(id) {
    const e = this.enemies.get(id);
    if (!e) return null;
    e.alive = false;
    e.actor.beginDeath();
    return e;
  }

  /* --------------------------------------------------------- projectiles -- */

  _syncProjectiles(win) {
    const seen = new Set();
    for (const p of win.b.data.projectiles || []) {
      seen.add(p.id);
      let v = this.projectiles.get(p.id);
      if (!v) {
        v = new ProjectileView(this.scene, p.e, p.k);
        this.projectiles.set(p.id, v);
      }
      // Projectiles move fast enough that interpolating between snapshots lags
      // visibly; extrapolate along the sent velocity from the newest sample
      // instead. Being slightly ahead of the server reads far better than an
      // arrow that arrives after the damage number.
      const ahead = Math.max(0, (this.socket.renderTime() - win.b.serverNow)) / 1000;
      const k = p.s * ahead;
      v.setPose(p.x + p.dx * k, p.y + p.dy * k, p.z + p.dz * k, p.dx, p.dy, p.dz);
      this.vfx?.trail(v.mesh.position.x, v.mesh.position.y, v.mesh.position.z, p.e, 0.8);
    }
    for (const [id, v] of this.projectiles) {
      if (seen.has(id)) continue;
      v.dispose();
      this.projectiles.delete(id);
    }
  }

  /* ------------------------------------------------------------ targeting -- */

  /** Living enemies sorted by distance from a point, for lock-on and cleave. */
  enemiesNear(x, z, radius) {
    const out = [];
    for (const [id, e] of this.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d <= radius) out.push({ id, e, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  enemyById(id) { return this.enemies.get(id) || null; }
  playerById(id) { return this.players.get(id) || null; }

  /**
   * Screen-space pick over other players, optionally filtered.
   *
   * Exists for one job: clicking a downed teammate to pick them up. The gateway has always had
   * the teammate branch of `C2S.REVIVE` (free, within 4 m) and nothing in the client ever sent
   * it, so a co-op death could only be waited out.
   */
  pickPlayer(raycaster, maxDist = 60, pred = null) {
    let best = null, bestT = Infinity;
    const o = raycaster.ray.origin, d = raycaster.ray.direction;
    for (const [id, e] of this.players) {
      if (pred && !pred(e)) continue;
      const cy = e.y + (e.actor.height || 1.7) * 0.5;
      const vx = e.x - o.x, vy = cy - o.y, vz = e.z - o.z;
      const t = vx * d.x + vy * d.y + vz * d.z;
      if (t < 0 || t > maxDist) continue;
      const cx = o.x + d.x * t, cyy = o.y + d.y * t, cz = o.z + d.z * t;
      const miss = Math.hypot(cx - e.x, cyy - cy, cz - e.z);
      // A body on the ground is a much smaller target than a standing character, so the
      // radius is generous: this is a rescue, not a precision shot.
      if (miss > 1.6) continue;
      if (t < bestT) { bestT = t; best = { id, p: e, dist: t }; }
    }
    return best;
  }

  /** Screen-space pick: the enemy whose capsule the given ray passes closest to. */
  pickEnemy(raycaster, maxDist = 80) {
    let best = null, bestT = Infinity;
    const o = raycaster.ray.origin, d = raycaster.ray.direction;
    for (const [id, e] of this.enemies) {
      if (!e.alive) continue;
      const cy = e.y + e.actor.height * 0.5;
      const vx = e.x - o.x, vy = cy - o.y, vz = e.z - o.z;
      const t = vx * d.x + vy * d.y + vz * d.z;
      if (t < 0 || t > maxDist) continue;
      const cx = o.x + d.x * t, cyy = o.y + d.y * t, cz = o.z + d.z * t;
      const miss = Math.hypot(cx - e.x, cyy - cy, cz - e.z);
      // Radius scales with the model, plus a little slack so small slimes are
      // still clickable without pixel-perfect aim.
      const r = Math.max(0.7, e.actor.height * 0.45) + 0.35;
      if (miss > r) continue;
      if (t < bestT) { bestT = t; best = { id, e, dist: t }; }
    }
    return best;
  }

  dispose() {
    for (const e of this.players.values()) e.actor.dispose();
    for (const e of this.enemies.values()) e.actor.dispose();
    for (const v of this.projectiles.values()) v.dispose();
    this.players.clear();
    this.enemies.clear();
    this.projectiles.clear();
  }
}
