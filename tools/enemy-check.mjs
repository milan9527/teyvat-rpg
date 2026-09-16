// Enemy data: is every authored key alive, and does the ruin guard's weak point work?
//
//   node tools/enemy-check.mjs
//
// Two halves, and the second one is why the first exists.
//
// **The gate** (`shared/src/data/enemyGate.js`) checks `ENEMIES` and `ATTACK_MOVES` in both
// directions — every key against a named consumer, every consumer against something that
// carries it — and, because `client/src/gfx/enemies.js` imports cleanly under Node, it also
// compares the authored `weakspot` against the point the *geometry* puts the glowing eye at.
//
// **The behaviour** drives a real `ZoneInstance` in-process, the same code the gateway runs
// online and `localSocket` runs for 单机, and fires real projectiles through it. That is the
// only way to answer the question the gate cannot: a weak point that is declared, drawn and
// documented is still worthless if a shot at it deals ordinary damage — which is exactly the
// state `ruinGuard.weakspot` shipped in. `mult: 3.0` was authored, nothing multiplied by it.
//
// Section 7 is the same story a second time, found by looking for it: `shield.element` was
// authored on the mage (ice) and the herald (water), validated by the gate, drawn on the
// nameplate and serialised to every client, and `takeDamage` had no `element` parameter — so
// physical, fire and the shield's own element drained it at exactly the same rate.
//
// Exit code is the number of failed assertions.
import { readFileSync, existsSync } from 'node:fs';
import { ENEMIES, ATTACK_MOVES, attackShape } from '../shared/src/data/enemies.js';
import { enemyGateReport, ENEMY_KEYS, MOVE_KEYS } from '../shared/src/data/enemyGate.js';
import { ELEMENTS, ELEMENT_IDS, shieldBreakMul, AuraState } from '../shared/src/data/elements.js';
import { ENEMY_KINDS, buildEnemy } from '../client/src/gfx/enemies.js';
// The telegraph's geometry is client code that needs no GL context to build, so it is checked
// here with the data rather than left entirely to `tools/telegraph-check.mjs`.
import { Vfx, TELEGRAPH_MODES } from '../client/src/game/vfx.js';
import { ZoneInstance, ASSIST_RADIUS } from '../shared/src/world/zoneInstance.js';
import { Projectile } from '../shared/src/world/entity.js';
import { buildCharacterStats, makeWeapon } from '../shared/src/sim/loot.js';
import { S2C, TICK_MS } from '../shared/src/protocol.js';
// Resolved through the client's copy:  has its own node_modules (puppeteer only), so
// a bare 'three' does not resolve from here even though client/src/gfx/enemies.js — imported
// two lines up — gets it from client/node_modules.
import * as THREE from '../client/node_modules/three/build/three.module.js';

let passes = 0, fails = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); } else {
    fails++; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`);
  }
  return !!ok;
}

/* ============================================================================
   1. the gate
   ========================================================================== */
console.log('\n=== 1. every authored enemy key has a consumer, and vice versa');
{
  const { problems, skipped } = enemyGateReport({ kinds: ENEMY_KINDS, build: buildEnemy });
  check('the enemy catalogue passes its own gate', problems.length === 0,
    problems.length ? `\n       ${problems.join('\n       ')}`
      : `${Object.keys(ENEMIES).length} enemies, ${Object.keys(ATTACK_MOVES).length} moves,`
        + ` ${Object.keys(ENEMY_KEYS).length} keys, ${Object.keys(MOVE_KEYS).length} move keys`);
  // The gate is allowed to skip the geometry half when its caller has no client — this probe
  // does have one, so a skip here means the wiring above broke, not that the check passed.
  check('the geometry half of the gate actually ran', skipped.length === 0, skipped.join('; '));
}

/* ============================================================================
   2. fixtures: a stopped instance, one archer, one victim
   ========================================================================== */

const LEVEL = 60;
const DT = TICK_MS / 1000;

function world() {
  const inst = new ZoneInstance('mondstadt', 99, { broadcast: () => {} });
  inst.camps.length = 0;
  // 凯伦 carries the bow, so an aimed shot is the shot this mechanic is for.
  const st = buildCharacterStats({
    charId: 'kaelen', level: LEVEL, ascension: 4, talents: { normal: 1, skill: 1, burst: 1 },
    weapon: makeWeapon('huntersBow', LEVEL, 1), artifacts: {}, dupes: 0,
  });
  st.critRate = 0;                                  // deterministic: compare numbers, not dice
  const save = { playerId: 1, party: [st.charId], activeSlot: 0, zone: 'mondstadt', pos: { x: 0, y: 6, z: 0, ry: 0 } };
  const p = inst.addPlayer(1, 'p1', save, { [st.charId]: st });
  inst.stop();
  inst.enemies.clear();
  inst.now = 100;
  inst.events.length = 0;
  return { inst, p };
}

// Well clear of the terrain: `updateProjectiles` kills an arrow that goes below the ground,
// and the point here is the geometry of the enemy, not of the hill it stands on.
const BASE_Y = 6;

/**
 * A target standing at the origin, facing +Z (`ry = 0`), with hp nothing can exhaust.
 *
 * The shield is stripped by default: every weak-point case below wants the arrow to reach the
 * body, and an `abyssMage` spawned with its 900 points of ice would answer "the shield ate it"
 * to questions about the eye. Section 7 asks for it back.
 */
function target(inst, defId, ry = 0, keepShield = false) {
  const e = inst.spawnEnemy(defId, LEVEL, 0, 0);
  e.x = 0; e.y = BASE_Y; e.z = 0; e.ry = ry;
  e.maxHp = 1e12; e.hp = 1e12;
  e.state = 'idle'; e.stunned = 0;
  if (!keepShield) e.shield = null;
  return e;
}

/**
 * Fire one aimed arrow that travels from `from` to `to` in a single tick and report the
 * DAMAGE event it produced. Speed is derived from the distance so the segment is exactly the
 * one the caller asked for — the point of several of these cases is *where the arrow was at
 * the tick boundary*, which is not something to leave to a default.
 *
 * Both points are `[x, height above the target's feet, z]`, the same frame `weakspot.offset`
 * is authored in, so an assertion reads as "through the eye" rather than as three constants.
 */
function shoot(inst, p, e, from0, to0, opts = {}) {
  const from = [from0[0], e.y + from0[1], from0[2]];
  const to = [to0[0], e.y + to0[1], to0[2]];
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(...d) || 1;
  const pr = new Projectile({
    owner: p.playerId, ownerType: 'player', x: from[0], y: from[1], z: from[2],
    dx: d[0], dy: d[1], dz: d[2], speed: len / DT, damage: 0,
    element: 'physical', gauge: 0, radius: 0.9, life: 2.4, kind: 'arrow',
  });
  pr.meta = { scaling: 1, kind: opts.kind ?? 'aimed', aimed: opts.aimed ?? true };
  inst.projectiles.set(pr.id, pr);
  inst.events.length = 0;
  const before = e.hp;
  inst.updateProjectiles(DT);
  const ev = inst.events.find((x) => x.t === S2C.DAMAGE)?.d ?? null;
  return { ev, dealt: before - e.hp, landed: !!ev };
}

/* ============================================================================
   3. the weak point pays, and only where it is
   ========================================================================== */
console.log('\n=== 2. the ruin guard\'s eye');
{
  const ws = ENEMIES.ruinGuard.weakspot;
  const wz = ws.offset[2], wy = ws.offset[1];

  // Straight down the eye's own axis: start in front, finish on it.
  const { inst, p } = world();
  const guard = target(inst, 'ruinGuard');
  const eye = shoot(inst, p, guard, [0, wy, wz + 3.5], [0, wy, wz]);
  check('an arrow into the eye lands', eye.landed, `${Math.round(eye.dealt)} damage`);
  check('the hit is reported as a weak point', eye.ev?.weak === true, JSON.stringify(eye.ev?.weak));
  check('the eye stuns the machine', guard.stunned > inst.now,
    `stunned for ${(guard.stunned - inst.now).toFixed(2)}s (authored ${ws.stun})`);

  // Same arrow, same enemy, aimed at the chest instead.
  const w2 = world();
  const guard2 = target(w2.inst, 'ruinGuard');
  const body = shoot(w2.inst, w2.p, guard2, [0, 1.5, wz + 3.5], [0, 1.5, wz]);
  check('an arrow into the chest lands too', body.landed, `${Math.round(body.dealt)} damage`);
  check('the chest is not a weak point', !body.ev?.weak);
  check('the chest does not stun', guard2.stunned <= w2.inst.now);
  const ratio = body.dealt > 0 ? eye.dealt / body.dealt : 0;
  check(`the eye is worth ${ws.mult}× the chest`, Math.abs(ratio - ws.mult) < 0.02,
    `measured ${ratio.toFixed(3)}×`);

  // Facing away: the offset is in the creature's own frame, so turning it presents armour.
  const w3 = world();
  const back = target(w3.inst, 'ruinGuard', Math.PI);
  const behind = shoot(w3.inst, w3.p, back, [0, wy, wz + 3.5], [0, wy, wz]);
  check('the same shot at its back is not a weak point', behind.landed && !behind.ev?.weak,
    `landed ${behind.landed}, weak ${behind.ev?.weak ?? false}`);

  // The tick is 50 ms and an aimed arrow flies 3.5 m in one: the arrow that passes *through*
  // the eye and out the far side is the common case, not the edge case, and testing the
  // endpoint alone would score it as a miss.
  const w4 = world();
  const g4 = target(w4.inst, 'ruinGuard');
  const through = shoot(w4.inst, w4.p, g4, [0, wy, wz + 2.0], [0, wy, wz - 1.5]);
  check('an arrow that flies through the eye in one tick still counts',
    through.ev?.weak === true, `ended ${(1.5 + 0).toFixed(1)} m past it`);

  // And an arrow that stops short of the enemy must not be credited with anything.
  const w5 = world();
  const g5 = target(w5.inst, 'ruinGuard');
  const short = shoot(w5.inst, w5.p, g5, [0, wy, wz + 9], [0, wy, wz + 5.5]);
  check('an arrow that never reaches the machine deals nothing', !short.landed);
}

/* ============================================================================
   4. everything else keeps its old headshot rule
   ========================================================================== */
console.log('\n=== 3. enemies without an authored weak point');
{
  // `hilichurl` has no `weakspot`, so the generic rule still applies: an aimed shot into the
  // top third of the hitbox is a headshot worth the bow passive's crit damage, and nothing
  // is multiplied. This is the half of the change that must *not* have moved.
  const { inst, p } = world();
  const h = target(inst, 'hilichurl');
  const hb = ENEMIES.hilichurl.hitbox;
  const high = shoot(inst, p, h, [0, hb.h * 0.9, 3.5], [0, hb.h * 0.9, 0]);
  check('an aimed shot into a hilichurl\'s head lands', high.landed, `${Math.round(high.dealt)} damage`);
  check('it is not reported as a weak point (there is no authored one)', !high.ev?.weak);

  const w2 = world();
  const h2 = target(w2.inst, 'hilichurl');
  const low = shoot(w2.inst, w2.p, h2, [0, hb.h * 0.3, 3.5], [0, hb.h * 0.3, 0]);
  // The headshot bonus is crit damage, and crit rate is pinned to 0, so the *damage* is
  // identical — what is being checked is that neither shot claims the weakspot multiplier.
  check('a body shot and a head shot on a hilichurl deal the same base damage',
    Math.abs(high.dealt - low.dealt) < 1, `${Math.round(high.dealt)} vs ${Math.round(low.dealt)}`);

  // The ruin guard is the one enemy where the generic rule is *switched off*: its top third
  // includes both shoulders, and paying the same bonus there as at the eye would make the
  // eye pointless. Same geometry as the hilichurl case, opposite expectation.
  const w3 = world();
  const g = target(w3.inst, 'ruinGuard');
  const shoulder = shoot(w3.inst, w3.p, g, [1.3, 3.0, 3.5], [1.3, 3.0, 0]);
  check('an aimed shot at the ruin guard\'s shoulder claims nothing',
    shoulder.landed && !shoulder.ev?.weak,
    `landed ${shoulder.landed}, weak ${shoulder.ev?.weak ?? false}`);
}

/* ============================================================================
   5. every ranged enemy fires at its own authored speed
   ========================================================================== */
console.log('\n=== 4. projectile speed comes from the enemy, not from a default');
{
  // The gate found this one: `basicRanged` used to carry `projectileSpeed: 20` and the move's
  // value is checked *first*, so `slimeElectro: 14`, `hilichurlArcher: 26` and `abyssMage: 16`
  // were all dead numbers — every fallback shot in the game travelled at 20 (or 15 for a
  // caster) regardless of what fired it. This drives the real `resolveEnemyAttack`.
  const speedOf = (defId, moveId) => {
    const { inst, p } = world();
    const e = target(inst, defId);
    e.targetId = p.playerId;
    p.x = 0; p.z = 12; p.y = e.y;
    inst.projectiles.clear();
    inst.resolveEnemyAttack(e, ATTACK_MOVES[moveId], DT);
    return [...inst.projectiles.values()][0]?.speed ?? null;
  };
  for (const [id, moveId] of [['slimeElectro', 'basicRanged'], ['hilichurlArcher', 'basicRanged'],
    ['abyssMage', 'basicCast'], ['ruinGuard', 'missileBarrage']]) {
    const want = ENEMIES[id].projectileSpeed;
    const got = speedOf(id, moveId);
    check(`${id} fires ${moveId} at its own ${want} m/s`, got === want, `got ${got}`);
  }
  // The other direction: a move that authors its own speed still overrides the enemy's. Not a
  // pairing the AI would ever make (`tideLance` belongs to the herald) — the resolution *rule*
  // is what is under test, and it only has content if both directions are pinned.
  check('a move with its own speed overrides the enemy default',
    speedOf('hilichurlArcher', 'tideLance') === ATTACK_MOVES.tideLance.projectileSpeed,
    `${speedOf('hilichurlArcher', 'tideLance')} vs enemy ${ENEMIES.hilichurlArcher.projectileSpeed}`);
}

/* ============================================================================
   6. every enemy still builds, and its model matches its hitbox
   ========================================================================== */
console.log('\n=== 5. every enemy builds and fits its hitbox');
{
  let bad = 0;
  const notes = [];
  for (const [id, def] of Object.entries(ENEMIES)) {
    let built = null;
    try { built = buildEnemy(id, { outline: false, aura: false }); } catch (err) {
      notes.push(`${id}: ${err.message}`); bad++; continue;
    }
    const want = (def.hitbox.h) * (def.model.scale ?? 1);
    if (Math.abs(built.height - want) > 1e-6) { notes.push(`${id}: height ${built.height} != ${want}`); bad++; }
    built.dispose?.();
  }
  check('all 12 enemy models build at their hitbox height', bad === 0,
    notes.join(' | ') || `${Object.keys(ENEMIES).length} models`);
}

/* ============================================================================
   7. the eye is actually the frontmost thing at the point you aim at
   ========================================================================== */
console.log('\n=== 6. the weak point is not buried in its own head');
{
  // 画出来、点亮了、却看不见. The old glowing sphere sat on the *back* of the neck, half
  // inside the head hood — which is fine for a vent and useless for a target. Now that the
  // data and the geometry are the same expression, the remaining way to break this is to
  // bury the eye: grow the hood, and the weak point becomes a thing the simulation rewards
  // and the player cannot see. A ray is the cheap version of the screenshot: cast one at the
  // eye and ask whether the first surface it meets is the glow material.
  const built = buildEnemy('ruinGuard', { outline: false, aura: false });
  built.group.updateMatrixWorld(true);
  const eye = new THREE.Vector3(...built.weakspot.offset);
  const rc = new THREE.Raycaster();
  // The builder merges every part into one mesh *per material list*, so the hit object's
  // `material` is an array and the face's `materialIndex` is what says which part was struck.
  // Comparing `object.material` to `materials.glow` is always false and would have passed the
  // "not glowing" assertions for free.
  const matOf = (h) => (Array.isArray(h.object.material)
    ? h.object.material[h.face?.materialIndex ?? 0] : h.object.material);
  const firstHit = (at, fromDir) => {
    const from = at.clone().add(new THREE.Vector3(...fromDir).multiplyScalar(6));
    rc.set(from, at.clone().sub(from).normalize());
    const hits = rc.intersectObject(built.group, true).filter((h) => !h.object.userData.noOutline);
    if (!hits[0]) return null;
    const m = matOf(hits[0]);
    return { glow: m === built.materials.glow, hex: m?.color?.getHexString(), d: hits[0].distance };
  };
  const front = firstHit(eye, [0, 0, 1]);
  check('a shot at the eye from the front reaches the glowing part first',
    front?.glow === true,
    front ? `first surface #${front.hex} at ${front.d.toFixed(2)} m along a 6 m ray` : 'no hit at all');
  // Both directions, or the assertion is just "the model has a glow material somewhere":
  // the same ray aimed at the chest must NOT come back glowing, and the eye must be hidden
  // from behind (it is one eye on a face, not a lamp on a pole).
  const chest = firstHit(new THREE.Vector3(0, 1.6, 0), [0, 0, 1]);
  check('the same ray at the chest lands on armour, not on glow', chest && !chest.glow,
    chest ? `#${chest.hex} at ${chest.d.toFixed(2)} m` : 'no hit');
  const back = firstHit(eye, [0, 0, -1]);
  check('from behind, the head blocks the eye', back && !back.glow,
    back ? `#${back.hex} at ${back.d.toFixed(2)} m` : 'no hit');
  built.dispose?.();
}

/* ============================================================================
   8. the shield is made of an element, and the sim charges by it
   ========================================================================== */
console.log('\n=== 7. an ice shield is broken by fire, not by patience');
{
  const SH = ENEMIES.abyssMage.shield;          // { hp: 900, element: 'ice' }
  const FLAT = 100;

  /**
   * One hit of exactly `FLAT` damage on a shielded mage, through `applyDamageToEnemy` with no
   * owning player: that branch calls `takeDamage` with the number it was given, so the shield's
   * *rate* is readable as arithmetic instead of being buried under atk, res and level scaling.
   * `gauge` is ignored on that path, which is what this section wants — the question here is
   * what the shield charges, not what a reaction pays.
   */
  const hit = (element, shieldHp = SH.hp, flat = FLAT) => {
    const { inst } = world();
    const e = target(inst, 'abyssMage', 0, true);
    e.shield.hp = shieldHp;
    const hp0 = e.hp;
    inst.events.length = 0;
    inst.applyDamageToEnemy(e, flat, element, 0, null, 'field');
    const ev = inst.events.find((x) => x.t === S2C.DAMAGE)?.d ?? null;
    return { e, ev, drained: shieldHp - e.shield.hp, toBody: hp0 - e.hp, now: inst.now };
  };

  check('the mage spawns with the shield the data authored',
    hit('physical').e.shield.element === SH.element,
    `${SH.hp} ${SH.element}`);

  // The rate, element by element, against the table the rule is derived from. Before this
  // existed, all three of these drained exactly 100.
  for (const el of ['fire', 'ice', 'physical', 'light']) {
    const want = shieldBreakMul(el, SH.element);
    const r = hit(el);
    check(`${el} drains ${want}× the damage it deals off an ice shield`,
      Math.abs(r.drained - FLAT * want) < 0.01,
      `${r.drained.toFixed(1)} of ${FLAT} (×${(r.drained / FLAT).toFixed(2)})`);
    check(`  and the wire says so: shieldMul ${want}`, r.ev?.shieldMul === want,
      `got ${r.ev?.shieldMul}`);
    check('  the body takes nothing while the shield holds', r.toBody === 0 && r.ev?.absorbed === FLAT,
      `hp -${r.toBody}, absorbed ${r.ev?.absorbed}`);
  }

  // The two boundaries. A hit that exactly empties the shield must not also bruise the enemy —
  // that is the whole reason `takeDamage` converts the eaten amount back through the multiplier
  // (`absorbed = eaten / mul`) instead of subtracting the charged number from `dealt`.
  const exact = hit('fire', FLAT * shieldBreakMul('fire', SH.element));
  check('a fire hit that exactly empties the shield deals nothing to the body',
    exact.e.shield.hp === 0 && exact.toBody === 0,
    `shield ${exact.e.shield.hp}, hp -${exact.toBody}`);
  check('breaking the shield stuns for 2 s', exact.e.stunned - exact.now === 2.0,
    `stunned ${(exact.e.stunned - exact.now).toFixed(2)}s`);
  check('the break is reported', exact.ev?.shieldBroke === true, JSON.stringify(exact.ev?.shieldBroke));

  // Half a shield left: fire is charged ×2, so 100 damage eats the last 100 points with 50
  // damage worth of hit left over, and the leftover is what reaches hp.
  const over = hit('fire', FLAT);
  check('the overflow of a shield-breaking hit reaches hp at face value',
    Math.abs(over.toBody - FLAT * 0.5) < 0.01,
    `hp -${over.toBody.toFixed(1)}, absorbed ${over.ev?.absorbed} of ${FLAT}`);

  // Data ↔ sim, both ways: whichever element the *table* says is best has to be the element that
  // empties the shield fastest in the running instance. An assertion per element passes even if
  // the rule reads some other shield's row; this one fails if the ordering is wrong anywhere.
  const measured = Object.keys(ELEMENTS)
    .map((el) => [el, hit(el).drained]).sort((a, b) => b[1] - a[1]);
  const table = Object.keys(ELEMENTS)
    .map((el) => [el, shieldBreakMul(el, SH.element)]).sort((a, b) => b[1] - a[1]);
  check('the fastest element in the sim is the one the table names',
    measured[0][0] === table[0][0] && measured[measured.length - 1][0] === table[table.length - 1][0],
    `sim best ${measured[0][0]} (${measured[0][1]}), worst ${measured[measured.length - 1][0]};`
      + ` table best ${table[0][0]} ×${table[0][1]}`);

  // The shield is not an aura. If it were, every pyro character would get a free 融化 out of the
  // first swing *and* the ×2 shield rate — the same reaction paid twice — so the first fire hit
  // on a full-shielded mage must report no reaction at all.
  {
    const { inst, p } = world();
    const e = target(inst, 'abyssMage', 0, true);
    inst.events.length = 0;
    inst.playerHitEnemy(p, e, { scaling: 1.0, element: 'fire', gauge: 1, kind: 'normal', charId: p.charId });
    const ev = inst.events.find((x) => x.t === S2C.DAMAGE)?.d ?? null;
    check('a fire hit on an ice shield is not a reaction', ev && ev.reaction === null,
      `reaction ${JSON.stringify(ev?.reaction)}, shieldMul ${ev?.shieldMul}`);
    check('the player path carries the shield fields too',
      ev?.shieldMul === 2.0 && ev?.absorbed > 0,
      `shieldMul ${ev?.shieldMul}, absorbed ${ev?.absorbed} of ${ev?.amount}`);
    // And the character's own element still applies normally, so the *second* hit can react.
    check('the fire hit still left its own aura for the next one',
      e.aura.auras.has('fire'),
      [...e.aura.auras.keys()].join(',') || 'none');
  }

  // The gate half, from the other side: both rules it gained have to be able to fail.
  {
    const clone = (patch) => ({
      ...ENEMIES,
      abyssMage: { ...ENEMIES.abyssMage, shield: { ...SH, ...patch } },
    });
    const uncounterable = enemyGateReport({ enemies: clone({ element: 'wind' }) }).problems;
    check('the gate rejects a shield the roster cannot counter',
      uncounterable.some((s) => s.includes('nothing counters it')),
      uncounterable.find((s) => s.includes('counters')) || uncounterable.join(' | ') || 'no problem reported');
    const mismatched = enemyGateReport({ enemies: clone({ element: 'lightning' }) }).problems;
    check('the gate rejects a shield made of an element the enemy is not',
      mismatched.some((s) => s.includes('two elements for one creature')),
      mismatched.find((s) => s.includes('two elements')) || mismatched.join(' | ') || 'no problem reported');
  }
}

/* ============================================================================
   9. the consumer notes are claims about the code, so open the code
   ========================================================================== */
console.log('\n=== 8. every consumer note names a file that really reads the key');
{
  // `ENEMY_KEYS` and `MOVE_KEYS` are the whole point of the gate, and their values are prose:
  // "shared/src/world/zoneInstance.js#enemyStrike — × the enemy atk". Nothing checked that the
  // file existed, that the function existed, or that the key appeared in it, and three of the
  // seventeen move notes were false — `arc` credited `client/src/gfx/animator.js`, which has
  // never mentioned it; `shake` credited a camera shake in `_onEnemyAttack` that was never
  // written (0.5, 0.6 and 1.0 authored, read by nobody); `range` credited a decision that
  // `def.attackRange` makes. An unchecked note is exactly the rot this gate exists to catch,
  // one layer up.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const src = new Map();
  const read = (p) => {
    if (!src.has(p)) src.set(p, existsSync(p) ? strip(readFileSync(p, 'utf8')) : null);
    return src.get(p);
  };
  const audit = (tables) => {
    const bad = [];
    let notes = 0;
    for (const [table, keys] of tables) {
      for (const [key, note] of Object.entries(keys)) {
        notes++;
        const at = (s) => bad.push(`${table}.${key}: ${s}`);
        const paths = [...note.matchAll(/[\w./-]+\.js/g)].map((m) => m[0]);
        if (!paths.length) { at('names no file at all'); continue; }
        let reads = false;
        for (const p of paths) {
          const text = read(p);
          if (text === null) { at(`names ${p}, which does not exist`); continue; }
          // A property access, a destructuring, or the key as an object key: `mv.radius`,
          // `{ radius }`, `radius:`. Comments are stripped first, so a note cannot be satisfied
          // by another note — which is how `shake` used to look like a consumer.
          if (new RegExp(`\\.\\s*${key}\\b|\\b${key}\\s*:|\\b${key}\\s*[,}]`).test(text)) reads = true;
        }
        if (!reads) at(`no file it names reads .${key}`);
        for (const [, p, fn] of note.matchAll(/([\w./-]+\.js)#(\w+)/g)) {
          const text = read(p);
          if (text !== null && !new RegExp(`\\b${fn}\\s*\\(`).test(text)) at(`${p} has no ${fn}()`);
        }
      }
    }
    return { bad, notes };
  };
  const real = audit([['ENEMY_KEYS', ENEMY_KEYS], ['MOVE_KEYS', MOVE_KEYS]]);
  check('every declared key names a file that reads it', real.bad.length === 0,
    real.bad.length ? `\n       ${real.bad.join('\n       ')}` : `${real.notes} notes, ${src.size} files opened`);
  // Mutation test, through the same function: the three shapes of lie this was written for have
  // to come back as three problems, or the green above means nothing.
  const lies = audit([['FAKE', {
    nosuchkey: 'shared/src/world/zoneInstance.js — invented, nothing reads it',
    radius: 'shared/src/world/nosuchfile.js — a file that does not exist',
    arc: 'shared/src/data/enemies.js#nosuchFunction — a function that does not exist',
  }]]).bad;
  check('  and the audit catches a dead key, a missing file and a missing function',
    lies.some((s) => s.startsWith('FAKE.nosuchkey: no file'))
    && lies.some((s) => s.includes('nosuchfile.js, which does not exist'))
    && lies.some((s) => s.includes('has no nosuchFunction()')),
    lies.join(' | ') || 'nothing reported');
}

/* ============================================================================
   10. the shape drawn during the wind-up is the shape that hits
   ========================================================================== */
console.log('\n=== 9. attack telegraphs: authored geometry, drawn and enforced');
{
  /* ---- the two vocabularies, both directions ------------------------------- */
  const kinds = new Map();
  for (const [id, mv] of Object.entries(ATTACK_MOVES)) {
    const sh = attackShape(mv, ENEMIES.ruinGuard);
    if (!sh) { check(`${id} has a shape`, false, 'attackShape returned null'); continue; }
    kinds.set(sh.kind, (kinds.get(sh.kind) || []).concat(id));
  }
  const undrawable = [...kinds.keys()].filter((k) => TELEGRAPH_MODES[k] === undefined);
  check('every shape kind the data produces can be drawn', undrawable.length === 0,
    undrawable.join(',') || [...kinds.keys()].map((k) => `${k}×${kinds.get(k).length}`).join(' '));
  const undemanded = Object.keys(TELEGRAPH_MODES).filter((k) => !kinds.has(k));
  check('every mode the shader can draw is asked for by some move', undemanded.length === 0,
    undemanded.join(',') || `${Object.keys(TELEGRAPH_MODES).length} modes`);

  /* ---- what the sim accepts is what the shape promised --------------------- */
  // The whole claim of a telegraph is "outside this, you are safe". So drive the real
  // `resolveEnemyAttack` at the boundary from both sides: 5 cm inside `shape.hit` must hurt and
  // 5 cm outside must not. `HIT_SLACK` is in the shape, so this also pins the 0.6 m of tick
  // tolerance the drawn outline includes — draw the bare radius and the player loses 0.6 m of
  // ground they were told was safe.
  const owner = (moveId) => Object.keys(ENEMIES).find((id) => ENEMIES[id].attacks?.includes(moveId))
    || 'hilichurl';
  const struckAt = (moveId, dist, angle = 0) => {
    const { inst, p } = world();
    const e = target(inst, owner(moveId));
    e.targetId = p.playerId;
    p.x = Math.sin(angle) * dist; p.z = Math.cos(angle) * dist; p.y = e.y;
    inst.events.length = 0;
    inst.resolveEnemyAttack(e, ATTACK_MOVES[moveId], DT);
    return inst.events.some((x) => x.t === S2C.DAMAGE);
  };
  const EPS = 0.05;
  let boundary = 0;
  for (const [moveId, mv] of Object.entries(ATTACK_MOVES)) {
    const sh = attackShape(mv, ENEMIES[owner(moveId)]);
    if (sh.kind !== 'disc' || !mv.mult) continue;      // sector and lane get their own cases
    boundary++;
    const inside = struckAt(moveId, sh.hit - EPS);
    const outside = struckAt(moveId, sh.hit + EPS);
    check(`${moveId}: ${sh.hit.toFixed(1)} m disc hits inside its outline and not outside`,
      inside && !outside, `in ${inside}, out ${outside}`);
  }
  check('  every damaging disc move was tested', boundary >= 5, `${boundary} moves`);

  // The sector: same radius test, plus the facing. `arc` is 2.4 rad, so 137° of the 360.
  {
    const mv = ATTACK_MOVES.tailSweep;
    const sh = attackShape(mv, ENEMIES[owner('tailSweep')]);
    const half = sh.arc / 2;
    check('tailSweep hits inside its sector', struckAt('tailSweep', sh.hit - EPS, half - 0.05), `arc ${sh.arc}`);
    check('tailSweep misses just outside the sector edge',
      !struckAt('tailSweep', sh.hit - EPS, half + 0.05), `at ${(half + 0.05).toFixed(2)} rad`);
    check('tailSweep misses behind itself', !struckAt('tailSweep', sh.hit - EPS, Math.PI));
    check('tailSweep misses past its radius', !struckAt('tailSweep', sh.hit + EPS, 0));
  }

  // A projectile's range: authored per move, read by nothing until it became the shot's life.
  {
    const flight = (defId, moveId) => {
      const { inst, p } = world();
      const e = target(inst, defId);
      e.targetId = p.playerId;
      p.x = 0; p.z = 200; p.y = e.y;                 // far away: the shot expires, it never lands
      inst.projectiles.clear();
      inst.resolveEnemyAttack(e, ATTACK_MOVES[moveId], DT);
      const pr = [...inst.projectiles.values()][0];
      const x0 = pr.x, z0 = pr.z;
      let t = 0;
      while (!pr.dead && t < 20) { inst.updateProjectiles(DT); t += DT; }
      return { pr, flew: Math.hypot(pr.x - x0, pr.z - z0), life: pr.life };
    };
    for (const [defId, moveId] of [['abyssHerald', 'tideLance'], ['stormTyrant', 'featherStorm'],
      ['hilichurlArcher', 'basicRanged']]) {
      const mv = ATTACK_MOVES[moveId];
      const want = attackShape(mv, ENEMIES[defId]).length;
      const { flew } = flight(defId, moveId);
      const speed = mv.projectileSpeed || ENEMIES[defId].projectileSpeed;
      check(`${moveId} stops at its authored ${want} m range`, Math.abs(flew - want) <= speed * DT + 0.1,
        `flew ${flew.toFixed(2)} m at ${speed} m/s`);
    }
  }

  /* ---- the picture: what the client actually builds ------------------------ */
  // `client/src/game/vfx.js` imports cleanly under Node, so the decal's *geometry* can be
  // checked here rather than in a screenshot: a probe proves it reaches the screen
  // (`tools/telegraph-check.mjs`), and this proves it is the right size, which is the part that
  // used to be wrong. The old code drew `max(1.6, hitbox.r * 2.4)` — one number per creature —
  // for all seventeen moves.
  const scene = new THREE.Scene();
  const vfx = new Vfx(scene);
  const slope = (x, z) => 6 + x * 0.12 - z * 0.05;     // a hillside, so a flat decal shows up
  const draw = (moveId, defId = owner(moveId), ry = 0) => {
    const sh = attackShape(ATTACK_MOVES[moveId], ENEMIES[defId]);
    const ext = vfx.telegraph(sh, 4, -3, ry, 0xff8844, 1.0, slope);
    const o = vfx.decals.live.at(-1)?.o;
    return { sh, ext, o, uni: o?.material.uniforms };
  };
  vfx.clear();
  {
    let wrong = 0;
    const notes = [];
    for (const moveId of Object.keys(ATTACK_MOVES)) {
      const { sh, ext, uni } = draw(moveId);
      const [halfX, halfZ] = ext || [0, 0];
      // The quad must hold the boundary *plus* the outline that straddles it — a rim exactly on
      // the boundary clips the outer half of the line the player is meant to read.
      const edge = uni?.uEdge.value ?? 0;
      const wantX = sh.hit + edge;
      const wantZ = sh.hit + (sh.length ? sh.length / 2 : 0) + edge;
      const ok = uni && uni.uMode.value === TELEGRAPH_MODES[sh.kind]
        // The outline is the damage boundary. This is the assertion the whole round is for.
        && uni.uR.value === sh.hit
        && uni.uArc.value === (sh.arc || 0)
        && uni.uSpan.value === (sh.length ? sh.length / 2 : 0)
        && edge >= 0.1 && edge <= 0.34
        && (sh.kind === 'ring' ? halfX === halfZ && halfX > wantX : halfX === wantX && halfZ === wantZ);
      if (!ok) { wrong++; notes.push(`${moveId}: ${sh.kind} ${halfX}×${halfZ}, wanted ${wantX}×${wantZ}`); }
      vfx.clear();
    }
    check('all 17 moves draw their own authored extent', wrong === 0,
      notes.join(' | ') || `${Object.keys(ATTACK_MOVES).length} moves`);
  }

  // The defect, stated as a measurement: one creature's four moves must not all be the same
  // size. `stormTyrant.hitbox.r` is 2.0, so the old ring was 4.8 m wide for cyclone (8 m),
  // divebomb (5.5 m + an 18 m lane), featherStorm (a 26 m line) and windPrison (4 m) alike.
  {
    const sizes = ENEMIES.stormTyrant.attacks.map((m) => {
      const { ext } = draw(m, 'stormTyrant');
      vfx.clear();
      return [m, ext[0] * ext[1]];
    });
    const uniq = new Set(sizes.map(([, a]) => a.toFixed(3)));
    check('the tyrant\'s four moves are four different shapes', uniq.size === 4,
      sizes.map(([m, a]) => `${m} ${a.toFixed(1)} m²`).join(', '));
    const old = Math.max(1.6, (ENEMIES.stormTyrant.hitbox.r ?? 1) * 2.4);
    const biggest = Math.max(...sizes.map(([, a]) => a));
    check('  and the biggest is nothing like the hitbox ring it replaced', biggest > old * old * 2,
      `${biggest.toFixed(0)} m² vs the old ${(old * old).toFixed(0)} m²`);
  }

  // On a hillside the decal has to follow the ground: a flat quad buries its outline in the
  // slope exactly where an uphill player needs to read it.
  {
    const { o } = draw('cyclone', 'stormTyrant', 0.6);
    const p = o.geometry.attributes.position.array;
    let lo = Infinity, hi = -Infinity, off = 0;
    for (let i = 0; i < p.length; i += 3) {
      const wx = o.position.x + p[i] * Math.cos(o.rotation.y) + p[i + 2] * Math.sin(o.rotation.y);
      const wz = o.position.z - p[i] * Math.sin(o.rotation.y) + p[i + 2] * Math.cos(o.rotation.y);
      off = Math.max(off, Math.abs(p[i + 1] - (slope(wx, wz) + 0.07)));
      lo = Math.min(lo, p[i + 1]); hi = Math.max(hi, p[i + 1]);
    }
    check('every decal vertex sits on the height field', off < 1e-4, `worst ${off.toExponential(1)} m`);
    check('  so a 8.6 m disc on a 13% slope is not flat', hi - lo > 1.5, `${(hi - lo).toFixed(2)} m of relief`);
    vfx.clear();
  }
  check('the decal pool hands its meshes back', vfx.decals.live.length === 0
    && vfx.decals.free.length === 10, `${vfx.decals.live.length} live, ${vfx.decals.free.length} free`);
  check('an unknown shape draws nothing rather than something wrong',
    vfx.telegraph({ kind: 'trapezoid', hit: 3 }, 0, 0, 0, 0xffffff, 1, slope) === null);
}

/* ============================================================================
   10. who gets paid for a corpse
   ========================================================================== */

// `Enemy.takeDamage` has always written `threat: Map<playerId, damage>` for its own aggro,
// and that map is also the only honest receipt for "I fought this". Until now the payment
// hook fired for the last hit alone, so a teammate who spent a minute of a boss's health
// bar got no xp, no drops and no progress on 「讨伐 ×3」 — co-op combat paid one player.
//
// Driven in-process because the two cases that matter are ones a live socket cannot
// construct on demand: a helper who walks away before the kill, and a bystander who never
// swung. `tools/mp-check.mjs` drives the end-to-end half through the real gateway.
console.log('\n=== 10. kill credit: the damage ledger is the receipt');
{
  const twoPlayers = () => {
    const paid = [];
    const inst = new ZoneInstance('mondstadt', 98, {
      broadcast: () => {},
      onKill: (i, player, enemy, loot, opts = {}) => {
        paid.push({ id: player.playerId, assist: !!opts.assist, loot });
      },
    });
    inst.camps.length = 0;
    const stats = {};
    for (const id of ['lyra']) {
      stats[id] = buildCharacterStats({
        charId: id, level: LEVEL, ascension: 4, talents: { normal: 1, skill: 1, burst: 1 },
        weapon: makeWeapon('travelersBlade', LEVEL, 1), artifacts: {}, dupes: 0,
      });
      stats[id].critRate = 0;
    }
    const add = (pid) => inst.addPlayer(pid, `p${pid}`, {
      playerId: pid, party: ['lyra'], activeSlot: 0, zone: 'mondstadt',
      pos: { x: 0, y: BASE_Y, z: 0, ry: 0 },
    }, stats);
    const a = add(1), b = add(2);
    inst.stop();
    inst.enemies.clear();
    inst.now = 100;
    inst.events.length = 0;
    return { inst, a, b, paid };
  };

  // Both swing, B lands the last hit. The hp is set so that the first hit cannot finish it,
  // which is what makes "A damaged it and B killed it" a real two-contributor corpse rather
  // than an accident of the damage roll.
  {
    const { inst, a, b, paid } = twoPlayers();
    const e = target(inst, 'hilichurl');
    e.maxHp = 1e12; e.hp = 1e12;
    inst.playerHitEnemy(a, e, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: 'lyra' });
    const aShare = e.threat.get(1) || 0;
    check('a helper\'s damage is on the enemy\'s own ledger', aShare > 0, `threat[A] = ${Math.round(aShare)}`);
    e.hp = 1;
    inst.playerHitEnemy(b, e, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: 'lyra' });
    check('the corpse pays both of them', paid.length === 2,
      paid.map((p) => `${p.id}${p.assist ? '(assist)' : ''}`).join(' + ') || 'nobody');
    check('...the last hit as a kill, the other as an assist',
      paid.find((p) => p.id === 2)?.assist === false && paid.find((p) => p.id === 1)?.assist === true,
      JSON.stringify(paid.map((p) => [p.id, p.assist])));
    // Every claimant is paid off their own roll, so a helper never eats the host's drop.
    // `paid.length === 2` is re-tested rather than assumed: with the credit rule mutated back
    // to last-hit-only there is no second entry, and an unguarded `paid[1].loot` turns a red
    // assertion into a stack trace that skips the four cases below it.
    check('and each claimant gets their own loot roll, not a share of one',
      paid.length === 2 && paid.every((p) => p.loot && typeof p.loot.xp === 'number' && p.loot.xp > 0)
      && paid[0].loot !== paid[1].loot,
      paid.map((p) => `${p.id}:${p.loot?.xp}xp/${p.loot?.mora}mora`).join(' '));
  }

  // The radius is the second condition, and it is the one that keeps 「站在山脊上看别人打」
  // from being an income. Same fight, except A walks away before the kill lands.
  {
    const { inst, a, b, paid } = twoPlayers();
    const e = target(inst, 'hilichurl');
    e.maxHp = 1e12; e.hp = 1e12;
    inst.playerHitEnemy(a, e, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: 'lyra' });
    a.x = ASSIST_RADIUS + 5; a.z = 0;
    e.hp = 1;
    inst.playerHitEnemy(b, e, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: 'lyra' });
    check('a helper who left before the kill is not paid',
      paid.length === 1 && paid[0].id === 2 && paid[0].assist === false,
      `${(a.x).toFixed(0)} m away → ${JSON.stringify(paid.map((p) => p.id))}`);
    // Both sides of the same boundary, or the assertion above is equally true of a rule that
    // pays nobody: step back inside and the payment has to come back.
    const { inst: i2, a: a2, b: b2, paid: p2 } = twoPlayers();
    const e2 = target(i2, 'hilichurl');
    e2.maxHp = 1e12; e2.hp = 1e12;
    i2.playerHitEnemy(a2, e2, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: 'lyra' });
    a2.x = ASSIST_RADIUS - 5; a2.z = 0;
    e2.hp = 1;
    i2.playerHitEnemy(b2, e2, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: 'lyra' });
    check('...and one who stayed inside it is', p2.length === 2 && p2.some((p) => p.id === 1 && p.assist),
      `${(a2.x).toFixed(0)} m away → ${JSON.stringify(p2.map((p) => [p.id, p.assist]))}`);
  }

  // A leech: present, in range, never swung. Threat-based credit is what refuses this, and
  // it is the reason the rule is not "everyone in the party".
  {
    const { inst, b, paid } = twoPlayers();
    const e = target(inst, 'hilichurl');
    e.hp = 1;
    inst.playerHitEnemy(b, e, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: 'lyra' });
    check('standing next to a fight you never joined pays nothing',
      paid.length === 1 && paid[0].id === 2, JSON.stringify(paid.map((p) => p.id)));
  }

  // An unowned kill — a lingering field left behind, a hazard — used to pay nobody at all,
  // because `applyDamageToEnemy` passes `byPlayer = null`. The ledger still knows who fought it.
  {
    const { inst, a, paid } = twoPlayers();
    const e = target(inst, 'hilichurl');
    e.maxHp = 1e12; e.hp = 1e12;
    inst.playerHitEnemy(a, e, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: 'lyra' });
    e.hp = 1;
    inst.applyDamageToEnemy(e, 500, 'pyro', 0, null, 'field');
    check('a kill nobody landed still pays whoever fought it',
      paid.length === 1 && paid[0].id === 1 && paid[0].assist === true,
      JSON.stringify(paid.map((p) => [p.id, p.assist])));
  }

  // 击败 procs are the one thing an assist must *not* get: "击败敌人后攻击力提升" is a
  // statement about the last hit.
  {
    const { inst, a, b } = twoPlayers();
    const e = target(inst, 'hilichurl');
    e.maxHp = 1e12; e.hp = 1e12;
    inst.playerHitEnemy(a, e, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: 'lyra' });
    e.hp = 1;
    const kills = { a: a.kills, b: b.kills };
    inst.playerHitEnemy(b, e, { scaling: 1, element: 'physical', gauge: 0, kind: 'normal', charId: 'lyra' });
    check('an assist is not a kill on the killer\'s counter',
      b.kills === kills.b + 1 && a.kills === kills.a,
      `A ${kills.a}→${a.kills}, B ${kills.b}→${b.kills}`);
  }
}

/* ============================================================================
   11. the element it claims is the element it lands — on a player
   ========================================================================== */
// The gate above can prove that `mv.element || def.element` resolves to the creature's own
// element for every move it can choose. It cannot prove that the hit *arrives* that way, and
// that is where this lived for the whole project: `ATTACK_MOVES.basic` carried
// `element: 'physical'`, so 水史莱姆, 炎史莱姆, 火斧丘丘人 and 霜狼 — every melee/charger
// elemental creature — swung physically and attached nothing, with `gauge: 1` authored on all
// four. 湿身 was unreachable in the open world, and with it the whole player-side half of the
// reaction table: 感电, 冻结, 超导 on your own party could not happen.
//
// So this section runs the AI: put a player in reach, drive `updateEnemy` until the sim emits
// its DAMAGE, and read the payload and the player's `AuraState`.
console.log('\n=== 11. what an elemental creature lands on a player');
{
  /** A stopped instance with one player who cannot die, at the origin. */
  const victim = () => {
    const inst = new ZoneInstance('mondstadt', 97, { broadcast: () => {} });
    inst.camps.length = 0;
    const st = buildCharacterStats({
      charId: 'lyra', level: LEVEL, ascension: 4, talents: { normal: 1, skill: 1, burst: 1 },
      weapon: makeWeapon('travelersBlade', LEVEL, 1), artifacts: {}, dupes: 0,
    });
    st.critRate = 0;
    st.hp = 1e9;                                     // survives every case, so hp is a *reading*
    const p = inst.addPlayer(1, 'p1', {
      playerId: 1, party: ['lyra'], activeSlot: 0, zone: 'mondstadt',
      pos: { x: 0, y: BASE_Y, z: 0, ry: 0 },
    }, { lyra: st });
    p.x = 0; p.y = BASE_Y; p.z = 0;
    p.hp = p.maxHp();
    inst.stop();
    inst.enemies.clear();
    inst.now = 100;
    inst.events.length = 0;
    return { inst, p };
  };

  /**
   * Let `defId` attack the player once, through the state machine, and hand back the payload.
   *
   * Nothing here writes an element or calls `damagePlayer`: the enemy is spawned inside its own
   * attack range, `updateEnemy` walks idle → chase → windup → active → `resolveEnemyAttack`, and
   * projectiles are flown by `updateProjectiles` — which is how a 雷史莱姆 (`AI.ranged`, an orb)
   * and a 水史莱姆 (`AI.melee`, a bump) can be asked the same question.
   */
  const swing = (inst, p, defId, budget = 400) => {
    const e = inst.spawnEnemy(defId, LEVEL, 0, 0);
    e.maxHp = 1e12; e.hp = 1e12;
    // Just inside the range the AI wants to attack from, on +Z, and standing on the player's
    // own ground: `resolveEnemyAttack` tests a horizontal distance, but a projectile has to
    // actually reach a body.
    const d = Math.min(e.def.attackRange * 0.7, 6);
    e.x = 0; e.y = p.y; e.z = d; e.ry = Math.PI;
    e.state = 'idle'; e.attackCd = 0; e.stunned = 0;
    inst.events.length = 0;
    for (let i = 0; i < budget; i++) {
      inst.now += DT;
      inst.updateEnemy(e, DT);
      inst.updateProjectiles(DT);
      const ev = inst.events.find((x) => x.t === S2C.DAMAGE && x.d?.target === 'player')?.d;
      if (ev) return { e, ev, ticks: i };
    }
    return { e, ev: null, ticks: budget };
  };

  // What *should* be left behind is not "the element", and the answer is not written out here:
  // 风 and 岩 are the two carriers with no aura of their own (`AuraState.apply` returns before
  // it writes one — swirl spreads an aura that is already there, crystallize hands out a
  // shield), so a 岩龙蜥 that leaves an earth aura would be the older bug this rule replaced.
  // Ask the aura table itself what each element does, then require the running sim to agree.
  const lingers = (el) => { const a = new AuraState(); a.apply(el, 1, 0); return a.dominant() === el; };
  check('the aura table answers that question both ways', lingers('water') && !lingers('wind'),
    ELEMENT_IDS.map((el) => `${el}:${lingers(el) ? 'lingers' : 'carries'}`).join(' '));

  // Every creature that claims an element and a gauge, asked at runtime. The list is derived,
  // so a thirteenth enemy is covered the day it is authored.
  const elemental = Object.values(ENEMIES)
    .filter((d) => d.gauge > 0 && d.element && d.element !== 'physical');
  check('there are elemental creatures to ask, of both kinds',
    elemental.filter((d) => lingers(d.element)).length >= 4
    && elemental.some((d) => !lingers(d.element)),
    elemental.map((d) => `${d.name}(${d.element})`).join(' '));
  for (const def of elemental) {
    const { inst, p } = victim();
    const { ev } = swing(inst, p, def.id);
    const want = lingers(def.element) ? def.element : null;
    check(`${def.name} hits with ${def.element}, and ${want ? 'it sticks' : 'nothing lingers'}`,
      !!ev && ev.element === def.element && (p.aura.dominant() || null) === want,
      ev ? `payload element ${ev.element}, aura ${p.aura.dominant() || 'none'}, ${ev.amount} dmg`
        : 'no DAMAGE payload for the player at all');
  }
  // The other direction, on the same path: a physical creature must attach nothing, or the
  // assertions above are equally true of a build that attaches the element of every hit.
  {
    const { inst, p } = victim();
    const { ev } = swing(inst, p, 'hilichurl');
    check('...while 丘丘人 (physical, gauge 0) attaches nothing',
      !!ev && ev.element === 'physical' && p.aura.dominant() === null,
      ev ? `payload element ${ev.element}, aura ${p.aura.dominant() || 'none'}` : 'no payload');
  }

  // 感电 on the player, made by two creatures rather than by a test writing an aura: the slime
  // bumps water on, the electro slime shoots lightning into it.
  {
    const { inst, p } = victim();
    swing(inst, p, 'slimeWater');
    const wet = p.aura.dominant();
    const { ev } = swing(inst, p, 'slimeElectro');
    check('two creatures make 感电 on the player, and the wire says so',
      wet === 'water' && ev?.reaction === 'electroCharged',
      `wet: ${wet || 'none'} → ${ev?.element || '?'} hit, reaction ${ev?.reaction || 'null'}`);
    check('...and it leaves the damage-over-time the reaction is made of',
      p.aura.dots.length === 1 && p.aura.dots[0].element === 'lightning',
      JSON.stringify(p.aura.dots.map((d) => ({ el: d.element, frac: d.frac }))));

    // The tick itself. `updatePlayer` is the only consumer, and until this run there was none:
    // the dots list was filled by the reaction and read by nobody, so 感电 on a player was a
    // popup and one number.
    const hp0 = p.hp;
    inst.events.length = 0;
    for (let i = 0; i < 25; i++) { inst.now += DT; inst.updatePlayer(p, DT); }
    const dotEv = inst.events.filter((x) => x.t === S2C.DAMAGE && x.d?.kind === 'dot');
    check('...which ticks the player once a second, as lightning', dotEv.length === 1
      && dotEv[0].d.element === 'lightning' && hp0 - p.hp > 0,
      `${dotEv.length} tick(s) in 1.25 s, ${Math.round(hp0 - p.hp)} hp of ${Math.round(p.maxHp())}`);
    // And it is bounded: `electroCharged.dot` is 4 s, so the same loop run long enough has to
    // stop paying. Without this, "it ticks" is equally true of a dot that never expires.
    const hp1 = p.hp;
    for (let i = 0; i < 120; i++) { inst.now += DT; inst.updatePlayer(p, DT); }
    const spent = Math.round(hp1 - p.hp);
    const held = p.hp;
    for (let i = 0; i < 60; i++) { inst.now += DT; inst.updatePlayer(p, DT); }
    check('...and stops when the reaction is over, not for ever',
      p.aura.dots.length === 0 && spent > 0 && p.hp === held,
      `${spent} hp over the remaining window, then ${Math.round(held - p.hp)} hp in the 3 s after`);
  }

  /**
   * The second application, which is the one a camp actually delivers.
   *
   * Everything above fires the reaction **once**, and `dots.length === 1` is equally true of a
   * build that refreshes the dot and one that pushes a parallel one per application — the tick
   * loop pays every entry in the list, so pushing makes the drain
   * `applications-in-the-last-4-s × the authored rate`. The camp player-aura-check walks into is
   * two 雷史莱姆 (attackCd 2.6) and one 水史莱姆 (2.0); alternating them holds a mean of 4 dots
   * and drained 6.09 %/s instead of 2.10 %/s, killing a full-health Lv.30 party in 17.7 s and
   * taking that probe's fixture down before it could photograph anything.
   *
   * Both directions, because "one dot" alone is also true of a build that ignores the second
   * application altogether — and that would end the reaction early instead of late.
   */
  {
    const { inst, p } = victim();
    const el = ENEMIES.slimeElectro.element;
    // Alternate the camp's own two elements at the camp's own cadence for ten seconds.
    const cds = [ENEMIES.slimeWater.attackCd, ENEMIES.slimeElectro.attackCd];
    let next = [0, 0.6], hits = 0;
    const hp0 = p.hp;
    inst.events.length = 0;
    for (let i = 0; i < Math.round(10 / DT); i++) {
      inst.now += DT;
      for (const k of [0, 1]) {
        if (inst.now < next[k]) continue;
        next[k] += cds[k];
        hits++;
        p.aura.apply(k ? el : ENEMIES.slimeWater.element, ENEMIES.slimeWater.gauge, inst.now);
      }
      inst.updatePlayer(p, DT);
    }
    const ticks = inst.events.filter((x) => x.t === S2C.DAMAGE && x.d?.kind === 'dot').length;
    const rate = (hp0 - p.hp) / p.maxHp() / 10 * 100;
    // Derived from one application rather than written down twice: `frac` is the reaction's own
    // number, and 0.35 is `updatePlayer`'s tick factor (a literal there, not exported).
    const one = new AuraState();
    one.apply(ENEMIES.slimeWater.element, 1, 0);
    one.apply(el, 1, 0);
    const authored = (one.dots[0]?.frac || 0) * 0.35 * 100;
    check('a camp that re-applies 感电 drains at the authored rate, not once per application',
      p.aura.dots.length <= 1 && ticks <= 11 && rate < authored * 1.35,
      `${hits} hits in 10 s → ${ticks} tick(s), ${p.aura.dots.length} dot(s) live,`
      + ` ${rate.toFixed(2)} %/s of max hp against ${authored.toFixed(2)} %/s authored`);
    // ...and the re-application is not simply dropped: the window has to reach past where the
    // first one alone would have ended.
    const solo = victim();
    solo.p.aura.apply('water', 1, 0);
    solo.p.aura.apply(el, 1, 0);
    const firstUntil = solo.p.aura.dots[0]?.until;
    solo.p.aura.apply('water', 1, 3.0);
    solo.p.aura.apply(el, 1, 3.0);
    const after = solo.p.aura.dots[0]?.until;
    solo.p.aura.update(0.1, 5.0);
    const aliveAt5 = solo.p.aura.dots.length;
    solo.p.aura.update(0.1, 7.1);
    check('...and re-applying it extends the window rather than being ignored',
      after > firstUntil && aliveAt5 === 1 && solo.p.aura.dots.length === 0,
      `until ${firstUntil} → ${after} after a hit at 3.0 s; ${aliveAt5} live at 5 s`
      + ` (past the first window), ${solo.p.aura.dots.length} at 7.1 s`);
  }

  // 超导 on the player: the same shred `playerHitEnemy` has always read on the way out.
  // Measured as a pair, because a lone number cannot tell 减防 from a damage roll.
  {
    const plain = victim();
    const { ev: evPlain } = swing(plain.inst, plain.p, 'hilichurl');
    const shredded = victim();
    // Ice first (a 霜狼's bump), then lightning (a 雷史莱姆's orb) — two creatures again.
    swing(shredded.inst, shredded.p, 'frostWolf');
    const iced = shredded.p.aura.dominant();
    const { ev: evReact } = swing(shredded.inst, shredded.p, 'slimeElectro');
    const shred = shredded.p.aura.defShred;
    check('a 冰 bump and a 雷 orb make 超导 on the player', iced === 'ice'
      && evReact?.reaction === 'superconduct' && shred > 0,
      `iced: ${iced || 'none'}, reaction ${evReact?.reaction || 'null'}, defShred ${shred}`);
    const { ev: evShred } = swing(shredded.inst, shredded.p, 'hilichurl');
    check('...and 减防 makes the next physical hit land harder', !!evPlain && !!evShred
      && evShred.amount > evPlain.amount * 1.05,
      `${evPlain?.amount} → ${evShred?.amount} dmg off the same 丘丘人 at ${shred} shred`);
  }
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails);
