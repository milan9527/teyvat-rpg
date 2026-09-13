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

    window.__freeze = () => {
      window.__frozen = true;
      g.stop();
      const you = (g.socket.latest()?.players || [])
        .find((r) => Number(r.id) === Number(g.playerId)) || null;
      window.__you = you;
      const el = g.r.renderer.domElement;
      // `Vector3` out of the scene (`scene.position.constructor`) — the page has no THREE global.
      const V = (x, y, z) => {
        const v = new g.scene.position.constructor(x, y, z);
        v.project(g.overlay.camera);
        return { x: +((v.x * 0.5 + 0.5) * el.clientWidth).toFixed(1),
          y: +((-v.y * 0.5 + 0.5) * el.clientHeight).toFixed(1), z: +v.z.toFixed(3) };
      };
      const me = V(g.me.x, g.me.y + 0.9, g.me.z);
      // Pixels per metre at the player's own distance from the camera, so every "near enough"
      // below is a distance in **metres** instead of a pixel count that means nothing at another
      // viewport size or camera pitch.
      const up = V(g.me.x, g.me.y + 1.9, g.me.z);
      const perM = Math.abs(up.y - me.y);
      const src = window.__hit?.d?.src ? g.actors.enemies.get(window.__hit.d.src) : null;
      return {
        you, aura: g.me.aura || null, actorAura: g.me.actor?.aura || null,
        hud: g.hudState().me.aura || null,
        char: g.party[g.activeSlot], slot: g.activeSlot, element: g.me.def?.element || null,
        me, up, perM: +perM.toFixed(1), w: el.clientWidth, h: el.clientHeight,
        hp: Math.round(g.me.hp), maxHp: Math.round(g.me.maxHp),
        src: src ? { id: window.__hit.d.src, defId: src.defId, name: src.actor.def.name,
          d: +Math.hypot(src.x - g.me.x, src.z - g.me.z).toFixed(1),
          at: V(src.x, src.y + (src.actor.height || 1) * 0.5, src.z) } : null,
      };
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
          out.push({ glow: +u.uElementGlow.value.toFixed(3), col: u.uElementColor.value.getHex() });
        }
      });
      return { n: out.length, glows: [...new Set(out.map((o) => o.glow))],
        cols: [...new Set(out.map((o) => o.col))] };
    };
    window.__pips = () => [...document.querySelectorAll('.pcard')].map((n) => {
      const a = n.querySelector('.av .aura');
      const cs = a ? getComputedStyle(a) : null;
      const r = a ? a.getBoundingClientRect() : null;
      return { slot: +n.dataset.slot, active: n.classList.contains('active'),
        display: cs?.display ?? 'missing', bg: cs?.backgroundColor ?? '',
        shadow: (cs?.boxShadow ?? '').slice(0, 40), text: a?.textContent ?? '', title: a?.title ?? '',
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null };
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

  // Close in on one of the camp's *own* creatures, by name: after a 200 m walk the census also
  // contains whatever streamed in on the way, and a 丘丘人 attaches nothing.
  const inCamp = (e) => camp.enemies.includes(e.defId);
  const nearest = async () => (await census()).filter(inCamp).sort((a, c) => a.d - c.d)[0] || null;
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
      alive: !!g.me.alive };
  });
  const deadline = Date.now() + 300000;
  let frozen = null, last = 0;
  for (;;) {
    const st = await state();
    if (st.hit && st.au && st.me) { frozen = await p.evaluate(() => window.__freeze()); break; }
    if (Date.now() > deadline) break;
    if (!st.alive) { console.log('  (the party was downed while standing in the camp)'); break; }
    if (Date.now() - last > 12000) {
      last = Date.now();
      console.log(`  (waiting: ${st.wire} payload(s), aura ${JSON.stringify(st.au)}, reaction`
        + ` ${JSON.stringify(st.hit)}, hp ${st.hp}, ${st.log} aura transition(s))`);
      // The creatures hop about and a 水史莱姆 that wandered 12 m off attaches nothing. Re-close
      // the gap on the nearest one that can, without ever attacking it.
      const now = await nearest();
      if (now && now.d > 5) await approach(now.id, 2.4, 20000, 0.9);
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
  check('...and stripping `au` from the same snapshot row puts the innate one back',
    dry.aura === null && dry.actor === null && uDry.cols.length === 1
    && uDry.cols[0] === (ELEMENTS[onField.element]?.color ?? 0xffffff)
    && uDry.glows.length === 1 && uDry.glows[0] < uAura.glows[0],
    `glow ${uDry.glows.join('/')} colour ${uDry.cols.map((c) => `0x${c.toString(16)}`).join('/')},`
    + ` ${CHARACTERS[onField.char]?.name} is ${onField.element}`
    + ` (0x${(ELEMENTS[onField.element]?.color ?? 0xffffff).toString(16)})`);

  const cap = async (tag) => {
    const file = `${outDir}/${tag}.png`;
    await p.screenshot({ path: file });
    return decodePng(fs.readFileSync(file));
  };

  // The body against black, with the world hidden and the player's own group kept — `photograph
  // the model alone`, so the difference between the two frames can only be the body.
  const iso = await p.evaluate(() => window.__isolate([window.game.me.actor.group]));
  check('the world was hidden and the character was not', iso.hidden > 0 && iso.pools > 50,
    `${iso.hidden} scene children hidden, ${iso.pools} kept`);
  await p.evaluate(() => window.__step(0));
  await sleep(400);
  const bodyDry = await cap('01-body-dry');
  await p.evaluate((el) => window.__setAu(el), au);
  await p.evaluate(() => window.__step(0));
  await sleep(400);
  const bodyAura = await cap('02-body-aura');

  // Where the body is, through the same camera the freeze projected it with: a box 1.1 m either
  // side of the player and from its feet to a little over its head.
  const bodyBox = {
    x: Math.round(frozen.me.x - frozen.perM * 1.1), y: Math.round(frozen.me.y - frozen.perM * 1.6),
    w: Math.round(frozen.perM * 2.2), h: Math.round(frozen.perM * 2.6),
  };
  // ...and the same box moved three metres to the side, which is empty black in both frames. A
  // one-sided "it differed" is equally true of a frame that changed everywhere.
  const offBox = { ...bodyBox, x: Math.max(0, Math.min(frozen.w - bodyBox.w,
    bodyBox.x + Math.round(frozen.perM * 3.4))) };
  const onBody = diffRect(bodyAura, bodyDry, bodyBox);
  const offBody = diffRect(bodyAura, bodyDry, offBox);
  const whole = diffMask(bodyAura, bodyDry, 8);
  const plate = rectStats(bodyDry, { x: 0, y: 0, w: bodyDry.width, h: bodyDry.height, label: 'plate' });
  console.log(`  (body box ${bodyBox.x},${bodyBox.y} ${bodyBox.w}x${bodyBox.h}: ${onBody} px differ,`
    + ` beside it ${offBody}, whole frame ${whole.count} px`
    + `${whole.box ? ` in ${whole.box.w}x${whole.box.h} at ${whole.box.x},${whole.box.y}` : ''};`
    + ` isolated plate luma ${plate.lum})`);
  check('the attachment changed the character on screen, on the body and nowhere else',
    onBody > 300 && offBody <= 20 && whole.count > 300,
    `${onBody} px on the body, ${offBody} px in the same box 3.4 m to the side`);
  // ...and the difference is *where the character is*, not somewhere else in the frame.
  if (whole.box) {
    const cx = whole.box.x + whole.box.w / 2, cy = whole.box.y + whole.box.h / 2;
    const off = Math.hypot(cx - frozen.me.x, cy - frozen.me.y) / frozen.perM;
    check('...centred on the character rather than anywhere in the frame', off < 1.6,
      `the changed pixels' centre is ${off.toFixed(2)} m from the character's own projection`);
  } else {
    check('...centred on the character rather than anywhere in the frame', false, 'nothing differed');
  }

  /* ------------------------------------------------------------ the HUD pip -- */

  /**
   * The party card's pip, in computed style and in pixels.
   *
   * A `classList` check would pass on a build where the CSS rule was deleted, so the style
   * reading is the *computed* one — and the pixels are read with the canvas hidden, because a
   * 15 px bead over a moving world cannot be told from the world (that is what
   * `hide the canvas to read the HUD` is about). The control is the same bead with `au` stripped
   * from the same row, and the *other* cards' beads, which must not move either way.
   */
  await p.evaluate(() => {
    // The isolate hid the HUD to photograph the body; the pip lives there.
    const el = document.querySelector('[data-hud]');
    if (el) el.style.display = '';
    return true;
  });
  await p.evaluate(() => window.__canvas(false));
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

  const pad = (r, n = 6) => ({ x: r.x - n, y: r.y - n, w: r.w + n * 2, h: r.h + n * 2 });
  const pipRect = active?.rect ? pad(active.rect) : null;
  if (pipRect) {
    const onPip = diffRect(hudAura, hudDry, pipRect);
    const ctrl = others.filter((c) => c.rect).map((c) => diffRect(hudAura, hudDry, pad(c.rect)));
    console.log(`  (pip rect ${pipRect.x},${pipRect.y} ${pipRect.w}x${pipRect.h}: ${onPip} px differ;`
      + ` the other cards' pips ${ctrl.join('/')} px)`);
    check('the pip is painted, and only the active card\'s',
      onPip > 60 && ctrl.every((n) => n === 0),
      `${onPip} px on it, ${ctrl.join('/')} px on the others`);
    const lit = rectStats(hudAura, { ...pipRect, label: 'pip' });
    const el = ELEMENTS[au].color;
    // The bead's own colour, in the frame. Its glyph is dark (#0d1018) on the element's fill, so
    // the mean of the padded rect is the fill pulled toward the HUD's dark panel — which is why
    // this asks about the *ordering* of the channels rather than for the hex back.
    const chan = [(el >> 16) & 255, (el >> 8) & 255, el & 255];
    const order = (v) => v.map((_, i) => i).sort((a, c) => v[c] - v[a]).join('');
    check('...in the element\'s own hue', order(lit.rgb) === order(chan),
      `pip mean rgb ${lit.rgb.map((v) => Math.round(v)).join(',')} against`
      + ` ${ELEMENTS[au].name} 0x${el.toString(16)} (${chan.join(',')})`);
  } else {
    check('the pip is painted, and only the active card\'s', false, 'the pip has no rect');
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
  const shots = [];
  let at = 0;
  for (const t of PHASES) {
    await p.evaluate((n) => window.__step(n), Math.round((t - at) * 60));
    at = t;
    shots.push({ t, img: await cap(`06-${t.toFixed(2)}s`) });
  }
  const rec = await p.evaluate(() => ({ cues: window.__cues, react: window.__react }));
  const grew = shots.map((s) => diffMask(s.img, before, 8));
  console.log(`  phases: ${shots.map((s, i) => `${s.t}s ${grew[i].count}px`).join('  ')}`);
  check('the reaction the server sent drew light on screen', grew[0].count > 800,
    `${grew[0].count} px at ${PHASES[0]} s`
    + `${grew[0].box ? `, box ${grew[0].box.w}x${grew[0].box.h}` : ''}`);
  check('...and it is over by the end of its own life', grew[3].count <= 200,
    `${grew[3].count} px still differ from the pre-hit frame at ${PHASES[3]} s`);

  // The reaction's own light, against **the same payload with the key stripped** — the player
  // branch also draws the hit itself (and the shield shell when one is up), so this subtraction is
  // what makes the number "the reaction's".
  await p.evaluate(() => window.__fire(true));
  await p.evaluate((n) => window.__step(n), Math.round(PHASES[1] * 60));
  const plain = await cap('07-plain');
  const own = diffMask(shots[1].img, plain, 8);
  check('...and it is the reaction\'s own light, not the hit\'s', own.count > 800,
    `${own.count} px over the same payload with \`reaction\` taken off`);

  // Where. In metres, through the camera the freeze measured.
  const box = own.box || grew[1].box;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const dMe = Math.hypot(cx - frozen.me.x, cy - frozen.me.y) / frozen.perM;
  check('the light was drawn at the player', dMe < 2.5,
    `the effect's centre is ${dMe.toFixed(2)} m from my own projection`
    + ` (${cx.toFixed(0)},${cy.toFixed(0)} against ${frozen.me.x},${frozen.me.y})`);
  const srcPt = frozen.src?.at;
  const apart = srcPt ? Math.hypot(srcPt.x - frozen.me.x, srcPt.y - frozen.me.y) : null;
  if (!srcPt || Math.abs(srcPt.z) > 1) {
    skip('...rather than at the creature that hit me', 'the attacker has no screen position');
  } else if (apart < 80) {
    skip('...rather than at the creature that hit me',
      `it was ${apart.toFixed(0)} px away on screen — a melee attacker standing on top of me`
      + ' cannot tell the two apart');
  } else {
    const dSrc = Math.hypot(cx - srcPt.x, cy - srcPt.y) / frozen.perM;
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
