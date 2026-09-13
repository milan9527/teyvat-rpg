// Like /tmp/pix.mjs but reports the *spread* of a rectangle, not just its mean.
//
// Written because "the ground looks flat" is not a measurement, and this project has
// already wasted a round of work on a defect that turned out to be a camera artifact. A
// mean tells you the tone; the standard deviation tells you whether there is any detail
// there at all. Rule of thumb for these screenshots: std under ~4 sRGB over a metre-scale
// patch is genuinely featureless, 8-15 is normal ground, over 20 means edges dominate.
//
// The trap this tool sets, learned the expensive way: it answers precisely, about whatever
// rectangle you gave it, and it cannot tell you that you aimed at the wrong thing. A pine in
// the Mondstadt gameplay frame sampled at luma 38-52 against ground at 126, with red at 4
// out of an albedo red of 47, which looks exactly like a lighting bug and bought two changes
// to the shade path (a per-material shadow floor, then a doubled shadow tint). Both moved
// the number by less than two, because the rectangles were never on the tree — rendered
// isolated with tools/prop-cam.mjs the same pine is bright saturated green and its real
// fault is its silhouette. A high std with a wide p5..p95 is the tell for a *mixed* region:
// it means edges and background, not texture. Confirm framing with prop-cam, or by reading
// the screenshot, before believing any rectangle sampled out of a cluttered frame.
//
// The arithmetic itself lives in tools/lib/rectstats.mjs, because tools/tour.mjs now asserts on
// the same numbers and a threshold calibrated here has to mean the same thing there.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { rectStats, fmtStat } from './lib/rectstats.mjs';

const file = process.argv[2];
// Any number of "x,y,w,h,label" rects, so one browser launch answers the whole question.
const rects = process.argv.slice(3).map((s) => {
  const [x, y, w, h, label] = s.split(',');
  return { x: +x, y: +y, w: +w, h: +h, label: label ?? `${x},${y}` };
});

const b = await puppeteer.launch({ browser: 'firefox', headless: true });
const p = await b.newPage();
for (const r of await rectStats(p, fs.readFileSync(file), rects)) console.log(fmtStat(r));
await b.close();
