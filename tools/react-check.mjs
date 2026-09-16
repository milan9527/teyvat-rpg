// Does an elemental reaction reach the player's eyes and ears?
//
//   node tools/react-check.mjs --no-browser      # vocabulary + wiring only
//   DISPLAY=:99 node tools/react-check.mjs       # ...plus a photograph of all 11 reactions,
//                                                #    and one the server produced in a real fight
//   DISPLAY=:99 node tools/react-check.mjs --no-catalogue   # ...section 4 alone, for editing it
//
// 元素反应 is the deepest mechanic in the game's damage model and the one with the least on
// screen to explain it: a multiplier the player never sees, applied by a table they cannot
// read. Three things were wrong when this file was written, and no gate in the repo could
// have gone red for any of them:
//
//   1. `client/src/game/vfx.js` spelled 冻结 `case 'frozen'`, while the wire says
//      `REACTIONS.freeze`. So the most common reaction in the game — 水 onto 冰 or 冰 onto
//      水 — fell through the switch's `default` and drew a generic bloom in the *incoming*
//      element's colour, and the authored frost formation was dead code. A dead `case` plus
//      a silent `default` is invisible to every "is it wired?" check: the key was declared,
//      the branch existed, and the picture was wrong.
//   2. Reactions had **no sound at all**. Every other combat beat has one.
//   3. `_onDamage`'s `target === 'player'` branch never read `d.reaction`, although
//      `zoneInstance` computes the player's own aura reaction and puts the key on the wire
//      for it. A shaman 感电ing a wet character was mechanically identical to the player's
//      own combo and presented as an ordinary hit.
//
// So this file asks the question in both places it can be answered:
//
//   * Vocabulary and wiring, from source: `REACTIONS` against the `case` labels in both
//     directions (a key with no case, a case with no key), the wire carrying `reaction` for
//     both damage targets, and both `_onDamage` branches drawing, sounding and naming it.
//   * Pixels, in the running page: every reaction is driven through the real `_onDamage`,
//     photographed on an isolated black frame, and compared **against the `default`
//     branch's own frame**. A key that has lost its case still draws something — that is
//     exactly the bug — so "did it draw?" cannot answer this; "did it draw something other
//     than what an unknown key draws?" can. Randomness is seeded per capture, which is what
//     lets the two frames be compared at all, and the same capture repeated must come back
//     bit-identical or the reading is noise.
//
// Exit code is the number of failed assertions.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, diffMask, pixelsDiffering, rectStats } from './lib/png.mjs';
import { REACTIONS, ELEMENTS, resolveReaction, auraDecayFor } from '../shared/src/data/elements.js';
// The applicator's damage is *derived* before the first press (see `hardest`), from the same
// function the simulation resolves hits with — and so is the arena's punching bag (see `arena`).
import { computeDamage, enemyStatAtLevel, totalXpTo } from '../shared/src/sim/formulas.js';
import { ZONES } from '../shared/src/data/zones.js';
import { ENEMIES } from '../shared/src/data/enemies.js';
// Section 4 plays the game rather than describing it, so which two characters it uses and which
// reaction it expects come out of the same tables the server resolves against.
import { CHARACTERS } from '../shared/src/data/characters.js';
import { REACTION_SFX } from '../client/src/audio/audio.js';

const root = path.resolve(import.meta.dirname, '..');
const noBrowser = process.argv.includes('--no-browser');
// Section 3 photographs all 11 reactions and takes about eight minutes; section 4 fights for one.
// The flag skips the catalogue so the fight can be iterated on, and is never used by `check-all`.
const noCatalogue = process.argv.includes('--no-catalogue');
const base = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5173';
// `check-all` hands art probes `[base, outDir]` positionally, so an absolute path argument is
// where the 30 frames go; by hand it is /tmp/react-cam.
const outDir = process.argv.slice(2).find((a) => a.startsWith('/')) || '/tmp/react-cam';

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

const keys = Object.keys(REACTIONS);
/** The element every capture is triggered with, and the one the element-tint pair compares against. */
const EL = 'water';
const EL2 = 'fire';

/* ------------------------------------------------------------------------------ */
/* 1. Vocabulary: REACTIONS against the switch that draws them                     */
/* ------------------------------------------------------------------------------ */

console.log('--- 1. vocabulary');

/**
 * The body of one method, by balanced braces, with strings and comments skipped.
 *
 * Slicing "from the signature to the end of the file" is what let `audio-check`'s first
 * version count zero cases and pass; and slicing to the next `\n  }` breaks on the first
 * nested block that ends at that indentation. The scanner is a few lines and it either
 * finds a body or says so.
 */
function methodBody(src, sigRe) {
  const m = src.match(sigRe);
  if (!m) return null;
  let i = src.indexOf('{', m.index);
  if (i < 0) return null;
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

const vfxSrc = read('client/src/game/vfx.js');
const body = methodBody(vfxSrc, /\breaction\(x, y, z, kind, element\)\s*\{/);
const cases = body ? [...body.matchAll(/case '([a-zA-Z0-9]+)':/g)].map((m) => m[1]) : [];

// The guard. Everything below is a statement about `cases`, and an empty `cases` makes
// "every case is a real reaction" true for free.
check('the scan found the reaction switch', !!body && cases.length >= 9 && !body.includes('cast('),
  body ? `${cases.length} cases in ${body.length} chars` : 'no method body');
check('there are reactions to draw', keys.length >= 10, `${keys.length}: ${keys.join(' ')}`);

const missing = keys.filter((k) => !cases.includes(k));
check('every reaction has its own case', missing.length === 0,
  missing.join(', ') || `all ${keys.length} of ${cases.length} cases`);
const invented = cases.filter((c) => !REACTIONS[c]);
check('...and no case is a reaction that does not exist', invented.length === 0,
  invented.join(', ') || `${cases.length} cases`);
check('no reaction is drawn twice', new Set(cases).size === cases.length, cases.join(','));
// The `default` branch is the control the pixel section shoots against, so it is part of
// the contract here rather than an implementation detail.
check('there is still a default branch to fall through to', /\n\s*default:/.test(body || ''));

/* ------------------------------------------------------------------------------ */
/* 2. Wiring: the wire, both damage branches, and the three consumers              */
/* ------------------------------------------------------------------------------ */

console.log('\n--- 2. wiring');

// The wire. `reaction` is resolved on the server for hits in both directions — the player's
// aura and the enemy's — and a payload that drops the key makes every client-side branch
// below unreachable without any of them changing.
const zoneSrc = read('shared/src/world/zoneInstance.js');
const payloads = [...zoneSrc.matchAll(/this\.emit\(S2C\.DAMAGE,\s*\{/g)].map((m) => {
  let i = m.index + m[0].length, depth = 1;
  while (i < zoneSrc.length && depth > 0) {
    if (zoneSrc[i] === '{') depth++;
    else if (zoneSrc[i] === '}') depth--;
    i++;
  }
  return zoneSrc.slice(m.index, i);
});
const carries = (t) => payloads.filter((s) => s.includes(`target: '${t}'`) && /\breaction:/.test(s)).length;
check('the wire found some damage payloads', payloads.length >= 4, `${payloads.length} emits`);
check('a hit on an enemy carries its reaction', carries('enemy') >= 1, `${carries('enemy')} payload(s)`);
check('a hit on a player carries its reaction too', carries('player') >= 1,
  `${carries('player')} payload(s)`);

// The client. Three consumers, and each of them was missing on one side or the other:
// the bloom (player branch had none), the sound (neither branch had one) and the name.
const gameSrc = read('client/src/game/game.js');
const dmg = methodBody(gameSrc, /\b_onDamage\(d\)\s*\{/);
check('the scan found _onDamage', !!dmg && dmg.includes("target === 'player'"),
  dmg ? `${dmg.length} chars` : 'no method body');
/**
 * And the only way into it is the wire.
 *
 * This is what makes section 4 an end-to-end claim rather than a claim about a function.
 * That section waits for the *server* to compute a reaction and then photographs whatever
 * `_onDamage` drew — but "the payload came off the socket" is only true as long as nothing
 * else in the client calls that handler. One in-client caller (a local prediction, a 单机
 * shortcut, a replay) and the photograph would no longer be evidence that the sim did
 * anything at all. So: exactly one call site in the whole client, and it is the S2C.DAMAGE
 * binding. `client/src/net/socket.js` is what turns a frame into that callback, so the chain
 * from the sim's `emit` to these pixels has no other entrance.
 */
const clientFiles = fs.readdirSync(path.join(root, 'client/src'), { recursive: true })
  .filter((f) => String(f).endsWith('.js'))
  .map((f) => path.join('client/src', String(f)));
const callSites = clientFiles.flatMap((f) => [...read(f).matchAll(/[\w$)\]]\._onDamage\(/g)].map(() => f));
check('the whole client was scanned for callers', clientFiles.length > 20, `${clientFiles.length} files`);
check('the only caller of _onDamage is the socket', callSites.length === 1
  && /s\.on\(S2C\.DAMAGE,\s*\(d\)\s*=>\s*this\._onDamage\(d\)\)/.test(gameSrc),
  `${callSites.length} call site(s): ${[...new Set(callSites)].join(' ') || 'none'}`);
const count = (re) => (dmg ? [...dmg.matchAll(re)].length : 0);
check('both damage branches draw the reaction', count(/\.vfx\.reaction\(/g) >= 2,
  `${count(/\.vfx\.reaction\(/g)} call(s)`);
check('both branches play its sound', count(/\.sfx\(REACTION_SFX\[/g) >= 2,
  `${count(/\.sfx\(REACTION_SFX\[/g)} call(s)`);
check('both branches name it', count(/emit\('reaction'/g) >= 2, `${count(/emit\('reaction'/g)} emit(s)`);
// A reaction lands whether or not the shield ate the damage, so the player branch's block
// must sit outside the heal/blocked split — which is also what the pixel section drives.
const playerHalf = dmg ? dmg.slice(dmg.indexOf("target === 'player'")) : '';
check("...and the player branch's reaction is not inside the heal/blocked split",
  playerHalf.indexOf('.vfx.reaction(') > 0
  && playerHalf.indexOf('.vfx.reaction(') < playerHalf.indexOf('if (heal)'),
  `reaction at ${playerHalf.indexOf('.vfx.reaction(')}, heal split at ${playerHalf.indexOf('if (heal)')}`);

// And the name has somewhere to go: the HUD toast and the floating number's colour.
check('the HUD listens for the name', /on\('reaction'/.test(read('client/src/ui/ui.js')));
check('the damage number is coloured by it', /REACTIONS\[/.test(read('client/src/game/overlay.js')));

/* ------------------------------------------------------------------------------ */
/* 3. Pixels: every reaction against the default branch's own frame                */
/* ------------------------------------------------------------------------------ */

if (noBrowser) {
  skip('every reaction draws its own shape', '--no-browser');
  console.log(`\n${passes} passed, ${fails} failed, ${skips} skipped`);
  process.exit(fails);
}

console.log('\n--- 3. pixels');
fs.mkdirSync(outDir, { recursive: true });
const puppeteer = (await import('puppeteer')).default;
const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
    'media.autoplay.default': 0,
  },
  defaultViewport: { width: 1024, height: 640 },
});
const p = await b.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
p.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });

/**
 * The four page-side helpers both pixel sections need, installed once per page.
 *
 * Section 3 hand-feeds `_onDamage` and section 4 waits for the *server* to send one, but the
 * moment either has a payload the two want exactly the same still-life: black frame, nothing
 * but the effect layer, a seeded `Math.random`, and pools in a canonical order. Written once
 * and evaluated in each page rather than copied into both, because every one of these is a
 * *measurement precondition* — a section whose copy of `__isolate` forgot the fog, or whose
 * `__canon` forgot the spark cursor, would still be green while comparing frames that differ
 * for reasons nobody named.
 */
const INSTALL = `(() => {
  const g = window.game;
  window.__cues = [];
  window.__react = [];
  g.audio.sfx = (name, opts) => { window.__cues.push(name); return true; };
  g.on('reaction', (d) => window.__react.push(d));
  // A tiny deterministic PRNG, re-seeded before every capture.
  window.__seed = (s) => {
    let a = (s >>> 0) || 1;
    Math.random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  // Hide the world, keep the effect layer. Returns what it did, because "the frame is black"
  // is a claim the caller has to be able to assert rather than hope for.
  window.__isolate = () => {
    const own = new Set([g.vfx.sparks.points]);
    for (const pool of g.vfx.meshPools()) {
      for (const o of pool.free) own.add(o);
      for (const e of pool.live) own.add(e.o);
    }
    let hidden = 0;
    for (const c of g.scene.children) {
      if (own.has(c) || c.isLight || c.isCamera) continue;
      if (c.visible) { c.visible = false; hidden++; }
    }
    g.scene.fog = null;
    g.r.renderer.setClearColor(0x000000, 1);
    for (const sel of ['[data-hud]', '#world-overlay']) {
      const el = document.querySelector(sel);
      if (el) el.style.display = 'none';
    }
    return { hidden, pools: own.size };
  };
  // Canonical pool state, or two captures of the same payload are not bit-identical.
  // \`MeshPool.clear()\` pushes the live meshes back onto \`free\` in *retirement* order and
  // \`take()\` pops the end, so which pre-built mesh a shell lands in depends on the whole
  // history of captures; \`SparkField\`'s \`cursor\` keeps rotating through 2 000 slots and
  // \`clear()\` deliberately does not rewind it. Both change the order these additive,
  // depth-write-off surfaces reach the half-float target, and float addition is not
  // associative: measured 3 px between two identical \`default\` captures and 4 px between
  // \`bloom\` and \`swirl\` (which share a case body), up to 10 counts on the outer rim of a
  // ring, where the tone curve amplifies a small linear delta. It is not the product's
  // problem — a live game never draws the same frame twice — but it is this file's, because
  // every claim here is a pixel count and two of them demand exact equality.
  // ...and the one transient that lives in the *renderer* rather than in the sim or a pool.
  // \`Renderer._flash\` is raised by every unblocked hit on the local player (game.js:1673) and
  // decays inside \`render(dt)\`, not inside \`update(dt)\` — so a page frozen a moment after the
  // probe's own character took a hit photographs a **coloured plate** and then decays it, by
  // 0.0416 per render, while the captures are being taken. That is how section 4's pre-hit frame
  // came back at luma 14.5, rgb 43,6,16 in one run and 4.1, rgb 2,4,12 in the next, and why the
  // 1.2 s frame differed from its own control by the whole viewport in the first. Zeroed here
  // and *reported*, because "the plate was black" is a claim the caller has to be able to assert.
  window.__canon = () => {
    g.vfx.clear();
    g.overlay.clear?.();
    g.vfx.sparks.cursor = 0;
    for (const pool of g.vfx.meshPools()) pool.free.sort((a, b) => a.id - b.id);
    const u = g.r.grade.uniforms;
    const was = { flash: +(g.r._flash || 0).toFixed(4), uFlash: +u.uFlash.value.toFixed(4) };
    g.r._flash = 0;
    u.uFlash.value = 0;
    return { was, now: u.uFlash.value, edge: u.uFlashEdge ? u.uFlashEdge.value : null };
  };
  return true;
})()`;

/** Boot a page all the way into the world, from the launcher, as a guest. */
const bootWorld = async (label) => {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  // Which button depends on whether this browser already holds an account, and the launcher
  // offers *both* either way — so the choice is made on the token rather than on what is on
  // screen. Clicking 游客登录 with a session in hand mints a **second, level-1 guest**: that is
  // how section 4's second boot threw away the party it had just levelled and walked a fresh
  // level-1 character into a camp of six.
  const act = (await p.evaluate(() => !!localStorage.getItem('teyvat.token'))) ? 'resume' : 'guest';
  if (await p.$(`[data-act="${act}"]`)) await p.click(`[data-act="${act}"]`);
  let up = false;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    up = await p.evaluate(() => !!window.game?._running);
    if (up) break;
  }
  if (!check(`the world came up${label ? ` (${label})` : ''}`, up)) throw new Error('never booted');
  await sleep(2500);
  await p.evaluate(INSTALL);
};

try {
  await bootWorld('');

  /**
   * Freeze the page into a still-life the probe drives by hand.
   *
   * Three separate reasons, and all three have bitten a probe in this repo before:
   *  * llvmpipe runs this page at 3-4 fps, so sampling a 0.4 s effect from a live loop is a
   *    lottery on the animation's phase — and two lotteries cannot be compared.
   *  * `Math.random` decides where every spark goes. Seeded per capture, two frames differ
   *    in exactly the thing being claimed; unseeded, everything differs.
   *  * The world behind the effect never holds still (grass, weather, the sun), which is
   *    the confound the isolation sheets already fight. Black background, no fog, no world.
   * Both DOM layers go too: the HUD toast prints the reaction's *name* and the floating
   * number is tinted by its colour, so leaving them up would let a frame differ for
   * reasons that have nothing to do with `vfx.reaction`.
   */
  // Pin the tier first, and through the product's own API. `autoQuality` puts llvmpipe on
  // `low`, where `Vfx.setQuality` scales every particle count by 0.35 — so an unpinned probe
  // judges a third of the sparks the target hardware draws. It goes *before* the world is
  // hidden, because `_applyQuality` drops and rebuilds resident chunks: pinning afterwards
  // would put freshly-visible terrain back into a frame that is supposed to be black.
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
    g.settings.showDamage = false;
    g.settings.cameraShake = false;
    // Noon, like every other pixel probe in the repo — `daylight-check` scans for this call and
    // went red the first time this file ran inside the suite. The effects here are unlit
    // additive surfaces on a black clear colour, so the sun cannot reach the frame; pinning it
    // anyway costs one line and keeps the "no pixel probe measures a moving world" gate
    // one-sided in the only direction that is cheap to keep.
    const noon = g.setWorldTime(12);
    g.stop();
    // Everything the Vfx pools own stays visible; every other scene child is hidden, and both
    // DOM layers go with them (`__isolate`, installed above and shared with section 4).
    const { hidden, pools } = window.__isolate();
    return {
      hidden, pools, quality: g.quality, noon, clock: `${g.clock.label} pinned=${g.clock.pinned}`,
      me: [+g.me.x.toFixed(2), +g.me.z.toFixed(2)],
    };
  });
  console.log(`  (hid ${setup.hidden} scene children, ${setup.pools} vfx objects kept,`
    + ` quality ${setup.quality}, clock ${setup.clock}, at ${setup.me})`);
  check('the world was hidden and the effect layer was not', setup.hidden > 0 && setup.pools > 50,
    `${setup.hidden} hidden, ${setup.pools} kept`);
  // Asserted, not just called: `setWorldTime` returns false for an hour it cannot parse and
  // pinning is exactly the kind of setup line that keeps passing after the API under it moves.
  check('the clock is pinned at noon', setup.noon === true && /^12:00/.test(setup.clock), setup.clock);

  /**
   * Fire one reaction through the product's own damage handler and photograph it.
   *
   * Two controls, and the frames are named after what they contain rather than after what
   * they lack:
   *  * `reaction: null` is the **plain** hit — the same payload with the reaction key taken
   *    off. It is not a black frame: the enemy branch still fires `vfx.hit` (7 129 lit px)
   *    and the player branch still draws the shield shell (39 250 dim px), and those are
   *    exactly the companions that have to be subtracted before a number can be called "the
   *    reaction's own light".
   *  * an unknown key is the **default** branch — the frame every authored key has to
   *    differ from, because a key whose case has stopped matching still draws that one.
   *
   * The enemy payload deliberately carries no `by`, so no hit sound and no camera shake:
   * a shake would move the camera between captures and make every diff meaningless. The
   * player payload is a fully absorbed hit (`amount: 0, absorbed: 999`), which is the
   * quietest real path through that branch — no screen flash to wash the frame out, no
   * flinch — and it also pins the fix in place: a reaction block moved inside the
   * `else` (unblocked) half would photograph as nothing at all.
   */
  const shoot = async (target, key, tag, seed = 12345, el = EL) => {
    const where = await p.evaluate(({ target, key, seed, el }) => {
      const g = window.game;
      // Canonical pool and spark-cursor state — see `__canon` above for why exact equality
      // between two captures depends on it.
      window.__canon();
      window.__cues = [];
      window.__react = [];
      window.__seed(seed);
      if (target === 'enemy') {
        g._onDamage({
          target: 'enemy', id: -1, amount: 100, element: el, reaction: key,
          x: g.me.x, y: g.me.y + 1.0, z: g.me.z,
        });
      } else {
        g._onDamage({
          target: 'player', id: g.playerId, amount: 0, absorbed: 999,
          element: el, kind: 'melee', reaction: key,
        });
      }
      // 0.25 s of effect life, in fixed steps, with the loop stopped: the same phase
      // for every key regardless of what the machine's frame rate is doing.
      for (let i = 0; i < 15; i++) g.vfx.update(1 / 60, g.camera);
      for (let i = 0; i < 3; i++) g.r.render(0.016);
      // Everything below is drawn at the character's feet and photographed from the rig, so
      // the geometry of every comparison is a function of these six numbers. Reported per
      // capture rather than trusted: see the constancy assertion under each target's rows.
      const c = g.camera.position;
      return [g.me.x, g.me.y, g.me.z, c.x, c.y, c.z].map((v) => +v.toFixed(4)).join(' ');
    }, { target, key, seed, el });
    await sleep(500);
    const file = `${outDir}/${target}-${tag}.png`;
    await p.screenshot({ path: file });
    const rec = await p.evaluate(() => ({ cues: window.__cues, react: window.__react }));
    wheres.push({ tag, where });
    return { img: decodePng(fs.readFileSync(file)), where, ...rec, file };
  };

  const UNKNOWN = '__nosuchreaction';
  let wheres = [];
  // The triggering element, taken **from the element table** rather than invented. The first
  // draft of this file passed `'hydro'`, which is Genshin's name and not this game's — the
  // elements here are 水/冰/炎/雷/风/岩/光 — so `elementColor` fell through to its white
  // fallback and every element-tinted branch was photographed in a colour the product never
  // shows. An invented key does not throw anywhere: it just quietly means "white".
  check(`the triggering element is a real one (${EL} = 「${ELEMENTS[EL]?.name}」)`, !!ELEMENTS[EL],
    ELEMENTS[EL] ? `#${ELEMENTS[EL].color.toString(16)}` : `no such element; have ${Object.keys(ELEMENTS)}`);
  if (noCatalogue) skip('every reaction draws its own shape', '--no-catalogue');
  for (const target of noCatalogue ? [] : ['enemy', 'player']) {
    console.log(`\n  -- target: ${target}`);
    wheres = [];
    const plain = await shoot(target, null, 'plain-hit');
    const def = await shoot(target, UNKNOWN, 'default');
    const def2 = await shoot(target, UNKNOWN, 'default-again');

    // The harness's own two controls, before a single claim about a reaction.
    //  * a reaction has to be visible *over the plain hit* at all, or the camera is not
    //    pointing at the effect and every "differs from default" below is a comparison of
    //    two frames of nothing;
    //  * the same capture twice has to be identical, or a diff of a few hundred pixels
    //    means nothing (this is the seeded-PRNG claim, and llvmpipe's staleness check).
    const drew = diffMask(def.img, plain.img, 8);
    check('a reaction is visible over the plain hit', drew.count > 800,
      `${drew.count} px changed vs the plain hit, box ${drew.box ? `${drew.box.w}x${drew.box.h}` : 'none'}`);
    const repeat = pixelsDiffering(def.img, def2.img, 2);
    check('...and the same capture twice is bit-identical', repeat === 0, `${repeat} px differ`);

    const seen = [];
    const imgs = {};
    for (const k of keys) {
      const s = await shoot(target, k, k);
      imgs[k] = s.img;
      const d = diffMask(s.img, def.img, 8);
      const lit = diffMask(s.img, plain.img, 8);
      seen.push({ k, px: d.count, lit: lit.count });
      // Two directions, because either one alone is passed by a defect. "Differs from the
      // default frame" is satisfied by a `case` whose body is *empty*: all of the default
      // bloom's own ~70 000 pixels differ, and the gate goes green on a reaction that draws
      // nothing at all. And "drew something over the plain hit" is satisfied by a key that
      // fell through to `default`, which is the bug this file was written for. 800 px is
      // ~0.1 % of the frame and three orders above the 0 px the repeat control measured; the
      // real spread on a working build is printed under the rows (crystallize is the
      // smallest at ~14 000 px, i.e. the bar is 17× below the quietest reaction there is).
      check(`${k} draws light of its own`, lit.count > 800,
        `${lit.count} px over the plain hit, box ${lit.box ? `${lit.box.w}x${lit.box.h}` : 'none'}`);
      check('...and it is not the default bloom', d.count > 800,
        `${d.count} px differ from default (${(d.frac * 100).toFixed(2)} % of frame)`);
      check('...and asks for its own sound', s.cues.includes(REACTION_SFX[k]),
        `wanted ${REACTION_SFX[k]}, got ${s.cues.join(',') || 'silence'}`);
      const named = s.react.find((r) => r.kind === k);
      check('...and says its name', !!named && named.name === REACTIONS[k].name,
        named ? `「${named.name}」` : `no reaction event (${s.react.length} events)`);
    }
    console.log(`  ${target}: ${seen.map((s) => `${s.k} ${s.px}/${s.lit}`).join('  ')}`);

    // What the diff is actually a function of. Two keys that *share* a case body must
    // photograph identically and two that do not must not — otherwise a big diff could be
    // coming from the key (a colour picked off `kind`, a per-key offset) rather than from the
    // branch that ran, and "it differs from default" would stop meaning "its case ran".
    for (const [a, c] of [['vaporize', 'melt'], ['bloom', 'swirl']]) {
      check(`${a} and ${c} share a case, so they share a picture`,
        pixelsDiffering(imgs[a], imgs[c], 2) === 0, `${pixelsDiffering(imgs[a], imgs[c], 2)} px differ`);
    }
    for (const [a, c] of [['freeze', 'crystallize'], ['freeze', 'shatter'], ['overload', 'radiance']]) {
      const n = pixelsDiffering(imgs[a], imgs[c], 2);
      check(`...and ${a} and ${c} do not`, n > 800, `${n} px differ`);
    }

    // Does the incoming element reach the picture? `swirl`/`bloom` and `default` colour
    // themselves off `elementColor(element)` — 扩散 is supposed to be the colour of what was
    // swirled — while every other case is authored constants (frost is frost whatever set it
    // off). Both halves are asserted, and only on the **player** target: the enemy branch
    // fires `vfx.hit` in the incoming element's own colour, so there a changed element moves
    // pixels that have nothing to do with `vfx.reaction`. The blocked player path draws no
    // hit at all and its shield shell is coloured by `me.shieldElement`, so the reaction is
    // the only thing in frame that can care.
    if (target === 'player') {
      const swirl2 = await shoot(target, 'swirl', `swirl-${EL2}`, 12345, EL2);
      const tinted = pixelsDiffering(swirl2.img, imgs.swirl, 2);
      check(`扩散 is drawn in the element's colour (${EL} vs ${EL2})`, tinted > 800, `${tinted} px differ`);
      const frost2 = await shoot(target, 'freeze', `freeze-${EL2}`, 12345, EL2);
      const same = pixelsDiffering(frost2.img, imgs.freeze, 2);
      check('...and 冻结 is frost whatever set it off', same === 0, `${same} px differ`);
    }

    // One authored key, twice, at the same seed: the repeat control above proves the
    // *default* frame is reproducible, and this proves an authored one is too — so a
    // key's diff being large is about its shape and not about which capture it was.
    const twice = await shoot(target, 'freeze', 'freeze-again');
    const frost = decodePng(fs.readFileSync(`${outDir}/${target}-freeze.png`));
    check('freeze photographs the same way twice', pixelsDiffering(twice.img, frost, 2) === 0,
      `${pixelsDiffering(twice.img, frost, 2)} px differ`);
    // And an unknown key must *not* look like the fixed one — the mutation this whole
    // section exists for is a `case` label that stops matching.
    const frostVsDefault = diffMask(frost, def.img, 8);
    check('...and not like a key the switch has never heard of', frostVsDefault.count > 800,
      `${frostVsDefault.count} px`);

    // The isolation, re-proved at the end. Everything above is a difference measured against
    // one control frame captured half a minute earlier; if the world crept back in — a chunk
    // finishing its rebuild, a weather layer, the HUD un-hiding itself — those differences
    // would be about the scene and this file would still be green.
    const plainAgain = await shoot(target, null, 'plain-hit-again');
    check('the frame is still nothing but the effect layer',
      pixelsDiffering(plainAgain.img, plain.img, 2) === 0,
      `${pixelsDiffering(plainAgain.img, plain.img, 2)} px differ from the first plain hit`);

    // And the geometry every one of those comparisons rests on. The loop is stopped, but the
    // socket is not: a snapshot for our own player arriving between two captures moves
    // `me` by a millimetre, which is a *sub-pixel* shift of a 2 m shell and shows up as three
    // or four pixels on its silhouette edge — bit-identity fails and nothing else does. Read
    // it, do not assume it: an ADRIFT reading here is the one explanation of a tiny diff that
    // has nothing to do with `vfx.reaction`.
    const drift = wheres.filter((w) => w.where !== wheres[0].where);
    check('the character and the camera never moved between captures', drift.length === 0,
      drift.length ? `${drift.length}/${wheres.length} captures moved: ${wheres[0].where} → `
        + drift.map((w) => `${w.tag} ${w.where}`).slice(0, 3).join(' | ')
        : `${wheres.length} captures at ${wheres[0].where}`);
  }

  /* ---------------------------------------------------------------------------- */
  /* 3b. The shape of the impact flash                                            */
  /* ---------------------------------------------------------------------------- */

  /**
   * Everything above counts pixels a reaction *changed*, which cannot see the shape of the
   * thing that changed them. `this.flashes` was `PlaneGeometry` + `MeshBasicMaterial`: a
   * rectangle of one flat colour, no map, no falloff, scaled up to 6 m by `shield()` — so every
   * hit, reaction and burst in the game put a hard-edged white block on the screen (measured on
   * a black plate: 278×278 px, `fill 1.000`, corners exactly as bright as the middle, radial
   * profile `1 1 1 1 1`). Eleven green reactions above photographed it eleven times and none of
   * them could say so, because a sticker changes as many pixels as a flash does.
   *
   * So the claim here is about *distribution* rather than count, on one flash fired directly:
   * no corners, a falloff, and spikes along the quad's own axes. All four are then mutated by
   * `uShape`, the term the fix added — with it at 0 the square has to come back, or these
   * thresholds are describing something else in the frame. The centre stays as bright either
   * way, which is what makes it a change of shape and not a change of exposure.
   */
  console.log('\n--- 3b. the impact flash is light, not a sticker');
  {
    const lumAt = (im, x, y) => {
      if (x < 0 || y < 0 || x >= im.width || y >= im.height) return 0;
      const i = ((y | 0) * im.width + (x | 0)) * 4;
      return 0.2126 * im.data[i] + 0.7152 * im.data[i + 1] + 0.0722 * im.data[i + 2];
    };
    // A patch rather than a pixel: at `high` the bloom pass is on, and one sample on a bloomed
    // additive surface is a lottery on the blur kernel's phase.
    const patch = (im, x, y, r = 2) => {
      let s = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { s += lumAt(im, x + dx, y + dy); n++; }
      return s / n;
    };
    /** Fire one flash, hold it at a fixed age, and photograph it. `shape` is the mutation axis. */
    const flashShot = async (tag, size, shape) => {
      const st = await p.evaluate(({ size, shape }) => {
        const g = window.game;
        window.__canon();
        window.__seed(4242);
        // Every mesh in the pool, not just the one `take()` happens to pop: which mesh a flash
        // lands in depends on the whole history of captures (see `__canon`).
        const meshes = [...g.vfx.flashes.free, ...g.vfx.flashes.live.map((e) => e.o)];
        let mats = 0, was = null;
        for (const o of meshes) {
          const u = o.material?.uniforms?.uShape;
          if (!u) continue;
          if (was === null) was = u.value;
          u.value = shape; mats++;
        }
        const at = { x: g.me.x, y: g.me.y + 1.2, z: g.me.z };
        // `flash()` billboards against `this.camera`, which only `update()` hands it.
        g.vfx.update(0, g.camera);
        g.vfx.flash(at.x, at.y, at.z, 0xffffff, size, 0.3);
        for (let i = 0; i < 2; i++) g.vfx.update(1 / 60, g.camera);
        for (let i = 0; i < 3; i++) g.r.render(0.016);
        const el = g.r.renderer.domElement;
        const V = (x, y, z) => {
          const v = new g.scene.position.constructor(x, y, z);
          v.project(g.camera);
          return { x: (v.x * 0.5 + 0.5) * el.clientWidth, y: (-v.y * 0.5 + 0.5) * el.clientHeight };
        };
        const c = V(at.x, at.y, at.z), up = V(at.x, at.y + 1, at.z);
        const live = g.vfx.flashes.live[0] || null;
        return { mats, was, pool: meshes.length, c, perM: +Math.abs(up.y - c.y).toFixed(1),
          live: g.vfx.flashes.live.length, u: live ? +(live.t / live.life).toFixed(3) : null,
          scale: live ? +live.o.scale.x.toFixed(2) : null };
      }, { size, shape });
      await sleep(500);
      const file = `${outDir}/flash-${tag}.png`;
      await p.screenshot({ path: file });
      const img = decodePng(fs.readFileSync(file));
      // The bounding box of everything above the black plate, and the shape inside it.
      let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, lit = 0;
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          if (lumAt(img, x, y) <= 8) continue;
          lit++;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = bw / 2;
      const centre = patch(img, cx, cy);
      // 0.7r along both diagonals: inside a square (bright), all but outside the inscribed
      // circle (0.99r, dark). This one number is the whole difference between the two shapes.
      const diag = [[0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]
        .map(([a, c]) => patch(img, cx + a * r, cy + c * r));
      // Two profiles at the same radii: one down an arm (the +x axis), one down the diagonal,
      // where no arm runs. Normalised on the centre so both shapes are read the same way.
      const arm = [0.25, 0.5, 0.75, 0.99].map((f) => +(patch(img, cx + f * r, cy) / centre).toFixed(3));
      const dia = [0.25, 0.5, 0.75].map((f) =>
        +(patch(img, cx + f * r * 0.707, cy + f * r * 0.707) / centre).toFixed(3));
      const m = { ...st, bw, bh, lit, x0, y0, x1, y1, w: img.width, h: img.height,
        fill: +(lit / (bw * bh)).toFixed(3), centre: +centre.toFixed(1),
        diag: +(diag.reduce((a, v) => a + v, 0) / 4 / centre).toFixed(3), arm, dia, file };
      console.log(`  (${tag}: ${size} m at u ${st.u}, scale ${st.scale}, bbox ${bw}x${bh},`
        + ` lit ${lit} px, fill ${m.fill}, centre ${m.centre}, diag/centre ${m.diag},`
        + ` arm ${arm.join(' ')}, diagonal ${dia.join(' ')})`);
      return m;
    };

    // 2.2 m is the elemental-burst flash (`burst()`); the shield's 6 m one is the same picture at
    // a bigger scale (`fill` and `diag/centre` read the same at 0.9, 2.2 and 6 m in the lab), and
    // 6 m at this camera's 135 px/m is 810 px wide — clipped by the viewport, which would make
    // every ratio below a measurement of the frame's edges.
    const shaped = await flashShot('shaped', 2.2, 1);
    check('every mesh in the flash pool carries the shape term, authored at 1',
      shaped.mats === shaped.pool && shaped.pool >= 16 && shaped.was === 1,
      `${shaped.mats}/${shaped.pool} materials, uShape was ${shaped.was}`);
    check('the flash is one flash, held at a fixed age', shaped.live === 1 && shaped.u > 0 && shaped.u < 0.2,
      `${shaped.live} live at u ${shaped.u}, ${shaped.perM} px/m`);
    // Whole and un-clipped, or `fill`, the corner samples and both profiles are all reading a
    // shape the viewport cut for them.
    check('...and the whole of it is inside the frame',
      shaped.x0 > 4 && shaped.y0 > 4 && shaped.x1 < shaped.w - 5 && shaped.y1 < shaped.h - 5,
      `${shaped.bw}x${shaped.bh} at ${shaped.x0},${shaped.y0} in ${shaped.w}x${shaped.h}`);
    check('the impact flash has no corners', shaped.diag < 0.35,
      `0.7r along the diagonals is ${(shaped.diag * 100).toFixed(1)} % of the centre`);
    check('...and it falls off rather than ending at an edge',
      shaped.arm[0] < 0.95 && shaped.arm[0] > shaped.arm[1] && shaped.arm[1] > shaped.arm[2]
        && shaped.arm[2] > shaped.arm[3] && shaped.arm[3] < 0.2,
      `centre → edge: 1 ${shaped.arm.join(' ')}`);
    check('...and it has spikes along its own axes, so a hit reads as a glint',
      shaped.arm[1] > shaped.dia[1] * 1.7,
      `at half the radius: ${shaped.arm[1]} down an arm vs ${shaped.dia[1]} down the diagonal`);

    // The mutation. Without it, every bar above could be describing a flash that is simply
    // smaller, or dimmer, or absent — the square is what those numbers are a claim *against*.
    const flat = await flashShot('flat', 2.2, 0);
    check('taking the shape term away brings the flat square back',
      flat.fill > 0.98 && flat.diag > 0.9 && flat.arm[2] > 0.9,
      `fill ${flat.fill} (shaped ${shaped.fill}), diag/centre ${flat.diag}, 0.75r ${flat.arm[2]}`);
    check('...and it is the shape that changed, not the exposure',
      Math.abs(shaped.centre - flat.centre) / flat.centre < 0.12 && shaped.lit < flat.lit * 0.8,
      `centre ${shaped.centre} vs ${flat.centre}, lit ${shaped.lit} vs ${flat.lit} px`);
    // Put the product's own value back: section 4 photographs real flashes.
    const back = await p.evaluate(() => {
      let n = 0;
      for (const o of [...window.game.vfx.flashes.free, ...window.game.vfx.flashes.live.map((e) => e.o)]) {
        const u = o.material?.uniforms?.uShape;
        if (u) { u.value = 1; n++; }
      }
      return n;
    });
    check('the shape term is back at its authored value for the fight below', back === shaped.pool,
      `${back} materials at uShape 1`);
  }

  /* ------------------------------------------------------------------------------ */
  /* 4. End to end: the reaction the *sim* computed, over the whole life of the       */
  /*    effect it caused                                                             */
  /* ------------------------------------------------------------------------------ */

  /**
   * Everything above photographs `vfx.reaction` — the presentation. Nothing above proves the
   * *game* ever produces a reaction: section 3 hands `_onDamage` a payload it wrote itself, so
   * a build where `zoneInstance` resolved every reaction to `null`, or where the aura never
   * attached, or where the key never reached the socket, would be green on all of it. Section 2
   * checks that path by reading source, which is the weakest evidence in the repo.
   *
   * So this section plays the game. Two characters out of the party a new account is given, two
   * elements, one creature, walked to on the product's own click-to-move path; the aura is
   * applied by pressing E, the trigger is another E, and the reaction is computed **on the
   * server**, resolved by `resolveReaction`, put on the wire by `emit(S2C.DAMAGE)`, delivered by
   * `socket.js` and drawn by the one `_onDamage` call site section 2 pinned down. What is
   * asserted here is the chain, at every link where it can be seen from a browser:
   *   * the sim hit the creature with the first element, and reported *no* reaction for it —
   *     a server-produced plain hit, which is the control the reaction has to beat;
   *   * the creature is now carrying that element (「元素附着」), both in the client's own record
   *     and as the pip the nameplate draws, which was previously written once at spawn and
   *     never again;
   *   * the second element produced exactly the reaction the *data* says it should (never a
   *     literal 'swirl' — the pair is read out of `CHARACTERS` and run through
   *     `resolveReaction`, so a table change moves this probe with it);
   *   * and the effect that reaction caused is photographed at four phases of its own life,
   *     which is the second half of what section 3 cannot say: it samples one 0.25 s phase, so
   *     an effect that froze on its first frame, or never faded, would pass it.
   *
   * The freeze is done from inside the socket callback, before the handler runs: the payload is
   * held, the loop is stopped, the world is hidden and the PRNG is seeded, and only then is the
   * *real* handler called with the *server's* payload. That is what makes a live fight
   * measurable at all — llvmpipe draws 3 fps, so a live sample of a 0.5 s effect is a lottery
   * on its phase, and two lotteries cannot be compared.
   */
  console.log('\n--- 4. end to end');

  // Section 3 stopped the loop and hid the world in that page, so the fight needs a fresh one.
  await bootWorld('a live page for the fight');

  /**
   * Make the party strong enough to survive the fight it has to start.
   *
   * The nearest creature is 60 m from the guest spawn and it lives in a camp of six, all of
   * which aggro on the way in. A fresh level-1 guest reaches it, gets surrounded and dies — and
   * a downed character casts nothing (`useSkill` returns on `!this.alive`), so the section's
   * first run photographed nothing and reported it as a missing reaction. The party is levelled
   * the way `mp-check` does it: `POST /api/dev/supply` hands over **materials and mora only**,
   * billed from the same cost tables a player pays out of, and every level is then bought
   * through `/api/char/levelup` and `/api/char/ascend` — the routes the character screen calls.
   * If those are broken the party stays weak and this section goes red, which is correct.
   *
   * The page is reloaded afterwards rather than patched: the stat block the simulation fights
   * with is the one the gateway built at join.
   */
  const rest = async (token, route, body) => {
    const r = await fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, b: await r.json().catch(() => ({})) };
  };
  const token = await p.evaluate(() => localStorage.getItem('teyvat.token'));
  /**
   * How strong the party has to be — which is a question about the **fixture**, not about level.
   *
   * The first version of this fight picked its target out of the census and so had a ceiling: a
   * 伊格纳 much past level 14 slams a 595 hp Lv.5 丘丘人 for more than it has, the aura lands on a
   * corpse, and "no reaction" is reported for a creature that no longer exists. Level 14 was the
   * top of that band.
   *
   * The arena removed the ceiling and left the floor. `arena` (below) walks to the zone's one
   * *solitary* camp instead — a 9797 hp 遗迹守卫 that no slam in this party can dent — so what
   * decides the level now is the other side of the trade: it hits back with `slam` 1.6×,
   * `chargeRoll` 1.9× and a six-tick `missileBarrage` off atk 300 every 2.6 s, and the character
   * standing on the field is the one paying for the whole rotation. Measured at level 14: about
   * 250 hp per attack against 2298, i.e. nine attacks, and run #16 spent all of them inside a
   * single failed attempt. Level 30 buys 3568 hp against ~230, i.e. fifteen — enough for three
   * attempts and the walk in, on both characters, which is what the section needs to be able to
   * repeat. Nothing above it is bought for free: `arCap(10)` is 40 and this is bought with books.
   *
   * The climb is bought one route call at a time with **exactly** the books the remaining xp
   * needs, because `levelUpCharacter` spends everything it is handed (one book is 20 000 xp and
   * level 30 is 359 679 of them, so `heroWit: 1` twelve times stops at 25 and `heroWit: 9999`
   * lands wherever the shelf runs out).
   */
  const WANT_LEVEL = 30;
  let grown = { chars: [] };
  if (token) {
    await rest(token, '/api/dev/rank', { rank: 10 });
    const sup = await rest(token, '/api/dev/supply', { level: WANT_LEVEL });
    const st0 = await rest(token, '/api/player/state');
    for (const charId of Object.keys(st0.b.player?.characters || {})) {
      for (let round = 0; round < 10; round++) {
        const inst = (await rest(token, '/api/player/state')).b.player?.characters?.[charId] || {};
        if ((inst.level || 1) >= WANT_LEVEL) break;
        const want = Math.max(1, Math.ceil((totalXpTo(WANT_LEVEL)
          - totalXpTo(inst.level || 1) - (inst.xp || 0)) / 20000));
        const lv = await rest(token, '/api/char/levelup', { charId, materials: { heroWit: want } });
        // No progress is either "no books left" or "at the ascension cap" (20 without one, which
        // level 30 is above); the second is worth one 突破 and then another go at the books.
        if (lv.status !== 200 || (lv.b?.level || 0) <= (inst.level || 1)) {
          if ((await rest(token, '/api/char/ascend', { charId })).status !== 200) break;
        }
      }
    }
    const st1 = (await rest(token, '/api/player/state')).b.player || {};
    grown = {
      granted: sup.b?.granted || {},
      chars: Object.values(st1.characters || {}).map((c) => c.level),
      rank: st1.adventureRank, worldLevel: st1.worldLevel,
    };
  }
  // Both sides of the band, because the ceiling is the load-bearing half: a browser profile that
  // resumed an older account (or a supply route that hands over the whole shelf) would arrive at
  // level 20+, one-shot every aura target it attaches 炎 to, and report that as "no reaction".
  check('the party was levelled through the growth routes, not written',
    grown.chars.length > 1 && Math.min(...grown.chars) >= WANT_LEVEL
      && Math.max(...grown.chars) <= WANT_LEVEL + 2,
    `levels ${grown.chars.join('/')} (wanted ${WANT_LEVEL}-${WANT_LEVEL + 2}),`
      + ` AR ${grown.rank}, world ${grown.worldLevel}`);
  // The join snapshot is where the stat block comes from, so the fight starts on a fresh one.
  await bootWorld('the levelled party');
  const hp0 = await p.evaluate(() => ({ hp: Math.round(window.game.me.hp), max: Math.round(window.game.me.maxHp) }));
  // A level-1 guest joins with 1030 hp, which is what the camp on the way in kills.
  check('...and joined with the hp that buys', hp0.hp > 1500 && hp0.hp === hp0.max, JSON.stringify(hp0));

  const roster = await p.evaluate(() => ({ party: window.game.party, slot: window.game.activeSlot }));
  const plans = [];
  for (const [ai, ac] of (roster.party || []).entries()) {
    for (const [hi, hc] of (roster.party || []).entries()) {
      if (ai === hi || !ac || !hc) continue;
      const aEl = CHARACTERS[ac]?.element, hEl = CHARACTERS[hc]?.element;
      const r = aEl && hEl ? resolveReaction(hEl, aEl) : null;
      if (!r) continue;
      const aSkill = CHARACTERS[ac].skill || {}, hSkill = CHARACTERS[hc].skill || {};
      plans.push({
        auraSlot: ai, auraChar: ac, auraEl: aEl, auraR: aSkill.radius || 4, auraDash: aSkill.dash || 0,
        hitSlot: hi, hitChar: hc, hitEl: hEl, hitR: hSkill.radius || 4, hitDash: hSkill.dash || 0,
        key: r.key, name: r.name, decay: auraDecayFor(aEl),
        // Which of the two elements should be the *aura* is not a free choice. An aura applied
        // by a skill that dashes 7.5 m forward first is a coin flip on whether the creature was
        // still inside the radius when the hit test ran from where the dash ended, and a 3 s
        // aura can expire during a character switch on a page drawing 3 fps. Both of those are
        // decided here, once, rather than retried blindly: a still applicator and a long-lived
        // aura, and the *trigger* is where a dash is affordable — it is the last link.
        score: (aSkill.dash ? 0 : 2) + (auraDecayFor(aEl) >= 5 ? 1 : 0),
      });
    }
  }
  plans.sort((a, b) => b.score - a.score);
  const plan = plans[0];
  if (!check('the starter party can make a reaction at all', !!plan, plan
    ? `${CHARACTERS[plan.auraChar].name}(${ELEMENTS[plan.auraEl].name}) 附着 → `
      + `${CHARACTERS[plan.hitChar].name}(${ELEMENTS[plan.hitEl].name}) 触发 = `
      + `「${plan.name}」/${plan.key}, aura ${plan.decay}s, dash ${plan.auraDash}/${plan.hitDash} m`
    : `party ${JSON.stringify(roster.party)}`)) throw new Error('no reactable pair in the party');

  // The interceptor. It records every DAMAGE payload the socket delivers, and latches the first
  // one that carries a reaction *and* the server's own coordinates — the triggering hit, not the
  // splash `applyReactionEffects` emits first for neighbours (which has no position, so the
  // client falls back to the creature's own).
  await p.evaluate(() => {
    const g = window.game;
    // The same two confounds section 3 removes: a floating number is a DOM layer that would be
    // in the captures, and a camera shake would move the camera between them.
    g.settings.showDamage = false;
    g.settings.cameraShake = false;
    // 点击攻击's auto-swing, off. Clicking a creature locks on *and* starts swinging at it, and
    // the several seconds between the aura landing and the trigger are enough normal hits to
    // kill it — which takes the aura down with it. Locking on is what this fight wants from the
    // click; the damage is the two skills' business.
    g.settings.autoAttack = false;
    window.__wire = [];
    window.__caught = null;
    // Two more taps, both for telling the three ways a press can produce nothing apart: the
    // client refused it (no packet left the page), the sim refused it (an ERROR came back), or it
    // was cast and simply reached nothing (a PLAYER_ACTION with no DAMAGE behind it). Without
    // them a whiffed aim and a dropped press are the same empty wire — which is exactly what five
    // runs of this section read while the client sat on someone else's cooldown.
    window.__acts = [];
    window.__errs = [];
    const origAct = g._onPlayerAction.bind(g);
    g._onPlayerAction = (d) => {
      if (d && Number(d.playerId) === Number(g.playerId)) {
        window.__acts.push({ action: d.action, charId: d.charId, skillId: d.skillId, at: performance.now() });
      }
      origAct(d);
    };
    const origErr = g._onError.bind(g);
    g._onError = (d) => { window.__errs.push({ error: d?.error, at: performance.now() }); origErr(d); };
    const orig = g._onDamage.bind(g);
    g._onDamage = (d) => {
      window.__wire.push(d);
      if (window.__caught) return;   // frozen for the captures: nothing else may paint into them
      if (d.target === 'enemy' && d.reaction && d.x != null) {
        // Freeze *before* the handler draws anything: stop the loop, cut the socket (so no
        // snapshot, death effect or splash arrives mid-capture), hide the world, seed the PRNG.
        g.stop();
        const at = g.overlay.project(d.x, d.y, d.z, Infinity);
        const me = g.overlay.project(g.me.x, g.me.y + 1.0, g.me.z, Infinity);
        // The same two points without the label rules. `Overlay.project` is written for
        // *nameplates*: it returns null for anything more than 240 px outside the viewport,
        // because a label that far out should not be drawn. The trigger is a 7.5 m dash and it
        // ends with the camera still swinging, so one of the two bodies is routinely just off the
        // edge — and then "was the light drawn at the creature or at the player?" was skipped for
        // a reason that has nothing to do with the question. `Vector3` comes out of the scene
        // (`scene.position.constructor`) rather than an import, because the page has no THREE
        // global; `z` outside [-1, 1] is the one case that really cannot be answered.
        const ndc = (x, y, z) => {
          const V = new g.scene.position.constructor(x, y, z);
          V.project(g.overlay.camera);
          const el = g.r.renderer.domElement;
          return { x: (V.x * 0.5 + 0.5) * el.clientWidth, y: (-V.y * 0.5 + 0.5) * el.clientHeight,
            z: +V.z.toFixed(3) };
        };
        const raw = { at: ndc(d.x, d.y, d.z), me: ndc(g.me.x, g.me.y + 1.0, g.me.z) };
        g.socket.close();
        const iso = window.__isolate();
        const canon = window.__canon();
        window.__cues = [];
        window.__react = [];
        window.__caught = { d, iso, canon, at, me, raw, wire: window.__wire.length };
        // The product's own handler, with the server's own payload. `strip` is the control:
        // the same payload with the reaction key taken off, which is what the plain hit in the
        // very same fight would have drawn.
        window.__fire = (strip) => {
          window.__canon();
          window.__cues = [];
          window.__react = [];
          window.__seed(4242);
          orig(strip ? { ...d, reaction: null } : d);
          return true;
        };
        return;
      }
      orig(d);
    };
    return true;
  });

  /** Everyone's position, from the page. `id` null means "the nearest one still standing". */
  const look = (id = null) => p.evaluate((want) => {
    const g = window.game;
    let tgt = null;
    for (const [eid, e] of g.actors.enemies) {
      if (!e.alive || e.hp <= 0) continue;
      if (want && eid !== want) continue;
      const d = Math.hypot(e.x - g.me.x, e.z - g.me.z);
      if (!tgt || d < tgt.d) {
        tgt = { id: eid, d: +d.toFixed(2), hp: e.hp, maxHp: e.maxHp, aura: e.aura,
          name: e.actor.def.name, defId: e.defId, lv: e.level };
      }
    }
    return { tgt, me: [+g.me.x.toFixed(1), +g.me.z.toFixed(1)], hp: Math.round(g.me.hp),
      slot: g.activeSlot, char: g.party[g.activeSlot], seen: g.actors.enemies.size };
  }, id);

  /**
   * Walk until the creature is `want` metres away, on the product's own path.
   *
   * `setGoal` is the click handler's own entry point (`_handleMouse` → `me.setGoal`), so this is
   * the game's locomotion rather than a probe writing coordinates — a write to `me.x` is lerped
   * back home by the next snapshot. Re-issued every couple of seconds because the creature is
   * walking too (usually towards us: it aggroes long before we arrive).
   */
  const approach = async (id, want, budgetMs, tol = 1.2) => {
    const t0 = Date.now();
    let st = await look(id);
    while (Date.now() - t0 < budgetMs) {
      if (!st.tgt) return st;
      if (Math.abs(st.tgt.d - want) <= tol) return st;
      await p.evaluate(({ id: eid, want: w }) => {
        const g = window.game;
        const e = g.actors.enemies.get(eid);
        if (!e) return;
        const k = Math.max(0.001, Math.hypot(e.x - g.me.x, e.z - g.me.z));
        // Stop `w` metres short, along the line we are standing on — which also leaves us
        // *facing* the creature, and facing is what a dashing skill dashes along.
        g.me.setGoal(e.x - ((e.x - g.me.x) / k) * w, e.z - ((e.z - g.me.z) / k) * w, 'move');
      }, { id, want });
      await sleep(2000);
      st = await look(id);
    }
    return st;
  };

  /**
   * Walk to a point on the map, however far away it is, on the product's own locomotion.
   *
   * `approach` cannot do this: it aims at a creature, and a creature 140 m away has not streamed
   * in yet (`ENEMY_SPAWN` arrives at about 110 m). Sprinting because the trip is long at 3 fps and
   * nothing is hitting us on the way — the whole point of the destination is that it is empty.
   *
   * The stuck branch is the terrain. Mondstadt has 78 m of relief and a 54 m lake, and the walker
   * steers itself rather than pathfinding, so a straight line into a cliff face makes no progress
   * at all (it latches `climbing` and stays there). Aiming 22 m to one side, alternating sides,
   * is enough to get around the ones between the statue and the elite.
   */
  const travelTo = async ([tx, tz], budgetMs) => {
    const t0 = Date.now();
    let last = null, stuck = 0;
    for (;;) {
      const st = await p.evaluate(({ x, z }) => {
        const g = window.game;
        g.me.setGoal(x, z, 'move', null, { sprint: true });
        return { x: +g.me.x.toFixed(1), z: +g.me.z.toFixed(1), hp: Math.round(g.me.hp),
          climbing: !!g.me.climbing, swimming: !!g.me.swimming, alive: !!g.me.alive };
      }, { x: tx, z: tz });
      const d = +Math.hypot(tx - st.x, tz - st.z).toFixed(1);
      // Close enough: 24 m is inside an elite's aggro ring, so it comes the rest of the way, and
      // it is far enough out that `approach` still has a stand-off to walk to.
      if (d <= 24 || !st.alive) return { ...st, d };
      if (Date.now() - t0 > budgetMs) return { ...st, d, timeout: true };
      if (last != null && last - d < 1.0) {
        stuck++;
        await p.evaluate(({ x, z, side }) => {
          const g = window.game;
          const k = Math.max(0.001, Math.hypot(x - g.me.x, z - g.me.z));
          const nx = -((z - g.me.z) / k) * side, nz = ((x - g.me.x) / k) * side;
          g.me.setGoal(g.me.x + nx * 22, g.me.z + nz * 22, 'move', null, { sprint: true });
        }, { x: tx, z: tz, side: stuck % 2 ? 1 : -1 });
        await sleep(4000);
      } else stuck = 0;
      last = d;
      await sleep(3000);
    }
  };

  /**
   * Everything alive nearby, biggest first.
   *
   * Which creature this fight uses is not a free choice either: the applicator has to hit it and
   * leave it *standing*, because the reaction is the second hit. A 伊格纳 levelled to 40 slams a
   * Lv.5 丘丘人 for 682 of its 595 hp — the aura landed on a corpse, and the assertion below read
   * the aura of a creature that no longer existed. Two things came out of that: the party is
   * levelled to exactly 20 (measured: 303 damage, 2709 hp — enough to survive the walk in, not
   * enough to one-shot the fixture), and `pickTarget` prefers a creature that survives the hit.
   */
  const census = () => p.evaluate(() => {
    const g = window.game;
    const live = [...g.actors.enemies].filter(([, e]) => e.alive && e.hp > 0);
    const out = [];
    for (const [id, e] of live) {
      if (!e.alive || e.hp <= 0) continue;
      // How many of its neighbours come with it. Standing at 2 m from one creature in the middle
      // of a six-strong camp means being hit by all six for the length of a rotation, and the
      // applicator does not fight back — that is what put it at 0 hp in runs #9 to #11.
      const crowd = live.filter(([oid, o]) => oid !== id && Math.hypot(o.x - e.x, o.z - e.z) <= 14).length;
      out.push({ id, d: +Math.hypot(e.x - g.me.x, e.z - g.me.z).toFixed(2), hp: e.hp, maxHp: e.maxHp,
        crowd, lv: e.level, defId: e.defId, name: e.actor.def.name, aura: e.aura });
    }
    return out.sort((a, b) => (b.maxHp - a.maxHp) || (a.d - b.d));
  });
  /**
   * The **nearest** creature that can survive the applicator, or the toughest one in reach.
   *
   * `hardest` is what the aura skill has actually been measured hitting for this run (0 before the
   * first landed hit), so "survives" is a reading rather than a guess about levels and tables. It
   * has to be the nearest and not simply the toughest: preferring toughness walked away from the
   * creature the probe had just spent 60 m closing on, every attempt, because a 1025 hp 火斧丘丘人
   * kept streaming in 40 m further out — three attempts of walking and one of fighting.
   */
  /**
   * What the applicator costs its target, before anything has been hit — derived, not guessed.
   *
   * `computeDamage` is the sim's own function and the character's `atk` comes from the join
   * snapshot, so this is the same arithmetic the server will do, plus the 灼烧地带's five ticks.
   * It matters because the *first* pick is the one made blind: seeded at 0, "survives the
   * applicator" was true of every creature in the census, so the first attempt always burned its
   * own aura target down and the measurement cost an attempt (and, once the camp was awake, the
   * applicator). The measured hp drop replaces it as soon as there is one.
   */
  const auraSkill = CHARACTERS[plan.auraChar].skill;
  const myAtk = await p.evaluate((c) => Math.round(window.game.stats?.[c]?.atk || 0), plan.auraChar);
  const myLevel = grown.chars.length ? Math.min(...grown.chars) : WANT_LEVEL;
  const est = (scaling) => computeDamage({ atk: myAtk, scaling, level: myLevel, targetLevel: 5,
    targetRes: 0.1, rng: () => 1 }).damage;
  const ling = auraSkill.lingering;
  let hardest = myAtk ? est(auraSkill.mult)
    + (ling ? est(ling.tickMult) * Math.floor(ling.duration / ling.interval) : 0) : 0;
  console.log(`  (${plan.auraChar} Lv.${myLevel} atk ${myAtk}: ${auraSkill.id} costs a Lv.5 target`
    + ` about ${hardest} hp — slam ${est(auraSkill.mult)}`
    + `${ling ? ` + ${est(ling.tickMult)} × ${Math.floor(ling.duration / ling.interval)} burning` : ''})`);
  /**
   * Which creature to make the reaction on. Three things decide it, in this order:
   *
   *  * it has to **survive the applicator** — `hardest` is the slam plus its 灼烧地带, seeded from
   *    the repo's own `computeDamage` and then replaced by the measured hp drop, because a corpse
   *    carries no aura and that failure reads exactly like "the element did not stick";
   *  * it should be **alone** — the rotation takes fifteen seconds at 3 fps and the applicator
   *    never fights back, so every neighbour within 14 m is another attacker for the whole of it;
   *  * and it should be **near**, which is the tie-break rather than the rule: preferring the
   *    nearest one is what walked away from the creature the probe had just closed 60 m on.
   */
  const pickTarget = async (range = 90) => {
    const all = (await census()).filter((e) => e.d <= range);
    if (!all.length) return null;
    const score = (e) => (e.hp > hardest * 1.25 ? 0 : 400) + e.crowd * 45 + e.d;
    return all.slice().sort((a, b) => score(a) - score(b))[0];
  };

  const first = await look();
  const roll = await census();
  check('the sim streamed a creature into the page', !!first.tgt && first.seen > 0,
    first.tgt ? `${first.seen} enemies, nearest ${first.tgt.name} Lv.${first.tgt.lv} `
      + `${first.tgt.hp}/${first.tgt.maxHp} hp at ${first.tgt.d} m` : `${first.seen} enemies`);
  console.log(`  (nearby: ${roll.slice(0, 6).map((e) => `${e.name} Lv.${e.lv} ${e.maxHp}hp @${e.d}m`
    + ` +${e.crowd}`).join(', ')})`);
  if (!first.tgt) throw new Error('no enemy to fight');

  /**
   * How close to stand. The aura skill wants the creature comfortably inside its radius; the
   * trigger dashes `hitDash` metres forward *before* its hit test runs, so standing on top of
   * the creature is the one distance from which a dashing trigger reliably misses (it ends
   * `hitDash - d` metres past it). Both bounds come from the character data.
   */
  const reach = plan.hitDash
    ? Math.min(plan.auraR * 0.9, Math.max(plan.hitDash - plan.hitR * 0.75, 2.6))
    : Math.min(plan.auraR * 0.6, plan.hitR * 0.6);
  /**
   * The party sheet, per character — because only the character **on the field** takes damage,
   * and a character at 0 hp cannot be switched to at all (`switchTo` → 「该角色已倒下」).
   */
  const partyHp = () => p.evaluate(() => {
    const g = window.game;
    return Object.fromEntries(g.party.filter(Boolean).map((c) => [c, Math.round(g._hpOf(c))]));
  });
  // Put the applicator on the field *before* the 60 m walk in, and keep the trigger off it. Run
  // #8 spawned with 莉拉 (slot 0) leading, so she soaked the whole walk through an aggroed camp
  // and was down by the time the rotation started: the 炎 half kept working and the 风 half could
  // never be pressed, which from the keyboard's side looks like a dropped key again.
  await p.keyboard.press(`Digit${plan.auraSlot + 1}`);
  await sleep(1500);
  console.log(`  (${plan.auraChar} takes the walk in, ${plan.hitChar} stays off the field;`
    + ` party hp ${JSON.stringify(await partyHp())})`);

  /**
   * Where the fight happens: the zone's **lone elite**, derived from its own spawn table.
   *
   * A reaction takes two presses and a character switch — fifteen seconds of wall clock at 3 fps
   * — and for all of them the applicator has to be alive and the creature carrying the aura has
   * to be alive too. Fighting in a camp gives neither. Runs #9 to #12 all died the same way: the
   * census's best pick sat in a four- to six-strong camp, every neighbour inside 14 m spent the
   * rotation hitting whoever was on the field (only the on-field character takes damage), and the
   * applicator arrived at the switch at 0 hp with 2298 hp of walk behind it. The camp is also why
   * the target kept dying: the creatures the starter zone puts in groups are 379–595 hp and the
   * 灼烧地带 alone is worth ~455.
   *
   * A camp of **one** answers both. 蒙德's table has exactly one — `{ at: [10, -140],
   * enemies: ['ruinGuard'], level: 14, elite: true }`, 9797 hp at that level and 130 m from the
   * nearest other camp, walking at 2.6 m/s (slower than the party) and swinging every 2.6 s. It
   * cannot be killed by the applicator, nobody joins in, and the trip there crosses nothing that
   * aggroes. This is read out of `ZONES` rather than written down here so that moving the camp,
   * or giving the zone a bigger solitary elite, moves the fight with it.
   */
  const arena = await (async () => {
    const zdef = ZONES[await p.evaluate(() => window.game.zoneId)];
    let best = null;
    for (const s of zdef?.spawns || []) {
      if (s.enemies.length !== 1) continue;
      const def = ENEMIES[s.enemies[0]];
      if (!def) continue;
      const hp = enemyStatAtLevel(def.base.hp, s.level);
      if (!best || hp > best.hp) best = { at: s.at, defId: def.id, name: def.name, hp, lv: s.level };
    }
    return best;
  })();
  if (arena) {
    console.log(`  (walking to the zone's only solitary camp: ${arena.name} Lv.${arena.lv},`
      + ` ${arena.hp} hp, at ${arena.at})`);
    const trip = await travelTo(arena.at, 300000);
    console.log(`  (arrived ${trip.d} m from it at ${trip.x},${trip.z}, hp ${trip.hp}`
      + `${trip.timeout ? ' — out of budget' : ''}; party hp ${JSON.stringify(await partyHp())})`);
  }
  // The arena's own occupant by name, if the walk got us to it: `pickTarget` scores what it can
  // see, and after a 140 m walk what it can see includes whatever streamed in on the way.
  let eid = (arena && (await census()).find((e) => e.defId === arena.defId)?.id)
    || (await pickTarget())?.id || (await look()).tgt?.id || first.tgt.id;
  let tname = (await census()).find((e) => e.id === eid)?.name || first.tgt.name;
  // Aimed a little *closer* than the stand-off, with a tolerance that fits inside the aura radius:
  // `approach` returns as soon as it is within `tol` of what it was asked for, so asking for 4.35
  // with the default 1.2 legitimately stops at 5.55 — outside the slam's 5 m disc, and outside the
  // gate below, which is how run #15 walked 140 m and then failed at 4.7 m.
  const near = await approach(eid, reach - 0.6, 200000, 0.6);
  console.log(`  (stood ${near.tgt ? near.tgt.d : '?'} m off, wanted ~${reach.toFixed(1)} m,`
    + ` me ${near.me}, hp ${near.hp})`);
  if (!check('walked into range of it, by clicking the ground', !!near.tgt
    && near.tgt.d <= Math.min(plan.auraR, plan.hitR + plan.hitDash) - 0.4,
    near.tgt ? `${near.tgt.d} m (aura radius ${plan.auraR}, trigger ${plan.hitR}+${plan.hitDash} dash)`
      : 'the creature is gone')) throw new Error('never got in range');

  /**
   * Click the creature, which is how a player aims a skill.
   *
   * `useSkill` sends `attackDir(actors)`, and that is the **locked target's** direction when
   * one is locked and the character's stale yaw when none is. A dash skill dashes along it, so
   * with no target the trigger's 7.5 m dash goes wherever the last walk happened to end — which
   * is exactly how the first run of this section whiffed. Clicking is also the product's own
   * lock-on gesture (`_leftClick` → `pickEnemy` → `setTarget`), so the aim this fight uses is
   * the aim 鼠标点击 gives a player, and the click point is projected per press because the
   * camera has moved since the last one.
   */
  /**
   * Where the creature is on screen, and whether that is somewhere a mouse can go.
   *
   * Three points up the body, not one. `pickEnemy` tests the ray against a **sphere** of
   * `max(0.7, height × 0.45) + 0.35` metres around mid-height, so anywhere on the model locks the
   * same creature — and the fixture is a 3.6 m machine standing 3.2 m away, whose middle projects
   * *below the bottom edge of the frame* (run #18: y = 645 of 640, so nothing was clicked at all
   * and the lock had to be repaired later by the trigger's own prep). Its head is comfortably on
   * screen. So the click point is the first of centre / three-quarters / head that the viewport
   * actually has, and it is still derived per press through the product's own camera.
   */
  const screenPos = (id) => p.evaluate((eid) => {
    const g = window.game;
    const e = g.actors.enemies.get(eid);
    if (!e) return null;
    const h = e.actor.height || 1.6;
    const r = g.r.renderer.domElement.getBoundingClientRect();
    const M = 24;
    let pt = null, frac = null, best = Infinity;
    const alts = [];
    // The *closest to being clickable*, not the first one tried. Keeping the first off-screen
    // candidate picked the creature's waist at y = 784 over its head at y = 667 — 117 px further
    // out of a 640 px frame — and then reported the worse number as the reason nothing was
    // clicked. When something is inside the margin it still wins immediately.
    const howFar = (q) => Math.max(0, M - q.x, q.x - (r.width - M), M - q.y, q.y - (r.height - M));
    for (const f of [0.5, 0.75, 1.0]) {
      const q = g.overlay.project(e.x, e.y + h * f, e.z, Infinity);
      alts.push(q ? { f, x: Math.round(q.x), y: Math.round(q.y) } : { f, x: null, y: null });
      if (!q) continue;
      const out = howFar(q);
      if (pt && out >= best) continue;
      pt = q; frac = f; best = out;
      if (!out) break;
    }
    // The camera the projection came out of, so a click point that fell off the frame can say
    // *why*. `project` was given an infinite margin, so a null is "behind the near plane", not
    // "outside the viewport" — a distinction that decides whether pitching can help at all.
    const cam = g.r.camera;
    const rig = { pitch: +g.rig.pitch.toFixed(3), dist: +g.rig.dist.toFixed(2),
      now: +(g.rig._distNow ?? g.rig.dist).toFixed(2), yaw: +g.rig.yaw.toFixed(2),
      camY: +cam.position.y.toFixed(2), meY: +g.me.y.toFixed(2), eY: +e.y.toFixed(2),
      fov: cam.fov, drop: +(g.me.y - e.y).toFixed(2),
      // Where the creature sits relative to where the camera is pointing, in degrees: the
      // quantity a pitch drag moves, and the one a half-FOV has to cover.
      below: +((Math.atan2(cam.position.y - (e.y + h * 0.5),
        Math.hypot(e.x - cam.position.x, e.z - cam.position.z)) * 180 / Math.PI)
        - (g.rig.pitch * 180 / Math.PI)).toFixed(1) };
    const yaw = Math.atan2(e.x - g.me.x, e.z - g.me.z);
    let err = yaw - g.rig.yaw;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    // `orbit` turns `dx` pixels into `-dx · settings.sensitivity · rig.sens` radians of yaw,
    // so this is how far the mouse has to travel to point the camera at the creature.
    const px = -err / (g.settings.sensitivity * g.rig.sens);
    return {
      x: pt ? Math.round(r.left + pt.x) : null, y: pt ? Math.round(r.top + pt.y) : null,
      w: Math.round(r.width), h: Math.round(r.height), err: +err.toFixed(2), px: Math.round(px),
      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
      frac, alts, height: +h.toFixed(1), rig,
    };
  }, id);

  /**
   * Turn the camera until the creature is on screen, by dragging with the right button.
   *
   * A click can only land on pixels the viewport has: the first run of this section projected
   * the creature to x = -186 and puppeteer refused the move. Orbiting is the product's own
   * gesture for it — `input.js` only lets the right and middle buttons orbit (a left drag is a
   * steering gesture), and `_rightClick` deliberately does not fire for a press that moved.
   */
  /**
   * ...and the axis it drags has an end.
   *
   * `CameraRig` clamps pitch to `MAX_PITCH = 1.16` rad, and the fixture this section fights — a
   * 遗迹守卫 that spawns **3.86 m below** the ledge the walk-in ends on — is still 17.9° under the
   * view axis when the clamp is reached: its middle projects to y ≈ 612 of a 640 px frame, inside
   * the viewport but under this loop's 50 px margin. So passes 4, 5 and 6 dragged 110 px, moved
   * the subject **one pixel**, and the sign heuristic (which flips whenever a pass does not
   * improve) read the saturated axis as a wrong guess and thrashed. That is the whole failure:
   * `clicking the creature locks onto it` refused a point a click would have taken.
   *
   * Two answers, in the order a player would try them. Take the point if the *viewport* has it,
   * once pitch has stopped responding — the margin is a preference, not a requirement. And if it
   * is genuinely outside, stop turning and **step back**: distance is the other way to raise
   * something in frame, and `approach` is the product's own locomotion.
   */
  const faceCreature = async (id, backedOff = false) => {
    let at = await screenPos(id);
    // Which way a downward drag moves the subject. Corrected by what the drag actually did rather
    // than derived, because `orbit`'s pitch sign is one line in `input.js` and this is a probe.
    let pitch = 1;
    let stuck = 0;
    for (let i = 0; i < 6 && at; i++) {
      const margin = 50;
      const offX = at.x == null || at.x < margin || at.x > at.w - margin;
      const offY = at.y == null || at.y < margin || at.y > at.h - margin;
      if (!offX && !offY) return at;
      // Clamped so the whole drag stays inside the viewport; several passes finish the turn.
      let dx = offX ? Math.max(-Math.round(at.w * 0.35), Math.min(Math.round(at.w * 0.35), at.px)) : 0;
      // The correction this fight actually needs is **pitch**. A 3.6 m elite standing 3.8 m from
      // the camera projects near the bottom edge of the frame, and its *yaw* error is ~0 — so
      // `px` rounded to 0, the drag moved the mouse nowhere, and `input.js` (which calls a right
      // press that did not move a right *click*) handed it to `_rightClick`, whose whole job is
      // 取消: `_clearTarget()`. Six of those in a row is how runs #14's attempts 1 and 2 reached
      // the trigger with `game.target` null and dashed along a stale yaw — 0 wind payloads, twice,
      // from 3.81 m inside the window. Never a drag shorter than 12 px, for that reason.
      let dy = offY && at.y != null ? (at.y > at.h - margin ? 1 : -1) * pitch * 110 : 0;
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) dx = at.px >= 0 ? 12 : -12;
      await p.mouse.move(at.cx, at.cy);
      await p.mouse.down({ button: 'right' });
      await p.mouse.move(at.cx + dx, at.cy + dy, { steps: 6 });
      await p.mouse.up({ button: 'right' });
      await sleep(700);
      const next = await screenPos(id);
      // Every pass says what it did and what moved, because a loop whose only feedback is a
      // projection has to prove the projection changed at all — six drags that each moved
      // nothing look exactly like six drags that were aimed the wrong way.
      console.log(`  (orbit ${i + 1}: drag ${dx},${dy} → y ${at.y} → ${next?.y}`
        + `, pitch ${at.rig?.pitch} → ${next?.rig?.pitch}, ${at.rig?.below}° below the axis`
        + `, boom ${at.rig?.now} m, drop ${at.rig?.drop} m, alts ${JSON.stringify(next?.alts)})`);
      // A drag that asked for pitch and got none is the clamp, not a wrong guess — three of those
      // and there is nothing left to turn. Told apart from a wrong guess by the *pitch* the rig
      // reports rather than by the projection, because at the clamp the projection moves a pixel
      // or two on its own and no amount of reading y can tell which happened.
      const moved = dy && next?.rig && at.rig
        && Math.abs(next.rig.pitch - at.rig.pitch) > 0.01;
      if (dy && !moved) stuck++;
      else if (dy && next && at.y != null && next.y != null
        && Math.abs(next.y - at.h / 2) > Math.abs(at.y - at.h / 2)) {
        // Did the pitch guess help? If the subject went *further* from the middle of the frame it
        // did not, and the next pass drags the other way.
        pitch = -pitch;
      }
      at = next;
      if (stuck >= 3 && at) {
        const has = at.x != null && at.x > 0 && at.x < at.w && at.y > 0 && at.y < at.h;
        console.log(`  (the camera is at its pitch clamp (${at.rig?.pitch} rad) with the creature`
          + ` ${at.rig?.below}° under the axis and ${at.rig?.drop} m below us`
          + `${has ? ' — taking the point the viewport does have' : ' — stepping back instead'})`);
        if (has) return at;
        if (backedOff) return at;
        // Distance is the other axis. Walk out to where the drop stops filling the frame and try
        // the turn once more, from further away.
        await approach(id, Math.min(9, (at.rig?.drop || 0) + 5), 20000, 1.2);
        return faceCreature(id, true);
      }
    }
    return at;
  };

  const clickTarget = async (id) => {
    const at = await faceCreature(id);
    const onScreen = at && at.x != null && at.x > 0 && at.x < at.w && at.y > 0 && at.y < at.h;
    if (!onScreen) return { at, clicked: false, target: await p.evaluate(() => window.game.target) };
    // What is under the pointer. `pointerdown` is bound on the canvas, so a click that lands on
    // the HUD's button stack does not lock anything — and worse, it *opens a panel*, which pauses
    // the world and silently swallows every key press after it.
    const hit = await p.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { tag: el?.tagName || 'none', cls: el?.className || '', canvas: el?.tagName === 'CANVAS' };
    }, { x: Math.round(at.x), y: Math.round(at.y) });
    if (!hit.canvas) {
      console.log(`  (the creature's screen point is behind the UI: ${hit.tag}.${hit.cls}; not clicking)`);
      return { at: { ...at, ui: hit }, clicked: false, target: await p.evaluate(() => window.game.target) };
    }
    await p.mouse.click(at.x, at.y);
    await sleep(700);
    return { at, clicked: true, target: await p.evaluate(() => window.game.target) };
  };

  /**
   * The creature's nameplate pip — the 元素附着 dot beside its name — and its colour.
   *
   * The camera is turned to the creature first, because a plate is only built for a creature the
   * camera can see: `Overlay.label` returns early when `project` says "behind the camera", and a
   * pooled node that nothing wrote this frame is `display: none`. Reading the pip after a slam
   * that knocked the creature 6 m sideways found two plates, neither of them this one, and failed
   * an assertion about a pip that was on screen a second earlier.
   */
  /**
   * The 元素附着 pip on a creature's nameplate.
   *
   * `face` is a budget, not a preference. Turning the camera onto the creature costs up to six
   * 700 ms passes, and the reading taken *after* the aura lands has to happen inside the 6 s the
   * attachment lives — run #16 spent that whole window here and pressed its trigger onto a
   * creature carrying null. So the after-reading looks first and only turns the camera if the
   * plate is not on screen at all.
   */
  const pipOf = async (id, name, face = true) => {
    if (face) await faceCreature(id);
    const read = () => p.evaluate((who) => {
      const nodes = [...document.querySelectorAll('.wlabel.enemy')].filter((n) => n.style.display !== 'none');
      for (const n of nodes) {
        if (n.children[0]?.children[1]?.textContent !== who) continue;
        const a = n.children[0].children[2];
        const cs = getComputedStyle(a);
        return { found: true, display: cs.display, bg: cs.backgroundColor };
      }
      return { found: false, plates: nodes.length, names: nodes.map((n) => n.children[0]?.children[1]?.textContent) };
    }, name);
    const got = await read();
    if (got.found || face) return got;
    // Not on screen: pay for the camera after all, since a missing plate answers nothing.
    await faceCreature(id);
    return read();
  };

  /**
   * Press a party slot, then the skill, and give the socket a round trip for each.
   *
   * The reading between the two presses is the one this section was blocked on for five runs: the
   * client kept a *single* `skillCd` for the party and no packet ever corrected it, so switching
   * to 莉拉 six seconds into 伊格纳's eight-second cooldown handed her his, `useSkill` returned
   * false on the spot, and the trigger sent nothing at all. It looks exactly like a whiffed aim.
   * The party cards come back too, because they are the readout for the same fact — whether the
   * character you are about to switch to can do anything when you get there.
   */
  /**
   * Give the keyboard back to the world, and say what had taken it.
   *
   * Anything the UI opens — a panel or a modal — calls `game.setPaused(true)`, and a paused
   * world reads **no** keys: `_handleKeys` sits inside the pause gate in `_frame` while
   * `input.endFrame()` keeps clearing the press set outside it. So a skill press vanishes with
   * the cooldown still reading 0 and no error anywhere, which is indistinguishable from a
   * dropped key press — attempts 2 and 3 of run #7 both died this way, four presses in silence.
   * Closing it goes through the product's own 关闭 button rather than Escape (Escape is the
   * UI's, and it opens 设置 when there is nothing to close).
   */
  const unpause = async (why) => {
    const st = await p.evaluate(() => {
      const g = window.game, u = window.ui;
      const st = {
        paused: !!g._paused, panel: u?.panels?.name || null,
        modal: document.querySelector('.scrim h2')?.textContent || null,
        chat: !!u?.hud?.chatOpen, typing: document.activeElement?.tagName || 'none',
      };
      for (const b of document.querySelectorAll('.scrim .close')) b.click();
      if (u?.hud?.chatOpen) u.hud.closeChat();
      document.activeElement?.blur?.();
      return st;
    });
    if (st.paused || st.panel || st.modal || st.chat) {
      console.log(`  (${why}: the world was paused by the UI — panel ${st.panel}, modal`
        + ` ${st.modal && `「${st.modal}」`}, chat ${st.chat}, focus ${st.typing}; closed it)`);
      await sleep(1200);
    }
    return st;
  };

  const cast = async (slot, prep) => {
    await unpause('before the press');
    await p.keyboard.press(`Digit${slot + 1}`);
    // Wait for the *sim* to have the character on the field, not for a fixed second and a half of
    // wall clock. The switch is a C2S message and the skill that follows is validated against
    // `viewer.charId`, so what the press is waiting for is the snapshot echoing `c` back — which
    // arrives in about 400 ms and used to be paid for with a flat 900. Between the aura press and
    // this one there are only six seconds of 元素附着 to spend, and run #16 spent them all.
    // Both halves have to name the character we asked for. "The two agree" is not the same
    // question and answers itself instantly: for the first 300 ms after the press they agree on
    // the *outgoing* character, which is how run #17 read its cards, its `skillCd` and its
    // `activeSlot` before the switch had happened at all and failed three assertions about them.
    const want = await p.evaluate((s) => window.game.party[s], slot);
    for (let i = 0; i < 12; i++) {
      const seen = await p.evaluate(() => {
        const g = window.game;
        const you = (g.socket.latest()?.players || []).find((r) => r.id === g.playerId);
        return { sim: you?.c || null, client: g.party[g.activeSlot] };
      });
      if (seen.sim === want && seen.client === want) break;
      await sleep(250);
    }
    const on = await p.evaluate(() => {
      const g = window.game;
      return {
        slot: g.activeSlot, char: g.party[g.activeSlot], skillCd: +g.me.skillCd.toFixed(2),
        // Who is still standing. A 0 hp character is refused by `switchTo` with a toast, so the
        // press that never lands on the field has to be told apart from a press never read.
        party: Object.fromEntries(g.party.filter(Boolean).map((c) => [c, Math.round(g._hpOf(c))])),
        // Every other door `useSkill` closes without a word. `climbing` is the mean one: a
        // keyboard walk into a slope latches it, and then a skill press is refused in silence
        // with the cooldown reading 0 — which looks exactly like a dropped key.
        gatesBefore: {
          alive: g.me.alive, rooted: +g.me.rooted.toFixed(2), climbing: !!g.me.climbing,
          swimming: !!g.me.swimming, gliding: !!g.me.gliding, paused: !!g._paused,
        },
        // The authority behind the cards, read in the same evaluate as the cards themselves: the
        // per-character map off the snapshot (`Player.cooldownMap`) is the only place an off-field
        // portrait's cooldown can come from, and `hudState` is what the card is fed. Reading them
        // together is what makes the card assertion a claim about the *consumer* rather than a
        // claim about how fast the probe got here — the veil is correct and gone eight seconds
        // later, and a probe that arrives late measures the second thing.
        cds: g.socket.latest()?.cds || {},
        hudCd: Object.fromEntries(g.hudState().party.map((x) => [x.charId, +x.skillCd.toFixed(2)])),
        cards: [...document.querySelectorAll('.pcard')].map((n) => ({
          slot: +n.dataset.slot, cooling: n.classList.contains('cooling'),
          cd: n.querySelector('.av .cd')?.textContent || '',
          shown: n.querySelector('.av .cd') ? getComputedStyle(n.querySelector('.av .cd')).display : 'missing',
          veil: getComputedStyle(n).getPropertyValue('--cd').trim(),
        })),
      };
    });
    // The last chance to fix the geometry. The switch itself costs a second and a half of wall
    // clock at 3 fps, and the creature walks the whole time — a 6.3 m reading against a 5 m radius
    // in run #12 was 4.1 m when the switch was pressed. So the gap is closed *here*, after the
    // character is on the field and immediately before the key that spends the cooldown.
    await prep?.();
    // Hanging off a cliff refuses every cast. Keys are already up, so the climb ends by itself
    // the moment the feet are back on walkable ground; wait for that rather than pressing into it.
    for (let i = 0; i < 12 && (await p.evaluate(() => !!window.game.me.climbing)); i++) await sleep(500);
    let out = null;
    // Two presses, because the honest reasons to be refused are timed ones: `rooted` for 0.28 s
    // of *sim* time is ~2 s of wall clock at 3 fps, and a cooldown is a number we can wait out.
    for (let tries = 0; tries < 2; tries++) {
      const n = await p.evaluate(() => ({ a: window.__acts.length, e: window.__errs.length }));
      await p.keyboard.press('KeyE');
      // What the press became. `cast` is the client's half (a refusal leaves `skillCd` where it
      // was and sends nothing), `sim` is the simulation's answer — the PLAYER_ACTION it
      // broadcasts for a skill it accepted, or the ERROR it refuses with. Polled, not slept on:
      // the answer arrives in a few hundred milliseconds and the aura it is racing lives for six
      // seconds, so a flat 1.4 s wait here was a quarter of the whole window.
      const answer = (k) => p.evaluate((kk) => {
        const g = window.game;
        return {
          cast: g.me.skillCd > 0, left: +g.me.skillCd.toFixed(2),
          gates: {
            alive: g.me.alive, rooted: +g.me.rooted.toFixed(2), climbing: !!g.me.climbing,
            swimming: !!g.me.swimming, gliding: !!g.me.gliding, paused: !!g._paused,
          },
          sim: window.__acts.slice(kk.a).filter((x) => x.action === 'skill').map((x) => x.charId),
          errs: window.__errs.slice(kk.e).map((x) => x.error),
        };
      }, k);
      for (let i = 0; i < 8; i++) {
        out = await answer(n);
        if (out.sim.length || out.errs.length) break;
        await sleep(200);
      }
      if (out.sim.length) break;
      const wait = Math.min(9.5, Math.max(out.left, out.gates.rooted * 8, 1.5));
      await sleep(wait * 1000 + 400);
    }
    return { ...on, ...out };
  };
  /** Every DAMAGE payload the socket has delivered so far, and a wait for one of them. */
  const wire = () => p.evaluate(() => (window.__wire || []).map((d) => ({ ...d })));
  /**
   * Wait for a payload matching `pred` **among the ones that arrive from `from` onwards**.
   *
   * The window is the whole point. Searching the entire log returns the *first ever* match, so
   * the second attempt's "did the aura skill land?" was answered by the first attempt's hit —
   * which had already decayed off the creature by then, and the aura assertion read null while
   * the wire said the skill had connected. Every wait here is a question about the press that
   * just happened.
   */
  const waitWire = async (pred, ms, from = 0) => {
    const until = Date.now() + ms;
    for (;;) {
      const hit = (await wire()).slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() >= until) return null;
      await sleep(400);
    }
  };
  const caught = () => p.evaluate(() => window.__caught);

  /**
   * The fight, up to three times.
   *
   * Two things can legitimately go wrong on a page drawing 3 fps against a creature that walks:
   * the aura skill can whiff (it walked out of the radius) and the trigger can whiff (a 7.5 m
   * dash from point-blank ends past the far edge of its own hit test). Neither is a product
   * defect, and both are visible in what the sim sent back — so each attempt reads the wire and
   * says which link failed, and the section only fails if all three do.
   *
   * Everything the attempts observe is *recorded* and asserted after the loop, never checked
   * inside it. An `if (attempts === 1)` check is worse than it looks in both directions: attempt
   * 1 giving up before it reaches the press silently drops the assertion from the run (a green
   * report with fewer questions in it), and a transient miss on attempt 1 fails a section the
   * next attempt goes on to prove. `keep` takes the first non-null reading and the last one only
   * when the earlier one failed, so the numbers reported below belong to the attempt that got
   * furthest.
   */
  let auraOn = null, pipAfter = null, plainWire = null, attempts = 0;
  let pipBefore = null, lockSeen = null, castA = null, castB = null, tier4 = null, geom = null;
  const keep = (was, now, good) => (was && good(was) ? was : now);
  for (attempts = 1; attempts <= 3 && !(await caught()); attempts++) {
    // A downed character casts nothing (`useSkill` returns on `!this.alive`) and the 力竭 box
    // covers the screen, so a wipe has to be said out loud rather than reported as a reaction
    // that never came. 返回最近的锚点 is the free one of the two buttons — 原地复苏 spends an item
    // no guest owns — and it puts us back on our feet at the statue, a walk away.
    if (!(await p.evaluate(() => window.game.me.alive))) {
      console.log(`  (attempt ${attempts}: the party was downed; taking the anchor respawn)`);
      await p.click('[data-act="respawn"]').catch(() => {});
      await sleep(4000);
      // The revive puts the *first alive* character on the field, which is the trigger — and then
      // the walk back from the statue spends her hp instead of the applicator's, which is how run
      // #12 arrived at the rotation with 莉拉 at 0 and nothing to switch to.
      await p.keyboard.press(`Digit${plan.auraSlot + 1}`);
      await sleep(1200);
      console.log(`  (attempt ${attempts}: back up, party hp ${JSON.stringify(await partyHp())})`);
    }
    /*
     * Are we still in the arena? The 力竭 box is not the only thing that moves the party: the
     * server stands a wiped one back up at its anchor on a wall clock of its own, so an attempt
     * can *begin* 120 m away with `me.alive` true and nothing said about it. Run #16's attempt 3
     * did, and walked off to fight a 丘丘人 68 m from the statue — which is the nearest creature
     * to where it woke up, and a camp of three.
     *
     * The check is on the *place*, so it covers both ways of ending up somewhere else, and it has
     * to come before the re-pick: at 120 m the elite has streamed out of the page entirely
     * (`ENEMY_SPAWN` arrives at about 110 m), so the census the pick reads does not contain it.
     */
    if (arena) {
      const away = await p.evaluate(([ax, az]) => {
        const g = window.game;
        return +Math.hypot(ax - g.me.x, az - g.me.z).toFixed(1);
      }, arena.at);
      if (away > 40) {
        console.log(`  (attempt ${attempts}: ${away} m from the arena — walking back to it)`);
        const back = await travelTo(arena.at, 300000);
        console.log(`  (attempt ${attempts}: back at the arena, ${back.d} m off, hp ${back.hp};`
          + ` party hp ${JSON.stringify(await partyHp())})`);
      }
    }
    // Re-pick the target every attempt: the previous one may be dead (the applicator hits hard
    // enough to kill a small creature outright), and the camp keeps walking about. In the arena the
    // pick is not free — the whole point of walking here was *this* creature, alone, and anything
    // else in the census is a camp we would be dragging along. So the elite wins by name.
    const pick = (arena && (await census()).find((e) => e.defId === arena.defId)) || (await pickTarget());
    if (pick && (pick.id !== eid || pick.d > reach + 1.5)) {
      if (pick.id !== eid) {
        console.log(`  (attempt ${attempts}: fighting ${pick.name} Lv.${pick.lv} ${pick.hp}/${pick.maxHp} hp at ${pick.d} m)`);
      }
      eid = pick.id; tname = pick.name;
      await approach(eid, reach - 0.6, 120000, 0.6);
    }
    // The clean-plate reading, for the creature this attempt actually uses.
    if (!(await look(eid)).tgt?.aura) {
      pipBefore = keep(pipBefore, await pipOf(eid, tname), (r) => r.found && r.display === 'none');
    }
    // Lock on first: this is what aims both skills (see `clickTarget`).
    const lock = await clickTarget(eid);
    lockSeen = keep(lockSeen, { ...lock, eid }, (r) => r.target === r.eid);
    // Close the gap the walk and the click leave. `approach` stops within its tolerance of the
    // stand-off, the camera turn takes another second or two, and the creature is walking the
    // whole time — so a slam whose disc reaches 5.7 m was being pressed from 5.5 m plus drift,
    // which is a coin flip and read exactly like a broken skill. Tight tolerance, right here.
    const gap = await look(eid);
    if (gap.tgt && gap.tgt.d > plan.auraR - 0.8) await approach(eid, reach, 20000, 0.7);
    // Pin the tier *before* the rotation, not between its two presses: `low` (what `autoQuality`
    // gives llvmpipe) scales every particle count by 0.35, so an unpinned capture judges a third
    // of the sparks the target hardware draws — and `_applyQuality` drops and rebuilds resident
    // chunks, which is a thing to do while standing still and, it turned out, not a thing to do
    // while a 6 s aura and an 8 s cooldown are both running. The pin plus its settle cost three
    // and a half seconds of the eight, which is what left 伊格纳's card with nothing to show by
    // the time the switch was pressed (run #13: the veil was correct, the reading was late).
    // ...and only once: `_applyQuality` is idempotent, so a second attempt would pay the settle
    // for nothing.
    if (!(tier4?.quality === 'high' && tier4?.vfx === 1.0)) {
      tier4 = await p.evaluate(() => {
        const g = window.game;
        g.setAutoQuality(false);
        g.setQuality('high');
        return { quality: g.quality, vfx: g.vfx.quality };
      });
      await sleep(2500);
    }
    const before = (await wire()).length;
    // Inside the slam's own radius when the key goes down, not when the attempt started.
    const onA = await cast(plan.auraSlot, async () => {
      const now = await look(eid);
      if (now.tgt && now.tgt.d > plan.auraR - 1.4) await approach(eid, reach, 12000, 0.8);
    });
    castA = keep(castA, onA, (r) => r.char === plan.auraChar);
    // The sim's answer to that press: a hit on this creature, in the aura element, and with no
    // reaction on it, because nothing was attached yet. That last half is the control — the same
    // code path, the same wire, the same handler, and a null where the key goes. Only payloads
    // that arrive *after* the press count, or a later attempt reads an earlier attempt's hit.
    const hit = await waitWire((d) => d.target === 'enemy' && d.id === eid
      && d.element === plan.auraEl, 6000, before);
    if (hit) {
      plainWire = plainWire || hit;
      // A floor on it, from the wire, in case the creature dies before the second reading.
      hardest = Math.max(hardest, Math.abs(hit.amount || 0));
      // Wait for the attachment to land in a snapshot (the aura rides on every enemy in every
      // frame) and read both readouts *while it is still attached*: 炎 at gauge 2 is gone in six
      // seconds, so everything from here to the trigger press is spending that window — which is
      // why this polls for the aura in 250 ms steps instead of sleeping 1.2 s for the worst case.
      let st = await look(eid);
      for (let i = 0; i < 8 && st.tgt && !st.tgt.aura; i++) {
        await sleep(250);
        st = await look(eid);
      }
      auraOn = st.tgt?.aura || null;
      // What the applicator actually costs the target: the hp drop across the window, because the
      // 灼烧地带 keeps ticking after the slam and one DAMAGE payload's `amount` is only the first
      // of six. `pickTarget` prices "will still be standing" off this.
      if (st.tgt && gap.tgt) hardest = Math.max(hardest, gap.tgt.hp - st.tgt.hp);
      if (auraOn === plan.auraEl) {
        // Without the camera pass: the plate is on screen already (we are 4 m from it and facing
        // it), and turning to make sure costs more of the aura's six seconds than the reading is
        // worth. If it is genuinely off screen `pipOf` still pays for the turn.
        pipAfter = keep(pipAfter, await pipOf(eid, tname, false),
          (r) => r.found && r.display !== 'none');
      }
      // A creature the applicator killed is not a creature carrying an aura, and it is the one
      // failure that looks identical to "the element did not stick" from the wire alone.
      if (!st.tgt) {
        // A kill is the tighter measurement of the two: the creature's hp *before* the press is a
        // lower bound on what the slam does, and one DAMAGE payload's `amount` is not — 379 dmg
        // killed a 595 hp 丘丘人 in run #7, so the slam lands more than one of them.
        hardest = Math.max(hardest, gap.tgt?.hp || 0);
        console.log(`  (attempt ${attempts}: ${tname} died to the ${plan.auraEl} hit`
          + ` (${hit.amount} dmg reported, ${gap.tgt?.hp} hp standing); the next attempt takes a tougher one)`);
      }
    }
    if (!hit || auraOn !== plan.auraEl) {
      console.log(`  (attempt ${attempts}: aura ${hit ? `hit but carries ${auraOn}` : 'skill did not land'};`
        + ` press: client ${onA.cast ? 'cast' : `refused, cd ${onA.skillCd}s`}, sim`
        + ` ${JSON.stringify(onA.sim)}${onA.errs.length ? ` errors ${JSON.stringify(onA.errs)}` : ''};`
        + ` gates ${JSON.stringify(onA.gatesBefore)} -> ${JSON.stringify(onA.gates)};`
        + ` party ${JSON.stringify(onA.party)};`
        + ` ${(await wire()).length - before} payload(s) since the press,`
        + ` creature ${(await look(eid)).tgt?.d} m off)`);
      await approach(eid, reach, 30000);
      await sleep(3000);
      continue;
    }
    /*
     * A dashing trigger needs both halves of the geometry: a distance inside the window derived
     * above, and a lock so the dash goes *at* the creature. Both are re-checked here, immediately
     * before the press that gets photographed — the slam knocks the creature 6 m/s away and then it
     * walks back in — and both corrections are **conditional**, which is the difference between a
     * rotation that fits inside 元素附着 and one that does not. Re-clicking costs up to six camera
     * passes and an `approach` waits in two-second steps; the trigger's window is nine metres wide
     * (2.6 m to `hitR + hitDash`), the lock is usually still held from before the slam, and run #16
     * paid for both anyway and pressed into a creature carrying null.
     */
    if (plan.hitDash) {
      if ((await p.evaluate(() => window.game.target)) !== eid) await clickTarget(eid);
      const d = (await look(eid)).tgt?.d;
      if (d != null && (d < 2.6 || d > plan.hitR + plan.hitDash - 1.5)) {
        await approach(eid, reach - 0.6, 25000, 0.6);
      }
    }
    const preTrigger = (await wire()).length;
    // What the trigger is actually aimed at *at the moment of the press* — which is why it is read
    // inside `cast`'s hook, after the switch and after the last correction, rather than before the
    // second and a half the switch costs. Two numbers decide whether a dashing hit test can
    // reach: the distance, and the lock the dash follows.
    let aim = null, shot = null;
    const onB = await cast(plan.hitSlot, async () => {
      const d0 = (await look(eid)).tgt?.d;
      if (d0 != null && (d0 < 2.6 || d0 > plan.hitR + plan.hitDash - 1.5)) {
        await approach(eid, reach, 12000, 0.8);
      }
      // The lock, re-checked at the last moment and re-taken if it is gone. `attackDir` falls back
      // to the character's stale yaw the instant `target` is null, and a dash along a stale yaw is
      // a whiff that reads exactly like a broken skill — so this is a precondition of the press,
      // not a nicety. Any right-button gesture can drop it (see `faceCreature`), and so can the
      // creature dying or streaming out.
      if ((await p.evaluate(() => window.game.target)) !== eid) {
        console.log(`  (attempt ${attempts}: the lock was gone at the press; clicking again)`);
        await clickTarget(eid);
      }
      aim = await look(eid);
      shot = { d: aim.tgt?.d ?? null, aura: aim.tgt?.aura || null, eid,
        target: await p.evaluate(() => window.game.target) };
      geom = keep(geom, shot, (r) => r.target === r.eid && r.d != null);
    });
    castB = keep(castB, onB, (r) => r.char === plan.hitChar && r.skillCd < 0.05);
    // The interceptor freezes the page the moment the reaction arrives, so waiting for it is
    // waiting for `__caught`.
    for (let i = 0; i < 15 && !(await caught()); i++) await sleep(400);
    if (!(await caught())) {
      const sinceTrigger = (await wire()).slice(preTrigger).filter((d) => d.element === plan.hitEl);
      const now = await look(eid);
      console.log(`  (attempt ${attempts}: trigger sent ${sinceTrigger.length} ${plan.hitEl} payload(s),`
        + ` none with a reaction; aura was ${auraOn}, pressed at ${onB.slot === plan.hitSlot
          ? `${onB.char} cd ${onB.skillCd}s (client ${onB.cast ? 'cast' : 'refused'},`
            + ` sim ${JSON.stringify(onB.sim)}${onB.errs.length ? ` errors ${JSON.stringify(onB.errs)}` : ''},`
            + ` gates ${JSON.stringify(onB.gatesBefore)} -> ${JSON.stringify(onB.gates)})`
          : `the wrong slot ${onB.slot}`},`
        + ` ${shot.d} m off locked to ${JSON.stringify(shot.target)};`
        + ` creature now ${now.tgt?.d} m off, carrying ${JSON.stringify(now.tgt?.aura)})`);
      // Both skills are on cooldown now; the aura element decays, so re-apply from the top.
      await sleep(Math.max(3000, (CHARACTERS[plan.hitChar].skill.cd || 6) * 1000));
      await approach(eid, reach, 30000);
    }
  }

  // The gestures, as the attempts saw them. 鼠标点击 is the primary control scheme, so the lock
  // that aims both skills has to come from a click on the creature's own pixels.
  check('clicking the creature locks onto it', !!lockSeen && lockSeen.target === lockSeen.eid,
    lockSeen ? `target ${JSON.stringify(lockSeen.target)}, ${lockSeen.clicked ? 'clicked' : 'NOT clicked'} at `
      + `${lockSeen.at && lockSeen.at.x != null
        ? `${lockSeen.at.x},${lockSeen.at.y} of ${lockSeen.at.w}x${lockSeen.at.h}`
          + ` (${lockSeen.at.frac ?? '?'} up a ${lockSeen.at.height ?? '?'} m body`
          + `${lockSeen.at.alts ? `, tried ${JSON.stringify(lockSeen.at.alts)}` : ''})`
        : 'off-screen'}`
      // Where the camera was when that point was computed. Without it, a click point below the
      // frame is unattributable: this fixture stands in a 3.86 m hollow, and the rig's pitch
      // clamp (1.16 rad) leaves it 17.9° under the view axis however hard the probe drags.
      + `${lockSeen.at?.rig ? ` [pitch ${lockSeen.at.rig.pitch}, ${lockSeen.at.rig.below}° under`
        + ` the axis, ${lockSeen.at.rig.drop} m below us, boom ${lockSeen.at.rig.now} m]` : ''}`
      : 'never clicked (no attempt got that far)');
  check(`pressing ${plan.auraSlot + 1} puts ${CHARACTERS[plan.auraChar].name} on the field`,
    !!castA && castA.char === plan.auraChar, castA ? `slot ${castA.slot} = ${castA.char}` : 'never pressed');
  // The other way a press disappears without a word: a panel or a modal had opened, which pauses
  // the world (`setPaused` → `input.setEnabled(false)`, and `_handleKeys` is inside the pause gate
  // while `endFrame` runs outside it). Two attempts of run #7 were lost to it, reading exactly
  // like a dropped key. `unpause` closes it through the UI's own 关闭 button; this asserts the
  // presses that count were read by a world that was actually running.
  check('...with the world running, not paused behind a panel',
    !!castA && castA.gatesBefore?.paused === false && castA.gates?.paused === false,
    castA ? `paused ${castA.gatesBefore?.paused} -> ${castA.gates?.paused}` : 'never pressed');
  // Before the switch can be blamed, the character has to have been alive to switch to: `switchTo`
  // refuses a downed one with 「该角色已倒下」 and returns, so a party that walked in with the
  // *trigger* on the field fails this half of the rotation and nothing else. Only the character on
  // the field takes damage, which is why the applicator now leads the walk.
  check(`${CHARACTERS[plan.hitChar].name} was still standing when the switch was pressed`,
    !!castB && (castB.party?.[plan.hitChar] ?? 0) > 0,
    castB ? `party hp ${JSON.stringify(castB.party)}` : 'never pressed');
  check(`pressing ${plan.hitSlot + 1} puts ${CHARACTERS[plan.hitChar].name} on the field`,
    !!castB && castB.char === plan.hitChar, castB ? `slot ${castB.slot} = ${castB.char}` : 'never pressed');
  // The bug five runs of this section died on, now a gate: 冷却 is per character in the sim
  // (`cooldowns` is keyed `${charId}:skill`), and the client kept one `skillCd` for whoever was on
  // the field with no packet correcting it. So switching mid-rotation handed 莉拉 伊格纳's
  // remaining cooldown and `useSkill` refused the cast — the trigger of every elemental reaction
  // a *player* would ever make, silently dropped, with the HUD ring to match.
  check(`...with ${CHARACTERS[plan.hitChar].name}'s own cooldown, not the character before her`,
    !!castB && castB.skillCd < 0.05,
    castB ? `skillCd ${castB.skillCd} s on the switch, ${CHARACTERS[plan.auraChar].name}'s skill is `
      + `${CHARACTERS[plan.auraChar].skill.cd} s` : 'never pressed');
  // ...and the readout of the same fact, on the card of the character who is *not* on the field.
  //
  // Two assertions, because the card can only be judged against what the wire was saying at the
  // moment it was read. The rotation is *supposed* to happen inside the applicator's cooldown —
  // the aura decays in 6 s and the cooldown is 8 s, so a switch that arrives with 伊格纳 ready
  // again is a rotation that has already lost the aura — so "the wire still had it" is a claim
  // about the fight, and "the card agreed" is the claim about the consumer.
  const cardA = castB?.cards?.find((c) => c.slot === plan.auraSlot);
  const cardB = castB?.cards?.find((c) => c.slot === plan.hitSlot);
  const wireA = castB?.cds?.[`${plan.auraChar}:skill`] ?? 0;
  const hudA = castB?.hudCd?.[plan.auraChar] ?? 0;
  check(`the wire still had ${CHARACTERS[plan.auraChar].name}'s cooldown when the switch was pressed`,
    wireA > 0.05 && Math.abs(wireA - hudA) < 0.2,
    `cds ${JSON.stringify(castB?.cds ?? null)}, ${CHARACTERS[plan.auraChar].skill.cd} s skill,`
    + ` hudState says ${hudA} s`);
  check(`...and ${CHARACTERS[plan.auraChar].name}'s card shows the cooldown he is actually on`,
    // The number within one of ⌈what is left⌉ rather than equal to it: the card is painted once
    // per frame and a frame is a third of a second of cooldown at llvmpipe's 3 fps.
    !!cardA && cardA.cooling && cardA.shown !== 'none'
      && Math.abs(+cardA.cd - Math.ceil(hudA)) <= 1
      && +cardA.veil > 0 && +cardA.veil <= 1,
    `${JSON.stringify(cardA ?? null)} against ${hudA} s left`);
  check(`...while ${CHARACTERS[plan.hitChar].name}'s card shows none`,
    !!cardB && !cardB.cooling && cardB.shown === 'none'
      && (castB?.hudCd?.[plan.hitChar] ?? 1) < 0.05,
    `${JSON.stringify(cardB ?? null)} against ${castB?.hudCd?.[plan.hitChar]} s left`);
  check('the quality tier is pinned high for the capture too',
    !!tier4 && tier4.quality === 'high' && tier4.vfx === 1.0, JSON.stringify(tier4));
  // The geometry the trigger was pressed in, from the character data: a dash lands its disc
  // `hitDash` metres ahead, so a creature closer than `hitDash - hitR` is behind the hit.
  if (plan.hitDash) {
    const lo = Math.max(0, plan.hitDash - plan.hitR - 0.7), hi = plan.hitDash + plan.hitR + 0.7;
    check(`...and the trigger was pressed from inside its own reach (${lo.toFixed(1)}–${hi.toFixed(1)} m)`,
      !!geom && geom.d >= lo && geom.d <= hi && geom.target === geom.eid,
      geom ? `${geom.d} m, locked to ${geom.target === geom.eid ? 'it' : JSON.stringify(geom.target)}`
        : 'no attempt reached the trigger');
  }

  check(`the sim hit it with ${ELEMENTS[plan.auraEl].name} and reported no reaction for it`,
    !!plainWire && plainWire.reaction == null,
    plainWire ? `${plainWire.amount} dmg, element ${plainWire.element}, reaction ${JSON.stringify(plainWire.reaction)}`
      : 'the aura skill never landed a hit on the wire');
  // 元素附着, read off the client's own record of the creature — which is fed by `nb.au` in every
  // snapshot and nothing else. This is the half of a reaction that happens *before* the reaction:
  // one element sitting on a body, waiting. It also gates a bug this section found: the record's
  // `aura` was written in the enemy's constructor and never updated, so every reader of it
  // (nameplate pip, 目标 panel, the element of the death burst) saw the value from the frame the
  // creature streamed in — always null, because nothing gives a creature an innate aura.
  check(`...and the creature carried ${ELEMENTS[plan.auraEl].name} a second later`,
    auraOn === plan.auraEl, `aura = ${JSON.stringify(auraOn)}`);
  const wantPip = `rgb(${[16, 8, 0].map((s) => (ELEMENTS[plan.auraEl].color >> s) & 255).join(', ')})`;
  check('...and its nameplate showed the attachment, in that element\'s colour',
    !!pipAfter && pipAfter.found && pipAfter.display !== 'none' && pipAfter.bg === wantPip,
    `${JSON.stringify(pipAfter)} wanted ${wantPip}`);
  // The other direction, or "the pip is on" says nothing: before any element touched it, the
  // same plate had no pip at all.
  check('...and had none before the element landed',
    !!pipBefore && pipBefore.found && pipBefore.display === 'none', JSON.stringify(pipBefore));

  const got = await caught();
  check(`the sim computed 「${plan.name}」 itself and put it on the wire`,
    !!got && got.d.reaction === plan.key,
    got ? `${got.d.element} onto ${plan.auraEl}: reaction ${got.d.reaction}, kind ${got.d.kind},`
      + ` ${got.d.amount} dmg on ${got.d.id}, by ${got.d.by}, after ${got.wire} payload(s),`
      + ` attempt ${attempts - 1}`
      : `no reaction payload in ${(await wire()).length} payloads`);
  if (!got) throw new Error('the sim never produced a reaction');
  check('...positioned by the server, not by the client', got.d.x != null && got.d.z != null
    && Math.hypot(got.d.x - 0, got.d.z - 0) > 0, `at ${got.d.x}, ${got.d.y}, ${got.d.z}`);
  check('...and the page froze on it with the world hidden',
    got.iso.hidden > 0 && got.iso.pools > 50, `${got.iso.hidden} hidden, ${got.iso.pools} kept`);

  /**
   * Four phases of one effect's life, from the frame before it existed.
   *
   * Section 3 samples 0.25 s and only 0.25 s, so an effect that drew one frame and froze, or one
   * that never faded, is invisible to it. `swirl`'s shell lives 0.5 s and its three rings up to
   * 0.71 s, so the phases below straddle the whole authored life: just after the trigger, near
   * the peak, on the way out, and past the end — where the frame has to come back to the one
   * captured before the payload was ever handed to the handler.
   */
  const PHASES = [0.05, 0.20, 0.45, 1.20];
  const step = (frames) => p.evaluate((n) => {
    const g = window.game;
    for (let i = 0; i < n; i++) g.vfx.update(1 / 60, g.camera);
    for (let i = 0; i < 3; i++) g.r.render(0.016);
    return true;
  }, frames);
  const capture = async (tag) => {
    const file = `${outDir}/e2e-${tag}.png`;
    await p.screenshot({ path: file });
    return decodePng(fs.readFileSync(file));
  };

  /*
   * The pre-hit frame — and a gate on it, because every phase reading below is a difference
   * *against* it.
   *
   * `g.stop()` ends the loop that drives the compositor, so the isolated black plate is rendered
   * into a canvas the browser has not necessarily painted yet: run #17's pre-hit frame came back
   * as the **meadow** (mean luma 108 of 255), and then all four phases differed from it by the
   * whole viewport — 655360 px of 655360 — including 1.2 s, where the effect is provably gone (the
   * stripped-key control at the same phase differed by 58179, i.e. the two dark frames agreed with
   * each other and only the control frame was wrong). A control frame nobody looked at is the
   * quietest way for four pixel assertions to stop asking anything.
   *
   * So the plate is drawn, given the compositor two animation frames and a moment to paint, and
   * then *measured*: black is what the isolate promised (`hidden` scene children, `[data-hud]`
   * hidden, clear colour 0x000000), and anything else means the capture raced it.
   */
  let before = null, plate = null;
  for (let i = 0; i < 6; i++) {
    await step(0);
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await sleep(400);
    before = await capture('00-before');
    plate = rectStats(before, { x: 0, y: 0, w: before.width, h: before.height, label: 'plate' });
    if (plate.lum < 20) break;
  }
  check('...and the pre-hit frame is that black plate, not the meadow behind it',
    plate.lum < 20, `luma ${plate.lum}, rgb ${plate.rgb.join(',')}`);
  // Why the plate can be trusted to be black: the renderer's own hit flash was zeroed when the
  // page froze, and `__canon` said what it found. A run that caught the freeze 0.1 s after the
  // ruin guard connected shot its control frame at luma 14.5 instead of 4.1 and then failed
  // "it is over by 1.2 s" against it, because `uFlash` was still decaying — inside `render`,
  // which is the one clock a stopped game keeps running.
  check('...and the renderer\'s hit flash was zeroed when the page froze',
    got.canon && got.canon.now === 0,
    `found ${JSON.stringify(got.canon?.was)}, now uFlash ${got.canon?.now}, uFlashEdge ${got.canon?.edge}`);

  /*
   * And the flash itself, on the plate it would otherwise have ruined: a hit is a *rim* of light.
   *
   * `GradeShader` used to end with `mix(c, uFlashColor, uFlash)`, which repaints every pixel by
   * the same amount — measured on a real frame with `uFlash` held at 0.3, one hit moved 100 % of
   * the viewport and the centre changed as much as the corner (109,138,68 -> 146,134,172 against
   * 111,125,92 -> 147,123,176). The creature being fought is in that centre. So both halves are
   * asserted here, and `uFlashEdge 0` restores the flood to prove the reading is of the mask:
   * with the mask on, the corner lights and the middle of the frame does not move at all.
   */
  const grade = (f, edge) => p.evaluate(([v, e]) => {
    const u = window.game.r.grade.uniforms;
    u.uFlashColor.value.setHex(0x3aa7ff);
    u.uFlash.value = v;
    if (e != null && u.uFlashEdge) u.uFlashEdge.value = e;
    for (let i = 0; i < 3; i++) window.game.r.render(0);
    return { uFlash: u.uFlash.value, edge: u.uFlashEdge ? u.uFlashEdge.value : null };
  }, [f, edge]);
  const R = (v) => Math.round(v);
  const CENTRE = { x: R(before.width * 0.35), y: R(before.height * 0.35),
    w: R(before.width * 0.3), h: R(before.height * 0.3), label: 'centre' };
  const CORNER = { x: 0, y: 0, w: R(before.width * 0.08), h: R(before.height * 0.12), label: 'corner' };
  const lumIn = (img, r) => rectStats(img, r).lum;
  const plateLum = { c: lumIn(before, CENTRE), k: lumIn(before, CORNER) };
  // The same wait the plate itself needed: three renders put the frame in the drawing buffer, and
  // the compositor still has to paint it before `screenshot` can see it. Without this the readings
  // below are of the *previous* uniform value — a stale frame is a silent zero.
  const settled = async (tag) => {
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await sleep(400);
    return capture(tag);
  };
  const setRim = await grade(0.3, 1);
  const rimImg = await settled('00b-flash-rim');
  const rimAt = { c: lumIn(rimImg, CENTRE), k: lumIn(rimImg, CORNER) };
  await grade(0.3, 0);
  const floodImg = await settled('00c-flash-flood');
  const floodAt = { c: lumIn(floodImg, CENTRE), k: lumIn(floodImg, CORNER) };
  await grade(0, 1);
  const restored = await settled('00d-restored');
  console.log(`  flash: plate ${plateLum.c.toFixed(1)}/${plateLum.k.toFixed(1)}`
    + `  rim ${rimAt.c.toFixed(1)}/${rimAt.k.toFixed(1)}`
    + `  flood ${floodAt.c.toFixed(1)}/${floodAt.k.toFixed(1)} (centre/corner luma)`);
  check('taking a hit lights the rim of the frame', rimAt.k - plateLum.k > 10,
    `corner +${(rimAt.k - plateLum.k).toFixed(1)} luma at uFlash 0.3, ${JSON.stringify(setRim)}`);
  check('...and leaves the middle of the picture, where the fight is, alone',
    Math.abs(rimAt.c - plateLum.c) < 1.5, `centre ${plateLum.c.toFixed(2)} -> ${rimAt.c.toFixed(2)} luma`);
  check('...and turning the mask off floods the whole frame again',
    floodAt.c - plateLum.c > 10, `centre +${(floodAt.c - plateLum.c).toFixed(1)} luma at uFlashEdge 0`
      + ` (against +${(rimAt.c - plateLum.c).toFixed(1)} with the mask on)`);
  check('...and the flash is back at zero, so the frames below still have their control',
    pixelsDiffering(restored, before, 8) === 0,
    `${pixelsDiffering(restored, before, 8)} px differ from the pre-hit plate`);
  await p.evaluate(() => window.__fire(false));
  const shots = [];
  let at = 0;
  for (const t of PHASES) {
    await step(Math.round((t - at) * 60));
    at = t;
    shots.push({ t, img: await capture(`${(shots.length + 1).toString().padStart(2, '0')}-${t.toFixed(2)}s`) });
  }
  const rec = await p.evaluate(() => ({ cues: window.__cues, react: window.__react }));

  const grew = shots.map((s) => diffMask(s.img, before, 8));
  console.log(`  phases: ${shots.map((s, i) => `${s.t}s ${grew[i].count}px`).join('  ')}`);
  check('the reaction the server sent drew light on screen', grew[0].count > 800,
    `${grew[0].count} px at ${PHASES[0]} s, box ${grew[0].box ? `${grew[0].box.w}x${grew[0].box.h}` : 'none'}`);
  // Time evolution, which is the second gap this section closes. Both consecutive pairs, so a
  // frozen effect (identical frames) and a static one (drawn once, never updated) both fail.
  for (let i = 0; i + 1 < 3; i++) {
    const n = pixelsDiffering(shots[i].img, shots[i + 1].img, 8);
    check(`...and its shape moves between ${PHASES[i]} s and ${PHASES[i + 1]} s`, n > 800, `${n} px differ`);
  }
  // And it is finite: `MeshPool` retires the shell and the rings, and the frame comes back.
  check(`...and it is over by ${PHASES[3]} s`, grew[3].count <= 200,
    `${grew[3].count} px still differ from the pre-hit frame`);

  // The reaction's own light, against the plain hit **the same payload** would have drawn. The
  // hit sparks, the flash and the damage number are all still there in the control, so what this
  // measures is what the reaction added — the same subtraction section 3 makes, on a payload
  // nobody in this process wrote.
  await p.evaluate(() => window.__fire(true));
  let plainAt = 0;
  const PLAIN_PHASE = PHASES[1];
  await step(Math.round(PLAIN_PHASE * 60));
  plainAt = PLAIN_PHASE;
  const plainImg = await capture(`05-plain-${plainAt.toFixed(2)}s`);
  const own = diffMask(shots[1].img, plainImg, 8);
  check('...and it is the reaction\'s own light, not the hit\'s', own.count > 800,
    `${own.count} px over the same payload with the key stripped`);

  // Where it was drawn. The server sends the coordinates of the body it happened to, and the one
  // mistake this cannot survive is drawing every reaction on the player — which is exactly what
  // section 3's captures look like, because there the probe passes its own position.
  // The label projection when it has one, the raw one otherwise (see `ndc`): a body just outside
  // the viewport still has a screen position the two distances can be compared against, and the
  // light itself is on screen — that is what `grew[0]` measured.
  const atPt = got.at || (Math.abs(got.raw?.at?.z ?? 9) <= 1 ? got.raw.at : null);
  const mePt = got.me || (Math.abs(got.raw?.me?.z ?? 9) <= 1 ? got.raw.me : null);
  const box = own.box || grew[1].box;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const apart = atPt && mePt ? Math.hypot(atPt.x - mePt.x, atPt.y - mePt.y) : null;
  if (!atPt) {
    skip('...at the creature rather than at the player',
      `the creature has no screen position: ${JSON.stringify(got.raw ?? null)}`);
  } else if (mePt && apart < 80) {
    skip('...at the creature rather than at the player',
      `the two are ${apart.toFixed(0)} px apart on screen`);
  } else {
    const dHit = Math.hypot(cx - atPt.x, cy - atPt.y);
    const dMe = mePt ? Math.hypot(cx - mePt.x, cy - mePt.y) : null;
    // With both on screen the question is scale-free: whichever point the light sits nearer to is
    // the one it was drawn at. The trigger's 7.5 m dash often ends with the camera practically
    // inside the character (ndc z −59), and then there is no player point to compare against —
    // but that is the stronger half of the same question, not a weaker one: a reaction drawn at
    // the player would be *behind the camera* and paint nothing, and 160 px is a quarter of the
    // frame's height (the measured miss is 20–50 px).
    check('...at the creature rather than at the player', dMe != null ? dHit < dMe : dHit < 160,
      `effect centre (${cx.toFixed(0)},${cy.toFixed(0)}) is ${dHit.toFixed(0)} px from the hit`
      + (dMe != null ? ` and ${dMe.toFixed(0)} px from the character`
        : `, and the character is behind the camera (ndc z ${got.raw?.me?.z ?? '?'}) — light drawn`
          + ' there would paint nothing'));
  }

  check('...and asks for its own sound', rec.cues.includes(REACTION_SFX[plan.key]),
    `wanted ${REACTION_SFX[plan.key]}, got ${rec.cues.join(',') || 'silence'}`);
  const named = rec.react.find((r) => r.kind === plan.key);
  check('...and says its name to the HUD', !!named && named.name === REACTIONS[plan.key].name,
    named ? `「${named.name}」` : `no reaction event (${rec.react.length} events)`);

  check('no page errors while reacting', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  fails++;
  console.log(`  FAIL harness: ${e.message}`);
} finally {
  await b.close();
}

console.log(`\n${passes} passed, ${fails} failed, ${skips} skipped`);
process.exit(fails);
