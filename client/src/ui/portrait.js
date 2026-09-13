// Live 3D character portrait for the character panel.
//
// The panel used to show the first glyph of the character's name in a coloured box,
// which is a placeholder, not a portrait: the game already builds a fully skinned,
// weapon-carrying, element-auraed model for every one of the eight characters, and
// the one screen whose whole job is to show you that character was the one screen
// that didn't. This renders the real rig into its own small canvas.
//
// It is a second WebGL context on purpose. Sharing the world renderer would mean
// swapping its scene and camera mid-frame, or a render target plus a blit pass, for
// a 220x300 image that only exists while one panel is open. A dedicated context is
// ~66 k pixels — cheap next to the main view — and it is torn down when the panel
// closes, so nothing lingers.

import * as THREE from 'three';
import { CHARACTERS } from '@teyvat/shared/data/characters.js';
import { ELEMENTS } from '@teyvat/shared/data/elements.js';
import { buildHumanoid } from '../gfx/humanoid.js';
import { attachWeapon } from '../gfx/weapons.js';
import { Animator } from '../gfx/animator.js';
import { setAura } from '../gfx/toon.js';

const W = 220;
const H = 300;

/** Slow turntable: a portrait that never moves reads as a still image. */
const SPIN = 0.42;         // radians per second
const SPIN_RANGE = 0.55;   // ± yaw around three-quarter view, in radians

export class Portrait {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'portrait-3d';
    this.canvas.width = W;
    this.canvas.height = H;

    // `alpha` so the panel's own gradient shows behind the character instead of a
    // black rectangle punched into the frame.
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, alpha: true, stencil: false,
      powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(W, H, false);
    this.renderer.setClearAlpha(0);
    // Matched to the world renderer, or the same character is a different colour in
    // the panel than it is on screen.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    // Long lens: 24° flattens the perspective the way a character-select render
    // should, where a 52° game camera gives you a fish-eyed head and tiny feet.
    this.camera = new THREE.PerspectiveCamera(24, W / H, 0.1, 40);

    // Three-point rig. The world's sun direction is zone-dependent and would light
    // the same character differently in Mondstadt than in a cavern; a portrait wants
    // a fixed, flattering key regardless of where the player happens to be standing.
    this.key = new THREE.DirectionalLight(0xfff3dd, 2.0);
    this.key.position.set(-2.4, 3.2, 3.4);
    this.fill = new THREE.DirectionalLight(0xbfd4ff, 0.65);
    this.fill.position.set(3.0, 0.6, 1.6);
    this.rim = new THREE.DirectionalLight(0xffffff, 1.25);
    this.rim.position.set(1.2, 2.0, -3.6);
    this.hemi = new THREE.HemisphereLight(0x9fb4e0, 0x3a3040, 0.55);
    this.scene.add(this.key, this.fill, this.rim, this.hemi);

    // Element-tinted back light, recoloured per character in setCharacter.
    this.accent = new THREE.PointLight(0xffffff, 6, 8, 2);
    this.accent.position.set(0, 1.1, -1.5);
    this.scene.add(this.accent);

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this.charId = null;
    this.rig = null;
    this.weapon = null;
    this.animator = null;
    this.t = 0;
    this._raf = 0;
    this._last = 0;
  }

  /** Build (or rebuild) the model. Cheap to call with the same id. */
  setCharacter(charId) {
    if (this.charId === charId) return;
    this._dispose();
    const def = CHARACTERS[charId];
    if (!def) return;
    this.charId = charId;

    // Outline on: the toon outline is part of how these characters read, and at this
    // size dropping it makes the silhouette mushy against the panel background.
    this.rig = buildHumanoid(def, { outline: true, outlineWidth: 1.5 });
    this.pivot.add(this.rig.group);
    this.animator = new Animator(this.rig);
    this.animator.play('idle');
    this.weapon = attachWeapon(this.rig, def.weapon, { element: def.element });

    const elColor = ELEMENTS[def.element]?.color ?? 0xffffff;
    setAura(this.rig.group, elColor, 0.16);
    this.accent.color.setHex(elColor);

    this._frameCamera();
  }

  /**
   * Fit the camera to the character's actual height. The eight rigs differ by ~25 cm,
   * so a fixed camera crops the tall ones at the ankles and leaves the short ones
   * floating in the middle of the frame.
   */
  _frameCamera() {
    const hgt = this.rig?.height ?? 1.7;
    // Aim a little above the waist and pull back far enough for head-to-heel plus a
    // small margin, given the vertical FOV.
    const target = hgt * 0.54;
    const halfV = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    // 0.52 · height as the half-frame: head-to-heel plus ~4% margin. Anything looser
    // and the character sits in the middle of an empty box at this size.
    const dist = (hgt * 0.52) / Math.tan(halfV);
    this.camera.position.set(0, target + hgt * 0.06, dist);
    this.camera.lookAt(0, target, 0);
    this.accent.position.set(0, hgt * 0.62, -hgt * 0.9);
  }

  /** Start the render loop. Idempotent. */
  start() {
    if (this._raf) return;
    this._last = performance.now();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      const now = performance.now();
      // Clamped: a backgrounded tab hands back a multi-second dt, and the secondary
      // springs in the animator explode when integrated over one.
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      this.t += dt;
      if (!this.rig) return;
      // `auto: false` pins the base clip: autoLocomotion would read speed 0 and be
      // right, but it also re-plays 'idle' every frame and resets the phase.
      this.animator.update(dt, { speed: 0, grounded: true, auto: false });
      this.weapon?.update?.(dt, this.t);
      this.pivot.rotation.y = 0.32 + Math.sin(this.t * SPIN) * SPIN_RANGE;
      this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _dispose() {
    if (!this.rig) return;
    this.weapon?.dispose?.();
    this.pivot.remove(this.rig.group);
    this.rig.group.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    this.rig = null;
    this.weapon = null;
    this.animator = null;
    this.charId = null;
  }

  /** Full teardown, including the GL context. Called when the panel closes. */
  dispose() {
    this.stop();
    this._dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}
