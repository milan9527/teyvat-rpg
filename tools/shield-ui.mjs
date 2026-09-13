// 元素护盾呈现层 probe: is the shield's element *on screen*, in pixels?
//
//   DISPLAY=:99 node tools/shield-ui.mjs [baseUrl] [outDir]
//
// `tools/proc-check.mjs` section 15 and `tools/enemy-check.mjs` section 7 prove the two
// simulation halves: a shard remembers what it was crystallised from, an enemy's shield
// gives way to the element that reacts with it, and one function (`shieldBreakMul`) decides
// both. None of that is a *decision* for the player unless the bar says which element is
// on the target and which one is on their own HP bar — the whole point of typing the shield
// is that the player picks the character that breaks it.
//
// Two surfaces, both DOM, both drawn over a live 3D frame:
//
//   1. the party card's shield bar (`.pcard .bar.hp > i.shield`), tinted through the
//      memoised `--shield`/`--shield-dark` custom properties by `hud.js`
//   2. the enemy nameplate's shield bar (`.wlabel .ebar > i.sh`), tinted by an inline
//      gradient in `overlay.js`
//
// Both are measured as pixels, not as class names or style strings: this repo has shipped a
// `classList` assertion that passed while the element was painted in the background colour,
// and a `style.background` read-back that could never match what was written. And both are
// pinned *from both directions*: a measured colour must be nearer its own element than to
// every other candidate, and the other element's bar must be nearer to that one. "The tint
// moved the pixels" is a claim any tint satisfies; "this bar is ice and that one is water"
// is the claim the player actually reads.
//
// The canvas is hidden for every pixel read. The HUD and the nameplates sit over a lit
// scene whose colour changes every frame, and measuring a 5-pixel-tall bar through it is
// how an earlier probe in this repo read a violet line as grey.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { ELEMENTS } from '../shared/src/data/elements.js';
import { ENEMIES } from '../shared/src/data/enemies.js';
import { decodePng, rectStats, pixelsDiffering } from './lib/png.mjs';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/shield-ui';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.png')) rmSync(`${outDir}/${f}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}
function skip(name, why) { console.log(`  SKIP ${name} — ${why}`); }

/** sRGB byte distance. Measured against sRGB because that is what the screenshot holds. */
const rgbOf = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hex3 = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** The gold every shield used to be, straight out of style.css so a retune cannot drift. */
const GOLD = 0xd8c890;

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
const errors = [];
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

let step = 0;
async function shot(name) {
  step++;
  const file = `${outDir}/${String(step).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file });
  return { img: decodePng(readFileSync(file)), file };
}

const frameCount = () => p.evaluate(() => window.__shFrames || 0);
/** Wait for real rendered frames: llvmpipe runs this page at ~3 fps and a sleep is a hope. */
async function frames(n = 2) {
  const from = await frameCount();
  for (let i = 0; i < 400; i++) {
    const now = await frameCount();
    if (now - from >= n) return now - from;
    await sleep(100);
  }
  return -1;
}
const hideCanvas = (h) => p.evaluate((hid) => {
  for (const c of document.querySelectorAll('canvas')) c.style.visibility = hid ? 'hidden' : '';
}, h);

/**
 * The right end of a bar, inset by a pixel on every side.
 *
 * Both bars are painted as a dark→bright gradient, so the last third is the only part that
 * carries the element's own colour; and the inset keeps the border and the HP fill beneath
 * out of the mean. A CSS width transition means the rect has to be read *after* the bar has
 * settled — `barRect` is called once the width stops moving.
 */
const tail = (r, label) => ({
  x: Math.round(r.x + r.w * 0.62) + 1, y: Math.round(r.y) + 1,
  w: Math.max(3, Math.round(r.w * 0.38) - 2), h: Math.max(2, Math.round(r.h) - 2), label,
});

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await (await p.$('[data-act="solo"]')).click();
  await sleep(300);
  const guest = await p.$('[data-act="guest"]') || await p.$('[data-act="resume"]');
  await guest.click();
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  const boot = await p.evaluate(() => {
    const g = window.game;
    if (!g) return null;
    // Frame counter first: every wait below is a frame count, not a sleep. `game` emits
    // 'frame' once per rendered frame (game.js), which is the only tick that means the
    // screenshot will differ from the last one.
    window.__shFrames = 0;
    g.on('frame', () => { window.__shFrames++; });
    g.setAutoQuality(false);
    g.setQuality('high');
    g.setWorldTime(12);
    g.tutorial?.skip?.();
    return { running: !!g._running, mode: g.mode, inst: !!g.socket?.inst, quality: g.quality };
  });
  check('the solo world booted with its own simulation in the tab',
    !!boot && boot.running && boot.inst === true, boot ? `mode ${boot.mode}` : 'no game');
  // llvmpipe boots every browser probe at `low` unless it is told otherwise, and the two
  // bars under test are drawn at the tier the player is meant to see.
  check('the tier is pinned to high', await p.evaluate(() => window.game.quality) === 'high');

  // Record every effect the game asks for. A container with no audio device still routes the
  // *request*, and section 3 is about which of the three shield outcomes the player is told
  // about — not about a waveform. Wrapping `sfx` rather than reading the code, because a call
  // site that grep finds and a call site that runs are different claims.
  await p.evaluate(() => {
    const g = window.game;
    window.__cues = [];
    const real = g.audio.sfx.bind(g.audio);
    g.audio.sfx = (name, opts) => { window.__cues.push({ name, opts: opts || null }); return real(name, opts); };
  });
  await sleep(1500);

  const advanced = await frames(3);
  check('the page is rendering, so a stale frame cannot pass for a fresh one',
    advanced >= 3, `${advanced} frames`);

  /* =================================================== 1) 玩家 HUD 的护盾条 -- */

  console.log('\n--- 1. the party card bar says which element the shield is');

  // Nothing may eat the shield mid-measurement: a hilichurl that wanders into range would
  // drain the bar between the rect read and the screenshot.
  // The real door is kept, because section 3 drives damage through it on purpose.
  await p.evaluate(() => {
    const inst = window.game.socket.inst;
    window.__realDamage = inst.damagePlayer.bind(inst);
    inst.damagePlayer = () => 0;
  });

  /**
   * Put a shield on the player through the simulation's own door and wait for it to arrive.
   *
   * `grantShield` is what crystallize, 磐岩壁垒 and 圣咏回响 all call; from there the value
   * travels the product's real path — `serialize().sh/.she` → `localPlayer.applyServer` →
   * `hud.update`. Writing `game.me.shield` directly would test nothing but the HUD's
   * arithmetic (and the next snapshot would correct it back).
   */
  async function grant(element, frac = 0.55) {
    await p.evaluate(([el, f]) => {
      const g = window.game, inst = g.socket.inst, ent = g.socket.entity;
      ent.clearShield();
      ent.grantShield(ent.maxHp() * f, inst.now + 600, el, inst.now);
    }, [element, frac]);
    // Two frames for the snapshot to arrive and the HUD to write the width, then wait for
    // the CSS width transition to settle: reading the rect too early measures the width the
    // bar is leaving, not the one it is arriving at.
    return settled((me) => me.shield > 0 && me.el === element);
  }
  /**
   * The bar's rect once the browser has *received* the change and the width has stopped moving.
   *
   * Both halves are needed, and the first one is the one that bites. `.bar > i` carries
   * `transition: width 0.2s ease-out`, so a rect read one frame after the HUD writes the new
   * percentage is the width the bar is leaving — but a width that has not started moving at
   * all is *also* stable, and llvmpipe renders this page at ~3 fps, so "two reads 120 ms
   * apart agree" was satisfied before the snapshot carrying the change had even arrived. That
   * version of this probe reported a cleared shield still 67.6 px wide and blamed the HUD,
   * while `game.me.shield` in the very same read was still 567. So: wait for the client state
   * the HUD draws *from* to satisfy `want`, and only then wait for the pixels to settle.
   */
  async function settled(want = () => true) {
    let arrived = null;
    for (let i = 0; i < 120; i++) {
      const r = await barRect();
      if (r && want(r.me)) { arrived = r; break; }
      await sleep(120);
    }
    if (!arrived) return { ...(await barRect()), stateTimedOut: true };
    // Then wait for the painted width to *reach* the percentage the HUD wrote, rather than for
    // two reads to agree: the refresh driver on llvmpipe ticks at ~3 fps, so the transition
    // advances in steps far apart, and "stable for 120 ms" was true of a bar that had not
    // begun to move. The target is derived from the element's own inline width and its track,
    // so it stays honest if the layout changes.
    let last = null;
    for (let i = 0; i < 60; i++) {
      const r = await barRect();
      if (r && Math.abs(r.w - r.expected) < 1) return r;
      last = r;
      await sleep(120);
    }
    return { ...(last || await barRect()), widthTimedOut: true };
  }
  const barRect = () => p.evaluate(() => {
    const el = document.querySelector('.pcard[data-slot="0"] .bar.hp > i.shield');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const card = el.closest('.pcard');
    return {
      x: r.x, y: r.y, w: r.width, h: r.height, inline: el.style.width,
      // What the percentage the HUD wrote means in pixels, on this bar's own track.
      expected: (el.parentElement.getBoundingClientRect().width * (parseFloat(el.style.width) || 0)) / 100,
      shieldVar: getComputedStyle(card).getPropertyValue('--shield').trim(),
      me: { shield: Math.round(window.game.me.shield), el: window.game.me.shieldElement },
    };
  });

  const CASES = [
    { el: null, want: GOLD, name: '无元素(旧的金色)' },
    { el: 'fire', want: ELEMENTS.fire.color, name: '炎' },
    { el: 'ice', want: ELEMENTS.ice.color, name: '冰' },
    { el: 'lightning', want: ELEMENTS.lightning.color, name: '雷' },
  ];
  const measured = [];
  await hideCanvas(true);
  for (const c of CASES) {
    const r = await grant(c.el);
    // Asserted before the rect is used for anything: a shield that never reached the browser
    // is a failure, not a case to skip, and it is exactly the failure the wall-clock gate in
    // `PlayerEntity.serialize` used to produce for every shield in the game.
    if (!check(`a ${c.name} shield reaches the HUD as an element, not just as a number`,
      !!r && !r.stateTimedOut && r.me.shield > 0 && r.me.el === c.el,
      r ? `shield ${r.me.shield}, shieldElement ${r.me.el}` : 'no bar in the DOM')) continue;
    if (!check('...and the bar is drawn wide enough to read', r.w > 6, `${r.w.toFixed(0)} px`)) continue;
    await frames(1);
    const { img, file } = await shot(`hud-${c.el || 'gold'}`);
    const st = rectStats(img, tail(r, c.name));
    measured.push({ ...c, st, rect: r, file });
    check(`...and its painted colour is nearer ${c.name} than the gold every shield used to be`,
      c.el === null
        ? dist(st.rgb, rgbOf(GOLD)) < 60
        : dist(st.rgb, rgbOf(c.want)) < dist(st.rgb, rgbOf(GOLD)),
      `${hex3(st.rgb)}: d(${c.name})=${dist(st.rgb, rgbOf(c.want)).toFixed(0)} d(gold)=${dist(st.rgb, rgbOf(GOLD)).toFixed(0)}`);
  }
  await hideCanvas(false);

  // Both directions. Every bar must be nearest to *its own* element among all the candidates
  // measured — "the tint moved the pixels" is equally true of a tint that is always red.
  for (const m of measured) {
    if (m.el === null) continue;
    let best = null, bestD = Infinity;
    for (const other of measured) {
      const d = dist(m.st.rgb, rgbOf(other.want));
      if (d < bestD) { bestD = d; best = other; }
    }
    check(`the ${m.name} bar is nearest ${m.name} among all four candidates`,
      best?.el === m.el,
      `${hex3(m.st.rgb)} -> ${best?.name} (${bestD.toFixed(0)}), ` +
      measured.map((o) => `${o.name}:${dist(m.st.rgb, rgbOf(o.want)).toFixed(0)}`).join(' '));
  }
  if (measured.length >= 3) {
    const [g0, f0, i0] = measured;
    check('and two different elements are two different pictures, not one frame twice',
      pixelsDiffering(decodePng(readFileSync(f0.file)), decodePng(readFileSync(i0.file)), 8) > 0
      && dist(f0.st.rgb, i0.st.rgb) > 30,
      `炎 ${hex3(f0.st.rgb)} vs 冰 ${hex3(i0.st.rgb)}, d=${dist(f0.st.rgb, i0.st.rgb).toFixed(0)}, gold ${hex3(g0.st.rgb)}`);
  }
  // Off state: a cleared shield leaves no bar at all, so no stale tint survives it.
  await p.evaluate(() => { window.game.socket.entity.clearShield(); });
  const gone = await settled((me) => me.shield === 0);
  check('clearing the shield takes the bar away, element and all',
    !!gone && !gone.stateTimedOut && !gone.widthTimedOut && gone.w < 1
    && gone.me.shield === 0 && gone.me.el === null,
    `${gone ? gone.w.toFixed(1) : '?'} px (inline ${gone?.inline}), shield ${gone?.me.shield}, shieldElement ${gone?.me.el}`);

  /* ================================================= 2) 敌人铭牌的护盾条 -- */

  console.log('\n--- 2. the nameplate says which element the enemy shield is');

  /** Spawn one enemy in front of the camera and hand back its label's shield bar. */
  async function plate(defId) {
    const spawned = await p.evaluate((id) => {
      const g = window.game, inst = g.socket.inst;
      for (const e of inst.enemies.values()) { e.alive = false; e.hp = 0; }
      const yaw = g.rig?.yaw ?? 0;
      const e = inst.spawnEnemy(id, 30, g.me.x - Math.sin(yaw) * 9, g.me.z - Math.cos(yaw) * 9);
      if (!e) return null;
      e.y = g.me.y;
      // Standing still and harmless: a mage that blinks away between the rect read and the
      // screenshot takes its nameplate with it.
      e.state = 'idle'; e.stunned = 1e9; e.ai = null;
      return { id: e.id, shield: e.shield ? Math.round(e.shield.hp) : 0, el: e.shield?.element || null };
    }, defId);
    if (!spawned) return null;
    await frames(4);
    const name = ENEMIES[defId].name;
    const r = await p.evaluate((nm) => {
      for (const n of document.querySelectorAll('.wlabel')) {
        if ((n.querySelector('.who')?.textContent || '') !== nm) continue;
        const sh = n.querySelector('.ebar > i.sh');
        if (!sh) return { found: true, sh: null };
        const cs = getComputedStyle(sh);
        const rect = sh.getBoundingClientRect();
        return {
          found: true, display: cs.display, bg: sh.style.background || '',
          x: rect.x, y: rect.y, w: rect.width, h: rect.height,
          plate: n.getBoundingClientRect().top,
        };
      }
      return { found: false };
    }, name);
    return { ...spawned, ...r, name };
  }

  const shields = [];
  for (const defId of ['abyssMage', 'abyssHerald']) {
    const def = ENEMIES[defId];
    const pl = await plate(defId);
    if (!pl?.found) { skip(`${def.name} shows a nameplate`, 'no label with that name on screen'); continue; }
    check(`${def.name} carries its ${ELEMENTS[def.shield.element].name} shield into the label`,
      pl.shield > 0 && pl.el === def.shield.element, `${pl.shield} hp of ${pl.el}`);
    if (!pl.w || pl.w < 4 || pl.display === 'none') {
      skip(`${def.name}'s shield bar is measurable`, `display ${pl.display}, ${pl.w} px`);
      continue;
    }
    await hideCanvas(true);
    await frames(1);
    const { img, file } = await shot(`plate-${defId}`);
    await hideCanvas(false);
    const st = rectStats(img, tail(pl, def.name));
    const want = ELEMENTS[def.shield.element].color;
    shields.push({ defId, name: def.name, el: def.shield.element, want, st, file });
    check(`...and the bar is painted ${ELEMENTS[def.shield.element].name}, not the shared gold`,
      dist(st.rgb, rgbOf(want)) < dist(st.rgb, rgbOf(GOLD)),
      `${hex3(st.rgb)}: d(${ELEMENTS[def.shield.element].name})=${dist(st.rgb, rgbOf(want)).toFixed(0)} d(gold)=${dist(st.rgb, rgbOf(GOLD)).toFixed(0)}`);
  }
  if (shields.length === 2) {
    const [ice, water] = shields;
    check('the mage and the herald are two different colours, each nearest its own element',
      dist(ice.st.rgb, rgbOf(ice.want)) < dist(ice.st.rgb, rgbOf(water.want))
      && dist(water.st.rgb, rgbOf(water.want)) < dist(water.st.rgb, rgbOf(ice.want)),
      `${ice.name} ${hex3(ice.st.rgb)} vs ${water.name} ${hex3(water.st.rgb)}`);
  } else {
    skip('the mage and the herald are two different colours', `${shields.length} of 2 measured`);
  }
  // The control: an enemy with no shield has no shield bar, so the tint above is not simply
  // the bar every nameplate carries.
  const plain = await plate('hilichurl');
  check('an unshielded enemy shows no shield bar at all',
    !!plain?.found && (plain.display === 'none' || !(plain.w > 1)),
    plain ? `display ${plain.display}, ${plain.w?.toFixed?.(1)} px` : 'no label');

  /* ============================================= 3) 护盾的三个声音 -- */

  // The bar says *which element*; it does not say *what just happened*, and the three things
  // that can happen to a shield ask the player for three different decisions: stand still
  // (it went up), keep going (it held), get out (it broke). Until now the middle one was
  // literally silent — the fully-absorbed hit deliberately suppresses `hurt` (no flash, no
  // shake, no flinch), so a mage tanking a camp behind 磐岩壁垒 heard nothing at all.
  //
  // Driven through the simulation's own doors (`grantShield`, `damagePlayer`,
  // `playerHitEnemy`), so what is under test is the whole chain: sim → S2C.DAMAGE → the
  // client's `_onDamage` branch → `audio.sfx`. `tools/audio-check.mjs` proves the vocabulary
  // and the synthesis; only this proves the branch runs.
  console.log('\n--- 3. the shield has three sounds, one per outcome');

  await p.evaluate(() => { window.game.socket.inst.damagePlayer = window.__realDamage; });

  const cueQ = () => p.evaluate(() => { const q = window.__cues; window.__cues = []; return q; });
  /**
   * Everything the game asked to play from now on, until `want` has all arrived.
   *
   * The queue is drained *before* each action by the caller: a `find` over the whole log
   * answers with the previous action's cue, which is how a probe in this repo once called a
   * landed fix broken.
   */
  async function heard(want, ms = 6000) {
    const got = [];
    for (let waited = 0; waited < ms; waited += 150) {
      got.push(...(await cueQ()));
      if (want.every((w) => got.some((c) => c.name === w))) break;
      await sleep(150);
    }
    return got;
  }
  const namesOf = (got) => got.map((c) => c.name).join(',') || 'nothing';
  /** Both sides of the HP claim: what the simulation holds, and what the client was told. */
  const hpNow = () => p.evaluate(() => ({
    ent: Math.round(window.game.socket.entity.hp),
    me: Math.round(window.game.me.hp),
  }));
  /**
   * Wait for the body to actually lose hp.
   *
   * `game.me.hp` is written by the snapshot (`localPlayer.applyServer`: `this.hp = you.hp`),
   * which is a *different message* from the S2C.DAMAGE that carried the cue — so reading it
   * the instant the cue arrives reads the hp from before the hit. The first version of this
   * assertion did exactly that and reported 1030 → 1030 while the shield had visibly broken.
   */
  const bodyLost = async (from, ms = 6000) => {
    let last = await hpNow();
    for (let w = 0; w < ms && !(last.me < from.me && last.ent < from.ent); w += 150) {
      await sleep(150);
      last = await hpNow();
    }
    return last;
  };

  // a) 升起
  await cueQ();
  await p.evaluate(() => {
    const g = window.game, inst = g.socket.inst, ent = g.socket.entity;
    ent.hp = ent.maxHp();
    ent.clearShield();
    ent.grantShield(ent.maxHp() * 0.9, inst.now + 600, 'ice', inst.now);
  });
  const upCues = await heard(['shield']);
  check('a shield going up is audible', upCues.some((c) => c.name === 'shield'), namesOf(upCues));
  check('...and it is not the being-hit sound',
    !upCues.some((c) => c.name === 'hurt' || c.name === 'shieldBlock'), namesOf(upCues));

  // b) 完全挡住. The one that used to be silent.
  await settled((me) => me.shield > 0);
  await cueQ();
  const hpBlock0 = await hpNow();
  await p.evaluate(() => {
    const g = window.game;
    g.socket.inst.damagePlayer(g.socket.entity, 60, 'physical', 0, null, {});
  });
  const blockCues = await heard(['shieldBlock']);
  // A beat and two frames before reading hp back: "it did not move" must be measured after
  // enough snapshots for a move to have shown up, or it is the same free pass as reading it
  // too early. (`bodyLost` below is the other direction of the same problem.)
  await frames(2);
  const hpBlock1 = await hpNow();
  check('a hit the shield eats whole is audible', blockCues.some((c) => c.name === 'shieldBlock'),
    namesOf(blockCues));
  check('...and it is not 受伤, because the character never felt it',
    !blockCues.some((c) => c.name === 'hurt')
    && hpBlock1.me >= hpBlock0.me && hpBlock1.ent >= hpBlock0.ent,
    `hp ${hpBlock0.ent}/${hpBlock0.me} -> ${hpBlock1.ent}/${hpBlock1.me} (sim/client), ${namesOf(blockCues)}`);

  // c) 破碎. A 20-point shield and a hit far bigger than it: the shell breaks and the
  // overflow reaches the body, so this outcome is the one that plays *both* sounds.
  await p.evaluate(() => {
    const g = window.game, inst = g.socket.inst, ent = g.socket.entity;
    ent.hp = ent.maxHp();
    ent.clearShield();
    ent.grantShield(20, inst.now + 600, 'earth', inst.now);
  });
  await settled((me) => me.shield > 0 && me.shield < 100);
  await heard(['shield'], 4000);      // consume the grant's own cue
  await cueQ();
  const hpBreak0 = await hpNow();
  await p.evaluate(() => {
    const g = window.game;
    g.socket.inst.damagePlayer(g.socket.entity, 400, 'physical', 0, null, {});
  });
  const breakCues = await heard(['shieldBreak', 'hurt']);
  const hpBreak1 = await bodyLost(hpBreak0);
  check('a shield giving way is a third sound, not the same one again',
    breakCues.some((c) => c.name === 'shieldBreak'), namesOf(breakCues));
  check('...and this one *does* hurt, because the overflow reached the body',
    breakCues.some((c) => c.name === 'hurt')
    && hpBreak1.ent < hpBreak0.ent && hpBreak1.me < hpBreak0.me,
    `hp ${hpBreak0.ent}/${hpBreak0.me} -> ${hpBreak1.ent}/${hpBreak1.me} (sim/client), ${namesOf(breakCues)}`);

  // d) The control that makes the block sound mean something: the same hit with no shield.
  // Without this, 「盾挡住了会响」 is equally true of a cue that plays on every hit.
  await p.evaluate(() => {
    const ent = window.game.socket.entity;
    ent.clearShield();
    ent.hp = ent.maxHp();
  });
  await settled((me) => me.shield === 0);
  await cueQ();
  await p.evaluate(() => {
    const g = window.game;
    g.socket.inst.damagePlayer(g.socket.entity, 60, 'physical', 0, null, {});
  });
  const bareCues = await heard(['hurt']);
  check('the same hit with no shield is 受伤 and nothing about shields',
    bareCues.some((c) => c.name === 'hurt')
    && !bareCues.some((c) => c.name === 'shieldBlock' || c.name === 'shieldBreak'),
    namesOf(bareCues));

  // e) The enemy's shield, which is the one the whole party is waiting for — and the only
  // one that is a place in the world rather than something happening to you.
  const foe = await plate('abyssMage');
  if (!foe?.found) {
    skip("an enemy's shield breaking is audible", 'no abyss mage on screen');
  } else {
    await cueQ();
    const at = await p.evaluate(() => {
      const g = window.game, inst = g.socket.inst, ent = g.socket.entity;
      const e = [...inst.enemies.values()].find((x) => x.alive && x.shield && x.shield.hp > 0);
      if (!e) return null;
      // Fixture, not subject: grinding 3200 points of ice shield down through the real
      // damage formula is `enemy-check`'s job, and it would take a minute of frames here.
      e.shield.hp = 1;
      inst.playerHitEnemy(ent, e, {
        flatDamage: 200, element: 'fire', gauge: 0, kind: 'normal', charId: ent.charId,
      });
      return { x: e.x, y: e.y, z: e.z };
    });
    if (!at) {
      skip("an enemy's shield breaking is audible", 'the mage had no shield to break');
    } else {
      const foeCues = await heard(['shieldBreak']);
      const ev = foeCues.find((c) => c.name === 'shieldBreak');
      check("an enemy's shield giving way is audible", !!ev, namesOf(foeCues));
      check('...and positioned at the enemy, so a break across the camp is the quiet one',
        !!ev?.opts?.at && Math.hypot(ev.opts.at[0] - at.x, ev.opts.at[2] - at.z) < 1.5,
        ev?.opts?.at ? `at (${ev.opts.at.map((v) => Number(v).toFixed(1)).join(', ')}) vs enemy (${at.x.toFixed(1)}, ${at.z.toFixed(1)})` : 'no position');
      // Both directions on the position: my own shield breaking is not a place in the world,
      // and a cue that always carried `at` would attenuate the player's own shell by distance
      // to wherever the listener happens to be.
      const mine = breakCues.find((c) => c.name === 'shieldBreak');
      check('...while my own shield breaking is not positioned at all',
        !!mine && !mine.opts?.at, mine ? `opts ${JSON.stringify(mine.opts)}` : 'no cue to compare');
    }
  }

  check('no page errors through the whole run', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL probe crashed — ${e.message}`);
  console.log(e.stack);
} finally {
  await b.close();
}

console.log(`\nshield-ui: ${pass} passed, ${fail} failed`);
console.log(`frames in ${outDir}`);
process.exit(fail);
