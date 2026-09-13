// Zone (scene/level) definitions. Terrain is procedural but fully deterministic:
// the server uses the same heightAt() as the client so movement/collision agree.

import { fbm2, ridged2, clamp, lerp, smoothstep, Rand, hashStr } from '../sim/rng.js';
import { chamberXp } from '../sim/formulas.js';

/**
 * Each zone declares:
 *  - terrain: layered noise recipe + biome palette
 *  - spawns:  enemy camps with positions derived from the zone seed
 *  - props:   procedural scatter rules (trees, rocks, grass, ruins)
 *  - poi:     waypoints, chests, puzzles, dungeon entrances
 */
export const ZONES = {
  mondstadt: {
    id: 'mondstadt',
    name: '蒙德平原',
    subtitle: '风与牧歌之地',
    seed: 20240117,
    size: 420,
    kind: 'open',
    levelRange: [1, 20],
    recommendedLevel: 1,
    entryRank: 1,
    music: 'plains',
    weather: { type: 'clear', windSpeed: 3.2, cloudiness: 0.35 },
    // 天气: day 0 is the `weather` block above, exactly (that is what keeps the pixel gates valid);
    // from day 1 the rotation runs here, one entry per in-game day of 24 real minutes. `strength` is
    // how far toward that weather this zone goes, so 蒙德's rain is a mild green-country rain and
    // 龙脊's is not — see `shared/src/world/weather.js`.
    forecast: [
      { name: '多云', seg: [{ at: 0 }, { at: 8, type: 'cloudy', strength: 0.85 }, { at: 20 }] },
      { name: '午后骤雨', seg: [
        { at: 0 }, { at: 11, type: 'cloudy', strength: 0.7 }, { at: 13.5, type: 'rain', strength: 0.9 },
        { at: 18, type: 'cloudy', strength: 0.5 }, { at: 21 },
      ] },
      { name: '晴朗', seg: [{ at: 0 }] },
      // Starts already raining: the crossfade at the top of the day comes from the *previous* day's
      // last segment, so this arrives during the small hours instead of popping on at 00:00.
      { name: '晨雨', seg: [
        { at: 0, type: 'rain', strength: 0.45 }, { at: 7.5, type: 'cloudy', strength: 0.6 }, { at: 14 },
      ] },
    ],
    sky: {
      sunDir: [0.42, 0.72, 0.35], sunColor: 0xfff2d8, sunIntensity: 2.5,
      ambientSky: 0x9fc8ff, ambientGround: 0x6b7a4a, ambientIntensity: 0.85,
      fogColor: 0xc8ddf0, fogDensity: 0.0016,
      rayleigh: 1.4, turbidity: 3.2, exposure: 1.0,
    },
    terrain: {
      // 78 m of relief with mid-frequency ridges: the starter zone is the one the
      // player sees most, and at the old 34 m / 0.0075 ridge it read as a putting
      // green — 94% of the map sat inside a single 10 m band.
      octaves: 7, scale: 0.0042, height: 78, ridgeMix: 0.45, ridgeScale: 0.019,
      plateau: 0.12, cliffPower: 1.1, baseShift: 24,
      lakes: [{ at: [80, -118], radius: 54, floor: -5 }],
      biomes: [
        { key: 'grass',  color: 0x6d8f41, rough: 0.9, maxSlope: 0.55, maxHeight: 999 },
        { key: 'rock',   color: 0x8a8378, rough: 0.95, minSlope: 0.55 },
        { key: 'sand',   color: 0xd8cfa4, rough: 0.85, maxHeight: 3.2 },
        { key: 'dirt',   color: 0x7a6244, rough: 0.9, maxHeight: 999 },
      ],
      // Steep faces are painted with this, not with a biome: the biome splat is too
      // low-frequency to follow a cliff edge. It has to be stated per zone — the
      // default is the *fourth* biome, which here is dirt, and that is what turned
      // every distant hillside into a brown scar across the meadow.
      cliffColor: 0x8a8378,
      // The meadow's two blade colours, read by `gfx/props.js#SCATTER.grassTuft`: A is the
      // lit blade, B its shaded partner, and the light and dry variants are derived from A
      // so a zone cannot end up with four colours that disagree.
      // The pair the meadow was actually tuned on (`gfx/props.js` held them as constants
      // while these keys sat unread): 0x80a64c/0x506f36 was authored here, half a stop
      // brighter and a good deal more saturated — and saturated green is the one thing the
      // ACES curve mangles, so the tuned values win and the data is corrected to match.
      grassColorA: 0x648944, grassColorB: 0x486833,
      shadowTint: 0x6f7ba8,
    },
    water: { level: 1.4, color: 0x4a6d8f, deepColor: 0x25394e, foam: 0x9fd8f0 },
    props: {
      trees: { density: 0.00105, kinds: ['oak', 'pine'], minH: 3.0, maxSlope: 0.4, scale: [0.85, 1.5] },
      rocks: { density: 0.00055, scale: [0.5, 2.2] },
      grass: { density: 3.0, maxSlope: 0.5, height: [0.26, 0.50] },
      flowers: { density: 0.06, kinds: ['sweetFlower', 'windwheelAster', 'mint'] },
      ruins: { count: 6, kind: 'pillar' },
      bushes: { density: 0.0042 },
    },
    spawns: [
      { at: [40, 60], enemies: ['slimeWater', 'slimeWater', 'hilichurl'], level: 3, radius: 9, respawn: 90 },
      { at: [-70, 30], enemies: ['hilichurl', 'hilichurl', 'hilichurlArcher'], level: 5, radius: 10, respawn: 90 },
      { at: [110, -40], enemies: ['slimeFire', 'slimeFire', 'hilichurlPyro'], level: 8, radius: 11, respawn: 120 },
      { at: [-120, -90], enemies: ['hilichurlArcher', 'hilichurl', 'hilichurl', 'hilichurlPyro'], level: 10, radius: 12, respawn: 120 },
      { at: [10, -140], enemies: ['ruinGuard'], level: 14, radius: 14, respawn: 300, elite: true },
      { at: [160, 120], enemies: ['slimeElectro', 'slimeElectro', 'slimeWater'], level: 6, radius: 10, respawn: 90 },
      { at: [-160, 140], enemies: ['frostWolf', 'frostWolf', 'frostWolf'], level: 12, radius: 12, respawn: 150 },
    ],
    // Gatherables. Counts, not densities: every node has a stable id because the
    // server records "picked at" per node, so the set has to be a fixed list rather
    // than something the streamer invents as the player walks.
    gathers: [
      { kind: 'sweetFlower', count: 28, perCluster: 4, spots: [[16, 19], [-24, -9]] },
      { kind: 'windwheelAster', count: 22, perCluster: 3 },
      { kind: 'mint', count: 20, perCluster: 3, spots: [[-13, 22]] },
      // Cooking staples, in bigger clusters than the flowers: a recipe wants two or
      // three of each, so a lone stalk per hillside would make one dish an
      // afternoon's walk. Wheat sits in the open, mushrooms under the trees.
      { kind: 'wheat', count: 30, perCluster: 6, spots: [[24, 8]] },
      { kind: 'mushroom', count: 24, perCluster: 4, spots: [[-20, -18]] },
      { kind: 'ironChunk', count: 18, perCluster: 3, prop: 'oreNode', color: 0x8a7a68, maxSlope: 0.95, spots: [[30, -14]] },
      { kind: 'crystalChunk', count: 8, perCluster: 2, prop: 'oreNode', color: 0x9fd8ee, maxSlope: 0.95 },
    ],
    poi: [
      { id: 'mond_spawn', type: 'waypoint', at: [0, 0], name: '风起地' },
      { id: 'mond_wp2', type: 'waypoint', at: [130, -60], name: '果酒湖畔' },
      { id: 'mond_wp3', type: 'waypoint', at: [-140, 110], name: '奔狼领' },
      { id: 'mond_chest1', type: 'chest', at: [55, 72], tier: 'common' },
      { id: 'mond_chest2', type: 'chest', at: [-88, 44], tier: 'exquisite' },
      { id: 'mond_chest3', type: 'chest', at: [148, 128], tier: 'precious' },
      { id: 'mond_chest4', type: 'chest', at: [-30, -150], tier: 'luxurious', requires: 'puzzle:mond_puzzle1' },
      { id: 'mond_puzzle1', type: 'puzzle', at: [-30, -142], kind: 'elementalMonument', element: 'wind', count: 3, name: '风之试炼' },
      { id: 'mond_dungeon', type: 'dungeon', at: [190, 190], target: 'abyssTrial', name: '深渊试炼入口' },
      { id: 'mond_statue', type: 'statue', at: [0, -20], element: 'wind', name: '七天神像' },
    ],
    npcs: [
      // `lines` is the whole conversation. It used to be a `dialogue: 'welcome'` key that
      // nothing read, so every NPC in the game said "……" — an authored key with no
      // consumer is worse than no key, because it looks like the feature exists.
      { id: 'katheryne', at: [8, 6], name: '凯瑟琳', role: 'guild', lines: [
        '欢迎来到冒险家协会，需要协会的帮助吗？',
        '每日委托能换取冒险经验与原石，别忘了领取。',
        '祝您旅途顺利，冒险家。',
      ] },
      // `role` was decoration until the shop existed; `shop` is the key that makes a
      // keeper a keeper, and it names a shop in `data/shop.js` rather than repeating its
      // stock here. An NPC with `role: 'shop'` and no `shop` opens nothing.
      { id: 'smith', at: [-14, 10], name: '铁匠瓦格纳', role: 'forge', shop: 'blacksmith', lines: [
        '要打铁还是要买矿？两样我都在行。',
        '三星的胚子拿去精炼吧，别当收藏品供着。',
      ] },
      { id: 'grocer', at: [11, -4], name: '杂货商花语', role: 'shop', shop: 'general', lines: [
        '万有铺，什么都有一点点。',
        '甜甜花和薄荷今天新到，做菜正合适。',
      ] },
      { id: 'scholar', at: [16, -8], name: '学者莉莎', role: 'quest', quest: 'q_intro', lines: [
        '哦呀，是新来的旅行者。',
        '风起地那边最近不太安宁，愿意去看看吗？',
      ] },
    ],
  },

  dragonspine: {
    id: 'dragonspine',
    name: '龙脊雪山',
    subtitle: '沉眠的严寒',
    seed: 771203,
    size: 380,
    kind: 'open',
    levelRange: [20, 45],
    recommendedLevel: 22,
    entryRank: 4,
    music: 'snow',
    weather: { type: 'snow', windSpeed: 6.5, cloudiness: 0.72 },
    // A zone whose baseline already precipitates: its quiet days are the ones where the snow
    // *stops* (`cloudy`), and its bad days are the only weather in the game that makes 严寒 climb
    // faster than authored (`coldMul` is exactly 1 at the baseline above).
    forecast: [
      { name: '风雪渐起', seg: [{ at: 0 }, { at: 10, type: 'blizzard', strength: 0.75 }, { at: 16 }] },
      { name: '雪停', seg: [{ at: 0 }, { at: 6, type: 'cloudy', strength: 0.8 }, { at: 17 }] },
      { name: '整日暴风雪', seg: [
        { at: 0, type: 'blizzard', strength: 1 }, { at: 20, type: 'snow', strength: 0.8 },
      ] },
      { name: '细雪', seg: [{ at: 0, type: 'snow', strength: 0.45 }] },
    ],
    mechanic: { sheerCold: true, coldRate: 3.2, warmRadius: 12 },
    sky: {
      // `sunIntensity` drives the DirectionalLight (props, characters, shadow map) and *not*
      // the terrain: `gfx/terrain.js` takes `sunColor` as its light term and never multiplies
      // it by this. Lowering it to dim a blown-out snowfield therefore moved nothing — the
      // measurement that proved it: near-ground rgb [189,206,224] before and after.
      sunDir: [0.28, 0.55, -0.5], sunColor: 0xd8e8ff, sunIntensity: 1.9,
      ambientSky: 0xcfe4ff, ambientGround: 0x8fa8c0, ambientIntensity: 1.05,
      fogColor: 0xd6e4f2, fogDensity: 0.0042,
      // 0.58, and this is the number that made the zone readable. `sky.exposure` was authored
      // on all six zones and read by nobody until `Renderer#setExposure`; at the 1.05 written
      // here the snowfield measured rgb [192,209,227] p5..p95 204..213 — a 9-count band holding
      // the drift shader, the sparkle, the slope shading and the blue shadow, all computed and
      // all rolled off the top of the ACES curve, with the ground landing on the same value as
      // its own sky. Every other zone keeps the exposure it authored; this is the one whose
      // entire frame is a single bright material, so it is the one that has to sit lower on the
      // curve. Measured at 0.5: the same rect reads std 14 and the drifts are visible.
      rayleigh: 2.2, turbidity: 6.0, exposure: 0.58,
    },
    terrain: {
      octaves: 6, scale: 0.0038, height: 78, ridgeMix: 0.62, ridgeScale: 0.0055,
      plateau: 0.15, cliffPower: 1.9, baseShift: 6,
      // A frozen tarn in the western hollow: the ice surface is the zone's one
      // flat landmark in a map of slopes.
      lakes: [{ at: [-92, -4], radius: 44, floor: -8 }],
      // The snow *shader* (drifts with a long wind axis, sky-blue troughs, near-field
      // sparkle — the `uSnowLine` branch in gfx/terrain.js) had never run in this game:
      // its three inputs had defaults and no zone authored them, so `uSnowLine` was 1e9
      // everywhere and Dragonspine's ground was the flat biome albedo. Measured on
      // /tmp/tour-dragonspine-0.png before this: near-ground luma 209.6 std 10.0, i.e. the
      // one surface in the game with no texture at all — and *brighter* than its own sky
      // (197.1), so the horizon dissolved.
      //
      // Not a peak height and not even a *positive* one. The first attempt put the line at 2 m
      // with a 14 m blend, reasoning from the height histogram (-8 → 46 m, p25 9.7, p50 18.6)
      // that a low line would cover the zone — and it did cover it, at weight 0.4: the spawn
      // and the whole walkable bowl sit at y ≈ -0.6, so `smoothstep(-12, 16, -0.6)` diluted
      // every drift and sparkle to a third of its amplitude and the near ground still measured
      // std 3.3, i.e. featureless. The blend has to *end* below the ground the player stands
      // on. -2 + 3 puts full snow everywhere above -2 m — which is exactly the water level, so
      // the frozen tarn is the one surface that stays ice, and it needs no separate rule.
      snowLine: -2, snowBlend: 3,
      // Darker than the albedo it replaces (0xeef4fb, luma 244). `uSnowColor` is the
      // effective albedo of every flat snow surface once the branch runs, and at 244 under
      // this zone's 1.9-intensity sun the drift modulation (±5 %) and the sparkle (+0.34)
      // both landed above the tonemap's shoulder, i.e. the texture existed and was clipped
      // off. See [tinted-light-eats-hue]: a surface brighter than its sky is an albedo
      // value fault, not a lighting one.
      //
      // Then lowered again, for the same reason one step further out. 0xd4e2f0 fixed the
      // *distant* field (that measurement was taken 20 m out) but the ground at the player's
      // feet still came back lum 194 with p5..p95 of 188..200 — std 3.9, featureless. Driving
      // one thing at a time in that frame: uDetail 0 → std 1.1 (so every count of texture
      // there is authored, none of it is lighting), uDetail 3 → 6.3, exposure 0.40 → 4.7, and
      // this albedo at 65 % → 5.1. A ±20 % albedo swing buying five sRGB counts *is* the
      // shoulder, so the fix is both halves: the operating point here and a bigger swing in
      // the snow branch of gfx/terrain.js. Snow stays the brightest ground in the game and
      // stays below its own sky, which is the constraint that matters.
      snowColor: 0xbccddf,
      // Snow shadows are blue because a shadowed snowfield is lit by sky alone. This is the
      // one zone where that is the *main* source of shape.
      shadowTint: 0x7d92c8,
      biomes: [
        // Both snows track `snowColor` (the shader takes over on flat ground, these carry
        // the slopes and the tarn's rim, and a seam between them would be a hard line
        // across every hillside). `snow2` is the `uColD` patch term, a colder grey-blue so
        // the field has a second colour rather than a second brightness.
        { key: 'snow',   color: 0xbccddf, rough: 0.7, maxSlope: 0.6, maxHeight: 999 },
        { key: 'ice',    color: 0xb8d8ea, rough: 0.25, minSlope: 0.62 },
        { key: 'rock',   color: 0x5d6470, rough: 0.95, minSlope: 0.68 },
        { key: 'snow2',  color: 0xb6c8dc, rough: 0.75, maxHeight: 999 },
      ],
      cliffColor: 0x5d6470,   // bare rock, not the snow that used to bleach the cliffs
      // Blades in the zone's own colour: pale, snow-dusted tufts. Read by
      // `gfx/props.js#SCATTER.grassTuft` via `world.js#_recipes` — before that these two
      // keys were authored on all six zones and consumed by nobody, so Dragonspine's
      // snowfields grew the same 0x648944 meadow green as Mondstadt.
      // *Below* the snow albedo above (luma 165 and 122 against the drift's 222): the pair
      // authored here before was 0xe8f2fb/0xc0d4e4, i.e. blades brighter than the ground
      // they stand in, which is the same albedo fault the snow branch just fixed. Frost-bitten
      // grey-green; the tufts also run `dry: true` below, so most blades come out as the cool
      // straw `dryBlade()` strikes from this colour.
      grassColorA: 0x9aa89e, grassColorB: 0x74857a,
    },
    water: { level: -2, color: 0x3a5b71, deepColor: 0x202f40, foam: 0xd8f0ff, frozen: true },
    props: {
      trees: { density: 0.00042, kinds: ['pine', 'deadTree'], minH: 6, maxSlope: 0.45, scale: [0.9, 1.7], snowy: true },
      rocks: { density: 0.0009, scale: [0.6, 3.0], snowy: true },
      grass: { density: 0.55, maxSlope: 0.4, height: [0.11, 0.24], dry: true },
      crystals: { density: 0.00035, color: 0x8fe3f0 },
      ruins: { count: 4, kind: 'ancientArch' },
    },
    spawns: [
      { at: [30, 40], enemies: ['frostWolf', 'frostWolf', 'frostWolf'], level: 24, radius: 12, respawn: 120 },
      { at: [-60, 80], enemies: ['abyssMage', 'hilichurl', 'hilichurl'], level: 28, radius: 12, respawn: 150 },
      { at: [90, -50], enemies: ['frostWolf', 'frostWolf', 'abyssMage'], level: 32, radius: 13, respawn: 150 },
      { at: [-110, -70], enemies: ['ruinGuard', 'hilichurlArcher', 'hilichurlArcher'], level: 36, radius: 15, respawn: 300, elite: true },
      { at: [140, 130], enemies: ['geoVishap'], level: 40, radius: 14, respawn: 300, elite: true },
    ],
    gathers: [
      { kind: 'qingxin', count: 14, perCluster: 2 },
      { kind: 'mint', count: 10, perCluster: 2 },
      { kind: 'mushroom', count: 12, perCluster: 3 },
      { kind: 'starsilver', count: 18, perCluster: 3, prop: 'oreNode', color: 0xd8e4f0, maxSlope: 0.95 },
      { kind: 'whiteIronChunk', count: 14, perCluster: 3, prop: 'oreNode', color: 0xb8bcc4, maxSlope: 0.95 },
    ],
    poi: [
      { id: 'ds_wp1', type: 'waypoint', at: [0, 0], name: '雪葬之都·外围' },
      { id: 'ds_wp2', type: 'waypoint', at: [120, -80], name: '星银矿洞' },
      { id: 'ds_warm1', type: 'warmth', at: [20, 25], name: '篝火' },
      { id: 'ds_warm2', type: 'warmth', at: [-80, 60], name: '篝火' },
      { id: 'ds_warm3', type: 'warmth', at: [110, 110], name: '篝火' },
      { id: 'ds_chest1', type: 'chest', at: [46, 58], tier: 'exquisite' },
      { id: 'ds_chest2', type: 'chest', at: [-96, -64], tier: 'luxurious' },
      { id: 'ds_puzzle1', type: 'puzzle', at: [60, -100], kind: 'sealedFrost', count: 4, name: '封印的碎片' },
      { id: 'ds_dungeon', type: 'dungeon', at: [-170, 170], target: 'frostCavern', name: '冰封洞窟' },
      { id: 'ds_statue', type: 'statue', at: [-10, 12], element: 'ice', name: '七天神像' },
    ],
    npcs: [
      { id: 'explorer', at: [6, 4], name: '冒险家伊利亚斯', role: 'quest', quest: 'q_dragonspine', lines: [
        '这山里的寒气会钻进骨头，别待太久。',
        '篝火附近能暖回来，也能烧点热的。',
      ] },
    ],
  },

  liyue: {
    id: 'liyue',
    name: '璃月群峰',
    subtitle: '磐岩之国',
    seed: 998877,
    size: 440,
    kind: 'open',
    levelRange: [30, 60],
    recommendedLevel: 35,
    entryRank: 7,
    music: 'karst',
    weather: { type: 'clear', windSpeed: 2.4, cloudiness: 0.28 },
    forecast: [
      { name: '海雾', seg: [{ at: 0, type: 'cloudy', strength: 0.9 }, { at: 11 }] },
      // Ends still raining, on purpose: the day boundary is the one seam a forecast can tear at.
      { name: '夜雨', seg: [
        { at: 0, type: 'rain', strength: 0.6 }, { at: 3, type: 'cloudy', strength: 0.5 }, { at: 9 },
        { at: 20, type: 'cloudy', strength: 0.7 }, { at: 22, type: 'rain', strength: 0.75 },
      ] },
      { name: '晴朗', seg: [{ at: 0 }] },
      { name: '午后阵雨', seg: [{ at: 0 }, { at: 15, type: 'rain', strength: 0.55 }, { at: 17.5 }] },
    ],
    sky: {
      sunDir: [-0.35, 0.62, 0.5], sunColor: 0xffe6b8, sunIntensity: 2.7,
      ambientSky: 0xffd8a8, ambientGround: 0x7a6a48, ambientIntensity: 0.9,
      fogColor: 0xf0dcb8, fogDensity: 0.0018,
      rayleigh: 1.1, turbidity: 4.5, exposure: 1.08,
    },
    terrain: {
      octaves: 7, scale: 0.0034, height: 96, ridgeMix: 0.85, ridgeScale: 0.0044,
      plateau: 0.08, cliffPower: 2.6, karst: true, baseShift: 22,
      lakes: [{ at: [-132, 34], radius: 50, floor: -4 }],
      biomes: [
        { key: 'grass',  color: 0x658845, rough: 0.9, maxSlope: 0.5, maxHeight: 999 },
        { key: 'karst',  color: 0xb8a888, rough: 0.9, minSlope: 0.5 },
        { key: 'gold',   color: 0xd8b060, rough: 0.85, maxHeight: 6 },
        { key: 'stone',  color: 0x9a8a70, rough: 0.95, minSlope: 0.72 },
      ],
      cliffColor: 0x9a8a70,   // karst stone: Liyue's pillars are the zone's silhouette
      grassColorA: 0x74a049, grassColorB: 0x4c6933,
      // Warmer and less blue than the default: Liyue's shadows fall on limestone.
      shadowTint: 0x7b7f98,
    },
    water: { level: 2.2, color: 0x517c99, deepColor: 0x233949, foam: 0xa8e0f0 },
    props: {
      trees: { density: 0.0006, kinds: ['bamboo', 'oak'], minH: 3.5, maxSlope: 0.42, scale: [0.9, 1.6] },
      rocks: { density: 0.0011, scale: [0.7, 4.0] },
      grass: { density: 2.7, maxSlope: 0.48, height: [0.24, 0.47] },
      flowers: { density: 0.018, kinds: ['qingxin', 'sweetFlower'] },
      ruins: { count: 8, kind: 'pagoda' },
      lanterns: { count: 24 },
    },
    spawns: [
      { at: [50, 30], enemies: ['geoVishap'], level: 36, radius: 12, respawn: 240, elite: true },
      // Moved off the shoreline: at [-80, 70] the camp stood in a metre of water.
      { at: [-68, 78], enemies: ['abyssMage', 'abyssMage', 'hilichurlPyro'], level: 40, radius: 13, respawn: 180 },
      { at: [130, -70], enemies: ['ruinGuard', 'ruinGuard'], level: 46, radius: 16, respawn: 300, elite: true },
      { at: [-150, -110], enemies: ['geoVishap', 'geoVishap'], level: 50, radius: 15, respawn: 300, elite: true },
      { at: [180, 150], enemies: ['abyssHerald'], level: 55, radius: 18, respawn: 600, boss: true },
    ],
    gathers: [
      { kind: 'qingxin', count: 22, perCluster: 3 },
      { kind: 'sweetFlower', count: 18, perCluster: 4 },
      { kind: 'wheat', count: 24, perCluster: 6 },
      { kind: 'mushroom', count: 18, perCluster: 4 },
      { kind: 'whiteIronChunk', count: 18, perCluster: 3, prop: 'oreNode', color: 0xb8bcc4, maxSlope: 0.95 },
      { kind: 'crystalChunk', count: 10, perCluster: 2, prop: 'oreNode', color: 0x9fd8ee, maxSlope: 0.95 },
    ],
    poi: [
      { id: 'ly_wp1', type: 'waypoint', at: [0, 0], name: '望舒客栈' },
      { id: 'ly_wp2', type: 'waypoint', at: [140, -100], name: '归离原' },
      { id: 'ly_wp3', type: 'waypoint', at: [-160, 130], name: '琉璃亭' },
      { id: 'ly_chest1', type: 'chest', at: [64, 42], tier: 'precious' },
      { id: 'ly_chest2', type: 'chest', at: [-120, -80], tier: 'luxurious' },
      { id: 'ly_puzzle1', type: 'puzzle', at: [90, 90], kind: 'elementalMonument', element: 'earth', count: 3, name: '岩之试炼' },
      { id: 'ly_puzzle2', type: 'puzzle', at: [-60, -30], kind: 'lightUpPillars', count: 5, name: '古老的石灯' },
      { id: 'ly_dungeon', type: 'dungeon', at: [200, -200], target: 'goldenHall', name: '黄金屋遗迹' },
      { id: 'ly_statue', type: 'statue', at: [12, -14], element: 'earth', name: '七天神像' },
    ],
    npcs: [
      { id: 'merchant', at: [4, 8], name: '商人石头', role: 'shop', shop: 'liyueMarket', lines: [
        '客人，看看货？璃月的东西，别处买不到。',
        '价钱是实价，摩拉一分不多收。',
      ] },
      { id: 'adeptus', at: [-10, -6], name: '仙人使者', role: 'quest', quest: 'q_liyue', lines: [
        '凡人，你身上有岩之力的气息。',
        '群峰之间有仙家旧事待了，可愿一听？',
      ] },
    ],
  },

  abyssTrial: {
    id: 'abyssTrial',
    name: '深渊试炼场',
    subtitle: '螺旋深境',
    seed: 133700,
    size: 130,
    kind: 'dungeon',
    levelRange: [15, 90],
    recommendedLevel: 20,
    entryRank: 1,
    music: 'abyss',
    weather: { type: 'none', windSpeed: 0.4, cloudiness: 0 },
    indoor: true,
    sky: {
      // Light comes down the shaft, so the "sun" is near-vertical and weak; the
      // braziers and the rune inlay carry the rest.
      sunDir: [0.1, 0.94, 0.2], sunColor: 0x9fb0e8, sunIntensity: 0.8,
      ambientSky: 0x46467e, ambientGround: 0x22223a, ambientIntensity: 0.85,
      fogColor: 0x14142a, fogDensity: 0.013,
      rayleigh: 0.3, turbidity: 12, exposure: 1.2,
      vaultColor: 0x241f42, vaultGlow: 0x7a5ad0,
    },
    terrain: {
      octaves: 3, scale: 0.012, height: 4, ridgeMix: 0.1, ridgeScale: 0.02,
      plateau: 0.8, cliffPower: 1.0, arena: { radius: 52, wall: 14 },
      // Rune light, not floor stone. 0x7a68c8 was a violet 6/20/32 counts from this floor's own
      // 0x807ca8 albedo, so `tools/inlay-cam.mjs` metered the rings 15 counts from the stone
      // beside them at the authored strength — a pattern that was computed, mixed, tone-mapped
      // and then invisible. Pale cyan is the one hue this room does not already own (violet
      // stone, violet vault glow, warm braziers) and it is the colour of the crystals growing
      // out of the same floor, so the rings read as the ley lines the sky block calls them.
      inlayColor: 0xa8dcf0,
      biomes: [
        // Raised off near-black twice. At 0x2a2a44 under this ambient the floor rendered as
        // a void and the character had nothing to stand on; 0x3a3a5c fixed the void but not
        // the flatness. Measured at 0x3a3a5c the near floor was lum 27 with std 2.8 and
        // p5..p95 of 24..32 — the whole flagstone pattern (joints, per-slab tone, veining,
        // grit) was being computed and then crushed into eight sRGB counts at the *bottom* of
        // the tone curve, the mirror image of 龙脊雪山's snow sitting on the shoulder. Driving
        // the same frame's uDetail to 3 raised std to 6.3 and driving exposure to 2.2 raised
        // it to 4.2, but only the albedo moved it without changing the whole hall: at the
        // value below the floor reads lum ~85 and std ~5.5 with everything else untouched.
        // A dark hall is the art direction; a floor whose texture cannot survive its own
        // albedo is not. See the ground assertion in tools/tour.mjs.
        { key: 'abyssFloor', color: 0x807ca8, rough: 0.6, maxSlope: 1, maxHeight: 999 },
        { key: 'abyssEdge',  color: 0x413e60, rough: 0.7, minSlope: 0.4 },
        { key: 'rune',       color: 0x6a5ab0, rough: 0.3, maxHeight: 999 },
        { key: 'abyssRock',  color: 0x393356, rough: 0.85, minSlope: 0.5 },
      ],
      cliffColor: 0x2a2648,
      // Rings, spokes and medallion at the shared default. The strength is not what decides
      // whether the pattern is visible — the distance between `inlayColor` and the floor's own
      // albedo is (see the note on it above) — and 0.45 is what keeps a pale trim off the bloom
      // threshold while still lifting the rings clear of the stone. Measured by
      // tools/inlay-cam.mjs, which bounds both ends.
      inlayStrength: 0.45,
      shadowTint: 0x5f6aa0,
    },
    water: { level: -99, color: 0x2a1f4a, deepColor: 0x100a20, foam: 0x8a6ad0 },
    props: {
      rocks: { density: 0.0006, scale: [0.6, 2.4] },
      crystals: { density: 0.0018, color: 0xb46cff },
      ruins: { count: 12, kind: 'abyssPillar' },
      braziers: { count: 16 },
      // The wall of the room. `heightAt` already ramps the height field 44 m up
      // outside the arena, but that is unlit terrain at the fog line: from inside,
      // all three dungeons photographed as an endless plane with haze at the edge.
      // `span` is not read from here — `World._buildEnclosure` derives the real span
      // from the segment count so the ring closes exactly — it only picks the count.
      enclosure: { kind: 'abyssArch', span: 8.2, inset: 2.2 },
      // The lid. `tools/vault-cam.mjs` pitched the gameplay camera up to its own clamp
      // and found the terrain ramp, not the vault shader, filling the top of every
      // dungeon frame — so the ceiling is geometry now (`buildVaultCeiling`), and only
      // its *style* lives here: `World._buildCeiling` derives the radius and the
      // springing height from the arena and the wall module so they cannot disagree.
      // A black vault crossed by glowing veins, which is what the runes are for. The
      // colour is measured, not chosen: at 0x6f68a8 the crown metered luma 31.3 against a
      // 21.6 fog and a 23.6 horizon, i.e. the ceiling was the *brightest* thing in the
      // room and the arena read as dusk outdoors. 0x3a3558 with a 0.46 crown lands it
      // near 14 — clear of the fog on the dark side, which is the only side this zone has.
      ceiling: {
        style: 'rune', rise: 10, ribs: 14, pendants: 12, pendantScale: 0.9, bump: 0.9,
        crownShade: 0.46, rockColor: 0x3a3558, trimColor: 0x4a4372, glowColor: 0xb46cff,
        shadowColor: 0x4a3f80,
      },
    },
    domain: { sets: ['gladiator', 'emberCrown', 'windSong'], mats: ['abyssalCrystal', 'chaosDevice', 'chaosCore'] },
    // Floor 1 has no disorder on purpose: it is where a player learns what a chamber is.
    // From floor 2 on, every floor asks a different question — see `disorders.js`.
    chambers: [
      { floor: 1, level: 18, timeLimit: 90, stars: [50, 35, 25],
        waves: [['hilichurl', 'hilichurl', 'slimeWater'], ['slimeFire', 'hilichurlArcher']] },
      { floor: 2, level: 24, timeLimit: 120, stars: [80, 55, 40], disorder: 'frostVein',
        waves: [['frostWolf', 'frostWolf'], ['hilichurlArcher', 'hilichurlPyro', 'hilichurl']] },
      { floor: 3, level: 32, timeLimit: 180, stars: [120, 85, 55], disorder: 'emberVein',
        waves: [['hilichurlPyro', 'hilichurlPyro'], ['abyssMage', 'abyssMage']] },
      { floor: 4, level: 40, timeLimit: 210, stars: [145, 100, 65], disorder: 'stoneVein',
        waves: [['frostWolf', 'frostWolf', 'frostWolf'], ['ruinGuard']] },
      { floor: 5, level: 50, timeLimit: 120, stars: [75, 50, 35], disorder: 'galeVein',
        waves: [['slimeElectro', 'slimeElectro', 'hilichurlArcher'], ['geoVishap', 'abyssMage']] },
      { floor: 6, level: 60, timeLimit: 360, stars: [255, 175, 120], disorder: 'emberVein', boss: true,
        waves: [['hilichurlPyro', 'hilichurlPyro', 'slimeFire'], ['abyssHerald']] },
      { floor: 7, level: 70, timeLimit: 210, stars: [140, 95, 65], disorder: 'galeVein',
        waves: [['ruinGuard', 'ruinGuard'], ['geoVishap', 'geoVishap']] },
      // The deepest floor in the game gets the only three-wave shape: adds, a guard, then
      // the tyrant — so the last fight is a run, not a health bar.
      { floor: 8, level: 80, timeLimit: 570, stars: [430, 295, 200], disorder: 'stormVein', boss: true,
        waves: [['abyssMage', 'abyssMage', 'slimeElectro'], ['ruinGuard'], ['stormTyrant']] },
    ],
    poi: [
      { id: 'ab_entry', type: 'waypoint', at: [0, 44], name: '入口' },
      { id: 'ab_reward', type: 'chest', at: [0, -40], tier: 'luxurious', requires: 'clear' },
    ],
    npcs: [
      // Stands by the entry waypoint, not in the arena: he is the reason a chamber run
      // has an exit for its materials, and a player should meet him on the way in.
      { id: 'ab_trader', at: [7, 40], name: '兜帽人', role: 'shop', shop: 'abyssTrader', lines: [
        '……你从下面上来的。',
        '深渊里的东西，我收。别问我从哪来。',
      ] },
    ],
    spawns: [],
    exit: { zone: 'mondstadt', at: [190, 190] },
  },

  frostCavern: {
    id: 'frostCavern',
    name: '冰封洞窟',
    subtitle: '寒霜之底',
    seed: 445566,
    size: 150,
    kind: 'dungeon',
    levelRange: [25, 50],
    recommendedLevel: 30,
    entryRank: 5,
    music: 'cavern',
    indoor: true,
    weather: { type: 'none', windSpeed: 0.6, cloudiness: 0 },
    mechanic: { sheerCold: true, coldRate: 4.5, warmRadius: 10 },
    sky: {
      // A cave lit down a shaft, not a snowfield at noon. At 0.85/0.8 over a 0xc8e4f2
      // floor the ice metered at luma 199 with a std of 6.2 — brighter than Mondstadt's
      // sunlit grass (132) and flatter than bare rock, so the zone photographed as a
      // white plain and no brazier's light pool could show against it.
      sunDir: [0.2, 0.9, 0.3], sunColor: 0xc8e8ff, sunIntensity: 0.6,
      ambientSky: 0x6a90b8, ambientGround: 0x2a3a4a, ambientIntensity: 0.62,
      // The haze of a cave is its own rock receding, so it cannot be brighter than the
      // shell overhead — and this one was, by 1.77x (fog 0x6b8fa8 luma 137 against
      // vaultColor 0x3e5064 luma 78). What that bought, measured off tools/tour.mjs's
      // gameplay frames: the band above the wall ring metered rgb [96,139,170] — the fog
      // colour to within 3 counts — at luma 127 against a ceiling of 82 and a near floor
      // of 172. So a room with a real lid (tools/vault-cam.mjs proves it: hiding the
      // ceiling group moves that band 18 counts, hiding the height field moves it 2)
      // still photographed as an open snowfield under a blue sky, because everything the
      // player sees at eye level beyond ~60 m is 90% fog and the fog was daylight.
      // 0x2c3f52 is the same cold hue at luma 60, i.e. 0.78 of the vault — the ratio the
      // two dungeons that already read as interiors have (深渊 0.62, 黄金屋 0.73), and now
      // a rule in zoneGate.js rather than three independent judgements.
      fogColor: 0x2c3f52, fogDensity: 0.013,
      rayleigh: 1.0, turbidity: 8, exposure: 1.1,
      vaultColor: 0x3e5064, vaultGlow: 0x8fd8ff,
    },
    terrain: {
      octaves: 4, scale: 0.011, height: 10, ridgeMix: 0.4, ridgeScale: 0.018,
      plateau: 0.5, cliffPower: 1.6, arena: { radius: 62, wall: 18 },
      // Meltwater channels cut into the ice, which is the only way an ice floor can carry a
      // pattern: 0x8ec0da was (142,192,218) against an ice albedo of (156,192,212) — the same
      // colour, one channel 14 counts apart — and tools/inlay-cam.mjs found 9998 pixels moving
      // when the whole pattern was switched off, most of them dither. Contrast has to go *down*
      // here (a brighter trim on ice has nowhere to go but white), so this is the zone's own
      // deep-ice hue pushed a step darker and bluer than `deepIce`.
      inlayColor: 0x2f6f96,
      biomes: [
        // Pulled down with the lighting: ice is the brightest thing a cave has, but at
        // 0xc8e4f2 under any ambient at all it lands within a few counts of white, and a
        // surface with no headroom left cannot show detail, a shadow or a firelight pool.
        { key: 'ice',   color: 0x9cc0d4, rough: 0.2, maxSlope: 0.6, maxHeight: 999 },
        { key: 'rock',  color: 0x4a5464, rough: 0.9, minSlope: 0.6 },
        { key: 'snow',  color: 0xcadeeb, rough: 0.7, maxHeight: 999 },
        { key: 'deepIce', color: 0x74a2bc, rough: 0.15, minSlope: 0.3 },
      ],
      cliffColor: 0x4a5464,
      inlayStrength: 0.45,      // dark trim, so the ceiling of this one is texture, not bloom
      shadowTint: 0x7f9cc0,
    },
    water: { level: -99, color: 0x3a5b71, deepColor: 0x202f40, foam: 0xd8f0ff, frozen: true },
    props: {
      // Densest scatter of any zone: a cavern has to feel enclosed and cluttered, and
      // at the old densities a 62 m arena held ~14 rocks and one spire cluster, which
      // looked like a snowfield rather than a cave.
      rocks: { density: 0.0024, scale: [0.6, 3.2], snowy: true },
      crystals: { density: 0.0055, color: 0x8fe3f0 },
      ruins: { count: 12, kind: 'iceSpire' },
      braziers: { count: 14 },
      // Narrower spans than the other two, and three variants: a cave wall is broken
      // up, so repeating one module identically around the ring would read as built.
      // `wallColor`: the rock, one step lighter than the ceiling's 0x64768a because the wall
      // is what the player stands next to. On the generic `stoneDark` the curtain photographed
      // at rgb [24,34,50], p5..p95 31..37 — a navy sheet of paper in a room whose floor
      // measures 166-182 (tools/prop-check.mjs, and see MATS.caveWall for why no amount of
      // mottle or light could have reached it).
      enclosure: { kind: 'iceCurtain', span: 7.0, inset: 2.0, variants: 3, wallColor: 0x7b8b9e },
      // A cave roof, so: the strongest lobes of the three (`bump`), ribs that wander,
      // and stalactites in the ice material to meet the stalagmites on the floor.
      // 0x8a9db2 metered 90 against fogged terrain at 85, i.e. a lid present and
      // invisible, so the shell is this darker grey-blue: it measures 82 in the up-shot
      // against a near floor of 165. It reads *above* the haze now rather than below it
      // (fog went 137 -> 60, see `sky.fogColor`), and 22 counts apart in a different
      // hue is a ceiling line either way round.
      ceiling: {
        style: 'cave', rise: 12, ribs: 9, pendants: 26, bump: 1.5,
        crownShade: 0.36, rockColor: 0x64768a, trimColor: 0x4a5c6e, glowColor: 0x8fd8ff,
        shadowColor: 0x5f7f9c,
      },
    },
    domain: { sets: ['frostveil', 'tidebound'], mats: ['wolfClaw', 'damagedMask', 'chaosDevice'] },
    chambers: [
      { floor: 1, level: 28, timeLimit: 150, stars: [95, 65, 45], disorder: 'frostVein',
        waves: [['frostWolf', 'frostWolf'], ['frostWolf', 'frostWolf', 'slimeWater']] },
      { floor: 2, level: 34, timeLimit: 150, stars: [105, 75, 50], disorder: 'galeVein',
        waves: [['hilichurlArcher', 'hilichurlArcher', 'slimeElectro'], ['abyssMage', 'abyssMage']] },
      { floor: 3, level: 42, timeLimit: 240, stars: [165, 115, 80], disorder: 'frostVein', boss: true,
        waves: [['frostWolf', 'frostWolf', 'frostWolf'], ['ruinGuard', 'frostWolf']] },
    ],
    poi: [
      { id: 'fc_entry', type: 'waypoint', at: [0, 50], name: '洞窟入口' },
      { id: 'fc_warm', type: 'warmth', at: [0, 30], name: '篝火' },
      { id: 'fc_reward', type: 'chest', at: [0, -46], tier: 'luxurious', requires: 'clear' },
    ],
    npcs: [], spawns: [],
    exit: { zone: 'dragonspine', at: [-170, 170] },
  },

  goldenHall: {
    id: 'goldenHall',
    name: '黄金屋遗迹',
    subtitle: '磐岩的回响',
    seed: 246810,
    size: 160,
    kind: 'dungeon',
    levelRange: [45, 90],
    recommendedLevel: 55,
    // 18, not 10: `arCap` caps character level at `20 + rank * 2`, so rank 10 lets the
    // player in with a level-40 ceiling against a level-55 first floor — a fight they
    // are not permitted to be strong enough to win (margin 0.93x, `tools/balance-check.mjs`).
    // Rank 18 gives a cap of 56, just clearing this dungeon's recommendation.
    entryRank: 18,
    music: 'ruins',
    indoor: true,
    weather: { type: 'none', windSpeed: 0.3, cloudiness: 0 },
    sky: {
      // A buried hall, not a courtyard: the shaft light is near-vertical and much
      // weaker than the 1.4 it used to be, which was bright enough to read as noon.
      sunDir: [0.2, 0.92, 0.15], sunColor: 0xffdca0, sunIntensity: 0.85,
      // Desaturated on purpose: a fully gold ambient painted the stone walls the same
      // orange as the floor, so the room had one colour and no depth.
      ambientSky: 0x9a8558, ambientGround: 0x3a2a18, ambientIntensity: 0.8,
      fogColor: 0x3e2a16, fogDensity: 0.012,
      rayleigh: 0.8, turbidity: 10, exposure: 1.12,
      vaultColor: 0x453c30, vaultGlow: 0xff9a4c,
    },
    terrain: {
      octaves: 3, scale: 0.013, height: 6, ridgeMix: 0.2, ridgeScale: 0.02,
      plateau: 0.7, cliffPower: 1.2, arena: { radius: 66, wall: 20 },
      // Jade, not gold. The rings, spokes and centre medallion are mixed into the floor at
      // 0.45 (`uInlayColor` in gfx/terrain.js, and the same constant bakes the minimap in
      // ui/mapview.js), so a gold inlay on a gold floor is a pattern that exists in the
      // data and not on the screen — the first tour of this hall showed a 130 m disc of one
      // tone. A dark green-blue survives the 0.45 mix as a *darker* band, which is the half
      // of the contrast that a gold sun and a gold ambient cannot wash out.
      // Not the 0x2c6f5e this started as: `tools/gamut-check.mjs 2c6f5e` reports red clamped
      // to 0 at three of five light levels, which is the one defect no shading parameter can
      // undo. 0x40796a is the same jade with the saturation ACES will actually carry.
      inlayColor: 0x40796a,
      biomes: [
        { key: 'goldFloor', color: 0x8a6a34, rough: 0.5, maxSlope: 1, maxHeight: 999 },
        { key: 'goldTrim',  color: 0xd8b060, rough: 0.3, minSlope: 0.35 },
        { key: 'stone',     color: 0x6a5a44, rough: 0.9, minSlope: 0.6 },
        // The fourth biome is the one the flat floor actually shows. `goldFloor` allows any
        // slope and any height, so it wins the splat everywhere inside the arena and the
        // only second colour on the ground is the `uColD` "bare earth" term, which mixes
        // this entry in at up to 0.62 over a ~48 m mask (gfx/terrain.js). While it was
        // `ember` 0xa8703c that term was gold-on-gold too, i.e. the floor had exactly one
        // colour. Verdigris on a buried bronze-and-gilt floor is the same argument as the
        // jade inlay above, at the scale of a patch rather than a band.
        { key: 'patina',    color: 0x4e6154, rough: 0.7, maxHeight: 999 },
      ],
      // Grey stone walls around a gold floor. Defaulting to the fourth biome painted the
      // walls the same orange as the ground and made the hall read as an open desert.
      cliffColor: 0x6a5a44,
      // The one zone that can afford a strong inlay, and the reason this stopped being a
      // constant in the shader. 0.45 exists because a *bright* trim colour at full strength
      // flares — but 0x40796a is a dark jade with a luma of 0.42 against this gold floor's
      // 0.76, so mixing it in harder only ever makes the bands *darker*, which is the half
      // of the contrast a gold sun and a gold ambient cannot wash out (see the note on
      // `inlayColor` above). Bloom cannot be fed by a colour below the floor it replaces.
      inlayStrength: 0.72,
      // Cool, against a hall lit entirely by gold. `shadowCol = base * uShadowTint`, so this
      // is the one place a second hue can reach a surface whose albedo, sun and ambient are
      // all the same colour — the shaded side of every column now reads slate rather than
      // dimmer gold.
      shadowTint: 0x6f7690,
    },
    water: { level: -99, color: 0x8a6a34, deepColor: 0x3a2a14, foam: 0xffd898 },
    props: {
      // Rubble, not boulders. `scale` is a multiplier on a recipe about 4 m across, so 2.8
      // put a ten-metre outdoor crag inside a built hall — the first tour caught one taller
      // than the player standing in the middle of the floor and clipping a column. Fallen
      // masonry from a collapsed ceiling is what a ruin has on its floor, and at 1.15 the
      // same prop reads as exactly that. Slightly denser to compensate for being small.
      rocks: { density: 0.0011, scale: [0.45, 1.15] },
      // Geo crystal breaking up through the flagstones — 磐岩的回响, and the only *emissive*
      // non-gold in the room, which is what a monochrome frame needs more than another
      // albedo. Sparse: this is a hall with crystal growing through it, not a cavern.
      crystals: { density: 0.0016, color: 0x7fd8b0 },
      ruins: { count: 16, kind: 'goldPillar' },
      braziers: { count: 24 },
      lanterns: { count: 12 },
      // `wallColor`: cinnabar lacquer over the lower storey. See MATS.lacquer — the whole
      // room was gold or `stonePale`, and 0xbdb6a4 under a 0xffdca0 sun is gold as well.
      enclosure: { kind: 'goldArcade', span: 8.6, inset: 2.6, wallColor: 0x9c4a34 },
      // A built ceiling, not a dug one: shallow rise, almost no lobing, gilt ribs and a
      // coffer with a lamp in every bay between them.
      // The one ceiling that is brighter than its fog rather than darker: a hall of dressed
      // stone over a 44.8-luma brown haze, metered at 60 with the braziers below it — so
      // `rockColor` stays where it is, because that margin is thin and a dark shell here
      // disappears into the haze instead of reading as a lid.
      // `crownShade` is the other knob and it does not have that problem: it darkens the
      // *crown*, which is overhead and near, while the springing — the ring that sits at the
      // fog line — keeps the albedo. At 0.72 there was no dark region anywhere in the frame;
      // 0.48 puts the anchor directly over the arena, where the eye already is. 深渊试炼场
      // runs 0.46 and 冰封洞窟 0.36, both of which photograph as rooms.
      ceiling: {
        style: 'coffer', rise: 9, ribs: 14, pendants: 8, pendantScale: 0.7, bump: 0.5,
        crownShade: 0.48, rockColor: 0xb5a88f, trimColor: 0xc59a4c, glowColor: 0xffca7a,
        shadowColor: 0x9a7a4c,
      },
    },
    domain: { sets: ['stoneheart', 'thunderCall', 'dawnHymn'], mats: ['vishapScale', 'abyssalCrystal', 'chaosCore'] },
    chambers: [
      { floor: 1, level: 55, timeLimit: 210, stars: [140, 95, 65], disorder: 'stoneVein',
        waves: [['geoVishap'], ['geoVishap', 'abyssMage']] },
      { floor: 2, level: 65, timeLimit: 270, stars: [190, 130, 90], disorder: 'emberVein',
        waves: [['ruinGuard', 'ruinGuard'], ['abyssMage', 'abyssMage']] },
      { floor: 3, level: 80, timeLimit: 570, stars: [430, 295, 200], disorder: 'stormVein', boss: true,
        waves: [['ruinGuard', 'ruinGuard', 'geoVishap'], ['stormTyrant']] },
    ],
    poi: [
      { id: 'gh_entry', type: 'waypoint', at: [0, 54], name: '大门' },
      { id: 'gh_reward', type: 'chest', at: [0, -50], tier: 'luxurious', requires: 'clear' },
    ],
    npcs: [], spawns: [],
    exit: { zone: 'liyue', at: [200, -200] },
  },
};

export const ZONE_IDS = Object.keys(ZONES);
export const OPEN_ZONE_IDS = ZONE_IDS.filter((z) => ZONES[z].kind === 'open');

/**
 * What an NPC's `role` slug is called on screen.
 *
 * The slugs are data ('forge', 'guild'), and they have now been printed raw in two different
 * places: the dialogue header once introduced 凯瑟琳 as 「凯瑟琳 · guild」, and the interaction
 * prompt's subtitle did the same thing for another year because the fix lived as a private table
 * inside `panels.js`. So the table sits next to the NPCs it names, both callers read it, and
 * `zoneGateReport()` checks it both ways — an NPC with a role nobody translated prints English,
 * and a translation no NPC carries is copy for a role that does not exist.
 */
export const NPC_ROLES = Object.freeze({
  guild: '冒险家协会', forge: '铁匠', quest: '委托', shop: '商人',
});

export function npcRoleName(role) { return NPC_ROLES[role] || ''; }

/* ---------------------------------------------------------------- chambers -- */

/**
 * Seconds between a wave dying and the next one spawning.
 *
 * Shared rather than local to the simulation because `tools/balance-check.mjs` has to
 * charge the run for it: the gaps are part of the clear time the star thresholds are
 * measured against, and a floor whose limit was derived without them is a floor whose
 * limit is wrong by (waves - 1) × this.
 */
export const CHAMBER_WAVE_GAP = 4;

/**
 * Every enemy a floor spawns, all waves flattened.
 *
 * `waves` is the *only* chamber shape — there is no `enemies` fallback here on purpose.
 * Two accepted shapes means every consumer (the gates, the loot-level cap, the xp audit,
 * the spawner) has to remember both, and the one that forgets reads an empty list and
 * agrees with everything.
 */
export function chamberEnemies(c) {
  return (c?.waves || []).flat();
}

/**
 * May this player start this floor right now — and if not, why not?
 *
 * The sequential-unlock rule was written **three** times (the WS gateway's
 * `START_CHAMBER`, `POST /api/world/chamber`, and 单机's `localSocket`) and read **zero**
 * times by the UI, which is exactly the wrong split: the three copies can drift from each
 * other, and the map panel's floor list happily offered all fourteen floors and then let
 * the server explain. A panel that offers a click the route is going to refuse is worse
 * than one that shows the lock — the same argument the locked teleport pin already makes.
 *
 * So the rule lives here, once, and both sides call it: the enforcers to refuse, the panel
 * to draw. The checks run in the order a player meets them and the *first* failure is the
 * one reported, because that is the one they can act on.
 *
 * `chamber` is the instance's live chamber block (`null` when nothing is running). Pass it
 * from anywhere that can see it; a caller that cannot (the clear-report route, which is not
 * starting anything) leaves it out and gets the other three checks. Every field it needs
 * comes off the *save* (`abyss`, `adventureRank`), never off the client's word.
 *
 * @param zone     zone definition (or id)
 * @param floor    floor number the player asked for
 * @param ctx      { adventureRank, abyss, chamber }
 * @returns {{ ok:boolean, error?:string, chamber?:object, need?:number,
 *             prevFloor?:number, runningFloor?:number }}
 */
export function chamberEntry(zone, floor, ctx = {}) {
  const zdef = typeof zone === 'string' ? ZONES[zone] : zone;
  const f = Number(floor);
  if (!zdef || zdef.kind !== 'dungeon') return { ok: false, error: 'not_a_dungeon' };
  const def = (zdef.chambers || []).find((c) => c.floor === f);
  if (!def) return { ok: false, error: 'no_such_chamber' };
  if (!canEnterZone(zdef, ctx.adventureRank ?? 0)) {
    return { ok: false, error: 'rank_too_low', need: zoneEntryRank(zdef), chamber: def };
  }
  if (f > 1 && !((ctx.abyss?.[zdef.id]?.[f - 1] || ctx.abyss?.[zdef.id]?.[String(f - 1)])?.stars > 0)) {
    return { ok: false, error: 'previous_floor_locked', prevFloor: f - 1, chamber: def };
  }
  // `startChamber` *is* the reset, so a live run must not be restarted by anyone — in co-op
  // that is somebody else's eightieth second. The simulation refuses this too; this copy is
  // what lets the panel grey the row out instead of inviting the click.
  if (ctx.chamber?.state === 'running') {
    return { ok: false, error: 'chamber_in_progress', runningFloor: ctx.chamber.floor, chamber: def };
  }
  return { ok: true, chamber: def };
}

/**
 * How many stars a clear in `time` seconds is worth.
 *
 * Written three times before this existed — the WS gateway's `zoneInstance` (which decides
 * what the run report says), `POST /api/world/chamber` (which decides what a 单机 player is
 * paid) and `tools/balance-check.mjs` (which decides whether the thresholds are reachable at
 * all). Three copies of a comparison chain is how a floor ends up paying for a time its own
 * report called two stars.
 *
 * `stars` is a descending list of seconds: `[1★, 2★, 3★]`. A time *equal* to a threshold earns
 * it — the boundary is inclusive, which is the only reading a player can act on ("三星 25s"
 * means 25.0 is three stars), and the reason `chamber-check` pins both sides of every one.
 */
export function chamberStars(chamber, time) {
  const thr = chamber?.stars;
  if (!Array.isArray(thr) || thr.length !== 3 || !(time >= 0)) return 0;
  if (time <= thr[2]) return 3;
  if (time <= thr[1]) return 2;
  if (time <= thr[0]) return 1;
  return 0;
}

/** Full mora for taking a floor from nothing to three stars. Steeper floors pay more. */
export function chamberMoraFull(floor) { return 8000 + Number(floor) * 2000; }

/** How many stars a floor is worth in total — the denominator every milestone is a share of. */
export const CHAMBER_MAX_STARS = 3;

/**
 * What a clear *newly earns*, denominated in stars.
 *
 * The rule this replaces paid `gained * 20` primogems (per star, correct) alongside a full
 * `8000 + floor * 2000` mora and a full `chamberXp(level)` **per improvement** — so a player
 * who cleared floor 8 slowly three times, at one star then two then three, was paid three
 * times 24 000 mora and three whole clears of party xp for one floor. Nobody authored that
 * faucet; it is what happens when a reward for *progress* is priced per visit.
 *
 * So every part is a share of the floor's own total, and the share is taken by **running
 * total** rather than per-star rounding: `part(k) = round(total * k / 3)`, and a step from
 * `prev` to `stars` is paid `part(stars) - part(prev)`. Any path from 0 to 3 — one clear, or
 * three — sums to exactly what one three-star clear pays, and the arithmetic can be checked
 * by a probe without knowing which path was taken (`parts must sum to the whole`).
 *
 * A clear that beats no record earns nothing: `gained` is 0 and the caller pays nothing at
 * all, which is what keeps the resin-bought drop as the only repeatable half of a run.
 */
export function chamberMilestone(chamber, prevStars = 0, stars = 0) {
  const floor = Number(chamber?.floor) || 0;
  const level = Number(chamber?.level) || floor * 8;
  const from = clamp(Number(prevStars) || 0, 0, CHAMBER_MAX_STARS);
  const to = clamp(Number(stars) || 0, 0, CHAMBER_MAX_STARS);
  const gained = Math.max(0, to - from);
  const empty = {
    gained: 0, primogem: 0, mora: 0, xp: { adventure: 0, party: 0 }, reward: {},
  };
  if (gained === 0) return empty;

  const full = chamberXp(level);
  const share = (total, k) => Math.round((total * k) / CHAMBER_MAX_STARS);
  const part = (total) => share(total, to) - share(total, from);
  const primogem = part(20 * CHAMBER_MAX_STARS);
  const mora = part(chamberMoraFull(floor));
  const xp = { adventure: part(full.adventure), party: part(full.party) };
  return { gained, primogem, mora, xp, reward: { primogem, mora } };
}

/* ---------------------------------------------------------------- terrain -- */

/** Radius of the flattened plaza around each open zone's origin, in metres. */
const HUB_R = 52;

/**
 * The noise part of the landscape, before hub/border/lake shaping. Split out so
 * the hub can flatten towards the terrain's own height at the origin instead of
 * a fixed number — pinning the centre to a constant turns a zone with real
 * relief into a crater with the player at the bottom of it.
 */
function rawHeight(zone, x, z) {
  const t = zone.terrain;
  const s = t.scale;
  let h = fbm2(x * s, z * s, { octaves: t.octaves, seed: zone.seed });

  // Base shaping: plateau bias flattens lowlands, cliffPower steepens highlands.
  h = Math.pow(h, t.cliffPower);
  h = lerp(h, smoothstep(h * 1.15), t.plateau);

  if (t.ridgeMix > 0) {
    const r = ridged2(x * t.ridgeScale, z * t.ridgeScale, { octaves: 4, seed: zone.seed + 991 });
    h = lerp(h, r, t.ridgeMix);
  }

  if (t.karst) {
    // Sharp vertical karst pillars: threshold ridged noise into towers.
    const p = ridged2(x * 0.016, z * 0.016, { octaves: 3, seed: zone.seed + 5501 });
    if (p > 0.62) h += (p - 0.62) * 2.6;
  }

  // baseShift drops the whole landscape so its lowlands reach the water plane:
  // without it a zone's minimum sits tens of metres above `water.level` and there
  // is no water anywhere in the world.
  return h * t.height - (t.baseShift || 0);
}

/**
 * Height of terrain at world x,z for a zone. Deterministic; shared by client
 * mesh generation, client movement, and server physics.
 */
export function heightAt(zone, x, z) {
  const t = zone.terrain;
  let y = rawHeight(zone, x, z);

  if (t.arena) {
    // Dungeon: flat floor inside radius, walls rising outside.
    const d = Math.hypot(x, z);
    const R = t.arena.radius;
    if (d < R) {
      y = y * 0.25 - 1.0;
    } else {
      const over = (d - R) / Math.max(1, t.arena.wall);
      y = y * 0.25 - 1.0 + Math.pow(clamp(over, 0, 1.6), 1.6) * 44;
    }
  } else {
    // Open zone: a plaza around the origin so the spawn, the statue and the
    // quest-givers all stand on level ground, mountains at the border to close
    // the view, and lake basins carved last so nothing else fills them in.
    const dHub = Math.hypot(x, z);
    if (dHub < HUB_R) {
      // Cached: it is one extra noise evaluation and the same value forever.
      if (t._hubY === undefined) t._hubY = rawHeight(zone, 0, 0);
      const k = smoothstep(dHub / HUB_R);
      y = lerp(t._hubY, y, k);
    }
    const half = zone.size / 2;
    const edge = Math.max(Math.abs(x), Math.abs(z));
    if (edge > half - 60) {
      const k = clamp((edge - (half - 60)) / 60, 0, 1);
      y = lerp(y, y + 90 * Math.pow(k, 1.7), k);
    }
    // Lakes: without a basin the water plane sits under the ground everywhere and
    // the whole swimming system is dead content.
    for (const l of t.lakes || []) {
      const d = Math.hypot(x - l.at[0], z - l.at[1]);
      if (d < l.radius) y = lerp(l.floor, y, smoothstep(d / l.radius));
    }
  }
  return y;
}

/** Surface normal via finite differences. */
export function normalAt(zone, x, z, eps = 0.9) {
  const hL = heightAt(zone, x - eps, z);
  const hR = heightAt(zone, x + eps, z);
  const hD = heightAt(zone, x, z - eps);
  const hU = heightAt(zone, x, z + eps);
  const nx = hL - hR;
  const nz = hD - hU;
  const ny = 2 * eps;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Slope 0 (flat) .. 1 (vertical). */
export function slopeAt(zone, x, z) {
  return 1 - normalAt(zone, x, z)[1];
}

export function biomeAt(zone, x, z) {
  const t = zone.terrain;
  const y = heightAt(zone, x, z);
  const slope = slopeAt(zone, x, z);
  for (const b of t.biomes) {
    if (b.minSlope !== undefined && slope < b.minSlope) continue;
    if (b.maxSlope !== undefined && slope > b.maxSlope) continue;
    if (b.maxHeight !== undefined && y > b.maxHeight) continue;
    if (b.minHeight !== undefined && y < b.minHeight) continue;
    return b;
  }
  return t.biomes[0];
}

/** Find a walkable position near a target (used for spawns & teleports). */
export function findWalkable(zone, x, z, maxSlope = 0.5, tries = 40, seed = 7) {
  const rand = new Rand(((zone.seed ^ Math.round(x * 31 + z * 17)) >>> 0) + seed);
  if (slopeAt(zone, x, z) <= maxSlope) return [x, heightAt(zone, x, z), z];
  for (let i = 0; i < tries; i++) {
    const a = rand.angle();
    const r = 2 + i * 1.4;
    const nx = x + Math.cos(a) * r;
    const nz = z + Math.sin(a) * r;
    if (slopeAt(zone, nx, nz) <= maxSlope) return [nx, heightAt(zone, nx, nz), nz];
  }
  return [x, heightAt(zone, x, z), z];
}

/* ------------------------------------------------------------ gather nodes -- */

const GATHER_CACHE = new Map();

/**
 * The gatherable nodes of a zone: plants and ore outcrops the player picks.
 *
 * Generated rather than authored — 100 hand-placed flowers per zone is data nobody
 * would keep correct — but generated *once* and cached, because a node's identity is
 * persistent state: the server stores "picked at" under `g:<id>` per player and
 * refuses a re-pick inside the regrow window. That means the id, the kind and the
 * position must be identical in the client that draws the node, the client that
 * clicks it, and the server that validates the click, on every process and forever
 * after. Hence: derived from the zone seed alone, with no dependence on view
 * distance, player position or wall-clock time.
 *
 * Nodes come in clusters. A uniform sprinkle of 24 flowers over a 420 m zone is one
 * per 7 000 m², which the player experiences as "there is nothing here"; four
 * clusters of six is the same count and reads as a meadow worth searching.
 */
export function gatherNodes(zone) {
  if (!GATHER_CACHE.has(zone.id)) GATHER_CACHE.set(zone.id, buildGatherNodes(zone));
  return GATHER_CACHE.get(zone.id);
}

function buildGatherNodes(zone) {
  const out = [];
  const water = zone.water?.level ?? -999;
  const half = zone.size / 2 - 16;
  const arena = zone.terrain?.arena;
  for (const g of zone.gathers || []) {
    // Seeded per kind, so adding a kind to a zone cannot shuffle the ids of the
    // kinds already there — which would silently hand players a fresh crop of
    // everything they had already picked.
    // Hashed over the whole kind name rather than its length: two kinds of equal name
    // length and equal count drew the same stream, which put two different gather nodes
    // at one spot. (Changing the seed does renumber existing nodes once, so a save's
    // picked-node timers land on different plants after this — a one-off, and preferable
    // to two harvestables sharing a position forever.)
    const rand = new Rand(((zone.seed ^ (hashStr(g.kind) + g.count * 31)) >>> 0) + 4211);
    const per = g.perCluster ?? 4;
    const clusters = Math.max(1, Math.ceil(g.count / per));
    let made = 0;
    // `spots` pins the first clusters. Everything else is random, but a zone that
    // hands the player nothing within sight of where they land teaches them the
    // mechanic does not exist.
    const spots = g.spots || [];
    for (let c = 0; c < clusters + spots.length && made < g.count; c++) {
      const pin = spots[c];
      const cx = pin ? pin[0] : rand.float(-half, half);
      const cz = pin ? pin[1] : rand.float(-half, half);
      const want = Math.min(g.count - made, per);
      for (let k = 0; k < want; k++) {
        const a = rand.angle();
        const r = rand.float(0.9, 4.6);
        const [wx, wy, wz] = findWalkable(
          zone, cx + Math.cos(a) * r, cz + Math.sin(a) * r, g.maxSlope ?? 0.45, 20, 3 + k,
        );
        // Underwater plants would be unreachable, and an ore node inside the arena
        // ring of a trial zone would sit in the middle of a boss fight.
        if (wy < water + 0.5) continue;
        if (arena && Math.hypot(wx, wz) > arena.radius - 4) continue;
        out.push({
          // Numbered *within the kind*, not across the whole list: with a global
          // index, adding a new gatherable to a zone renumbers every kind after it,
          // and every `g:<id>` a player had saved would silently point at a
          // different plant.
          id: `${g.kind}_${made}`,
          kind: g.kind,
          prop: g.prop ?? g.kind,
          color: g.color,
          x: wx, y: wy, z: wz,
        });
        made++;
      }
    }
  }
  return out;
}

/** One node by id, for server-side validation of a gather request. */
export function gatherNodeById(zone, id) {
  return gatherNodes(zone).find((n) => n.id === id) || null;
}

/* ---------------------------------------------------------------- puzzles -- */

/**
 * What each puzzle *is*.
 *
 * `poi.kind` and `poi.count` were authored on every puzzle in the game and read by nobody:
 * a puzzle was one click on one monument, and `kind: 'sealedFrost', count: 4` was a caption.
 * `zoneGate.js` is what caught it, and the honest fix is the one that makes the data true —
 * a puzzle is now `count` monuments standing in a ring, and it is solved when the last one
 * is lit. The kind decides what they look like and what the prompt calls them; the element
 * defaults per kind so `elementalMonument` is the only kind that needs `poi.element`.
 *
 * `radius` is the ring the monuments stand on, in metres. Wide enough to walk between (the
 * interact range is ~3 m and the camera boom is 6 m), tight enough that the whole puzzle is
 * one silhouette from outside.
 */
export const PUZZLE_KINDS = {
  elementalMonument: { name: '元素方碑', verb: '共鸣', radius: 7.5, element: null },
  sealedFrost: { name: '霜封碎片', verb: '融解', radius: 6.5, element: 'ice' },
  lightUpPillars: { name: '古老石灯', verb: '点亮', radius: 9.0, element: 'fire' },
};

const PUZZLE_CACHE = new Map();

/**
 * The monuments of one puzzle, in ring order.
 *
 * Same contract as `gatherNodes`: the ids and positions are state the server validates a
 * click against, so they are derived from the zone seed and the poi id alone and must be
 * identical in every process forever. `#0`-style ids keep the puzzle's own id as their prefix,
 * which is what lets `world_progress` store them beside it under a `p:` key without either
 * one being mistaken for the other (the achievement snapshot tells records apart by payload —
 * a monument writes `{lit}`, never `{solved}`).
 */
export function puzzleNodes(zone, poi) {
  const key = `${zone.id}:${poi.id}`;
  if (!PUZZLE_CACHE.has(key)) PUZZLE_CACHE.set(key, buildPuzzleNodes(zone, poi));
  return PUZZLE_CACHE.get(key);
}

function buildPuzzleNodes(zone, poi) {
  const def = PUZZLE_KINDS[poi.kind] || PUZZLE_KINDS.elementalMonument;
  const n = Math.max(1, poi.count ?? 1);
  const [cx, cz] = poi.at;
  const rand = new Rand(((zone.seed ^ hashStr(poi.id)) >>> 0) + 811);
  // A ring, not a scatter: the player has to be able to see how many are left from the
  // middle, and a random spread over 9 m turns "light four monuments" into "search a field".
  const phase = rand.float(0, Math.PI * 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const r = def.radius * (n === 1 ? 0 : 1);
    const [x, y, z] = findWalkable(zone, cx + Math.cos(a) * r, cz + Math.sin(a) * r, 0.5, 24, 5 + i);
    out.push({
      id: `${poi.id}#${i}`,
      puzzleId: poi.id,
      index: i,
      element: def.element ?? poi.element ?? 'wind',
      x, y, z,
      // Face the middle, so a ring of monuments reads as one arrangement.
      rot: Math.atan2(cx - x, cz - z),
    });
  }
  return out;
}

/** One monument by id, for server-side validation of a puzzle click. */
export function puzzleNodeById(zone, poi, id) {
  return puzzleNodes(zone, poi).find((n) => n.id === id) || null;
}

/** How many monuments of a puzzle the player has already lit, from their world progress. */
export function puzzleLitCount(zone, poi, zoneProgress = {}) {
  return puzzleNodes(zone, poi).filter((n) => zoneProgress[`p:${n.id}`]?.lit).length;
}

export function zoneById(id) {
  return ZONES[id] || ZONES.mondstadt;
}

/**
 * Adventure rank required to enter a zone. Single source of truth for the WS
 * gateway and the REST teleport route so the two can never disagree.
 * Starter areas and the first dungeon are open from AR 1.
 */
export function zoneEntryRank(zone) {
  if (!zone) return 1;
  if (zone.entryRank !== undefined) return zone.entryRank;
  return Math.max(1, Math.floor((zone.recommendedLevel - 1) / 4));
}

export function canEnterZone(zone, adventureRank) {
  return adventureRank >= zoneEntryRank(zone);
}

/**
 * Resin one 秘境 run charges for its drop (`domain` on the three dungeon zones).
 *
 * Chests are the only other source of artifacts and they are one-shot per POI
 * (`world_progress` remembers them), so before this the 5-slot / 8-set artifact system
 * ran dry the moment the map was emptied and there was nothing left to farm. Repeat
 * clears fix that, which immediately needs a limiter — and resin was already in the
 * schema, already regenerating 1 per 8 min to a cap of 160, already drawn in the HUD,
 * and spent on nothing whatsoever. 20 per run is 8 runs from a full bar and 9 more a
 * day from regen; the star milestones stay one-time, so the resin buys drops, not
 * progress that could be earned twice.
 */
export const DOMAIN_RESIN = 20;

export const CHEST_TIERS = {
  common:    { mora: [800, 1600], primogem: 0, rolls: 1, color: 0x8a7a5a, artifactChance: 0.15 },
  exquisite: { mora: [2000, 3600], primogem: 2, rolls: 2, color: 0xb0965c, artifactChance: 0.45 },
  precious:  { mora: [4500, 7000], primogem: 5, rolls: 3, color: 0xd8b060, artifactChance: 0.8 },
  luxurious: { mora: [9000, 14000], primogem: 10, rolls: 4, color: 0xffd15c, artifactChance: 1.0, weaponChance: 0.4 },
};
