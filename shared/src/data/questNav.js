// Where a quest objective *is*.
//
// The tracker has always printed the objective ('击败 5 只霜狼', '前往七天神像') and nothing
// else. In a 380 m zone with 5 camps, 2 waypoints and no labels on anything, that sentence is
// not an instruction — it is a riddle. Every one of the ten story quests could be read and
// still not be findable, so the chain stalled on knowledge the game never gave: the player had
// to already know where frost wolves spawn.
//
// The fix is not a hand-written table of coordinates. Every stage target is *already* an id in
// the world data — an npc id, a poi id, a chest tier, an enemy id, an item some enemy drops —
// so a position is a query, the same way an achievement is a query on tables the database
// already has. One resolver per stage kind, declared in `STAGE_LOCATORS`, gated **both ways**
// against `QUEST_EVENT_SOURCES`: a stage kind with no locator is an objective the player cannot
// be pointed at, and a locator no stage uses is dead code that looks load-bearing.
//
// The two things this module deliberately does not do:
//
//   * It does not invent a place for objectives that have none. `cook` happens in a panel, so
//     the answer is `kind: 'panel'` and the *client* turns that into 「按 L 打开料理」 from
//     `KEYMAP` — the keymap lives in the client and copying it here would let the two drift.
//   * It does not read the keyboard, the renderer or the DOM, so `tools/questnav-check.mjs`
//     can walk all ten story quests, stage by stage, in Node.
//
// Live progress is optional: pass `pois`/`gathers` from `game.world` and an opened chest reads
// as opened (the next stage points at the *next* one); pass nothing and the static zone
// definition answers, which is what the full-screen map does for a zone the player is not in.

import { ZONES, ZONE_IDS, gatherNodes, heightAt, chamberEnemies } from './zones.js';
import { defaultAnchor } from './anchors.js';
import { ENEMIES } from './enemies.js';
import { itemName } from './items.js';
import { QUESTS, QUEST_EVENT_SOURCES } from './quests.js';

/** How each stage kind is located, and out of what. Documentation *and* the gate's vocabulary. */
export const STAGE_LOCATORS = Object.freeze({
  talk:      { what: 'NPC 本人', from: 'zone.npcs[].id' },
  reach:     { what: '目标 POI', from: 'zone.poi[].id' },
  puzzle:    { what: '谜题 POI', from: "zone.poi[].id (type 'puzzle')" },
  chest:     { what: '同档位且没开过的最近一口宝箱', from: "zone.poi[] (type 'chest', poi.tier)" },
  warmth:    { what: '最近的取暖点', from: "zone.poi[] (type 'warmth')" },
  kill:      { what: '最近的、刷这种怪的营地；只在秘境里出现的怪指那一间', from: 'zone.spawns[].enemies · zone.chambers[].waves' },
  collect:   { what: '掉这件东西的怪的营地，或长这件东西的采集点', from: 'ENEMIES[].loot · zone.gathers[]' },
  gather:    { what: '最近的、还没被采走的采集点', from: 'gatherNodes(zone)' },
  enterZone: { what: '那个区域（在本区域内就指它的入口）', from: "ZONES · zone.poi[] (type 'dungeon')" },
  chamber:   { what: '秘境入口，进去之后是秘境中心', from: "zone.poi[] (type 'dungeon', poi.target)" },
  cook:      { what: '没有地点：料理是个面板', panel: 'cook' },
});

/* --------------------------------------------------------------------- helpers -- */

/** The POI list to answer from: live entries when we have them, the zone definition otherwise. */
function poisOf(zoneId, ctx) {
  if (ctx.zoneId === zoneId && ctx.pois) return ctx.pois;
  const z = ZONES[zoneId];
  return (z?.poi || []).map((p) => ({
    id: p.id, type: p.type, x: p.at[0], z: p.at[1], name: p.name || null, done: false, poi: p,
  }));
}

/** A chest entry's tier, whichever shape it arrived in. */
function tierOf(entry) { return entry.tier ?? entry.poi?.tier ?? null; }

function dist2(a, x, z) {
  if (!a) return 0;
  return (a.x - x) ** 2 + (a.z - z) ** 2;
}

/**
 * The closest of several candidates. Distance is only meaningful inside the zone the player is
 * standing in; for any other zone the first candidate is as good as any, and pretending
 * otherwise would rank places by their distance from a point in a different coordinate space.
 */
function nearest(list, zoneId, ctx) {
  if (!list.length) return null;
  if (ctx.zoneId !== zoneId || !ctx.pos) return list[0];
  let best = list[0], bd = dist2(list[0], ctx.pos.x, ctx.pos.z);
  for (let i = 1; i < list.length; i++) {
    const d = dist2(list[i], ctx.pos.x, ctx.pos.z);
    if (d < bd) { bd = d; best = list[i]; }
  }
  return best;
}

/** Zones to search, the quest's own zone first, then the one the player is in, then the rest. */
function searchOrder(def, ctx) {
  const order = [];
  for (const id of [def?.zone, ctx.zoneId]) if (id && ZONES[id] && !order.includes(id)) order.push(id);
  for (const id of ZONE_IDS) if (!order.includes(id)) order.push(id);
  return order;
}

function place(zoneId, x, z, name, extra = {}) {
  const zone = ZONES[zoneId];
  return {
    kind: 'place', zone: zoneId, zoneName: zone?.name || zoneId,
    x, z, y: zone ? heightAt(zone, x, z) : 0, name, ...extra,
  };
}

/** The `dungeon` POI that leads into `destId`, wherever it is. */
function gateTo(destId) {
  for (const id of ZONE_IDS) {
    for (const p of ZONES[id]?.poi || []) {
      if (p.type === 'dungeon' && p.target === destId) return { zoneId: id, poi: p };
    }
  }
  return null;
}

/** A zone-level answer: the objective is somewhere else entirely. */
function elsewhere(destId) {
  const dest = ZONES[destId];
  const gate = dest?.kind === 'dungeon' ? gateTo(destId) : null;
  return {
    kind: 'zone', zone: destId, zoneName: dest?.name || destId, name: dest?.name || destId,
    via: gate ? gate.zoneId : null,
    hint: gate
      ? `从${ZONES[gate.zoneId]?.name || gate.zoneId}的${gate.poi.name || '入口'}进入`
      : '打开地图传送',
  };
}

/**
 * Turn a destination in some zone into an answer the UI can draw.
 *
 * Three cases, and the middle one is the reason this function exists: the objective is in
 * another zone, but *this* zone holds the door to it, so the arrow should point at the door
 * rather than shrugging. That is the whole of how a player finds 深渊试炼场 the first time.
 */
function resolve(destZoneId, point, ctx) {
  if (!destZoneId || !ZONES[destZoneId]) return null;
  if (destZoneId === ctx.zoneId && point) return point;
  const gate = ZONES[destZoneId].kind === 'dungeon' ? gateTo(destZoneId) : null;
  if (gate && gate.zoneId === ctx.zoneId) {
    const live = poisOf(gate.zoneId, ctx).find((p) => p.id === gate.poi.id);
    const name = `${ZONES[destZoneId].name}入口`;
    return live
      ? place(gate.zoneId, live.x, live.z, name, { poiId: live.id, gate: destZoneId })
      : place(gate.zoneId, gate.poi.at[0], gate.poi.at[1], name, { poiId: gate.poi.id, gate: destZoneId });
  }
  return elsewhere(destZoneId);
}

/* ------------------------------------------------------------------- resolvers -- */

function findNpc(npcId, def, ctx) {
  for (const zoneId of searchOrder(def, ctx)) {
    const npc = (ZONES[zoneId].npcs || []).find((n) => n.id === npcId);
    if (npc) return resolve(zoneId, place(zoneId, npc.at[0], npc.at[1], npc.name || npcId, { npcId }), ctx);
  }
  return null;
}

function findPoi(poiId, def, ctx, wantType = null) {
  for (const zoneId of searchOrder(def, ctx)) {
    const hit = poisOf(zoneId, ctx).find((p) => p.id === poiId && (!wantType || p.type === wantType));
    if (!hit) continue;
    const nm = hit.name || ZONES[zoneId].poi?.find((p) => p.id === poiId)?.name || poiId;
    return resolve(zoneId, place(zoneId, hit.x, hit.z, nm, { poiId }), ctx);
  }
  return null;
}

/** Chests of a tier ('any' for all), unopened first — an opened chest is not a destination. */
function findChest(tier, def, ctx) {
  for (const zoneId of searchOrder(def, ctx)) {
    const all = poisOf(zoneId, ctx).filter(
      (p) => p.type === 'chest' && (tier === 'any' || tierOf(p) === tier),
    );
    const open = all.filter((p) => !p.done);
    const pick = nearest(open.length ? open : [], zoneId, ctx);
    if (!pick) continue;
    const nm = CHEST_NAME[tierOf(pick)] || '宝箱';
    return resolve(zoneId, place(zoneId, pick.x, pick.z, nm, { poiId: pick.id }), ctx);
  }
  return null;
}

const CHEST_NAME = { common: '普通的宝箱', exquisite: '精致的宝箱', precious: '珍贵的宝箱', luxurious: '华丽的宝箱' };

function findWarmth(def, ctx) {
  for (const zoneId of searchOrder(def, ctx)) {
    const list = poisOf(zoneId, ctx).filter((p) => p.type === 'warmth');
    const pick = nearest(list, zoneId, ctx);
    if (pick) return resolve(zoneId, place(zoneId, pick.x, pick.z, pick.name || '篝火', { poiId: pick.id }), ctx);
  }
  return null;
}

/**
 * Some enemies never stand in the open world. 暴风之主 (`stormTyrant`) exists only in the last
 * chamber of 黄金屋遗迹, so 「击败暴风之主」 has no camp to point at — and the gate caught exactly
 * that: the final story quest's second stage resolved to nothing, which on screen is a tracker
 * with no arrow at the end of the whole chain. A chamber-only enemy's place is the floor it
 * fights on.
 */
function findChamberEnemy(ids, def, ctx) {
  for (const zoneId of searchOrder(def, ctx)) {
    for (const c of ZONES[zoneId].chambers || []) {
      const hit = chamberEnemies(c).map((e) => e.id || e).find((e) => ids === 'any' || ids.includes(e));
      if (!hit) continue;
      const floor = c.floor ?? 1;
      const nm = `${ENEMIES[hit]?.name || '敌人'}（第 ${floor} 间）`;
      if (zoneId === ctx.zoneId) {
        return { kind: 'here', zone: zoneId, zoneName: ZONES[zoneId].name, name: nm, floor,
                 hint: `在秘境内开始第 ${floor} 间`, enemyId: hit };
      }
      const r = resolve(zoneId, null, ctx);
      if (r) { r.floor = floor; r.name = nm; r.enemyId = hit; }
      return r;
    }
  }
  return null;
}

/** Camps that spawn any of `ids` ('any' for every camp). */
function findCamp(ids, def, ctx) {
  for (const zoneId of searchOrder(def, ctx)) {
    const camps = (ZONES[zoneId].spawns || [])
      .filter((s) => ids === 'any' || (s.enemies || []).some((e) => ids.includes(e)))
      .map((s) => ({
        x: s.at[0], z: s.at[1],
        // The camp has no authored name; the enemy it is being tracked *for* is the only
        // honest label, so a stage asking for frost wolves points at 「霜狼营地」 and not at
        // whatever else happens to stand there.
        enemy: ids === 'any' ? s.enemies?.[0] : (s.enemies || []).find((e) => ids.includes(e)),
      }));
    const pick = nearest(camps, zoneId, ctx);
    if (!pick) continue;
    const nm = `${ENEMIES[pick.enemy]?.name || '敌人'}营地`;
    return resolve(zoneId, place(zoneId, pick.x, pick.z, nm, { enemyId: pick.enemy }), ctx);
  }
  return findChamberEnemy(ids, def, ctx);
}

/** Gather nodes of a kind ('any' for all), skipping the ones already picked. */
function findGather(kind, def, ctx) {
  for (const zoneId of searchOrder(def, ctx)) {
    const live = ctx.zoneId === zoneId && ctx.gathers ? ctx.gathers : gatherNodes(ZONES[zoneId]);
    const list = live.filter((n) => (kind === 'any' || n.kind === kind) && !n.done);
    const pick = nearest(list, zoneId, ctx);
    if (pick) return resolve(zoneId, place(zoneId, pick.x, pick.z, GATHER_NAME(pick.kind), { nodeId: pick.id }), ctx);
  }
  return null;
}

/** 「甜甜花采集点」, never 「采集点（sweetFlower）」: the id is not a word the player knows. */
function GATHER_NAME(kind) { return kind ? `${itemName(kind)}采集点` : '采集点'; }

/**
 * An item comes from somewhere: a camp of whatever drops it, or a patch of whatever grows it.
 * Both are derived — `ENEMIES[].loot` and `zone.gathers[]` are the tables the server rolls
 * against, so a locator that reads them cannot point at a source that does not exist.
 */
function findItemSource(itemId, def, ctx) {
  const droppers = Object.keys(ENEMIES).filter(
    (id) => (ENEMIES[id].loot || []).some(([item]) => item === itemId),
  );
  if (droppers.length) {
    const camp = findCamp(droppers, def, ctx);
    if (camp) return camp;
  }
  return findGather(itemId, def, ctx);
}

const RESOLVERS = {
  talk:      (s, def, ctx) => findNpc(s.target, def, ctx),
  reach:     (s, def, ctx) => findPoi(s.target, def, ctx),
  puzzle:    (s, def, ctx) => findPoi(s.target, def, ctx, 'puzzle'),
  chest:     (s, def, ctx) => findChest(s.target, def, ctx),
  warmth:    (s, def, ctx) => findWarmth(def, ctx),
  gather:    (s, def, ctx) => findGather(s.target, def, ctx),
  kill:      (s, def, ctx) => findCamp(s.target === 'any' ? 'any' : String(s.target).split('|'), def, ctx),
  collect:   (s, def, ctx) => findItemSource(s.target, def, ctx),
  cook:      () => ({ kind: 'panel', panel: 'cook', name: '料理' }),
  enterZone: (s, def, ctx) => {
    const destId = s.target;
    const dest = ZONES[destId];
    if (!dest) return null;
    if (destId === ctx.zoneId) {
      // Already there: the stage completes on arrival, so there is nothing to walk to. Say so
      // rather than pointing at the middle of the map.
      return { kind: 'here', zone: destId, zoneName: dest.name, name: dest.name };
    }
    const wp = defaultAnchor(dest);
    return resolve(destId, wp ? place(destId, wp.at[0], wp.at[1], wp.name || dest.name, { poiId: wp.id }) : null, ctx);
  },
  chamber:   (s, def, ctx) => {
    // 'abyssTrial:3' — the zone is the place, the floor is a number the UI already prints.
    const [destId, floor] = String(s.target).split(':');
    const dest = ZONES[destId];
    if (!dest) return null;
    if (destId === ctx.zoneId) {
      return { kind: 'here', zone: destId, zoneName: dest.name, name: dest.name, floor: Number(floor) || 1,
               hint: `在秘境内开始第 ${Number(floor) || 1} 间` };
    }
    const wp = defaultAnchor(dest);
    const r = resolve(destId, wp ? place(destId, wp.at[0], wp.at[1], wp.name || dest.name, { poiId: wp.id }) : null, ctx);
    if (r) r.floor = Number(floor) || 1;
    return r;
  },
};

/* ---------------------------------------------------------------------- public -- */

/**
 * Which quest the tracker follows. One line of HUD, so: story before anything else, and the
 * first one otherwise. Shared with the map and the quest panel so all three agree on which
 * objective the arrow belongs to — three independent "pick the tracked quest" loops is how the
 * map ends up pinning a different quest from the one the tracker names.
 */
export function trackedQuest(quests = {}) {
  let pick = null;
  for (const [id, rec] of Object.entries(quests)) {
    if (rec?.state !== 'active') continue;
    const def = QUESTS[id];
    if (!def) continue;
    if (!pick || TRACK_ORDER(def) < TRACK_ORDER(pick.def)) pick = { id, rec, def };
  }
  return pick;
}

/**
 * Which quest the one line of HUD belongs to when several are active.
 *
 * It used to be "story, else whichever came first out of `Object.entries`", which was fine while
 * the only non-story quests were the four commissions — and wrong the moment 传说/世界任务
 * existed: a 每日委托·采集 written into the save at 04:00 this morning outranked the 传说任务 the
 * player accepted five minutes ago, purely by key order. Story first (it is the spine), then the
 * regional errand, then the character story, and a commission last: a chore whose objective is
 * 「击败 12 名敌人 · any」 has nothing to point at that the player is not already doing.
 */
const TRACK_RANK = { story: 0, world: 1, side: 2, daily: 3 };
function TRACK_ORDER(def) { return TRACK_RANK[def?.type] ?? 4; }

/**
 * Where the current stage of `def` wants the player to go.
 *
 * @param def  a QUESTS entry
 * @param rec  the player's row: `{ state, stageIndex, counters }`
 * @param ctx  `{ zoneId, pos:{x,z}, pois?, gathers? }` — `pois`/`gathers` are the live world
 *             entries (with `done`) when the caller has them.
 * @returns    `null` when there is no stage, else one of
 *             `place` (a point in the zone the player is in, with `x`/`z`/`y`/`name`),
 *             `zone`  (it is in another zone; `hint` says how to get there),
 *             `here`  (this zone *is* the objective — arriving is the objective),
 *             `panel` (no place at all; the client names the key from KEYMAP).
 */
export function questTarget(def, rec, ctx = {}) {
  const stage = def?.stages?.[rec?.stageIndex ?? 0];
  if (!stage) return null;
  const fn = RESOLVERS[stage.kind];
  if (!fn) return null;
  const t = fn(stage, def, ctx);
  if (!t) return null;
  t.stage = stage;
  if (t.kind === 'place' && ctx.pos && t.zone === ctx.zoneId) {
    t.dist = Math.hypot(t.x - ctx.pos.x, t.z - ctx.pos.z);
  }
  return t;
}

/**
 * The catalogue's consumer gate, both directions — the same shape as `questGateReport()`.
 *
 * A stage kind with no resolver is an objective with no arrow: it fails at *play* time, on one
 * quest, for the players who get that far, and no test notices. A resolver no stage uses is
 * dead code. So: every kind in `QUEST_EVENT_SOURCES` must have a locator and a resolver, every
 * locator must have a kind that some stage waits on, and — the assertion that actually caught
 * things — **every stage of every quest must resolve to something** from a standing start in
 * the quest's own zone.
 */
export function questNavGateReport() {
  const problems = [];
  const kinds = new Set(Object.keys(QUEST_EVENT_SOURCES));

  for (const kind of kinds) {
    if (!STAGE_LOCATORS[kind]) problems.push(`stage kind "${kind}" has no locator, so its objective cannot be pointed at`);
    if (!RESOLVERS[kind]) problems.push(`stage kind "${kind}" is declared in STAGE_LOCATORS but has no resolver`);
  }
  for (const kind of Object.keys(STAGE_LOCATORS)) {
    if (!kinds.has(kind)) problems.push(`locator "${kind}" resolves a stage kind no quest waits on`);
    if (!RESOLVERS[kind]) problems.push(`locator "${kind}" declares no resolver`);
  }
  for (const kind of Object.keys(RESOLVERS)) {
    if (!STAGE_LOCATORS[kind]) problems.push(`resolver "${kind}" is undeclared in STAGE_LOCATORS`);
  }

  for (const [id, def] of Object.entries(QUESTS)) {
    const zoneId = def.zone || 'mondstadt';
    for (let i = 0; i < (def.stages || []).length; i++) {
      const stage = def.stages[i];
      const t = questTarget(def, { state: 'active', stageIndex: i, counters: {} },
        { zoneId, pos: { x: 0, z: 0 } });
      if (!t) { problems.push(`${id}.${stage.id} (${stage.kind} ${stage.target}) resolves to nothing`); continue; }
      if (t.kind === 'place') {
        const half = (ZONES[t.zone]?.size || 0) / 2;
        if (!Number.isFinite(t.x) || !Number.isFinite(t.z)) problems.push(`${id}.${stage.id} resolved to a non-finite point`);
        else if (Math.abs(t.x) > half || Math.abs(t.z) > half) problems.push(`${id}.${stage.id} resolved outside ${t.zone} (${t.x.toFixed(0)},${t.z.toFixed(0)})`);
        if (!t.name) problems.push(`${id}.${stage.id} resolved to an unnamed place`);
      } else if (t.kind === 'zone' && !ZONES[t.zone]) {
        problems.push(`${id}.${stage.id} points at missing zone "${t.zone}"`);
      }
    }
  }
  return problems;
}
