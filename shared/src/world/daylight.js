// 时间与天光: one world clock, and the sky/light values every zone shows at a given hour.
//
// Why this file exists at all. `gfx/sky.js` has had a star field and a `uNight` term since it was
// written — `uStars: { value: s.stars ?? 0 }`, `uNight: { value: s.night ?? 0 }` — and **no zone
// has ever set either key**. Two shader branches, one of them 8 lines of twinkling stars, that had
// never drawn a pixel: the same defect as four animation clips nobody played, one layer further
// down. The producer they were missing is a clock, so this is it.
//
// Three decisions shape the file:
//
//  * **The clock is derived from the wall clock, not stored anywhere.** `worldClock(Date.now())`
//    is a pure function of epoch milliseconds, so every client in a session agrees on the hour
//    without a byte on the wire, 单机 agrees with 多人 for free, and a reconnect cannot desync it.
//    A day is 24 real minutes (原神's own ratio: one real second is one in-game minute).
//
//  * **Noon returns the authored values, exactly.** Every zone's `sky` block was hand-calibrated
//    against measurements — exposure, fog, ambient, the shadow tint — and there are ~500 pixel
//    assertions across `tour`, `vault-cam`, `prop-check`, `npc-cam`, `enemy-cam`, `light-space` and
//    `motion-check` standing on those numbers. So `daylight()` is built so that at 12:00 every
//    term it returns is *bit-identical* to the authored value: `day` reaches exactly 1, `night`
//    and `golden` are exactly 0, and every mix collapses to its first argument. Probes pin noon
//    and see the frame they were calibrated on; `daylight-check` asserts that identity for all six
//    zones rather than trusting it. A visual feature that silently invalidates the gates is not
//    worth having.
//
//  * **Indoor zones have no sky.** 深渊试炼场 / 冰封洞窟 / 黄金屋 are underground; their vault
//    shader has no sun in it. `daylight()` is simply never applied there, which also means half
//    the art gates cannot be moved by this feature at all.
//
// The sun's path is the great circle through the authored noon direction and the horizon. With
// `N` the authored (normalised) noon direction and `E` the horizontal unit vector perpendicular to
// it, the sun at hour angle `H` (0 at noon) is `N·cos H + E·sin H`: it is at `N` at 12:00, on the
// horizon at 06:00 and 18:00, and at `-N` at midnight. That gives an equinox day — twelve hours of
// light — and elevation `asin(sin(e₀)·cos H)`, which is the textbook formula, without needing a
// latitude or a date the game does not have.

/** One in-game day in real milliseconds. 24 minutes, i.e. 1 real second = 1 in-game minute. */
export const DAY_MS = 24 * 60 * 1000;

/** Hour angles, for anything that wants to talk about the day in words. */
export const DAWN = 6, NOON = 12, DUSK = 18;

/* ------------------------------------------------------------------ the clock -- */

/**
 * Epoch milliseconds → where we are in the in-game day.
 *
 * `dayT` is 0 at midnight and 0.5 at noon. Negative inputs are handled (the double modulo) so a
 * caller that subtracts a skew off `Date.now()` cannot produce a negative hour.
 */
export function worldClock(nowMs) {
  const ms = ((nowMs % DAY_MS) + DAY_MS) % DAY_MS;
  const dayT = ms / DAY_MS;
  return { dayT, ...clockLabel(dayT) };
}

/** `dayT` → `{ hour, minute, label }`, the form the HUD prints. */
export function clockLabel(dayT) {
  const t = ((dayT % 1) + 1) % 1;
  // The epsilon is not decoration: `dayTFromHours('7:05')` is (7 + 5/60)/24, which times 1440 is
  // 424.99999999999994, and a bare floor printed 07:04 — a clock that is a minute slow on most of
  // the day's minutes. Rounding at the seventh decimal is far below one minute (1/1440 ≈ 7e-4).
  const total = Math.floor(t * 24 * 60 + 1e-7);
  const hour = Math.floor(total / 60) % 24;
  const minute = total % 60;
  return { hour, minute, label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

/** `13`, `13.5` or `'13:30'` → `dayT`. What `game.setWorldTime` and every probe's pin go through. */
export function dayTFromHours(h) {
  let hours = h;
  if (typeof h === 'string') {
    const m = h.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
    if (!m) return null;
    hours = +m[1] + (+(m[2] || 0)) / 60;
  }
  if (!Number.isFinite(hours)) return null;
  return (((hours / 24) % 1) + 1) % 1;
}

/**
 * 白天 / 黄昏 / 夜晚, for text that has to name the time of day. Derived from the same `day` and
 * `night` curves the lighting uses rather than from hour numbers, so the word and the picture
 * cannot disagree.
 */
export function timeOfDayName(ph) {
  // `golden` is tested first on purpose. It is the only term that is high *only* near the horizon,
  // and the first version tested `night` first: at 06:00 the sun is exactly on the horizon, so
  // `night` is still 0.6 and sunrise was called 夜晚 while the screen showed an orange sky.
  if (ph.golden >= 0.35) return ph.rising ? '黎明' : '黄昏';
  if (ph.night >= 0.6) return '夜晚';
  // 正午 is a clock fact, not a light fact: `day` is a plateau at 1 for most of the afternoon, so
  // deriving it from the curve called 15:00 midday.
  if (ph.hour >= 11 && ph.hour < 13) return '正午';
  return ph.rising ? '上午' : '下午';
}

/* ------------------------------------------------------------------- the light -- */

const hexRgb = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// The three colours the day is mixed *toward*. Deliberately few: every other value in the result
// comes from the zone's own palette, so 蒙德's evening is warm over green and 龙脊's is warm over
// blue-white instead of both landing on the same postcard.
const GOLD = [1.0, 0.42, 0.16];        // low sun
const MOON = [0.42, 0.52, 0.86];       // the light after dark
const NIGHT_ZENITH = [0.022, 0.035, 0.095];
const NIGHT_HORIZON = [0.05, 0.062, 0.125];
const NIGHT_FOG = [0.055, 0.068, 0.12];
const NIGHT_AMB_SKY = [0.16, 0.20, 0.34];
const NIGHT_AMB_GROUND = [0.07, 0.08, 0.13];

/**
 * Everything the renderer needs for one instant of one zone's sky.
 *
 * Returns colours as `[r, g, b]` in **sRGB 0..1**, i.e. exactly `hex / 255`, because that is the
 * space the authored values are written in and the space `THREE.Color.setRGB(…, SRGBColorSpace)`
 * reads — which is what makes the noon identity exact rather than approximate.
 *
 *   `day`     1 at noon → 0 after dark. Every dimming term is a function of this.
 *   `night`   `1 - day`, drives the stars and thins the clouds.
 *   `golden`  0 unless the sun is within ~20° of the horizon. Warmth, dawn and dusk.
 *   `sunDir`  where the sun actually is, for the dome's disc — below the horizon at night.
 *   `lightDir` where the light comes *from*: the sun by day, its antipode (the moon) at night.
 *             Without the swap, night is lit from under the terrain and every face goes black.
 */
export function daylight(sky, dayT) {
  const N = norm(sky.sunDir);
  // Horizontal, perpendicular to the noon direction: cross(up, N). Degenerate only for a sun
  // exactly at the zenith, which is an indoor zone's near-vertical fake sun — those never get here.
  const E = norm([N[2], 0, -N[0]], [1, 0, 0]);
  const H = (dayT - 0.5) * Math.PI * 2;
  const cH = Math.cos(H), sH = Math.sin(H);
  const sunDir = [N[0] * cH + E[0] * sH, N[1] * cH + E[1] * sH, N[2] * cH + E[2] * sH];
  const sinElev = sunDir[1];

  // Exactly 1 for any sun higher than 17.5°, which every outdoor zone's noon is (0.69–0.80), so
  // the whole middle of the day is the authored frame and a probe pinned at noon is reproducible.
  // The lower edge is 12.7° *below* the horizon rather than just under it: with the first tuning
  // (-0.08) the sun sitting exactly on the horizon at 06:00 gave day 0.11, i.e. sunrise was lit
  // like midnight, and the golden sun disc hung in a black scene.
  const day = smooth(-0.22, 0.30, sinElev);
  const night = 1 - day;
  // Exactly 0 at noon for the same reason: no zone's noon sun is within 20° of the horizon.
  const golden = clamp01(1 - Math.abs(sinElev) / 0.34);
  // How far *under* the horizon the sun is, 0 for any sun that is up. Two things have to key off
  // this rather than off `night`, because `night` is already 0.6 at sunrise:
  //   * the mix toward MOON — driving it from `night` turned the 06:00 sun blue, which cancelled
  //     the golden hour exactly where it should be strongest;
  //   * the stars — at 0.955 they were plainly visible over an orange sunrise.
  // Both are properties of "the sun has set", so both are measured from the sun's own elevation.
  // Not returned: it is an internal driver, and `daylight-check` requires every returned key to
  // have a named reader — a key with no consumer is exactly how `uStars` rotted. What it does is
  // observable in `sunColor`, which is MOON exactly when it is 1.
  const dark = smooth(-0.02, -0.20, sinElev);
  const stars = smooth(-0.03, -0.26, sinElev);
  // How bright the dome itself is, as opposed to which colour it is. The two were the same term
  // until this line existed: the *only* thing that dimmed the sky between noon and sunset was the
  // mix toward NIGHT_ZENITH/NIGHT_HORIZON, so when that mix was correctly moved off `night` and
  // onto `dark` (below), 18:00 kept the whole of noon's brightness — zenith lum 185.7 against
  // noon's 203.2, an afternoon sky with an orange sun pasted in it. Worse, a near-white dome is
  // where ACES desaturates hardest, so the sunset band could not go warm however much GOLD went
  // into it (r/b 1.27 against a 1.4 bar). A real sunset sky is a mid-tone: this is that, and
  // `0.42 + 0.58 = 1` keeps noon exact. Applied *before* the night mix so the two never compound.
  const domeDim = 0.42 + 0.58 * day;

  const zenith0 = hexRgb(sky.zenithColor ?? sky.ambientSky);
  const horizon0 = hexRgb(sky.horizonColor ?? sky.fogColor);
  const sun0 = hexRgb(sky.sunColor);

  // Hue first, brightness second. Mixing toward GOLD *before* dimming is what makes 18:00 an
  // orange sun rather than a dim white one; the intensity curve then takes it down.
  let lit = mix(sun0, GOLD, golden * 0.75);
  lit = mix(lit, MOON, dark);

  return {
    // No `dayT` here on purpose: the caller passed it in, nothing read it back, and
    // `daylight-check` refuses to let this object carry a key with no reader.
    ...clockLabel(dayT),
    day,
    night,
    golden,
    stars,
    rising: sH < 0,                     // before noon the sun is climbing; used to name 黎明/黄昏
    sunDir,
    lightDir: sinElev >= 0 ? sunDir : scale(sunDir, -1),
    elevation: Math.asin(Math.max(-1, Math.min(1, sinElev))),
    sunColor: lit,
    // 0.055 + 0.945 = 1, so noon is the authored intensity to the last bit.
    sunIntensity: (sky.sunIntensity ?? 1.6) * (0.055 + 0.945 * day),
    // `gfx/terrain.js` uses `uSunColor` as its light term and never multiplies by `sunIntensity`
    // (see the note in 龙脊雪山's sky block — lowering the intensity to dim a blown-out snowfield
    // moved the ground by zero counts). So the ground's dimming has to ride on the colour, and
    // this is the value that goes into the terrain and water shaders.
    groundSunColor: scale(lit, 0.10 + 0.90 * day),
    ambientSky: mix(hexRgb(sky.ambientSky), NIGHT_AMB_SKY, night),
    ambientGround: mix(hexRgb(sky.ambientGround), NIGHT_AMB_GROUND, night),
    // Never scaled to zero: the ambient floor is the only thing keeping a night ground off 0,
    // and a channel that reaches 0 across a whole region comes out of the ACES curve as a dead
    // hole with a hard edge. 0.30 + 0.70 = 1 keeps noon exact.
    ambientIntensity: (sky.ambientIntensity ?? 0.9) * (0.30 + 0.70 * day),
    // The dome's *hue* keys off `dark` — "the sun has set" — and not off `night`. This is the
    // same defect `stars` had (see the note above it): `night` is 1 - day, and `day` only reaches
    // 1 at 17.5° of elevation, so `night` is already 0.61 with the sun sitting exactly on the
    // horizon. Driving the sky colour from it dragged the dome 61% toward midnight blue at the
    // very moment `golden` peaks at 1.0, and the two mixes cancelled into mud: 18:00 measured
    // zenith [71,76,98] over horizon [97,71,70], a near-black dome with a hard terrain edge,
    // where a sunset is the brightest and most saturated sky of the day. Brightness still rides
    // `day` — that is what `sunIntensity`/`ambientIntensity` are for; what belongs here is only
    // "which colour", and the answer changes when the sun goes down, not when it gets low.
    // The isotropic warmth is deliberately small (0.10 / 0.26, down from 0.18 / 0.55). These two
    // values are the dome's *ring*: a function of height only, identical at every azimuth, so
    // everything they carry is behind you as well as in front. Pushed hard enough to read as a
    // sunset, they made the whole sky the same orange — and `daylight-check`'s 「warmer than the
    // part of the sky facing away from it」 could then only pass on the Mie halo. What a sunset
    // actually is — a warm band *around the sun*, blue overhead and behind — is direction, so it
    // lives in the shader, keyed off `golden` and `sunsetColor`. See SKY_FRAG's golden-hour block.
    zenith: mix(scale(mix(zenith0, GOLD, golden * 0.10), domeDim), NIGHT_ZENITH, dark),
    horizon: mix(scale(mix(horizon0, GOLD, golden * 0.26), domeDim), NIGHT_HORIZON, dark),
    // The colour of that band, at full strength. Built from the zone's own horizon so 蒙德's dusk
    // is warm over its pale blue and 龙脊's over its ice, rather than both landing on GOLD; the
    // shader is what decides *where* it applies, and at noon `golden` is 0 so it applies nowhere.
    sunsetColor: mix(mix(horizon0, GOLD, 0.82), NIGHT_HORIZON, dark * 0.6),
    // Fog tracks the far sky. A zone whose fog stays bright while its dome goes dark photographs
    // as an overcast noon at midnight — the same failure as a cave lit by its own fog.
    fogColor: mix(scale(mix(hexRgb(sky.fogColor), GOLD, golden * 0.45), 0.55 + 0.45 * day),
      NIGHT_FOG, dark * 0.92),
  };
}

function norm(v, fallback = [0, 1, 0]) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l] : fallback.slice();
}
