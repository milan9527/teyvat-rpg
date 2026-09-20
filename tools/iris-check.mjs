// 眼睛是一块平色的圆片: an iris that holds exactly one value.
//
// Why this probe exists. Measured on a 700 px portrait with the head at 62 % of the frame — the
// size a player sees a face at — the iris is one of the largest single features on screen and it
// was a flat disc of colour (.run/eye.mjs, before this unit):
//
//     lyra   iris 9272 px of 490000   top 195.4  middle 199.3  bottom 198.7   ordering  +3.3
//     ignar  iris 9517 px             top 185.3  middle 186.2  bottom 183.6   ordering  -1.7
//     seris  iris 9680 px             top 168.3  middle 170.3  bottom 166.9   ordering  -1.4
//     ...all seven within 3.3 counts top to bottom, and on four of them (ignar, seris, volt, nyx)
//     the sign is *inverted*: the lens was brightest where the lid hangs over it
//
// (That table is this probe's own `--shade 0` run, which is the defect reproduced on demand.) Its
// median and its 95th percentile were 0.1 counts apart. A shape the size of a thumbnail, holding
// one number. Nothing in the scene can shade it and nothing was ever going to: the lens is
// 4 mm tall and the sun's shadow map resolves 7.6 cm (see rig-occlusion-check for that arithmetic),
// the lash bar hanging directly over it is flat-shaded with no shadow of its own, and the baked rig
// occlusion from that unit is a hemisphere integral over the *body* — at the scale of an eye socket
// it is one smooth value across the whole lens. A drawn eye is the other way round by a wide
// margin, because the lid and the lashes hang over it; that step is most of what makes an iris read
// as wet rather than printed.
//
// The fix is a two-tone on the albedo, gated by uPartShade and driven by a new per-part attribute
// aPartV (skin.js): height up the part the vertex belongs to, 0 at its own lowest vertex and 1 at
// its highest, in bind space. It has to be per *part*, because a merged rig has one object space
// for the whole body — the gradient the material already carried (uRootH/vRootUp, written for a
// blade of grass) cannot say "the top of the iris" when every face feature sits at y ≈ 1.5 m and
// spans 5 cm. IRIS_LID_SHADE is [depth 0.42, pivot 0.56, softness 0.16]: the top 44 % of the lens
// darkens by up to 42 %, over a band 32 % of the lens tall, and the bottom 40 % is untouched.
//
// Method, and why each half is here.
//
//   * The data first: the attribute exists for every vertex, and the iris lens spans the full 0..1
//     of it. A part with no vertical extent reads 0 everywhere — the identity — so "the attribute
//     is there" and "the attribute says something about this part" are two different questions.
//   * Then the two identities that keep the term off everything else, asserted in both directions:
//     exactly one of the rig's materials claims uPartShade and it is matEye, and everything in the
//     scene that claims it reads aPartV. The uniform is the gate, which is deliberate — an enemy's
//     eye orb and its elemental trim are the same recipe (enemies.js `eye` and `trim`) and must
//     keep a flat lens: a hem hoop is a whole bright surface, not something under an eyelid.
//   * Then the authored vector's *shape*, not its digits: a lid hangs from above, so the pivot
//     stays in the upper half, and it is a shadow and not a paint line, so the band has width.
//   * Then what it does on screen, inside the iris's own mask (hide matEye and diff): that it
//     moves a real fraction of the lens, that it only ever darkens, and that nothing outside the
//     lens moves at all — the sclera, the pupil, the catchlight and the lash bar are separate
//     materials and must not have been dragged along.
//   * Then the row that is the whole point, and the one a constant field cannot fake: the lens is
//     shaded *from the top down*. The bottom third against the top third, in counts, and then the
//     ratio of the top third's drop to the bottom third's. The bottom 40 % of the lens is outside
//     the smoothstep, so its drop is arithmetically zero — a dimmer of any strength reads ~1 on
//     that ratio while this term reads 20+. That pairing is why the pixel-presence row cannot be
//     the headline: a uniform dim reaches the screen too (see rig-occlusion-check, --flat).
//
// Mutations it must fail, both run against the shipped build (84 rows, green at 84/0/0):
//     --shade 0   the uniform off -> 22 failures: 0 px move on all seven characters, the ordering
//                 falls back to the defect this unit was written for (lyra 3.3 counts, ignar -1.7,
//                 seris -1.4 — inverted), and the anti-vacuous row goes with it.
//     --flatv     every aPartV replaced by the iris group's own mean, in the data, shader
//                 untouched -> 21 failures: the data row, the ordering (3.1, -2.6) and the ratio
//                 (0.9 against 88-116 shipped). Note which rows do *not* fail: "it reaches the
//                 screen" reads 94.1 % — *more* than the shipped 39 % — and "it only ever darkens"
//                 passes too, because a uniform dimmer reaches the screen and only darkens. Those
//                 two rows are presence; the ratio is the feature.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { INSTALL } from './lib/probe-world.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/iris'; })();
const shadeOverride = (() => { const i = argv.indexOf('--shade'); return i >= 0 ? +argv[i + 1] : null; })();
const FLATV = argv.includes('--flatv');
fs.mkdirSync(outDir, { recursive: true });
const W = 700, H = 700;
const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WHO = ['lyra', 'ignar', 'seris', 'kaelen', 'volt', 'terra', 'nyx'];
const FILL = 0.62;                 // head diameter as a fraction of frame height: a portrait

// --- the bars, all of them measured first -------------------------------------
// The lens has to use the whole attribute, or the two-tone's pivot means nothing. Measured 0.000
// to 1.000 on every character: the part is a sphere and the extremes are its poles.
const SPAN_LO = 0.02, SPAN_HI = 0.98;
// A lid hangs over an eye from above and a shadow has a soft edge. Both are claims about what the
// authored vector *is*, so that "tune it to nothing" is not a way to make this probe green.
const MIN_PIVOT = 0.40, MIN_SOFT = 0.05, MAX_DEPTH = 0.60;
// The iris owns 9370-9689 px of a 700x700 portrait.
const MIN_MASK = 2000;
// Of that mask, the shaded band is the top 44 % minus whatever the lash bar already covers.
const MIN_MOVED_FRAC = 0.15;
// A shadow that brightens is not a shadow. The few that do are the driver's dither on the
// tone curve at the mask's antialiased edge.
const MAX_LIGHTER_FRAC = 0.02;
// Nothing outside the lens may move: the sclera, pupil, catchlight and lash bar are their own
// materials with the term off, so the only pixels here are the mask's own edge.
const MAX_OUTSIDE_FRAC = 0.05;
// The ordering, in counts of 255. Measured bottom-minus-top: lyra 26.4, volt 23.7, ignar 21.1,
// nyx 24.1 — against 4.2, -0.1 and -0.3 before the term existed.
const MIN_ORDERING = 8;
// And the ordering has to come from the top being shaded rather than the lens being dimmed. The
// bottom 40 % of the lens sits below the smoothstep, so its drop is arithmetically zero; a
// constant field of any strength reads ~1 here.
const MIN_SELECTIVITY = 4;
// ...with the drop itself visible at all.
const MIN_TOP_DROP = 6;

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
// llvmpipe boots every browser at `low`; the ramp and the tone curve read differently there, and a
// portrait shot at `low` is a frame no player sees.
await p.evaluate(() => {
  window.game.setAutoQuality(false);
  window.game.setQuality('high');
  window.game.setWorldTime(12);
});
await sleep(3000);
check('the quality tier is pinned to high', await p.evaluate(() => window.game.quality) === 'high');

// An enemy's eye is the same recipe with no lid over it, and its elemental `trim` is a whole bright
// surface built from that recipe. Assert the opt-out through the product's own builder, and assert
// it is the *uniform* that opts out: the attribute is written for every rig, so a creature that
// claimed uPartShade would get a two-tone down its hoops.
const foe = await p.evaluate(async () => {
  try {
    const mod = await import('/src/gfx/enemies.js');
    const view = mod.buildEnemy('hilichurl', {});
    const v = view.skinned;
    if (!v) return { err: 'the built enemy has no skinned mesh' };
    const mats = Array.isArray(v.material) ? v.material : [v.material];
    return {
      attr: !!v.geometry.getAttribute('aPartV'),
      claimed: mats.filter((m) => (m.userData?.toon?.uPartShade?.value?.x ?? 0) > 0).length,
      mats: mats.length,
    };
  } catch (e) { return { err: String(e).slice(0, 120) }; }
});
if (foe.err) skipped('an enemy eye is a flat lens', foe.err);
else {
  check('an enemy eye is a flat lens', foe.attr && foe.claimed === 0,
    `hilichurl: aPartV ${foe.attr}, ${foe.claimed} of ${foe.mats} materials claiming the lid shade`);
}

// Stop the loop: every number below is one camera rendered twice with one thing changed, and that
// is only an experiment if nothing else moves between the two frames.
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
    const head = wp(rig.bones.head), R = rig.P.headR;
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
  // render() only queues work; readPixels is also what makes the picture exist before it is read.
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
  // Which vertices belong to the iris lenses, found through the material rather than by index:
  // matEye is exactly the two iris spheres (humanoid.js), and aPartV is written per part, so each
  // lens spans 0..1 on its own.
  window.__irisVerts = () => {
    const rig = window.game.me.actor.rig, geo = rig.skinned.geometry;
    const pv = geo.getAttribute('aPartV'), idx = geo.index;
    if (!pv) return null;
    const k = window.__mats().indexOf(rig.materials.matEye);
    if (k < 0) return { err: 'this rig has no matEye' };
    const set = new Set();
    for (const grp of geo.groups) {
      if (grp.materialIndex !== k) continue;
      for (let i = grp.start; i < grp.start + grp.count; i++) set.add(idx ? idx.getX(i) : i);
    }
    let lo = 1, hi = 0, s = 0;
    for (const v of set) { const x = pv.getX(v); lo = Math.min(lo, x); hi = Math.max(hi, x); s += x; }
    let glo = 1, ghi = 0;
    for (let i = 0; i < pv.count; i++) { const x = pv.getX(i); glo = Math.min(glo, x); ghi = Math.max(ghi, x); }
    return {
      count: pv.count, verts: geo.getAttribute('position').count,
      n: set.size, min: +lo.toFixed(3), max: +hi.toFixed(3), mean: +(s / Math.max(set.size, 1)).toFixed(3),
      gmin: +glo.toFixed(3), gmax: +ghi.toFixed(3), idx: [...set],
    };
  };
  // The mutation: the iris keeps its attribute but the attribute stops saying anything, at its own
  // mean. Data only — the shader is untouched — so what survives is exactly "a uniform dimmer".
  window.__flatten = (list, m) => {
    const geo = window.game.me.actor.rig.skinned.geometry;
    const pv = geo.getAttribute('aPartV');
    if (!pv) return 0;
    for (const v of list) pv.setX(v, m);
    pv.needsUpdate = true;
    return list.length;
  };
  // The claimants, and the one knob this probe turns. Captured once per character so that setting
  // the depth to 0 does not lose the authored vector.
  window.__lid = { mats: [], v: null };
  window.__lidScan = () => {
    const rig = window.game.me.actor.rig, mats = window.__mats();
    window.__lid.mats = mats.filter((m) => (m.userData?.toon?.uPartShade?.value?.x ?? 0) > 0);
    const u = window.__lid.mats[0]?.userData.toon.uPartShade.value;
    window.__lid.v = u ? [+u.x.toFixed(3), +u.y.toFixed(3), +u.z.toFixed(3)] : null;
    return {
      mats: mats.length, on: window.__lid.mats.length, v: window.__lid.v,
      named: Object.entries(rig.materials)
        .filter(([, m]) => window.__lid.mats.includes(m)).map(([k]) => k),
    };
  };
  window.__depth = (x) => {
    for (const m of window.__lid.mats) m.userData.toon.uPartShade.value.x = x;
    return window.__lid.mats.length;
  };
  // Everything else in the scene that claims the lid shade. The uniform is what switches the term
  // on and a geometry with no aPartV reads 0 there, which is the unshaded side of the step — so a
  // material shared with an unbaked mesh would be silently off, and one shared with another rig
  // would two-tone whatever part that rig gave it.
  window.__foreign = () => {
    const g = window.game, mine = g.me.actor.rig.skinned;
    const out = [];
    g.scene.traverse((o) => {
      if (!o.material || o === mine) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if ((m.userData?.toon?.uPartShade?.value?.x ?? 0) > 0) {
          const chain = [];
          for (let q = o; q && chain.length < 4; q = q.parent) chain.push(q.name || q.type);
          out.push({ what: chain.join('<'), attr: !!o.geometry?.getAttribute('aPartV'), rig: !!o.skeleton });
          break;
        }
      }
    });
    return out;
  };
  // The lens on screen, in three frames: as shipped, with the lens hidden (which is its mask), and
  // with the term's depth at 0. Bloom off, or a halo counts as a pixel the term touched.
  window.__iris = (depth) => {
    const g = window.game, rig = g.me.actor.rig, r = g.r, was = r.bloom.enabled;
    const mat = rig.materials.matEye;
    r.bloom.enabled = false;
    window.__depth(depth);
    const on = window.__grab();
    mat.visible = false;
    const hid = window.__grab();
    mat.visible = true;
    window.__depth(0);
    const off = window.__grab();
    window.__depth(depth);
    r.bloom.enabled = was;
    const L = (px, i) => 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
    const rows = new Map();
    let mask = 0, moved = 0, darker = 0, lighter = 0, outside = 0;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < on.w * on.h; i++) {
      const dm = Math.abs(on.px[i * 4] - hid.px[i * 4]) + Math.abs(on.px[i * 4 + 1] - hid.px[i * 4 + 1])
        + Math.abs(on.px[i * 4 + 2] - hid.px[i * 4 + 2]);
      const dt = Math.abs(on.px[i * 4] - off.px[i * 4]) + Math.abs(on.px[i * 4 + 1] - off.px[i * 4 + 1])
        + Math.abs(on.px[i * 4 + 2] - off.px[i * 4 + 2]);
      if (dm <= 8) { if (dt > 8) outside++; continue; }
      mask++;
      const x = i % on.w, y = (i / on.w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      const e = rows.get(y) || { n: 0, on: 0, off: 0 };
      e.n++; e.on += L(on.px, i); e.off += L(off.px, i); rows.set(y, e);
      if (dt > 8) { moved++; if (L(off.px, i) > L(on.px, i) + 0.5) darker++; else if (L(off.px, i) < L(on.px, i) - 0.5) lighter++; }
    }
    if (!mask) return { mask: 0 };
    // Thirds by row *index*, so each third holds a comparable number of the lens's own rows
    // whatever shape the visible part of the lens is. readPixels is bottom-up: low rows are the
    // bottom of the lens, which is the part a lid does not reach.
    const ys = [...rows.keys()].sort((a, c) => a - c);
    const third = (a, c) => {
      const sl = ys.slice(Math.floor(ys.length * a), Math.max(Math.floor(ys.length * c), Math.floor(ys.length * a) + 1));
      let n = 0, so = 0, sf = 0;
      for (const y of sl) { const e = rows.get(y); n += e.n; so += e.on; sf += e.off; }
      return n ? { n, on: +(so / n).toFixed(1), off: +(sf / n).toFixed(1) } : null;
    };
    return {
      mask, moved, darker, lighter, outside, box: [x1 - x0 + 1, y1 - y0 + 1],
      bottom: third(0, 0.34), middle: third(0.34, 0.67), top: third(0.67, 1.0),
    };
  };
})()`);

console.log(`\nIRIS_LID_SHADE as shipped: read from the material below`
  + `${shadeOverride != null ? `  (mutation: --shade ${shadeOverride})` : ''}`
  + `${FLATV ? '  (mutation: --flatv)' : ''}`);
let anyMoved = 0;

for (const cid of WHO) {
  const got = await p.evaluate((c) => window.__pick(c), cid);
  if (got.charId !== cid) { skipped(`${cid}`, `setCharacter left ${got.charId} on screen`); continue; }
  await p.evaluate((f) => window.__aim(0, f), FILL);
  console.log(`\n${cid}`);

  const pv = await p.evaluate(() => window.__irisVerts());
  const scan = await p.evaluate(() => window.__lidScan());
  const depth = shadeOverride != null ? shadeOverride : (scan.v ? scan.v[0] : 0);

  if (!pv || pv.err) {
    check(`${cid}: every vertex carries a per-part height`, false, pv ? pv.err : 'no aPartV attribute');
    for (const row of ['the iris lens spans the whole attribute', 'exactly one material claims the lid shade',
      'everything that claims it reads the attribute', 'the lid shade is a soft shadow from above',
      'the lens is on screen', 'it reaches the screen', 'it only ever darkens',
      'nothing outside the lens moves', 'the lens is shaded from the top down',
      'the top is shaded, the lens is not dimmed']) skipped(`${cid}: ${row}`, 'no per-part height to read');
    continue;
  }
  check(`${cid}: every vertex carries a per-part height`,
    pv.count === pv.verts && pv.count > 1000 && pv.gmin <= SPAN_LO && pv.gmax >= SPAN_HI,
    `${pv.count} of ${pv.verts} vertices, ${pv.gmin}..${pv.gmax} over the whole rig`);
  if (FLATV) {
    const n = await p.evaluate((l, m) => window.__flatten(l, m), pv.idx, pv.mean);
    console.log(`  (--flatv: ${n} iris vertices set to ${pv.mean})`);
  }
  const pv2 = FLATV ? await p.evaluate(() => window.__irisVerts()) : pv;
  check(`${cid}: the iris lens spans the whole attribute`,
    pv2.min <= SPAN_LO && pv2.max >= SPAN_HI,
    `${pv2.n} lens vertices, ${pv2.min}..${pv2.max} (mean ${pv2.mean})`);

  check(`${cid}: exactly one material claims the lid shade`,
    scan.on === 1 && scan.named.length === 1 && scan.named[0] === 'matEye',
    `${scan.on} of ${scan.mats} materials: ${scan.named.join(',') || 'none'} at ${JSON.stringify(scan.v)}`);
  const foreign = await p.evaluate(() => window.__foreign());
  const blind = foreign.filter((f) => !f.attr);
  check(`${cid}: everything that claims it reads the attribute`, blind.length === 0,
    `${foreign.length} other claimants${blind.length ? `; NOT: ${blind.slice(0, 3).map((f) => f.what).join(', ')}` : ''}`
    + ` (${foreign.slice(0, 2).map((f) => f.what).join(', ') || 'none'})`);
  check(`${cid}: the lid shade is a soft shadow from above`,
    !!scan.v && scan.v[1] >= MIN_PIVOT && scan.v[2] >= MIN_SOFT && scan.v[0] > 0 && scan.v[0] <= MAX_DEPTH,
    `depth ${scan.v?.[0]} pivot ${scan.v?.[1]} softness ${scan.v?.[2]}`);

  // --- what it does on screen ------------------------------------------------
  const s = await p.evaluate((d) => window.__iris(d), depth);
  check(`${cid}: the lens is on screen`, s.mask >= MIN_MASK,
    `${s.mask} px, box ${(s.box || []).join('x')}`);
  if (s.mask < MIN_MASK) {
    for (const row of ['it reaches the screen', 'it only ever darkens', 'nothing outside the lens moves',
      'the lens is shaded from the top down', 'the top is shaded, the lens is not dimmed']) {
      skipped(`${cid}: ${row}`, `only ${s.mask} px of iris in frame`);
    }
    continue;
  }
  anyMoved += s.moved;
  check(`${cid}: it reaches the screen`, s.moved / s.mask >= MIN_MOVED_FRAC,
    `${s.moved} px of the ${s.mask} px lens = ${(s.moved / s.mask * 100).toFixed(1)}%`);
  check(`${cid}: it only ever darkens`, s.lighter <= MAX_LIGHTER_FRAC * Math.max(s.moved, 1),
    `${s.lighter} lighter of ${s.moved} moved`);
  check(`${cid}: nothing outside the lens moves`, s.outside <= MAX_OUTSIDE_FRAC * Math.max(s.moved, 1),
    `${s.outside} px outside a ${s.mask} px mask (${s.moved} moved inside)`);
  if (!s.top || !s.bottom) {
    skipped(`${cid}: the lens is shaded from the top down`, 'the lens covers too few rows to split');
    skipped(`${cid}: the top is shaded, the lens is not dimmed`, 'the lens covers too few rows to split');
  } else {
    check(`${cid}: the lens is shaded from the top down`,
      s.bottom.on - s.top.on >= MIN_ORDERING,
      `top ${s.top.on} middle ${s.middle?.on} bottom ${s.bottom.on}`
      + ` — bottom is ${(s.bottom.on - s.top.on).toFixed(1)} counts brighter (need ${MIN_ORDERING})`);
    const dropTop = s.top.off - s.top.on, dropBot = s.bottom.off - s.bottom.on;
    check(`${cid}: the top is shaded, the lens is not dimmed`,
      dropTop >= MIN_TOP_DROP && dropTop >= MIN_SELECTIVITY * Math.max(dropBot, 0.25),
      `top -${dropTop.toFixed(1)} counts, bottom -${dropBot.toFixed(1)}`
      + `, ratio ${(dropTop / Math.max(dropBot, 0.25)).toFixed(1)} (need ${MIN_SELECTIVITY})`);
  }
  await p.evaluate(() => window.__grab());
  await p.screenshot({ path: `${outDir}/${cid}-head.png` });
}

check('the uniform changed at least one subject', anyMoved > 0,
  `${anyMoved} px moved across ${WHO.length} characters`);
check('no shader failed to compile', glsl.length === 0, glsl.slice(0, 2).join(' | ') || 'clean');
check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');

// Every subject that loaded owes 11 rows; the four standing rows are the quality pin, the enemy
// opt-out, the isolation and the three closing rows. A probe that silently stops asking is the
// failure mode this line exists for.
const want = WHO.length * 11 + 6;
const got = pass + fail + skip;
check('every subject was asked every question', got === want, `${got} rows of ${want} expected`);

console.log(`\nshots -> ${outDir}`);
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
await b.close();
process.exit(fail ? 1 : 0);
