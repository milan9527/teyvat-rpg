// Redis layer: hot-state cache, presence, zone rosters, leaderboards, rate limits,
// pub/sub for cross-process chat. Degrades to an in-process map if Redis is down.

import Redis from 'ioredis';
import { config } from '../config.js';

const K = {
  player: (id) => `ty:player:${id}`,
  profile: (id) => `ty:profile:${id}`,
  presence: 'ty:presence',
  zoneRoster: (z) => `ty:zone:${z}:roster`,
  session: (t) => `ty:sess:${t}`,
  lb: 'ty:lb:score',
  lbAbyss: 'ty:lb:abyss',
  lbDamage: 'ty:lb:damage',
  rate: (k) => `ty:rate:${k}`,
  chat: 'ty:chat',
  worldState: (z) => `ty:world:${z}`,
  lock: (k) => `ty:lock:${k}`,
};

class MemoryFallback {
  constructor() { this.map = new Map(); this.z = new Map(); this.h = new Map(); }
  async get(k) { const e = this.map.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { this.map.delete(k); return null; } return e.v; }
  async set(k, v, ...a) {
    let exp = 0;
    const i = a.findIndex((x) => String(x).toUpperCase() === 'EX');
    if (i >= 0) exp = Date.now() + Number(a[i + 1]) * 1000;
    this.map.set(k, { v, exp }); return 'OK';
  }
  async setex(k, s, v) { return this.set(k, v, 'EX', s); }
  async del(...ks) { let n = 0; for (const k of ks) if (this.map.delete(k)) n++; return n; }
  async incr(k) { const v = Number((await this.get(k)) || 0) + 1; await this.set(k, String(v)); return v; }
  async expire(k, s) { const e = this.map.get(k); if (e) e.exp = Date.now() + s * 1000; return 1; }
  async hset(k, ...args) {
    let m = this.h.get(k); if (!m) { m = new Map(); this.h.set(k, m); }
    if (args.length === 1 && typeof args[0] === 'object') { for (const [f, v] of Object.entries(args[0])) m.set(f, String(v)); return 1; }
    for (let i = 0; i < args.length; i += 2) m.set(String(args[i]), String(args[i + 1]));
    return 1;
  }
  async hget(k, f) { return this.h.get(k)?.get(String(f)) ?? null; }
  async hgetall(k) { const m = this.h.get(k); return m ? Object.fromEntries(m) : {}; }
  async hdel(k, ...fs) { const m = this.h.get(k); let n = 0; if (m) for (const f of fs) if (m.delete(String(f))) n++; return n; }
  async hlen(k) { return this.h.get(k)?.size ?? 0; }
  async sadd(k, ...v) { let s = this.map.get(k)?.v; if (!(s instanceof Set)) { s = new Set(); this.map.set(k, { v: s, exp: 0 }); } const b = s.size; v.forEach((x) => s.add(String(x))); return s.size - b; }
  async srem(k, ...v) { const s = this.map.get(k)?.v; if (!(s instanceof Set)) return 0; let n = 0; v.forEach((x) => { if (s.delete(String(x))) n++; }); return n; }
  async smembers(k) { const s = this.map.get(k)?.v; return s instanceof Set ? [...s] : []; }
  async scard(k) { const s = this.map.get(k)?.v; return s instanceof Set ? s.size : 0; }
  async zadd(k, ...args) {
    let z = this.z.get(k); if (!z) { z = new Map(); this.z.set(k, z); }
    for (let i = 0; i < args.length; i += 2) z.set(String(args[i + 1]), Number(args[i]));
    return 1;
  }
  async zrevrange(k, a, b, withScores) {
    const z = this.z.get(k) || new Map();
    const arr = [...z.entries()].sort((x, y) => y[1] - x[1]).slice(a, b === -1 ? undefined : b + 1);
    return withScores ? arr.flatMap(([m, s]) => [m, String(s)]) : arr.map(([m]) => m);
  }
  async zscore(k, m) { const v = this.z.get(k)?.get(String(m)); return v === undefined ? null : String(v); }
  async zrevrank(k, m) {
    const z = this.z.get(k) || new Map();
    const arr = [...z.entries()].sort((x, y) => y[1] - x[1]);
    const i = arr.findIndex(([mm]) => mm === String(m));
    return i < 0 ? null : i;
  }
  async publish() { return 0; }
  async subscribe() { return 0; }
  on() { return this; }
  duplicate() { return this; }
  async ping() { return 'PONG'; }
  async quit() { return 'OK'; }
  get status() { return 'ready'; }
}

let client;
let subscriber;
let usingFallback = false;

function make() {
  const c = new Redis(config.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 250, 2000)),
    enableOfflineQueue: true,
  });
  c.on('error', (e) => {
    if (!usingFallback) console.warn('[redis] error:', e.message);
  });
  return c;
}

try {
  client = make();
} catch (e) {
  console.warn('[redis] falling back to memory:', e.message);
  client = new MemoryFallback();
  usingFallback = true;
}

export async function ensureRedis() {
  try {
    await client.ping();
    console.log('[redis] connected');
    return true;
  } catch (e) {
    console.warn('[redis] unavailable, using in-memory fallback:', e.message);
    try { client.disconnect?.(); } catch {}
    client = new MemoryFallback();
    usingFallback = true;
    return false;
  }
}

export function redis() { return client; }
export function redisIsFallback() { return usingFallback; }
export { K as RK };

/* --------------------------------------------------------------- helpers -- */

export async function cacheJson(key, ttl, producer) {
  try {
    const hit = await client.get(key);
    if (hit) return JSON.parse(hit);
  } catch {}
  const val = await producer();
  try { await client.set(key, JSON.stringify(val), 'EX', ttl); } catch {}
  return val;
}

export async function invalidate(...keys) {
  try { await client.del(...keys); } catch {}
}

export async function setPresence(playerId, info) {
  try {
    await client.hset(K.presence, String(playerId), JSON.stringify({ ...info, at: Date.now() }));
  } catch {}
}

export async function clearPresence(playerId) {
  try { await client.hdel(K.presence, String(playerId)); } catch {}
}

export async function getPresence() {
  try {
    const all = await client.hgetall(K.presence);
    const out = [];
    const stale = [];
    for (const [id, raw] of Object.entries(all)) {
      try {
        const v = JSON.parse(raw);
        if (Date.now() - v.at > 120000) { stale.push(id); continue; }
        out.push({ playerId: Number(id), ...v });
      } catch { stale.push(id); }
    }
    if (stale.length) client.hdel(K.presence, ...stale).catch(() => {});
    return out;
  } catch { return []; }
}

export async function joinZoneRoster(zone, playerId) {
  try { await client.sadd(K.zoneRoster(zone), String(playerId)); } catch {}
}
export async function leaveZoneRoster(zone, playerId) {
  try { await client.srem(K.zoneRoster(zone), String(playerId)); } catch {}
}
export async function zoneRoster(zone) {
  try { return await client.smembers(K.zoneRoster(zone)); } catch { return []; }
}

export async function bumpLeaderboard(playerId, nickname, fields) {
  try {
    if (fields.score !== undefined) await client.zadd(K.lb, fields.score, `${playerId}:${nickname}`);
    if (fields.abyss !== undefined) await client.zadd(K.lbAbyss, fields.abyss, `${playerId}:${nickname}`);
    if (fields.damage !== undefined) {
      const cur = Number(await client.zscore(K.lbDamage, `${playerId}:${nickname}`)) || 0;
      if (fields.damage > cur) await client.zadd(K.lbDamage, fields.damage, `${playerId}:${nickname}`);
    }
  } catch {}
}

export async function topLeaderboard(which = 'score', n = 20) {
  const key = which === 'abyss' ? K.lbAbyss : which === 'damage' ? K.lbDamage : K.lb;
  try {
    const raw = await client.zrevrange(key, 0, n - 1, 'WITHSCORES');
    const out = [];
    for (let i = 0; i < raw.length; i += 2) {
      const [id, ...rest] = String(raw[i]).split(':');
      out.push({ rank: out.length + 1, playerId: Number(id), nickname: rest.join(':'), score: Number(raw[i + 1]) });
    }
    return out;
  } catch { return []; }
}

/** Simple sliding-window rate limit. Returns true when allowed. */
export async function rateLimit(key, limit, windowSec) {
  try {
    const k = K.rate(key);
    const n = await client.incr(k);
    if (n === 1) await client.expire(k, windowSec);
    return n <= limit;
  } catch { return true; }
}

export async function publishChat(msg) {
  try { await client.publish(K.chat, JSON.stringify(msg)); } catch {}
}

export async function subscribeChat(handler) {
  try {
    subscriber = client.duplicate ? client.duplicate() : client;
    if (subscriber === client) return;
    await subscriber.subscribe(K.chat);
    subscriber.on('message', (_ch, raw) => {
      try { handler(JSON.parse(raw)); } catch {}
    });
  } catch {}
}

export async function closeRedis() {
  try { await subscriber?.quit(); } catch {}
  try { await client.quit(); } catch {}
}
