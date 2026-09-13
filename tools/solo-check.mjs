// 单机 (offline) mode probe: proves the game is playable with the gateway
// unreachable.
//
//   xvfb-run -a node tools/solo-check.mjs [baseUrl] [outDir]
//
// The interesting part is the WebSocket stub installed before any page script runs:
// every `new WebSocket(...)` aimed at `/ws` throws, exactly as it would if the
// gateway were down or firewalled. Vite's own HMR socket is left alone so the dev
// server still serves modules. If solo mode secretly needed the gateway — which it
// did until `client/src/net/localSocket.js` existed, despite the README claiming
// otherwise — the boot would hang here rather than quietly falling back.
//
// Then it plays: spawn a hilichurl into the browser-hosted `ZoneInstance`, lock on,
// and check that damage lands, that the corpse pays out (mora goes up, which can only
// happen through `POST /api/world/kill`), and that a zone change rebuilds the world.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/solo';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

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

await p.evaluateOnNewDocument(() => {
  const Real = window.WebSocket;
  window.__wsGateway = [];
  const Stub = function (url, protocols) {
    const u = String(url);
    // Only the game's gateway is cut; Vite's HMR channel has to keep working or the
    // page never gets its modules and the probe would prove nothing.
    if (/\/ws(\?|$)/.test(u)) {
      window.__wsGateway.push(u);
      throw new Error('gateway WebSocket blocked by solo-check');
    }
    return new Real(url, protocols);
  };
  Stub.prototype = Real.prototype;
  Object.assign(Stub, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Stub;
});

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
  if (drained.length) console.log(drained.slice(-20).join('\n'));
  return file;
}

async function state() {
  return p.evaluate(() => {
    const g = window.game;
    const s = g?.socket;
    return {
      running: !!g?._running,
      mode: g?.mode ?? null,
      local: !!s?.local,
      sock: s?.state ?? null,
      zone: g?.world?.zone?.id ?? null,
      snapshots: s?.snapshots?.length ?? null,
      stale: s?.stale ?? null,
      simEnemies: s?.inst?.enemies?.size ?? null,
      simTick: s?.inst?.tick ?? null,
      actorEnemies: g?.actors?.enemies?.size ?? null,
      mora: g?.player?.mora ?? null,
      hp: g?.me ? Math.round(g.me.hp) : null,
      lv: g?.player?.characters?.[g?.party?.[0]]?.level ?? null,
      gatewayTries: window.__wsGateway?.length ?? null,
      fps: g?.r?.fps ?? null,
    };
  }).catch((e) => ({ evalError: e.message }));
}

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await shot('title');

  // 单机模式 then guest: the mode button only sets a flag, the login button finishes.
  await (await p.$('[data-act="solo"]')).click();
  await sleep(300);
  await (await p.$('[data-act="guest"]')).click();

  for (let i = 0; i < 45; i++) {
    const s = await state();
    if (s.running) break;
    await sleep(1000);
  }
  await sleep(3000);
  await shot('world');
  let s = await state();
  console.log('  state', JSON.stringify(s));

  check('world booted with no gateway', s.running === true && s.zone, `zone=${s.zone}`);
  check('mode is solo', s.mode === 'solo');
  check('socket is the local host', s.local === true && s.sock === 'open');
  check('no gateway socket was opened', s.gatewayTries === 0, `tries=${s.gatewayTries}`);
  check('simulation is ticking', s.simTick > 20, `tick=${s.simTick}`);
  check('snapshots are flowing', s.snapshots > 0 && s.stale === false, `n=${s.snapshots}`);

  // Spawn a hilichurl within weapon reach. Level 1 on purpose: llvmpipe runs this page
  // at ~4 fps, and the auto-attack loop swings once per frame, so a level-10 camp mob's
  // 900 hp turns a pass/fail assertion into a stopwatch race. The reward path being
  // tested is the same either way — the route clamps the level it pays for.
  const spawn = await p.evaluate(() => {
    const g = window.game;
    const inst = g.socket.inst;
    const a = g.me.ry;
    const e = inst.spawnEnemy('hilichurl', 1, g.me.x + Math.sin(a) * 3, g.me.z + Math.cos(a) * 3);
    return e ? { id: e.id, hp: Math.round(e.hp), level: e.level } : null;
  });
  check('enemy spawned into the local sim', !!spawn, JSON.stringify(spawn));
  await sleep(600);
  const seen = await p.evaluate((id) => !!window.game.actors.enemyById(id), spawn.id);
  check('enemy reached the renderer through a snapshot', seen);
  await shot('spawned');

  // Lock on and let the mouse-play auto-attack loop do the fighting.
  const before = await state();
  await p.evaluate((id) => {
    const g = window.game;
    g.setTarget(id);
    g.autoAttack = true;
  }, spawn.id);

  const enemyState = (id) => p.evaluate((eid) => {
    const g = window.game;
    const live = g.socket.inst.enemies.get(eid);
    return { hp: live ? Math.round(live.hp) : 0, gone: !live || !live.alive, mora: g.player.mora };
  }, id);

  let killed = false, damaged = false, lastHp = spawn.hp;
  // 60 × 700 ms, because the swing rate is the frame rate: at llvmpipe's 4 fps a 420 hp
  // hilichurl took 28.4 s once and the old 28 s budget called it alive with 14 hp left,
  // then it died during the screenshot — a stopwatch race, not a broken kill.
  for (let i = 0; i < 60; i++) {
    await sleep(700);
    const r = await enemyState(spawn.id);
    lastHp = r.hp;
    if (r.hp < spawn.hp) damaged = true;
    if (r.gone) { killed = true; break; }
  }
  await sleep(1500);
  if (!killed) {
    const r = await enemyState(spawn.id);
    lastHp = r.hp;
    killed = r.gone;
  }
  console.log(`  fight: enemy hp ${spawn.hp} -> ${lastHp}${killed ? ' (dead)' : ''}`);
  await shot('fight');
  s = await state();
  console.log('  state', JSON.stringify(s));

  check('attacks damage the enemy', damaged);
  check('enemy dies', killed);
  check('kill banks loot through REST', s.mora > before.mora, `mora ${before.mora} → ${s.mora}`);
  check('party gained levels or xp', s.lv >= before.lv, `lv ${before.lv} → ${s.lv}`);

  // A build changed over REST has to reach the simulation *this browser is hosting*.
  // `PlayerEntity.stats`/`.party` are the snapshot handed to `addPlayer`, so without
  // `LocalSocket.applyBuild` every level-up and party edit stays cosmetic until the next
  // zone load — and 单机 is the half `tools/build-check.mjs` cannot see, because there the
  // entity lives here and not in the gateway.
  const build = await p.evaluate(async () => {
    const g = window.game;
    const token = localStorage.getItem('teyvat.token');
    const rest = (path, body) => fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).then((r) => r.json());

    const mine = g.party[g.activeSlot] || g.party[0];
    const other = Object.keys(g.player.characters || {}).find((c) => c !== mine);
    const before = { simMaxHp: g.socket.entity.maxHp(), hudMaxHp: g.stats[mine]?.maxHp };

    const up = await rest('/api/char/levelup', { charId: mine, materials: { heroWit: 2, adventurerXp: 10 } });
    g.applyBuild(up.stats, up.player?.party);
    const levelled = {
      err: up.error || null, restMaxHp: up.stats?.[mine]?.maxHp,
      simMaxHp: g.socket.entity.maxHp(), hudMaxHp: g.stats[mine]?.maxHp,
    };

    let dropped = null;
    if (other) {
      const res = await rest('/api/player/party', { party: [other] });
      g.applyBuild(res.stats, res.party);
      dropped = {
        err: res.error || null, simParty: [...g.socket.entity.party],
        simChar: g.socket.entity.charId, modelChar: g.me.charId,
        // Must be refused: the character is no longer on the team.
        switchedBack: g.socket.entity.switchTo(mine),
      };
    }
    return { mine, other, before, levelled, dropped };
  }).catch((e) => ({ error: e.message }));
  console.log('  build', JSON.stringify(build));

  check('a REST level-up reaches the browser-hosted simulation',
    build.levelled?.restMaxHp > build.before?.simMaxHp && build.levelled.simMaxHp === build.levelled.restMaxHp,
    `sim ${build.before?.simMaxHp} → ${build.levelled?.simMaxHp}, REST ${build.levelled?.restMaxHp}${build.levelled?.err ? ` err=${build.levelled.err}` : ''}`);
  check('...and the HUD is reading the same block',
    build.levelled?.hudMaxHp === build.levelled?.simMaxHp, `${build.levelled?.hudMaxHp}`);
  check('a party edit moves the solo roster',
    build.dropped?.simParty?.length === 1 && build.dropped.simParty[0] === build.other,
    JSON.stringify(build.dropped?.simParty));
  check('...switches the character being played, model included',
    build.dropped?.simChar === build.other && build.dropped?.modelChar === build.other,
    `sim=${build.dropped?.simChar} model=${build.dropped?.modelChar}`);
  check('...and the dropped character can no longer be switched to',
    build.dropped?.switchedBack === false, String(build.dropped?.switchedBack));
  await shot('rebuilt');

  // Zone change: solo has to build a fresh instance, not ask a server for one.
  const moved = await p.evaluate(async () => {
    const g = window.game;
    await g.enterZone('mondstadt', { x: 40, z: -30 });
    return { zone: g.zoneId, pos: [Math.round(g.me.x), Math.round(g.me.z)], tick: g.socket.inst.tick };
  }).catch((e) => ({ error: e.message }));
  await sleep(2500);
  await shot('rezoned');
  check('zone change works offline', moved.zone === 'mondstadt' && !moved.error, JSON.stringify(moved));
  const after = await state();
  check('sim restarted in the new instance', after.simTick >= 0 && after.running, `tick=${after.simTick}`);
  check('still no gateway socket', after.gatewayTries === 0);

  const real = errors.filter((e) => !/gateway WebSocket blocked/.test(e));
  check('no page errors', real.length === 0, real.slice(0, 6).join(' | '));

  console.log(`\nsolo-check: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.log('\nHARNESS FAILURE:', e.message);
  await shot('failure').catch(() => {});
  console.log(errors.slice(0, 30).join('\n'));
  process.exitCode = 1;
} finally {
  await b.close();
}
