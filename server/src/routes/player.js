import { z } from 'zod';
import { requireAuth } from '../auth.js';
import * as repo from '../db/repo.js';
import * as cache from '../services/playerCache.js';
import * as prog from '../services/progression.js';
import {
  partyStats, enhanceArtifact, artifactFodderXp, artifactXpToCap, artifactLevelCost,
  ARTIFACT_LEVEL_CAP, ARTIFACT_MORA_PER_XP,
  levelUpWeapon, weaponCapFor, weaponXpToLevel, oreXp, canRefineWith,
  WEAPON_ORE, WEAPON_MORA_PER_XP, WEAPON_REFINE_MAX,
} from '@teyvat/shared/sim/loot.js';
import { CHARACTERS } from '@teyvat/shared/data/characters.js';
import { ARTIFACT_SLOTS, WEAPONS } from '@teyvat/shared/data/items.js';
import { QUESTS } from '@teyvat/shared/data/quests.js';
import { periodEndsAt } from '@teyvat/shared/sim/clock.js';
import { RECIPES, cook, maxPortions } from '@teyvat/shared/data/recipes.js';
import { world } from '../world/manager.js';
import crypto from 'node:crypto';

export default async function playerRoutes(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/player') && !req.url.startsWith('/api/char')
      && !req.url.startsWith('/api/inventory') && !req.url.startsWith('/api/quest')) return;
    return requireAuth(req, reply);
  });

  /** Full save state, plus derived combat stats so the client doesn't recompute blindly. */
  app.get('/api/player/state', async (req, reply) => {
    const p = await cache.getPlayer(req.user.playerId, { fresh: true });
    if (!p) return reply.code(404).send({ error: 'no_player' });
    return { player: publicPlayer(p), stats: publishStats(p) };
  });

  app.post('/api/player/save', async (req, reply) => {
    const schema = z.object({
      zone: z.string().max(40).optional(),
      pos: z.object({ x: z.number(), y: z.number(), z: z.number(), ry: z.number().optional() }).optional(),
      party: z.array(z.string()).max(4).optional(),
      activeSlot: z.number().int().min(0).max(3).optional(),
      settings: z.record(z.any()).optional(),
      playtimeSec: z.number().int().min(0).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });
    const body = parsed.data;
    if (body.party) {
      const valid = body.party.filter((c) => p.characters[c]);
      if (valid.length) p.party = valid;
    }
    if (body.zone) p.zone = body.zone;
    if (body.pos) p.pos = body.pos;
    if (body.activeSlot !== undefined) p.activeSlot = Math.min(body.activeSlot, (p.party?.length || 1) - 1);
    if (body.settings) p.settings = { ...p.settings, ...body.settings };
    if (body.playtimeSec) p.playtimeSec = Math.max(p.playtimeSec, body.playtimeSec);
    cache.markDirty(p.playerId);
    await cache.flush(p.playerId, true);
    // This route answers `{ok:true}` and no stats, but it is allowed to *set the party* —
    // so the running fight still has to hear about it, or the team the panel shows and the
    // team the simulation lets the player switch to are two different lists.
    if (body.party) publishStats(p);
    return { ok: true };
  });

  app.post('/api/player/party', async (req, reply) => {
    const schema = z.object({ party: z.array(z.string()).min(1).max(4) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const p = await cache.getPlayer(req.user.playerId);
    const valid = [...new Set(parsed.data.party)].filter((c) => p.characters[c]);
    if (!valid.length) return reply.code(400).send({ error: 'no_valid_characters' });
    p.party = valid;
    p.activeSlot = 0;
    cache.markDirty(p.playerId);
    await cache.flush(p.playerId, true);
    return { party: p.party, stats: publishStats(p) };
  });

  /* ------------------------------------------------------- character growth -- */

  app.post('/api/char/levelup', async (req, reply) => {
    const schema = z.object({ charId: z.string(), materials: z.record(z.number().int().min(0)) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const p = await cache.getPlayer(req.user.playerId);
    const r = await prog.levelUpCharacter(p, parsed.data.charId, parsed.data.materials);
    if (r.error) return reply.code(400).send(r);
    await cache.mirror(p.playerId, p);
    return { ...r, player: publicPlayer(p), stats: publishStats(p) };
  });

  app.post('/api/char/ascend', async (req, reply) => {
    const p = await cache.getPlayer(req.user.playerId);
    const r = await prog.ascendCharacter(p, String(req.body?.charId || ''));
    if (r.error) return reply.code(400).send(r);
    await cache.mirror(p.playerId, p);
    return { ...r, player: publicPlayer(p), stats: publishStats(p) };
  });

  app.post('/api/char/talent', async (req, reply) => {
    const p = await cache.getPlayer(req.user.playerId);
    const r = await prog.upgradeTalent(p, String(req.body?.charId || ''), String(req.body?.which || ''));
    if (r.error) return reply.code(400).send(r);
    await cache.mirror(p.playerId, p);
    return { ...r, player: publicPlayer(p), stats: publishStats(p) };
  });

  /* -------------------------------------------------------------- equipment -- */

  app.post('/api/char/equip', async (req, reply) => {
    const schema = z.object({
      charId: z.string(),
      uid: z.string(),
      slot: z.enum(['weapon', ...ARTIFACT_SLOTS]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { charId, uid, slot } = parsed.data;
    const p = await cache.getPlayer(req.user.playerId);
    const inst = p.characters[charId];
    if (!inst) return reply.code(400).send({ error: 'character_not_owned' });
    const item = p.equipment.find((e) => e.uid === uid);
    if (!item) return reply.code(404).send({ error: 'item_not_found' });

    if (slot === 'weapon') {
      if (item.kind !== 'weapon') return reply.code(400).send({ error: 'not_a_weapon' });
      const wdef = WEAPONS[item.weaponId];
      if (!wdef || wdef.type !== CHARACTERS[charId].weapon) {
        return reply.code(400).send({ error: 'wrong_weapon_type', need: CHARACTERS[charId].weapon });
      }
      // Unequip from whoever had it.
      for (const other of Object.values(p.characters)) {
        if (other.charId !== charId && other.weapon?.uid === uid) {
          other.weapon = null;
          await repo.upsertCharacter(p.playerId, other);
        }
      }
      inst.weapon = item;
    } else {
      if (item.kind !== 'artifact') return reply.code(400).send({ error: 'not_an_artifact' });
      if (item.slot !== slot) return reply.code(400).send({ error: 'wrong_slot', expected: item.slot });
      for (const other of Object.values(p.characters)) {
        if (other.charId !== charId && other.artifacts?.[slot]?.uid === uid) {
          delete other.artifacts[slot];
          await repo.upsertCharacter(p.playerId, other);
        }
      }
      inst.artifacts = { ...inst.artifacts, [slot]: item };
    }
    item.equippedBy = charId;
    await repo.setEquippedBy(p.playerId, uid, charId);
    await repo.upsertCharacter(p.playerId, inst);
    await cache.mirror(p.playerId, p);
    return { ok: true, stats: publishStats(p), player: publicPlayer(p) };
  });

  app.post('/api/char/unequip', async (req, reply) => {
    const schema = z.object({ charId: z.string(), slot: z.enum(['weapon', ...ARTIFACT_SLOTS]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const p = await cache.getPlayer(req.user.playerId);
    const inst = p.characters[parsed.data.charId];
    if (!inst) return reply.code(400).send({ error: 'character_not_owned' });
    if (parsed.data.slot === 'weapon') {
      if (inst.weapon) { await repo.setEquippedBy(p.playerId, inst.weapon.uid, null); inst.weapon.equippedBy = null; }
      inst.weapon = null;
    } else {
      const a = inst.artifacts?.[parsed.data.slot];
      if (a) { await repo.setEquippedBy(p.playerId, a.uid, null); a.equippedBy = null; delete inst.artifacts[parsed.data.slot]; }
    }
    await repo.upsertCharacter(p.playerId, inst);
    await cache.mirror(p.playerId, p);
    return { ok: true, stats: publishStats(p), player: publicPlayer(p) };
  });

  /** Best-in-slot auto-equip: convenience so new players aren't stat-starved. */
  app.post('/api/char/autoequip', async (req, reply) => {
    const p = await cache.getPlayer(req.user.playerId);
    const charId = String(req.body?.charId || '');
    const inst = p.characters[charId];
    if (!inst) return reply.code(400).send({ error: 'character_not_owned' });
    const taken = new Set();
    for (const c of Object.values(p.characters)) {
      if (c.charId === charId) continue;
      if (c.weapon?.uid) taken.add(c.weapon.uid);
      for (const a of Object.values(c.artifacts || {})) taken.add(a.uid);
    }
    // Taking a slot means letting go of what was in it. `/api/char/equip` above does this on the
    // manual path; forgetting it here left rows that claimed an owner nobody was wearing them
    // for — two five-slot characters reported fourteen equipped pieces — and `equippedBy` is a
    // refusal in five places (bulk salvage, enhancement fodder, the bag's 装备中 badge and its
    // two pickers). The spare became a piece the player could neither wear nor spend.
    const release = async (uid, keep) => {
      if (!uid || uid === keep) return;
      const row = p.equipment.find((e) => e.uid === uid);
      if (row) row.equippedBy = null;
      await repo.setEquippedBy(p.playerId, uid, null);
    };
    // Weapon: highest rarity+level matching type.
    const wType = CHARACTERS[charId].weapon;
    const weapons = p.equipment.filter((e) => e.kind === 'weapon' && !taken.has(e.uid) && WEAPONS[e.weaponId]?.type === wType);
    weapons.sort((a, b) => (WEAPONS[b.weaponId].rarity - WEAPONS[a.weaponId].rarity) || (b.level - a.level));
    if (weapons[0]) {
      await release(inst.weapon?.uid, weapons[0].uid);
      inst.weapon = weapons[0]; weapons[0].equippedBy = charId; await repo.setEquippedBy(p.playerId, weapons[0].uid, charId);
    }
    // Artifacts: highest level per slot.
    const arts = { ...inst.artifacts };
    for (const slot of ARTIFACT_SLOTS) {
      const pool = p.equipment.filter((e) => e.kind === 'artifact' && e.slot === slot && !taken.has(e.uid));
      pool.sort((a, b) => (b.rarity - a.rarity) || (b.level - a.level));
      if (pool[0]) {
        await release(arts[slot]?.uid, pool[0].uid);
        arts[slot] = pool[0]; pool[0].equippedBy = charId; await repo.setEquippedBy(p.playerId, pool[0].uid, charId);
      }
    }
    inst.artifacts = arts;
    await repo.upsertCharacter(p.playerId, inst);
    await cache.mirror(p.playerId, p);
    return { ok: true, stats: publishStats(p), player: publicPlayer(p) };
  });

  /* -------------------------------------------------------------- inventory -- */

  app.post('/api/inventory/use', async (req, reply) => {
    const schema = z.object({ itemId: z.string(), count: z.number().int().min(1).max(99).default(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { MATERIALS } = await import('@teyvat/shared/data/items.js');
    const def = MATERIALS[parsed.data.itemId];
    if (!def || def.kind !== 'consumable') return reply.code(400).send({ error: 'not_consumable' });
    const p = await cache.getPlayer(req.user.playerId);
    const have = p.inventory[def.id] || 0;
    const use = Math.min(have, parsed.data.count);
    if (use <= 0) return reply.code(400).send({ error: 'none_left' });
    await repo.addItems(p.playerId, { [def.id]: -use });
    p.inventory[def.id] = have - use;
    if (def.resin) {
      p.resin = Math.min(200, p.resin + def.resin * use);
      await repo.savePlayerCore(p.playerId, { resin: p.resin });
    }
    await cache.mirror(p.playerId, p);
    return { ok: true, used: use, effect: { heal: def.heal, buff: def.buff, revive: def.revive, resin: def.resin }, player: publicPlayer(p) };
  });

  /**
   * Cook a dish.
   *
   * Server-side because it mints items out of other items: the quality roll, the
   * ingredient charge and the rank gate all have to be somewhere the client cannot
   * reach. The client's cooking panel calls `maxPortions` from the same shared table
   * to grey out what is unaffordable, so a rejection here means either a stale
   * inventory or someone poking the endpoint.
   */
  app.post('/api/player/cook', async (req, reply) => {
    const schema = z.object({
      recipeId: z.string().max(40),
      count: z.number().int().min(1).max(20).default(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const recipe = RECIPES[parsed.data.recipeId];
    if (!recipe) return reply.code(404).send({ error: 'no_such_recipe' });

    const p = await cache.getPlayer(req.user.playerId);
    if (p.adventureRank < recipe.rank) {
      return reply.code(403).send({ error: 'recipe_locked', need: recipe.rank });
    }
    // Clamp rather than reject: a batch of five when the player can afford three is
    // a stale panel, and cooking three is what they wanted.
    const afford = maxPortions(recipe.id, p.inventory, parsed.data.count);
    if (afford <= 0) return reply.code(400).send({ error: 'missing_ingredients' });

    const res = cook(recipe.id, afford, p.adventureRank, crypto.randomInt(0, 2 ** 31 - 1));
    const delta = {};
    for (const [id, n] of Object.entries(res.consumed)) delta[id] = -n;
    for (const [id, n] of Object.entries(res.gained)) delta[id] = (delta[id] || 0) + n;
    await repo.addItems(p.playerId, delta);
    for (const [id, n] of Object.entries(delta)) {
      p.inventory[id] = Math.max(0, (p.inventory[id] || 0) + n);
    }
    // One call: a stage with `target: 'any'` matches every event of its kind, so a
    // second 'any' pass would double-count.
    const questUpdates = await prog.advanceQuests(p, { kind: 'cook', target: recipe.id, count: afford });
    await cache.mirror(p.playerId, p);
    return {
      ok: true, cooked: afford, tally: res.tally, gained: res.gained, consumed: res.consumed,
      questUpdates, player: publicPlayer(p),
    };
  });

  app.post('/api/inventory/salvage', async (req, reply) => {
    const schema = z.object({ uids: z.array(z.string()).min(1).max(50) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const p = await cache.getPlayer(req.user.playerId);
    const set = new Set(parsed.data.uids);
    const removable = p.equipment.filter((e) => set.has(e.uid) && !e.equippedBy && !e.locked);
    if (!removable.length) return reply.code(400).send({ error: 'nothing_salvageable' });
    let mora = 0;
    for (const e of removable) mora += e.kind === 'artifact' ? 400 + e.level * 120 : 900;
    await repo.deleteEquipment(p.playerId, removable.map((e) => e.uid));
    await repo.addItems(p.playerId, { mora });
    p.mora += mora;
    p.equipment = p.equipment.filter((e) => !removable.some((r) => r.uid === e.uid));
    await cache.mirror(p.playerId, p);
    return { ok: true, salvaged: removable.length, mora, player: publicPlayer(p) };
  });

  /**
   * Lock a piece against being destroyed.
   *
   * `locked` has been on every artifact and weapon since they were first generated, and
   * both `salvage` and `enhance` refuse to touch a locked one — but nothing could ever
   * set it, so the flag was a promise with no way to make it. It matters most now that
   * enhancement eats artifacts by the handful: the 5★ piece you are saving for the set
   * bonus needs to be un-clickable, not merely un-clicked.
   */
  app.post('/api/inventory/lock', async (req, reply) => {
    const schema = z.object({ uid: z.string(), locked: z.boolean() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });
    const item = p.equipment.find((e) => e.uid === parsed.data.uid);
    if (!item) return reply.code(404).send({ error: 'item_not_found' });
    item.locked = parsed.data.locked;
    await repo.addEquipment(p.playerId, item);
    await cache.mirror(p.playerId, p);
    return { ok: true, uid: item.uid, locked: item.locked, player: publicPlayer(p) };
  });

  /**
   * Feed spare artifacts into one you want to keep.
   *
   * Only as much fodder as the piece can actually absorb is consumed: the list is walked
   * in order and stops the moment the accumulated xp would carry it to +20, so asking to
   * enhance a +19 piece with ten 5★ pieces spends one and leaves nine in the bag. Anything
   * else would let a mis-click destroy a stack of artifacts for xp that has nowhere to go,
   * and the client cannot compute the stopping point itself without duplicating the cost
   * curve — which is exactly the kind of second copy that drifts.
   *
   * Mora is charged on xp *spent*, not xp offered, for the same reason.
   */
  app.post('/api/inventory/enhance', async (req, reply) => {
    const schema = z.object({ uid: z.string(), fodder: z.array(z.string()).min(1).max(20) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { uid, fodder } = parsed.data;
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });

    const target = p.equipment.find((e) => e.uid === uid);
    if (!target) return reply.code(404).send({ error: 'item_not_found' });
    if (target.kind !== 'artifact') return reply.code(400).send({ error: 'not_an_artifact' });
    if ((target.level || 0) >= ARTIFACT_LEVEL_CAP) {
      return reply.code(400).send({ error: 'already_max', cap: ARTIFACT_LEVEL_CAP });
    }

    // The target is never its own fodder, and neither is anything worn or locked.
    const want = [...new Set(fodder)].filter((u) => u !== uid);
    const need = artifactXpToCap(target);
    const use = [];
    let xp = 0;
    for (const u of want) {
      if (xp >= need) break;
      const e = p.equipment.find((x) => x.uid === u);
      if (!e || e.kind !== 'artifact' || e.equippedBy || e.locked) continue;
      use.push(e);
      xp += artifactFodderXp(e);
    }
    if (!use.length) return reply.code(400).send({ error: 'no_usable_fodder' });

    const r = enhanceArtifact(target, xp, crypto.randomInt(0, 2 ** 31 - 1));
    if (r.levels <= 0) {
      return reply.code(400).send({
        error: 'not_enough_xp', have: xp, need: artifactLevelCost(target.rarity, target.level || 0),
      });
    }
    const moraCost = Math.round(r.spent * ARTIFACT_MORA_PER_XP);
    if (p.mora < moraCost) return reply.code(400).send({ error: 'not_enough_mora', need: moraCost });

    // The artifact object is shared by reference with `characters[x].artifacts[slot]`
    // (`repo.getPlayer` builds both from one `equipByUid` map), so mutating it in place is
    // what makes an enhanced piece show up in the wearer's stats without a re-fetch.
    Object.assign(target, r.artifact);
    await repo.addEquipment(p.playerId, target);
    await repo.deleteEquipment(p.playerId, use.map((e) => e.uid));
    const gone = new Set(use.map((e) => e.uid));
    p.equipment = p.equipment.filter((e) => !gone.has(e.uid));
    await repo.addItems(p.playerId, { mora: -moraCost });
    p.mora -= moraCost;
    await cache.mirror(p.playerId, p);

    return {
      ok: true, artifact: target, from: r.from, level: r.level, levels: r.levels,
      gains: r.gains, newSubs: r.newSubs, consumed: use.length, xpSpent: r.spent,
      xpWasted: r.xpLeft, moraCost, stats: publishStats(p), player: publicPlayer(p),
    };
  });

  /**
   * Feed ore to a weapon.
   *
   * Body shape mirrors `POST /api/char/levelup` (`{ uid, ore: { oreId: count } }` against
   * its `{ charId, materials }`) because it is the same transaction: hand over a pile of a
   * material with a published xp value, get levels and a banked remainder. The cap is
   * `weaponCapFor`, which is the rarity ceiling *and* `arCap` — the same adventure-rank
   * gate character levels obey, so a lucky 5-star pull cannot be mined to 90 in the
   * starter valley.
   *
   * Ore is spent cheapest-first and only up to what the weapon can still absorb, so a
   * player who offers their whole bag does not have starsilver eaten to finish a level
   * iron would have paid for. Mora is charged on xp actually handed over.
   */
  app.post('/api/inventory/weapon/levelup', async (req, reply) => {
    const schema = z.object({ uid: z.string(), ore: z.record(z.number().int().min(0)) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { uid, ore } = parsed.data;
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });

    const target = p.equipment.find((e) => e.uid === uid);
    if (!target) return reply.code(404).send({ error: 'item_not_found' });
    if (target.kind !== 'weapon') return reply.code(400).send({ error: 'not_a_weapon' });
    const cap = weaponCapFor(target, p.adventureRank);
    if ((target.level || 1) >= cap) return reply.code(400).send({ error: 'level_capped', cap });

    const rarity = WEAPONS[target.weaponId]?.rarity ?? 4;
    // What is still missing to reach `cap`, counting what is already banked on the weapon.
    const need = Math.max(0, weaponXpToLevel(rarity, cap) - weaponXpToLevel(rarity, target.level || 1) - (target.xp || 0));
    const spend = {};
    let xpGain = 0;
    for (const oreId of WEAPON_ORE) {
      if (xpGain >= need) break;
      const want = Math.floor(ore[oreId] || 0);
      if (want <= 0) continue;
      const have = p.inventory[oreId] || 0;
      const per = oreXp(oreId);
      const affordable = Math.min(want, have, Math.ceil((need - xpGain) / per));
      if (affordable <= 0) continue;
      spend[oreId] = -affordable;
      xpGain += affordable * per;
    }
    if (xpGain <= 0) return reply.code(400).send({ error: 'no_usable_ore', ore: WEAPON_ORE });

    const moraCost = Math.round(xpGain * WEAPON_MORA_PER_XP);
    if (p.mora < moraCost) return reply.code(400).send({ error: 'not_enough_mora', need: moraCost });

    const r = levelUpWeapon(target, xpGain, cap);
    // Same by-reference story as artifacts: `characters[x].weapon` and this entry of
    // `p.equipment` are one object, so mutating in place is what moves the wielder's atk.
    Object.assign(target, r.weapon);
    await repo.addEquipment(p.playerId, target);
    await repo.addItems(p.playerId, { ...spend, mora: -moraCost });
    p.mora -= moraCost;
    for (const [id, n] of Object.entries(spend)) p.inventory[id] = Math.max(0, (p.inventory[id] || 0) + n);
    await cache.mirror(p.playerId, p);

    return {
      ok: true, weapon: target, from: r.from, level: r.level, levels: r.levels,
      xp: r.xp, xpToNext: r.xpToNext, xpGain, cap, consumed: spend, moraCost,
      stats: publishStats(p), player: publicPlayer(p),
    };
  });

  /**
   * Refine a weapon with duplicates of itself.
   *
   * This is the use for duplicate weapons out of the wish pool, which until now went into
   * the bag and stayed there — `refinement` was written by `makeWeapon`, promised by the
   * README and read by nothing. One duplicate is one rank, up to `WEAPON_REFINE_MAX`, and
   * rank 5 doubles the passive (`refineMul`); `weaponStats` applies it, so every consumer
   * of a weapon passive — server sim, browser sim, stat panel — gets it from one place.
   *
   * Duplicates are consumed one rank at a time and no further than the cap, for the same
   * reason enhancement stops when the target is full: offering four dupes to an R4 weapon
   * must cost one, not four.
   */
  app.post('/api/inventory/weapon/refine', async (req, reply) => {
    // 20, not 4: four copies is the most this can *consume* (R1 → R5), but the panel offers
    // every duplicate the bag holds, and locked or equipped copies in that list are skipped
    // rather than counted. Bounding the request at the consumption limit turned a player
    // with five spares into `invalid_input` — the button simply stopped working. The loop
    // below is what enforces the cap; the schema only has to keep the array sane.
    const schema = z.object({ uid: z.string(), fodder: z.array(z.string()).min(1).max(20) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { uid, fodder } = parsed.data;
    const p = await cache.getPlayer(req.user.playerId);
    if (!p) return reply.code(404).send({ error: 'no_player' });

    const target = p.equipment.find((e) => e.uid === uid);
    if (!target) return reply.code(404).send({ error: 'item_not_found' });
    if (target.kind !== 'weapon') return reply.code(400).send({ error: 'not_a_weapon' });
    if ((target.refinement || 1) >= WEAPON_REFINE_MAX) {
      return reply.code(400).send({ error: 'already_max', cap: WEAPON_REFINE_MAX });
    }

    const use = [];
    let rank = target.refinement || 1;
    for (const u of [...new Set(fodder)].filter((x) => x !== uid)) {
      if (rank >= WEAPON_REFINE_MAX) break;
      const e = p.equipment.find((x) => x.uid === u);
      if (!canRefineWith({ ...target, refinement: rank }, e)) continue;
      use.push(e);
      rank++;
    }
    if (!use.length) return reply.code(400).send({ error: 'no_usable_dupe', weaponId: target.weaponId });

    const before = target.refinement || 1;
    target.refinement = rank;
    await repo.addEquipment(p.playerId, target);
    await repo.deleteEquipment(p.playerId, use.map((e) => e.uid));
    const gone = new Set(use.map((e) => e.uid));
    p.equipment = p.equipment.filter((e) => !gone.has(e.uid));
    await cache.mirror(p.playerId, p);

    return {
      ok: true, weapon: target, from: before, refinement: rank, consumed: use.length,
      cap: WEAPON_REFINE_MAX, stats: publishStats(p), player: publicPlayer(p),
    };
  });

  /* ----------------------------------------------------------------- quests -- */

  // There is no `POST /api/quest/event` and no `POST /api/quest/dailies/reset`, and both
  // absences are load-bearing. The first took `{kind, target, count}` out of a request body so
  // a 单机 client could report what happened — but every kind a stage waits on already has a
  // route that validates the action first (`quests.QUEST_EVENT_SOURCES` names them, and
  // `questGateReport()` fails if one is missing), so the body-driven route was a second door
  // into quest rewards worth 20–120 primogems each. The second re-armed the dailies on demand,
  // which paid their reward again every time it was called; the rows now roll over by period
  // key instead (`progression.rollDailies`), which also covers a player who was offline at
  // 04:00 — something the route never did.
  app.get('/api/quests', async (req) => {
    const p = await cache.getPlayer(req.user.playerId);
    // Read is the trigger: opening the panel after 04:00 shows today's commissions even if the
    // player has not swung at anything yet.
    const rolled = await prog.rollDailies(p);
    const out = [];
    for (const [id, st] of Object.entries(p.quests || {})) {
      const def = QUESTS[id];
      if (!def) continue;
      out.push({
        id, name: def.name, type: def.type, chapter: def.chapter || null,
        state: st.state, stageIndex: st.stageIndex,
        stages: def.stages.map((s, i) => ({
          id: s.id, desc: s.desc, count: s.count || 1,
          have: st.counters?.[s.id] || 0,
          done: i < st.stageIndex,
        })),
        rewards: def.rewards, zone: def.zone || null, minLevel: def.minLevel || 1,
        intro: def.intro || null, giver: def.giver || null,
      });
    }
    // `dailyResetAt` is for a countdown, never for a limit check — the key decides that.
    return { quests: out, dailyResetAt: periodEndsAt('daily'), rolled };
  });
}

/* ------------------------------------------------------------------ shaping -- */

export function publicPlayer(p) {
  return {
    playerId: p.playerId, nickname: p.nickname,
    adventureRank: p.adventureRank, adventureXp: p.adventureXp, worldLevel: p.worldLevel,
    mora: p.mora, primogem: p.primogem, wishTicket: p.wishTicket, resin: p.resin,
    zone: p.zone, pos: p.pos, party: p.party, activeSlot: p.activeSlot,
    characters: p.characters, inventory: p.inventory, equipment: p.equipment,
    quests: p.quests, worldProgress: p.worldProgress, abyss: p.abyss,
    wishState: p.wishState, settings: p.settings, playtimeSec: p.playtimeSec,
  };
}

/**
 * Pure derivation: the stat block of every owned character.
 *
 * Only two callers may use this directly, and both of them build stats for a player who
 * has no live entity yet: `ws/gateway.js` when the socket joins a zone, and this file's
 * `publishStats`. Anything else — every route that answers a build change with a `stats`
 * field — must go through `publishStats`, because the panel is not the only reader of
 * these numbers; see below. `tools/build-check.mjs` enforces that.
 */
export function derivedStats(p) {
  // `partyStats` is the loop plus the party's 元素共鸣 folded into the four characters
  // standing in it. It is shared rather than written here because the browser's 单机 host
  // builds the same numbers, and a team bonus that only exists on one host is a fork.
  return partyStats(p.characters, p.party);
}

/**
 * Derive the stats *and* hand them to the running simulation.
 *
 * `PlayerEntity.stats` and `PlayerEntity.party` are snapshots taken when the socket
 * joined a zone, and every single thing the game asks a player to do to their build —
 * level, ascend, talent, equip, unequip, autoequip, enhance an artifact, level or refine a
 * weapon, edit the party — is an HTTP route that mutates the saved document and answers
 * with new numbers for the panel. For as long as that was the whole story, the entire
 * progression loop was cosmetic mid-session: a starter 伊格纳 levelled 1 → 17 during a
 * fight showed 2460 hp in the panel and kept fighting with 1290, and a character dropped
 * from the party could still be switched to. The fix is one function, not a line at the
 * end of eleven routes — a route that forgets it is a route whose rewards do nothing, and
 * that is exactly the shape of bug that got missed for this long.
 */
export function publishStats(p, opts = {}) {
  const stats = derivedStats(p);
  world.refreshBuild(p.playerId, stats, p.party, opts);
  return stats;
}
