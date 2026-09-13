// Mail routes: read the box, take what is attached, throw the letter away.
//
// The only structural idea here is `ensureMail`: **opening the mailbox is the scheduler.**
// Every request first tries to insert the letters the current period is owed — today's
// sign-in gift, this week's ladder payout — and the partial unique index on
// `(player_id, dedupe)` makes those inserts no-ops on the second call. A player who is away
// for a week does not get seven letters when they come back, because the six keys that
// elapsed are never asked for; they get today's. That is the point of keying on the period
// instead of counting days: mail cannot pile up in a queue nobody drains.
//
// Claiming is guarded in SQL rather than in JS (`repo.claimMail` flips `claimed=false` rows
// and returns only what it actually flipped), so two clicks racing each other pay once.

import { z } from 'zod';
import { requireAuth } from '../auth.js';
import * as repo from '../db/repo.js';
import * as cache from '../services/playerCache.js';
import { publicPlayer, publishStats } from './player.js';
// `isCurrency` lives in the shop catalogue because that is where the column-vs-row split was
// first written down; importing it keeps one list of which item ids are player columns.
import { isCurrency } from '@teyvat/shared/data/shop.js';
import {
  loginMail, boardMail, MAIL_TTL_DAYS, MAIL_CAP, attachLines,
} from '@teyvat/shared/data/mail.js';

const idsSchema = z.object({
  ids: z.array(z.number().int().positive()).max(MAIL_CAP).optional(),
});

/**
 * Materialise whatever the current period owes this player. Returns the letters created, so
 * the caller can tell the client "1 new" without diffing the box.
 */
async function ensureMail(playerId) {
  const fresh = [];
  const daily = await repo.insertMail(playerId, loginMail(), MAIL_TTL_DAYS);
  if (daily) fresh.push(daily);

  // The ladder payout reads the board, so it costs a query — but only for a player who has
  // ever scored, and `insertMail` short-circuits on the dedupe key for the rest of the week.
  const board = await repo.boardRank(playerId);
  if (board) {
    const letter = boardMail(board.rank, board.score);
    if (letter) {
      const made = await repo.insertMail(playerId, letter, MAIL_TTL_DAYS);
      if (made) fresh.push(made);
    }
  }
  // Both of these only run on the request that actually delivered something, which is at most
  // once per period — so the mailbox has no maintenance path that costs a normal read anything.
  if (fresh.length) {
    await repo.trimMailbox(playerId, MAIL_CAP);
    await repo.purgeExpiredMail(playerId);
  }
  return fresh;
}

function counts(box) {
  return {
    total: box.length,
    unread: box.filter((m) => !m.seen).length,
    claimable: box.filter((m) => !m.claimed && attachLines(m.attach).length).length,
  };
}

export default async function mailRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/mail')) return;
    return requireAuth(req, reply);
  });

  app.get('/api/mail', async (req, reply) => {
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });
    const fresh = await ensureMail(p.playerId);
    const box = await repo.mailbox(p.playerId, MAIL_CAP);
    return { mail: box, fresh: fresh.map((m) => m.id), ...counts(box), now: Date.now() };
  });

  app.post('/api/mail/claim', async (req, reply) => {
    const parsed = idsSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });

    // `ids` absent means 一键领取. Passing null through to the repo (rather than expanding the
    // box into a list here) keeps the "which rows are still unclaimed" decision in the one
    // UPDATE that also flips them.
    const taken = await repo.claimMail(p.playerId, parsed.data.ids ?? null);
    if (!taken.length) return reply.code(400).send({ error: 'nothing_to_claim' });

    // Fold every attachment into one delta before touching the database: claiming ten
    // letters that each carry mora must be one column write, not ten.
    const corePatch = {};
    const itemDelta = {};
    const gained = {};
    for (const t of taken) {
      for (const [id, qty] of Object.entries(t.attach || {})) {
        if (!(qty > 0)) continue;
        gained[id] = (gained[id] || 0) + qty;
        if (isCurrency(id)) { p[id] = (p[id] || 0) + qty; corePatch[id] = p[id]; }
        else {
          itemDelta[id] = (itemDelta[id] || 0) + qty;
          p.inventory[id] = (p.inventory[id] || 0) + qty;
        }
      }
    }
    if (Object.keys(corePatch).length) await repo.savePlayerCore(p.playerId, corePatch);
    if (Object.keys(itemDelta).length) await repo.addItems(p.playerId, itemDelta);
    await cache.mirror(p.playerId, p);

    const box = await repo.mailbox(p.playerId, MAIL_CAP);
    return {
      claimed: taken.map((t) => t.id), gained, lines: attachLines(gained),
      mail: box, ...counts(box),
      player: publicPlayer(p), stats: publishStats(p),
    };
  });

  app.post('/api/mail/seen', async (req, reply) => {
    const parsed = idsSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const n = await repo.markMailSeen(req.user.playerId, parsed.data.ids ?? null);
    const box = await repo.mailbox(req.user.playerId, MAIL_CAP);
    return { seen: n, ...counts(box) };
  });

  app.post('/api/mail/delete', async (req, reply) => {
    const parsed = idsSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    // The repo refuses to bin an unclaimed letter that still has something on it, and the bin
    // is a flag rather than a DELETE — dropping the row would also drop the dedupe receipt and
    // let the next GET re-mint the gift. A 清空 that printed primogems, or that silently threw
    // away an unopened reward, are the two worst bugs this module could have; both guards live
    // next to the statement rather than in the UI that calls it.
    const gone = await repo.deleteMail(req.user.playerId, parsed.data.ids ?? null);
    const box = await repo.mailbox(req.user.playerId, MAIL_CAP);
    return { deleted: gone, kept: box.length, ...counts(box) };
  });
}
