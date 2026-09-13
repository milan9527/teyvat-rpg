// The roster: is every number on a character sheet a number the game reads?
//
//   DISPLAY unnecessary; node tools/char-check.mjs [--verbose]
//
// Written when the roster grew from 8 to 14 characters so that 元素共鸣 could be reached
// (a resonance needs two characters of one element). Six new sheets meant six new chances
// to author a field nothing consumes — and the audit that came with them found that the
// *original* roster already had six: `charged.chargeTime`, `charged.hold`,
// `charged.spinDrain`, `charged.thrust`, `charged.headshot` and `skill.particles` were
// written in `characters.js` and read by nobody. Every bow charged in the same 0.32 s a
// sword did, a claymore's spin cost one flat swing, and a two-particle skill charged its
// burst exactly as fast as a four-particle one.
//
// This is the same two-way gate as `DISORDER_FIELDS` and `RESONANCE_FIELDS`:
//
//   1. every authored kit path is declared in `KIT_FIELDS`
//   2. every declared path is used by at least one character
//   3. the consumer each path names exists, names that function, and reads that key
//   4. plus a self-test: a fabricated path must be reported dead, or a green run proves
//      nothing (a probe in this repo once ran zero assertions and reported "0 failed")
//
// Sections 4–6 are the parts a vocabulary gate cannot see: identity/reachability (a
// character nobody can obtain), the appearance vocabulary (`buildHair` falls through to
// `short` for an unknown style, so a typo is invisible), and kit parity — a new 4★ whose
// burst is unreachable or whose skill hits ten times harder than the rest of the roster.
//
// Exit code is the number of failed assertions.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CHARACTERS, CHARACTER_IDS, KIT_FIELDS, CHARACTER_META_KEYS, HAIR_STYLES,
  WEAPON_TYPES, RARITY, STARTER_PARTY,
} from '../shared/src/data/characters.js';
import { ELEMENTS } from '../shared/src/data/elements.js';
import { WISH_POOL } from '../shared/src/data/items.js';
import { STAT_KEYS } from '../shared/src/sim/loot.js';
import { ENERGY_PER_PARTICLE } from '../shared/src/world/actions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
let passes = 0, fails = 0;
function ok(name, cond, extra = '') {
  if (cond) { passes++; console.log(`ok   ${name}${extra ? '  ' + extra : ''}`); } else {
    fails++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`);
  }
  return !!cond;
}
const fmt = (v, d = 2) => Number(v).toFixed(d);
const KIT_SECTIONS = ['normal', 'charged', 'plunge', 'skill', 'burst', 'passive', 'body'];

/** Every authored leaf path of one character, e.g. `skill.heal.interval`. */
function kitPaths(def) {
  const out = [];
  const walk = (pre, o) => {
    for (const [k, v] of Object.entries(o || {})) {
      const p = `${pre}.${k}`;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(p, v);
      else out.push(p);
    }
  };
  for (const sec of KIT_SECTIONS) if (def[sec]) walk(sec, def[sec]);
  // Top-level fields that are neither identity nor a section — `voice` is the only one
  // today, and it is exactly the kind of field that rots (a pitch nothing pitches).
  for (const [k, v] of Object.entries(def)) {
    if (!KIT_SECTIONS.includes(k) && !CHARACTER_META_KEYS.includes(k)) out.push(k);
  }
  return out;
}

/**
 * The declared field that covers an authored path.
 *
 * Longest declared prefix wins, so `passive.bonus` covers `passive.bonus.fire` — the
 * children of that one are stat keys, gated against `STAT_KEYS` in section 4 instead.
 */
function declaredFor(p) {
  let best = null;
  for (const key of Object.keys(KIT_FIELDS)) {
    if ((p === key || p.startsWith(`${key}.`)) && (!best || key.length > best.length)) best = key;
  }
  return best;
}

/* ================================================ 1. the vocabulary, both ways -- */

console.log('\n-- kit vocabulary --');

const authored = new Map();     // declared path -> characters using it
const undeclared = [];
for (const def of Object.values(CHARACTERS)) {
  for (const p of kitPaths(def)) {
    const key = declaredFor(p);
    if (!key) undeclared.push(`${def.id}.${p}`);
    else authored.set(key, [...(authored.get(key) || []), def.id]);
  }
}
ok('the scan found the roster it is meant to scan',
  CHARACTER_IDS.length >= 14 && authored.size > 60,
  `${CHARACTER_IDS.length} characters, ${authored.size} of ${Object.keys(KIT_FIELDS).length} declared fields in use`);
ok('every authored kit field is declared', !undeclared.length, undeclared.join(' '));

const unusedFields = Object.keys(KIT_FIELDS).filter((k) => !authored.has(k));
ok('every declared field is used by some character', !unusedFields.length, unusedFields.join(' '));

// Top-level keys too: a stray `charged` typo'd as `charge` would sit there forever.
const strayTop = [];
for (const def of Object.values(CHARACTERS)) {
  for (const k of Object.keys(def)) {
    if (!CHARACTER_META_KEYS.includes(k) && !KIT_FIELDS[k]) strayTop.push(`${def.id}.${k}`);
  }
}
ok('no character carries an unknown top-level key', !strayTop.length, strayTop.join(' '));

/* ============================================== 2. the consumers, in the files -- */

console.log('\n-- consumers --');

const MODULES = {
  'world/actions': 'shared/src/world/actions.js',
  'world/procs': 'shared/src/world/procs.js',
  'world/entity': 'shared/src/world/entity.js',
  'world/zoneInstance': 'shared/src/world/zoneInstance.js',
  'sim/loot': 'shared/src/sim/loot.js',
  'sim/formulas': 'shared/src/sim/formulas.js',
  'game/localPlayer': 'client/src/game/localPlayer.js',
  'gfx/humanoid': 'client/src/gfx/humanoid.js',
  'ui/panels': 'client/src/ui/panels.js',
  'game/game': 'client/src/game/game.js',
  // The sheet's own file is a legitimate consumer: `playerAttackShape` is where the ground shape
  // an attack covers is derived from the kit, so `charged.spin` (a sword's charged attack sweeps
  // the circle) is read there and nowhere else. See `KIT_FIELDS` in it for the hole this opens
  // and how `codeOf` closes it.
  'data/characters': 'shared/src/data/characters.js',
};
const source = {};
for (const [mod, rel] of Object.entries(MODULES)) source[mod] = readFileSync(path.join(ROOT, rel), 'utf8');
ok('every consumer file was read',
  Object.values(source).every((s) => s.length > 2000), Object.keys(MODULES).length + ' files');

/**
 * Non-comment lines only: a key named in a `//` line is a promise, not a consumer.
 *
 * And not the `KIT_FIELDS` map itself. Declaring a key's consumer to be the file the declaration
 * lives in would otherwise satisfy the check for free — `'charged.spin': 'data/characters…'` is a
 * line of code containing the word `spin` — so the map is cut out before the scan, and the
 * self-test below proves it by looking for a function named *only* in the map.
 */
const codeOf = (mod) => source[mod]
  .replace(/export const KIT_FIELDS = Object\.freeze\(\{[\s\S]*?\n\}\);/, '')
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');
const code = {};
for (const mod of Object.keys(MODULES)) code[mod] = codeOf(mod);

/**
 * The module that *is* the character sheet. Cutting `KIT_FIELDS` out of it is not enough: every
 * declared key's leaf name is authored by some character a few hundred lines above, in the same
 * file, as data — `stamina`, `spin`, `radius` are all in there — so a whole-file grep can never
 * come back "unread" and the key half of the check is vacuous for anything declared here. For this
 * one module the key must be found inside the *named function's body*.
 */
const SELF_DECLARING = 'data/characters';

/** The body of a top-level `function fn(…) { … }`, brace-matched, or null. */
function functionBody(src, fn) {
  const m = src.match(new RegExp(`\\bfunction ${fn}\\s*\\(`));
  if (!m) return null;
  const open = src.indexOf('{', m.index + m[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

/** Does `mod` name `fn` and read `key`? Returns the reason it does not. */
function consumerProblem(fieldPath, where) {
  const [mod, fn] = [where.slice(0, where.lastIndexOf('.')), where.slice(where.lastIndexOf('.') + 1)];
  if (!MODULES[mod]) return `unknown module ${mod}`;
  const key = fieldPath.split('.').pop();
  if (!new RegExp(`\\b${fn}\\b`).test(code[mod])) return `${mod} has no ${fn}`;
  let scope = code[mod], where2 = mod;
  if (mod === SELF_DECLARING) {
    scope = functionBody(code[mod], fn);
    where2 = `${mod}.${fn}`;
    if (scope === null) return `${mod}.${fn} is not a plain function this scan can read`;
  }
  if (!new RegExp(`\\b${key}\\b`).test(scope)) return `${key} unread in ${where2}`;
  return null;
}

const consumerProblems = [];
for (const [fieldPath, where] of Object.entries(KIT_FIELDS)) {
  const why = consumerProblem(fieldPath, where);
  if (why) consumerProblems.push(`${fieldPath}: ${why}`);
}
ok('every declared field is read by the consumer it names', !consumerProblems.length,
  consumerProblems.join(' | '));

// The self-test. Without it a broken scanner reports a clean roster, which is how a probe
// in this repo once passed while running no assertions at all.
ok('the scan can tell a dead field from a live one',
  consumerProblem('skill.notAKitKey', 'world/actions.handleSkill') === 'notAKitKey unread in world/actions'
  && consumerProblem('skill.cd', 'world/actions.noSuchFunction') === 'world/actions has no noSuchFunction'
  && consumerProblem('skill.cd', 'nope/nope.x') === 'unknown module nope/nope'
  // `liveStats` appears in characters.js *only* as a KIT_FIELDS value, so this is only reported if
  // the map really was cut out of the scanned source.
  && consumerProblem('skill.cd', 'data/characters.liveStats') === 'data/characters has no liveStats'
  // `stamina` is authored by characters in this very file but is not read by `playerAttackShape`:
  // reported only if the key scan is scoped to the function body rather than the whole sheet.
  && consumerProblem('charged.stamina', 'data/characters.playerAttackShape')
    === 'stamina unread in data/characters.playerAttackShape',
  'fabricated field, fabricated function, fabricated module, the declaration map and the sheet\'s own data all reported');
if (VERBOSE) {
  for (const [k, v] of Object.entries(KIT_FIELDS)) console.log(`     ${k.padEnd(26)} ${v}  (${(authored.get(k) || []).length})`);
}

/* ================================================== 3. identity & reachability -- */

console.log('\n-- roster identity --');

const idProblems = [];
for (const [id, def] of Object.entries(CHARACTERS)) {
  if (def.id !== id) idProblems.push(`${id}: id field says ${def.id}`);
  if (!ELEMENTS[def.element]) idProblems.push(`${id}: element ${def.element}`);
  if (!WEAPON_TYPES[def.weapon]) idProblems.push(`${id}: weapon ${def.weapon}`);
  if (!RARITY[def.rarity]) idProblems.push(`${id}: rarity ${def.rarity}`);
  if (!def.name || !def.title) idProblems.push(`${id}: no name/title`);
  if (!def.base || !def.base.hp || !def.base.atk) idProblems.push(`${id}: no base stats`);
  if (!STAT_KEYS.includes(def.ascensionStat?.key)) idProblems.push(`${id}: ascensionStat ${def.ascensionStat?.key}`);
  if (!(def.ascensionStat?.value > 0)) idProblems.push(`${id}: ascensionStat has no value`);
  if (!def.normal?.hits?.length) idProblems.push(`${id}: no normal combo`);
  if (!(def.skill?.cd > 0)) idProblems.push(`${id}: skill has no cd`);
  if (!(def.burst?.cost > 0) || !(def.burst?.cd > 0)) idProblems.push(`${id}: burst has no cost/cd`);
  if (!def.passive?.name) idProblems.push(`${id}: no passive`);
}
ok('every character is a complete sheet', !idProblems.length, idProblems.join(' | '));

// Reachability: a character who is in no wish pool and not a starter exists only in the
// data file. That is the same defect as an unreachable resonance, one layer up.
const poolChars = new Set();
// `featured` is a single id and `featuredFour` a list; iterating a string would add its
// letters, which is how the first run of this probe reported a character named "i".
const addIds = (v) => { for (const id of (typeof v === 'string' ? [v] : v || [])) poolChars.add(id); };
for (const pool of Object.values(WISH_POOL)) {
  for (const tier of ['fiveStar', 'fourStar']) addIds(pool[tier]?.chars);
  addIds(pool.featuredFive); addIds(pool.featuredFour); addIds(pool.featured);
}
const unreachable = CHARACTER_IDS.filter((id) => !poolChars.has(id) && !STARTER_PARTY.includes(id));
ok('every character is obtainable (a wish pool or the starter party)', !unreachable.length,
  unreachable.join(' ') || `${poolChars.size} in pools + ${STARTER_PARTY.length} starters`);
const ghosts = [...poolChars].filter((id) => !CHARACTERS[id]);
ok('...and no pool offers a character that does not exist', !ghosts.length, ghosts.join(' '));
ok('the starter party is four real characters',
  STARTER_PARTY.length === 4 && STARTER_PARTY.every((id) => CHARACTERS[id]), STARTER_PARTY.join(' '));

/* ==================================================== 4. the appearance layer -- */

console.log('\n-- procedural model vocabulary --');

// `buildHair` has a `default:` that falls through to `short`, so a typo'd style renders a
// character bald-ish and nothing ever complains. Gate the styles against the switch itself.
const humanoid = source['gfx/humanoid'];
const builtStyles = [...humanoid.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]);
ok('every hair style the roster asks for is one buildHair implements',
  CHARACTER_IDS.every((id) => HAIR_STYLES.includes(CHARACTERS[id].body.hair)),
  CHARACTER_IDS.filter((id) => !HAIR_STYLES.includes(CHARACTERS[id].body.hair)).join(' ')
  || [...new Set(CHARACTER_IDS.map((id) => CHARACTERS[id].body.hair))].join(' '));
ok('...and the declared list matches the switch in humanoid.js',
  HAIR_STYLES.every((s) => builtStyles.includes(s)),
  HAIR_STYLES.filter((s) => !builtStyles.includes(s)).join(' ') || `${builtStyles.length} cases`);
// Every style should be worn by someone, or it is unreachable art.
const wornStyles = new Set(CHARACTER_IDS.map((id) => CHARACTERS[id].body.hair));
ok('...and every implemented style is worn by someone',
  HAIR_STYLES.every((s) => wornStyles.has(s)),
  HAIR_STYLES.filter((s) => !wornStyles.has(s)).join(' ') || `${wornStyles.size} styles in use`);

const bodyProblems = [];
for (const def of Object.values(CHARACTERS)) {
  const b = def.body;
  if (!(b.height > 1.4 && b.height < 2.1)) bodyProblems.push(`${def.id}: height ${b.height}`);
  if (!(b.build >= 0 && b.build <= 1)) bodyProblems.push(`${def.id}: build ${b.build}`);
  for (const k of ['skin', 'hairColor', 'hairTip', 'primary', 'secondary', 'accent', 'eye', 'boots']) {
    if (typeof b[k] !== 'number') bodyProblems.push(`${def.id}: ${k} is not a colour`);
  }
  if (b.skirt !== undefined && !(b.skirt >= 0 && b.skirt <= 1)) bodyProblems.push(`${def.id}: skirt ${b.skirt}`);
}
ok('every body block is inside the rig it drives', !bodyProblems.length, bodyProblems.join(' | '));

/* ============================================================= 5. kit parity -- */

console.log('\n-- kit parity across the roster --');

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// A reference sheet, so a heal and a hit can be compared in one unit. Roughly a level-80
// character in decent gear; only the *ratio* between the two sides matters here.
const REF = { hp: 12000, atk: 1200, def: 900 };
const amount = (o) => (o.hpScaling || 0) * REF.hp + (o.atkScaling || 0) * REF.atk
  + (o.defScaling || 0) * REF.def + (o.flat || 0);
/** HP per second a section restores or absorbs, over its own cooldown. */
function sustainRate(sec, cd) {
  let total = 0;
  for (const key of ['heal', 'shield']) {
    const o = sec[key];
    if (!o) continue;
    const ticks = o.interval && o.duration ? Math.floor(o.duration / o.interval) : 1;
    total += amount(o) * ticks;
  }
  return total / cd;
}

const rows = Object.values(CHARACTERS).map((def) => {
  const particles = def.skill.particles ?? 3;
  const rate = (particles * ENERGY_PER_PARTICLE) / def.skill.cd;   // energy per second from skill casts
  return {
    id: def.id, rarity: def.rarity,
    skillDps: (def.skill.mult * (def.skill.ticks || 1)) / def.skill.cd,
    burstDps: (def.burst.mult * (def.burst.ticks || 1)) / def.burst.cd,
    comboDps: def.normal.hits.reduce((a, v) => a + v, 0) / (def.normal.hits.length * def.normal.frameTime),
    toBurst: def.burst.cost / rate,
    skillSustain: sustainRate(def.skill, def.skill.cd),
    burstSustain: sustainRate(def.burst, def.burst.cd),
    particles,
  };
});
if (VERBOSE) for (const r of rows) {
  console.log(`     ${r.id.padEnd(9)} skill ${fmt(r.skillDps)}/s  burst ${fmt(r.burstDps)}/s  combo ${fmt(r.comboDps)}/s  burst in ${fmt(r.toBurst, 1)}s (${r.particles}粒)  sustain ${fmt(r.skillSustain, 0)}/${fmt(r.burstSustain, 0)} hp/s`);
}

// A band rather than a number: characters are supposed to differ, but a 4★ whose skill is
// five times the roster's is not a design choice, it is a typo. The medians are the roster's
// own scale, so this keeps holding as the game is tuned.
//
// The low side needs one exemption, and it must not be a blank cheque: a支援 kit is *meant*
// to hit softly, so it may sit under the damage band — but only if the same ability actually
// pays for it, which the paired assertion below measures in HP per second against the damage
// per second it gave up. Anything that neither damages nor sustains is still a defect.
const SOFT_FLOOR = 0.25;                      // a sustain kit may fall to 25% of the median…
const exempt = [];                            // …and then owes the sustain to justify it
for (const axis of ['skillDps', 'burstDps', 'comboDps']) {
  const m = med(rows.map((r) => r[axis]));
  const sustainKey = axis === 'skillDps' ? 'skillSustain' : axis === 'burstDps' ? 'burstSustain' : null;
  const outliers = rows.filter((r) => {
    if (r[axis] > m * 2.2) return true;
    if (r[axis] >= m * 0.45) return false;
    const sustains = sustainKey && r[sustainKey] > 0 && r[axis] >= m * SOFT_FLOOR;
    if (sustains) exempt.push({ ...r, axis, m, sustain: r[sustainKey] });
    return !sustains;
  });
  ok(`no character is an outlier on ${axis}`, !outliers.length,
    outliers.map((r) => `${r.id} ${fmt(r[axis])} vs median ${fmt(m)}`).join(' | ')
    || `median ${fmt(m)}, range ${fmt(Math.min(...rows.map((r) => r[axis])))}–${fmt(Math.max(...rows.map((r) => r[axis])))}`);
}

// Both halves of the exemption. It has to fire (otherwise the branch above is dead code that
// would hide a real outlier the day a support is added), and every kit that takes it has to
// buy at least 40% as much HP per second as the damage per second it forfeited.
ok('the sustain exemption is used by the kits that need it', exempt.length >= 3,
  exempt.map((r) => `${r.id}.${r.axis}`).join(' ') || 'nobody claimed it');
const unpaid = exempt.filter((r) => r.sustain < 0.4 * r.m * REF.atk);
ok('...and every kit that takes it pays for it in sustain', !unpaid.length,
  unpaid.map((r) => `${r.id} ${fmt(r.sustain, 0)}hp/s vs ${fmt(0.4 * r.m * REF.atk, 0)} owed`).join(' | ')
  || exempt.map((r) => `${r.id} ${fmt(r.sustain, 0)}hp/s ≥ ${fmt(0.4 * r.m * REF.atk, 0)}`).join(' | '));

// Burst reachability, in the unit the energy actually arrives in. `skill.particles` is the
// only *deterministic* source (hits and the in-combat trickle add more), so this is an upper
// bound on the time to a burst: it has to be inside a fight, and it must not be free.
const slow = rows.filter((r) => r.toBurst > 75);
const free = rows.filter((r) => r.toBurst < 12);
ok('every burst is reachable from skill particles alone inside a fight', !slow.length,
  slow.map((r) => `${r.id} ${fmt(r.toBurst, 1)}s`).join(' ')
  || `worst ${fmt(Math.max(...rows.map((r) => r.toBurst)), 1)}s`);
ok('...and no burst is close to free', !free.length,
  free.map((r) => `${r.id} ${fmt(r.toBurst, 1)}s`).join(' ')
  || `best ${fmt(Math.min(...rows.map((r) => r.toBurst)), 1)}s`);
ok('particle counts are a small integer count of orbs', rows.every((r) => r.particles >= 1 && r.particles <= 6),
  rows.map((r) => r.particles).join(''));

/* ======================================================= 6. the six additions -- */

console.log('\n-- the roster shape resonance needs --');

const byElement = {};
for (const def of Object.values(CHARACTERS)) (byElement[def.element] = byElement[def.element] || []).push(def.id);
ok('every element has at least two characters', Object.values(byElement).every((a) => a.length >= 2),
  Object.entries(byElement).map(([el, a]) => `${el}:${a.length}`).join(' '));
ok('...and at least one weapon type per element is different inside the pair',
  Object.values(byElement).every((a) => new Set(a.map((id) => CHARACTERS[id].weapon)).size >= 2),
  Object.entries(byElement).map(([el, a]) => `${el}:${a.map((id) => CHARACTERS[id].weapon).join('/')}`).join(' '));
ok('every weapon type is playable', Object.keys(WEAPON_TYPES)
  .every((w) => CHARACTER_IDS.some((id) => CHARACTERS[id].weapon === w)),
  Object.keys(WEAPON_TYPES).map((w) => `${w}:${CHARACTER_IDS.filter((id) => CHARACTERS[id].weapon === w).length}`).join(' '));

console.log(`\nchar-check: ${passes} passed, ${fails} failed`);
process.exit(fails);
