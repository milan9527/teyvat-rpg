// Atmosphere: physically-flavoured gradient sky dome, sun disc, layered volumetric
// clouds, star field for night, plus the directional light + shadow rig and weather.

import * as THREE from 'three';

const SKY_FRAG = /* glsl */`
precision highp float;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uSunsetCol;
uniform float uGolden;
uniform vec3  uGroundCol;
uniform float uTurbidity;
uniform float uRayleigh;
uniform float uTime;
uniform float uCloudiness;
uniform float uWindSpeed;
uniform float uStorm;
uniform float uStars;
uniform float uNight;
varying vec3 vDir;

float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float hash31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x), mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vnoise(p); p = p * 2.07 + 1.3; a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  vec3 L = normalize(uSunDir);
  float mu = dot(d, L);

  // --- gradient with a Rayleigh-ish falloff -------------------------------
  float t = pow(clamp(1.0 - max(h, 0.0), 0.0, 1.0), 1.0 + uRayleigh * 1.6);
  vec3 sky = mix(uZenith, uHorizon, t);

  // Mie forward-scatter halo around the sun.
  float g = 0.76;
  float mie = pow(1.0 - g, 2.0) / (4.0 * 3.14159 * pow(1.0 + g*g - 2.0*g*mu, 1.5));
  sky += uSunColor * mie * (0.55 + uTurbidity * 0.035);

  // Horizon glow opposite the sun keeps the dome from looking flat.
  sky += uHorizon * pow(clamp(1.0 - abs(h), 0.0, 1.0), 6.0) * 0.22;

  // --- the golden hour is a *place* in the sky, not a tint on the whole dome ----
  // uZenith/uHorizon are functions of height alone, so any warmth they carry is behind you too:
  // with the sunset written into them the sky at 18:00 was uniformly orange, the anti-sun half
  // included, and the only thing making the sunward side warmer at all was the Mie halo above.
  // This is the term that knows where the sun is. Azimuth only — the full 3-D dot would drape the
  // band over a high sun as well, and it is gated on uGolden, which is 0 for every hour whose sun
  // is more than ~20 degrees off the horizon (exactly 0 at noon, so the calibrated frames and the
  // whole cloud block below are untouched).
  // (No backticks in here: this shader lives in a JS template literal.)
  if (uGolden > 0.001) {
    float az = dot(normalize(d.xz + vec2(1e-5)), normalize(L.xz + vec2(1e-5)));
    float toward = pow(clamp(az * 0.5 + 0.5, 0.0, 1.0), 2.6);
    float low = pow(clamp(1.0 - max(h, 0.0), 0.0, 1.0), 3.0);
    sky = mix(sky, uSunsetCol, uGolden * toward * low * 0.9);
  }

  // --- sun disc -----------------------------------------------------------
  float sunAng = acos(clamp(mu, -1.0, 1.0));
  float disc = 1.0 - smoothstep(0.021, 0.028, sunAng);
  float bloomRing = exp(-sunAng * 12.0) * 0.55;
  sky += uSunColor * (disc * 14.0 + bloomRing);

  // --- moon (night only) --------------------------------------------------
  // At night the light comes from -uSunDir: daylight() hands the DirectionalLight and the terrain
  // shader the sun's antipode, because a light below the horizon lights the underside of the ground
  // and every visible face goes black. But nothing was ever drawn *at* that direction, so the night
  // sky was a scene lit from above by an empty dome. This is the moon: a wider, far dimmer disc than
  // the sun's with a soft halo, gated on uNight -- which is also what finally gives that uniform
  // something to draw, instead of only thinning the clouds by 45%.
  // (No backticks in here: this shader lives in a JS template literal.)
  if (uNight > 0.001) {
    float mAng = acos(clamp(dot(d, -L), -1.0, 1.0));
    float mDisc = 1.0 - smoothstep(0.030, 0.038, mAng);
    float mGlow = exp(-mAng * 9.0) * 0.16;
    sky += vec3(0.80, 0.86, 1.0) * (mDisc * 2.6 + mGlow) * uNight;
  }

  // --- stars (night only) -------------------------------------------------
  if (uStars > 0.001 && h > -0.05) {
    vec3 sp = d * 260.0;
    float star = hash31(floor(sp));
    float tw = 0.6 + 0.4 * sin(uTime * 2.4 + star * 90.0);
    float s = smoothstep(0.9975, 0.9999, star) * tw;
    sky += vec3(0.85, 0.9, 1.0) * s * uStars * smoothstep(-0.02, 0.25, h);
  }

  // --- clouds: two parallax layers projected onto the dome ----------------
  if (h > 0.002) {
    float drift = uTime * uWindSpeed * 0.0035;
    // Project the ray onto a virtual cloud plane.
    vec2 p1 = d.xz / max(h + 0.06, 0.02) * 0.36 + vec2(drift, drift * 0.4);
    vec2 p2 = d.xz / max(h + 0.16, 0.02) * 0.19 + vec2(drift * 0.55, drift * 0.22);

    float base = fbm(p2, 5);
    float detail = fbm(p1 * 2.3, 5);
    float cover = mix(0.86, 0.28, clamp(uCloudiness, 0.0, 1.0));
    float lo = smoothstep(cover, cover + 0.30, base);
    float hi = smoothstep(cover + 0.06, cover + 0.42, base * 0.62 + detail * 0.5);

    // Fake self-shadowing: sample the density slightly toward the sun.
    vec2 toSun = normalize(L.xz + vec2(0.001)) * 0.055;
    float lit = smoothstep(cover, cover + 0.30, fbm(p2 + toSun, 4));
    float shade = clamp(1.0 - (lit - lo) * 1.6, 0.35, 1.0);

    // A deck lit by a sun on the horizon is the most saturated thing in the sky, and at 0.45 of a
    // near-white base it stayed pale grey while the dome behind it went orange — the clouds were
    // then what washed the sunset back out. uGolden is 0 at noon, so the calibrated cover is the
    // same picture it always was.
    vec3 cloudLit = mix(vec3(0.92, 0.94, 1.0), uSunColor * 1.15, 0.45 + 0.40 * uGolden);
    vec3 cloudDark = mix(vec3(0.42, 0.46, 0.60), uHorizon * 0.8, 0.5);
    vec3 cloud = mix(cloudDark, cloudLit, shade);
    // Silver lining toward the sun.
    cloud += uSunColor * pow(max(mu, 0.0), 8.0) * 0.55 * lo;

    float alpha = clamp(lo * 0.85 + hi * 0.4, 0.0, 1.0);
    // A storm is not just more cloud, it is *darker* cloud, and this is the term that says so.
    // uCloudiness alone moved the sky by 2.3 counts of luminance between a clear 蒙德 afternoon and
    // a downpour (188,205,221 vs 191,207,222): the coverage tripled, but cloudLit is very nearly
    // white and the clear sky at 15:00 is already lum 202, so an overcast dome and a blue one
    // photographed the same. uStorm is how far this zone's cloudiness has been pushed *past its own
    // authored baseline*, so it is exactly 0 on day 0 in every zone -- which is what lets a shader
    // that ~500 calibrated pixel assertions depend on grow a new term at all.
    // (No backticks in here: this shader lives in a JS template literal.)
    // Three counts of luminance, at first: 0.80 of a *linear* dome is about 3% of the sRGB byte
    // once ACES has compressed the shoulder, which is the same trap as every other display-operator
    // bug in this repo. A storm has to close the deck (alpha), drop the cloud's own colour toward
    // the shadowed grey, and dim the dome — all three, and hard enough to survive the tone curve.
    alpha = clamp(alpha + uStorm * 0.55 * (1.0 - alpha), 0.0, 1.0);
    cloud = mix(cloud, cloudDark * mix(1.0, 0.50, uStorm), uStorm);
    alpha *= smoothstep(0.0, 0.13, h);            // fade at the horizon
    alpha *= 1.0 - uNight * 0.45;
    sky = mix(sky, cloud, alpha);
    sky *= mix(1.0, 0.72, uStorm);
  } else {
    // Below the horizon: ground haze so the dome reads as enclosed.
    sky = mix(sky, uGroundCol, smoothstep(0.0, -0.22, h));
  }

  gl_FragColor = vec4(sky, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  // Keep the dome centred on the camera and always behind everything.
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.999999;
}
`;

/**
 * Vault shader for `indoor` zones.
 *
 * A dungeon lit by an open sky is the single thing that made every arena in this game
 * read as a flat desert: the sun disc, the clouds and the blue zenith all say "you are
 * outside" no matter what the floor is painted. This replaces the dome with a rock
 * ceiling — mottled, darkest at the zenith, warmed from below by the braziers on the
 * arena rim — and keeps the horizon on the zone's fog colour so the terrain wall still
 * dissolves into it. Same one draw call, no geometry.
 */
const VAULT_FRAG = /* glsl */`
precision highp float;
uniform vec3  uVaultCol;
uniform vec3  uHorizon;
uniform vec3  uGroundCol;
uniform vec3  uGlowCol;
uniform float uTime;
varying vec3 vDir;

float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x), mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vnoise(p); p = p * 2.11 + 1.7; a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);

  // Project the ray onto a ceiling plane so the mottling has perspective: a vault
  // painted in dome coordinates looks like wallpaper on a sphere. p is therefore a
  // position *on the ceiling* — features keep a constant size in metres and compress
  // toward the horizon, which is what makes a flat shader read as a surface overhead.
  vec2 p = d.xz / max(abs(h) + 0.10, 0.02);

  // Three scales, and the frequencies matter more than anything else here. This used to
  // be one fbm(p * 0.55, 5), i.e. its largest feature spanned ~2 units of p — while the
  // whole visible ceiling, from the wall line to the zenith, only spans p 0.5 to 2.2. One
  // blob over the entire frame is a gradient, and tools/vault-cam.mjs measured exactly
  // that: std 1.0 in 深渊试炼场, 2.3 in 黄金屋, 3.3 in 冰封洞窟, i.e. all three ceilings were
  // a flat wash the eye could only read as fog. Nothing about the colours was wrong.
  float coarse = fbm(p * 0.9, 3);      // metre-scale slabs
  float rough  = fbm(p * 3.2, 4);      // the grain
  float fine   = vnoise(p * 9.0);      // speckle, so large flat areas still break up

  // Bedding planes: bands of ~2 units in p, warped by the coarse layer so they wander
  // like rock instead of striping like a barcode, with a hard lower edge and a soft top.
  float seam = fract(p.x * 0.5 + coarse * 2.4 + rough * 0.35);
  float strata = smoothstep(0.50, 0.56, seam) * (1.0 - smoothstep(0.84, 0.95, seam));

  // Darkest overhead, opening out at the horizon line so the terrain silhouette has
  // something to sit against.
  float up = smoothstep(0.0, 0.62, h);
  vec3 rock = uVaultCol * (0.42 + coarse * 0.55 + rough * 0.50 + fine * 0.12);
  rock *= mix(1.26, 0.56, up);
  rock *= 1.0 - strata * 0.22;
  // Pockets: where the coarse layer dips the rock is hollowed out and holds shadow. This
  // is the one term that gives the ceiling depth rather than just texture.
  rock *= 1.0 - smoothstep(0.42, 0.14, coarse) * 0.34;
  // Floor in the vault's own colour, not black: three of those multipliers can land
  // together, and a region that reaches 0 in a channel comes out of the tonemap as a dead
  // hole with a hard edge — the same fingerprint as the contrast-before-tonemap bug.
  rock = max(rock, uVaultCol * 0.20);

  // Deep shadow where the wall meets the ceiling. Blending to the fog colour here
  // instead made the upper half of the screen the same value as the lit floor, so the
  // room had no ceiling line at all — a dungeon is dark above and lit below.
  vec3 springing = uVaultCol * (0.18 + rough * 0.34 + coarse * 0.18) * (1.0 - strata * 0.18);
  vec3 col = mix(springing, rock, up);

  // Firelight bounce along the rim, breathing slightly. This is what tells the eye
  // the light in the room comes from the braziers and not from above. Kept tight to
  // the horizon line (pow 7) so it is a glow off the wall, not an amber wash.
  float rim = pow(1.0 - abs(h), 7.0);
  float flicker = 0.86 + 0.14 * sin(uTime * 1.9 + rough * 6.0);
  col += uGlowCol * rim * 0.18 * flicker;

  // Below the horizon: haze, same as the outdoor dome.
  col = mix(col, uGroundCol, smoothstep(0.0, -0.24, h));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Write an sRGB triple into a `THREE.Color`. `setRGB` with an explicit colour space is the same
 * conversion `new THREE.Color(hex)` performs, which is what makes noon exact instead of merely
 * close: `daylight()` returns `hex / 255` unchanged at 12:00.
 */
const srgb = (col, rgb) => col.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);

export class Sky {
  constructor(zone, scene) {
    this.zone = zone;
    this.scene = scene;
    const s = zone.sky;
    const sunDir = new THREE.Vector3(...s.sunDir).normalize();

    this.indoor = !!zone.indoor;
    // The zone's *own* normal cloud cover, and the factor a storm dims the direct light by. Both
    // are the baseline by construction — `_baseCloud` is what day 0 returns and `stormDim` starts
    // at 1 — so nothing here moves a calibrated frame until the forecast pushes past the zone's
    // authored weather. See `applyWeather`.
    this._baseCloud = zone.weather?.cloudiness ?? 0.35;
    this.stormDim = 1;
    this._ph = null;

    this.uniforms = {
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color(s.sunColor) },
      uZenith: { value: new THREE.Color(s.zenithColor ?? s.ambientSky) },
      uHorizon: { value: new THREE.Color(s.horizonColor ?? s.fogColor) },
      // The sunset band's colour and how far the sun is into the golden hour. Both start where a
      // dome with no clock starts: the authored horizon, at zero strength.
      uSunsetCol: { value: new THREE.Color(s.horizonColor ?? s.fogColor) },
      uGolden: { value: 0 },
      uGroundCol: { value: new THREE.Color(s.ambientGround) },
      uTurbidity: { value: s.turbidity ?? 8 },
      uRayleigh: { value: s.rayleigh ?? 1.4 },
      uTime: { value: 0 },
      uCloudiness: { value: zone.weather?.cloudiness ?? 0.35 },
      uStorm: { value: 0 },                 // 0 at the zone's authored baseline, by construction
      uWindSpeed: { value: zone.weather?.windSpeed ?? 3 },
      uStars: { value: s.stars ?? 0 },
      uNight: { value: s.night ?? 0 },
      // Indoor only. The vault takes the zone's cliff colour so the ceiling is the
      // same stone as the walls, and the rim glow follows the braziers' colour.
      uVaultCol: { value: new THREE.Color(s.vaultColor ?? zone.terrain?.cliffColor ?? s.ambientGround) },
      uGlowCol: { value: new THREE.Color(s.vaultGlow ?? s.sunColor) },
    };

    const geo = new THREE.SphereGeometry(1, 48, 32);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: this.indoor ? VAULT_FRAG : SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(1500);
    scene.add(this.mesh);

    // --- lighting rig -------------------------------------------------------
    this.sun = new THREE.DirectionalLight(s.sunColor, s.sunIntensity ?? 1.6);
    this.sun.position.copy(sunDir).multiplyScalar(140);
    this.sun.castShadow = true;
    const cam = this.sun.shadow.camera;
    const extent = 78;
    cam.left = -extent; cam.right = extent;
    cam.top = extent; cam.bottom = -extent;
    cam.near = 1; cam.far = 420;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.045;
    this.sun.shadow.radius = 2.4;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(s.ambientSky, s.ambientGround, s.ambientIntensity ?? 0.9);
    scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(s.ambientSky, 0.22);
    scene.add(this.ambient);

    // Fill light from the opposite side keeps character shadow sides readable.
    // Indoors it comes from *below* instead: the dungeon sun is near-vertical, so every
    // face of the ceiling geometry (`buildVaultCeiling`) points away from it and the
    // whole vault sits on ambient alone — flat, whatever its albedo does. This is the
    // brazier bounce off the floor, and it is what makes the shell's facets, its ribs
    // and its pendants shade differently from each other.
    this.fill = new THREE.DirectionalLight(
      this.indoor ? (s.vaultGlow ?? s.ambientSky) : s.ambientSky,
      this.indoor ? 0.42 : 0.28,
    );
    // Offset from the focus point, fixed at construction because `update` needs the same
    // vector every frame. The indoor one is deliberately *not* straight down: the sun of a
    // dungeon is near-vertical, so -sunDir is near-vertical too, and a vault lit from
    // directly below has the same n.L on every facet — which is a uniform brightening, not
    // shading. tools/vault-cam.mjs measured exactly that: goldenHall's ceiling rose 75 -> 85
    // and the ceiling line, the step between the vault band and the floor band, collapsed
    // from 14 to 5. Normalising the horizontal part to a full 34 m against 50 m of drop puts
    // the bounce ~34 degrees off vertical, which is the same order as the shell's facet
    // tilt, so neighbouring facets land in different bands of the quantised ramp.
    const flat = Math.hypot(sunDir.x, sunDir.z) || 1;
    this.fillOff = this.indoor
      ? new THREE.Vector3(-sunDir.x / flat * 34, -50, -sunDir.z / flat * 34)
      : new THREE.Vector3(-sunDir.x * 70, 50, -sunDir.z * 70);
    this.fill.position.copy(this.fillOff);
    scene.add(this.fill);
    // The fill needs its own target for the same reason the sun does. A DirectionalLight
    // aims at `target`, which defaults to an object at the world origin, so a light whose
    // *position* follows the player while its target does not is a light whose direction
    // rotates as you walk: at the middle of a zone it lit from below, 60 m out it lit
    // sideways. `update` keeps this one on the focus point.
    scene.add(this.fill.target);

    scene.fog = new THREE.FogExp2(s.fogColor, s.fogDensity ?? 0.008);

    this.time = 0;
    this.weather = null;
    // Where the light comes *from*, which is the sun by day and the moon after dark. Separate
    // from `uSunDir` on purpose: the dome draws its disc where the sun really is (below the
    // horizon at night, so no disc), while the DirectionalLight has to stay overhead or every
    // surface in the world is lit from underneath the terrain.
    this.lightDir = sunDir.clone();
  }

  /**
   * Apply one instant of the day. `ph` is `shared/world/daylight.js`'s phase; colours arrive as
   * sRGB triples, which is the space the authored hex values are written in — so at noon every
   * `setRGB` below writes exactly what `new THREE.Color(hex)` wrote at construction.
   *
   * Indoor zones never call this: their vault has no sun.
   */
  applyDaylight(ph, dim = 1) {
    if (this.indoor) return;
    this._ph = ph;
    const u = this.uniforms;
    u.uSunDir.value.set(ph.sunDir[0], ph.sunDir[1], ph.sunDir[2]);
    this.lightDir.set(ph.lightDir[0], ph.lightDir[1], ph.lightDir[2]);
    srgb(u.uSunColor.value, ph.sunColor);
    srgb(u.uZenith.value, ph.zenith);
    srgb(u.uHorizon.value, ph.horizon);
    srgb(u.uSunsetCol.value, ph.sunsetColor);
    u.uGolden.value = ph.golden;
    u.uStars.value = ph.stars;
    u.uNight.value = ph.night;

    srgb(this.sun.color, ph.sunColor);
    // `dim` is the storm's, and it is applied *here* rather than in `applyWeather` on purpose: the
    // intensity is recomputed from `ph` every time, so a storm can arrive and leave a hundred times
    // without the factor compounding. Ambient is deliberately left alone — overcast light is
    // diffuse, so a storm takes away the sun, not the sky's bounce.
    this.sun.intensity = ph.sunIntensity * dim;
    srgb(this.hemi.color, ph.ambientSky);
    srgb(this.hemi.groundColor, ph.ambientGround);
    this.hemi.intensity = ph.ambientIntensity;
    srgb(this.ambient.color, ph.ambientSky);
    // The fill is the sky's own bounce, so it follows the ambient rather than the sun.
    srgb(this.fill.color, ph.ambientSky);
    this.fill.intensity = 0.28 * (0.34 + 0.66 * ph.day);
    if (this.scene.fog) srgb(this.scene.fog.color, ph.fogColor);
    // The light has to *move* here, not on the next update(). `lightDir` is only a stored vector;
    // what actually lights the world — and what centres the shadow frustum — is the
    // DirectionalLight's position. One frame of lag is invisible while the loop runs, but with the
    // loop stopped (every pixel probe, and 设置's frozen clock) the sun stayed wherever the
    // previous hour had put it: two runs of the same probe photographed the same meadow, one
    // sunlit (ground lum 106) and one in full shadow (68), from an identical camera.
    const t = this.sun.target.position;
    this._placeSun(t.x, t.y, t.z);
  }

  /**
   * Apply one instant of the weather: the two dome uniforms that had exactly one authored value per
   * zone, and the fog density. Fog *colour* belongs to `applyDaylight` (it tracks the far sky) and
   * fog *density* belongs here (it is how far you can see through the rain), so the two never write
   * the same field.
   */
  applyWeather(w) {
    if (this.indoor) return;
    this.uniforms.uCloudiness.value = w.cloudiness;
    this.uniforms.uWindSpeed.value = w.windSpeed;
    if (this.scene.fog) this.scene.fog.density = w.fogDensity;
    // How far past its own normal this zone's sky has been pushed, in 0..1. 蒙德 authored 0.35 and
    // its downpour reaches 0.881, so a 蒙德 storm is 0.82 of the way to overcast; 龙脊雪山 authored
    // 0.72, so the same *absolute* cloudiness is a milder departure there. That is the same rule
    // the rest of this feature follows — a storm is measured against the zone it falls on — and it
    // is what makes `uStorm` and `stormDim` exactly 0 and 1 on day 0.
    const over = Math.max(0, Math.min(1, (w.cloudiness - this._baseCloud) / Math.max(0.05, 1 - this._baseCloud)));
    this.uniforms.uStorm.value = over;
    this.stormDim = 1 - 0.35 * over;
  }

  /** The sun is a direction, so it is placed 130 m up-light of whatever it is aimed at. */
  _placeSun(focusX, focusY, focusZ) {
    const dir = this.lightDir;
    this.sun.position.set(focusX + dir.x * 130, focusY + dir.y * 130, focusZ + dir.z * 130);
    this.sun.target.position.set(focusX, focusY, focusZ);
    this.sun.target.updateMatrixWorld();
  }

  /** Keep the sky dome and shadow frustum following the player. */
  update(dt, camera, focusX, focusY, focusZ) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.mesh.position.copy(camera.position);

    this._placeSun(focusX, focusY, focusZ);
    // Keep the indoor fill under the player: a light that follows from +50 would put the
    // uplift back on the floor and take it off the ceiling as soon as the player moves.
    this.fill.position.set(focusX + this.fillOff.x, focusY + this.fillOff.y, focusZ + this.fillOff.z);
    this.fill.target.position.set(focusX, focusY, focusZ);
    this.fill.target.updateMatrixWorld();
  }

  setShadowQuality(size, enabled) {
    this.sun.castShadow = enabled;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  dispose() {
    this.mesh.removeFromParent();
    this.material.dispose();
    this.mesh.geometry.dispose();
    [this.sun, this.sun.target, this.hemi, this.ambient, this.fill, this.fill.target]
      .forEach((l) => l.removeFromParent());
  }
}

/* ------------------------------------------------------------------ weather -- */

/**
 * How each storm draws. `density` multiplies the quality tier's point budget — a blizzard is the
 * same storm with more of it — and `snow` reproduces the authored look of 龙脊雪山 exactly.
 */
const STORM_LOOK = {
  // `maxPx` and `add` are rain's, and they exist because the first screenshot of a 蒙德 downpour was
  // a meadow behind fifty white *rectangles*: the point size is `uSize * 300 / distance`, so a drop
  // two metres from the camera drew 300 px across, and additive white on a bright overcast sky
  // blew every one of them to paper. Snow keeps `maxPx: 0` (no ceiling) and additive blending
  // deliberately — 龙脊雪山's snowfall is the look ~90 calibrated pixel assertions were measured on,
  // and rain has never appeared in a calibrated frame, so it is the only one free to change.
  rain:     { speed: 26.0, size: 1.5, color: 0xbcd6ff, streak: 1.0, opacity: 0.55, wind: 1.4, density: 1.0, maxPx: 15, add: false },
  snow:     { speed: 3.2,  size: 2.6, color: 0xffffff, streak: 0.0, opacity: 0.85, wind: 1.4, density: 1.0, maxPx: 0, add: true },
  blizzard: { speed: 6.4,  size: 2.4, color: 0xf2f8ff, streak: 0.3, opacity: 0.90, wind: 9.0, density: 1.6, maxPx: 0, add: true },
};

/**
 * GPU particle weather (rain / snow) as a single instanced points cloud that
 * follows the camera. Cheap and reads well with the stylised look.
 */
export class Weather {
  /**
   * `type` is the heaviest storm this zone can ever reach (`maxStorm(zone)`), not what is falling
   * now: rain and snow differ only in uniforms, so one allocation can *become* either, and 蒙德 —
   * whose baseline is `clear` — still needs the buffer for its rainy days. What falls right now is
   * `setStorm`, called every time the forecast moves.
   */
  constructor(type, scene, count = 4000) {
    this.type = type;
    this.scene = scene;
    this.storm = { type: 'clear', intensity: 0 };
    this._qBase = count;        // the quality governor's target for a normal storm
    if (type !== 'rain' && type !== 'snow' && type !== 'blizzard') { this.mesh = null; return; }

    const isSnow = type !== 'rain';
    const n = this._n(count);
    this.count = n;             // allocated; setCount can draw fewer, never more
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    const box = 44;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * box * 2;
      pos[i * 3 + 1] = Math.random() * box;
      pos[i * 3 + 2] = (Math.random() - 0.5) * box * 2;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOrigin: { value: new THREE.Vector3() },
        uBox: { value: box },
        uSpeed: { value: isSnow ? 3.2 : 26.0 },
        uSize: { value: isSnow ? 2.6 : 1.5 },
        uColor: { value: new THREE.Color(isSnow ? 0xffffff : 0xbcd6ff) },
        uStreak: { value: isSnow ? 0.0 : 1.0 },
        uWind: { value: new THREE.Vector2(type === 'blizzard' ? 9 : 1.4, 0.6) },
        uOpacity: { value: isSnow ? 0.85 : 0.5 },
        uMaxPx: { value: isSnow ? 0.0 : 15.0 },   // 0 = no ceiling; see STORM_LOOK
      },
      vertexShader: /* glsl */`
        uniform float uTime, uBox, uSpeed, uSize, uMaxPx;
        uniform vec3 uOrigin;
        uniform vec2 uWind;
        attribute float aSeed;
        varying float vSeed;
        void main() {
          vSeed = aSeed;
          vec3 p = position;
          // Fall + wrap within a box that follows the camera.
          float fall = uTime * uSpeed * (0.7 + aSeed * 0.6);
          p.y = mod(p.y - fall, uBox);
          p.x = mod(p.x + uTime * uWind.x * (0.5 + aSeed) + uBox, uBox * 2.0) - uBox;
          p.z = mod(p.z + uTime * uWind.y * (0.5 + aSeed) + uBox, uBox * 2.0) - uBox;
          // Snow sway
          p.x += sin(uTime * 1.7 + aSeed * 40.0) * (1.0 - step(10.0, uSpeed)) * 0.9;
          vec4 mv = modelViewMatrix * vec4(p + uOrigin, 1.0);
          gl_Position = projectionMatrix * mv;
          float px = uSize * (300.0 / -mv.z) * (0.6 + aSeed * 0.8);
          // A ceiling, not a scale: uSize still separates rain from snow at every normal distance,
          // and the clamp only catches the handful of drops inside a couple of metres, which are
          // the ones that drew as slabs. uMaxPx = 0 means "no ceiling" (snow keeps its authored law).
          gl_PointSize = uMaxPx > 0.0 ? min(px, uMaxPx) : px;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uStreak, uOpacity;
        varying float vSeed;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          // Rain draws as a vertical streak, snow as a soft disc. Scaling y *down* stretched the
          // disc to fill the sprite's full height while leaving it full width — a rounded slab, not
          // a streak. A streak is narrow: squeeze x hard, and keep most of the height. Both factors
          // collapse to 1.0 at uStreak = 0, so snow's disc is bit-for-bit what it was.
          c.x *= mix(1.0, 5.0, uStreak);
          c.y *= mix(1.0, 0.62, uStreak);
          float d = length(c);
          float a = smoothstep(0.5, 0.06, d) * uOpacity;
          if (a < 0.02) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.Points(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 900;
    scene.add(this.mesh);
  }

  /** A blizzard is the same storm with more of it. */
  _n(base) { return this.type === 'blizzard' ? (base * 1.6) | 0 : base; }

  /**
   * Thin the storm without rebuilding it — `setDrawRange` works because every point is
   * independent, so the first k of them are a complete, evenly distributed storm. This is
   * the one weather lever the quality governor can pull mid-session; Dragonspine's blizzard
   * is 6400 additively blended points, which on a weak machine is real fill cost.
   *
   * It can only ever draw fewer than were allocated at construction, so a zone entered on
   * 流畅 keeps a light storm even if the tier climbs back — the next zone build reallocates.
   */
  setCount(base) {
    this._qBase = base;
    this._draw();
  }

  /**
   * What is falling, and how hard. `type` is anything `WEATHER_TYPES` names — a non-precipitating
   * one (clear / cloudy / none) draws nothing without touching the buffer, which is how a zone
   * whose forecast is dry today costs one empty draw call instead of a rebuild.
   *
   * The uniforms for `snow` are the constructor's old snow branch to the digit, because 龙脊雪山's
   * baseline *is* snow and day 0 of the forecast has to be the zone as it was authored.
   */
  setStorm(type, intensity = 1) {
    this.storm = { type, intensity: Math.max(0, Math.min(1, intensity)) };
    const look = STORM_LOOK[type];
    if (this.mesh && look) {
      const u = this.material.uniforms;
      u.uSpeed.value = look.speed;
      u.uSize.value = look.size;
      u.uColor.value.setHex(look.color);
      u.uStreak.value = look.streak;
      u.uWind.value.set(look.wind, 0.6);
      // Opacity carries the last of a shower on its way out: the count is quantised to whole
      // points, so fading only by count makes the last hundred flakes pop off together.
      u.uOpacity.value = look.opacity * Math.min(1, 0.35 + 0.65 * this.storm.intensity);
      u.uMaxPx.value = look.maxPx;
      // Additive is right for snow against a dark sky and wrong for rain against a bright one.
      const blend = look.add ? THREE.AdditiveBlending : THREE.NormalBlending;
      if (this.material.blending !== blend) { this.material.blending = blend; this.material.needsUpdate = true; }
    }
    this._draw();
  }

  /** One place decides the draw range, because two levers (quality, storm) both move it. */
  _draw() {
    if (!this.mesh) return;
    const look = STORM_LOOK[this.storm.type];
    const dens = look ? this.storm.intensity * look.density : 0;
    const want = Math.floor(Math.max(0, this._qBase) * dens);
    this.mesh.geometry.setDrawRange(0, Math.max(0, Math.min(this.count, want)));
  }

  update(dt, camera) {
    if (!this.mesh) return;
    this.material.uniforms.uTime.value += dt;
    this.material.uniforms.uOrigin.value.copy(camera.position);
    this.material.uniforms.uOrigin.value.y -= 14;
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
