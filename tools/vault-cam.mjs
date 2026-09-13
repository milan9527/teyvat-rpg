// What a dungeon looks like when the player looks *up*.
//
//   DISPLAY=:99 node tools/vault-cam.mjs [zone ...] [--out /tmp/vault]
//
// `tools/tour.mjs` shoots every zone at pitch 0.24, i.e. slightly *down*, because that is
// where the third-person camera sits while you walk. That framing has never once contained
// a dungeon's ceiling: the three arenas are enclosed by 16-20 m wall modules, so at 0.24
// the top of frame is wall, and what is overhead was judged by nobody — which is how a
// vault shader that never reached the screen survived a full rewrite. This probe pitches
// the *gameplay* camera to `MIN_PITCH` (-0.28 rad, the limit `client/src/game/camera.js`
// clamps to, so it is a frame a player can actually get) and measures a vertical profile.
//
// It asserts the claims the ceiling's own comments make, because they are the ones that
// fail silently:
//
//   1. there is a ceiling in the frame at all — the top band must not be the fog colour;
//   2. it has form — std over ~4 sRGB, or it is a flat wash (see tools/pixstd.mjs for why
//      that number, and why a *high* std with a wide p5..p95 means edges, not texture);
//   3. a dungeon is dark above and lit below — the top band must be darker than the floor
//      band. This is the one that decides whether a room reads as enclosed or as an
//      outdoor arena at dusk.
//
// Habits inherited from the other probes here, each of which cost a wasted run once:
// pin the tier (llvmpipe boots every browser at `low`), never let a second page decode the
// screenshots (it steals focus and Firefox throttles rAF to a stale frame — hence
// tools/lib/png.mjs), and keep a control that must move (two shots at different yaws have
// to differ, or the run is measuring one frozen frame four times).
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';
import { ZONES, zoneById, zoneEntryRank } from '../shared/src/data/zones.js';
import { decodePng, rectStats, pixelsDiffering } from './lib/png.mjs';
import { raiseRank } from './lib/account.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/vault'; })();
const asked = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
const zones = asked.length ? asked : Object.values(ZONES).filter((z) => z.indoor).map((z) => z.id);
const W = 1000, H = 700;
mkdirSync(outDir, { recursive: true });

// The camera's own clamp: looking any further up is not a frame the game can produce.
const UP_PITCH = -0.28;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}

// A vertical profile rather than three named bands, because the elevation at which the
// wall stops and the vault starts is different in every arena (wall height over arena
// radius) and a band hard-coded as "wall" lands on ceiling in one zone and on floor in
// another. Six stacked strips, top to bottom; the top one is the vault, the bottom one is
// the floor, and "is there a ceiling line at all" becomes the largest step between
// neighbours instead of a guess about where to look.
//
// x is 250..620: not the middle 60% of the width, which sounds neutral and is not — the HUD
// puts the party portraits at the top left, the mora/currency row at the top right and the
// minimap under it, and all three are inside a naive centre crop.
const BAND = (y, label) => ({ x: 250, y, w: 370, h: 90, label });
const PROFILE = [0, 1, 2, 3, 4, 5].map((i) => BAND(60 + i * 100, `y${60 + i * 100}`));

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
// Before the page loads, because every zone gate reads the save `Game.load` fetches once.
// 黄金屋 needs AR 18 and this file's token is usually a fresh guest, so without this the
// `enterZone` for it is refused and the probe measures 深渊试炼场's ceiling twice — the
// zone check below would catch it, as a FAIL that points at the streaming code.
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
  // Noon, pinned: the world clock moves the sun 15° a real minute, and every threshold in this
  // file was calibrated on the authored sky, which is exactly what daylight() returns at 12:00.
  window.game.setWorldTime(12);
});
await sleep(3000);
const tier = await p.evaluate(() => window.game.quality);
console.log('quality pinned ->', tier);
if (tier !== 'high') { console.log('tier did not pin; every shot would be at low'); await b.close(); process.exit(1); }

const shoot = async (file) => {
  await p.screenshot({ path: file });
  return decodePng(readFileSync(file));
};

for (const zone of zones) {
  console.log(`\n=== ${zone}`);
  if (hmr.length) {
    console.log('client/src was hot-updated mid-run — the shots from here are untrustworthy');
    break;
  }
  const info = await p.evaluate(async ([z, pitch]) => {
    const g = window.game;
    // Arena centre, not the spawn ring: the enclosure is a ring and the shot has to be
    // taken from inside it or the wall fills the frame from edge to edge.
    await g.enterZone(z, { x: 0, z: 0 });
    await new Promise((r) => setTimeout(r, 6000));
    g.rig.pitch = pitch;
    g.rig.yaw = 0;
    // Hide the avatar, *after* the zone change that rebuilt it. Pitching up puts the
    // camera below the character, so her shoulders and hair own the middle of the frame
    // and the first run of this probe measured a white sleeve as "ceiling std 59.5". The
    // bands below are deliberately the middle 60% of the width, which is exactly where
    // she stands.
    const a = g.me?.actor;
    const root = [a?.root, a?.group, a?.mesh, a?.obj].find((o) => o && o.isObject3D);
    if (root) root.visible = false;
    return {
      zone: g.zoneId, indoor: !!g.world.zone.indoor, y: +g.me.y.toFixed(1), q: g.quality,
      avatarHidden: !!root,
    };
  }, [zone, UP_PITCH]);
  console.log(' ', JSON.stringify(info));
  if (!check(`${zone}: the game is in the zone we asked for`, info.zone === zone, info.zone)) continue;
  check(`${zone}: is an indoor zone, so the vault shader is the sky`, info.indoor);
  check(`${zone}: the avatar is out of the way of the bands`, info.avatarHidden);

  await sleep(3000);
  const a = await shoot(`${outDir}/${zone}-up-0.png`);
  // The control. Yaw a quarter turn: if these two frames are identical, rAF is throttled
  // and every number below is one stale frame, not a measurement.
  await p.evaluate(() => { window.game.rig.yaw = Math.PI / 2; });
  await sleep(3000);
  const c = await shoot(`${outDir}/${zone}-up-1.png`);
  const moved = pixelsDiffering(a, c, 2);
  check(`${zone}: the camera is live (two yaws differ)`, moved > 2000, `${moved} px`);

  // Identify the surface instead of assuming it, by *hiding* it: the top band has to
  // change when the ceiling group goes away. This is the assertion the probe exists for.
  // It used to tint `uVaultCol` magenta and require the band to move, and the band moved
  // by 0 counts in all three zones — the ceiling shader was never on screen. What fills
  // the top of a dungeon frame is the height field, which `heightAt` ramps 44 m up
  // outside `terrain.arena.radius`, so the fix was geometry (`buildVaultCeiling`) and
  // this check is now: is that geometry what I am measuring?
  const swap = async (label, mutate) => {
    const undo = await p.evaluate(mutate);
    await sleep(2500);
    const img = await shoot(`${outDir}/${zone}-${label}.png`);
    if (undo) await p.evaluate(mutate);          // the mutator toggles, so run it twice
    return rectStats(img, PROFILE[0]);
  };
  const base = rectStats(c, PROFILE[0]);
  const noCeiling = await swap('no-ceiling', () => {
    const g = window.game.world.group.children.find((o) => o.name === 'ceiling');
    if (!g) return false;
    g.visible = !g.visible;
    return true;
  });
  // Hiding the terrain group is the other half of the identification, and it is the one
  // that caught the original mistake: whatever survives is architecture, whatever
  // vanishes was the ramp. With a real lid in place, the ramp must no longer be visible
  // at all — hiding it must change *nothing* up there.
  const noTerrain = await swap('no-terrain', () => {
    window.game.world.terrain.group.visible = !window.game.world.terrain.group.visible;
    return true;
  });
  await p.evaluate(() => { window.game.rig.yaw = 0; });
  // Per *channel*, not luma. 黄金屋's top band went [66,61,60] -> [86,57,37] when the
  // ceiling was hidden — a grey ceiling swapped for an orange ramp, i.e. a completely
  // different surface — and the luma of those two differs by 0.1, so a luma test called
  // it "the same pixels". Two colours agreeing on luma is a coincidence a probe has to
  // survive; the largest channel move is the thing that cannot be faked.
  const chan = (a, c) => Math.max(...[0, 1, 2].map((i) => Math.abs(a.rgb[i] - c.rgb[i])));
  const dCeil = chan(base, noCeiling);
  const dTerr = chan(base, noTerrain);
  console.log(`  top band: shot ${JSON.stringify(base.rgb)} · ceiling hidden ${JSON.stringify(noCeiling.rgb)}`
    + ` · terrain hidden ${JSON.stringify(noTerrain.rgb)}`);
  check(`${zone}: the top band is the ceiling geometry`, dCeil > 8,
    `channels move ${dCeil} when the ceiling is hidden, ${dTerr} when the terrain is`);
  check(`${zone}: the ceiling occludes the terrain ramp`, dTerr < 5,
    `hiding the height field moves the band by ${dTerr}`);
  await sleep(2500);

  const bands = PROFILE.map((r) => rectStats(a, r));
  for (const s of bands) {
    console.log(`  ${s.label.padEnd(5)} lum ${String(s.lum).padStart(5)} std ${String(s.std).padStart(5)}`
      + ` rgb ${JSON.stringify(s.rgb).padEnd(16)} p5..p95 ${s.p5}..${s.p95}`);
  }
  const ceil = bands[0], floor = bands[bands.length - 1];
  let step = 0, stepAt = '';
  for (let i = 1; i < bands.length; i++) {
    const d = Math.abs(bands[i].lum - bands[i - 1].lum);
    if (d > step) { step = d; stepAt = `${bands[i - 1].label}->${bands[i].label}`; }
  }

  // Per channel, for the reason this file already argues 30 lines up and then failed to
  // apply to itself: 深渊试炼场's vault is [11,14,54] against a fog of [20,20,42] — a
  // deeper, bluer violet, 12 counts apart in blue and 9 in red, and unmistakable in the
  // screenshot — but the *lumas* are 16.1 and 21.6, so a `|Δlum| > 6` test called the one
  // dungeon whose ceiling was never in doubt "the fog colour" and this probe stayed out of
  // check-all with a permanent red. A luma collision between two different colours is a
  // coincidence a probe has to survive, and the largest channel move is what cannot be
  // faked. Which of the two is brighter is a *data* question now, not a pixel one:
  // zoneGate.js requires an indoor zone's fog to sit in 0.30..1.0 of its vault colour.
  const fog = ZONES[zone].sky.fogColor;
  const fogRgb = [(fog >> 16) & 255, (fog >> 8) & 255, fog & 255];
  const dFog = Math.max(...[0, 1, 2].map((i) => Math.abs(ceil.rgb[i] - fogRgb[i])));
  check(`${zone}: looking up finds a ceiling, not the fog colour`, dFog > 6,
    `ceiling ${JSON.stringify(ceil.rgb)} vs fog ${JSON.stringify(fogRgb)}, biggest channel ${dFog}`);
  // A *pure* vault crop, so unlike the mixed rectangle a naive centre band gives, std here
  // is the ceiling's own texture and nothing else. Under ~4 is a flat wash; the tell for a
  // wash pretending to be detail is a narrow p5..p95 next to a big std, which cannot happen.
  check(`${zone}: the ceiling has form, not a flat wash`, ceil.std > 4,
    `std ${ceil.std}, p5..p95 ${ceil.p5}..${ceil.p95}`);
  check(`${zone}: dark above, lit below`, ceil.lum < floor.lum - 6,
    `ceiling ${ceil.lum} floor ${floor.lum}`);
  check(`${zone}: the frame has a ceiling line, not one continuous gradient`,
    step > 8, `biggest step ${step.toFixed(1)} at ${stepAt}`);
}

console.log('\nerrors ->', errs.length ? JSON.stringify([...new Set(errs)].slice(0, 6)) : 'none');
console.log('hmr    ->', hmr.length ? `${hmr.length} update(s) — RUN IS INVALID` : 'none');
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
// A green run has to have *counted* something: `check` returning nothing once let a whole
// section be skipped by an `if`, and the tally still said 0 failed.
if (pass + fail < zones.length * 10) {
  console.log(`only ${pass + fail} assertions ran for ${zones.length} zone(s) — expected ${zones.length * 10}`);
  process.exit(1);
}
process.exit(fail ? 1 : 0);
