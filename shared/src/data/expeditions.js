// 探索派遣 — send a character out to gather while you are away.
//
// The module every "complete game" checklist has and this repo did not: a place to put
// characters you own but do not play, an income that runs on the wall clock instead of on
// keystrokes, and a reason to open the game after a night away.
//
// Three rules decide everything here, and all three are *derived* rather than authored,
// because an idle income invented out of round numbers is exactly how a currency gets
// printed (see the mora/xp audits in `tools/balance-check.mjs`):
//
//  1. **What a destination pays** is that zone's own gathering, done for you. Every
//     `oreNode`/flower cluster in `zones.js` already declares how much of what grows there
//     (`gatherNodes`), and `rollGather` pays 1-3 of the node's kind (mean 2). So one
//     "sweep" of a zone is a known basket of items, and a destination pays a **fraction of
//     that basket**: `EXPEDITION_SWEEP_SHARE` of it per `EXPEDITION_REF_HOURS`. Nothing is
//     invented per destination and nothing needs rebalancing when a zone gains a cluster.
//  2. **Time is linear.** `payout(2h) + payout(2h) === payout(4h)` up to one item of
//     rounding, so there is no optimal duration to compute and no reason to set alarms:
//     the longer trips exist to save trips, not to earn a bonus. A superlinear tier ladder
//     is what turns an idle system into a spreadsheet.
//  3. **No currency.** Gathering pays materials, so gathering-by-proxy pays materials.
//     Mora and 原石 have their own faucets (quests, chests, achievements, mail) which are
//     audited; a second unaudited one that runs while nobody is watching is a liability.
//
// The clock is the server's: a row's `startedAt` is written from `now()` on the server and
// never from the client's word, and "is it done" is a comparison against the request's own
// `now`, not a stored deadline (the same reason `shop_purchases` stores a period key rather
// than a `resets_at` — a stored deadline is a second source of truth about time).
import { ZONES, gatherNodes, canEnterZone, zoneEntryRank } from './zones.js';
import { WEAPON_ORE } from '../sim/loot.js';

/** Mean items one gathered node pays — `rollGather` rolls `int(1,3)`. */
const MEAN_PER_NODE = 2;
/** The duration the share below is quoted at. */
export const EXPEDITION_REF_HOURS = 12;
/** A 12 h expedition pays this much of its theme's full sweep. */
export const EXPEDITION_SWEEP_SHARE = 1 / 3;
/** Durations offered, in hours. Linear payout, so this list is convenience only. */
export const EXPEDITION_HOURS = [4, 8, 12, 20];

/**
 * Slots by adventure rank.
 *
 * The one authored curve in the file, and it is deliberately flat: two slots from the
 * first minute (a fresh account owns exactly two characters, so a third would be dead UI),
 * one more every six ranks, five at rank 25 — the rank a full playthrough of the story
 * chain finishes at, per `balance-check`'s walk. The real limiter is characters owned, not
 * this number, which is why `expeditionSlots` takes both.
 */
export function expeditionSlots(adventureRank, ownedCharacters = 99) {
  const byRank = Math.min(5, 2 + Math.floor(Math.max(0, (adventureRank || 1) - 1) / 6));
  return Math.max(1, Math.min(byRank, ownedCharacters || 1));
}

/**
 * Destinations: two per open zone, split by what the ground gives.
 *
 * The split is `WEAPON_ORE` membership, not a hand-written list — 矿脉 pays what a weapon
 * climb eats, 采集 pays what the kitchen eats, and a zone that grows neither simply has no
 * destination. Names come from the zone's own name so a renamed zone cannot leave a stale
 * label in the panel.
 */
export const EXPEDITION_THEMES = {
  ore: { suffix: '矿脉', hint: '武器强化用的矿石' },
  flora: { suffix: '采集', hint: '料理与突破用的材料' },
};

function buildDestinations() {
  const out = {};
  for (const zone of Object.values(ZONES)) {
    if (zone.kind !== 'open') continue;
    const counts = new Map();
    for (const n of gatherNodes(zone)) counts.set(n.kind, (counts.get(n.kind) || 0) + 1);
    for (const [theme, meta] of Object.entries(EXPEDITION_THEMES)) {
      const kinds = [...counts.entries()]
        .filter(([k]) => (theme === 'ore') === WEAPON_ORE.includes(k))
        // Deterministic order: the payout rounds a *running total*, so a reshuffle would
        // move an item between two counts. Sort by yield then id, never by Map order.
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (!kinds.length) continue;
      const id = `${zone.id}_${theme}`;
      out[id] = {
        id,
        zone: zone.id,
        theme,
        name: `${zone.name}·${meta.suffix}`,
        hint: meta.hint,
        entryRank: zoneEntryRank(zone),
        /** kind -> nodes of it in the zone. The whole payout derives from this. */
        nodes: Object.fromEntries(kinds),
      };
    }
  }
  return out;
}

export const EXPEDITIONS = buildDestinations();

export function expeditionById(id) {
  return EXPEDITIONS[id] || null;
}

/** Destinations this player may send anyone to right now, in rank order. */
export function expeditionsFor(adventureRank) {
  return Object.values(EXPEDITIONS)
    .filter((d) => canEnterZone(ZONES[d.zone], adventureRank ?? 0))
    .sort((a, b) => a.entryRank - b.entryRank || a.id.localeCompare(b.id));
}

/**
 * What `hours` at `dest` pays, as an item map.
 *
 * Exact value per kind is `nodes * MEAN_PER_NODE * SHARE * hours / REF_HOURS`, a fraction.
 * Rounding each kind on its own loses up to half an item per kind, every time, which over a
 * day of trips is a systematic tax nobody authored — so the **running total** is what gets
 * rounded and the difference is what each kind is paid (`parts must sum to the whole`).
 * A kind whose exact share is under half an item still pays out sometimes, which is the
 * honest behaviour for a rare ore in a small basket.
 */
export function expeditionPayout(dest, hours) {
  const def = typeof dest === 'string' ? expeditionById(dest) : dest;
  const h = Number(hours);
  if (!def || !(h > 0)) return {};
  const rate = MEAN_PER_NODE * EXPEDITION_SWEEP_SHARE * h / EXPEDITION_REF_HOURS;
  const out = {};
  let exact = 0, paid = 0;
  for (const [kind, count] of Object.entries(def.nodes)) {
    exact += count * rate;
    const give = Math.round(exact) - paid;
    if (give > 0) { out[kind] = give; paid += give; }
  }
  return out;
}

/** Total items `hours` at `dest` pays — the number the card shows. */
export function expeditionTotal(dest, hours) {
  return Object.values(expeditionPayout(dest, hours)).reduce((a, b) => a + b, 0);
}

/**
 * Where one dispatch stands right now.
 *
 * `now` is passed in, never read off the clock inside: the route answers about the request's
 * own instant, the panel about the frame it is drawing, and a probe about a moment it chose.
 * `remainSec` is clamped at 0 so a finished row reads as 「可领取」 rather than counting up.
 */
export function expeditionState(row, now = Date.now()) {
  const startedAt = Number(row?.startedAt ?? 0);
  const hours = Number(row?.hours ?? 0);
  const endsAt = startedAt + hours * 3600_000;
  const ready = startedAt > 0 && now >= endsAt;
  return {
    startedAt, hours, endsAt, ready,
    remainSec: Math.max(0, Math.ceil((endsAt - now) / 1000)),
    elapsedSec: Math.max(0, Math.floor((now - startedAt) / 1000)),
  };
}

/**
 * May this player send this character to this destination for this long — and if not, why?
 *
 * One rule, read by the route that enforces it *and* the panel that draws it, for the reason
 * `chamberEntry` gives at length: a UI that offers a button the server refuses is worse than
 * one that shows the lock. Checks run in the order the player meets them and the first
 * failure is the one reported.
 *
 * @param ctx { adventureRank, owned: string[] (character ids), rows: [{slot, charId,…}] }
 */
export function expeditionEntry(destId, charId, hours, ctx = {}) {
  const def = expeditionById(destId);
  if (!def) return { ok: false, error: 'no_such_expedition' };
  if (!EXPEDITION_HOURS.includes(Number(hours))) return { ok: false, error: 'bad_hours' };
  if (!canEnterZone(ZONES[def.zone], ctx.adventureRank ?? 0)) {
    return { ok: false, error: 'rank_too_low', need: def.entryRank, dest: def };
  }
  const owned = ctx.owned || [];
  if (!charId || !owned.includes(charId)) return { ok: false, error: 'character_not_owned', dest: def };
  const rows = ctx.rows || [];
  if (rows.some((r) => r.charId === charId)) {
    return { ok: false, error: 'character_busy', dest: def };
  }
  // Slots are the cap on *dispatches in flight*, and a finished-but-unclaimed row still
  // occupies one: the reward is sitting in it. So 领取 is what frees a slot, which is also
  // what makes the panel's 可领取 badge worth acting on.
  const slots = expeditionSlots(ctx.adventureRank ?? 1, owned.length);
  if (rows.length >= slots) return { ok: false, error: 'no_free_slot', slots, dest: def };
  return { ok: true, dest: def, slots, payout: expeditionPayout(def, hours) };
}

/**
 * Which widget a refusal belongs to.
 *
 * The panel draws two things that can be locked — a destination row and the 派遣 button — and
 * `expeditionEntry` answers about both at once. Deciding which is which by listing codes in
 * the panel would put half of this rule back in the UI, so the split lives here with it: these
 * three are properties of the *destination* (it does not exist, that duration does not exist,
 * your rank is too low), everything else is a property of the character or the slots and
 * belongs on the button.
 */
export const EXPEDITION_DEST_ERRORS = ['no_such_expedition', 'bad_hours', 'rank_too_low'];

export function isDestRefusal(error) {
  return EXPEDITION_DEST_ERRORS.includes(error);
}

/** The lowest free slot index, or -1 when every slot is in flight. */
export function nextFreeSlot(rows, slots) {
  const used = new Set((rows || []).map((r) => Number(r.slot)));
  for (let i = 0; i < slots; i++) if (!used.has(i)) return i;
  return -1;
}

/**
 * Data audit, called by `tools/api-check.mjs` so a bad table cannot ship quietly.
 *
 * It checks the things a typo would break silently: that every kind a destination pays is a
 * real gather kind of its own zone, that themes do not overlap, that the payout is linear in
 * hours and monotone, and that no destination pays nothing at the shortest duration — a
 * 4-hour trip that hands back an empty bag is a button that lies.
 */
export function validateExpeditions() {
  const problems = [];
  const dests = Object.values(EXPEDITIONS);
  if (!dests.length) problems.push('no destinations at all');
  for (const d of dests) {
    const zone = ZONES[d.zone];
    if (!zone) { problems.push(`${d.id}: unknown zone ${d.zone}`); continue; }
    const kinds = new Set(gatherNodes(zone).map((n) => n.kind));
    for (const [kind, count] of Object.entries(d.nodes)) {
      if (!kinds.has(kind)) problems.push(`${d.id}: pays ${kind}, which does not grow in ${d.zone}`);
      if (!(count > 0)) problems.push(`${d.id}: ${kind} has no nodes`);
      const isOre = WEAPON_ORE.includes(kind);
      if (isOre !== (d.theme === 'ore')) problems.push(`${d.id}: ${kind} is on the wrong theme`);
    }
    if (d.entryRank !== zoneEntryRank(zone)) problems.push(`${d.id}: entryRank drifted from its zone`);
    const short = expeditionTotal(d, EXPEDITION_HOURS[0]);
    if (short < 1) problems.push(`${d.id}: pays nothing for ${EXPEDITION_HOURS[0]}h`);
    let prev = 0;
    for (const h of EXPEDITION_HOURS) {
      const t = expeditionTotal(d, h);
      if (t < prev) problems.push(`${d.id}: ${h}h pays less than the duration below it`);
      prev = t;
    }
    // Linear: the 12 h reference basket is `SHARE` of the sweep, exactly.
    const sweep = Object.values(d.nodes).reduce((a, c) => a + c * MEAN_PER_NODE, 0);
    const ref = expeditionTotal(d, EXPEDITION_REF_HOURS);
    if (Math.abs(ref - sweep * EXPEDITION_SWEEP_SHARE) > 1) {
      problems.push(`${d.id}: ${EXPEDITION_REF_HOURS}h pays ${ref}, not ${(sweep * EXPEDITION_SWEEP_SHARE).toFixed(1)}`);
    }
  }
  return problems;
}
