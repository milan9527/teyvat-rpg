import { z } from 'zod';
import * as repo from '../db/repo.js';
import { signToken, hashPassword, checkPassword } from '../auth.js';
import { rateLimit } from '../db/redis.js';

const credsSchema = z.object({
  username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_一-龥-]+$/),
  password: z.string().min(4).max(72),
  nickname: z.string().min(1).max(20).optional(),
});

export default async function authRoutes(app) {
  app.post('/api/register', async (req, reply) => {
    const parsed = credsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input', detail: parsed.error.issues[0]?.message });
    const { username, password, nickname } = parsed.data;

    if (!(await rateLimit(`reg:${req.ip}`, 20, 3600))) {
      return reply.code(429).send({ error: 'too_many_requests' });
    }
    const existing = await repo.findAccountByUsername(username);
    if (existing) return reply.code(409).send({ error: 'username_taken' });

    const hash = await hashPassword(password);
    const acc = await repo.createAccount(username, hash, nickname);
    await repo.grantStarterArtifacts(acc.playerId, 5);
    const token = signToken({ accountId: acc.accountId, playerId: acc.playerId, username: acc.username });
    return { token, playerId: acc.playerId, nickname: acc.nickname };
  });

  app.post('/api/login', async (req, reply) => {
    const parsed = credsSchema.omit({ nickname: true }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { username, password } = parsed.data;

    if (!(await rateLimit(`login:${req.ip}`, 40, 600))) {
      return reply.code(429).send({ error: 'too_many_requests' });
    }
    const acc = await repo.findAccountByUsername(username);
    if (!acc || !(await checkPassword(password, acc.password_hash))) {
      return reply.code(401).send({ error: 'bad_credentials' });
    }
    if (acc.banned) return reply.code(403).send({ error: 'banned' });
    await repo.touchLogin(acc.id);
    const token = signToken({ accountId: Number(acc.id), playerId: Number(acc.player_id), username: acc.username });
    return { token, playerId: Number(acc.player_id), nickname: acc.nickname };
  });

  /** Instant play: creates a throwaway guest account so the game is playable with one click. */
  app.post('/api/guest', async (req, reply) => {
    if (!(await rateLimit(`guest:${req.ip}`, 200, 3600))) {
      return reply.code(429).send({ error: 'too_many_requests' });
    }
    const suffix = Math.random().toString(36).slice(2, 8);
    const username = `guest_${suffix}`;
    const hash = await hashPassword(`guest-${suffix}-${Date.now()}`);
    try {
      const acc = await repo.createAccount(username, hash, `旅行者${suffix.slice(0, 4).toUpperCase()}`);
      await repo.grantStarterArtifacts(acc.playerId, 5);
      const token = signToken({ accountId: acc.accountId, playerId: acc.playerId, username, guest: true });
      return { token, playerId: acc.playerId, nickname: acc.nickname, guest: true };
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'guest_failed' });
    }
  });
}
