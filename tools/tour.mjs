// Scene tour: warp into every zone, stand in the middle of it, and take four shots a
// quarter-turn apart. This is the only way to judge whether a zone actually *looks*
// like its description — a single screenshot from the spawn waypoint faces the arena
// wall and shows none of the landmarks the zone declares.
//
// Promoted out of /tmp because it is the project's regression gate and /tmp tools keep
// evaporating: a comment in gfx/props.js already cites a tools/pixstd.mjs that had been
// left behind in /tmp and therefore did not exist.
//
// It also now refuses to produce a misleading run, which is the more important change.
// The previous version had no failure branch anywhere: it polled 90 times for
// `window.game`, then walked into `g.enterZone` regardless and died with "g is
// undefined" — a message that says nothing about the cause. Worse, the run before *that*
// looked successful and was not. Its log read:
//
//   mondstadt   {"zone":"mondstadt",  ...,"draws":500,"tris":2952732}
//   dragonspine {"zone":"dragonspine",...,"draws":388,"tris":775390}
//   liyue       {"zone":"dragonspine",...,"draws":366,"tris":773814}
//   abyssTrial  {"zone":"dragonspine",...,"draws":366,"tris":773814}
//   frostCavern {"zone":"dragonspine",...,"draws":366,"tris":773814}
//
// Three zones in a row reporting `dragonspine` with byte-identical triangle counts, and
// then `window.game` gone. That reads exactly like a broken zone transition, and it was
// not one: Vite was hot-updating client/src underneath the probe, so `enterZone` was
// holding stale module state and silently no-opping, until one update escalated to a full
// page reload and cleared `window.game`. The screenshots on disk were of the wrong zone
// while claiming to be liyue.
//
// One more thing it now refuses to do: shoot at whatever tier the governor happened to
// land on. `engine/perf.js` guesses a tier from the renderer string, llvmpipe matches its
// software-rasteriser pattern, and the governor drops further within seconds of the first
// bad frame bucket — so on this box every tour ever shot was a `low` frame: uDetail 0.3
// (terrain clump/grain/fine and the near-field turf almost switched off), reduced scatter
// density, no shadows, no bloom, DPR 1.0. Judging "画面细腻" on those shots judged a frame
// the target hardware never displays, and that is exactly the mistake the last review made
// from /tmp/tour-*.png. So the tier is pinned to `high` by default (`--tier ultra` to go
// further, `--adaptive` for the old behaviour, which is still the right mode for asking
// "does the governor keep this zone above water"). The framerate line is then a software
// -renderer number *at a pinned tier* and says nothing about the target machine — which was
// already true, only now it is true on purpose.
//
// Hence the three assertions below. HMR is detected directly — the Vite client announces
// itself on the console, so any "[vite] hot updated" during a run aborts it — plus a
// window sentinel that a full reload wipes, plus a check that the zone we asked for is
// the zone we got. A probe that cannot fail is not a verification.
//
// And one thing it could not do at all until the rank hook existed: reach four of the six
// zones. 龙脊雪山 (AR 4), 冰封洞窟 (5), 璃月 (7) and 黄金屋 (18) are rank-gated in the client, in
// localSocket, in the gateway and in `/api/world/teleport`, and `/tmp/world-token.txt` is a
// fresh guest at AR 1 — so `enterZone` was refused and the run aborted with "the transition did
// not take", a message that points at the streaming code. The token's rank is now raised over
// `/api/dev/rank` before the page loads (it has to be before: every gate reads a save fetched
// once at boot), and when that hook is absent the unreachable zones are skipped by name with
// the reason printed, and the run still exits non-zero — a two-zone tour must never look like a
// six-zone one, because "细腻画面" is judged from exactly these files.
//
// The fourth assertion is about the pixels rather than the run: every zone's ground must not be
// featureless. That defect is the one this project keeps shipping — 龙脊雪山's snow, 黄金屋's floor
// and 深渊试炼's floor each spent a round as one flat tone with all of their authored detail
// computed and then thrown away by an exposure, a shader branch, or an inlay that mixed toward a
// bare colour. Every time, the shots were on disk and looked fine at a glance. So the tour now
// measures the same rectangle tools/pixstd.mjs would and fails on it.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { zoneById, zoneEntryRank } from '../shared/src/data/zones.js';
import { raiseRank } from './lib/account.mjs';
import { rectStats, fmtStat } from './lib/rectstats.mjs';
import { decodePng } from './lib/png.mjs';

// A patch of ground at the bottom of the frame, left of the character so it is not their back.
// 140x60 px there is roughly a metre and a half of floor at pitch 0.24.
const GROUND = { x: 150, y: 700, w: 140, h: 60, label: 'ground' };
// Bounded from both sides, in the units pixstd prints. The floor is the rule of thumb this repo
// measures by ("under ~4 sRGB over a metre-scale patch is genuinely featureless, 8-15 is normal
// ground"): 6.0 sits above anything that has ever read as broken and below every zone that has
// ever read as right, and leaves polished stone and snow — which legitimately carry less texture
// than turf — their headroom. The ceiling is not padding: over 34 the rectangle is on prop edges
// or a character and not on ground at all, so the assertion would be passing for a reason that
// has nothing to do with the floor. Both bounds are checked against the *median* of the four
// yaws, so one shot where a tree trunk or a wall crosses the rect cannot decide the zone.
const GROUND_MIN = 6.0, GROUND_MAX = 34.0;

// ---- and the same question about the *middle distance* -----------------------------------
// The rect above is 140x60 px at the bottom of the frame, which is a metre and a half of floor
// about eight metres out — inside the tuft carpet, and the carpet is what it measures. Hiding the
// carpet on a frozen Mondstadt frame (.run/ground-detail-lab.mjs) showed what the ground has
// without it: contrast (window std over window mean) of 2.3 % at 8 m and 3.5 % at 35 m, i.e. the
// terrain shader was leaving the meadow flat at *every* distance and the near field only looked
// right because 8.8 tufts/m2 were standing on it. Those tufts stop: `STREAM.grass` keeps a 3x3
// block of 24 m cells, measured 8.8/m2 out to 20 m, then 5.7, 3.4, 1.3, 0.3 and zero past 55 m.
// So the band below is the one where nothing was answering, and these are the assertions that
// keep it answered.
const MID = { lo: 25, hi: 40 };
// Contrast is read in a window of this width, in pixels, and the width is a band-pass rather
// than a quality setting: a 2.4 m clump 33 m away spans 36 px, so a 16 px window straddles less
// than half of one period and reports a fraction of its swing. 40 px asks about features of
// roughly a metre to three, which is the band between the tufts and the 13 m biome blotches.
const MID_WIN = 40;
// The *median* across headings, because one heading is not a measurement: swept round one spot the
// carpet-free band read 2.15, 4.75, 4.80, 5.36, 5.98 and 6.71 % (a 45-degree turn is worth more than
// the whole fix), so a bar anywhere near the top of that range is a coin toss. 3.0 sits under every
// median measured and well over the ~2 % a smooth sheet gives at this window.
const MID_MIN = 3.0;
// What turning `uNoiseStretch` off must cost, in mean absolute luma, pooled over every band pixel of
// every heading. This is the assertion that a term is *reaching the screen*. Per heading it ranged
// 1.48-8.00 luma at one spot and 1.52 at another, for a reason that is not a defect: `bare` has a
// ~48 m period, so a 15 m band either straddles its threshold window or sits in one lobe. Pooling
// several headings gives 3-4; the bar is under the *lowest single heading* seen, because a future
// edit that re-windows one of these terms against a threshold the field cannot reach — the exact
// defect this pass fixed, and one the file had already half-fixed once — drops it to nearly zero.
const MID_DELTA_MIN = 1.2;
// And what it must *not* cost: the stretch redistributes light rather than adding it, so the
// whole-frame exposure between the two ends of the axis stays put. Read as the worst of the
// headings, not their average, because a term that pays for contrast by brightening the ground
// would average out against one that darkens it. Measured 3.13 luma of about 128.
const MID_EXPOSURE_MAX = 5.0;
// How much of the band the chosen heading has to actually show. Every percentage above is a median
// over the band's rows, so a band that has collapsed onto a hillside 2.4 m deep is a reading about
// one patch of slope wearing the label "25-40 m" — which is how this pass first reported 2.61 %
// against the lab's 5.36 %. The lab's open-meadow view spans the full 15 m over 54 rows.
const MID_ROWS = 16;
const MID_DEPTH = 6.0;
// And how many of the eight headings have to clear that before the medians above are believed. Five
// of eight did at the lab's spot (the other three ran into a hillside at 27 m or saw no ground in
// the band at all), four of eight at the tour's.
const MID_VIEWS = 3;

const tok = fs.readFileSync('/tmp/world-token.txt', 'utf8').trim();
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const argv = process.argv.slice(2);
const ADAPTIVE = argv.includes('--adaptive');
const TIER_ARG = (() => {
  const i = argv.indexOf('--tier');
  return i >= 0 ? argv[i + 1] : 'high';
})();
const ZONES = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--tier');
if (!ZONES.length) ZONES.push('mondstadt', 'dragonspine', 'liyue', 'abyssTrial', 'frostCavern', 'goldenHall');

// Rank first, browser second.
const needRank = Math.max(...ZONES.map((z) => zoneEntryRank(zoneById(z))));
const rankRes = await raiseRank(API, tok, needRank);
console.log(`rank   -> AR ${rankRes.rank ?? '?'} (need ${needRank})${rankRes.ok ? '' : ` — ${rankRes.reason}`}`);
const skippedZones = [];
const shots = [];       // every screenshot written, in order
const shotZones = [];   // the zones that actually produced four shots

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: { 'webgl.force-enabled': true, 'webgl.disable-fail-if-major-performance-caveat': true },
  defaultViewport: { width: 1280, height: 800 },
});
const p = await b.newPage();
const errs = [];
// Anything Vite says about hot-updating a module while we are shooting invalidates the
// whole run, so it is collected separately from page errors rather than mixed in.
const hmr = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
p.on('console', (m) => {
  const t = m.text().slice(0, 250);
  if (/\[vite\].*(hot updated|hmr update|page reload)/i.test(t)) { hmr.push(t); console.log('[HMR]', t); }
  if (m.type() === 'error') { errs.push(t.slice(0, 200)); console.log('[err]', t); }
});

/** Abort loudly, after saying what to do about it. */
function die(msg, hint) {
  console.log(`\nTOUR ABORTED: ${msg}`);
  if (hint) console.log(`  ${hint}`);
  return b.close().then(() => process.exit(1));
}

await p.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' });
await p.evaluate((t) => localStorage.setItem('teyvat.token', t), tok);
await p.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 5000));
await p.click('[data-act="resume"]');
let up = false;
for (let i = 0; i < 90; i++) {
  if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) { up = true; break; }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!up) {
  await die('window.game never started running within 90 s',
    `page errors: ${errs.length ? JSON.stringify([...new Set(errs)].slice(0, 5)) : 'none'} — check ./tools/daemon.sh status`);
}
await new Promise((r) => setTimeout(r, 5000));

// Pin the tier before any zone is streamed, so every shot in the run is at one setting and
// it is the setting the game is meant to look like. Auto off first: with the governor live
// it steps back down within a few bad buckets and half the tour would be at another tier.
if (!ADAPTIVE) {
  await p.evaluate((t) => { window.game.setAutoQuality(false); window.game.setQuality(t); }, TIER_ARG);
  await new Promise((r) => setTimeout(r, 3000));
}
// And pin the hour, for the same reason and with more force: a tour is 24 shots over several
// minutes, the sun moves 15° a real minute, and the ground-detail and fog bands below were all
// calibrated against each zone's authored `sky` block — which is precisely what `daylight()`
// returns at 12:00 (asserted per zone in tools/daylight-check.mjs). Without this the last zone in
// the run is photographed at a different time of day than the first.
await p.evaluate(() => window.game.setWorldTime(12));
const pinned = await p.evaluate(() => window.game.quality);
console.log(`quality -> ${pinned}${ADAPTIVE ? ' (adaptive: governor free to move)' : ' (pinned)'}`);
if (!ADAPTIVE && pinned !== TIER_ARG) {
  await die(`asked to pin ${TIER_ARG} but the renderer is at ${pinned}`,
    'every shot would be at a tier nobody asked for — check game.setQuality/_applyQuality');
}

// A full page reload wipes this; a partial hot-update does not, which is why the console
// watcher above is needed as well. Between them the two cover both HMR outcomes.
const EPOCH = `tour-${Date.now()}`;
await p.evaluate((e) => { window.__tourEpoch = e; }, EPOCH);

// The rank the *client* believes it has, which is the one `enterZone` checks — the http answer
// above only proves the row moved.
const clientAR = await p.evaluate(() => window.game.player.adventureRank);
console.log(`AR     -> ${clientAR} in the browser session`);

for (const zone of ZONES) {
  const need = zoneEntryRank(zoneById(zone));
  if (clientAR < need) {
    console.log(`${zone.padEnd(13)} SKIPPED — needs AR ${need}, this account is AR ${clientAR}`
      + `${rankRes.ok ? '' : ` (${rankRes.reason})`}`);
    skippedZones.push(zone);
    continue;
  }
  if (hmr.length) {
    await die(`client/src was hot-updated mid-run (${hmr.length} update(s)) — every shot from here is untrustworthy`,
      'nothing may edit client/src while a probe runs; stop ./tools/autorun.sh first, then re-run');
  }
  const info = await p.evaluate(async (z, epoch) => {
    if (window.__tourEpoch !== epoch) return { fatal: 'page reloaded mid-run (window.__tourEpoch lost)' };
    const g = window.game;
    if (!g) return { fatal: 'window.game is undefined' };
    await g.enterZone(z, { x: 0, z: 14 });
    await new Promise((r) => setTimeout(r, 6000));
    return {
      zone: g.zoneId, at: [Math.round(g.me.x), Math.round(g.me.z)], y: +g.me.y.toFixed(1),
      enemies: g.actors.enemies.size,
      // Landmarks are the fixed silhouette props; scattered flora streams per cell.
      landmarks: g.world.landmarks?.length ?? null,
      animated: g.world.animated?.length ?? null,
      draws: g.r.renderer.info.render.calls, tris: g.r.renderer.info.render.triangles,
      fps: Math.round(g.r.fps),
      // The tier in use, which under software rendering is not the tier that was asked
      // for: the quality governor is expected to have stepped down by now, and a tour that
      // did not report it would silently compare shots taken at different settings.
      q: g.quality,
    };
  }, zone, EPOCH);
  if (info.fatal) await die(`${zone}: ${info.fatal}`, 'a reload usually means Vite HMR — see the header');
  console.log(zone.padEnd(13), JSON.stringify(info));
  // The check the old version lacked: shots are named after the zone we *asked* for, so
  // if the transition did not take, the files on disk are actively lying about what they
  // show. That is worse than no shots at all.
  if (info.zone !== zone) {
    await die(`asked for ${zone} but the game is in ${info.zone} — the transition did not take`,
      'shots would be filed under the wrong zone; fix the transition (or the HMR) before trusting any of them');
  }
  for (let k = 0; k < 4; k++) {
    await p.evaluate((yaw) => { window.game.rig.yaw = yaw; window.game.rig.pitch = 0.24; }, k * Math.PI / 2);
    await new Promise((r) => setTimeout(r, 2500));
    await p.screenshot({ path: `/tmp/tour-${zone}-${k}.png` });
    shots.push(`/tmp/tour-${zone}-${k}.png`);
  }
  shotZones.push(zone);
  // The pin has to hold for the whole zone, not just at boot: a shot taken after a silent
  // step-down is the same lie as a shot of the wrong zone.
  const qNow = await p.evaluate(() => window.game.quality);
  if (!ADAPTIVE && qNow !== TIER_ARG) {
    await die(`${zone}: tier slipped from ${TIER_ARG} to ${qNow} during the shots`,
      'the four shots of this zone are not comparable with the rest — see setAutoQuality');
  }
  // After the shots, not before: the ten seconds of yawing is the only stretch of the run
  // where the governor is out of its post-transition settle window and actually deciding.
  console.log('  '.padEnd(13), JSON.stringify({
    fps: await p.evaluate(() => Math.round(window.game.r.fps)),
    gov: await p.evaluate(() => window.game.governor.report()),
  }));
}

// ---- the middle distance, on a frozen frame ----------------------------------
// Inside the same browser session, because this needs to stop the loop, hide the tuft carpet and
// drive a uniform — none of which can be done from the PNGs. One outdoor zone, because the terms
// under test are in the shared terrain shader and this pass costs 15 captures over four headings;
// the per-zone `ground ->` gate below is what says the other five did not regress. On Dragonspine
// the terms are inert anyway (above the snow line the grass splat weight is ~0).
const mid = { ran: false, fail: [], note: null };
if (!hmr.length && shotZones.length) {
  const midZone = shotZones.includes('mondstadt') ? 'mondstadt'
    : shotZones.find((z) => !zoneById(z)?.indoor);
  if (!midZone) {
    mid.note = 'no outdoor zone in this tour';
  } else {
    // Two evaluates, not one: `enterZone` leaves the loop running (it restarts it as part of the
    // transition), so a `g.stop()` in the same call is undone a moment later and every frame below
    // is a live one — the chase camera puts itself back, the sway moves, and the first version of
    // this pass read 776254 px of "carpet" and 801335 px of "reversible".
    await p.evaluate(async (z) => {
      await window.game.enterZone(z, { x: 0, z: 14 });
      await new Promise((r) => setTimeout(r, 6000));
    }, midZone);
    const info = await p.evaluate(() => {
      const g = window.game;
      g.stop();
      for (const sel of ['[data-hud]', '#world-overlay']) {
        const el = document.querySelector(sel);
        if (el) el.style.display = 'none';
      }
      const V = (x, y, z2) => new g.camera.position.constructor(x, y, z2);
      // Level-ish and forward on an *absolute* heading: the chase camera spends most of the frame
      // on ground inside 15 m, which is the half of the range this section is not asking about,
      // and a heading taken from `camera.quaternion` is whichever way the last zone shot happened
      // to leave it — the reading would then depend on shot order.
      const c = g.camera;
      window.__aim = (yaw) => {
        const f = V(Math.sin(yaw), 0, -Math.cos(yaw));
        const gy = g.world.terrain.heightAt(g.me.x, g.me.z);
        c.position.set(g.me.x - f.x * 5, gy + 3.4, g.me.z - f.z * 5);
        c.lookAt(V(g.me.x + f.x * 40, gy + 3.4 - Math.tan(0.26) * 40, g.me.z + f.z * 40));
        c.updateMatrixWorld(true);
        // And draw it. Moving the camera of a *stopped* game changes nothing on screen: the canvas
        // keeps the last frame the running loop drew, from the chase camera. Without this the first
        // two captures were that stale frame — identical to each other, so the freeze check passed
        // — and the first real render happened inside the carpet toggle, which then measured a
        // camera move as 776446 px of grass.
        for (let i = 0; i < 3; i++) g.r.render(0.016);
        return +(yaw * 180 / Math.PI).toFixed(0);
      };

      // Row -> ground distance, by marching each row's own view ray against the height field.
      // Derived rather than assumed: a strip placed at a nominal "32 m" lands on whatever the
      // terrain happens to put there, and on rolling ground that was a hillside 60 px away.
      window.__rows = () => {
        const el = g.r.renderer.domElement;
        const terr = g.world.terrain;
        const out2 = [];
        for (let y = 0; y < el.clientHeight; y += 2) {
          const dir = V(0, -((y + 0.5) / el.clientHeight * 2 - 1), 0.5).unproject(c)
            .sub(c.position).normalize();
          if (dir.y > -1e-4) continue;
          let lo = 0, hi = 0, found = false;
          for (let t = 1; t <= 420; t += t < 60 ? 1 : 4) {
            if (c.position.y + dir.y * t <= terr.heightAt(c.position.x + dir.x * t, c.position.z + dir.z * t)) {
              hi = t; found = true; break;
            }
            lo = t;
          }
          if (!found) continue;
          for (let i = 0; i < 16; i++) {
            const m2 = (lo + hi) / 2;
            if (c.position.y + dir.y * m2 <= terr.heightAt(c.position.x + dir.x * m2, c.position.z + dir.z * m2)) hi = m2;
            else lo = m2;
          }
          out2.push({ y, d: +hi.toFixed(2) });
        }
        return out2;
      };
      // Hide the carpet, and put back exactly what was hidden so the control frame can be
      // bit-identical rather than nearly so.
      const hiddenTufts = [];
      window.__carpet = (on) => {
        let n = 0;
        if (!on) {
          hiddenTufts.length = 0;
          g.scene.traverse((o) => {
            if (o.isInstancedMesh && o.visible
              && /^(grassTuft|sweetFlower|mint|windwheelAster)/.test(o.name || '')) hiddenTufts.push(o);
          });
          for (const o of hiddenTufts) { o.visible = false; n++; }
        } else {
          for (const o of hiddenTufts) { o.visible = true; n++; }
        }
        for (let i = 0; i < 3; i++) g.r.render(0.016);
        return n;
      };
      window.__stretch = (v) => {
        const u = g.world.terrain.uniforms.uNoiseStretch;
        if (!u) return null;
        u.value = v;
        for (let i = 0; i < 3; i++) g.r.render(0.016);
        return u.value;
      };
      // uDetail multiplies two of the three clump consumers, so a tier the tour thinks it pinned
      // but a fresh zone's terrain rebuilt would show up here and nowhere else.
      const u = g.world.terrain.uniforms;
      const ld = g.world.sky?.lightDir;
      return { zone: g.zoneId, quality: g.quality, running: !!g._running,
        detail: u.uDetail?.value ?? null, at: [+g.me.x.toFixed(1), +g.me.z.toFixed(1)],
        sunEl: ld ? +(Math.atan2(ld.y, Math.hypot(ld.x, ld.z)) * 180 / Math.PI).toFixed(1) : null,
        fog: g.world.scene?.fog ? +g.world.scene.fog.density.toFixed(4) : null };
    });

    if (info.zone !== midZone) {
      await die(`the mid-field pass asked for ${midZone} and got ${info.zone}`,
        'the readings would be filed under the wrong zone');
    }
    const settled = async (tag) => {
      await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await new Promise((r) => setTimeout(r, 400));
      const f = `/tmp/tour-mid-${midZone}-${tag}.png`;
      await p.screenshot({ path: f });
      shots.push(f);
      return decodePng(fs.readFileSync(f));
    };
    const L = (im, i) => 0.2126 * im.data[i] + 0.7152 * im.data[i + 1] + 0.0722 * im.data[i + 2];
    // Derive the heading from what the section is about, instead of assuming any direction shows
    // 25-40 m of ground. Looking north from the Mondstadt spawn the view runs straight into a
    // rising hillside, so the ray hits it at 27.5 m and jumps to the crest: the whole 15 m band
    // collapsed onto a 2.4 m slice of slope, which read 2.61 % where open meadow reads 5.36 %.
    // Eight headings, take the one that puts the most ground in the band — deterministic given a
    // spawn point, and the per-yaw row counts are printed so a zone that has no such view says so.
    console.log('midfield: frame state', JSON.stringify(info));
    const YAWS = 8;
    const looks = [];
    for (let i = 0; i < YAWS; i++) {
      const yaw = i * Math.PI * 2 / YAWS;
      const deg = await p.evaluate((y) => window.__aim(y), yaw);
      const rs = await p.evaluate(() => window.__rows());
      const b = rs.filter((r) => r.d >= MID.lo && r.d < MID.hi);
      const ds = b.map((r) => r.d);
      looks.push({ yaw, deg, rows: rs, band: b,
        depth: b.length ? Math.max(...ds) - Math.min(...ds) : 0 });
    }
    // Deepest band first, and among comparable depths the one with the most rows: depth is what
    // makes the reading a statement about a range rather than about one patch.
    looks.sort((a, c2) => (c2.depth - a.depth) || (c2.band.length - a.band.length));
    console.log(`midfield: headings tried  ${looks.map((q) => `${q.deg}deg ${q.band.length}r/${q.depth.toFixed(1)}m`).join('  ')}`);
    // Every heading that shows the band, not just the best one, because one frame cannot measure
    // these terms. `bare` is fbm(xz * 0.021) — a ~48 m feature — so a 15 m band either straddles its
    // threshold window or sits inside one lobe of it, and swept across eight headings at one spot
    // the mean |delta| between the two ends of the axis read 1.48, 1.78, 2.22, 5.64 and 8.00 luma
    // with contrast between 2.15 % and 6.71 %. Every bar this pass first shipped was calibrated on
    // the luckiest of those eight and failed on the others (.run/ground-detail-lab.mjs prints the
    // sweep). So the assertions below are aggregates: a median across headings, and a delta pooled
    // over every band pixel of every heading.
    const valid = looks.filter((q) => q.band.length >= MID_ROWS && q.depth >= MID_DEPTH);
    const look = valid[0] ?? looks[0];
    const band = look.band;

    // Every helper first, then the captures: a `const` used above its own declaration in the same
    // block is a TDZ ReferenceError, and this block reads its own measurements as it goes.
    //
    // Contrast: median over MID_WIN-wide windows of (std / mean), median because a row that
    // clips a trunk or a rock is not a statement about ground.
    const contrast = (im, bd = band, W = MID_WIN) => {
      const x0 = Math.round(im.width * 0.18), x1 = Math.round(im.width * 0.82);
      const per = [];
      for (const r of bd) {
        const vals = [];
        for (let x = x0; x + W <= x1; x += W) {
          let s = 0, s2 = 0;
          for (let k = 0; k < W; k++) { const l = L(im, (r.y * im.width + x + k) * 4); s += l; s2 += l * l; }
          const m2 = s / W;
          if (m2 > 6) vals.push(Math.sqrt(Math.max(0, s2 / W - m2 * m2)) / m2 * 100);
        }
        if (vals.length) { vals.sort((a, c2) => a - c2); per.push(vals[Math.floor(vals.length / 2)]); }
      }
      if (!per.length) return null;
      per.sort((a, c2) => a - c2);
      return +per[Math.floor(per.length / 2)].toFixed(2);
    };
    // Sum and count rather than a mean, so several headings can be pooled into one reading instead
    // of averaging averages taken over different numbers of rows.
    const bandDelta = (a, c2, bd = band) => {
      const x0 = Math.round(a.width * 0.18), x1 = Math.round(a.width * 0.82);
      let s = 0, n = 0;
      for (const r of bd) {
        for (let x = x0; x < x1; x++) {
          const i = (r.y * a.width + x) * 4;
          s += Math.abs(L(a, i) - L(c2, i)); n++;
        }
      }
      return { s, n };
    };
    const meanLuma = (im) => {
      let s = 0, n = 0;
      for (let i = 0; i < im.data.length; i += 4) { s += L(im, i); n++; }
      return +(s / n).toFixed(2);
    };
    const differing = (a, c2, thr = 4) => {
      let n = 0;
      for (let i = 0; i < a.data.length; i += 4) if (Math.abs(L(a, i) - L(c2, i)) > thr) n++;
      return n;
    };
    const mc = (name, ok, detail) => {
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}  ${detail}`);
      if (!ok) mid.fail.push(name);
    };
    // The band's own description, printed whatever the verdict. A single contrast percentage cannot
    // be argued with: MID_WIN is a band-pass in *pixels*, so the same ground reads differently at a
    // different window or a different viewport, and 25-40 m of a hillside seen at a grazing angle is
    // not 25-40 m of open meadow. These three scales are what .run/ground-detail-lab.mjs prints.
    const describe = (im, other, bd, tag) => {
      const ds = bd.map((r) => r.d);
      const at = [12, MID_WIN, 120].map((W) => {
        const c = contrast(im, bd, W);
        return `${W}px ${c === null ? '—' : `${c} %`}`;
      });
      const dl = [];
      const x0 = Math.round(im.width * 0.18), x1 = Math.round(im.width * 0.82);
      for (const r of bd) {
        for (let x = x0; x < x1; x++) {
          const i = (r.y * im.width + x) * 4;
          dl.push(Math.abs(L(im, i) - L(other, i)));
        }
      }
      dl.sort((a, c2) => a - c2);
      console.log(`  ${tag}  ground ${Math.min(...ds).toFixed(1)}-${Math.max(...ds).toFixed(1)} m,`
        + ` contrast ${at.join(' ')},  axis moves p50 ${dl[dl.length >> 1].toFixed(1)}`
        + ` p95 ${dl[Math.floor(dl.length * 0.95)].toFixed(1)} max ${dl.at(-1).toFixed(1)} luma`);
    };

    await p.evaluate((y) => window.__aim(y), look.yaw);
    const before = await settled('01-carpet');
    // Before any diff is believed: two captures of a frame nobody touched. Everything below reads
    // differences of a few luma over a band, and a scene that is still moving swamps all of it —
    // the first version of this pass measured a live frame and called 76 % of it "carpet".
    const still = await settled('01b-still');
    const nTufts = await p.evaluate(() => window.__carpet(false));
    const bare1 = await settled('02-bare');
    // The axis, on every heading that has a band. The carpet stays hidden throughout: this is the
    // terrain shader answering alone, which is the whole question.
    const stretch0 = await p.evaluate(() => window.__stretch(0));
    await p.evaluate(() => window.__stretch(1));
    const sweep = [];
    if (stretch0 !== null) {
      for (const q of valid) {
        await p.evaluate((y) => window.__aim(y), q.yaw);
        const one = await settled(`10-${q.deg}deg-stretched`);
        await p.evaluate(() => window.__stretch(0));
        const zero = await settled(`11-${q.deg}deg-raw`);
        await p.evaluate(() => window.__stretch(1));
        const c1 = contrast(one, q.band), c0 = contrast(zero, q.band);
        sweep.push({ ...q, c1, c0, gain: c1 !== null && c0 !== null ? +(c1 - c0).toFixed(2) : null,
          d: bandDelta(one, zero, q.band), lum: [meanLuma(zero), meanLuma(one)] });
        describe(one, zero, q.band, `${String(q.deg).padStart(3)}deg`);
      }
    }
    // Back to the heading everything else was measured on, and prove the round trip: a 0-px diff
    // here says both that the axis restores and that `__aim` puts the camera back where it was.
    await p.evaluate((y) => window.__aim(y), look.yaw);
    const bare1b = await settled('04-bare-again');
    await p.evaluate(() => window.__carpet(true));
    const after = await settled('05-carpet-again');

    mid.ran = true;
    console.log(`midfield: ${midZone} at ${look.deg}deg, ${band.length} rows of ground between`
      + ` ${MID.lo} and ${MID.hi} m, ${nTufts} tuft mesh(es) hidden,`
      + ` uNoiseStretch axis ${stretch0 === null ? 'ABSENT' : 'present'}`);
    // The band has to be a range before any percentage taken over it means what it says, and there
    // have to be several of them before a median across headings means anything.
    mc(`the view actually shows ${MID.lo}-${MID.hi} m of ground`,
      valid.length >= MID_VIEWS,
      `${valid.length} of ${YAWS} headings clear ${MID_ROWS} rows and ${MID_DEPTH} m of depth`
      + ` (want >= ${MID_VIEWS}); deepest ${look.deg}deg, ${band.length} rows over`
      + ` ${look.depth.toFixed(1)} m`);
    mc('the frame is frozen before anything is measured',
      !info.running && differing(before, still) === 0,
      `loop ${info.running ? 'STILL RUNNING' : 'stopped'}, two untouched captures differ by`
      + ` ${differing(before, still)} px`);
    // The control that must move — bounded on both sides. Too little and every reading below is of
    // a frame the tufts were never in, so the "with the carpet hidden" claim is vacuous; too much
    // and the toggle is being credited with something else. A tuft carpet over a meadow paints
    // 13.2 % of the frame (.run/ground-detail-lab.mjs), and the 76 % this read before the render
    // above was added is the whole picture changing camera, which no amount of grass can do.
    const px = before.width * before.height;
    const painted = differing(before, bare1);
    mc('the tuft carpet paints the frame it is hidden from',
      painted > px * 0.02 && painted < px * 0.35,
      `${painted} px of ${px} (${(painted / px * 100).toFixed(1)} %, want 2-35)`);
    mc('hiding the carpet and showing it again is the same frame',
      differing(before, after) === 0, `${differing(before, after)} px`);
    if (stretch0 === null) {
      // Not a SKIP: every assertion below is about a term that only exists behind this axis, so a
      // build without it would report four fewer checks and still call itself green.
      mc('the mid field has a noise-stretch axis to mutate', false,
        'uNoiseStretch is absent from terrain.js — see fbmS in the fragment shader');
    } else {
      const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
      const cs = sweep.map((q) => q.c1).filter((c) => c !== null);
      const gains = sweep.map((q) => q.gain).filter((c) => c !== null);
      mc(`ground ${MID.lo}-${MID.hi} m carries contrast without the carpet`,
        cs.length > 0 && med(cs) >= MID_MIN,
        `median ${med(cs)?.toFixed(2)} % in a ${MID_WIN} px window over ${cs.length} headings`
        + ` [${cs.map((c) => c.toFixed(1)).join(' ')}] (want >= ${MID_MIN})`);
      // Pooled over every band pixel of every heading, which is the reading that does not depend on
      // where one 48 m noise lobe happened to fall.
      const s = sweep.reduce((a, q) => a + q.d.s, 0), n = sweep.reduce((a, q) => a + q.d.n, 0);
      const pooled = n ? s / n : 0;
      const up = gains.filter((c) => c > 0).length;
      mc('the stretched noise terms reach the screen there',
        pooled >= MID_DELTA_MIN && up > gains.length / 2,
        `${pooled.toFixed(2)} luma pooled over ${n} band px (want >= ${MID_DELTA_MIN}),`
        + ` and contrast rose on ${up}/${gains.length} headings`
        + ` [${gains.map((c) => c.toFixed(2)).join(' ')}]`);
      // Exposure on every heading, not just one: a term that pays for its contrast by brightening
      // the ground would show up as a one-sided shift here.
      const worst = sweep.reduce((a, q) => Math.max(a, Math.abs(q.lum[1] - q.lum[0])), 0);
      mc('and they redistribute light rather than adding it',
        worst <= MID_EXPOSURE_MAX,
        `worst whole-frame mean luma shift ${worst.toFixed(2)} of ${sweep.length} headings`
        + ` (want within ${MID_EXPOSURE_MAX})`);
      mc('the axis and the camera both restore the frame they started from',
        differing(bare1, bare1b) === 0, `${differing(bare1, bare1b)} px after ${sweep.length}`
        + ' headings and a round trip through uNoiseStretch');
    }
  }
}

console.log('shot   ->', `${ZONES.length - skippedZones.length}/${ZONES.length} zones`);
console.log('skipped->', skippedZones.length ? `${skippedZones.join(', ')} — RUN IS INCOMPLETE` : 'none');
console.log('errors ->', errs.length ? JSON.stringify([...new Set(errs)].slice(0, 8), null, 1) : 'none');
console.log('hmr    ->', hmr.length ? `${hmr.length} update(s) — RUN IS INVALID` : 'none');
await b.close();

// ---- ground detail, measured off the files just written ----------------------
// After the game browser is closed, deliberately. Opening a second page alongside a WebGL page
// backgrounds it, Firefox throttles its rAF, and the shots stop advancing — which has previously
// turned four pixel assertions into readings of one stale frame.
const ground = [];
if (shotZones.length) {
  const mb = await puppeteer.launch({ browser: 'firefox', headless: true });
  const mp = await mb.newPage();
  for (const zone of shotZones) {
    const stats = [];
    for (let k = 0; k < 4; k++) {
      const f = `/tmp/tour-${zone}-${k}.png`;
      const [s] = await rectStats(mp, fs.readFileSync(f), [{ ...GROUND, label: `${zone}-${k}` }]);
      stats.push(s);
    }
    const sorted = stats.map((s) => s.std).sort((a, v) => a - v);
    const med = +((sorted[1] + sorted[2]) / 2).toFixed(1);   // four samples: mean of the middle two
    const bad = med < GROUND_MIN ? 'featureless' : med > GROUND_MAX ? 'not on ground' : null;
    ground.push({ zone, med, bad });
    console.log(`  ${bad ? 'FAIL' : 'ok  '} ${zone.padEnd(13)} ground std median ${String(med).padStart(5)}`
      + ` of [${sorted.join(', ')}]  (want ${GROUND_MIN}..${GROUND_MAX})${bad ? ` — ${bad}` : ''}`);
    if (bad) for (const s of stats) console.log(`       ${fmtStat(s)}`);
  }
  await mb.close();
}
const flatZones = ground.filter((g) => g.bad).map((g) => `${g.zone}:${g.med}`);
console.log('ground ->', flatZones.length ? `${flatZones.join(', ')} — DETAIL REGRESSION` : `${ground.length} zone(s) within ${GROUND_MIN}..${GROUND_MAX}`);
// A pass that did not run is not a pass. It can only be skipped by a tour with no outdoor zone in
// it at all, which is a thing you have to ask for on the command line.
console.log('midfield->', mid.fail.length ? `${mid.fail.join(', ')} — MID-FIELD REGRESSION`
  : mid.ran ? `${MID.lo}-${MID.hi} m holds up with the carpet hidden`
    : `NOT RUN — ${mid.note || 'no reason recorded'}`);

// A tour that could not enter a zone is a failed tour, not a shorter one: the shots on disk are
// the only evidence for those scenes and the missing ones are silently stale otherwise.
if (hmr.length || skippedZones.length || flatZones.length || mid.fail.length) process.exit(1);
