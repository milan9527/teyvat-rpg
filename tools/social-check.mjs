// 好友 / co-op probe: the friend panel and "join a friend's world", clicked through a
// real browser rather than asserted at the protocol level.
//
//   DISPLAY=:99 node tools/social-check.mjs [baseUrl] [outDir]
//
// `mp-check.mjs` already proves the gateway side of `JOIN_ZONE {follow}` (a stranger is
// refused, an offline friend is refused, a friend's shard and position are honoured).
// What it cannot prove is that a player can *get* there: that the panel lists the
// request, that 同意 turns into a friend row, that the row grows a 前往 button the
// moment the friend comes online, and that clicking it tears down the world and
// rebuilds it in their shard without throwing.
//
// The friend is a Node-side WebSocket, not a second browser: two WebGL contexts under
// llvmpipe run at ~1 fps each, and the friend does not need to *see* anything — it only
// needs to be a real player in a real shard, standing somewhere the follower is not.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { C2S, S2C } from '../shared/src/protocol.js';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/social';
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function rest(token, path, body) {
  const r = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, b: await r.json().catch(() => ({})) };
}

/* ------------------------------------------------------- the friend, in Node -- */

/** A minimal player: connects, tracks its own live position, can walk. */
async function friendClient(token) {
  const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
  const c = { ws, welcome: null, x: 0, z: 0, shard: null, zone: null };
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.t === S2C.WELCOME) {
      c.welcome = m.d; c.shard = String(m.d.shard); c.zone = m.d.zone;
      c.x = m.d.you?.x ?? 0; c.z = m.d.you?.z ?? 0;
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('friend socket refused')));
  });
  ws.send(JSON.stringify({ t: C2S.HELLO, d: { token, zone: 'mondstadt', mode: 'online' } }));
  for (let i = 0; i < 60 && !c.welcome; i++) await sleep(100);
  if (!c.welcome) throw new Error('friend never got a welcome');
  // Walk in steps the anti-teleport check accepts (MAX_SPEED * dt + 1.5 m per packet).
  c.walkTo = async (x, z) => {
    const x0 = c.x, z0 = c.z;
    for (let i = 1; i <= 14; i++) {
      const t = i / 14;
      ws.send(JSON.stringify({ t: C2S.INPUT, d: { x: x0 + (x - x0) * t, z: z0 + (z - z0) * t, y: 0, ry: 0, a: 2, st: 240 } }));
      await sleep(90);
    }
    c.x = x; c.z = z;
  };
  return c;
}

/* ------------------------------------------------------------------ browser -- */

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

let step = 0;
async function shot(name) {
  step++;
  const file = `${outDir}/${String(step).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file });
  const drained = logs; logs = [];
  console.log(`\n=== ${step}. ${name} → ${file}`);
  if (drained.length) console.log(drained.slice(-14).join('\n'));
}

/** The panel's rows, as the player sees them: nickname, subtitle, button labels. */
const rows = () => p.evaluate(() => [...document.querySelectorAll('.panel .list-row')].map((r) => ({
  nick: r.querySelector('b')?.textContent || '',
  sub: r.querySelector('small')?.textContent || '',
  buttons: [...r.querySelectorAll('button')].map((x) => x.textContent),
})));

/** Click the button whose label contains `label`, in the row named `nick`. */
const clickIn = (nick, label) => p.evaluate((n, l) => {
  const row = [...document.querySelectorAll('.panel .list-row')]
    .find((r) => r.querySelector('b')?.textContent === n);
  const btn = row && [...row.querySelectorAll('button')].find((x) => x.textContent.includes(l));
  if (!btn) return false;
  btn.click();
  return true;
}, nick, label);

// Read off the DOM rather than the Panels instance: `window.game` is the only handle
// main.js exports, and the panel's title is what the player is actually looking at.
const panelTitle = () => p.evaluate(() => document.querySelector('.panel h2')?.textContent ?? null);

let friend = null;
try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await shot('title');

  // 多人在线 is the default mode, so the guest button is the whole login.
  await (await p.$('[data-act="guest"]')).click();
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  const me = await p.evaluate(() => ({
    running: !!window.game?._running, playerId: window.game?.playerId,
    mode: window.game?.mode, zone: window.game?.zoneId,
    x: window.game?.me?.x, z: window.game?.me?.z,
  }));
  check('online world booted', me.running === true && me.mode === 'online' && !!me.playerId,
    `player ${me.playerId} in ${me.zone}`);
  await shot('world');

  // A stranger sends a friend request. Created here rather than in the browser because
  // the panel has to be shown data it did not write itself.
  const cAcc = await rest(null, '/api/guest', {});
  const cToken = cAcc.b.token, cNick = cAcc.b.nickname;
  const req = await rest(cToken, '/api/social/request', { playerId: me.playerId });
  check('a friend request reaches the account', req.status === 200 && req.b.state === 'pending',
    `${cNick} -> ${req.b.state}`);

  // U opens the panel; the keymap entry is part of what is being checked.
  await p.keyboard.press('KeyU');
  await sleep(1200);
  check('U opens the friend panel', (await panelTitle()) === '好友');
  let list = await rows();
  const incoming = list.find((r) => r.nick === cNick);
  check('the request is listed with accept/decline',
    !!incoming && incoming.buttons.some((x) => x.includes('同意')) && incoming.buttons.some((x) => x.includes('拒绝')),
    JSON.stringify(incoming || null));
  await shot('request');

  check('the accept button is clickable', await clickIn(cNick, '同意'));
  await sleep(1500);
  list = await rows();
  const offline = list.find((r) => r.nick === cNick);
  check('accepting turns it into a friend row', !!offline && !offline.buttons.some((x) => x.includes('同意')),
    JSON.stringify(offline || null));
  // Nothing to click on an offline friend: there is no shard to join and no socket to
  // invite through, so the buttons are absent rather than dead.
  check('an offline friend offers no world to join',
    !!offline && offline.sub.includes('离线') && !offline.buttons.some((x) => x.includes('前往')),
    offline?.sub);
  await shot('accepted');

  await p.keyboard.press('Escape');
  await sleep(600);
  check('Escape closes the panel', (await panelTitle()) === null);

  // The friend comes online and walks away from the spawn, so "beside them" is a
  // measurably different place from where the follower is standing.
  friend = await friendClient(cToken);
  await friend.walkTo(friend.x + 15, friend.z - 12);
  await sleep(800);
  check('the friend is in a live shard', !!friend.welcome && !!friend.shard,
    `${friend.zone}#${friend.shard} at ${friend.x.toFixed(0)},${friend.z.toFixed(0)}`);

  // The friend joined the shard the browser is already standing in, so the arrival is
  // announced in the chat log — and it has to name them. `S2C.PLAYER_JOIN` carries the
  // serialized entity (`{player:{id,n,…}}`), not flat `playerId`/`nickname` fields, and
  // reading the flat ones printed "undefined 进入了此区域" for every arrival.
  const chatlog = await p.evaluate(() => document.querySelector('.chatlog')?.textContent || '');
  check('the arrival is announced by name', chatlog.includes(`${cNick} 进入了此区域`),
    chatlog.slice(-120).replace(/\s+/g, ' '));
  check('and no chat line says undefined', !chatlog.includes('undefined'));

  await p.keyboard.press('KeyU');
  await sleep(1500);
  list = await rows();
  const online = list.find((r) => r.nick === cNick);
  check('an online friend shows their zone and a join button',
    !!online && !online.sub.includes('离线') && online.buttons.some((x) => x.includes('前往')),
    JSON.stringify(online || null));
  await shot('online');

  const before = await p.evaluate(() => ({ x: window.game.me.x, z: window.game.me.z }));
  check('the join button is clickable', await clickIn(cNick, '前往'));
  // The click closes the panel, runs the loading screen and rebuilds the world.
  for (let i = 0; i < 40; i++) {
    const st = await p.evaluate(() => ({ pend: window.game?._pendingZone ?? null, run: !!window.game?._running }));
    if (!st.pend && st.run) break;
    await sleep(700);
  }
  await sleep(2500);
  const after = await p.evaluate(() => ({
    zone: window.game?.zoneId, shard: String(window.game?.socket?.shard ?? ''),
    x: window.game?.me?.x, z: window.game?.me?.z, running: !!window.game?._running,
    others: window.game?.actors?.players?.size ?? null,
  }));
  const gap = Math.hypot(after.x - friend.x, after.z - friend.z);
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  console.log(`  travel: (${before.x.toFixed(0)},${before.z.toFixed(0)}) -> (${after.x.toFixed(0)},${after.z.toFixed(0)}), friend at (${friend.x.toFixed(0)},${friend.z.toFixed(0)})`);
  check('the world is still running after the jump', after.running && after.zone === friend.zone,
    `${after.zone} vs ${friend.zone}`);
  check('and in the friend\'s shard', after.shard === friend.shard,
    `${after.shard} vs ${friend.shard}`);
  check('the player actually moved', moved > 5, `${moved.toFixed(1)} m`);
  check('and landed beside the friend', gap < 8, `${gap.toFixed(1)} m apart`);
  check('the friend is rendered as a remote player', (after.others ?? 0) >= 1, `${after.others} others`);
  await shot('arrived');

  // And the symmetric line: the remote avatar is the only place the client still knows
  // who an id belonged to, so the departure has to be named before it is removed.
  friend.ws.close();
  friend = null;
  await sleep(2500);
  const gone = await p.evaluate(() => ({
    log: document.querySelector('.chatlog')?.textContent || '',
    others: window.game?.actors?.players?.size ?? null,
  }));
  check('the departure is announced by name', gone.log.includes(`${cNick} 离开了此区域`),
    gone.log.slice(-120).replace(/\s+/g, ' '));
  check('and the remote avatar is gone', (gone.others ?? 1) === 0, `${gone.others} others`);

  check('no page errors', errors.length === 0, errors.slice(0, 6).join(' | '));

  console.log(`\nsocial-check: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.log('\nHARNESS FAILURE:', e.message);
  await shot('failure').catch(() => {});
  console.log(errors.slice(0, 20).join('\n'));
  process.exitCode = 1;
} finally {
  try { friend?.ws.close(); } catch {}
  await b.close();
}
