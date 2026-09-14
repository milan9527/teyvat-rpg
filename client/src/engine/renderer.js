// Core renderer: WebGL2 setup, cel-shaded pipeline, HDR postprocessing stack.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

/** Colour grading + vignette + subtle chromatic edge, tuned for the anime look. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    // 1.14 double-counts: the biome and material albedos are already chosen
    // saturated for a cel look, and pushing them again drove grass to a blue channel
    // of 29/255 against a green of 141 — a green that no longer has anywhere to go
    // when a fire effect or a sunset needs to shift it.
    uSaturation: { value: 1.05 },
    uContrast: { value: 1.06 },
    uLift: { value: new THREE.Vector3(0.005, 0.008, 0.016) },
    uGain: { value: new THREE.Vector3(1.02, 1.0, 0.985) },
    uVignette: { value: 0.32 },
    uAberration: { value: 0.0016 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uFlash: { value: 0.0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    // 1 = the hit flash is a rim; 0 = the flat full-frame wash it used to be. A measurement
    // axis, like `uShape` on the impact quad: the probe turns it off to prove the reading it
    // just took is of the mask and not of the exposure.
    uFlashEdge: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uSaturation, uContrast, uVignette, uAberration, uFlash, uFlashEdge;
    uniform vec3 uLift, uGain, uFlashColor;
    uniform vec3 uTint;
    varying vec2 vUv;

    // 18% grey: the pivot both the contrast curve and the eye agree on. This pass runs
    // before tone mapping, so its input is scene-linear HDR, not 0..1 display values —
    // which is why the pivot is 0.18 and not 0.5.
    const float MID = 0.18;

    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      // Chromatic aberration grows toward the frame edge.
      vec2 off = d * uAberration * (0.4 + r2 * 2.2);
      vec3 c;
      c.r = texture2D(tDiffuse, vUv + off).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv - off).b;

      c = c * uGain + uLift;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // Saturating past 1.0 can push a channel below zero on an already-saturated colour,
      // and the power curve below is undefined there.
      c = max(mix(vec3(l), c, uSaturation), 0.0);
      // Contrast as a power around mid grey, *not* (c - 0.5) * k + 0.5. On scene-linear
      // input the affine form subtracts a flat (0.5 * (k - 1)) = 0.03 from every channel,
      // so everything below 0.028 linear — the entire shadow range of a dark scene — got
      // clipped to pure black by the max(c, 0.0) at the end. Measured with
      // tools/grade-ab.mjs on the abyss arena floor: luma 22.2 with nothing clipped at
      // uContrast 1.0, against luma 3.3 with 100% of red and green pinned to 0 at 1.06,
      // while the crystals moved by 8 luma. It was buying no highlight contrast and
      // costing every dark surface in the game. A power curve pivots the same midtones,
      // stays monotonic, and never crosses zero.
      c = MID * pow(c / MID, vec3(uContrast));
      c *= uTint;
      // Vignette
      c *= 1.0 - uVignette * smoothstep(0.18, 0.78, r2);
      // Hit flash: light from the rim, not a coat of paint over the picture.
      //
      // This line used to be mix(c, uFlashColor, uFlash) — a flat mix over every pixel. Measured
      // with uFlash pinned at 0.3 (.run/flood-lab.mjs, world visible, noon): one hit changed
      // 100 % of the viewport, 655360 px of 655360, and the middle of the frame moved as much as
      // the corner — 109,138,68 -> 146,134,172 in the centre against 111,125,92 -> 147,123,176 in
      // the corner. The character and the creature being fought are in that middle. Mixing *toward*
      // a saturated hue also throws the picture away rather than adding to it: a 水 hit left 953 px
      // of red at exactly 0.
      //
      // So the cue lives in the periphery — where the vignette already is, and where a real eye
      // notices motion it is not looking at — and it arrives as light, added on top, so every
      // surface underneath keeps its own colour. Grows with r2 as well as being masked by it, so
      // the corners carry the strongest of it — and the 0.42/1.35 pair is chosen so the whole
      // frame gains about as much light as the flood spent, redistributed rather than added to.
      vec3 flood = mix(c, uFlashColor, uFlash);
      vec3 rim = c + uFlashColor * uFlash * smoothstep(0.035, 0.26, r2) * (0.42 + 1.35 * r2);
      c = mix(flood, rim, uFlashEdge);
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }
  `,
};

export class Renderer {
  constructor(canvas, quality = 'high') {
    this.canvas = canvas;
    this.quality = quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // handled by SMAA/FXAA in the composer
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setClearColor(0x0a0a12, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Per zone, from `sky.exposure` — see `setExposure`.
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.15, 2600);
    this.camera.position.set(0, 8, -12);

    this.clock = new THREE.Clock();
    this.frame = 0;
    this.fps = 60;
    this.msFrame = 16.7;
    this._fpsFrames = 0;
    // Bumped once per completed measurement bucket. The quality governor has to sample
    // each bucket exactly once — reading `msFrame` every frame would feed the same number
    // thirty times and make three seconds of evidence look like ninety.
    this.perfSeq = 0;

    this.setupComposer();
    this.applyQuality(quality);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setupComposer() {
    const size = this.renderer.getSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 0,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.26, 0.62, 0.95);
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.smaa = new SMAAPass(size.x, size.y);
    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.smaa);
  }

  applyQuality(q) {
    this.quality = q;
    const dprCap = q === 'low' ? 1.0 : q === 'medium' ? 1.25 : q === 'ultra' ? 2.0 : 1.6;
    this.dprCap = dprCap;
    this.renderer.shadowMap.enabled = q !== 'low';
    const shadowSize = q === 'ultra' ? 4096 : q === 'high' ? 2048 : 1024;
    this.shadowSize = shadowSize;
    if (this.sun?.shadow) {
      this.sun.shadow.mapSize.set(shadowSize, shadowSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.bloom.enabled = q !== 'low';
    this.bloom.strength = q === 'ultra' ? 0.32 : q === 'low' ? 0.16 : 0.26;
    this.smaa.enabled = q === 'high' || q === 'ultra';
    this.grade.uniforms.uAberration.value = q === 'low' ? 0 : 0.0016;
    this.resize();
  }

  /**
   * Exposure, per zone, from `sky.exposure`.
   *
   * Not a taste knob and not a substitute for fixing albedo: the reason it exists is that
   * 龙脊雪山 is the one zone whose *whole* frame is a bright material. Snow at albedo 0.87 under
   * a 0.8 sun plus ambient lands near 1.0 in linear, which ACES rolls into a 9-count band —
   * measured: near ground rgb [192,209,227] with a p5..p95 of 204..213, i.e. the drift shader,
   * the sparkle and the slope shading were all being computed and then tone-mapped away, and
   * the ground came out the same value as its own sky so the horizon dissolved. Turning the
   * albedo down instead only moves the surface *and* everything standing on it toward grey
   * (measured: albedo 0.48 → luma 192, std still 3.6). Exposure is the correct lever because
   * the fault is the operating point of the curve, not the material: at 0.5 the same frame
   * measures std 14 and the drifts, the blue shadow under the character and the distant
   * slopes are all visible. Every other zone leaves this at 1.0 and is unaffected.
   */
  setExposure(v) {
    this.renderer.toneMappingExposure = v;
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap ?? 1.6);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.fxaa) {
      this.fxaa.material.uniforms.resolution.value.set(1 / (w * dpr), 1 / (h * dpr));
    }
    this.width = w; this.height = h;
  }

  /**
   * Trigger a hit flash in `color` — a rim of light in the periphery, see `GradeShader`.
   *
   * The strength decays in `render`, not in the game's `update`, so a *stopped* page keeps
   * whatever was left of it and photographs a tinted frame. Anything that freezes the game to
   * measure pixels has to zero `_flash` **and** `uFlash` (react-check's `__canon` does).
   */
  flash(color = 0xffffff, strength = 0.35) {
    this.grade.uniforms.uFlashColor.value.setHex(color);
    this._flash = strength;
  }

  render(dt) {
    this.frame++;
    // Decay the hit flash.
    if (this._flash > 0) {
      this._flash = Math.max(0, this._flash - dt * 2.6);
      this.grade.uniforms.uFlash.value = this._flash;
    }
    this.renderer.info.reset();
    this.composer.render(dt);

    // Wall clock, not `dt`: the caller clamps dt to 50 ms so one long hitch cannot
    // teleport the simulation, which means summing dt on a machine running at
    // 5 fps reports 20. The meter has to measure the frames the display actually
    // got, or it hides exactly the problem it exists to reveal.
    const now = performance.now();
    this._fpsFrames++;
    if (this._fpsMark === undefined) this._fpsMark = now;
    const span = now - this._fpsMark;
    if (span >= 500) {
      this.fps = Math.round((this._fpsFrames * 1000) / span);
      this.msFrame = +(span / this._fpsFrames).toFixed(1);
      this._fpsMark = now;
      this._fpsFrames = 0;
      this.perfSeq++;
    }
  }

  get drawCalls() { return this.renderer.info.render.calls; }
  get triangles() { return this.renderer.info.render.triangles; }
}
