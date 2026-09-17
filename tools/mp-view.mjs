// 多人在线, in pixels: does a second player actually appear on your screen?
//
//   DISPLAY=:99 node tools/mp-view.mjs [baseUrl] [outDir] [--zone mondstadt]
//
// `tools/mp-check.mjs` proves the gateway's half — two sockets, one shard, snapshots that
// list each other, party, co-op follow, revive refusals — and it has been green for weeks.
// None of that is evidence for the sentence the goal actually contains (支持单机和多人在线),
// because every assertion in it is about a JSON payload. A client that receives a perfect
// snapshot stream and renders nothing looks exactly the same from the server's side, and
// this repo has shipped that shape of bug repeatedly: a shader that never reached the screen
// (`uVaultCol` moved 0 counts), an orb buried inside its own capstone, nine SFX recipes with
// no caller. So the one thing multiplayer had never been asked was whether the other player
// is *visible*.
//
// The asymmetry is the design. One real browser — the pixels we judge — plus one player made
// of nothing but the messages `client/src/net/socket.js` would have sent (tools/lib/ghost.mjs).
// Two browsers would have been the obvious probe and a useless one: two WebGL contexts under
// llvmpipe run at about 1 fps each and Firefox throttles rAF in the unfocused page, so both
// windows would have been screenshotted stale, and "stale" is indistinguishable from
// "correct" in a frame diff.
//
// What it measures, and why each one is here:
//
//   1. **A baseline with nobody there.** Every pixel claim below is a diff against the same
//      frame with the ghost not yet connected, plus a *noise floor* — two baselines 1.5 s
//      apart, so grass sway, the local avatar's idle breathing and llvmpipe's dither are
//      measured rather than assumed away. A threshold picked by hand is how a probe ends up
//      passing on a frozen frame. The sway is not a rounding error: at tol 8 two frames of
//      an *empty* meadow differ in 13-17% of the rect and one pair hit 75%, which is why the
//      diff runs at tol 48 and is backed by a second, diff-free metric (see `alien` below).
//   2. **Both sides of the move.** The ghost stands at one station, then walks to a second:
//      the first rect has to go *back* towards empty and the second has to fill. A one-sided
//      "something changed where I expected" passes for a cloud drifting past.
//   3. **A control rect that must not move**, chosen on the far side of the frame, verified
//      with `elementsFromPoint` to be canvas rather than a HUD panel — a chat line arriving
//      when the ghost joins would otherwise be a perfectly good "the frame changed".
//   4. **The state and the DOM next to the pixels**: `actors.players`, the name plate's text
//      and its screen position, the 进入/离开 chat lines, the remote locomotion speed and the
//      attack clip. A pixel diff says something is there; these say it is *that player*.
//
// The ghost's spot is chosen by the page, not typed here: 12 directions are tried and the
// first one whose two stations are on gentle dry ground, in frame, and with an unobstructed
// line from the camera (`world.blockedAt` sampled along the ray) wins. A tree between the
// camera and the ghost would otherwise make every assertion above measure bark, and the
// failure would read as "multiplayer is invisible".
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { C2S, S2C } from '../shared/src/protocol.js';
import { mintGuest } from './lib/account.mjs';
import { connectGhost } from './lib/ghost.mjs';
import { decodePng, rectStats, pixelsDiffering } from './lib/png.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const base = positional[0] || process.env.GAME_APP || 'http://127.0.0.1:5173';
const outDir = positional[1] || '/tmp/mp-view';
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const ZONE = flag('zone', 'mondstadt');
const W = 1000, H = 700;

mkdirSync(outDir, { recursive: true });
// Old frames numbered by step are a trap once a step is added: `03-moved.png` from the
// previous run sits next to this run's and looks current.
for (const f of readdirSync(outDir)) if (f.endsWith('.png')) rmSync(`${outDir}/${f}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0, skips = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}
/** A claim whose precondition this run could not meet — reported, never counted as green. */
function skip(name, why) { skips++; console.log(`  SKIP ${name} — ${why}`); }

/**
 * Fraction of pixels inside `r` that differ by more than `tol` in any channel.
 *
 * The default tolerance is high on purpose. Mondstadt's grass is animated, so between any
 * two frames a large share of every ground rect moves a little: measured over this probe's
 * own PNGs, two consecutive frames of an empty meadow differ in 13-17% of a body-sized rect
 * at tol 8 (one pair, 1.5 s apart, 75%), while a body arriving changes 35-37% at tol 48
 * against a 1-3% floor. Tol 8 is not a stricter test, it is a broken one.
 */
function rectDiff(a, b, r, tol = 48) {
  let n = 0, total = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * a.width + x) * 4;
      total++;
      if (Math.abs(a.data[i] - b.data[i]) > tol
        || Math.abs(a.data[i + 1] - b.data[i + 1]) > tol
        || Math.abs(a.data[i + 2] - b.data[i + 2]) > tol) n++;
    }
  }
  return total ? n / total : 0;
}
const pct = (v) => `${(v * 100).toFixed(1)}%`;

/**
 * Fraction of pixels inside `r` that are *not this ground*: max-channel distance from `ref`
 * above `thr`. Nothing is subtracted from another frame, which is the point — it is a
 * property of one PNG, so wind cannot move it.
 *
 * `ref` is not a constant either: it is the mean colour of the **control rect in the same
 * frame**, so the ground's own exposure, the time of day and the tone curve all cancel. The
 * numbers this earned over run 3's frames, threshold 60:
 *
 *     rect   empty  empty  P1 held  P2 held  P2 held  ghost gone
 *     P1       9.4    9.3     34.8      8.9      8.9         9.3
 *     P2       3.4    3.5      3.5     36.6     38.2         3.3
 *     ctrl    11.7   12.3     12.2     12.0     11.9        11.5
 *
 * An empty rect holds its value to ±0.5 points across the whole run while an occupied one
 * gains 25-33. That is a two-sided pin with two decimal orders of headroom, and unlike the
 * diff it also states which of the two frames the body was in.
 */
function alien(img, r, ref, thr = 60) {
  let n = 0, total = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * img.width + x) * 4;
      const d = Math.max(
        Math.abs(img.data[i] - ref[0]),
        Math.abs(img.data[i + 1] - ref[1]),
        Math.abs(img.data[i + 2] - ref[2]),
      );
      total++;
      if (d > thr) n++;
    }
  }
  return total ? n / total : 0;
}

/* --------------------------------------------------------------- the browser -- */

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
const hmr = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('[pageerror]', e.message); });
p.on('console', (m) => {
  const t = m.text().slice(0, 250);
  if (/\[vite\].*(hot updated|hmr update|page reload)/i.test(t)) { hmr.push(t); console.log('[HMR]', t); }
  if (m.type() === 'error') { errs.push(t.slice(0, 200)); console.log('[err]', t); }
});

/**
 * Wait until the renderer has actually composited `n` more frames. `Renderer#render`
 * increments `frame`, so this counts frames the display got — not rAF ticks, not sleeps.
 *
 * Every screenshot goes through here. At llvmpipe's 2-3 fps a shot taken after a `sleep`
 * can still hold the *previous* frame, and a stale PNG produces a failure and an alibi at
 * the same time: run 3 photographed `03-me-shown` with the camera still pointing where the
 * placement scan had left it, and the hide-and-diff then read 79.8% "signal" against a
 * 75.2% control — two frames of different scenes, compared as if they were one scene with
 * a change in it.
 */
const stalled = [];
const waitFrames = async (n = 3, ms = 25000, label = '') => {
  const from = await p.evaluate(() => window.game?.r?.frame ?? -1).catch(() => -1);
  if (from < 0) { await sleep(600); return -1; }
  const until = Date.now() + ms;
  for (;;) {
    const now = await p.evaluate(() => window.game.r.frame).catch(() => from);
    if (now - from >= n) return now - from;
    if (Date.now() > until) { stalled.push(label || `${n} frames`); return now - from; }
    await sleep(150);
  }
};

let step = 0;
const shoot = async (name, frames = 3) => {
  const drew = await waitFrames(frames, 25000, name);
  step++;
  const file = `${outDir}/${String(step).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file });
  console.log(`  · ${file} (after ${drew} fresh frames)`);
  return decodePng(readFileSync(file));
};

let ghost = null;
try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  // 多人在线 is the default on the title screen and must stay the default — the whole probe
  // is about the online host, and a solo tab would show an empty world and pass nothing.
  const online = await p.evaluate(() => {
    const btn = document.querySelector('[data-act="online"]');
    return !!btn && btn.classList.contains('primary');
  });
  check('the title screen offers 多人在线 and it is the default', online);
  const enter = await p.$('[data-act="guest"]') || await p.$('[data-act="resume"]');
  await enter.click();
  for (let i = 0; i < 90; i++) {
    if (await p.evaluate(() => !!window.game?._running).catch(() => 0)) break;
    await sleep(1000);
  }
  await sleep(4000);
  await p.evaluate(() => {
    window.game.setAutoQuality(false);
    window.game.setQuality('high');
    // Noon, pinned: see daylight-check.mjs — the authored sky is what 12:00 returns.
    window.game.setWorldTime(12);
  });
  await sleep(3000);

  // Record what arrives, from inside the page: the assertions about remote actions need the
  // events themselves, and `socket.on` takes a Set of handlers so listening alongside the
  // game changes nothing about what the game does.
  await p.evaluate((types) => {
    window.__mp = { actions: [], joins: [], leaves: [], chats: [] };
    const s = window.game.socket;
    s.on(types.PLAYER_ACTION, (d) => window.__mp.actions.push(d));
    s.on(types.PLAYER_JOIN, (d) => window.__mp.joins.push(d));
    s.on(types.PLAYER_LEAVE, (d) => window.__mp.leaves.push(d));
    s.on(types.CHAT, (d) => window.__mp.chats.push(d));
  }, { PLAYER_ACTION: S2C.PLAYER_ACTION, PLAYER_JOIN: S2C.PLAYER_JOIN, PLAYER_LEAVE: S2C.PLAYER_LEAVE, CHAT: S2C.CHAT });

  const state = () => p.evaluate(() => {
    const g = window.game;
    return {
      running: !!g._running, mode: g.mode, quality: g.quality, playerId: g.playerId,
      zone: g.zoneId, shard: g.socket?.shard ?? null, nickname: g.socket?.nickname ?? null,
      showNames: !!g.settings?.showNames,
      me: { x: +g.me.x.toFixed(2), y: +g.me.y.toFixed(2), z: +g.me.z.toFixed(2) },
      players: [...g.actors.players.entries()].map(([id, e]) => ({
        id, nickname: e.nickname, charId: e.charId, hp: e.hp, maxHp: e.maxHp,
        x: +e.x.toFixed(2), y: +e.y.toFixed(2), z: +e.z.toFixed(2), speed: +e.speed.toFixed(2),
        clip: e.actor?.animator?.currentAction ?? null,
        visible: !!e.actor?.rig?.group?.visible,
      })),
    };
  });

  let st = await state();
  console.log(' ', JSON.stringify({ ...st, players: st.players.length }));
  if (!check('the online world booted', st.running && !!st.playerId && st.mode === 'online',
    `player ${st.playerId}, mode ${st.mode}`)) throw new Error('no world');
  check('the quality tier is pinned to high', st.quality === 'high', `tier ${st.quality}`);

  if (st.zone !== ZONE) {
    await p.evaluate(async (z) => { await window.game.enterZone(z); }, ZONE);
    await sleep(8000);
    st = await state();
  }
  if (!check(`the game is in ${ZONE}`, st.zone === ZONE, st.zone)) throw new Error('wrong zone');
  // A private shard is what 单机 and a co-op dungeon get; its key starts with `p` and nobody
  // can be matched into it. If A is in one, no second player could ever arrive and every
  // failure below would be a lie about the renderer.
  check('A is in a public shard, the kind another player can be matched into',
    !!st.shard && !String(st.shard).startsWith('p'), `shard ${st.shard}`);
  check('name plates are on (the default), so the plate assertions mean something', st.showNames);

  /* ------------------------------------------------- the frame is not frozen -- */

  const a0 = await shoot('live-a');
  await p.evaluate(() => { window.game.rig.yaw += Math.PI / 2; });
  await sleep(2500);
  const a1 = await shoot('live-b');
  const yawMoved = pixelsDiffering(a0, a1, 2);
  check('the camera is live (a quarter turn changes the frame)', yawMoved > 2000, `${yawMoved} px`);

  /* ------------------------------------------------------ where to stand it -- */

  // Two stations, symmetric about the aim direction, so both are in frame and neither is
  // hidden behind the local avatar in the middle of it. Aiming happens for real (the rig's
  // own `faceDirection`, the lock-on path) before the line of sight is sampled, because the
  // camera *position* is what the ray starts from and that only exists once the yaw is set.
  // Every candidate that loses says *why*: the first version of this scan reported "all 12
  // directions blocked" and that sentence is useless — it is equally consistent with a
  // forest, with a projection returning null because the overlay never got a size, and with
  // a margin test written for a different viewport. Three framings are tried in turn, because
  // a spawn hemmed in by trees can still have a nearer clear spot.
  const FRAMINGS = [{ dist: 8.5, side: 3.6 }, { dist: 6.5, side: 2.8 }, { dist: 11, side: 4.6 }];
  let placement = null;
  const rejected = [];
  for (const f of FRAMINGS) {
    for (let i = 0; i < 12 && !placement; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const r = await p.evaluate(({ angle: a, dist, side }) => {
        const g = window.game, W = g.world;
        const fx = Math.sin(a), fz = Math.cos(a);
        g.rig.faceDirection(fx, fz);
        g.rig.update(0.05, { x: g.me.x, y: g.me.y, z: g.me.z }, 1.7, false);
        // `Vector3.project` reads `camera.matrixWorldInverse`, which three.js only refreshes
        // during a render — so projecting straight after a yaw change measures the *previous*
        // orientation. That cost this scan a whole run: every station came out 150 px off the
        // left edge, which reads exactly like a forest or a bad margin test. `Camera`'s own
        // `updateMatrixWorld` rebuilds the inverse, so ask for it explicitly.
        g.rig.camera.updateMatrixWorld(true);
        const me = { x: g.me.x, y: g.me.y, z: g.me.z };
        const cam = g.rig.camera.position;
        const out = [];
        for (const s of [1, -1]) {
          const x = me.x + fx * dist - fz * side * s;
          const z = me.z + fz * dist + fx * side * s;
          const y = W.heightAt(x, z);
          const step = Math.abs(y - me.y), slope = W.slopeAt(x, z);
          if (step > 2.2) return { why: `step ${step.toFixed(1)} m` };
          if (slope > 0.45) return { why: `slope ${slope.toFixed(2)}` };
          if (y < W.waterLevel + 0.4) return { why: `in the water (y ${y.toFixed(1)})` };
          // Trunks and boulders between the camera and the station: sample the ray at chest
          // height every metre. This is the check that keeps a pixel FAIL honest.
          const n = Math.ceil(Math.hypot(x - cam.x, z - cam.z));
          for (let k = 1; k <= n; k++) {
            const t = k / n;
            if (W.blockedAt(cam.x + (x - cam.x) * t, cam.y + (y + 1.0 - cam.y) * t, cam.z + (z - cam.z) * t)) {
              return { why: `a trunk or boulder ${k} m along the ray` };
            }
          }
          const feet = g.overlay.project(x, y, z, 200);
          const head = g.overlay.project(x, y + 1.75, z, 200);
          if (!feet || !head) return { why: `not projectable (overlay ${innerWidth}×${innerHeight})` };
          if (feet.x < 120 || feet.x > innerWidth - 120) return { why: `off-frame x ${feet.x.toFixed(0)}` };
          if (head.y < 70 || feet.y > innerHeight - 90) return { why: `off-frame y ${head.y.toFixed(0)}..${feet.y.toFixed(0)}` };
          out.push({ x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), feet, head });
        }
        // The two rects must not touch, or "P1 emptied" and "P2 filled" are the same pixels.
        const apart = Math.abs(out[0].feet.x - out[1].feet.x);
        if (apart < 100) return { why: `stations only ${apart.toFixed(0)} px apart on screen` };
        return { angle: a, fx, fz, stations: out };
      }, { angle, dist: f.dist, side: f.side });
      if (r?.stations) placement = { ...r, ...f };
      else rejected.push(`${f.dist}m@${(angle * 57.3).toFixed(0)}°: ${r?.why || 'unknown'}`);
    }
    if (placement) break;
  }
  if (!check('found a spot with a clear line of sight to stand the other player in',
    !!placement, placement ? `aim ${(placement.angle * 57.3).toFixed(0)}°, ${placement.dist} m out, ±${placement.side} m`
      : `${rejected.length} candidates rejected`)) {
    for (const r of rejected) console.log(`    · ${r}`);
    throw new Error('nowhere to stand');
  }
  const [P1, P2] = placement.stations;
  console.log(`  stations: P1 (${P1.x}, ${P1.z}) → screen ${P1.feet.x.toFixed(0)},${P1.feet.y.toFixed(0)}`
    + ` · P2 (${P2.x}, ${P2.z}) → screen ${P2.feet.x.toFixed(0)},${P2.feet.y.toFixed(0)}`);

  /**
   * The rect a standing character covers, derived from its own two projections rather than
   * from a pixel count typed here: the same expression works at 8 m and at 20 m.
   */
  const bodyRect = (s, label) => {
    const h = Math.max(24, s.feet.y - s.head.y);
    const w = Math.round(h * 0.46);
    return {
      label,
      x: Math.max(0, Math.round(s.feet.x - w / 2)),
      y: Math.max(0, Math.round(s.head.y)),
      w: Math.min(W - 2, w), h: Math.min(H - Math.round(s.head.y) - 2, Math.round(h * 1.06)),
    };
  };
  const r1 = bodyRect(P1, 'P1'), r2 = bodyRect(P2, 'P2');
  // The control: the same height band, pushed to whichever edge is furthest from both
  // bodies. Same kind of content (mid-distance terrain), no avatar, no HUD.
  const midX = (r1.x + r2.x) / 2;
  const ctrl = {
    label: 'ctrl',
    x: midX > W / 2 ? 24 : W - 24 - r1.w,
    y: r1.y, w: r1.w, h: r1.h,
  };
  for (const r of [r1, r2, ctrl]) console.log(`  rect ${r.label}: ${r.x},${r.y} ${r.w}×${r.h}`);

  // A rect over a HUD panel would diff for reasons that have nothing to do with the world —
  // the chat line the join prints is the obvious one. Ask the DOM what is on top.
  const onCanvas = await p.evaluate((rects) => rects.map((r) => {
    const el = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2);
    return { label: r.label, tag: el?.tagName || 'none', cls: el?.className || '' };
  }), [r1, r2, ctrl]);
  check('all three rects sit on the 3D canvas, not on a HUD panel',
    onCanvas.every((o) => o.tag === 'CANVAS'), JSON.stringify(onCanvas));

  /* ------------------------- does a projected rect really hold those pixels? -- */

  // Every pixel claim in this probe rests on one unproven step: that `overlay.project` and
  // the rendered frame agree about where a world point is. So prove it on a body that is
  // already there — hide the local avatar, and the rect *her own* projection produces must
  // change while the control rect does not. A stale `matrixWorldInverse` had already faked
  // this once (see the scan above), and a projection that is 150 px out would otherwise show
  // up as "the other player is invisible".
  const meStation = await p.evaluate(() => {
    const g = window.game;
    g.rig.camera.updateMatrixWorld(true);
    const feet = g.overlay.project(g.me.x, g.me.y, g.me.z, 200);
    const head = g.overlay.project(g.me.x, g.me.y + 1.75, g.me.z, 200);
    return feet && head ? { feet, head } : null;
  });
  if (meStation) {
    const rMe = bodyRect(meStation, 'me');
    const hideMe = async (on) => p.evaluate((v) => {
      const a = window.game.me?.actor;
      const root = [a?.rig?.group, a?.root, a?.group, a?.mesh].find((o) => o && o.isObject3D);
      if (!root) return false;
      root.visible = v;
      return true;
    }, on);
    const shown = await shoot('me-shown');
    const hid = await hideMe(false);
    const hidden = await shoot('me-hidden');
    await hideMe(true);
    const dMe = rectDiff(shown, hidden, rMe), dCtrl = rectDiff(shown, hidden, ctrl);
    check('a projected rect really does hold that body\'s pixels (hide the local avatar)',
      hid && dMe > 0.10 && dMe > 3 * dCtrl,
      `${pct(dMe)} of her own rect ${rMe.x},${rMe.y} ${rMe.w}×${rMe.h} changed, ${pct(dCtrl)} of the control`);
    // The same claim in the wind-immune metric, which also says *which way* it went: with
    // her hidden the rect must read as ground, i.e. drop towards what the control reads.
    const aMe = alien(shown, rMe, rectStats(shown, ctrl).rgb);
    const aGone = alien(hidden, rMe, rectStats(hidden, ctrl).rgb);
    check('...and hiding her turns that rect back into ground',
      aMe - aGone > 0.08, `${pct(aMe)} of the rect was not-ground with her there, ${pct(aGone)} without`);
  } else {
    check('a projected rect really does hold that body\'s pixels (hide the local avatar)',
      false, 'the local avatar does not project at all — the overlay has no size');
  }

  /* ------------------------------------------------- baseline: nobody there -- */

  // Two readings of the same three rects, kept together because they fail in different
  // ways: the diff needs a partner frame and is the one that survives a body whose colour
  // happens to match the ground, while the silhouette fraction needs only this frame and is
  // the one that survives wind. Every stage below asserts on both.
  const sil = (img) => {
    const ref = rectStats(img, ctrl).rgb;
    return { ref, P1: alien(img, r1, ref), P2: alien(img, r2, ref), ctrl: alien(img, ctrl, ref) };
  };
  const silLine = (tag, s) => `  ${tag.padEnd(11)} not-ground: P1 ${pct(s.P1)} · P2 ${pct(s.P2)}`
    + ` · ctrl ${pct(s.ctrl)}   (this frame's ground = rgb ${s.ref.map((v) => Math.round(v)).join(',')})`;
  // A body fills a body-sized rect: 25-33 points measured. A rect nobody is in holds its
  // value to ±0.5. Both thresholds sit an order of magnitude inside those.
  const FILLED = 0.08, SAME = 0.03;

  const emptyA = await shoot('empty-a');
  await sleep(1800);
  const emptyB = await shoot('empty-b');
  const noise = { P1: rectDiff(emptyA, emptyB, r1), P2: rectDiff(emptyA, emptyB, r2), ctrl: rectDiff(emptyA, emptyB, ctrl) };
  console.log(`  noise floor (two empty frames): P1 ${pct(noise.P1)} · P2 ${pct(noise.P2)} · ctrl ${pct(noise.ctrl)}`);
  // Signal has to beat the frame's own restlessness by a margin *and* clear an absolute
  // floor, so a very quiet frame cannot make a 1% diff look like a person.
  const arrived = (d, n) => d > Math.max(0.10, 4 * n);

  const emptyRefA = sil(emptyA), emptyRef = sil(emptyB);
  console.log(silLine('empty-a', emptyRefA));
  console.log(silLine('empty-b', emptyRef));
  // The metric's own noise floor, on the same two frames the diff floor came from. If the
  // wind moves *this* number too then the readings below prove nothing, and it is better to
  // know that here than to explain a 9-point arrival later.
  const drift = Math.max(...['P1', 'P2', 'ctrl'].map((k) => Math.abs(emptyRefA[k] - emptyRef[k])));
  check('the silhouette metric is steady across two empty frames',
    drift < SAME, `worst rect drifted ${pct(drift)}, and an arrival is worth ${pct(FILLED)}+`);

  const chatBefore = await p.evaluate(() => document.querySelector('.chatlog')?.textContent || '');

  /* --------------------------------------------------------------- the ghost -- */

  const acc = await mintGuest(API);
  ghost = await connectGhost(API, acc, { tag: 'ghost' });
  const welcome = await ghost.hello(ZONE, 'online');
  if (!check('the second player got a WELCOME', !!welcome, welcome ? `${welcome.zone}#${welcome.shard}` : 'none')) {
    throw new Error('ghost never joined');
  }
  check('the second player is in the same zone', welcome.zone === ZONE, welcome.zone);
  // The one precondition that cannot be worked around: matchmaking puts both in the
  // fullest shard with room, so a mismatch here means the zone was already busy and
  // nothing below would be measuring what it claims.
  if (!check('...and in the same shard as the browser', String(welcome.shard) === String(st.shard),
    `${welcome.shard} vs ${st.shard}`)) throw new Error('different shards');
  // Identity comes off the WELCOME, not off the mint response, and it is read once here so
  // the assertions after `ghost.close()` still know who to look for.
  const gid = Number(ghost.playerId), gnick = ghost.nickname;
  console.log(`  ghost: ${gnick} (#${gid}) spawned at ${ghost.x.toFixed(1)}, ${ghost.z.toFixed(1)}`);

  // Walk to the first station, sampling the *remote* locomotion speed the browser derives
  // while it happens: `_syncPlayers` computes it from the snapshot pair, and it is what
  // decides whether the model runs or slides.
  //
  // Sampled **inside the page, once per frame**, by wrapping `actors.update` — because `speed`
  // is a per-frame quantity and polling it from out here reads the frames a round-trip happens
  // to land on. The ghost covers the 9.2 m to P1 in 1.65 s and llvmpipe draws 3 fps under suite
  // load, so the whole walk fits between two `p.evaluate` calls: this assertion once reported
  // `peak 0.00 m/s` in a run where the same ghost's body changed 37.6% of the P1 rect. `frames`
  // is printed beside the peak for the same reason — a zero over 0 frames is a probe that never
  // looked, a zero over 40 is the product — and so is the animator's own base clip, which is
  // what the player actually sees: a remote player whose speed reads zero is *sliding*, feet
  // planted in `idle`, and that is a claim about the pose rather than about a number.
  const STEP = 0.9, PACKET_MS = 150, GHOST_MPS = STEP / (PACKET_MS / 1000);
  //
  // The recorder also keeps the *input* to that derivation — how far the ghost's row moved
  // between the two snapshots each frame was interpolated from — because "the speed came out
  // zero" has two completely different causes and the fix is in a different file for each: a
  // derivation that dropped the movement, or a pair of snapshots the ghost had not moved between
  // (which is a claim about the window this frame was drawn against, and makes the assertion
  // below unanswerable rather than false).
  await p.evaluate((id) => {
    const g = window.game;
    const fresh = () => ({ peak: 0, frames: 0, seen: 0, poses: [], noWin: 0, noRow: 0,
      pairMax: 0, spans: [], moves: [], dts: [] });
    window.__spd = fresh();
    window.__spdReset = () => { window.__spd = fresh(); };
    const inner = g.actors.update.bind(g.actors);
    g.actors.update = (dt, t, win) => {
      const out = inner(dt, t, win);
      const s = window.__spd;
      s.frames++;
      if (s.dts.length < 40) s.dts.push(+dt.toFixed(3));
      if (!win) s.noWin++;
      else {
        const row = (snap) => (snap.data.players || []).find((r) => Number(r.id) === id);
        const ra = row(win.a), rb = row(win.b);
        if (!ra || !rb) s.noRow++;
        else {
          const d = Math.hypot(rb.x - ra.x, rb.z - ra.z);
          s.pairMax = Math.max(s.pairMax, d);
          if (s.moves.length < 40) {
            s.moves.push(+d.toFixed(2));
            s.spans.push(win.b.serverNow - win.a.serverNow);
          }
        }
      }
      const e = g.actors.players.get(id);
      if (!e) return out;
      s.seen++;
      s.peak = Math.max(s.peak, e.speed);
      const base = e.actor.animator?.base;
      if (base && !s.poses.includes(base)) s.poses.push(base);
      return out;
    };
  }, gid);
  await ghost.walkTo(P1.x, P1.z, { y: P1.y, step: STEP, ms: PACKET_MS });
  await ghost.stand({ ry: Math.atan2(st.me.x - P1.x, st.me.z - P1.z) });
  const spd = await p.evaluate(() => window.__spd);
  check('no correction: the server accepted the walk', !ghost.corrected,
    ghost.corrected ? JSON.stringify(ghost.corrected) : 'none');

  await sleep(2500);
  const at1 = await shoot('joined-P1');
  st = await state();
  const them = st.players.find((q) => Number(q.id) === gid);
  if (!check('the browser built a remote actor for them', !!them,
    `${st.players.length} remote player(s): ${JSON.stringify(st.players.map((q) => q.nickname))}`)) {
    throw new Error('no remote actor');
  }
  check('...carrying their nickname and a character model',
    them.nickname === gnick && !!them.charId, `${them.nickname} as ${them.charId}`);
  check('...at the position they walked to',
    Math.hypot(them.x - P1.x, them.z - P1.z) < 2.0,
    `client has ${them.x}, ${them.z}; they walked to ${P1.x}, ${P1.z}`);
  check('...with hp the plate can draw', them.hp > 0 && them.maxHp > 0, `${them.hp}/${them.maxHp}`);
  // Bounded from both sides against the speed the ghost was *driven* at, rather than against a
  // number typed here: 0.9 m every 150 ms is 6 m/s, and the ceiling matters too — `_syncPlayers`
  // clamps at 12 m/s, so a derivation that double-counted the snapshot span would sit at the
  // clamp and still be "greater than 2".
  console.log(`  (${spd.frames} frame(s) drawn during the walk, ${spd.seen} with the ghost in them,`
    + ` ${spd.noWin} with no snapshot window, ${spd.noRow} with no row for them;`
    + ` dt ${spd.dts.join('/')} s; the pair each frame interpolated moved them`
    + ` ${spd.moves.join('/')} m over ${spd.spans.join('/')} ms)`);
  // The precondition: this claim is about a *derivation*, and it cannot be answered on frames whose
  // snapshot pair does not straddle any movement — at 2-3 fps under llvmpipe a whole 1.65 s walk
  // can be drawn from windows that each sit inside one 100 ms step.
  const pairMps = spd.pairMax / ((spd.spans[0] || 100) / 1000);
  if (spd.pairMax < 0.02) {
    const why = `none of the ${spd.frames} frame(s) drawn during the walk was interpolated across a`
      + ' pair the ghost moved in, so nothing was asked of the derivation';
    skip('the remote locomotion speed was driven by the walk, not left at zero', why);
    // The clip follows from the speed, so it is the same unanswered question wearing a pose.
    skip('...and the model was in a locomotion pose while they moved, not sliding in idle', why);
  } else {
    check('the remote locomotion speed was driven by the walk, not left at zero',
      spd.peak > GHOST_MPS * 0.5 && spd.peak < GHOST_MPS * 1.9,
      `peak ${spd.peak.toFixed(2)} m/s against the ${GHOST_MPS.toFixed(2)} m/s the ghost ran`
      + ` (the widest pair drawn was worth ${pairMps.toFixed(2)} m/s),`
      + ` over ${spd.seen} of ${spd.frames} frame(s) drawn during the walk`);
    check('...and the model was in a locomotion pose while they moved, not sliding in idle',
      spd.poses.some((b) => ['walk', 'run', 'sprint'].includes(b)),
      `base clip(s) ${spd.poses.length ? spd.poses.join(', ') : 'none — they were never on a drawn frame'}`);
  }

  const joinLine = await p.evaluate((before) => {
    const now = document.querySelector('.chatlog')?.textContent || '';
    return now.slice(before.length);
  }, chatBefore);
  check('the chat log announced them by name', joinLine.includes(gnick)
    && joinLine.includes('进入'), JSON.stringify(joinLine.trim().slice(0, 80)));

  /** The name plate for one player: its text and where on screen it is. */
  const plateOf = (nick) => p.evaluate((n) => {
    for (const el of document.querySelectorAll('.wlabel')) {
      if (el.style.display === 'none') continue;
      const who = el.querySelector('.who')?.textContent || '';
      if (who !== n) continue;
      const r = el.getBoundingClientRect();
      return { who, x: Math.round(r.x + r.width / 2), y: Math.round(r.y), w: Math.round(r.width) };
    }
    return null;
  }, nick);
  const plate1 = await plateOf(gnick);
  check('a name plate over them says who they are', !!plate1 && plate1.w > 0,
    plate1 ? `"${plate1.who}" at ${plate1.x},${plate1.y}` : 'no visible plate with that name');

  const d1 = { P1: rectDiff(emptyB, at1, r1), P2: rectDiff(emptyB, at1, r2), ctrl: rectDiff(emptyB, at1, ctrl) };
  const v1 = sil(at1);
  console.log(`  joined vs empty: P1 ${pct(d1.P1)} · P2 ${pct(d1.P2)} · ctrl ${pct(d1.ctrl)}`);
  console.log(silLine('joined', v1));
  check('their body is on screen where the client says they are (pixels, not state)',
    arrived(d1.P1, noise.P1), `${pct(d1.P1)} of the P1 rect changed, noise ${pct(noise.P1)}`);
  check('...and that rect now holds something that is not this ground',
    v1.P1 - emptyRef.P1 > FILLED, `not-ground ${pct(emptyRef.P1)} → ${pct(v1.P1)}`);
  check('the control rect on the far side of the frame did not change',
    d1.ctrl < Math.max(0.06, 3 * noise.ctrl) && Math.abs(v1.ctrl - emptyRef.ctrl) < SAME,
    `${pct(d1.ctrl)} changed (noise ${pct(noise.ctrl)}), not-ground ${pct(emptyRef.ctrl)} → ${pct(v1.ctrl)}`);
  // The other station is the second control, and it is the one that matters: it is the same
  // *kind* of place as P1 — the ground a player could be standing on — and nobody is there
  // yet. Without it, "the rect changed" is satisfied by anything that moved in that half of
  // the frame.
  check('and nothing appeared at the station they are not standing in',
    Math.abs(v1.P2 - emptyRef.P2) < SAME, `not-ground ${pct(emptyRef.P2)} → ${pct(v1.P2)}`);
  const s1 = rectStats(at1, r1);
  console.log(`  P1 rect: lum ${s1.lum} std ${s1.std} rgb ${JSON.stringify(s1.rgb)}`);

  /* ------------------------------------------------------- and now they move -- */

  await ghost.walkTo(P2.x, P2.z, { y: P2.y });
  await ghost.stand({ ry: Math.atan2(st.me.x - P2.x, st.me.z - P2.z) });
  await sleep(2500);
  const at2 = await shoot('walked-P2');
  const d2 = { P1: rectDiff(at1, at2, r1), P2: rectDiff(at1, at2, r2), ctrl: rectDiff(at1, at2, ctrl) };
  const v2 = sil(at2);
  console.log(`  after the walk vs before: P1 ${pct(d2.P1)} · P2 ${pct(d2.P2)} · ctrl ${pct(d2.ctrl)}`);
  console.log(silLine('walked', v2));
  // "Emptied" is the half a one-sided probe never checks, and it is stated in the absolute
  // metric on purpose: a diff at P1 is equally consistent with them still standing there
  // waving. This says the rect is *ground again*, back within a few points of the baseline.
  check('walking away emptied the rect they were standing in',
    arrived(d2.P1, noise.P1) && Math.abs(v2.P1 - emptyRef.P1) < SAME,
    `${pct(d2.P1)} of P1 changed, not-ground ${pct(v1.P1)} → ${pct(v2.P1)} (empty was ${pct(emptyRef.P1)})`);
  check('...and filled the one they walked to',
    arrived(d2.P2, noise.P2) && v2.P2 - emptyRef.P2 > FILLED,
    `${pct(d2.P2)} of P2 changed, not-ground ${pct(emptyRef.P2)} → ${pct(v2.P2)}`);
  check('...while the control rect stayed put',
    d2.ctrl < Math.max(0.06, 3 * noise.ctrl) && Math.abs(v2.ctrl - emptyRef.ctrl) < SAME,
    `${pct(d2.ctrl)} changed, not-ground ${pct(v2.ctrl)}`);

  const plate2 = await plateOf(gnick);
  const wantSign = Math.sign(P2.feet.x - P1.feet.x);
  check('their name plate travelled with them',
    !!plate2 && Math.abs(plate2.x - plate1.x) > 60 && Math.sign(plate2.x - plate1.x) === wantSign,
    plate2 ? `plate x ${plate1.x} → ${plate2.x}, expected sign ${wantSign}` : 'plate vanished');

  const stMoved = await state();
  const them2 = stMoved.players.find((q) => Number(q.id) === gid);
  check('the client tracked them to the second station',
    !!them2 && Math.hypot(them2.x - P2.x, them2.z - P2.z) < 2.0,
    them2 ? `${them2.x}, ${them2.z} vs ${P2.x}, ${P2.z}` : 'gone');

  /* ------------------------------------------------ a swing and a chat line -- */

  ghost.send(C2S.ATTACK, {});
  let clip = null;
  for (let i = 0; i < 40; i++) {
    clip = await p.evaluate((id) => {
      const e = window.game.actors.players.get(id);
      const cur = e?.actor?.animator?.currentAction ?? null;
      const seen = (window.__mp.actions || []).filter((a) => Number(a.playerId) === Number(id))
        .map((a) => a.action);
      return { cur, busy: !!e?.actor?.animator?.busy, seen };
    }, gid);
    if (clip.seen.includes('normal')) break;
    await sleep(200);
  }
  check('their attack reached the browser as an event', clip.seen.includes('normal'),
    JSON.stringify(clip.seen.slice(-4)));
  // The animation is the visible half. `_onPlayerAction` maps `normal` → `attack<combo+1>`,
  // and the clip is a one-shot overlay, so `currentAction` is the attack for as long as it
  // runs — several seconds of wall clock at llvmpipe's frame rate.
  let swung = false;
  for (let i = 0; i < 30 && !swung; i++) {
    const cur = await p.evaluate((id) => window.game.actors.players.get(id)?.actor?.animator?.currentAction ?? null,
      gid);
    if (cur && /^attack|charged/.test(cur)) { swung = true; clip.cur = cur; }
    else await sleep(150);
  }
  check('...and the remote model played the swing', swung, `clip ${clip.cur}`);

  const marker = `mp-view ${Date.now() % 100000}`;
  const chatMid = await p.evaluate(() => document.querySelector('.chatlog')?.textContent || '');
  ghost.send(C2S.CHAT, { body: marker, channel: 'zone' });
  let chatDelta = '';
  for (let i = 0; i < 30; i++) {
    chatDelta = await p.evaluate((before) => (document.querySelector('.chatlog')?.textContent || '').slice(before.length), chatMid);
    if (chatDelta.includes(marker)) break;
    await sleep(300);
  }
  check('what they say appears in the chat log, attributed to them',
    chatDelta.includes(marker) && chatDelta.includes(gnick),
    JSON.stringify(chatDelta.trim().slice(0, 90)));

  /* ---------------------------------------------- 助战: the co-op loot line -- */

  // `mp-check` proves the gateway pays a helper their own LOOT with `assist: true`; this is
  // the far end of that wire, and the wire is the point — a flag the client receives and
  // never prints is the same as no flag at all. A *real* assist needs a corpse two players
  // fought over, which is minutes of llvmpipe combat, so the message is handed to the
  // client's own dispatcher (`socket._route`, the function `ws.onmessage` calls) instead of
  // being faked further in: the path under test is `_route → _onLoot → emit('loot') → hud`.
  //
  // Both readings, because 「没有助战字样」 is equally true of a line that never appeared:
  // the control is the same message with the flag left off.
  {
    const inject = async (assist) => {
      const before = await p.evaluate(() => document.querySelector('.chatlog')?.textContent || '');
      await p.evaluate((as) => {
        window.game.socket._route({
          t: 'loot',
          d: { from: 'hilichurl', enemyId: 'probe-corpse', items: { mora: 7 }, xp: 5, assist: as || undefined },
        });
      }, assist);
      for (let i = 0; i < 20; i++) {
        const now = await p.evaluate(() => document.querySelector('.chatlog')?.textContent || '');
        if (now.length > before.length) return now.slice(before.length).trim();
        await sleep(150);
      }
      return '';
    };
    const helper = await inject(true);
    check('a helper\'s drop says 助战 in the loot line',
      /助战/.test(helper) && /获得/.test(helper) && /摩拉/.test(helper),
      JSON.stringify(helper.slice(0, 60)));
    const own = await inject(false);
    check('...and a drop off your own kill does not',
      /获得/.test(own) && /摩拉/.test(own) && !/助战/.test(own), JSON.stringify(own.slice(0, 60)));
  }

  await shoot('with-plate');

  /* -------------------------------------------------------- and they leave -- */

  ghost.close();
  ghost = null;
  let gone = null;
  for (let i = 0; i < 40; i++) {
    gone = await p.evaluate((id) => ({
      still: window.game.actors.players.has(id),
      leaves: (window.__mp.leaves || []).map((l) => Number(l.playerId)),
    }), gid);
    if (!gone.still) break;
    await sleep(500);
  }
  check('leaving removed the remote actor', !gone.still, `leave events ${JSON.stringify(gone.leaves)}`);
  const plateGone = await plateOf(gnick);
  check('...and took their name plate with it', !plateGone,
    plateGone ? `plate still at ${plateGone.x},${plateGone.y}` : 'no plate');

  const after = await shoot('left');
  const d3 = { P2: rectDiff(at2, after, r2), ctrl: rectDiff(at2, after, ctrl) };
  const v3 = sil(after);
  console.log(`  after they left vs while they stood there: P2 ${pct(d3.P2)} · ctrl ${pct(d3.ctrl)}`);
  console.log(silLine('left', v3));
  check('the pixels they occupied went back to the world behind them',
    arrived(d3.P2, noise.P2), `${pct(d3.P2)} of P2 changed`);
  // The closing pin, and the strictest one: the rect has to read as the same ground it read
  // as before anyone was there. Anything left behind — a stuck model, a frozen plate, a
  // half-faded ghost — shows up here as a rect that never came back down.
  check('...and that rect now matches the frame from before they arrived',
    Math.abs(v3.P2 - emptyRef.P2) < SAME,
    `not-ground ${pct(emptyRef.P2)} (empty) → ${pct(v2.P2)} (standing there) → ${pct(v3.P2)} (gone)`);
  check('...while the control rect read the same at the end as at the start',
    Math.abs(v3.ctrl - emptyRef.ctrl) < SAME, `not-ground ${pct(emptyRef.ctrl)} → ${pct(v3.ctrl)}`);
  // Every screenshot above waited for real frames; if any wait timed out, the PNG it
  // produced is a repeat of an older one and the assertions that read it are worthless.
  check('no screenshot was taken on a stalled renderer',
    stalled.length === 0, stalled.length ? `stale: ${stalled.join(', ')}` : `${step} frames, all fresh`);
} catch (e) {
  console.log(`\nABORTED: ${e.message}`);
  fail++;
} finally {
  ghost?.close();
}

console.log('\nerrors ->', errs.length ? JSON.stringify([...new Set(errs)].slice(0, 6)) : 'none');
console.log('hmr    ->', hmr.length ? `${hmr.length} update(s) — RUN IS INVALID` : 'none');
check('no page errors during the run', errs.length === 0, `${errs.length}`);
check('client/src was not hot-updated mid-run', hmr.length === 0, `${hmr.length}`);
console.log(`\n${pass} passed, ${fail} failed${skips ? `, ${skips} skipped` : ''}`);
await b.close();
// A green run has to have counted something. The `catch` above turns a bail into one FAIL,
// which is honest but small: without this floor, an exception three assertions in would be
// reported as "3 passed, 1 failed" and read like a single narrow defect.
if (pass + fail < 30) {
  console.log(`only ${pass + fail} assertions ran — this probe has 45; something bailed early`);
  process.exit(1);
}
process.exit(fail ? 1 : 0);
