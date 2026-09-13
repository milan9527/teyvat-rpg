// Enemy archetypes: stats, AI behaviour params, procedural model recipe, loot table.
//
// Every key in here is declared, with the function that reads it, in `data/enemyGate.js`,
// and `tools/enemy-check.mjs` fails on a key with no consumer as well as on a declaration
// no enemy uses. That gate exists because this file had both: `weakspot` described a 3×
// multiplier nothing multiplied, and `pack: 3` a group size nothing grouped.

export const AI = {
  melee: 'melee',
  ranged: 'ranged',
  charger: 'charger',
  caster: 'caster',
  flyer: 'flyer',
  boss: 'boss',
};

export const ENEMIES = {
  slimeWater: {
    id: 'slimeWater', name: '水史莱姆', element: 'water', ai: AI.melee, tier: 1,
    base: { hp: 320, atk: 34, def: 30 }, res: { water: 0.9, physical: 0.1 },
    speed: 2.2, aggro: 12, attackRange: 1.9, attackCd: 2.0, gauge: 1,
    // `glow` used to be `ELEMENTS.water.glow` (0x9fd8ff), and so did the other two slimes',
    // the tyrant's and the mage's: the element table's `glow` is authored for *additive
    // particle sprites*, where pale is right because the sprite adds its colour to whatever
    // is behind it. A material's `glow` is multiplied instead — emissive = hex × 1.5 plus a
    // rim at strength 1.2 — so a pale hex arrives at the top of the tone curve as white and
    // the crest photographs as a featureless blade. Use the element's *saturated* colour
    // (or deeper), one step below where you want it to land: the intensity supplies the
    // brightness, the hex supplies only the hue.
    model: { kind: 'slime', scale: 0.85, color: 0x4aa8e8, glow: 0x2f96f0 },
    xp: 24, loot: [['slimeCondensate', 0.6], ['slimeSecretions', 0.3], ['mora', 1.0]],
    hitbox: { r: 0.75, h: 1.1 },
  },
  slimeFire: {
    id: 'slimeFire', name: '炎史莱姆', element: 'fire', ai: AI.charger, tier: 1,
    base: { hp: 300, atk: 40, def: 30 }, res: { fire: 0.9, physical: 0.1 },
    speed: 2.9, aggro: 13, attackRange: 2.0, attackCd: 1.8, gauge: 1,
    model: { kind: 'slime', scale: 0.85, color: 0xff7a3c, glow: 0xff5a12 },
    xp: 26, loot: [['slimeCondensate', 0.6], ['agnidusShard', 0.12], ['mora', 1.0]],
    hitbox: { r: 0.75, h: 1.1 },
  },
  slimeElectro: {
    id: 'slimeElectro', name: '雷史莱姆', element: 'lightning', ai: AI.ranged, tier: 1,
    base: { hp: 290, atk: 36, def: 30 }, res: { lightning: 0.9, physical: 0.1 },
    speed: 2.4, aggro: 15, attackRange: 11, attackCd: 2.6, gauge: 1, projectileSpeed: 14,
    model: { kind: 'slime', scale: 0.82, color: 0xb46cff, glow: 0x9440f0 },
    xp: 26, loot: [['slimeCondensate', 0.6], ['vajradaShard', 0.12], ['mora', 1.0]],
    hitbox: { r: 0.72, h: 1.05 },
  },
  hilichurl: {
    id: 'hilichurl', name: '丘丘人', element: 'physical', ai: AI.melee, tier: 1,
    base: { hp: 420, atk: 46, def: 42 }, res: {},
    speed: 3.1, aggro: 16, attackRange: 2.3, attackCd: 1.6, gauge: 0,
    model: { kind: 'hilichurl', scale: 1.0, color: 0x8a6a44, cloth: 0x5a4a2a, mask: 0xd8c090 },
    xp: 40, loot: [['damagedMask', 0.55], ['arrowhead', 0.2], ['mora', 1.0]],
    hitbox: { r: 0.5, h: 1.7 },
  },
  hilichurlArcher: {
    id: 'hilichurlArcher', name: '丘丘弓手', element: 'physical', ai: AI.ranged, tier: 2,
    base: { hp: 380, atk: 52, def: 40 }, res: {},
    speed: 2.8, aggro: 22, attackRange: 18, attackCd: 2.4, gauge: 0, projectileSpeed: 26,
    model: { kind: 'hilichurl', scale: 0.98, color: 0x8a6a44, cloth: 0x3f5a3a, mask: 0xc0b088, bow: true },
    xp: 46, loot: [['arrowhead', 0.6], ['damagedMask', 0.25], ['mora', 1.0]],
    hitbox: { r: 0.5, h: 1.7 },
  },
  hilichurlPyro: {
    id: 'hilichurlPyro', name: '火斧丘丘人', element: 'fire', ai: AI.charger, tier: 2,
    base: { hp: 560, atk: 62, def: 48 }, res: { fire: 0.5 },
    speed: 3.4, aggro: 20, attackRange: 2.6, attackCd: 2.0, gauge: 1,
    model: { kind: 'hilichurl', scale: 1.12, color: 0x9a6a44, cloth: 0x6a2a20, mask: 0xff8a4a, axe: true },
    xp: 62, loot: [['damagedMask', 0.5], ['agnidusShard', 0.2], ['mora', 1.0]],
    hitbox: { r: 0.56, h: 1.85 },
  },
  abyssMage: {
    id: 'abyssMage', name: '深渊法师', element: 'ice', ai: AI.caster, tier: 3,
    base: { hp: 1250, atk: 74, def: 60 }, res: { ice: 0.75 },
    speed: 2.0, aggro: 24, attackRange: 14, attackCd: 3.0, gauge: 2, projectileSpeed: 16,
    shield: { hp: 900, element: 'ice' },
    // 0x8fe3f0 was `ELEMENTS.ice.color` itself — 56 % red, and the ice palette is pale by
    // design because it was authored for auras and sprites that *add*. In a material it is
    // multiplied three times over (emissive ×1.5, a rim at 1.2, plus the light), so the robe
    // trim rings and the two floating hand orbs photographed as featureless white hoops and a
    // white ping-pong ball. Same rule as the slimes above: keep the hue, drop the red.
    model: { kind: 'mage', scale: 1.15, color: 0x2a2a52, robe: 0x1a1a38, glow: 0x2fc4e6 },
    xp: 180, loot: [['abyssalCrystal', 0.7], ['shivadaShard', 0.35], ['mora', 1.0]],
    hitbox: { r: 0.7, h: 2.0 },
  },
  ruinGuard: {
    id: 'ruinGuard', name: '遗迹守卫', element: 'physical', ai: AI.boss, tier: 3,
    base: { hp: 3400, atk: 104, def: 120 }, res: { physical: 0.3 },
    // `missileBarrage` is a projectile move with no speed of its own, so this is the number
    // its six missiles fly at. Slower than the archer's arrow (26) on purpose: the barrage is
    // meant to be walked out of, and until this key existed it silently used the generic 18.
    speed: 2.6, aggro: 26, attackRange: 4.0, attackCd: 2.6, gauge: 0, projectileSpeed: 20,
    // The single eye. `offset` is metres from the machine's feet with +Z forward, and it
    // mirrors the geometry: `KINDS.ruinGuard.weakspot()` in client/src/gfx/enemies.js
    // exports the same point out of the same expression that places the glowing sphere,
    // and the gate fails if these two drift more than 12 cm apart. Only projectiles can
    // claim it (a weak point is something you aim at), so a bow or a catalyst gets a
    // reason to exist against the one enemy whose armour is 30% physical resistance.
    weakspot: { offset: [0, 3.25, 0.42], r: 0.5, mult: 3.0, stun: 1.6 },
    model: { kind: 'ruinGuard', scale: 1.0, color: 0x6b6a62, metal: 0x8a897e, glow: 0xffb13b },
    xp: 420, loot: [['chaosDevice', 0.8], ['chaosCore', 0.25], ['mora', 1.0]],
    hitbox: { r: 1.2, h: 3.6 }, elite: true,
    attacks: ['slam', 'missileBarrage', 'chargeRoll'],
  },
  frostWolf: {
    id: 'frostWolf', name: '霜狼', element: 'ice', ai: AI.charger, tier: 2,
    base: { hp: 640, atk: 68, def: 52 }, res: { ice: 0.6 },
    speed: 5.0, aggro: 26, attackRange: 2.4, attackCd: 1.5, gauge: 1,
    // 0xdfe9f2 was 91 % luminance, and an albedo that high has nothing left to shade with:
    // half of the animal's silhouette (50.5 % at the worst yaw, the highest reading of any
    // enemy in the game) came out within 55 counts of white in all three channels with the
    // channels inside 12 of each other — a paper cut-out of a wolf. The cel ramp's lit band,
    // a 0.34-of-white fresnel rim, the sky bounce and the elemental aura all add on top of
    // the albedo, so the albedo is the one term that has to leave room for them. This is the
    // same ice blue two stops down: still unmistakably a snow wolf, and now its dorsal
    // saddle and belly (both derived at 0.66× in `materialsFor`) have somewhere to sit.
    //
    // Two terms, not one, because the gate asks two questions and the first draft (0xa9bfd2)
    // only answered one: it took the worst yaw from 50.5 % to 9.3 %, and the pixels still
    // failing averaged (203, 211, 214) — one count over the "min ≥ 200" line and one count
    // under the "channels within 12" line. So this is a little darker *and* noticeably cooler:
    // 41 counts of channel spread in the albedo became 57, which is the term that keeps a
    // bright surface reading as blue-white ice instead of as paper. Warm sunlight on a cool
    // hide compresses that spread, so it has to be authored wider than it needs to look.
    // Third step, and this one is bounded by a measurement instead of a guess. Eight yaws (the
    // sheet used to shoot four) put the worst *connected* washed patch at 651 px on the back view:
    // one flat facet on the left rump at a uniform (213, 217, 221). Two things were ruled out
    // there before touching the albedo again — the fresnel rim, because the distance transform of
    // the silhouette puts the patch 32 px inside the outline where the rim cannot reach, and the
    // stepped specular, because turning it off (`iso-nospec-back`) left 416 px of the same patch.
    // What is left is the diffuse top band itself: `bands: 2` on a hide means the lit side is one
    // flat `albedo × sunlight`, and a warm sun plus the neutral sky bounce compresses the albedo's
    // 29 % channel spread to 3.6 % by the time it reaches the frame. At 0.61 luminance the same
    // facet lands under the "within 55 counts of white" line with room to spare, and the animal is
    // still unmistakably pale ice — see the `enemy-cam frostWolf` sheet for the before/after.
    model: { kind: 'wolf', scale: 1.0, color: 0x86a1bd, accent: 0x8fd4ff },
    xp: 90, loot: [['wolfClaw', 0.55], ['shivadaShard', 0.15], ['mora', 1.0]],
    // No `pack` key: the camps in `zones.js` already list the wolves one by one
    // (`['frostWolf', 'frostWolf', 'frostWolf']`), which is what `updateCamps` spawns.
    // A second, unread pack size next to it was a rule that looked enforced.
    hitbox: { r: 0.6, h: 1.3 },
  },
  geoVishap: {
    id: 'geoVishap', name: '岩龙蜥', element: 'earth', ai: AI.melee, tier: 3,
    base: { hp: 1800, atk: 92, def: 96 }, res: { earth: 0.7, physical: 0.2 },
    speed: 3.6, aggro: 24, attackRange: 3.2, attackCd: 2.2, gauge: 2,
    model: { kind: 'vishap', scale: 1.2, color: 0xc9a45c, accent: 0xffd15c },
    xp: 260, loot: [['vishapScale', 0.7], ['prithivaShard', 0.3], ['mora', 1.0]],
    hitbox: { r: 0.95, h: 2.2 }, elite: true,
    attacks: ['tailSweep', 'drillCharge', 'spikeField'],
  },
  abyssHerald: {
    id: 'abyssHerald', name: '深渊使徒', element: 'water', ai: AI.boss, tier: 4,
    base: { hp: 8600, atk: 148, def: 140 }, res: { water: 0.9, physical: 0.3 },
    speed: 3.0, aggro: 40, attackRange: 4.5, attackCd: 2.4, gauge: 2,
    shield: { hp: 3200, element: 'water' },
    // `metal` defaults to a warm grey that was authored for Mondstadt ruin machinery: on the
    // herald's new brow ridge it photographed as a beige twig laid across an abyss-blue helm.
    // The faction's trim is cold steel, so it is authored here rather than special-cased in the
    // builder — one value, on the model data, next to the colours it has to sit between.
    // `glow` was 0x62c8ff: 38 % red, which is not pale for a sprite and is far too pale for a
    // material — 10.5 % of this boss's silhouette from behind came out at (216, 241, 243), i.e.
    // four solid white hoops round the skirt, two white shoulder slabs and six white needles.
    // The deeper blue keeps the red term under the ×1.5 emissive and the 1.2 rim.
    model: { kind: 'herald', scale: 1.35, color: 0x16324a, robe: 0x0e2036, glow: 0x1d8ae8, metal: 0x93a8bd },
    xp: 1500, loot: [['abyssalCrystal', 1.0], ['heraldsInsignia', 1.0], ['crownFragment', 0.35], ['mora', 1.0]],
    hitbox: { r: 1.1, h: 3.2 }, boss: true,
    attacks: ['tideLance', 'whirlpool', 'shieldSurge', 'summonMinions'],
    phases: 2,
  },
  stormTyrant: {
    id: 'stormTyrant', name: '暴风之主', element: 'wind', ai: AI.boss, tier: 5,
    base: { hp: 14000, atk: 186, def: 160 }, res: { wind: 0.95, physical: 0.4 },
    speed: 3.4, aggro: 60, attackRange: 6.0, attackCd: 2.2, gauge: 2,
    // `glow` is multiplied by 1.5 into an emissive and also becomes the glow parts' rim colour, so
    // an authored *pale* hex has nowhere left to go: 0xb9ffe8 (73% red) came out of the tone curve
    // as white and the crest photographed as a lens flare. A colour that has to survive being
    // brightened must be saturated to begin with — the intensity supplies the brightness, the hex
    // only supplies the hue. `accent` stays pale, because nothing multiplies it.
    model: { kind: 'tyrant', scale: 1.9, color: 0x3a5a68, accent: 0x7affd8, glow: 0x2fe0c0 },
    xp: 4200, loot: [['tyrantPlume', 1.0], ['crownFragment', 1.0], ['mora', 1.0]],
    hitbox: { r: 2.0, h: 5.2 }, boss: true, flying: true,
    attacks: ['cyclone', 'divebomb', 'featherStorm', 'windPrison'],
    phases: 3,
  },
};

export const ENEMY_IDS = Object.keys(ENEMIES);

/** Attack move definitions used by the server AI and client animation. */
export const ATTACK_MOVES = {
  slam:           { windup: 0.85, active: 0.2, recover: 1.0, mult: 1.6, radius: 4.2, element: 'physical', shake: 0.6 },
  missileBarrage: { windup: 1.2, active: 1.6, recover: 0.8, mult: 0.5, ticks: 6, range: 22, element: 'physical', projectile: true },
  chargeRoll:     { windup: 1.0, active: 1.4, recover: 1.2, mult: 1.9, radius: 2.6, element: 'physical', dash: 16, shake: 0.5 },
  tailSweep:      { windup: 0.6, active: 0.3, recover: 0.7, mult: 1.4, radius: 4.0, arc: 2.4, element: 'earth' },
  drillCharge:    { windup: 0.9, active: 1.1, recover: 0.9, mult: 2.0, radius: 2.2, dash: 14, element: 'earth' },
  spikeField:     { windup: 1.1, active: 0.6, recover: 1.0, mult: 1.2, radius: 6.0, element: 'earth', ticks: 3 },
  tideLance:      { windup: 0.7, active: 0.3, recover: 0.6, mult: 1.8, range: 16, element: 'water', projectile: true, projectileSpeed: 22 },
  whirlpool:      { windup: 1.3, active: 2.2, recover: 1.0, mult: 0.6, ticks: 7, radius: 7.0, element: 'water', pull: 6 },
  shieldSurge:    { windup: 1.0, active: 0.4, recover: 1.4, mult: 2.2, radius: 6.0, element: 'water', selfShield: 1800 },
  summonMinions:  { windup: 1.4, active: 0.2, recover: 1.2, mult: 0, summon: ['slimeWater', 'slimeWater', 'hilichurl'] },
  cyclone:        { windup: 1.1, active: 2.6, recover: 1.0, mult: 0.55, ticks: 9, radius: 8.0, element: 'wind', pull: 8 },
  divebomb:       { windup: 1.5, active: 0.7, recover: 1.6, mult: 2.6, radius: 5.5, element: 'wind', dash: 26, shake: 1.0 },
  featherStorm:   { windup: 1.0, active: 2.0, recover: 0.9, mult: 0.45, ticks: 12, range: 26, element: 'wind', projectile: true, projectileSpeed: 24 },
  windPrison:     { windup: 1.2, active: 0.5, recover: 1.5, mult: 1.4, radius: 4.0, element: 'wind', root: 2.5 },
  // The three fallback moves carry **no `element`**, for the same reason they carry no
  // `projectileSpeed` (see below): `resolveEnemyAttack` reads `mv.element || e.def.element`, so a
  // literal here wins over the creature's own element for every enemy that has no `attacks` list.
  // `element: 'physical'` used to sit on this line, and it made four elemental creatures deal
  // physical damage with no attachment at all — 水史莱姆, 炎史莱姆, 火斧丘丘人 and 霜狼 all swing
  // `basic`. Their `element` and their `gauge: 1` are both authored (`enemyGate` even documents
  // them as 「the element its attacks apply」 and 「elemental application on its hits」), their
  // `res` profile is built around the element, and the client's telegraph has always coloured the
  // wind-up ring by `mv?.element || def.element` — every reader agreed except the resolver.
  // The consequence was a whole half of the reaction system being unreachable: nothing in the
  // open world could make a player 湿身, so 感电/冻结 on your own party could not happen.
  basic:          { windup: 0.45, active: 0.18, recover: 0.5, mult: 1.0, radius: 2.4 },
  // Both ranged fallbacks deliberately carry no `projectileSpeed`: they are what *every*
  // ranged enemy without its own `attacks` list fires, so a speed here would win over
  // `def.projectileSpeed` (the move's value is checked first) and a slime's bubble would
  // travel exactly as fast as a hilichurl archer's arrow. Those three numbers — 14, 26, 16 —
  // were authored per enemy and read by nothing at all until this was noticed.
  basicRanged:    { windup: 0.6, active: 0.1, recover: 0.7, mult: 1.0, range: 18, projectile: true },
  basicCast:      { windup: 0.9, active: 0.2, recover: 0.9, mult: 1.3, range: 16, projectile: true },
};

/**
 * The slack `resolveEnemyAttack` adds to a melee radius before it tests a player against it.
 *
 * The sim runs at 20 Hz and a sprinting player covers 0.3 m per tick, so a hit tested against
 * the bare radius drops on the frame it should land. It lives here, next to the radii it
 * applies to, because the *telegraph* has to draw the circle the damage really uses: a ring
 * drawn at `radius` while the damage lands at `radius + 0.6` is a lie that costs health.
 */
export const HIT_SLACK = 0.6;

/** An enemy projectile's collision radius, metres. Also the width of the aim line drawn for it. */
export const PROJECTILE_R = 1.0;

/** How far from itself a summoner drops its minions, metres. Also the radius of the ring drawn. */
export const SUMMON_R = 6;

/**
 * The patch of ground a move is about to cover — the one description of an attack's geometry
 * that both the simulation and the telegraph read.
 *
 * This exists because they used to disagree completely. `ATTACK_MOVES` authors radii from 2.2 m
 * (drillCharge) to 8.0 m (cyclone), a 137° `arc` for the tail sweep, dash speeds up to 26 m/s
 * and projectile ranges up to 26 m — and the client drew, for all seventeen moves, one ring
 * sized `max(1.6, hitbox.r * 2.4)`: a number belonging to the *creature*, not to the attack. So
 * the wind-up said "stand back about two metres" whether the answer was 2.4 m or a 6 m field of
 * spikes, and the only way to learn a boss's moves was to die to each of them.
 *
 * Kinds, and what each promises:
 *   `disc`   — everything inside `hit` metres is struck (slam, spikeField, whirlpool, cyclone)
 *   `sector` — as `disc`, but only within `arc` radians of the creature's facing (tailSweep)
 *   `lane`   — a `disc` of radius `hit` swept `length` metres forward (chargeRoll, divebomb)
 *   `aim`    — a shot `length` metres down the facing, `radius` wide (every projectile move)
 *   `ring`   — minions arrive on this circle; nothing is struck (summonMinions)
 *
 * `radius` is the authored reach — what `pull` and `root` test against — and `hit` is that plus
 * `HIT_SLACK`, what the damage test accepts. Callers that draw use both: the outline goes at
 * `hit`, because that is where the damage stops.
 */
export function attackShape(mv, def = {}) {
  if (!mv) return null;
  if (mv.projectile) {
    // The shot's reach, not the enemy's: `range` is authored per move and used to be read by
    // nothing at all, so a tideLance that missed flew its full 4 s — 88 m — looking for someone.
    return { kind: 'aim', radius: PROJECTILE_R, hit: PROJECTILE_R, length: mv.range || def.attackRange || 18 };
  }
  if (mv.summon) return { kind: 'ring', radius: SUMMON_R, hit: SUMMON_R };
  // Every damaging melee move authors its own `radius` (`enemyGateReport` fails one that does
  // not), so both fallbacks below are unreachable today and are here only so that a new move
  // missing a radius degrades to the reach it was started from instead of to NaN.
  const radius = mv.radius || def.attackRange || 2.4;
  const hit = radius + HIT_SLACK;
  // A dash resolves its damage every frame of the active window while `applyDash` drives the
  // creature forward at `dash` m/s, so the ground at risk is the swept disc, not the disc.
  if (mv.dash) return { kind: 'lane', radius, hit, length: mv.dash * (mv.active || 0.2) };
  if (mv.arc) return { kind: 'sector', radius, hit, arc: mv.arc };
  return { kind: 'disc', radius, hit };
}
