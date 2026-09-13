// Achievements: the only system in the game that reads state instead of receiving events.
//
// The obvious way to build 成就 is a counter per achievement, bumped from wherever the thing
// happens. That is eight new call sites, eight chances to bump twice or not at all, and a
// second copy of numbers the database already holds — `leaderboard.kills` and
// `chamber_records` have been counting since the first commit, and a fresh `ach_kills` column
// would start at zero for every account that already exists.
//
// So the rule here is: **an achievement is a threshold on a stat, and a stat is a query.**
// `GET /api/achievements` assembles a snapshot with a handful of aggregates and compares it
// with the tier table below. Nothing is written when progress happens; the only row this
// module owns records *what has been paid for*, because that is the one fact no aggregate can
// reproduce. Consequences worth stating:
//
//   - Progress is retroactive. A save from before this file existed shows its real numbers.
//   - There is no drift to fix, because there is nothing to keep in sync.
//   - Every stat must be **monotone**. A number that can go down would un-earn an unclaimed
//     achievement, so current balances (mora, resin, bag counts) are deliberately absent, and
//     the two things that *could* regress are handled: daily quests are excluded from
//     `quests` (`dailiesToRoll` flips them back to active every morning), and friendship is
//     counted as a lifetime tally rather than as `count(friends)`, which unfriending lowers.
//
// A few things genuinely are not derivable — nobody records a cooked dish or a conversation,
// and gathering nodes regrow over their own progress rows. Those live in `players.stats`, a
// JSONB bag of lifetime tallies bumped in exactly one place: the funnel every gameplay event
// already passes through (`progression.advanceQuests`). `LIFETIME_EVENTS` below is that
// mapping, and it is shared rather than server-local so `achGateReport()` can check both
// directions — a lifetime stat nothing bumps, or a bump no achievement reads, is a bug the
// tools catch instead of a dead key that sits in the file for a year.

/**
 * Every stat an achievement is allowed to read, and where the number comes from.
 *
 * `src: 'db'`       — an aggregate in `repo.achSnapshot`, derived on read.
 * `src: 'lifetime'` — a tally in `players.stats`, bumped through `LIFETIME_EVENTS`.
 *
 * The `unit` is what the panel writes after the number; `name` is what it calls the axis.
 */
export const ACH_STATS = {
  rank: { name: '冒险等阶', src: 'db', unit: '级' },
  worldLevel: { name: '世界等级', src: 'db', unit: '级' },
  playHours: { name: '游戏时长', src: 'db', unit: '小时' },
  zonesTouched: { name: '留下痕迹的地区', src: 'db', unit: '个' },
  quests: { name: '完成的任务', src: 'db', unit: '个' },

  kills: { name: '击败的敌人', src: 'db', unit: '个' },
  maxDamage: { name: '最高单次伤害', src: 'db', unit: '点' },
  chambers: { name: '通过的秘境', src: 'db', unit: '层' },
  abyssStars: { name: '秘境星数', src: 'db', unit: '星' },

  chests: { name: '开启的宝箱', src: 'db', unit: '个' },
  puzzles: { name: '解开的谜题', src: 'db', unit: '个' },
  waypoints: { name: '激活的锚点', src: 'db', unit: '个' },
  gathered: { name: '采集次数', src: 'lifetime', unit: '次' },
  // 探索度: derived from the same `world_progress` rows as the three above, but as a *fraction of
  // one zone* rather than a lifetime count — see `data/exploration.js`. Both are monotone in the
  // row set, which is the only thing this module requires of a stat.
  exploreBest: { name: '单个地区最高探索度', src: 'db', unit: '%' },
  zonesExplored: { name: '完全探索的地区', src: 'db', unit: '个' },

  chars: { name: '同行的角色', src: 'db', unit: '名' },
  charLevel: { name: '最高角色等级', src: 'db', unit: '级' },
  ascension: { name: '最高突破阶段', src: 'db', unit: '阶' },
  talent: { name: '最高天赋等级', src: 'db', unit: '级' },
  constellation: { name: '最高命之座', src: 'db', unit: '重' },
  weapons: { name: '拥有的武器', src: 'db', unit: '把' },
  artifacts: { name: '拥有的圣遗物', src: 'db', unit: '件' },

  cooked: { name: '烹饪次数', src: 'lifetime', unit: '次' },
  talks: { name: '对话次数', src: 'lifetime', unit: '次' },
  friendsMade: { name: '结识的旅行者', src: 'lifetime', unit: '位' },

  wishes: { name: '祈愿次数', src: 'db', unit: '次' },
  fiveStars: { name: '五星收获', src: 'db', unit: '个' },
};

/**
 * Which gameplay event bumps which lifetime tally, keyed by the `kind` that
 * `advanceQuests(player, { kind, target, count })` already carries.
 *
 * Only the kinds whose totals cannot be recovered from another table belong here. `kill`,
 * `chest`, `puzzle`, `waypoint` and `chamber` are all absent on purpose: they are counted by
 * `leaderboard`, `world_progress` and `chamber_records`, and tallying them here as well would
 * be the duplicate bookkeeping this module exists to avoid.
 */
export const LIFETIME_EVENTS = {
  cook: 'cooked',
  gather: 'gathered',
  talk: 'talks',
};

/** Lifetime tallies bumped outside the event funnel, by the route that owns the fact. */
export const LIFETIME_DIRECT = { friendsMade: 'social.accept' };

/** Primogems paid for reaching tier n (index), so a later tier is always worth more. */
export const TIER_GEMS = [10, 20, 30, 60];

/**
 * Tier labels, for the panel's badge. Circled digits rather than Roman numerals: at 13px an
 * `Ⅰ` is a bare vertical stroke that reads as a stray rule in the list, and `Ⅲ` is wider than
 * the fixed badge column. Checked on a screenshot, not in theory.
 */
export const TIER_LABELS = ['①', '②', '③', '④'];

/**
 * Categories. The icons are monochrome symbols already used elsewhere in this UI (`PIN_GLYPH`
 * in `client/src/ui/panels.js`) instead of colour emoji, because the target box has no emoji
 * font for half of them — 🍳 and 🗺 came out as blank boxes in the probe screenshot while ✨
 * rendered, which is exactly the kind of gap a DOM assertion cannot see.
 */
export const ACH_GROUPS = [
  { id: 'adventure', name: '冒险之路', icon: '◈' },
  { id: 'combat', name: '战斗', icon: '⊗' },
  { id: 'explore', name: '探索', icon: '▣' },
  { id: 'build', name: '养成', icon: '✦' },
  { id: 'life', name: '生活', icon: '✹' },
  { id: 'wish', name: '祈愿', icon: '⛩' },
];

/**
 * The catalogue. One entry per achievement, `targets` ascending — a tiered achievement is one
 * row in the database (`tier` = how many steps have been paid for) instead of three rows that
 * repeat each other's text, and it lets the panel show the *next* number rather than a wall of
 * greyed-out duplicates.
 */
export const ACHIEVEMENTS = [
  // --- 冒险之路 ---
  { id: 'ar', group: 'adventure', stat: 'rank', name: '冒险家的阶梯', targets: [10, 20, 35, 50],
    desc: '提升冒险等阶' },
  { id: 'world', group: 'adventure', stat: 'worldLevel', name: '世界的重量', targets: [1, 3, 5],
    desc: '提升世界等级，敌人会跟着变强' },
  { id: 'hours', group: 'adventure', stat: 'playHours', name: '提瓦特时间', targets: [1, 5, 20],
    desc: '在提瓦特度过的时间' },
  { id: 'roam', group: 'adventure', stat: 'zonesTouched', name: '足迹', targets: [2, 4, 6],
    desc: '在不同地区留下痕迹' },
  { id: 'quest', group: 'adventure', stat: 'quests', name: '委托与传说', targets: [1, 5, 15],
    desc: '完成任务（每日委托不计）' },

  // --- 战斗 ---
  { id: 'slay', group: 'combat', stat: 'kills', name: '势不可挡', targets: [20, 200, 1000, 3000],
    desc: '击败敌人' },
  { id: 'crit', group: 'combat', stat: 'maxDamage', name: '一击', targets: [1000, 5000, 20000],
    desc: '打出一次高额伤害' },
  { id: 'domain', group: 'combat', stat: 'chambers', name: '秘境挑战者', targets: [1, 5, 12],
    desc: '通过秘境的层数' },
  { id: 'stars', group: 'combat', stat: 'abyssStars', name: '星之所在', targets: [3, 15, 36],
    desc: '累计秘境星数' },

  // --- 探索 ---
  { id: 'chest', group: 'explore', stat: 'chests', name: '寻宝的直觉', targets: [5, 30, 100],
    desc: '开启宝箱' },
  { id: 'puzzle', group: 'explore', stat: 'puzzles', name: '机关的解法', targets: [1, 5, 15],
    desc: '解开野外谜题' },
  { id: 'anchor', group: 'explore', stat: 'waypoints', name: '七天神像的指引', targets: [2, 6, 12],
    desc: '激活传送锚点' },
  { id: 'gather', group: 'explore', stat: 'gathered', name: '采集者', targets: [10, 60, 200],
    desc: '采集野外材料' },
  // A fresh account reads 12% (the zone entry anchor is travellable without a row), so the first
  // tier is not free; 100% of a single zone is 8-9 finds, so the last one is not out of reach.
  { id: 'survey', group: 'explore', stat: 'exploreBest', name: '踏遍此地', targets: [50, 80, 100],
    desc: '把一个地区的探索度推上去（锚点、神像、篝火、宝箱、谜题）' },
  // Three open-world zones exist, so [1,2,3] is "one of them", "two of them", "all of them".
  { id: 'atlas', group: 'explore', stat: 'zonesExplored', name: '大地的图册', targets: [1, 2, 3],
    desc: '把地区的探索度做到 100%' },

  // --- 养成 ---
  { id: 'party', group: 'build', stat: 'chars', name: '同行者', targets: [2, 4, 6],
    desc: '获得角色' },
  { id: 'level', group: 'build', stat: 'charLevel', name: '突破极限', targets: [20, 40, 60, 80],
    desc: '把一名角色练到高等级' },
  { id: 'ascend', group: 'build', stat: 'ascension', name: '阶梯之上', targets: [1, 3, 5],
    desc: '为角色突破' },
  { id: 'talent', group: 'build', stat: 'talent', name: '技艺', targets: [3, 6, 9],
    desc: '提升天赋等级' },
  { id: 'consts', group: 'build', stat: 'constellation', name: '命之座', targets: [1, 3, 6],
    desc: '解锁命之座' },
  { id: 'arms', group: 'build', stat: 'weapons', name: '武器库', targets: [3, 10, 25],
    desc: '收集武器' },
  { id: 'relic', group: 'build', stat: 'artifacts', name: '圣遗物收藏', targets: [5, 25, 60],
    desc: '收集圣遗物' },

  // --- 生活 ---
  { id: 'cook', group: 'life', stat: 'cooked', name: '好吃的', targets: [3, 20, 80],
    desc: '烹饪料理' },
  { id: 'talk', group: 'life', stat: 'talks', name: '健谈的旅行者', targets: [3, 15, 40],
    desc: '与人交谈' },
  { id: 'friend', group: 'life', stat: 'friendsMade', name: '并肩', targets: [1, 3],
    desc: '结识其他旅行者' },

  // --- 祈愿 ---
  { id: 'wish', group: 'wish', stat: 'wishes', name: '命运的邀请', targets: [10, 50, 150],
    desc: '进行祈愿' },
  { id: 'gold', group: 'wish', stat: 'fiveStars', name: '金色的光', targets: [1, 3, 8],
    desc: '祈愿获得五星' },
];

export const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

/** Primogems for tier index `i`; the last entry repeats for anything deeper. */
export function tierGems(i) {
  return TIER_GEMS[Math.min(i, TIER_GEMS.length - 1)];
}

/** Total primogems an achievement is worth if every tier is taken. */
export function achWorth(a) {
  return a.targets.reduce((s, _t, i) => s + tierGems(i), 0);
}

/**
 * Where one achievement stands: how many tiers the progress has earned, how many are paid
 * for, and what the next threshold is.
 *
 * `earned` is recomputed from the snapshot every time rather than stored, which is what makes
 * an old save light up the moment this code ships. `claimable = earned - claimed` can only be
 * positive because every stat is monotone.
 */
export function achState(a, progress = {}, claimedTier = 0) {
  const have = Number(progress[a.stat] || 0);
  let earned = 0;
  for (const t of a.targets) { if (have >= t) earned++; else break; }
  const claimed = Math.min(claimedTier, a.targets.length);
  const nextIdx = Math.min(earned, a.targets.length - 1);
  const done = earned >= a.targets.length;
  return {
    id: a.id,
    have,
    earned,
    claimed,
    claimable: Math.max(0, earned - claimed),
    gems: a.targets.slice(claimed, earned).reduce((s, _t, i) => s + tierGems(claimed + i), 0),
    target: a.targets[nextIdx],
    // A finished achievement has no "next", so the bar is full rather than 0/last.
    frac: done ? 1 : Math.max(0, Math.min(1, have / a.targets[nextIdx])),
    done,
    tierLabel: TIER_LABELS[Math.min(Math.max(earned - 1, 0), TIER_LABELS.length - 1)],
  };
}

/** Panel header numbers, computed the same way on both sides of the wire. */
export function achSummary(progress = {}, claimed = {}) {
  let tiers = 0, earnedTiers = 0, claimableTiers = 0, gems = 0, done = 0;
  for (const a of ACHIEVEMENTS) {
    const st = achState(a, progress, claimed[a.id] || 0);
    tiers += a.targets.length;
    earnedTiers += st.earned;
    claimableTiers += st.claimable;
    gems += st.gems;
    if (st.done) done++;
  }
  return { tiers, earnedTiers, claimableTiers, gems, done, total: ACHIEVEMENTS.length };
}

/** Grouped view for the panel, in catalogue order, claimable first inside each group. */
export function achByGroup(progress = {}, claimed = {}) {
  return ACH_GROUPS.map((g) => {
    const items = ACHIEVEMENTS.filter((a) => a.group === g.id)
      .map((a) => ({ def: a, st: achState(a, progress, claimed[a.id] || 0) }));
    items.sort((x, y) => (y.st.claimable > 0) - (x.st.claimable > 0)
      || (x.st.done - y.st.done));
    return { ...g, items, claimable: items.reduce((s, i) => s + i.st.claimable, 0) };
  });
}

/**
 * The consumer gate, in both directions.
 *
 * Authored data rots two ways: a condition nothing can ever satisfy, and a number computed for
 * nobody. Both are invisible at runtime — the achievement simply never fires, the stat simply
 * never appears — so the check is a function the tools call, and `tools/api-check.mjs` also
 * compares the *server's* snapshot keys against `ACH_STATS` so a stat cannot be declared here
 * and forgotten in the query.
 */
export function achGateReport() {
  const problems = [];
  const seen = new Set();
  const read = new Set();
  const bumped = new Set([...Object.values(LIFETIME_EVENTS), ...Object.keys(LIFETIME_DIRECT)]);

  for (const a of ACHIEVEMENTS) {
    if (seen.has(a.id)) problems.push(`duplicate achievement id ${a.id}`);
    seen.add(a.id);
    read.add(a.stat);
    if (!ACH_STATS[a.stat]) problems.push(`${a.id} reads undeclared stat "${a.stat}"`);
    if (!ACH_GROUPS.some((g) => g.id === a.group)) problems.push(`${a.id} is in unknown group "${a.group}"`);
    if (!a.targets?.length) problems.push(`${a.id} has no targets`);
    if (a.targets.some((t, i) => i > 0 && t <= a.targets[i - 1])) {
      problems.push(`${a.id} targets are not strictly ascending: ${a.targets.join(',')}`);
    }
    if (a.targets.some((t) => !(t > 0))) problems.push(`${a.id} has a non-positive target`);
    if (!a.name || !a.desc) problems.push(`${a.id} is missing name or desc`);
  }

  for (const [k, d] of Object.entries(ACH_STATS)) {
    if (!read.has(k)) problems.push(`stat "${k}" is computed but no achievement reads it`);
    if (d.src === 'lifetime' && !bumped.has(k)) {
      problems.push(`lifetime stat "${k}" has no writer in LIFETIME_EVENTS/LIFETIME_DIRECT`);
    }
    if (d.src !== 'lifetime' && bumped.has(k)) {
      problems.push(`stat "${k}" is bumped as a tally but declared src="${d.src}"`);
    }
    if (!d.name || !d.unit) problems.push(`stat "${k}" is missing name or unit`);
  }
  for (const [ev, k] of Object.entries(LIFETIME_EVENTS)) {
    if (!ACH_STATS[k]) problems.push(`event "${ev}" bumps undeclared stat "${k}"`);
  }
  return problems;
}
