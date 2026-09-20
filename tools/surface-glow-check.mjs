// 发光的头发: a lit surface is not a light source.
//
// Why this probe exists. Bloom in this game starts at a linear luminance of 0.95
// (`BLOOM_THRESHOLD`, engine/renderer.js), and that number is *below* what an ordinary pale
// material returns with the sun on it. kaelen's hair is albedo #dfe9f2 — luminance 0.80 before a
// single light touches it — so the cel ramp's lit band alone carries the whole top of her head
// past the threshold and feeds it to the bloom pass. Photographed at portrait size the result was
// not a highlight: the glow thrown over the background covered **2.4x as many pixels as the hair
// itself**, a fog around the silhouette that softened the outline and greyed the sky behind it.
// The other six characters measured 0.00 to 0.06 of their own hair area.
//
// Which term crossed the line was measured, not guessed (.run/halo.mjs): pushing `uSpecStep` past
// 1 left it at 2.472 and `uRimStrength` to 0 left it at 2.465, while multiplying the hair albedo
// by 0.8 took it to 0.003. The diffuse response was the whole of it.
//
// The fix is a ceiling on the light response, `uSurfaceCeil`, set 0.05 under the bloom threshold
// and applied after the diffuse/ambient/fill/point-light accumulation but *before* the specular,
// the rim, the elemental aura and `totalEmissiveRadiance`. So everything that means to glow still
// glows — the sheen band on the hair still blooms, as a thin bright line, which is the anime look
// — and a merely pale surface does not.
//
// Method, and why each half is here.
//
//   * The hair's own pixels are NOT "everything that changes when the hair is hidden". That mask
//     also catches every pixel the hair merely *contributed* to — its bloom halo over the sky and
//     its cast shadow on the face — which on kaelen made the "hair" 340k px of a 490k px frame
//     and put the bottom half of its own histogram at luma 9-29, i.e. glow over black. So the
//     mask is taken with bloom off and intersected with a hue test on a frame where the hair is
//     painted magenta. The hue test survives any brightness, so it does not quietly drop the
//     shadow side and flatter the very thing being measured.
//   * The glow is then priced against that area — halo px per hair px — because a waist-length
//     style puts twice the hair on screen that a bob does.
//   * Every claim is an A/B on one page with one uniform changed, never a comparison against a
//     remembered number from another build: this driver does not repeat itself to the byte across
//     runs (dark characters' percentiles drift 1-2 counts), so "bit-identical" is only meaningful
//     inside a single page. With `uSurfaceCeil` at 0 the block is skipped entirely, which is what
//     makes that A/B exact.
//   * Two obligations pair every "do not glow" bar, or the whole thing could be satisfied by
//     turning bloom off and painting the characters grey:
//       - the hair may not get *darker* than the same frame without the ceiling (≤ 6 counts at
//         p50 and p95), so "fix it by dimming the hair" fails;
//       - giving the hair an emissive must bring a halo back, through the product's own
//         totalEmissiveRadiance path — the one weakspots and boss phases use. That is what says
//         bloom is alive and the ceiling is a ceiling on *light response*, not a kill switch.
//   * And at least one character must actually be changed by the ceiling. A run where every
//     single A/B came out bit-identical proves nothing at all, so that is its own row.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { INSTALL } from './lib/probe-world.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/surface-glow'; })();
// The mutation run: --ceil 0 restores the shipped-before behaviour on every material at once.
const ceilOverride = (() => { const i = argv.indexOf('--ceil'); return i >= 0 ? +argv[i + 1] : null; })();
fs.mkdirSync(outDir, { recursive: true });
const W = 700, H = 700;
const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// All seven characters, because the rule is a property of the shader and of the palette, not of
// one head — and the two views are the two that carry the most hair: front, and side, where the
// long styles put their whole mass in frame.
const WHO = ['lyra', 'ignar', 'seris', 'kaelen', 'volt', 'terra', 'nyx'];
const YAWS = [0, 90];
const FILL = 0.62;                 // head diameter as a fraction of frame height

// Glow the hair is allowed to throw, as a fraction of its own area on screen. The shipped
// build measured 2.47 / 2.15 / 1.25 on kaelen and 0.00 to 0.44 on everyone else, so this bar is
// set where it separates those two populations with room on both sides; after the ceiling kaelen
// reads 0.16 / 0.05. It is a ratio and not a pixel count on purpose: see the header.
const MAX_HALO = 0.55;
// The ceiling may not cost the hair its brightness. Both are counts of 255 on the same camera
// with only uSurfaceCeil changed, so 6 is generous: the measured cost on kaelen is 2.
const MAX_DIM = 6;
// An emissive must still reach past the bloom threshold. Baseline reach (everything the hair
// changes, including its halo, over the hair's own area) is 1.00-1.16; with a white emissive it
// has to be far clear of that.
const MIN_EMISSIVE_REACH = 1.6;

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
  // on drawing nothing, so every diff in this file would read 0 and every bar would pass.
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
// llvmpipe boots every browser at `low`, and `low` turns the bloom pass off outright — the
// picture this probe is about would not exist.
await p.evaluate(() => {
  window.game.setAutoQuality(false);
  window.game.setQuality('high');
  window.game.setWorldTime(12);
});
await sleep(3000);
check('the quality tier is pinned to high', await p.evaluate(() => window.game.quality) === 'high');
check('the bloom pass is on', await p.evaluate(() => !!window.game.r.bloom.enabled));
// Stop the loop: every number here is the same camera rendered twice with one uniform changed,
// and that is only a controlled experiment if nothing else moves between the two frames.
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
  // render() only queues work, so readPixels is also what makes the picture exist before it is
  // measured. A sleep here would measure the previous camera.
  window.__grab = () => {
    const g = window.game;
    const gl = g.r.renderer.getContext();
    for (let k = 0; k < 3; k++) g.r.render(0.016);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { w, h, px };
  };
  // The toon uniforms live in mat.userData.toon (merged into shader.uniforms inside
  // onBeforeCompile), so a material never has a .uniforms of its own to look in.
  window.__toonMats = () => {
    const m = window.game.me.actor.rig.materials;
    return Object.entries(m).filter(([, x]) => x && x.userData && x.userData.toon);
  };
  window.__groupMats = (keys) => window.__toonMats()
    .filter(([k]) => keys.indexOf(k) >= 0).map(([, x]) => x);
  window.__hairMats = () => window.__groupMats(['matHair', 'matHairB']);
  window.__ceils = () => window.__toonMats()
    .map(([k, x]) => [k, x.userData.toon.uSurfaceCeil ? x.userData.toon.uSurfaceCeil.value : null]);
  // Per group, not per rig: the halo being measured belongs to one set of materials, and an A/B
  // that switches the ceiling off on the whole body answers a different question than the one the
  // halo asked. (It also hides the answer: turning it off for terra moved 255082 px of a frame
  // whose *hair* had not changed at all -- that was her face.)
  window.__setCeil = (keys, v) => window.__groupMats(keys).forEach((x) => {
    if (x.userData.toon.uSurfaceCeil) x.userData.toon.uSurfaceCeil.value = v;
  });
  window.__anyDiff = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.w * a.h; i++) {
      if (a.px[i * 4] !== b.px[i * 4] || a.px[i * 4 + 1] !== b.px[i * 4 + 1]
        || a.px[i * 4 + 2] !== b.px[i * 4 + 2]) n++;
    }
    return n;
  };
  /**
   * The hair, and what it throws outside itself.
   *
   * mask: bloom OFF (so the halo cannot join the mask) and a hue test against a frame with the
   * hair painted magenta (so the cast shadow on the face cannot either, at any brightness).
   * halo: bloom back ON, the same hide-and-diff, counted only where the mask is not.
   */
  window.__glow = (keys, tol = 8) => {
    const mats = window.__groupMats(keys);
    const r = window.game.r, wasBloom = r.bloom.enabled;
    r.bloom.enabled = false;
    const on = window.__grab();
    mats.forEach((m) => { m.visible = false; });
    const off = window.__grab();
    mats.forEach((m) => { m.visible = true; });
    const keep = mats.map((m) => m.color.clone());
    mats.forEach((m) => m.color.setHex(0xff00ff));
    const id = window.__grab();
    mats.forEach((m, i) => m.color.copy(keep[i]));
    r.bloom.enabled = wasBloom;
    const { w, h, px } = on;
    const mask = new Uint8Array(w * h);
    const lum = [];
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      const d = Math.abs(on.px[i * 4] - off.px[i * 4]) + Math.abs(on.px[i * 4 + 1] - off.px[i * 4 + 1])
        + Math.abs(on.px[i * 4 + 2] - off.px[i * 4 + 2]);
      if (d <= tol) continue;
      const ir = id.px[i * 4], ig = id.px[i * 4 + 1], ib = id.px[i * 4 + 2];
      if (ig + 4 >= 0.8 * Math.max(ir, ib)) continue;
      mask[i] = 1; n++;
      lum.push(0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]);
    }
    if (!n) return { n: 0 };
    let halo = 0, haloSum = 0, reach = 0;
    const bon = window.__grab();
    mats.forEach((m) => { m.visible = false; });
    const boff = window.__grab();
    mats.forEach((m) => { m.visible = true; });
    for (let k = 0; k < 3; k++) window.game.r.render(0.016);
    for (let i = 0; i < w * h; i++) {
      const d = Math.abs(bon.px[i * 4] - boff.px[i * 4]) + Math.abs(bon.px[i * 4 + 1] - boff.px[i * 4 + 1])
        + Math.abs(bon.px[i * 4 + 2] - boff.px[i * 4 + 2]);
      if (d <= tol) continue;
      reach++;
      if (mask[i]) continue;
      halo++; haloSum += d;
    }
    lum.sort((a, b) => a - b);
    const q = (f) => lum[Math.min(lum.length - 1, Math.max(0, Math.round(f * (lum.length - 1))))];
    return {
      n, halo: +(halo / n).toFixed(3), haloPx: halo,
      haloMean: +(haloSum / Math.max(halo, 1)).toFixed(1),
      reach: +(reach / n).toFixed(3),
      p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1),
    };
  };
  // Everything the hair changes in the frame, halo included, over its own area — with an emissive
  // on it. Nothing else here can tell a working bloom pass from a disabled one.
  window.__emissiveReach = (keys) => {
    const mats = window.__groupMats(keys);
    const keepE = mats.map((m) => m.emissive.clone());
    const keepI = mats.map((m) => m.emissiveIntensity);
    mats.forEach((m) => { m.emissive.setRGB(1, 1, 1); m.emissiveIntensity = 1.0; });
    const g = window.__glow(keys);
    mats.forEach((m, i) => { m.emissive.copy(keepE[i]); m.emissiveIntensity = keepI[i]; });
    for (let k = 0; k < 3; k++) window.game.r.render(0.016);
    return g;
  };
})()`);

/* ------------------------------------------------- 1. the instrument itself -- */
// Aim at a head first. The control below paints the hair and counts what changed, and from the
// gameplay camera the head is a few hundred pixels of a full-body shot: the first version of this
// probe ran the control before aiming and read 551 changed pixels, which is a broken instrument
// reporting a broken instrument.
await p.evaluate((c) => window.__pick(c), 'ignar');
await p.evaluate((y, f) => window.__aim(y, f), 90, FILL);
const ctl = await p.evaluate(() => {
  const mats = window.__hairMats();
  const on = window.__grab();
  const keep = mats.map((m) => m.color.clone());
  mats.forEach((m) => m.color.setHex(0xff00ff));
  const off = window.__grab();
  mats.forEach((m, i) => m.color.copy(keep[i]));
  for (let k = 0; k < 3; k++) window.game.r.render(0.016);
  return { changed: window.__anyDiff(on, off), mats: mats.length, ceils: window.__ceils() };
});
check('every shader compiled', glsl.length === 0, glsl.slice(0, 1).join(' | '));
check('the hair materials are reachable', ctl.mats >= 1, `${ctl.mats} material(s)`);
check('repainting the hair changes the frame', ctl.changed > 50000, `${ctl.changed} px of ${W * H}`);
// The two constants are one constant (gfx/toon.js exports BLOOM_THRESHOLD and derives the ceiling
// from it), and this is the row that would notice if they ever stopped being.
const thr = await p.evaluate(() => window.game.r.bloom.threshold);
const ceil0 = ctl.ceils.find(([, v]) => v !== null && v > 0);
check('the surface ceiling sits below where bloom starts', !!ceil0 && ceil0[1] < thr,
  `ceiling ${ceil0 ? ceil0[1] : 'missing'} vs bloom threshold ${thr}`);
check('every toon material on the rig has the ceiling',
  ctl.ceils.length > 0 && ctl.ceils.every(([, v]) => v !== null),
  `${ctl.ceils.filter(([, v]) => v !== null).length} of ${ctl.ceils.length}`);

/* --------------------------------------------- 2. the glow, per head, per subject -- */
// Two subjects, because the palette has two pale things on a head and they fail independently:
// the hair (where this was found) and the skin, which is a pale albedo on every character in the
// game. Each is measured and toggled *alone* — the ceiling is switched off for that group only —
// so a halo and the A/B that explains it always describe the same pixels.
const GROUPS = [
  { name: 'hair', keys: ['matHair', 'matHairB'] },
  { name: 'skin', keys: ['matSkin'] },
];

console.log(`\nhalo is counted outside the subject's own mask and priced against it;`
  + ` ceiling ${MAX_HALO} of its area, and the ceiling may not dim it by ${MAX_DIM} counts`);
if (ceilOverride !== null) console.log(`!! uSurfaceCeil forced to ${ceilOverride} on every material`);

let touched = 0, identical = 0;
for (const cid of WHO) {
  const got = await p.evaluate((c) => window.__pick(c), cid);
  if (got.charId !== cid) { skipped(`${cid}: the character loaded`, `got ${got.charId}`); continue; }
  if (ceilOverride !== null) {
    await p.evaluate((v) => window.__setCeil(['matHair', 'matHairB', 'matSkin'], v), ceilOverride);
  }
  const shipped = await p.evaluate(() => {
    const c = window.__ceils().find(([, v]) => v !== null);
    return c ? c[1] : 0;
  });
  console.log(`  ${cid}: ceiling ${shipped.toFixed ? shipped.toFixed(3) : shipped}`);
  for (const g of GROUPS) {
    for (const yaw of YAWS) {
      const tag = `${cid} ${g.name} yaw ${yaw}`;
      await p.evaluate((y, f) => window.__aim(y, f), yaw, FILL);
      const on = await p.evaluate((k) => window.__glow(k), g.keys);
      if (!on.n) { skipped(`${tag}: the subject is in shot`, 'no pixels'); continue; }
      // The same camera with this group's ceiling switched off, on the same page. Nothing else
      // moves, so a zero here is an exact statement about these materials and not about a driver
      // that does not repeat itself to the byte between runs.
      const ab = await p.evaluate((k, c) => {
        const a = window.__grab();
        window.__setCeil(k, 0);
        const b = window.__grab();
        window.__setCeil(k, c);
        for (let i = 0; i < 3; i++) window.game.r.render(0.016);
        return window.__anyDiff(a, b);
      }, g.keys, shipped);
      await p.evaluate((k) => window.__setCeil(k, 0), g.keys);
      const off = await p.evaluate((k) => window.__glow(k), g.keys);
      await p.evaluate((k, c) => window.__setCeil(k, c), g.keys, shipped);
      console.log(`    ${g.name.padEnd(4)} ${String(on.n).padStart(6)} px   halo ${String(on.halo).padStart(6)}`
        + ` (${on.haloPx} px, mean Δ ${on.haloMean})   p50 ${on.p50}  p95 ${on.p95}`
        + `   ceiling off: halo ${off.halo}  p50 ${off.p50}  p95 ${off.p95}  |  A/B ${ab} px differ`);
      check(`${tag}: it does not glow`, on.halo <= MAX_HALO,
        `halo ${on.halo} of its own area (ceiling ${MAX_HALO}), ${on.haloPx} px mean Δ ${on.haloMean}`);
      check(`${tag}: the ceiling did not dim it`,
        on.p50 >= off.p50 - MAX_DIM && on.p95 >= off.p95 - MAX_DIM,
        `p50 ${on.p50} vs ${off.p50}, p95 ${on.p95} vs ${off.p95} without it (≤ ${MAX_DIM} counts)`);
      if (ab === 0) {
        // These materials never reached the ceiling, so the frame is the frame it always was, and
        // the claim is exact: not one pixel of 490000 moved by one count.
        identical++;
        check(`${tag}: a subject under the ceiling renders bit-identically`,
          on.halo === off.halo && on.p95 === off.p95,
          `0 px differ, halo ${on.halo} either way`);
      } else {
        touched++;
        check(`${tag}: switching the ceiling off brings the glow back`, off.halo > on.halo * 1.5,
          `halo ${off.halo} without the ceiling vs ${on.halo} with it, ${ab} px differ`);
      }
      await p.screenshot({ path: `${outDir}/${cid}-${g.name}-${yaw}.png` });
    }
  }
  // The paired obligation, once per character: bloom must still fire for something that means to
  // glow, through the path the game actually uses for it (weakspots, boss phases).
  await p.evaluate((y, f) => window.__aim(y, f), 0, FILL);
  const base = await p.evaluate(() => window.__glow(['matHair', 'matHairB']));
  const em = await p.evaluate(() => window.__emissiveReach(['matHair', 'matHairB']));
  console.log(`    emissive: reach ${em.reach} vs ${base.reach} plain, halo ${em.halo} vs ${base.halo}`);
  check(`${cid}: an emissive still reaches past the bloom threshold`,
    em.reach >= MIN_EMISSIVE_REACH && em.reach > base.reach * 1.3,
    `reach ${em.reach} with an emissive vs ${base.reach} without (floor ${MIN_EMISSIVE_REACH})`);
}

/* ------------------------------------------------------------------- tally -- */
// A run in which the ceiling changed nobody's frame would pass every bar above while proving
// nothing whatsoever about the defect it exists for — and one in which it changed *everybody's*
// would mean it is no longer the narrow rule it claims to be.
check('the ceiling engages where the palette is pale', touched > 0,
  `${touched} of ${WHO.length * GROUPS.length * YAWS.length} views changed by it`);
check('the ceiling leaves most of the palette bit-identical', identical > 0,
  `${identical} views unchanged to the byte`);
console.log(`\nerrors -> ${errs.length ? errs.slice(0, 4).join(' | ') : 'none'}`);
check('no page errors while the heads turned', errs.length === 0, errs.slice(0, 2).join(' | '));
check('client/src was not hot-updated mid-run', hmr.length === 0, `${hmr.length} HMR events`);

// Three claims per subject-view plus one emissive obligation per character, and nine tally rows.
const want = WHO.length * (GROUPS.length * YAWS.length * 3 + 1) + 9;
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
console.log(`shots -> ${outDir}`);
await b.close();
process.exit(fail === 0 && pass >= want ? 0 : 1);
