// 秘境打深: the eight floors of 深渊试炼场, actually played, in co-op, to the bottom.
//
// Why this exists. 「多个游戏场景和关卡」 has one dungeon with eight authored floors, and until
// this probe the deepest thing any gate had *played* was floor 2 of it. `chamber-check` drives
// floor 2 in-process with a 1e9-damage `killAll`, `mp-check` clears floor 1 with two level-40
// guests, and `balance-check` grades the star thresholds against a parity model on paper. So
// three things the repo's own 「已知限制」 lists first had no receipt at all:
//
//   · the **3★ time gate** — nothing had ever cleared a floor inside its fastest band, so
//     `stars: [430,295,200]` on floor 8 was an authored number nobody had beaten;
//   · the **deeper 地脉异变** — five disorders are placed on floors 2–8 and only the two on
//     floors 1–2 had ever been installed by a running instance;
//   · the **boss floors** — `phases: 2/3`, the herald's water shield and the stagger that comes
//     with a phase change are computed in `Enemy.takeDamage`, and no probe had ever taken a boss
//     below two thirds of its health;
//   · and the 分账 — `chamberMilestone` prices each star as a share of the floor's own total, so
//     1★ → 3★ must cost the economy exactly what one 3★ clear costs it. That arithmetic was
//     tested as a pure function and had never been paid out by a server to two players.
//
// How it plays. Two guest accounts, armed through the *real* growth routes (`/api/dev/supply`
// hands over materials priced by the same cost tables a player pays, and every level, ascension,
// weapon level, artifact and dish after that is bought through the route the panel clicks), then
// a party, a private dungeon shard, and a fight loop that plays like a player rather than like a
// damage script:
//
//   · it **steps out of the telegraph**. `attackShape` is the same function the server tests
//     damage with, so leaving the disc means exactly what it says. Only the heavy moves are
//     dodged (`mult >= DODGE_MULT`): dodging the chip-damage AoEs as well costs so much uptime
//     that a boss out-heals the party — the first version of this loop turned a 45 s herald into
//     a 234 s one, which is the difference between 3★ and 1★.
//   · it **brings the right element**. 暴风之主 resists wind 0.95; a probe that fights it with
//     the wind starter is measuring the resistance table, not the floor.
//   · it eats, and it **picks its teammate up** — the free co-op revive, which is the mechanic
//     that makes floor 8 survivable at all.
//
// The one thing it constructs rather than plays is the 分账 receipt: floor 1 is cleared *slowly*
// on purpose (kite the last enemy of the last wave until the server's own chamber clock is inside
// the 1★ band), then quickly, then quickly again — so one floor pays a first star, then the
// difference up to three, then nothing at all, and the three payments can be added up.
//
// What it found on its first run: floors 5–8 spawned enemies scaled by the world level the party
// had walked in with (lv 68 = WL 6) while both saves had already been carried to WL 7 by the
// clears themselves. `playerCache.getPlayer(id, {fresh:true})` installed a *second* copy of the
// save in the cache, and the running shard reads the object it was handed at join
// (`p.save.worldLevel`) — so one `GET /api/player/state` detached the simulation from the save.
// Fixed by refreshing that object in place; `mp-check` now gates it in ten seconds.
//
//   DISPLAY unnecessary; node tools/deep-check.mjs [host] [firstFloor] [lastFloor]
//
// Exit code is the number of failed assertions. Runs for ~15 minutes: it is eleven real fights.

import { C2S, S2C } from '../shared/src/protocol.js';
import { ZONES, chamberStars, chamberMilestone } from '../shared/src/data/zones.js';
import { DISORDERS, disorderInfo } from '../shared/src/data/disorders.js';
import { ENEMIES, ATTACK_MOVES, attackShape } from '../shared/src/data/enemies.js';
import { CHARACTERS } from '../shared/src/data/characters.js';
import { maxPortions } from '../shared/src/data/recipes.js';
import { ARTIFACT_SLOTS } from '../shared/src/data/items.js';
import { enemyStatAtLevel } from '../shared/src/sim/formulas.js';

const HOST = process.argv[2] || '127.0.0.1:8787';
const DUNGEON = 'abyssTrial';
// Where the party shops for the artifacts the welcome kit does not cover — deliberately not the
// dungeon under test, so nothing this probe asserts about `abyssTrial`'s save is self-inflicted.
const FARM = 'frostCavern';
const FIRST = Number(process.argv[3] || 1);
const LAST = Number(process.argv[4] || 8);
// AR 35 is the operating point, not a round number: `arCap(35) = 90` (the character cap) while
// `worldLevel = floor((35-1)/5) = 6`. One rank higher is world level 7, which scales every enemy
// in the dungeon by another 6% for no extra character level — the party gets *weaker* at AR 36.
const RANK = 35;
const LEVEL = 90;

const fails = [];
const skips = [];
let passed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (cond) passed++; else fails.push(name);
};
const skip = (name, why) => { console.log(`SKIP ${name}  ${why}`); skips.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ clients -- */

async function rest(token, path, body) {
  const r = await fetch(`http://${HOST}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, b: await r.json().catch(() => ({})) };
}
async function guest(tag) {
  const r = await fetch(`http://${HOST}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  if (!r.ok) throw new Error(`guest ${tag}: HTTP ${r.status}`);
  const j = await r.json();
  return { tag, token: j.token, playerId: j.player?.id ?? j.playerId };
}
function connect(acc) {
  const ws = new WebSocket(`ws://${HOST}/ws?token=${encodeURIComponent(acc.token)}`);
  const c = {
    ...acc, ws, by: new Map(), welcome: null, y: 0, bag: {}, party: [],
    got(t) { return this.by.get(t) || []; },
    send(t, d) { if (ws.readyState === 1) ws.send(JSON.stringify({ t, d })); },
  };
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (!c.by.has(m.t)) c.by.set(m.t, []);
    c.by.get(m.t).push(m.d);
    if (m.t === S2C.WELCOME) c.welcome = m.d;
  });
  return new Promise((res, rej) => {
    ws.addEventListener('open', () => res(c));
    ws.addEventListener('error', (e) => rej(new Error(`${acc.tag}: ${e.message || 'refused'}`)));
  });
}
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
const meOf = (c) => snap(c)?.players?.find((p) => Number(p.id) === Number(c.playerId));

/* ---------------------------------------------------------------------- arm -- */

/**
 * Take an account to level 90 with a stocked kitchen, spending only through the routes a
 * player clicks. Nothing here writes a level or a stat: if a growth route is broken the party
 * stays weak and the floors below stay red, which is the correct outcome.
 */
async function arm(acc) {
  await rest(acc.token, '/api/dev/rank', { rank: RANK });
  await rest(acc.token, '/api/dev/supply', { level: LEVEL });
  const st0 = (await rest(acc.token, '/api/player/state')).b.player || {};
  for (const charId of Object.keys(st0.characters || {})) {
    // Levels and ascensions alternate: `levelUpCharacter` stops at the ascension cap and the
    // next ascension is what raises it, so one pass of each is not enough.
    for (let round = 0; round < 8; round++) {
      const lv = await rest(acc.token, '/api/char/levelup', { charId, materials: { heroWit: 99999 } });
      if ((lv.b?.level || 0) >= LEVEL) break;
      if ((await rest(acc.token, '/api/char/ascend', { charId })).status !== 200) break;
    }
  }
  const mid = (await rest(acc.token, '/api/player/state')).b.player || {};
  for (const w of (mid.equipment || []).filter((e) => e.kind === 'weapon')) {
    await rest(acc.token, '/api/inventory/weapon/levelup', { uid: w.uid, ore: { ironChunk: 999999 } });
  }
  await dress(acc);
  return kitchen(acc);
}

/**
 * Dress the whole party, not just whoever `autoequip` was called for first.
 *
 * The welcome kit is five artifacts — one per slot — and `autoequip` hands a character the best
 * piece per slot that nobody else is already wearing. So the first character it runs for takes
 * all five and the second one walks into a level-99 floor in nothing: base 5 % crit against
 * lyra's 29 %, and the probe's own `bestCharFor` puts it in whenever the target resists the
 * other element. Artifacts come from domains, so the party buys the rest from the two dungeons
 * that are *not* under test — the product's own claim route, at the product's own 20 resin,
 * leaving the `abyssTrial` save this probe asserts on untouched.
 */
async function dress(acc) {
  let bought = 0;
  for (let round = 0; round < 10; round++) {
    const before = (await rest(acc.token, '/api/player/state')).b.player || {};
    for (const charId of Object.keys(before.characters || {})) {
      await rest(acc.token, '/api/char/autoequip', { charId });
    }
    const after = (await rest(acc.token, '/api/player/state')).b.player || {};
    const short = Object.values(after.characters || {})
      .filter((c) => Object.keys(c.artifacts || {}).length < ARTIFACT_SLOTS.length).length;
    if (!short) break;
    // The bar is a clock and this is a probe, so rewind it rather than mint anything: the claim
    // still pays its own resin out of a bar that regenerated at the authored rate.
    await rest(acc.token, '/api/dev/resin-rewind', { seconds: 7 * 24 * 3600 });
    for (let i = 0; i < 5; i++) {
      const r = await rest(acc.token, '/api/world/chamber', { zone: FARM, floor: 1, time: 1 });
      if (r.status !== 200 || r.b?.error) break;
      bought += (r.b.drops?.artifacts || []).length;
    }
  }
  return bought;
}

/**
 * Buy ingredients with whatever mora is on hand and cook. Called between floors, because the
 * mora for the next kitchen is what the last floors paid — and because the shop's daily limits
 * cap the whole day's food at 30 of each ingredient, which is what keeps this honest.
 */
async function kitchen(acc) {
  for (const [entryId, count] of [
    ['gen_sweetFlower', 6], ['gen_wheat', 6], ['gen_mint', 6], ['gen_mushroom', 6],
    ['gen_reviveDish', 2],
  ]) {
    await rest(acc.token, '/api/shop/buy', { shopId: 'general', entryId, count });
  }
  let inv = ((await rest(acc.token, '/api/player/state')).b.player || {}).inventory || {};
  // The atk buff and the big heal before the small one: sweet madame is what the leftovers
  // become, not what the mint gets spent on.
  for (const id of ['mintJelly', 'northernStew', 'sweetMadame']) {
    const n = Math.min(20, maxPortions(id, inv, id === 'mintJelly' ? 4 : 20));
    if (n < 1) continue;
    const r = await rest(acc.token, '/api/player/cook', { recipeId: id, count: n });
    inv = (r.status === 200 && r.b.inventory)
      || ((await rest(acc.token, '/api/player/state')).b.player || {}).inventory || inv;
  }
  const fin = (await rest(acc.token, '/api/player/state')).b.player || {};
  return {
    player: fin,
    chars: Object.entries(fin.characters || {}).map(([k, v]) => `${k}@${v.level}`).join(' '),
    maxLevel: Math.max(0, ...Object.values(fin.characters || {}).map((v) => v.level || 0)),
    weapons: (fin.equipment || []).filter((e) => e.kind === 'weapon').map((e) => e.level),
    arts: (fin.equipment || []).filter((e) => e.kind === 'artifact' && e.equippedBy).length,
    // Per character, because the total says nothing about who is wearing it: five pieces is a
    // dressed main and a naked swap partner just as easily as it is two half-dressed characters.
    worn: Object.entries(fin.characters || {})
      .map(([id, c]) => `${id}:${Object.keys(c.artifacts || {}).length}`),
    food: ['sweetMadame', 'northernStew', 'mintJelly', 'reviveDish']
      .reduce((s, i) => s + (fin.inventory?.[i] || 0), 0),
    bag: fin.inventory || {},
    worldLevel: fin.worldLevel, rank: fin.adventureRank, resin: fin.resin,
  };
}

/* -------------------------------------------------------------------- fight -- */

const REACH = 2.4;
const REVIVE_RANGE = 4;          // shared/world/entity.js
const DODGE_MULT = 1.4;          // dodge the heavy moves; eat the chip damage
const HEALS = ['northernStew', 'sweetMadame', 'mushroomPizza', 'suspiciousFood'];

/** Telegraphs seen so far → the ground that is about to hurt. */
function ingestTelegraphs(c) {
  const evs = c.got(S2C.ENEMY_ATTACK);
  c._danger = c._danger || new Map();
  for (let i = c._teleIdx || 0; i < evs.length; i++) {
    const ev = evs[i];
    const mv = ATTACK_MOVES[ev.move];
    if (!mv || ev.phase !== 'windup') continue;
    if (mv.projectile || mv.summon || (mv.mult || 0) < DODGE_MULT) continue;
    const sh = attackShape(mv, {});
    if (!sh?.hit) continue;
    c._danger.set(ev.id, {
      r: sh.hit, dash: !!mv.dash, move: ev.move,
      until: Date.now() + (mv.windup + (mv.active || 0.2)) * 1000 + 150,
    });
  }
  c._teleIdx = evs.length;
  for (const [id, d] of c._danger) if (Date.now() > d.until) c._danger.delete(id);
}

/** The live telegraph whose shape currently covers me, if any. */
function threat(c, s, me) {
  for (const [id, d] of c._danger || []) {
    const e = (s.enemies || []).find((x) => x.id === id && x.a === 1);
    if (!e) continue;
    const dist = Math.hypot(e.x - me.x, e.z - me.z);
    if (dist < d.r + 1.2) return { e, ...d, dist };
  }
  return null;
}

/**
 * The party member this target resists least. Normal attacks are physical either way, so what
 * this decides is where the skill and burst damage lands: 0.95 wind resistance on 暴风之主 is
 * the difference between a cleared floor and a wipe.
 */
function bestCharFor(c, target, cur) {
  const res = ENEMIES[target?.t]?.res || {};
  let best = cur, score = -Infinity;
  for (const charId of c.party || []) {
    const el = CHARACTERS[charId]?.element;
    // The incumbent wins ties, or the loop swaps characters every tick and neither ever swings.
    const v = 1 - (res[el] || 0) + (charId === cur ? 0.001 : 0);
    if (v > score) { score = v; best = charId; }
  }
  return best;
}

const move = (c, me, x, z, ry, action = 2) =>
  c.send(C2S.INPUT, { x, z, y: me.y ?? 0, ry, a: action, st: 220 });

/**
 * One tick of one client's fight. `hold` means "do not kill the last thing standing" — the
 * deliberate stall that constructs a slow clear.
 */
function fightTick(c, opts = {}) {
  const s = snap(c);
  const me = meOf(c);
  if (!s || !me) return;
  ingestTelegraphs(c);
  const now = Date.now();
  const bag = c.bag;

  if (!me.al) {
    if (now - (c._deadAt || 0) > 2500) {
      c._deadAt = now; c.stat.deaths++;
      // A dish stands you up where you fell; without one the only way back is the anchor,
      // which is a 50 m walk out of the arena.
      if ((bag.reviveDish || 0) > 0) { bag.reviveDish--; c.send(C2S.REVIVE, {}); } else c.send(C2S.RESPAWN, {});
    }
    return;
  }
  // Picking a teammate up is free and is the reason two players clear what one cannot.
  const mate = (s.players || []).find((p) => Number(p.id) !== Number(c.playerId) && !p.al);
  if (mate) {
    const d = Math.hypot(mate.x - me.x, mate.z - me.z) || 1;
    if (d <= REVIVE_RANGE) { c.stat.rescues++; c.send(C2S.REVIVE, { playerId: Number(mate.id) }); } else {
      const step = Math.min(3.0, d - 1.5);
      move(c, me, me.x + ((mate.x - me.x) / d) * step, me.z + ((mate.z - me.z) / d) * step,
        Math.atan2(mate.x - me.x, mate.z - me.z), 3);
    }
    return;
  }

  if (me.hp < me.mhp * 0.72 && now - (c._healAt || 0) > 1400) {
    const dish = HEALS.find((i) => (bag[i] || 0) > 0);
    if (dish) { bag[dish]--; c._healAt = now; c.stat.heals++; c.send(C2S.USE_ITEM, { itemId: dish }); }
  }
  if ((bag.mintJelly || 0) > 0 && now - (c._buffAt || 0) > 290000) {
    bag.mintJelly--; c._buffAt = now; c.stat.buffs++;
    c.send(C2S.USE_ITEM, { itemId: 'mintJelly' });
  }

  const all = (s.enemies || []).filter((e) => e.a === 1);
  if (!all.length) return;
  // Killing a summon advances nothing. A chamber owns exactly the ids its own wave spawned
  // (`_spawnWave` sets `c.ids`), and `abyssHerald`'s `summonMinions` drops three more bodies in
  // the arena every few moves with no cap — so "attack the nearest live enemy" spends a boss
  // floor on slimes while the thing the clock is waiting for stands untouched. A player ignores
  // them; told which types the wave asked for, so does this. Everything else — the dodge, the
  // element pick — still sees every enemy in the arena.
  const owned = opts.wanted ? all.filter((e) => opts.wanted.has(e.t)) : all;
  const live = owned.length ? owned : all;
  const target = live.map((e) => ({ ...e, d: Math.hypot(e.x - me.x, e.z - me.z) }))
    .sort((p, q) => p.d - q.d)[0];

  // Step out of the ring that is closing. Same `attackShape` the server resolves the hit with.
  const th = threat(c, s, me);
  if (th) {
    c.stat.dodges++;
    const ax = me.x - th.e.x, az = me.z - th.e.z;
    const len = Math.hypot(ax, az) || 1;
    // A dash sweeps a lane along its facing, so sideways leaves it; a disc is left radially.
    const dir = th.dash ? [-az / len, ax / len] : [ax / len, az / len];
    const step = Math.min(3.2, th.r + 3.0 - th.dist);
    const nx = me.x + dir[0] * step, nz = me.z + dir[1] * step;
    if (step > 0.2 && Math.abs(nx) < 78 && Math.abs(nz) < 78) {
      move(c, me, nx, nz, Math.atan2(th.e.x - me.x, th.e.z - me.z), 3);
      return;
    }
  }

  if (opts.hold) {
    // Stall: stay alive and out of reach of the last thing standing, and land nothing on it.
    const ax = me.x - target.x, az = me.z - target.z;
    const len = Math.hypot(ax, az) || 1;
    if (len < 16) {
      const nx = me.x + (ax / len) * 2.6, nz = me.z + (az / len) * 2.6;
      if (Math.abs(nx) < 78 && Math.abs(nz) < 78) move(c, me, nx, nz, Math.atan2(ax, az), 3);
    }
    return;
  }

  // Bring the element the target does not resist; a nearly dead character leaves the field.
  const want = me.hp < me.mhp * 0.3 ? (c.party || []).find((p) => p !== me.c)
    : bestCharFor(c, target, me.c);
  if (want && want !== me.c && now - (c._swapAt || 0) > 1600) {
    c._swapAt = now; c.stat.swaps++;
    c.send(C2S.SWITCH_CHAR, { charId: want });
    return;
  }

  const dx = target.x - me.x, dz = target.z - me.z;
  const d = Math.hypot(dx, dz) || 1;
  const dir = [dx / d, 0, dz / d];
  if (d > REACH) {
    const step = Math.min(3.0, d - REACH * 0.8);
    move(c, me, me.x + dir[0] * step, me.z + dir[2] * step, Math.atan2(dir[0], dir[2]));
  }
  c.stat.swings++;
  if (d <= REACH) c.stat.inReach++;
  c.send(C2S.ATTACK, { dir });
  if (now - (c._skillAt || 0) > 1200) { c._skillAt = now; c.send(C2S.SKILL, { dir }); }
  if ((me.en || 0) >= (CHARACTERS[me.c]?.burst?.cost ?? 60)) c.send(C2S.BURST, { dir });
}

/* ---------------------------------------------------------------------- run -- */

const zdef = ZONES[DUNGEON];
const defOf = (floor) => (zdef.chambers || []).find((c) => c.floor === floor);

const a = await guest('A');
const b = await guest('B');
const [armA, armB] = await Promise.all([arm(a), arm(b)]);
console.log(`A ${a.playerId} ${armA.chars} weapons ${armA.weapons} arts ${armA.arts} `
  + `food ${armA.food} AR ${armA.rank} WL ${armA.worldLevel}`);
console.log(`B ${b.playerId} ${armB.chars} weapons ${armB.weapons} arts ${armB.arts} `
  + `food ${armB.food} AR ${armB.rank} WL ${armB.worldLevel}`);

// The whole probe is downstream of this: a party that is not armed measures the arming, not the
// dungeon. It is an assertion rather than a precondition because every step of it is a product
// route — a broken `/api/char/ascend` has to be able to turn this red.
// `worn`, not `arts`: every character on the field wears a full set, so the fight below is not
// quietly decided by which of the two `autoequip` reached first.
const armedOk = [armA, armB].every((k) => k.maxLevel >= 89 && k.food > 0
  && k.worn.length >= 2 && k.worn.every((w) => Number(w.split(':')[1]) === 5)
  && Math.min(...k.weapons) >= 70 && k.rank === RANK && k.worldLevel === 6);
ok('two guests reach level 90 with gear and food through the real growth routes', armedOk,
  `A lv${armA.maxLevel}/w${armA.weapons}/${armA.worn.join('+')}/f${armA.food} `
  + `B lv${armB.maxLevel}/w${armB.weapons}/${armB.worn.join('+')}/f${armB.food}`);

// And the bookkeeping behind it. `autoequip` used to set `equippedBy` on the piece it put on
// without clearing it on the piece it took off, so an account that had auto-equipped twice
// carried rows claiming an owner who was wearing something else — fourteen "equipped" pieces
// across two five-slot characters. `equippedBy` is a refusal in five places (bulk salvage,
// enhancement fodder, the bag's 装备中 badge and its two pickers), so each stale row was a piece
// the player could neither wear nor spend.
for (const [tag, k] of [['A', armA], ['B', armB]]) {
  const on = k.worn.reduce((s, w) => s + Number(w.split(':')[1]), 0);
  ok(`${tag}: every artifact that claims an owner is being worn by them`, k.arts === on,
    `${k.arts} rows say equipped, ${on} are on a character (${k.worn.join(' ')})`);
}

await rest(a.token, '/api/social/request', { playerId: b.playerId });
await rest(b.token, '/api/social/accept', { playerId: a.playerId });

const ca = await connect(a);
const cb = await connect(b);
ca.bag = armA.bag; cb.bag = armB.bag;
ca.send(C2S.HELLO, { token: a.token, zone: 'mondstadt', mode: 'online' });
await waitAfter(ca, S2C.WELCOME, 0);
cb.send(C2S.HELLO, { token: b.token, zone: 'mondstadt', mode: 'online' });
await waitAfter(cb, S2C.WELCOME, 0);
ca.party = (await rest(a.token, '/api/player/state')).b.player.party;
cb.party = (await rest(b.token, '/api/player/state')).b.player.party;
ca.send(C2S.PARTY_INVITE, { playerId: b.playerId });
const invite = (await waitAfter(cb, S2C.PARTY, 0, (m) => m.invite, 6000))?.invite;
cb.send(C2S.PARTY_ACCEPT, { partyId: invite?.partyId });
await sleep(800);
ca.send(C2S.JOIN_ZONE, { zone: DUNGEON });
const za = await waitAfter(ca, S2C.ZONE_STATE, 0, (z) => z.zone === DUNGEON, 9000);
cb.send(C2S.JOIN_ZONE, { zone: DUNGEON, follow: a.playerId });
const zb = await waitAfter(cb, S2C.ZONE_STATE, 0, (z) => z.zone === DUNGEON, 9000);
ok('both players are in one private dungeon shard',
  !!za && !!zb && za.shard === zb.shard && String(za.shard).startsWith('p'),
  `${za?.shard} / ${zb?.shard}`);
await sleep(1200);

const clients = [ca, cb];
for (const c of clients) c.stat = {};
const resetStats = () => clients.forEach((c) => {
  // `swings` is every ATTACK sent, `inReach` the ones sent from close enough for the server's
  // own `attackShape` to be able to touch the target: the difference is time the party spent
  // walking, and a probe that only counts swings cannot tell a slow floor from a distant one.
  c.stat = { deaths: 0, rescues: 0, heals: 0, buffs: 0, dodges: 0, swaps: 0, swings: 0, inReach: 0 };
  c._danger = new Map(); c._buffAt = 0;
});

/** The record the save holds for a floor, read back over REST — not from the reward event. */
async function record(acc, floor) {
  const p = (await rest(acc.token, '/api/player/state')).b.player || {};
  return p.abyss?.[DUNGEON]?.[floor] || p.abyss?.[DUNGEON]?.[String(floor)] || { stars: 0 };
}

/**
 * Play one floor. Returns everything the assertions need: the start event, what the enemies
 * were when they arrived, the boss's phase log, the clear report and both reward events.
 */
async function playFloor(floor, opts = {}) {
  const def = defOf(floor);
  resetStats();
  for (const acc of [a, b]) {
    // The bar is a clock, and eight floors is two full bars. `resin-rewind` mints nothing: it
    // moves `resinAt` back and lets the authored regen run.
    await rest(acc.token, '/api/dev/resin-rewind', { seconds: 7 * 24 * 3600 });
    const k = await kitchen(acc);
    (acc === a ? ca : cb).bag = k.bag;
  }
  const wlBefore = Math.max(
    ((await rest(a.token, '/api/player/state')).b.player || {}).worldLevel || 0,
    ((await rest(b.token, '/api/player/state')).b.player || {}).worldLevel || 0,
  );
  const nA = ca.got(S2C.CHAMBER).length, nB = cb.got(S2C.CHAMBER).length;
  const nDmg = ca.got(S2C.DAMAGE).length;
  ca.send(C2S.START_CHAMBER, { floor });
  const start = await waitAfter(ca, S2C.CHAMBER, nA, (m) => m.state === 'start', 8000);
  if (!start) return { def, start: null, error: ca.got(S2C.ERROR).slice(-1)[0] || null };

  const t0 = Date.now();
  const firstWave = new Map();     // enemy id -> its snapshot as it arrived
  const phases = new Map();        // phase -> { hp fraction, at, state }
  const staggers = [];             // { at, ph } while the boss is stunned
  let boss = null;
  let bossShieldMax = 0;
  // Also the *minimum*, because "it was broken" and "no shield stands now" are two claims and
  // only the first one is about the arriving shield — see the assertion.
  let bossShieldMin = Infinity;
  let held = 0;
  // A floor's real cost is how many bodies had to be put down, not how much health the roster
  // authored: a summoner adds to the count while the fight runs, and nothing else in the probe
  // would ever notice.
  const census = new Map();        // enemy type -> how many distinct ids of it were ever alive
  const seenIds = new Set();
  let peakLive = 0;
  const done = () => ca.got(S2C.CHAMBER).slice(nA).find((m) => m.state === 'cleared' || m.state === 'failed');

  // `fightTick` sends one ATTACK per pass, so the loop's *period* is the party's DPS — and
  // `await sleep(TICK)` at the bottom of a body makes the period `TICK + however long the body
  // took`. Standalone the body costs ~20 ms; under the full suite it cost more, and every floor
  // ran 16–32 % slower for it (floor 6: 220.2 s alone, 262.2 s in the suite, across a 255 s 1★
  // bar). So the tick is scheduled against a deadline instead: the cadence is wall-clock, and if
  // the body ever outruns it the lateness is reported rather than silently stretching the fight.
  const TICK = 180;
  let due = Date.now(), ticks = 0, late = 0, lateMs = 0;

  while (!done() && Date.now() - t0 < (def.timeLimit + 60) * 1000) {
    const s = snap(ca);
    const sc = s?.chamber;
    // Every reading is gated on the producer's own view of which floor is running: a snapshot
    // from between two floors still carries the last floor's corpses.
    const mine = sc && sc.floor === floor && sc.state === 'running';
    const elapsed = mine ? def.timeLimit - sc.timeLeft : 0;
    if (mine) {
      let live = 0;
      for (const e of s.enemies || []) {
        if (e.a !== 1) continue;
        live++;
        if (!seenIds.has(e.id)) { seenIds.add(e.id); census.set(e.t, (census.get(e.t) || 0) + 1); }
        if (sc.wave === 1 && !firstWave.has(e.id)) firstWave.set(e.id, e);
        if (!ENEMIES[e.t]?.boss) continue;
        boss = e;
        bossShieldMax = Math.max(bossShieldMax, e.shm || 0);
        bossShieldMin = Math.min(bossShieldMin, e.sh ?? 0);
        if (!phases.has(e.ph)) {
          phases.set(e.ph, { frac: e.hp / e.mhp, at: +elapsed.toFixed(1), st: e.st, lv: e.lv, mhp: e.mhp });
        }
        if (e.st === 'stagger') staggers.push({ at: +elapsed.toFixed(1), ph: e.ph });
      }
      peakLive = Math.max(peakLive, live);
    }
    // The stall: hold only when the last wave is down to its last enemy, so the clock runs
    // with the floor genuinely unfinished rather than with a wave still walking in.
    const hold = !!opts.holdUntil && mine && sc.wave === sc.waves && sc.remaining === 1
      && elapsed < opts.holdUntil;
    if (hold) held++;
    // The roster the *current* wave asked for, by type — the snapshot names no owner, and a
    // wave only starts once the one before it is dead, so the type list is unambiguous.
    const wanted = mine ? new Set(def.waves[Math.max(0, sc.wave - 1)] || []) : null;
    for (const c of clients) fightTick(c, { hold, wanted });
    ticks++;
    due += TICK;
    const wait = due - Date.now();
    if (wait < 0) { late++; lateMs -= wait; due = Date.now(); }
    await sleep(Math.max(0, wait));
  }
  const secs = (Date.now() - t0) / 1000;
  const tick = { ticks, late, lateMs, hz: +(ticks / Math.max(0.001, secs)).toFixed(2) };
  const authored = def.waves.reduce((n, w) => n + w.length, 0);
  const roster = { authored, seen: seenIds.size, peakLive, census: [...census] };
  // What the swings were worth. A floor's clear time is `health / damage per second`, and when
  // the time is the thing under test the only way to tell a tanky floor from a probe that spent
  // the fight out of range is to price both halves.
  const hits = ca.got(S2C.DAMAGE).slice(nDmg).filter((d) => d.by && d.target === 'enemy');
  const dealt = hits.reduce((s, d) => s + (d.amount || 0), 0);
  const onBoss = boss ? hits.filter((d) => d.id === boss.id).reduce((s, d) => s + (d.amount || 0), 0) : 0;
  const damage = { hits: hits.length, dealt: Math.round(dealt), onBoss: Math.round(onBoss),
    dps: Math.round(dealt / Math.max(0.001, secs)) };
  const end = done();
  const rwA = await waitAfter(ca, S2C.CHAMBER, nA, (m) => m.state === 'reward', 9000);
  const rwB = await waitAfter(cb, S2C.CHAMBER, nB, (m) => m.state === 'reward', 9000);
  const brokeShield = boss && ca.got(S2C.DAMAGE).slice(nDmg)
    .some((d) => d.id === boss.id && d.shieldBroke);
  const wlAfter = Math.max(
    ((await rest(a.token, '/api/player/state')).b.player || {}).worldLevel || 0,
    ((await rest(b.token, '/api/player/state')).b.player || {}).worldLevel || 0,
  );
  return {
    def, start, end, rwA, rwB, firstWave, phases, staggers, boss, bossShieldMax, bossShieldMin,
    brokeShield, tick, roster, damage,
    held, wl: [wlBefore, wlAfter], wall: (Date.now() - t0) / 1000,
  };
}

/** The lines every clear has to answer for, whichever floor it was. */
function checkClear(r, prevStars, tag) {
  const { def, end, rwA, rwB } = r;
  const floor = def.floor;
  ok(`floor ${floor}${tag}: cleared`, end?.state === 'cleared',
    `${end?.state} time=${end?.time} wall=${r.wall.toFixed(0)}s boss=${r.boss ? `${r.boss.hp}/${r.boss.mhp}` : '—'}`);
  if (end?.state !== 'cleared') return null;

  // The margin, always, whether it passed or not: this assertion is calibrated against how fast
  // the probe fights, and the one number that says how close the calibration is running is the
  // distance to the 1★ bar. Printed with the achieved tick rate beside it, because that is what
  // moves it.
  const bar = def.stars[0];
  console.log(`     floor ${floor}${tag}: ${end.time}s of the ${bar}s 1★ bar`
    + ` (${((1 - end.time / bar) * 100).toFixed(0)}% margin) at ${r.tick.hz}/s`
    + (r.tick.late ? `, ${r.tick.late} of ${r.tick.ticks} ticks late by ${r.tick.lateMs} ms total` : ''));
  console.log(`     floor ${floor}${tag}: ${r.roster.seen} enemies put down for ${r.roster.authored}`
    + ` authored, at most ${r.roster.peakLive} at once —`
    + ` ${r.roster.census.map(([t, n]) => `${t}×${n}`).join(' ')}`);
  const sw = [ca, cb].map((c) => `${c.stat.inReach}/${c.stat.swings}`).join(' ');
  console.log(`     floor ${floor}${tag}: ${r.damage.hits} hits landed for ${r.damage.dealt}`
    + ` (${r.damage.dps}/s${r.damage.onBoss ? `, ${r.damage.onBoss} of it on the boss` : ''}),`
    + ` swings in reach ${sw}`);

  const expectStars = chamberStars(def, end.time);
  ok(`floor ${floor}${tag}: ${end.stars}★ is what ${end.time}s is worth`,
    end.stars === expectStars && end.stars >= 1,
    `thresholds ${JSON.stringify(def.stars)}`);
  // The band, from both sides: a star count is only meaningful if the time also fails to reach
  // the next one up.
  const nextUp = def.stars[end.stars] ?? null;   // stars is [1★,2★,3★], descending seconds
  ok(`floor ${floor}${tag}: the time sits inside the ${end.stars}★ band and misses the next`,
    end.time <= def.stars[end.stars - 1] && (nextUp === null || end.time > nextUp),
    `${end.time}s in (${nextUp ?? 0}, ${def.stars[end.stars - 1]}]`);

  const ms = chamberMilestone(def, prevStars, end.stars);
  ok(`floor ${floor}${tag}: the payout is the ${prevStars}★→${end.stars}★ share, not a floor's worth`,
    rwA?.reward?.primogem === ms.reward.primogem && rwA?.reward?.mora === ms.reward.mora,
    `paid ${JSON.stringify(rwA?.reward)} expected ${JSON.stringify(ms.reward)}`);
  ok(`floor ${floor}${tag}: the teammate who pressed nothing is paid the same`,
    !!rwB && rwB.reward?.primogem === rwA?.reward?.primogem && rwB.reward?.mora === rwA?.reward?.mora
    && rwB.stars === rwA?.stars,
    `B ${JSON.stringify(rwB?.reward)}`);
  ok(`floor ${floor}${tag}: 20 resin bought a drop for each of them`,
    rwA?.resin?.spent === 20 && rwB?.resin?.spent === 20
    && (rwA?.drops?.artifacts?.length ?? 0) > 0 && (rwB?.drops?.artifacts?.length ?? 0) > 0,
    `A ${JSON.stringify(rwA?.resin)} drops ${rwA?.drops?.artifacts?.length} / `
    + `B ${JSON.stringify(rwB?.resin)} drops ${rwB?.drops?.artifacts?.length}`);
  return ms;
}

/* --- the lock, before anything has been cleared -------------------------------- */

if (FIRST === 1) {
  const nErr = ca.got(S2C.ERROR).length;
  ca.send(C2S.START_CHAMBER, { floor: 2 });
  const refused = await waitAfter(ca, S2C.ERROR, nErr, () => true, 4000);
  ok('floor 2 refuses to start before floor 1 has a star',
    refused?.error === 'previous_floor_locked', JSON.stringify(refused));
  await sleep(400);
}

/* --- floor 1, three times: a star, the difference, and nothing ----------------- */

const seenDisorders = new Set();
const starsByFloor = new Map();
let walked = 0;
let deepest = 0;

if (FIRST === 1) {
  const def1 = defOf(1);
  // Inside the 1★ band and 6 s clear of both edges: `stars` is [50,35,25] and the server's own
  // chamber clock is what the stall watches, not this process's.
  const HOLD = Math.round((def1.stars[0] + def1.stars[1]) / 2);
  const slow = await playFloor(1, { holdUntil: HOLD });
  ok('the stall actually held the floor open', slow.held > 20 && (slow.end?.time ?? 0) > def1.stars[1],
    `${slow.held} ticks held, cleared at ${slow.end?.time}s (1★ band is (${def1.stars[1]}, ${def1.stars[0]}])`);
  const ms1 = checkClear(slow, 0, ' (slow)');
  ok('a slow first clear is worth exactly one star', slow.end?.stars === 1, `${slow.end?.stars}★`);

  const rec1 = await record(a, 1);
  ok('the star is in the save, not just in the event',
    rec1.stars === slow.end?.stars && rec1.bestTime === slow.end?.time,
    JSON.stringify(rec1));

  const fast = await playFloor(1);
  const ms2 = checkClear(fast, slow.end?.stars ?? 0, ' (fast)');
  ok('a faster clear improves the record to 3★', fast.end?.stars === 3, `${fast.end?.stars}★ at ${fast.end?.time}s`);
  if (ms1 && ms2) {
    const whole = chamberMilestone(def1, 0, 3);
    ok('1★ then 3★ costs the economy exactly one 3★ clear',
      ms1.reward.primogem + ms2.reward.primogem === whole.reward.primogem
      && ms1.reward.mora + ms2.reward.mora === whole.reward.mora
      && slow.rwA.reward.primogem + fast.rwA.reward.primogem === whole.reward.primogem
      && slow.rwA.reward.mora + fast.rwA.reward.mora === whole.reward.mora,
      `${slow.rwA.reward.primogem}+${fast.rwA.reward.primogem} vs ${whole.reward.primogem} 原石, `
      + `${slow.rwA.reward.mora}+${fast.rwA.reward.mora} vs ${whole.reward.mora} 摩拉`);
  } else skip('1★ then 3★ costs the economy exactly one 3★ clear', 'a floor-1 clear was missing');

  const again = await playFloor(1);
  if (again.end?.state === 'cleared') {
    // `chamberMilestone` returns an empty basket for a gained-nothing clear, so the assertion is
    // "nothing was paid" rather than "0 was paid" — the keys are absent, not zeroed.
    ok('a clear that beats no record pays no stars',
      !(again.rwA?.reward?.primogem || 0) && !(again.rwA?.reward?.mora || 0)
      && !(again.rwB?.reward?.primogem || 0) && !(again.rwB?.reward?.mora || 0),
      `${JSON.stringify(again.rwA?.reward)} at ${again.end.time}s vs record ${fast.end?.time}s`);
    ok('...but still spends resin and still drops an artifact',
      again.rwA?.resin?.spent === 20 && (again.rwA?.drops?.artifacts?.length ?? 0) > 0,
      `${JSON.stringify(again.rwA?.resin)} drops ${again.rwA?.drops?.artifacts?.length}`);
    const rec = await record(a, 1);
    ok('the record keeps the best clear, not the last',
      rec.stars === 3 && rec.bestTime === Math.min(fast.end?.time ?? 1e9, again.end.time),
      `${JSON.stringify(rec)} after ${again.end.time}s`);
  } else {
    skip('a clear that beats no record pays no stars', `floor 1 re-run ${again.end?.state}`);
  }
  starsByFloor.set(1, Math.max(slow.end?.stars || 0, fast.end?.stars || 0));
  if (fast.end?.state === 'cleared') { walked++; deepest = 1; }
}

/* --- the walk down ------------------------------------------------------------- */

for (const def of zdef.chambers.filter((c) => c.floor >= Math.max(2, FIRST) && c.floor <= LAST)) {
  const floor = def.floor;
  const prev = (await record(a, floor)).stars || 0;
  const r = await playFloor(floor);
  if (!r.start) {
    ok(`floor ${floor}: starts`, false, `no start event: ${JSON.stringify(r.error)}`);
    break;
  }

  // The floor announces itself: waves and the 地脉异变, both ways — floor 1 has none and every
  // floor below it does.
  const want = disorderInfo(def.disorder);
  ok(`floor ${floor}: the start event names ${def.waves.length} waves and ${def.disorder || 'no disorder'}`,
    r.start.floor === floor && r.start.waves === def.waves.length
    && r.start.timeLimit === def.timeLimit
    && JSON.stringify(r.start.disorder ?? null) === JSON.stringify(want),
    `${JSON.stringify(r.start.disorder)} vs ${JSON.stringify(want)}`);
  if (def.disorder) seenDisorders.add(def.disorder);

  // The 异变 measured on the enemies that walked in, not on the banner: `mhp` is
  // `enemyStatAtLevel(base.hp, lv) * hpMul` exactly, and `lv` comes off the snapshot because the
  // party's world level scales it and can move mid-run.
  const dz = DISORDERS[def.disorder] || {};
  const hpMul = dz.enemyHpMul || 1;
  const arrivals = [...r.firstWave.values()];
  const bad = arrivals.filter((e) => e.mhp !== Math.round(enemyStatAtLevel(ENEMIES[e.t].base.hp, e.lv) * hpMul));
  ok(`floor ${floor}: every arrival carries the ×${hpMul} 生命 the 异变 authored`,
    arrivals.length >= def.waves[0].length && bad.length === 0,
    `${arrivals.length} arrivals, ${bad.length} off: `
    + bad.slice(0, 2).map((e) => `${e.t}@${e.lv} ${e.mhp}`).join(' '));
  // And the other way: a disorder with no `enemyHpMul` must not quietly inflate anything.
  if (hpMul === 1 && arrivals.length) {
    const plain = arrivals.every((e) => e.mhp === enemyStatAtLevel(ENEMIES[e.t].base.hp, e.lv));
    ok(`floor ${floor}: ${def.disorder || 'no disorder'} leaves 生命 alone`, plain);
  }
  const wl = r.wl;
  const lvOk = arrivals.every((e) => wl.some((w) => e.lv === Math.round(def.level * (1 + 0.06 * w))));
  ok(`floor ${floor}: level ${def.level} arrives scaled by the party's world level`,
    arrivals.length > 0 && lvOk,
    `lv ${arrivals.map((e) => e.lv).join('/')} vs ${wl.map((w) => Math.round(def.level * (1 + 0.06 * w))).join('|')} (WL ${wl.join('→')})`);

  // Boss floors: the phases, the stagger that comes with each one, and the shield.
  if (def.boss) {
    const bdef = ENEMIES[r.boss?.t] || {};
    const n = bdef.phases || 0;
    ok(`floor ${floor}: the boss is a ${n}-phase ${r.boss?.t}`, !!r.boss && n >= 2,
      `${r.boss?.t} phases=${n} lv${r.boss?.lv}`);
    for (let k = 2; k <= n; k++) {
      const seen = r.phases.get(k);
      // `wanted = phases - floor(frac * phases)`, so phase k begins at or below this fraction.
      const boundary = (n - k + 1) / n;
      ok(`floor ${floor}: phase ${k} begins at or below ${(boundary * 100).toFixed(0)}% health`,
        !!seen && seen.frac <= boundary + 1e-9,
        seen ? `first seen at ${(seen.frac * 100).toFixed(1)}% (${seen.at}s, ${seen.st})` : 'never reached');
      const nearby = seen && r.staggers.some((s) => s.ph >= k && Math.abs(s.at - seen.at) <= 1.5);
      ok(`floor ${floor}: ...and it staggers when it does`, !!nearby,
        seen ? `staggers ${JSON.stringify(r.staggers.filter((s) => s.ph >= k).slice(0, 3))}` : '');
    }
    if (bdef.shield) {
      const expect = enemyStatAtLevel(bdef.shield.hp, r.boss.lv);
      // A shield standing at the end is not a shield that was never broken. The herald's own
      // `shieldSurge` carries `selfShield`, so it puts a fresh one up mid-fight and whichever
      // side of that the last snapshot lands on is decided by AI timing: this assertion read
      // `left=1800` on a floor it had cleared, with `broke=true` beside it. So the claim is
      // stated in three parts — the arriving shield is the authored size, it reached zero, and
      // anything standing afterwards is small enough to be a re-shield rather than the original.
      // The allowance is derived from the boss's own moves, not from the number 1800.
      const surge = Math.max(0, ...(bdef.attacks || []).map((k) => ATTACK_MOVES[k]?.selfShield || 0));
      ok(`floor ${floor}: the ${bdef.shield.element} shield arrives at its authored size and is broken`,
        // `brokeShield` is read off the DAMAGE stream, so it cannot be missed between two 180 ms
        // snapshots the way a `sh === 0` sample can — `bossShieldMin` is printed as context, not
        // gated. With no `selfShield` move on the boss the bound below is the strict `sh === 0`.
        r.bossShieldMax === expect && r.brokeShield && r.boss.sh <= surge,
        `${r.bossShieldMax} vs ${expect}, broke=${r.brokeShield}, low=${r.bossShieldMin},`
        + ` left=${r.boss.sh} of a ${surge} re-shield`);
      // Not gated, printed: `selfShield` is a flat authored number in a game where the shield it
      // refreshes is `enemyStatAtLevel(hp, lv)`. At level 85 that is 1800 against 132369 — the
      // move's whole documented effect ("refreshes its own shield") is 1.4 % of one, so the
      // authored 56 % intent (1800/3200) never survives the level curve.
      if (surge) {
        console.log(`     floor ${floor}: shieldSurge refreshes ${surge} of ${expect}`
          + ` (${(surge / expect * 100).toFixed(1)}% at lv ${r.boss.lv};`
          + ` authored ${(surge / bdef.shield.hp * 100).toFixed(0)}% of the shield at lv 1)`);
      }
    }
  } else {
    ok(`floor ${floor}: no boss where none is authored`, !r.boss, `${r.boss?.t || ''}`);
  }

  checkClear(r, prev, '');
  const runs = [r];
  // A clear can be worth no star, and a 0★ clear banks nothing — so it leaves the next floor
  // locked exactly as a failure would (the rule itself is asserted at the top of this file). What
  // a player does then is play the floor again, so the probe does too: once, only when it happens,
  // and the retry's clear is the one the save and the walk are held to.
  if (r.end?.state === 'cleared' && r.end.stars === 0) {
    const rec0 = await record(a, floor);
    ok(`floor ${floor}: a 0★ clear banks no star`, (rec0.stars || 0) === 0,
      `record ${JSON.stringify(rec0)} after a ${r.end.time}s clear`);
    console.log(`     floor ${floor}: ${r.end.time}s missed the ${def.stars[0]}s 1★ bar by `
      + `${(r.end.time - def.stars[0]).toFixed(1)}s, so it is played again`);
    const retry = await playFloor(floor);
    if (!retry.start) {
      ok(`floor ${floor}: the retry starts`, false, `no start event: ${JSON.stringify(retry.error)}`);
      break;
    }
    runs.push(retry);
    checkClear(retry, rec0.stars || 0, ' (retry)');
  }
  const last = runs[runs.length - 1];
  const cleared = runs.filter((x) => x.end?.state === 'cleared').map((x) => x.end);
  if (last.end?.state === 'cleared') {
    starsByFloor.set(floor, last.end.stars);
    walked++; deepest = floor;
    const rec = await record(a, floor);
    // The record keeps the best of the attempts, not the last one — the same rule floor 1 proves
    // with a deliberate slow-then-fast pair.
    ok(`floor ${floor}: the clear is in the save`,
      rec.stars === Math.max(...cleared.map((e) => e.stars))
      && rec.bestTime === Math.min(...cleared.map((e) => e.time)),
      `${JSON.stringify(rec)} after ${cleared.map((e) => `${e.time}s ${e.stars}★`).join(' + ')}`);
  }
  console.log(`     floor ${floor} ${def.disorder || '—'} ${last.end?.state} ${last.end?.time}s `
    + `${last.end?.stars}★ A${JSON.stringify(ca.stat)} B${JSON.stringify(cb.stat)}`);
  if (last.end?.state !== 'cleared') break;
}

/* --- what the walk as a whole proves ------------------------------------------- */

const placed = new Set(zdef.chambers.map((c) => c.disorder).filter(Boolean));
if (LAST >= 8 && FIRST === 1) {
  ok('every floor of the dungeon was cleared', deepest === 8 && walked === 8,
    `deepest ${deepest}, cleared ${walked}: ${[...starsByFloor].map(([f, s]) => `${f}:${s}★`).join(' ')}`);
  ok('all five 地脉异变 were installed by a running instance',
    placed.size > 0 && [...placed].every((d) => seenDisorders.has(d)),
    `saw ${[...seenDisorders].join(' ')} of ${[...placed].join(' ')}`);
  // The 已知限制's first line: the 3★ time gate had never been beaten by anything that played.
  const threeStar = [...starsByFloor].filter(([, s]) => s === 3).map(([f]) => f);
  ok('the 3★ time gate is reachable by playing', threeStar.length > 0,
    `3★ on floors ${threeStar.join(',') || 'none'}`);
} else {
  skip('every floor of the dungeon was cleared', `ran floors ${FIRST}..${LAST}`);
  skip('all five 地脉异变 were installed by a running instance', `ran floors ${FIRST}..${LAST}`);
  skip('the 3★ time gate is reachable by playing', `ran floors ${FIRST}..${LAST}`);
}

// The fight loop provokes refusals on purpose — it swings, casts and eats every tick, which is
// what a player holding the button down does. Anything outside that list is a protocol failure.
const expectedErrors = new Set([
  'previous_floor_locked', 'on_cooldown', 'no_energy', 'downed', 'not_downed', 'too_far',
  'none_left', 'hp_full', 'is_downed', 'item_rate_limited', 'rate_limited', 'cannot_switch',
  'no_revive_item', 'no_stamina',
]);
const errs = ca.got(S2C.ERROR).concat(cb.got(S2C.ERROR)).filter((e) => !expectedErrors.has(e.error));
ok('no unexpected protocol errors', errs.length === 0, JSON.stringify(errs.slice(0, 4)));

ca.ws.close(); cb.ws.close();
console.log(`\n${passed} passed, ${fails.length} failed, ${skips.length} skipped`);
if (fails.length) console.log(`FAILED: ${fails.join(' | ')}`);
process.exit(fails.length);
