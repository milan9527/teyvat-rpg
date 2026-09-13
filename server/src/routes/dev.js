// Dev-only test hook: put this account at an adventure rank.
//
// Why the server needs one at all. Four of the six zones are rank-gated (龙脊雪山 AR 4,
// 冰封洞窟 5, 璃月 7, 黄金屋 18) and the gate is enforced in three places on purpose —
// `/api/world/teleport`, the gateway's `JOIN_ZONE`, and `localSocket`'s copy for 单机. That is
// correct for players and fatal for the picture: `tools/tour.mjs` is the project's only
// regression gate on 「细腻画面」, it works by warping into every zone and shooting four frames a
// quarter-turn apart, and on a fresh guest account it could only ever reach 蒙德 and 深渊试炼场.
// The tour did not report this. It read the refusal as "the transition did not take", which is
// also what a broken zone stream looks like, so the run either died with a misleading message
// or (before the tour learned to check) wrote screenshots of 蒙德 with dragonspine's name on
// them. `tools/nan-scan.mjs` hit the same wall the moment it started scanning all six zones:
// four FAILs that were the account's rank, not the geometry.
//
// The alternative was for probes to earn AR 18, which is hours of simulated play per run, or to
// reach into Postgres behind the server's back, which would leave the live save in Redis
// disagreeing with the row. So: one route, and it goes through the *real* progression path —
// `grantAdventureXp`, the same function a quest reward calls — rather than writing
// `adventure_rank` directly. That keeps `adventure_xp`, `world_level` and the AR-up rewards
// consistent with a rank earned the honest way, and it means this file adds no second
// implementation of anything.
//
// It is only registered when `config.isDev` (`NODE_ENV !== 'production'`), and `index.js`
// prints a line at boot when it is on, because a rank cheat that is quietly reachable in
// production is exactly the "dead route with no caller" this repo has already been bitten by
// twice. `tools/api-check.mjs` asserts both halves: that the hook moves the rank and unlocks
// the zone that was refused a moment earlier, and that `index.js` still guards the
// registration.

import { z } from 'zod';
import { requireAuth } from '../auth.js';
import * as repo from '../db/repo.js';
import * as cache from '../services/playerCache.js';
import {
  grantAdventureXp, ASCENSION_CAPS, ASCENSION_COST, regenResin, RESIN_CAP,
} from '../services/progression.js';
import { publicPlayer } from './player.js';
import { MATERIALS, WEAPONS } from '@teyvat/shared/data/items.js';
import {
  WEAPON_MORA_PER_XP, oreXp, weaponCapFor, weaponXpToLevel,
} from '@teyvat/shared/sim/loot.js';
import { xpForLevel, arCap } from '@teyvat/shared/sim/formulas.js';
// `totalXpTo` is the inverse of the curve `levelFromXp` walks, and it already exists — a
// second copy of the summation here is the kind of duplicate that drifts silently.
import { totalXpTo } from '@teyvat/shared/sim/formulas.js';

const RANK_MAX = 90;

const rankSchema = z.object({
  rank: z.number().int().min(1).max(RANK_MAX),
});

// Up to a week, which covers the longest trip (20 h) with room to spare, and is bounded so a
// typo cannot push a row's `started_at` into the 1970s and make every future trip instant.
const rewindSchema = z.object({
  seconds: z.number().int().min(1).max(7 * 24 * 3600),
});

const supplySchema = z.object({
  level: z.number().int().min(2).max(90),
});

/**
 * The shopping list for taking this account's party to `level`, derived from the cost tables
 * the player pays out of.
 *
 * Why a *supply* hook and not a "make me level 40" hook. `POST /api/dev/rank` unlocked the four
 * rank-gated zones for the screenshot probes; this one exists because `tools/mp-check.mjs` could
 * not photograph the other half of a 秘境 — a **cleared** run in co-op. Two fresh guests are
 * level 1 with level-1 starter weapons, the shallowest floor in the game is level 18 with 1576 hp
 * hilichurls on it, and so the only outcome a probe could construct was the wipe. That left
 * `handleChamberClear` — the loop that pays *every* player in the instance, the reason co-op
 * dungeons were built — with no receipt at all.
 *
 * So this route hands over materials and mora, and nothing else: the probe then spends them
 * through `/api/char/levelup`, `/api/char/ascend` and `/api/inventory/weapon/levelup`, which is
 * the same sequence a player clicks. Nothing here writes a level, an ascension or a stat — if
 * the growth routes are broken, the probe stays weak and the assertions that need a strong party
 * go red, which is the correct outcome. A hook that wrote `level = 40` directly would hide them.
 *
 * The amounts are *derived*, twice over: character xp from `xpForLevel` (the same curve
 * `levelUpCharacter` walks), ascension materials from `ASCENSION_COST`, weapon xp from
 * `weaponXpToLevel`, and mora at the rates both routes charge. So this is not a wish list of
 * items — it cannot mint anything the growth path does not consume, and if a cost table changes
 * the supply changes with it.
 */
function supplyFor(player, level) {
  // Never past what the account's rank allows: the growth routes cap at `arCap`, and granting
  // books for levels they will refuse to hand out would make the probe's own level assertion
  // unmeetable for a reason that is not a bug.
  const want = Math.min(level, arCap(player.adventureRank));
  const items = {};
  let mora = 0;
  const add = (id, n) => { if (n > 0) items[id] = (items[id] || 0) + Math.ceil(n); };

  const bookXp = MATERIALS.heroWit.xp;
  for (const inst of Object.values(player.characters || {})) {
    for (let asc = inst.ascension || 0; asc < ASCENSION_COST.length && ASCENSION_CAPS[asc] < want; asc++) {
      mora += ASCENSION_COST[asc].mora;
      for (const [id, n] of Object.entries(ASCENSION_COST[asc].items)) add(id, n);
    }
    let xp = -(inst.xp || 0);
    for (let l = inst.level || 1; l < want; l++) xp += xpForLevel(l);
    if (xp <= 0) continue;
    // Books are indivisible, and `levelUpCharacter` charges mora on the xp handed over, so the
    // mora is priced on the whole books rather than on the xp actually needed.
    const books = Math.ceil(xp / bookXp);
    add('heroWit', books);
    mora += Math.round(books * bookXp * 0.2);
  }

  for (const w of player.equipment || []) {
    if (w.kind !== 'weapon') continue;
    const rarity = WEAPONS[w.weaponId]?.rarity ?? 4;
    const cap = Math.min(weaponCapFor(w, player.adventureRank), want);
    const need = weaponXpToLevel(rarity, cap) - weaponXpToLevel(rarity, w.level || 1) - (w.xp || 0);
    if (need <= 0) continue;
    // Iron only: it is the cheapest rung of `WEAPON_ORE` and the route spends cheapest-first,
    // so one ore kind is the whole supply and the tiers above it stay something to be mined.
    const chunks = Math.ceil(need / oreXp('ironChunk'));
    add('ironChunk', chunks);
    mora += Math.round(chunks * oreXp('ironChunk') * WEAPON_MORA_PER_XP);
  }
  return { level: want, items, mora };
}

export default async function devRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/dev')) return;
    return requireAuth(req, reply);
  });

  app.post('/api/dev/rank', async (req, reply) => {
    const parsed = rankSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });

    const want = parsed.data.rank;
    // Only ever forward: rolling a rank *back* would leave levelled characters above
    // `arCap(rank)` and equipment above its cap, states no other code path can produce.
    if (want <= p.adventureRank) {
      return { rank: p.adventureRank, moved: false, player: publicPlayer(p) };
    }
    const gain = totalXpTo(want) - p.adventureXp;
    const res = await grantAdventureXp(p, Math.max(1, gain));
    cache.markDirty(p.playerId);
    return {
      rank: p.adventureRank, moved: true, granted: Math.max(1, gain),
      worldLevel: p.worldLevel, reward: res?.reward || null, player: publicPlayer(p),
    };
  });

  /** Hand the account the materials and mora its own growth curve prices at `level`. */
  app.post('/api/dev/supply', async (req, reply) => {
    const parsed = supplySchema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });

    const bill = supplyFor(p, parsed.data.level);
    const grant = { ...bill.items, mora: bill.mora };
    await repo.addItems(p.playerId, grant);
    for (const [id, n] of Object.entries(bill.items)) {
      p.inventory[id] = (p.inventory[id] || 0) + n;
    }
    p.mora += bill.mora;
    // `mirror`, not `markDirty`: the probe's very next call is a growth route, which reads the
    // player back out of the cache and would otherwise spend an inventory that has not arrived.
    await cache.mirror(p.playerId, p);
    return {
      level: bill.level, asked: parsed.data.level, granted: grant,
      player: publicPlayer(p), inventory: p.inventory,
    };
  });

  /**
   * Move this account's 探索派遣 back in time.
   *
   * The shortest trip is four hours, so without this hook the only testable half of the module
   * is the refusals: nothing could prove that a finished trip pays exactly its authored basket,
   * that an unfinished one refuses with `not_finished`, or that the card ever reaches 可领取.
   * It shifts `started_at`, which is the only clock the table has — there is no stored deadline
   * to keep in step (see `sql/schema.sql`).
   *
   * It cannot mint anything on its own: the payout still comes from `(destId, hours)` through
   * the same pure function the panel promised, and the row still has to be claimed through the
   * real route. What it buys is time, and time is the one input a probe cannot wait for.
   */
  app.post('/api/dev/expedition-rewind', async (req, reply) => {
    const parsed = rewindSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });
    const moved = await repo.rewindExpeditions(p.playerId, parsed.data.seconds);
    return { moved, seconds: parsed.data.seconds };
  });

  /**
   * Move this account's resin clock back, and let the *real* regen run on the result.
   *
   * Same argument as the expedition rewind, one currency over: resin is a clock, and a probe
   * cannot wait 8 minutes a point. Without it the deep-floor half of 秘境 is untestable —
   * eight floors x 20 resin is two full bars, so a walk down the dungeon runs dry on floor 4
   * and every drop assertion below that becomes "the bar was empty", which the suite already
   * proves on floor 1.
   *
   * It mints nothing: `resinAt` is the only input regen has, and the granted amount comes out
   * of `regenResin` at its authored `RESIN_PERIOD_MS` and `RESIN_CAP`. Rewinding a week hands
   * over a capped bar, not 1 260 resin. The cap is what makes this safe to bound loosely, and
   * `api-check` asserts it: a week's rewind must leave exactly `RESIN_CAP`.
   */
  app.post('/api/dev/resin-rewind', async (req, reply) => {
    const parsed = rewindSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });

    const before = p.resin;
    const last = new Date(p.resinAt || Date.now()).getTime();
    p.resinAt = new Date(last - parsed.data.seconds * 1000);
    // Regen is lazy and only runs on a cache *miss* (`playerCache.getPlayer`), so a rewind
    // that only moved the timestamp would do nothing at all for a player who is online —
    // which is every player a probe has. Apply the same function here.
    const rr = regenResin(p);
    p.resin = rr.resin;
    p.resinAt = rr.resinAt;
    await repo.savePlayerCore(p.playerId, { resin: p.resin, resinAt: p.resinAt });
    await cache.mirror(p.playerId, p);
    return {
      resin: p.resin, gained: p.resin - before, cap: RESIN_CAP,
      seconds: parsed.data.seconds, player: publicPlayer(p),
    };
  });
}
