// Live player-save cache. Keeps one authoritative in-memory copy per online
// player, backed by Postgres and mirrored into Redis for cross-process reads.

import * as repo from '../db/repo.js';
import { redis, RK } from '../db/redis.js';
import { regenResin } from './progression.js';

const live = new Map(); // playerId -> { player, dirty, lastSave }

/**
 * Refresh `target` from `src` without changing its identity: the whole point of this cache
 * is that there is exactly *one* object per online player, and a live `PlayerEntity` holds
 * that object as `entity.save`.
 */
function refreshInPlace(target, src) {
  for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
  Object.assign(target, src);
  return target;
}

export async function getPlayer(playerId, { fresh = false } = {}) {
  const id = Number(playerId);
  const entry = live.get(id) || null;
  if (!fresh && entry) return entry.player;

  // A fresh read must re-read the row but must NOT hand out a different object. The zone
  // simulation reads the save it was given at join: `ZoneInstance.worldLevel()` scales every
  // spawn by `p.save.worldLevel`, and the respawn anchors read `p.save.worldProgress`. While
  // `fresh` replaced the map entry with a newly loaded object, a single mid-dungeon
  // `GET /api/player/state` detached the running shard from the save — floor 5 of 深渊试炼场
  // spawned lv 68 enemies (world level 6) after four clears had already carried the save to
  // world level 7. Same family as the stats/party snapshot fixed on `PlayerEntity.applyBuild`.
  if (fresh && entry?.dirty) await flush(id, true).catch(() => {});

  let player = null;
  if (!fresh) {
    try {
      const hit = await redis().get(RK.player(id));
      if (hit) player = JSON.parse(hit);
    } catch {}
  }
  if (!player) player = await repo.loadPlayer(id);
  if (!player) return null;

  const rr = regenResin(player);
  if (rr.changed) {
    player.resin = rr.resin;
    player.resinAt = rr.resinAt;
    await repo.savePlayerCore(id, { resin: rr.resin, resinAt: rr.resinAt });
  }

  if (entry) {
    player = refreshInPlace(entry.player, player);
    entry.dirty = false;
    entry.lastSave = Date.now();
  } else {
    live.set(id, { player, dirty: false, lastSave: Date.now() });
  }
  await mirror(id, player);
  return player;
}

export function peek(playerId) {
  return live.get(Number(playerId))?.player || null;
}

export async function mirror(playerId, player) {
  try {
    await redis().set(RK.player(Number(playerId)), JSON.stringify(player), 'EX', 300);
  } catch {}
}

export function markDirty(playerId) {
  const e = live.get(Number(playerId));
  if (e) e.dirty = true;
}

export async function flush(playerId, force = false) {
  const id = Number(playerId);
  const e = live.get(id);
  if (!e) return;
  if (!e.dirty && !force) return;
  const p = e.player;
  await repo.savePlayerCore(id, {
    mora: p.mora, primogem: p.primogem, wishTicket: p.wishTicket,
    adventureRank: p.adventureRank, adventureXp: p.adventureXp, worldLevel: p.worldLevel,
    zone: p.zone, pos: p.pos, party: p.party, activeSlot: p.activeSlot,
    wishState: p.wishState, settings: p.settings, stats: p.stats,
    resin: p.resin, playtimeSec: p.playtimeSec,
  });
  for (const inst of Object.values(p.characters)) await repo.upsertCharacter(id, inst);
  e.dirty = false;
  e.lastSave = Date.now();
  await mirror(id, p);
}

export async function release(playerId) {
  const id = Number(playerId);
  await flush(id, true).catch(() => {});
  live.delete(id);
}

export function onlineIds() {
  return [...live.keys()];
}

/** Periodic autosave for everyone online. */
export function startAutosave(intervalMs = 20000) {
  const timer = setInterval(async () => {
    for (const id of [...live.keys()]) {
      try { await flush(id); } catch (e) { console.error('[autosave]', id, e.message); }
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export async function flushAll() {
  for (const id of [...live.keys()]) {
    try { await flush(id, true); } catch {}
  }
}
