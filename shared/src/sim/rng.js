// Deterministic RNG shared by client and server so procedural worlds match.

export function hash32(x) {
  x |= 0;
  x = (x + 0x7ed55d16 + (x << 12)) | 0;
  x = (x ^ 0xc761c23c ^ (x >>> 19)) | 0;
  x = (x + 0x165667b1 + (x << 5)) | 0;
  x = ((x + 0xd3a2646c) ^ (x << 9)) | 0;
  x = (x + 0xfd7046c5 + (x << 3)) | 0;
  x = (x ^ 0xb55a4f09 ^ (x >>> 16)) | 0;
  return x >>> 0;
}

export function hash2(x, y, seed = 0) {
  return hash32(hash32(x * 374761393 + y * 668265263) ^ hash32(seed + 0x9e3779b9));
}

/**
 * FNV-1a over a string, for seeding anything keyed by a name.
 *
 * Written because the streamed scatter was seeding each group from `group.length`, and
 * 'trees' and 'rocks' are both five characters long: the two groups drew the identical
 * sequence of candidate cell coordinates, so their props were placed in lockstep and the
 * first accepted rock in a cell landed inside the first accepted tree. Photographing the
 * nearest 'rock' and the nearest 'oak' in Mondstadt returned the same world position to
 * a tenth of a metre, which is how it surfaced. Any name-derived seed has to depend on
 * the whole name.
 */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Mulberry32 — small, fast, seedable. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rand {
  constructor(seed = 1) {
    this.next = mulberry32(seed);
  }
  float(a = 0, b = 1) {
    return a + (b - a) * this.next();
  }
  int(a, b) {
    return Math.floor(this.float(a, b + 1));
  }
  pick(arr) {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }
  chance(p) {
    return this.next() < p;
  }
  /** Weighted pick: entries are [value, weight]. */
  weighted(entries) {
    let total = 0;
    for (const e of entries) total += e[1];
    let r = this.next() * total;
    for (const e of entries) {
      r -= e[1];
      if (r <= 0) return e[0];
    }
    return entries[entries.length - 1][0];
  }
  angle() {
    return this.next() * Math.PI * 2;
  }
}

/** 2D value noise with smooth interpolation. */
export function valueNoise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const n00 = hash2(xi, yi, seed) / 4294967296;
  const n10 = hash2(xi + 1, yi, seed) / 4294967296;
  const n01 = hash2(xi, yi + 1, seed) / 4294967296;
  const n11 = hash2(xi + 1, yi + 1, seed) / 4294967296;
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

/** Fractal Brownian motion over value noise. Returns roughly [0,1]. */
export function fbm2(x, y, { octaves = 5, lacunarity = 2.0, gain = 0.5, seed = 0 } = {}) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged noise — good for mountain spines and karst pillars. */
export function ridged2(x, y, { octaves = 4, lacunarity = 2.0, gain = 0.5, seed = 0 } = {}) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, y * freq, seed + i * 7717) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};
export const TAU = Math.PI * 2;
