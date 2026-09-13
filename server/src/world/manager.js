// Zone manager: routes players into sharded zone instances, applies loot/quest
// side effects, and owns the connection registry.

import { ZoneInstance } from '@teyvat/shared/world/zoneInstance.js';
import { ZONES, heightAt } from '@teyvat/shared/data/zones.js';
import { S2C, MAX_PLAYERS_PER_ZONE } from '@teyvat/shared/protocol.js';
import * as repo from '../db/repo.js';
import * as cache from '../services/playerCache.js';
import * as prog from '../services/progression.js';
import { joinZoneRoster, leaveZoneRoster, setPresence, clearPresence, bumpLeaderboard } from '../db/redis.js';

/**
 * A cheap fingerprint of "which numbers is this player fighting with".
 *
 * FNV-1a over the derived stat block and the roster: any change anywhere in the block
 * (a talent level, one artifact substat, a set going from 2 to 4 pieces) moves it, and an
 * unchanged build hashes to the same value on every request.
 */
function buildSignature(stats, party) {
  const s = `${(party || []).join(',')}|${JSON.stringify(stats)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class WorldManager {
  constructor() {
    this.instances = new Map();  // key -> ZoneInstance
    this.conns = new Map();      // playerId -> { socket, instanceKey, player }
    this.parties = new Map();    // partyId -> Set<playerId>
    this.partyOf = new Map();    // playerId -> partyId
    this.partyLeader = new Map(); // partyId -> playerId whose name the party's shards carry
    this.solo = new Set();       // playerIds who requested a private (single-player) shard
  }

  /**
   * Whose name a private shard carries.
   *
   * A dungeon is always a private instance — nobody wants a stranger walking into their
   * 秘境 run — but "private" is not "alone": a party has to land in *one* instance or
   * co-op 秘境 does not exist. So the owner is the party's recorded leader, which is the
   * one player every member agrees on. It used to be `[...members][0]`, the Set's
   * insertion order, and that is only the leader until the leader leaves and rejoins.
   *
   * A player who asked for 单机 is keyed on themselves whatever party they are in:
   * their simulation runs in their own browser and the flag means "alone".
   */
  privateShardOwner(playerId, { solo = false } = {}) {
    const id = Number(playerId);
    if (solo) return id;
    const partyId = this.partyOf.get(id);
    const leader = partyId ? this.partyLeader.get(partyId) : null;
    return Number(leader ?? id);
  }

  hooks() {
    return {
      broadcast: (inst, events) => this.broadcastEvents(inst, events),
      sendTo: (playerId, msg) => this.sendTo(playerId, msg),
      // Every argument the sim sends is forwarded, `opts` included: this wrapper listed its
      // parameters one by one and silently dropped the `{ assist }` the sim had started
      // sending, so co-op helpers were paid and never told why. A hook is a wire.
      onKill: (...args) => this.handleKill(...args),
      onChamberClear: (inst, floor, time, stars) => this.handleChamberClear(inst, floor, time, stars),
    };
  }

  /** Pick or create a shard for a zone. Solo players always get a private shard. */
  pickInstance(zoneId, playerId, { solo = false, preferShard = null } = {}) {
    if (!ZONES[zoneId]) zoneId = 'mondstadt';
    const isDungeon = ZONES[zoneId].kind === 'dungeon';
    // A resolved shard wins over matchmaking, private or public. `preferShard` is only ever
    // set by the co-op follow path, which has already checked *who* is allowed in there
    // (friends, and for a private shard the same party) — and it has to be honoured for
    // private shards too, or following a teammate into their 秘境 would compute a shard
    // name of its own and open a second, empty copy of the dungeon next door.
    if (preferShard !== null) {
      const key = `${zoneId}#${preferShard}`;
      const inst = this.instances.get(key);
      if (inst && inst.players.size < MAX_PLAYERS_PER_ZONE) return inst;
    }
    if (solo || isDungeon) {
      const shard = `p${this.privateShardOwner(playerId, { solo })}`;
      return this.getOrCreate(zoneId, shard, `${zoneId}#${shard}`);
    }
    // Find the fullest shard that still has room (keeps players together).
    let best = null;
    for (const inst of this.instances.values()) {
      if (inst.zoneId !== zoneId) continue;
      if (String(inst.shard).startsWith('p')) continue;
      if (inst.players.size >= MAX_PLAYERS_PER_ZONE) continue;
      if (!best || inst.players.size > best.players.size) best = inst;
    }
    if (best) return best;
    let shard = 0;
    while (this.instances.has(`${zoneId}#${shard}`)) shard++;
    return this.getOrCreate(zoneId, shard, `${zoneId}#${shard}`);
  }

  getOrCreate(zoneId, shard, key) {
    let inst = this.instances.get(key);
    if (!inst) {
      inst = new ZoneInstance(zoneId, shard, this.hooks());
      inst.key = key;
      this.instances.set(key, inst);
    }
    return inst;
  }

  async join(playerId, socket, save, stats, { solo = false, zoneId = null, at = null, preferShard = null } = {}) {
    await this.leave(playerId, { keepSocket: true });
    const zone = zoneId || save.zone || 'mondstadt';
    // Destination is applied *after* the leave, never before: leaving persists the
    // player's current live position into `save.pos`, so a destination written by
    // the caller first gets silently overwritten — which used to drop every fast
    // travel and every dungeon entry at wherever the player happened to be standing.
    if (at && Number.isFinite(at.x) && Number.isFinite(at.z)) {
      const zdef = ZONES[zone];
      save.zone = zone;
      save.pos = {
        x: at.x, z: at.z, ry: at.ry ?? save.pos?.ry ?? 0,
        y: (zdef ? heightAt(zdef, at.x, at.z) : 0) + 1.2,
      };
      const live = cache.peek(Number(playerId));
      if (live) { live.pos = save.pos; live.zone = zone; cache.markDirty(playerId); }
    }
    // `preferShard` is how "join my friend's world" is expressed: the caller has
    // already resolved which shard the friend is standing in, and `pickInstance` only
    // honours it while that shard still has room — otherwise the usual matchmaking
    // applies and the player lands somewhere they can actually fit.
    const inst = this.pickInstance(zone, playerId, { solo, preferShard });
    const entity = inst.addPlayer(playerId, save.nickname, save, stats);
    this.conns.set(Number(playerId), { socket, instanceKey: inst.key, player: entity });
    if (solo) this.solo.add(Number(playerId)); else this.solo.delete(Number(playerId));

    await joinZoneRoster(inst.zoneId, playerId);
    await setPresence(playerId, {
      nickname: save.nickname, zone: inst.zoneId, shard: String(inst.shard),
      adventureRank: save.adventureRank, solo,
    });

    // Tell others.
    this.broadcastEvents(inst, [{ t: S2C.PLAYER_JOIN, d: { player: entity.serialize() } }], playerId);
    return { inst, entity };
  }

  /**
   * The player's authoritative position, if they are in a live shard.
   *
   * HTTP routes need this for reach checks: the *saved* `pos` is only written when
   * the player leaves a zone, so validating "are you actually next to this ore
   * node" against the save would reject every gather made during a session.
   * Returns null when the player has no live entity, which callers must treat as
   * "unknown" rather than "far away" — an offline-ish HTTP-only client is a
   * supported way to play.
   */
  livePos(playerId) {
    const conn = this.conns.get(Number(playerId));
    const p = conn?.player;
    if (!p) return null;
    return { x: p.x, y: p.y, z: p.z, zone: this.instances.get(conn.instanceKey)?.zoneId };
  }

  async leave(playerId, { keepSocket = false } = {}) {
    const id = Number(playerId);
    const conn = this.conns.get(id);
    if (!conn) return;
    const inst = this.instances.get(conn.instanceKey);
    if (inst) {
      const p = inst.players.get(id);
      if (p) {
        // Persist position. `p.save` *is* the cached save object — `playerCache.getPlayer`
        // keeps one object per online player and refreshes it in place — so this write lands
        // in the copy the autosave flushes.
        const save = cache.peek(id) || p.save;
        save.pos = { x: p.x, y: p.y, z: p.z, ry: p.ry };
        save.zone = inst.zoneId;
        cache.markDirty(id);
      }
      inst.removePlayer(id);
      this.broadcastEvents(inst, [{ t: S2C.PLAYER_LEAVE, d: { playerId: id } }]);
      if (inst.empty) { inst.stop(); this.instances.delete(conn.instanceKey); }
      await leaveZoneRoster(inst.zoneId, id);
    }
    if (!keepSocket) {
      this.conns.delete(id);
      await clearPresence(id);
      await cache.flush(id, true).catch(() => {});
    }
  }

  instanceOf(playerId) {
    const conn = this.conns.get(Number(playerId));
    return conn ? this.instances.get(conn.instanceKey) : null;
  }

  entityOf(playerId) {
    const inst = this.instanceOf(playerId);
    return inst ? inst.players.get(Number(playerId)) : null;
  }

  /**
   * Push a build the player just changed over HTTP into the running fight.
   *
   * Called from `publishStats` in `routes/player.js`, which is the one function every
   * route that touches a build goes through — see the comment there for why this is not
   * the caller's job to remember. `stats` is the freshly derived block and `party` the
   * saved roster; both are ignored when the player has no live entity (an HTTP-only
   * client is a supported way to play).
   *
   * The signature check is not an optimisation detail: `GET /api/player/state` and every
   * shop/mail/achievement response also derive stats, and pushing a full stat blob down
   * the socket each time would be several kilobytes per panel open for a build that did
   * not change.
   */
  refreshBuild(playerId, stats, party = null, { heal = 0, levels = null } = {}) {
    const id = Number(playerId);
    const entity = this.entityOf(id);
    if (!entity || !stats) return null;
    const sig = buildSignature(stats, party?.length ? party : entity.party);
    if (sig === entity.buildSig && !levels?.length) return null;
    entity.buildSig = sig;
    const res = entity.applyBuild(stats, party, { heal });
    this.sendTo(id, {
      t: S2C.PLAYER_ACTION,
      d: {
        playerId: id, action: 'statsRefresh', stats,
        party: res.party, charId: res.charId,
        hp: Math.round(entity.hp), maxHp: res.maxHp,
        levels: levels || [],
      },
    });
    // Dropping the character you were controlling is a visible event for everyone else in
    // the shard: their copy of this player is wearing the wrong model until they hear it.
    if (res.switched) {
      const inst = this.instanceOf(id);
      if (inst) {
        this.broadcastEvents(inst, [{
          t: S2C.PLAYER_ACTION, d: { playerId: id, action: 'switch', charId: res.charId },
        }], id);
      }
      const live = cache.peek(id);
      if (live) {
        live.activeSlot = Math.max(0, res.party.indexOf(res.charId));
        cache.markDirty(id);
      }
    }
    return res;
  }

  sendTo(playerId, msg) {
    const conn = this.conns.get(Number(playerId));
    if (!conn?.socket) return;
    try {
      if (conn.socket.readyState === 1) conn.socket.send(JSON.stringify(msg));
    } catch {}
  }

  broadcastEvents(inst, events, exceptPlayerId = null) {
    if (!inst || !events.length) return;
    for (const p of inst.players.values()) {
      if (exceptPlayerId !== null && p.playerId === Number(exceptPlayerId)) continue;
      for (const ev of events) this.sendTo(p.playerId, ev);
    }
  }

  broadcastGlobal(msg) {
    for (const id of this.conns.keys()) this.sendTo(id, msg);
  }

  /* --------------------------------------------------------------- kill loot -- */

  async handleKill(inst, playerEntity, enemy, loot, { assist = false } = {}) {
    const id = playerEntity.playerId;
    try {
      const player = await cache.getPlayer(id);
      if (!player) return;
      // Items, xp and quest progress are all `progression.grantKillRewards`; the only
      // thing this path adds is the *live* entity — stats to refresh, damage records.
      const { items, ar: arRes, levels: partyLv, questUpdates: allUpdates } =
        await prog.grantKillRewards(player, enemy.defId, loot);
      // Refresh combat stats for characters that levelled. `publishStats` is the same
      // door the HTTP routes use; the only thing this path adds is the 200 hp a level-up
      // hands back and the level list the client needs for its banner.
      if (partyLv.length) {
        const { publishStats } = await import('../routes/player.js');
        publishStats(player, { heal: 200, levels: partyLv });
      }

      this.sendTo(id, {
        t: S2C.LOOT,
        d: {
          from: enemy.defId, enemyId: enemy.id, items, xp: loot.xp,
          // The helper has to be told *why* they were paid, or a drop with no corpse of
          // their own under it reads as a bug. The HUD prefixes the line with 「助战」.
          assist: assist || undefined,
          mora: loot.mora, ar: arRes, levels: partyLv,
          player: { mora: player.mora, primogem: player.primogem, adventureRank: player.adventureRank, adventureXp: player.adventureXp },
        },
      });
      if (allUpdates.length) this.sendTo(id, { t: S2C.QUEST_UPDATE, d: { updates: allUpdates } });

      // An assist pays like a kill and *counts* like an assist: the kill board is the one
      // number where "who finished it" is the question being asked, so a helper adds 0
      // there while still banking their own xp, drops and quest progress above.
      await repo.updateLeaderboard(id, player.nickname, {
        score: player.adventureXp, kills: assist ? 0 : 1, maxDamage: Math.round(playerEntity.maxDamage),
      });
      await bumpLeaderboard(id, player.nickname, { score: player.adventureXp, damage: Math.round(playerEntity.maxDamage) });
      cache.markDirty(id);
    } catch (e) {
      console.error('[kill]', e.message);
    }
  }

  async handleChamberClear(inst, floor, time, stars) {
    for (const p of inst.players.values()) {
      try {
        const player = await cache.getPlayer(p.playerId);
        if (!player) continue;
        // Everything about paying for a clear — the record, the one-time star milestone,
        // the resin-paid drop, the leaderboards, the quest event — lives in
        // `prog.grantChamberClear`, because `POST /api/world/chamber` has to do exactly
        // the same thing for a 单机 client and the two copies of this block had already
        // drifted apart twice.
        const r = await prog.grantChamberClear(player, inst.zoneId, floor, time, stars);
        this.sendTo(p.playerId, {
          t: S2C.CHAMBER,
          d: {
            state: 'reward', floor, stars, time, reward: r.reward, drops: r.drops, resin: r.resin,
            ar: r.ar, partyLevels: r.partyLevels, questUpdates: r.questUpdates,
            player: {
              mora: player.mora, primogem: player.primogem,
              adventureRank: player.adventureRank, resin: player.resin,
            },
          },
        });
        cache.markDirty(p.playerId);
      } catch (e) {
        console.error('[chamber]', e.message);
      }
    }
  }

  /* ----------------------------------------------------------------- parties -- */

  createParty(leaderId) {
    const pid = `party_${leaderId}_${Date.now().toString(36)}`;
    this.parties.set(pid, new Set([Number(leaderId)]));
    this.partyOf.set(Number(leaderId), pid);
    this.partyLeader.set(pid, Number(leaderId));
    return pid;
  }

  addToParty(partyId, playerId) {
    const set = this.parties.get(partyId);
    if (!set || set.size >= 4) return false;
    set.add(Number(playerId));
    this.partyOf.set(Number(playerId), partyId);
    return true;
  }

  leaveParty(playerId) {
    const id = Number(playerId);
    const pid = this.partyOf.get(id);
    if (!pid) return null;
    const set = this.parties.get(pid);
    set?.delete(id);
    this.partyOf.delete(id);
    if (set && set.size === 0) {
      this.parties.delete(pid);
      this.partyLeader.delete(pid);
    } else if (set && this.partyLeader.get(pid) === id) {
      // The leader walked out. Somebody has to own the party's future private shards, and
      // the instance the rest of them are standing in right now is unaffected: it exists
      // under its old key and the follow path joins it by `preferShard`, not by name.
      this.partyLeader.set(pid, [...set][0]);
    }
    return pid;
  }

  /** The party's shard owner, for callers that only have a member's id. */
  partyLeaderOf(playerId) {
    const pid = this.partyOf.get(Number(playerId));
    return pid ? (this.partyLeader.get(pid) ?? null) : null;
  }

  partyMembers(playerId) {
    const pid = this.partyOf.get(Number(playerId));
    if (!pid) return [];
    return [...(this.parties.get(pid) || [])];
  }

  broadcastParty(playerId) {
    const pid = this.partyOf.get(Number(playerId));
    if (pid) this.broadcastPartyId(pid);
  }

  /**
   * Push one party's roster, addressed by party id.
   *
   * The door for a member who has *already* left: `broadcastParty` looks the party up from
   * the player, so after `leaveParty` there is nothing to look up and the members who stayed
   * were never told. Their panel kept drawing the player who walked out — with the zone and
   * hp they had at the time — until the process restarted.
   */
  broadcastPartyId(partyId) {
    const members = [...(this.parties.get(partyId) || [])];
    if (!members.length) return;
    const roster = members.map((id) => {
      const e = this.entityOf(id);
      return e ? { playerId: id, nickname: e.nickname, charId: e.charId, hp: Math.round(e.hp), maxHp: e.maxHp(), zone: e.zone, alive: e.alive } : { playerId: id };
    });
    for (const id of members) this.sendTo(id, { t: S2C.PARTY, d: { members: roster } });
  }

  stats() {
    const zones = {};
    for (const inst of this.instances.values()) {
      zones[inst.key] = { zone: inst.zoneId, players: inst.players.size, enemies: inst.enemies.size, tick: inst.tick };
    }
    return { instances: this.instances.size, connections: this.conns.size, zones };
  }

  shutdown() {
    for (const inst of this.instances.values()) inst.stop();
  }
}

export const world = new WorldManager();
