// Diagnostic: boots the game and reports camera/player transforms plus the world
// bounding boxes of everything near the player, then screenshots from a far
// camera so the whole spawn area is visible at once.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const out = process.argv[3] || '/tmp/probe';
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: { 'webgl.force-enabled': true, 'webgl.disable-fail-if-major-performance-caveat': true },
  defaultViewport: { width: 1280, height: 720 },
});
const p = await b.newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(2000);
await p.click('[data-act="guest"]');
for (let i = 0; i < 60; i++) {
  if (await p.evaluate(() => !!window.game?._running).catch(() => false)) break;
  await sleep(1000);
}
await sleep(3000);

console.log(JSON.stringify(await p.evaluate(() => {
  const g = window.game;
  const c = g.camera;
  return {
    me: { x: +g.me.x.toFixed(2), y: +g.me.y.toFixed(2), z: +g.me.z.toFixed(2), h: g.me.height },
    cam: { x: +c.position.x.toFixed(2), y: +c.position.y.toFixed(2), z: +c.position.z.toFixed(2), near: c.near, far: c.far, fov: c.fov },
    rig: { dist: g.rig?.dist, yaw: g.rig?.yaw, pitch: g.rig?.pitch, target: g.rig?.target },
    zone: g.world.zone.id,
    sceneChildren: g.scene.children.map((o) => o.name || o.type),
  };
}), null, 1));

// Every mesh whose world box is within 30 m of the player, biggest first.
const nearby = await p.evaluate(() => {
  const g = window.game;
  const res = [];
  const me = { x: g.me.x, y: g.me.y, z: g.me.z };
  // Transform a point by matrixWorld by hand: no THREE reference is exposed on
  // window, and the element order is stable (column-major).
  const xf = (e, x, y, z) => [
    e[0] * x + e[4] * y + e[8] * z + e[12],
    e[1] * x + e[5] * y + e[9] * z + e[13],
    e[2] * x + e[6] * y + e[10] * z + e[14],
  ];
  const colLen = (e, i) => Math.hypot(e[i * 4], e[i * 4 + 1], e[i * 4 + 2]);
  g.scene.updateMatrixWorld(true);
  g.scene.traverse((o) => {
    if (!o.geometry || !o.visible) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    if (!bb || !Number.isFinite(bb.min.x)) return;
    const e = o.matrixWorld.elements;
    const c = xf(e, (bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2);
    const d = Math.hypot(c[0] - me.x, c[2] - me.z);
    if (d > 40) return;
    const size = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
    const ws = [colLen(e, 0), colLen(e, 1), colLen(e, 2)];
    res.push({
      name: o.name || o.type, parent: o.parent?.name || o.parent?.type,
      d: +d.toFixed(1),
      worldSize: size.map((n, i) => +(n * ws[i]).toFixed(2)),
      at: c.map((n) => +n.toFixed(1)),
      instances: o.isInstancedMesh ? o.count : undefined,
    });
  });
  res.sort((a, b) => Math.max(...b.worldSize) - Math.max(...a.worldSize));
  return res.slice(0, 25);
});
console.log('\nNEARBY (biggest first)');
for (const n of nearby) console.log(`  ${String(n.name).padEnd(22)} d=${String(n.d).padStart(5)} world=${n.worldSize.join('x')} at=${n.at.join(',')} parent=${n.parent}${n.instances ? ' x' + n.instances : ''}`);

// Fly the camera up for an establishing shot.
await p.evaluate(() => {
  const g = window.game;
  g._probeCam = true;
  const c = g.camera;
  const step = () => {
    c.position.set(g.me.x + 60, g.me.y + 45, g.me.z + 60);
    c.lookAt(g.me.x, g.me.y + 1, g.me.z);
  };
  g.on('frame', step);
});
await sleep(2500);
await p.screenshot({ path: `${out}/aerial.png` });
console.log('saved', `${out}/aerial.png`);
await b.close();
