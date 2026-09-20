// 头发高光: the shape of the hair highlight, measured as its own mask.
//
// Why this probe exists. `hairMaterial`'s docstring has always said "an anisotropic band
// highlight, drawn as a stretched specular" and the shader has always been isotropic
// Blinn-Phong — `pow(dot(N, H), ~173)` stepped over 0.06. On a skull-shaped cap that is not a
// band and not stretched: it is a *point*. Photographed at portrait size (a 700 px frame with the
// head filling 62% of it) the largest piece of the highlight was a 41x43 px disc filling 76% of
// its own bounding box, in the same place on the crown of every character — a coin stuck on the
// hair, which is exactly what it looked like. `uSpecAniso` replaces the lobe with a Kajiya-Kay
// strand lobe whose highlight runs *across* the strands; the same measurement now reads a 263 px
// arc 18 px thick following the curve of the skull, plus a band along each lock at the nape.
//
// Method. The mask is the product's own control: pushing `uSpecStep` past 1 makes the smoothstep
// 0, so `mix(col, uSpecColor, 0.0)` is the same frame *without* the highlight, exactly. Diff the
// two and what is left is the highlight and nothing else — no threshold on brightness, no guess
// about where to look, and it works on pale hair where the sheen is deliberately scaled back to
// a Δ of 14 (see hairMaterial: at full strength the near-white hair colours clip and the
// silhouette reads as bald).
//
// Every bar is denominated in the head's own on-screen diameter, not in pixels of this viewport,
// and priced against the hair actually in shot (see __hairArea), not against the frame: a
// waist-length style puts 360k hair pixels on screen where a bob puts 89k, and a ceiling in raw
// pixels calls the first one a defect. The five claims are paired so that no half of one can be
// satisfied by cheating the other:
//
//   * the sheen exists — so deleting it fails;
//   * the sheen has not swallowed the hair — so widening the band into a wash fails. Two versions
//     of this shader did exactly that, one at 24% of the hair and one at 49%;
//   * some piece of it runs a good way across the hair — so a mask of crumbs fails. A tangent
//     shift that chopped the band into a lattice of 925 pieces failed here;
//   * that piece is much longer than the mask is thick — the scale-free half of the same claim,
//     and the one that actually separates a band from a spot: a band measures 3.4 to 21.6, the
//     coin measured 1.4;
//   * and nothing anywhere in it is thicker than a band, measured as the largest square that fits
//     inside the mask. Note this bar does *not* catch the original coin (31 px thick, under the
//     37 px ceiling) and the coin bar does not catch a 60 px pool of sheen on a smooth hair mass
//     (fill 0.33, too ragged to be a coin). Each caught a defect the other let through, which is
//     why both are here.
//
// Dividing a piece's area by its longest side is *not* a thickness measurement, and believing it
// was cost a day: for a network of k bands each t thick it returns k*t, so it counts bands. It
// reported an "83 px slab" on a picture that was a lattice of 15 px bands which happened to touch,
// and the shader change made to fix that non-defect made the sheen measurably worse.
//
// Restoring `specAniso: 0` (the shipped isotropic lobe) turns 49 of these rows red: every "asks
// for the strand lobe", 13 "exists", 11 "runs across", 5 "long for its thickness" and 13 coins.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { INSTALL } from './lib/probe-world.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/hair-sheen'; })();
// Force the hair's uSpecAniso, for the mutation run: --aniso 0 is the shipped isotropic lobe.
const anisoOverride = (() => { const i = argv.indexOf('--aniso'); return i >= 0 ? +argv[i + 1] : null; })();
fs.mkdirSync(outDir, { recursive: true });
const W = 700, H = 700;
const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every character the game ships, because the defect was a function of the *shader*, not of one
// head: the disc landed on all seven. Three views each — front, three-quarter, side — because a
// band is a shape and one azimuth cannot tell a band from a stripe.
const WHO = ['lyra', 'ignar', 'seris', 'kaelen', 'volt', 'terra', 'nyx'];
const YAWS = [0, 30, 90];
const FILL = 0.62;                       // head diameter as a fraction of frame height
const HEAD_DIA = FILL * H;               // px
// The sheen is priced against the hair it sits on (see __hairArea), not against the frame.
// This floor only says the sheen exists. It cannot also say "and it is a band", because the two
// distributions overlap: the shipped coin covered up to 2.9 % of the hair and the band covers as
// little as 2.1 % on a side view of the longest hairstyle, where most of the hair in shot is a
// mass the light never reaches. The band claim is the three shape bars below.
const MIN_FRAC = 0.012;
const MAX_FRAC = 0.24;                   // ... and is still a highlight, not a wash
const MIN_BAND_SPAN = 0.18 * HEAD_DIA;   // some piece of it runs across the head
// ... and is much longer than it is thick, which is the scale-free half of the same claim and the
// one that actually separates a band from a spot. Absolute length cannot: volt's crown is short
// spikes, so its side view's longest band is 99 px where lyra's is 259, and both are bands. The
// measured range on the shipped build is 3.4 (the thickest view of the longest hairstyle) to 21.6;
// the coin this unit removed measured 43 px long over 31 px thick, i.e. 1.4.
const MIN_SLENDER = 2.5;
const MAX_THICK = 0.085 * HEAD_DIA;      // ... and none of it is thicker than this. Measured as
                                         // the largest square that fits inside the mask (×2), so
                                         // branchiness and connectivity cannot flatter or damn it;
                                         // `fill` cannot say this either — a *straight* band fills
                                         // its own bounding box, and one of nyx's reads 0.70.
const COIN_FILL = 0.55;                  // a coin is solid,
const COIN_MIN_DIM = 0.074 * HEAD_DIA;   // thick in *both* directions,
const COIN_ASPECT = [0.6, 1.8];          // and roughly round
const MIN_PIECE = 300;                   // px; below this a piece is an aliasing crumb

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); } else {
    fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
};
const skipped = (name, why) => { skip++; console.log(`  SKIP ${name} — ${why}`); };

const tokFile = '/tmp/world-token.txt';
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
  defaultViewport: { width: W, height: H },
});
const p = await b.newPage();
const errs = [], hmr = [], glsl = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => {
  const t = m.text();
  if (/hmr|hot updated/i.test(t)) hmr.push(t);
  // A GLSL compile error is not a page error and not an exception: three.js logs it and carries
  // on drawing nothing. Referring to `modelMatrix` in the fragment shader (it is declared in
  // three's vertex prefix only) cost a whole run of zeroes before this line existed.
  if (/shader error|INVALID_OPERATION|compile.*shader|ERROR: 0:/i.test(t)) glsl.push(t.slice(0, 200));
});
await p.goto(origin, { waitUntil: 'domcontentloaded' });
await p.evaluate((t) => localStorage.setItem('teyvat.token', t), token);
await p.reload({ waitUntil: 'domcontentloaded' });
await sleep(5000);
if (await p.$('[data-act="resume"]')) await p.click('[data-act="resume"]');
for (let i = 0; i < 90; i++) {
  if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) break;
  await sleep(1000);
}
await sleep(4000);
if (!await p.evaluate(() => !!window.game?._running)) {
  console.log('the world never started');
  console.log(`\n${pass} passed, ${fail + 1} failed, ${skip} skipped`);
  await b.close();
  process.exit(1);
}
await p.evaluate(INSTALL);
// llvmpipe boots every browser at `low`, and `low` is not the picture anyone ships.
await p.evaluate(() => {
  window.game.setAutoQuality(false);
  window.game.setQuality('high');
  window.game.setWorldTime(12);
});
await sleep(3000);
check('the quality tier is pinned to high', await p.evaluate(() => window.game.quality) === 'high');
// Stop the loop: a highlight is measured by rendering the same camera twice with one uniform
// changed, and that is only a controlled experiment if nothing else moves between the two frames.
await p.evaluate(() => { window.game.stop(); });
await sleep(300);
const iso = await p.evaluate(() => window.__isolate([window.game.me.actor.group]));
check('the world is hidden and only the character is left', iso.hidden > 0, `${iso.hidden} hidden`);

await p.evaluate(`(() => {
  const wp = (o) => { const e = o.matrixWorld.elements; return [e[12], e[13], e[14]]; };
  window.__aim = (yawDeg, fill) => {
    const g = window.game, a = g.me.actor, rig = a.rig, cam = g.camera;
    a.group.rotation.y = 0;
    rig.group.updateMatrixWorld(true);
    const head = wp(rig.bones.head);
    const R = rig.P.headR;
    const tgt = [head[0], head[1] + R * 0.05, head[2]];
    const fov = 30, dist = (R * 2 / fill) / (2 * Math.tan((fov / 2) * Math.PI / 180));
    const yaw = (yawDeg * Math.PI) / 180;
    cam.fov = fov;
    cam.position.set(tgt[0] + Math.sin(yaw) * dist, tgt[1], tgt[2] + Math.cos(yaw) * dist);
    cam.lookAt(tgt[0], tgt[1], tgt[2]);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    g.world.sky.update(0.016, cam, tgt[0], tgt[1], tgt[2]);
    return { headR: +R.toFixed(4), dist: +dist.toFixed(3) };
  };
  window.__pick = async (cid) => {
    const a = window.game.me.actor;
    await a.setCharacter(cid);
    let guard = 0;
    while (a.animator.busy && guard++ < 80) a.update(0.05, 0, { speed: 0, grounded: true, auto: false });
    a.animator.play('idle');
    a.update(0.05, 0, { speed: 0, grounded: true, auto: true });
    return { charId: a.charId };
  };
  // Read the frame back out of the driver. render() only queues work, so readPixels is also what
  // makes the picture exist before it is measured — a sleep here measures the previous camera.
  window.__grab = () => {
    const g = window.game;
    const gl = g.r.renderer.getContext();
    for (let k = 0; k < 3; k++) g.r.render(0.016);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { w, h, px };
  };
  // The toon uniforms live in mat.userData.toon (they are merged into shader.uniforms inside
  // onBeforeCompile), so a material never has a .uniforms of its own to look in.
  window.__toonMats = () => {
    const m = window.game.me.actor.rig.materials;
    return Object.entries(m).filter(([, x]) => x && x.userData && x.userData.toon);
  };
  window.__hairMats = () => window.__toonMats()
    .filter(([k]) => k === 'matHair' || k === 'matHairB').map(([, x]) => x);
  window.__anisoMats = () => window.__toonMats()
    .filter(([, x]) => x.userData.toon.uSpecAniso.value > 0.001).map(([k]) => k).sort();
  window.__setAniso = (v) => window.__hairMats().forEach((m) => { m.userData.toon.uSpecAniso.value = v; });
  window.__diff = (a, b, tol) => {
    let n = 0;
    for (let i = 0; i < a.w * a.h; i++) {
      const d = Math.abs(a.px[i * 4] - b.px[i * 4]) + Math.abs(a.px[i * 4 + 1] - b.px[i * 4 + 1])
        + Math.abs(a.px[i * 4 + 2] - b.px[i * 4 + 2]);
      if (d > tol) n++;
    }
    return n;
  };
  // How much hair is in this shot, so the highlight can be priced against the thing it sits on
  // instead of against the viewport: hide the hair materials and count what disappears. A head
  // whose hair reaches the shoulders puts three times as many hair pixels on screen as a bob,
  // and a ceiling in raw pixels calls that a defect.
  window.__hairArea = () => {
    const mats = window.__hairMats();
    const on = window.__grab();
    mats.forEach((m) => { m.visible = false; });
    const off = window.__grab();
    mats.forEach((m) => { m.visible = true; });
    for (let k = 0; k < 3; k++) window.game.r.render(0.016);
    return window.__diff(on, off, 10);
  };

  /**
   * The highlight's own mask: this frame minus the same frame with the highlight step pushed past
   * 1. Returns the mask's area and every connected piece of it worth naming.
   */
  window.__sheen = (tol = 10) => {
    const on = window.__grab();
    const mats = window.__hairMats();
    const keep = mats.map((m) => m.userData.toon.uSpecStep.value);
    mats.forEach((m) => { m.userData.toon.uSpecStep.value = 2.0; });
    const off = window.__grab();
    mats.forEach((m, i) => { m.userData.toon.uSpecStep.value = keep[i]; });
    // The last frame drawn is the frame a screenshot shows, and that was the *off* frame: put
    // the highlight back on the canvas or every picture this probe files is the picture without it.
    for (let k = 0; k < 3; k++) window.game.r.render(0.016);
    const { w, h } = on;
    const mask = new Uint8Array(w * h);
    let area = 0, sum = 0;
    for (let i = 0; i < w * h; i++) {
      const d = Math.abs(on.px[i * 4] - off.px[i * 4])
        + Math.abs(on.px[i * 4 + 1] - off.px[i * 4 + 1])
        + Math.abs(on.px[i * 4 + 2] - off.px[i * 4 + 2]);
      if (d <= tol) continue;
      mask[i] = 1; area++; sum += d;
    }
    const seen = new Uint8Array(w * h);
    const pieces = [];
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || seen[i]) continue;
      let n = 0; const st = [i]; seen[i] = 1;
      let bb = [1e9, 1e9, -1e9, -1e9];
      while (st.length) {
        const c = st.pop(); n++;
        const x = c % w, y = (c / w) | 0;
        bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)];
        for (const d of [1, -1, w, -w]) {
          const k = c + d;
          if (k < 0 || k >= w * h || !mask[k] || seen[k]) continue;
          if (d === 1 && k % w === 0) continue;       // do not wrap round the right edge
          if (d === -1 && c % w === 0) continue;
          seen[k] = 1; st.push(k);
        }
      }
      const pw = bb[2] - bb[0] + 1, ph = bb[3] - bb[1] + 1;
      pieces.push({ n, w: pw, h: ph, fill: +(n / (pw * ph)).toFixed(3), aspect: +(pw / ph).toFixed(2) });
    }
    pieces.sort((a, b) => b.n - a.n);

    // How thick the highlight is, without asking connectivity anything. Dividing a piece's area
    // by its longest side does not measure thickness: for a network of k bands each t thick and L
    // long it returns k*t, so it counts bands. It called kaelen's sheen an "83 px slab" when the
    // picture was a lattice of 15 px bands that happened to touch. The largest square that fits
    // inside the mask does not care: it is t/2 for a band of any length or branchiness, and ~R for
    // a disc of radius R. Chessboard distance transform, two passes, exact for the 8-neighbour
    // chamfer; outside the frame counts as background.
    const dist = new Int32Array(w * h);
    const BIG = 1 << 20;
    for (let i = 0; i < w * h; i++) dist[i] = mask[i] ? BIG : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        let m = y === 0 || x === 0 || x === w - 1 ? 0 : BIG;
        if (y > 0) {
          m = Math.min(m, dist[i - w]);
          if (x > 0) m = Math.min(m, dist[i - w - 1]);
          if (x < w - 1) m = Math.min(m, dist[i - w + 1]);
        }
        if (x > 0) m = Math.min(m, dist[i - 1]);
        dist[i] = Math.min(dist[i], m + 1);
      }
    }
    let maxR = 0, maxRx = 0, maxRy = 0;
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!mask[i]) continue;
        let m = y === h - 1 || x === 0 || x === w - 1 ? 0 : BIG;
        if (y < h - 1) {
          m = Math.min(m, dist[i + w]);
          if (x > 0) m = Math.min(m, dist[i + w - 1]);
          if (x < w - 1) m = Math.min(m, dist[i + w + 1]);
        }
        if (x < w - 1) m = Math.min(m, dist[i + 1]);
        dist[i] = Math.min(dist[i], m + 1);
        if (dist[i] > maxR) { maxR = dist[i]; maxRx = x; maxRy = y; }
      }
    }
    return {
      w, h, area, mean: +(sum / (area || 1)).toFixed(1),
      nPieces: pieces.length, pieces: pieces.slice(0, 24),
      maxR, maxRAt: [maxRx, h - 1 - maxRy],
    };
  };
})()`);

/* ------------------------------------------------- 1. the camera is on the hair -- */
// A control that must move: repaint the hair and the frame has to change by tens of thousands of
// pixels. Without it every "mask 0 px" below would be indistinguishable from a probe measuring
// the wrong object — which is how the first draft of this file spent two runs reading zeroes.
await p.evaluate((c) => window.__pick(c), 'ignar');
await p.evaluate((y, f) => window.__aim(y, f), 90, FILL);
const ctl = await p.evaluate(() => {
  const mats = window.__hairMats();
  const keep = mats.map((m) => m.color.clone());
  const on = window.__grab();
  mats.forEach((m) => m.color.setHex(0xff00ff));
  const off = window.__grab();
  mats.forEach((m, i) => m.color.copy(keep[i]));
  for (let k = 0; k < 3; k++) window.game.r.render(0.016);
  let n = 0;
  for (let i = 0; i < on.w * on.h; i++) {
    const d = Math.abs(on.px[i * 4] - off.px[i * 4]) + Math.abs(on.px[i * 4 + 1] - off.px[i * 4 + 1])
      + Math.abs(on.px[i * 4 + 2] - off.px[i * 4 + 2]);
    if (d > 10) n++;
  }
  return { changed: n, mats: mats.length };
});
check('every shader compiled', glsl.length === 0, glsl.slice(0, 1).join(' | '));
check('the hair materials are reachable', ctl.mats >= 1, `${ctl.mats} material(s)`);
check('repainting the hair changes the frame', ctl.changed > 50000, `${ctl.changed} px of ${W * H}`);

/* ----------------------------------------------- 2. the shape of the highlight -- */
console.log(`\nhead ${HEAD_DIA.toFixed(0)} px across; the sheen must cover`
  + ` ${(100 * MIN_FRAC).toFixed(0)}-${(100 * MAX_FRAC).toFixed(0)}% of the hair in shot,`
  + ` span ≥ ${MIN_BAND_SPAN.toFixed(0)} px and stay ≤ ${MAX_THICK.toFixed(0)} px thick`);
if (anisoOverride !== null) console.log(`!! uSpecAniso forced to ${anisoOverride}`);

for (const cid of WHO) {
  const got = await p.evaluate((c) => window.__pick(c), cid);
  if (got.charId !== cid) { skipped(`${cid}: the character loaded`, `got ${got.charId}`); continue; }
  if (anisoOverride !== null) await p.evaluate((v) => window.__setAniso(v), anisoOverride);
  // Only hair asks for the strand lobe. Every other material's uSpecAniso is 0, which is what
  // makes this change bit-identical for skin, cloth and metal: at 0 the whole block is skipped.
  const an = await p.evaluate(() => window.__anisoMats());
  check(`${cid}: only the hair uses the strand lobe`,
    an.every((k) => k === 'matHair' || k === 'matHairB'),
    an.length ? an.join(',') : 'none');
  check(`${cid}: the hair asks for the strand lobe`,
    await p.evaluate(() => window.__hairMats().every((m) => m.userData.toon.uSpecAniso.value > 0.9)),
    `${an.length} of the rig's materials`);
  console.log(`  ${cid}:`);
  for (const yaw of YAWS) {
    const info = await p.evaluate((y, f) => window.__aim(y, f), yaw, FILL);
    const hairPx = await p.evaluate(() => window.__hairArea());
    const s = await p.evaluate(() => window.__sheen());
    const big = s.pieces[0] || { n: 0, w: 0, h: 0, fill: 0, aspect: 0 };
    // The longest piece anywhere, not the largest by area: a mask that has broken into a dozen
    // bands is *more* banded, and judging its reach by whichever piece happens to hold the most
    // pixels marks that down. lyra's front view reads 43 px by area and 300 px by length.
    const span = Math.max(...s.pieces.filter((q) => q.n >= MIN_PIECE).map((q) => Math.max(q.w, q.h)), 0);
    const frac = s.area / Math.max(hairPx, 1);
    const coins = s.pieces.filter((q) => q.n >= MIN_PIECE && q.fill >= COIN_FILL
      && Math.min(q.w, q.h) >= COIN_MIN_DIM && q.aspect >= COIN_ASPECT[0] && q.aspect <= COIN_ASPECT[1]);
    const tag = `${cid} yaw ${yaw}`;
    console.log(`    mask ${String(s.area).padStart(6)} px of ${hairPx} hair px`
      + ` (${(100 * frac).toFixed(1)}%)  biggest ${big.n} ${big.w}x${big.h}`
      + ` fill ${big.fill}  longest ${span}  thickest ${2 * s.maxR} px at ${s.maxRAt.join(',')}`
      + `  pieces ${s.nPieces}  mean Δ ${s.mean}  [R ${info.headR}]`);
    check(`${tag}: the hair has a highlight at all`, frac >= MIN_FRAC,
      `${(100 * frac).toFixed(1)}% of ${hairPx} hair px, floor ${(100 * MIN_FRAC).toFixed(1)}%`);
    check(`${tag}: the highlight has not swallowed the hair`, frac <= MAX_FRAC,
      `${(100 * frac).toFixed(1)}%, ceiling ${(100 * MAX_FRAC).toFixed(0)}%`);
    check(`${tag}: the highlight runs across the hair`, span >= MIN_BAND_SPAN,
      `longest piece ${span} px (≥ ${MIN_BAND_SPAN.toFixed(0)}), ${s.nPieces} pieces`);
    const slender = span / Math.max(2 * s.maxR, 1);
    check(`${tag}: the highlight is long for its thickness`, slender >= MIN_SLENDER,
      `${span} px long over ${2 * s.maxR} px thick = ${slender.toFixed(1)} (≥ ${MIN_SLENDER})`);
    check(`${tag}: nothing in the highlight is thicker than a band`, 2 * s.maxR <= MAX_THICK,
      `thickest ${2 * s.maxR} px at ${s.maxRAt.join(',')} (≤ ${MAX_THICK.toFixed(0)})`);
    check(`${tag}: no coin stuck on the hair`, coins.length === 0,
      coins.length ? coins.map((q) => `${q.n}px ${q.w}x${q.h} fill ${q.fill}`).join(' | ')
        : `${s.pieces.filter((q) => q.n >= MIN_PIECE).length} piece(s) checked`);
    await p.screenshot({ path: `${outDir}/${cid}-${yaw}.png` });
  }
}

/* ------------------------------------------------------------------- tally -- */
console.log(`\nerrors -> ${errs.length ? errs.slice(0, 4).join(' | ') : 'none'}`);
check('no page errors while the head turned', errs.length === 0, errs.slice(0, 2).join(' | '));
check('client/src was not hot-updated mid-run', hmr.length === 0, `${hmr.length} HMR events`);

// A green run that asserted nothing is the failure mode this repo keeps meeting, so the count is
// part of the contract: two material claims and four shape claims per view, per character.
const want = WHO.length * (2 + YAWS.length * 6) + 7;
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
console.log(`shots -> ${outDir}`);
await b.close();
process.exit(fail === 0 && pass >= want ? 0 : 1);
