// End-to-end REST check: one fresh guest walked through the whole HTTP surface.
//
//   node tools/api-check.mjs            # against the daemon on :8787
//   GAME_API=http://host:port node tools/api-check.mjs
//
// The companion to `tools/mp-check.mjs`, which does the same for the WebSocket gateway.
// Neither opens a browser: under llvmpipe a page costs minutes, and none of what is being
// checked here is a rendering question. Node 22 has `fetch` built in, so this needs no
// dependencies and imports the zone tables straight out of `shared/` by relative path
// (`@teyvat/shared` is only linked inside server/ and client/).
//
// What makes this more than a status-code sweep is that it asserts *consequences*, on a
// player whose starting state is known exactly from `server/src/db/repo.js`: 20 000 mora,
// 1600 primogems, 10 wish tickets, `adventurerXp` ×10, `sweetMadame` ×5, two characters
// each holding a starter weapon, and `q_intro` active on stage 1. So opening a chest has
// to move mora, a ten-pull has to consume exactly ten tickets and return ten results,
// talking to the scholar has to advance `q_intro` past its first stage, and gathering two
// sweet flowers plus a wheat has to make the sweetMadame recipe affordable. A route that
// returns 200 and changes nothing fails here.
//
// Exit code is the number of failed assertions.
import { readFileSync } from 'node:fs';
import {
  ZONES, gatherNodes, DOMAIN_RESIN, puzzleNodes, PUZZLE_KINDS, CHEST_TIERS, chamberEnemies,
  zoneEntryRank,
} from '../shared/src/data/zones.js';
import {
  zoneGateReport, propKindsUsed, PROP_GROUPS, TERRAIN_KEYS, SKY_KEYS, BIOME_KEYS, ARENA_KEYS,
  POI_PROPS,
} from '../shared/src/data/zoneGate.js';
import {
  zoneExploration, explorationSummary, exploreGateReport, EXPLORE_TYPES,
  EXPLORE_MILESTONES, MILESTONE_KEY, milestoneRewards, zoneChestValue, exploreClaim, exploreClaims,
  explorables, EXPLORED_KINDS,
} from '../shared/src/data/exploration.js';
import { SCATTER_KINDS, SINGLE_KINDS } from '../client/src/gfx/props.js';
import { RECIPES } from '../shared/src/data/recipes.js';
import { ENEMIES, ATTACK_MOVES } from '../shared/src/data/enemies.js';
import { ARTIFACT_MAIN_STATS, ARTIFACT_SLOTS, WEAPONS, MATERIALS } from '../shared/src/data/items.js';
import { CHARACTERS } from '../shared/src/data/characters.js';
import {
  artifactFodderXp, ARTIFACT_LEVEL_CAP, ARTIFACT_MORA_PER_XP,
  weaponStats, weaponXpToLevel, oreXp, refineMul,
  WEAPON_ORE, WEAPON_LEVEL_CAP, WEAPON_MORA_PER_XP, WEAPON_REFINE_MAX,
} from '../shared/src/sim/loot.js';
import { arCap, rankForLevel, xpForLevel } from '../shared/src/sim/formulas.js';
import {
  QUESTS, DAILY_IDS, EXTRA_IDS, QUEST_EVENT_SOURCES, questGateReport, dailiesToRoll,
  offerableQuest,
} from '../shared/src/data/quests.js';
import { SHOPS, SHOP_IDS, GEM_PER_WISH } from '../shared/src/data/shop.js';
import { untilText, periodKey } from '../shared/src/sim/clock.js';
import { loginMail, boardMail, boardTier, MAIL_TTL_DAYS } from '../shared/src/data/mail.js';
import {
  ACHIEVEMENTS, ACH_BY_ID, ACH_STATS, achState, achGateReport, tierGems,
} from '../shared/src/data/achievements.js';
import {
  EXPEDITIONS, EXPEDITION_HOURS, expeditionEntry, expeditionPayout, expeditionSlots,
  expeditionTotal, expeditionsFor, validateExpeditions,
} from '../shared/src/data/expeditions.js';

const ORIGIN = process.env.GAME_API || 'http://127.0.0.1:8787';

let fails = 0;
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; console.log(`ok   ${name}${detail ? '  ' + detail : ''}`); } else {
    fails++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`);
  }
  return !!ok;
}

let token = '';
async function call(method, path, body) {
  const r = await fetch(ORIGIN + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* empty or non-JSON body */ }
  return { status: r.status, b: json ?? {} };
}
const get = (p) => call('GET', p);
const post = (p, b) => call('POST', p, b);

/* ------------------------------------------------------------------ health --- */

{
  const h = await get('/api/health');
  if (!check('health', h.status === 200 && h.b.ok !== false, JSON.stringify(h.b).slice(0, 90))) {
    console.log('\nserver not answering; start it with ./tools/daemon.sh start server');
    process.exit(1);
  }
  const s = await get('/api/stats');
  check('stats', s.status === 200 && typeof s.b === 'object');
}

/* ----------------------------------------------------------------- auth ------ */

// Unauthenticated access to a player route must be refused before anything else runs;
// if this passes, every later assertion is about the guest we minted rather than about
// whatever the last run left behind.
{
  const anon = await get('/api/player/state');
  check('player state needs a token', anon.status === 401, `status ${anon.status}`);
}

const guest = await post('/api/guest', {});
if (!check('guest signup', guest.status === 200 && !!guest.b.token && !!guest.b.playerId,
  `player ${guest.b.playerId} ${guest.b.nickname}`)) {
  process.exit(1);
}
token = guest.b.token;
const playerId = guest.b.playerId;

{
  const bad = await post('/api/login', { username: 'no_such_user_xyz', password: 'wrong' });
  check('login rejects unknown user', bad.status === 401 || bad.status === 400, `status ${bad.status}`);
  const short = await post('/api/register', { username: 'a', password: 'b' });
  check('register validates input', short.status === 400, `status ${short.status}`);
}

/* ---------------------------------------------------------------- state ------ */

let st = await get('/api/player/state');
check('player state', st.status === 200 && !!st.b.player, `AR ${st.b.player?.adventureRank}`);
const p0 = st.b.player;
check('starting currencies', p0.mora === 20000 && p0.wishTicket === 10 && p0.primogem === 1600,
  `mora ${p0.mora} tickets ${p0.wishTicket} primo ${p0.primogem}`);
check('two starter characters', Object.keys(p0.characters).length === 2, Object.keys(p0.characters).join(','));
check('starter inventory', p0.inventory.adventurerXp === 10 && p0.inventory.sweetMadame === 5,
  `xp ${p0.inventory.adventurerXp} food ${p0.inventory.sweetMadame}`);
check('both starters hold a weapon',
  p0.equipment.filter((e) => e.kind === 'weapon' && e.equippedBy).length === 2);
// The welcome kit is one piece per slot, not five dice rolls. It used to roll the slot too, and
// an account could open on three circlets and two flowers: three slots it could not fill and two
// pieces its two characters could not both wear. The stats are still random — only the slot is
// dealt — so this asks for coverage, not for a fixed piece.
const kit = p0.equipment.filter((e) => e.kind === 'artifact');
const kitSlots = kit.map((e) => e.slot).sort();
check('the welcome kit covers every artifact slot once',
  kit.length === ARTIFACT_SLOTS.length
  && kitSlots.join(',') === [...ARTIFACT_SLOTS].sort().join(','),
  `${kit.length} pieces: ${kitSlots.join(' ')}`);
check('...and each of them still rolled its own stats',
  new Set(kit.map((e) => `${e.setId}/${e.main.key}/${e.level}`)).size > 1,
  kit.map((e) => `${e.slot}:${e.setId}@${e.level}`).join(' '));
// Derived stats are computed server-side from level, weapon and artifacts; a character
// with zero attack means the stat pipeline silently produced nothing.
const stats = st.b.stats || {};
const firstChar = p0.party[0];
check('derived stats', (stats[firstChar]?.atk ?? 0) > 0, `${firstChar} atk ${stats[firstChar]?.atk}`);

/* ---------------------------------------------------------------- zones ------ */

{
  const z = await get('/api/zones');
  const ids = (z.b.zones || []).map((x) => x.id);
  check('zone list', z.status === 200 && ids.length === Object.keys(ZONES).length, ids.join(','));
  const mond = (z.b.zones || []).find((x) => x.id === 'mondstadt');
  check('open world zone carries poi and npcs',
    (mond?.poi?.length ?? 0) > 0 && (mond?.npcs?.length ?? 0) > 0,
    `poi ${mond?.poi?.length} npcs ${mond?.npcs?.length}`);
  const dungeon = (z.b.zones || []).find((x) => x.kind === 'dungeon');
  check('dungeon zone carries chambers', (dungeon?.chambers?.length ?? 0) > 0,
    `${dungeon?.id} ${dungeon?.chambers?.length}`);
}

/* ------------------------------------------------------------- zone gate ----- */

// The consumer gate for the biggest authored file in the project. Both directions matter and
// both have already been wrong: `props.trees.minH` was a rule nobody applied, `poi.kind` and
// `poi.count` described a puzzle mechanic that did not exist, and `requires: 'clear'` was a
// lock the chest route did not know how to read.
//
// `client/src/gfx/props.js` is imported here even though this tool never opens a browser: it
// touches no browser globals at module scope, so Node can load it, and that is what closes the
// loop between a prop *name* in a zone and a builder that exists. Without it a typo in
// `ruins.kind` is a crash that only happens when that one zone loads.
{
  const probs = zoneGateReport({ scatter: SCATTER_KINDS, single: SINGLE_KINDS });
  check('the zone catalogue passes its own gate', probs.length === 0,
    probs.slice(0, 4).join(' | ') || `${Object.keys(ZONES).length} zones clean`);

  // A gate that is clean on the shipped data proves nothing about itself, so the two newest rules
  // are mutation-tested through the `zones` injection point. Both of these were real: 冰封洞窟 and
  // 黄金屋遗迹 shipped for weeks with no quest that mentioned them (a zone the player has no reason
  // to visit), and `sq_golden_ledger` was drafted at lv 50, whose adventure rank 15 is below
  // 黄金屋's door — a quest handed over in front of a lock the same account cannot open.
  {
    const orphan = { ...ZONES, ghostVale: { ...ZONES.frostCavern, id: 'ghostVale' } };
    const m1 = zoneGateReport({ scatter: SCATTER_KINDS, single: SINGLE_KINDS, zones: orphan })
      .filter((p) => /ghostVale: no quest happens here/.test(p));
    check('a zone no quest ever mentions is reported', m1.length === 1, m1.join(' | ') || 'not reported');

    const locked = { ...ZONES, frostCavern: { ...ZONES.frostCavern, entryRank: 90 } };
    const m2 = zoneGateReport({ scatter: SCATTER_KINDS, single: SINGLE_KINDS, zones: locked })
      .filter((p) => /sends the player into frostCavern, whose door needs rank 90/.test(p));
    check('an extra quest that sends the player through a door their rank cannot open is reported',
      m2.length >= 1, m2[0] || 'not reported');
  }

  const used = propKindsUsed();
  check('every prop kind a zone asks for has a builder, and every builder is asked for',
    used.size === SCATTER_KINDS.length + SINGLE_KINDS.length && used.size >= 30,
    `${used.size} kinds = ${SCATTER_KINDS.length} scatter + ${SINGLE_KINDS.length} single`);

  // The other half of the `minH` bug: a key can be declared *and* documented and still be read
  // by nobody. Every group key names the file that consumes it, so the file has to mention it.
  //
  // `consumer` may name more than one file, joined by ' + ', and every one of them is scanned.
  // `ceiling` is why: `World._buildCeiling` derives three of the options and then spreads the
  // rest straight into `buildVaultCeiling`, so the file that *decides* the group and the file
  // that *reads* its keys are two different files, and pinning the group to either one alone
  // would report the other one's keys as dead.
  const sources = new Map();
  let scanned = 0;
  for (const [group, def] of Object.entries(PROP_GROUPS)) {
    const files = def.consumer.split(/\s*\+\s*/).map((c) => c.split('#')[0]);
    for (const file of files) {
      if (!sources.has(file)) sources.set(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    }
    const src = files.map((f) => sources.get(f)).join('\n');
    const dead = Object.keys(def.keys).filter((k) => !new RegExp(`\\b${k}\\b`).test(src));
    scanned += Object.keys(def.keys).length;
    if (dead.length) check(`props.${group} keys are all read by ${def.consumer}`, false, dead.join(','));
  }
  check('every declared prop key is mentioned by the consumer that claims it', scanned >= 25,
    `${scanned} keys across ${PROP_GROUPS && Object.keys(PROP_GROUPS).length} groups in ${sources.size} file(s)`);

  // The same scan for `terrain`, where the rot was worse than in props: three of these keys were
  // *shader uniforms with defaults* (`snowLine`, `snowBlend`, `snowColor`), so the snow branch in
  // gfx/terrain.js had never executed, and `grassColorA/B` coloured nothing on any of the three
  // zones that authored them. Each key names the file that must mention it; `biomes[]` and
  // `arena{}` are scanned against their own readers.
  const scan = (label, keys, files) => {
    for (const file of files) {
      if (!sources.has(file)) sources.set(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    }
    const src = files.map((f) => sources.get(f)).join('\n');
    const dead = keys.filter((k) => !new RegExp(`\\b${k}\\b`).test(src));
    if (dead.length) check(`${label} keys are all read by ${files.join(' + ')}`, false, dead.join(','));
    return keys.length;
  };
  let tScanned = 0;
  for (const [key, def] of Object.entries(TERRAIN_KEYS)) {
    tScanned += scan(`terrain.${key}`, [key], def.by.split(/\s*\+\s*/).map((c) => c.split('#')[0]));
  }
  for (const [key, def] of Object.entries(SKY_KEYS)) {
    tScanned += scan(`sky.${key}`, [key], def.by.split(/\s*\+\s*/).map((c) => c.split('#')[0]));
  }
  tScanned += scan('terrain.biomes[]', Object.keys(BIOME_KEYS), ['client/src/gfx/terrain.js']);
  tScanned += scan('terrain.arena', Object.keys(ARENA_KEYS),
    ['shared/src/data/zones.js', 'client/src/gfx/terrain.js']);
  check('every declared terrain and sky key is mentioned by the consumer that claims it', tScanned >= 47,
    `${tScanned} keys: ${Object.keys(TERRAIN_KEYS).length} terrain + ${Object.keys(SKY_KEYS).length} sky`
    + ` + ${Object.keys(BIOME_KEYS).length} biome + ${Object.keys(ARENA_KEYS).length} arena`);

  // A gate form nothing enforces is the `requires: 'clear'` bug; a chest whose lock the route
  // cannot read must be refused, which is asserted against the live route further down.
  const gated = Object.values(ZONES).flatMap((zz) => (zz.poi || [])
    .filter((x) => x.requires).map((x) => `${zz.id}/${x.id}=${x.requires}`));
  check('every authored chest lock is one of the enforced forms',
    gated.length >= 4 && gated.every((g) => /=(clear|puzzle:.+)$/.test(g)), gated.join(' '));
}

/* ------------------------------------------------------------- party/save ---- */

{
  const chars = Object.keys(p0.characters);
  const okParty = await post('/api/player/party', { party: chars });
  check('set party', okParty.status === 200 && okParty.b.party?.length === chars.length,
    (okParty.b.party || []).join(','));
  const junk = await post('/api/player/party', { party: ['not_a_character'] });
  check('party rejects unowned characters', junk.status === 400, `status ${junk.status}`);

  const pos = { x: 12.5, y: 9, z: -3.25, ry: 1.5 };
  const saved = await post('/api/player/save', { zone: 'mondstadt', pos, playtimeSec: 61 });
  check('save state', saved.status === 200, `status ${saved.status}`);
  const back = await get('/api/player/state');
  check('save round-trips position',
    Math.abs((back.b.player?.pos?.x ?? 0) - pos.x) < 0.01
    && Math.abs((back.b.player?.pos?.z ?? 0) - pos.z) < 0.01,
    JSON.stringify(back.b.player?.pos));
  check('save round-trips playtime', back.b.player?.playtimeSec >= 61,
    String(back.b.player?.playtimeSec));
}

/* -------------------------------------------------------------- teleport ----- */

const MZ = ZONES.mondstadt;
{
  const wp = MZ.poi.find((x) => x.type === 'waypoint');
  const tp = await post('/api/world/teleport', { zone: 'mondstadt', poiId: wp.id });
  check('teleport to waypoint', tp.status === 200 && tp.b.zone === 'mondstadt',
    `${wp.id} -> ${JSON.stringify(tp.b.pos)}`);
  // Rank gating: Dragonspine wants AR 4 and a fresh guest is AR 1, so this must be
  // refused. If it ever starts succeeding, the entry requirement has stopped applying.
  const gated = await post('/api/world/teleport', { zone: 'dragonspine' });
  check('zone entry rank is enforced', gated.status === 403 && gated.b.error === 'rank_too_low',
    `status ${gated.status} ${gated.b.error} need ${gated.b.need}`);
  const nowhere = await post('/api/world/teleport', { zone: 'atlantis' });
  check('teleport rejects unknown zone', nowhere.status === 400, `status ${nowhere.status}`);
}

/* ----------------------------------------------------------------- chest ----- */

{
  const chest = MZ.poi.find((x) => x.type === 'chest');
  const before = (await get('/api/player/state')).b.player.mora;
  const r = await post('/api/world/chest', { zone: 'mondstadt', poiId: chest.id });
  const after = r.b.player?.mora ?? before;
  check('open chest', r.status === 200 && !!r.b.loot, `tier ${chest.tier} mora +${after - before}`);
  check('chest pays mora', after > before, `${before} -> ${after}`);
  // The loot roll is the shared one, so the reply has to carry the item map the player's
  // inventory was actually credited with, not just a count.
  const st2 = await get('/api/player/state');
  const items = Object.entries(r.b.loot?.items || {}).filter(([k]) => k !== 'mora' && k !== 'primogem');
  const credited = items.every(([k, v]) => (st2.b.player.inventory[k] ?? 0) >= v);
  check('chest items land in the inventory', credited, items.map(([k, v]) => `${k}x${v}`).join(' ') || '(currency only)');
  const again = await post('/api/world/chest', { zone: 'mondstadt', poiId: chest.id });
  check('chest cannot be reopened', again.status === 409 && again.b.error === 'already_opened',
    `status ${again.status} ${again.b.error}`);
  const ghost = await post('/api/world/chest', { zone: 'mondstadt', poiId: 'no_such_chest_id' });
  check('unknown chest is a 404', ghost.status === 404, `status ${ghost.status}`);
}

/* ---------------------------------------------------------------- puzzle ----- */

// A puzzle is `poi.count` monuments in a ring and pays only when the last one is lit. What
// this section is really guarding is the payout: before the ring existed, `kind` and `count`
// were captions, one POST solved the puzzle, and the interesting failure mode now is a
// half-lit puzzle that pays anyway — or lights that count as solved puzzles in 探索.
{
  const puz = MZ.poi.find((x) => x.type === 'puzzle');
  const nodes = puzzleNodes(MZ, puz);
  check('a puzzle is a ring of monuments, not a single click',
    nodes.length === puz.count && puz.count > 1 && !!PUZZLE_KINDS[puz.kind],
    `${puz.id} ${puz.kind} ×${nodes.length}`);
  const spread = Math.max(...nodes.map((n) => Math.hypot(n.x - puz.at[0], n.z - puz.at[1])));
  check('the monuments stand apart, so each one has to be walked to', spread > 4,
    `${spread.toFixed(1)} m from the centre`);

  const bogus = await post('/api/world/puzzle', { zone: 'mondstadt', poiId: puz.id, nodeId: `${puz.id}#99` });
  check('an unknown monument is a 404', bogus.status === 404 && bogus.b.error === 'no_such_monument',
    `status ${bogus.status} ${bogus.b.error}`);

  const before = (await get('/api/player/state')).b.player;
  const first = await post('/api/world/puzzle', { zone: 'mondstadt', poiId: puz.id, nodeId: nodes[0].id });
  check('lighting one monument does not solve the puzzle',
    first.status === 200 && first.b.solved === false && first.b.lit === 1 && first.b.total === nodes.length,
    `lit ${first.b.lit}/${first.b.total}`);
  check('and pays nothing on the way',
    !first.b.reward && first.b.player.primogem === before.primogem && first.b.player.mora === before.mora,
    `${before.primogem} -> ${first.b.player.primogem} primogems`);
  const twice = await post('/api/world/puzzle', { zone: 'mondstadt', poiId: puz.id, nodeId: nodes[0].id });
  check('the same monument cannot be lit twice', twice.status === 409 && twice.b.error === 'already_lit',
    `status ${twice.status} ${twice.b.error}`);

  let last = first;
  for (const n of nodes.slice(1)) {
    last = await post('/api/world/puzzle', { zone: 'mondstadt', poiId: puz.id, nodeId: n.id });
  }
  check('the last monument solves it and pays once',
    last.status === 200 && last.b.solved === true && last.b.lit === nodes.length
    && last.b.reward?.primogem === 5 && last.b.player.primogem === before.primogem + 5,
    `${before.primogem} -> ${last.b.player.primogem} primogems, reward ${JSON.stringify(last.b.reward)}`);
  const again = await post('/api/world/puzzle', { zone: 'mondstadt', poiId: puz.id, nodeId: nodes[0].id });
  check('a solved puzzle cannot be re-solved', again.status === 409 && again.b.error === 'already_solved',
    `status ${again.status} ${again.b.error}`);

  // The monuments are recorded beside the puzzle under `p:` keys with a `{lit}` payload. That
  // payload is load-bearing: `repo.achSnapshot` counts solved puzzles by
  // `value->>'solved' = 'true'`, so a monument written as `{solved}` would have turned one
  // three-monument puzzle into four solved puzzles in the 探索 achievements.
  const wp = (await get('/api/player/state')).b.player.worldProgress?.mondstadt || {};
  const litRows = nodes.filter((n) => wp[`p:${n.id}`]?.lit);
  check('each monument is recorded as lit, not as solved',
    litRows.length === nodes.length && litRows.every((n) => !wp[`p:${n.id}`].solved)
    && wp[puz.id]?.solved === true,
    `${litRows.length} lit rows + ${puz.id} ${JSON.stringify(wp[puz.id])}`);
  const ach = await get('/api/achievements');
  check('and the whole ring counts as exactly one solved puzzle',
    ach.b.progress?.puzzles === 1, `探索.puzzles = ${ach.b.progress?.puzzles} for ${nodes.length} monuments`);
}

/* ---------------------------------------------------------------- statue ----- */

{
  const statue = MZ.poi.find((x) => x.type === 'statue');
  const r = await post('/api/world/unlock', { zone: 'mondstadt', poiId: statue.id });
  check('unlock statue', r.status === 200 && r.b.first === true, `first ${r.b.first}`);
  const again = await post('/api/world/unlock', { zone: 'mondstadt', poiId: statue.id });
  // Not an error the second time: a statue is a heal point you return to. But the reward
  // is first-visit only, and `first` is what says so.
  check('second statue visit gives no reward', again.status === 200 && again.b.first === false,
    `first ${again.b.first}`);
}

/* ------------------------------------------------------------ exploration --- */

// 探索度 is derived from the `world_progress` rows the three routes above have been writing all
// along, so this section is mostly about *consequences*: the number the routes report has to be
// the one an independent count of those rows gives, it has to move when something is found, and
// the achievement priced from it has to agree with both.
//
// The recount below is deliberately a second implementation rather than a call into
// `zoneExploration` — asserting a function against itself proves only that it is a function.
{
  const FLAGS = { waypoint: 'unlocked', statue: 'unlocked', warmth: 'unlocked', chest: 'opened', puzzle: 'solved' };
  const recount = (zdef, prog = {}) => {
    // The zone's entry anchor is travellable without a row (`anchors.js#isAnchorUnlocked`), and
    // 探索度 has to agree with the map about that or the same panel shows two answers.
    const entry = zdef.poi.find((x) => x.type === 'waypoint')?.id;
    let found = 0, total = 0;
    for (const p of zdef.poi) {
      const flag = FLAGS[p.type];
      if (!flag) continue;
      total++;
      if (p.id === entry || prog[p.id]?.[flag] === true) found++;
    }
    return { found, total, pct: found >= total ? 100 : Math.min(99, Math.floor((found * 100) / total)) };
  };

  const stateProg = async (zone = 'mondstadt') =>
    (await get('/api/player/state')).b.player?.worldProgress?.[zone] || {};

  // The second implementation has to stay *complete*: a POI type added to `EXPLORE_TYPES` that
  // this recount does not know about would make every assertion below quietly measure the old
  // vocabulary, and they would all still pass.
  check('the recount covers every type 探索度 counts',
    Object.keys(FLAGS).length === Object.keys(EXPLORE_TYPES).length
    && Object.keys(EXPLORE_TYPES).every((t) => FLAGS[t] === EXPLORE_TYPES[t].flag),
    `${Object.keys(FLAGS).join(',')} vs ${Object.keys(EXPLORE_TYPES).join(',')}`);

  const before = recount(MZ, await stateProg());
  // Walked so far: the entry anchor, one chest, one puzzle (three monuments), the statue.
  check('探索度 has been accumulating from the rows the walk-through already wrote',
    before.found === 4 && before.total === 9 && before.pct === 44,
    `${before.found}/${before.total} = ${before.pct}%`);

  const chest2 = MZ.poi.filter((x) => x.type === 'chest')[1];
  const r2 = await post('/api/world/chest', { zone: 'mondstadt', poiId: chest2.id });
  const after = recount(MZ, await stateProg());
  check('a chest reports the 探索度 it just moved, and the step is the one the rows give',
    r2.status === 200 && r2.b.explore?.pct === after.pct
    && r2.b.explore?.found === after.found && r2.b.explore?.total === after.total
    && r2.b.explore?.gained === after.pct - before.pct && after.pct > before.pct,
    `${before.pct}% → ${r2.b.explore?.pct}% (+${r2.b.explore?.gained}), rows say ${after.found}/${after.total}`);
  // The breakdown is what the map panel writes under the bar, so it has to add up to `found`.
  const bt = r2.b.explore?.byType || [];
  check('...and the per-type breakdown sums to it',
    bt.length === 4 && bt.reduce((s, b) => s + b.found, 0) === after.found
    && bt.reduce((s, b) => s + b.total, 0) === after.total,
    bt.map((b) => `${b.label} ${b.found}/${b.total}`).join(' '));

  // `POST /api/world/unlock` used to take *any* POI id in the zone: it wrote `{unlocked:true}`
  // under a chest's id and paid 5 原石, which made the chest answer `already_opened` forever.
  // Both halves are asserted — the refusal, and that the chest it refused to eat still pays.
  const chest3 = MZ.poi.filter((x) => x.type === 'chest')[2];
  const gemBefore = (await get('/api/player/state')).b.player.primogem;
  for (const [what, id] of [['chest', chest3.id], ['puzzle', 'mond_puzzle1'], ['dungeon door', 'mond_dungeon']]) {
    const bad = await post('/api/world/unlock', { zone: 'mondstadt', poiId: id });
    check(`unlock refuses a ${what}`, bad.status === 409 && bad.b.error === 'not_an_anchor',
      `${id}: status ${bad.status} ${bad.b.error || ''}`);
  }
  const st3 = await get('/api/player/state');
  check('...paying nothing and writing no row for it',
    st3.b.player.primogem === gemBefore && !st3.b.player.worldProgress?.mondstadt?.[chest3.id],
    `${gemBefore} → ${st3.b.player.primogem} 原石, row ${JSON.stringify(st3.b.player.worldProgress?.mondstadt?.[chest3.id] ?? null)}`);
  const rescued = await post('/api/world/chest', { zone: 'mondstadt', poiId: chest3.id });
  check('...and the chest it tried to eat still opens for its full loot',
    rescued.status === 200 && (rescued.b.loot?.mora || 0) > 0 && rescued.b.explore?.gained > 0,
    `+${rescued.b.loot?.mora} mora, 探索度 +${rescued.b.explore?.gained}%`);

  // A real anchor: 探索度 moves, and the 锚点 achievement counts it, from the same row.
  const wp2 = MZ.poi.filter((x) => x.type === 'waypoint')[1];
  const achBefore = (await get('/api/achievements')).b.progress;
  const un = await post('/api/world/unlock', { zone: 'mondstadt', poiId: wp2.id });
  const nowP = recount(MZ, await stateProg());
  check('activating an anchor moves 探索度 too',
    un.status === 200 && un.b.explore?.pct === nowP.pct && un.b.explore?.gained > 0,
    `${un.b.explore?.pct}% (+${un.b.explore?.gained}), rows say ${nowP.pct}%`);
  // Read before the dungeon anchor below is touched: `waypoints` counts every `{unlocked}` row in
  // the account, so two unlocks between the two reads would make a +1 assertion read +2 and the
  // line would have been "fixed" by loosening it.
  const achMid = (await get('/api/achievements')).b.progress;
  check('the anchor row is counted once by both readers',
    achMid.waypoints === achBefore.waypoints + 1, `waypoints ${achBefore.waypoints} → ${achMid.waypoints}`);

  // Dungeons have no 探索度 at all (`EXPLORED_KINDS`): one anchor and one reward chest is not a
  // percentage, and counting them would hand a brand-new account 「最高探索度 50%」 for free.
  const abyss = ZONES.abyssTrial;
  const dunUn = await post('/api/world/unlock', { zone: abyss.id, poiId: abyss.poi[0].id });
  check('a 秘境 reports no 探索度 rather than a meaningless one',
    dunUn.status === 200 && dunUn.b.explore === null, `explore ${JSON.stringify(dunUn.b.explore)}`);

  const ach = (await get('/api/achievements')).b.progress;
  check('the achievement reads the best zone, not the average',
    ach.exploreBest === nowP.pct, `exploreBest ${ach.exploreBest} vs mondstadt ${nowP.pct}%`);
  check('...and nothing is 100% yet', ach.zonesExplored === 0, `zonesExplored ${ach.zonesExplored}`);
  check('a 秘境 anchor does not move 探索度 for anybody',
    ach.exploreBest === achMid.exploreBest && ach.zonesExplored === achMid.zonesExplored,
    `exploreBest ${achMid.exploreBest} → ${ach.exploreBest}`);

  /* --- the milestone ladder: what the percentage actually pays ------------- */
  //
  // 探索度 used to pay only through achievements, and those are global high-water marks, so the
  // second and third zone paid nothing at all for the same walk. The ladder is per zone, priced
  // off that zone's own chests, and claimed. Everything below names its payer: a claim moves mora
  // and 原石 and *nothing else*, so every delta here is exact rather than bounded.
  {
    const LADDER = milestoneRewards(MZ);
    const stepFor = (pct) => LADDER.find((s) => s.pct === pct)?.rewards || { mora: 0, primogem: 0 };
    const sumOf = (pcts) => pcts.reduce((a, pct) => ({
      mora: a.mora + stepFor(pct).mora, primogem: a.primogem + stepFor(pct).primogem,
    }), { mora: 0, primogem: 0 });

    const at77 = recount(MZ, await stateProg());
    // Everything below is priced off this number, so it is asserted rather than assumed: the
    // walk-through has to have left 蒙德 between the third and fourth milestone for the
    // "three steps at once" and "next is 80" assertions to mean what they say.
    check('the walk-through has 蒙德 past three milestones and short of the fourth',
      at77.pct >= 60 && at77.pct < 80, `${at77.pct}%`);

    const stBefore = (await get('/api/player/state')).b.player;
    const achBeforeClaim = (await get('/api/achievements')).b.progress;
    const cl = await post('/api/world/explore/claim', { zone: 'mondstadt' });
    const want = sumOf([20, 40, 60]);
    check('claiming pays every milestone below the current 探索度, in one press',
      cl.status === 200 && cl.b.took?.length === 3
      && cl.b.took.map((t) => t.pct).join(',') === '20,40,60'
      && cl.b.gained?.mora === want.mora && cl.b.gained?.primogem === want.primogem,
      `${cl.status} took ${JSON.stringify(cl.b.took?.map((t) => t.pct))} `
      + `+${cl.b.gained?.mora} mora +${cl.b.gained?.primogem} 原石 (want ${want.mora}/${want.primogem})`);
    const stAfter = (await get('/api/player/state')).b.player;
    check('...and the player actually holds it',
      stAfter.mora === stBefore.mora + want.mora
      && stAfter.primogem === stBefore.primogem + want.primogem,
      `mora ${stBefore.mora} → ${stAfter.mora}, 原石 ${stBefore.primogem} → ${stAfter.primogem}`);
    // The mark is a row in the table 探索度 is derived from. If the percentage could see it, the
    // denominator would grow by one every time somebody collected a reward.
    const afterClaim = recount(MZ, await stateProg());
    check('...the paid mark is one world_progress row, invisible to the percentage',
      stAfter.worldProgress?.mondstadt?.[MILESTONE_KEY]?.pct === 60
      && afterClaim.found === at77.found && afterClaim.total === at77.total,
      `${MILESTONE_KEY} = ${JSON.stringify(stAfter.worldProgress?.mondstadt?.[MILESTONE_KEY])}, `
      + `${afterClaim.found}/${afterClaim.total}`);
    // The other half of "invisible": `achSnapshot` counts world-progress rows by payload shape,
    // and `{pct}` is none of `{opened}`/`{solved}`/`{unlocked}`.
    const achAfterClaim = (await get('/api/achievements')).b.progress;
    check('...and no achievement counts it as a discovery',
      achAfterClaim.chests === achBeforeClaim.chests
      && achAfterClaim.waypoints === achBeforeClaim.waypoints
      && achAfterClaim.puzzles === achBeforeClaim.puzzles
      && achAfterClaim.exploreBest === achBeforeClaim.exploreBest,
      `chests ${achAfterClaim.chests} waypoints ${achAfterClaim.waypoints} `
      + `puzzles ${achAfterClaim.puzzles} best ${achAfterClaim.exploreBest}%`);

    const again = await post('/api/world/explore/claim', { zone: 'mondstadt' });
    const stTwice = (await get('/api/player/state')).b.player;
    check('a second press pays nothing and says what is next',
      again.status === 400 && again.b.error === 'nothing_to_claim' && again.b.next === 80
      && stTwice.mora === stAfter.mora && stTwice.primogem === stAfter.primogem,
      `${again.status} ${again.b.error} next ${again.b.next}, mora ${stTwice.mora}`);

    const dun = await post('/api/world/explore/claim', { zone: 'abyssTrial' });
    check('a 秘境 has no ladder to claim', dun.status === 409 && dun.b.error === 'no_exploration',
      `${dun.status} ${dun.b.error}`);
    const nowhere = await post('/api/world/explore/claim', { zone: 'notaplace' });
    check('an unknown zone is refused', nowhere.status === 400 && nowhere.b.error === 'bad_zone',
      `${nowhere.status} ${nowhere.b.error}`);

    // Finish the zone through the routes that own each type, and watch the discovery responses
    // announce the reward that just unlocked — that block is what lights the button in the panel,
    // so a chest that crosses 80% has to say so without the client asking a second route.
    let sawClaimable = 0;
    for (const p of MZ.poi) {
      const spec = EXPLORE_TYPES[p.type];
      if (!spec) continue;
      const prog = await stateProg();
      if (prog[p.id]?.[spec.flag]) continue;
      const path = spec.writer.replace('POST ', '');
      const r = p.type === 'puzzle'
        ? { status: 0, b: {} } // handled below: a puzzle needs every monument of its ring
        : await post(path, { zone: 'mondstadt', poiId: p.id });
      if (p.type === 'puzzle') {
        for (const node of puzzleNodes(MZ, p)) {
          await post('/api/world/puzzle', { zone: 'mondstadt', poiId: p.id, nodeId: node.id });
        }
        continue;
      }
      if (r.status !== 200) { check(`finishing 蒙德: ${p.id} opens`, false, `${r.status} ${r.b.error}`); continue; }
      if (r.b.explore?.claimable?.length) sawClaimable++;
    }
    const done = recount(MZ, await stateProg());
    check('蒙德 can be finished through the same routes that count it',
      done.pct === 100 && done.found === done.total, `${done.found}/${done.total} = ${done.pct}%`);
    check('...and the discovery that crossed a milestone said so in its own response',
      sawClaimable > 0, `${sawClaimable} responses carried a claimable milestone`);

    // Two presses at once. The guard is the `WHERE` inside `repo.claimExploreMilestone`, so both
    // requests read the same rows and compute the same target: exactly one of them may pay.
    const stPre = (await get('/api/player/state')).b.player;
    const [a1, a2] = await Promise.all([
      post('/api/world/explore/claim', { zone: 'mondstadt' }),
      post('/api/world/explore/claim', { zone: 'mondstadt' }),
    ]);
    const stPost = (await get('/api/player/state')).b.player;
    const last = sumOf([80, 100]);
    const oks = [a1, a2].filter((r) => r.status === 200);
    check('two presses at once pay once',
      oks.length === 1 && stPost.mora === stPre.mora + last.mora
      && stPost.primogem === stPre.primogem + last.primogem,
      `${a1.status}/${a2.status}, mora +${stPost.mora - stPre.mora} (want ${last.mora}), `
      + `原石 +${stPost.primogem - stPre.primogem} (want ${last.primogem})`);
    check('...and the loser is told why, not paid',
      [a1, a2].some((r) => r.status === 409 || (r.status === 400 && r.b.error === 'nothing_to_claim')),
      `${a1.status} ${a1.b.error || 'ok'} / ${a2.status} ${a2.b.error || 'ok'}`);

    // The whole point of the pricing rule, end to end: what a zone's ladder pays in total is what
    // that zone's chests pay at face value. Measured over the five claims that just happened.
    const total = sumOf(EXPLORE_MILESTONES);
    const face = zoneChestValue(MZ);
    check('finishing a zone pays exactly what that zone\'s chests pay',
      total.mora === face.mora && total.primogem === face.primogem,
      `ladder ${total.mora}/${total.primogem} vs chests ${face.mora}/${face.primogem}`);
    const st100 = (await get('/api/player/state')).b.player;
    const cl100 = exploreClaim(MZ, st100.worldProgress?.mondstadt || {});
    check('a finished, fully claimed zone has nothing left to offer',
      cl100.pct === 100 && cl100.paid === 100 && !cl100.claimable.length && cl100.next === null
      && cl100.steps.every((s) => s.state === 'paid'),
      `${cl100.pct}% paid ${cl100.paid}, next ${JSON.stringify(cl100.next)}`);
    const after100 = await post('/api/world/explore/claim', { zone: 'mondstadt' });
    check('...and the route agrees there is nothing left',
      after100.status === 400 && after100.b.next === null,
      `${after100.status} ${after100.b.error} next ${JSON.stringify(after100.b.next)}`);
  }

  // Pure derivation: 100% is reserved for "everything", and the last find is worth 12 points.
  {
    const full = {};
    for (const p of MZ.poi) if (FLAGS[p.type]) full[p.id] = { [FLAGS[p.type]]: true };
    const done = zoneExploration(MZ, full);
    const oneLeft = { ...full };
    delete oneLeft[MZ.poi.find((x) => x.type === 'statue').id];
    const short = zoneExploration(MZ, oneLeft);
    check('探索度 is 100% only when every last thing is found',
      done.pct === 100 && done.found === done.total && short.pct === 88 && short.found === done.total - 1,
      `${short.found}/${short.total} = ${short.pct}% → ${done.pct}%`);
    // The floor matters in the other direction as well: 8/9 must not round up to 100.
    check('...and a floored percentage never rounds up into it', short.pct < 100, `${short.pct}%`);
    const sum = explorationSummary({ mondstadt: full });
    check('a finished zone counts as one fully explored zone',
      sum.complete === 1 && sum.best === 100 && Object.keys(sum.byZone).length === 3,
      `complete ${sum.complete}, best ${sum.best}, zones ${Object.keys(sum.byZone).join(',')}`);
  }

  // The number on the HUD's 🎁 chip: every zone with something to collect, at once. Pure
  // derivation over synthetic saves, because the interesting cases (two zones owing at the same
  // time, a 秘境 with rows in it, a zone already paid off) take an hour of walking to reach.
  {
    const flagsFor = (zdef, ids) => {
      const out = {};
      for (const p of explorables(zdef)) if (ids.includes(p.id)) out[p.id] = { [FLAGS[p.type]]: true };
      return out;
    };
    const allOf = (zdef) => flagsFor(zdef, explorables(zdef).map((p) => p.id));

    const fresh = exploreClaims({});
    check('a save with no rows owes nothing anywhere, so the chip stays hidden',
      fresh.rungs === 0 && fresh.zones.length === 0 && fresh.best === null
      && fresh.reward.mora === 0 && fresh.reward.primogem === 0,
      `${fresh.rungs} rungs in ${fresh.zones.map((z) => z.zone).join(',') || 'nowhere'}`);

    // 璃月 gets exactly enough for the first rung — the sum has to be over *zones*, not over the
    // one the player happens to be standing in.
    const LZ = ZONES.liyue;
    const lyIds = [];
    for (const p of explorables(LZ)) {
      lyIds.push(p.id);
      if (zoneExploration(LZ, flagsFor(LZ, lyIds)).pct >= EXPLORE_MILESTONES[0]) break;
    }
    const both = { mondstadt: allOf(MZ), liyue: flagsFor(LZ, lyIds) };
    const sum = exploreClaims(both);
    const mondClaim = exploreClaim(MZ, both.mondstadt);
    const liyueClaim = exploreClaim(LZ, both.liyue);
    check('two zones owing at once are both counted, richest first',
      sum.rungs === mondClaim.claimable.length + liyueClaim.claimable.length
      && sum.zones.map((z) => z.zone).join(',') === 'mondstadt,liyue'
      && sum.best.zone === 'mondstadt' && sum.rungs === EXPLORE_MILESTONES.length + 1,
      `${sum.rungs} rungs · ${sum.zones.map((z) => `${z.zone} ${z.pct}% ×${z.claimable.length}`).join(' · ')}`);
    check('...and the chip\'s total is the sum of the two zones\' own numbers',
      sum.reward.mora === mondClaim.reward.mora + liyueClaim.reward.mora
      && sum.reward.primogem === mondClaim.reward.primogem + liyueClaim.reward.primogem
      && sum.reward.mora === zoneChestValue(MZ).mora + liyueClaim.reward.mora,
      `${sum.reward.mora} mora / ${sum.reward.primogem} 原石 vs `
      + `${mondClaim.reward.mora}+${liyueClaim.reward.mora} / ${mondClaim.reward.primogem}+${liyueClaim.reward.primogem}`);

    // A 秘境 has no ladder, so rows inside one can never light the chip — the other half of the
    // rule `EXPLORED_KINDS` states, read off the aggregate rather than off one zone.
    const dz = Object.values(ZONES).find((z) => !EXPLORED_KINDS.has(z.kind));
    const dungeonRows = { ...both, [dz.id]: allOf(dz) };
    check('rows inside a 秘境 never light the chip',
      exploreClaims(dungeonRows).zones.every((z) => z.zone !== dz.id)
      && exploreClaims(dungeonRows).rungs === sum.rungs,
      `${dz.id}: ${Object.keys(allOf(dz)).length} rows → ${exploreClaims(dungeonRows).rungs} rungs (want ${sum.rungs})`);

    // The paid mark is what makes the chip go away; nothing else changes.
    const paidOff = { ...both, mondstadt: { ...both.mondstadt, [MILESTONE_KEY]: { pct: 100 } } };
    const after = exploreClaims(paidOff);
    check('a zone that has been paid off drops out of the count',
      after.rungs === liyueClaim.claimable.length && after.best.zone === 'liyue'
      && zoneExploration(MZ, paidOff.mondstadt).pct === 100,
      `${after.rungs} rungs · ${after.zones.map((z) => z.zone).join(',')}`);
    const allPaid = {
      mondstadt: { ...both.mondstadt, [MILESTONE_KEY]: { pct: 100 } },
      liyue: { ...both.liyue, [MILESTONE_KEY]: { pct: 100 } },
    };
    check('...and with every ladder paid the chip is hidden again',
      exploreClaims(allPaid).rungs === 0 && exploreClaims(allPaid).best === null,
      `${exploreClaims(allPaid).rungs} rungs`);
  }

  // The gate's own obligation: every branch of `exploreGateReport` shown to fire.
  {
    const fake = (id, poi, kind = 'open') => ({ id, kind, poi });
    const four = { m: fake('m', MZ.poi.slice(0, 4)) };
    check('a zone too small for a percentage is reported',
      exploreGateReport({ zones: four, poiProps: POI_PROPS })
        .some((s) => /only has \d+ things to find/.test(s)),
      exploreGateReport({ zones: four, poiProps: POI_PROPS }).join(' | ') || 'not reported');
    const empty = { ...ZONES, hollow: fake('hollow', [{ id: 'h1', type: 'dungeon', at: [0, 0] }]) };
    check('a zone with nothing to find is reported',
      exploreGateReport({ zones: empty, poiProps: POI_PROPS })
        .some((s) => /hollow.*nothing to explore/.test(s)), 'gate output');
    check('a POI type nobody classified is reported',
      exploreGateReport({ zones: ZONES, poiProps: { ...POI_PROPS, shrine: 'shrine' } })
        .some((s) => /"shrine".*neither counts it nor declares it uncounted/.test(s)), 'gate output');
    const { chest: _drop, ...noChest } = POI_PROPS;
    check('a counted type no zone can author is reported',
      exploreGateReport({ zones: ZONES, poiProps: noChest })
        .some((s) => /classifies POI type "chest"/.test(s)), 'gate output');
    // --- the milestone half of the gate, one branch at a time ---
    // Each of these is a way the ladder can rot silently: a zone that pays for arriving, a step
    // worth nothing, a threshold list that does not reach 100%, a paid mark that collides with a
    // POI id. The thresholds and the key are parameters precisely so each line can be fired.
    const arrival = { rich: { id: 'rich', kind: 'open', poi: [
      { id: 'a1', type: 'waypoint', at: [0, 0] },
      ...['common', 'common', 'exquisite', 'precious'].map((tier, i) => ({ id: `c${i}`, type: 'chest', tier, at: [i, 0] })),
    ] } };
    check('a zone that already reads a milestone on arrival is reported',
      exploreGateReport({ zones: arrival, poiProps: POI_PROPS })
        .some((s) => /reads 20% on arrival/.test(s)),
      exploreGateReport({ zones: arrival, poiProps: POI_PROPS }).join(' | ') || 'not reported');
    // The same defect said in the units the player sees: that zone would light the HUD chip on a
    // brand-new account. Both lines fire off one fake zone, and both have to be present — the
    // per-zone one is about a percentage, the aggregate one is about the badge.
    check('...and so is the 🎁 chip it would light on a new account',
      exploreGateReport({ zones: arrival, poiProps: POI_PROPS })
        .some((s) => /save with no rows already owes 1 milestone\(s\) in rich/.test(s)),
      exploreGateReport({ zones: arrival, poiProps: POI_PROPS }).join(' | ') || 'not reported');
    const chestless = { bare: { id: 'bare', kind: 'open', poi: [
      { id: 'w', type: 'waypoint', at: [0, 0] }, { id: 's', type: 'statue', at: [1, 0] },
      { id: 'f', type: 'warmth', at: [2, 0] }, { id: 'p', type: 'puzzle', at: [3, 0] },
      { id: 'w2', type: 'waypoint', at: [4, 0] }, { id: 'w3', type: 'waypoint', at: [5, 0] },
    ] } };
    check('a zone whose ladder pays nothing is reported',
      exploreGateReport({ zones: chestless, poiProps: POI_PROPS })
        .some((s) => /milestone 100% pays 0 mora \/ 0 原石/.test(s)), 'gate output');
    const badTier = { odd: { id: 'odd', kind: 'open', poi: MZ.poi.map((p) => (p.type === 'chest'
      ? { ...p, tier: 'gilded' } : p)) } };
    check('a chest of an unpriced tier is reported',
      exploreGateReport({ zones: badTier, poiProps: POI_PROPS })
        .some((s) => /chest\(s\) of an unpriced tier \(gilded/.test(s)), 'gate output');
    check('a ladder that stops short of 100% is reported',
      exploreGateReport({ poiProps: POI_PROPS, milestones: [20, 40, 60] })
        .some((s) => /last 探索度 milestone is 60%/.test(s)), 'gate output');
    check('a ladder that does not ascend is reported',
      exploreGateReport({ poiProps: POI_PROPS, milestones: [40, 20, 100] })
        .some((s) => /must ascend: 40% then 20%/.test(s)), 'gate output');
    check('a threshold that is not a percentage is reported',
      exploreGateReport({ poiProps: POI_PROPS, milestones: [20, 140] })
        .some((s) => /milestone 140% is not a percentage/.test(s)), 'gate output');
    // An empty ladder is the one shape in which the totals stop matching the chests, which is the
    // sentence the whole pricing rule rests on.
    check('a ladder that does not add up to the zone\'s chests is reported',
      exploreGateReport({ poiProps: POI_PROPS, milestones: [] })
        .some((s) => /milestones sum to 0 mora \/ 0 原石, not its chest value/.test(s))
      && exploreGateReport({ poiProps: POI_PROPS, milestones: [] })
        .some((s) => /has no milestone/.test(s)), 'gate output');
    check('a paid mark that could be mistaken for a POI is reported',
      exploreGateReport({ poiProps: POI_PROPS, milestoneKey: 'explore' })
        .some((s) => /has no prefix/.test(s)), 'gate output');
    const collide = { coll: { id: 'coll', kind: 'open', poi: [
      ...MZ.poi, { id: MILESTONE_KEY, type: 'chest', tier: 'common', at: [0, 0] },
    ] } };
    check('a POI id that collides with the paid mark is reported',
      exploreGateReport({ zones: collide, poiProps: POI_PROPS })
        .some((s) => new RegExp(`POI whose id is the milestone key "${MILESTONE_KEY}"`).test(s)),
      'gate output');

    check('and the real tables pass it', exploreGateReport({ poiProps: POI_PROPS }).length === 0,
      exploreGateReport({ poiProps: POI_PROPS }).join(' | ') || 'clean');
  }
}

/* ---------------------------------------------------------------- gather ----- */

const NODES = gatherNodes(MZ);
{
  const flower = NODES.find((n) => n.kind === 'sweetFlower');
  const r = await post('/api/world/gather', { zone: 'mondstadt', nodeId: flower.id });
  const got = Object.entries(r.b.items || {});
  check('gather a node', r.status === 200 && got.length > 0,
    `${flower.id} -> ${got.map(([k, v]) => `${k}x${v}`).join(' ')}`);
  check('gather yields its own kind', (r.b.items?.sweetFlower ?? 0) > 0, `kind ${r.b.kind}`);
  const again = await post('/api/world/gather', { zone: 'mondstadt', nodeId: flower.id });
  check('picked node has to regrow', again.status === 409 && again.b.error === 'not_regrown',
    `status ${again.status} ${again.b.error}`);
  const ghost = await post('/api/world/gather', { zone: 'mondstadt', nodeId: 'sweetFlower_99999' });
  check('unknown node is a 404', ghost.status === 404, `status ${ghost.status}`);
}

/* ------------------------------------------------------------------ cook ----- */

{
  // Gather up to the sweetMadame recipe rather than granting items: the point is that the
  // two systems agree on ingredient names, which a hand-written grant would paper over.
  const recipe = RECIPES.sweetMadame;
  const need = recipe.ingredients;
  let inv = (await get('/api/player/state')).b.player.inventory;
  for (const [item, qty] of Object.entries(need)) {
    for (const n of NODES.filter((x) => x.kind === item)) {
      if ((inv[item] ?? 0) >= qty) break;
      const g = await post('/api/world/gather', { zone: 'mondstadt', nodeId: n.id });
      if (g.status === 200) inv = g.b.player.inventory;
    }
  }
  const enough = Object.entries(need).every(([k, v]) => (inv[k] ?? 0) >= v);
  check('gathered the recipe ingredients', enough,
    Object.keys(need).map((k) => `${k} ${inv[k] ?? 0}/${need[k]}`).join(' '));

  const before = inv.sweetMadame ?? 0;
  const suspBefore = inv.suspiciousFood ?? 0;
  const r = await post('/api/player/cook', { recipeId: 'sweetMadame', count: 1 });
  check('cook', r.status === 200, `status ${r.status} ${r.b.error ?? ''}`);
  const afterInv = r.b.player?.inventory ?? {};
  // Asserted against the reported tally rather than as "the dish went up", because a
  // portion has a ruined roll (4 % at this rank, `cookOdds`) that yields suspiciousFood
  // instead — so the flat assertion failed about one run in twenty-five and read exactly
  // like a cache-invalidation bug: status 200, ingredients gone, dish count unmoved, and
  // the *next* run of the tool starting one dish higher. It was neither stale nor a bug,
  // it was the recipe working. A check that fails 4 % of the time is worse than no check,
  // because the first thing it costs is a hunt through the wrong subsystem.
  const tally = r.b.tally ?? {};
  const gotDish = (afterInv.sweetMadame ?? 0) - before;
  const gotSusp = (afterInv.suspiciousFood ?? 0) - suspBefore;
  check('cooking yields what its tally says',
    tally.ruined ? gotSusp === tally.ruined && gotDish === 0
      : gotDish === tally.normal + tally.perfect * 2 && gotDish > 0,
    `tally ${JSON.stringify(tally)} dish ${before} -> ${afterInv.sweetMadame} susp +${gotSusp}`);
  check('cooking consumes the ingredients',
    Object.entries(need).every(([k, v]) => (afterInv[k] ?? 0) === (inv[k] ?? 0) - v),
    Object.keys(need).map((k) => `${k} ${inv[k]} -> ${afterInv[k]}`).join(' '));
  const nope = await post('/api/player/cook', { recipeId: 'not_a_recipe' });
  check('unknown recipe is a 404', nope.status === 404, `status ${nope.status}`);
}

/* ------------------------------------------------------------- consumables --- */

{
  const before = (await get('/api/player/state')).b.player.inventory.sweetMadame;
  const r = await post('/api/inventory/use', { itemId: 'sweetMadame', count: 1 });
  check('use a consumable', r.status === 200 && r.b.used === 1, `heal ${JSON.stringify(r.b.effect?.heal)}`);
  check('using one consumes one', (r.b.player?.inventory?.sweetMadame ?? 0) === before - 1,
    `${before} -> ${r.b.player?.inventory?.sweetMadame}`);
  const notFood = await post('/api/inventory/use', { itemId: 'adventurerXp' });
  check('non-consumables cannot be eaten', notFood.status === 400 && notFood.b.error === 'not_consumable',
    `status ${notFood.status} ${notFood.b.error}`);
  const none = await post('/api/inventory/use', { itemId: 'northernSmokedChicken', count: 1 });
  check('cannot use an item you do not have', none.status === 400,
    `status ${none.status} ${none.b.error}`);
}

/* ----------------------------------------------------------------- growth ---- */

{
  // 2 × adventurerXp is 10 000 xp for 2000 mora, both from the shared tables.
  const before = (await get('/api/player/state')).b.player;
  const lvl0 = before.characters[firstChar].level;
  const r = await post('/api/char/levelup', { charId: firstChar, materials: { adventurerXp: 2 } });
  check('level up a character', r.status === 200 && r.b.level > lvl0,
    `${firstChar} ${lvl0} -> ${r.b.level} (cap ${r.b.cap})`);
  check('levelling charges mora', (r.b.player?.mora ?? 0) === before.mora - (r.b.moraSpent ?? -1),
    `${before.mora} - ${r.b.moraSpent} = ${r.b.player?.mora}`);
  check('levelling spends the books',
    (r.b.player?.inventory?.adventurerXp ?? 99) === before.inventory.adventurerXp - 2,
    `${before.inventory.adventurerXp} -> ${r.b.player?.inventory?.adventurerXp}`);
  check('stats follow the level', (r.b.stats?.[firstChar]?.atk ?? 0) > (stats[firstChar]?.atk ?? 1e9),
    `atk ${stats[firstChar]?.atk} -> ${r.b.stats?.[firstChar]?.atk}`);

  const noMat = await post('/api/char/levelup', { charId: firstChar, materials: {} });
  check('levelling needs materials', noMat.status === 400 && noMat.b.error === 'no_materials',
    `status ${noMat.status} ${noMat.b.error}`);
  const ghost = await post('/api/char/levelup', { charId: 'nobody', materials: { adventurerXp: 1 } });
  check('cannot level an unowned character', ghost.status === 400 && ghost.b.error === 'character_not_owned',
    `${ghost.b.error}`);

  // Ascension and talents both have material and mora gates a fresh guest cannot meet, so
  // what is asserted is that they refuse cleanly with a named error rather than throwing.
  const asc = await post('/api/char/ascend', { charId: firstChar });
  check('ascend answers with a decision, not a crash',
    asc.status === 200 || (asc.status === 400 && typeof asc.b.error === 'string'),
    `status ${asc.status} ${asc.b.error ?? 'ascended'}`);
  const tal = await post('/api/char/talent', { charId: firstChar, which: 'normal' });
  check('talent answers with a decision, not a crash',
    tal.status === 200 || (tal.status === 400 && typeof tal.b.error === 'string'),
    `status ${tal.status} ${tal.b.error ?? 'upgraded'}`);
  const badTal = await post('/api/char/talent', { charId: firstChar, which: 'telekinesis' });
  check('unknown talent is refused', badTal.status === 400, `status ${badTal.status} ${badTal.b.error}`);
}

/* -------------------------------------------------------------- equipment ---- */

{
  const p = (await get('/api/player/state')).b.player;
  const weapon = p.equipment.find((e) => e.kind === 'weapon' && e.equippedBy === firstChar);
  if (check('starter weapon is equipped', !!weapon, weapon?.id)) {
    const off = await post('/api/char/unequip', { charId: firstChar, slot: 'weapon' });
    check('unequip', off.status === 200, `status ${off.status}`);
    const bare = (await get('/api/player/state')).b.player;
    check('unequipped weapon is free',
      !bare.equipment.find((e) => e.uid === weapon.uid)?.equippedBy);
    // An unequipped weapon is the only thing a fresh guest can legally destroy.
    const salv = await post('/api/inventory/salvage', { uids: [weapon.uid] });
    check('salvage answers', salv.status === 200 || salv.status === 400,
      `status ${salv.status} ${salv.b.error ?? `+${salv.b.mora} mora`}`);
    if (salv.status !== 200) {
      const on = await post('/api/char/equip', { charId: firstChar, uid: weapon.uid, slot: 'weapon' });
      check('re-equip', on.status === 200, `status ${on.status}`);
    }
  }
  const ghost = await post('/api/char/equip', { charId: firstChar, uid: 'no_such_uid', slot: 'weapon' });
  check('cannot equip a uid you do not own', ghost.status >= 400, `status ${ghost.status}`);
  const auto = await post('/api/char/autoequip', { charId: firstChar });
  check('autoequip', auto.status === 200, `status ${auto.status}`);
}

/* ----------------------------------------------------------------- quests ---- */

{
  const q = await get('/api/quests');
  const list = q.b.quests || q.b.active || [];
  check('quest list', q.status === 200 && list.length > 0, `${list.length} quests`);
  const intro = list.find((x) => x.id === 'q_intro');
  check('intro quest is active', intro?.state === 'active',
    `state ${intro?.state} stage ${intro?.stageIndex}`);

  // q_intro stage 1 is "talk to the scholar", stage 2 is "reach the statue". Both are driven
  // through the route that owns the action, because that is now the *only* way a quest can
  // advance — the body-driven `/api/quest/event` is gone (see below).
  const stage0 = intro?.stageIndex ?? 0;
  const talk = await post('/api/world/talk', { zone: 'mondstadt', npcId: 'scholar' });
  check('talk to an NPC', talk.status === 200 && !!talk.b.npc, `${talk.b.npc?.name}`);
  check('talking advances the quest', (talk.b.questUpdates || []).length > 0,
    JSON.stringify(talk.b.questUpdates || []).slice(0, 120));
  const ev = await post('/api/world/unlock', { zone: 'mondstadt', poiId: 'mond_statue' });
  check('reaching the statue is what emits the `reach` event',
    ev.status === 200 && (ev.b.questUpdates || []).some((u) => u.questId === 'q_intro'),
    `status ${ev.status}, updates ${JSON.stringify(ev.b.questUpdates || []).slice(0, 90)}`);
  const q2 = await get('/api/quests');
  const intro2 = (q2.b.quests || q2.b.active || []).find((x) => x.id === 'q_intro');
  check('intro quest moved on',
    intro2 && (intro2.state !== 'active' || (intro2.stageIndex ?? 0) > stage0),
    `stage ${stage0} -> ${intro2?.stageIndex} state ${intro2?.state}`);
  // Two of three stages done means the third (kill three slimes) is the only one left,
  // and its counter is still zero — combat is the gateway's business, not REST's.
  check('finished stages are marked done',
    (intro2?.stages || []).filter((x) => x.done).length >= 2,
    (intro2?.stages || []).map((x) => `${x.id}:${x.have}/${x.count}${x.done ? '✓' : ''}`).join(' '));

  const ghostNpc = await post('/api/world/talk', { zone: 'mondstadt', npcId: 'nobody' });
  check('unknown NPC is a 404', ghostNpc.status === 404, `status ${ghostNpc.status}`);

  /* --- the two doors that used to be open ---------------------------------- */
  // `POST /api/quest/event` took its kind and count from the request body, so it could finish a
  // quest — and collect its 20–120 primogems — without the action ever happening. It existed
  // for the 单机 client, which turns out never to have called it: every kind a stage waits on
  // has a validating route (`QUEST_EVENT_SOURCES`), and the gate below is what keeps that true.
  const forgedQuest = await post('/api/quest/event', { kind: 'kill', target: 'any', count: 99 });
  check('the body-driven quest event route is gone', forgedQuest.status === 404,
    `status ${forgedQuest.status}`);
  // And `POST /api/quest/dailies/reset` re-armed all four dailies on demand: a finished daily
  // row *is* the receipt for today's payout, so re-arming it paid again, without limit.
  const gemsBefore = (await get('/api/player/state')).b.player?.primogem ?? 0;
  const resetGone = await post('/api/quest/dailies/reset', {});
  check('the on-demand daily reset route is gone', resetGone.status === 404,
    `status ${resetGone.status}`);
  const gemsAfter = (await get('/api/player/state')).b.player?.primogem ?? 0;
  check('and it cannot have paid anything on the way out', gemsAfter === gemsBefore,
    `${gemsBefore} -> ${gemsAfter}`);

  /* --- the rollover that replaced them ------------------------------------- */
  check('the quest catalogue passes its own gate', questGateReport().length === 0,
    questGateReport().join(' | '));
  // Every stage kind must have a producer and every producer must have a consumer; that is what
  // makes deleting the body-driven route safe rather than a way to strand a quest chain.
  const kinds = new Set();
  for (const def of Object.values(QUESTS)) for (const s of def.stages || []) kinds.add(s.kind);
  check('every kind a stage waits on names the server path that produces it',
    [...kinds].every((k) => !!QUEST_EVENT_SOURCES[k]) && kinds.size >= 8,
    `${kinds.size} kinds: ${[...kinds].join(' ')}`);

  const qd = await get('/api/quests');
  const dailies = (qd.b.quests || []).filter((x) => x.type === 'daily');
  check('the four commissions are listed and active',
    dailies.length === DAILY_IDS.length && dailies.every((x) => x.state !== undefined),
    dailies.map((x) => `${x.id}:${x.state}`).join(' '));
  // A countdown, not a deadline: the number is only ever rendered, never compared against.
  const until = (qd.b.dailyResetAt || 0) - Date.now();
  check('the list carries when today ends', until > 0 && until <= 24 * 3600e3 + 1000,
    `${(until / 3600e3).toFixed(1)}h away`);
  // Reading the list twice inside one period must not roll anything: the rollover is keyed on
  // the period, so an idempotent read is the whole point. `rolled` on the first call may be
  // non-empty (a brand-new account has no rows yet), on the second it must be empty.
  const qd2 = await get('/api/quests');
  check('reading the list again inside the same period rolls nothing',
    Array.isArray(qd2.b.rolled) && qd2.b.rolled.length === 0,
    `rolled ${JSON.stringify(qd2.b.rolled)}`);

  // The pure half, with a clock this tool controls: yesterday's rows are stale, today's are
  // not, and a row from a build that never stamped one counts as stale so it rolls once.
  const now = Date.now();
  const fresh = Object.fromEntries(DAILY_IDS.map((id) => [id, { state: 'done', at: now }]));
  check('a row written this period is not rolled', dailiesToRoll(fresh, now).length === 0);
  check('a row written before 04:00 yesterday is rolled',
    dailiesToRoll(fresh, now + 2 * 86400e3).length === DAILY_IDS.length,
    `${dailiesToRoll(fresh, now + 2 * 86400e3).length} of ${DAILY_IDS.length}`);
  const unstamped = Object.fromEntries(DAILY_IDS.map((id) => [id, { state: 'done' }]));
  check('a row with no period stamp is rolled once',
    dailiesToRoll(unstamped, now).length === DAILY_IDS.length);
  check('a missing row is rolled', dailiesToRoll({}, now).length === DAILY_IDS.length);
}

/* ------------------------------------------------------------------ wish ----- */

{
  const pools = await get('/api/wish/pools');
  check('wish pools', pools.status === 200 && (pools.b.pools?.length ?? Object.keys(pools.b.pools || {}).length) >= 2,
    JSON.stringify(Object.keys(pools.b)).slice(0, 80));

  const before = (await get('/api/player/state')).b.player;
  const r = await post('/api/wish/pull', { pool: 'standard', count: 10 });
  const pulls = r.b.pulls || r.b.results || [];
  check('ten-pull', r.status === 200 && pulls.length === 10, `${pulls.length} results`);
  check('every pull has a rarity of 3 to 5',
    pulls.length > 0 && pulls.every((x) => x.rarity >= 3 && x.rarity <= 5),
    pulls.map((x) => x.rarity).join(''));
  // A ten-pull guarantees at least one 4-star; that is the whole point of the counter.
  check('ten-pull guarantees a 4-star', pulls.some((x) => x.rarity >= 4),
    `max ${Math.max(0, ...pulls.map((x) => x.rarity))}`);
  const after = r.b.player ?? (await get('/api/player/state')).b.player;
  // Tickets first, primogems only when tickets run out — a fresh guest has exactly ten.
  check('ten-pull costs ten tickets', after.wishTicket === before.wishTicket - 10,
    `${before.wishTicket} -> ${after.wishTicket}`);
  check('primogems untouched while tickets last', after.primogem === before.primogem,
    `${before.primogem} -> ${after.primogem}`);

  const hist = await get('/api/wish/history');
  check('wish history recorded', (hist.b.history || hist.b.pulls || []).length >= 10,
    `${(hist.b.history || hist.b.pulls || []).length} rows`);

  const broke = await post('/api/wish/pull', { pool: 'standard', count: 3 });
  check('only 1 and 10 pulls exist', broke.status === 400, `status ${broke.status}`);
  const badPool = await post('/api/wish/pull', { pool: 'weapon', count: 1 });
  check('unknown pool is refused', badPool.status === 400, `status ${badPool.status}`);
}

/* --------------------------------------------------------------- chamber ----- */

{
  // The Abyss trial is the one dungeon open at AR 1. `time` under the chamber's par
  // should earn stars; a deliberately terrible time should clear nothing.
  const dz = Object.values(ZONES).find((z) => z.kind === 'dungeon' && (z.chambers?.length ?? 0) > 0);
  const floor = dz.chambers[0].floor ?? 1;
  const slow = await post('/api/world/chamber', { zone: dz.id, floor, time: 9999 });
  check('a hopeless time earns no stars', slow.status === 200 && slow.b.stars === 0,
    `${dz.id} f${floor} stars ${slow.b.stars}`);
  check('a hopeless time costs no resin', slow.b.resin === undefined && slow.b.drops === undefined,
    JSON.stringify({ resin: slow.b.resin, drops: slow.b.drops }));
  const resinBefore = (await get('/api/player/state')).b.player.resin;
  const fast = await post('/api/world/chamber', { zone: dz.id, floor, time: 1 });
  check('a fast clear earns stars', fast.status === 200 && fast.b.stars > 0 && fast.b.cleared === true,
    `stars ${fast.b.stars} reward ${JSON.stringify(fast.b.reward || {}).slice(0, 60)}`);

  // The drop is the repeatable half of a clear, and the resin is what it costs. Both
  // have to be true of the same response: resin left the account *and* something came
  // back for it, in this domain's own artifact sets.
  const cost = dz.domain.resin ?? DOMAIN_RESIN;
  check('the clear spends resin', fast.b.resin?.spent === cost && fast.b.player.resin === resinBefore - cost,
    `${resinBefore} -> ${fast.b.player.resin} (cost ${cost})`);
  const arts = fast.b.drops?.artifacts || [];
  check('and drops an artifact from this domain', arts.length > 0
    && arts.every((a) => dz.domain.sets.includes(a.setId)),
    arts.map((a) => `${a.setId}/${a.slot}+${a.level}`).join(' '));
  check('the artifact is in the player\'s equipment',
    arts.every((a) => (fast.b.player.equipment || []).some((e) => e.uid === a.uid)),
    `${fast.b.player.equipment?.length} pieces`);
  check('and the talent material landed in the bag',
    Object.entries(fast.b.drops?.items || {}).every(([id, n]) => (fast.b.player.inventory?.[id] || 0) >= n),
    JSON.stringify(fast.b.drops?.items || {}));
  const ghost = await post('/api/world/chamber', { zone: dz.id, floor: 19, time: 1 });
  check('unknown chamber is a 404', ghost.status === 404 && ghost.b.error === 'no_such_chamber',
    `status ${ghost.status} ${ghost.b.error || ''}`);
  const notDungeon = await post('/api/world/chamber', { zone: 'mondstadt', floor: 1, time: 1 });
  check('...and an open-world zone has no floors to claim',
    notDungeon.status === 404 && notDungeon.b.error === 'not_a_dungeon',
    `status ${notDungeon.status} ${notDungeon.b.error || ''}`);

  // This route grants levels off a client-reported time, so the authorisation the
  // gateway applies to START_CHAMBER has to hold here too -- and since `chamberEntry`, it is
  // literally the same function. Floor 1 is starred by now, which unlocks floor 2 -- so floor 3
  // is the one that must still be shut. The *code* is asserted, not only the status: three
  // different refusals share 403, and "forbidden for some reason" is not the claim.
  const locked = await post('/api/world/chamber', { zone: dz.id, floor: 3, time: 1 });
  check('a locked floor cannot be claimed',
    locked.status === 403 && locked.b.error === 'previous_floor_locked',
    `status ${locked.status} ${locked.b.error || ''}`);
  const gated = Object.values(ZONES).find((z) => z.kind === 'dungeon' && (z.entryRank || 1) > 5);
  const overRank = await post('/api/world/chamber', { zone: gated.id, floor: 1, time: 1 });
  check('a dungeon above the guest rank cannot be claimed',
    overRank.status === 403 && overRank.b.error === 'rank_too_low'
    && overRank.b.need === zoneEntryRank(gated),
    `${gated.id} needs AR ${gated.entryRank}: status ${overRank.status} ${overRank.b.error || ''} need ${overRank.b.need}`);

  // A re-run is the whole point of the resin loop, so the two rewards have to come
  // apart: no second milestone (that would be one fight paid twice), but a full drop.
  const again = await post('/api/world/chamber', { zone: dz.id, floor, time: 1 });
  check('re-clearing a starred floor grants no second milestone',
    again.status === 200 && !again.b.reward?.mora && !again.b.reward?.primogem
    && !again.b.arResult && !again.b.partyLevels,
    `reward ${JSON.stringify(again.b.reward || {})} ar ${JSON.stringify(again.b.arResult)}`);
  check('but still pays its resin-bought drop',
    (again.b.drops?.artifacts?.length ?? 0) > 0 && again.b.resin?.spent === cost,
    `${again.b.resin?.left} resin left`);

  // Drain the bar and the drop stops while the record does not: a player out of resin
  // still clears the floor, banks the stars and keeps the best time.
  let left = again.b.resin.left;
  let last = again;
  for (let i = 0; i < 12 && left >= cost; i++) {
    last = await post('/api/world/chamber', { zone: dz.id, floor, time: 1 });
    left = last.b.resin?.left ?? 0;
  }
  const dry = await post('/api/world/chamber', { zone: dz.id, floor, time: 1 });
  check('an empty resin bar buys no drop', dry.b.resin?.short === true && !dry.b.drops,
    `left ${dry.b.resin?.left} < ${cost}`);
  check('and the clear is still recorded', dry.status === 200 && dry.b.cleared === true && dry.b.stars > 0,
    `stars ${dry.b.stars}`);
  check('the resin bar really is spent, not refunded', (dry.b.player.resin ?? 999) < cost,
    `${dry.b.player.resin} resin`);

  // `POST /api/dev/resin-rewind` — and it is checked *here* because the empty bar above is the
  // one state that makes a refill measurable. The hook exists so a probe can walk a dungeon:
  // eight floors x 20 resin is two full bars, so `tools/deep-check.mjs` runs dry on floor 4 and
  // every drop assertion below that would collapse into "the bar was empty", which this section
  // already proves on floor 1. Its own docstring claimed these assertions lived here; they did
  // not, and the route had **no caller anywhere in the repo** — the dead-route shape this project
  // has now been bitten by three times.
  //
  // What it must not be is a resin faucet. It moves `resinAt` back and re-runs the *real*
  // `regenResin`, so a week's rewind is worth a capped bar and not 1 260 resin — that ceiling is
  // the whole reason it is safe, so it is the assertion, from both sides.
  const prog = readFileSync(new URL('../server/src/services/progression.js', import.meta.url), 'utf8');
  const RESIN_CAP = Number(/export const RESIN_CAP = (\d+)/.exec(prog)?.[1]);
  const RESIN_PERIOD_S = (() => {
    const m = /export const RESIN_PERIOD_MS = (\d+) \* (\d+) \* (\d+)/.exec(prog);
    return m ? (Number(m[1]) * Number(m[2]) * Number(m[3])) / 1000 : NaN;
  })();
  check('the resin constants were read off the service that owns them',
    RESIN_CAP > 0 && RESIN_PERIOD_S > 0, `cap ${RESIN_CAP}, one point every ${RESIN_PERIOD_S}s`);

  const anonRw = await (async () => {
    const t = token; token = '';
    const r = await post('/api/dev/resin-rewind', { seconds: 60 });
    token = t; return r;
  })();
  check('the resin rewind hook needs a token', anonRw.status === 401, `status ${anonRw.status}`);
  const rwJunk = await post('/api/dev/resin-rewind', { seconds: 0 });
  const rwHuge = await post('/api/dev/resin-rewind', { seconds: 8 * 24 * 3600 });
  const rwNone = await post('/api/dev/resin-rewind', {});
  check('...and validates its input',
    rwJunk.status === 400 && rwHuge.status === 400 && rwNone.status === 400,
    `0s → ${rwJunk.status}, 8 days → ${rwHuge.status}, {} → ${rwNone.status}`);

  const dryResin = dry.b.player.resin ?? 0;
  const rwWeek = await post('/api/dev/resin-rewind', { seconds: 7 * 24 * 3600 });
  const rwAgain = await post('/api/dev/resin-rewind', { seconds: 7 * 24 * 3600 });
  check('a week fills the bar to the cap and no further',
    rwWeek.status === 200 && rwWeek.b.resin === RESIN_CAP && rwWeek.b.cap === RESIN_CAP
    && rwWeek.b.gained === RESIN_CAP - dryResin
    && rwAgain.b.resin === RESIN_CAP && rwAgain.b.gained === 0,
    `${dryResin} → ${rwWeek.b.resin} (+${rwWeek.b.gained}), a second week +${rwAgain.b.gained}`);
  check('...and the filled bar is in the save, not just the reply',
    (await get('/api/player/state')).b.player?.resin === RESIN_CAP,
    `${(await get('/api/player/state')).b.player?.resin} resin`);

  // The half that matters to a probe: the refilled bar buys drops again, on the same floor
  // that a moment ago answered `short`.
  const wet = await post('/api/world/chamber', { zone: dz.id, floor, time: 1 });
  check('a refilled bar buys the drop the empty one refused',
    wet.b.resin?.short === false && wet.b.resin?.spent === cost
    && (wet.b.drops?.artifacts?.length ?? 0) > 0,
    `spent ${wet.b.resin?.spent}, left ${wet.b.resin?.left}, `
    + `${wet.b.drops?.artifacts?.length} artifacts`);

  // Three periods, three points — the amount is the *authored* regen rate applied to the
  // rewound clock, not a number this route picks. Measured after the two calls above on
  // purpose: filling to the cap re-anchors `resinAt` to now (`regenResin` does that when the
  // bar is full), so the elapsed time this rewind is added to is a few seconds rather than
  // however long this probe has been running, and `3` is exact instead of 3-or-4.
  const wetResin = wet.b.resin?.left ?? 0;
  const rwSmall = await post('/api/dev/resin-rewind', { seconds: 3 * RESIN_PERIOD_S });
  check('a rewind is worth exactly what the regen rate says',
    rwSmall.status === 200 && rwSmall.b.gained === 3 && rwSmall.b.resin === wetResin + 3,
    `${wetResin} + 3 periods of ${RESIN_PERIOD_S}s → ${rwSmall.b.resin} (gained ${rwSmall.b.gained})`);
}

/* --------------------------------------------------------- artifact levels ---- */

// Enhancement is the other half of the domain loop, so it is checked on the pile the
// resin loop above just farmed. Two things matter more than the status code: that an
// enhanced piece is worth *exactly* what a piece that dropped at that level is worth
// (otherwise the two sources disagree about what a level means), and that feeding it
// destroys precisely the fodder it needed and no more.
{
  const p = (await get('/api/player/state')).b.player;
  const spares = (p.equipment || []).filter((e) => e.kind === 'artifact' && !e.equippedBy && !e.locked);
  if (check('the domain runs left a pile of artifacts to work with', spares.length >= 4,
    `${spares.length} spare pieces`)) {
    // Target: the lowest piece, so there is room to climb. Fodder: everything else.
    const sorted = [...spares].sort((a, b) => a.level - b.level);
    const target = sorted[0];
    const fodder = sorted.slice(1);
    const offered = fodder.reduce((a, e) => a + artifactFodderXp(e), 0);
    const before = { level: target.level, main: target.main.value, subs: target.subs.length, mora: p.mora };

    // The lock is the only thing standing between a considered player and a mis-click,
    // so it has to hold against both destroyers.
    const keep = sorted[sorted.length - 1];
    const lk = await post('/api/inventory/lock', { uid: keep.uid, locked: true });
    check('an artifact can be locked', lk.status === 200 && lk.b.locked === true
      && lk.b.player.equipment.find((e) => e.uid === keep.uid)?.locked === true, `${keep.uid}`);
    const eat = await post('/api/inventory/enhance', { uid: target.uid, fodder: [keep.uid] });
    check('a locked piece is not fodder', eat.status === 400 && eat.b.error === 'no_usable_fodder',
      `status ${eat.status} ${eat.b.error}`);
    const sal = await post('/api/inventory/salvage', { uids: [keep.uid] });
    check('and cannot be salvaged either', sal.status === 400 && sal.b.error === 'nothing_salvageable',
      `status ${sal.status} ${sal.b.error}`);
    await post('/api/inventory/lock', { uid: keep.uid, locked: false });
    check('unlocking puts it back in play',
      (await get('/api/player/state')).b.player.equipment.find((e) => e.uid === keep.uid)?.locked === false);

    const bad = await post('/api/inventory/enhance', { uid: target.uid, fodder: [target.uid] });
    check('a piece cannot eat itself', bad.status === 400 && bad.b.error === 'no_usable_fodder',
      `status ${bad.status} ${bad.b.error}`);
    const worn = (p.equipment || []).find((e) => e.kind === 'artifact' && e.equippedBy);
    if (worn) {
      const eq = await post('/api/inventory/enhance', { uid: target.uid, fodder: [worn.uid] });
      check('an equipped piece is not fodder', eq.status === 400 && eq.b.error === 'no_usable_fodder',
        `status ${eq.status} ${eq.b.error}`);
    }

    // Two pieces first, deliberately short of the cap, so the partial case is covered
    // and there is still a climb left for the equipped test below.
    const part = fodder.slice(0, 2);
    const r = await post('/api/inventory/enhance', { uid: target.uid, fodder: part.map((e) => e.uid) });
    check('enhancing raises the level', r.status === 200 && r.b.level > before.level,
      `+${r.b.from} -> +${r.b.level} for ${r.b.consumed} pieces, ${r.b.xpSpent} xp`);
    check('and never spends more than was offered',
      r.b.consumed <= part.length && r.b.xpSpent <= part.reduce((a, e) => a + artifactFodderXp(e), 0),
      `${r.b.consumed}/${part.length} eaten of ${offered} xp on the table`);
    check('the eaten pieces are gone from the bag',
      (r.b.player.equipment || []).filter((e) => part.some((f) => f.uid === e.uid)).length === 0,
      `${before.subs} -> ${r.b.artifact.subs.length} subs`);
    check('mora is charged at the published rate',
      r.b.moraCost === Math.round(r.b.xpSpent * ARTIFACT_MORA_PER_XP)
      && r.b.player.mora === before.mora - r.b.moraCost,
      `${r.b.xpSpent} xp -> ${r.b.moraCost} mora`);

    // The consistency assertion: main stat is the slot's table scaled by the generator's
    // own level fraction, so `enhance` and `generateArtifact` cannot drift apart.
    const mainMax = (ARTIFACT_MAIN_STATS[r.b.artifact.slot] || [])
      .find((m) => m[0] === r.b.artifact.main.key)?.[1];
    const expect = mainMax * (0.2 + 0.8 * (r.b.level / ARTIFACT_LEVEL_CAP)) * (r.b.artifact.rarity === 5 ? 1 : 0.78);
    check('the main stat matches what a natural drop at that level would roll',
      Math.abs(r.b.artifact.main.value - expect) < 1e-3,
      `${r.b.artifact.main.key} ${r.b.artifact.main.value} vs ${Math.round(expect * 1e4) / 1e4}`);
    check('sub-stats grew rather than being re-rolled',
      r.b.artifact.subs.length >= before.subs
      && target.subs.every((s, i) => r.b.artifact.subs[i]?.key === s.key
        && r.b.artifact.subs[i].value >= s.value),
      r.b.artifact.subs.map((s) => `${s.key} ${s.value}`).join(', '));

    // Wearing it and enhancing it has to move the wearer's stats: the artifact object is
    // shared by reference with the character instance, and a copy here would silently
    // leave the equipped piece at its old numbers until the next login.
    const spare2 = ((await get('/api/player/state')).b.player.equipment || [])
      .filter((e) => e.kind === 'artifact' && !e.equippedBy && e.uid !== target.uid);
    if (check('there is still fodder and room left for the equipped case',
      r.b.level < ARTIFACT_LEVEL_CAP && spare2.length > 0, `+${r.b.level}, ${spare2.length} spares`)) {
      const on = await post('/api/char/equip', { charId: firstChar, uid: target.uid, slot: target.slot });
      const statBefore = on.b.stats?.[firstChar];
      const r2 = await post('/api/inventory/enhance', { uid: target.uid, fodder: spare2.map((e) => e.uid) });
      const statAfter = r2.b.stats?.[firstChar];
      check('enhancing a worn piece moves the wearer\'s stats',
        r2.status === 200 && !!statBefore && !!statAfter
        && JSON.stringify(statBefore) !== JSON.stringify(statAfter),
        `+${r2.b.from} -> +${r2.b.level} on ${firstChar}`);
      // Everything left was offered; the cap is where it stops, and the surplus stays.
      check('feeding past the cap stops at the cap and keeps the surplus',
        r2.b.level === ARTIFACT_LEVEL_CAP && r2.b.consumed < spare2.length,
        `+${r2.b.level}, ate ${r2.b.consumed}/${spare2.length}`);
      const maxed = await post('/api/inventory/enhance', {
        uid: target.uid, fodder: spare2.slice(-1).map((e) => e.uid),
      });
      check('a maxed piece refuses more fodder',
        maxed.status === 400 && maxed.b.error === 'already_max',
        `status ${maxed.status} ${maxed.b.error}`);
    }
  }
  const nothing = await post('/api/inventory/enhance', { uid: 'no_such_uid', fodder: ['x'] });
  check('enhancing a uid you do not own is a 404', nothing.status === 404, `status ${nothing.status}`);
}

/* ----------------------------------------------------------- weapon levels ---- */

// The weapon axis. `enemyStatAtLevel` is the *product* of the character curve and the
// weapon curve, and until now only one of them could move: every weapon was minted at
// level 1 and no route could raise it, so enemy hp was priced against 24 % of attack the
// player could never buy. These assertions therefore care about the same two things the
// artifact ones do — that the price is what was published, and that the wielder's panel
// actually moves — plus one the artifacts do not have: that xp is *banked*, because the
// ore that pays for it comes in 1 000-xp chunks against levels that cost tens of
// thousands, and a route that rounded the remainder away would silently eat most of a
// mining trip.
// Labelled so the construction below can give up with one red assertion instead of a stack
// trace: this section used to die on `WEAPONS[worn.weaponId]` when the pull happened to leave
// no usable duplicate, and a crash here takes every later section's assertions with it.
weaponLoot: {
  // Mine the ore. It is gatherable in every open world, regrows on the 6 h window, and
  // before this appeared in no recipe, no ascension cost and no route at all.
  const oreNodes = NODES.filter((n) => WEAPON_ORE.includes(n.kind));
  let mined = 0;
  for (const n of oreNodes) {
    const r = await post('/api/world/gather', { zone: 'mondstadt', nodeId: n.id });
    if (r.status === 200) mined += Object.values(r.b.items || {}).reduce((a, v) => a + v, 0);
  }
  let p = (await get('/api/player/state')).b.player;
  const bag = () => WEAPON_ORE.reduce((a, o) => a + (p.inventory[o] || 0), 0);
  check('mondstadt has weapon ore to mine', oreNodes.length > 0 && mined > 0,
    `${oreNodes.length} nodes -> ${mined} chunks`);
  check('the mined ore is in the bag', bag() >= mined,
    WEAPON_ORE.map((o) => `${o}x${p.inventory[o] || 0}`).join(' '));

  // Which weapon this section works on is chosen, not taken from slot 0, and the reason is a
  // check that used to fail about two runs in five: refinement needs a *duplicate*, autoequip
  // deliberately wears the best weapon the ten pulls produced, and the best one is usually the
  // singleton 4★ — so "the ten pulls left duplicates" went red while the bag plainly held three
  // travelersBlades. The luck was in which weapon was worn, never in whether duplicates
  // existed. So wear one of the duplicates: prefer an equipped weapon that already has a spare,
  // otherwise equip a spare from the deepest stack onto a character whose weapon type matches.
  const stacksOf = (pp) => {
    const out = {};
    for (const e of (pp.equipment || []).filter((x) => x.kind === 'weapon')) {
      (out[e.weaponId] = out[e.weaponId] || []).push(e);
    }
    return out;
  };
  const spareIn = (st, id) => (st[id] || []).find((e) => !e.equippedBy && !e.locked);
  let worn = (p.equipment || [])
    .find((e) => e.kind === 'weapon' && e.equippedBy && spareIn(stacksOf(p), e.weaponId));
  if (!worn) {
    const owned = Object.keys(p.characters || {});
    for (const [id, copies] of Object.entries(stacksOf(p)).sort((a, b) => b[1].length - a[1].length)) {
      const spare = copies.length >= 2 ? spareIn(stacksOf(p), id) : null;
      const charId = owned.find((c) => CHARACTERS[c]?.weapon === WEAPONS[id]?.type);
      if (!spare || !charId) continue;
      const on = await post('/api/char/equip', { charId, uid: spare.uid, slot: 'weapon' });
      if (on.status !== 200) continue;
      p = (await get('/api/player/state')).b.player;
      worn = (p.equipment || []).find((e) => e.uid === spare.uid);
      break;
    }
  }
  // Even wearing a duplicate is not guaranteed by ten pulls: this run drew three huntersBows,
  // three ironSpears and two apprenticeTomes, and the guest's two starters can hold none of
  // those three types — so every stack was unequippable and `worn` came out undefined. The
  // blacksmith closes it for mora instead of luck, exactly as the refinement section already
  // does: `smith_<type>` mints the 3★ weapon of that type, so buying one copy of a weapon that
  // is *already worn* turns the wielder into a duplicate holder.
  const SMITH_BY_WEAPON = {
    travelersBlade: 'smith_sword', ironGreatsword: 'smith_claymore', huntersBow: 'smith_bow',
    ironSpear: 'smith_polearm', apprenticeTome: 'smith_catalyst',
  };
  let forgedFor = null;
  if (!worn) {
    const already = (p.equipment || [])
      .find((e) => e.kind === 'weapon' && e.equippedBy && SMITH_BY_WEAPON[e.weaponId]);
    if (already && (await post('/api/shop/buy', { entryId: SMITH_BY_WEAPON[already.weaponId], count: 1 })).status === 200) {
      forgedFor = already.weaponId;
      p = (await get('/api/player/state')).b.player;
      worn = (p.equipment || []).find((e) => e.uid === already.uid);
    }
  }
  if (!check('a worn weapon with a spare copy was obtained, not hoped for',
    !!worn && !!worn.equippedBy && !!spareIn(stacksOf(p), worn.weaponId),
    worn
      ? `${worn.weaponId} on ${worn.equippedBy}, ${(stacksOf(p)[worn.weaponId] || []).length} copies`
        + `${forgedFor ? ' (one forged at the blacksmith)' : ''}`
      : Object.entries(stacksOf(p)).map(([k, v]) => `${k}x${v.length}`).join(' '))) {
    break weaponLoot;
  }
  const rarity = WEAPONS[worn.weaponId].rarity;
  check('a weapon starts at level 1 with nothing banked',
    worn.level === 1 && !worn.xp, `${worn.weaponId} Lv.${worn.level} xp ${worn.xp || 0}`);

  // One chunk of the cheapest ore. Either it buys a level and banks the change or it banks
  // the lot; the assertion is xp conservation, which is the same statement either way.
  const one = await post('/api/inventory/weapon/levelup', { uid: worn.uid, ore: { ironChunk: 1 } });
  check('one chunk of ore is accepted', one.status === 200 && one.b.xpGain === oreXp('ironChunk'),
    `status ${one.status} xpGain ${one.b.xpGain}`);
  check('the cap is the rarity ceiling under the adventure-rank cap',
    one.b.cap === Math.min(WEAPON_LEVEL_CAP[rarity], arCap(p.adventureRank)),
    `cap ${one.b.cap} = min(${WEAPON_LEVEL_CAP[rarity]}, arCap(${p.adventureRank})=${arCap(p.adventureRank)})`);
  check('no xp is lost — levels bought plus the remainder equals what was handed over',
    weaponXpToLevel(rarity, one.b.level) + one.b.xp
      === weaponXpToLevel(rarity, 1) + oreXp('ironChunk'),
    `Lv.${one.b.level} + ${one.b.xp} banked vs ${oreXp('ironChunk')} offered`);
  check('mora is charged at the published rate',
    one.b.moraCost === Math.round(one.b.xpGain * WEAPON_MORA_PER_XP),
    `${one.b.moraCost} mora for ${one.b.xpGain} xp`);
  check('exactly one chunk was taken', one.b.consumed.ironChunk === -1,
    JSON.stringify(one.b.consumed));

  // The wielder's attack has to move, and for the same by-reference reason artifacts do:
  // `characters[x].weapon` and this entry of `p.equipment` are one object.
  const atkBefore = one.b.stats[worn.equippedBy].atk;
  const big = await post('/api/inventory/weapon/levelup', {
    uid: worn.uid, ore: Object.fromEntries(WEAPON_ORE.map((o) => [o, 999])),
  });
  check('the whole bag can be offered at once', big.status === 200, `status ${big.status} ${big.b.error || ''}`);
  check('offering everything stops at the cap', big.b.level === big.b.cap && big.b.xp === 0,
    `Lv.${big.b.level} of ${big.b.cap}, ${big.b.xp} banked`);
  check("the wielder's attack went up", big.b.stats[worn.equippedBy].atk > atkBefore,
    `${atkBefore} -> ${big.b.stats[worn.equippedBy].atk} at Lv.${big.b.level}`);
  check('the levelled weapon reports the stats the shared curve says it should',
    big.b.weapon.level === big.b.cap
      && weaponStats(big.b.weapon).atk === weaponStats({ ...worn, level: big.b.cap }).atk,
    `atk ${weaponStats(big.b.weapon).atk}`);
  // Cheapest first: iron is spent before starsilver, so a full bag does not lose its
  // best ore to a level the worst could have paid for.
  const spent = big.b.consumed;
  check('ore is spent cheapest-first', (spent.ironChunk || 0) < 0
    && !(spent.starsilver < 0 && !(p.inventory.ironChunk || 0)),
    JSON.stringify(spent));
  p = big.b.player;
  check('the ore it could not absorb is still in the bag', bag() > 0,
    WEAPON_ORE.map((o) => `${o}x${p.inventory[o] || 0}`).join(' '));

  const capped = await post('/api/inventory/weapon/levelup', { uid: worn.uid, ore: { ironChunk: 1 } });
  check('a capped weapon refuses more ore',
    capped.status === 400 && capped.b.error === 'level_capped',
    `status ${capped.status} ${capped.b.error}`);
  const notOre = (p.equipment || []).find((e) => e.kind === 'weapon' && !e.equippedBy);
  const junk = await post('/api/inventory/weapon/levelup', { uid: notOre.uid, ore: { sweetFlower: 50 } });
  check('a flower is not ore', junk.status === 400 && junk.b.error === 'no_usable_ore',
    `status ${junk.status} ${junk.b.error}`);
  const art = (p.equipment || []).find((e) => e.kind === 'artifact');
  const wrongKind = await post('/api/inventory/weapon/levelup', { uid: art.uid, ore: { ironChunk: 1 } });
  check('an artifact is not a weapon',
    wrongKind.status === 400 && wrongKind.b.error === 'not_a_weapon',
    `status ${wrongKind.status} ${wrongKind.b.error}`);
  const ghost = await post('/api/inventory/weapon/levelup', { uid: 'no_such_uid', ore: { ironChunk: 1 } });
  check('levelling a weapon you do not own is a 404', ghost.status === 404, `status ${ghost.status}`);

  /* --- refinement --- */

  // The wish pool's 3-star tier has five weapons and most pulls are 3-star, so the ten pulls
  // above are guaranteed to have left duplicates — and the weapon being levelled was picked
  // above *because* it has one, so refinement is reachable on every run rather than on the
  // lucky ones. It is not a route waiting on content that does not exist.
  const stacks = stacksOf(p);
  const wornStack = (stacks[worn.weaponId] || []).filter((e) => !e.equippedBy && !e.locked);
  if (check('the levelled weapon still has its spare to eat', wornStack.length >= 1,
    Object.entries(stacks).map(([k, v]) => `${k}x${v.length}`).join(' '))) {
    const passiveBefore = big.b.stats[worn.equippedBy].weaponPassive;
    const one2 = await post('/api/inventory/weapon/refine', {
      uid: worn.uid, fodder: [wornStack[0].uid],
    });
    check('one duplicate is one rank',
      one2.status === 200 && one2.b.refinement === 2 && one2.b.consumed === 1,
      `R${one2.b.from} -> R${one2.b.refinement}, ate ${one2.b.consumed}`);
    // This is the assertion that makes refinement mean something rather than decorate a
    // tooltip: `weaponPassive` was computed by `buildCharacterStats` and read by nobody,
    // so every weapon's description in `items.js` promised an effect the game did not have.
    const key = Object.keys(passiveBefore || {}).find((k) => typeof passiveBefore[k] === 'number');
    check('refining moves the passive by exactly refineMul', key
      && Math.abs(one2.b.stats[worn.equippedBy].weaponPassive[key]
        - passiveBefore[key] * refineMul(2)) < 1e-6,
      `${key}: ${passiveBefore?.[key]} -> ${one2.b.stats[worn.equippedBy].weaponPassive?.[key]}`);
    // ... and that the always-on ones reach the panel the player reads.
    const tb = one2.b.stats[worn.equippedBy].typeBonus;
    check('an always-on passive shows up in the wielder\'s type bonuses',
      Math.abs((tb.normal + tb.charged + tb.aimed)
        - (one2.b.stats[worn.equippedBy].weaponPassive.normalDmg
          || one2.b.stats[worn.equippedBy].weaponPassive.chargedDmg
          || one2.b.stats[worn.equippedBy].weaponPassive.aimedDmg || 0)) < 1e-6,
      JSON.stringify(tb));

    const self = await post('/api/inventory/weapon/refine', { uid: worn.uid, fodder: [worn.uid] });
    check('a weapon cannot refine itself',
      self.status === 400 && self.b.error === 'no_usable_dupe',
      `status ${self.status} ${self.b.error}`);
    const other = Object.entries(stacks).find(([id, v]) => id !== worn.weaponId && v.length);
    if (other) {
      const wrong = await post('/api/inventory/weapon/refine', { uid: worn.uid, fodder: [other[1][0].uid] });
      check('a different weapon is not a duplicate',
        wrong.status === 400 && wrong.b.error === 'no_usable_dupe',
        `${other[0]} into ${worn.weaponId}: ${wrong.status} ${wrong.b.error}`);
    }
    // The two remaining rules — locked fodder, and the rank cap — need a stack of at least
    // three spares of one weapon, which is more than one ten-pull reliably leaves. This
    // block used to gate itself on `deep.length >= 3` and so *skipped* all four assertions
    // whenever the gacha handed out two of a kind instead of three — while still reporting
    // a clean run. So the stack is now built rather than hoped for: two ten-pulls (the
    // second bought with the 1600 starting primogems at the shared rate) spread over the
    // five 3-star weapons, then the blacksmith tops the deepest pile up with copies that
    // cost mora instead of luck.
    //
    // It runs on a throwaway guest for two reasons: 40 000 mora of forging and 1600
    // primogems of wishes would move balances that the shop, mail and achievement sections
    // assert exact deltas on, and a second ten-pull would move the lifetime `wishes` tally.
    {
      const mainToken = token;
      const g = await post('/api/guest', {});
      token = g.b.token;
      const deepestSpare = async () => {
        const st = {};
        const pl = (await get('/api/player/state')).b.player;
        for (const e of pl.equipment.filter((x) => x.kind === 'weapon' && !x.equippedBy && !x.locked)) {
          (st[e.weaponId] = st[e.weaponId] || []).push(e);
        }
        return Object.values(st).sort((a, b2) => b2.length - a.length)[0] || [];
      };
      await post('/api/wish/pull', { pool: 'standard', count: 10 });
      await post('/api/shop/buy', { entryId: 'bar_wish', count: 10 });
      await post('/api/wish/pull', { pool: 'standard', count: 10 });
      let deep = await deepestSpare();
      // `smith_<type>` mints exactly the 3-star weapon of that type, twice per week, and a
      // fresh guest's 20 000 mora buys one of them — enough to close a one-copy shortfall.
      const SMITH = {
        travelersBlade: 'smith_sword', ironGreatsword: 'smith_claymore', huntersBow: 'smith_bow',
        ironSpear: 'smith_polearm', apprenticeTome: 'smith_catalyst',
      };
      const forged = [];
      while (deep.length < 3 && SMITH[deep[0]?.weaponId]) {
        const buy = await post('/api/shop/buy', { entryId: SMITH[deep[0].weaponId], count: 1 });
        if (buy.status !== 200) break;
        forged.push(deep[0].weaponId);
        deep = await deepestSpare();
      }
      check('a stack deep enough to test the refinement rules was built, not hoped for',
        deep.length >= 3,
        `${deep[0]?.weaponId}x${deep.length}${forged.length ? ` (${forged.length} forged)` : ''}`);
      // Guarded only so a construction that somehow came up short reports one failure
      // instead of a stack trace — the `check` above has already gone red by then, so this
      // can no longer skip four assertions and still call the run clean.
      if (deep.length >= 3) {
        const [tgt, keep, ...fodder] = deep;
        // A locked duplicate is protected from refinement just as it is from salvage: it is
        // the only defence against destroying the copy being saved for a second character.
        await post('/api/inventory/lock', { uid: keep.uid, locked: true });
        const locked = await post('/api/inventory/weapon/refine', { uid: tgt.uid, fodder: [keep.uid] });
        check('a locked duplicate is not fodder either',
          locked.status === 400 && locked.b.error === 'no_usable_dupe',
          `status ${locked.status} ${locked.b.error}`);
        // Offering every spare at once must raise the rank by one per copy, stop at the cap,
        // and charge only the copies it actually used.
        const many = await post('/api/inventory/weapon/refine', {
          uid: tgt.uid, fodder: [...fodder, keep].map((e) => e.uid),
        });
        const want = Math.min(WEAPON_REFINE_MAX, 1 + fodder.length);
        check('refinement is one rank per copy, capped, and charges only what it used',
          many.status === 200 && many.b.refinement === want && many.b.consumed === want - 1,
          `${many.status} ${many.b.error || ''} R1 + ${fodder.length} usable (+1 locked)`
          + ` -> R${many.b.refinement}, ate ${many.b.consumed}`);
        const after = (await get('/api/player/state')).b.player;
        check('the locked copy is still there afterwards',
          !!after.equipment.find((e) => e.uid === keep.uid),
          `${keep.weaponId} ${keep.uid}`);
        // The copies the cap left unspent are still copies — a refine that ate the whole
        // offer and stopped at R5 would be the same 200 with a stolen bag.
        const left = after.equipment.filter((e) => e.weaponId === tgt.weaponId
          && e.uid !== tgt.uid && !e.equippedBy);
        check('the copies the cap could not use are still in the bag',
          left.length === deep.length - 1 - (many.b.consumed ?? 0),
          `${left.length} left of ${deep.length - 1} offered, ate ${many.b.consumed}`);
      }
      token = mainToken;
      // R5 is exactly twice R1 by construction — the one authored number in `refineMul`.
      check('a fully refined weapon would report its passive at exactly double',
        Math.abs(refineMul(WEAPON_REFINE_MAX) - 2) < 1e-9, `refineMul(5) = ${refineMul(5)}`);
    }
  }

  // The whole point is that it is a save, not a session: re-read from the server.
  const back = (await get('/api/player/state')).b;
  const again = back.player.equipment.find((e) => e.uid === worn.uid);
  check('the level and the refinement are persisted, not cached',
    again.level === big.b.cap && (again.refinement || 1) > 1,
    `Lv.${again.level} R${again.refinement}`);
  check('and the reloaded wielder still has the attack the levels bought',
    back.stats[worn.equippedBy].atk >= big.b.stats[worn.equippedBy].atk,
    `atk ${back.stats[worn.equippedBy].atk}`);
}

/* ------------------------------------------------------------- solo kill ----- */

// `POST /api/world/kill` is what pays a 单机 player, whose simulation runs in their own
// browser. It is the only route that grants combat rewards off a client's word, so what
// matters here is not that it returns 200 but that every *number* is the server's: the
// level is clamped to the hardest place the zone tables put that enemy, the loot is
// rolled server-side, and an enemy that cannot be met in the named zone is refused.
{
  const zoneCap = (zdef) => {
    const cap = new Map();
    const bump = (id, lv) => { if (id) cap.set(id, Math.max(cap.get(id) || 0, lv)); };
    for (const s of zdef.spawns || []) for (const id of s.enemies || []) bump(id, s.level || zdef.recommendedLevel || 1);
    // Mirror of `zoneKillLevel`: every wave of every floor, and *not* `c.boss`, which is
    // a flag rather than an enemy id.
    for (const c of zdef.chambers || []) {
      for (const id of chamberEnemies(c)) bump(id, c.level || 1);
    }
    for (const [id, lv] of [...cap]) {
      for (const mv of ENEMIES[id]?.attacks || []) {
        for (const sid of ATTACK_MOVES[mv]?.summon || []) bump(sid, lv);
      }
    }
    return cap;
  };

  const cap = zoneCap(ZONES.mondstadt);
  const [enemyId, capLevel] = [...cap].sort((a, b) => a[1] - b[1])[0];
  const before = (await get('/api/player/state')).b.player;
  const expect = Math.max(1, Math.round(capLevel * (1 + 0.06 * (before.worldLevel || 0))));

  const r = await post('/api/world/kill', { zone: 'mondstadt', enemyId });
  check('a solo kill pays out', r.status === 200 && r.b.mora > 0 && r.b.xp > 0,
    `${enemyId} lv${r.b.level}: ${r.b.mora} mora, ${r.b.xp} xp`);
  check('the level is the zone cap, not the client\'s', r.b.level === expect,
    `expected ${expect}, got ${r.b.level}`);
  const greedy = await post('/api/world/kill', { zone: 'mondstadt', enemyId, level: 120 });
  check('asking for a higher level changes nothing', greedy.b.level === expect,
    `asked 120, paid lv${greedy.b.level}`);

  const after = (await get('/api/player/state')).b.player;
  check('the reward is in the save', after.mora > before.mora && after.adventureXp > before.adventureXp,
    `mora ${before.mora} -> ${after.mora}, xp ${before.adventureXp} -> ${after.adventureXp}`);
  const drops = Object.entries(r.b.items || {}).filter(([k]) => k !== 'mora');
  check('drops are in the inventory', drops.every(([k, n]) => (after.inventory[k] || 0) >= n),
    drops.map(([k, n]) => `${k}x${n}`).join(',') || 'no item drops this roll');
  check('a kill advances quests', (r.b.questUpdates || []).length > 0,
    (r.b.questUpdates || []).map((u) => `${u.questId} ${u.progress?.have}/${u.progress?.need}`).join(' '));

  // An enemy that exists but is not met in this zone: the whole point of the level cap
  // is that a mondstadt client cannot report killing a dungeon boss for its loot.
  let foreign = null;
  for (const z of Object.values(ZONES)) {
    if (z.id === 'mondstadt') continue;
    for (const [id] of zoneCap(z)) if (!cap.has(id)) { foreign = id; break; }
    if (foreign) break;
  }
  const away = await post('/api/world/kill', { zone: 'mondstadt', enemyId: foreign });
  check('an enemy from elsewhere is refused', away.status === 404 && away.b.error === 'not_in_zone',
    `${foreign}: status ${away.status} ${away.b.error || ''}`);
  const ghost = await post('/api/world/kill', { zone: 'mondstadt', enemyId: 'notAnEnemy' });
  check('an unknown enemy is a 404', ghost.status === 404 && ghost.b.error === 'no_such_enemy',
    `status ${ghost.status}`);
  const badZone = await post('/api/world/kill', { zone: 'atlantis', enemyId });
  check('an unknown zone is a 400', badZone.status === 400, `status ${badZone.status}`);
  const gated = Object.values(ZONES).find((z) => (z.entryRank || 1) > (after.adventureRank || 1));
  if (gated) {
    const [gid] = [...zoneCap(gated)][0] || [];
    const over = await post('/api/world/kill', { zone: gated.id, enemyId: gid });
    check('a zone above the guest rank is refused', over.status === 403 && over.b.error === 'rank_too_low',
      `${gated.id} needs AR ${gated.entryRank}: status ${over.status} ${over.b.error || ''}`);
  }
}

/* ---------------------------------------------------------------- social ----- */

{
  const lb = await get('/api/leaderboard?which=score');
  check('leaderboard', lb.status === 200 && Array.isArray(lb.b.top), `${lb.b.top?.length} rows`);
  const online = await get('/api/online');
  check('online list', online.status === 200 && Array.isArray(online.b.players),
    `${online.b.count} online`);
  const chat = await get('/api/chat/recent?channel=world');
  check('recent chat', chat.status === 200 && Array.isArray(chat.b.messages),
    `${chat.b.messages?.length} messages`);
}

/* --------------------------------------------------------------- friends ----- */

// The friend graph is the one part of co-op that outlives a session, and it is stored
// as two rows per friendship (see `repo.friendsOf`), so every assertion here is really
// asking "do *both* sides agree" — a one-sided friendship is the failure mode this
// storage choice invites.
{
  const aToken = token;
  const aId = playerId, aNick = guest.b.nickname;
  const bGuest = await post('/api/guest', {});
  const bToken = bGuest.b.token, bId = bGuest.b.playerId, bNick = bGuest.b.nickname;
  const asA = () => { token = aToken; };
  const asB = () => { token = bToken; };

  const empty = await get('/api/social/friends');
  check('a new account has no friends', empty.status === 200 && !empty.b.friends.length
    && !empty.b.incoming.length && !empty.b.outgoing.length, `max ${empty.b.max}`);

  // By nickname, because that is what a player can actually read off a chat line.
  const req = await post('/api/social/request', { nickname: bNick });
  check('a friend request by nickname finds the player',
    req.status === 200 && req.b.state === 'pending' && Number(req.b.playerId) === Number(bId),
    `${bNick} -> ${req.b.state}`);
  const dup = await post('/api/social/request', { playerId: bId });
  check('the same request twice is refused',
    dup.status === 409 && dup.b.error === 'request_pending', `status ${dup.status} ${dup.b.error}`);
  const self = await post('/api/social/request', { playerId: aId });
  check('you cannot friend yourself',
    self.status === 400 && self.b.error === 'not_yourself', `status ${self.status} ${self.b.error}`);
  const nobody = await post('/api/social/request', { nickname: '这个昵称不存在_zzz' });
  check('an unknown nickname is a 404',
    nobody.status === 404 && nobody.b.error === 'no_such_player', `status ${nobody.status}`);

  const outA = await get('/api/social/friends');
  check('the sender sees it as outgoing',
    outA.b.outgoing.length === 1 && Number(outA.b.outgoing[0].playerId) === Number(bId)
    && !outA.b.friends.length, JSON.stringify(outA.b.outgoing[0] || null).slice(0, 90));

  asB();
  const inB = await get('/api/social/friends');
  check('the recipient sees it as incoming',
    inB.b.incoming.length === 1 && Number(inB.b.incoming[0].playerId) === Number(aId)
    && inB.b.incoming[0].nickname === aNick, `from ${inB.b.incoming[0]?.nickname}`);
  // Offline rows still carry a zone — the one they logged out in — which is what the
  // panel greys out. `online` has to be false: nobody here holds a WebSocket.
  check('an offline row carries a zone but not presence',
    inB.b.incoming[0]?.online === false && !!inB.b.incoming[0]?.zone
    && inB.b.incoming[0]?.joinable === false, `zone ${inB.b.incoming[0]?.zone}`);

  const ghost = await post('/api/social/accept', { playerId: 999999 });
  check('accepting a request that was never sent is a 404',
    ghost.status === 404 && ghost.b.error === 'no_request', `status ${ghost.status}`);
  const acc = await post('/api/social/accept', { playerId: aId });
  check('the recipient can accept', acc.status === 200 && acc.b.state === 'accepted',
    `status ${acc.status}`);
  const twice = await post('/api/social/accept', { playerId: aId });
  check('accepting twice is a 404, not a second friendship',
    twice.status === 404 && twice.b.error === 'no_request', `status ${twice.status}`);

  const bList = await get('/api/social/friends');
  asA();
  const aList = await get('/api/social/friends');
  check('both sides now list each other',
    bList.b.friends.length === 1 && Number(bList.b.friends[0].playerId) === Number(aId)
    && aList.b.friends.length === 1 && Number(aList.b.friends[0].playerId) === Number(bId)
    && !aList.b.outgoing.length && !bList.b.incoming.length,
    `A:${aList.b.friends.length} B:${bList.b.friends.length}`);
  const already = await post('/api/social/request', { playerId: bId });
  check('re-requesting an existing friend is refused',
    already.status === 409 && already.b.error === 'already_friends', `status ${already.status}`);

  // Both sides asking is consent from both sides: the second request must accept the
  // first rather than leave two pending rows neither player can clear.
  const cGuest = await post('/api/guest', {});
  token = cGuest.b.token;
  const cReq = await post('/api/social/request', { playerId: aId });
  asA();
  const back = await post('/api/social/request', { playerId: cGuest.b.playerId });
  check('a reciprocal request accepts instead of piling up',
    cReq.b.state === 'pending' && back.status === 200 && back.b.state === 'accepted',
    `${cReq.b.state} then ${back.b.state}`);

  const gone = await post('/api/social/remove', { playerId: bId });
  const aAfter = await get('/api/social/friends');
  asB();
  const bAfter = await get('/api/social/friends');
  check('removing a friend removes both directions',
    gone.status === 200 && !aAfter.b.friends.some((f) => Number(f.playerId) === Number(bId))
    && !bAfter.b.friends.length, `A has ${aAfter.b.friends.length}, B has ${bAfter.b.friends.length}`);
  const noop = await post('/api/social/remove', { playerId: aId });
  check('removing a stranger is a 404',
    noop.status === 404 && noop.b.error === 'not_found', `status ${noop.status}`);

  asA();
}

/* ------------------------------------------------------------------ shop ----- */

// The shop is the economy's only mora sink, so what is checked here is not "the route
// answers" but that the ledger balances: mora leaves, goods arrive, the daily limit is
// enforced server-side, and the period key that carries the limit is the one the catalogue
// declared. The catalogue itself is asserted too — a shop that sold primogems for mora
// would be a progression bug no status code catches.
{
  const view = await get('/api/shop');
  const shops = view.b.shops || [];
  const general = shops.find((s) => s.id === 'general');
  check('shop catalogue', view.status === 200 && shops.length === SHOP_IDS.length && !!general,
    `${shops.length} shops`);

  // Rule 1 of shared/src/data/shop.js, asserted rather than trusted: no entry anywhere
  // turns mora into premium currency, directly or as part of a mixed cost.
  const laundering = [];
  for (const shop of Object.values(SHOPS)) {
    for (const e of shop.entries) {
      if ((e.item === 'primogem' || e.item === 'wishTicket') && ('mora' in e.cost)) laundering.push(e.id);
    }
  }
  check('mora never buys premium currency', laundering.length === 0, laundering.join(' '));

  const before = (await get('/api/player/state')).b.player;
  const entry = general.entries.find((e) => e.id === 'gen_sweetFlower');
  const unit = entry.cost.mora;
  const buy = await post('/api/shop/buy', { entryId: 'gen_sweetFlower', count: 2 });
  const after = buy.b.player || {};
  check('buying spends exactly the listed price',
    buy.status === 200 && buy.b.bought === 2 && before.mora - after.mora === unit * 2,
    `${before.mora} -> ${after.mora} for 2x${unit}`);
  const invAfter = (await get('/api/player/state')).b.player.inventory;
  check('and the goods arrive',
    (invAfter.sweetFlower ?? 0) - (before.inventory.sweetFlower ?? 0) === entry.count * 2,
    `sweetFlower ${before.inventory.sweetFlower ?? 0} -> ${invAfter.sweetFlower ?? 0}`);
  check('stock is spent against the declared period',
    buy.b.entry.left === entry.limit - 2 && buy.b.entry.resetsAt > Date.now(),
    `left ${buy.b.entry.left}, resets in ${untilText(buy.b.entry.resetsAt - Date.now())}`);

  // Clamp, do not reject: an over-large request buys what is left, which is what keeps a
  // stale client from turning a race into an error dialog.
  const rest = await post('/api/shop/buy', { entryId: 'gen_sweetFlower', count: 99 });
  check('an over-large order clamps to the daily limit',
    rest.status === 200 && rest.b.bought === entry.limit - 2 && rest.b.entry.left === 0,
    `asked 99, got ${rest.b.bought} of ${entry.limit}`);
  const overdraft = await post('/api/shop/buy', { entryId: 'gen_sweetFlower', count: 1 });
  check('and then it is sold out for the period',
    overdraft.status === 400 && overdraft.b.error === 'sold_out', `${overdraft.status} ${overdraft.b.error}`);

  // The currency-for-currency path: the grant lands in a player column, not the inventory,
  // and at exactly the rate the wish route uses.
  const g0 = (await get('/api/player/state')).b.player;
  const wish = await post('/api/shop/buy', { entryId: 'bar_wish', count: 1 });
  check('primogems buy a wish at the shared rate',
    wish.status === 200 && g0.primogem - wish.b.player.primogem === GEM_PER_WISH
    && wish.b.player.wishTicket - g0.wishTicket === 1,
    `${g0.primogem}->${wish.b.player.primogem} gems, ${g0.wishTicket}->${wish.b.player.wishTicket} tickets`);

  // An unlimited entry has no stock row to run out of, and must not grow a `left`.
  check('an unlimited entry reports no limit', wish.b.entry.left === null,
    `left ${JSON.stringify(wish.b.entry.left)}`);

  // Gates. The abyss trader is rank-locked at the shop level and again per entry; either
  // refusal is correct, but the money must not move.
  const rank = wish.b.player.adventureRank;
  const locked = await post('/api/shop/buy', { entryId: 'ab_crown', count: 1 });
  const stillHave = (await get('/api/player/state')).b.player.mora;
  check('a rank/stock gate refuses without charging',
    locked.status === 400
    && ['shop_locked', 'rank_too_low', 'not_enough'].includes(locked.b.error)
    && stillHave === wish.b.player.mora,
    `AR ${rank} -> ${locked.b.error}, mora ${stillHave}`);
  const ghost = await post('/api/shop/buy', { entryId: 'nope_nothing', count: 1 });
  check('an unknown entry is a 404', ghost.status === 404 && ghost.b.error === 'no_entry',
    `status ${ghost.status}`);
  const bad = await post('/api/shop/buy', { entryId: 'gen_mint', count: 0 });
  check('count 0 is invalid input', bad.status === 400 && bad.b.error === 'invalid_input',
    `status ${bad.status}`);

  // A weapon entry mints equipment rather than stacking an item, which is the one grant
  // path that cannot be verified from the inventory map.
  //
  // Both branches below are real assertions, on purpose. Whether this run can *afford* a
  // 20 000 mora sword is not something the script decides: the growth section spends mora on
  // whatever xp material the gather and cook sections happened to roll, so the purse arrives
  // here somewhere either side of the price, and the chamber section has already drained the
  // resin bar that would pay for more. It ran red once on the poor side — and it ran red as a
  // *TypeError* on `gained[0]` of a 400 body, which threw away the ~100 assertions after it and
  // reported nothing about the actual state. A branch is honest here where a SKIP would not be:
  // the poor half asserts the thing that would really hurt, which is a route minting equipment
  // it was never paid for.
  const smith = shops.find((s) => s.id === 'blacksmith');
  const sword = smith.entries.find((e) => e.id === 'smith_sword');
  const price = sword.cost?.mora ?? 0;
  const pre = (await get('/api/player/state')).b.player;
  const eq0 = pre.equipment.length;
  const forged = await post('/api/shop/buy', { entryId: 'smith_sword', count: 1 });
  const post1 = (await get('/api/player/state')).b.player;
  const eq1 = post1.equipment;
  const minted = forged.b.gained?.[0];
  const why = `buy ${forged.status} ${forged.b.error || ''}`.trim();
  if (pre.mora >= price) {
    check('a weapon entry mints equipment',
      forged.status === 200 && eq1.length === eq0 + 1
      && eq1.some((e) => e.uid === minted?.uid && e.weaponId === sword.item),
      `${pre.mora} mora >= ${price}: ${eq0} -> ${eq1.length} equipment, uid ${minted?.uid} (${why})`);
    check('...and charges exactly the listed price for it',
      post1.mora === pre.mora - price, `${pre.mora} -> ${post1.mora} mora`);
    // The poor branch's predicate, exercised on every run instead of only on an unlucky purse —
    // otherwise the branch below is code nobody has ever run. Paying 20 000 leaves this account
    // unable to afford a second sword, and the weekly limit is 2, so the refusal has to be
    // 'not_enough' and not 'sold_out'.
    if (post1.mora < price) {
      const twice = await post('/api/shop/buy', { entryId: 'smith_sword', count: 1 });
      const post2 = (await get('/api/player/state')).b.player;
      check('...and a second one is refused for the money, minting nothing',
        twice.status === 400 && twice.b.error === 'not_enough'
        && post2.equipment.length === eq1.length && post2.mora === post1.mora,
        `${post1.mora} mora < ${price}: ${twice.status} ${twice.b.error || ''}, `
        + `${eq1.length} -> ${post2.equipment.length} equipment, mora ${post1.mora} -> ${post2.mora}`);
    }
  } else {
    check('a weapon entry mints nothing it was not paid for',
      forged.status === 400 && forged.b.error === 'not_enough'
      && eq1.length === eq0 && post1.mora === pre.mora,
      `${pre.mora} mora < ${price}: ${why}, ${eq0} -> ${eq1.length} equipment, mora ${pre.mora} -> ${post1.mora}`);
  }

  // The view has to agree with what the buys just did — the client renders from it, so a
  // `canBuy` that ignores stock would offer a button that always 400s.
  const view2 = await get('/api/shop');
  const e2 = view2.b.shops.find((s) => s.id === 'general').entries.find((e) => e.id === 'gen_sweetFlower');
  check('the view reflects spent stock',
    e2.bought === entry.limit && e2.left === 0 && e2.canBuy === 0,
    `bought ${e2.bought}, canBuy ${e2.canBuy}`);
}

/* ------------------------------------------------------------------ mail ----- */

// The mailbox is the only module whose *creation* path is a GET: opening it materialises the
// letters the current period owes (see `server/src/routes/mail.js`). So the assertions that
// matter are about idempotence — a second GET must not hand out a second sign-in gift — and
// about the delete guard, which is the one operation here that can destroy a reward.
{
  // Attachments round-trip through JSONB, which does not preserve key order — so comparing
  // `JSON.stringify` of two item maps is a coin flip that happens to land right for
  // single-key attachments. Compare as maps.
  const sameMap = (a = {}, b = {}) => {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
  };

  const box0 = await get('/api/mail');
  check('the mailbox opens', box0.status === 200 && Array.isArray(box0.b.mail),
    `${box0.b.total} letters, ${box0.b.claimable} claimable`);
  const byKey = (k) => box0.b.mail.find((m) => m.dedupe === k);
  const hello = byKey('welcome');
  const gift = byKey(`login:${periodKey('daily', box0.b.now)}`);
  check('a new account starts with a welcome letter',
    !!hello && !hello.claimed && Object.keys(hello.attach).length === 4,
    `${hello?.subject} · ${JSON.stringify(hello?.attach)}`);
  check("and today's sign-in gift", !!gift, gift?.subject);

  // The gift is derived from the day, not stored, so the client can compute the same letter
  // the server did. If these ever disagree the rotation has picked up a second source of truth.
  const want = loginMail(box0.b.now);
  check('the sign-in gift is the one the shared table derives',
    !!gift && sameMap(gift.attach, want.attach) && gift.subject === want.subject,
    `${JSON.stringify(gift?.attach)} vs ${JSON.stringify(want.attach)}`);
  check('a letter carries an expiry a month out',
    !!gift && Math.abs((gift.expiresAt - gift.at) / 86400000 - MAIL_TTL_DAYS) < 0.1,
    gift ? `${((gift.expiresAt - gift.at) / 86400000).toFixed(2)} days` : '');
  check('unread and claimable are counted separately',
    box0.b.unread === box0.b.total && box0.b.claimable === box0.b.total,
    `${box0.b.unread} unread, ${box0.b.claimable} claimable of ${box0.b.total}`);
  // By this point in the run the guest has killed things and cleared a chamber, so it *is* on
  // the board and the weekly payout is owed. Its rank is written into the letter's body, which
  // makes the tier checkable against the shared table rather than against a copied number.
  const paid = box0.b.mail.find((m) => (m.dedupe || '').startsWith('board:'));
  if (check('a player who scored is paid for the ladder',
    !!paid && paid.dedupe === `board:${periodKey('weekly', box0.b.now)}`, paid?.subject)) {
    const rank = Number(/第 (\d+) 位/.exec(paid.body)?.[1] || 0);
    const tier = boardTier(rank);
    check('the payout matches the tier for the rank it names',
      rank > 0 && sameMap(paid.attach, tier.attach) && paid.subject.endsWith(tier.label),
      `rank ${rank} → ${tier?.label} ${JSON.stringify(paid.attach)}`);
  }

  // Idempotence: this is the whole justification for having no scheduler.
  const box1 = await get('/api/mail');
  check('reopening the box hands out nothing new',
    box1.b.total === box0.b.total && box1.b.fresh.length === 0
    && box1.b.mail.map((m) => m.id).join() === box0.b.mail.map((m) => m.id).join(),
    `${box0.b.total} -> ${box1.b.total}, fresh ${JSON.stringify(box1.b.fresh)}`);

  // The delete guard, asserted while the letter is still worth something.
  const guard = await post('/api/mail/delete', { ids: [gift.id] });
  const box2 = await get('/api/mail');
  check('an unclaimed letter with an attachment cannot be deleted',
    guard.status === 200 && guard.b.deleted.length === 0
    && box2.b.mail.some((m) => m.id === gift.id),
    `deleted ${JSON.stringify(guard.b.deleted)}, kept ${guard.b.kept}`);

  // Claiming one letter must pay exactly what it listed, across both storage shapes: mora and
  // primogems are player columns, `adventurerXp` and `condensedResin` are inventory rows.
  const before = (await get('/api/player/state')).b.player;
  const claim = await post('/api/mail/claim', { ids: [hello.id] });
  const after = claim.b.player;
  check('claiming pays exactly what the letter listed',
    claim.status === 200 && claim.b.claimed.join() === String(hello.id)
    && sameMap(claim.b.gained, hello.attach),
    JSON.stringify(claim.b.gained));
  check('a currency attachment lands in the column',
    after.mora - before.mora === hello.attach.mora
    && after.primogem - before.primogem === hello.attach.primogem
    && (after.inventory.mora || 0) === (before.inventory.mora || 0),
    `mora ${before.mora}->${after.mora}, gems ${before.primogem}->${after.primogem}`);
  check('a material attachment lands in the bag',
    (after.inventory.adventurerXp || 0) - (before.inventory.adventurerXp || 0)
      === hello.attach.adventurerXp
    && (after.inventory.condensedResin || 0) - (before.inventory.condensedResin || 0)
      === hello.attach.condensedResin,
    `xp ${before.inventory.adventurerXp}->${after.inventory.adventurerXp}`);
  check('the response carries the redrawn box',
    Array.isArray(claim.b.mail) && claim.b.mail.find((m) => m.id === hello.id)?.claimed === true
    && claim.b.claimable === box2.b.claimable - 1,
    `claimable ${box2.b.claimable} -> ${claim.b.claimable}`);

  // The guard against a double claim is the UPDATE's own `claimed=false`, so a second call
  // must pay nothing rather than paying again.
  const twice = await post('/api/mail/claim', { ids: [hello.id] });
  const afterTwice = (await get('/api/player/state')).b.player;
  check('a letter cannot be claimed twice',
    twice.status === 400 && twice.b.error === 'nothing_to_claim'
    && afterTwice.mora === after.mora,
    `status ${twice.status} ${twice.b.error}, mora ${after.mora} -> ${afterTwice.mora}`);

  const seen = await post('/api/mail/seen', {});
  check('marking read clears the unread count',
    seen.status === 200 && seen.b.unread === 0 && seen.b.claimable > 0,
    `unread ${seen.b.unread}, claimable ${seen.b.claimable}`);

  const all = await post('/api/mail/claim', {});
  check('一键领取 takes everything that is left',
    all.status === 200 && all.b.claimed.length === seen.b.claimable && all.b.claimable === 0,
    `${all.b.claimed.length} letters, gained ${JSON.stringify(all.b.gained)}`);
  check('and the sign-in gift was part of it',
    Object.entries(want.attach).every(([id, n]) => (all.b.gained[id] || 0) >= n),
    `${JSON.stringify(want.attach)} in ${JSON.stringify(all.b.gained)}`);

  const wipe = await post('/api/mail/delete', {});
  const box3 = await get('/api/mail');
  check('claimed letters can then be deleted',
    wipe.status === 200 && wipe.b.deleted.length >= 2 && wipe.b.kept === 0,
    `deleted ${wipe.b.deleted.length}, kept ${wipe.b.kept}`);
  // …and the now-empty box must not re-mint today's gift, or 删除已读 would be an infinite
  // source of primogems.
  check('deleting a claimed gift does not re-mint it',
    box3.b.total === 0 && box3.b.fresh.length === 0,
    `${box3.b.total} letters, fresh ${JSON.stringify(box3.b.fresh)}`);

  const empty = await post('/api/mail/claim', {});
  check('claiming an empty box is refused, not silently ok',
    empty.status === 400 && empty.b.error === 'nothing_to_claim', `status ${empty.status}`);
  const bad = await post('/api/mail/claim', { ids: ['nope'] });
  check('mail ids are validated', bad.status === 400 && bad.b.error === 'invalid_input',
    `status ${bad.status}`);

  // Pure: the payout tiers. A ladder nobody is paid for is a scoreboard, and the boundary
  // between "top fifty" and "took part" is the one an off-by-one would hide in.
  check('ladder tiers rank from the top down',
    boardTier(1).label === '榜首' && boardTier(3).label === '前三' && boardTier(10).label === '前十'
    && boardTier(50).label === '前五十' && boardTier(51).label === '参与' && boardTier(0) === null,
    `1:${boardTier(1).label} 51:${boardTier(51).label}`);
  check('a zero score earns no letter at any rank',
    boardMail(1, 0) === null && boardMail(1, 5).attach.primogem === 300,
    JSON.stringify(boardMail(1, 5)?.attach));
}

/* ---------------------------------------------------------- achievements ---- */

// Achievements store nothing but "what has been paid for": progress is re-derived from the
// tables the rest of the game already writes. That makes three things worth asserting, and
// they are the three ways this design can fail:
//
//   1. the snapshot really reads those tables — the guest has opened a chest, cooked, wished
//      and cleared a chamber by now, so every one of those numbers must be non-zero here;
//   2. the key set on the wire is exactly `ACH_STATS` — a stat declared in shared and missing
//      from the query would be an achievement nobody can ever complete, invisibly;
//   3. claiming is priced by the server and can only move a tier forward once.
{
  const gate = achGateReport();
  check('the achievement catalogue passes its own gate', gate.length === 0, gate.join(' | '));

  const a0 = await get('/api/achievements');
  check('the achievement list opens', a0.status === 200 && !!a0.b.progress && !!a0.b.summary,
    `${a0.b.summary?.earnedTiers}/${a0.b.summary?.tiers} tiers, ${a0.b.summary?.claimableTiers} claimable`);

  // The consumer gate, checked against the *server* rather than within shared: declared here,
  // computed there, and neither direction is allowed to drift.
  const declared = Object.keys(ACH_STATS).sort();
  const served = Object.keys(a0.b.progress || {}).sort();
  check('the snapshot serves exactly the declared stats',
    declared.join() === served.join(),
    `missing ${declared.filter((k) => !served.includes(k)).join(',') || 'none'}; `
    + `extra ${served.filter((k) => !declared.includes(k)).join(',') || 'none'}`);
  check('every stat is a finite count, not a NULL from an empty aggregate',
    served.every((k) => Number.isFinite(a0.b.progress[k]) && a0.b.progress[k] >= 0),
    served.filter((k) => !Number.isFinite(a0.b.progress[k])).join(',') || 'all numeric');

  // Retroactivity is the whole payoff of deriving instead of counting: this run never touched
  // an achievement endpoint until now, and the history is already there.
  const pr = a0.b.progress;
  check('progress is derived from what the run actually did',
    pr.chests >= 1 && pr.puzzles >= 1 && pr.chambers >= 1 && pr.wishes >= 10
    && pr.chars >= 2 && pr.artifacts >= 5 && pr.cooked >= 1 && pr.talks >= 1,
    `chests ${pr.chests} puzzles ${pr.puzzles} chambers ${pr.chambers} wishes ${pr.wishes} `
    + `cooked ${pr.cooked} talks ${pr.talks} artifacts ${pr.artifacts}`);

  // A lifetime tally must move once per event, from the funnel every real action goes through.
  const talk = await post('/api/world/talk', { zone: 'mondstadt', npcId: 'scholar' });
  const a1 = await get('/api/achievements');
  check('a real action bumps its lifetime tally exactly once',
    talk.status === 200 && a1.b.progress.talks === pr.talks + 1,
    `talks ${pr.talks} -> ${a1.b.progress.talks}`);

  // …and the tally moves by the amount the *server* computed, not by an amount anyone asked
  // for. `/api/player/cook` clamps the batch to what the ingredients afford and reports it as
  // `cooked`; that number, and only that number, is what the tally is allowed to move by. (The
  // route that used to take a count straight out of a request body is gone — see the quest
  // section — which is why there is no forged-count case left to write here.)
  const recipe = RECIPES.sweetMadame;
  let inv = (await get('/api/player/state')).b.player.inventory;
  for (const [item, qty] of Object.entries(recipe.ingredients)) {
    for (const n of NODES.filter((x) => x.kind === item)) {
      if ((inv[item] ?? 0) >= qty * 3) break;
      const g = await post('/api/world/gather', { zone: 'mondstadt', nodeId: n.id });
      if (g.status === 200) inv = g.b.player.inventory;
    }
  }
  const batch = await post('/api/player/cook', { recipeId: 'sweetMadame', count: 3 });
  const a2 = await get('/api/achievements');
  check('a batch moves the tally by the portions the server actually cooked',
    batch.status === 200 && batch.b.cooked >= 1
    && a2.b.progress.cooked === a1.b.progress.cooked + batch.b.cooked,
    `cooked ${a1.b.progress.cooked} -> ${a2.b.progress.cooked} for a batch of ${batch.b.cooked}`);

  // Dailies are excluded from the quest count, because they roll back to active every morning
  // (`dailiesToRoll`) and a stat that can fall would un-earn an uncollected achievement. The
  // batch above is what makes this non-vacuous: 委托 d_cook wants 4 portions and the run has now
  // cooked them, so there *is* a completed quest that must not appear in the count. Without
  // that, "the number did not change" would pass on an account that had finished nothing.
  const dailyDone = ((await get('/api/quests')).b.quests || [])
    .filter((x) => x.type === 'daily' && x.state === 'done');
  check('a finished daily is not counted as a quest',
    dailyDone.length > 0 && a2.b.progress.quests === 0,
    `${dailyDone.map((x) => x.id).join(',') || 'no daily done'} vs quests ${a2.b.progress.quests}`);
  // The control that has to move. Everything above would also pass if the aggregate were
  // broken and simply always returned 0 — two dailies are done and the count is 0 either way.
  // So finish a *story* quest and watch the same number rise: q_intro's last stage is three
  // slimes, and slimes are what the mondstadt camps hold. (Whether a stale row *rolls* is
  // decided by `dailiesToRoll`, which the quest section checks against a clock it controls;
  // what is being pinned here is that the exclusion is by quest id, not by "always zero".)
  for (let i = 0; i < 3; i++) await post('/api/world/kill', { zone: 'mondstadt', enemyId: 'slimeWater' });
  const qs3 = (await get('/api/quests')).b.quests || [];
  const a3 = await get('/api/achievements');
  const doneStory = qs3.filter((x) => x.state === 'done' && !DAILY_IDS.includes(x.id));
  check('a finished story quest does raise the same count',
    doneStory.length > 0 && a3.b.progress.quests === doneStory.length
    && a3.b.progress.quests > a2.b.progress.quests,
    `quests ${a2.b.progress.quests} -> ${a3.b.progress.quests}, done non-daily `
    + `${doneStory.map((x) => x.id).join(',') || 'none'}, done daily `
    + `${qs3.filter((x) => x.state === 'done' && DAILY_IDS.includes(x.id)).length}`);

  // Claiming one achievement: priced from the server's own snapshot, paid into the column.
  const ready = ACHIEVEMENTS
    .map((a) => achState(a, a3.b.progress, a3.b.claimed[a.id] || 0))
    .filter((s) => s.claimable > 0);
  if (check('the run has earned something to collect', ready.length > 0,
    `${ready.length} of ${ACHIEVEMENTS.length}: ${ready.slice(0, 6).map((s) => s.id).join(',')}`)) {
    const one = ready[0];
    const gemsBefore = (await get('/api/player/state')).b.player.primogem;
    const got = await post('/api/achievements/claim', { id: one.id });
    check('claiming one achievement pays its tier price',
      got.status === 200 && got.b.took.length === 1 && got.b.took[0].id === one.id
      && got.b.gained.primogem === one.gems && got.b.player.primogem === gemsBefore + one.gems,
      `${one.id} tier ${one.claimed}->${one.earned} = ${got.b.gained?.primogem} gems `
      + `(want ${one.gems}), purse ${gemsBefore} -> ${got.b.player?.primogem}`);
    check('and records the tier it paid for',
      got.b.claimed[one.id] === one.earned
      && achState(ACH_BY_ID[one.id], got.b.progress, got.b.claimed[one.id]).claimable === 0,
      `claimed ${JSON.stringify(got.b.claimed[one.id])} of ${one.earned}`);

    // The guard is `WHERE tier < $3` inside the UPDATE, so the second call must pay nothing.
    const again = await post('/api/achievements/claim', { id: one.id });
    const purse = (await get('/api/player/state')).b.player.primogem;
    check('the same tier cannot be collected twice',
      again.status === 400 && again.b.error === 'nothing_to_claim'
      && purse === got.b.player.primogem,
      `status ${again.status} ${again.b.error}, purse ${got.b.player.primogem} -> ${purse}`);
  }

  // 全部领取 must pay the sum of what is left and then leave nothing behind.
  const pending = await get('/api/achievements');
  const owed = pending.b.summary.gems;
  const purseBefore = (await get('/api/player/state')).b.player.primogem;
  const all = await post('/api/achievements/claim', {});
  check('全部领取 pays exactly what the summary owed',
    all.status === 200 && all.b.gained.primogem === owed
    && all.b.player.primogem === purseBefore + owed
    && all.b.summary.claimableTiers === 0 && all.b.summary.gems === 0,
    `owed ${owed}, paid ${all.b.gained?.primogem}, left ${all.b.summary?.claimableTiers} tiers`);
  const emptyAch = await post('/api/achievements/claim', {});
  check('collecting an empty list is refused, not silently ok',
    emptyAch.status === 400 && emptyAch.b.error === 'nothing_to_claim', `status ${emptyAch.status}`);

  // An unearned threshold must not be claimable even when named directly. `hours` needs an
  // hour of playtime and this account is minutes old.
  const unearned = await post('/api/achievements/claim', { id: 'hours' });
  check('an unearned achievement cannot be claimed',
    unearned.status === 400 && unearned.b.error === 'nothing_to_claim'
    && (pending.b.progress.playHours ?? 0) < 1,
    `status ${unearned.status} ${unearned.b.error}, playHours ${pending.b.progress.playHours}`);
  const noSuch = await post('/api/achievements/claim', { id: 'not_an_achievement' });
  check('an unknown achievement id is a 404', noSuch.status === 404, `status ${noSuch.status}`);
  const badBody = await post('/api/achievements/claim', { id: 42 });
  check('achievement ids are validated', badBody.status === 400, `status ${badBody.status}`);

  // A brand-new account proves the derivation needs no events at all: two starter characters
  // and five starter artifacts already satisfy the first tier of two achievements.
  {
    const fresh = await post('/api/guest', {});
    const keep = token;
    token = fresh.b.token;
    const f0 = await get('/api/achievements');
    check('a save that predates the module still shows real progress',
      f0.status === 200 && f0.b.summary.claimableTiers >= 2
      && f0.b.progress.chars === 2 && f0.b.progress.kills === 0,
      `${f0.b.summary?.claimableTiers} claimable on a fresh account `
      + `(chars ${f0.b.progress?.chars}, artifacts ${f0.b.progress?.artifacts})`);
    token = keep;
  }

  // Pure: the tier curve. A later tier that paid the same as an earlier one would make the
  // deepest thresholds the worst value in the game.
  check('tier rewards rise with the tier',
    tierGems(0) < tierGems(1) && tierGems(1) < tierGems(2) && tierGems(3) >= tierGems(2)
    && tierGems(9) === tierGems(3),
    [0, 1, 2, 3, 9].map((i) => tierGems(i)).join(','));
  check('a partly claimed achievement prices only the tiers it owes',
    achState(ACH_BY_ID.slay, { kills: 250 }, 1).gems === tierGems(1)
    && achState(ACH_BY_ID.slay, { kills: 250 }, 0).gems === tierGems(0) + tierGems(1),
    `${achState(ACH_BY_ID.slay, { kills: 250 }, 1).gems} vs ${tierGems(1)}`);
  check('a finished achievement reports a full bar rather than an empty next tier',
    achState(ACH_BY_ID.slay, { kills: 99999 }, 4).frac === 1
    && achState(ACH_BY_ID.slay, { kills: 99999 }, 4).done === true
    && achState(ACH_BY_ID.slay, { kills: 0 }, 0).frac === 0,
    JSON.stringify(achState(ACH_BY_ID.slay, { kills: 99999 }, 4)));
}

/* ------------------------------------------------ 传说任务 / 世界任务 offers ---- */

// The extras are not hooked to an NPC's `npc.quest` story slot; they name their own `giver`, and
// whether one is on offer is decided by a single shared predicate. That matters because two
// callers ask: this route (to hand the quest over) and the client's interaction prompt (to print
// 「有新任务」). Two copies of the rule is how a prompt ends up promising a quest the route
// refuses — so the last assertion here feeds the predicate the *player document the server just
// returned* and demands it agree with what the server just did.
//
// Both directions, because the interesting failure is silent either way: a locked quest handed
// over skips its prerequisite chapter, and an unlocked one withheld is content that exists in the
// data, has stages, has rewards, has a tracker entry, and no player can ever start.
//
// Ordered after the achievements section on purpose: that one finishes `q_intro` with three
// slimes, and 花语的委托 requires it. Talking pays nothing, so nothing below inherits a moved
// adventure rank from here.
{
  const st = (await get('/api/player/state')).b.player;
  const npcOf = (id) => (MZ.npcs || []).find((n) => n.id === id);
  check('the prerequisite the rest of this section stands on is finished',
    st.quests?.q_intro?.state === 'done', `q_intro ${st.quests?.q_intro?.state || 'missing'}`);

  // 铁匠的私活 waits on q_ruins, three chapters further along, so the smith has nothing to say.
  const locked = QUESTS.sq_smith_ore;
  const refused = await post('/api/world/talk', { zone: 'mondstadt', npcId: 'smith' });
  const afterRefusal = (await get('/api/player/state')).b.player;
  check('an NPC does not hand over a 传说任务 whose prerequisite is unfinished',
    refused.status === 200 && !refused.b.started && !afterRefusal.quests?.[locked.id],
    `requires ${locked.requires} (${st.quests?.[locked.requires]?.state || 'not started'}), `
    + `started ${JSON.stringify(refused.b.started)}`);
  check('...and the prompt the player sees would say the same about that NPC',
    offerableQuest(npcOf('smith'), st) === null,
    `predicate -> ${offerableQuest(npcOf('smith'), st)?.id || 'null'}`);

  // The grocer's 花语的委托 is unlocked, above no level the guest has not reached, and untaken.
  const side = QUESTS.sq_flower_wine;
  check('the predicate offers the unlocked 传说任务 at its giver before anyone talks',
    offerableQuest(npcOf(side.giver), st)?.id === side.id,
    `AR ${st.adventureRank} vs rank ${rankForLevel(side.minLevel)} needed -> `
    + `${offerableQuest(npcOf(side.giver), st)?.id || 'null'}`);
  const got = await post('/api/world/talk', { zone: 'mondstadt', npcId: side.giver });
  check('talking to the giver starts it, typed 传说任务',
    got.status === 200 && got.b.started?.id === side.id && got.b.started?.type === 'side',
    JSON.stringify(got.b.started));
  check('and it arrives with the copy the dialogue needs, not just an id',
    !!got.b.started?.name && !!got.b.started?.intro && !!got.b.started?.chapter,
    `${got.b.started?.chapter} / ${got.b.started?.name}`);

  // Talking again must not re-mint it: `started` is the row's receipt, and a second copy would
  // reset a half-finished quest to stage 0.
  const twice = await post('/api/world/talk', { zone: 'mondstadt', npcId: side.giver });
  check('a giver with nothing left to give starts nothing', twice.status === 200 && !twice.b.started,
    `started ${JSON.stringify(twice.b.started)}`);

  const q = await get('/api/quests');
  const row = (q.b.quests || []).find((x) => x.id === side.id);
  check('the new quest is in the player\'s list exactly once, with its stages',
    (q.b.quests || []).filter((x) => x.id === side.id).length === 1
    && row?.state === 'active' && (row.stages || []).length === side.stages.length,
    `${row?.state} ${(row?.stages || []).map((s) => `${s.id}:${s.have}/${s.count}`).join(' ')}`);
  check('...typed side so the panel gives it the 传说任务 chip',
    row?.type === 'side' && EXTRA_IDS.includes(row.id), `type ${row?.type}`);

  // Stage 1 is 采集甜甜花 ×6, and it advances the same way a story quest does: through the route
  // that owns the action. No stage of an extra may need a producer the extras' own kinds lack.
  // Earlier sections have already picked some of the flowers for the cooking tests, and a picked
  // node is a 409 for six hours — so walk from the far end until one is still standing rather
  // than asserting against whichever node happens to be first in the list.
  let g = { status: 0, b: {} }, pick = null;
  for (const n of [...NODES.filter((x) => x.kind === 'sweetFlower')].reverse()) {
    pick = n;
    g = await post('/api/world/gather', { zone: 'mondstadt', nodeId: n.id });
    if (g.status === 200) break;
  }
  const upd = (g.b.questUpdates || []).find((u) => u.questId === side.id);
  check('gathering advances the 传说任务 through the validating route',
    g.status === 200 && !!upd, `${pick?.id} -> ${JSON.stringify(g.b.questUpdates || []).slice(0, 120)}`);
  const q2 = await get('/api/quests');
  const row2 = (q2.b.quests || []).find((x) => x.id === side.id);
  check('...and the counter the HUD reads moved with it',
    (row2?.stages?.[0]?.have ?? 0) > (row?.stages?.[0]?.have ?? 0),
    `${row?.stages?.[0]?.have} -> ${row2?.stages?.[0]?.have} / ${row2?.stages?.[0]?.count}`);

  // The agreement assertion: same player document, same npc, one rule. If the prompt and the
  // route ever drift, this is the line that goes red — and it is fed the live document rather
  // than a hand-built one so it cannot agree with a fiction.
  const live = (await get('/api/player/state')).b.player;
  check('the shared predicate and the route agree on every giver in 蒙德',
    (MZ.npcs || []).every((n) => {
      const off = offerableQuest(n, live);
      return !off || !live.quests?.[off.id];
    }),
    (MZ.npcs || []).map((n) => `${n.id}:${offerableQuest(n, live)?.id || '-'}`).join(' '));
}

/* --------------------------------------------------- dungeon reward chest ---- */

// `requires: 'clear'` on the three dungeon reward chests was authored, looked enforced, and
// was not: the route understood `puzzle:` and nothing else, so a luxurious chest — ~12 000
// mora, 10 primogems, four loot rolls and a guaranteed artifact — sat behind an open door in
// every dungeon. This section is the receipt that the lock exists in both directions: refused
// with the dungeon unfinished, granted once every floor is cleared.
//
// Ordered last of the guest's sections on purpose: clearing the remaining floors pays
// adventure rank, and nothing above this point should have its rank assumptions moved.
{
  const dz = Object.values(ZONES).find((zz) => (zz.poi || []).some((x) => x.requires === 'clear'));
  const chest = dz.poi.find((x) => x.requires === 'clear');
  const floors = (dz.chambers || []).map((c) => c.floor);
  const before = (await get('/api/player/state')).b.player;
  const cleared = floors.filter((f) => (before.abyss?.[dz.id]?.[f]?.stars ?? 0) > 0);
  check('the dungeon reward chest is a luxurious chest behind every floor',
    chest.tier === 'luxurious' && floors.length >= 3,
    `${dz.id}/${chest.id} over ${floors.length} floors`);
  check('and the guest has cleared some but not all of them',
    cleared.length > 0 && cleared.length < floors.length,
    `cleared ${cleared.join(',')} of ${floors.join(',')}`);

  const locked = await post('/api/world/chest', { zone: dz.id, poiId: chest.id });
  check('an unfinished dungeon locks its reward chest',
    locked.status === 403 && locked.b.error === 'locked' && locked.b.requires === 'clear'
    && (locked.b.floors || []).length === floors.length - cleared.length,
    `status ${locked.status} ${locked.b.error} floors left ${JSON.stringify(locked.b.floors)}`);
  const mid = (await get('/api/player/state')).b.player;
  check('and the refusal paid nothing at all',
    mid.mora === before.mora && mid.primogem === before.primogem
    && !mid.worldProgress?.[dz.id]?.[chest.id],
    `${before.mora}/${before.primogem} -> ${mid.mora}/${mid.primogem}`);

  for (const f of floors) {
    if ((mid.abyss?.[dz.id]?.[f]?.stars ?? 0) > 0) continue;
    await post('/api/world/chamber', { zone: dz.id, floor: f, time: 1 });
  }
  const done = (await get('/api/player/state')).b.player;
  const stars = floors.map((f) => done.abyss?.[dz.id]?.[f]?.stars ?? 0);
  check('every floor can be cleared', stars.every((s) => s > 0), `stars ${stars.join('/')}`);
  const opened = await post('/api/world/chest', { zone: dz.id, poiId: chest.id });
  check('a cleared dungeon opens it, and it pays like a luxurious chest',
    opened.status === 200 && opened.b.loot?.primogem === CHEST_TIERS.luxurious.primogem
    && opened.b.loot?.mora >= CHEST_TIERS.luxurious.mora[0]
    && (opened.b.loot?.artifacts?.length ?? 0) > 0,
    `status ${opened.status} +${opened.b.loot?.mora} mora +${opened.b.loot?.primogem} primogems `
    + `${opened.b.loot?.artifacts?.length} artifacts`);
  const twice = await post('/api/world/chest', { zone: dz.id, poiId: chest.id });
  check('and it is still a one-shot chest', twice.status === 409 && twice.b.error === 'already_opened',
    `status ${twice.status} ${twice.b.error}`);
}

/* ------------------------------------------------------------ 探索派遣 -------- */

// The idle half of the game: send a character out, come back hours later, collect materials.
// Three things are worth asserting and nothing else is interesting:
//
//  1. **The data is derived.** `validateExpeditions()` is the gate — every kind a destination
//     pays has to grow in that zone, the themes must not overlap, the payout must be linear and
//     monotone in hours, and the shortest trip must pay *something*.
//  2. **Every refusal is reachable, and the route agrees with the shared rule.** The panel dims
//     rows by calling `expeditionEntry` itself, so a code the route answers with that the rule
//     does not produce (or the reverse) is a lock the player cannot see. Each of the six codes is
//     provoked here.
//  3. **The claim pays exactly once, and pays the authored basket.** The reward is not stored on
//     the row — it is recomputed from `(destId, hours)` — so the test is that the granted items
//     equal `expeditionPayout` item for item, and that a second 领取 gets nothing.
{
  const mainToken = token;
  const g = await post('/api/guest', {});
  token = g.b.token;

  const problems = validateExpeditions();
  check('the destination table is derived from the zones it names', problems.length === 0,
    problems.slice(0, 4).join(' | ') || `${Object.keys(EXPEDITIONS).length} destinations`);

  const anon = await (async () => { const t = token; token = ''; const r = await get('/api/expeditions'); token = t; return r; })();
  check('the 派遣 list needs a token', anon.status === 401, `status ${anon.status}`);

  const snap = await get('/api/expeditions');
  const p = (await get('/api/player/state')).b.player;
  const owned = Object.keys(p.characters);
  const open = expeditionsFor(p.adventureRank);
  check('a fresh account sees an empty slate and only the destinations it may reach',
    snap.status === 200 && snap.b.entries?.length === 0
    && snap.b.slots === expeditionSlots(p.adventureRank, owned.length)
    && snap.b.destinations?.length === open.length
    && snap.b.destinations.every((d) => open.some((o) => o.id === d.id)),
    `AR ${p.adventureRank}, ${owned.length} characters → ${snap.b.slots} slots, `
    + `${snap.b.destinations?.length}/${Object.keys(EXPEDITIONS).length} destinations`);
  // The catalogue is what the panel prices its rows from, so it has to carry the payout of every
  // duration — a row that says 「4 小时」 and cannot say what that brings back is a blind choice.
  const first = snap.b.destinations[0];
  check('...and each one is priced at every duration it offers',
    snap.b.hours?.length === EXPEDITION_HOURS.length
    && EXPEDITION_HOURS.every((hv) => JSON.stringify(first.payouts[hv])
      === JSON.stringify(expeditionPayout(first.id, hv))),
    `${first.id}: ${EXPEDITION_HOURS.map((hv) => `${hv}h=${JSON.stringify(first.payouts[hv])}`).join(' ')}`);

  // The clock the server answers with. A snapshot without it would force the panel to trust the
  // browser's, which is how a card counts down to 可领取 and is then refused.
  check('the snapshot carries the server clock',
    Math.abs((snap.b.now || 0) - Date.now()) < 60_000, `now ${snap.b.now} vs ${Date.now()}`);

  const dest = open[0];
  const gatedDest = Object.values(EXPEDITIONS)
    .filter((d) => d.entryRank > (p.adventureRank || 1))
    .sort((a, b) => a.entryRank - b.entryRank)[0];
  const hours = EXPEDITION_HOURS[0];

  // Every refusal, in the order `expeditionEntry` checks them, and each one paired with the code
  // the shared rule produces for the same question. Two implementations of one rule is the defect
  // this pairing exists to catch — see the 秘境 floor lock in README.
  const ctx = { adventureRank: p.adventureRank, owned, rows: [] };
  const refusals = [
    ['no_such_expedition', 404, { destId: 'nowhere_at_all', charId: owned[0], hours }],
    ['bad_hours', 400, { destId: dest.id, charId: owned[0], hours: 5 }],
    ...(gatedDest ? [['rank_too_low', 403, { destId: gatedDest.id, charId: owned[0], hours }]] : []),
    ['character_not_owned', 403, { destId: dest.id, charId: 'nobody', hours }],
  ];
  for (const [code, status, body] of refusals) {
    const r = await post('/api/expedition/start', body);
    const rule = expeditionEntry(body.destId, body.charId, body.hours, ctx);
    check(`a dispatch is refused with ${code}, and the shared rule says the same`,
      r.status === status && r.b.error === code && rule.ok === false && rule.error === code,
      `route ${r.status} ${r.b.error} · rule ${rule.error}${rule.need ? ` (need ${rule.need})` : ''}`);
  }
  // `need` is what the panel prints in 「需要 N 阶」, so it has to survive the wire.
  if (gatedDest) {
    const r = await post('/api/expedition/start', { destId: gatedDest.id, charId: owned[0], hours });
    check('...and a rank refusal says which rank', r.b.need === gatedDest.entryRank,
      `${gatedDest.id} needs ${r.b.need}, table says ${gatedDest.entryRank}`);
  }

  const sent = await post('/api/expedition/start', { destId: dest.id, charId: owned[0], hours });
  check('a dispatch takes the lowest free slot and prices itself from the table',
    sent.status === 200 && sent.b.started?.slot === 0 && sent.b.started?.charId === owned[0]
    && JSON.stringify(sent.b.started?.payout) === JSON.stringify(expeditionPayout(dest.id, hours))
    && sent.b.started?.ready === false && sent.b.started?.remainSec === hours * 3600,
    `slot ${sent.b.started?.slot} ${JSON.stringify(sent.b.started?.payout)} `
    + `remain ${sent.b.started?.remainSec}s`);

  const busy = await post('/api/expedition/start', { destId: dest.id, charId: owned[0], hours });
  check('the same character cannot be sent twice',
    busy.status === 403 && busy.b.error === 'character_busy',
    `status ${busy.status} ${busy.b.error}`);

  // Fill the slate to provoke `no_free_slot`. A fresh account owns exactly as many characters as
  // it has slots, which is the point of `expeditionSlots` taking both — so this also proves the
  // cap is the *character* count here and not a number invented per rank.
  const rest = owned.slice(1);
  for (const id of rest) await post('/api/expedition/start', { destId: dest.id, charId: id, hours });
  const full = (await get('/api/expeditions')).b;
  check('the slate fills to the slot cap and no further',
    full.entries.length === full.slots && full.slots === owned.length,
    `${full.entries.length}/${full.slots} in flight, ${owned.length} characters owned`);

  // A third character would need a third slot; the account has neither, so this is the honest
  // refusal for both. `character_not_owned` comes first in the rule's order, which is why the
  // check for `no_free_slot` has to be made with a character that *is* owned — and every owned
  // one is already out, so the rule reports `character_busy` and the slate is proven full by the
  // count above instead. Assert the rule's own answer for a hypothetical extra character.
  const ruleFull = expeditionEntry(dest.id, 'extra_char', hours,
    { adventureRank: p.adventureRank, owned: [...owned, 'extra_char'], rows: full.entries });
  check('...and one more character than there are slots is refused with no_free_slot',
    ruleFull.ok === false && ruleFull.error === 'no_free_slot' && ruleFull.slots === full.slots,
    `${full.entries.length} rows against ${ruleFull.slots} slots → ${ruleFull.error}`);

  const early = await post('/api/expedition/claim', { slot: 0 });
  check('an unfinished trip cannot be claimed',
    early.status === 409 && early.b.error === 'not_finished',
    `status ${early.status} ${early.b.error}`);

  // The rewind hook is what makes the *other* half testable at all — the shortest trip is four
  // hours. It shifts `started_at`, the table's only clock, and can mint nothing on its own.
  const badRewind = await post('/api/dev/expedition-rewind', { seconds: 0 });
  check('the rewind hook validates its input', badRewind.status === 400, `status ${badRewind.status}`);
  const moved = await post('/api/dev/expedition-rewind', { seconds: hours * 3600 });
  check('...and moves every row of this account back',
    moved.status === 200 && moved.b.moved === full.entries.length,
    `${moved.b.moved} rows by ${moved.b.seconds}s`);

  const ready = (await get('/api/expeditions')).b;
  check('the trips now read as finished',
    ready.entries.every((e) => e.ready === true && e.remainSec === 0),
    ready.entries.map((e) => `${e.charId}:${e.ready}/${e.remainSec}`).join(' '));

  const bag0 = (await get('/api/player/state')).b.player.inventory;
  const want = {};
  for (const e of ready.entries) {
    for (const [k, v] of Object.entries(expeditionPayout(e.destId, e.hours))) want[k] = (want[k] || 0) + v;
  }
  const took = await post('/api/expedition/claim', {});
  check('一键领取 pays every finished trip exactly its authored basket',
    took.status === 200 && took.b.took?.length === ready.entries.length
    && JSON.stringify(took.b.items) === JSON.stringify(want),
    `${took.b.took?.length} trips: ${JSON.stringify(took.b.items)} vs ${JSON.stringify(want)}`);
  check('...and the items are in the bag',
    Object.entries(want).every(([k, v]) => (took.b.player?.inventory?.[k] || 0) === (bag0[k] || 0) + v),
    Object.keys(want).map((k) => `${k} ${bag0[k] || 0}→${took.b.player?.inventory?.[k]}`).join(' '));
  check('...and the slate is empty again',
    took.b.entries?.length === 0 && took.b.slots === full.slots,
    `${took.b.entries?.length}/${took.b.slots}`);

  const twice = await post('/api/expedition/claim', {});
  check('a second 领取 pays nothing',
    twice.status === 400 && twice.b.error === 'nothing_to_claim',
    `status ${twice.status} ${twice.b.error}`);

  // The atomic claim, from both ends at once: the DELETE is the arbiter, so two simultaneous
  // 领取 must split the rows rather than both pay for them. Anything else is an item duplicator.
  const race = await post('/api/expedition/start', { destId: dest.id, charId: owned[0], hours });
  await post('/api/dev/expedition-rewind', { seconds: hours * 3600 });
  const bagR = (await get('/api/player/state')).b.player.inventory;
  const [a, b2] = await Promise.all([
    post('/api/expedition/claim', {}),
    post('/api/expedition/claim', {}),
  ]);
  const paidRows = (a.b.took?.length || 0) + (b2.b.took?.length || 0);
  const one = expeditionPayout(dest.id, hours);
  const bagAfter = (await get('/api/player/state')).b.player.inventory;
  check('two simultaneous claims pay one trip once',
    paidRows === 1 && Object.entries(one).every(([k, v]) => (bagAfter[k] || 0) === (bagR[k] || 0) + v),
    `${a.status}/${b2.status} → ${paidRows} row(s) paid, `
    + Object.keys(one).map((k) => `${k} ${bagR[k] || 0}→${bagAfter[k]}`).join(' '));
  check('...and the loser is told why, not handed an empty success',
    [a, b2].some((r) => r.status === 400 && r.b.error === 'nothing_to_claim'),
    `${a.status} ${a.b.error || 'ok'} / ${b2.status} ${b2.b.error || 'ok'}`);
  if (race.status !== 200) check('the race could be set up', false, JSON.stringify(race.b));

  // Linearity, on the wire rather than in the table: two 4-hour trips must be worth the same as
  // one 8-hour trip, up to the single item the running-total rounding can move. This is what
  // makes the long durations a convenience instead of a strategy.
  const short = expeditionTotal(dest, 4) * 2;
  const long = expeditionTotal(dest, 8);
  check('time is linear, so no duration is the clever one', Math.abs(short - long) <= 1,
    `2×4h = ${short} items, 8h = ${long}`);
  // And no currency: an idle income that printed mora or 原石 would be an unaudited faucet.
  const currencies = new Set(['mora', 'primogem', 'wishTicket', 'resin']);
  const paysCurrency = Object.values(EXPEDITIONS)
    .flatMap((d) => EXPEDITION_HOURS.flatMap((hv) => Object.keys(expeditionPayout(d, hv))))
    .filter((k) => currencies.has(k));
  check('...and 派遣 pays materials only, never currency', paysCurrency.length === 0,
    paysCurrency.join(' ') || `${Object.keys(EXPEDITIONS).length} destinations checked`);

  token = mainToken;
}

/* ------------------------------------------------------------- dev hooks ----- */

// `POST /api/dev/rank` exists for one reason: the screenshot probes cannot reach four of the
// six zones on a fresh guest, so 「细腻画面」 had no current evidence for 龙脊雪山, 冰封洞窟, 璃月 or
// 黄金屋. A test hook is exactly the sort of route this repo has twice found rotting — written,
// never called, or called and never guarded — so it is asserted from both ends: it must move
// the rank *and* unlock the zone that was refused a moment earlier, it must refuse anonymous
// callers and nonsense input, and `index.js` must still register it only under `config.isDev`.
{
  const mainToken = token;
  const g = await post('/api/guest', {});
  token = g.b.token;

  const gated = Object.values(ZONES)
    .filter((z) => (z.entryRank || 1) > 1)
    .sort((a, b) => (a.entryRank || 1) - (b.entryRank || 1))[0];
  const need = gated?.entryRank || 4;

  const before = await post('/api/world/teleport', { zone: gated.id });
  check('the gated zone is refused before the hook runs',
    before.status === 403 && before.b.error === 'rank_too_low' && before.b.need === need,
    `${gated.id} needs AR ${need}: status ${before.status} ${before.b.error || ''}`);

  const anon = await (async () => { const t = token; token = ''; const r = await post('/api/dev/rank', { rank: need }); token = t; return r; })();
  check('the rank hook needs a token', anon.status === 401, `status ${anon.status}`);

  const junk = await post('/api/dev/rank', { rank: 0 });
  const huge = await post('/api/dev/rank', { rank: 9999 });
  const none = await post('/api/dev/rank', {});
  check('the rank hook validates its input',
    junk.status === 400 && huge.status === 400 && none.status === 400,
    `0 → ${junk.status}, 9999 → ${huge.status}, {} → ${none.status}`);

  const st0 = (await get('/api/player/state')).b.player;
  const up = await post('/api/dev/rank', { rank: need });
  // Rank has to come out of the real curve, not an UPDATE: `world_level` is derived from it and
  // `arCap(rank)` caps every character and weapon level, so a rank with no xp behind it produces
  // a save no honest playthrough could reach.
  check('the hook moves the rank forward through the xp curve',
    up.status === 200 && up.b.moved === true && up.b.rank === need
    && up.b.player.adventureXp > st0.adventureXp
    && up.b.player.worldLevel === Math.min(8, Math.floor((need - 1) / 5)),
    `AR ${st0.adventureRank} → ${up.b.rank}, xp ${st0.adventureXp} → ${up.b.player?.adventureXp}, `
    + `wl ${up.b.player?.worldLevel}, +${up.b.granted} xp`);

  const after = await post('/api/world/teleport', { zone: gated.id });
  check('...and the same warp that was refused now lands',
    after.status === 200 && after.b.zone === gated.id && after.b.player?.zone === gated.id,
    `${gated.id}: status ${after.status} → zone ${after.b.zone}, save ${after.b.player?.zone}`);

  const back = await post('/api/dev/rank', { rank: 1 });
  check('the hook never rolls a rank backwards',
    back.status === 200 && back.b.moved === false && back.b.rank === need,
    `asked for AR 1 at AR ${need} → ${back.b.rank} (moved ${back.b.moved})`);

  // The second hook, `POST /api/dev/supply`, exists for the other probe: `mp-check` could only
  // ever *lose* a 秘境 in co-op, because two level-1 guests cannot beat a level-18 floor, so the
  // loop that pays every player in a cleared instance had no test at all. It grants materials
  // and mora only — the probe then buys the levels through `/api/char/levelup`,
  // `/api/char/ascend` and `/api/inventory/weapon/levelup`, so a broken growth route stays
  // visible instead of being papered over by a hook that writes `level = 40`.
  const anonS = await (async () => { const t = token; token = ''; const r = await post('/api/dev/supply', { level: 40 }); token = t; return r; })();
  check('the supply hook needs a token', anonS.status === 401, `status ${anonS.status}`);
  const lowS = await post('/api/dev/supply', { level: 1 });
  const bigS = await post('/api/dev/supply', { level: 91 });
  const noneS = await post('/api/dev/supply', {});
  check('the supply hook validates its input',
    lowS.status === 400 && bigS.status === 400 && noneS.status === 400,
    `1 → ${lowS.status}, 91 → ${bigS.status}, {} → ${noneS.status}`);

  const bag0 = (await get('/api/player/state')).b.player;
  const sup = await post('/api/dev/supply', { level: 90 });
  const granted = sup.b.granted || {};
  // Billed against the same ceiling the growth routes enforce: `arCap(AR)` refuses levels the
  // supply would otherwise be buying books for, which would leave the probe unable to spend
  // what it was handed and its own level assertion unmeetable for a reason that is not a bug.
  check('the supply hook bills against arCap, not what was asked',
    sup.status === 200 && sup.b.asked === 90 && sup.b.level === arCap(need)
    && (granted.heroWit || 0) > 0 && (granted.mora || 0) > 0,
    `asked 90 at AR ${need} → level ${sup.b.level} (cap ${arCap(need)}): ${JSON.stringify(granted)}`);
  check('...and what it granted is in the bag',
    sup.b.inventory?.heroWit === (bag0.inventory.heroWit || 0) + granted.heroWit
    && sup.b.player?.mora === bag0.mora + granted.mora,
    `heroWit ${bag0.inventory.heroWit} → ${sup.b.inventory?.heroWit}, mora ${bag0.mora} → ${sup.b.player?.mora}`);

  // And the rule that supply exposed. `levelUpCharacter` used to hand its whole `materials`
  // bag to the xp curve and clamp the *result* at the cap, so every book above the ceiling was
  // incinerated: the panel's button offers `min(have, 20)` heroWit, one click on a level-1
  // character burnt ~19 of them (380 000 xp) and left the rest of the party nothing to level
  // with. Three rules, the same three the weapon path already had — stop at the cap, spend the
  // cheapest fodder first, leave what could not be absorbed in the bag.
  const chars = Object.keys(bag0.characters);
  const bank = { ...sup.b.inventory };
  const lv1 = await post('/api/char/levelup', {
    charId: chars[0], materials: { heroWit: 9999, adventurerXp: 9999 },
  });
  let room = 0;
  for (let l = 1; l < (lv1.b.cap || 1); l++) room += xpForLevel(l);
  const cheap = Math.min(bank.adventurerXp || 0, Math.ceil(room / MATERIALS.adventurerXp.xp));
  const books = Math.ceil((room - cheap * MATERIALS.adventurerXp.xp) / MATERIALS.heroWit.xp);
  check('a level-up stops at the cap and spends the cheapest fodder first',
    lv1.status === 200 && lv1.b.level === lv1.b.cap
    && lv1.b.consumed?.adventurerXp === -cheap && lv1.b.consumed?.heroWit === -books,
    `level ${lv1.b.level}/cap ${lv1.b.cap}, room ${room} xp: spent ${JSON.stringify(lv1.b.consumed)}`
    + ` vs adventurerXp ${cheap} + heroWit ${books}`);
  check('...so the books it could not absorb are still in the bag',
    lv1.b.player?.inventory?.heroWit === (bank.heroWit || 0) - books
    && lv1.b.player?.inventory?.heroWit > 0,
    `${bank.heroWit} - ${books} → ${lv1.b.player?.inventory?.heroWit}`);
  const lv2 = await post('/api/char/levelup', { charId: chars[1], materials: { heroWit: 9999 } });
  check('...and the second character can still be levelled out of what is left',
    lv2.status === 200 && lv2.b.level === lv2.b.cap,
    `${chars[1]} → ${lv2.b.level}/cap ${lv2.b.cap} (${lv2.b.error || 'ok'}),`
    + ` ${lv2.b.player?.inventory?.heroWit} heroWit left`);

  const h = await get('/api/health');
  check('health advertises that the hooks are on', h.b.devHooks === true, `devHooks ${h.b.devHooks}`);

  // The guard itself, read off disk: a hook that is registered unconditionally would pass every
  // assertion above and ship a rank cheat to production.
  const idx = readFileSync(new URL('../server/src/index.js', import.meta.url), 'utf8');
  const guarded = /if\s*\(config\.isDev\)\s*\{[\s\S]{0,200}?register\(devRoutes\)/.test(idx);
  check('and index.js only registers them when config.isDev', guarded,
    guarded ? 'guarded' : 'devRoutes is registered outside the isDev branch');

  token = mainToken;
}

/* ------------------------------------------------------------ persistence ---- */

// Everything above ran through the Redis-backed player cache. `/api/player/state` asks for
// a `fresh` read, so it is already reading through to Postgres — but only inside one
// session. The stronger statement is that a *different* session on the same account sees
// the same save, which needs a real username and password, since `/api/guest` mints a new
// account on every call and a guest's password is random by design.
{
  const suffix = Math.random().toString(36).slice(2, 8);
  const creds = { username: `apicheck_${suffix}`, password: 'check-pass-1', nickname: `检查${suffix.slice(0, 2)}` };
  const reg = await post('/api/register', creds);
  if (check('register a real account', reg.status === 200 && !!reg.b.token, `player ${reg.b.playerId}`)) {
    token = reg.b.token;
    const chest = ZONES.mondstadt.poi.filter((x) => x.type === 'chest')[1]
      ?? ZONES.mondstadt.poi.find((x) => x.type === 'chest');
    const opened = await post('/api/world/chest', { zone: 'mondstadt', poiId: chest.id });
    const mora = opened.b.player?.mora ?? 0;
    check('new account can play', opened.status === 200 && mora > 20000, `mora ${mora}`);

    token = '';
    const again = await post('/api/login', { username: creds.username, password: creds.password });
    check('login with the same credentials', again.status === 200 && !!again.b.token,
      `status ${again.status}`);
    token = again.b.token;
    const st2 = await get('/api/player/state');
    check('progress survives a new session', st2.b.player?.mora === mora,
      `${mora} -> ${st2.b.player?.mora}`);
    check('and the chest stays open',
      st2.b.player?.worldProgress?.mondstadt?.[chest.id]?.opened === true,
      `${chest.id} ${JSON.stringify(st2.b.player?.worldProgress?.mondstadt?.[chest.id])}`);
    const wrong = await post('/api/login', { username: creds.username, password: 'not-the-password' });
    check('a wrong password is refused', wrong.status === 401, `status ${wrong.status}`);
  }
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails);
