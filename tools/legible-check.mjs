// Can you read the HUD when the scene behind it is bright?
//
//   DISPLAY=:99 node tools/legible-check.mjs [--out DIR] [--hours 12,23] [--bar 3]
//
// Every piece of HUD text in this game floats directly on the 3D scene: there is no letterbox, no
// opaque bar, and the same 12 px line can land on a noon meadow (luma 150-230), on a night hillside
// (luma 30-60) or on the sky. Whether it can still be read is decided by two things the CSS owns —
// the text colour's alpha and the `text-shadow` — and **nothing in this repo asked**. 49 other
// probes photograph the world; the ones that look at the HUD assert its *text* ("the banner names
// the chapter"), its *rect* ("446x456 at 577,236") or its *own* colour ("card lum 88"), and every
// one of those passes on a build where the line has become invisible against what is behind it.
//
// It is a real defect, not a hypothetical: the 每日委托 banner's second line is
// `rgba(232, 197, 106, 0.8)` at 13 px with **no shadow of its own** (`.banner .t` has one, `.banner`
// itself does not, and `text-shadow` is inherited — so the subtitle inherits nothing). Composited
// over sunlit grass that is a contrast ratio of **1.87:1**, which is below the 3:1 that WCAG calls
// the floor for large text. The screenshot that started this file is
// `/tmp/qe-fix/05-daily-done.png`: the title reads, the line under it is a smudge.
//
// How the measurement works, and why it is not the obvious one:
//
//   * **Three frames, because a glyph's backdrop is its own shadow.** With the loop stopped the same
//     scene is photographed three times: **A** the HUD as the player sees it, **S** with every graded
//     element set to `color: transparent` — which keeps each `text-shadow`, since a shadow is drawn
//     from the glyph's alpha and not from its colour — and **B** with them all `visibility: hidden`.
//     A minus S is then the ink and nothing but the ink, and **S is the backdrop** the ink was laid
//     on: scene plus halo, which is exactly what the eye compares a stroke against. B is kept for the
//     untouched scene luma and for the control that says the line painted at all.
//   * **Locate the glyph by coverage, not by how much it changed.** The version before this one
//     masked "ink" as `|A - B| > threshold`, and over a *bright* background that selects the shadow
//     instead of the letter: 「46」 in salmon over the traveller's white coat measured its own stroke
//     cores at `113,82,75` — the black halo — and then measured the "surround" 2 px outside the halo,
//     i.e. untouched sunlit cloth. Adding a stronger halo made the number score *worse*. Coverage is
//     solved instead, per pixel, from the frame pair that differs by the glyph alone:
//     `A = alpha*coverage*colour + (1 - alpha*coverage)*S`, inverted on the channel where the authored
//     colour is furthest from S. The core is the pixels within 60 % of the strongest ink *this element*
//     laid down, so it is letter and never halo, whichever way round the two are.
//   * **The foreground is the authored colour composited, not the painted average.** The first
//     version of this file averaged the stroke-core pixels of frame A, and it lied about every small
//     line: at 46 px `.banner .t` measured `239,231,211`, exactly its `--paper`, while 13 px
//     `.hud-player` — `rgba(242,234,214,.86)`, the same near-white — measured `177,105,91`, a third
//     of the way to the brown hill behind it. Nothing was wrong with the picture; a mean over
//     antialiased CJK strokes at 12 px *is* mostly partial coverage, so the average slides toward the
//     background and the ratio collapses. 35 of 38 lines "failed" that way. WCAG contrast is defined
//     between the text colour and the background, so that is what is used: `getComputedStyle().color`
//     (its alpha times every ancestor `opacity`) composited over S at the ring — the same backdrop the
//     background side uses. The painted core mean is printed next to it, and where the text is opaque
//     and fully covered somewhere the two are *asserted* to agree: that is what proves the colour this
//     probe read out of the CSS is the colour the frame actually shows.
//   * **The elements are discovered, not listed.** Anything under `[data-hud]` or `#world-overlay`
//     that carries its own text, is visible, and has no opaque ancestor between it and the canvas is
//     a candidate — so a new HUD line is gated the day it is added. An authored list is kept anyway,
//     in the other direction: the six lines below *must* be among the discovered ones, or a refactor
//     that stops discovery from seeing text (a wrapper with a background, a canvas-rendered HUD)
//     would empty this probe and still report GREEN.
//   * **A control pair that has to straddle the bar.** Two lines of the probe's own text are injected
//     into the overlay side by side over the same ground: one `rgba(242,234,214,.5)` with no shadow,
//     one `#fff` with the shadow the rest of the HUD wears. They go through discovery, the hide, and
//     `grade()` like everything else, and the bright hour has to score the first below the bar and the
//     second above it. That is the assertion that would have caught the antialiasing bug above on the
//     first run: a metric that reads every line as illegible reads the *good* control as illegible
//     too. They are excluded from the gate itself — a control is not a subject.
//   * **Two hours, because the failure is two-sided.** Pale text dies on a bright background and
//     dark text dies on a dark one; a single hour can only see one of them. 12:00 is the brightest
//     ground the game has outdoors and 23:00 the darkest, and every element has to clear the bar at
//     both.
//
// Freezing, honestly: the game loop is stopped (`game.stop()`) and every CSS animation is
// **cancelled**, which drops each element to its base style — that is the state the player reads it
// in (a damage number mid-float at full opacity, a banner between its fade-in and its fade-out), and
// it is the only state that can be photographed twice identically. Two teardown timers are then
// neutered so the subjects survive the ~12 s a settled pair costs: the banner's 3.5 s
// `setTimeout(el.remove)` and the toast's. Nothing else about the elements is touched — not their
// classes, not their colours, not their position.
//
// Exit code is the number of failed assertions.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { decodePng, pixelsDiffering } from './lib/png.mjs';
import { mintGuest } from './lib/account.mjs';

const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const APP = process.env.GAME_APP || 'http://127.0.0.1:5173';
const W = 1280, H = 800;
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const OUT = arg('out', '/tmp/legible-check');
const HOURS = arg('hours', '12,23').split(',').map(Number);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0, passes = 0, skips = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); } else {
    fails++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
  return !!ok;
}
function skip(name, why) { skips++; console.log(`  SKIP ${name} — ${why}`); }

// WCAG 2.1 puts large text (>= 18.66 px bold or >= 24 px) at 3:1 and body text at 4.5:1. Game HUD is
// neither: it is 11-15 px, but it is also transient, single-purpose and read at a glance rather than
// paragraph-by-paragraph, and 4.5:1 would mean a HUD of white text in black boxes. So the bar is the
// large-text floor, 3:1 -- borrowed from a standard rather than invented here, which matters because a
// threshold I pick is an opinion and this one has to survive a redesign of the HUD's colours.
//
// It is not a bar the HUD cleared when this file was written: at 2.6 the first run put five product
// lines under it and the worst was 1.87:1. Every floating group now shares one authored halo
// (`--ink-halo`), the banner subtitle has a shadow at all, and 「Lv.n」 is muted in its colour instead
// of with an `opacity` that faded its own halo. The bar was raised to 3 only after those four fixes
// were measured at both hours, and the run that raised it is the calibration: the worst product line
// and its margin are printed by the gate itself, every run. The injected control pair -- a pale
// shadowless line and a white shadowed one, side
// by side on the same ground -- is what proves each run that the bar can still fail and still pass.
const BAR = +arg('bar', '3');
// Ink is anything the element changed by more than this many sRGB bytes on its strongest channel.
// 12 is above llvmpipe's dither (+-3) and FXAA shimmer and below the weakest glyph antialiasing that
// a reader can see.
const INK = 12;
// The stroke core: ink at least this fraction of the element's own strongest change. Antialiased CJK
// at 12 px puts roughly a third of its pixels above 0.6 -- dense enough to seed a ring, and far enough
// from the edges that the ring is not measuring the glyph again.
const CORE = 0.6;
// How far out the "immediately next to it" ring reaches, in pixels. 2 is the shadow's own scale
// (`0 1px 4px` reaches about 3 px) -- wider and the ring is just scene, which is the number the
// shadow exists to hide.
const RING = 2;
// Below this effective alpha a line is *on its way out*, not being offered to be read: `overlay.js`
// fades a world label from 1 to 0 between 45 m and 100 m (`fade = 1 - (dist - 45) / 55`), so an 81 m
// name plate composites at 0.34 and no shadow can make that clear the bar over grass -- nor should it,
// because the plate the player is reading is the one in front of them. The exemption is not free: a
// faded line is dropped from the gate only if *the same key at full alpha, in the same shot*, cleared
// the bar. If the near plate is illegible, nothing is exempt and both go red.
const FADE = 0.6;
// An element has to put at least this many pixels of stroke core on the screen to be worth grading.
// Below it, the reading is one glyph stem's worth of antialiasing and the ratio swings by a whole
// point between runs.
const MIN_CORE = 14;
// How much of the *scene* may still reach a line before "it sits on a panel, the scene behind it is
// not its problem" stops being true. The exemption used to fire on a single `background-color` with
// alpha >= 0.55, which is a door: a 10.5 px 「Lv.n」 chip that had just failed this gate at 2.12:1 was
// given a `rgba(6,8,12,0.55)` backing and *vanished from the graded set* — 28/0, nothing measured. A
// 0.55 scrim over a luma-220 meadow still puts a luma-99 backdrop under the text, which is the number
// the gate exists to look at. So the exemption is now the composite of every background up the chain
// (a `backdrop-filter` or a `background-image` counts as sealed), and it only fires when at most 15 %
// of the scene gets through. The `scrim` control below is a pale line on a 0.5 backing that must come
// back *graded*: put the threshold back at 0.55 and that control goes missing and says so.
// A flag rather than a literal so the door can be re-opened on the command line: `--leak=0.55` is the
// old rule, and it turns the two assertions below red instead of quietly retiring rows.
const SCENE_LEAK = +arg('leak', '0.15');

/** sRGB byte triple -> WCAG relative luminance. */
function relLum(r, g, b) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const ratio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

/**
 * Grade one element from the three-frame set.
 *
 * `A` has the whole HUD, `S` the same frame with the graded elements' text colour transparent (halos
 * intact, glyphs gone) and `B` with them hidden altogether. The rect comes from
 * `getBoundingClientRect`, padded, because a text-shadow and an italic overhang both draw outside
 * the box. `spec` carries what the CSS authored: `color` as an sRGB triple and `alpha` as the colour's
 * own alpha times every `opacity` between the element and the body.
 */
function grade(A, S, B, rect, spec) {
  const { width, height } = A;
  const pad = RING + 4;
  const x0 = Math.max(0, Math.floor(rect.x) - pad), y0 = Math.max(0, Math.floor(rect.y) - pad);
  const x1 = Math.min(width - 1, Math.ceil(rect.x + rect.w) + pad);
  const y1 = Math.min(height - 1, Math.ceil(rect.y + rect.h) + pad);
  if (x1 <= x0 || y1 <= y0) return { why: 'the rect is off the frame' };

  const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
  const a = Math.max(0.05, Math.min(1, spec.alpha));
  // Coverage per pixel, from the one frame pair that differs by the glyph and nothing else. Inverted
  // on the channel where the authored colour is furthest from the backdrop, so a white letter on a
  // black halo and a black letter on white cloth are read the same way.
  const cov = new Float32Array(rw * rh);
  let maxd = 0, ink = 0, illCond = true;
  const seen = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4;
      let dd = 0, best = 0, spread = 0;
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(A.data[i + k] - S.data[i + k]);
        if (d > dd) dd = d;
        const sp = spec.color[k] - S.data[i + k];
        if (Math.abs(sp) > Math.abs(spread)) { spread = sp; best = k; }
      }
      if (dd > maxd) maxd = dd;
      if (dd > INK) ink++;
      // Below 40 bytes of spread the inversion is ill-conditioned -- white text on a sunlit white
      // coat has nowhere to go, which is the *finding*, not a reason to skip. There the ink is
      // located by plain magnitude and the prediction check below leaves the line alone.
      let c;
      if (Math.abs(spread) >= 40) {
        illCond = false;
        c = (A.data[i + best] - S.data[i + best]) / (a * spread);
      } else c = dd / 40;
      if (!(c > 0)) c = 0;
      cov[(y - y0) * rw + (x - x0)] = c;
      if (dd > INK) seen.push(c);
    }
  }
  if (maxd <= INK * 2) return { why: `nothing painted (strongest change ${maxd} bytes)`, ink, maxd };

  // The cut is a rank, not an absolute: hinted CJK at 10 px never reaches full coverage anywhere, and
  // Firefox blends glyph coverage gamma-corrected, so the sRGB inversion above is monotone in coverage
  // but not linear in it. What the mask has to get right is *where the strokes are*, because the ring is
  // dilated from it -- so it takes the strongest ink this element put down (95th centile, capped at
  // full, since a pixel over 1 belongs to an overlapping label and not to this one) and keeps the
  // pixels within 60 % of that.
  seen.sort((x, y) => x - y);
  const p95 = Math.min(1, seen[Math.floor(seen.length * 0.95)] ?? 0);
  const coreCut = Math.max(0.35, CORE * p95);
  const core = new Uint8Array(rw * rh);
  let nCore = 0;
  for (let i = 0; i < core.length; i++) {
    // Inside the element's *own* box, unpadded: a shadow spills outside it but a glyph does not, and
    // the padding is full of other people's ink. A name plate's element aura sits 4 px right of the
    // name and loses its `currentColor` glow in S exactly like a letter does; a damage number lands on
    // top of the loot note beside it. Both scored as this element's stroke until this line.
    const y = Math.floor(i / rw) + y0, x = (i % rw) + x0;
    if (x < rect.x - 1 || x > rect.x + rect.w + 1 || y < rect.y - 1 || y > rect.y + rect.h + 1) continue;
    if (cov[i] >= coreCut && cov[i] <= 1.2) { core[i] = 1; nCore++; }
  }
  if (nCore < MIN_CORE) return { why: `only ${nCore} px of stroke core`, ink, maxd, nCore, cov: +p95.toFixed(2) };

  // The ring: within RING px of a core pixel, and not core itself. Averaged in S, so it is the halo
  // the shadow painted -- which is the whole point -- with none of the glyph's own antialiasing.
  const ring = new Uint8Array(rw * rh);
  let nRing = 0;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (!core[y * rw + x]) continue;
      for (let dy = -RING; dy <= RING; dy++) {
        for (let dx = -RING; dx <= RING; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= rh || nx < 0 || nx >= rw) continue;
          const j = ny * rw + nx;
          if (core[j] || ring[j]) continue;
          ring[j] = 1; nRing++;
        }
      }
    }
  }
  const mean = (img, m) => {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        if (!m[y * rw + x]) continue;
        const i = ((y + y0) * width + (x + x0)) * 4;
        sr += img.data[i]; sg += img.data[i + 1]; sb += img.data[i + 2]; n++;
      }
    }
    return n ? [sr / n, sg / n, sb / n] : null;
  };
  // The densest ink, for the prediction check: the mean over the whole core is a mean over partial
  // coverage and sits well short of the authored colour by construction, so the check uses the top of
  // the coverage distribution instead.
  const top = new Uint8Array(rw * rh);
  let nTop = 0, covTop = 0;
  {
    const want = Math.max(8, Math.round(nCore * 0.15));
    const vals = [];
    for (let i = 0; i < cov.length; i++) if (core[i]) vals.push(cov[i]);
    vals.sort((x, y) => y - x);
    const cut = vals[Math.min(vals.length - 1, want - 1)];
    for (let i = 0; i < cov.length; i++) if (core[i] && cov[i] >= cut) { top[i] = 1; nTop++; covTop += cov[i]; }
    covTop = nTop ? Math.min(1, covTop / nTop) : 0;
  }
  const paint = mean(A, core);
  const paintTop = mean(A, top);
  const halo = mean(S, ring);
  const sceneB = mean(B, ring);
  if (!paint || !halo || !paintTop) return { why: 'no pixels to average', ink, maxd, nCore };
  // The foreground: the authored colour laid over the backdrop at its effective alpha. Opaque text
  // gives back its own colour; `rgba(...,.5)` gives the half-blend the player actually sees, over the
  // *shadowed* backdrop, which is the same one the background side is measured on.
  const fg = spec.color.map((c, i) => a * c + (1 - a) * halo[i]);
  const lf = relLum(...fg), ln = relLum(...halo);
  // What the densest ink should read *given how covered it measured*, which is not the same thing as
  // the authored colour: at 15 px the peak of a CJK stroke on this box lands around 0.9, so holding
  // `paintTop` to `fg` scored 「12:00」 at pull 0.73 for being 15 px instead of 46. The seam this is
  // for is a colour that is not the CSS colour — a `filter`, a blend mode, a colour set on a child
  // the walk never saw — and that survives, because coverage is inverted on one channel while the
  // comparison is over relative luminance, i.e. all three.
  const pred = spec.color.map((c, i) => covTop * a * c + (1 - covTop * a) * halo[i]);
  const lp = relLum(...pred);
  return {
    ink, maxd, nCore, nRing, nTop, illCond, alpha: +a.toFixed(2), cov: +p95.toFixed(2),
    covTop: +covTop.toFixed(2),
    // How far the densest ink actually travelled from the backdrop, as a fraction of how far the
    // prediction above says it should have. 1.0 is a perfect match, and a line whose CSS colour is not
    // the colour on screen lands near 0 or on the wrong side of it. Asserted below.
    pull: Math.abs(lp - ln) < 0.04 ? null : +((relLum(...paintTop) - ln) / (lp - ln)).toFixed(2),
    // The size of the prediction's own denominator. `pull` divides by this, so a line whose densest ink
    // barely leaves the halo (thin, faded, or nearly the same luminance as what is behind it) amplifies
    // a byte of capture noise into a large pull. This is what the assertion gates on, instead of raw
    // coverage: it is the quantity that decides whether the ratio is measurable at all.
    travel: +(lp - ln).toFixed(3),
    fg: fg.map(Math.round), pred: pred.map(Math.round), paint: paintTop.map(Math.round),
    near: halo.map(Math.round), scene: sceneB ? sceneB.map(Math.round) : null,
    // The luma of the untouched scene under the ring: what the line is fighting, in the units the
    // rest of the repo's gates print.
    sceneLum: sceneB ? +(0.2126 * sceneB[0] + 0.7152 * sceneB[1] + 0.0722 * sceneB[2]).toFixed(1) : null,
    ratio: +ratio(lf, ln).toFixed(2),
    polarity: lf >= ln ? 'light' : 'dark',
  };
}

/* ------------------------------------------------------------------ browser -- */

const acct = await mintGuest(API);
const b = await puppeteer.launch({
  browser: 'firefox',
  headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
    'media.autoplay.default': 0,
  },
  defaultViewport: { width: W, height: H },
});
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
p.on('console', (m) => {
  const t = m.text().slice(0, 200);
  if (/\[vite\].*(hot updated|hmr update|page reload)/i.test(t)) { errs.push('HMR: ' + t); console.log('[HMR]', t); }
  if (m.type() === 'error') errs.push(t);
});

// How many pixels *of the region this probe reads* may differ between two captures of the same state.
// Frame-wide stillness is not available and is not needed: at 23:00 some 3000 px of drifting fireflies
// never settle out in the open grass, and none of them are within 6 px of a HUD glyph. So the settle
// test looks only at the padded rects that get graded, and the frame-wide residual is printed beside it
// for the record.
//
// Inside the mask the tolerance is a *fraction* of it rather than a flat count, because what actually
// turns up is not a moving widget: the worst pair measured 14 px of peak Δ10 scattered over a 509x571
// region of the HUD (with 11467 px frame-wide, i.e. the whole picture dithering by a byte or two), and a
// hand-picked 8 px failed a frame that is identical for every purpose this probe has -- every reading
// here is a mean over at least 14 core pixels and a ring of dozens. 0.05 % of the graded region is
// 64 px at this window size; a real animation inside a name plate is thousands.
const SETTLE_FRAC = 0.0005;
// And however few pixels move, none of them may move far: a byte or two is dither, Δ40 in three
// pixels is a glyph appearing.
const SETTLE_PEAK = 24;

/**
 * One accepted frame: capture until *some two* captures agree, and keep that one.
 *
 * Any two, not just consecutive two: one capture in twenty comes back wrong on this box — the
 * screenshot lands between the clear and the present and the frame is a near-uniform wash, 96 % of the
 * pixels off. Chaining only neighbours lets one bad capture spoil the pair on each side of it and burn
 * the whole budget, which is what a 23:00 shot did (`residual 984879 px`). Comparing against every
 * capture so far costs a diff or two and cannot be fooled the same way: two frames that agree are two
 * frames of the same state, whenever they were taken.
 */
async function shoot(name, mask) {
  let nMask = 0;
  if (mask) for (let q = 0; q < mask.length; q++) if (mask[q]) nMask++;
  const tol = Math.max(8, Math.round((nMask || W * H) * SETTLE_FRAC));
  const diff = (a, b) => {
    let n = 0, peak = 0;
    for (let q = 0, i = 0; q < W * H; q++, i += 4) {
      if (mask && !mask[q]) continue;
      const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]));
      if (d > 3) { n++; if (d > peak) peak = d; }
    }
    return { n, peak };
  };
  // Where the residual is, when there is one: a count alone cannot tell one twitching widget from
  // dither spread over the whole HUD, and that is the difference between excluding a rect and
  // loosening the tolerance for everybody.
  const where = (a, b) => {
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, peak = 0, n = 0;
    for (let q = 0, i = 0; q < W * H; q++, i += 4) {
      if (mask && !mask[q]) continue;
      const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]));
      if (d <= 3) continue;
      const x = q % W, y = (q / W) | 0;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      peak = Math.max(peak, d); n++;
    }
    return n ? `${n} px in ${x0},${y0}..${x1},${y1} peak Δ${peak}` : 'nothing';
  };
  const shots = [];
  for (let i = 0; i < 10; i++) {
    await p.evaluate(() => { for (let k = 0; k < 3; k++) window.game.r.render(0.016); });
    await sleep(420);
    const buf = await p.screenshot();
    const img = decodePng(buf);
    for (const q of shots) {
      const d = diff(q.img, img);
      if (d.n <= tol && d.peak <= SETTLE_PEAK) {
        fs.writeFileSync(`${OUT}/${name}.png`, buf);
        return { img, settled: true, tries: i + 1, resid: d.n, peak: d.peak, tol,
          whole: pixelsDiffering(q.img, img, 3) };
      }
    }
    shots.push({ img, buf });
  }
  // Nothing agreed: hand back the closest pair there was, and let the assertion say so.
  let best = { resid: Infinity, peak: -1, shot: shots[shots.length - 1], whole: -1, at: '' };
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) {
      const d = diff(shots[i].img, shots[j].img);
      if (d.n < best.resid) {
        best = { resid: d.n, peak: d.peak, shot: shots[j], tol,
          whole: pixelsDiffering(shots[i].img, shots[j].img, 3),
          at: where(shots[i].img, shots[j].img) };
      }
    }
  }
  fs.writeFileSync(`${OUT}/${name}.png`, best.shot.buf);
  console.log(`  (${name} never settled: ${best.at}, tolerance ${tol} px)`);
  return { img: best.shot.img, settled: false, tries: shots.length, resid: best.resid,
    peak: best.peak, tol, whole: best.whole };
}

try {
  await p.goto(APP, { waitUntil: 'domcontentloaded' });
  await p.evaluate((t) => localStorage.setItem('teyvat.token', t), acct.token);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await sleep(4000);
  // 单机 first, and it is not optional: the name plate and the damage numbers are staged through
  // `socket.inst`, the local simulation, which only exists in solo mode. Booting straight into
  // 「继续」 lands on the gateway socket and `inst` is undefined.
  await (await p.$('[data-act="solo"]'))?.click();
  await sleep(500);
  await (await p.$('[data-act="resume"]') || await p.$('[data-act="guest"]')).click();
  let up = false;
  for (let i = 0; i < 90; i++) {
    if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) { up = true; break; }
    await sleep(1000);
  }
  if (!up) {
    console.log('window.game never started running — check ./tools/daemon.sh status');
    await b.close();
    process.exit(1);
  }
  await sleep(3500);

  console.log('--- the HUD this probe grades');
  await p.evaluate(() => { window.game.setAutoQuality(false); window.game.setQuality('high'); });
  await sleep(2500);

  // Everything that has to be on screen, put there through the product's own calls: the banner and
  // the toasts through `game.banner`/`game.toast` (the same methods the quest, the zone change and
  // the reward path use), the name plate by spawning an enemy in the local sim, the damage number
  // and the reaction word through `overlay.damage` with the spec the sim sends. A HUD element that
  // is never on screen cannot be graded, and a probe that grades three lines out of twenty is the
  // failure mode this list exists to avoid.
  const staged = await p.evaluate(() => {
    const g = window.game;
    const a = g.me.ry;
    const ex = g.me.x + Math.sin(a) * 6, ez = g.me.z + Math.cos(a) * 6;
    const e = g.socket.inst.spawnEnemy('slimeWater', 12, ex, ez);
    // The chat log's own sink: `hud` listens for the game's `chat` event, and the game emits exactly
    // this shape when a player joins a zone or a teammate goes down.
    g.emit('chat', { channel: 'sys', body: '前面那只史莱姆归我了' });
    g.emit('chat', { channel: 'world', nickname: '旅行者', body: '风起地集合' });
    return { enemy: e ? e.id : null, ex, ez, ey: g.world.heightAt(ex, ez) };
  });
  check('the scene has an enemy in it to hang a name plate on', !!staged.enemy, staged.enemy || 'no spawn');
  await sleep(2500);

  const rows = [];
  const panelRows = [];
  for (const hour of HOURS) {
    await p.evaluate((h) => { window.game.setWorldTime(h, 0); }, hour);
    await sleep(2200);

    // Stage the transient lines, then freeze. Order matters: the banner and the numbers are emitted
    // *before* the loop stops, so their positions come from the product, and the animations are
    // cancelled *after*, so nothing is mid-fade.
    const stage = await p.evaluate((eid) => {
      const g = window.game;
      g.banner('委托完成', '每日委托·讨伐');
      g.toast('+20 原石', 'gold');
      const en = eid ? g.actors.enemyById(eid) : null;
      const at = en || g.me;
      const y = (at.y ?? 0) + 1.7;
      g.overlay.damage({ x: at.x, y, z: at.z, amount: 1274, crit: true, element: 'fire' });
      g.overlay.damage({ x: at.x + 0.9, y: y + 0.4, z: at.z, amount: 806, reaction: 'vaporize' });
      g.overlay.note(at.x - 0.9, y + 0.2, at.z, '拾取 ×2', 'loot');

      // The control pair: two lines of the probe's own text, same size, same ground, one deliberately
      // below the bar and one deliberately above it. They are discovered and graded by the same code
      // as the HUD, so if the metric ever reads the whole HUD as illegible again, the *good* one goes
      // red and says so. Placed left of centre over open ground, clear of the character and the panels.
      const ov = document.getElementById('world-overlay');
      const mk = (id, top, css, text) => {
        const el = document.createElement('div');
        el.dataset.ctl = id;
        el.style.cssText = 'position:absolute;left:20%;font-size:15px;font-weight:600;'
          + `letter-spacing:.08em;pointer-events:none;top:${top};` + css;
        el.textContent = text;
        ov.appendChild(el);
      };
      mk('bad', '56%', 'color:rgba(242,234,214,0.5)', '对照 · 淡且无描边');
      mk('good', '62%', 'color:#fff;text-shadow:0 1px 4px rgba(0,0,0,0.95),0 0 9px rgba(0,0,0,0.85)',
        '对照 · 白且有描边');
      // The third control is about the *discovery*, not the metric: a line on a half-transparent scrim
      // is still a line over the scene, so it has to come back graded. This is what stops the panel
      // exemption from being a way to make a failing row disappear (see SCENE_LEAK).
      mk('scrim', '68%', 'color:rgba(242,234,214,0.6);background:rgba(6,8,12,0.5);padding:1px 4px',
        '对照 · 半透底板');
      return { plate: !!en };
    }, staged.enemy);
    await sleep(700);

    const frozen = await p.evaluate(() => {
      const g = window.game;
      g.stop();
      // Base style, not a keyframe: cancelling drops each element to the CSS it rests at, which is
      // the state the player reads (full opacity, no blur, no scale) and the only one that can be
      // captured twice identically. `cancel` also means no `animationend`, so the pooled damage
      // numbers are not swept away between the two shots.
      const anims = document.getAnimations();
      for (const a of anims) { try { a.cancel(); } catch { /* finished already */ } }
      // The two teardown timers that would fire during a settled pair (~12 s). Local, reversible,
      // and the only thing about these elements the probe touches.
      let neutered = 0;
      for (const el of document.querySelectorAll('.banner, .toast')) { el.remove = () => {}; neutered++; }
      return { anims: anims.length, neutered, running: g._running };
    });
    check(`${hour}:00 the loop is stopped, so the pair differs only by the HUD`,
      frozen.running === false, `${frozen.anims} animations cancelled, ${frozen.neutered} teardowns neutered`);

    // Discovery. A candidate carries its own text, is visible, and has no opaque ancestor between it
    // and the canvas -- `background-color` alpha >= 0.55 or a `backdrop-filter` means it sits on a
    // panel and the scene behind it is not its problem.
    const found = await p.evaluate((LEAK) => {
      const roots = [...document.querySelectorAll('[data-hud]'), document.getElementById('world-overlay')]
        .filter(Boolean);
      const rgba = (c) => {
        const m = /rgba?\(([^)]+)\)/.exec(c || '');
        if (!m) return null;
        const q = m[1].split(/[,/]/).map((s) => parseFloat(s));
        return [q[0] || 0, q[1] || 0, q[2] || 0, q.length > 3 && isFinite(q[3]) ? q[3] : 1];
      };
      const alpha = (c) => (rgba(c) ? rgba(c)[3] : 0);
      // How much of the scene still reaches this element's glyphs: (1 - a) multiplied over every
      // background between it and the body. Two 0.5 scrims leak 0.25, one 0.9 panel leaks 0.1.
      const sceneLeak = (el) => {
        let leak = 1;
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.backdropFilter && cs.backdropFilter !== 'none') return 0;
          if (cs.backgroundImage && cs.backgroundImage !== 'none') return 0;
          leak *= 1 - Math.max(0, Math.min(1, alpha(cs.backgroundColor)));
        }
        return leak;
      };
      const out = [];
      // The nodes themselves, so the hidden frame hides *exactly* what was graded. Matching the walk
      // twice by predicate is how a probe ends up measuring one element and hiding another.
      window.__legibleEls = [];
      let skippedTiny = 0;
      const panels = [];
      for (const root of roots) {
        for (const el of root.querySelectorAll('*')) {
          const own = [...el.childNodes]
            .filter((n) => n.nodeType === 3 && n.textContent.trim())
            .map((n) => n.textContent.trim()).join(' ');
          if (!own) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.05) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 6 || r.height < 6 || r.right <= 0 || r.bottom <= 0
            || r.left >= innerWidth || r.top >= innerHeight) { skippedTiny++; continue; }
          if (parseFloat(cs.fontSize) < 9) { skippedTiny++; continue; }
          // A stable name: the class chain plus the data-f the HUD indexes it by.
          const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
          const parent = (el.parentElement?.className || '').toString().trim().split(/\s+/)[0] || '';
          const key = `${parent ? parent + ' > ' : ''}${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`
            + (el.dataset.f ? `[${el.dataset.f}]` : '');
          const leak = sceneLeak(el);
          if (leak <= LEAK) { panels.push({ key, leak: +leak.toFixed(3), ctl: el.dataset.ctl || '' }); continue; }
          // The authored foreground: the resolved colour, and its alpha folded together with every
          // `opacity` up the chain (`.chatlog .ln .ch` is 0.8 on top of its own colour, and the whole
          // world overlay can be dimmed by one).
          const col = rgba(cs.color) || [242, 234, 214, 1];
          let op = 1;
          for (let n = el; n && n !== document.body; n = n.parentElement) {
            const o = parseFloat(getComputedStyle(n).opacity);
            if (isFinite(o)) op *= o;
          }
          window.__legibleEls.push(el);
          out.push({
            key, text: own.slice(0, 24), font: +parseFloat(cs.fontSize).toFixed(1),
            weight: cs.fontWeight, shadow: cs.textShadow === 'none' ? '' : cs.textShadow,
            color: [col[0], col[1], col[2]], alpha: col[3] * op, ctl: el.dataset.ctl || '',
            leak: +leak.toFixed(3),
            rect: { x: r.left, y: r.top, w: r.width, h: r.height },
          });
        }
      }
      window.__legible = out;
      return { out, panels, skippedTiny };
    }, SCENE_LEAK);
    console.log(`\n  ${hour}:00 — ${found.out.length} floating text elements`
      + ` (${found.panels.length} sit on a panel, ${found.skippedTiny} too small or off-frame)`);
    if (found.panels.length) {
      console.log('    panel-exempt: ' + found.panels.map((q) => `${q.key}(leak ${q.leak})`).join(' '));
    }
    for (const q of found.panels) panelRows.push({ hour, ...q });
    check(`${hour}:00 the discovery found a HUD to grade`, found.out.length >= 8,
      `${found.out.length} elements`);

    // The region the three frames have to agree on: every graded rect, padded exactly as `grade` pads
    // it. Everything outside is scenery this probe never reads.
    const roi = new Uint8Array(W * H);
    let nRoi = 0;
    for (const el of found.out) {
      const pad = RING + 4;
      for (let y = Math.max(0, Math.floor(el.rect.y) - pad); y <= Math.min(H - 1, Math.ceil(el.rect.y + el.rect.h) + pad); y++) {
        for (let x = Math.max(0, Math.floor(el.rect.x) - pad); x <= Math.min(W - 1, Math.ceil(el.rect.x + el.rect.w) + pad); x++) {
          if (!roi[y * W + x]) { roi[y * W + x] = 1; nRoi++; }
        }
      }
    }

    const a = await shoot(`h${hour}-hud`, roi);
    // Glyphs off, halos on. `color: transparent` leaves every `text-shadow` exactly where it was --
    // a shadow is painted from the glyph's alpha, not its colour -- so this frame is the backdrop the
    // ink was laid on. (A `text-shadow` written in `currentColor` would vanish here and the backdrop
    // would come out too clean; none of the HUD's shadows are, they are all explicit rgba blacks.)
    await p.evaluate(() => { for (const el of window.__legibleEls) el.style.color = 'transparent'; });
    const s = await shoot(`h${hour}-glyphless`, roi);
    await p.evaluate(() => { for (const el of window.__legibleEls) el.style.color = ''; });
    const hid = await p.evaluate(() => {
      for (const el of window.__legibleEls) el.style.visibility = 'hidden';
      return window.__legibleEls.length;
    });
    const c = await shoot(`h${hour}-scene`, roi);
    await p.evaluate(() => { for (const el of window.__legibleEls) el.style.visibility = ''; });
    check(`${hour}:00 all three captures settled over the rects they are read in`,
      a.settled && s.settled && c.settled,
      `${a.tries} + ${s.tries} + ${c.tries} captures, residual ${a.resid} / ${s.resid} / ${c.resid} px`
      + ` (peak Δ${a.peak} / ${s.peak} / ${c.peak}) of ${nRoi} graded, tolerance ${a.tol} px`
      + ` (frame-wide ${a.whole} / ${s.whole} / ${c.whole} of ${W * H})`);
    check(`${hour}:00 the hidden frame hides exactly what was graded`, hid === found.out.length,
      `${hid} hidden, ${found.out.length} graded`);
    // The two frames the metric leans on have to be *different pictures*, in the right order: taking
    // the colour away must remove ink (or every coverage is zero), and hiding the elements must then
    // remove more (or the halos were never in S and the backdrop is just the scene).
    const dAS = pixelsDiffering(a.img, s.img, 6), dSB = pixelsDiffering(s.img, c.img, 6);
    check(`${hour}:00 the glyphless frame dropped the ink and kept the halos`,
      dAS > 600 && dSB > 300, `A→S ${dAS} px changed, S→B ${dSB} px`);

    for (const el of found.out) {
      const g = grade(a.img, s.img, c.img, el.rect, { color: el.color, alpha: el.alpha });
      // Does anything else that got hidden overlap this box? Then the ink inside it may not all be
      // this element's, and the prediction check below leaves it alone. The ratio still stands: the
      // halo it is measured against is a real part of the picture whoever painted it.
      const crowded = found.out.some((o) => o !== el && o.rect.x < el.rect.x + el.rect.w
        && o.rect.x + o.rect.w > el.rect.x && o.rect.y < el.rect.y + el.rect.h
        && o.rect.y + o.rect.h > el.rect.y);
      rows.push({ hour, crowded, ...el, ...g });
    }
    const wide = Math.max(...found.out.map((e) => (e.ctl ? 8 : 0) + e.key.length), 10);
    for (const r of rows.filter((r) => r.hour === hour)) {
      const head = `    ${((r.ctl ? `[ctl:${r.ctl}] ` : '') + r.key).padEnd(wide)} ${String(r.font).padStart(5)}px`;
      if (r.why) { console.log(`${head}  —  ${r.why}   「${r.text}」`); continue; }
      console.log(`${head}  ${String(r.ratio).padStart(6)}:1  ink ${String(r.nCore).padStart(5)} px`
        + `  fg ${r.fg.join(',')}@${r.alpha}  ink ${r.paint.join(',')} (cov ${r.cov}/${r.covTop}, pull ${r.pull})`
        + `  halo ${r.near.join(',')}  scene luma ${r.sceneLum}`
        + `  ${r.shadow ? 'shadow' : 'NO SHADOW'}   「${r.text}」`);
    }
    console.log(`  (shots ${OUT}/h${hour}-hud.png, h${hour}-scene.png)`);

    // Undo the freeze before the next hour: the neutered teardowns are given back their own
    // `remove`, the transient subjects are cleared (a banner whose `remove` is a no-op would
    // otherwise still be on screen when the next hour emits its own, and the walk would grade two),
    // and the loop is restarted, because `setWorldTime` only reaches the sky through a frame.
    await p.evaluate(() => {
      for (const el of document.querySelectorAll('.banner, .toast, .dmg, [data-ctl]')) {
        delete el.remove; el.remove();
      }
      window.game.start();
    });
    await sleep(1200);
  }

  /* --------------------------------------------------------------- the gate -- */
  console.log('\n--- is every floating line readable at both hours?');

  // The other direction of the discovery: these are the lines a player reads most, one per family
  // (a banner, a tracker, a world label, a floating number, the clock, the chat log). If a refactor
  // hides them from the walk above, the probe would grade whatever is left and still say GREEN.
  const MUST = [
    ['a banner subtitle', (r) => /banner > div\.s/.test(r.key)],
    ['the banner title', (r) => /banner > div\.t/.test(r.key)],
    ['the quest tracker objective', (r) => /tracker/.test(r.key)],
    ['an enemy name plate', (r) => /wlabel|\bnm\b|who/.test(r.key)],
    ['a floating damage number', (r) => /dmg/.test(r.key)],
    ['the world clock', (r) => /worldclock|clock/.test(r.key)],
    ['a chat line', (r) => /chatlog|\.ln/.test(r.key)],
  ];
  for (const [name, pred] of MUST) {
    const hit = rows.filter((r) => !r.ctl && pred(r));
    check(`the walk found ${name}`, hit.length > 0,
      hit.length ? hit.map((r) => `${r.hour}:00 ${r.key}`).join(', ') : 'no element matched');
  }

  const graded = rows.filter((r) => !r.why);
  check('most of what was discovered could be graded', graded.length >= rows.length * 0.6,
    `${graded.length} graded of ${rows.length} discovered`);

  // The reading is half CSS (`color`) and half picture (the halo under the ring), and this is the seam:
  // where a line is opaque and its strokes reached full coverage, the colour read out of the CSS has
  // to be the colour those pixels are. If a rule this probe never looked at repaints the text -- a
  // `filter`, a `mix-blend-mode`, a canvas HUD, a colour set on a child it did not walk -- the numbers
  // above would still look plausible and this goes red. Luminance units, 0..1.
  // Three things have to hold before a line can be held to its authored colour, and each of them was
  // learned from a row that failed for a reason that was not the product's:
  //   `covTop` -- the coverage of the very pixels being compared, not the element's p95. 「12:00」 at
  //     15 px peaks at 0.92 and reads pull 0.84; 「风与牧歌之地」 peaks at 0.7 and reads 0.53, because
  //     Firefox blends glyph coverage in linear light while this arithmetic is in sRGB bytes, and that
  //     approximation is only harmless where coverage is nearly full.
  //   `alpha` -- an *opaque* line. A translucent one is composited as a group, so its `text-shadow` is
  //     faded with it and the true delta is `cov * (colour - shadow)` rather than `cov * (colour -
  //     backdrop)`: the two faded name plates read pull 1.29 and 1.44 for being 0.39 and 0.48 opaque.
  //     Their ratio still stands -- that is measured against the faded halo they really have.
  //   `travel` -- `pull` divides by the predicted distance from the halo, so a line whose densest ink
  //     sits a hair from its backdrop would be judged by amplified capture noise.
  const solid = graded.filter((r) => !r.illCond && !r.crowded && r.nCore >= 40
    && r.pull !== null && r.covTop >= 0.9 && r.alpha >= 0.9 && Math.abs(r.travel) >= 0.1);
  if (solid.length < 4) skip('the colour read from the CSS is the colour on screen', `only ${solid.length} lines travelled far enough to measure`);
  else {
    const off = solid.filter((r) => r.pull < 0.75 || r.pull > 1.3).sort((x, y) => x.pull - y.pull);
    check('the colour read from the CSS is the colour on screen', off.length === 0,
      off.length
        ? off.slice(0, 4).map((r) => `${r.hour}:00 ${r.key} predicted ${r.pred.join(',')} at cov ${r.covTop} but painted ${r.paint.join(',')} (pull ${r.pull})`).join(' | ')
        : `${solid.length} lines, pull ${Math.min(...solid.map((r) => r.pull)).toFixed(2)}-${Math.max(...solid.map((r) => r.pull)).toFixed(2)}`);
  }

  // The control pair first, because it is what licenses reading the rest of the numbers. Both lines
  // are the same size over the same ground at the same hour, so the only difference between them is the
  // alpha and the shadow -- and the bright hour is the one that can tell them apart (at 23:00 half-alpha
  // paper over a luma-40 hillside is perfectly readable, which is the honest answer, not a failure).
  const bright = HOURS[0];
  const ctlBad = graded.find((r) => r.hour === bright && r.ctl === 'bad');
  const ctlGood = graded.find((r) => r.hour === bright && r.ctl === 'good');
  if (!ctlBad || !ctlGood) {
    check(`the control pair was graded at ${bright}:00`, false,
      `bad ${ctlBad ? 'ok' : 'missing'}, good ${ctlGood ? 'ok' : 'missing'}`);
  } else {
    check(`the metric can fail: a pale shadowless line scores under ${BAR}:1 at ${bright}:00`,
      ctlBad.ratio < BAR, `control 「${ctlBad.text}」 ${ctlBad.ratio}:1 over luma ${ctlBad.sceneLum}`);
    check(`the metric can pass: the same line white with a shadow clears it`,
      ctlGood.ratio >= BAR && ctlGood.ratio > ctlBad.ratio * 1.4,
      `control 「${ctlGood.text}」 ${ctlGood.ratio}:1 over luma ${ctlGood.sceneLum}`
      + ` (${(ctlGood.ratio / ctlBad.ratio).toFixed(1)}x the pale one)`);
  }

  // The exemption's own control. A pale line on a 0.5 scrim is still a line over the world, so it must
  // be *in the graded set*: this is the assertion that a failing row cannot be retired by giving it a
  // backing, which is exactly what a 0.55 chip did to 「Lv.n」 the day this was written.
  const ctlScrim = graded.find((r) => r.hour === bright && r.ctl === 'scrim');
  const scrimExempt = panelRows.filter((q) => q.ctl === 'scrim');
  check('the panel exemption did not swallow a line on a half-transparent scrim',
    !!ctlScrim && !scrimExempt.length,
    ctlScrim
      ? `control 「${ctlScrim.text}」 graded at ${ctlScrim.ratio}:1, scene leak ${ctlScrim.leak}`
      : `the scrim control was ${scrimExempt.length ? `panel-exempt (leak ${scrimExempt[0].leak})` : 'not graded'}`);
  if (!panelRows.length) skip('every panel-exempt line really is behind a sealed backing', 'the exemption never fired');
  else {
    const worstLeak = Math.max(...panelRows.map((q) => q.leak));
    check('every panel-exempt line really is behind a sealed backing',
      worstLeak <= SCENE_LEAK && panelRows.every((q) => !q.ctl),
      `${panelRows.length} exempt readings, worst leak ${worstLeak} (bar ${SCENE_LEAK})`
      + `: ${[...new Set(panelRows.map((q) => q.key))].slice(0, 6).join(' ')}`);
  }

  let fadedSeen = 0;
  for (const hour of HOURS) {
    const mine = graded.filter((r) => r.hour === hour && !r.ctl);
    if (!mine.length) { skip(`${hour}:00 every floating line clears ${BAR}:1`, 'nothing graded'); continue; }
    // The distance fade, and the price of exempting it (see FADE above).
    const earned = (r) => mine.some((q) => q.key === r.key && q.alpha >= 0.7 && q.ratio >= BAR);
    const faded = mine.filter((r) => r.alpha < FADE && r.ratio < BAR && earned(r));
    const judged = mine.filter((r) => !faded.includes(r));
    const worst = judged.reduce((m, r) => (r.ratio < m.ratio ? r : m));
    const bad = judged.filter((r) => r.ratio < BAR);
    check(`${hour}:00 every floating line clears ${BAR}:1 against what is behind it`,
      bad.length === 0,
      (bad.length
        ? bad.map((r) => `${r.key} ${r.ratio}:1 (scene luma ${r.sceneLum}${r.shadow ? '' : ', no shadow'})`).join(' | ')
        : `worst is ${worst.key} at ${worst.ratio}:1 over luma ${worst.sceneLum}, ${judged.length} lines`)
      + (faded.length ? ` [${faded.length} fading out past 45 m, exempt because the near one passes]` : ''));
    fadedSeen += faded.length;
  }

  // The exemption is only defensible if it is *narrow*, so say out loud how many lines used it and
  // make sure it stayed the minority. A run where it never fired is not a failure (the streamed camps
  // may all be inside 45 m), but it means the branch above went untested, so it says so.
  const gradedSubj = graded.filter((r) => !r.ctl).length;
  if (!fadedSeen) skip('the distance-fade exemption stayed narrow', 'no label was past 45 m in either shot');
  else {
    check('the distance-fade exemption stayed narrow', fadedSeen <= Math.max(2, gradedSubj * 0.2),
      `${fadedSeen} of ${gradedSubj} graded lines were fading out past 45 m`);
  }

  // A ratio is only evidence if the two hours really were different scenes: a night shot that came
  // out as bright as noon means `setWorldTime` did nothing and the "both hours" claim is one hour
  // twice. Compared over the lines that both hours graded, so it is the same rects either way.
  if (HOURS.length > 1) {
    const [h1, h2] = HOURS;
    const subj = graded.filter((r) => !r.ctl);
    const keys = new Set(subj.filter((r) => r.hour === h1).map((r) => r.key));
    const pairs = subj.filter((r) => r.hour === h2 && keys.has(r.key)).map((r) => ({
      key: r.key, dark: r.sceneLum,
      bright: subj.find((q) => q.hour === h1 && q.key === r.key).sceneLum,
    })).filter((q) => q.dark !== null && q.bright !== null);
    const meanOf = (f) => pairs.reduce((s, q) => s + f(q), 0) / Math.max(1, pairs.length);
    check(`${h2}:00 really is a darker scene than ${h1}:00, so the bar was cleared twice`,
      pairs.length >= 4 && meanOf((q) => q.bright) > meanOf((q) => q.dark) + 20,
      `${pairs.length} shared lines: mean scene luma ${meanOf((q) => q.bright).toFixed(1)} at ${h1}:00`
      + ` vs ${meanOf((q) => q.dark).toFixed(1)} at ${h2}:00`);
  }

  // Every graded line also has to have *painted*: a ratio computed off 14 px of stroke is a number
  // with no picture behind it, and an element whose ink vanished (a colour that went transparent, a
  // font that failed to load) reads as "nothing painted" above rather than as a bad ratio.
  const unpainted = rows.filter((r) => r.why && /nothing painted/.test(r.why));
  check('every discovered line put ink on the screen', unpainted.length === 0,
    unpainted.map((r) => `${r.hour}:00 ${r.key}`).join(' | ') || `${rows.length} lines, all painted`);

  check('no page errors through any of it', errs.length === 0, errs.slice(0, 3).join(' | ') || 'clean');
} catch (e) {
  fails++;
  console.log(`  FAIL the probe ran to the end — ${e.message}`);
  console.log(e.stack);
}

await b.close();
console.log(`\nlegible-check: ${passes} passed, ${fails} failed, ${skips} skipped`);
process.exit(fails);
