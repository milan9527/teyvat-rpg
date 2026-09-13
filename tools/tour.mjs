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

// A tour that could not enter a zone is a failed tour, not a shorter one: the shots on disk are
// the only evidence for those scenes and the missing ones are silently stale otherwise.
if (hmr.length || skippedZones.length || flatZones.length) process.exit(1);
