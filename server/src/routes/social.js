// Friends: the persistent half of multiplayer.
//
// Everything else about co-op in this game is ephemeral — `/api/online` is whoever
// happens to be connected right now, a party lives in `WorldManager.parties` and dies
// with the process, and a zone chat line scrolls away. So the only way to play with
// somebody was to catch them in the same shard at the same minute and know their
// numeric player id. The `friends` table has been in `schema.sql` since the first
// migration and nothing ever wrote to it.
//
// The graph is stored two rows per accepted friendship, one per pending request; see
// `repo.friendsOf`. What this file adds on top is the presence join (a friend list is
// useless without "online, in 蒙德平原"), the guardrails, and the shard hint that lets
// the client ask the gateway to drop it into a friend's world.
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import * as repo from '../db/repo.js';
import { getPresence, rateLimit } from '../db/redis.js';
import { world } from '../world/manager.js';

/** Genshin's cap is 45; the number matters only as a bound on the list a panel renders. */
const MAX_FRIENDS = 50;

/**
 * Count a new friendship for both sides' 成就 tally.
 *
 * A lifetime tally rather than `count(friends)` on purpose: achievement progress has to be
 * monotone, and a live count would drop the moment somebody was removed — un-earning 「并肩」
 * for a player who had not collected it yet. Both ids are bumped because `acceptFriend` writes
 * both directions; a friendship is something two people did.
 */
async function tallyFriendship(a, b) {
  await Promise.all([
    repo.bumpLifetime(a, 'friendsMade', 1),
    repo.bumpLifetime(b, 'friendsMade', 1),
  ]);
}

/**
 * Presence, keyed by playerId, with the shard a client would have to join to stand
 * next to them.
 *
 * Redis presence is the source of truth for *who* is online because it survives a
 * server restart mid-session and is shared across processes. The shard, though, comes
 * from the live `WorldManager` when this process happens to be hosting them: Redis
 * records the shard name at join time, and a player who has changed zone since then
 * has a stale one. `world.livePos` is authoritative and free.
 */
async function presenceMap() {
  const rows = await getPresence();
  const m = new Map();
  for (const p of rows) {
    const live = world.livePos(p.playerId);
    const inst = live ? world.instanceOf(p.playerId) : null;
    m.set(Number(p.playerId), {
      online: true,
      zone: inst?.zoneId || p.zone || null,
      shard: inst ? String(inst.shard) : (p.shard ?? null),
      // Two different facts, and conflating them cost co-op 秘境 its only entry point.
      // `private` is a property of the shard: a 单机 session or a 秘境 run, which no
      // *stranger* can be dropped into. `solo` is a property of the player: they asked
      // for single-player, their simulation runs in their browser, and nobody at all can
      // join them. A teammate can follow into the first and never into the second, and
      // the client needs to know which before it offers a button it cannot honour.
      private: inst ? String(inst.shard).startsWith('p') : String(p.shard ?? '').startsWith('p'),
      solo: !!p.solo,
      party: world.partyOf.get(Number(p.playerId)) || null,
      adventureRank: p.adventureRank ?? null,
    });
  }
  return m;
}

const view = (row, pres, myParty = null) => ({
  playerId: Number(row.player_id),
  nickname: row.nickname,
  adventureRank: pres?.adventureRank ?? row.adventure_rank ?? 1,
  // Offline friends still get a zone — the one they logged out in, which is what the
  // panel shows greyed out. It is `players.zone`, written on every zone change.
  zone: pres?.zone || row.zone || null,
  shard: pres?.shard ?? null,
  online: !!pres,
  // Who the client may offer a "join them" button for. A public shard: any friend. A
  // private one (a 秘境 run): only a teammate, which is what makes co-op dungeons
  // reachable at all — the gateway applies the same rule to the JOIN_ZONE that follows.
  // A 单机 friend: nobody, ever.
  joinable: !!pres && !pres.solo && (!pres.private || (!!myParty && myParty === pres.party)),
  // So the panel can say *why* a row has no button, and label the one it does have: a
  // 秘境 is not "Ta的世界".
  private: !!pres?.private,
  since: row.at ?? null,
});

export default async function socialRoutes(app) {
  app.register(async (inner) => {
    inner.addHook('preHandler', requireAuth);

    /** The whole panel in one request: friends, requests received, requests sent. */
    inner.get('/api/social/friends', async (req) => {
      const me = req.user.playerId;
      const [rows, incoming, pres] = await Promise.all([
        repo.friendsOf(me), repo.friendRequestsTo(me), presenceMap(),
      ]);
      const friends = [], outgoing = [];
      // Whether a friend's private shard is joinable depends on *who is asking*, so the
      // viewer's party comes into the row.
      const myParty = world.partyOf.get(Number(me)) || null;
      for (const r of rows) {
        // A row on *my* side that is still pending is a request I sent: `addFriendRequest`
        // writes only the requester's direction, and `acceptFriend` flips both.
        (r.state === 'accepted' ? friends : outgoing)
          .push(view(r, pres.get(Number(r.player_id)), myParty));
      }
      return {
        friends, outgoing, max: MAX_FRIENDS,
        incoming: incoming.map((r) => view(r, pres.get(Number(r.player_id)), myParty)),
      };
    });

    /**
     * Send a friend request, by nickname (what a player can actually read off a chat
     * line or a leaderboard row) or by id (what the online list and party roster carry).
     */
    inner.post('/api/social/request', async (req, reply) => {
      const schema = z.object({
        playerId: z.coerce.number().int().positive().optional(),
        nickname: z.string().min(1).max(40).optional(),
      }).refine((v) => v.playerId || v.nickname, 'need a target');
      const parsed = schema.safeParse(req.body || {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const me = req.user.playerId;

      // Spam guard before the lookups: a request costs the recipient a notification.
      if (!(await rateLimit(`friendreq:${me}`, 20, 300))) {
        return reply.code(429).send({ error: 'too_many_requests' });
      }

      const target = parsed.data.playerId
        ? await repo.playerProfile(parsed.data.playerId)
        : await repo.findPlayerByNickname(parsed.data.nickname);
      if (!target) return reply.code(404).send({ error: 'no_such_player' });
      const otherId = Number(target.playerId ?? target.id);
      if (otherId === Number(me)) return reply.code(400).send({ error: 'not_yourself' });

      const [mine, theirs] = await Promise.all([
        repo.friendEdge(me, otherId), repo.friendEdge(otherId, me),
      ]);
      if (mine?.state === 'accepted') return reply.code(409).send({ error: 'already_friends' });
      if (mine?.state === 'pending') return reply.code(409).send({ error: 'request_pending' });
      // They asked first and I am now asking back: that is consent from both sides, so
      // accept instead of leaving two pending requests neither player can clear.
      if (theirs?.state === 'pending') {
        await repo.acceptFriend(me, otherId);
        await tallyFriendship(me, otherId);
        return { state: 'accepted', playerId: otherId, nickname: target.nickname };
      }
      if (await repo.countFriends(me) >= MAX_FRIENDS) {
        return reply.code(409).send({ error: 'friends_full', max: MAX_FRIENDS });
      }
      await repo.addFriendRequest(me, otherId);
      return { state: 'pending', playerId: otherId, nickname: target.nickname };
    });

    inner.post('/api/social/accept', async (req, reply) => {
      const parsed = z.object({ playerId: z.coerce.number().int().positive() }).safeParse(req.body || {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const me = req.user.playerId;
      const otherId = parsed.data.playerId;
      if (await repo.countFriends(me) >= MAX_FRIENDS) {
        return reply.code(409).send({ error: 'friends_full', max: MAX_FRIENDS });
      }
      // `acceptFriend` only flips a row that is actually pending, so this is also the
      // check against accepting a request that was withdrawn a moment ago.
      if (!(await repo.acceptFriend(me, otherId))) {
        return reply.code(404).send({ error: 'no_request' });
      }
      await tallyFriendship(me, otherId);
      return { state: 'accepted', playerId: otherId };
    });

    /** Remove a friend, decline a request, or withdraw one: all the same delete. */
    inner.post('/api/social/remove', async (req, reply) => {
      const parsed = z.object({ playerId: z.coerce.number().int().positive() }).safeParse(req.body || {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const removed = await repo.removeFriend(req.user.playerId, parsed.data.playerId);
      if (!removed) return reply.code(404).send({ error: 'not_found' });
      return { removed: true, playerId: parsed.data.playerId };
    });
  });
}
