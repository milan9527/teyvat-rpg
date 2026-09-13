// Which way is the toon shader's sun pointing?
//
//   DISPLAY=:99 node tools/light-space.mjs [zone] [--out /tmp/lightspace]
//
// three.js hands a directional light's direction to the shader in *view* space:
// WebGLLights.js ends the directional block with `uniforms.direction.transformDirection(
// viewMatrix)`. `client/src/gfx/toon.js` dots that direction against `vToonNormal`, which
// the vertex stage builds as `mat3(modelMatrix) * objectNormal` — a *world* normal. Mixing
// the two spaces means the cel ramp is anchored to the camera rather than to the sun: the
// lit side of everything toon-shaded would swing around as the player orbits, and it would
// do it smoothly enough that no still screenshot could ever show it.
//
// A still cannot, but two stills can, and this probe is the argument in its cheapest form.
// It drops a *sphere* into the resident scene, wearing a material borrowed from a prop
// already in the zone (so the material under test is the real one, with the real uniforms),
// and photographs it from four azimuths with the free camera, measuring the luma of the
// sphere's left half against its right half:
//
//   world-space (correct): the bright limb stays on the sun's side of the world, so the
//     sign of (left - right) flips between azimuth a and a+180 deg;
//   view-space (the bug):  the bright limb is glued to one side of the *screen*, so the
//     sign is the same at all four azimuths.
//
// A sphere and not a prop on purpose: any real prop is asymmetric, so left-minus-right on
// one would measure its geometry as much as its lighting, and the four numbers would be
// unreadable. A sphere has no preferred side, which makes the sign of the asymmetry purely
// a statement about the light.
//
// Habits from the other probes here: pin the tier (llvmpipe boots every browser at `low`),
// decode the PNGs in-process (a second page steals focus and Firefox throttles rAF to a
// stale frame), stop the game loop before framing so the third-person rig cannot lerp the
// camera back, and keep a control that must move.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { decodePng, rectStats, pixelsDiffering } from './lib/png.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/lightspace'; })();
const zone = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out') || 'mondstadt';
const W = 900, H = 700;
fs.mkdirSync(outDir, { recursive: true });
const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}

// The sphere is drawn dead centre of a 900x700 frame at a fixed stand-off, so its two
// halves are known rectangles rather than something to search for. Kept well inside the
// silhouette (the limb is where the normal turns edge-on and the rim term lives) and off
// the vertical centre line, so neither rect can straddle the terminator by accident.
const RAD = 150;
const LEFT = { x: W / 2 - RAD, y: H / 2 - 70, w: 110, h: 140, label: 'L' };
const RIGHT = { x: W / 2 + RAD - 110, y: H / 2 - 70, w: 110, h: 140, label: 'R' };

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
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
p.on('console', (m) => {
  if (m.type() !== 'error') return;
  errs.push(m.text().slice(0, 200));
  console.log('[err]', m.text().slice(0, 250));
});

await p.goto(origin, { waitUntil: 'domcontentloaded' });
await p.evaluate((t) => localStorage.setItem('teyvat.token', t), token);
await p.reload({ waitUntil: 'domcontentloaded' });
await sleep(5000);
await p.click('[data-act="resume"]');
let up = false;
for (let i = 0; i < 90; i++) {
  if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) { up = true; break; }
  await sleep(1000);
}
if (!up) { console.log('window.game never started running — check ./tools/daemon.sh status'); await b.close(); process.exit(1); }
await sleep(4000);
await p.evaluate(() => {
  window.game.setAutoQuality(false);
  window.game.setQuality('high');
  // Noon, pinned: the world clock moves the sun 15° a real minute, and every threshold in this
  // file was calibrated on the authored sky, which is exactly what daylight() returns at 12:00.
  window.game.setWorldTime(12);
});
await sleep(3000);
const tier = await p.evaluate(() => window.game.quality);
console.log('quality pinned ->', tier);
if (tier !== 'high') { console.log('tier did not pin'); await b.close(); process.exit(1); }

const setup = await p.evaluate(async (z) => {
  const g = window.game;
  await g.enterZone(z, { x: 0, z: 0 });
  await new Promise((r) => setTimeout(r, 6000));

  // Borrow a real toon material out of the resident scene rather than building one: the
  // probe has no module scope, and more importantly a material made here would not carry
  // the zone's own uniforms, so it would answer a question about a material that is not in
  // the game. Skip vertexColors materials — the sphere below has no colour attribute and
  // would come out black — and skip the outline hulls.
  let mat = null, host = null;
  g.world.group.traverse((o) => {
    if (mat || !o.isMesh || o.userData.noOutline) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    // The toon marker is `userData.toon` (toonMaterial is a MeshStandardMaterial with an
    // onBeforeCompile, not a ShaderMaterial, so there is no `.uniforms` to look at).
    if (!m || !m.userData?.toon) return;
    if (m.vertexColors) return;                 // the sphere below carries no colour attribute
    if (m.userData.toon.uFillStrength.value > 0) return;   // that is a vault; test the default path
    mat = m; host = o.name || o.type;
  });
  if (!mat) return { err: 'no toon material found in the resident scene' };

  // A UV sphere, built by hand. THREE is not reachable from here (bare specifiers do not
  // resolve in the page), so the geometry class comes off an existing geometry and the
  // attribute class off one of its attributes — the same trick prop-cam.mjs uses to get a
  // Matrix4 and a Vector3.
  const proto = g.world.group.children.find((c) => c.isMesh || c.isInstancedMesh)
    || [...g.world.propPool.batches.values()][0]?.mesh;
  const Geo = proto.geometry.constructor;
  const Attr = proto.geometry.getAttribute('position').constructor;
  const Mesh = proto.constructor.name === 'InstancedMesh'
    ? Object.getPrototypeOf(proto.constructor) : proto.constructor;
  const R = 3.0, SEG = 48, RING = 32;
  const pos = [], nrm = [], idx = [];
  for (let j = 0; j <= RING; j++) {
    const v = j / RING, phi = v * Math.PI;
    for (let i = 0; i <= SEG; i++) {
      const u = i / SEG, th = u * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(th), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(th);
      nrm.push(nx, ny, nz);
      pos.push(nx * R, ny * R, nz * R);
    }
  }
  for (let j = 0; j < RING; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = j * (SEG + 1) + i, c = a + SEG + 1;
      idx.push(a, c, a + 1, c, c + 1, a + 1);
    }
  }
  const geo = new Geo();
  geo.setAttribute('position', new Attr(new Float32Array(pos), 3));
  geo.setAttribute('normal', new Attr(new Float32Array(nrm), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const probe = new Mesh(geo, mat);
  probe.name = 'lightspace-probe';
  probe.frustumCulled = false;
  probe.castShadow = false;
  probe.receiveShadow = false;
  // Above the ground and above the player, so nothing in the zone can occlude it and no
  // cast shadow can land on it. Elevation is what the four camera positions orbit.
  const y = g.me.y + 9;
  probe.position.set(0, y, 0);
  g.scene.add(probe);
  window.__probe = probe;

  const a = g.me?.actor;
  const root = [a?.root, a?.group, a?.mesh, a?.obj].find((o) => o && o.isObject3D);
  if (root) root.visible = false;
  g.stop();

  const sd = g.world.sky.uniforms.uSunDir.value;
  return {
    host, y: +y.toFixed(1), avatarHidden: !!root,
    // World sun azimuth: the direction light *comes from*, in the same xz convention the
    // camera azimuth below uses. This is the answer the pixels are checked against.
    sunAz: +Math.atan2(sd.z, sd.x).toFixed(3), sunY: +sd.y.toFixed(2),
    fillOn: !!g.world.sky.fill,
  };
}, zone);

console.log(' ', JSON.stringify(setup));
if (setup.err) { console.log(setup.err); await b.close(); process.exit(1); }
check('a toon material was borrowed from the live scene', !!setup.host, setup.host);
check('the avatar is hidden', setup.avatarHidden);

// Four azimuths, 90 deg apart, all level with the sphere's centre so the top/bottom of the
// sphere is not what fills the rects.
const AZ = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const shots = [];
for (let k = 0; k < AZ.length; k++) {
  const info = await p.evaluate(([az, k]) => {
    const g = window.game;
    const cam = g.camera;
    const c = window.__probe.position;
    const dist = 13;
    cam.fov = 45;
    cam.position.set(c.x + Math.cos(az) * dist, c.y, c.z + Math.sin(az) * dist);
    cam.lookAt(c.x, c.y, c.z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    // The sky dome and the shadow frustum follow the camera in `Sky.update`, which the
    // stopped loop no longer calls — so drive it by hand, or all four frames keep the sky
    // and the fill light that belonged to the camera's position at the moment of `stop()`.
    g.world.sky.update(0.016, cam, c.x, c.y, c.z);
    for (let i = 0; i < 3; i++) g.r.render(0.016);
    // Which side of the *screen* the world sun is on, from the camera's own basis: +1 means
    // the sun is off to the right of frame. A world-space shader must brighten that side.
    const sd = g.world.sky.uniforms.uSunDir.value;
    const right = { x: Math.cos(az + Math.PI / 2), z: Math.sin(az + Math.PI / 2) };
    // camera looks from +az back at the origin, so its right vector is -(az+90) in xz
    const dotRight = -(sd.x * right.x + sd.z * right.z);
    return { az: +az.toFixed(2), sunScreenSide: dotRight > 0 ? 1 : -1, dotRight: +dotRight.toFixed(3) };
  }, [AZ[k], k]);
  await sleep(1200);
  const file = `${outDir}/${zone}-az${k}.png`;
  await p.screenshot({ path: file });
  const img = decodePng(fs.readFileSync(file));
  const L = rectStats(img, LEFT), R = rectStats(img, RIGHT);
  shots.push({ ...info, img, L: L.lum, R: R.lum, d: +(L.lum - R.lum).toFixed(1), std: L.std });
  console.log(`  az ${(info.az).toFixed(2).padStart(5)}  L ${String(L.lum).padStart(5)}`
    + `  R ${String(R.lum).padStart(5)}  L-R ${String(+(L.lum - R.lum).toFixed(1)).padStart(6)}`
    + `   sun is screen-${info.sunScreenSide > 0 ? 'right' : 'left '} (dot ${info.dotRight})`);
}

// Control: four different camera positions must be four different frames.
let moved = 1e9;
for (let i = 1; i < shots.length; i++) moved = Math.min(moved, pixelsDiffering(shots[0].img, shots[i].img, 2));
check('the camera actually moved between frames', moved > 5000, `min ${moved} px differ`);
// And the sphere has to be in frame: a fogged empty sky would give L ≈ R at every azimuth
// and the sign test would pass on noise.
check('the probe sphere is in frame', shots.every((s) => s.std > 2 && s.L > 3),
  `left-rect std ${shots.map((s) => s.std).join(', ')}`);

// The measurement. A sphere lit from world space is brighter on whichever side of the
// screen the sun is on, at every azimuth; a sphere lit from view space is brighter on the
// same side every time, and disagrees with the sun at half of them.
// L-R > 0 means the left rect is brighter, i.e. the light is on screen-left, i.e.
// sunScreenSide is -1: the two must be opposite in sign. The 1.5-count dead band is there
// because at an azimuth where the sun is nearly straight ahead or straight behind, the
// screen-side of the light is genuinely undefined and the frame cannot vote.
const ok = shots.filter((s) => Math.abs(s.d) > 1.5 && Math.sign(s.d) === -s.sunScreenSide);
const flat = shots.filter((s) => Math.abs(s.d) <= 1.5);
// The second half of the argument, and the one that actually catches the view-space bug.
// "Is the sign constant across all four?" does not: dotting a world normal against a
// view-space direction rotates the apparent light by the camera's own rotation *on top of*
// the camera's rotation, so the measured side goes as sunAz - 2*az and has a period of 180
// degrees — it does flip, just twice as fast, and it agreed with the sun at 2 of 4 azimuths
// while completely broken. What no wrong answer can fake is opposite azimuths disagreeing:
// turn the camera to the far side of an object and the sun has to come from the other side
// of the screen. Measured +11 / +10.9 at az 0 and 180 before the fix.
const flip02 = Math.sign(shots[0].d) !== Math.sign(shots[2].d);
const flip13 = Math.sign(shots[1].d) !== Math.sign(shots[3].d);
console.log(`\n  ${ok.length}/4 azimuths put the bright side where the world sun is;`
  + ` ${flat.length} too flat to tell; opposite azimuths flip: ${flip02} / ${flip13}`);
check('the lit side follows the world sun, not the camera', ok.length >= 3,
  `${ok.length}/4 agree, ${flat.length} flat`);
check('opposite azimuths see the light from opposite sides of the screen', flip02 && flip13,
  `az 0/180 -> ${shots[0].d}/${shots[2].d}, az 90/270 -> ${shots[1].d}/${shots[3].d}`);

console.log('\nerrors ->', errs.length ? JSON.stringify([...new Set(errs)].slice(0, 6)) : 'none');
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
if (pass + fail < 6) { console.log(`only ${pass + fail} assertions ran — expected 6`); process.exit(1); }
process.exit(fail ? 1 : 0);
