// Screenshot harness: loads a page in Firefox+Xvfb with WebGL2 and saves a PNG.
import puppeteer from 'puppeteer';

const url = process.argv[2];
const out = process.argv[3] || '/tmp/shot.png';
const waitMs = Number(process.argv[4] || 6000);
const w = Number(process.argv[5] || 1280), h = Number(process.argv[6] || 720);

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: { 'webgl.force-enabled': true, 'webgl.disable-fail-if-major-performance-caveat': true },
  defaultViewport: { width: w, height: h },
});
const p = await b.newPage();
const logs = [];
p.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
p.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

await p.goto(url, { waitUntil: 'networkidle0', timeout: 60000 }).catch((e) => logs.push('[goto] ' + e.message));
await new Promise((r) => setTimeout(r, waitMs));
await p.screenshot({ path: out });
console.log(logs.slice(0, 60).join('\n'));
console.log('--- saved', out);
const diag = await p.evaluate(() => (window.__diag ? window.__diag() : null)).catch(() => null);
if (diag) console.log('DIAG', JSON.stringify(diag, null, 1));
await b.close();
