// 元素附着 on the *player*: does being 湿身 look like anything?
//
//   node tools/player-aura-check.mjs --no-browser   # the consumer gate, from source
//   DISPLAY=:99 node tools/player-aura-check.mjs    # ...plus a real camp, in pixels
//
// `Player.serialize()` has always put `au: this.aura.dominant()` on the wire — one field, every
// snapshot, ten times a second. On the **enemy** side the matching field has two consumers (the
// body's glow through `EnemyActor.setElementAura`, and the 元素附着 pip on the nameplate), and
// `react-check`'s section 4 photographs both. On the player's side it had **none**: `applyServer`
// never read `au`, `CharacterActor` had an `aura` field nothing ever wrote and no
// `setElementAura` at all, and `hudState()` did not carry it. So a soaked traveller was
// pixel-identical to a dry one — no glow, no HUD, nothing to say that the next 雷 orb is a 感电
// rather than a bruise, and nothing to explain the damage number when it arrived.
//
// It stayed invisible because of a second defect, one layer down: `resolveEnemyAttack` reads
// `mv.element || e.def.element`, and `ATTACK_MOVES.basic` carries `element: 'physical'` — so every
// creature that attacks with the generic melee (水史莱姆 included) dealt physical and attached
// nothing. Nothing in the open world could make a player wet at all, so the missing consumer had
// nothing to be missing for. Both are fixed; this file is the gate.
//
// What it asks, and where:
//
//   * From source — the consumer gate. Every field in the player's own `serialize()` aura family
//     (`au`, `sh`, `she`) has a named reader in `client/src`, and the reading is done in both
//     directions so that a field with no reader *and* a reader of a field nobody sends are both
//     red. `fz` (frozen) is the one the player wire does not carry: the check is conditional, so
//     it is green today and stays green the day the player half is implemented — and goes red if
//     it is wired only half way.
//   * In a real fight — the pixels. The probe walks to the one camp in 蒙德 whose creatures carry
//     two *different* reactable elements (derived from `ZONES`, not written down), stands in it
//     without fighting back, and lets the simulation soak it. Then it freezes the page and
//     photographs three things against the same still-life: the glow on the character's own model
//     (with the aura, and with the same snapshot row minus `au`), the pip on the party card (the
//     same subtraction), and the reaction the sim itself computed on the player — which is the
//     other half of `react-check` section 4, whose payload is an *enemy* hit.
//
// The player payload carries no coordinates (`damagePlayer` sends `target/id/amount/element/
// kind/reaction/src` and no x,z), so where its effect is drawn is the client's own decision: at
// the player. That is the claim the position contrast below makes, against the attacker's own
// position, which `src` names.
//
// Exit code is the number of failed assertions.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, diffMask, rectStats } from './lib/png.mjs';
import { INSTALL, bootWorld, worldHelpers, levelParty } from './lib/probe-world.mjs';
import { ELEMENTS, REACTIONS, resolveReaction, auraDecayFor, AuraState } from '../shared/src/data/elements.js';
import { ZONES } from '../shared/src/data/zones.js';
import { ENEMIES } from '../shared/src/data/enemies.js';
import { CHARACTERS } from '../shared/src/data/characters.js';
import { totalXpTo } from '../shared/src/sim/formulas.js';
import { REACTION_SFX } from '../client/src/audio/audio.js';
import { ELEMENT_GLYPH } from '../client/src/ui/dom.js';

const root = path.resolve(import.meta.dirname, '..');
const noBrowser = process.argv.includes('--no-browser');
const base = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5173';
const outDir = process.argv.slice(2).find((a) => a.startsWith('/')) || '/tmp/player-aura';

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
const rgbOf = (hex) => `rgb(${[16, 8, 0].map((s) => (hex >> s) & 255).join(', ')})`;

/**
 * The body of one method, by balanced braces, with strings and comments skipped. (The same
 * scanner `react-check` and `telegraph-check` use; slicing "from the signature to the end of the
 * file" is what let one probe's first version count zero cases and pass.)
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

/** Differing pixels inside one rect — the whole-frame `diffMask` cannot answer "did *this* move". */
const diffRect = (a, b, r, tol = 8) => {
  let n = 0;
  for (let y = Math.max(0, r.y); y < Math.min(a.height, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(a.width, r.x + r.w); x++) {
      const i = (y * a.width + x) * 4;
      if (Math.abs(a.data[i] - b.data[i]) > tol || Math.abs(a.data[i + 1] - b.data[i + 1]) > tol
        || Math.abs(a.data[i + 2] - b.data[i + 2]) > tol) n++;
    }
  }
  return n;
};

/* ------------------------------------------------------------------------------ */
/* 1. The consumer gate: every field the player wire carries about its own aura     */
/* ------------------------------------------------------------------------------ */

console.log('--- 1. the wire and its readers');

const entitySrc = read('shared/src/world/entity.js');
// The *player's* serialize, not the enemy's — both classes have one, and the enemy's is the one
// that already worked. `PlayerEntity` is the second, so the scan starts from its declaration.
const playerCls = entitySrc.slice(entitySrc.indexOf('export class PlayerEntity'));
const playerSer = methodBody(playerCls, /\bserialize\(\)\s*\{/);
const enemySer = methodBody(entitySrc.slice(0, entitySrc.indexOf('export class PlayerEntity')),
  /\bserialize\(\)\s*\{/);
check('the scan found both serialize bodies', !!playerSer && !!enemySer
  && /\bpt:/.test(playerSer) && /\bt: this\.defId/.test(enemySer),
  `player ${playerSer?.length ?? 0} chars, enemy ${enemySer?.length ?? 0} chars`);

const keysOf = (body) => [...(body || '').matchAll(/(?:^|[\s{,])([a-z]{1,4}):/gm)].map((m) => m[1]);
const playerKeys = new Set(keysOf(playerSer));
check('...and the player wire carries an 元素附着 field at all', playerKeys.has('au'),
  [...playerKeys].join(' '));

const clientFiles = fs.readdirSync(path.join(root, 'client/src'), { recursive: true })
  .filter((f) => f.endsWith('.js')).map((f) => `client/src/${f}`);
check('the whole client was scanned for readers', clientFiles.length > 20, `${clientFiles.length} files`);
const readersOf = (key) => clientFiles.filter((f) => new RegExp(`\\b(?:you|nb|r|row|p)\\.${key}\\b`)
  .test(read(f)));
// The aura family: the three fields `serialize` sends about what is *on* my body. Every one needs a
// consumer, and this is the shape of check that would have caught the bug this file was written
// for — `au` was sent 10× a second and read by nobody, which no test in the repo could see.
for (const key of ['au', 'sh', 'she']) {
  const who = readersOf(key);
  check(`the client reads \`${key}\` somewhere`, who.length > 0, who.join(', ') || 'nobody');
}
// ...and the other direction, or the loop above is satisfied by a client that reads made-up
// fields: nothing may read a field the player wire does not send.
const invented = ['auz', 'frz'].filter((k) => readersOf(k).length);
check('...and reads nothing the wire never sends', invented.length === 0, invented.join(','));

const lpSrc = read('client/src/game/localPlayer.js');
const applyBody = methodBody(lpSrc, /\bapplyServer\(you, snap\)\s*\{/);
check('`applyServer` is where `au` is read', !!applyBody && /you\.au\b/.test(applyBody)
  && /setElementAura\(/.test(applyBody),
  applyBody ? `${applyBody.length} chars` : 'no applyServer body');

const actorsSrc = read('client/src/game/actors.js');
const charCls = actorsSrc.slice(actorsSrc.indexOf('export class CharacterActor'),
  actorsSrc.indexOf('export class EnemyActor'));
check('...and `CharacterActor` has the method to read it into',
  /setElementAura\(el, frozen = false, force = false\)/.test(charCls)
  && /setAura\(this\.rig\.group/.test(charCls));
// Three call sites, and each one is a different way for the glow to be wrong: the local player's
// snapshot, a remote player's snapshot (their 湿身 is my information too), and `setCharacter` —
// which rebuilds the model from scratch, so pressing 2 while wet used to be a towel.
const sites = [
  ['the local player', /this\.actor\?\.setElementAura\(this\.aura/.test(lpSrc)],
  ['remote players', /\.actor\.setElementAura\(nb\.au/.test(actorsSrc)],
  ['a party switch', /if \(this\.aura\) this\.setElementAura\(this\.aura, false, true\)/.test(charCls)],
];
check('every path that can put a body on screen feeds it',
  sites.every(([, ok]) => ok), sites.map(([n, ok]) => `${n}: ${ok ? 'yes' : 'NO'}`).join(', '));

const gameSrc = read('client/src/game/game.js');
const hudBody = methodBody(gameSrc, /\bhudState\(\)\s*\{/);
check('`hudState` carries it to the HUD', !!hudBody && /aura: this\.me\.aura/.test(hudBody));
const hudSrc = read('client/src/ui/hud.js');
check('...and the party card paints a pip from it',
  /st\.me\.aura/.test(hudSrc) && /cls\(c\.aura, 'on'/.test(hudSrc)
  && /ELEMENT_GLYPH\[aur\]/.test(hudSrc));
check('...with a CSS rule that draws it in the element\'s own colour',
  /\.pcard \.av \.aura\s*\{[^}]*var\(--au/.test(read('client/src/ui/style.css'))
  && /\.pcard \.av \.aura\.on\s*\{[^}]*display: block/.test(read('client/src/ui/style.css')));

// 冻结 is the one member of the family the player wire does *not* carry — the enemy's `serialize`
// has `fz` and `_syncEnemies` hands it to `setElementAura(el, frozen)`, while a frozen player is
// only ever a number inside `AuraState`. Conditional on purpose: green today (the field is not
// sent), green the day it is sent *and* read, red if it is sent and dropped — which is the failure
// this whole file exists to make impossible to ship again.
if (playerKeys.has('fz')) {
  check('the player wire\'s `fz` reaches a reader too', readersOf('fz').some((f) => /localPlayer|game\.js/.test(f)),
    readersOf('fz').join(', ') || 'nobody');
} else {
  skip('the player wire\'s `fz` reaches a reader too',
    'the player wire does not carry `fz` yet — a frozen player is not immobilised either'
    + ' (see 已知限制 in README)');
  check('...while the enemy wire\'s does', /\bfz:/.test(enemySer || '')
    && /nb\.fz\b/.test(actorsSrc), 'enemy fz → setElementAura(el, frozen)');
}

if (noBrowser) {
  console.log(`\n${passes} passed, ${fails} failed, ${skips} skipped`);
  process.exit(fails);
}

/* ------------------------------------------------------------------------------ */
/* 2. A real camp: the simulation attaches an element to the player, and it shows   */
/* ------------------------------------------------------------------------------ */

console.log('\n--- 2. a real camp');
fs.mkdirSync(outDir, { recursive: true });

/**
 * Which element *lingers*, derived from `AuraState` itself.
 *
 * 风 and 岩 are carriers, not auras: `AuraState.apply` returns before writing one (扩散 spreads
 * what is already there, 结晶 hands out a shield), so "the element sticks" is not a property of
 * every element and a probe that assumes it fails on two of them. Asked here rather than written
 * down, so a table change moves this file with it.
 */
const lingers = (el) => { const a = new AuraState(); a.apply(el, 1, 0); return a.dominant() === el; };

const puppeteer = (await import('puppeteer')).default;
const b = await puppeteer.launch({
  browser: 'firefox',
  headless: false,
  args: ['--width=1024', '--height=640'],
  defaultViewport: { width: 1024, height: 640 },
});
const p = await b.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

const { look, approach, travelTo, census, partyHp, unpause } = worldHelpers(p);

try {
  await bootWorld(p, { base, check, label: 'a fresh guest' });

  /**
   * Strong enough to be hit for a minute without dying.
   *
   * The probe's whole method is to *not* fight back: `autoAttack` off, no keys, standing in a camp
   * until the simulation has soaked it and then shocked it. A level-1 guest has 1030 hp and three
   * creatures hitting it, and a downed player carries no aura (and is looking at the 力竭 box), so
   * the party is levelled the way `mp-check` and `react-check` do it — materials from
   * `/api/dev/supply`, every level bought through `/api/char/levelup|ascend`. Level 30 is 3568 hp
   * against ~40 a hit here, which is minutes.
   */
  const WANT_LEVEL = 30;
  const token = await p.evaluate(() => localStorage.getItem('teyvat.token'));
  const grown = token ? await levelParty({ base, token, want: WANT_LEVEL, totalXpTo }) : { chars: [] };
  check('the party was levelled through the growth routes, not written',
    grown.chars.length > 1 && Math.min(...grown.chars) >= WANT_LEVEL,
    `levels ${grown.chars.join('/')} (wanted ${WANT_LEVEL}), AR ${grown.rank}, world ${grown.worldLevel}`);
  // The stat block the simulation fights with is the one the gateway builds at join.
  await bootWorld(p, { base, check, label: 'the levelled party' });
  const hp0 = await p.evaluate(() => ({ hp: Math.round(window.game.me.hp), max: Math.round(window.game.me.maxHp) }));
  check('...and joined with the hp that buys', hp0.hp > 1500 && hp0.hp === hp0.max, JSON.stringify(hp0));

  // Noon, pinned. The aura captures below are of the character's *body*, and a body is lit by the
  // sun: `daylight()` moves the DirectionalLight's colour and intensity through the day, so an
  // unpinned run compares an aura glow against whatever hour the wall clock happened to be in —
  // and the run that wrote these thresholds happened to be a bright one. `daylight-check` scans
  // every pixel probe for this line; the alternative it accepts is hiding the canvas, which this
  // probe cannot do because the canvas is its subject.
  const pinned = await p.evaluate(() => {
    const ok = window.game.setWorldTime(12);
    return { ok, label: window.game.clock.label, pinned: window.game.clock.pinned };
  });
  check('the hour is pinned to noon, so the body is lit the way these thresholds were measured',
    pinned.ok === true && pinned.pinned === true && pinned.label === '12:00', JSON.stringify(pinned));

  /**
   * Where a player can be made to react: derived from the zone's own spawn table.
   *
   * The camp has to attach **two different elements that react with each other**, which is a much
   * narrower thing than "a camp with elemental creatures": 蒙德's other five are single-element
   * (two 水史莱姆 and a 丘丘人, three 冰狼, …) and can soak a player forever without ever
   * triggering anything. `gauge > 0` is the attachment budget on the creature's own definition and
   * `lingers` is asked of the aura table, so a data change moves the fixture instead of breaking
   * the probe. The lowest-level camp that qualifies wins: it is the one the party outlives.
   */
  const zoneId = await p.evaluate(() => window.game.zoneId);
  const camp = (() => {
    let best = null;
    for (const s of ZONES[zoneId]?.spawns || []) {
      const els = [...new Set(s.enemies.map((id) => ENEMIES[id])
        .filter((d) => d && d.gauge > 0 && d.element && d.element !== 'physical' && lingers(d.element))
        .map((d) => d.element))];
      const keys = new Set();
      for (const a of els) for (const c of els) {
        if (a === c) continue;
        const r = resolveReaction(a, c);
        if (r) keys.add(r.key);
      }
      if (!keys.size) continue;
      const cand = { at: s.at, level: s.level, radius: s.radius, enemies: s.enemies,
        els, keys: [...keys] };
      if (!best || s.level < best.level) best = cand;
    }
    return best;
  })();
  if (!check(`${zoneId} has a camp that can react on a player at all`, !!camp,
    camp ? `${camp.enemies.join('+')} Lv.${camp.level} at ${camp.at}: ${camp.els.join('+')}`
      + ` → ${camp.keys.map((k) => `${REACTIONS[k]?.name || k}`).join('/')}`
      : 'no spawn carries two reacting elements')) throw new Error('no mixed camp in this zone');

  /**
   * The instrumentation. Four things it has to be able to do, and the reason for each:
   *
   *  * record what the wire said about my aura **and what the reader did with it**, every time the
   *    reader ran — `applyServer` is wrapped, so the log is the consumer's own history rather than
   *    a poll that samples whatever survived;
   *  * latch the first reaction the simulation puts on *me* (`target: 'player'` with a key), and
   *    keep drawing everything else so the fight continues normally;
   *  * freeze the page into a still-life, because llvmpipe draws 3 fps and a 0.5 s effect sampled
   *    from a live loop is a lottery on its phase (`applyServer` is called from `_frame`, so
   *    `g.stop()` alone pins `me.aura` — the socket may keep talking);
   *  * and re-apply the *server's own snapshot row* with one field changed, which is the control
   *    every reading below is measured against.
   */
  await p.evaluate(() => {
    const g = window.game;
    // The confounds: a floating number is a DOM layer that would be in the captures, a camera
    // shake would move the camera between them, and 点击攻击's auto-swing would kill the camp this
    // probe is standing in to be hit by.
    g.settings.showDamage = false;
    g.settings.cameraShake = false;
    g.settings.autoAttack = false;
    window.__wire = [];
    window.__auLog = [];
    window.__hit = null;
    window.__frozen = false;
    window.__you = null;

    // `...a` rather than `(you, snap)`: a wrapper that lists the parameters it forwards silently
    // drops the next one somebody adds (co-op paid only the last hitter for exactly that reason).
    const origApply = g.me.applyServer.bind(g.me);
    g.me.applyServer = (...a) => {
      const was = g.me.aura || null;
      origApply(...a);
      const rec = { au: a[0]?.au || null, me: g.me.aura || null, actor: g.me.actor?.aura || null };
      const last = window.__auLog[window.__auLog.length - 1];
      if (!last || last.au !== rec.au || last.me !== rec.me || last.actor !== rec.actor) {
        window.__auLog.push({ ...rec, was, t: Math.round(performance.now()) });
      }
    };

    const mine = (d) => d.target === 'player' && (d.id == null || Number(d.id) === Number(g.playerId));
    const orig = g._onDamage.bind(g);
    g._onDamage = (d) => {
      window.__wire.push(d);
      if (window.__frozen) return;      // the still-life is being photographed: nothing may paint
      if (mine(d) && d.reaction && !window.__hit) {
        // Latched *and* drawn: the fight is live and this is a real hit. The photograph below
        // re-fires this very payload through the same handler from a canonical frozen state, which
        // is the only way to compare it against anything.
        window.__hit = { d, wire: window.__wire.length, aura: g.me.aura || null,
          actor: g.me.actor?.aura || null, char: g.party[g.activeSlot], t: Math.round(performance.now()) };
      }
      orig(d);
    };

    // Where the player and its neighbourhood land on screen, through the camera as it stands.
    // Split out of `__freeze` because the body section re-frames the camera and has to re-ask:
    // a projection measured before the boom moved describes a picture nobody took.
    window.__proj = () => {
      const el = g.r.renderer.domElement;
      // `Vector3` out of the scene (`scene.position.constructor`) — the page has no THREE global.
      const V = (x, y, z) => {
        const v = new g.scene.position.constructor(x, y, z);
        v.project(g.camera);
        return { x: +((v.x * 0.5 + 0.5) * el.clientWidth).toFixed(1),
          y: +((-v.y * 0.5 + 0.5) * el.clientHeight).toFixed(1), z: +v.z.toFixed(3) };
      };
      const me = V(g.me.x, g.me.y + 0.9, g.me.z);
      // Pixels per metre at the player's own distance from the camera, so every "near enough"
      // below is a distance in **metres** instead of a pixel count that means nothing at another
      // viewport size or camera pitch.
      const up = V(g.me.x, g.me.y + 1.9, g.me.z);
      // The attacker, through the same camera. Carried here rather than only in `__freeze` because
      // "the light landed nearer to me than to it" is a claim about one picture, and the body
      // section moves the boom between the freeze and the frames that claim is measured on.
      const s = window.__hit?.d?.src ? g.actors.enemies.get(window.__hit.d.src) : null;
      return { V, me, up, perM: +Math.abs(up.y - me.y).toFixed(1),
        srcAt: s ? V(s.x, s.y + (s.actor.height || 1) * 0.5, s.z) : null,
        w: el.clientWidth, h: el.clientHeight,
        dist: +Math.hypot(g.camera.position.x - g.me.x, g.camera.position.y - (g.me.y + 0.9),
          g.camera.position.z - g.me.z).toFixed(2) };
    };
    window.__freeze = () => {
      window.__frozen = true;
      g.stop();
      const you = (g.socket.latest()?.players || [])
        .find((r) => Number(r.id) === Number(g.playerId)) || null;
      window.__you = you;
      const { V, me, up, perM, w, h, dist } = window.__proj();
      const src = window.__hit?.d?.src ? g.actors.enemies.get(window.__hit.d.src) : null;
      return {
        you, aura: g.me.aura || null, actorAura: g.me.actor?.aura || null,
        hud: g.hudState().me.aura || null,
        char: g.party[g.activeSlot], slot: g.activeSlot, element: g.me.def?.element || null,
        me, up, perM, w, h, dist,
        hp: Math.round(g.me.hp), maxHp: Math.round(g.me.maxHp),
        src: src ? { id: window.__hit.d.src, defId: src.defId, name: src.actor.def.name,
          d: +Math.hypot(src.x - g.me.x, src.z - g.me.z).toFixed(1),
          at: V(src.x, src.y + (src.actor.height || 1) * 0.5, src.z) } : null,
      };
    };
    /**
     * Put the camera a chosen number of metres from the body, along the direction it is already
     * looking from.
     *
     * Whatever the walk left the boom at is not a camera to photograph a model with. This camp
     * sits on a hillside, `CameraRig`'s occlusion sweep is allowed down to `MIN_DIST * 0.55`, and
     * it had pulled in to **1.05 m** — 707 px on every metre, a 1.8 m model overflowing a 640 px
     * frame, a "body box" of 1556x1839 that swallowed the whole picture *and* the control box
     * beside it (both read the same 151 px), and a "the change is centred on the character" bar of
     * 1.6 m on a frame only 1.4 m wide, which nothing could fail.
     *
     * The azimuth is left alone deliberately: the claim being measured is about the body's own
     * pixels moving, not about which side of it faces the lens, and turning the model would be a
     * probe-side fix-up for something the product never does.
     */
    window.__frameBody = (dist = 4.6) => {
      const V = (x, y, z) => new g.scene.position.constructor(x, y, z);
      const aim = V(g.me.x, g.me.y + 0.95, g.me.z);
      const dir = g.camera.position.clone().sub(aim);
      if (dir.lengthSq() < 1e-4) dir.set(0, 0.35, 1);
      dir.normalize();
      // A little above the aim point regardless of where the rig had ended up, so a boom that had
      // been jammed under the hillside does not photograph the model from its ankles.
      dir.y = Math.max(dir.y, 0.16);
      dir.normalize();
      g.camera.position.copy(aim).add(dir.multiplyScalar(dist));
      g.camera.lookAt(aim);
      g.camera.updateMatrixWorld(true);
      return window.__proj();
    };
    /**
     * The hurt vignette, pinned.
     *
     * `.hurt.on` is a full-screen red radial gradient with a 0.42 s CSS fade, and the class comes
     * off inside `hud.update(dt)` — which a stopped game does not call. So it sat frozen over the
     * HUD captures: the pip's own centre read (73,18,19) with the aura on and (68,102,111) with it
     * off, both of them the vignette rather than the bead, and a frame 1.2 s after the reaction
     * still differed from the pre-hit plate across 451338 px because the vignette had come back
     * with the re-fired payload. Returns the opacity it found, so "it was really covering the
     * frame" is a reading and not an assumption.
     */
    window.__hurt = (on) => {
      const el = document.querySelector('.hurt');
      if (!el) return null;
      const was = +getComputedStyle(el).opacity;
      el.style.transition = 'none';
      el.style.opacity = on ? '1' : '0';
      return was;
    };
    /**
     * The damage flash, pinned — the vignette's twin, one layer down.
     *
     * `col = mix(col, vec3(1.0, 0.72, 0.72), uHitFlash)` is the *last* line of the toon fragment,
     * so a frozen flash both pulls the body to pink and scales every term under it by
     * `1 - uHitFlash`. `hitFlash` decays at 5/s inside `Actor.update(dt)` — which a stopped game
     * never calls — and this probe freezes the moment a reaction lands, i.e. within 0.2 s of being
     * hit. Measured in `.run/coat-lab.mjs` by pinning the flash by hand at noon, on this same
     * character, over the same 8.8k body pixels: at 0 the body is 184,199,194 and the coat moves it
     * 28.4 counts toward 水; at 0.75 the body is 225,215,214 and the coat moves it 3.1. The probe's
     * own confirmation run read 225,215,214 and 2.7 — the same picture, digit for digit. So a run
     * that froze late passed and a run that froze early failed the *same* build. Pin it off, and
     * return what was found so the log says which run it was.
     */
    window.__flash = (v) => {
      const a = g.me.actor;
      let n = 0, was = 0;
      a?.rig?.group?.traverse((o) => {
        if (!o.material) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          const u = m?.userData?.toon;
          if (!u?.uHitFlash) continue;
          was = Math.max(was, u.uHitFlash.value);
          if (v != null) u.uHitFlash.value = v;
          n++;
        }
      });
      // The field too, or the next `update(dt)` puts the uniform straight back.
      if (v != null && a) a.hitFlash = v;
      return { n, was: +was.toFixed(3) };
    };
    // The control, and the restore: the server's own row with `au` set to whatever is asked for.
    // Through `applyServer` and `ui.update` — the product's consumers — rather than by writing
    // `me.aura`, because what is being measured *is* the consumer.
    window.__setAu = (el) => {
      g.me.applyServer({ ...window.__you, au: el }, null);
      window.ui.update(0.016);
      return { aura: g.me.aura || null, actor: g.me.actor?.aura || null,
        hud: g.hudState().me.aura || null };
    };
    // The glow itself, off the materials the shader reads. One entry per toon material on the rig,
    // deduped: a body whose head kept the old colour is a different failure from a body with no
    // glow at all, and both are invisible to "the field was set".
    window.__uni = () => {
      const out = [];
      g.me.actor?.rig?.group?.traverse((o) => {
        if (!o.material) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          const u = m?.userData?.toon;
          if (!u) continue;
          out.push({ glow: +u.uElementGlow.value.toFixed(3), col: u.uElementColor.value.getHex(),
            wash: +(u.uElementWash?.value ?? 0).toFixed(3) });
        }
      });
      return { n: out.length, glows: [...new Set(out.map((o) => o.glow))],
        cols: [...new Set(out.map((o) => o.col))],
        washes: [...new Set(out.map((o) => o.wash))] };
    };
    // The mutation: the coat, forced to a value, on the rig that is standing in front of the
    // camera right now. Writing the uniform directly is the point — it is the one term under test,
    // and 0 is the build this section was red on.
    window.__setWash = (v) => {
      let n = 0, was = null;
      g.me.actor?.rig?.group?.traverse((o) => {
        if (!o.material) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          const u = m?.userData?.toon;
          if (!u?.uElementWash) continue;
          if (was === null) was = u.uElementWash.value;
          u.uElementWash.value = v;
          n++;
        }
      });
      // The value it replaced, so the mutation can be undone exactly rather than by re-deriving
      // what the product would have written (`setElementAura` early-returns on an unchanged aura,
      // so re-applying the same row would not put it back).
      return { n, was };
    };
    window.__pips = () => [...document.querySelectorAll('.pcard')].map((n) => {
      const a = n.querySelector('.av .aura');
      const av = n.querySelector('.av');
      const cs = a ? getComputedStyle(a) : null;
      const r = a ? a.getBoundingClientRect() : null;
      const ar = av ? av.getBoundingClientRect() : null;
      // Where the pip *would* be on this card, from the avatar it is positioned against
      // (`top: -3px; right: -5px; 15x15` in style.css). An off-field card's pip is
      // `display: none`, so its own rect is 0x0 at 0,0 — padding that gave the control box
      // `-6,-6 12x12`, i.e. the top-left corner of the HUD, which is not a pip on any card.
      const box = ar ? { x: Math.round(ar.x + ar.width + 5 - 15), y: Math.round(ar.y - 3), w: 15, h: 15 } : null;
      return { slot: +n.dataset.slot, active: n.classList.contains('active'),
        display: cs?.display ?? 'missing', bg: cs?.backgroundColor ?? '',
        shadow: (cs?.boxShadow ?? '').slice(0, 40), text: a?.textContent ?? '', title: a?.title ?? '',
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        box };
    });
    window.__canvas = (on) => {
      g.r.renderer.domElement.style.visibility = on ? '' : 'hidden';
      return getComputedStyle(g.r.renderer.domElement).visibility;
    };
    window.__hideMe = () => { g.me.actor.group.visible = false; return true; };
    window.__step = (frames) => {
      for (let i = 0; i < frames; i++) g.vfx.update(1 / 60, g.camera);
      for (let i = 0; i < 3; i++) g.r.render(0.016);
      return true;
    };
    window.__fire = (strip) => {
      const d = window.__hit.d;
      window.__canon();
      window.__cues = [];
      window.__react = [];
      window.__seed(4242);
      orig(strip ? { ...d, reaction: null } : d);
      return true;
    };
    return true;
  });

  /**
   * Who stands on the field — chosen so the colour claim is not vacuous.
   *
   * `setElementAura(null)` puts the model back to its *innate* element glow, which is what the
   * control frame shows. If the character standing there happens to be 水元素 and the camp soaks
   * us with 水, the two frames differ only in strength (0.42 against 0.10) and "the glow is the
   * attached element's colour" says nothing at all. So the field character is one whose own
   * element is not among the camp's.
   */
  const roster = await p.evaluate(() => window.game.hudState().party
    .map((x) => ({ slot: x.slot, charId: x.charId, element: x.element, active: x.active })));
  const want = roster.find((r) => r && !camp.els.includes(r.element)) || roster[0];
  if (want && !want.active) {
    await unpause();
    await p.keyboard.press(`Digit${want.slot + 1}`);
    for (let i = 0; i < 12; i++) {
      const on = await p.evaluate(() => {
        const g = window.game;
        const you = (g.socket.latest()?.players || []).find((r) => Number(r.id) === Number(g.playerId));
        return { sim: you?.c || null, client: g.party[g.activeSlot] };
      });
      if (on.sim === want.charId && on.client === want.charId) break;
      await sleep(300);
    }
  }
  const onField = await p.evaluate(() => ({ char: window.game.party[window.game.activeSlot],
    element: window.game.me.def?.element || null }));
  check('the character on the field carries an element the camp cannot attach',
    !!onField.element && !camp.els.includes(onField.element),
    `${CHARACTERS[onField.char]?.name || onField.char} is ${onField.element},`
    + ` the camp attaches ${camp.els.join('+')}`);

  // The walk. 200 m at llvmpipe's 3 fps with `dt` clamped to 50 ms is about 0.9 m of ground per
  // second of wall clock, so this is the expensive half of the probe and the budget is generous.
  const from = await p.evaluate(() => [+window.game.me.x.toFixed(0), +window.game.me.z.toFixed(0)]);
  console.log(`  (walking ${Math.round(Math.hypot(camp.at[0] - from[0], camp.at[1] - from[1]))} m`
    + ` from ${from} to the ${camp.enemies.join('+')} camp at ${camp.at})`);
  const trip = await travelTo(camp.at, 600000, camp.radius + 6);
  console.log(`  (arrived ${trip.d} m from the camp centre at ${trip.x},${trip.z}, hp ${trip.hp}`
    + `${trip.timeout ? ' — out of budget' : ''}; party ${JSON.stringify(await partyHp())})`);
  if (!check('walked into the camp on the product\'s own click-to-move locomotion',
    trip.d <= camp.radius + 6 && trip.alive,
    `${trip.d} m from ${camp.at}, alive ${trip.alive}`)) throw new Error('never reached the camp');
  // ...and then into the middle of it. `radius + 6` is a generous arrival tolerance for a 200 m
  // walk, and a run that stopped 15.8 m short stood next to one creature with the other two 12 and
  // 18 m away — one element, no reaction, ever. The camp's own creatures spawn inside `radius`, so
  // standing at its centre is what puts more than one of them in range.
  const inside = await travelTo(camp.at, 180000, Math.max(2, Math.min(5, camp.radius)));
  console.log(`  (into the camp: ${inside.d} m from the centre (radius ${camp.radius} m), hp ${inside.hp})`);

  // Close in on one of the camp's *own* creatures, by name: after a 200 m walk the census also
  // contains whatever streamed in on the way, and a 丘丘人 attaches nothing.
  const inCamp = (e) => camp.enemies.includes(e.defId);
  const nearest = async () => (await census()).filter(inCamp).sort((a, c) => a.d - c.d)[0] || null;
  // A reaction needs *two* elements, so "the nearest creature that attaches something" is not
  // enough: this camp is two 雷史莱姆 and one 水史莱姆, and a run that parked next to the water
  // slime with both electro ones 12 and 18 m away soaked 204 payloads of pure 水 in four minutes,
  // lost the whole party's hp and never saw a reaction. What is needed is the nearest creature
  // whose element is *not* the one already attached — asked of the enemy sheet, so it follows the
  // data rather than a hard-coded pair.
  const elOf = (e) => ENEMIES[e.defId]?.element || null;
  const nearestOther = async (au) => (await census()).filter((e) => inCamp(e) && elOf(e)
    && elOf(e) !== 'physical' && elOf(e) !== au && resolveReaction(elOf(e), au))
    .sort((a, c) => a.d - c.d)[0] || null;
  let mob = await nearest();
  console.log(`  (camp: ${(await census()).map((e) => `${e.name} Lv.${e.lv} @${e.d}m`).join(', ')})`);
  if (mob) await approach(mob.id, 2.4, 60000, 0.9);
  mob = await nearest();
  check('stood next to a creature that can attach something',
    !!mob && mob.d <= 5, mob ? `${mob.name} Lv.${mob.lv} at ${mob.d} m` : 'none of the camp is in the page');

  /**
   * Stand there and be hit.
   *
   * Nothing is pressed from here on: the simulation soaks the player with 水 (gauge 1, which
   * `auraDecayFor` keeps alive for seconds) and then a 雷 orb turns it into 感电 — on the server,
   * by `damagePlayer` → `AuraState.apply` → `resolveReaction`, with no client involvement at all.
   * The wait ends when **both** halves are in hand: a reaction has been latched, and the wire has
   * an aura on the player *right now*, because the pixel work below needs a live attachment to
   * freeze on. The two are independent — the reaction consumes what it reacted with — so this
   * polls for the pair rather than for either one.
   */
  const state = () => p.evaluate(() => {
    const g = window.game;
    const you = (g.socket.latest()?.players || []).find((r) => Number(r.id) === Number(g.playerId));
    return { au: you?.au || null, me: g.me.aura || null, hit: window.__hit?.d?.reaction || null,
      wire: window.__wire.length, log: window.__auLog.length, hp: Math.round(g.me.hp),
      maxHp: Math.round(g.me.maxHp || 0), alive: !!g.me.alive };
  });
  /**
   * Eat, the way the inventory panel does.
   *
   * Standing in a camp of four for minutes costs the party its whole health bar: one run got its
   * reaction at **hp 0/3782** and photographed a corpse, and then the respawn put the body 200 m
   * away — so the pip read the dead card's grey (22,24,29) and the phase section measured the
   * effect against a projection 183 m off screen. A fresh guest starts with five 甜甜花酿鸡
   * (`repo.js`: 2000 flat + 18 % of max hp each, so ~12 k hp of headroom), and `useConsumable` is
   * the function the panel's own button calls — the gateway rate-limits it to 6 per 10 s, which one
   * dish per poll cycle stays well under.
   */
  const eat = () => p.evaluate(async () => {
    const g = window.game;
    const id = ['sweetMadame', 'northernStew', 'mushroomPizza', 'suspiciousFood']
      .find((q) => (g.player?.inventory?.[q] || 0) > 0);
    if (!id) return null;
    try { await g.useConsumable(id); return id; } catch (e) { return `refused:${e?.code || e?.message}`; }
  });
  const deadline = Date.now() + 300000;
  let frozen = null, last = 0, ate = [], lastAte = 0;
  for (;;) {
    const st = await state();
    // Alive is part of the freeze condition, not a separate check after it: a downed character is
    // still drawn, still carries the aura on the wire and still satisfies every other clause here.
    if (st.hit && st.au && st.me && st.alive) {
      frozen = await p.evaluate(() => window.__freeze());
      break;
    }
    if (Date.now() > deadline) break;
    if (st.maxHp && st.hp < st.maxHp * 0.55 && Date.now() - lastAte > 2500) {
      lastAte = Date.now();
      const dish = await eat();
      if (dish) ate.push(dish);
      console.log(`  (hp ${st.hp}/${st.maxHp} — ate ${dish || 'nothing: the pantry is empty'})`);
    }
    if (!st.alive) { console.log('  (the party was downed while standing in the camp)'); break; }
    if (Date.now() - last > 12000) {
      last = Date.now();
      console.log(`  (waiting: ${st.wire} payload(s), aura ${JSON.stringify(st.au)}, reaction`
        + ` ${JSON.stringify(st.hit)}, hp ${st.hp}, ${st.log} aura transition(s))`);
      // The creatures hop about and a 水史莱姆 that wandered 12 m off attaches nothing. Re-close
      // the gap, without ever attacking: on the creature that carries the *other* element once
      // something is attached, because standing in range of one element for four minutes only
      // renews that element, and on the nearest one otherwise.
      const now = (st.au ? await nearestOther(st.au) : null) || await nearest();
      if (now && now.d > 5) {
        console.log(`  (closing on ${now.name} @${now.d}m — ${elOf(now) || 'physical'}`
          + `${st.au ? ` against the ${st.au} already attached` : ''})`);
        await approach(now.id, 2.4, 20000, 0.9);
      }
    }
    await sleep(500);
  }

  const auLog = await p.evaluate(() => window.__auLog);
  const hit = await p.evaluate(() => window.__hit);
  console.log(`  (aura transitions: ${auLog.slice(0, 12).map((r) => `${r.au ?? '—'}`).join(' → ')}`
    + `${auLog.length > 12 ? ` … ${auLog.length} total` : ''})`);
  if (!check('the simulation attached an element to the player', auLog.some((r) => r.au),
    auLog.length ? `${auLog.filter((r) => r.au).length} of ${auLog.length} transitions carry one`
      : 'the wire never said anything about my aura')) {
    throw new Error('nothing was ever attached to the player');
  }
  // Every element the wire ever put on us is one this camp can actually apply, and it lingers.
  const seenEls = [...new Set(auLog.map((r) => r.au).filter(Boolean))];
  check('...one the camp\'s own creatures carry',
    seenEls.length > 0 && seenEls.every((el) => camp.els.includes(el)),
    `${seenEls.join('+')} against ${camp.els.join('+')} (decay ${seenEls
      .map((el) => `${el} ${auraDecayFor(el)}s`).join(', ')})`);
  // The reader, over the whole history rather than at one instant: every time `applyServer` ran,
  // the client's own record and the model's glow state came out of the field the wire sent. This
  // is the assertion that was impossible to pass before this round — `au` reached no reader at all,
  // so `me` and `actor` were null through every transition while `au` cycled.
  const wrong = auLog.filter((r) => r.me !== r.au || r.actor !== r.au);
  check('...and the client\'s own record followed it, every time, in both directions',
    auLog.length >= 2 && wrong.length === 0,
    `${auLog.length} transitions, ${wrong.length} disagreed`
    + `${wrong.length ? `: ${JSON.stringify(wrong.slice(0, 3))}` : ''}`);
  check('...including the dry state, so the pip has a way back off',
    auLog.some((r) => r.au === null && r.was !== null) || auLog.some((r) => r.au === null),
    `${auLog.filter((r) => r.au === null).length} transition(s) back to nothing`);

  if (!check('the simulation computed a reaction on the player itself', !!frozen && !!hit,
    hit ? `${hit.d.reaction}` : `no reaction in ${(await state()).wire} payload(s)`
      + ' — the camp never landed its second element')) {
    throw new Error('no player-side reaction to photograph');
  }
  const au = frozen.aura;
  console.log(`  (froze with ${au} attached to ${CHARACTERS[frozen.char]?.name}, hp ${frozen.hp}/${frozen.maxHp},`
    + ` ${frozen.perM} px per metre, camp reaction ${hit.d.reaction})`);
  // A body, not a corpse — the precondition for every picture below. See `eat` above for what this
  // caught: a downed character keeps its aura on the wire and keeps being drawn, so without this
  // clause the section photographed one and then chased its respawn 200 m across the map.
  check('...on a character who is still standing, so the pictures below are of a body',
    frozen.hp > 0,
    `hp ${frozen.hp}/${frozen.maxHp}, ate ${ate.length ? ate.join('+') : 'nothing'} while being soaked`);
  check('the freeze caught the attachment on the wire, the record and the HUD state',
    !!au && frozen.you?.au === au && frozen.actorAura === au && frozen.hud === au,
    `wire ${JSON.stringify(frozen.you?.au)}, me ${JSON.stringify(au)},`
    + ` actor ${JSON.stringify(frozen.actorAura)}, hudState ${JSON.stringify(frozen.hud)}`);

  /* -------------------------------------------------------- the model's glow -- */

  /**
   * The glow on the character's own body, in the uniforms the shader reads and then in pixels.
   *
   * Both, because either alone is a half-answer: a uniform that no material on screen uses is the
   * `uVaultCol` bug (magenta, moved 0 px), and a pixel difference with no named cause could be
   * anything. So the uniforms say *what was asked for on every material of the rig*, and the two
   * captures say the request reached the screen.
   */
  const uAura = await p.evaluate(() => window.__uni());
  const dry = await p.evaluate(() => window.__setAu(null));
  const uDry = await p.evaluate(() => window.__uni());
  check('the aura is written to every toon material on the rig',
    uAura.n > 4 && uAura.glows.length === 1 && uAura.cols.length === 1
    && uAura.cols[0] === ELEMENTS[au].color && uAura.glows[0] > uDry.glows[0],
    `${uAura.n} materials, glow ${uAura.glows.join('/')} colour`
    + ` ${uAura.cols.map((c) => `0x${c.toString(16)}`).join('/')}, wanted 0x${ELEMENTS[au].color.toString(16)}`
    + ` (${ELEMENTS[au].name})`);
  // `washes` is in here for a reason that is not about the aura at all: the coat is a *new* term in
  // TOON_FRAG, and every enemy sheet and character shot in the suite was calibrated before it
  // existed. Those frames stay bit-identical only if the term is exactly 0 at the resting operating
  // point — not small, 0 — so that is asserted on the uniform rather than assumed from the code.
  check('...and stripping `au` from the same snapshot row puts the innate one back, coat and all',
    dry.aura === null && dry.actor === null && uDry.cols.length === 1
    && uDry.cols[0] === (ELEMENTS[onField.element]?.color ?? 0xffffff)
    && uDry.glows.length === 1 && uDry.glows[0] < uAura.glows[0]
    && uDry.washes.length === 1 && uDry.washes[0] === 0,
    `glow ${uDry.glows.join('/')} coat ${uDry.washes.join('/')} (must be exactly 0)`
    + ` colour ${uDry.cols.map((c) => `0x${c.toString(16)}`).join('/')},`
    + ` ${CHARACTERS[onField.char]?.name} is ${onField.element}`
    + ` (0x${(ELEMENTS[onField.element]?.color ?? 0xffffff).toString(16)})`);

  const cap = async (tag) => {
    const file = `${outDir}/${tag}.png`;
    await p.screenshot({ path: file });
    return decodePng(fs.readFileSync(file));
  };
  // Render, let the compositor take it, render again, then capture — a screenshot returns the
  // *last composited* frame, and on llvmpipe at 6 fps a capture taken straight after a step
  // returns the one before it. That is how the 0.05 s phase below came back bit-identical to the
  // pre-hit plate: `0 px` was not "nothing was drawn", it was "nothing was drawn *yet*".
  const shoot = async (tag, steps = 0) => {
    await p.evaluate((n) => window.__step(n), steps);
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await sleep(260);
    await p.evaluate(() => window.__step(0));
    return cap(tag);
  };

  // The body against black, with the world hidden and the player's own group kept — `photograph
  // the model alone`, so the difference between the two frames can only be the body.
  const iso = await p.evaluate(() => window.__isolate([window.game.me.actor.group]));
  check('the world was hidden and the character was not', iso.hidden > 0 && iso.pools > 50,
    `${iso.hidden} scene children hidden, ${iso.pools} kept`);
  // ...and the effect layer emptied. `__isolate` *keeps* the vfx pools (they are what every other
  // probe is there to photograph), so the leftovers of a fight were still in frame: a violet
  // bokeh of additive orbs over a plate at luma 135, bloom-flooded by a body filling a 1.05 m
  // camera. Nothing to do with the aura, and it is the background both readings are taken over.
  await p.evaluate(() => window.__canon());
  // ...and the damage flash pinned off. See `__flash`: it is the last line of the fragment shader
  // and this probe freezes within 0.2 s of being hit, so whether the body is its own colour or pink
  // depended on which tick the reaction landed on. Read once for the log, then pinned, then read
  // back — the pin is asserted on the mutation below rather than trusted.
  const flashWas = await p.evaluate(() => window.__flash(0));
  const flashNow = await p.evaluate(() => window.__flash(null));
  // The vignette is the same leftover one layer up, and it belongs here rather than only over the
  // HUD captures further down: on a run that froze on the very tick a hit landed (`damage flash 1`
  // in the line below) it sat at full opacity over *these* captures too. The black plate read luma
  // 15.4 instead of 4.1, and 648813 of 655360 px moved between two consecutive captures of the
  // *same dry body*, because its 0.42 s CSS fade was running through both of them.
  const hurtWas = await p.evaluate(() => window.__hurt(false));
  const framed = await p.evaluate(() => window.__frameBody(4.6));
  const bodyBox = {
    x: Math.round(framed.me.x - framed.perM * 1.1), y: Math.round(framed.me.y - framed.perM * 1.6),
    w: Math.round(framed.perM * 2.2), h: Math.round(framed.perM * 2.6),
  };
  // ...and the same box moved three metres to the side, which is empty black in both frames. A
  // one-sided "it differed" is equally true of a frame that changed everywhere.
  const offBox = { ...bodyBox, x: Math.max(0, Math.min(framed.w - bodyBox.w,
    bodyBox.x + Math.round(framed.perM * 3.4))) };
  console.log(`  (camera ${frozen.dist} m -> ${framed.dist} m, ${frozen.perM} -> ${framed.perM} px/m;`
    + ` body box ${bodyBox.x},${bodyBox.y} ${bodyBox.w}x${bodyBox.h} in ${framed.w}x${framed.h};`
    + ` damage flash ${flashWas.was} when we froze, now ${flashNow.was} on ${flashNow.n} materials)`);
  // The framing is a precondition, so it is a reading: a box that does not fit inside the frame
  // cannot be told apart from the control box beside it, and a metre that spans most of the
  // viewport makes every distance-in-metres bar below unfailable.
  check('the model is framed, so "on the body" and "beside it" are different pixels',
    bodyBox.w > 0 && bodyBox.x >= 0 && bodyBox.y >= 0
    && bodyBox.x + bodyBox.w <= framed.w && bodyBox.y + bodyBox.h <= framed.h
    && offBox.x >= bodyBox.x + bodyBox.w * 0.8,
    `${bodyBox.w}x${bodyBox.h} at ${bodyBox.x},${bodyBox.y} inside ${framed.w}x${framed.h},`
    + ` control box at ${offBox.x} (body ends at ${bodyBox.x + bodyBox.w})`);

  const bodyDry = await shoot('01-body-dry');
  const bodyFloor = await shoot('01-body-dry-again');
  await p.evaluate((el) => window.__setAu(el), au);
  const bodyAura = await shoot('02-body-aura');
  const floorPx = diffMask(bodyFloor, bodyDry, 8).count;

  const readBody = (img) => ({
    onBody: diffRect(img, bodyDry, bodyBox), offBody: diffRect(img, bodyDry, offBox),
    whole: diffMask(img, bodyDry, 8),
  });
  const withCoat = readBody(bodyAura);
  const plate = rectStats(bodyDry, { ...offBox, label: 'plate' });

  /**
   * The body's own colour: the mean over the pixels that *are* the model.
   *
   * A rect mean cannot answer this. The tightest box that certainly holds torso and skirt is still
   * 64 % black plate at this framing, so a coat that moved every body pixel by 25 counts showed up
   * as 9 on the rect's mean — a reading that says "barely visible" about a body that is visibly
   * blue. The mask is taken from the **dry** frame (luma > 40, i.e. "brighter than the plate"), so
   * which pixels are measured is decided before the aura is applied and cannot be selected by what
   * the aura happened to change.
   */
  const bodyPx = (() => {
    const pts = [];
    for (let y = bodyBox.y; y < bodyBox.y + bodyBox.h; y++) {
      for (let x = bodyBox.x; x < bodyBox.x + bodyBox.w; x++) {
        const i = (y * bodyDry.width + x) * 4;
        const l = 0.2126 * bodyDry.data[i] + 0.7152 * bodyDry.data[i + 1] + 0.0722 * bodyDry.data[i + 2];
        if (l > 40) pts.push(i);
      }
    }
    return pts;
  })();
  const bodyMean = (img) => {
    let r = 0, g = 0, bl = 0;
    for (const i of bodyPx) { r += img.data[i]; g += img.data[i + 1]; bl += img.data[i + 2]; }
    return [r / bodyPx.length, g / bodyPx.length, bl / bodyPx.length];
  };
  // How far a colour moved **toward this element's own hue**, in sRGB counts: the change projected
  // onto the element's chroma direction (its colour with the grey taken out). A plain distance
  // would score a coat that merely brightened the model, and 水 is not "brighter" — it is
  // 0x3aa7ff, which is 95 counts of blue and *minus* 102 of red away from neutral.
  const chromaDir = (() => {
    const c = [(ELEMENTS[au].color >> 16) & 255, (ELEMENTS[au].color >> 8) & 255, ELEMENTS[au].color & 255];
    const m = (c[0] + c[1] + c[2]) / 3;
    const v = c.map((q) => q - m);
    const n = Math.hypot(...v);
    return v.map((q) => q / n);
  })();
  const toward = (a, b) => +a.reduce((s, v, i) => s + (v - b[i]) * chromaDir[i], 0).toFixed(1);
  const dryMean = bodyMean(bodyDry);
  const auraMean = bodyMean(bodyAura);
  const shownRgb = (v) => v.map((q) => Math.round(q)).join(',');
  console.log(`  (${withCoat.onBody} px on the body, ${withCoat.offBody} beside it,`
    + ` ${withCoat.whole.count} px in frame, floor ${floorPx} px; plate luma ${plate.lum};`
    + ` ${bodyPx.length} body px ${shownRgb(dryMean)} -> ${shownRgb(auraMean)},`
    + ` ${toward(auraMean, dryMean)} counts toward ${ELEMENTS[au].name})`);
  // The background both readings are taken over, asserted rather than printed. Two captures of the
  // same dry body have to be the same picture: when they are not, every count below is measuring
  // whatever else was moving (a vfx leftover, the vignette's CSS fade, a hit flash decaying), and
  // the reds that follow name the aura for it.
  check('the pair was shot over a black, still plate, so the only difference can be the body',
    plate.lum < 8 && floorPx < 300,
    `plate luma ${plate.lum}, ${floorPx} px move between two captures of the same dry body`
    + ` (vignette ${hurtWas} when we froze, damage flash ${flashWas.was})`);
  check('the attachment changed the character on screen, on the body and nowhere else',
    withCoat.onBody > Math.max(300, floorPx * 3) && withCoat.offBody <= 20
    && withCoat.whole.count > 300,
    `${withCoat.onBody} px on the body, ${withCoat.offBody} px in the same box 3.4 m to the side`
    + ` (noise floor ${floorPx} px)`);
  // ...and the difference is *where the character is*, not somewhere else in the frame.
  if (withCoat.whole.box) {
    const cx = withCoat.whole.box.x + withCoat.whole.box.w / 2;
    const cy = withCoat.whole.box.y + withCoat.whole.box.h / 2;
    const off = Math.hypot(cx - framed.me.x, cy - framed.me.y) / framed.perM;
    check('...centred on the character rather than anywhere in the frame', off < 1.6,
      `the changed pixels' centre is ${off.toFixed(2)} m from the character's own projection`
      + ` (${framed.perM} px/m, so the frame is ${(framed.w / framed.perM).toFixed(1)} m wide)`);
  } else {
    check('...centred on the character rather than anywhere in the frame', false, 'nothing differed');
  }
  /**
   * The coat, swept: the term under test moved and nothing else.
   *
   * 0 is the build this section was red on — the additive glow alone moved a near-white torso by
   * 3/255 (208,203,205 -> 208,204,208). The intermediate values are here because the authored
   * `AURA_WASH` is a number somebody has to choose, and a probe that only knows "0 is bad" cannot
   * say whether 0.45 was a taste or a measurement. The sweep is printed; the assertions below use
   * the authored value and 0.
   */
  const SWEEP = [0, 0.15, 0.3, 0.6];
  const wash = await p.evaluate(() => window.__setWash(0));
  const bodyNoCoat = await shoot('02b-body-aura-nocoat');
  const noCoat = readBody(bodyNoCoat);
  const noCoatMean = bodyMean(bodyNoCoat);
  const sweep = [{ v: wash.was, toward: toward(auraMean, dryMean), px: withCoat.onBody }];
  for (const v of SWEEP) {
    const set = await p.evaluate((q) => window.__setWash(q), v);
    const img = await shoot(`02c-body-wash-${v}`);
    sweep.push({ v, toward: toward(bodyMean(img), dryMean), px: diffRect(img, bodyDry, bodyBox),
      n: set.n });
  }
  await p.evaluate((v) => window.__setWash(v), wash.was);
  console.log(`  (coat sweep on ${wash.n} materials, counts toward ${ELEMENTS[au].name}:`
    + ` ${sweep.sort((a, b) => a.v - b.v).map((s) => `${s.v}→${s.toward}`).join('  ')})`);
  check('...and it is the coat that does it, not the glow that was already there',
    wash.n > 10 && wash.was > 0.001
    && toward(noCoatMean, dryMean) < toward(auraMean, dryMean) * 0.5,
    `the body moved ${toward(auraMean, dryMean)} counts toward ${ELEMENTS[au].name} with the coat at`
    + ` ${wash.was} and ${toward(noCoatMean, dryMean)} with it forced to 0 on ${wash.n} materials`
    + ` (${shownRgb(dryMean)} -> ${shownRgb(auraMean)} / ${shownRgb(noCoatMean)})`);
  // 13 because the sweep in this same run brackets it from both sides: 0.30 was measured at 11.1
  // and rejected as still too faint, and the authored 0.45 reads 14.9 here and 17.8-33.2 in the
  // lab across four azimuths and four exposures. A bar between the setting that was rejected and
  // the one that was chosen fails a build that quietly turns the coat down.
  check('...by a distance a player can see, not by three counts of blue',
    toward(auraMean, dryMean) > 13,
    `${toward(auraMean, dryMean)} counts of ${ELEMENTS[au].name} over ${bodyPx.length} body pixels`
    + ` (the glow alone: ${toward(noCoatMean, dryMean)})`);
  /**
   * ...measured on the body's own colour, with the damage flash put back to prove it.
   *
   * This is the mutation for the pin above, and it is also the whole story of a red run: with the
   * flash at 0.75 the *same* aura, the same coat and the same camera move the body 3 counts instead
   * of 15, because `mix(col, vec3(1.0, 0.72, 0.72), uHitFlash)` is the last thing the fragment does
   * and it scales every term under it by `1 - uHitFlash`. Two consecutive runs of this probe
   * disagreed on nothing else: 196,193,194 with 14.9 counts, and 225,215,214 with 2.7.
   */
  const FLASH_ON = 0.75;
  await p.evaluate((v) => window.__flash(v), FLASH_ON);
  const bodyFlash = await shoot('02d-body-hitflash');
  const flashMean = bodyMean(bodyFlash);
  const flashBack = await p.evaluate(() => window.__flash(0));
  check('...on the body\'s own colour, with the damage flash pinned off',
    flashNow.n > 10 && flashNow.was === 0 && flashBack.was === FLASH_ON
    && toward(flashMean, dryMean) < toward(auraMean, dryMean) * 0.4,
    `the flash was ${flashWas.was} when the reaction froze the game and 0 for both captures;`
    + ` put back at ${FLASH_ON} the same coat moves the body ${toward(flashMean, dryMean)} counts`
    + ` instead of ${toward(auraMean, dryMean)} (${shownRgb(dryMean)} -> ${shownRgb(flashMean)})`);

  /* ------------------------------------------------------------ the HUD pip -- */

  /**
   * The party card's pip, in computed style and in pixels.
   *
   * A `classList` check would pass on a build where the CSS rule was deleted, so the style
   * reading is the *computed* one — and the pixels are read with the canvas hidden, because a
   * 15 px bead over a moving world cannot be told from the world (that is what
   * `hide the canvas to read the HUD` is about). The control is the same bead with `au` stripped
   * from the same row, and the *other* cards' beads, which must not move either way.
   *
   * Both frames are taken with the hurt vignette pinned off. It is a full-screen red gradient
   * whose class only comes off inside `hud.update(dt)`, so on a stopped page it stayed on — and it
   * came off *between* these two captures, on its own 0.42 s CSS fade. That put a red wash over
   * one frame and not the other: every rect in the HUD differed, the bead's own centre read
   * (73,18,19) with the aura on and (68,102,111) with it off, and the frame's top-left corner —
   * the "control" the old code was accidentally measuring — went 96,17,17 -> 11,13,20.
   */
  await p.evaluate(() => {
    // The isolate hid the HUD to photograph the body; the pip lives there.
    const el = document.querySelector('[data-hud]');
    if (el) el.style.display = '';
    return true;
  });
  await p.evaluate(() => window.__canvas(false));
  // Pinned since the body section (`hurtWas` was read there); re-pinned because the HUD it lives in
  // was hidden and has just come back.
  await p.evaluate(() => window.__hurt(false));
  await p.evaluate((el) => window.__setAu(el), au);
  const pipsOn = await p.evaluate(() => window.__pips());
  await sleep(500);
  const hudAura = await cap('03-hud-aura');
  await p.evaluate(() => window.__setAu(null));
  const pipsOff = await p.evaluate(() => window.__pips());
  await sleep(500);
  const hudDry = await cap('04-hud-dry');

  const active = pipsOn.find((c) => c.active);
  const others = pipsOn.filter((c) => !c.active);
  const activeOff = pipsOff.find((c) => c.slot === active?.slot);
  check('the active card\'s pip is on, in the element\'s colour, with its glyph and its name',
    !!active && active.display !== 'none' && active.bg === rgbOf(ELEMENTS[au].color)
    && active.text === (ELEMENT_GLYPH[au] || '✦') && active.title === `元素附着：${ELEMENTS[au].name}`,
    `${JSON.stringify(active)} wanted ${rgbOf(ELEMENTS[au].color)} 「${ELEMENT_GLYPH[au]}」`);
  check('...and the off-field cards have none, because one body carries the aura',
    others.length > 0 && others.every((c) => c.display === 'none'),
    others.map((c) => `${c.slot}:${c.display}`).join(' '));
  check('...and it goes away when the wire stops sending it',
    !!activeOff && activeOff.display === 'none',
    JSON.stringify(activeOff));

  // The vignette really was over these frames, and pinning it off really was what removed it:
  // put it back and see the frame move. Without this the pin is an unproven precaution, and a
  // build that deleted `.hurt` altogether would look the same as one where it was handled.
  if (hurtWas == null) {
    skip('the hurt vignette was pinned off, so the bead is measured against the panel',
      'the page has no .hurt element to pin');
  } else {
    await p.evaluate(() => window.__hurt(true));
    await sleep(120);
    const hudHurt = await cap('03b-hud-hurt');
    await p.evaluate(() => window.__hurt(false));
    const covered = diffMask(hudHurt, hudAura, 8).count;
    const frame = hudAura.width * hudAura.height;
    console.log(`  (hurt vignette: opacity ${hurtWas} when we arrived;`
      + ` showing it again moves ${covered} px of ${frame})`);
    check('the hurt vignette was pinned off, so the bead is measured against the panel',
      covered > frame * 0.25,
      `${covered} px of ${frame} move when it is put back (opacity found: ${hurtWas})`);
  }

  // The bead's rect derived from the avatar it is positioned against, not from its own
  // `getBoundingClientRect()`: an off-field card's pip is `display: none`, so its own rect is
  // 0x0 at 0,0 and the old `pad(rect, 6)` turned the control into `-6,-6 12x12` — the HUD's
  // top-left corner, which is not a pip on any card and moved 96,17,17 -> 11,13,20 on the
  // vignette alone.
  const pipRect = active?.box;
  const ctrlRects = others.map((c) => c.box).filter(Boolean);
  if (pipRect && ctrlRects.length) {
    const onPip = diffRect(hudAura, hudDry, pipRect);
    const ctrl = ctrlRects.map((r) => diffRect(hudAura, hudDry, r));
    console.log(`  (pip rect ${pipRect.x},${pipRect.y} ${pipRect.w}x${pipRect.h}: ${onPip} px differ;`
      + ` where the other cards' pips would be ${ctrl.join('/')} px)`);
    check('the pip is painted, and only the active card\'s',
      onPip > 60 && ctrl.every((n) => n === 0),
      `${onPip} px on it, ${ctrl.join('/')} px where the others' would be`);
    // The bead's hue, as the **signed difference** the bead itself makes: on minus off, over the
    // same 15x15. The absolute mean of that rect is mostly the panel and the dark glyph
    // (#0d1018 on the element's fill), so a mean can carry the panel's ordering rather than the
    // element's; the delta is only what appeared when the wire started sending `au`.
    const lit = rectStats(hudAura, { ...pipRect, label: 'pip' });
    const unlit = rectStats(hudDry, { ...pipRect, label: 'pip-off' });
    const delta = lit.rgb.map((v, i) => v - unlit.rgb[i]);
    const el = ELEMENTS[au].color;
    const chan = [(el >> 16) & 255, (el >> 8) & 255, el & 255];
    const order = (v) => v.map((_, i) => i).sort((a, c) => v[c] - v[a]).join('');
    const shown = (v) => v.map((n) => Math.round(n)).join(',');
    check('...in the element\'s own hue',
      order(delta) === order(chan) && Math.max(...delta) > 8,
      `the bead adds ${shown(delta)} (${shown(unlit.rgb)} -> ${shown(lit.rgb)}) against`
      + ` ${ELEMENTS[au].name} 0x${el.toString(16)} (${chan.join(',')})`);
  } else {
    check('the pip is painted, and only the active card\'s', false,
      `pip box ${JSON.stringify(pipRect)}, ${ctrlRects.length} control boxes`);
  }
  await p.evaluate(() => window.__canvas(true));

  /* --------------------------------------------------- the reaction, at *me* -- */

  /**
   * The reaction the simulation computed on the player, photographed where it was drawn.
   *
   * `react-check` section 4 does this for an *enemy* payload, which carries the server's own
   * coordinates. The player's does not — `damagePlayer` sends no x,z at all — so the client draws
   * it at the player, and "at the player" is the claim. The contrast is the attacker: `src` names
   * the creature whose blow it was, and the effect has to be nearer to me than to it.
   */
  check('the reaction is one this camp\'s two elements can make',
    camp.keys.includes(hit.d.reaction),
    `${hit.d.reaction} against ${camp.keys.join('/')} from ${camp.els.join('+')}`);
  const predicted = hit.aura ? resolveReaction(hit.d.element, hit.aura)?.key : null;
  if (hit.aura) {
    check('...and the one the table predicts for the two elements the client saw',
      predicted === hit.d.reaction,
      `${ELEMENTS[hit.d.element]?.name || hit.d.element} onto ${ELEMENTS[hit.aura]?.name || hit.aura}`
      + ` → ${predicted}, the sim said ${hit.d.reaction}`);
  } else {
    skip('...and the one the table predicts for the two elements the client saw',
      'the client had no aura recorded at the moment the hit arrived (the snapshot that carried'
      + ' it had not been applied yet)');
  }
  check('the payload carries no position of its own, which is why it is drawn at me',
    hit.d.x == null && hit.d.z == null,
    `x ${JSON.stringify(hit.d.x)}, z ${JSON.stringify(hit.d.z)}, src ${JSON.stringify(hit.d.src)},`
    + ` kind ${hit.d.kind}, ${hit.d.amount} dmg`);
  check('...and the attacker it names is a creature of this camp',
    !!frozen.src && camp.enemies.includes(frozen.src.defId),
    frozen.src ? `${frozen.src.name} (${frozen.src.defId}) ${frozen.src.d} m off` : 'no src on the payload');

  // Hide the character too: the reaction's light is measured against black, and a lit body in the
  // frame is 300+ px of "something differed" that has nothing to do with the effect.
  await p.evaluate(() => window.__hideMe());
  await p.evaluate(() => window.__canon());
  // ...and the HUD hidden again. `__isolate` had put it away; the pip section above put it back to
  // photograph the bead, and nothing took it down. With it in frame the phase diffs were reading
  // the HUD's own 「感电」 banner — 2544 px in a 71x40 box above the player, still up 1.2 s later
  // because that banner's life has nothing to do with the effect's, which is `flash(…, 0.18)` and
  // four `coneSparks(…, 0.15)`.
  const hudGone = await p.evaluate(() => {
    const el = document.querySelector('[data-hud]');
    if (el) el.style.display = 'none';
    return el ? getComputedStyle(el).display : 'missing';
  });
  check('the HUD is out of frame, so the phases below measure the effect and not a banner',
    hudGone === 'none', `[data-hud] computed display is ${hudGone}`);
  // And keep the vignette pinned off across the phases. `__fire` replays the payload, which puts
  // `.hurt.on` back, and on a stopped page nothing ever takes it off again — that is why the frame
  // 1.2 s after the reaction still differed from the pre-hit plate across 451338 px, three orders
  // of magnitude over the bar, while the effect itself had long finished.
  const hurtPhase = await p.evaluate(() => window.__hurt(false));
  let before = null, plate2 = null;
  for (let i = 0; i < 6; i++) {
    await p.evaluate(() => window.__step(0));
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await sleep(400);
    before = await cap('05-before');
    plate2 = rectStats(before, { x: 0, y: 0, w: before.width, h: before.height, label: 'plate' });
    if (plate2.lum < 20) break;
  }
  check('the pre-hit frame is a black plate, not the meadow behind it', plate2.lum < 20,
    `luma ${plate2.lum}, rgb ${plate2.rgb.map((v) => Math.round(v)).join(',')}`);

  const PHASES = [0.05, 0.20, 0.45, 1.20];
  await p.evaluate(() => window.__fire(false));
  await p.evaluate(() => window.__hurt(false));
  const shots = [];
  let at = 0;
  for (const t of PHASES) {
    // Through `shoot`, so each phase is a frame that was actually painted. Stepping and
    // screenshotting back to back gave `06-0.05s.png` byte-identical to `05-before.png` — a
    // reading of exactly 0 px, which looks like "the reaction drew nothing" and is really
    // "the compositor had not caught up".
    shots.push({ t, img: await shoot(`06-${t.toFixed(2)}s`, Math.round((t - at) * 60)) });
    at = t;
  }
  const rec = await p.evaluate(() => ({ cues: window.__cues, react: window.__react }));
  const grew = shots.map((s) => diffMask(s.img, before, 8));
  console.log(`  phases: ${shots.map((s, i) => `${s.t}s ${grew[i].count}px`).join('  ')}`
    + `  (vignette opacity when the payload re-fired: ${hurtPhase})`);
  check('the reaction the server sent drew light on screen', grew[0].count > 800,
    `${grew[0].count} px at ${PHASES[0]} s`
    + `${grew[0].box ? `, box ${grew[0].box.w}x${grew[0].box.h}` : ''}`);
  check('...and it is over by the end of its own life', grew[3].count <= 200,
    `${grew[3].count} px still differ from the pre-hit frame at ${PHASES[3]} s`);

  // The reaction's own light, against **the same payload with the key stripped** — the player
  // branch also draws the hit itself (and the shield shell when one is up), so this subtraction is
  // what makes the number "the reaction's".
  await p.evaluate(() => window.__fire(true));
  await p.evaluate(() => window.__hurt(false));
  const plain = await shoot('07-plain', Math.round(PHASES[1] * 60));
  const own = diffMask(shots[1].img, plain, 8);
  check('...and it is the reaction\'s own light, not the hit\'s', own.count > 800,
    `${own.count} px over the same payload with \`reaction\` taken off`);

  // Where. In metres, through **the camera these frames were taken with** — not the one the freeze
  // measured, which was 1.52 m from the chest and has since been pushed back to frame the body.
  // A projection from before the boom moved describes a picture nobody took.
  const view = await p.evaluate(() => window.__proj());
  // ...and the subject has to still be in it. The body section left the boom 4.6 m from the chest;
  // a run whose party was downed mid-soak was later respawned at a statue, and this same reading
  // came back "camera 202.25 m, me at -1771.9,45.1" — every distance-from-the-player below then
  // describes a point that is not in the picture. Cheap to assert, and it fails on the cause rather
  // than on the symptom (that run's red was "the light was drawn 183.14 m from me").
  check('the character is still in the frame these phases are measured against',
    view.dist < 12 && view.me.x >= 0 && view.me.x <= view.w && view.me.y >= 0 && view.me.y <= view.h,
    `camera ${view.dist} m from the chest, me at ${view.me.x.toFixed(0)},${view.me.y.toFixed(0)}`
    + ` in ${view.w}x${view.h}`);

  /**
   * Where the light is, weighted by how much light it is.
   *
   * Not the diff's bounding box. A player taking a hit used to flood the **entire viewport** with a
   * flat wash — 05-before was rgb 2,4,12 and every pixel of the 0.05 s frame sat on 0,26,57, so
   * `diffMask` returned all 655 360 px and a box of 1024x640 whose centre is the centre of the
   * frame. And `__frameBody` centres the camera on the character, so "the effect's centre is
   * 0.05 m from my own projection" was arithmetic about the viewport, true no matter what the
   * reaction drew or where. (That flood was its own defect and got its own unit: the hit flash is
   * now a rim, `uFlashEdge` in `GradeShader`, and the impact quads inside it have a falloff.)
   *
   * The threshold still comes out of the frame being measured, but the corner it comes from means
   * something different now: the rim flash *peaks* at the corner, so `flash` below is the most the
   * hit cue adds anywhere in the frame rather than a level it adds everywhere — which makes the
   * bar an upper bound, and a conservative one for the middle of the picture where the cue adds
   * nothing at all. Printing it next to the mask's size is what keeps the cue visible in the
   * output instead of silently carrying the measurement.
   */
  const lumOf = (im, i) => 0.2126 * im.data[i] + 0.7152 * im.data[i + 1] + 0.0722 * im.data[i + 2];
  const litAt = (img, base) => {
    const corner = { x: 0, y: 0, w: 96, h: 96, label: 'rim' };
    const flood = rectStats(img, corner).lum - rectStats(base, corner).lum;
    const bar = Math.max(24, flood + 30);
    let sw = 0, sx = 0, sy = 0, n = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        const d = lumOf(img, i) - lumOf(base, i);
        if (d <= bar) continue;
        sx += x * d; sy += y * d; sw += d; n++;
      }
    }
    return { flood: +flood.toFixed(1), bar: +bar.toFixed(1), n,
      x: n ? sx / sw : null, y: n ? sy / sw : null };
  };
  // On the peak frame, which is the one the presence assertion above is about.
  const lit = litAt(shots[0].img, before);
  console.log(`  (measured through the camera at ${view.dist} m: ${view.perM} px/m,`
    + ` me at ${view.me.x},${view.me.y}; the ${PHASES[0]} s frame's hit cue peaks at`
    + ` ${lit.flood} luma in the corner, so the light is the ${lit.n} px above ${lit.bar})`);
  if (!check('the reaction\'s light is a shape in the frame, not the whole frame',
    lit.n > 200 && lit.n < shots[0].img.width * shots[0].img.height * 0.5,
    `${lit.n} px are more than ${lit.bar} luma brighter than the pre-hit frame`)) {
    throw new Error('nothing to locate');
  }
  const cx = lit.x, cy = lit.y;
  const dMe = Math.hypot(cx - view.me.x, cy - view.me.y) / view.perM;
  check('the light was drawn at the player', dMe < 2.5,
    `the effect's centre is ${dMe.toFixed(2)} m from my own projection`
    + ` (${cx.toFixed(0)},${cy.toFixed(0)} against ${view.me.x},${view.me.y})`);
  const srcPt = view.srcAt;
  const apart = srcPt ? Math.hypot(srcPt.x - view.me.x, srcPt.y - view.me.y) : null;
  if (!srcPt || Math.abs(srcPt.z) > 1) {
    skip('...rather than at the creature that hit me', 'the attacker has no screen position');
  } else if (apart < 80) {
    skip('...rather than at the creature that hit me',
      `it was ${apart.toFixed(0)} px away on screen — a melee attacker standing on top of me`
      + ' cannot tell the two apart');
  } else {
    const dSrc = Math.hypot(cx - srcPt.x, cy - srcPt.y) / view.perM;
    check('...rather than at the creature that hit me', dMe < dSrc,
      `${dMe.toFixed(2)} m from me, ${dSrc.toFixed(2)} m from ${frozen.src.name}`
      + ` (${apart.toFixed(0)} px apart on screen)`);
  }

  check('...and asks for its own sound', rec.cues.includes(REACTION_SFX[hit.d.reaction]),
    `wanted ${REACTION_SFX[hit.d.reaction]}, got ${rec.cues.join(',') || 'silence'}`);
  const named = rec.react.find((r) => r.kind === hit.d.reaction);
  check('...and says its name to the HUD', !!named && named.name === REACTIONS[hit.d.reaction].name,
    named ? `「${named.name}」` : `no reaction event (${rec.react.length} events)`);

  check('no page errors while being soaked', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  fails++;
  console.log(`  FAIL harness: ${e.message}`);
} finally {
  await b.close();
}

console.log(`\n${passes} passed, ${fails} failed, ${skips} skipped`);
process.exit(fails);
