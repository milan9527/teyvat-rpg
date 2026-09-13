// Minimal PNG reader + rectangle statistics, for probes that measure their own screenshots.
//
// Exists because the obvious way to measure a screenshot — decode it in a browser page with
// `getImageData` — costs a *second page*, and a second page steals focus: Firefox then
// throttles requestAnimationFrame on the backgrounded game page to well under 1 fps, so
// every screenshot after the first is the same stale frame. tools/grade-ab.mjs spent two
// runs reporting that disabling the entire colour-grade pass changed nothing before its
// controls (a red tint, a 90° yaw) caught it. Decoding here keeps the game page frontmost
// and alone.
//
// Scope is deliberately just what puppeteer emits: 8-bit non-interlaced RGB/RGBA.

import zlib from 'node:zlib';

/** Decode a PNG buffer to `{ width, height, data }` with `data` as tightly packed RGBA. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') break;
    off += 12 + len;               // length + type + body + crc
  }
  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: depth ${depth} colorType ${colorType} interlace ${interlace}`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    // Reverse the per-scanline filter. `a` is the pixel to the left, `b` above, `c` above-left.
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4 + 0] = line[x * bpp + 0];
      out[(y * width + x) * 4 + 1] = line[x * bpp + 1];
      out[(y * width + x) * 4 + 2] = line[x * bpp + 2];
      out[(y * width + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

/**
 * Mean colour, Rec. 709 luma mean/std and percentiles over one rectangle, plus `clip`: the
 * fraction of pixels with red or green pinned at 0. A dark region and a *clipped* region
 * have the same mean and are told apart only by that fraction.
 */
export function rectStats(img, r) {
  const { width, data } = img;
  const lum = [];
  let sr = 0, sg = 0, sb = 0, clipped = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * width + x) * 4;
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2];
      if (data[i] === 0 || data[i + 1] === 0) clipped++;
      lum.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    }
  }
  const n = lum.length;
  const mean = lum.reduce((a, v) => a + v, 0) / n;
  const std = Math.sqrt(lum.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  const sorted = [...lum].sort((a, v) => a - v);
  return {
    label: r.label, n,
    rgb: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
    lum: +mean.toFixed(1), std: +std.toFixed(1), clip: +(clipped / n).toFixed(2),
    p5: Math.round(sorted[Math.floor(n * 0.05)]), p95: Math.round(sorted[Math.floor(n * 0.95)]),
  };
}

/**
 * The pixels that changed between two frames, as a mask — "which part of the screen is this
 * object?" answered by hiding it rather than by a hand-typed rectangle.
 *
 * Every rect in this repo's probes is a guess about where something will land, and the guesses
 * rot: npc-cam graded an adeptus on a rect that had drifted onto the water she stands in, and
 * vault-cam's bands are the middle 60% of the width precisely to dodge the HUD. A mask has no
 * such drift — it is the object's own silhouette, at whatever size the framing gave it — and it
 * comes with a control for free, because a mask of zero pixels means the thing was never drawn.
 *
 * `tol` is in sRGB bytes on the largest-moving channel: 8 is above llvmpipe's dither and FXAA's
 * edge shimmer, and well under any albedo difference that matters.
 */
export function diffMask(a, b, tol = 8) {
  const { width, height } = a;
  const mask = new Uint8Array(width * height);
  let count = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.abs(a.data[i] - b.data[i]) > tol
        || Math.abs(a.data[i + 1] - b.data[i + 1]) > tol
        || Math.abs(a.data[i + 2] - b.data[i + 2]) > tol) {
        mask[y * width + x] = 1;
        count++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  // `fill` separates a silhouette from a scattering: one prop fills a good half of its own
  // bounding box, while a mask spread thinly over the frame (a whole batch hidden, a global
  // exposure shift) fills a few percent of a box the size of the screen.
  const boxArea = x1 < 0 ? 0 : (x1 - x0 + 1) * (y1 - y0 + 1);
  return {
    mask, count, width, height,
    box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
    fill: boxArea ? +(count / boxArea).toFixed(2) : 0,
    frac: +(count / (width * height)).toFixed(4),
  };
}

/** `rectStats` over a `diffMask` instead of a rectangle: same numbers, arbitrary shape. */
export function maskStats(img, m, label = 'mask') {
  const { width, data } = img;
  const lum = [];
  let sr = 0, sg = 0, sb = 0, clipped = 0;
  for (let i = 0, px = 0; i < m.mask.length; i++) {
    if (!m.mask[i]) continue;
    px = i * 4;
    sr += data[px]; sg += data[px + 1]; sb += data[px + 2];
    if (data[px] === 0 || data[px + 1] === 0) clipped++;
    lum.push(0.2126 * data[px] + 0.7152 * data[px + 1] + 0.0722 * data[px + 2]);
  }
  const n = lum.length;
  if (!n) return { label, n: 0, rgb: [0, 0, 0], lum: 0, std: 0, clip: 0, p5: 0, p95: 0 };
  const mean = lum.reduce((a, v) => a + v, 0) / n;
  const std = Math.sqrt(lum.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  const sorted = [...lum].sort((a, v) => a - v);
  return {
    label, n,
    rgb: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
    lum: +mean.toFixed(1), std: +std.toFixed(1), clip: +(clipped / n).toFixed(2),
    p5: Math.round(sorted[Math.floor(n * 0.05)]), p95: Math.round(sorted[Math.floor(n * 0.95)]),
    width,
  };
}

/**
 * The largest connected patch of *one luminance* inside a mask — "how big is the flattest part of
 * this thing?", the model-space twin of the ground-detail std gate.
 *
 * The wash gate asks whether a part is blown out to white. It is blind to the other half of the
 * same defect: a wide face painted in one light material, which is not white, has plenty of hue,
 * and still reads as a flat slab — 53 cm of `metal` pauldron came out at 17 px of "wash" and 0.02 %
 * in one patch while being the brightest, flattest thing on the model. What the eye objects to
 * there is not the brightness, it is that a hand-sized surface has no gradient, no course, no
 * inset: one value across hundreds of pixels.
 *
 * So: bin luminance into bands of `band` counts and take the biggest 8-connected component of one
 * band. A curved lit surface crosses bands every few pixels, so its patches are stripes; a flat
 * plate facing one light is a single patch the size of the plate. The bin grid is run twice, offset
 * by half a band, because a plate whose values straddle a bin edge would otherwise be split in two
 * and score half of what it should — the answer is the larger of the two readings.
 *
 * Deliberately not seed-relative growth ("within ±3 of where I started"): that merges a whole
 * smooth gradient one count at a time, so a cylinder reads as flat as a slab.
 */
export function flatPatch(img, m, band = 6) {
  const { width, height, mask } = m;
  const { data } = img;
  const lum = new Float32Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const px = i * 4;
    lum[i] = 0.2126 * data[px] + 0.7152 * data[px + 1] + 0.0722 * data[px + 2];
  }
  let best = { count: 0, lum: 0, box: null };
  for (const shift of [0, band / 2]) {
    const bin = new Int32Array(width * height).fill(-1);
    for (let i = 0; i < mask.length; i++) if (mask[i]) bin[i] = Math.floor((lum[i] + shift) / band);
    const seen = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      const b = bin[start];
      let head = 0, tail = 0, sum = 0;
      let x0 = width, y0 = height, x1 = -1, y1 = -1;
      queue[tail++] = start; seen[start] = 1;
      while (head < tail) {
        const i = queue[head++];
        const x = i % width, y = (i - x) / width;
        sum += lum[i];
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if ((!dx && !dy) || nx < 0 || nx >= width) continue;
            const j = ny * width + nx;
            if (mask[j] && !seen[j] && bin[j] === b) { seen[j] = 1; queue[tail++] = j; }
          }
        }
      }
      if (tail > best.count) {
        best = { count: tail, lum: +(sum / tail).toFixed(1), box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
      }
    }
  }
  return { ...best, frac: +(best.count / Math.max(1, m.count)).toFixed(4) };
}

/**
 * The subject's own connected pixels, with unattached specks dropped — "which part of this mask is
 * the *object*?" when the mask also caught something that moved elsewhere in the frame.
 *
 * A `diffMask` is only as clean as its background shot. `motion-check` takes one background frame
 * and compares two dozen poses against it, so anything that drifts in the meantime — the sky, a
 * cloud edge, a distant banner — lands in every mask. A 4-px speck near the top of the frame is
 * nothing by pixel count (4 of 17452) and invisible to any pixel floor, but it is 177 px *above*
 * the character's head, and a bounding box does not care how many pixels voted: the idle box went
 * from `95x305 @456,261` to `95x482 @456,84` at an unchanged pixel count, and the climb-reaches-
 * higher-than-standing assertion failed by one pixel against a box top that was a piece of sky.
 * Row/column density floors do not help, because a speck 4 px wide clears 2 % of a 90-px peak row.
 *
 * Connectivity is 8-way, so a limb joined to the torso only diagonally stays with it. Components
 * at least `minFrac` of the largest are kept, not just the single largest: a drawn weapon or a
 * hair strand can photograph as its own island, and throwing those away would shrink real poses.
 * Anything smaller is not part of the subject at any plausible framing.
 */
export function largestBlob(m, minFrac = 0.02) {
  const { width, height, mask } = m;
  const label = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  const sizes = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = sizes.length;
    let head = 0, tail = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % width, y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((!dx && !dy) || nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (mask[j] && label[j] < 0) { label[j] = id; queue[tail++] = j; }
        }
      }
    }
    sizes.push(tail);
  }
  const peak = sizes.length ? Math.max(...sizes) : 0;
  const floor = peak * minFrac;
  const keep = sizes.map((n) => n >= floor);
  const out = new Uint8Array(width * height);
  let count = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || !keep[label[i]]) continue;
    out[i] = 1;
    count++;
    const x = i % width, y = (i - x) / width;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const boxArea = x1 < 0 ? 0 : (x1 - x0 + 1) * (y1 - y0 + 1);
  return {
    mask: out, count, width, height,
    box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
    fill: boxArea ? +(count / boxArea).toFixed(2) : 0,
    frac: +(count / (width * height)).toFixed(4),
    blobs: sizes.length, kept: keep.filter(Boolean).length, dropped: m.count - count,
  };
}

/**
 * Grow a mask by `r` pixels in every direction — the step that has to come before any
 * connectivity question about geometry.
 *
 * A rasterised silhouette is full of hairlines. `enemy-cam`'s model sheet caught the ruin guard's
 * head as a *separate component* from directly behind, and the second component was 3292 px with
 * a bounding box whose bottom edge was exactly one row above the torso's top edge: the collar and
 * the skull touch, but not on any pixel this framing sampled. A 1-px seam is not a model that
 * came apart, while the defect the gate exists for — the frost wolf's hindquarters — was 34 cm of
 * daylight, tens of pixels at any useful framing. Closing 1-2 px keeps the second reading and
 * throws away the first.
 */
export function dilateMask(m, r = 2) {
  const { width, height, mask } = m;
  const out = new Uint8Array(width * height);
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (!out[j]) { out[j] = 1; count++; }
        }
      }
    }
  }
  return { mask: out, count, width, height };
}

/** How many of a `diffMask`'s pixels fall inside a rectangle — "is the change where it belongs?" */
export function maskInRect(m, r) {
  let n = 0;
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(m.width - 1, Math.ceil(r.x + r.w)), y1 = Math.min(m.height - 1, Math.ceil(r.y + r.h));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) if (m.mask[y * m.width + x]) n++;
  }
  return n;
}

/** How many pixels differ by more than `tol` in any channel — a probe's own staleness check. */
export function pixelsDiffering(a, b, tol = 2) {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) > tol
      || Math.abs(a.data[i + 1] - b.data[i + 1]) > tol
      || Math.abs(a.data[i + 2] - b.data[i + 2]) > tol) n++;
  }
  return n;
}
