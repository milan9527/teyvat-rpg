// The consumer gate for zone data.
//
// `data/zones.js` is the largest authored file in the project and the only one whose keys are
// read by three different layers: the terrain/prop builders in the client, the validating
// routes in the server, and the shared simulation in between. That makes it the file where
// authored data rots the most quietly, in the two directions this project has now been bitten
// by four times:
//
//   1. **A key with no consumer.** `props.trees.minH` was declared in three zones for months
//      and read by nobody — `world.js#_recipes` builds the tree recipe from `kinds`, `density`,
//      `maxSlope`, `scale` and `snowy`, and derives its lower bound from the water level. So
//      the number looked like a rule ("no trees below 6 m on Dragonspine") and was decoration.
//      The same shape of bug already shipped as `npc.dialogue` (every NPC said "……") and as the
//      quest kinds nothing produced.
//   2. **A name with no builder.** A zone that asks for `ruins: { kind: 'obelisk' }` throws
//      `unknown prop kind` from `makeProto` — but only when *that zone loads*, which on this
//      map means after a teleport, in a dungeon, on someone else's machine. A typo in a prop
//      name is a crash the author does not see.
//
// So this module is the contract, checked in both directions by `tools/api-check.mjs`:
// `PROP_GROUPS` declares every scatter group a zone may carry, every key inside it, and the
// function that reads it; `zoneGateReport()` rejects a zone key that is not declared here and a
// declaration no zone uses; and because `client/src/gfx/props.js` imports cleanly under Node
// (it touches no browser globals at module scope), the same report also compares the kinds the
// zones ask for against the builders that actually exist — `SCATTER`/`SINGLE` — so a missing
// builder and an unreachable one are both failures of a test rather than a crash in play.
//
// The keys are documented here rather than at their use site on purpose: a reader asking "what
// can a zone say?" has exactly one file to read, and a reviewer asking "is this key alive?" has
// a name to grep for in the consumer this file names.

import {
  ZONES, CHEST_TIERS, PUZZLE_KINDS, NPC_ROLES, puzzleNodes, chamberEnemies, zoneEntryRank,
} from './zones.js';
import { rankForLevel } from '../sim/formulas.js';
import { ENEMIES } from './enemies.js';
import { DISORDERS } from './disorders.js';
import { ELEMENTS } from './elements.js';
import { MATERIALS, ARTIFACT_SETS } from './items.js';
import { SHOPS } from './shop.js';
import { WEATHER_TYPES, baseWeather, maxStorm } from '../world/weather.js';
import { QUESTS } from './quests.js';

/**
 * Scatter/landmark groups a zone's `props` may declare.
 *
 * `family` is which builder the group reaches:
 *   'field'  — `buildPropField(kind, …)`, an InstancedMesh per prop kind (`SCATTER`).
 *   'single' — `buildProp(kind, …)`, one group per instance, for props that carry a light or
 *              an animation instancing cannot express (`SINGLE`).
 *
 * `kind` is where the prop name comes from: a literal (the group always builds the same shape),
 * `'kind'` (the zone names one), or `'kinds'` (the zone names a list and the scatter deals them
 * out across the placements).
 *
 * `keys` is every key the group may carry, mapped to the note that says who reads it. Anything
 * else in a zone's group is a typo or a dead idea, and `zoneGateReport()` says so.
 */
export const PROP_GROUPS = {
  trees: {
    family: 'field', kind: 'kinds', consumer: 'client/src/game/world.js#_recipes',
    keys: {
      kinds: 'prop names dealt across the field',
      density: 'props per m² of cell area',
      minH: 'lowest ground height a trunk may stand on — keeps the treeline off the shore',
      maxSlope: 'steepest ground a trunk may stand on',
      scale: '[min, max] uniform scale',
      snowy: 'passed to the recipe: frosted foliage, and bushes follow it',
    },
  },
  rocks: {
    family: 'field', kind: 'rock', consumer: 'client/src/game/world.js#_recipes',
    keys: { density: 'per m²', scale: '[min, max]', snowy: 'snow cap on the boulder' },
  },
  grass: {
    family: 'field', kind: 'grassTuft', consumer: 'client/src/game/world.js#_recipes',
    keys: {
      density: 'per m² — the one group dense enough to be measured per square metre',
      maxSlope: 'steepest ground a tuft grows on',
      height: '[min, max] in *metres*, converted by `scaleIsHeight`, not a multiplier',
      dry: 'every tuft is strawy, not the usual one in five — a frost-killed or arid zone.'
        + ' The blade colours themselves come from `terrain.grassColorA/B`',
    },
  },
  flowers: {
    family: 'field', kind: 'kinds', consumer: 'client/src/game/world.js#_recipes',
    keys: { density: 'per m²', kinds: 'decorative species (the gatherable ones are `gathers`)' },
  },
  bushes: {
    family: 'field', kind: 'bush', consumer: 'client/src/game/world.js#_recipes',
    keys: { density: 'per m²' },
  },
  crystals: {
    family: 'field', kind: 'crystal', consumer: 'client/src/game/world.js#_recipes',
    keys: { density: 'per m²', color: 'emissive tint of the shard' },
  },
  ruins: {
    family: 'field', kind: 'kind', consumer: 'client/src/game/world.js#_buildLandmarks',
    keys: {
      kind: 'the architecture of this zone: pillar / pagoda / iceSpire / …',
      count: 'placed once at construction — landmarks must not stream in',
    },
  },
  lanterns: {
    family: 'field', kind: 'lantern', consumer: 'client/src/game/world.js#_buildLandmarks',
    keys: { count: 'placed once, inside 0.85 of the landmark radius' },
  },
  braziers: {
    family: 'single', kind: 'brazier', consumer: 'client/src/game/world.js#_buildLandmarks',
    keys: { count: 'each one owns a PointLight and a flame, so these are not instanced' },
  },
  enclosure: {
    family: 'field', kind: 'kind', consumer: 'client/src/game/world.js#_buildEnclosure',
    arenaOnly: true, singleton: true,
    keys: {
      kind: 'wall module ringing the arena: abyssArch / iceCurtain / goldArcade',
      span: 'target width per module; the count is derived so the ring cannot seam',
      inset: 'metres inside `arena.radius` the wall stands',
      variants: 'how many reshuffles of the module to deal around the ring',
      wallColor: 'albedo of the wall itself — `goldArcade`\'s lacquer dado (plus its plinth'
        + ' and fillet at 0.55 and 0.34 of it) and `iceCurtain`\'s rock. The room\'s value'
        + ' anchor, which is why the zone owns it and not the recipe: a cave wall built out'
        + ' of the generic `stoneDark` photographed at luma 33 against its own 166-182 floor',
    },
  },
  // The one group that reaches neither `buildPropField` nor `buildProp`: a ceiling is a single
  // hand-built shell, so `family: 'own'` and `kind: null` keep it out of the prop-kind half of
  // the gate (`propKindsUsed`'s `want()` ignores a null kind) while the key half still applies.
  //
  // Note what is *not* listed: `buildVaultCeiling` also reads `radius`, `rimY` and `seed`, and
  // `_buildCeiling` overwrites all three after spreading the zone's config — they are derived
  // from the arena and the wall height, because that derivation is the whole sealing argument
  // (rim wider than the wall ring, rim lower than the wall top, so the two surfaces intersect
  // and the 44 m terrain ramp has no elevation left to show through). Authoring one of them
  // would be a value that silently does nothing, so the gate rejects it instead.
  ceiling: {
    family: 'own', kind: null,
    consumer: 'client/src/game/world.js#_buildCeiling + client/src/gfx/props.js#buildVaultCeiling',
    arenaOnly: true, singleton: true,
    keys: {
      style: 'cave (stalactites) / rune (glowing veins) / coffer (gilt panels + rosettes)',
      rise: 'metres from the springing line up to the crown',
      segments: 'facets around — vertex tone varies per facet, so this is also the tone grain',
      rings: 'courses out from the crown',
      ribs: 'radial ribs hung under the shell',
      hoops: 'fractions of the radius to run a hoop at; a hoop is the only decoration'
        + ' guaranteed to cross the top of frame, which is what fixed the flat-wash std',
      pendants: 'stalactites / bosses hanging from the shell',
      pendantScale: 'multiplier on pendant length',
      bump: 'amplitude of the low-frequency lobes that keep the dome off a clean sphere',
      crownShade: 'vertex tone at the crown, 1.0 = albedo — the knob that decides whether the'
        + ' vault reads darker than the floor',
      rockColor: 'shell albedo',
      trimColor: 'rib / hoop / coffer albedo',
      glowColor: 'emissive of the veins, rosettes and crown light',
      shadowColor: 'shadowTint for both vault materials — on a surface permanently in the'
        + ' shadow band this *is* the colour, so it cannot share the cold default',
      overhang: 'metres the rim reaches past `arena.radius`, past the wall ring',
      drop: 'metres the rim sits below the top of the wall modules',
    },
  },
};

/**
 * Every key a zone's `terrain` may carry, and who reads it.
 *
 * This half of the gate was written after the props half found `minH`, and it immediately paid
 * for itself three times over: `snowLine`, `snowBlend` and `snowColor` were *shader inputs with
 * defaults* that no zone authored, so the snow branch in `gfx/terrain.js` — drifts along a wind
 * axis, sky-blue troughs, near-field sparkle — had never run in this game and Dragonspine's
 * ground was a flat biome albedo brighter than its own sky; `grassColorA/B` were authored on all
 * three outdoor zones and read by nobody, so the snowfields grew Mondstadt's meadow green; and
 * `biomes[].rough` was 24 numbers describing a material property no shader sampled.
 *
 * `by` is the file (and function) that must mention the key — checked by grep in
 * `tools/api-check.mjs`, which is weak proof of *use* but conclusive proof of *absence*.
 */
export const TERRAIN_KEYS = {
  // ---- the height field: shared by client mesh, client movement and server physics --------
  scale: { by: 'shared/src/data/zones.js#rawHeight', why: 'horizontal frequency of the base fbm' },
  height: { by: 'shared/src/data/zones.js#rawHeight', why: 'metres per unit of noise — the zone\'s relief' },
  octaves: { by: 'shared/src/data/zones.js#rawHeight', why: 'fbm octaves; more = finer ridgelines' },
  ridgeMix: { by: 'shared/src/data/zones.js#rawHeight', why: 'how much ridged noise is folded into the fbm' },
  ridgeScale: { by: 'shared/src/data/zones.js#rawHeight', why: 'frequency of that ridged term' },
  plateau: { by: 'shared/src/data/zones.js#rawHeight', why: 'flattening exponent — 0.8 is a dungeon floor, 0.08 is karst' },
  cliffPower: { by: 'shared/src/data/zones.js#rawHeight', why: 'sharpens slopes into cliffs' },
  baseShift: { by: 'shared/src/data/zones.js#rawHeight', why: 'metres the whole landscape drops so its lowlands reach the water plane' },
  karst: { by: 'shared/src/data/zones.js#rawHeight', why: 'Liyue only: threshold ridged noise into vertical towers' },
  lakes: { by: 'shared/src/data/zones.js#rawHeight', why: '[{ at, radius, floor }] basins carved out of the field' },
  arena: { by: 'shared/src/data/zones.js#heightAt', why: 'flat indoor floor inside `radius`, ground rising outside it' },
  // ---- surface appearance -----------------------------------------------------------------
  biomes: { by: 'client/src/gfx/terrain.js', why: 'up to four surfaces, splatted by slope and height' },
  cliffColor: { by: 'client/src/gfx/terrain.js', why: 'bare rock on steep faces; the default is biome #4' },
  shadowTint: { by: 'client/src/gfx/terrain.js', why: 'multiplier on albedo in the shadow band — the one place a second hue reaches a single-lit scene' },
  snowLine: { by: 'client/src/gfx/terrain.js', why: 'metres above which the snow branch takes over flat ground' },
  snowBlend: { by: 'client/src/gfx/terrain.js', why: 'metres of fade across that line, so it is not a contour' },
  snowColor: { by: 'client/src/gfx/terrain.js', why: 'effective albedo of every flat snow surface once the branch runs' },
  inlayColor: { by: 'client/src/gfx/terrain.js + client/src/ui/mapview.js', why: 'colour of the rings, spokes and medallion inlaid in an arena floor' },
  inlayStrength: { by: 'client/src/gfx/terrain.js + client/src/ui/mapview.js', why: 'how hard that colour is mixed in: a hall shows its floor pattern, a cavern barely hints at one' },
  grassColorA: { by: 'client/src/game/world.js#_recipes', why: 'blade colour, passed to props.js as `color`; the light and dry shades are struck from it' },
  grassColorB: { by: 'client/src/game/world.js#_recipes', why: 'the second blade colour, passed as `colorB`' },
};

/** Keys one entry of `terrain.biomes` may carry. All read by `client/src/gfx/terrain.js`. */
export const BIOME_KEYS = {
  key: 'name, for reading the data — no code branches on it',
  color: 'albedo, one of `uColA..D`',
  rough: 'roughness; inverted into `uGloss` so ice takes a specular lobe and grass does not',
  minSlope: 'lower slope bound in `biomeIndex`',
  maxSlope: 'upper slope bound in `biomeIndex`',
  maxHeight: 'upper height bound in `biomeIndex`',
  // Declared but carried by no zone, and deliberately exempt from the "declaration nothing
  // uses" direction below. The exemption is not free: `biomeIndex` is grepped for the name like
  // every other key here, so this entry asserts the *reader* exists. Without the declaration a
  // zone that authored a lower bound — the symmetric half of `maxHeight`, in the same four-line
  // reader — would be reported as a typo, which is a worse failure than an unexercised option.
  minHeight: 'lower height bound in `biomeIndex`; no zone needs one yet',
};

/**
 * Every key a zone's `sky` may carry, and who reads it.
 *
 * Written the moment `exposure` turned up: all six zones authored one (1.0 … 1.2) and the
 * renderer never asked for it, so the *tone curve's operating point* — the single most
 * consequential number in a frame — was authored data doing nothing while 龙脊雪山's snow sat on
 * the ACES shoulder with its texture tone-mapped into a 9-count band. `Renderer#setExposure`
 * reads it now, which is also why the pairs below are checked: an unread key is harmless and an
 * unread *exposure* is a whole zone's look.
 */
export const SKY_KEYS = {
  sunDir: { by: 'client/src/gfx/sky.js', why: 'direction of the one directional light; also the terrain and water sun term' },
  sunColor: { by: 'client/src/gfx/sky.js', why: 'colour of that light — and, in gfx/terrain.js, the *whole* light term (no intensity)' },
  sunIntensity: { by: 'client/src/gfx/sky.js', why: 'strength of the DirectionalLight: props, characters, shadows. The terrain does not read it' },
  ambientSky: { by: 'client/src/gfx/sky.js', why: 'upper half of the hemispheric ambient; doubles as the sky zenith when no zenithColor is given' },
  ambientGround: { by: 'client/src/gfx/sky.js', why: 'lower half — bounce off the ground' },
  ambientIntensity: { by: 'client/src/gfx/sky.js', why: 'strength of that hemisphere, and the terrain\'s uAmbInt' },
  fogColor: { by: 'client/src/gfx/sky.js', why: 'what distance fades to; also the sky horizon when no horizonColor is given' },
  fogNear: { by: 'client/src/gfx/terrain.js', why: 'metres before fog starts (the terrain scales it up: distant ground must stay readable)' },
  fogFar: { by: 'client/src/gfx/terrain.js', why: 'metres at which fog is total' },
  fogDensity: { by: 'client/src/gfx/sky.js', why: 'exponential density for the scene fog the meshes use' },
  rayleigh: { by: 'client/src/gfx/sky.js', why: 'falloff exponent of the zenith→horizon gradient' },
  turbidity: { by: 'client/src/gfx/sky.js', why: 'haze: widens the Mie halo around the sun' },
  exposure: { by: 'client/src/engine/renderer.js', why: 'ACES exposure for this zone — where its materials sit on the curve' },
  vaultColor: { by: 'client/src/gfx/sky.js', why: 'indoor only: the cavern shell the sky dome is replaced by' },
  vaultGlow: { by: 'client/src/gfx/sky.js', why: 'indoor only: emissive of the veins in that shell' },
  // Read by sky.js behind a `??` fallback and authored by no zone yet. Same bargain as
  // `minHeight` below: declared so authoring one is not reported as a typo, exempt from the
  // "nobody uses it" direction, and paying for the exemption with the same grep that proves
  // every other key here has a reader.
  zenithColor: { by: 'client/src/gfx/sky.js', why: 'sky colour straight up, when ambientSky is not the right one' },
  horizonColor: { by: 'client/src/gfx/sky.js', why: 'sky colour at the horizon, when fogColor is not the right one' },
  stars: { by: 'client/src/gfx/sky.js', why: 'star field strength — for a night zone' },
  night: { by: 'client/src/gfx/sky.js', why: 'darkens the dome and turns the sun disc down' },
};

/** Sky keys no zone is required to carry (see the note above). */
const SKY_KEYS_OPTIONAL = new Set(['zenithColor', 'horizonColor', 'stars', 'night']);

/** Keys `terrain.arena` may carry. */
export const ARENA_KEYS = {
  radius: 'metres of flat floor; also the wall ring, the ceiling rim and the minimap disc',
  wall: 'metres of rise outside the radius — how tall the room reads from inside',
};

/** Biome keys no zone is required to carry (see the note on `minHeight`). */
const BIOME_KEYS_OPTIONAL = new Set(['minHeight']);

/**
 * POI type → the prop that represents it, and the interaction it offers.
 *
 * Imported by `client/src/game/world.js#_buildPois` rather than repeated there: the mapping is
 * what decides whether a POI is visible at all (a type with no entry is silently skipped), so
 * it belongs next to the gate that checks every authored type has one.
 */
export const POI_PROPS = {
  waypoint: 'waypoint',
  chest: 'chest',
  statue: 'statue',
  puzzle: 'monument',
  dungeon: 'dungeonGate',
  warmth: 'brazier',
};

/** Keys a POI of each type may carry, beyond the universal id/type/at/name. */
const POI_KEYS = {
  waypoint: [],
  chest: ['tier', 'requires'],
  statue: ['element'],
  puzzle: ['kind', 'element', 'count'],
  dungeon: ['target'],
  warmth: [],
};

/**
 * The lock a chest may carry, and who enforces it.
 *
 * Declared as a table because the last hole here was a *silent* one: the route only understood
 * `puzzle:`, so the three dungeon reward chests — `requires: 'clear'`, one luxurious chest each,
 * 10 primogems and a guaranteed artifact — opened the moment a player walked in. An authored
 * condition enforced nowhere is worse than no condition, and a gate that only knows some of the
 * forms cannot tell that it is the one at fault. So: every form is listed here, the route fails
 * closed on anything it does not recognise, and this gate rejects a form nobody enforces.
 */
export const POI_GATES = {
  'puzzle:': 'server/src/routes/world.js POST /api/world/chest — the named puzzle must be solved',
  clear: 'server/src/routes/world.js POST /api/world/chest — every chamber floor cleared',
};

/**
 * Every prop kind the authored zones ask for, with the family it must be built by and the
 * reason it is asked for — the "who wants this?" half of the gate.
 */
export function propKindsUsed(zones = ZONES) {
  const used = new Map();
  const want = (kind, family, why) => {
    if (!kind) return;
    const cur = used.get(kind);
    if (cur) { cur.why.push(why); if (cur.family !== family) cur.families.add(family); return; }
    used.set(kind, { kind, family, families: new Set([family]), why: [why] });
  };

  for (const z of Object.values(zones)) {
    for (const [group, cfg] of Object.entries(z.props || {})) {
      const def = PROP_GROUPS[group];
      if (!def) continue;                       // reported separately; not this function's job
      const why = `${z.id}.props.${group}`;
      if (def.kind === 'kinds') for (const k of cfg.kinds || []) want(k, def.family, why);
      else if (def.kind === 'kind') want(cfg.kind, def.family, why);
      else want(def.kind, def.family, why);
    }
    for (const poi of z.poi || []) want(POI_PROPS[poi.type], 'single', `${z.id}.poi.${poi.type}`);
    // Gather nodes are streamed through `PropPool`, which resolves protos out of `SCATTER`.
    for (const g of z.gathers || []) want(g.prop ?? g.kind, 'field', `${z.id}.gathers.${g.kind}`);
  }
  return used;
}

/** An ascending pair of positive numbers: a range like `scale: [0.85, 1.5]`. */
const isRange = (v) => Array.isArray(v) && v.length === 2
  && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0) && v[1] >= v[0];

/** An `[x, z]` position. Not a range — ordering means nothing and either sign is fine. */
const isPoint = (v) => Array.isArray(v) && v.length === 2
  && v.every((n) => typeof n === 'number' && Number.isFinite(n));

const outside = (v, half) => !isPoint(v) || Math.max(Math.abs(v[0]), Math.abs(v[1])) > half;

/**
 * Rec. 709 luma of an authored `0xrrggbb`, in the same sRGB byte space every probe in
 * `tools/` measures screenshots in (`tools/lib/rectstats.mjs`), so a ratio written here and
 * a ratio read off a PNG mean the same thing. Not a gamma-correct luminance on purpose:
 * these are authoring inputs whose numbers get compared to screen bytes by hand.
 */
const luma = (hex) => 0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255);

/**
 * The report. Empty array = the zone data is internally consistent *and* every name in it
 * resolves to something that exists.
 *
 * Pass the client's registries to close the prop-kind loop:
 *   `zoneGateReport({ scatter: SCATTER_KINDS, single: SINGLE_KINDS })`
 * Without them the kind checks are skipped rather than faked — a server-side caller has no
 * geometry to check against, and a gate that silently passes on missing input is the failure
 * mode this file exists to prevent, so the omission is reported as `skipped` by the caller.
 */
export function zoneGateReport({ scatter = null, single = null, zones = ZONES } = {}) {
  const problems = [];
  const groupsSeen = new Set();
  const terrainSeen = new Set(), biomeSeen = new Set(), arenaSeen = new Set(), skySeen = new Set();
  const roleSeen = new Set();

  for (const z of Object.values(zones)) {
    const at = (s) => `${z.id}: ${s}`;
    const half = z.size / 2;
    const arena = z.terrain?.arena;

    /* ---- props ------------------------------------------------------------- */
    for (const [group, cfg] of Object.entries(z.props || {})) {
      const def = PROP_GROUPS[group];
      if (!def) { problems.push(at(`props.${group} is not a declared group`)); continue; }
      groupsSeen.add(group);
      for (const key of Object.keys(cfg)) {
        if (!def.keys[key]) problems.push(at(`props.${group}.${key} is not a key ${def.consumer} reads`));
      }
      if (def.arenaOnly && !arena) {
        problems.push(at(`props.${group} needs terrain.arena — ${def.consumer} never runs without one`));
      }
      if (def.kind === 'kind' && !cfg.kind) problems.push(at(`props.${group} has no kind`));
      if (def.kind === 'kinds' && !(cfg.kinds || []).length) problems.push(at(`props.${group} has no kinds`));
      if ('density' in cfg && !(cfg.density > 0)) problems.push(at(`props.${group}.density must be > 0`));
      if ('count' in cfg && !(Number.isInteger(cfg.count) && cfg.count > 0)) {
        problems.push(at(`props.${group}.count must be a positive integer`));
      }
      // `singleton` groups place exactly one thing (a wall ring, a ceiling), so they have
      // neither a density nor a count — declared on the def rather than special-cased by name,
      // which is how the second such group came to be reported as an error by this line.
      if (cfg.density === undefined && cfg.count === undefined && !def.singleton) {
        problems.push(at(`props.${group} has neither density nor count, so nothing is placed`));
      }
      for (const key of ['scale', 'height']) {
        if (key in cfg && !isRange(cfg[key])) problems.push(at(`props.${group}.${key} must be [min, max] > 0`));
      }
      if ('maxSlope' in cfg && !(cfg.maxSlope > 0 && cfg.maxSlope <= 1.5)) {
        problems.push(at(`props.${group}.maxSlope ${cfg.maxSlope} is outside (0, 1.5]`));
      }
      if ('minH' in cfg && !(cfg.minH >= (z.water?.level ?? -999))) {
        problems.push(at(`props.${group}.minH ${cfg.minH} is below the water level, so it rules out nothing`));
      }
    }

    /* ---- terrain ----------------------------------------------------------- */
    const t = z.terrain;
    if (!t) problems.push(at('has no terrain'));
    else {
      for (const key of Object.keys(t)) {
        // `_`-prefixed keys are runtime memo slots, not authored data: `heightAt` caches the hub
        // height as `terrain._hubY` on first call. Without this skip the gate's verdict depends
        // on whether anything asked for a height earlier *in the same process* — three FAILs in
        // a probe that happens to import questNav before zoneGate, and none in one that does not.
        if (key.startsWith('_')) continue;
        if (!TERRAIN_KEYS[key]) problems.push(at(`terrain.${key} is not a key anything reads`));
        else terrainSeen.add(key);
      }
      if (!(t.biomes || []).length) problems.push(at('terrain has no biomes'));
      // Only four make it into the shader: `biomeIndex` stops at 4 and the splat is a vec4, so a
      // fifth surface is authored data that cannot be reached — a whole colour, silently unused.
      if ((t.biomes || []).length > 4) {
        problems.push(at(`terrain has ${t.biomes.length} biomes; the splat is a vec4, so only the first 4 exist`));
      }
      // Stated per zone because the default is the *fourth* biome, which put a brown scar
      // across every distant hillside in Mondstadt until it was written down.
      if (!t.cliffColor) problems.push(at('terrain has no cliffColor (the default is biome #4)'));
      for (const b of t.biomes || []) {
        if (!b.key) problems.push(at('a biome has no key'));
        if (b.color === undefined) problems.push(at(`biome ${b.key} has no color`));
        for (const key of Object.keys(b)) {
          if (!BIOME_KEYS[key]) problems.push(at(`biome ${b.key} carries "${key}", which nothing reads`));
          else biomeSeen.add(key);
        }
        // Required, not defaulted: `rough` now drives `uGloss`, and a biome that omits it gets
        // the matte fallback — i.e. an ice sheet would quietly lose its highlight.
        if (!(b.rough >= 0 && b.rough <= 1)) {
          problems.push(at(`biome ${b.key} needs a rough in [0, 1] (it sets the specular gloss); got ${b.rough}`));
        }
        if (b.minSlope !== undefined && b.maxSlope !== undefined && b.minSlope > b.maxSlope) {
          problems.push(at(`biome ${b.key} has minSlope ${b.minSlope} above maxSlope ${b.maxSlope}, so it never wins`));
        }
      }
      // Paired keys. Each pair is one feature split across two names, and the failure mode of a
      // half-authored feature is a *default* doing something plausible enough not to be noticed:
      // `snowLine` alone would have run the drift shader in white 0xeef4ff (luma 244, above the
      // tonemap shoulder — the texture exists and is clipped off), and `grassColorA` alone would
      // pair a zone's own blade with Mondstadt's second green.
      if ((t.snowLine !== undefined) !== (t.snowColor !== undefined)
        || (t.snowLine !== undefined) !== (t.snowBlend !== undefined)) {
        problems.push(at('terrain must author snowLine, snowBlend and snowColor together or not at all'));
      }
      if ((t.grassColorA !== undefined) !== (t.grassColorB !== undefined)) {
        problems.push(at('terrain must author both grassColorA and grassColorB'));
      }
      // Consumer pairs across sections: a colour for something the zone does not grow or build.
      if (t.grassColorA !== undefined && !z.props?.grass) {
        problems.push(at('terrain.grassColorA colours grass tufts, but this zone has no props.grass'));
      }
      for (const key of ['inlayColor', 'inlayStrength']) {
        if (t[key] !== undefined && !(arena && z.indoor)) {
          problems.push(at(`terrain.${key} needs an indoor zone with terrain.arena — the inlay branch reads uArenaR, which is 0 otherwise`));
        }
        // And the other direction, which was missing: the shader falls back to `?? 0.45` and to
        // biome #2's colour, so an arena that forgets these keys still draws rings — in its own
        // floor colour, at a strength nobody chose, and with nothing in the data to review. That
        // is the near-invisible pattern tools/inlay-cam.mjs found in two of the three arenas,
        // one authoring mistake away from a third.
        if (arena && z.indoor && t[key] === undefined) {
          problems.push(at(`terrain.${key} must be authored: an indoor arena draws a floor inlay whether or not it says so, and the fallback is the floor's own colour`));
        }
      }
      if (arena) {
        for (const key of Object.keys(arena)) {
          if (!ARENA_KEYS[key]) problems.push(at(`terrain.arena.${key} is not a key anything reads`));
          else arenaSeen.add(key);
        }
        if (!(arena.radius > 0)) problems.push(at('terrain.arena has no radius'));
        if (!(arena.wall > 0)) problems.push(at('terrain.arena has no wall height, so the room has no sides'));
        if (!z.indoor) problems.push(at('has terrain.arena but is not indoor, so the floor is flattened and never surfaced'));
      }
      if (z.indoor && !arena) problems.push(at('is indoor but has no terrain.arena (no room to be in)'));
      // The other direction of `arenaOnly`, which was only enforced one way: `props.ceiling`
      // and `props.enclosure` were rejected without an arena, but an indoor zone with no
      // ceiling was accepted — and that is the shape of the bug tools/vault-cam.mjs was
      // written for. `heightAt` ramps the ground 44 m up outside `arena.radius`, so a room
      // without a shell does not show sky when you look up, it shows the far side of that
      // ramp, which is indistinguishable from a hillside at dusk. Same for the ring: no
      // enclosure means the ramp *is* the wall.
      if (z.indoor) {
        if (!z.props?.ceiling) problems.push(at('is indoor but has no props.ceiling — looking up finds the 44 m terrain ramp'));
        if (!z.props?.enclosure) problems.push(at('is indoor but has no props.enclosure — the room has no wall, only the ramp'));
      }
    }

    /* ---- sky --------------------------------------------------------------- */
    if (z.sky) {
      for (const key of Object.keys(z.sky)) {
        if (!SKY_KEYS[key]) problems.push(at(`sky.${key} is not a key anything reads`));
        else skySeen.add(key);
      }
      // Bounded because this one multiplies the whole frame: 0.4 is a night zone, 1.6 is a
      // white-out, and a typo'd 12 would render every zone as paper.
      if (!(z.sky.exposure > 0.35 && z.sky.exposure < 1.7)) {
        problems.push(at(`sky.exposure ${z.sky.exposure} is outside (0.35, 1.7)`));
      }
      if (!(z.sky.fogFar > z.sky.fogNear)) {
        problems.push(at(`sky.fogFar ${z.sky.fogFar} must be beyond fogNear ${z.sky.fogNear}`));
      }
      for (const key of ['vaultColor', 'vaultGlow']) {
        if (z.sky[key] !== undefined && !z.indoor) {
          problems.push(at(`sky.${key} is only read for an indoor zone (the dome is swapped for VAULT_FRAG)`));
        }
      }
      if (z.indoor && z.sky.vaultColor === undefined) {
        problems.push(at('is indoor but authors no sky.vaultColor, so the vault falls back to the cliff colour'));
      }
      // The haze of a room is that room's own surfaces receding, so it cannot be brighter
      // than the shell overhead. 冰封洞窟 shipped at 1.77x (fog 0x6b8fa8 luma 137 over
      // vaultColor 0x3e5064 luma 78) and the consequence is not subtle: past ~60 m every
      // pixel at eye level is 90% fog, so the band above the wall ring metered the fog
      // colour to within 3 counts and a cave with a measured, proven lid photographed as an
      // open snowfield under a blue sky. The two dungeons that already read as interiors
      // sit at 0.62 (深渊试炼场) and 0.73 (黄金屋), so the ratio was the rule all along and
      // nobody had written it down.
      //
      // Bounded from below as well, because the failure has two ends: haze at 0.1 of the
      // shell is an inky void that hides the enclosure ring, the ceiling line and the
      // pendants that tools/vault-cam.mjs asserts on — the same "it went to zero, so of
      // course it is uniform" that the tone-curve bugs in this file's biome comments are.
      if (z.indoor && z.sky.vaultColor !== undefined && z.sky.fogColor !== undefined) {
        const fog = luma(z.sky.fogColor), vault = luma(z.sky.vaultColor);
        const ratio = fog / (vault || 1);
        if (!(ratio >= 0.30 && ratio <= 1.0)) {
          problems.push(at(`sky.fogColor luma ${fog.toFixed(1)} is ${ratio.toFixed(2)}x sky.vaultColor's`
            + ` ${vault.toFixed(1)} — indoor haze must sit in 0.30..1.0 of the vault`
            + `${ratio > 1 ? ' (brighter than the shell reads as open sky above the wall ring)' : ''}`));
        }
      }
    } else problems.push(at('has no sky'));

    /* ---- poi --------------------------------------------------------------- */
    const poiById = new Map();
    for (const poi of z.poi || []) {
      if (!poi.id) { problems.push(at('a poi has no id')); continue; }
      if (poiById.has(poi.id)) problems.push(at(`duplicate poi id ${poi.id}`));
      poiById.set(poi.id, poi);
      if (!POI_PROPS[poi.type]) problems.push(at(`poi ${poi.id} has type "${poi.type}", which no prop represents`));
      if (outside(poi.at, half)) {
        problems.push(at(`poi ${poi.id} is at ${JSON.stringify(poi.at)}, outside the ${z.size} m zone`));
      }
      if (arena && poi.at && Math.hypot(poi.at[0], poi.at[1]) > arena.radius) {
        problems.push(at(`poi ${poi.id} is outside the arena wall`));
      }
      const allowed = POI_KEYS[poi.type] || [];
      for (const key of Object.keys(poi)) {
        if (!['id', 'type', 'at', 'name'].includes(key) && !allowed.includes(key)) {
          problems.push(at(`poi ${poi.id} carries "${key}", which nothing reads for a ${poi.type}`));
        }
      }
      if (poi.type === 'chest' && !CHEST_TIERS[poi.tier || 'common']) {
        problems.push(at(`chest ${poi.id} has unknown tier "${poi.tier}"`));
      }
      if (poi.element !== undefined && !ELEMENTS[poi.element]) {
        problems.push(at(`poi ${poi.id} has unknown element "${poi.element}"`));
      }
      if (poi.type === 'puzzle') {
        const def = PUZZLE_KINDS[poi.kind];
        if (!def) problems.push(at(`puzzle ${poi.id} has unknown kind "${poi.kind}"`));
        if (!(poi.count > 0)) problems.push(at(`puzzle ${poi.id} needs a positive count`));
        // `elementalMonument` is the only kind whose element is authored per puzzle; the others
        // fix it, so an element there is a number that reads as a choice and changes nothing.
        if (def && def.element && poi.element) {
          problems.push(at(`puzzle ${poi.id} sets element "${poi.element}", but kind ${poi.kind} fixes it to ${def.element}`));
        }
        if (def && !def.element && !poi.element) {
          problems.push(at(`puzzle ${poi.id} is a ${poi.kind} and needs an element`));
        }
        // The monuments are placed on a ring by `puzzleNodes`; if the walkable search pushed
        // two of them onto each other the puzzle would look like one monument you cannot solve.
        if (def && poi.count > 1) {
          const nodes = puzzleNodes(z, poi);
          if (nodes.length !== poi.count) problems.push(at(`puzzle ${poi.id} wants ${poi.count} monuments but places ${nodes.length}`));
          for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
              if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z) < 2.4) {
                problems.push(at(`puzzle ${poi.id} monuments ${i} and ${j} are on top of each other`));
              }
            }
          }
        }
      }
      if (poi.type === 'dungeon' && !zones[poi.target]) {
        problems.push(at(`dungeon ${poi.id} leads to "${poi.target}", which is not a zone`));
      }
    }
    // `requires` is checked after the whole list is known, because a gate may precede its key.
    for (const poi of z.poi || []) {
      if (!poi.requires) continue;
      const req = String(poi.requires);
      if (req === 'clear') {
        if (!(z.chambers || []).length) {
          problems.push(at(`poi ${poi.id} requires a clear, but this zone has no chambers to clear`));
        }
        continue;
      }
      const form = Object.keys(POI_GATES).find((f) => f.endsWith(':') && req.startsWith(f));
      if (!form) { problems.push(at(`poi ${poi.id} requires "${req}", a form nothing enforces`)); continue; }
      const type = form.slice(0, -1);
      const id = req.slice(form.length);
      const dep = poiById.get(id);
      if (!dep) problems.push(at(`poi ${poi.id} requires ${req}, which is not a poi of this zone`));
      else if (dep.type !== type) problems.push(at(`poi ${poi.id} requires ${req} but ${id} is a ${dep.type}`));
    }

    /* ---- spawns and chambers ------------------------------------------------ */
    for (const s of z.spawns || []) {
      for (const e of s.enemies || []) {
        if (!ENEMIES[e]) problems.push(at(`spawn at ${JSON.stringify(s.at)} wants unknown enemy "${e}"`));
      }
      if (!(s.enemies || []).length) problems.push(at(`spawn at ${JSON.stringify(s.at)} has no enemies`));
      if (!(s.level > 0)) problems.push(at(`spawn at ${JSON.stringify(s.at)} has no level`));
      if (!(s.radius > 0)) problems.push(at(`spawn at ${JSON.stringify(s.at)} has no radius`));
      if (!(s.respawn > 0)) problems.push(at(`spawn at ${JSON.stringify(s.at)} never respawns`));
    }
    let lastFloor = 0;
    for (const c of z.chambers || []) {
      if (!(c.floor === lastFloor + 1)) problems.push(at(`chamber floors must run 1..n; found ${c.floor} after ${lastFloor}`));
      lastFloor = c.floor;
      for (const e of chamberEnemies(c)) {
        if (!ENEMIES[e]) problems.push(at(`chamber ${c.floor} wants unknown enemy "${e}"`));
      }
      // `waves` is the only chamber shape, and it is a list *of lists*: an author who
      // writes `waves: ['hilichurl']` would otherwise get one wave per letter of the id.
      if (!Array.isArray(c.waves) || !c.waves.length) {
        problems.push(at(`chamber ${c.floor} has no waves`));
      } else if (c.waves.some((w) => !Array.isArray(w) || !w.length)) {
        problems.push(at(`chamber ${c.floor} has an empty or non-array wave`));
      }
      if (c.enemies) problems.push(at(`chamber ${c.floor} still carries a flat "enemies" list; use waves`));
      if (c.disorder && !DISORDERS[c.disorder]) {
        problems.push(at(`chamber ${c.floor} wants unknown disorder "${c.disorder}"`));
      }
      if (!(c.timeLimit > 0)) problems.push(at(`chamber ${c.floor} has no timeLimit`));
      // Star thresholds are seconds remaining, so they descend: three stars is the strictest.
      if (!(Array.isArray(c.stars) && c.stars.length === 3)) problems.push(at(`chamber ${c.floor} needs three star thresholds`));
      else if (c.stars.some((s, i) => i > 0 && s >= c.stars[i - 1])) {
        problems.push(at(`chamber ${c.floor} star thresholds must descend: ${c.stars.join(',')}`));
      } else if (c.stars[0] > c.timeLimit) {
        problems.push(at(`chamber ${c.floor} one-star threshold ${c.stars[0]} exceeds its ${c.timeLimit}s limit`));
      }
    }
    if ((z.chambers || []).length && !z.domain) problems.push(at('has chambers but no domain, so a clear drops nothing'));
    if (z.domain && !(z.chambers || []).length) problems.push(at('has a domain but no chambers to run'));
    for (const s of z.domain?.sets || []) {
      if (!ARTIFACT_SETS[s]) problems.push(at(`domain drops unknown artifact set "${s}"`));
    }
    for (const m of z.domain?.mats || []) {
      if (!MATERIALS[m]) problems.push(at(`domain drops unknown material "${m}"`));
    }

    /* ---- gathers ----------------------------------------------------------- */
    for (const g of z.gathers || []) {
      if (!MATERIALS[g.kind]) problems.push(at(`gathers "${g.kind}" is not a material`));
      if (!(g.count > 0)) problems.push(at(`gathers ${g.kind} has no count`));
      if (g.perCluster !== undefined && !(g.perCluster > 0)) problems.push(at(`gathers ${g.kind} has a non-positive perCluster`));
      for (const spot of g.spots || []) {
        if (outside(spot, half)) {
          problems.push(at(`gathers ${g.kind} pins a cluster at ${JSON.stringify(spot)}, outside the zone`));
        }
      }
    }

    /* ---- npcs -------------------------------------------------------------- */
    const npcIds = new Set();
    for (const n of z.npcs || []) {
      if (npcIds.has(n.id)) problems.push(at(`duplicate npc id ${n.id}`));
      npcIds.add(n.id);
      if (!(n.lines || []).length) problems.push(at(`npc ${n.id} has no lines (the \`dialogue\` key bug)`));
      if (n.shop && !SHOPS[n.shop]) problems.push(at(`npc ${n.id} keeps unknown shop "${n.shop}"`));
      if (!n.role) problems.push(at(`npc ${n.id} has no role, so their prompt and dialogue header have no subtitle`));
      else if (!NPC_ROLES[n.role]) {
        problems.push(at(`npc ${n.id} has role "${n.role}", which has no name in NPC_ROLES — the prompt would print the slug`));
      } else roleSeen.add(n.role);
      if (n.role === 'shop' && !n.shop) problems.push(at(`npc ${n.id} has role "shop" but no shop to open`));
      if (n.quest && !QUESTS[n.quest]) problems.push(at(`npc ${n.id} offers unknown quest "${n.quest}"`));
      if (n.quest && QUESTS[n.quest]?.type !== 'story') {
        problems.push(at(`npc ${n.id} carries "${n.quest}" as its story hook, but that quest is typed `
          + `"${QUESTS[n.quest]?.type}" — extras are offered through their own giver field`));
      }
      if (outside(n.at, half)) {
        problems.push(at(`npc ${n.id} stands at ${JSON.stringify(n.at)}, outside the zone`));
      }
    }

    /* ---- weather and its forecast ------------------------------------------ */
    // `zone.weather` is the authored baseline *and* the values day 0 returns, so a typo'd type here
    // is not a cosmetic problem: it silently changes what every pinned-hour pixel probe photographs.
    if (!WEATHER_TYPES[z.weather?.type]) {
      problems.push(at(`has weather type "${z.weather?.type}", which is not one of ${Object.keys(WEATHER_TYPES).join('/')}`));
    }
    if (z.indoor && z.forecast) problems.push(at('is indoor but carries a forecast, which is never read'));
    if (!z.indoor && !z.forecast) problems.push(at('is outdoor with no forecast, so its weather never changes'));
    for (const [pi, pat] of (z.forecast || []).entries()) {
      const patAt = (m) => at(`forecast[${pi}] (${pat.name || '?'}) ${m}`);
      if (!pat.name) problems.push(patAt('has no name, and the HUD prints it'));
      const segs = pat.seg || [];
      if (!segs.length) problems.push(patAt('has no segments, so it is the baseline under another name'));
      let last = -1;
      for (const sg of segs) {
        if (!(sg.at >= 0 && sg.at < 24)) problems.push(patAt(`has a segment at hour ${sg.at}`));
        if (sg.at <= last) problems.push(patAt(`has segments out of order at hour ${sg.at}`));
        last = sg.at;
        if (sg.type !== undefined && !WEATHER_TYPES[sg.type]) problems.push(patAt(`uses unknown type "${sg.type}"`));
        if (sg.type === 'none') problems.push(patAt('uses type "none", which is the indoor sentinel, not a forecast'));
        if (sg.strength !== undefined && !(sg.strength > 0 && sg.strength <= 1)) {
          problems.push(patAt(`has strength ${sg.strength}, outside (0, 1]`));
        }
        // A segment with a strength but no type is the reverse of the "back to normal" segment: the
        // strength would be silently dropped, because a typeless segment *is* the authored baseline.
        if (sg.strength !== undefined && !sg.type) problems.push(patAt('gives a strength with no type'));
      }
      // A day that never leaves the baseline is fine as one entry of a rotation (a clear day is
      // weather too) but a whole forecast of them means the zone still never changes.
      if ((z.forecast || []).every((pp) => !(pp.seg || []).some((sg) => sg.type))) {
        problems.push(at('has a forecast where no segment ever changes the weather'));
      }
    }
    // The particle cloud is allocated once per zone from `maxStorm`, so a forecast that reaches a
    // heavier storm than the buffer supports would draw a thin one. Assert the two agree.
    if (!z.indoor) {
      const worst = maxStorm(z);
      const reached = new Set([baseWeather(z).type, ...(z.forecast || []).flatMap((pp) => (pp.seg || []).map((sg) => sg.type).filter(Boolean))]);
      if (!reached.has(worst)) problems.push(at(`maxStorm says "${worst}" but no segment or baseline asks for it`));
    }

    /* ---- mechanics and exits ----------------------------------------------- */
    const mech = z.mechanic;
    if (mech?.sheerCold) {
      if (!(mech.coldRate > 0)) problems.push(at('sheerCold with no coldRate never chills anyone'));
      if (!(mech.warmRadius > 0)) problems.push(at('sheerCold with no warmRadius makes braziers useless'));
      // Without a source of warmth the mechanic is a death timer with no counterplay.
      if (!(z.poi || []).some((p) => p.type === 'warmth')) {
        problems.push(at('sheerCold but no warmth poi, so the cold cannot be escaped'));
      }
    }
    if ((z.poi || []).some((p) => p.type === 'warmth') && !mech?.sheerCold) {
      problems.push(at('has warmth poi but no sheerCold mechanic for them to relieve'));
    }
    if (z.indoor && !z.exit) problems.push(at('is indoor with no exit, so a player who enters is stuck'));
    if (z.exit && !zones[z.exit.zone]) problems.push(at(`exit leads to "${z.exit.zone}", which is not a zone`));
    if (z.exit && !isPoint(z.exit.at)) problems.push(at('exit has no landing position'));
    if (!(z.entryRank >= 1)) problems.push(at('has no entryRank'));
    if (!isRange(z.levelRange)) problems.push(at('has no levelRange'));
    if (!z.music) problems.push(at('has no music cue'));
  }

  /* ---- declarations nothing uses ------------------------------------------ */
  for (const group of Object.keys(PROP_GROUPS)) {
    if (!groupsSeen.has(group)) problems.push(`prop group "${group}" is declared but no zone carries it`);
  }
  for (const [key, def] of Object.entries(TERRAIN_KEYS)) {
    if (!terrainSeen.has(key)) problems.push(`terrain.${key} is declared (read by ${def.by}) but no zone authors it`);
  }
  for (const key of Object.keys(BIOME_KEYS)) {
    if (!biomeSeen.has(key) && !BIOME_KEYS_OPTIONAL.has(key)) {
      problems.push(`biome key "${key}" is declared but no biome carries it`);
    }
  }
  for (const key of Object.keys(ARENA_KEYS)) {
    if (!arenaSeen.has(key)) problems.push(`terrain.arena.${key} is declared but no arena carries it`);
  }
  for (const [key, def] of Object.entries(SKY_KEYS)) {
    if (!skySeen.has(key) && !SKY_KEYS_OPTIONAL.has(key)) {
      problems.push(`sky.${key} is declared (read by ${def.by}) but no zone authors it`);
    }
  }
  for (const role of Object.keys(NPC_ROLES)) {
    if (!roleSeen.has(role)) problems.push(`npc role "${role}" has a name in NPC_ROLES but no NPC carries it`);
  }

  /* ---- who hands out the 传说/世界任务 ------------------------------------- */
  // The quest catalogue's own gate proves an extra is *offerable* (`offerableQuest` returns it
  // for its `giver`), but it cannot see `zones.js`, so a `giver: 'grocer2'` would pass there and
  // reach nobody in the world. This is the other half: the giver has to be an NPC who exists,
  // standing in the zone the quest happens in — an errand for 璃月 offered by a 蒙德 shopkeeper
  // is a quest whose objective the player has to fast-travel away from to accept.
  for (const [id, def] of Object.entries(QUESTS)) {
    if (def.type !== 'side' && def.type !== 'world') continue;
    const z = zones[def.zone];
    if (!z) continue;                                  // the quest gate reports a missing zone
    const npc = (z.npcs || []).find((n) => n.id === def.giver);
    if (!npc) {
      problems.push(`${def.zone}: quest "${id}" is given by "${def.giver}", who is not an NPC in that zone`);
    }
  }

  /* ---- 每个区域都得有人在里面做点什么 ------------------------------------- */
  // The direction that bites is the second one: a zone with terrain, camps, chests and a domain
  // but no quest pointing at it is content the tracker never mentions and the player never has a
  // reason to open. 冰封洞窟 and 黄金屋遗迹 were exactly that — and the rule above is *why* they
  // were: no NPC stands in either, so neither can host its own 传说/世界任务, and only a quest in
  // the open zone next door can send anyone in. A zone is "reached" by a quest that happens in it
  // (`def.zone`) or by an `enterZone`/`chamber` stage naming it, which is the same string the
  // locator in `questNav.js` resolves — so this cannot be satisfied by a comment or a POI.
  const questZones = new Set();
  for (const def of Object.values(QUESTS)) {
    if (def.zone) questZones.add(def.zone);
    for (const s of def.stages || []) {
      if (s.kind === 'enterZone') questZones.add(String(s.target));
      if (s.kind === 'chamber') questZones.add(String(s.target).split(':')[0]);
    }
  }
  for (const id of Object.keys(zones)) {
    if (!questZones.has(id)) {
      problems.push(`${id}: no quest happens here and no stage sends anyone here, `
        + 'so nothing in the game gives a player a reason to come');
    }
  }
  for (const id of questZones) {
    if (!zones[id]) problems.push(`a quest stage names zone "${id}", which is not a zone`);
  }

  /* ---- 送进秘境的委托不能比那扇门先到手 ----------------------------------- */
  // Two rank tests that had nothing to do with each other: an extra is handed over when
  // `rank >= rankForLevel(minLevel)` (`offerableQuest`) and a dungeon opens when
  // `rank >= zoneEntryRank(zone)` (`canEnterZone`). If the first can be true while the second is
  // false, the quest arrives with its first stage behind a locked door — no error, no hint, just a
  // tracker line that cannot advance. `sq_golden_ledger` was written at lv 50 (rank 15) against
  // 黄金屋's rank 18 and this is what turned it into lv 55.
  //
  // Story quests are excluded on purpose, and the exemption has a price: the chain grants the next
  // quest on completion *regardless of rank* (`progression.js`), so a story `minLevel` is advice
  // and 「等你练到那个阶再回来」 is the intended shape — while an extra's `minLevel` **is** its
  // offer condition. The obligation is that this gate is mutation-tested through `zones` in
  // `tools/api-check.mjs`: raise 冰封洞窟's `entryRank` and `sq_frost_relic` has to be reported.
  for (const [id, def] of Object.entries(QUESTS)) {
    if (def.type !== 'side' && def.type !== 'world') continue;
    const rankAtOffer = rankForLevel(def.minLevel || 1);
    for (const s of def.stages || []) {
      const dest = s.kind === 'enterZone' ? String(s.target)
        : s.kind === 'chamber' ? String(s.target).split(':')[0] : null;
      if (!dest || !zones[dest]) continue;
      const need = zoneEntryRank(zones[dest]);
      if (rankAtOffer < need) {
        problems.push(`quest "${id}" (lv ${def.minLevel} → rank ${rankAtOffer}) sends the player `
          + `into ${dest}, whose door needs rank ${need}`);
      }
    }
  }

  const poiTypesUsed = new Set(Object.values(zones).flatMap((z) => (z.poi || []).map((p) => p.type)));
  for (const type of Object.keys(POI_PROPS)) {
    if (!poiTypesUsed.has(type)) problems.push(`poi type "${type}" maps to a prop but no zone places one`);
  }

  /* ---- prop kinds against the builders that exist ------------------------- */
  if (scatter && single) {
    const used = propKindsUsed(zones);
    const have = { field: new Set(scatter), single: new Set(single) };
    for (const entry of used.values()) {
      if (entry.families.size > 1) {
        problems.push(`prop "${entry.kind}" is asked for as both instanced and single (${entry.why.join(', ')})`);
      }
      if (!have[entry.family].has(entry.kind)) {
        problems.push(`prop "${entry.kind}" has no ${entry.family === 'single' ? 'buildProp' : 'SCATTER'}`
          + ` builder — asked for by ${entry.why[0]}`);
      }
    }
    for (const kind of scatter) {
      if (!used.has(kind)) problems.push(`SCATTER.${kind} is built by nothing: no zone, poi or gather asks for it`);
    }
    for (const kind of single) {
      if (!used.has(kind)) problems.push(`SINGLE.${kind} is built by nothing: no zone, poi or gather asks for it`);
    }
  }

  return problems;
}
