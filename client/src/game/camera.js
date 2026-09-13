// Third-person orbit camera.
//
// The three details that make an action-RPG camera feel right, all here:
//
//  * The pivot lags the character with a critically-damped spring rather than
//    tracking it exactly. Hard tracking makes the world jitter with every
//    footstep bob; a spring turns the same motion into weight.
//  * The boom shortens when terrain would come between the camera and the
//    character. Without it, running up against a cliff puts the camera inside the
//    rock and the player is blind exactly when they are being ambushed.
//  * Vertical framing shifts with pitch: looking down should look *past* the
//    character, not at the top of their head.

import * as THREE from 'three';
import { clamp, lerp } from '@teyvat/shared/sim/rng.js';

const MIN_PITCH = -0.28;   // radians below horizontal (looking up)
const MAX_PITCH = 1.16;    // looking down, just short of top-down
const MIN_DIST = 1.9;
const MAX_DIST = 13.5;

export class CameraRig {
  constructor(camera, terrainHeight) {
    this.camera = camera;
    this.heightAt = terrainHeight;          // (x, z) => y
    this.blockedAt = null;                  // (x, y, z) => inside a trunk/boulder?

    this.yaw = Math.PI;                     // behind the character, looking +Z
    this.pitch = 0.30;
    this.dist = 7.0;
    this._distNow = 7.0;                    // spring-smoothed boom length

    this.pivot = new THREE.Vector3(0, 1.4, 0);
    this.target = new THREE.Vector3(0, 1.4, 0);
    this.pivotVel = new THREE.Vector3();

    this.sens = 0.0032;
    this.invertY = false;
    this.shake = 0;
    this._shakeT = 0;
    this.aiming = false;
    this.fovBase = camera.fov;

    this._tmp = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  /** Snap with no interpolation — after a teleport or a zone change. */
  snapTo(x, y, z) {
    this.target.set(x, y, z);
    this.pivot.copy(this.target);
    this.pivotVel.set(0, 0, 0);
    this._distNow = this.dist;
    this._apply(0);
  }

  /**
   * Snap to a character rather than to a raw point. Callers have the character's
   * feet and height, not the pivot, and getting the conversion wrong is invisible
   * on a fast machine and crippling on a slow one: seeding the pivot metres below
   * the character leaves the boom underground, so the clearance test retracts it
   * to the minimum and the spring needs a full second of *simulated* time to
   * climb out — at 5 fps that is twenty seconds of staring at the character's
   * back from ten centimetres away. So the offset lives here, next to the
   * identical expression in `update`, where the two cannot drift apart.
   */
  snapToFocus(focus, height = 1.7) {
    this.snapTo(
      focus.x,
      focus.y + height * (this.aiming ? 0.86 : 0.62) + this.pitch * height * 0.30,
      focus.z,
    );
  }

  orbit(dx, dy) {
    this.yaw -= dx * this.sens;
    this.pitch += (this.invertY ? -dy : dy) * this.sens;
    this.pitch = clamp(this.pitch, MIN_PITCH, MAX_PITCH);
    // Keep yaw bounded so the float never drifts into precision loss over a long
    // session of spinning in one direction.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  zoom(amount) {
    // Multiplicative so one wheel notch feels the same close in and far out.
    this.dist = clamp(this.dist * (1 + amount * 0.12), MIN_DIST, MAX_DIST);
  }

  addShake(strength) {
    this.shake = Math.min(1.4, this.shake + strength);
  }

  setAiming(v) { this.aiming = v; }

  /** Turn the camera to look along a world direction (used when locking on). */
  faceDirection(dx, dz, blend = 1) {
    const want = Math.atan2(-dx, -dz);
    let d = want - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * blend;
  }

  /** Camera-space forward/right on the ground plane — what WASD is relative to. */
  basis() {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    // Forward is where the camera looks, flattened to the XZ plane. Right is
    // forward × up (three is right-handed, +Y up), which for this forward is
    // (cos yaw, -sin yaw) — the sign that puts D and → on the screen's right.
    // It was (-cos, +sin) for a long time, i.e. strafing was mirrored, and no
    // probe saw it because the one test of "left click vs right click" derived
    // its click point through this same basis and measured the result with it
    // too, so the sign cancelled. Anything asserting a side must land in
    // screen space; see the 「横移落在屏幕的哪一侧」 section of motion-check.
    return { fx: -s, fz: -c, rx: c, rz: -s };
  }

  /**
   * `focus` is the character's feet; `height` their eye/chest height. Both are
   * needed: the pivot sits at chest height but the boom must not sink below the
   * ground under the *camera*, which can be metres away from the feet.
   */
  update(dt, focus, height = 1.7, moving = false) {
    // Aiming pulls in and narrows the fov, the standard over-the-shoulder read.
    const wantDist = this.aiming ? Math.min(this.dist, 3.2) : this.dist;
    const wantFov = this.aiming ? this.fovBase * 0.72 : this.fovBase;
    if (Math.abs(this.camera.fov - wantFov) > 0.01) {
      this.camera.fov = lerp(this.camera.fov, wantFov, 1 - Math.exp(-9 * dt));
      this.camera.updateProjectionMatrix();
    }

    // Pivot: chest height, drifting up slightly as the camera pitches down so we
    // frame the ground ahead rather than the character's scalp.
    this.target.set(
      focus.x,
      focus.y + height * (this.aiming ? 0.86 : 0.62) + this.pitch * height * 0.30,
      focus.z,
    );

    // Critically-damped spring. omega is higher while moving so the camera keeps
    // up in a sprint, and lower at rest so idle breathing does not shove it.
    const omega = moving ? 13.0 : 8.0;
    const k = omega * omega, c2 = 2 * omega;
    this._tmp.subVectors(this.target, this.pivot);
    this.pivotVel.addScaledVector(this._tmp, k * dt).addScaledVector(this.pivotVel, -c2 * dt);
    this.pivot.addScaledVector(this.pivotVel, dt);
    // Hard clamp so a teleport can never leave the camera chasing across the map.
    if (this.pivot.distanceToSquared(this.target) > 400) this.snapTo(this.target.x, this.target.y, this.target.z);

    // --- boom, with terrain clearance --------------------------------------
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this._dir.set(
      Math.sin(this.yaw) * cp,
      sp,
      Math.cos(this.yaw) * cp,
    );
    let allowed = wantDist;
    if (this.heightAt || this.blockedAt) {
      // March along the boom and stop short of the first sample that would put
      // the camera under the surface or inside a prop. 10 samples over ~7 m is
      // fine enough to catch a tree trunk, and costs ten noise evaluations plus
      // ten grid lookups — nothing next to a raycast against the streamed mesh.
      const STEPS = 10;
      for (let i = 1; i <= STEPS; i++) {
        const t = (i / STEPS) * wantDist;
        const px = this.pivot.x + this._dir.x * t;
        const pz = this.pivot.z + this._dir.z * t;
        const py = this.pivot.y + this._dir.y * t;
        const under = this.heightAt && py < this.heightAt(px, pz) + 0.55;
        if (under || (this.blockedAt && this.blockedAt(px, py, pz))) {
          allowed = Math.max(MIN_DIST * 0.55, ((i - 1) / STEPS) * wantDist);
          break;
        }
      }
    }
    // Retract instantly (never clip into rock) but extend slowly, so squeezing
    // past a boulder does not fling the camera back out.
    this._distNow = allowed < this._distNow
      ? allowed
      : lerp(this._distNow, allowed, 1 - Math.exp(-4.5 * dt));

    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.6);
      this._shakeT += dt;
    }
    this._apply(dt);
  }

  _apply() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const d = this._distNow;
    let x = this.pivot.x + Math.sin(this.yaw) * cp * d;
    let y = this.pivot.y + sp * d;
    let z = this.pivot.z + Math.cos(this.yaw) * cp * d;

    if (this.heightAt) {
      // Final safety: never below ground, whatever the boom search concluded.
      const g = this.heightAt(x, z) + 0.35;
      if (y < g) y = g;
    }

    if (this.shake > 0) {
      // Two incommensurate frequencies per axis so the shake never looks like a
      // clean sine — a single sine reads as a camera wobble, not an impact.
      const s = this.shake * this.shake * 0.34;
      const t = this._shakeT;
      x += (Math.sin(t * 43.1) + Math.sin(t * 71.7) * 0.6) * s;
      y += (Math.sin(t * 37.3 + 1.7) + Math.sin(t * 61.1) * 0.6) * s;
      z += (Math.sin(t * 53.9 + 0.6) + Math.sin(t * 79.3) * 0.6) * s;
    }

    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.pivot);
  }

  /** Ground-plane direction the camera is facing — the default attack direction. */
  forward(out = new THREE.Vector3()) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    return out.set(-s, 0, -c);
  }
}
