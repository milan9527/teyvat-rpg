// Does a build change reach the *running* simulation?
//
// Everything the game asks a player to do between two zone loads — level a character,
// ascend, raise a talent, equip a weapon, enhance an artifact, refine, edit the team — is
// an HTTP route that mutates the saved document. But the fight is run by a `PlayerEntity`
// whose `stats` and `party` were snapshots taken when the socket joined, so all of it used
// to be cosmetic until the next zone load: a starter 伊格纳 taken from Lv.1 to Lv.17
// (maxHp 1290 → 2460) kept fighting with 1290, and a character dropped from the team could
// still be switched to. This is the gate on that fix, in three parts:
//
//   1. `PlayerEntity.applyBuild` — the one place the rules live, so both hosts agree.
//   2. Static: every door is used, and nobody bypasses it (server *and* client).
//   3. Live: a real socket, real REST calls, and assertions on what the gateway pushes.
//
//   DISPLAY unnecessary; node tools/build-check.mjs [host]
//
// Exit code is the number of failed assertions.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PlayerEntity } from '../shared/src/world/entity.js';
import { C2S, S2C } from '../shared/src/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.argv[2] || '127.0.0.1:8787';
const fails = [];
const skips = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fails.push(name);
};
const skip = (name, why) => { console.log(`skip ${name}  ${why}`); skips.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/* ------------------------------------------------ 1. the rule, on the entity -- */

console.log('\n-- PlayerEntity.applyBuild --');

const statsOf = (spec) => Object.fromEntries(
  Object.entries(spec).map(([c, hp]) => [c, { maxHp: hp, atk: 100, def: 50, critRate: 0.05, critDmg: 0.5, er: 1 }]));

function entity(party, spec, active = party[0]) {
  const save = { playerId: 1, nickname: 't', party: [...party], activeSlot: party.indexOf(active), pos: { x: 0, y: 0, z: 0 }, zone: 'mondstadt' };
  return new PlayerEntity(1, 't', save, statsOf(spec));
}

{
  // A level-up: the ceiling rises and the character keeps the hp they were fighting with.
  const e = entity(['lyra', 'ignar'], { lyra: 1000, ignar: 1290 }, 'ignar');
  e.hp = 700;
  const r = e.applyBuild(statsOf({ lyra: 1000, ignar: 2460 }));
  ok('a level-up raises maxHp and keeps current hp', e.maxHp() === 2460 && e.hp === 700, `maxHp ${e.maxHp()} hp ${e.hp}`);
  ok('...and reports the new ceiling to the caller', r.maxHp === 2460 && r.switched === false);
}
{
  // A build that *lowers* the ceiling (unequipping a weapon) must not leave hp above it.
  const e = entity(['lyra'], { lyra: 2000 });
  e.hp = 2000;
  e.applyBuild(statsOf({ lyra: 1200 }));
  ok('a weaker build clamps hp to the new maxHp', e.hp === 1200, `hp ${e.hp}`);
}
{
  // Dropping the character you are controlling has to move you off them.
  const e = entity(['lyra', 'ignar'], { lyra: 1000, ignar: 1290 }, 'lyra');
  const r = e.applyBuild(statsOf({ lyra: 1000, ignar: 1290 }), ['ignar']);
  ok('dropping the active character switches to a live one', r.switched && e.charId === 'ignar', e.charId);
  ok('...and the dropped character can no longer be switched to', e.switchTo('lyra') === false);
  ok('...and their energy and hp are forgotten', e.energy.lyra === undefined && e.hpByChar.lyra === undefined);
}
{
  // Adding one is the other half — this is what `switchTo` used to refuse forever.
  const e = entity(['ignar'], { lyra: 1000, ignar: 1290 });
  e.applyBuild(statsOf({ lyra: 1000, ignar: 1290 }), ['ignar', 'lyra']);
  ok('a character added to the team becomes switchable', e.switchTo('lyra') === true);
  ok('...and arrives at full health', e.hp === 1000, `hp ${e.hp}`);
}
{
  // Only characters with a stat block can be fought with; an unusable roster keeps the old
  // team rather than leaving the player with nobody to control.
  const e = entity(['lyra', 'ignar'], { lyra: 1000, ignar: 1290 }, 'lyra');
  e.applyBuild(statsOf({ lyra: 1000, ignar: 1290 }), ['nobody']);
  ok('a roster with no stat blocks is ignored', e.party.join(',') === 'lyra,ignar', e.party.join(','));
}
{
  // The level-up top-up, and the one thing it must not do.
  const e = entity(['lyra', 'ignar'], { lyra: 1000, ignar: 1290 }, 'lyra');
  e.hp = 400;
  e.hpByChar.ignar = 0;
  e.applyBuild(statsOf({ lyra: 1000, ignar: 1290 }), null, { heal: 200 });
  ok('a level-up heals a little', e.hp === 600, `hp ${e.hp}`);
  ok('...but never revives a downed character', e.hpByChar.ignar === 0, String(e.hpByChar.ignar));
}

/* ------------------------------------------- 2. one door, and nobody beside it -- */

console.log('\n-- doors --');

// `derivedStats` is pure: it derives and returns, and pushes nothing. Exactly two callers
// may use it — the join handshake (no live entity yet) and `publishStats` itself. Any
// route that calls it directly is answering the panel while the fight keeps the old build.
const SERVER_FILES = ['routes/player.js', 'routes/gacha.js', 'routes/shop.js', 'routes/mail.js',
  'routes/achievements.js', 'routes/world.js', 'routes/social.js', 'ws/gateway.js', 'world/manager.js'];
let scanned = 0;
const derivedCallers = [];
const statsAnswers = [];
for (const rel of SERVER_FILES) {
  let src;
  try { src = read(`server/src/${rel}`); } catch { continue; }
  scanned++;
  const calls = (src.match(/derivedStats\(/g) || []).length;
  if (calls) derivedCallers.push(`${rel}×${calls}`);
  if (/^\s*(?:return \{|\.\.\.).*\bstats:/m.test(src) || /\bstats: publishStats\(/.test(src) || /\bstats: derivedStats\(/.test(src)) {
    statsAnswers.push(rel);
  }
}
// The scan itself has to be proved non-empty: a regex that matches nothing agrees with
// every assertion below it.
ok('the server scan read its files', scanned === SERVER_FILES.length && derivedCallers.length > 0,
  `${scanned}/${SERVER_FILES.length} files, callers ${derivedCallers.join(' ')}`);
ok('only the handshake and publishStats call derivedStats',
  derivedCallers.sort().join(' ') === 'routes/player.js×2 ws/gateway.js×2', derivedCallers.join(' '));
ok('every route answering a stats field goes through publishStats',
  statsAnswers.length >= 4 && statsAnswers.every((rel) => /publishStats\(/.test(read(`server/src/${rel}`))),
  statsAnswers.join(' '));
ok('publishStats pushes into the world', /publishStats\([^)]*\)\s*\{[\s\S]{0,220}world\.refreshBuild\(/.test(read('server/src/routes/player.js')));
ok('the kill path uses the same door',
  /publishStats\(player, \{ heal: 200/.test(read('server/src/world/manager.js')));

// The client half: 单机 mode hosts the same simulation in the browser, so a fix that only
// lands online is a balance fork. Three doors have to exist and be wired.
const local = read('client/src/net/localSocket.js');
const game = read('client/src/game/game.js');
const panels = read('client/src/ui/panels.js');
ok('the browser host applies builds to its own entity',
  /applyBuild\(stats, party = null, opts = \{\}\)/.test(local) && /e\.applyBuild\(this\._stats, party, opts\)/.test(local));
ok('...through the same entity method as the gateway', /e\.applyBuild\(/.test(local) && /entity\.applyBuild\(/.test(read('server/src/world/manager.js')));
ok('Game.applyBuild forwards to the local host when there is one', /this\.socket\.applyBuild\?\.\(/.test(game));
ok('the statsRefresh event applies party and charId', /case 'statsRefresh':[\s\S]{0,400}this\.applyBuild\(d\.stats, d\.party, d\.charId\)/.test(game));
ok('every panel action goes through it', /_act\(fn[\s\S]{0,700}this\.game\.applyBuild\(/.test(panels));
ok('...and no panel writes the roster behind its back', !/g\.party = /.test(panels), (panels.match(/g\.party = .*/g) || []).join(' '));

/* ---------------------------------------------------- 3. live, over the wire -- */

console.log('\n-- live gateway --');

const up = await fetch(`http://${HOST}/api/health`).then((r) => r.ok).catch(() => false);
if (!up) {
  skip('live gateway section', `no server on ${HOST}`);
} else {
  const rest = async (token, p, body) => {
    const r = await fetch(`http://${HOST}${p}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, b: await r.json().catch(() => ({})) };
  };

  const g = await (await fetch(`http://${HOST}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).json();
  const token = g.token;
  const state = await rest(token, '/api/player/state');
  const owned = Object.keys(state.b.player?.characters || {});
  ok('a fresh account owns two characters to switch between', owned.length >= 2, owned.join(','));

  // Join with a one-character team, so "a character added to the team" is a real test:
  // with both already on the roster it would pass whether or not the entity heard about it.
  await rest(token, '/api/player/party', { party: [owned[1]] });
  const [other, mine] = owned;

  const ws = new WebSocket(`ws://${HOST}/ws?token=${encodeURIComponent(token)}`);
  let log = [];
  ws.addEventListener('message', (ev) => { try { log.push(JSON.parse(String(ev.data))); } catch {} });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws refused')));
  });
  const send = (t, d) => ws.send(JSON.stringify({ t, d }));
  // Every wait starts from a cleared log. `find` over everything received since connect
  // answers with the *first* match, which for a repeated action is the previous one — that
  // is how this probe once reported a fixed bug as still broken.
  const waitFor = async (pred, ms = 2500) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = log.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    return null;
  };
  const isRefresh = (m) => m.t === S2C.PLAYER_ACTION && m.d.action === 'statsRefresh';
  const act = async (fn) => { log = []; const r = await fn(); return r; };
  const switchTo = async (charId) => {
    log = [];
    send(C2S.SWITCH_CHAR, { charId });
    const hit = await waitFor((m) => m.t === S2C.PLAYER_ACTION && m.d.action === 'switchOk' && m.d.charId === charId);
    if (hit) return { maxHp: hit.d.maxHp };
    return { error: log.find((m) => m.t === S2C.ERROR)?.d?.error || 'no reply' };
  };

  send(C2S.HELLO, { token, zone: 'mondstadt', mode: 'online' });
  const welcome = await waitFor((m) => m.t === S2C.WELCOME, 8000);
  ok('joined a zone', !!welcome, welcome ? `${welcome.d.zone}#${welcome.d.shard}` : '');

  // (a) adding a character to the team makes them switchable *now*.
  await act(() => rest(token, '/api/player/party', { party: [mine, other] }));
  const added = await waitFor(isRefresh);
  ok('a party edit is pushed to the socket', !!added, added ? JSON.stringify(added.d.party) : 'NOTHING');
  ok('...with the new roster', added?.d.party?.length === 2, JSON.stringify(added?.d.party));
  let r = await switchTo(other);
  ok('the added character can be switched to', !!r.maxHp, r.error || `maxHp ${r.maxHp}`);

  // (b) a level-up reaches the fight, not just the panel.
  const before = state.b.stats?.[mine]?.maxHp;
  const up2 = await act(() => rest(token, `/api/char/levelup`, { charId: mine, materials: { heroWit: 2, adventurerXp: 10 } }));
  const after = up2.b?.stats?.[mine]?.maxHp;
  const pushed = await waitFor(isRefresh);
  ok('the level-up itself worked', after > before, `${before} -> ${after}`);
  ok('the new stat block is pushed to the socket', pushed?.d.stats?.[mine]?.maxHp === after,
    `pushed ${pushed?.d.stats?.[mine]?.maxHp ?? 'NOTHING'}`);
  r = await switchTo(mine);
  ok('the live simulation fights with the new maxHp', r.maxHp === after, `${r.maxHp} vs REST ${after}`);

  // (c) an unchanged build must not push: `GET /api/player/state` derives stats too, and
  // every panel open would otherwise resend the whole block down the socket.
  log = [];
  await rest(token, '/api/player/state');
  await rest(token, '/api/player/state');
  await sleep(400);
  ok('an unchanged build pushes nothing', !log.some(isRefresh), `${log.filter(isRefresh).length} refreshes`);

  // (d) dropping the character being controlled switches them off it.
  r = await switchTo(other);
  const dropped = await act(() => rest(token, '/api/player/party', { party: [mine] }));
  const off = await waitFor(isRefresh);
  ok('dropping the active character is pushed', !!off && off.d.charId === mine,
    `charId ${off?.d.charId} party ${JSON.stringify(off?.d.party)}`);
  r = await switchTo(other);
  ok('a character no longer in the team cannot be switched to', !r.maxHp, r.maxHp ? `ALLOWED ${r.maxHp}` : r.error);
  ok('the party edit stuck in the save', (dropped.b?.party || []).join(',') === mine);

  ws.close();
}

console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}`
  : `\nall passed${skips.length ? ` (${skips.length} skipped)` : ''}`);
process.exit(fails.length);
