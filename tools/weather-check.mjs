// 天气门禁: the forecast, and the particle system that had one authored state per zone.
//
// Why this probe exists. Before `shared/src/world/weather.js`, `zone.weather` was a constant: 蒙德
// was clear forever, 龙脊雪山 snowed forever, and `client/src/audio/audio.js` chose its wind bed
// with `this.zone?.weather === 'blizzard'` — a **string compared to an object**, because
// `zone.weather` is `{ type, windSpeed, cloudiness }`. Both branches of that condition were
// unreachable, which is the same defect as a uniform with no producer, only quieter: nothing was
// missing, nothing threw, and the cold thin wind simply never played anywhere.
//
// Four parts, the same shape as `daylight-check.mjs`, because it is the same kind of feature — a
// pure function of epoch milliseconds that every client derives independently:
//
//  1. **The vocabulary** (no browser). Six types, what each one means, and the words the HUD
//     prints. Both directions: no type may be unreachable from the authored forecasts, and no
//     forecast may name a type that does not exist.
//
//  2. **Day 0 is the authored zone, for the whole day** (no browser). ~500 calibrated pixel
//     assertions across the visual suite stand on each zone's authored `weather`/`sky` block, and
//     every one of those probes pins an hour — a pin is day 0. So day 0 has to return the authored
//     numbers `===`, at every hour of the day, for all six zones. This is the assertion that lets a
//     weather system exist in a repo full of calibrated thresholds.
//
//  3. **The sweep** (no browser). Twelve days at one in-game minute per step for every zone:
//     ranges, no jumps (a storm arrives over 30 real seconds, it does not pop), the day boundary
//     held continuous, precipitation type agreeing with intensity, indoor zones never leaving
//     `none`, and the sheer-cold coupling bounded from *both* sides — a blizzard has to hurt, and a
//     campfire has to still win.
//
//  4. **Pixels** (browser). Wiring proves the numbers arrive. The same hour on two different
//     forecast days is the cleanest A/B this repo has: identical sun, identical camera, one rainy
//     and one clear. Plus hide-the-suspect on the particle cloud against a measured noise floor
//     (llvmpipe renders grass and water in motion, so "the frame changed" needs a control that says
//     how much it changes when nothing changed), the HUD chip read as text *and* as style, and an
//     indoor zone which must not move at all.
//
// Method notes: quality pinned to `high`, loop stopped and frames rendered by hand, the HUD hidden
// for world shots, and the run ends outdoors in 蒙德 because a boot resumes the saved zone.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { DAY_MS } from '../shared/src/world/daylight.js';
import {
  RAMP_H, WEATHER_TYPES, STORM_RANK, baseWeather, weatherAt, weatherDay, weatherName, maxStorm,
} from '../shared/src/world/weather.js';
import { ZONES, ZONE_IDS } from '../shared/src/data/zones.js';
import { zoneGateReport } from '../shared/src/data/zoneGate.js';
import { decodePng, rectStats, pixelsDiffering } from './lib/png.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/weather'; })();
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

/** An epoch that lands on a given forecast day and hour. Exactly what `game.setWorldTime` builds. */
const at = (day, hour) => (day + hour / 24) * DAY_MS;
const OUTDOOR = ZONE_IDS.filter((z) => !ZONES[z].indoor);
const INDOOR = ZONE_IDS.filter((z) => ZONES[z].indoor);

/* -------------------------------------------------------- 1. the vocabulary -- */

console.log('=== the vocabulary');
check('six types, and every one is fully specified',
  Object.keys(WEATHER_TYPES).length === 6 && Object.values(WEATHER_TYPES).every((t) => (
    typeof t.name === 'string' && t.name.length > 0
    && t.cloud >= 0 && t.cloud <= 1 && t.wind > 0 && t.fog >= 1
    && t.sev >= 0 && t.sev <= 1 && typeof t.precip === 'boolean'
  )), Object.keys(WEATHER_TYPES).join(' '));
check('exactly the three wet types precipitate',
  Object.entries(WEATHER_TYPES).filter(([, t]) => t.precip).map(([k]) => k).join() === 'rain,snow,blizzard',
  Object.entries(WEATHER_TYPES).filter(([, t]) => t.precip).map(([k]) => k).join());
// An ordering, not three loose numbers: a blizzard that were less severe than snow would make the
// worst weather in the game the *safest*, and nothing else in the file would notice.
check('a blizzard is the worst of everything',
  ['sev', 'cloud', 'wind', 'fog'].every((f) => Object.entries(WEATHER_TYPES)
    .every(([k, t]) => k === 'blizzard' || t[f] <= WEATHER_TYPES.blizzard[f])),
  `sev ${WEATHER_TYPES.blizzard.sev} wind ${WEATHER_TYPES.blizzard.wind} fog ${WEATHER_TYPES.blizzard.fog}`);
check('and snow is worse than rain, which is worse than cloud',
  WEATHER_TYPES.snow.sev > WEATHER_TYPES.rain.sev && WEATHER_TYPES.rain.sev > WEATHER_TYPES.cloudy.sev
  && WEATHER_TYPES.clear.sev === 0 && WEATHER_TYPES.none.sev === 0);
check('a ramp is half an in-game hour, which is 30 real seconds',
  RAMP_H === 0.5 && (RAMP_H / 24) * DAY_MS === 30_000, `${(RAMP_H / 24) * DAY_MS} ms`);

console.log('\n=== the words the HUD prints');
const namesOf = (t) => [0.1, 0.4, 0.9].map((k) => weatherName(t, k));
for (const t of ['rain', 'snow']) console.log(`  ${t.padEnd(9)} ${namesOf(t).join(' / ')}`);
check('rain and snow each read as three different strengths',
  new Set(namesOf('rain')).size === 3 && new Set(namesOf('snow')).size === 3,
  `${namesOf('rain').join('/')} ${namesOf('snow').join('/')}`);
check('rain and snow never share a word',
  namesOf('rain').every((n) => !namesOf('snow').includes(n)));
check('a dry type is just its own name',
  weatherName('clear', 1) === WEATHER_TYPES.clear.name && weatherName('cloudy', 0.5) === '多云'
  && weatherName('none', 1) === WEATHER_TYPES.none.name);
check('and an unknown type degrades instead of throwing',
  weatherName('hurricane', 1) === WEATHER_TYPES.none.name, weatherName('hurricane', 1));

// Both directions, over the authored data: every type the forecasts use exists, and every type in
// the vocabulary is actually reachable — a preset nobody can ever see is dead data with a name.
console.log('\n=== the vocabulary and the forecasts agree, both ways');
const used = new Set();
for (const z of ZONE_IDS) {
  used.add(baseWeather(ZONES[z]).type);
  for (const pat of ZONES[z].forecast || []) for (const s of pat.seg || []) if (s.type) used.add(s.type);
}
check('no forecast names a type that does not exist',
  [...used].every((t) => WEATHER_TYPES[t]), [...used].join(' '));
check('and no type in the vocabulary is unreachable',
  Object.keys(WEATHER_TYPES).every((t) => used.has(t)),
  `used ${[...used].sort().join(' ')}`);
check('the zone data gate is clean', zoneGateReport().length === 0, zoneGateReport().join(' | '));

/* ------------------------------------------------ 2. day 0 is the authored zone -- */

console.log('\n=== day 0 is the authored weather, bit for bit, all day');
for (const id of ZONE_IDS) {
  const z = ZONES[id], base = baseWeather(z);
  // Every hour of the day, not just noon: a forecast that leaked into day 0 at 03:00 would be
  // invisible to a probe that only checks 12:00, and `tour` shoots dawn in one zone.
  const drift = [];
  for (let m = 0; m < 24 * 60; m += 7) {
    const w = weatherAt(z, at(0, m / 60));
    if (w.type !== base.type || w.intensity !== base.intensity || w.cloudiness !== base.cloudiness
      || w.windSpeed !== base.windSpeed || w.fogDensity !== base.fogDensity || w.coldMul !== 1) {
      drift.push(`${(m / 60).toFixed(2)}h ${w.type} ${w.intensity}`);
    }
  }
  const noon = weatherAt(z, at(0, 12));
  console.log(`  ${id.padEnd(13)} ${noon.type.padEnd(8)} i ${noon.intensity} cloud ${noon.cloudiness}`
    + ` wind ${noon.windSpeed} fog ${noon.fogDensity} cold ×${noon.coldMul} "${noon.name}" / ${noon.dayName}`);
  check(`${id}: day 0 never moves off the authored block`, drift.length === 0,
    drift.slice(0, 3).join(' | ') || `${24 * 60 / 7 | 0} samples identical`);
  check(`${id}: and the block is the one zones.js authored`,
    noon.cloudiness === (z.weather?.cloudiness ?? WEATHER_TYPES[base.type].cloud)
    && noon.windSpeed === (z.weather?.windSpeed ?? WEATHER_TYPES[base.type].wind)
    && noon.fogDensity === (z.sky?.fogDensity ?? 0.008)
    && noon.type === (WEATHER_TYPES[z.weather?.type] ? z.weather.type : 'none'),
    `cloud ${noon.cloudiness} wind ${noon.windSpeed} fog ${noon.fogDensity}`);
  check(`${id}: day 0 costs the sheer cold nothing`, noon.coldMul === 1, `×${noon.coldMul}`);
}
// A pin is day 0 only because `setWorldTime` builds its epoch from the pinned hour alone. If that
// ever changes, this line is the one that says so.
check('an epoch inside the first day is day index 0, and a negative one is not a later day',
  weatherDay(at(0, 23.99)) === 0 && weatherDay(-1) < 0 && weatherDay(at(3, 0.5)) === 3,
  `${weatherDay(at(0, 23.99))} / ${weatherDay(-1)} / ${weatherDay(at(3, 0.5))}`);
check('and a time before the epoch is still the baseline rather than a crash',
  weatherAt(ZONES.mondstadt, -DAY_MS * 2.5).type === baseWeather(ZONES.mondstadt).type
  && weatherAt(ZONES.mondstadt, -DAY_MS * 2.5).coldMul === 1);

console.log('\n=== the same instant always gives the same weather');
const t0 = Date.UTC(2026, 8, 7, 4, 12, 9, 500);
const a1 = weatherAt(ZONES.dragonspine, t0), a2 = weatherAt(ZONES.dragonspine, t0);
check('two callers with the same epoch ms agree on every key',
  Object.keys(a1).every((k) => a1[k] === a2[k]), JSON.stringify(a1).slice(0, 110));
// Four authored patterns, so four days later is the same pattern at the same hour. That is what
// makes a forecast something a player can learn instead of noise.
check('the forecast is a cycle: four days later is the same weather',
  ['mondstadt', 'dragonspine', 'liyue'].every((z) => {
    const n = ZONES[z].forecast.length;
    const x = weatherAt(ZONES[z], at(2, 15)), y = weatherAt(ZONES[z], at(2 + n, 15));
    return x.type === y.type && Math.abs(x.intensity - y.intensity) < 1e-12 && x.dayName === y.dayName;
  }), `cycle lengths ${['mondstadt', 'dragonspine', 'liyue'].map((z) => ZONES[z].forecast.length).join()}`);

/* --------------------------------------------------------------- 3. the sweep -- */

console.log('\n=== twelve days, one in-game minute per step');
const STEPS = 24 * 60;                 // one in-game minute; a ramp is 30 of them
const DAYS = 12;
for (const id of ZONE_IDS) {
  const z = ZONES[id], base = baseWeather(z);
  const seen = new Set();
  let maxJump = { i: 0, c: 0, f: 0 }, bad = [], coldMax = 1, prev = null, fogMin = Infinity, fogMax = 0;
  let windMax = 0, boundary = 0;
  for (let d = 1; d <= DAYS; d++) {
    for (let s = 0; s <= STEPS; s++) {
      const w = weatherAt(z, at(d, (s * 24) / STEPS));
      seen.add(w.type);
      if (!WEATHER_TYPES[w.type]) bad.push(`unknown type ${w.type}`);
      if (w.intensity < 0 || w.intensity > 1) bad.push(`intensity ${w.intensity}`);
      if (w.cloudiness < 0 || w.cloudiness > 1) bad.push(`cloudiness ${w.cloudiness}`);
      if (w.fogDensity <= 0) bad.push(`fogDensity ${w.fogDensity}`);
      if (w.coldMul < 1) bad.push(`coldMul ${w.coldMul}`);
      // A number the HUD prints has to mean something in the zone it is printed in. 蒙德's
      // downpour reported ×1.09 and the chip's tooltip said 严寒加剧 — in a valley with no 严寒.
      if (!z.mechanic?.sheerCold && w.coldMul !== 1) bad.push(`coldMul ${w.coldMul} with no 严寒`);
      // Intensity and type have to tell the same story. `precipType` exists so a shower's last
      // 30 seconds keep falling after the segment ended; the failure it guards against is the
      // mirror image — particles drawn by a type that cannot precipitate, or a wet type drawing
      // nothing at all.
      if (w.intensity > 0.02 && !WEATHER_TYPES[w.type].precip) bad.push(`${w.type} at i=${w.intensity.toFixed(2)}`);
      if (w.intensity <= 0.02 && WEATHER_TYPES[w.type].precip && !WEATHER_TYPES[base.type].precip) {
        bad.push(`dry ${w.type} at ${(s * 24 / STEPS).toFixed(2)}h d${d}`);
      }
      fogMin = Math.min(fogMin, w.fogDensity); fogMax = Math.max(fogMax, w.fogDensity);
      windMax = Math.max(windMax, w.windSpeed); coldMax = Math.max(coldMax, w.coldMul);
      if (prev) {
        maxJump.i = Math.max(maxJump.i, Math.abs(w.intensity - prev.intensity));
        maxJump.c = Math.max(maxJump.c, Math.abs(w.cloudiness - prev.cloudiness));
        maxJump.f = Math.max(maxJump.f, Math.abs(w.fogDensity - prev.fogDensity) / prev.fogDensity);
        if (s === 0) boundary = Math.max(boundary, Math.abs(w.intensity - prev.intensity));
      }
      prev = w;
    }
  }
  console.log(`  ${id.padEnd(13)} types {${[...seen].join(' ')}} jump i ${maxJump.i.toFixed(4)}`
    + ` c ${maxJump.c.toFixed(4)} fog ${(maxJump.f * 100).toFixed(2)}% | fog ${fogMin}..${fogMax}`
    + ` wind ≤${windMax.toFixed(1)} cold ≤×${coldMax.toFixed(3)} | day seam Δi ${boundary.toFixed(4)}`);
  check(`${id}: every value stays inside its range for ${DAYS} days`, bad.length === 0,
    bad.slice(0, 3).join(' | ') || `${DAYS * STEPS} samples`);
  // 1/30 per step is exactly a full 0→1 ramp; anything much above that is a pop.
  check(`${id}: nothing jumps — a change takes ${RAMP_H} h, not a frame`,
    maxJump.i <= 0.036 && maxJump.c <= 0.036 && maxJump.f <= 0.06,
    `Δi ${maxJump.i.toFixed(4)} Δcloud ${maxJump.c.toFixed(4)} Δfog ${(maxJump.f * 100).toFixed(2)}%`);
  // The one seam a derived forecast can tear at: 00:00 reads the *previous* day's last segment as
  // the outgoing state. 璃月's 夜雨 deliberately ends mid-storm to exercise it.
  check(`${id}: midnight is continuous across the forecast day boundary`, boundary <= 0.036,
    `Δintensity ${boundary.toFixed(4)}`);
  check(`${id}: the fog never leaves a believable multiple of the zone's own`,
    fogMin >= base.fogDensity - 1e-12 && fogMax <= base.fogDensity * 2.5 + 1e-12,
    `${fogMin} .. ${fogMax} on a base of ${base.fogDensity}`);
  check(`${id}: the buffer allocated for this zone can hold everything it will ever draw`,
    [...seen].every((t) => STORM_RANK[t] <= STORM_RANK[maxStorm(z)]),
    `maxStorm ${maxStorm(z)} covers {${[...seen].join(' ')}}`);
}

console.log('\n=== underground there is no weather at all');
for (const id of INDOOR) {
  let off = [];
  for (let d = 0; d <= DAYS; d++) {
    for (const h of [0, 3.2, 10.5, 15, 21.7]) {
      const w = weatherAt(ZONES[id], at(d, h));
      if (w.type !== 'none' || w.intensity !== 0 || w.coldMul !== 1) off.push(`d${d} ${h}h ${w.type}`);
    }
  }
  check(`${id}: 'none', every hour of every day`, off.length === 0, off.slice(0, 3).join(' | '));
  check(`${id}: and it is not allocated a particle buffer`, maxStorm(ZONES[id]) === 'none',
    maxStorm(ZONES[id]));
}
check('every indoor zone is one of the three dungeons, so this claim covers them',
  INDOOR.length === 3 && OUTDOOR.length === 3, `${INDOOR.join()} / ${OUTDOOR.join()}`);

console.log('\n=== allocation: the heaviest storm each zone can reach');
for (const id of ZONE_IDS) console.log(`  ${id.padEnd(13)} ${maxStorm(ZONES[id])}`);
check('蒙德 allocates for rain even though its baseline is dry',
  maxStorm(ZONES.mondstadt) === 'rain', maxStorm(ZONES.mondstadt));
check('龙脊雪山 allocates for a blizzard', maxStorm(ZONES.dragonspine) === 'blizzard');
check('璃月 allocates for rain', maxStorm(ZONES.liyue) === 'rain');

/* ---------------------------------------------- the sheer cold, from both sides -- */

// The gameplay consumer. `zoneInstance.js` multiplies the cold rate by this exact `coldMul`, which
// is why the number the HUD shows and the number that kills you cannot drift apart. Bounded from
// both sides: a blizzard has to be worse than a normal snowfall, and a campfire has to still win —
// weather that outruns its own counterplay is not difficulty, it is a wall.
console.log('\n=== 严寒 scales with the storm, and a fire still beats the worst of it');
const mech = ZONES.dragonspine.mechanic;
const drain = (mul) => mech.coldRate * mul * 0.35;         // the expression zoneInstance.js uses
const recover = mech.coldRate * 2.5;
const worst = (() => {
  let m = 1;
  for (let d = 1; d <= DAYS; d++) for (let s = 0; s <= STEPS; s++) {
    m = Math.max(m, weatherAt(ZONES.dragonspine, at(d, (s * 24) / STEPS)).coldMul);
  }
  return m;
})();
console.log(`  baseline ×1 → ${drain(1).toFixed(2)} cold/s (${(100 / drain(1)).toFixed(0)} s to freeze)`
  + ` | worst ×${worst.toFixed(3)} → ${drain(worst).toFixed(2)}/s (${(100 / drain(worst)).toFixed(0)} s)`
  + ` | a fire recovers ${recover.toFixed(1)}/s`);
check('the baseline zone is untouched by the feature',
  weatherAt(ZONES.dragonspine, at(0, 12)).coldMul === 1);
check('a blizzard is meaningfully colder than the zone at rest',
  worst > 1.15 && worst <= 1.5, `×${worst.toFixed(3)}`);
check('but freezing still takes long enough to walk out of', 100 / drain(worst) > 45,
  `${(100 / drain(worst)).toFixed(0)} s`);
check('and a campfire beats the worst storm several times over', recover > drain(worst) * 4,
  `${recover.toFixed(1)}/s vs ${drain(worst).toFixed(2)}/s`);
check('the sim reads the same function, not a copy of the numbers',
  /weatherAt\(this\.zone, Date\.now\(\)\)\.coldMul/.test(fs.readFileSync('shared/src/world/zoneInstance.js', 'utf8')),
  'zoneInstance.js');

/* --------------------------------------------- every key returned has a reader -- */

// The mirror of the bug at the top of this file. A string compared to an object is a *consumer*
// with no producer; a key nobody reads is a producer with no consumer. Both are silent, so both
// directions are scanned.
console.log('\n=== every value returned has a named reader');
const READERS = [
  'client/src/gfx/sky.js', 'client/src/game/world.js', 'client/src/game/game.js',
  'client/src/ui/hud.js', 'client/src/audio/audio.js', 'shared/src/world/zoneInstance.js',
];
// Comments are stripped before scanning. The first version's "nothing compares zone.weather to a
// string any more" assertion went red on the *comment* in audio.js that records the old bug — a
// scan that cannot tell code from prose would have forced the explanation out of the file.
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const src = Object.fromEntries(READERS.map((f) => [f, strip(fs.readFileSync(f, 'utf8'))]));
const KEYS = Object.keys(weatherAt(ZONES.mondstadt, at(2, 15)));
const noReader = [];
for (const k of KEYS) {
  // `w.key` (the renderer and the HUD), `wx?.key` (the audio bed's local), or the direct
  // `weatherAt(...).key` the sim uses so it can never hold a stale copy.
  const re = new RegExp(`\\b(w|wx|weather)\\??\\.${k}\\b|weatherAt\\([^)]*\\)\\.${k}\\b`);
  const who = READERS.filter((f) => re.test(src[f]));
  if (!who.length) noReader.push(k); else console.log(`  ${k.padEnd(11)} ${who.map((f) => f.split('/').pop()).join(' ')}`);
}
check('no value is returned that nobody reads', noReader.length === 0, noReader.join(' '));
const unknown = [];
for (const f of READERS) {
  for (const m of src[f].matchAll(/\bw\.([a-zA-Z]+)\b/g)) {
    if (!KEYS.includes(m[1]) && !unknown.includes(`${f.split('/').pop()}:${m[1]}`)) {
      unknown.push(`${f.split('/').pop()}:${m[1]}`);
    }
  }
}
check('and nothing reads a value that is not returned', unknown.length === 0, unknown.join(' '));
// The specific dead comparison this round removed. It has to stay removed.
check('nothing compares zone.weather to a string any more',
  !/weather\s*===\s*'/.test(src['client/src/audio/audio.js'])
  && /wx\?\.type/.test(src['client/src/audio/audio.js'])
  && /this\.weather/.test(src['client/src/audio/audio.js']),
  'audio.js');

if (NO_BROWSER) {
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped (no browser)`);
  process.exit(fail === 0 ? 0 : 1);
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

// Helpers installed once. `__wxPin(day, hour)` is the product's own path — `setWorldTime` — so a
// probe cannot pass on a build where the pin does not reach the weather.
await p.evaluate(() => {
  const g = window.game;
  window.__wxHud = (on) => {
    for (const el of document.querySelectorAll('[data-hud], #world-overlay')) el.style.visibility = on ? '' : 'hidden';
  };
  window.__wxRender = () => { for (let i = 0; i < 3; i++) g.r.render(0.016); };
  window.__wxPin = (day, hour) => {
    const ok = g.setWorldTime(hour, day);
    window.__wxRender();
    return ok;
  };
  window.__wxSkyCam = (yaw) => {
    // 150 m up and tilted 8° above the horizontal. At head height in 蒙德 there is no visible
    // horizon — the hills ringing the valley subtend more than 10° — so a "sky" band at the top of
    // the walking frame is part ridge, and a ridge that darkens with the storm as much as the sky
    // does hides the very thing being measured. 90 m and level was still not enough: the band read
    // rgb(185,198,192), green over blue, and its own validation assertion said so.
    const me = g.me, cam = g.camera, eye = me.y + 150, up = Math.tan(8 * Math.PI / 180) * 200;
    cam.fov = 55;
    cam.position.set(me.x, eye, me.z);
    cam.lookAt(me.x + Math.sin(yaw) * 200, eye + up, me.z + Math.cos(yaw) * 200);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  };
  // A vista: 24 m up and 7.4° down, which is the only camera in this probe that holds ground at
  // arm's length *and* ground 200 m out in the same frame. Aerial perspective is a claim about two
  // distances, so it cannot be measured from a camera that only has one.
  window.__wxVista = (yaw) => {
    const me = g.me, cam = g.camera, eye = me.y + 24;
    cam.fov = 55;
    cam.position.set(me.x, eye, me.z);
    cam.lookAt(me.x + Math.sin(yaw) * 200, eye - 26, me.z + Math.cos(yaw) * 200);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  };
  // What a rect is actually looking at: five rays through it, each answering "how far, and is it
  // the ground?". The terrain is chunked meshes sharing one material, so the subject is identified
  // by `material ===` and not by object identity. The sky dome and the *precipitation mesh* are
  // both skipped — a ray through a rainstorm otherwise hits a raindrop 2 m from the lens and
  // reports the distant hillside as a 2.1 m prop, which is exactly what the first run of this
  // measurement did.
  window.__wxRectSubject = async (r, vw, vh) => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const out = [];
    for (const [fx, fy] of [[0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7], [0.5, 0.5]]) {
      const ndcX = ((r.x + r.w * fx) / vw) * 2 - 1, ndcY = 1 - ((r.y + r.h * fy) / vh) * 2;
      const ray = g._pointerRay({ ndcX, ndcY });
      const rc = new THREE.Raycaster(); rc.ray.copy(ray.ray || ray); rc.far = 1e6;
      const hit = rc.intersectObjects(g.scene.children, true).find((h) => h.object !== g.world.sky.mesh
        && h.object !== g.world.weather.mesh && h.object.visible && h.distance > 0.5);
      out.push(hit ? { d: +hit.distance.toFixed(1), t: hit.object.material === g.world.terrain.material } : null);
    }
    return out;
  };
  // The precipitation, taken out of the frame. The atmosphere section below measures the *ground's*
  // air at two depths, and 4000 additive snow points falling through the near rect move that rect's
  // own saturation by tens of percent between two otherwise identical frames — a wander much wider
  // than the ~2% the fog itself puts there at 38 m, which made a true reading unmeasurable. So those
  // readings are taken with the snow hidden. That the snow is drawn at all is a different claim,
  // made by the hide-the-rain section against its own measured floor.
  window.__wxPrecip = (on) => {
    const m = g.world.weather.mesh;
    if (!m) return null;
    const was = m.visible;
    m.visible = on;
    return was;
  };
  // The three places the air's density lives. They are three because the renderer only fogs the
  // meshes it owns the material of: the ground and the water fog themselves in their own shaders.
  window.__wxFog = () => ({
    ground: +g.world.terrain.uniforms.uFogDensity.value.toFixed(6),
    scene: g.scene.fog ? +g.scene.fog.density.toFixed(6) : -1,
    water: g.world.water ? +g.world.water.material.uniforms.uFogDensity.value.toFixed(6) : null,
    // The colour the air is, in the same 8-bit sRGB the screenshots are read in — `getHexString()`
    // converts out of three's working space, which the raw `.r/.g/.b` would not.
    fogHex: g.scene.fog ? g.scene.fog.color.getHexString() : null,
  });
  window.__wxAim = (yaw) => {
    // Head height, 5° up: the top of the frame is sky (where cloudiness lives), the bottom is
    // ground within ten metres, and the middle is the 44 m particle box the storm falls inside.
    const me = g.me, cam = g.camera, up = Math.tan(5 * Math.PI / 180) * 30;
    cam.fov = 55;
    cam.position.set(me.x, me.y + 3.0, me.z);
    cam.lookAt(me.x + Math.sin(yaw) * 30, me.y + 3.0 + up, me.z + Math.cos(yaw) * 30);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  };
  window.__wxState = () => {
    const wz = g.world.weather, sky = g.world.sky;
    return {
      zone: g.zoneId, indoor: !!g.world.zone.indoor, quality: g.quality, running: g._running,
      hour: g.clock.label, day: g.weather.dayIndex, dayName: g.weather.dayName,
      type: g.weather.type, intensity: +g.weather.intensity.toFixed(4), name: g.weather.name,
      coldMul: +g.weather.coldMul.toFixed(4),
      // What the renderer is actually doing with those numbers.
      drawn: wz.mesh ? wz.mesh.geometry.drawRange.count : -1,
      alloc: wz.mesh ? wz.count : -1,
      opacity: wz.mesh ? +wz.material.uniforms.uOpacity.value.toFixed(3) : -1,
      windU: wz.mesh ? +wz.material.uniforms.uWind.value.x.toFixed(2) : -1,
      speed: wz.mesh ? +wz.material.uniforms.uSpeed.value.toFixed(2) : -1,
      maxPx: wz.mesh ? wz.material.uniforms.uMaxPx.value : -1,
      additive: wz.mesh ? wz.material.blending === 2 : null,   // 2 = THREE.AdditiveBlending
      // The two terms that must be exactly 0 and 1 on day 0, or every calibrated pixel gate in the
      // suite is measuring a frame the authored zone never shows.
      storm: +sky.uniforms.uStorm.value.toFixed(4),
      dim: +sky.stormDim.toFixed(4),
      sunInt: +sky.sun.intensity.toFixed(3),
      groundSun: g.world.terrain.uniforms.uSunColor.value.getHexString(),
      cloudiness: +sky.uniforms.uCloudiness.value.toFixed(4),
      windSpeed: +sky.uniforms.uWindSpeed.value.toFixed(3),
      fog: g.scene.fog ? +g.scene.fog.density.toFixed(6) : -1,
    };
  };
});

// Into 蒙德 explicitly: a boot resumes the saved zone, and this probe's last world section is a cave.
await p.evaluate(async () => {
  await window.game.enterZone('mondstadt', { x: 0, z: 14 });
  await new Promise((r) => setTimeout(r, 6000));
});
await p.evaluate(() => { const g = window.game; g.stop(); window.__wxAim(0.6); });

// Render, wait a beat, render again, *then* capture. A screenshot returns the last frame the
// browser's compositor has, which is not necessarily the last one WebGL drew — so a single render
// after a camera move can be missed entirely and the shot is of the previous camera. That is not
// hypothetical: the dome section below moves to a camera 150 m up, and for as long as this probe has
// existed its first shot was silently the *walking* camera's frame. It passed anyway, because the
// band it measures happened to be sky in both, and it only started failing when a fog change
// repainted the hillside that was in the rect. Two renders and 250 ms per shot removes the class.
const shoot = async (file) => {
  await p.evaluate(() => window.__wxRender());
  await sleep(250);
  await p.evaluate(() => window.__wxRender());
  await p.screenshot({ path: `${outDir}/${file}.png` });
  return decodePng(fs.readFileSync(`${outDir}/${file}.png`));
};
const SKY = { x: 330, y: 20, w: 340, h: 110, label: 'sky' };
const MID = { x: 200, y: 200, w: 600, h: 300, label: 'mid' };

const boot = await p.evaluate(() => window.__wxState());
console.log(`\n=== frames in ${boot.zone} @ ${boot.quality}`);
check('the frames are shot outdoors, in the zone this probe asked for',
  boot.zone === 'mondstadt' && boot.indoor === false, `${boot.zone} indoor=${boot.indoor}`);
check('the tier is pinned high', boot.quality === 'high', boot.quality);
check('the loop is stopped, so two shots share one camera', boot.running === false);
// The rain buffer is pooled up-front and the *drawn* count follows the weather. A boot lands on
// whatever forecast day the clock is on — this failed once at 午后骤雨 (drawn 2101), which is the
// system working — so pin a dry day and prove it is dry before reading the count. The wet half of
// the pair is asserted below (3600/4000 at 午后骤雨).
const dry = await p.evaluate(async () => {
  const ok = window.__wxPin(3, 15);
  await new Promise((r) => setTimeout(r, 1200));
  window.__wxRender();
  return { ok, ...window.__wxState() };
});
check('a dry forecast day could be pinned, so the count below is read in clear weather',
  dry.ok === true && dry.type === 'clear' && dry.intensity === 0,
  `day 3 → ${dry.dayName} ${dry.type} i ${dry.intensity}`);
check('蒙德 allocates its rain buffer up front, not when the first drop falls',
  dry.alloc > 500, `allocated ${dry.alloc}`);
check('...and draws none of it while the weather is clear',
  dry.drawn === 0, `drawing ${dry.drawn} at ${dry.dayName}`);

/** Pin a forecast day+hour, let the page settle, render by hand, shoot. */
const frame = async (day, hour, tag) => {
  const ok = await p.evaluate((d, h) => window.__wxPin(d, h), day, hour);
  await sleep(1200);
  await p.evaluate(() => window.__wxRender());
  const st = await p.evaluate(() => window.__wxState());
  const img = await shoot(tag);
  console.log(`  d${day} ${st.hour} ${String(st.dayName).padEnd(6)} ${st.type.padEnd(6)} i ${st.intensity}`
    + ` "${st.name}" drawn ${st.drawn}/${st.alloc} op ${st.opacity} wind ${st.windU} | cloud ${st.cloudiness}`
    + ` skywind ${st.windSpeed} fog ${st.fog} cold ×${st.coldMul} | uStorm ${st.storm} dim ${st.dim}`
    + ` sun ${st.sunInt} ground #${st.groundSun}`);
  check(`d${day} ${hour}:00 — the pin was accepted and the clock and the forecast day both moved`,
    ok === true && st.day === day && st.hour === `${String(hour).padStart(2, '0')}:00`,
    `day ${st.day} hour ${st.hour}`);
  return { img, st, sky: rectStats(img, SKY), mid: rectStats(img, MID) };
};

// The A/B: 15:00 on 蒙德's rainy day (午后骤雨, day 2 — the shower has been at full strength since
// 14:00) against 15:00 on its clear day (晴朗, day 3). Same sun, same camera, same terrain.
console.log('\n=== the same hour on a rainy day and a clear one');
await p.evaluate(() => window.__wxHud(false));
const day0 = await frame(0, 15, 'mondstadt-day0');
const rain = await frame(2, 15, 'mondstadt-rain');
const clear = await frame(3, 15, 'mondstadt-clear');

// The assertion this whole design exists to make. Day 0 is the zone as authored, and 晴朗 is a
// forecast day whose every segment says "this zone's normal" — so they are not merely close, they
// are the same picture, and every calibrated pixel gate in the suite still measures what it
// measured before there was weather at all.
const sameShot = pixelsDiffering(day0.img, clear.img, 4);
console.log(`  day 0 vs 晴朗 at the same hour: ${sameShot} px of ${W * H} differ`);
check('day 0 and a clear forecast day are the same frame, to the pixel',
  sameShot < 200, `${sameShot} px`);
check('and day 0 carries no storm term at all',
  day0.st.storm === 0 && day0.st.dim === 1 && day0.st.cloudiness === clear.st.cloudiness
  && day0.st.fog === clear.st.fog && day0.st.groundSun === clear.st.groundSun,
  `uStorm ${day0.st.storm} dim ${day0.st.dim} cloud ${day0.st.cloudiness} ground #${day0.st.groundSun}`);

check('the rainy day is raining and the clear one is not',
  rain.st.type === 'rain' && rain.st.intensity > 0.85 && clear.st.type === 'clear' && clear.st.intensity === 0,
  `${rain.st.type} ${rain.st.intensity} vs ${clear.st.type} ${clear.st.intensity}`);
check('and the names are the ones the vocabulary promised',
  rain.st.name === '暴雨' && rain.st.dayName === '午后骤雨' && clear.st.dayName === '晴朗',
  `"${rain.st.name}" / ${rain.st.dayName} vs ${clear.st.dayName}`);
check('the particle cloud draws thousands of points in the rain and none in the sun',
  rain.st.drawn > 1000 && clear.st.drawn === 0, `${rain.st.drawn} vs ${clear.st.drawn}`);
check('and never more than it allocated',
  rain.st.drawn <= rain.st.alloc && rain.st.alloc === clear.st.alloc,
  `${rain.st.drawn} / ${rain.st.alloc}`);
check('the sky dome is cloudier and windier in the rain',
  rain.st.cloudiness > clear.st.cloudiness + 0.3 && rain.st.windSpeed > clear.st.windSpeed + 1,
  `cloud ${clear.st.cloudiness} → ${rain.st.cloudiness}, wind ${clear.st.windSpeed} → ${rain.st.windSpeed}`);
check('the fog thickens, and by a factor rather than a nudge',
  rain.st.fog > clear.st.fog * 1.5, `${clear.st.fog} → ${rain.st.fog}`);
check('a rainy afternoon costs 蒙德 no extra 严寒, because 蒙德 has none to scale',
  rain.st.coldMul === 1, `×${rain.st.coldMul}`);

// The picture, not just the uniforms. Two rects: the dome (cloudiness) and the middle of the frame
// (where the rain falls). The sky rect is validated as sky on the clear frame first.
// The rain must be *in* the frame without being made of slabs: the sprite ceiling and normal
// blending are what turned fifty white rectangles into streaks, and the bright tail of the meadow
// rect is where that shows up as a number. The "is it there at all" half is the hide-the-suspect
// diff below.
console.log(`  meadow p95 ${clear.mid.p95} → ${rain.mid.p95}, lum ${clear.mid.lum} → ${rain.mid.lum}`);
check('the rain is drawn as clamped, non-additive streaks',
  rain.st.maxPx > 0 && rain.st.maxPx <= 24 && rain.st.additive === false,
  `ceiling ${rain.st.maxPx} px, additive ${rain.st.additive}`);
check('so a meadow behind a downpour does not gain a white blowout',
  rain.mid.p95 - clear.mid.p95 < 40, `p95 ${clear.mid.p95} → ${rain.mid.p95}`);

/* ----------------------------------------- one atmosphere: the ground is in the same air -- */

// This section exists because for most of the project the world had **two** atmospheres. Props,
// grass and characters were in `scene.fog` — a `THREE.FogExp2` whose density is the zone's own and
// which this file's forecast moves — while the ground and the water fogged themselves off a linear
// window, `smoothstep(fogNear * 2.2, fogFar * 2.4, camD)`, that no weather ever touched. In 蒙德
// that window opened at 198 m and finished at 1104 m on a 420 m map: 0 of 315 noon sight lines
// reached its near edge, so the ground's fog term was **exactly zero in every frame the player has
// ever seen**. Measured then: a tree 200 m out was 9.7% hazed standing on a hillside at 0.0%, the
// same grass at 3 m and 140 m photographed identically (lum 126.2/sat 0.420 vs 130.2/0.433), and a
// 龙脊 blizzard erased props 89% at 150 m over ground it dimmed by 2.7% — a whiteout with a hard
// green floor showing through it.
//
// Three claims, and each needs a different kind of evidence:
//   * the air is *one* number — asserted on the floats, in all three places it has to arrive;
//   * that number reaches the ground as depth — asserted on two rects at two distances in one
//     frame, each rect's subject proved by rays, with the pre-fix expression as the mutation;
//   * and it follows the weather — asserted across the storm A/B, in a form that survives the
//     storm also dimming the light.
const NEAR_G = { x: 300, y: 585, w: 400, h: 80, label: 'ground near' };
const FAR_G = { x: 250, y: 165, w: 500, h: 95, label: 'ground far' };
const satOf = (rgb) => { const mx = Math.max(...rgb), mn = Math.min(...rgb); return mx ? (mx - mn) / mx : 0; };

/**
 * The whole section, for one zone: a calm day and a stormy one from the vista camera.
 * `calm`/`storm` are `[forecastDay, hour]`. Leaves the camera back on `__wxAim`.
 */
const atmosphere = async (label, calm, storm, tagBase) => {
  console.log(`\n=== one atmosphere in ${label}: near ground, far ground, and the weather`);
  // Which way to look is measured, not assumed. 蒙德's spawn faces down a valley and 龙脊's faces
  // into a slope 65 m away — the first version of this section pointed both at yaw 0.6 and the far
  // rect in 龙脊 was ground at 60–70 m, i.e. the two rects were the same distance and the section
  // was measuring nothing. So sweep the compass and take the direction with the longest sight line.
  const pick = async () => {
    let best = null;
    for (const yaw of [0.6, 1.6, 2.6, 3.6, 4.6, 5.6]) {
      await p.evaluate((y) => { window.__wxVista(y); window.__wxRender(); }, yaw);
      const f = await p.evaluate((r, w, h) => window.__wxRectSubject(r, w, h), FAR_G, W, H);
      const n = await p.evaluate((r, w, h) => window.__wxRectSubject(r, w, h), NEAR_G, W, H);
      const deep = f.filter((r) => r && r.t && r.d > 140).length;
      const shallow = n.filter((r) => r && r.t && r.d < 90).length;
      console.log(`  yaw ${yaw.toFixed(1)}: far ${deep}/5 ground past 140 m, near ${shallow}/5 ground within 90 m`);
      if (!best || deep * 10 + shallow > best.rank) best = { yaw, rank: deep * 10 + shallow, f, n, deep, shallow };
    }
    return best;
  };
  const aim = await pick();
  // Three shots, and the reading is the last one. The first two exist because a frame taken shortly
  // after a zone change is still converging: in 龙脊 the shot straight after the transition differed
  // from the next one across 66% of the frame, sky and ground together, at a mean delta of 10 — not
  // motion (the game is stopped and the composer has no temporal pass) but something still settling.
  // A floor measured across that interval is a floor for a frame nobody reads, so the pair the floor
  // is measured on is the pair the reference frame itself sits in, and both numbers are printed: a
  // large `settle` next to a small `floor` is a frame that converged, while a floor as big as the
  // settle would mean something in this zone never stops moving and the bars would have to say so.
  // Pinning a day also turns the precipitation back on, so it is hidden per shot, after the pin.
  const relMove = (a, b, r) => {
    const s0 = satOf(rectStats(a, r).rgb), s1 = satOf(rectStats(b, r).rgb);
    return Math.abs(s1 - s0) / Math.max(s0, 1e-6);
  };
  const look = async ([day, hour], tag) => {
    await p.evaluate((d, h) => window.__wxPin(d, h), day, hour);
    await sleep(1200);
    const precipWas = await p.evaluate((y) => {
      const was = window.__wxPrecip(false);
      window.__wxVista(y);
      window.__wxRender();
      return was;
    }, aim.yaw);
    const img0 = await shoot(`${tag}-settle`);
    const img1 = await shoot(`${tag}-floor`);
    const img = await shoot(tag);
    const settle = pixelsDiffering(img0, img1, 4), floorPx = pixelsDiffering(img1, img, 4);
    const st = await p.evaluate(() => ({ ...window.__wxState(), ...window.__wxFog() }));
    const near = rectStats(img, NEAR_G), far = rectStats(img, FAR_G);
    const floorNear = relMove(img1, img, NEAR_G), floorFar = relMove(img1, img, FAR_G);
    console.log(`  ${tag}: ${st.type} i${st.intensity} density ${st.ground} (scene ${st.scene},`
      + ` water ${st.water}) dim ${st.dim}, running ${st.running}, precipitation hidden (was ${precipWas})`);
    console.log(`    near lum ${near.lum} rgb ${near.rgb.join()} sat ${satOf(near.rgb).toFixed(3)}`
      + ` | far lum ${far.lum} rgb ${far.rgb.join()} sat ${satOf(far.rgb).toFixed(3)}`);
    console.log(`    settle ${settle} px → floor ${floorPx} px, near sat ±${(floorNear * 100).toFixed(1)}%,`
      + ` far sat ±${(floorFar * 100).toFixed(1)}%`);
    return { img, st, near, far, precipWas, settle, floorPx, floorNear, floorFar,
      nearSat: satOf(near.rgb), farSat: satOf(far.rgb) };
  };
  const c = await look(calm, `${tagBase}-vista-calm`);
  // One number, in all three places it has to arrive. The scene fog is what the renderer applies to
  // every mesh it owns; the other two are the surfaces that fog themselves. This half needs no
  // sight line, so it is asserted before the pixel half can bow out.
  check(`${label}: the ground, the water and every prop are given the same air`,
    c.st.ground === c.st.scene && (c.st.water === null || c.st.water === c.st.scene),
    `ground ${c.st.ground}, scene ${c.st.scene}, water ${c.st.water}`);

  // A rect must prove its subject, and this pair of rects is the whole pixel claim: if they are not
  // ground at two very different distances, everything below is measuring something else. Reported
  // as a SKIP rather than a FAIL when no direction has the sight line, because that is a fact about
  // where the probe stands, not about the fog — and a green run with a silent hole is worse.
  console.log(`  aiming at yaw ${aim.yaw.toFixed(1)}: near ${JSON.stringify(aim.n)}`);
  console.log(`  ${''.padEnd(19)} far  ${JSON.stringify(aim.f)}`);
  if (aim.deep < 4 || aim.shallow < 4) {
    skipped(`${label}: the picture half of the atmosphere section`,
      `no direction from this spawn holds ground within 90 m and ground past 140 m in one frame`
      + ` (best yaw ${aim.yaw.toFixed(1)}: ${aim.shallow}/5 near, ${aim.deep}/5 far)`);
    await p.evaluate(() => { window.__wxPrecip(true); window.__wxAim(0.6); window.__wxRender(); });
    return { c, yaw: aim.yaw };
  }
  // Not a restatement of the line above: that one asked "is there a sight line at all", this one is
  // the ratio the aerial-perspective reading needs. Two rects 50 m and 60 m out would satisfy the
  // first and prove nothing.
  const depths = (rays) => rays.filter((r) => r && r.t).map((r) => r.d).sort((x, y) => x - y);
  const dNear = depths(aim.n)[Math.floor(depths(aim.n).length / 2)];
  const dFar = depths(aim.f)[Math.floor(depths(aim.f).length / 2)];
  check(`${label}: and the far rect is several times deeper into the world than the near one`,
    dFar >= dNear * 2.5, `${dNear} m → ${dFar} m (×${(dFar / dNear).toFixed(1)})`);

  // "The far ground is less saturated than the near ground" is not on its own a statement about fog:
  // 蒙德's distance is grey cliff and 龙脊's foreground is snow, so the two rects do not start from
  // the same colour and no absolute ratio holds in both zones (the first version of this check read
  // 0.083/0.389 in 蒙德 and 0.116/0.165 in 龙脊 — one passing a 0.55 bar by a mile, the other
  // failing it). What *is* a statement about fog is the same ratio with the fog taken out, so the
  // mutation is not an extra assertion here, it is the control every reading below is measured
  // against. And density 0 is very nearly the picture the ground used to be drawn with: the pre-fix
  // `smoothstep(fogNear·2.2, fogFar·2.4, camD)` was a 198–1104 m window in 蒙德 and 88–720 m in
  // 龙脊, which is 0.0% at both zones' near rect and 0.6% / 4.0% at their far one, against the
  // 13.7% / 37.7% the air puts there now. From the player's own camera, which cannot see past about
  // 150 m, it was exactly 0 in every frame.
  //
  // Every bar below is a multiple of what the frame does when nothing is changed, which `look()` has
  // already measured on the very pair this reference frame sits in.
  const { floorPx, floorNear, floorFar } = c;
  const off = await p.evaluate(() => {
    window.game.world.terrain.uniforms.uFogDensity.value = 0;
    window.__wxRender();
    return window.__wxFog();
  });
  const imgOff = await shoot(`${tagBase}-vista-nofog`);
  const moved = pixelsDiffering(c.img, imgOff, 4);
  const offNear = satOf(rectStats(imgOff, NEAR_G).rgb), offFar = satOf(rectStats(imgOff, FAR_G).rgb);
  const dFarSat = (offFar - c.farSat) / c.farSat, dNearSat = Math.abs(offNear - c.nearSat) / c.nearSat;
  const restored = await p.evaluate(() => { window.game._updateWeather(true); return window.__wxFog(); });
  console.log(`  mutation → density ${off.ground}: ${moved} px moved,`
    + ` far sat ${c.farSat.toFixed(3)} → ${offFar.toFixed(3)} (${(dFarSat * 100).toFixed(0)}%),`
    + ` near ${c.nearSat.toFixed(3)} → ${offNear.toFixed(3)} (${(dNearSat * 100).toFixed(0)}%)`
    + ` (restored to ${restored.ground})`);
  check(`${label}: the air is what stands between you and the distance`,
    c.farSat / c.nearSat < (offFar / offNear) * 0.8,
    `far/near sat ${(c.farSat / c.nearSat).toFixed(3)} with the fog, ${(offFar / offNear).toFixed(3)} without it`);
  check(`${label}: ...washed toward the fog colour, not blown out or blacked in`,
    c.far.lum > c.near.lum * 0.85 && c.far.lum < c.near.lum * 1.7 && c.far.clip < 0.05,
    `lum ${c.near.lum} → ${c.far.lum}, ${(c.far.clip * 100).toFixed(1)}% clipped`);
  check(`${label}: putting the ground back on the pre-fix fog gives the distance its colour back`,
    moved > Math.max(100000, floorPx * 3) && dFarSat > Math.max(0.25, floorFar * 4),
    `${moved} px (floor ${floorPx}), far sat +${(dFarSat * 100).toFixed(0)}% (floor ±${(floorFar * 100).toFixed(1)}%)`);
  check(`${label}: ...and it is the distance it acts on, not the frame`,
    dNearSat < Math.max(0.12, floorNear * 3) && dFarSat > dNearSat * 2,
    `near sat ${(dNearSat * 100).toFixed(0)}% (floor ±${(floorNear * 100).toFixed(1)}%)`
    + ` against far ${(dFarSat * 100).toFixed(0)}%`);
  check(`${label}: the product's own weather path puts the air back`,
    restored.ground === c.st.ground && restored.ground === restored.scene,
    `${off.ground} → ${restored.ground}`);

  // The weather. A storm both thickens the air and dims the light, and the dimming alone would move
  // any single rect — so the reading is the *gap* between the far ground and the ground at your
  // feet. The two halves point in opposite directions and only thicker air can do that: the storm's
  // dim factor takes the near ground down (蒙德 lum 115 → 108 at dim 0.71) while the haze pulls the
  // far ground up toward the fog colour (143 → 165). A fix that only dimmed, or only tinted the
  // whole frame, moves both the same way and fails here.
  const s = await look(storm, `${tagBase}-vista-storm`);
  const gapC = c.far.lum - c.near.lum, gapS = s.far.lum - s.near.lum;
  console.log(`  ${label}: far−near lum ${gapC.toFixed(1)} → ${gapS.toFixed(1)},`
    + ` near lum ${c.near.lum} → ${s.near.lum}, far sat ${c.farSat.toFixed(3)} → ${s.farSat.toFixed(3)},`
    + ` density ${c.st.ground} → ${s.st.ground} at dim ${s.st.dim}`);
  check(`${label}: a storm thickens the ground's air by the same factor as the props'`,
    s.st.ground > c.st.ground * 1.5 && s.st.ground === s.st.scene
    && (s.st.water === null || s.st.water === s.st.scene),
    `${c.st.ground} → ${s.st.ground} (scene ${s.st.scene}, water ${s.st.water})`);
  check(`${label}: and the distance goes with it — the far ground washes out while the near ground darkens`,
    gapS > gapC + 8 && s.near.lum < c.near.lum && s.far.lum > c.far.lum,
    `gap ${gapC.toFixed(1)} → ${gapS.toFixed(1)}, near lum ${c.near.lum} → ${s.near.lum},`
    + ` far lum ${c.far.lum} → ${s.far.lum}`);
  // The direction, named. "Washes out" is not "gets brighter" and it is certainly not "loses
  // saturation" — 蒙德's air is a saturated blue-white (#c8ddf0) and its 240 m hillside is already
  // washed past it, so thicker fog *raises* that rect's saturation while 龙脊's lowers it, and the
  // first version of this check went red on exactly that. What both do is move toward the colour of
  // the air, and the near ground does not: it walks away from it as the storm dims the light. The
  // target is the authored fog colour in sRGB and the pixels have been through bloom and ACES, so
  // this is a reading of a direction and not of an absolute distance — which is why it is scored as
  // "much closer" against "no closer", a split of 0.65 versus 1.1 that no tone curve inverts.
  const fogRGB = [0, 2, 4].map((i) => parseInt(s.st.fogHex.slice(i, i + 2), 16));
  const distTo = (rgb) => Math.hypot(...rgb.map((v, i) => v - fogRGB[i]));
  const [fc, fs2] = [distTo(c.far.rgb), distTo(s.far.rgb)];
  const [nc, ns] = [distTo(c.near.rgb), distTo(s.near.rgb)];
  console.log(`  distance to the air's own #${s.st.fogHex}: far ${fc.toFixed(0)} → ${fs2.toFixed(0)}`
    + ` (×${(fs2 / fc).toFixed(2)}), near ${nc.toFixed(0)} → ${ns.toFixed(0)} (×${(ns / nc).toFixed(2)})`);
  check(`${label}: ...toward the colour of the air, which is not where the near ground goes`,
    fs2 < fc * 0.8 && ns > nc * 0.95,
    `far ×${(fs2 / fc).toFixed(2)}, near ×${(ns / nc).toFixed(2)} of the way to #${s.st.fogHex}`);
  // Every reading in this section is of ground with the storm's own drops hidden, and "we hid it" is
  // only worth saying if it was there: `precipWas` cannot say so, because the calm shot hid it first
  // and nothing turns it back on. So put it back and photograph it — the drops are in the frame if
  // showing them changes the frame by much more than the frame changes by itself.
  const backOn = await p.evaluate(() => { window.__wxPrecip(true); window.__wxRender(); return window.__wxState().drawn; });
  const imgDrops = await shoot(`${tagBase}-vista-storm-drops`);
  const dropsPx = pixelsDiffering(s.img, imgDrops, 4);
  console.log(`  showing the storm's ${backOn} drops again moves ${dropsPx} px (floor ${s.floorPx})`);
  check(`${label}: and those were readings of the ground, with the storm's own drops out of the frame`,
    backOn > 1000 && dropsPx > Math.max(4000, s.floorPx * 3),
    `${backOn} points, ${dropsPx} px against a floor of ${s.floorPx} px`);
  await p.evaluate(() => { window.__wxAim(0.6); window.__wxRender(); });
  return { c, s, yaw: aim.yaw };
};

await atmosphere('蒙德', [3, 15], [2, 15], 'mondstadt');

/* ------------------------------------------------- the dome, from above the ridge -- */

// Measured from 90 m, level, because at head height the top of the frame is part hillside. The
// first version of the claim below read Δlum 2.3 and was right to fail: coverage tripled while the
// dome stayed the same brightness, because an almost-white cloud over an already-bright sky is not
// a storm. `uStorm` — cloudiness past the zone's *own* baseline, hence 0 on day 0 — darkens it.
console.log('\n=== the dome itself, from above the ridge line');
const DOME = { x: 380, y: 150, w: 240, h: 110, label: 'dome' };
const dome = async (day, tag) => {
  await p.evaluate((d, h) => window.__wxPin(d, h), day, 15);
  await p.evaluate(() => window.__wxSkyCam(0.6));
  await sleep(1200);
  await p.evaluate(() => window.__wxRender());
  const img = await shoot(tag);
  const st = await p.evaluate(() => window.__wxState());
  return { band: rectStats(img, DOME), st };
};
const dClear = await dome(3, 'dome-clear');
const dRain = await dome(2, 'dome-rain');
console.log(`  dome lum ${dClear.band.lum} → ${dRain.band.lum}`
  + ` rgb ${dClear.band.rgb.join()} → ${dRain.band.rgb.join()} p5 ${dClear.band.p5} → ${dRain.band.p5}`);
check('the band is dome and not hillside on the clear day: blue over green over red',
  dClear.band.rgb[2] > dClear.band.rgb[1] && dClear.band.rgb[1] > dClear.band.rgb[0]
  && dClear.band.lum > 90, `rgb ${dClear.band.rgb.join()} lum ${dClear.band.lum}`);
check('and the storm actually darkens the sky, not just the cloud coverage',
  dClear.band.lum - dRain.band.lum > 18, `lum ${dClear.band.lum} → ${dRain.band.lum}`);
// Bounded from the other side too, because "darker" is the kind of claim that is satisfied by
// black. An overcast afternoon is grey, not night, and no channel may pin at 0.
check('a rainy afternoon is overcast, not night, and nothing crushes',
  dRain.band.lum > 60 && dRain.band.clip < 0.05 && Math.min(...dRain.band.rgb) > 25,
  `lum ${dRain.band.lum} rgb ${dRain.band.rgb.join()} clipped ${(dRain.band.clip * 100).toFixed(1)}%`);
await p.evaluate(() => window.__wxAim(0.6));
check('a storm dims the direct light too, and only past the zone\'s own baseline',
  rain.st.storm > 0.7 && rain.st.dim < 0.85 && clear.st.storm === 0 && clear.st.dim === 1,
  `uStorm ${clear.st.storm} → ${rain.st.storm}, dim ${clear.st.dim} → ${rain.st.dim}`);

/* ------------------------------------- hide the storm, against a measured floor -- */

// llvmpipe renders grass, water and cloud in motion, so "the frame changed" is meaningless without
// knowing how much it changes when *nothing* changed. The floor is measured first, in the same
// conditions, from the same camera, at the same instant.
console.log('\n=== the rain, hidden to prove it is there');
await p.evaluate((d, h) => window.__wxPin(d, h), 2, 15);
await sleep(1000);
await p.evaluate(() => window.__wxRender());
const n1 = await shoot('noise-a');
await p.evaluate(() => window.__wxRender());
const n2 = await shoot('noise-b');
const floor = pixelsDiffering(n1, n2, 4);
const off = await p.evaluate(() => {
  window.game.world.weather.setStorm('rain', 0);
  window.__wxRender();
  return window.game.world.weather.mesh.geometry.drawRange.count;
});
await sleep(600);
await p.evaluate(() => window.__wxRender());
const noRain = await shoot('rain-off');
const moved = pixelsDiffering(n2, noRain, 4);
// Put it back through the product's own path, so nothing downstream is left in a probe-only state.
await p.evaluate(() => window.game._updateWeather(true));
const backOn = await p.evaluate(() => window.__wxState());
console.log(`  two identical frames differ by ${floor} px; taking the rain out moves ${moved} px`
  + ` (draw range ${rain.st.drawn} → ${off} → ${backOn.drawn})`);
check('taking the rain out changes the picture far more than the frame changes by itself',
  moved > Math.max(2500, floor * 3), `${moved} px vs a floor of ${floor} px`);
check('and it went out through the draw range, not by luck',
  off === 0 && backOn.drawn > 1000, `${off} then restored to ${backOn.drawn}`);

/* ------------------------------------------------------------- the HUD's chip -- */

console.log('\n=== the 天气 chip in the corner');
await p.evaluate(() => window.__wxHud(true));
const readChip = async (day, hour) => {
  await p.evaluate((d, h) => window.__wxPin(d, h), day, hour);
  await sleep(700);
  return p.evaluate(() => {
    const el = document.querySelector('[data-f="weather"]');
    const cs = getComputedStyle(el);
    return {
      text: el.textContent, hidden: el.classList.contains('hidden'),
      title: el.getAttribute('title'), opacity: +cs.opacity, color: cs.color, bg: cs.backgroundColor,
      display: cs.display, want: window.game.weather,
    };
  });
};
const cRain = await readChip(2, 15), cClear = await readChip(3, 15), cShower = await readChip(2, 13.6);
for (const [tag, v] of [['rain', cRain], ['clear', cClear], ['starting', cShower]]) {
  console.log(`  ${tag.padEnd(9)} "${v.text}" hidden=${v.hidden} @${v.opacity} ${v.color} title="${v.title}"`);
}
check('the chip prints the word the forecast chose',
  cRain.text === cRain.want.name && cRain.text === '暴雨' && cRain.hidden === false, `"${cRain.text}"`);
check('and says nothing on a clear day instead of printing 晴',
  cClear.hidden === true && cClear.display === 'none', `hidden=${cClear.hidden} display=${cClear.display}`);
check("the tooltip names the day and the day index, and it is the only place they are read",
  /今日天气：午后骤雨/.test(cRain.title) && /第 2 天/.test(cRain.title), cRain.title);
// The other direction is asserted in 龙脊雪山 below, where the warning has to be present.
check('and it does not warn about 严寒 in a valley that has none',
  !/严寒/.test(cRain.title), cRain.title);
// Style, not class: intensity has to reach the pixels. A shower that has just started is fainter
// than the same storm at full strength — measured as computed opacity, both directions pinned.
check('a storm that has just begun is fainter than one at full strength',
  cShower.opacity < cRain.opacity - 0.1 && cShower.opacity > 0.5,
  `@${cShower.opacity} (i=${cShower.want.intensity.toFixed(2)}) vs @${cRain.opacity}`);
check('and a rain chip is painted, not left as bare text',
  /\d/.test(cRain.bg) && cRain.bg !== 'rgba(0, 0, 0, 0)', cRain.bg);

/* ------------------------------------------------- 龙脊雪山: a blizzard, and 严寒 -- */

console.log('\n=== 龙脊雪山: the baseline snowfall and a full blizzard');
const travel = async (zone) => p.evaluate(async (z) => {
  const g = window.game;
  g.start?.();
  await g.enterZone(z, { x: 0, z: 40 });
  await new Promise((r) => setTimeout(r, 6000));
  g.stop();
  window.__wxAim(0.6);
  return g.zoneId === z && g.quality === 'high';
}, zone);

if (!await travel('dragonspine')) skipped('the blizzard section', 'the zone transition did not take');
else {
  await p.evaluate(() => window.__wxHud(false));
  // The atmosphere section again, in the zone with the thickest authored air (0.0042, 2.6× 蒙德's)
  // and the worst storm — this is where the two atmospheres were most visible, and it is the reading
  // that would catch a fix which only happened to work at one density. It runs *first* here because
  // it is the only thing in the probe that **measures** which way to look, and the two shots below
  // need that answer. 龙脊's spawn faces a slope 65 m
  // away and the walking camera __wxAim leaves is inside it: the snowfall/blizzard pair used to be
  // two photographs of the near-black interior of one polygon, 6168 px apart, and the value that
  // passed before them (621669 px) was a stale composited frame from the previous camera. Same zone,
  // same days, same assertions — from a camera pointed at the mountain.
  const atm = await atmosphere('龙脊雪山', [0, 12], [3, 12], 'dragonspine');
  await p.evaluate((y) => { window.__wxVista(y); window.__wxRender(); }, atm.yaw);
  const snow = await frame(0, 12, 'dragonspine-base');       // day 0 = the authored zone
  const bliz = await frame(3, 12, 'dragonspine-blizzard');   // 整日暴风雪
  check('day 0 in 龙脊雪山 is still the snowfall every other probe photographs',
    snow.st.type === 'snow' && snow.st.intensity === 1 && snow.st.coldMul === 1,
    `${snow.st.type} i${snow.st.intensity} ×${snow.st.coldMul}`);
  check('and the blizzard day is a blizzard', bliz.st.type === 'blizzard' && bliz.st.intensity > 0.95,
    `${bliz.st.type} i${bliz.st.intensity} / ${bliz.st.dayName}`);
  // One buffer becomes either storm: the count grows and the uniforms change, with no reallocation.
  check('the same allocation drives both, with more points and far more wind in the blizzard',
    bliz.st.alloc === snow.st.alloc && bliz.st.drawn > snow.st.drawn * 1.2 && bliz.st.windU > snow.st.windU * 4,
    `drawn ${snow.st.drawn} → ${bliz.st.drawn} of ${snow.st.alloc}, wind ${snow.st.windU} → ${bliz.st.windU}`);
  check('and snow keeps the additive, unclamped look 龙脊雪山 was calibrated on',
    snow.st.additive === true && snow.st.maxPx === 0 && bliz.st.additive === true,
    `snow additive ${snow.st.additive} ceiling ${snow.st.maxPx}`);
  check('the blizzard makes the sheer cold worse, and the HUD says so',
    bliz.st.coldMul > 1.2 && snow.st.coldMul === 1, `×${snow.st.coldMul} → ×${bliz.st.coldMul}`);
  await p.evaluate(() => window.__wxHud(true));
  const cBliz = await readChip(3, 12);
  console.log(`  blizzard chip "${cBliz.text}" title="${cBliz.title}"`);
  check('the chip warns that the cold is worse than usual',
    /严寒加剧 ×1\.2/.test(cBliz.title) && cBliz.text === '暴风雪', `"${cBliz.text}" ${cBliz.title}`);
  await p.evaluate(() => window.__wxHud(false));
  const dMoved = pixelsDiffering(snow.img, bliz.img, 6);
  console.log(`  snowfall vs blizzard: ${dMoved} px of ${W * H}`);
  check('and it is a different picture, not just a different number', dMoved > 8000, `${dMoved} px`);
}

/* --------------------------------------------------- indoor zones do not move -- */

// Both sides, as always: the cave must not move, and the surface must move a lot on the same pair
// of days — otherwise "no change" would be equally true of a build where the forecast never
// reached the renderer at all. The surface pass runs last so the shared guest token is left
// outdoors for the next probe to inherit.
console.log('\n=== underground the forecast changes nothing');
const pairDiff = async (zone, tag, d1, d2) => {
  if (!await travel(zone)) return null;
  await p.evaluate(() => window.__wxHud(false));
  await p.evaluate((d, h) => window.__wxPin(d, h), d1, 15);
  await sleep(1500);
  await p.evaluate(() => window.__wxRender());
  const a = await shoot(`${tag}-d${d1}`);
  const st = await p.evaluate(() => window.__wxState());
  await p.evaluate((d, h) => window.__wxPin(d, h), d2, 15);
  await sleep(1500);
  await p.evaluate(() => window.__wxRender());
  const c = await shoot(`${tag}-d${d2}`);
  return { moved: pixelsDiffering(a, c, 6), st };
};
const cave = await pairDiff('abyssTrial', 'cave', 2, 3);
const surf = await pairDiff('mondstadt', 'surface', 2, 3);
if (!cave || !surf) skipped('indoor immunity', 'a zone transition did not take');
else {
  console.log(`  d2 vs d3 at 15:00 — 蒙德 ${surf.moved} px, 深渊试炼场 ${cave.moved} px of ${W * H}`);
  check('the cave reports no weather at all', cave.st.type === 'none' && cave.st.drawn === -1,
    `${cave.st.type}, mesh ${cave.st.drawn === -1 ? 'not built' : 'built'}`);
  check('and the two forecast days are the same picture underground', cave.moved < 2500, `${cave.moved} px`);
  check('while on the surface they are plainly different', surf.moved > 15000, `${surf.moved} px`);
}
// The chip has to appear on a *mount*, not only on the next `weather` event — the corner was empty
// after a zone change for exactly this reason in the quest tracker.
const mounted = await p.evaluate(() => {
  const el = document.querySelector('[data-f="weather"]');
  return { text: el.textContent, hidden: el.classList.contains('hidden'), type: window.game.weather.type };
});
console.log(`  after two zone changes the chip reads "${mounted.text}" (hidden=${mounted.hidden}) for ${mounted.type}`);
check('the chip survives a zone change instead of going stale',
  mounted.hidden === (mounted.type === 'clear' || mounted.type === 'none'),
  `"${mounted.text}" for ${mounted.type}`);

/* ------------------------------------------------------------------- tally -- */

console.log(`\nerrors -> ${errs.length ? errs.slice(0, 4).join(' | ') : 'none'}`);
console.log(`hmr    -> ${hmr.length ? hmr.length : 'none'}`);
check('no page errors while the weather turned', errs.length === 0, errs.slice(0, 2).join(' | '));
check('client/src was not hot-updated mid-run', hmr.length === 0, `${hmr.length} HMR events`);

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
console.log(`shots -> ${outDir}`);
await b.close();
process.exit(fail === 0 && pass >= 80 ? 0 : 1);
