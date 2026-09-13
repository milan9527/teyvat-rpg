// Shop routes: browse the catalogue, buy from it.
//
// Two decisions that shape the whole file:
//
//  * **Stock is never read from the player cache.** `cache.getPlayer` is a Redis mirror that
//    can outlive a period boundary; a limit checked against it would still say "sold out
//    today" after today ended. So every request re-reads `shop_purchases` and resolves it
//    against `periodKey(now)`.
//  * **A buy clamps, it does not reject.** Asking for 5 when 2 are affordable buys 2 and
//    reports what happened, matching `/api/player/cook`. The client's own arithmetic can be
//    a frame stale — a race with a mora-spending action elsewhere should cost the player a
//    smaller purchase, not an error dialog.

import { z } from 'zod';
import { requireAuth } from '../auth.js';
import * as repo from '../db/repo.js';
import * as cache from '../services/playerCache.js';
import { publicPlayer, publishStats } from './player.js';
import { makeWeapon } from '@teyvat/shared/sim/loot.js';
import {
  SHOPS, shopEntry, shopView, entryGrant, entryCost, maxBuyable, isCurrency, held,
} from '@teyvat/shared/data/shop.js';
import { periodKey, periodEndsAt } from '@teyvat/shared/sim/clock.js';

const buySchema = z.object({
  entryId: z.string().min(1).max(64),
  count: z.number().int().min(1).max(99).default(1),
});

export default async function shopRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/shop')) return;
    return requireAuth(req, reply);
  });

  app.get('/api/shop', async (req, reply) => {
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });
    const purchases = await repo.shopPurchases(p.playerId);
    const now = Date.now();
    return { shops: shopView(p, purchases, now), now };
  });

  app.post('/api/shop/buy', async (req, reply) => {
    const parsed = buySchema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { entryId, count } = parsed.data;

    const entry = shopEntry(entryId);
    if (!entry) return reply.code(404).send({ error: 'no_entry' });
    const grant = entryGrant(entry);
    if (!grant) return reply.code(500).send({ error: 'bad_entry' });

    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });

    const shop = SHOPS[entry.shopId];
    if ((shop.minRank ?? 0) > p.adventureRank) {
      return reply.code(400).send({ error: 'shop_locked', minRank: shop.minRank });
    }
    if ((entry.minRank ?? 0) > p.adventureRank) {
      return reply.code(400).send({ error: 'rank_too_low', minRank: entry.minRank });
    }

    const now = Date.now();
    const key = periodKey(entry.period, now);
    const purchases = await repo.shopPurchases(p.playerId);
    const rec = purchases[entryId];
    const bought = rec && rec.period === key ? rec.bought : 0;

    const n = maxBuyable(entry, p, bought, count);
    if (n <= 0) {
      // Two different "no": out of stock for the period, or short on the goods. The client
      // shows different text for each, so the reason has to survive the round trip.
      const soldOut = entry.limit && bought >= entry.limit;
      return reply.code(400).send({
        error: soldOut ? 'sold_out' : 'not_enough',
        need: entryCost(entry, 1),
        have: Object.fromEntries(Object.keys(entry.cost).map((id) => [id, held(p, id)])),
        left: entry.limit ? Math.max(0, entry.limit - bought) : null,
      });
    }

    // Spend. Currencies are columns and materials are inventory rows, so the cost map is
    // split before it is applied — `addItems` knows the difference, but `savePlayerCore`
    // is the only thing that can write a column, and the mirror must match both.
    const cost = entryCost(entry, n);
    const corePatch = {};
    const itemDelta = {};
    for (const [id, qty] of Object.entries(cost)) {
      if (isCurrency(id)) { p[id] -= qty; corePatch[id] = p[id]; }
      else { itemDelta[id] = -qty; p.inventory[id] = (p.inventory[id] || 0) - qty; }
    }

    // Grant.
    const gained = [];
    if (grant.kind === 'weapon') {
      for (let i = 0; i < n * grant.count; i++) {
        const w = makeWeapon(grant.id, 1);
        await repo.addEquipment(p.playerId, w);
        p.equipment.push({ ...w, equippedBy: null });
        gained.push({ kind: 'weapon', id: grant.id, uid: w.uid });
      }
    } else if (isCurrency(grant.id)) {
      p[grant.id] += grant.count * n;
      corePatch[grant.id] = p[grant.id];
      gained.push({ kind: 'currency', id: grant.id, count: grant.count * n });
    } else {
      itemDelta[grant.id] = (itemDelta[grant.id] || 0) + grant.count * n;
      p.inventory[grant.id] = (p.inventory[grant.id] || 0) + grant.count * n;
      gained.push({ kind: 'item', id: grant.id, count: grant.count * n });
    }

    if (Object.keys(corePatch).length) await repo.savePlayerCore(p.playerId, corePatch);
    if (Object.keys(itemDelta).length) await repo.addItems(p.playerId, itemDelta);
    const stock = await repo.bumpShopPurchase(p.playerId, entryId, n, key);
    await cache.mirror(p.playerId, p);

    return {
      bought: n, requested: count, spent: cost, gained,
      entry: {
        id: entry.id, bought: stock.bought,
        left: entry.limit ? Math.max(0, entry.limit - stock.bought) : null,
        resetsAt: periodEndsAt(entry.period, now),
        canBuy: maxBuyable(entry, p, stock.bought),
      },
      player: publicPlayer(p),
      stats: publishStats(p),
    };
  });
}
