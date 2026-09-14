// World-space visual effects: impact sparks, elemental bursts, slash arcs,
// shockwave rings, reaction blooms, healing motes, level-up pillars.
//
// Design constraints that shape the implementation:
//
//  * No textures. Every effect is geometry + additive vertex colours, matching
//    the rest of the project's procedural-only rule.
//  * Fixed pools, allocated once. A burst that allocates a BufferGeometry mid-
//    fight causes a GC hitch exactly when the frame budget is tightest, so the
//    spark system is one persistent Points cloud whose particles are recycled.
//  * Everything additive and depth-write-off, drawn after the scene. Elemental
//    VFX in this style are light, not surfaces; writing depth makes two
//    overlapping bursts punch holes in each other.

import * as THREE from 'three';
import { ELEMENTS } from '@teyvat/shared/data/elements.js';
import { TAU, lerp, clamp } from '@teyvat/shared/sim/rng.js';

/** Element → colour. Falls back to white for physical hits. */
export function elementColor(el) {
  return ELEMENTS[el]?.color ?? 0xffffff;
}

const MAX_SPARKS = 2400;

/* ------------------------------------------------------------------ sparks -- */

/**
 * One additive Points cloud for every spark in the world.
 *
 * Particles live in a flat Float32Array rather than an object array: at 2400
 * live sparks the per-particle object churn is measurable, and the arrays are
 * also exactly what the BufferAttributes need, so there is no copy step.
 */
class SparkField {
  constructor(scene) {
    this.n = MAX_SPARKS;
    this.pos = new Float32Array(this.n * 3);
    this.vel = new Float32Array(this.n * 3);
    this.col = new Float32Array(this.n * 3);
    this.life = new Float32Array(this.n);
    this.maxLife = new Float32Array(this.n);
    this.size = new Float32Array(this.n);
    this.drag = new Float32Array(this.n);
    this.grav = new Float32Array(this.n);
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3);
    this.aCol = new THREE.BufferAttribute(this.col, 3);
    this.aSize = new THREE.BufferAttribute(this.size, 1);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    this.aSize.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('color', this.aCol);
    geo.setAttribute('aSize', this.aSize);
    // Dead particles are parked at size 0 and culled in the vertex shader; the
    // draw range stays the whole buffer, which is one draw call regardless.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 1 } },
      vertexShader: /* glsl */`
        attribute float aSize;
        varying vec3 vCol;
        varying float vAlpha;
        uniform float uScale;
        void main() {
          vCol = color;
          vAlpha = step(0.0001, aSize);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // aSize is the particle's diameter in CENTIMETRES, so this is
          // metres * (pixels per metre at one metre) / distance — a real perspective
          // size, with the clamp only for a spark that ends up inside the lens.
          //
          // It used to be aSize * uScale / -mv.z with aSize in the 16..34 range and
          // uScale around 960 (half the viewport height over tan(halfFov)), i.e. tens of
          // thousands of pixels: *every* particle within 200 m hit the 90 px ceiling. So
          // sparks did not shrink with distance, and the per-effect sizes — 16 for footstep
          // dust, 34 for a death burst — were authored data that reached nothing. A single
          // 20-spark burst 11 m away rendered as one white mass 180 px across.
          gl_PointSize = clamp(aSize * 0.01 * uScale / max(0.35, -mv.z), 1.0, 200.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCol;
        varying float vAlpha;
        void main() {
          // Round, soft-edged, with a hot core — a square point reads as a bug.
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d);
          if (r > 0.5) discard;
          float a = pow(1.0 - r * 2.0, 1.6);
          gl_FragColor = vec4(vCol * (0.6 + a * 1.6), a * vAlpha);
        }`,
    });
    mat.vertexColors = true;

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 12;
    scene.add(this.points);
  }

  /** Allocate one particle, recycling the oldest slot if the pool is full. */
  spawn(x, y, z, vx, vy, vz, r, g, b, life, size, drag = 2.2, grav = -9) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.drag[i] = drag;
    this.grav[i] = grav;
  }

  update(dt) {
    const { pos, vel, life, maxLife, size, drag, grav } = this;
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (life[i] <= 0) continue;
      any = true;
      life[i] -= dt;
      const i3 = i * 3;
      if (life[i] <= 0) {
        size[i] = 0;
        continue;
      }
      const d = 1 - drag[i] * dt;
      vel[i3] *= d;
      vel[i3 + 1] = vel[i3 + 1] * d + grav[i] * dt;
      vel[i3 + 2] *= d;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      // Shrink over the tail of the life so sparks wink out rather than vanish.
      const u = life[i] / maxLife[i];
      size[i] = size[i] * 0.995 * (u < 0.35 ? 0.90 : 1.0);
    }
    if (any) {
      this.aPos.needsUpdate = true;
      this.aSize.needsUpdate = true;
      this.aCol.needsUpdate = true;
    }
  }

  /** Kill every live particle this instant. Returns how many were dropped. */
  clear() {
    let n = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] = 0;
      this.size[i] = 0;
      n++;
    }
    if (n) { this.aSize.needsUpdate = true; }
    return n;
  }

  dispose() {
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.points.parent?.remove(this.points);
  }
}

/* ------------------------------------------------------------------- meshes -- */

/**
 * Pool of short-lived transform-animated meshes (rings, arcs, flashes). Each
 * entry carries an `anim(o, u)` closure that gets the object and its normalised
 * age, so a new effect is a few lines rather than a new class.
 */
class MeshPool {
  constructor(scene, make, count) {
    this.scene = scene;
    this.free = [];
    this.live = [];
    for (let i = 0; i < count; i++) {
      const o = make();
      o.visible = false;
      o.frustumCulled = false;
      scene.add(o);
      this.free.push(o);
    }
  }

  take(life, anim) {
    const o = this.free.pop() ?? this.live.shift()?.o;
    if (!o) return null;
    o.visible = true;
    const e = { o, t: 0, life, anim };
    this.live.push(e);
    anim(o, 0);
    return o;
  }

  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i];
      e.t += dt;
      const u = e.t / e.life;
      if (u >= 1) {
        e.o.visible = false;
        this.live.splice(i, 1);
        this.free.push(e.o);
        continue;
      }
      e.anim(e.o, u);
    }
  }

  /** Retire every live mesh this instant. Returns how many were dropped. */
  clear() {
    const n = this.live.length;
    for (const e of this.live) { e.o.visible = false; this.free.push(e.o); }
    this.live.length = 0;
    return n;
  }

  dispose() {
    for (const o of [...this.free, ...this.live.map((e) => e.o)]) {
      o.geometry?.dispose();
      o.material?.dispose();
      o.parent?.remove(o);
    }
    this.free.length = 0;
    this.live.length = 0;
  }
}

/* ---------------------------------------------------------- danger decals -- */

/**
 * `attackShape().kind` → the branch the decal's fragment shader takes.
 *
 * Exported so `tools/enemy-check.mjs` can gate the two vocabularies against each other in both
 * directions: a shape kind the shader cannot draw would silently render nothing, and a mode no
 * shape ever asks for is dead GLSL. Keep the numbers in step with the `if` chain below.
 */
export const TELEGRAPH_MODES = { disc: 0, sector: 1, lane: 2, aim: 3, ring: 4 };

/** Grid resolution of a decal, per side. 13×13 vertices follow a hillside closely enough that
 *  the outline stops disappearing into the slope, and costs 169 `heightAt` samples per cast. */
const DECAL_SEG = 12;

/** Thickness of the summon ring, metres — about the width of the body that arrives on it. */
const RING_BAND = 0.9;

/**
 * A ground-projected danger zone.
 *
 * Flat geometry is not enough: the moves that need this most are a boss's, bosses live in
 * arenas with slopes, and a flat 8 m disc laid on a hillside buries half its outline in the
 * terrain — the half a player standing downhill needs. So the grid's vertices are lifted onto
 * the height field at cast time (`telegraph()`), and the shape itself is drawn in the fragment
 * shader from local metres, which keeps one mesh able to draw all five kinds.
 */
const decalMaterial = () => new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  // Blended toward the colour, not added to the scene. An additive wash is unbounded by
  // construction, and this is the largest additive surface in the game: the interior added about
  // half a unit of light to whatever was under it, which greys out noon grass (measured
  // 126,155,75 → 177,180,177) and at 23:00 comes back off the ACES shoulder desaturated and
  // clipped — an 8 m hydro disc photographed as a neutral 244,244,244 plate over half the frame
  // and outshone every HUD line standing on it (`tools/legible-check.mjs` scored a name plate at
  // 1.44:1 against its 3:1 bar). A mix can never leave the colour it mixes toward, so the same
  // decal is a coloured film at every hour and its outline stays the brightest part of it.
  blending: THREE.NormalBlending,
  side: THREE.DoubleSide,
  uniforms: {
    uColor: { value: new THREE.Color(0xffffff) },
    uMode: { value: 0 },
    uR: { value: 1 },        // metres: the radius damage reaches (shape.hit)
    uSpan: { value: 0 },     // metres: half the swept length, lane/aim only
    uArc: { value: 0 },      // radians: full sector angle, sector only
    uBand: { value: RING_BAND },
    uEdge: { value: 0.16 },  // metres: half-width of the bright outline
    uFill: { value: 0 },     // 0..1 wind-up progress; 1 is the instant the blow lands
    uAlpha: { value: 1 },
    uLight: { value: 1 },    // the world's daylight, exactly 1 at the authored noon
  },
  vertexShader: /* glsl */`
    varying vec2 vP;
    void main() {
      // x/z are already in local metres (telegraph() writes them), +z is the creature's facing,
      // and y is the height field. So the fragment shader works in metres and the uniforms it
      // compares against are the authored numbers, unscaled.
      vP = vec2(position.x, position.z);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    varying vec2 vP;
    uniform vec3 uColor;
    uniform float uMode, uR, uSpan, uArc, uBand, uEdge, uFill, uAlpha, uLight;
    const float TAU = 6.2831853;

    void main() {
      float d;              // signed distance to the boundary, metres (negative = inside)
      float filled;         // 1 where the sweep has already arrived
      float r = length(vP);

      if (uMode < 0.5) {                       // disc
        d = r - uR;
        filled = step(r, uR * uFill);
      } else if (uMode < 1.5) {                // sector
        float a = abs(atan(vP.x, vP.y));
        d = max(r - uR, (a - uArc * 0.5) * uR);
        filled = step(r, uR * uFill) * step(a, uArc * 0.5);
      } else if (uMode < 3.5) {                // lane / aim: swept disc
        d = length(vec2(vP.x, max(abs(vP.y) - uSpan, 0.0))) - uR;
        filled = step(vP.y, mix(-uSpan, uSpan, uFill));
        // The aim line is dashed along its length, so a 22 m trajectory does not read as a
        // 22 m wall: same geometry, different sign.
        if (uMode > 2.5) filled *= step(0.42, fract(vP.y * 0.55 + uFill));
      } else {                                 // ring
        d = abs(r - uR) - uBand;
        filled = step(fract(atan(vP.x, vP.y) / TAU + 1.0), uFill);
      }

      // Three layers: the outline (always, so the extent is legible the instant it appears),
      // a dim wash over the whole shape, and the sweep that reaches the edge exactly at impact.
      float outline = 1.0 - smoothstep(0.0, uEdge, abs(d));
      float inside = 1.0 - step(0.0, d);
      float a = outline * 0.92 + inside * (0.14 + filled * 0.24);
      if (a < 0.004) discard;
      // Pigment inside, a lit line on the boundary.
      //
      // A mix is bounded, but the bound is the *colour*, and a 0.38 mix toward a full-intensity hue
      // is composited in linear HDR: over noon grass it read +42 luma (137 → 180) and at 23:00 it
      // read 154 against a world at 20, so a slime's 6 m wind-up was still the brightest thing on
      // the screen and legible-check scored the enemy name plate standing on it at 2.36:1 against
      // its 3:1 bar. So the interior is pigment — uColor * 0.30, darker than any lit ground — and
      // it *stains* rather than glows: it takes noon grass down and dark grass slightly up, which
      // is what paint does. The outline keeps the lift (over 1.0 it clips per channel, saturating
      // the hue instead of walking it toward white), because the boundary is the promise being made.
      //
      // uLight is the world's own daylight, with a floor: a warning has to be readable in the
      // dark, and it is exactly 1 at the authored noon every calibrated probe pins.
      float lit = max(uLight, 0.55);
      vec3 col = mix(uColor * (0.30 + filled * 0.22), uColor * 1.35, outline) * lit;
      gl_FragColor = vec4(col, clamp(a * uAlpha, 0.0, 1.0));
    }`,
});

/**
 * The impact flash's shape, in its own fragment shader.
 *
 * `PlaneGeometry` + `MeshBasicMaterial` draws a **rectangle of one flat colour**, and this pool is
 * the one effect in the file whose shape was supposed to come from a texture the project does not
 * have. Photographed on a black plate (`.run/flash-lab.mjs`): the 6 m shield flash was a 278×278 px
 * block, `fill 1.000`, corners exactly as bright as the middle (`diag/centre 1.000`) and a radial
 * profile of `1 1 1 1 1` out to the last pixel — a white sticker, 12 % of the viewport, on every
 * hit, reaction and burst. `SparkField` already says why that is wrong, twelve lines up: "a square
 * point reads as a bug".
 *
 * So the falloff is computed rather than sampled, from `vUv`, and it is three terms because a flash
 * is not a disc either: a hot core, a radial tail, and four soft spikes along the quad's own axes
 * (which are the camera's, after `flash()` billboards it) so a hit reads as a glint.
 *
 * `uShape` is the axis this was measured along — 1 is the authored value, 0 puts the flat square
 * back. `tools/react-check.mjs` sweeps it, because "it has no corners now" is only evidence if the
 * corners come back when the term is taken away.
 */
const flashMaterial = () => new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  fog: false,
  uniforms: {
    uColor: { value: new THREE.Color(0xffffff) },
    uAlpha: { value: 1 },
    uShape: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uColor;
    uniform float uAlpha;
    uniform float uShape;
    varying vec2 vUv;
    void main() {
      vec2 q = (vUv - 0.5) * 2.0;            // -1..1 across the quad
      float f = max(0.0, 1.0 - length(q));   // 1 at the centre, 0 at the inscribed circle
      // Four arms: thin across, long along, on both axes. The max() keeps the crossing point at
      // one arm's brightness instead of two.
      vec2 a = abs(q);
      float arm = max(
        (1.0 - smoothstep(0.0, 0.17, a.y)) * (1.0 - smoothstep(0.12, 0.98, a.x)),
        (1.0 - smoothstep(0.0, 0.17, a.x)) * (1.0 - smoothstep(0.12, 0.98, a.y)));
      float shaped = pow(f, 2.4) * 0.42 + pow(f, 9.0) * 0.5 + arm * 0.36;
      // Normalised on the centre so that turning the shape off is a change of *shape* and not a
      // change of exposure: both ends of uShape put the same amount of light at the middle.
      float m = mix(1.0, shaped / 1.28, uShape);
      if (m < 0.004) discard;
      gl_FragColor = vec4(uColor, clamp(m, 0.0, 1.0) * uAlpha);
    }`,
});

const additive = (color) => new THREE.MeshBasicMaterial({
  color,
  transparent: true,
  opacity: 1,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  fog: false,
});

/* ---------------------------------------------------------------------- VFX -- */

const V = new THREE.Vector3();
const C = new THREE.Color();

export class Vfx {
  constructor(scene) {
    this.scene = scene;
    this.sparks = new SparkField(scene);
    /** Daylight multiplier for ground decals; 1 until the world says otherwise. */
    this.dayLight = 1;

    // Ground shockwave ring: a flat annulus that expands and fades.
    this.rings = new MeshPool(scene, () => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.62, 1.0, 44).rotateX(-Math.PI / 2),
        additive(0xffffff),
      );
      m.renderOrder = 11;
      return m;
    }, 14);

    // Slash arc: a torus wedge swept through the swing plane.
    this.arcs = new MeshPool(scene, () => {
      const m = new THREE.Mesh(
        new THREE.TorusGeometry(1.0, 0.055, 4, 26, Math.PI * 0.92),
        additive(0xffffff),
      );
      m.renderOrder = 11;
      return m;
    }, 12);

    // Impact flash: a billboarded quad whose shape lives in `flashMaterial`'s fragment shader —
    // the geometry is only the canvas the falloff is drawn on.
    this.flashes = new MeshPool(scene, () => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flashMaterial());
      m.renderOrder = 13;
      return m;
    }, 16);

    // Vertical light pillar: level-up, chamber clear, statue attunement.
    this.pillars = new MeshPool(scene, () => {
      const g = new THREE.CylinderGeometry(1, 1, 1, 26, 1, true);
      g.translate(0, 0.5, 0);
      const m = new THREE.Mesh(g, additive(0xffffff));
      m.renderOrder = 11;
      return m;
    }, 5);

    // Spherical burst shell (bursts, reactions).
    this.shells = new MeshPool(scene, () => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), additive(0xffffff));
      m.renderOrder = 11;
      return m;
    }, 10);

    // Ground danger decals: the shape an enemy attack is about to cover. Ten is a camp of six
    // plus a boss and its summons all winding up at once; each keeps its own geometry because
    // `telegraph()` rewrites the vertices to sit on the terrain.
    this.decals = new MeshPool(scene, () => {
      const g = new THREE.PlaneGeometry(1, 1, DECAL_SEG, DECAL_SEG).rotateX(-Math.PI / 2);
      g.attributes.position.setUsage(THREE.DynamicDrawUsage);
      const m = new THREE.Mesh(g, decalMaterial());
      m.renderOrder = 10;      // under the rings and sparks: this is the floor
      return m;
    }, 10);

    this.camera = null;
    this.quality = 1.0;      // particle-count multiplier, driven by the settings
  }

  setQuality(q) {
    this.quality = ({ low: 0.35, medium: 0.65, high: 1.0, ultra: 1.4 })[q] ?? 1.0;
  }

  /**
   * Drop every effect currently in flight, and say how many there were.
   *
   * Needed in two places that both used to leak. A zone change tears down the world and
   * the actors but the Vfx pools live on the persistent scene, so a burst fired one frame
   * before a teleport kept animating — at the *old* zone's coordinates — in the new one.
   * And a screenshot probe that freezes the loop freezes whatever was mid-fade with it:
   * `tools/enemy-cam.mjs` photographed a 12 m light pillar standing on the ruin guard's
   * head because the frame it froze was the frame the camp spawned in, and its
   * `g.vfx?.clear?.()` was a silent no-op — the method did not exist.
   */
  clear() {
    let n = this.sparks.clear();
    for (const p of this.meshPools()) n += p.clear();
    return n;
  }

  /**
   * Every mesh pool, in a fixed order.
   *
   * One list, so that adding a pool cannot forget `clear()` — and so a probe that hides the
   * world can ask which objects belong to the effect layer without naming them (which is how
   * `tools/react-check.mjs` would have quietly started hiding the newest pool).
   */
  meshPools() {
    return [this.rings, this.arcs, this.flashes, this.pillars, this.shells, this.decals];
  }

  update(dt, camera) {
    this.camera = camera;
    this.sparks.update(dt);
    this.rings.update(dt);
    this.arcs.update(dt);
    this.flashes.update(dt);
    this.pillars.update(dt);
    this.shells.update(dt);
    this.decals.update(dt);
    // Point size is in pixels at 1 m, so it has to scale with the viewport or
    // sparks look twice as big in a small window.
    this.sparks.points.material.uniforms.uScale.value = (camera?.__vfxScale ?? 260);
  }

  /* ------------------------------------------------------------ primitives -- */

  burstSparks(x, y, z, color, count, speed, opts = {}) {
    C.set(color);
    const n = Math.max(3, Math.round(count * this.quality));
    const life = opts.life ?? 0.55;
    const size = opts.size ?? 26;
    const up = opts.up ?? 0.5;
    for (let i = 0; i < n; i++) {
      // Uniform-ish sphere sampling, biased upward: a symmetric burst reads as a
      // firework, while pushing the mean up reads as an impact throwing debris.
      const a = Math.random() * TAU;
      const ct = Math.random() * 2 - 1;
      const st = Math.sqrt(1 - ct * ct);
      const s = speed * (0.45 + Math.random() * 0.75);
      const jr = opts.spread ?? 0.12;
      this.sparks.spawn(
        x + (Math.random() - 0.5) * jr,
        y + (Math.random() - 0.5) * jr,
        z + (Math.random() - 0.5) * jr,
        Math.cos(a) * st * s,
        (ct * 0.6 + up) * s,
        Math.sin(a) * st * s,
        C.r, C.g, C.b,
        life * (0.6 + Math.random() * 0.8),
        size * (0.55 + Math.random() * 0.9),
        opts.drag ?? 2.4,
        opts.grav ?? -9,
      );
    }
  }

  /** Cone of sparks along a direction — hits, muzzle flashes, dashes. */
  coneSparks(x, y, z, dx, dy, dz, color, count, speed, spread = 0.5) {
    C.set(color);
    V.set(dx, dy, dz);
    if (V.lengthSq() < 1e-6) V.set(0, 1, 0);
    V.normalize();
    // Build an orthonormal basis around the direction without a Matrix4.
    const ax = Math.abs(V.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const t1 = new THREE.Vector3().crossVectors(V, ax).normalize();
    const t2 = new THREE.Vector3().crossVectors(V, t1);
    const n = Math.max(3, Math.round(count * this.quality));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const r = Math.random() * spread;
      const s = speed * (0.5 + Math.random() * 0.8);
      const vx = V.x * s + (t1.x * Math.cos(a) + t2.x * Math.sin(a)) * r * s;
      const vy = V.y * s + (t1.y * Math.cos(a) + t2.y * Math.sin(a)) * r * s;
      const vz = V.z * s + (t1.z * Math.cos(a) + t2.z * Math.sin(a)) * r * s;
      this.sparks.spawn(x, y, z, vx, vy, vz, C.r, C.g, C.b,
        0.3 + Math.random() * 0.35, 20 + Math.random() * 22, 3.0, -5);
    }
  }

  ring(x, y, z, color, radius, life = 0.5, thickness = 1) {
    this.rings.take(life, (o, u) => {
      const r = radius * (0.18 + u * 0.95);
      o.position.set(x, y + 0.06, z);
      o.scale.set(r, 1, r * thickness);
      o.material.color.set(color);
      o.material.opacity = (1 - u) * (1 - u) * 0.95;
    });
  }

  /** Expanding shell — elemental burst, reaction bloom. */
  shell(x, y, z, color, radius, life = 0.45) {
    this.shells.take(life, (o, u) => {
      const r = radius * (0.12 + u * 1.05);
      o.position.set(x, y, z);
      o.scale.setScalar(r);
      o.material.color.set(color);
      // Fade fast: a lingering sphere looks like a bubble stuck on the character.
      o.material.opacity = Math.pow(1 - u, 2.4) * 0.55;
    });
  }

  /**
   * Slash arc. `dir` is the swing direction, `roll` rotates the swing plane, so
   * consecutive combo hits can alternate between horizontal and diagonal.
   */
  slash(x, y, z, dx, dz, color, radius = 1.5, roll = 0, life = 0.22) {
    const yaw = Math.atan2(dx, dz);
    this.arcs.take(life, (o, u) => {
      o.position.set(x, y, z);
      o.rotation.set(Math.PI / 2 + roll, yaw, 0, 'YXZ');
      const s = radius * (0.72 + u * 0.5);
      o.scale.set(s, s, 1 + u * 1.6);
      o.material.color.set(color);
      o.material.opacity = Math.pow(1 - u, 1.5) * 0.95;
    });
  }

  /**
   * Camera-facing flash quad.
   *
   * `size` is the width the *quad* grows to, and the shape inside it reaches the inscribed circle,
   * so the visible flash is that circle plus its spikes rather than the full square.
   */
  flash(x, y, z, color, size, life = 0.16) {
    this.flashes.take(life, (o, u) => {
      o.position.set(x, y, z);
      if (this.camera) o.quaternion.copy(this.camera.quaternion);
      const s = size * (0.4 + u * 1.5);
      o.scale.set(s, s, 1);
      o.material.uniforms.uColor.value.set(color);
      o.material.uniforms.uAlpha.value = Math.pow(1 - u, 2) * 0.9;
    });
  }

  /**
   * Draw the ground an attack is about to cover, from the move's own geometry.
   *
   * `shape` is exactly what `attackShape(mv, def)` returns, so the outline sits at the radius
   * the damage test uses and the fill reaches it at the instant the blow lands: the wind-up is
   * a readable promise instead of decoration. `groundY(x, z)` is the terrain sampler — pass
   * `world.heightAt` — and `ry` is the creature's facing, which is what `lane`, `aim` and
   * `sector` are measured from.
   *
   * Returns the extent it drew, `[halfX, halfZ]` metres, so a probe can compare the picture
   * against the authored numbers without re-deriving them.
   */
  telegraph(shape, x, z, ry, color, life, groundY) {
    return this._decal(shape, x, z, ry, color, life, groundY, (uni, u) => {
      uni.uFill.value = u;
      // Fade in over the first tenth — a decal that appears at full strength reads as a hit
      // that already happened — then brighten into the impact.
      uni.uAlpha.value = Math.min(1, u / 0.1) * (0.7 + u * u * 0.6);
    });
  }

  /**
   * Draw the ground an attack just covered — the player's own swing, skill or burst.
   *
   * Same geometry as `telegraph`, from the same `{kind, radius, hit, ...}` a handler tested
   * against, with the clock the other way round: a strike is at full extent the instant it
   * appears and then fades, because it reports rather than promises. `strength` scales the whole
   * thing down, since a five-hit combo drawing its reach at a wind-up's brightness would be the
   * loudest thing on the screen.
   *
   * This is the only picture that tells a player how far their own weapon reaches. Before it the
   * client drew a slash arc `weaponReach * 0.66` wide — a third of the ground `handleAttack`
   * actually sweeps — and one 7 m ring for every burst in the game, from nyx's 4 m to aurel's 8 m.
   */
  strike(shape, x, z, ry, color, life = 0.28, groundY = null, strength = 1) {
    return this._decal(shape, x, z, ry, color, life, groundY, (uni, u) => {
      uni.uFill.value = 1;
      uni.uAlpha.value = Math.min(1, u / 0.05) * Math.pow(1 - u, 1.5) * strength;
    });
  }

  /**
   * The hour, from `daylight()`'s phase: how brightly to light a decal lying on the ground.
   *
   * `game#_updateDaylight` hands this the same phase it hands `World.applyDaylight`, so the paint
   * and the ground it is painted on dim together. `0.16 + 0.84 * day` is the terrain's own
   * `0.10 + 0.90 * day` with a slightly higher floor (paint on a black field still has to be
   * paint), and it is exactly 1 at noon, where every calibrated pixel gate in `tools/` was
   * measured.
   *
   * Written to every decal material, not just to the ones drawn from here on: a decal drawn a
   * moment before the hour changed is still on the ground, and `legible-check` freezes the loop
   * mid wind-up — with the value baked in at creation, that frozen disc kept its noon brightness
   * into the 23:00 frame and was the brightest thing in a scene at luma 20.
   */
  applyDaylight(ph) {
    const day = Math.max(0, Math.min(1, ph?.day ?? 1));
    this.dayLight = 0.16 + 0.84 * day;
    for (const o of this.decals.free) o.material.uniforms.uLight.value = this.dayLight;
    for (const e of this.decals.live) e.o.material.uniforms.uLight.value = this.dayLight;
  }

  /** The shared mesh: geometry, uniforms and the lift onto the terrain. `anim(uniforms, u)`. */
  _decal(shape, x, z, ry, color, life, groundY, anim) {
    const mode = TELEGRAPH_MODES[shape?.kind];
    if (mode === undefined) return null;
    const R = shape.hit;
    // The box the shape lives in, and how far forward of the creature its centre sits. A swept
    // lane starts as a disc *around* the creature and ends one radius past its stopping point,
    // hence the R at both ends.
    const swept = shape.kind === 'lane' || shape.kind === 'aim';
    const span = swept ? shape.length / 2 : 0;
    // The outline straddles the boundary, so the quad has to reach `edge` past it or the mesh's
    // own rim cuts the outer half of the brightest line in the picture — worst on the summon
    // ring, whose band peaks a full RING_BAND outside `hit`.
    const edge = clamp(R * 0.06, 0.1, 0.34);
    const halfX = (shape.kind === 'ring' ? R + RING_BAND : R) + edge;
    const halfZ = (shape.kind === 'ring' ? R + RING_BAND : R + span) + edge;
    const o = this.decals.take(life, (m, u) => anim(m.material.uniforms, u));
    if (!o) return null;
    const uni = o.material.uniforms;
    uni.uColor.value.set(color);
    uni.uMode.value = mode;
    uni.uR.value = R;
    uni.uSpan.value = span;
    uni.uArc.value = shape.arc || 0;
    uni.uEdge.value = edge;
    uni.uLight.value = this.dayLight;
    // The shader measures a swept lane from the middle of its segment, so that is where the
    // mesh's origin goes: `span` metres in front of the creature. Everything else is centred
    // on the creature itself (a sector's apex included), and for those `span` is 0.
    const cy = Math.cos(ry), sy = Math.sin(ry);
    o.position.set(x + sy * span, 0, z + cy * span);
    o.rotation.set(0, ry, 0);

    // Vertices in local metres, lifted onto the height field at the world point each one lands
    // on once the object's own yaw is applied. y is absolute (the object sits at y = 0) so a
    // slope tilts nothing: the decal follows the ground instead of cutting into it.
    const pos = o.geometry.attributes.position;
    const arr = pos.array;
    for (let j = 0, i = 0; j <= DECAL_SEG; j++) {
      const lz = (j / DECAL_SEG - 0.5) * 2 * halfZ;
      for (let k = 0; k <= DECAL_SEG; k++, i += 3) {
        const lx = (k / DECAL_SEG - 0.5) * 2 * halfX;
        arr[i] = lx;
        arr[i + 2] = lz;
        arr[i + 1] = (groundY ? groundY(o.position.x + lx * cy + lz * sy, o.position.z - lx * sy + lz * cy) : 0) + 0.07;
      }
    }
    pos.needsUpdate = true;
    return [halfX, halfZ];
  }

  pillar(x, y, z, color, radius, height, life = 1.1) {
    this.pillars.take(life, (o, u) => {
      o.position.set(x, y, z);
      o.scale.set(radius * (1 - u * 0.35), height * Math.min(1, u * 3), radius * (1 - u * 0.35));
      o.material.color.set(color);
      o.material.opacity = (u < 0.15 ? u / 0.15 : Math.pow(1 - (u - 0.15) / 0.85, 1.6)) * 0.5;
    });
  }

  /* ------------------------------------------------------ composed effects -- */

  /** A weapon connecting with an enemy. */
  hit(x, y, z, element, crit = false, dir = null) {
    const col = elementColor(element);
    this.flash(x, y, z, col, crit ? 1.5 : 0.9, 0.14);
    this.burstSparks(x, y, z, col, crit ? 26 : 14, crit ? 7.5 : 5.0,
      { life: 0.42, size: crit ? 30 : 22, up: 0.35 });
    if (crit) {
      this.ring(x, y, z, col, 1.5, 0.34);
      this.shell(x, y, z, col, 0.85, 0.28);
    }
    if (dir) this.coneSparks(x, y, z, dir.x, dir.y ?? 0.2, dir.z, 0xfff2d0, crit ? 12 : 7, 8, 0.35);
  }

  /** Elemental reaction — bigger, and shaped per reaction family. */
  reaction(x, y, z, kind, element) {
    const col = elementColor(element);
    switch (kind) {
      case 'vaporize':
      case 'melt':
        // Amplifying: a hot bloom, not much debris.
        this.shell(x, y, z, 0xffb060, 2.0, 0.42);
        this.burstSparks(x, y, z, 0xffd090, 26, 5.5, { up: 1.0, grav: -2, life: 0.7, size: 30 });
        this.ring(x, y, z, 0xffc070, 2.4, 0.5);
        break;
      case 'overload':
        this.shell(x, y, z, 0xff6a3c, 2.8, 0.36);
        this.ring(x, y, z, 0xff8a4a, 3.6, 0.55, 1);
        this.burstSparks(x, y, z, 0xffa060, 46, 11, { up: 0.7, life: 0.75, size: 32 });
        this.flash(x, y + 0.5, z, 0xffd0a0, 4.0, 0.2);
        break;
      case 'superconduct':
        this.shell(x, y, z, 0xa878f0, 2.6, 0.4);
        this.burstSparks(x, y, z, 0xc8a8ff, 40, 9, { up: 0.4, life: 0.8, size: 26 });
        this.ring(x, y, z, 0xb890ff, 3.2, 0.6);
        break;
      case 'electroCharged':
        // Arcs rather than a bloom: thin, fast, many.
        for (let i = 0; i < 4; i++) {
          this.coneSparks(x, y + 0.4, z,
            Math.cos(i * 1.57), 0.2, Math.sin(i * 1.57), 0xc0a0ff, 9, 13, 0.15);
        }
        this.flash(x, y + 0.4, z, 0xd8c0ff, 2.2, 0.18);
        break;
      // 冻结. The key is `freeze` — `REACTIONS.freeze` in shared/data/elements.js, which is what
      // the server puts on the wire — and this branch spent its whole life spelled `frozen`,
      // i.e. the most common reaction in the game (水 onto 冰, or 冰 onto 水) fell through to
      // `default` and drew a generic bloom in the *incoming element's* colour. `tools/react-check.mjs`
      // now walks REACTIONS against the case labels below in both directions, and photographs
      // every one of them against the default branch's own frame so a shape that is only
      // reachable through `default` cannot pass.
      //
      // Shaped as a *formation*, which is what distinguishes it from `shatter` below: the shell
      // holds nearly a second, the motes drift up instead of falling (`grav` is positive-up in
      // `burstSparks`, so -3 is a slow sink and the frost hangs), and a slow ring closes in on
      // the target's feet rather than blowing outward.
      case 'freeze':
        this.shell(x, y, z, 0xa8e8ff, 1.7, 0.85);
        this.ring(x, y, z, 0xd8f4ff, 1.9, 0.7, 0.7);
        this.burstSparks(x, y, z, 0xd8f4ff, 26, 2.6, { up: 0.15, grav: -2, life: 1.15, size: 24, drag: 3.4 });
        this.flash(x, y + 0.3, z, 0xeafbff, 1.3, 0.22);
        break;
      case 'shatter':
        this.burstSparks(x, y, z, 0xd8f4ff, 40, 8, { up: 0.5, grav: -16, life: 0.8, size: 24, drag: 1.2 });
        this.flash(x, y, z, 0xffffff, 2.0, 0.12);
        break;
      case 'crystallize':
        this.burstSparks(x, y, z, 0xf0c860, 18, 4.0, { up: 0.9, grav: -6, life: 0.9, size: 26 });
        this.ring(x, y, z, 0xe8c060, 1.8, 0.5);
        break;
      case 'bloom':
      case 'swirl':
        this.shell(x, y, z, col, 2.4, 0.5);
        for (let i = 0; i < 3; i++) {
          this.ring(x, y + i * 0.5, z, col, 2.0 + i * 0.5, 0.55 + i * 0.08);
        }
        break;
      case 'radiance':
        this.pillar(x, y, z, 0xfff0c0, 1.4, 7, 0.8);
        this.shell(x, y + 0.8, z, 0xfff4d0, 2.4, 0.5);
        break;
      // Kept, and deliberately plain: a reaction key this switch has never heard of still gets a
      // bloom rather than nothing. It is also the control `react-check` shoots each authored key
      // against — so if a key ever loses its own case, its photograph collapses onto this one's.
      default:
        this.shell(x, y, z, col, 2.0, 0.4);
        this.burstSparks(x, y, z, col, 24, 6, { life: 0.6 });
    }
  }

  /** Elemental skill cast: a ground sigil that snaps out from under the caster. */
  cast(x, y, z, element, radius = 2.6) {
    const col = elementColor(element);
    this.ring(x, y, z, col, radius, 0.55);
    this.ring(x, y, z, col, radius * 0.6, 0.4);
    this.burstSparks(x, y + 0.3, z, col, 26, 4.2,
      { up: 1.4, grav: -1.2, life: 0.85, size: 24, spread: radius * 0.7 });
    this.flash(x, y + 0.9, z, col, 2.2, 0.2);
  }

  /**
   * Burst: the big one. Pillar + expanding shells + a swirl of motes.
   *
   * `radius` is the burst's own `burst.radius` — 4 m for nyx, 8 m for aurel, i.e. the ground the
   * sim really damages. Every ring in here used to be a constant, so those two were the same 7 m
   * picture and it was the truth for neither. The default is the middle of the authored range, so
   * a caller that has no character to ask still draws what this always drew.
   */
  burst(x, y, z, element, radius = 6) {
    const col = elementColor(element);
    this.pillar(x, y, z, col, radius * 0.4, 16, 1.2);
    this.shell(x, y + 1.2, z, col, radius * 0.85, 0.6);
    this.ring(x, y, z, col, radius, 0.85);
    this.ring(x, y, z, 0xffffff, radius * 0.62, 0.6);
    this.flash(x, y + 1.4, z, col, radius, 0.3);
    this.burstSparks(x, y + 1.0, z, col, 120, radius * 1.7,
      { up: 0.9, grav: -3.5, life: 1.4, size: 34, spread: 1.4, drag: 1.4 });
  }

  /** Healing: motes rising, no debris. */
  heal(x, y, z, amount = 1) {
    const n = Math.round(clamp(6 + amount * 0.02, 6, 26) * this.quality);
    C.set(0xa8f088);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const r = 0.35 + Math.random() * 0.5;
      this.sparks.spawn(
        x + Math.cos(a) * r, y + Math.random() * 0.4, z + Math.sin(a) * r,
        Math.cos(a) * 0.25, 1.4 + Math.random() * 1.3, Math.sin(a) * 0.25,
        C.r, C.g, C.b, 0.9 + Math.random() * 0.5, 20 + Math.random() * 14, 0.7, 1.4,
      );
    }
    this.ring(x, y, z, 0x9ce87c, 1.5, 0.7);
  }

  /** Shield application: a hexagonal-ish flash + ring. */
  shieldUp(x, y, z, element) {
    const col = elementColor(element);
    this.shell(x, y + 0.9, z, col, 1.5, 0.5);
    this.ring(x, y, z, col, 2.0, 0.6);
  }

  /** Enemy death: dissolve into rising motes, matching the aura element. */
  death(x, y, z, element, big = false) {
    const col = elementColor(element || 'earth');
    const n = big ? 90 : 40;
    this.burstSparks(x, y + (big ? 1.2 : 0.6), z, col, n, big ? 6 : 4,
      { up: 1.6, grav: -1.0, life: 1.3, size: big ? 34 : 24, spread: big ? 1.6 : 0.8, drag: 1.2 });
    this.ring(x, y, z, col, big ? 5 : 2.4, big ? 0.9 : 0.55);
    if (big) {
      this.pillar(x, y, z, col, 1.8, 12, 1.0);
      this.flash(x, y + 1.5, z, 0xffffff, 6, 0.3);
    }
  }

  /** Loot drop: a small gold spark fountain and a ring on the ground. */
  loot(x, y, z, rarity = 3) {
    const col = [0x9fb0c0, 0x8fd8a0, 0x6fb0f0, 0xb890f0, 0xffd15c][clamp(rarity - 1, 0, 4)];
    this.burstSparks(x, y + 0.3, z, col, 12 + rarity * 4, 3.2,
      { up: 1.5, grav: -6, life: 0.9, size: 22 });
    this.ring(x, y, z, col, 1.0 + rarity * 0.16, 0.5);
  }

  /** Level up / ascension. */
  levelUp(x, y, z) {
    this.pillar(x, y, z, 0xffe9a8, 1.6, 12, 1.4);
    this.ring(x, y, z, 0xffe9a8, 5.0, 0.9);
    this.burstSparks(x, y + 0.6, z, 0xfff0c0, 90, 6,
      { up: 1.8, grav: -1.2, life: 1.6, size: 30, spread: 1.0, drag: 1.0 });
  }

  /** Teleport in/out: two counter-rotating rings plus a column of motes. */
  teleport(x, y, z, outward = true) {
    const col = 0x8fe0f0;
    this.pillar(x, y, z, col, 1.2, 10, 0.9);
    this.ring(x, y, z, col, outward ? 3.2 : 1.0, 0.6);
    this.shell(x, y + 1.0, z, col, 2.2, 0.5);
    this.burstSparks(x, y + 0.5, z, col, 50, outward ? 7 : 2,
      { up: outward ? 1.2 : 2.6, grav: outward ? -4 : 1.5, life: 1.0, size: 26 });
  }

  /**
   * An enemy materialising: a ground ring, a low dome and a handful of rising motes,
   * scaled to the body and tinted by its element.
   *
   * Deliberately *not* `teleport()`, which is what this used to call. Fast travel's cyan
   * 12 m light column is right for the player arriving at a waypoint and wrong for a
   * hilichurl: `updateCamps` spawns a camp when any player comes within 110 m, so a walk
   * across Mondstadt lit a row of enormous cyan pillars on the horizon — for monsters that
   * had been standing there all along. Half a second, waist-high, and the same colour as
   * the thing arriving.
   */
  spawnIn(x, y, z, color, scale = 1, radius = 0.5) {
    const s = Math.max(0.6, Math.min(2.4, scale));
    const r = Math.max(0.3, Math.min(2.0, radius));
    // Shaped from the body's own hitbox, not from a constant. The first version put a 1.6 m
    // shell 1 m off the ground, which is *inside* a 3.6 m ruin guard and read as a lamp
    // switched on in its belly; the second put everything flat on the floor, where a camp on
    // a hillside buried it in the slope. So: a ring at twice the body's radius, a waist-high
    // collar of light no wider than the body, and dust that rises past the knees.
    this.ring(x, y, z, color, r * 2.2, 0.5);
    this.pillar(x, y, z, color, r * 1.05, 1.2 * s, 0.42);
    this.burstSparks(x, y + 0.15 * s, z, color, Math.round(12 * s), 2.0 * s,
      { up: 1.6, grav: -3.0, life: 0.55, size: 24, spread: r * 1.4, drag: 2.2 });
  }

  /** Footstep / landing dust, tinted by the ground colour. */
  dust(x, y, z, groundColor = 0x9a8f78, strength = 1) {
    const n = Math.round(4 + strength * 10);
    C.set(groundColor);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const s = (0.6 + Math.random() * 1.6) * strength;
      this.sparks.spawn(
        x + Math.cos(a) * 0.2, y + 0.06, z + Math.sin(a) * 0.2,
        Math.cos(a) * s, 0.4 + Math.random() * 0.8 * strength, Math.sin(a) * s,
        C.r * 0.8, C.g * 0.8, C.b * 0.8,
        0.35 + Math.random() * 0.4, 16 + Math.random() * 16, 3.4, -3,
      );
    }
  }

  /** Water splash / swimming. */
  splash(x, y, z, strength = 1) {
    this.ring(x, y, z, 0xa8dcf0, 1.4 * strength, 0.5);
    C.set(0xcfeaf8);
    const n = Math.round(10 * strength * this.quality);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const s = 1.4 + Math.random() * 2.4;
      this.sparks.spawn(x, y + 0.1, z,
        Math.cos(a) * s * 0.6, 2.2 + Math.random() * 2.6 * strength, Math.sin(a) * s * 0.6,
        C.r, C.g, C.b, 0.5 + Math.random() * 0.4, 18 + Math.random() * 14, 1.0, -14);
    }
  }

  /** Projectile trail — called each frame while a projectile is alive. */
  trail(x, y, z, element, rate = 1) {
    if (Math.random() > rate * this.quality) return;
    C.set(elementColor(element));
    this.sparks.spawn(x, y, z,
      (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6,
      C.r, C.g, C.b, 0.22 + Math.random() * 0.16, 15 + Math.random() * 10, 3.5, -1.2);
  }

  dispose() {
    this.sparks.dispose();
    for (const p of this.meshPools()) p.dispose();
  }
}
