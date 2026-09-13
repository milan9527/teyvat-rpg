// Playable roster. Original characters designed for this game; each entry carries
// both gameplay numbers and the procedural-model parameters the renderer uses to
// build the mesh (no external asset files needed).

export const WEAPON_TYPES = {
  sword:    { id: 'sword',    name: '单手剑', reach: 2.6, speed: 1.0,  combo: 5 },
  claymore: { id: 'claymore', name: '大剑',   reach: 3.1, speed: 0.68, combo: 4 },
  polearm:  { id: 'polearm',  name: '长柄武器', reach: 3.6, speed: 1.12, combo: 5 },
  bow:      { id: 'bow',      name: '弓',     reach: 34,  speed: 0.85, combo: 2 },
  catalyst: { id: 'catalyst', name: '法器',   reach: 12,  speed: 0.9,  combo: 4 },
};

export const RARITY = { 4: { name: '四星', color: 0xa07bd0 }, 5: { name: '五星', color: 0xffb13b } };

/** Extra reach the sim grants a swing, metres: 20 Hz ticks plus interpolation drift on both bodies. */
export const MELEE_SLACK = 2.2;
/** The wedge a swing covers, radians. A sword's charged spin (`charged.spin`) covers the circle. */
export const MELEE_ARC = Math.PI * 0.85;
/** The ground a skill covers when its kit does not author a radius. */
export const SKILL_RADIUS = 4;
/** A piercing skill's half-width, as a fraction of the radius its kit authored. */
export const PIERCE_WIDTH = 0.6;

/**
 * The ground one player action covers — the same vocabulary an enemy move speaks through
 * `attackShape(mv, def)`: `{ kind, radius, hit, arc?, length? }` in metres, measured from the
 * caster with +z along the direction of the action.
 *
 * `null` means the action leaves no boundary on the ground at all: a bow's arrow and a catalyst
 * skill's orbs *are* the picture, and a ring under the caster's feet would be a promise about
 * ground nothing is going to happen on.
 *
 * `hit` is the boundary a target's *body* has to reach, so each caller adds the target's own
 * hitbox radius to it — exactly as the enemy side does with the player's.
 *
 * Two readers, one description. `handleAttack`/`handleSkill`/`handleBurst` test against this, and
 * `vfx.strike` draws it, which is the only reason a player can learn their own reach by playing.
 * Before it the numbers lived twice over: the sweep re-wrote `WEAPON_TYPES[…].reach` as a ternary
 * and swept `+ 2.2` m through 0.85π while the client drew a slash a third that wide, the auto
 * attack closed to a private `+ 0.6`, and a 9 m piercing lance was drawn as a 3 m disc.
 */
export function playerAttackShape(action, def) {
  if (!def) return null;
  if (action === 'normal' || action === 'charged') {
    const atk = action === 'charged' ? def.charged : def.normal;
    // A bow or a catalyst throws something; there is no arc.
    if (atk?.projectile || def.weapon === 'bow' || def.weapon === 'catalyst') return null;
    const radius = WEAPON_TYPES[def.weapon]?.reach ?? WEAPON_TYPES.sword.reach;
    const hit = radius + MELEE_SLACK;
    if (action === 'charged' && atk?.spin) return { kind: 'disc', radius, hit };
    return { kind: 'sector', radius, hit, arc: MELEE_ARC };
  }
  if (action === 'skill') {
    const sk = def.skill;
    if (!sk) return null;
    if (sk.pierce) {
      const r = (sk.radius || SKILL_RADIUS) * PIERCE_WIDTH;
      return { kind: 'lane', radius: r, hit: r, length: sk.pierce };
    }
    if (sk.projectile) {
      // Orbs that leave a field behind them draw the field; orbs that just fly draw nothing.
      const r = sk.lingering?.radius;
      return r ? { kind: 'disc', radius: r, hit: r } : null;
    }
    const radius = sk.radius || SKILL_RADIUS;
    return { kind: 'disc', radius, hit: radius };
  }
  if (action === 'burst') {
    const r = def.burst?.radius;
    return r ? { kind: 'disc', radius: r, hit: r } : null;
  }
  return null;
}

/**
 * body: procedural rig proportions & palette.
 *   height   — metres
 *   build    — 0 slender .. 1 broad
 *   hair     — style key consumed by gfx/characterBuilder
 */
export const CHARACTERS = {
  lyra: {
    id: 'lyra',
    name: '莉拉',
    title: '风歌游侠',
    element: 'wind',
    weapon: 'sword',
    rarity: 5,
    starter: true,
    voice: 260,
    base: { hp: 1030, atk: 26, def: 62, critRate: 0.05, critDmg: 0.5, em: 0, er: 1.0 },
    ascensionStat: { key: 'critRate', value: 0.192 },
    body: {
      height: 1.62, build: 0.28, hair: 'longWave',
      skin: 0xf3d4bd, hairColor: 0x9fe8cf, hairTip: 0xdffaf1,
      primary: 0x2f5f6e, secondary: 0xe8f6f2, accent: 0x7dffd8, eye: 0x62f0c8,
      cape: true, skirt: 0.55, boots: 0x24404a,
    },
    normal: { hits: [0.44, 0.42, 0.53, 0.28, 0.28, 0.68], frameTime: 0.28, element: 'physical' },
    charged: { mult: 1.18, stamina: 20, element: 'physical', spin: true },
    skill: {
      id: 'galeStep', name: '疾风踏',
      cd: 6.0, mult: 2.24, element: 'wind', radius: 4.2, gauge: 1,
      dash: 7.5, desc: '化身疾风向前突进，卷起风刃并将周围敌人牵引。',
      pull: 6.0, particles: 3,
    },
    burst: {
      id: 'tempestSong', name: '风暴之歌',
      cost: 60, cd: 15, mult: 1.24, ticks: 9, interval: 0.55,
      element: 'wind', radius: 6.5, gauge: 1,
      desc: '召唤持续的风暴领域，反复造成风元素伤害并扩散元素。',
      duration: 5.0,
    },
    passive: { name: '顺风而行', desc: '冲刺消耗的体力降低 20%，风元素伤害提升 12%。', staminaMul: 0.8, bonus: { wind: 0.12 } },
  },

  ignar: {
    id: 'ignar',
    name: '伊格纳',
    title: '熔炉铁匠',
    element: 'fire',
    weapon: 'claymore',
    rarity: 5,
    voice: 110,
    base: { hp: 1290, atk: 30, def: 78, critRate: 0.05, critDmg: 0.5, em: 0, er: 1.0 },
    ascensionStat: { key: 'atkPct', value: 0.24 },
    body: {
      height: 1.86, build: 0.85, hair: 'short',
      skin: 0xc98d63, hairColor: 0x3a2320, hairTip: 0xff7a3c,
      primary: 0x53201c, secondary: 0x2a1a18, accent: 0xff8a3c, eye: 0xffb15c,
      cape: false, skirt: 0.0, boots: 0x2f1a16, pauldrons: true,
    },
    normal: { hits: [0.72, 0.68, 0.86, 1.12], frameTime: 0.42, element: 'physical' },
    charged: { mult: 0.62, stamina: 24, element: 'physical', spinDrain: 32 },
    skill: {
      id: 'forgeSlam', name: '熔炉重击',
      cd: 8.0, mult: 3.12, element: 'fire', radius: 5.0, gauge: 2,
      desc: '将烧红的巨剑砸入地面，炸开熔岩并留下灼烧地带。',
      lingering: { duration: 4, tickMult: 0.4, interval: 0.7 }, particles: 4, knock: 6,
    },
    burst: {
      id: 'moltenCore', name: '熔心解放',
      cost: 80, cd: 18, mult: 6.2, element: 'fire', radius: 7.0, gauge: 2,
      desc: '释放熔炉之心，造成大范围爆发炎伤并强化自身攻击。',
      buff: { atkPct: 0.35, duration: 10 },
    },
    passive: { name: '烈焰淬炼', desc: '生命值低于 50% 时防御力提升 30%。', lowHpDef: 0.3 },
  },

  seris: {
    id: 'seris',
    name: '瑟莉丝',
    title: '潮汐祭司',
    element: 'water',
    weapon: 'catalyst',
    rarity: 5,
    voice: 300,
    base: { hp: 1120, atk: 28, def: 58, critRate: 0.05, critDmg: 0.5, em: 60, er: 1.15 },
    ascensionStat: { key: 'hpPct', value: 0.28 },
    body: {
      height: 1.66, build: 0.24, hair: 'longStraight',
      skin: 0xf6dcc8, hairColor: 0x2f6fa8, hairTip: 0x8fd8ff,
      primary: 0x1e4a72, secondary: 0xdfeffb, accent: 0x62c8ff, eye: 0x49b8ff,
      cape: true, skirt: 0.85, boots: 0x17384f, veil: true,
    },
    normal: { hits: [0.51, 0.48, 0.62, 0.78], frameTime: 0.36, element: 'water', projectile: true },
    charged: { mult: 1.42, stamina: 20, element: 'water', projectile: true, gauge: 1 },
    skill: {
      id: 'tideward', name: '潮护之环',
      cd: 12.0, mult: 1.6, element: 'water', radius: 4.4, gauge: 1,
      desc: '展开潮汐结界，持续治疗队伍并对触碰的敌人附着水元素。',
      heal: { hpScaling: 0.055, flat: 320, interval: 2.0, duration: 10 },
      shield: { hpScaling: 0.16, duration: 10 },
    },
    burst: {
      id: 'abyssalHymn', name: '深海赞歌',
      cost: 70, cd: 16, mult: 4.4, element: 'water', radius: 6.8, gauge: 2,
      desc: '召唤深海之潮席卷战场，造成水元素伤害并治疗全队。',
      heal: { hpScaling: 0.22, flat: 1200 },
    },
    passive: { name: '潮汐共鸣', desc: '生命值上限每 1000 点提升 2% 治疗加成。', healPerHp: 0.02 },
  },

  kaelen: {
    id: 'kaelen',
    name: '凯伦',
    title: '霜原猎手',
    element: 'ice',
    weapon: 'bow',
    rarity: 5,
    voice: 190,
    base: { hp: 990, atk: 32, def: 60, critRate: 0.05, critDmg: 0.5, em: 0, er: 1.0 },
    ascensionStat: { key: 'critDmg', value: 0.384 },
    body: {
      height: 1.78, build: 0.42, hair: 'ponytail',
      skin: 0xecd0b8, hairColor: 0xdfe9f2, hairTip: 0xa8d4e8,
      primary: 0x2b3f56, secondary: 0xdce8f2, accent: 0x9fe6ff, eye: 0x8fdcff,
      cape: true, skirt: 0.0, boots: 0x1e2c3c, quiver: true,
    },
    normal: { hits: [0.44, 0.47, 0.55, 0.30, 0.30], frameTime: 0.3, element: 'physical', projectile: true },
    charged: {
      mult: 1.24, stamina: 0, element: 'ice', projectile: true, aim: true,
      chargeTime: 1.1, gauge: 1, aimedMult: 2.16,
    },
    skill: {
      id: 'frostVolley', name: '霜华连射',
      cd: 7.0, mult: 0.86, ticks: 5, element: 'ice', gauge: 1, projectile: true,
      desc: '同时射出五支冰箭，命中后在地面留下霜华花。',
      lingering: { duration: 6, tickMult: 0.5, interval: 1.2, radius: 2.4 },
    },
    burst: {
      id: 'glacialRain', name: '冰河箭雨',
      cost: 60, cd: 15, mult: 1.02, ticks: 14, interval: 0.28,
      element: 'ice', radius: 7.5, gauge: 1,
      desc: '朝天射出寒箭，冰河之雨倾泻而下持续冻结敌人。',
      duration: 4.0,
    },
    passive: { name: '猎手之眼', desc: '瞄准射击对弱点造成的伤害提升 40%。', headshotBonus: 0.4 },
  },

  volt: {
    id: 'volt',
    name: '沃尔特',
    title: '雷枪卫士',
    element: 'lightning',
    weapon: 'polearm',
    rarity: 4,
    base: { hp: 1080, atk: 27, def: 72, critRate: 0.05, critDmg: 0.5, em: 0, er: 1.1 },
    ascensionStat: { key: 'er', value: 0.267 },
    voice: 150,
    body: {
      height: 1.8, build: 0.6, hair: 'spiky',
      skin: 0xdcae86, hairColor: 0x4a2f6e, hairTip: 0xc79cff,
      primary: 0x3a2b60, secondary: 0xe2d8f2, accent: 0xbf7bff, eye: 0xd0a0ff,
      cape: false, skirt: 0.0, boots: 0x241a3c, pauldrons: true,
    },
    normal: { hits: [0.48, 0.49, 0.30, 0.30, 0.62, 0.80], frameTime: 0.25, element: 'physical' },
    charged: { mult: 1.06, stamina: 20, element: 'physical', thrust: true },
    skill: {
      id: 'stormLance', name: '雷霆突刺',
      cd: 5.5, mult: 2.02, element: 'lightning', radius: 3.2, gauge: 1,
      desc: '以雷电贯穿前方直线上的敌人，命中后短暂提升攻速。',
      pierce: 9.0, buff: { atkSpeed: 0.25, duration: 5 }, particles: 2,
    },
    burst: {
      id: 'thunderCage', name: '雷牢',
      cost: 60, cd: 14, mult: 1.36, ticks: 8, interval: 0.5,
      element: 'lightning', radius: 5.6, gauge: 1, duration: 4.0,
      desc: '在战场上架起雷电牢笼，束缚并反复电击其中的敌人。',
      slow: 0.5,
    },
    // `onReactions` is the condition the description already stated. Without it the
    // 8 energy landed on *every* reaction including 蒸发, which is a 3.3x wider trigger
    // than the talent claims — see `shared/src/world/procs.js`.
    passive: { name: '导电体质', desc: '触发感电或超导时恢复 8 点元素能量。', energyOnReaction: 8, onReactions: ['electroCharged', 'superconduct'] },
  },

  terra: {
    id: 'terra',
    name: '忒拉',
    title: '磐岩守护',
    element: 'earth',
    weapon: 'claymore',
    rarity: 4,
    voice: 210,
    base: { hp: 1360, atk: 24, def: 96, critRate: 0.05, critDmg: 0.5, em: 0, er: 1.0 },
    ascensionStat: { key: 'defPct', value: 0.30 },
    body: {
      height: 1.72, build: 0.7, hair: 'bun',
      skin: 0xe8c49c, hairColor: 0x6b4a24, hairTip: 0xf0c860,
      primary: 0x6b4c22, secondary: 0xf3e3c0, accent: 0xffd15c, eye: 0xffca4a,
      cape: false, skirt: 0.35, boots: 0x3e2a12, pauldrons: true,
    },
    normal: { hits: [0.70, 0.66, 0.84, 1.06], frameTime: 0.44, element: 'physical' },
    charged: { mult: 0.60, stamina: 24, element: 'physical', spinDrain: 32 },
    skill: {
      id: 'bulwark', name: '磐岩壁垒',
      cd: 9.0, mult: 1.9, element: 'earth', radius: 4.0, gauge: 1,
      desc: '拔起岩石护壁，为自身附加护盾并嘲讽附近敌人。',
      shield: { defScaling: 2.2, duration: 12 }, taunt: 8.0,
    },
    burst: {
      id: 'seismicJudgment', name: '地脉裁决',
      cost: 60, cd: 15, mult: 5.4, element: 'earth', radius: 7.2, gauge: 2,
      desc: '震动地脉，岩刺自地面刺出并使敌人短暂石化。',
      stun: 2.0,
    },
    passive: { name: '大地之盾', desc: '护盾存在时受到的伤害降低 15%。', shieldDR: 0.15 },
  },

  aurel: {
    id: 'aurel',
    name: '奥蕾尔',
    title: '晨曦圣咏者',
    element: 'light',
    weapon: 'sword',
    rarity: 5,
    voice: 280,
    base: { hp: 1180, atk: 29, def: 68, critRate: 0.05, critDmg: 0.5, em: 40, er: 1.2 },
    ascensionStat: { key: 'healBonus', value: 0.222 },
    body: {
      height: 1.68, build: 0.3, hair: 'longWave',
      skin: 0xf8e0c8, hairColor: 0xf4e2a8, hairTip: 0xfff8d8,
      primary: 0xe8dcc0, secondary: 0xfffaf0, accent: 0xffe98a, eye: 0xffd96a,
      cape: true, skirt: 0.7, boots: 0xbfae86, wings: true,
    },
    normal: { hits: [0.46, 0.44, 0.50, 0.56, 0.72], frameTime: 0.27, element: 'physical' },
    charged: { mult: 1.2, stamina: 20, element: 'light', gauge: 1 },
    skill: {
      id: 'dawnBlessing', name: '晨曦祝福',
      cd: 10.0, mult: 1.4, element: 'light', radius: 5.0, gauge: 1,
      desc: '降下晨曦之光，治疗队伍并为攻击附加光元素。',
      heal: { atkScaling: 1.8, flat: 480 },
      buff: { infuse: 'light', duration: 8 },
    },
    burst: {
      id: 'hymnOfDawn', name: '破晓圣咏',
      cost: 80, cd: 20, mult: 7.4, element: 'light', radius: 8.0, gauge: 2,
      desc: '吟唱破晓圣咏，净化战场造成巨额光元素伤害并复苏队伍。',
      heal: { atkScaling: 3.0, flat: 1600 }, revive: true,
    },
    passive: { name: '圣咏回响', desc: '治疗溢出的部分转化为全队护盾。', overhealShield: 0.5 },
  },

  nyx: {
    id: 'nyx',
    name: '妮克丝',
    title: '暗影双刃',
    element: 'lightning',
    weapon: 'sword',
    rarity: 4,
    voice: 240,
    body: {
      height: 1.6, build: 0.26, hair: 'twinTail',
      skin: 0xe6c0a4, hairColor: 0x241c33, hairTip: 0x8a5cff,
      primary: 0x1c1830, secondary: 0x3a2f52, accent: 0x9a6cff, eye: 0xb98cff,
      cape: true, skirt: 0.4, boots: 0x14101f,
    },
    base: { hp: 940, atk: 33, def: 55, critRate: 0.05, critDmg: 0.5, em: 0, er: 1.0 },
    ascensionStat: { key: 'atkPct', value: 0.24 },
    normal: { hits: [0.32, 0.30, 0.34, 0.32, 0.38, 0.52], frameTime: 0.18, element: 'physical' },
    charged: { mult: 0.96, stamina: 18, element: 'physical', spin: true },
    skill: {
      id: 'shadowStep', name: '影袭',
      cd: 4.5, mult: 1.68, element: 'lightning', radius: 3.0, gauge: 1,
      desc: '瞬移至目标背后并造成雷元素伤害，命中背面时暴击率提升。',
      teleport: 9.0, backstab: 0.3, charges: 2,
    },
    burst: {
      id: 'thousandCuts', name: '千影斩',
      cost: 40, cd: 12, mult: 0.62, ticks: 16, interval: 0.12,
      element: 'lightning', radius: 4.0, gauge: 1,
      desc: '化为影群对范围内敌人展开高速连斩。',
    },
    passive: { name: '疾影', desc: '攻击速度提升 10%，暴击后移动速度提升 15%，持续 4 秒。', atkSpeed: 0.1, critMoveSpeed: 0.15, duration: 4 },
  },

  /* ------------------------------------------------------------------------
   * The second character of each element.
   *
   * 元素共鸣 (`data/resonance.js`) pays for two characters of the same element, and the
   * first eight entries above put seven elements across eight slots: 雷 was the only pair
   * a player could ever field, so six of the seven elemental resonances would have been
   * table rows nobody could reach — authored data with no way to consume it, which is the
   * exact defect the resonance gate exists to catch.
   *
   * All six are 四星, all six pair with the 五星 of their element (or, for 雷, add a third
   * option), and every kit field they use is one the simulation already consumes:
   * `tools/char-check.mjs` gates the whole roster's kit vocabulary against the consumers in
   * `world/actions.js`, `world/procs.js` and `sim/loot.js`.
   * ------------------------------------------------------------------------ */

  pyra: {
    id: 'pyra',
    name: '皮拉',
    title: '灰烬舞者',
    element: 'fire',
    weapon: 'polearm',
    rarity: 4,
    voice: 280,
    base: { hp: 960, atk: 31, def: 56, critRate: 0.05, critDmg: 0.5, em: 0, er: 1.0 },
    ascensionStat: { key: 'critDmg', value: 0.24 },
    body: {
      height: 1.64, build: 0.3, hair: 'ponytail',
      skin: 0xe8b98f, hairColor: 0x6e2418, hairTip: 0xff8a4c,
      primary: 0x64221c, secondary: 0xf0d8c0, accent: 0xff9a4c, eye: 0xffb974,
      cape: false, skirt: 0.5, boots: 0x39140f,
    },
    normal: { hits: [0.46, 0.44, 0.52, 0.30, 0.66], frameTime: 0.26, element: 'physical' },
    charged: { mult: 1.14, stamina: 20, element: 'physical', thrust: true },
    skill: {
      id: 'cinderWaltz', name: '灰烬回旋',
      cd: 7.0, mult: 2.36, element: 'fire', radius: 4.0, gauge: 1,
      desc: '旋身突进并甩出一圈灰烬，落点持续燃烧。',
      dash: 5.5, knock: 5, particles: 3,
      lingering: { duration: 3.0, tickMult: 0.34, interval: 0.6, radius: 3.2 },
    },
    burst: {
      id: 'ashenFinale', name: '烬火终舞',
      cost: 60, cd: 15, mult: 1.18, ticks: 8, interval: 0.5, duration: 4.0,
      element: 'fire', radius: 6.0, gauge: 1,
      desc: '以炽舞点燃整片场地，反复造成炎元素伤害。',
    },
    passive: { name: '余焰不散', desc: '炎元素伤害提升 12%。', bonus: { fire: 0.12 } },
  },

  naida: {
    id: 'naida',
    name: '娜依达',
    title: '涌泉侍女',
    element: 'water',
    weapon: 'sword',
    rarity: 4,
    voice: 320,
    base: { hp: 1140, atk: 26, def: 62, critRate: 0.05, critDmg: 0.5, em: 20, er: 1.15 },
    ascensionStat: { key: 'hpPct', value: 0.24 },
    body: {
      height: 1.58, build: 0.26, hair: 'twinTail',
      skin: 0xf4dcc6, hairColor: 0x2f7f9e, hairTip: 0xa8ecff,
      primary: 0x235f7a, secondary: 0xe6f4fb, accent: 0x6fd8ff, eye: 0x62c8ff,
      cape: false, skirt: 0.7, boots: 0x18424f,
    },
    normal: { hits: [0.42, 0.40, 0.48, 0.28, 0.62], frameTime: 0.27, element: 'physical' },
    charged: { mult: 1.10, stamina: 20, element: 'water', spin: true, gauge: 1 },
    skill: {
      id: 'springTide', name: '涌泉之礼',
      cd: 11.0, mult: 1.24, element: 'water', radius: 4.2, gauge: 1,
      desc: '在脚下开出一口泉眼，持续治疗附近的旅行者并附着水元素。',
      heal: { hpScaling: 0.04, flat: 240, interval: 2.5, duration: 8 },
    },
    burst: {
      id: 'wellspringVow', name: '泉誓',
      cost: 60, cd: 16, mult: 3.4, element: 'water', radius: 6.2, gauge: 2,
      desc: '涌泉冲上高空后落下，造成水元素伤害并治疗全队。',
      // Scales off HP like her skill does (and like her ascension stat, hpPct): an
      // atk-scaling heal on an HP character healed less than the damage the kit gave up,
      // which `tools/char-check.mjs` measures as HP/s against dps forfeited.
      heal: { hpScaling: 0.24, flat: 1000 },
    },
    passive: { name: '润泽', desc: '治疗加成提升 15%。', bonus: { healBonus: 0.15 } },
  },

  sylvi: {
    id: 'sylvi',
    name: '西尔薇',
    title: '霜绘学徒',
    element: 'ice',
    weapon: 'catalyst',
    rarity: 4,
    voice: 340,
    base: { hp: 900, atk: 30, def: 52, critRate: 0.05, critDmg: 0.5, em: 80, er: 1.1 },
    ascensionStat: { key: 'em', value: 96 },
    body: {
      height: 1.54, build: 0.22, hair: 'bun',
      skin: 0xf8e2d0, hairColor: 0xbcd8e8, hairTip: 0xeafaff,
      primary: 0x33566e, secondary: 0xeaf6fb, accent: 0x9fe8f8, eye: 0xa8ecff,
      cape: true, skirt: 0.8, boots: 0x22404f,
    },
    normal: { hits: [0.46, 0.44, 0.52, 0.70], frameTime: 0.34, element: 'ice', projectile: true },
    charged: { mult: 1.32, stamina: 20, element: 'ice', projectile: true, gauge: 1 },
    skill: {
      id: 'frostSketch', name: '霜绘三笔',
      cd: 7.0, mult: 0.9, ticks: 3, element: 'ice', gauge: 1, projectile: true,
      desc: '挥笔画出三道霜痕，命中的敌人被冰元素附着。',
    },
    burst: {
      id: 'hoarfrostCanvas', name: '霜白之幕',
      cost: 70, cd: 16, mult: 1.10, ticks: 7, interval: 0.5, duration: 3.5,
      element: 'ice', radius: 6.0, gauge: 2,
      desc: '铺开一整幅霜白画卷，持续冻结其中的敌人。',
      slow: true,
    },
    passive: { name: '素笔生霜', desc: '冰元素伤害提升 12%。', bonus: { ice: 0.12 } },
  },

  zephira: {
    id: 'zephira',
    name: '泽菲拉',
    title: '引风猎手',
    element: 'wind',
    weapon: 'bow',
    rarity: 4,
    voice: 230,
    base: { hp: 970, atk: 30, def: 58, critRate: 0.05, critDmg: 0.5, em: 40, er: 1.0 },
    ascensionStat: { key: 'critRate', value: 0.12 },
    body: {
      height: 1.7, build: 0.32, hair: 'longStraight',
      skin: 0xecd4b6, hairColor: 0x3f6b5a, hairTip: 0xa8f0d0,
      primary: 0x2c5348, secondary: 0xe4f6ec, accent: 0x7dffd0, eye: 0x8ff0c8,
      cape: true, skirt: 0.0, boots: 0x1e3a32, quiver: true,
    },
    normal: { hits: [0.42, 0.44, 0.52, 0.28, 0.28], frameTime: 0.29, element: 'physical', projectile: true },
    charged: {
      mult: 1.18, stamina: 0, element: 'wind', projectile: true, aim: true,
      chargeTime: 1.05, gauge: 1, aimedMult: 2.02,
    },
    skill: {
      id: 'gustLance', name: '穿风矢',
      cd: 6.5, mult: 2.10, element: 'wind', radius: 3.2, gauge: 1,
      desc: '拉满一箭贯穿整条直线，被命中的敌人附着风元素。',
      pierce: 12,
    },
    burst: {
      id: 'draftedSky', name: '牵风长歌',
      cost: 60, cd: 15, mult: 1.0, ticks: 8, interval: 0.45, duration: 3.6,
      element: 'wind', radius: 5.8, gauge: 1,
      desc: '拉出一片盘旋的气流，持续扩散场上的元素。',
    },
    passive: { name: '顺羽', desc: '冲刺消耗的体力降低 15%，风元素伤害提升 8%。', staminaMul: 0.85, bonus: { wind: 0.08 } },
  },

  gorran: {
    id: 'gorran',
    name: '戈兰',
    title: '山巡卫',
    element: 'earth',
    weapon: 'polearm',
    rarity: 4,
    voice: 120,
    base: { hp: 1290, atk: 25, def: 88, critRate: 0.05, critDmg: 0.5, em: 0, er: 1.0 },
    ascensionStat: { key: 'defPct', value: 0.3 },
    body: {
      height: 1.84, build: 0.78, hair: 'short',
      skin: 0xc59468, hairColor: 0x2e2620, hairTip: 0x8a7048,
      primary: 0x4a3a22, secondary: 0x2a2418, accent: 0xf0c04a, eye: 0xf0d08a,
      cape: false, skirt: 0.0, boots: 0x2a2016, pauldrons: true,
    },
    normal: { hits: [0.50, 0.48, 0.56, 0.32, 0.72], frameTime: 0.3, element: 'physical' },
    charged: { mult: 1.06, stamina: 22, element: 'physical', thrust: true },
    skill: {
      id: 'ridgeGuard', name: '山脊守势',
      cd: 10.0, mult: 1.70, element: 'earth', radius: 4.4, gauge: 1,
      desc: '以枪杵地立起岩壁，为自己张开护盾并把附近的敌人引向自己。',
      shield: { hpScaling: 0.14, defScaling: 1.2, duration: 12 },
      taunt: 5.0, pull: 4.5,
    },
    burst: {
      id: 'cairnfall', name: '落石阵',
      cost: 60, cd: 15, mult: 4.8, element: 'earth', radius: 6.4, gauge: 2,
      desc: '砸落一整片岩块，造成岩元素伤害并将敌人震晕。',
      stun: 1.6,
    },
    passive: { name: '岩壁', desc: '护盾存在时受到的伤害降低 12%。', shieldDR: 0.12 },
  },

  elira: {
    id: 'elira',
    name: '艾莉拉',
    title: '晨祷执笔',
    element: 'light',
    weapon: 'catalyst',
    rarity: 4,
    voice: 310,
    base: { hp: 1010, atk: 29, def: 60, critRate: 0.05, critDmg: 0.5, em: 60, er: 1.2 },
    ascensionStat: { key: 'atkPct', value: 0.18 },
    body: {
      height: 1.66, build: 0.27, hair: 'longWave',
      skin: 0xf6e0c8, hairColor: 0xe8d69a, hairTip: 0xfff6d8,
      primary: 0x6a5a2e, secondary: 0xfbf4e0, accent: 0xffe89a, eye: 0xfff0b8,
      cape: true, skirt: 0.75, boots: 0x4a3e20, veil: true,
    },
    normal: { hits: [0.44, 0.42, 0.50, 0.66], frameTime: 0.33, element: 'light', projectile: true },
    charged: { mult: 1.28, stamina: 20, element: 'light', projectile: true, gauge: 1 },
    skill: {
      id: 'matinBlessing', name: '晨祷',
      cd: 8.0, mult: 2.20, element: 'light', radius: 3.6, gauge: 1,
      desc: '诵出一段晨祷，光辉炸开的同时提升自身攻击力。',
      buff: { atkPct: 0.18, duration: 8 },
    },
    burst: {
      id: 'litanyOfDawn', name: '破晓连祷',
      cost: 70, cd: 17, mult: 5.0, element: 'light', radius: 6.0, gauge: 2,
      desc: '将晨光倾泻而下，造成光元素伤害并治疗全队。',
      heal: { atkScaling: 1.2, flat: 600 },
    },
    passive: { name: '晨光', desc: '光元素伤害提升 12%。', bonus: { light: 0.12 } },
  },
};

export const CHARACTER_IDS = Object.keys(CHARACTERS);

export const STARTER_PARTY = ['lyra', 'ignar', 'seris', 'volt'];

/**
 * Every field a kit may carry, and the one place that reads it.
 *
 * A character sheet is *data*, and data in this repo has rotted the same way three times
 * now: nine weapon passives, nine sfx recipes and eight resonance fields were authored,
 * described in a tooltip, and consumed by nobody. The roster had six of them when this map
 * was written — `charged.chargeTime`, `charged.hold`, `charged.spinDrain`, `charged.thrust`,
 * `charged.headshot` and `skill.particles` — so every bow charged in 0.32 s, every claymore
 * spin cost one flat swing, and a two-particle skill charged its burst exactly as fast as a
 * four-particle one. Four of them got the consumer they were waiting for; the other two were
 * deleted instead, because `charged.hold` restated what a non-zero `spinDrain` already says
 * and `charged.headshot` was a second rule named 弱点 next to `passive.headshotBonus`.
 *
 * The value is `module.function`, resolved by `tools/char-check.mjs`, which fails in both
 * directions: a kit key that is not declared here, a declared key no character uses, and a
 * consumer that no longer names the function or reads the key. Keys are full paths, because
 * `duration` under `skill.heal` and under `passive` are two different rules.
 *
 * `ui/panels` means the field is *presentation only* (a name, a description): still a
 * consumer, but one that must not be mistaken for a simulation effect.
 */
export const KIT_FIELDS = Object.freeze({
  // -- identity. `voice` is the pitch of the character's 发声, and the only top-level field
  // that is a *kit* field rather than a label: two characters differ by a fifth.
  voice: 'game/game._bindLocal',

  // -- normal / charged attacks
  'normal.hits': 'world/actions.handleAttack',
  'normal.frameTime': 'world/actions.handleAttack',
  'normal.element': 'world/actions.handleAttack',
  'normal.projectile': 'world/actions.handleAttack',
  'charged.mult': 'world/actions.handleAttack',
  'charged.element': 'world/actions.handleAttack',
  'charged.gauge': 'world/actions.handleAttack',
  'charged.projectile': 'world/actions.handleAttack',
  'charged.aim': 'world/actions.handleAttack',
  'charged.aimedMult': 'world/actions.handleAttack',
  // The wedge a swing covers is geometry, and geometry now lives in one place that both the
  // damage sweep and the ground decal read, so this key's consumer moved out of the action.
  'charged.spin': 'data/characters.playerAttackShape',
  'charged.stamina': 'game/localPlayer.chargedAttack',
  'charged.chargeTime': 'game/localPlayer.chargeTime',
  'charged.spinDrain': 'game/localPlayer.drainSpin',
  'charged.thrust': 'game/localPlayer.chargedAttack',

  // -- elemental skill
  'skill.id': 'world/actions.handleSkill',
  'skill.name': 'ui/panels._character',
  'skill.desc': 'ui/panels._character',
  'skill.cd': 'world/actions.handleSkill',
  'skill.charges': 'world/actions.handleSkill',
  'skill.mult': 'world/actions.handleSkill',
  'skill.element': 'world/actions.handleSkill',
  'skill.gauge': 'world/actions.handleSkill',
  'skill.radius': 'world/actions.handleSkill',
  'skill.ticks': 'world/actions.handleSkill',
  'skill.particles': 'world/actions.handleSkill',
  'skill.projectile': 'world/actions.handleSkill',
  'skill.dash': 'world/actions.handleSkill',
  'skill.teleport': 'world/actions.handleSkill',
  'skill.pierce': 'world/actions.handleSkill',
  'skill.knock': 'world/actions.handleSkill',
  'skill.pull': 'world/actions.handleSkill',
  'skill.taunt': 'world/actions.handleSkill',
  'skill.backstab': 'world/actions.handleSkill',
  'skill.buff.atkPct': 'world/procs.liveStats',
  'skill.buff.atkSpeed': 'world/procs.liveStats',
  'skill.buff.infuse': 'world/actions.handleAttack',
  'skill.buff.duration': 'world/actions.handleSkill',
  'skill.shield.hpScaling': 'world/actions.handleSkill',
  'skill.shield.defScaling': 'world/actions.handleSkill',
  'skill.shield.duration': 'world/actions.handleSkill',
  'skill.heal.hpScaling': 'world/actions.handleSkill',
  'skill.heal.atkScaling': 'world/actions.handleSkill',
  'skill.heal.flat': 'world/actions.handleSkill',
  'skill.heal.interval': 'world/actions.handleSkill',
  'skill.heal.duration': 'world/actions.handleSkill',
  'skill.lingering.duration': 'world/actions.handleSkill',
  'skill.lingering.interval': 'world/actions.handleSkill',
  'skill.lingering.radius': 'world/actions.handleSkill',
  'skill.lingering.tickMult': 'world/actions.handleSkill',

  // -- elemental burst
  'burst.id': 'world/actions.handleBurst',
  'burst.name': 'ui/panels._character',
  'burst.desc': 'ui/panels._character',
  'burst.cd': 'world/actions.handleBurst',
  'burst.cost': 'world/actions.handleBurst',
  'burst.mult': 'world/actions.handleBurst',
  'burst.element': 'world/actions.handleBurst',
  'burst.gauge': 'world/actions.handleBurst',
  'burst.radius': 'world/actions.handleBurst',
  'burst.duration': 'world/actions.handleBurst',
  'burst.interval': 'world/actions.handleBurst',
  'burst.ticks': 'world/actions.handleBurst',
  'burst.stun': 'world/actions.handleBurst',
  'burst.slow': 'world/actions.handleBurst',
  'burst.revive': 'world/actions.handleBurst',
  'burst.buff.atkPct': 'world/procs.liveStats',
  'burst.buff.duration': 'world/actions.handleBurst',
  'burst.heal.hpScaling': 'world/actions.handleBurst',
  'burst.heal.atkScaling': 'world/actions.handleBurst',
  'burst.heal.flat': 'world/actions.handleBurst',

  // -- passive talent. Half of these are conditional, and each one names the single place
  // that can judge its condition — that is why they are not all in `buildCharacterStats`.
  'passive.name': 'ui/panels._character',
  'passive.desc': 'ui/panels._character',
  'passive.bonus': 'sim/loot.buildCharacterStats',
  'passive.atkSpeed': 'sim/loot.buildCharacterStats',
  'passive.healPerHp': 'sim/loot.buildCharacterStats',
  'passive.staminaMul': 'game/localPlayer.dash',
  'passive.shieldDR': 'world/entity.takeDamage',
  'passive.lowHpDef': 'world/procs.liveStats',
  'passive.overhealShield': 'world/procs.healOverflowToShield',
  'passive.critMoveSpeed': 'world/procs.fireProcs',
  'passive.energyOnReaction': 'world/procs.fireProcs',
  'passive.onReactions': 'world/procs.fireProcs',
  'passive.duration': 'world/procs.fireProcs',
  'passive.headshotBonus': 'world/zoneInstance.playerHitEnemy',

  // -- procedural model. No asset files: the mesh is built from these numbers.
  'body.height': 'gfx/humanoid.buildHumanoid',
  'body.build': 'gfx/humanoid.torsoProfile',
  'body.hair': 'gfx/humanoid.buildHair',
  'body.hairColor': 'gfx/humanoid.buildHumanoid',
  'body.hairTip': 'gfx/humanoid.buildHumanoid',
  'body.skin': 'gfx/humanoid.buildHumanoid',
  'body.eye': 'gfx/humanoid.buildHumanoid',
  'body.primary': 'gfx/humanoid.buildHumanoid',
  'body.secondary': 'gfx/humanoid.buildHumanoid',
  'body.accent': 'gfx/humanoid.buildHumanoid',
  'body.boots': 'gfx/humanoid.buildHumanoid',
  'body.cape': 'gfx/humanoid.buildHumanoid',
  'body.skirt': 'gfx/humanoid.buildHumanoid',
  'body.veil': 'gfx/humanoid.buildHumanoid',
  'body.wings': 'gfx/humanoid.buildHumanoid',
  'body.pauldrons': 'gfx/humanoid.buildHumanoid',
  'body.quiver': 'gfx/humanoid.buildHumanoid',
});

/** Top-level keys of a character that are identity or presentation, not a kit field. */
export const CHARACTER_META_KEYS = Object.freeze([
  'id', 'name', 'title', 'element', 'weapon', 'rarity', 'starter', 'base', 'ascensionStat',
  'body', 'normal', 'charged', 'plunge', 'skill', 'burst', 'passive',
]);

/** Hair styles `gfx/humanoid.buildHair` can actually build. */
export const HAIR_STYLES = Object.freeze([
  'longWave', 'longStraight', 'ponytail', 'twinTail', 'bun', 'spiky', 'short',
]);

/** Talent multiplier scaling with talent level (1..10). */
export function talentScale(level) {
  return 1 + (level - 1) * 0.087;
}

/**
 * How far a constellation goes. Exported because three places have to agree: `dupeBonus`
 * stops here, `repo.grantCharacter` clamps the stored count here, and the wish's dupe
 * conversion pays the *maxed* rate exactly when a pull could not raise it any further.
 * A `6` typed into the UPDATE statement is how the third one silently stops matching.
 */
export const MAX_CONSTELLATION = 6;

/** Constellation-style bonuses by duplicate count. */
export function dupeBonus(dupes) {
  const c = Math.min(dupes, MAX_CONSTELLATION);
  return { atkPct: c * 0.04, critRate: c * 0.015, cdReduction: c * 0.03 };
}
