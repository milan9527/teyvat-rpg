// Procedural enemy models — one builder per `model.kind` in shared/data/enemies.js.
//
// Same pipeline as the characters: rigid primitives authored in bone space, baked
// into a single skinned mesh so a whole creature is 3-5 draw calls however many
// bones it has, then given the inverted-hull outline so it belongs to the same
// art style as the party.
//
// Each kind supplies four things and nothing else:
//   bones  — [name, parent] list
//   place  — rest pose (this is where the proportions live)
//   parts  — the geometry, pushed per bone
//   pose   — a procedural animation function of (t, state)
// That split is what keeps eight very different silhouettes — a jelly blob, a
// quadruped, a mech and a flying boss — from turning into eight ad-hoc files.

import * as THREE from 'three';
import {
  SEC, sweep, loft, bar, trs, Parts, UP_REF, X_REF,
  sphere, blob, spike, along, ring as torus,
} from './solid.js';
import { makeRig, bakeSkinned } from './skin.js';
import {
  hideMaterial, jellyMaterial, metalMaterial, clothMaterial, glowMaterial,
  eyeMaterial, addOutline, setAura,
} from './toon.js';
import { ENEMIES } from '@teyvat/shared/data/enemies.js';
import { ELEMENTS } from '@teyvat/shared/data/elements.js';

/* ---------------------------------------------------------------- primitives -- */

/**
 * A tapered limb segment growing from the origin along -Y (the direction every
 * bone in these rigs points), so a bone rotation bends it the way a joint would.
 */
function limb(len, rBase, rTip, seg = 6, radial = 8) {
  const g = new THREE.CylinderGeometry(rTip, rBase, len, radial, seg);
  g.translate(0, -len / 2, 0);
  return g;
}

/** Flat-ish plate: armour panels, feathers, fins. Rounded rect lofted thin. */
const plate = (len, w0, w1, thick) =>
  loft(SEC.rect, 0, len, (t) => ({ w: w0 + (w1 - w0) * t, d: thick }), 4);

/**
 * The gait clock, in radians. `rate` is the kind's stride frequency, used only as a
 * fallback — normally the clock is *distance* driven (see `GAIT` and `buildRigged`).
 *
 * Two optional inputs, and they are deliberately *not* called `phase`:
 *
 *   `st.gait`       replaces the clock outright: what the view itself writes every frame
 *                   from the ground the creature has covered, and what a tool passes to
 *                   hold one fixed pose;
 *   `st.gaitOffset` shifts it per actor, so three hilichurls walking together do not
 *                   step in perfect unison.
 *
 * It used to be a single key named `phase`, and `ActorSystem` passed the *boss battle
 * phase* into it — an integer, always ≥ 1, so `st.phase ?? t * rate` never once fell
 * through to the clock. Every walker in the game (hilichurl ×3, ruin guard, wolf,
 * vishap) slid across the ground with its legs frozen at sin(1). Two different
 * quantities must never share a name on the same state object; `phase2` (the herald's
 * second-phase hunch) is the battle phase and keeps its name.
 */
function gaitPhase(st, t, rate) {
  return (st.gait ?? t * rate) + (st.gaitOffset ?? 0);
}

/**
 * 步幅. Gait geometry per model kind, in one table because the *pose* and the *clock* have
 * to agree about it — and for the whole life of this file they did not.
 *
 * A time-driven clock (`t * rate`) makes the distance covered by one stride whatever
 * `speed / rate` happens to be, and it was 1.5-2.4× further than the legs could reach in
 * every walking kind: the hilichurl's hips sit 0.58 m up and its thigh swings 0.62 rad, so
 * a full cycle can carry it 4·0.58·sin(0.62) = 1.34 m, while at 3.1 m/s and 6.0 rad/s it
 * actually covered 3.25 m. The feet skated. That reads as ice, or as a creature being
 * dragged, and no amount of leg amplitude fixes it, because the error is in the *clock*.
 *
 *   amp   thigh swing amplitude in radians at full speed, which the pose reads back so the
 *         stride and the pose can never disagree
 *   top   the speed the amplitude ramp saturates at, also read back by the pose
 *   feet  the contact points, one per support phase of a cycle: two feet for a biped, the
 *         front and the back pair for the wolf's bound. `ext` extends a bone to its tip,
 *         for a kind whose lowest bone is a shin rather than an ankle.
 *
 * How far one cycle carries the creature is **measured off the rig** rather than derived
 * (`measureStride` below): the ideal pendulum answer, `4 · hip · sin(amp)`, is 25-60% too
 * long, because the knee folds as the leg swings forward and the hips bob, and both eat into
 * the reach. Guessing it left the feet sliding by a fifth to a third — better than the 2.4×
 * skate, but still sliding, and no comment could have told you which. Cadence then falls out
 * of the geometry instead of being authored: ~2.5 Hz for a stubby hilichurl, ~1.3 Hz for a
 * 3.6 m mech, ~2.8 Hz for a galloping wolf.
 *
 * The amplitudes are ~18% wider than they were first authored. That is the other half of the
 * same sum: with the clock honest, a short swing has to be paid for in cadence, and the wolf
 * was scrabbling at over 3 Hz. A longer stride buys the frequency back and reads better at
 * 40 m, which is where most of these are seen.
 */
const GAIT = {
  hilichurl: { amp: 0.74, top: 3.2, feet: [{ bone: 'footL' }, { bone: 'footR' }] },
  ruinGuard: { amp: 0.50, top: 2.6, feet: [{ bone: 'footL' }, { bone: 'footR' }] },
  // Quadruped bound: the front pair plants, then the back pair, so a cycle is still two
  // support phases — they are just not the same two legs. The pairs straddle `amp`.
  wolf: { amp: 1.00, top: 5.0, feet: [{ bone: 'fShinL', ext: (S) => S.shin }, { bone: 'bShinL', ext: (S) => S.shin }] },
  vishap: { amp: 0.66, top: 3.6, feet: [{ bone: 'footL' }, { bone: 'footR' }] },
};

/**
 * The ground one gait cycle covers, in model units, measured by posing the rig through a full
 * cycle at full speed and adding up how far each contact point sweeps.
 *
 * Summed rather than averaged: a cycle has one support phase per entry in `feet` (left foot,
 * right foot — or for a bound, the front pair then the back pair), and each one carries the
 * body by its own sweep. Sixty-four samples is far more than the shape needs; it runs once per
 * creature *model*, at build, and costs no geometry.
 */
function measureStride(K, S, bones, rest, group) {
  const feet = (K.gait.feet || []).filter((f) => bones[f.bone]);
  if (!feet.length) return 0;
  let total = 0;
  for (const f of feet) {
    const ext = f.ext ? f.ext(S) : 0;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 64; i++) {
      for (const [n] of K.bones) bones[n].rotation.copy(rest[n]);
      K.pose(bones, 0, { speed: K.gait.top, attack: 0, gait: (i / 64) * Math.PI * 2 }, S);
      group.updateMatrixWorld(true);
      const e = bones[f.bone].matrixWorld.elements;
      // e[12..14] is the bone origin; column 1 (e[4..6]) is its local +Y axis, and bones point
      // down -Y, so a tip `ext` along the bone is the origin minus ext·that. +Z is forward.
      const z = e[14] - (ext ? e[6] * ext : 0);
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
    total += hi - lo;
  }
  for (const [n] of K.bones) bones[n].rotation.copy(rest[n]);
  return total;
}

/* ------------------------------------------------------------------ palettes -- */

// Colour derivation happens on the sRGB bytes, NOT through THREE.Color arithmetic.
//
// THREE.Color decodes a hex literal to linear-light and re-encodes on getHex(), so
// `multiplyScalar(0.40)` darkens the *displayed* value only to about 0.66 — a
// barely visible step where a distinctly darker tone was wanted. Likewise a
// mid-brown like 0x8a6a44 has a linear luminance of ~0.16, so a "min luminance
// 0.22" test done in linear space fires on colours that are already perfectly
// readable and washes the whole palette out. Perceptual steps need sRGB maths.
const rgbOf = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const hexOf = (r, g, b) => (Math.round(clamp255(r)) << 16) | (Math.round(clamp255(g)) << 8) | Math.round(clamp255(b));
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
/** Perceived luminance, 0..1, in display space. */
function lumOf(hex) {
  const [r, g, b] = rgbOf(hex);
  return (r * 0.299 + g * 0.587 + b * 0.114) / 255;
}
/** Darken/brighten in display space: `shade(c, 0.4)` really does look 40% as bright. */
function shade(hex, k) {
  const [r, g, b] = rgbOf(hex);
  return hexOf(r * k, g * k, b * k);
}

/**
 * Guarantee a minimum luminance for a large-area material.
 *
 * Several of the authored enemy colours are near-black by design (the abyss mage
 * robe is 0x1a1a38, the herald's 0x0e2036). Under the cel ramp a base that dark has
 * nowhere to go: the lit band, the tinted shadow band and the outline all land on
 * top of each other and the whole creature renders as one black silhouette with
 * glowing trim floating on it. Lifting the *base* keeps the authored hue while
 * giving the ramp room to separate its bands — the design stays dark navy, it just
 * stops being a hole in the screen.
 */
function lift(hex, minLum = 0.20) {
  const l = lumOf(hex);
  if (l >= minLum) return hex;
  const [r, g, b] = rgbOf(hex);
  // Scale the channels up together so the hue and saturation ratio survive; a navy
  // robe brightens to a lighter navy rather than drifting toward grey.
  const k = minLum / Math.max(0.008, l);
  const peak = Math.max(r, g, b) * k;
  // If scaling would clip the brightest channel, fall back to lerping toward white
  // for the remainder — clipping one channel is what turns navy into cyan.
  if (peak <= 255) return hexOf(r * k, g * k, b * k);
  const s = 255 / Math.max(1, Math.max(r, g, b));
  const [r2, g2, b2] = [r * s, g * s, b * s];
  const need = Math.min(1, (minLum - lumOf(hexOf(r2, g2, b2))) / Math.max(0.02, 1 - lumOf(hexOf(r2, g2, b2))));
  return hexOf(r2 + (255 - r2) * need, g2 + (255 - g2) * need, b2 + (255 - b2) * need);
}

const scaleHex = shade;

/**
 * The anime highlight, in the hide's own hue instead of paper white.
 *
 * `toon.js` bounds the stepped specular by *mixing* toward `uSpecColor` rather than adding it
 * (see the note there), which fixed the unbounded case — but the default `uSpecColor` is white,
 * and a mix toward white still destroys the one property a coloured hide has. The frost wolf's
 * back-yaw isolation frame is the measured case: one flat facet on the left rump, 56×31 px at a
 * uniform (213, 217, 221), i.e. 8 counts of channel spread left out of the 57 the albedo was
 * deliberately authored with (see `frostWolf.model.color`, walked down twice for exactly this
 * reason). It is a hard-edged white wedge on the shoulder of a blue-white animal.
 *
 * It is a *facet*, not a rim, and that was worth measuring rather than assuming: the distance
 * transform of the silhouette puts the patch 32 px inside the outline, where the fresnel term
 * (`rimWidth` 0.30, so it needs `1 − N·V ≥ 0.70`) cannot reach. A flat facet has one normal, so
 * the stepped specular is all-or-nothing across the whole face however sharp the exponent is —
 * the exponent only decides *whether* the facet lights up.
 *
 * One term, not two, and the second one is worth recording because a probe caught it: the first
 * draft also raised `specStep` with the hide's luminance (like `hairMaterial`, which scales its
 * sheen back on pale hair so a near-white head does not read as bald). On the wolf that moved the
 * step from 0.74 to 0.83 and left **14 px** of highlight on the whole model — the wash readings all
 * improved, because the cheapest way to pass "no washed-out patch" is to delete the highlight.
 * `enemy-cam`'s A/B (`iso-spec-*` vs `iso-nospec-*`) is there to make that fail, and it did.
 *
 * So the highlight keeps its old size and only changes colour: `specColor` is the hide's own hue at
 * full value, kept a third of the way to white. On the wolf that is (208, 232, 255) instead of
 * (255, 255, 255) — still visibly a highlight, still cool, and it carries hue *into* the brightest
 * pixels the model has, which is exactly what the wash mask is asking for.
 */
function hideSpec(hex) {
  const [r, g, b] = rgbOf(hex);
  // Full value at the authored hue: scale the channels together until the brightest clips.
  const k = 255 / Math.max(1, Math.max(r, g, b));
  const toWhite = (v) => v * k + (255 - v * k) * 0.34;
  return { specColor: hexOf(toWhite(r), toWhite(g), toWhite(b)) };
}

function materialsFor(def) {
  const m = def.model;
  const el = ELEMENTS[def.element]?.color ?? 0xffffff;
  const glowHex = m.glow ?? m.accent ?? el;
  // Two floors, not one: the garment has to stay clearly below the body value or
  // hood and skirt merge into a single dark mass again.
  const bodyHex = lift(m.color, 0.26);
  const clothHex = lift(m.cloth ?? m.robe ?? scaleHex(bodyHex, 0.62), 0.15);
  // Every hide on a creature gets its highlight in its own hue (`hideSpec`). Applied here rather
  // than inside `hideMaterial`, because that function also builds bark, stone, snow and mushroom
  // caps for `props.js` — a term that changes the world's pale surfaces is a different change with
  // a different set of calibrated pictures behind it, and it can be argued on its own frames.
  const hide = (hex, opts = {}) => hideMaterial(hex, { ...hideSpec(hex), ...opts });
  return {
    body: hide(bodyHex),
    // A second body tone, derived rather than authored: every creature needs a
    // belly/underside value or the silhouette is one flat mass from the side.
    body2: hide(scaleHex(bodyHex, 0.66)),
    cloth: clothMaterial(clothHex),
    metal: metalMaterial(m.metal ?? 0x8a897e),
    // The deep value. Derived from the *authored* colour, not the lifted one, so
    // the darkest parts keep the designed near-black.
    dark: hide(scaleHex(m.color, 0.40), { bands: 2 }),
    bone: hide(m.mask ?? 0xd8ccb0),
    accent: hide(m.accent ?? glowHex),
    // For parts thinner than the rim is wide. `hideMaterial`'s fresnel rim is 0.34 of *white* at
    // width 0.30, which on a body is an edge and on a 6 cm quill is the entire surface — the storm
    // tyrant's crest read as a white starburst partly for this reason, and no albedo change can fix
    // it because the albedo is not what is being drawn. So: the same hide colour a shade down, with
    // the rim turned almost off, for feathers, quills, blades and fins.
    thin: hide(scaleHex(bodyHex, 0.92), { rimStrength: 0.10, rimWidth: 0.20 }),
    glow: glowMaterial(glowHex, 1.5),
    // Lit from within: a monster eye has to read against a near-black hide in whatever
    // light its camp has. See `eyeMaterial`'s note for the value.
    eye: eyeMaterial(glowHex, 0.42),
    // Bright elemental trim that is *not* an eye: hoops, bands, orbs — anything whose whole
    // surface is the accent colour. `glow` cannot do that job, because emissive ×1.5 plus a
    // 1.2 rim clips a wide surface to paper white (the mage's skirt rings and hand orbs, the
    // herald's four hem hoops — 10.5 % of that boss's silhouette). The same recipe as `eye`,
    // deliberately under a *second* key rather than reused: `enemy-cam` proves a face by hiding
    // `materials.eye` and demanding that nothing outside the head box moves, so the moment a
    // skirt ring shares that material the face gate stops being a face gate.
    trim: eyeMaterial(glowHex, 0.42),
    jelly: jellyMaterial(m.color, glowHex),
    glowHex,
  };
}

/* ----------------------------------------------------------------- the kinds -- */

/**
 * Where a dot has to sit to be *on* an ellipsoidal head instead of inside it.
 * `blob(r, sx, sy, sz)` is a unit sphere scaled per axis, so the surface above
 * (x, y) is at `z = sz·√(1 − (x/sx)² − (y/sy)²)` — everything here in units of r.
 *
 * Every eye in this file was authored as a constant z that looked right at x = 0,
 * and every one of them was buried: the wolf's and the vishap's contributed **0 px**
 * to their own portraits and the tyrant's contributed 648, all edge-peek. A head is
 * widest at its centre, so the further out an eye sits the further back the surface
 * has already curved — which is why the constant is wrong in exactly the place the
 * eyes go. `out` floats the eyeball proud of the socket; the sphere is squashed in z,
 * so the visible dome is what is left above the surface.
 */
function onBlob(sx, sy, sz, x, y, out = 0.02) {
  return sz * Math.sqrt(Math.max(0.04, 1 - (x / sx) ** 2 - (y / sy) ** 2)) + out;
}

const KINDS = {};

/* --- slime ------------------------------------------------------------------ */
// Not rigged: a slime is one blob, and its whole performance is squash-and-stretch
// on a single transform. Skinning it would cost a skeleton to animate one scale.
KINDS.slime = {
  rigged: false,
  build(def, M) {
    const S = { r: (def.hitbox?.r ?? 0.75) * 0.78, h: def.hitbox?.h ?? 1.1 };
    const group = new THREE.Group();

    // Nucleus and face go in first and get outlines; the jelly shell is added
    // afterwards so the inverted hull never wraps the transparent surface (a
    // black ring around a translucent blob reads as a hole).
    const inner = new Parts();
    inner.add(blob(S.r * 0.44, 1.0, 0.82, 1.0, 12), M.glow);
    for (const s of [-1, 1]) {
      inner.add(sphere(S.r * 0.13, 10), M.dark,
        trs(s * S.r * 0.30, S.r * 0.52, S.r * 0.74, 0, 0, 0, 1, 1.25, 0.6));
    }
    // Mouth: a small flattened wedge, enough to give the blob a front.
    inner.add(blob(S.r * 0.12, 1.5, 0.7, 0.5, 8), M.dark, trs(0, S.r * 0.30, S.r * 0.80));
    const core = inner.build('core');
    group.add(core);

    // Elemental crest: the pointed tuft on top that identifies the element.
    //
    // Two parts, for the reason the storm tyrant's quills are two parts: as a single
    // `glow` sweep this was emissive = hex × 1.5 over its whole area plus a rim of the
    // same colour at strength 1.2, i.e. a shape with no shading anywhere on it. The
    // model-alone frames showed it exactly that way — the electro slime's tuft was a
    // featureless white blade over 7 % of the whole silhouette (the gate's bar is 7 %),
    // and the fire slime's was cream (bright enough to lose its hue, warm enough that
    // the neutrality clause in that gate never noticed). A blade in a shaded material
    // with a narrow bright core reads as a *lit* tuft from every yaw instead.
    //
    // The glowing part's path is the blade's path with `t` remapped, so the two cannot drift
    // apart when the curve is retuned. On the tyrant the glow is a narrow *spine* down a long
    // quill; here the crest is 17 cm across on screen, and a spine that thin inside a blade
    // that wide simply disappeared (the first version of this read as a plain violet horn with
    // no element left in it). So on a small part the glowing thing is the **tip**: the top
    // 30 % of the same sweep, a hair narrower in `w` so the blade still owns the silhouette
    // and a hair deeper in `d` so it stands proud instead of z-fighting inside it. A hot tip
    // on a shaded tuft is also what the shape is supposed to say.
    const crest = new Parts();
    const tuft = (mat, u0, kw, kd) => crest.add(sweep(SEC.lens, (t) => {
      const u = u0 + t * (1 - u0);
      const p = CREST_P.set(Math.sin(u * 2.4) * S.r * 0.26, S.r * (0.82 + u * 0.66), -u * S.r * 0.30);
      return { p, w: S.r * kw * (1 - u * 0.94) + 0.005, d: S.r * kd * (1 - u * 0.92) + 0.004 };
    }, 8), mat);
    tuft(M.thin, 0, 0.30, 0.19);
    tuft(M.glow, 0.70, 0.29, 0.20);
    const crestG = crest.build('crest');
    group.add(crestG);

    addOutline(group, 0x1a1626, 1.6);

    const shell = new THREE.Mesh(blob(S.r, 1.0, 0.86, 1.0, 18), M.jelly);
    shell.position.y = S.r * 0.84;
    shell.userData.noOutline = true;
    group.add(shell);
    core.position.y = S.r * 0.84;
    crestG.position.y = S.r * 0.84;

    return {
      group,
      height: S.h,
      update(dt, t, st) {
        // Idle: a slow breathing wobble. Moving: a hop, because a slime that
        // slides at constant height reads as a ball rolling on ice.
        const sp = st?.speed ?? 0;
        const hopF = 3.4 + sp * 0.5;
        const hop = sp > 0.2 ? Math.max(0, Math.sin(t * hopF)) : 0;
        const sq = 1 - hop * 0.20 + Math.sin(t * 2.1) * 0.035;
        const stretch = 1 + hop * 0.26 - Math.sin(t * 2.1) * 0.05;
        // The hop moves the *parts*, never `group`. `group` is the actor's own node: every
        // frame `EnemyActor.setPose` writes the network position into `group.position`, so
        // `group.position.y = hop * …` here threw the terrain height away and pinned every
        // slime to world y ≈ 0 — 5 m under the ground at the first Mondstadt camp, 20-30 m
        // under it at the third. All three slime kinds were therefore buried everywhere in
        // the open world, and this is the *first* enemy a new player meets. Nothing else was
        // wrong: the server had them on the ground (net y 8.58, ground 8.58) and the actor
        // was streamed, built, lit and animated. `tools/enemy-cam.mjs` found it as "no yaw
        // shows the subject" — the model sheet was 47589 px of slime while all four world
        // framings were 1000x700 px of grass. Only the slime does this, because only the
        // slime is `rigged: false` and hand-animates its own transforms; every rigged kind
        // poses bones *inside* the group and cannot reach it.
        const lift = S.r * 0.84 + hop * S.r * 0.55;
        for (const o of [shell, core, crestG]) { o.scale.set(sq, stretch, sq); o.position.y = lift; }
        crestG.rotation.z = Math.sin(t * 1.7) * 0.16 - hop * 0.2;
      },
    };
  },
};
const CREST_P = new THREE.Vector3();

/* --- hilichurl -------------------------------------------------------------- */
KINDS.hilichurl = {
  gait: GAIT.hilichurl,
  bones: [
    ['root', null], ['hips', 'root'], ['torso', 'hips'], ['neck', 'torso'], ['head', 'neck'],
    ['armL', 'torso'], ['foreL', 'armL'], ['handL', 'foreL'],
    ['armR', 'torso'], ['foreR', 'armR'], ['handR', 'foreR'],
    ['thighL', 'hips'], ['shinL', 'thighL'], ['footL', 'shinL'],
    ['thighR', 'hips'], ['shinR', 'thighR'], ['footR', 'shinR'],
  ],
  dims(def) {
    const h = def.hitbox?.h ?? 1.7;
    return {
      h,
      // Squat and top-heavy: short bowed legs, a barrel belly and long arms. Those
      // three ratios *are* the hilichurl silhouette; get them wrong and it reads
      // as a small human.
      leg: h * 0.34, thigh: h * 0.17, shin: h * 0.17,
      torsoH: h * 0.34, neckH: h * 0.03, headR: h * 0.125,
      // shoulderW is wider than waistW on purpose even though the *body* is
      // pear-shaped: it is the arm-attachment radius, and it has to clear the
      // belly or the arms end up buried inside it and the creature reads as a
      // legged sack. The chest volume below is narrower than this.
      shoulderW: h * 0.205, waistW: h * 0.165, limbR: h * 0.050,
      upper: h * 0.19, fore: h * 0.20,
    };
  },
  place(b, S) {
    b.hips.position.set(0, S.leg, 0);
    b.torso.position.set(0, 0, 0);
    b.neck.position.set(0, S.torsoH * 0.92, S.headR * 0.10);
    b.head.position.set(0, S.neckH + S.headR * 0.58, 0);
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      b[`arm${L}`].position.set(s * S.shoulderW, S.torsoH * 0.74, 0);
      b[`fore${L}`].position.set(0, -S.upper, 0);
      b[`hand${L}`].position.set(0, -S.fore, 0);
      b[`thigh${L}`].position.set(s * S.waistW * 0.52, 0, 0);
      b[`shin${L}`].position.set(0, -S.thigh, 0);
      b[`foot${L}`].position.set(0, -S.shin, 0);
      // Bow-legged, and the arms splay *outward* as they descend so the hands end
      // up clear of the belly where a weapon can be seen.
      b[`arm${L}`].rotation.z = s * 0.34;
      b[`arm${L}`].rotation.x = 0.24;
      b[`fore${L}`].rotation.z = s * 0.18;
      b[`fore${L}`].rotation.x = 0.42;
      b[`thigh${L}`].rotation.z = s * 0.16;
      b[`shin${L}`].rotation.z = -s * 0.14;
    }
  },
  parts(P, S, M, def, H) {
    // Torso: one big pear, widest low down.
    P(blob(S.waistW * 1.16, 1.0, 1.20, 0.90, 14), M.body,
      'torso', trs(0, S.torsoH * 0.38, S.waistW * 0.10),
      { softBone: 'hips', softLen: S.torsoH });
    // Chest/shoulder mass, narrower than the belly, so the pear has a top.
    P(blob(S.waistW * 0.94, 1.0, 0.74, 0.88, 12), M.body, 'torso',
      trs(0, S.torsoH * 0.78, 0));
    // Loincloth: a short flared skirt, the only garment.
    P(loft(SEC.oct, 0, -S.torsoH * 0.52, (t) => ({
      w: S.waistW * (1.02 + t * 0.34), d: S.waistW * (0.86 + t * 0.30),
    }), 4), M.cloth, 'hips', trs(0, S.torsoH * 0.16, 0));
    // Shoulder wrap — sized off the chest volume, not the arm-attachment radius.
    P(torus(S.waistW * 0.98, S.limbR * 0.66, 6, 14), M.cloth, 'torso',
      trs(0, S.torsoH * 0.82, 0, Math.PI / 2, 0, 0));

    // Head: low forehead, heavy jaw, and the wooden mask over the face — the mask
    // is what makes it a hilichurl, so it is a separate proud plate, not a texture.
    P(blob(S.headR, 1.0, 0.94, 1.0, 14), M.body, 'head', trs(0, 0, 0));
    P(blob(S.headR * 0.62, 1.0, 0.60, 0.86, 10), M.body, 'head',
      trs(0, -S.headR * 0.52, S.headR * 0.18));
    P(loft(SEC.rect, -S.headR * 0.72, S.headR * 0.62, (t) => ({
      w: S.headR * (0.66 + Math.sin(t * Math.PI) * 0.26), d: S.headR * 0.16,
    }), 5), M.bone, 'head', trs(0, 0, S.headR * 0.80, -0.12, 0, 0));
    // Eye holes in the mask, and an eye inside each hole. The holes alone are two black
    // slots — correct for the mask and wrong for the creature wearing it, which read as an
    // empty prop at close range. The glint is small (0.38 of the hole) and clears the hole's
    // own front pole (0.90 + 0.5·0.13 = 0.965) by 0.065·headR — 1.4 cm on a 1.7 m hilichurl,
    // the least that can be seen at all. Anything less is *behind* an opaque dark sphere and
    // therefore not drawn; anything more is a bead stuck on the mask instead of an eye in a
    // slot, which is why the dark hole's silhouette stays 2.6× the glint's. It is also the
    // only user of
    // `materials.eye` on this model, which is what lets the portrait probe hide it and prove
    // the face reaches the screen instead of skipping the question.
    for (const s of [-1, 1]) {
      P(sphere(S.headR * 0.13, 8), M.dark, 'head',
        trs(s * S.headR * 0.30, S.headR * 0.16, S.headR * 0.90, 0, 0, 0, 1, 0.8, 0.5));
      P(sphere(S.headR * 0.05, 8), M.eye, 'head',
        trs(s * S.headR * 0.30, S.headR * 0.155, S.headR * 0.99, 0, 0, 0, 1, 1.0, 0.8));
    }
    // Two horn tufts of hair either side of the mask.
    for (const s of [-1, 1]) {
      P(spike(S.headR * 0.9, S.headR * 0.24, 5), M.dark, 'head',
        trs(s * S.headR * 0.72, S.headR * 0.34, -S.headR * 0.12, 0.3, 0, s * 0.9));
    }

    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      P(limb(S.upper, S.limbR * 1.15, S.limbR * 0.92, 4), M.body, `arm${L}`,
        trs(0, 0, 0), { softBone: `fore${L}`, softLen: S.upper });
      P(limb(S.fore, S.limbR * 0.95, S.limbR * 0.80, 4), M.body, `fore${L}`,
        trs(0, 0, 0), { softBone: `hand${L}`, softLen: S.fore });
      P(sphere(S.limbR * 1.05, 8), M.body, `fore${L}`, trs(0, 0, 0));
      P(blob(S.limbR * 1.25, 0.9, 1.05, 0.7, 8), M.body, `hand${L}`,
        trs(0, -S.limbR * 0.6, 0));
      P(limb(S.thigh, S.limbR * 1.55, S.limbR * 1.25, 4), M.body, `thigh${L}`,
        trs(0, 0, 0), { softBone: `shin${L}`, softLen: S.thigh });
      P(limb(S.shin, S.limbR * 1.20, S.limbR * 0.90, 4), M.body, `shin${L}`,
        trs(0, 0, 0), { softBone: `foot${L}`, softLen: S.shin });
      // thigh+shin lands the ankle bone exactly on the ground, so the foot volume
      // has to sit *above* it — centred below y=0 it half sinks into the terrain.
      P(blob(S.limbR * 1.5, 0.85, 0.55, 1.45, 8), M.dark, `foot${L}`,
        trs(0, S.limbR * 0.34, S.limbR * 0.42));
    }

    // Held weapons are authored in **model space** via `H.held`, not in hand space.
    // A hand bone inherits the arm's whole rest pose — 0.66 rad of forward pitch
    // and 0.52 of outward roll here — and its local +Y runs back up the forearm, so
    // hand-space weapons come out either buried in the torso (the first version's
    // haft, lofted along +Y) or slung across the body at an angle no amount of
    // guessed counter-rotation lands reliably. Authored upright in model space they
    // hang the way a carried weapon hangs, and still swing with the arm.
    if (def.model.bow) {
      // Crude recurve, gripped at its middle so the limbs run up and down past the
      // fist. The arc has to bend in **X**: an archer's bow face is perpendicular to
      // the arrow and the arrow leaves along Z, so curved in Z it sits edge-on to a
      // camera behind the shoulder and reads as a bare stick. Cut from bone rather
      // than the near-black hide, which vanished into the silhouette entirely.
      const half = S.h * 0.25;
      const g = H.at('handL');
      const grip = (dx) => H.held('handL',
        trs(g.x + dx * Math.cos(BOW_YAW), g.y, g.z + S.limbR * 0.5 - dx * Math.sin(BOW_YAW),
          0, BOW_YAW, 0));
      P(sweep(SEC.lens, (t) => {
        const y = -half + 2 * half * t;
        BOW_P.set(-Math.sin(t * Math.PI) * half * 0.42 + Math.abs(y) * 0.28, y, 0);
        return {
          p: BOW_P, w: S.limbR * 0.42 * (1 - Math.abs(t - 0.5) * 0.7),
          d: S.limbR * 0.66 * (1 - Math.abs(t - 0.5) * 0.5),
        };
      }, 14), M.bone, 'handL', grip(0));
      // String: a straight chord across the two tips, so the gap it spans is what
      // sells the recurve. `bar` builds on the Y axis and trs translates *after*
      // rotating, hence the pre-rotated offset in `grip`.
      P(bar(SEC.quad, -half * 0.96, half * 0.96, S.limbR * 0.055, S.limbR * 0.055),
        M.cloth, 'handL', grip(half * 0.28));
      // Arrows in a hip quiver, so the archer still reads as an archer from behind
      // with the bow edge-on.
      for (let i = 0; i < 3; i++) {
        // Shaft and fletching share one frame, so the flights are placed by their
        // y range along the shaft instead of by trigonometry at the quiver mouth.
        const q = trs(-S.waistW * 0.80 + i * S.limbR * 0.26, S.limbR * 0.6,
          -S.waistW * 0.60, -0.55, 0, -0.25);
        P(bar(SEC.quad, 0, S.h * 0.26, S.limbR * 0.06, S.limbR * 0.06), M.bone, 'hips', q);
        P(loft(SEC.quad, S.h * 0.20, S.h * 0.27, (t) => ({
          w: S.limbR * 0.30 * (1 - t * 0.7), d: S.limbR * 0.30 * (1 - t * 0.7),
        }), 2), M.cloth, 'hips', q);
      }
    }
    if (def.model.axe) {
      // Stone axe carried head-down beside the leg: a vertical haft past the fist
      // with a chipped wedge lashed across it near the bottom.
      const g = H.at('handR');
      const gz = g.z + S.limbR * 0.55;
      const hy = g.y - S.h * 0.27;                 // where the head sits on the haft
      P(bar(SEC.oct, S.h * 0.09, -S.h * 0.37, S.limbR * 0.32, S.limbR * 0.30, 2),
        M.body2, 'handR', H.held('handR', trs(g.x, g.y, gz)));
      // The head is lofted along +Y and then given a quarter turn, so its *length*
      // reaches outward off the haft while the section's `w` becomes the blade
      // height and `d` tapers to the edge.
      P(loft(SEC.rect, -S.limbR * 0.45, S.limbR * 2.7, (t) => ({
        w: S.limbR * (1.15 + t * 1.05), d: S.limbR * (0.55 - t * 0.44),
      }), 5), M.metal, 'handR',
        H.held('handR', trs(g.x, hy, gz, 0, 0, -Math.PI / 2)));
      P(torus(S.limbR * 0.55, S.limbR * 0.13, 5, 10), M.cloth, 'handR',
        H.held('handR', trs(g.x, hy, gz, Math.PI / 2, 0, 0)));
    }
  },
  pose(b, t, st, S) {
    const sp = st.speed ?? 0;
    const run = Math.min(1, sp / GAIT.hilichurl.top);
    const ph = gaitPhase(st, t, 2.6 + run * 3.4);
    const sw = Math.sin(ph), sw2 = Math.sin(ph * 2);
    // Lumbering, wide-tracked gait with a heavy vertical bob and a lot of roll.
    b.hips.position.y = S.leg + (run ? -Math.abs(sw2) * S.h * 0.022 : Math.sin(t * 1.7) * S.h * 0.004);
    b.hips.rotation.z = sw * 0.10 * run;
    b.hips.rotation.y = -sw * 0.14 * run;
    b.torso.rotation.x = 0.10 + run * 0.16 + Math.sin(t * 1.9) * 0.02;
    b.torso.rotation.y = sw * 0.16 * run;
    b.head.rotation.x = -0.08 - run * 0.10;
    b.head.rotation.y = Math.sin(t * 0.7) * 0.14 * (1 - run);
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      const d = s < 0 ? sw : -sw;
      b[`thigh${L}`].rotation.x = d * GAIT.hilichurl.amp * run;
      b[`shin${L}`].rotation.x = Math.max(0, -d) * 0.85 * run + 0.06;
      b[`arm${L}`].rotation.x = 0.24 - d * 0.55 * run;
      b[`fore${L}`].rotation.x = 0.42 + Math.max(0, d) * 0.30 * run;
    }
    if (st.attack > 0) {
      // Overhead two-handed swing, the same shape whether it is fists or an axe.
      const a = st.attack;                     // 0..1 through the swing
      const wind = Math.min(1, a / 0.42), hit = Math.max(0, (a - 0.42) / 0.58);
      const e = wind * (1 - hit) ;
      b.torso.rotation.x = 0.10 - e * 0.55 + hit * 0.85;
      b.torso.rotation.y = e * 0.5 - hit * 0.35;
      for (const s of [-1, 1]) {
        const L = s < 0 ? 'L' : 'R';
        b[`arm${L}`].rotation.x = -2.1 * e + 1.1 * hit;
        b[`fore${L}`].rotation.x = 0.9 - 0.7 * hit;
      }
    }
  },
};
const BOW_P = new THREE.Vector3();
const BOW_YAW = 0.30;                  // bow face turned slightly off the body plane

/* --- abyss mage ------------------------------------------------------------- */
KINDS.mage = {
  airborne: true,
  bones: [
    ['root', null], ['hips', 'root'], ['torso', 'hips'], ['head', 'torso'],
    ['armL', 'torso'], ['handL', 'armL'], ['armR', 'torso'], ['handR', 'armR'],
    ['hemA', 'hips'], ['hemB', 'hemA'],
  ],
  dims(def) {
    const h = def.hitbox?.h ?? 2.0;
    return {
      h, float: h * 0.24, torsoH: h * 0.34, headR: h * 0.115,
      shoulderW: h * 0.155, limbR: h * 0.034, arm: h * 0.27, hem: h * 0.50,
    };
  },
  place(b, S) {
    b.hips.position.set(0, S.float + S.hem, 0);
    b.torso.position.set(0, 0, 0);
    b.head.position.set(0, S.torsoH * 0.94, 0);
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      b[`arm${L}`].position.set(s * S.shoulderW, S.torsoH * 0.70, 0);
      b[`hand${L}`].position.set(0, -S.arm, 0);
      b[`arm${L}`].rotation.z = s * 0.55;
      b[`arm${L}`].rotation.x = -0.35;
    }
    b.hemA.position.set(0, 0, 0);
    b.hemB.position.set(0, -S.hem * 0.55, 0);
  },
  parts(P, S, M, def) {
    // No legs: the robe runs to a point and the whole figure hovers. The taper is
    // the silhouette, so it is lofted rather than assembled from cones.
    P(loft(SEC.oct, 0, -S.hem * 0.55, (t) => ({
      w: S.shoulderW * (1.02 + t * 0.72), d: S.shoulderW * (0.95 + t * 0.66),
    }), 6), M.cloth, 'hemA', trs(0, 0, 0), { softBone: 'hemB', softLen: S.hem * 0.55 });
    P(loft(SEC.oct, 0, -S.hem * 0.45, (t) => ({
      w: S.shoulderW * (1.74 - t * 1.60), d: S.shoulderW * (1.61 - t * 1.48),
    }), 6), M.cloth, 'hemB', trs(0, 0, 0));
    // Robe trim rings. `trim`, not `glow`: a 3 cm tube is thinner than the rim is wide, so in
    // the glow material the rim (1.2 of the accent) *is* the whole surface and the three rings
    // photographed as solid white hoops with no tube in them.
    for (let i = 0; i < 3; i++) {
      P(torus(S.shoulderW * (1.10 + i * 0.24), S.limbR * 0.42, 5, 16), M.trim, 'hemA',
        trs(0, -S.hem * 0.13 * (i + 1), 0, Math.PI / 2, 0, 0));
    }
    // Shoulders up to 0.82·torsoH, not all of it. The head bone sits at 0.94·torsoH and the
    // shoulder volume is 0.99·shoulderW *deep* — 0.153·h against a face that reaches 0.117·h —
    // so a full-length torso stands in front of the hood and cuts it off in a flat octagonal
    // line just above the eyes. Which it did: the first version of the face fix below was
    // invisible for exactly this reason, and the model sheet's head crop showed a hood opening
    // with a slab across the bottom two thirds of it. The head cannot be raised out of the way
    // instead, because the torso's top vertices are soft-bound to it and follow.
    P(loft(SEC.oct, 0, S.torsoH * 0.82, (t) => ({
      w: S.shoulderW * (0.95 + Math.sin(t * 2.2) * 0.18), d: S.shoulderW * (0.86 + Math.sin(t * 2.2) * 0.16),
    }), 6), M.body, 'torso', trs(0, 0, 0), { softBone: 'head', softLen: S.torsoH * 0.82 });
    // The hood, and why it is a cowl and not a ball.
    //
    // Everything that makes this a face — the rim, the shadow in the opening, the two
    // eye lights — used to be authored at z ≈ 0.86·headR, while the head volume was a
    // blob reaching 1.46·headR. All three were therefore sealed *inside* their own
    // hood, and the abyss mage had no face: `tools/enemy-cam.mjs`'s model sheet, which
    // photographs the model alone against black, came back with a smooth navy egg and
    // two antennae. Nothing was missing from the scene — the parts were built, bound
    // and lit, and none of them could be seen. (The abyss herald's visor slit had the
    // same bug, showing only the ends that stuck out past the sides of its helm.)
    //
    // So every z below is derived from the front surface of the part behind it, which
    // is the rule the frost wolf's muzzle already obeyed. Dome first: pushed back and
    // flattened in z, its front pole lands at -0.55 + 1.42·0.86 = 0.67·headR. It keeps
    // the lighter `body` value while the skirt below stays `cloth` — two values on one
    // robe is the only thing that stops a near-black design from rendering as a flat
    // cut-out.
    P(blob(S.headR * 1.42, 1.0, 1.05, 0.86, 14), M.body, 'head',
      trs(0, S.headR * 0.10, -S.headR * 0.55));
    P(loft(SEC.oct, 0, S.headR * 1.05, (t) => ({
      w: S.headR * (1.02 - t * 0.86), d: S.headR * (0.98 - t * 0.82),
    }), 5), M.body, 'head', trs(0, S.headR * 0.86, -S.headR * 0.58, 0.34, 0, 0));
    // The shadow in the opening: a dark ball whose front pole (0.30 + 0.72 = 1.02)
    // clears the dome by a third of a head radius, so it reads as a hole and not as a
    // chin. Its silhouette (0.72) sits well inside the dome's (1.42), which is what
    // makes the dome read as framing it.
    P(sphere(S.headR * 0.72, 12), M.dark, 'head', trs(0, -S.headR * 0.02, S.headR * 0.30));
    // The rim, in the middle value, seated on the dome's own silhouette circle:
    // 1.02·headR off the axis the dome's surface is at z 0.30, so the ring is half
    // sunk into it. A rim in `dark` would have merged with the hole it frames.
    P(torus(S.headR * 1.02, S.headR * 0.16, 6, 16), M.cloth, 'head',
      trs(0, -S.headR * 0.02, S.headR * 0.30, 0.22, 0, 0));
    // Eyes. At their own off-axis radius (0.31) the cavity's surface is at z 0.95, so
    // a centre at 1.00 leaves two thirds of each eye outside it and the last third
    // buried, which is what keeps them attached to something.
    //
    // Three parts, not one, and the reason is what the portrait showed: a single `glow`
    // sphere at emissive 1.5 clips to paper white, so the face was two featureless dots
    // with no iris, no pupil and no direction of gaze — the same "blown-out lampshade"
    // the robe trim reads as. The fix for a clipped highlight is a *dark* mark on it, so
    // the glow stays as the socket light behind and the eye itself is the eye material
    // (bright but not clipping, with a sharp specular) carrying a `dark` pupil in front.
    // It also makes the face *provable*: `materials.eye` is removable and used nowhere
    // else on this model, so `tools/enemy-cam.mjs` can hide it and diff the head box —
    // which is why the two eye assertions stop being a free SKIP for this kind
    // ([[drawn-lit-and-invisible]]: an eye nobody can hide is an eye nobody can gate).
    const mEyeZ = 1.00;
    for (const s of [-1, 1]) {
      P(sphere(S.headR * 0.155, 10), M.glow, 'head',
        trs(s * S.headR * 0.30, S.headR * 0.06, S.headR * (mEyeZ - 0.03)));
      P(sphere(S.headR * 0.125, 10), M.eye, 'head',
        trs(s * S.headR * 0.30, S.headR * 0.06, S.headR * (mEyeZ + 0.05), 0, 0, 0, 1, 1.05, 0.72));
      P(sphere(S.headR * 0.048, 8), M.dark, 'head',
        trs(s * S.headR * 0.30, S.headR * 0.055, S.headR * (mEyeZ + 0.14), 0, 0, 0, 1, 1.15, 0.7));
    }
    // Horned crown
    for (const s of [-1, 1]) {
      P(sweep(SEC.lens, (t) => {
        HORN_P.set(s * S.headR * (0.60 + t * 0.55), S.headR * (0.90 + t * 1.35), -S.headR * (0.20 + t * 0.55));
        return { p: HORN_P, w: S.headR * 0.14 * (1 - t * 0.88) + 0.003, d: S.headR * 0.10 * (1 - t * 0.85) + 0.003 };
      }, 7), M.glow, 'head', trs(0, 0, 0));
    }
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      // Wide bell sleeves; the hands are floating orbs, not hands.
      P(loft(SEC.oct, 0, -S.arm, (t) => ({
        w: S.limbR * (1.5 + t * t * 2.4), d: S.limbR * (1.4 + t * t * 2.2),
      }), 5), M.cloth, `arm${L}`, trs(0, 0, 0), { softBone: `hand${L}`, softLen: S.arm });
      // The orb is 10 cm of nothing but accent colour, which `glow` renders as a white ball —
      // `trim` keeps it bright and gives it a specular highlight, i.e. a sphere instead of a dot.
      P(sphere(S.limbR * 1.5, 10), M.trim, `hand${L}`, trs(0, -S.limbR * 1.1, 0));
    }
    void def;
  },
  pose(b, t, st, S) {
    // Hover: a slow figure-of-eight, plus robe sway lagging behind it.
    const bobY = Math.sin(t * 1.15) * S.h * 0.030;
    b.hips.position.y = S.float + S.hem + bobY;
    b.hips.rotation.z = Math.sin(t * 0.83) * 0.06;
    b.torso.rotation.x = Math.sin(t * 0.9) * 0.05;
    b.head.rotation.y = Math.sin(t * 0.55) * 0.22;
    b.hemA.rotation.x = Math.sin(t * 1.15 - 0.6) * 0.10;
    b.hemA.rotation.z = Math.sin(t * 0.83 - 0.5) * 0.09;
    b.hemB.rotation.x = Math.sin(t * 1.15 - 1.3) * 0.14;
    b.hemB.rotation.z = Math.sin(t * 0.83 - 1.1) * 0.12;
    const cast = st.attack > 0 ? Math.sin(st.attack * Math.PI) : 0;
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      b[`arm${L}`].rotation.z = s * (0.55 - cast * 0.30);
      b[`arm${L}`].rotation.x = -0.35 - cast * 0.95 + Math.sin(t * 1.4 + s) * 0.06;
    }
  },
};
const HORN_P = new THREE.Vector3();

/* --- ruin guard ------------------------------------------------------------- */
KINDS.ruinGuard = {
  gait: GAIT.ruinGuard,
  bones: [
    ['root', null], ['hips', 'root'], ['torso', 'hips'], ['head', 'torso'],
    ['shoulderL', 'torso'], ['armL', 'shoulderL'], ['foreL', 'armL'],
    ['shoulderR', 'torso'], ['armR', 'shoulderR'], ['foreR', 'armR'],
    ['thighL', 'hips'], ['shinL', 'thighL'], ['footL', 'shinL'],
    ['thighR', 'hips'], ['shinR', 'thighR'], ['footR', 'shinR'],
  ],
  dims(def) {
    const h = def.hitbox?.h ?? 3.6;
    const headR = h * 0.105;
    return {
      h, leg: h * 0.44, thigh: h * 0.22, shin: h * 0.22,
      torsoH: h * 0.36, headR, shoulderW: h * 0.21,
      waistW: h * 0.135, limbR: h * 0.058, upper: h * 0.23, fore: h * 0.25,
      // The single eye, in head-bone space. It is both the part `parts()` places and
      // the point `weakspot()` exports for `ENEMIES.ruinGuard.weakspot` to mirror —
      // one expression, so the glowing thing the player aims at and the sphere the
      // simulation tests cannot drift apart.
      eye: { y: headR * 0.10, z: headR * 0.66, r: headR * 0.52 },
    };
  },
  // `r` is deliberately wider than the eye itself: the eye is 23 cm across on a 3.6 m
  // machine, and a weak point nobody can hit is the same as no weak point. 2.2× puts the
  // hittable sphere at roughly the width of the head shutter — visibly "the face", not
  // "the shoulder" (which is 1.9 m away from it).
  weakspot: (S) => ({ bone: 'head', local: [0, S.eye.y, S.eye.z], r: S.eye.r * 2.2 }),
  place(b, S) {
    b.hips.position.set(0, S.leg, 0);
    b.torso.position.set(0, 0, 0);
    b.head.position.set(0, S.torsoH * 0.92, S.headR * 0.30);
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      b[`shoulder${L}`].position.set(s * S.shoulderW * 0.86, S.torsoH * 0.70, 0);
      b[`arm${L}`].position.set(s * S.shoulderW * 0.34, -S.limbR * 0.4, 0);
      b[`fore${L}`].position.set(0, -S.upper, 0);
      b[`thigh${L}`].position.set(s * S.waistW * 0.80, 0, 0);
      b[`shin${L}`].position.set(0, -S.thigh, 0);
      b[`foot${L}`].position.set(0, -S.shin, 0);
      b[`arm${L}`].rotation.z = s * 0.12;
      b[`fore${L}`].rotation.x = 0.30;
    }
  },
  parts(P, S, M) {
    // Cylindrical drum torso with a segmented waist — machine, not creature, so
    // everything is a hard-edged revolve with visible plate seams.
    P(loft(SEC.oct, 0, S.torsoH * 0.86, (t) => ({
      w: S.waistW * (1.10 + Math.sin(t * 2.6) * 0.42), d: S.waistW * (0.92 + Math.sin(t * 2.6) * 0.34),
    }), 7), M.metal, 'torso', trs(0, 0, 0), { softBone: 'hips', softLen: S.torsoH });
    P(loft(SEC.oct, 0, -S.torsoH * 0.24, (t) => ({
      w: S.waistW * (1.05 - t * 0.30), d: S.waistW * (0.88 - t * 0.24),
    }), 3), M.dark, 'hips', trs(0, 0, 0));
    for (let i = 0; i < 3; i++) {
      P(torus(S.waistW * (1.16 - i * 0.05), S.limbR * 0.28, 5, 14), M.dark, 'torso',
        trs(0, S.torsoH * (0.16 + i * 0.22), 0, Math.PI / 2, 0, 0));
    }
    // Chest vents
    for (const s of [-1, 1]) {
      P(plate(S.torsoH * 0.30, S.waistW * 0.20, S.waistW * 0.14, S.limbR * 0.22), M.dark,
        'torso', trs(s * S.waistW * 0.42, S.torsoH * 0.34, S.waistW * 0.82, 0.1, 0, 0));
    }
    // Head: the classic single eye on a short stalk, with a shutter hood over it.
    P(loft(SEC.oct, -S.headR * 0.5, S.headR * 0.9, (t) => ({
      w: S.headR * (0.86 + Math.sin(t * 2.0) * 0.30), d: S.headR * (0.80 + Math.sin(t * 2.0) * 0.28),
    }), 5), M.metal, 'head', trs(0, 0, 0));
    // The eye *is* the weak point — see `dims().eye` and `weakspot()` above.
    P(sphere(S.eye.r, 14), M.glow, 'head', trs(0, S.eye.y, S.eye.z));
    P(torus(S.headR * 0.56, S.headR * 0.13, 6, 16), M.dark, 'head',
      trs(0, S.headR * 0.10, S.headR * 0.62, 0.1, 0, 0));
    P(plate(S.headR * 1.3, S.headR * 0.72, S.headR * 0.44, S.headR * 0.12), M.metal, 'head',
      trs(0, S.headR * 0.42, S.headR * 0.30, 1.15, 0, Math.PI / 2));
    // Coolant vent on the nape. Half of it is inside the head hood on purpose: what
    // shows is the rim, which is all a 3.6 m machine seen from behind needs.
    P(sphere(S.headR * 0.40, 12), M.glow, 'head', trs(0, S.headR * 0.30, -S.headR * 0.60));

    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      // Big angular pauldron, then arm segments that get *wider* toward the fist —
      // the ruin guard's punch reads because the mass is at the far end.
      P(loft(SEC.rect, S.limbR * 0.6, -S.limbR * 1.5, (t) => ({
        w: S.shoulderW * (0.46 - t * 0.10), d: S.shoulderW * (0.40 - t * 0.08),
      }), 4), M.metal, `shoulder${L}`, trs(0, 0, 0));
      P(sphere(S.limbR * 1.05, 10), M.dark, `arm${L}`, trs(0, 0, 0));
      P(loft(SEC.oct, 0, -S.upper, (t) => ({
        w: S.limbR * (0.90 + t * 0.24), d: S.limbR * (0.86 + t * 0.22),
      }), 4), M.metal, `arm${L}`, trs(0, 0, 0), { softBone: `fore${L}`, softLen: S.upper });
      P(loft(SEC.rect, 0, -S.fore, (t) => ({
        w: S.limbR * (1.05 + t * 0.55), d: S.limbR * (1.0 + t * 0.50),
      }), 4), M.metal, `fore${L}`, trs(0, 0, 0));
      P(loft(SEC.rect, -S.fore, -S.fore - S.limbR * 1.5, (t) => ({
        w: S.limbR * (1.60 - t * 0.20), d: S.limbR * (1.50 - t * 0.18),
      }), 2), M.dark, `fore${L}`, trs(0, 0, 0));
      // Missile ports on the forearm (missileBarrage has to come from somewhere).
      for (let i = 0; i < 2; i++) {
        P(torus(S.limbR * 0.24, S.limbR * 0.07, 5, 10), M.glow, `fore${L}`,
          trs(s * S.limbR * 0.9, -S.fore * (0.34 + i * 0.30), 0, 0, s * Math.PI / 2, 0));
      }
      // Legs: reverse-jointed pistons.
      P(loft(SEC.oct, 0, -S.thigh, (t) => ({
        w: S.limbR * (1.30 - t * 0.30), d: S.limbR * (1.20 - t * 0.26),
      }), 4), M.metal, `thigh${L}`, trs(0, 0, 0), { softBone: `shin${L}`, softLen: S.thigh });
      P(loft(SEC.oct, 0, -S.shin, (t) => ({
        w: S.limbR * (0.98 - t * 0.24), d: S.limbR * (0.92 - t * 0.20),
      }), 4), M.dark, `shin${L}`, trs(0, 0, 0), { softBone: `foot${L}`, softLen: S.shin });
      P(sphere(S.limbR * 1.05, 10), M.dark, `shin${L}`, trs(0, 0, 0));
      // thigh+shin puts the ankle bone on the ground, so the foot goes *up* from
      // it. Lofted downward it sank through the terrain and showed as a pale
      // sliver under the mech.
      P(loft(SEC.rect, S.limbR * 0.9, 0, () => ({ w: S.limbR * 1.5, d: S.limbR * 2.2 }), 2),
        M.metal, `foot${L}`, trs(0, 0, S.limbR * 0.5));
    }
  },
  pose(b, t, st, S) {
    const sp = st.speed ?? 0;
    const run = Math.min(1, sp / GAIT.ruinGuard.top);
    const ph = gaitPhase(st, t, 1.7 + run * 1.6);
    const sw = Math.sin(ph);
    // Slow, heavy, and it *lands*: the vertical drop is on |sin(2ph)| so both
    // footfalls thump rather than the body floating on a sine.
    b.hips.position.y = S.leg - Math.abs(Math.sin(ph * 2)) * S.h * 0.020 * run;
    b.hips.rotation.z = sw * 0.05 * run;
    b.torso.rotation.y = -sw * 0.10 * run;
    b.torso.rotation.x = 0.02 + run * 0.05;
    b.head.rotation.x = -0.04;
    b.head.rotation.y = Math.sin(t * 0.5) * 0.30 * (1 - run);
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      const d = s < 0 ? sw : -sw;
      b[`thigh${L}`].rotation.x = d * GAIT.ruinGuard.amp * run;
      b[`shin${L}`].rotation.x = Math.max(0, -d) * 0.62 * run;
      b[`shoulder${L}`].rotation.x = -d * 0.16 * run;
      b[`arm${L}`].rotation.x = -d * 0.22 * run;
      b[`fore${L}`].rotation.x = 0.30 + Math.max(0, d) * 0.18 * run;
    }
    if (st.attack > 0) {
      const a = st.attack;
      const wind = Math.min(1, a / 0.5), hit = Math.max(0, (a - 0.5) / 0.5);
      const e = wind * (1 - hit);
      b.torso.rotation.x = 0.02 - e * 0.30 + hit * 0.42;
      for (const s of [-1, 1]) {
        const L = s < 0 ? 'L' : 'R';
        b[`shoulder${L}`].rotation.x = -1.5 * e + 0.5 * hit;
        b[`arm${L}`].rotation.x = -0.9 * e + 0.9 * hit;
        b[`fore${L}`].rotation.x = 0.3 + 0.9 * e - 0.6 * hit;
      }
    }
  },
};

/* --- frost wolf ------------------------------------------------------------- */
KINDS.wolf = {
  gait: GAIT.wolf,
  bones: [
    ['root', null], ['hips', 'root'], ['spine', 'hips'], ['chest', 'spine'],
    ['neck', 'chest'], ['head', 'neck'], ['jaw', 'head'],
    ['tailA', 'hips'], ['tailB', 'tailA'], ['tailC', 'tailB'],
    ['fThighL', 'chest'], ['fShinL', 'fThighL'], ['fThighR', 'chest'], ['fShinR', 'fThighR'],
    ['bThighL', 'hips'], ['bShinL', 'bThighL'], ['bThighR', 'hips'], ['bShinR', 'bThighR'],
  ],
  dims(def) {
    const h = def.hitbox?.h ?? 1.3;
    return {
      h, back: h * 0.62, bodyLen: h * 0.94, chestR: h * 0.225,
      neck: h * 0.25, headR: h * 0.17, leg: h * 0.29, shin: h * 0.30,
      // `tail` is one of three segments, so the tail is 3× this. At 0.22 it was
      // 0.66·h against a 0.98·h body — two thirds of the animal's length, and with
      // six 17 cm tufts per segment on top of that it photographed as a spiked
      // mace trailing behind a dolphin. A wolf's tail is a bit under half its body.
      limbR: h * 0.052, tail: h * 0.15,
    };
  },
  place(b, S) {
    // Quadruped: the root sits at the hips and the spine runs *forward*, which is
    // why every part below is authored on -Y with a +Z offset rather than the
    // vertical stacks the bipeds use.
    b.hips.position.set(0, S.back, -S.bodyLen * 0.42);
    b.spine.position.set(0, 0, S.bodyLen * 0.38);
    b.chest.position.set(0, S.back * 0.06, S.bodyLen * 0.46);
    b.neck.position.set(0, S.chestR * 0.42, S.chestR * 0.62);
    b.head.position.set(0, S.neck * 0.30, S.neck * 0.78);
    b.jaw.position.set(0, -S.headR * 0.34, S.headR * 0.30);
    b.tailA.position.set(0, S.chestR * 0.42, -S.chestR * 0.52);
    b.tailB.position.set(0, 0, -S.tail);
    b.tailC.position.set(0, 0, -S.tail);
    // Hanging, not level. Held out horizontally the bushy tail sits at exactly
    // body height and the same size as the head, and the animal reads as
    // two-headed from the side.
    b.tailA.rotation.x = -1.05;
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      b[`fThigh${L}`].position.set(s * S.chestR * 0.60, -S.chestR * 0.42, S.chestR * 0.16);
      b[`fShin${L}`].position.set(0, -S.leg, 0);
      b[`bThigh${L}`].position.set(s * S.chestR * 0.62, -S.chestR * 0.36, -S.chestR * 0.10);
      b[`bShin${L}`].position.set(0, -S.leg, 0);
      b[`fThigh${L}`].rotation.x = 0.12;
      b[`fShin${L}`].rotation.x = -0.16;
      b[`bThigh${L}`].rotation.x = -0.34;
      b[`bShin${L}`].rotation.x = 0.52;
    }
  },
  parts(P, S, M) {
    // Body as one swept tube from *behind the hip joint* to the shoulder.
    //
    // The first version started at spine-z −0.10·bodyLen. The hips bone sits at
    // −0.38·bodyLen (the spine runs forward from it), and the tail and both hind
    // legs hang off the hips — so the rump, the haunches and the tail were a
    // separate floating cluster with 0.28·bodyLen (34 cm) of daylight between
    // them and the barrel. On a spine authored to run *forward*, the sweep has to
    // start behind the rearmost bone it is supposed to cover, not at the origin.
    //
    // Note also which axis is which: swept along +Z with an X roll reference, the
    // section's `w` becomes the part's **height** and `d` its **width** (see the
    // roll-reference note in gfx/solid.js). The old profile read as "0.74 wide,
    // 1.06× deeper", and was really 0.74 tall and slightly wider than tall.
    const lobe = (t, c, s) => Math.exp(-(((t - c) / s) ** 2));
    // Where the sweep starts and stops is not free: it has to cover the bones that
    // carry geometry and stop where the next part takes over. In spine-local Z the
    // stations are hips −0.38, hind thigh −0.40, tail root −0.50, chest +0.46,
    // front thigh +0.50, neck base +0.61 (all ×bodyLen). So the barrel runs from
    // −0.46 (just behind the haunches, the tail covers the rest) to +0.58 (the
    // neck base) — a span of 1.04·bodyLen and no more.
    //
    // 1.30 was the first attempt at the too-short original, and overshooting is
    // just as visible as falling short: 0.34·bodyLen of barrel stuck out *past the
    // head*, the front legs — which hang off the chest, not off the sweep — ended
    // up under the middle of the body beside the hind pair, and the animal
    // photographed as a two-legged dolphin. Both ends of a sweep are a claim about
    // a bone.
    const bodyZ = (t) => -S.bodyLen * 0.46 + t * S.bodyLen * 1.04;
    /** The inverse: which `t` of the sweep sits at a spine-local Z. */
    const bodyT = (z) => (z / S.bodyLen + 0.46) / 1.04;
    // Three lobes instead of one sine, because a single sine cannot be deep at both
    // ends and tucked in the middle: haunches over the hip joint (t 0.12), waist
    // between, ribcage at t 0.74 where the shoulders are, then down to the neck.
    const bodyY = (t) => S.chestR * (0.03 + 0.07 * Math.sin(t * Math.PI));
    const bodyH = (t) => S.chestR * (0.46 + 0.52 * lobe(t, 0.12, 0.16) + 0.68 * lobe(t, 0.74, 0.20));
    const bodyW = (t) => bodyH(t) * (1.05 + 0.22 * lobe(t, 0.12, 0.18));
    P(sweep(SEC.lens, (t) => {
      WOLF_P.set(0, bodyY(t), bodyZ(t));
      return { p: WOLF_P, w: bodyH(t), d: bodyW(t), ref: X_REF };
    }, 16), M.body, 'spine', trs(0, 0, 0));
    // Pale underside, derived from the body profile rather than authored beside
    // it: a belly pad that sits *on* the surface at every point, hugging the
    // bottom of the barrel from between the hind legs to between the front ones.
    // It used to be a tall narrow fin (`w` 0.56 tall, `d` 0.24 wide, because of
    // the axis swap above) buried inside the barrel, showing a sliver at best —
    // the wolf read as one flat white mass from the side, which is the exact
    // thing a second body tone exists to prevent.
    // Sunk so its *bottom* is level with the barrel's, 5 mm proud of the surface to
    // keep it out of a z-fight. Sitting 0.14·chestR lower than the belly it was
    // supposed to hug, it hung out below the barrel as a hard-edged trapezoidal
    // skirt — a panel the animal was wearing rather than its own underside.
    P(sweep(SEC.lens, (u) => {
      const t = 0.08 + u * 0.84;   // between the hind paws and the front ones
      WOLF_P.set(0, bodyY(t) - bodyH(t) + S.chestR * 0.12, bodyZ(t));
      return { p: WOLF_P, w: S.chestR * 0.14, d: bodyW(t) * 0.74, ref: X_REF };
    }, 10), M.body2, 'spine', trs(0, 0, 0));
    // Dark saddle along the back, likewise riding the profile. A white wolf under
    // a cel ramp is one untextured mass — the toon shell only draws an outline on
    // the *silhouette*, so a boundary in the middle of the body can only come
    // from albedo. This is the wolf's dorsal fur, and it is what makes the back
    // read as a back at any distance.
    // `body2` is 0.66× the body colour (see the palette in `enemyMaterials`), so this
    // is a mid grey on a white animal — but only if it is wide enough to be seen from
    // the side. At 0.56·bodyW it was a thin crest on top of the spine, invisible from
    // anywhere but directly above; 0.78 carries it over the shoulders and down onto
    // the upper flank, which is where a wolf's dark dorsal fur actually sits.
    P(sweep(SEC.lens, (u) => {
      const t = 0.06 + u * 0.88;   // rump to withers
      WOLF_P.set(0, bodyY(t) + bodyH(t) - S.chestR * 0.14, bodyZ(t));
      return { p: WOLF_P, w: S.chestR * 0.20, d: bodyW(t) * 0.78, ref: X_REF };
    }, 12), M.body2, 'spine', trs(0, 0, 0));
    // Ruff at the shoulders: a mane of chunky tufts, the wolf's read at distance.
    // Seated on the ribcage's own radius (`bodyT` gives the chest bone's station in
    // the sweep) so the tufts stand out of the surface instead of starting half a
    // radius inside it.
    //
    // Not a full ring, and not 23 cm long. A closed ring puts four tufts pointing
    // *down* through the animal's own chest and two forward over the neck, and on
    // the model sheet the withers were a pile of angular flakes that read as damage.
    // The mane covers the top and the sides down to the shoulder joint — `sa` is the
    // vertical component of the ring, so the bottom third is simply skipped.
    const ruffT = bodyT(S.bodyLen * 0.46);   // the chest bone's own station
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      if (sa < -0.40) continue;
      P(spike(S.chestR * 0.52, S.chestR * 0.20, 5), M.body2, 'chest',
        along(ca * bodyW(ruffT) * 0.84, sa * bodyH(ruffT) * 0.84, -S.chestR * 0.16,
          ca, sa, -0.62));
    }
    P(loft(SEC.lens, 0, S.neck, (t) => ({
      w: S.chestR * (0.62 - t * 0.18), d: S.chestR * (0.66 - t * 0.20),
    }), 4), M.body, 'neck', trs(0, 0, 0, -1.1, 0, 0), { softBone: 'head', softLen: S.neck });
    // Head: skull blob plus a long lofted muzzle, which is the whole silhouette.
    P(blob(S.headR, 1.0, 0.92, 1.05, 12), M.body, 'head', trs(0, 0, 0));
    // Muzzle. Shorter and much more tapered than it was: 1.45·headR long at a
    // 0.62 → 0.30 taper is a rectangular bar sticking out of a ball, which is what
    // the model sheet showed — a brick for a nose.
    P(loft(SEC.lens, 0, S.headR * 1.20, (t) => ({
      w: S.headR * (0.56 - t * 0.34), d: S.headR * (0.52 - t * 0.30),
    }), 5), M.body, 'head', trs(0, -S.headR * 0.12, S.headR * 0.42, Math.PI / 2 - 0.14, 0, 0));
    P(sphere(S.headR * 0.15, 8), M.dark, 'head', trs(0, -S.headR * 0.06, S.headR * 1.52));
    P(loft(SEC.lens, 0, S.headR * 1.15, (t) => ({
      w: S.headR * (0.44 - t * 0.24), d: S.headR * (0.20 - t * 0.10),
    }), 4), M.body2, 'jaw', trs(0, 0, 0, Math.PI / 2 - 0.05, 0, 0));
    // Eyes. Two things were in front of them, not one: the skull surface at x 0.46
    // has curved back to z 0.89 (the authored z 0.66 plus a 0.7-squashed radius only
    // reached 0.77), *and* the muzzle's base section spans x ±0.56 by y −0.64…0.40,
    // which swallows anything at y 0.24. So they move up over the muzzle's back and
    // out onto the solved surface, with a dark pupil in front — a cyan eye material on
    // a pale frost wolf is a bright button until something reads as looking out of it.
    const wEX = 0.44, wEY = 0.44;
    const wEZ = onBlob(1.0, 0.92, 1.05, wEX, wEY);
    for (const s of [-1, 1]) {
      P(sphere(S.headR * 0.15, 8), M.eye, 'head',
        trs(s * S.headR * wEX, S.headR * wEY, S.headR * wEZ, 0, 0, 0, 1, 1.1, 0.7));
      P(sphere(S.headR * 0.07, 8), M.dark, 'head',
        trs(s * S.headR * wEX, S.headR * wEY, S.headR * (wEZ + 0.11), 0, 0, 0, 1, 1.1, 0.7));
      // Ears: flat triangles, swept back.
      P(plate(S.headR * 0.85, S.headR * 0.30, S.headR * 0.04, S.headR * 0.05), M.body,
        'head', trs(s * S.headR * 0.52, S.headR * 0.66, -S.headR * 0.20, -0.35, 0, s * 0.35));
      // Frost accents along the flank, placed *on the profile* rather than at a
      // constant height and width. At the authored y 0.52·chestR and x
      // 0.70·chestR they were inside the barrel — the ribcage alone is
      // 1.14·chestR tall — so the one element marker on an ice creature was
      // three spikes of buried geometry.
      // Ice shards along the upper flank: the one element marker on an ice creature,
      // so they have to be big enough to see. At 0.34·chestR long and 0.72 of the
      // half-width out they were slivers poking through the surface — 8 px of cyan
      // on the model sheet. Out at 0.86 and half again as long they break the
      // silhouette, which is the only place a toon outline can draw them.
      for (let i = 0; i < 3; i++) {
        const t = 0.34 + i * 0.19;
        P(spike(S.chestR * 0.50, S.chestR * 0.13, 4), M.glow, 'spine',
          trs(s * bodyW(t) * 0.86, bodyY(t) + bodyH(t) * 0.58, bodyZ(t),
            -0.5, 0, s * 0.8));
      }
    }
    // Tail: three tapering segments on a bone chain so it can whip, each ringed
    // with fur tufts. Bare lofted tubes read as a segmented mechanical antenna —
    // the tufts are what make it brush.
    const seg = (bone, r0, r1) => {
      P(loft(SEC.lens, 0, -S.tail, (t) => ({
        w: r0 + (r1 - r0) * t, d: (r0 + (r1 - r0) * t) * 1.1,
      }), 4), M.body, bone, trs(0, 0, 0, Math.PI / 2, 0, 0));
      // Two short rings rather than one long one: fur is dense and shallow, and a
      // ring of 1.6-radius spikes is a sea urchin. Staggered by half a step so the
      // silhouette has no gaps between tufts.
      for (let ring = 0; ring < 2; ring++) {
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2 + 0.4 + ring * (Math.PI / 7);
          const ca = Math.cos(a), sa = Math.sin(a);
          const rr = r0 + (r1 - r0) * (ring ? 0.75 : 0.25);
          P(spike(rr * 0.95, rr * 0.42, 4), M.body2, bone,
            along(ca * rr * 0.78, sa * rr * 0.78, -S.tail * (ring ? 0.75 : 0.25),
              ca, sa, -0.85));
        }
      }
    };
    seg('tailA', S.chestR * 0.36, S.chestR * 0.30);
    seg('tailB', S.chestR * 0.30, S.chestR * 0.22);
    seg('tailC', S.chestR * 0.22, S.chestR * 0.07);
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      for (const [F, kneeSign] of [['f', 1], ['b', -1]]) {
        P(loft(SEC.lens, 0, -S.leg, (t) => ({
          w: S.limbR * (1.35 - t * 0.45), d: S.limbR * (1.45 - t * 0.50),
        }), 4), M.body, `${F}Thigh${L}`, trs(0, 0, 0),
        { softBone: `${F}Shin${L}`, softLen: S.leg });
        // Lower legs in the deep value. On a white wolf the pale body2 underside
        // and the pale legs merged into one mass and the animal read as a pig;
        // dark socks are what pull four legs out of the silhouette.
        P(loft(SEC.lens, 0, -S.shin, (t) => ({
          w: S.limbR * (0.90 - t * 0.30), d: S.limbR * (0.95 - t * 0.32),
        }), 4), M.dark, `${F}Shin${L}`, trs(0, 0, 0));
        // Paw
        P(blob(S.limbR * 1.15, 0.9, 0.62, 1.45, 8), M.dark, `${F}Shin${L}`,
          trs(0, -S.shin, S.limbR * 0.45 * kneeSign));
      }
    }
  },
  pose(b, t, st, S) {
    const sp = st.speed ?? 0;
    const run = Math.min(1, sp / GAIT.wolf.top);
    const ph = gaitPhase(st, t, 3.0 + run * 6.0);
    const sw = Math.sin(ph);
    // Bound gait: the front pair and the back pair move together and out of phase
    // with each other, with the spine flexing between them. A trot (diagonal
    // pairs) reads as a horse; a bound reads as a wolf.
    b.hips.position.y = S.back + Math.sin(ph * 2) * S.h * 0.030 * run;
    b.spine.rotation.x = -sw * 0.16 * run;
    b.chest.rotation.x = sw * 0.20 * run;
    b.neck.rotation.x = -0.10 - run * 0.24 - sw * 0.10 * run;
    b.head.rotation.x = 0.06 + run * 0.20;
    b.head.rotation.y = Math.sin(t * 0.6) * 0.24 * (1 - run);
    b.jaw.rotation.x = 0.10 + (st.attack > 0 ? Math.sin(st.attack * Math.PI) * 0.55 : run * 0.22);
    // Tail: a lagging chain, which is all a tail ever needs.
    b.tailA.rotation.x = -1.05 + run * 0.55 + Math.sin(t * 2.2) * 0.10;
    b.tailA.rotation.y = Math.sin(t * 2.6) * 0.20;
    b.tailB.rotation.y = Math.sin(t * 2.6 - 0.7) * 0.26;
    b.tailC.rotation.y = Math.sin(t * 2.6 - 1.4) * 0.30;
    b.tailB.rotation.x = Math.sin(t * 2.2 - 0.6) * 0.14;
    b.tailC.rotation.x = Math.sin(t * 2.2 - 1.2) * 0.16;
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      const fd = sw, bd = -sw;
      b[`fThigh${L}`].rotation.x = 0.12 + fd * (GAIT.wolf.amp + 0.03) * run;
      b[`fShin${L}`].rotation.x = -0.16 - Math.max(0, fd) * 0.80 * run;
      b[`bThigh${L}`].rotation.x = -0.34 + bd * (GAIT.wolf.amp - 0.02) * run;
      b[`bShin${L}`].rotation.x = 0.52 + Math.max(0, -bd) * 0.70 * run;
    }
    if (st.attack > 0) {
      // Pounce: rear up, then snap forward and down.
      const a = st.attack;
      const up = Math.min(1, a / 0.4), down = Math.max(0, (a - 0.4) / 0.6);
      b.spine.rotation.x = -up * (1 - down) * 0.5 + down * 0.35;
      b.neck.rotation.x = -0.10 - up * (1 - down) * 0.5 + down * 0.5;
      for (const s of [-1, 1]) {
        const L = s < 0 ? 'L' : 'R';
        b[`fThigh${L}`].rotation.x = 0.12 - up * (1 - down) * 1.3 + down * 0.9;
        b[`fShin${L}`].rotation.x = -0.16 - up * (1 - down) * 0.9;
      }
    }
  },
};
const WOLF_P = new THREE.Vector3();

/* --- geo vishap ------------------------------------------------------------- */
KINDS.vishap = {
  gait: GAIT.vishap,
  bones: [
    ['root', null], ['hips', 'root'], ['spine', 'hips'], ['chest', 'spine'],
    ['neck', 'chest'], ['head', 'neck'], ['jaw', 'head'],
    ['tailA', 'hips'], ['tailB', 'tailA'], ['tailC', 'tailB'], ['tailD', 'tailC'],
    ['armL', 'chest'], ['armR', 'chest'],
    ['thighL', 'hips'], ['shinL', 'thighL'], ['footL', 'shinL'],
    ['thighR', 'hips'], ['shinR', 'thighR'], ['footR', 'shinR'],
  ],
  dims(def) {
    const h = def.hitbox?.h ?? 2.2;
    return {
      h, hipY: h * 0.48, torso: h * 0.58, chestR: h * 0.170,
      neck: h * 0.30, headR: h * 0.140, thigh: h * 0.24, shin: h * 0.22,
      limbR: h * 0.050, tail: h * 0.26, arm: h * 0.20,
    };
  },
  place(b, S) {
    // Bipedal but horizontal: the torso leans forward over the hips and the tail
    // counterweights it, so the hip bone is the pivot for the whole animal.
    b.hips.position.set(0, S.hipY, 0);
    b.spine.position.set(0, S.chestR * 0.10, S.torso * 0.30);
    b.chest.position.set(0, S.chestR * 0.10, S.torso * 0.42);
    b.neck.position.set(0, S.chestR * 0.46, S.chestR * 0.52);
    b.head.position.set(0, S.neck * 0.42, S.neck * 0.66);
    b.jaw.position.set(0, -S.headR * 0.30, S.headR * 0.20);
    b.tailA.position.set(0, S.chestR * 0.24, -S.chestR * 0.62);
    for (const n of ['tailB', 'tailC', 'tailD']) b[n].position.set(0, 0, -S.tail);
    b.tailA.rotation.x = -0.30;
    b.tailB.rotation.x = 0.12;
    b.tailC.rotation.x = 0.22;
    b.tailD.rotation.x = 0.26;
    b.spine.rotation.x = 0.10;
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      b[`arm${L}`].position.set(s * S.chestR * 0.72, -S.chestR * 0.10, S.chestR * 0.20);
      b[`arm${L}`].rotation.set(0.6, 0, s * 0.7);
      b[`thigh${L}`].position.set(s * S.chestR * 0.62, 0, 0);
      b[`shin${L}`].position.set(0, -S.thigh, 0);
      b[`foot${L}`].position.set(0, -S.shin, 0);
      b[`thigh${L}`].rotation.x = -0.42;
      b[`shin${L}`].rotation.x = 0.78;
      b[`foot${L}`].rotation.x = -0.36;
    }
  },
  parts(P, S, M) {
    P(sweep(SEC.lens, (t) => {
      VIS_P.set(0, Math.sin(t * Math.PI) * S.chestR * 0.14, -S.torso * 0.34 + t * S.torso * 0.94);
      const w = S.chestR * (0.78 + Math.sin(t * 2.7) * 0.30);
      return { p: VIS_P, w, d: w * (1.22 - t * 0.14), ref: X_REF };
    }, 12), M.body, 'spine', trs(0, 0, 0), { softBone: 'chest', softLen: S.torso });
    P(sweep(SEC.lens, (t) => {
      VIS_P.set(0, -S.chestR * 0.62, -S.torso * 0.20 + t * S.torso * 0.78);
      const w = S.chestR * (0.54 + Math.sin(t * 2.7) * 0.18);
      return { p: VIS_P, w, d: w * 0.40, ref: X_REF };
    }, 8), M.body2, 'spine', trs(0, 0, 0));
    // Dorsal plates: the rock-armour read. Sizes peak over the hips.
    for (let i = 0; i < 7; i++) {
      const u = i / 6;
      const sz = 0.55 + Math.sin(u * Math.PI) * 0.85;
      P(plate(S.chestR * 0.60 * sz, S.chestR * 0.24 * sz, S.chestR * 0.05, S.chestR * 0.09),
        M.accent, 'spine',
        trs(0, S.chestR * 0.86, -S.torso * 0.26 + u * S.torso * 0.92, -0.35, 0, 0));
    }
    P(loft(SEC.lens, 0, S.neck, (t) => ({
      w: S.chestR * (0.56 - t * 0.16), d: S.chestR * (0.60 - t * 0.18),
    }), 4), M.body, 'neck', trs(0, 0, 0, -0.9, 0, 0), { softBone: 'head', softLen: S.neck });
    // Head: armoured wedge with the drill horn that drillCharge implies.
    P(blob(S.headR, 1.05, 0.86, 1.15, 12), M.body, 'head', trs(0, 0, 0));
    P(loft(SEC.rect, 0, S.headR * 1.05, (t) => ({
      w: S.headR * (0.62 - t * 0.26), d: S.headR * (0.46 - t * 0.18),
    }), 4), M.body, 'head', trs(0, -S.headR * 0.16, S.headR * 0.50, Math.PI / 2, 0, 0));
    P(sweep(SEC.oct, (t) => {
      VIS_P.set(0, S.headR * (0.30 + t * 0.30), S.headR * (0.60 + t * 1.35));
      return { p: VIS_P, w: S.headR * 0.24 * (1 - t * 0.94) + 0.004, d: S.headR * 0.24 * (1 - t * 0.94) + 0.004,
        roll: t * 5.6 };
    }, 10), M.accent, 'head', trs(0, 0, 0));
    P(loft(SEC.lens, 0, S.headR * 0.85, (t) => ({
      w: S.headR * (0.46 - t * 0.22), d: S.headR * (0.18 - t * 0.08),
    }), 4), M.body2, 'jaw', trs(0, 0, 0, Math.PI / 2, 0, 0));
    // Eyes, on the solved skull surface instead of a constant z: at x 0.60 the wedge
    // has curved back to z 0.87, so the authored 0.46 put both of them inside their own
    // head, and y 0.28 was under the snout's top face (−0.16 + 0.46) as well. 0 px of
    // eye reached the portrait. Pupil in front for the same reason as the wolf's.
    const vEX = 0.58, vEY = 0.42;
    const vEZ = onBlob(1.05, 0.86, 1.15, vEX, vEY);
    for (const s of [-1, 1]) {
      P(sphere(S.headR * 0.14, 8), M.eye, 'head',
        trs(s * S.headR * vEX, S.headR * vEY, S.headR * vEZ, 0, 0, 0, 1, 1.2, 0.7));
      P(sphere(S.headR * 0.065, 8), M.dark, 'head',
        trs(s * S.headR * vEX, S.headR * vEY, S.headR * (vEZ + 0.10), 0, 0, 0, 1, 1.2, 0.7));
      P(spike(S.headR * 0.62, S.headR * 0.14, 5), M.accent, 'head',
        trs(s * S.headR * 0.62, S.headR * 0.52, -S.headR * 0.30, -0.5, 0, s * 0.6));
      const L = s < 0 ? 'L' : 'R';
      // Small forelimbs, three claws each.
      P(loft(SEC.lens, 0, -S.arm, (t) => ({
        w: S.limbR * (1.0 - t * 0.34), d: S.limbR * (1.05 - t * 0.36),
      }), 4), M.body, `arm${L}`, trs(0, 0, 0));
      for (let c = -1; c <= 1; c++) {
        P(spike(S.limbR * 0.9, S.limbR * 0.20, 4), M.bone, `arm${L}`,
          trs(c * S.limbR * 0.42, -S.arm, 0, 2.2, 0, c * 0.28));
      }
      // Digitigrade legs.
      P(loft(SEC.lens, 0, -S.thigh, (t) => ({
        w: S.limbR * (1.85 - t * 0.60), d: S.limbR * (1.95 - t * 0.65),
      }), 4), M.body, `thigh${L}`, trs(0, 0, 0), { softBone: `shin${L}`, softLen: S.thigh });
      P(loft(SEC.lens, 0, -S.shin, (t) => ({
        w: S.limbR * (1.10 - t * 0.44), d: S.limbR * (1.15 - t * 0.46),
      }), 4), M.body2, `shin${L}`, trs(0, 0, 0), { softBone: `foot${L}`, softLen: S.shin });
      P(blob(S.limbR * 1.35, 1.0, 0.55, 1.55, 8), M.body2, `foot${L}`,
        trs(0, -S.limbR * 0.3, S.limbR * 0.55));
      for (let c = -1; c <= 1; c++) {
        P(spike(S.limbR * 0.85, S.limbR * 0.22, 4), M.bone, `foot${L}`,
          trs(c * S.limbR * 0.55, -S.limbR * 0.35, S.limbR * 1.35, 1.9, 0, c * 0.3));
      }
    }
    const seg = (bone, r0, r1, plates) => {
      P(loft(SEC.lens, 0, -S.tail, (t) => ({
        w: r0 + (r1 - r0) * t, d: (r0 + (r1 - r0) * t) * 1.08,
      }), 5), M.body, bone, trs(0, 0, 0, Math.PI / 2, 0, 0),
      { softBone: bone === 'tailD' ? undefined : `tail${String.fromCharCode(bone.charCodeAt(4) + 1)}`,
        softLen: S.tail });
      if (plates) {
        for (let i = 0; i < 2; i++) {
          P(plate(S.chestR * 0.34, S.chestR * 0.13, S.chestR * 0.03, S.chestR * 0.06), M.accent,
            bone, trs(0, r0 * 0.9, -S.tail * (0.25 + i * 0.42), -0.3, 0, 0));
        }
      }
    };
    seg('tailA', S.chestR * 0.52, S.chestR * 0.44, true);
    seg('tailB', S.chestR * 0.44, S.chestR * 0.32, true);
    seg('tailC', S.chestR * 0.32, S.chestR * 0.19, true);
    seg('tailD', S.chestR * 0.19, S.chestR * 0.03, false);
  },
  pose(b, t, st, S) {
    const sp = st.speed ?? 0;
    const run = Math.min(1, sp / GAIT.vishap.top);
    const ph = gaitPhase(st, t, 2.4 + run * 3.2);
    const sw = Math.sin(ph);
    b.hips.position.y = S.hipY - Math.abs(Math.sin(ph * 2)) * S.h * 0.024 * run;
    b.hips.rotation.y = -sw * 0.10 * run;
    b.spine.rotation.x = 0.10 + run * 0.10;
    b.spine.rotation.y = sw * 0.12 * run;
    b.chest.rotation.y = sw * 0.10 * run;
    b.neck.rotation.x = -0.10 - run * 0.16 + Math.sin(t * 1.3) * 0.05;
    b.head.rotation.x = 0.10 + run * 0.14;
    b.head.rotation.y = Math.sin(t * 0.62) * 0.22 * (1 - run);
    b.jaw.rotation.x = 0.08 + (st.attack > 0 ? Math.sin(st.attack * Math.PI) * 0.5 : 0);
    const lag = [0, 0.55, 1.1, 1.65];
    ['tailA', 'tailB', 'tailC', 'tailD'].forEach((n, i) => {
      b[n].rotation.y = Math.sin(t * 1.9 - lag[i]) * (0.14 + i * 0.05) + (st.attack > 0 ? Math.sin(st.attack * Math.PI * 2 - lag[i]) * 0.45 : 0);
    });
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      const d = s < 0 ? sw : -sw;
      b[`thigh${L}`].rotation.x = -0.42 + d * GAIT.vishap.amp * run;
      b[`shin${L}`].rotation.x = 0.78 - Math.max(0, d) * 0.45 * run;
      b[`foot${L}`].rotation.x = -0.36 + Math.max(0, -d) * 0.40 * run;
      b[`arm${L}`].rotation.x = 0.6 - d * 0.30 * run;
    }
  },
};
const VIS_P = new THREE.Vector3();

/* --- abyss herald ----------------------------------------------------------- */
KINDS.herald = {
  airborne: true,
  bones: [
    ['root', null], ['hips', 'root'], ['torso', 'hips'], ['chest', 'torso'], ['head', 'chest'],
    ['shoulderL', 'chest'], ['armL', 'shoulderL'], ['foreL', 'armL'],
    ['shoulderR', 'chest'], ['armR', 'shoulderR'], ['foreR', 'armR'],
    ['hemA', 'hips'], ['hemB', 'hemA'], ['hemC', 'hemB'],
  ],
  dims(def) {
    const h = def.hitbox?.h ?? 3.2;
    return {
      // Broad and heavy — a boss silhouette. Narrow shoulders on a tapered robe
      // read as a chess bishop no matter how tall the figure is.
      h, float: h * 0.16, torsoH: h * 0.32, headR: h * 0.095,
      shoulderW: h * 0.265, limbR: h * 0.058, upper: h * 0.23, fore: h * 0.25,
      hem: h * 0.52,
    };
  },
  place(b, S) {
    b.hips.position.set(0, S.float + S.hem, 0);
    b.torso.position.set(0, 0, 0);
    b.chest.position.set(0, S.torsoH * 0.52, 0);
    b.head.position.set(0, S.torsoH * 0.52 + S.headR * 0.9, 0);
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      b[`shoulder${L}`].position.set(s * S.shoulderW * 0.84, S.torsoH * 0.20, 0);
      b[`arm${L}`].position.set(s * S.shoulderW * 0.34, -S.limbR, 0);
      b[`fore${L}`].position.set(0, -S.upper, 0);
      b[`arm${L}`].rotation.z = s * 0.36;
      b[`arm${L}`].rotation.x = -0.20;
      b[`fore${L}`].rotation.x = 0.42;
    }
    b.hemA.position.set(0, 0, 0);
    b.hemB.position.set(0, -S.hem * 0.36, 0);
    b.hemC.position.set(0, -S.hem * 0.34, 0);
  },
  parts(P, S, M) {
    // Robe in three lofted stages on a bone chain, so it can billow.
    const stage = (bone, y, w0, w1, child) => P(loft(SEC.oct, 0, y, (t) => ({
      w: w0 + (w1 - w0) * t, d: (w0 + (w1 - w0) * t) * 0.90,
    }), 6), M.cloth, bone, trs(0, 0, 0), child ? { softBone: child, softLen: Math.abs(y) } : undefined);
    stage('hemA', -S.hem * 0.36, S.shoulderW * 0.86, S.shoulderW * 1.10, 'hemB');
    stage('hemB', -S.hem * 0.34, S.shoulderW * 1.10, S.shoulderW * 1.42, 'hemC');
    stage('hemC', -S.hem * 0.30, S.shoulderW * 1.42, S.shoulderW * 0.30, null);
    // Four hoops of elemental light round the skirt, in `trim` rather than `glow` for the same
    // reason as the mage's three: a 5.6 cm tube under a 1.2 rim is all rim, and from behind these
    // four were the single biggest white area in the game (10.5 % of the silhouette).
    for (let i = 0; i < 4; i++) {
      P(torus(S.shoulderW * (0.92 + i * 0.16), S.limbR * 0.30, 5, 18), M.trim, 'hemA',
        trs(0, -S.hem * 0.09 * (i + 1), 0, Math.PI / 2, 0, 0));
    }
    // Torso: a fitted cuirass over the robe, waist pinched, chest broad.
    P(loft(SEC.oct, 0, S.torsoH * 0.55, (t) => ({
      w: S.shoulderW * (0.74 + t * 0.28), d: S.shoulderW * (0.60 + t * 0.24),
    }), 5), M.dark, 'torso', trs(0, 0, 0), { softBone: 'chest', softLen: S.torsoH * 0.55 });
    P(loft(SEC.oct, 0, S.torsoH * 0.55, (t) => ({
      w: S.shoulderW * (1.02 - t * 0.24), d: S.shoulderW * (0.84 - t * 0.22),
    }), 5), M.dark, 'chest', trs(0, 0, 0), { softBone: 'head', softLen: S.torsoH * 0.55 });
    P(sweep(SEC.rect, (t) => {
      HER_P.set(0, S.torsoH * 0.22 * t, S.shoulderW * (0.62 + t * 0.06));
      return { p: HER_P, w: S.shoulderW * (0.34 - t * 0.20), d: S.limbR * 0.5 };
    }, 5), M.glow, 'chest', trs(0, 0, 0));
    // Head: horned helm, glowing visor slit rather than a face.
    //
    // The slit was one flat `plate` and that is why it took three tries. A *flat* panel
    // cannot be in front of a curved helm: at the centre the helm's surface is at
    // z 0.97·headR while at ±0.65 off the axis it is only at 0.66, so any single z is
    // either buried in the middle (the original bug — z 0.86 against a helm reaching
    // 1.10, which drew only the two ends that overhung the sides, a bar through the head
    // with a notch bitten out of it) or floating clear of the ends. Pushing it out to
    // 1.06 traded that for a shelf sticking 0.47·headR off the face, because `plate`
    // lofts along +Y *from the origin* — so the Z-rotation that turns it sideways also
    // hangs its whole length off one side, and the Rx that was meant to lay it flat tips
    // its width into +z instead.
    //
    // So the visor follows the surface it sits on: seven short bars stepped along the
    // helm's own front arc, each at the point (1.012·sin a, 0.968·cos a) of the helm
    // ellipsoid scaled out by 1.03, yawed by `a` so its long axis lies along the
    // tangent. Every segment is therefore proud of the helm by construction, at any
    // width, and they overlap (0.19 apart, 0.32 long) into one continuous curved slit.
    // Same rule as the abyss mage's hood: derive each z from the front surface of the
    // part behind it.
    //
    // Both the arc extent and the push-out taper towards the ends, and that is not
    // styling — anything held proud of a curved surface crosses that surface's own
    // silhouette at a grazing angle. At a flat 1.06 the outermost bar reached 0.88·headR
    // against a helm half-width of 1.01 and the three-quarter view had a lit cigar poking
    // out past the head's edge. So the push runs 1.035 at the centre down to 0.985 at the
    // ends (the last bar is *inside* the helm, which is what a slit narrowing into the
    // metal looks like) and the bars shrink with it. It sits at y 0.25·headR, above the
    // helm's equator — at 0.10 it read as a mouth.
    P(blob(S.headR * 1.1, 0.92, 1.15, 0.88, 14), M.dark, 'head', trs(0, 0, 0));
    // A faceplate, because the helm was still an egg. Everything above was about getting the
    // slit *onto* the surface, and the model sheet then showed what was left: one navy value
    // from crown to jaw with a row of beads across it, and no plane that reads as a face. The
    // plate is a flattened blob in the mid `body` value whose front pole clears the helm's
    // (1.1·0.88 = 0.968) by 0.03 while its own silhouette (0.76) stays well inside the helm's
    // (1.012) — so it is proud at the centre and *sinks into* the helm at its rim (at x 0.76
    // the helm's surface is already at z 0.64, in front of the plate's 0.60 centre), which is
    // how a faceplate meets a helm instead of floating in front of it as a second egg.
    P(blob(S.headR * 0.95, 0.80, 0.92, 0.42, 12), M.body, 'head',
      trs(0, -S.headR * 0.06, S.headR * 0.60));
    // The visor, rebuilt for two reasons the portrait made obvious.
    //
    // ① 7 bars 0.20 rad apart, each 0.32·headR long tapering to 0.21, are *just* touching at
    // the ends and only by a hairline in the middle: with the toon ramp on top it photographed
    // as a scalloped row of beads — a zipper, not a slit. So 13 bars 0.105 rad apart, each
    // 0.19·headR long: every gap is covered by 1.8× its own width at the centre of the arc and
    // 1.2× at the ends, which is what makes a *line* out of a row of ellipsoids.
    //
    // ② The bars were `glow` at emissive 1.5, so they clipped to paper white and the visor had
    // no colour and no shape. In the eye material they are bright, specular and *not* clipped;
    // a short `glow` core down the middle of the arc keeps the light spilling out of the groove
    // without whiting the whole band out. That also arms this kind's face gate — `materials.eye`
    // is used nowhere else on the herald, so the portrait probe can hide it and prove the visor
    // reaches the screen, which for a helmed boss is the same question as "does it have eyes".
    //
    // ③ And the arc has to shrink as it rises. The old bars used the helm's *equator* radius
    // (1.012, 0.968) at every height, which is fine at y 0.25 and floats free by 0.03·headR at
    // y 0.50 — the brow band below was authored that way first and hung off the front of the
    // helm like a hoop. `seat(y)` is the same correction `onBlob` makes for an eye, in the one
    // other place a curved surface carries decoration: the ellipse at height y is the equator's
    // scaled by √(1 − (y/half-height)²), so every band seated with it stays half-sunk at any
    // height, and the numbers below are about how proud the band is, nothing else.
    const [hx, hy, hz] = [1.1 * 0.92, 1.1 * 1.15, 1.1 * 0.88];
    const seat = (y) => Math.sqrt(Math.max(0.04, 1 - (y / hy) ** 2));
    // ④ …and then a row of overlapping ellipsoids still photographed as beads. Closing the gaps
    // to 1.8× the bar width fixed the *holes* and could not fix the scallops: each blob's own
    // silhouette bulges between its neighbours' and the toon ramp puts a highlight on every
    // dome, so the eye reads twelve lozenges. **A line is not a row of dots at any spacing** —
    // it is one swept solid. `sweep` carries a cross-section along a path (X = tangent × REF
    // ends up along −Y here, so `w` is the slit's height and `d` its depth), which gives a
    // continuous slit that tapers to a point at each end, in three parts instead of thirty-five.
    const onHelm = (a, y, out) => HER_P.set(
      S.headR * hx * Math.sin(a) * seat(y) * out, S.headR * y,
      S.headR * hz * Math.cos(a) * seat(y) * out);
    P(sweep(SEC.lens, (t) => {
      const k = Math.abs(t - 0.5) * 2;
      return {
        p: onHelm((t - 0.5) * 1.26, 0.25, 1.045 - k * 0.05),
        w: S.headR * (0.105 - k * 0.055), d: S.headR * 0.050,
      };
    }, 16), M.eye, 'head', trs(0, 0, 0));
    // The light in the groove: the same arc over the middle half only, thinner and 0.02·headR
    // further out, so the visor has a bright core inside a readable band instead of one clipped
    // white bar (`glow` runs at emissive 1.5 — on its own it has no colour and no shape).
    P(sweep(SEC.lens, (t) => {
      const k = Math.abs(t - 0.5) * 2;
      return {
        p: onHelm((t - 0.5) * 0.86, 0.25, 1.090),
        w: S.headR * (0.052 - k * 0.030), d: S.headR * 0.040,
      };
    }, 12), M.glow, 'head', trs(0, 0, 0));
    // A metal brow ridge over the slit: it separates the crown from the face, it is the one grey
    // value on a model that is otherwise navy and glow, and it arches up at the temples so the
    // helm has an expression rather than a waistline.
    P(sweep(SEC.lens, (t) => {
      const k = Math.abs(t - 0.5) * 2;
      return {
        p: onHelm((t - 0.5) * 1.56, 0.62 + k * 0.12, 1.015),
        w: S.headR * (0.050 + k * 0.015), d: S.headR * 0.045,
      };
    }, 18), M.metal, 'head', trs(0, 0, 0));
    for (const s of [-1, 1]) {
      P(sweep(SEC.lens, (t) => {
        HER_P.set(s * S.headR * (0.70 + Math.sin(t * 1.7) * 1.35),
          S.headR * (0.90 + t * 1.9 - t * t * 0.9), -S.headR * (0.20 + t * 0.9));
        return { p: HER_P, w: S.headR * 0.22 * (1 - t * 0.9) + 0.004, d: S.headR * 0.15 * (1 - t * 0.88) + 0.004 };
      }, 9), M.glow, 'head', trs(0, 0, 0));
    }
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      // Floating shoulder plates and a huge clawed gauntlet on each arm.
      //
      // The plates are 53 cm of flat slab and they have now been three materials. In `glow` they
      // were two white rectangles stapled to the shoulders — a slab that size has to be *shaded*
      // to read as a plate, and an emissive material has no shading, so no hue fixes it. In
      // `metal` (the faction's cold steel, the brow ridge's value) they were flat pale slabs
      // *brighter than the boss's own helm*: the head close-up read as a navy figure wearing two
      // pieces of polystyrene. A thin bright value is a highlight; the same value across the
      // widest panel on the model is just the lightest thing in the frame.
      //
      // So: navy panel, elemental lip. The lip is a second plate a little longer, a little wider
      // and *thinner in depth*, drawn first — being thinner it hides inside the panel everywhere
      // except around the border, which is how a rim gets onto a flat panel without modelling a
      // bevel. The elemental light on this boss is therefore carried entirely by parts narrow
      // enough to survive being multiplied: horns, chest crest, claws, visor core, hem hoops and
      // this 2 cm lip.
      P(plate(S.shoulderW * 0.66, S.shoulderW * 0.46, S.shoulderW * 0.28, S.limbR * 0.30),
        M.trim, `shoulder${L}`, trs(0, S.limbR * 1.2, 0, -0.35, 0, Math.PI / 2 + s * 0.2));
      P(plate(S.shoulderW * 0.62, S.shoulderW * 0.40, S.shoulderW * 0.22, S.limbR * 0.55),
        M.body, `shoulder${L}`, trs(0, S.limbR * 1.2, 0, -0.35, 0, Math.PI / 2 + s * 0.2));
      P(loft(SEC.oct, 0, -S.upper, (t) => ({
        w: S.limbR * (1.0 - t * 0.16), d: S.limbR * (0.95 - t * 0.14),
      }), 4), M.cloth, `arm${L}`, trs(0, 0, 0), { softBone: `fore${L}`, softLen: S.upper });
      P(loft(SEC.rect, 0, -S.fore * 0.72, (t) => ({
        w: S.limbR * (1.25 + t * 0.55), d: S.limbR * (1.15 + t * 0.50),
      }), 4), M.dark, `fore${L}`, trs(0, 0, 0));
      for (let c = -1; c <= 1; c++) {
        P(sweep(SEC.lens, (t) => {
          HER_P.set(c * S.limbR * 0.70, -S.fore * (0.72 + t * 0.52), S.limbR * (t * 0.9 - t * t * 0.4));
          return { p: HER_P, w: S.limbR * 0.30 * (1 - t * 0.92) + 0.003, d: S.limbR * 0.22 * (1 - t * 0.9) + 0.003 };
        }, 6), M.glow, `fore${L}`, trs(0, 0, 0));
      }
    }
  },
  pose(b, t, st, S) {
    const bobY = Math.sin(t * 1.0) * S.h * 0.022;
    b.hips.position.y = S.float + S.hem + bobY;
    b.hips.rotation.y = Math.sin(t * 0.45) * 0.10;
    b.torso.rotation.x = Math.sin(t * 0.9) * 0.04;
    b.chest.rotation.y = Math.sin(t * 0.7) * 0.07;
    b.head.rotation.y = Math.sin(t * 0.5) * 0.16;
    ['hemA', 'hemB', 'hemC'].forEach((n, i) => {
      b[n].rotation.x = Math.sin(t * 1.0 - 0.5 * (i + 1)) * (0.07 + i * 0.03);
      b[n].rotation.z = Math.sin(t * 0.74 - 0.45 * (i + 1)) * (0.06 + i * 0.03);
    });
    const a = st.attack > 0 ? st.attack : 0;
    const wind = a > 0 ? Math.min(1, a / 0.45) : 0;
    const hit = a > 0 ? Math.max(0, (a - 0.45) / 0.55) : 0;
    const e = wind * (1 - hit);
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      b[`shoulder${L}`].rotation.x = -0.7 * e + 0.25 * hit;
      b[`arm${L}`].rotation.x = -0.20 - 1.0 * e + 1.2 * hit + Math.sin(t * 1.2 + s) * 0.05;
      b[`arm${L}`].rotation.z = s * (0.36 - e * 0.20);
      b[`fore${L}`].rotation.x = 0.42 + 0.7 * e - 0.5 * hit;
    }
    if (st.phase2) b.chest.rotation.x = -0.12;   // second phase: hunched, aggressive
  },
};
const HER_P = new THREE.Vector3();

/* --- storm tyrant ----------------------------------------------------------- */
KINDS.tyrant = {
  airborne: true,
  bones: [
    ['root', null], ['body', 'root'], ['neck', 'body'], ['head', 'neck'], ['jaw', 'head'],
    ['wingL0', 'body'], ['wingL1', 'wingL0'], ['wingL2', 'wingL1'],
    ['wingR0', 'body'], ['wingR1', 'wingR0'], ['wingR2', 'wingR1'],
    ['tailA', 'body'], ['tailB', 'tailA'], ['tailC', 'tailB'],
    ['legL', 'body'], ['footL', 'legL'], ['legR', 'body'], ['footR', 'legR'],
  ],
  dims(def) {
    const h = def.hitbox?.h ?? 5.2;
    return {
      // Long and slim rather than tall: the first pass gave it a barrel body as
      // deep as it was long, and a bird whose body is a sphere reads as a beetle
      // however good the head is. The wingspan has to dominate the silhouette too.
      h, fly: h * 0.52, bodyR: h * 0.125, bodyLen: h * 0.60,
      neck: h * 0.30, headR: h * 0.115, wing: h * 0.54, leg: h * 0.17,
      limbR: h * 0.040, tail: h * 0.24,
    };
  },
  place(b, S) {
    b.body.position.set(0, S.fly, 0);
    b.neck.position.set(0, S.bodyR * 0.42, S.bodyLen * 0.40);
    b.head.position.set(0, S.neck * 0.52, S.neck * 0.58);
    b.jaw.position.set(0, -S.headR * 0.26, S.headR * 0.24);
    b.tailA.position.set(0, S.bodyR * 0.20, -S.bodyLen * 0.46);
    b.tailB.position.set(0, 0, -S.tail);
    b.tailC.position.set(0, 0, -S.tail);
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      b[`wing${L}0`].position.set(s * S.bodyR * 0.82, S.bodyR * 0.42, 0);
      b[`wing${L}1`].position.set(s * S.wing * 0.46, 0, 0);
      b[`wing${L}2`].position.set(s * S.wing * 0.44, 0, 0);
      // Gull shape: up at the shoulder, levelling at the wrist, dropping at the
      // tip — and swept backward, which is what stops a spread wing from reading as
      // a crossbar bolted to the shoulders.
      b[`wing${L}0`].rotation.z = s * 0.26;
      b[`wing${L}1`].rotation.z = -s * 0.20;
      b[`wing${L}2`].rotation.z = -s * 0.26;
      b[`wing${L}0`].rotation.y = s * 0.10;
      b[`wing${L}1`].rotation.y = s * 0.16;
      b[`wing${L}2`].rotation.y = s * 0.20;
      b[`leg${L}`].position.set(s * S.bodyR * 0.52, -S.bodyR * 0.70, S.bodyLen * 0.10);
      b[`foot${L}`].position.set(0, -S.leg, 0);
      b[`leg${L}`].rotation.x = 0.55;
      b[`foot${L}`].rotation.x = -0.9;
    }
    b.neck.rotation.x = -0.35;
  },
  parts(P, S, M) {
    // Body: one big swept spindle, deepest just behind the shoulders.
    P(sweep(SEC.lens, (t) => {
      TY_P.set(0, Math.sin(t * Math.PI) * S.bodyR * 0.12, -S.bodyLen * 0.5 + t * S.bodyLen);
      const w = S.bodyR * (0.62 + Math.sin(t * 2.8) * 0.44);
      return { p: TY_P, w, d: w * 1.06, ref: X_REF };
    }, 12), M.body, 'body', trs(0, 0, 0));
    P(sweep(SEC.lens, (t) => {
      TY_P.set(0, -S.bodyR * 0.58, -S.bodyLen * 0.38 + t * S.bodyLen * 0.80);
      const w = S.bodyR * (0.40 + Math.sin(t * 2.8) * 0.24);
      return { p: TY_P, w, d: w * 0.42, ref: X_REF };
    }, 8), M.body2, 'body', trs(0, 0, 0));
    // Neck and a raptor head with a hooked beak.
    //
    // The neck has to *end at the head bone*, and the only way to guarantee that is
    // to author its spine from `place`'s own head offset instead of from an angle.
    // The first pass lofted it along -0.6 rad about X, which in the neck's rest
    // frame points up and **backward**, so the tube grew out of the bird's back like
    // a dorsal fin while the head floated half a metre in front of it with black sky
    // in between — invisible head-on and from behind (the gap is along Z, so the
    // body silhouette swallows it), unmistakable in profile, where the isolation
    // sheet split the model into two connected components.
    const nz = S.neck * 0.58, ny = S.neck * 0.52;   // = b.head.position, see place()
    P(sweep(SEC.lens, (t) => {
      const u = t * 1.10;                            // overshoot: let the skull swallow the joint
      // Slight backward bow at mid-span — a raptor's S-curve, not a broomstick.
      TY_P.set(0, ny * u, nz * u - Math.sin(Math.min(1, u) * Math.PI) * S.neck * 0.09);
      return { p: TY_P, w: S.bodyR * (0.52 - t * 0.18), d: S.bodyR * (0.56 - t * 0.20), ref: X_REF };
    }, 7), M.body, 'neck', trs(0, 0, 0), { softBone: 'head', softLen: ny * 1.10 });
    P(blob(S.headR, 0.86, 0.90, 1.20, 12), M.body, 'head', trs(0, 0, 0));
    P(sweep(SEC.lens, (t) => {
      TY_P.set(0, S.headR * (0.10 - t * t * 0.75), S.headR * (0.80 + t * 1.05));
      return { p: TY_P, w: S.headR * (0.40 - t * 0.34) + 0.004, d: S.headR * (0.44 - t * 0.38) + 0.004, ref: X_REF };
    }, 7), M.accent, 'head', trs(0, 0, 0));
    P(loft(SEC.lens, 0, S.headR * 0.95, (t) => ({
      w: S.headR * (0.34 - t * 0.24), d: S.headR * (0.20 - t * 0.13),
    }), 4), M.accent, 'jaw', trs(0, 0, 0, Math.PI / 2 - 0.15, 0, 0));
    // Eyes on the skull's own surface — `onBlob` solves the z from the head ellipsoid at *this*
    // lateral offset. The head is `blob(headR, 0.86, 0.90, 1.20)`, so at x 0.60·headR the surface
    // has already curved back to z 0.86 and the old constant z 0.40 put both eyes *inside* the
    // skull: 648 px of one of them peeked around the silhouette edge and the boss's portrait read
    // as a blank pale face. Same failure as 深渊法师's sealed hood.
    // Brought inboard to 0.45 as well, which is what makes a raptor read as forward-facing, and up
    // a size, because this head is 2.3 m across and its eyes are the only feature on it.
    const EX = 0.45, EY = 0.22;
    const eyeZ = onBlob(0.86, 0.90, 1.20, EX, EY);
    for (const s of [-1, 1]) {
      P(sphere(S.headR * 0.20, 10), M.eye, 'head',
        trs(s * S.headR * EX, S.headR * EY, S.headR * eyeZ, 0, 0, 0, 1, 1.15, 0.7));
      // A pupil, because a pale glow eye on a pale skull is two frosted buttons: the eyeball is
      // flattened to 0.7 in z, so its front pole is at eye z + 0.14·headR and *that* is where the
      // dot's centre goes — half in, half out. Centred on the eyeball, so unlike a visor plate it
      // never crosses the surface it sits on.
      P(sphere(S.headR * 0.09, 8), M.dark, 'head',
        trs(s * S.headR * EX, S.headR * EY, S.headR * (eyeZ + 0.14), 0, 0, 0, 1, 1.1, 0.7));
      // Swept crest horns — this is the storm tyrant's silhouette from below.
      //
      // Three per side, and for a long time all six were solid `glow` tubes: emissive 1.5 on a
      // near-white authored hex, rim 1.2, thin enough that the fresnel covers the whole surface.
      // From behind, the isolation sheet showed a **white starburst with a bloom halo where the
      // head should be** — 10 928 px of one featureless blob, 11% of the boss's whole silhouette.
      // A clipped highlight is only ever fixed by putting something dark next to it (the same
      // lesson as 深渊法师's eyes): so each quill is now a *blade* in the low-rim `thin` material
      // with a narrow glow core running down it, and the core is thicker than the blade in `d` so
      // it reads as a lit spine from both sides instead of a stripe painted on one face.
      const quill = (i, mat, kw, kd, k0) => P(sweep(SEC.lens, (t) => {
        TY_P.set(s * S.headR * (0.40 + i * 0.20 + t * 0.55),
          S.headR * (0.60 + t * 1.15), -S.headR * (0.30 + t * (1.5 + i * 0.35)));
        return {
          p: TY_P,
          w: S.headR * kw * (1 - t * k0) + 0.003,
          d: S.headR * kd * (1 - t * k0) + 0.003,
        };
      }, 7), mat, 'head', trs(0, 0, 0));
      for (let i = 0; i < 3; i++) {
        quill(i, M.thin, 0.19, 0.055, 0.88);
        quill(i, M.glow, 0.055, 0.075, 0.92);
      }
    }
    // Wings. Three bones per side, each carrying a thin leading-edge spar plus a
    // flat panel whose chord runs backward in Z, then a row of trailing feathers.
    //
    // The panel is the important part: the first version was a fat round tube per
    // segment with four sparse feather planks hanging off it, and with no surface
    // between them the pair read unmistakably as a set of front legs. A wing has to
    // be a *sheet* first and a set of feathers second.
    //
    // Frame note: the panel's spine runs along X, so per solid.js the section's `w`
    // becomes Z (the chord) and `d` becomes Y (the thickness) — not the other way
    // round, which would give a chord-tall, paper-thin blade standing on edge.
    const CHORD = [0.95, 0.72, 0.44, 0.10];
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      for (let seg = 0; seg < 3; seg++) {
        const span = S.wing * (seg === 2 ? 0.44 : 0.46);
        const r = S.limbR * (0.74 - seg * 0.16);
        P(loft(SEC.lens, 0, span, (t) => ({ w: r * (1 - t * 0.28), d: r * 0.78 }), 4),
          M.body, `wing${L}${seg}`, trs(0, 0, 0, 0, 0, -s * Math.PI / 2),
          seg < 2 ? { softBone: `wing${L}${seg + 1}`, softLen: span } : undefined);

        const c0 = S.wing * CHORD[seg], c1 = S.wing * CHORD[seg + 1];
        P(sweep(SEC.lens, (t) => {
          const chord = c0 + (c1 - c0) * t;
          // The mid-chord slides backward along the span, so the leading edge rakes
          // back instead of standing out as a straight crossbar.
          TY_P.set(s * span * t, -t * S.wing * 0.025, -chord * 0.44 - t * S.wing * 0.09);
          return { p: TY_P, w: chord * 0.5, d: S.limbR * 0.34 * (1 - t * 0.35), ref: UP_REF };
        }, 6), seg === 0 ? M.body : M.body2, `wing${L}${seg}`, trs(0, 0, 0));

        // Trailing-edge feathers. Their spine runs along -Z, so here `w` is the
        // feather width in X and `d` is again the thickness in Y.
        const count = 6;
        for (let i = 0; i < count; i++) {
          const u = (i + 0.5) / count;
          const chord = c0 + (c1 - c0) * u;
          const len = chord * (0.50 + Math.sin(u * Math.PI) * 0.32);
          P(sweep(SEC.lens, (t) => {
            TY_P.set(s * span * u, -t * len * 0.12, -chord * 0.92 - u * S.wing * 0.09 - t * len);
            return {
              p: TY_P, w: (span / count) * 0.66 * (1 - t * 0.5), d: S.limbR * 0.17,
              ref: UP_REF,
            };
          }, 4), seg === 2 ? M.accent : M.body, `wing${L}${seg}`, trs(0, 0, 0));
        }
      }
    }
    // Tail: three segments with a fan of storm feathers at the tip.
    const seg = (bone, r0, r1) => P(loft(SEC.lens, 0, -S.tail, (t) => ({
      w: r0 + (r1 - r0) * t, d: (r0 + (r1 - r0) * t) * 1.1,
    }), 4), M.body, bone, trs(0, 0, 0, Math.PI / 2, 0, 0));
    seg('tailA', S.bodyR * 0.34, S.bodyR * 0.26);
    seg('tailB', S.bodyR * 0.26, S.bodyR * 0.17);
    seg('tailC', S.bodyR * 0.17, S.bodyR * 0.05);
    // The same treatment as the crest, for the same reason: a storm feather is a blade with a lit
    // *tip*, not a glowing plank. `u0` starts the glow sweep partway along the shared path, so the
    // two parts cannot drift apart the way two hand-written paths would.
    const plume = (i, mat, u0, kw, kd) => P(sweep(SEC.lens, (t) => {
      const u = u0 + t * (1 - u0);
      TY_P.set(i * S.bodyR * 0.13 * (1 + u * 1.5), 0, -S.tail * 0.3 - u * S.tail * 1.15);
      return { p: TY_P, w: S.limbR * kw * (1 - u * 0.76) + 0.004, d: S.limbR * kd, ref: UP_REF };
    }, 5), mat, 'tailC', trs(0, 0, 0));
    for (let i = -2; i <= 2; i++) {
      plume(i, M.thin, 0, 0.62, 0.13);
      plume(i, M.glow, 0.55, 0.30, 0.17);
    }
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      P(loft(SEC.lens, 0, -S.leg, (t) => ({
        w: S.limbR * (1.15 - t * 0.35), d: S.limbR * (1.20 - t * 0.36),
      }), 4), M.body, `leg${L}`, trs(0, 0, 0), { softBone: `foot${L}`, softLen: S.leg });
      P(loft(SEC.lens, 0, -S.leg * 0.55, (t) => ({
        w: S.limbR * (0.80 - t * 0.30), d: S.limbR * (0.84 - t * 0.32),
      }), 3), M.accent, `foot${L}`, trs(0, 0, 0));
      for (let c = -1; c <= 2; c++) {
        const back = c === 2;
        P(sweep(SEC.lens, (t) => {
          TY_P.set((back ? 0 : c) * S.limbR * 0.5, -S.leg * 0.55 - t * S.limbR * 0.5,
            (back ? -1 : 1) * (t * S.limbR * 1.7 - t * t * S.limbR * 0.5));
          return { p: TY_P, w: S.limbR * 0.24 * (1 - t * 0.92) + 0.003, d: S.limbR * 0.20 * (1 - t * 0.9) + 0.003 };
        }, 5), M.accent, `foot${L}`, trs(0, 0, 0));
      }
    }
  },
  pose(b, t, st, S) {
    // Always airborne: the wingbeat drives the vertical bob, not the other way
    // round, so the body rises on the downstroke like a real flyer.
    const beat = t * (2.0 + (st.speed ?? 0) * 0.18);
    const flap = Math.sin(beat);
    b.body.position.y = S.fly + flap * S.h * 0.055;
    b.body.rotation.x = -0.06 + flap * 0.10 + (st.speed > 0.5 ? 0.16 : 0);
    b.neck.rotation.x = -0.35 - flap * 0.10;
    b.head.rotation.x = 0.22 + flap * 0.08;
    b.head.rotation.y = Math.sin(t * 0.5) * 0.20;
    b.jaw.rotation.x = 0.06 + (st.attack > 0 ? Math.sin(st.attack * Math.PI) * 0.6 : 0);
    for (const s of [-1, 1]) {
      const L = s < 0 ? 'L' : 'R';
      // Each outboard segment lags the one inboard of it, which is what makes a
      // wing look like a wing instead of a rigid glider panel.
      b[`wing${L}0`].rotation.z = s * (0.26 + flap * 0.46);
      b[`wing${L}0`].rotation.y = s * (0.10 - 0.08 * Math.sin(beat - 0.4));
      b[`wing${L}1`].rotation.z = -s * (0.20 - Math.sin(beat - 0.55) * 0.36);
      b[`wing${L}2`].rotation.z = -s * (0.26 - Math.sin(beat - 1.1) * 0.44);
      b[`leg${L}`].rotation.x = 0.55 + Math.sin(t * 0.9 + s) * 0.10;
      b[`foot${L}`].rotation.x = -0.9 + Math.sin(t * 0.9 + s - 0.5) * 0.12;
    }
    ['tailA', 'tailB', 'tailC'].forEach((n, i) => {
      b[n].rotation.x = 0.10 + Math.sin(beat - 0.5 * (i + 1)) * (0.10 + i * 0.04);
      b[n].rotation.y = Math.sin(t * 1.3 - 0.5 * (i + 1)) * (0.10 + i * 0.05);
    });
    if (st.attack > 0) {
      // Divebomb / cyclone: wings sweep back and the whole body pitches down.
      const a = Math.sin(st.attack * Math.PI);
      b.body.rotation.x = -0.06 + a * 0.75;
      for (const s of [-1, 1]) {
        const L = s < 0 ? 'L' : 'R';
        b[`wing${L}0`].rotation.z = s * (0.26 - a * 0.85);
        b[`wing${L}1`].rotation.y = s * (0.16 + a * 0.75);
        b[`wing${L}2`].rotation.y = s * (0.20 + a * 0.85);
      }
    }
  },
};
const TY_P = new THREE.Vector3();

/* -------------------------------------------------------------------- driver -- */

function buildRigged(kind, def, M) {
  const K = KINDS[kind];
  const S = K.dims(def);
  const { bones, skeleton, ordered, bindWorld, boneIndexOf } =
    makeRig(K.bones, (b) => K.place(b, S));
  const parts = [];
  const push = (geo, mat, bone, matrix, soft) => parts.push({ geo, mat, bone, matrix, ...soft });

  // Helpers for parts that care about *model* space rather than their bone's own
  // frame. Held props are the case that needs it: a hand bone inherits the whole
  // arm's rest splay (roll + forward pitch), so a bow or a haft authored upright
  // in hand space comes out slung across the body at some angle nobody can
  // predict from the numbers. `held` gives back the bone-local matrix that
  // reproduces a model-space transform, so a weapon can be authored hanging
  // straight down from the fist and still deform with the arm.
  const H = {
    at: (bone) => new THREE.Vector3().setFromMatrixPosition(bindWorld[bone]),
    held(bone, world) {
      return new THREE.Matrix4().copy(bindWorld[bone]).invert().multiply(world);
    },
  };
  K.parts(push, S, M, def, H);

  const { geo, materials } = bakeSkinned(parts, ordered, boneIndexOf, bindWorld);
  const skinned = new THREE.SkinnedMesh(geo, materials);
  skinned.castShadow = true;
  skinned.receiveShadow = true;
  skinned.frustumCulled = false;
  skinned.add(bones.root);
  // Identity bind matrix — see the note in humanoid.js: the geometry is already in
  // bind space and boneInverses were captured before the bones were parented here.
  skinned.bind(skeleton, new THREE.Matrix4());

  const group = new THREE.Group();
  group.name = `enemy:${def.id}`;
  group.add(skinned);

  // Rest pose snapshot: `pose` writes absolute rotations for the bones it drives
  // and leaves the rest alone, so anything it does not touch has to already be
  // sitting in its authored rest value.
  const rest = {};
  for (const [n] of K.bones) rest[n] = bones[n].rotation.clone();

  // 步态里程. The gait clock lives here, per creature, because it is an *integral* of the
  // ground the creature has covered — one cycle per `4 · hip · sin(amp · run)` metres, so the
  // planted foot stays planted (see `GAIT`). A pose function cannot own it: poses are pure
  // functions of (t, state), and the stride length changes with speed, so the phase has to be
  // accumulated frame by frame rather than derived from total distance.
  //
  // `mScale` is the normalisation `buildEnemy` applies to the whole group afterwards. Without
  // it the hip height would be in the rig's own pre-scale units while `speed` is in metres,
  // and every creature whose model.scale is not 1 would skate again (the pyro hilichurl is
  // 1.12, the vishap 1.2).
  let gait = 0;
  let mScale = 1;
  const strideRef = K.gait ? measureStride(K, S, bones, rest, group) : 0;
  const strideSin = K.gait ? Math.sin(K.gait.amp) : 1;
  // The ground one cycle covers at this speed, in world metres: the measured cycle is for a
  // full-speed swing, and a shorter swing reaches proportionally less far — the one part of this
  // that *is* trigonometry. One function so the odometer's divisor and the number a probe states
  // its resolution in cannot drift apart.
  const strideAt = (v) => {
    if (!K.gait) return 0;
    const run = Math.min(1, Math.max(0, v) / K.gait.top);
    return strideRef * mScale * (Math.sin(K.gait.amp * run) / strideSin);
  };

  return {
    group, skinned, bones, height: S.h, dims: S,
    setModelScale(v) { mScale = v > 0 ? v : 1; },
    strideAt,
    update(dt, t, st = {}) {
      for (const [n] of K.bones) bones[n].rotation.copy(rest[n]);
      let s = st;
      // `st.gait != null` means the caller is holding a fixed pose (a tool, a screenshot);
      // leave the clock alone and do not advance the odometer either, or the pose would
      // depend on how many times the tool happened to call update.
      if (K.gait && st.gait == null) {
        const v = Math.max(0, st.speed ?? 0);
        const stride = strideAt(v);
        // The ground the body covered this frame when the caller knows it (`ActorSystem` does: it
        // interpolates the position itself), `v * dt` when it does not. The two differ on every
        // frame slower than 20 fps, because the position comes from the wall clock and `dt` is
        // clamped to 50 ms — a creature chasing you at 6 fps slid three quarters of its ground.
        // Uncapped: clamping the step to one stride is clamping the phase to one whole cycle, and
        // a whole cycle per frame draws the same pose forever (a live chase at 3 fps measured
        // 0.0000 rad of thigh spread over 15 frames with the clamp in).
        const step = st.advance != null ? st.advance : v * dt;
        if (step > 0 && stride > 1e-3) gait += (step / stride) * Math.PI * 2;
        s = { ...st, gait };
      }
      K.pose(bones, t, s, S);
    },
  };
}

/* --------------------------------------------------------------------- public -- */

/**
 * Build the model for an enemy id (or a `{ ...def }` object). Returns
 * `{ group, height, update(dt, t, state) }` where `state` is
 * `{ speed, attack, advance, gait, gaitOffset, phase2 }`:
 *   speed      — world units/second, drives the gait blend
 *   attack     — 0 for none, else 0..1 progress through the current attack
 *   advance    — metres of ground covered since the last frame, when the caller knows it;
 *                the gait clock integrates this instead of `speed * dt` (see the odometer)
 *   gait       — optional override of the gait clock (radians), for a fixed pose
 *   gaitOffset — optional per-actor shift of that clock, so a pack of wolves running
 *                together does not step in perfect unison (see `gaitPhase`)
 *   phase2     — the creature is in its second *battle* phase (the herald hunches)
 */
export function buildEnemy(idOrDef, opts = {}) {
  const def = typeof idOrDef === 'string' ? ENEMIES[idOrDef] : idOrDef;
  if (!def) throw new Error(`unknown enemy: ${idOrDef}`);
  const M = materialsFor(def);
  const kind = def.model.kind;
  const K = KINDS[kind];
  if (!K) throw new Error(`unknown enemy model kind: ${kind}`);

  const built = K.rigged === false ? K.build(def, M) : buildRigged(kind, def, M);
  if (K.rigged !== false) {
    addOutline(built.group, opts.outline ?? 0x14121c, opts.outlineWidth ?? 2.0);
  }

  // Normalise the built model to the hitbox height the server simulates, then
  // apply the authored artistic multiplier on top.
  //
  // Worth doing rather than hand-balancing each dims() table: the proportions in
  // those tables are ratios of `h`, and they never sum to exactly h (a mech's head
  // hood, a mage's horns and a wolf's ear tips all overshoot, while missing neck
  // segments undershoot). Measuring the result and correcting once means the tables
  // only have to be right *relative to each other*, and a creature can never again
  // render at two-thirds the size the collision capsule claims.
  const box = new THREE.Box3().setFromObject(built.group);
  // Floaters (mage, herald, tyrant) carry their hover height inside the rig, so
  // measure their own extent rather than their distance off the ground — otherwise
  // hitbox.h gets spent on empty air and the creature shrinks to fit under itself.
  const modelH = Math.max(0.01, K.airborne ? box.max.y - box.min.y : box.max.y);
  const s = ((def.hitbox?.h ?? modelH) / modelH) * (def.model.scale ?? 1);
  built.group.scale.setScalar(s);
  built.group.userData.enemyId = def.id;
  // The distance-driven gait clock needs the same scale, in the same place: it converts a
  // speed in metres to a phase using the rig's own hip height.
  built.setModelScale?.(s);

  // Where the weak point ended up, in the same space `ENEMIES[id].weakspot.offset` is
  // written in: metres from the creature's own origin (its feet), +Z forward, *after*
  // the normalisation above. The simulation cannot import this file — it runs in the
  // server too — so it reads the authored number instead, and `enemyGateReport()`
  // compares the two. That is the whole point of exporting it: the art moves the eye,
  // the gate fails, the data gets corrected. Nobody has to remember.
  const wsDef = K.weakspot?.(built.dims, def);
  const weakspot = wsDef ? (() => {
    const b = built.bones[wsDef.bone];
    // After the `setScalar` above, so the bone's world matrix already carries `s` — the
    // radius still needs it by hand, since it is a length in the rig's own units.
    b.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(...wsDef.local).applyMatrix4(b.matrixWorld);
    return { offset: [p.x, p.y, p.z].map((v) => Math.round(v * 1000) / 1000), r: wsDef.r * s };
  })() : null;

  // Elites and bosses carry a visible elemental aura; ordinary trash does not,
  // or a field of six slimes turns the screen into a light show.
  if (opts.aura !== false && (def.elite || def.boss)) {
    setAura(built.group, M.glowHex, def.boss ? 0.42 : 0.24);
  }

  return {
    ...built,
    def,
    materials: M,
    weakspot,
    height: (def.hitbox?.h ?? modelH) * (def.model.scale ?? 1),
    dispose() {
      built.group.traverse((o) => {
        if (o.isMesh) o.geometry?.dispose();
      });
      for (const m of Object.values(M)) m?.dispose?.();
    },
  };
}

export { KINDS as ENEMY_KINDS };
