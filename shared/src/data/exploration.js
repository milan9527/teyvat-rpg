// 探索度: what fraction of a zone a player has actually finished.
//
// Why this is a *derivation* and not a counter. Everything a zone offers once — an anchor
// activated, a campfire lit, a chest opened, a puzzle solved — has been writing a row in
// `world_progress` since the first commit, keyed `(player, zone, poi)`. So the percentage is a
// query over rows that already exist, in exactly the sense `data/achievements.js` argues for:
// nothing bumps a percentage when a chest opens, so nothing can bump it twice; a save made
// before this file existed reports its real exploration the first time it is read; and there is
// no second copy of the truth to drift.
//
// The denominator is the zone table, which is why this lives in shared/: the server prices the
// achievement from it, the map panel draws the bar from it, and the two must not be able to
// disagree about what 100% means.
//
// One deliberate asymmetry: an anchor counts as found through `isAnchorUnlocked`, not through a
// raw row, because that function already says the zone's *default* anchor is travellable without
// a row (it is how you arrive). Counting rows here instead would have made the map draw an
// active diamond on an anchor that 探索度 called undiscovered — one fact, two answers, in the
// same panel.

import { ZONES, CHEST_TIERS } from './zones.js';
import { isAnchorUnlocked, zoneProgress, TELEPORT_TYPES } from './anchors.js';

/**
 * POI types that count toward 探索度, with the payload flag that marks one as done.
 *
 * `flag` is not decoration: `repo.achSnapshot` and this file both tell a chest from a waypoint
 * by *what the route wrote* rather than by the key text, and the three routes write three
 * different shapes. `writer` names the route that writes it, so `exploreGateReport` can refuse a
 * type whose flag nobody produces.
 */
export const EXPLORE_TYPES = {
  waypoint: { label: '锚点', flag: 'unlocked', writer: 'POST /api/world/unlock' },
  statue: { label: '神像', flag: 'unlocked', writer: 'POST /api/world/unlock' },
  warmth: { label: '篝火', flag: 'unlocked', writer: 'POST /api/world/unlock' },
  chest: { label: '宝箱', flag: 'opened', writer: 'POST /api/world/chest' },
  puzzle: { label: '谜题', flag: 'solved', writer: 'POST /api/world/puzzle' },
};

/**
 * POI types that are *not* progress, and why.
 *
 * Listed rather than implied: `POI_PROPS` in `data/zoneGate.js` is the authored vocabulary of POI
 * types, and `exploreGateReport` checks it equals `EXPLORE_TYPES ∪ UNCOUNTED_TYPES` in both
 * directions. A new POI type therefore cannot be added without someone deciding whether walking
 * to it is exploration — the alternative is a type that silently lowers every zone's percentage
 * (counted but never markable) or one that silently vanishes from it.
 */
export const UNCOUNTED_TYPES = {
  dungeon: '秘境入口：进去以后算的是秘境自己的探索度，门本身不是一件要完成的事',
};

/**
 * Zone kinds that have a 探索度 at all.
 *
 * Only the open world. A 秘境 has one anchor and one reward chest, so its percentage would be
 * 50% for arriving and 100% for the chest — three coarse steps that say nothing about whether it
 * has been *beaten*, which is what `chamber_records` (层数 and 星数, two achievements already)
 * measures. Worse, with dungeons in the pool a brand-new account reads 「最高探索度 50%」 before
 * it has walked anywhere, which is a tier paid for nothing.
 */
export const EXPLORED_KINDS = new Set(['open']);

/** Every POI in a zone that 探索度 counts, in table order. */
export function explorables(zdef) {
  return (zdef?.poi || []).filter((p) => EXPLORE_TYPES[p.type]);
}

/**
 * Has this one POI been done?
 *
 * Anchors defer to `isAnchorUnlocked` (see the note at the top); everything else asks for the
 * flag its own route writes, so a monument's `{lit}` row — recorded under a `p:` key beside the
 * puzzle — can never be mistaken for a solved puzzle.
 */
export function isFound(zdef, poi, zoneProg = {}) {
  const spec = EXPLORE_TYPES[poi?.type];
  if (!spec) return false;
  if (TELEPORT_TYPES.has(poi.type)) return isAnchorUnlocked(zdef, poi, zoneProg);
  return zoneProg[poi.id]?.[spec.flag] === true;
}

/**
 * One zone's exploration.
 *
 * `pct` is floored, and pinned below 100 until every single POI is done: "99%" with one chest
 * left is the number that sends a player back out to look for it, while a rounded-up 100% with
 * something unfinished would make the achievement below unearnable-looking and the map lie.
 * A zone with nothing to find (none exist; the gate refuses one) reads 100/0.
 */
export function zoneExploration(zdef, zoneProg = {}) {
  const list = explorables(zdef);
  const byType = [];
  let found = 0;
  for (const [type, spec] of Object.entries(EXPLORE_TYPES)) {
    const mine = list.filter((p) => p.type === type);
    if (!mine.length) continue;
    const done = mine.filter((p) => isFound(zdef, p, zoneProg)).length;
    found += done;
    byType.push({ type, label: spec.label, found: done, total: mine.length });
  }
  const total = list.length;
  const pct = !total ? 100
    : found >= total ? 100
      : Math.min(99, Math.floor((found * 100) / total));
  return { zone: zdef?.id || null, found, total, pct, byType };
}

/**
 * Every zone at once, plus the two numbers the achievements read.
 *
 * `best` and `complete` are both monotone in the row set, which is the requirement
 * `data/achievements.js` puts on any stat it reads: rows are only ever added, so neither can
 * fall and un-earn a tier somebody has not collected yet.
 */
export function explorationSummary(worldProgress, zones = ZONES) {
  const byZone = {};
  let best = 0, complete = 0, found = 0, total = 0;
  for (const zdef of Object.values(zones)) {
    if (!EXPLORED_KINDS.has(zdef.kind)) continue;
    const r = zoneExploration(zdef, zoneProgress(worldProgress, zdef.id));
    byZone[zdef.id] = r;
    best = Math.max(best, r.pct);
    if (r.total && r.found >= r.total) complete++;
    found += r.found; total += r.total;
  }
  return { byZone, best, complete, found, total };
}

/** What to write on a bar: 「蒙德 44% · 锚点 1/3 · 宝箱 1/4」 */
export function exploreText(r) {
  return `${r.pct}%${r.byType.map((b) => ` · ${b.label} ${b.found}/${b.total}`).join('')}`;
}

/* ------------------------------------------------------------- milestones -- */

/**
 * The 探索度 steps that pay.
 *
 * Until these existed the percentage paid **only through achievements**, and those are global
 * high-water marks: `survey` reads the *best* zone and `atlas` counts the *finished* ones. So the
 * first zone a player pushed to 100% collected every tier of both, and the second and third zone
 * paid literally nothing for the walk — 龙脊雪山 from 11% to 88% was a number going up on a panel.
 * A per-zone ladder is the missing half: the same walk pays in every zone, and it pays more the
 * closer you are to finishing, which is exactly where the hard-to-find things are.
 *
 * Five steps rather than ten: 探索度 moves in steps of one POI (9 POI in 蒙德 = 11 points), so
 * ten milestones would mean several of them landing on a single chest.
 *
 * The lowest step has to sit **above what a zone reads on arrival** — the default anchor counts as
 * found without a row (see `isFound`), so a fresh save reads 11%/11%/12%, and a 10% milestone would
 * pay every account for walking through the door. `exploreGateReport` derives that bound from
 * `zoneExploration(zdef, {})` rather than trusting this comment.
 */
export const EXPLORE_MILESTONES = [20, 40, 60, 80, 100];

/**
 * The `world_progress` key holding how much of the ladder has been paid for, per zone.
 *
 * Not a new table and not a new column: the paid mark is one row in the table 探索度 is already
 * derived from, so it arrives in `loadPlayer`'s blob (and therefore in `publicPlayer`) with no new
 * wire format, and the guarded UPDATE in `repo.claimExploreMilestone` is the same
 * arbiter-in-the-UPDATE that stops two clicks from paying an achievement tier twice.
 *
 * The `x:` prefix matters. Rows in this table are keyed by POI id, and three readers walk them:
 * `isFound` (indexes by authored POI id, so an extra key is invisible to it), `achSnapshot`
 * (counts by payload shape — `{pct}` has no `opened`/`solved`/`unlocked`, so it counts nowhere)
 * and `world.applyProgress` (which switches on the prefix, alongside `p:` monuments and `g:`
 * gather timers). A bare key like `milestone` would be one typo away from an authored POI id.
 */
export const MILESTONE_KEY = 'x:explore';

/**
 * What a zone's chests pay at face value: mora at the midpoint of each tier's range.
 *
 * This is the whole pricing rule, in one sentence: **finishing a zone's 探索度 pays what that
 * zone's chests paid.** Nothing here is a hand-written constant, which is the point — the
 * milestones of a zone with four chests including a luxurious one are worth more than those of a
 * zone with two, automatically, and adding a chest to a zone raises its ladder in the same edit.
 * The alternative (a table of primogem amounts next to the thresholds) is the mistake
 * `balance-check` was built for: a constant sitting beside a curve it was eyeballed against.
 *
 * Currency only, deliberately. A material stack would need a second pricing rule (which material,
 * how many) and the zone's own gather nodes already pay materials by the hundred; what exploration
 * is short of is a reason to hunt the last chest, and that reads as 摩拉 + 原石.
 */
export function zoneChestValue(zdef) {
  let mora = 0, primogem = 0;
  for (const p of zdef?.poi || []) {
    if (p.type !== 'chest') continue;
    const tier = CHEST_TIERS[p.tier];
    if (!tier) continue;
    mora += Math.round((tier.mora[0] + tier.mora[1]) / 2);
    primogem += tier.primogem || 0;
  }
  return { mora, primogem };
}

/**
 * The ladder for one zone: `[{ pct, rewards: { mora, primogem } }]`.
 *
 * Back-loaded, and by construction rather than by taste: each step's share of the total is its own
 * threshold over the sum of the thresholds (20+40+60+80+100 = 300), so 100% pays a third of the
 * zone and 20% pays a fifteenth. That shape is the honest one — the first 20% of a zone is the
 * things you cannot miss, the last 20% is the chest behind the waterfall.
 *
 * Split by **cumulative** rounding, not by rounding each step: five independently rounded shares
 * of 17 原石 add up to 15, and then the sentence above stops being true. Rounding the running
 * total and taking differences makes the sum exact for any threshold list, which is what
 * `exploreGateReport` and `api-check` assert.
 */
export function milestoneRewards(zdef, milestones = EXPLORE_MILESTONES) {
  const total = zoneChestValue(zdef);
  const denom = milestones.reduce((s, m) => s + m, 0) || 1;
  const out = [];
  let cum = 0, paidMora = 0, paidGem = 0;
  for (const pct of milestones) {
    cum += pct;
    const upToMora = Math.round((total.mora * cum) / denom);
    const upToGem = Math.round((total.primogem * cum) / denom);
    out.push({ pct, rewards: { mora: upToMora - paidMora, primogem: upToGem - paidGem } });
    paidMora = upToMora; paidGem = upToGem;
  }
  return out;
}

/** How far up the ladder this zone has already been paid. */
export function milestonePaid(zoneProg = {}) {
  const v = zoneProg?.[MILESTONE_KEY]?.pct;
  return Number.isFinite(v) ? v : 0;
}

/**
 * Everything both the button and the route need: what is claimable in this zone right now.
 *
 * One function so the map panel's 「领取探索奖励」 and `POST /api/world/explore/claim` cannot
 * disagree about what a click is worth — the panel prints `reward`, the route pays `reward`, and
 * the route re-derives it from its own copy of the rows rather than believing the request.
 *
 * `to` is the mark to write: the *highest* claimable threshold, not one per click. A save that
 * predates this file and already sits at 88% collects 20/40/60/80 in one press, for the same
 * reason an achievement pays every tier below the one it earned — the ladder is a high-water
 * mark, not a queue, and there is no state in which making the player press four times is better.
 *
 * `null` for a 秘境: no 探索度 (see `EXPLORED_KINDS`), so no ladder either.
 */
export function exploreClaim(zdef, zoneProg = {}) {
  if (!zdef || !EXPLORED_KINDS.has(zdef.kind)) return null;
  const ex = zoneExploration(zdef, zoneProg);
  const paid = milestonePaid(zoneProg);
  const steps = milestoneRewards(zdef).map((s) => ({
    ...s,
    state: s.pct <= paid ? 'paid' : s.pct <= ex.pct ? 'ready' : 'locked',
  }));
  const ready = steps.filter((s) => s.state === 'ready');
  const reward = { mora: 0, primogem: 0 };
  for (const s of ready) { reward.mora += s.rewards.mora; reward.primogem += s.rewards.primogem; }
  return {
    zone: zdef.id, pct: ex.pct, paid, steps,
    claimable: ready.map((s) => s.pct),
    to: ready.length ? ready[ready.length - 1].pct : paid,
    reward,
    next: steps.find((s) => s.state === 'locked') || null,
  };
}

/**
 * Every zone with something to collect, richest first — the whole source of the HUD's 🎁 chip.
 *
 * The ladder had a hole the day it shipped: the only places that said 「有奖可领」 were the map
 * panel's zone row and its footer button, and both of them are *inside* the panel. A player who
 * pushed 龙脊雪山 past 40% and never opened the map again was never told — which is the same
 * failure the ladder was built to fix (a reward nobody is told about is not a reward), one screen
 * further out. The mailbox and the achievements already answer this with a chip in the currency
 * row; this is the third errand, and it is the only one that needs no round trip at all: the rows
 * are in `player.worldProgress`, so the count is a derivation of the document the HUD already
 * holds, refreshed by the one line every writer repeats (`_applyPlayer` → `playerState`).
 *
 * Sorted by what the press is worth, because the chip can only route a click at one zone.
 * `zones` is a parameter for the same reason it is in `explorationSummary`: the gate fires this
 * with fakes.
 */
export function exploreClaims(worldProgress, zones = ZONES) {
  const out = [];
  const reward = { mora: 0, primogem: 0 };
  let rungs = 0;
  for (const zdef of Object.values(zones)) {
    const st = exploreClaim(zdef, zoneProgress(worldProgress, zdef.id));
    if (!st || !st.claimable.length) continue;
    out.push(st);
    rungs += st.claimable.length;
    reward.mora += st.reward.mora;
    reward.primogem += st.reward.primogem;
  }
  out.sort((a, b) => b.reward.mora - a.reward.mora || b.pct - a.pct);
  return { zones: out, rungs, reward, best: out[0] || null };
}

/**
 * Two-way gate over the vocabulary and the zone tables.
 *
 * `poiProps` is `POI_PROPS` from `data/zoneGate.js`, passed in rather than imported to keep this
 * file free of the gate module (and so a probe can mutate it). `milestones` and `milestoneKey`
 * default to the real ones and are parameters for the same reason: a gate line that can only be
 * made to fire by editing the module it guards is a line nobody has ever seen fire.
 */
export function exploreGateReport({
  zones = ZONES, poiProps = null, milestones = EXPLORE_MILESTONES, milestoneKey = MILESTONE_KEY,
} = {}) {
  const problems = [];
  const counted = Object.keys(EXPLORE_TYPES);
  const uncounted = Object.keys(UNCOUNTED_TYPES);

  for (const t of counted) {
    if (UNCOUNTED_TYPES[t]) problems.push(`POI type "${t}" is both counted and declared uncounted`);
    const spec = EXPLORE_TYPES[t];
    if (!spec.label || !spec.flag || !spec.writer) {
      problems.push(`explore type "${t}" is missing label/flag/writer`);
    }
  }

  // The authored vocabulary, both ways: a type nobody classified would either drag every
  // zone's percentage down forever or disappear from it, and both are silent.
  if (poiProps) {
    for (const t of Object.keys(poiProps)) {
      if (!EXPLORE_TYPES[t] && !UNCOUNTED_TYPES[t]) {
        problems.push(`POI type "${t}" exists in the zone tables but 探索度 neither counts it nor declares it uncounted`);
      }
    }
    for (const t of [...counted, ...uncounted]) {
      if (!poiProps[t]) problems.push(`探索度 classifies POI type "${t}", which no zone can author`);
    }
  }

  // The ladder's own shape. Ascending, ending at 100 — a ladder whose top step is 80% would leave
  // the hardest find in the game unpaid, and a repeated threshold would pay one step twice.
  if (!milestones.length) problems.push('探索度 has no milestone, so the percentage pays nothing per zone');
  let prevM = 0;
  for (const m of milestones) {
    if (!(m > prevM)) problems.push(`探索度 milestones must ascend: ${prevM}% then ${m}%`);
    if (!(m >= 1 && m <= 100)) problems.push(`探索度 milestone ${m}% is not a percentage`);
    prevM = m;
  }
  if (milestones.length && prevM !== 100) {
    problems.push(`the last 探索度 milestone is ${prevM}%, so finishing a zone pays nothing`);
  }
  // The paid mark shares a table with POI rows, and three readers tell them apart by prefix.
  if (!/^[a-z]+:/.test(milestoneKey)) {
    problems.push(`the milestone key "${milestoneKey}" has no prefix, so it is one typo away from a POI id`);
  }

  // Every counted type has to actually appear somewhere, and every zone has to have something
  // to find — a zone with an empty denominator reads 100% the moment it is entered.
  const used = new Set();
  let open = 0;
  for (const zdef of Object.values(zones)) {
    const list = explorables(zdef);
    if (!EXPLORED_KINDS.has(zdef.kind)) continue;
    // Counted over the open world only: a type that lives exclusively inside 秘境 is a type no
    // 探索度 can ever move, which is the dead-data case this check exists for.
    for (const p of list) used.add(p.type);
    open++;
    if (!list.length) {
      problems.push(`zone "${zdef.id}" has nothing to explore, so its 探索度 is 100% on arrival`);
    }
    // A percentage over four things moves in 25% steps and cannot express 「差一个宝箱」, and the
    // achievement below asks for 50% and 80% of *some* zone.
    if (list.length < 5) {
      problems.push(`zone "${zdef.id}" only has ${list.length} things to find, too coarse for a percentage`);
    }

    // --- the milestone ladder, per zone ---
    // The bound the comment on EXPLORE_MILESTONES claims, measured instead of asserted in prose:
    // what does this zone read before the player has done anything? The default anchor counts as
    // found without a row, so that number is not 0, and a first milestone at or below it would
    // pay every account for arriving.
    const free = zoneExploration(zdef, {}).pct;
    if (milestones.length && free >= milestones[0]) {
      problems.push(`zone "${zdef.id}" reads ${free}% on arrival, at or above the first milestone `
        + `(${milestones[0]}%) — walking in would collect a reward`);
    }
    // An unpriced tier would silently shrink the ladder instead of failing.
    const chests = (zdef.poi || []).filter((p) => p.type === 'chest');
    const unpriced = chests.filter((p) => !CHEST_TIERS[p.tier]);
    if (unpriced.length) {
      problems.push(`zone "${zdef.id}" has ${unpriced.length} chest(s) of an unpriced tier `
        + `(${unpriced.map((p) => p.tier).join(',')}), so its milestones are underpaid`);
    }
    // 「走完一个地区，付这个地区的宝箱那一份」 — exactly, or the sentence is not the rule.
    const ladder = milestoneRewards(zdef, milestones);
    const want = zoneChestValue(zdef);
    const got = ladder.reduce((a, s) => ({
      mora: a.mora + s.rewards.mora, primogem: a.primogem + s.rewards.primogem,
    }), { mora: 0, primogem: 0 });
    if (got.mora !== want.mora || got.primogem !== want.primogem) {
      problems.push(`zone "${zdef.id}" milestones sum to ${got.mora} mora / ${got.primogem} 原石, `
        + `not its chest value ${want.mora} / ${want.primogem}`);
    }
    for (const s of ladder) {
      if (!(s.rewards.mora > 0) || !(s.rewards.primogem > 0)) {
        problems.push(`zone "${zdef.id}" milestone ${s.pct}% pays ${s.rewards.mora} mora / `
          + `${s.rewards.primogem} 原石 — a step that pays nothing is not a milestone`);
      }
    }
    if ((zdef.poi || []).some((p) => p.id === milestoneKey)) {
      problems.push(`zone "${zdef.id}" has a POI whose id is the milestone key "${milestoneKey}"`);
    }
  }
  if (!open) problems.push('no zone has a 探索度 at all, so the achievements below are unreachable');
  // The same bound as `free >= milestones[0]` above, but read off the aggregate the HUD chip
  // counts: a brand-new account must have no errand at all. Two sides of one rule, because the
  // per-zone line is about a percentage and this one is about the badge a player sees.
  const arrival = exploreClaims({}, zones);
  if (arrival.rungs) {
    problems.push(`a save with no rows already owes ${arrival.rungs} milestone(s) in `
      + `${arrival.zones.map((z) => z.zone).join(',')} — the 🎁 chip would be lit on a new account`);
  }
  for (const t of counted) {
    if (!used.has(t)) problems.push(`探索度 counts POI type "${t}", which no zone contains`);
  }
  return problems;
}
