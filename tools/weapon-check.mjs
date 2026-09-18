// Where is the weapon while nobody is fighting?
//
//   DISPLAY=:99 node tools/weapon-check.mjs [--out /tmp/weaponcheck]
//
// `attachWeapon` has authored two transforms per weapon type since the day it was written — one
// in the hand, one on the back or hip — and `setSheathed` had **no caller anywhere in the
// project**. Nothing ever passed `opts.sheathed` either, so the stowed half of that table had
// never been rendered once, and every character in the game walked, swam, climbed, gathered and
// stood in town with the weapon out. Photographed against black at noon that is not a small
// thing: 莉拉's 0.75 m sword hung out of her idle fist and ended **0.010 m below her own soles**
// with 7.7 % of its vertices inside her right thigh; 伊格纳's claymore was 0.066 m under the
// ground and 53.8 % inside him; 凯伦's bow sat exactly on the ground plane with 61.6 % of it
// inside his left leg and torso. The stowed poses were no better for never having been seen —
// 41.0 % of the hip sword was inside 莉拉's torso, and the whole weapon photographed as a single
// gold speck at her waist.
//
// So there are two claims to gate, and they need different kinds of evidence:
//
//   1. **The state machine** (`CharacterActor._driveSheath`) draws the weapon when there is
//      fighting to do and puts it away afterwards. Gated on the *instances*, not the vocabulary:
//      every name in `DRAWN_CLIPS` and `STOW_NOW` is read out of actors.js and driven, each
//      through the door the product uses — an attack is a clip the animator plays, while
//      swimming and climbing arrive as `state.swimming` / `state.climbing` from the sim, which
//      `autoLocomotion` turns into a base clip. A set member with no instance test is a member
//      that can silently stop working, and the countdown is bounded from *both* sides: still
//      drawn a moment after the clip ends, away within a frame of `STOW_DELAY` past it.
//   2. **The transforms** put the weapon somewhere a body could carry it. That is geometry, so it
//      is measured on the rig rather than eyeballed: the lowest weapon vertex against the soles
//      (`clearance`), the weapon vertices inside the body's own limb/torso/head capsules
//      (`pierce`), and the distance from the nearest vertex to the body *surface* (`gap`, which is
//      how a stowed weapon is told from one floating behind its owner). Every type is measured on
//      the two most different bodies that carry it — 1.58 m 娜依达 against 1.68 m 奥蕾尔, 1.72 m
//      忒拉 against 1.86 m 伊格纳 — because a pose tuned on one of those two puts the other's
//      blade through their knee.
//
// Geometry alone would still miss the defect that actually shipped, though: a weapon can be
// perfectly placed and drawn *inside the cape*. So each body is also photographed from behind
// three times — stowed, stowed with the weapon group hidden, and drawn — and the weapon has to
// own a connected patch of the screen in the stowed frame, and drawing it has to move pixels.
// The hidden-weapon frame is the control: a mask of zero pixels is a weapon nobody can see, which
// is the whole point of moving it to the back.
//
// House habits: pin the tier (llvmpipe boots every browser at `low`), pin the hour, stop the loop
// before framing, drive `Sky.update` by hand, and decode the PNGs in-process.
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { decodePng, diffMask, largestBlob, pixelsDiffering } from './lib/png.mjs';
import { INSTALL } from './lib/probe-world.mjs';

const argv = process.argv.slice(2);
const outDir = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : '/tmp/weaponcheck'; })();
const W = 820, H = 820;
fs.mkdirSync(outDir, { recursive: true });
const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}

/* ------------------------------------------------------- what the source says -- */

// Every threshold below is a bar on a measurement; these two constants are the *product's*,
// read out of the source so the probe cannot drift away from the thing it is gating.
const actorsSrc = fs.readFileSync('client/src/game/actors.js', 'utf8');
const weaponsSrc = fs.readFileSync('client/src/gfx/weapons.js', 'utf8');
const animSrc = fs.readFileSync('client/src/gfx/animator.js', 'utf8');

const clipSetNames = (name) => {
  const m = actorsSrc.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  return m ? [...m[1].matchAll(/'([a-zA-Z0-9]+)'/g)].map((x) => x[1]) : [];
};
const DRAWN = clipSetNames('DRAWN_CLIPS');
const STOW_NOW = clipSetNames('STOW_NOW');
const STOW_DELAY = Number(actorsSrc.match(/STOW_DELAY\s*=\s*([\d.]+)/)?.[1]);
const CLIP_NAMES = [...animSrc.matchAll(/^clip\('(\w+)'/gm)].map((m) => m[1]);
const tableTypes = (name) => {
  const m = weaponsSrc.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`));
  return m ? [...m[1].matchAll(/^\s{2}(\w+):\s*\{/gm)].map((x) => x[1]) : [];
};
const BUILDER_TYPES = (weaponsSrc.match(/const BUILDERS = \{([^}]*)\}/)?.[1] ?? '')
  .split(',').map((s) => s.split(':')[0].trim()).filter(Boolean);

console.log('=== the tables and the clip vocabulary');
console.log(`  builders: ${BUILDER_TYPES.join(' ')}`);
console.log(`  DRAWN_CLIPS: ${DRAWN.join(' ')}`);
console.log(`  STOW_NOW: ${STOW_NOW.join(' ')}  STOW_DELAY: ${STOW_DELAY}s`);
check('the scan found the tables and the clips at all',
  BUILDER_TYPES.length >= 5 && CLIP_NAMES.length >= 20 && DRAWN.length >= 8
  && STOW_NOW.length >= 3 && STOW_DELAY > 0,
  `${BUILDER_TYPES.length} builders, ${CLIP_NAMES.length} clips, ${DRAWN.length} drawn,`
  + ` ${STOW_NOW.length} stow-now, delay ${STOW_DELAY}`);
for (const table of ['ATTACH', 'STOW']) {
  const have = tableTypes(table);
  const missing = BUILDER_TYPES.filter((t) => !have.includes(t));
  const extra = have.filter((t) => !BUILDER_TYPES.includes(t));
  check(`every weapon type has a ${table} transform, and no more`,
    have.length > 0 && !missing.length && !extra.length,
    `${have.length} entries${missing.length ? `, missing ${missing.join(' ')}` : ''}`
    + `${extra.length ? `, unknown ${extra.join(' ')}` : ''}`);
}
{
  const unknown = [...DRAWN, ...STOW_NOW].filter((c) => !CLIP_NAMES.includes(c));
  check('every clip the sheath machine names is a clip the animator has',
    unknown.length === 0, unknown.length ? `not clips: ${unknown.join(' ')}` : `${DRAWN.length + STOW_NOW.length} names`);
  // The other direction, derived rather than restated: whatever the animator calls a swing has to
  // be a reason to have the weapon out. A new `attack6` that nobody adds to DRAWN_CLIPS would
  // otherwise be swung with an empty fist.
  const combat = CLIP_NAMES.filter((c) => /^attack\d$/.test(c) || ['charged', 'skill', 'burst'].includes(c));
  const unarmed = combat.filter((c) => !DRAWN.includes(c));
  check('every combat clip draws the weapon', combat.length >= 7 && unarmed.length === 0,
    `${combat.length} combat clips${unarmed.length ? `, not drawn: ${unarmed.join(' ')}` : ''}`);
  const both = DRAWN.filter((c) => STOW_NOW.includes(c));
  check('no clip both draws it and stows it', both.length === 0, both.join(' '));
}

/* ---------------------------------------------------------------- the bodies -- */

// Per type, the two bodies that differ most in height *and* build. `held`/`stow` name the slot
// each transform is supposed to end up in; a slot name that does not resolve on the rig falls
// back to `weaponSlot` inside `attachWeapon`, silently, so the parent is asserted by identity.
const CASES = [
  { type: 'sword', held: 'weaponSlot', chars: ['naida', 'aurel'] },
  { type: 'claymore', held: 'weaponSlot', chars: ['terra', 'ignar'] },
  { type: 'polearm', held: 'weaponSlot', chars: ['pyra', 'gorran'] },
  { type: 'bow', held: 'offhandSlot', chars: ['zephira', 'kaelen'] },
  { type: 'catalyst', held: 'offhandSlot', chars: ['sylvi', 'seris'] },
];

// The bars. Everything here is in metres on the model, and every one of them is a defect that
// shipped: a tip below zero is a weapon in the dirt, pierce is a weapon inside its owner, and a
// stowed weapon 20 cm off the back is a weapon floating behind them.
const MIN_CLEAR_STOW = 0.25;
const MIN_CLEAR_HELD = 0.12;
const MAX_PIERCE_STOW = 0.01;
const MAX_PIERCE_HELD = 0.06;
const MAX_GAP_STOW = 0.06;
const MIN_GAP_STOW = -0.005;
const MAX_GRIP = 0.22;
// Pixel bars, set after measuring both the fix and the defect. The shipped hip sword photographed
// as 111 px (aurel) and 400 px (naida) of gold speck, while every finalist covers 3724-18991 px —
// so a bar of 1000 kills the defect on both bodies and still leaves the smallest finalist 3.7x of
// headroom. 400 was too generous: it let the shorter body through at exactly the bar.
const MIN_MASK = 1000;
const MIN_MOVED = 500;

const tokFile = '/tmp/world-token.txt';
let token = fs.existsSync(tokFile) ? fs.readFileSync(tokFile, 'utf8').trim() : '';
if (!token) {
  const r = await fetch(`${origin}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  token = (await r.json()).token;
  fs.writeFileSync(tokFile, token);
}

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
  },
  defaultViewport: { width: W, height: H },
});
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
p.on('console', (m) => {
  if (m.type() !== 'error') return;
  errs.push(m.text().slice(0, 200));
  console.log('[err]', m.text().slice(0, 250));
});

await p.goto(origin, { waitUntil: 'domcontentloaded' });
await p.evaluate((t) => localStorage.setItem('teyvat.token', t), token);
await p.reload({ waitUntil: 'domcontentloaded' });
await sleep(5000);
if (await p.$('[data-act="resume"]')) await p.click('[data-act="resume"]');
let up = false;
for (let i = 0; i < 90; i++) {
  if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) { up = true; break; }
  await sleep(1000);
}
if (!check('the world came up', up)) { await b.close(); process.exit(1); }
await sleep(4000);
await p.evaluate(INSTALL);
await p.evaluate(() => {
  window.game.setAutoQuality(false);
  window.game.setQuality('high');
  // Noon, pinned: the sun moves 15° a real minute and every pixel count here was calibrated on
  // the authored sky, which is what daylight() returns at 12:00.
  window.game.setWorldTime(12);
});
await sleep(3000);
const tier = await p.evaluate(() => window.game.quality);
console.log('quality pinned ->', tier);
if (!check('the quality tier pinned to high', tier === 'high', tier)) { await b.close(); process.exit(1); }

// Stop the loop and hide the world: a weapon on someone's back is a 20 cm object against a
// hillside, and the only way to count its pixels is to shoot the body alone against black.
await p.evaluate(() => { window.game.stop(); });
await sleep(300);
const iso = await p.evaluate(() => window.__isolate([window.game.me.actor.group]));
check('the world is hidden and the body is not', iso.hidden > 0, `${iso.hidden} scene children hidden`);

// Page-side geometry. No THREE in the page (bare specifiers do not resolve), so world positions
// come out of `matrixWorld.elements` and the capsule tests are written by hand.
const PAGE = `(() => {
  const wp = (o) => { const e = o.matrixWorld.elements; return [e[12], e[13], e[14]]; };
  const verts = (root) => {
    const out = [];
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const pos = o.geometry?.attributes?.position;
      if (!pos || !o.visible) return;
      const e = o.matrixWorld.elements;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        out.push([
          e[0] * x + e[4] * y + e[8] * z + e[12],
          e[1] * x + e[5] * y + e[9] * z + e[13],
          e[2] * x + e[6] * y + e[10] * z + e[14],
        ]);
      }
    });
    return out;
  };
  const segDist = (p, a, b) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-9;
    let t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
  };
  const SLOTS = ['weaponSlot', 'offhandSlot', 'backSlot', 'hipSlot'];
  window.__wscore = () => {
    const a = window.game.me.actor, rig = a.rig, P = rig.P;
    rig.group.updateMatrixWorld(true);
    const V = verts(a.weapon.group);
    const foot = wp(a.group)[1];
    let lo = 1e9;
    for (const v of V) lo = Math.min(lo, v[1]);
    // The body, as capsules around its own bones, at the radii buildHumanoid gave it. Slightly
    // generous on purpose: the skin is a skinned surface a little wider than the bone chain, and
    // a weapon that grazes the silhouette reads as through it.
    const caps = [
      ['thighL', wp(rig.bones.thighL), wp(rig.bones.shinL), P.limbR * 1.15],
      ['shinL', wp(rig.bones.shinL), wp(rig.bones.footL), P.limbR * 1.15],
      ['thighR', wp(rig.bones.thighR), wp(rig.bones.shinR), P.limbR * 1.15],
      ['shinR', wp(rig.bones.shinR), wp(rig.bones.footR), P.limbR * 1.15],
      ['torso', wp(rig.bones.hips), wp(rig.bones.chest), P.waistW * 0.95],
      ['head', wp(rig.bones.head), wp(rig.bones.head), P.headR * 1.05],
    ];
    const inside = {};
    let pierce = 0, gap = 1e9;
    for (const v of V) {
      let hit = false;
      for (const c of caps) {
        const d = segDist(v, c[1], c[2]) - c[3];
        if (d < gap) gap = d;
        if (d < 0 && !hit) { inside[c[0]] = (inside[c[0]] || 0) + 1; pierce++; hit = true; }
      }
    }
    const parent = SLOTS.find((s) => rig[s] === a.weapon.group.parent) || 'other';
    const handBone = parent === 'offhandSlot' ? 'handL' : 'handR';
    const grip = wp(a.weapon.group), hand = wp(rig.bones[handBone]);
    return {
      verts: V.length, parent, hand: handBone, sheathed: !!a.weapon.sheathed,
      type: a.weapon.spec.type, charId: a.charId, height: +a.height.toFixed(2),
      clearance: +(lo - foot).toFixed(3), gap: +gap.toFixed(3),
      pierce, pierceFrac: +(pierce / V.length).toFixed(3), inside,
      gripToHand: +Math.hypot(grip[0] - hand[0], grip[1] - hand[1], grip[2] - hand[2]).toFixed(3),
      drawT: +a._drawT.toFixed(2),
    };
  };
  // One camera, one subject, three yaws: 0 is the face, 180 the back.
  window.__frame = (yawDeg) => {
    const g = window.game, a = g.me.actor, cam = g.camera;
    const h = a.height, base = [g.me.x, g.me.y, g.me.z];
    const tgt = [base[0], base[1] + h * 0.55, base[2]];
    const fov = 45, dist = (h * 0.80) / Math.tan((fov / 2) * Math.PI / 180);
    const yaw = (yawDeg * Math.PI) / 180;
    cam.fov = fov;
    cam.position.set(tgt[0] + Math.sin(yaw) * dist, tgt[1], tgt[2] + Math.cos(yaw) * dist);
    cam.lookAt(tgt[0], tgt[1], tgt[2]);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    g.world.sky.update(0.016, cam, tgt[0], tgt[1], tgt[2]);
    for (let k = 0; k < 3; k++) g.r.render(0.016);
    return true;
  };
  const IDLE = { speed: 0, grounded: true };
  /**
   * Back to standing still, whatever the last case left behind.
   *
   * Both layers have to be cleared, and neither clears itself: an overlay left running is a
   * DRAWN_CLIPS member on the next frame, and a base left on \`swim\` is a STOW_NOW member. The
   * first draft of this probe skipped it and reported 13 reds whose 'before' halves were all
   * wrong — every case was standing on the tail of the one before it.
   */
  const settle = (a) => {
    let guard = 0;
    while (a.animator.busy && guard++ < 80) a.update(0.05, 0, { ...IDLE, auto: false });
    a.animator.play('idle');
    a.update(0.05, 0, { ...IDLE, auto: true });
  };
  /** Stand still with the weapon away: the state a character is in almost all the time. */
  window.__rest = () => {
    const a = window.game.me.actor;
    settle(a);
    a._drawT = 0;
    a.animator.play('idle');
    for (let i = 0; i < 6; i++) a.update(0.05, i * 0.05, { ...IDLE, auto: true });
    return window.__wscore();
  };
  /**
   * Swing once, let the clip finish, and measure the pose that follows it — the weapon is still
   * out (STOW_DELAY has not run down) and the body is back in idle. That is the frame the player
   * spends a fight in, and the frame the shipped transforms put in the ground.
   */
  window.__afterSwing = () => {
    const a = window.game.me.actor;
    settle(a);
    a._drawT = 0;
    a.animator.play('attack1');
    a.update(0.05, 0, { ...IDLE, auto: false });
    const drawnAtOnce = !a.weapon.sheathed;
    let el = 0.05;
    while (a.animator.busy && el < 3) { a.update(0.05, el, { ...IDLE, auto: false }); el += 0.05; }
    for (let i = 0; i < 4; i++) { a.update(0.05, el, { ...IDLE, auto: true }); el += 0.05; }
    return { ...window.__wscore(), drawnAtOnce, overlay: a.animator.overlay, base: a.animator.base,
      elapsed: +el.toFixed(2) };
  };
  window.__hideWeapon = (v) => {
    const g = window.game.me.actor.weapon.group;
    g.visible = !v;
    return g.visible;
  };
  window.__pick = (cid) => {
    const a = window.game.me.actor;
    a.setCharacter(cid);
    a.setPose(window.game.me.x, window.game.me.y, window.game.me.z, 0);
    return { charId: a.charId, type: a.weapon.spec.type };
  };
  /** Does clip \`name\` take the weapon out? Asserted from the stowed side first. */
  window.__drawsOn = (name) => {
    const a = window.game.me.actor;
    settle(a);
    a._drawT = 0;
    a.update(0.05, 0, { ...IDLE, auto: true });
    const before = a.weapon.sheathed;
    a.animator.play(name);
    a.update(0.05, 0.05, { ...IDLE, auto: false });
    return { before, after: a.weapon.sheathed, base: a.animator.base, overlay: a.animator.overlay };
  };
  /**
   * Swing, run the clip out, then hand the animator the state the *sim* sends for this
   * situation — \`swimming: true\`, not \`play('swim')\` — and see the weapon go away in one frame.
   * \`down\` has no state: the death path plays it directly with \`auto: false\`, so the probe does
   * what localPlayer does.
   */
  window.__stowsOn = (name, state) => {
    const a = window.game.me.actor;
    settle(a);
    a._drawT = 0;
    a.animator.play('attack1');
    let el = 0;
    do { a.update(0.05, el, { ...IDLE, auto: !a.animator.busy }); el += 0.05; } while (a.animator.busy && el < 3);
    const drawnFirst = !a.weapon.sheathed;
    if (state) a.update(0.05, el, { ...IDLE, ...state, auto: true });
    else { a.animator.play(name); a.update(0.05, el, { ...IDLE, auto: false }); }
    return { drawnFirst, base: a.animator.base, sheathed: a.weapon.sheathed,
      drawT: +a._drawT.toFixed(3), elapsed: +el.toFixed(2) };
  };
  /** The countdown, both ends: when did the clip end, and when did the weapon go away? */
  window.__stowTimer = (limit) => {
    const a = window.game.me.actor;
    settle(a);
    a._drawT = 0;
    a.animator.play('attack1');
    a.update(0.05, 0, { ...IDLE, auto: false });
    const drawnAtOnce = !a.weapon.sheathed;
    let el = 0.05, clipEnd = null, drawnAtClipEnd = null, flip = null;
    while (el < limit) {
      const busy = a.animator.busy;
      a.update(0.05, el, { ...IDLE, auto: !busy });
      el += 0.05;
      if (busy && !a.animator.busy && clipEnd === null) {
        clipEnd = +el.toFixed(2);
        drawnAtClipEnd = !a.weapon.sheathed;
      }
      if (a.weapon.sheathed) { flip = +el.toFixed(2); break; }
    }
    return { drawnAtOnce, clipEnd, drawnAtClipEnd, flip, elapsed: +el.toFixed(2) };
  };
  /** Switching character mid-fight must not put the incoming weapon away, or draw it in town. */
  window.__switchWith = (cid, drawT) => {
    const a = window.game.me.actor;
    a._drawT = drawT;
    a.setCharacter(cid);
    return { charId: a.charId, sheathed: !!a.weapon.sheathed, drawT: +a._drawT.toFixed(2) };
  };
  return true;
})()`;
await p.evaluate(PAGE);

/** Frame, present, shoot. `g.stop()` means nothing else composites, so the rAF pair is the wait. */
const shoot = async (name, yaw) => {
  await p.evaluate((y) => window.__frame(y), yaw);
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(450);
  const file = `${outDir}/${name}.png`;
  await p.screenshot({ path: file });
  return { file, img: decodePng(fs.readFileSync(file)) };
};

/* --------------------------------------------------------------- the geometry -- */

const rows = [];
for (const c of CASES) {
  console.log(`\n=== ${c.type}`);
  for (const cid of c.chars) {
    const picked = await p.evaluate((id) => window.__pick(id), cid);
    if (picked.type !== c.type) {
      console.log(`  ${cid}: carries ${picked.type}, not ${c.type} — the case list is stale`);
      check(`${cid}: carries a ${c.type}`, false, `got ${picked.type}`);
      continue;
    }

    const rest = await p.evaluate(() => window.__rest());
    const stow = await shoot(`${c.type}-${cid}-stow`, 180);
    await p.evaluate(() => window.__hideWeapon(true));
    const bare = await shoot(`${c.type}-${cid}-stow-nowep`, 180);
    await p.evaluate(() => window.__hideWeapon(false));
    const swung = await p.evaluate(() => window.__afterSwing());
    const held = await shoot(`${c.type}-${cid}-held`, 180);
    if (cid === c.chars[0]) await shoot(`${c.type}-${cid}-held-front`, 0);

    const mask = largestBlob(diffMask(stow.img, bare.img, 8), 0.05);
    const moved = pixelsDiffering(stow.img, held.img, 4);
    console.log(`  ${cid} (${rest.height} m, ${rest.verts} verts)`);
    console.log(`    stowed  parent ${rest.parent.padEnd(11)} clearance ${rest.clearance}`
      + `  pierce ${(rest.pierceFrac * 100).toFixed(1)}% ${JSON.stringify(rest.inside)}`
      + `  gap ${rest.gap}`);
    console.log(`    drawn   parent ${swung.parent.padEnd(11)} clearance ${swung.clearance}`
      + `  pierce ${(swung.pierceFrac * 100).toFixed(1)}% ${JSON.stringify(swung.inside)}`
      + `  grip->${swung.hand} ${swung.gripToHand}  (clip ran out after ${swung.elapsed}s)`);
    console.log(`    screen  weapon ${mask.count} px in ${mask.blobs} blob(s), box`
      + ` ${mask.box ? `${mask.box.w}x${mask.box.h}` : 'none'};  drawing moved ${moved} px`);

    const id = `${c.type}/${cid}`;
    check(`${id}: stowed, it is on the back`,
      rest.parent === 'backSlot' && rest.sheathed,
      `parent ${rest.parent}, sheathed ${rest.sheathed}`);
    check(`${id}: stowed, it clears the ground`, rest.clearance >= MIN_CLEAR_STOW,
      `lowest vertex ${rest.clearance} m above the soles (need ${MIN_CLEAR_STOW})`);
    check(`${id}: stowed, it is not inside the body`,
      rest.pierceFrac <= MAX_PIERCE_STOW && rest.gap >= MIN_GAP_STOW,
      `${(rest.pierceFrac * 100).toFixed(1)}% of ${rest.verts} vertices inside`
      + ` ${JSON.stringify(rest.inside)}, gap ${rest.gap}`);
    check(`${id}: stowed, it touches the back rather than floating`, rest.gap <= MAX_GAP_STOW,
      `nearest vertex ${rest.gap} m from the body surface (need <= ${MAX_GAP_STOW})`);
    check(`${id}: stowed, it reaches the screen`, mask.count >= MIN_MASK,
      `${mask.count} px change when the weapon is hidden (need ${MIN_MASK})`);
    check(`${id}: drawn, it is in the ${c.held === 'offhandSlot' ? 'off' : ''}hand`,
      swung.parent === c.held && !swung.sheathed,
      `parent ${swung.parent} (want ${c.held}), sheathed ${swung.sheathed}`);
    check(`${id}: drawn, it clears the ground`, swung.clearance >= MIN_CLEAR_HELD,
      `lowest vertex ${swung.clearance} m above the soles (need ${MIN_CLEAR_HELD})`);
    check(`${id}: drawn, it is not inside the body`, swung.pierceFrac <= MAX_PIERCE_HELD,
      `${(swung.pierceFrac * 100).toFixed(1)}% of ${swung.verts} vertices inside`
      + ` ${JSON.stringify(swung.inside)}`);
    check(`${id}: drawn, the grip is at the hand`, swung.gripToHand <= MAX_GRIP,
      `grip is ${swung.gripToHand} m from ${swung.hand} (need <= ${MAX_GRIP})`);
    check(`${id}: drawing it changes the picture`, moved >= MIN_MOVED,
      `${moved} px differ between stowed and drawn (need ${MIN_MOVED})`);
    rows.push({ id, height: rest.height, rest, swung, mask: mask.count, moved });
  }
}

/* ---------------------------------------------------- the state machine itself -- */

console.log('\n=== drawing and stowing');
await p.evaluate((id) => window.__pick(id), 'lyra');

// Both directions of the attach-time gate. The weapon is rebuilt on a character switch, and it
// has to come back in whichever holster the *player* is currently using.
const midFight = await p.evaluate(() => window.__switchWith('aurel', 4.5));
check('switching character mid-fight keeps the weapon drawn', midFight.sheathed === false,
  `${midFight.charId} came in sheathed=${midFight.sheathed} at drawT ${midFight.drawT}`);
const inTown = await p.evaluate(() => window.__switchWith('nyx', 0));
check('switching character out of combat keeps it stowed', inTown.sheathed === true,
  `${inTown.charId} came in sheathed=${inTown.sheathed} at drawT ${inTown.drawT}`);

// The countdown, bounded from both sides against the product's own constant.
const timer = await p.evaluate((lim) => window.__stowTimer(lim), STOW_DELAY * 2 + 4);
const held = timer.flip != null && timer.clipEnd != null ? +(timer.flip - timer.clipEnd).toFixed(2) : null;
console.log(`  attack1 ended at ${timer.clipEnd}s, weapon went away at ${timer.flip}s`
  + ` — ${held}s after the clip (STOW_DELAY ${STOW_DELAY}s)`);
check('an attack draws it on the very first frame', timer.drawnAtOnce === true);
check('it is still out when the clip ends', timer.drawnAtClipEnd === true,
  `clip ended at ${timer.clipEnd}s`);
check(`it goes away STOW_DELAY (${STOW_DELAY}s) after the last swing, not before and not never`,
  held != null && held >= STOW_DELAY * 0.95 && held <= STOW_DELAY + 0.2,
  `stayed out ${held}s after the clip (want ${(STOW_DELAY * 0.95).toFixed(2)}-${(STOW_DELAY + 0.2).toFixed(2)})`);

// Every member of both sets, driven. A name with no instance test is a name that can rot.
for (const name of DRAWN) {
  const r = await p.evaluate((n) => window.__drawsOn(n), name);
  check(`'${name}' takes the weapon out`, r.before === true && r.after === false,
    `stowed before: ${r.before}; after: sheathed ${r.after}, base ${r.base}, overlay ${r.overlay}`);
}
const STATE_FOR = {
  swim: { swimming: true },
  climb: { climbing: true },
  glide: { gliding: true, grounded: false },
  sit: { sitting: true },
  // No state drives `down`: the death path plays it directly and passes `auto: false`.
  down: null,
};
{
  const unmapped = STOW_NOW.filter((n) => !(n in STATE_FOR));
  const stale = Object.keys(STATE_FOR).filter((n) => !STOW_NOW.includes(n));
  check('every stow-at-once clip has a way in from the sim, and no more',
    !unmapped.length && !stale.length,
    `${unmapped.length ? `no state for ${unmapped.join(' ')}` : ''}`
    + `${stale.length ? ` stale: ${stale.join(' ')}` : ''}`);
}
for (const name of STOW_NOW) {
  if (!(name in STATE_FOR)) continue;
  const r = await p.evaluate(([n, s]) => window.__stowsOn(n, s), [name, STATE_FOR[name]]);
  check(`'${name}' puts it away at once`,
    r.drawnFirst === true && r.base === name && r.sheathed === true && r.drawT === 0,
    `drawn first: ${r.drawnFirst}; base ${r.base}, sheathed ${r.sheathed}, drawT ${r.drawT}`);
}

/* -------------------------------------------------------------------- summary -- */

console.log('\n  worst-first, stowed clearance / held pierce:');
for (const r of [...rows].sort((a, x) => a.rest.clearance - x.rest.clearance)) {
  console.log(`   ${r.id.padEnd(20)} ${r.height} m  stow ${String(r.rest.clearance).padStart(6)} m`
    + ` gap ${String(r.rest.gap).padStart(6)}  held ${String(r.swung.clearance).padStart(6)} m`
    + ` pierce ${(r.swung.pierceFrac * 100).toFixed(1).padStart(5)}%`
    + `  ${String(r.mask).padStart(5)} px on screen`);
}
console.log(`\nshots -> ${outDir}`);
console.log('errors ->', errs.length ? JSON.stringify([...new Set(errs)].slice(0, 6)) : 'none');
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
// 6 source gates, 2 boot, 1 isolation, 10 per body, 5 on the timer/switch pair, one per clip
// name in each set, plus the state-table gate.
const want = 6 + 2 + 1 + rows.length * 10 + 5 + DRAWN.length + STOW_NOW.length + 1;
if (pass + fail < want) {
  console.log(`only ${pass + fail} assertions ran — expected ${want}`);
  process.exit(1);
}
process.exit(fail ? 1 : 0);
