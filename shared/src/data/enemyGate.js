// The consumer gate for enemy data.
//
// `data/enemies.js` is the second-largest authored file in the project and the one whose keys
// are read from the most directions: the AI state machine in `world/entity.js`, the damage and
// spawn code in `world/zoneInstance.js`, the loot roll in `sim/loot.js`, and the procedural
// model recipes in `client/src/gfx/enemies.js`. `data/zoneGate.js` already showed what happens
// to a file in that position — and this one had both failure modes at once:
//
//   1. **A key with no consumer.** `ruinGuard.weakspot = { offset, r, mult: 3.0 }` described a
//      triple-damage weak point for months. Nothing multiplied by it. The only mention of it
//      outside this table was a *comment* in the model builder, next to a glowing sphere that
//      had been placed on the back of the neck by hand while the data pointed at the chest —
//      so the number, the geometry and the comment disagreed three ways and no test could
//      fail. `frostWolf.pack = 3` was the same shape: every camp in `zones.js` already lists
//      its wolves one by one, so the pack size was a rule that looked enforced.
//   2. **A name with no definition.** An enemy whose `attacks` list a move that is not in
//      `ATTACK_MOVES` gets `undefined` back from `chooseMove` and then throws — or worse,
//      silently stands still — but only once that enemy is spawned, on that floor, by that
//      camp. Same for a `model.kind` no builder implements.
//
// So: `ENEMY_KEYS` and `MOVE_KEYS` declare every key with the function that reads it, and
// `enemyGateReport()` checks both directions. It also closes the loop across the layer
// boundary the way `zoneGateReport` does with prop builders — pass the client's `ENEMY_KINDS`
// and the report compares the authored `weakspot` against the point the *geometry* puts it at,
// so the next time someone moves the eye the data is corrected by a failing test rather than
// by a player wondering why aiming at the head does nothing.

import { ENEMIES, ATTACK_MOVES, AI } from './enemies.js';
import { ELEMENTS, shieldBreakMul } from './elements.js';
import { CHARACTERS } from './characters.js';
import { MATERIALS } from './items.js';
import { ZONES, chamberEnemies } from './zones.js';

/**
 * Every key an entry in `ENEMIES` may carry, mapped to the note naming its consumer.
 *
 * Written here rather than at the use site for the same reason as the zone gate: one file
 * answers "what can an enemy say?", and every value in it is a name to grep for.
 */
export const ENEMY_KEYS = {
  id: 'the table key, echoed — shared/src/sim/loot.js keys drops by it',
  name: 'client/src/ui/hud.js nameplate',
  element: 'shared/src/world/zoneInstance.js#resolveEnemyAttack — the element its attacks apply',
  ai: 'shared/src/world/zoneInstance.js#updateEnemy state machine',
  tier: 'shared/src/sim/loot.js — drop rarity weighting',
  base: 'shared/src/sim/formulas.js#enemyStatAtLevel — hp/atk/def at level 1',
  res: 'shared/src/world/entity.js#resistance',
  speed: 'shared/src/world/zoneInstance.js#updateEnemy — chase speed',
  aggro: 'shared/src/world/entity.js#pickTarget',
  attackRange: 'shared/src/world/zoneInstance.js#updateEnemy — when it commits to a move',
  attackCd: 'shared/src/world/zoneInstance.js#updateEnemy — gap between moves',
  gauge: 'shared/src/world/zoneInstance.js#damagePlayer — elemental application on its hits',
  model: 'client/src/gfx/enemies.js#buildEnemy',
  xp: 'server/src/services/progression.js — party xp on kill',
  loot: 'shared/src/sim/loot.js#rollEnemyLoot',
  hitbox: 'shared/src/world/zoneInstance.js — projectile and melee overlap; also normalises the model',
  projectileSpeed: 'shared/src/world/zoneInstance.js#resolveEnemyAttack — speed of the shots it fires',
  shield: 'shared/src/world/entity.js#takeDamage — absorbs before hp, breaking stuns;'
    + ' shield.element decides the rate via shared/src/data/elements.js#shieldBreakMul and colours'
    + ' the nameplate bar in client/src/game/overlay.js',
  weakspot: 'shared/src/world/entity.js#weakspotSweep'
    + ' + shared/src/world/zoneInstance.js#playerHitEnemy',
  elite: 'shared/src/sim/loot.js (drop bump) and client/src/gfx/enemies.js (aura)',
  boss: 'shared/src/world/entity.js#takeDamage (phases) and client/src/ui/hud.js (boss bar)',
  phases: 'shared/src/world/entity.js#takeDamage — hp fraction thresholds that stagger it',
  flying: 'shared/src/world/entity.js — hover instead of walking',
  attacks: 'shared/src/world/entity.js#chooseMove',
};

/**
 * Every key an `ATTACK_MOVES` entry may carry.
 *
 * Each note names the file that reads the key, and `tools/enemy-check.mjs` now *opens that file
 * and looks for the key* — because three of these notes were wrong. `arc` pointed at
 * `client/src/gfx/animator.js`, which has never mentioned it (the real reader is the facing test
 * in `resolveEnemyAttack`); `shake` claimed a camera shake in `_onEnemyAttack` that was never
 * written, so slam 0.6, chargeRoll 0.5 and divebomb 1.0 were four authored numbers reaching
 * nothing; and `range` claimed to decide how far a move could be started from, which is
 * `def.attackRange`'s job. A note is a claim about the code, and an unchecked claim rots exactly
 * like the data this gate was built to protect.
 */
export const MOVE_KEYS = {
  windup: 'shared/src/world/zoneInstance.js — telegraph before the hit lands',
  active: 'shared/src/world/zoneInstance.js — the window that deals damage',
  recover: 'shared/src/world/zoneInstance.js — the punish window after it',
  mult: 'shared/src/world/zoneInstance.js#resolveEnemyAttack — × the enemy atk',
  radius: 'shared/src/data/enemies.js#attackShape — melee/AoE reach, drawn and tested from there',
  element: 'shared/src/world/zoneInstance.js#damagePlayer',
  range: 'shared/src/data/enemies.js#attackShape — how far the shot flies (life = range / speed)',
  projectile: 'shared/src/world/zoneInstance.js — spawns a Projectile instead of hitting directly',
  projectileSpeed: 'shared/src/world/zoneInstance.js — overrides the enemy default for this move',
  ticks: 'shared/src/world/zoneInstance.js — repeats within the active window',
  dash: 'shared/src/data/enemies.js#attackShape — the lane it sweeps, driven by zoneInstance#applyDash',
  arc: 'shared/src/data/enemies.js#attackShape — the sector it strikes, tested in resolveEnemyAttack',
  pull: 'shared/src/world/zoneInstance.js#applyPull — drags the target in',
  root: 'shared/src/world/zoneInstance.js — holds the target in place',
  selfShield: 'shared/src/world/zoneInstance.js — refreshes its own shield',
  summon: 'shared/src/world/zoneInstance.js — spawns minions',
  shake: 'client/src/game/game.js#_onEnemyAttack — camera shake when the blow lands near you',
};

/**
 * Moves an enemy never lists but the AI can still pick: `chooseMove` falls back to one of
 * these when `attacks` is absent, keyed by `ai`. They are consumers in their own right, so the
 * "no enemy references this move" check has to know about them or it reports three false
 * positives — and if one is ever renamed, the mismatch shows up here instead of as an enemy
 * that stands still.
 */
export const FALLBACK_MOVES = {
  [AI.ranged]: 'basicRanged',
  [AI.caster]: 'basicCast',
  '*': 'basic',
};

/**
 * Report every problem in the enemy catalogue. Empty array means clean.
 *
 * Pass the client's model registry to close the geometry loop:
 *   `enemyGateReport({ kinds: ENEMY_KINDS, build: buildEnemy })`
 * Without them those checks are skipped rather than faked (`skipped` counts them), because a
 * server-side caller has no geometry — and a gate that silently passes on missing input is the
 * failure mode this file exists to prevent.
 */
export function enemyGateReport({ kinds = null, build = null, enemies = ENEMIES, zones = ZONES } = {}) {
  const problems = [];
  const skipped = [];
  const movesSeen = new Set(Object.values(FALLBACK_MOVES));
  const kindsSeen = new Set();

  /* ---- what the world actually spawns ------------------------------------- */
  // An enemy nobody meets is not content, and the two ways to meet one are a camp and a
  // chamber wave. This is the check that would have caught a mistyped id in `zones.js` from
  // the enemy side rather than only when that zone loaded.
  const placed = new Map();
  for (const z of Object.values(zones)) {
    for (const s of z.spawns || []) for (const id of s.enemies || []) {
      placed.set(id, (placed.get(id) || []).concat(`${z.id} camp`));
    }
    for (const c of z.chambers || []) for (const id of chamberEnemies(c)) {
      placed.set(id, (placed.get(id) || []).concat(`${z.id} floor ${c.floor}`));
    }
  }

  for (const [id, def] of Object.entries(enemies)) {
    const at = (s) => `${id}: ${s}`;
    if (def.id !== id) problems.push(at(`id field says "${def.id}"`));

    for (const key of Object.keys(def)) {
      if (!ENEMY_KEYS[key]) problems.push(at(`"${key}" is not a key any consumer reads`));
    }

    /* ---- numbers that have to exist for the AI to run --------------------- */
    if (!Object.values(AI).includes(def.ai)) problems.push(at(`ai "${def.ai}" is not an AI mode`));
    if (!(def.base?.hp > 0 && def.base?.atk > 0 && def.base?.def >= 0)) problems.push(at('base hp/atk/def missing'));
    if (!(def.speed > 0)) problems.push(at('speed must be > 0 or it can never reach anyone'));
    if (!(def.aggro > 0)) problems.push(at('aggro must be > 0 or it never picks a target'));
    if (!(def.attackRange > 0)) problems.push(at('attackRange must be > 0'));
    if (!(def.attackCd > 0)) problems.push(at('attackCd must be > 0 or it attacks every tick'));
    if (!(def.xp > 0)) problems.push(at('xp must be > 0'));
    if (!(def.hitbox?.r > 0 && def.hitbox?.h > 0)) problems.push(at('hitbox needs r and h'));
    if (!(def.tier >= 1)) problems.push(at('tier must be >= 1'));
    if (def.element && !ELEMENTS[def.element]) problems.push(at(`element "${def.element}" is unknown`));
    for (const el of Object.keys(def.res || {})) {
      if (!ELEMENTS[el] && el !== 'physical') problems.push(at(`res has unknown element "${el}"`));
    }

    /* ---- ranged attackers need something to fire ------------------------- */
    // `resolveEnemyAttack` resolves a projectile's speed as
    // `mv.projectileSpeed || e.def.projectileSpeed || 18`, so this key is needed exactly when
    // the move about to be fired has no speed of its own — and the generic 18 at the end of
    // that chain is a floor for a crash, not a tuning value: reaching it means nobody chose
    // how fast this enemy's shots travel.
    //
    // Which moves those are depends on `attacks`. With a list, `chooseMove` only ever returns
    // moves from it; without one it returns the `AI`-keyed fallback, and both fallbacks are
    // projectiles with no speed of their own.
    const pool = def.attacks?.length ? def.attacks : [FALLBACK_MOVES[def.ai] || FALLBACK_MOVES['*']];
    const wantsSpeed = pool.some((m) => ATTACK_MOVES[m]?.projectile && !ATTACK_MOVES[m]?.projectileSpeed);
    if (wantsSpeed && !(def.projectileSpeed > 0)) {
      problems.push(at('fires projectiles but has no projectileSpeed'));
    }
    if (def.projectileSpeed !== undefined && !wantsSpeed) {
      problems.push(at('has projectileSpeed but nothing it does is a projectile'));
    }

    /* ---- the element it says it is, and the element it lands --------------- */
    // `resolveEnemyAttack` resolves the element it applies as `mv.element || def.element`, and
    // `damagePlayer` only attaches anything when `def.gauge > 0`. Both halves of that pair have
    // to agree with what the creature *claims*, in both directions, because each direction hides
    // a different silent defect:
    //
    //  * a creature with an element and a gauge whose every move overrides the element with a
    //    literal attaches nothing — `ATTACK_MOVES.basic` carried `element: 'physical'` and that
    //    is exactly what happened to four of the twelve (see the comment on `basic`). Every
    //    other reader agreed with the data: the `res` profile, the model glow, the nameplate,
    //    and the client's own telegraph colour (`mv?.element || def.element`);
    //  * a creature whose moves apply a real element with `gauge: 0` looks elemental and reacts
    //    with nothing — the element is then decoration on a physical hit.
    const applies = new Set(pool.map((m) => ATTACK_MOVES[m]?.element || def.element || 'physical'));
    const elemental = [...applies].filter((el) => el !== 'physical');
    if (def.gauge > 0) {
      if (!def.element || def.element === 'physical') {
        problems.push(at('has a gauge but no element of its own, so damagePlayer/aura.apply'
          + ' attaches nothing'));
      } else if (!applies.has(def.element)) {
        problems.push(at(`is a ${def.element} enemy with gauge ${def.gauge}, but the moves it can`
          + ` choose (${pool.join(', ')}) apply ${[...applies].join('/')} —`
          + ' resolveEnemyAttack reads mv.element before def.element'));
      }
    } else if (elemental.length) {
      problems.push(at(`applies ${elemental.join('/')} with gauge 0, so it attaches nothing`
        + ' and can never make a reaction'));
    }

    /* ---- loot ------------------------------------------------------------ */
    for (const [item, chance] of def.loot || []) {
      if (item !== 'mora' && !MATERIALS[item]) problems.push(at(`loot names unknown item "${item}"`));
      if (!(chance > 0 && chance <= 1)) problems.push(at(`loot chance for ${item} is ${chance}`));
    }
    if (!(def.loot || []).length) problems.push(at('drops nothing at all'));

    /* ---- moves ----------------------------------------------------------- */
    for (const m of def.attacks || []) {
      if (!ATTACK_MOVES[m]) problems.push(at(`attacks "${m}", which is not in ATTACK_MOVES`));
      movesSeen.add(m);
    }
    if (def.attacks && def.attacks.length < 2) {
      // `chooseMove` slices the last move off the pool below phase 2, so a one-move list
      // leaves the pool empty for the whole first phase.
      problems.push(at('attacks has one entry; chooseMove needs at least two'));
    }

    /* ---- boss / elite consistency ---------------------------------------- */
    if (def.phases && !def.boss) problems.push(at('has phases but is not a boss, so takeDamage never reads them'));
    if (def.boss && !def.phases) problems.push(at('is a boss with no phases, so it never staggers or escalates'));
    if (def.boss && def.elite) problems.push(at('is both boss and elite; the aura and the loot bump would both apply'));
    if (def.shield && !ELEMENTS[def.shield.element]) problems.push(at('shield has no valid element'));
    if (def.shield && !(def.shield.hp > 0)) problems.push(at('shield has no hp'));
    if (def.shield && ELEMENTS[def.shield.element]) {
      // A shield is a decision only if the roster can answer it. `shieldBreakMul` pays the
      // element that reacts hardest with the shield, so «bring someone else» has to be
      // possible: if the best element any playable character carries is worth ×1.0, the
      // mechanic reads as «this enemy takes longer», which is a stat, not a choice.
      const best = [...new Set(Object.values(CHARACTERS).map((c) => c.element))]
        .map((el) => [el, shieldBreakMul(el, def.shield.element)])
        .sort((a, b) => b[1] - a[1])[0] || [null, 0];
      if (best[1] < 1.5) {
        problems.push(at(`has a ${def.shield.element} shield, but the best element in the roster`
          + ` is ${best[0]} at ×${best[1]} — nothing counters it`));
      }
      // And the other direction: an enemy whose own element is not what its shield is made of
      // would teach the wrong lesson, because the nameplate aura chip and the shield bar would
      // be different colours while the tooltip talks about one enemy.
      if (def.shield.element !== def.element) {
        problems.push(at(`is a ${def.element} enemy with a ${def.shield.element} shield;`
          + ' the nameplate would show two elements for one creature'));
      }
    }

    /* ---- weak point ------------------------------------------------------ */
    const w = def.weakspot;
    if (w) {
      if (!(Array.isArray(w.offset) && w.offset.length === 3 && w.offset.every(Number.isFinite))) {
        problems.push(at('weakspot.offset must be [x, y, z] in metres from the feet'));
      } else if (!(w.offset[1] > 0 && w.offset[1] < def.hitbox.h * 1.1)) {
        // Above the hitbox is unreachable: `updateProjectiles` only tests a projectile
        // against an enemy while it is inside that cylinder, so a weak point above the top
        // can never be claimed no matter how well aimed the shot is.
        problems.push(at(`weakspot sits at y ${w.offset[1]} on a ${def.hitbox.h} m hitbox`));
      }
      if (!(w.r > 0.15)) problems.push(at(`weakspot radius ${w.r} is too small to hit at 20 Hz`));
      if (!(w.mult > 1)) problems.push(at('weakspot has no mult > 1, so hitting it is worth nothing'));
      if (w.stun !== undefined && !(w.stun > 0)) problems.push(at('weakspot.stun must be > 0 when present'));
    }

    /* ---- the model ------------------------------------------------------- */
    if (!def.model?.kind) problems.push(at('has no model.kind'));
    else kindsSeen.add(def.model.kind);
    if (def.model?.scale !== undefined && !(def.model.scale > 0)) problems.push(at('model.scale must be > 0'));

    if (!placed.has(id)) problems.push(at('is spawned by no camp and no chamber, so no player can meet it'));
  }

  /* ---- declarations nothing uses ------------------------------------------ */
  for (const [m, move] of Object.entries(ATTACK_MOVES)) {
    if (!movesSeen.has(m)) problems.push(`ATTACK_MOVES.${m} is listed by no enemy and is not an AI fallback`);
    for (const key of Object.keys(move)) {
      if (!MOVE_KEYS[key]) problems.push(`ATTACK_MOVES.${m}.${key} is not a key any consumer reads`);
    }
    if (!(move.windup >= 0 && move.active > 0 && move.recover >= 0)) {
      problems.push(`ATTACK_MOVES.${m} needs windup/active/recover`);
    }
    // A move has to *do* something, and there are two ways: deal damage, or apply an effect.
    // `summonMinions` is the honest `mult: 0` — it spends its whole active window spawning —
    // so the rule is not "every move has a mult" but "a move with no damage has a reason".
    const EFFECTS = ['summon', 'selfShield', 'root', 'pull'];
    if (!(move.mult >= 0)) problems.push(`ATTACK_MOVES.${m} has no mult`);
    else if (move.mult === 0 && !EFFECTS.some((k) => move[k])) {
      problems.push(`ATTACK_MOVES.${m} deals no damage and applies no effect, so it is a pause`);
    }
    if (move.projectile && !move.range) problems.push(`ATTACK_MOVES.${m} is a projectile with no range`);
    // `resolveEnemyAttack` falls back to `def.attackRange` for a melee radius, so a missing
    // one is a reach silently borrowed from the range at which the move was *started*.
    if (!move.projectile && move.mult > 0 && !move.radius) {
      problems.push(`ATTACK_MOVES.${m} hits directly but has no radius`);
    }
  }
  const declared = new Set(Object.keys(ENEMY_KEYS));
  for (const key of declared) {
    if (!Object.values(enemies).some((d) => d[key] !== undefined)) {
      problems.push(`ENEMY_KEYS.${key} is declared but no enemy carries it`);
    }
  }

  /* ---- the geometry, if the caller brought it ----------------------------- */
  if (kinds && build) {
    for (const kind of Object.keys(kinds)) {
      if (!kindsSeen.has(kind)) problems.push(`ENEMY_KINDS.${kind} is built for nobody: no enemy names it`);
    }
    for (const [id, def] of Object.entries(enemies)) {
      const K = kinds[def.model?.kind];
      if (!K) { problems.push(`${id}: model.kind "${def.model?.kind}" has no builder in ENEMY_KINDS`); continue; }
      // Two-way: geometry that declares a weak point needs the data that makes it hittable,
      // and data that claims one needs the glowing thing the player aims at.
      const hasGeo = typeof K.weakspot === 'function';
      if (hasGeo && !def.weakspot) {
        problems.push(`${id}: its model builds a weak point but the data has no weakspot to hit`);
      }
      if (def.weakspot && !hasGeo) {
        problems.push(`${id}: has a weakspot but its model draws nothing there to aim at`);
      }
      if (!hasGeo || !def.weakspot) continue;
      const built = build(id, { outline: false, aura: false });
      const got = built.weakspot;
      built.dispose?.();
      if (!got) { problems.push(`${id}: buildEnemy exported no weakspot`); continue; }
      const d = Math.hypot(...got.offset.map((v, i) => v - def.weakspot.offset[i]));
      if (d > 0.12) {
        problems.push(`${id}: weakspot.offset ${JSON.stringify(def.weakspot.offset)} is ${d.toFixed(2)} m`
          + ` from where the model puts it (${JSON.stringify(got.offset)})`);
      }
      if (Math.abs(got.r - def.weakspot.r) > 0.15) {
        problems.push(`${id}: weakspot.r ${def.weakspot.r} disagrees with the geometry's ${got.r.toFixed(2)}`);
      }
    }
  } else {
    skipped.push('geometry checks (pass { kinds, build } from the client)');
  }

  return { problems, skipped };
}
