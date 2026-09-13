// Close-ups of one live enemy, and a pixel answer to "can the player see the weak point?"
//
//   DISPLAY=:99 node tools/enemy-cam.mjs [defId] [zone] [--out /tmp/enemycam]
//
// There is a camera probe for props (`prop-cam`), for villagers (`npc-cam`) and for the vault
// interior (`vault-cam`), and until now none for the models a player looks at most. This one
// exists for a specific claim: the ruin guard's weak point is *one glowing eye*, the
// simulation pays 3× for hitting it (`tools/enemy-check.mjs`), and the whole mechanic is worth
// nothing if that eye does not read as a target on screen. `enemy-check` already proves the
// geometry with a raycast — the eye is the frontmost surface along the aim ray — but a raycast
// cannot answer what survives the cel ramp, the bloom, the fog, the tonemap and the grade.
//
// So: photograph the enemy the server actually spawned (not a fresh `buildEnemy`, which would
// prove nothing about the shipped scene), then measure three rectangles in the head shot — the
// eye, the plating below it, and the chest — and photograph the *same* framing again with the
// glow material turned into plain metal. The eye rect must beat the other two, and it must
// stop beating them when the glow goes out while the plating rect stays put; otherwise the
// measurement is only saying "two rectangles differ", which is true of any model.
//
// Exit code is the number of failed assertions (or 1 if the enemy never showed up).
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { decodePng, rectStats, diffMask, maskInRect, largestBlob, dilateMask, flatPatch } from './lib/png.mjs';
import { ZONES, zoneById, zoneEntryRank } from '../shared/src/data/zones.js';
import { ENEMIES } from '../shared/src/data/enemies.js';
import { raiseRank } from './lib/account.mjs';

// `--out DIR` takes a value, so dropping only the flag leaves the *directory* sitting in the
// positional list: `enemy-cam.mjs ruinGuard --out /tmp/x` read /tmp/x as the zone and died with
// "no camp in /tmp/x spawns 'ruinGuard'", which reads exactly like a missing enemy table.
const argv = process.argv.slice(2);
const args = argv.filter((a, i) => !a.startsWith('--')
  && argv[i - 1] !== '--out' && argv[i - 1] !== '--yaw' && argv[i - 1] !== '--blind');
// `--yaw R` pins which way the subject faces. Not a convenience: the world moves under this sheet.
// The ruin guard wandered 1.6 m and turned 3.3 rad between two runs an hour apart, and at ry −1.8
// its own hillside stood between the camera and its face — so a real occlusion bug walked in and
// out of the suite by itself. A defect that only appears in one state can only be proved fixed by
// constructing that state ([[drive-the-tail-from-a-state]]).
// …and since the world moves under it, the pin is now the *default*, not an option: `--yaw` picks
// a different facing (−2.4 is the one that used to blow the guard's forearm out to white), and
// `--yaw free` hands the model back to its AI for the one case where that is the subject.
const yawIx = argv.indexOf('--yaw');
const yawArg = yawIx >= 0 ? argv[yawIx + 1] : null;
const pinYaw = yawArg === null ? 0 : (yawArg === 'free' ? null : +yawArg);
// `--blind F` is fault injection for the recovery ladder in the framing loop below. That ladder
// exists for a camera standing inside a grass clump, which depends on where a wandering slime
// happens to be — a branch that only runs when the world cooperates is a branch nobody has
// tested. It works by moving the near plane past the subject, i.e. by simulating the *signature*
// of the fault ("the photograph does not contain the model") rather than the fault: everything
// nearer than the subject is thrown away until the camera has climbed F× the stand-off, after
// which the shot comes back normally. So it tests the detector, the ladder and the bookkeeping,
// and the sheet still has to come back green. The ladder climbs in the same units, so
// `--blind 0.2` buries the first two rungs of every shot, close-ups included, and lets the third
// recover. (`--sink`, the first attempt at this, was useless: the terrain is single-sided, so a
// camera 2.2 m *underground* photographed the slime perfectly and no rung ever failed.)
// Armed by the portrait ladder alone. The first version applied to every shot and took the
// isolation sheet down with it (122 px of slime instead of 2228, two FAILs) — an injected fault
// that reaches the assertions it is not testing proves nothing about the branch it is testing.
const blindIx = argv.indexOf('--blind');
const blind = blindIx >= 0 ? +argv[blindIx + 1] : 0;
let blindArmed = false;
const defId = args[0] || 'ruinGuard';
const zoneArg = args[1] || null;
const outIx = argv.indexOf('--out');
const outDir = outIx >= 0 ? argv[outIx + 1] : '/tmp/enemycam';
fs.mkdirSync(outDir, { recursive: true });

let passes = 0, fails = 0, skips = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passes++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); } else {
    fails++; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`);
  }
};
const skip = (name, why) => { skips++; console.log(`  SKIP ${name}  ${why}`); };
// sRGB byte distance, which is the ruler the eye uses — not linear luminance.
const dist = (a, b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));

// Where does this enemy actually stand? The camp is the answer, and it comes from the same
// table the server spawns from, so the tool cannot photograph a place the game does not use.
let found = null;
for (const z of Object.values(ZONES)) {
  if (zoneArg && z.id !== zoneArg) continue;
  for (const s of z.spawns || []) {
    if ((s.enemies || []).includes(defId)) {
      found = { zone: z.id, at: s.at, level: s.level, via: 'camp' };
      break;
    }
  }
  if (found) break;
}
// The second place an enemy can live: a dungeon **wave**. 暴风之主 stands in no camp anywhere —
// it exists only in `chambers[].waves` (abyssTrial floor 8, goldenHall floor 3) — so the camp
// search above printed "no camp spawns 'stormTyrant'" and the game's only three-phase boss was
// the one model this sheet had never photographed. Fighting two waves to reach it is not a
// frame this tool can hold still, so a wave kind is entered in the same zone and spawned from
// the *same* call the chamber uses (`ZoneInstance.spawnEnemy`, at the floor's own level, which
// is what `tools/boss-check.mjs` does for its phase tests). That requires 单机, because only
// there is the authoritative instance inside this tab.
if (!found) {
  for (const z of Object.values(ZONES)) {
    if (zoneArg && z.id !== zoneArg) continue;
    for (const c of z.chambers || []) {
      if ((c.waves || []).some((w) => w.includes(defId))) {
        found = { zone: z.id, at: null, level: c.level, via: 'wave', floor: c.floor };
        break;
      }
    }
    if (found) break;
  }
}
if (!found) {
  console.log(`no camp and no chamber wave in ${zoneArg || 'any zone'} spawns '${defId}'`);
  process.exit(1);
}
console.log(`${defId} -> ${found.zone} `
  + (found.via === 'camp' ? `camp at [${found.at}]` : `chamber floor ${found.floor} wave`)
  + ` (level ${found.level})`);

const origin = process.env.GAME_URL || 'http://127.0.0.1:5173';
const tokFile = '/tmp/world-token.txt';
let token = fs.existsSync(tokFile) ? fs.readFileSync(tokFile, 'utf8').trim() : '';
if (!token) {
  const r = await fetch(`${origin}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  token = (await r.json()).token;
  fs.writeFileSync(tokFile, token);
}

// Rank first, browser second — `Game.load` fetches the save once at boot and every zone gate
// reads that copy, so raising it on a live session changes nothing. Without this the two abyss
// kinds were unphotographable: 深渊法师's nearest camp is in 龙脊雪山 (AR 4) and 深渊使徒's is in
// 璃月 (AR 7), `enterZone` refused for the fresh AR 1 guest in /tmp/world-token.txt, and the tool
// then reported "the server never spawned a 'abyssHerald' near the camp" — which reads exactly
// like a broken spawn table. prop-cam's header tells the same story about 黄金屋 and AR 18.
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const needRank = zoneEntryRank(zoneById(found.zone));
if (needRank > 1) {
  const rr = await raiseRank(API, token, needRank);
  console.log(`rank -> AR ${rr.rank ?? '?'} (${found.zone} needs ${needRank})${rr.ok ? '' : ` — ${rr.reason}`}`);
}

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
  },
  defaultViewport: { width: 1000, height: 700 },
});
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

await p.goto(origin, { waitUntil: 'domcontentloaded' });
await p.evaluate((t) => localStorage.setItem('teyvat.token', t), token);
await p.reload({ waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 5000));
// 单机 for a wave kind: `LocalSocket` hosts the `ZoneInstance` in this tab, which is the only
// place a tool can add an enemy the world's own spawn tables would not have put there. Online
// the same call has nothing to spawn into (`g.socket.inst` is undefined) — and that is asserted
// below rather than assumed, because a silent fall back to online would look like "the wave
// table is wrong".
if (found.via === 'wave') await p.click('[data-act="solo"]');
await p.click('[data-act="resume"]');
for (let i = 0; i < 90; i++) {
  if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await new Promise((r) => setTimeout(r, 4000));

// llvmpipe matches the software-rasteriser pattern, so every probe boots at `low`: no bloom,
// no shadows, DPR 1.0. A glow that only reads because of bloom would look fine here and be
// judged on a frame the target hardware never shows — see also tools/prop-cam.mjs.
await p.evaluate(() => {
  window.game.setAutoQuality(false);
  window.game.setQuality('high');
  // Noon, pinned: the world clock moves the sun 15° a real minute, and every threshold in this
  // file was calibrated on the authored sky, which is exactly what daylight() returns at 12:00.
  window.game.setWorldTime(12);
});
await new Promise((r) => setTimeout(r, 3000));
console.log('quality pinned ->', await p.evaluate(() => window.game.quality));

const subject = await p.evaluate(async ([defId, zone, at, via, level, pinYaw]) => {
  const g = window.game;
  // 40 m out on both axes: `updateCamps` spawns a camp for any player within **110 m** and
  // `AOI_RADIUS` streams entities to 130 m, while `def.aggro` is 26 — so the machine appears,
  // is broadcast, and never notices anybody. The first version of this probe stood 12 m away
  // and photographed a fight: dust puffs over the armour, damage numbers over the chest and
  // the whole frame under the red hurt vignette. Everything after this reads the *first*
  // frame the enemy is in, so it has to be a frame with nothing happening in it.
  await g.enterZone(zone, at ? { x: at[0] + 40, z: at[1] + 40 } : undefined);
  // Recorded before anything is searched for: `enterZone` catches `rank_too_low` and only
  // *toasts* it, leaving the game in the zone it was already in — where every enemy of the
  // asked-for zone is legitimately absent. The caller compares this, so a refused transition
  // reports itself instead of arriving as "this kind never spawns".
  window.__landed = g.zoneId;
  window.__solo = { mode: g.mode, inst: !!g.socket?.inst };
  // A wave kind has nothing to wait for — nothing in the zone will ever spawn it — so it is
  // spawned here, 26 m behind the camera's forward, and immediately taken out of its own AI.
  // `aggro` is 60 m for the tyrant, so an awake one would charge across the arena before the
  // first screenshot; `ai = null` plus a stun deadline is how boss-check holds one still.
  if (via === 'wave') {
    const inst = g.socket?.inst;
    if (!inst) return null;
    const yaw = g.rig?.yaw ?? 0;
    const e = inst.spawnEnemy(defId, level, g.me.x - Math.sin(yaw) * 26, g.me.z - Math.cos(yaw) * 26);
    if (e) { e.ai = null; e.stunned = 1e9; e.state = 'idle'; }
    window.__spawned = !!e;
  }
  let rec = null;
  for (let i = 0; i < 40 && !rec; i++) {
    await new Promise((r) => setTimeout(r, 500));
    rec = [...g.actors.enemies.values()].find((e) => e.actor?.defId === defId) || null;
  }
  if (!rec) return null;
  // Freeze immediately: the machine is walking towards a level-1 guest, and everything after
  // this point needs the subject to hold still. Stopping the loop also stops the camera rig
  // from lerping `fov` back and the enemy from being interpolated any further.
  g.stop();
  const a = rec.actor;
  // The pin goes in before anything is measured: every world-space point below (the weak point,
  // the mesh corners, the head box) is read out of `matrixWorld`, so turning the subject
  // afterwards would leave the whole sheet describing the pose it used to be in.
  if (pinYaw !== null) {
    a.group.rotation.y = pinYaw;
    for (const k of ['ry', 'yaw', 'rotY']) if (typeof a[k] === 'number') a[k] = pinYaw;
  }
  a.group.updateMatrixWorld(true);
  const V = g.camera.position.constructor;
  const ry = a.group.rotation.y;
  const ws = a.view.weakspot;
  const eye = ws ? new V(
    a.group.position.x + ws.offset[0] * Math.cos(ry) + ws.offset[2] * Math.sin(ry),
    a.group.position.y + ws.offset[1],
    a.group.position.z - ws.offset[0] * Math.sin(ry) + ws.offset[2] * Math.cos(ry),
  ) : null;
  const me = g.me?.actor;
  const root = [me?.root, me?.group, me?.mesh, me?.obj].find((o) => o && o.isObject3D);
  if (root) root.visible = false;
  // Both DOM layers go too. `client/src/game/overlay.js` pins nameplates, health bars and
  // damage numbers to world positions, so the enemy's own nameplate sits directly above the
  // head — i.e. inside the frame this probe measures — and the HUD's minimap and party cards
  // cover two corners. Neither is part of the model.
  for (const sel of ['[data-hud]', '#world-overlay']) {
    const el = document.querySelector(sel);
    if (el) el.style.display = 'none';
  }
  // Called, not optional-called. `g.vfx?.clear?.()` is what this line used to say, and
  // `Vfx` had no `clear` at all, so it did nothing at all — and the frame this probe froze
  // was the frame the camp spawned in, which used to fire the fast-travel effect: a 12 m
  // cyan light pillar standing on the ruin guard's head, blown out enough to desaturate the
  // eye being measured. A cleanup step that cannot fail loudly is not a cleanup step.
  const dropped = g.vfx.clear() + (g.overlay.clear() ?? 0);
  const stillLive = g.vfx.clear();   // a clear that leaves work behind is a leak, not a clear
  // The *drawn* eye is much smaller than the hittable sphere: `weakspot().r` is deliberately
  // 2.2× the geometry so a 23 cm lamp on a 3.6 m machine is aimable. Rectangles sized off the
  // hittable radius are 165 px boxes covering the whole head — measured, that is the head's
  // average colour and not the eye's. `dims.eye.r` (the same expression that places the sphere)
  // times the group scale is the radius actually on screen.
  // Where the head actually is, and how big the model actually is — neither of which is
  // `a.height`. `a.height` is the *hitbox* height: 暴风之主's crest tips stand above it and its
  // head hovers well below it, so a portrait aimed at `0.90 * height` framed the bird's chin and
  // cropped the crest off the top edge. The head bone is the only honest aim point for a portrait,
  // and the union of the meshes' boxes is the only honest answer to "is the model in the frame".
  // (Bind-pose boxes: the rig is frozen near its rest pose, and both gates below keep margins.)
  const headBone = a.view.bones?.head ?? null;
  const headPos = headBone ? new V().setFromMatrixPosition(headBone.matrixWorld) : null;
  const corners = [];
  a.group.traverse((o) => {
    const geo = o.isMesh ? o.geometry : null;
    if (!geo?.attributes?.position) return;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    for (const x of [bb.min.x, bb.max.x]) {
      for (const y of [bb.min.y, bb.max.y]) {
        for (const z of [bb.min.z, bb.max.z]) corners.push(new V(x, y, z).applyMatrix4(o.matrixWorld));
      }
    }
  });
  // And the head's *own* extent, from the vertices the head bone actually drives. An
  // axis-aligned box over a 21 m wingspan has corners nowhere near the bird, so projecting the
  // model box said the back-head portrait cropped the head while the picture shows the whole head
  // with room to spare — the same "a box top is not a head" trap one level up. Weights come
  // straight from `skin.js` (dominant bone, weight ≥ 0.5), and the live rigid transform for a
  // head-bound vertex is `headBone.matrixWorld · boneInverse` (the geometry is already in bind
  // space and the inverses were captured in that same space — see `buildRigged`).
  const sm = a.view.skinned;
  let headCorners = null;
  const hbi = headBone && sm?.skeleton ? sm.skeleton.bones.indexOf(headBone) : -1;
  if (hbi >= 0 && sm.geometry?.attributes?.skinIndex) {
    const { position: pos, skinIndex: si, skinWeight: sw } = sm.geometry.attributes;
    const g4 = ['getX', 'getY', 'getZ', 'getW'];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (si[g4[k]](i) === hbi) w += sw[g4[k]](i);
      if (w < 0.5) continue;
      const v = [pos.getX(i), pos.getY(i), pos.getZ(i)];
      for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], v[d]); hi[d] = Math.max(hi[d], v[d]); }
    }
    if (lo[0] < Infinity) {
      const rigid = new headBone.matrixWorld.constructor()
        .copy(headBone.matrixWorld).multiply(sm.skeleton.boneInverses[hbi]);
      headCorners = [];
      for (const x of [lo[0], hi[0]]) {
        for (const y of [lo[1], hi[1]]) {
          for (const z of [lo[2], hi[2]]) headCorners.push(new V(x, y, z).applyMatrix4(rigid));
        }
      }
    }
  }
  window.__subj = {
    // `actor` so the stride section can pin the gait clock by hand: with the loop stopped
    // nothing else re-poses the rig, so a pinned `gait` survives until the next screenshot.
    actor: a, group: a.group, eye, ry, height: a.height, r: ws?.r ?? 0, headPos, corners, headCorners,
    rVis: (a.view.dims?.eye?.r ?? 0) * a.group.scale.x,
    glow: a.view.materials?.glow ?? null, metal: a.view.materials?.metal ?? null,
    eyeMat: a.view.materials?.eye ?? null,
  };
  return {
    pos: [a.group.position.x, a.group.position.y, a.group.position.z].map((v) => +v.toFixed(2)),
    ry: +ry.toFixed(2), height: +a.height.toFixed(2),
    eye: eye ? [eye.x, eye.y, eye.z].map((v) => +v.toFixed(2)) : null,
    r: ws?.r ?? null, avatarHidden: !!root,
    headY: headPos ? +headPos.y.toFixed(2) : null,
    modelTop: +Math.max(...corners.map((c) => c.y)).toFixed(2),
    meshes: corners.length / 8,
    // The two heights the framings are computed from, in metres: how tall the *model* is (not the
    // hitbox — the tyrant's crests stand 2.2 m above its 9.88 m hitbox) and how tall the head is.
    // A stand-off is only ever right relative to the thing it is framing, and a constant fraction
    // of the frame is only reachable if the tool knows that number.
    modelH: +(Math.max(...corners.map((c) => c.y)) - a.group.position.y).toFixed(2),
    headH: headCorners
      ? +(Math.max(...headCorners.map((c) => c.y)) - Math.min(...headCorners.map((c) => c.y))).toFixed(2)
      : null,
    // And the head's bounding *sphere* radius, which is the number a stand-off has to be solved
    // from: a head is not a vertical stick. Fitting the wolf's 0.5 m head height to the frame put
    // the camera at 1.49 m, where its 0.95 m muzzle ran out of the *side* of the frame; the vishap's
    // drill horn projected 123% of the frame height from behind, because a box as deep as it is far
    // from the lens spreads in perspective. A sphere has no such orientation.
    headR: headCorners
      ? +(0.5 * Math.hypot(...['x', 'y', 'z'].map((k) => Math.max(...headCorners.map((c) => c[k]))
        - Math.min(...headCorners.map((c) => c[k]))))).toFixed(2)
      : null,
    // The box in metres, per axis, so a reader can tell "the framing is wrong" from "the box is
    // wrong": a bind-pose box on a posed rig is an over-estimate, and how much of one is visible here.
    span: ['x', 'y', 'z'].map((k) => +(Math.max(...corners.map((c) => c[k]))
      - Math.min(...corners.map((c) => c[k]))).toFixed(1)),
    scale: +a.group.scale.x.toFixed(2),
    vfxDropped: dropped, vfxStillLive: stillLive, hasGlowMat: !!window.__subj.glow,
    // Whether the *baked mesh* uses the eye material, not whether the palette has one: every kind
    // gets the full material set built, and only the ones a kind's `parts` asked for end up in the
    // mesh's material array (see `bakeSkinned` — one mesh, one array, so `=== mats.eye` on the
    // object is always false and the presence test has to look inside the array).
    usesEyeMat: (() => {
      const mm = sm && Array.isArray(sm.material) ? sm.material : sm?.material ? [sm.material] : [];
      return !!a.view.materials?.eye && mm.includes(a.view.materials.eye);
    })(),
  };
}, [defId, found.zone, found.at, found.via, found.level, pinYaw]);

const landed = await p.evaluate(() => window.__landed);
const solo = await p.evaluate(() => window.__solo);
if (found.via === 'wave' && !(solo?.mode === 'solo' && solo?.inst)) {
  console.log(`ABORTED: '${defId}' only appears in a chamber wave, which needs 单机 —`
    + ` this session is mode=${solo?.mode} inst=${solo?.inst}`);
  await b.close();
  process.exit(1);
}
if (landed !== found.zone) {
  console.log(`ABORTED: asked for ${found.zone}, the game is in ${landed} — the transition did not take`);
  console.log(`  ${found.zone} needs AR ${needRank}; raise it with POST /api/dev/rank (dev only) or check enterZone`);
  await b.close();
  process.exit(1);
}
if (!subject) {
  console.log(found.via === 'camp'
    ? `the server never spawned a '${defId}' near the camp (in ${landed}, as asked)`
    : `spawnEnemy('${defId}') produced nothing in ${landed}`
      + ` (spawned=${await p.evaluate(() => window.__spawned)})`);
  await b.close();
  process.exit(1);
}
console.log('subject', JSON.stringify(subject));
// "Nothing is happening in this frame" was an assumption until it was checked: the pillar that
// used to stand on the guard's head was a live effect frozen by `g.stop()`.
check('the frozen frame has no effects left in it', subject.vfxStillLive === 0,
  `dropped ${subject.vfxDropped}, still live ${subject.vfxStillLive}`);

/**
 * [label, aim height as a fraction of the model's height, stand-off in metres, fov, yaw offset
 * from the model's own forward]. Yaw is relative to the *model*, so "front" means the face and
 * not whichever way the camera happened to be pointing.
 */
// Stand-offs were authored for something person-sized; the tallest kind that stands in the open
// world is the 3.6 m ruin guard. 暴风之主 is 9.9 m tall with a wingspan to match, and 11 m in a
// 40° cone shows a wing and nothing else. So the distances scale with height *above* 3.6 m —
// exactly 1.0× for every kind these numbers were calibrated on, so no existing frame moves.
const hs = +Math.max(1, subject.height / 3.6).toFixed(2);
if (hs > 1) console.log(`stand-offs ×${hs} (this model is ${subject.height} m tall)`);
// The head close-up's distance comes from the head, for the same reason the aim point does.
// 4.2 m in a 34° cone is 2.6 m of frame height: the tyrant's 1.7 m head fills 69% of it and the
// frost wolf's 0.5 m head fills 20% — 140 px of face, in which no one can see whether an eye has
// a pupil, which is the thing these three pictures exist to show. So the distance is solved for a
// fixed share of the frame height and then only ever allowed to come *closer* than the calibrated
// 4.2·hs, so every kind that already framed well keeps its exact framing.
//
// The floor is the weak-point section, which measures the plating 1.0 m *below* the eye in this
// same shot: at 1.6 m the frame is 0.98 m tall and that rect falls off the bottom, so a kind with
// an authored weakspot needs enough vertical coverage to hold it. Both numbers are printed —
// a framing this tool solved for itself has to be readable in the log.
// `HEAD_FIT` is how much of the frame's *vertical* angle the head's bounding sphere is allowed to
// subtend: `d = R / sin(HEAD_FIT · fov/2)`. The sphere over-estimates every head, so the head itself
// lands somewhere under this and nothing crops from any yaw — which the height-only version could
// not promise in either direction.
const HEAD_FOV = 34, HEAD_FIT = 0.85;
const halfCone = Math.tan((HEAD_FOV * Math.PI) / 360);
const far = +(4.2 * hs).toFixed(2);
const headNear = ENEMIES[defId].weakspot ? 2.6 / (2 * halfCone) : 0.9;
const headDst = subject.headR
  ? +Math.min(far, Math.max(headNear,
    subject.headR / Math.sin((HEAD_FIT * HEAD_FOV * Math.PI) / 360))).toFixed(2)
  : far;
if (headDst !== far) {
  console.log(`close-ups at ${headDst} m instead of ${far} m`
    + ` (a ${subject.headH} m head, bounding radius ${subject.headR} m, at`
    + ` ${(HEAD_FIT * 100).toFixed(0)}% of the frame angle, floor ${headNear.toFixed(2)} m)`);
}
// Where the subject stands is the last thing that can falsify the sheet, and it is not the model's
// fault: a camp on a 23° slope leaves *no* stand-off that clears the hill at the asked yaw, so the
// wolf's own hillside was the reason its portraits orbited 100°. This sheet is about the model, so
// the frozen subject is walked to the flattest spot near its camp — the same world, the same
// lighting, the same server-spawned actor, on ground that does not stand in front of it. Only when
// it is needed: every kind whose four yaws already clear the terrain stays exactly where it spawned
// and keeps its calibrated frames. The relief before and after is printed, because a subject that
// had to be moved is not photographed where the game put it and a reader has to know.
const relief = await p.evaluate(([hs, headDst, camY]) => {
  const g = window.game, s = window.__subj;
  const H = (x, z) => g.world?.heightAt?.(x, z) ?? 0;
  const wl = (g.world?.zone?.water?.level ?? -999) + 0.6;
  const p0 = s.group.position;
  // The four shots are rebuilt here from `s` rather than passed in, because a *prediction* of where
  // the camera will stand has to use the same geometry that puts it there. The first version scored
  // rings around the group's x/z while `shoot()` orbits the **aim point** — and the head bone of a
  // quadruped is 0.8 m in front of its group origin, which at a 2.77 m stand-off moves the sampled
  // hill by more than the cap. It reported "every portrait can keep its yaw" and then the wolf's
  // front-head orbited 100°: a search that scores a different camera than the one that shoots is
  // the same class of mistake as measuring a point the model no longer stands on.
  const head = s.headPos || p0.clone().setY(p0.y + s.height * 0.9);
  const float = p0.y - H(p0.x, p0.z);   // the model is not always exactly on the height field
  const shots = [
    [s.ry, 11 * hs, 0, 0, s.height * 0.55],
    ...[0, 0.9, Math.PI].map((d) =>
      [s.ry + d, headDst, head.x - p0.x, head.z - p0.z, head.y - p0.y]),
  ];
  // The worst "the camera is inside the hill" over the four portraits, as metres above the lift cap
  // that shot is allowed. ≤ 0 means every portrait can keep its own yaw. Sampled along the whole
  // line of sight, for the reason written out over `need` in `shoot()`.
  const score = (x, z) => {
    let worst = -Infinity;
    for (const [yaw, dst, ax, az, ay] of shots) {
      const aim = { x: x + ax, z: z + az, y: H(x, z) + float + ay };
      const baseY = aim.y + dst * camY;
      const margin = Math.min(0.6, 0.25 + dst * 0.03);
      const cx = aim.x + Math.sin(yaw) * dst, cz = aim.z + Math.cos(yaw) * dst;
      let need = 0;
      for (let i = 0; i <= 12; i++) {
        const t = i / 16;
        const gap = H(cx + (aim.x - cx) * t, cz + (aim.z - cz) * t)
          + margin * (1 - t) - (baseY + (aim.y - baseY) * t);
        if (gap > 0) need = Math.max(need, gap / (1 - t));
      }
      worst = Math.max(worst, need - dst * 0.35);
    }
    return worst;
  };
  const before = score(p0.x, p0.z);
  if (before <= 0) return { before: +before.toFixed(2), moved: 0 };
  // Nearest ring first, and *within* a ring the smallest change in elevation wins rather than the
  // flattest spot: the abyss herald's camp stands at the foot of a Liyue karst pillar, and the
  // absolutely-flattest ground within 30 m of it is the top of the pillar — a 90 m climb, which is
  // the same "the camera ended up on the pillar" mistake one level down ([[orbit-dont-lift]]).
  //
  // The tie-break alone was not enough, because it only chooses *within* the first ring that has any
  // clear spot at all: the geo vishap's camp gave none until r = 9, and the winner there was +48.58 m
  // up the pillar's wall. So the destination has to be somewhere the subject could have stood, by the
  // product's own definition — `findWalkable`'s default `maxSlope` 0.5 (shared/src/data/zones.js),
  // applied both to the spot itself and to the average grade of the walk that reaches it. That keeps
  // every relocation a short stroll across the same terrain; when nothing walkable is clear, the
  // best walkable spot is taken anyway and the yaw assertion below reports the bend, which is the
  // honest outcome — a portrait shot from a bent yaw that says so beats a portrait of a spire.
  const SLOPE = 0.5;
  const h0 = H(p0.x, p0.z);
  const walkable = (x, z, r) =>
    (g.world?.slopeAt?.(x, z) ?? 0) <= SLOPE && Math.abs(H(x, z) - h0) <= SLOPE * r;
  let best = { x: p0.x, z: p0.z, sc: before };
  for (let r = 3; r <= 30 && best.sc > 0; r += 3) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = p0.x + Math.sin(a) * r, z = p0.z + Math.cos(a) * r;
      if (H(x, z) < wl) continue;                    // not into the lake
      if (!walkable(x, z, r)) continue;              // not up a cliff face
      const sc = score(x, z);
      const climb = Math.abs(H(x, z) - h0);
      if (sc <= 0 && (best.sc > 0 || climb < Math.abs(H(best.x, best.z) - h0))) best = { x, z, sc };
      else if (best.sc > 0 && sc < best.sc) best = { x, z, sc };
    }
  }
  if (best.x === p0.x && best.z === p0.z) return { before: +before.toFixed(2), moved: 0 };
  // Translate the model *and* every world-space point cached from it, or the boxes and the aim
  // point describe where it used to be — the silent version of this bug is a probe measuring an
  // empty patch of grass ([[drawn-lit-and-invisible]]).
  const d = { x: best.x - p0.x, y: H(best.x, best.z) - H(p0.x, p0.z), z: best.z - p0.z };
  s.group.position.set(p0.x + d.x, p0.y + d.y, p0.z + d.z);
  s.group.updateMatrixWorld(true);
  // Only fields the actor actually has: writing `a.x = d.x` onto an undefined `x` would put a
  // *delta* where the rest of the code expects a world coordinate.
  const a = s.actor;
  if (a) for (const k of ['x', 'y', 'z']) if (typeof a[k] === 'number') a[k] += d[k];
  for (const v of [s.headPos, s.eye].concat(s.corners || [], s.headCorners || [])) {
    if (v) { v.x += d.x; v.y += d.y; v.z += d.z; }
  }
  return {
    before: +before.toFixed(2), after: +best.sc.toFixed(2),
    moved: +Math.hypot(d.x, d.z).toFixed(1), dy: +d.y.toFixed(2),
  };
}, [hs, headDst, 0.10]);
if (relief.moved) {
  console.log(`subject walked ${relief.moved} m to flatter ground`
    + ` (${relief.dy >= 0 ? '+' : ''}${relief.dy} m in height): the hill stood`
    + ` ${relief.before} m into the worst portrait, now ${relief.after} m`);
} else if (relief.before > 0) {
  console.log(`no flatter ground within 30 m: the hill stands ${relief.before} m`
    + ' into the worst portrait, so some yaw will have to be bent');
}

const SHOTS = [
  ['front-full', 0.55, 11 * hs, 40, 0],
  ['front-head', 'head', headDst, HEAD_FOV, 0],
  ['quarter', 'head', headDst, HEAD_FOV, 0.9],
  ['back-head', 'head', headDst, HEAD_FOV, Math.PI],
];

const shots = {};
/**
 * Frame the model, render, screenshot, and hand back where the interesting points landed.
 * `camY` is the camera's height above the aim point as a fraction of the stand-off: the default
 * 0.10 is nearly level with the subject, which is the flattering angle for a portrait and the
 * useless one for anything at ground level — camps stand on slopes and a level camera puts the
 * hill in front of the feet.
 */
async function shoot(label, hf, dst, fov, dyaw, camY = 0.10, lift = true, extra = 0) {
  const info = await p.evaluate(([hf, dst, fov, dyaw, camY, lift, extra, blind]) => {
    const g = window.game;
    const s = window.__subj;
    const cam = g.camera;
    // `hf === 'head'` means "aim at the head bone", which is not the same point as any fraction
    // of the hitbox height — see the note where `headPos` is captured. Unrigged kinds (the three
    // slimes) have no bones, so they fall back to the fraction the portraits were calibrated on.
    const aim = s.group.position.clone();
    if (hf === 'head' && s.headPos) aim.copy(s.headPos);
    else aim.y += s.height * (hf === 'head' ? 0.90 : hf);
    const yaw = s.ry + dyaw;
    const baseY = aim.y + dst * camY;
    cam.fov = fov;
    // `--blind F`: throw away everything nearer than the subject until the camera has climbed
    // F× the stand-off — the same units the retry ladder climbs in, so one value buries the same
    // rungs of an 11 m full body and a 1.5 m head close-up. Injected here and not with a real
    // occluder because a mesh in front of the lens needs THREE constructors the page does not
    // export, and because the *signature* is what the retry loop reads: an empty photograph whose
    // diff against the hidden frame is 0 px. Restored from the saved default on every other shot,
    // so one flag cannot leak into a sheet.
    window.__near0 ??= cam.near;
    cam.near = blind > 0 && extra < blind * dst ? dst * 1.06 : window.__near0;
    // Keeping the terrain out of the lens, which the probe has to do itself because it drives
    // `cam.position` and so skips the product's rule (`CameraRig` holds itself `heightAt + 0.35`
    // above the ground for exactly this reason). A camp on a slope puts *this* camera inside a
    // hill: the hilichurl archer's arrival-effect frame came back as 1000x700 px of grass with
    // the subject, the effect and the sky all on the far side of the terrain.
    //
    // Two ways out, and which one is right depends on which claim the shot is making. **Orbiting**
    // keeps the distance, the elevation and the subject's size and only changes which side it is
    // seen from — free for a shot that does not care about the side, ruinous for these four, whose
    // labels *are* the side. It was tried first for months and it quietly falsified the sheet: 43
    // of the frames in one sweep had been orbited, 12 of them by 80–120°, so 「front-head」 was a
    // profile of a frost wolf and the eye placement was being judged from a picture that never
    // showed the face. **Lifting** keeps the yaw and spends the elevation instead, and its own
    // failure mode is unbounded: a camp under a Liyue karst pillar asked the abyss herald for
    // 95.9 m of lift, which is a camera on top of the pillar and a 4-px speck of boss
    // ([[orbit-dont-lift]] the hard way).
    //
    // So: lift, up to a cap that keeps the look-down angle usable (0.35·dst ≈ 19°), and only orbit
    // when even that is not enough — the least-lift yaw, as before. Both numbers are reported and
    // the yaw is *asserted* below, because a bent framing that nobody counts is a framing nobody
    // knows about. The clearance margin scales too: +0.6 m is right for an 11 m stand-off, and at
    // 1.5 m from a wolf's head it fires on any slope at all and forced exactly those 100° orbits.
    //
    // Off for the isolation sheet below, and that is not an exception to the rule: the rule is
    // "keep the terrain out of the lens", and in isolation the terrain is not drawn at all.
    // Lifting there would only tilt the sheet — the archer's four yaws came back from 0 m, 5.84 m,
    // 0 m and 3.64 m above the aim point, which is four different framings of one model.
    let lifted = 0, orbited = 0, shotYaw = yaw;
    if (lift) {
      const margin = Math.min(0.6, 0.25 + dst * 0.03);
      // The hill that ruins a portrait is not the one under the camera's feet — it is the ridge
      // *between* the camera and the subject, and a point sample at the camera cannot see it. The
      // ruin guard wandered 1.6 m and turned around between two runs of this tool; the second run
      // reported `lifted 0, orbited 0` and produced 1000x700 px of hillside with the guard behind
      // it, and every weak-point assertion then measured grass ([[sweep-dont-sample]]). So the
      // whole line of sight is sampled, and the lift is solved for the worst point on it: raising
      // the camera by `dy` lifts the ray at fraction `t` by `dy·(1−t)`, so that point asks for
      // `gap/(1−t)`. The margin tapers to nothing at the aim point — the subject's own feet are
      // below its head and must not be mistaken for an occluder — and t stops at 0.75 so the
      // divisor stays sane. At t = 0 this is exactly the old camera-point test.
      const HH = (x, z) => g.world?.heightAt?.(x, z) ?? -Infinity;
      const need = (yy) => {
        const cx = aim.x + Math.sin(yy) * dst, cz = aim.z + Math.cos(yy) * dst;
        let dy = 0;
        for (let i = 0; i <= 12; i++) {
          const t = i / 16;
          const gap = HH(cx + (aim.x - cx) * t, cz + (aim.z - cz) * t)
            + margin * (1 - t) - (baseY + (aim.y - baseY) * t);
          if (gap > 0) dy = Math.max(dy, gap / (1 - t));
        }
        return dy;
      };
      const cap = dst * 0.35;
      let best = { dy: 0, need: need(yaw) };
      if (best.need > cap) {
        for (let k = 1; k <= 17 && best.need > 0.01; k++) {
          const dy = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 9);
          const n = need(yaw + dy);
          if (n < best.need) best = { dy, need: n };
        }
      }
      shotYaw = yaw + best.dy;
      orbited = Math.round(best.dy * 57.3);
      lifted = +best.need.toFixed(2);
    }
    // `extra` is lift the *height field* did not ask for, handed down by the caller when the
    // photograph came back empty anyway: grass, boulders and trunks are props, and `heightAt`
    // has never heard of them. See the retry loop below the framing gates.
    cam.position.set(aim.x + Math.sin(shotYaw) * dst, baseY + lifted + extra,
      aim.z + Math.cos(shotYaw) * dst);
    cam.lookAt(aim);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    for (let i = 0; i < 3; i++) g.r.render(0.016);
    // Project the weak point to pixels, plus one radius to the camera's right (so rectangles
    // are sized in units of the eye) and two points *inside the body* below it. A point inside
    // the volume always projects onto the silhouette, which is what makes "0.4 m below the eye"
    // a reliable patch of armour without knowing anything about the model's outline.
    const w = window.innerWidth, h = window.innerHeight;
    const toPx = (v) => {
      const q = v.clone().project(cam);
      return [Math.round((q.x * 0.5 + 0.5) * w), Math.round((-q.y * 0.5 + 0.5) * h)];
    };
    // The model's own screen-space extent, from the mesh boxes rather than from a height: two of
    // this tool's framings have been wrong in a way no number in the log could show (a 4-px speck,
    // and a boss whose head hung above the top edge), so every shot now prints its subject's box.
    const pxBox = (pts) => {
      const q = pts.map(toPx);
      return [
        Math.min(...q.map((v) => v[0])), Math.min(...q.map((v) => v[1])),
        Math.max(...q.map((v) => v[0])), Math.max(...q.map((v) => v[1])),
      ];
    };
    const boxPx = pxBox(s.corners);
    const headPx = s.headCorners ? pxBox(s.headCorners) : null;
    const feet = toPx(s.group.position.clone().setY(s.group.position.y + 0.5));
    // The control point for anything fired at the feet: 4.5 m up is 2.25× the arrival effect's
    // 2.0 m radius, so it is outside the effect for *every* kind. The head is not — a 1.7 m
    // hilichurl stands entirely inside its own spawn ring, and using its head as the "this must
    // not change" box failed the moment this section stopped being skipped for eyeless kinds.
    const high = toPx(s.group.position.clone().setY(s.group.position.y + 4.5));
    // The two body points every subject has, eye or no eye: the ankles and the top of the head.
    // Only the *weak-point* rects need `s.eye`, and those live behind a `weakspot` branch that
    // SKIPs — so returning null here used to kill the arrival-effect section (which only wants
    // the feet and something far away from them) for every enemy without an authored eye.
    if (!s.eye) {
      const top = toPx(s.group.position.clone().setY(s.group.position.y + s.height));
      return { c: top, rpx: 0, w, h, armour: null, chest: null, feet, high, lifted, orbited, boxPx, headPx, hasEye: false };
    }
    const right = new cam.position.constructor().setFromMatrixColumn(cam.matrixWorld, 0);
    const down = (m) => s.eye.clone().setY(s.eye.y - m);
    const c = toPx(s.eye);
    const edge = toPx(s.eye.clone().add(right.multiplyScalar(s.rVis)));
    return {
      c, rpx: Math.max(3, Math.abs(edge[0] - c[0])), w, h,
      armour: toPx(down(0.4)), chest: toPx(down(1.0)), feet, high, lifted, orbited, boxPx, headPx, hasEye: true,
    };
  }, [hf, dst, fov, dyaw, camY, lift, extra, blindArmed ? blind : 0]);
  await new Promise((r) => setTimeout(r, 1200));
  const file = `${outDir}/${defId}-${label}.png`;
  await p.screenshot({ path: file });
  shots[label] = { file, info };
  console.log(`  ${label} -> ${file}`
    + (info?.hasEye ? `  eye at ${info.c} r=${info.rpx}px` : `  head at ${info?.c} feet at ${info?.feet}`)
    + (info?.boxPx ? `  model box ${info.boxPx}` : '')
    + (info?.headPx ? `  head box ${info.headPx}` : '')
    + (info?.orbited ? `  (camera orbited ${info.orbited}° to clear the ground)` : '')
    + (info?.lifted ? `  (camera lifted ${info.lifted} m out of the ground)` : '')
    + (extra ? `  (and ${extra.toFixed(2)} m more, for whatever is in the way that the height`
      + ' field does not know about)' : ''));
  return shots[label];
}

/**
 * Shoot each portrait and then *prove* it contains the model, by hiding the model and diffing:
 * the pixels inside its projected box have to be its pixels ([[no-change-means-wrong-camera]]).
 *
 * This runs here, in the framing loop, rather than as a post-hoc assertion, because the answer
 * changes the framing. The terrain rule above solves the lift out of `heightAt`, and grass,
 * boulders and trunks are *props* — the height field has never heard of them. The water slime's
 * full-body portrait came back as 1000×700 px of grass blade with the camera inside a clump, and
 * every number in the log was healthy: lifted 0.5 m, box 70×92 px, "1.10× the size a 0.96 m model
 * covers at 11.0 m". The one measurement that saw it was hiding the slime and finding that the
 * frame did not change *by a single pixel*.
 *
 * So the photograph is the test and it is retried: keep the yaw (the label is the yaw), keep the
 * distance (the size gate is a claim about the distance), and spend elevation, which is the axis
 * that carries no claim in a portrait — in fractions of the stand-off so a 1.5 m head close-up and
 * an 11 m full body get comparable angles. If none of the four framings works the assertion below
 * fails with the best of them, which is what it did before this loop existed.
 */
const seen = {};
const coverage = (label, hiddenFile) => {
  const s = shots[label].info;
  const m = diffMask(decodePng(fs.readFileSync(shots[label].file)),
    decodePng(fs.readFileSync(hiddenFile)), 16);
  // Clamped to the frame: a close-up box legitimately runs off every edge, and an unclamped
  // area would make the percentage meaningless in exactly the shots that matter most.
  const r = { x: Math.max(0, s.boxPx[0]), y: Math.max(0, s.boxPx[1]) };
  r.w = Math.min(s.w, s.boxPx[2]) - r.x;
  r.h = Math.min(s.h, s.boxPx[3]) - r.y;
  const inBox = r.w > 0 && r.h > 0 ? maskInRect(m, r) : 0;
  const area = Math.max(1, r.w * r.h);
  return {
    inBox, area, frame: m.count, pc: +((inBox / area) * 100).toFixed(1),
    ok: inBox >= Math.max(500, area * 0.08),
  };
};
blindArmed = true;
for (const [label, hf, dst, fov, dyaw] of SHOTS) {
  for (const rung of [0, 0.14, 0.30, 0.55]) {
    const extra = rung * dst;
    await shoot(label, hf, dst, fov, dyaw, 0.10, true, extra);
    await p.evaluate(() => { window.__subj.group.visible = false; });
    // Same label-by-label framing, and the lift/orbit is a function of the terrain and this
    // `extra` alone, so each hidden frame is the visible one with the subject removed and
    // nothing else changed.
    const hidden = await shoot(`${label}-hidden`, hf, dst, fov, dyaw, 0.10, true, extra);
    await p.evaluate(() => { window.__subj.group.visible = true; });
    seen[label] = { ...coverage(label, hidden.file), extra: +extra.toFixed(2) };
    if (seen[label].ok) break;
    console.log(`  ${label}: hiding the model moved ${seen[label].inBox} px of its`
      + ` ${seen[label].area} px box (${seen[label].pc}%) — something the height field does not`
      + ' know about is in the way, so the camera goes up');
  }
}
blindArmed = false;

// Two gates on the framings themselves, because the four pictures above are the ones a human
// judges and both ways this tool has mis-framed a model were invisible in its log. The full-body
// shot promises the whole model at a usable size; the three close-ups promise an uncropped head.
// Neither is free: aiming at the head bone would make "the head is centred" true by construction,
// so what is asserted is the *model box* against the frame edges — a claim the aim point cannot fake.
{
  // First, the cheapest and most damaging thing to get wrong: was each shot taken from the side
  // its name promises? Nothing else in this sheet means anything if it was not — "the eyes are
  // drawn in the front portrait" is not a claim about eyes if the portrait is a profile.
  const bent = ['front-full', 'front-head', 'quarter', 'back-head']
    .map((l) => [l, shots[l].info.orbited || 0])
    .filter(([, o]) => Math.abs(o) > 20);
  check('every portrait was shot from the yaw its name claims',
    bent.length === 0,
    bent.length
      ? `${bent.map(([l, o]) => `${l} orbited ${o}°`).join(', ')} — the terrain forced it`
      : 'no shot needed more than 20° of orbit off its own yaw');

  const f = shots['front-full'].info;
  const [x0, y0, x1, y1] = f.boxPx;
  const inside = x0 >= 0 && y0 >= 0 && x1 <= f.w && y1 <= f.h;
  const fill = (y1 - y0) / f.h;
  // Not a constant floor. This shot is at a fixed *gameplay* distance — the weak-point section
  // asserts "visible from 11 m away" against it — so how much of the frame the model fills is a
  // property of how big the model is, and a 25% floor failed a correctly framed 1.9 m hilichurl
  // (23%) and a 1.5 m wolf (18%) while passing everything taller. The reference is geometry:
  // `modelH / (2·dst·tan(fov/2))` is the share of the frame height a model of that height must
  // cover at that stand-off. Measured over predicted lands near 1.0 for every kind, and it is the
  // ratio that catches the failure this gate exists for — the karst-pillar lift multiplies the
  // real distance (√(dst² + lift²) was 96 m for the herald), so the ratio collapses with it.
  const exp = subject.modelH / (2 * 11 * hs * Math.tan((40 * Math.PI) / 360));
  const ratio = fill / exp;
  check('the whole model is inside the full-body frame at the size its height predicts',
    inside && ratio >= 0.6 && ratio <= 2.0,
    `box ${f.boxPx} in ${f.w}x${f.h}, filling ${(fill * 100).toFixed(0)}% of the height`
    + ` — ${ratio.toFixed(2)}× the ${(exp * 100).toFixed(0)}% a ${subject.modelH} m model covers`
    + ` at ${(11 * hs).toFixed(1)} m` + (inside ? '' : ' — cropped')
    + (f.lifted ? `, camera lifted ${f.lifted} m` : ''));
  for (const label of ['front-head', 'quarter', 'back-head']) {
    const s = shots[label].info;
    if (!s.headPx) {
      skip(`the ${label} close-up shows the whole head, large enough to read`,
        'this kind has no rig, so there is no head bone to bound');
      continue;
    }
    // The distance is solved for HEAD_FILL of the frame, so this band is two-sided around it and
    // both sides mean something: below it the head is too small to judge a face (the defect that
    // made this gate necessary), above it the head is about to leave the frame. 4 px of margin
    // rather than 0, because a box that ends exactly on the edge has already lost a pixel.
    // "Large enough to read" is about the *limiting* axis, not the vertical one: a muzzle that runs
    // 45% across the frame while standing 34% up it is a legible head, and demanding 30% of the
    // height from every head would push a long one out of the sides.
    const [x, y, X, Y] = s.headPx;
    const inside = x >= 4 && y >= 4 && X <= s.w - 4 && Y <= s.h - 4;
    const fill = Math.max((Y - y) / s.h, (X - x) / s.w);
    check(`the ${label} close-up shows the whole head, large enough to read`,
      inside && fill >= 0.30 && fill <= 0.95,
      `head box ${s.headPx} in ${s.w}x${s.h}, ${(fill * 100).toFixed(0)}% of its longer frame axis`
      + ` (${subject.headH} m head, r ${subject.headR} m, at ${headDst} m)`
      + (inside ? '' : ' — cropped'));
  }
}

// A projected box is not a photograph. Both gates above run the model's own corners through the
// camera matrix, so they are just as green when the model stands *behind a hill*: the run that
// found this reported "the whole model is inside the full-body frame at 1.05× the predicted size"
// about a frame containing nothing but a grassy ridge. The evidence was collected in the framing
// loop (which retries on it); this is where it is *judged*, and it stays independent of both the
// terrain rule and the projected boxes — it measures the photograph.
{
  const rows = SHOTS.map(([l]) => [l, seen[l]]);
  console.log('  ' + rows.map(([l, s]) => `${l} ${s.inBox}/${s.area} px in box (${s.pc}%,`
    + ` ${s.frame} in frame${s.extra ? `, camera raised a further ${s.extra} m` : ''})`).join('; '));
  const worst = rows.reduce((a, b) => (b[1].pc < a[1].pc ? b : a));
  check('every portrait photographs the model and not the hill in front of it', worst[1].ok,
    `${worst[0]} is the emptiest: hiding the model changed ${worst[1].inBox} px inside its own box`
    + ` of ${worst[1].area} px (${worst[1].pc}%), ${worst[1].frame} px in the whole frame`
    + (worst[1].extra ? ` — and that is with the camera ${worst[1].extra} m above where the`
      + ' terrain rule put it' : ''));
}

// Are the eyes in the portrait at all? The two abyss kinds' faces were built, bound and lit and
// sealed inside their own head volumes, and that was caught by *looking* — but the eye material is
// removable, so it can be asserted instead. Hide it and the front portrait has to change inside
// the head box (the eyes are drawn) and stay put outside it (what changed is the eyes).
if (!subject.usesEyeMat) {
  skip('the eyes are drawn in the front portrait', 'this model does not use the eye material');
  skip('...and hiding them changed nothing outside the head', 'ditto');
} else {
  await p.evaluate(() => { window.__subj.eyeMat.visible = false; });
  // Same distance and fov as the frame it is diffed against, or the "diff" is two framings.
  const noEye = await shoot('front-head-noeye', 'head', headDst, HEAD_FOV, 0);
  await p.evaluate(() => { window.__subj.eyeMat.visible = true; });
  const m = diffMask(decodePng(fs.readFileSync(shots['front-head'].file)),
    decodePng(fs.readFileSync(noEye.file)), 16);
  const [hx, hy, hX, hY] = shots['front-head'].info.headPx;
  const inHead = maskInRect(m, { x: hx, y: hy, w: hX - hx, h: hY - hy });
  const outside = m.count - inHead;
  check('the eyes are drawn in the front portrait', inHead >= 40,
    `${inHead} px changed inside the head box when the eye material was hidden`);
  check('...and hiding them changed nothing outside the head', outside <= Math.max(40, inHead * 0.5),
    `${outside} px changed elsewhere, of ${m.count} in the frame`);
}

// The control shot: the same two framings with the glow material turned into plain metal.
// "Two rectangles differ" is true of any model; "this rectangle stops differing when the
// glow is switched off, and the rectangle next to it does not move" is a statement about
// the eye. See tools/mat-probe.mjs for the same trick on a shader uniform, and the vault's
// magenta test material for why a suspect has to be *removable* to be provable.
let dark = null;
if (subject.hasGlowMat) {
  await p.evaluate(() => {
    const s = window.__subj, m = s.glow, T = m.userData.toon;
    window.__glowSave = {
      col: m.color.getHex(), em: m.emissive.getHex(), ei: m.emissiveIntensity,
      op: m.opacity, rim: T?.uRimStrength.value ?? 0,
    };
    m.color.copy(s.metal ? s.metal.color : m.color);
    m.emissive.setHex(0x000000);
    m.emissiveIntensity = 0;
    m.opacity = 1;
    if (T) T.uRimStrength.value = 0;    // the toon rim is tinted by the glow colour too
    m.needsUpdate = true;
  });
  dark = {
    head: await shoot('front-head-noglow', 'head', headDst, HEAD_FOV, 0),
    full: await shoot('front-full-noglow', 0.55, 11 * hs, 40, 0),
  };
  await p.evaluate(() => {
    const m = window.__subj.glow, T = m.userData.toon, sv = window.__glowSave;
    m.color.setHex(sv.col); m.emissive.setHex(sv.em); m.emissiveIntensity = sv.ei;
    m.opacity = sv.op;
    if (T) T.uRimStrength.value = sv.rim;
    m.needsUpdate = true;
  });
}

console.log(`\n--- can the eye be seen? (${defId})`);
if (!ENEMIES[defId].weakspot) {
  skip('weak-point legibility', `${defId} has no authored weakspot`);
} else {
  const head = shots['front-head'];
  const img = decodePng(fs.readFileSync(head.file));
  const rp = head.info.rpx;
  // Three rects of the same size, all of them on the machine: the eye, the plating 0.4 m below
  // it, and the chest 1.0 m below. Below rather than beside, because the drawn eye is half the
  // width of the head — there is no armour *beside* it to compare against.
  const side = Math.max(6, Math.round(rp * 0.9));
  const box = (im, [x, y], label) => rectStats(im, {
    x: Math.max(0, x - (side >> 1)), y: Math.max(0, y - (side >> 1)), w: side, h: side, label,
  });
  const eye = box(img, head.info.c, 'eye');
  const armour = box(img, head.info.armour, 'armour');
  const chest = box(img, head.info.chest, 'chest');
  for (const s of [eye, armour, chest]) console.log(`  ${s.label.padEnd(7)} ${JSON.stringify(s.rgb)} lum ${s.lum}`);

  const dEyeArmour = dist(eye.rgb, armour.rgb);
  const dEyeChest = dist(eye.rgb, chest.rgb);
  check('the eye separates from the armour below it', dEyeArmour >= 45,
    `${dEyeArmour} bytes (${JSON.stringify(eye.rgb)} vs ${JSON.stringify(armour.rgb)})`);
  check('and from the chest', dEyeChest >= 45, `${dEyeChest} bytes`);
  check('the eye is the brighter of the pair', eye.lum > armour.lum + 12,
    `lum ${eye.lum} vs ${armour.lum}`);

  // The control. An earlier version compared the armour rect against the chest rect and
  // demanded they agree — but the machine's own top-down lighting puts 79 bytes between two
  // patches of identical plating 1 m apart, so that control could never pass and never said
  // anything about the eye anyway. Switching the glow material off does: the eye rect has to
  // collapse onto the plating around it, and the plating rect has to stay where it was.
  if (!dark) {
    skip('the eye rect is the eye', 'the built model exposes no glow material');
    skip('and nothing else moved when the glow went out', 'ditto');
  } else {
    const dimg = decodePng(fs.readFileSync(dark.head.file));
    const eyeOff = box(dimg, dark.head.info.c, 'eye-noglow');
    const armourOff = box(dimg, dark.head.info.armour, 'armour-noglow');
    console.log(`  ${eyeOff.label} ${JSON.stringify(eyeOff.rgb)} lum ${eyeOff.lum}`);
    console.log(`  ${armourOff.label} ${JSON.stringify(armourOff.rgb)} lum ${armourOff.lum}`);
    const dOnOff = dist(eye.rgb, eyeOff.rgb);
    const dOffArmour = dist(eyeOff.rgb, armour.rgb);
    const dArmourMoved = dist(armour.rgb, armourOff.rgb);
    check('the eye rect is the eye', dOnOff >= 45 && dOffArmour < dOnOff,
      `glow on vs off ${dOnOff} bytes; off vs plating ${dOffArmour}`);
    check('and nothing else moved when the glow went out', dArmourMoved < 24,
      `plating moved ${dArmourMoved} bytes`);
  }

  // And at gameplay distance it must still be *there*. Not by matching the authored #ffb13b:
  // an emissive part comes out of the bloom and the tonemap much whiter than its albedo (the
  // eye measures [253,240,192] up close, 120 bytes from its own colour), so the test is the
  // property the player's eye actually uses — bright *and* warm — counted in the same box on
  // the same framing with the glow off, which is a control the *scene* cannot fake.
  const warmCount = (im, [px, py], rad = 30) => {
    let n = 0;
    for (let y = Math.max(0, py - rad); y < Math.min(im.height, py + rad); y++) {
      for (let x = Math.max(0, px - rad); x < Math.min(im.width, px + rad); x++) {
        const i = (y * im.width + x) * 4;
        if (im.data[i] > 170 && im.data[i] - im.data[i + 2] > 45) n++;
      }
    }
    return n;
  };
  const full = shots['front-full'];
  const fimg = decodePng(fs.readFileSync(full.file));
  const litEye = warmCount(fimg, full.info.c);
  const litChest = warmCount(fimg, full.info.chest);
  // 21 px of radius at this distance is a ~1400 px disc, and it measures 1919 with the halo,
  // so the floor is "at least half the disc is bright and warm". It was **9** while the spawn
  // pillar stood behind the head: bloom that wide desaturates everything it touches, and the
  // assertion was reporting the pillar's fault as the eye's.
  check('the eye is visible from 11 m away', litEye >= 700, `${litEye} bright warm pixels`);
  check('...and that count is the eye, not the lighting', litChest < litEye * 0.35,
    `${litChest} on the chest`);
  if (dark) {
    const dfull = decodePng(fs.readFileSync(dark.full.file));
    const offEye = warmCount(dfull, dark.full.info.c);
    check('...and it is the glow, not the sun', offEye < litEye * 0.2,
      `${offEye} with the glow off vs ${litEye} with it on`);
  } else skip('...and it is the glow, not the sun', 'no glow material to switch off');
}

// ---------------------------------------------------------------- arrivals --
//
// What put the light pillar in the first three runs of this probe: `S2C.ENEMY_SPAWN` played
// `vfx.teleport`, the fast-travel effect, for every enemy the server spawned — and the server
// spawns a whole camp the moment any player is within 110 m. So walking across Mondstadt lit
// 12 m cyan columns on the horizon for hilichurls that had been standing there all along.
// Both halves have to be checked: the distant camp must be silent, and an enemy arriving next
// to the player must still be visible, or "silent" is just a deleted feature.
console.log('\n--- does an arrival read as an arrival?');
const gate = await p.evaluate(() => {
  const g = window.game;
  const fake = (dx) => ({
    enemy: { id: 'probe', t: 'hilichurl', lv: 1, x: g.me.x + dx, y: g.me.y, z: g.me.z,
      ry: 0, hp: 100, mhp: 100, st: 'idle', a: 1 },
  });
  g.vfx.clear();
  g.socket.emit('enemySpawn', fake(6));
  const near = g.vfx.clear();
  g.socket.emit('enemySpawn', fake(90));
  const far = g.vfx.clear();
  return { near, far };
});
check('an enemy materialising six metres away gets an effect', gate.near > 0,
  `${gate.near} live effects`);
check('...and a camp streaming in ninety metres away does not', gate.far === 0,
  `${gate.far} live effects`);

// And it has to reach the screen, not just the pool: effect at the subject's feet, advanced to
// mid-life by hand because `g.stop()` froze the update loop.
//
// Its own before/after pair, from its own camera, rather than reusing `front-full`. The portrait
// framing is level with the subject (`camY` 0.10) 11 m out, and camps stand on slopes: one run
// of this file photographed a hillside with the wolf entirely behind the ridge, and an effect
// nothing could see read as "the arrival effect never reaches the screen". A ground-level effect
// needs a camera that can see the ground the subject stands on.
// Which way is clear is luck, so the frame has to prove its own subject before it is allowed to
// report on the effect. Lifting the camera out of the ground (see `shoot`) is not enough: the
// archer's camp is at the foot of a hill, and from the yaw the hill is on, a camera raised to
// ground level still looks at a slope with the subject behind it. So: hide the model, shoot the
// same frame, and count the pixels the model owns — the same test the stride section uses to pick
// a side — over four yaws, stopping at the first that clearly shows the creature. If none does,
// this is a SKIP with the reason, not a FAIL about an effect nobody could have seen.
let fx0 = null;
for (const dyaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
  const frame = [0.35, 9, 40, dyaw, 0.45];
  const tag = `spawn-clean${fx0 === null && dyaw === 0 ? '' : `-y${Math.round(dyaw * 57)}`}`;
  const lit = await shoot(tag, ...frame);
  await p.evaluate(() => { window.__subj.group.visible = false; });
  const hid = await shoot(`${tag}-hidden`, ...frame);
  await p.evaluate(() => { window.__subj.group.visible = true; });
  const body = diffMask(decodePng(fs.readFileSync(lit.file)),
    decodePng(fs.readFileSync(hid.file)), 12).count;
  console.log(`  yaw ${(dyaw * 57).toFixed(0)}°: ${body} px of creature in the arrival frame`);
  if (!fx0 || body > fx0.body) fx0 = { frame, lit, body };
  if (body > 3000) break;
}
const FX_FRAME = fx0.frame;
const before = fx0.lit;
const fx = fx0.body < 800 ? null : await p.evaluate(() => {
  const g = window.game, s = window.__subj;
  g.vfx.clear();
  g.vfx.spawnIn(s.group.position.x, s.group.position.y, s.group.position.z, 0xd8c8a8, 2.0, 1.2);
  for (let i = 0; i < 2; i++) g.vfx.update(0.08, g.camera);
  return true;
});
if (fx) {
  const after = await shoot('spawn-fx', ...FX_FRAME);
  const a = decodePng(fs.readFileSync(after.file));
  const bfr = decodePng(fs.readFileSync(before.file));
  const at = before.info.feet;
  const side = 120;   // the machine is ~314 px tall at this framing, so this is its lower third
  const rect = { x: Math.max(0, at[0] - (side >> 1)), y: Math.max(0, at[1] - (side >> 1)), w: side, h: side };
  const s1 = rectStats(bfr, { ...rect, label: 'feet' });
  const s2 = rectStats(a, { ...rect, label: 'feet+fx' });
  const moved = dist(s1.rgb, s2.rgb);
  console.log(`  feet ${JSON.stringify(s1.rgb)} -> ${JSON.stringify(s2.rgb)}`);
  check('the arrival effect reaches the screen', moved >= 8, `${moved} bytes at the feet`);
  // The far half of the same claim: a box 4.5 m above the effect — outside its 2 m radius for
  // every kind, unlike the head — must not change.
  const hb = { x: Math.max(0, before.info.high[0] - 30), y: Math.max(0, before.info.high[1] - 30), w: 60, h: 60, label: 'above' };
  const h1 = rectStats(bfr, hb);
  const h2 = rectStats(a, hb);
  const headMoved = dist(h1.rgb, h2.rgb);
  // The far half of it is only a control while the near half moved: "nothing changed 4.5 m up" is
  // also true of a frame where nothing changed anywhere, which is exactly the frame the archer
  // produced. Tying the bar to `moved` says the effect is *local*, and needs `moved` to be real.
  check('...and only where it was fired', moved >= 8 && headMoved < Math.max(6, moved * 0.6),
    `the box 4.5 m up moved ${headMoved} bytes, the feet ${moved}`);
} else {
  skip('the arrival effect reaches the screen',
    `no yaw shows the subject at the arrival framing (best ${fx0.body} px of creature) — it is on a slope`);
  skip('...and only where it was fired', 'the frame it would be measured in has no subject in it');
}

// The gait lives in `tools/boss-check.mjs` as numbers — foot slip per cycle, cadence,
// repeatability — all read off the rig with no renderer in the loop. This section is the part
// those numbers cannot cover: that the swing is actually *drawn*, and drawn in the legs. Both
// bugs this repo has had here would have passed a bone-space check and failed a picture:
// a clock frozen at sin(1) still poses a rig, and a leg that swings only in a bone the view
// never renders moves nothing on screen.
console.log('\n--- is the stride on screen?');
await p.evaluate(() => { window.game.vfx.clear(); window.game.overlay.clear?.(); });
/** Pin the gait clock (radians) and report how far the thighs actually moved in bone space. */
const pose = (gait) => p.evaluate((g) => {
  const s = window.__subj, a = s.actor;
  a.update(1 / 60, 300, { speed: window.__subjSpeed, attack: 0, gait: g, gaitOffset: 0, phase2: false });
  a.group.updateMatrixWorld(true);
  const b = a.view.bones || {};
  const th = ['thighL', 'thighR', 'fThighL', 'bThighL'].filter((n) => b[n]);
  return th.map((n) => +b[n].rotation.x.toFixed(4));
}, gait);
await p.evaluate((v) => { window.__subjSpeed = v; }, ENEMIES[defId].speed || 2);
/** The legs box for whatever camera `shoot` just set: ankles to hip, a metre either side. */
const legsBox = () => p.evaluate(() => {
  const g = window.game, s = window.__subj, cam = g.camera;
  const V = cam.position.constructor;
  const w = window.innerWidth, h = window.innerHeight;
  const toPx = (v) => { const q = v.clone().project(cam); return [(q.x * 0.5 + 0.5) * w, (-q.y * 0.5 + 0.5) * h]; };
  const right = new V().setFromMatrixColumn(cam.matrixWorld, 0).setY(0).normalize();
  const at = (dy, side) => toPx(s.group.position.clone()
    .setY(s.group.position.y + dy).add(right.clone().multiplyScalar(side)));
  const pts = [at(0.03, -1.0), at(0.03, 1.0), at(s.height * 0.5, -1.0), at(s.height * 0.5, 1.0)];
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const x = Math.round(Math.min(...xs)), y = Math.round(Math.min(...ys));
  return { x, y, w: Math.round(Math.max(...xs)) - x, h: Math.round(Math.max(...ys)) - y, label: 'legs' };
});
// Side on, so the swing is across the frame rather than towards the camera; `hf 0.3` aims low
// and `camY 0.45` looks *down* at the legs from 3.6 m up, because the level portrait angle puts
// the slope the camp stands on directly in front of the ankles. Which side is clear is luck, so
// both are tried and the silhouette decides: hide the creature, shoot the same frame, and count
// how many pixels inside the legs box are creature rather than hillside. A first version took
// the level shot from one fixed side and measured a hilichurl whose knees were behind a ridge —
// once at 20% of the box (its swinging arm) and once, on a later run, at 0.
const pA1 = await pose(Math.PI / 2);
let best = null;
for (const dyaw of [Math.PI / 2, -Math.PI / 2]) {
  const tag = dyaw > 0 ? 'l' : 'r';
  const frame = [0.3, 8, 40, dyaw, 0.45];
  const lit = await shoot(`stride-${tag}`, ...frame);
  const rect = await legsBox();
  await p.evaluate(() => { window.__subj.group.visible = false; });
  const hid = await shoot(`stride-${tag}-hidden`, ...frame);
  await p.evaluate(() => { window.__subj.group.visible = true; });
  const body = maskInRect(diffMask(decodePng(fs.readFileSync(lit.file)),
    decodePng(fs.readFileSync(hid.file)), 12), rect);
  console.log(`  side ${tag}: ${body} px of creature inside ${JSON.stringify(rect)}`);
  if (!best || body > best.body) best = { frame, rect, body, lit, hid };
}
const { frame: SIDE, rect: legRect } = best;
const sA1 = best.lit, sHid = best.hid;
// Same phase again, after the hide-and-restore: proves the restore put the frame back, and that
// the two `pose(π/2)` calls really are one pose.
const pA2 = await pose(Math.PI / 2);
const sA2 = await shoot('stride-a-again', ...SIDE);
const pB = await pose(Math.PI * 1.5);
const sB = await shoot('stride-b', ...SIDE);
const boneMove = Math.max(...pB.map((v, i) => Math.abs(v - pA1[i])), 0);
console.log(`  legs rect ${JSON.stringify(legRect)}; thighs ${JSON.stringify(pA1)} -> ${JSON.stringify(pB)}`);
// Whether this kind walks is read off the *authored* table, never off the measurement. The
// first version skipped when the thighs did not move — and a mutation that froze the hilichurl's
// thigh term to a constant turned the whole section into a SKIP and reported "0 failed". An
// escape hatch keyed on the thing under test cannot ever catch it.
const gfxSrc = fs.readFileSync(new URL('../client/src/gfx/enemies.js', import.meta.url), 'utf8');
const walkingKinds = new Set();
for (const m of gfxSrc.matchAll(/KINDS\.(\w+) = \{([\s\S]*?)\n\};/g)) {
  if (/\n  gait: GAIT\./.test(m[2])) walkingKinds.add(m[1]);
}
const kind = ENEMIES[defId].model.kind;
check('gfx/enemies.js still declares which kinds walk', walkingKinds.size >= 4,
  `${walkingKinds.size} kinds carry a GAIT entry: ${[...walkingKinds].join(', ')}`);
if (!walkingKinds.has(kind)) {
  skip('the stride is drawn', `'${kind}' has no GAIT entry — this kind does not walk`);
} else {
  // For a kind the table says walks, both halves are obligations, not conditions.
  check(`${kind} has thigh bones to swing`, pA1.length > 0, `${pA1.length} thigh bones`);
  check(`${kind}'s thighs move between opposite gait phases`, boneMove >= 0.05,
    `${boneMove.toFixed(3)} rad between π/2 and 3π/2`);
  const iA1 = decodePng(fs.readFileSync(sA1.file));
  const iA2 = decodePng(fs.readFileSync(sA2.file));
  const iB = decodePng(fs.readFileSync(sB.file));
  const iH = decodePng(fs.readFileSync(sHid.file));
  const inLegs = (a2, b2) => maskInRect(diffMask(a2, b2, 12), legRect);
  const same = inLegs(iA1, iA2);
  const swung = inLegs(iA1, iB);
  const body = inLegs(iA1, iH);          // subject pixels visible inside the legs box
  const area = Math.max(1, legRect.w * legRect.h);
  console.log(`  legs box ${area} px, ${body} px of creature in it:`
    + ` same phase ${same} px differ, opposite phase ${swung} px`);
  // The rect has to prove its subject before any reading off it means anything: a box of pure
  // hillside would give `same = 0` for free and could still show a swing (grass moves).
  check('the legs box is on the creature and not on the hillside', body > 900,
    `${body} px of silhouette inside a ${area} px box (${(100 * body / area).toFixed(1)}%)`);
  // The far side next: two screenshots of the *same* pinned phase must be the same picture,
  // hide-and-restore in between. Without this, "the legs moved" is equally true of a browser
  // that repainted the sky.
  check('a pinned gait phase draws the same frame twice', same < area * 0.01,
    `${same} px of ${area} differ between two shots of gait π/2`);
  // A fifth of the drawn creature in this box, redrawn. Measured against the silhouette rather
  // than the box, so a partly occluded subject raises the bar instead of lowering it.
  check('the stride is drawn — opposite phases redraw the legs', swung > Math.max(120, body * 0.2),
    `${swung} px moved of ${body} px of creature (${(100 * swung / Math.max(1, body)).toFixed(0)}%),`
    + ` thighs moved ${boneMove.toFixed(3)} rad`);
}

// ------------------------------------------------ the model, photographed alone --
//
// Every shot above is the model *in the world*: a hillside behind it, its own cast shadow under
// it, the camera tilted down to clear the slope. That is the right frame for "can the player see
// the eye" and the wrong one for "is this a wolf" — the frost wolf's rump, both haunches and its
// tail sat 34 cm behind its barrel for months, in front of every camera this repo owns, because
// the body sweep started forward of the hip joint they hang from. Nothing here caught it: the
// portraits frame the *head*, and the gait gates read bones, which were all exactly where the rig
// said they were.
//
// So: hide every scene child that is not this actor and not a light, fog off, clear colour black.
// What is left is the model against nothing. No terrain to occlude it, no shadow to bridge it,
// and — because the slope is gone — the camera can go back to level, which is the framing that
// shows a silhouette honestly. These four frames are the model sheet this repo never had; the
// wolf's flat-plank body and spear tail were both found by *looking* at them.
//
// The measured claims are deliberately modest. Connectivity is the interesting one, and it has now
// been tested from both sides:
//
//   * it *does* fail on a part that has come off. Lifting the hilichurl's head bone by 2.2 head
//     radii (47 cm, the same order as the wolf's gap) reads 80.6-87.0% in two components from all
//     four yaws — the bloom halo around a detached piece is nowhere near wide enough to bridge it.
//   * it does *not* catch every such bug. Restoring the wolf's broken sweep (`bodyZ` starting at
//     -0.10·bodyLen instead of -0.46) put the hindquarters back out behind the body and the
//     silhouette still came back 100% one piece, because a hind leg swung forward by the pinned
//     gait phase spanned the hole in projection. (That is also why the sheet is now shot at rest.)
//
// So a detached cluster reads as detached only if nothing else spans the hole. What this section
// promises is that the model is drawn, that it is drawn in one place, and that the pictures a human
// judges it by are the model and nothing else.
console.log('\n--- the model, photographed alone');
const iso = (on) => p.evaluate((on) => {
  const g = window.game, s = window.__subj;
  if (on) {
    const sv = { fog: g.scene.fog, vis: [] };
    for (const c of g.scene.children) {
      if (c === s.group || c.isLight || c.isCamera) continue;
      if (c.visible) { sv.vis.push(c); c.visible = false; }
    }
    g.scene.fog = null;
    g.r.renderer.setClearColor(0x000000, 1);
    window.__isoSave = sv;
    return sv.vis.length;
  }
  const sv = window.__isoSave;
  for (const c of sv.vis) c.visible = true;
  g.scene.fog = sv.fog;
  g.r.renderer.setClearColor(0x0a0a12, 1);
  return sv.vis.length;
}, on);
/** Brightest pixel and how many clear the threshold — what the *control* frame has to answer. */
function lumStats(img, thr = 26) {
  const { data } = img;
  let count = 0, max = 0;
  for (let px = 0; px < data.length; px += 4) {
    const l = 0.2126 * data[px] + 0.7152 * data[px + 1] + 0.0722 * data[px + 2];
    if (l > thr) count++;
    if (l > max) max = l;
  }
  return { count, max: Math.round(max) };
}
// Standing, not mid-stride. The stride section above leaves the rig pinned at gait π/2, which for
// the wolf is full extension — thighs at 1.15 rad — and the bone map showed exactly what that
// does to a model sheet: the front leg swings back and the hind leg swings forward until both
// pairs stand under the middle of the body and the animal looks two-legged. The gait amplitude
// scales with `run = speed / GAIT.top`, so speed 0 is the rest pose every part was authored in.
await p.evaluate(() => { window.__subjSpeed = 0; });
await pose(0);
const hidden = await iso(true);
/**
 * What is lighting the isolation sheet, printed before a single blob is measured.
 *
 * Two runs of this file an hour apart photographed the same model at mean luminance 133 and 92 —
 * a 45 % swing on frames whose camera, pose and pixel counts are otherwise identical to a few
 * pixels — and the bright one tripped "no single white patch is a feature of the model" (1291 px
 * against a 2 % bar) while the dark one read 152 px. A washed-out patch cannot be read as a fact
 * about the *model* until the light it is under is a known quantity, so every term the sheet's
 * thresholds depend on is dumped here: pinning noon (`setWorldTime(12)`) is not by itself a claim
 * that the sun arrived, and neither is `quality high`.
 */
const isoLight = await p.evaluate(() => {
  const g = window.game, sk = g.world?.sky;
  const l = { quality: g.quality, auto: !!g.settings?.autoQuality, timePin: g.settings?.worldTime };
  if (sk) {
    l.sun = +(sk.sun?.intensity ?? -1).toFixed(3);
    l.sunShadow = !!sk.sun?.castShadow;
    l.shadowMap = sk.sun?.shadow?.mapSize?.x ?? 0;
    l.hemi = +(sk.hemi?.intensity ?? -1).toFixed(3);
    l.fill = +(sk.fill?.intensity ?? -1).toFixed(3);
    l.cloud = +(sk.uniforms?.uCloudiness?.value ?? -1).toFixed(3);
    l.storm = +(sk.uniforms?.uStorm?.value ?? -1).toFixed(3);
    l.stormDim = +(sk.stormDim ?? -1).toFixed(3);
    const d = sk.lightDir;
    if (d) l.lightDir = [+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)];
    const sp = sk.sun?.position;
    if (sp) l.sunPos = [Math.round(sp.x), Math.round(sp.y), Math.round(sp.z)];
  }
  l.weather = g.weather ? { type: g.weather.type, cloudiness: g.weather.cloudiness } : null;
  l.ry = +(window.__subj.group.rotation.y).toFixed(3);
  return l;
});
console.log('  iso light', JSON.stringify(isoLight));
// The pin has to still be there when the shutter opens, not just when it was set: the AI owns this
// actor's rotation for the whole run and the sheet happens a minute after `pinYaw` was written.
if (pinYaw !== null) {
  check('the subject is still facing where the sheet pinned it', Math.abs(isoLight.ry - pinYaw) < 0.01,
    `pinned ${pinYaw}, ry ${isoLight.ry}`);
}
// Level camera, aimed at half height, stood off far enough that the *longest* axis fits: a
// quadruped is twice as long as it is tall, so framing on height alone crops the tail off.
const isoDst = Math.max(3.4, subject.height * 3.2);
// The last `false` turns the terrain lift off: nothing but the model is drawn here, so the
// camera can be level even when it is technically inside a hill.
const isoFrame = (dyaw) => [0.5, isoDst, 40, dyaw, 0.10, false];
// The control the whole section rests on: with the subject hidden *too*, an isolation frame has
// to be essentially empty. If it is not, something in the world is still drawing and every blob
// measured below could be that instead of the model.
await p.evaluate(() => { window.__subj.group.visible = false; });
const isoEmptyImg = decodePng(fs.readFileSync((await shoot('iso-empty', ...isoFrame(0))).file));
const isoEmpty = lumStats(isoEmptyImg);
await p.evaluate(() => { window.__subj.group.visible = true; });
check('the isolation render leaves nothing in the frame but the model',
  isoEmpty.count < 2000,
  `${hidden} scene children hidden, ${isoEmpty.count} px still lit, brightest ${isoEmpty.max}`);
/**
 * The subject's pixels: every pixel that *changed* when the model was hidden.
 *
 * This started out as "pixels brighter than the black clear colour", threshold 26, and that mask
 * cannot tell a dark material from the void. The pyro hilichurl's crimson skirt is rgb 60,16,24 in
 * shadow — luminance 25.9 — so the front frame lost the half of the skirt that bridges hips to
 * legs, and the gate reported 92.8% in two components with the whole right leg as the second one.
 * Nothing was wrong with the model. Meanwhile the background it was being told apart from is
 * luminance 3-5, so there was never a shortage of contrast, only the wrong question: a *difference*
 * against the empty frame is 57 bytes of red on that same skirt pixel.
 *
 * `diffMask` was rejected for this job once already, and for a reason that does not apply here:
 * against a world frame, hiding the model also removes its cast shadow, so the mask grows a ground
 * blob that bridges everything. In isolation there is no ground to receive a shadow — the empty
 * frame is the post-processed clear colour and nothing else — which is exactly what makes the
 * subtraction clean. Tolerance is 16 rather than 8 so that the bloom halo around a glowing part
 * stays out of the mask; a halo joins components for free and would quietly weaken connectivity.
 */
const subjMask = (im) => diffMask(im, isoEmptyImg, 16);
/**
 * Where the rig's bones land in the frame just shot. A silhouette says "two legs are visible";
 * only the bone map says whether that is one pair or two — the frost wolf's front pair looked
 * like it was standing beside the hind pair, and the arithmetic off `place()` said otherwise.
 */
// Every bone the rig has, in declaration order — not a hand-written list. The list used to be the
// wolf's thirteen names, which meant the map printed *nothing at all* for the three slimes and the
// two abyss kinds (their rigs share not one name with a quadruped), and a debugging aid that is
// silent on five of ten kinds is a debugging aid for one model.
const bonePx = () => p.evaluate(() => {
  const g = window.game, s = window.__subj, cam = g.camera;
  const b = s.actor.view.bones || {};
  const w = window.innerWidth, h = window.innerHeight;
  const out = {};
  for (const n of Object.keys(b)) {
    const e = b[n].matrixWorld.elements;
    const q = new cam.position.constructor(e[12], e[13], e[14]).project(cam);
    out[n] = [Math.round((q.x * 0.5 + 0.5) * w), Math.round((-q.y * 0.5 + 0.5) * h)];
  }
  return out;
});
// "Washed" means one thing in this file, and both sides of the argument below use the same number:
// a pixel whose channels agree to within this fraction of its own brightest channel has no hue
// left. The wash gate says no *large patch* of the model may be that; the highlight gate says the
// brightest thing the hide can draw must *not* be that. One constant, so neither can drift.
const WASH_SPREAD = 0.14;
/** How far apart a colour's channels are, as a fraction of its brightest one. 0 = neutral grey. */
const spreadOf = ([r, g, b]) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx > 0 ? (mx - mn) / mx : 0;
};
/**
 * The washed-out pixels of one frame, inside a mask: near-white *and* out of hue. One function, so
 * the wash gate below and the highlight-colour argument after it cannot drift apart — the second
 * one is only interesting because it is asked in the first one's units.
 */
function washMaskOf(im, sil) {
  let count = 0;
  const mask = new Uint8Array(sil.width * sil.height);
  for (let i = 0, px = 0; px < im.data.length; px += 4, i++) {
    if (!sil.mask[i]) continue;
    const mn = Math.min(im.data[px], im.data[px + 1], im.data[px + 2]);
    const mx = Math.max(im.data[px], im.data[px + 1], im.data[px + 2]);
    if (mn >= 200 && mx - mn <= WASH_SPREAD * mx) { mask[i] = 1; count++; }
  }
  return { mask, count, width: sil.width, height: sil.height };
}
/** Mean sRGB colour of an image over a mask. */
function meanOver(im, mask) {
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0, px = 0; px < im.data.length; px += 4, i++) {
    if (!mask[i]) continue;
    R += im.data[px]; G += im.data[px + 1]; B += im.data[px + 2]; n++;
  }
  return n ? [R / n, G / n, B / n].map((v) => Math.round(v)) : [0, 0, 0];
}
let least = Infinity, worst = { frac: 1, kept: 1, tag: '-' };
let worstWash = { frac: 0, px: 0, tag: '-' };
let worstBlob = { frac: 0, px: 0, tag: '-' };
let worstFlat = { frac: 0, px: 0, lum: 0, box: null, tag: '-' };
/**
 * Eight yaws, not four — and the subject's own facing pinned (see `pinYaw` at the top).
 *
 * Whether a facet blows out to white depends on the half-vector between the sun and the *camera*,
 * so the sheet's yaws are the axis that decides whether a specular defect is in the photograph at
 * all. With four of them and the guard's facing left to its own AI (it turned 3.3 rad between two
 * runs), the clipped forearm this gate is calibrated to catch walked in and out of the suite by
 * itself: 152 px on one run, 1291 px and a red on the next, from the same build. Doubling the yaws
 * to 45° steps and pinning the facing makes the worst case a property of the model instead of a
 * property of the hour, which is the only way "the worst of N yaws" means anything.
 */
const ISO_YAWS = [['front', 0], ['quarter', 0.9], ['side', Math.PI / 2],
  ['side-back', Math.PI * 0.75], ['back', Math.PI], ['back-far', -Math.PI * 0.75],
  ['side-far', -Math.PI / 2], ['quarter-far', -0.9]];
for (const [tag, dyaw] of ISO_YAWS) {
  const im = decodePng(fs.readFileSync((await shoot(`iso-${tag}`, ...isoFrame(dyaw))).file));
  if (tag === 'side') {
    const bm = await bonePx();
    const ent = Object.entries(bm).map(([k, v]) => `${k} ${v[0]},${v[1]}`);
    for (let i = 0; i < ent.length; i += 7) console.log('  bones ' + ent.slice(i, i + 7).join('  '));
  }
  const all = subjMask(im);
  // How much of the silhouette has no colour and no shading left: within 55 bytes of the ceiling
  // in every channel *and* with the channels within 12 of each other, i.e. a pixel that is only
  // "white". A shape made of those pixels has no form — the storm tyrant's six crest quills are
  // `glow` at emissive 1.5 with a near-white authored hex (`0xb9ffe8`), and from behind they are a
  // solid white starburst with a bloom halo that swallows the whole head. Measured on the *mask*,
  // so the halo outside the model is not counted and a small model cannot be flattered by having
  // more background; measured in isolation, because in the world a washed part can hide behind a
  // legitimately bright sky.
  //
  // The channel condition is *relative* (`mx - mn ≤ 0.14·mx`), and it used to be the absolute
  // `≤ 12`. The absolute form asked for a neutral pixel, which was deliberate — "bright but still
  // coloured" is legitimate — and it cost the gate every *cream* blowout: the fire slime's crest
  // was a featureless pale-orange blade at 0.0 %, and the abyss herald's four hem hoops came out
  // at (216, 241, 243), which is 27 counts of spread and reads as white to anyone looking at it.
  // At 0.14 that pixel is washed and a saturated highlight still is not (see the calibration on
  // the two assertions below).
  const { mask: wm, count: wash } = washMaskOf(im, all);
  const washFrac = wash / Math.max(1, all.count);
  // …and the *largest connected* washed patch, because the two failure modes are not the same
  // question. Scattered sparkle over a wet or icy hide is legitimate however much of it there is;
  // one white *feature* — a hoop, a pauldron, an orb — is a defect however small the total. A
  // boss is big enough for a solid white slab to be 2 % of its silhouette and pass on the total.
  const blob = wash
    ? largestBlob({ mask: wm, count: wash, width: all.width, height: all.height }, 0.999).count : 0;
  const blobFrac = blob / Math.max(1, all.count);
  if (washFrac > worstWash.frac) worstWash = { frac: washFrac, px: wash, tag };
  if (blobFrac > worstBlob.frac) worstBlob = { frac: blobFrac, px: blob, tag };
  // The other half of the same defect: not "blown out to white" but "one value across a hand-sized
  // face". See `flatPatch` — the biggest single-luminance patch of the silhouette.
  const flat = flatPatch(im, all, 6);
  if (flat.frac > worstFlat.frac) worstFlat = { ...flat, px: flat.count, tag };
  // Connectivity is asked of the mask *closed by 2 px* (`dilateMask` explains why: the ruin
  // guard's collar and skull touch without sharing a pixel from directly behind). The "is it
  // drawn" count below stays on the raw mask.
  const grown = dilateMask(all, 2);
  // `minFrac 0.999` keeps only components within a hair of the biggest, i.e. exactly the largest.
  const main = largestBlob(grown, 0.999);
  const parts = largestBlob(grown, 0.02);
  const frac = main.count / Math.max(1, grown.count);
  const box = parts.box || { w: 0, h: 0 };
  console.log(`  iso-${tag.padEnd(7)} ${String(all.count).padStart(6)} px of model,`
    + ` box ${box.w}x${box.h}, largest piece ${(100 * frac).toFixed(1)}%,`
    + ` ${parts.blobs} components, ${parts.kept} over 2%,`
    + ` washed out ${(100 * washFrac).toFixed(1)}% (biggest patch ${blob} px,`
    + ` ${(100 * blobFrac).toFixed(2)}%),`
    + ` flattest patch ${flat.count} px (${(100 * flat.frac).toFixed(2)}%,`
    + ` lum ${flat.lum}, ${flat.box ? `${flat.box.w}x${flat.box.h}` : '-'})`);
  least = Math.min(least, all.count);
  if (frac <= worst.frac) worst = { frac, kept: parts.kept, tag };
}
// The model has to be *in* all four frames — a stand-off computed off `height` can put a long
// creature outside a 40° cone, and then every reading above is a reading of the tail.
check('the model is drawn in every isolation frame', least > 3000, `${least} px in the emptiest`);
// One piece, worst of the four yaws. Specks under 2% are antialiasing and authored floating
// detail (a glow mote on the frost wolf's spikes); two big pieces are a rig that came apart.
// The bar is 0.97 because with hairlines closed there is nothing between "whole" and "broken":
// forty frames across all ten open-world kinds read 100.0%, and a detached head reads 80.6%.
// A kind whose design really does float something away from the body (an orbiting shield) will
// fail here, and that is a triage, not a false alarm — the numbers are in the message.
check('the model is one connected piece from every yaw', worst.frac >= 0.97 && worst.kept <= 2,
  `worst yaw ${worst.tag}: largest piece ${(100 * worst.frac).toFixed(1)}%,`
  + ` ${worst.kept} components over 2% of it`);
// Both bars are calibrated on one sweep of all twelve kinds through this tool (`/tmp/s23-*.log`,
// four yaws each), recomputed offline against the frames of every defect this gate has caught.
// The two columns are worst-yaw *fraction of the silhouette* and worst-yaw *largest connected
// patch*, and they separate cleanly:
//
//   fixed build   wolf 1.4 / 0.43   slimes 0.8 / 0.83   pyro 0.8 / 0.78   guard 0.3 / 0.29
//                 tyrant 0.4 / 0.09   herald 0.0 / 0.02   mage 0.0 / 0.00   vishap 0.0 / 0.00
//   the defects   wolf 42.7 / 39.4   electro slime 10.4 / 9.14   herald 10.5 / 3.24
//                 fire slime 7.6 / 7.07   mage 4.7 / 1.75
//
// So 4 % of the silhouette (2.9× the worst legitimate reading, under the smallest defect) and
// 1.2 % in one patch (1.4× the slime's specular droplet, under the mage's white hand orb). The
// slime sets the headroom on both: its crown droplet and nucleus are wet highlights and are
// *supposed* to be white. A kind that genuinely wants a big white feature will fail here and the
// numbers are in the message; that is a triage, not a false alarm.
check('no part of the model is washed out to featureless white', worstWash.frac <= 0.04,
  `worst yaw ${worstWash.tag}: ${worstWash.px} px of the silhouette`
  + ` (${(100 * worstWash.frac).toFixed(1)}%) is near-white with no hue left`);
check('...and no single white patch is a feature of the model', worstBlob.frac <= 0.012,
  `worst yaw ${worstBlob.tag}: the biggest connected washed patch is ${worstBlob.px} px`
  + ` (${(100 * worstBlob.frac).toFixed(2)}% of the silhouette)`);

/**
 * The obligation the two assertions above create, and the reason they cannot be paid by deletion.
 *
 * "No washed-out patch" is a bar that a *missing* highlight passes perfectly, and that is not a
 * hypothetical: the first draft of the fix these assertions asked for (`hideSpec` in
 * `client/src/gfx/enemies.js`) also raised `uSpecStep` with the hide's luminance, which improved
 * every wash reading on the sheet by leaving 14 px of highlight on the entire animal. This section
 * is what caught it, and it is why the shipped fix changes the highlight's *colour* only.
 *
 * `uSpecStep` is the removable suspect (the trick the glow control uses two hundred lines up):
 * `spec` is a clamped cosine power, so pushing the step past 1.0 deletes the highlight without
 * touching albedo, ramp, rim or geometry, and pulling it below 0 floods every lit facet with it.
 * Four frames at one yaw, and each one answers a different question:
 *
 *   1. the same frame twice, nothing changed — the noise floor. Two shots of a creature are never
 *      bit-identical (the elemental aura pulses on `uTime`), so without this number "12 px moved"
 *      means nothing.
 *   2. `uSpecStep = 1.01` — the term is *present*: pixels move, and they are brighter with it on.
 *      This is deliberately not a size bar. A rough hide at a 4° lobe legitimately puts a few dozen
 *      pixels of sparkle on a 50 000 px silhouette (the wolf reads 10-42 px depending on yaw); what
 *      cannot be legitimate is *zero*.
 *   3. `uSpecStep = -1.0` — every lit facet takes the full mix, which turns a few dozen pixels into
 *      a few thousand and makes the *colour* of `uSpecColor` measurable rather than inferred. That
 *      colour has to clear the same `WASH_SPREAD` the wash mask rejects patches for.
 *   4. the flood again with `uSpecColor` forced to white — the mutation, run in the page so it needs
 *      no rebuild. If the flooded hue does not collapse when the highlight is painted white, the
 *      measurement in (3) was not reading `uSpecColor` at all.
 *
 * The yaw is chosen by trying the worst washed one first and falling back through a fixed list
 * until one shows the term, so the choice never depends on the hour; only the presence pair is
 * repeated per yaw.
 */
const HI_MIN_PX = 8;
const hideKeys = ['body', 'body2', 'dark', 'bone', 'accent', 'thin'];
const specOrder = [...new Set([worstBlob.tag, worstWash.tag, 'quarter', 'front', 'side', 'back'])]
  .filter((t) => ISO_YAWS.some(([x]) => x === t));
/** Set `uSpecStep` on every hide material of the subject, remembering the values it replaced. */
const specStep = (v) => p.evaluate(([keys, val]) => {
  const mats = window.__subj.actor.view.materials || {};
  window.__specSave = [];
  for (const k of keys) {
    const T = mats[k]?.userData?.toon;
    if (!T || !T.uSpecStep) continue;
    window.__specSave.push([k, T.uSpecStep.value]);
    T.uSpecStep.value = val;
  }
  return window.__specSave.map(([k, x]) => `${k} ${x.toFixed(2)}`).join(' ');
}, [hideKeys, v]);
const specRestore = () => p.evaluate((keys) => {
  const mats = window.__subj.actor.view.materials || {};
  for (const [k, v] of window.__specSave || []) {
    const T = mats[k]?.userData?.toon;
    if (T && T.uSpecStep) T.uSpecStep.value = v;
  }
}, hideKeys);
const lumOfRgb = (c) => Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
let hi = null;
for (const tag of specOrder) {
  const dyaw = ISO_YAWS.find(([t]) => t === tag)[1];
  const onImg = decodePng(fs.readFileSync((await shoot(`iso-spec-${tag}`, ...isoFrame(dyaw))).file));
  const steps = await specStep(1.01);
  const offImg = decodePng(fs.readFileSync((await shoot(`iso-nospec-${tag}`, ...isoFrame(dyaw))).file));
  await specRestore();
  // Tolerance 25, not 8: the elemental aura pulses with `uTime`, so two frames of the same pose
  // are never bit-identical on a creature, and a highlight worth arguing about is worth 25 counts.
  const moved = diffMask(onImg, offImg, 25);
  const on = moved.count ? meanOver(onImg, moved.mask) : [0, 0, 0];
  const noSpec = moved.count ? meanOver(offImg, moved.mask) : [0, 0, 0];
  console.log(`  spec A/B ${tag.padEnd(11)} uSpecStep ${steps} -> 1.01,`
    + ` ${moved.count} px moved: ${on.join(',')} (lum ${lumOfRgb(on)})`
    + ` vs ${noSpec.join(',')} (lum ${lumOfRgb(noSpec)}) with the highlight off`);
  if (!hi || moved.count > hi.px) {
    hi = { px: moved.count, tag, dyaw, lum: lumOfRgb(on), lumOff: lumOfRgb(noSpec) };
  }
  if (moved.count >= HI_MIN_PX) break;
}
// The floor for the number above, at the same yaw: the same frame twice, nothing touched.
const floorImgA = decodePng(fs.readFileSync((await shoot(`iso-spec-${hi.tag}`, ...isoFrame(hi.dyaw))).file));
const floorImgB = decodePng(fs.readFileSync((await shoot(`iso-spec-${hi.tag}-again`, ...isoFrame(hi.dyaw))).file));
const specFloor = diffMask(floorImgA, floorImgB, 25).count;
check('two shots of the same isolation frame agree, so a moved pixel is the uniform',
  specFloor * 3 < hi.px, `${specFloor} px of floor against ${hi.px} px moved by uSpecStep`);
check('the stepped specular reaches the screen at all', hi.px >= HI_MIN_PX,
  `best of ${specOrder.length} yaws tried: ${hi.px} px changed when uSpecStep went past 1.0`
  + ` (yaw ${hi.tag}, ${HI_MIN_PX} px needed)`);
check('...and it is brighter than the surface under it', hi.lum > hi.lumOff + 6,
  `lum ${hi.lum} with the highlight, ${hi.lumOff} without it`);
// The pair to the wash gate. Flood the highlight over every lit facet and ask what colour the
// result is: with the authored `uSpecColor` the model keeps its hue, and with a white one the same
// flood drains it. Two readings are printed for each flood — the channel spread of the repainted
// pixels, and the wash fraction in the same units as the gate above — because the first draft
// compared a diluted mean against the WASH_SPREAD bar (13.4 % against 14 %, red on a healthy build)
// and the second used the wash fraction with an absolute floor, which only holds for a pale hide.
const silHi = subjMask(floorImgA);
const flood = async (label, white) => {
  const restore = white ? await p.evaluate((keys) => {
    const mats = window.__subj.actor.view.materials || {};
    window.__specColSave = [];
    for (const k of keys) {
      const T = mats[k]?.userData?.toon;
      if (!T || !T.uSpecColor) continue;
      window.__specColSave.push([k, T.uSpecColor.value.getHex()]);
      T.uSpecColor.value.setHex(0xffffff);
    }
    return window.__specColSave.map(([k, v]) => `${k} #${v.toString(16).padStart(6, '0')}`).join(' ');
  }, hideKeys) : null;
  await specStep(-1.0);
  const img = decodePng(fs.readFileSync((await shoot(`iso-${label}-${hi.tag}`, ...isoFrame(hi.dyaw))).file));
  await specRestore();
  if (white) {
    await p.evaluate((keys) => {
      const mats = window.__subj.actor.view.materials || {};
      for (const [k, v] of window.__specColSave || []) {
        const T = mats[k]?.userData?.toon;
        if (T && T.uSpecColor) T.uSpecColor.value.setHex(v);
      }
    }, hideKeys);
  }
  const m = diffMask(img, floorImgA, 25);
  const mean = m.count ? meanOver(img, m.mask) : [0, 0, 0];
  const wash = washMaskOf(img, silHi).count / Math.max(1, silHi.count);
  console.log(`  spec flood ${label.padEnd(9)} ${m.count} px flooded, mean ${mean.join(',')},`
    + ` spread ${(100 * spreadOf(mean)).toFixed(1)}%, washes`
    + ` ${(100 * wash).toFixed(1)}% of the silhouette${restore ? ` (was ${restore})` : ''}`);
  return { px: m.count, mean, wash, spread: spreadOf(mean), img };
};
const wide = await flood('specwide', false);
const paper = await flood('specwhite', true);
check('flooding the highlight repaints a measurable part of the model',
  wide.px > 400, `${wide.px} px changed when uSpecStep went to -1.0`);
check('...and the model survives it with its hue', wide.wash < 0.15,
  `the highlight over every lit facet leaves ${(100 * wide.wash).toFixed(1)}% of the silhouette`
  + ' washed out (the shipped step leaves ' + (100 * worstWash.frac).toFixed(1) + '% at worst)');
// The mutation, stated as a *ratio* and read only over the pixels the flood actually reached.
//
// Two earlier drafts of this one assertion were wrong in opposite directions. "Painting the
// highlight white washes at least a quarter of the model" is true of the frost wolf (67.6 %) and
// false of the hilichurl (12.1 %): a hide dark enough that a full white highlight still lands under
// the wash mask's own 200 floor fails a bar that has nothing to do with it. Comparing the channel
// spread of *every changed pixel* fixes the scale but dilutes the reading with everything else that
// moved — on the storm tyrant the pulsing aura and the glow crest are half the mask, and their hue
// is in both frames, which took a real 5.5× separation down to 2.06× against a 2× bar.
// So the mask is "pixels the white flood raised by 40 counts of luminance or more", i.e. surfaces
// the spec term demonstrably repaints. Measured over the twelve kinds that selection reads
// 3.5×-15× — except the ruin guard (2.5×), which is not noise but arithmetic: `hideSpec` returns
// the hide's own hue at full value, and a warm grey machine's own hue *is* nearly white
// (0x6b6a62 -> 0xfffdf1). That is what the pair of uniform checks below is for; a kind whose hides
// have no hue to lose skips the pixel mutation and is held by them instead.
const FLOOD_GAIN = 40;
/** Pixels `ref` raised by FLOOD_GAIN counts of luminance or more over `base`. */
const floodLit = (base, ref) => {
  const mask = new Uint8Array(base.width * base.height);
  let count = 0;
  for (let i = 0, px = 0; px < base.data.length; px += 4, i++) {
    const g = lumOfRgb([ref.data[px], ref.data[px + 1], ref.data[px + 2]])
      - lumOfRgb([base.data[px], base.data[px + 1], base.data[px + 2]]);
    if (g >= FLOOD_GAIN) { mask[i] = 1; count++; }
  }
  return { mask, count, width: base.width, height: base.height };
};
// `paper` is the flood that decides which pixels count, and *both* readings are taken over that one
// set: the surfaces a white highlight repaints are the surfaces a coloured one has to colour.
const lit = floodLit(floorImgA, paper.img);
const hueSel = {
  px: lit.count,
  wide: lit.count ? spreadOf(meanOver(wide.img, lit.mask)) : 0,
  paper: lit.count ? spreadOf(meanOver(paper.img, lit.mask)) : 0,
};
console.log(`  spec hue over the ${hueSel.px} px the white flood raised by ${FLOOD_GAIN}+ lum:`
  + ` ${(100 * hueSel.wide).toFixed(1)}% spread authored vs ${(100 * hueSel.paper).toFixed(1)}% white`);
// The uniform-level promise, which holds for every kind including the grey ones: `hideSpec` scales
// the hide's albedo up until its brightest channel clips and then mixes 0.34 toward white, and both
// of those are hue-preserving, so the highlight's channel spread is exactly 0.66x the albedo's.
// A deleted `specColor` (white, the old shared default) reads 0, and any hue not taken from the
// hide reads a different number. The tolerance is 1.5 points of spread, ~4 counts out of 255.
// Both spreads are read in *sRGB bytes* (`getHex`), the space `hideSpec` does its arithmetic in.
// `THREE.Color` stores linear components, and the 0.66 relationship is not preserved by that
// transfer function — reading `toArray()` here would compare two different colour spaces.
const specHues = await p.evaluate((keys) => {
  const mats = window.__subj.actor.view.materials || {};
  const out = [];
  const spread = (hex) => {
    const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
    const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    return mx > 0 ? (mx - mn) / mx : 0;
  };
  for (const k of keys) {
    const m = mats[k];
    const T = m?.userData?.toon;
    if (!m || !T || !T.uSpecColor) continue;
    const hex = T.uSpecColor.value.getHex();
    out.push({ key: k, albedo: spread(m.color.getHex()), spec: spread(hex), hex });
  }
  return out;
}, hideKeys);
const hueWorst = specHues.reduce((w, s) => {
  const err = Math.abs(s.spec - s.albedo * 0.66);
  return !w || err > w.err ? { ...s, err } : w;
}, null);
const hueBest = specHues.reduce((b, s) => (!b || s.spec > b.spec ? s : b), null);
check('every hide highlight is its own hide colour, brightened',
  hueWorst && hueWorst.err <= 0.015,
  hueWorst ? `worst of ${specHues.length} hide materials: ${hueWorst.key} highlight`
    + ` #${hueWorst.hex.toString(16).padStart(6, '0')} at ${(100 * hueWorst.spec).toFixed(1)}% spread`
    + ` against ${(100 * hueWorst.albedo * 0.66).toFixed(1)}% expected from its albedo`
    + ` (${(100 * hueWorst.albedo).toFixed(1)}% x 0.66)`
    : 'no hide material carries a uSpecColor uniform');
// ...and the same reading, taken while the mutation is applied, must break it. This is the half
// that makes the check above impossible to satisfy with the shared white default, and it needs no
// photograph, so it covers the kinds that skip the pixel mutation below.
const paintedHue = await p.evaluate((keys) => {
  const mats = window.__subj.actor.view.materials || {};
  const spread = (hex) => {
    const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
    const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    return mx > 0 ? (mx - mn) / mx : 0;
  };
  let worst = 0;
  const saved = [];
  for (const k of keys) {
    const T = mats[k]?.userData?.toon;
    if (!T || !T.uSpecColor) continue;
    saved.push([k, T.uSpecColor.value.getHex()]);
    T.uSpecColor.value.setHex(0xffffff);
    worst = Math.max(worst, spread(T.uSpecColor.value.getHex()));
  }
  for (const [k, v] of saved) mats[k].userData.toon.uSpecColor.value.setHex(v);
  return worst;
}, hideKeys);
check('...and painting them white breaks that, so the check above is not free',
  hueBest && paintedHue < hueBest.spec - 0.015,
  hueBest ? `the most hued hide (${hueBest.key}, ${(100 * hueBest.spec).toFixed(1)}% spread)`
    + ` reads ${(100 * paintedHue).toFixed(1)}% painted white`
    : 'no hide material carries a uSpecColor uniform');
// Which hide decides whether the photograph *can* show a hue: `body`, because every builder derives
// `body2` and `dark` from the same `model.color` and paints most of the animal with them, while
// `accent`/`bone` are trim. The ruin guard is the case that forces the distinction — its accent is a
// saturated amber (50.6 % spread) on a few plates, its body is warm grey (5.5 %), and the flood
// reads 6.8 % against 2.6 % painted white: a 2.6x separation that would sit 4 % over a 2.5x bar.
// There is no hue on that machine's hull to lose, so it is the uniform pair above that holds it.
const hueDom = specHues.find((s) => s.key === 'body') || hueBest;
if (!hueDom || hueDom.spec < 0.10) {
  skip('...and the flooded pixels keep that hue on screen',
    `this kind's main hide is near-neutral (body highlight`
    + ` ${(100 * (hueDom?.spec ?? 0)).toFixed(1)}% spread), so hideSpec returns a near-white`
    + ' highlight by construction and there is no hue for the flood to show — the two uniform'
    + ` checks above are the gate here (the flood reads ${(100 * hueSel.wide).toFixed(1)}% against`
    + ` ${(100 * hueSel.paper).toFixed(1)}% painted white)`);
} else {
  check('...and the flooded pixels keep that hue on screen',
    hueSel.px > 400 && hueSel.wide > hueSel.paper * 2.5,
    `over the ${hueSel.px} px the white flood repaints, the authored highlight leaves`
    + ` ${(100 * hueSel.wide).toFixed(1)}% channel spread against ${(100 * hueSel.paper).toFixed(1)}%`
    + ` painted white (whole-mask readings ${(100 * wide.spread).toFixed(1)}% vs`
    + ` ${(100 * paper.spread).toFixed(1)}%; washed ${(100 * wide.wash).toFixed(1)}% vs`
    + ` ${(100 * paper.wash).toFixed(1)}% of the silhouette)`);
}
await iso(false);

// ---------------------------------------------------------------- particles --
//
// Found while looking at the arrival effect: 20 sparks 11 m away rendered as one white mass
// 180 px across, because `gl_PointSize` was `aSize * uScale / distance` with `aSize` in the
// 16..34 range and `uScale` ≈ 960 — tens of thousands of pixels, so every particle in the
// game sat on the 90 px ceiling and none of them shrank with distance. Two identical sparks
// at 4 m and 16 m are the test: they must differ by roughly the square of the distance ratio.
//
// **Shot against black, not against the world.** Everything this section used to be — a derived
// lens tilt, a free yaw, an eye lifted out of the ground, a 4×4×8 framing search scored by the
// lowest clearance anywhere along the segment camera→point, and a SKIP when the search came up
// short — existed to fight one confound: the *scene behind the spark*. It never won. What was
// left was a gate the README had to carry as known-flaky (8-30× on a claim whose theoretical
// value is 15.5×): the abyss mage exhausted the search, climbed to 30 m where every line of
// sight is sky, and read 36.7× — because an additive sprite over the bright Mondstadt sky is
// tone-mapped until its soft edge is gone, so the *far* blob (57 px, radius 4 px) collapsed
// while the near one did not. Framing was never the variable to pin; the backdrop was.
//
// So: hide the world (`iso`, the same isolation the model sheet above uses — black clear colour,
// no fog), hide the subject so it cannot occlude, and put both sparks on the same nothing. The
// two blobs then differ in exactly one thing, which is the one thing being claimed. Depth
// testing has nothing to test against, so "buried" stops existing and a 0 px reading goes back
// to meaning what the assertion wants it to mean. Same shader, same `uScale`, same tone curve,
// same two distances — only the confound is gone.
console.log('\n--- do sparks have a perspective?');
const hiddenForSparks = await iso(true);
const sp = await p.evaluate(() => {
  const g = window.game, cam = g.camera;
  const V = cam.position.constructor;
  // `iso` hides every visible child of the scene, and the particle layer is one of them.
  window.__subj.group.visible = false;
  g.vfx.sparks.points.visible = true;
  cam.fov = 50;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  const f = new V(0, 0, -1).applyQuaternion(cam.quaternion);
  const rt = new V().setFromMatrixColumn(cam.matrixWorld, 0);
  const at = (d, side) => cam.position.clone()
    .add(f.clone().multiplyScalar(d)).add(rt.clone().multiplyScalar(side));
  // Offset sideways so the far one is not hidden inside the near one's halo, and so a single
  // connected component cannot swallow both.
  const near = at(4, -1.0), far = at(16, 2.6);
  g.vfx.clear();
  // 40 cm across, motionless, alive for nine seconds: one particle whose only job is to be
  // measured. The far one has to be *findable*, hence 40 rather than the 13..34 the real
  // effects use — at 16 m even 40 cm is only ~24 px wide.
  for (const q of [near, far]) g.vfx.sparks.spawn(q.x, q.y, q.z, 0, 0, 0, 1, 1, 1, 9, 40, 0, 0);
  g.vfx.update(0.001, cam);
  const w = window.innerWidth, h = window.innerHeight;
  const toPx = (v) => { const q = v.clone().project(cam); return [Math.round((q.x * 0.5 + 0.5) * w), Math.round((-q.y * 0.5 + 0.5) * h)]; };
  // The distances are measured, not assumed: the lateral offsets make them 4.12 m and 16.21 m,
  // so the expected area ratio is 15.5×, not 16×, and the assertion below is written against
  // whatever the camera actually did rather than against the two round numbers above.
  return {
    near: toPx(near), far: toPx(far),
    dNear: +cam.position.distanceTo(near).toFixed(2), dFar: +cam.position.distanceTo(far).toFixed(2),
  };
});
await new Promise((r) => setTimeout(r, 400));
await p.evaluate(() => { for (let i = 0; i < 3; i++) window.game.r.render(0.016); });
await new Promise((r) => setTimeout(r, 900));
await p.screenshot({ path: `${outDir}/${defId}-sparks.png` });
const sparkImg = decodePng(fs.readFileSync(`${outDir}/${defId}-sparks.png`));
await p.evaluate(() => { window.game.vfx.clear(); for (let i = 0; i < 3; i++) window.game.r.render(0.016); });
await new Promise((r) => setTimeout(r, 900));
await p.screenshot({ path: `${outDir}/${defId}-sparks-off.png` });
const cleanImg = decodePng(fs.readFileSync(`${outDir}/${defId}-sparks-off.png`));
// A second sparkless frame, 900 ms after the first: the **noise floor** of this reading, and now
// also the proof that the isolation happened. On the scene this floor was the whole problem — the
// grass never stops moving, the creature breathes, a big flat mountain face dithers, and
// "brighter by 10 over three channels" is ~3 bytes a channel, so an empty box was not empty
// (geoVishap read 605 px of *floor* for its far spark, failed the ratio at 5.9×, and read 226 px
// on the next run). Against black there is nothing left to move, so the floor is asserted to be
// ~0 rather than merely printed: if it is not, this frame is not the frame it claims to be.
await p.evaluate(() => { for (let i = 0; i < 3; i++) window.game.r.render(0.016); });
await new Promise((r) => setTimeout(r, 900));
await p.screenshot({ path: `${outDir}/${defId}-sparks-off2.png` });
const clean2Img = decodePng(fs.readFileSync(`${outDir}/${defId}-sparks-off2.png`));
/** Pixels in a box around `pt` that image `A` has brighter than image `B`. */
const brighter = (A, B, [px, py], rad = 70) => {
  let n = 0;
  for (let y = Math.max(0, py - rad); y < Math.min(A.height, py + rad); y++) {
    for (let x = Math.max(0, px - rad); x < Math.min(A.width, px + rad); x++) {
      const i = (y * A.width + x) * 4;
      const a = A.data[i] + A.data[i + 1] + A.data[i + 2];
      const b = B.data[i] + B.data[i + 1] + B.data[i + 2];
      if (a - b >= 10) n++;      // ~3 bytes per channel: the soft edge of an additive point
    }
  }
  return n;
};
/**
 * The connected patch of new light nearest the projected point — *this* spark, not everything
 * that changed in a 140 px box. Subtracting the wind floor is not enough on its own: the floor
 * only sees noise that repeats in the second interval, and geoVishap's 605 px did not repeat
 * (226 px on the next run). Restricting to one component is what actually answers the question.
 * The seed is the lit pixel closest to the point, because `project` runs a frame before the
 * screenshot. If the spark never drew, the seed lands on a noise speck and the area is a
 * handful of pixels — which is the "0 px" answer the assertion wants; the printed floor is
 * there to say how loud the box was.
 *
 * The contour is drawn at a quarter of *this blob's own peak*, not at a fixed +10 of added
 * light, and that is what makes the two readings comparable. A particle sprite is additive and
 * then tone-mapped, so the same 40 cm spark measures a completely different area depending on
 * what is behind it: against the bright Mondstadt sky the roll-off eats the soft edge, against
 * a dark mountain face it does not. Measured over the eight kinds' existing frames, the fixed
 * +10 contour gave near/far ratios of 6.4× … 32.7× for one and the same pair of distances,
 * and hilichurlPyro's 6.4× was a FAIL: its far spark happened to land on a shaded ridge and
 * read 510 px against every other kind's ~200 (its peak was 249 against their 111). The
 * quarter-of-peak contour reads 13.9× … 21.3× across the same eight frames — a band around
 * the theoretical 16×, which is what the assertion below is actually about. The `max(10, …)`
 * keeps a *missing* spark from turning noise into a contour: with no spark the peak in the box
 * is a couple of counts of wind and the threshold stays at the absolute floor.
 */
const blobAt = (A, B, [px, py], rad) => {
  const x0 = Math.max(0, px - rad), y0 = Math.max(0, py - rad);
  const x1 = Math.min(A.width, px + rad), y1 = Math.min(A.height, py + rad);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return 0;
  const on = new Uint8Array(w * h);
  const d = new Int32Array(w * h);
  let peak = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * A.width + x) * 4;
      const v = (A.data[i] + A.data[i + 1] + A.data[i + 2])
        - (B.data[i] + B.data[i + 1] + B.data[i + 2]);
      d[(y - y0) * w + (x - x0)] = v;
      if (v > peak) peak = v;
    }
  }
  const lim = Math.max(10, peak * 0.25);
  for (let k = 0; k < d.length; k++) if (d[k] >= lim) on[k] = 1;
  let seed = -1, bestD = Infinity;
  for (let k = 0; k < on.length; k++) {
    if (!on[k]) continue;
    const dx = (k % w) + x0 - px, dy = Math.floor(k / w) + y0 - py;
    if (dx * dx + dy * dy < bestD) { bestD = dx * dx + dy * dy; seed = k; }
  }
  if (seed < 0) return 0;
  const q = [seed]; on[seed] = 2;
  let n = 0;
  while (q.length) {
    const k = q.pop(); n++;
    const kx = k % w, ky = (k - kx) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = kx + dx, ny = ky + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (on[j] === 1) { on[j] = 2; q.push(j); }
    }
  }
  return n;
};
const litArea = (pt, rad = 70) => ({
  sig: brighter(sparkImg, cleanImg, pt, rad),
  noise: brighter(clean2Img, cleanImg, pt, rad),
  px: blobAt(sparkImg, cleanImg, pt, rad),
});
const nr = litArea(sp.near), fr = litArea(sp.far);
const aNear = nr.px, aFar = fr.px;
// Diameters, not areas: the far blob is a few dozen pixels, so its *area* carries the
// quantisation twice over (57 px vs 74 px is 5 px of radius either way but 30 % of ratio).
// Everything below is stated in the linear quantity and compared against the linear claim.
const dia = (a) => Math.sqrt((4 * a) / Math.PI);
const want = sp.dFar / sp.dNear;                 // the claim: screen diameter ∝ 1/distance
const got = dia(aNear) / Math.max(1, dia(aFar));
console.log(`  spark at ${sp.dNear} m -> ${aNear} px, ⌀${dia(aNear).toFixed(1)} at ${sp.near}`
  + ` (box lit ${nr.sig}, floor ${nr.noise});`
  + `  at ${sp.dFar} m -> ${aFar} px, ⌀${dia(aFar).toFixed(1)} at ${sp.far}`
  + ` (box lit ${fr.sig}, floor ${fr.noise})`
  + `  → ${got.toFixed(2)}× the diameter for ${want.toFixed(2)}× the distance`
  + `  [world hidden: ${hiddenForSparks} objects, subject too]`);
// The frame has to *be* the isolation it claims: on black, with the world and the subject hidden,
// two frames 900 ms apart are identical, so the floor inside both boxes is zero. This is the
// assertion that would have caught the old reading (the mage's far box had a whole sky in it).
check('the sparks are shot against nothing, so the boxes are still between frames',
  nr.noise === 0 && fr.noise === 0, `floor ${nr.noise} / ${fr.noise} px in the two boxes`);
check('both sparks reached the screen', aNear > 20 && aFar > 20, `${aNear} / ${aFar} px`);
// Both ends of this are a claim. A diameter ratio near 1 means the size is being clamped or
// ignored (the 200 px `gl_PointSize` ceiling and the 90 px one this section was written for);
// a ratio far above the distance ratio means the far one is being shrunk twice, which is what a
// perspective divide applied on top of an already-perspective size looks like. The band is
// −15 %/+20 % of the *measured* distance ratio, calibrated afterwards on nine kinds × two passes:
// against black the whole spread is 3.94-4.02× for a claim of 3.93×, i.e. 100-102 %, where the
// same reading over the scene ranged 6.4×-36.7× on an area ratio whose theory was 15.5×. A
// clamped point size reads 25 % of the claim and a doubled perspective divide reads 400 %, so the
// band is still wide enough to be a band and narrow enough to be a gate.
check('the far spark is smaller in proportion to its distance',
  got > want * 0.85 && got < want * 1.2,
  `⌀ ratio ${got.toFixed(2)}× vs distance ratio ${want.toFixed(2)}×`
  + ` (${(100 * got / want).toFixed(0)}% of the claim)`);
await p.evaluate(() => {
  window.game.vfx.clear();
  window.__subj.group.visible = true;
});
await iso(false);

console.log('errors ->', errs.length ? JSON.stringify([...new Set(errs)].slice(0, 6), null, 1) : 'none');
console.log(`\n${passes} passed, ${fails} failed, ${skips} skipped`);
await b.close();
process.exit(fails + (errs.length ? 1 : 0));
