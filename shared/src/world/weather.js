// 天气: what the sky is doing right now, derived — like the clock — from epoch milliseconds.
//
// Why this file exists. `zone.weather` has been a *constant* since zones.js was written: 蒙德 is
// clear forever, 龙脊雪山 snows forever, and the three dungeons have `type: 'none'`. Two
// consequences, both of them the shape of defect this repo keeps finding:
//
//   * `client/src/audio/audio.js` picks its wind filter with `this.zone?.weather === 'blizzard'`
//     — comparing a **string to an object**, because `zone.weather` is `{ type, windSpeed,
//     cloudiness }`. Both branches were unreachable, so the cold thin wind never played anywhere.
//   * `Weather` (gfx/sky.js) is built once per zone from that constant and then only ever thinned
//     by the quality governor. A whole particle system with one authored state per zone.
//
// The design mirrors `daylight.js`, deliberately, because the two problems are the same problem:
//
//  * **Derived, not stored.** `weatherAt(zone, Date.now())` is pure. No forecast is broadcast,
//    nothing is persisted, every client in a session sees the same storm, and 单机 agrees with
//    多人 for free. The sim reads the same function for the sheer-cold rate, so what you *feel* in
//    龙脊雪山 comes from the same expression that draws the snow.
//
//  * **Day 0 is the authored zone, exactly.** `daylight()` gives back each zone's hand-tuned `sky`
//    block at 12:00; this gives back each zone's authored `weather` block for the whole of day
//    index 0 — same values, `===`, including `fogDensity`. Every pixel probe pins an hour, a pin is
//    day 0 (`setWorldTime` builds its epoch from `dayT` alone), so the ~500 calibrated pixel
//    assertions keep the frame they were calibrated on. Day 1 and later rotate through the zone's
//    authored `forecast`.
//
//  * **Authors write two numbers, not five.** A segment is a `type` and a `strength`: "how far from
//    this zone's own baseline toward that weather". Cloudiness, wind, fog and cold are derived from
//    the type's preset and the zone's own baseline, so 蒙德's rain stays 蒙德's (green, mild fog)
//    instead of every zone's storm landing on the same postcard. The same reason `daylight()` mixes
//    toward three colours and takes everything else from the zone.
//
//  * **Nothing jumps.** Every value crossfades over `RAMP_H` in-game hours, across the day
//    boundary too (the segment before midnight is the previous day's last one), so a storm arrives
//    and leaves instead of popping. At 24 real minutes per day, 0.5 in-game hours is 30 s.
import { DAY_MS } from './daylight.js';

/** How long a change takes, in in-game hours. 0.5 h = 30 real seconds. */
export const RAMP_H = 0.5;

/**
 * The weather vocabulary. `sev` is severity, which is the only thing gameplay reads (it scales the
 * sheer-cold rate); `cloud`/`wind` are the targets a strength of 1 reaches and `fog` multiplies the
 * zone's authored fog density. `precip` is what decides whether the particle system draws at all.
 */
export const WEATHER_TYPES = {
  none:     { name: '无风', cloud: 0.00, wind: 0.4, fog: 1.00, sev: 0.00, precip: false },
  clear:    { name: '晴',   cloud: 0.30, wind: 3.0, fog: 1.00, sev: 0.00, precip: false },
  cloudy:   { name: '多云', cloud: 0.82, wind: 4.6, fog: 1.25, sev: 0.05, precip: false },
  rain:     { name: '雨',   cloud: 0.94, wind: 6.0, fog: 1.85, sev: 0.20, precip: true },
  snow:     { name: '雪',   cloud: 0.88, wind: 5.0, fog: 1.70, sev: 0.55, precip: true },
  blizzard: { name: '暴风雪', cloud: 0.97, wind: 11.0, fog: 2.40, sev: 1.00, precip: true },
};

/** How much worse than its own baseline a zone's weather can make the sheer cold. */
const COLD_GAIN = 0.5;

/** Allocation order for the particle cloud: a heavier storm needs more points than a lighter one. */
export const STORM_RANK = { none: 0, clear: 0, cloudy: 0, rain: 1, snow: 1, blizzard: 2 };

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The zone's authored state, and the *exact* values day 0 returns.
 *
 * `intensity` is 1 for a zone whose baseline precipitates (龙脊雪山 snows by default) and 0
 * otherwise — that is what makes "day 0 is the authored zone" true of the particle count as well
 * as of the colours.
 */
export function baseWeather(zone) {
  const w = zone?.weather || {};
  const type = WEATHER_TYPES[w.type] ? w.type : 'none';
  const t = WEATHER_TYPES[type];
  return {
    type,
    intensity: t.precip ? 1 : 0,
    cloudiness: w.cloudiness ?? t.cloud,
    windSpeed: w.windSpeed ?? t.wind,
    fogDensity: zone?.sky?.fogDensity ?? 0.008,
    severity: t.sev,
  };
}

/** Which day of the forecast an epoch falls on. Day 0 (and anything before it) is the baseline. */
export function weatherDay(epochMs) { return Math.floor(epochMs / DAY_MS); }

/**
 * The segments that make up one day, as `{ at, ...state }` sorted by hour, always starting at 0.
 *
 * Indoor zones and day 0 are a single baseline segment — an indoor zone has no sky to have weather
 * in, which (like `applyDaylight`) makes half the art gates structurally immune to this feature.
 */
function dayPlan(zone, dayIndex) {
  const base = baseWeather(zone);
  const list = zone?.forecast || [];
  if (zone?.indoor || base.type === 'none' || dayIndex <= 0 || list.length === 0) {
    return { name: WEATHER_TYPES[base.type].name, segs: [{ at: 0, ...base }] };
  }
  const pat = list[(dayIndex - 1) % list.length];
  const segs = (pat.seg || []).map((s) => ({ at: s.at, ...segState(base, s) }));
  if (!segs.length || segs[0].at !== 0) segs.unshift({ at: 0, ...base });
  return { name: pat.name || WEATHER_TYPES[segs[segs.length - 1].type].name, segs };
}

/** One authored segment → a full state, derived from the type preset and the zone's own baseline. */
function segState(base, s) {
  const type = WEATHER_TYPES[s.type] ? s.type : base.type;
  const t = WEATHER_TYPES[type];
  // No `type` means "back to this zone's normal", and that has to be the baseline *bit for bit*,
  // not a strength-1 lerp toward the preset: 龙脊雪山's authored snow is cloudiness 0.72, the snow
  // preset is 0.88, and a day that "returns to normal" 0.16 cloudier every time would drift.
  if (!s.type) return { ...base };
  const k = s.strength ?? 1;
  return {
    type,
    intensity: t.precip ? k : 0,
    cloudiness: lerp(base.cloudiness, t.cloud, k),
    windSpeed: lerp(base.windSpeed, t.wind, k),
    fogDensity: base.fogDensity * lerp(1, t.fog, k),
    severity: t.sev * k,
  };
}

/**
 * Everything the renderer, the HUD, the audio bed and the sim need for one instant of one zone's
 * weather.
 *
 *   `type`       one of `WEATHER_TYPES`. What the particle cloud draws and the wind bed filters on.
 *   `intensity`  0..1. Particle count and opacity; 0 means the cloud draws nothing.
 *   `cloudiness` / `windSpeed`  the two sky-dome uniforms that had one authored value per zone.
 *   `fogDensity` absolute, already multiplied out — the reader assigns it, it does no arithmetic.
 *   `coldMul`    ≥ 1, and *exactly* 1 at the zone's baseline, so today's balance is untouched and
 *                only a storm above the zone's normal makes 严寒 climb faster. Also exactly 1 in
 *                every zone that has no 严寒 to scale: the HUD prints this number, and a 蒙德
 *                downpour reported ×1.09 — a warning about a mechanic that zone does not have.
 */
export function weatherAt(zone, epochMs) {
  const dayIndex = weatherDay(epochMs);
  const plan = dayPlan(zone, dayIndex);
  const hour = ((epochMs - dayIndex * DAY_MS) / DAY_MS) * 24;

  // The active segment, and the one before it — which at the top of the day is the *previous day's*
  // last segment. Without that, a storm that runs to midnight would vanish between two frames.
  let i = 0;
  for (let k = 0; k < plan.segs.length; k++) if (hour >= plan.segs[k].at) i = k;
  const cur = plan.segs[i];
  const prev = i > 0 ? plan.segs[i - 1]
    : (() => { const p = dayPlan(zone, dayIndex - 1).segs; return p[p.length - 1]; })();

  // Weight of the crossfade. Exactly 1 everywhere except the RAMP_H after a boundary, so a day made
  // of one baseline segment returns the authored numbers untouched.
  const w = clamp01((hour - cur.at) / RAMP_H);
  const intensity = lerp(prev.intensity, cur.intensity, w);
  const base = baseWeather(zone);
  // Which type the picture and the HUD should name during a crossfade: whichever side of the fade
  // matches what is actually happening. Something falling means the wet side — reading `cur.type`
  // alone would switch to 'clear' the instant a shower's segment ended and delete its last 30 s
  // mid-air. Nothing falling means the *dry* side, which is the mirror case and was wrong first:
  // at exactly 00:00 of 蒙德's 晨雨 the incoming segment is rain at intensity 0, so the chip printed
  // 零星细雨 over a dry meadow. Both wet (a shower turning to snow) keeps the incoming one.
  const wetSide = intensity > 0.02;
  const precipType = WEATHER_TYPES[cur.type].precip === wetSide ? cur.type
    : WEATHER_TYPES[prev.type].precip === wetSide ? prev.type : cur.type;
  const severity = lerp(prev.severity, cur.severity, w);

  return {
    type: precipType,
    intensity,
    cloudiness: lerp(prev.cloudiness, cur.cloudiness, w),
    windSpeed: lerp(prev.windSpeed, cur.windSpeed, w),
    fogDensity: lerp(prev.fogDensity, cur.fogDensity, w),
    coldMul: zone?.mechanic?.sheerCold ? 1 + COLD_GAIN * Math.max(0, severity - base.severity) : 1,
    name: weatherName(precipType, intensity),
    dayName: plan.name,
    dayIndex,
  };
}

/** 小雨 / 暴雨 / 飘雪 — the words the HUD prints, from the same two numbers the picture uses. */
export function weatherName(type, intensity) {
  const t = WEATHER_TYPES[type] || WEATHER_TYPES.none;
  if (!t.precip) return t.name;
  if (type === 'rain') return intensity >= 0.7 ? '暴雨' : intensity >= 0.25 ? '小雨' : '零星细雨';
  if (type === 'snow') return intensity >= 0.7 ? '大雪' : intensity >= 0.25 ? '飘雪' : '细雪';
  return t.name;
}

/**
 * The heaviest storm this zone can ever produce, for allocation. The particle cloud is one buffer
 * built when the zone is built: rain and snow differ only in uniforms (speed, size, colour, streak,
 * wind, opacity), so one allocation can *become* either — but it cannot grow, and 蒙德 whose
 * baseline is `clear` still needs the buffer for its rainy days.
 */
export function maxStorm(zone) {
  let best = baseWeather(zone).type;
  if (!zone?.indoor && best !== 'none') {
    for (const pat of zone?.forecast || []) {
      for (const s of pat.seg || []) {
        if (s.type && STORM_RANK[s.type] > STORM_RANK[best]) best = s.type;
      }
    }
  }
  return best;
}
