// A/B the colour-grade pass at runtime, and measure the frame each variant produces.
//
// Written for one specific question that neither a screenshot nor the terrain shader could
// answer: the abyss arena floor photographs at luma 3.5 with rgb [0,0,49] — red and green
// *exactly* zero — although its albedo is #3a3a5c and hand algebra over terrain.js's
// shade path predicts luma ~30 even fully shadowed. Something between the terrain shader
// and the PNG was eating the darks, and the only way to find out which stage is to change
// one stage at a time on a live frame.
//
// The trick that makes this cheap: every stage of the post chain is a uniform on a live
// object (`game.r.grade.uniforms`, `.bloom`, `renderer.toneMapping`), so one browser boot
// can shoot the same camera through a dozen pipelines. No rebuild, no HMR, and — because it
// only writes uniforms — no risk of leaving the repo in a half-changed state.
//
//   DISPLAY=:99 node tools/grade-ab.mjs [zone]
//
// Each variant prints the same rectangles so the columns are directly comparable. Read the
// *ratios* between variants, not the absolute numbers: llvmpipe renders the low-tier
// pipeline unless the probe pins a tier (it does — see tools/tour.mjs's header).

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import { decodePng, rectStats, pixelsDiffering } from './lib/png.mjs';

const zone = process.argv[2] || 'abyssTrial';
const origin = 'http://127.0.0.1:5173';
const tokFile = '/tmp/teyvat-probe-token';

// Rectangles over the abyss arena spawn frame: two patches of bare floor, the inlaid ring
// arc that should be visible on it, and two bright things that must NOT change when the
// shadow end of the curve is fixed.
const RECTS = [
  { x: 380, y: 600, w: 200, h: 90, label: 'floor-near' },
  { x: 700, y: 300, w: 140, h: 40, label: 'floor-mid' },
  { x: 250, y: 285, w: 300, h: 18, label: 'inlay-ring' },
  { x: 990, y: 300, w: 90, h: 90, label: 'crystal' },
  { x: 508, y: 338, w: 44, h: 40, label: 'brazier-flame' },
];

const VARIANTS = [
  { key: 'base', apply: () => {} },
  // Two controls, because "every variant measured the same" has two very different causes:
  // the pass does nothing, or the screenshots are stale. A red tint must recolour the whole
  // frame, and a 90° yaw must change it completely. If either control fails to move the
  // numbers, nothing below it means anything.
  { key: 'ctl-tint-red', apply: (g) => { g.r.grade.uniforms.uTint.value.setRGB(1, 0.2, 0.2); } },
  { key: 'ctl-yaw-90', apply: (g) => { g.rig.yaw = Math.PI / 2; } },
  // The suspect: `(c - 0.5) * 1.06 + 0.5` runs on scene-linear HDR, so it subtracts a flat
  // 0.03 from every channel and clips everything below 0.028 linear to black.
  { key: 'contrast-off', apply: (g) => { g.r.grade.uniforms.uContrast.value = 1.0; } },
  { key: 'lift-off', apply: (g) => { g.r.grade.uniforms.uLift.value.set(0, 0, 0); } },
  { key: 'grade-off', apply: (g) => { g.r.grade.enabled = false; } },
  { key: 'vignette-off', apply: (g) => { g.r.grade.uniforms.uVignette.value = 0; } },
];

let token = fs.existsSync(tokFile) ? fs.readFileSync(tokFile, 'utf8').trim() : '';
if (!token) {
  const r = await fetch(`${origin}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  token = (await r.json()).token;
  fs.writeFileSync(tokFile, token);
}

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
  },
  defaultViewport: { width: 1280, height: 800 },
});
const p = await b.newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message));

await p.goto(origin, { waitUntil: 'domcontentloaded' });
await p.evaluate((t) => localStorage.setItem('teyvat.token', t), token);
await p.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 5000));
await p.click('[data-act="resume"]');
for (let i = 0; i < 90; i++) {
  if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) break;
  await new Promise((r) => setTimeout(r, 1000));
}

// The app reloads itself once shortly after `resume` (session hand-off), and evaluating
// into the frame that is about to go away fails with "detached Frame". tour.mjs waits out
// the same race; so does this.
await new Promise((r) => setTimeout(r, 5000));
await p.evaluate(() => {
  window.game.setAutoQuality(false);
  window.game.setQuality('high');
  // Noon, pinned: the world clock moves the sun 15° a real minute, and every threshold in this
  // file was calibrated on the authored sky, which is exactly what daylight() returns at 12:00.
  window.game.setWorldTime(12);
});
// Same camera as tour shot 0, so the rectangles below mean the same thing in both tools.
await p.evaluate((zn) => window.game.enterZone(zn, { x: 0, z: 14 }), zone);
await new Promise((r) => setTimeout(r, 6000));
await p.evaluate(() => { window.game.rig.yaw = 0; window.game.rig.pitch = 0.24; });
await new Promise((r) => setTimeout(r, 2500));
const tier = await p.evaluate(() => window.game.quality);
if (tier !== 'high') { console.log(`FAIL: tier is ${tier}, not high`); await b.close(); process.exit(1); }

/** Block until the render loop has drawn `n` more frames (or 40 s has passed). */
async function waitFrames(from, n) {
  for (let i = 0; i < 200; i++) {
    const f = await p.evaluate(() => window.game.r.frame);
    if (f - from >= n) return f - from;
    await new Promise((r) => setTimeout(r, 200));
  }
  return -1;
}

const table = [];
let prevImg = null;
for (const v of VARIANTS) {
  // Every variant starts from a clean pass: re-apply the shipped defaults, then the override.
  await p.evaluate(() => {
    const u = window.game.r.grade.uniforms;
    window.game.r.grade.enabled = true;
    u.uContrast.value = 1.06;
    u.uSaturation.value = 1.05;
    u.uLift.value.set(0.005, 0.008, 0.016);
    u.uVignette.value = 0.32;
    u.uTint.value.setRGB(1, 1, 1);
    u.uFlash.value = 0;
    window.game.rig.yaw = 0;
    window.game.rig.pitch = 0.24;
  });
  // Read the state back after applying it. An override that silently failed (wrong handle
  // name, renamed uniform) would otherwise print the baseline five times and look like
  // "the grade pass makes no difference" — the exact wrong conclusion.
  const state = await p.evaluate(new Function(
    'const g = window.game;'
    + '(' + v.apply.toString() + ')(g);'
    + 'const u = g.r.grade.uniforms;'
    + 'return { on: g.r.grade.enabled, contrast: u.uContrast.value,'
    + ' lift: u.uLift.value.toArray(), vignette: u.uVignette.value,'
    + ' tint: u.uTint.value.getHexString(), yaw: +g.rig.yaw.toFixed(2), frame: g.r.frame };',
  ));
  // Wait on *frames*, not on wall clock. Under llvmpipe a 3.2 M-triangle frame can take
  // seconds, and a fixed sleep photographs the pipeline from before the override.
  const drawn = await waitFrames(state.frame, 4);
  await new Promise((r) => setTimeout(r, 400));
  const png = await p.screenshot({ path: `/tmp/grade-${zone}-${v.key}.png` });
  const img = decodePng(Buffer.from(png));
  const moved = prevImg ? pixelsDiffering(prevImg, img) : null;
  prevImg = img;
  const rows = RECTS.map((r) => rectStats(img, r));
  table.push({ variant: v.key, state, drawn, moved, rows });
  console.log(`\n--- ${v.key}  frames+${drawn}  pxDiffVsPrev=${moved}  ${JSON.stringify(state)}`);
  for (const r of rows) {
    console.log(`  ${r.label.padEnd(14)} rgb=[${r.rgb.join(',')}]`.padEnd(46)
      + `lum=${String(r.lum).padStart(6)} std=${String(r.std).padStart(5)} clip=${r.clip}`);
  }
}

// The controls exist to be checked, not just printed: a run where the red tint or the 90°
// yaw left the frame untouched measured a stale canvas and every other row is void.
for (const key of ['ctl-tint-red', 'ctl-yaw-90']) {
  const row = table.find((t) => t.variant === key);
  if (row && row.moved !== null && row.moved < 20000) {
    console.log(`\nFAIL: control ${key} changed only ${row.moved} px — the screenshots are stale,`
      + ' every measurement above is void (check rAF throttling: is another page focused?)');
    await b.close();
    process.exit(1);
  }
}

console.log('\nzone', zone, '- shots at /tmp/grade-' + zone + '-<variant>.png');
fs.writeFileSync(`/tmp/grade-ab-${zone}.json`, JSON.stringify(table, null, 1));
await b.close();
process.exit(0);
