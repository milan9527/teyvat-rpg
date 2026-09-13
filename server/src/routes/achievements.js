// 成就 routes: read a derived snapshot, pay for the tiers it has earned.
//
// There is no progress endpoint because there is no stored progress — `GET /api/achievements`
// runs `repo.achSnapshot` (a handful of aggregates over tables that were already being
// written) and hands the numbers over next to `{ achId: tier }`, the only thing this module
// stores. The thresholds are compared on both sides: the client imports the same catalogue and
// computes the same bars, so the panel does not need a second wire format for "how far along".
//
// Claiming is priced from the *server's* snapshot and guarded by `WHERE tier < $3` inside the
// UPDATE, so a request cannot name its own reward and two clicks racing each other pay once.
// A player who somehow reached tier 3 without ever collecting tier 1 is paid for all three at
// once — tiers are a high-water mark, not a queue, and skipping is normal for a save that
// predates this file.

import { z } from 'zod';
import { requireAuth } from '../auth.js';
import * as repo from '../db/repo.js';
import * as cache from '../services/playerCache.js';
import { publicPlayer, publishStats } from './player.js';
import {
  ACHIEVEMENTS, ACH_BY_ID, achState, achSummary, tierGems,
} from '@teyvat/shared/data/achievements.js';

const claimSchema = z.object({
  // Absent means 一键领取. A single id is the normal path; the panel's per-row button.
  id: z.string().min(1).max(40).optional(),
});

export default async function achievementRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/achievements')) return;
    return requireAuth(req, reply);
  });

  app.get('/api/achievements', async (req, reply) => {
    const [progress, claimed] = await Promise.all([
      repo.achSnapshot(req.user.playerId),
      repo.achClaimed(req.user.playerId),
    ]);
    if (!progress) return reply.code(404).send({ error: 'no_player' });
    return { progress, claimed, summary: achSummary(progress, claimed), now: Date.now() };
  });

  app.post('/api/achievements/claim', async (req, reply) => {
    const parsed = claimSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    if (parsed.data.id && !ACH_BY_ID[parsed.data.id]) {
      return reply.code(404).send({ error: 'no_such_achievement' });
    }
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });

    const progress = await repo.achSnapshot(p.playerId);
    const claimed = await repo.achClaimed(p.playerId);
    const wanted = parsed.data.id ? [ACH_BY_ID[parsed.data.id]] : ACHIEVEMENTS;

    const took = [];
    let gems = 0;
    for (const a of wanted) {
      const st = achState(a, progress, claimed[a.id] || 0);
      if (st.claimable <= 0) continue;
      // The UPDATE is the arbiter: it returns null when another request already moved this row
      // to the same tier, and the reward is only counted for the caller that moved it.
      const to = await repo.claimAchTier(p.playerId, a.id, st.earned);
      if (to === null) continue;
      const from = st.claimed;
      let pay = 0;
      for (let i = from; i < to; i++) pay += tierGems(i);
      gems += pay;
      claimed[a.id] = to;
      took.push({ id: a.id, name: a.name, from, to, primogem: pay, target: a.targets[to - 1] });
    }
    if (!took.length) return reply.code(400).send({ error: 'nothing_to_claim' });

    p.primogem += gems;
    await repo.savePlayerCore(p.playerId, { primogem: p.primogem });
    await cache.mirror(p.playerId, p);

    return {
      took, gained: { primogem: gems },
      progress, claimed, summary: achSummary(progress, claimed),
      player: publicPlayer(p), stats: publishStats(p),
    };
  });
}
