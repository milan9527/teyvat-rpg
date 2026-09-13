// Free-camera close-ups of one scattered prop, for judging模型 and材质 rather than framerate.
//
//   DISPLAY=:99 node tools/prop-cam.mjs oak [zone] [outDir]
//
// Why it does not just move the gameplay camera, which is what three earlier attempts
// did: the third-person boom collides with whatever is behind the player and collapses to
// its 1.9 m minimum, the character stands between the lens and the subject at every yaw,
// and the rig lerps `fov` back to `fovBase` every frame, so a telephoto write is gone
// before the screenshot lands. Stopping the loop is what makes the camera stay put —
// nothing else in the frame needs it, because streaming has already run and one
// `renderer.render` draws the resident scene fine.
//
// Also worth remembering: the rig's view direction is (-sin yaw, ·, -cos yaw), so yaw = PI
// looks along +Z. Aiming *back* at a subject the player is north-east of is yaw = +PI/4.
//
// And the failure this tool printed for months, in the same words as a missing prop:
// `prop-cam goldArcade goldenHall` answered "no 'goldArcade' instances in goldenHall" while
// the arcade was on screen in 黄金屋 — because /tmp/world-token.txt is usually a fresh AR 1
// guest, 黄金屋 needs AR 18, `enterZone` refused, and the tool then photographed 蒙德平原
// under the other zone's name. So the rank is raised over the dev hook *before* the page
// loads (every gate reads a save fetched once at boot) and the zone the game actually landed
// in is checked against the one that was asked for. A tool that cannot tell "this prop is
// not built" from "you are in the wrong zone" is not evidence about the prop.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { zoneById, zoneEntryRank } from '../shared/src/data/zones.js';
import { raiseRank } from './lib/account.mjs';

const kind = process.argv[2] || 'oak';
const zone = process.argv[3] || 'mondstadt';
const outDir = process.argv[4] || '/tmp';
// Created up front rather than left to the screenshot call, which fails with a bare ENOENT
// four minutes in — after the browser has launched, streamed the zone and framed the shot.
fs.mkdirSync(outDir, { recursive: true });
const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';

// A token file is honoured if present (it keeps successive runs on one save, which is
// what makes two screenshots comparable), otherwise mint a throwaway guest.
const tokFile = '/tmp/world-token.txt';
let token = fs.existsSync(tokFile) ? fs.readFileSync(tokFile, 'utf8').trim() : '';
if (!token) {
  const r = await fetch(`${origin}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  token = (await r.json()).token;
  fs.writeFileSync(tokFile, token);
  console.log('minted a guest token ->', tokFile);
}

// Rank first, browser second: `Game.load` fetches the save once and every zone gate reads
// that copy, so raising it on a live session changes nothing.
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const needRank = zoneEntryRank(zoneById(zone));
if (needRank > 1) {
  const rr = await raiseRank(API, token, needRank);
  console.log(`rank -> AR ${rr.rank ?? '?'} (${zone} needs ${needRank})${rr.ok ? '' : ` — ${rr.reason}`}`);
}

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
  },
  defaultViewport: { width: 1000, height: 700 },
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
await new Promise((r) => setTimeout(r, 5000));
await p.click('[data-act="resume"]');
for (let i = 0; i < 90; i++) {
  if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await new Promise((r) => setTimeout(r, 4000));

// Pin the top tier before anything is streamed. Since engine/perf.js started guessing a
// tier from the renderer string, every probe on this box boots at `low` — llvmpipe matches
// the software-rasteriser pattern — which is right for a framerate probe and wrong for this
// one: at low there are no shadows, no bloom and DPR 1.0, so a model would be judged on a
// frame the target hardware never shows. Auto off first, or the governor drops it back
// within three seconds of the first bad bucket.
await p.evaluate(() => {
  window.game.setAutoQuality(false);
  window.game.setQuality('high');
  // And pin noon. The world clock moves the sun a degree every four real seconds, so two shots a
  // minute apart are lit differently; 12:00 is the authored sky every threshold was measured on.
  window.game.setWorldTime(12);
});
await new Promise((r) => setTimeout(r, 3000));
console.log('quality pinned ->', await p.evaluate(() => window.game.quality));

const found = await p.evaluate(async ([kind, zone]) => {
  const g = window.game;
  await g.enterZone(zone, { x: 0, z: 14 });
  await new Promise((r) => setTimeout(r, 6000));
  // Recorded, not asserted here: the caller compares it, so a refused transition reports
  // itself instead of arriving as "this prop does not exist".
  window.__landed = g.zoneId;
  // Nearest pooled instance of the kind. The pool keys batches `<kind>:<variant>`, and
  // the instance matrix' translation is the prop's base in world space.
  const Mat4 = g.world.group.matrix.constructor;
  const m = new Mat4();
  let best = null, bd = 1e9;
  // Size, too, not just position. Framing every prop at a fixed 7 m aim height and a
  // fixed 11 m stand-off is what put the camera *inside* a three-metre boulder and aimed
  // it at the sky above it; the same numbers are a distant wide shot of an oak. So take
  // the union of the bounding boxes of every batch of this kind — one prop is spread
  // across several batches, one per (prototype, material) — and frame off that.
  const parts = [];
  // Three sources (the third is below), because a zone holds its props in three different
  // places and asking for
  // `abyssPillar` or an enclosure segment used to print "no instances" from a tool whose
  // whole job is to photograph them: the streaming pool owns scatter (`{name, mesh, used}`
  // batches), while `world.landmarks` owns the fixed-count dressing — ruins, lanterns,
  // the arena enclosure — as `buildPropField` results whose InstancedMeshes are named
  // `<kind>:v<variant>` and carry their own `count`.
  const batches = [...g.world.propPool.batches.values()];
  for (const lm of g.world.landmarks || []) {
    for (const im of lm.meshes || []) {
      if (im.isInstancedMesh) batches.push({ name: im.name, mesh: im, used: im.count });
    }
  }
  for (const bt of batches) {
    if (!bt.name.startsWith(kind + ':')) continue;
    const geo = bt.mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    for (let i = 0; i < bt.used; i++) {
      bt.mesh.getMatrixAt(i, m);
      const e = m.elements;
      parts.push([e[12], e[13], e[14], geo.boundingBox.clone().applyMatrix4(m)]);
      const d = e[12] ** 2 + (e[14] - 14) ** 2;
      if (d < bd) { bd = d; best = [e[12], e[13], e[14]]; }
    }
  }
  // Third source: the one-off props. Everything a POI plants — chest, statue, waypoint,
  // brazier, dungeon gate, and every monument of a puzzle ring — is a `buildProp()` result,
  // i.e. a plain `THREE.Group` named `prop:<kind>` with ordinary Meshes inside, so it is in
  // neither the streaming pool nor `world.landmarks`. Asking for one printed
  // "no 'monument' instances" from the tool whose whole job is to photograph props: half the
  // interactive objects in the game were unphotographable. These are built at zone load
  // rather than streamed, so the whole zone's worth is present from the first `enterZone`.
  if (!best) {
    g.world.group.traverse((o) => {
      if (o.name !== `prop:${kind}`) return;
      o.updateWorldMatrix(true, true);
      const pos = o.getWorldPosition(new o.position.constructor());
      let box = null;
      o.traverse((c) => {
        if (!c.isMesh || c.userData.noOutline) return;
        if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
        const bb = c.geometry.boundingBox.clone().applyMatrix4(c.matrixWorld);
        box = box ? box.union(bb) : bb;
      });
      if (!box) return;
      parts.push([pos.x, pos.y, pos.z, box]);
      const d = pos.x ** 2 + (pos.z - 14) ** 2;
      if (d < bd) { bd = d; best = [pos.x, pos.y, pos.z]; }
    });
  }
  if (!best) return null;
  // Union the world-space boxes of every piece of this one prop. A prop is split across
  // one batch per merged piece (`<kind>:v<variant>`, keyed on prototype and material) and
  // the piece geometry carries the part offsets in prop-local space, so a single batch's
  // box is a trunk or a canopy but never the tree. Every piece of one prop shares that
  // prop's instance matrix exactly, so matching the translation identifies them without
  // any radius guess that could reach the next prop over.
  let hi = 0, rad = 0.4;
  for (const [px, py, pz, bb] of parts) {
    if (Math.abs(px - best[0]) > 0.02 || Math.abs(py - best[1]) > 0.02
      || Math.abs(pz - best[2]) > 0.02) continue;
    hi = Math.max(hi, bb.max.y - best[1]);
    rad = Math.max(rad, bb.max.x - best[0], bb.max.z - best[2],
      best[0] - bb.min.x, best[2] - bb.min.z);
  }
  window.__size = [Math.max(hi, 0.6), rad];
  // Stand next to it so the streaming cells around the subject stay resident once the
  // loop stops; the avatar itself gets hidden below.
  await g.enterZone(zone, { x: best[0] + 6, z: best[2] + 6 });
  await new Promise((r) => setTimeout(r, 6000));
  window.__subject = best;
  return best.map((v) => +v.toFixed(1));
}, [kind, zone]);

// Before the "no instances" branch, because it explains that branch away: a zone the
// account may not enter leaves the game where it was, and every prop of the asked-for zone
// is then legitimately absent.
const landed = await p.evaluate(() => window.__landed);
if (landed !== zone) {
  console.log(`ABORTED: asked for ${zone}, the game is in ${landed} — the transition did not take`);
  console.log(`  ${zone} needs AR ${needRank}; raise it with POST /api/dev/rank (dev only) or check enterZone`);
  await b.close();
  process.exit(1);
}
if (!found) {
  console.log(`no '${kind}' instances in ${zone}`);
  await b.close();
  process.exit(1);
}
console.log('subject', JSON.stringify(found));
const size = await p.evaluate(() => window.__size.map((v) => +v.toFixed(2)));
console.log('size [height, radius]', JSON.stringify(size));

const hidden = await p.evaluate(() => {
  const g = window.game;
  g.stop();
  const a = g.me?.actor;
  const root = [a?.root, a?.group, a?.mesh, a?.obj].find((o) => o && o.isObject3D);
  if (root) root.visible = false;
  return !!root;
});
console.log('avatar hidden ->', hidden);

// [aim height as a fraction of the prop's height, stand-off in prop radii, fov]. Four
// angles, because a single one cannot tell a silhouette problem from a shading one: a
// full-figure shot, a tight one, a long lens from further out, and one aimed at the top.
// Everything is in units of the measured prop, so the same four numbers frame a 3 m
// boulder and a 9 m oak.
const SHOTS = [[0.55, 4.2, 40], [0.50, 2.6, 34], [0.45, 7.0, 22], [0.85, 3.4, 40]];
for (let k = 0; k < SHOTS.length; k++) {
  await p.evaluate(([shot, k]) => {
    const [hf, mul, fov] = shot;
    const [sx, sy, sz] = window.__subject;
    const [ph, pr] = window.__size;
    const cam = window.game.camera;
    const aimY = sy + ph * hf;
    // Stand off by the prop's own size, floored so a knee-high bush is still reachable
    // and the near plane does not clip it.
    const dist = Math.max(2.5, Math.max(pr, ph * 0.45) * mul);
    const a = 0.9 + k * 1.35;                  // orbit, so the four frames differ
    cam.fov = fov;
    cam.position.set(sx + Math.cos(a) * dist, aimY + dist * 0.16, sz + Math.sin(a) * dist);
    cam.lookAt(sx, aimY, sz);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    // Three passes: the composer's FXAA and bloom read the previous frame's targets.
    for (let i = 0; i < 3; i++) window.game.r.render(0.016);
  }, [SHOTS[k], k]);
  await new Promise((r) => setTimeout(r, 1200));
  await p.screenshot({ path: `${outDir}/${kind}-cam-${k}.png` });
}
console.log('errors ->', errs.length ? JSON.stringify([...new Set(errs)].slice(0, 6), null, 1) : 'none');
await b.close();
process.exit(errs.length ? 1 : 0);
