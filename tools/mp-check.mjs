// Two-client multiplayer end-to-end check, at the protocol level.
//
// The browser probes (`play.mjs`, `tour.mjs`) prove one client works. What they cannot
// show is the part the goal actually asks for — that two players in the same zone see
// each other — because two WebGL contexts under llvmpipe is 1 fps each and the tour is
// already the slowest thing in the repo. So this talks to the gateway directly with the
// same messages `client/src/net/socket.js` sends: two guest accounts, one zone, and
// assertions on what each socket receives about the other.
//
//   DISPLAY unnecessary; node tools/mp-check.mjs [host]
//
// Exit code is the number of failed assertions.

// Node 22's own global WebSocket and fetch, so this runs from the repo root with no
// node_modules of its own — `@teyvat/shared` is only linked inside server/ and client/.
import { C2S, S2C } from '../shared/src/protocol.js';
import { ZONES } from '../shared/src/data/zones.js';

const HOST = process.argv[2] || '127.0.0.1:8787';
const ZONE = 'mondstadt';
const fails = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function guest(tag) {
  const r = await fetch(`http://${HOST}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  if (!r.ok) throw new Error(`guest ${tag}: HTTP ${r.status}`);
  const j = await r.json();
  return { tag, token: j.token, playerId: j.player?.id ?? j.playerId, nickname: j.player?.nickname };
}

/** A minimal client: connects, records every message by type, and can send input. */
function connect(acc) {
  const ws = new WebSocket(`ws://${HOST}/ws?token=${encodeURIComponent(acc.token)}`);
  const c = {
    ...acc, ws, log: [], by: new Map(), welcome: null,
    got(t) { return this.by.get(t) || []; },
    send(t, d) { if (ws.readyState === 1) ws.send(JSON.stringify({ t, d })); },
    // Feed the server a position the anti-teleport check will accept: it allows
    // MAX_SPEED * dt + 1.5 m per packet, so walk there in steps rather than jumping.
    async walkTo(x, z, y = 0) {
      for (let i = 0; i < 14; i++) {
        const t = (i + 1) / 14;
        this.send(C2S.INPUT, {
          x: this.x + (x - this.x) * t, z: this.z + (z - this.z) * t, y, ry: 0, a: 2, st: 240,
        });
        await sleep(90);
      }
      this.x = x; this.z = z;
    },
  };
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
    c.log.push(m);
    if (!c.by.has(m.t)) c.by.set(m.t, []);
    c.by.get(m.t).push(m.d);
    if (m.t === S2C.WELCOME) {
      c.welcome = m.d;
      c.x = m.d.you?.x ?? 0; c.z = m.d.you?.z ?? 0;
    }
  });
  return new Promise((res, rej) => {
    ws.addEventListener('open', () => res(c));
    ws.addEventListener('error', (e) => rej(new Error(`${acc.tag} ws error: ${e.message || 'refused'}`)));
  });
}

const waitFor = async (c, t, ms = 6000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (c.got(t).length) return c.got(t);
    await sleep(80);
  }
  return null;
};

/** Wait for a message of type `t` that satisfies `pred`, ignoring ones already logged. */
const waitWhere = async (c, t, pred, ms = 6000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = c.got(t).find(pred);
    if (hit) return hit;
    await sleep(80);
  }
  return null;
};

/**
 * Wait for a message of type `t` logged *after* index `from`.
 *
 * `waitWhere` searches the whole log, which silently returns a message that arrived
 * before the action under test: every zone transition in this file answers with
 * ZONE_STATE, so "wait for a ZONE_STATE in 蒙德" is already satisfied by the one from
 * three sections ago. Take the length before sending, pass it in here.
 */
const waitAfter = async (c, t, from, pred = () => true, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = c.got(t).slice(from).find(pred);
    if (hit) return hit;
    await sleep(80);
  }
  return null;
};

const snap = (c) => c.got(S2C.SNAPSHOT).at(-1);
const posOf = (c, who) => snap(c)?.players?.find((p) => Number(p.id) === Number(who.playerId));

/**
 * Walk a client to (x, z) in chunks the anti-teleport check accepts, re-reading the
 * server's idea of where the player is after each one: `walkTo` assumes its packets all
 * landed, and over 60 m of hillside that assumption drifts far enough to walk into the
 * void. Shared by the co-op kill and the co-op 秘境 sections, which both need two
 * players standing in the same place.
 */
const approach = async (c, acc, x, z, chunks = 6) => {
  for (let i = 0; i < chunks; i++) {
    const me = posOf(c, acc);
    if (me) { c.x = me.x; c.z = me.z; }
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < 4) return true;
    const t = Math.min(1, 18 / d);
    await c.walkTo(c.x + (x - c.x) * t, c.z + (z - c.z) * t);
  }
  const me = posOf(c, acc);
  return !!me && Math.hypot(x - me.x, z - me.z) < 6;
};

async function rest(token, path, body) {
  const r = await fetch(`http://${HOST}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, b: await r.json().catch(() => ({})) };
}

/**
 * Take a fresh guest to a party that can win a fight, through the routes the character
 * screen calls.
 *
 * Needed because the *winning* half of a co-op 秘境 was unconstructible: two level-1 guests
 * in the shallowest floor in the game (level 18) can only ever wipe, so `handleChamberClear`
 * — the loop that pays every player in the instance, the reason co-op dungeons exist — had
 * no receipt at all.
 *
 * `POST /api/dev/supply` (dev-only, `server/src/routes/dev.js`) hands over *materials and
 * mora only*, billed from the same cost tables a player pays out of. Every level below is
 * therefore bought with `/api/char/levelup`, `/api/char/ascend` and
 * `/api/inventory/weapon/levelup`: if one of those is broken the party stays weak and the
 * clear assertions go red, which is the correct outcome. A hook that wrote `level = 40`
 * would have hidden the two growth bugs this section found.
 *
 * Rank first: the growth routes cap at `arCap(AR) = min(90, 20 + 2·AR)`, so at AR 1 nothing
 * above level 22 can be bought and the supply is billed against the same ceiling.
 */
async function powerUp(acc, level = 40, rank = 10) {
  await rest(acc.token, '/api/dev/rank', { rank });
  const sup = await rest(acc.token, '/api/dev/supply', { level });
  const before = await rest(acc.token, '/api/player/state');
  for (const charId of Object.keys(before.b.player?.characters || {})) {
    // levelup → ascend → levelup: an ascension is a cap, so the climb to 40 has to stop at
    // 20 and break through. Four rounds is slack — `ASCENSION_CAPS` needs one.
    for (let round = 0; round < 4; round++) {
      const lv = await rest(acc.token, '/api/char/levelup', { charId, materials: { heroWit: 9999 } });
      if ((lv.b?.level || 0) >= level) break;
      if ((await rest(acc.token, '/api/char/ascend', { charId })).status !== 200) break;
    }
  }
  const mid = await rest(acc.token, '/api/player/state');
  for (const w of (mid.b.player?.equipment || []).filter((e) => e.kind === 'weapon')) {
    await rest(acc.token, '/api/inventory/weapon/levelup', { uid: w.uid, ore: { ironChunk: 99999 } });
  }
  const st = (await rest(acc.token, '/api/player/state')).b.player || {};
  return {
    granted: sup.b?.granted || {},
    chars: Object.values(st.characters || {}).map((c) => c.level),
    weapons: (st.equipment || []).filter((e) => e.kind === 'weapon').map((e) => e.level || 1),
    rank: st.adventureRank, worldLevel: st.worldLevel,
  };
}

/* -------------------------------------------------------------------- run -- */

const a = await guest('A');
const b = await guest('B');
ok('two guest accounts', a.playerId && b.playerId && a.playerId !== b.playerId,
  `${a.playerId} / ${b.playerId}`);

const ca = await connect(a);
const cb = await connect(b);

// Online mode (not solo) is what puts both into a shared instance.
ca.send(C2S.HELLO, { token: a.token, zone: ZONE, mode: 'online' });
ok('A welcome', !!(await waitFor(ca, S2C.WELCOME)), ca.welcome?.zone);
await sleep(400);
cb.send(C2S.HELLO, { token: b.token, zone: ZONE, mode: 'online' });
ok('B welcome', !!(await waitFor(cb, S2C.WELCOME)), cb.welcome?.zone);

ok('same zone', ca.welcome?.zone === ZONE && cb.welcome?.zone === ZONE);
ok('same shard', ca.welcome?.shard === cb.welcome?.shard,
  `${ca.welcome?.shard} / ${cb.welcome?.shard}`);
ok('online mode', ca.welcome?.mode === 'online' && cb.welcome?.mode === 'online');

// A must be told B arrived.
const joins = await waitFor(ca, S2C.PLAYER_JOIN, 5000);
ok('A sees B join', !!joins?.some((j) => Number(j.playerId ?? j.player?.id) === Number(b.playerId)),
  JSON.stringify(joins?.slice(-1)?.[0]?.playerId ?? joins?.slice(-1)?.[0] ?? null).slice(0, 80));

// Snapshots must carry the other player. Both spawn at the zone entry, so they start
// well inside the AOI radius.
await waitFor(ca, S2C.SNAPSHOT);
await sleep(1200);
const seesOther = (c, other) => c.got(S2C.SNAPSHOT).slice(-6)
  .some((s) => s.players?.some((p) => Number(p.id) === Number(other.playerId)));
ok('A snapshot lists B', seesOther(ca, b));
ok('B snapshot lists A', seesOther(cb, a));

// Movement must propagate: walk B 18 m and check the position A is told about tracks it.
const before = ca.got(S2C.SNAPSHOT).at(-1).players.find((p) => Number(p.id) === Number(b.playerId));
await cb.walkTo(cb.x + 13, cb.z + 13);
await sleep(900);
const after = ca.got(S2C.SNAPSHOT).at(-1).players.find((p) => Number(p.id) === Number(b.playerId));
const moved = before && after ? Math.hypot(after.x - before.x, after.z - before.z) : 0;
ok('B movement reaches A', moved > 8, `${moved.toFixed(1)} m`);
ok('server accepted the walk (no correction)',
  !ca.got(S2C.PLAYER_ACTION).concat(cb.got(S2C.PLAYER_ACTION))
    .some((p) => p.action === 'correction'));

// Chat is the other broadcast path players notice immediately.
cb.send(C2S.CHAT, { body: 'mp-check hello', channel: 'zone' });
const chat = await waitFor(ca, S2C.CHAT, 5000);
ok('A receives B chat', !!chat?.some((m) => String(m.body || '').includes('mp-check hello')));

// Party: invite carries the party id, and accept has to echo it back — the server looks
// the party up by that id and has no notion of "accept whoever invited me".
ca.send(C2S.PARTY_INVITE, { playerId: b.playerId });
const invite = (await waitFor(cb, S2C.PARTY, 5000))?.map((m) => m.invite).filter(Boolean).at(-1);
ok('B receives the invite', !!invite && Number(invite.from) === Number(a.playerId), invite?.partyId);
cb.send(C2S.PARTY_ACCEPT, { partyId: invite?.partyId });
await sleep(1000);
const roster = (list) => list?.map((m) => m.members).filter(Boolean).at(-1)
  ?.map((m) => Number(m.playerId ?? m.id)) || [];
const partyA = ca.got(S2C.PARTY);
const partyB = cb.got(S2C.PARTY);
ok('party roster has both, on A', roster(partyA).includes(Number(a.playerId))
  && roster(partyA).includes(Number(b.playerId)), JSON.stringify(roster(partyA)));
ok('party roster has both, on B', roster(partyB).includes(Number(a.playerId))
  && roster(partyB).includes(Number(b.playerId)), JSON.stringify(roster(partyB)));

// Shared world: the enemies A is told about must be the same entities B is told about,
// which is the whole point of one authoritative instance per zone.
const ea = new Set((ca.got(S2C.SNAPSHOT).at(-1).enemies || []).map((e) => e.id));
const eb = new Set((cb.got(S2C.SNAPSHOT).at(-1).enemies || []).map((e) => e.id));
const shared = [...ea].filter((id) => eb.has(id));
ok('enemies are shared entities', ea.size > 0 && shared.length > 0,
  `A=${ea.size} B=${eb.size} common=${shared.length}`);

// `POST /api/world/kill` exists for 单机 clients, whose simulation runs in their own
// browser. A player who is in a live shard has the gateway paying for their kills
// already, so the route has to refuse them — otherwise one corpse pays twice, which is
// exactly the bug the chamber route had. A is connected right now, so this must 409.
{
  const enemyId = (ZONES[ZONE].spawns || [])[0]?.enemies?.[0];
  const r = await fetch(`http://${HOST}/api/world/kill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
    body: JSON.stringify({ zone: ZONE, enemyId }),
  });
  const body = await r.json().catch(() => ({}));
  ok('the solo kill route refuses a connected player', r.status === 409 && body.error === 'use_socket',
    `${enemyId}: status ${r.status} ${body.error || ''}`);
}

// Co-op through the friend list: `JOIN_ZONE {follow}` is the only way one player can
// ask to be put in *another player's* shard, so it is the only place the gateway takes
// a shard from the client at all — hence the gate (friends only) and the assertions on
// both the refusals and the landing.
const expectedErrors = new Set();
{
  // Before they are friends, following must be refused. This is the whole access
  // control story for co-op: `/api/online` tells anyone which zone you are in, but
  // only a friend can be dropped into your shard.
  expectedErrors.add('not_friends');
  ca.send(C2S.JOIN_ZONE, { zone: ZONE, follow: b.playerId });
  const denied = await waitWhere(ca, S2C.ERROR, (e) => e.error === 'not_friends', 5000);
  ok('following a stranger is refused', !!denied, JSON.stringify(denied || null));

  // Befriend over REST — the friendship is persistent state, so it does not matter
  // that the two are talking over sockets right now.
  const req = await rest(a.token, '/api/social/request', { playerId: b.playerId });
  const acc = await rest(b.token, '/api/social/accept', { playerId: a.playerId });
  ok('friend request and accept over REST',
    req.status === 200 && acc.status === 200 && acc.b.state === 'accepted',
    `${req.b.state} -> ${acc.b.state}`);

  // A friend who is not connected has no shard to join, and the client has to hear
  // that rather than watch a loading screen: C accepts without ever opening a socket.
  const c = await guest('C');
  await rest(a.token, '/api/social/request', { playerId: c.playerId });
  await rest(c.token, '/api/social/accept', { playerId: a.playerId });
  expectedErrors.add('friend_offline');
  ca.send(C2S.JOIN_ZONE, { zone: ZONE, follow: c.playerId });
  const off = await waitWhere(ca, S2C.ERROR, (e) => e.error === 'friend_offline', 5000);
  ok('following an offline friend says so', !!off, JSON.stringify(off || null));

  // And the real thing: A follows B and must come out standing next to them, in B's
  // zone and B's shard, whatever zone A asked for. B walked 18 m earlier, so "next to
  // B" is a different place from the zone entry A would otherwise be sent to.
  const bPos = ca.got(S2C.SNAPSHOT).at(-1).players.find((p) => Number(p.id) === Number(b.playerId));
  ca.send(C2S.JOIN_ZONE, { zone: ZONE, follow: b.playerId });
  const zs = await waitFor(ca, S2C.ZONE_STATE, 8000);
  const st = zs?.at(-1);
  ok('following a friend lands in their shard',
    st?.zone === cb.welcome?.zone && String(st?.shard) === String(cb.welcome?.shard),
    `${st?.zone}#${st?.shard} vs ${cb.welcome?.zone}#${cb.welcome?.shard}`);
  const gap = st?.you && bPos ? Math.hypot(st.you.x - bPos.x, st.you.z - bPos.z) : 999;
  ok('and lands beside them, not at the zone entry', gap < 6, `${gap.toFixed(1)} m apart`);
  ok('B is told A arrived',
    !!(await waitWhere(cb, S2C.PLAYER_JOIN,
      (j) => Number(j.player?.id ?? j.playerId) === Number(a.playerId), 5000)));
}

// Standing someone up is the only C2S message whose subject is *another player*, so the
// gateway's guards on it are the whole of its access control — without `not_downed`,
// `C2S.REVIVE {playerId: <a stranger>}` is a free 50%-hp heal from any distance, and
// `C2S.RESPAWN` from a standing player is a free teleport to their nearest anchor. Both
// refusals are reachable from here; the third (`too_far`) is not, because nothing in C2S
// inflicts damage — a *downed* remote player cannot be constructed over a socket at all.
// `tools/death-check.mjs` drives the downed half in the browser, where the sim is local.
{
  expectedErrors.add('not_downed');
  const refusals = (c) => c.got(S2C.ERROR).filter((e) => e.error === 'not_downed').length;
  // Counted rather than searched: three sends produce the same error string, and on one
  // socket `find` would keep returning the *first* one and call every later send green.
  const refused = async (c, from, ms = 5000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (refusals(c) > from) return true;
      await sleep(80);
    }
    return false;
  };
  const hpOf = (c, who) => c.got(S2C.SNAPSHOT).at(-1)?.players
    ?.find((p) => Number(p.id) === Number(who.playerId));
  const hpBefore = { a: hpOf(ca, a)?.hp, b: hpOf(ca, b)?.hp };

  let n = refusals(ca);
  ca.send(C2S.REVIVE, { playerId: b.playerId });
  ok('reviving a teammate who is standing is refused', await refused(ca, n), 'not_downed');

  n = refusals(ca);
  ca.send(C2S.REVIVE, { playerId: 999999999 });
  ok('...as is reviving somebody who is not in this shard', await refused(ca, n), 'not_downed');

  const nb = refusals(cb);
  cb.send(C2S.RESPAWN, {});
  ok('...and asking to be sent to an anchor while alive', await refused(cb, nb), 'not_downed');

  // A refusal has to be a refusal: no REVIVED went out, and neither player was healed,
  // hurt or moved by the attempt.
  await sleep(900);
  const after = { a: hpOf(ca, a), b: hpOf(ca, b) };
  ok('no REVIVED event went out for either of them',
    ca.got(S2C.REVIVED).length === 0 && cb.got(S2C.REVIVED).length === 0,
    `A=${ca.got(S2C.REVIVED).length} B=${cb.got(S2C.REVIVED).length}`);
  ok('and both are still standing with the hp they had',
    after.a?.al === 1 && after.b?.al === 1
    && after.a?.hp === hpBefore.a && after.b?.hp === hpBefore.b,
    `A ${hpBefore.a}→${after.a?.hp}, B ${hpBefore.b}→${after.b?.hp}`);
}

// Co-op combat has to pay everybody who fought, or helping a friend is charity: the last
// hit used to be the only receipt, so a teammate could spend a boss's health bar and get no
// xp, no drops and no progress on 「讨伐 ×3」. `Enemy.threat` is the ledger the credit is
// derived from; the unit-level cases (a helper who walked away, a bystander who never swung)
// are in `tools/enemy-check.mjs` section 10, because a socket cannot construct them on
// demand. What only this probe can show is that the *gateway* pays the helper: a second
// `grantKillRewards`, a second LOOT down a second socket, labelled `assist`.
//
// Nothing here is pinned to which player lands the last hit — that is a race between two
// attack cooldowns. The expectation is derived from `ENEMY_DIED.by`, so either outcome is
// the same assertion.
{
  // Level 3 slimes and level 14 ruin guards live in the same zone; two level-1 guests kill
  // the first in seconds and lose to the second, so the candidate list is capped by level
  // rather than by distance alone.
  const candidates = () => {
    const me = posOf(ca, a) || { x: ca.x, z: ca.z };
    return (snap(ca)?.enemies || []).filter((e) => e.a === 1 && e.lv <= 8)
      .map((e) => ({ ...e, d: Math.hypot(e.x - me.x, e.z - me.z) }))
      .sort((p, q) => p.d - q.d);
  };

  let died = null, tid = null;
  for (const cand of candidates().slice(0, 2)) {
    tid = cand.id;
    await Promise.all([approach(ca, a, cand.x, cand.z), approach(cb, b, cand.x, cand.z)]);
    // 莉拉 carries a sword: reach 2.6 m + 2.2 m of slack, swept around the aim the packet
    // carries, so the direction has to be re-derived from the enemy's *current* position on
    // every swing — it is walking towards whoever it is angry at the whole time.
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      const e = (snap(ca)?.enemies || []).find((x) => x.id === tid);
      if (!e || e.a === 0) break;
      for (const [c, acc] of [[ca, a], [cb, b]]) {
        const me = posOf(c, acc);
        if (!me) continue;
        const dx = e.x - me.x, dz = e.z - me.z;
        const d = Math.hypot(dx, dz) || 1;
        if (d > 3.2) {
          const step = Math.min(1.4, d - 2.4);
          c.send(C2S.INPUT, {
            x: me.x + (dx / d) * step, z: me.z + (dz / d) * step, y: me.y ?? 0,
            ry: Math.atan2(dx, dz), a: 2, st: 240,
          });
        }
        c.send(C2S.ATTACK, { dir: [dx / d, 0, dz / d] });
      }
      await sleep(220);
      died = ca.got(S2C.ENEMY_DIED).find((x) => x.id === tid) || null;
      if (died) break;
    }
    if (died) break;
  }

  ok('two players killed a shared enemy', !!died, died ? `${died.t} #${tid} by ${died.by}` : `#${tid} survived`);
  const hitters = new Set(ca.got(S2C.DAMAGE)
    .filter((m) => m.target === 'enemy' && m.id === tid && m.by).map((m) => Number(m.by)));
  ok('...and both of them landed hits on it',
    hitters.has(Number(a.playerId)) && hitters.has(Number(b.playerId)),
    `hit by ${[...hitters].join(',')} of ${a.playerId},${b.playerId}`);

  const lootFor = (c) => c.got(S2C.LOOT).find((l) => l.enemyId === tid);
  const lootA = lootFor(ca), lootB = lootFor(cb);
  ok('the corpse pays both sockets, not just the one that finished it',
    !!lootA && !!lootB, `A ${lootA ? 'paid' : 'nothing'} / B ${lootB ? 'paid' : 'nothing'}`);

  // Derived from the outcome: whoever `ENEMY_DIED.by` names is the killer, the other is the
  // assist. Pinning "B kills" would be a coin flip on two 0.24 s cooldowns.
  const killedByA = Number(died?.by) === Number(a.playerId);
  const kill = killedByA ? lootA : lootB;
  const assist = killedByA ? lootB : lootA;
  ok('the last hit is the kill, the other is labelled 助战',
    !!kill && !kill.assist && assist?.assist === true,
    `killer ${died?.by}: assist=${kill?.assist} / helper: assist=${assist?.assist}`);
  ok('and the helper is paid something real, not an empty envelope',
    (assist?.xp || 0) > 0 && Object.keys(assist?.items || {}).length > 0,
    `${assist?.xp} xp, ${JSON.stringify(assist?.items || {})}`);
}

// Co-op 秘境: the three dungeon zones in 多人在线.
//
// This is the section the goal's "多个游戏场景和关卡 + 多人在线" was missing entirely, and it
// was missing because the server refused it: every dungeon is `kind: 'dungeon'`, every dungeon
// instance is therefore a private shard, and the follow path answered *any* private shard with
// `friend_is_solo`. So the game had three levels that only ever held one player, and — worse —
// entering one latched `world.solo`, which kept the player in private shards of the open world
// for the rest of the session and told their client `mode: 'solo'`.
//
// The rule now has two sides and both are asserted here: a teammate lands in the party's
// instance, a friend who is not in the party still cannot. The shard is named after the party
// *leader* rather than whoever walked in first, which is what makes "one instance per party"
// well defined — B enters first below, and the shard still carries A's id.
{
  const DUNGEON = 'abyssTrial';
  expectedErrors.add('friend_is_solo');
  expectedErrors.add('previous_floor_locked');

  const nB = cb.got(S2C.ZONE_STATE).length;
  cb.send(C2S.JOIN_ZONE, { zone: DUNGEON });
  const zb = await waitAfter(cb, S2C.ZONE_STATE, nB, (z) => z.zone === DUNGEON, 9000);
  ok('a teammate can enter a 秘境', !!zb, `${zb?.zone}#${zb?.shard} mode=${zb?.mode}`);
  ok('the 秘境 shard is named after the party leader, not the entrant',
    String(zb?.shard) === `p${a.playerId}`, `${zb?.shard} vs p${a.playerId} (B is ${b.playerId})`);
  // The regression that mattered most: a dungeon is a private *instance*, which is a
  // different statement from "this player is playing 单机". Reporting solo here is what
  // turned the client's own co-op UI off for the rest of the session.
  ok('...and entering it does not put an online player into 单机', zb?.mode === 'online', zb?.mode);

  const nA = ca.got(S2C.ZONE_STATE).length;
  ca.send(C2S.JOIN_ZONE, { zone: ZONE, follow: b.playerId });
  const za = await waitAfter(ca, S2C.ZONE_STATE, nA, (z) => z.zone === DUNGEON, 9000);
  ok('the leader follows them into the same 秘境 instance',
    !!za && String(za?.shard) === String(zb?.shard), `${za?.zone}#${za?.shard} vs ${zb?.zone}#${zb?.shard}`);
  ok('...and the follower is not sent to 单机 either', za?.mode === 'online', za?.mode);

  // Two players, one dungeon instance, each in the other's snapshot: this is co-op 秘境.
  await sleep(1400);
  ok('both players are in the same 秘境 snapshot', seesOther(ca, b) && seesOther(cb, a),
    `A sees B: ${seesOther(ca, b)}, B sees A: ${seesOther(cb, a)}`);

  // The other side of the rule. S is a *friend* of A — so the `not_friends` gate is not what
  // stops them — and is in their own dungeon. A stranger in a party's 秘境 would be handed a
  // chamber already in progress, so following is still refused.
  const s = await guest('S');
  await rest(a.token, '/api/social/request', { playerId: s.playerId });
  await rest(s.token, '/api/social/accept', { playerId: a.playerId });
  const cs = await connect(s);
  cs.send(C2S.HELLO, { token: s.token, zone: ZONE, mode: 'online' });
  await waitFor(cs, S2C.WELCOME);
  cs.send(C2S.JOIN_ZONE, { zone: DUNGEON });
  const zs = await waitAfter(cs, S2C.ZONE_STATE, 0, (z) => z.zone === DUNGEON, 9000);
  ok('a friend who is not in the party gets their own 秘境 instance',
    !!zs && String(zs.shard) === `p${s.playerId}`, `${zs?.shard} vs p${s.playerId}`);
  cs.send(C2S.JOIN_ZONE, { zone: ZONE, follow: a.playerId });
  ok('...and cannot follow into the party\'s',
    !!(await waitWhere(cs, S2C.ERROR, (e) => e.error === 'friend_is_solo', 5000)));

  // The friend panel has to agree with the gateway, or the co-op the server now allows has no
  // button: `joinable` is what draws it. Both directions in one response — B is joinable from
  // A's list (same party, private shard), S is not (private shard, no party) — and `private`
  // tells the panel to label it 秘境 rather than 「Ta的世界」.
  {
    const fr = await rest(a.token, '/api/social/friends');
    const rowOf = (who) => (fr.b.friends || []).find((f) => Number(f.playerId) === Number(who.playerId));
    const rb = rowOf(b), rs = rowOf(s);
    ok('the friend list marks the teammate in the 秘境 joinable',
      rb?.online === true && rb?.private === true && rb?.joinable === true,
      `B: online=${rb?.online} private=${rb?.private} joinable=${rb?.joinable} zone=${rb?.zone}`);
    ok('...and the friend in their own 秘境 not joinable',
      rs?.online === true && rs?.private === true && rs?.joinable === false,
      `S: online=${rs?.online} private=${rs?.private} joinable=${rs?.joinable} zone=${rs?.zone}`);
  }
  cs.ws.close();

  // The chamber itself. Floors unlock in order, from the *requester's* own record, so a
  // guest asking for floor 2 is refused before anything is spawned.
  ca.send(C2S.START_CHAMBER, { floor: 2 });
  ok('floor 2 is locked until floor 1 is cleared',
    !!(await waitWhere(ca, S2C.ERROR, (e) => e.error === 'previous_floor_locked', 5000)));

  ca.send(C2S.START_CHAMBER, { floor: 1 });
  const startA = await waitWhere(ca, S2C.CHAMBER, (m) => m.state === 'start', 6000);
  const startB = await waitWhere(cb, S2C.CHAMBER, (m) => m.state === 'start', 6000);
  ok('one player starts the chamber and both are told',
    !!startA && !!startB && startA.floor === 1 && startB.floor === 1,
    `A ${startA?.state}/${startA?.floor}, B ${startB?.state}/${startB?.floor}`);
  await sleep(1400);
  const chamberOf = (c) => c.got(S2C.SNAPSHOT).at(-1)?.chamber;
  ok('the run is in both snapshots, including the player who pressed nothing',
    chamberOf(ca)?.floor === 1 && chamberOf(cb)?.floor === 1,
    `A ${JSON.stringify(chamberOf(ca))?.slice(0, 60)} / B ${JSON.stringify(chamberOf(cb))?.slice(0, 60)}`);
  const cea = new Set((ca.got(S2C.SNAPSHOT).at(-1).enemies || []).map((e) => e.id));
  const ceb = new Set((cb.got(S2C.SNAPSHOT).at(-1).enemies || []).map((e) => e.id));
  ok('the chamber\'s enemies are one set of entities, not one per client',
    cea.size > 0 && cea.size === ceb.size && [...cea].every((id) => ceb.has(id)),
    `A=${cea.size} B=${ceb.size} common=${[...cea].filter((id) => ceb.has(id)).length}`);

  // The entry anchor is 50 m from the arena and a hilichurl's aggro radius is 16 m, so a party
  // that never walks in is never fought — the run would end on the clock, not on the mechanic
  // under test. Both walk to the wave, and to the same spot: the wipe is the assertion, so both
  // have to be in it.
  const arena = (ca.got(S2C.SNAPSHOT).at(-1).enemies || [])[0] || { x: 0, z: -8 };
  await Promise.all([approach(ca, a, arena.x, arena.z), approach(cb, b, arena.x, arena.z)]);
  ok('both players reached the arena', [ca, cb].every((c, i) => {
    const me = posOf(c, i ? b : a);
    return me && Math.hypot(me.x - arena.x, me.z - arena.z) < 20;
  }), `A ${JSON.stringify(posOf(ca, a) && [Math.round(posOf(ca, a).x), Math.round(posOf(ca, a).z)])}`
    + ` B ${JSON.stringify(posOf(cb, b) && [Math.round(posOf(cb, b).x), Math.round(posOf(cb, b).z)])}`
    + ` arena ${Math.round(arena.x)},${Math.round(arena.z)}`);

  // Nobody swings: two level-1 guests in a level-18 chamber are a wipe, which is the failure
  // path co-op adds — the run ends when *everyone* is down, not when the first player falls.
  // A lost run must pay nobody, which is the mirror of `handleChamberClear` paying everybody.
  const failA = await waitWhere(ca, S2C.CHAMBER, (m) => m.state === 'failed', 100000);
  const failB = await waitWhere(cb, S2C.CHAMBER, (m) => m.state === 'failed', 20000);
  ok('the run is lost only once the whole party is down, and both are told',
    !!failA && !!failB && failA.reason === 'wiped' && failB.reason === 'wiped',
    `A ${failA?.state}/${failA?.reason}, B ${failB?.state}/${failB?.reason}`);
  ok('a lost run pays nobody',
    !ca.got(S2C.CHAMBER).some((m) => m.state === 'reward')
    && !cb.got(S2C.CHAMBER).some((m) => m.state === 'reward'));
  await sleep(1600);
  ok('and the arena is cleared, not left hunting the respawned party',
    (ca.got(S2C.SNAPSHOT).at(-1).enemies || []).length === 0,
    `${(ca.got(S2C.SNAPSHOT).at(-1).enemies || []).length} enemies left`);

  // ---- the same floor, won -----------------------------------------------------------
  //
  // Everything above is the losing half, and until now it was the *only* half a probe could
  // reach. `handleChamberClear` (manager.js) is the co-op payment: it walks
  // `inst.players.values()` and calls `grantChamberClear` once per player, so a teammate who
  // was in the room is paid the star reward, the resin-priced drop, the AR/party xp and the
  // record — without it, helping a friend clear a 秘境 pays the presser and nobody else. It
  // had never run with two players in it. See `powerUp` for why that took a dev route, and
  // why the route only grants materials.
  {
    expectedErrors.add('chamber_in_progress');
    const mhpBefore = { a: posOf(ca, a)?.mhp, b: posOf(cb, b)?.mhp };
    const nSa = ca.got(S2C.PLAYER_ACTION).length, nSb = cb.got(S2C.PLAYER_ACTION).length;
    const [pa, pb] = await Promise.all([powerUp(a), powerUp(b)]);
    ok('both accounts bought their way to level 40 through the real growth routes',
      pa.chars.every((l) => l === 40) && pb.chars.every((l) => l === 40)
      && pa.weapons.every((l) => l === 40) && pb.weapons.every((l) => l === 40),
      `A chars ${pa.chars} weapons ${pa.weapons} / B chars ${pb.chars} weapons ${pb.weapons}`
      + `, supply ${JSON.stringify(pa.granted)}`);

    // The levels have to reach the fight, not just the save: `publishStats` → `refreshBuild`
    // is what rebuilds the live entity, and it is the only reason a party levelled up mid-run
    // hits any harder. Two receipts — the event each socket is sent, and the ceiling in the
    // snapshot every client draws its health bar from.
    const refresh = (c, n) => c.got(S2C.PLAYER_ACTION).slice(n).filter((m) => m.action === 'statsRefresh');
    await sleep(1200);
    ok('the live entities were rebuilt, so the levels reach the fight',
      refresh(ca, nSa).length > 0 && refresh(cb, nSb).length > 0
      && posOf(ca, a).mhp > mhpBefore.a * 2 && posOf(cb, b).mhp > mhpBefore.b * 2,
      `A ${mhpBefore.a}→${posOf(ca, a).mhp} hp (${refresh(ca, nSa).length} refreshes)`
      + `, B ${mhpBefore.b}→${posOf(cb, b).mhp} (${refresh(cb, nSb).length})`);

    // Stood up and healed. The wipe left both of them down, the 8 s timer stands them up at
    // the anchor with a fraction of their hp, and `applyBuild` keeps hp where it was under
    // the new ceiling — so a 3778 hp character walks in with 500. 甜甜花酿鸡 is in the starter
    // bag and heals over the socket (`C2S.USE_ITEM`), because the effect is combat state.
    for (const [c, acc] of [[ca, a], [cb, b]]) {
      for (let i = 0; i < 14 && posOf(c, acc)?.al !== 1; i++) await sleep(700);
      for (let i = 0; i < 2; i++) {
        const me = posOf(c, acc);
        if (!me || me.hp >= me.mhp - 1) break;
        c.send(C2S.USE_ITEM, { itemId: 'sweetMadame' });
        await sleep(700);
      }
    }
    ok('both are standing and fed before the run', [[ca, a], [cb, b]].every(([c, acc]) => {
      const me = posOf(c, acc);
      return me && me.al === 1 && me.hp > me.mhp * 0.6;
    }), `A ${posOf(ca, a)?.hp}/${posOf(ca, a)?.mhp} al=${posOf(ca, a)?.al}`
      + `, B ${posOf(cb, b)?.hp}/${posOf(cb, b)?.mhp} al=${posOf(cb, b)?.al}`);

    // The world level has to reach the fight too, and it travels a different road than the
    // stats above: `ZoneInstance.worldLevel()` reads `p.save.worldLevel` off the entity that
    // joined the shard, so it only holds while that object *is* the cached save. A fresh read
    // (`GET /api/player/state`) used to load a second copy and install it in the cache,
    // orphaning the running shard from the save — `powerUp` calls that route three times, and
    // every panel the client opens calls it again. The symptom was a shard that kept scaling
    // spawns by the world level the party walked in with: floor 5 of 深渊试炼场 spawned lv 68
    // (world level 6) long after four clears had carried the save to world level 7.
    //
    // The ordering *is* the test: the rank goes up after `powerUp`'s fresh reads, so the only
    // way the arriving wave can carry it is if the simulation and the save are still the same
    // object. `spawnEnemy` rounds `level * (1 + 0.06 * WL)`, and the instance takes the party
    // maximum, so both accounts are moved together.
    const wlBefore = pa.worldLevel;
    await Promise.all([a, b].map((acc) => rest(acc.token, '/api/dev/rank', { rank: 16 })));
    const wlOf = async (acc) => (await rest(acc.token, '/api/player/state')).b.player?.worldLevel;
    const [wlA, wlB] = await Promise.all([wlOf(a), wlOf(b)]);
    const wl = Math.max(wlA ?? 0, wlB ?? 0);
    ok('a rank the party earns mid-run raises their world level',
      wl > (wlBefore ?? 0) && wlA === wlB, `AR ${pa.rank}→16: WL ${wlBefore} → ${wlA}|${wlB}`);

    const nChA = ca.got(S2C.CHAMBER).length, nChB = cb.got(S2C.CHAMBER).length;
    const nErrB = cb.got(S2C.ERROR).length;
    ca.send(C2S.START_CHAMBER, { floor: 1 });
    ok('the party can start the floor it just lost',
      !!(await waitAfter(ca, S2C.CHAMBER, nChA, (m) => m.state === 'start' && m.floor === 1, 6000)));
    await sleep(5000);

    const floor1 = ZONES[DUNGEON].chambers.find((c) => c.floor === 1);
    const wantLv = Math.round(floor1.level * (1 + 0.06 * wl));
    const arrivals = (snap(ca)?.enemies || []).map((e) => e.lv);
    ok('...and that world level reaches the shard, not the one they walked in with',
      arrivals.length > 0 && arrivals.every((l) => l === wantLv),
      `WL ${wl}: lv ${floor1.level} × ${(1 + 0.06 * wl).toFixed(2)} = ${wantLv},`
      + ` arrived ${arrivals.join('/') || 'nothing'}`);

    // A run in progress is not restartable, and in co-op that rule protects somebody else's
    // fight: `startChamber` *is* the reset (it empties the arena, respawns wave 1 and
    // re-anchors the clock), so before the guard any teammate could throw away the party's
    // 80th second — or a stray click in the map panel's floor list could, since it stays
    // clickable during a run. The refusal is not enough on its own: the clock has to still be
    // the old clock and the wave has to still be the same entities.
    const clockBefore = snap(cb)?.chamber?.timeLeft ?? 0;
    const waveBefore = new Set((snap(cb)?.enemies || []).map((e) => e.id));
    const t0 = Date.now();
    cb.send(C2S.START_CHAMBER, { floor: 1 });
    const refusedRestart = await waitAfter(cb, S2C.ERROR, nErrB,
      (e) => e.error === 'chamber_in_progress', 5000);
    await sleep(1200);
    const clockAfter = snap(cb)?.chamber?.timeLeft ?? 0;
    const elapsed = (Date.now() - t0) / 1000;
    const waveAfter = new Set((snap(cb)?.enemies || []).map((e) => e.id));
    ok('a teammate cannot restart the run that is already going',
      !!refusedRestart, JSON.stringify(refusedRestart || null));
    // "The clock kept running" is not the same statement as "the clock went down": a run that
    // restarts at 90 s and is read 6 s later is *also* lower than the 85 s it was at. So the
    // drop has to match the wall time that passed — a reset shows up as a drop far smaller
    // than the wait, or negative. The wave is the other half: `startChamber` respawns wave 1,
    // so a restart changes the entity ids even when the count is the same.
    ok('...and the refusal left the clock and the wave alone',
      clockBefore > 0 && Math.abs((clockBefore - clockAfter) - elapsed) < 2
      && waveBefore.size > 0 && waveAfter.size === waveBefore.size
      && [...waveAfter].every((id) => waveBefore.has(id)),
      `${clockBefore}s → ${clockAfter}s left over ${elapsed.toFixed(1)}s of waiting,`
      + ` wave ${waveBefore.size}→${waveAfter.size} entities,`
      + ` ${[...waveAfter].filter((id) => waveBefore.has(id)).length} of them the same`);
    ok('...and nobody was told the run restarted',
      ca.got(S2C.CHAMBER).slice(nChA).filter((m) => m.state === 'start').length === 1
      && cb.got(S2C.CHAMBER).slice(nChB).filter((m) => m.state === 'start').length === 1,
      `A ${ca.got(S2C.CHAMBER).slice(nChA).filter((m) => m.state === 'start').length}`
      + ` B ${cb.got(S2C.CHAMBER).slice(nChB).filter((m) => m.state === 'start').length} starts`);

    // Now fight it. Both players, every wave, aim re-derived from the target's current
    // position on every swing — the enemies are walking towards whoever they are angry at.
    const done = () => ca.got(S2C.CHAMBER).slice(nChA)
      .find((m) => m.state === 'cleared' || m.state === 'failed');
    const until = Date.now() + 100000;
    while (Date.now() < until && !done()) {
      for (const [c, acc] of [[ca, a], [cb, b]]) {
        const me = posOf(c, acc);
        if (!me || me.al !== 1) continue;
        const live = (snap(c)?.enemies || []).filter((e) => e.a === 1);
        if (!live.length) continue;   // the 4 s gap between waves
        const e = live.map((x) => ({ ...x, d: Math.hypot(x.x - me.x, x.z - me.z) }))
          .sort((p, q) => p.d - q.d)[0];
        const dx = e.x - me.x, dz = e.z - me.z;
        const d = Math.hypot(dx, dz) || 1;
        if (d > 3) {
          const step = Math.min(1.6, d - 2.2);
          c.send(C2S.INPUT, {
            x: me.x + (dx / d) * step, z: me.z + (dz / d) * step, y: me.y ?? 0,
            ry: Math.atan2(dx, dz), a: 2, st: 240,
          });
        }
        c.send(C2S.ATTACK, { dir: [dx / d, 0, dz / d] });
      }
      await sleep(200);
    }
    const clearedA = ca.got(S2C.CHAMBER).slice(nChA).find((m) => m.state === 'cleared');
    const clearedB = cb.got(S2C.CHAMBER).slice(nChB).find((m) => m.state === 'cleared');
    ok('the party cleared the floor, and both were told',
      !!clearedA && !!clearedB && clearedA.stars >= 1 && clearedA.stars === clearedB.stars,
      `${clearedA?.time}s → ${clearedA?.stars}★ (A) / ${clearedB?.time}s → ${clearedB?.stars}★ (B)`);

    // The payment. One reward message per socket, each with that player's own numbers — this
    // is the assertion `handleChamberClear` exists for, and the one nothing could reach.
    const rewardA = await waitAfter(ca, S2C.CHAMBER, nChA, (m) => m.state === 'reward', 9000);
    const rewardB = await waitAfter(cb, S2C.CHAMBER, nChB, (m) => m.state === 'reward', 9000);
    ok('a cleared run pays every player in the instance, not the one who pressed start',
      !!rewardA && !!rewardB, `A ${rewardA ? 'paid' : 'nothing'} / B ${rewardB ? 'paid' : 'nothing'}`);
    ok('...the star reward is real on both sockets',
      (rewardA?.reward?.primogem || 0) === (clearedA?.stars || 0) * 20
      && (rewardB?.reward?.primogem || 0) === (clearedB?.stars || 0) * 20
      && (rewardA?.reward?.mora || 0) > 0 && (rewardB?.reward?.mora || 0) > 0,
      `A ${JSON.stringify(rewardA?.reward)} / B ${JSON.stringify(rewardB?.reward)}`);
    // Resin is the limiter on the drop, and it is charged *per player*: a fresh account
    // starts at 160 and a 秘境 costs `DOMAIN_RESIN`, so each of them pays their own 20 and
    // each of them gets their own roll. Two players clearing together must not share one
    // charge (which would make co-op a way to farm for free) and must not pay twice.
    ok('...and each of them paid their own resin for their own drop',
      [rewardA, rewardB].every((r) => r.resin?.cost === 20 && r.resin?.spent === 20
        && r.resin?.left === 140 && r.player?.resin === 140
        && Object.keys(r.drops?.items || {}).length > 0),
      `A ${JSON.stringify(rewardA?.resin)} drops ${JSON.stringify(rewardA?.drops?.items)}`
      + ` / B ${JSON.stringify(rewardB?.resin)} drops ${JSON.stringify(rewardB?.drops?.items)}`);
    ok('...and both banked adventure xp for it',
      (rewardA?.ar?.adventureRank || 0) > 0 && (rewardB?.ar?.adventureRank || 0) > 0,
      `A ${JSON.stringify(rewardA?.ar)} / B ${JSON.stringify(rewardB?.ar)}`);

    // The record has to be in the *save*, or the floor re-locks on the next login and the
    // teammate's 3★ was a toast. Read back over REST, which is a different door from the
    // socket the reward arrived on.
    const recOf = async (acc) => (await rest(acc.token, '/api/player/state'))
      .b.player?.abyss?.[DUNGEON]?.['1'];
    const [recA, recB] = await Promise.all([recOf(a), recOf(b)]);
    ok('the clear is recorded for both players, including the one who pressed nothing',
      recA?.stars === clearedA?.stars && recB?.stars === clearedB?.stars
      && recA?.bestTime > 0 && recB?.bestTime > 0,
      `A ${JSON.stringify(recA)} / B ${JSON.stringify(recB)}`);

    // And the gate the record opens is read from the *requester's* own save: earlier in this
    // section floor 2 was refused for A. B pressed nothing all run, so if the unlock had come
    // from the presser's record this is the request that would still be locked.
    const nChB2 = cb.got(S2C.CHAMBER).length;
    cb.send(C2S.START_CHAMBER, { floor: 2 });
    ok('floor 2 is now startable by the teammate who pressed nothing',
      !!(await waitAfter(cb, S2C.CHAMBER, nChB2, (m) => m.state === 'start' && m.floor === 2, 6000)));
  }

  // A party's instance has to outlive the party that opened it. The shard is named after the
  // leader, so once the leader walks out and the party re-forms under somebody else, the name a
  // joiner would *compute* (`p{new leader}`) is no longer the instance their teammate is
  // standing in. So the follow path joins the shard it resolved from the target instead of the
  // one matchmaking would pick — without that, following B below opens a second, empty copy of
  // the dungeon, and the two of them are alone in adjacent instances that look identical.
  {
    const nPb = cb.got(S2C.PARTY).length;
    ca.send(C2S.PARTY_LEAVE, {});
    const rosterB = await waitAfter(cb, S2C.PARTY, nPb, (m) => !!m.members, 5000);
    ok('the members who stayed are told somebody left',
      !!rosterB && !rosterB.members.some((m) => Number(m.playerId) === Number(a.playerId)),
      JSON.stringify(rosterB?.members?.map((m) => m.playerId) ?? null));

    // Out of the party and out of the dungeon, so the re-invite is a clean two-step.
    const nA3 = ca.got(S2C.ZONE_STATE).length;
    ca.send(C2S.JOIN_ZONE, { zone: ZONE });
    await waitAfter(ca, S2C.ZONE_STATE, nA3, (z) => z.zone === ZONE, 9000);
    const nPa = ca.got(S2C.PARTY).length;
    cb.send(C2S.PARTY_INVITE, { playerId: a.playerId });
    const inv = await waitAfter(ca, S2C.PARTY, nPa, (m) => !!m.invite, 6000);
    ok('the promoted leader can re-form the party',
      !!inv && Number(inv.invite.from) === Number(b.playerId), inv?.invite?.partyId);
    ca.send(C2S.PARTY_ACCEPT, { partyId: inv?.invite?.partyId });
    await sleep(900);

    const nA4 = ca.got(S2C.ZONE_STATE).length;
    ca.send(C2S.JOIN_ZONE, { zone: ZONE, follow: b.playerId });
    const za2 = await waitAfter(ca, S2C.ZONE_STATE, nA4, (z) => z.zone === DUNGEON, 9000);
    ok('the 秘境 instance outlives the party that opened it',
      !!za2 && String(za2.shard) === String(zb?.shard),
      `${za2?.zone}#${za2?.shard} vs the instance B is in, ${zb?.zone}#${zb?.shard}`);
    await sleep(1400);
    ok('...and they are in it together, not in two identical empty ones',
      seesOther(ca, b) && seesOther(cb, a),
      `A sees B: ${seesOther(ca, b)}, B sees A: ${seesOther(cb, a)}`);
  }

  // Leaving the 秘境 has to hand the player back to the shared world. This is the assertion
  // that catches the latched flag: with `world.solo` set by dungeon entry, A came back to a
  // private 蒙德 and B — standing in the public one — was gone for the rest of the session.
  const nA2 = ca.got(S2C.ZONE_STATE).length;
  ca.send(C2S.JOIN_ZONE, { zone: ZONE });
  const back = await waitAfter(ca, S2C.ZONE_STATE, nA2, (z) => z.zone === ZONE, 9000);
  ok('leaving the 秘境 returns the player to a public shard',
    !!back && !String(back.shard).startsWith('p') && back.mode === 'online',
    `${back?.zone}#${back?.shard} mode=${back?.mode}`);
  const nB2 = cb.got(S2C.ZONE_STATE).length;
  cb.send(C2S.JOIN_ZONE, { zone: ZONE, follow: a.playerId });
  const backB = await waitAfter(cb, S2C.ZONE_STATE, nB2, (z) => z.zone === ZONE, 9000);
  ok('...where the teammate can still find them',
    !!backB && String(backB.shard) === String(back?.shard),
    `${backB?.zone}#${backB?.shard} vs ${back?.zone}#${back?.shard}`);
  await sleep(1400);
  ok('and they are back in one snapshot together', seesOther(ca, b) && seesOther(cb, a),
    `A sees B: ${seesOther(ca, b)}, B sees A: ${seesOther(cb, a)}`);
}

/* ------------------------------------------- 元素战技 cooldowns, per character -- */
// The rotation every elemental reaction is made of: 附着 with one character, switch, 触发 with
// the next, inside the aura's few seconds. The simulation has always keyed cooldowns by character
// (`PlayerEntity.cooldowns` is `${charId}:skill`), but nothing on the wire carried them — so the
// client kept one `skillCd` for whoever stood on the field and handed it to the incoming
// character on a switch. Six seconds into 伊格纳's eight-second cooldown, 莉拉's skill was
// refused by her own client and the press produced nothing at all: no packet, no reaction, and a
// HUD ring counting down someone else's number. `tools/react-check.mjs` spent five runs looking
// for a whiffed aim. This is the wire half of the fix; the browser half is that probe's section 4.
//
// Last on purpose: it is the only section that switches A's character, so nothing that follows
// can be reading a party member it did not expect.
{
  const chars = Object.keys(ca.welcome?.stats || {});
  const first = ca.welcome?.you?.c;
  const second = chars.find((c) => c !== first);
  const cdsOf = () => snap(ca)?.cds || {};
  ok('a starter party has two characters to rotate between', !!first && !!second,
    `${first} / ${second} of ${chars.length}`);
  ok('nothing is on cooldown before anything is cast', !cdsOf()[`${first}:skill`],
    JSON.stringify(cdsOf()));
  ca.send(C2S.SKILL, { dir: [0, 0, 1] });
  await sleep(800);
  ok(`${first}'s skill goes on cooldown under its own key`, cdsOf()[`${first}:skill`] > 0,
    JSON.stringify(cdsOf()));
  ca.send(C2S.SWITCH_CHAR, { charId: second });
  await sleep(800);
  const after = cdsOf();
  ok('...and the switch leaves the incoming character ready',
    after[`${first}:skill`] > 0 && !after[`${second}:skill`], JSON.stringify(after));
  // And the sim accepts the cast that used to be dropped client-side. `PLAYER_ACTION` naming the
  // second character is the receipt; an `on_cooldown` would come back as an ERROR.
  const acts0 = ca.got(S2C.PLAYER_ACTION).length, errs0 = ca.got(S2C.ERROR).length;
  ca.send(C2S.SKILL, { dir: [0, 0, 1] });
  await sleep(800);
  const acted = ca.got(S2C.PLAYER_ACTION).slice(acts0).filter((m) => m.action === 'skill');
  const refused = ca.got(S2C.ERROR).slice(errs0);
  ok(`the sim casts ${second}'s skill while ${first} is still cooling`,
    acted.some((m) => m.charId === second) && refused.length === 0,
    `${acted.length} skill action(s) ${JSON.stringify(acted.map((m) => m.charId))},`
    + ` errors ${JSON.stringify(refused).slice(0, 120)}`);
  const both = cdsOf();
  ok('...and the two cooldowns then run side by side',
    both[`${first}:skill`] > 0 && both[`${second}:skill`] > 0, JSON.stringify(both));
}

// Leaving must be announced too, so a client can drop the remote avatar.
cb.ws.close();
const left = await waitFor(ca, S2C.PLAYER_LEAVE, 6000);
ok('A sees B leave', !!left?.some((l) => Number(l.playerId) === Number(b.playerId)));

// Every error the run provoked on purpose is named in `expectedErrors`; anything else
// arriving on either socket is a real protocol failure.
const errs = ca.got(S2C.ERROR).concat(cb.got(S2C.ERROR))
  .filter((e) => !expectedErrors.has(e.error));
ok('no unexpected protocol errors', errs.length === 0, JSON.stringify(errs).slice(0, 200));

ca.ws.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length);
