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

const shoot = async (file) => {
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
