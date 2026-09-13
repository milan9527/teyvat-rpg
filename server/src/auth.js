import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

export function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiry });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

export async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}

export async function checkPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

/** Fastify preHandler: requires a valid Bearer token. */
export async function requireAuth(req, reply) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.query?.token;
  const claims = token ? verifyToken(token) : null;
  if (!claims) {
    reply.code(401).send({ error: 'unauthorized' });
    return reply;
  }
  req.user = claims;
}
