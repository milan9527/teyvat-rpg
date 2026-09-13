// Smoke test for the AWS deployment, run from outside against the CloudFront domain.
//
//   node deploy/smoke.mjs https://dxxxxxxxx.cloudfront.net
//
// This is not a second copy of `tools/api-check.mjs` — the game logic is already covered by the
// 64 local probes. What only a deployed stack can be wrong about is the *path*: does the bundle
// come out of S3 with usable cache headers, does an HTTP API call survive a CDN behaviour that
// is allowed to cache, does a WebSocket survive CloudFront *and* the ALB in both directions,
// did the container get its database and its secrets, and is it really running as production.
//
// Exit code is the number of failed assertions.

import { C2S, S2C, PROTOCOL_VERSION } from '../shared/src/protocol.js';

const BASE = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(BASE)) {
  console.error('usage: node deploy/smoke.mjs https://<distribution>.cloudfront.net');
  process.exit(2);
}
const HOST = new URL(BASE).host;
const WSS = `${BASE.startsWith('https') ? 'wss' : 'ws'}://${HOST}/ws`;

const fails = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, init = {}) {
  const r = await fetch(BASE + path, init);
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json().catch(() => null) : await r.text();
  return { status: r.status, headers: r.headers, ct, body };
}

/* ------------------------------------------------------------------ the gateway is alive -- */

// CloudFront answers on first byte long before the origin does, so a failure here is about the
// ALB behaviour and the task, not about DNS.
const health = await req('/api/health');
ok('/api/health through CloudFront', health.status === 200,
  `${health.status} ${JSON.stringify(health.body).slice(0, 90)}`);
if (health.status !== 200) {
  console.log('\nthe origin is not answering; nothing below can pass. ./deploy/deploy.sh logs');
  process.exit(fails.length || 1);
}

ok('the server reports its own build', health.body?.protocol === PROTOCOL_VERSION,
  `protocol ${health.body?.protocol} vs ${PROTOCOL_VERSION}`);
// Redis has to be the real thing, not the in-process fallback: `entrypoint.sh` refuses to boot
// without REDIS_URL, but a URL that points at nothing would degrade quietly.
ok('the task is using ElastiCache, not the in-memory fallback', health.body?.redis === 'redis',
  `redis: ${health.body?.redis}`);

// The gate on this stack having no distribution-wide SPA error rewrite: an API error has to
// arrive as its own status code, not as index.html with 200. (A `CustomErrorResponses` entry
// mapping 403/404 to /index.html applies to *every* behaviour, including the ALB ones.)
const noAuth = await req('/api/player/state');
ok('an unauthenticated API call returns its status, not the SPA',
  noAuth.status === 401 && !String(noAuth.body).includes('<!doctype html'),
  `${noAuth.status} ${noAuth.ct}`);
const noRoute = await req('/api/nope');
ok('an unknown API route 404s as JSON', noRoute.status === 404 && noRoute.ct.includes('json'),
  `${noRoute.status} ${noRoute.ct}`);

/* ----------------------------------------------------------------- the bundle is served -- */

const index = await req('/');
ok('/ serves the client bundle from S3',
  index.status === 200 && index.ct.includes('text/html') && String(index.body).includes('<div id="app"'),
  `${index.status} ${index.ct} ${String(index.body).length} B`);
ok('CloudFront is in front of it (edge headers present)',
  !!index.headers.get('x-amz-cf-pop') || !!index.headers.get('x-cache'),
  `${index.headers.get('x-cache') || ''} ${index.headers.get('x-amz-cf-pop') || ''}`.trim());
// index.html names this deploy's fingerprinted chunks, so caching it is how a deploy half-lands:
// the browser keeps asking for last release's files, which the `--delete` sync just removed.
ok('index.html is not cached at the edge',
  /no-cache|no-store|max-age=0/i.test(index.headers.get('cache-control') || ''),
  `cache-control: ${index.headers.get('cache-control')}`);

const assets = [...String(index.body).matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
ok('index.html references fingerprinted assets', assets.length > 0, `${assets.length} found`);
const js = assets.find((a) => a.endsWith('.js')) || assets[0];
if (js) {
  const a1 = await req(js);
  ok('a hashed asset loads (OAC lets CloudFront read the private bucket)',
    a1.status === 200 && String(a1.body).length > 1000, `${js} -> ${a1.status}`);
  ok('...and is immutable for a year',
    /immutable/.test(a1.headers.get('cache-control') || ''),
    `cache-control: ${a1.headers.get('cache-control')}`);
}
// The bucket must not be reachable except through the distribution. `deploy.sh` passes the
// name; without it this cannot be tested, and a green line for an untested claim is worse than
// a missing one.
if (process.env.WEB_BUCKET) {
  const direct = await fetch(`https://${process.env.WEB_BUCKET}.s3.amazonaws.com/index.html`)
    .then((r) => r.status).catch(() => 0);
  ok('the bucket refuses reads that bypass CloudFront', direct === 403,
    `direct GET -> ${direct}`);
} else {
  console.log('SKIP the bucket refuses direct reads (no WEB_BUCKET in the environment)');
}

/* ------------------------------------------------------------- an account, then a socket -- */

const guest = await req('/api/guest', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
});
const token = guest.body?.token;
const playerId = guest.body?.playerId;
ok('guest signup writes to RDS', guest.status === 200 && !!token && !!playerId,
  `player ${playerId} ${guest.body?.nickname || ''}`);
if (!token) {
  console.log('\nno session; the database or the JWT secret never arrived. ./deploy/deploy.sh logs');
  process.exit(fails.length || 1);
}

const auth = { headers: { authorization: `Bearer ${token}` } };
const state = await req('/api/player/state', auth);
ok('the session reads back that player',
  state.status === 200 && Number(state.body?.player?.playerId) === Number(playerId),
  `AR ${state.body?.player?.adventureRank} · ${state.body?.player?.mora} 摩拉 · `
  + `${Object.keys(state.body?.player?.characters || {}).length} 角色`);

// A second call on the same token must return the same player — with Redis in front of Postgres,
// a cache that answered a cold miss with a different row would show up here.
const again = await req('/api/player/state', auth);
ok('a second read is the same player (cache and db agree)',
  Number(again.body?.player?.playerId) === Number(playerId));

// The proof that `NODE_ENV=production` reached the container: the dev hooks every local probe
// arms itself with must not exist on the internet. Sent *with* a session, so a 401 from the
// auth hook cannot be mistaken for a missing route.
const devHook = await req('/api/dev/rank', {
  method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' }, body: '{"rank":40}',
});
ok('dev test hooks are absent in production', devHook.status === 404,
  `POST /api/dev/rank -> ${devHook.status}`);

const log = [];
const by = new Map();
const got = (t) => by.get(t) || [];
const ws = new WebSocket(`${WSS}?token=${encodeURIComponent(token)}`);
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
  log.push(m);
  if (!by.has(m.t)) by.set(m.t, []);
  by.get(m.t).push(m.d);
});
const opened = await new Promise((res) => {
  ws.addEventListener('open', () => res(true));
  ws.addEventListener('error', () => res(false));
  setTimeout(() => res(false), 15000);
});
ok('the WebSocket upgrade survives CloudFront and the ALB', opened, WSS);

if (opened) {
  const waitFor = async (t, ms = 12000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (got(t).length) return got(t); await sleep(100); }
    return null;
  };
  ws.send(JSON.stringify({ t: C2S.HELLO, d: { token, zone: 'mondstadt', mode: 'online' } }));
  const welcome = (await waitFor(S2C.WELCOME))?.at(-1);
  ok('HELLO reaches the origin and is answered', !!welcome,
    welcome ? `zone ${welcome.zone} shard ${welcome.shard}` : 'no WELCOME in 12 s');
  ok('the deployed protocol matches this checkout',
    welcome?.protocol === PROTOCOL_VERSION, `${welcome?.protocol} vs ${PROTOCOL_VERSION}`);
  ok('the socket is bound to the same player', Number(welcome?.playerId) === Number(playerId),
    `${welcome?.playerId}`);

  // Two snapshots with a moving clock: one buffered frame proves the pipe, a clock that
  // advances proves the simulation is actually running in the task behind it.
  const first = (await waitFor(S2C.SNAPSHOT))?.at(-1);
  await sleep(1500);
  const later = got(S2C.SNAPSHOT).at(-1);
  ok('snapshots stream down the socket', !!first && got(S2C.SNAPSHOT).length > 3,
    `${got(S2C.SNAPSHOT).length} frames`);
  ok('the world clock advances (the sim is live, not a replay)',
    !!first && !!later && later.tick > first.tick && later.now > first.now,
    `tick ${first?.tick} -> ${later?.tick}, now ${first?.now} -> ${later?.now}`);
  ok('the shared world has content around the spawn',
    (later?.enemies?.length ?? 0) > 0 || (later?.npcs?.length ?? 0) > 0,
    `${later?.enemies?.length ?? 0} enemies, ${later?.npcs?.length ?? 0} npcs`);

  // Upstream direction: walk, and read the position back out of the server's own snapshot.
  // Everything above only shows the origin can talk *to* the browser.
  const me = () => got(S2C.SNAPSHOT).at(-1)?.players?.find((p) => Number(p.id) === Number(playerId));
  const start = me() || { x: welcome?.you?.x ?? 0, z: welcome?.you?.z ?? 0 };
  let x = start.x, z = start.z;
  for (let i = 0; i < 14; i++) {
    x += 1; z += 1;
    ws.send(JSON.stringify({ t: C2S.INPUT, d: { x, z, y: start.y ?? 0, ry: 0, a: 2, st: 240 } }));
    await sleep(90);
  }
  await sleep(800);
  const end = me();
  const moved = end ? Math.hypot(end.x - start.x, end.z - start.z) : 0;
  ok('input travels up the socket and moves the player server-side', moved > 8,
    `${moved.toFixed(1)} m`);
  ws.close();
}

console.log(`\n${fails.length ? 'FAILED' : 'PASSED'}: ${fails.length} failed`);
if (fails.length) for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length);
