// Does the game make the sounds it knows how to make?
//
//   node tools/audio-check.mjs --no-browser      # vocabulary + synthesis only
//   DISPLAY=:99 node tools/audio-check.mjs       # ...plus the real page, driven by keys
//
// `client/src/audio/audio.js` synthesises 34 effects and ends its switch in
// `default: break`, so an unimplemented name and an uncalled recipe are both perfectly
// silent — and no gate in this repo could ever have gone red for either. When this
// file was written, **nine of the recipes had no caller at all**: the sword swing, the
// jump, the landing, the elemental skill, the elemental burst, loot, panel-open,
// refusals and fast travel. The five most frequent actions in the game were mute, and
// every check in the repo was green.
//
// Three sections, because there are three separate ways this can be broken and no one
// of them implies the others:
//
//   1. Vocabulary. `SFX_CUES` declares every effect and *which file asks for it*, and
//      this is checked both ways: case without cue, cue without case, cue whose file
//      does not contain the call, call site whose file no cue claims, and any name
//      passed to `sfx()` that no case implements (a typo is silent by design).
//   2. Synthesis. The Audio class is pure Web Audio and never touches the DOM outside
//      `unlock()`, so it runs here under a recording mock context: every recipe must
//      start at least one source, every source must reach the **sfx** bus (not the
//      music bus), and the scheduled envelope must peak above zero. A `case` that
//      calls nothing, or whose helper was pointed at the wrong bus, is a real bug that
//      reads as "the sound is too quiet" forever.
//   3. Delivery. Grep proves a call site exists; it cannot prove the call *runs*. So
//      the last section boots the real page, replaces `game.audio.sfx` with a recorder,
//      and drives the game with the actual keys (Space, C, E, Q, K, Esc) — the cue has
//      to arrive, and its name has to be one the synth implements.
//
// Exit code is the number of failed assertions.
import fs from 'node:fs';
import path from 'node:path';
import { SFX_CUES, REACTION_SFX } from '../client/src/audio/audio.js';
import { REACTIONS } from '../shared/src/data/elements.js';

const root = path.resolve(import.meta.dirname, '..');
const noBrowser = process.argv.includes('--no-browser');
const base = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5173';

let passes = 0, fails = 0, skips = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passes++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); } else {
    fails++; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`);
  }
  return !!ok;
};
const skip = (name, why) => { skips++; console.log(`  SKIP ${name}  ${why}`); };

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/* ------------------------------------------------------------------------------ */
/* 1. Vocabulary: the cue table against the switch, and both against the call sites */
/* ------------------------------------------------------------------------------ */

console.log('--- 1. vocabulary');

const audioSrc = read('client/src/audio/audio.js');

// The `_sfx` switch only: `SFX_CUES` is above it and the music scheduler below, and
// neither contains `case '...':` lines, but slicing keeps this honest if that changes.
//
// Match the signature loosely and assert the slice found something: this was written as
// `indexOf('_sfx(name) {')`, and the day the method grew an options argument the index went
// to -1, `sfxBody` became the file's last character, and `cases` became empty — which made
// "every recipe in the switch has a cue" pass over zero recipes.
const sfxAt = audioSrc.search(/_sfx\(name\b[^)]*\)\s*\{/);
const sfxBody = sfxAt < 0 ? '' : audioSrc.slice(sfxAt);
const cases = [...sfxBody.matchAll(/case '([a-zA-Z0-9]+)':/g)].map((m) => m[1]);
const cueKeys = Object.keys(SFX_CUES);

check('the scan found the recipe switch', sfxAt > 0 && cases.length > 20,
  `${cases.length} cases at index ${sfxAt}`);

check('every recipe in the switch has a cue', cases.every((c) => SFX_CUES[c]),
  cases.filter((c) => !SFX_CUES[c]).join(', ') || `${cases.length} cases`);
check('every cue has a recipe in the switch', cueKeys.every((k) => cases.includes(k)),
  cueKeys.filter((k) => !cases.includes(k)).join(', ') || `${cueKeys.length} cues`);
check('no recipe is written twice', new Set(cases).size === cases.length,
  `${cases.length} cases`);

/**
 * Every `sfx(...)` call in a client file, with the names it can pass.
 *
 * A ternary counts as two cues (`sfx(d.crit ? 'crit' : 'hit')`), so this scans the
 * whole balanced argument list rather than matching a single quoted string — and an
 * argument list can contain nested calls (`{ gain: Math.min(1.6, speed / 9) }`), which
 * is exactly where a lazier `[^)]*` regex stops early and loses the name.
 */
function callSites(src) {
  const out = [];
  // `.sfx(` — every caller goes through a property access (`this.audio.sfx`,
  // `g.audio.sfx`), which is also what keeps the definition and the internal `_sfx`
  // out of the results. Matching a bare `sfx(` instead finds the declaration and, as
  // it turned out on the first run, *nothing else*: the scan came back empty and the
  // "every name is a recipe" check passed for free on a set of size zero.
  const re = /\.sfx\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === "'" || c === '"' || c === '`') { const q = c; while (++i < src.length && src[i] !== q); }
      i++;
    }
    const args = src.slice(m.index + m[0].length, i - 1);
    out.push({ args, names: [...args.matchAll(/'([a-zA-Z0-9]+)'/g)].map((x) => x[1]) });
  }
  return out;
}

const clientFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (e.isDirectory()) walk(`${dir}/${e.name}`);
    else if (e.name.endsWith('.js')) clientFiles.push(`${dir}/${e.name}`);
  }
}('client/src'));

/**
 * Cues a call site asks for *through a table* rather than as a literal.
 *
 * `sfx(REACTION_SFX[d.reaction], …)` passes no quoted string, so the literal scan above sees
 * nothing and all six reaction cues read as "asked for by nobody". Crediting the whole table
 * to any file that dispatches through it keeps the two-way vocabulary check honest without
 * pretending the names are written out — and the credit is *earned*: it only applies where the
 * expression really appears, so deleting the dispatch un-credits every value at once.
 */
const TABLES = [{ re: /REACTION_SFX\s*\[/, values: Object.values(REACTION_SFX) }];
const viaTable = (args) => TABLES.flatMap((t) => (t.re.test(args) ? t.values : []));

const calls = new Map();          // file (relative to client/src) → names
for (const f of clientFiles) {
  if (f === 'client/src/audio/audio.js') continue;    // the definition, not a call site
  const names = callSites(read(f)).flatMap((c) => [...c.names, ...viaTable(c.args)]);
  if (names.length) calls.set(f.replace('client/src/', ''), names);
}
const calledNames = new Set([...calls.values()].flat());

check('every name passed to sfx() is a recipe',
  calledNames.size >= cueKeys.length && [...calledNames].every((n) => SFX_CUES[n]),
  [...calledNames].filter((n) => !SFX_CUES[n]).join(', ') || `${calledNames.size} distinct names`);

check('every recipe is asked for by somebody', cueKeys.every((k) => calledNames.has(k)),
  cueKeys.filter((k) => !calledNames.has(k)).join(', ') || `all ${cueKeys.length}`);

// The `from` half: a cue that names the wrong file is a stale map, which is worse than
// no map — the next person greps the named file, finds nothing, and rewrites the cue.
const wrongFrom = [];
for (const [k, cue] of Object.entries(SFX_CUES)) {
  for (const f of cue.from) {
    if (!(calls.get(f) || []).includes(k)) wrongFrom.push(`${k}←${f}`);
  }
}
check('every cue is asked for by the file it names', wrongFrom.length === 0, wrongFrom.join(', '));

const declaredFiles = new Set(Object.values(SFX_CUES).flatMap((c) => c.from));
const undeclared = [...calls.keys()].filter((f) => !declaredFiles.has(f));
check('no file plays sound without being named by a cue', undeclared.length === 0,
  undeclared.join(', ') || `${declaredFiles.size} file(s)`);

/* ------------------------------------------------------------------------------ */
/* 1b. REACTION_SFX: the reaction table, both ways, plus the dispatch that uses it  */
/* ------------------------------------------------------------------------------ */

// Reactions are the one cue family that is looked up rather than written out, and the
// bug this section was written for is exactly what a lookup table invites: the client
// spelled 冻结 `frozen` while the wire says `freeze`, so the most common reaction in the
// game had no picture of its own and (once these cues existed) would have dispatched
// `sfx(undefined)` — silently, because the switch's `default` returns false.
console.log('\n--- 1b. reaction cue table');

const reactKeys = Object.keys(REACTIONS);
const reactVals = [...new Set(Object.values(REACTION_SFX))];
check('there are reactions to make a sound for', reactKeys.length >= 10, `${reactKeys.length} reactions`);
check('every reaction has a sound', reactKeys.every((k) => REACTION_SFX[k]),
  reactKeys.filter((k) => !REACTION_SFX[k]).join(', ') || `all ${reactKeys.length}`);
check('...and the table invents none', Object.keys(REACTION_SFX).every((k) => REACTIONS[k]),
  Object.keys(REACTION_SFX).filter((k) => !REACTIONS[k]).join(', ') || `${reactVals.length} distinct cues`);
check('every reaction sound is a declared cue', reactVals.every((v) => SFX_CUES[v]),
  reactVals.filter((v) => !SFX_CUES[v]).join(', ') || reactVals.join(','));
check('...and an implemented recipe', reactVals.every((v) => cases.includes(v)),
  reactVals.filter((v) => !cases.includes(v)).join(', ') || `${reactVals.length} recipes`);

// The other direction on the *cue* side: a `react*` recipe nobody maps to is a recipe
// that can never play, which is the nine-silent-recipes bug this whole file exists for.
const reactCues = cueKeys.filter((k) => k.startsWith('react'));
check('every react* cue is mapped by some reaction', reactCues.every((k) => reactVals.includes(k)),
  reactCues.filter((k) => !reactVals.includes(k)).join(', ') || `${reactCues.length} cues`);

// And the dispatch itself. Without this, the table could be perfect and unused: both
// `_onDamage` branches have to hand a mapped name to `sfx`, because the player-target
// branch used to drop `d.reaction` on the floor entirely.
const gameSrc = read('client/src/game/game.js');
const dispatches = [...gameSrc.matchAll(/\.sfx\(REACTION_SFX\[/g)].length;
check('game.js dispatches reaction sounds through the table, in both branches',
  dispatches >= 2, `${dispatches} call site(s)`);
check('...and imports it', /import\s*\{[^}]*\bREACTION_SFX\b[^}]*\}\s*from\s*'\.\.\/audio\/audio\.js'/.test(gameSrc));

/* ------------------------------------------------------------------------------ */
/* 2. Synthesis: run the real class against a recording Web Audio mock            */
/* ------------------------------------------------------------------------------ */

console.log('\n--- 2. synthesis');

class Param {
  constructor(v) { this.value = v; this.events = []; }
  setValueAtTime(v, t) { this.events.push([v, t]); return this; }
  linearRampToValueAtTime(v, t) { this.events.push([v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.events.push([v, t]); return this; }
  setTargetAtTime(v, t) { this.events.push([v, t]); return this; }
  cancelScheduledValues() { return this; }
  /** The loudest value the envelope was ever told to reach. */
  get peak() { return this.events.length ? Math.max(...this.events.map((e) => e[0])) : this.value; }
}

class MockNode {
  constructor(type, ctx) { this.type = type; this.ctx = ctx; this.outs = []; }
  connect(dest) { this.outs.push(dest); return dest; }
  disconnect() { this.outs.length = 0; }
  start(when = 0) { this.startedAt = when; this.ctx.started.push(this); }
  stop() { }
}

class MockCtx {
  constructor() {
    this.currentTime = 4;      // not 0: a recipe that scheduled at 0 would look fine
    this.sampleRate = 48000;
    this.state = 'running';
    this.started = [];
    this.destination = new MockNode('destination', this);
  }
  _n(type, params = {}) {
    const n = new MockNode(type, this);
    for (const [k, v] of Object.entries(params)) n[k] = new Param(v);
    return n;
  }
  createGain() { return this._n('gain', { gain: 1 }); }
  createOscillator() { return this._n('osc', { frequency: 440, detune: 0 }); }
  createBufferSource() { const n = this._n('source', { playbackRate: 1 }); n.buffer = null; return n; }
  createBiquadFilter() { const n = this._n('biquad', { frequency: 350, Q: 1, gain: 0 }); n.type = 'lowpass'; return n; }
  createConvolver() { const n = this._n('convolver'); n.buffer = null; return n; }
  createDynamicsCompressor() {
    return this._n('comp', { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 });
  }
  createBuffer(channels, length) {
    const data = new Float32Array(length);
    return { numberOfChannels: channels, length, sampleRate: this.sampleRate, getChannelData: () => data };
  }
  resume() { this.state = 'running'; }
  close() { this.state = 'closed'; }
}

globalThis.window = { AudioContext: MockCtx };
const { Audio } = await import('../client/src/audio/audio.js');
const a = new Audio();
a.unlock();

check('the context came up', a.ready === true && a.ctx instanceof MockCtx, `state=${a.ctx?.state}`);

/** Follow the signal from a source to the buses, multiplying gain nodes on the way. */
function busPaths(node, gain = 1, depth = 0, out = []) {
  if (depth > 16) return out;
  for (const d of node.outs) {
    if (d instanceof Param) continue;                 // modulation, not signal
    const g = d.type === 'gain' ? gain * d.gain.peak : gain;
    if (d === a.sfxBus) out.push({ bus: 'sfx', gain: g });
    else if (d === a.musicBus) out.push({ bus: 'music', gain: g });
    else if (d === a.ambBus) out.push({ bus: 'amb', gain: g });
    else busPaths(d, g, depth + 1, out);
  }
  return out;
}

/** Play one effect on a clean slate and report what it scheduled. */
function play(name, opts) {
  a.ctx.started.length = 0;
  const played = a.sfx(name, opts);
  const paths = a.ctx.started.flatMap((s) => busPaths(s));
  return {
    played,
    sources: a.ctx.started.length,
    buses: [...new Set(paths.map((p) => p.bus))],
    gain: paths.reduce((s, p) => s + p.gain, 0),
    orphans: a.ctx.started.filter((s) => busPaths(s).length === 0).length,
  };
}

for (const name of cueKeys) {
  const r = play(name);
  check(`${name} is audible on the sfx bus`,
    r.played === true && r.sources > 0 && r.orphans === 0
      && r.buses.length === 1 && r.buses[0] === 'sfx' && r.gain > 0.01,
    `${r.sources} source(s) → ${r.buses.join('+') || 'nothing'}, Σgain ${r.gain.toFixed(2)}`);
}

// A name nobody implements has to be distinguishable from one that played, or the
// runtime section below cannot catch a typo.
check('an unknown name reports that it played nothing', a.sfx('nosuchsound') === false);
check('...and schedules nothing', play('nosuchsound').sources === 0);

console.log('\n--- 2b. gain and distance');

const loud = play('hit');
const half = play('hit', { gain: 0.5 });
check('opts.gain scales the whole recipe',
  Math.abs(half.gain - loud.gain * 0.5) < loud.gain * 0.02,
  `${loud.gain.toFixed(3)} → ${half.gain.toFixed(3)}`);
check('...and does not change what got scheduled', half.sources === loud.sources,
  `${loud.sources} sources`);

// `opts.at` needs a listener, which `update()` caches from the local player. Before any
// frame has run there is nothing to measure a distance against, and silence would be
// the wrong default: the sound is happening, we just do not know where the ear is.
check('with no listener, position is ignored', a._atten([500, 0, 500]) === 1);
a.update(0.016, { me: { x: 0, y: 0, z: 0 } });
check('the listener came from the local player', JSON.stringify(a._listener) === '[0,1.2,0]');

const at = (d) => a._atten([d, 1.2, 0]);
check('flat inside 2 m', at(0) === 1 && at(2) === 1);
const curve = [4, 8, 20, 40, 60].map((d) => `${d}m ${at(d).toFixed(2)}`);
check('rolls off with distance', at(4) < 1 && at(20) < at(8) && at(40) < at(20), curve.join('  '));
let monotone = true;
for (let d = 2; d < 80; d += 0.5) if (at(d + 0.5) > at(d) + 1e-9) monotone = false;
check('...monotonically, with no bump to argue about', monotone);
check('and goes silent before the streaming radius', at(75) === 0 && at(45) > 0,
  `45m ${at(45).toFixed(3)}  75m ${at(75)}`);

const near = play('enemyAttack', { at: [1, 1.2, 0] });
const far = play('enemyAttack', { at: [30, 1.2, 0] });
const gone = play('enemyAttack', { at: [300, 1.2, 0] });
check('a distant effect is quieter', far.gain > 0 && far.gain * 2 < near.gain,
  `${near.gain.toFixed(3)} at 1 m vs ${far.gain.toFixed(3)} at 30 m`);
check('...and one far outside earshot is not scheduled at all',
  gone.played === false && gone.sources === 0);
// The scale is scratch state on the instance; a cheap way to leave every later sound
// quiet forever is to forget to put it back.
check('the gain scale is reset afterwards', a._vol === 1);

/* ------------------------------------------------------------------------------ */
/* 3. Delivery: the real page, driven by the real keys                            */
/* ------------------------------------------------------------------------------ */

if (noBrowser) {
  skip('the cues arrive in the running game', '--no-browser');
} else {
  console.log('\n--- 3. delivery');
  const puppeteer = (await import('puppeteer')).default;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const b = await puppeteer.launch({
    browser: 'firefox', headless: false,
    env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
    extraPrefsFirefox: {
      'webgl.force-enabled': true,
      'webgl.disable-fail-if-major-performance-caveat': true,
      'media.autoplay.default': 0,
    },
    defaultViewport: { width: 1280, height: 720 },
  });
  const p = await b.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });

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

    // Record instead of hear. A headless container may have no audio device at all, so
    // the assertion is about the cue reaching the mixer, not about a waveform.
    const hooked = await p.evaluate(() => {
      const g = window.game;
      window.__cues = [];
      const real = g.audio.sfx.bind(g.audio);
      g.audio.sfx = (name, opts) => { window.__cues.push({ name, opts: opts || null }); return real(name, opts); };
      return { ready: !!g.audio.ready, enabled: !!g.audio.enabled };
    });
    console.log(`  (audio ready=${hooked.ready} enabled=${hooked.enabled})`);

    const seen = [];
    const drain = async () => {
      const c = await p.evaluate(() => { const q = window.__cues; window.__cues = []; return q; });
      seen.push(...c.map((x) => x.name));
      return c;
    };
    const names = async () => (await drain()).map((c) => c.name);
    /**
     * Collect cues until `want` has all shown up, or the timeout runs out.
     *
     * A fixed sleep is the wrong instrument here: llvmpipe runs this page at 3-4 fps,
     * so a cue that depends on a few frames of simulation (the landing after a jump is
     * four frames of gravity) arrives whenever it arrives, and a sleep that is a frame
     * too short reads exactly like a missing sound.
     */
    const waitFor = async (want, ms = 4000) => {
      const got = [];
      for (let waited = 0; waited < ms; waited += 300) {
        got.push(...(await names()));
        if (want.every((w) => got.includes(w))) break;
        await sleep(300);
      }
      return got;
    };
    await drain();

    // Walk: click the ground below centre and let a few strides go by. The distance
    // walked is the control — "no footstep cue" and "the click never moved anybody"
    // are the same silence, and only one of them is about audio.
    // Where to click for a walk of known length. Guessing a fraction of the viewport
    // does not work: the character stands near the middle of the frame and the ground
    // *below* it is the ground nearest the camera, so the obvious click at 72 % height
    // lands 70 cm from your own feet and the walk is over before one stride. Even 52 %
    // measured 4.1 m on one boot and 1.4 m on the next, because what that pixel means
    // depends on the slope in front of the spawn.
    //
    // So aim in the world and project back: a point 14 m along the camera's own
    // heading, dropped onto the terrain. That is a click on a real pixel going through
    // the real raycast, but with a distance the probe chose rather than inherited.
    const pos = () => p.evaluate(() => [window.game.me.x, window.game.me.z]);
    const from = await pos();
    const aim = await p.evaluate(() => {
      const g = window.game;
      const fwd = g.me.actor.group.position.clone();   // any Vector3 will do; no THREE global
      g.camera.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) return null;
      fwd.normalize();
      const t = g.me.actor.group.position.clone();
      t.x = g.me.x + fwd.x * 14;
      t.z = g.me.z + fwd.z * 14;
      t.y = g.world.heightAt(t.x, t.z);
      t.project(g.camera);
      if (Math.abs(t.x) > 0.95 || Math.abs(t.y) > 0.95 || t.z > 1) return null;
      return [Math.round((t.x * 0.5 + 0.5) * window.innerWidth),
        Math.round((-t.y * 0.5 + 0.5) * window.innerHeight)];
    });
    if (!check('a walkable point 14 m ahead is on screen', !!aim, aim ? `(${aim})` : 'off screen')) {
      throw new Error('cannot aim a click');
    }
    await p.mouse.click(aim[0], aim[1]);
    await sleep(400);
    const goal = await p.evaluate(() => {
      const m = window.game.me;
      return m.goal ? Math.hypot(m.goal.x - m.x, m.goal.z - m.z) : null;
    });
    check('the click reached the ground, some way off', goal !== null && goal > 2,
      goal === null ? 'no goal was set' : `${goal.toFixed(1)} m away`);
    const strides = await waitFor(['step'], 4000);
    const to = await pos();
    const walked = Math.hypot(to[0] - from[0], to[1] - from[1]);
    check('the character actually walked', walked > 1.5, `${walked.toFixed(1)} m`);
    check('walking makes footsteps', strides.includes('step'), strides.join(',') || 'nothing');

    // Space is a jump and, ~0.7 s later, a landing. Both are on the local player's
    // own events, which is why one keypress can prove two cues. (The key is ' ', not
    // 'Space': puppeteer's BiDi backend passes single code points straight through
    // and has no name for the space bar.)
    await p.keyboard.press(' ');
    const air = [];
    for (let waited = 0; waited < 5000; waited += 300) {
      air.push(...(await drain()));
      if (air.some((c) => c.name === 'land')) break;
      await sleep(300);
    }
    check('jumping is audible', air.some((c) => c.name === 'jump'));
    const land = air.find((c) => c.name === 'land');
    /**
     * The floor here is *derived*, not chosen. `localPlayer` emits `land` above 3.5 m/s and
     * `game.js` asks for `gain = min(1.6, speed / 9)`, so the quietest landing the product can
     * ever play is 3.5/9 = 0.389 — and a bar of 0.5 (this probe's first version) fails a
     * perfectly working cue whenever the jump lands on rising ground and touches down at 4.2 m/s
     * instead of 5.6. It did: `gain 0.47`, one red on an untouched build.
     *
     * "Louder the harder it was" also cannot be read off one landing at all — a single number is
     * above any floor for two reasons, the cue being loud and the floor being low. It needs a
     * second, taller drop, below.
     */
    const LAND_MIN = 3.5 / 9;
    check('...and so is landing, at the quietest gain the product can emit', !!land
      && land.opts?.gain > LAND_MIN - 0.005 && land.opts.gain <= 1.6,
      land ? `gain ${land.opts.gain.toFixed(2)} (floor ${LAND_MIN.toFixed(2)}, ceiling 1.6)`
        : 'no land cue');

    // The comparison the claim is actually about. Only the *height* is set from outside: the fall
    // itself is the product's own gravity integration and the cue comes out of the same emit, so a
    // taller drop has to arrive faster and louder. The height is chosen off `GRAVITY = -24`:
    // 2.5 m reaches sqrt(2·24·2.5) = 11.0 m/s → gain 1.22, clear of a jump's ~0.5 and **below the
    // 1.6 clamp** — a 6 m drop was tried first and read exactly 1.60, i.e. the clamp, which tests
    // the ceiling rather than the curve.
    const DROP_M = 2.5;
    await p.evaluate((h) => {
      window.game.me.y += h; window.game.me.grounded = false; window.game.me.vy = 0;
    }, DROP_M);
    const fall = [];
    for (let waited = 0; waited < 6000; waited += 300) {
      fall.push(...(await drain()));
      if (fall.some((c) => c.name === 'land')) break;
      await sleep(300);
    }
    const hard = fall.find((c) => c.name === 'land');
    check(`a ${DROP_M} m drop lands louder than a jump, and not at the clamp`, !!hard && !!land
      && hard.opts?.gain > land.opts.gain + 0.2 && hard.opts.gain < 1.6,
      hard && land ? `jump ${land.opts.gain.toFixed(2)} vs drop ${hard.opts.gain.toFixed(2)}`
        : `${hard ? 'no jump cue' : 'no drop cue'}`);

    await p.keyboard.press('KeyC');
    check('dashing is audible', (await waitFor(['dash'], 2000)).includes('dash'));

    // Swing goes through the model rather than the mouse: a left click only attacks
    // when an enemy is under the cursor, and a probe cannot promise one is in frame.
    await p.evaluate(() => { window.game.me.attackCooldown = 0; window.game.me.attack(window.game.actors); });
    check('a normal attack swings audibly', (await waitFor(['swing'], 2000)).includes('swing'));

    await p.keyboard.press('KeyE');
    check('the elemental skill is audible', (await waitFor(['skill'], 3000)).includes('skill'));

    // The burst needs a full gauge, which a fresh guest does not have. Filling it is
    // the fixture, not the subject — the subject is whether the cast makes a sound.
    await p.evaluate(() => { const m = window.game.me; m.energy = m.energyMax; m.burstCd = 0; m.rooted = 0; });
    await p.keyboard.press('KeyQ');
    check('the elemental burst is audible', (await waitFor(['burst'], 3000)).includes('burst'));

    await p.keyboard.press('KeyK');
    const opened = await waitFor(['open'], 3000);
    await p.keyboard.press('Escape');
    const closed = await waitFor(['close'], 3000);
    check('opening a panel is audible', opened.includes('open'), opened.join(',') || 'nothing');
    check('closing it is audible', closed.includes('close'), closed.join(',') || 'nothing');

    // Every refusal in the game surfaces as a red toast, so the toast is the cue.
    await p.evaluate(() => window.game.toast('探针：这一步不行', 'bad'));
    check('a refusal is audible', (await waitFor(['error'], 1500)).includes('error'));
    await p.evaluate(() => window.game.toast('探针：这一步可以', 'good'));
    await sleep(500);
    check('...and good news is not the same sound', !(await names()).includes('error'));

    // Everything the running game asked for has to be a name the synth implements —
    // the switch swallows the rest, so this is the only place a typo can be caught,
    // and boot alone asks for a dozen of them.
    const unknown = [...new Set(seen)].filter((n) => !SFX_CUES[n]);
    check('every cue the running game asked for is implemented', unknown.length === 0,
      unknown.join(', ') || `${new Set(seen).size} distinct: ${[...new Set(seen)].join(',')}`);

    if (hooked.ready) {
      const live = await p.evaluate(() => {
        const g = window.game;
        const here = g.audio.sfx('hit', { at: [g.me.x, g.me.y + 1, g.me.z] });
        const away = g.audio.sfx('hit', { at: [g.me.x + 300, g.me.y, g.me.z + 300] });
        return { here, away };
      });
      await drain();
      check('in the running game, a sound at your feet plays', live.here === true);
      check('...and one 400 m away does not', live.away === false);
    } else {
      skip('distance culling in the running game', 'no audio device: ctx never became ready');
    }

    check('no page errors while playing sounds', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    fails++;
    console.log(`  FAIL harness: ${e.message}`);
  } finally {
    await b.close();
  }
}

console.log(`\n${passes} passed, ${fails} failed, ${skips} skipped`);
process.exit(fails);
