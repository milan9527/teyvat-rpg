// 解谜 probe: a ring of monuments, lit the way a player lights it.
//
//   DISPLAY=:99 node tools/puzzle-check.mjs [baseUrl] [outDir]
//
// `api-check.mjs` already proves the *rules* of a puzzle: a click is validated against
// `puzzleNodes`, each monument writes its own `p:<nodeId>` row, only the last one pays, and one
// three-monument ring counts as one solved puzzle in 探索. What none of that covers is the only
// thing a player actually sees — whether a monument *looks* different once it is lit. The
// feedback is a single 12 cm sigil switching from dead stone to an emissive ring plus a glowing
// crown, and it was wrong for weeks (a flat torus floating beside the obelisk, i.e. an "already
// solved" marker on an untouched puzzle) without a single test going red.
//
// So this probe asserts the visual channel, with pixels:
//   * the client's ring is the shared derivation's ring (ids and positions), because the server
//     validates against the latter and a client that draws its own would be unsolvable;
//   * the gated chest says 需先解开谜题 before, and stops saying it the moment the ring is done;
//   * a *mouse click* on a monument 6 m away walks there and lights it (the click path, not just
//     the F key), and the remaining two go up on F;
//   * before/after crops of the same monument from the *same* camera transform show the sigil
//     and the crown getting brighter and taking the element's colour;
//   * the '1/3' note and the 谜题解开 toast really fire, and the three clicks are in the
//     database, and a reload brings all three back lit through `applyProgress`.
//
// Two habits this file inherits from earlier probe failures. Pin the quality tier: llvmpipe
// boots every browser at `low`, where there is no bloom, and bloom is half of what "lit" looks
// like. And keep a control that *must* move — two shots of a running frame must differ, or a
// throttled rAF would make every "before" and "after" identical and every delta zero.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { ZONES, puzzleNodes, PUZZLE_KINDS } from '../shared/src/data/zones.js';
import { ELEMENTS } from '../shared/src/data/elements.js';
import { decodePng, rectStats, pixelsDiffering } from './lib/png.mjs';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/puzzle';
const W = 1000, H = 700;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Inside a monument's 2.2 m interactable radius, outside its 0.7 m body.
const PROMPT_DIST = 1.7;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}

/* ------------------------------------------------------- the puzzle, in Node -- */

const zone = ZONES.mondstadt;
const poi = (zone.poi || []).find((x) => x.type === 'puzzle');
const gatedChest = (zone.poi || []).find((x) => x.requires === `puzzle:${poi?.id}`);
const nodes = puzzleNodes(zone, poi);
const def = PUZZLE_KINDS[poi.kind];
const elem = ELEMENTS[def.element ?? poi.element ?? 'wind'];

/** Where to stand to face a monument: its sigil faces the ring's centre, so does the player. */
function approach(n, dist) {
  const [cx, cz] = poi.at;
  const dx = cx - n.x, dz = cz - n.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: n.x + (dx / len) * dist, z: n.z + (dz / len) * dist, fx: dx / len, fz: dz / len };
}

// One camera transform, computed once, used for both the unlit and the lit shot of monument 0.
// Identical framing is the whole comparison: the difference between the two images then has
// exactly one cause.
// Framed to hold *both* lit parts: the sigil at y 1.6 and the orb floating at 3.18. At 4.6 m
// with a 34° lens the orb is eight pixels above the top of the window.
const CAM = (() => {
  const a = approach(nodes[0], 5.6);
  return { px: a.x, py: nodes[0].y + 2.9, pz: a.z, tx: nodes[0].x, ty: nodes[0].y + 2.1, tz: nodes[0].z, fov: 36 };
})();

/* ----------------------------------------------------------------- the page -- */

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

let logs = [];
const errors = [];
p.on('console', (m) => {
  const line = `[${m.type()}] ${m.text()}`;
  logs.push(line);
  if (m.type() === 'error') errors.push(line);
});
p.on('pageerror', (e) => { const l = `[pageerror] ${e.message}`; logs.push(l); errors.push(l); });

let step = 0;
/** Screenshot to disk *and* to a decoded image, so every shot can also be measured. */
async function shot(name) {
  step++;
  const file = `${outDir}/${String(step).padStart(2, '0')}-${name}.png`;
  const buf = Buffer.from(await p.screenshot({ path: file }));
  const drained = logs; logs = [];
  console.log(`\n=== ${step}. ${name} → ${file}`);
  if (drained.length) console.log(drained.slice(-6).join('\n'));
  return decodePng(buf);
}

const state = () => p.evaluate((poiId) => {
  const g = window.game;
  const e = g.world.poiById(poiId);
  return {
    zone: g.zoneId,
    prompt: g.prompt ? { txt: g.prompt.txt, sub: g.prompt.sub, disabled: !!g.prompt.disabled, id: g.prompt.entry.id } : null,
    me: { x: +g.me.x.toFixed(2), z: +g.me.z.toFixed(2) },
    done: !!e?.done,
    progress: g.world.puzzleProgress(poiId),
    notes: window.__notes || [],
    noteCalls: window.__noteCalls || [],
    toasts: window.__toasts || [],
    frames: g._frames ?? null,
  };
}, poi.id);

/** Light the monument the rig is standing at, with F, and wait for the count to move. */
async function litCount() {
  return (await p.evaluate((poiId) => window.game.world.puzzleProgress(poiId).lit, poi.id));
}
async function waitLit(want, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await litCount()) >= want) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Move the player, the way fast travel does.
 *
 * `me.teleportTo` alone is *not* enough and fails silently: the server owns the position and
 * answers any jump over 8 m with a `correction`, which `me.correct` applies by teleporting
 * straight back. The first run of this probe lit monument 0, then reported the prompt at
 * monument 1 as still reading monument 0 — because the player had never left. `Game#teleport`
 * shows the missing half: tell the server too (`socket.joinZone`). So every hop here reports
 * where it actually landed, and the caller asserts on that.
 */
async function hopTo(x, z, ry = null) {
  const landed = await p.evaluate(([tx, tz, r]) => {
    const g = window.game;
    const y = g.world.heightAt(tx, tz);
    g.me.teleportTo(tx, y, tz, r ?? g.me.ry);
    g.rig.snapToFocus({ x: tx, y, z: tz }, g.me.height);
    g.socket.joinZone(g.zoneId, { x: tx, z: tz });
    return true;
  }, [x, z, ry]);
  await sleep(2500);
  const at = await p.evaluate(() => ({ x: window.game.me.x, z: window.game.me.z }));
  return { ok: landed, dist: Math.hypot(at.x - x, at.z - z), at };
}

/**
 * Wait until nothing transient is on screen: no floating text, no live VFX.
 *
 * Both halves are load-bearing for a *measurement*. The note is DOM drawn at `y + 1.6`, which is
 * the sigil's exact height, so shooting early measures the text '1/3'. And the resonance pillar
 * is a 12 m translucent column 1.4 m wide standing in the monument — from 4.6 m away with a 34°
 * lens that is the entire frame, and because these probes stop the loop to place a free camera,
 * a pillar that is still alive at that moment is frozen there *forever*. The first green run of
 * this file measured 76 → 215 on a mint-veiled frame: the delta was real but its cause was half
 * pillar, which is exactly the sort of confident wrong number a pixel probe exists to avoid.
 */
async function waitQuiet(ms = 15000) {
  const busy = () => p.evaluate(() => {
    const v = window.game.vfx;
    let n = 0;
    for (const k of Object.keys(v)) if (Array.isArray(v[k]?.live)) n += v[k].live.length;
    return n + document.querySelectorAll('.dmg').length;
  });
  const t0 = Date.now();
  let left = await busy();
  while (left > 0 && Date.now() - t0 < ms) {
    await sleep(500);
    left = await busy();
  }
  return left;
}

/** Stand next to a monument, facing it, camera behind the player as in normal play. */
async function standAt(n, dist, label = n.id) {
  const a = approach(n, dist);
  const hop = await hopTo(a.x, a.z, Math.atan2(-a.fx, -a.fz));
  await p.evaluate(([fx, fz]) => {
    window.game.rig.faceDirection(-fx, -fz);
    window.game.rig.pitch = 0.22;
  }, [a.fx, a.fz]);
  await sleep(600);
  check(`the player is standing ${dist} m from ${label}, and stayed there`,
    hop.dist < 1.5, `${hop.dist.toFixed(1)} m off target`);
  return hop;
}

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  check('the login screen offers 单机模式', await p.evaluate(() => {
    const btn = document.querySelector('[data-act="solo"]');
    if (!btn) return false;
    btn.click();
    return true;
  }));
  await sleep(400);
  await (await p.$('[data-act="guest"]')).click();
  for (let i = 0; i < 90; i++) {
    if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) break;
    await sleep(1000);
  }
  check('the solo world booted', await p.evaluate(() => !!window.game?._running));
  const token = await p.evaluate(() => localStorage.getItem('teyvat.token'));
  const api = async (path) => (await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })).json();

  // Pinned before anything is streamed, and auto off first or the governor drops it back
  // within three seconds. At `low` the sigil's glow has no bloom around it, which is exactly
  // the difference this probe measures.
  await p.evaluate(() => {
    window.game.setAutoQuality(false);
    window.game.setQuality('high');
    // Noon, pinned: see daylight-check.mjs — the authored sky is what 12:00 returns.
    window.game.setWorldTime(12);
  });
  await sleep(2500);
  check('the quality tier is pinned high, so bloom is in the frame',
    (await p.evaluate(() => window.game.quality)) === 'high',
    await p.evaluate(() => window.game.quality));

  // Record the two floating-text channels before anything can fire them. `overlay.note` and
  // `toast` are both fire-and-forget DOM that self-removes on `animationend`, so a probe that
  // screenshots afterwards has no way to see what they said.
  await p.evaluate(() => {
    window.__notes = [];
    window.__toasts = [];
    window.game.on('toast', (t) => window.__toasts.push(t.text));
    // `overlay.note` draws nothing when its anchor does not project, and an empty `__notes` alone
    // cannot tell "the product never said it" from "it said it at a point off the screen". So
    // record every call *and* what the projection made of it: text, the screen point or null, and
    // where the camera and the player were standing when it was asked.
    const ov = window.game.overlay;
    const orig = ov.note.bind(ov);
    window.__noteCalls = [];
    ov.note = (x, y, z, text, cls) => {
      const g = window.game, cam = g.camera.position;
      window.__noteCalls.push({
        text, at: [+x.toFixed(1), +y.toFixed(1), +z.toFixed(1)],
        pt: ov.project(x, y, z, 90),
        cam: [+cam.x.toFixed(1), +cam.y.toFixed(1), +cam.z.toFixed(1)],
        me: [+g.me.x.toFixed(1), +g.me.y.toFixed(1), +g.me.z.toFixed(1)],
        dist: +Math.hypot(x - cam.x, y - cam.y, z - cam.z).toFixed(1),
      });
      return orig(x, y, z, text, cls);
    };
    new MutationObserver((recs) => {
      for (const r of recs) {
        for (const nd of r.addedNodes) {
          if (nd.nodeType === 1 && nd.classList.contains('dmg')) window.__notes.push(nd.textContent);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  await p.evaluate(async ([zid, x, z]) => {
    await window.game.enterZone(zid, { x, z });
  }, [zone.id, approach(nodes[0], 6).x, approach(nodes[0], 6).z]);
  await sleep(6000);
  await shot('arrived');

  /* --------------------------------------------- the ring the server validates -- */

  const ring = await p.evaluate((poiId) => {
    const g = window.game;
    const e = g.world.poiById(poiId);
    if (!e) return null;
    return {
      entryIsInteractable: g.world.interactables.some((i) => i.id === poiId),
      nodes: (e.nodes || []).map((n) => ({
        id: n.id, x: n.x, y: n.y, z: n.z, type: n.type, puzzleId: n.puzzleId,
        interactable: g.world.interactables.includes(n),
        hasProp: !!n.prop?.setLit, lit: !!n.done,
      })),
    };
  }, poi.id);

  check('the client builds the ring the shared derivation describes',
    !!ring && ring.nodes.length === nodes.length
    && ring.nodes.every((n, i) => n.id === nodes[i].id
      && Math.abs(n.x - nodes[i].x) < 0.01 && Math.abs(n.z - nodes[i].z) < 0.01),
    ring ? ring.nodes.map((n) => `${n.id}@${n.x.toFixed(1)},${n.z.toFixed(1)}`).join(' ') : 'no poi entry');
  // The monuments are the interactables; the poi entry is only a label and a map pin. If the
  // entry were interactable too, one click at the ring's centre would light the whole puzzle.
  check('each monument is its own interactable and the puzzle entry is not',
    !!ring && ring.entryIsInteractable === false
    && ring.nodes.every((n) => n.interactable && n.type === 'puzzle' && n.puzzleId === poi.id && n.hasProp),
    ring ? `entry ${ring.entryIsInteractable}, nodes ${ring.nodes.filter((n) => n.interactable).length}/${ring.nodes.length}` : '');
  check('nothing is lit on a fresh save', !!ring && ring.nodes.every((n) => !n.lit)
    && (await litCount()) === 0);

  // In range now. Note *which* range: `INTERACT_RANGE` is 4.2 m, but `nearestInteractable`
  // first requires the player to be inside the interactable's own radius, and a monument's is
  // 2.2 m — so 2.6 m away is close enough to interact and still shows no prompt at all.
  await standAt(nodes[0], PROMPT_DIST);
  const s0 = await state();
  check('standing at a monument prompts to 共鸣 it, and says how many are left',
    s0.prompt?.txt === `${def.verb}${def.name}` && s0.prompt?.sub === `${poi.name} 0/${nodes.length}`
    && s0.prompt?.id === nodes[0].id && !s0.prompt.disabled,
    JSON.stringify(s0.prompt));

  /* --------------------------------------------------- the lock the chest keeps -- */

  await hopTo(gatedChest.at[0], gatedChest.at[1]);
  const atChest = await state();
  check('the gated chest says what unlocks it, and cannot be opened yet',
    atChest.prompt?.id === gatedChest.id && atChest.prompt?.sub === '需先解开谜题',
    JSON.stringify(atChest.prompt));

  /* ---------------------------------- the frame is live, and the shot is aimed -- */

  await standAt(nodes[0], 6);
  const live1 = await shot('near-monument');
  await sleep(900);
  const live2 = await shot('near-monument-again');
  // The control that must move. Without it, a throttled rAF makes every later delta zero and
  // the probe reports "the lit sigil is no brighter" as a graphics bug.
  const moving = pixelsDiffering(live1, live2, 3);
  check('the frame is advancing between screenshots', moving > 2000, `${moving} px differ`);

  /* ------------------------------- unlit: the same camera, before the click ---- */

  /** Freeze the loop, place the free camera, render, and report where the two lit parts are. */
  const frameMonument = () => p.evaluate(([cam, n]) => {
    const g = window.game;
    g.stop();
    const a = g.me?.actor;
    const root = [a?.root, a?.group, a?.mesh, a?.obj].find((o) => o && o.isObject3D);
    if (root) root.visible = false;
    const c = g.camera;
    c.fov = cam.fov;
    c.position.set(cam.px, cam.py, cam.pz);
    c.lookAt(cam.tx, cam.ty, cam.tz);
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    for (let i = 0; i < 3; i++) g.r.render(0.016);
    // Aim at the *meshes*, found by name, not at guessed heights: the sigil sits at y 1.6 and
    // the orb floats above the capstone, and if either ever moves this probe has to move with
    // it rather than keep reporting confident numbers about a patch of stone.
    const it = g.world.interactables.find((i) => i.id === n.id);
    const found = {};
    it.prop.group.traverse((o) => {
      if (o.name !== 'monument:sigil' && o.name !== 'monument:core') return;
      o.updateWorldMatrix(true, false);
      const v = o.getWorldPosition(new o.position.constructor());
      found[o.name.split(':')[1]] = g.overlay.project(v.x, v.y, v.z, 999);
    });
    return { ...found, w: g.overlay._w, h: g.overlay._h };
  }, [CAM, nodes[0]]);

  check('the scene is quiet before the reference shot', (await waitQuiet()) === 0);
  const aim = await frameMonument();
  await sleep(800);
  const unlit = await shot('sigil-unlit');
  // Aim the rectangles off the projection, and prove the projection and the screenshot share a
  // coordinate space before trusting either — a rectangle measured in the wrong space is the
  // one failure mode that produces confident numbers about the wrong pixels.
  check('the monument projects on screen and the overlay measures in screenshot pixels',
    !!aim.sigil && !!aim.core && aim.w === unlit.width && aim.h === unlit.height,
    `sigil ${aim.sigil && `${aim.sigil.x.toFixed(0)},${aim.sigil.y.toFixed(0)}`} core ${aim.core && `${aim.core.x.toFixed(0)},${aim.core.y.toFixed(0)}`} overlay ${aim.w}x${aim.h} shot ${unlit.width}x${unlit.height}`);
  const rect = (pt, w, h, label) => ({
    x: Math.round(pt.x - w / 2), y: Math.round(pt.y - h / 2), w, h, label,
  });
  const R_SIGIL = rect(aim.sigil, 44, 44, 'sigil');
  const R_CORE = rect(aim.core, 52, 72, 'core');       // taller: the lit orb bobs ±0.07 m
  const before = { sigil: rectStats(unlit, R_SIGIL), core: rectStats(unlit, R_CORE) };
  console.log('  unlit', JSON.stringify(before));
  // A dead monument must actually read as stone: if the sigil were already glowing, the puzzle
  // would have no feedback left to give. Only the sigil gets a luma threshold — the orb floats
  // clear of the obelisk, so its crop is mostly hillside and an absolute number there says
  // nothing. What it *can* be held to is being hidden, which is a fact and not a threshold.
  const orbShown = () => p.evaluate((id) => {
    let v = null;
    window.game.world.interactables.find((i) => i.id === id).prop.group
      .traverse((o) => { if (o.name === 'monument:core') v = o.visible; });
    return v;
  }, nodes[0].id);
  check('an untouched monument is dead stone, not a glowing disc',
    before.sigil.lum < 120 && (await orbShown()) === false,
    `sigil ${before.sigil.lum} rgb ${before.sigil.rgb} · orb shown ${await orbShown()}`);

  /* --------------------------------------------------- lighting one with a click -- */

  await p.evaluate(() => window.game.start());
  await sleep(600);
  await standAt(nodes[0], 6);
  const far = await state();
  // What to click: a patch of ground a metre in front of the monument. The click path raycasts
  // the *terrain* and then looks for an interactable near the hit, so the aim point has to be
  // ground within the monument's 2.2 m radius — clicking the sigil itself would put the ground
  // hit somewhere on the hillside behind it.
  //
  // And the camera has to be aimed before anything can be clicked: this ring is on a slope
  // (the three monuments stand at y 18.4, 11.2 and 7.4), so from the downhill side the default
  // pitch has the target 23 px *above* the top of the window, which puppeteer rejects outright
  // rather than clicking nothing. So sweep the pitch and take the first framing that puts the
  // aim point comfortably inside the viewport.
  const a0 = approach(nodes[0], 6);
  let target = null, usedPitch = null;
  for (const pitch of [0.22, 0.05, -0.12, -0.28, 0.4]) {
    await p.evaluate((v) => { window.game.rig.pitch = v; }, pitch);
    await sleep(700);
    target = await p.evaluate(([n, fx, fz]) => {
      const g = window.game;
      const gx = n.x + fx * 1.0, gz = n.z + fz * 1.0;
      const pt = g.overlay.project(gx, g.world.heightAt(gx, gz) + 0.05, gz, 999);
      if (!pt) return null;
      const inside = pt.x > 60 && pt.x < g.overlay._w - 60 && pt.y > 60 && pt.y < g.overlay._h - 60;
      return inside ? { x: pt.x, y: pt.y } : null;
    }, [nodes[0], a0.fx, a0.fz]);
    if (target) { usedPitch = pitch; break; }
  }
  check('the monument can be brought under the cursor from six metres away',
    !!target, target ? `pitch ${usedPitch} -> ${target.x.toFixed(0)},${target.y.toFixed(0)}` : 'never on screen');
  if (target) await p.mouse.click(target.x, target.y);
  const lit1 = await waitLit(1);
  const afterClick = await state();
  await shot('after-click');
  // Six metres is past INTERACT_RANGE, so a click has to walk there first and interact on
  // arrival — that arrival branch is a different code path from pressing F in range.
  check('a mouse click on a distant monument walks there and lights it',
    lit1 && Math.hypot(afterClick.me.x - far.me.x, afterClick.me.z - far.me.z) > 1.5,
    `lit ${afterClick.progress.lit}/${afterClick.progress.total}, walked `
    + `${Math.hypot(afterClick.me.x - far.me.x, afterClick.me.z - far.me.z).toFixed(1)} m`);
  // Announced in the channel that does not depend on where the camera is pointing. The note at
  // the monument is the other half of this claim and is asserted below, from the F key, because
  // *this* path cannot promise a camera: the walk is 4.6 m up a slope (the ring's monuments stand
  // at y 18.4, 11.2 and 7.4) and the follow camera converges over frames, so at llvmpipe's 2 fps
  // it arrives 10 m *below* the player, inside the hillside — the anchor 1.6 m over a monument
  // then sits far above the top of the frame and `overlay.note` correctly draws nothing. That is
  // what the recorded call says, so it is printed either way rather than left as an empty list.
  check('and a walk-and-interact lighting says how many are left, in a toast',
    afterClick.toasts.some((t) => t === `已点亮 1/${nodes.length}`),
    `toasts ${JSON.stringify(afterClick.toasts)} note calls ${JSON.stringify(afterClick.noteCalls)}`);
  check('a lit monument\'s prompt is spent',
    (await p.evaluate((id) => {
      const g = window.game;
      const it = g.world.interactables.find((i) => i.id === id);
      return it ? { done: !!it.done } : null;
    }, nodes[0].id))?.done === true);
  // Without moving. The prompt used to be rebuilt only when the player walked up to a *different*
  // interactable, so the bar under a monument the player had just lit went on offering
  // 「共鸣元素方碑 风之试炼 0/3」 — the count being the whole point of the subtitle.
  await sleep(1500);                    // a couple of frames at llvmpipe's 3 fps
  const settled = (await state()).prompt;
  check('and the prompt says so while the player is still standing there',
    settled?.id === nodes[0].id && settled?.disabled === true
    && settled?.sub === `${poi.name} 1/${nodes.length}`,
    JSON.stringify(settled));

  /* ------------------------------- lit: the same camera again, and the pixels ---- */

  check('the resonance effects have finished before the comparison shot',
    (await waitQuiet()) === 0);
  await frameMonument();
  await sleep(800);
  const litImg = await shot('sigil-lit');
  const after = { sigil: rectStats(litImg, R_SIGIL), core: rectStats(litImg, R_CORE) };
  console.log('  lit  ', JSON.stringify(after));
  check('lighting a monument makes its sigil visibly brighter',
    after.sigil.lum > before.sigil.lum + 25,
    `${before.sigil.lum} -> ${after.sigil.lum} (rgb ${before.sigil.rgb} -> ${after.sigil.rgb})`);
  // Brighter is not enough: a white sigil would pass that and tell the player nothing about
  // which element resonated. The glow is the element's colour, so its channels must move apart.
  const wantG = (elem.color >> 8) & 255, wantR = (elem.color >> 16) & 255;
  check('and it takes the element\'s colour rather than turning white',
    after.sigil.rgb[1] - before.sigil.rgb[1] > 20
    && (after.sigil.rgb[1] - after.sigil.rgb[0]) > (before.sigil.rgb[1] - before.sigil.rgb[0]) + 8
    && wantG > wantR,
    `${elem.name} #${elem.color.toString(16)} · rgb ${before.sigil.rgb} -> ${after.sigil.rgb}`);
  // The orb, whose whole reason to exist is being visible from further away than a 12 cm sigil.
  // It was buried inside the capstone until this probe measured 96.8 → 95.1 there: shown, lit,
  // animated and completely invisible.
  check('and the orb above the tip appears',
    (await orbShown()) === true && after.core.lum > before.core.lum + 30,
    `${before.core.lum} -> ${after.core.lum} (rgb ${before.core.rgb} -> ${after.core.rgb})`);

  /* ------------------------------------------------- the other two, on the F key -- */

  await p.evaluate(() => {
    const g = window.game;
    g.start();
    const a = g.me?.actor;
    const root = [a?.root, a?.group, a?.mesh, a?.obj].find((o) => o && o.isObject3D);
    if (root) root.visible = true;
  });
  await sleep(600);
  for (let i = 1; i < nodes.length; i++) {
    await standAt(nodes[i], PROMPT_DIST);
    const st = await state();
    check(`monument ${i} prompts with the running count`,
      st.prompt?.id === nodes[i].id && st.prompt?.sub === `${poi.name} ${i}/${nodes.length}`,
      JSON.stringify(st.prompt));
    const notesBefore = (await state()).noteCalls.length;
    await p.keyboard.press('KeyF');
    check(`F lights monument ${i}`, await waitLit(i + 1), `lit ${await litCount()}`);
    // The other half of "it says how many are left": at the monument. `standAt` teleports and the
    // camera is settled behind the player, so here the anchor does project — and the assertion
    // demands exactly that, off the recorded projection, so a note that was dropped off the top
    // of the frame cannot pass as one the player read. The last monument solves the ring and
    // takes the reward branch, which says its piece in toasts instead.
    if (i < nodes.length - 1) {
      await sleep(600);
      const st2 = await state();
      const call = st2.noteCalls.slice(notesBefore).find((c) => c.text === `${i + 1}/${nodes.length}`);
      check(`and monument ${i} says how many are left at the monument, on screen`,
        !!call && !!call.pt && st2.notes.includes(`${i + 1}/${nodes.length}`),
        `notes ${JSON.stringify(st2.notes)} call ${JSON.stringify(call ?? null)}`);
    }
  }
  await shot('solved');
  const solved = await state();
  check('the last monument solves the puzzle and pays 原石',
    solved.done && solved.progress.lit === nodes.length
    && solved.toasts.some((t) => /^谜题解开 \+\d+原石$/.test(t)),
    `${solved.progress.lit}/${solved.progress.total} done=${solved.done} `
    + `toasts ${JSON.stringify(solved.toasts.slice(-3))}`);
  check('every monument of a solved ring is lit',
    (await p.evaluate((poiId) => window.game.world.poiById(poiId).nodes.every((n) => n.done), poi.id)) === true);
  // Announced, not just enabled. The note is anchored at the chest and therefore silent when
  // the chest is off screen — which it is from two of the three monuments — so the toast is the
  // part that has to be there whatever the player is looking at.
  check('the chest the ring unlocks is announced, not silently enabled',
    solved.toasts.some((t) => /宝箱已解锁/.test(t)),
    `toasts ${JSON.stringify(solved.toasts.slice(-3))} notes ${JSON.stringify(solved.notes)}`);

  /* ------------------------------------------------------- what reached the DB -- */

  const wp = (await api('/api/player/state')).player?.worldProgress?.[zone.id] || {};
  check('all three clicks are in world progress, one row each plus the solve',
    nodes.every((n) => wp[`p:${n.id}`]?.lit === true) && wp[poi.id]?.solved === true,
    Object.keys(wp).filter((k) => k.startsWith('p:') || k === poi.id).join(' '));
  const ach = await api('/api/achievements');
  check('and one ring counts as exactly one solved puzzle in 探索',
    ach.progress?.puzzles === 1, `puzzles = ${ach.progress?.puzzles} for ${nodes.length} monuments`);

  /* ----------------------------------------------------- and it survives a reload -- */

  await p.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3000);
  await (await p.$('[data-act="resume"]')).click();
  for (let i = 0; i < 90; i++) {
    if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) break;
    await sleep(1000);
  }
  await p.evaluate(async ([zid, x, z]) => {
    window.game.setAutoQuality(false);
    window.game.setQuality('high');
    await window.game.enterZone(zid, { x, z });
  }, [zone.id, approach(nodes[0], 3).x, approach(nodes[0], 3).z]);
  await sleep(6000);
  // `enterZone`'s `at` is a request, not a guarantee — the server answers with the position it
  // decided on — so walk up to the monument explicitly before reading its prompt.
  await standAt(nodes[0], PROMPT_DIST, `${nodes[0].id} after the reload`);
  const back = await state();
  await shot('after-reload');
  check('a solved ring comes back lit on re-entry',
    back.progress.lit === nodes.length && back.done,
    `${back.progress.lit}/${back.progress.total} done=${back.done}`);
  check('and its monuments read as already resonated',
    back.prompt?.txt === `${def.name}已${def.verb}` && back.prompt?.disabled === true,
    JSON.stringify(back.prompt));
  await hopTo(gatedChest.at[0], gatedChest.at[1]);
  const chest2 = await state();
  check('the once-gated chest can be opened now',
    chest2.prompt?.id === gatedChest.id && chest2.prompt?.sub !== '需先解开谜题'
    && !chest2.prompt?.disabled,
    JSON.stringify(chest2.prompt));

  check('no page errors', errors.length === 0, [...new Set(errors)].slice(0, 3).join(' | '));
} catch (e) {
  check('probe ran to completion', false, e?.stack?.split('\n').slice(0, 3).join(' ') || String(e));
  await shot('crash').catch(() => {});
} finally {
  await b.close().catch(() => {});
}

// A probe that asserts nothing is worse than a red one; the count is part of the verdict.
console.log(`\n${pass} passed, ${fail} failed`);
if (pass < 36) { console.log('too few assertions ran — treat this as a failure'); process.exit(1); }
process.exit(fail);
