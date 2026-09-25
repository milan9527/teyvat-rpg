// 深色衣服没有明暗: a garment painted dark enough has no room left to be shaded.
//
// Why this probe exists. Photographed at the size a character is played at — whole body filling
// 85 % of a 700 px frame, noon, quality pinned to high, the world hidden — and asked the only
// question that matters for shading, *how many of the 256 levels does this surface's form occupy*,
// eleven of the twenty-six sub-mid-grey surfaces on the seven playable rigs answered in single
// digits. This is the defect, measured on the build before the fix (`.run/floor.mjs`, interquartile
// spread of the surface's own masked pixels):
//
//     nyx    matBoots      8658 px  albedo  17.9  screen p25..p75  15.0..16.4   iqr  1.4
//     ignar  matSecondary 22239 px  albedo  29.3  screen          20.6..23.2   iqr  2.6
//     volt   matBoots     11290 px  albedo  30.6  screen          20.8..24.1   iqr  3.3
//     nyx    matHair       8435 px  albedo  31.4  screen          20.9..25.6   iqr  4.7
//     ignar  matPrimary   26580 px  albedo  42.6  screen          30.6..35.5   iqr  4.9
//     kaelen matBoots     11150 px  albedo  42.2  screen          31.0..38.1   iqr  7.1
//
// A cel ramp, a rim term, a specular step and CLOTH_FORM's within-band lean all land inside those
// two or three counts, so the surface is a cut-out however good the shading model is.
//
// It is not a lighting bug and the ruler that says so is scale-free: p75/p25 is 1.18 on ignar's
// trousers, 1.27 on lyra's and 1.11 on skin — the dark garments are lit exactly as well as the
// bright ones, in proportion. What they do not have is counts, because the transfer chain is a
// curve: the same proportion is worth ~5 counts at 200 and ~0.6 at 20, and this pipeline's toe
// makes it worse than plain sRGB (an albedo of 216 renders at 0.95 of itself, 86 at 0.93, 43 at
// 0.72). Nothing downstream of the palette can fix that; only the paint can move.
//
// So `liftDark` in client/src/gfx/humanoid.js maps any authored albedo below DARK_KNEE onto
// [DARK_FLOOR, DARK_KNEE) affinely, in sRGB HSL, holding hue and saturation and raising only
// lightness — and `separateFrom`'s search is boxed into the same band, because its two cheapest
// ways to buy distance from a neighbour are to dive toward black (which undoes the lift) and to
// climb out of the range (which repainted ignar's near-black leather jacket salmon, #f37667).
//
// What this probe asserts, per dark subject, and why each row is here:
//   * the lift reached it at all — the rendered albedo lands inside the band. This is the row that
//     fails if the map is bypassed for one material, applied twice, or turned into a clamp.
//   * it is still the colour the author painted: the hue is unmoved and the saturation has not
//     fallen. A linear-space scale (the first version of the lift) passes every count-based row
//     below and fails this one, which is exactly what it looked like — a dusty pink jacket.
//   * its form spans MIN_IQR counts on screen, the headline claim.
//   * and spans them *in proportion*, p75/p25 — so "paint it lighter" alone cannot satisfy the
//     row above; a surface lifted into the range but lit flat still fails.
// Per character, the waist seam: the two garments that meet are told apart on screen, in colour,
// not in luminance — the lift compresses value differences (slope 0.47) and hands that seam's
// legibility to hue, so that is where it has to be measured. This row is an *obligation* on the
// lift, not a detector: none of the three mutations below trips it (the closest is ignar off, at
// 39.2 bytes against 65.4 shipped). It is here because the cheapest way to satisfy every other row
// is to paint the whole dark end one value, and that is what it forbids.
// And both ways: every surface the author painted at or above the knee is byte-identical to what
// they painted. A map that lifted the whole range would pass all of the above.
//
// Mutations, all three against the shipped build (114/0/7):
//     DARK_FLOOR = 0     the lift becomes the identity map, bit-exact -> 31 failures: 17 band rows
//                        (the 4 subjects already painted above 68 keep theirs) and 14 form rows at
//                        1.6..9.6 counts, which is the defect table above, printed by the gate.
//     linear multiply    holding chromaticity instead of saturation -> every count-based row still
//                        passes and 17 colour rows fail, each on 0.02..0.10 of lost sRGB
//                        saturation with the hue unmoved to within 0.003. That is the version that
//                        photographed as a dusty pink jacket.
//     max(lum, FLOOR)    the idempotent map the affine one is often mistaken for -> 13 failures:
//                        six band rows (a clamp lands *on* the floor, 67.4..68.0) and — the point —
//                        four form rows at 9.3..11.8 counts. Everything piled onto the floor itself
//                        does not buy enough range; the map has to spread the band.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { INSTALL } from './lib/probe-world.mjs';
import { CHARACTERS } from '../shared/src/data/characters.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const outDir = flag('--out', '/tmp/garment-range');
fs.mkdirSync(outDir, { recursive: true });
const W = 700, H = 700;
const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WHO = ['lyra', 'ignar', 'seris', 'kaelen', 'volt', 'terra', 'nyx'];
const FILL = 0.85;                 // body height as a fraction of frame height: play distance

// --- the band, mirrored from humanoid.js -------------------------------------
// Not imported because these are internal to that module; the rows below are written so that any
// disagreement shows up as a failure rather than as a silently different question.
const FLOOR = 68, KNEE = 128;

// Which material group wears which authored colour. `matHairB` and `matAccent` are derived from
// these by `hairTone`/`glowMaterial` rather than painted, and skin, metal and the eyes are not in
// the lift's scope at all (every authored skin tone is already 150..224).
const SUBJECT = {
  matHair: 'hairColor', matPrimary: 'primary', matSecondary: 'secondary',
  matBoots: 'boots', matSheet: 'secondary',
};
// Groups `separateFrom` can move after the lift, so their colour rows are the one-sided version.
const SEPARATED = new Set(['matPrimary', 'matSecondary', 'matSheet']);
const DEFAULT_BOOTS = 0x2a2a34;    // humanoid.js's fallback, for a body with no boots key

// --- the bars, every one of them measured first -------------------------------
// A mask small enough to be a trim strip cannot carry a percentile spread.
const MIN_PX = 700;
// The headline. Measured post-fix: 13.8 counts (ignar's jacket) to 55.8 (seris's hair) across all
// 21 subjects. With the lift off, fourteen of the same 21 read 1.6..9.6 and the seven that pass are
// the ones already painted near the knee. The bar sits in that gap, nearer the defect.
const MIN_IQR = 12;
// ...and the form has to be proportional, not just wide. Measured 1.21..1.71 post-fix on every
// subject and 1.12..1.74 with the lift off — which is the point of the row rather than a weakness
// in it: the ratio was never the defect, so this row is what stops MIN_IQR from being satisfiable
// by a surface lifted into the range and then lit flat.
const MIN_RATIO = 1.10;
// The colour must survive the lift. Hue in turns (0..1): a bisection on lightness at fixed H and S
// cannot move it at all, so anything above rounding is a different map. Saturation is allowed to
// rise (`separateFrom` scales, and scaling toward white raises sRGB S: nyx's cape 0.28 -> 0.33) but
// never to fall; the linear-multiply version of the lift loses 0.03..0.10 and photographs dusty.
const MAX_DHUE = 0.02, MAX_DSAT_DOWN = 0.02;
// Hue is meaningless below this saturation (a grey has no hue), so that half of the row is skipped.
const GREY_SAT = 0.06;
// The waist seam, in sRGB bytes between the two garments' on-screen medians. Measured post-fix:
// 58.4 (nyx) and 65.4 (ignar, whose trousers and jacket are two values of one brown) up to 234.5
// where a dark garment meets a near-white one. The bar is a floor under the two that are genuinely
// close, not a detector — see the note on obligations in the header.
const MIN_SEAM = 20;
// How many dark subjects the seven rigs are expected to present. If a palette edit takes one out of
// the band, this probe must say so rather than quietly asking fewer questions.
const SUBJECTS_EXPECTED = 21;
// The other side: seven skin tones, plus lyra's and kaelen's pale hair, all byte-identical.
const UNTOUCHED_EXPECTED = 9;

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); } else {
    fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
};
const skipped = (name, why) => { skip++; console.log(`  SKIP ${name} — ${why}`); };

// --- colour helpers, in the screen's own space --------------------------------
const lumBytes = (r, g, bl) => 0.2126 * r + 0.7152 * g + 0.0722 * bl;
const lumHex = (h) => lumBytes(h >> 16 & 255, h >> 8 & 255, h & 255);
const hx = (h) => `#${(h >>> 0).toString(16).padStart(6, '0')}`;
const dist = (a, b) => Math.hypot(
  (a >> 16 & 255) - (b >> 16 & 255), (a >> 8 & 255) - (b >> 8 & 255), (a & 255) - (b & 255),
);
// HSL as the player's screen defines it (sRGB bytes), which is where the complaint "it went dusty"
// lives — not a linear-light chromaticity.
function hsl(hex) {
  const r = (hex >> 16 & 255) / 255, g = (hex >> 8 & 255) / 255, b = (hex & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return { h: 0, s: 0, l };
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h / 6, s, l };
}
const dHue = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };

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
const errs = [], glsl = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => {
  const t = m.text();
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
// llvmpipe boots every browser at `low`, where the ramp and the tone curve read differently: a
// frame shot there is a frame no player sees.
await p.evaluate(() => {
  window.game.setAutoQuality(false);
  window.game.setQuality('high');
  window.game.setWorldTime(12);
});
await sleep(3000);
check('the quality tier is pinned to high', await p.evaluate(() => window.game.quality) === 'high');

await p.evaluate(() => { window.game.stop(); });
await sleep(300);
const iso = await p.evaluate(() => window.__isolate([window.game.me.actor.group]));
check('the world is hidden and only the character is left', iso.hidden > 0, `${iso.hidden} hidden`);

await p.evaluate(`(() => {
  const wp = (o) => { const e = o.matrixWorld.elements; return [e[12], e[13], e[14]]; };
  // Whole body, from the rig's own height, centred at half of it.
  window.__aim = (yawDeg, fill) => {
    const g = window.game, a = g.me.actor, rig = a.rig, cam = g.camera;
    a.group.rotation.y = 0;
    rig.group.updateMatrixWorld(true);
    const root = wp(rig.group), Hh = rig.height ?? rig.P?.height ?? 1.7;
    const tgt = [root[0], root[1] + Hh * 0.5, root[2]];
    const fov = 30, dist = (Hh / fill) / (2 * Math.tan((fov / 2) * Math.PI / 180));
    const yaw = (yawDeg * Math.PI) / 180;
    cam.fov = fov;
    cam.position.set(tgt[0] + Math.sin(yaw) * dist, tgt[1], tgt[2] + Math.cos(yaw) * dist);
    cam.lookAt(tgt[0], tgt[1], tgt[2]);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    g.world.sky.update(0.016, cam, tgt[0], tgt[1], tgt[2]);
    return { height: +Hh.toFixed(3), dist: +dist.toFixed(2) };
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
  window.__grab = () => {
    const g = window.game, gl = g.r.renderer.getContext();
    for (let k = 0; k < 3; k++) g.r.render(0.016);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { w, h, px };
  };
  window.__mats = () => {
    const m = window.game.me.actor.rig.skinned.material;
    return Array.isArray(m) ? m : [m];
  };
  // One mesh per material *array*, so a group is an index into it, not an object identity.
  window.__named = () => {
    const rig = window.game.me.actor.rig, mats = window.__mats();
    const out = {};
    for (const [name, m] of Object.entries(rig.materials)) {
      const k = mats.indexOf(m);
      if (k >= 0) out[name] = { k, hex: m.color.getHex() };
    }
    return out;
  };
  const q = (arr, f) => { const s = [...arr].sort((x, y) => x - y); return +s[Math.round(f * (s.length - 1))].toFixed(1); };
  const L = (px, i) => 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  // A group's own pixels, found by hiding it and diffing — the only way to name a region on a
  // merged skinned mesh. Bloom off: a halo would carry other surfaces' light into this mask.
  window.__shape = (k) => {
    const r = window.game.r, was = r.bloom.enabled, m = window.__mats()[k];
    r.bloom.enabled = false;
    const on = window.__grab();
    m.visible = false;
    const hid = window.__grab();
    m.visible = true;
    r.bloom.enabled = was;
    const lum = [], R = [], G = [], B = [];
    for (let i = 0; i < on.w * on.h; i++) {
      const dm = Math.abs(on.px[i * 4] - hid.px[i * 4]) + Math.abs(on.px[i * 4 + 1] - hid.px[i * 4 + 1])
        + Math.abs(on.px[i * 4 + 2] - hid.px[i * 4 + 2]);
      if (dm <= 8) continue;
      lum.push(L(on.px, i));
      R.push(on.px[i * 4]); G.push(on.px[i * 4 + 1]); B.push(on.px[i * 4 + 2]);
    }
    if (!lum.length) return { mask: 0 };
    return {
      mask: lum.length,
      albedo: m.color.getHex(),
      p25: q(lum, 0.25), med: q(lum, 0.5), p75: q(lum, 0.75),
      // Channel-wise medians: this is a colour to compare against a neighbouring garment's, not a
      // pixel that exists. The two masks are lit by the same sun in the same frame.
      rgb: [Math.round(q(R, 0.5)), Math.round(q(G, 0.5)), Math.round(q(B, 0.5))],
    };
  };
})()`);

let subjects = 0, untouched = 0, seams = 0;
const table = [];
for (const cid of WHO) {
  const got = await p.evaluate((c) => window.__pick(c), cid);
  if (!check(`${cid}: the rig loaded`, got.charId === cid, `got ${got.charId}`)) continue;
  const body = CHARACTERS[cid].body;
  const named = await p.evaluate(() => window.__named());
  await p.evaluate((f) => window.__aim(0, f), FILL);
  console.log(`\n=== ${cid}`);

  const shot = {};
  for (const [group, key] of Object.entries(SUBJECT)) {
    if (!named[group]) continue;
    const authored = key === 'boots' ? (body.boots ?? DEFAULT_BOOTS) : body[key];
    const s = await p.evaluate((kk) => window.__shape(kk), named[group].k);
    if (!s.mask || s.mask < MIN_PX) continue;
    shot[group] = s;
    const a = hsl(authored), r = hsl(s.albedo);
    const aLum = lumHex(authored), rLum = lumHex(s.albedo);

    // The bright half of the palette: the lift is the identity there, byte for byte, and that is
    // the row — not a skip for convenience. `separateFrom` may still move these, so only the
    // groups it never touches can be asked.
    if (aLum >= KNEE) {
      if (SEPARATED.has(group)) {
        skipped(`${cid} ${group}: painted above the knee`,
          `albedo ${hx(authored)} ${aLum.toFixed(1)} >= ${KNEE}, and separateFrom may still scale it`);
      } else {
        untouched++;
        check(`${cid} ${group}: painted above the knee, untouched`, s.albedo === authored,
          `${hx(authored)} ${aLum.toFixed(1)} -> ${hx(s.albedo)} ${rLum.toFixed(1)}`);
      }
      continue;
    }

    subjects++;
    const iqr = +(s.p75 - s.p25).toFixed(1);
    const ratio = s.p75 / Math.max(1, s.p25);
    table.push(`${cid} ${group} ${s.mask}px ${hx(authored)}${aLum.toFixed(1)} -> ${hx(s.albedo)}`
      + `${rLum.toFixed(1)}  screen ${s.p25}..${s.p75} iqr ${iqr} ratio ${ratio.toFixed(2)}`);

    check(`${cid} ${group}: the lift put it in the band`,
      rLum >= FLOOR && rLum < KNEE,
      `albedo ${hx(authored)} ${aLum.toFixed(1)} -> ${hx(s.albedo)} ${rLum.toFixed(1)}`
      + ` (want [${FLOOR}, ${KNEE}))`);
    const hueOk = Math.min(a.s, r.s) < GREY_SAT || dHue(a.h, r.h) <= MAX_DHUE;
    check(`${cid} ${group}: it is still the colour it was painted`,
      hueOk && r.s >= a.s - MAX_DSAT_DOWN,
      `hue ${a.h.toFixed(3)} -> ${r.h.toFixed(3)}, sat ${a.s.toFixed(2)} -> ${r.s.toFixed(2)}`
      + (Math.min(a.s, r.s) < GREY_SAT ? ' (grey: hue not asked)' : ''));
    check(`${cid} ${group}: its form spans the range`, iqr >= MIN_IQR,
      `p25..p75 ${s.p25}..${s.p75} = ${iqr} counts over ${s.mask} px (need ${MIN_IQR})`);
    check(`${cid} ${group}: and spans it in proportion`, ratio >= MIN_RATIO,
      `p75/p25 ${ratio.toFixed(2)} (need ${MIN_RATIO})`);
  }

  // Skin is out of the lift's scope by deliberate choice, not by luck: a face is the one surface a
  // player reads at every distance, and every authored tone is 150..224 already. So it is asked the
  // opposite question — that nothing reached it.
  if (named.matSkin) {
    const s = await p.evaluate((kk) => window.__shape(kk), named.matSkin.k);
    untouched++;
    check(`${cid} matSkin: the lift did not reach the skin`, s.albedo === body.skin,
      `${hx(body.skin)} ${lumHex(body.skin).toFixed(1)} -> ${hx(s.albedo)} over ${s.mask} px`);
  }

  // The waist seam. Nothing draws an outline inside a silhouette, so this boundary is albedo alone.
  if (shot.matPrimary && shot.matSecondary) {
    seams++;
    const a = shot.matPrimary.rgb, c = shot.matSecondary.rgb;
    const d = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
    check(`${cid}: the trousers and the jacket are told apart on screen`, d >= MIN_SEAM,
      `rgb(${a}) vs rgb(${c}) = ${d.toFixed(1)} bytes`
      + `, luminance ${shot.matPrimary.med} vs ${shot.matSecondary.med} (need ${MIN_SEAM})`);
  } else {
    skipped(`${cid}: the waist seam`, 'one of the two garments is under the mask floor');
  }
  await p.evaluate(() => window.__grab());
  await p.screenshot({ path: `${outDir}/${cid}.png` });
}

console.log('\n--- every dark subject, as measured');
for (const t of table) console.log(`  ${t}`);

console.log('');
check('every dark surface on every rig was scored', subjects === SUBJECTS_EXPECTED,
  `${subjects} subjects of ${SUBJECTS_EXPECTED} expected`);
check('the bright half of the palette was checked too', untouched === UNTOUCHED_EXPECTED,
  `${untouched} surfaces at or above the knee of ${UNTOUCHED_EXPECTED} expected`);
check('no shader failed to compile', glsl.length === 0, glsl.slice(0, 2).join(' | ') || 'clean');
check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');

// Four rows per dark subject, one seam per character, one load row per character, the untouched
// rows, and six standing rows: the quality pin, the isolation, and the four closing rows above this
// one. A probe that quietly stops asking is the failure mode this line exists for.
const want = subjects * 4 + seams + WHO.length + untouched + 6;
const got = pass + fail;
check('every subject was asked every question', got === want, `${got} rows of ${want} expected`);

console.log(`\nshots -> ${outDir}`);
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
await b.close();
process.exit(fail ? 1 : 0);
