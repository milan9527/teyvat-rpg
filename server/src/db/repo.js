// Repository: all SQL for player save/load, with Redis write-behind caching.

import { q, one, many, tx } from './pg.js';
import { redis, RK, invalidate } from './redis.js';
import { STARTER_PARTY, CHARACTERS, MAX_CONSTELLATION } from '@teyvat/shared/data/characters.js';
import { makeWeapon, generateArtifact } from '@teyvat/shared/sim/loot.js';
import { DAILY_IDS } from '@teyvat/shared/data/quests.js';
import { welcomeMail, MAIL_TTL_DAYS } from '@teyvat/shared/data/mail.js';
import { explorationSummary } from '@teyvat/shared/data/exploration.js';

const S = 'teyvat';

// First-login position. Deliberately *not* the waypoint at the origin: standing
// dead-centre on the teleport anchor puts the character inside its glow beam, so
// the first thing a new player sees is their own silhouette washed out by a column
// of light. Seven metres out and facing it reads as arriving *at* a landmark.
// `y` is a hint only — the client re-samples the terrain height on zone load.
const SPAWN = { x: -7, y: 4, z: 8, ry: 2.42 };

/* ------------------------------------------------------------- accounts -- */

export async function createAccount(username, passwordHash, nickname) {
  return tx(async (c) => {
    const acc = (await c.query(
      `INSERT INTO ${S}.accounts (username, password_hash) VALUES ($1,$2) RETURNING id, username`,
      [username, passwordHash],
    )).rows[0];
    const p = (await c.query(
      `INSERT INTO ${S}.players (account_id, nickname, party, pos)
       VALUES ($1,$2,$3::jsonb,$4::jsonb) RETURNING *`,
      [acc.id, nickname || username, JSON.stringify(STARTER_PARTY.slice(0, 2)),
        JSON.stringify(SPAWN)],
    )).rows[0];

    // Starter characters: the first two of the standard party.
    for (const charId of STARTER_PARTY.slice(0, 2)) {
      await c.query(
        `INSERT INTO ${S}.player_characters (player_id, char_id, level, talents)
         VALUES ($1,$2,1,'{"normal":1,"skill":1,"burst":1}'::jsonb)
         ON CONFLICT DO NOTHING`,
        [p.id, charId],
      );
    }
    // Starter weapons, one per starter char's type.
    for (const charId of STARTER_PARTY.slice(0, 2)) {
      const type = CHARACTERS[charId].weapon;
      const wid = { sword: 'travelersBlade', claymore: 'ironGreatsword', bow: 'huntersBow', polearm: 'ironSpear', catalyst: 'apprenticeTome' }[type];
      const w = makeWeapon(wid, 1);
      await c.query(
        `INSERT INTO ${S}.equipment (uid, player_id, kind, data, equipped_by) VALUES ($1,$2,'weapon',$3::jsonb,$4)`,
        [w.uid, p.id, JSON.stringify(w), charId],
      );
      await c.query(`UPDATE ${S}.player_characters SET weapon_uid=$1 WHERE player_id=$2 AND char_id=$3`, [w.uid, p.id, charId]);
    }
    // Starter inventory
    const starter = [['adventurerXp', 10], ['sweetMadame', 5], ['mora', 0], ['heroWit', 2], ['condensedResin', 2]];
    for (const [item, qty] of starter) {
      if (qty > 0) {
        await c.query(
          `INSERT INTO ${S}.inventory (player_id, item_id, qty) VALUES ($1,$2,$3)
           ON CONFLICT (player_id,item_id) DO UPDATE SET qty=${S}.inventory.qty+$3`,
          [p.id, item, qty],
        );
      }
    }
    // Starter quest + dailies
    await c.query(
      `INSERT INTO ${S}.quest_progress (player_id, quest_id, state) VALUES ($1,'q_intro','active') ON CONFLICT DO NOTHING`,
      [p.id],
    );
    for (const d of DAILY_IDS) {
      await c.query(
        `INSERT INTO ${S}.quest_progress (player_id, quest_id, state) VALUES ($1,$2,'active') ON CONFLICT DO NOTHING`,
        [p.id, d],
      );
    }
    await c.query(
      `INSERT INTO ${S}.leaderboard (player_id, nickname, score) VALUES ($1,$2,0)
       ON CONFLICT (player_id) DO UPDATE SET nickname=$2`,
      [p.id, p.nickname],
    );
    // The welcome letter, not a welcome grant. Everything in `starter` above is already in
    // the player's hands the moment they spawn, which teaches them nothing about where later
    // rewards will arrive; a mailbox with one letter in it does, and it makes the first
    // 领取 the tutorial for every offline grant after it.
    const hello = welcomeMail();
    await c.query(
      `INSERT INTO ${S}.mail (player_id, dedupe, sender, subject, body, attach, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb, now() + ($7 || ' days')::interval)`,
      [p.id, hello.dedupe, hello.sender, hello.subject, hello.body,
        JSON.stringify(hello.attach), String(MAIL_TTL_DAYS)],
    );
    return { accountId: Number(acc.id), playerId: Number(p.id), username: acc.username, nickname: p.nickname };
  });
}

export async function findAccountByUsername(username) {
  return one(`SELECT a.*, p.id AS player_id, p.nickname FROM ${S}.accounts a
              LEFT JOIN ${S}.players p ON p.account_id = a.id WHERE a.username = $1`, [username]);
}

export async function touchLogin(accountId) {
  await q(`UPDATE ${S}.accounts SET last_login = now() WHERE id = $1`, [accountId]);
}

/* --------------------------------------------------------------- players -- */

export async function loadPlayer(playerId) {
  const p = await one(`SELECT * FROM ${S}.players WHERE id = $1`, [playerId]);
  if (!p) return null;

  const [chars, inv, equip, quests, world, chambers] = await Promise.all([
    many(`SELECT * FROM ${S}.player_characters WHERE player_id = $1 ORDER BY acquired_at`, [playerId]),
    many(`SELECT item_id, qty FROM ${S}.inventory WHERE player_id = $1`, [playerId]),
    many(`SELECT uid, kind, data, equipped_by FROM ${S}.equipment WHERE player_id = $1`, [playerId]),
    // `updated_at` is not bookkeeping here: it is the period stamp the daily rollover reads
    // (`quests.dailiesToRoll`). A row written before 04:00 belongs to yesterday's bucket.
    many(`SELECT quest_id, state, stage_index, counters, updated_at FROM ${S}.quest_progress WHERE player_id = $1`, [playerId]),
    many(`SELECT zone, key, value FROM ${S}.world_progress WHERE player_id = $1`, [playerId]),
    many(`SELECT zone, floor, stars, best_time FROM ${S}.chamber_records WHERE player_id = $1`, [playerId]),
  ]);

  const equipByUid = new Map();
  for (const e of equip) equipByUid.set(e.uid, { ...e.data, uid: e.uid, kind: e.kind, equippedBy: e.equipped_by });

  const characters = {};
  for (const c of chars) {
    const arts = {};
    for (const [slot, uid] of Object.entries(c.artifacts || {})) {
      const a = equipByUid.get(uid);
      if (a) arts[slot] = a;
    }
    characters[c.char_id] = {
      charId: c.char_id,
      level: c.level,
      xp: Number(c.xp),
      ascension: c.ascension,
      talents: c.talents,
      dupes: c.dupes,
      weapon: c.weapon_uid ? equipByUid.get(c.weapon_uid) || null : null,
      artifacts: arts,
      hp: c.hp,
      energy: Number(c.energy),
    };
  }

  const inventory = {};
  for (const i of inv) inventory[i.item_id] = Number(i.qty);

  const questState = {};
  for (const qq of quests) {
    questState[qq.quest_id] = {
      state: qq.state, stageIndex: qq.stage_index, counters: qq.counters || {},
      at: qq.updated_at ? new Date(qq.updated_at).getTime() : null,
    };
  }

  const worldProgress = {};
  for (const w of world) {
    worldProgress[w.zone] = worldProgress[w.zone] || {};
    worldProgress[w.zone][w.key] = w.value || {};
  }

  const abyss = {};
  for (const ch of chambers) {
    abyss[ch.zone] = abyss[ch.zone] || {};
    abyss[ch.zone][ch.floor] = { stars: ch.stars, bestTime: ch.best_time };
  }

  return {
    playerId: Number(p.id),
    accountId: Number(p.account_id),
    nickname: p.nickname,
    adventureRank: p.adventure_rank,
    adventureXp: Number(p.adventure_xp),
    worldLevel: p.world_level,
    mora: Number(p.mora),
    primogem: Number(p.primogem),
    wishTicket: p.wish_ticket,
    resin: p.resin,
    resinAt: p.resin_at,
    zone: p.zone,
    pos: p.pos,
    party: p.party || [],
    activeSlot: p.active_slot,
    wishState: p.wish_state || {},
    settings: p.settings || {},
    stats: p.stats || {},
    playtimeSec: Number(p.playtime_sec),
    characters,
    inventory,
    equipment: [...equipByUid.values()],
    quests: questState,
    worldProgress,
    abyss,
  };
}

export async function savePlayerCore(playerId, patch) {
  const fields = [];
  const vals = [];
  let i = 1;
  const map = {
    adventureRank: 'adventure_rank', adventureXp: 'adventure_xp', worldLevel: 'world_level',
    mora: 'mora', primogem: 'primogem', wishTicket: 'wish_ticket', resin: 'resin',
    zone: 'zone', activeSlot: 'active_slot', playtimeSec: 'playtime_sec', nickname: 'nickname',
  };
  const jsonMap = { pos: 'pos', party: 'party', wishState: 'wish_state', settings: 'settings', stats: 'stats' };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) { fields.push(`${col} = $${i++}`); vals.push(patch[k]); }
  }
  for (const [k, col] of Object.entries(jsonMap)) {
    if (patch[k] !== undefined) { fields.push(`${col} = $${i++}::jsonb`); vals.push(JSON.stringify(patch[k])); }
  }
  if (patch.resinAt !== undefined) { fields.push(`resin_at = $${i++}`); vals.push(patch.resinAt); }
  if (!fields.length) return;
  fields.push('updated_at = now()');
  vals.push(playerId);
  await q(`UPDATE ${S}.players SET ${fields.join(', ')} WHERE id = $${i}`, vals);
  await invalidate(RK.player(playerId), RK.profile(playerId));
}

export async function upsertCharacter(playerId, ch) {
  const artifactUids = {};
  for (const [slot, a] of Object.entries(ch.artifacts || {})) if (a?.uid) artifactUids[slot] = a.uid;
  await q(
    `INSERT INTO ${S}.player_characters
       (player_id, char_id, level, xp, ascension, talents, dupes, weapon_uid, artifacts, hp, energy)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11)
     ON CONFLICT (player_id, char_id) DO UPDATE SET
       level=$3, xp=$4, ascension=$5, talents=$6::jsonb, dupes=$7,
       weapon_uid=$8, artifacts=$9::jsonb, hp=$10, energy=$11`,
    [playerId, ch.charId, ch.level || 1, ch.xp || 0, ch.ascension || 0,
      JSON.stringify(ch.talents || { normal: 1, skill: 1, burst: 1 }), ch.dupes || 0,
      ch.weapon?.uid || null, JSON.stringify(artifactUids),
      ch.hp === undefined ? -1 : ch.hp, ch.energy || 0],
  );
  await invalidate(RK.player(playerId));
}

export async function grantCharacter(playerId, charId) {
  const existing = await one(`SELECT char_id, dupes FROM ${S}.player_characters WHERE player_id=$1 AND char_id=$2`, [playerId, charId]);
  if (existing) {
    // `capped` is the whole reason this returns three fields instead of two: a duplicate of a
    // character already at C6 raises nothing, and the wish's conversion pays extra for exactly
    // that case. The caller cannot work it out from `dupes` alone — 6 before and 6 after look
    // identical. The ceiling is the shared constant, not a 6 typed into the SQL.
    const capped = existing.dupes >= MAX_CONSTELLATION;
    await q(
      `UPDATE ${S}.player_characters SET dupes = LEAST(dupes+1, $3) WHERE player_id=$1 AND char_id=$2`,
      [playerId, charId, MAX_CONSTELLATION],
    );
    await invalidate(RK.player(playerId));
    return { dupe: true, dupes: Math.min(existing.dupes + 1, MAX_CONSTELLATION), capped };
  }
  await q(
    `INSERT INTO ${S}.player_characters (player_id, char_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [playerId, charId],
  );
  await invalidate(RK.player(playerId));
  return { dupe: false, dupes: 0, capped: false };
}

export async function addItems(playerId, items) {
  const entries = Object.entries(items || {}).filter(([, v]) => v);
  if (!entries.length) return;
  await tx(async (c) => {
    for (const [id, qty] of entries) {
      if (id === 'mora') { await c.query(`UPDATE ${S}.players SET mora = mora + $2 WHERE id=$1`, [playerId, qty]); continue; }
      if (id === 'primogem') { await c.query(`UPDATE ${S}.players SET primogem = primogem + $2 WHERE id=$1`, [playerId, qty]); continue; }
      if (id === 'wishTicket') { await c.query(`UPDATE ${S}.players SET wish_ticket = wish_ticket + $2 WHERE id=$1`, [playerId, qty]); continue; }
      await c.query(
        `INSERT INTO ${S}.inventory (player_id, item_id, qty) VALUES ($1,$2,$3)
         ON CONFLICT (player_id,item_id) DO UPDATE SET qty = GREATEST(0, ${S}.inventory.qty + $3)`,
        [playerId, id, qty],
      );
    }
  });
  await invalidate(RK.player(playerId));
}

export async function addEquipment(playerId, item) {
  await q(
    `INSERT INTO ${S}.equipment (uid, player_id, kind, data, equipped_by) VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (uid) DO UPDATE SET data=$4::jsonb, equipped_by=$5`,
    [item.uid, playerId, item.kind, JSON.stringify(item), item.equippedBy || null],
  );
  await invalidate(RK.player(playerId));
}

export async function deleteEquipment(playerId, uids) {
  if (!uids.length) return;
  await q(`DELETE FROM ${S}.equipment WHERE player_id=$1 AND uid = ANY($2::text[])`, [playerId, uids]);
  await invalidate(RK.player(playerId));
}

export async function setEquippedBy(playerId, uid, charId) {
  await q(`UPDATE ${S}.equipment SET equipped_by=$3 WHERE player_id=$1 AND uid=$2`, [playerId, uid, charId]);
}

export async function saveQuest(playerId, questId, st) {
  await q(
    `INSERT INTO ${S}.quest_progress (player_id, quest_id, state, stage_index, counters, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb, now())
     ON CONFLICT (player_id,quest_id) DO UPDATE SET state=$3, stage_index=$4, counters=$5::jsonb, updated_at=now()`,
    [playerId, questId, st.state, st.stageIndex || 0, JSON.stringify(st.counters || {})],
  );
  // The row's `updated_at` is the period stamp the daily rollover compares against, so the
  // in-memory copy is stamped with the same write. Skipping this would leave a cached player
  // rolling its dailies again on the next event of the day.
  st.at = Date.now();
  await invalidate(RK.player(playerId));
}

export async function saveWorldProgress(playerId, zone, key, value = {}) {
  await q(
    `INSERT INTO ${S}.world_progress (player_id, zone, key, value) VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (player_id,zone,key) DO UPDATE SET value=$4::jsonb, at=now()`,
    [playerId, zone, key, JSON.stringify(value)],
  );
  await invalidate(RK.player(playerId));
}

/**
 * Raise a zone's paid-for 探索度 milestone to `pct`, and report what was actually raised.
 *
 * Same arbiter-in-the-statement as `claimAchTier`, and for the same reason: two clicks on
 * 「领取探索奖励」 compute the same target from the same rows, so the guard cannot live in the
 * caller. `WHERE (value->>'pct')::int < $4` means the loser's UPDATE moves nothing, `one()`
 * hands back no row, and the route pays once. Deliberately *not* routed through
 * `saveWorldProgress` — that one overwrites unconditionally, which here would be a refund.
 *
 * The row lives in `world_progress` under `MILESTONE_KEY` (see `shared/data/exploration.js`):
 * no new table, and the mark arrives in `loadPlayer`'s blob with the rows it is derived from.
 */
export async function claimExploreMilestone(playerId, zone, key, pct) {
  const row = await one(
    `INSERT INTO ${S}.world_progress (player_id, zone, key, value)
     VALUES ($1,$2,$3, jsonb_build_object('pct', $4::int))
     ON CONFLICT (player_id,zone,key) DO UPDATE
       SET value = jsonb_build_object('pct', $4::int), at = now()
       WHERE COALESCE((${S}.world_progress.value->>'pct')::int, -1) < $4::int
     RETURNING (value->>'pct')::int AS pct`,
    [playerId, zone, key, pct],
  );
  await invalidate(RK.player(playerId));
  return row ? row.pct : null;
}

/**
 * Shop stock as `{ entryId: { bought, period } }`.
 *
 * Deliberately not part of `loadPlayer`: the player blob is cached in Redis for the whole
 * session and stock has to be re-read against the wall clock, so folding it in would mean
 * a cached row could claim a limit was spent in a period that has already ended.
 */
export async function shopPurchases(playerId) {
  const rows = await many(
    `SELECT entry_id, bought, period FROM ${S}.shop_purchases WHERE player_id=$1`, [playerId],
  );
  const out = {};
  for (const r of rows) out[r.entry_id] = { bought: r.bought, period: r.period };
  return out;
}

/**
 * Add `n` to an entry's count, in the period named by `period`.
 *
 * The reset lives in the `ON CONFLICT` branch: a row whose stored period is not the one
 * being written *starts over* at `n` rather than accumulating. That is why no job ever has
 * to sweep this table — a stale row is not wrong data, it is a count for a period that has
 * ended, and the first purchase of the new period overwrites it.
 */
export async function bumpShopPurchase(playerId, entryId, n, period) {
  const row = await one(
    `INSERT INTO ${S}.shop_purchases (player_id, entry_id, bought, period) VALUES ($1,$2,$3,$4)
     ON CONFLICT (player_id,entry_id) DO UPDATE SET
       bought = CASE WHEN ${S}.shop_purchases.period = $4 THEN ${S}.shop_purchases.bought + $3 ELSE $3 END,
       period = $4, at = now()
     RETURNING bought, period`,
    [playerId, entryId, n, period],
  );
  return { bought: row.bought, period: row.period };
}

/* ---------------------------------------------------------- achievements -- */

/**
 * The whole achievement snapshot in one round trip.
 *
 * Every number here is an aggregate over a table that was already being written, which is the
 * point of the module (see `shared/src/data/achievements.js`): nothing bumps a counter when a
 * chest opens, so nothing can bump it twice, and a save made before achievements existed
 * reports its real history the first time this runs.
 *
 * Two subtleties are load-bearing rather than stylistic:
 *   - `quest_progress` rows for dailies are excluded, because `progression.rollDailies` flips
 *     them back to `active` every morning; counting them would make `quests` go *down* at 04:00
 *     and un-earn an achievement that had not been collected yet.
 *   - the `world_progress` counts key off the shape of `value` (`{opened}` / `{solved}` /
 *     `{unlocked}`) rather than off the key text, because that is what the three routes
 *     actually write — a chest and a waypoint are told apart by their payload, not their id.
 *
 * The returned keys must match `ACH_STATS` exactly; `tools/api-check.mjs` asserts that both
 * ways so a stat cannot be declared in shared and forgotten here.
 */
export async function achSnapshot(playerId) {
  // 探索度 is the one stat that is not an aggregate: it is a *fraction of the zone table*, so the
  // denominator lives in shared/ and the rows have to come back to be priced by the same
  // function the map panel draws its bar from (`data/exploration.js`). Still a derivation —
  // nothing stores a percentage — and still one round trip, in parallel with the aggregates.
  const wpRows = many(`SELECT zone, key, value FROM ${S}.world_progress WHERE player_id = $1`, [playerId]);
  const row = await one(
    `SELECT
       p.adventure_rank, p.world_level, p.playtime_sec, p.stats,
       COALESCE(l.kills, 0)      AS kills,
       COALESCE(l.max_damage, 0) AS max_damage,
       (SELECT count(*) FROM ${S}.world_progress w
         WHERE w.player_id = p.id AND w.value->>'opened' = 'true')    AS chests,
       (SELECT count(*) FROM ${S}.world_progress w
         WHERE w.player_id = p.id AND w.value->>'solved' = 'true')    AS puzzles,
       (SELECT count(*) FROM ${S}.world_progress w
         WHERE w.player_id = p.id AND w.value->>'unlocked' = 'true')  AS waypoints,
       (SELECT count(DISTINCT w.zone) FROM ${S}.world_progress w
         WHERE w.player_id = p.id)                                    AS zones_touched,
       (SELECT count(*) FROM ${S}.chamber_records c WHERE c.player_id = p.id)      AS chambers,
       (SELECT COALESCE(sum(c.stars), 0) FROM ${S}.chamber_records c
         WHERE c.player_id = p.id)                                    AS abyss_stars,
       (SELECT count(*) FROM ${S}.quest_progress qp
         WHERE qp.player_id = p.id AND qp.state = 'done'
           AND qp.quest_id <> ALL($2::text[]))                        AS quests,
       (SELECT count(*) FROM ${S}.player_characters pc WHERE pc.player_id = p.id) AS chars,
       (SELECT COALESCE(max(pc.level), 1) FROM ${S}.player_characters pc
         WHERE pc.player_id = p.id)                                   AS char_level,
       (SELECT COALESCE(max(pc.ascension), 0) FROM ${S}.player_characters pc
         WHERE pc.player_id = p.id)                                   AS ascension,
       (SELECT COALESCE(max(pc.dupes), 0) FROM ${S}.player_characters pc
         WHERE pc.player_id = p.id)                                   AS constellation,
       (SELECT COALESCE(max(GREATEST(
                 (pc.talents->>'normal')::int,
                 (pc.talents->>'skill')::int,
                 (pc.talents->>'burst')::int)), 1)
          FROM ${S}.player_characters pc WHERE pc.player_id = p.id)    AS talent,
       (SELECT count(*) FROM ${S}.equipment e
         WHERE e.player_id = p.id AND e.kind = 'weapon')              AS weapons,
       (SELECT count(*) FROM ${S}.equipment e
         WHERE e.player_id = p.id AND e.kind = 'artifact')             AS artifacts,
       (SELECT count(*) FROM ${S}.wish_history h WHERE h.player_id = p.id)         AS wishes,
       (SELECT count(*) FROM ${S}.wish_history h
         WHERE h.player_id = p.id AND h.rarity = 5)                    AS five_stars
     FROM ${S}.players p
     LEFT JOIN ${S}.leaderboard l ON l.player_id = p.id
     WHERE p.id = $1`,
    [playerId, DAILY_IDS],
  );
  if (!row) return null;
  const life = row.stats || {};
  const n = (v) => Number(v || 0);
  const progress = {};
  for (const w of await wpRows) {
    progress[w.zone] = progress[w.zone] || {};
    progress[w.zone][w.key] = w.value || {};
  }
  const explore = explorationSummary(progress);
  return {
    rank: n(row.adventure_rank),
    worldLevel: n(row.world_level),
    // Floored hours: the panel shows "3 小时", and a stat that ticks in seconds would make the
    // progress bar jitter on every save without ever meaning anything different.
    playHours: Math.floor(n(row.playtime_sec) / 3600),
    zonesTouched: n(row.zones_touched),
    quests: n(row.quests),
    kills: n(row.kills),
    maxDamage: n(row.max_damage),
    chambers: n(row.chambers),
    abyssStars: n(row.abyss_stars),
    chests: n(row.chests),
    puzzles: n(row.puzzles),
    waypoints: n(row.waypoints),
    gathered: n(life.gathered),
    exploreBest: explore.best,
    zonesExplored: explore.complete,
    chars: n(row.chars),
    charLevel: n(row.char_level),
    ascension: n(row.ascension),
    talent: n(row.talent),
    constellation: n(row.constellation),
    weapons: n(row.weapons),
    artifacts: n(row.artifacts),
    cooked: n(life.cooked),
    talks: n(life.talks),
    friendsMade: n(life.friendsMade),
    wishes: n(row.wishes),
    fiveStars: n(row.five_stars),
  };
}

/** `{ achId: tier }` — how many tiers of each achievement have been paid for. */
export async function achClaimed(playerId) {
  const rows = await many(`SELECT ach_id, tier FROM ${S}.achievements WHERE player_id = $1`, [playerId]);
  const out = {};
  for (const r of rows) out[r.ach_id] = r.tier;
  return out;
}

/**
 * Raise an achievement's paid-for tier to `tier`, and report what was actually raised.
 *
 * The guard is in the statement (`WHERE tier < $3`), not in the caller: two 一键领取 clicks
 * racing each other both compute the same target tier, and only the one whose UPDATE moves the
 * row gets a non-null result to pay for. `from`/`to` come back so the route can price exactly
 * the tiers it won rather than trusting its own read.
 */
export async function claimAchTier(playerId, achId, tier) {
  const row = await one(
    `INSERT INTO ${S}.achievements (player_id, ach_id, tier) VALUES ($1,$2,$3)
     ON CONFLICT (player_id, ach_id) DO UPDATE SET tier = $3, at = now()
       WHERE ${S}.achievements.tier < $3
     RETURNING tier`,
    [playerId, achId, tier],
  );
  return row ? row.tier : null;
}

/**
 * Bump a lifetime tally inside `players.stats`.
 *
 * Incremented in SQL rather than by writing back a JS object: the bag is shared by every event
 * kind, and a read-modify-write from two requests in the same tick (a kill and a gather) would
 * lose one of them. `jsonb_set` with `create_missing` also means no migration for a new tally.
 *
 * Returns the new total so the caller can keep its in-memory player coherent. Nothing here
 * touches the cache: `getPlayer` keeps a live object that a Redis `DEL` would not reach, and
 * `achSnapshot` reads Postgres directly, so the row is the only copy that has to be right.
 */
export async function bumpLifetime(playerId, key, delta = 1) {
  if (!key || !delta) return null;
  const row = await one(
    `UPDATE ${S}.players
        SET stats = jsonb_set(COALESCE(stats, '{}'::jsonb), ARRAY[$2],
                    to_jsonb(COALESCE((stats->>$2)::bigint, 0) + $3::bigint), true),
            updated_at = now()
      WHERE id = $1
      RETURNING (stats->>$2)::bigint AS n`,
    [playerId, key, delta],
  );
  return row ? Number(row.n) : null;
}

/* ------------------------------------------------------------------ mail -- */

/**
 * Insert a letter, or do nothing if this player already has one with the same `dedupe`.
 *
 * Returns the row when it was inserted and `null` when it was already there — that boolean is
 * the whole of the "has today's gift been handed out?" question, so no code has to store or
 * compare a last-claimed timestamp. `ttlDays` is written as an absolute instant because the
 * query filters on it; a letter's lifetime is decided when it is sent, not when it is read.
 */
export async function insertMail(playerId, mail, ttlDays = 30) {
  const row = await one(
    `INSERT INTO ${S}.mail (player_id, dedupe, sender, subject, body, attach, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb, now() + ($7 || ' days')::interval)
     ON CONFLICT (player_id, dedupe) WHERE dedupe IS NOT NULL DO NOTHING
     RETURNING id, dedupe, sender, subject, body, attach, claimed, seen, at, expires_at`,
    [playerId, mail.dedupe ?? null, mail.sender, mail.subject, mail.body || '',
      JSON.stringify(mail.attach || {}), String(ttlDays)],
  );
  return row ? mailRow(row) : null;
}

function mailRow(r) {
  return {
    id: Number(r.id), dedupe: r.dedupe, sender: r.sender, subject: r.subject,
    body: r.body, attach: r.attach || {}, claimed: r.claimed, seen: r.seen,
    at: new Date(r.at).getTime(), expiresAt: new Date(r.expires_at).getTime(),
  };
}

/** The live mailbox, newest first. Expired and binned letters are filtered, never swept. */
export async function mailbox(playerId, limit = 50) {
  const rows = await many(
    `SELECT id, dedupe, sender, subject, body, attach, claimed, seen, at, expires_at
       FROM ${S}.mail WHERE player_id=$1 AND deleted=false AND expires_at > now()
      ORDER BY at DESC, id DESC LIMIT $2`,
    [playerId, limit],
  );
  return rows.map(mailRow);
}

export async function markMailSeen(playerId, ids = null) {
  if (ids && !ids.length) return 0;
  const res = ids
    ? await q(`UPDATE ${S}.mail SET seen=true WHERE player_id=$1 AND id = ANY($2::bigint[])`, [playerId, ids])
    : await q(`UPDATE ${S}.mail SET seen=true WHERE player_id=$1 AND seen=false`, [playerId]);
  return res.rowCount || 0;
}

/**
 * Flip unclaimed letters to claimed and return what was on them.
 *
 * The UPDATE is the gate, not a preceding SELECT: `claimed=false` in the WHERE clause means
 * two concurrent claims cannot both walk away with the attachment, and the caller only grants
 * what came back in `RETURNING`. Expiry is checked here too, so a letter that ran out between
 * the mailbox render and the click pays nothing rather than paying late.
 */
export async function claimMail(playerId, ids = null) {
  const rows = ids
    ? await many(
      `UPDATE ${S}.mail SET claimed=true, seen=true
        WHERE player_id=$1 AND id = ANY($2::bigint[]) AND claimed=false
          AND deleted=false AND expires_at > now()
        RETURNING id, attach`, [playerId, ids])
    : await many(
      `UPDATE ${S}.mail SET claimed=true, seen=true
        WHERE player_id=$1 AND claimed=false AND deleted=false AND expires_at > now()
        RETURNING id, attach`, [playerId]);
  return rows.map((r) => ({ id: Number(r.id), attach: r.attach || {} }));
}

/**
 * Bin letters. Only claimed or attachment-free ones — see the route for why — and the row is
 * flagged rather than removed.
 *
 * The soft delete is load-bearing, not housekeeping: the row *is* the proof that this period's
 * gift was handed out (`dedupe`), so a hard DELETE would let the next `GET /api/mail` mint it
 * again, and 删除已读 would print primogems. Rows leave for real in `purgeExpiredMail`, where
 * it is safe because a period key never comes round twice.
 */
export async function deleteMail(playerId, ids = null) {
  const rows = ids
    ? await many(
      `UPDATE ${S}.mail SET deleted=true WHERE player_id=$1 AND id = ANY($2::bigint[])
         AND deleted=false AND (claimed=true OR attach='{}'::jsonb) RETURNING id`, [playerId, ids])
    : await many(
      `UPDATE ${S}.mail SET deleted=true WHERE player_id=$1 AND deleted=false
         AND (claimed=true OR attach='{}'::jsonb) RETURNING id`, [playerId]);
  return rows.map((r) => Number(r.id));
}

/**
 * Trim a mailbox to `cap` visible letters.
 *
 * The subselect orders the letters worth *keeping* first — unclaimed before claimed, newest
 * before oldest — and `OFFSET cap` is therefore everything that falls off the bottom. Sorting
 * the other way round (surplus first) is the easy bug here: it bins the newest unread mail.
 */
export async function trimMailbox(playerId, cap = 50) {
  const rows = await many(
    `UPDATE ${S}.mail SET deleted=true WHERE id IN (
       SELECT id FROM ${S}.mail WHERE player_id=$1 AND deleted=false
        ORDER BY claimed ASC, at DESC, id DESC OFFSET $2
     ) RETURNING id`,
    [playerId, cap],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * The only place mail rows actually disappear. An expired row can be dropped without
 * reopening the dedupe hole, because every dedupe key that is still reachable names a period
 * — `login:2026-09-05`, `board:w2953` — and no period is ever owed twice. The grace day is
 * there so a row cannot be purged in the same request that is still deciding whether it was
 * owed. `welcome` has no expiry path of its own: it is only ever written at account creation.
 */
export async function purgeExpiredMail(playerId) {
  const rows = await many(
    `DELETE FROM ${S}.mail WHERE player_id=$1 AND expires_at < now() - interval '1 day'
       RETURNING id`, [playerId],
  );
  return rows.map((r) => Number(r.id));
}

export async function saveChamber(playerId, zone, floor, stars, time) {
  await q(
    `INSERT INTO ${S}.chamber_records (player_id, zone, floor, stars, best_time) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (player_id,zone,floor) DO UPDATE SET
       stars = GREATEST(${S}.chamber_records.stars, $4),
       best_time = LEAST(COALESCE(${S}.chamber_records.best_time, 1e9), $5),
       cleared_at = now()`,
    [playerId, zone, floor, stars, time],
  );
  await invalidate(RK.player(playerId));
}

/* ---------------------------------------------------------- expeditions -- */

/**
 * Dispatches in flight, oldest slot first.
 *
 * `started_at` comes back as epoch millis, not a Date: every consumer (`expeditionState`, the
 * panel's countdown, the probe) does arithmetic against `Date.now()`, and a Date that has been
 * through JSON once is a string that silently NaNs the subtraction. See the shield bar in
 * `README` for what that costs when it happens on the wire.
 */
export async function listExpeditions(playerId) {
  const rows = await many(
    `SELECT slot, char_id, dest_id, hours,
            (EXTRACT(EPOCH FROM started_at) * 1000)::bigint AS started_ms
       FROM ${S}.expeditions WHERE player_id=$1 ORDER BY slot`, [playerId],
  );
  return rows.map((r) => ({
    slot: Number(r.slot), charId: r.char_id, destId: r.dest_id,
    hours: Number(r.hours), startedAt: Number(r.started_ms),
  }));
}

/**
 * Take a slot, if it is still free and that character is still idle.
 *
 * `ON CONFLICT DO NOTHING` on both keys — the primary key (slot) and `exped_char_idx`
 * (character) — so two clicks racing each other cannot double-book either one, and the caller
 * learns which happened from a `null` return instead of from its own earlier read.
 */
export async function startExpedition(playerId, { slot, charId, destId, hours }) {
  const row = await one(
    `INSERT INTO ${S}.expeditions (player_id, slot, char_id, dest_id, hours)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
     RETURNING slot, char_id, dest_id, hours, (EXTRACT(EPOCH FROM started_at) * 1000)::bigint AS started_ms`,
    [playerId, slot, charId, destId, hours],
  );
  if (!row) return null;
  return {
    slot: Number(row.slot), charId: row.char_id, destId: row.dest_id,
    hours: Number(row.hours), startedAt: Number(row.started_ms),
  };
}

/**
 * Claim finished trips and hand the caller exactly the rows it won.
 *
 * The due check is in the statement (`started_at + hours <= now()`), so the reward is paid by
 * whichever request actually removed the row: two 一键领取 clicks in the same tick see the same
 * rows, and the loser gets an empty list to pay for. `slots` narrows it to one slot; omitted
 * means every finished trip.
 */
export async function claimExpeditions(playerId, slots = null) {
  const rows = await many(
    `DELETE FROM ${S}.expeditions
      WHERE player_id=$1
        AND ($2::int[] IS NULL OR slot = ANY($2::int[]))
        AND started_at + make_interval(hours => hours) <= now()
      RETURNING slot, char_id, dest_id, hours,
                (EXTRACT(EPOCH FROM started_at) * 1000)::bigint AS started_ms`,
    [playerId, slots && slots.length ? slots : null],
  );
  return rows.map((r) => ({
    slot: Number(r.slot), charId: r.char_id, destId: r.dest_id,
    hours: Number(r.hours), startedAt: Number(r.started_ms),
  }));
}

/**
 * Move a player's dispatches back in time. Dev only (`/api/dev/*`), and the reason it exists:
 * the shortest trip is four hours, so nothing else can prove that a finished trip pays, that
 * an unfinished one refuses, or that the countdown reaches 可领取 — the three claims that
 * matter most. It edits `started_at` rather than any deadline, because there is no deadline.
 */
export async function rewindExpeditions(playerId, seconds) {
  const rows = await many(
    `UPDATE ${S}.expeditions SET started_at = started_at - make_interval(secs => $2)
      WHERE player_id=$1 RETURNING slot`, [playerId, Math.max(0, Number(seconds) || 0)],
  );
  return rows.length;
}

export async function logWish(playerId, pool, results) {
  if (!results.length) return;
  const values = [];
  const params = [];
  let i = 1;
  for (const r of results) {
    values.push(`($${i++},$${i++},$${i++},$${i++},$${i++})`);
    params.push(playerId, pool, r.type, r.id, r.rarity);
  }
  await q(`INSERT INTO ${S}.wish_history (player_id, pool, item_type, item_id, rarity) VALUES ${values.join(',')}`, params);
}

export async function wishHistory(playerId, limit = 100) {
  return many(
    `SELECT pool, item_type, item_id, rarity, at FROM ${S}.wish_history
     WHERE player_id=$1 ORDER BY at DESC, id DESC LIMIT $2`, [playerId, limit],
  );
}

export async function updateLeaderboard(playerId, nickname, fields) {
  await q(
    `INSERT INTO ${S}.leaderboard (player_id, nickname, score, abyss_floor, abyss_stars, max_damage, kills, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (player_id) DO UPDATE SET
       nickname=$2,
       score=GREATEST(${S}.leaderboard.score, $3),
       abyss_floor=GREATEST(${S}.leaderboard.abyss_floor, $4),
       abyss_stars=GREATEST(${S}.leaderboard.abyss_stars, $5),
       max_damage=GREATEST(${S}.leaderboard.max_damage, $6),
       kills=${S}.leaderboard.kills + $7,
       updated_at=now()`,
    [playerId, nickname, fields.score || 0, fields.abyssFloor || 0, fields.abyssStars || 0,
      fields.maxDamage || 0, fields.kills || 0],
  );
}

/**
 * Where one player sits on the score board: `{ rank, score }`, or null if they never scored.
 *
 * Counting the players strictly ahead is cheaper than paging the board and cannot disagree
 * with `leaderboardTop`'s ordering the way a client-side index into a top-20 slice would once
 * the player falls off the end of it.
 */
export async function boardRank(playerId) {
  const row = await one(
    `SELECT l.score,
            (SELECT count(*) + 1 FROM ${S}.leaderboard o WHERE o.score > l.score)::int AS rank
       FROM ${S}.leaderboard l WHERE l.player_id = $1`, [playerId],
  );
  if (!row) return null;
  return { rank: row.rank, score: Number(row.score) };
}

export async function leaderboardTop(which = 'score', limit = 20) {
  const col = { score: 'score', abyss: 'abyss_stars', damage: 'max_damage', kills: 'kills' }[which] || 'score';
  // Joined against players for rank and zone: the board only stores tallies, and the
  // UI was falling back to `score` for the AR column — which showed the adventure *xp*
  // total (916,160) under an "AR" label — and to a missing `zone`, which resolved to
  // Mondstadt for everyone.
  return many(
    `SELECT l.player_id, l.nickname, l.score, l.abyss_floor, l.abyss_stars, l.max_damage, l.kills,
            p.adventure_rank, p.zone
     FROM ${S}.leaderboard l JOIN ${S}.players p ON p.id = l.player_id
     ORDER BY l.${col} DESC, l.updated_at ASC LIMIT $1`, [limit],
  );
}

export async function saveChat(playerId, channel, nickname, body) {
  await q(`INSERT INTO ${S}.chat_log (player_id, channel, nickname, body) VALUES ($1,$2,$3,$4)`,
    [playerId, channel, nickname, body.slice(0, 400)]);
}

export async function recentChat(channel = 'world', limit = 50) {
  const rows = await many(
    `SELECT nickname, body, at FROM ${S}.chat_log WHERE channel=$1 ORDER BY at DESC LIMIT $2`,
    [channel, limit],
  );
  return rows.reverse();
}

/** Cached lightweight profile used by roster/social lists. */
export async function playerProfile(playerId) {
  const key = RK.profile(playerId);
  try {
    const hit = await redis().get(key);
    if (hit) return JSON.parse(hit);
  } catch {}
  const p = await one(
    `SELECT id, nickname, adventure_rank, world_level, zone FROM ${S}.players WHERE id=$1`, [playerId],
  );
  if (!p) return null;
  const prof = {
    playerId: Number(p.id), nickname: p.nickname,
    adventureRank: p.adventure_rank, worldLevel: p.world_level, zone: p.zone,
  };
  try { await redis().set(key, JSON.stringify(prof), 'EX', 60); } catch {}
  return prof;
}

/* ---------------------------------------------------------------- friends -- */

/**
 * The friend graph is stored as *two* rows per accepted friendship and *one* row per
 * pending request — `(player_id, friend_id)` is directional and the primary key.
 *
 * A single row with a `state` column would be smaller, but then "who are my friends"
 * is a query over two columns with a CASE to work out which end is the other person,
 * and every caller has to remember which direction it stored. Two rows makes the read
 * path — the one that runs on every panel open — a plain indexed lookup on
 * `player_id`, and the write path pays for it once, inside a transaction.
 */
export async function friendsOf(playerId) {
  return many(
    `SELECT f.friend_id AS player_id, f.state, f.at, p.nickname, p.adventure_rank, p.zone
     FROM ${S}.friends f JOIN ${S}.players p ON p.id = f.friend_id
     WHERE f.player_id = $1 ORDER BY p.nickname`, [playerId],
  );
}

/** Requests *sent to* `playerId` and still pending — the other direction of the above. */
export async function friendRequestsTo(playerId) {
  return many(
    `SELECT f.player_id, f.at, p.nickname, p.adventure_rank, p.zone
     FROM ${S}.friends f JOIN ${S}.players p ON p.id = f.player_id
     WHERE f.friend_id = $1 AND f.state = 'pending' ORDER BY f.at`, [playerId],
  );
}

export async function friendEdge(playerId, otherId) {
  return one(`SELECT player_id, friend_id, state FROM ${S}.friends WHERE player_id=$1 AND friend_id=$2`,
    [playerId, otherId]);
}

export async function findPlayerByNickname(nickname) {
  // Case-insensitive, because a nickname is typed by hand from a chat line or a
  // leaderboard row and nobody reproduces capitalisation faithfully. Nicknames are
  // not unique in this schema, so the oldest match wins — deterministic, and it is
  // the account that has held the name longest.
  return one(
    `SELECT id, nickname, adventure_rank, zone FROM ${S}.players
     WHERE lower(nickname) = lower($1) ORDER BY id LIMIT 1`, [nickname],
  );
}

export async function countFriends(playerId) {
  const r = await one(`SELECT count(*)::int AS n FROM ${S}.friends WHERE player_id=$1 AND state='accepted'`,
    [playerId]);
  return r?.n || 0;
}

export async function addFriendRequest(playerId, friendId) {
  await q(`INSERT INTO ${S}.friends (player_id, friend_id, state) VALUES ($1,$2,'pending')
           ON CONFLICT (player_id, friend_id) DO NOTHING`, [playerId, friendId]);
}

/**
 * Accept the request `requesterId` sent to `playerId`: both directions become
 * 'accepted' in one transaction, so a crash between the two writes cannot leave a
 * friendship that only one side can see.
 */
export async function acceptFriend(playerId, requesterId) {
  return tx(async (c) => {
    const r = await c.query(
      `UPDATE ${S}.friends SET state='accepted' WHERE player_id=$1 AND friend_id=$2 AND state='pending'`,
      [requesterId, playerId],
    );
    if (!r.rowCount) return false;
    await c.query(
      `INSERT INTO ${S}.friends (player_id, friend_id, state) VALUES ($1,$2,'accepted')
       ON CONFLICT (player_id, friend_id) DO UPDATE SET state='accepted'`,
      [playerId, requesterId],
    );
    return true;
  });
}

/** Remove/decline: drops both directions, so this is also how a request is refused. */
export async function removeFriend(playerId, otherId) {
  const r = await q(
    `DELETE FROM ${S}.friends WHERE (player_id=$1 AND friend_id=$2) OR (player_id=$2 AND friend_id=$1)`,
    [playerId, otherId],
  );
  return r.rowCount > 0;
}

export async function grantStarterArtifacts(playerId, count = 5) {
  const arts = [];
  for (let i = 0; i < count; i++) {
    const a = generateArtifact(1, Math.floor(Math.random() * 1e9), 4);
    arts.push(a);
    await addEquipment(playerId, a);
  }
  return arts;
}
