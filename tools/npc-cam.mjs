// Does a villager's shirt read as cloth, or as bare skin?
//
//   DISPLAY=:99 node tools/npc-cam.mjs [zone ...] [--out /tmp/npccam]
//
// `client/src/gfx/humanoid.js` paints the upper torso and both upper arms in the body's
// `secondary` colour and the forearms, hands, neck and head in `skin`. Nothing draws an
// outline *inside* a silhouette, so the only thing holding the jacket/skin boundary
// together is the difference between those two albedos — and `NPC_PALETTE` in
// client/src/game/world.js hands out cream shirts to tan villagers. The palettes actually
// reachable by `hash2(...) % 5` are 0, 1 and 4, whose shirt-to-skin luminance gaps are
// 0.031, 0.141 and 0.029 in linear light; palettes 2 and 3 (0.235, 0.090) are never used.
//
// A material comparison in Node would be cheaper, but it cannot answer the question that
// matters: after the cel ramp, the fog, the tonemap and the grade, do the two areas still
// differ *on screen*? So this probe photographs each villager from the front and measures
// across the one boundary where the comparison is fair — the elbow. Shoulder→elbow is
// jacket, elbow→wrist is skin: two co-axial cylinders of the same radius at the same
// distance under the same light, so the count between them is albedo and little else.
// (Chest-versus-face is the read a player actually notices, and it is reported, but the
// face points every which way and would have the probe measuring light, not colour.)
//
// The controls are the load-bearing part. A rect that has drifted onto the ground, the sky
// or a neighbouring prop would happily report a large delta — the first run of this probe
// graded the liyue adeptus on a rect that was sitting in the water she stands in. So every
// villager is shot three times: as built, with their own jacket material forced to magenta,
// and with their own skin material forced to magenta. Then
//
//   the jacket tint must move the sleeve rect and leave the forearm rect alone,
//   the skin tint must move the forearm rect and leave the sleeve rect alone,
//
// which pins both rects to a named material from both directions. One-sided controls are
// not enough: "the jacket tint did not move it" is equally true of skin, grass and water.
// Both arms are measured and the arm with the stronger pair of controls is the one graded.
//
// Habits from the other probes
// here: pin the tier (llvmpipe boots every browser at `low`), decode the PNGs in-process
// (a second page steals focus and Firefox throttles rAF to a stale frame), stop the game
// loop before framing, drive `Sky.update` by hand afterwards, and hide the avatar.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { decodePng, rectStats, pixelsDiffering } from './lib/png.mjs';
import { zoneById, zoneEntryRank } from '../shared/src/data/zones.js';
import { raiseRank } from './lib/account.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/npccam'; })();
const zones = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
if (!zones.length) zones.push('mondstadt', 'liyue');
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
const chan = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// The gap a villager's shirt has to clear from their own skin, in sRGB bytes, recovered from
// the screen (see the ratio argument at the measurement below). It is the same number
// `buildHumanoid` enforces on the albedos — 48, from the palettes that read as clothed —
// less the ~6 bytes the recovery loses to the two surfaces not being lit *exactly* alike.
// With NPC_PALETTE taken at face value the four Mondstadt villagers recovered 34-59 and the
// smith read as bare-chested in the screenshot; the guard puts them at 46 and up.
const MIN_GAP = 42;

// How far switching the non-albedo light terms off has to move the graded forearm, in counts,
// for the fidelity row to be reading a frame where they were actually off. Measured 27-42 on
// the four mondstadt villagers; a frame the toggle never reached reads 0.
const AO_MOVE = 10;

const tokFile = '/tmp/world-token.txt';
let token = fs.existsSync(tokFile) ? fs.readFileSync(tokFile, 'utf8').trim() : '';
if (!token) {
  const r = await fetch(`${origin}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  token = (await r.json()).token;
  fs.writeFileSync(tokFile, token);
}

// Rank first, browser second: `Game.load` fetches the save once and every zone gate reads that
// copy, and `enterZone` answers a refusal with a toast. The liyue half of this probe sat behind
// that toast on a fresh AR 1 token, photographing mondstadt's villagers under liyue's name.
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const needRank = Math.max(...zones.map((z) => zoneEntryRank(zoneById(z)) || 1));
if (needRank > 1) {
  const rr = await raiseRank(API, token, needRank);
  console.log(`rank -> AR ${rr.rank ?? '?'} (${zones.join(', ')} need ${needRank})${rr.ok ? '' : ` — ${rr.reason}`}`);
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

// Everything below runs against a stopped loop, so the page needs no THREE: world
// positions come straight out of `matrixWorld.elements` and the projection is done by
// hand with the camera's own matrices (prop-cam.mjs borrows classes off live objects for
// the same reason — bare specifiers do not resolve in the page).
const PAGE = `
  const mulV = (e, x, y, z, w) => [
    e[0] * x + e[4] * y + e[8] * z + e[12] * w,
    e[1] * x + e[5] * y + e[9] * z + e[13] * w,
    e[2] * x + e[6] * y + e[10] * z + e[14] * w,
    e[3] * x + e[7] * y + e[11] * z + e[15] * w,
  ];
  window.__wpos = (o) => { const e = o.matrixWorld.elements; return [e[12], e[13], e[14]]; };
  window.__project = (cam, x, y, z, W, H) => {
    let v = mulV(cam.matrixWorldInverse.elements, x, y, z, 1);
    v = mulV(cam.projectionMatrix.elements, v[0], v[1], v[2], v[3]);
    return [(v[0] / v[3] * 0.5 + 0.5) * W, (1 - (v[1] / v[3] * 0.5 + 0.5)) * H];
  };
`;
await p.evaluate(PAGE);

const rows = [], skipped = [];
for (const zone of zones) {
  const setup = await p.evaluate(async (z) => {
    const g = window.game;
    const toasts = [];
    const offToast = g.on?.('toast', (t) => toasts.push(t?.text ?? String(t)));
    await g.enterZone(z, { x: 0, z: 0 });
    await new Promise((r) => setTimeout(r, 6000));
    offToast?.();
    const a = g.me?.actor;
    const root = [a?.root, a?.group, a?.mesh, a?.obj].find((o) => o && o.isObject3D);
    if (root) root.visible = false;
    g.stop();
    return {
      zone: g.player?.zone, toasts,
      avatarHidden: !!root,
      npcs: g.world.npcs.map((n) => ({ id: n.id, x: n.x, y: n.y, z: n.z })),
    };
  }, zone);
  console.log(`\n== ${zone}: ${setup.npcs.length} villagers ==`);
  // enterZone reports a refusal as a toast and resolves anyway, so without this row a zone the
  // server turned down photographs the previous zone's villagers under the new zone's name.
  if (!check(`${zone}: the world is in the zone it was asked for`, setup.zone === zone,
    `in ${setup.zone}${setup.toasts.length ? ` · ${JSON.stringify(setup.toasts)}` : ''}`)) continue;
  check(`${zone}: the avatar is hidden`, setup.avatarHidden);

  for (let i = 0; i < setup.npcs.length; i++) {
    // Frame the villager, then take three shots of the same frame: as built, with this
    // villager's jacket forced to magenta, and with their skin forced to magenta.
    // A fourth shot, `bare`, is the as-built frame with this villager's cloth-only and
    // enclosure-only light terms switched off; see the fidelity row below for why it exists.
    const shots = [];
    for (const tint of ['none', 'jacket', 'skin', 'bare']) {
      const info = await p.evaluate(([i, tint, W, H]) => {
        const g = window.game;
        const n = g.world.npcs[i];
        const cam = g.camera;
        n.rig.group.updateMatrixWorld(true);
        const chest = window.__wpos(n.rig.bones.chest);
        // Bones sit at joints, so a rect centred on `forearmR` straddles the elbow and
        // eats half a sleeve — which is exactly how the first run of this probe got the
        // forearm rect to move 52-63 counts when the jacket was tinted. Sample the
        // *middles* of the two segments instead: shoulder→elbow is jacket, elbow→wrist is
        // skin. Two co-axial cylinders of the same radius, the same distance and the same
        // light, one boundary apart: their difference is albedo and almost nothing else,
        // which is what makes a plain count threshold meaningful here.
        const mid = (a, c) => [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
        // Both arms. Which one gets measured is decided by the controls below, not here:
        // the liyue adeptus stands waist-deep in water that draws over one of her arms,
        // and an arm the probe cannot see is an arm it must not grade.
        const arms = ['L', 'R'].map((s) => ({
          s,
          sleeve: mid(window.__wpos(n.rig.bones[`arm${s}`]), window.__wpos(n.rig.bones[`forearm${s}`])),
          fore: mid(window.__wpos(n.rig.bones[`forearm${s}`]), window.__wpos(n.rig.bones[`hand${s}`])),
        }));
        // Villagers are turned to face the hub (`rig.group.rotation.y = atan2(-x, -z)`),
        // so their front is the direction back toward the origin. Stand there.
        const fl = Math.hypot(n.x, n.z) || 1;
        const fwd = [-n.x / fl, -n.z / fl];
        const dist = 3.0;
        cam.fov = 45;
        cam.position.set(chest[0] + fwd[0] * dist, chest[1] + 0.05, chest[2] + fwd[1] * dist);
        cam.lookAt(chest[0], chest[1], chest[2]);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
        g.world.sky.update(0.016, cam, chest[0], chest[1], chest[2]);
        const mat = n.rig.materials.matSecondary;
        const skinMat = n.rig.materials.matSkin;
        const shirtHex = mat.color.getHexString();
        const skinHex = skinMat.color.getHexString();
        const suspect = tint === 'jacket' ? mat : tint === 'skin' ? skinMat : null;
        const was = suspect?.color.getHex();
        if (suspect) suspect.color.setHex(0xff00ff);
        const terms = tint === 'bare'
          ? Object.values(n.rig.materials).flatMap((m) => [m?.userData?.toon?.uRigAo, m?.userData?.toon?.uFormShade])
            .filter(Boolean)
          : [];
        const termsWas = terms.map((u) => u.value);
        terms.forEach((u) => { u.value = 0; });
        for (let k = 0; k < 3; k++) g.r.render(0.016);
        if (suspect) suspect.color.setHex(was);
        terms.forEach((u, k) => { u.value = termsWas[k]; });

        // Rects, in pixels, from the projected bones. Scale comes from projecting a 10 cm
        // vertical offset at the same depth rather than from a trig identity, so it stays
        // right whatever the FOV and aspect end up being.
        const pc = window.__project(cam, chest[0], chest[1], chest[2], W, H);
        const pu = window.__project(cam, chest[0], chest[1] + 0.1, chest[2], W, H);
        const ppm = Math.abs(pu[1] - pc[1]) * 10;         // pixels per metre
        // Limb radius sets the rect: wide enough to average over the cel band across the
        // cylinder, narrow enough to stay off the silhouette and its outline shell.
        const r = n.rig.P.limbR;
        const rect = (px, halfW, halfH, label) => ({
          x: Math.round(px[0] - halfW), y: Math.round(px[1] - halfH),
          w: Math.max(4, Math.round(halfW * 2)), h: Math.max(4, Math.round(halfH * 2)), label,
        });
        const at = (wp, halfW, halfH, label) => {
          const px = window.__project(cam, wp[0], wp[1], wp[2], W, H);
          return rect(px, halfW * ppm, halfH * ppm, label);
        };
        return {
          id: n.id, shirt: shirtHex, skin: skinHex, ppm: +ppm.toFixed(1),
          termsOn: termsWas.filter((v) => v > 0).length,
          // Chest: reported, not asserted. The jacket band runs waist→shoulders, so a rect
          // a little below the chest bone is deep inside it and clear of the collar — but
          // the only skin near it is the face, whose surfaces point every which way, so a
          // chest-vs-face count would be measuring the light as much as the albedo.
          chest: rect([pc[0], pc[1] + 0.04 * ppm], 0.075 * ppm, 0.07 * ppm, 'chest'),
          arms: arms.map((a) => ({
            s: a.s,
            sleeve: at(a.sleeve, r * 0.55, r * 0.9, `sleeve${a.s}`),
            fore: at(a.fore, r * 0.45, r * 0.9, `fore${a.s}`),
          })),
        };
      }, [i, tint, W, H]);
      await sleep(1000);
      const file = `${outDir}/${zone}-${info.id}${tint === 'none' ? '' : `-${tint}`}.png`;
      await p.screenshot({ path: file });
      const img = decodePng(fs.readFileSync(file));
      shots.push({
        ...info, img, tint,
        chestS: rectStats(img, info.chest),
        armS: info.arms.map((a) => ({
          s: a.s, sleeve: rectStats(img, a.sleeve), fore: rectStats(img, a.fore),
        })),
      });
    }
    const [s, jm, sm, na] = shots;
    // Which arm to grade: the one whose two controls are both strongest. Tinting the
    // jacket must move that arm's sleeve rect and leave its forearm rect alone, and
    // tinting the skin must do the exact opposite. Picking by `min` of the two means an
    // arm only wins by being unambiguous on both halves.
    const scored = s.armS.map((a, k) => ({
      s: a.s,
      ctlSleeve: chan(a.sleeve.rgb, jm.armS[k].sleeve.rgb),
      ctlFore: chan(a.fore.rgb, sm.armS[k].fore.rgb),
      crossFore: chan(a.fore.rgb, jm.armS[k].fore.rgb),
      crossSleeve: chan(a.sleeve.rgb, sm.armS[k].sleeve.rgb),
      sleeve: a.sleeve, fore: a.fore,
    }));
    const arm = scored.reduce((a, x) =>
      Math.min(x.ctlSleeve, x.ctlFore) > Math.min(a.ctlSleeve, a.ctlFore) ? x : a);
    // Staleness first, and for every villager: the three shots differ only by the tint,
    // but they must differ — an identical pair means the second frame never rendered.
    const moved = [pixelsDiffering(s.img, jm.img, 2), pixelsDiffering(s.img, sm.img, 2)];
    check(`${zone}/${s.id}: the tinted frames are new frames`, moved[0] > 300 && moved[1] > 300,
      `${moved[0]} / ${moved[1]} px differ`);

    // A villager whose arms the probe cannot see is a villager the probe must not grade —
    // and the player cannot see them either. The liyue pair stand in water that draws over
    // their forearms, so the skin tint moves nothing there (3 and 12 counts).
    if (Math.min(arm.ctlSleeve, arm.ctlFore) < 40) {
      skipped.push(`${zone}/${s.id}`);
      console.log(`  ${s.id.padEnd(10)} SKIP — no arm passes both controls`
        + ` (best ${arm.s}: jacket moved the sleeve ${arm.ctlSleeve}, skin moved the forearm`
        + ` ${arm.ctlFore}); nothing on screen there to measure`);
      continue;
    }
    check(`${zone}/${s.id}: neither tint moves the other's rect`,
      arm.crossFore < 14 && arm.crossSleeve < 14,
      `jacket moved the forearm ${arm.crossFore}, skin moved the sleeve ${arm.crossSleeve}`);

    // Divide the light out. Sleeve and forearm are co-axial cylinders of the same radius
    // one boundary apart, so to a good approximation they carry the same illumination and
    // the per-channel *ratio* between them is the ratio of their albedos. Multiply that
    // ratio into the skin's known albedo and the shirt's albedo comes back out — measured
    // through the cel ramp, the fog, the tonemap and the grade. Raw counts cannot do this
    // job: grocer and smith wear the same two colours and measured 53 and 35 apart purely
    // because one of them stands in shadow.
    const lin = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    const enc = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
    const skinRgb = [0, 1, 2].map((k) => parseInt(s.skin.slice(k * 2, k * 2 + 2), 16));
    const shirtRgb = [0, 1, 2].map((k) => parseInt(s.shirt.slice(k * 2, k * 2 + 2), 16));
    const recover = (sleeve, fore) => [0, 1, 2].map((k) => Math.max(0, Math.min(255,
      enc(lin(skinRgb[k]) * lin(sleeve[k]) / Math.max(lin(fore[k]), 1e-4)))));
    const recovered = recover(arm.sleeve.rgb, arm.fore.rgb);
    const gap = Math.round(dist(recovered, skinRgb));
    // Except for two light terms the cylinders do *not* share. The baked contact shadow
    // (uRigAo, gfx/occlusion.js, bound in the rest pose) encloses a forearm hanging beside the
    // hip far more than the sleeve above it, and CLOTH_FORM (uFormShade) leans cloth, and only
    // cloth, darker inside its band. With both on the ratio handed back a shirt 29-59 bytes
    // too bright and too blue; with only the occlusion off, 24-35 bytes too dark. "Does the
    // material reach the screen" is a question about the colour pipeline, so it reads the
    // `bare` frame; "does the shirt read as skin" is a question about what the player sees, so
    // `gap` above keeps the as-built frame, every term on.
    const k = s.armS.findIndex((a) => a.s === arm.s);
    const bare = na.armS[k];
    const recoveredBare = recover(bare.sleeve.rgb, bare.fore.rgb);
    const fidelity = Math.round(dist(recoveredBare, shirtRgb));
    const aoMoved = chan(arm.fore.rgb, bare.fore.rgb);
    check(`${zone}/${s.id}: the non-albedo terms were on, and switching them off reached the arm`,
      na.termsOn > 0 && aoMoved >= AO_MOVE,
      `${na.termsOn} light terms were on, forearm moved ${aoMoved} (need ${AO_MOVE})`);
    const dArm = chan(arm.sleeve.rgb, arm.fore.rgb);
    const dChest = chan(s.chestS.rgb, arm.fore.rgb);
    // Contrast-to-noise: an albedo step is only an edge if it beats the shading variation
    // inside the two areas it separates. The cel ramp puts a band boundary somewhere on
    // every cylinder, so the std here is the real floor for "would a player see a seam".
    const noise = Math.max(arm.sleeve.std, arm.fore.std);
    const cnr = +(dArm / Math.max(noise, 1)).toFixed(2);
    rows.push({ zone, id: s.id, shirt: s.shirt, skin: s.skin, gap, fidelity, dArm, dChest, cnr, arm: arm.s });
    console.log(`  ${s.id.padEnd(10)} shirt #${s.shirt} skin #${s.skin}  arm ${arm.s}`
      + `  sleeve ${JSON.stringify(arm.sleeve.rgb)} std ${arm.sleeve.std}`
      + `  fore ${JSON.stringify(arm.fore.rgb)} std ${arm.fore.std}`
      + `  ->  shirt recovered #${recovered.map((v) => v.toString(16).padStart(2, '0')).join('')}`
      + `, bare #${recoveredBare.map((v) => v.toString(16).padStart(2, '0')).join('')}`
      + ` (off by ${fidelity}), gap ${gap}, raw ${dArm} (cnr ${cnr}), chest-vs-skin ${dChest}`);

    check(`${zone}/${s.id}: the screen agrees with the material`, fidelity <= 25,
      `recovered shirt albedo is ${fidelity} bytes from #${s.shirt}`);
    check(`${zone}/${s.id}: the shirt does not read as bare skin`, gap >= MIN_GAP && cnr >= 2,
      `${gap} bytes from skin through the pipeline, cnr ${cnr} (need ${MIN_GAP} and 2)`);
  }
}

check('most villagers were measurable', rows.length >= 4,
  `${rows.length} measured, ${skipped.length} skipped${skipped.length ? `: ${skipped.join(', ')}` : ''}`);
console.log('\n  worst-first:');
for (const r of [...rows].sort((a, x) => a.gap - x.gap)) {
  console.log(`   gap ${String(r.gap).padStart(3)} (raw ${String(r.dArm).padStart(3)},`
    + ` cnr ${String(r.cnr).padStart(5)})  ${r.zone}/${r.id}  shirt #${r.shirt} vs skin #${r.skin}`);
}
console.log('\nerrors ->', errs.length ? JSON.stringify([...new Set(errs)].slice(0, 6)) : 'none');
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
// Per zone: the avatar. Per villager: staleness, and for the measurable ones the cross-tint
// isolation, the fidelity of the recovery and the gap itself. Plus the coverage check.
const want = zones.length + 1 + rows.length * 4 + skipped.length;
if (pass + fail < want) { console.log(`only ${pass + fail} assertions ran — expected ${want}`); process.exit(1); }
process.exit(fail ? 1 : 0);
