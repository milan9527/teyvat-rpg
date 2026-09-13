// 元素共鸣: is the party's *shape* worth what the table says, on both hosts?
//
//   DISPLAY unnecessary; node tools/resonance-check.mjs [--verbose]
//
// Same harness as `tools/chamber-check.mjs`: a real `ZoneInstance` driven in-process with
// its 20 Hz timer stopped and `inst.now` advanced by hand, so nothing sleeps and nothing
// rolls dice (`critRate` is pinned to 0 where damage is measured).
//
// Three things can rot here, and each has a section:
//
//   1. the table. A resonance is *data*. This repo has shipped that mistake twice — nine
//      weapon passives and nine sfx recipes were authored, described in a tooltip, and read
//      by nobody. So every field must be named in `RESONANCE_FIELDS`, every named field must
//      be carried by some resonance, and the consumer each one names must actually exist and
//      read it. Plus reachability: a resonance for an element with one character in the
//      roster is a rule no player can ever field.
//   2. the trigger. `partyResonances` is pure and cheap to test exhaustively — one pair, two
//      pairs, four distinct, a party of three, an unknown id.
//   3. the money. "the party got stronger" is not measurable from one number. Every effect
//      is a ratio against a control that must *not* move: the same character in a party
//      whose composition activates nothing, and — for the fold itself — a *benched*
//      character, who must be untouched even though the resonance is live.
//
// Exit code is the number of failed assertions.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  RESONANCES, RESONANCE_FIELDS, RESONANCE_STAT_KEYS, RESONANCE_ELEMENTS,
  RESONANCE_NEED, DISTINCT_NEED, partyResonances, resonanceHint, resonanceCondition,
  rosterByElement,
} from '../shared/src/data/resonance.js';
import { CHARACTERS } from '../shared/src/data/characters.js';
import { ZoneInstance } from '../shared/src/world/zoneInstance.js';
import { partyStats, makeWeapon, STAT_KEYS } from '../shared/src/sim/loot.js';
import { PROC_KEYS, PROC_SHAPE_KEYS, hitMods, fireProcs, gearProcs } from '../shared/src/world/procs.js';
import { handleSkill } from '../shared/src/world/actions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
let passes = 0, fails = 0;
function ok(name, cond, extra = '') {
  if (cond) { passes++; console.log(`ok   ${name}${extra ? '  ' + extra : ''}`); } else {
    fails++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`);
  }
  return !!cond;
}
const fmt = (v, d = 3) => Number(v).toFixed(d);
const ratio = (a, b) => (b ? a / b : Infinity);
const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/* ==================================================== 1. the table, both ways -- */

console.log('\n-- the resonance table --');

const META = ['id', 'element', 'name', 'distinct', 'effect'];
const badKeys = [];
for (const [id, r] of Object.entries(RESONANCES)) {
  if (r.id !== id) badKeys.push(`${id}: id field says "${r.id}"`);
  for (const k of Object.keys(r)) if (!META.includes(k)) badKeys.push(`${id}.${k}`);
  for (const k of Object.keys(r.effect || {})) if (!RESONANCE_FIELDS[k]) badKeys.push(`${id}.effect.${k}`);
  if (!r.element && !r.distinct) badKeys.push(`${id}: neither element nor distinct`);
  if (r.element && !CHARACTERS[Object.keys(CHARACTERS)[0]]) badKeys.push('roster empty');
}
ok('every effect key is a declared field', !badKeys.length, badKeys.join(' '));

const unused = Object.keys(RESONANCE_FIELDS)
  .filter((k) => !Object.values(RESONANCES).some((r) => r.effect?.[k] !== undefined));
ok('every declared field is carried by some resonance', !unused.length, unused.join(' '));

// Which *kind* of consumer each field claims has to be true, because the three folds are
// three different code paths: a stat key is folded by `applyPartyResonance`, a proc key is
// fired through `gearProcs`, and a shape key only qualifies another field.
const foldProblems = [];
for (const [k, f] of Object.entries(RESONANCE_FIELDS)) {
  if (f.fold === 'stat' && !STAT_KEYS.includes(k)) foldProblems.push(`${k}: not a STAT_KEYS entry`);
  if (f.fold === 'proc' && !PROC_KEYS.includes(k)) foldProblems.push(`${k}: not a PROC_KEYS entry`);
  if (f.fold === 'shape' && !PROC_SHAPE_KEYS.includes(k)) foldProblems.push(`${k}: not a PROC_SHAPE_KEYS entry`);
  if (!['stat', 'proc', 'shape'].includes(f.fold)) foldProblems.push(`${k}: fold "${f.fold}"`);
  if (!f.consumer) foldProblems.push(`${k}: no consumer named`);
}
ok('every field folds through a path that already exists', !foldProblems.length, foldProblems.join(' | '));
ok('the stat subset is exactly the fold:stat fields',
  RESONANCE_STAT_KEYS.length === Object.values(RESONANCE_FIELDS).filter((f) => f.fold === 'stat').length
  && RESONANCE_STAT_KEYS.every((k) => STAT_KEYS.includes(k)),
  RESONANCE_STAT_KEYS.join(' '));

// The consumer each field *names*, in the file it names. `RESONANCE_FIELDS[k].consumer` is
// prose for the player-facing docs, so the check is deliberately loose about the wording and
// strict about the two facts that matter: the file exists and the key appears in it.
const CONSUMER_FILES = {
  'sim/loot': 'shared/src/sim/loot.js',
  'sim/formulas': 'shared/src/sim/formulas.js',
  'world/actions': 'shared/src/world/actions.js',
  'world/procs': 'shared/src/world/procs.js',
  'world/entity': 'shared/src/world/entity.js',
  'world/zoneInstance': 'shared/src/world/zoneInstance.js',
};
const missingConsumers = [];
for (const [key, f] of Object.entries(RESONANCE_FIELDS)) {
  const mod = Object.keys(CONSUMER_FILES).find((m) => f.consumer.startsWith(m));
  if (!mod) { missingConsumers.push(`${key}: consumer names no known module`); continue; }
  const text = src(CONSUMER_FILES[mod]);
  // The consumer string is prose: `sim/loot.applyPartyResonance -> st.atk（…）`,
  // `world/actions.handleSkill/handleBurst 的 heal`, `world/actions 的 skill.shield 与 …`.
  // A dotted identifier path right after the module name is the function to look for; when
  // the prose names none, the key's own presence in the file is the whole check.
  const dotted = f.consumer.slice(mod.length).match(/^\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/);
  const fn = dotted ? dotted[1].split('.').pop() : '';
  if (fn && !new RegExp(`\\b${fn}\\b`).test(text)) missingConsumers.push(`${key}: ${mod} has no ${fn}`);
  else if (!new RegExp(`\\b${key}\\b`).test(text)) missingConsumers.push(`${key}: unread in ${mod}`);
}
ok('every field is read by the module it names', !missingConsumers.length, missingConsumers.join(' | '));

// Reachability. This is the reason six characters were added with the system: a resonance
// needs two characters of one element, and before the roster grew, five of the seven
// elements had exactly one character — five rules no party could ever activate.
const roster = rosterByElement();
const unreachable = RESONANCE_ELEMENTS.filter((el) => (roster[el] || []).length < RESONANCE_NEED);
ok('every elemental resonance is reachable with the shipped roster', !unreachable.length,
  unreachable.map((el) => `${el}=${(roster[el] || []).length}`).join(' ')
  || RESONANCE_ELEMENTS.map((el) => `${el}:${roster[el].length}`).join(' '));
ok('...and there are at least four elements for 四象庇护',
  Object.keys(roster).length >= DISTINCT_NEED, `${Object.keys(roster).length} elements`);

// Derived text: `resonanceHint` is generated from the effect so the numbers and the words
// cannot drift, which only holds if it describes *every* term.
const badHints = [];
for (const r of Object.values(RESONANCES)) {
  const hint = resonanceHint(r);
  const terms = Object.keys(r.effect).filter((k) => RESONANCE_FIELDS[k].fold !== 'shape').length;
  const cond = resonanceCondition(r);
  if (!hint) badHints.push(`${r.id}: no hint`);
  else if (hint.split('，').length !== terms) badHints.push(`${r.id}: ${hint.split('，').length} clauses for ${terms} terms`);
  if (/undefined|NaN|%%/.test(hint)) badHints.push(`${r.id}: "${hint}"`);
  if (!cond || /undefined/.test(cond)) badHints.push(`${r.id}: condition "${cond}"`);
  if (!r.name) badHints.push(`${r.id}: no name`);
}
ok('every resonance describes itself and its condition', !badHints.length, badHints.join(' | '));
if (VERBOSE) for (const r of Object.values(RESONANCES)) {
  console.log(`     ${r.name}  ${resonanceCondition(r)}  ${resonanceHint(r)}`);
}

/* ================================================== 2. the trigger, exhaustive -- */

console.log('\n-- partyResonances --');

const ids = (party) => partyResonances(party).map((r) => r.id);
const pair = (el) => roster[el].slice(0, RESONANCE_NEED);
const filler = (avoid) => Object.values(CHARACTERS)
  .filter((c) => !avoid.includes(c.element)).map((c) => c.id);

{
  const firePair = pair('fire');
  const solo = [firePair[0], roster.water[0], roster.ice[0]];
  ok('a pair activates its element', ids([...firePair, roster.water[0], roster.ice[0]]).includes('fire'),
    ids([...firePair, roster.water[0], roster.ice[0]]).join(' '));
  ok('...and a single character of that element does not', !ids(solo).includes('fire'), ids(solo).join(' '));
  ok('two pairs activate both', (() => {
    const both = [...pair('fire'), ...pair('ice')];
    const got = ids(both);
    return got.includes('fire') && got.includes('ice') && !got.includes('protective');
  })(), ids([...pair('fire'), ...pair('ice')]).join(' '));
  const distinct = ['fire', 'water', 'ice', 'lightning'].map((el) => roster[el][0]);
  ok('four different elements activate 四象庇护 and nothing else',
    ids(distinct).length === 1 && ids(distinct)[0] === 'protective', ids(distinct).join(' '));
  ok('...but three different elements do not',
    !ids(distinct.slice(0, 3)).includes('protective'), ids(distinct.slice(0, 3)).join(' ') || 'none');
  ok('an empty or unknown party activates nothing',
    !ids([]).length && !ids(['nobody', 'ghost']).length && !ids(undefined).length);
  ok('a pair plus two unknown ids still resonates',
    ids([...firePair, 'ghost', 'nobody']).join(' ') === 'fire',
    ids([...firePair, 'ghost', 'nobody']).join(' '));
  ok('three of one element is still one resonance, not two',
    ids([...roster.lightning.slice(0, 2), roster.lightning[0]]).join(' ') === 'lightning',
    ids([...roster.lightning.slice(0, 2), roster.lightning[0]]).join(' '));
  if (VERBOSE) console.log(`     filler pool: ${filler(['fire']).slice(0, 4).join(' ')}`);
}

/* ============================================ 3. the effects, each with a control -- */

console.log('\n-- the effects, measured against a party that activates nothing --');

const LEVEL = 60;
const instOf = (charId) => ({
  charId, level: LEVEL, ascension: 4, talents: { normal: 1, skill: 1, burst: 1 }, dupes: 0,
  weapon: makeWeapon('travelersBlade', LEVEL, 1), artifacts: {},
});

/**
 * A stopped instance holding one player whose party is exactly `party`.
 *
 * `bench` is the two-sided control: a character who is built and in the save but *not* in
 * the party, so the fold has to leave every one of their numbers alone.
 */
function arena(party, { zoneId = 'abyssTrial', bench = [], noCrit = true } = {}) {
  const inst = new ZoneInstance(zoneId, 99, { broadcast: () => {} });
  inst.camps.length = 0;
  const chars = {};
  for (const id of [...party, ...bench]) chars[id] = instOf(id);
  const stats = partyStats(chars, party);
  if (noCrit) for (const st of Object.values(stats)) st.critRate = 0;
  const save = {
    playerId: 1, party: [...party], activeSlot: 0, zone: zoneId,
    pos: { x: 0, y: 6, z: 0, ry: 0 },
  };
  const p = inst.addPlayer(1, 'p1', save, stats);
  inst.stop();
  inst.enemies.clear();
  inst.now = 100;
  inst.events.length = 0;
  return { inst, p, stats };
}

/** A party of `lead` plus characters whose elements pair with nothing (all distinct, <4). */
function loneParty(lead) {
  const used = new Set([CHARACTERS[lead].element]);
  const out = [lead];
  for (const c of Object.values(CHARACTERS)) {
    if (out.length >= 3 || used.has(c.element)) continue;   // 3 only: 4 distinct would resonate
    used.add(c.element); out.push(c.id);
  }
  return out;
}
/** The same lead, now with a partner of its own element. */
const resParty = (lead) => {
  const el = CHARACTERS[lead].element;
  const partner = roster[el].find((id) => id !== lead);
  const rest = loneParty(lead).filter((id) => CHARACTERS[id].element !== el).slice(0, 2);
  return [lead, partner, ...rest];
};

ok('the two parties differ only in the partner element', (() => {
  const a = loneParty('ignar'), b = resParty('ignar');
  return a[0] === b[0] && ids(a).length === 0 && ids(b).join(' ') === 'fire';
})(), `${loneParty('ignar').join(',')} -> none | ${resParty('ignar').join(',')} -> ${ids(resParty('ignar')).join(' ')}`);

// (a) atkPct — the fold itself, and the benched character who must not move.
{
  const off = arena(loneParty('ignar'), { bench: ['nyx'] });
  const on = arena(resParty('ignar'), { bench: ['nyx'] });
  const want = 1 + RESONANCES.fire.effect.atkPct;
  ok('炎炎不息 raises the attack of a party member',
    Math.abs(ratio(on.stats.ignar.atk, off.stats.ignar.atk) - want) < 0.01,
    `${off.stats.ignar.atk} -> ${on.stats.ignar.atk} = ${fmt(ratio(on.stats.ignar.atk, off.stats.ignar.atk))}x, want ${fmt(want)}x`);
  ok('...and its partner too, not just the on-field one',
    Math.abs(ratio(on.stats.pyra.atk, arena(['pyra']).stats.pyra.atk) - want) < 0.01,
    `${arena(['pyra']).stats.pyra.atk} -> ${on.stats.pyra.atk}`);
  ok('...and leaves a benched character of another element alone',
    on.stats.nyx.atk === off.stats.nyx.atk && !on.stats.nyx.resonance,
    `bench nyx ${off.stats.nyx.atk} -> ${on.stats.nyx.atk}`);
  ok('...and the members carry the resonance source for the client',
    on.stats.ignar.resonance?.length === 1 && on.stats.ignar.resonance[0].name === RESONANCES.fire.name
    && !!on.stats.ignar.resonance[0].hint,
    JSON.stringify(on.stats.ignar.resonance?.[0]?.name));

  // Through the damage funnel, because a stat block nobody hits with proves nothing.
  const hit = ({ inst, p }) => {
    const e = inst.spawnEnemy('hilichurl', LEVEL, 4, 4, { homeRadius: 60 });
    return inst.playerHitEnemy(p, e, { scaling: 4, element: 'fire', gauge: 0, kind: 'skill', charId: 'ignar' }).total;
  };
  const dOff = hit(off), dOn = hit(on);
  ok('...and the damage a hit lands moves by the same factor',
    Math.abs(ratio(dOn, dOff) - want) < 0.02,
    `${Math.round(dOff)} -> ${Math.round(dOn)} = ${fmt(ratio(dOn, dOff))}x`);
}

// (b) healBonus — measured through `handleSkill`, the line the field names.
{
  const healed = (party) => {
    const { inst, p, stats } = arena(party);
    p.hp = 1;
    handleSkill(p, inst, { dir: [0, 0, 1] }, () => {});
    return { amount: p.hp - 1, healBonus: stats[party[0]].healBonus };
  };
  const off = healed(loneParty('naida')), on = healed(resParty('naida'));
  // Worth derived, not guessed: `healBonus` composes *additively* (`addStat`), and naida's
  // own talent already carries +15 %, so the ratio is 1.45/1.15 and not 1.30. A hand-written
  // 「should be 1.3x」 would have been wrong by exactly the character's own passive.
  const want = (1 + on.healBonus) / (1 + off.healBonus);
  ok('潮涌相闻 adds exactly the healing bonus it promises',
    Math.abs((on.healBonus - off.healBonus) - RESONANCES.water.effect.healBonus) < 1e-9,
    `${fmt(off.healBonus, 2)} -> ${fmt(on.healBonus, 2)}`);
  ok('...and the heal that lands grows with it',
    off.amount > 0 && Math.abs(ratio(on.amount, off.amount) - want) < 0.02,
    `${Math.round(off.amount)} -> ${Math.round(on.amount)} = ${fmt(ratio(on.amount, off.amount))}x, want ${fmt(want)}x`);
}

// (c) cdReduction — read off the cooldown the skill wrote.
{
  const cdOf = (party) => {
    const { inst, p } = arena(party);
    handleSkill(p, inst, { dir: [0, 0, 1] }, () => {});
    return p.cooldowns[`${party[0]}:skill`] - inst.now;
  };
  const off = cdOf(loneParty('lyra')), on = cdOf(resParty('lyra'));
  const want = 1 - RESONANCES.wind.effect.cdReduction;
  ok('疾风相引 shortens the skill cooldown',
    Math.abs(ratio(on, off) - want) < 0.005 && Math.abs(off - CHARACTERS.lyra.skill.cd) < 0.001,
    `${fmt(off, 2)}s -> ${fmt(on, 2)}s = ${fmt(ratio(on, off))}x, want ${fmt(want)}x`);
}

// (d) shieldStrength — 磐岩同契 through gorran's shield.
{
  const shieldOf = (party) => {
    const { inst, p } = arena(party);
    handleSkill(p, inst, { dir: [0, 0, 1] }, () => {});
    return p.shieldHp;
  };
  const off = shieldOf(loneParty('gorran')), on = shieldOf(resParty('gorran'));
  const want = 1 + RESONANCES.earth.effect.shieldStrength;
  ok('磐岩同契 thickens the shield', off > 0 && Math.abs(ratio(on, off) - want) < 0.02,
    `${Math.round(off)} -> ${Math.round(on)} = ${fmt(ratio(on, off))}x, want ${fmt(want)}x`);
}

// (e) dr — 四象庇护, measured where the field says it is read: `takeDamage`.
{
  const hurtOf = (party) => {
    const { inst, p } = arena(party);
    p.hp = p.maxHp();
    const before = p.hp;
    p.takeDamage(500, inst.now);
    return before - p.hp;
  };
  const distinct = ['fire', 'water', 'ice', 'lightning'].map((el) => roster[el][0]);
  const off = hurtOf(distinct.slice(0, 3)), on = hurtOf(distinct);
  const want = 1 - RESONANCES.protective.effect.dr;
  ok('四象庇护 softens every hit the player takes',
    Math.abs(ratio(on, off) - want) < 0.01,
    `${Math.round(off)} -> ${Math.round(on)} = ${fmt(ratio(on, off))}x, want ${fmt(want)}x`);
  ok('...and a party of three distinct elements pays nothing',
    ids(distinct.slice(0, 3)).length === 0 && Math.abs(off - 500) < 1, `${Math.round(off)} of 500`);
}

// (f) em — 皓光同辉, seen where mastery is worth something: a reaction.
{
  const react = (party) => {
    const { inst, p, stats } = arena(party);
    const e = inst.spawnEnemy('hilichurl', LEVEL, 4, 4, { homeRadius: 60 });
    e.aura.apply('water', 2, inst.now);
    const r = inst.playerHitEnemy(p, e, { scaling: 4, element: 'lightning', gauge: 1, kind: 'skill', charId: party[0] });
    return { total: r.total, reaction: r.reaction, em: stats[party[0]].em };
  };
  const off = react(loneParty('aurel')), on = react(resParty('aurel'));
  ok('皓光同辉 adds exactly the mastery it promises',
    on.em - off.em === RESONANCES.light.effect.em, `${off.em} -> ${on.em}`);
  ok('...and the reaction it feeds hits harder for it',
    off.reaction === 'electroCharged' && on.reaction === 'electroCharged' && ratio(on.total, off.total) > 1.03,
    `${Math.round(off.total)} -> ${Math.round(on.total)} = ${fmt(ratio(on.total, off.total))}x`);
}

// (g) critVsFrozen — a `PROC_KEYS` field, so the assertion is that the resonance rides
// `gearProcs` as a fourth source and `hitMods` finds it. Both halves of the condition are
// tested: frozen and not frozen.
{
  const crit = (party, { freeze }) => {
    const { inst, p, stats } = arena(party);
    const e = inst.spawnEnemy('hilichurl', LEVEL, 4, 4, { homeRadius: 60 });
    if (freeze) { e.aura.apply('water', 2, inst.now); e.aura.apply('ice', 2, inst.now); }
    const st = stats[party[0]];
    return {
      frozen: !!e.aura.isFrozen?.(inst.now),
      mods: hitMods(st, e, {}, inst.now),
      sources: gearProcs(st).filter((s) => s.src === `r:${RESONANCES.ice.id}`).length,
    };
  };
  const off = crit(loneParty('kaelen'), { freeze: true });
  const on = crit(resParty('kaelen'), { freeze: true });
  const warm = crit(resParty('kaelen'), { freeze: false });
  ok('the target is actually frozen (and the control is not)', on.frozen && !warm.frozen,
    `${on.frozen} / ${warm.frozen}`);
  ok('霜碎之诫 reaches hitMods as a conditional effect source',
    on.sources === 1 && off.sources === 0
    && Math.abs((on.mods.critRate - off.mods.critRate) - RESONANCES.ice.effect.critVsFrozen) < 1e-9,
    `critRate +${fmt(on.mods.critRate - off.mods.critRate)} from ${on.sources} source`);
  ok('...and pays nothing against a target that is not frozen',
    Math.abs(warm.mods.critRate) < 1e-9, `+${fmt(warm.mods.critRate)}`);
}

// (h) energyOnReaction — the other proc field, with its `onReactions` shape gate as the
// control: a reaction the list does not name must pay nothing.
{
  const energy = (party, reaction) => {
    const { inst, p, stats } = arena(party);
    p.energy[party[0]] = 0;
    fireProcs(inst, p, stats[party[0]], 'reaction', { charId: party[0], reaction });
    return { energy: p.energy[party[0]], er: stats[party[0]].er || 1 };
  };
  const lead = roster.lightning[0];
  const off = energy(loneParty(lead), 'electroCharged');
  const on = energy(resParty(lead), 'electroCharged');
  const wrongOff = energy(loneParty(lead), 'crystallize');
  const wrongOn = energy(resParty(lead), 'crystallize');
  // `addEnergy` scales by the character's 元素充能效率, so the *flat* 3 points arrive as
  // 3 × er. Comparing the raw delta against 3 would fail on any build with an ER weapon.
  const want = RESONANCES.lightning.effect.energyOnReaction * on.er;
  ok('雷动共振 hands out energy on the reactions it names',
    Math.abs((on.energy - off.energy) - want) < 0.05,
    `${fmt(off.energy, 1)} -> ${fmt(on.energy, 1)} (+${fmt(on.energy - off.energy, 2)}, want ${fmt(want, 2)} = 3 x er ${fmt(on.er, 2)})`);
  ok('...and nothing on a reaction its onReactions list does not name',
    Math.abs(wrongOn.energy - wrongOff.energy) < 1e-9 && wrongOn.energy === 0,
    `crystallize: ${fmt(wrongOff.energy, 1)} -> ${fmt(wrongOn.energy, 1)}`);
}

// (i) both hosts. The gateway and the browser run the same simulation, and a party bonus
// folded in one and not the other is a balance fork — so the two entry points are asserted
// to be the same call, textually.
{
  const server = src('server/src/routes/player.js');
  const client = src('client/src/net/localSocket.js');
  ok('the gateway derives stats through partyStats',
    /partyStats\(\s*p\.characters\s*,\s*p\.party/.test(server), 'server/src/routes/player.js');
  ok('...and so does the browser solo host',
    /partyStats\(this\._save\.characters[^)]*this\._save\.party/.test(client), 'client/src/net/localSocket.js');
  ok('...and the party panel reads the same table rather than restating it',
    /partyResonances|resonanceCondition/.test(src('client/src/ui/panels.js')), 'client/src/ui/panels.js');
}

console.log(`\nresonance-check: ${passes} passed, ${fails} failed`);
process.exit(fails);
