// Walk the scene graph of every zone looking for geometries with non-finite vertex data.
//
// A single NaN in a position buffer does not draw a wrong triangle — it collapses the whole
// draw's bounding sphere, so the object flickers in and out with the frustum cull and the mesh
// looks like it is "sometimes not there". That is why this is worth a probe of its own: the
// symptom never points at the arithmetic that produced it.
//
// It used to print `JSON.stringify(bad)` and exit 0 no matter what. Two ways that lies:
//
//  1. `[]` is what a *broken boot* prints too. If the guest click misses, or `window.game` is
//     never assigned, `scan` covers nothing and an empty result reads as a clean bill of
//     health. So the scan now reports how many attributes it actually looked at and fails when
//     that number is zero — the same rule `tools/check-all.mjs` applies to every probe.
//  2. It only ever looked at the boot zone. Terrain, props and enemies are generated per zone,
//     which is where the NaN would come from, so five of the six zones were never scanned.
//     It now warps through all of them and verifies the transition took before scanning —
//     otherwise the report names a zone it never visited, which is the bug `tour.mjs` was
//     rewritten to stop making.
//  3. Four of those zones are rank-gated, so scanning all six needs an account that can enter
//     them (see tools/lib/account.mjs). The first all-zone run reported four FAILs reading
//     "the transition took — in mondstadt", which is what the refusal looks like from here and
//     also what a broken zone stream looks like. The rank is raised *before* the page loads,
//     because every gate reads a save that is fetched once at boot. If the hook is missing the
//     gated zones are SKIPPED by name with the reason printed — never quietly dropped — and one
//     summary assertion fails, so a run that scanned two zones can never be confused with a run
//     that scanned six. An exemption without an obligation is how "all passed" starts lying.
//
//   DISPLAY=:99 node tools/nan-scan.mjs [http://127.0.0.1:5173] [http://127.0.0.1:8787]
//
// Exit code is the number of failures.

import puppeteer from 'puppeteer';
import { zoneById, zoneEntryRank } from '../shared/src/data/zones.js';
import { guestAtRank } from './lib/account.mjs';

const base = process.argv[2] || process.env.GAME_APP || 'http://127.0.0.1:5173';
const api = process.argv[3] || process.env.GAME_API || 'http://127.0.0.1:8787';
const ZONES = ['mondstadt', 'dragonspine', 'liyue', 'abyssTrial', 'frostCavern', 'goldenHall'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, skipped = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  cond ? pass++ : fail++;
  return cond;
};
const skip = (name, why) => { console.log(`  SKIP ${name} — ${why}`); skipped++; };

// The account is minted and levelled before the browser starts: `Game.load` fetches
// `/api/player/state` once, and the client, localSocket and gateway all keep that copy.
const needRank = Math.max(...ZONES.map((z) => zoneEntryRank(zoneById(z))));
const acct = await guestAtRank(api, needRank);
console.log(`account ${acct.playerId} → AR ${acct.rank ?? '?'} (need ${needRank} for ${ZONES.length} zones)`
  + `${acct.rankOk ? '' : ` — ${acct.rankReason}`}`);

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: { 'webgl.force-enabled': true, 'webgl.disable-fail-if-major-performance-caveat': true },
  defaultViewport: { width: 1280, height: 720 },
});
const p = await b.newPage();
const errors = [];
const hmr = [];
p.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
p.on('console', (m) => {
  const t = m.text();
  if (/\[vite\].*(hot updated|hmr update|page reload)/i.test(t)) hmr.push(t);
});

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Hand the page the levelled account rather than clicking 「立即游玩」, which would mint a
  // fresh AR 1 guest and put four zones back out of reach.
  await p.evaluate((t) => localStorage.setItem('teyvat.token', t), acct.token);
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  // 「继续冒险」 sits in the DOM inside a `hidden` row until a token is stored, and with no token
  // that path lands in 「登录状态已失效」 and never builds a scene to scan. Checking `hidden` keeps
  // the probe honest about which door it went through.
  const door = await p.evaluate(() => {
    const resume = document.querySelector('[data-row="resume"]');
    const act = resume && !resume.hidden ? 'resume' : 'guest';
    document.querySelector(`[data-act="${act}"]`).click();
    return act;
  });
  check('the injected token puts the boot screen on 继续冒险', door === 'resume',
    `clicked ${door}${door === 'guest' ? ' — this account is not the one that was levelled' : ''}`);
  for (let i = 0; i < 90; i++) {
    if (await p.evaluate(() => !!window.game?._running).catch(() => false)) break;
    await sleep(1000);
  }
  check('the world booted', await p.evaluate(() => !!window.game?._running));

  // Geometry generation is tier-dependent (scatter density, terrain detail, LOD rings), so the
  // buffers scanned here have to be the ones the target hardware builds, not llvmpipe's `low`.
  await p.evaluate(() => {
    window.game.setAutoQuality(false);
    window.game.setQuality('high');
    // Noon, pinned: see daylight-check.mjs — the authored sky is what 12:00 returns.
    window.game.setWorldTime(12);
  });
  await sleep(2000);
  check('the quality tier is pinned to high', (await p.evaluate(() => window.game.quality)) === 'high');

  const EPOCH = `nan-${Date.now()}`;
  await p.evaluate((e) => { window.__nanEpoch = e; }, EPOCH);

  // What the account can actually enter. Reported once, up front, so a short run is never
  // mistaken for a clean one.
  const ar = await p.evaluate(() => window.game.player.adventureRank);
  check('the browser session sees the levelled rank', ar >= needRank || !acct.rankOk,
    `client AR ${ar}, need ${needRank}`);

  let attrs = 0, geoms = 0;
  const scanned = [];
  const found = [];
  for (const zone of ZONES) {
    const need = zoneEntryRank(zoneById(zone));
    if (ar < need) { skip(`${zone}: needs AR ${need}, account is AR ${ar}`, acct.rankReason || 'rank gate'); continue; }
    if (hmr.length) { check(`no HMR before ${zone}`, false, `${hmr.length} update(s) — run is invalid`); break; }
    const r = await p.evaluate(async (z, epoch) => {
      if (window.__nanEpoch !== epoch) return { fatal: 'the page reloaded mid-run' };
      const g = window.game;
      if (!g) return { fatal: 'window.game is undefined' };
      if (g.zoneId !== z) await g.enterZone(z, { x: 0, z: 14 });
      await new Promise((res) => setTimeout(res, 5000));
      const out = [];
      let a = 0, n = 0;
      const path = (o) => { const s = []; for (let q = o; q; q = q.parent) s.unshift(q.name || q.type); return s.join('/'); };
      g.scene.traverse((o) => {
        const geo = o.geometry;
        if (!geo?.attributes) return;
        n++;
        for (const [k, at] of Object.entries(geo.attributes)) {
          a++;
          const arr = at.array;
          let bad = 0, first = -1;
          for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) { bad++; if (first < 0) first = i; }
          if (bad) out.push({ obj: path(o), attr: k, count: bad, first, total: arr.length, type: o.type });
        }
      });
      return { zone: g.zoneId, geoms: n, attrs: a, bad: out };
    }, zone, EPOCH);

    if (r.fatal) { check(`${zone} could be scanned`, false, r.fatal); break; }
    // A report naming a zone it never entered is worse than no report.
    if (!check(`${zone}: the transition took`, r.zone === zone, `in ${r.zone}`)) continue;
    check(`${zone}: the scene has geometry to scan`, r.geoms > 20 && r.attrs > 60,
      `${r.geoms} geometries, ${r.attrs} attributes`);
    check(`${zone}: every vertex attribute is finite`, r.bad.length === 0,
      r.bad.map((x) => `${x.obj}.${x.attr} ${x.count}/${x.total}`).join(' | ') || 'clean');
    attrs += r.attrs; geoms += r.geoms;
    scanned.push(zone);
    found.push(...r.bad.map((x) => ({ zone, ...x })));
  }

  check('the scan covered something, so an empty result means clean and not broken',
    attrs > 400 && scanned.length > 0,
    `${geoms} geometries, ${attrs} attributes over ${scanned.length}/${ZONES.length} zones (${scanned.join(', ') || 'none'})`);
  // The gate the rank hook exists for: with it live this must be every zone, and the run that
  // scanned two of six has to be visibly different from the run that scanned all six.
  check('every zone was reachable, so the whole map was scanned', skipped === 0,
    skipped ? `${skipped} zone(s) skipped: ${ZONES.filter((z) => !scanned.includes(z)).join(', ')}` : 'all six');
  check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
  if (found.length) console.log(JSON.stringify(found, null, 1));
} catch (e) {
  check('the probe ran to the end', false, e.message);
} finally {
  await b.close();
}

console.log(`\nnan-scan: ${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail);
