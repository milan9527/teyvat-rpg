// 衣服像纸板: a garment that holds one value across its whole width.
//
// Why this probe exists. Photographed at the size a character is played at — the whole body filling
// 85 % of a 700 px frame, noon, quality pinned to high — a garment's widest row is one number. This
// is this probe's own --form 0 run, which is the defect reproduced on demand:
//
//     lyra   matPrimary   18982 px  med  84.0   72 px of a 165 px row held 83.9..85.9   44 % of it
//     seris  matPrimary   24735 px  med  57.7   82 px of a 184 px row held 56.2..57.7   45 %
//     terra  matPrimary   18381 px  med  80.1   85 px of a 180 px row held 93.7..95.0   47 %
//     nyx    matSecondary 17669 px  med  48.7   87 px of a 176 px row held 47.9..49.9   49 %
//     ignar  matSecondary 22257 px  med  21.8  108 px of a 227 px row held 18.5..21.8   48 %
//     lyra   matSecondary 18517 px  med 220.1   94 px of a 176 px row held 221.1..222.4 53 %
//
// That span is the longest stretch of contiguous pixels along the row that all sit within 2 counts
// of where the stretch began: a third to a half of a skirt or a jacket rendering as a single value
// with a hard step at the end of it. That is what "flat, like cardboard" is when it is measured
// instead of asserted.
//
// It is not the geometry. .run/ndl.mjs computes the shader's own lit = dot(n,L)*0.5+0.5 over the
// front-facing vertices of each material group and the garments spread 0.717-0.769 of the full
// range (sun [0.465,0.796,0.387]) — the meshes are round, and the value the light gives them varies
// across nearly the whole scale. What flattens them is the quantiser: bands = 3 puts its two edges
// at lit 1/3 and 2/3, i.e. at 70 and 110 degrees off the sun, so the entire sunlit side of a
// garment lands in one band and comes out at ramp = 1.0 whatever its normal was.
//
// It is also not the surface ceiling, which was the other candidate and had to be measured to be
// ruled out (.run/ceil.mjs): `col *= min(1, uSurfaceCeil/lum)` is a *normalizing* clamp, so the
// suspicion was that it maps a whole bright garment onto exactly 0.90. On three characters at two
// yaws it touches one material group of one of them (lyra's near-white jacket, 12.7-15.9 % of its
// mask) and inside that region the unclamped spread is 37.1 counts against a clamped 37.9 — the
// clamp is a uniform scale there, not a flattener. Everything else: 0.0 %.
//
// The fix is uFormShade (toon.js): inside each band, lean on the continuous response that was
// quantised away — ramp *= 1 - uFormShade * (1 - lit) — multiplicative and anchored at lit = 1, so
// it is monotone in lit (no sawtooth at the band edges), it never brightens, and a facet pointing
// straight at the sun keeps the value it has today. CLOTH_FORM = 0.55, asked for by clothMaterial
// and by nothing else; the painted face details opt out again (`flat` in humanoid.js), because a
// 1-band pupil that shades by its own normal is exactly the highlight that helper suppresses.
//
// Method.
//   * The consumer gate, both ways: on the rig, the garments claim the lean and skin, hair, metal,
//     eyes and every painted face detail read 0. Then the same question of the whole scene: nothing
//     anywhere may claim the lean with 1 band, which is the shape of a painted decal.
//   * That the opt-out is the *value* and not a missing wire: hand the lean to matSkin and watch its
//     pixels move, then take it back. A uniform nobody reaches would pass the row above for free.
//   * Then the pixels, and only where they can carry the answer. The subject is chosen by the run
//     itself: the largest garment group whose median lands between MID_LO and MID_HI counts, with a
//     flat run of at least MIN_SPAN px in the --form 0 frame. Outside that window the question
//     cannot be asked in 8-bit: at a median of 22 counts (ignar's jacket) a 12 % lean is two counts,
//     which is dither, and at 220 (lyra's) the tone curve returns 5 counts for the same 12 %. Those
//     groups SKIP, and say so — both ends are a palette defect this probe does not fix.
//   * Then, inside the exact pixel span that held one value: how much the shipped frame varies
//     there, that the variation is *ordered* across the span rather than noise, and — the obligation
//     that stops "make it darker" from being the answer — that the group's 95th percentile has
//     hardly moved.
//
// Mutations, both run against the shipped build (46 rows, green at 46/0/4):
//     --form 0   the lean off -> 12 failures, the relief and the ordering rows on all six scored
//                characters: relief 1.3-2.8 counts (which is the span's own tolerance, i.e. nothing)
//                and ordering 0.00-0.21 of it, against 3.7-8.6 counts and 0.30-0.49 shipped.
//     --dim      the lean off and every garment albedo multiplied by 0.90 instead — the same average
//                darkening with no form in it -> the same 12 failures, and the scans show why:
//                lyra's span goes from 84 flat to 79 flat, moved bodily and still one value.
//                Note the row that does *not* fail: "the garment was not merely dimmed" passes at
//                6.6 counts of p95 drop. That row is an obligation on this unit, not a detector for
//                dimmers; the relief and the ordering are the feature.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { INSTALL } from './lib/probe-world.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const outDir = flag('--out', '/tmp/cloth-form');
const formOverride = argv.includes('--form') ? +flag('--form', '0') : null;
const DIM = argv.includes('--dim');
fs.mkdirSync(outDir, { recursive: true });
const W = 700, H = 700;
const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WHO = ['lyra', 'ignar', 'seris', 'kaelen', 'volt', 'terra', 'nyx'];
const FILL = 0.85;                 // body height as a fraction of frame height: play distance
const CLOTH = ['matPrimary', 'matSecondary', 'matBoots', 'matSheet'];
const BARE = ['matSkin', 'matHair', 'matHairB', 'matMetal', 'matEye', 'matAccent'];

// --- the bars, all of them measured first -------------------------------------
// The lean, as authored. Range rather than a digit: it is a look, and the rows below are what it
// has to achieve. 0 is off and off is bit-exact, so a build that tunes it away fails here first.
const MIN_FORM = 0.3, MAX_FORM = 0.9;
// Where 8-bit counts can carry the answer at all. Below 35 a 12 % lean is under 4 counts; above
// 205 the tone curve gives back 5 counts for the same 12 %. Measured medians: lyra primary 84 and
// boots 51 inside, lyra secondary 220 and every ignar garment (22-34) outside.
const MID_LO = 35, MID_HI = 205;
// A flat run has to be long enough to be a defect. Measured 50-108 px on a 149-227 px row.
const MIN_SPAN = 25;
// And flat: the run detector allows 2 counts either side of where a run started, so 4 counts is its
// own bound, not a taste. Measured 1.3-2.7.
const MAX_SPAN_RANGE = 4.0;
// Inside that span, the shipped frame has to vary. Measured across six rigs: 3.5 counts (volt's
// trousers) to 8.5 (lyra's skirt), against 1.3-2.7 with the lean off.
const MIN_RELIEF = 3;
// ...and vary in one direction across the span rather than as speckle, scored against the relief
// itself so the bar cannot be met by a bigger dim: a monotone ramp puts half the relief between the
// two halves of the span, speckle puts none. Measured 0.33-0.46 of the relief on all six, which is
// most of the way to that ideal; 1 count is the floor below which this is dither.
const MIN_ORDER_FRAC = 0.25, MIN_ORDER_ABS = 1.0;
// The obligation. A uniform dimmer would pass everything above it if it were allowed to take the
// highlights with it; the lean is anchored at lit = 1 precisely so it does not. Measured drops in
// the 95th percentile: lyra primary 2.0 counts, boots 6.8.
const MAX_P95_DROP = 10;
// Handing the lean to skin has to move skin.
const MIN_WIRE_FRAC = 0.05;
// With today's palettes only one or two groups per rig land in the window above, so the probe has
// to say out loud how many subjects it actually scored. Six of the seven do; ignar wears near-black
// from head to foot (garment medians 20.6-30.6) and cannot be asked.
const MIN_SUBJECTS = 5;

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
const errs = [], glsl = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => {
  const t = m.text();
  // A GLSL compile error is not an exception: three.js logs it and carries on drawing nothing, so
  // every diff below would read 0 and every bar would pass.
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
  // render() only queues the work; readPixels is also what makes the picture exist before it is read.
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
  window.__named = () => {
    const rig = window.game.me.actor.rig, mats = window.__mats();
    const out = {};
    for (const [name, m] of Object.entries(rig.materials)) {
      const k = mats.indexOf(m);
      if (k >= 0) out[name] = k;
    }
    return out;
  };
  // Who asks for the lean on this rig, and with what. Captured once per character so that driving
  // the value to 0 below does not lose what the product authored.
  window.__lean = { mats: new Map(), colors: new Map() };
  window.__leanScan = () => {
    const rig = window.game.me.actor.rig;
    const named = [], bare = [], flatClaim = [];
    // setCharacter builds a new set of materials, and the albedo mutation below stores originals by
    // name: a stale entry would paint this character with the last one's colour.
    window.__lean.mats = new Map();
    window.__lean.colors = new Map();
    for (const [name, m] of Object.entries(rig.materials)) {
      const u = m.userData?.toon?.uFormShade;
      if (!u) { bare.push(name); continue; }
      if (u.value > 0) {
        named.push([name, +u.value.toFixed(3)]);
        window.__lean.mats.set(name, m);
        if ((m.userData.toon.uBands?.value ?? 3) < 2) flatClaim.push(name);
      } else bare.push(name);
    }
    return { on: named, off: bare, flatClaim };
  };
  window.__setLean = (x, only) => {
    let n = 0;
    for (const [name, m] of window.__lean.mats) {
      if (only && !only.includes(name)) continue;
      m.userData.toon.uFormShade.value = x; n++;
    }
    return n;
  };
  // The dimmer mutation: the lean off, and the same average darkening applied to the albedo
  // instead. Data only, so what is left is exactly "the garment is darker, with no form in it".
  window.__dimAlbedo = (k) => {
    for (const [name, m] of window.__lean.mats) {
      if (!window.__lean.colors.has(name)) window.__lean.colors.set(name, m.color.clone());
      m.color.copy(window.__lean.colors.get(name)).multiplyScalar(k);
    }
    return window.__lean.mats.size;
  };
  // Every claimant in the scene, not just on this rig: cloth is a class (props and enemies wear it
  // too) and a 1-band material claiming the lean would be a painted decal shading itself.
  window.__foreignLean = () => {
    const g = window.game;
    let claim = 0; const flat = [];
    g.scene.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if ((m.userData?.toon?.uFormShade?.value ?? 0) <= 0) continue;
        claim++;
        if ((m.userData.toon.uBands?.value ?? 3) < 2) {
          const chain = [];
          for (let q = o; q && chain.length < 3; q = q.parent) chain.push(q.name || q.type);
          flat.push(chain.join('<'));
        }
      }
    });
    return { claim, flat };
  };
  const L = (px, i) => 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  // One material group, three frames: as shipped, with the group hidden (which is its mask), and
  // with the lean at 0. Bloom off — a halo is not a pixel of the garment.
  //
  // The span is found in the *off* frame: the longest stretch of contiguous pixels along the widest
  // masked row whose luminance stays within 2 counts of where the stretch started. That is the
  // defect, located. Everything else is measured inside those same pixels in the shipped frame.
  window.__group = (k, leanValue, dimmed) => {
    const g = window.game, r = g.r, was = r.bloom.enabled, mats = window.__mats();
    r.bloom.enabled = false;
    window.__setLean(leanValue);
    const on = window.__grab();
    mats[k].visible = false;
    const hid = window.__grab();
    mats[k].visible = true;
    // The reference frame is the product *before* this unit: the lean at 0, and — under --dim — the
    // albedo the palette actually authored, so that the dimmer is compared against what it replaced.
    window.__setLean(0);
    if (dimmed) window.__dimAlbedo(1);
    const off = window.__grab();
    if (dimmed) window.__dimAlbedo(0.90);
    window.__setLean(leanValue);
    r.bloom.enabled = was;
    const rows = new Map();
    const allOn = [], allOff = [];
    for (let i = 0; i < on.w * on.h; i++) {
      const dm = Math.abs(on.px[i * 4] - hid.px[i * 4]) + Math.abs(on.px[i * 4 + 1] - hid.px[i * 4 + 1])
        + Math.abs(on.px[i * 4 + 2] - hid.px[i * 4 + 2]);
      if (dm <= 8) continue;
      const x = i % on.w, y = (i / on.w) | 0;
      const a = L(on.px, i), c = L(off.px, i);
      allOn.push(a); allOff.push(c);
      const e = rows.get(y) || [];
      e.push([x, a, c]);
      rows.set(y, e);
    }
    if (!allOn.length) return { mask: 0 };
    const q = (arr, f) => { const s = [...arr].sort((x, y) => x - y); return +s[Math.round(f * (s.length - 1))].toFixed(1); };
    let wide = null;
    for (const [y, e] of rows) if (!wide || e.length > wide[1].length) wide = [y, e];
    const line = wide[1].sort((a, c) => a[0] - c[0]);
    // The longest near-constant run in the off frame.
    let run = 1, best = { n: 1, i: 0 }, v0 = line[0][2];
    for (let i = 1; i < line.length; i++) {
      if (line[i][0] === line[i - 1][0] + 1 && Math.abs(line[i][2] - v0) <= 2) run++;
      else { run = 1; v0 = line[i][2]; }
      if (run > best.n) best = { n: run, i };
    }
    const span = line.slice(best.i - best.n + 1, best.i + 1);
    const inOn = span.map((s) => s[1]), inOff = span.map((s) => s[2]);
    const half = Math.floor(span.length / 2);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
    const sample = (arr) => {
      const st = Math.max(1, Math.floor(arr.length / 14));
      return arr.filter((_, i) => i % st === 0).map((v) => Math.round(v));
    };
    return {
      mask: allOn.length,
      med: q(allOn, 0.5), p95on: q(allOn, 0.95), p95off: q(allOff, 0.95),
      rowY: wide[0], rowN: line.length,
      span: span.length, spanX: [span[0][0], span[span.length - 1][0]],
      offMin: +Math.min(...inOff).toFixed(1), offMax: +Math.max(...inOff).toFixed(1),
      onMin: +Math.min(...inOn).toFixed(1), onMax: +Math.max(...inOn).toFixed(1),
      order: +(mean(inOn.slice(half)) - mean(inOn.slice(0, half))).toFixed(1),
      onScan: sample(inOn), offScan: sample(inOff),
    };
  };
  // Give a material that did not ask for the lean the lean, and see whether its pixels move: the
  // opt-out has to be the value rather than a uniform nothing reaches.
  window.__wire = (name, k, x) => {
    const rig = window.game.me.actor.rig, m = rig.materials[name], r = window.game.r;
    const u = m?.userData?.toon?.uFormShade;
    if (!u) return { err: name + ' has no uFormShade' };
    const mats = window.__mats(), was = r.bloom.enabled;
    r.bloom.enabled = false;
    const a = window.__grab();
    mats[k].visible = false;
    const hid = window.__grab();
    mats[k].visible = true;
    u.value = x;
    const c = window.__grab();
    u.value = 0;
    r.bloom.enabled = was;
    let mask = 0, moved = 0, lighter = 0;
    for (let i = 0; i < a.w * a.h; i++) {
      const dm = Math.abs(a.px[i * 4] - hid.px[i * 4]) + Math.abs(a.px[i * 4 + 1] - hid.px[i * 4 + 1])
        + Math.abs(a.px[i * 4 + 2] - hid.px[i * 4 + 2]);
      if (dm <= 8) continue;
      mask++;
      const d = Math.abs(a.px[i * 4] - c.px[i * 4]) + Math.abs(a.px[i * 4 + 1] - c.px[i * 4 + 1])
        + Math.abs(a.px[i * 4 + 2] - c.px[i * 4 + 2]);
      if (d > 8) { moved++; if (c.px[i * 4 + 1] > a.px[i * 4 + 1] + 1) lighter++; }
    }
    return { mask, moved, lighter };
  };
})()`);

const foreign = await p.evaluate(() => window.__foreignLean());
check('nothing in the scene shades a painted surface by its own normal',
  foreign.flat.length === 0,
  `${foreign.claim} claimants in the scene${foreign.flat.length ? `; 1-band: ${foreign.flat.slice(0, 3).join(', ')}` : ''}`);

console.log(`\nCLOTH_FORM: read from the rig below`
  + `${formOverride != null ? `  (mutation: --form ${formOverride})` : ''}`
  + `${DIM ? '  (mutation: --dim)' : ''}`);

let subjects = 0, anyRelief = 0;
for (const cid of WHO) {
  const got = await p.evaluate((c) => window.__pick(c), cid);
  if (got.charId !== cid) { skipped(`${cid}`, `setCharacter left ${got.charId} on screen`); continue; }
  await p.evaluate((f) => window.__aim(0, f), FILL);
  const named = await p.evaluate(() => window.__named());
  const scan = await p.evaluate(() => window.__leanScan());
  console.log(`\n${cid}`);

  const onNames = scan.on.map(([n]) => n).sort();
  const wantOn = CLOTH.filter((c) => named[c] !== undefined || scan.on.some(([n]) => n === c)).sort();
  const strayBare = BARE.filter((n) => onNames.includes(n));
  const authored = scan.on[0]?.[1] ?? 0;
  check(`${cid}: the garments ask for the lean and nothing else does`,
    onNames.length > 0 && strayBare.length === 0
    && onNames.every((n) => CLOTH.includes(n))
    && wantOn.every((n) => onNames.includes(n))
    && scan.on.every(([, v]) => v >= MIN_FORM && v <= MAX_FORM)
    && scan.flatClaim.length === 0,
    `on: ${scan.on.map(([n, v]) => `${n}=${v}`).join(' ')} | off: ${scan.off.length} materials`
    + `${strayBare.length ? ` | STRAY: ${strayBare.join(',')}` : ''}`
    + `${scan.flatClaim.length ? ` | 1-BAND: ${scan.flatClaim.join(',')}` : ''}`);

  const wire = await p.evaluate((n, k, x) => window.__wire(n, k, x), 'matSkin', named.matSkin, 0.55);
  if (wire.err || !wire.mask) {
    skipped(`${cid}: the opt-out is the value, not a missing wire`, wire.err || 'no skin on screen');
  } else {
    check(`${cid}: the opt-out is the value, not a missing wire`,
      wire.moved >= MIN_WIRE_FRAC * wire.mask && wire.lighter <= 0.02 * Math.max(wire.moved, 1),
      `handing matSkin the lean moves ${wire.moved} of ${wire.mask} px`
      + ` = ${(wire.moved / wire.mask * 100).toFixed(1)}% (${wire.lighter} of them lighter)`);
  }

  // The subject: the largest garment group whose median can carry the answer in 8-bit, with a flat
  // run long enough to be the defect. Measured with the lean as the product authored it.
  const lean = DIM ? 0 : (formOverride != null ? formOverride : authored);
  if (DIM) {
    const k = await p.evaluate((x) => window.__dimAlbedo(x), 0.90);
    console.log(`  (--dim: ${k} garment albedos scaled by 0.90, lean at ${lean})`);
  }
  const groups = [];
  for (const name of CLOTH) {
    if (named[name] === undefined) continue;
    const s = await p.evaluate((k, x, d) => window.__group(k, x, d), named[name], lean, DIM);
    if (!s.mask || s.mask < 2000) continue;
    s.name = name;
    groups.push(s);
    console.log(`    ${name.padEnd(13)} ${String(s.mask).padStart(6)} px  med ${String(s.med).padStart(5)}`
      + `  row y${s.rowY} (${s.rowN} px)  flat span ${String(s.span).padStart(4)} px at x${s.spanX?.[0]}`
      + `  off ${s.offMin}..${s.offMax} -> on ${s.onMin}..${s.onMax}  order ${s.order}`);
  }
  const ok = groups.filter((s) => s.med >= MID_LO && s.med <= MID_HI && s.span >= MIN_SPAN);
  ok.sort((a, c) => c.mask - a.mask);
  const s = ok[0];
  if (!s) {
    const why = groups.length
      ? `no garment both in ${MID_LO}..${MID_HI} counts and flat over ${MIN_SPAN}+ px: `
        + groups.map((g) => `${g.name} med ${g.med} span ${g.span}`).join(', ')
      : 'no garment group of 2000+ px on screen';
    for (const row of ['the flat span is a defect worth measuring', 'the span that held one value now has relief',
      'the relief runs across the span', 'the garment was not merely dimmed']) skipped(`${cid}: ${row}`, why);
  } else {
    subjects++;
    check(`${cid}: the flat span is a defect worth measuring`,
      s.span >= MIN_SPAN && s.offMax - s.offMin <= MAX_SPAN_RANGE,
      `${s.name}: ${s.span} px of a ${s.rowN} px row held ${s.offMin}..${s.offMax}`
      + ` (${(s.span / s.rowN * 100).toFixed(0)}% of the row)`);
    const relief = s.onMax - s.onMin;
    anyRelief += relief;
    check(`${cid}: the span that held one value now has relief`,
      relief >= MIN_RELIEF,
      `${s.onMin}..${s.onMax} = ${relief.toFixed(1)} counts`
      + ` (x${(s.onMax / Math.max(s.onMin, 1)).toFixed(2)}), was ${(s.offMax - s.offMin).toFixed(1)}`
      + ` | ${s.onScan.join(' ')} vs ${s.offScan.join(' ')}`);
    check(`${cid}: the relief runs across the span`,
      Math.abs(s.order) >= MIN_ORDER_ABS && Math.abs(s.order) >= MIN_ORDER_FRAC * relief,
      `second half minus first half: ${s.order} counts`
      + ` = ${(Math.abs(s.order) / Math.max(relief, 0.1)).toFixed(2)} of the relief`
      + ` (need ${MIN_ORDER_FRAC} and ${MIN_ORDER_ABS} count)`);
    check(`${cid}: the garment was not merely dimmed`,
      s.p95off - s.p95on <= MAX_P95_DROP,
      `p95 ${s.p95off} -> ${s.p95on} = ${(s.p95off - s.p95on).toFixed(1)} counts (allow ${MAX_P95_DROP})`);
  }
  if (DIM) await p.evaluate(() => window.__dimAlbedo(1));
  await p.evaluate(() => window.__grab());
  await p.screenshot({ path: `${outDir}/${cid}-body.png` });
}

check('enough garments were in a range where the question can be asked', subjects >= MIN_SUBJECTS,
  `${subjects} of ${WHO.length} characters scored (need ${MIN_SUBJECTS})`);
check('the lean changed at least one subject', anyRelief > 0, `${anyRelief.toFixed(1)} counts of relief in total`);
check('no shader failed to compile', glsl.length === 0, glsl.slice(0, 2).join(' | ') || 'clean');
check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');

// Six rows per character; the seven standing rows are the quality pin, the isolation, the
// scene-wide claimant scan and the four closing rows. A probe that quietly stops asking is the
// failure mode this line exists for.
const want = WHO.length * 6 + 7;
const got = pass + fail + skip;
check('every subject was asked every question', got === want, `${got} rows of ${want} expected`);

console.log(`\nshots -> ${outDir}`);
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
await b.close();
process.exit(fail ? 1 : 0);
