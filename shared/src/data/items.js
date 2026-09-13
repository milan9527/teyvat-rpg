// Weapons, artifacts, materials, consumables, and the wish (gacha) pools.

export const ITEM_KIND = {
  weapon: 'weapon', artifact: 'artifact', material: 'material',
  consumable: 'consumable', currency: 'currency', quest: 'quest',
};

export const WEAPONS = {
  travelersBlade:  { id: 'travelersBlade',  name: '旅者之剑', type: 'sword',    rarity: 3, baseAtk: 38, sub: { key: 'atkPct',   value: 0.10 }, desc: '普通攻击伤害提升 8%。', passive: { normalDmg: 0.08 } },
  windriderEdge:   { id: 'windriderEdge',   name: '御风之刃', type: 'sword',    rarity: 4, baseAtk: 44, sub: { key: 'critRate', value: 0.08 }, desc: '施放元素战技后攻击力提升 12%，持续 8 秒。', passive: { onSkillAtk: 0.12, duration: 8 } },
  dawnbreaker:     { id: 'dawnbreaker',     name: '破晓之辉', type: 'sword',    rarity: 5, baseAtk: 48, sub: { key: 'critDmg',  value: 0.19 }, desc: '暴击时恢复 6 点元素能量，元素伤害提升 20%。', passive: { energyOnCrit: 6, elementalDmg: 0.20 } },
  ironGreatsword:  { id: 'ironGreatsword',  name: '铁影阔剑', type: 'claymore', rarity: 3, baseAtk: 42, sub: { key: 'atkPct',   value: 0.11 }, desc: '重击伤害提升 15%。', passive: { chargedDmg: 0.15 } },
  emberCleaver:    { id: 'emberCleaver',    name: '余烬裂斩', type: 'claymore', rarity: 4, baseAtk: 46, sub: { key: 'atkPct',   value: 0.12 }, desc: '击败敌人后攻击力提升 16%，持续 10 秒，可叠加 2 层。', passive: { onKillAtk: 0.16, stacks: 2, duration: 10 } },
  forgeheartMaul:  { id: 'forgeheartMaul',  name: '熔心巨斧', type: 'claymore', rarity: 5, baseAtk: 50, sub: { key: 'critDmg',  value: 0.22 }, desc: '造成炎元素伤害时提升 24% 炎元素伤害。', passive: { elementalDmg: 0.24, element: 'fire' } },
  huntersBow:      { id: 'huntersBow',      name: '猎弓',     type: 'bow',      rarity: 3, baseAtk: 36, sub: { key: 'critRate', value: 0.06 }, desc: '瞄准射击伤害提升 12%。', passive: { aimedDmg: 0.12 } },
  frostfeather:    { id: 'frostfeather',    name: '霜羽长弓', type: 'bow',      rarity: 4, baseAtk: 42, sub: { key: 'critRate', value: 0.09 }, desc: '对被冻结或受冰附着的敌人伤害提升 20%。', passive: { vsFrozen: 0.20 } },
  polarSight:      { id: 'polarSight',      name: '极星之瞳', type: 'bow',      rarity: 5, baseAtk: 47, sub: { key: 'critDmg',  value: 0.20 }, desc: '瞄准射击命中弱点时暴击伤害提升 40%。', passive: { headshotCritDmg: 0.40 } },
  ironSpear:       { id: 'ironSpear',       name: '铁尖枪',   type: 'polearm',  rarity: 3, baseAtk: 39, sub: { key: 'defPct',   value: 0.13 }, desc: '受到伤害后防御力提升 10%。', passive: { onHitDef: 0.10 } },
  stormPike:       { id: 'stormPike',       name: '雷鸣长枪', type: 'polearm',  rarity: 4, baseAtk: 45, sub: { key: 'er',       value: 0.15 }, desc: '元素爆发后攻速提升 15%，持续 8 秒。', passive: { onBurstSpeed: 0.15, duration: 8 } },
  skyPiercer:      { id: 'skyPiercer',      name: '穿云之枪', type: 'polearm',  rarity: 5, baseAtk: 49, sub: { key: 'critRate', value: 0.15 }, desc: '元素战技命中后造成额外 80% 攻击力的范围伤害。', passive: { skillBurst: 0.80 } },
  apprenticeTome:  { id: 'apprenticeTome',  name: '学徒笔记', type: 'catalyst', rarity: 3, baseAtk: 37, sub: { key: 'em',       value: 40 },   desc: '元素精通提升 40 点。', passive: {} },
  tidalGrimoire:   { id: 'tidalGrimoire',   name: '潮汐秘典', type: 'catalyst', rarity: 4, baseAtk: 43, sub: { key: 'hpPct',    value: 0.14 }, desc: '治疗加成提升 15%。', passive: { healBonus: 0.15 } },
  abyssalCodex:    { id: 'abyssalCodex',    name: '深渊圣典', type: 'catalyst', rarity: 5, baseAtk: 46, sub: { key: 'em',       value: 110 },  desc: '触发元素反应时全队元素精通提升 80 点，持续 8 秒。', passive: { teamEm: 80, duration: 8 } },
};

export const ARTIFACT_SLOTS = ['flower', 'plume', 'sands', 'goblet', 'circlet'];
export const SLOT_NAMES = { flower: '生之花', plume: '死之羽', sands: '时之沙', goblet: '空之杯', circlet: '理之冠' };

export const ARTIFACT_SETS = {
  gladiator: {
    id: 'gladiator', name: '角斗士的终幕礼',
    two: { atkPct: 0.18 }, twoDesc: '攻击力提升 18%。',
    four: { normalDmg: 0.35 }, fourIf: { weaponType: ['sword', 'claymore', 'polearm'] },
    fourDesc: '装备单手剑/双手剑/长柄武器时普通攻击伤害提升 35%。',
  },
  windSong: {
    id: 'windSong', name: '风歌者之诗',
    two: { wind: 0.15 }, twoDesc: '风元素伤害提升 15%。',
    four: { swirlBonus: 0.4, emOnSwirl: 60, duration: 8 },
    fourDesc: '扩散反应伤害提升 40%；触发扩散反应时全队元素精通提升 60 点，持续 8 秒。',
  },
  emberCrown: {
    id: 'emberCrown', name: '炽焰之冠',
    two: { fire: 0.15 }, twoDesc: '炎元素伤害提升 15%。',
    four: { onSkillAtk: 0.20, vaporizeBonus: 0.15, duration: 8 },
    fourDesc: '蒸发与融化反应伤害提升 15%；施放元素战技后攻击力提升 20%，持续 8 秒。',
  },
  tidebound: {
    id: 'tidebound', name: '潮汐眷属',
    two: { hpPct: 0.20 }, twoDesc: '生命值上限提升 20%。',
    four: { healBonus: 0.20 }, fourDesc: '治疗加成提升 20%。',
  },
  frostveil: {
    id: 'frostveil', name: '霜华之帷',
    two: { ice: 0.15 }, twoDesc: '冰元素伤害提升 15%。',
    four: { vsFrozen: 0.20, critVsFrozen: 0.20 },
    fourDesc: '对被冻结或受冰附着的敌人伤害提升 20%；攻击被冻结的敌人时暴击率提升 20%。',
  },
  thunderCall: {
    id: 'thunderCall', name: '雷鸣的召唤',
    two: { lightning: 0.15 }, twoDesc: '雷元素伤害提升 15%。',
    four: { energyOnReaction: 6, onReactionSpeed: 0.10, duration: 8,
      onReactions: ['overload', 'electroCharged', 'superconduct'] },
    fourDesc: '触发雷元素反应后恢复 6 点元素能量、攻速提升 10%，持续 8 秒。',
  },
  stoneheart: {
    id: 'stoneheart', name: '磐岩之心',
    two: { defPct: 0.30 }, twoDesc: '防御力提升 30%。',
    four: { shieldStrength: 0.35, dr: 0.10 }, fourDesc: '护盾强效提升 35%，受到的伤害降低 10%。',
  },
  dawnHymn: {
    id: 'dawnHymn', name: '晨曦圣颂',
    two: { healBonus: 0.15 }, twoDesc: '治疗加成提升 15%。',
    four: { teamAtk: 0.15, light: 0.20, duration: 8 },
    fourDesc: '光元素伤害提升 20%；治疗队友后全队攻击力提升 15%，持续 8 秒。',
  },
};

export const ARTIFACT_MAIN_STATS = {
  flower:  [['hp', 4780]],
  plume:   [['atk', 311]],
  sands:   [['atkPct', 0.466], ['hpPct', 0.466], ['defPct', 0.583], ['em', 187], ['er', 0.518]],
  goblet:  [['atkPct', 0.466], ['hpPct', 0.466], ['defPct', 0.583], ['em', 187],
            ['fire', 0.466], ['water', 0.466], ['ice', 0.466], ['lightning', 0.466],
            ['wind', 0.466], ['earth', 0.466], ['light', 0.466], ['physical', 0.583]],
  circlet: [['atkPct', 0.466], ['hpPct', 0.466], ['defPct', 0.583], ['em', 187],
            ['critRate', 0.311], ['critDmg', 0.622], ['healBonus', 0.359]],
};

export const ARTIFACT_SUB_STATS = [
  ['hp', 269, 8], ['atk', 18, 8], ['def', 21, 8],
  ['hpPct', 0.058, 10], ['atkPct', 0.058, 10], ['defPct', 0.073, 10],
  ['em', 23, 10], ['er', 0.065, 9],
  ['critRate', 0.039, 7], ['critDmg', 0.078, 7],
];

export const MATERIALS = {
  mora:              { id: 'mora', name: '摩拉', kind: 'currency', icon: '💰', stack: 999999999 },
  primogem:          { id: 'primogem', name: '原石', kind: 'currency', icon: '💎', stack: 999999 },
  wishTicket:        { id: 'wishTicket', name: '纠缠之缘', kind: 'currency', icon: '🎫', stack: 9999 },
  // Wish change. Every pull hands one of these back, which is what stops a duplicate from
  // being nothing: 星辉 for 4★/5★, 星尘 for the 3★ weapons. `kind: 'material'` rather than
  // `currency` on purpose — `CURRENCIES` in data/shop.js is the list of *columns* on the
  // player row, and these two live in the inventory like every other counted thing, so the
  // material tab shows them and the shop's cost path spends them with no new machinery.
  starglitter:       { id: 'starglitter', name: '星辉', kind: 'material', icon: '✦', stack: 9999 },
  stardust:          { id: 'stardust', name: '星尘', kind: 'material', icon: '✧', stack: 9999 },
  heroWit:           { id: 'heroWit', name: '大英雄的经验', kind: 'material', icon: '📕', stack: 9999, xp: 20000 },
  adventurerXp:      { id: 'adventurerXp', name: '流浪者的经验', kind: 'material', icon: '📗', stack: 9999, xp: 5000 },
  slimeCondensate:   { id: 'slimeCondensate', name: '史莱姆凝液', kind: 'material', icon: '🫧', stack: 9999 },
  slimeSecretions:   { id: 'slimeSecretions', name: '史莱姆清珠', kind: 'material', icon: '💧', stack: 9999 },
  damagedMask:       { id: 'damagedMask', name: '破损的面具', kind: 'material', icon: '🎭', stack: 9999 },
  arrowhead:         { id: 'arrowhead', name: '牢固的箭簇', kind: 'material', icon: '🏹', stack: 9999 },
  wolfClaw:          { id: 'wolfClaw', name: '霜狼之爪', kind: 'material', icon: '🐾', stack: 9999 },
  vishapScale:       { id: 'vishapScale', name: '龙蜥鳞片', kind: 'material', icon: '🐲', stack: 9999 },
  chaosDevice:       { id: 'chaosDevice', name: '混沌装置', kind: 'material', icon: '⚙️', stack: 9999 },
  chaosCore:         { id: 'chaosCore', name: '混沌机芯', kind: 'material', icon: '🔮', stack: 9999 },
  abyssalCrystal:    { id: 'abyssalCrystal', name: '深渊结晶', kind: 'material', icon: '🟣', stack: 9999 },
  heraldsInsignia:   { id: 'heraldsInsignia', name: '使徒的纹徽', kind: 'material', icon: '🔷', stack: 9999 },
  tyrantPlume:       { id: 'tyrantPlume', name: '暴风之羽', kind: 'material', icon: '🪶', stack: 9999 },
  crownFragment:     { id: 'crownFragment', name: '智识之冕碎片', kind: 'material', icon: '👑', stack: 9999 },
  agnidusShard:      { id: 'agnidusShard', name: '炎晶碎屑', kind: 'material', icon: '🔥', stack: 9999 },
  shivadaShard:      { id: 'shivadaShard', name: '冰晶碎屑', kind: 'material', icon: '❄️', stack: 9999 },
  vajradaShard:      { id: 'vajradaShard', name: '雷晶碎屑', kind: 'material', icon: '⚡', stack: 9999 },
  prithivaShard:     { id: 'prithivaShard', name: '岩晶碎屑', kind: 'material', icon: '🪨', stack: 9999 },
  vayudaShard:       { id: 'vayudaShard', name: '风晶碎屑', kind: 'material', icon: '🌪️', stack: 9999 },
  varunadaShard:     { id: 'varunadaShard', name: '水晶碎屑', kind: 'material', icon: '🌊', stack: 9999 },
  sweetFlower:       { id: 'sweetFlower', name: '甜甜花', kind: 'material', icon: '🌸', stack: 9999 },
  mint:              { id: 'mint', name: '薄荷', kind: 'material', icon: '🌿', stack: 9999 },
  crystalCore:       { id: 'crystalCore', name: '晶核', kind: 'material', icon: '🟡', stack: 9999 },
  windwheelAster:    { id: 'windwheelAster', name: '风车菊', kind: 'material', icon: '🌼', stack: 9999 },
  qingxin:           { id: 'qingxin', name: '清心', kind: 'material', icon: '🤍', stack: 9999 },
  // Cooking staples. Gathered, not dropped: a kitchen stocked from monster corpses
  // makes every meal a battle reward, and the point of these two is that a player
  // who only wants to walk around can still cook.
  mushroom:          { id: 'mushroom', name: '蘑菇', kind: 'material', icon: '🍄', stack: 9999 },
  wheat:             { id: 'wheat', name: '麦子', kind: 'material', icon: '🌾', stack: 9999 },
  // Ore. Gatherable from rock outcrops rather than dropped by enemies, which is
  // what gives the mineral half of the map a reason to be walked over.
  ironChunk:         { id: 'ironChunk', name: '铁块', kind: 'material', icon: '🪨', stack: 9999 },
  whiteIronChunk:    { id: 'whiteIronChunk', name: '白铁块', kind: 'material', icon: '⬜', stack: 9999 },
  crystalChunk:      { id: 'crystalChunk', name: '水晶块', kind: 'material', icon: '💎', stack: 9999 },
  starsilver:        { id: 'starsilver', name: '星银矿石', kind: 'material', icon: '✨', stack: 9999 },
  // Consumables
  sweetMadame:       { id: 'sweetMadame', name: '甜甜花酿鸡', kind: 'consumable', icon: '🍗', stack: 999, heal: { flat: 2000, hpPct: 0.18 } },
  northernStew:      { id: 'northernStew', name: '北地烟熏鸡', kind: 'consumable', icon: '🍖', stack: 999, heal: { flat: 3400, hpPct: 0.30 } },
  adeptusTemptation: { id: 'adeptusTemptation', name: '仙跳墙', kind: 'consumable', icon: '🍲', stack: 99, buff: { atkPct: 0.32, critRate: 0.10, duration: 300 } },
  reviveDish:        { id: 'reviveDish', name: '提神醒脑的汤', kind: 'consumable', icon: '🥣', stack: 99, revive: { hpPct: 0.4 } },
  condensedResin:    { id: 'condensedResin', name: '浓缩树脂', kind: 'consumable', icon: '🧴', stack: 99, resin: 40 },
  // Cooked dishes. `heal` is flat + a fraction of max HP so one dish stays useful
  // from level 1 to 90 without being the only healing anyone needs at either end.
  mushroomPizza:     { id: 'mushroomPizza', name: '菌菇披萨', kind: 'consumable', icon: '🍕', stack: 999, heal: { flat: 2600, hpPct: 0.24 } },
  mintJelly:         { id: 'mintJelly', name: '薄荷凉糕', kind: 'consumable', icon: '🍧', stack: 999, buff: { atkPct: 0.14, critRate: 0.05, duration: 300 } },
  // The failure result. Heals a little, which is the joke: nobody throws food away.
  suspiciousFood:    { id: 'suspiciousFood', name: '奇怪的料理', kind: 'consumable', icon: '🍳', stack: 999, heal: { flat: 400, hpPct: 0.03 } },
};

// The 4★ roster is one list shared by both banners. A featured banner does not have a
// *smaller* 4★ pool than the standard one — it has the same pool with three names pulled
// forward (`featuredFour` + `featuredChance`), and `pullWish` needs the rest of the list to
// have something to give when that rate-up roll is lost.
const FOUR_STAR_CHARS = ['volt', 'terra', 'nyx', 'pyra', 'naida', 'sylvi', 'zephira', 'gorran', 'elira'];
const FOUR_STAR_WEAPONS = ['windriderEdge', 'emberCleaver', 'frostfeather', 'stormPike', 'tidalGrimoire'];
const THREE_STAR_WEAPONS = ['travelersBlade', 'ironGreatsword', 'huntersBow', 'ironSpear', 'apprenticeTome'];

export const WISH_POOL = {
  standard: {
    id: 'standard', name: '奔行世界', cost: { wishTicket: 1 },
    fiveStar: { rate: 0.006, pity: 90, chars: ['aurel', 'kaelen'], weapons: ['dawnbreaker', 'forgeheartMaul', 'polarSight', 'skyPiercer', 'abyssalCodex'] },
    fourStar: { rate: 0.051, pity: 10, chars: FOUR_STAR_CHARS, weapons: FOUR_STAR_WEAPONS },
    threeStar: { weapons: THREE_STAR_WEAPONS },
  },
  featured: {
    id: 'featured', name: '炽焰重燃', cost: { wishTicket: 1 },
    featuredFive: 'ignar', featuredFour: ['pyra', 'nyx', 'volt'],
    fiveStar: { rate: 0.006, pity: 90, featuredChance: 0.55, chars: ['ignar', 'aurel', 'kaelen'], weapons: [] },
    fourStar: { rate: 0.051, pity: 10, featuredChance: 0.75, chars: FOUR_STAR_CHARS, weapons: FOUR_STAR_WEAPONS },
    threeStar: { weapons: THREE_STAR_WEAPONS },
  },
};

export const ALL_ITEM_IDS = [
  ...Object.keys(WEAPONS), ...Object.keys(MATERIALS), ...Object.keys(ARTIFACT_SETS),
];

export function itemDef(id) {
  return MATERIALS[id] || WEAPONS[id] || null;
}

export function itemName(id) {
  const d = itemDef(id);
  return d ? d.name : id;
}

/** A glyph for anything with an id. Weapons carry no `icon`, so they get the sword. */
export function itemIcon(id) {
  return itemDef(id)?.icon || (WEAPONS[id] ? '⚔' : '·');
}

/**
 * The name of an *instance* of equipment — a rolled artifact or a weapon.
 *
 * Equipment has no item id (each piece is a document with its own rolls), so it cannot go
 * through `itemName`. The inventory panel had the only spelling of this rule; a chest that
 * pays a 5-star artifact has to name it too, and two spellings of 「角斗士的终幕礼·生之花」
 * is how one of them ends up printing a raw `setId`.
 */
export function equipName(e) {
  if (!e) return '';
  if (e.weaponId) return WEAPONS[e.weaponId]?.name || e.weaponId;
  const set = ARTIFACT_SETS[e.setId]?.name || e.setId || '圣遗物';
  return `${set}·${SLOT_NAMES[e.slot] || e.slot || ''}`;
}

/** ⚔ for a weapon, the slot's glyph for an artifact. */
export function equipIcon(e) {
  if (e?.weaponId) return '⚔';
  return { flower: '🌸', plume: '🪶', sands: '⏳', goblet: '🏺', circlet: '👑' }[e?.slot] || '◈';
}

/**
 * A reward block (`{ mora, xp, primogem, items: [[id, n], …] }`) as display rows.
 *
 * Quest rewards, chest rewards and chamber rewards all use that shape, and every surface that
 * shows one was formatting it by hand: the quest card built a 、-joined sentence with its own
 * `MATERIALS[id]?.name || WEAPONS[id]?.name || id` fallback, which is how an unnamed id reaches
 * a player. One list, in a fixed order (currency, then adventure xp, then items), so the
 * completion screen and the quest panel cannot disagree about what a quest pays.
 *
 * `xp` is adventure rank xp — it has no item id, so it is spelled out here.
 */
export function rewardList(rewards = {}) {
  const rows = [];
  if (rewards.mora) rows.push({ id: 'mora', icon: itemIcon('mora'), name: itemName('mora'), n: rewards.mora });
  if (rewards.primogem) rows.push({ id: 'primogem', icon: itemIcon('primogem'), name: itemName('primogem'), n: rewards.primogem });
  if (rewards.xp) rows.push({ id: 'xp', icon: '✦', name: '冒险经验', n: rewards.xp });
  for (const [id, n] of rewards.items || []) {
    rows.push({ id, icon: itemIcon(id), name: itemName(id), n });
  }
  return rows;
}
