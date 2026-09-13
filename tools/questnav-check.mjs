// 任务导航 probe: does every quest objective have a place, and is that place on screen?
//
//   DISPLAY=:99 node tools/questnav-check.mjs [baseUrl] [outDir]
//
// The tracker used to print the objective and nothing else — 「击败 5 只霜狼」 in a 380 m zone
// with five camps and no labels. That sentence is not an instruction, and the story chain
// stalled on knowledge the game never gave. So there are three separate claims here, and a
// green on one says nothing about the others:
//
//   1. **Every stage kind can be located, both ways.** `STAGE_LOCATORS` against
//      `QUEST_EVENT_SOURCES`: a kind with no locator is an objective with no arrow, a locator
//      no stage uses is dead code. Then the stronger one — every stage of every quest actually
//      resolves. That assertion found the hole it was written for: 暴风之主 exists only in the
//      last chamber of 黄金屋遗迹, never in a camp, so the final story quest's kill stage
//      resolved to nothing.
//   2. **The answers are answers.** A resolved place is checked against the zone data it came
//      from (the npc's own coordinates, the poi's own `at`), an opened chest is not a
//      destination, the nearest camp is the nearest to *the player*, and a target in another
//      zone answers with the door in this one rather than a shrug.
//   3. **It is on screen, and it points the right way.** Distance and bearing are compared
//      against the game's own state, the minimap marker is counted in canvas pixels with a
//      control that must move it, and the full map's pin is compared against the map's own
//      world→screen transform. Then the loop closes: walking to where the arrow points and
//      interacting finishes the stage, and the arrow moves to the next objective.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';
import { ZONES } from '../shared/src/data/zones.js';
import { ENEMIES } from '../shared/src/data/enemies.js';
import { QUESTS, QUEST_EVENT_SOURCES } from '../shared/src/data/quests.js';
import { STAGE_LOCATORS, questTarget, trackedQuest, questNavGateReport } from '../shared/src/data/questNav.js';
import { KEYMAP, keyGlyph } from '../client/src/game/input.js';
import { decodePng } from './lib/png.mjs';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/questnav-check';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0, skip = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}
function note(name, why) { skip++; console.log(`  SKIP ${name} — ${why}`); }

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const code = {
  hud: read('client/src/ui/hud.js'),
  mapview: read('client/src/ui/mapview.js'),
  panels: read('client/src/ui/panels.js'),
  css: read('client/src/ui/style.css'),
  nav: read('shared/src/data/questNav.js'),
  navtext: read('client/src/ui/navtext.js'),
};
/** Source with its comments removed, for the rules about what the code must not contain. */
const nocomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** A standing start in a quest's own zone — the state the gate reasons about. */
const at = (zoneId, x = 0, z = 0, extra = {}) => ({ zoneId, pos: { x, z }, ...extra });
const stageTarget = (id, i, ctx) => questTarget(QUESTS[id], { state: 'active', stageIndex: i, counters: {} }, ctx);

/* ============================================== 1. every objective has a place ==== */

console.log('--- 1. every stage kind can be located, both ways');

const kinds = Object.keys(QUEST_EVENT_SOURCES);
check('the event vocabulary is non-empty, so the two-way test below can fail',
  kinds.length >= 8 && Object.keys(STAGE_LOCATORS).length >= 8,
  `${kinds.length} kinds, ${Object.keys(STAGE_LOCATORS).length} locators`);
check('every stage kind a quest waits on has a locator',
  kinds.every((k) => STAGE_LOCATORS[k]),
  kinds.filter((k) => !STAGE_LOCATORS[k]).join(' ') || `all ${kinds.length}`);
check('...and every locator resolves a kind some stage waits on',
  Object.keys(STAGE_LOCATORS).every((k) => kinds.includes(k)),
  Object.keys(STAGE_LOCATORS).filter((k) => !kinds.includes(k)).join(' ') || 'no orphans');
check('...and each locator says what it looks in',
  Object.values(STAGE_LOCATORS).every((l) => l.what && (l.from || l.panel)),
  Object.entries(STAGE_LOCATORS).filter(([, l]) => !l.what || !(l.from || l.panel)).map(([k]) => k).join(' ') || 'all documented');

const gate = questNavGateReport();
check('the gate is clean', gate.length === 0, gate.join(' | ') || `${Object.keys(QUESTS).length} quests walked`);

// Resolve every stage of every quest from its own zone and report the table, so a regression
// is legible as *which* objective lost its place rather than as a count.
const rows = [];
for (const [id, def] of Object.entries(QUESTS)) {
  for (let i = 0; i < def.stages.length; i++) {
    const t = stageTarget(id, i, at(def.zone || 'mondstadt'));
    rows.push({ id, i, stage: def.stages[i], t });
  }
}
check('every stage of every quest resolves to something', rows.every((r) => r.t),
  rows.filter((r) => !r.t).map((r) => `${r.id}.${r.stage.id}`).join(' ') || `${rows.length} stages`);
check('...and every place is inside its zone and named', rows.filter((r) => r.t?.kind === 'place')
  .every((r) => r.t.name && Math.abs(r.t.x) <= ZONES[r.t.zone].size / 2 && Math.abs(r.t.z) <= ZONES[r.t.zone].size / 2),
  `${rows.filter((r) => r.t?.kind === 'place').length} places`);
// A name is read by a player, so it may not be an id. 「采集点（sweetFlower）」 was one: the
// gather resolver printed the key it looked the node up by.
check('...and no name leaks an id the player has never seen',
  rows.filter((r) => r.t?.name).every((r) => !/[A-Za-z]{4,}/.test(r.t.name)),
  rows.filter((r) => /[A-Za-z]{4,}/.test(r.t?.name || '')).map((r) => r.t.name).join(' ') || 'all in Chinese');

// Read from its own zone, every objective is either in front of the player or in the room; the
// reading positions a player actually has are all five zones, and that is where the fourth shape
// (「打开地图传送」) comes from. Nothing may resolve to nothing from any of them.
const everywhere = [];
for (const [id, def] of Object.entries(QUESTS)) {
  for (let i = 0; i < def.stages.length; i++) {
    for (const zoneId of Object.keys(ZONES)) {
      everywhere.push({ id, i, zoneId, t: stageTarget(id, i, at(zoneId)) });
    }
  }
}
check('every stage resolves from every zone the player could read it in',
  everywhere.every((r) => r.t),
  everywhere.filter((r) => !r.t).map((r) => `${r.id}.${r.i}@${r.zoneId}`).join(' ') || `${everywhere.length} readings`);
const kindsUsed = new Set(everywhere.map((r) => r.t?.kind));
check('...and all four answer shapes are exercised by the real catalogue',
  ['place', 'zone', 'here', 'panel'].every((k) => kindsUsed.has(k)), [...kindsUsed].join(' '));

// The other half of "it resolves": it must *fail* to resolve nonsense, or every assertion
// above is satisfied by a function that always answers.
check('a stage kind with no resolver resolves to nothing',
  stageTarget('q_intro', 0, at('mondstadt')) !== null
  && questTarget({ stages: [{ id: 'x', kind: 'sacrifice', target: 'any' }] }, { stageIndex: 0 }, at('mondstadt')) === null);
check('...and a typo in a target id resolves to nothing, instead of to the wrong place',
  questTarget({ zone: 'mondstadt', stages: [{ id: 'x', kind: 'reach', target: 'mond_statuee' }] }, { stageIndex: 0 }, at('mondstadt')) === null);
check('...and a stage past the end of the list resolves to nothing',
  stageTarget('q_intro', 9, at('mondstadt')) === null);

/* ================================================= 2. the answers are answers ==== */

console.log('\n--- 2. the place is the place the world data says');

const npc = ZONES.mondstadt.npcs.find((n) => n.id === 'scholar');
const t_talk = stageTarget('q_intro', 0, at('mondstadt'));
check('a talk stage resolves to the NPC\'s own coordinates',
  t_talk.kind === 'place' && t_talk.x === npc.at[0] && t_talk.z === npc.at[1] && t_talk.name === npc.name,
  `${t_talk.name} ${t_talk.x},${t_talk.z}`);
check('...and carries the distance from where the player stands',
  Math.abs(t_talk.dist - Math.hypot(npc.at[0], npc.at[1])) < 0.01, `${t_talk.dist.toFixed(1)} m`);

const statue = ZONES.mondstadt.poi.find((p) => p.id === 'mond_statue');
const t_reach = stageTarget('q_intro', 1, at('mondstadt'));
check('a reach stage resolves to that POI',
  t_reach.kind === 'place' && t_reach.x === statue.at[0] && t_reach.z === statue.at[1],
  `${t_reach.name} ${t_reach.x},${t_reach.z}`);
check('...and its height comes off the terrain, not from zero',
  Number.isFinite(t_reach.y) && t_reach.y !== 0, `y ${t_reach.y?.toFixed(2)}`);

// 'nearest' has to mean nearest to the player. Two standing starts, two answers.
const near = stageTarget('q_slimes', 0, at('mondstadt', -120, -90));
const far = stageTarget('q_slimes', 0, at('mondstadt', 160, 120));
check('the nearest camp is nearest to the player, not the first in the table',
  near.kind === 'place' && far.kind === 'place' && (near.x !== far.x || near.z !== far.z),
  `from (-120,-90) → ${near.x},${near.z} · from (160,120) → ${far.x},${far.z}`);
check('...and it is a camp that really spawns one of the stage\'s enemies',
  ZONES.mondstadt.spawns.some((s) => s.at[0] === near.x && s.at[1] === near.z
    && s.enemies.some((e) => String(QUESTS.q_slimes.stages[0].target).split('|').includes(e))),
  `${near.name} at ${near.x},${near.z}`);

// 霜狼 stand in 蒙德平原 as well as 龙脊雪山, so this is also the test that the quest's own zone
// wins the search: a dragonspine quest read while standing in mondstadt must not send the
// player to the mondstadt wolves and call the stage done there — it cannot be.
const wolves = stageTarget('q_dragonspine', 2, at('dragonspine'));
check('a stage resolves inside its own quest\'s zone even when the enemy also lives elsewhere',
  wolves.zone === 'dragonspine',
  `${wolves.kind} ${wolves.name} in ${wolves.zone} (蒙德 also has ${ZONES.mondstadt.spawns.filter((s) => s.enemies.includes('frostWolf')).length} wolf camp)`);

// An opened chest is not a destination.
const chestPois = ZONES.mondstadt.poi.filter((p) => p.type === 'chest')
  .map((p) => ({ id: p.id, type: p.type, x: p.at[0], z: p.at[1], done: false, poi: p }));
const c1 = questTarget(QUESTS.d_chests, { stageIndex: 0 }, at('mondstadt', 0, 0, { pois: chestPois }));
const opened = chestPois.map((p) => ({ ...p, done: p.x === c1.x && p.z === c1.z }));
const c2 = questTarget(QUESTS.d_chests, { stageIndex: 0 }, at('mondstadt', 0, 0, { pois: opened }));
check('an opened chest stops being the destination', c1.kind === 'place' && c2.kind === 'place'
  && (c1.x !== c2.x || c1.z !== c2.z), `${c1.name} ${c1.x},${c1.z} → ${c2.name} ${c2.x},${c2.z}`);

// The door in this zone beats a zone-level shrug.
const t_gate = stageTarget('q_abyss_gate', 0, at('mondstadt'));
const gatePoi = ZONES.mondstadt.poi.find((p) => p.type === 'dungeon' && p.target === 'abyssTrial');
check('a dungeon in another zone resolves to its entrance in *this* zone',
  t_gate.kind === 'place' && t_gate.x === gatePoi.at[0] && t_gate.z === gatePoi.at[1] && t_gate.gate === 'abyssTrial',
  `${t_gate.name} ${t_gate.x},${t_gate.z}`);
const t_inside = stageTarget('q_abyss_gate', 0, at('abyssTrial'));
check('...and once the player is inside, the objective is arriving, not walking',
  t_inside.kind === 'here', `${t_inside.kind} ${t_inside.name}`);
const t_open = stageTarget('q_frost_seal', 0, at('mondstadt'));
check('an open-world zone with no door answers with the zone and how to get there',
  t_open.kind === 'zone' && t_open.zone === 'dragonspine' && /地图/.test(t_open.hint || ''),
  `${t_open.name} · ${t_open.hint}`);

// The boss that has no camp: the assertion that found the hole.
const t_boss = stageTarget('q_tyrant', 1, at('goldenHall'));
check('a chamber-only boss resolves to the floor it fights on',
  t_boss && t_boss.floor === 3 && new RegExp(ENEMIES.stormTyrant.name).test(t_boss.name),
  `${t_boss?.kind} ${t_boss?.name}`);
check('...and it is really only in a chamber, never in a camp',
  !Object.values(ZONES).some((z) => (z.spawns || []).some((s) => s.enemies.includes('stormTyrant'))),
  'no zone spawns 暴风之主 in the open world');

const t_cook = stageTarget('d_cook', 0, at('mondstadt'));
check('an objective with no place says so instead of inventing one',
  t_cook.kind === 'panel' && t_cook.panel === 'cook', JSON.stringify(t_cook.panel));

// One tracker line, one objective: the map and the HUD must ask the same function.
const picked = trackedQuest({ d_hunt: { state: 'active', stageIndex: 0 }, q_intro: { state: 'active', stageIndex: 0 } });
check('the tracked quest is the story one, whatever order the document is in', picked?.id === 'q_intro', picked?.id);
check('...and a document with nothing active tracks nothing',
  trackedQuest({ q_intro: { state: 'done', stageIndex: 2 } }) === null);

/* ==================================================== 3. the consumers exist ==== */

console.log('\n--- 3. the UI consumes it, in all three places');

check('the HUD imports the shared resolver instead of guessing',
  /questTarget, trackedQuest \} from '@teyvat\/shared\/data\/questNav\.js'/.test(code.hud));
check('...and picks the tracked quest with trackedQuest, not its own loop',
  code.hud.includes('trackedQuest(this.game.player?.quests)')
  && !/for \(const \[id, rec\] of Object\.entries\(quests\)\)/.test(code.hud),
  'one rule for which quest is tracked');
check('...and draws the row', ['qnav', 'qarrow', 'qwhere', 'qdist'].every((f) => code.hud.includes(`data-f="${f}"`)));
check('...and updates it from the frame path', /_navTick\(dt\)/.test(code.hud) && /_navTick\(dt\) \{/.test(code.hud));
// The distance text is throttled to 6 Hz; the *arrow* must not be. Its answer changes with the
// camera alone, so a throttled aim lags a mouse turn by up to 167 ms. The aim call has to sit
// above the accumulator's early return, which is also the only place a stray `--rot` write can
// be, or the running-game test below is measuring the throttle instead of the arrow.
{
  const tick = nocomment(code.hud).split('_navTick(dt) {')[1]?.split('\n  }')[0] || '';
  const gate = tick.indexOf('this._navAcc <');
  check('...and aims the arrow every frame, not at the 6 Hz text rate',
    /this\._navAim\(/.test(tick) && gate > 0 && tick.indexOf('this._navAim(') < gate
    && !/--rot/.test(tick),
    'the aim is above the 1/6 s early return');
}
check('...and feeds the live world lists in, so a picked node is not a destination',
  /pois: g\.world\.pois/.test(code.hud) && /gathers: g\.world\.gathers/.test(code.hud));
// One sentence, one function. The tracker said 「按 L 打开料理」 while the panel printed 「料理」,
// so both now read `ui/navtext.js` and neither phrases anything itself.
check('the tracker and the quest panel print the same sentence, from the same function',
  /from '\.\/navtext\.js'/.test(code.hud) && /from '\.\/navtext\.js'/.test(code.panels)
  && /navWhere\(t\)/.test(code.hud) && /navWhere\(t, \{ zone: true, dist: true \}\)/.test(code.panels));
check('...and neither of them phrases a target kind on its own',
  !/kind === 'here'/.test(code.hud) && !/kind === 'here'/.test(code.panels)
  && /kind === 'here'/.test(code.navtext), 'the four kinds are spelled out in exactly one file');
// Comments stripped first: a rule about what the code must not *say* is a rule about code, and
// navtext.js explains itself by quoting the very string this forbids.
check('the hint for a panel objective comes from KEYMAP, not from a typed letter',
  /KEYMAP\[t\.panel\]/.test(code.navtext)
  && ['navtext', 'hud', 'panels'].every((f) => !/按 [A-Z] 打开/.test(nocomment(code[f]))),
  ['navtext', 'hud', 'panels'].filter((f) => /按 [A-Z] 打开/.test(nocomment(code[f]))).join(' ') || 'derived in all three');
check('the minimap draws the objective', /view\.quest/.test(code.mapview) && /len > R/.test(code.mapview),
  'in-disc marker and a rim arrow when it is off-map');
check('the full map pins it, with a label', /'pin quest'/.test(code.panels) && /pin-label/.test(code.panels));
check('...and the quest panel says where the objective is',
  code.panels.includes('目标位置') && /questTarget\(QUESTS\[qd\.id\]/.test(code.panels));
check('the styles exist for all of it',
  ['.qnav', '--rot', '.qnav.far .qarrow', '.pin.quest', '.pin-label'].every((s) => code.css.includes(s)));
// Comments stripped, for the same reason as the two checks above: a comment cannot reach for the
// DOM, and this one went red on the word 「document」 inside a sentence about the player's save.
// The rule is about what the module *executes*.
check('the module does not reach for the DOM or the renderer',
  !/document|window|THREE/.test(nocomment(code.nav)), 'shared/data/questNav.js is testable in node');

/* ================================================= 4. the arrow in a real game ==== */

console.log('\n--- 4. the arrow, the marker and the pin in a running game');

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
    'media.autoplay.default': 0,
  },
  defaultViewport: { width: W, height: H },
});
const p = await b.newPage();
const errors = [];
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

let step = 0;
async function shot(name) {
  step++;
  const file = `${outDir}/${String(step).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file });
  console.log(`  (shot ${file})`);
  return decodePng(readFileSync(file));
}
/** Wait for `n` rendered frames — llvmpipe runs this scene at a few frames a second. */
async function frames(n = 3) {
  const from = await p.evaluate(() => window.__probeFrames || 0);
  for (let i = 0; i < 400; i++) {
    const now = await p.evaluate(() => window.__probeFrames || 0);
    if (now - from >= n) return now - from;
    await sleep(120);
  }
  return -1;
}
/** Everything the navigation row is saying, plus the state it is saying it about. */
const nav = () => p.evaluate(() => {
  const el = document.querySelector('[data-f="qnav"]');
  const tr = document.querySelector('[data-f="tracker"]');
  const g = window.game, hud = window.ui?.hud;
  const t = hud?.navTarget || null;
  const rot = el ? getComputedStyle(el.querySelector('[data-f="qarrow"]')).transform : null;
  return {
    shown: el ? getComputedStyle(el).display !== 'none' : false,
    trackerShown: tr ? !tr.classList.contains('hidden') : false,
    title: tr?.querySelector('b')?.textContent || '',
    objective: tr?.querySelector('span')?.textContent || '',
    where: el?.querySelector('[data-f="qwhere"]')?.textContent || '',
    dist: el?.querySelector('[data-f="qdist"]')?.textContent || '',
    arrowShown: el ? getComputedStyle(el.querySelector('[data-f="qarrow"]')).display !== 'none' : false,
    arrived: !!el?.classList.contains('arrived'),
    far: !!el?.classList.contains('far'),
    transform: rot,
    rect: el ? (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
    target: t && { kind: t.kind, name: t.name, x: t.x, z: t.z, zone: t.zone },
    me: { x: g.me.x, z: g.me.z, yaw: g.rig.yaw },
    quests: Object.fromEntries(Object.entries(g.player.quests || {}).map(([k, v]) => [k, { state: v.state, stageIndex: v.stageIndex }])),
  };
});
/** The rotation a CSS matrix encodes, in degrees, normalised to (-180, 180]. */
function rotOf(transform) {
  const m = /matrix\(([^)]+)\)/.exec(transform || '');
  if (!m) return null;
  const [a, bb] = m[1].split(',').map(Number);
  let deg = Math.atan2(bb, a) * 180 / Math.PI;
  if (deg <= -180) deg += 360;
  if (deg > 180) deg -= 360;
  return deg;
}
const angleGap = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
/** Gold marker pixels in the minimap's own canvas, read where they are drawn. */
const goldPixels = (tol = 12) => p.evaluate((t) => {
  const c = document.querySelector('[data-f="minimap"] canvas');
  if (!c) return null;
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const cx = c.width / 2, cy = c.height / 2;
  let n = 0, rim = 0, near = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (Math.abs(d[i] - 255) <= t && Math.abs(d[i + 1] - 209) <= t && Math.abs(d[i + 2] - 92) <= t) {
        n++;
        const r = Math.hypot(x - cx, y - cy);
        if (r > c.width / 2 - 12) rim++; else near++;
      }
    }
  }
  return { n, rim, near, w: c.width };
}, tol);
const ink = (img, r, frac = 0.25) => {
  const px = [];
  for (let y = Math.max(0, r.y); y < Math.min(img.height, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(img.width, r.x + r.w); x++) {
      const i = (y * img.width + x) * 4, d = img.data;
      px.push([d[i], d[i + 1], d[i + 2], 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]]);
    }
  }
  if (!px.length) return { rgb: [0, 0, 0], lum: 0 };
  px.sort((a, c) => c[3] - a[3]);
  const top = px.slice(0, Math.max(1, Math.round(px.length * frac)));
  const mean = (k) => Math.round(top.reduce((a, v) => a + v[k], 0) / top.length);
  return { rgb: [mean(0), mean(1), mean(2)], lum: Math.round(top.reduce((a, v) => a + v[3], 0) / top.length) };
};
const warm = (rgb) => rgb[0] - rgb[2] > 15 && rgb[1] > rgb[2];
const setCanvasVisible = (v) => p.evaluate((vis) => {
  const c = document.querySelector('canvas');
  if (c) c.style.visibility = vis ? '' : 'hidden';
}, v);
/**
 * Walk to an interactable and use it, on the product's own click-to-move path.
 *
 * Not a teleport: writing `game.me.x` moves the character for about a second and then the
 * position correction lerps it back where the server thinks it is, which is exactly the kind of
 * probe fix-up that reads as a passing assertion about a game the player never sees. This is
 * the same call the click handler makes (`game.js` → `setGoal(it.x, it.z, 'interact', it)`), so
 * the character walks, arrives, and interacts by itself.
 */
async function walkTo(id, { onArrive = null, capFrames = 320 } = {}) {
  const it = await p.evaluate((wanted) => {
    const g = window.game;
    const e = (g.world.interactables || []).find((x) => x.id === wanted);
    if (!e) return null;
    g.me.setGoal(e.x, e.z, 'interact', e);
    return { id: e.id, type: e.type, x: e.x, z: e.z, was: Math.round(Math.hypot(e.x - g.me.x, e.z - g.me.z)) };
  }, id);
  if (!it) return null;
  let arrivedSeen = false;
  for (let i = 0; i < capFrames; i += 3) {
    await frames(3);
    const s = await p.evaluate((w) => {
      const g = window.game;
      const e = (g.world.interactables || []).find((x) => x.id === w);
      return {
        d: e ? Math.hypot(e.x - g.me.x, e.z - g.me.z) : 999,
        goal: !!g.me.goal,
        arrived: !!document.querySelector('[data-f="qnav"]')?.classList.contains('arrived'),
      };
    }, id);
    if (s.arrived) arrivedSeen = true;
    if (!s.goal || s.d < 2.5) { it.d = s.d; break; }
  }
  if (onArrive) await onArrive();
  await sleep(1600);
  // Interacting puts a modal over the HUD (the conversation, the unlock notice) and pauses the
  // game with it; the quest advanced server-side the moment the request returned, so dismissing
  // it is not skipping anything. Its own ✕, not Escape — Escape with nothing open is the pause
  // menu (`ui.js`), which is how the first run of this probe ended up screenshotting 设置.
  for (let i = 0; i < 4; i++) {
    const closed = await p.evaluate(() => {
      const btn = document.querySelector('.scrim .close');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!closed) break;
    await sleep(500);
  }
  await frames(3);
  it.arrivedSeen = arrivedSeen;
  return it;
}

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await (await p.$('[data-act="solo"]')).click();
  await sleep(400);
  const enter = await p.$('[data-act="guest"]') || await p.$('[data-act="resume"]');
  await enter.click();
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  check('the solo world booted', await p.evaluate(() => !!window.game?._running && !!window.game?.playerId));
  check('...and the UI is reachable, so the probe can read what it resolved',
    await p.evaluate(() => !!window.ui?.hud));
  await p.evaluate(() => {
    window.__probeFrames = 0;
    window.game.on('frame', () => { window.__probeFrames++; });
  });
  await p.evaluate(() => {
    window.game.setAutoQuality(false);
    window.game.setQuality('high');
    // Noon, pinned: see daylight-check.mjs — the authored sky is what 12:00 returns.
    window.game.setWorldTime(12);
  });
  await sleep(2500);
  check('the quality tier is pinned to high', await p.evaluate(() => window.game.quality) === 'high');
  check('the game is rendering, so a stale frame cannot pass for a fresh one', (await frames(4)) >= 4);
  // The guide card would sit over the tracker in a screenshot; this run is not about it.
  await p.evaluate(() => window.game.tutorial.skip());

  /* ------------------------------------- the tracker on arrival, not on an event -- */
  // Nothing has been done in this world yet: the intro quest comes with the account and the
  // daily commissions are rolled before the first frame. So this is the state a player logs in
  // to, and it is the one the tracker used to get wrong — it was written only from the 'quest'
  // and 'playerState' events, so five active quests showed as an empty corner of the screen
  // until something else happened to emit.
  const boot = await p.evaluate(() => Object.entries(window.game.player.quests || {})
    .filter(([, r]) => r.state === 'active').map(([k]) => k));
  check('the join snapshot already has active quests, so a tracker is owed',
    boot.length > 0 && boot.includes('q_intro'), boot.join(' '));
  let n = await nav();
  check('the tracker is showing one, before the player has done anything',
    n.trackerShown && n.title === QUESTS.q_intro.name, `${n.title} — ${n.objective}`);
  check('...and says where to go', n.shown && n.where.length > 0, `${n.where} ${n.dist}`);
  check('...which for 「与学者莉莎交谈」 is that NPC',
    n.target?.kind === 'place' && n.where === ZONES.mondstadt.npcs.find((x) => x.id === 'scholar').name,
    `${n.where} ${n.dist}`);

  /* ------------------------------------------------ the distance is the distance -- */
  const trueDist = Math.hypot(n.target.x - n.me.x, n.target.z - n.me.z);
  check('the distance on screen is the distance in the world',
    Math.abs(parseFloat(n.dist) - trueDist) <= 2 && /m$/.test(n.dist),
    `HUD ${n.dist} vs ${trueDist.toFixed(1)} m`);
  check('...and 28 m away it is not claiming the player has arrived',
    n.arrived === false && trueDist > 12, `arrived=${n.arrived} at ${trueDist.toFixed(1)} m`);

  /* ---------------------------------------------------- the arrow points at it -- */
  // Bearing, derived the same way the world is: the camera looks along (-sin yaw, -cos yaw),
  // so straight ahead is yaw + π and the arrow's rotation must be the difference.
  const expected = (s) => {
    const rel = Math.atan2(s.target.x - s.me.x, s.target.z - s.me.z) - s.me.yaw - Math.PI;
    return ((rel * 180 / Math.PI) % 360 + 540) % 360 - 180;
  };
  n = await nav();
  check('the arrow points at the objective', angleGap(rotOf(n.transform), expected(n)) < 6,
    `arrow ${rotOf(n.transform)?.toFixed(1)}° vs bearing ${expected(n).toFixed(1)}°`);
  // The control that must move: turn the camera and the arrow has to swing with it, by the
  // same amount and in the opposite direction. Polled per frame rather than waited out, and the
  // frame count is part of the answer: the aim is a per-frame job, so two frames is the budget,
  // and this assertion failing on frame 3 means the throttle crept back in. (It first failed
  // here with the rotation written inside the 6 Hz branch — 4 frames of clamped dt is 0.2 s of
  // sim time, so whether the arrow had moved yet depended on where the accumulator happened to
  // be. A flaky probe was reporting a real 167 ms lag.)
  const before = rotOf(n.transform);
  await p.evaluate(() => { window.game.rig.yaw += Math.PI / 2; });
  let n2 = null, swingFrames = 0;
  for (let i = 1; i <= 8; i++) {
    await frames(1);
    swingFrames = i;
    n2 = await nav();
    if (angleGap(rotOf(n2.transform), expected(n2)) < 6 && angleGap(rotOf(n2.transform), before) > 60) break;
  }
  check('...and swings when the camera turns, within a frame or two', angleGap(rotOf(n2.transform), expected(n2)) < 6
    && angleGap(rotOf(n2.transform), before) > 60 && swingFrames <= 2,
    `${before?.toFixed(1)}° → ${rotOf(n2.transform)?.toFixed(1)}° (bearing ${expected(n2).toFixed(1)}°) after ${swingFrames} frame(s)`);
  // Walking toward it has to bring the number down; the arrow is aimed by pointing the camera
  // at the target first, because W is camera-relative.
  await p.evaluate(() => {
    const g = window.game, t = window.ui.hud.navTarget;
    g.rig.faceDirection(t.x - g.me.x, t.z - g.me.z);   // the game's own lock-on turn
  });
  await frames(3);
  const d0 = parseFloat((await nav()).dist);
  await p.keyboard.down('KeyW');
  await frames(40);
  await p.keyboard.up('KeyW');
  await sleep(600);
  await frames(2);
  const n3 = await nav();
  check('walking the way it points brings the distance down',
    d0 - parseFloat(n3.dist) > 3 && angleGap(rotOf(n3.transform), 0) < 25,
    `${d0} m → ${n3.dist}, arrow ${rotOf(n3.transform)?.toFixed(1)}° off centre`);

  /* ------------------------------------------------------------ in the pixels -- */
  await setCanvasVisible(false);
  await frames(2);
  const imgOn = await shot('tracker-nav');
  const rectOn = n3.rect;
  const inkOn = ink(imgOn, rectOn);
  check('the row is a real block of screen', rectOn.w > 60 && rectOn.h > 8, `${rectOn.w}×${rectOn.h} at ${rectOn.x},${rectOn.y}`);
  check('...painted in the gold the objective ink uses', warm(inkOn.rgb), `rgb ${inkOn.rgb.join(',')} lum ${inkOn.lum}`);
  await p.evaluate(() => { document.querySelector('[data-f="qnav"]').style.visibility = 'hidden'; });
  await frames(2);
  const imgOff = await shot('tracker-nav-hidden');
  const inkOff = ink(imgOff, rectOn);
  check('...and hiding it changes those pixels', Math.abs(inkOn.lum - inkOff.lum) > 15 || !warm(inkOff.rgb),
    `on lum ${inkOn.lum} rgb ${inkOn.rgb.join(',')} / off lum ${inkOff.lum} rgb ${inkOff.rgb.join(',')}`);
  await p.evaluate(() => { document.querySelector('[data-f="qnav"]').style.visibility = ''; });
  await setCanvasVisible(true);
  await frames(2);

  /* --------------------------------------------------------- the minimap marker -- */
  const gold = await goldPixels();
  if (!gold) {
    note('the minimap marker', 'no minimap canvas found');
  } else {
    check('the objective is marked on the minimap', gold.n > 0, `${gold.n} marker pixels (${gold.near} in-disc, ${gold.rim} on the rim)`);
    // Control: drop the target and redraw. Without it, "gold pixels exist" is also true of
    // every chest pin on the map.
    await p.evaluate(() => { window.ui.hud.navTarget = null; });
    await frames(3);
    const none = await goldPixels();
    check('...and it is the marker, not a POI pin: dropping the target removes those pixels',
      none.n === 0, `${none.n} left`);
    // Off the edge of the disc it becomes a rim arrow rather than nothing at all.
    await p.evaluate(() => { window.ui.hud._resolveNav(); });
    await frames(3);
    await p.evaluate(() => {
      const hud = window.ui.hud, t = hud.navTarget;
      if (t) { t.x = window.game.me.x + 320; t.z = window.game.me.z + 320; }
      hud._navAge = 0;   // the 5 s re-resolve would put the real target back mid-read
    });
    await frames(3);
    const offmap = await goldPixels();
    check('...and an objective past the edge of the disc is clamped to the rim, not dropped',
      offmap.n > 0 && offmap.rim > 0, `${offmap.n} pixels, ${offmap.rim} within 12 px of the rim`);
    await p.evaluate(() => window.ui.hud._resolveNav());
    await frames(3);
  }
  await shot('minimap-marker');

  /* ------------------------------------------------------------ the full map -- */
  await p.keyboard.press('KeyM');
  await sleep(1400);
  const full = await p.evaluate(() => {
    const pin = document.querySelector('.pin.quest');
    const label = document.querySelector('.pin-label');
    const canvas = document.querySelector('.mapwrap canvas');
    const t = window.ui.hud.navTarget;
    if (!pin || !canvas) return { pin: !!pin, canvas: !!canvas };
    const cr = canvas.getBoundingClientRect(), pr = pin.getBoundingClientRect();
    const size = window.game.world.zone.size;
    const side = Math.min(cr.width, cr.height);
    const ox = cr.x + (cr.width - side) / 2, oy = cr.y + (cr.height - side) / 2;
    return {
      pin: true, canvas: true,
      label: label?.textContent || '',
      title: pin.title,
      // Where the map's own transform says the target is, in page coordinates.
      want: [ox + ((t.x + size / 2) / size) * side, oy + ((t.z + size / 2) / size) * side],
      got: [pr.x + pr.width / 2, pr.y + pr.height / 2],
      pins: document.querySelectorAll('.pin').length,
    };
  });
  if (!full.pin) {
    check('the full map pins the objective', false, `pin=${full.pin} canvas=${full.canvas}`);
  } else {
    const off = Math.hypot(full.want[0] - full.got[0], full.want[1] - full.got[1]);
    check('the full map pins the objective where the map says it is', off < 6,
      `${off.toFixed(1)} px from the transform's answer, among ${full.pins} pins`);
    check('...and labels it, so one of the pins is legibly the goal',
      full.label.includes(n3.target.name) && /m$/.test(full.label.trim()), full.label);
  }
  await shot('full-map-pin');
  await p.keyboard.press('Escape');
  await sleep(600);

  /* ---------------------------------------------------------- the quest panel -- */
  await p.keyboard.press(KEYMAP.quests?.[0] || 'KeyJ');
  await sleep(1800);
  const panel = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.quest')].map((c) => ({
      name: c.querySelector('[data-f="nm"]')?.textContent || '',
      where: c.querySelector('.qwhere')?.textContent.trim() || '',
      answer: c.querySelector('.qwhere span:last-of-type')?.textContent.trim() || '',
      btn: c.querySelector('.qwhere button')?.textContent || '',
      // The button used to sit flush against the last character of the place name.
      gap: (() => {
        const s = c.querySelector('.qwhere span:last-of-type'), bt = c.querySelector('.qwhere button');
        if (!s || !bt) return null;
        return Math.round(bt.getBoundingClientRect().x - s.getBoundingClientRect().right);
      })(),
    }));
    return { cards, active: cards.filter((c) => c.where).length };
  });
  check('the quest panel says where each active objective is', panel.active > 0,
    `${panel.active}/${panel.cards.length} cards: ${panel.cards[0]?.where || ''}`);
  check('...and every active quest gets a non-empty answer, never a blank line',
    panel.cards.filter((c) => c.where).every((c) => c.answer.length > 1),
    panel.cards.filter((c) => c.where && c.answer.length <= 1).map((c) => c.name).join(' ')
    || panel.cards.filter((c) => c.where).map((c) => c.answer).join(' | ').slice(0, 150));
  check('...and names the same place the tracker does',
    panel.cards.some((c) => c.answer.includes(n3.target.name)),
    panel.cards.map((c) => c.answer).join(' | ').slice(0, 120));
  const cookCard = panel.cards.find((c) => /料理|烹饪/.test(c.name));
  if (!cookCard?.where) note('the panel phrases a placeless objective', 'no cooking commission today');
  else check('...and a placeless objective names the key in the panel too, not just in the tracker',
    cookCard.answer === `按 ${keyGlyph(KEYMAP.cook[0])} 打开料理`, `${cookCard.name}: ${cookCard.answer}`);
  check('...and offers to show it on the map, clear of the text',
    panel.cards.some((c) => c.btn) && panel.cards.filter((c) => c.gap != null).every((c) => c.gap >= 4),
    panel.cards.filter((c) => c.gap != null).map((c) => `${c.gap}px`).join(' '));
  await shot('quest-panel-where');
  await p.keyboard.press('Escape');
  await sleep(600);

  /* ----------------------------------------- an objective with no place at all -- */
  const farHides = await p.evaluate(() => {
    const el = document.querySelector('[data-f="qnav"]');
    const arrow = el.querySelector('[data-f="qarrow"]');
    el.classList.add('far');
    const hidden = getComputedStyle(arrow).display;
    el.classList.remove('far');
    return { hidden, shown: getComputedStyle(arrow).display };
  });
  check('...and a target with no bearing hides the arrow instead of pointing north',
    farHides.hidden === 'none' && farHides.shown !== 'none', `far → ${farHides.hidden}, near → ${farHides.shown}`);

  /* ------------------------------------------------------------ close the loop -- */
  // The whole point, end to end: walk to where it points, do the thing, and the objective —
  // and the arrow with it — must move on. Two stages of the story quest, on foot.
  const wasTarget = (await nav()).target;
  const arrival = await walkTo('scholar');
  // The advance is a server round trip that lands a frame or two after the conversation closes,
  // and at llvmpipe's frame rate `walkTo`'s 1.6 s wait is not always enough: one check-all run
  // read 「stage 0: 与学者莉莎交谈」 here and then passed 「stage 2」 two steps later, so the
  // objective had advanced — just not yet. Poll for it instead of reading once.
  let n4 = await nav();
  for (let i = 0; i < 14 && n4.quests.q_intro.stageIndex === 0; i++) { await frames(3); n4 = await nav(); }
  check('walking to where it pointed reaches the objective',
    !!arrival && arrival.d < 4, `${arrival?.was} m → ${arrival?.d?.toFixed(1)} m`);
  check('...and the row says so on the way in, instead of only counting metres',
    arrival?.arrivedSeen === true, `arrived class seen: ${arrival?.arrivedSeen}`);
  check('...and the objective it pointed at is now done',
    n4.quests.q_intro.stageIndex > 0, `stage ${n4.quests.q_intro.stageIndex}: ${n4.objective}`);
  const wantNext = questTarget(QUESTS.q_intro, { stageIndex: n4.quests.q_intro.stageIndex }, at('mondstadt', n4.me.x, n4.me.z));
  check('...and the arrow has moved to the next one', n4.where !== wasTarget.name && n4.where === wantNext.name,
    `${wasTarget.name} → ${n4.where} (shared resolver says ${wantNext.name})`);
  await shot('next-objective');

  // Second stage: the seven-god statue. Same again — the arrow is the only thing that said
  // where it was.
  const statueArrival = await walkTo('mond_statue');
  n4 = await nav();
  for (let i = 0; i < 14 && n4.quests.q_intro.stageIndex < 2; i++) { await frames(3); n4 = await nav(); }
  check('the next objective is reachable the same way, with no other instruction',
    !!statueArrival && statueArrival.d < 6 && n4.quests.q_intro.stageIndex > 1,
    `${statueArrival?.was} m → ${statueArrival?.d?.toFixed(1)} m, stage ${n4.quests.q_intro.stageIndex}`);
  check('...and the arrow moved on again, to the enemy camp the last stage wants',
    n4.where !== wantNext.name && n4.target?.kind === 'place',
    `${wantNext.name} → ${n4.where} ${n4.dist}`);
  await shot('third-objective');

  check('no page errors through any of it', errors.length === 0, errors.slice(0, 3).join(' | ') || `nav at ${n4.rect.x},${n4.rect.y}`);
} catch (e) {
  fail++;
  console.log(`  FAIL probe crashed — ${e?.stack || e}`);
} finally {
  await b.close();
}

console.log(`\nquestnav-check: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
