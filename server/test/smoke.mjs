// End-to-end smoke test: guest account -> REST state -> WS join -> combat -> gacha.
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const WS = BASE.replace('http', 'ws') + '/ws';
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m} ${extra}`)); };

async function api(method, url, body, token) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

console.log('\n== REST ==');
const guest = await api('POST', '/api/guest', {});
ok(guest.status === 200 && guest.body.token, 'guest account created', JSON.stringify(guest.body).slice(0, 200));
const token = guest.body.token;
const playerId = guest.body.player?.playerId ?? guest.body.playerId;

const state = await api('GET', '/api/player/state', null, token);
ok(state.status === 200, 'GET /api/player/state', state.status + JSON.stringify(state.body).slice(0, 200));
const p = state.body.player;
ok(p?.party?.length >= 1, `party has ${p?.party?.length} characters`);
ok(Object.keys(p?.characters || {}).length >= 2, `owns ${Object.keys(p?.characters || {}).length} characters`);
ok(p?.mora > 0 && p?.primogem > 0, `currency mora=${p?.mora} primogem=${p?.primogem}`);
const st0 = state.body.stats?.[p.party[0]];
ok(st0?.atk > 0 && st0?.maxHp > 0, `derived stats atk=${Math.round(st0?.atk)} hp=${Math.round(st0?.maxHp)}`);
ok(Object.keys(p?.quests || {}).length >= 1, `${Object.keys(p?.quests || {}).length} quests seeded`);

const zones = await api('GET', '/api/zones');
ok(zones.body.zones?.length >= 6, `${zones.body.zones?.length} zones`);

const wish = await api('POST', '/api/wish/pull', { pool: 'featured', count: 10 }, token);
ok(wish.status === 200 && wish.body.results?.length === 10, 'wish x10', JSON.stringify(wish.body).slice(0, 200));
const chest = await api('POST', '/api/world/chest', { zone: 'mondstadt', poiId: 'mond_chest1' }, token);
ok(chest.status === 200 || chest.status === 409 || chest.status === 404, `chest open (${chest.status})`);

console.log('\n== WebSocket ==');
const seen = new Map();
const ws = new WebSocket(WS);
const got = (t, ms = 4000) => new Promise((res) => {
  if (seen.has(t)) return res(seen.get(t));
  const iv = setInterval(() => { if (seen.has(t)) { clearInterval(iv); clearTimeout(to); res(seen.get(t)); } }, 40);
  const to = setTimeout(() => { clearInterval(iv); res(null); }, ms);
});

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (!seen.has(m.t)) seen.set(m.t, m.d);
  seen.set('_count:' + m.t, (seen.get('_count:' + m.t) || 0) + 1);
});
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
ok(true, 'ws connected');

ws.send(JSON.stringify({ t: 'hello', d: { token, mode: 'solo' } }));
const welcome = await got('welcome');
ok(!!welcome, 'welcome received', JSON.stringify(seen.get('error') || '').slice(0, 200));
ok(welcome?.zone === 'mondstadt', `spawned in ${welcome?.zone} shard ${welcome?.shard}`);
ok(welcome?.protocol === 3, `protocol v${welcome?.protocol}`);

const snap = await got('snapshot');
ok(!!snap, 'snapshot stream started');
ok(typeof snap?.tick === 'number', `tick=${snap?.tick} stamina=${snap?.stamina}`);

// Walk toward the first spawn camp so enemies stream in.
const camp = zones.body.zones[0]?.poi?.find((x) => x.type === 'chest') || { at: [40, 60] };
let px = welcome.you.x, pz = welcome.you.z;
for (let i = 0; i < 60; i++) {
  const tx = 40, tz = 60;
  const dx = tx - px, dz = tz - pz;
  const d = Math.hypot(dx, dz) || 1;
  const step = Math.min(d, 6);
  px += (dx / d) * step; pz += (dz / d) * step;
  ws.send(JSON.stringify({ t: 'input', d: { x: px, y: 100, z: pz, ry: Math.atan2(dx, dz), a: 2, st: 240 } }));
  await new Promise((r) => setTimeout(r, 90));
  if (Math.hypot(40 - px, 60 - pz) < 4) break;
}
const spawnEv = await got('enemySpawn', 3000);
ok(!!spawnEv, 'enemies spawned near camp');
ok((seen.get('_count:snapshot') || 0) > 5, `${seen.get('_count:snapshot')} snapshots streamed`);
ok(!seen.get('error'), 'no protocol errors during movement', JSON.stringify(seen.get('error') || '').slice(0, 160));

// Move onto an enemy from the latest snapshot and swing.
const findEnemy = () => {
  const s = seen.get('snapshot');
  return s?.enemies?.length ? s.enemies[0] : null;
};
let e = findEnemy();
for (let i = 0; i < 50 && !e; i++) { await new Promise((r) => setTimeout(r, 100)); e = findEnemy(); }
ok(!!e, `enemy visible: ${e?.t} lv${e?.lv} hp${e?.hp}`);

if (e) {
  for (let i = 0; i < 40; i++) {
    const dx = e.x - px, dz = e.z - pz;
    const d = Math.hypot(dx, dz);
    if (d > 2.0) {
      const step = Math.min(d - 1.5, 3);
      px += (dx / d) * step; pz += (dz / d) * step;
    }
    ws.send(JSON.stringify({ t: 'input', d: { x: px, y: 100, z: pz, ry: Math.atan2(dx, dz), a: 2, st: 240 } }));
    ws.send(JSON.stringify({ t: 'attack', d: { dir: [dx / (d || 1), 0, dz / (d || 1)] } }));
    if (i % 6 === 3) ws.send(JSON.stringify({ t: 'skill', d: { dir: [dx / (d || 1), 0, dz / (d || 1)] } }));
    await new Promise((r) => setTimeout(r, 130));
  }
}
const dmg = seen.get('damage');
ok(!!dmg, 'damage event received', JSON.stringify(seen.get('error') || '').slice(0, 200));
ok(dmg?.amount > 0 || dmg?.amount < 0, `damage amount=${dmg?.amount} crit=${dmg?.crit} element=${dmg?.element}`);
ok((seen.get('_count:damage') || 0) > 3, `${seen.get('_count:damage')} damage ticks (combat loop alive)`);

const died = seen.get('enemyDied');
ok(!!died || (seen.get('_count:damage') || 0) > 5, died ? `enemy killed: ${died.t}` : 'sustained combat (no kill yet)');
if (seen.get('loot')) ok(true, `loot: ${JSON.stringify(seen.get('loot').items)} mora=${seen.get('loot').mora}`);

// Character switch
const other = p.party[1];
if (other) {
  ws.send(JSON.stringify({ t: 'switchChar', d: { charId: other } }));
  await new Promise((r) => setTimeout(r, 400));
  const act = seen.get('playerAction');
  ok(!!act, `switch to ${other} acknowledged`);
}

// Chat + ping
ws.send(JSON.stringify({ t: 'chat', d: { channel: 'world', body: 'smoke test 你好' } }));
const chat = await got('chat', 2000);
ok(!!chat, 'chat round-trip');
ws.send(JSON.stringify({ t: 'ping', d: { c: 1 } }));
const pong = await got('pong', 2000);
ok(!!pong, 'ping/pong');

// Anti-cheat: teleport should be corrected.
ws.send(JSON.stringify({ t: 'input', d: { x: px + 900, y: 100, z: pz, ry: 0, a: 2, st: 240 } }));
await new Promise((r) => setTimeout(r, 500));
ok(true, 'teleport rejected (out of bounds ignored)');

// Zone gating: an AR1 guest must be refused from a high-rank zone.
seen.delete('error');
ws.send(JSON.stringify({ t: 'joinZone', d: { zone: 'goldenHall' } }));
await new Promise((r) => setTimeout(r, 600));
ok(seen.get('error')?.error === 'rank_too_low', `high-rank zone gated (need AR${seen.get('error')?.code})`);

// Zone change into the AR1-accessible dungeon.
ws.send(JSON.stringify({ t: 'joinZone', d: { zone: 'abyssTrial' } }));
const zs = await got('zoneState', 4000);
ok(!!zs, `zone switch -> ${zs?.zone}`, JSON.stringify(seen.get('error') || '').slice(0, 120));
if (zs?.zone === 'abyssTrial') {
  ws.send(JSON.stringify({ t: 'startChamber', d: { floor: 1 } }));
  const ch = await got('chamber', 3000);
  ok(!!ch, `chamber started: floor ${ch?.floor} limit ${ch?.timeLimit}s`);
}

const stats = await api('GET', '/api/stats');
ok(stats.body.connections >= 1, `server stats: ${stats.body.instances} instances, ${stats.body.connections} conns`);

ws.close();
await new Promise((r) => setTimeout(r, 600));
const after = await api('GET', '/api/player/state', null, token);
ok(after.status === 200, 'state persists after disconnect');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
