// Progression rules enforced server-side: character/AR levelling, ascension,
// talents, resin regen, quest advancement, rewards.

import * as repo from '../db/repo.js';
import { xpForLevel, levelFromXp, arCap, rankForLevel } from '@teyvat/shared/sim/formulas.js';
import { CHARACTERS } from '@teyvat/shared/data/characters.js';
import { MATERIALS } from '@teyvat/shared/data/items.js';
import { QUESTS, stageMatches, dailiesToRoll } from '@teyvat/shared/data/quests.js';
import { LIFETIME_EVENTS } from '@teyvat/shared/data/achievements.js';
import { ZONES, DOMAIN_RESIN, chamberMilestone } from '@teyvat/shared/data/zones.js';
import { rollDomainReward } from '@teyvat/shared/sim/loot.js';
import { bumpLeaderboard } from '../db/redis.js';

export const ASCENSION_CAPS = [20, 40, 50, 60, 70, 80, 90];
export const ASCENSION_COST = [
  { mora: 20000, items: { slimeCondensate: 3, crystalCore: 3 } },
  { mora: 40000, items: { slimeCondensate: 10, crystalCore: 10, damagedMask: 15 } },
  { mora: 60000, items: { slimeSecretions: 20, chaosDevice: 12, damagedMask: 12 } },
  { mora: 80000, items: { slimeSecretions: 30, chaosDevice: 20, arrowhead: 18 } },
  { mora: 100000, items: { abyssalCrystal: 24, chaosCore: 12, wolfClaw: 20 } },
  { mora: 120000, items: { abyssalCrystal: 40, chaosCore: 24, vishapScale: 24 } },
];

export const TALENT_COST = (level) => ({
  mora: 12500 * level,
  items: { damagedMask: 3 * level, chaosDevice: Math.ceil(level / 2), abyssalCrystal: level >= 7 ? level : 0 },
});

export function maxCharLevel(ascension) {
  return ASCENSION_CAPS[Math.min(ascension, ASCENSION_CAPS.length - 1)];
}

// Defined in shared so the client, the server and `tools/balance-check.mjs` gate on one
// rule; re-exported here because this is where the rest of the progression rules live.
export { arCap, rankForLevel };

export const RESIN_CAP = 160;
export const RESIN_PERIOD_MS = 8 * 60 * 1000;

/**
 * Resin regenerates 1 per 8 minutes up to 160.
 *
 * The remainder is deliberately kept: `resinAt` advances by whole periods only, so the
 * seven minutes that did not buy a point are still on the clock next time — otherwise
 * a player who reloads often would never regenerate at all.
 *
 * Sitting at the cap has to *re-anchor* the clock rather than leave it running. It used
 * to return early, and once resin had a sink (`DOMAIN_RESIN`) that early return handed
 * the cost straight back: an account created a week ago and never spent is at 160 with
 * `resinAt` a week in the past, so the first 20-resin domain run was refunded in full by
 * the next `getPlayer` — 1260 points of "regen" waiting to be claimed. Full means full,
 * and the eight minutes start from now.
 */
export function regenResin(player) {
  const last = new Date(player.resinAt || Date.now()).getTime();
  const elapsed = Date.now() - last;
  // `resin` itself is left alone here — 浓缩树脂 deliberately overfills past the cap
  // (`POST /api/inventory/use` allows 200), and this function's job is the clock.
  if (player.resin >= RESIN_CAP) {
    return { resin: player.resin, resinAt: new Date(), changed: elapsed >= RESIN_PERIOD_MS };
  }
  const gained = Math.floor(elapsed / RESIN_PERIOD_MS);
  if (gained <= 0) return { resin: player.resin, resinAt: player.resinAt, changed: false };
  const resin = Math.min(RESIN_CAP, player.resin + gained);
  const resinAt = new Date(last + gained * RESIN_PERIOD_MS);
  return { resin, resinAt, changed: true };
}

/**
 * Feed XP material to a character.
 *
 * Books are spent **cheapest-first and only up to what the character can still absorb**, which
 * is the same rule `POST /api/inventory/weapon/levelup` applies to ore — and it was missing
 * here, in the path with the bigger bag behind it. The old loop took every book offered, and
 * the level loop below zeroes the bank at the cap (`if (level >= cap) xp = 0`), so a level-19
 * character one click away from the cap ate the whole offer: the character panel's own button
 * offers `min(have, 20)` 大英雄的经验 in one press, which is 400 000 xp handed over for the
 * ~30 000 the last level costs, and the other nineteen books were incinerated with no warning
 * and no way to get them back. The surplus that *cannot* be avoided is one book (they are
 * indivisible), and below the cap it is banked in `inst.xp` rather than lost.
 */
export async function levelUpCharacter(player, charId, materials) {
  const inst = player.characters[charId];
  if (!inst) return { error: 'character_not_owned' };
  const cap = Math.min(maxCharLevel(inst.ascension), arCap(player.adventureRank));
  if (inst.level >= cap) return { error: 'level_capped', cap };

  // Room left: the xp from here to the cap, less what is already banked on the character.
  let room = -(inst.xp || 0);
  for (let l = inst.level; l < cap; l++) room += xpForLevel(l);

  // Cheapest book first, for the same reason ore is: a bag-wide offer must not lose a
  // 大英雄的经验 to a level a 流浪者的经验 could have paid for.
  const offered = Object.entries(materials || {})
    .map(([id, count]) => ({ id, xp: MATERIALS[id]?.xp || 0, count: Math.floor(count) }))
    .filter((o) => o.xp > 0 && o.count > 0)
    .sort((x, y) => x.xp - y.xp);

  let xpGain = 0;
  let moraCost = 0;
  const spend = {};
  for (const o of offered) {
    if (xpGain >= room) break;
    const have = player.inventory[o.id] || 0;
    const use = Math.min(o.count, have, Math.ceil((room - xpGain) / o.xp));
    if (use <= 0) continue;
    xpGain += o.xp * use;
    moraCost += Math.round(o.xp * use * 0.2);
    spend[o.id] = -use;
  }
  if (xpGain <= 0) return { error: 'no_materials' };
  if (player.mora < moraCost) return { error: 'not_enough_mora', need: moraCost };

  let level = inst.level;
  let xp = inst.xp + xpGain;
  while (level < cap) {
    const need = xpForLevel(level);
    if (xp < need) break;
    xp -= need;
    level++;
  }
  if (level >= cap) xp = 0;

  inst.level = level;
  inst.xp = xp;
  await repo.upsertCharacter(player.playerId, inst);
  await repo.addItems(player.playerId, { ...spend, mora: -moraCost });
  player.mora -= moraCost;
  for (const [k, v] of Object.entries(spend)) player.inventory[k] = (player.inventory[k] || 0) + v;

  // `consumed` is what the panel needs to say what a click cost, and what the audit needs to
  // see that the books it declined are still in the bag.
  return { charId, level, xp, xpToNext: xpForLevel(level), moraSpent: moraCost, cap, consumed: spend };
}

export async function ascendCharacter(player, charId) {
  const inst = player.characters[charId];
  if (!inst) return { error: 'character_not_owned' };
  const asc = inst.ascension;
  if (asc >= 6) return { error: 'max_ascension' };
  if (inst.level < ASCENSION_CAPS[asc]) return { error: 'level_too_low', need: ASCENSION_CAPS[asc] };
  const cost = ASCENSION_COST[asc];
  if (player.mora < cost.mora) return { error: 'not_enough_mora', need: cost.mora };
  for (const [id, n] of Object.entries(cost.items)) {
    if ((player.inventory[id] || 0) < n) return { error: 'missing_material', item: id, need: n };
  }
  const spend = { mora: -cost.mora };
  for (const [id, n] of Object.entries(cost.items)) spend[id] = -n;

  inst.ascension = asc + 1;
  await repo.upsertCharacter(player.playerId, inst);
  await repo.addItems(player.playerId, spend);
  player.mora -= cost.mora;
  for (const [id, n] of Object.entries(cost.items)) player.inventory[id] = (player.inventory[id] || 0) - n;
  return { charId, ascension: inst.ascension, newCap: maxCharLevel(inst.ascension) };
}

export async function upgradeTalent(player, charId, which) {
  if (!['normal', 'skill', 'burst'].includes(which)) return { error: 'bad_talent' };
  const inst = player.characters[charId];
  if (!inst) return { error: 'character_not_owned' };
  const cur = inst.talents[which] || 1;
  if (cur >= 10) return { error: 'max_talent' };
  const maxByAsc = Math.min(10, 1 + inst.ascension * 2);
  if (cur >= maxByAsc) return { error: 'need_ascension', maxByAsc };
  const cost = TALENT_COST(cur);
  if (player.mora < cost.mora) return { error: 'not_enough_mora', need: cost.mora };
  for (const [id, n] of Object.entries(cost.items)) {
    if (n > 0 && (player.inventory[id] || 0) < n) return { error: 'missing_material', item: id, need: n };
  }
  const spend = { mora: -cost.mora };
  for (const [id, n] of Object.entries(cost.items)) if (n > 0) spend[id] = -n;

  inst.talents = { ...inst.talents, [which]: cur + 1 };
  await repo.upsertCharacter(player.playerId, inst);
  await repo.addItems(player.playerId, spend);
  player.mora -= cost.mora;
  for (const [id, n] of Object.entries(cost.items)) if (n > 0) player.inventory[id] = (player.inventory[id] || 0) - n;
  return { charId, talents: inst.talents };
}

export async function grantAdventureXp(player, amount) {
  if (amount <= 0) return null;
  const before = player.adventureRank;
  player.adventureXp += amount;
  const { level } = levelFromXp(player.adventureXp);
  player.adventureRank = Math.max(1, Math.min(90, level));
  const worldLevel = Math.min(8, Math.floor((player.adventureRank - 1) / 5));
  const leveled = player.adventureRank > before;
  player.worldLevel = worldLevel;
  await repo.savePlayerCore(player.playerId, {
    adventureXp: player.adventureXp, adventureRank: player.adventureRank, worldLevel,
  });
  if (leveled) {
    // AR reward: primogems + wish ticket every 5 ranks.
    const reward = { primogem: 20 * (player.adventureRank - before) };
    if (Math.floor(player.adventureRank / 5) > Math.floor(before / 5)) reward.wishTicket = 2;
    await repo.addItems(player.playerId, reward);
    player.primogem += reward.primogem || 0;
    player.wishTicket += reward.wishTicket || 0;
    return { leveled: true, adventureRank: player.adventureRank, worldLevel, reward };
  }
  return { leveled: false, adventureRank: player.adventureRank, worldLevel };
}

/** Distribute XP to the active party. */
export async function grantPartyXp(player, amount) {
  const out = [];
  for (const charId of player.party || []) {
    const inst = player.characters[charId];
    if (!inst) continue;
    const cap = Math.min(maxCharLevel(inst.ascension), arCap(player.adventureRank));
    if (inst.level >= cap) continue;
    let level = inst.level;
    let xp = inst.xp + amount;
    let leveled = false;
    while (level < cap) {
      const need = xpForLevel(level);
      if (xp < need) break;
      xp -= need;
      level++;
      leveled = true;
    }
    if (level >= cap) xp = 0;
    inst.level = level;
    inst.xp = xp;
    await repo.upsertCharacter(player.playerId, inst);
    if (leveled) out.push({ charId, level });
  }
  return out;
}

/**
 * Pay for one dead enemy: items, mora, adventure xp, party xp, quest progress.
 *
 * One function because there are two callers — `world/manager.handleKill` for the
 * gateway and `POST /api/world/kill` for a 单机 client whose simulation runs in the
 * browser — and the last time two paths granted the same reward independently, one
 * of them silently paid twice. `loot` must come from `rollEnemyLoot` on this side of
 * the wire; nothing here is taken from a request body.
 */
export async function grantKillRewards(player, enemy, loot) {
  const items = { ...loot.items, mora: loot.mora };
  await repo.addItems(player.playerId, items);
  player.mora += loot.mora;
  for (const [k, v] of Object.entries(loot.items)) player.inventory[k] = (player.inventory[k] || 0) + v;

  const ar = await grantAdventureXp(player, Math.round(loot.xp * 0.35));
  const levels = await grantPartyXp(player, loot.xp);

  // One call per event kind: a stage with `target: 'any'` matches every event of its
  // kind, so a second pass with `target: 'any'` counted each kill twice and cleared
  // the "defeat 12 enemies" daily after six.
  const questUpdates = await advanceQuests(player, { kind: 'kill', target: enemy, count: 1 });
  for (const [itemId, n] of Object.entries(loot.items)) {
    questUpdates.push(...await advanceQuests(player, { kind: 'collect', target: itemId, count: n }));
  }
  return { items, ar, levels, questUpdates };
}

/* ---------------------------------------------------------------- chambers -- */

/**
 * Bank one cleared 秘境 floor: the record, the one-time star milestone, the resin-paid
 * drop, the leaderboard totals and the quest event.
 *
 * One function because there are two callers again — `world/manager.handleChamberClear`
 * for the gateway and `POST /api/world/chamber` for a 单机 client — and this pair had
 * already drifted twice: the route once paid the milestone unconditionally on top of the
 * gateway's (two payouts per fight), and it never touched the Redis leaderboard at all,
 * so a solo player's abyss stars were missing from the live board until their next kill.
 *
 * The two rewards answer to different rules, which is the whole reason resin can be
 * charged here at all:
 *   - stars are progress, paid once per newly earned star, free;
 *   - the drop is farm, paid on every clear, and costs `DOMAIN_RESIN`.
 * A player with no resin still gets the stars, the record and the xp — they just do not
 * get the drop, and are told which of the two happened (`resin.short`).
 */
export async function grantChamberClear(player, zoneId, floor, time, stars) {
  const zdef = ZONES[zoneId];
  const cdef = (zdef?.chambers || []).find((c) => c.floor === floor);
  const level = cdef?.level ?? floor * 8;

  await repo.saveChamber(player.playerId, zoneId, floor, stars, time);
  player.abyss[zoneId] = player.abyss[zoneId] || {};
  const prev = player.abyss[zoneId][floor]?.stars || 0;
  const prevBest = player.abyss[zoneId][floor]?.bestTime ?? 1e9;
  player.abyss[zoneId][floor] = { stars: Math.max(prev, stars), bestTime: Math.min(prevBest, time) };

  // Everything about *what a new star is worth* is derived in one shared place, because the
  // pay-per-visit version of this block handed out a full floor's mora and a full clear's xp
  // on every improvement: three slow clears of floor 8 paid three times 24 000 mora for one
  // floor. `chamberMilestone` prices each star as a share of the floor's own total, so 1★
  // then 2★ then 3★ costs the economy exactly what a single 3★ clear costs it.
  const ms = chamberMilestone(cdef || { floor, level }, prev, stars);
  const gained = ms.gained;
  const reward = ms.reward;
  let ar = null, partyLevels = null;
  if (gained > 0) {
    await repo.addItems(player.playerId, reward);
    player.primogem += reward.primogem;
    player.mora += reward.mora;
    ar = await grantAdventureXp(player, ms.xp.adventure);
    partyLevels = await grantPartyXp(player, ms.xp.party);
  }

  // The drop. Resin regen is lazy (`regenResin` is applied when the player is loaded),
  // so the balance in hand is already current here.
  const cost = zdef?.domain ? (zdef.domain.resin ?? DOMAIN_RESIN) : 0;
  let drops = null;
  const resin = { cost, spent: 0, left: player.resin, short: false };
  if (cost > 0) {
    if (player.resin < cost) {
      resin.short = true;
    } else {
      player.resin -= cost;
      resin.spent = cost;
      resin.left = player.resin;
      await repo.savePlayerCore(player.playerId, { resin: player.resin });
      drops = rollDomainReward(zdef, floor, level, (player.playerId * 7919 + Date.now()) >>> 0);
      await repo.addItems(player.playerId, { ...drops.items, mora: drops.mora });
      player.mora += drops.mora;
      for (const [id, n] of Object.entries(drops.items)) {
        player.inventory[id] = (player.inventory[id] || 0) + n;
      }
      for (const a of drops.artifacts) {
        await repo.addEquipment(player.playerId, a);
        player.equipment.push({ ...a, equippedBy: null });
      }
    }
  }

  let totalStars = 0, maxFloor = 0;
  for (const floors of Object.values(player.abyss)) {
    for (const [f, rec] of Object.entries(floors)) {
      totalStars += rec.stars;
      maxFloor = Math.max(maxFloor, Number(f));
    }
  }
  await repo.updateLeaderboard(player.playerId, player.nickname, {
    score: player.adventureXp, abyssFloor: maxFloor, abyssStars: totalStars,
  });
  await bumpLeaderboard(player.playerId, player.nickname, { abyss: totalStars });

  const questUpdates = await advanceQuests(player, { kind: 'chamber', target: `${zoneId}:${floor}`, count: 1 });
  return { stars, gained, reward, drops, resin, ar, partyLevels, questUpdates, totalStars, maxFloor };
}

/* ----------------------------------------------------------------- quests -- */

/**
 * Lifetime tallies for achievements, bumped here because this is the one function every
 * gameplay event already flows through — eight call sites, one hook, no chance of a kind being
 * counted in seven of them.
 *
 * Only the kinds in `LIFETIME_EVENTS` are tallied; kills, chests, puzzles, waypoints and
 * chambers are counted by tables that already exist and are read back as aggregates
 * (`repo.achSnapshot`), so tallying them here as well would be a second, disagreeing copy.
 * The write is an in-SQL increment, and the in-memory player is patched with the returned
 * total so the object the caller goes on to mirror is not stale.
 */
async function bumpLifetimeFor(player, event, trusted) {
  // `POST /api/quest/event` hands this function a `{kind, target, count}` straight out of a
  // request body — it exists so a 单机 client whose simulation runs in the browser can report
  // what happened. That is tolerable for quest counters, which only unlock rewards the quest
  // itself defines, and is *not* tolerable for a lifetime tally that achievements pay
  // primogems for: `{kind:'cook', count:99}` in a loop would be a printing press. So the
  // tally is only written for events this server produced after validating the action (a real
  // recipe with the ingredients spent, a node inside reach, an NPC that exists).
  if (!trusted) return;
  const key = LIFETIME_EVENTS[event?.kind];
  if (!key) return;
  const n = Math.max(1, Math.round(event.count || 1));
  const total = await repo.bumpLifetime(player.playerId, key, n);
  if (total !== null) player.stats = { ...(player.stats || {}), [key]: total };
}

/**
 * Feed a gameplay event into quest progress.
 * event: { kind, target, count }
 * Returns array of updates: { questId, stageIndex, done, rewards }
 */
export async function advanceQuests(player, event, { trusted = true } = {}) {
  await bumpLifetimeFor(player, event, trusted);
  // Before anything is matched: if the clock has rolled past 04:00 since these rows were
  // written, today's dailies are the ones this kill counts toward, not yesterday's finished
  // ones. Doing it here rather than on a timer means it also happens for a player who was
  // offline across the boundary, and it costs a string compare when nothing is stale.
  await rollDailies(player);
  const updates = [];
  for (const [questId, st] of Object.entries(player.quests || {})) {
    if (st.state !== 'active') continue;
    const def = QUESTS[questId];
    if (!def) continue;
    const stage = def.stages[st.stageIndex || 0];
    if (!stage) continue;
    if (!stageMatches(stage, event)) continue;

    const key = stage.id;
    const need = stage.count || 1;
    const have = Math.min(need, (st.counters[key] || 0) + (event.count || 1));
    st.counters = { ...st.counters, [key]: have };

    let stageDone = have >= need;
    let questDone = false;
    let rewards = null;
    let next = null;
    if (stageDone) {
      st.stageIndex = (st.stageIndex || 0) + 1;
      if (st.stageIndex >= def.stages.length) {
        st.state = 'done';
        questDone = true;
        rewards = await grantQuestRewards(player, def);
        if (def.next && QUESTS[def.next]) {
          if (!player.quests[def.next]) {
            player.quests[def.next] = { state: 'active', stageIndex: 0, counters: {} };
            await repo.saveQuest(player.playerId, def.next, player.quests[def.next]);
          }
          // The follow-up travels *with* the completion, record and all. Without it the client
          // knew only that this quest was done: the next one existed in the database and in
          // nobody's session, so the tracker went quiet and the story stalled until a reload —
          // the same class of bug as a join snapshot that stops being live.
          const nd = QUESTS[def.next];
          next = {
            id: def.next, name: nd.name, chapter: nd.chapter || null, intro: nd.intro || null,
            stageDesc: nd.stages?.[0]?.desc || null,
            rec: { ...player.quests[def.next] },
          };
        }
      }
    }
    await repo.saveQuest(player.playerId, questId, st);
    updates.push({
      questId, name: def.name, stageIndex: st.stageIndex, stageDone, done: questDone,
      progress: { key, have, need },
      stageDesc: def.stages[st.stageIndex]?.desc || null,
      rewards,
      // Presentation for the completion screen. The client owns *whether* to show one
      // (`questHasEnding`); this is the copy it would otherwise have to look up twice.
      ...(questDone ? { chapter: def.chapter || null, type: def.type, outro: def.outro || null, next } : {}),
    });
  }
  return updates;
}

async function grantQuestRewards(player, def) {
  const r = def.rewards || {};
  const items = {};
  if (r.mora) items.mora = r.mora;
  if (r.primogem) items.primogem = r.primogem;
  for (const [id, n] of r.items || []) items[id] = (items[id] || 0) + n;
  await repo.addItems(player.playerId, items);
  player.mora += r.mora || 0;
  player.primogem += r.primogem || 0;
  for (const [id, n] of r.items || []) {
    if (id === 'wishTicket') player.wishTicket += n;
    else player.inventory[id] = (player.inventory[id] || 0) + n;
  }
  if (r.xp) await grantAdventureXp(player, r.xp);
  return { ...r };
}

/**
 * Roll over any daily whose row belongs to a period that has ended.
 *
 * There is deliberately no route that does this and no timer that does this. The old
 * `POST /api/quest/dailies/reset` did both jobs badly: a player offline at 04:00 never got a
 * refresh, and anyone who did call it got the 20-primogem reward again, because a finished
 * daily row *is* the receipt for today's payout. The period key decides instead
 * (`quests.dailiesToRoll`), which is the same rule the shop's stock limits and the daily login
 * mail already follow — one source of truth about the clock, and rolling over is idempotent.
 *
 * Called from `advanceQuests` (so an event lands in the right day) and from `GET /api/quests`
 * (so the panel shows the new day even if the player has not done anything yet).
 */
export async function rollDailies(player, now = Date.now()) {
  const stale = dailiesToRoll(player.quests || {}, now);
  if (!stale.length) return [];
  player.quests = player.quests || {};
  for (const id of stale) {
    player.quests[id] = { state: 'active', stageIndex: 0, counters: {} };
    await repo.saveQuest(player.playerId, id, player.quests[id]);   // stamps `at` with the write
  }
  return stale;
}
