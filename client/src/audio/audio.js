// Procedural audio: everything is synthesised at runtime, no sample files.
//
// The same reasoning as the graphics — the project ships no binary assets, so the
// music is a small generative engine and every sound effect is an oscillator
// recipe. That constraint turns out to suit an open-world game: a generative score
// never loops audibly, and it can follow the player between exploration and
// combat by changing its own parameters instead of cross-fading tracks.
//
// Structure:
//   master → { musicBus → reverb/dry, sfxBus, ambienceBus }
//   a scheduler runs ~10 Hz and queues note events a fraction of a second ahead,
//   because scheduling on the audio clock is sample-accurate while setTimeout is
//   not, and anything scheduled *at* now() clicks.

const A4 = 440;

/** Semitone offset → frequency, relative to A4. */
function ftom(semis) { return A4 * Math.pow(2, semis / 12); }

/** Scale degrees as semitone offsets from the root. */
const SCALES = {
  // Major pentatonic: the open, wistful default for overworld exploration.
  pentatonic: [0, 2, 4, 7, 9, 12, 14, 16, 19, 21],
  // Natural minor for the snow zone and dungeons.
  minor: [0, 2, 3, 5, 7, 8, 10, 12, 14, 15, 17, 19],
  // Lydian-ish for the golden hall: bright but slightly unreal.
  lydian: [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19],
};

/** Chord progressions as arrays of scale-degree triads. */
const PROGRESSIONS = {
  mondstadt: [[0, 2, 4], [3, 5, 7], [1, 3, 5], [2, 4, 6]],
  dragonspine: [[0, 2, 4], [5, 7, 9], [3, 5, 7], [0, 2, 4]],
  liyue: [[0, 2, 4], [4, 6, 8], [2, 4, 6], [3, 5, 7]],
  dungeon: [[0, 2, 4], [1, 3, 5], [0, 2, 4], [4, 6, 8]],
};

const ZONE_MUSIC = {
  mondstadt: { root: -9, scale: 'pentatonic', bpm: 84, prog: 'mondstadt', pad: 0.30, air: 0.16, bell: 0.9 },
  dragonspine: { root: -14, scale: 'minor', bpm: 62, prog: 'dragonspine', pad: 0.34, air: 0.26, bell: 0.5 },
  liyue: { root: -7, scale: 'pentatonic', bpm: 76, prog: 'liyue', pad: 0.28, air: 0.14, bell: 1.0 },
  abyssTrial: { root: -16, scale: 'minor', bpm: 96, prog: 'dungeon', pad: 0.36, air: 0.10, bell: 0.35 },
  frostCavern: { root: -17, scale: 'minor', bpm: 70, prog: 'dungeon', pad: 0.38, air: 0.22, bell: 0.45 },
  goldenHall: { root: -5, scale: 'lydian', bpm: 88, prog: 'dungeon', pad: 0.30, air: 0.12, bell: 1.1 },
};

/**
 * Every effect this module can synthesise, what it means, and **which file is
 * supposed to ask for it**.
 *
 * `sfx()` ends in `default: break` — an unknown name is deliberately ignored so the
 * UI can be liberal. The price of that kindness is that a key nobody calls and a
 * name nobody implements are equally silent, and silence is the one bug no gate here
 * would ever have reported. When this table was first written, nine of the recipes
 * below had no caller at all: the sword swing, the jump, the landing, the elemental
 * skill and the elemental burst — the five things a player does most — plus loot,
 * panel-open, refusals and fast travel. They had been synthesised, mixed and
 * connected to the bus since the day the file was written, and never once played.
 *
 * So the vocabulary is declared, and `tools/audio-check.mjs` checks it both ways:
 * every `case` needs a cue, every cue needs a `case`, and every cue's `from` files
 * must really contain the call.
 */
export const SFX_CUES = {
  hit:          { what: '命中敌人', from: ['game/game.js'] },
  crit:         { what: '暴击命中', from: ['game/game.js'] },
  swing:        { what: '普通攻击/重击挥出（本地与远端玩家）', from: ['game/game.js'] },
  hurt:         { what: '自己受伤', from: ['game/game.js'] },
  heal:         { what: '自己被治疗', from: ['game/game.js'] },
  // 护盾的三个结果各有一个声音，因为它们要求玩家做三件不同的事：站住、继续打、躲开。
  shield:       { what: '护盾升起（结晶碎片/磐岩壁垒/圣咏回响的溢出盾都走这里）', from: ['game/game.js'] },
  shieldBreak:  { what: '护盾破碎（敌人的或自己的）', from: ['game/game.js'] },
  shieldBlock:  { what: '一次攻击被自己的盾完全吃掉（此时 hurt 被刻意抑制）', from: ['game/game.js'] },
  die:          { what: '普通敌人死亡', from: ['game/game.js'] },
  bossDie:      { what: 'BOSS 死亡', from: ['game/game.js'] },
  // BOSS 跨过血线换阶段：攻击更快、招式更多，还附带 1.2 秒硬直。以前这一切都是无声的。
  bossPhase:    { what: 'BOSS 进入下一阶段', from: ['game/game.js'] },
  enemyAttack:  { what: '敌人攻击命中期', from: ['game/game.js'] },
  step:         { what: '脚步', from: ['game/game.js'] },
  jump:         { what: '起跳', from: ['game/game.js'] },
  land:         { what: '落地（按下落速度给音量）', from: ['game/game.js'] },
  dash:         { what: '冲刺', from: ['game/game.js'] },
  skill:        { what: '元素战技（本地与远端玩家）', from: ['game/game.js'] },
  burst:        { what: '元素爆发（本地与远端玩家）', from: ['game/game.js'] },
  switch:       { what: '切换角色', from: ['game/game.js'] },
  chest:        { what: '开启宝箱', from: ['game/game.js'] },
  loot:         { what: '战利品掉落', from: ['game/game.js'] },
  pickup:       { what: '采集/使用道具/领取奖励', from: ['game/game.js', 'ui/panels.js'] },
  unlock:       { what: '激活锚点或神像、新手引导全部完成', from: ['game/game.js', 'game/tutorial.js'] },
  puzzle:       { what: '解开谜题', from: ['game/game.js'] },
  quest:        { what: '任务阶段推进', from: ['game/game.js'] },
  levelUp:      { what: '角色升级', from: ['game/game.js'] },
  rankUp:       { what: '冒险等阶提升', from: ['game/game.js'] },
  victory:      { what: '秘境通关', from: ['game/game.js'] },
  defeat:       { what: '秘境失败', from: ['game/game.js'] },
  chamberStart: { what: '秘境开始', from: ['game/game.js'] },
  down:         { what: '角色倒下', from: ['game/game.js'] },
  wish:         { what: '祈愿（无五星）', from: ['ui/panels.js'] },
  wish5:        { what: '祈愿出五星', from: ['ui/panels.js'] },
  click:        { what: 'UI 点击、新手引导完成一步', from: ['ui/panels.js', 'game/tutorial.js'] },
  open:         { what: '打开面板', from: ['ui/panels.js'] },
  close:        { what: '关闭面板', from: ['ui/panels.js'] },
  error:        { what: '操作被拒绝（坏消息提示、技能未冷却）', from: ['game/game.js'] },
  teleport:     { what: '传送', from: ['game/game.js'] },
  effort:       { what: '施放战技/爆发时的短促人声，音高取自 characters.voice', from: ['game/game.js'] },
  // 元素反应. 十一种反应共用六个声音（见下面的 REACTION_SFX），因为要分辨的不是"哪两种元素"，
  // 而是"这一下发生了什么":伤害被放大了、炸了、麻了、冻住了、碎了、还是长出了东西。
  // 这些都是通过 `sfx(REACTION_SFX[...])` 派发的，所以 audio-check 对它们要按映射表查调用点，
  // 而不是按字面量 —— 见 tools/audio-check.mjs 里的 REACTION_SFX 一节。
  reactAmp:     { what: '蒸发/融化：伤害被放大', from: ['game/game.js'] },
  reactBoom:    { what: '超载：范围爆炸', from: ['game/game.js'] },
  reactZap:     { what: '感电/超导：电流窜过去了', from: ['game/game.js'] },
  reactFreeze:  { what: '冻结/结晶：动作停住、结出晶体', from: ['game/game.js'] },
  reactShatter: { what: '碎冰：冻住的东西被砸开', from: ['game/game.js'] },
  reactBloom:   { what: '扩散/绽放/烈绽放：铺开或长开', from: ['game/game.js'] },
};

/**
 * 反应 key → 音效 cue。key 必须与 shared/src/data/elements.js 的 `REACTIONS` 完全一致：
 * `tools/audio-check.mjs` 两个方向都查（每个反应都有声音、每个反应音效都被某个反应用到），
 * 而 `tools/react-check.mjs` 查同一份 key 表对 vfx 的 `case` 标签 —— 因为这一轮修的正是
 * `REACTIONS.freeze` 被客户端写成 `frozen`、于是最常见的那个反应悄悄走了 `default`。
 */
export const REACTION_SFX = {
  vaporize: 'reactAmp',
  melt: 'reactAmp',
  overload: 'reactBoom',
  electroCharged: 'reactZap',
  superconduct: 'reactZap',
  freeze: 'reactFreeze',
  crystallize: 'reactFreeze',
  shatter: 'reactShatter',
  swirl: 'reactBloom',
  bloom: 'reactBloom',
  radiance: 'reactBloom',
};

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.musicVolume = 0.5;
    this.sfxVolume = 0.8;
    this.enabled = true;

    this.zone = null;
    this.weather = null;
    this.music = ZONE_MUSIC.mondstadt;
    this.intensity = 0;        // 0 exploring … 1 in combat
    this._intensityTarget = 0;
    this._bar = 0;
    this._nextNoteTime = 0;
    this._step = 0;
    this._timer = 0;
    this._stepAcc = 0;
    this._lastStepFoot = 0;
    // Scratch gain scale for the effect currently being scheduled, and the listener
    // position `update()` caches for `opts.at`. Both are read synchronously inside
    // `sfx()`, which is the only thing that ever sets them.
    this._vol = 1;
    this._listener = null;
  }

  /* --------------------------------------------------------------- plumbing -- */

  /**
   * Must be called from a user gesture. Browsers refuse to start an AudioContext
   * otherwise, and a suspended context silently swallows everything.
   */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    // A gentle limiter. Generative music plus a dozen simultaneous hits will
    // otherwise clip, and clipping on a laptop speaker sounds like a bug.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 12;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.006;
    this.comp.release.value = 0.22;
    this.master.connect(this.comp).connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVolume;
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = this.musicVolume * 0.8;

    // One shared reverb, built from a synthesised impulse response: a real hall
    // costs a file, and an exponentially decaying noise burst is indistinguishable
    // for a pad wash.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._makeIR(2.6, 0.4);
    this.revSend = ctx.createGain();
    this.revSend.gain.value = 0.5;
    this.revSend.connect(this.reverb).connect(this.master);

    this.musicBus.connect(this.master);
    this.musicBus.connect(this.revSend);
    this.sfxBus.connect(this.master);
    this.ambBus.connect(this.master);

    this._startAmbience();
    this.ready = true;
    this._nextNoteTime = ctx.currentTime + 0.2;
  }

  _makeIR(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const u = i / len;
        // Slight pre-delay of silence gives the tail a sense of room size.
        const pre = u < 0.012 ? u / 0.012 : 1;
        d[i] = (Math.random() * 2 - 1) * pre * Math.pow(1 - u, 1 / decay);
      }
    }
    return buf;
  }

  /** White noise buffer, reused by every noise-based effect. */
  _noise(seconds = 1) {
    const key = `n${seconds}`;
    this._noiseCache = this._noiseCache || {};
    if (this._noiseCache[key]) return this._noiseCache[key];
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this._noiseCache[key] = buf;
    return buf;
  }

  setVolumes(music, sfx) {
    this.musicVolume = music;
    this.sfxVolume = sfx;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.musicBus.gain.setTargetAtTime(music, t, 0.1);
    this.sfxBus.gain.setTargetAtTime(sfx, t, 0.05);
    this.ambBus.gain.setTargetAtTime(music * 0.8, t, 0.1);
  }

  setEnabled(v) {
    this.enabled = v;
    if (this.ready) this.master.gain.setTargetAtTime(v ? 0.9 : 0, this.ctx.currentTime, 0.08);
  }

  /* -------------------------------------------------------------- ambience -- */

  /** A continuous wind/room bed, filtered noise with a slow LFO on the cutoff. */
  _startAmbience() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise(4);
    src.loop = true;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 0.8;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;

    const g = ctx.createGain();
    g.gain.value = 0.0;

    // Two LFOs at incommensurable rates: one alone is audibly periodic.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 260;
    lfo.connect(lfoG).connect(lp.frequency);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.019;
    const lfo2G = ctx.createGain();
    lfo2G.gain.value = 0.05;
    lfo2.connect(lfo2G).connect(g.gain);

    src.connect(hp).connect(lp).connect(g).connect(this.ambBus);
    src.start();
    lfo.start();
    lfo2.start();
    this.amb = { src, lp, g, base: 0.0 };
    this._applyAmbience();
  }

  _applyAmbience() {
    if (!this.ready || !this.amb) return;
    const m = this.music;
    const t = this.ctx.currentTime;
    // Colder zones get a thinner, higher wind; caverns a duller rumble.
    //
    // This used to read `this.zone?.weather === 'blizzard'` — and `zone.weather` is
    // `{ type, windSpeed, cloudiness }`, an object, so both comparisons were always false and the
    // cold thin wind never played in 龙脊雪山. It now keys off the *live* weather instead of the
    // zone constant (`setWeather`, from `weatherAt`), so the bed opens up as a storm arrives.
    const wx = this.weather;
    const type = wx?.type ?? this.zone?.weather?.type;
    const cut = type === 'blizzard' ? 900
      : type === 'snow' ? 620
        : type === 'rain' ? 700
          : this.zone?.kind === 'dungeon' ? 260 : 420;
    this.amb.lp.frequency.setTargetAtTime(cut, t, 2.0);
    // Loudness follows the storm: `m.air` is the zone's own bed level and a storm is allowed to add
    // to it, so a downpour is audibly wetter than the same zone on a clear day.
    const gain = m.air * (1 + 0.55 * (wx?.intensity ?? 0));
    this.amb.g.gain.setTargetAtTime(gain, t, 1.5);
  }

  /* ----------------------------------------------------------------- scene -- */

  /** What is falling right now (`weatherAt`), from `game._updateWeather`. */
  setWeather(w) {
    this.weather = w;
    this._applyAmbience();
  }

  setScene(zdef) {
    this.zone = zdef;
    this.music = ZONE_MUSIC[zdef?.id] || ZONE_MUSIC.mondstadt;
    this._bar = 0;
    this._step = 0;
    this._applyAmbience();
  }

  /* ------------------------------------------------------------- scheduling -- */

  update(dt, game) {
    if (!this.ready || !this.enabled) return;

    // The listener. A third-person game hears from the character, not the camera:
    // pulling the camera out should not make your own sword quieter.
    if (game?.me) this._listener = [game.me.x, game.me.y + 1.2, game.me.z];

    // Combat intensity: nearby living enemies push the score into its busier
    // variation. Derived rather than event-driven so it decays naturally.
    if (game?.actors && game?.me) {
      const near = game.actors.enemiesNear(game.me.x, game.me.z, 26).length;
      this._intensityTarget = Math.min(1, near / 3);
      if (game.chamber?.state === 'active' || game.chamber?.state === 'running') {
        this._intensityTarget = Math.max(this._intensityTarget, 0.75);
      }
      if (!game.me.alive) this._intensityTarget = 0;
    }
    this.intensity += (this._intensityTarget - this.intensity) * Math.min(1, dt * 0.6);

    // Look ahead ~0.35 s. Anything closer than ~30 ms to now() risks a click.
    const ctx = this.ctx;
    const horizon = ctx.currentTime + 0.35;
    const spb = 60 / this.music.bpm;
    const stepDur = spb / 2;    // eighth notes
    let guard = 0;
    while (this._nextNoteTime < horizon && guard++ < 32) {
      this._scheduleStep(this._nextNoteTime, this._step);
      this._nextNoteTime += stepDur;
      this._step++;
    }
  }

  _scheduleStep(when, step) {
    const m = this.music;
    const scale = SCALES[m.scale];
    const prog = PROGRESSIONS[m.prog] || PROGRESSIONS.mondstadt;
    const stepsPerBar = 8;
    const bar = Math.floor(step / stepsPerBar);
    const inBar = step % stepsPerBar;
    const chord = prog[bar % prog.length];
    const spb = 60 / m.bpm;

    // --- pad: one sustained chord per bar -----------------------------------
    if (inBar === 0) {
      for (let i = 0; i < chord.length; i++) {
        const semi = m.root + scale[chord[i] % scale.length] + (chord[i] >= scale.length ? 12 : 0);
        this._pad(when, ftom(semi - 12), spb * stepsPerBar * 0.55, m.pad * (i === 0 ? 1 : 0.7));
      }
      // A bass note on the downbeat is what makes the progression legible.
      this._bass(when, ftom(m.root + scale[chord[0] % scale.length] - 24), spb * 1.6, 0.22 + this.intensity * 0.1);
    }

    // --- melody: sparse when exploring, insistent in combat ------------------
    const melodyChance = 0.16 + this.intensity * 0.42;
    const onBeat = inBar % 2 === 0;
    if ((onBeat || Math.random() < 0.25) && Math.random() < melodyChance + (onBeat ? 0.18 : 0)) {
      const deg = chord[Math.floor(Math.random() * chord.length)] + (Math.random() < 0.3 ? 2 : 0);
      const semi = m.root + scale[deg % scale.length] + 12 * (deg >= scale.length ? 1 : 0);
      this._bell(when, ftom(semi), 0.9 + Math.random() * 0.5, 0.13 * m.bell * (0.7 + this.intensity * 0.5));
    }

    // --- percussion: only appears with intensity ----------------------------
    if (this.intensity > 0.25) {
      if (inBar === 0 || inBar === 4) this._drum(when, 62, 0.16, 0.20 * this.intensity);
      if (inBar === 2 || inBar === 6) this._drum(when, 150, 0.10, 0.13 * this.intensity);
      if (this.intensity > 0.6 && inBar % 2 === 1) this._hat(when, 0.05 * this.intensity);
    }
  }

  /* ------------------------------------------------------------ instruments -- */

  /** Wide, slow pad: two detuned saws through a lowpass with a long envelope. */
  _pad(when, freq, dur, gain) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + dur * 0.35);
    g.gain.linearRampToValueAtTime(0, when + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, when);
    lp.frequency.linearRampToValueAtTime(1400 + this.intensity * 900, when + dur * 0.4);
    lp.Q.value = 0.7;

    for (const det of [-6, 0, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq * Math.pow(2, det / 1200);
      o.connect(lp);
      o.start(when);
      o.stop(when + dur + 0.05);
    }
    lp.connect(g).connect(this.musicBus);
  }

  _bass(when, freq, dur, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    o.connect(g).connect(this.musicBus);
    o.start(when);
    o.stop(when + dur + 0.02);
  }

  /**
   * Struck bell / plucked string via 2-operator FM. A sine carrier with a
   * fast-decaying modulator gives a metallic attack and a pure tail, which is the
   * whole character of the melody voice.
   */
  _bell(when, freq, dur, gain) {
    const ctx = this.ctx;
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = freq;

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = freq * 2.01;   // slight inharmonicity
    const modG = ctx.createGain();
    modG.gain.setValueAtTime(freq * 2.4, when);
    modG.gain.exponentialRampToValueAtTime(1, when + dur * 0.5);
    mod.connect(modG).connect(carrier.frequency);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0005, when + dur);

    carrier.connect(g).connect(this.musicBus);
    carrier.start(when); carrier.stop(when + dur + 0.05);
    mod.start(when); mod.stop(when + dur + 0.05);
  }

  _drum(when, freq, dur, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 2.2, when);
    o.frequency.exponentialRampToValueAtTime(freq, when + dur * 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
    o.connect(g).connect(this.musicBus);
    o.start(when); o.stop(when + dur + 0.02);
  }

  _hat(when, gain) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this._noise(1);
    s.playbackRate.value = 1.4;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0004, when + 0.045);
    s.connect(hp).connect(g).connect(this.musicBus);
    s.start(when, Math.random() * 0.5, 0.08);
  }

  /* ------------------------------------------------------------------- sfx -- */

  /** Short tone with an envelope. The building block for most effects. */
  _tone(freq, { type = 'sine', dur = 0.14, gain = 0.3, sweep = null, delay = 0, detune = 0 } = {}) {
    const ctx = this.ctx;
    gain *= this._vol;
    const when = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(20, sweep), when + dur);
    if (detune) o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
    o.connect(g).connect(this.sfxBus);
    o.start(when);
    o.stop(when + dur + 0.03);
  }

  /** Filtered noise burst: impacts, footsteps, wind whooshes. */
  _burst({ dur = 0.12, gain = 0.3, type = 'bandpass', freq = 1200, q = 1.2, sweep = null, delay = 0, rate = 1 } = {}) {
    const ctx = this.ctx;
    gain *= this._vol;
    const when = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = this._noise(1);
    s.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, when);
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweep), when + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
    s.connect(f).connect(g).connect(this.sfxBus);
    s.start(when, Math.random() * 0.6, dur + 0.05);
  }

  /** Arpeggio helper for the "something good happened" family. */
  _arp(semis, { root = 0, step = 0.07, dur = 0.4, gain = 0.2, type = 'triangle' } = {}) {
    semis.forEach((s, i) => {
      this._tone(ftom(root + s), { type, dur, gain, delay: i * step });
    });
  }

  /**
   * How loud something happening at `at` should be, heard from `this._listener`.
   *
   * Not a PannerNode: panning a mono whoosh in a game where the camera can be behind
   * your own shoulder mostly produces confusion, whereas *distance* carries real
   * information — an enemy winding up 60 m away must not be as loud as the one in
   * front of you. Flat inside 2 m, then an inverse-square-ish rolloff (0.38 at 20 m,
   * 0.12 at 40 m), and silent past ~70 m, which is inside the streaming radius, so a
   * shard full of other players never sounds like a shard full of players next to you.
   */
  _atten(at) {
    if (!at || !this._listener) return 1;
    const [lx, ly, lz] = this._listener;
    const d = Math.hypot(at[0] - lx, (at[1] ?? ly) - ly, at[2] - lz);
    if (d <= 2) return 1;
    const a = 12 / (12 + (d - 2) * (d - 2) * 0.06);
    return a < 0.04 ? 0 : a;
  }

  /**
   * Play a named effect. Unknown names are ignored rather than throwing: the UI
   * gets to be liberal about what it asks for.
   *
   * `opts.gain` scales the recipe (a heavier landing is a louder landing) and
   * `opts.at` is a world position for distance attenuation. Returns whether anything
   * was actually scheduled — a probe cannot hear a sound, but it can count them, and
   * a misspelled name has to be able to fail somewhere.
   *
   * `opts` reaches the recipe as well, because one cue is per *character*: `effort` is
   * pitched by `characters.voice`, and a vocal blip at one fixed frequency for a roster of
   * fourteen is the same sound coming out of fourteen different throats.
   */
  sfx(name, opts = {}) {
    if (!this.ready || !this.enabled) return false;
    const vol = Math.max(0, Math.min(2, opts.gain ?? 1)) * this._atten(opts.at);
    if (vol <= 0) return false;
    this._vol = vol;
    try {
      return this._sfx(name, opts);
    } finally {
      this._vol = 1;
    }
  }

  _sfx(name, opts = {}) {
    switch (name) {
      case 'hit':
        this._burst({ dur: 0.09, gain: 0.30, freq: 1500, sweep: 400, q: 0.9 });
        this._tone(220, { type: 'triangle', dur: 0.08, gain: 0.14, sweep: 110 });
        break;
      case 'crit':
        this._burst({ dur: 0.13, gain: 0.36, freq: 2600, sweep: 500, q: 0.8 });
        this._tone(660, { type: 'square', dur: 0.10, gain: 0.13, sweep: 240 });
        this._tone(990, { type: 'sine', dur: 0.16, gain: 0.10, delay: 0.02 });
        break;
      case 'swing':
        this._burst({ dur: 0.16, gain: 0.20, type: 'bandpass', freq: 900, sweep: 2600, q: 0.7 });
        break;
      case 'hurt':
        this._burst({ dur: 0.20, gain: 0.30, type: 'lowpass', freq: 900, sweep: 200, q: 0.6 });
        this._tone(140, { type: 'sawtooth', dur: 0.18, gain: 0.16, sweep: 70 });
        break;
      case 'heal':
        this._arp([0, 4, 7, 12], { root: 4, step: 0.055, dur: 0.5, gain: 0.11, type: 'sine' });
        break;
      // 护盾升起：往上扫的一声，加一个开放五度，听起来像"关上了"而不是像受伤。
      case 'shield':
        this._tone(220, { type: 'sine', dur: 0.45, gain: 0.13, sweep: 640 });
        this._arp([0, 7, 12], { root: 5, step: 0.05, dur: 0.4, gain: 0.075, type: 'triangle' });
        break;
      // 破碎：高频噪声往上散开（玻璃），底下一个往下掉的方波（支撑没了）。
      case 'shieldBreak':
        this._burst({ dur: 0.42, gain: 0.26, type: 'highpass', freq: 900, sweep: 4200, q: 0.7 });
        this._tone(520, { type: 'square', dur: 0.22, gain: 0.11, sweep: 120 });
        this._tone(1560, { type: 'sine', dur: 0.3, gain: 0.07, sweep: 700, delay: 0.03 });
        break;
      // 完全挡住：闷、短、不刺耳。它顶掉的是 hurt，所以绝不能听着像受伤。
      case 'shieldBlock':
        this._tone(160, { type: 'sine', dur: 0.14, gain: 0.14, sweep: 95 });
        this._burst({ dur: 0.12, gain: 0.10, type: 'lowpass', freq: 700, q: 0.9 });
        break;
      case 'die':
        this._tone(300, { type: 'sawtooth', dur: 0.34, gain: 0.16, sweep: 60 });
        this._burst({ dur: 0.34, gain: 0.24, type: 'lowpass', freq: 1400, sweep: 180 });
        break;
      case 'bossDie':
        this._tone(180, { type: 'sawtooth', dur: 0.9, gain: 0.24, sweep: 40 });
        this._burst({ dur: 0.9, gain: 0.3, type: 'lowpass', freq: 2200, sweep: 90 });
        this._arp([0, -5, -12], { root: 0, step: 0.13, dur: 0.9, gain: 0.14 });
        break;
      // 换阶段：一记低音重击 + 往上的小三度，比 bossDie 短、比 shieldBreak 低。
      // 它要说的是"它还没死，但它变了"，所以结尾是升上去的，不是塌下去的。
      case 'bossPhase':
        this._tone(70, { type: 'sine', dur: 0.75, gain: 0.3, sweep: 44 });
        this._burst({ dur: 0.55, gain: 0.2, type: 'lowpass', freq: 900, sweep: 260, q: 0.8 });
        this._arp([0, 3, 7], { root: -7, step: 0.11, dur: 0.7, gain: 0.13, type: 'sawtooth' });
        break;
      case 'enemyAttack':
        this._burst({ dur: 0.18, gain: 0.18, type: 'bandpass', freq: 500, sweep: 1600, q: 1.0 });
        break;
      case 'step': {
        // Footsteps need variation or they turn into a metronome.
        const r = 0.85 + Math.random() * 0.4;
        this._burst({ dur: 0.055, gain: 0.075, type: 'bandpass', freq: 380 * r, q: 1.6, rate: r });
        break;
      }
      case 'jump':
        this._tone(300, { type: 'sine', dur: 0.12, gain: 0.12, sweep: 620 });
        break;
      case 'dash':
        // Longer and lower than a sword swing, and sweeping *down* — a body moving
        // through air, not an edge cutting it.
        this._burst({ dur: 0.26, gain: 0.20, type: 'bandpass', freq: 1700, sweep: 320, q: 0.5 });
        this._tone(180, { type: 'sine', dur: 0.16, gain: 0.08, sweep: 90 });
        break;
      case 'land':
        this._burst({ dur: 0.12, gain: 0.18, type: 'lowpass', freq: 500, sweep: 140 });
        break;
      case 'skill':
        this._tone(440, { type: 'triangle', dur: 0.26, gain: 0.16, sweep: 900 });
        this._burst({ dur: 0.26, gain: 0.14, freq: 1800, sweep: 600 });
        break;
      // A voice, not a synth patch: the fundamental at the character's own pitch, a
      // formant a fifth above it, and a breath burst under both. `sweep` falls rather
      // than rises, which is what turns a beep into an exhale.
      case 'effort': {
        const f = Math.max(80, Math.min(500, opts.pitch || 200));
        const dur = opts.long ? 0.34 : 0.18;
        this._tone(f, { type: 'triangle', dur, gain: 0.15, sweep: f * 0.72 });
        this._tone(f * 1.5, { type: 'sine', dur: dur * 0.7, gain: 0.07, sweep: f * 1.1, delay: 0.015 });
        this._burst({ dur: dur * 0.8, gain: 0.06, type: 'bandpass', freq: f * 4, q: 1.2, sweep: f * 2 });
        break;
      }
      case 'burst':
        this._tone(160, { type: 'sawtooth', dur: 0.6, gain: 0.2, sweep: 700 });
        this._arp([0, 7, 12, 16, 19], { root: 0, step: 0.05, dur: 0.7, gain: 0.13 });
        this._burst({ dur: 0.7, gain: 0.22, type: 'lowpass', freq: 400, sweep: 3000 });
        break;
      case 'switch':
        this._arp([0, 7, 12], { root: 7, step: 0.04, dur: 0.22, gain: 0.11 });
        break;
      case 'chest':
        this._burst({ dur: 0.10, gain: 0.16, freq: 700, q: 2 });
        this._arp([0, 4, 7, 11, 16], { root: 4, step: 0.065, dur: 0.6, gain: 0.13 });
        break;
      case 'loot':
        this._arp([12, 16], { root: 0, step: 0.05, dur: 0.3, gain: 0.10 });
        break;
      case 'pickup':
        // Two parts, because picking a plant is a physical event and a reward one:
        // a short filtered noise burst for the stem breaking, then a rising third.
        this._burst({ dur: 0.09, gain: 0.13, type: 'bandpass', freq: 1900, sweep: 900, q: 1.4 });
        this._arp([7, 12], { root: 2, step: 0.055, dur: 0.28, gain: 0.11, type: 'sine' });
        break;
      case 'unlock':
        this._arp([0, 5, 9, 12], { root: 2, step: 0.08, dur: 0.8, gain: 0.13, type: 'sine' });
        break;
      case 'puzzle':
        this._arp([0, 4, 7, 12, 16, 19], { root: 0, step: 0.07, dur: 0.9, gain: 0.12, type: 'sine' });
        break;
      case 'quest':
        this._arp([0, 4, 7], { root: 9, step: 0.09, dur: 0.7, gain: 0.14, type: 'triangle' });
        break;
      case 'levelUp':
        this._arp([0, 4, 7, 12], { root: 0, step: 0.07, dur: 0.7, gain: 0.15 });
        break;
      case 'rankUp':
        this._arp([0, 4, 7, 12, 16], { root: 0, step: 0.09, dur: 1.1, gain: 0.17 });
        break;
      case 'victory':
        this._arp([0, 4, 7, 12, 7, 12, 16], { root: 0, step: 0.11, dur: 0.8, gain: 0.16 });
        break;
      case 'defeat':
        this._arp([0, -3, -7, -12], { root: 0, step: 0.16, dur: 0.9, gain: 0.15, type: 'sine' });
        break;
      case 'chamberStart':
        this._tone(110, { type: 'sawtooth', dur: 0.8, gain: 0.18, sweep: 220 });
        this._burst({ dur: 0.8, gain: 0.18, type: 'lowpass', freq: 300, sweep: 1400 });
        break;
      case 'down':
        this._tone(220, { type: 'sawtooth', dur: 0.7, gain: 0.2, sweep: 55 });
        break;
      case 'wish':
        this._arp([0, 7, 12, 19, 24], { root: 0, step: 0.06, dur: 1.0, gain: 0.14, type: 'sine' });
        break;
      case 'wish5':
        this._arp([0, 4, 7, 12, 16, 19, 24], { root: 0, step: 0.08, dur: 1.4, gain: 0.18 });
        break;
      case 'click':
        this._tone(1200, { type: 'sine', dur: 0.035, gain: 0.08 });
        break;
      case 'open':
        this._tone(700, { type: 'sine', dur: 0.09, gain: 0.09, sweep: 1300 });
        break;
      case 'close':
        this._tone(900, { type: 'sine', dur: 0.08, gain: 0.08, sweep: 500 });
        break;
      case 'error':
        this._tone(200, { type: 'square', dur: 0.11, gain: 0.11, sweep: 150 });
        break;
      case 'teleport':
        this._tone(200, { type: 'sine', dur: 0.6, gain: 0.16, sweep: 2400 });
        this._burst({ dur: 0.6, gain: 0.16, type: 'bandpass', freq: 600, sweep: 4000, q: 0.8 });
        break;
      // ── 元素反应 ──────────────────────────────────────────────────────────────
      // 这六个是叠在 hit/enemyAttack 上面播的，所以每一个都刻意留在 0.1~0.2 的 gain：
      // 反应要听得出来，但不能把它自己触发的那一下打击盖掉。彼此之间靠"形状"区分
      // （往上/往下、点状/连续、有没有尾巴），而不是靠音高，因为战斗里同时响的东西太多。
      //
      // 蒸发/融化：伤害被乘大了。一个往上扫的实音加一层跟着张开的噪声 —— 结论是"更多"。
      case 'reactAmp':
        this._tone(330, { type: 'triangle', dur: 0.30, gain: 0.15, sweep: 880 });
        this._burst({ dur: 0.32, gain: 0.14, type: 'bandpass', freq: 800, sweep: 3200, q: 0.7 });
        break;
      // 超载：真的炸了。低频塌下去 + 宽带噪声，比 bossPhase 短、比 hit 沉。
      case 'reactBoom':
        this._tone(90, { type: 'sawtooth', dur: 0.45, gain: 0.22, sweep: 42 });
        this._burst({ dur: 0.40, gain: 0.22, type: 'lowpass', freq: 2600, sweep: 200 });
        break;
      // 感电/超导：三颗随机的高频爆点，不是一条连续的声音 —— 电是断续的。
      case 'reactZap':
        for (let i = 0; i < 3; i++) {
          const r = 0.8 + Math.random() * 0.5;
          this._burst({
            dur: 0.05, gain: 0.13, type: 'highpass', freq: 2200 * r, sweep: 5000, q: 1.2, rate: r,
          });
          this._tone(1400 * r, { type: 'square', dur: 0.04, gain: 0.06, delay: i * 0.045 });
        }
        break;
      // 冻结/结晶：往下停住的一声（动作被按停了），上面挂一个很干净的高音三度，像结出面。
      case 'reactFreeze':
        this._tone(520, { type: 'sine', dur: 0.34, gain: 0.13, sweep: 190 });
        this._arp([0, 7], { root: 24, step: 0.06, dur: 0.5, gain: 0.07, type: 'sine' });
        this._burst({ dur: 0.30, gain: 0.09, type: 'bandpass', freq: 3400, sweep: 1200, q: 1.6 });
        break;
      // 碎冰：硬起音、短、亮，向上散开。它和 shieldBreak 的区别是没有底下那个塌下去的方波：
      // 碎的是敌人身上的冰，不是玩家的依靠。
      case 'reactShatter':
        this._burst({ dur: 0.22, gain: 0.26, type: 'highpass', freq: 1800, sweep: 6000, q: 0.8 });
        this._tone(2100, { type: 'triangle', dur: 0.10, gain: 0.09, sweep: 3000 });
        break;
      // 扩散/绽放/烈绽放：软起音、往外铺，用五度堆叠而不是打击 —— 长出来的东西没有撞击点。
      case 'reactBloom':
        this._arp([0, 7, 14], { root: 9, step: 0.07, dur: 0.55, gain: 0.10, type: 'sine' });
        this._burst({ dur: 0.5, gain: 0.10, type: 'lowpass', freq: 500, sweep: 2400, q: 0.5 });
        break;
      default:
        return false;
    }
    return true;
  }

  dispose() {
    if (!this.ctx) return;
    try { this.amb?.src.stop(); } catch { /* already stopped */ }
    this.ctx.close();
    this.ctx = null;
    this.ready = false;
  }
}
