// Does an enemy's wind-up tell you where the blow will land?
//
//   node tools/telegraph-check.mjs --no-browser        # wiring, from source
//   DISPLAY=:99 node tools/telegraph-check.mjs         # ...plus the shape, measured in metres
//
// `ATTACK_MOVES` authors the geometry of every attack in the game: radii from 2.2 m to 8.0 m, a
// 137° `arc` for the tail sweep, dashes at 14-26 m/s and projectile ranges out to 26 m. The
// simulation reads all of it. The client drew, for all seventeen moves, one ring of
// `max(1.6, hitbox.r * 2.4)` — a number belonging to the *creature* — so a 2.4 m jab and a 6 m
// spike field were the same picture, and `emit('telegraph', …)` next to it had no listener
// anywhere. Learning a boss's moves meant dying to each of them once.
//
// Now `shared/src/data/enemies.js#attackShape` is the single description of an attack's ground
// shape, `resolveEnemyAttack` tests against it and `vfx.telegraph` draws it. Which raises the
// question this file exists to answer: **is the shape on screen the shape that hits?**
// `tools/enemy-check.mjs` proves the geometry the client *builds* (it needs no GL context) and
// that the sim damages exactly inside it. Here the frame is photographed, because a mesh can be
// built correctly and still be invisible, upside down, or two metres wide on a 40 m shot.
//
// The measurement: the world is hidden, the camera is put 40 m straight above the shape, and the
// decal's changed pixels are converted back to metres through the camera's own fov. So every
// assertion below reads as "the drawn disc is 8.6 m across, and the damage stops at 8.6 m" —
// the two numbers a player is being promised agree.
//
// Sections 1b and 7 ask the same question of the *player's* own attacks, where the answer was
// worse. `handleAttack` swept `weaponReach + 2.2` metres through 0.85π radians while the client
// drew a slash arc `weaponReach * 0.66` wide in front of the character — about a third of the
// ground that was really being hit. `burst.radius` is authored per character (4 m to 8 m), was
// put on the wire, and the client drew a 7 m ring for all fourteen. And a piercing skill, a 9 m
// line, was drawn as a disc at the caster's feet. Same fix, same gate: one
// `playerAttackShape(action, def)`, tested by the sim and drawn by the client.
//
// Exit code is the number of failed assertions.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, diffMask, maskInRect, largestBlob } from './lib/png.mjs';
import { ENEMIES, ATTACK_MOVES, attackShape } from '../shared/src/data/enemies.js';
import { FALLBACK_MOVES } from '../shared/src/data/enemyGate.js';
import { CHARACTERS, playerAttackShape, MELEE_SLACK, MELEE_ARC } from '../shared/src/data/characters.js';

const root = path.resolve(import.meta.dirname, '..');
const noBrowser = process.argv.includes('--no-browser');
const base = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5173';
// `check-all` hands art probes `[base, outDir]` positionally.
const outDir = process.argv.slice(2).find((a) => a.startsWith('/')) || '/tmp/telegraph-cam';

let passes = 0, fails = 0, skips = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passes++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); } else {
    fails++; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`);
  }
  return !!ok;
};
const skip = (name, why) => { skips++; console.log(`  SKIP ${name}  ${why}`); };
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The enemy that actually uses a move, so the def in the fixture is the one players meet. A move
 * no `attacks` list names is still reachable: `entity.js#chooseMove` falls back by `ai`, and
 * `FALLBACK_MOVES` is the table that says which — the same one the enemy gate reads.
 */
const owner = (moveId) => Object.keys(ENEMIES).find((id) => ENEMIES[id].attacks?.includes(moveId))
  || Object.keys(ENEMIES).find((id) => !ENEMIES[id].attacks?.length
    && (FALLBACK_MOVES[ENEMIES[id].ai] || FALLBACK_MOVES['*']) === moveId);

/**
 * Source with comments removed and strings kept. Every negative assertion below needs this: the
 * wind-up branch *describes* the hitbox ring it replaced, so grepping the commented source for
 * `hitbox` fails on the prose that explains why there is none.
 */
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && d === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      while (++i < src.length) {
        out += src[i];
        if (src[i] === '\\') { out += src[++i]; } else if (src[i] === q) break;
      }
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * The body of one method, by balanced braces, with strings and comments skipped. Same scanner as
 * `tools/react-check.mjs`: slicing to the end of the file, or to the next `\n  }`, is how a
 * source gate ends up asserting things about the wrong code.
 */
function methodBody(src, sigRe) {
  const m = src.match(sigRe);
  if (!m) return null;
  // The brace that opens the *block*, i.e. the one at the end of a line. `indexOf('{')` finds the
  // empty arrow body in `fail = () => {}` instead, and every handler in shared/world/actions.js
  // declares one — so this returned a 2-character body and the three assertions below could not
  // fail for the right reason.
  let i = src.slice(m.index).search(/\{[ \t]*\r?\n/);
  if (i < 0) return null;
  i += m.index;
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i = src.indexOf('*/', i); if (i < 0) return null; i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      while (++i < src.length) { if (src[i] === '\\') i++; else if (src[i] === q) break; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/* ------------------------------------------------------------------------------ */
/* 1. wiring: the handler draws the move's shape and shakes on the move's weight   */
/* ------------------------------------------------------------------------------ */

console.log('--- 1. the wind-up handler');
{
  const gameSrc = read('client/src/game/game.js');
  const body = methodBody(gameSrc, /\b_onEnemyAttack\(d\)\s*\{/);
  check('the scan found _onEnemyAttack', !!body && body.includes("'windup'"),
    body ? `${body.length} chars` : 'no method body');
  if (body) {
    // Split at the phase branch: what the wind-up draws, and what the landing does, are
    // different claims and a check that greps the whole method cannot tell them apart.
    const code = stripComments(body);
    const cut = code.indexOf('} else {');
    const windup = code.slice(0, cut < 0 ? code.length : cut);
    const active = cut < 0 ? '' : code.slice(cut);
    check('the two phases are separate branches', cut > 0 && windup.length > 60 && active.length > 60,
      `${windup.length} chars of wind-up, ${active.length} of landing`);
    check('the wind-up draws the move\'s own shape', /attackShape\(/.test(windup)
      && /vfx\.telegraph\(/.test(windup), windup.match(/vfx\.\w+\(/)?.[0] || 'nothing drawn');
    // The defect, as a negative: the old ring took its size from the creature's hitbox.
    check('...and nothing in it is sized off the creature\'s hitbox', !/hitbox/.test(windup));
    // A route with no listener is not a feature. `emit('telegraph', …)` had none anywhere in
    // client/src, so it went, rather than being kept "for later" — the repo's own rule.
    check('the dead telegraph event is gone', !/emit\('telegraph'/.test(gameSrc));
    check('the landing reads the move\'s authored shake', /mv\?\.shake/.test(active)
      && /addShake\(/.test(active), active.match(/addShake\([^)]*\)/)?.[0] || 'no shake');
    check('...and only for someone close enough to be in it', /attackShape\(/.test(active)
      && /Math\.hypot/.test(active));
  }
  // The vocabulary gate lives in enemy-check (kinds against shader modes, both ways); here just
  // pin that the shapes under test are the ones the data really produces.
  const kinds = new Set(Object.keys(ATTACK_MOVES).map((m) => attackShape(ATTACK_MOVES[m], {}).kind));
  check('the data produces all five shapes', kinds.size === 5, [...kinds].join(' '));
}

/** Moves photographed: one per shape kind, plus a radius sweep to prove the size is authored. */
const SHOTS = ['basic', 'slam', 'spikeField', 'cyclone', 'tailSweep', 'chargeRoll',
  'tideLance', 'summonMinions'];
{
  const orphan = SHOTS.filter((m) => !ATTACK_MOVES[m] || !owner(m));
  check('every move under test belongs to a creature', orphan.length === 0,
    orphan.join(' ') || SHOTS.map((m) => `${m}→${owner(m)}`).join(' '));
}

/* ------------------------------------------------------------------------------ */
/* 1b. the other side of the fight: what your own swing covers                     */
/* ------------------------------------------------------------------------------ */

console.log('\n--- 1b. the player\'s own reach');
{
  const actSrc = stripComments(read('shared/src/world/actions.js'));
  const lpSrc = stripComments(read('client/src/game/localPlayer.js'));
  const gmSrc = stripComments(read('client/src/game/game.js'));
  const vfxSrc = stripComments(read('client/src/game/vfx.js'));

  // The expectation is written out again here, from the authored data, rather than asking the
  // expression under test what it thinks: the defect being gated *was* a second copy of these
  // numbers living in the client, so a gate that imports the one source proves nothing about it.
  const REACH = { sword: 2.6, claymore: 3.1, polearm: 3.6 };
  const want = (action, def) => {
    if (action === 'normal' || action === 'charged') {
      const atk = action === 'charged' ? def.charged : def.normal;
      if (atk.projectile || def.weapon === 'bow' || def.weapon === 'catalyst') return 'none';
      const hit = REACH[def.weapon] + 2.2;
      return action === 'charged' && atk.spin
        ? `disc ${hit.toFixed(2)}`
        : `sector ${hit.toFixed(2)} arc ${(Math.PI * 0.85).toFixed(3)}`;
    }
    if (action === 'skill') {
      const sk = def.skill;
      if (sk.pierce) return `lane ${((sk.radius || 4) * 0.6).toFixed(2)} long ${sk.pierce}`;
      if (sk.projectile) return sk.lingering?.radius ? `disc ${sk.lingering.radius.toFixed(2)}` : 'none';
      return `disc ${(sk.radius || 4).toFixed(2)}`;
    }
    return def.burst.radius ? `disc ${def.burst.radius.toFixed(2)}` : 'none';
  };
  const say = (sh) => (sh
    ? `${sh.kind} ${sh.hit.toFixed(2)}${sh.arc ? ` arc ${sh.arc.toFixed(3)}` : ''}`
      + `${sh.length ? ` long ${sh.length}` : ''}`
    : 'none');

  for (const action of ['normal', 'charged', 'skill', 'burst']) {
    const rows = Object.entries(CHARACTERS).map(([id, def]) =>
      [id, say(playerAttackShape(action, def)), want(action, def)]);
    const bad = rows.filter(([, got, exp]) => got !== exp);
    const drawn = rows.filter(([, got]) => got !== 'none');
    check(`every character's ${action} covers the ground the sim tests`,
      bad.length === 0 && rows.length === Object.keys(CHARACTERS).length && drawn.length > 0,
      bad.length ? bad.map(([id, got, exp]) => `${id}: ${got} ≠ ${exp}`).join('; ')
        : `${drawn.length}/${rows.length} leave a mark, e.g. ${drawn[0][0]} ${drawn[0][1]}`);
  }
  check(`the melee slack and arc are the sim's own (${MELEE_SLACK} m, ${MELEE_ARC.toFixed(3)} rad)`,
    MELEE_SLACK === 2.2 && Math.abs(MELEE_ARC - Math.PI * 0.85) < 1e-12
    && playerAttackShape('normal', CHARACTERS.volt).hit === REACH.polearm + MELEE_SLACK,
    `polearm reaches ${playerAttackShape('normal', CHARACTERS.volt).hit.toFixed(2)} m`);
  // Both directions on the empty shape: a skill that is only orbs leaves no boundary at all (the
  // orbs are their own picture), while one that drops a field draws the field's authored radius —
  // not the 3 m the client used to invent for either of them.
  check('a skill that is only projectiles draws no boundary',
    playerAttackShape('skill', CHARACTERS.sylvi) === null
    && playerAttackShape('skill', CHARACTERS.kaelen)?.hit === CHARACTERS.kaelen.skill.lingering.radius,
    `sylvi ${say(playerAttackShape('skill', CHARACTERS.sylvi))},`
    + ` kaelen ${say(playerAttackShape('skill', CHARACTERS.kaelen))}`);
  check('every burst has a radius to draw',
    Object.values(CHARACTERS).every((def) => playerAttackShape('burst', def)?.hit > 0),
    Object.entries(CHARACTERS).filter(([, d]) => !d.burst.radius).map(([id]) => id).join(' ')
    || `all ${Object.keys(CHARACTERS).length}`);

  // The sim's three handlers each test against the published shape rather than a private number.
  for (const fn of ['handleAttack', 'handleSkill', 'handleBurst']) {
    const body = methodBody(actSrc, new RegExp(`function ${fn}\\(`));
    check(`${fn} tests the published shape`, !!body && /playerAttackShape\(/.test(body),
      body ? `${body.length} chars` : 'no function body');
  }
  // The old copies, as negatives. The weapon reach was written out both in `WEAPON_TYPES` and as a
  // ternary in the sweep; the arc was a literal; and the client was sent a `radius` which it then
  // defaulted differently from the server that sent it (`|| 3` against `|| 4`).
  check('the weapon reach and the arc are not written out a second time',
    !/claymore'\s*\?\s*3\.1/.test(actSrc) && !/Math\.PI \* 0\.85/.test(actSrc),
    actSrc.match(/claymore'\s*\?\s*3\.1[^;]*/)?.[0] || actSrc.match(/Math\.PI \* 0\.85/)?.[0]
    || 'one source');
  check('the cast broadcast no longer carries a radius the client has to guess',
    !/radius:\s*(skill|burst)\.radius/.test(actSrc) && !/d\.radius/.test(gmSrc),
    (actSrc.match(/radius:\s*\w+\.radius[^,]*/) || gmSrc.match(/d\.radius[^,)]*/)
      || ['derived from charId'])[0]);

  // The client draws that shape, on both paths that can produce one.
  check('the local player draws its own shape', /playerAttackShape\(/.test(lpSrc)
    && /vfx\.strike\(/.test(lpSrc), lpSrc.match(/vfx\.strike\([^;]*/)?.[0]?.slice(0, 64) || 'nothing');
  check('...and so does an ally\'s cast arriving on the wire',
    /playerAttackShape\(/.test(gmSrc) && /vfx\.strike\(/.test(gmSrc));
  check('the auto-attack closes to the reach the sim tests, not a private constant',
    !/AUTO_ATTACK_SLACK/.test(gmSrc) && /attackReach/.test(gmSrc) && /get attackReach/.test(lpSrc),
    gmSrc.match(/reach = [^;]*/)?.[0] || 'no reach');
  // One geometry builder with two animations: a second copy of the vertex lift is how a
  // telegraph and a strike drift apart.
  const decal = methodBody(vfxSrc, /\n  _decal\(/);
  check('the telegraph and the strike are one mesh builder',
    !!decal && /needsUpdate/.test(decal)
    && (vfxSrc.match(/DECAL_SEG;\s*j\+\+/g) || []).length === 1
    && /_decal\(/.test(methodBody(vfxSrc, /\btelegraph\(shape/) || '')
    && /_decal\(/.test(methodBody(vfxSrc, /\bstrike\(shape/) || ''),
    decal ? `${decal.length} chars` : 'no _decal');
  // A ground decal is lit by the world's hour, and both ends of that have to exist: a uniform no
  // one writes is dead GLSL, and an `applyDaylight` the game never calls is a dead method. Section
  // 8 photographs what it does; this is what says the wire is there at all.
  const dayFactor = vfxSrc.match(/this\.dayLight = ([\d.]+) \+ ([\d.]+) \* day/);
  check('the decal is lit by the world\'s own daylight',
    /uniform float [^;]*uLight/.test(vfxSrc)
    && /uni\.uLight\.value = this\.dayLight/.test(decal || '')
    // ...and it reaches the decals already on the ground, not only the next one drawn.
    && /uLight/.test(methodBody(vfxSrc, /\n  applyDaylight\(/) || '')
    && /vfx\?\.applyDaylight\(ph\)/.test(gmSrc),
    dayFactor ? dayFactor[0] : 'no factor');
  // Noon has to come out at exactly 1, or every calibrated pixel gate in tools/ is now measuring
  // a slightly different picture than the one its thresholds were set on.
  check('...and noon is exactly the frame the probes were calibrated on',
    !!dayFactor && Number(dayFactor[1]) + Number(dayFactor[2]) === 1,
    dayFactor ? `${dayFactor[1]} + ${dayFactor[2]} = ${Number(dayFactor[1]) + Number(dayFactor[2])}`
      : 'no factor');
}

/* ------------------------------------------------------------------------------ */
/* 2. the picture, in metres                                                       */
/* ------------------------------------------------------------------------------ */

if (noBrowser) {
  console.log(`\n${passes} passed, ${fails} failed, ${skips} skipped  (no browser)`);
  process.exit(fails);
}

const CAM_H = 40;          // metres straight up; ~41 m of vertical view at fov 55
const LIFE = 1.0;          // s: one second of wind-up, so a step count is a fill fraction
const ID = -77;            // the fixture enemy's id, well clear of any real one
const E_TOL = 60;          // extent: only the outline, so a bloom halo cannot pad the box
const A_TOL = 14;          // area: the dim interior wash counts too

/**
 * What the drawn shape should measure, as a box in metres: `[width along x, depth along z]`.
 * Every term comes from the authored move except `edge`, the outline's half-width, read back off
 * the material — the outline straddles the boundary, so it reaches `edge` past it.
 */
const extentOf = (sh, edge) => {
  const R = sh.hit + edge;
  const span = sh.length ? sh.length / 2 : 0;
  if (sh.kind === 'ring') {
    const outer = sh.hit + 0.9 + edge;          // RING_BAND, the width of the body that arrives
    return [outer * 2, outer * 2];
  }
  if (sh.kind === 'sector') {
    // A pie slice with its apex on the creature: it reaches R forward and nothing backward, and
    // its widest point is on the arc's own edge, not at 90°.
    const half = Math.min(Math.PI / 2, sh.arc / 2 + edge / sh.hit);
    return [2 * R * Math.sin(half), R];
  }
  return [R * 2, (R + span) * 2];               // disc, and the capsule of a lane or aim line
};

fs.mkdirSync(outDir, { recursive: true });
const puppeteer = (await import('puppeteer')).default;
const browser = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
    'media.autoplay.default': 0,
  },
  defaultViewport: { width: 1280, height: 800 },
});
const p = await browser.newPage();
p.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  await p.click('[data-act="guest"]');
  let up = false;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    up = await p.evaluate(() => !!window.game?._running);
    if (up) break;
  }
  if (!check('the world came up', up)) throw new Error('never booted');
  await sleep(2500);

  // Pin the tier before hiding anything: `_applyQuality` rebuilds resident chunks, so pinning
  // afterwards puts terrain back into a frame that is supposed to be black.
  const tier = await p.evaluate(() => {
    const g = window.game;
    g.setAutoQuality(false);
    g.setQuality('high');
    return { quality: g.quality, vfx: g.vfx.quality };
  });
  await sleep(3000);
  check('the quality tier is pinned high, not llvmpipe\'s low',
    tier.quality === 'high' && tier.vfx === 1.0, JSON.stringify(tier));

  const setup = await p.evaluate(() => {
    const g = window.game;
    // Noon, like every pixel probe here — `daylight-check` scans for this call. The decal is an
    // unlit additive surface on a black clear colour, so the sun cannot reach the frame; the pin
    // costs one line and keeps that gate one-sided in the cheap direction.
    const noon = g.setWorldTime(12);
    g.stop();
    for (const sel of ['[data-hud]', '#world-overlay']) {
      const el = document.querySelector(sel);
      if (el) el.style.display = 'none';
    }
    // `meshPools()` rather than a hard-coded list, so a pool added to Vfx later cannot be hidden
    // by this probe and then photographed as absent.
    const own = new Set([g.vfx.sparks.points]);
    for (const pool of g.vfx.meshPools()) {
      for (const o of pool.free) own.add(o);
      for (const e of pool.live) own.add(e.o);
    }
    let hidden = 0;
    // Kept, not just counted: section 8 photographs a decal *on* the world, so it needs to undo
    // exactly this and nothing else — un-hiding everything would show whatever the product was
    // hiding for its own reasons.
    window.__tgHidden = [];
    for (const c of g.scene.children) {
      if (own.has(c) || c.isLight || c.isCamera) continue;
      if (c.visible) { c.visible = false; hidden++; window.__tgHidden.push(c); }
    }
    window.__tgFog = g.scene.fog;
    g.scene.fog = null;
    g.r.renderer.setClearColor(0x000000, 1);

    // The flattest patch in reach, because relief *is* the measurement error here: the decal
    // follows the height field (that is the point of the tessellation), and from 40 m up a vertex
    // 2 m closer to the lens projects 5% wider. The flat spot is only a best effort — nothing is
    // assumed about it, since every shot below measures the ground under its own footprint and
    // widens its own tolerance by what it finds.
    // Scored over the ground every shape below will cover, not a tidy square around the spot: the
    // widest footprint is a 22 m lane that starts at the creature and runs *forward*, so a box
    // centred on the creature is the wrong question and picked a spot with 7 m of relief under
    // the lane. x ±9, z -9 to +26, in metres, facing +z.
    let best = null;
    for (let a = 0; a < 32; a++) {
      for (const rad of [12, 20, 28, 36, 44, 52]) {
        const x = g.me.x + Math.cos((a / 32) * Math.PI * 2) * rad;
        const z = g.me.z + Math.sin((a / 32) * Math.PI * 2) * rad;
        let lo = 1e9, hi = -1e9;
        for (let i = -3; i <= 3; i++) {
          for (let j = -3; j <= 8; j++) {
            const y = g.world.heightAt(x + i * 3, z + j * 3.2);
            lo = Math.min(lo, y); hi = Math.max(hi, y);
          }
        }
        if (!best || hi - lo < best.relief) best = { x, z, y: g.world.heightAt(x, z), relief: hi - lo };
      }
    }
    const cv = g.r.renderer.domElement;
    return {
      hidden, pools: own.size, quality: g.quality, noon,
      clock: `${g.clock.label} pinned=${g.clock.pinned}`,
      spot: [+best.x.toFixed(2), +best.y.toFixed(2), +best.z.toFixed(2)],
      relief: +best.relief.toFixed(2),
      fov: g.camera.fov, w: cv.clientWidth, h: cv.clientHeight, dpr: window.devicePixelRatio,
    };
  });
  console.log(`  (hid ${setup.hidden} children, ${setup.pools} vfx objects kept, quality`
    + ` ${setup.quality}, clock ${setup.clock}, spot ${setup.spot} relief ${setup.relief} m,`
    + ` fov ${setup.fov} on ${setup.w}x${setup.h} dpr ${setup.dpr})`);
  check('the world was hidden and the effect layer was not', setup.hidden > 0 && setup.pools > 50,
    `${setup.hidden} hidden, ${setup.pools} kept`);
  // Asserted, not just called: `setWorldTime` returns false for an hour it cannot parse, and a
  // probe that only calls it photographs whatever hour the boot happened to pick.
  check('the clock is pinned at noon', setup.noon === true && /^12:00/.test(setup.clock), setup.clock);

  /**
   * Fire one wind-up through the real `_onEnemyAttack` and photograph it from straight above.
   *
   * The fixture is the *actor entry* — `_syncEnemies` builds those from a snapshot, and there is
   * no enemy within 40 m of a fresh spawn — carrying the authored def, passed in from Node so the
   * page is not asked to invent one. Everything under test is product code: the wire payload goes
   * into the handler, the handler asks `attackShape` for the geometry and `vfx.telegraph` draws
   * it. `look` is the shape's own centre, because a 22 m lane starts at the creature and a camera
   * aimed at the creature would photograph half of it.
   */
  const shoot = async (tag, { move = null, def = null, fill = 0.55, look = [0, 0], direct = null } = {}) => {
    const info = await p.evaluate(({ move, def, fill, look, direct, ID, CAM_H, LIFE, spot }) => {
      const g = window.game;
      g.vfx.clear();
      for (const pool of g.vfx.meshPools()) pool.free.sort((a, b) => a.id - b.id);
      const [ex, ey, ez] = spot;
      // Straight down. `up` has to leave the view axis or the basis is degenerate: with up = +Z,
      // world +X runs along the frame's width and world +Z down its height.
      g.camera.up.set(0, 0, 1);
      g.camera.position.set(look[0], ey + CAM_H, look[1]);
      g.camera.lookAt(look[0], ey, look[1]);
      g.camera.updateProjectionMatrix();
      if (move) {
        g.actors.enemies.set(ID, {
          actor: { def, height: def.hitbox.h }, defId: def.id,
          x: ex, y: ey, z: ez, ry: 0, alive: true, state: 'windup', attacking: null,
        });
        g._onEnemyAttack({ id: ID, move, phase: 'windup', duration: LIFE, x: ex, y: ey, z: ez, ry: 0 });
      } else if (direct) {
        // Not a product path: a control for the *metric*. If a disc drawn at 1.5× the radius does
        // not measure 1.5× as wide, the pixels are not measuring the radius at all.
        g.vfx.telegraph(direct, ex, ez, 0, 0xff8844, LIFE, (x, z) => g.world.heightAt(x, z));
      }
      const live = g.vfx.decals.live.length;
      const o = g.vfx.decals.live[0]?.o;
      const uni = o?.material.uniforms;
      const got = uni ? {
        mode: uni.uMode.value, uR: uni.uR.value, span: uni.uSpan.value,
        arc: uni.uArc.value, edge: uni.uEdge.value,
      } : {};
      // The ground under this shape, off the 169 vertices the decal put there: how far the
      // surface being photographed departs from the plane the camera's px/m assumes. Read from
      // the mesh rather than resampled, so it is the terrain in the picture.
      if (o) {
        const arr = o.geometry.attributes.position.array;
        let lo = 1e9, hi = -1e9, sum = 0, n = 0;
        for (let i = 1; i < arr.length; i += 3) { lo = Math.min(lo, arr[i]); hi = Math.max(hi, arr[i]); sum += arr[i]; n++; }
        got.relief = +(hi - lo).toFixed(3);
        got.groundOff = +(sum / n - 0.07 - spot[1]).toFixed(3);
      }
      for (let i = 0; i < Math.round(fill * LIFE * 60); i++) g.vfx.update(1 / 60, g.camera);
      for (let i = 0; i < 3; i++) g.r.render(0.016);
      return {
        live, ...got,
        fillNow: +(uni?.uFill.value ?? -1).toFixed(3),
        cam: [g.camera.position.x, g.camera.position.y, g.camera.position.z].map((v) => +v.toFixed(2)),
      };
    }, { move, def, fill, look, direct, ID, CAM_H, LIFE, spot: setup.spot });
    await sleep(400);
    const file = `${outDir}/${tag}.png`;
    await p.screenshot({ path: file });
    return { ...info, img: decodePng(fs.readFileSync(file)), file };
  };

  /** The empty frame this camera sees: the control every shape is measured against. */
  const controls = new Map();
  const controlFor = async (look) => {
    const key = look.map((v) => v.toFixed(2)).join(',');
    if (!controls.has(key)) controls.set(key, await shoot(`control-${controls.size}`, { look }));
    return controls.get(key);
  };

  const home = [setup.spot[0], setup.spot[2]];
  const ctrl0 = await controlFor(home);

  // Pixels per metre on the ground plane, from the camera's own numbers: half the frame covers
  // CAM_H * tan(fov/2) metres. Measured off the screenshot, and only after checking the
  // screenshot is the canvas — a HUD strip or a 2× device ratio would silently rescale metres.
  check('the screenshot is the canvas, one pixel per CSS pixel',
    ctrl0.img.width === setup.w && ctrl0.img.height === setup.h && setup.dpr === 1,
    `${ctrl0.img.width}x${ctrl0.img.height} vs canvas ${setup.w}x${setup.h} dpr ${setup.dpr}`);
  const pxPerM = (ctrl0.img.height / 2) / (CAM_H * Math.tan((setup.fov * Math.PI) / 360));
  console.log(`  (${pxPerM.toFixed(2)} px per metre at ${CAM_H} m)`);

  /** Changed pixels against the empty frame, as a box in metres. */
  const measure = (img, ctrl, tol) => {
    const m = diffMask(img, ctrl.img, tol);
    if (!m.box) return { ...m, mx: 0, mz: 0, edge: true };
    const edge = m.box.x <= 2 || m.box.y <= 2
      || m.box.x + m.box.w >= img.width - 2 || m.box.y + m.box.h >= img.height - 2;
    return { ...m, mx: m.box.w / pxPerM, mz: m.box.h / pxPerM, edge };
  };

  /**
   * How far a rect has travelled from the empty frame, in bytes: the mean over the box of the
   * largest per-channel difference. Unlike a thresholded area this has no cliff in it, which is
   * what a claim about *brightness* rather than extent needs.
   */
  const meanLift = (img, ctrl, box) => {
    let sum = 0, n = 0;
    const x1 = Math.min(img.width - 1, box.x + box.w - 1);
    const y1 = Math.min(img.height - 1, box.y + box.h - 1);
    for (let y = Math.max(0, box.y); y <= y1; y++) {
      for (let x = Math.max(0, box.x); x <= x1; x++) {
        const i = (y * img.width + x) * 4;
        sum += Math.max(
          Math.abs(img.data[i] - ctrl.img.data[i]),
          Math.abs(img.data[i + 1] - ctrl.img.data[i + 1]),
          Math.abs(img.data[i + 2] - ctrl.img.data[i + 2]),
        );
        n++;
      }
    }
    return n ? sum / n : 0;
  };

  /* ---- does the metric read a radius at all? -------------------------------- */
  // First, because every assertion below is this measurement. A disc asked for at 1.5× the radius
  // has to come back 1.5× wider, or these numbers are measuring something else.
  console.log('\n--- 2. the measurement');
  let disc6 = null;
  {
    const R = 4.0;
    const a = await shoot('control-disc-1x', { direct: { kind: 'disc', hit: R }, look: home });
    const b = await shoot('control-disc-1.5x', { direct: { kind: 'disc', hit: R * 1.5 }, look: home });
    const ma = measure(a.img, ctrl0, E_TOL), mb = measure(b.img, ctrl0, E_TOL);
    const want = (R * 1.5 + b.edge) / (R + a.edge);      // the outline's half-width scales too
    const got = mb.mx / Math.max(0.01, ma.mx);
    check('a disc drawn 1.5× wider measures 1.5× wider', Math.abs(got - want) < 0.07,
      `${ma.mx.toFixed(2)} m → ${mb.mx.toFixed(2)} m, ×${got.toFixed(3)} (want ×${want.toFixed(3)})`);
    check('  and the smaller one measures its own radius',
      Math.abs(ma.mx - (R + a.edge) * 2) < 0.5 && Math.abs(ma.mz - ma.mx) < 0.35,
      `${ma.mx.toFixed(2)}×${ma.mz.toFixed(2)} m for hit ${R} + edge ${a.edge}`);
    disc6 = { shot: b, m: measure(b.img, ctrl0, A_TOL) };
  }

  /* ---- every kind, at the radius the damage test uses ----------------------- */
  console.log('\n--- 3. the drawn shape is the shape that hits');
  const seen = [];
  let measured = 0;
  for (const move of SHOTS) {
    const def = ENEMIES[owner(move)];
    const sh = attackShape(ATTACK_MOVES[move], def);
    const span = sh.length ? sh.length / 2 : 0;
    const look = [setup.spot[0], setup.spot[2] + span];        // ry = 0, so forward is +z
    const ctrl = await controlFor(look);
    const shot = await shoot(move, { move, def, look });
    const m = measure(shot.img, ctrl, E_TOL);
    seen.push({ move, sh, m, area: measure(shot.img, ctrl, A_TOL), shot, ctrl, look });

    const [wantX, wantZ] = extentOf(sh, shot.edge ?? 0);
    // The ground's own error budget, as a fraction: a footprint whose surface swings `relief`
    // metres, `groundOff` metres off the plane the camera was aimed at, projects that much wider
    // or narrower. Everything else is 0.3 m of anti-aliasing plus 4% of slack.
    const budget = (Math.abs(shot.groundOff ?? 0) + (shot.relief ?? 0) / 2) / CAM_H;
    const tol = (v) => 0.3 + v * (0.04 + budget);
    const name = `${move} (${sh.kind}) covers ${wantX.toFixed(1)}×${wantZ.toFixed(1)} m of ground`;
    const detail = `measured ${m.mx.toFixed(1)}×${m.mz.toFixed(1)} m, ${m.count} px,`
      + ` ±${(budget * 100).toFixed(1)}% for ${shot.relief} m of relief`
      + `${m.edge ? ' — TOUCHES THE FRAME EDGE' : ''}${shot.live !== 1 ? ` — ${shot.live} decals` : ''}`;
    // Past 8% the terrain under the footprint distorts the projection more than the defect this
    // assertion looks for, so it says so instead of reporting a colour. `enemy-check` proves the
    // same extents with no ground at all, and proves the conformance on a synthetic hillside —
    // this shot is the one that needs level ground, and whether the zone has any is not its call.
    if (budget >= 0.08 && shot.live === 1) skip(name, `${detail} — no ground this flat within 52 m`);
    else {
      measured++;
      check(name, shot.live === 1 && !m.edge
        && Math.abs(m.mx - wantX) < tol(wantX) && Math.abs(m.mz - wantZ) < tol(wantZ), detail);
    }
    check(`  drawn from ${move}'s own numbers`,
      shot.mode !== undefined && shot.uR === sh.hit && shot.span === span && shot.arc === (sh.arc || 0),
      `mode ${shot.mode}, uR ${shot.uR}, span ${shot.span}, arc ${shot.arc}, edge ${shot.edge}`);
  }

  // A section that skipped its way to green proves nothing: the count of shapes actually measured
  // is itself an assertion.
  check('the shapes were measured, not skipped', measured >= SHOTS.length - 2,
    `${measured} of ${SHOTS.length} on measurable ground`);

  /* ---- the shapes are different shapes, not one shape in five sizes ---------- */
  console.log('\n--- 4. five shapes, not one');
  {
    const by = (k) => seen.find((s) => s.move === k);
    const disc = by('slam'), sector = by('tailSweep'), ring = by('summonMinions'), aim = by('tideLance');
    // 137° of a circle is 38% of it, and both are drawn at nearly the same radius (4.8 vs 4.6),
    // so a sector that quietly drew a full disc would be caught by covered area alone.
    const ratio = (sector.area.count / disc.area.count) * ((disc.sh.hit / sector.sh.hit) ** 2);
    check('the sector covers its arc, not the whole circle', ratio > 0.22 && ratio < 0.62,
      `${(ratio * 100).toFixed(0)}% of an equal disc (arc ${ATTACK_MOVES.tailSweep.arc} rad = 38%)`);

    // The summon ring and the 6 m control disc have the same radius, so the only thing the
    // picture can differ by is the hole: the minions land *on* the ring and nobody is warned
    // about the middle. Read in the same rect of the same camera, both directions.
    const rect = {
      x: ctrl0.img.width / 2 - ring.sh.hit * 0.5 * pxPerM,
      y: ctrl0.img.height / 2 - ring.sh.hit * 0.5 * pxPerM,
      w: ring.sh.hit * pxPerM, h: ring.sh.hit * pxPerM,
    };
    const area = (rect.w + 1) * (rect.h + 1);
    const inRing = maskInRect(diffMask(ring.shot.img, ring.ctrl.img, A_TOL), rect) / area;
    const inDisc = maskInRect(diffMask(disc6.shot.img, ctrl0.img, A_TOL), rect) / area;
    check('the summon ring is a band with a hole in it', inRing < 0.06 && inDisc > 0.9,
      `${(inRing * 100).toFixed(1)}% of the middle lit, vs ${(inDisc * 100).toFixed(1)}% for a`
      + ` ${disc6.shot.uR} m disc`);
    check('the aim line is only as wide as the shot is wide', aim.m.mx < 3.0,
      `${aim.m.mx.toFixed(2)} m across for a ${ATTACK_MOVES.tideLance.range} m range`);

    // And the old picture, from both sides: one ring sized off `hitbox.r` could not be both
    // wider than the tyrant's cyclone and narrower than the herald's lance.
    const oldRing = (id) => Math.max(1.6, (ENEMIES[id].hitbox?.r ?? 1) * 2.4) * 2;
    const cyc = by('cyclone');
    check('a cyclone is far wider than the hitbox ring it replaced',
      cyc.m.mx > oldRing(owner('cyclone')) * 1.5,
      `${cyc.m.mx.toFixed(1)} m vs the old ${oldRing(owner('cyclone')).toFixed(1)} m`);
    check('...and a lance is far narrower', aim.m.mx < oldRing(owner('tideLance')) * 0.6,
      `${aim.m.mx.toFixed(1)} m vs the old ${oldRing(owner('tideLance')).toFixed(1)} m`);
  }

  /* ---- the fill converges on the outline at the instant of impact ------------ */
  console.log('\n--- 5. the wind-up is a clock');
  {
    const def = ENEMIES[owner('spikeField')];
    const early = await shoot('spikeField-early', { move: 'spikeField', def, fill: 0.12, look: home });
    const late = await shoot('spikeField-late', { move: 'spikeField', def, fill: 0.98, look: home });
    const me = measure(early.img, ctrl0, E_TOL), ml = measure(late.img, ctrl0, E_TOL);
    check('the outline is the same size all the way through',
      Math.abs(me.mx - ml.mx) < 0.6 && me.count > 200,
      `${me.mx.toFixed(2)} m at fill ${early.fillNow} → ${ml.mx.toFixed(2)} m at ${late.fillNow}`);
    // Brightness, not extent. The interior is a *mix* toward the colour now rather than light
    // added to the scene, and even at fill 0.12 it clears A_TOL, so a thresholded area saturates
    // in both frames (63817 px against 64000) and cannot see the sweep at all. What actually
    // grows is how far the ground inside the ring has travelled from empty: interior alpha runs
    // 0.14 → 0.38 over the wind-up and `uAlpha` ramps with it, so ~4× is the shape of the claim.
    const early_l = meanLift(early.img, ctrl0, ml.box), late_l = meanLift(late.img, ctrl0, ml.box);
    check('...and the fill grows into it', late_l > early_l * 2,
      `mean lift ${early_l.toFixed(1)} → ${late_l.toFixed(1)} bytes inside the ring,`
      + ` ×${(late_l / Math.max(0.01, early_l)).toFixed(2)}`);
  }

  /* ---- the landing shakes the camera, for someone standing in it ------------ */
  console.log('\n--- 6. the blow lands');
  {
    // `mv.shake` was authored on four moves and read by nothing. Two-sided: a heavy blow within
    // its own reach moves the rig, the same blow three radii away does not, and a move that
    // authors no shake never moves it at all.
    const trial = await p.evaluate(({ ID, def, basicDef }) => {
      const g = window.game;
      g.settings.cameraShake = true;
      const at = (dist, move, d = def) => {
        g.actors.enemies.set(ID, {
          actor: { def: d, height: d.hitbox.h }, defId: d.id,
          x: g.me.x, y: g.me.y, z: g.me.z + dist, ry: 0, alive: true, attacking: null,
        });
        g.rig.shake = 0;
        g._onEnemyAttack({ id: ID, move, phase: 'active', duration: 0.7 });
        return +g.rig.shake.toFixed(4);
      };
      return { near: at(1.0, 'divebomb'), far: at(18, 'divebomb'), none: at(1.0, 'basic', basicDef) };
    }, { ID, def: ENEMIES.stormTyrant, basicDef: ENEMIES[owner('basic')] });
    const want = ATTACK_MOVES.divebomb.shake;
    check(`a divebomb landing on you shakes the camera (${want} authored)`, trial.near > want * 0.5,
      `shake ${trial.near}`);
    check('...the same divebomb 18 m away does not', trial.far === 0, `shake ${trial.far}`);
    check('...and a move that authors no shake never does', trial.none === 0, `shake ${trial.none}`);
  }

  /* ---- and now the attacks you make yourself --------------------------------- */
  console.log('\n--- 7. your own reach, drawn where it is tested');
  {
    /**
     * One player action, through the product's own path, photographed from straight above.
     *
     * A melee swing is drawn only for the player making it, so those go through `me.attack` —
     * the same call the mouse and the keyboard make — with the cooldown and the stamina pinned,
     * because the loop is stopped and nothing is refilling them. A cast is drawn for anybody, so
     * those arrive the way an ally's does: a PLAYER_ACTION payload into `_onPlayerAction`.
     */
    const shootPlayer = async (tag, { char, action, element, look }) => {
      const info = await p.evaluate(({ char, action, element, look, CAM_H, spot }) => {
        const g = window.game;
        g.vfx.clear();
        for (const pool of g.vfx.meshPools()) pool.free.sort((a, b) => a.id - b.id);
        const [ex, ey, ez] = spot;
        g.camera.up.set(0, 0, 1);
        g.camera.position.set(look[0], ey + CAM_H, look[1]);
        g.camera.lookAt(look[0], ey, look[1]);
        g.camera.updateProjectionMatrix();
        if (action === 'normal' || action === 'charged') {
          g.me.setCharacter(char);
          g.me.teleportTo(ex, ey, ez, 0);
          g.me.target = null;          // so `attackDir` is the facing, i.e. +z
          g.me.attackCooldown = 0;
          g.me.rooted = 0;
          g.me.stamina = 240;
          if (action === 'charged') g.me.chargedAttack(g.actors, {});
          else g.me.attack(g.actors);
        } else {
          g._onPlayerAction({
            playerId: -91, action, charId: char, element,
            x: ex, y: ey, z: ez, ry: 0, dir: [0, 0, 1],
          });
        }
        const live = g.vfx.decals.live.length;
        const o = g.vfx.decals.live[0]?.o;
        const uni = o?.material.uniforms;
        const got = uni ? {
          mode: uni.uMode.value, uR: uni.uR.value, span: uni.uSpan.value,
          arc: uni.uArc.value, edge: uni.uEdge.value, fillNow: +uni.uFill.value.toFixed(3),
        } : {};
        if (o) {
          const arr = o.geometry.attributes.position.array;
          let lo = 1e9, hi = -1e9, sum = 0, n = 0;
          for (let i = 1; i < arr.length; i += 3) {
            lo = Math.min(lo, arr[i]); hi = Math.max(hi, arr[i]); sum += arr[i]; n++;
          }
          got.relief = +(hi - lo).toFixed(3);
          got.groundOff = +(sum / n - 0.07 - spot[1]).toFixed(3);
        }
        // Four frames, not a fill fraction: a strike is at its full extent the instant it lands,
        // which is the difference between a promise and a report.
        for (let i = 0; i < 4; i++) g.vfx.update(1 / 60, g.camera);
        for (let i = 0; i < 3; i++) g.r.render(0.016);
        return { live, ...got };
      }, { char, action, element, look, CAM_H, spot: setup.spot });
      await sleep(400);
      const file = `${outDir}/${tag}.png`;
      await p.screenshot({ path: file });
      return { ...info, img: decodePng(fs.readFileSync(file)), file };
    };

    /**
     * Changed pixels of the *shape*, as a box in metres. Same conversion as `measure`, plus a
     * connectivity filter: the swing goes through the real socket, so the server's own copy of
     * the swing can land on a monster near the spawn point — 12 to 52 m from this camera, and
     * possibly in frame. Every shape here is one connected component; a spark blob somewhere
     * else in the picture is not, and would otherwise be counted as extent.
     */
    const measureBlob = (img, ctrl, tol) => {
      const b = largestBlob(diffMask(img, ctrl.img, tol), 0.5);
      if (!b.box) return { ...b, mx: 0, mz: 0, edge: true };
      const edge = b.box.x <= 2 || b.box.y <= 2
        || b.box.x + b.box.w >= img.width - 2 || b.box.y + b.box.h >= img.height - 2;
      return { ...b, mx: b.box.w / pxPerM, mz: b.box.h / pxPerM, edge };
    };

    const PLAYER_SHOTS = [
      { tag: 'player-lyra-charged', char: 'lyra', action: 'charged' },
      { tag: 'player-volt-normal', char: 'volt', action: 'normal' },
      { tag: 'player-volt-pierce', char: 'volt', action: 'skill' },
      { tag: 'player-kaelen-field', char: 'kaelen', action: 'skill' },
      { tag: 'player-aurel-burst', char: 'aurel', action: 'burst' },
      { tag: 'player-nyx-burst', char: 'nyx', action: 'burst' },
      { tag: 'player-elira-skill', char: 'elira', action: 'skill' },
      { tag: 'player-sylvi-skill', char: 'sylvi', action: 'skill' },
    ];
    const shots = new Map();
    let pmeasured = 0, pwanted = 0;
    for (const s of PLAYER_SHOTS) {
      const def = CHARACTERS[s.char];
      const sh = playerAttackShape(s.action, def);
      const span = sh?.length ? sh.length / 2 : 0;
      const look = [setup.spot[0], setup.spot[2] + span];
      const element = (s.action === 'burst' ? def.burst : s.action === 'skill' ? def.skill
        : (s.action === 'charged' ? def.charged : def.normal)).element || def.element;
      const ctrl = await controlFor(look);
      const shot = await shootPlayer(s.tag, { ...s, element, look });
      const m = measureBlob(shot.img, ctrl, E_TOL);
      shots.set(s.tag, { ...s, sh, shot, m, area: measureBlob(shot.img, ctrl, A_TOL), ctrl });
      if (!sh) continue;
      pwanted++;
      const [wantX, wantZ] = extentOf(sh, shot.edge ?? 0);
      const budget = (Math.abs(shot.groundOff ?? 0) + (shot.relief ?? 0) / 2) / CAM_H;
      const tol = (v) => 0.3 + v * (0.04 + budget);
      const name = `${s.char}'s ${s.action} (${sh.kind}) covers`
        + ` ${wantX.toFixed(1)}×${wantZ.toFixed(1)} m of ground`;
      const detail = `measured ${m.mx.toFixed(1)}×${m.mz.toFixed(1)} m, ${m.count} px`
        + `${m.dropped ? ` (${m.dropped} px elsewhere dropped)` : ''},`
        + ` ±${(budget * 100).toFixed(1)}% for ${shot.relief} m of relief`
        + `${m.edge ? ' — TOUCHES THE FRAME EDGE' : ''}${shot.live !== 1 ? ` — ${shot.live} decals` : ''}`;
      if (budget >= 0.08 && shot.live === 1) skip(name, `${detail} — no ground this flat within 52 m`);
      else {
        pmeasured++;
        check(name, shot.live === 1 && !m.edge
          && Math.abs(m.mx - wantX) < tol(wantX) && Math.abs(m.mz - wantZ) < tol(wantZ), detail);
      }
      check('  ...at full extent the instant it lands',
        shot.uR === sh.hit && shot.fillNow === 1 && shot.arc === (sh.arc || 0)
        && shot.span === span,
        `uR ${shot.uR}, fill ${shot.fillNow}, arc ${shot.arc}, span ${shot.span}`);
    }
    check('the player shapes were measured, not skipped', pmeasured >= pwanted - 2,
      `${pmeasured} of ${pwanted} on measurable ground`);

    // Two bursts, two sizes — and the 7 m ring the client drew for all fourteen characters lies
    // between them, so it cannot have been right for either.
    const nyx = shots.get('player-nyx-burst'), aurel = shots.get('player-aurel-burst');
    const OLD_BURST = 7.0 * 2;
    check('a 4 m burst and an 8 m burst are not the same picture',
      aurel.m.mx / Math.max(0.01, nyx.m.mx) > 1.7,
      `${nyx.m.mx.toFixed(1)} m vs ${aurel.m.mx.toFixed(1)} m across`);
    check('...and the one ring that used to stand for both is wrong for both',
      nyx.m.mx < OLD_BURST * 0.85 && aurel.m.mx > OLD_BURST * 1.05,
      `${nyx.m.mx.toFixed(1)} m and ${aurel.m.mx.toFixed(1)} m against the old ${OLD_BURST.toFixed(1)} m`);

    // A piercing skill is a line down the field, not a disc at your feet.
    const lance = shots.get('player-volt-pierce');
    check('a piercing skill draws the lane it hits along',
      lance.m.mz / Math.max(0.01, lance.m.mx) > 2.4 && lance.m.mx < 5.0,
      `${lance.m.mx.toFixed(1)} m wide and ${lance.m.mz.toFixed(1)} m long, against the`
      + ` ${(CHARACTERS.volt.skill.radius * 2).toFixed(1)} m disc it used to draw`);

    // A swing is a wedge in front of you; a sword's charged attack is the whole circle, because
    // `charged.spin` is what makes the sim sweep 2π.
    const swing = shots.get('player-volt-normal'), spin = shots.get('player-lyra-charged');
    const wedge = (swing.area.count / spin.area.count) * ((spin.sh.hit / swing.sh.hit) ** 2);
    check('a swing covers its arc and a spin covers the circle', wedge > 0.28 && wedge < 0.68,
      `${(wedge * 100).toFixed(0)}% of an equal disc (0.85π of a circle is 43%)`);

    // Both directions on "no shape, no boundary": same weapon class, same cast flourish, and the
    // only thing that differs in the two frames is the decal one of them owns.
    const sylvi = shots.get('player-sylvi-skill'), elira = shots.get('player-elira-skill');
    check('a projectile-only skill draws no ring it does not own',
      sylvi.shot.live === 0 && elira.shot.live === 1
      && sylvi.area.count < elira.area.count * 0.6,
      `sylvi ${sylvi.shot.live} decals / ${sylvi.area.count} px lit,`
      + ` elira ${elira.shot.live} / ${elira.area.count} px`);
  }

  /* ---- and it has to lie on the ground rather than replace it ---------------- */
  console.log('\n--- 8. a decal is paint on the ground, at any hour');
  {
    /**
     * Every section above shoots the effect layer alone against black, which is what makes the
     * geometry measurable — and is exactly why the blend mode went unnoticed. The decal was
     * `AdditiveBlending`, so with bloom and the ACES curve behind it a 13.9 m spike field at
     * 23:00 photographed as a neutral 244,244,244 plate over half the frame: the grass under it
     * disappeared, and `legible-check` went red because the HUD was then drawing dark text on
     * white (a 1.44:1 name plate against a 3:1 bar). The shape was right and the picture was
     * ruined, which no assertion in this file could see.
     *
     * So: put the world back, draw the same disc at noon and at 23:00, and bound the interior
     * from both sides. A mix toward the colour can never leave the segment between the ground and
     * the colour; light added to the scene has no ceiling at all.
     */
    await p.evaluate(() => {
      for (const c of window.__tgHidden) c.visible = true;
      window.game.scene.fog = window.__tgFog;
    });
    const W = ctrl0.img.width, H = ctrl0.img.height;
    const cx = W / 2, cy = H / 2;
    const lum = (img, i) => 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
    /** Mean sRGB bytes over the pixels whose distance from the frame centre is in [r0, r1). */
    const band = (img, r0, r1) => {
      let r = 0, g = 0, b = 0, l = 0, n = 0;
      const y0 = Math.max(0, Math.floor(cy - r1)), y1 = Math.min(H - 1, Math.ceil(cy + r1));
      const x0 = Math.max(0, Math.floor(cx - r1)), x1 = Math.min(W - 1, Math.ceil(cx + r1));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d < r0 || d >= r1) continue;
          const i = (y * W + x) * 4;
          r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; l += lum(img, i); n++;
        }
      }
      return n ? { r: r / n, g: g / n, b: b / n, lum: l / n, n } : { r: 0, g: 0, b: 0, lum: 0, n: 0 };
    };
    const hour = async (h, tag) => {
      const pinned = await p.evaluate((h) => window.game.setWorldTime(h), h);
      const label = await p.evaluate(() => window.game.clock.label);
      const ctrl = await shoot(`world-${tag}-ctrl`, { look: home });
      const lit = await shoot(`world-${tag}-decal`, {
        move: 'spikeField', def: ENEMIES[owner('spikeField')], fill: 0.98, look: home,
      });
      const R = lit.uR * pxPerM;
      return {
        h, pinned, label, R,
        // A square wholly inside the disc would do, but a band is the honest partition: the
        // interior is the wash, the rim is the outline, and the outside is the control's own
        // ground in the same frame.
        inside: band(lit.img, 0, R * 0.6), rim: band(lit.img, R * 0.9, R * 1.02),
        ground: band(ctrl.img, 0, R * 0.6), far: band(lit.img, R * 1.3, R * 1.6),
        ctrlFar: band(ctrl.img, R * 1.3, R * 1.6),
      };
    };
    const noonShot = await hour(12, 'noon');
    const night = await hour(23, 'night');
    console.log(`  (noon ground ${noonShot.ground.lum.toFixed(1)} → inside`
      + ` ${noonShot.inside.lum.toFixed(1)}; night ground ${night.ground.lum.toFixed(1)} → inside`
      + ` ${night.inside.lum.toFixed(1)}; rims ${noonShot.rim.lum.toFixed(1)} /`
      + ` ${night.rim.lum.toFixed(1)}; R ${night.R.toFixed(0)} px)`);

    // The control that must move, in the units the assertions below are written in. Without it,
    // every "not too bright at night" row is green on a frame that is really noon.
    const dark = night.pinned === true && /^23:/.test(night.label)
      && night.ctrlFar.lum < noonShot.ctrlFar.lum * 0.8;
    check('the two hours photograph as two hours', dark,
      `${noonShot.label} ground ${noonShot.ctrlFar.lum.toFixed(1)} vs ${night.label}`
      + ` ${night.ctrlFar.lum.toFixed(1)} outside the disc`);
    if (!dark) skip('a decal at night does not out-shine daylight', 'the night frame is not dark');
    else {
      // The number the additive blend produced was 244 against noon grass at ~140: brighter at
      // midnight than the same ground in full sun.
      check('a decal at night does not out-shine daylight ground',
        night.inside.lum < noonShot.ctrlFar.lum,
        `${night.inside.lum.toFixed(1)} inside at ${night.label} vs`
        + ` ${noonShot.ctrlFar.lum.toFixed(1)} of sunlit ground`);
      // Both halves of "paint": it is visible, and it is not opaque. `ground` is the same pixels
      // in the control frame, so this is one region measured twice.
      for (const st of [noonShot, night]) {
        const lift = Math.abs(st.inside.lum - st.ground.lum);
        check(`  at ${st.label} the ground under it still shows through`,
          lift > 4 && st.inside.lum < st.ground.lum + 90,
          `ground ${st.ground.lum.toFixed(1)} → ${st.inside.lum.toFixed(1)} (Δ ${lift.toFixed(1)})`);
      }
      // A white-out has no hue and no ring left in it. Two independent fingerprints of the
      // defect: the plate was neutral, and its outline had clipped to the same value as its fill.
      const spread = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
      check('...and it keeps the element colour it was drawn in',
        spread(night.inside) > 6 && spread(night.inside) > night.inside.lum * 0.05,
        `rgb ${night.inside.r.toFixed(0)},${night.inside.g.toFixed(0)},`
        + `${night.inside.b.toFixed(0)} — spread ${spread(night.inside).toFixed(1)}`);
      check('...and the outline is still the brightest part of it',
        night.rim.lum > night.inside.lum * 1.2 && noonShot.rim.lum > noonShot.inside.lum * 1.05,
        `night ${night.rim.lum.toFixed(1)} vs ${night.inside.lum.toFixed(1)},`
        + ` noon ${noonShot.rim.lum.toFixed(1)} vs ${noonShot.inside.lum.toFixed(1)}`);
    }
  }

  console.log(`\n  frames in ${outDir}`);
} catch (err) {
  check('the probe ran to completion', false, err.message);
} finally {
  await browser.close();
}

console.log(`\n${passes} passed, ${fails} failed${skips ? `, ${skips} skipped` : ''}`);
process.exit(fails);
