// Chamber level design: are the waves real, and does the 地脉异常 actually reach the fight?
//
//   DISPLAY unnecessary; node tools/chamber-check.mjs [--verbose]
//
// No server and no browser: this drives a real `ZoneInstance` in-process, exactly like
// `tools/proc-check.mjs`. The instance's 20 Hz timer is stopped and `inst.now` is advanced by
// hand, so every assertion is deterministic — no sleeping and no wall clock. Crit is pinned
// off by setting `critRate` to 0 rather than by re-rolling until the dice cooperate.
//
// Why it exists. All fourteen chamber floors used to be the same encounter: one wave, kill
// everything before a timer that a parity party used 5–25 % of. `balance-check` graded them
// and every floor got three stars for free. Waves and disorders are the fix, and both halves
// of that fix are the kind that rots silently:
//
//   * a disorder is *data*. Nine weapon passives and nine sfx recipes in this repo were
//     authored, described in a tooltip, and read by nobody. Section 1 is the two-way gate:
//     every field must be named in `DISORDER_FIELDS`, every named field must be read by the
//     file that claims to read it, every disorder must be placed on a floor, and every floor
//     must reference a disorder that exists.
//   * "the fight got harder" is not measurable by looking at one number. Section 3 measures
//     every effect against a control that must *not* move: a floor with no disorder, an
//     element the disorder does not touch, a hit with no reaction, and a chamber whose state
//     is no longer `running`. One-sided evidence ("the damage was 4 300") proves nothing.
//
// Exit code is the number of failed assertions.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ZONES, chamberEnemies, CHAMBER_WAVE_GAP, chamberEntry, zoneEntryRank,
  chamberStars, chamberMilestone, chamberMoraFull, CHAMBER_MAX_STARS,
} from '../shared/src/data/zones.js';
import {
  DISORDERS, DISORDER_FIELDS, DISORDER_META_KEYS, DISORDER_IDS,
  disorderById, disorderHint, disorderTerms, disorderInfo,
} from '../shared/src/data/disorders.js';
import { ENEMIES } from '../shared/src/data/enemies.js';
import { resMultiplier, chamberXp } from '../shared/src/sim/formulas.js';
import { ZoneInstance } from '../shared/src/world/zoneInstance.js';
import { buildCharacterStats, makeWeapon } from '../shared/src/sim/loot.js';
import { S2C } from '../shared/src/protocol.js';

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
const ratio = (a, b) => (b ? a / b : Infinity);

const DUNGEONS = Object.values(ZONES).filter((z) => z.kind === 'dungeon');
const FLOORS = DUNGEONS.flatMap((z) => z.chambers.map((c) => ({ z, c })));

/* ==================================================== 1. the data, both ways -- */

console.log('\n-- disorder data --');

const badKeys = [];
for (const [id, d] of Object.entries(DISORDERS)) {
  if (d.id !== id) badKeys.push(`${id}: id field says "${d.id}"`);
  for (const k of Object.keys(d)) {
    if (!DISORDER_FIELDS[k] && !DISORDER_META_KEYS.includes(k)) badKeys.push(`${id}.${k}`);
  }
}
ok('every disorder key is a declared field', !badKeys.length, badKeys.join(' '));

// The other direction: a field declared and used by no disorder is a rule the game cannot
// express, and it would keep its consumer alive in a grep while meaning nothing.
const unusedFields = Object.keys(DISORDER_FIELDS)
  .filter((k) => !Object.values(DISORDERS).some((d) => d[k] !== undefined));
ok('every declared field is used by some disorder', !unusedFields.length, unusedFields.join(' '));

// And the field's *consumer*: `DISORDER_FIELDS` names a file and a function, so the file has
// to exist, name the function, and read the key. This is what fails the moment someone
// deletes a line in `zoneInstance.js` and leaves the data behind.
const CONSUMER_FILE = 'shared/src/world/zoneInstance.js';
const consumerSrc = readFileSync(path.join(ROOT, CONSUMER_FILE), 'utf8');
ok('the consumer file was read', consumerSrc.length > 5000 && /class ZoneInstance/.test(consumerSrc),
  `${CONSUMER_FILE} ${consumerSrc.length} bytes`);
const missingConsumers = [];
for (const [key, where] of Object.entries(DISORDER_FIELDS)) {
  const fn = String(where).split(' ')[0].replace(/^zoneInstance\./, '');
  if (!new RegExp(`\\b${fn}\\s*\\(`).test(consumerSrc)) missingConsumers.push(`${key}: no ${fn}()`);
  else if (!new RegExp(`\\b${key}\\b`).test(consumerSrc)) missingConsumers.push(`${key}: unread`);
}
ok('every field is read by the consumer it names', !missingConsumers.length, missingConsumers.join(' '));

// The hint is derived, never authored beside the numbers — so it has to actually describe
// every term. One clause per effect, and no disorder that says nothing.
const badHints = [];
for (const d of Object.values(DISORDERS)) {
  const hint = disorderHint(d);
  const terms = disorderTerms(d);
  if (!terms) badHints.push(`${d.id}: no effect at all`);
  if (!hint) badHints.push(`${d.id}: no hint`);
  else if (hint.split(' · ').length !== terms) badHints.push(`${d.id}: ${hint.split(' · ').length} clauses for ${terms} terms`);
  if (/undefined|NaN|%%/.test(hint)) badHints.push(`${d.id}: "${hint}"`);
}
ok('every disorder describes itself', !badHints.length, badHints.join(' | '));
if (VERBOSE) for (const d of Object.values(DISORDERS)) console.log(`     ${d.name}: ${disorderHint(d)}`);

// Both directions between floors and disorders.
const placedDisorders = new Set(FLOORS.map(({ c }) => c.disorder).filter(Boolean));
const unknownRefs = FLOORS.filter(({ c }) => c.disorder && !DISORDERS[c.disorder])
  .map(({ z, c }) => `${z.id}:${c.floor}=${c.disorder}`);
ok('no floor references an unknown disorder', !unknownRefs.length, unknownRefs.join(' '));
ok('every disorder is placed on a floor', placedDisorders.size === DISORDER_IDS.length,
  DISORDER_IDS.filter((id) => !placedDisorders.has(id)).join(' ') || `${placedDisorders.size} of ${DISORDER_IDS.length}`);
// The first floor of the game's first dungeon is where a player learns what a chamber is:
// it teaches one thing, so it carries no modifier. If that ever changes it should change on
// purpose.
ok('the first floor of the starter dungeon has no disorder', !ZONES.abyssTrial.chambers[0].disorder,
  String(ZONES.abyssTrial.chambers[0].disorder));

console.log('\n-- wave data --');

const shapeProblems = [];
for (const { z, c } of FLOORS) {
  const at = (s) => `${z.id}:${c.floor} ${s}`;
  if (c.enemies) shapeProblems.push(at('still has a flat enemies list'));
  if (!Array.isArray(c.waves) || !c.waves.length) shapeProblems.push(at('has no waves'));
  else if (c.waves.some((w) => !Array.isArray(w) || !w.length)) shapeProblems.push(at('has an empty wave'));
  for (const id of chamberEnemies(c)) if (!ENEMIES[id]) shapeProblems.push(at(`unknown enemy ${id}`));
}
ok('the floor scan found floors', FLOORS.length >= 14, `${FLOORS.length} floors`);
ok('every floor is a list of non-empty waves', !shapeProblems.length, shapeProblems.join(' | '));
ok('every floor has more than one wave', FLOORS.every(({ c }) => c.waves.length >= 2),
  FLOORS.filter(({ c }) => c.waves.length < 2).map(({ z, c }) => `${z.id}:${c.floor}`).join(' ') || 'all');
// A boss floor's boss belongs in the *last* wave, or the fight ends on trash.
const bossTail = FLOORS.filter(({ c }) => c.boss).filter(({ c }) => {
  const last = c.waves[c.waves.length - 1];
  const hp = (id) => ENEMIES[id]?.base?.hp || 0;
  return Math.max(...last.map(hp)) < Math.max(...chamberEnemies(c).map(hp));
});
ok('a boss floor ends on its boss', !bossTail.length,
  bossTail.map(({ z, c }) => `${z.id}:${c.floor}`).join(' '));

/* ====================================================== 2. waves, in the sim -- */

console.log('\n-- waves, driven in a real instance --');

const LEVEL = 60;
function statsFor(charId) {
  const st = buildCharacterStats({
    charId, level: LEVEL, ascension: 4, talents: { normal: 1, skill: 1, burst: 1 }, dupes: 0,
    weapon: makeWeapon('travelersBlade', LEVEL, 1), artifacts: {},
  });
  st.critRate = 0;      // pinned: this probe measures damage, not dice
  return st;
}

/** A stopped instance in a dungeon with one player in it and nothing ambient alive. */
function arena(zoneId = 'abyssTrial', charId = 'lyra') {
  const inst = new ZoneInstance(zoneId, 99, { broadcast: () => {} });
  inst.camps.length = 0;
  const st = statsFor(charId);
  const save = {
    playerId: 1, party: [charId], activeSlot: 0, zone: zoneId,
    pos: { x: 0, y: 6, z: 0, ry: 0 },
  };
  const p = inst.addPlayer(1, 'p1', save, { [charId]: st });
  inst.stop();
  inst.enemies.clear();
  inst.now = 100;
  inst.events.length = 0;
  return { inst, p, st };
}

// Every wait/read starts from a cleared event queue: `find` over everything emitted since
// the instance booted answers with the *first* match, which for a repeated action is the
// previous one. That is how a probe in this repo once called a landed fix broken.
const drain = (inst) => { const e = [...inst.events]; inst.events.length = 0; return e; };
const chamberEvents = (evts, state) => evts.filter((e) => e.t === S2C.CHAMBER && e.d.state === state);
const killAll = (inst) => {
  for (const e of inst.enemies.values()) if (e.alive) e.takeDamage(1e9, 1, inst.now);
};
/** Advance the clock and run the chamber state machine, without the 20 Hz timer. */
const advance = (inst, dt) => { inst.now += dt; inst.updateChamber(); };

{
  const { inst } = arena();
  const c = ZONES.abyssTrial.chambers[1];     // 2 waves: 2 then 3, frostVein
  inst.events.length = 0;
  const r = inst.startChamber(c.floor);
  const started = chamberEvents(drain(inst), 'start')[0];
  ok('startChamber reports the shape of the floor',
    r.ok && r.waves === c.waves.length && r.disorder === c.disorder,
    `waves ${r.waves} disorder ${r.disorder}`);
  ok('...and the start event names the disorder for the client',
    started?.d.wave === 1 && started.d.waves === c.waves.length
    && started.d.disorder?.id === c.disorder && !!started.d.disorder?.hint,
    `${started?.d.wave}/${started?.d.waves} ${started?.d.disorder?.name}: ${started?.d.disorder?.hint}`);
  ok('only the first wave is in the arena', inst.enemies.size === c.waves[0].length,
    `${inst.enemies.size} alive, wave 1 is ${c.waves[0].length}`);

  // Kill wave 1. Nothing may spawn during the breather, and the wave must arrive after it.
  killAll(inst);
  advance(inst, 0.05);
  const duringGap = chamberEvents(drain(inst), 'wave').length;
  const aliveInGap = [...inst.enemies.values()].filter((e) => e.alive).length;
  ok('the breather is a breather', duringGap === 0 && aliveInGap === 0 && inst.chamber.wave === 0,
    `${duringGap} wave events, ${aliveInGap} alive`);
  advance(inst, CHAMBER_WAVE_GAP - 0.5);
  ok('...and it lasts as long as it says', [...inst.enemies.values()].every((e) => !e.alive)
    && inst.chamber.wave === 0, `wave index ${inst.chamber.wave} at ${CHAMBER_WAVE_GAP - 0.45}s`);
  advance(inst, 1);
  const waveEvt = chamberEvents(drain(inst), 'wave')[0];
  const alive2 = [...inst.enemies.values()].filter((e) => e.alive).length;
  ok('the next wave spawns after the breather',
    inst.chamber.wave === 1 && alive2 === c.waves[1].length,
    `wave ${inst.chamber.wave + 1}, ${alive2} alive, expected ${c.waves[1].length}`);
  ok('...and the client is told which wave it is',
    waveEvt?.d.wave === 2 && waveEvt.d.waves === c.waves.length && waveEvt.d.enemies === c.waves[1].length,
    JSON.stringify(waveEvt?.d));
  ok('the floor is not cleared while a wave is still owed', inst.chamber.state === 'running');

  // Kill the last wave: now it clears, and the stars come off the derived thresholds.
  killAll(inst);
  advance(inst, 0.05);
  const cleared = chamberEvents(drain(inst), 'cleared')[0];
  ok('the last wave clears the floor', inst.chamber.state === 'cleared' && !!cleared,
    JSON.stringify(cleared?.d));
  ok('...with three stars for a fast clear',
    cleared?.d.stars === 3 && cleared.d.time <= c.stars[2],
    `${cleared?.d.time}s vs 3★ ${c.stars[2]}s`);
}
{
  // The other ending. The clock runs through the breather, so a floor can time out between
  // waves — and a timeout has to fail rather than quietly wait forever.
  const { inst } = arena();
  const c = ZONES.abyssTrial.chambers[1];
  inst.startChamber(c.floor);
  drain(inst);
  advance(inst, c.timeLimit + 1);
  const failed = chamberEvents(drain(inst), 'failed')[0];
  ok('running out of time fails the floor', inst.chamber.state === 'failed' && !!failed,
    JSON.stringify(failed?.d));
}
{
  // A run in progress is not restartable — and the rule has two sides, because the same
  // function is also the only way to start the next attempt.
  //
  // `startChamber` *is* the reset: it empties the arena, respawns wave 1 and re-anchors
  // `startedAt`. So a second request while a run is live handed out a brand-new clock and
  // threw the progress away. Solo that is one stray click — the map panel's floor list stays
  // clickable during a run — and in co-op it is worse: the presser need not be the player
  // whose run it is, so any teammate could wipe the party's 80th second, on any floor.
  const { inst } = arena();
  const c = ZONES.abyssTrial.chambers[0];
  inst.startChamber(c.floor);
  drain(inst);
  advance(inst, 12);
  const clock = inst.chamber.startedAt;
  const wave = [...inst.enemies.keys()].join(',');
  const again = inst.startChamber(c.floor);
  const other = inst.startChamber(2);
  ok('a run in progress refuses to restart',
    again.error === 'chamber_in_progress' && again.floor === c.floor && !again.ok,
    JSON.stringify(again));
  ok('...whatever floor the request names',
    other.error === 'chamber_in_progress' && other.floor === c.floor,
    `asked for floor 2 → ${JSON.stringify(other)}`);
  ok('...and the refusal left the clock and the wave alone',
    inst.chamber.startedAt === clock && [...inst.enemies.keys()].join(',') === wave
    && inst.chamber.state === 'running',
    `startedAt ${inst.chamber.startedAt} vs ${clock}, ${inst.enemies.size} enemies`);
  ok('...and told nobody a run had started',
    chamberEvents(drain(inst), 'start').length === 0);

  // The other side: once the run has ended, the same request is how the next attempt begins.
  // Without this half the guard could be `return { error }` unconditionally and still pass.
  advance(inst, c.timeLimit + 1);
  drain(inst);
  const retry = inst.startChamber(c.floor);
  ok('a floor that has ended can be started again',
    retry.ok === true && inst.chamber.state === 'running'
    && chamberEvents(drain(inst), 'start').length === 1,
    `${inst.chamber.state} after ${JSON.stringify(retry)}`);
}
{
  // The snapshot has to carry the same three facts as the event, because a player who
  // reloads mid-run never saw the event.
  const { inst, p } = arena();
  const c = ZONES.abyssTrial.chambers[1];
  let snap = null;
  inst.hooks.sendTo = (_id, msg) => { if (msg.t === S2C.SNAPSHOT) snap = msg.d; };
  inst.startChamber(c.floor);
  inst.broadcastSnapshot();
  const first = snap?.chamber;
  killAll(inst);
  advance(inst, 0.05);
  inst.broadcastSnapshot();
  const gap = snap?.chamber;
  ok('the snapshot carries wave, count and disorder',
    first?.wave === 1 && first?.waves === c.waves.length && first?.disorder === c.disorder
    && first?.remaining === c.waves[0].length,
    JSON.stringify(first));
  ok('...and counts the breather down for the HUD', gap?.waveIn > 0 && gap.waveIn <= CHAMBER_WAVE_GAP,
    `waveIn ${gap?.waveIn}`);
  ok('the player is still standing in it', p.alive);

  // Floor 1 has no 地脉异常, and the snapshot has to say `null` rather than carrying the
  // previous run's. In its own instance: `startChamber` refuses to restart a run that is
  // still `running` (it *is* the reset — see `shared/world/zoneInstance.js`), so asking this
  // question on the instance above would photograph floor 2's `frostVein` and call it floor
  // 1's. Which is what it did until the guard landed.
  const plain = arena();
  let snap2 = null;
  plain.inst.hooks.sendTo = (_id, msg) => { if (msg.t === S2C.SNAPSHOT) snap2 = msg.d; };
  plain.inst.startChamber(1);
  plain.inst.broadcastSnapshot();
  ok('a floor with no disorder says so rather than inventing one',
    snap2?.chamber?.floor === 1 && snap2.chamber.disorder === null,
    JSON.stringify(snap2?.chamber));
}

/* ============================================== 3. disorders, measured twice -- */

console.log('\n-- disorder effects, each against a control that must not move --');

/**
 * Two identical fights, one under `disorderId` and one under nothing.
 *
 * The disorder is assigned to the live chamber rather than picked by floor, so the two runs
 * differ in exactly one thing: same zone, same floor, same level, same build. What each
 * effect is worth is then a ratio, and a ratio that does not move is the control.
 */
function underDisorder(disorderId, fn, { floor = 1, state = 'running' } = {}) {
  const { inst, p, st } = arena();
  inst.startChamber(floor);
  inst.chamber.disorder = disorderById(disorderId);
  inst.chamber.state = state;
  drain(inst);
  return fn({ inst, p, st });
}

// (a) enemyHpMul — read off the spawned enemy, which is the only place it can be read.
{
  const hpOf = (id) => underDisorder(id, ({ inst }) => {
    inst.enemies.clear();
    inst.chamber.wave = 0;
    inst._spawnWave(inst.chamber);
    return [...inst.enemies.values()][0].maxHp;
  });
  const base = hpOf(null), frost = hpOf('frostVein'), storm = hpOf('stormVein');
  ok('凝霜地脉 spawns tougher enemies',
    Math.abs(ratio(frost, base) - DISORDERS.frostVein.enemyHpMul) < 0.02,
    `${Math.round(base)} -> ${Math.round(frost)} = ${fmt(ratio(frost, base))}x`);
  ok('...and a disorder without enemyHpMul changes nothing',
    Math.abs(ratio(storm, base) - 1) < 0.001, `${fmt(ratio(storm, base))}x`);
}

// (b) enemyDmgMul — through `damagePlayer`, which is the funnel every enemy hit lands in.
{
  const hurt = (id, opts) => underDisorder(id, ({ inst, p }) => {
    p.hp = p.maxHp();
    return inst.damagePlayer(p, 500, 'physical', 0, null, {});
  }, opts);
  const base = hurt(null), ember = hurt('emberVein'), stone = hurt('stoneVein');
  const cleared = hurt('emberVein', { state: 'cleared' });
  ok('炽炎地脉 makes every enemy hit harder',
    Math.abs(ratio(ember, base) - DISORDERS.emberVein.enemyDmgMul) < 0.02,
    `${Math.round(base)} -> ${Math.round(ember)} = ${fmt(ratio(ember, base))}x`);
  ok('...and a disorder without enemyDmgMul does not',
    Math.abs(ratio(stone, base) - 1) < 0.005, `${fmt(ratio(stone, base))}x`);
  ok('...and a floor that is no longer running stops buffing anything',
    Math.abs(ratio(cleared, base) - 1) < 0.005, `${fmt(ratio(cleared, base))}x after the clear`);
}

// (c) enemyRes and playerElemBonus — through `playerHitEnemy`, once per element, so the
// element the disorder does *not* name is the control.
{
  const hit = (id, element) => underDisorder(id, ({ inst, p, st }) => {
    const e = inst.spawnEnemy('hilichurl', LEVEL, 4, 4, { homeRadius: 60 });
    const r = inst.playerHitEnemy(p, e, { scaling: 4, element, gauge: 0, kind: 'skill', charId: st.charId });
    return r.total;
  });
  const fireBase = hit(null, 'fire'), fireEmber = hit('emberVein', 'fire');
  const iceBase = hit(null, 'ice'), iceEmber = hit('emberVein', 'ice');
  // Expected worth, derived rather than guessed: a hilichurl has no fire entry, so its
  // resistance is the 0.1 default, and `resMultiplier` is not linear — it has a separate
  // branch below zero (1 - res/2), which is exactly where −40 % lands it. A hand-written
  // 「should be 1.4x」 would have been wrong by that branch.
  const dRes = ENEMIES.hilichurl.res.fire ?? 0.1;
  const wantFire = resMultiplier(dRes + DISORDERS.emberVein.enemyRes.fire) / resMultiplier(dRes);
  ok('炽炎地脉 strips fire resistance',
    Math.abs(ratio(fireEmber, fireBase) - wantFire) < 0.02,
    `fire ${Math.round(fireBase)} -> ${Math.round(fireEmber)} = ${fmt(ratio(fireEmber, fireBase))}x, want ${fmt(wantFire)}x`);
  ok('...only for fire', Math.abs(ratio(iceEmber, iceBase) - 1) < 0.01,
    `ice ${Math.round(iceBase)} -> ${Math.round(iceEmber)} = ${fmt(ratio(iceEmber, iceBase))}x`);

  const icePhys = hit(null, 'physical'), frostPhys = hit('frostVein', 'physical');
  const iceFrost = hit('frostVein', 'ice');
  const pRes = ENEMIES.hilichurl.res.physical ?? 0.1;
  const wantPhys = resMultiplier(pRes + DISORDERS.frostVein.enemyRes.physical) / resMultiplier(pRes);
  ok('凝霜地脉 armours the floor against physical damage',
    Math.abs(ratio(frostPhys, icePhys) - wantPhys) < 0.02,
    `physical ${Math.round(icePhys)} -> ${Math.round(frostPhys)} = ${fmt(ratio(frostPhys, icePhys))}x, want ${fmt(wantPhys)}x`);
  ok('...and pays the elements it names',
    Math.abs(ratio(iceFrost, iceBase) - (1 + DISORDERS.frostVein.playerElemBonus.ice)) < 0.03,
    `ice ${Math.round(iceBase)} -> ${Math.round(iceFrost)} = ${fmt(ratio(iceFrost, iceBase))}x`);
}

// (d) reactionBonus — the one field `balance-check` cannot see, so it has to be measured
// here. The control is the same hit with no aura to react with.
{
  const hit = (id, { aura }) => underDisorder(id, ({ inst, p, st }) => {
    const e = inst.spawnEnemy('hilichurl', LEVEL, 4, 4, { homeRadius: 60 });
    if (aura) e.aura.apply(aura, 2, inst.now);
    const r = inst.playerHitEnemy(p, e, {
      scaling: 4, element: 'lightning', gauge: 1, kind: 'skill', charId: st.charId,
    });
    return { total: r.total, reaction: r.reaction };
  });
  const plain = hit(null, { aura: null }), plainStorm = hit('stormVein', { aura: null });
  const react = hit(null, { aura: 'water' }), reactStorm = hit('stormVein', { aura: 'water' });
  ok('the reaction fires at all', react.reaction === 'electroCharged' && react.total > plain.total,
    `${react.reaction} ${Math.round(plain.total)} -> ${Math.round(react.total)}`);
  ok('雷鸣地脉 pays for reactions', ratio(reactStorm.total, react.total) > 1.05,
    `${Math.round(react.total)} -> ${Math.round(reactStorm.total)} = ${fmt(ratio(reactStorm.total, react.total))}x`);
  ok('...and pays nothing for a hit that reacts with nothing',
    Math.abs(ratio(plainStorm.total, plain.total) - 1) < 0.01,
    `${fmt(ratio(plainStorm.total, plain.total))}x`);
}

// (e) the shape the client is handed. `disorderInfo` is what rides the CHAMBER event, and a
// missing hint there is a silent floor.
{
  const bad = DISORDER_IDS.filter((id) => {
    const info = disorderInfo(id);
    return !info || info.id !== id || !info.name || !info.hint;
  });
  ok('every disorder can describe itself to the client', !bad.length, bad.join(' '));
  ok('...and an absent one is null rather than a blank chip', disorderInfo(null) === null
    && disorderInfo('nope') === null);
}

/* ================================ 4. who may start a floor, and who says so -- */

// The sequential-unlock rule used to be written three times (gateway, REST route, 单机
// localSocket) and read zero times by the UI, which is the worst possible split: three copies
// that can drift, and a map panel that offered all fourteen floors and let the server explain.
// `chamberEntry` is the one rule. This section is its truth table — every refusal has to fire
// *and* have a case where it clears, or a mutation that hard-codes `{ok:true}` passes half of
// them — plus the consumer gate that keeps the copies from coming back.
console.log('\n-- the entry rule --');

{
  const dz = DUNGEONS.find((z) => (z.entryRank ?? 1) <= 1);
  const gated = DUNGEONS.find((z) => (z.entryRank ?? 1) > 1);
  const AR = 60;                                   // high enough that rank is never the reason
  const starred = { [dz.id]: { 1: { stars: 1, bestTime: 30 } } };

  ok('floor 1 of the starter dungeon is open to a fresh guest',
    chamberEntry(dz, 1, { adventureRank: 1 }).ok === true
    && chamberEntry(dz, 1, { adventureRank: 1 }).chamber?.floor === 1,
    `${dz.id} entryRank ${zoneEntryRank(dz)}`);

  const locked = chamberEntry(dz, 2, { adventureRank: AR });
  ok('...but floor 2 is shut until floor 1 is starred',
    locked.ok === false && locked.error === 'previous_floor_locked' && locked.prevFloor === 1,
    JSON.stringify(locked));
  ok('...and one star on floor 1 opens it',
    chamberEntry(dz, 2, { adventureRank: AR, abyss: starred }).ok === true);
  ok('...while a zero-star record does not',
    chamberEntry(dz, 2, { adventureRank: AR, abyss: { [dz.id]: { 1: { stars: 0 } } } }).error
      === 'previous_floor_locked');
  // The save round-trips through JSONB, so the floor keys come back as strings. A rule that
  // only reads numbers unlocks nothing after a reload.
  ok('...whichever way the save spells the floor key',
    chamberEntry(dz, 2, { adventureRank: AR, abyss: { [dz.id]: { '1': { stars: 2 } } } }).ok === true
    && chamberEntry(dz, 3, { adventureRank: AR, abyss: starred }).error === 'previous_floor_locked',
    'string key opens 2, and 3 stays shut');
  ok('...and a record from a *different* dungeon opens nothing',
    chamberEntry(dz, 2, { adventureRank: AR, abyss: { [gated.id]: { 1: { stars: 3 } } } }).error
      === 'previous_floor_locked');

  const need = zoneEntryRank(gated);
  const under = chamberEntry(gated, 1, { adventureRank: need - 1 });
  ok('a dungeon above the player rank refuses every floor',
    under.error === 'rank_too_low' && under.need === need, `${gated.id} needs ${need}`);
  ok('...and clears at exactly that rank',
    chamberEntry(gated, 1, { adventureRank: need }).ok === true);
  // Precedence: a request that is both rank-locked and floor-locked reports the rank, because
  // that is the one the player can do something about — grinding floor 1 is not available yet.
  ok('...and rank is reported before the floor lock',
    chamberEntry(gated, 2, { adventureRank: need - 1 }).error === 'rank_too_low'
    && chamberEntry(gated, 2, { adventureRank: need }).error === 'previous_floor_locked');

  ok('an open-world zone is not a dungeon',
    chamberEntry(ZONES.mondstadt, 1, { adventureRank: AR }).error === 'not_a_dungeon'
    && chamberEntry(null, 1, { adventureRank: AR }).error === 'not_a_dungeon'
    && chamberEntry('nope', 1, { adventureRank: AR }).error === 'not_a_dungeon');
  ok('a floor that does not exist is named as such',
    chamberEntry(dz, 99, { adventureRank: AR }).error === 'no_such_chamber'
    && chamberEntry(dz, 0, { adventureRank: AR }).error === 'no_such_chamber');
  // Both readings: the enforcers hold a zone *definition*, the panel sometimes an id.
  ok('the rule answers the same for a zone id and a zone definition',
    chamberEntry(dz.id, 2, { adventureRank: AR }).error
      === chamberEntry(dz, 2, { adventureRank: AR }).error
    && chamberEntry(dz.id, 1, { adventureRank: 1 }).ok === true);

  const busy = chamberEntry(dz, 1, { adventureRank: AR, chamber: { state: 'running', floor: 2 } });
  ok('a live run blocks every floor, and names the one that is live',
    busy.error === 'chamber_in_progress' && busy.runningFloor === 2, JSON.stringify(busy));
  // The states the producer actually sends (`zoneInstance` writes 'running', 'cleared',
  // 'failed'): a finished floor must not keep the door shut, or the panel locks itself.
  ok('...and a finished one blocks nothing',
    chamberEntry(dz, 1, { adventureRank: AR, chamber: { state: 'cleared', floor: 1 } }).ok === true
    && chamberEntry(dz, 1, { adventureRank: AR, chamber: { state: 'failed', floor: 1 } }).ok === true
    && chamberEntry(dz, 1, { adventureRank: AR, chamber: null }).ok === true);
}

// The consumer gate. Two directions: every place that decides whether a floor may start has to
// call the shared rule, and no place may spell the rule out again. The second half is the one
// that rots — an inlined `abyss[...][floor - 1]` somewhere else looks correct and drifts.
{
  const consumers = [
    ['server/src/ws/gateway.js', 'C2S.START_CHAMBER (联机)'],
    ['server/src/routes/world.js', 'POST /api/world/chamber'],
    ['client/src/net/localSocket.js', 'START_CHAMBER (单机)'],
    ['client/src/ui/panels.js', '地图面板的层数列表'],
  ];
  const missing = consumers.filter(([f]) => {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    // Both halves: imported *from the shared module* (a local helper of the same name would
    // be exactly the drift this gate exists to stop) and actually called.
    return !/chamberEntry\s*\(/.test(src)
      || !/import\s*\{[^}]*\bchamberEntry\b[^}]*\}\s*from\s*['"][^'"]*zones\.js['"]/.test(src);
  }).map(([f, what]) => `${what} (${f})`);
  ok(`all ${consumers.length} deciders call chamberEntry`, !missing.length, missing.join(', '));

  const reinlined = consumers.filter(([f]) => {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    return /abyss\??\.?\[[^\]]*\]\s*\?\.\[\s*floor\s*-\s*1/.test(src)
      || /previous_floor_locked'\s*\)/.test(src);
  }).map(([f]) => f);
  ok('...and none of them spells the unlock rule out again', !reinlined.length, reinlined.join(', '));
}

/* ================================ 5. the star rating, and what a star costs -- */

// `balance-check` already argues about *where* the thresholds should sit (3★ between 1.15x and
// 2.00x a parity party's measured clear). This section is about the two things that sit on top
// of those numbers and had never been asserted at all:
//
//   * the comparison chain that turns a time into a rating. It was written out three times —
//     the REST route, the WS instance, and balance-check's own report — so a floor could be
//     paid for a time its own audit called two stars. It is `chamberStars` now.
//   * what a *new* star is worth. The reward block paid `gained * 20` primogems (per star)
//     next to a full floor's mora and a full `chamberXp` **per improvement**, so clearing
//     floor 8 at 1★, then 2★, then 3★ paid 3 x 24 000 mora for one floor. Nothing authored
//     that; it is a reward for progress priced per visit. `chamberMilestone` denominates it
//     in stars, and the property that makes it checkable is that the parts sum to the whole.
console.log('\n-- the star rating --');

{
  const EPS = 1e-3;
  // The truth table below reads `stars[n] + EPS` as "one star worse", which is only a fair
  // reading if the thresholds are strictly descending by more than EPS. Pin that first, or a
  // pair of equal thresholds would make half the table vacuous.
  const notDescending = FLOORS.filter(({ c }) =>
    !(c.stars[0] - c.stars[1] > EPS && c.stars[1] - c.stars[2] > EPS));
  ok(`all ${FLOORS.length} floors' thresholds descend with room to step between them`,
    !notDescending.length,
    notDescending.map(({ z, c }) => `${z.id}#${c.floor} [${c.stars}]`).join(', '));

  // Every floor, both sides of all three boundaries. The inclusive side is the one a player
  // acts on ("三星 25s" has to mean 25.0 earns it) and the one a `<` / `<=` slip flips.
  const wrong = [];
  for (const { z, c } of FLOORS) {
    const table = [
      [0, 3], [c.stars[2] / 2, 3], [c.stars[2], 3],
      [c.stars[2] + EPS, 2], [c.stars[1], 2],
      [c.stars[1] + EPS, 1], [c.stars[0], 1],
      [c.stars[0] + EPS, 0], [c.timeLimit + 1, 0],
    ];
    for (const [t, want] of table) {
      const got = chamberStars(c, t);
      if (got !== want) wrong.push(`${z.id}#${c.floor} t=${t} -> ${got}, want ${want}`);
    }
  }
  ok(`the rating is exact on both sides of all ${FLOORS.length * 3} thresholds`,
    !wrong.length, wrong.slice(0, 6).join('; ') || `${FLOORS.length * 9} readings`);

  // A rating may never *improve* as a run gets slower. This is the shape assertion the table
  // above cannot make: it would pass for a chain that answers 2, 3, 1 in that order.
  const nonMono = [];
  for (const { z, c } of FLOORS) {
    let last = 4;
    for (let i = 0; i <= 60; i++) {
      const s = chamberStars(c, (c.timeLimit * 1.2 * i) / 60);
      if (s > last) nonMono.push(`${z.id}#${c.floor}`);
      last = s;
    }
  }
  ok('...and never rises as the clear gets slower', !nonMono.length, [...new Set(nonMono)].join(', '));

  // Garbage in, zero out — the enforcers hand this whatever `chambers.find(...)` returned,
  // which is `undefined` for a floor that does not exist, and `time` comes off the wire.
  const dz = DUNGEONS[0], c1 = dz.chambers[0];
  ok('a missing or malformed chamber rates zero rather than throwing',
    chamberStars(undefined, 1) === 0 && chamberStars(null, 1) === 0
    && chamberStars({}, 1) === 0 && chamberStars({ stars: [30, 20] }, 1) === 0
    && chamberStars({ stars: 'fast' }, 1) === 0);
  ok('...and so does a time that is not a time',
    chamberStars(c1, -1) === 0 && chamberStars(c1, NaN) === 0
    && chamberStars(c1, undefined) === 0 && chamberStars(c1, 'fast') === 0);
}

console.log('\n-- what a new star is worth --');

{
  const paths = [
    ['0 -> 3 in one clear', [[0, 3]]],
    ['0 -> 1 -> 2 -> 3', [[0, 1], [1, 2], [2, 3]]],
    ['0 -> 2 -> 3', [[0, 2], [2, 3]]],
    ['0 -> 1 -> 3', [[0, 1], [1, 3]]],
  ];
  const walk = (c, steps) => steps.reduce((acc, [a, b]) => {
    const m = chamberMilestone(c, a, b);
    return {
      gained: acc.gained + m.gained, primogem: acc.primogem + m.primogem,
      mora: acc.mora + m.mora,
      adventure: acc.adventure + m.xp.adventure, party: acc.party + m.xp.party,
    };
  }, { gained: 0, primogem: 0, mora: 0, adventure: 0, party: 0 });

  // The authored whole, straight from the sources the old per-visit code used, so this is the
  // baseline assertion too: a single three-star clear must pay *exactly* what it always paid.
  const off = [];
  for (const { z, c } of FLOORS) {
    const full = chamberXp(c.level);
    const want = {
      gained: 3, primogem: 20 * CHAMBER_MAX_STARS, mora: chamberMoraFull(c.floor),
      adventure: full.adventure, party: full.party,
    };
    for (const [name, steps] of paths) {
      const got = walk(c, steps);
      for (const k of Object.keys(want)) {
        if (got[k] !== want[k]) off.push(`${z.id}#${c.floor} ${name} ${k}=${got[k]} want ${want[k]}`);
      }
    }
  }
  ok(`every path from 0 to 3 stars pays the same total, on all ${FLOORS.length} floors`,
    !off.length, off.slice(0, 5).join('; ')
    || `${paths.length} paths x ${FLOORS.length} floors, 5 currencies`);

  // The faucet, pinned by name. The three-visit ladder is the case that used to pay triple;
  // this asserts the *specific wrong number* is no longer reachable, which a rounding-only
  // check would not (round(T/3) x 3 happens to equal T for these totals).
  const deep = FLOORS.map(({ c }) => c).reduce((a, b) => (b.level > a.level ? b : a));
  const ladder = walk(deep, [[0, 1], [1, 2], [2, 3]]);
  const oneShot = walk(deep, [[0, 3]]);
  ok('three slow clears of the deepest floor do not pay three floors',
    ladder.mora === oneShot.mora && ladder.mora !== oneShot.mora * 3
    && ladder.party === oneShot.party && ladder.party !== oneShot.party * 3,
    `floor ${deep.floor}: ladder ${ladder.mora} mora / ${ladder.party} xp`
    + ` vs the old per-visit ${oneShot.mora * 3} / ${oneShot.party * 3}`);

  // Each step is a real payment, or "the parts sum to the whole" is satisfied by paying
  // everything at the last star and nothing before it.
  const silent = [];
  for (const { z, c } of FLOORS) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 3]]) {
      const m = chamberMilestone(c, a, b);
      if (!(m.gained === 1 && m.primogem > 0 && m.mora > 0
        && m.xp.party > 0 && m.xp.adventure > 0)) silent.push(`${z.id}#${c.floor} ${a}->${b}`);
    }
  }
  ok('...and each single star pays something on its own', !silent.length, silent.slice(0, 5).join(', '));

  // The other side of the same rule: a clear that beats no record is worth nothing at all.
  const free = [];
  for (const { z, c } of FLOORS) {
    for (const [a, b] of [[0, 0], [1, 1], [3, 3], [2, 1], [3, 0], [3, 2]]) {
      const m = chamberMilestone(c, a, b);
      if (m.gained !== 0 || m.primogem !== 0 || m.mora !== 0
        || m.xp.party !== 0 || m.xp.adventure !== 0
        || Object.keys(m.reward).length !== 0) free.push(`${z.id}#${c.floor} ${a}->${b}`);
    }
  }
  ok('a clear that beats no record pays nothing', !free.length, free.slice(0, 5).join(', '));

  // `stars` arrives from a sim that could always send a fourth star, and `prevStars` from a
  // stored row. Neither may buy more than the floor is worth.
  const c1 = FLOORS[0].c;
  const capped = chamberMilestone(c1, 0, 9), whole = chamberMilestone(c1, 0, 3);
  ok('...and no input buys more than the floor is worth',
    capped.mora === whole.mora && capped.gained === CHAMBER_MAX_STARS
    && chamberMilestone(c1, -5, 3).mora === whole.mora
    && chamberMilestone(c1, 9, 3).gained === 0,
    `${capped.mora} mora`);

  // `reward` is the map handed to `repo.addItems`; it has to agree with the numbers the caller
  // also adds to the in-memory player, or the two halves of the write drift apart.
  const m = chamberMilestone(c1, 1, 3);
  ok('the item map matches the numbers the caller credits in memory',
    m.reward.primogem === m.primogem && m.reward.mora === m.mora
    && Object.keys(m.reward).sort().join(',') === 'mora,primogem',
    JSON.stringify(m.reward));

  // A floor definition the caller could not find still has to price *something*, because
  // `grantChamberClear` falls back to `{ floor, level }` for an unknown floor.
  const bare = chamberMilestone({ floor: 4, level: 40 }, 0, 3);
  ok('a bare {floor, level} prices the same as the real definition',
    bare.mora === chamberMoraFull(4) && bare.xp.party === chamberXp(40).party,
    `${bare.mora} mora / ${bare.xp.party} xp`);
}

// The consumer gate, both ways again. A rating rule with no callers is what the *previous*
// three copies looked like from here.
{
  const raters = [
    ['server/src/routes/world.js', 'POST /api/world/chamber'],
    ['shared/src/world/zoneInstance.js', 'the instance that ends the fight'],
    ['tools/balance-check.mjs', 'the reachability audit'],
  ];
  const missing = raters.filter(([f]) => {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    return !/chamberStars\s*\(/.test(src)
      || !/import\s*\{[^}]*\bchamberStars\b[^}]*\}\s*from\s*['"][^'"]*zones\.js['"]/.test(src);
  }).map(([f, what]) => `${what} (${f})`);
  ok(`all ${raters.length} raters call chamberStars`, !missing.length, missing.join(', '));

  // The half that rots: `time <= c.stars[2] ? 3 : ...` reads as obviously correct wherever it
  // is written, which is exactly why it came back twice.
  const reinlined = raters.filter(([f]) => {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    return /stars\s*\[\s*2\s*\]\s*\?/.test(src) || /<=\s*[\w.?]*\bstars\s*\[/.test(src);
  }).map(([f]) => f);
  ok('...and none of them spells the comparison chain out again',
    !reinlined.length, reinlined.join(', '));

  const payers = [['server/src/services/progression.js', 'grantChamberClear']];
  const unpaid = payers.filter(([f]) => {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    return !/chamberMilestone\s*\(/.test(src)
      || !/import\s*\{[^}]*\bchamberMilestone\b[^}]*\}\s*from\s*['"][^'"]*zones\.js['"]/.test(src);
  }).map(([f, what]) => `${what} (${f})`);
  ok('the only reward path calls chamberMilestone', !unpaid.length, unpaid.join(', '));

  // And it must no longer be able to reach the per-visit ingredients directly: a live
  // `chamberXp` import or an inline `8000 + floor * 2000` there *is* the faucet.
  const src = readFileSync(path.join(ROOT, 'server/src/services/progression.js'), 'utf8');
  ok('...and cannot price a milestone by itself any more',
    !/\bchamberXp\b/.test(src) && !/8000\s*\+\s*\w*\s*\*\s*2000/.test(src)
    && !/gained\s*\*\s*20\b/.test(src));
}

console.log(`\nchamber-check: ${passes} passed, ${fails} failed`);
process.exit(fails);
