// 天光门禁: the world clock, the sun's path, and the two shader terms that had no producer.
//
// Why this probe exists. `client/src/gfx/sky.js` has carried `uStars: { value: s.stars ?? 0 }` and
// `uNight: { value: s.night ?? 0 }` since the day it was written — an eight-line twinkling star
// field and a night term — and **no zone has ever authored either key**. Two shader branches that
// had never drawn a pixel, for the same reason four animation clips had never been played: the
// producer was missing. Here it is (`shared/src/world/daylight.js`), and this file is the gate that
// keeps it honest, in four parts:
//
//  1. **The clock** (no browser). `worldClock` is a pure function of epoch milliseconds — that is
//     what makes 单机 and 多人 agree on the hour with nothing on the wire — so it can be asserted
//     without a page at all, including the wrap cases (negative input, hour 24, `'13:30'`).
//
//  2. **Noon is the authored sky, exactly** (no browser). ~500 calibrated pixel assertions across
//     `tour`, `vault-cam`, `prop-check`, `npc-cam`, `enemy-cam`, `light-space` and `motion-check`
//     stand on each zone's hand-tuned `sky` block. `daylight()` is built so 12:00 reproduces those
//     numbers *bit for bit* (every coefficient pair sums to 1, every mix collapses to its first
//     argument), and every probe now pins noon. That identity is asserted here for all six zones,
//     term by term with `===`, rather than trusted — and part 4 asserts the probes really pin it.
//
//  3. **The curve, swept** (no browser). A full day at 15-minute steps for every zone: the sun up
//     between 06:00 and 18:00 and down otherwise, `lightDir` never below the horizon (or night is
//     lit from *under* the terrain and every face goes black), no returned colour channel ever 0
//     (a channel pinned at 0 over a region is this repo's signature display-operator bug), stars
//     only after the sun has actually set, and every key returned having a named reader.
//
//  4. **Pixels** (browser). Wiring proves the values arrive; only a frame proves they do anything.
//     The loop is stopped and frames are rendered by hand, so a shot is a still life: noon, dusk
//     and midnight measured on the same camera, plus the hide-the-suspect test for both dead
//     uniforms (force `uStars`/`uNight` to 0 at midnight — the frame must change; do the same at
//     noon — it must not), the HUD clock read as pixels and text, and an indoor zone which must
//     *not* move at all while the outdoor one moves by tens of thousands of pixels.
//
// Method notes: quality is pinned to `high` (llvmpipe boots every browser at `low`), the HUD is
// hidden for world shots so the clock widget's own pixels cannot leak into a world diff, and every
// hour change is followed by a hand-rendered frame rather than a sleep — at 2–6 fps a sleep is how
// a probe ends up measuring the frame it was leaving.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import {
  DAY_MS, worldClock, clockLabel, dayTFromHours, timeOfDayName, daylight,
} from '../shared/src/world/daylight.js';
import { ZONES, ZONE_IDS } from '../shared/src/data/zones.js';
import { decodePng, rectStats, pixelsDiffering } from './lib/png.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/daylight'; })();
const NO_BROWSER = argv.includes('--no-browser');
const W = 1000, H = 700;
fs.mkdirSync(outDir, { recursive: true });
const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); } else {
    fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
};
const skipped = (name, why) => { skip++; console.log(`  SKIP ${name} — ${why}`); };

const hexRgb = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((v, i) => v === b[i]);
const deg = (r) => +((r * 180) / Math.PI).toFixed(1);
const byte = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);

/* ------------------------------------------------------------- 1. the clock -- */

console.log('=== the clock');
check('a day is 24 real minutes', DAY_MS === 24 * 60 * 1000, `${DAY_MS} ms`);
check('epoch 0 is midnight', worldClock(0).dayT === 0 && worldClock(0).label === '00:00',
  worldClock(0).label);
check('half a day in is noon', worldClock(DAY_MS / 2).label === '12:00', worldClock(DAY_MS / 2).label);
// A caller that subtracts a clock skew off Date.now() can hand this a negative number; a bare
// `%` would return a negative dayT and every `smooth` downstream would clamp to midnight.
const back = worldClock(-DAY_MS * 1.25);
check('a negative time still lands inside the day', back.dayT >= 0 && back.dayT < 1,
  `dayT ${back.dayT.toFixed(3)} label ${back.label}`);
check('one real minute is one in-game hour',
  Math.abs((worldClock(60_000).dayT - worldClock(0).dayT) * 24 - 1) < 1e-9,
  `${((worldClock(60_000).dayT - worldClock(0).dayT) * 24).toFixed(4)} h`);
// The wall clock is shared, so two clients that are not talking to each other still agree.
const t0 = Date.UTC(2026, 8, 7, 3, 21, 44, 250);
check('two callers with the same epoch ms get the same hour',
  worldClock(t0).label === worldClock(t0).label && worldClock(t0).dayT === worldClock(t0 + DAY_MS).dayT,
  `${worldClock(t0).label} and a day later ${worldClock(t0 + DAY_MS).label}`);

console.log('\n=== parsing an hour');
check('12 is noon', dayTFromHours(12) === 0.5);
check('13.5 is half past one', Math.abs(dayTFromHours(13.5) - 13.5 / 24) < 1e-12);
check("'13:30' parses to the same place", dayTFromHours('13:30') === dayTFromHours(13.5),
  `${dayTFromHours('13:30')} vs ${dayTFromHours(13.5)}`);
check('24 wraps to midnight rather than falling off the end', dayTFromHours(24) === 0);
check('30 wraps to 06:00', Math.abs(dayTFromHours(30) - 0.25) < 1e-12, String(dayTFromHours(30)));
check('nonsense is rejected instead of becoming NaN',
  dayTFromHours('breakfast') === null && dayTFromHours(NaN) === null && dayTFromHours('99:99') !== undefined,
  `'breakfast' -> ${dayTFromHours('breakfast')}`);
check('the label pads both fields', clockLabel(dayTFromHours('7:05')).label === '07:05',
  clockLabel(dayTFromHours('7:05')).label);

/* --------------------------------------------------- 2. noon is the authored sky -- */

console.log('\n=== 12:00 is the authored sky, bit for bit');
for (const id of ZONE_IDS) {
  const sky = ZONES[id].sky;
  const ph = daylight(sky, 0.5);
  // Every one of these is an `===` on purpose. "Close enough" is what would let a rounding change
  // move a calibrated threshold by one count six months from now with nothing to point at.
  const terms = [
    ['day is exactly 1', ph.day === 1, ph.day],
    ['night is exactly 0', ph.night === 0, ph.night],
    ['golden is exactly 0', ph.golden === 0, ph.golden],
    ['stars are exactly 0', ph.stars === 0, ph.stars],
    ['sunColor is the authored colour', same(ph.sunColor, hexRgb(sky.sunColor)), ph.sunColor.join()],
    ['groundSunColor is too', same(ph.groundSunColor, hexRgb(sky.sunColor)), ph.groundSunColor.join()],
    ['sunIntensity is the authored intensity', ph.sunIntensity === (sky.sunIntensity ?? 1.6), ph.sunIntensity],
    ['ambientSky is authored', same(ph.ambientSky, hexRgb(sky.ambientSky)), ph.ambientSky.join()],
    ['ambientGround is authored', same(ph.ambientGround, hexRgb(sky.ambientGround)), ph.ambientGround.join()],
    ['ambientIntensity is authored', ph.ambientIntensity === (sky.ambientIntensity ?? 0.9), ph.ambientIntensity],
    ['fogColor is authored', same(ph.fogColor, hexRgb(sky.fogColor)), ph.fogColor.join()],
    ['zenith is authored', same(ph.zenith, hexRgb(sky.zenithColor ?? sky.ambientSky)), ph.zenith.join()],
    ['horizon is authored', same(ph.horizon, hexRgb(sky.horizonColor ?? sky.fogColor)), ph.horizon.join()],
    ['the light comes from the sun, not its antipode', same(ph.lightDir, ph.sunDir), ph.lightDir.join()],
  ];
  const bad = terms.filter(([, ok]) => !ok);
  check(`${id}: 12:00 returns the authored sky (${terms.length} terms)`, bad.length === 0,
    bad.length ? bad.map(([n, , v]) => `${n} -> ${v}`).join('; ') : `elev ${deg(ph.elevation)}°`);
  // The noon direction is the authored one, normalised — the great circle is built through it, so
  // if this drifts the shadows in every calibrated shot rotate.
  const n = Math.hypot(...sky.sunDir);
  check(`${id}: the noon sun points where the zone says`,
    ph.sunDir.every((v, i) => Math.abs(v - sky.sunDir[i] / n) < 1e-12),
    `${ph.sunDir.map((v) => v.toFixed(4)).join()} vs authored ${sky.sunDir.join()}`);
}

/* ------------------------------------------------------------ 3. the whole day -- */

console.log('\n=== a full day, 15-minute steps, every zone');
const STEPS = 96;
const COLOUR_KEYS = ['sunColor', 'groundSunColor', 'ambientSky', 'ambientGround', 'zenith', 'horizon', 'fogColor'];
for (const id of ZONE_IDS) {
  const sky = ZONES[id].sky;
  const day = [];
  for (let i = 0; i < STEPS; i++) day.push(daylight(sky, i / STEPS));

  check(`${id}: every scalar stays inside its range`,
    day.every((p) => [p.day, p.night, p.golden, p.stars].every((v) => v >= 0 && v <= 1 && Number.isFinite(v))),
    `day ${Math.min(...day.map((p) => p.day)).toFixed(2)}–${Math.max(...day.map((p) => p.day)).toFixed(2)}`);
  check(`${id}: night is exactly the complement of day`,
    day.every((p) => Math.abs(p.night + p.day - 1) < 1e-15));
  // The sun is up for half the day. An equinox day is what the great-circle construction gives, so
  // this is really asserting that the construction is the one documented.
  const upIdx = day.map((pp, i) => [i, pp.elevation]).filter(([, e]) => e > 1e-9).map(([i]) => i);
  const dawnI = STEPS / 4, duskI = (STEPS * 3) / 4;
  check(`${id}: the sun is up strictly between 06:00 and 18:00, on the horizon at both, down otherwise`,
    upIdx.length === STEPS / 2 - 1 && upIdx[0] === dawnI + 1 && upIdx[upIdx.length - 1] === duskI - 1
    && Math.abs(day[dawnI].elevation) < 1e-12 && Math.abs(day[duskI].elevation) < 1e-12
    && day.every((pp, i) => i >= dawnI && i <= duskI ? true : pp.elevation < 0),
    `${upIdx.length} steps ${day[upIdx[0]].label}–${day[upIdx[upIdx.length - 1]].label},`
    + ` 06:00 ${deg(day[dawnI].elevation)}° 18:00 ${deg(day[duskI].elevation)}°`);
  // The one that matters most: the DirectionalLight and the terrain shader take `lightDir`, and a
  // light below the horizon lights the underside of the ground — every visible face goes black.
  check(`${id}: lightDir never dips below the horizon`,
    day.every((p) => p.lightDir[1] >= 0),
    `min ${Math.min(...day.map((p) => p.lightDir[1])).toFixed(4)}`);
  check(`${id}: both directions stay unit length`,
    day.every((p) => Math.abs(Math.hypot(...p.sunDir) - 1) < 1e-12 && Math.abs(Math.hypot(...p.lightDir) - 1) < 1e-12));
  // Stars over a sunlit sky was the first tuning's actual bug: `stars` was driven from `night`,
  // which is still 0.6 when the sun is exactly on the horizon, so sunrise had a full star field.
  check(`${id}: stars only come out after the sun has set`,
    day.every((p) => p.elevation <= 0 || p.stars === 0),
    `max while up ${Math.max(...day.filter((p) => p.elevation > 0).map((p) => p.stars)).toFixed(3)}`);
  check(`${id}: and they are fully out in the middle of the night`,
    daylight(sky, 0).stars > 0.95, daylight(sky, 0).stars.toFixed(3));
  // Golden hour is a horizon effect in both directions: on at 06:00/18:00, off at noon and at
  // midnight. "Warm at dusk" alone would also be true of a term that is warm all the time.
  check(`${id}: golden is on at the horizon and off at both extremes`,
    daylight(sky, 0.25).golden > 0.95 && daylight(sky, 0.75).golden > 0.95
    && daylight(sky, 0.5).golden === 0 && daylight(sky, 0).golden === 0,
    `06:00 ${daylight(sky, 0.25).golden.toFixed(2)} 18:00 ${daylight(sky, 0.75).golden.toFixed(2)}`);
  // No channel may reach 0 over a whole frame. This repo has been bitten twice by exactly that —
  // a 0.5-pivot contrast before tone mapping, and ACES eating saturated greens — and the ambient
  // floor (0.30 of authored) is the only thing standing between a night ground and a dead hole.
  let worst = { v: 1, at: '', key: '' };
  for (const p of day) {
    for (const k of COLOUR_KEYS) {
      for (const v of p[k]) if (v < worst.v) worst = { v, at: p.label, key: k };
    }
  }
  check(`${id}: no colour channel is ever driven to zero`, worst.v > 0.005,
    `min ${worst.v.toFixed(4)} in ${worst.key} at ${worst.at}`);
  // Monotone where it has to be, or a sunrise could brighten and dim on the way up.
  const morning = day.slice(0, STEPS / 2).map((p) => p.day);
  check(`${id}: the day brightens from midnight to noon and never backwards`,
    morning.every((v, i) => i === 0 || v >= morning[i - 1] - 1e-12),
    `${morning[0].toFixed(2)} → ${morning[morning.length - 1].toFixed(2)}`);
  check(`${id}: noon is the brightest moment of the day`,
    day.every((p) => p.sunIntensity <= daylight(sky, 0.5).sunIntensity + 1e-12));
  // Ordering, not just difference: dusk has to sit strictly between noon and midnight, or a curve
  // that jumped straight from day to night would pass a "they differ" test.
  const [noon, dusk, mid] = [0.5, 0.75, 0].map((t) => daylight(sky, t));
  check(`${id}: noon > 黄昏 > midnight in both intensity and ambient`,
    noon.sunIntensity > dusk.sunIntensity && dusk.sunIntensity > mid.sunIntensity
    && noon.ambientIntensity > dusk.ambientIntensity && dusk.ambientIntensity > mid.ambientIntensity,
    `sun ${noon.sunIntensity.toFixed(2)}/${dusk.sunIntensity.toFixed(2)}/${mid.sunIntensity.toFixed(2)}`);
  // The point of mixing toward GOLD *before* dimming: 18:00 is a warm sun, not a dim white one.
  const warmth = (p) => p.sunColor[0] / p.sunColor[2];
  check(`${id}: 黄昏's light is warmer than noon's and midnight's is cooler`,
    warmth(dusk) > warmth(noon) * 1.15 && warmth(mid) < warmth(noon),
    `r/b noon ${warmth(noon).toFixed(2)} dusk ${warmth(dusk).toFixed(2)} night ${warmth(mid).toFixed(2)}`);
}

console.log('\n=== naming the time of day');
const names = new Set();
for (let i = 0; i < 24 * 4; i++) names.add(timeOfDayName(daylight(ZONES.mondstadt.sky, i / (24 * 4))));
const WANT_NAMES = ['夜晚', '黎明', '上午', '正午', '下午', '黄昏'];
check('every name the function can return actually happens during a day',
  WANT_NAMES.every((n) => names.has(n)) && [...names].every((n) => WANT_NAMES.includes(n)),
  [...names].join(' '));
// The bug this replaced: `night` was tested first, so 06:00 — sun exactly on the horizon, sky
// orange — was called 夜晚. The word and the picture have to agree.
check('sunrise is 黎明 and sunset is 黄昏, not 夜晚',
  timeOfDayName(daylight(ZONES.mondstadt.sky, 0.25)) === '黎明'
  && timeOfDayName(daylight(ZONES.mondstadt.sky, 0.75)) === '黄昏',
  `${timeOfDayName(daylight(ZONES.mondstadt.sky, 0.25))} / ${timeOfDayName(daylight(ZONES.mondstadt.sky, 0.75))}`);
check('the middle of the night is 夜晚 and noon is 正午',
  timeOfDayName(daylight(ZONES.mondstadt.sky, 0)) === '夜晚'
  && timeOfDayName(daylight(ZONES.mondstadt.sky, 0.5)) === '正午');

/* ----------------------------------------------- 3b. every key has a reader -- */

// The whole reason this feature exists is that two shader uniforms sat there for months with no
// producer. The mirror image — a producer with no consumer — is the same defect, so both
// directions are gated: every key `daylight()` returns must be read by a named file, and every
// `ph.<key>` any renderer reads must be a key that exists.
console.log('\n=== every value returned has a named reader');
const READERS = [
  'client/src/gfx/sky.js', 'client/src/gfx/terrain.js', 'client/src/game/world.js',
  'client/src/game/game.js', 'client/src/ui/hud.js', 'shared/src/world/daylight.js',
];
const src = Object.fromEntries(READERS.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const KEYS = Object.keys(daylight(ZONES.mondstadt.sky, 0.5));
const noReader = [];
for (const k of KEYS) {
  // `ph.key` in a renderer, or `c.key` in the HUD (the clock view carries a copy), or `sky.key`
  // in the module itself (timeOfDayName reads golden/rising/night/day/hour).
  const re = new RegExp(`\\b(ph|c|p|v)\\.${k}\\b`);
  const who = READERS.filter((f) => re.test(src[f]));
  if (!who.length) noReader.push(k); else console.log(`  ${k.padEnd(18)} ${who.map((f) => f.split('/').pop()).join(' ')}`);
}
check('no value is returned that nobody reads', noReader.length === 0, noReader.join(' '));
const unknown = [];
for (const f of READERS) {
  for (const m of src[f].matchAll(/\bph\.([a-zA-Z]+)\b/g)) {
    if (!KEYS.includes(m[1]) && !unknown.includes(`${f}:${m[1]}`)) unknown.push(`${f.split('/').pop()}:${m[1]}`);
  }
}
check('and nothing reads a value that is not returned', unknown.length === 0, unknown.join(' '));

/* ------------------------------------------- 3c. every pixel probe pins noon -- */

// A moving sun would silently invalidate every calibrated threshold in the repo. The defence is
// that each pixel probe pins 12:00 — and a defence nobody checks is a defence that rots, so this
// scans for it. Exempt probes carry an obligation: they must hide the WebGL canvas, which is what
// makes them measurements of the HUD rather than of the world.
console.log('\n=== every probe that measures pixels pins the hour');
const EXEMPT = {
  'chamber-ui.mjs': 'measures the chamber HUD with the canvas hidden',
  'food-check.mjs': 'measures the 料理 panel with the canvas hidden',
  'resonance-ui.mjs': 'measures the party panel with the canvas hidden',
  'expedition-ui.mjs': 'measures the 派遣 panel and the HUD chip with the canvas hidden',
};
const probes = fs.readdirSync('tools').filter((f) => f.endsWith('.mjs') && f !== 'daylight-check.mjs');
const measures = [], missing = [], badExempt = [];
for (const f of probes) {
  const s = fs.readFileSync(`tools/${f}`, 'utf8');
  if (!/window\.game/.test(s) || !/lib\/(png|rectstats)/.test(s)) continue;
  measures.push(f);
  if (/setWorldTime\(/.test(s)) continue;
  if (!EXEMPT[f]) { missing.push(f); continue; }
  // The obligation. An exemption that cannot show the canvas being taken out of the frame is a
  // probe measuring a moving world while claiming not to.
  if (!/visibility\s*=\s*'hidden'|setCanvasVisible\(false\)/.test(s)) badExempt.push(f);
}
console.log(`  ${measures.length} probes measure pixels; exempt: ${Object.keys(EXEMPT).join(' ')}`);
check('the scan found the pixel probes at all', measures.length >= 15, `${measures.length} files`);
check('every pixel probe pins the hour or is exempt', missing.length === 0, missing.join(' '));
check('every exempt probe really hides the canvas', badExempt.length === 0, badExempt.join(' '));
check('the exemption table has no stale entries',
  Object.keys(EXEMPT).every((f) => measures.includes(f)),
  Object.keys(EXEMPT).filter((f) => !measures.includes(f)).join(' '));

if (NO_BROWSER) {
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped (--no-browser)`);
  process.exit(fail === 0 && pass >= 60 ? 0 : 1);
}

/* ----------------------------------------------------------------- 4. pixels -- */

const tokFile = '/tmp/world-token.txt';
let token = fs.existsSync(tokFile) ? fs.readFileSync(tokFile, 'utf8').trim() : '';
if (!token) {
  const r = await fetch(`${API}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  token = (await r.json()).token;
  fs.writeFileSync(tokFile, token);
  console.log('minted a guest token ->', tokFile);
}

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
  },
  defaultViewport: { width: W, height: H },
});
const p = await b.newPage();
const errs = [], hmr = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
p.on('console', (m) => {
  const t = m.text().slice(0, 250);
  if (/\[vite\].*(hot updated|hmr update|page reload)/i.test(t)) { hmr.push(t); console.log('[HMR]', t); }
  if (m.type() === 'error') { errs.push(t.slice(0, 200)); console.log('[err]', t); }
});

await p.goto(origin, { waitUntil: 'domcontentloaded' });
await p.evaluate((t) => localStorage.setItem('teyvat.token', t), token);
await p.reload({ waitUntil: 'domcontentloaded' });
await sleep(5000);
await p.click('[data-act="resume"]');
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
await sleep(4000);
await p.evaluate(() => { window.game.setAutoQuality(false); window.game.setQuality('high'); });
await sleep(3000);

// Into 蒙德, explicitly. A boot resumes the *saved* zone, and this probe's own last section leaves
// the shared guest account underground: the previous run shot its whole "the frame changes with the
// hour" section inside 深渊试炼场, where by design nothing changes, so five must-move assertions
// failed and every must-not-move one passed. Never inherit the zone.
await p.evaluate(async () => {
  await window.game.enterZone('mondstadt', { x: 0, z: 14 });
  await new Promise((r) => setTimeout(r, 6000));
});

const boot = await p.evaluate(() => {
  const g = window.game;
  g.stop();
  // Framing, set by hand rather than through the rig. The first version nudged `rig.pitch` and
  // measured a "sky" rect whose mean colour was rgb(128,149,92) — foliage. The camera is put at
  // head height and aimed 5° above the horizontal with a 55° vertical fov, so the top of the frame
  // is ~32° up (sky, with nothing in 蒙德 tall enough to reach it) and the bottom ~22° down (ground
  // within about ten metres). The player is behind the camera, so the middle of the frame is world
  // rather than avatar. Both rects are then *validated* at noon below, because a framing claim
  // nobody checks is how the first run measured a hedge and called it a sunset.
  const me = g.me, cam = g.camera, yaw = 0.6, up = Math.tan(5 * Math.PI / 180) * 30;
  cam.fov = 55;
  cam.position.set(me.x, me.y + 3.0, me.z);
  cam.lookAt(me.x + Math.sin(yaw) * 30, me.y + 3.0 + up, me.z + Math.cos(yaw) * 30);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  // The HUD and the world overlay are DOM over the canvas. Hidden for world shots so the clock
  // widget's own pixels cannot show up in a "did the world change" diff — the widget is measured
  // separately, with the HUD back on.
  window.__dlHud = (on) => {
    for (const el of document.querySelectorAll('[data-hud], #world-overlay')) el.style.visibility = on ? '' : 'hidden';
  };
  window.__dlPin = (h) => {
    const ok = g.setWorldTime(h);
    for (let i = 0; i < 3; i++) g.r.render(0.016);
    return ok;
  };
  window.__dlRender = () => { for (let i = 0; i < 3; i++) g.r.render(0.016); };
  return { zone: g.zoneId, quality: g.quality, running: g._running, indoor: !!g.world.zone.indoor };
});
console.log(`\n=== frames in ${boot.zone} @ ${boot.quality}`);
check('the frames are shot outdoors, in the zone this probe asked for',
  boot.zone === 'mondstadt' && boot.indoor === false, `${boot.zone} indoor=${boot.indoor}`);
check('the tier is still pinned when the shooting starts', boot.quality === 'high', boot.quality);
check('the game loop is stopped, so two shots share one camera', boot.running === false);

const shoot = async (file) => {
  await p.screenshot({ path: `${outDir}/${file}.png` });
  return decodePng(fs.readFileSync(`${outDir}/${file}.png`));
};

// Bands, not guesses about where a thing is: the sky rect is the top strip between the two HUD
// corners and the ground rects sit either side of the character, who stands in the middle.
const SKY = { x: 330, y: 20, w: 340, h: 110, label: 'sky' };
const GROUND_L = { x: 120, y: 600, w: 300, h: 70, label: 'ground-L' };
const GROUND_R = { x: 580, y: 600, w: 300, h: 70, label: 'ground-R' };

const HOURS = [12, 18, 21, 0, 6];
const frames = {};
await p.evaluate(() => window.__dlHud(false));
for (const h of HOURS) {
  const st = await p.evaluate((hh) => {
    const ok = window.__dlPin(hh);
    const g = window.game;
    return {
      ok, label: g.clock.label, name: g.clock.name, pinned: g.clock.pinned,
      stars: g.world.sky.uniforms.uStars.value, night: g.world.sky.uniforms.uNight.value,
      lightY: +g.world.sky.lightDir.y.toFixed(3),
      // Where the light *is*, not where the sky says it should be. `lightDir` is a stored vector;
      // the DirectionalLight's position is what lights the terrain and centres the shadow map, and
      // it used to be written only by update() — so with the loop stopped it kept the previous
      // hour's direction. That is not a probe detail: it decided whether the foreground meadow was
      // sunlit or shadowed, silently, from an identical camera.
      lightDot: (() => {
        const s = g.world.sky, sp = s.sun.position, tp = s.sun.target.position;
        const dx = sp.x - tp.x, dy = sp.y - tp.y, dz = sp.z - tp.z;
        const L = Math.hypot(dx, dy, dz) || 1;
        return +((dx / L) * s.lightDir.x + (dy / L) * s.lightDir.y + (dz / L) * s.lightDir.z).toFixed(4);
      })(),
      sunInt: +g.world.sky.sun.intensity.toFixed(3),
      ground: g.world.terrain.uniforms.uSunColor.value.getHexString(),
    };
  }, h);
  await sleep(1200);
  await p.evaluate(() => window.__dlRender());
  const img = await shoot(`h${String(h).padStart(2, '0')}`);
  const sky = rectStats(img, SKY);
  const gl = rectStats(img, GROUND_L), gr = rectStats(img, GROUND_R);
  frames[h] = { img, sky, ground: { lum: (gl.lum + gr.lum) / 2, clip: Math.max(gl.clip, gr.clip), rgb: gl.rgb }, st };
  console.log(`  ${st.label} ${String(st.name).padEnd(4)} sky lum ${String(sky.lum).padStart(5)} rgb ${sky.rgb.join()}`
    + ` | ground lum ${((gl.lum + gr.lum) / 2).toFixed(1)} rgb ${gl.rgb.join()} clip ${Math.max(gl.clip, gr.clip)}`
    + ` | dot ${st.lightDot} | uStars ${st.stars.toFixed(2)} uNight ${st.night.toFixed(2)} lightY ${st.lightY} sun ${st.sunInt}`);
  check(`${h}:00 — the pin was accepted and the clock agrees`,
    st.ok === true && st.pinned === true && st.label === `${String(h).padStart(2, '0')}:00`, st.label);
  check(`${h}:00 — the light is actually standing where the hour says, with the loop stopped`,
    st.lightDot > 0.9999, `dot(sun.position - target, lightDir) = ${st.lightDot}`);
}

const noonF = frames[12], duskF = frames[18], nightF = frames[0], dawnF = frames[6];

// The rects are where they are claimed to be. Sky is blue at noon (blue above green above red) and
// grass is green (green above both) — so a framing that drifts onto a hedge, a cliff or the HUD
// fails here instead of quietly turning every hue claim below into noise.
console.log('\n=== the rects are on sky and on ground');
check('the sky rect is sky at noon: blue over green over red',
  noonF.sky.rgb[2] > noonF.sky.rgb[1] && noonF.sky.rgb[1] > noonF.sky.rgb[0],
  `rgb ${noonF.sky.rgb.join()}`);
check('the ground rect is ground at noon: green over blue',
  noonF.ground.rgb[1] > noonF.ground.rgb[2] && noonF.ground.rgb[1] > noonF.ground.rgb[0],
  `rgb ${noonF.ground.rgb.join()}`);

console.log('\n=== the frame changes with the hour');
// Ordering in both halves of the frame. "Night is darker" alone would also be satisfied by a
// build where only the fog moved; the sky and the ground are lit by different terms (the dome
// shader vs the terrain's uSunColor) and both have to follow the clock.
check('the sky is brightest at noon, dimmest at midnight, dusk between',
  noonF.sky.lum > duskF.sky.lum && duskF.sky.lum > nightF.sky.lum,
  `${noonF.sky.lum} > ${duskF.sky.lum} > ${nightF.sky.lum}`);
check('the ground follows the same ordering',
  noonF.ground.lum > duskF.ground.lum && duskF.ground.lum > nightF.ground.lum,
  `${noonF.ground.lum.toFixed(1)} > ${duskF.ground.lum.toFixed(1)} > ${nightF.ground.lum.toFixed(1)}`);
// An *interval*, because "dusk between" above is satisfied by a dome one count darker than noon —
// and that is very nearly what the build did. Moving the dome's hue off `night` and onto `dark`
// (correctly: `night` is already 0.61 with the sun on the horizon) also removed the only thing that
// was dimming it, so 18:00 photographed at lum 185.7 against noon's 203.2: an afternoon sky with an
// orange sun pasted into it, and near-white is exactly where ACES refuses to hold a hue. `domeDim`
// is the brightness term that replaced the accident; this is the pair of bounds it has to sit in.
check('黄昏 is a mid-tone sky: clearly darker than noon, still nothing like night',
  duskF.sky.lum < noonF.sky.lum * 0.75 && duskF.sky.lum > nightF.sky.lum * 4,
  `dusk ${duskF.sky.lum} vs noon ${noonF.sky.lum} (want < ${(noonF.sky.lum * 0.75).toFixed(0)})`
  + ` and night ${nightF.sky.lum} (want > ${(nightF.sky.lum * 4).toFixed(0)})`);
check('and midnight is a big change, not a nudge',
  noonF.sky.lum - nightF.sky.lum > 40 && noonF.ground.lum - nightF.ground.lum > 25,
  `Δsky ${(noonF.sky.lum - nightF.sky.lum).toFixed(1)} Δground ${(noonF.ground.lum - nightF.ground.lum).toFixed(1)}`);
// Nothing may crush. A region with a channel pinned at 0 is this repo's signature bug, and the
// night ambient floor exists precisely to prevent it — so it is asserted on the night frame.
check('the night ground is dark but not crushed',
  nightF.ground.lum > 5 && nightF.ground.clip < 0.2,
  `lum ${nightF.ground.lum.toFixed(1)} clipped ${(nightF.ground.clip * 100).toFixed(0)}%`);
check('the night sky is dark but not black',
  nightF.sky.lum > 1.5 && nightF.sky.clip < 0.6,
  `lum ${nightF.sky.lum} clipped ${(nightF.sky.clip * 100).toFixed(0)}% rgb ${nightF.sky.rgb.join()}`);
// Hue is measured as a ratio between two channels of the same pixels — the only way to talk about
// colour without the exposure of the frame getting into the answer. Up here, at the top of the
// dome, the claim is that the night sky is *cooler* than noon's: `golden` only pulls the zenith 18%
// toward GOLD, so a warm sunset lives at the horizon and is measured separately below (that is what
// the first version of this check got wrong — it asserted a warm zenith at 18:00 while the camera
// happened to be facing away from the sun, and read a deep blue 68,67,95).
const warm = (s) => s.rgb[0] / Math.max(1, s.rgb[2]);
check('the night zenith is cooler than noon\'s',
  warm(nightF.sky) < warm(noonF.sky) * 0.6,
  `r/b noon ${warm(noonF.sky).toFixed(2)} night ${warm(nightF.sky).toFixed(2)}`);
check('the sun light itself is dimmed and its direction stays above the horizon',
  noonF.st.sunInt > nightF.st.sunInt * 3 && HOURS.every((h) => frames[h].st.lightY >= 0),
  `intensity ${noonF.st.sunInt} → ${nightF.st.sunInt}, min lightY ${Math.min(...HOURS.map((h) => frames[h].st.lightY))}`);
// The terrain does not go through the DirectionalLight at all (its uSunColor *is* its light term),
// so it needs its own evidence that the value arrived.
check("the terrain's own sun colour changed with the hour",
  noonF.st.ground !== nightF.st.ground && noonF.st.ground !== duskF.st.ground,
  `noon #${noonF.st.ground} dusk #${duskF.st.ground} night #${nightF.st.ground}`);

/* ------------------------------------- the two uniforms that never drew a pixel -- */

// Hide the suspect to prove it is there. `uStars` and `uNight` are the reason this whole round
// exists: forcing either to 0 at midnight has to change the frame, and doing the same at noon has
// to change nothing — the second half is what proves the first is not measuring something else.
console.log('\n=== the star field and the night term, hidden to prove they are there');
const zeroOut = async (uniform, hour) => {
  await p.evaluate((h) => { window.__dlPin(h); }, hour);
  await sleep(1000);
  await p.evaluate(() => window.__dlRender());
  const before = await shoot(`${uniform}-${hour}-on`);
  const was = await p.evaluate((u) => {
    const uu = window.game.world.sky.uniforms[u];
    const old = uu.value;
    uu.value = 0;
    window.__dlRender();
    return old;
  }, uniform);
  await sleep(600);
  await p.evaluate(() => window.__dlRender());
  const after = await shoot(`${uniform}-${hour}-off`);
  await p.evaluate((u, v) => { window.game.world.sky.uniforms[u].value = v; window.__dlRender(); }, uniform, was);
  return { moved: pixelsDiffering(before, after, 4), was };
};
const starsNight = await zeroOut('uStars', 0);
const starsNoon = await zeroOut('uStars', 12);
console.log(`  uStars: midnight ${starsNight.was.toFixed(2)} → 0 moves ${starsNight.moved} px;`
  + ` noon ${starsNoon.was.toFixed(2)} → 0 moves ${starsNoon.moved} px`);
check('at midnight there are stars on screen (zeroing uStars changes the frame)',
  starsNight.moved > 150, `${starsNight.moved} px`);
check('at noon there are none (zeroing it changes nothing)',
  starsNoon.moved < 60, `${starsNoon.moved} px`);
const nightNight = await zeroOut('uNight', 0);
const nightNoon = await zeroOut('uNight', 12);
console.log(`  uNight: midnight ${nightNight.was.toFixed(2)} → 0 moves ${nightNight.moved} px;`
  + ` noon ${nightNoon.was.toFixed(2)} → 0 moves ${nightNoon.moved} px`);
check('the moon is in the night sky (zeroing uNight takes it out)',
  nightNight.moved > 400, `${nightNight.moved} px`);
check('and nothing at noon', nightNoon.moved < 60, `${nightNoon.moved} px`);

/* ---------------------------------------------------- warmth, where the sun is -- */

// 黄昏 has to be *orange*, and orange lives next to the sun. `golden` mixes the horizon colour 55%
// toward GOLD and the zenith only 18%, so this points the camera down the sun's own azimuth —
// atan2(sunDir.x, sunDir.z), i.e. wherever on the compass the sun happens to be at that hour — and
// measures a band a few degrees above the horizon. Two directions of evidence: warmer than the same
// band at noon, and warmer than the same *hour's* zenith, which is the part of the sky facing away.
console.log('\n=== the sunset is warm where the sun actually is');
// 90 m up and level, because at head height in 蒙德 there *is* no visible horizon: the first
// version aimed 6° above the horizontal from the ground and measured rgb(121,133,89) — the hills
// ringing the valley subtend more than 10°. From above the ridge line the band is dome all the way
// across, which is what a claim about the sky's colour needs.
const SUNWARD = { x: 380, y: 240, w: 240, h: 100, label: 'sunward' };
const aimAtSun = async (h) => {
  const st = await p.evaluate((hh) => {
    const g = window.game;
    window.__dlPin(hh);
    const d = g.phase.sunDir;
    const yaw = Math.atan2(d[0], d[2]);
    const me = g.me, cam = g.camera, eye = me.y + 90;
    cam.position.set(me.x, eye, me.z);
    cam.lookAt(me.x + Math.sin(yaw) * 200, eye, me.z + Math.cos(yaw) * 200);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    window.__dlRender();
    return { yaw: +yaw.toFixed(2), elev: g.clock.elev, label: g.clock.label };
  }, h);
  await sleep(1000);
  await p.evaluate(() => window.__dlRender());
  const img = await shoot(`sunward-${String(h).padStart(2, '0')}`);
  return { st, band: rectStats(img, SUNWARD) };
};
const sNoon = await aimAtSun(12), sDusk = await aimAtSun(18), sDawn = await aimAtSun(6);
for (const v of [sNoon, sDusk, sDawn]) {
  console.log(`  ${v.st.label} looking down azimuth ${v.st.yaw} rad at elev ${v.st.elev}°:`
    + ` rgb ${v.band.rgb.join()} lum ${v.band.lum} r/b ${warm(v.band).toFixed(2)}`);
}
check('the sunward band is sky at noon, not a hillside',
  sNoon.band.rgb[2] > sNoon.band.rgb[0] && sNoon.band.lum > 90,
  `rgb ${sNoon.band.rgb.join()} lum ${sNoon.band.lum}`);
check('at 黄昏 the sky beside the sun is warmer than the same sky at noon',
  warm(sDusk.band) > warm(sNoon.band) * 1.4, `r/b ${warm(sDusk.band).toFixed(2)} vs ${warm(sNoon.band).toFixed(2)}`);
check('at 黎明 too', warm(sDawn.band) > warm(sNoon.band) * 1.4,
  `r/b ${warm(sDawn.band).toFixed(2)} vs ${warm(sNoon.band).toFixed(2)}`);
check('and warmer than the part of the sky facing away from it at the same hour',
  warm(sDusk.band) > warm(duskF.sky) * 1.3,
  `sunward ${warm(sDusk.band).toFixed(2)} vs zenith ${warm(duskF.sky).toFixed(2)}`);

// Which term is doing it — asked the way `uStars` and `uNight` are asked, by taking the suspect out.
// The assertion above passed for a whole release on a build with *no directional term at all*: the
// dome's warmth was isotropic and the anti-sun zenith was only cooler because it had been dragged
// 61% toward midnight blue, so "sunward is warmer than away" was measuring the bug that made the
// sunset muddy. With the zenith fixed that ratio fell to 1.27/0.90 and this is the term that carries
// it now, so it gets its own two-sided evidence rather than sharing a threshold with the gradient.
const withoutGolden = async (h) => {
  const on = await aimAtSun(h);
  const was = await p.evaluate(() => {
    const u = window.game.world.sky.uniforms.uGolden, v = u.value;
    u.value = 0;
    window.__dlRender();
    return v;
  });
  await sleep(700);
  await p.evaluate(() => window.__dlRender());
  const off = rectStats(await shoot(`nogolden-${String(h).padStart(2, '0')}`), SUNWARD);
  // Put it back through the product's own path, not by assignment, so the next hour is clean.
  await p.evaluate((hh) => { window.__dlPin(hh); window.__dlRender(); }, h);
  return { was, on: on.band, off };
};
const gDusk = await withoutGolden(18), gNoon = await withoutGolden(12);
console.log(`  uGolden: 18:00 ${gDusk.was.toFixed(2)} → 0 turns rgb ${gDusk.on.rgb.join()} into ${gDusk.off.rgb.join()}`
  + ` (r/b ${warm(gDusk.on).toFixed(2)} → ${warm(gDusk.off).toFixed(2)});`
  + ` 12:00 ${gNoon.was.toFixed(2)} → 0 turns ${gNoon.on.rgb.join()} into ${gNoon.off.rgb.join()}`);
check('the warm band is the shader\'s directional term: zeroing uGolden at 黄昏 takes it out',
  gDusk.was > 0.9 && warm(gDusk.on) > warm(gDusk.off) * 1.35,
  `r/b ${warm(gDusk.on).toFixed(2)} → ${warm(gDusk.off).toFixed(2)} with uGolden ${gDusk.was.toFixed(2)}`);
check('and at noon it is already 0, so forcing it is not a change at all',
  gNoon.was === 0 && gNoon.on.rgb.every((v, i) => Math.abs(v - gNoon.off.rgb[i]) <= 1),
  `uGolden ${gNoon.was} rgb ${gNoon.on.rgb.join()} vs ${gNoon.off.rgb.join()}`);

/* ------------------------------------------------------------ the HUD's clock -- */

console.log('\n=== the clock in the corner');
await p.evaluate(() => window.__dlHud(true));
const readHud = async (h) => {
  await p.evaluate((hh) => { window.__dlPin(hh); }, h);
  // The dial's colour transitions over 420 ms; read after it has landed, or the measurement is the
  // colour the widget is leaving.
  await sleep(900);
  return p.evaluate(() => {
    const el = document.querySelector('[data-f="clockwrap"]');
    const dial = document.querySelector('[data-f="clockdial"]');
    const cs = getComputedStyle(dial);
    return {
      label: document.querySelector('[data-f="clock"]').textContent,
      name: document.querySelector('[data-f="clockname"]').textContent,
      note: document.querySelector('[data-f="clocknote"]').textContent,
      noteHidden: document.querySelector('[data-f="clocknote"]').classList.contains('hidden'),
      title: el.getAttribute('title'),
      bg: cs.backgroundColor,
      opacity: +cs.opacity,
      moon: dial.classList.contains('moon'),
      crescent: getComputedStyle(dial, '::after').boxShadow,
      want: window.game.clock.sunColor.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)),
      elev: window.game.clock.elev,
    };
  });
};
const hudNoon = await readHud(12), hudNight = await readHud(0), hudDusk = await readHud(18);
for (const [h, v] of [[12, hudNoon], [0, hudNight], [18, hudDusk]]) {
  console.log(`  ${String(h).padStart(2, '0')}:00 -> "${v.label}" ${v.name} ${v.note} dial ${v.bg} @${v.opacity}`
    + ` moon=${v.moon} title="${v.title}"`);
}
check('the clock prints the hour it was pinned to',
  hudNoon.label === '12:00' && hudNight.label === '00:00' && hudDusk.label === '18:00',
  `${hudNoon.label} ${hudNight.label} ${hudDusk.label}`);
check('and names it',
  hudNoon.name === '正午' && hudNight.name === '夜晚' && hudDusk.name === '黄昏',
  `${hudNoon.name} ${hudNight.name} ${hudDusk.name}`);
check('a pinned clock says so instead of pretending to run',
  hudNoon.note === '时间已固定' && hudNoon.noteHidden === false, `"${hudNoon.note}"`);
// Style, not class: a widget whose classList is right and whose pixels are grey is still wrong.
const rgbOf = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
check("the dial is painted the sky's own sun colour",
  rgbOf(hudNoon.bg).every((v, i) => Math.abs(v - hudNoon.want[i]) <= 2),
  `${hudNoon.bg} vs sunColor ${hudNoon.want.join()}`);
check('and it is a different colour at midnight, not just a different class',
  rgbOf(hudNight.bg).some((v, i) => Math.abs(v - rgbOf(hudNoon.bg)[i]) > 25)
  && hudNight.opacity < hudNoon.opacity - 0.2,
  `${hudNoon.bg} @${hudNoon.opacity} → ${hudNight.bg} @${hudNight.opacity}`);
check('the night dial is a crescent and the day dial is not',
  hudNight.moon === true && /\d/.test(hudNight.crescent) && hudNoon.moon === false,
  `night "${hudNight.crescent}" / day moon=${hudNoon.moon}`);
check("the tooltip carries the sun's elevation, and it moves",
  /太阳高度/.test(hudNoon.title) && hudNoon.elev > 40 && hudNight.elev < -40
  && Math.abs(hudDusk.elev) <= 1,
  `noon ${hudNoon.elev}° dusk ${hudDusk.elev}° night ${hudNight.elev}°`);

/* --------------------------------------------------- indoor zones do not move -- */

// Half the art gates photograph 深渊试炼场 / 冰封洞窟 / 黄金屋, which are underground: their vault
// shader has no sun in it and `World.applyDaylight` returns early. That claim needs both sides —
// the cave must not move, *and* the same pair of hours on the surface must move a lot, or "no
// change" would be equally true of a build where the clock never reached the renderer.
console.log('\n=== underground, the sky does not move');
const pairDiff = async (zone, tag) => {
  const ok = await p.evaluate(async (z) => {
    const g = window.game;
    g.start?.();
    await g.enterZone(z, { x: 0, z: 40 });
    await new Promise((r) => setTimeout(r, 6000));
    g.stop();
    window.__dlHud(false);
    return g.zoneId === z && g.quality === 'high';
  }, zone);
  if (!ok) return null;
  await p.evaluate(() => { window.__dlPin(12); });
  await sleep(1500);
  await p.evaluate(() => window.__dlRender());
  const a = await shoot(`${tag}-noon`);
  await p.evaluate(() => { window.__dlPin(0); });
  await sleep(1500);
  await p.evaluate(() => window.__dlRender());
  const c = await shoot(`${tag}-midnight`);
  return pixelsDiffering(a, c, 6);
};
// Cave first, surface second, so the run ends with the shared guest account standing outdoors —
// the next probe to boot this token inherits the zone, and that is how this section's own frames
// ended up underground once already.
const indoorMoved = await pairDiff('abyssTrial', 'cave');
const outdoorMoved = await pairDiff('mondstadt', 'surface');
console.log(`  noon vs midnight: 蒙德 ${outdoorMoved} px, 深渊试炼场 ${indoorMoved} px of ${W * H}`);
if (outdoorMoved === null || indoorMoved === null) skipped('indoor immunity', 'a zone transition did not take');
else {
  check('on the surface the two hours are different pictures',
    outdoorMoved > 20000, `${outdoorMoved} px`);
  check('underground they are the same picture',
    indoorMoved < 2000, `${indoorMoved} px`);
}

/* ------------------------------------------------------------------- tally -- */

console.log(`\nerrors -> ${errs.length ? errs.slice(0, 4).join(' | ') : 'none'}`);
console.log(`hmr    -> ${hmr.length ? hmr.length : 'none'}`);
check('no page errors while the sun moved', errs.length === 0, errs.slice(0, 2).join(' | '));
check('client/src was not hot-updated mid-run', hmr.length === 0, `${hmr.length} HMR events`);

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
console.log(`shots -> ${outDir}`);
await b.close();
process.exit(fail === 0 && pass >= 90 ? 0 : 1);
