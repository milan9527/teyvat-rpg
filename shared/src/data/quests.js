// Quest chain: story quests with staged objectives, plus repeatable dailies.

import { periodKey } from '../sim/clock.js';
import { rankForLevel } from '../sim/formulas.js';
import { itemDef, rewardList } from './items.js';

export const QUEST_TYPE = { story: 'story', side: 'side', daily: 'daily', world: 'world' };

export const QUESTS = {
  q_intro: {
    id: 'q_intro', type: 'story', chapter: '序章', name: '风起之时',
    zone: 'mondstadt', minLevel: 1, next: 'q_slimes',
    giver: 'scholar',
    intro: '莉莎：旅行者，你终于醒了。风把你带到了这片土地——不如先去熟悉一下周围？',
    stages: [
      { id: 's1', desc: '与学者莉莎交谈', kind: 'talk', target: 'scholar', count: 1 },
      { id: 's2', desc: '前往七天神像', kind: 'reach', target: 'mond_statue', radius: 8 },
      { id: 's3', desc: '击败 3 只史莱姆', kind: 'kill', target: 'slimeWater|slimeFire|slimeElectro', count: 3 },
    ],
    rewards: { mora: 3000, xp: 500, primogem: 60, items: [['adventurerXp', 3], ['wishTicket', 1]] },
    outro: '莉莎：不错的开始。这片大陆还有很多地方等着你。',
  },
  q_slimes: {
    id: 'q_slimes', type: 'story', chapter: '第一章', name: '丘丘人的威胁',
    zone: 'mondstadt', minLevel: 3, next: 'q_ruins', giver: 'katheryne',
    intro: '凯瑟琳：冒险家协会收到报告，附近的丘丘人营地活动频繁。',
    stages: [
      { id: 's1', desc: '击败 6 只丘丘人', kind: 'kill', target: 'hilichurl|hilichurlArcher|hilichurlPyro', count: 6 },
      { id: 's2', desc: '收集 4 个破损的面具', kind: 'collect', target: 'damagedMask', count: 4 },
      { id: 's3', desc: '开启 1 个精致的宝箱', kind: 'chest', target: 'exquisite', count: 1 },
    ],
    rewards: { mora: 6000, xp: 1200, primogem: 60, items: [['adventurerXp', 5], ['travelersBlade', 1]] },
    outro: '凯瑟琳：营地清空了，商路又能通行。协会会把这份功劳记在你名下。',
  },
  q_ruins: {
    id: 'q_ruins', type: 'story', chapter: '第一章', name: '遗迹中的低鸣',
    zone: 'mondstadt', minLevel: 10, next: 'q_wind_trial', giver: 'smith',
    intro: '瓦格纳：南边遗迹里有台老机器又开始动了。它的核心对我很有用。',
    stages: [
      { id: 's1', desc: '击败遗迹守卫', kind: 'kill', target: 'ruinGuard', count: 1 },
      { id: 's2', desc: '收集 2 个混沌装置', kind: 'collect', target: 'chaosDevice', count: 2 },
    ],
    rewards: { mora: 12000, xp: 2400, primogem: 60, items: [['heroWit', 2], ['windriderEdge', 1]] },
    outro: '瓦格纳：核心还热着呢。下次来铺子，我给你打把更趁手的家伙。',
  },
  q_wind_trial: {
    id: 'q_wind_trial', type: 'story', chapter: '第一章', name: '风之试炼',
    zone: 'mondstadt', minLevel: 14, next: 'q_abyss_gate', giver: 'scholar',
    intro: '莉莎：想要打开那座封印，你需要以风元素唤醒三座石碑。',
    stages: [
      { id: 's1', desc: '完成风之试炼谜题', kind: 'puzzle', target: 'mond_puzzle1', count: 1 },
      { id: 's2', desc: '开启华丽的宝箱', kind: 'chest', target: 'luxurious', count: 1 },
    ],
    rewards: { mora: 15000, xp: 3000, primogem: 90, items: [['wishTicket', 2]] },
    outro: '莉莎：三座石碑都醒了。封印之后的东西，可就没人替你挡着了。',
  },
  q_abyss_gate: {
    id: 'q_abyss_gate', type: 'story', chapter: '第二章', name: '深渊的邀请',
    zone: 'abyssTrial', minLevel: 18, next: 'q_dragonspine', giver: 'katheryne',
    intro: '凯瑟琳：东边出现了通往深境的裂隙。里面的东西……并不友好。',
    stages: [
      { id: 's1', desc: '进入深渊试炼场', kind: 'enterZone', target: 'abyssTrial', count: 1 },
      { id: 's2', desc: '通过深境第 1-3 层', kind: 'chamber', target: 'abyssTrial:3', count: 1 },
    ],
    rewards: { mora: 20000, xp: 4200, primogem: 120, items: [['heroWit', 4], ['wishTicket', 2]] },
    outro: '凯瑟琳：裂隙暂时稳定了。但它不是自己出现的——有人在另一头推门。',
  },
  q_dragonspine: {
    id: 'q_dragonspine', type: 'story', chapter: '第二章', name: '沉眠的雪山',
    zone: 'dragonspine', minLevel: 22, next: 'q_frost_seal', giver: 'explorer',
    intro: '伊利亚斯：这座山会吞掉不做准备的人。先找到几处火堆吧。',
    stages: [
      { id: 's1', desc: '抵达龙脊雪山', kind: 'enterZone', target: 'dragonspine', count: 1 },
      { id: 's2', desc: '点亮 3 处篝火', kind: 'warmth', target: 'any', count: 3 },
      { id: 's3', desc: '击败 5 只霜狼', kind: 'kill', target: 'frostWolf', count: 5 },
    ],
    rewards: { mora: 24000, xp: 5400, primogem: 60, items: [['heroWit', 4], ['frostfeather', 1]] },
    outro: '伊利亚斯：山还在睡。至少现在，你知道该在哪儿取暖了。',
  },
  q_frost_seal: {
    id: 'q_frost_seal', type: 'story', chapter: '第二章', name: '封印的碎片',
    zone: 'dragonspine', minLevel: 28, next: 'q_liyue', giver: 'explorer',
    intro: '伊利亚斯：四块碎片散落在雪中。集齐它们，洞窟才会开启。',
    stages: [
      { id: 's1', desc: '完成封印谜题', kind: 'puzzle', target: 'ds_puzzle1', count: 1 },
      { id: 's2', desc: '在冰封洞窟中击败深渊法师 2 只', kind: 'kill', target: 'abyssMage', count: 2 },
      { id: 's3', desc: '通过冰封洞窟', kind: 'chamber', target: 'frostCavern:3', count: 1 },
    ],
    rewards: { mora: 32000, xp: 7200, primogem: 120, items: [['heroWit', 6], ['wishTicket', 3]] },
    outro: '伊利亚斯：碎片合上的那一刻，洞窟里的风停了。那不是好兆头。',
  },
  q_liyue: {
    id: 'q_liyue', type: 'story', chapter: '第三章', name: '磐岩之国',
    zone: 'liyue', minLevel: 35, next: 'q_herald', giver: 'adeptus',
    intro: '仙人使者：群峰之下，地脉正在躁动。请随我查明缘由。',
    stages: [
      { id: 's1', desc: '抵达璃月群峰', kind: 'enterZone', target: 'liyue', count: 1 },
      { id: 's2', desc: '点亮 5 座古老石灯', kind: 'puzzle', target: 'ly_puzzle2', count: 1 },
      { id: 's3', desc: '击败 3 只岩龙蜥', kind: 'kill', target: 'geoVishap', count: 3 },
    ],
    rewards: { mora: 40000, xp: 9600, primogem: 120, items: [['heroWit', 8], ['skyPiercer', 1]] },
    outro: '仙人使者：石灯重新亮起，地脉稍稍平息。躁动的源头还在更深处。',
  },
  q_herald: {
    id: 'q_herald', type: 'story', chapter: '第三章', name: '深渊使徒',
    zone: 'liyue', minLevel: 45, next: 'q_tyrant', giver: 'adeptus',
    intro: '仙人使者：源头是一位深渊使徒。它的护盾需要用元素反应击碎。',
    stages: [
      { id: 's1', desc: '击败深渊使徒', kind: 'kill', target: 'abyssHerald', count: 1 },
      { id: 's2', desc: '收集使徒的纹徽', kind: 'collect', target: 'heraldsInsignia', count: 1 },
    ],
    rewards: { mora: 60000, xp: 14000, primogem: 200, items: [['heroWit', 10], ['dawnbreaker', 1], ['wishTicket', 5]] },
    outro: '仙人使者：使徒的纹徽是它效忠之物的凭证。此物，应当由你保管。',
  },
  q_tyrant: {
    id: 'q_tyrant', type: 'story', chapter: '终章', name: '暴风之主',
    zone: 'goldenHall', minLevel: 55, next: null, giver: 'adeptus',
    intro: '仙人使者：黄金屋的最深处，暴风之主已经醒来。这将是真正的考验。',
    stages: [
      { id: 's1', desc: '进入黄金屋遗迹', kind: 'enterZone', target: 'goldenHall', count: 1 },
      { id: 's2', desc: '击败暴风之主', kind: 'kill', target: 'stormTyrant', count: 1 },
    ],
    rewards: { mora: 120000, xp: 30000, primogem: 400, items: [['crownFragment', 2], ['wishTicket', 10], ['abyssalCodex', 1]] },
    outro: '风终于平息了。但提瓦特的秘密，还远远没有说完……',
  },

  // Repeatables
  d_hunt: {
    id: 'd_hunt', type: 'daily', name: '每日委托·讨伐', repeatable: true, minLevel: 1,
    stages: [{ id: 's1', desc: '击败 12 名敌人', kind: 'kill', target: 'any', count: 12 }],
    rewards: { mora: 5000, xp: 800, primogem: 20, items: [['adventurerXp', 2]] },
  },
  d_gather: {
    id: 'd_gather', type: 'daily', name: '每日委托·采集', repeatable: true, minLevel: 1,
    stages: [{ id: 's1', desc: '采集 10 份材料', kind: 'gather', target: 'any', count: 10 }],
    rewards: { mora: 4000, xp: 600, primogem: 20, items: [['sweetMadame', 3]] },
  },
  d_chests: {
    id: 'd_chests', type: 'daily', name: '每日委托·探索', repeatable: true, minLevel: 1,
    stages: [{ id: 's1', desc: '开启 3 个宝箱', kind: 'chest', target: 'any', count: 3 }],
    rewards: { mora: 4500, xp: 700, primogem: 20, items: [['condensedResin', 1]] },
  },
  d_cook: {
    id: 'd_cook', type: 'daily', name: '每日委托·烹饪', repeatable: true, minLevel: 1,
    // Counted in portions, so one batch of four at a campfire clears it. The point
    // is to send the player to a fire with the plants they picked, not to make them
    // press the button four times.
    stages: [{ id: 's1', desc: '烹饪 4 份料理', kind: 'cook', target: 'any', count: 4 }],
    rewards: { mora: 4000, xp: 600, primogem: 20, items: [['mint', 4], ['wheat', 4]] },
  },
};

/* ------------------------------------------------------- 传说任务 / 世界任务 -- */

/**
 * Everything outside the story chain and the four commissions.
 *
 * `QUEST_TYPE` has declared `side` and `world` since the first commit, `panels.js` has a chip
 * and a colour for each (传说任务 / 世界任务), and neither had a single instance — declared
 * vocabulary, styled, labelled, and empty. The story chain is ten quests in a straight line, so
 * every zone had exactly one thing to do in it and an NPC who was not the chain's current giver
 * had nothing to say.
 *
 * Two rules make this content rather than filler, and both are gated below:
 *
 *   * **Every one of them hangs off a story quest** (`requires`). That is what makes them
 *     orderable without a second chain to keep in sync: the story is the spine, and a 传说任务
 *     unlocks when the chapter that introduces its NPC is finished.
 *   * **The giver stands in the quest's own zone** (gated in `zoneGate.js`), so the offer is
 *     where the work is. `offerableQuest()` is the single predicate that decides whether an NPC
 *     is holding one out — asked by `POST /api/world/talk` when it hands the quest over *and* by
 *     the client's interaction prompt when it says 「有新任务」. One door, two callers, which is
 *     the only reason the prompt cannot promise a quest the route then refuses.
 *
 * They also put three authored-but-unused pieces of world data to work: 璃月's 岩之试炼 puzzle
 * (`ly_puzzle1`, which no story quest ever pointed at), 龙脊's starsilver veins, and the
 * 兜帽人 in 深渊试炼场, who existed only to sell things.
 */
const EXTRAS = [
  {
    id: 'sq_flower_wine', type: 'side', chapter: '传说·蒲公英', name: '花语的委托',
    zone: 'mondstadt', giver: 'grocer', requires: 'q_intro', minLevel: 5,
    intro: '花语：客人，帮我个忙好吗？酒庄要的甜甜花我一个人采不完，顺手做两份料理带回来就行。',
    stages: [
      { id: 's1', desc: '采集 6 朵甜甜花', kind: 'gather', target: 'sweetFlower', count: 6 },
      { id: 's2', desc: '在篝火边做 2 份甜甜花酿鸡', kind: 'cook', target: 'sweetMadame', count: 2 },
      { id: 's3', desc: '把料理交给花语', kind: 'talk', target: 'grocer', count: 1 },
    ],
    items: [['sweetMadame', 5], ['adventurerXp', 3]],
    outro: '花语：香味都飘到广场上了。这些你带着路上吃——冒险家总是忘记吃饭。',
  },
  {
    id: 'wq_wolf_howl', type: 'world', chapter: '世界·奔狼领', name: '奔狼领的哨声',
    zone: 'mondstadt', giver: 'katheryne', requires: 'q_slimes', minLevel: 12,
    intro: '凯瑟琳：奔狼领方向有人听见了丘丘弓手的哨声。请去看看，顺便把他们藏起来的东西找出来。',
    stages: [
      { id: 's1', desc: '前往奔狼领', kind: 'reach', target: 'mond_wp3', radius: 10 },
      { id: 's2', desc: '击败 5 名丘丘弓手', kind: 'kill', target: 'hilichurlArcher', count: 5 },
      { id: 's3', desc: '开启 1 个珍贵的宝箱', kind: 'chest', target: 'precious', count: 1 },
    ],
    items: [['heroWit', 2], ['wishTicket', 1]],
    outro: '凯瑟琳：哨声停了。协会会把奔狼领重新标成可通行——在下一次它们回来之前。',
  },
  {
    id: 'sq_smith_ore', type: 'side', chapter: '传说·风锤', name: '铁匠的私活',
    zone: 'mondstadt', giver: 'smith', requires: 'q_ruins', minLevel: 16,
    intro: '瓦格纳：别告诉协会。我想试试用遗迹机器的核心淬一把刀，材料你出，刀归你。',
    stages: [
      { id: 's1', desc: '采集 8 块铁矿石', kind: 'gather', target: 'ironChunk', count: 8 },
      { id: 's2', desc: '取得 1 个混沌核心', kind: 'collect', target: 'chaosCore', count: 1 },
      { id: 's3', desc: '回到瓦格纳的铺子', kind: 'talk', target: 'smith', count: 1 },
    ],
    items: [['whiteIronChunk', 4], ['emberCleaver', 1]],
    outro: '瓦格纳：淬得住。刀口上那道蓝纹是核心留下的，磨不掉——就当是签名吧。',
  },
  {
    id: 'wq_abyss_hood', type: 'world', chapter: '世界·裂隙', name: '兜帽人的生意',
    zone: 'abyssTrial', giver: 'ab_trader', requires: 'q_abyss_gate', minLevel: 20,
    intro: '兜帽人：往里走的人多，回来的人少。你要是能走到第五间，我出价买你带回来的结晶。',
    stages: [
      { id: 's1', desc: '通过深境第 5 层', kind: 'chamber', target: 'abyssTrial:5', count: 1 },
      { id: 's2', desc: '取得 3 块深渊结晶', kind: 'collect', target: 'abyssalCrystal', count: 3 },
      { id: 's3', desc: '开启试炼场深处的宝箱', kind: 'chest', target: 'luxurious', count: 1 },
    ],
    items: [['heroWit', 4], ['condensedResin', 2]],
    outro: '兜帽人：成交。别问我拿它做什么——你也不会想知道。',
  },
  {
    id: 'sq_starsilver', type: 'side', chapter: '传说·雪线', name: '星银的重量',
    zone: 'dragonspine', giver: 'explorer', requires: 'q_frost_seal', minLevel: 30,
    intro: '伊利亚斯：矿洞里的星银够打一副新的爬钉。你去凿，我教你怎么在雪线上活着。',
    stages: [
      { id: 's1', desc: '采集 6 块星银矿石', kind: 'gather', target: 'starsilver', count: 6 },
      { id: 's2', desc: '沿路点亮 2 处取暖点', kind: 'warmth', target: 'any', count: 2 },
      { id: 's3', desc: '取得 5 枚霜狼的爪', kind: 'collect', target: 'wolfClaw', count: 5 },
    ],
    items: [['starsilver', 4], ['polarSight', 1]],
    outro: '伊利亚斯：拿着这把弓。星银在冷的地方更硬——这座山唯一对人好的地方。',
  },
  {
    id: 'wq_liyue_lantern', type: 'world', chapter: '世界·归离原', name: '石头的账本',
    zone: 'liyue', giver: 'merchant', requires: 'q_liyue', minLevel: 40,
    intro: '石头：地脉一乱，我这条商路就断了。你替我把岩之试炼重新点上，账我记着。',
    stages: [
      { id: 's1', desc: '完成岩之试炼', kind: 'puzzle', target: 'ly_puzzle1', count: 1 },
      { id: 's2', desc: '清理商路上的 6 只怪物', kind: 'kill', target: 'geoVishap|abyssMage', count: 6 },
      { id: 's3', desc: '采集 8 朵清心', kind: 'gather', target: 'qingxin', count: 8 },
    ],
    items: [['heroWit', 6], ['crystalChunk', 6]],
    outro: '石头：路通了。账我不记了——你要的东西，以后在我这儿都打八折。',
  },

  /* -- 第二波：把两座没有 NPC 的秘境也变成目的地 ----------------------------
   *
   * 前六条落在四个区域，冰封洞窟和黄金屋遗迹一条也没有 —— 而且它们**不可能**有：
   * 「委托人站在任务发生的区域里」（`zoneGate.js`）加上这两座秘境一个 NPC 都没有，等于
   * 它们永远拿不到自己的 extras。所以这四条里有两条把玩家**送进去**：任务仍然归属于秘境
   * 入口所在的那个露天区域，而 `enterZone` / `chamber` 两个 locator 本来就跨区域解析
   * （`gateTo` 找到那扇门），于是「从龙脊雪山的冰封洞窟进入」这句提示是推导出来的。
   *
   * 还有一条规则是写这四条时才发现的，现在钉在 `zoneGate.js` 里：**一条把玩家送进秘境的
   * 委托，它的 `minLevel` 必须高到 `rankForLevel(minLevel)` 够开那扇门。** 交付条件是
   * `rank >= rankForLevel(minLevel)`（`offerableQuest`），开门条件是 `rank >= entryRank`
   * （`canEnterZone`），两者之间没有任何联系 —— `sq_golden_ledger` 第一版写 lv 50（阶 15），
   * 而黄金屋要阶 18：任务会在门还锁着的时候交到手上，卡死在第一阶段。lv 55 才是它能存在的
   * 最低等级，这个数不是审美，是从两条已有规则里解出来的。
   */
  {
    id: 'wq_snow_supply', type: 'world', chapter: '世界·雪线', name: '雪线上的补给',
    zone: 'dragonspine', giver: 'explorer', requires: 'q_dragonspine', minLevel: 26,
    intro: '伊利亚斯：星银矿洞那边的三个人断粮两天了。药我配好了，路你比我熟——顺手把挡路的东西清掉。',
    stages: [
      { id: 's1', desc: '抵达星银矿洞', kind: 'reach', target: 'ds_wp2', radius: 10 },
      { id: 's2', desc: '采集 6 株薄荷', kind: 'gather', target: 'mint', count: 6 },
      { id: 's3', desc: '击败 3 名深渊法师', kind: 'kill', target: 'abyssMage', count: 3 },
    ],
    items: [['northernStew', 3], ['heroWit', 3]],
    outro: '伊利亚斯：他们能自己下山了。这座山不记恩，但下山的人会。',
  },
  {
    id: 'sq_frost_relic', type: 'side', chapter: '传说·雪葬之都', name: '洞窟里的回音',
    zone: 'dragonspine', giver: 'explorer', requires: 'q_frost_seal', minLevel: 32,
    intro: '伊利亚斯：封印碎了之后，洞窟深处一直有回音。我这把老骨头进不到第三间——你替我听听那是什么。',
    stages: [
      { id: 's1', desc: '进入冰封洞窟', kind: 'enterZone', target: 'frostCavern', count: 1 },
      { id: 's2', desc: '清空冰封洞窟第 3 间', kind: 'chamber', target: 'frostCavern:3', count: 1 },
      { id: 's3', desc: '开启 1 个华丽的宝箱', kind: 'chest', target: 'luxurious', count: 1 },
    ],
    items: [['shivadaShard', 4], ['condensedResin', 2]],
    outro: '伊利亚斯：回音是风穿过冰缝。……但你带回来的这块东西，不是风留下的。',
  },
  {
    id: 'wq_liyue_leyline', type: 'world', chapter: '世界·地脉', name: '古老的石灯',
    zone: 'liyue', giver: 'adeptus', requires: 'q_liyue', minLevel: 38,
    intro: '仙人使者：归离原的石灯熄了，地脉便乱了。遗迹机关正循着乱流走——先点灯，再断它们的路。',
    stages: [
      { id: 's1', desc: '点亮古老的石灯', kind: 'puzzle', target: 'ly_puzzle2', count: 1 },
      { id: 's2', desc: '击败 3 台遗迹守卫', kind: 'kill', target: 'ruinGuard', count: 3 },
      { id: 's3', desc: '采集 6 块水晶块', kind: 'gather', target: 'crystalChunk', count: 6 },
    ],
    items: [['prithivaShard', 3], ['condensedResin', 2]],
    outro: '仙人使者：灯亮了，地脉自会归位。凡人做仙家的事，也做得不差。',
  },
  {
    id: 'sq_golden_ledger', type: 'side', chapter: '传说·账本', name: '石头的最后一笔账',
    zone: 'liyue', giver: 'merchant', requires: 'q_tyrant', minLevel: 55,
    intro: '石头：黄金屋那批货压在遗迹里三年了。现在雷停了——你陪我把这笔账结掉，八折我照算。',
    stages: [
      { id: 's1', desc: '进入黄金屋遗迹', kind: 'enterZone', target: 'goldenHall', count: 1 },
      { id: 's2', desc: '通过黄金屋第 3 间', kind: 'chamber', target: 'goldenHall:3', count: 1 },
      { id: 's3', desc: '取得 3 个混沌核心', kind: 'collect', target: 'chaosCore', count: 3 },
    ],
    items: [['crystalCore', 4], ['heroWit', 8]],
    outro: '石头：账结了。这一笔我不记在账本上——记在别的地方。',
  },
];

/**
 * What a 传说/世界任务 pays, derived from the story quest it sits next to on the level curve.
 *
 * Not authored per quest, and that is the point: quest rewards are paid into the *superlinear*
 * level and adventure-rank curves, so a flat 「支线给 10000 摩拉」 is generous at level 5 and an
 * insult at level 40 — the same mistake every earlier balance defect in this repo made. Half of
 * the nearest story quest is one number to reason about, it moves automatically if the chain is
 * ever rebalanced, and `tools/balance-check.mjs` measures the result against the curve rather
 * than against this comment.
 */
function nearestStory(minLevel) {
  return STORY_CHAIN.map((id) => QUESTS[id])
    .reduce((a, b) => (Math.abs((b.minLevel || 1) - minLevel) < Math.abs((a.minLevel || 1) - minLevel) ? b : a));
}
function extraRewards(minLevel, items) {
  const r = nearestStory(minLevel).rewards;
  return {
    mora: Math.round(r.mora / 2 / 500) * 500,
    xp: Math.round(r.xp / 2 / 100) * 100,
    primogem: Math.max(20, Math.round(r.primogem / 2 / 10) * 10),
    items,
  };
}

export const STORY_CHAIN = ['q_intro', 'q_slimes', 'q_ruins', 'q_wind_trial', 'q_abyss_gate',
  'q_dragonspine', 'q_frost_seal', 'q_liyue', 'q_herald', 'q_tyrant'];
export const DAILY_IDS = ['d_hunt', 'd_gather', 'd_chests', 'd_cook'];

for (const e of EXTRAS) {
  const { items, ...def } = e;
  QUESTS[def.id] = { ...def, rewards: extraRewards(def.minLevel, items) };
}

/** 传说任务 — the NPC-side stories that hang off the chain. */
export const SIDE_IDS = EXTRAS.filter((e) => e.type === 'side').map((e) => e.id);
/** 世界任务 — regional errands, same offer path, different chip. */
export const WORLD_IDS = EXTRAS.filter((e) => e.type === 'world').map((e) => e.id);
export const EXTRA_IDS = EXTRAS.map((e) => e.id);

export const QUEST_IDS = Object.keys(QUESTS);

/**
 * Which **trusted** server path produces each event kind a stage can wait on.
 *
 * This table exists because of a hole it closed. There used to be a `POST /api/quest/event`
 * that took `{kind, target, count}` out of the request body, so that a 单机 client — whose
 * simulation runs in the browser — could report what happened. Every kind below, though,
 * already has a route that *validates the action* before emitting the event: the chest has to
 * be an unopened POI in the zone the player is standing in, the enemy has to exist in that
 * zone and pass a rate limit, the recipe has to be affordable. The body-driven route was a
 * second, unguarded door into the same rewards — and quests pay 20–120 primogems each — so it
 * is gone, and this map is what keeps it gone: `questGateReport()` fails if a stage waits on a
 * kind no server path produces, which is the only way a stage could become unreachable without
 * that route, and it equally fails on a declared producer no stage reads.
 *
 * The values are documentation, not dispatch — they name the code that emits the event.
 */
export const QUEST_EVENT_SOURCES = {
  kill: 'POST /api/world/kill · ws attack → progression.grantKillRewards',
  chest: 'POST /api/world/chest',
  puzzle: 'POST /api/world/puzzle',
  reach: 'POST /api/world/unlock (waypoint / statue)',
  warmth: 'POST /api/world/unlock (warmth POI)',
  gather: 'POST /api/world/gather',
  enterZone: 'POST /api/world/teleport · ws joinZone',
  talk: 'POST /api/world/talk',
  cook: 'POST /api/player/cook',
  chamber: 'POST /api/world/chamber · ws chamber clear',
  collect: 'progression.addItems → any route that grants an item',
};

/**
 * Does finishing this quest deserve the completion screen?
 *
 * One predicate, read by two sides that would otherwise drift: the client shows the 完成 card
 * for exactly these quests, and `questGateReport()` demands an `intro` and an `outro` for
 * exactly these quests (and refuses an `outro` on the others, which nothing would ever print).
 * A 每日委托 gets a banner and a toast instead — four blocking cards a day for a 20-primogem
 * chore is not a story beat, and writing an ending line for one would be writing dead data.
 */
export function questHasEnding(def) {
  return !!def && def.type !== 'daily' && !def.repeatable;
}

/**
 * Is this quest's prerequisite behind the player? A quest with no `requires` is open from the
 * start, which is what every story-chain head and every commission is.
 */
export function questUnlocked(def, quests = {}) {
  if (!def?.requires) return true;
  return quests[def.requires]?.state === 'done';
}

/**
 * Which quest this NPC would hand over *right now* — the story hook they carry in the zone data
 * first, then their 传说/世界任务 in authored order. `null` when they have nothing to offer.
 *
 * The one door. `POST /api/world/talk` calls it to decide what to start, and the client's
 * interaction prompt calls it to decide whether the NPC's subtitle reads 「有新任务」 — a prompt
 * with its own copy of the rule is a prompt that promises quests the route refuses (and stays
 * quiet about ones it would give). The rank test is `rankForLevel(minLevel)` and nothing else:
 * `arCap` is what decides whether that character level is reachable at all, so asking for more
 * would gate content on a rank the player cannot need (see `formulas.arCap`).
 *
 * @param npc     a zone NPC entry (`{ id, quest? }`)
 * @param player  `{ quests, adventureRank }` — the player document, or the client's copy of it
 */
export function offerableQuest(npc, player = {}) {
  if (!npc?.id) return null;
  const quests = player.quests || {};
  const rank = player.adventureRank || 1;
  const ids = [];
  if (npc.quest) ids.push(npc.quest);
  for (const id of EXTRA_IDS) if (QUESTS[id].giver === npc.id) ids.push(id);
  for (const id of ids) {
    const def = QUESTS[id];
    if (!def || quests[id]) continue;                 // unknown, already active, or finished
    if (!questUnlocked(def, quests)) continue;
    if (rank < rankForLevel(def.minLevel || 1)) continue;
    return def;
  }
  return null;
}

/** Does an event advance this stage? */
export function stageMatches(stage, event) {
  if (stage.kind !== event.kind) return false;
  if (stage.target === 'any') return true;
  if (stage.kind === 'reach') return stage.target === event.target;
  const targets = String(stage.target).split('|');
  return targets.includes(String(event.target));
}

/**
 * Which dailies belong to a period that has ended, given the quest document.
 *
 * The dailies used to be re-armed by `POST /api/quest/dailies/reset`, which is to say: not at
 * all, unless a client asked — and then as often as it liked. Both halves were wrong. A daily
 * that only refreshes when someone POSTs never refreshes for a player who is offline at 04:00,
 * and a daily that refreshes on demand is a printing press, because a finished daily row **is
 * the receipt for today's 20 primogems** and re-arming it hands the reward out again.
 *
 * So the reset follows the same rule as shop limits and periodic mail (`sim/clock.js`): nothing
 * stores a deadline and nothing runs on a timer. The row carries the moment it was last
 * written, that moment maps to a period key, and a row whose key is not the current key *is*
 * yesterday's row. Rolling it over is then idempotent, retroactive, and free of a second source
 * of truth about the clock — the same reason there is no cron for the daily login mail.
 *
 * A row with no timestamp at all (written by a build older than this function) counts as stale,
 * so it rolls once and stamps itself. `at` is epoch ms.
 */
export function dailiesToRoll(quests = {}, now = Date.now()) {
  const today = periodKey('daily', now);
  return DAILY_IDS.filter((id) => {
    const st = quests[id];
    if (!st) return true;                       // never had the row: hand them today's
    if (!st.at) return true;
    return periodKey('daily', st.at) !== today;
  });
}

/**
 * The catalogue's own consumer gate, both directions — the same shape as `achGateReport()`.
 *
 * Quest data fails silently in both directions: a stage that waits on a kind nothing emits
 * simply never completes (and blocks every later stage in its chain), and a producer nothing
 * waits on is dead code that looks load-bearing. Neither shows up at runtime, so the tools ask.
 */
export function questGateReport() {
  const problems = [];
  const used = new Set();

  for (const [id, def] of Object.entries(QUESTS)) {
    if (def.id !== id) problems.push(`${id} carries a mismatched id "${def.id}"`);
    if (!QUEST_TYPE[def.type]) problems.push(`${id} has unknown type "${def.type}"`);
    if (!def.name) problems.push(`${id} has no name`);
    if (!def.stages?.length) problems.push(`${id} has no stages`);
    if (def.next && !QUESTS[def.next]) problems.push(`${id} chains to missing quest "${def.next}"`);
    if (!def.rewards) problems.push(`${id} pays nothing`);
    // Every reward has to be nameable, because the completion screen and the quest card print
    // the name: a typo'd id used to reach the player as `windriderEdge ×1`.
    for (const row of rewardList(def.rewards || {})) {
      if (row.id !== 'xp' && !itemDef(row.id)) problems.push(`${id} pays "${row.id}", which is in neither MATERIALS nor WEAPONS`);
      if (!(row.n > 0)) problems.push(`${id} pays a non-positive amount of ${row.id}`);
    }
    // The ending, both ways (`questHasEnding`): a story quest with no `outro` finishes with an
    // empty card, and an `outro` on a quest that never shows one is data nothing reads.
    if (questHasEnding(def)) {
      if (!def.intro) problems.push(`${id} has no intro, so the card that offers it says nothing`);
      if (!def.outro) problems.push(`${id} has no outro, so finishing it ends the chapter on a blank line`);
    } else if (def.outro) {
      problems.push(`${id} carries an outro but never shows a completion screen, so nothing prints it`);
    }
    const seen = new Set();
    for (const s of def.stages || []) {
      if (!s.id) problems.push(`${id} has a stage with no id`);
      if (seen.has(s.id)) problems.push(`${id} repeats stage id "${s.id}"`);
      seen.add(s.id);
      if (!s.desc) problems.push(`${id}.${s.id} has no description`);
      used.add(s.kind);
      if (!QUEST_EVENT_SOURCES[s.kind]) {
        problems.push(`${id}.${s.id} waits on kind "${s.kind}", which no server path produces`);
      }
      if (s.count !== undefined && !(s.count > 0)) {
        problems.push(`${id}.${s.id} needs a non-positive count`);
      }
      // 'any' means every event of the kind; anything else is matched by exact string, so a
      // typo in a target id is a stage that can never advance.
      if (s.target === undefined) problems.push(`${id}.${s.id} has no target ('any' is explicit)`);
    }
  }

  for (const kind of Object.keys(QUEST_EVENT_SOURCES)) {
    if (!used.has(kind)) problems.push(`event kind "${kind}" is produced but no stage waits on it`);
  }
  for (const id of DAILY_IDS) {
    const def = QUESTS[id];
    if (!def) { problems.push(`DAILY_IDS names missing quest "${id}"`); continue; }
    if (def.type !== 'daily') problems.push(`${id} is in DAILY_IDS but typed "${def.type}"`);
    if (!def.repeatable) problems.push(`${id} is a daily but not marked repeatable`);
  }
  for (const [id, def] of Object.entries(QUESTS)) {
    if (def.type === 'daily' && !DAILY_IDS.includes(id)) {
      problems.push(`${id} is typed daily but is not in DAILY_IDS, so it never rolls over`);
    }
  }
  // `STORY_CHAIN` and the `next` links are two spellings of one order, and the second one is
  // the one the server follows when it hands out the next quest. So the list is checked against
  // the links rather than merely for existence: walking `next` from the first entry has to
  // reproduce it exactly, and the last quest has to be the one that ends the story.
  const walk = [];
  for (let id = STORY_CHAIN[0]; id && QUESTS[id] && walk.length <= QUEST_IDS.length; id = QUESTS[id].next) walk.push(id);
  if (walk.join(',') !== STORY_CHAIN.join(',')) {
    problems.push(`STORY_CHAIN disagrees with the next links: chain=[${STORY_CHAIN}] links=[${walk}]`);
  }
  for (const id of STORY_CHAIN) {
    if (!QUESTS[id]) problems.push(`STORY_CHAIN names missing quest "${id}"`);
    else if (QUESTS[id].type !== 'story') problems.push(`STORY_CHAIN names "${id}", typed "${QUESTS[id].type}"`);
  }
  for (const [id, def] of Object.entries(QUESTS)) {
    if (def.type === 'story' && !STORY_CHAIN.includes(id)) {
      problems.push(`${id} is a story quest outside STORY_CHAIN, so nothing leads to it`);
    }
  }

  // A type with no instances is a chip `panels.js` styles, labels and never draws. `side` and
  // `world` were exactly that until 传说/世界任务 existed, and the gate above (`unknown type`)
  // could not see it: it only ever asked the question in the direction that had instances.
  for (const t of Object.values(QUEST_TYPE)) {
    if (!Object.values(QUESTS).some((d) => d.type === t)) {
      problems.push(`quest type "${t}" is declared and labelled but no quest has it`);
    }
  }
  // The extras, both directions — same shape as the DAILY_IDS pair above.
  for (const id of EXTRA_IDS) {
    const def = QUESTS[id];
    if (!def) { problems.push(`EXTRA_IDS names missing quest "${id}"`); continue; }
    if (def.type !== 'side' && def.type !== 'world') {
      problems.push(`${id} is offered as an extra but typed "${def.type}"`);
    }
    if (STORY_CHAIN.includes(id)) problems.push(`${id} is both an extra and part of STORY_CHAIN`);
    if (def.next) problems.push(`${id} chains to "${def.next}": extras stand alone, so nothing would ever print that follow-up`);
    // Offer path. No giver means no NPC can hand it over, an unknown giver means the same, and
    // a `requires` outside the story chain would be a second ordering to keep in sync.
    if (!def.giver) problems.push(`${id} has no giver, so no NPC can offer it`);
    if (!def.requires) problems.push(`${id} has no requires, so it would be offered in the tutorial valley`);
    else if (!QUESTS[def.requires]) problems.push(`${id} requires missing quest "${def.requires}"`);
    else if (!STORY_CHAIN.includes(def.requires)) {
      problems.push(`${id} requires "${def.requires}", which is not a story quest`);
    }
    if (!def.zone) problems.push(`${id} has no zone, so the tracker cannot say where it is`);
  }
  for (const [id, def] of Object.entries(QUESTS)) {
    if ((def.type === 'side' || def.type === 'world') && !EXTRA_IDS.includes(id)) {
      problems.push(`${id} is typed "${def.type}" but is in no offer list, so no NPC offers it`);
    }
  }
  // The rewards are derived from the story chain (`extraRewards`), so what is worth asserting is
  // the property that derivation is *for*: pay never falls as the prerequisite gets later. An
  // authored table drifts here silently — the level curve is superlinear, so a flat 「支线给
  // 10 000 摩拉」 is generous at level 5 and an insult at 40.
  {
    const ranked = [...EXTRA_IDS].sort((a, b) => (QUESTS[a].minLevel || 1) - (QUESTS[b].minLevel || 1));
    for (let i = 1; i < ranked.length; i++) {
      const lo = QUESTS[ranked[i - 1]], hi = QUESTS[ranked[i]];
      if (hi.rewards.mora < lo.rewards.mora || hi.rewards.xp < lo.rewards.xp) {
        problems.push(`${hi.id} (lv ${hi.minLevel}) pays less than ${lo.id} (lv ${lo.minLevel}): `
          + `${hi.rewards.mora}/${hi.rewards.xp} vs ${lo.rewards.mora}/${lo.rewards.xp}`);
      }
    }
  }
  // **Every extra must actually come out of `offerableQuest`.** One NPC can hold several, and
  // the function returns one at a time, so the check is to walk it: a player who has finished
  // the whole story at a rank that clears every `minLevel` must be offered each of them in turn.
  // Without this the reachability of a quest depends on a `giver` string matching an id in
  // `zones.js`, which is a typo away from content nothing in the game can reach.
  {
    const quests = {};
    for (const id of STORY_CHAIN) quests[id] = { state: 'done', stageIndex: 0, counters: {} };
    const player = { quests, adventureRank: 90 };
    const givers = [...new Set(EXTRA_IDS.map((id) => QUESTS[id].giver))];
    for (let round = 0; round < EXTRA_IDS.length + 1; round++) {
      for (const g of givers) {
        const def = offerableQuest({ id: g }, player);
        if (def) quests[def.id] = { state: 'done', stageIndex: 0, counters: {} };
      }
    }
    for (const id of EXTRA_IDS) {
      if (!quests[id]) problems.push(`${id} is never offered by "${QUESTS[id].giver}", so nothing in the game can start it`);
    }
  }
  return problems;
}
