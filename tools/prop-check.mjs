// Every prop, character-height and wall the six zones actually build, measured on screen.
//
//   DISPLAY=:99 node tools/prop-check.mjs [zone ...] [--out /tmp/propcheck]
//
// The hole this fills. After `tour` (ground) and `vault-cam` (ceiling) joined check-all, the
// suite had quantified pixel assertions about the floor of a frame and the lid of a frame and
// nothing at all about the things standing between them: 31 prop kinds, three enclosure wall
// families and every one-off POI model. `tools/prop-cam.mjs` photographs one kind beautifully
// — free camera, size-relative framing, rank raised before boot — and asserts *nothing*, so a
// prop that stopped being drawn, or came back as a flat silhouette, was caught only by whoever
// happened to open the PNG. `tools/mat-probe.mjs` and `tools/scene-probe.mjs` are the same
// shape. Sixteen of this repo's probes exist because a number moved; these three print numbers
// and let them move.
//
// What it measures, and why not a rectangle. Every rect in the other probes is a guess about
// where a thing will land, and the guesses drift: npc-cam once graded a villager on a rect that
// had slid onto the water she stands in. So the subject is identified by *hiding* it — the same
// argument vault-cam makes about a ceiling, applied per prop. One frame with the prop, one with
// its instance matrices zeroed, and the pixels that moved are the prop's own silhouette,
// whatever size the framing gave it. That mask then answers four questions:
//
//   1. was it drawn at all, at the size its own bounding box promised? (a mask of nothing is
//      the fingerprint of a prop culled, zero-scaled, or buried inside another mesh — the
//      monument whose orb was inside its capstone shipped that way);
//   2. can you see it against what is behind it? The backdrop is read from the *same* mask in
//      the hidden frame, i.e. exactly the pixels the prop was covering, so the comparison is
//      albedo and geometry with the lighting divided out — no neighbouring control rect to
//      drift, no "the tint did not move it" that is equally true of grass;
//   3. does it have form, or is it a flat pencil? (std and p5..p95 over the silhouette, the
//      same ruler tools/pixstd.mjs argues for);
//   4. is it inside the gamut the tonemap can show — neither crushed to black nor blown out,
//      and not clipping a channel to zero the way saturated foliage did.
//
// Coverage is the fifth assertion and the one that keeps the file honest: the kinds it measured
// are compared against `SCATTER_KINDS + SINGLE_KINDS` from client/src/gfx/props.js, and any kind
// it could not reach has to be named in `OFF_CAMERA` below *with a reason* — and named there
// wrongly is also a failure, so the list cannot rot into a blanket exemption.
//
// Habits inherited, each of which cost a run once: raise the rank before the page loads (黄金屋
// needs AR 18, and a refused `enterZone` photographs 蒙德 under the wrong zone's name), pin the
// tier (llvmpipe boots every browser at `low`, where there is no bloom and no shadow), decode
// the PNGs in-process (a second page steals focus and Firefox throttles rAF to a stale frame),
// and stop the game loop before framing (the third-person rig lerps `fov` back every frame).
// Staleness needs no separate control here: a frozen frame makes every mask empty, which is
// assertion 1.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { ZONES, zoneById, zoneEntryRank } from '../shared/src/data/zones.js';
import { SCATTER_KINDS, SINGLE_KINDS } from '../client/src/gfx/props.js';
import { decodePng, diffMask, maskStats, maskInRect } from './lib/png.mjs';
import { raiseRank } from './lib/account.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/propcheck'; })();
const asked = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
const zones = asked.length ? asked : Object.keys(ZONES);
const partial = asked.length > 0;      // a subset run cannot speak about coverage
const W = 1000, H = 700;
fs.mkdirSync(outDir, { recursive: true });
const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Thresholds, calibrated on the run recorded at the bottom of README's 「像素门禁」 section and
 * bounded on both sides wherever a bound means anything — a one-sided gate has been green on
 * broken content in this repo twice (a 3★ chamber that was free, a fog brighter than its vault).
 */
const MIN_MASK = 600;       // px of 700 000: below this nothing was drawn where a prop stands
const MAX_FRAC = 0.92;      // a mask that is the whole screen is not a prop, it is a global change
// Two ratios against the subject's *own* projected bounding box, which is the only honest
// expectation for size: a grass tuft is thin blades and fills 3% of its box, a boulder fills
// 70%, and a single absolute pixel floor cannot tell the thin one from a missing one. So
// `inside/mask` says the change happened where the box promised (bloom haloes and lost shadows
// land outside it, which is why this is not 1.0) and `inside/box` says something actually fills
// the promise. Calibrated on the run below: thinnest real subject is qingxin at 0.03 of its box.
const MIN_ON_TARGET = 0.35;
const MIN_OF_BOX = 0.015;
const MIN_BACKDROP = 8;     // sRGB counts, largest-moving channel, prop vs what it covers
// Luma std over the silhouette: whether the model has internal form at all. Calibrated from both
// ends of a real defect. The three dungeon enclosures measured 3.9 / 10.2 / 14.3 while their
// mid-storey was bare (and 3.9 is what a 271 000 px wall with three counts of range looks like),
// against 19.4 for the flattest *good* subject in the full sweep — dragonspine/ancientArch — and a
// median near 37. 12 sits between the two with room on both sides. No upper bound: the top of the
// distribution is frostCavern/iceCurtain at 64.8, which is white ice against near-black rock, and
// there is no defect on that side to gate.
const MIN_STD = 12;
const MIN_CHAN = 10;        // crushed to black under this
const MAX_CHAN = 250;       // blown out over this
const MAX_CLIP = 0.5;       // fraction of the silhouette with red or green pinned at 0

/**
 * Kinds no zone keeps within streaming range of a spawn point, with the reason each one is out
 * of reach. Both directions are asserted: a name missing from here fails the coverage check, and
 * a name here that *did* get measured fails too, so the list has to shrink when the world grows.
 */
const OFF_CAMERA = {
  // Empty, and it should stay that way: the full sweep reaches all 31 kinds (34 with the chest
  // variants) from the six spawn points. An entry here is a confession that some content is
  // unmeasurable, so it needs a reason — "no zone builds it within streaming range of a spawn",
  // not "it kept failing".
};

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); } else {
    fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
};
const skipped = (name, why) => { skip++; console.log(`  SKIP ${name} — ${why}`); };

/* --------------------------------------------------------------------- boot -- */

const tokFile = '/tmp/world-token.txt';
let token = fs.existsSync(tokFile) ? fs.readFileSync(tokFile, 'utf8').trim() : '';
if (!token) {
  const r = await fetch(`${API}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  token = (await r.json()).token;
  fs.writeFileSync(tokFile, token);
  console.log('minted a guest token ->', tokFile);
}
// Rank first, browser second: `Game.load` fetches the save once and every zone gate reads that
// copy, so raising it on a live session changes nothing and 黄金屋 is silently refused.
const needRank = Math.max(...zones.map((z) => zoneEntryRank(zoneById(z))));
if (needRank > 1) {
  const rr = await raiseRank(API, token, needRank);
  console.log(`rank -> AR ${rr.rank ?? '?'} (need ${needRank})${rr.ok ? '' : ` — ${rr.reason}`}`);
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
const hmr = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
p.on('console', (m) => {
  const t = m.text().slice(0, 250);
  if (/\[vite\].*(hot updated|hmr update|page reload)/i.test(t)) { hmr.push(t); console.log('[HMR]', t); }
  if (m.type() === 'error') { errs.push(t.slice(0, 200)); console.log('[err]', t); }
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
if (!up) {
  console.log('window.game never started running — check ./tools/daemon.sh status');
  await b.close();
  process.exit(1);
}
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
if (tier !== 'high') {
  console.log('tier did not pin; every shot would be at low');
  await b.close();
  process.exit(1);
}

/* ----------------------------------------------------------- page-side helpers -- */

// Installed once. Nothing here captures `world`, because a zone change replaces it — only the
// Matrix4 constructor, which is stable and cheaper than re-importing three.js into the page.
await p.evaluate(() => {
  const Mat4 = window.game.world.group.matrix.constructor;
  const ZERO = new Mat4().makeScale(0, 0, 0);

  // A zone holds its props in three places and a tool that knows about one of them reports the
  // other two as "does not exist": the streaming pool owns scatter, `world.landmarks` owns the
  // fixed-count dressing (ruins, braziers, lanterns, the arena enclosure) as InstancedMeshes
  // named `<kind>:v<variant>`, and every POI one-off (chest, statue, waypoint, dungeon gate,
  // puzzle monument) is a plain Group named `prop:<kind>`.
  const batchesOf = () => {
    const g = window.game;
    const out = [];
    for (const bt of g.world.propPool?.batches?.values?.() || []) {
      if (bt.mesh?.isInstancedMesh && bt.used > 0) out.push({ name: bt.name, mesh: bt.mesh, used: bt.used });
    }
    for (const lm of g.world.landmarks || []) {
      for (const im of lm.meshes || []) {
        if (im.isInstancedMesh && im.name && im.count > 0) out.push({ name: im.name, mesh: im, used: im.count });
      }
    }
    return out;
  };

  window.__pcKinds = () => {
    const set = new Set();
    for (const bt of batchesOf()) set.add(bt.name.split(':')[0]);
    window.game.world.group.traverse((o) => {
      if (o.name && o.name.startsWith('prop:')) set.add(o.name.slice(5));
    });
    return [...set].filter(Boolean).sort();
  };

  // Nearest instance to (ax, az), plus the handles needed to hide exactly *that* prop: one prop
  // is spread over one batch per (prototype, material) and every piece shares the prop's
  // instance matrix exactly, so matching the translation identifies the pieces without a radius
  // guess that could reach the prop next door. Hiding the whole batch instead would take the
  // rest of the field with it and make the mask a scattering rather than a silhouette.
  window.__pcPick = (kind, ax, az) => {
    const g = window.game;
    const m = new Mat4();
    const parts = [];
    const groups = [];
    let best = null, bd = 1e9;
    for (const bt of batchesOf()) {
      if (bt.name.split(':')[0] !== kind) continue;
      const geo = bt.mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      for (let i = 0; i < bt.used; i++) {
        bt.mesh.getMatrixAt(i, m);
        const e = m.elements;
        parts.push({ x: e[12], y: e[13], z: e[14], box: geo.boundingBox.clone().applyMatrix4(m), mesh: bt.mesh, i });
        const d = (e[12] - ax) ** 2 + (e[14] - az) ** 2;
        if (d < bd) { bd = d; best = [e[12], e[13], e[14]]; }
      }
    }
    g.world.group.traverse((o) => {
      if (o.name !== `prop:${kind}`) return;
      o.updateWorldMatrix(true, true);
      const pos = o.getWorldPosition(new o.position.constructor());
      let box = null;
      o.traverse((c) => {
        if (!c.isMesh) return;
        if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
        const bb = c.geometry.boundingBox.clone().applyMatrix4(c.matrixWorld);
        box = box ? box.union(bb) : bb;
      });
      if (!box) return;
      groups.push({ x: pos.x, y: pos.y, z: pos.z, box, obj: o });
      const d = (pos.x - ax) ** 2 + (pos.z - az) ** 2;
      if (d < bd) { bd = d; best = [pos.x, pos.y, pos.z]; }
    });
    if (!best) return null;
    const near = (o) => Math.abs(o.x - best[0]) <= 0.02 && Math.abs(o.y - best[1]) <= 0.02
      && Math.abs(o.z - best[2]) <= 0.02;
    const mine = parts.filter(near);
    const myGroups = groups.filter(near);
    let hi = 0, rad = 0.3;
    for (const o of [...mine, ...myGroups]) {
      hi = Math.max(hi, o.box.max.y - best[1]);
      rad = Math.max(rad, o.box.max.x - best[0], o.box.max.z - best[2],
        best[0] - o.box.min.x, best[2] - o.box.min.z);
    }
    let box = null;
    for (const o of [...mine, ...myGroups]) box = box ? box.union(o.box) : o.box.clone();
    window.__pc = {
      pos: best,
      size: [Math.max(hi, 0.5), Math.max(rad, 0.25)],
      box,
      parts: mine,
      groups: myGroups,
      saved: mine.map((pt) => { const mm = new Mat4(); pt.mesh.getMatrixAt(pt.i, mm); return mm; }),
    };
    return {
      pos: best.map((v) => +v.toFixed(1)),
      size: window.__pc.size.map((v) => +v.toFixed(2)),
      pieces: mine.length, groups: myGroups.length, dist: +Math.sqrt(bd).toFixed(1),
    };
  };

  window.__pcHide = (on) => {
    const S = window.__pc;
    if (!S) return 0;
    S.parts.forEach((pt, k) => {
      pt.mesh.setMatrixAt(pt.i, on ? ZERO : S.saved[k]);
      pt.mesh.instanceMatrix.needsUpdate = true;
      // Zeroing a matrix leaves the mesh's bounding sphere claiming space it no longer fills;
      // recompute or the *rest* of the batch can end up frustum-culled with it.
      pt.mesh.computeBoundingSphere?.();
    });
    for (const gg of S.groups) gg.obj.visible = !on;
    return S.parts.length + S.groups.length;
  };

  // Framing in units of the subject, so the same numbers frame a knee-high bush and a 9 m oak:
  // [aim height as a fraction of the prop's height, stand-off in prop radii, fov, azimuth].
  window.__pcShot = (hf, mul, fov, ang) => {
    const S = window.__pc;
    const [sx, sy, sz] = S.pos;
    const [ph, pr] = S.size;
    const cam = window.game.camera;
    const aimY = sy + ph * hf;
    const dist = Math.max(2.2, Math.max(pr, ph * 0.45) * mul);
    cam.fov = fov;
    cam.position.set(sx + Math.cos(ang) * dist, aimY + dist * 0.16, sz + Math.sin(ang) * dist);
    cam.lookAt(sx, aimY, sz);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    // Three passes: the composer's FXAA and bloom read the previous frame's targets.
    for (let i = 0; i < 3; i++) window.game.r.render(0.016);
    return +dist.toFixed(1);
  };

  // Where the subject's own bounding box lands on screen, in screenshot pixels — the promise the
  // silhouette has to keep. Read off the canvas' client rect rather than the viewport, so a page
  // that ever gains a letterbox or a sidebar does not silently shift every measurement.
  window.__pcPromise = () => {
    const S = window.__pc, cam = window.game.camera, bb = S.box;
    if (!bb) return null;
    const V = cam.position.constructor;
    const el = window.game.r.renderer.domElement.getBoundingClientRect();
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const cx of [bb.min.x, bb.max.x]) {
      for (const cy of [bb.min.y, bb.max.y]) {
        for (const cz of [bb.min.z, bb.max.z]) {
          const v = new V(cx, cy, cz).project(cam);
          const sx = el.left + (v.x * 0.5 + 0.5) * el.width;
          const sy = el.top + (1 - (v.y * 0.5 + 0.5)) * el.height;
          x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
          y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
        }
      }
    }
    return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
  };

  // The loop has to be running for streaming to fill the cells around the spawn, and stopped
  // before framing or the rig lerps the camera home. Everything measured afterwards is
  // therefore resident by construction: the camera flies to props that are already there
  // instead of teleporting the player and waiting out another six seconds per kind.
  window.__pcEnter = async (zone, x, z) => {
    const g = window.game;
    g.start();
    await g.enterZone(zone, { x, z });
    await new Promise((r) => setTimeout(r, 6000));
    if (g.quality !== 'high') { g.setAutoQuality(false); g.setQuality('high'); }
    await new Promise((r) => setTimeout(r, 1500));
    g.stop();
    const a = g.me?.actor;
    const root = [a?.root, a?.group, a?.mesh, a?.obj].find((o) => o && o.isObject3D);
    if (root) root.visible = false;      // rebuilt by the zone change, so hidden after it
    return {
      zone: g.zoneId, quality: g.quality, avatarHidden: !!root,
      indoor: !!g.world.zone.indoor, kinds: window.__pcKinds(),
    };
  };
});

/* ------------------------------------------------------------------ the sweep -- */

const shoot = async (file) => {
  await p.screenshot({ path: file });
  return decodePng(fs.readFileSync(file));
};
const chan = (a, c) => Math.max(...[0, 1, 2].map((i) => Math.abs(a.rgb[i] - c.rgb[i])));

const SPAWN = { x: 0, z: 14 };
const FULL = [0.55, 4.2, 40];        // the human-eyeball artifact
const TIGHT = [0.5, 2.6, 34];        // the one that is measured
// Which side to stand on. A fixed set of world azimuths photographs whichever face the ring
// happens to turn that way, and for a wall segment that is a coin flip: the first run shot
// abyssArch and goldArcade from *outside* the arena, so the mid-storey articulation added to
// their inward faces changed their numbers by literally zero (std 3.9 and 10.2 before and after,
// mask within 0.3%) while iceCurtain — the one module the ring turned inward at az 0.9 — moved
// 4.2 → 14.3. So the fan is anchored on the direction of the spawn point, i.e. the side a player
// actually sees, and only spread from there. Props right on top of the anchor have no meaningful
// direction, hence the fallback.
const AZIMUTHS = (pos) => {
  const dx = SPAWN.x - pos[0], dz = SPAWN.z - pos[2];
  if (Math.hypot(dx, dz) < 3) return [0.9, 3.0, 5.1];
  const base = Math.atan2(dz, dx);
  return [base, base + 0.85, base - 0.85].map((a) => +a.toFixed(2));
};

const measured = new Map();          // kind -> row
const rows = [];

for (const zone of zones) {
  console.log(`\n=== ${zone}`);
  if (hmr.length) {
    console.log('client/src was hot-updated mid-run — every shot from here is untrustworthy');
    break;
  }
  const info = await p.evaluate(([z, s]) => window.__pcEnter(z, s.x, s.z), [zone, SPAWN]);
  if (!check(`${zone}: the game is in the zone we asked for`, info.zone === zone, info.zone)) continue;
  check(`${zone}: the avatar is out of the way`, info.avatarHidden);
  check(`${zone}: the tier is still pinned`, info.quality === 'high', info.quality);
  console.log(`  ${info.kinds.length} kinds resident: ${info.kinds.join(' ')}`);

  for (const kind of info.kinds) {
    if (measured.has(kind)) continue;
    const pick = await p.evaluate(([k, s]) => window.__pcPick(k, s.x, s.z), [kind, SPAWN]);
    if (!pick) { skipped(`${zone}/${kind}`, 'enumerated but no instance could be located'); continue; }

    const angles = AZIMUTHS(pick.pos);
    await p.evaluate(([sh, a]) => window.__pcShot(sh[0], sh[1], sh[2], a), [FULL, angles[0]]);
    await sleep(900);
    await p.screenshot({ path: `${outDir}/${kind}-full.png` });

    // The measured pair, retried around the subject: a mask of nothing can mean "not drawn"
    // (the defect) or "another prop is in the way from this side" (framing), and only trying
    // another azimuth tells them apart. Best of three, and which one is reported.
    let m = null, base = null, hidden = null, used = null, dist = 0, prom = null;
    for (const ang of angles) {
      dist = await p.evaluate(([sh, a]) => window.__pcShot(sh[0], sh[1], sh[2], a), [TIGHT, ang]);
      await sleep(900);
      const rect = await p.evaluate(() => window.__pcPromise());
      const bImg = await shoot(`${outDir}/${kind}-tight-az${ang}.png`);
      const n = await p.evaluate(() => window.__pcHide(true));
      await p.evaluate(([sh, a]) => window.__pcShot(sh[0], sh[1], sh[2], a), [TIGHT, ang]);
      await sleep(700);
      const hImg = await shoot(`${outDir}/${kind}-gone-az${ang}.png`);
      await p.evaluate(() => window.__pcHide(false));
      const mm = diffMask(bImg, hImg, 8);
      const on = rect ? maskInRect(mm, rect) : 0;
      if (!m || on > used.on) { m = mm; base = bImg; hidden = hImg; prom = rect; used = { ang, n, on }; }
      if (rect && on >= MIN_MASK * 6) break;
    }
    if (used.n === 0) { skipped(`${zone}/${kind}`, 'nothing to hide — no pieces or groups matched'); continue; }

    // Measured over the on-target part of the mask only: a bright subject's bloom halo and the
    // shadow it stops casting are both "pixels that changed when it went away", and neither is
    // the prop's material. Clipping to the projected box keeps `rgb`/`std` about the model.
    const inBox = prom ? { ...m, mask: m.mask.map((v, i) => (v
      && (i % m.width) >= prom.x && (i % m.width) <= prom.x + prom.w
      && Math.floor(i / m.width) >= prom.y && Math.floor(i / m.width) <= prom.y + prom.h ? 1 : 0)) } : m;
    const sub = maskStats(base, inBox, 'prop');
    const back = maskStats(hidden, inBox, 'behind');
    const dBack = chan(sub, back);
    const promArea = prom ? Math.max(1, Math.min(prom.w, W) * Math.min(prom.h, H)) : 1;
    const onTarget = m.count ? used.on / m.count : 0;
    const ofBox = used.on / promArea;
    const row = {
      zone, kind, pieces: pick.pieces + pick.groups, dist: pick.dist, camDist: dist,
      h: pick.size[0], r: pick.size[1], ang: used.ang, px: m.count, on: used.on, frac: m.frac,
      onTarget: +onTarget.toFixed(2), ofBox: +ofBox.toFixed(3),
      rgb: sub.rgb, lum: sub.lum, std: sub.std, p5: sub.p5, p95: sub.p95, clip: sub.clip,
      back: back.rgb, dBack,
    };
    rows.push(row);
    measured.set(kind, row);
    console.log(`  ${kind.padEnd(14)} ${pick.pieces + pick.groups}pc h${pick.size[0]} r${pick.size[1]}`
      + ` @${pick.dist}m cam${dist}m az${used.ang}  mask ${m.count}px on-target ${used.on}px`
      + ` (${(onTarget * 100).toFixed(0)}% of mask, ${(ofBox * 100).toFixed(1)}% of the ${prom ? `${prom.w}x${prom.h}` : '?'} box)`
      + `  rgb ${JSON.stringify(sub.rgb)} lum ${sub.lum} std ${sub.std} p${sub.p5}..${sub.p95}`
      + ` clip ${sub.clip}  behind ${JSON.stringify(back.rgb)} Δ${dBack}`);

    check(`${zone}/${kind}: is drawn, where its own bounding box says it is`,
      used.on >= MIN_MASK && m.frac <= MAX_FRAC && onTarget >= MIN_ON_TARGET && ofBox >= MIN_OF_BOX,
      `${used.on}px inside the projected box (${(onTarget * 100).toFixed(0)}% of the ${m.count}px that`
      + ` moved, ${(ofBox * 100).toFixed(1)}% of the box's ${promArea}px)`);
    check(`${zone}/${kind}: reads against what is behind it`, dBack >= MIN_BACKDROP,
      `prop ${JSON.stringify(sub.rgb)} vs the same pixels without it ${JSON.stringify(back.rgb)},`
      + ` biggest channel ${dBack}`);
    check(`${zone}/${kind}: has form, not a flat wash`, sub.std >= MIN_STD,
      `std ${sub.std}, p5..p95 ${sub.p5}..${sub.p95}`);
    check(`${zone}/${kind}: sits inside the gamut the tonemap can show`,
      Math.max(...sub.rgb) >= MIN_CHAN && Math.max(...sub.rgb) <= MAX_CHAN && sub.clip <= MAX_CLIP,
      `rgb ${JSON.stringify(sub.rgb)}, ${(sub.clip * 100).toFixed(0)}% of the silhouette clipping a channel to 0`);
  }
}

/* -------------------------------------------------------------------- coverage -- */

// A pooled batch is named `<kind>:<variant>` and a POI group `prop:<kind>`, except that the four
// chests are built as `prop:chest:common` … `prop:chest:luxurious` — so the name a zone hands the
// pool is not always the name `props.js` exports, and comparing them raw reported "no shot of
// chest" on a run that had photographed all four of them.
const all = [...new Set([...SCATTER_KINDS, ...SINGLE_KINDS])];
const shot = new Set([...measured.keys()].map((k) => k.split(':')[0]));
const missing = all.filter((k) => !shot.has(k));
const unreachable = missing.filter((k) => !(k in OFF_CAMERA));
const stale = Object.keys(OFF_CAMERA).filter((k) => shot.has(k));
console.log(`\nmeasured ${shot.size} of ${all.length} kinds, ${measured.size} counting variants separately`);
if (missing.length) {
  for (const k of missing) console.log(`  not measured: ${k}${OFF_CAMERA[k] ? ` — ${OFF_CAMERA[k]}` : ''}`);
}
// Coverage is a statement about the whole world, so only a whole-world run may make it. Asserted
// on a named subset it fails by construction ("no shot of oak, pine, bamboo …"), which would train
// everyone to read this probe's exit code as noise — and the suite runs it with no zone argument.
if (partial) {
  skipped('every prop kind the game builds was photographed and measured',
    `only ${zones.join(', ')} were visited — coverage needs the full run`);
  skipped('the OFF_CAMERA exemptions are all still needed', 'a subset run cannot retire an exemption');
} else {
  check('every prop kind the game builds was photographed and measured',
    unreachable.length === 0, unreachable.length ? `no shot of ${unreachable.join(', ')}` : `${shot.size} kinds, ${measured.size} with variants`);
  check('the OFF_CAMERA exemptions are all still needed', stale.length === 0,
    stale.length ? `${stale.join(', ')} were measured after all — delete them from the list` : 'none stale');
}

if (rows.length) {
  const worst = [...rows].sort((a, c) => (a.std - c.std) || (a.dBack - c.dBack)).slice(0, 8);
  console.log('\nflattest first:');
  for (const r of worst) {
    console.log(`  std ${String(r.std).padStart(5)}  Δbackdrop ${String(r.dBack).padStart(3)}`
      + `  ${r.zone}/${r.kind}  lum ${r.lum} rgb ${JSON.stringify(r.rgb)} ${r.px}px`);
  }
}

console.log('\nerrors ->', errs.length ? JSON.stringify([...new Set(errs)].slice(0, 6)) : 'none');
console.log('hmr    ->', hmr.length ? `${hmr.length} update(s) — RUN IS INVALID` : 'none');
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
await b.close();
// A green run has to have counted something: a `check()` that returned nothing once let a whole
// section be skipped by an `if` while the tally still said "0 failed".
if (pass + fail < 4 * 10) {
  console.log(`only ${pass + fail} assertions ran — a zone or the pool must have failed to load`);
  process.exit(1);
}
process.exit(fail ? 1 : 0);
