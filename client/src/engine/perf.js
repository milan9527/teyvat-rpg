// Adaptive quality: the thing that decides when the renderer has to give something up.
//
// Why this exists. `quality` used to be fixed at construction (`opts.quality || 'high'`)
// and the only way it ever changed was the settings panel, so a machine that could not
// hold the top tier simply ran badly forever — and "badly" here is not hypothetical:
// under software rendering (llvmpipe) the scene tour measures 2 fps in Mondstadt at
// 2.99 M triangles and 5 fps in the domains. A player on a weak laptop got exactly that
// with no fallback. Everything the tiers control was already wired up (renderer DPR,
// shadows, bloom, SMAA; world scatter density, terrain detail, weather particle counts;
// vfx particle multiplier) — what was missing was anything watching the framerate.
//
// The three things that make this hard, and what each one forces:
//
// 1. A quality change is *expensive*. `World.setQuality` disposes every resident scatter
//    cell so the density change takes effect, then rebuilds them a few per frame. So the
//    frames right after a change are the worst frames of the session, and a naive
//    controller reads its own downgrade as evidence that it should downgrade again. Hence
//    `settle`: samples inside the settling window are dropped, not averaged in.
//
// 2. Frame time is spiky for reasons that have nothing to do with the tier — a shader
//    compile, a zone stream, a GC pause. So the decision runs on the *median* of the
//    renderer's 500 ms buckets over a multi-second window, never on one frame. A single
//    400 ms hitch cannot move a median.
//
// 3. Oscillation is worse than a wrong tier. A controller that steps up into a tier it
//    cannot hold, drops back, steps up again, and so on, produces a full scatter rebuild
//    every few seconds — much worse than just staying low. Two mechanisms stop it: an
//    upgrade needs a far longer and stricter run of good frames than a downgrade needs of
//    bad ones (asymmetric thresholds, with a gap between them that no steady state can be
//    in), and a tier that has failed goes on a cooldown, then after a second failure is
//    never attempted again for the rest of the session. That bounds the total number of
//    changes: each tier can cost at most two round trips, so this cannot churn.
//
// The upgrade threshold deserves its own note, because getting it wrong makes the top tier
// unreachable on perfectly good hardware: with vsync on a 60 Hz display a flawless frame
// measures 16.7 ms, so any "is it fast enough" test below that never passes. UP_MS is
// 19 ms — comfortably above the vsync floor, comfortably below the 40 ms downgrade line.

export const TIERS = ['low', 'medium', 'high', 'ultra'];

const DOWN_MS = 40;          // sustained worse than 25 fps: give something up
const PANIC_MS = 100;        // worse than 10 fps: skip a tier rather than crawl through it
const UP_MS = 19;            // ~53 fps, i.e. hitting a 60 Hz vsync cap with margin
const DOWN_WINDOW = 3.0;     // seconds of evidence needed to drop
const UP_WINDOW = 12.0;      // ...and four times as much to climb
const MIN_DOWN_SAMPLES = 3;  // at 3 fps a 500 ms bucket takes ~600 ms, so 3 ≈ 2 s
const MIN_UP_SAMPLES = 8;
// Sample counts alone do not bound a decision in *time*: at 60 fps the buckets are 500 ms
// apart, so MIN_UP_SAMPLES on its own would let two seconds of good frames stand in for the
// twelve the window claims to require (an early version climbed two tiers by t=8 s). The
// evidence has to span the window as well as fill it.
const DOWN_SPAN = 2.0;
const UP_SPAN = UP_WINDOW * 0.75;
// A drop is only worth keeping if it bought frames. Below this improvement ratio the tier
// was not what was slow (see the `floored` latch).
const HELPED = 0.9;
const SETTLE = 2.5;          // ignore this long after a change (see note 1 above)
const ZONE_SETTLE = 6.0;     // a fresh zone streams its cells in; that is not the tier's fault
const RETRY_AFTER = 60;      // a tier that failed once may be retried after this
const MAX_FAILS = 2;         // ...and after this many failures, never again this session

/**
 * Watches frame times and moves the quality tier. Deliberately pure: it takes numbers and
 * returns a decision, touches no THREE object and no DOM, so its behaviour can be checked
 * without a browser (`node tools/quality-check.mjs`).
 */
export class QualityGovernor {
  /**
   * `ceiling` is the tier the player asked for; the governor never climbs above it, only
   * down from it. That is the whole contract with the settings panel: choosing 极致 is a
   * request for as much as the machine can hold, not a promise to render it.
   */
  constructor({ tier = 'high', ceiling = null, enabled = true, onChange = () => {} } = {}) {
    this.tier = TIERS.includes(tier) ? tier : 'high';
    this.ceiling = ceiling && TIERS.includes(ceiling) ? ceiling : this.tier;
    this.enabled = enabled !== false;
    this.onChange = onChange;
    this.samples = [];         // [t seconds, ms per frame]
    this.fails = new Map();    // tier → how many times it proved too slow
    this.retryAfter = new Map();
    this.changes = 0;
    this.lastReason = '';
    this.floored = false;      // a drop bought nothing: stop stripping the scene
    this._preMed = 0;          // the median that justified the last drop
    this._settleUntil = 0;
    this._t = 0;
  }

  /** Suppress decisions for a while: a zone load, a manual change, our own change. */
  busy(seconds = SETTLE) {
    this._settleUntil = Math.max(this._settleUntil, this._t + seconds);
    // Frames measured before or during a disruption say nothing about the frames after
    // it, and keeping them would let a stale window decide the next move.
    this.samples.length = 0;
  }

  /**
   * The player picked a tier by hand. Their choice becomes the new ceiling.
   *
   * `snap` is what separates the two callers. A click in the settings panel means "give me
   * this now", so it jumps straight there. Loading a save means "this is my ceiling", and
   * jumping to it would undo `guessTier` and hand a software renderer ten seconds at a tier
   * it has no chance of holding — so that caller passes false and lets the climb be earned.
   */
  setCeiling(tier, snap = true) {
    if (!TIERS.includes(tier)) return;
    this.ceiling = tier;
    if (snap || TIERS.indexOf(this.tier) > TIERS.indexOf(tier)) this.tier = tier;
    // A manual pick is also a fresh mandate: if they ask for 极致 again after we dropped
    // them to 标准, honour it and let the machine prove itself again.
    this.fails.clear();
    this.retryAfter.clear();
    this.floored = false;
    this._preMed = 0;
    this.busy();
  }

  setEnabled(v) {
    this.enabled = v !== false;
    if (this.enabled) this.busy();
  }

  /**
   * Feed one frame-time bucket. `nowMs` is `performance.now()`. Returns the new tier if it
   * changed, else null; callers can ignore the return and use `onChange`.
   */
  sample(msFrame, nowMs) {
    const t = (this._t = nowMs / 1000);
    if (!(msFrame > 0)) return null;
    this.samples.push([t, msFrame]);
    while (this.samples.length && t - this.samples[0][0] > UP_WINDOW + 1) this.samples.shift();
    if (!this.enabled || t < this._settleUntil) return null;

    const i = TIERS.indexOf(this.tier);
    const down = this._stats(t - DOWN_WINDOW);
    if (down.n >= MIN_DOWN_SAMPLES && down.span >= DOWN_SPAN && down.med > DOWN_MS && i > 0) {
      // Did the previous drop actually buy anything? If the frame time is where it was
      // before, the tier is not what is slow here — the bottleneck is somewhere the tiers
      // do not reach (a CPU-bound simulation, a browser without hardware acceleration at
      // all) and continuing to strip the scene down would cost every visual in the game
      // and still not reach 25 fps. Latch instead. Only a manual pick clears it, because
      // the player asking again is the one signal that means "try anyway".
      if (this._preMed && down.med > this._preMed * HELPED) {
        this.floored = true;
        this._preMed = 0;
      }
      if (!this.floored) {
        // Two steps at once when it is truly hopeless. Walking high → medium → low costs
        // two full scatter rebuilds and ten seconds of 3 fps to learn what one look at a
        // 100 ms median already said.
        const step = down.med > PANIC_MS ? 2 : 1;
        const next = TIERS[Math.max(0, i - step)];
        // The tier we are leaving has now demonstrably failed on this machine.
        this.fails.set(this.tier, (this.fails.get(this.tier) || 0) + 1);
        this.retryAfter.set(this.tier, t + RETRY_AFTER);
        this._preMed = down.med;
        return this._go(next, `${Math.round(1000 / down.med)} fps，自动降低画质`);
      }
    }

    const up = this._stats(t - UP_WINDOW);
    const next = TIERS[i + 1];
    if (up.n >= MIN_UP_SAMPLES && up.span >= UP_SPAN && next && i < TIERS.indexOf(this.ceiling)
      // Median *and* p90: a scene that averages 55 fps but stutters into the 20s every
      // second is not a scene with headroom, and climbing would make the stutter the norm.
      && up.med < UP_MS && up.p90 < DOWN_MS
      && (this.fails.get(next) || 0) < MAX_FAILS && t >= (this.retryAfter.get(next) ?? 0)) {
      return this._go(next, `帧率稳定，恢复画质`);
    }
    return null;
  }

  _go(tier, reason) {
    if (tier === this.tier) return null;
    const from = this.tier;
    if (TIERS.indexOf(tier) > TIERS.indexOf(from)) {
      // Climbing invalidates both pieces of downward memory. `_preMed` was measured at a
      // tier we have since left, and comparing the next drop against it is how a second
      // attempt at a tier the machine cannot hold got mistaken for "dropping does not
      // help" and latched the governor at that tier permanently. `floored` goes with it:
      // a machine that just demonstrated headroom is not the machine that had none.
      this._preMed = 0;
      this.floored = false;
    }
    this.tier = tier;
    this.changes++;
    this.lastReason = reason;
    this.busy();
    this.onChange(tier, { from, reason });
    return tier;
  }

  /** Median and p90 of the buckets at or after `since`. */
  _stats(since) {
    const v = [];
    for (const [t, ms] of this.samples) if (t >= since) v.push(ms);
    if (!v.length) return { n: 0, med: 0, p90: 0, span: 0 };
    // Before sorting: how much wall time these buckets actually cover.
    const span = this.samples.length
      ? this.samples[this.samples.length - 1][0] - Math.max(since, this.samples[0][0])
      : 0;
    v.sort((a, b) => a - b);
    return {
      n: v.length,
      med: v[Math.floor(v.length / 2)],
      p90: v[Math.min(v.length - 1, Math.floor(v.length * 0.9))],
      span,
    };
  }

  /** For the HUD/debug readout. */
  report() {
    const s = this._stats(this._t - UP_WINDOW);
    return {
      tier: this.tier, ceiling: this.ceiling, enabled: this.enabled,
      changes: this.changes, reason: this.lastReason, floored: this.floored,
      med: +s.med.toFixed(1), samples: s.n,
      settling: this._t < this._settleUntil,
    };
  }
}

/**
 * A first guess at the tier to *start* at, before any frame has been measured.
 *
 * The governor converges on its own, so this is only about the first few seconds — but on
 * a software renderer those seconds cost 2 fps and then a full scatter rebuild when the
 * drop lands, and the boot sequence is the worst possible moment for that. Asking the
 * driver what it is takes microseconds and skips the whole episode.
 *
 * It is a *starting* tier, never a ceiling: the player's saved pick stays the ceiling, so a
 * machine this guess underestimates climbs back out within a few windows. That asymmetry is
 * the whole reason a crude string match is safe here.
 */
export function guessTier(fallback = 'high') {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    // No WebGL2 at all is not something the tiers can fix, but it is a strong hint that
    // nothing here is fast.
    if (!gl) return 'low';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(
      (dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '',
    );
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    // llvmpipe/softpipe are Mesa's CPU rasterisers, SwiftShader is Chrome's; "Google
    // Inc." with no GPU string and the ANGLE software backends land here too. Any of them
    // means every pixel is being coloured by the CPU, which no tier makes fast — but low
    // is 1.0 DPR with no shadows and no bloom, and that is the difference between 2 fps
    // and 7 (measured on this box's llvmpipe across all six zones).
    if (/llvmpipe|softpipe|swiftshader|software|basic render|microsoft basic/i.test(name)) return 'low';
    // Two cores has to run the frame loop, the streaming builder and the compositor.
    if ((navigator.hardwareConcurrency || 8) <= 2) return 'medium';
    return fallback;
  } catch {
    return fallback;
  }
}

export { SETTLE, ZONE_SETTLE, DOWN_MS, UP_MS };
