// Zone realisation: terrain, sky, water, weather, scattered flora, ruins, POI
// structures and NPCs.
//
// The one architectural decision worth calling out is prop streaming. A zone is
// 420 m across with a grass density of 0.34/m² — a naive build is 60 000 tufts in
// one go, which is both a multi-second hitch and far more geometry than is ever
// on screen. Instead props are scattered per *cell* on a deterministic grid: the
// cell's contents come from a hash of (zone seed, kind, cell coords), so a cell
// rebuilt after the player walks away and returns is bit-identical, and cells
// outside the view radius are disposed. Each kind gets its own cell size and
// radius, because grass only needs to exist within ~70 m while a pine needs to be
// visible from across the valley.

import * as THREE from 'three';
import {
  heightAt, slopeAt, biomeAt, normalAt, findWalkable, gatherNodes, puzzleNodes, PUZZLE_KINDS,
} from '@teyvat/shared/data/zones.js';
import { POI_PROPS } from '@teyvat/shared/data/zoneGate.js';
import { Rand, hash2, hashStr, clamp, lerp, TAU } from '@teyvat/shared/sim/rng.js';
import { ELEMENTS } from '@teyvat/shared/data/elements.js';
import { Terrain, makeWater } from '../gfx/terrain.js';
import { Sky, Weather } from '../gfx/sky.js';
import { weatherAt, maxStorm } from '@teyvat/shared/world/weather.js';
import {
  buildPropField, buildProp, buildVaultCeiling, clearProtoCache, PropPool,
} from '../gfx/props.js';
import { buildHumanoid } from '../gfx/humanoid.js';
import { Animator } from '../gfx/animator.js';

/* ------------------------------------------------------ scatter definitions -- */

/**
 * Per-kind streaming parameters.
 *   cell   — grid size in metres
 *   rings  — how many cells out from the player's cell to keep resident
 *   budget — hard cap on instances per cell, so a dense recipe cannot explode
 */
const STREAM = {
  // Grass on a 24 m cell rather than 48: the budget is what is affordable per
  // *frame*, so spending it over a 144 m span puts most of it beyond the distance
  // any of it is legible, and starves the ten metres in front of the player where
  // the ground is being examined. Three rings of 24 m still cover 72 m.
  grass:    { cell: 24, rings: 1, budget: 1750, variants: 3, outline: false, sway: true, shadow: false },
  flowers:  { cell: 32, rings: 1, budget: 200, variants: 3, outline: false, shadow: false },
  // Fewer, larger cells for the long-range kinds. Each resident cell costs one
  // InstancedMesh per (variant, material) whatever it holds, so 49 tree cells at
  // 64 m was ~440 draw calls to cover the same 240 m that 25 cells at 96 m cover in
  // ~225. Cell size is a draw-call knob, not a content one: the scatter is hashed
  // from cell coordinates, so only the seams move.
  bushes:   { cell: 96, rings: 1, budget: 90, variants: 3 },
  trees:    { cell: 96, rings: 2, budget: 90, variants: 3 },
  rocks:    { cell: 96, rings: 2, budget: 85, variants: 3 },
  crystals: { cell: 96, rings: 2, budget: 60, variants: 3 },
};

const DENSITY_BY_QUALITY = { low: 0.30, medium: 0.60, high: 1.0, ultra: 1.3 };
// Named rather than inline, because the quality governor now changes tiers at runtime and
// two copies of the same table in the constructor and in `setQuality` is exactly how a
// re-tier ends up applying settings that never matched the ones it booted with.
const SHADOW_SIZE_BY_QUALITY = { low: 1024, medium: 1536, high: 2048, ultra: 3072 };
const WEATHER_COUNT_BY_QUALITY = { low: 1200, medium: 2600, high: 4000, ultra: 6000 };

/**
 * How far away a gather node keeps a visible prop. Generous compared with the size
 * of a flower, because the point of a node is to be *spotted* from a distance and
 * walked to: cutting this to 40 m makes gathering feel like the world is hiding.
 */
const GATHER_VIEW = 85;

/** Regrow window for a picked node. Must match the server's check in world.js. */
export const REGROW_MS = 6 * 60 * 60 * 1000;

/** Grid cell for the camera-blocker lookup, in metres. */
const BLOCK_CELL = 12;

/**
 * Which scatter groups block the camera, and the cylinder that stands in for
 * them (radius and vertical span in prop-scale units). Trees are trunk-only on
 * purpose: retracting the boom every time a canopy crosses it would make walking
 * through a wood feel like a lurching camera fault.
 */
const BLOCK = {
  trees: { r: 0.50, y0: 0.0, y1: 5.0 },
  rocks: { r: 1.10, y0: -0.6, y1: 1.8 },
  crystals: { r: 0.80, y0: -0.4, y1: 2.6 },
};

/** How much of a landmark clearing each scatter group has to respect. */
const CLEAR_MUL = {
  trees: 1.0, rocks: 1.0, crystals: 1.0, bushes: 0.7, flowers: 0.35, grass: 0.30,
};

// The POI type → prop mapping lives in shared/data/zoneGate.js: a type with no entry is
// silently invisible, so the table belongs next to the gate that checks every authored type
// has one and that every entry is a prop `gfx/props.js` can actually build.
const POI_PROP = POI_PROPS;

/* ------------------------------------------------------------------- NPC kit -- */

// `secondary` is the jacket and both sleeves, and it meets bare skin at the collar and at
// both elbows where no outline is drawn — so it has to differ from `skin` by eye, not just
// on paper. The first four of these were cream and beige over cream and tan skin, 30 and 39
// bytes apart, and the Mondstadt smith read as bare-chested in a screenshot. Keep every
// shirt at least ~60 bytes from the skin below it and in a different hue family; the guard
// in `gfx/humanoid.js` will drag a closer pair apart, but a dimmed cream is a worse villager
// than a sage or teal one. `tools/npc-cam.mjs` measures the elbow of every villager.
const NPC_PALETTE = [
  { primary: 0x6a7f9c, secondary: 0xa8b49a, accent: 0x8fd8e0, hairColor: 0x4a3a2c, skin: 0xf0cfae },
  { primary: 0x8a5c3c, secondary: 0x7f9a8e, accent: 0xe0a860, hairColor: 0x2a2018, skin: 0xe8c39c },
  { primary: 0x4c5a48, secondary: 0xb8c0a0, accent: 0xa8d878, hairColor: 0x6a5030, skin: 0xf4d8b8 },
  { primary: 0x6c4a6a, secondary: 0xb09cc0, accent: 0xc890e0, hairColor: 0x503048, skin: 0xefcdb0 },
  { primary: 0x3c5470, secondary: 0xc0cad8, accent: 0x78b8e8, hairColor: 0x8a7a60, skin: 0xe0bc98 },
];

/**
 * Synthesise a character-shaped `def` for an NPC.
 *
 * NPCs are not playable characters, so they have no entry in characters.js. But
 * `buildHumanoid` only needs a `body`, and deriving that body from a hash of the
 * NPC id gives every villager a stable, distinct look for free — the alternative
 * (one shared NPC model) makes a town read as a clone army.
 */
function npcDef(npc) {
  // Whole id, not length-plus-first-letter: two villagers whose ids share a length and
  // an initial were coming out as the same person in the same clothes.
  const h = hash2(hashStr(npc.id), npc.id.length, 4242);
  const pal = NPC_PALETTE[h % NPC_PALETTE.length];
  const r = new Rand(h);
  // `build` is a scalar (0 slender .. 1 broad) that feeds the torso profile
  // arithmetic directly, and `hair` must be one of the styles buildHair knows —
  // a descriptive string here silently produced a mesh full of NaN vertices.
  const hairs = ['short', 'longStraight', 'ponytail', 'bun', 'twinTail'];
  return {
    id: npc.id,
    name: npc.name,
    body: {
      height: 1.62 + r.float(0, 0.16),
      build: r.float(0.22, 0.62),
      hair: hairs[r.int(0, hairs.length - 1)],
      skin: pal.skin,
      hairColor: pal.hairColor,
      hairTip: pal.hairColor,
      primary: pal.primary,
      secondary: pal.secondary,
      accent: pal.accent,
      eye: 0x4a6a7a,
      boots: 0x3a3028,
      // No cape or skirt: NPCs stand around for the whole session, and every
      // extra sheet is a DoubleSide draw plus an outline shell on something the
      // player will never look at closely.
      cape: null,
      skirt: r.float(0, 1) < 0.4 ? r.float(0.35, 0.7) : 0,
    },
  };
}

/* ------------------------------------------------------------------- World --- */

export class World {
  constructor(zone, scene, opts = {}) {
    this.zone = zone;
    this.scene = scene;
    this.quality = opts.quality || 'high';
    this.densityScale = DENSITY_BY_QUALITY[this.quality] ?? 1.0;

    this.group = new THREE.Group();
    this.group.name = `zone:${zone.id}`;
    scene.add(this.group);

    // --- terrain / sky / water -------------------------------------------
    this.terrain = new Terrain(zone, scene);
    this.terrain.setQuality(this.quality);
    this.sky = new Sky(zone, scene);
    this.sky.setShadowQuality(
      SHADOW_SIZE_BY_QUALITY[this.quality] ?? 2048,
      this.quality !== 'low',
    );

    this.water = makeWater(zone);
    if (this.water) this.group.add(this.water);

    // Allocated for the heaviest storm the *forecast* can reach, not for today's weather: 蒙德's
    // baseline is `clear`, and without this its rainy days would have nowhere to draw. What actually
    // falls is `applyWeather`, driven by `weatherAt` — the buffer cannot grow after this line.
    this.weather = new Weather(
      maxStorm(zone),
      scene,
      WEATHER_COUNT_BY_QUALITY[this.quality] ?? 4000,
    );
    // 1 and null until the first storm and the first hour: the direct-light dim a storm applies,
    // and the last phase, so a storm can re-light the world between clock ticks.
    this._dim = 1;
    this._ph = null;
    this.applyWeather(weatherAt(zone, 0));      // day 0: the zone exactly as authored

    // --- streamed scatter -------------------------------------------------
    // One instanced batch per (proto, material) for the whole zone; cells own
    // instance slots inside it rather than meshes of their own. See PropPool.
    this.propPool = new PropPool(this.group);
    this.cells = new Map();      // `${kind}:${cx},${cz}` → slot claims per kind
    this.pending = [];           // cells queued for build, drained a few per frame
    this.recipes = this._recipes();

    // --- one-shot content -------------------------------------------------
    this.landmarks = [];         // ruins / lanterns / braziers with fixed counts
    this.pois = [];              // interactable POI entries
    this.npcs = [];              // { npc, rig, animator, group, pos }
    this.animated = [];          // anything with update(dt, t)
    this.interactables = [];     // { id, kind, x, y, z, radius, name, poi, obj }

    this._buildLandmarks();
    this._buildPois();
    this._buildGathers();
    this._buildNpcs();
    this.clearings = this._clearings();

    // Prop trunks/boulders the camera boom must not pass through, in a coarse
    // spatial grid so the seven boom samples do not walk a thousand-entry list.
    this.blockGrid = new Map();
    this.cellBlockers = new Map();   // cell key → the blockers it contributed

    this._lastCellX = null;
    this._lastCellZ = null;
    this._t = 0;
  }

  /* ----------------------------------------------------------- scatter set -- */

  _recipes() {
    const p = this.zone.props || {};
    const t = this.zone.terrain || {};
    const out = [];
    const water = this.zone.water?.level ?? -999;

    if (p.trees) {
      out.push({
        group: 'trees',
        kinds: p.trees.kinds || ['oak'],
        density: p.trees.density,
        maxSlope: p.trees.maxSlope ?? 0.42,
        // `minH` is the authored treeline: trees stop below it, which is what keeps a pine
        // out of the shallows of the lake and off the shingle at the water's edge. It was
        // declared on three zones and read by nobody until `zoneGate.js` asked who reads it.
        minY: Math.max(water + 0.6, p.trees.minH ?? -Infinity),
        scale: p.trees.scale || [0.85, 1.4],
        opts: { snowy: !!p.trees.snowy },
      });
    }
    if (p.rocks) {
      out.push({
        group: 'rocks',
        kinds: ['rock'],
        density: p.rocks.density,
        maxSlope: 0.95,
        minY: water - 1.5,
        scale: p.rocks.scale || [0.5, 2.0],
        opts: { snowy: !!p.rocks.snowy },
      });
    }
    if (p.grass) {
      out.push({
        group: 'grass',
        kinds: ['grassTuft'],
        density: p.grass.density,
        maxSlope: p.grass.maxSlope ?? 0.5,
        minY: water + 0.25,
        scale: p.grass.height || [0.4, 0.8],
        // Grass "scale" in the recipe is a height in metres; the tallest blade of the
        // proto reaches ~0.45 m, so convert rather than treating it as a multiplier.
        scaleIsHeight: 0.45,
        // Blade colour comes from the zone (`terrain.grassColorA/B`); props.js derives the
        // light and strawy shades from A. `dry` is authored too now — Dragonspine's tufts are
        // frost-killed — with Liyue's old hard-coded id test kept as the fallback.
        opts: {
          dry: p.grass.dry ?? this.zone.id === 'liyue',
          color: t.grassColorA, colorB: t.grassColorB,
        },
      });
    }
    if (p.flowers) {
      out.push({
        group: 'flowers',
        kinds: p.flowers.kinds || ['sweetFlower'],
        density: p.flowers.density,
        maxSlope: 0.42,
        minY: water + 0.4,
        scale: [0.85, 1.25],
        opts: {},
      });
    }
    if (p.bushes) {
      out.push({
        group: 'bushes',
        kinds: ['bush'],
        density: p.bushes.density,
        maxSlope: 0.45,
        minY: water + 0.4,
        scale: [0.8, 1.4],
        opts: { snowy: !!p.trees?.snowy },
      });
    }
    if (p.crystals) {
      out.push({
        group: 'crystals',
        kinds: ['crystal'],
        density: p.crystals.density,
        maxSlope: 0.85,
        minY: water - 2,
        scale: [0.7, 1.6],
        opts: { color: p.crystals.color },
      });
    }
    return out;
  }

  /* --------------------------------------------------------- fixed content -- */

  /**
   * Ruins, lanterns and braziers are declared as a *count* for the whole zone
   * rather than a density, so they are placed once at construction. They are also
   * the zone's silhouette landmarks, which is exactly why they must not stream:
   * a pagoda popping in at 120 m destroys the sense of place.
   */
  _buildLandmarks() {
    const z = this.zone;
    const p = z.props || {};
    const half = z.size / 2;
    const arena = z.terrain.arena;

    const place = (kind, count, opts = {}, spread = 1.0) => {
      if (!count) return;
      const rand = new Rand((z.seed ^ hashStr(kind)) >>> 0);
      const placements = [];
      for (let i = 0; i < count; i++) {
        let x = 0, zz = 0, ok = false;
        for (let tries = 0; tries < 40 && !ok; tries++) {
          if (arena) {
            // Dungeon: two concentric rings, leaving a clear ~18 m of floor in the
            // middle to fight in. One band hugging the wall put every pillar at the
            // edge of vision, which is why these halls read as empty plains — the eye
            // needs something at mid depth to judge the size of the room.
            const inner = i % 3 === 2;
            const per = inner ? Math.max(1, Math.round(count / 3)) : count - Math.round(count / 3);
            const idx = inner ? Math.floor(i / 3) : i - Math.floor(i / 3);
            const a = (idx / Math.max(1, per)) * TAU + (inner ? 0.4 : 0) + rand.float(-0.12, 0.12);
            const band = inner ? rand.float(0.30, 0.46) : rand.float(0.62, 0.94);
            const r = arena.radius * band * spread;
            x = Math.cos(a) * r;
            zz = Math.sin(a) * r;
          } else {
            const a = rand.angle();
            const r = rand.float(28, half - 70) * spread;
            x = Math.cos(a) * r;
            zz = Math.sin(a) * r;
          }
          // Landmarks want reasonably flat ground; a pagoda on a 45° slope floats.
          ok = slopeAt(z, x, zz) < 0.30 && heightAt(z, x, zz) > (z.water?.level ?? -999) + 0.8;
        }
        placements.push({
          x, z: zz, y: heightAt(z, x, zz) - 0.12,
          rot: rand.float(0, TAU),
          scale: rand.float(0.9, 1.18),
          variant: i,
        });
      }
      const field = buildPropField(kind, placements, {
        ...opts,
        variants: Math.min(3, count),
        seed: z.seed + kind.length,
      });
      this.group.add(field.group);
      this.landmarks.push(field);
    };

    if (p.ruins) place(p.ruins.kind, p.ruins.count, { snowy: !!p.trees?.snowy });
    if (p.lanterns) place('lantern', p.lanterns.count, {}, 0.85);

    // Braziers are individual props, not a field: each carries a real PointLight
    // and its own flame animation, which instancing cannot express.
    if (p.braziers?.count) {
      const rand = new Rand((z.seed ^ 0x5eed) >>> 0);
      const n = p.braziers.count;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + rand.float(-0.1, 0.1);
        // Every third brazier stands on the inner ring, close enough that its light
        // actually falls on the floor the player fights on.
        const r = arena
          ? arena.radius * (i % 3 === 1 ? rand.float(0.26, 0.38) : rand.float(0.62, 0.9))
          : rand.float(30, half - 90);
        const x = Math.cos(a) * r, zz = Math.sin(a) * r;
        const prop = buildProp('brazier', { color: z.id === 'frostCavern' ? 0x8fd8ff : 0xff8a3c });
        prop.group.position.set(x, heightAt(z, x, zz), zz);
        prop.group.rotation.y = rand.float(0, TAU);
        // Only the nearest few braziers should cost a real light. Beyond that the
        // flame geometry alone carries the read, and 24 point lights in one scene
        // blows past the shader's light-loop budget.
        prop.light.visible = false;
        this.group.add(prop.group);
        this.animated.push(prop);
        this.landmarks.push(prop);
        this._lights = this._lights || [];
        this._lights.push(prop);
      }
    }

    if (arena && p.enclosure) this._buildEnclosure(arena, p.enclosure);
  }

  /**
   * The dungeon's wall. `heightAt` ramps the height field 44 m up outside
   * `arena.radius`, but from inside the arena that is unlit terrain sitting at the
   * fog line — all three dungeons photographed as an endless plane with haze at the
   * edge, with no vertical scale and no sense of being in a room. This rings the
   * arena with wall segments (`abyssArch` / `iceCurtain` / `goldArcade`), each built
   * in a local frame where +X is tangential and +Z points at the centre.
   */
  _buildEnclosure(arena, e) {
    const z = this.zone;
    const r = arena.radius - (e.inset ?? 2.4);
    // Count first, span second. Choosing both independently is how a ring ends up
    // with a seam: the segments would either interpenetrate or leave a wedge of raw
    // terrain showing, and over 40 modules the error accumulates into a visible gap.
    const count = Math.max(8, Math.round((TAU * r) / (e.span ?? 8)));
    const span = (TAU * r) / count;
    const placements = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      const x = Math.cos(a) * r, zz = Math.sin(a) * r;
      placements.push({
        x, z: zz,
        // Sunk slightly: the arena floor still carries a few metres of noise, so a
        // segment sitting exactly on `heightAt` shows light under its skirting
        // wherever the ground dips away between two samples.
        y: heightAt(z, x, zz) - 0.12,
        // Same convention as the POI props: a yaw of atan2(-x, -zz) turns local +Z
        // toward the arena centre, which leaves local +X along the tangent.
        rot: Math.atan2(-x, -zz),
        variant: i,
      });
    }
    const field = buildPropField(e.kind, placements, {
      span,
      // Architecture repeats — that is what makes it read as architecture — so an
      // arcade wants one variant, while a cave wall wants its stalagmites reshuffled.
      variants: Math.min(e.variants ?? 1, count),
      // Forwarded, unlike the rest of the group: the wall's own colour is the only large
      // non-gold surface 黄金屋 has, and until this line existed the recipe could only
      // hard-code it — an authored key with nothing reading it.
      wallColor: e.wallColor,
      seed: (z.seed ^ 0xa11e) >>> 0,
      // The dungeon "sun" is near-vertical (sunDir y ≈ 0.93), so an 11 m wall casts
      // almost nothing onto floor it is not already hiding, and putting forty more
      // modules through the shadow pass would roughly double its draw calls.
      castShadow: false,
    });
    this.group.add(field.group);
    this.landmarks.push(field);
    if (z.props?.ceiling) this._buildCeiling(arena, e, field.height);
  }

  /**
   * The dungeon's ceiling. Sized off the wall it lands on rather than off numbers of
   * its own: the enclosure proto reports its own `height`, so re-proportioning a wall
   * module moves the ceiling with it instead of opening a gap along the springing —
   * which is the one failure that would put the 44 m terrain ramp back on screen.
   */
  _buildCeiling(arena, e, wallH) {
    const z = this.zone;
    const c = z.props.ceiling;
    // The floor at the centre, because that is what the wall segments are seated on
    // (`heightAt(z, x, zz) - 0.12` above) and the arena floor is nearly flat.
    const base = heightAt(z, 0, 0) - 0.12;
    const wallTop = base + wallH;
    const ceiling = buildVaultCeiling({
      ...c,
      // Derived, and deliberately not overridable from zone data: outside the wall ring
      // and below its top, so the two surfaces *intersect* rather than meet. A gap
      // between them is a slot the 44 m terrain ramp shows through, and it would be
      // invisible in the data — two numbers that have to agree should be one number.
      radius: arena.radius + (c.overhang ?? 1.0),
      rimY: wallTop - (c.drop ?? 2.2),
      seed: (z.seed ^ 0xce11) >>> 0,
    });
    this.group.add(ceiling.group);
    this.landmarks.push(ceiling);
  }

  /** POI structures, each registered as an interactable. */
  _buildPois() {
    const z = this.zone;
    for (const poi of z.poi || []) {
      const kind = POI_PROP[poi.type];
      if (!kind) continue;
      if (poi.type === 'puzzle') { this._buildPuzzle(poi); continue; }
      const [x, zz] = poi.at;
      const y = heightAt(z, x, zz);
      const opts = {};
      if (poi.type === 'chest') opts.tier = poi.tier || 'common';
      if (poi.type === 'statue') opts.color = ELEMENTS[poi.element]?.color ?? 0x8fe3f0;
      if (poi.type === 'puzzle') opts.element = poi.element || 'wind';
      if (poi.type === 'warmth') opts.color = 0xff8a3c;

      const prop = buildProp(kind, opts);
      prop.group.position.set(x, y, zz);
      // Face inward so gates and statues present their front to the map centre.
      prop.group.rotation.y = Math.atan2(-x, -zz);
      this.group.add(prop.group);
      this.animated.push(prop);

      const entry = {
        id: poi.id,
        type: poi.type,
        kind,
        name: poi.name || null,
        x, y, z: zz,
        height: prop.height ?? 2,
        radius: Math.max(2.2, (prop.radius ?? 1.5) + 1.4),
        poi,
        prop,
        done: false,
      };
      this.pois.push(entry);
      this.interactables.push(entry);
      if (prop.light) {
        // Waypoints, statues and gates are landmark lights; keep them, they are
        // few and they are what the player navigates by.
        this._lights = this._lights || [];
        this._lights.push(prop);
      }
    }
  }

  /**
   * A puzzle: `poi.count` monuments in a ring, each one interactable, solved when the last
   * one is lit (`shared/data/zones.js#puzzleNodes` owns the positions, because the server
   * validates a click against the same list).
   *
   * The puzzle keeps one entry in `this.pois` — that is what the floating label, the map pin
   * and `applyProgress` address it by — but that entry is *not* an interactable and owns no
   * prop of its own. The monuments are the interactables, and they carry `puzzleId` so a click
   * on one can name the puzzle it belongs to.
   */
  _buildPuzzle(poi) {
    const z = this.zone;
    const def = PUZZLE_KINDS[poi.kind] || PUZZLE_KINDS.elementalMonument;
    const [cx, cz] = poi.at;
    const entry = {
      id: poi.id,
      type: 'puzzle',
      kind: POI_PROP.puzzle,
      name: poi.name || def.name,
      x: cx, y: heightAt(z, cx, cz), z: cz,
      height: 3.2,
      radius: 3.0,
      poi,
      prop: null,
      nodes: [],
      done: false,
    };
    for (const node of puzzleNodes(z, poi)) {
      const prop = buildProp(POI_PROP.puzzle, { element: node.element });
      prop.group.position.set(node.x, node.y, node.z);
      prop.group.rotation.y = node.rot;
      this.group.add(prop.group);
      this.animated.push(prop);
      const it = {
        id: node.id,
        type: 'puzzle',
        puzzleId: poi.id,
        kind: POI_PROP.puzzle,
        name: poi.name || def.name,
        x: node.x, y: node.y, z: node.z,
        height: prop.height ?? 3,
        radius: Math.max(2.2, (prop.radius ?? 0.7) + 1.4),
        poi,
        node,
        puzzle: entry,
        prop,
        done: false,
      };
      entry.nodes.push(it);
      this.interactables.push(it);
    }
    this.pois.push(entry);
  }

  /** Light one monument (or all of them, when the puzzle is solved). */
  markPuzzleLit(nodeId) {
    for (const p of this.pois) {
      const it = (p.nodes || []).find((n) => n.id === nodeId);
      if (!it || it.done) continue;
      it.done = true;
      it.prop.setLit?.(true);
      return true;
    }
    return false;
  }

  markPuzzleSolved(poiId) {
    const p = this.poiById(poiId);
    if (!p) return false;
    p.done = true;
    for (const it of p.nodes || []) { it.done = true; it.prop.setLit?.(true); }
    return true;
  }

  /** How many monuments of a puzzle are lit, and how many there are. */
  puzzleProgress(poiId) {
    const p = this.poiById(poiId);
    const nodes = p?.nodes || [];
    return { lit: nodes.filter((n) => n.done).length, total: nodes.length };
  }

  /**
   * Gatherable nodes.
   *
   * The node *records* are permanent — there are under a hundred per zone and each
   * one carries persistent picked/regrow state — but their *props* are streamed by
   * distance. A flower is 30 cm across and 400 draw calls of them spread over 420 m
   * would be four hundred draw calls of nothing.
   */
  _buildGathers() {
    this.gathers = [];
    for (const node of gatherNodes(this.zone)) {
      const entry = {
        id: node.id,
        type: 'gather',
        kind: node.kind,
        propKind: node.prop,
        color: node.color,
        name: null,
        x: node.x, y: node.y, z: node.z,
        height: 0.5,
        radius: 1.9,
        prop: null,
        done: false,
        regrowAt: 0,
      };
      this.gathers.push(entry);
      this.interactables.push(entry);
    }
  }

  /** Realise the props of gather nodes in view, dispose the rest. */
  _streamGathers(px, pz) {
    for (const g of this.gathers) {
      // Range by size, not one number for everything: an ore outcrop is a metre of
      // bright crystal and worth drawing from far enough away to be walked *to*, a
      // 25 cm flower is invisible past twenty metres and would only be spending
      // draw calls on a pixel.
      const view = g.propKind === 'oreNode' ? GATHER_VIEW : GATHER_VIEW * 0.55;
      const near = (g.x - px) ** 2 + (g.z - pz) ** 2 < view * view;
      // A picked node keeps its record but shows nothing until it regrows, which is
      // also what tells the player they have already been here.
      const want = near && !g.done;
      if (want && !g.prop) {
        // Plants get scaled up. A gatherable has to be distinguishable from the
        // thousands of decorative flowers the scatter strews around it, and size is
        // the only channel that works at every distance — the alternative, a marker
        // floating above it, is UI pretending to be world.
        const s = g.propKind === 'oreNode' ? 1.0 : 1.55;
        const prop = this.propPool.acquire(g.propKind, [{
          x: g.x, y: g.y, z: g.z,
          rot: (g.x * 0.7 + g.z * 1.3) % TAU,
          scale: s,
        }], {
          // One shape per kind, not one per node. The pool charges a draw call per
          // distinct proto, so a per-node seed cost 72 draw calls and 72 geometry
          // merges for 72 ore outcrops; even four seeds per kind came out worse than
          // the per-node meshes it replaced for the kinds with only a dozen nodes.
          // Every node of a kind is the same species anyway — what distinguishes one
          // from the next in play is where it is and which way it faces.
          seed: 1,
          color: g.color,
          variants: 1,
        });
        g.prop = prop;
        g.height = (prop.height ?? 0.5) * s;
        // Tight: a ground click within this radius is read as "gather that", and a
        // zone has dozens of nodes — a generous radius turns every walk-click near a
        // flower bed into an unwanted harvest.
        g.radius = Math.max(1.9, (prop.radius ?? 0.5) * s + 1.2);
      } else if (!want && g.prop) {
        g.prop.release();
        g.prop = null;
      }
    }
  }

  /** Called after a successful pick: hide the node and start its regrow timer. */
  markGathered(nodeId, regrowMs = REGROW_MS) {
    const g = this.gathers.find((n) => n.id === nodeId);
    if (!g) return null;
    g.done = true;
    g.regrowAt = Date.now() + regrowMs;
    if (g.prop) {
      g.prop.release();
      g.prop = null;
    }
    return g;
  }

  _buildNpcs() {
    const z = this.zone;
    for (const npc of z.npcs || []) {
      const [x, zz] = npc.at;
      const [wx, wy, wz] = findWalkable(z, x, zz, 0.42);
      const def = npcDef(npc);
      const rig = buildHumanoid(def, { outline: true });
      rig.group.position.set(wx, wy, wz);
      // Turn to face the hub, which is where the player arrives from.
      rig.group.rotation.y = Math.atan2(-wx, -wz);
      this.group.add(rig.group);
      const animator = new Animator(rig);
      animator.play('idle');
      const entry = {
        npc, def, rig, animator,
        x: wx, y: wy, z: wz,
        height: rig.height,
        radius: 2.6,
        id: npc.id,
        type: 'npc',
        name: npc.name,
        // Idle personality: a small phase offset so a group of NPCs does not
        // breathe in lockstep.
        phase: Math.random() * 10,
      };
      this.npcs.push(entry);
      this.interactables.push(entry);
    }
  }

  /**
   * Circles the scatter has to leave alone.
   *
   * A pine growing through the teleport waypoint, or a boulder sitting on the
   * quest-giver you are supposed to talk to, is the tell-tale sign of procedural
   * placement nobody ever looked at — and since the player spawns *on* a
   * waypoint, it was the first thing visible in the game.
   */
  _clearings() {
    const out = [];
    for (const it of this.interactables) {
      const base = it.type === 'npc' ? 2.8
        : it.type === 'dungeon' ? 8.0
          : it.type === 'statue' ? 7.0
            : it.type === 'waypoint' ? 6.5
              // One monument of a puzzle, not the whole puzzle: the ring's *middle* is
              // cleared below, so that a wood cannot grow between two monuments the player
              // has to walk between and see from each other.
              : it.type === 'puzzle' ? 3.6
                : 3.4;
      out.push({ x: it.x, z: it.z, r: base });
    }
    for (const p of this.pois) {
      if (p.type !== 'puzzle' || !p.nodes?.length) continue;
      const r = Math.max(...p.nodes.map((n) => Math.hypot(n.x - p.x, n.z - p.z)));
      out.push({ x: p.x, z: p.z, r: r + 2.5 });
    }
    for (const l of this.landmarks) {
      // Brazier props expose a group; instanced fields do not have a single
      // position, and their own placement already avoids the zone centre.
      const g = l.group;
      if (g && !g.isInstancedMesh && l.height != null) out.push({ x: g.position.x, z: g.position.z, r: 4.0 });
    }
    return out;
  }

  /**
   * True if (x, z) is inside a landmark clearing. `mul` shrinks the radius for
   * small props: grass and flowers at the foot of a waypoint look tended, a tree
   * there looks broken.
   */
  _inClearing(x, z, mul) {
    for (const c of this.clearings) {
      const r = c.r * mul;
      const dx = x - c.x, dz = z - c.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------- streaming -- */

  _cellKey(group, cx, cz) { return `${group}:${cx},${cz}`; }

  /* ------------------------------------------------ camera-blocking props -- */

  _blockKey(x, z) { return `${Math.floor(x / BLOCK_CELL)},${Math.floor(z / BLOCK_CELL)}`; }

  _addBlockers(list) {
    for (const b of list) {
      const k = this._blockKey(b.x, b.z);
      let bucket = this.blockGrid.get(k);
      if (!bucket) this.blockGrid.set(k, (bucket = []));
      bucket.push(b);
    }
  }

  _removeBlockers(list) {
    for (const b of list) {
      const k = this._blockKey(b.x, b.z);
      const bucket = this.blockGrid.get(k);
      if (!bucket) continue;
      const i = bucket.indexOf(b);
      if (i >= 0) bucket.splice(i, 1);
      if (!bucket.length) this.blockGrid.delete(k);
    }
  }

  /**
   * Is this point inside a trunk or boulder? Used by the camera boom, which
   * otherwise happily parks itself inside the rock the player spawned next to.
   */
  blockedAt(x, y, z) {
    const gx = Math.floor(x / BLOCK_CELL), gz = Math.floor(z / BLOCK_CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.blockGrid.get(`${gx + dx},${gz + dz}`);
        if (!bucket) continue;
        for (const b of bucket) {
          if (y < b.y0 || y > b.y1) continue;
          const ox = x - b.x, oz = z - b.z;
          if (ox * ox + oz * oz < b.r * b.r) return true;
        }
      }
    }
    return false;
  }

  /** Build the scatter for one cell of one recipe. */
  _buildCell(rec, cx, cz) {
    const cfg = STREAM[rec.group];
    const key = this._cellKey(rec.group, cx, cz);
    if (this.cells.has(key)) return;

    const z = this.zone;
    const size = cfg.cell;
    const x0 = cx * size, z0 = cz * size;
    const half = z.size / 2;
    // Cells wholly outside the playable area are recorded as empty rather than
    // skipped, so we do not retry them every time the player's cell changes.
    if (x0 > half || x0 + size < -half || z0 > half || z0 + size < -half) {
      this.cells.set(key, null);
      return;
    }

    // Seeded from the whole group name, not its length: 'trees' and 'rocks' are both
    // five characters, so the old `rec.group.length * 6151` gave both groups the same
    // cell stream and the first rock in a cell was placed inside the first tree.
    const rand = new Rand(hash2(cx, cz, (z.seed ^ hashStr(rec.group)) >>> 0));
    const want = Math.min(
      cfg.budget,
      Math.round(rec.density * size * size * this.densityScale),
    );
    if (want <= 0) { this.cells.set(key, null); return; }

    const arena = z.terrain.arena;
    const clearMul = CLEAR_MUL[rec.group] ?? 1.0;
    // Split by kind: buildPropField takes one kind, so a recipe listing
    // ['oak','pine'] becomes two fields sharing this cell's lifetime.
    const byKind = new Map();
    for (let i = 0; i < want; i++) {
      const x = x0 + rand.float(0, size);
      const zz = z0 + rand.float(0, size);
      if (Math.abs(x) > half - 4 || Math.abs(zz) > half - 4) continue;
      if (arena && Math.hypot(x, zz) > arena.radius - 2) continue;
      const y = heightAt(z, x, zz);
      if (y < rec.minY) continue;
      if (slopeAt(z, x, zz) > rec.maxSlope) continue;
      if (this._inClearing(x, zz, clearMul)) continue;

      const kind = rec.kinds[rand.int(0, rec.kinds.length - 1)];
      let scale;
      if (rec.scaleIsHeight) {
        scale = rand.float(rec.scale[0], rec.scale[1]) / rec.scaleIsHeight;
      } else {
        scale = rand.float(rec.scale[0], rec.scale[1]);
      }
      // Sink slightly so the base is never floating over a dip between samples.
      const n = normalAt(z, x, zz);
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push({
        x, y: y - 0.06 * scale, z: zz,
        rot: rand.float(0, TAU),
        scale,
        scaleY: scale * rand.float(0.9, 1.14),
        // Lean with the ground, capped: fully aligning to a steep normal lays a
        // tree flat on a hillside.
        tilt: [clamp(-n[2] * 0.55, -0.34, 0.34), clamp(n[0] * 0.55, -0.34, 0.34)],
      });
    }

    if (byKind.size === 0) { this.cells.set(key, null); return; }

    const fields = [];
    for (const [kind, placements] of byKind) {
      const field = this.propPool.acquire(kind, placements, {
        ...rec.opts,
        variants: Math.min(cfg.variants, Math.max(1, placements.length)),
        // One seed per (zone, kind), deliberately *not* per cell or per cell parity.
        // The pool draws one call per distinct proto, so every extra seed set is
        // paid for in draw calls for as long as the zone is loaded; variety comes
        // from `variants` (a proto set every cell draws from) plus the per-instance
        // yaw, tilt and scale, which is what the eye actually reads at 20 m.
        seed: hash2(z.seed & 0xffff, hashStr(kind), 0x5bd1),
        outline: cfg.outline !== false,
        // Grass and flowers do not cast, and this is a resolution argument rather than
        // a budget one: the sun's shadow map is 2048 texels over a 156 m span, so one
        // texel is 7.6 cm and a 3 cm blade cannot register in it. Switching grass to
        // castShadow put 1.1 M triangles through the depth pass and changed nothing
        // visible. Depth *inside* the canopy comes from the root-darkening gradient on
        // the blade materials instead (see `rootDark` in gfx/toon.js), which is free
        // and does not depend on texel size. Grass still *receives*, so a tree's
        // shadow or the player's own darkens the blades it falls on.
        castShadow: cfg.shadow !== false,
      });
      fields.push(field);
    }
    this.cells.set(key, fields);

    const bk = BLOCK[rec.group];
    if (bk) {
      const blockers = [];
      for (const list of byKind.values()) {
        for (const p of list) {
          blockers.push({
            x: p.x, z: p.z, r: bk.r * p.scale,
            y0: p.y + bk.y0 * p.scaleY, y1: p.y + bk.y1 * p.scaleY,
          });
        }
      }
      this.cellBlockers.set(key, blockers);
      this._addBlockers(blockers);
    }
  }

  _disposeCell(key) {
    const fields = this.cells.get(key);
    this.cells.delete(key);
    const blockers = this.cellBlockers.get(key);
    if (blockers) {
      this._removeBlockers(blockers);
      this.cellBlockers.delete(key);
    }
    if (!fields) return;
    // Pool-backed: the meshes are the zone's, so a cell only gives its slots back.
    for (const f of fields) f.release();
  }

  /** Recompute which cells should be resident. */
  _restream(px, pz) {
    const wanted = new Set();
    for (const rec of this.recipes) {
      const cfg = STREAM[rec.group];
      const cx = Math.floor(px / cfg.cell);
      const cz = Math.floor(pz / cfg.cell);
      for (let dz = -cfg.rings; dz <= cfg.rings; dz++) {
        for (let dx = -cfg.rings; dx <= cfg.rings; dx++) {
          // Round the corners of the square ring: the diagonal cell of a 3-ring
          // grid is 4.2 cells away and never visible through the fog.
          if (dx * dx + dz * dz > (cfg.rings + 0.5) * (cfg.rings + 0.5)) continue;
          const key = this._cellKey(rec.group, cx + dx, cz + dz);
          wanted.add(key);
          if (!this.cells.has(key)) {
            this.pending.push({ rec, cx: cx + dx, cz: cz + dz, key, d: dx * dx + dz * dz });
          }
        }
      }
    }
    // Evict anything no longer wanted.
    for (const key of [...this.cells.keys()]) {
      if (!wanted.has(key)) this._disposeCell(key);
    }
    // Nearest first, so what the player is looking at appears first.
    this.pending.sort((a, b) => a.d - b.d);
  }

  /** Build queued cells under a time budget so streaming never drops a frame. */
  _drainPending(budgetMs) {
    if (!this.pending.length) return;
    const t0 = performance.now();
    while (this.pending.length && performance.now() - t0 < budgetMs) {
      const job = this.pending.shift();
      if (this.cells.has(job.key)) continue;
      this._buildCell(job.rec, job.cx, job.cz);
    }
  }

  /** Build every cell that would be resident at `(x, z)` — used during boot. */
  prewarm(x, z) {
    this._restream(x, z);
    while (this.pending.length) {
      const job = this.pending.shift();
      if (!this.cells.has(job.key)) this._buildCell(job.rec, job.cx, job.cz);
    }
    this._lastCellX = Math.floor(x / 32);
    this._lastCellZ = Math.floor(z / 32);
  }

  /* ----------------------------------------------------------------- frame -- */

  /**
   * Push one instant of the day into everything that is lit by the sky.
   *
   * Indoor zones return without touching anything: 深渊试炼场 / 冰封洞窟 / 黄金屋 are underground,
   * their dome is the vault shader and their light rig is the braziers. That is also why half the
   * art gates cannot be moved by the day/night cycle at all.
   */
  applyDaylight(ph) {
    if (this.zone.indoor) return;
    // Kept so `applyWeather` can re-light the world when a storm arrives without waiting for the
    // clock's next six-minute tick — and so the dim factor is always applied to a freshly computed
    // phase instead of to whatever the last one left behind.
    this._ph = ph;
    this.sky.applyDaylight(ph, this._dim);
    this.terrain.applyDaylight(ph, this._dim);
    this.water?.applyDaylight?.(ph, this._dim);
  }

  /**
   * Apply one instant of the weather. Indoor zones return early for the same reason they do above:
   * a vault has no sky to have weather in, which also means this feature cannot move any of the
   * three dungeons' calibrated frames.
   */
  applyWeather(w) {
    if (this.zone.indoor) return;
    this.sky.applyWeather(w);
    this.weather.setStorm(w.type, w.intensity);
    // A storm dims the world it falls on. `Sky` owns the factor (it is derived from the zone's own
    // baseline cloudiness), `World` owns the two things that have to agree about it: the
    // DirectionalLight that lights props and characters, and the terrain, whose light term is a
    // uniform of its own.
    if (this.sky.stormDim !== this._dim) {
      this._dim = this.sky.stormDim;
      if (this._ph) this.applyDaylight(this._ph);
    }
  }

  update(dt, t, px, py, pz, camera) {
    this._t = t;
    this.terrain.update(px, pz, dt);
    this.sky.update(dt, camera, px, py, pz);
    this.weather.update(dt, camera);
    if (this.water) {
      this.water.material.uniforms.uTime.value = t;
      // Follow the player so a modest water plane covers the visible ocean.
      this.water.position.x = px;
      this.water.position.z = pz;
    }

    // Restream on a 32 m hysteresis grid rather than every frame: the cell math
    // is cheap but the eviction scan over every resident cell is not.
    const gx = Math.floor(px / 32), gz = Math.floor(pz / 32);
    if (gx !== this._lastCellX || gz !== this._lastCellZ) {
      this._lastCellX = gx;
      this._lastCellZ = gz;
      this._restream(px, pz);
    }
    this._drainPending(2.5);
    // Cheap: under a hundred squared-distance tests, and it has to run more often
    // than the 32 m cell hysteresis or a node pops in only after the player has
    // walked past it.
    if (this._gatherTick === undefined || t - this._gatherTick > 0.5) {
      this._gatherTick = t;
      this._streamGathers(px, pz);
    }

    for (const a of this.animated) a.update?.(dt, t);

    // NPC idle animation.
    for (const n of this.npcs) {
      n.animator.update(dt, { speed: 0, grounded: true, auto: true });
    }

    // Only the closest handful of braziers keep a live light: 24 point lights in one
    // scene blows past the shader's light-loop budget.
    if (this._lights) {
      const budget = this.quality === 'low' ? 2 : this.quality === 'medium' ? 4 : 6;
      // Indoors the reach is the whole arena. The braziers ring the wall 40-60 m out,
      // so the old 30 m cutoff meant a player standing in the middle of a dungeon had
      // *no* live lights at all — every one of them was flame geometry lighting nothing.
      const reach2 = this.zone.indoor ? 5200 : 900;
      const list = this._lights;
      // Nearest-k rather than first-k. Once the cutoff covers the whole ring, taking
      // the first six in list order lights an arbitrary arc of the wall and leaves the
      // side the player is facing dark.
      const pick = (this._litPick ||= []);
      pick.length = 0;
      for (let i = 0; i < list.length; i++) {
        const g = list[i].group;
        const d2 = (g.position.x - px) ** 2 + (g.position.z - pz) ** 2;
        if (d2 >= reach2) continue;
        // Insertion into a k-length sorted buffer: k is 6, so this beats sorting 24.
        let at = pick.length;
        while (at > 0 && pick[at - 1].d2 > d2) at--;
        if (at >= budget) continue;
        pick.splice(at, 0, { i, d2 });
        if (pick.length > budget) pick.length = budget;
      }
      for (let i = 0; i < list.length; i++) {
        const want = pick.some((p) => p.i === i);
        if (list[i].light.visible !== want) list[i].light.visible = want;
      }
    }
  }

  /* ------------------------------------------------------------- utilities -- */

  heightAt(x, z) { return heightAt(this.zone, x, z); }
  slopeAt(x, z) { return slopeAt(this.zone, x, z); }
  groundColor(x, z) { return biomeAt(this.zone, x, z).color; }

  get waterLevel() { return this.zone.water?.level ?? -999; }

  /** Nearest interactable within its own radius of (x, z), or null. */
  nearestInteractable(x, y, z) {
    let best = null, bestD = Infinity;
    for (const it of this.interactables) {
      // A picked gather node has no prop to walk up to, so it must not offer a
      // prompt either — otherwise the player is invited to harvest bare ground.
      if (it.type === 'gather' && (it.done || !it.prop)) continue;
      const dx = it.x - x, dz = it.z - z, dy = (it.y ?? y) - y;
      // Vertical tolerance matters in dungeons where a chest can be on a ledge.
      if (Math.abs(dy) > 6) continue;
      const d = Math.hypot(dx, dz);
      if (d > it.radius) continue;
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  /**
   * The interactable the cursor is actually pointing at, or null.
   *
   * `nearestInteractable` answers a different question — "is there something to use near this
   * patch of ground" — and it is the wrong one for a click aimed at a *body*: the ground point
   * under an NPC's torso is metres behind them, and under a node on a rise it is metres short,
   * so a squarely-aimed click fell through to 点哪走哪 and the player walked past the thing they
   * clicked. This is a sphere test against the ray instead, so anywhere on the silhouette works.
   *
   * Spheres rather than meshes on purpose: interactables are logical points (`{x, y, z, radius,
   * type}`) whose props are merged instances shared with the scenery, so there is no per-object
   * mesh to hit — and a chest-sized sphere is what the player is aiming at anyway. Ties go to
   * the nearest along the ray, so a chest in front of a waypoint wins.
   */
  pickInteractable(raycaster, maxDist = 90) {
    const ray = raycaster.ray;
    let best = null, bestT = Infinity;
    for (const it of this.interactables) {
      if (it.type === 'gather' && (it.done || !it.prop)) continue;
      const gy = it.y ?? this.heightAt(it.x, it.z);
      // Aim at the middle of the body, not at its feet: everything the player clicks stands up
      // out of the ground, and `radius` is the *walk-up* range, which is wider than the prop.
      const cy = gy + Math.min(1.4, Math.max(0.5, (it.radius ?? 2) * 0.5));
      const cx = it.x, cz = it.z;
      // Distance along the ray to the closest approach; behind the camera does not count.
      const t = (cx - ray.origin.x) * ray.direction.x + (cy - ray.origin.y) * ray.direction.y
        + (cz - ray.origin.z) * ray.direction.z;
      if (t <= 0 || t > maxDist) continue;
      const px = ray.origin.x + ray.direction.x * t;
      const py = ray.origin.y + ray.direction.y * t;
      const pz = ray.origin.z + ray.direction.z * t;
      const miss = Math.hypot(px - cx, py - cy, pz - cz);
      // A generous but bounded silhouette: big enough to hit a hilichurl-sized body at 40 m,
      // small enough that two chests a few metres apart are still two different targets.
      if (miss > Math.max(1.1, Math.min(2.4, (it.radius ?? 2) * 0.7))) continue;
      if (t < bestT) { bestT = t; best = it; }
    }
    return best;
  }

  poiById(id) { return this.pois.find((p) => p.id === id) || null; }

  /** Mark a chest as opened (from the server's world progress). */
  markOpened(poiId) {
    const p = this.poiById(poiId);
    if (!p || p.done) return false;
    p.done = true;
    p.prop?.open?.();
    p.prop?.setLit?.(true);
    return true;
  }

  /**
   * Apply the player's saved world progress on entry.
   *
   * Shape is the server's `worldProgress`: a map of zone id → poi id → a record
   * whose *keys* say what happened (`{opened}`, `{solved}`, `{unlocked}`, `{lit}`
   * for one monument of a puzzle, or `{at}` for a gather node's regrow timestamp).
   * Gather keys are prefixed `g:` and puzzle monuments `p:`.
   *
   * Not every row in the table is a place. `x:` rows are per-zone bookkeeping — right now the one
   * `x:explore` mark saying how far up the 探索度 milestone ladder this zone has been paid
   * (`shared/data/exploration.js`). Skipped explicitly rather than left to fall through
   * `poiById` returning null, because that fall-through is also what a *typo* in a POI id looks
   * like, and one of the two should be silent while the other is not.
   */
  applyProgress(progress) {
    if (!progress) return;
    const zp = progress[this.zone.id];
    if (!zp) return;
    for (const [poiId, rec] of Object.entries(zp)) {
      if (!rec) continue;
      if (poiId.startsWith('x:')) continue;
      if (poiId.startsWith('p:')) {
        if (rec.lit) this.markPuzzleLit(poiId.slice(2));
        continue;
      }
      if (poiId.startsWith('g:')) {
        // A picked node stays picked for the regrow window; past that the server
        // will allow it again, so the prop has to come back too.
        const left = REGROW_MS - (Date.now() - (rec.at || 0));
        if (left > 0) this.markGathered(poiId.slice(2), left);
        continue;
      }
      const p = this.poiById(poiId);
      if (!p) continue;
      if (rec.opened) {
        this.markOpened(poiId);
      } else if (rec.solved) {
        // A solved puzzle lights every monument of its ring, including saves made before
        // puzzles had rings — those have the `{solved}` record and no `p:` keys at all.
        this.markPuzzleSolved(poiId);
        p.done = true;
        p.prop?.setLit?.(true);
      }
      if (rec.unlocked) {
        p.unlocked = true;
        // An unlocked waypoint/statue reads as active rather than dormant.
        p.prop?.setLit?.(true);
      }
    }
  }

  setQuality(q) {
    this.quality = q;
    this.densityScale = DENSITY_BY_QUALITY[q] ?? 1.0;
    this.terrain.setQuality(q);
    this.sky.setShadowQuality(SHADOW_SIZE_BY_QUALITY[q] ?? 2048, q !== 'low');
    this.weather.setCount(WEATHER_COUNT_BY_QUALITY[q] ?? 4000);
    // Density changed, so every resident cell is stale.
    for (const key of [...this.cells.keys()]) this._disposeCell(key);
    this._lastCellX = null;
    this._lastCellZ = null;
  }

  dispose() {
    for (const key of [...this.cells.keys()]) this._disposeCell(key);
    for (const l of this.landmarks) l.dispose?.();
    for (const n of this.npcs) {
      n.rig.group.parent?.remove(n.rig.group);
      n.rig.dispose?.();
    }
    for (const p of this.pois) {
      p.prop?.dispose?.();
      for (const n of p.nodes || []) n.prop?.dispose?.();
    }
    for (const g of this.gathers) g.prop?.dispose?.();
    // After everything that holds slots has given them back, so the pool is not
    // tearing down meshes other objects still hold claims in.
    this.propPool.dispose();
    this.terrain.dispose();
    this.sky.dispose();
    this.weather.dispose();
    if (this.water) {
      this.water.geometry.dispose();
      this.water.material.dispose();
      this.group.remove(this.water);
    }
    // Prop protos are keyed by kind and options, both of which change wholesale
    // with the zone, so nothing in the cache is worth carrying into the next one.
    clearProtoCache();
    this.scene.remove(this.group);
  }
}
