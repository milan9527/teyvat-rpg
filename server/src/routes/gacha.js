import { z } from 'zod';
import crypto from 'node:crypto';
import { requireAuth } from '../auth.js';
import * as repo from '../db/repo.js';
import * as cache from '../services/playerCache.js';
import { publicPlayer, publishStats } from './player.js';
import { pullWish, makeWeapon, SOFT_PITY, wishConversion, sumConversion } from '@teyvat/shared/sim/loot.js';
import { WISH_POOL } from '@teyvat/shared/data/items.js';
import { GEM_PER_WISH } from '@teyvat/shared/data/shop.js';
import { rateLimit } from '../db/redis.js';

export default async function gachaRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/wish')) return;
    return requireAuth(req, reply);
  });

  app.get('/api/wish/pools', async () => {
    return {
      pools: Object.values(WISH_POOL).map((p) => ({
        id: p.id, name: p.name, cost: p.cost,
        featuredFive: p.featuredFive || null, featuredFour: p.featuredFour || null,
        rate5: p.fiveStar.rate, pity5: p.fiveStar.pity, rate4: p.fourStar.rate, pity4: p.fourStar.pity,
        // The rate-up chances and the soft-pity curve are published too, because the panel
        // prints them: 「限定五星 55%」 and 「当前五星概率」 are the two numbers a player uses to
        // decide whether to pull, and a client that invents either of them is lying about
        // the roll `pullWish` is going to make.
        featuredChance5: p.fiveStar.featuredChance ?? null,
        featuredChance4: p.fourStar.featuredChance ?? null,
        softPity: SOFT_PITY,
        gemPerWish: GEM_PER_WISH,
      })),
    };
  });

  app.get('/api/wish/history', async (req) => {
    const rows = await repo.wishHistory(req.user.playerId, 200);
    return { history: rows };
  });

  app.post('/api/wish/pull', async (req, reply) => {
    const schema = z.object({
      pool: z.enum(['standard', 'featured']),
      count: z.union([z.literal(1), z.literal(10)]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    if (!(await rateLimit(`wish:${req.user.playerId}`, 60, 60))) {
      return reply.code(429).send({ error: 'too_fast' });
    }
    const { pool, count } = parsed.data;
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });

    // Cost comes from the pool's own `cost`, not from a hardcoded 1: the field is published
    // by `/api/wish/pools` and printed in the footer, so a route that charges its own number
    // would silently overrule the banner. Primogems auto-convert at the shop's published
    // rate — that constant is imported for the same reason.
    let tickets = p.wishTicket;
    let gems = p.primogem;
    const perPull = WISH_POOL[pool]?.cost?.wishTicket ?? 1;
    const needTickets = count * perPull;
    if (tickets < needTickets) {
      const short = needTickets - tickets;
      const gemCost = short * GEM_PER_WISH;
      if (gems < gemCost) return reply.code(400).send({ error: 'not_enough_currency', needGems: gemCost, haveGems: gems });
      gems -= gemCost;
      tickets += short;
    }
    tickets -= needTickets;

    const state = p.wishState[pool]
      || { pity5: 0, pity4: 0, guaranteed5: false, guaranteed4: false, total: 0 };
    const results = [];
    let s = state;
    for (let i = 0; i < count; i++) {
      const seed = crypto.randomInt(0, 2 ** 31 - 1);
      const r = pullWish(pool, s, seed);
      s = r.state;
      results.push(r.result);
    }

    // Apply: characters grant/dupe, weapons materialise into equipment. Every result also
    // converts to 星辉/星尘 — see `wishConversion`. `capped` (the duplicate raised nothing)
    // comes from the grant, so the conversion has to be computed here where that answer is,
    // not from the roll alone.
    const grants = [];
    for (const r of results) {
      if (r.type === 'character') {
        const g = await repo.grantCharacter(p.playerId, r.id);
        grants.push({ ...r, dupe: g.dupe, dupes: g.dupes, capped: !!g.capped, converted: wishConversion(r, g) });
        if (!g.dupe) {
          p.characters[r.id] = {
            charId: r.id, level: 1, xp: 0, ascension: 0,
            talents: { normal: 1, skill: 1, burst: 1 }, dupes: 0,
            weapon: null, artifacts: {}, hp: -1, energy: 0,
          };
        } else if (p.characters[r.id]) {
          p.characters[r.id].dupes = g.dupes;
        }
      } else {
        const w = makeWeapon(r.id, 1);
        await repo.addEquipment(p.playerId, w);
        p.equipment.push({ ...w, equippedBy: null });
        grants.push({ ...r, uid: w.uid, converted: wishConversion(r) });
      }
    }

    // The change, in one write. 星辉/星尘 are inventory items rather than player columns
    // (`CURRENCIES`), so this is an `addItems` and the mirror has to move with it.
    const change = sumConversion(grants.map((x) => x.converted));
    for (const [id, qty] of Object.entries(change)) p.inventory[id] = (p.inventory[id] || 0) + qty;
    if (Object.keys(change).length) await repo.addItems(p.playerId, change);

    p.wishState = { ...p.wishState, [pool]: s };
    p.wishTicket = tickets;
    p.primogem = gems;
    await repo.savePlayerCore(p.playerId, { wishTicket: tickets, primogem: gems, wishState: p.wishState });
    await repo.logWish(p.playerId, pool, results);
    await cache.mirror(p.playerId, p);

    return {
      results: grants,
      // The total, alongside the per-result maps: the panel prints one line under the reveal
      // and the balances in its footer come off `player.inventory`.
      converted: change,
      pity: {
        pity5: s.pity5, pity4: s.pity4, total: s.total,
        // Both guarantees, because the panel prints both: losing the 4★ rate-up is state the
        // player is owed a line about, and it used to be invisible even to the client.
        guaranteed5: s.guaranteed5, guaranteed4: s.guaranteed4,
      },
      player: publicPlayer(p),
      stats: publishStats(p),
    };
  });
}
