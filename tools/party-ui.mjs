// 元素共鸣呈现层 probe: does the player ever *see* the resonance, and do the six new
// characters exist as models rather than as rows in a table?
//
//   DISPLAY=:99 node tools/party-ui.mjs [baseUrl] [outDir]
//
// `resonance-check.mjs` proves the simulation half — 38 measured assertions, each with a
// party that activates nothing and a benched character that must not move. None of it is
// reachable by a player who cannot read the source: a bonus that comes from the *shape* of
// the team is only a decision if the team screen says what the shape is worth, and says it
// for the resonances the party does *not* have as well (the off state is the instruction
// for how to get one).
//
// So this drives the two surfaces the table feeds:
//
//   1. the 元素共鸣 list in the 队伍 panel, for every resonance in `RESONANCES`, in both
//      states, with the *same row* measured on and off. Class, computed style and pixels:
//      a `classList` assertion passes while the row is painted in the background colour,
//      and this repo has shipped exactly that bug before.
//   2. the six sheets the roster grew by. `humanoid-check.mjs` bakes every body block in
//      Node and reports NaN vertices, which is not the same question as "is there a person
//      on screen": a rig can be built, lit and still be invisible. Every character is
//      rendered from a fixed camera and measured against a baseline frame with the avatar
//      hidden, so coverage is projected pixels, not hope.
//
// Both parties and both texts are derived, never typed: the ON/OFF parties come out of
// `rosterByElement()`, the expected lit set out of `partyResonances()`, and the expected
// strings out of `resonanceHint`/`resonanceCondition`. Retuning a resonance or adding a
// character must not need an edit here.
//
// Two deliberate choices worth stating:
//
//   - The party is set through `game.applyBuild(stats, party)` — the one door panels use
//     after the server confirms an edit, and the same message the gateway sends online.
//     The stat blocks come from `partyStats` in Node, so the sim really does receive four
//     live characters. What this skips is `POST /api/player/party`'s ownership filter,
//     which `api-check` owns: a fresh guest owns two characters, so no honest sequence of
//     REST calls can field two 炎 characters, and 20 wishes' worth of primogems bought one
//     new sheet when the probe tried.
//   - Pixel reads happen with the canvas hidden. The panel dims the scene behind a scrim,
//     and measuring a lit row *through* a live 3D frame is how a previous probe in this
//     repo read a violet line as grey.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import {
  RESONANCES, resonanceHint, resonanceCondition, partyResonances, rosterByElement,
  RESONANCE_NEED, DISTINCT_NEED,
} from '../shared/src/data/resonance.js';
import { CHARACTERS, CHARACTER_IDS } from '../shared/src/data/characters.js';
import { partyStats } from '../shared/src/sim/loot.js';
import { decodePng, rectStats, pixelsDiffering } from './lib/png.mjs';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/party-ui';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });
// Frames from an earlier run are numbered by step, and the step numbers move when a section
// gains an assertion — so an old `12-wind-on.png` next to a new one is a trap for whoever
// opens the directory to look at what failed.
for (const f of readdirSync(outDir)) if (f.endsWith('.png')) rmSync(`${outDir}/${f}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}
function skip(name, why) { console.log(`  SKIP ${name} — ${why}`); }

/* ------------------------------------------------------------ the parties -- */

const roster = rosterByElement();
const LEVEL = { level: 40, ascension: 2 };
/** A stat block per character, the shape `applyBuild` expects from either host. */
const statsFor = (party) => partyStats(
  Object.fromEntries(party.map((id) => [id, { charId: id, ...LEVEL }])), party,
);

/** One character of each element other than `exclude`, in roster order. */
function fillers(exclude, n) {
  const out = [];
  for (const [el, ids] of Object.entries(roster)) {
    if (exclude.includes(el) || out.length >= n) continue;
    out.push(ids[0]);
    exclude = [...exclude, el];
  }
  return out;
}

/**
 * The ON and OFF party for one resonance.
 *
 * Three characters, not four, for the elemental ones: a fourth would make the party four
 * distinct elements and light 四象庇护 as well, and a row that is on in both states of a
 * neighbouring test is a row this probe cannot use as its own control. 四象庇护 is the
 * mirror image — its ON case *is* the four-distinct party and its OFF case drops one.
 */
function parties(r) {
  if (r.distinct) {
    const four = Object.values(roster).slice(0, DISTINCT_NEED).map((ids) => ids[0]);
    return { on: four, off: four.slice(0, DISTINCT_NEED - 1) };
  }
  const pair = roster[r.element]?.slice(0, RESONANCE_NEED) || [];
  const rest = fillers([r.element], 2);
  return { on: [...pair, rest[0]], off: [pair[0], ...rest] };
}

/* --------------------------------------------------------------- the page -- */

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
async function shot(name) {
  step++;
  const file = `${outDir}/${String(step).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file });
  const drained = logs; logs = [];
  if (drained.length) console.log(`     (${drained.length} console lines) ${drained.slice(-3).join(' | ')}`);
  return { img: decodePng(readFileSync(file)), file };
}

/** Everything the resonance list says, plus the geometry and the painted colours. */
const readRows = () => p.evaluate(() => {
  const rows = [...document.querySelectorAll('.panel .res-row')];
  return rows.map((el) => {
    const cs = getComputedStyle(el);
    const bEl = el.querySelector('b'), iEl = el.querySelector('i'), sEl = el.querySelector('small');
    const rect = el.getBoundingClientRect();
    // A row's rect is a rect whether or not the scroller is showing that part of the column,
    // so "is this strip of the screenshot actually this row?" needs the clip box too.
    let sc = el.parentElement;
    while (sc && sc.scrollHeight <= sc.clientHeight + 1) sc = sc.parentElement;
    const box = (sc || document.documentElement).getBoundingClientRect();
    return {
      id: el.dataset.res,
      on: el.classList.contains('on'),
      visible: rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5,
      opacity: Number(cs.opacity),
      border: cs.borderLeftColor,
      name: bEl?.textContent || '',
      cond: iEl?.textContent || '',
      hint: sEl?.textContent || '',
      nameColor: bEl ? getComputedStyle(bEl).color : '',
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
  });
});

/** The four party slots as the player reads them. */
const readSlots = () => p.evaluate(() => [...document.querySelectorAll('.panel .col.side .grid .slot')]
  .map((s) => ({ empty: s.classList.contains('empty'), name: s.querySelector('.nm')?.textContent || '' })));

/**
 * Hand the game a party the way a confirmed panel edit does, then redraw the panel.
 *
 * `applyBuild` is deliberately the only door (see `game.js`): it stores the stat blocks,
 * pushes them into the host that owns the entity, and moves the model to whoever is on
 * field. Reopening the panel afterwards is exactly what `_act(...).then(() => _render())`
 * does after `POST /api/player/party` answers.
 */
async function useParty(party) {
  const applied = await p.evaluate(([ps, stats]) => {
    const g = window.game;
    const res = g.applyBuild(stats, ps);
    g.emit('togglePanel', { panel: 'party', open: true });
    return { party: res, charId: g.me?.charId, statKeys: Object.keys(g.stats || {}) };
  }, [party, statsFor(party)]);
  for (let i = 0; i < 30; i++) {
    const n = await p.evaluate(() => document.querySelectorAll('.panel .res-row').length);
    if (n) break;
    await sleep(150);
  }
  return applied;
}

const hideCanvas = (hidden) => p.evaluate((h) => {
  for (const c of document.querySelectorAll('canvas')) c.style.visibility = h ? 'hidden' : '';
  return document.querySelectorAll('canvas').length;
}, hidden);

/**
 * Let the compositor catch up before a screenshot.
 *
 * The first run of this probe read Δlum 0.0 on every row and 876 differing pixels between
 * two frames that should have looked plainly different — because llvmpipe renders this
 * scene at 2 fps and a screenshot taken 250 ms after the panel opened is a composite from
 * before it existed. Two animation frames plus a beat is the wait; the assertions below
 * still carry their own staleness control, because a wait is a hope and a diff is evidence.
 */
async function settle(extra = 350) {
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
  await sleep(extra);
}

const pad = (r, label) => ({ x: Math.max(0, r.x - 1), y: Math.max(0, r.y - 1), w: r.w + 2, h: r.h + 2, label });

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);

  // 单机模式 first: this probe never needs the gateway, and a solo tab hosts the same
  // simulation, so a resonance the panel claims is a resonance this tab is running.
  check('the login screen offers 单机模式', await p.evaluate(() => {
    const btn = document.querySelector('[data-act="solo"]');
    if (!btn) return false;
    btn.click();
    return true;
  }));
  await sleep(400);
  const guest = await p.$('[data-act="guest"]') || await p.$('[data-act="resume"]');
  await guest.click();
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  const me = await p.evaluate(() => ({
    running: !!window.game?._running, mode: window.game?.mode, playerId: window.game?.playerId,
  }));
  check('the solo world booted', me.running === true && !!me.playerId, `player ${me.playerId}, mode ${me.mode}`);
  await sleep(2500);

  // llvmpipe boots every browser probe at `low`, and `low` is a frame the target hardware
  // never shows. Pin the tier before a single pixel is measured.
  await p.evaluate(() => {
    window.game.setAutoQuality(false);
    window.game.setQuality('high');
    // Noon, pinned: see daylight-check.mjs — the authored sky is what 12:00 returns.
    window.game.setWorldTime(12);
  });
  await sleep(3000);
  const tier = await p.evaluate(() => window.game.quality);
  check('the quality tier is pinned to high', tier === 'high', `tier ${tier}`);

  /* ================================================== 1. the resonance list -- */

  console.log('\n== 元素共鸣 rows, each measured on and off ==');

  const first = await useParty(parties(RESONANCES.fire).on);
  const rows0 = await readRows();
  check('the 队伍 panel draws one row per resonance',
    rows0.length === Object.keys(RESONANCES).length,
    `${rows0.length} rows: ${rows0.map((r) => r.id).join(' ')}`);
  check('...and every row names its resonance',
    rows0.every((r) => r.name === RESONANCES[r.id]?.name),
    rows0.map((r) => r.name).join(' '));
  check('...and the party the sim is running is the party the panel drew',
    first.party?.join(',') === parties(RESONANCES.fire).on.join(','),
    `sim ${first.party?.join(',')} / on field ${first.charId}`);
  const slots0 = await readSlots();
  check('...and the party grid shows those characters',
    parties(RESONANCES.fire).on.every((id, i) => slots0[i]?.name === CHARACTERS[id].name),
    slots0.map((s) => s.name).join(' '));

  // Pixel reads happen with the 3D canvas hidden and the render loop stopped: the panel
  // dims the scene behind a scrim, and a lit row measured through a live frame is how a
  // probe in this repo once read a violet line as grey. Stopping the loop also takes the
  // 2 fps llvmpipe frame budget out of the compositor's way.
  await hideCanvas(true);
  await p.evaluate(() => { document.querySelector('.scrim .close')?.click(); window.game.stop(); });
  await settle(500);
  const closed = await shot('panel-closed');

  let controls = 0;
  for (const r of Object.values(RESONANCES)) {
    const { on: onParty, off: offParty } = parties(r);
    console.log(`\n-- ${r.id} (${r.name}): on ${onParty.join('+')} / off ${offParty.join('+')} --`);
    if (onParty.length < (r.distinct || RESONANCE_NEED)) {
      skip(`${r.id} both states`, `the roster cannot field it: ${onParty.join(',')}`);
      continue;
    }

    const state = {};
    for (const which of ['on', 'off']) {
      await useParty(which === 'on' ? onParty : offParty);
      // The side column scrolls, and the last two rows of the table sit below its fold on a
      // 900 px viewport. Their `getBoundingClientRect` is still a rect, so the first version
      // of this probe measured a clipped strip and reported Δlum 0.0 for 皓光同辉 and
      // 四象庇护 while every text and style assertion on the same rows passed. Scroll the
      // row under test into view the way a player does, then re-read the geometry.
      await p.evaluate((id) => {
        document.querySelector(`.panel .res-row[data-res="${id}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'instant' });
      }, r.id);
      await settle();
      const rows = await readRows();
      const { img } = await shot(`${r.id}-${which}`);
      state[which] = { rows, img, row: rows.find((x) => x.id === r.id) };
    }

    // Two frames that must differ, and a region that must have appeared. Without them the
    // colour assertions below can be answered by a composite from before the panel opened,
    // which is exactly what the first run of this probe measured.
    const span = state.on.rows.reduce((a, x) => ({
      x: Math.min(a.x, x.rect.x), y: Math.min(a.y, x.rect.y),
      x2: Math.max(a.x2, x.rect.x + x.rect.w), y2: Math.max(a.y2, x.rect.y + x.rect.h),
    }), { x: 1e9, y: 1e9, x2: 0, y2: 0 });
    const listBox = { x: span.x, y: span.y, w: span.x2 - span.x, h: span.y2 - span.y, label: 'res-list' };
    check(`${r.id}: the list is painted where the DOM says it is`,
      Math.abs(rectStats(state.on.img, listBox).lum - rectStats(closed.img, listBox).lum) > 2,
      `list ${listBox.w}x${listBox.h} at ${listBox.x},${listBox.y}: lum ${rectStats(state.on.img, listBox).lum} vs ${rectStats(closed.img, listBox).lum} with the panel closed`);
    check(`${r.id}: the two frames are not the same frame`,
      pixelsDiffering(state.on.img, state.off.img, 4) > 200,
      `${pixelsDiffering(state.on.img, state.off.img, 4)} px differ`);

    // The lit set, both ways: the row under test must light only in the ON state, and no
    // other row may light along with it. `partyResonances` writes the expectation, so a
    // retuned table cannot leave this probe asserting yesterday's answer.
    for (const which of ['on', 'off']) {
      const party = which === 'on' ? onParty : offParty;
      const want = partyResonances(party).map((x) => x.id).sort().join(',');
      const got = state[which].rows.filter((x) => x.on).map((x) => x.id).sort().join(',');
      check(`${r.id}/${which}: exactly the resonances the party has are lit`, want === got,
        `want [${want || '-'}] got [${got || '-'}]`);
    }
    check(`${r.id}: the row is lit with the pair and dim without it`,
      state.on.row?.on === true && state.off.row?.on === false,
      `on=${state.on.row?.on} off=${state.off.row?.on}`);

    // The text, both states, derived from the effect object rather than restated.
    check(`${r.id}: the lit row reads 已激活`, state.on.row?.cond === '已激活', state.on.row?.cond);
    check(`${r.id}: the dim row states the condition instead`,
      state.off.row?.cond === resonanceCondition(r), `${state.off.row?.cond} vs ${resonanceCondition(r)}`);
    check(`${r.id}: both states spell out what it gives`,
      state.on.row?.hint === resonanceHint(r) && state.off.row?.hint === resonanceHint(r),
      state.on.row?.hint);

    // Style, not class: opacity, the left rule and the title colour all have to move, or
    // the two states differ by a class name nobody can see.
    check(`${r.id}: the lit row is fully opaque and the dim one is not`,
      state.on.row?.opacity === 1 && state.off.row?.opacity < 0.9,
      `${state.on.row?.opacity} vs ${state.off.row?.opacity}`);
    check(`${r.id}: only the lit row carries the gold rule and gold title`,
      state.on.row?.border !== state.off.row?.border && state.on.row?.nameColor !== state.off.row?.nameColor,
      `border ${state.on.row?.border} / ${state.off.row?.border}; title ${state.on.row?.nameColor} / ${state.off.row?.nameColor}`);

    // …and pixels, with a control row that must not move. The rects come from the DOM in
    // each state (the list does not reflow, but reading them per state costs nothing and
    // means a future layout change cannot make this measure the wrong strip).
    // The control has to be a row whose *pixels* are comparable across the two frames, which
    // means off in both **and** fully inside the scroller in both. Since `panels.js` sorts the
    // active resonances to the top, the two frames do not agree on row order: for 皓光同辉 the
    // control (炎炎不息) sat at index 0 in the ON frame and was scrolled half out of the column
    // in the OFF one, so its rect covered panel background and the control "moved" by Δlum 3.0
    // — a real change in what the rect contained, not a change of state. Widening the tolerance
    // would have hidden it; picking a control that is on screen in both frames is the claim.
    const visibleBoth = (id) => state.on.rows.find((y) => y.id === id)?.visible
      && state.off.rows.find((y) => y.id === id)?.visible;
    const other = state.off.rows.find((x) => x.id !== r.id && !x.on
      && !state.on.rows.find((y) => y.id === x.id)?.on && visibleBoth(x.id));
    const onPix = rectStats(state.on.img, pad(state.on.row.rect, `${r.id}-on`));
    const offPix = rectStats(state.off.img, pad(state.off.row.rect, `${r.id}-off`));
    const warmOn = onPix.rgb[0] - onPix.rgb[2];
    const warmOff = offPix.rgb[0] - offPix.rgb[2];
    console.log(`     on ${onPix.rgb.join(',')} lum ${onPix.lum} warm ${warmOn} | off ${offPix.rgb.join(',')} lum ${offPix.lum} warm ${warmOff}`);
    check(`${r.id}: the lit row is brighter and warmer in pixels`,
      onPix.lum > offPix.lum + 3 && warmOn > warmOff + 3,
      `Δlum ${(onPix.lum - offPix.lum).toFixed(1)}, Δwarm ${warmOn - warmOff}`);
    if (other) {
      // Per state, not one rect for both frames: each frame was scrolled independently, so
      // a rect read out of the other frame's layout is a rect over the wrong row.
      const cOn = rectStats(state.on.img, pad(state.on.rows.find((x) => x.id === other.id).rect, 'control'));
      const cOff = rectStats(state.off.img, pad(state.off.rows.find((x) => x.id === other.id).rect, 'control'));
      controls++;
      check(`${r.id}: a row that is off in both frames did not move`,
        Math.abs(cOn.lum - cOff.lum) < 2.5,
        `${other.id} lum ${cOn.lum} vs ${cOff.lum}`);
    } else {
      skip(`${r.id} pixel control`,
        'no other row is off and fully on screen in both frames');
    }
  }

  // …and the control itself needs a control: if the visibility requirement above ever starves
  // every row out, the pixel claims lose their only reference and the run still says 0 failed.
  check('most resonances got a pixel control row', controls >= 6,
    `${controls} of ${Object.keys(RESONANCES).length}`);

  await hideCanvas(false);

  /* ================================================ 2. the roster, rendered -- */

  console.log('\n== every character as a model, measured against an empty frame ==');

  await p.evaluate(() => {
    const g = window.game;
    document.querySelector('.scrim .close')?.click();
    g.setPaused(false);
  });
  await sleep(600);

  // Everything below runs against a stopped loop and renders by hand, so a frame is a
  // frame of *this* character rather than of whoever the animator happened to be on.
  //
  // Not at the origin, and not facing away: the spawn point of 蒙德平原 is the fast-travel
  // waypoint, so the first version of this section photographed fourteen characters stood
  // inside a stone pillar with their backs to the camera. `ry = 0` is +z in this engine and
  // the camera sits at +z, so this is a front view.
  const STAGE = { x: 24, z: 22 };
  const staging = await p.evaluate((s) => {
    const g = window.game;
    g.me.teleportTo(s.x, 0, s.z, 0);
    g.stop();
    return { x: g.me.x, y: g.me.y, z: g.me.z, running: !!g._running, slope: g.world.slopeAt?.(s.x, s.z) ?? null };
  }, STAGE);
  check('the avatar is staged on open ground with the loop stopped',
    staging.running === false, `at ${staging.x.toFixed(1)},${staging.y.toFixed(1)},${staging.z.toFixed(1)}`);

  // One camera for all fourteen frames, framed off the *feet* rather than a bone: a rect
  // anchored on the chest moves with the character's height, and then a taller character
  // measures the same pixel span as a shorter one — which is the measurement this section
  // exists to make. The rect is projected from world points (feet, and 2.4 m above them)
  // with the camera's own matrices, the way `npc-cam.mjs` does it — bare specifiers do not
  // resolve in the page, so there is no THREE to borrow a projector from.
  const FRAME = `
    const mulV = (e, x, y, z, w) => [
      e[0] * x + e[4] * y + e[8] * z + e[12] * w,
      e[1] * x + e[5] * y + e[9] * z + e[13] * w,
      e[2] * x + e[6] * y + e[10] * z + e[14] * w,
      e[3] * x + e[7] * y + e[11] * z + e[15] * w,
    ];
    window.__project = (cam, x, y, z, W, H) => {
      let v = mulV(cam.matrixWorldInverse.elements, x, y, z, 1);
      v = mulV(cam.projectionMatrix.elements, v[0], v[1], v[2], v[3]);
      return [(v[0] / v[3] * 0.5 + 0.5) * W, (1 - (v[1] / v[3] * 0.5 + 0.5)) * H];
    };
    window.__frame = (W, H) => {
      const g = window.game, cam = g.camera;
      const fx = g.me.x, fy = g.me.y, fz = g.me.z;
      cam.fov = 40;
      cam.position.set(fx, fy + 1.05, fz + 5.0);
      cam.lookAt(fx, fy + 1.00, fz);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      g.world.sky.update(0.016, cam, fx, fy, fz);
      for (let k = 0; k < 3; k++) g.r.render(0.016);
      const feet = window.__project(cam, fx, fy, fz, W, H);
      const over = window.__project(cam, fx, fy + 2.4, fz, W, H);
      const wide = window.__project(cam, fx + 0.8, fy, fz, W, H);
      return { feet, over, halfW: Math.abs(wide[0] - feet[0]) };
    };
  `;
  await p.evaluate(FRAME);

  // The baseline: the same frame with nobody in it. Coverage is measured against this, so
  // "there is a person on screen" is a count of pixels that changed, not a guess.
  const geom = await p.evaluate(([w, h]) => {
    window.game.me.actor.rig.group.visible = false;
    return window.__frame(w, h);
  }, [W, H]);
  const baseline = (await shot('roster-00-empty')).img;
  await p.evaluate(() => { window.game.me.actor.rig.group.visible = true; });

  // The figure's rect, from the projection: feet at the bottom, 2.4 m of headroom above,
  // ±0.8 m either side. The camera never moves, so it is computed once — and it is taller
  // than any character, which is what makes a pixel height a measurement rather than the
  // rect's own height read back.
  const FIG = {
    x: Math.round(geom.feet[0] - geom.halfW), y: Math.round(geom.over[1]),
    w: Math.round(geom.halfW * 2), h: Math.round(geom.feet[1] - geom.over[1]) + 12, label: 'figure',
  };
  console.log(`     figure rect ${FIG.w}x${FIG.h} at ${FIG.x},${FIG.y} (feet at y=${Math.round(geom.feet[1])})`);
  check('the framing leaves headroom above the tallest sheet',
    FIG.h > 460 && FIG.y > 0 && FIG.x > 0 && FIG.x + FIG.w < W && FIG.y + FIG.h < H,
    `${FIG.w}x${FIG.h} at ${FIG.x},${FIG.y}`);

  /**
   * Pixels inside `FIG` that differ from the empty frame, and their vertical extent.
   *
   * Two extents, because they answer different questions. `n`/`coverage` counts every pixel
   * the character changed at all — that is presence, and the element aura's faint wisps
   * count. `pxHeight` is the span of rows that are *solidly* the character (at least
   * `SOLID` differing pixels across the row), because the aura is a fixed-size glow around
   * everyone: measured with the loose threshold, a 1.54 m sheet and a 1.86 m one came out
   * 498 px and 516 px apart, i.e. the glow, not the body.
   */
  const SOLID = 8;
  function silhouette(img) {
    let n = 0, left = FIG.x + FIG.w, right = FIG.x;
    let top = -1, bottom = -1;
    for (let y = FIG.y; y < FIG.y + FIG.h; y++) {
      let row = 0;
      for (let x = FIG.x; x < FIG.x + FIG.w; x++) {
        const i = (y * img.width + x) * 4;
        const d = Math.abs(img.data[i] - baseline.data[i]) + Math.abs(img.data[i + 1] - baseline.data[i + 1])
          + Math.abs(img.data[i + 2] - baseline.data[i + 2]);
        if (d <= 24) continue;
        n++; row++;
        if (x < left) left = x;
        if (x > right) right = x;
      }
      if (row >= SOLID) { if (top < 0) top = y; bottom = y; }
    }
    return {
      n, coverage: n / (FIG.w * FIG.h),
      pxHeight: top < 0 ? 0 : bottom - top, pxWidth: n ? right - left : 0, top, bottom,
    };
  }

  const shots = [];
  for (const id of CHARACTER_IDS) {
    // The weapon type is passed the way `game._weaponOf` passes an equipped weapon on a
    // slot switch — a character with nothing equipped falls back to their sheet's type, so
    // this is the same argument the game itself would supply for a fresh account.
    const info = await p.evaluate(([cid, wtype, w, h]) => {
      const g = window.game;
      g.me.setCharacter(cid, wtype);
      const geom = window.__frame(w, h);
      const a = g.me.actor;
      // The head bone, projected: a second reading of the same scale, off the skeleton
      // instead of off the pixels. If the two disagree the model and its rig disagree.
      a.rig.group.updateMatrixWorld(true);
      const e = a.rig.bones.head.matrixWorld.elements;
      const headPx = window.__project(g.camera, e[12], e[13], e[14], w, h);
      return {
        charId: g.me.charId, height: a.height, weapon: a.weaponId, hasWeapon: !!a.weapon,
        feet: geom.feet[1], headPx: headPx[1],
      };
    }, [id, CHARACTERS[id].weapon, W, H]);
    const { img, file } = await shot(`roster-${id}`);
    const sil = silhouette(img);
    const torso = rectStats(img, {
      x: Math.round(geom.feet[0] - 26),
      y: Math.round(geom.feet[1] - (geom.feet[1] - geom.over[1]) * 0.46), w: 52, h: 70, label: 'torso',
    });
    shots.push({ id, ...info, ...sil, torso, img, file });
    console.log(`     ${id.padEnd(9)} ${info.height.toFixed(2)}m rig, ${(sil.coverage * 100).toFixed(1)}% of rect, ${sil.pxHeight}px solid (head bone ${Math.round(info.feet - info.headPx)}px up), torso ${torso.rgb.join(',')}`);
  }

  check('every character was actually swapped in',
    shots.every((s) => s.charId === s.id), shots.filter((s) => s.charId !== s.id).map((s) => s.id).join(' ') || `${shots.length} models`);
  check('every character puts a body on screen',
    shots.every((s) => s.coverage > 0.06 && s.pxHeight > 200),
    shots.filter((s) => !(s.coverage > 0.06 && s.pxHeight > 200))
      .map((s) => `${s.id} ${(s.coverage * 100).toFixed(1)}%/${s.pxHeight}px`).join(' ')
    || `worst ${(Math.min(...shots.map((s) => s.coverage)) * 100).toFixed(1)}%`);
  check('...holding the weapon their sheet gives them',
    shots.every((s) => s.hasWeapon && s.weapon === CHARACTERS[s.id].weapon),
    shots.filter((s) => s.weapon !== CHARACTERS[s.id].weapon).map((s) => `${s.id}:${s.weapon}`).join(' ')
    || [...new Set(shots.map((s) => s.weapon))].join(' '));

  // Two characters that render the same pixels are one character with two names — which is
  // what a `body` block nothing reads would look like from here.
  const twins = [];
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) {
      let diff = 0;
      const a = shots[i].img, c = shots[j].img;
      for (let y = FIG.y; y < FIG.y + FIG.h; y += 2) {
        for (let x = FIG.x; x < FIG.x + FIG.w; x += 2) {
          const k = (y * a.width + x) * 4;
          if (Math.abs(a.data[k] - c.data[k]) + Math.abs(a.data[k + 1] - c.data[k + 1])
            + Math.abs(a.data[k + 2] - c.data[k + 2]) > 24) diff++;
        }
      }
      const frac = diff / ((FIG.w / 2) * (FIG.h / 2));
      if (frac < 0.02) twins.push(`${shots[i].id}~${shots[j].id} ${(frac * 100).toFixed(1)}%`);
    }
  }
  check('no two characters render the same figure', !twins.length,
    twins.join(' ') || `${(shots.length * (shots.length - 1)) / 2} pairs compared`);

  // The authored height reaches the screen. A ratio between the extremes, not a threshold:
  // the pixel span of a 1.58 m sheet and a 1.86 m one must differ in the same direction and
  // by roughly the same factor, or `body.height` is decoration.
  const byHeight = [...shots].sort((a, c) => CHARACTERS[a.id].body.height - CHARACTERS[c.id].body.height);
  const lo = byHeight[0], hi = byHeight[byHeight.length - 1];
  const wantRatio = CHARACTERS[hi.id].body.height / CHARACTERS[lo.id].body.height;
  const gotRatio = hi.pxHeight / lo.pxHeight;
  check('the tallest sheet renders taller than the shortest, by about the authored factor',
    gotRatio > 1 && Math.abs(gotRatio - wantRatio) < 0.08,
    `${lo.id} ${CHARACTERS[lo.id].body.height}m→${lo.pxHeight}px, ${hi.id} ${CHARACTERS[hi.id].body.height}m→${hi.pxHeight}px; ratio ${gotRatio.toFixed(3)} vs ${wantRatio.toFixed(3)}`);
  // The skeleton says the same thing as the silhouette, in the same units. Two readings of
  // one scale: pixels can be fooled by a glow, a bone can be fooled by a mesh that ignores
  // the rig, and agreeing rules both out.
  const boneRatio = (hi.feet - hi.headPx) / (lo.feet - lo.headPx);
  check('...and the rig agrees with the pixels about it',
    Math.abs(boneRatio - gotRatio) < 0.06,
    `bone ratio ${boneRatio.toFixed(3)} vs silhouette ${gotRatio.toFixed(3)} (authored ${wantRatio.toFixed(3)})`);

  check('no page errors during the run', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL probe threw — ${e.stack || e.message}`);
} finally {
  console.log(`\nparty-ui: ${pass} passed, ${fail} failed  (frames in ${outDir})`);
  await b.close();
  process.exit(fail);
}
