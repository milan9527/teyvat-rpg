// WebSocket gateway: validates every client action against the authoritative sim.

import { verifyToken } from '../auth.js';
import * as cache from '../services/playerCache.js';
import * as repo from '../db/repo.js';
import { world } from '../world/manager.js';
import { derivedStats } from '../routes/player.js';
import { C2S, S2C, PROTOCOL_VERSION, MAX_PLAYERS_PER_ZONE } from '@teyvat/shared/protocol.js';
import { MATERIALS } from '@teyvat/shared/data/items.js';
import { ZONES, heightAt, canEnterZone, zoneEntryRank, chamberEntry } from '@teyvat/shared/data/zones.js';
import { defaultAnchor } from '@teyvat/shared/data/anchors.js';
import { REVIVE_RANGE } from '@teyvat/shared/world/entity.js';
import { rateLimit, publishChat } from '../db/redis.js';
// Movement and combat resolution live in `shared/` so the browser can host the same
// simulation in 单机 mode; what is left here is genuinely transport: auth, rate
// limiting, chat, parties, zone changes.
import { handleInput, handleAttack, handleSkill, handleBurst } from '@teyvat/shared/world/actions.js';
import { consumableEffect } from '@teyvat/shared/world/consumables.js';

export function registerGateway(app) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    let playerId = null;
    let authed = false;
    let entity = null;
    let inst = null;
    let lastPosAt = Date.now();
    let msgCount = 0;

    const send = (t, d) => {
      try { if (socket.readyState === 1) socket.send(JSON.stringify({ t, d })); } catch {}
    };
    const fail = (msg, code) => send(S2C.ERROR, { error: msg, code: code || null });

    socket.on('message', async (raw) => {
      // Cheap flood guard.
      if (++msgCount > 400) {
        msgCount = 0;
        if (!(await rateLimit(`ws:${playerId || req.ip}`, 4000, 60))) {
          fail('rate_limited');
          socket.close();
          return;
        }
      }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return fail('bad_json'); }
      const { t, d } = msg || {};
      if (!t) return;

      try {
        if (t === C2S.HELLO) {
          const claims = verifyToken(d?.token || '');
          if (!claims?.playerId) return fail('unauthorized');
          playerId = Number(claims.playerId);
          const save = await cache.getPlayer(playerId, { fresh: true });
          if (!save) return fail('no_player');
          const stats = derivedStats(save);
          const solo = d?.mode === 'solo';
          const joined = await world.join(playerId, socket, save, stats, { solo, zoneId: d?.zone });
          inst = joined.inst;
          entity = joined.entity;
          authed = true;
          send(S2C.WELCOME, {
            protocol: PROTOCOL_VERSION,
            playerId,
            nickname: save.nickname,
            zone: inst.zoneId,
            shard: String(inst.shard),
            mode: solo ? 'solo' : 'online',
            tickRate: 20,
            you: entity.serialize(),
            stats,
            state: inst.zoneStateFor(entity),
          });
          world.broadcastParty(playerId);
          return;
        }

        if (!authed || !entity) return fail('not_authed');
        // Re-resolve instance each message; it can change on zone switch.
        inst = world.instanceOf(playerId);
        entity = world.entityOf(playerId);
        if (!inst || !entity) return fail('not_in_zone');

        switch (t) {
          case C2S.PING:
            send(S2C.PONG, { c: d?.c, server: Date.now() });
            break;

          case C2S.INPUT:
            handleInput(entity, inst, d, lastPosAt);
            lastPosAt = Date.now();
            break;

          case C2S.SWITCH_CHAR: {
            const charId = String(d?.charId || '');
            if (!entity.switchTo(charId)) return fail('cannot_switch');
            const slot = entity.party.indexOf(charId);
            const live = cache.peek(playerId);
            if (live) { live.activeSlot = Math.max(0, slot); cache.markDirty(playerId); }
            inst.hooks.broadcast?.(inst, [{ t: S2C.PLAYER_ACTION, d: { playerId, action: 'switch', charId } }]);
            send(S2C.PLAYER_ACTION, { playerId, action: 'switchOk', charId, hp: Math.round(entity.hp), maxHp: entity.maxHp() });
            break;
          }

          case C2S.ATTACK:
            handleAttack(entity, inst, d, send, fail);
            break;

          case C2S.SKILL:
            handleSkill(entity, inst, d, send, fail);
            break;

          case C2S.BURST:
            handleBurst(entity, inst, d, send, fail);
            break;

          case C2S.INTERACT: {
            // Interactions that need durable state go through REST; this is for the
            // in-world visual + party notification.
            inst.hooks.broadcast?.(inst, [{ t: S2C.PLAYER_ACTION, d: { playerId, action: 'interact', target: d?.target || null } }]);
            break;
          }

          case C2S.CHAT: {
            const body = String(d?.body || '').slice(0, 300).trim();
            if (!body) return;
            if (!(await rateLimit(`chat:${playerId}`, 12, 20))) return fail('chat_rate_limited');
            const channel = d?.channel === 'zone' ? 'zone' : d?.channel === 'party' ? 'party' : 'world';
            const out = { t: S2C.CHAT, d: { playerId, nickname: entity.nickname, channel, body, at: Date.now() } };
            if (channel === 'zone') world.broadcastEvents(inst, [out]);
            else if (channel === 'party') for (const id of world.partyMembers(playerId)) world.sendTo(id, out);
            else world.broadcastGlobal(out);
            await repo.saveChat(playerId, channel, entity.nickname, body).catch(() => {});
            await publishChat(out.d);
            break;
          }

          case C2S.JOIN_ZONE: {
            // `follow` is co-op's entry point: the client names a friend and the server
            // decides *where*. It deliberately ignores the zone the client asked for —
            // the friend list is a REST snapshot and a friend who changed zone two
            // seconds ago would otherwise put the follower in an empty shard of the
            // stale zone, which looks exactly like the feature being broken.
            let follow = null;
            if (d?.follow) {
              const targetId = Number(d.follow);
              const edge = await repo.friendEdge(playerId, targetId);
              if (edge?.state !== 'accepted') return fail('not_friends');
              const tInst = world.instanceOf(targetId);
              if (!tInst) return fail('friend_offline');
              // A private shard is one player's or one *party's* instance: 单机 sessions
              // and 秘境 runs. Dropping a stranger into one would hand them a chamber
              // already in progress, so it is refused rather than redirected — but a
              // teammate is exactly who belongs in there, and refusing them is what made
              // co-op 秘境 impossible: all three dungeons are `kind: 'dungeon'`, so every
              // instance of them is private and every follow was answered with
              // `friend_is_solo`. Same party, and the owner is not playing 单机 (whose
              // simulation runs in their own browser and cannot host anybody).
              if (String(tInst.shard).startsWith('p')) {
                const mine = world.partyOf.get(playerId);
                const theirs = world.partyOf.get(targetId);
                if (!mine || mine !== theirs || world.solo.has(targetId)) return fail('friend_is_solo');
              }
              if (tInst.players.size >= MAX_PLAYERS_PER_ZONE) return fail('world_full');
              const tp = tInst.players.get(targetId);
              follow = {
                zoneId: tInst.zoneId,
                shard: tInst.shard,
                // Beside them, not on top of them: two entities at the same coordinates
                // fight over the same collision cell and read as one avatar.
                at: tp ? { x: tp.x + 2.5, z: tp.z + 2.5, ry: tp.ry } : null,
              };
            }
            const zoneId = follow ? follow.zoneId : String(d?.zone || '');
            if (!ZONES[zoneId]) return fail('bad_zone');
            const save = await cache.getPlayer(playerId);
            if (!save) return fail('no_player');
            const zdef = ZONES[zoneId];
            // Entry gate by adventure rank (shared with the REST teleport route).
            if (!canEnterZone(zdef, save.adventureRank)) return fail('rank_too_low', zoneEntryRank(zdef));
            // `at` is accepted as {x, z} or [x, z]: the client sends the object,
            // but the array form is what zone POI tables use and mixing them up
            // silently dropped the player at the first waypoint instead.
            const at = (() => {
              if (follow?.at) return follow.at;
              const a = d?.at;
              if (Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1])) {
                return { x: a[0], z: a[1] };
              }
              if (a && Number.isFinite(a.x) && Number.isFinite(a.z)) return { x: a.x, z: a.z };
              const wp = defaultAnchor(zdef);
              const w = wp ? wp.at : [0, 0];
              return { x: w[0], z: w[1] };
            })();
            const stats = derivedStats(save);
            // Following a friend is by definition not solo, and it has to clear the
            // player's own solo flag: `join` only calls `solo.delete` when it is passed
            // false, so a player who started in a private shard would otherwise keep
            // getting one and never see the friend they just followed.
            //
            // `solo` is the *player's* declared mode and nothing else. It used to be
            // OR-ed with `zdef.kind === 'dungeon'`, which is a different question —
            // "is this instance private", which `pickInstance` answers for itself — and
            // the difference was two bugs in one line: `join` latched the flag into
            // `world.solo`, so one 秘境 run left an online player in private shards for
            // the rest of the session (their friends became invisible), and ZONE_STATE
            // reported `mode: 'solo'`, which the client latches too and which turns its
            // own co-op UI off.
            const solo = follow ? false : world.solo.has(playerId);
            // `at` goes to join(), not onto `save` here: join() leaves the old shard
            // first, and leaving writes the current live position over `save.pos`.
            const joined = await world.join(playerId, socket, save, stats, {
              solo, zoneId, at, preferShard: follow ? follow.shard : null,
            });
            save.pos = { x: at.x, y: heightAt(zdef, at.x, at.z) + 1.2, z: at.z, ry: 0 };
            save.zone = zoneId;
            await repo.savePlayerCore(playerId, { zone: zoneId, pos: save.pos });
            inst = joined.inst;
            entity = joined.entity;
            send(S2C.ZONE_STATE, {
              zone: inst.zoneId, shard: String(inst.shard), mode: solo ? 'solo' : 'online',
              you: entity.serialize(), stats, state: inst.zoneStateFor(entity),
            });
            // The roster carries each member's zone, and "where is my team" is the whole
            // reason to look at it: without this a teammate who walks into a 秘境 still
            // reads as standing in 蒙德, so nobody knows there is a run to follow into.
            world.broadcastParty(playerId);
            break;
          }

          case C2S.START_CHAMBER: {
            const floor = Number(d?.floor || 1);
            const save = await cache.getPlayer(playerId);
            // One shared rule (`chamberEntry`): is this a dungeon, does the floor exist, is
            // the rank enough, is the previous floor starred, and is a run already live.
            // The map panel draws its locks from the same function, so a row it offers is a
            // row this case accepts. `startChamber` keeps its own in-progress guard as well —
            // that one is the simulation refusing to reset itself, and it is what protects a
            // teammate's run from a request this gateway never saw.
            const entry = chamberEntry(inst.zone, floor, {
              adventureRank: save.adventureRank, abyss: save.abyss, chamber: inst.chamber,
            });
            if (!entry.ok) return fail(entry.error);
            const r = inst.startChamber(floor);
            if (r.error) return fail(r.error);
            break;
          }

          case C2S.REVIVE: {
            const targetId = Number(d?.playerId || playerId);
            const target = inst.players.get(targetId);
            if (!target || target.alive) return fail('not_downed');
            let hpPct;
            if (targetId !== playerId) {
              if (Math.hypot(entity.x - target.x, entity.z - target.z) > REVIVE_RANGE) return fail('too_far');
            } else {
              // Self-revive costs a revive dish, so it hands back what the dish promises
              // rather than what a teammate's free hand does.
              const save = await cache.getPlayer(playerId);
              if ((save.inventory.reviveDish || 0) < 1) return fail('no_revive_item');
              await repo.addItems(playerId, { reviveDish: -1 });
              save.inventory.reviveDish -= 1;
              hpPct = MATERIALS.reviveDish?.revive?.hpPct;
            }
            target.revive(hpPct);
            world.broadcastEvents(inst, [{ t: S2C.REVIVED, d: { playerId: targetId, by: playerId } }]);
            break;
          }

          /**
           * Give up on being rescued and walk it back from an anchor.
           *
           * The sim already does this on its own after AUTO_RESPAWN_SEC; this only lets the
           * player skip the wait, so it must land at the same place — hence
           * `inst.respawnAtAnchor` rather than a second copy of the arithmetic here.
           */
          case C2S.RESPAWN: {
            if (entity.alive) return fail('not_downed');
            inst.respawnAtAnchor(entity, { auto: false });
            inst.flushEvents();
            break;
          }

          /**
           * Eat something.
           *
           * Over the socket rather than REST because the *effect* is combat state:
           * hp and stat buffs live on the live entity, and a REST route could only
           * write them to the save — which the running zone instance would then
           * overwrite on its next tick. The inventory decrement still goes through
           * the repo, so a dish eaten in a fight is gone even if the shard dies.
           */
          case C2S.USE_ITEM: {
            const itemId = String(d?.itemId || '');
            const def = MATERIALS[itemId];
            if (!def || def.kind !== 'consumable') return fail('not_consumable');
            const save = await cache.getPlayer(playerId);
            if (!save) return fail('no_player');
            if ((save.inventory[itemId] || 0) < 1) return fail('none_left');
            // Would it do anything? Resin potions belong to the menu, a heal is a no-op at
            // full health and a revive dish is a no-op standing up — and this route spends
            // the item, so the question has to be asked *before* the decrement.
            // `shared/world/consumables.js` is the one place that answers it.
            const eff = consumableEffect(def, { hp: entity.hp, maxHp: entity.maxHp(), alive: entity.alive });
            if (eff.refusal) return fail(eff.refusal);
            if (!(await rateLimit(`item:${playerId}`, 6, 10))) return fail('item_rate_limited');

            await repo.addItems(playerId, { [itemId]: -1 });
            save.inventory[itemId] = (save.inventory[itemId] || 1) - 1;
            cache.markDirty(playerId);

            const events = [];
            if (eff.revive) {
              entity.revive(eff.revive.hpPct);
              events.push({ t: S2C.REVIVED, d: { playerId, by: playerId } });
            }
            if (eff.heal) {
              const amount = (eff.heal.flat || 0) + (eff.heal.hpPct || 0) * entity.maxHp();
              const healed = entity.heal(amount);
              if (healed > 0) {
                events.push({ t: S2C.DAMAGE, d: {
                  target: 'player', id: playerId, amount: -Math.round(healed),
                  element: 'light', kind: 'heal',
                } });
              }
            }
            if (eff.buff) {
              const until = inst.now + (eff.buff.duration || 180);
              // One food buff at a time: two stacked dishes is a straightforward way
              // to double a character's attack for five minutes, and the fix players
              // expect is that the new meal replaces the old one.
              entity.buffs = entity.buffs.filter((b) => b.kind !== 'food');
              entity.buffs.push({
                kind: 'food', source: itemId, until,
                atkPct: eff.buff.atkPct || 0, critRate: eff.buff.critRate || 0,
              });
              events.push({ t: S2C.BUFF, d: {
                playerId, item: itemId, name: def.name,
                atkPct: eff.buff.atkPct || 0, critRate: eff.buff.critRate || 0,
                duration: eff.buff.duration || 180,
              } });
            }
            entity.dirty = true;
            send(S2C.PLAYER_ACTION, { playerId, action: 'useItem', itemId, left: save.inventory[itemId] });
            if (events.length) world.broadcastEvents(inst, events);
            break;
          }

          case C2S.PARTY_INVITE: {
            const targetId = Number(d?.playerId);
            if (!targetId || targetId === playerId) return fail('bad_target');
            let pid = world.partyOf.get(playerId) || world.createParty(playerId);
            world.sendTo(targetId, { t: S2C.PARTY, d: { invite: { from: playerId, nickname: entity.nickname, partyId: pid } } });
            break;
          }

          case C2S.PARTY_ACCEPT: {
            const pid = String(d?.partyId || '');
            if (!world.parties.has(pid)) return fail('party_gone');
            if (!world.addToParty(pid, playerId)) return fail('party_full');
            world.broadcastParty(playerId);
            break;
          }

          case C2S.PARTY_LEAVE: {
            const pid = world.leaveParty(playerId);
            send(S2C.PARTY, { members: [] });
            // The members who stayed have to hear it as well, and they cannot be reached
            // through the player who just left — see `broadcastPartyId`.
            if (pid) world.broadcastPartyId(pid);
            break;
          }

          case C2S.EMOTE:
            world.broadcastEvents(inst, [{ t: S2C.EMOTE, d: { playerId, emote: String(d?.emote || 'wave').slice(0, 16) } }]);
            break;

          case C2S.MARK:
            world.broadcastEvents(inst, [{ t: S2C.MARK, d: { playerId, x: Number(d?.x) || 0, z: Number(d?.z) || 0 } }]);
            break;

          default:
            fail('unknown_message');
        }
      } catch (e) {
        app.log.error({ err: e, type: t }, 'ws handler failed');
        fail('server_error');
      }
    });

    socket.on('close', async () => {
      if (playerId) {
        await world.leave(playerId).catch(() => {});
        world.broadcastParty(playerId);
      }
    });
    socket.on('error', () => {});
  });
}
