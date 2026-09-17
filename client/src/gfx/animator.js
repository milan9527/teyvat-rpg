// Procedural skeletal animation.
//
// There are no animation files. Every pose is a function of time evaluated into a
// flat channel buffer, which keeps the whole character pipeline generative and
// means a new action costs a dozen lines instead of an authored clip.
//
// Structure:
//   * a LOCOMOTION clip is always running, chosen from speed / grounded / state
//   * a one-shot OVERLAY clip (attack, skill, hit, …) blends over the top with an
//     envelope, then releases — so a swing can interrupt a run and hand control
//     back without a state machine to get stuck in
//   * SECONDARY bones (cape, hair) are not posed at all; they are damped springs
//     driven by the character's own motion, which is what stops long hair and
//     capes from looking welded to the body
//
// Sign conventions, because they are easy to get backwards and every pose depends
// on them. Limb bones hang along -Y, so for a leg or an arm a *positive*
// rotation.x swings the far end BACKWARD (-Z) and a negative one swings it
// forward. Knee and elbow flexion are therefore opposite in sign: the knee folds
// the shin backward (+x), the elbow folds the hand forward (-x).

import * as THREE from 'three';
import { ACTION, ACTION_NAMES } from '@teyvat/shared/protocol.js';

/* -------------------------------------------------------------- pose buffer -- */

// Bones the pose system drives. Secondary bones are deliberately absent: they are
// simulated, and writing a pose to them would fight the spring.
const POSE_BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'armL', 'forearmL', 'handL',
  'shoulderR', 'armR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR',
];

const IDX = {};
POSE_BONES.forEach((n, i) => { IDX[n] = i * 3; });

// Extra non-rotation channels tacked onto the end of the buffer.
const CH_OFF_X = POSE_BONES.length * 3;
const CH_OFF_Y = CH_OFF_X + 1;
const CH_OFF_Z = CH_OFF_X + 2;
const CH_YAW = CH_OFF_X + 3;        // whole-body spin, for spin attacks
// Foot *targets*, in the character's own frame, per side: fore-aft metres, lift above the
// ground, extra ankle pitch, and the weight the leg solver gets. A locomotion clip asks for
// a place on the ground rather than a pair of joint angles, which is the only way a planted
// foot can stay planted while the pelvis bobs; everything else leaves the weight at 0 and
// keeps the joint angles the clip wrote.
const CH_IK = CH_OFF_X + 4;
const IK = { L: CH_IK, R: CH_IK + 4 };
const POSE_LEN = CH_IK + 8;

/** Thin writer over a Float32Array so pose functions read like posing code. */
class Pose {
  constructor() { this.a = new Float32Array(POSE_LEN); }
  zero() { this.a.fill(0); return this; }
  /** Absolute rotation offset from the bind pose, in radians. */
  set(bone, x = 0, y = 0, z = 0) {
    const i = IDX[bone];
    const a = this.a;
    a[i] = x; a[i + 1] = y; a[i + 2] = z;
    return this;
  }
  add(bone, x = 0, y = 0, z = 0) {
    const i = IDX[bone];
    const a = this.a;
    a[i] += x; a[i + 1] += y; a[i + 2] += z;
    return this;
  }
  /** Root translation offset in metres (bob, crouch, lunge). */
  offset(x, y, z) {
    this.a[CH_OFF_X] = x; this.a[CH_OFF_Y] = y; this.a[CH_OFF_Z] = z;
    return this;
  }
  yaw(v) { this.a[CH_YAW] = v; return this; }

  /**
   * Where a foot should be, in the character's own frame: `z` metres fore-aft of the
   * hips, `y` metres above the ground, `pitch` extra ankle rotation, and `w` how much
   * the leg solver should honour it. Blends like every other channel, so a clip that
   * leaves `w` at 0 keeps the joint angles it wrote and an overlay fading in takes the
   * legs back.
   */
  foot(side, z, y, pitch, w = 1) {
    const i = IK[side];
    const a = this.a;
    a[i] = z; a[i + 1] = y; a[i + 2] = pitch; a[i + 3] = w;
    return this;
  }

  /** Mirror-aware limb setter: `arm('L', ...)`. */
  arm(side, x, y, z) { return this.set(`arm${side}`, x, y, z); }
}

function lerpPose(out, a, b, w) {
  const oa = out.a, aa = a.a, ba = b.a;
  for (let i = 0; i < POSE_LEN; i++) oa[i] = aa[i] + (ba[i] - aa[i]) * w;
}

/* ------------------------------------------------------------------- easing -- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
// Fast out, slow settle — the shape most melee swings want.
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const easeInQuad = (t) => { t = clamp01(t); return t * t; };
/** A wind-up/strike/recover envelope: 0 → -over → 1 → settle. */
function swing(t, windup = 0.28, over = 0.22) {
  t = clamp01(t);
  if (t < windup) return -over * Math.sin((t / windup) * Math.PI * 0.5);
  const u = (t - windup) / (1 - windup);
  return easeOutCubic(u * 1.25) * (1 + over) - over * (1 - u) * (1 - u);
}
const TAU = Math.PI * 2;

/* -------------------------------------------------------------------- gait --- */

/**
 * How a leg cycle is shaped, in leg-lengths, against speed in leg-lengths per second.
 * Nothing here is in metres, so one curve serves the 1.54 m character and the 1.86 m
 * one, and the two of them running side by side take proportional steps instead of
 * identical ones.
 *
 *   duty   the fraction of the cycle each foot spends on the ground. Above 0.5 the two
 *          feet overlap (a walk has double support); below it there is a flight phase,
 *          which is what lets a run cover more ground than the legs can reach.
 *   sweep  how far the planted ankle travels backwards, relative to the hips, over that
 *          stance.
 *
 * The stride is *not* authored — it follows. While one foot is down for `duty` of a
 * cycle the body must cover exactly `sweep`, so
 *
 *     stride = sweep / duty
 *
 * and at any other value the planted foot slides along the ground. That identity is why
 * this table replaced three hand-written per-clip stride constants (1.55 / 2.30 / 2.85 m
 * per cycle, against a measured ankle sweep of 0.51-0.58 m: 30-50% of the ground the
 * characters covered was covered by skating, and the error grew with height).
 */
const GAIT = [
  { v: 0.0, duty: 0.70, sweep: 0.24 },
  { v: 0.6, duty: 0.66, sweep: 0.50 },
  { v: 1.7, duty: 0.60, sweep: 0.82 },
  { v: 2.9, duty: 0.48, sweep: 0.94 },
  { v: 4.5, duty: 0.38, sweep: 1.02 },
  { v: 6.5, duty: 0.30, sweep: 1.08 },
  { v: 10.2, duty: 0.22, sweep: 1.14 },
  { v: 14.0, duty: 0.19, sweep: 1.18 },
];

// How far above the ankle the hip can be, as a fraction of the leg. A two-bone chain
// shortened to 97.5% already carries ~25° of knee flex, and that is what stops the stance
// leg locking straight like a mannequin's.
const LEG_MAX = 0.975;
// The ankle does leave the ground at the ends of the stance, because the foot rolls onto
// its heel and then its toes: at push-off the forefoot is still down while the ankle has
// risen by roughly the forefoot's length times the sine of the ankle pitch.
//
// It is small — 3% of a leg — and that is the whole reason the sweep column above tops out
// near one leg-length. This skeleton has no ankle *height* (the ankle bone binds at y=0,
// with the sole around it), so a foot planted half a leg-length forward pulls the hip down
// by the full straight-leg geometry. Every extra centimetre of stance sweep buys stride at
// the price of a permanently lower pelvis; the table above spends that budget down to
// about 0.09 of a leg at walking speed and 0.18 at a sprint, which is why this character
// takes shorter, quicker steps than a real body at the same speed rather than skating to
// cover the difference.
const ANKLE_ROLL = 0.035;
// How much of the reach the pelvis is allowed to claim back between footfalls. Tracking the
// limit exactly bobs about twice as far as a real walk does, because a real knee stays bent
// through mid-stance instead of extending into every last centimetre of headroom.
const BOB_KEEP = 0.45;

/** Interpolate the gait table for a leg of `legLen` metres moving at `speed` m/s. */
function gaitAt(speed, legLen) {
  const L = Math.max(0.2, legLen || 0.85);
  const last = GAIT[GAIT.length - 1];
  const vn = Math.min(last.v, Math.abs(speed) / L);
  let i = 1;
  while (i < GAIT.length - 1 && vn > GAIT[i].v) i++;
  const a = GAIT[i - 1], b = GAIT[i];
  const w = b.v > a.v ? clamp01((vn - a.v) / (b.v - a.v)) : 0;
  const duty = a.duty + (b.duty - a.duty) * w;
  const sweepN = a.sweep + (b.sweep - a.sweep) * w;
  return {
    duty,
    sweep: sweepN * L,
    stride: (sweepN / duty) * L,
    // Swing clearance. It has to grow with the step (a longer swing needs more room to
    // fold under the body) and again with raw speed, because a sprinter's heel comes up
    // towards the buttock while a walker's barely leaves the ground.
    lift: L * (0.04 + 0.085 * sweepN + 0.010 * vn),
    legLen: L,
  };
}

/**
 * Write one cycle of foot targets and return the pelvis drop the legs demand.
 *
 * The stance half is *linear in phase*, which is the entire point: the body advances at
 * a constant rate, so a foot that is meant to stay put has to travel backwards at
 * exactly that rate. Curved stance motion is foot-slide with extra steps.
 *
 * The pelvis drop is derived rather than authored, too. The hip can be no higher above a
 * planted ankle than the leg is long, so the further the foot is fore or aft, the lower
 * the hips must sit — which produces the classic two-dips-per-cycle bob for free, in the
 * right places, at an amplitude that follows the stride instead of being tuned per clip.
 */
function legCycle(p, u, g) {
  const { duty, sweep, lift, legLen } = g;
  const legMax = legLen * LEG_MAX;
  const roll = legLen * ANKLE_ROLL;
  /** How high the hip may sit with the ankle at (z, y). */
  const reach = (z, y) => Math.sqrt(Math.max(1e-4, legMax * legMax - z * z)) + y;
  // The deepest any footfall will demand: a stance leg at full fore-aft reach.
  const edge = reach(sweep * 0.5, roll) - legLen;
  let held = null;
  for (const side of ['L', 'R']) {
    // The two feet are half a cycle apart; L plants at phase 0.
    const t = ((side === 'R' ? u + 0.5 : u) % 1 + 1) % 1;
    let z, y, pitch;
    if (t < duty) {
      const s = t / duty;                        // 0 at heel strike, 1 at toe-off
      z = sweep * (0.5 - s);
      // Flat-footed in the middle, up on the heel and then the toes at the ends.
      const e = Math.abs(s - 0.5) * 2;
      y = roll * e * e;
      pitch = -0.22 * (1 - smooth(s / 0.25)) + 0.45 * smooth((s - 0.7) / 0.3);
      const c = reach(z, y) - legLen;
      held = held === null ? c : Math.min(held, c);
    } else {
      const s = (t - duty) / (1 - duty);         // 0 at toe-off, 1 at the next strike
      z = sweep * (smooth(s) - 0.5);
      y = lift * Math.sin(Math.PI * Math.pow(s, 0.85));
      // Push-off plantarflexion releases into a toes-up swing, landing where the stance
      // curve starts so the ankle angle is continuous around the whole cycle.
      const k = smooth(s / 0.3);
      pitch = 0.45 * (1 - k) - k * (0.22 + 0.16 * Math.sin(Math.PI * s));
    }
    p.foot(side, z, y, pitch, 1);
  }
  // Only a foot that is *down* constrains anything. Through the flight phase of a run the
  // pelvis simply holds the height it took off at: interpolating back towards standing
  // height there is what turns a run into a bounce.
  return Math.min(0, edge + BOB_KEEP * ((held === null ? edge : held) - edge));
}

/* ------------------------------------------------------------------- clips --- */

/**
 * Locomotion: a contact-driven walk/run cycle. `amp` scales the upper body so walk, run
 * and sprint are the same curve at different amplitudes; the legs are not scaled at all,
 * because where the feet go is decided by the speed and the leg length (see `gaitAt`) and
 * not by which speed band the clip belongs to. That is what makes the walk → run → sprint
 * blends free of foot-slide, and it is why the three clips no longer carry a stride each.
 */
function locomotionPose(p, ph, amp, lean, ctx) {
  const s = Math.sin(ph), c = Math.cos(ph);
  const A = amp;

  // Where the feet go, and how far the planted leg lets the pelvis sit.
  const gait = ctx.gait || gaitAt(ctx.speed, ctx.legLen);
  const drop = legCycle(p, ph / TAU, gait);

  // Joint angles for the legs as well: the solver blends *from* these, so they are what
  // an attack overlay (which asks for no foot placement) hands the legs back to.
  for (const side of ['L', 'R']) {
    const o = side === 'L' ? 0 : Math.PI;
    const ss = Math.sin(ph + o);
    p.set(`thigh${side}`, -A * 0.62 * ss, 0, 0);
    // Knee flexion peaks shortly after toe-off, and never goes negative.
    p.set(`shin${side}`, A * 1.10 * Math.max(0, Math.sin(ph + o - 2.05)) + 0.06 + A * 0.10, 0, 0);
    // Ankle: toe-off push then a flat-ish swing.
    p.set(`foot${side}`, -A * 0.34 * Math.sin(ph + o + 0.85) + A * 0.12, 0, 0);
  }

  // Arms counter-swing the legs, with the elbow carrying a little more bend the
  // faster we go — straight arms at speed read as a zombie shamble.
  const elbow = -(0.18 + A * 0.45);
  p.set('armL', A * 0.72 * s, 0, -A * 0.10);
  p.set('armR', -A * 0.72 * s, 0, A * 0.10);
  p.set('forearmL', elbow + A * 0.22 * Math.max(0, s), 0, 0);
  p.set('forearmR', elbow + A * 0.22 * Math.max(0, -s), 0, 0);
  p.set('handL', 0, 0, 0);
  p.set('handR', 0, 0, 0);

  // Pelvis: drops on each footfall, rolls toward the support leg, twists against
  // the shoulders. All three together are what makes a walk read as weight.
  p.set('hips', lean * 0.35, -A * 0.16 * s, A * 0.10 * c);
  p.set('spine', lean * 0.30, A * 0.13 * s, 0);
  p.set('chest', lean * 0.22, A * 0.20 * s, -A * 0.05 * c);
  // Head stays level and looks where we're going.
  p.set('neck', -lean * 0.30, -A * 0.10 * s, 0);
  p.set('head', -lean * 0.42 + A * 0.05 * Math.cos(ph * 2), 0, 0);
  p.set('shoulderL', 0, A * 0.10 * s, -A * 0.06);
  p.set('shoulderR', 0, A * 0.10 * s, A * 0.06);

  // The vertical bob is not authored: it is exactly how much the stance leg has to give
  // up to keep the foot where the gait put it, which lands one dip per footfall by
  // construction and scales itself with the stride.
  p.offset(0, drop, 0);
}

const CLIPS = {};

/** @param def {loop?, dur?, blendIn?, blendOut?, fn, lockFacing?} */
const clip = (name, def) => { CLIPS[name] = { blendIn: 0.10, blendOut: 0.18, ...def }; };

// ---- locomotion ------------------------------------------------------------

clip('idle', {
  loop: 3.6,
  locomotion: true,
  fn: (p, t, ctx) => {
    const ph = t * TAU;
    const br = Math.sin(ph);                 // breathing
    const sway = Math.sin(ph * 0.5);         // slow weight shift
    p.zero();
    p.set('hips', 0.015 + br * 0.012, sway * 0.05, sway * 0.045);
    p.set('spine', 0.02 + br * 0.020, sway * 0.04, -sway * 0.02);
    p.set('chest', -0.03 - br * 0.030, sway * 0.055, 0);
    p.set('neck', 0.01 + br * 0.010, -sway * 0.06, 0);
    p.set('head', 0.02, Math.sin(ph * 0.37) * 0.16, sway * 0.03);
    // Arms hang and drift; the shoulder lift follows the breath.
    p.set('shoulderL', 0, 0, -0.03 - br * 0.02);
    p.set('shoulderR', 0, 0, 0.03 + br * 0.02);
    p.set('armL', br * 0.035, 0, -0.05 + sway * 0.03);
    p.set('armR', -br * 0.035, 0, 0.05 + sway * 0.03);
    p.set('forearmL', -0.16 - br * 0.04, 0, 0);
    p.set('forearmR', -0.16 + br * 0.04, 0, 0);
    // Knees never lock straight — a perfectly straight leg reads as a mannequin.
    p.set('thighL', 0.02, 0, 0);
    p.set('thighR', -0.01, 0, 0);
    p.set('shinL', 0.06, 0, 0);
    p.set('shinR', 0.05, 0, 0);
    p.offset(0, br * 0.006 * ctx.scale, 0);
  },
});

// `paced` means the clip is stepped by distance rather than by time, with the stride the
// gait table implies for the character's own legs — never a constant, and never per clip.
clip('walk', {
  paced: true, locomotion: true,
  fn: (p, t, ctx) => { p.zero(); locomotionPose(p, t * TAU, 0.42, 0.06, ctx); },
});
clip('run', {
  paced: true, locomotion: true,
  fn: (p, t, ctx) => { p.zero(); locomotionPose(p, t * TAU, 0.72, 0.20, ctx); },
});
clip('sprint', {
  paced: true, locomotion: true,
  fn: (p, t, ctx) => { p.zero(); locomotionPose(p, t * TAU, 0.92, 0.34, ctx); },
});

clip('fall', {
  loop: 1.6, locomotion: true,
  fn: (p, t, ctx) => {
    const w = Math.sin(t * TAU);
    p.zero();
    // Trailing legs, arms up and out — the classic "not in control" read.
    p.set('hips', -0.10, 0, 0);
    p.set('spine', -0.08, w * 0.05, 0);
    p.set('chest', -0.10, -w * 0.06, 0);
    p.set('head', -0.14, 0, 0);
    p.set('armL', -1.85 + w * 0.10, 0, -0.55);
    p.set('armR', -1.85 - w * 0.10, 0, 0.55);
    p.set('forearmL', -0.70, 0, 0);
    p.set('forearmR', -0.70, 0, 0);
    p.set('thighL', 0.32 + w * 0.10, 0, 0.06);
    p.set('thighR', 0.20 - w * 0.10, 0, -0.10);
    p.set('shinL', 0.70, 0, 0);
    p.set('shinR', 0.95, 0, 0);
    p.set('footL', -0.30, 0, 0);
    p.set('footR', -0.30, 0, 0);
  },
});

clip('glide', {
  loop: 2.8, locomotion: true,
  fn: (p, t, ctx) => {
    const w = Math.sin(t * TAU);
    p.zero();
    // Pitched forward, arms spread to the wings, legs together and trailing.
    p.set('hips', 0.52, 0, 0);
    p.set('spine', 0.16, w * 0.03, 0);
    p.set('chest', 0.10, -w * 0.04, 0);
    p.set('neck', -0.46, 0, 0);
    p.set('head', -0.30, 0, 0);
    p.set('shoulderL', 0, 0, -0.30);
    p.set('shoulderR', 0, 0, 0.30);
    p.set('armL', -0.10, 0, -1.24 + w * 0.05);
    p.set('armR', -0.10, 0, 1.24 - w * 0.05);
    p.set('forearmL', -0.12, 0, -0.10);
    p.set('forearmR', -0.12, 0, 0.10);
    p.set('thighL', 0.28, 0, 0.04);
    p.set('thighR', 0.28, 0, -0.04);
    p.set('shinL', 0.30 + w * 0.06, 0, 0);
    p.set('shinR', 0.30 - w * 0.06, 0, 0);
    p.set('footL', -0.24, 0, 0);
    p.set('footR', -0.24, 0, 0);
  },
});

clip('swim', {
  loop: 1.5, locomotion: true,
  fn: (p, t, ctx) => {
    const ph = t * TAU;
    const s = Math.sin(ph);
    p.zero();
    // Breaststroke: both arms sweep together, legs flutter at double rate.
    const reach = Math.sin(ph - 0.5);
    p.set('hips', 0.95, 0, 0);
    p.set('spine', 0.10, 0, 0);
    p.set('chest', 0.06, 0, 0);
    p.set('neck', -0.72, 0, 0);
    p.set('head', -0.34, 0, 0);
    p.set('armL', -1.30 - reach * 0.55, 0, -0.42 - Math.max(0, -reach) * 0.5);
    p.set('armR', -1.30 - reach * 0.55, 0, 0.42 + Math.max(0, -reach) * 0.5);
    p.set('forearmL', -0.45 - Math.max(0, reach) * 0.7, 0, 0);
    p.set('forearmR', -0.45 - Math.max(0, reach) * 0.7, 0, 0);
    p.set('thighL', -0.10 - Math.sin(ph * 2) * 0.24, 0, 0.05);
    p.set('thighR', -0.10 + Math.sin(ph * 2) * 0.24, 0, -0.05);
    p.set('shinL', 0.22 + Math.max(0, Math.sin(ph * 2)) * 0.45, 0, 0);
    p.set('shinR', 0.22 + Math.max(0, -Math.sin(ph * 2)) * 0.45, 0, 0);
    p.set('footL', -0.32, 0, 0);
    p.set('footR', -0.32, 0, 0);
    p.offset(0, s * 0.02 * ctx.scale, 0);
  },
});

clip('climb', {
  loop: 1.30, locomotion: true,
  fn: (p, t, ctx) => {
    const ph = t * TAU;
    const s = Math.sin(ph);
    p.zero();
    // Opposite hand and foot reach together; the hips press in toward the wall.
    p.set('hips', -0.10, 0, 0);
    p.set('spine', -0.04, s * 0.10, 0);
    p.set('chest', -0.06, -s * 0.14, 0);
    p.set('head', -0.20, 0, 0);
    p.set('armL', -2.35 - s * 0.40, 0, -0.30);
    p.set('armR', -2.35 + s * 0.40, 0, 0.30);
    p.set('forearmL', -0.55 + Math.max(0, s) * 0.5, 0, 0);
    p.set('forearmR', -0.55 + Math.max(0, -s) * 0.5, 0, 0);
    p.set('thighL', -0.55 + s * 0.42, 0, 0.22);
    p.set('thighR', -0.55 - s * 0.42, 0, -0.22);
    p.set('shinL', 0.85 - s * 0.30, 0, 0);
    p.set('shinR', 0.85 + s * 0.30, 0, 0);
    p.offset(0, s * 0.03 * ctx.scale, 0.06 * ctx.scale);
  },
});

clip('sit', {
  loop: 4.0, locomotion: true,
  fn: (p, t, ctx) => {
    const br = Math.sin(t * TAU);
    p.zero();
    p.set('hips', -0.16, 0, 0);
    p.set('spine', 0.10 + br * 0.02, 0, 0);
    p.set('chest', 0.06, br * 0.03, 0);
    p.set('head', -0.06, br * 0.10, 0);
    p.set('armL', 0.30, 0, -0.16);
    p.set('armR', 0.30, 0, 0.16);
    p.set('forearmL', -0.85, 0, 0);
    p.set('forearmR', -0.85, 0, 0);
    p.set('thighL', -1.42, 0, 0.16);
    p.set('thighR', -1.42, 0, -0.16);
    p.set('shinL', 1.50, 0, 0);
    p.set('shinR', 1.50, 0, 0);
    p.set('footL', -0.20, 0, 0);
    p.set('footR', -0.20, 0, 0);
    // Hips have to drop to the ground, not just rotate.
    p.offset(0, -0.42 * ctx.scale, -0.05 * ctx.scale);
  },
});

clip('down', {
  loop: 3.0, locomotion: true,
  fn: (p, t, ctx) => {
    const br = Math.sin(t * TAU) * 0.5 + 0.5;
    p.zero();
    // Face down, collapsed. Faint breathing so it doesn't look like a prop.
    p.set('hips', 1.42, 0, 0.10);
    p.set('spine', -0.12 - br * 0.03, 0, 0);
    p.set('chest', -0.20, 0.12, 0);
    p.set('neck', -0.30, 0, 0);
    p.set('head', 0.10, 0.28, 0);
    p.set('armL', -0.95, 0, -0.85);
    p.set('armR', -0.55, 0, 0.35);
    p.set('forearmL', -1.05, 0, 0);
    p.set('forearmR', -0.45, 0, 0);
    p.set('thighL', 0.22, 0, 0.28);
    p.set('thighR', 0.10, 0, -0.14);
    p.set('shinL', 0.55, 0, 0);
    p.set('shinR', 0.28, 0, 0);
    p.offset(0, -0.46 * ctx.scale, 0.10 * ctx.scale);
  },
});

clip('aim', {
  loop: 2.6, locomotion: true,
  fn: (p, t, ctx) => {
    const br = Math.sin(t * TAU) * 0.02;
    p.zero();
    // Bow stance: torso bladed to the target, bow arm out, draw hand at the cheek.
    p.set('hips', 0.02, -0.30, 0);
    p.set('spine', 0.03, -0.16, 0);
    p.set('chest', -0.02, -0.34, 0);
    p.set('neck', 0.0, 0.30, 0);
    p.set('head', 0.02, 0.44, 0);
    p.set('shoulderL', 0, -0.16, -0.20);
    p.set('shoulderR', 0, 0.10, 0.16);
    p.set('armL', -1.50 + br, -0.30, -0.20);
    p.set('forearmL', -0.10, 0, 0);
    p.set('armR', -1.05 - br, 0.55, 0.62);
    p.set('forearmR', -1.85, 0, 0);
    p.set('thighL', -0.10, -0.28, 0.10);
    p.set('thighR', 0.10, 0.20, -0.12);
    p.set('shinL', 0.22, 0, 0);
    p.set('shinR', 0.30, 0, 0);
  },
});

// ---- one-shots -------------------------------------------------------------

clip('jump', {
  dur: 0.72, blendIn: 0.06, blendOut: 0.22,
  fn: (p, t, ctx) => {
    p.zero();
    // Crouch (0..0.22) then extend. The offset is what sells the launch; the
    // rotations alone read as a curtsy.
    const crouch = t < 0.22 ? smooth(t / 0.22) : 1 - smooth((t - 0.22) / 0.28);
    const ext = smooth(clamp01((t - 0.22) / 0.30));
    p.set('hips', 0.30 * crouch - 0.10 * ext, 0, 0);
    p.set('spine', 0.18 * crouch, 0, 0);
    p.set('chest', -0.10 * crouch - 0.10 * ext, 0, 0);
    p.set('head', -0.10 * crouch - 0.18 * ext, 0, 0);
    p.set('armL', 0.85 * crouch - 2.20 * ext, 0, -0.30 * ext);
    p.set('armR', 0.85 * crouch - 2.20 * ext, 0, 0.30 * ext);
    p.set('forearmL', -0.55 * crouch - 0.35 * ext, 0, 0);
    p.set('forearmR', -0.55 * crouch - 0.35 * ext, 0, 0);
    p.set('thighL', -0.95 * crouch + 0.30 * ext, 0, 0.10 * crouch);
    p.set('thighR', -0.95 * crouch + 0.30 * ext, 0, -0.10 * crouch);
    p.set('shinL', 1.55 * crouch + 0.10, 0, 0);
    p.set('shinR', 1.55 * crouch + 0.10, 0, 0);
    p.set('footL', -0.55 * crouch + 0.35 * ext, 0, 0);
    p.set('footR', -0.55 * crouch + 0.35 * ext, 0, 0);
    p.offset(0, (-0.24 * crouch + 0.05 * ext) * ctx.scale, 0);
  },
});

clip('dash', {
  dur: 0.42, blendIn: 0.05, blendOut: 0.16,
  fn: (p, t, ctx) => {
    const k = Math.sin(clamp01(t) * Math.PI);
    p.zero();
    p.set('hips', 0.42 * k, 0, 0);
    p.set('spine', 0.16 * k, 0, 0);
    p.set('chest', 0.10 * k, 0, 0);
    p.set('neck', -0.40 * k, 0, 0);
    p.set('head', -0.24 * k, 0, 0);
    p.set('armL', 1.10 * k, 0, -0.30 * k);
    p.set('armR', -1.30 * k, 0, 0.24 * k);
    p.set('forearmL', -0.90 * k, 0, 0);
    p.set('forearmR', -0.60 * k, 0, 0);
    p.set('thighL', -0.85 * k, 0, 0);
    p.set('thighR', 0.70 * k, 0, 0);
    p.set('shinL', 1.05 * k, 0, 0);
    p.set('shinR', 0.35 * k, 0, 0);
    p.offset(0, -0.05 * k * ctx.scale, 0);
  },
});

clip('plunge', {
  dur: 0.9, blendIn: 0.08, blendOut: 0.20,
  fn: (p, t, ctx) => {
    // Weapon held overhead, body vertical and rigid, then the landing snap.
    const land = smooth(clamp01((t - 0.62) / 0.20));
    p.zero();
    p.set('hips', -0.14 + 0.55 * land, 0, 0);
    p.set('spine', -0.08 + 0.20 * land, 0, 0);
    p.set('chest', -0.12 + 0.12 * land, 0, 0);
    p.set('head', -0.10 - 0.20 * land, 0, 0);
    p.set('armL', -2.45 + 3.0 * land, 0, -0.42);
    p.set('armR', -2.55 + 3.1 * land, 0, 0.42);
    p.set('forearmL', -0.35 - 0.4 * land, 0, 0);
    p.set('forearmR', -0.35 - 0.4 * land, 0, 0);
    p.set('thighL', 0.30 - 1.35 * land, 0, 0.10);
    p.set('thighR', 0.34 - 1.20 * land, 0, -0.10);
    p.set('shinL', 0.55 + 1.30 * land, 0, 0);
    p.set('shinR', 0.62 + 1.15 * land, 0, 0);
    p.set('footL', -0.30 - 0.30 * land, 0, 0);
    p.set('footR', -0.30 - 0.30 * land, 0, 0);
    p.offset(0, -0.30 * land * ctx.scale, 0);
  },
});

clip('hit', {
  dur: 0.34, blendIn: 0.03, blendOut: 0.14,
  fn: (p, t, ctx) => {
    // Sharp snap back then a fast settle. Impact needs a spike, not a curve.
    const k = Math.pow(1 - clamp01(t), 2) * Math.cos(clamp01(t) * 9.0);
    p.zero();
    p.set('hips', -0.22 * k, 0.08 * k, 0);
    p.set('spine', -0.20 * k, -0.10 * k, 0);
    p.set('chest', -0.26 * k, 0.14 * k, 0);
    p.set('neck', -0.20 * k, 0, 0);
    p.set('head', -0.30 * k, -0.12 * k, 0);
    p.set('armL', -0.55 * k, 0, -0.45 * k);
    p.set('armR', -0.50 * k, 0, 0.40 * k);
    p.set('forearmL', -0.55 * k, 0, 0);
    p.set('forearmR', -0.50 * k, 0, 0);
    p.set('thighL', 0.26 * k, 0, 0);
    p.set('thighR', 0.18 * k, 0, 0);
    p.set('shinL', 0.30 * k, 0, 0);
    p.set('shinR', 0.22 * k, 0, 0);
    p.offset(0, 0, -0.05 * k * ctx.scale);
  },
});

clip('gather', {
  dur: 1.05, blendIn: 0.14, blendOut: 0.22,
  fn: (p, t, ctx) => {
    // Crouch, reach, take, rise. Held near the bottom so the pickup reads.
    const d = t < 0.34 ? smooth(t / 0.34) : t < 0.66 ? 1 : 1 - smooth((t - 0.66) / 0.34);
    const grab = Math.sin(clamp01((t - 0.30) / 0.34) * Math.PI) * (t > 0.30 && t < 0.68 ? 1 : 0);
    p.zero();
    p.set('hips', 0.60 * d, 0, 0);
    p.set('spine', 0.34 * d, -0.10 * d, 0);
    p.set('chest', 0.24 * d, 0.06 * d, 0);
    p.set('neck', -0.20 * d, 0, 0);
    p.set('head', -0.38 * d, 0, 0);
    p.set('armL', 0.20 * d, 0, -0.18 * d);
    p.set('armR', -0.55 * d - 0.30 * grab, -0.20 * d, 0.10 * d);
    p.set('forearmL', -0.50 * d, 0, 0);
    p.set('forearmR', -0.40 * d + 0.20 * grab, 0, 0);
    p.set('handR', -0.30 * grab, 0, 0);
    p.set('thighL', -1.05 * d, 0, 0.14 * d);
    p.set('thighR', -0.80 * d, 0, -0.20 * d);
    p.set('shinL', 1.55 * d, 0, 0);
    p.set('shinR', 1.25 * d, 0, 0);
    p.set('footL', -0.45 * d, 0, 0);
    p.set('footR', -0.35 * d, 0, 0);
    p.offset(0, -0.34 * d * ctx.scale, 0.04 * d * ctx.scale);
  },
});

/**
 * Melee attacks. Each is a distinct shape so a five-hit string reads as a
 * combo rather than the same swing five times: horizontal, backhand return,
 * thrust, spin, overhead slam.
 */
clip('attack1', {
  dur: 0.46, blendIn: 0.05, blendOut: 0.16,
  fn: (p, t) => {
    const k = swing(t, 0.30, 0.30);          // right-to-left horizontal cut
    p.zero();
    p.set('hips', 0, -0.42 * k, 0);
    p.set('spine', 0.04, -0.34 * k, 0);
    p.set('chest', 0.02, -0.62 * k, -0.10 * k);
    p.set('neck', 0, 0.28 * k, 0);
    p.set('head', 0, 0.34 * k, 0);
    p.set('shoulderR', 0, -0.34 * k, 0.20 * Math.abs(k));
    p.set('armR', -1.05 - 0.30 * k, -0.55 * k, 0.55 + 0.30 * k);
    p.set('forearmR', -1.15 + 0.85 * k, 0, 0);
    p.set('handR', 0, 0, -0.20 * k);
    p.set('armL', 0.35 + 0.45 * k, 0.30 * k, -0.55);
    p.set('forearmL', -1.10, 0, 0);
    p.set('thighL', -0.20 * k, -0.30 * k, 0.08);
    p.set('thighR', 0.24 * k, 0.20 * k, -0.08);
    p.set('shinL', 0.26, 0, 0);
    p.set('shinR', 0.20, 0, 0);
    p.offset(0, 0, 0);
  },
});

clip('attack2', {
  dur: 0.44, blendIn: 0.05, blendOut: 0.16,
  fn: (p, t) => {
    const k = swing(t, 0.26, 0.26);          // backhand, left-to-right
    p.zero();
    p.set('hips', 0, 0.40 * k, 0);
    p.set('spine', 0.03, 0.32 * k, 0);
    p.set('chest', 0.02, 0.60 * k, 0.10 * k);
    p.set('neck', 0, -0.26 * k, 0);
    p.set('head', 0, -0.32 * k, 0);
    p.set('shoulderR', 0, 0.30 * k, 0.16 * Math.abs(k));
    p.set('armR', -0.85 - 0.55 * k, 0.60 * k, 0.30 - 0.55 * k);
    p.set('forearmR', -1.45 + 1.05 * k, 0, 0);
    p.set('armL', 0.25 - 0.30 * k, -0.20 * k, -0.45);
    p.set('forearmL', -0.95, 0, 0);
    p.set('thighL', 0.20 * k, 0.24 * k, 0.08);
    p.set('thighR', -0.22 * k, -0.18 * k, -0.08);
    p.set('shinL', 0.22, 0, 0);
    p.set('shinR', 0.26, 0, 0);
  },
});

clip('attack3', {
  dur: 0.42, blendIn: 0.05, blendOut: 0.14,
  fn: (p, t, ctx) => {
    const k = swing(t, 0.32, 0.34);          // straight thrust
    p.zero();
    p.set('hips', -0.06 * k, -0.20 * k, 0);
    p.set('spine', 0.10 * k, -0.14 * k, 0);
    p.set('chest', 0.08 * k, -0.30 * k, 0);
    p.set('neck', -0.14 * k, 0.14 * k, 0);
    p.set('head', -0.10 * k, 0.16 * k, 0);
    p.set('shoulderR', 0, -0.40 * k, 0);
    p.set('armR', -1.35 * k, -0.10 * k, 0.30 - 0.10 * k);
    p.set('forearmR', -1.60 + 1.55 * k, 0, 0);
    p.set('armL', 0.30 * k, 0.30 * k, -0.50);
    p.set('forearmL', -1.25, 0, 0);
    // Lunging step: the whole body travels, which is what a thrust needs.
    p.set('thighL', -0.62 * k, 0, 0.08);
    p.set('thighR', 0.45 * k, 0, -0.08);
    p.set('shinL', 0.70 * k + 0.10, 0, 0);
    p.set('shinR', 0.22, 0, 0);
    p.set('footL', -0.30 * k, 0, 0);
    p.offset(0, -0.06 * Math.abs(k) * ctx.scale, 0.20 * k * ctx.scale);
  },
});

clip('attack4', {
  dur: 0.58, blendIn: 0.06, blendOut: 0.18,
  fn: (p, t, ctx) => {
    const k = swing(t, 0.24, 0.20);          // full spin cut
    p.zero();
    p.yaw(-k * TAU);                         // the body actually rotates
    p.set('hips', 0, -0.20 * k, 0);
    p.set('spine', 0.06, -0.14 * k, 0);
    p.set('chest', 0.04, -0.34 * k, -0.14 * k);
    p.set('head', 0, 0.20 * k, 0);
    p.set('shoulderR', 0, -0.20 * k, 0.24 * Math.abs(k));
    p.set('armR', -1.30, -0.30 * k, 0.85 + 0.20 * k);
    p.set('forearmR', -0.45, 0, 0);
    p.set('armL', -0.55, 0.20 * k, -0.85);
    p.set('forearmL', -0.55, 0, 0);
    p.set('thighL', -0.26 * k, -0.20 * k, 0.10);
    p.set('thighR', 0.30 * k, 0.16 * k, -0.10);
    p.set('shinL', 0.30 + 0.20 * Math.abs(k), 0, 0);
    p.set('shinR', 0.26, 0, 0);
    p.offset(0, -0.03 * Math.abs(k) * ctx.scale, 0);
  },
});

clip('attack5', {
  dur: 0.62, blendIn: 0.06, blendOut: 0.20,
  fn: (p, t, ctx) => {
    const k = swing(t, 0.36, 0.42);          // overhead slam
    // `swing` deliberately overshoots past 1 on the follow-through, which is right
    // for a rotation but wrong for a travel this large: unclamped it carries the
    // arms past vertical-down and out behind the back.
    const drive = clamp01(k);
    p.zero();
    p.set('hips', 0.30 * k, 0, 0);
    p.set('spine', 0.26 * k, 0, 0);
    p.set('chest', 0.22 * k, 0, 0);
    p.set('neck', -0.30 * k, 0, 0);
    p.set('head', -0.22 * k, 0, 0);
    // Both hands overhead, *further* back on the wind-up (k < 0), driving down to
    // about waist height on the strike.
    p.set('armR', -2.60 + 0.55 * Math.min(0, k) + 2.50 * drive, 0, 0.34);
    p.set('armL', -2.50 + 0.55 * Math.min(0, k) + 2.42 * drive, 0, -0.34);
    p.set('forearmR', -0.40 - 0.70 * drive, 0, 0);
    p.set('forearmL', -0.40 - 0.70 * drive, 0, 0);
    p.set('thighL', -0.55 * drive, 0, 0.10);
    p.set('thighR', -0.35 * drive, 0, -0.10);
    p.set('shinL', 0.80 * drive + 0.08, 0, 0);
    p.set('shinR', 0.55 * drive + 0.08, 0, 0);
    p.offset(0, -0.20 * drive * ctx.scale, 0.06 * k * ctx.scale);
  },
});

clip('charged', {
  dur: 1.10, blendIn: 0.10, blendOut: 0.20,
  fn: (p, t, ctx) => {
    // Long hold at full wind-up, then a heavy release.
    const hold = t < 0.55 ? smooth(t / 0.30) : 0;
    const rel = t >= 0.55 ? easeOutCubic((t - 0.55) / 0.30) : 0;
    const shake = hold * Math.sin(t * 90) * 0.02;
    p.zero();
    p.set('hips', 0.20 * hold + 0.24 * rel, -0.50 * hold + 0.30 * rel, 0);
    p.set('spine', 0.16 * hold + 0.18 * rel, -0.38 * hold + 0.24 * rel, 0);
    p.set('chest', 0.10 * hold + 0.14 * rel, -0.70 * hold + 0.55 * rel, 0);
    p.set('neck', -0.16 * hold, 0.40 * hold - 0.20 * rel, 0);
    p.set('head', -0.10 * hold, 0.44 * hold - 0.26 * rel, 0);
    p.set('armR', -2.30 * hold + 3.0 * rel + shake, -0.70 * hold, 0.40 + 0.30 * hold);
    p.set('forearmR', -1.30 * hold - 0.30 * rel, 0, 0);
    p.set('armL', 0.30 * hold - 0.20 * rel, 0.40 * hold, -0.60);
    p.set('forearmL', -1.30 * hold, 0, 0);
    p.set('thighL', -0.42 * hold - 0.30 * rel, -0.34 * hold, 0.10);
    p.set('thighR', 0.30 * hold + 0.20 * rel, 0.26 * hold, -0.10);
    p.set('shinL', 0.55 * hold + 0.30 * rel, 0, 0);
    p.set('shinR', 0.30 * hold, 0, 0);
    p.offset(0, (-0.10 * hold - 0.06 * rel) * ctx.scale, 0.10 * rel * ctx.scale);
  },
});

clip('skill', {
  dur: 0.86, blendIn: 0.08, blendOut: 0.22,
  fn: (p, t, ctx) => {
    // Gather (arms in) then cast (arm sweeps out and forward).
    const gather = t < 0.40 ? smooth(t / 0.34) : 1 - smooth((t - 0.40) / 0.26);
    const cast = smooth(clamp01((t - 0.40) / 0.24)) * (1 - smooth(clamp01((t - 0.78) / 0.22)));
    p.zero();
    p.set('hips', 0.10 * gather - 0.10 * cast, -0.24 * gather + 0.20 * cast, 0);
    p.set('spine', 0.14 * gather - 0.12 * cast, -0.20 * gather + 0.16 * cast, 0);
    p.set('chest', -0.14 * gather - 0.16 * cast, -0.30 * gather + 0.36 * cast, 0);
    p.set('neck', 0.04 * gather - 0.12 * cast, 0.20 * gather - 0.18 * cast, 0);
    p.set('head', -0.06 * gather - 0.18 * cast, 0.22 * gather - 0.22 * cast, 0);
    // Right hand pulls to the chest, then throws forward and out.
    p.set('armR', -0.95 * gather - 1.45 * cast, -0.30 * gather + 0.20 * cast, 0.30 + 0.55 * gather - 0.20 * cast);
    p.set('forearmR', -1.85 * gather - 0.25 * cast, 0, 0);
    p.set('handR', -0.35 * gather + 0.45 * cast, 0, 0);
    p.set('armL', -0.55 * gather - 0.70 * cast, 0.20 * gather, -0.35 - 0.50 * gather - 0.30 * cast);
    p.set('forearmL', -1.35 * gather - 0.55 * cast, 0, 0);
    p.set('thighL', -0.20 * gather - 0.24 * cast, 0, 0.10);
    p.set('thighR', -0.10 * gather + 0.18 * cast, 0, -0.10);
    p.set('shinL', 0.30 * gather + 0.30 * cast + 0.06, 0, 0);
    p.set('shinR', 0.22 * gather + 0.06, 0, 0);
    p.offset(0, -0.08 * gather * ctx.scale, 0.06 * cast * ctx.scale);
  },
});

clip('burst', {
  dur: 1.60, blendIn: 0.12, blendOut: 0.28,
  fn: (p, t, ctx) => {
    // Three beats: rise (arms up, back arched), hold, slam.
    const rise = smooth(clamp01(t / 0.28));
    const hold = clamp01((t - 0.28) / 0.10) * (1 - smooth(clamp01((t - 0.62) / 0.10)));
    const slam = smooth(clamp01((t - 0.66) / 0.16)) * (1 - smooth(clamp01((t - 1.10) / 0.50)));
    const float = Math.sin(clamp01((t - 0.28) / 0.38) * Math.PI);
    p.zero();
    p.set('hips', -0.34 * rise + 0.40 * slam, 0, 0);
    p.set('spine', -0.26 * rise + 0.30 * slam, 0.06 * hold, 0);
    p.set('chest', -0.34 * rise + 0.26 * slam, -0.06 * hold, 0);
    p.set('neck', 0.20 * rise - 0.34 * slam, 0, 0);
    p.set('head', 0.34 * rise - 0.30 * slam, 0, 0);
    p.set('shoulderL', 0, 0, -0.24 * rise);
    p.set('shoulderR', 0, 0, 0.24 * rise);
    p.set('armL', -2.85 * rise + 3.10 * slam, -0.20 * rise, -0.50 * rise + 0.30 * slam);
    p.set('armR', -2.85 * rise + 3.10 * slam, 0.20 * rise, 0.50 * rise - 0.30 * slam);
    p.set('forearmL', -0.30 * rise - 0.85 * slam, 0, 0);
    p.set('forearmR', -0.30 * rise - 0.85 * slam, 0, 0);
    p.set('handL', -0.40 * rise, 0, 0);
    p.set('handR', -0.40 * rise, 0, 0);
    p.set('thighL', 0.16 * rise - 0.75 * slam, 0, 0.08 + 0.10 * slam);
    p.set('thighR', 0.16 * rise - 0.62 * slam, 0, -0.08 - 0.10 * slam);
    p.set('shinL', 0.10 + 1.05 * slam, 0, 0);
    p.set('shinR', 0.10 + 0.88 * slam, 0, 0);
    p.set('footL', -0.30 * slam, 0, 0);
    p.set('footR', -0.30 * slam, 0, 0);
    // Lifts off the ground during the hold, drives down on the slam.
    p.offset(0, (0.12 * float - 0.26 * slam) * ctx.scale, 0);
  },
});

/* --------------------------------------------------------- secondary motion -- */

/**
 * A critically-ish damped angular spring. Secondary bones are integrated rather
 * than posed: hair and capes have to lag the body to read as cloth, and any
 * keyframed approximation of that lag is wrong the moment the player changes
 * direction.
 */
class Spring {
  constructor(stiffness, damping, limit) {
    this.x = 0; this.v = 0;
    this.k = stiffness; this.d = damping; this.limit = limit;
  }
  step(dt, target) {
    // Semi-implicit Euler, substepped so a frame spike can't make it explode.
    const steps = dt > 1 / 45 ? 2 : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.v += (this.k * (target - this.x) - this.d * this.v) * h;
      this.x += this.v * h;
      if (this.x > this.limit) { this.x = this.limit; this.v *= -0.25; }
      else if (this.x < -this.limit) { this.x = -this.limit; this.v *= -0.25; }
    }
    return this.x;
  }
}

/** Per-bone spring tuning: [stiffness, damping, limit, driveScale]. */
const SECONDARY_TUNING = {
  capeA: [58, 11, 1.05, 1.00],
  capeB: [42, 9, 1.25, 1.30],
  hairFront: [150, 19, 0.34, 0.35],
  hairBackL: [92, 14, 0.80, 0.85],
  hairBackR: [92, 14, 0.80, 0.85],
  hairTail: [70, 12, 1.05, 1.05],
};

/* ----------------------------------------------------------------- animator -- */

const TMP_Q = new THREE.Quaternion();
const TMP_E = new THREE.Euler();
const TMP_V = new THREE.Vector3();
const TMP_V2 = new THREE.Vector3();
const TMP_T = new THREE.Vector3();
const TMP_M = new THREE.Matrix4();

const clampCos = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

export class Animator {
  /**
   * @param rig  the object returned by buildHumanoid()
   */
  constructor(rig) {
    this.rig = rig;
    this.bones = rig.bones;

    // Leg geometry, read off the skeleton rather than passed in: the two segment lengths
    // the leg solver needs are exactly the child bones' offsets, so they cannot drift out
    // of step with the model the way a duplicated constant would.
    this.legT = Math.abs(this.bones.shinL.position.y);
    this.legS = Math.abs(this.bones.footL.position.y);
    this.legLen = this.legT + this.legS;
    this.footX = { L: this.bones.thighL.position.x, R: this.bones.thighR.position.x };

    // Height-relative so a 1.86 m character's bob is proportional to a 1.60 m one's.
    this.ctx = { scale: rig.height / 1.7, speed: 0, grounded: true, legLen: this.legLen, gait: null };

    // The bind pose is the reference every clip is an *offset* from, so a clip
    // never has to know about the A-pose arm spread or the hip height.
    this.rest = {};
    for (const name of POSE_BONES) {
      const b = this.bones[name];
      this.rest[name] = { e: b.rotation.clone(), p: b.position.clone() };
    }
    this.restRootY = this.bones.hips.position.y;

    this.basePose = new Pose();
    this.overlayPose = new Pose();
    this.outPose = new Pose();
    this.prevBase = new Pose();

    this.base = 'idle';
    this.baseTime = 0;
    this.basePhase = 0;             // distance-driven, in cycles
    this.stepIndex = 0;             // footfalls so far: two per cycle
    this._stepSeen = 0;
    // Cross-fade between locomotion clips (walk → run etc.).
    this.fadeFrom = null;
    this.fadeT = 0;
    this.fadeDur = 0.18;

    this.overlay = null;
    this.overlayTime = 0;
    this.overlayWeight = 0;

    // Secondary springs: two axes each (swing, lateral).
    this.springs = {};
    for (const [name, [k, d, lim]] of Object.entries(SECONDARY_TUNING)) {
      if (!this.bones[name]) continue;
      this.springs[name] = {
        x: new Spring(k, d, lim),
        z: new Spring(k * 1.15, d * 1.05, lim * 0.7),
        rest: this.bones[name].rotation.clone(),
      };
    }

    // Motion history for the springs, in the character's own local frame.
    this.lastWorld = new THREE.Vector3();
    this.lastYaw = 0;
    this.localVel = new THREE.Vector3();
    this.yawRate = 0;
    this.hasHistory = false;
    // Upper-body pose history. Root motion alone leaves the hair dead during an
    // attack — the character barely translates, but the torso and head whip
    // through 60°, and that is exactly when cloth should react most.
    this.lastTorso = { x: 0, y: 0 };
    this.torsoRate = { x: 0, y: 0 };

    this.facingYaw = 0;             // extra yaw the current clip asks for
  }

  /* ------------------------------------------------------------- public API -- */

  /**
   * Request an action. Locomotion actions replace the base layer with a
   * cross-fade; everything else fires as a one-shot overlay, which is what lets
   * an attack interrupt a sprint and then hand control straight back.
   */
  play(action, opts = {}) {
    const name = typeof action === 'number' ? ACTION_NAMES[action] : action;
    const cl = CLIPS[name];
    if (!cl) return false;
    if (cl.locomotion) {
      if (this.base === name && !opts.restart) return true;
      this.prevBase.a.set(this.outPose.a);
      this.fadeFrom = this.prevBase;
      this.fadeT = 0;
      this.fadeDur = opts.fade ?? (name === 'idle' ? 0.22 : 0.16);
      this.base = name;
      this.baseTime = 0;
      return true;
    }
    // Re-firing the same one-shot restarts it (combo mashing), but only past a
    // small guard so a duplicated network event doesn't reset mid-swing.
    if (this.overlay === name && this.overlayTime < 0.06) return true;
    this.overlay = name;
    this.overlayTime = 0;
    this.overlaySpeed = opts.speed ?? 1;
    return true;
  }

  /** Is a one-shot still playing? Gameplay uses this to gate the next combo hit. */
  get busy() { return this.overlay !== null; }
  get currentAction() { return this.overlay ?? this.base; }
  /** 0..1 progress through the current one-shot, or 1 if none. */
  get overlayProgress() {
    if (!this.overlay) return 1;
    return clamp01(this.overlayTime / CLIPS[this.overlay].dur);
  }

  /**
   * Metres per gait cycle at `speed` for *this* character. The one place a stride exists:
   * gameplay code that needs to know how far a step covers (footstep dust, sound) asks
   * here instead of keeping its own constant, which is how the old 1.5 m / 2.1 m pair
   * drifted away from the animation it was supposed to describe.
   */
  strideAt(speed = this.ctx.speed) { return gaitAt(speed, this.legLen).stride; }

  /**
   * Footfalls since the last call, and which foot just landed. Two per cycle, driven by
   * the same phase that placed the feet.
   */
  takeSteps() {
    const n = Math.max(0, this.stepIndex - this._stepSeen);
    this._stepSeen = this.stepIndex;
    // L plants at phase 0, R at 0.5 — so an even index is a left footfall.
    return { n, side: this.stepIndex % 2 === 0 ? 'L' : 'R' };
  }

  /**
   * Pick the locomotion clip implied by movement state.
   *
   * This is the *only* consumer of the looping clips, so a state the caller never passes is a
   * clip nobody can ever see: `sit` and `aim` were authored, listed in the `ACTION` enum (so a
   * remote client would have shown them) and reachable from nowhere, because nothing put
   * `sitting` or `aiming` in this object. `tools/motion-check.mjs` now gates the vocabulary in
   * both directions.
   */
  autoLocomotion(state) {
    const {
      speed = 0, grounded = true, swimming = false, gliding = false, climbing = false,
      sitting = false, aiming = false,
    } = state;
    if (climbing) return 'climb';
    if (swimming) return 'swim';
    if (gliding) return 'glide';
    if (!grounded) return 'fall';
    // Sitting outranks the speed bands but not the airborne states: standing up is the caller's
    // job (any movement input clears it), while falling off the rock you sat on is not.
    if (sitting) return 'sit';
    // Aiming only holds the draw stance while planted. Walking with a nocked arrow needs its own
    // clip; blending the bow stance onto the walk cycle puts the bow arm through the knee.
    if (aiming && speed < 0.25) return 'aim';
    if (speed < 0.25) return 'idle';
    if (speed < 2.6) return 'walk';
    if (speed < 5.4) return 'run';
    return 'sprint';
  }

  /**
   * Advance and apply the pose.
   *
   * @param dt      seconds
   * @param state   { speed, grounded, swimming, gliding, climbing, auto, advance }
   *                `advance` is the ground the body covered this frame, in metres, when the
   *                caller knows it (see the base layer below); omit it and the odometer falls
   *                back to `speed * dt`.
   */
  update(dt, state = {}) {
    const ctx = this.ctx;
    ctx.speed = state.speed ?? 0;
    ctx.grounded = state.grounded ?? true;

    if (state.auto !== false) {
      const want = this.autoLocomotion(state);
      if (want !== this.base) this.play(want);
    }

    // --- base layer ---------------------------------------------------------
    const baseClip = CLIPS[this.base];
    this.baseTime += dt;
    let bt;
    if (baseClip.paced) {
      // Distance-driven so the feet don't slide: one cycle per stride, and the stride is
      // whatever this character's legs imply at this speed.
      ctx.gait = gaitAt(ctx.speed, this.legLen);
      // Ground covered, not time elapsed. `state.advance` is how far this body actually moved
      // since the last frame, which is the only thing the feet can be planted against: a remote
      // actor's position is interpolated against the wall clock while `dt` here is the loop's,
      // clamped to 50 ms, so `speed * dt` under-counts the ground on every frame slower than
      // 20 fps and the planted foot slides forward to make up the difference. Callers that move
      // their own body by `speed * dt` (the local player) pass no `advance` and are unchanged.
      //
      // Not capped. The first form of this line was `min(advance, stride)`, meant to keep the legs
      // from spinning through a teleport — but one stride is exactly one *cycle*, so on every
      // frame whose ground reached the stride the phase advanced by a whole turn and the pose came
      // out bit-identical: the legs froze mid-stride while the body slid, which is the defect this
      // whole path exists to fix, reintroduced at low frame rates only. The pose is periodic, so
      // walking a long step through it is exactly right for a real stride and harmless for a
      // correction: a body that jumps while standing still is in `idle`, and one that jumps while
      // running lands on an arbitrary phase for a single frame.
      const step = state.advance != null ? state.advance : ctx.speed * dt;
      this.basePhase += step / ctx.gait.stride;
      bt = this.basePhase % 1;
      // Footfalls come from the same phase the feet are placed from, so a dust puff or a
      // step sound can never drift away from the step it belongs to.
      this.stepIndex = Math.floor(this.basePhase * 2);
    } else {
      ctx.gait = null;
      bt = (this.baseTime / baseClip.loop) % 1;
    }
    baseClip.fn(this.basePose, bt, ctx);

    if (this.fadeFrom) {
      this.fadeT += dt;
      const w = smooth(this.fadeT / this.fadeDur);
      lerpPose(this.outPose, this.fadeFrom, this.basePose, w);
      if (this.fadeT >= this.fadeDur) this.fadeFrom = null;
    } else {
      this.outPose.a.set(this.basePose.a);
    }

    // --- overlay layer -----------------------------------------------------
    if (this.overlay) {
      const oc = CLIPS[this.overlay];
      this.overlayTime += dt * (this.overlaySpeed ?? 1);
      const t = this.overlayTime / oc.dur;
      oc.fn(this.overlayPose, clamp01(t), ctx);
      // Envelope: ramp in, hold, ramp out. Ramping out inside the clip rather
      // than after it means the recovery frames blend back into locomotion
      // instead of snapping.
      const wIn = smooth(this.overlayTime / oc.blendIn);
      const wOut = 1 - smooth((this.overlayTime - (oc.dur - oc.blendOut)) / oc.blendOut);
      this.overlayWeight = Math.min(wIn, Math.max(0, wOut));
      lerpPose(this.outPose, this.outPose, this.overlayPose, this.overlayWeight);
      if (this.overlayTime >= oc.dur) { this.overlay = null; this.overlayWeight = 0; }
    }

    this.applyPose(this.outPose);
    this.updateSecondary(dt);
  }

  /* ------------------------------------------------------------- internals -- */

  applyPose(pose) {
    const a = pose.a;
    for (const name of POSE_BONES) {
      const i = IDX[name];
      const b = this.bones[name];
      const r = this.rest[name].e;
      // Additive Euler on top of the bind pose. Not a true rotation composition,
      // but the bind offsets are small and this is what makes clips composable
      // and cheap; a quaternion product here would also fight the pose blend.
      b.rotation.set(r.x + a[i], r.y + a[i + 1], r.z + a[i + 2]);
    }
    const hips = this.bones.hips;
    const rp = this.rest.hips.p;
    hips.position.set(rp.x + a[CH_OFF_X], rp.y + a[CH_OFF_Y], rp.z + a[CH_OFF_Z]);
    this.facingYaw = a[CH_YAW];
    // Whole-body spin lives on the root bone so it composes with the group's own
    // facing without the gameplay layer having to know a clip is spinning.
    this.bones.root.rotation.y = a[CH_YAW];
    this.solveLegs(pose);
  }

  /**
   * Bend each leg to reach the foot target the pose asked for, instead of trusting the
   * clip's joint angles to land in the right place.
   *
   * This has to be a solve rather than a curve: the pelvis bobs, leans and rolls, and any
   * pair of hip/knee angles that puts the foot on the ground for one pelvis position puts
   * it through the ground for the next. Solving in the *hips'* own frame is the point —
   * the target is a place in the world (well, in the character's frame, whose origin is on
   * the ground), so the pelvis can move underneath a planted foot without dragging it.
   *
   * Two bones in a plane, closed form. With limbs hanging along -Y and a positive
   * rotation.x swinging the far end backwards: the hip aims at the target and then opens
   * by the triangle's angle at the hip, and the knee closes by its interior angle.
   */
  solveLegs(pose) {
    const a = pose.a;
    const hips = this.bones.hips;
    let updated = false;
    for (const side of ['L', 'R']) {
      const i = IK[side];
      const w = a[i + 3];
      if (w <= 0.002) continue;
      if (!updated) { hips.updateMatrix(); TMP_M.copy(hips.matrix).invert(); updated = true; }
      const thigh = this.bones[`thigh${side}`];
      const shin = this.bones[`shin${side}`];
      const foot = this.bones[`foot${side}`];
      // Target from the character's frame into the hips' frame.
      TMP_T.set(this.footX[side], a[i + 1], a[i]).applyMatrix4(TMP_M);
      const dz = TMP_T.z - thigh.position.z;
      const dy = thigh.position.y - TMP_T.y;
      const t = this.legT, s = this.legS;
      // Clamp inside the reachable annulus, or the arc-cosines go NaN and the leg vanishes.
      const L = Math.min(Math.max(Math.hypot(dz, dy), Math.abs(t - s) + 1e-3), (t + s) * 0.9995);
      const aim = Math.atan2(-dz, dy);
      const open = Math.acos(clampCos((t * t + L * L - s * s) / (2 * t * L)));
      const knee = Math.PI - Math.acos(clampCos((t * t + s * s - L * L) / (2 * t * s)));
      const th = aim - open;
      // Blend against whatever the clip layer produced, so a fading overlay walks the legs
      // back to its own angles instead of popping.
      thigh.rotation.x += (th - thigh.rotation.x) * w;
      shin.rotation.x += (knee - shin.rotation.x) * w;
      // Level the sole: cancel the two joints above it and the pelvis pitch, then add the
      // clip's own ankle pitch on top.
      const level = -(th + knee) - hips.rotation.x + a[i + 2];
      foot.rotation.x += (level - foot.rotation.x) * w;
    }
  }

  /**
   * Drive the cape and hair springs from the character's actual motion. The
   * inputs are deliberately in the character's *local* frame, so turning in place
   * throws the hair sideways and running forward throws it back — using world
   * velocity here makes hair that swings the wrong way whenever the player turns.
   */
  updateSecondary(dt) {
    const group = this.rig.group;
    group.getWorldPosition(TMP_V);
    const yaw = group.rotation.y + this.facingYaw;

    // Accumulated upper-body rotation, which is what the hair actually hangs off.
    const tx = this.bones.chest.rotation.x + this.bones.neck.rotation.x + this.bones.head.rotation.x;
    const ty = this.bones.chest.rotation.y + this.bones.neck.rotation.y + this.bones.head.rotation.y;

    if (!this.hasHistory) {
      this.lastWorld.copy(TMP_V);
      this.lastYaw = yaw;
      this.lastTorso.x = tx;
      this.lastTorso.y = ty;
      this.hasHistory = true;
    }
    // World delta → local frame.
    TMP_V2.subVectors(TMP_V, this.lastWorld);
    const inv = dt > 1e-5 ? 1 / dt : 0;
    const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
    const lvx = (TMP_V2.x * cy - TMP_V2.z * sy) * inv;
    const lvz = (TMP_V2.x * sy + TMP_V2.z * cy) * inv;
    const lvy = TMP_V2.y * inv;
    // Smooth: a raw per-frame delta is noisy enough to make the springs buzz.
    this.localVel.set(
      this.localVel.x + (lvx - this.localVel.x) * Math.min(1, dt * 14),
      this.localVel.y + (lvy - this.localVel.y) * Math.min(1, dt * 14),
      this.localVel.z + (lvz - this.localVel.z) * Math.min(1, dt * 14),
    );
    let dYaw = yaw - this.lastYaw;
    while (dYaw > Math.PI) dYaw -= TAU;
    while (dYaw < -Math.PI) dYaw += TAU;
    this.yawRate += (dYaw * inv - this.yawRate) * Math.min(1, dt * 14);
    // Torso rates use a lighter smoothing than root motion: a swing lasts about
    // 150 ms and heavy filtering would flatten the whip out entirely.
    const kT = Math.min(1, dt * 26);
    this.torsoRate.x += ((tx - this.lastTorso.x) * inv - this.torsoRate.x) * kT;
    this.torsoRate.y += ((ty - this.lastTorso.y) * inv - this.torsoRate.y) * kT;
    this.lastWorld.copy(TMP_V);
    this.lastYaw = yaw;
    this.lastTorso.x = tx;
    this.lastTorso.y = ty;

    // Forward motion (local -Z is forward for these characters, which face +Z, so
    // moving forward means +Z here) throws cloth backward; falling throws it up.
    const fwd = this.localVel.z;
    const side = this.localVel.x;
    const rise = this.localVel.y;

    for (const [name, sp] of Object.entries(this.springs)) {
      const drive = SECONDARY_TUNING[name][3];
      // Swing target: back when moving forward, up when falling, and back again
      // when the torso itself pitches forward (a sword swing barely translates the
      // character, so without this term the hair is dead through every attack).
      const swingX = (fwd * 0.085 - rise * 0.055 + this.torsoRate.x * 0.042) * drive;
      // Lateral: sideways motion plus the lag from turning the root *or* the torso.
      const swingZ = (-side * 0.075 - this.yawRate * 0.10 - this.torsoRate.y * 0.052) * drive;
      const b = this.bones[name];
      const r = sp.rest;
      b.rotation.set(r.x + sp.x.step(dt, swingX), r.y, r.z + sp.z.step(dt, swingZ));
    }
  }

  /** Snap the springs to rest — use when teleporting so cloth doesn't whip. */
  resetSecondary() {
    this.hasHistory = false;
    this.localVel.set(0, 0, 0);
    this.yawRate = 0;
    this.torsoRate.x = this.torsoRate.y = 0;
    this.lastTorso.x = this.lastTorso.y = 0;
    for (const sp of Object.values(this.springs)) {
      sp.x.x = sp.x.v = 0;
      sp.z.x = sp.z.v = 0;
    }
  }
}

export { CLIPS, POSE_BONES, ACTION };
