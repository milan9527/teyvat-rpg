// 探索派遣 routes: dispatch a character, wait on the wall clock, collect materials.
//
// Three endpoints and no state of its own beyond the `expeditions` table:
//
//   GET  /api/expeditions          what is in flight, what is claimable, where you may go
//   POST /api/expedition/start     take a slot
//   POST /api/expedition/claim     collect finished trips (one slot, or all of them)
//
// Everything the client needs to *draw* comes from `shared/data/expeditions.js`, which both
// sides import: the destinations, the durations, the payout of a given trip, and the rule that
// says whether a dispatch is allowed (`expeditionEntry`). The route enforces that rule and the
// panel reads it — the split `chamberEntry` argues for at length. What the route adds is the
// two things only the server knows: the clock (`now`), and which rows exist.
//
// The reward is *not* on the row. It is recomputed from the destination and the duration at
// claim time by the same pure function the panel used to promise it, so a payout table edit
// applies to trips already in flight and there is no stored number to drift. A row cannot ask
// for more than its `(dest, hours)` allows, which is also why `dest_id` and `hours` are
// validated on the way in and never trusted on the way out.

import { z } from 'zod';
import { requireAuth } from '../auth.js';
import * as repo from '../db/repo.js';
import * as cache from '../services/playerCache.js';
import { publicPlayer } from './player.js';
import {
  EXPEDITION_HOURS, expeditionEntry, expeditionPayout, expeditionState,
  expeditionSlots, expeditionsFor, nextFreeSlot,
} from '@teyvat/shared/data/expeditions.js';

const startSchema = z.object({
  destId: z.string().min(1).max(40),
  charId: z.string().min(1).max(40),
  // Bound the shape here, not the vocabulary: `expeditionEntry` owns which durations exist
  // (`bad_hours`), so adding a 36-hour trip is a one-line data edit. See the refine-fodder
  // lesson in README — a schema that encodes a rule is a second copy of that rule.
  hours: z.number().int().min(1).max(24 * 7),
});

const claimSchema = z.object({
  // Absent means 一键领取 — every finished trip. A slot number is the per-card button.
  slot: z.number().int().min(0).max(15).optional(),
});

/** The whole payload the panel draws from, including the server's own clock. */
async function snapshot(p, rows) {
  const now = Date.now();
  const owned = Object.keys(p.characters || {});
  return {
    now,
    slots: expeditionSlots(p.adventureRank, owned.length),
    entries: rows.map((r) => ({
      ...r,
      ...expeditionState(r, now),
      payout: expeditionPayout(r.destId, r.hours),
    })),
    // The catalogue is filtered by rank server-side *as well* as in the panel, so a stale tab
    // cannot list 璃月群峰 to an AR-1 account and pretend the button will work.
    destinations: expeditionsFor(p.adventureRank).map((d) => ({
      id: d.id, zone: d.zone, theme: d.theme, name: d.name, hint: d.hint,
      entryRank: d.entryRank,
      payouts: Object.fromEntries(EXPEDITION_HOURS.map((h) => [h, expeditionPayout(d, h)])),
    })),
    hours: EXPEDITION_HOURS,
  };
}

export default async function expeditionRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/expedition')) return;
    return requireAuth(req, reply);
  });

  app.get('/api/expeditions', async (req, reply) => {
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });
    const rows = await repo.listExpeditions(p.playerId);
    return snapshot(p, rows);
  });

  app.post('/api/expedition/start', async (req, reply) => {
    const parsed = startSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { destId, charId, hours } = parsed.data;
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });

    const rows = await repo.listExpeditions(p.playerId);
    const entry = expeditionEntry(destId, charId, hours, {
      adventureRank: p.adventureRank,
      owned: Object.keys(p.characters || {}),
      rows,
    });
    if (!entry.ok) {
      const code = entry.error === 'no_such_expedition' ? 404
        : entry.error === 'bad_hours' ? 400 : 403;
      return reply.code(code).send({ error: entry.error, ...(entry.need ? { need: entry.need } : {}) });
    }

    const slot = nextFreeSlot(rows, entry.slots);
    // `entry.ok` already proved a slot is free by count; this is the *index*, and a -1 here
    // would mean the two disagree — refuse rather than insert over somebody's row.
    if (slot < 0) return reply.code(403).send({ error: 'no_free_slot' });
    const row = await repo.startExpedition(p.playerId, { slot, charId, destId, hours });
    // Lost the race: another request took this slot or this character between the read and the
    // insert. The client's next GET shows the truth, so answer with the code it already knows.
    if (!row) return reply.code(409).send({ error: 'character_busy' });

    const after = await repo.listExpeditions(p.playerId);
    return { started: { ...row, ...expeditionState(row), payout: expeditionPayout(destId, hours) },
      ...(await snapshot(p, after)) };
  });

  app.post('/api/expedition/claim', async (req, reply) => {
    const parsed = claimSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });

    // The DELETE is the arbiter: it only removes rows whose time is actually up, and the
    // caller pays for exactly the rows it removed. Nothing is read first to decide.
    const slots = parsed.data.slot === undefined ? null : [parsed.data.slot];
    const done = await repo.claimExpeditions(p.playerId, slots);
    if (!done.length) {
      // Distinguish the two "nothing happened" cases the panel words differently: a card that
      // is still counting down, versus a 领取 pressed with nothing to collect.
      const rows = await repo.listExpeditions(p.playerId);
      const pending = slots ? rows.filter((r) => slots.includes(r.slot)) : rows;
      const code = pending.length ? 'not_finished' : 'nothing_to_claim';
      return reply.code(code === 'not_finished' ? 409 : 400).send({ error: code });
    }

    const items = {};
    for (const row of done) {
      for (const [k, v] of Object.entries(expeditionPayout(row.destId, row.hours))) {
        items[k] = (items[k] || 0) + v;
      }
    }
    await repo.addItems(p.playerId, items);
    for (const [k, v] of Object.entries(items)) p.inventory[k] = (p.inventory[k] || 0) + v;
    await cache.mirror(p.playerId, p);

    const rows = await repo.listExpeditions(p.playerId);
    return { took: done, items, ...(await snapshot(p, rows)), player: publicPlayer(p) };
  });
}
