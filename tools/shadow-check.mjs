// Does anything in this world cast a shadow on the ground?
//
// Nothing in this repo asked. The rig is elaborate — a 2048² map, a PCF radius, bias, normalBias, a
// frustum that follows the player, `castShadow` decided per scatter group with a resolution argument
// behind each choice — and 48 other probes photograph the world without once measuring whether a
// shadow lands. Two things made that easy to miss:
//
//   * Every calibrated shot in the repo is taken at **12:00**, where the sun sits 53° up and a
//     1.6 m character's shadow is 1.2 m long and mostly under her own feet. A missing shadow and a
//     noon shadow look nearly the same.
//   * `motion-check` switches the avatar's shadow *off* on purpose (it moves with the pose), which
//     is right for that probe and leaves the one tool that photographs the avatar from the side with
//     nothing to say about shadows either.
//
// So this probe asks the question directly, at three hours, and it asks it the only way that cannot
// be answered by the ground's own mottle: **hide the caster and shoot the same frame.** The rect
// does not need to know what the grass looks like — it needs the same pixels twice, with and without
// the thing that is supposed to be darkening them.
//
// Three things this had to learn the hard way, all of them visible in the first run's pictures:
//
//   * **A predicted rect misses.** `h / tan(elevation)` is the shadow of a body standing on a
//     *plane*. The first run measured 蒙德's spawn meadow, which falls away toward the camera, and
//     the sample point — snapped to the terrain but placed by flat-ground trigonometry — landed off
//     the shadow: the tree section read 0.4% darker at a point 30 px from ground that was 32%
//     darker. So the sample is now a **sweep** along the shadow axis, ±2 shadow-lengths at 0.1
//     steps, each point widened by a short lateral cross-line (a straight ray drifts off a half-metre
//     shadow on ground with any tilt: 08:00 read 0 past 1.5 m of a 3.7 m shadow for that reason
//     alone). The assertion is about the darkest point of the profile and where it sits — pixels find
//     the shadow, geometry only has to agree about which half of the axis it is on and roughly how
//     far. The probe also moves to the flattest ground it can find first.
//   * **A screenshot is not a frame.** llvmpipe renders at ~2 fps and Firefox's compositor lags
//     behind the WebGL swap, so the first run's noon "avatar hidden" shot was a capture of the boot
//     camera: a different hill, 610k pixels different, and a 14% "change" on a control rect that
//     nothing had touched. Every shot here is therefore taken twice and only accepted when two
//     consecutive captures are **bit-identical** — with the loop stopped, nothing in the scene moves,
//     so anything but a zero difference means the pipeline had not caught up.
//   * **The tier decides whether there is a shadow map at all.** llvmpipe boots every browser probe
//     at `low`, where `shadowMap.enabled` is false. Pinned to `high`, and asserted in both
//     directions, because "there are no shadows" and "this tier has no shadows" are the same
//     picture and only one of them is a bug.
//
// What it found, once those three were fixed: the shadows are fine. 46-53% darker than bare ground
// at every hour, on the avatar and under a 9 m oak, with the sun-side control at 0.0-0.1%. The plan
// this probe was written to justify — narrowing sky.js's ±78 m ortho frustum because "the avatar's
// shadow is weak at a low sun" — was an artifact of the misplaced rects and the stale captures, and
// it was dropped rather than pushed through ~500 already-calibrated pixel gates for no measured gain.
// That is the probe's real output: the bars below now hold the working behaviour still.
//
// Exit code is the number of failed assertions.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { decodePng, rectStats, pixelsDiffering } from './lib/png.mjs';
import { raiseRank } from './lib/account.mjs';

const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const APP = process.env.GAME_APP || 'http://127.0.0.1:5173';
const W = 1000, H = 700;
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : '/tmp/shadow-check';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0, passes = 0, skips = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); } else {
    fails++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
  return !!ok;
}
function skip(name, why) { skips++; console.log(`  SKIP ${name} — ${why}`); }

// The three hours. Noon is the shortest shadow this world ever has and the hour every other probe
// shoots at; 08:00 and 16:00 put the sun at ~24° and stretch the same body to more than twice its
// height, which is where a shadow map's texel size stops being an implementation detail.
const HOURS = [12, 16, 8];
// How much darker the darkest point of the profile has to be than the same pixels with the caster
// removed. One number for all three hours, because the measurement says the hour barely matters:
// 52.8% at noon, 45.9% at 16:00, 50.7% at 08:00, 51.7% under a tree, across two runs that placed
// their rects differently (41-53% overall). The bar is half of the weakest of those, so it survives
// the ±5-point run-to-run wobble and still fails a build whose shadows have halved — and reads 0,
// not 20%, if the shadow pass or the caster flag goes away.
const MIN_DROP = 0.2;
// The sun-side half of the same sweep, over the same ground, with nothing put between it and the
// sun: it must stay put. This is what separates "casts a shadow" from "darkens its surroundings".
const MAX_MIRROR = 0.025;
// The sweep, in shadow lengths. Symmetric on purpose: the sun side is the control, so it gets
// exactly the same treatment, the same number of samples and the same rects as the shadow side. It
// runs to two lengths rather than one because at noon the useful part of the sweep starts *outside*
// the avatar's own screen box, which is a metre wide however short her shadow is; samples past the
// tip simply read 0, which is what a control is for.
const SWEEP = [];
for (let f = -2.0; f <= 2.001; f += 0.1) SWEEP.push(+f.toFixed(2));
// Lateral offsets, in metres, sampled at every sweep point. A shadow is a *line* half a metre wide
// and the sweep is a straight ray computed from the horizontal sun direction: on ground with any
// tilt at all the two diverge, and 08:00's profile went to 0 past 1.5 m of a 3.7 m shadow purely
// because the ray had wandered off a thin shadow that the picture plainly shows. Taking the darkest
// of a short cross-line answers the question actually being asked — is there shadow on the ground
// this far along — and the sun-side control gets the same widened search, which can only make the
// control harder to pass.
const CROSS = [-0.45, -0.225, 0, 0.225, 0.45];

const tokFile = '/tmp/world-token.txt';
let token = fs.existsSync(tokFile) ? fs.readFileSync(tokFile, 'utf8').trim() : '';
if (!token) {
  const r = await fetch(`${API}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  token = (await r.json()).token;
  fs.writeFileSync(tokFile, token);
}
await raiseRank(API, token, 30).catch(() => {});

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
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
p.on('console', (m) => {
  const t = m.text().slice(0, 200);
  if (/\[vite\].*(hot updated|hmr update|page reload)/i.test(t)) { errs.push('HMR: ' + t); console.log('[HMR]', t); }
  if (m.type() === 'error') errs.push(t);
});

/**
 * One accepted frame: render, capture, capture again, and only believe it when the two captures are
 * identical to the byte. See the header — the first run's noon control moved 14% because a capture
 * arrived a whole camera behind the render that produced it.
 */
async function shoot(name) {
  let prev = null;
  for (let i = 0; i < 7; i++) {
    await p.evaluate(() => { for (let k = 0; k < 3; k++) window.game.r.render(0.016); });
    await sleep(420);
    const buf = await p.screenshot();
    const img = decodePng(buf);
    if (prev && pixelsDiffering(prev, img, 2) === 0) {
      fs.writeFileSync(`${OUT}/${name}.png`, buf);
      return { img, settled: true, tries: i + 1 };
    }
    prev = img;
    fs.writeFileSync(`${OUT}/${name}.png`, buf);
  }
  return { img: prev, settled: false, tries: 7 };
}

const overlaps = (r, q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h;
const inFrame = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w < W && r.y + r.h < H;

/**
 * Read one hide-and-shoot pair as a profile along the shadow axis.
 *
 * `geo` is what the page handed back: the sample points already projected, the caster's own screen
 * box, and the pixels-per-metre along each screen axis. Everything here is difference measurement —
 * a sample already sitting in a tree's shadow is dark in *both* frames and simply shows a smaller
 * delta, which is the conservative direction.
 */
function profile(geo, withCaster, without) {
  const w = Math.max(8, Math.round(geo.pxAway * 0.22));
  const h = Math.max(8, Math.round(geo.pxSide * 0.22));
  const rows = [];
  for (const s of geo.samples) {
    let take = null, blocked = 0;
    for (let i = 0; i < s.pxs.length; i++) {
      const px = s.pxs[i];
      const r = { x: Math.round(px[0] - w / 2), y: Math.round(px[1] - h / 2), w, h, label: `f${s.f}` };
      if (!inFrame(r) || overlaps(r, geo.body)) { blocked++; continue; }
      const a = rectStats(withCaster, r), c = rectStats(without, r);
      const drop = (c.lum - a.lum) / Math.max(1, c.lum);
      if (!take || drop > take.drop) take = { lat: CROSS[i], lit: c.lum, shad: a.lum, drop };
    }
    if (!take) { rows.push({ f: s.f, m: s.m, skip: blocked === s.pxs.length ? 'on the caster' : 'offscreen' }); continue; }
    rows.push({ f: s.f, m: s.m, ...take });
  }
  const anti = rows.filter((r) => !r.skip && r.f > 0.05);
  const sun = rows.filter((r) => !r.skip && r.f < -0.05);
  const best = anti.reduce((m, r) => (!m || r.drop > m.drop ? r : m), null);
  const worst = sun.reduce((m, r) => (!m || Math.abs(r.drop) > Math.abs(m.drop) ? r : m), null);
  return { rows, anti, sun, best, worst, rect: `${w}x${h}` };
}
function printProfile(pr) {
  const cell = (r) => (r.skip ? `${r.f}:${r.skip === 'offscreen' ? 'off' : 'body'}` : `${r.f}:${(100 * r.drop).toFixed(0)}`);
  console.log(`    profile (shadow-lengths:% darker, rect ${pr.rect})  ${pr.rows.map(cell).join('  ')}`);
}

await p.goto(APP, { waitUntil: 'domcontentloaded' });
await p.evaluate((t) => localStorage.setItem('teyvat.token', t), token);
await p.reload({ waitUntil: 'domcontentloaded' });
await sleep(5000);
await p.click('[data-act="resume"]');
let up = false;
for (let i = 0; i < 90; i++) {
  if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) { up = true; break; }
  await sleep(1000);
}
if (!up) {
  console.log('window.game never started running — check ./tools/daemon.sh status');
  await b.close();
  process.exit(1);
}
await sleep(4000);

console.log('\n--- 1. the rig the tier promises');
await p.evaluate(() => { window.game.setAutoQuality(false); window.game.setQuality('low'); });
await sleep(2500);
const lowRig = await p.evaluate(() => ({
  q: window.game.quality,
  map: window.game.r.renderer.shadowMap.enabled,
  cast: window.game.world.sky.sun.castShadow,
}));
check('at the low tier the shadow pass is off in both places',
  lowRig.q === 'low' && lowRig.map === false && lowRig.cast === false,
  `${lowRig.q}: renderer ${lowRig.map}, sun ${lowRig.cast}`);
await p.evaluate(() => { window.game.setQuality('high'); });
await sleep(3000);
const rig = await p.evaluate(() => {
  const s = window.game.world.sky.sun.shadow;
  return {
    q: window.game.quality,
    map: window.game.r.renderer.shadowMap.enabled,
    cast: window.game.world.sky.sun.castShadow,
    size: s.mapSize.x, extent: s.camera.right, radius: s.radius,
    bias: s.bias, normalBias: s.normalBias,
  };
});
check('at the high tier it is on, with a map and a frustum',
  rig.q === 'high' && rig.map === true && rig.cast === true && rig.size >= 2048 && rig.extent > 10,
  `${rig.q}: ${rig.size}² over ±${rig.extent} m, PCF radius ${rig.radius}`);
// How much ground one shadow sample covers — the rig's resolution, in the units the eye cares
// about. This started life as an opinion ("a 15 cm limb cannot live in an 8 cm texel, so demand
// ≤ 5 cm") and the pictures refuted it: at 7.6 cm and a ±18 cm filter the avatar's own shadow
// still reads 46-53% darker than bare ground at every hour. So it is a regression fence, not a
// quality bar: it fails if the frustum is widened or the map shrunk (extent 96 m → 9.4 cm, or
// 2048² → 1536² → 10.2 cm), and says nothing about 7.6 cm being enough. The drop assertions below
// are what answer that.
const texel = 200 * rig.extent / rig.size;
check('one shadow sample still covers a hand-width of ground, not a limb-width',
  texel <= 9.0,
  `${texel.toFixed(1)} cm of ground per texel, filter ±${(rig.radius * texel).toFixed(0)} cm`
  + ` (±${rig.extent} m over ${rig.size}²)`);

// The flattest ground the zone can offer, away from its landmarks: `h / tan(elevation)` is the
// shadow of a body standing on a plane, and 蒙德's spawn meadow is a slope. Found by asking the
// world's own `heightAt`, walked to through the product's own zone-entry path.
const flat = await p.evaluate(async () => {
  const g = window.game, w = g.world;
  const half = w.zone.size / 2 - 20;
  // The built POI entries, not the zone table: an entry knows where its prop actually stands.
  const pois = w.pois.length ? w.pois : (w.zone.poi || []);
  let best = null;
  for (let x = -half; x <= half; x += 6) {
    for (let z = -half; z <= half; z += 6) {
      let poi = 1e9;
      for (const q of pois) poi = Math.min(poi, Math.hypot(q.x - x, q.z - z));
      if (poi < 26) continue;                       // landmarks bring architecture and clearings
      const h0 = w.heightAt(x, z);
      if (h0 < 1) continue;                          // water and shoreline
      let dev = 0;
      for (const r of [2, 4, 7]) {
        for (let a = 0; a < 8; a++) {
          const d = w.heightAt(x + Math.cos(a * Math.PI / 4) * r, z + Math.sin(a * Math.PI / 4) * r);
          dev = Math.max(dev, Math.abs(d - h0));
        }
      }
      if (!best || dev < best.dev) best = { x, z, h0, dev, poi };
    }
  }
  if (best) await g.enterZone('mondstadt', { x: best.x, z: best.z });
  await new Promise((r) => setTimeout(r, 7000));
  return best;
});
console.log(`\n--- 2. the avatar's own shadow, on the flattest ground in 蒙德`);
check('the probe found ground flat enough for flat-ground trigonometry',
  !!flat && flat.dev <= 1.2,
  flat ? `(${flat.x}, ${flat.z}): ${flat.dev.toFixed(2)} m of relief within 7 m,`
    + ` nearest landmark ${flat.poi.toFixed(0)} m` : 'no candidate');

const boot = await p.evaluate((sweep, cross) => {
  const g = window.game;
  g.stop();
  window.__shSweep = sweep;
  window.__shCross = cross;
  for (const el of document.querySelectorAll('[data-hud], #world-overlay')) el.style.visibility = 'hidden';

  /**
   * Aim at one caster for one hour, and hand back everything the measurement needs.
   *
   * Everything is derived from the light that is actually in the scene: `sun.position - target` is
   * the only thing that says where the sun is (`lightDir` is a stored copy, and with the loop
   * stopped a copy is a frame behind). The shadow of a body of height `h` under a sun at elevation
   * `e` reaches `h / tan(e)` along the sun's horizontal direction, negated.
   *
   * The camera goes *across* the shadow axis and well above it: `away` then maps to pure screen
   * horizontal (it is perpendicular to the view direction, so it has no screen-vertical component)
   * and the caster's height leans sideways instead of down the axis, which is what keeps both halves
   * of the sweep — the shadow and its control — clear of the caster's own pixels.
   */
  window.__shAim = (hour, at, sweep = window.__shSweep, cross = window.__shCross) => {
    const g = window.game, cam = g.camera;
    const V = cam.position.constructor;
    if (hour != null) g.setWorldTime(hour);
    const d = g.world.sky.sun.position.clone().sub(g.world.sky.sun.target.position).normalize();
    const elev = Math.asin(d.y);
    const away = new V(-d.x, 0, -d.z).normalize();
    const side = new V(-away.z, 0, away.x);
    const L = at.h / Math.max(0.05, Math.tan(elev));
    const foot = new V(at.x, at.y, at.z);
    const camEl = 62 * Math.PI / 180;
    // Far enough that the caster's own perspective spread does not eat the near half of the sweep:
    // at 9 m the head, a metre closer to the camera than the feet, widened her screen box to a
    // metre of ground either side and every noon sample inside 1.0 m was thrown away.
    const dist = Math.max(13, L * 2.0 + 5);
    cam.fov = 45;
    cam.position.set(
      foot.x + side.x * dist * Math.cos(camEl),
      foot.y + dist * Math.sin(camEl),
      foot.z + side.z * dist * Math.cos(camEl),
    );
    cam.lookAt(foot.x, foot.y + at.h * 0.2, foot.z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const proj = (v) => {
      const q = v.clone().project(cam);
      return [(q.x * 0.5 + 0.5) * window.innerWidth, (-q.y * 0.5 + 0.5) * window.innerHeight];
    };
    const ground = (v) => { v.y = g.world.heightAt(v.x, v.z); return v; };
    const samples = sweep.map((f) => ({
      f, m: +(f * L).toFixed(2),
      pxs: cross.map((c) => proj(ground(foot.clone().addScaledVector(away, f * L).addScaledVector(side, c)))),
    }));
    // The caster's own screen box, from its bounds: 8 corners of [x±r, y..y+h, z±r].
    let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const sy of [0, at.h]) {
      const q = proj(new V(at.x + sx * at.r, at.y + sy, at.z + sz * at.r));
      bx0 = Math.min(bx0, q[0]); by0 = Math.min(by0, q[1]);
      bx1 = Math.max(bx1, q[0]); by1 = Math.max(by1, q[1]);
    }
    const o = proj(foot);
    const pa = proj(foot.clone().addScaledVector(away, 1));
    const ps = proj(foot.clone().addScaledVector(side, 1));
    return {
      hour, elev: +(elev * 180 / Math.PI).toFixed(1), L: +L.toFixed(2), h: +at.h.toFixed(2),
      sun: [+d.x.toFixed(2), +d.y.toFixed(2), +d.z.toFixed(2)],
      pxAway: +Math.hypot(pa[0] - o[0], pa[1] - o[1]).toFixed(1),
      pxSide: +Math.hypot(ps[0] - o[0], ps[1] - o[1]).toFixed(1),
      samples,
      body: { x: Math.round(bx0), y: Math.round(by0), w: Math.round(bx1 - bx0), h: Math.round(by1 - by0) },
    };
  };
  // The avatar stands where her *actor* stands: `heightAt` is the terrain under her, which is not
  // the same number (she can be a step above it on a rock, or sunk into grass), and the shadow is
  // cast by the model, not by the collision height.
  window.__shMe = () => {
    const me = window.game.me, gp = me.actor.group.position;
    return { x: gp.x, y: gp.y, z: gp.z, h: me.actor.height, r: 0.55,
      terrain: +window.game.world.heightAt(gp.x, gp.z).toFixed(2) };
  };
  window.__shHide = (on) => { window.game.me.actor.group.visible = !on; };
  return { zone: g.zoneId, q: g.quality, running: g._running, indoor: !!g.world.zone.indoor,
    x: +g.me.x.toFixed(1), z: +g.me.z.toFixed(1) };
}, SWEEP, CROSS);
check('the frames are shot outdoors in the zone this probe asked for',
  boot.zone === 'mondstadt' && boot.indoor === false, `${boot.zone} indoor=${boot.indoor}`);
check('the tier survived the zone change', boot.q === 'high', boot.q);
check('the loop is stopped, so a pair of frames shares one camera and one sun',
  boot.running === false, `standing at (${boot.x}, ${boot.z})`);

const me = await p.evaluate(() => window.__shMe());
console.log(`  the avatar is ${me.h.toFixed(2)} m tall at (${me.x.toFixed(1)}, ${me.z.toFixed(1)}),`
  + ` model feet y ${me.y.toFixed(2)} against terrain ${me.terrain}`);
const seen = {};
for (const hour of HOURS) {
  const geo = await p.evaluate((h, at) => window.__shAim(h, at), hour, me);
  const a = await shoot(`h${hour}-avatar`);
  await p.evaluate(() => window.__shHide(true));
  const c = await shoot(`h${hour}-hidden`);
  await p.evaluate(() => window.__shHide(false));
  const pr = profile(geo, a.img, c.img);
  seen[hour] = { geo, pr };
  console.log(`\n  ${hour}:00  sun ${geo.sun.join(',')} at ${geo.elev}° up, shadow ${geo.L} m,`
    + ` ${geo.pxAway} px/m along the axis, ${geo.pxSide} px/m across`);
  printProfile(pr);
  check(`${hour}:00 both captures settled, so the pair differs only by the avatar`,
    a.settled && c.settled, `${a.tries} + ${c.tries} captures`);
  if (!pr.best || !pr.worst || pr.anti.length < 5 || pr.sun.length < 5) {
    skip(`${hour}:00 the avatar darkens the ground away from the sun`,
      `only ${pr.anti.length} shadow-side and ${pr.sun.length} sun-side samples cleared the body`);
    continue;
  }
  console.log(`    darkest ${(100 * pr.best.drop).toFixed(1)}% at ${pr.best.m} m`
    + ` (lum ${pr.best.lit} → ${pr.best.shad}), sun side worst ${(100 * pr.worst.drop).toFixed(1)}%`
    + ` at ${pr.worst.m} m`);
  check(`${hour}:00 the avatar darkens the ground away from the sun`,
    pr.best.drop >= MIN_DROP,
    `${(100 * pr.best.drop).toFixed(1)}% darker at ${pr.best.m} m, want ${(100 * MIN_DROP).toFixed(0)}%`);
  check(`${hour}:00 ...and leaves the ground toward the sun alone`,
    Math.abs(pr.worst.drop) <= MAX_MIRROR,
    `${(100 * pr.worst.drop).toFixed(1)}% at ${pr.worst.m} m, allow ${(100 * MAX_MIRROR).toFixed(1)}%`);
  // Pixels and geometry have to agree about *where*. The darkest sample must fall inside the
  // shadow the light asks for, not past its tip and not under the feet.
  check(`${hour}:00 the darkening sits where the sun's elevation puts it`,
    pr.best.f > 0.05 && pr.best.f <= 1.15,
    `darkest at ${pr.best.f} shadow-lengths (${pr.best.m} m of a ${geo.L} m shadow)`);
}

// The shadow is not a decal: it has to grow as the sun falls. Geometry says so from the light, and
// the profile says so from the ground — the far end of a noon shadow is lit again by 16:00.
if (seen[12]?.pr.best && seen[16]?.pr.best) {
  check('the shadow the light asks for grows as the sun falls',
    seen[16].geo.L > seen[12].geo.L * 1.8 && seen[8].geo.L > seen[12].geo.L * 1.8,
    `12:00 ${seen[12].geo.L} m at ${seen[12].geo.elev}°, 16:00 ${seen[16].geo.L} m at`
    + ` ${seen[16].geo.elev}°, 08:00 ${seen[8].geo.L} m at ${seen[8].geo.elev}°`);
  // 1.4 shadow-lengths of *noon* shadow, in metres, is well past the noon tip and well inside the
  // 16:00 one. The same patch of ground, measured twice: lit at noon, shaded in the afternoon.
  const far = seen[12].geo.L * 1.4;
  const at = (hour) => seen[hour].pr.rows.filter((r) => !r.skip)
    .reduce((m, r) => (!m || Math.abs(r.m - far) < Math.abs(m.m - far) ? r : m), null);
  const noon = at(12), late = at(16);
  if (noon && late && Math.abs(noon.m - far) < 0.5 && Math.abs(late.m - far) < 0.5) {
    check('ground beyond the noon shadow is in shadow by 16:00',
      noon.drop < 0.04 && late.drop > 0.06,
      `${far.toFixed(1)} m out: ${(100 * noon.drop).toFixed(1)}% at noon,`
      + ` ${(100 * late.drop).toFixed(1)}% at 16:00`);
  } else {
    skip('ground beyond the noon shadow is in shadow by 16:00', `no sample near ${far.toFixed(1)} m in both sweeps`);
  }
}

console.log('\n--- 3. the world casts too');
// The other half of the claim: a *prop* lays a shadow. `world.js` decides `castShadow` per scatter
// group with a resolution argument behind each choice (grass is off because a 3 cm blade cannot
// register in a 7.6 cm texel), and nothing checks that the groups which are on arrive in the scene
// graph switched on. Trees carry 蒙德's silhouette, so they are the ones to ask.
//
// A streamed prop is not an object: `propPool.acquire` hands back slot claims in InstancedMeshes
// shared by the whole zone, so there is nothing per-tree to hide. What can be hidden is the batch —
// every instance of one (variant, piece). So the caster removed here is *all* the trees, and the
// tree measured is one with no other trunk within 20 m, so nothing else was standing on the ground
// the sweep walks. Trunk positions and crown heights come from the instance matrices and the piece
// geometry; nothing about the tree is authored in this file.
const tree = await p.evaluate((iso) => {
  const g = window.game, cam = g.camera;
  const M = new cam.matrixWorld.constructor();
  const batches = [];
  for (const b of g.world.propPool.batches.values()) {
    if (!b.mesh || !/^(oak|pine|bamboo|deadTree|cypress)\b/.test(b.name || '')) continue;
    b.piece.geo.computeBoundingBox();
    batches.push(b);
  }
  if (!batches.length) return { reason: 'no tree batch is resident' };
  const inst = new Map();
  let casting = 0, total = 0;
  for (const b of batches) {
    const bb = b.piece.geo.boundingBox;
    for (let i = 0; i < b.mesh.count; i++) {
      b.mesh.getMatrixAt(i, M);
      const e = M.elements;
      const sx = Math.hypot(e[0], e[1], e[2]), sy = Math.hypot(e[4], e[5], e[6]), sz = Math.hypot(e[8], e[9], e[10]);
      const key = `${Math.round(e[12] / 0.6)},${Math.round(e[14] / 0.6)}`;
      let r = inst.get(key);
      if (!r) inst.set(key, r = { x: e[12], z: e[14], y0: 1e9, y1: -1e9, rad: 0, cast: false });
      r.y0 = Math.min(r.y0, e[13] + bb.min.y * sy);
      r.y1 = Math.max(r.y1, e[13] + bb.max.y * sy);
      r.rad = Math.max(r.rad, Math.abs(bb.max.x) * sx, Math.abs(bb.min.x) * sx,
        Math.abs(bb.max.z) * sz, Math.abs(bb.min.z) * sz);
      r.cast = r.cast || b.mesh.castShadow;
      total++;
      if (b.mesh.castShadow) casting++;
    }
  }
  const trees = [...inst.values()];
  let best = null;
  for (const t of trees) {
    if (!t.cast || t.y1 - t.y0 < 4) continue;
    const d = Math.hypot(t.x - g.me.x, t.z - g.me.z);
    if (d < 10 || d > 95) continue;
    let near = 1e9;
    for (const o of trees) if (o !== t) near = Math.min(near, Math.hypot(o.x - t.x, o.z - t.z));
    if (near < iso) continue;
    // Flat ground for the same reason the avatar moved: the sweep is a straight line.
    const gy = g.world.heightAt(t.x, t.z);
    let dev = 0;
    for (let a = 0; a < 8; a++) {
      for (const r of [4, 9]) {
        dev = Math.max(dev, Math.abs(g.world.heightAt(t.x + Math.cos(a * Math.PI / 4) * r,
          t.z + Math.sin(a * Math.PI / 4) * r) - gy));
      }
    }
    if (dev > 2.2) continue;
    if (!best || dev < best.dev) best = { ...t, d, near, dev, gy };
  }
  if (!best) {
    return { reason: `no tree ≥4 m, 10-95 m away, with ${iso} m of clear flat ground`, trees: trees.length, casting, total };
  }
  window.__shTrees = (hide) => { for (const b of batches) b.mesh.visible = hide ? false : b.used > 0; };
  window.__shTree = () => ({ x: best.x, y: best.gy, z: best.z, h: best.y1 - best.gy, r: best.rad });
  return {
    trees: trees.length, casting, total, dist: +best.d.toFixed(1), near: +best.near.toFixed(1),
    h: +(best.y1 - best.gy).toFixed(1), rad: +best.rad.toFixed(1), dev: +best.dev.toFixed(2),
  };
}, 20);
if (tree.reason) {
  skip('a tree lays a shadow across the ground', `${tree.reason} (${tree.total ?? 0} instances)`);
} else {
  // The group's own switch, read off the meshes that were built rather than off the table that was
  // supposed to produce them.
  check('every resident tree instance is a shadow caster',
    tree.casting === tree.total && tree.total > 0,
    `${tree.casting}/${tree.total} instances across ${tree.trees} trees`);
  const at = await p.evaluate(() => window.__shTree());
  const geo = await p.evaluate((h, a) => window.__shAim(h, a), 16, at);
  const a = await shoot('tree-there');
  await p.evaluate(() => window.__shTrees(true));
  const c = await shoot('tree-gone');
  await p.evaluate(() => window.__shTrees(false));
  const pr = profile(geo, a.img, c.img);
  console.log(`\n  a ${tree.h} m tree ${tree.dist} m away, crown r ${tree.rad} m, nearest neighbour`
    + ` ${tree.near} m, ${tree.dev} m of relief around it — shadow ${geo.L} m at ${geo.elev}°,`
    + ` ${geo.pxAway} px/m along the axis`);
  printProfile(pr);
  check('both captures settled, so the pair differs only by the trees',
    a.settled && c.settled, `${a.tries} + ${c.tries} captures`);
  if (!pr.best || !pr.worst || pr.anti.length < 5 || pr.sun.length < 5) {
    skip('a tree lays a shadow across the ground',
      `only ${pr.anti.length} shadow-side and ${pr.sun.length} sun-side samples cleared the crown`);
  } else {
    console.log(`    darkest ${(100 * pr.best.drop).toFixed(1)}% at ${pr.best.m} m`
      + ` (lum ${pr.best.lit} → ${pr.best.shad}), sun side worst ${(100 * pr.worst.drop).toFixed(1)}%`
      + ` at ${pr.worst.m} m`);
    // A 9 m crown at 24° over open grass is the easy case — measured 46.8% and 51.7% on two runs —
    // so the bar is the same half-of-weakest as the avatar's. If this fails while the avatar passes,
    // a scatter group stopped casting; if both fail, the rig did.
    check('a tree lays a shadow across the ground', pr.best.drop >= MIN_DROP,
      `${(100 * pr.best.drop).toFixed(1)}% darker at ${pr.best.m} m, want ${(100 * MIN_DROP).toFixed(0)}%`);
    // Looser than the avatar's control: the caster removed here is every tree in the zone, so a
    // distant canopy's own shadow can graze the up-sun half of the sweep. It still has to be a
    // small fraction of the drop.
    check('...and the ground toward the sun stays lit',
      Math.abs(pr.worst.drop) <= 0.06 && Math.abs(pr.worst.drop) < pr.best.drop * 0.4,
      `${(100 * pr.worst.drop).toFixed(1)}% against a ${(100 * pr.best.drop).toFixed(1)}% drop`);
  }
}

check('no page errors or reloads through any of it', errs.length === 0, errs.slice(0, 3).join(' | '));

console.log(`\nshadow-check: ${passes} passed, ${fails} failed, ${skips} skipped`);
console.log(`shots -> ${OUT}`);
await b.close();
process.exit(fails);
