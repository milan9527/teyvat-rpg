import { z } from 'zod';
import crypto from 'node:crypto';
import { requireAuth } from '../auth.js';
import * as repo from '../db/repo.js';
import * as cache from '../services/playerCache.js';
import * as prog from '../services/progression.js';
import { publicPlayer } from './player.js';
import {
  ZONES, CHEST_TIERS, heightAt, findWalkable, canEnterZone, zoneEntryRank, gatherNodeById,
  puzzleNodes, puzzleNodeById, puzzleLitCount, chamberEnemies, chamberEntry, chamberStars,
} from '@teyvat/shared/data/zones.js';
import {
  TELEPORT_TYPES, defaultAnchor, isAnchorUnlocked, zoneProgress,
} from '@teyvat/shared/data/anchors.js';
import {
  zoneExploration, exploreClaim, EXPLORE_TYPES, EXPLORED_KINDS, MILESTONE_KEY,
} from '@teyvat/shared/data/exploration.js';
import { rollChest, rollGather, rollEnemyLoot } from '@teyvat/shared/sim/loot.js';
import { ENEMIES, ATTACK_MOVES } from '@teyvat/shared/data/enemies.js';
import { offerableQuest } from '@teyvat/shared/data/quests.js';
import { topLeaderboard, getPresence, rateLimit } from '../db/redis.js';
import { world } from '../world/manager.js';

/** Regrow window for a gathered node. Mirrored client-side in game/world.js. */
const REGROW_MS = 6 * 60 * 60 * 1000;

/**
 * The zone's 探索度 right now, and how far this request just moved it.
 *
 * Every route that writes a one-time `world_progress` row returns this, because the discovery and
 * the number it moved are the same event to a player: a chest that pays 3 000 mora *and* takes
 * 蒙德 from 44% to 55% is two rewards, and the second one is the reason to keep walking. The
 * percentage itself is never stored — `pctBefore` is read off the progress map before the write
 * and the rest is derived (`shared/data/exploration.js`), so a route cannot pay a percentage twice.
 *
 * Dungeons have no 探索度 (see `EXPLORED_KINDS`), and answering `null` there is deliberate: the
 * client must not draw a bar for a number the achievements do not count.
 */
function exploreBlock(zdef, worldProgress, pctBefore = null) {
  if (!zdef || !EXPLORED_KINDS.has(zdef.kind)) return null;
  const zp = zoneProgress(worldProgress, zdef.id);
  const r = zoneExploration(zdef, zp);
  // `claim` rides along on every discovery, because 「又解锁了一档奖励」 is the part of a
  // percentage a player can act on, and the alternative is the client polling a second route
  // after every chest to find out whether the button lit up. Same function the button reads.
  const claim = exploreClaim(zdef, zp);
  return {
    ...r,
    gained: pctBefore == null ? 0 : Math.max(0, r.pct - pctBefore),
    claimable: claim.claimable, paid: claim.paid, reward: claim.reward,
  };
}

/** The percentage to compare against, read *before* the row is written. */
function explorePct(zdef, worldProgress) {
  if (!zdef || !EXPLORED_KINDS.has(zdef.kind)) return null;
  return zoneExploration(zdef, zoneProgress(worldProgress, zdef.id)).pct;
}

/**
 * The highest level at which `enemyId` can legitimately be met in this zone, or 0 if
 * it cannot be met there at all.
 *
 * Used to bound what `POST /api/world/kill` will pay a 单机 client, whose simulation
 * runs in its own browser and therefore reports its own kills. The report can name
 * *which* enemy died but not what that is worth: the level is clamped to the hardest
 * place the zone tables actually put that enemy, and the loot is rolled here.
 */
function zoneKillLevel(zdef, enemyId) {
  const cap = new Map();
  const bump = (id, lv) => { if (id) cap.set(id, Math.max(cap.get(id) || 0, lv)); };
  for (const s of zdef.spawns || []) {
    for (const id of s.enemies || []) bump(id, s.level || zdef.recommendedLevel || 1);
  }
  // Every wave of every floor. (`c.boss` used to be bumped here too, which was dead code:
  // it is a boolean flag on the floor, not an enemy id, so it only ever added `true` to the
  // map.)
  for (const c of zdef.chambers || []) {
    for (const id of chamberEnemies(c)) bump(id, c.level || 1);
  }
  // Summoned adds never appear in the zone tables — they inherit their summoner's
  // level (`ZoneInstance.resolveEnemyAttack` spawns them 6 levels below it), so the
  // summoner's cap is theirs too.
  for (const [id, lv] of [...cap]) {
    for (const mvKey of ENEMIES[id]?.attacks || []) {
      for (const sid of ATTACK_MOVES[mvKey]?.summon || []) bump(sid, lv);
    }
  }
  return cap.get(enemyId) || 0;
}

export default async function worldRoutes(app) {
  app.get('/api/zones', async () => ({
    zones: Object.values(ZONES).map((z) => ({
      id: z.id, name: z.name, subtitle: z.subtitle, kind: z.kind, size: z.size,
      levelRange: z.levelRange, recommendedLevel: z.recommendedLevel,
      entryRank: zoneEntryRank(z),
      poi: z.poi, npcs: z.npcs, weather: z.weather, mechanic: z.mechanic || null,
      chambers: z.chambers || null, exit: z.exit || null,
    })),
  }));

  app.get('/api/leaderboard', async (req) => {
    const which = String(req.query?.which || 'score');
    const [redisTop, dbTop] = await Promise.all([
      topLeaderboard(which, 20),
      repo.leaderboardTop(which, 20),
    ]);
    return { which, top: dbTop.length ? dbTop.map((r, i) => ({ rank: i + 1, ...r, playerId: Number(r.player_id) })) : redisTop };
  });

  app.get('/api/online', async () => {
    const presence = await getPresence();
    return {
      count: presence.length,
      players: presence.map((p) => ({ playerId: p.playerId, nickname: p.nickname, zone: p.zone, adventureRank: p.adventureRank })),
    };
  });

  app.get('/api/chat/recent', async (req) => {
    const channel = String(req.query?.channel || 'world');
    return { messages: await repo.recentChat(channel, 50) };
  });

  /* --------------------------------------------- authenticated world actions -- */

  app.register(async (inner) => {
    inner.addHook('preHandler', requireAuth);

    /** Open a chest — server rolls the loot and records it as consumed. */
    inner.post('/api/world/chest', async (req, reply) => {
      const schema = z.object({ zone: z.string(), poiId: z.string() });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const { zone, poiId } = parsed.data;
      const zdef = ZONES[zone];
      if (!zdef) return reply.code(400).send({ error: 'bad_zone' });
      const poi = (zdef.poi || []).find((x) => x.id === poiId && x.type === 'chest');
      if (!poi) return reply.code(404).send({ error: 'no_such_chest' });

      const p = await cache.getPlayer(req.user.playerId);
      if (p.worldProgress?.[zone]?.[poiId]) return reply.code(409).send({ error: 'already_opened' });
      const pctBefore = explorePct(zdef, p.worldProgress);

      // Every form of `requires` is enforced here, and an unrecognised one refuses the chest.
      //
      // This used to read `startsWith('puzzle:')` and nothing else, which meant the three
      // dungeon reward chests (`requires: 'clear'` — one luxurious chest each: ~12 000 mora,
      // 10 primogems, four loot rolls and a guaranteed artifact) could be opened by walking
      // into the dungeon and turning right, without clearing a single chamber. The form was
      // authored, looked enforced, and was decoration. `POI_GATES` in shared/data/zoneGate.js
      // is the list, `zoneGateReport()` rejects a form that is not in it, and the `else`
      // below fails closed so the next form somebody invents cannot pay out silently.
      if (poi.requires) {
        const req = String(poi.requires);
        if (req.startsWith('puzzle:')) {
          const need = req.slice(7);
          if (!p.worldProgress?.[zone]?.[need]?.solved) {
            return reply.code(403).send({ error: 'locked', requires: need });
          }
        } else if (req === 'clear') {
          const floors = (zdef.chambers || []).map((c) => c.floor);
          const left = floors.filter((f) => !((p.abyss?.[zone]?.[f]?.stars ?? 0) > 0));
          if (!floors.length || left.length) {
            return reply.code(403).send({ error: 'locked', requires: 'clear', floors: left });
          }
        } else {
          return reply.code(403).send({ error: 'locked', requires: req });
        }
      }

      const level = Math.max(1, Math.min(90, zdef.recommendedLevel + p.worldLevel * 3));
      const loot = rollChest(poi.tier, level, crypto.randomInt(0, 2 ** 31 - 1));
      const items = { ...loot.items, mora: loot.mora, primogem: loot.primogem };
      await repo.addItems(p.playerId, items);
      p.mora += loot.mora; p.primogem += loot.primogem;
      for (const [k, v] of Object.entries(loot.items)) p.inventory[k] = (p.inventory[k] || 0) + v;
      for (const a of loot.artifacts) { await repo.addEquipment(p.playerId, a); p.equipment.push({ ...a, equippedBy: null }); }
      for (const w of loot.weapons) { await repo.addEquipment(p.playerId, w); p.equipment.push({ ...w, equippedBy: null }); }

      p.worldProgress[zone] = p.worldProgress[zone] || {};
      p.worldProgress[zone][poiId] = { opened: true };
      await repo.saveWorldProgress(p.playerId, zone, poiId, { opened: true });

      // One pass only. A stage with `target: 'any'` matches every chest event, so the
      // tier call below already advances it; a second `target: 'any'` pass counted
      // each chest twice — and `count: 0` does not make it a no-op, because
      // advanceQuests reads `event.count || 1`.
      const questUpdates = await prog.advanceQuests(p, { kind: 'chest', target: poi.tier, count: 1 });
      await cache.mirror(p.playerId, p);
      return {
        loot: { ...loot, items }, questUpdates, player: publicPlayer(p),
        explore: exploreBlock(zdef, p.worldProgress, pctBefore),
      };
    });

    /**
     * Light one monument of a puzzle, and solve the puzzle when the last one is lit.
     *
     * A puzzle is `poi.count` monuments standing in a ring (`puzzleNodes`), so this route
     * takes the monument's id and pays nothing until every one of them is lit. Each monument
     * is recorded under `p:<poiId>#<i>` with a `{lit}` payload — deliberately not `{solved}`,
     * because `repo.achSnapshot` tells world-progress records apart by their payload and a
     * monument must not count as a solved puzzle in the 探索 achievements.
     *
     * `nodeId` is optional so a one-monument puzzle (and any old client) still works: with
     * `count: 1` the ring is a single monument at the poi itself.
     */
    inner.post('/api/world/puzzle', async (req, reply) => {
      const schema = z.object({ zone: z.string(), poiId: z.string(), nodeId: z.string().optional() });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const { zone, poiId, nodeId } = parsed.data;
      const zdef = ZONES[zone];
      const poi = (zdef?.poi || []).find((x) => x.id === poiId && x.type === 'puzzle');
      if (!poi) return reply.code(404).send({ error: 'no_such_puzzle' });
      const p = await cache.getPlayer(req.user.playerId);
      if (p.worldProgress?.[zone]?.[poiId]) return reply.code(409).send({ error: 'already_solved' });
      const pctBefore = explorePct(zdef, p.worldProgress);

      const nodes = puzzleNodes(zdef, poi);
      const node = nodeId ? puzzleNodeById(zdef, poi, nodeId) : nodes[0];
      if (!node) return reply.code(404).send({ error: 'no_such_monument' });

      // Same reach rule as gathering, for the same reason: the monuments are metres apart, so
      // without it one click at the ring's centre could light the whole puzzle.
      const live = world.livePos(p.playerId);
      if (live) {
        if (live.zone !== zone) return reply.code(409).send({ error: 'wrong_zone' });
        if (Math.hypot(live.x - node.x, live.z - node.z) > 14) {
          return reply.code(409).send({ error: 'too_far' });
        }
      }

      p.worldProgress[zone] = p.worldProgress[zone] || {};
      const litKey = `p:${node.id}`;
      if (p.worldProgress[zone][litKey]?.lit) return reply.code(409).send({ error: 'already_lit' });
      p.worldProgress[zone][litKey] = { lit: true };
      await repo.saveWorldProgress(p.playerId, zone, litKey, { lit: true });

      const lit = puzzleLitCount(zdef, poi, p.worldProgress[zone]);
      if (lit < nodes.length) {
        await cache.mirror(p.playerId, p);
        // A lit monument is not a discovery: `gained` is 0 here by construction (the puzzle's own
        // row is what counts, and it has not been written yet), and the block still goes out so
        // the client has one shape to read on both branches.
        return {
          ok: true, solved: false, lit, total: nodes.length, node: node.id, player: publicPlayer(p),
          explore: exploreBlock(zdef, p.worldProgress, pctBefore),
        };
      }

      p.worldProgress[zone][poiId] = { solved: true };
      await repo.saveWorldProgress(p.playerId, zone, poiId, { solved: true });
      const reward = { mora: 2000, primogem: 5 };
      await repo.addItems(p.playerId, reward);
      p.mora += reward.mora; p.primogem += reward.primogem;
      const questUpdates = await prog.advanceQuests(p, { kind: 'puzzle', target: poiId, count: 1 });
      await cache.mirror(p.playerId, p);
      return {
        ok: true, solved: true, lit, total: nodes.length, node: node.id,
        reward, questUpdates, player: publicPlayer(p),
        explore: exploreBlock(zdef, p.worldProgress, pctBefore),
      };
    });

    /**
     * Unlock a teleport waypoint / statue / campfire.
     *
     * The type filter is the whole security of this route, and it was missing: `find(x => x.id ===
     * poiId)` accepted **any** POI in the zone, wrote `{unlocked:true}` under its id and paid
     * 5 原石 for it. Two consequences, both silent. Every other route that owns a one-time POI
     * asks `if (worldProgress[zone][poiId])` first, so `POST /api/world/unlock {poiId:'mond_chest1'}`
     * *bricked that chest* — 409 `already_opened`, loot gone, for 5 原石. And `achSnapshot` counts
     * activated anchors by the `{unlocked}` payload, so the same call inflated 「七天神像的指引」
     * with chests, monuments and dungeon doors. The list of types that may be activated lives in
     * `data/exploration.js` next to the 探索度 that counts them, and anything else fails closed.
     */
    inner.post('/api/world/unlock', async (req, reply) => {
      const schema = z.object({ zone: z.string(), poiId: z.string() });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const { zone, poiId } = parsed.data;
      const zdef = ZONES[zone];
      const poi = (zdef?.poi || []).find((x) => x.id === poiId);
      if (!poi) return reply.code(404).send({ error: 'no_such_poi' });
      if (EXPLORE_TYPES[poi.type]?.writer !== 'POST /api/world/unlock') {
        return reply.code(409).send({ error: 'not_an_anchor', type: poi.type });
      }
      const p = await cache.getPlayer(req.user.playerId);
      const already = !!p.worldProgress?.[zone]?.[poiId];
      const pctBefore = explorePct(zdef, p.worldProgress);
      p.worldProgress[zone] = p.worldProgress[zone] || {};
      p.worldProgress[zone][poiId] = { unlocked: true };
      await repo.saveWorldProgress(p.playerId, zone, poiId, { unlocked: true });
      let reward = null;
      if (!already) {
        reward = poi.type === 'statue' ? { primogem: 10, mora: 1000 } : { primogem: 5 };
        await repo.addItems(p.playerId, reward);
        p.primogem += reward.primogem || 0; p.mora += reward.mora || 0;
      }
      const kind = poi.type === 'warmth' ? 'warmth' : 'reach';
      const questUpdates = await prog.advanceQuests(p, { kind, target: poi.type === 'warmth' ? 'any' : poiId, count: 1 });
      await cache.mirror(p.playerId, p);
      return {
        ok: true, first: !already, reward, questUpdates, player: publicPlayer(p),
        explore: exploreBlock(zdef, p.worldProgress, pctBefore),
      };
    });

    /**
     * Collect the 探索度 milestones this zone has reached.
     *
     * Everything that decides what this pays is derived here, from the same rows the map panel
     * draws its percentage from: the thresholds crossed, the ladder priced off the zone's own
     * chests, and the high-water mark of what has already been paid. The request names a zone and
     * nothing else — there is no amount, no tier and no list of steps on the wire, so there is
     * nothing for a client to overstate.
     *
     * Retroactive by construction: a save that reached 88% before this route existed collects
     * 20/40/60/80 on the first press, because the percentage was never a counter that had to be
     * ticking while the rewards were being invented (see `data/exploration.js`).
     *
     * The double-pay guard is `repo.claimExploreMilestone`'s `WHERE`, not this function: two
     * presses racing each other both read the same rows and compute the same target, and only the
     * one whose UPDATE moves the mark is paid.
     */
    inner.post('/api/world/explore/claim', async (req, reply) => {
      const schema = z.object({ zone: z.string().min(1).max(40) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const zdef = ZONES[parsed.data.zone];
      if (!zdef) return reply.code(400).send({ error: 'bad_zone' });
      // A 秘境 has no 探索度 at all, so it has no ladder either. Refused rather than answered with
      // an empty claim: a client asking this of a dungeon is a client that thinks it has a bar.
      if (!EXPLORED_KINDS.has(zdef.kind)) return reply.code(409).send({ error: 'no_exploration' });

      const p = await cache.getPlayer(req.user.playerId);
      if (!p) return reply.code(404).send({ error: 'no_player' });
      const zone = zdef.id;
      const st = exploreClaim(zdef, zoneProgress(p.worldProgress, zone));
      if (!st.claimable.length) {
        return reply.code(400).send({
          error: 'nothing_to_claim', pct: st.pct, paid: st.paid, next: st.next?.pct ?? null,
        });
      }

      const won = await repo.claimExploreMilestone(p.playerId, zone, MILESTONE_KEY, st.to);
      if (won === null) return reply.code(409).send({ error: 'already_claimed' });

      const reward = { mora: st.reward.mora, primogem: st.reward.primogem };
      await repo.addItems(p.playerId, reward);
      p.mora += reward.mora; p.primogem += reward.primogem;
      p.worldProgress[zone] = p.worldProgress[zone] || {};
      p.worldProgress[zone][MILESTONE_KEY] = { pct: won };
      await cache.mirror(p.playerId, p);

      return {
        ok: true, zone,
        took: st.steps.filter((s) => s.state === 'ready').map((s) => ({ pct: s.pct, rewards: s.rewards })),
        gained: reward,
        // `pctBefore` is `null` on purpose: claiming discovers nothing, so `gained` on the explore
        // block would be a second, differently-shaped 0 next to the payout above.
        explore: exploreBlock(zdef, p.worldProgress, null),
        claim: exploreClaim(zdef, zoneProgress(p.worldProgress, zone)),
        player: publicPlayer(p),
      };
    });

    /**
     * Gather a plant/ore node.
     *
     * The reward comes from the *node*, never from the request: the node list is
     * generated deterministically from the zone seed on both sides, so the client
     * only has to name which node it picked. Trusting a client-supplied `kind` here
     * would let anyone post `{kind:'starsilver'}` at a sweet-flower and mine the
     * rarest ore in the game from a meadow.
     */
    inner.post('/api/world/gather', async (req, reply) => {
      const schema = z.object({ zone: z.string(), nodeId: z.string(), kind: z.string().optional() });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const p = await cache.getPlayer(req.user.playerId);
      const { zone, nodeId } = parsed.data;
      const zdef = ZONES[zone];
      const node = zdef ? gatherNodeById(zdef, nodeId) : null;
      if (!node) return reply.code(404).send({ error: 'no_such_node' });
      const kind = node.kind;
      // Reach check against the *live* entity, not the saved position — the save is
      // only written on zone exit. Generous (14 m against an interact range of ~3)
      // because the character is still walking when the click fires, but it does
      // stop a script harvesting a whole zone from the spawn point. A player with
      // no live entity is not rejected: HTTP-only play is supported.
      const live = world.livePos(p.playerId);
      if (live) {
        if (live.zone !== zone) return reply.code(409).send({ error: 'wrong_zone' });
        if (Math.hypot(live.x - node.x, live.z - node.z) > 14) {
          return reply.code(409).send({ error: 'too_far' });
        }
      }
      const key = `g:${nodeId}`;
      const prev = p.worldProgress?.[zone]?.[key];
      if (prev?.at && Date.now() - prev.at < REGROW_MS) {
        return reply.code(409).send({ error: 'not_regrown' });
      }
      const items = rollGather(kind, crypto.randomInt(0, 2 ** 31 - 1));
      await repo.addItems(p.playerId, items);
      for (const [k, v] of Object.entries(items)) p.inventory[k] = (p.inventory[k] || 0) + v;
      p.worldProgress[zone] = p.worldProgress[zone] || {};
      p.worldProgress[zone][key] = { at: Date.now() };
      await repo.saveWorldProgress(p.playerId, zone, key, { at: Date.now() });
      const questUpdates = await prog.advanceQuests(p, { kind: 'gather', target: kind, count: 1 });
      await cache.mirror(p.playerId, p);
      return { items, kind, node: nodeId, questUpdates, player: publicPlayer(p) };
    });

    /** Teleport to an unlocked waypoint (or a zone's default entry). */
    inner.post('/api/world/teleport', async (req, reply) => {
      const schema = z.object({ zone: z.string(), poiId: z.string().optional() });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const zdef = ZONES[parsed.data.zone];
      if (!zdef) return reply.code(400).send({ error: 'bad_zone' });
      const p = await cache.getPlayer(req.user.playerId);
      if (!canEnterZone(zdef, p.adventureRank)) {
        return reply.code(403).send({ error: 'rank_too_low', need: zoneEntryRank(zdef) });
      }
      // Fast travel goes to anchors you have *activated*. `world_progress` has stored those rows
      // since the first commit and this route never read them, so the map was a free teleport to
      // anywhere in a zone you had rank for — 5 原石 for an unlock bought a diamond on the map and
      // nothing else. The zone's default anchor stays open (it is how you first arrive, and the
      // unlock route wants you standing in the zone), and anything that is not an anchor type at
      // all fails closed rather than silently falling back to the entry.
      const zoneProg = zoneProgress(p.worldProgress, zdef.id);
      let target = defaultAnchor(zdef);
      if (parsed.data.poiId) {
        const asked = (zdef.poi || []).find((x) => x.id === parsed.data.poiId);
        if (!asked || !TELEPORT_TYPES.has(asked.type)) return reply.code(404).send({ error: 'no_such_anchor' });
        if (!isAnchorUnlocked(zdef, asked, zoneProg)) {
          return reply.code(403).send({ error: 'anchor_locked', poiId: asked.id, name: asked.name || null });
        }
        target = asked;
      }
      const at = target ? target.at : [0, 0];
      // Named `tz`, not `z`: `z` is zod at module scope, and a `const z` anywhere in
      // this handler puts the whole function's `z` in the temporal dead zone — the
      // `z.object(...)` above then throws, so every fast travel answered 500.
      const [tx, ty, tz] = findWalkable(zdef, at[0], at[1]);
      p.zone = zdef.id;
      p.pos = { x: tx, y: ty + 1.2, z: tz, ry: 0 };
      await repo.savePlayerCore(p.playerId, { zone: p.zone, pos: p.pos });
      const questUpdates = await prog.advanceQuests(p, { kind: 'enterZone', target: zdef.id, count: 1 });
      await cache.mirror(p.playerId, p);
      return { zone: p.zone, pos: p.pos, questUpdates, player: publicPlayer(p) };
    });

    /** Talk to an NPC — may start a quest. */
    inner.post('/api/world/talk', async (req, reply) => {
      const schema = z.object({ zone: z.string(), npcId: z.string() });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const zdef = ZONES[parsed.data.zone];
      const npc = (zdef?.npcs || []).find((n) => n.id === parsed.data.npcId);
      if (!npc) return reply.code(404).send({ error: 'no_such_npc' });
      const p = await cache.getPlayer(req.user.playerId);
      const questUpdates = await prog.advanceQuests(p, { kind: 'talk', target: npc.id, count: 1 });
      let started = null;
      // What this NPC is holding out right now: their story hook first, then their 传说/世界任务
      // in authored order, filtered by prerequisite and by rank. The rule lives in `shared`
      // (`offerableQuest`) because the client's interaction prompt asks the same question to
      // decide whether the subtitle reads 「有新任务」 — two copies of it is a prompt that
      // promises a quest this route then declines to start.
      //
      // The rank test inside it is `rankForLevel(minLevel)`, the inverse of `arCap`, and nothing
      // else: the old private rule here (`adventureRank >= minLevel / 2`) wanted AR 28 for the
      // finale's level 55 where the cap only needs 18, and `tools/balance-check.mjs` measured
      // the whole story chain stalling out at AR 23 with nothing repeatable left to fix it.
      const qd = offerableQuest(npc, p);
      if (qd) {
        p.quests[qd.id] = { state: 'active', stageIndex: 0, counters: {} };
        await repo.saveQuest(p.playerId, qd.id, p.quests[qd.id]);
        started = { id: qd.id, name: qd.name, type: qd.type, chapter: qd.chapter || null, intro: qd.intro };
      }
      await cache.mirror(p.playerId, p);
      return { npc, questUpdates, started, player: publicPlayer(p) };
    });

    /**
     * Report a kill made by a client-hosted simulation (单机 mode).
     *
     * Online the gateway owns this: the zone instance decides that an enemy died and
     * `manager.handleKill` pays for it, so a client cannot ask. With no gateway there
     * is no such witness, and the choice is between an offline mode that awards nothing
     * and one that trusts the report. This route takes the second option but keeps every
     * *number* on this side: the enemy has to exist in the zone's own spawn/chamber
     * tables, its level is clamped to the hardest place those tables put it, the loot is
     * rolled here, and the whole thing is rate limited to a pace a real fight can hit.
     * A player who is currently in a live shard is refused outright — the gateway is
     * already paying for their kills, and two payers for one corpse is the bug that
     * `POST /api/world/chamber` used to have.
     */
    inner.post('/api/world/kill', async (req, reply) => {
      const schema = z.object({
        zone: z.string(),
        enemyId: z.string(),
        level: z.number().int().min(1).max(120).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const { zone, enemyId } = parsed.data;
      const zdef = ZONES[zone];
      if (!zdef) return reply.code(400).send({ error: 'bad_zone' });
      if (!ENEMIES[enemyId]) return reply.code(404).send({ error: 'no_such_enemy' });
      const capLevel = zoneKillLevel(zdef, enemyId);
      if (!capLevel) return reply.code(404).send({ error: 'not_in_zone' });

      const p = await cache.getPlayer(req.user.playerId);
      if (!canEnterZone(zdef, p.adventureRank)) {
        return reply.code(403).send({ error: 'rank_too_low', need: zoneEntryRank(zdef) });
      }
      if (world.livePos(p.playerId)) return reply.code(409).send({ error: 'use_socket' });
      // 60 per minute is roughly four times the pace of clearing camps back to back,
      // and still bounds a broken or malicious client to what farming would earn anyway.
      if (!(await rateLimit(`kill:${p.playerId}`, 60, 60))) {
        return reply.code(429).send({ error: 'too_fast' });
      }

      const scaled = Math.max(1, Math.round(capLevel * (1 + 0.06 * (p.worldLevel || 0))));
      const level = Math.min(scaled, Math.max(1, parsed.data.level ?? scaled));
      const loot = rollEnemyLoot(enemyId, level, crypto.randomInt(0, 2 ** 31 - 1));
      const { items, ar, levels, questUpdates } = await prog.grantKillRewards(p, enemyId, loot);
      await repo.updateLeaderboard(p.playerId, p.nickname, { score: p.adventureXp, kills: 1 });
      await cache.mirror(p.playerId, p);
      return {
        from: enemyId, level, items, mora: loot.mora, xp: loot.xp,
        ar, levels, questUpdates, player: publicPlayer(p),
      };
    });

    /** Record chamber (dungeon floor) clear. */
    inner.post('/api/world/chamber', async (req, reply) => {
      const schema = z.object({ zone: z.string(), floor: z.number().int().min(1).max(20), time: z.number().min(0) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const { zone, floor, time } = parsed.data;
      const zdef = ZONES[zone];
      const p = await cache.getPlayer(req.user.playerId);

      // This route grants real progression off a client-reported time, so it has to apply
      // the same authorisation the gateway's START_CHAMBER does — one shared rule
      // (`chamberEntry`), so the two can never disagree and the map panel can draw the same
      // locks it enforces. Without it a fresh guest could POST
      // `{zone:'abyssTrial', floor:8, time:10}` and be paid for the level-80 floor without
      // entering the dungeon, let alone fighting in it.
      const entry = chamberEntry(zdef, floor, { adventureRank: p.adventureRank, abyss: p.abyss });
      if (!entry.ok) {
        // `no_such_chamber` is a 404 (the thing asked for does not exist); the rest are
        // refusals of a request that made sense (403).
        const code = entry.error === 'no_such_chamber' || entry.error === 'not_a_dungeon' ? 404 : 403;
        return reply.code(code).send({ error: entry.error, ...(entry.need ? { need: entry.need } : {}) });
      }
      const chamber = entry.chamber;

      // Same rule as `POST /api/world/kill`: a player who is in a live shard has the
      // gateway paying for this clear already (`manager.handleChamberClear`), so this
      // route must refuse them rather than pay a second time. It used to rely on the
      // milestone being star-gated — but the resin-paid drop is granted on *every* clear,
      // so a second call now costs the player 20 more resin and hands out a second
      // artifact for one fight.
      if (world.livePos(p.playerId)) return reply.code(409).send({ error: 'use_socket' });

      const stars = chamberStars(chamber, time);
      if (stars === 0) return reply.code(200).send({ stars: 0, cleared: false, message: '超时，未获得星数' });

      const r = await prog.grantChamberClear(p, zone, floor, time, stars);
      await cache.mirror(p.playerId, p);
      return {
        stars, cleared: true, reward: r.reward, drops: r.drops, resin: r.resin,
        arResult: r.ar, partyLevels: r.partyLevels, questUpdates: r.questUpdates,
        player: publicPlayer(p),
      };
    });
  });
}
