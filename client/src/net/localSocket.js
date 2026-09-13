// 单机 mode: the browser hosts the authoritative simulation itself.
//
// The game is written entirely against `Socket` — `game.js` binds ~20 S2C events and
// never touches a WebSocket — so single-player is not a second game loop, it is a
// second *host* for the same one. This class subclasses `Socket` and replaces the
// two ends of the pipe (`connect`/`send`) while keeping everything in between:
// snapshot buffering, the 120 ms interpolation delay, clock-offset smoothing,
// `sampleWindow`/`latest`/`stale`. Local events are handed to the inherited
// `_route()`, which is exactly what arrives over the wire online, so the client
// cannot tell the difference and neither can the player.
//
// What runs here is `shared/src/world/*`: the same `ZoneInstance` at the same 20 Hz,
// the same enemy AI, the same `handleAttack`/`handleSkill`/`handleBurst` — including
// their anti-teleport and cooldown checks, which are pointless against yourself but
// keep solo and online combat numerically identical.
//
// What deliberately does *not* run here: anything that mints durable value. Loot,
// xp, quest progress and chamber rewards are rolled and banked by REST
// (`POST /api/world/kill`, `POST /api/world/chamber`), because a reward the browser
// invents is a reward every player can invent. So 单机 means "plays without a
// gateway connection", not "plays without a server": the save still lives in
// Postgres and a kill still has to be reported to be paid.

import { Socket } from './socket.js';
import { api } from './api.js';
import { ZoneInstance } from '@teyvat/shared/world/zoneInstance.js';
import { handleInput, handleAttack, handleSkill, handleBurst } from '@teyvat/shared/world/actions.js';
import { consumableEffect } from '@teyvat/shared/world/consumables.js';
import { C2S, S2C, PROTOCOL_VERSION } from '@teyvat/shared/protocol.js';
import { ZONES, heightAt, canEnterZone, zoneEntryRank, chamberEntry } from '@teyvat/shared/data/zones.js';
import { defaultAnchor } from '@teyvat/shared/data/anchors.js';
import { MATERIALS } from '@teyvat/shared/data/items.js';
import { partyStats } from '@teyvat/shared/sim/loot.js';

export class LocalSocket extends Socket {
  constructor() {
    super();
    this.local = true;
    this.mode = 'solo';
    this.inst = null;          // live ZoneInstance
    this.entity = null;        // our PlayerEntity inside it
    this._save = null;         // the REST player document (shared ref with Game.player)
    this._stats = {};          // derivedStats, refreshed on level-up
    this._lastPosAt = Date.now();
    this._lootWarned = false;
  }

  /**
   * Hand over the save. `Game.load` already fetches `/api/player/state` before it
   * connects, so this costs no extra request — and it is the reason the handshake
   * below can be synchronous.
   */
  setSave(player, stats) {
    this._save = player;
    this._stats = stats || {};
  }

  url() { return 'local://sim'; }

  /* ------------------------------------------------------------ lifecycle -- */

  connect(zone, mode = 'solo') {
    this._wantZone = zone ?? this._wantZone;
    this._wantMode = 'solo';
    if (this.state === 'open') return;
    if (!this._save) { this.emit('fatal', { reason: 'no_save' }); return; }
    this.state = 'open';
    this.playerId = this._save.playerId;
    this.nickname = this._save.nickname;
    this.emit('open');
    const { inst, entity } = this._enter(this._wantZone || this._save.zone || 'mondstadt', null);
    this._route({
      t: S2C.WELCOME,
      d: {
        protocol: PROTOCOL_VERSION,
        playerId: this.playerId, nickname: this.nickname,
        zone: inst.zoneId, shard: String(inst.shard), mode: 'solo', tickRate: 20,
        you: entity.serialize(), stats: this._stats, state: inst.zoneStateFor(entity),
      },
    });
  }

  // There is nothing to reconnect to; a dropped REST call is reported per action.
  _scheduleRetry() {}

  close() {
    this._closedByUs = true;
    this._leave();
    this.state = 'closed';
    this.emit('close', { code: 1000, wasOpen: true });
  }

  /** Spin up the instance for `zoneId`, placing us at `at` if given. */
  _enter(zoneId, at) {
    const id = ZONES[zoneId] ? zoneId : 'mondstadt';
    this._leave();
    const save = this._save;
    if (at && Number.isFinite(at.x) && Number.isFinite(at.z)) {
      save.zone = id;
      save.pos = {
        x: at.x, z: at.z, ry: at.ry ?? save.pos?.ry ?? 0,
        y: heightAt(ZONES[id], at.x, at.z) + 1.2,
      };
    }
    // Shard name matches what the server would pick for a private shard, so a HUD
    // that prints it reads the same in both modes.
    const inst = new ZoneInstance(id, `p${save.playerId}`, this._hooks());
    this.inst = inst;
    this.entity = inst.addPlayer(save.playerId, save.nickname, save, this._stats);
    this._lastPosAt = Date.now();
    return { inst, entity: this.entity };
  }

  /** Tear the instance down, writing the live position back into the save. */
  _leave() {
    const inst = this.inst, entity = this.entity;
    if (!inst) return;
    if (entity) {
      this._save.pos = { x: entity.x, y: entity.y, z: entity.z, ry: entity.ry };
      this._save.zone = inst.zoneId;
    }
    inst.removePlayer(this._save.playerId);
    inst.stop();
    this.inst = null;
    this.entity = null;
  }

  _hooks() {
    return {
      // `broadcast` gets a batch, `sendTo` a single message; both end up in the same
      // router the WebSocket feeds, and in solo there is exactly one recipient.
      broadcast: (inst, events) => { for (const ev of events) this._route(ev); },
      sendTo: (playerId, msg) => this._route(msg),
      onKill: (inst, player, enemy) => { this._grantKill(inst, enemy); },
      onChamberClear: (inst, floor, time) => { this._grantChamber(inst, floor, time); },
    };
  }

  /* --------------------------------------------------------------- rewards -- */

  /**
   * Report a kill and route the server's answer as a LOOT event.
   *
   * The local sim also rolled loot (that is how `onKill` is shaped), and it is
   * thrown away: the route re-rolls with its own seed and clamps the level to the
   * hardest place the zone tables put that enemy, so the numbers a solo player sees
   * are the server's numbers.
   */
  async _grantKill(inst, enemy) {
    try {
      const res = await api.killEnemy(inst.zoneId, enemy.defId, enemy.level);
      this._applySave(res.player);
      this._route({
        t: S2C.LOOT,
        d: {
          from: res.from, enemyId: enemy.id, items: res.items, mora: res.mora,
          xp: res.xp, ar: res.ar, levels: res.levels, player: res.player,
        },
      });
      if (res.levels?.length) this._refreshStats(res.levels);
      if (res.questUpdates?.length) this._route({ t: S2C.QUEST_UPDATE, d: { updates: res.questUpdates } });
    } catch (e) {
      // Fighting keeps working with the API unreachable, but nothing is banked. Say so
      // once rather than on every corpse, which would bury the screen in toasts.
      if (!this._lootWarned) {
        this._lootWarned = true;
        this._route({ t: S2C.ERROR, d: { error: e?.code || 'network' } });
      }
    }
  }

  async _grantChamber(inst, floor, time) {
    try {
      const res = await api.chamberResult(inst.zoneId, floor, time);
      this._applySave(res.player);
      this._route({
        t: S2C.CHAMBER,
        d: {
          state: 'reward', floor, time, stars: res.stars, reward: res.reward || {},
          drops: res.drops || null, resin: res.resin || null,
          ar: res.arResult, partyLevels: res.partyLevels,
          questUpdates: res.questUpdates, player: res.player,
        },
      });
      if (res.partyLevels?.length) this._refreshStats(res.partyLevels);
    } catch (e) {
      this._route({ t: S2C.ERROR, d: { error: e?.code || 'network' } });
    }
  }

  /**
   * Merge a REST player document into the save.
   *
   * `pos`/`zone` are dropped: the running instance owns them, and the REST copy is
   * whatever was last persisted — folding it back in would rubber-band the player to
   * their last save point on every kill.
   */
  _applySave(p) {
    if (!p || !this._save) return;
    const { pos, zone, ...rest } = p;
    Object.assign(this._save, rest);
  }

  /**
   * Public twin of `_applySave`, for REST replies the *game* handled rather than this class.
   *
   * `Game._applyPlayer` calls it on every route's `player` payload. `Socket` has none: online the
   * save lives in `playerCache` and the route that answered has already updated it.
   */
  applySave(p) { this._applySave(p); }

  /**
   * A build changed over REST — push it into the simulation this browser is hosting.
   *
   * The 单机 twin of `WorldManager.refreshBuild`. `PlayerEntity.stats` and `.party` are the
   * snapshot handed to `addPlayer` in `_enter`, so without this a level-up, an equip or a
   * party edit stayed cosmetic until the next zone load. Both hosts end in the same
   * `entity.applyBuild`, which is what keeps solo and online agreeing down to the hp.
   */
  applyBuild(stats, party = null, opts = {}) {
    if (stats) this._stats = stats;
    if (party?.length) this._save.party = [...party];
    const e = this.entity;
    if (!e) return null;
    const res = e.applyBuild(this._stats, party, opts);
    this._save.activeSlot = Math.max(0, res.party.indexOf(res.charId));
    return res;
  }

  /** Recompute derived stats after a level-up, the way the gateway path does. */
  _refreshStats(levels) {
    const stats = partyStats(this._save.characters || {}, this._save.party || []);
    // Same 200 hp a level-up hands back online (`manager.handleKill`), and the same
    // message shape, so `game.js` cannot tell which host it is talking to.
    const res = this.applyBuild(stats, null, { heal: 200 });
    this._route({
      t: S2C.PLAYER_ACTION,
      d: {
        playerId: this.playerId, action: 'statsRefresh', stats, levels,
        party: res?.party, charId: res?.charId, maxHp: res?.maxHp,
        hp: this.entity ? Math.round(this.entity.hp) : undefined,
      },
    });
  }

  /* --------------------------------------------------------------- sending -- */

  send(t, d) {
    if (this.state !== 'open') return;
    if (t === C2S.HELLO) return;            // the handshake happened in connect()
    const reply = (rt, rd) => this._route({ t: rt, d: rd });
    const fail = (error, code = null) => this._route({ t: S2C.ERROR, d: { error, code } });
    const inst = this.inst, entity = this.entity;
    if (!inst || !entity) return fail('not_in_zone');

    switch (t) {
      case C2S.PING:
        reply(S2C.PONG, { c: d?.c, server: Date.now() });
        break;

      case C2S.INPUT:
        handleInput(entity, inst, d, this._lastPosAt);
        this._lastPosAt = Date.now();
        break;

      case C2S.ATTACK: handleAttack(entity, inst, d, reply, fail); break;
      case C2S.SKILL: handleSkill(entity, inst, d, reply, fail); break;
      case C2S.BURST: handleBurst(entity, inst, d, reply, fail); break;

      case C2S.SWITCH_CHAR: {
        const charId = String(d?.charId || '');
        if (!entity.switchTo(charId)) return fail('cannot_switch');
        const slot = entity.party.indexOf(charId);
        if (slot >= 0) this._save.activeSlot = slot;
        reply(S2C.PLAYER_ACTION, { playerId: this.playerId, action: 'switch', charId });
        reply(S2C.PLAYER_ACTION, {
          playerId: this.playerId, action: 'switchOk', charId,
          hp: Math.round(entity.hp), maxHp: entity.maxHp(),
        });
        break;
      }

      case C2S.INTERACT:
        reply(S2C.PLAYER_ACTION, { playerId: this.playerId, action: 'interact', target: d?.target || null });
        break;

      case C2S.CHAT:
        // No one else is listening, but the chat log is also the quest/system log, so
        // the message still has to come back through the same event.
        reply(S2C.CHAT, {
          playerId: this.playerId, nickname: this.nickname,
          channel: d?.channel === 'party' ? 'party' : d?.channel === 'world' ? 'world' : 'zone',
          body: String(d?.body || '').slice(0, 300), at: Date.now(),
        });
        break;

      case C2S.JOIN_ZONE: {
        // Following a friend means joining their shard, and this host has exactly one
        // shard: the tab it runs in. Answered rather than ignored so the UI's error
        // path fires instead of its 20 s zone-change timeout.
        if (d?.follow) return fail('solo_no_party');
        const zoneId = String(d?.zone || '');
        const zdef = ZONES[zoneId];
        if (!zdef) return fail('bad_zone');
        if (!canEnterZone(zdef, this._save.adventureRank)) return fail('rank_too_low', zoneEntryRank(zdef));
        const at = (() => {
          const a = d?.at;
          if (Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1])) return { x: a[0], z: a[1] };
          if (a && Number.isFinite(a.x) && Number.isFinite(a.z)) return { x: a.x, z: a.z };
          const wp = defaultAnchor(zdef);
          const w = wp ? wp.at : [0, 0];
          return { x: w[0], z: w[1] };
        })();
        const joined = this._enter(zoneId, at);
        // Persist where we ended up. Fire-and-forget: the sim is already running, and
        // a failed save costs at most the walk back, not the session.
        api.save({ zone: zoneId, pos: this._save.pos }).catch(() => {});
        reply(S2C.ZONE_STATE, {
          zone: joined.inst.zoneId, shard: String(joined.inst.shard), mode: 'solo',
          you: joined.entity.serialize(), stats: this._stats,
          state: joined.inst.zoneStateFor(joined.entity),
        });
        break;
      }

      case C2S.START_CHAMBER: {
        const floor = Number(d?.floor || 1);
        // The same `chamberEntry` the gateway and the REST route apply, read from the save
        // that `_applySave` keeps current — so clearing floor 1 unlocks floor 2 without
        // leaving the dungeon, and 单机 refuses exactly what 联机 refuses.
        const entry = chamberEntry(inst.zone, floor, {
          adventureRank: this._save.adventureRank, abyss: this._save.abyss, chamber: inst.chamber,
        });
        if (!entry.ok) return fail(entry.error);
        const r = inst.startChamber(floor);
        if (r.error) return fail(r.error);
        break;
      }

      case C2S.REVIVE: {
        if (entity.alive) return fail('not_downed');
        if ((this._save.inventory?.reviveDish || 0) < 1) return fail('no_revive_item');
        // Spend the dish through the same route the inventory panel uses; the revive
        // only happens if the server agrees the item was there.
        api.useItem('reviveDish', 1).then((res) => {
          this._applySave(res.player);
          entity.revive(MATERIALS.reviveDish?.revive?.hpPct);
          reply(S2C.REVIVED, { playerId: this.playerId, by: this.playerId });
        }).catch((e) => fail(e?.code || 'none_left'));
        break;
      }

      // The instance emits REVIVED with the anchor it picked, and `_hooks().broadcast` routes
      // that straight back — so solo and online land on the same client code path.
      case C2S.RESPAWN: {
        if (entity.alive) return fail('not_downed');
        inst.respawnAtAnchor(entity, { auto: false });
        inst.flushEvents();
        break;
      }

      case C2S.USE_ITEM:
        this._useItem(String(d?.itemId || ''), reply, fail);
        break;

      case C2S.PARTY_LEAVE:
        reply(S2C.PARTY, { members: [] });
        break;

      case C2S.PARTY_INVITE:
      case C2S.PARTY_ACCEPT:
        fail('solo_no_party');
        break;

      case C2S.EMOTE:
        reply(S2C.EMOTE, { playerId: this.playerId, emote: String(d?.emote || 'wave').slice(0, 16) });
        break;

      case C2S.MARK:
        reply(S2C.MARK, { playerId: this.playerId, x: Number(d?.x) || 0, z: Number(d?.z) || 0 });
        break;

      default:
        fail('unknown_message');
    }
  }

  /**
   * Eat something.
   *
   * The decrement is the server's (REST), the effect is the live entity's — the same
   * split the gateway makes, for the same reason: hp and food buffs are combat state
   * that the running instance would overwrite if they were only written to the save.
   */
  async _useItem(itemId, reply, fail) {
    const def = MATERIALS[itemId];
    const entity = this.entity, inst = this.inst;
    if (!def || def.kind !== 'consumable') return fail('not_consumable');
    if (!entity || !inst) return fail('not_in_zone');
    if ((this._save.inventory?.[itemId] || 0) < 1) return fail('none_left');
    // The same gate the gateway uses, and here it matters even more: the decrement is the
    // REST route's and the effect is the local entity's, so a dish that would do nothing
    // is spent in the database and refunded nowhere.
    const eff = consumableEffect(def, { hp: entity.hp, maxHp: entity.maxHp(), alive: entity.alive });
    if (eff.refusal) return fail(eff.refusal);

    let res;
    try { res = await api.useItem(itemId, 1); } catch (e) { return fail(e?.code || 'none_left'); }
    this._applySave(res.player);

    if (eff.revive) {
      entity.revive(eff.revive.hpPct);
      reply(S2C.REVIVED, { playerId: this.playerId, by: this.playerId });
    }
    if (eff.heal) {
      const amount = (eff.heal.flat || 0) + (eff.heal.hpPct || 0) * entity.maxHp();
      const healed = entity.heal(amount);
      if (healed > 0) {
        reply(S2C.DAMAGE, {
          target: 'player', id: this.playerId, amount: -Math.round(healed),
          element: 'light', kind: 'heal',
        });
      }
    }
    if (eff.buff) {
      // One food buff at a time, matching the gateway.
      entity.buffs = entity.buffs.filter((b) => b.kind !== 'food');
      entity.buffs.push({
        kind: 'food', source: itemId, until: inst.now + (eff.buff.duration || 180),
        atkPct: eff.buff.atkPct || 0, critRate: eff.buff.critRate || 0,
      });
      reply(S2C.BUFF, {
        playerId: this.playerId, item: itemId, name: def.name,
        atkPct: eff.buff.atkPct || 0, critRate: eff.buff.critRate || 0,
        duration: eff.buff.duration || 180,
      });
    }
    entity.dirty = true;
    reply(S2C.PLAYER_ACTION, {
      playerId: this.playerId, action: 'useItem', itemId,
      left: res.player?.inventory?.[itemId] ?? 0,
    });
  }
}
