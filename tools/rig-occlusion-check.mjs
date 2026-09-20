// 人物没有接触阴影: a body whose parts never shade each other.
//
// Why this probe exists. The sun's shadow camera is 156 m across a 2048 map, so one texel is
// 7.6 cm — a third of a character's head *diameter* — and shadow.normalBias is 4.5 cm, which is
// 0.39 of a head radius. Nothing on a body's own scale can survive that. Measured (.run/selfshadow
// .mjs) with the world hidden and only the character's own castShadow toggled, so every pixel that
// moves is a pixel the body shadowed on itself:
//
//     hour  8 (sun elev 16.2°)  head self-shadow      0 px of 212463 body px = 0.00%
//     hour 12 (sun elev 54.5°)  head self-shadow      0 px of 265246 body px = 0.00%
//     ...five elevations, head and body, 0.00%-1.56%
//     control: switching the sun's shadow off moves 43439 px of 490000 on the terrain
//
// The map works. It simply cannot see a jaw, a fringe, a pauldron or a sleeve. What that costs,
// measured on a 700 px portrait, is a face with 21.9 counts of luminance between p05 and p95
// across a whole lit head — one flat field of skin with a mouth painted on it.
//
// The fix cannot be another shadow map (a character-sized cascade is a second full shadow pass for
// one object), so the occlusion is *baked into the geometry* — per vertex, in bind space, inside
// bakeSkinned, by voxelizing the merged body and marching a cosine-weighted hemisphere off every
// vertex (gfx/occlusion.js) — and multiplied into the light response in TOON_FRAG behind uRigAo.
// It is the same argument terrain's `aoBake` and grass's `uRootDark` already make: a gradient that
// belongs to the geometry costs nothing per frame.
//
// Method, and why each half is here.
//
//   * The *data* is asserted before any pixel: an attribute for every vertex, a field that
//     discriminates (a constant one would pass every pixel bar by dimming the whole body), and
//     two orderings that are true of a human and false of a bug — a neck is more enclosed than a
//     face (0.674 vs 0.390), and the jaw is the most enclosed band of the head while some band
//     above it is open (0.736 under the jaw, 0.052 on the crown). Those are the rows --flat breaks.
//   * Then that it reaches the screen at all, as a fraction of the rig's own silhouette, and that
//     it only ever *darkens*: occlusion that brightens anything is not occlusion.
//   * Then the row that says it is occlusion and not a dimmer, which is the whole point. Skin
//     rows are measured in both states and the largest drop is priced against the median one:
//     lyra reads 16.2 counts under the jaw against a median of ~2 (ratio 8), ignar 44.0 against
//     8.4 (5.2), while a flat field moves every row by the same amount and reads ~1.1. The bar is
//     a *ratio*, so it does not care how bright a character's skin is.
//   * And the obligation that stops "make it darker" from being the answer: the skin's own mean
//     may not drop more than a few counts, and the bake may not cost more than a fraction of the
//     character-load budget it runs inside.
//   * The consumer gate runs both ways. Every material on the rig must read the attribute, and
//     everything else in the scene that claims uRigAo must be a baked rig too — the uniform is
//     what turns the term on, a geometry with no aRigOcc reads 0 there, so a material shared with
//     an unbaked mesh would darken a body with no data to darken it by. (There are four other
//     claimants in mondstadt, the NPC rigs: char:katheryne, char:smith and two more.)
//   * And the opt-out is asserted, not assumed: enemies build a rig per spawn (actors.js is the
//     only buildEnemy caller and nothing caches per type), so at ~40 ms a bake they wait for that
//     cache — a live creature must have neither the attribute nor a material claiming one.
//
// Mutations it must fail, both run against the shipped build (83 rows, green at 83/0/0):
//     --ao 0   the uniform off -> 15 failures: both pixel rows on all seven characters read
//              exactly 0 px and 0.0 counts, plus the anti-vacuous row.
//     --flat   every vertex given the field's own mean, in the data, shader untouched -> 35
//              failures: the field no longer discriminates, both orderings collapse, the
//              selectivity ratio falls to 1.2-1.3 and the skin mean drops 15-22 counts. Note
//              which row does *not* fail: "it reaches the screen" still reads 29-43%, because a
//              dimmer reaches the screen too. That row is why the ratio row exists.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { INSTALL } from './lib/probe-world.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/rig-occlusion'; })();
// The mutation runs. --ao overrides the amount on every material at once; --flat replaces the
// baked field with its own mean, which is the strongest statement of "a dimmer, not occlusion".
const aoOverride = (() => { const i = argv.indexOf('--ao'); return i >= 0 ? +argv[i + 1] : null; })();
const FLAT = argv.includes('--flat');
fs.mkdirSync(outDir, { recursive: true });
const W = 700, H = 700;
const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WHO = ['lyra', 'ignar', 'seris', 'kaelen', 'volt', 'terra', 'nyx'];
const FILL = 0.62;                 // head diameter as a fraction of frame height

// --- the bars, all of them measured first -------------------------------------
// The field has to reach both ends: an open convex surface reads 0 (a crown band measures 0.035
// to 0.057) and an enclosed one reads most of the way to 1 (a fist between fingers, 0.967).
const OCC_MIN_LOW = 0.05, OCC_MIN_HIGH = 0.60;
// And its mean has to stay in the middle. 0.469-0.506 across seven characters; a field pushed to
// either end is either doing nothing or darkening everything.
const OCC_MEAN = [0.25, 0.65];
// A neck sits in a socket under a jaw; a face is a convex surface in the open. 0.674 vs 0.390.
const MIN_NECK_OVER_HEAD = 0.15;
// Down the head: the jaw band is the most enclosed of all of them on all seven characters
// (0.633-0.739), and somewhere above it the head has an open surface. *Which* band is the open one
// is a fact about the haircut, not about the body — the first version of this row asked the
// topmost band and volt read 0.339 there, because volt's crown is a ring of spikes leaning into
// each other and their inward walls genuinely see each other. Terra passed the same row for an
// accident: its second-from-top band reads 0.564 and only the 0.009 sliver above it was measured.
// So the row asks the head for its least occluded band instead, which is 0.009-0.187 measured.
const MIN_JAW_OVER_OPEN = 0.35, MAX_OPEN_BAND = 0.25;
// The bake runs on the character-load path (38-43 ms measured, on llvmpipe, for ~10k vertices).
const MAX_BAKE_MS = 150;
// On a head portrait the toggle moves 61k-100k px of a ~265k px body.
const MIN_MOVED_FRAC = 0.04;
// Occlusion that brightens is not occlusion: 51-129 px of 21k-100k, which is the driver's own
// dither on the tone curve.
const MAX_LIGHTER_FRAC = 0.02;
// The selectivity ratio: largest skin-row drop over the median one. 5.2-8 measured; a flat field
// reads ~1.1.
const MIN_SELECTIVITY = 2.5;
// ...and the drop has to be visible at all, in counts of 255.
const MIN_PEAK_DROP = 5;
// The obligation on the other side: this may not be a dimmer switch on the whole character.
const MAX_MEAN_DROP = 12;

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); } else {
    fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
};
const skipped = (name, why) => { skip++; console.log(`  SKIP ${name} — ${why}`); };
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

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
// llvmpipe boots every browser at `low`; the ramp, the ceiling and this term all read differently
// there, and a portrait shot at `low` is a frame no player sees.
await p.evaluate(() => {
  window.game.setAutoQuality(false);
  window.game.setQuality('high');
  window.game.setWorldTime(12);
});
await sleep(3000);
check('the quality tier is pinned to high', await p.evaluate(() => window.game.quality) === 'high');

// An enemy rig deliberately has none of this: actors.js builds one per spawn and the bake costs
// ~40 ms, so creatures wait for a per-type cache. Assert the opt-out on a live one *before* the
// world is hidden, and assert it both ways — no attribute and no material claiming one.
// A zone with no camp in streaming range has no enemy actor to look at, so the rig is built here
// through the product's own builder rather than waited for.
const foe = await p.evaluate(async () => {
  try {
    const mod = await import('/src/gfx/enemies.js');
    const view = mod.buildEnemy('hilichurl', {});
    const v = view.skinned;
    if (!v) return { err: 'the built enemy has no skinned mesh' };
    const mats = Array.isArray(v.material) ? v.material : [v.material];
    return {
      attr: !!v.geometry.getAttribute('aRigOcc'),
      claimed: mats.filter((m) => (m.userData?.toon?.uRigAo?.value ?? 0) > 0).length,
      mats: mats.length,
    };
  } catch (e) { return { err: String(e).slice(0, 120) }; }
});
if (foe.err) skipped('an enemy rig neither bakes occlusion nor claims it', foe.err);
else {
  check('an enemy rig neither bakes occlusion nor claims it', !foe.attr && foe.claimed === 0,
    `hilichurl: attribute ${foe.attr}, ${foe.claimed} of ${foe.mats} materials claiming it`);
}

// Stop the loop: every number here is the same camera rendered twice with one thing changed, and
// that is only an experiment if nothing else moves between the two frames.
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
  window.__ao = (v) => {
    let n = 0;
    for (const m of window.__mats()) { const u = m.userData?.toon?.uRigAo; if (u) { u.value = v; n++; } }
    return n;
  };
  // How many of the rig's materials read the attribute, and at what amount.
  window.__claims = () => {
    const vals = window.__mats().map((m) => m.userData?.toon?.uRigAo?.value ?? null);
    return { mats: vals.length, on: vals.filter((v) => v > 0).length, vals: [...new Set(vals)] };
  };
  // Everything else in the scene that claims baked occlusion. uRigAo is what switches the term
  // on; a geometry with no aRigOcc attribute reads 0 there, so a material *shared* with an
  // unbaked mesh would darken a body that has no data to darken it by.
  window.__foreignClaims = () => {
    const g = window.game, mine = window.game.me.actor.rig.skinned;
    const out = [];
    g.scene.traverse((o) => {
      if (!o.material || o === mine) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if ((m.userData?.toon?.uRigAo?.value ?? 0) > 0) {
          const chain = [];
          for (let q = o; q && chain.length < 4; q = q.parent) chain.push(q.name || q.type);
          out.push({
            what: chain.join('<'),
            baked: !!o.geometry?.getAttribute('aRigOcc'),
            rig: !!o.skeleton,
            visible: o.visible,
          });
          break;
        }
      }
    });
    return out;
  };
  // The baked field itself: its range, and the two orderings that are true of a body.
  window.__occ = () => {
    const rig = window.game.me.actor.rig, geo = rig.skinned.geometry;
    const occ = geo.getAttribute('aRigOcc'), si = geo.getAttribute('skinIndex');
    const pos = geo.getAttribute('position');
    if (!occ) return null;
    const names = rig.skeleton.bones.map((b2) => b2.name);
    const R = rig.P.headR;
    let lo = 1, hi = 0, sum = 0;
    const bone = new Map(), band = new Map();
    for (let i = 0; i < occ.count; i++) {
      const v = occ.getX(i);
      lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v;
      const bn = names[si.getX(i)] || '?';
      const e = bone.get(bn) || { n: 0, s: 0 };
      e.n++; e.s += v; bone.set(bn, e);
      if (bn === 'head' || bn === 'neck') {
        // Height in head radii, in bind space: the jaw and the crown are different numbers here
        // whatever the character's height.
        const k = Math.round(pos.getY(i) / (R * 0.5)) * 0.5;
        const e2 = band.get(k) || { n: 0, s: 0 };
        e2.n++; e2.s += v; band.set(k, e2);
      }
    }
    const meanOf = (m, k) => (m.get(k) ? m.get(k).s / m.get(k).n : null);
    // A band of three vertices is noise, not a jawline.
    const keys = [...band.keys()].filter((k) => band.get(k).n >= 20).sort((x, y) => x - y);
    const bandAt = (k) => (k === undefined ? null : meanOf(band, k));
    const vals = keys.map((k) => bandAt(k));
    return {
      count: occ.count, verts: pos.count,
      min: +lo.toFixed(3), max: +hi.toFixed(3), mean: +(sum / occ.count).toFixed(3),
      neck: meanOf(bone, 'neck'), head: meanOf(bone, 'head'),
      jaw: vals.length ? vals[0] : null,
      bandMin: vals.length ? Math.min(...vals) : null,
      bandMinAt: vals.length ? keys[vals.indexOf(Math.min(...vals))] : null,
      jawIsMax: vals.length > 2 && vals[0] >= Math.max(...vals),
      bands: keys.map((k, i) => [k, +vals[i].toFixed(3)]),
    };
  };
  // The mutation: every vertex gets the field's own mean, so the body is uniformly darkened and
  // nothing is shaded. Data, not code — the shader is untouched.
  window.__flatten = () => {
    const geo = window.game.me.actor.rig.skinned.geometry;
    const occ = geo.getAttribute('aRigOcc');
    if (!occ) return 0;
    let s = 0;
    for (let i = 0; i < occ.count; i++) s += occ.getX(i);
    const m = s / occ.count;
    for (let i = 0; i < occ.count; i++) occ.setX(i, m);
    occ.needsUpdate = true;
    return +m.toFixed(3);
  };
  // The rig's own silhouette, so a pixel count can be priced against the body that threw it.
  window.__mask = () => {
    const rig = window.game.me.actor.rig, r = window.game.r, was = r.bloom.enabled;
    r.bloom.enabled = false;
    const on = window.__grab();
    rig.skinned.visible = false;
    const off = window.__grab();
    rig.skinned.visible = true;
    r.bloom.enabled = was;
    let n = 0;
    for (let i = 0; i < on.w * on.h; i++) {
      const d = Math.abs(on.px[i * 4] - off.px[i * 4]) + Math.abs(on.px[i * 4 + 1] - off.px[i * 4 + 1])
        + Math.abs(on.px[i * 4 + 2] - off.px[i * 4 + 2]);
      if (d > 8) n++;
    }
    return n;
  };
  // Two frames, one uniform. Bloom off, because a halo would count pixels the term never touched.
  window.__diff = (v0, v1) => {
    const r = window.game.r, was = r.bloom.enabled;
    r.bloom.enabled = false;
    window.__ao(v0);
    const a = window.__grab();
    window.__ao(v1);
    const c = window.__grab();
    r.bloom.enabled = was;
    let moved = 0, sum = 0, darker = 0, lighter = 0;
    for (let i = 0; i < a.w * a.h; i++) {
      const la = 0.2126 * a.px[i * 4] + 0.7152 * a.px[i * 4 + 1] + 0.0722 * a.px[i * 4 + 2];
      const lc = 0.2126 * c.px[i * 4] + 0.7152 * c.px[i * 4 + 1] + 0.0722 * c.px[i * 4 + 2];
      const d = Math.abs(a.px[i * 4] - c.px[i * 4]) + Math.abs(a.px[i * 4 + 1] - c.px[i * 4 + 1])
        + Math.abs(a.px[i * 4 + 2] - c.px[i * 4 + 2]);
      if (d > 8) { moved++; sum += d; if (lc < la - 0.5) darker++; else if (lc > la + 0.5) lighter++; }
    }
    return { moved, of: a.w * a.h, meanD: +(sum / Math.max(moved, 1)).toFixed(1), darker, lighter };
  };
  // Skin luminance per screen row, in whatever state the uniform is in now. readPixels is
  // bottom-up, so the first rows are the throat and the last the crown.
  window.__skinRows = () => {
    const rig = window.game.me.actor.rig, skin = [rig.materials.matSkin];
    const r = window.game.r, was = r.bloom.enabled;
    r.bloom.enabled = false;
    const on = window.__grab();
    skin.forEach((m) => { m.visible = false; });
    const off = window.__grab();
    skin.forEach((m) => { m.visible = true; });
    r.bloom.enabled = was;
    const rows = [];
    for (let y = 0; y < on.h; y++) rows.push({ n: 0, s: 0 });
    let all = 0, allN = 0;
    for (let i = 0; i < on.w * on.h; i++) {
      const d = Math.abs(on.px[i * 4] - off.px[i * 4]) + Math.abs(on.px[i * 4 + 1] - off.px[i * 4 + 1])
        + Math.abs(on.px[i * 4 + 2] - off.px[i * 4 + 2]);
      if (d <= 8) continue;
      const L = 0.2126 * on.px[i * 4] + 0.7152 * on.px[i * 4 + 1] + 0.0722 * on.px[i * 4 + 2];
      const y = Math.floor(i / on.w);
      rows[y].n++; rows[y].s += L;
      all += L; allN++;
    }
    return {
      n: allN, mean: allN ? +(all / allN).toFixed(2) : 0,
      rows: rows.map((r2, y) => [y, r2.n, r2.n ? r2.s / r2.n : null]).filter((r2) => r2[1] > 40),
    };
  };
})()`);

const AMT = await p.evaluate(() => {
  // The shipped amount, read off the product's own material rather than restated here.
  const m = window.__mats().find((x) => x.userData?.toon?.uRigAo);
  return m ? m.userData.toon.uRigAo.value : null;
});
console.log(`\nuRigAo as shipped: ${AMT}${aoOverride != null ? `  (mutation: --ao ${aoOverride})` : ''}`
  + `${FLAT ? '  (mutation: --flat)' : ''}`);
const amt = aoOverride != null ? aoOverride : AMT;
let anyMoved = 0;

for (const cid of WHO) {
  const got = await p.evaluate((c) => window.__pick(c), cid);
  if (got.charId !== cid) {
    skipped(`${cid}`, `setCharacter left ${got.charId} on screen`);
    continue;
  }
  await p.evaluate((f) => window.__aim(0, f), FILL);
  console.log(`\n${cid}`);

  const bake = await p.evaluate(() => window.game.me.actor.rig.occlusion);
  const occ = await p.evaluate(() => window.__occ());
  if (!occ) {
    check(`${cid}: every vertex carries a baked occlusion value`, false, 'no aRigOcc attribute on the rig');
    for (const row of ['the field discriminates', 'a neck is more enclosed than a face',
      'occlusion falls from the jaw to the crown', 'every material on the rig reads it',
      'nothing else in the scene claims it', 'the bake fits the character-load budget',
      'it reaches the screen', 'it only ever darkens', 'it shades crevices, not the whole body',
      'the body does not merely get darker']) skipped(`${cid}: ${row}`, 'nothing was baked');
    continue;
  }
  if (FLAT) {
    const m = await p.evaluate(() => window.__flatten());
    console.log(`  (--flat: every vertex set to ${m})`);
  }
  const occ2 = FLAT ? await p.evaluate(() => window.__occ()) : occ;

  check(`${cid}: every vertex carries a baked occlusion value`,
    occ2.count === occ2.verts && occ2.count > 1000, `${occ2.count} of ${occ2.verts} vertices`);
  check(`${cid}: the field discriminates`,
    occ2.min <= OCC_MIN_LOW && occ2.max >= OCC_MIN_HIGH
    && occ2.mean >= OCC_MEAN[0] && occ2.mean <= OCC_MEAN[1],
    `min ${occ2.min} mean ${occ2.mean} max ${occ2.max}`);
  if (occ2.neck == null || occ2.head == null) {
    skipped(`${cid}: a neck is more enclosed than a face`, 'no head/neck bone on this rig');
  } else {
    check(`${cid}: a neck is more enclosed than a face`,
      occ2.neck - occ2.head >= MIN_NECK_OVER_HEAD,
      `neck ${occ2.neck.toFixed(3)} vs head ${occ2.head.toFixed(3)} (need +${MIN_NECK_OVER_HEAD})`);
  }
  if (occ2.jaw == null || occ2.bandMin == null || occ2.bands.length < 3) {
    skipped(`${cid}: the head is shaded under the jaw and open somewhere above`,
      `only ${occ2.bands.length} populated head bands`);
  } else {
    check(`${cid}: the head is shaded under the jaw and open somewhere above`,
      occ2.jawIsMax && occ2.bandMin <= MAX_OPEN_BAND
      && occ2.jaw - occ2.bandMin >= MIN_JAW_OVER_OPEN,
      `jaw ${occ2.jaw.toFixed(3)} (the head's most enclosed band: ${occ2.jawIsMax})`
      + ` -> open at y/headR ${occ2.bandMinAt}: ${occ2.bandMin.toFixed(3)}`
      + ` (bands ${occ2.bands.map((x) => x.join(':')).join(' ')})`);
  }

  const claims = await p.evaluate(() => window.__claims());
  check(`${cid}: every material on the rig reads it`,
    claims.on === claims.mats && claims.vals.length === 1 && claims.vals[0] > 0,
    `${claims.on} of ${claims.mats} materials at ${claims.vals.join('/')}`);
  const foreign = await p.evaluate(() => window.__foreignClaims());
  const unbaked = foreign.filter((f) => !f.baked || !f.rig);
  check(`${cid}: everything that claims it was baked`, unbaked.length === 0,
    `${foreign.length} other claimants, all skinned rigs with the attribute`
    + `${unbaked.length ? `; NOT: ${unbaked.slice(0, 3).map((f) => f.what).join(', ')}` : ''}`
    + ` (${foreign.slice(0, 2).map((f) => f.what).join(', ') || 'none'})`);
  check(`${cid}: the bake fits the character-load budget`,
    !!bake && bake.ms <= MAX_BAKE_MS, `${bake ? bake.ms : '?'} ms for ${occ2.verts} vertices`
    + ` (grid ${bake ? bake.dims.join('x') : '?'}, ${bake ? bake.rays : '?'} rays)`);

  // --- what it does on screen ------------------------------------------------
  const mask = await p.evaluate(() => window.__mask());
  const diff = await p.evaluate((v) => window.__diff(0, v), amt);
  anyMoved += diff.moved;
  check(`${cid}: it reaches the screen`,
    mask > 1000 && diff.moved / mask >= MIN_MOVED_FRAC,
    `${diff.moved} px of a ${mask} px body = ${(diff.moved / Math.max(mask, 1) * 100).toFixed(1)}%`
    + `, mean Δ ${diff.meanD}`);
  check(`${cid}: it only ever darkens`,
    diff.lighter <= MAX_LIGHTER_FRAC * Math.max(diff.moved, 1),
    `${diff.lighter} lighter of ${diff.moved} moved`);

  // The selectivity row: the same skin rows in both states.
  await p.evaluate((v) => window.__ao(v), 0);
  const off = await p.evaluate(() => window.__skinRows());
  await p.evaluate((v) => window.__ao(v), amt);
  const on = await p.evaluate(() => window.__skinRows());
  const byY = new Map(off.rows.map(([y, n, L]) => [y, L]));
  const drops = on.rows.filter(([y]) => byY.has(y)).map(([y, n, L]) => byY.get(y) - L);
  if (drops.length < 20) {
    skipped(`${cid}: it shades crevices, not the whole body`, `only ${drops.length} skin rows in frame`);
    skipped(`${cid}: the body does not merely get darker`, `only ${drops.length} skin rows in frame`);
  } else {
    const peak = Math.max(...drops), mid = median(drops);
    check(`${cid}: it shades crevices, not the whole body`,
      peak >= MIN_PEAK_DROP && peak >= MIN_SELECTIVITY * Math.max(mid, 0.25),
      `deepest row -${peak.toFixed(1)} counts, median row -${mid.toFixed(1)}`
      + `, ratio ${(peak / Math.max(mid, 0.25)).toFixed(1)} (need ${MIN_SELECTIVITY})`);
    check(`${cid}: the body does not merely get darker`,
      off.mean - on.mean <= MAX_MEAN_DROP,
      `skin mean ${off.mean} -> ${on.mean} (${(on.mean - off.mean).toFixed(1)})`);
  }
  await p.evaluate(() => window.__grab());
  await p.screenshot({ path: `${outDir}/${cid}-head.png` });
}

check('the uniform changed at least one subject', anyMoved > 0,
  `${anyMoved} px moved across ${WHO.length} characters`);
check('no shader failed to compile', glsl.length === 0, glsl.slice(0, 2).join(' | ') || 'clean');
check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');

// Every subject that loaded owes 11 rows; the four standing rows are the quality pin, the enemy
// opt-out, the isolation and the anti-vacuous "something moved", plus the two hygiene rows.
const want = WHO.length * 11 + 6;
console.log(`\nshots -> ${outDir}`);
console.log(`${pass} passed, ${fail} failed, ${skip} skipped (expected ${want} rows, ran ${pass + fail + skip})`);
if (pass + fail + skip < want) {
  console.log(`  NOTE ${want - (pass + fail + skip)} rows never ran — a probe that skips silently is not green`);
}
await b.close();
process.exit(fail > 0 ? 1 : 0);
