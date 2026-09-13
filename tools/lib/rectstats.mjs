// Luminance statistics for rectangles of a PNG, shared by tools/pixstd.mjs and tools/tour.mjs.
//
// Extracted so the tour can assert on the same numbers a human reads from pixstd. Two copies of
// this arithmetic would diverge on the one detail that matters — Rec. 709 luma rather than a
// channel mean, because "is there detail here" tracks luminance and a green field carries almost
// all of its signal in G — and then a threshold calibrated with one tool would be wrong in the
// other.
//
// Decoding happens in the browser rather than with a PNG library because puppeteer is already a
// dependency and `Image` + canvas is exact. The caller supplies the page: a browser launch is
// four seconds, and both callers measure many rects at once.
//
// NOTE for anyone tempted to measure from inside a running probe: do not open this page while a
// WebGL page is being screenshotted. Firefox throttles rAF in a backgrounded tab, the game stops
// advancing, and every later shot is a stale frame. Shoot first, close the browser, measure after.

/**
 * @param page  a puppeteer page (any page; nothing is rendered into it)
 * @param png   PNG bytes (Buffer/Uint8Array)
 * @param rects [{x, y, w, h, label}]
 * @returns [{label, n, rgb, lum, std, p5, p95}]
 */
export async function rectStats(page, png, rects) {
  const url = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  return page.evaluate(async ([url, rects]) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return rects.map((r) => {
      const d = g.getImageData(r.x, r.y, r.w, r.h).data;
      const n = d.length / 4;
      const lum = [];
      let sr = 0, sg = 0, sb = 0;
      for (let i = 0; i < d.length; i += 4) {
        sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
        lum.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
      }
      const mean = lum.reduce((a, v) => a + v, 0) / n;
      const std = Math.sqrt(lum.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
      lum.sort((a, v) => a - v);
      return {
        label: r.label, n,
        rgb: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
        lum: +mean.toFixed(1), std: +std.toFixed(1),
        // Percentiles rather than min/max: one stray bright pixel should not define the range.
        p5: Math.round(lum[Math.floor(n * 0.05)]), p95: Math.round(lum[Math.floor(n * 0.95)]),
      };
    });
  }, [url, rects]);
}

/** The one-line form pixstd prints and the tour echoes, so both logs read the same. */
export function fmtStat(r) {
  return `${r.label.padEnd(16)} rgb=${JSON.stringify(r.rgb).padEnd(18)} lum=${String(r.lum).padStart(5)}`
    + ` std=${String(r.std).padStart(5)} p5..p95=${r.p5}..${r.p95}`;
}
