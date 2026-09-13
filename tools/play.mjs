// Play harness: boots the game for real (guest login → world load) and drives a
// scripted sequence of clicks/keys, saving a screenshot after each step.
//
//   xvfb-run -a node tools/play.mjs [baseUrl] [outDir]
//
// Steps are declarative so a failure is easy to attribute: each one prints
// PASS/FAIL plus anything the page logged while it ran.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/play';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
    'media.autoplay.default': 0,
  },
  defaultViewport: { width: W, height: H },
});
const p = await b.newPage();

let logs = [];
const errors = [];
p.on('console', (m) => {
  const line = `[${m.type()}] ${m.text()}`;
  logs.push(line);
  if (m.type() === 'error') errors.push(line);
});
p.on('pageerror', (e) => { const l = `[pageerror] ${e.message}`; logs.push(l); errors.push(l); });
p.on('requestfailed', (r) => {
  const l = `[reqfail] ${r.url()} ${r.failure()?.errorText}`;
  logs.push(l);
  if (!/favicon/.test(r.url())) errors.push(l);
});

let step = 0;
async function shot(name) {
  step++;
  const file = `${outDir}/${String(step).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file });
  const drained = logs; logs = [];
  console.log(`\n=== ${step}. ${name} → ${file}`);
  if (drained.length) console.log(drained.slice(-25).join('\n'));
  return file;
}

async function click(sel, { wait = 600, optional = false } = {}) {
  const el = await p.$(sel);
  if (!el) {
    if (optional) { console.log(`  (skip, no ${sel})`); return false; }
    throw new Error(`no element ${sel}`);
  }
  await el.click();
  await sleep(wait);
  return true;
}

async function state() {
  return p.evaluate(() => {
    const g = window.game;
    const boot = document.getElementById('boot');
    return {
      bootHidden: boot?.classList.contains('hidden') ?? null,
      bootMsg: document.getElementById('boot-msg')?.textContent || '',
      hud: !!document.querySelector('.hud-br'),
      panel: document.querySelector('.panel h2')?.textContent || null,
      zone: g?.world?.zone?.id || null,
      running: !!g?._running,
      fps: g?.r?.fps ?? null,
      sock: g?.socket?.state || null,
      latency: g?.socket?.latency ?? null,
      enemies: g?.actors?.enemies?.size ?? null,
      remotes: g?.actors?.players?.size ?? null,
      pos: g?.me ? [Math.round(g.me.x), Math.round(g.me.z)] : null,
    };
  }).catch((e) => ({ evalError: e.message }));
}

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await shot('title');
  console.log('  state', JSON.stringify(await state()));

  // Guest login → world load. The load can take a while on llvmpipe.
  await click('[data-act="guest"]', { wait: 1200 });
  await shot('loading');
  for (let i = 0; i < 40; i++) {
    const s = await state();
    if (s.running) break;
    await sleep(1000);
  }
  await sleep(2500);
  await shot('world');
  console.log('  state', JSON.stringify(await state()));

  // Click-to-move: click a point on the ground below centre.
  await p.mouse.click(W * 0.5, H * 0.72);
  await sleep(2500);
  await shot('moving');
  console.log('  state', JSON.stringify(await state()));

  // Skills.
  await p.keyboard.press('KeyE'); await sleep(900);
  await shot('skill');
  await p.keyboard.press('KeyQ'); await sleep(1200);
  await shot('burst');

  // Panels, one key each.
  for (const [key, name] of [['KeyK', 'character'], ['KeyB', 'inventory'], ['KeyJ', 'quests'],
    ['KeyM', 'map'], ['KeyP', 'wish'], ['KeyO', 'party']]) {
    await p.keyboard.press(key);
    await sleep(1100);
    await shot(name);
    const s = await state();
    console.log(`  panel=${s.panel}`);
    await p.keyboard.press('Escape');
    await sleep(500);
  }

  // Chat.
  await p.keyboard.press('Enter'); await sleep(300);
  await p.keyboard.type('hello teyvat');
  await p.keyboard.press('Enter'); await sleep(800);
  await shot('chat');

  const s = await state();
  console.log('\nFINAL', JSON.stringify(s, null, 1));
  console.log(`\nerrors: ${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 40).join('\n'));
} catch (e) {
  console.log('\nHARNESS FAILURE:', e.message);
  await shot('failure').catch(() => {});
  console.log(errors.slice(0, 40).join('\n'));
} finally {
  await b.close();
}
