// What a dungeon looks like when the player looks *down*.
//
//   DISPLAY=:99 node tools/inlay-cam.mjs [zone ...] [--out /tmp/inlay]
//
// `tools/vault-cam.mjs` pitches the gameplay camera up to prove there is a ceiling overhead.
// This is the other half of the same argument, and it exists because of a number nobody had
// ever photographed: `terrain.inlayStrength`. The arena floor shader mixes rings, eight spokes
// and a centre medallion into the stone in `terrain.inlayColor`, scaled by that one uniform,
// and its own comment (client/src/gfx/terrain.js:351) says the right strength is a property of
// the *colour* — too weak and 黄金屋's dark jade "was a pattern that existed in the data and
// not on the screen", too strong and a bright trim "goes straight into the bloom threshold and
// the spokes flare into a solid cross of light". Only 黄金屋's 0.72 was ever measured, by hand,
// once. 深渊试炼场 and 冰渊洞 both carry 0.45 with a comment that reasons about bloom, and no
// probe in this repo reads the word `inlay` at all.
//
// The subject is found by *hiding* it rather than by a hand-typed rectangle: shoot the floor at
// the authored strength, shoot it again with `uInlayMix` at 0, and the pixels that moved are
// the inlay, at whatever size the framing gave it (tools/lib/png.mjs#diffMask, and the mask is
// its own control — zero pixels means the pattern was never drawn). What that mask then has to
// survive, in both directions:
//
//   1. it is on screen at all, and it is *where the data says it is*: 72 points around each
//      authored radius, projected through the same camera that took the shot, have to land in
//      the mask, and a control set on the bare stone between the rings has to stay out of it.
//      (The first framing tried to assert "the mask is on the floor, not in the vault" — at this
//      pitch every pixel in the frame is floor, so that one proved nothing in either direction.)
//   2. it still has the stone's texture. The shader mixes toward `uInlayColor * dress`, so the
//      joints, veins and wear run *through* the inlay; mixing toward a bare colour erased them
//      in proportion to the strength, which made the strongest inlay in the game the flattest
//      region of its floor. std inside the mask, against the same pixels with the mix off.
//   3. it is legible, and it is not a light. Compared with the floor in a collar 4-10 px outside
//      the mask — same distance, same lamp, same shadow band, so the light divides out (see the
//      `divide-the-light-out` habit in the README) — the inlay must be at least 18 sRGB counts
//      away on its strongest channel, and no more than 2.6× as bright with a p95 clear of the
//      bloom threshold. This is the pair the first run caught: two of the three arenas were
//      painting the pattern in their own floor colour.
//   4. the authored number is a live scale, not a switch. A third shot at `uInlayMix = 1`
//      bounds the authored strength from both sides: the colour shift it produces has to be a
//      real fraction of the full-strength shift, neither invisible nor already saturated.
//
// Habits inherited from the probes next door: pin the tier (llvmpipe boots every browser at
// `low`), pin the clock, keep a control that must move (two yaws), decode the PNGs in-process
// so no second page steals focus, and take the animation noise floor as a pair of shots with
// nothing touched between them so a "the inlay moved 9000 px" claim is measured against what
// the frame does on its own.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';
import { ZONES, zoneById, zoneEntryRank } from '../shared/src/data/zones.js';
import { decodePng, diffMask, maskStats, pixelsDiffering } from './lib/png.mjs';
import { raiseRank } from './lib/account.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/inlay'; })();
const asked = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
const zones = asked.length ? asked : Object.values(ZONES).filter((z) => z.indoor).map((z) => z.id);
const W = 1000, H = 700;
mkdirSync(outDir, { recursive: true });

// A frame the player can actually get: `camera.js` clamps pitch to 1.16 and the boom to 13.5 m,
// so this is the most floor a scroll wheel and a mouse drag can put on screen. Pitch 1.0 rather
// than the 1.16 limit because at the limit the near floor under the camera fills the bottom
// third and the rings are squeezed into a thin band at the top.
const DOWN_PITCH = 1.0;
const BOOM = 13.5;
// Where to stand. The inlay is two rings at 0.24R and 0.52R plus spokes between 0.16R and
// 0.56R, so the centre of the arena shows only the medallion and a distant hoop. Standing at
// 0.34R and looking inward puts the inner ring a few metres ahead, the spokes converging into
// it, and the medallion near the top of frame — three of the four features the shader draws.
const STAND = 0.34;
// The second framing, for the centre medallion (`medal` in the same shader block, a disc that
// fades out between 0.055R and 0.075R). From 0.34R it is a handful of pixels at the top of the
// frame, which is why the first version of this probe measured everything about the floor except
// the one feature it is standing on: stand *just outside* the medallion instead and look inward,
// so its own edge is a couple of metres ahead whatever the arena's radius is (66 m in 黄金屋,
// 26 m in the other two).
const MEDAL_STAND = 0.095;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, skip = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}
function skipped(name, why) { skip++; console.log(`  SKIP ${name} — ${why}`); }

/** Mean per-pixel largest-channel move between two frames, over a mask. "How far did it shift?" */
function shift(a, b, m) {
  let sum = 0, n = 0;
  for (let i = 0; i < m.mask.length; i++) {
    if (!m.mask[i]) continue;
    const px = i * 4;
    sum += Math.max(
      Math.abs(a.data[px] - b.data[px]),
      Math.abs(a.data[px + 1] - b.data[px + 1]),
      Math.abs(a.data[px + 2] - b.data[px + 2]),
    );
    n++;
  }
  return n ? +(sum / n).toFixed(1) : 0;
}

const bag = (m, mask) => {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return { mask, count: n, width: m.width, height: m.height };
};

/** Separable square dilation by `d` px — a mask grown outwards, used to find "beside it". */
function dilate(m, d) {
  const { width, height } = m;
  const h = new Uint8Array(m.mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!m.mask[row + x]) continue;
      for (let k = Math.max(0, x - d); k <= Math.min(width - 1, x + d); k++) h[row + k] = 1;
    }
  }
  const v = new Uint8Array(m.mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!h[y * width + x]) continue;
      for (let k = Math.max(0, y - d); k <= Math.min(height - 1, y + d); k++) v[k * width + x] = 1;
    }
  }
  return bag(m, v);
}

/**
 * The floor *immediately* around the inlay: a collar 4-10 px outside the mask. Not "the rest of
 * the frame", which at this pitch spans 60 m of fog and every prop in the room and would make
 * the comparison a lighting measurement instead of an albedo one — the collar is the same
 * distance, the same lamp and the same shadow band as the pixels it is compared with.
 */
const collar = (m) => {
  const inner = dilate(m, 4), outer = dilate(m, 10);
  const mask = new Uint8Array(m.mask.length);
  for (let i = 0; i < mask.length; i++) if (outer.mask[i] && !inner.mask[i]) mask[i] = 1;
  return bag(m, mask);
};

const union = (a, b2) => {
  const mask = new Uint8Array(a.mask.length);
  for (let i = 0; i < mask.length; i++) if (a.mask[i] || b2.mask[i]) mask[i] = 1;
  return bag(a, mask);
};

const and = (a, b2) => {
  const mask = new Uint8Array(a.mask.length);
  for (let i = 0; i < mask.length; i++) if (a.mask[i] && b2.mask[i]) mask[i] = 1;
  return bag(a, mask);
};

/**
 * Fill the projected outline of a circle on the floor: even-odd scanline over the polygon.
 *
 * The medallion is a *disc*, not a line, so "did it land in the mask" is the wrong question —
 * the question is whether the pattern fills the area the shader says it covers. A perspective
 * camera maps a ground circle to a conic and keeps the vertex order, so the projected samples
 * are already a simple polygon and a scanline is exact enough at this size.
 */
function fillPoly(width, height, pts) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i], s = pts[(i + 1) % pts.length];
      if ((q.y <= y && s.y > y) || (s.y <= y && q.y > y)) {
        xs.push(q.x + ((y - q.y) / (s.y - q.y)) * (s.x - q.x));
      }
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k])), x1 = Math.min(width - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) mask[y * width + x] = 1;
    }
  }
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return { mask, count: n, width, height };
}

/** `a` minus `b`: the pixels that moved for the reason under test and not for another one. */
const andNot = (a, b2) => {
  const mask = new Uint8Array(a.mask.length);
  for (let i = 0; i < mask.length; i++) if (a.mask[i] && !b2.mask[i]) mask[i] = 1;
  return bag(a, mask);
};

/** How many of `pts` land within `tol` px of a mask pixel. */
function hits(m, pts, tol = 3) {
  let n = 0;
  for (const q of pts) {
    let found = false;
    for (let dy = -tol; dy <= tol && !found; dy++) {
      for (let dx = -tol; dx <= tol && !found; dx++) {
        const x = Math.round(q.x) + dx, y = Math.round(q.y) + dy;
        if (x < 0 || y < 0 || x >= m.width || y >= m.height) continue;
        if (m.mask[y * m.width + x]) found = true;
      }
    }
    if (found) n++;
  }
  return n;
}

/**
 * A mask of small squares around each point — the clipping-robust way to sample a ring.
 *
 * Filling a projected annulus needs the *whole* outline in frame, and a camera standing on the
 * ring itself has the far half behind it (`pts(...).on === false`), which turns the polygon into
 * garbage rather than into nothing. Sampling only the points that are on screen keeps the
 * reference at the same radius, the same lamp and the same shadow band, and degrades to "too few
 * points, SKIP" instead of to a wrong number.
 */
function dots(width, height, pts, r = 5) {
  const mask = new Uint8Array(width * height);
  for (const q of pts) {
    const cx = Math.round(q.x), cy = Math.round(q.y);
    for (let y = Math.max(0, cy - r); y <= Math.min(height - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(width - 1, cx + r); x++) mask[y * width + x] = 1;
    }
  }
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return { mask, count: n, width, height };
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

const token = readFileSync('/tmp/world-token.txt', 'utf8').trim();
// Before the page loads: every zone gate reads the save that `Game.load` fetches once, and
// 黄金屋 needs AR 18. Without this the `enterZone` is refused and the probe would measure
// 深渊试炼场's floor twice — caught below by the zone assertion, but as a confusing red.
const needRank = Math.max(...zones.map((z) => zoneEntryRank(zoneById(z))));
if (needRank > 1) {
  const rr = await raiseRank(process.env.GAME_API || 'http://127.0.0.1:8787', token, needRank);
  console.log(`rank -> AR ${rr.rank ?? '?'} (need ${needRank})${rr.ok ? '' : ` — ${rr.reason}`}`);
}
await p.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' });
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
  window.game.setWorldTime(12);
});
await sleep(3000);
const tier = await p.evaluate(() => window.game.quality);
console.log('quality pinned ->', tier);
if (tier !== 'high') { console.log('tier did not pin; every shot would be at low'); await b.close(); process.exit(1); }

let shots = 0;
const shoot = async (zone, label) => {
  shots++;
  await p.screenshot({ path: `${outDir}/${zone}-${label}.png` });
  return decodePng(readFileSync(`${outDir}/${zone}-${label}.png`));
};
/** Set `uInlayMix` and read back what the material actually holds. */
const setMix = (v) => p.evaluate((mix) => {
  const u = window.game.world.terrain.uniforms.uInlayMix;
  if (mix !== null) u.value = mix;
  return u.value;
}, v);

for (const zone of zones) {
  const z = ZONES[zone];
  console.log(`\n=== ${zone}`);
  if (hmr.length) {
    console.log('client/src was hot-updated mid-run — the shots from here are untrustworthy');
    break;
  }
  const R = z.terrain?.arena?.radius || 0;
  if (!R) { skipped(`${zone}: has an arena floor to inlay`, 'no terrain.arena'); continue; }

  const info = await p.evaluate(async ([zid, x, pitch, boom]) => {
    const g = window.game;
    // Spawned at the offset rather than walked there: a probe that drives WASD spends ten
    // seconds and lands somewhere else (dt is clamped, llvmpipe runs at 3 fps), and writing
    // `me.x` directly gets lerped home by the server reconciler.
    await g.enterZone(zid, { x, z: 0 });
    await new Promise((r) => setTimeout(r, 6000));
    g.rig.pitch = pitch;
    g.rig.yaw = Math.PI / 2;              // basis forward is (-1, 0): looking back at the centre
    g.rig.dist = boom;
    g.rig._distNow = boom;                // the boom extends slowly; jump it, then let it settle
    // The avatar owns the middle of a pitched-down frame, and her shadow owns the floor under
    // it. The HUD is hidden for the same reason: its cooldown sweeps and breathing bars would
    // land in every diff mask below as pixels that "moved when the inlay was switched off".
    const a = g.me?.actor;
    const root = [a?.root, a?.group, a?.mesh, a?.obj].find((o) => o && o.isObject3D);
    if (root) root.visible = false;
    const hud = document.querySelector('[data-hud]');
    if (hud) hud.style.visibility = 'hidden';
    return {
      zone: g.zoneId, indoor: !!g.world.zone.indoor, q: g.quality,
      x: +g.me.x.toFixed(1), z: +g.me.z.toFixed(1), y: +g.me.y.toFixed(1),
      arenaR: g.world.terrain.uniforms.uArenaR.value,
      mix: g.world.terrain.uniforms.uInlayMix.value,
      avatarHidden: !!root,
      hudHidden: !!hud && getComputedStyle(hud).visibility === 'hidden',
    };
  }, [zone, +(R * STAND).toFixed(1), DOWN_PITCH, BOOM]);
  console.log(' ', JSON.stringify(info));
  if (!check(`${zone}: the game is in the zone we asked for`, info.zone === zone, info.zone)) continue;
  check(`${zone}: the avatar and the HUD are out of the way of the floor`,
    info.avatarHidden === true && info.hudHidden === true, JSON.stringify(info));
  // The shader's own precondition: outdoors `uArenaR` is 0 and the whole inlay branch is
  // skipped, so a floor pattern authored for a zone without an arena draws nothing.
  check(`${zone}: the arena radius reaches the floor shader`, info.arenaR === R,
    `uArenaR ${info.arenaR}, data ${R}`);
  // Authored, not defaulted: `t.inlayStrength ?? 0.45` means a zone that forgets the key still
  // gets a mid-strength pattern, so the uniform agreeing with the *data* is the only proof the
  // number under test is the number someone chose.
  check(`${zone}: the authored inlay strength is what the material holds`,
    z.terrain.inlayStrength !== undefined && info.mix === z.terrain.inlayStrength,
    `data ${z.terrain.inlayStrength} → uniform ${info.mix}`);

  await sleep(3500);
  const camY = await p.evaluate(() => +(window.game.rig.camera.position.y - window.game.me.y).toFixed(1));
  check(`${zone}: the camera really is above the floor looking down`, camY > 6,
    `${camY} m over the character, pitch ${DOWN_PITCH}, boom ${BOOM}`);

  const a0 = await shoot(zone, 'in');
  // The control. If these two are the same frame, rAF is throttled and every number below is
  // one stale screenshot measured six times.
  await p.evaluate(() => { window.game.rig.yaw = -Math.PI / 2; });
  await sleep(3000);
  const out = await shoot(zone, 'out');
  const moved = pixelsDiffering(a0, out, 2);
  check(`${zone}: the camera is live (two yaws differ)`, moved > 2000, `${moved} px`);
  await p.evaluate(() => { window.game.rig.yaw = Math.PI / 2; });
  await sleep(3500);

  // The noise floor: two shots, nothing touched between them. Brazier flicker, drifting motes,
  // the crystals' shimmer and llvmpipe's dither all live in here — 深渊试炼场 moves 39k pixels on
  // its own between two consecutive frames, which is *half* of what switching the inlay off
  // moves, so this is not a formality: every pixel that was going to move anyway is subtracted
  // out below rather than counted as pattern.
  const a1 = await shoot(zone, 'auth-1');
  await sleep(3000);
  const a2 = await shoot(zone, 'auth-2');
  const noiseA = diffMask(a1, a2, 8);

  // The subject: the same floor with the pattern switched off, then over-driven, then put back.
  const off = await setMix(0);
  await sleep(3000);
  const b0 = await shoot(zone, 'mix-0');
  const full = await setMix(1);
  await sleep(3000);
  const d1 = await shoot(zone, 'mix-1');
  const back = await setMix(z.terrain.inlayStrength);
  await sleep(3000);
  const a3 = await shoot(zone, 'auth-3');
  // A second noise pair across the whole span of the experiment: same uniform in a2 and a3, ~12 s
  // apart, so a brazier that happens to sit still for three seconds still lands in here.
  const noiseB = diffMask(a2, a3, 8);
  const noise = union(noiseA, noiseB);

  const raw = diffMask(a2, b0, 8);
  const m = andNot(raw, noise);
  const ink = maskStats(a2, m, 'inlay');
  const bare = maskStats(b0, m, 'bare');
  const near = maskStats(a2, collar(m), 'floor');
  const sAuth = shift(a2, b0, m);
  const sFull = shift(d1, b0, m);
  const stdRatio = bare.std > 0.05 ? +(ink.std / bare.std).toFixed(2) : 0;
  const lumRatio = near.lum > 0.5 ? +(ink.lum / near.lum).toFixed(2) : 0;
  const dCol = Math.max(...[0, 1, 2].map((i) => Math.abs(ink.rgb[i] - near.rgb[i])));

  // Where the *data* says the pattern is, projected through the same camera that took the shot:
  // 72 points around the inner ring at 0.24R and the outer at 0.52R, and a control set on the
  // bare stone between them, off the spokes (which sit every 45°). This is the assertion that
  // survives a reframing — the counts and the areas above all depend on how much floor happens
  // to be in shot, while "the ring in the screenshot is the ring in zones.js" does not.
  const geo = await p.evaluate(([R2, stand]) => {
    const g = window.game;
    const cam = g.rig.camera;
    const V = cam.position.constructor;                 // no THREE on window; borrow the class
    const r = document.querySelector('canvas').getBoundingClientRect();
    const pts = (rad, angles) => angles.map((a) => {
      const v = new V(Math.cos(a) * rad * R2, g.me.y + 0.02, Math.sin(a) * rad * R2);
      v.project(cam);
      return {
        x: (v.x * 0.5 + 0.5) * r.width + r.left,
        y: (-v.y * 0.5 + 0.5) * r.height + r.top,
        on: v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1,
      };
    }).filter((q) => q.on);
    const ring = [];
    for (let i = 0; i < 72; i++) ring.push((i / 72) * Math.PI * 2);
    // Off every spoke, and radii that clear both rings by more than their half-width. Three
    // angles per 45° sector rather than one: a spoke is 0.03 of a turn/8 wide, i.e. ±1.35°, so
    // anything past ~3° off it is bare stone — and 黄金屋's arena is 66 m, which is big enough
    // that a single ring of control points put only 6 of them on screen and the probe failed its
    // own "enough samples" floor. Widening the sample is the fix; lowering the floor is not.
    const between = [];
    for (let k = 0; k < 8; k++) for (const f of [0.28, 0.5, 0.72]) between.push((k + f) * Math.PI / 4);
    const bareRadii = [0.10, 0.13, 0.30, 0.33, 0.36, 0.40, 0.44, 0.48];
    return {
      stand,
      ring: [...pts(0.24, ring), ...pts(0.52, ring)],
      bare: bareRadii.flatMap((rad) => pts(rad, between)),
    };
  }, [R, +(R * STAND).toFixed(1)]);
  const onRing = hits(m, geo.ring);
  const onBare = hits(m, geo.bare);

  console.log(`  mask ${m.count} px (${(100 * m.count / (W * H)).toFixed(1)}% of frame)`
    + ` of ${raw.count} the toggle moved · ${noise.count} px move on their own`);
  console.log(`  inlay  lum ${ink.lum} std ${ink.std} rgb ${JSON.stringify(ink.rgb)} p95 ${ink.p95}`);
  console.log(`  bare   lum ${bare.lum} std ${bare.std} rgb ${JSON.stringify(bare.rgb)} p95 ${bare.p95}`);
  console.log(`  collar lum ${near.lum} std ${near.std} rgb ${JSON.stringify(near.rgb)} n ${near.n}`);
  console.log(`  shift authored ${sAuth} · at mix 1 ${sFull} · ratio ${(sFull ? sAuth / sFull : 0).toFixed(2)}`);
  console.log(`  geometry: ${onRing}/${geo.ring.length} ring samples in the mask,`
    + ` ${onBare}/${geo.bare.length} control samples on bare stone`);

  check(`${zone}: switching the inlay off changes the frame`, off === 0 && full === 1 && back === z.terrain.inlayStrength,
    `uniform read back 0 / 1 / ${back}`);
  // 6× the noise floor *and* an absolute area: a pattern that only clears the noise by a
  // margin is a pattern the player cannot see either.
  check(`${zone}: the floor pattern is on screen at the authored strength`,
    m.count > 6000 && m.count > raw.count * 0.3,
    `${m.count} px of the ${raw.count} the toggle moved survive subtracting the ${noise.count} px`
    + ' that move on their own');
  // Both directions, because either one alone is free: a mask that covers the ring but also
  // everything else is a wash, and a mask that avoids the bare stone but misses the ring is
  // whatever else the toggle happened to change.
  if (geo.ring.length >= 12) {
    check(`${zone}: the pattern is where zones.js says the rings are`,
      onRing / geo.ring.length > 0.6,
      `${onRing}/${geo.ring.length} points on r=0.24R/0.52R landed in the mask`);
    check(`${zone}: ...and the bare stone between them stayed bare`,
      geo.bare.length >= 8 && onBare / geo.bare.length < 0.25,
      `${onBare}/${geo.bare.length} control points off the spokes landed in the mask`);
  } else {
    skipped(`${zone}: the pattern is where zones.js says the rings are`,
      `only ${geo.ring.length} ring samples are on screen from ${geo.stand} m out`);
  }
  // The 黄金屋 regression, as a rule: the mix goes toward `uInlayColor * dress`, so the joints,
  // veins and wear survive it. Mixing toward a bare colour flattened the strongest inlay in the
  // game (std 1.9 inside a jade spoke against 6.9 for the gold slab beside it).
  check(`${zone}: the inlay is stone, not paint — it keeps the floor's texture`,
    stdRatio >= 0.55, `std ${ink.std} inside the inlay vs ${bare.std} with the mix off (${stdRatio}×)`);
  // The assertion the first run of this probe was written to find, and did: the pattern has to
  // be *legible*, and legibility is a distance between the inlay and the stone it is set into —
  // not a strength. 深渊试炼场 painted 0x7a68c8 onto a 0x807ca8 floor and 冰渊洞 painted 0x8ec0da
  // onto 0x9cc0d4, i.e. an albedo 14 counts away from its own floor in one channel, and both
  // zones' comments then argued about *bloom* as if the mix were the reason nothing showed. 18
  // counts on the strongest channel, measured against the collar 4-10 px outside the mask so the
  // lamp divides out: 黄金屋's jade-on-gold reads 46 here, and a pattern under ~15 is invisible
  // in the screenshots next to this file.
  check(`${zone}: the inlay reads as a different stone from the floor around it`,
    dCol >= 18, `inlay ${JSON.stringify(ink.rgb)} vs floor ${JSON.stringify(near.rgb)}, biggest channel ${dCol}`);
  // The other side of the same rule, and the shader's own bloom argument: a bright trim "flares
  // into a solid cross of light". Contrast may come from hue or from lightness, so this bounds
  // only what the tone curve cannot take — a trim more than 2.6× its floor, or a p95 up against
  // the top of the range where bloom feeds.
  check(`${zone}: and not as a light source burnt into it`,
    lumRatio > 0.40 && lumRatio < 2.6 && ink.p95 < 238,
    `inlay lum ${ink.lum} vs floor ${near.lum} (${lumRatio}×), p95 ${ink.p95}`);
  // The authored number is a scale, bounded from both sides by the frame at mix 1. A clamp
  // somewhere downstream, or a strength so low the tone curve eats it, both land outside this.
  const ratio = sFull ? sAuth / sFull : 0;
  check(`${zone}: the authored strength is a real fraction of full strength`,
    sFull > 4 && ratio > 0.2 && ratio < 0.92,
    `shift ${sAuth} at ${z.terrain.inlayStrength} vs ${sFull} at 1.0 — ${ratio.toFixed(2)}`);
  // And the run put the world back: otherwise the *next* zone in this loop, or the tour probe
  // sharing this browser profile, would be measuring a floor this file over-drove.
  const restored = diffMask(a2, a3, 8);
  check(`${zone}: the authored strength is restored afterwards`,
    restored.count < Math.max(noise.count * 3, 1500),
    `${restored.count} px differ from the authored frame (noise floor ${noise.count})`);

  /* ------------------------------------------------- the centre medallion -- */

  // The one feature of the arena floor that had never been photographed. Everything above is
  // measured over a mask that *includes* the medallion, and that is exactly why it proved
  // nothing about it: a mask 20 000 px in size does not notice that the 300 px in the middle
  // are flat, or the wrong colour, or absent. The medallion is also the place where the shader
  // mixes hardest (`medal * uInlayMix * 0.9`, toward `uInlayColor * dress * 1.05`), so it is the
  // *most likely* place for the 黄金屋 flattening regression to survive — the README's own
  // numbers for that bug were "std 1.9 inside a jade spoke, 1.1 under the medallion".
  //
  // Its strength is derived from the band strength rather than authored separately, and that
  // claim is checkable rather than decorative: both are the same uniform times a constant, so
  // the authored-vs-full shift *ratio* under the medallion has to agree with the one measured
  // over the bands above. A second authored number would drift away from it.
  const medInfo = await p.evaluate(async ([zid, x, pitch, boom]) => {
    const g = window.game;
    await g.enterZone(zid, { x, z: 0 });
    await new Promise((r) => setTimeout(r, 6000));
    g.rig.pitch = pitch;
    g.rig.yaw = Math.PI / 2;
    g.rig.dist = boom;
    g.rig._distNow = boom;
    // Re-hidden: `enterZone` rebuilds the actor, so the avatar and her shadow are back over the
    // exact patch of floor this section is about.
    const a = g.me?.actor;
    const root = [a?.root, a?.group, a?.mesh, a?.obj].find((o) => o && o.isObject3D);
    if (root) root.visible = false;
    const hud = document.querySelector('[data-hud]');
    if (hud) hud.style.visibility = 'hidden';
    return {
      zone: g.zoneId, x: +g.me.x.toFixed(1), z: +g.me.z.toFixed(1),
      mix: g.world.terrain.uniforms.uInlayMix.value,
      arenaR: g.world.terrain.uniforms.uArenaR.value,
      avatarHidden: !!root,
    };
  }, [zone, +(R * MEDAL_STAND).toFixed(1), DOWN_PITCH, BOOM]);
  await sleep(3500);
  if (!check(`${zone}: 徽章 — the camera moved to the middle of the arena`,
    medInfo.zone === zone && Math.abs(medInfo.x) <= R * MEDAL_STAND + 1.5
    && medInfo.arenaR === R && medInfo.avatarHidden,
    JSON.stringify(medInfo))) continue;

  const m1 = await shoot(zone, 'med-auth-1');
  await sleep(3000);
  const m2 = await shoot(zone, 'med-auth-2');
  const medOff = await setMix(0);
  await sleep(3000);
  const mb = await shoot(zone, 'med-mix-0');
  const medFull = await setMix(1);
  await sleep(3000);
  const md = await shoot(zone, 'med-mix-1');
  const medBack = await setMix(z.terrain.inlayStrength);
  await sleep(3000);
  const m3 = await shoot(zone, 'med-auth-3');
  const medNoise = union(diffMask(m1, m2, 8), diffMask(m2, m3, 8));
  const medMoved = andNot(diffMask(m2, mb, 8), medNoise);
  check(`${zone}: 徽章 — the toggle went through the material`,
    medOff === 0 && medFull === 1 && medBack === z.terrain.inlayStrength,
    `uniform read back 0 / 1 / ${medBack}`);

  // The disc the shader promises, and a control annulus outside it. Nothing else is drawn
  // between 0.075R and the inner ring's edge — the spokes start at 0.16R — so the floor at
  // 0.10R-0.13R must not move when the inlay is switched off, or what is being measured is a
  // tinted floor rather than a medallion.
  const medGeo = await p.evaluate(([R2]) => {
    const g = window.game;
    const cam = g.rig.camera;
    const V = cam.position.constructor;
    const r = document.querySelector('canvas').getBoundingClientRect();
    const pts = (rad, n, from = 0) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = from + (i / n) * Math.PI * 2;
        const v = new V(Math.cos(a) * rad * R2, g.me.y + 0.02, Math.sin(a) * rad * R2);
        v.project(cam);
        out.push({
          x: (v.x * 0.5 + 0.5) * r.width + r.left,
          y: (-v.y * 0.5 + 0.5) * r.height + r.top,
          on: v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1,
        });
      }
      return out;
    };
    // 0.052R: just inside where the fade starts (0.055R), so the whole polygon is the *solid*
    // part of the medallion and no pixel in it is half-faded.
    return {
      disc: pts(0.052, 48),
      around: [0.10, 0.115, 0.13].flatMap((rad) => pts(rad, 24, 0.2)),
    };
  }, [R]);
  const discOn = medGeo.disc.filter((q) => q.on);
  if (discOn.length < medGeo.disc.length) {
    skipped(`${zone}: 徽章 — the medallion is drawn where the shader says it is`,
      `only ${discOn.length}/${medGeo.disc.length} of its outline is on screen from ${(R * MEDAL_STAND).toFixed(1)} m out`);
    continue;
  }
  const disc = fillPoly(m2.width, m2.height, medGeo.disc);
  const inside = and(medMoved, disc);
  const around = medGeo.around.filter((q) => q.on);
  const onAround = hits(medMoved, around);
  const ink2 = maskStats(m2, inside, 'medal');
  const bare2 = maskStats(mb, inside, 'bare');
  // Bare floor between 0.10R and 0.13R: past the medallion's fade (0.075R), short of the inner
  // ring and of where the spokes start (0.16R). Sampled as dots on the points that are actually
  // in frame, and with every pixel the inlay touched subtracted, so a ring that happens to clip
  // a band or a spoke cannot pass itself off as bare stone.
  const refRing = andNot(dots(m2.width, m2.height, around, 5), dilate(medMoved, 2));
  const near2 = maskStats(m2, refRing, 'floor');
  const sA = shift(m2, mb, inside);
  const sF = shift(md, mb, inside);
  const stdR2 = bare2.std > 0.05 ? +(ink2.std / bare2.std).toFixed(2) : 0;
  const lumR2 = near2.lum > 0.5 ? +(ink2.lum / near2.lum).toFixed(2) : 0;
  const dCol2 = Math.max(...[0, 1, 2].map((i) => Math.abs(ink2.rgb[i] - near2.rgb[i])));
  const medRatio = sF ? sA / sF : 0;

  console.log(`  徽章 disc ${disc.count} px projected, ${inside.count} of them moved`
    + ` · ${onAround}/${around.length} control points at 0.10-0.13R moved`);
  console.log(`  徽章 lum ${ink2.lum} std ${ink2.std} rgb ${JSON.stringify(ink2.rgb)} p95 ${ink2.p95}`
    + ` · bare std ${bare2.std} · floor at 0.10-0.13R lum ${near2.lum} rgb ${JSON.stringify(near2.rgb)}`
    + ` n ${near2.n} from ${around.length}/${medGeo.around.length} points`);
  console.log(`  徽章 shift authored ${sA} · at mix 1 ${sF} · ratio ${medRatio.toFixed(2)}`
    + ` (bands ${ratio.toFixed(2)})`);

  // Both directions: it fills its own disc, and it stops there.
  check(`${zone}: 徽章 — the medallion fills the disc the shader promises`,
    disc.count > 400 && inside.count > disc.count * 0.7,
    `${inside.count}/${disc.count} px inside r=0.052R moved when the inlay was switched off`);
  check(`${zone}: 徽章 — ...and the floor just outside it did not move`,
    around.length >= 12 && onAround / around.length < 0.25,
    `${onAround}/${around.length} points at 0.10-0.13R landed in the mask`);
  // The flattening regression, at the place it would survive longest.
  check(`${zone}: 徽章 — it is stone, not a decal: the floor's texture runs through it`,
    stdR2 >= 0.55, `std ${ink2.std} under the medallion vs ${bare2.std} with the mix off (${stdR2}×)`);
  if (around.length < 12 || refRing.count < 300) {
    skipped(`${zone}: 徽章 — it reads as a different stone from the floor around it`,
      `the 0.10R-0.13R reference floor is barely in frame (${around.length} points, ${refRing.count} px)`);
  } else {
    // Both colour claims carry the subject's own precondition: with the medallion deleted the
    // mask is empty, `maskStats` reads [0,0,0], and "it is a different colour from the floor"
    // passes by 143 channels for having no pixels at all.
    const subj = inside.count > disc.count * 0.5;
    check(`${zone}: 徽章 — it reads as a different stone from the floor around it`,
      subj && dCol2 >= 18,
      `${JSON.stringify(ink2.rgb)} (${inside.count} px) vs bare floor ${JSON.stringify(near2.rgb)} at 0.10-0.13R, biggest channel ${dCol2}`);
    check(`${zone}: 徽章 — and it is not a lamp set into the floor`,
      subj && lumR2 > 0.40 && lumR2 < 2.6 && ink2.p95 < 238,
      `lum ${ink2.lum} vs floor ${near2.lum} (${lumR2}×), p95 ${ink2.p95}`);
  }
  // Derived, not authored twice: `uInlayMix` scales the medallion and the bands through the same
  // multiply, so the fraction of full strength each one reaches must be the *same number*, not
  // merely a similar one. Measured deviations are 0.00-0.02 across the three arenas; 0.10 leaves
  // five times that and still rejects a medallion whose own brightness was rescaled (a ×4 mutant
  // on the mix target reads 0.85 against bands 0.62 — and it slips through both the lum band and
  // the p95 ceiling, so this is the assertion that owns "the medallion is not its own artwork").
  check(`${zone}: 徽章 — its strength is the band strength, not a second number`,
    sF > 4 && medRatio > 0.2 && medRatio < 0.92 && Math.abs(medRatio - ratio) < 0.10,
    `medallion ${medRatio.toFixed(2)} vs bands ${ratio.toFixed(2)} of full strength`);
  const medRestored = diffMask(m2, m3, 8);
  check(`${zone}: 徽章 — the authored strength is restored afterwards`,
    medRestored.count < Math.max(medNoise.count * 3, 1500),
    `${medRestored.count} px differ from the authored frame (noise floor ${medNoise.count})`);
}

console.log('\nerrors ->', errs.length ? JSON.stringify([...new Set(errs)].slice(0, 6)) : 'none');
console.log('hmr    ->', hmr.length ? `${hmr.length} update(s) — RUN IS INVALID` : 'none');
console.log(`shots  -> ${shots}`);
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
await b.close();
// A green run has to have counted something: `check` returning nothing once let an entire
// section be skipped by an `if`, and the tally still said "0 failed".
if (pass + fail < zones.length * 14) {
  console.log(`only ${pass + fail} assertions ran for ${zones.length} zone(s) — expected ${zones.length * 14}`);
  process.exit(1);
}
process.exit(fail ? 1 : 0);
