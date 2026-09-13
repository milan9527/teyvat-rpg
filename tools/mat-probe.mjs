// Dump the toon uniforms actually in force on each prop batch.
//
// Written because a change that looked correct in three places at once did nothing on
// screen: `mottle` was plumbed into MATS.leafA/B/C, `uMottleSpeck` appeared four times in
// the built bundle, and the oak crown still photographed as flat uniform green. At that
// point every remaining explanation was a guess about which material object the batch
// really holds, and a 4-minute screenshot probe cannot distinguish them. This asks the
// renderer instead. No screenshots and no settling time, so it costs well under a minute.
//
//   DISPLAY=:99 node tools/mat-probe.mjs [zone] [namePattern]

import puppeteer from 'puppeteer';
import fs from 'node:fs';

const zone = process.argv[2] || 'mondstadt';
const pat = process.argv[3] || '';
const origin = 'http://127.0.0.1:5173';
const tokFile = '/tmp/teyvat-probe-token';

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
  defaultViewport: { width: 640, height: 480 },
});
const p = await b.newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message));

await p.goto(origin, { waitUntil: 'domcontentloaded' });
await p.evaluate((t) => localStorage.setItem('teyvat.token', t), token);
await p.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 5000));
await p.click('[data-act="resume"]');
for (let i = 0; i < 90; i++) {
  if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) break;
  await new Promise((r) => setTimeout(r, 1000));
}

const rows = await p.evaluate(async ([zn, pt]) => {
  const g = window.game;
  await g.enterZone(zn, { x: 0, z: 14 });
  await new Promise((r) => setTimeout(r, 6000));
  const out = [];
  for (const bt of g.world.propPool.batches.values()) {
    if (pt && !bt.name.includes(pt)) continue;
    const mat = bt.mesh.material;
    const u = mat?.userData?.toon;
    // Two separate questions, and the bug could be either: does the material carry the
    // uniform at all (was the option plumbed?), and has the shader been *compiled* with
    // the patch (`program` non-null means onBeforeCompile has run)?
    out.push({
      batch: bt.name,
      used: bt.used,
      vcol: mat?.vertexColors === true,
      hasColorAttr: !!bt.mesh.geometry.attributes.color,
      compiled: !!mat?.program,
      mottle: u?.uMottle?.value ?? null,
      scale: u?.uMottleScale?.value ?? null,
      speck: u?.uMottleSpeck?.value ?? null,
      rootDark: u?.uRootDark?.value ?? null,
    });
  }
  return out.sort((a, b2) => a.batch.localeCompare(b2.batch));
}, [zone, pat]);

console.log(`zone ${zone}  batches ${rows.length}`);
for (const r of rows) {
  console.log(
    `${r.batch.padEnd(26)} n=${String(r.used).padStart(4)}`,
    `mottle=${r.mottle} scale=${r.scale} speck=${r.speck} rootDark=${r.rootDark}`,
    `vcol=${r.vcol} colorAttr=${r.hasColorAttr} compiled=${r.compiled}`,
  );
}
await b.close();
process.exit(0);
