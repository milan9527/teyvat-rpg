// Cel-shaded material system.
//
// Genshin's look comes from a few specific things, all reproduced here:
//   * hard-stepped diffuse ramp (2-3 bands) instead of smooth lambert
//   * a warm/cool shadow tint rather than plain darkening
//   * a fresnel rim light that reads as the character silhouette
//   * a tight specular lobe with a stepped edge (the "anime highlight")
//   * inverted-hull outlines for characters, screen-thin
//
// Implemented by patching MeshStandardMaterial via onBeforeCompile so we keep
// three.js shadow maps, fog, tone mapping and instancing for free.

import * as THREE from 'three';

const TOON_PARS = /* glsl */`
uniform float uBands;
uniform float uRampSoft;
uniform vec3  uShadowTint;
uniform float uRimStrength;
uniform float uRimWidth;
uniform vec3  uRimColor;
uniform float uSpecStep;
uniform float uSpecSharp;
uniform vec3  uSpecColor;
uniform float uEmissivePulse;
uniform float uElementGlow;
uniform vec3  uElementColor;
uniform float uElementWash;
uniform float uTime;
uniform float uHitFlash;
uniform float uDissolve;
uniform float uSway;
uniform float uRootDark;
uniform float uRootH;
uniform float uMottle;
uniform float uMottleScale;
uniform float uMottleSpeck;
uniform float uShadowFloor;
uniform float uRampFloor;
uniform float uFillStrength;
varying vec3 vToonNormal;
varying vec3 vToonView;
varying vec3 vToonWorld;
varying float vRootUp;

// Cheap 3D value noise, for surface detail no vertex attribute can carry: an
// icosahedron boulder has a few hundred vertices over six metres, so anything finer
// than a metre has to come from the fragment shader.
float toonHash(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}
float toonVN(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(toonHash(i), toonHash(i + vec3(1, 0, 0)), f.x),
        mix(toonHash(i + vec3(0, 1, 0)), toonHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(toonHash(i + vec3(0, 0, 1)), toonHash(i + vec3(1, 0, 1)), f.x),
        mix(toonHash(i + vec3(0, 1, 1)), toonHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
`;

const TOON_VERT = /* glsl */`
  vToonNormal = normalize(mat3(modelMatrix) * objectNormal);
  vec4 toonWorld = modelMatrix * vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    toonWorld = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
    vToonNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
  #endif
  vToonWorld = toonWorld.xyz;
  vToonView = normalize(cameraPosition - toonWorld.xyz);
  // Height up the plant, in its own object space, for the root-darkening gradient.
  // Object space, not world: the whole point is that it means the same thing on a
  // tuft standing in a valley as on one up a hill.
  vRootUp = clamp(transformed.y / max(uRootH, 1e-4), 0.0, 1.0);

`;

/**
 * Wind sway, shared by the lit material and its outline shell.
 *
 * Bending in the *vertex* shader is the only affordable way to move a hundred
 * thousand grass blades, and taking the phase from world position is what keeps a
 * meadow from waving in unison like one rigid object: neighbouring tufts sit a
 * fraction of a wavelength apart, so the motion crosses the field as a gust.
 * Weighted by local height, so roots stay planted and only tips travel.
 *
 * Inserted before <project_vertex> in both materials — the outline shell has to
 * run the identical displacement or the black hull stays behind while the leaf
 * moves out from under it.
 */
const SWAY_VERT = /* glsl */`
  if (uSway > 0.0) {
    vec4 swayW = modelMatrix * vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      swayW = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
    #endif
    float windPh = swayW.x * 0.42 + swayW.z * 0.31 + uTime * 1.7;
    float gust = 0.72 + 0.28 * sin(windPh * 0.23 - uTime * 0.4);
    float amt = uSway * gust * max(0.0, transformed.y);
    transformed.x += sin(windPh) * amt;
    transformed.z += sin(windPh * 0.77 + 1.3) * amt * 0.55;
  }
`;

// Replaces the final colour assembly.
const TOON_FRAG = /* glsl */`
  vec3 toonN = normalize(vToonNormal);
  vec3 toonV = normalize(vToonView);

  // --- primary light direction ------------------------------------------------
  vec3 L = vec3(0.4, 0.82, 0.4);
  vec3 lightCol = vec3(1.0);
  #if NUM_DIR_LIGHTS > 0
    // Back into world space. three.js gives the shader every light in *view* space — the
    // directional block in WebGLLights.js ends with .transformDirection(viewMatrix) — while
    // vToonNormal is mat3(modelMatrix) * objectNormal, i.e. a world normal. Dotting the two
    // as they arrive is the same as lighting the scene with the sun rotated by the camera's
    // own rotation, so the apparent sun swings round at *twice* the rate the player orbits:
    // tools/light-space.mjs put a sphere in Mondstadt and measured left-minus-right luma of
    // +11, -8.6, +10.9, -19.6 at azimuths 0, 90, 180, 270 — a period of 180 degrees, which
    // is a signature nothing else produces, and which agrees with the real sun at exactly
    // half the angles by coincidence. viewMatrix is orthonormal, so right-multiplying by
    // mat3(viewMatrix) applies its transpose, which is its inverse.
    L = normalize(directionalLights[0].direction * mat3(viewMatrix));
    // Intensity arrives baked into the colour uniform (three.js dropped legacy
    // lights), so a sun set to 2.5 for the physical path multiplies a cel albedo straight past white —
    // which is exactly why the characters read as glowing cut-outs against ground
    // that the terrain shader lights at 1.0. Cel shading wants the sun's *hue* plus a
    // compressed response to its strength: unit output at intensity 1, and only
    // +18 % by 2.5, so a "brighter" zone gains contrast rather than losing colour.
    vec3 dirCol = directionalLights[0].color;
    float dirMax = max(max(dirCol.r, dirCol.g), dirCol.b);
    lightCol = (dirCol / max(dirMax, 1e-4))
      * (0.5 + 0.5 * min(dirMax, 1.0) + 0.12 * max(dirMax - 1.0, 0.0));
  #endif

  float ndl = dot(toonN, L);
  // Quantised diffuse ramp with a soft-but-narrow transition between bands.
  float lit = ndl * 0.5 + 0.5;
  float bands = max(uBands, 1.0);
  float q = floor(lit * bands) / bands;
  float frac = fract(lit * bands);
  float smoothed = q + smoothstep(0.5 - uRampSoft, 0.5 + uRampSoft, frac) / bands;
  float ramp = clamp(smoothed, 0.0, 1.0);

  // Shadow map attenuation folded into the ramp so cast shadows also read as cels.
  float shadowAtten = 1.0;
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
    shadowAtten = getShadow(
      directionalShadowMap[0], directionalLightShadows[0].shadowMapSize,
      directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias,
      directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0]
    );
    shadowAtten = mix(1.0, smoothstep(0.15, 0.65, shadowAtten), 0.92);
  #endif
  // The floor is per-material, because for dense foliage a hard 0.14 is three darkeners
  // deep. A spruce self-shadows almost everywhere — every whorl shades the one beneath —
  // so the needle mass takes foliageTone's baked AO, then its already-dark albedo, then
  // this floor, all multiplied. Measured in the Mondstadt gameplay shot the pine came back
  // at luma 38-52 against ground at 126, with its red channel at 4 out of an albedo red of
  // 47: a nine-metre tree rendering as a black cone in a bright green field. Cel shading
  // wants a shadowed leaf to stay a dark *green*, not go to black, so foliage lifts this to
  // around 0.45 and keeps its hue (see leafMat in gfx/props.js). Opaque solids keep 0.14 —
  // a boulder's cast shadow should be deep.
  ramp = min(ramp, mix(uShadowFloor, 1.0, shadowAtten));

  // Floor on the deepest cel band, per-material — and the one term that was missing from
  // four earlier attempts at the "foliage goes black" problem, all of which worked on
  // uShadowTint or uShadowFloor instead.
  //
  // lit = ndl * 0.5 + 0.5 with two bands sends every facet more than ~130 degrees from
  // the sun to ramp *exactly* 0, which is shadowCol with no diffuse term at all. On a
  // sphere-based foliage lobe that is the whole underside. Measured on an isolated bush
  // (tools/prop-cam.mjs bush, then tools/pixstd.mjs): the lit top read luma 114 against
  // grass at 117 — correct — while the lower mass read 17 with a p95 of 43, i.e. uniformly
  // near-black rather than merely shaded. Reading the composition backwards, such a facet
  // keeps only albedo * (uShadowTint + 0.24 * hemiGround + 0.32 * ambient), and the
  // hemisphere term is the *ground* colour at n.y = -1, the darkest source in the rig; the
  // baked darkeners (foliageTone's AO, uRootDark) then multiply on top of that.
  //
  // A cel-shaded plant should bottom out at a dark saturated green, so foliage lifts this
  // (see leafMat in gfx/props.js). Opaque solids keep 0: a boulder's dark side has one
  // light source and should be allowed to read as unlit.
  ramp = max(ramp, uRampFloor);

  vec3 albedo = diffuseColor.rgb;
  // Occlusion inside a plant's own canopy.
  //
  // Grass has no usable cast shadow: the sun's map is 2048 texels over 156 m, so a
  // texel is 7.6 cm and a 3 cm blade is invisible to it. But the reason a real meadow
  // does not read as a flat green sheet is that almost no light reaches the bottom of
  // it, and that gradient is a property of the geometry, not of the light — so it can
  // be baked from the vertex's own height above the root and cost nothing.
  albedo *= mix(1.0 - uRootDark, 1.0, vRootUp);

  // Surface mottling, in world space.
  //
  // Measured on the Mondstadt plain: the whole sunlit face of a six-metre boulder came
  // back at sRGB 144-152 — a 5 % spread across four metres of rock, which is nothing.
  // Baking tone per vertex (stoneTone in gfx/props.js) fixed the *form*, the base-versus-crown and
  // face-to-face reading, but it cannot reach the scale that says "granite": an
  // icosahedron of that size has a vertex every 80 cm. So the 10-50 cm band comes from
  // here instead. Faded out past 18 m, for the same reason the terrain fades its fine
  // grain — procedural noise has no mip chain, and left on it turns into a crawling
  // film at distance rather than detail.
  //
  // Grain, not pattern. Two earlier versions of this block tried to draw *cracks* with a
  // ridged fold of the same field (1 - |2n-1|, thresholded), and both times the boulder
  // came back painted: thresholding a ridge picks out a level set of the noise, and a
  // level set of a smooth scalar field is a family of closed loops of near-uniform
  // width. Photographed at 7 m and 16 m it read as a topographic maze — the third
  // variant of the same camouflage failure, tightening the band only made the lines
  // thinner and neater. Real stone has no such lines at this scale; what it has is
  // speckle. So all three octaves stay in the mottle, weighted toward the fine end, and
  // the crack term is gone.
  if (uMottle > 0.0) {
    float mDist = length(cameraPosition - vToonWorld);
    float near = 1.0 - smoothstep(18.0, 55.0, mDist);
    if (near > 0.002) {
      vec3 wp = vToonWorld * uMottleScale;
      // At uMottleScale 1.6 these sit at roughly 31 / 14 / 7 cm. Nothing below the
      // first: on a three-metre boulder a 60 cm lobe is five cycles across the whole
      // rock, which draws continents, and that was the original camouflage complaint.
      float m = toonVN(wp * 2.0) * 0.28 + toonVN(wp * 4.6) * 0.34 + toonVN(wp * 9.5) * 0.38;
      // uMottle is NOT the resulting brightness swing, and mis-reading it as one has now
      // cost two rounds of pointless retuning. The three octaves are averaged, so their
      // spreads add in quadrature: each toonVN has a standard deviation near 0.2, and
      // 0.2*sqrt(0.28^2+0.34^2+0.38^2) is about 0.116. The *2.0 doubles that, so the
      // multiplier's standard deviation is roughly 0.23*uMottle — a quarter of what the
      // number looks like. At uMottle 0.15 that is a ±3.5 % wobble on a mid green, i.e.
      // three or four 8-bit levels, which is why the oak crown photographed dead flat with
      // the uniform verifiably set (tools/mat-probe.mjs). Rule of thumb: divide by four to
      // get the visible swing, so foliage at 0.48 reads as about ±11 %.
      albedo *= 1.0 + (m - 0.5) * 2.0 * uMottle * near;
      // Mica: a sparse scatter of bright specks, one octave finer again (~3 cm) and
      // clipped to the top of its range so it stays specks rather than a second layer of
      // blotches. Faded by 9 m, because past that a 3 cm feature is under a pixel and all
      // it can do is shimmer. Off for foliage (uMottleSpeck 0): leaves want the grain but
      // not the glitter, and a canopy full of bright dots reads as blossom.
      float sp = uMottleSpeck * (1.0 - smoothstep(3.0, 9.0, mDist));
      if (sp > 0.002) {
        float g = toonVN(wp * 21.0 + 7.1);
        albedo *= 1.0 + smoothstep(0.72, 0.97, g) * uMottle * 1.1 * sp;
      }
    }
  }
  // Shadowed areas shift hue instead of merely darkening — key to the painted look.
  vec3 shadowCol = albedo * uShadowTint;
  vec3 col = mix(shadowCol, albedo * lightCol, ramp);

  // Ambient / sky bounce, kept flat.
  vec3 skyAmbient = vec3(0.0);
  #if NUM_HEMI_LIGHTS > 0
    skyAmbient = mix(hemisphereLights[0].groundColor, hemisphereLights[0].skyColor, toonN.y * 0.5 + 0.5);
  #endif
  // Deliberately weak: the banded diffuse term above already carries most of the
  // energy, so a strong ambient add on top just washes the bands out.
  col += albedo * skyAmbient * 0.24;
  col += albedo * ambientLightColor * 0.32;

  // --- second directional light, as an opt-in fill ----------------------------
  // The ramp above reads directionalLights[0] and nothing else, so the fill light the
  // rig has always carried (Sky.fill in gfx/sky.js, commented "keeps character shadow
  // sides readable") has never reached a single toon surface in this game: an authored knob
  // with no consumer. It is switched on per material rather than globally because it
  // matters for exactly one class of surface — a dungeon ceiling, whose every face
  // points away from the near-vertical dungeon sun and so has no diffuse term at all to
  // shade with — and because relighting every prop in six measured zones is not a
  // side effect a ceiling should have.
  //
  // Quantised in three steps like the primary ramp, which is the point: the shell's
  // facets tilt by up to 20 degrees, so they land in different steps and the vault gets
  // cel *bands* from below instead of one flat ambient value.
  //
  // directionalLights[i].direction arrives in *view* space (WebGLLights.js calls
  // .transformDirection(viewMatrix) on it), while toonN is a world normal, so the two have
  // to be brought into one space or the shading swings around as the camera orbits.
  // viewMatrix is orthonormal, hence dir * mat3(viewMatrix) is the inverse rotation and
  // gives the direction back in world space. (The primary ramp above does *not* do this —
  // see tools/light-space.mjs, which measures what that costs.)
  #if NUM_DIR_LIGHTS > 1
    if (uFillStrength > 0.001) {
      vec3 fillL = normalize(directionalLights[1].direction * mat3(viewMatrix));
      float fndl = max(dot(toonN, fillL), 0.0);
      col += albedo * directionalLights[1].color * (floor(fndl * 3.0) / 3.0) * uFillStrength;
    }
  #endif

  // --- point lights (torches, elemental VFX) ---------------------------------
  #if NUM_POINT_LIGHTS > 0
    for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
      // pointLights[i].position is in view space too (WebGLLights.js applies viewMatrix to
      // it), and subtracting a world position from it does not merely aim the light wrongly
      // — it makes dist a number of the order of the fragment's world coordinate. Every
      // torch in this game therefore attenuated to nothing anywhere the world origin was
      // far away, and its falloff changed as the camera moved. Undo the view transform:
      // rotation by the transpose, then back off the camera's world position.
      vec3 lightWorld = pointLights[i].position * mat3(viewMatrix) + cameraPosition;
      vec3 lv = lightWorld - vToonWorld;
      float dist = length(lv);
      float att = pow(clamp(1.0 - dist / max(pointLights[i].distance, 0.001), 0.0, 1.0), 2.0);
      float pndl = max(dot(toonN, normalize(lv)), 0.0);
      float pq = floor(pndl * 3.0) / 3.0;
      col += albedo * pointLights[i].color * pq * att * 1.1;
    }
  #endif

  // --- stepped specular ------------------------------------------------------
  // A mix, not an add. The add was unbounded: a plate at the specular angle got the whole of
  // uSpecColor laid on top of its already-lit top band, and uSpecSharp 0.88 is an exponent of
  // ~194 -- a pinpoint on anything curved and all-or-nothing on a flat facet, because one normal
  // covers the entire face. The ruin guard's forearm (a lofted rect) therefore went to a flat,
  // hueless 238 over 3.3% of its silhouette at one azimuth, bloom halo and all, while every curved
  // part of the same model was fine (enemy-cam.mjs ruinGuard --yaw -2.4 is the repro).
  // Mixing *toward* the highlight colour cannot exceed it, so the brightest a facet can go is the
  // material's own reflection -- and for metal that reflection is now hued, which is both the
  // physics and what metalMaterial's comment always claimed.
  vec3 H = normalize(L + toonV);
  float spec = pow(max(dot(toonN, H), 0.0), mix(8.0, 220.0, uSpecSharp));
  float specStep = smoothstep(uSpecStep, uSpecStep + 0.06, spec);
  col = mix(col, uSpecColor, specStep * (1.0 - roughnessFactor * 0.75) * shadowAtten);

  // --- rim / fresnel ---------------------------------------------------------
  float fres = 1.0 - max(dot(toonN, toonV), 0.0);
  float rim = smoothstep(1.0 - uRimWidth, 1.0, fres);
  // Rim is strongest where the light grazes — avoids the "glowing blob" look.
  rim *= mix(0.35, 1.0, clamp(ndl * 0.5 + 0.6, 0.0, 1.0));
  col += uRimColor * rim * uRimStrength;

  // --- elemental aura --------------------------------------------------------
  float auraPulse = 0.65 + 0.35 * sin(uTime * 4.5 + vToonWorld.y * 1.6);
  if (uElementGlow > 0.001) {
    col += uElementColor * uElementGlow * (rim * 1.6 + 0.22) * auraPulse;
  }
  // 元素附着 on a *body*: a coat, not a light.
  //
  // The additive term above is the resting glow, and on a pale character it is invisible. A
  // traveller with 水 attached (glow 0.42) measured 3/255 bluer across the torso than a dry one
  // at the resting 0.10 -- 208,203,205 -> 208,204,208 -- because rim is ~0 everywhere but the
  // silhouette, leaving a 0.22 floor to add to a body already sitting where the tone curve has
  // almost no room left. Adding light to white cannot colour it; taking light away from two
  // channels can. So an attachment mixes the body *toward* the element instead: bounded by
  // construction, and modulated by the body's own luminance so the cel bands, the shadow side and
  // the outline all still read through the coat.
  //
  // Separate uniform rather than a curve on uElementGlow, because the resting glow is the
  // operating point every enemy sheet and character shot was calibrated on: at uElementWash 0
  // this block is exactly nothing and those frames stay bit-identical.
  //
  // The damage flash at the bottom of this shader overrides the coat, on purpose: mixing the body
  // toward pink is the last thing that happens, so a hit whites out the attachment along with
  // everything else for its 0.2 s. Worth knowing when measuring: pinned at 0.75 it turns this
  // coat's 15 counts into 2.7, which is how the same build read 58/0 and 55/3 on two runs.
  if (uElementWash > 0.001) {
    float bodyLum = dot(col, vec3(0.299, 0.587, 0.114));
    vec3 coat = uElementColor * (0.35 + 0.9 * bodyLum);
    col = mix(col, coat, uElementWash * (0.78 + 0.22 * auraPulse));
  }
  // Emissive pulse (used for weakspots / boss phase changes)
  col += totalEmissiveRadiance * (1.0 + uEmissivePulse * sin(uTime * 8.0) * 0.5);
  // Damage flash
  col = mix(col, vec3(1.0, 0.72, 0.72), uHitFlash);

  outgoingLight = col;
`;

let sharedTime = { value: 0 };
export function setToonTime(t) { sharedTime.value = t; }

const DEFAULTS = {
  bands: 3.0,
  rampSoft: 0.06,
  shadowTint: 0x6a6f95,
  rimStrength: 0.30,
  rimWidth: 0.28,
  rimColor: 0xffffff,
  specStep: 0.55,
  specSharp: 0.6,
  specColor: 0xffffff,
  sway: 0.0,
};

/**
 * Create a cel-shaded material. `opts` accepts every MeshStandardMaterial option
 * plus the toon parameters above.
 */
export function toonMaterial(opts = {}) {
  const {
    bands = DEFAULTS.bands, rampSoft = DEFAULTS.rampSoft,
    shadowTint = DEFAULTS.shadowTint, rimStrength = DEFAULTS.rimStrength,
    rimWidth = DEFAULTS.rimWidth, rimColor = DEFAULTS.rimColor,
    specStep = DEFAULTS.specStep, specSharp = DEFAULTS.specSharp,
    specColor = DEFAULTS.specColor, sway = DEFAULTS.sway,
    rootDark = 0, rootH = 1, mottle = 0, mottleScale = 1.6, mottleSpeck = 1,
    shadowFloor = 0.14, rampFloor = 0, fill = 0,
    ...stdOpts
  } = opts;

  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.75,
    metalness: 0.0,
    ...stdOpts,
  });

  mat.userData.toon = {
    uBands: { value: bands },
    uRampSoft: { value: rampSoft },
    uShadowTint: { value: new THREE.Color(shadowTint) },
    uRimStrength: { value: rimStrength },
    uRimWidth: { value: rimWidth },
    uRimColor: { value: new THREE.Color(rimColor) },
    uSpecStep: { value: specStep },
    uSpecSharp: { value: specSharp },
    uSpecColor: { value: new THREE.Color(specColor) },
    uEmissivePulse: { value: 0 },
    uElementGlow: { value: 0 },
    uElementColor: { value: new THREE.Color(0xffffff) },
    uElementWash: { value: 0 },
    uTime: sharedTime,
    uHitFlash: { value: 0 },
    uDissolve: { value: 0 },
    uSway: { value: sway },
    uRootDark: { value: rootDark },
    uRootH: { value: rootH },
    uMottle: { value: mottle },
    // Cycles per metre. 1.6 puts the coarse lobe at ~60 cm and the third octave at
    // ~11 cm, which is the range a player standing next to a rock actually resolves.
    uMottleScale: { value: mottleScale },
    uMottleSpeck: { value: mottleSpeck },
    uShadowFloor: { value: shadowFloor },
    uRampFloor: { value: rampFloor },
    // Off for every material but the dungeon vaults; see the fill block in TOON_FRAG.
    uFillStrength: { value: fill },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.toon);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + TOON_PARS)
      .replace(
        '#include <project_vertex>',
        TOON_VERT + '\n' + SWAY_VERT + '\n#include <project_vertex>',
      );
    // `outgoingLight` is already declared by the physical shader just above
    // <opaque_fragment>; we overwrite it with the cel-shaded result.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + TOON_PARS)
      .replace(
        '#include <opaque_fragment>',
        TOON_FRAG + '\n#include <opaque_fragment>',
      );
    mat.userData.shader = shader;
  };
  // NOTE: no customProgramCacheKey override — the default one hashes
  // onBeforeCompile's source *plus* every shader parameter, so skinned /
  // instanced / shadowed variants each get their own program. Forcing a single
  // key would make the first compiled variant get reused for all of them.
  return mat;
}

/**
 * Set the elemental aura glow on any toon material (or a whole subtree).
 *
 * `wash` is 元素附着's coat (see TOON_FRAG) and, like `colorHex`, is left alone when it is not
 * passed: the burst pulse re-calls this every frame with only a new strength, and a default of 0
 * there would drop the attachment's coat on the first pulsed frame.
 */
export function setAura(objOrMat, colorHex, strength, wash) {
  const apply = (m) => {
    const u = m?.userData?.toon;
    if (!u) return;
    u.uElementGlow.value = strength;
    if (colorHex != null) u.uElementColor.value.setHex(colorHex);
    if (wash != null) u.uElementWash.value = wash;
  };
  if (objOrMat?.isMaterial) return apply(objOrMat);
  objOrMat?.traverse?.((o) => {
    if (!o.material) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(apply);
  });
}

export function setHitFlash(obj, v) {
  obj?.traverse?.((o) => {
    if (!o.material) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      if (m.userData?.toon) m.userData.toon.uHitFlash.value = v;
    });
  });
}

/* ------------------------------------------------------------------ outlines -- */

const OUTLINE_VERT = /* glsl */`
  // Pick the deformed view-space normal when the shader has one (skinning /
  // envmap paths declare transformedNormal), otherwise transform the attribute.
  vec3 outlineNrm;
  #if defined( USE_ENVMAP ) || defined( USE_SKINNING )
    outlineNrm = transformedNormal;
    #ifdef FLIP_SIDED
      outlineNrm = -outlineNrm;     // BackSide already flipped it; undo that
    #endif
  #elif defined( USE_INSTANCING )
    // The basic shader only declares transformedNormal for the envmap/skinning
    // paths, so the instanced case has to fold instanceMatrix in by hand. Without
    // it every rotated instance of a scattered prop pushes its shell along the
    // *unrotated* normal and the outline tears open down one side.
    outlineNrm = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  #else
    outlineNrm = normalize(normalMatrix * normal);
  #endif
  // Constant screen-space width: the NDC offset is scaled by w.
  vec2 outlineOff = normalize((projectionMatrix * vec4(outlineNrm, 0.0)).xy + 1e-6);
  gl_Position.xy += outlineOff * uThickness * gl_Position.w * 0.0016;
`;

/**
 * Inverted-hull outline. Renders backfaces pushed along the normal in *clip*
 * space so the line stays a constant pixel width regardless of distance.
 *
 * Built on MeshBasicMaterial rather than a raw ShaderMaterial so three.js gives
 * us skinning and instancing support for free — a hand-written ShaderMaterial
 * would leave skinned outline shells frozen in the bind pose.
 */
export function outlineMaterial(color = 0x121018, thickness = 1.9, sway = 0) {
  const mat = new THREE.MeshBasicMaterial({
    color,
    side: THREE.BackSide,
    fog: false,
  });
  mat.userData.outline = {
    uThickness: { value: thickness },
    uSway: { value: sway },
    uTime: sharedTime,
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.outline);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uThickness;\nuniform float uSway;\nuniform float uTime;',
      )
      .replace(
        '#include <project_vertex>',
        SWAY_VERT + '\n#include <project_vertex>\n' + OUTLINE_VERT,
      );
  };
  return mat;
}

/**
 * Add an inverted-hull shell around every mesh in a subtree. Skinned meshes get
 * a SkinnedMesh shell sharing the same skeleton and bind matrix so the outline
 * deforms with the pose.
 */
export function addOutline(root, color = 0x14121c, thickness = 1.9) {
  const shells = [];
  root.traverse((o) => {
    if (!o.isMesh || o.userData.noOutline) return;
    // Inherit the source material's sway so the hull travels with the geometry.
    const srcMat = Array.isArray(o.material) ? o.material[0] : o.material;
    const mat = outlineMaterial(color, thickness, srcMat?.userData?.toon?.uSway?.value ?? 0);
    let shell;
    if (o.isSkinnedMesh) {
      shell = new THREE.SkinnedMesh(o.geometry, mat);
      shell.bindMode = o.bindMode;
      shell.bind(o.skeleton, o.bindMatrix);
    } else if (o.isInstancedMesh) {
      // Share the instanceMatrix attribute rather than copying it, so moving an
      // instance (wind sway, a chest opening) moves its outline with it.
      shell = new THREE.InstancedMesh(o.geometry, mat, o.count);
      shell.instanceMatrix = o.instanceMatrix;
      shell.count = o.count;
    } else {
      shell = new THREE.Mesh(o.geometry, mat);
    }
    shell.userData.noOutline = true;
    shell.userData.isOutline = true;
    shell.castShadow = false;
    shell.receiveShadow = false;
    shell.frustumCulled = o.frustumCulled;
    shell.renderOrder = -1;
    o.add(shell);
    shells.push(shell);
  });
  return shells;
}

/* -------------------------------------------------------- special materials -- */

/**
 * Hair uses an anisotropic band highlight, drawn as a stretched specular.
 *
 * The rim and specular are scaled down as the base colour gets lighter. At full
 * strength on the near-white hair colours the fresnel rim and the highlight both
 * clip, and the whole head turns into one glowing dome with no lock definition
 * left in it — the silhouette reads as bald.
 */
export function hairMaterial(color, tipColor) {
  const c = new THREE.Color(color);
  const lum = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  return toonMaterial({
    color,
    bands: 3.0,
    rampSoft: 0.045,
    roughness: 0.42,
    specStep: 0.42 + lum * 0.34,
    specSharp: 0.78,
    // The sheen band takes the *tip* colour, not white. A white highlight on dark
    // hair adds ~0.7 to a base value of ~0.13, so the band lands at light grey and
    // the strand reads as a stripe of a different material; tinting it (and
    // scaling it back on the dark colours) turns the same band into the anime hair
    // sheen it is supposed to be.
    specColor: new THREE.Color(tipColor ?? 0xffffff).multiplyScalar(0.42 + lum * 0.58),
    rimStrength: 0.34 * (1 - lum * 0.8),
    rimWidth: 0.22,
    rimColor: tipColor ?? 0xffffff,
    // Cooler and deeper on pale hair so the bands actually separate.
    shadowTint: new THREE.Color(0x7a7099).lerp(new THREE.Color(0x4d5480), lum).getHex(),
  });
}

/** Skin: soft ramp, warm subsurface-ish shadow, low spec. */
export function skinMaterial(color) {
  return toonMaterial({
    color,
    bands: 2.0,
    rampSoft: 0.13,
    roughness: 0.85,
    specStep: 0.86,
    specSharp: 0.35,
    rimStrength: 0.20,
    rimWidth: 0.24,
    rimColor: 0xffd9c4,
    shadowTint: 0xd08e86,
  });
}

/** Cloth: 3 bands, matte. */
export function clothMaterial(color, opts = {}) {
  return toonMaterial({
    color,
    bands: 3.0,
    roughness: 0.88,
    specStep: 0.92,
    specSharp: 0.25,
    rimStrength: 0.26,
    shadowTint: 0x7378a4,
    ...opts,
  });
}

/**
 * Metal: sharper spec, fewer bands, tinted reflections.
 *
 * "Tinted" is the part this used to only claim. `specColor` was left at the white default, and the
 * add is `uSpecColor * step(spec) * (1 - rough·0.75)` — so a plate at the specular angle got a full
 * white 0.79 laid over its top band and clipped. `specSharp 0.88` is an exponent of ~194, which is
 * a pinpoint glint on anything curved and **all-or-nothing on a flat facet**: the ruin guard's
 * forearm is a lofted rect, one normal across the whole face, so at one azimuth (reproduce with
 * `enemy-cam.mjs ruinGuard --yaw -2.4`) 3.3 % of the silhouette went to featureless white in one
 * connected wedge, bloom halo and all. Nothing was wrong with the geometry or the light.
 *
 * A metal's specular takes its own hue — white spec is dielectric behaviour — so the fix is the
 * physical one: reflect the albedo, lifted most of the way to white so it still reads as a glint.
 * On the guard's 0x8a897e that is 0.79 of a *hued* value instead of 0.79 of white, which keeps the
 * highlight bright and keeps a channel spread in it. Overridable per caller like everything else.
 */
export function metalMaterial(color, opts = {}) {
  const spec = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.34);
  return toonMaterial({
    color,
    bands: 2.0,
    rampSoft: 0.03,
    roughness: 0.28,
    metalness: 0.75,
    specStep: 0.3,
    specSharp: 0.88,
    specColor: spec,
    rimStrength: 0.55,
    rimWidth: 0.22,
    rimColor: 0xffffff,
    shadowTint: 0x5a6484,
    ...opts,
  });
}

/**
 * Eyes. Deliberately *not* very emissive: the iris colours are already bright
 * mint/gold/violet, and an emissive add on top of the flat ramp pushes them to
 * white so the eye loses its colour and reads as a blank lens.
 *
 * `lit` raises that for the one case where the character's own eyes are a light
 * source: a monster face. A creature's eye is read against a near-black hide in
 * whatever light the camp happens to have, and at 0.10 the abyss herald's visor
 * band came out the same value as its helm in the shade — the diffuse ramp had
 * taken 65 % of it. `enemies.js` asks for 0.42; a person's eye keeps the default,
 * because a face is lit like the skin next to it.
 */
export function eyeMaterial(color, lit = 0.10) {
  return toonMaterial({
    // Slightly deepened so the highlight pass has somewhere to go.
    color: new THREE.Color(color).multiplyScalar(0.78),
    bands: 1.0,
    roughness: 0.25,
    emissive: new THREE.Color(color).multiplyScalar(lit),
    specStep: 0.98,
    specSharp: 0.95,
    rimStrength: 0.0,
    shadowTint: 0xb9c2e0,
  });
}

/**
 * Hide / scale / chitin: monster bodies. Two bands rather than cloth's three and
 * a green-shifted shadow, which is what stops a big animal body from reading as
 * an inflated fabric balloon.
 */
export function hideMaterial(color, opts = {}) {
  return toonMaterial({
    color,
    bands: 2.0,
    rampSoft: 0.09,
    roughness: 0.80,
    specStep: 0.74,
    specSharp: 0.45,
    rimStrength: 0.34,
    rimWidth: 0.30,
    shadowTint: 0x6a7a86,
    ...opts,
  });
}

/**
 * Slime jelly: translucent, lit from inside. Depth-write is off so the nucleus
 * inside reads through the shell no matter which order they happen to draw in;
 * `noOutline` keeps the inverted hull off it, because an outline on a
 * transparent shell draws a hard black ring where the jelly should fade.
 */
export function jellyMaterial(color, glow = color) {
  const m = toonMaterial({
    color,
    bands: 2.0,
    roughness: 0.10,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    emissive: new THREE.Color(glow).multiplyScalar(0.28),
    specStep: 0.34,
    specSharp: 0.92,
    rimStrength: 1.05,
    rimWidth: 0.42,
    rimColor: glow,
    shadowTint: 0x8fa8c8,
  });
  m.userData.noOutlineMat = true;
  return m;
}

/** Emissive elemental crystal / glow material. */
export function glowMaterial(color, intensity = 1.4) {
  return toonMaterial({
    color,
    bands: 2.0,
    roughness: 0.15,
    emissive: new THREE.Color(color).multiplyScalar(intensity),
    transparent: true,
    opacity: 0.92,
    specStep: 0.3,
    specSharp: 0.9,
    rimStrength: 1.2,
    rimColor: color,
  });
}
