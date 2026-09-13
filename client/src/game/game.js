// The game: owns every subsystem, the frame loop, and the translation between
// server events and things the player sees or hears.
//
// Layering rule this file exists to enforce: subsystems never talk to each other
// directly. The world does not know about the socket; the actor system does not
// know about the DOM; the UI does not know about Three.js. Everything meets here.
// That is why this file is long — the alternative is the same amount of coupling
// smeared across ten files where it cannot be read in one sitting.
//
// Control scheme (the goal is a mouse-playable game, so the mouse is primary):
//   left click ground   → walk there
//   left click enemy    → lock on, close to weapon range, keep attacking
//   hold left           → charged attack on release
//   left click a chest / waypoint / NPC → walk over and interact
//   right / middle drag → orbit camera, wheel → zoom
//   WASD                → direct steering, cancels any click order
//   E / Q / 1-4 / F     → skill, burst, party switch, interact

import * as THREE from 'three';
import { Renderer } from '../engine/renderer.js';
import { QualityGovernor, TIERS, ZONE_SETTLE } from '../engine/perf.js';
import { setToonTime } from '../gfx/toon.js';
import { S2C } from '@teyvat/shared/protocol.js';
import { CHARACTERS, SKILL_RADIUS, playerAttackShape } from '@teyvat/shared/data/characters.js';
import { ELEMENTS, REACTIONS } from '@teyvat/shared/data/elements.js';
import { ENEMIES, ATTACK_MOVES, attackShape } from '@teyvat/shared/data/enemies.js';
import { zoneById, canEnterZone, zoneEntryRank, npcRoleName, PUZZLE_KINDS } from '@teyvat/shared/data/zones.js';
import { itemName, itemDef, itemIcon, equipName, equipIcon, MATERIALS } from '@teyvat/shared/data/items.js';
import { QUESTS, questHasEnding, offerableQuest } from '@teyvat/shared/data/quests.js';
import { REVIVE_RANGE } from '@teyvat/shared/world/entity.js';
import { worldClock, clockLabel, daylight, dayTFromHours, timeOfDayName, DAY_MS } from '@teyvat/shared/world/daylight.js';
import { weatherAt } from '@teyvat/shared/world/weather.js';
import { clamp } from '@teyvat/shared/sim/rng.js';
import { api, errorText } from '../net/api.js';
import { socket } from '../net/socket.js';
import { LocalSocket } from '../net/localSocket.js';
import { Input, PANEL_ACTIONS } from './input.js';
import { CameraRig } from './camera.js';
import { Vfx } from './vfx.js';
import { Overlay } from './overlay.js';
import { World } from './world.js';
import { ActorSystem } from './actors.js';
import { LocalPlayer } from './localPlayer.js';
import { Tutorial } from './tutorial.js';
import { Audio, REACTION_SFX } from '../audio/audio.js';

const INTERACT_RANGE = 4.2;

export class Game {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    // Two different things, deliberately: `settings.quality` is what the player asked for
    // and what gets saved, `this.quality` is what is being rendered right now. They differ
    // whenever the governor has stepped down, and at boot whenever `guessTier` says this
    // machine should not even try the asked-for tier first.
    const asked = opts.quality || 'high';
    this.quality = TIERS.includes(opts.startQuality) ? opts.startQuality : asked;
    this.settings = {
      quality: asked,
      // The tier above is a ceiling, not a promise: with this on, the governor drops below
      // it when the machine cannot hold it. Default on, because the failure it prevents
      // (an unplayable 3 fps with no way out but the settings panel) is much worse than
      // the one it can cause (a scene that quietly renders simpler than asked).
      autoQuality: true,
      showNames: true,
      showDamage: true,
      cameraShake: true,
      musicVolume: 0.5,
      sfxVolume: 0.8,
      invertY: false,
      sensitivity: 1,
      autoAttack: true,
      ...(opts.settings || {}),
    };

    this.r = new Renderer(canvas, this.quality);
    this.scene = this.r.scene;
    this.camera = this.r.camera;

    // Watches the renderer's frame-time buckets and steps the tier down when the machine
    // cannot hold the one that was asked for. `_applyQuality` rather than `setQuality`:
    // an automatic drop must not overwrite the player's saved choice, or one slow evening
    // would permanently demote them.
    this.governor = new QualityGovernor({
      tier: this.quality,
      ceiling: asked,
      enabled: this.settings.autoQuality !== false,
      onChange: (q, { from, reason }) => {
        this._applyQuality(q);
        console.log(`[quality] ${from} -> ${q} (${reason})`);
        this.emit('quality', { quality: q, from, reason, auto: true });
        // A recovery reads as good news, a drop as a warning; both are worth telling the
        // player about, because a scene that silently loses its shadows looks like a bug.
        this.emit('toast', { text: reason, kind: TIERS.indexOf(q) > TIERS.indexOf(from) ? 'gold' : 'bad' });
      },
    });
    this._perfSeq = 0;

    this.vfx = new Vfx(this.scene);
    this.vfx.setQuality(this.quality);
    this.overlay = new Overlay(opts.overlayRoot || document.getElementById('world-overlay'), this.camera);
    this.input = new Input(canvas);
    this.audio = new Audio();
    // 新手引导. Constructed before the save loads (so `mark` is always callable from the
    // frame loop and from every input path) and filled in by `load`; every step is completed
    // by an outcome further down this file, never by a keypress.
    this.tutorial = new Tutorial(this);
    // 单机 or 在线 is settled here, before anything binds to a socket: solo hosts the
    // authoritative simulation in this tab (see net/localSocket.js), online talks to the
    // gateway. The two present the same interface, so nothing downstream — the actor
    // system, LocalPlayer, `_bindSocket` — has to know which one it was handed.
    this.mode = opts.mode === 'solo' ? 'solo' : 'online';
    this.socket = this.mode === 'solo' ? new LocalSocket() : socket;
    // The socket does not know about the REST client, so hand it the token.
    this.socket.token = api.token;
    this.actors = new ActorSystem(this.scene, this.socket, this.vfx);
    this.rig = null;            // CameraRig, needs the world's height field
    this.world = null;
    this.me = null;             // LocalPlayer

    this.raycaster = new THREE.Raycaster();
    this.player = null;         // server player record (publicPlayer)
    this.stats = {};            // derived stats per character
    this.party = [];
    this.activeSlot = 0;
    this.zoneId = null;
    this.chamber = null;
    this.partyRoster = [];
    this.onlineCount = 0;
    this.buffs = [];            // local food buffs: { kind, item, name, atkPct, critRate, endsAt }

    this.target = null;         // locked enemy id
    this.autoAttack = false;
    this.prompt = null;         // { key, txt, sub, entry }
    this.aiming = false;
    this._leftHold = 0;
    this._leftWasDown = false;
    this._time = 0;
    this._running = false;
    this._raf = 0;
    this._paused = false;
    this._events = new Map();
    this._pendingZone = null;
    this._lastSaveAt = 0;
    this._deaths = 0;
    // 时间. `_timePin` null means "follow the wall clock"; a number freezes the sky at that hour
    // (设置 has the row, and every pixel probe pins noon). `_daylightAt` is the dayT the sky was
    // last written at, -1 so the first frame always writes.
    this._timePin = typeof this.settings.worldTime === 'number' ? this.settings.worldTime : null;
    // Which day of the forecast a pinned clock sits on. Not persisted and not in 设置: a pin is day
    // 0, which is the day `weatherAt` defines as "the zone exactly as authored", so pinning an hour
    // keeps every calibrated pixel threshold. Probes pass a day to photograph a storm.
    this._dayPin = 0;
    this._daylightAt = -1;
    this._weatherAt = -1;
    this.weather = null;        // last weatherAt() result, for the HUD, the audio bed and probes
    this.phase = null;          // last daylight() result, for probes and the terrain
    this.clock = null;          // the HUD's view of it

    this._bindSocket();
    window.addEventListener('resize', () => this._onResize());
    document.addEventListener('visibilitychange', () => {
      // A backgrounded tab stops getting frames; do not accumulate a huge dt.
      if (document.hidden) this.input.setEnabled(false);
      else this.input.setEnabled(!this._paused);
    });
  }

  /* --------------------------------------------------------------- event bus -- */

  on(type, fn) {
    if (!this._events.has(type)) this._events.set(type, new Set());
    this._events.get(type).add(fn);
    return () => this._events.get(type)?.delete(fn);
  }

  emit(type, data) {
    const s = this._events.get(type);
    if (s) for (const fn of [...s]) { try { fn(data); } catch (e) { console.error(`[game:${type}]`, e); } }
  }

  /**
   * Every refusal in the game already ends up here as a red toast — not enough mora,
   * resin short, a locked door, a rejected request — so this is the one place a
   * "that did not work" sound belongs. Wiring it at each call site instead would mean
   * remembering it 40 times, and the ones that were forgotten would be exactly the
   * ones a player never understands.
   */
  toast(text, kind = '') {
    if (kind === 'bad') this.audio.sfx('error');
    this.emit('toast', { text, kind });
  }
  banner(title, sub = '') { this.emit('banner', { title, sub }); }

  /* ------------------------------------------------------------------- boot -- */

  /**
   * Load the player, connect, and build the starting zone.
   * `onProgress(fraction, message)` drives the boot bar.
   */
  async load(onProgress = () => {}) {
    onProgress(0.05, '读取存档…');
    const st = await api.playerState();
    this.player = st.player;
    this.stats = st.stats || {};
    this.party = st.player.party?.length ? st.player.party.slice() : ['lyra'];
    this.activeSlot = clamp(st.player.activeSlot || 0, 0, this.party.length - 1);
    Object.assign(this.settings, st.player.settings || {});
    // Before the first frame, so a returning player never sees step 1 flash for the
    // duration of one round trip.
    this.tutorial.sync(this.settings.tutorial);
    // The saved tier is the ceiling. With the governor on it decides when to actually climb
    // to it (so `guessTier`'s verdict survives the load); with it off, the save is law.
    const auto = this.settings.autoQuality !== false;
    if (this.settings.quality) {
      this.governor.setCeiling(this.settings.quality, !auto);
      if (!auto) this._applyQuality(this.settings.quality);
    }
    this.governor.setEnabled(auto);
    this.audio.setVolumes(this.settings.musicVolume, this.settings.sfxVolume);
    this.emit('playerState', { player: this.player, stats: this.stats });

    // In 单机 mode the "server" is this tab, and it needs the save it is going to
    // simulate: party, position, adventure rank, abyss records. `playerState` above is
    // the same document the gateway would have loaded, so solo costs no extra request.
    this.socket.setSave?.(this.player, this.stats);

    onProgress(0.18, this.mode === 'solo' ? '启动本地世界…' : '连接服务器…');
    const welcome = await this._connect(this.mode, this.player.zone);

    onProgress(0.34, `载入${zoneById(welcome.zone)?.name || welcome.zone}…`);
    await this._buildZone(welcome.zone, welcome.you, welcome.state, onProgress);
    onProgress(1, '进入提瓦特');
    return welcome;
  }

  /** Open the socket and resolve on WELCOME. */
  _connect(mode, zone) {
    return new Promise((resolve, reject) => {
      let done = false;
      const offW = this.socket.on(S2C.WELCOME, (d) => {
        if (done) return;
        done = true; offW(); offF();
        this.mode = d.mode || mode;
        this.actors.setLocalId(d.playerId);
        this.playerId = d.playerId;
        resolve(d);
      });
      const offF = this.socket.on('fatal', (d) => {
        if (done) return;
        done = true; offW(); offF();
        reject(new Error(d?.reason || 'connect_failed'));
      });
      this.socket.connect(zone, mode);
      setTimeout(() => {
        if (!done) { done = true; offW(); offF(); reject(new Error('timeout')); }
      }, 15000);
    });
  }

  /** Build (or rebuild) the world for a zone and place the local player. */
  async _buildZone(zoneId, you, state, onProgress = () => {}) {
    const zdef = zoneById(zoneId);
    if (!zdef) throw new Error(`unknown zone ${zoneId}`);

    // Tear the old zone down first so we never hold two worlds of geometry.
    if (this.world) {
      this.actors.dispose();
      this.world.dispose();
      this.overlay.clear();
      // The Vfx pools hang off the persistent scene, not off the world, so anything still
      // in flight when the teleport fired would keep animating in the new zone at the old
      // zone's coordinates — a ring expanding in mid-air over a different continent.
      this.vfx.clear();
      this.world = null;
    }

    this.zoneId = zoneId;
    // Before the world, so the first composited frame of the new zone is already at its own
    // exposure rather than flashing the previous zone's for a frame or two.
    this.r.setExposure(zdef.sky?.exposure ?? 1.0);
    this.world = new World(zdef, this.scene, { quality: this.quality });
    // Once, now, forced: the zone was built from its authored noon values, so without this the
    // first frame after a loading screen is a noon sky at 02:00 until the next periodic update.
    this._daylightAt = -1;
    this._weatherAt = -1;
    this._updateDaylight(true);
    this._updateWeather(true);
    onProgress(0.5, '生成地形…');
    this.world.applyProgress(this.player?.worldProgress);

    if (!this.rig) {
      // Both callbacks read `this.world` at call time, so a zone change needs no
      // rebinding — the rig follows whichever world is current.
      this.rig = new CameraRig(this.camera, (x, z) => this.world.heightAt(x, z));
      this.rig.blockedAt = (x, y, z) => this.world.blockedAt(x, y, z);
    }

    const charId = this.party[this.activeSlot] || this.party[0] || 'lyra';
    if (!this.me) {
      this.me = new LocalPlayer(this.scene, this.world, this.camera, this.socket, this.vfx, { charId });
      this._bindLocal();
    } else {
      this.me.world = this.world;
    }
    this.me.setCharacter(charId, this._weaponOf(charId));

    const px = you?.x ?? this.player?.pos?.x ?? 0;
    const pz = you?.z ?? this.player?.pos?.z ?? 0;
    onProgress(0.62, '放置景物…');
    this.world.prewarm(px, pz);
    this.me.teleportTo(px, this.world.heightAt(px, pz), pz, you?.ry ?? 0);
    this.me.applyServer(you, null);
    this.rig.snapToFocus({ x: px, y: this.me.y, z: pz }, this.me.height);
    this.rig.update(0.016, { x: px, y: this.me.y, z: pz }, this.me.height, false);

    // Seed actors from the zone state so the world is populated on the very first
    // frame rather than a tenth of a second later.
    if (state) {
      this.actors.update(0.016, 0, {
        a: { serverNow: 0, data: state }, b: { serverNow: 1, data: state }, u: 1,
      });
    }

    this.audio.setScene(zdef);
    this.chamber = null;
    // A fresh zone streams its scatter cells in over the next few seconds, so the frames
    // right after a transition are the slowest ones the player will see in it. Judging the
    // tier on those would demote everyone on every zone change.
    this.governor.busy(ZONE_SETTLE);
    this._onResize();
    this.emit('zone', { zoneId, zone: zdef, mode: this.mode });
    onProgress(0.9, '同步世界…');
  }

  _weaponOf(charId) {
    const inst = this.player?.characters?.[charId];
    return inst?.weapon || inst?.equipped?.weapon || null;
  }

  /* --------------------------------------------------------------- lifecycle -- */

  start() {
    if (this._running) return;
    this._running = true;
    this.input.setEnabled(true);
    this._last = performance.now();
    const frame = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(frame);
      const now = performance.now();
      // Clamp dt: a long stall (tab switch, shader compile) must not teleport the
      // character or drain a whole stamina bar in one step.
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      try {
        this._frame(dt);
      } catch (e) {
        console.error('[frame]', e);
        // One bad frame should not end the session; a repeating one will be
        // obvious in the console rather than a black screen.
      }
    };
    this._raf = requestAnimationFrame(frame);
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    this.input.setEnabled(false);
  }

  setPaused(v) {
    this._paused = v;
    this.input.setEnabled(!v);
  }

  /**
   * The player picked a tier. Their pick is the ceiling the governor works under, and it
   * is what gets saved; anything the governor does afterwards is a runtime concession and
   * is deliberately not written back to `settings.quality`.
   */
  setQuality(q) {
    this.settings.quality = q;
    this.governor.setCeiling(q);
    this._applyQuality(q);
  }

  /* ------------------------------------------------------------- time of day -- */

  /**
   * Where the in-game day is right now, and the sky that goes with it.
   *
   * Derived from the wall clock (`worldClock`) rather than stored, so every client in a session
   * agrees on the hour with nothing on the wire and 单机 agrees with 多人 for free. A day is 24
   * real minutes.
   */
  worldTime() {
    const dayT = this._timePin === null ? worldClock(Date.now()).dayT : this._timePin;
    return { dayT, ...clockLabel(dayT), pinned: this._timePin !== null };
  }

  /**
   * Freeze the sky at an hour, or hand it back to the clock with `null`.
   *
   * This is a product control (设置 has a 时间 row) *and* the lever every screenshot probe needs:
   * with the sun moving 15° a real minute, two frames a minute apart are not comparable, and every
   * calibrated pixel threshold in `tour` / `prop-check` / `vault-cam` / `motion-check` was measured
   * at the authored noon. `daylight()` is built so 12:00 reproduces the authored values exactly, so
   * a probe that pins noon sees the frame it was calibrated on.
   */
  setWorldTime(h, day = 0) {
    const t = h === null || h === undefined ? null : dayTFromHours(h);
    if (h !== null && h !== undefined && t === null) return false;
    this._timePin = t;
    this._dayPin = Number.isFinite(day) ? Math.max(0, Math.floor(day)) : 0;
    this.settings.worldTime = t;
    this._daylightAt = -1;              // force a re-apply on the next frame
    this._weatherAt = -1;
    this._updateDaylight(true);
    this._updateWeather(true);
    return true;
  }

  /**
   * The epoch the world is being drawn at: the wall clock, or the pinned hour on the pinned
   * forecast day. One function so the sky and the weather can never disagree about *when* it is.
   */
  worldEpoch() {
    return this._timePin === null ? Date.now() : (this._dayPin + this._timePin) * DAY_MS;
  }

  /** Whether the sky is following the clock (`null`) or pinned, for the settings row and probes. */
  get worldTimePin() { return this._timePin; }

  /**
   * Recompute the sky if the hour has moved enough to matter.
   *
   * Every 1/240th of a day — six in-game minutes, six real seconds — rather than per frame: the
   * phase is ~30 float ops and a dozen `setRGB`s, which is nothing, but `Sky.applyDaylight` also
   * writes light colours that the renderer hashes into its lights cache, and doing that 60 times a
   * second for a value that changes by 0.4% is pointless. Six in-game minutes is well under the
   * threshold where a step is visible.
   */
  _updateDaylight(force = false) {
    if (!this.world) return;
    const t = this._timePin === null ? worldClock(Date.now()).dayT : this._timePin;
    if (!force && Math.abs(t - this._daylightAt) < 1 / 240) return;
    this._daylightAt = t;
    const zdef = zoneById(this.zoneId);
    if (!zdef?.sky) return;
    const ph = daylight(zdef.sky, t);
    this.phase = ph;
    this.world.applyDaylight(ph);
    // The ground effects are painted on that ground, so they take the same hour: a telegraph disc
    // lit for noon photographed at 23:00 as a luma-154 plate over a luma-20 world.
    this.vfx?.applyDaylight(ph);
    // The HUD clock is a *state*, not a notification, so it is published as one: kept on the game
    // (`this.clock`) for whoever mounts mid-day and emitted for whoever is already listening.
    // `enterZone` calls this with force, so a zone change re-writes it too — including the note
    // that says why an underground zone's sky does not move.
    this.clock = {
      label: ph.label, hour: ph.hour, minute: ph.minute,
      name: timeOfDayName(ph), night: ph.night, day: ph.day, sunColor: ph.sunColor,
      elev: Math.round((ph.elevation * 180) / Math.PI),
      pinned: this._timePin !== null,
      note: zdef.indoor ? '洞内不见天色' : this._timePin !== null ? '时间已固定' : '',
    };
    this.emit('clock', this.clock);
  }

  /**
   * Recompute the weather if the forecast has moved. Twice a second rather than every frame (it is
   * a handful of lerps plus three uniform writes) but far more often than the sky's six seconds,
   * because a storm crossfades over 30 s and a six-second step in the particle count is visible as
   * the rain arriving in five lumps.
   */
  _updateWeather(force = false) {
    if (!this.world) return;
    const now = this.worldEpoch();
    if (!force && Math.abs(now - this._weatherAt) < 500) return;
    this._weatherAt = now;
    const zdef = zoneById(this.zoneId);
    if (!zdef) return;
    const w = weatherAt(zdef, now);
    this.weather = w;
    this.world.applyWeather(w);
    // The wind bed used to pick its filter with `zone.weather === 'blizzard'` — a string compared
    // against an object, so neither branch was ever taken. Now it is told what is falling.
    this.audio.setWeather(w);
    this.emit('weather', w);
  }

  /** Turn 自动画质 on or off; off pins the renderer at the saved tier. */
  setAutoQuality(on) {
    this.settings.autoQuality = !!on;
    this.governor.setEnabled(!!on);
    if (!on && this.quality !== this.settings.quality) this._applyQuality(this.settings.quality);
  }

  /**
   * Push a tier into the subsystems. Expensive — `World.setQuality` drops every resident
   * scatter cell — so it must never be called per frame, only on a real change.
   */
  _applyQuality(q) {
    if (q === this.quality) return;
    this.quality = q;
    this.r.applyQuality(q);
    this.vfx.setQuality(q);
    this.world?.setQuality(q);
    this._onResize();
  }

  _onResize() {
    this.r.resize();
    this.overlay.resize(this.r.width, this.r.height);
    // Point sprites are sized in world units; convert with the vertical FOV so a
    // spark is the same physical size regardless of window height.
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) * 0.5;
    this.camera.__vfxScale = (this.r.height * 0.5) / Math.tan(halfFov);
  }

  /* -------------------------------------------------------------- the frame -- */

  _frame(dt) {
    const t = (this._time += dt);
    setToonTime(t);
    this.input.update(dt);

    // Panel hotkeys keep working while a panel is open — pressing M again has to
    // close the map, and B has to swap the inventory in for it — so they are read
    // outside the pause gate. Everything that moves or fights is inside it.
    this._handlePanelKeys();
    if (!this._paused) {
      this._handleKeys(dt);
      this._handleMouse(dt);
    }

    // Camera before the player so click rays use this frame's view matrix, and
    // player movement is relative to where the camera actually is.
    const drag = this.input.takeDrag();
    if (drag && (drag.x || drag.y)) {
      const s = this.settings.sensitivity;
      const yaw0 = this.rig.yaw, pitch0 = this.rig.pitch;
      this.rig.orbit(drag.x * s, drag.y * s * (this.settings.invertY ? -1 : 1));
      // What the guide credits is the rotation the rig *applied*, measured here rather than
      // from the drag: pitch clamps at the poles and yaw wraps at ±π, and the rig also turns
      // itself when locking on. Only this difference is the player's own doing.
      let dy = this.rig.yaw - yaw0;
      if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
      this.tutorial.orbit(Math.abs(dy) + Math.abs(this.rig.pitch - pitch0));
    }
    const wheel = this.input.takeWheel();
    if (wheel) this.rig.zoom(wheel);

    this.me.update(dt, t, this.input, this.rig, this.actors);
    // After the move, so what the guide measures is ground actually covered — a wish that
    // walked the player into a wall counts for nothing.
    this.tutorial.sample(this.me.x, this.me.z);

    this.rig.setAiming(this.aiming);
    this.rig.update(dt, { x: this.me.x, y: this.me.y, z: this.me.z }, this.me.height, this.me.speed > 0.5);

    const win = this.socket.sampleWindow();
    this.actors.update(dt, t, win);
    for (const up of this.actors.takePhaseUps()) this._onBossPhase(up);
    if (win) {
      const you = (win.b.data.players || []).find((p) => p.id === this.playerId);
      this.me.applyServer(you, win.b.data);
      this._syncChamber(win.b.data.chamber);
    }

    // Before the world updates: the sky's uniforms and the sun's direction are what the world's
    // own update (water, shadow camera, fog) reads this frame.
    this._updateDaylight();
    this._updateWeather();
    this.world.update(dt, t, this.me.x, this.me.y, this.me.z, this.camera);
    this.vfx.update(dt, this.camera);
    this.audio.update(dt, this);

    this._updatePrompt();
    this._drawLabels();

    // Networking last, so the state we send is the state we just rendered.
    // sendInput owns the rate limit (CLIENT_SEND_RATE) and the idle-heartbeat
    // logic, so it must be called every frame: gating it here as well would make
    // its accumulator advance in frame-sized steps only on the frames it saw,
    // quartering the real send rate.
    this.socket.sendInput(dt, this.me.netSnapshot());
    this.socket.ping(dt);

    this.emit('frame', { dt, t });
    this.r.render(dt);

    // One sample per completed measurement bucket (~500 ms), never per frame: see
    // Renderer.perfSeq. The governor may call back into `_applyQuality` from here, which
    // is safe — the frame is finished, and it settles itself before deciding again.
    if (this.r.perfSeq !== this._perfSeq) {
      this._perfSeq = this.r.perfSeq;
      this.governor.sample(this.r.msFrame, performance.now());
    }

    // Edge-triggered input is per frame by definition: without this every press
    // stays "just pressed" for the rest of the session and a single tap on M
    // toggles the map sixty times a second.
    this.input.endFrame();
  }

  /* ------------------------------------------------------------- input: keys -- */

  // Panels are emitted rather than handled so the UI owns its own stacking and
  // can decide that Escape closes the topmost thing. Escape and Enter are not
  // here: the UI consumes those before the input layer ever sees them.
  // The action's name *is* the panel's name (`PANEL_ACTIONS` is derived from the 界面 group of
  // `ACTION_INFO`), so this is one loop rather than one line per panel — a list that had to be
  // edited in lockstep with three others and silently produced dead keys when it was not.
  _handlePanelKeys() {
    const i = this.input;
    for (const action of PANEL_ACTIONS) {
      if (i.justPressed(action)) this.emit('togglePanel', { panel: action });
    }
  }

  _handleKeys(dt) {
    const i = this.input;

    if (i.justPressed('emote')) this.socket.emote('wave');
    // Sitting needs no server round trip: `currentAction()` already ships ACTION.sit with the
    // next snapshot, which is the same path every other pose takes to the other players.
    if (i.justPressed('sit')) this.me.setSitting(!this.me.sitting);

    for (let s = 0; s < 4; s++) {
      if (i.justPressed(`char${s + 1}`)) this.switchTo(s);
    }

    if (i.justPressed('skill')) this.me.useSkill(this.actors);
    if (i.justPressed('burst')) this.me.useBurst(this.actors);
    if (i.justPressed('dodge')) this.me.dash();
    if (i.justPressed('interact')) this._interactNearest();
    if (i.justPressed('aim')) this.setAiming(!this.aiming);
  }

  /* ------------------------------------------------------------ input: mouse -- */

  _handleMouse(dt) {
    const i = this.input;

    // Hold-to-charge. takeClicks() deliberately does not report long holds, so
    // the charge is measured here and resolved on release.
    // How long the hold has to last is the character's own number now (`charged.chargeTime`);
    // a bow draws for a second, a sword flicks in a third of one.
    const need = this.me.chargeTime;
    if (i.leftDown) {
      this._leftHold += dt;
      if (this._leftHold > need) {
        // A claymore keeps spinning while the button is down, paying `charged.spinDrain`
        // stamina per second, and ends the moment that runs out. Every other weapon
        // resolves its charge on release, below.
        if (this.me.heldSpin) {
          if (this.me.drainSpin(dt)) this.me.chargedAttack(this.actors, { spin: true });
          else { this._leftHold = 0; this.emit('charging', null); }
        } else this.emit('charging', { t: this._leftHold });
      }
    } else if (this._leftWasDown) {
      if (this._leftHold > need) {
        if (!this.me.heldSpin) this.me.chargedAttack(this.actors);
        this.emit('charging', null);
      }
      this._leftHold = 0;
    }
    this._leftWasDown = i.leftDown;

    for (const c of i.takeClicks()) {
      if (c.button === 0) this._leftClick(c);
      else if (c.button === 2) this._rightClick(c);
    }

    // Auto-attack: once an enemy is clicked we keep swinging while it lives and
    // stays in reach. Without this, mouse-only play is a clicking contest.
    if (this.autoAttack && this.settings.autoAttack && this.target) {
      const e = this.actors.enemyById(this.target);
      if (!e || !e.alive) {
        this._clearTarget();
      } else {
        const d = Math.hypot(e.x - this.me.x, e.z - this.me.z);
        if (d <= this._attackRange(e) && !i.leftDown) this.me.attack(this.actors);
      }
    }
  }

  /**
   * How close the auto-attack has to be to swing at `e`, metres.
   *
   * `me.attackReach` is the sim's own melee sweep (`playerAttackShape(...).hit`, slack included)
   * or the weapon's authored range for a bow or a catalyst, and the target's hitbox is added
   * because that is what the sweep compares against. It used to be `weaponReach + 0.6` — 1.6 m
   * short of where a hit actually lands, so 点击攻击 walked the player into the enemy's chest
   * before swinging — and a flat 26 m for every ranged weapon, which is neither of the two
   * authored ranges (34 m for a bow, 12 m for a catalyst).
   */
  _attackRange(e) {
    return this.me.attackReach + (e?.actor?.def?.hitbox?.r ?? 0.7);
  }

  _pointerRay(c) {
    this.raycaster.setFromCamera(new THREE.Vector2(c.ndcX, c.ndcY), this.camera);
    return this.raycaster;
  }

  _leftClick(c) {
    if (!this.me.alive) return;
    const ray = this._pointerRay(c);

    // 1) An enemy under the cursor wins: attacking is the most common intent.
    const hit = this.actors.pickEnemy(ray, 90);
    if (hit) {
      this.setTarget(hit.id);
      this.autoAttack = true;
      const d = Math.hypot(hit.e.x - this.me.x, hit.e.z - this.me.z);
      const reach = this._attackRange(hit.e);
      if (d > reach) {
        this.me.setGoal(hit.e.x, hit.e.z, 'approach', null, { sprint: c.double, reach });
      }
      else { this.me.clearGoal(); this.me.attack(this.actors); }
      this.overlay.clickRing(c.x, c.y);
      return;
    }

    // 2) A downed teammate under the cursor: go pick them up. Ahead of the ground branch
    // because a body lying in the grass is over walkable ground by definition, so 点哪走哪
    // would otherwise eat every click aimed at it.
    const friend = this.actors.pickPlayer(ray, 90, (p) => !p.alive);
    if (friend) {
      this._clearTarget();
      const d = Math.hypot(friend.p.x - this.me.x, friend.p.z - this.me.z);
      if (d <= REVIVE_RANGE) this._reviveFriend(friend.id);
      else this.me.setGoal(friend.p.x, friend.p.z, 'rescue', { playerId: friend.id });
      this.overlay.clickRing(c.x, c.y);
      return;
    }

    // 3) An interactable *under the cursor*: the chest's lid, the NPC's chest, the spire of a
    // waypoint. This has to be a ray test rather than the ground test below, because the ground
    // point under a body is not where the body is: aiming at an NPC's torso 15 m away lands the
    // ground hit metres behind them, and aiming at a node sitting on a rise lands it metres
    // short — tools/mouse-check.mjs measured 8.9 m short of a gather node it had clicked
    // squarely, and the click walked past it instead of harvesting. Genshin's rule is the one
    // players expect: clicking the thing is clicking the thing.
    const pick = this.world.pickInteractable(ray, 90);
    if (pick) {
      this._clearTarget();
      const d = Math.hypot(pick.x - this.me.x, pick.z - this.me.z);
      if (d <= INTERACT_RANGE) this._interact(pick);
      else this.me.setGoal(pick.x, pick.z, 'interact', pick, { sprint: c.double });
      this.overlay.clickRing(c.x, c.y);
      return;
    }

    // 4) An interactable near the clicked ground point: clicking the grass *beside* a chest
    // should still open it, which is the forgiving half of the same gesture.
    const g = this.me.raycastGround(ray, 320);
    if (!g) return;
    const it = this.world.nearestInteractable(g.x, g.y, g.z);
    if (it) {
      this._clearTarget();
      const d = Math.hypot(it.x - this.me.x, it.z - this.me.z);
      if (d <= INTERACT_RANGE) this._interact(it);
      else this.me.setGoal(it.x, it.z, 'interact', it, { sprint: c.double });
      this.overlay.clickRing(c.x, c.y);
      return;
    }

    // 5) Plain ground: walk there. A double click sprints there — the same sprint Shift asks
    // for, paid for out of the same stamina bar (`LocalPlayer.goalSprint`).
    this._clearTarget();
    this.me.setGoal(g.x, g.z, 'move', null, { sprint: c.double });
    // Only this branch is 点哪走哪. Clicking an enemy or a chest above also moves the
    // character, and marking those would tick the step off for a player who has never
    // clicked open ground.
    this.tutorial.mark('clickMove');
    this.overlay.clickRing(c.x, c.y);
    this.vfx.ring(g.x, g.y + 0.06, g.z, 0xffe9a8, 0.85, 0.45, 0.8);
    if (c.double) this.socket.mark(g.x, g.z);
  }

  _rightClick(c) {
    // A right *click* (not a drag) cancels: drop the target, stop moving.
    this._clearTarget();
    this.me.clearGoal();
    if (this.aiming) this.setAiming(false);
  }

  setAiming(v) {
    if (this.aiming === v) return;
    this.aiming = v;
    this.me.aiming = v;
    this.emit('aiming', { on: v });
  }

  /* -------------------------------------------------------------- targeting -- */

  setTarget(id) {
    this.target = id;
    this.me.setTarget(id);
    const e = this.actors.enemyById(id);
    this.emit('target', e ? {
      id, name: e.actor.def.name, level: e.level,
      hp: e.hp, maxHp: e.maxHp, aura: e.aura, boss: !!e.actor.def.boss,
    } : null);
  }

  _clearTarget() {
    if (!this.target) { this.autoAttack = false; return; }
    this.target = null;
    this.autoAttack = false;
    this.me.setTarget(null);
    this.emit('target', null);
  }

  /* ------------------------------------------------------------ interaction -- */

  /**
   * The interaction prompt, rebuilt whenever its *text* would change — not only when the player
   * walks up to a different thing.
   *
   * The old form bailed out on `near === this.prompt.entry`, which is the common case and looks
   * like an obvious optimisation, but it also froze the text for as long as the player stood
   * still: light a monument and the bar keeps offering 「共鸣元素方碑 风之试炼 0/3」 until you walk
   * away and back, on the exact step where the count is the feedback. `tools/puzzle-check.mjs`
   * photographed that stale bar under a monument that was already glowing. Recomputing the
   * strings costs a switch and a three-element scan, and only while something is in range.
   */
  _updatePrompt() {
    const it = this.world.nearestInteractable(this.me.x, this.me.y, this.me.z);
    const near = it && Math.hypot(it.x - this.me.x, it.z - this.me.z) <= INTERACT_RANGE ? it : null;
    if (!near) {
      if (!this.prompt) return;
      this.prompt = null;
      this.emit('prompt', null);
      return;
    }
    const next = this._promptText(near);
    const cur = this.prompt;
    if (cur && cur.entry === near && cur.txt === next.txt && cur.sub === next.sub
      && !!cur.disabled === !!next.disabled) return;
    this.prompt = { entry: near, ...next };
    this.emit('prompt', this.prompt);
  }

  _promptText(it) {
    switch (it.type) {
      case 'chest': return {
        txt: it.done ? '空宝箱' : '开启宝箱',
        // A locked chest says what unlocks it. Before this the prompt read the same as any
        // other chest and the 403 was the first the player heard of the condition.
        sub: it.done ? '已开启' : this._chestLock(it) || it.poi.tier,
        disabled: it.done,
      };
      case 'waypoint': return { txt: '启用传送锚点', sub: it.name || '' };
      case 'statue': return { txt: '与七天神像共鸣', sub: ELEMENTS[it.poi.element]?.name || '' };
      // A puzzle is a ring of monuments and the prompt is on one of them, so it names the
      // monument and how many are left. `it.poi.kind` / `it.poi.count` were authored on every
      // puzzle in the game and read by nobody until this — the old prompt read `it.poi.puzzle`,
      // a key no zone has ever carried, so the subtitle was always empty.
      case 'puzzle': {
        const def = PUZZLE_KINDS[it.poi.kind] || PUZZLE_KINDS.elementalMonument;
        const { lit, total } = this.world.puzzleProgress(it.puzzleId || it.id);
        return {
          txt: it.done ? `${def.name}已${def.verb}` : `${def.verb}${def.name}`,
          sub: total > 1 ? `${it.poi.name || '谜题'} ${lit}/${total}` : (it.poi.name || ''),
          disabled: it.done,
        };
      }
      case 'dungeon': return { txt: '进入秘境', sub: zoneById(it.poi.target)?.name || '' };
      // A lit campfire becomes the kitchen: cooking needs a place in the world, and
      // walking to a fire is a far better gate than a keybind nobody discovers.
      case 'warmth': return it.unlocked
        ? { txt: '在篝火边烹饪', sub: '料理' }
        : { txt: '点燃篝火', sub: '驱散严寒' };
      // 「有新任务」 beats the role, and it is the *same* predicate the talk route uses to decide
      // what to hand over (`offerableQuest`) — a prompt with its own idea of the rule either
      // promises a quest the server refuses or stays silent about one it would give. Without it
      // a 传说任务 waiting at the grocer's is invisible: nothing in the world says an NPC who has
      // been standing there for ten chapters now has something to say.
      // The subtitle is `npcRoleName`, never `npc.role`: the slug used to print raw here, so the
      // guild receptionist's prompt read 「凯瑟琳 · guild」 — the same bug the dialogue header had.
      case 'npc': return {
        txt: `与${it.name}交谈`,
        sub: offerableQuest(it.npc, this.player) ? '有新任务' : npcRoleName(it.npc.role),
      };
      case 'gather': return { txt: '采集', sub: itemName(it.kind) };
      default: return { txt: '交互', sub: '' };
    }
  }

  _interactNearest() {
    const it = this.prompt?.entry
      || this.world.nearestInteractable(this.me.x, this.me.y, this.me.z);
    if (!it) return;
    if (Math.hypot(it.x - this.me.x, it.z - this.me.z) > INTERACT_RANGE) {
      this.me.setGoal(it.x, it.z, 'interact', it);
      return;
    }
    this._interact(it);
  }

  async _interact(it) {
    if (this._interacting) return;
    this._interacting = true;
    this.me.actor.animator.play('gather');
    // Past the range test and the re-entrancy guard, so this is a real interaction —
    // whichever of F, a click, or walking over on a click order got here.
    this.tutorial.mark('interact');
    this.socket.interact(it.type, it.id);
    try {
      switch (it.type) {
        case 'chest': await this._openChest(it); break;
        case 'puzzle': await this._solvePuzzle(it); break;
        case 'warmth':
          if (it.unlocked) { this.emit('togglePanel', { panel: 'cook', open: true }); break; }
          await this._unlock(it);
          break;
        case 'waypoint': case 'statue': await this._unlock(it); break;
        case 'dungeon': this._enterDungeon(it); break;
        case 'npc': await this._talk(it); break;
        case 'gather': await this._gather(it); break;
        default: break;
      }
    } catch (e) {
      this.toast(errorText(e), 'bad');
    } finally {
      this._interacting = false;
    }
  }

  async _openChest(it) {
    if (it.done) return;
    const res = await api.openChest(this.zoneId, it.id);
    it.done = true;
    it.prop.open?.();
    this.world.markOpened(it.id);
    this.vfx.loot(it.x, it.y + 0.7, it.z, it.poi.tier === 'luxurious' ? 5 : it.poi.tier === 'precious' ? 4 : 3);
    this.audio.sfx('chest');
    this._applyPlayer(res.player);
    this._reportLoot(res.loot, it);
    this._reportExplore(res.explore);
    this._applyQuestUpdates(res.questUpdates);
  }

  /**
   * Say what a REST reward paid.
   *
   * `_onLoot` is the same job for kills, which arrive over the socket; a chest answers its own
   * call, and the reply carries a whole `publicPlayer` (inventory and equipment included), so
   * `_applyPlayer` has already credited it — nothing is added to the bag here.
   *
   * This method was *called and never defined*: `_openChest` has ended with
   * `this._reportLoot(res.loot, it)` since chests were written, and `class Game` has no mixin
   * and no base class, so every chest open threw a TypeError straight into `_interact`'s
   * `catch` — a red error toast on a chest that had in fact just paid out, no loot line at all,
   * and (because the throw skipped the next statement) `_applyQuestUpdates` never ran, so
   * 「开启宝箱」 quest counters sat still until something else refetched them. 44 probes and a
   * REST-level chest test could not see it: the server was right, and nothing photographed the
   * toast a chest makes. `tools/chest-cam.mjs` now does.
   *
   * `it` is the interaction entry, and it is optional: the note is drawn at the chest when
   * there is one, and `overlay.note` draws nothing when that point is off screen, which is
   * why the same text also goes to the toast rail and the chat log.
   */
  _reportLoot(loot, it = null) {
    if (!loot) return;
    // The route merges the currencies into `items` (`{...loot.items, mora, primogem}`), so
    // naming `loot.mora` separately here would print 摩拉 twice — the bug `_onLoot`'s comment
    // records. A zero primogem field is still sent, hence the falsy skip.
    const names = [];
    for (const [id, n] of Object.entries(loot.items || {})) {
      if (!n) continue;
      names.push(`${itemIcon(id)}${itemName(id)}${n > 1 ? ` ×${n}` : ''}`);
    }
    let best = 0;
    for (const e of [...(loot.artifacts || []), ...(loot.weapons || [])]) {
      names.push(`${equipIcon(e)}${equipName(e)}`);
      best = Math.max(best, e.rarity || 4);
    }
    if (!names.length) return;
    const text = names.join('、');
    // One chat line with everything (the log scrolls, so length is free) and a short toast:
    // a luxurious chest pays six or seven rows and the rail would swallow the screen.
    this.emit('loot', { items: loot.items, text });
    this.toast(names.length > 3 ? `获得 ${names.slice(0, 2).join('、')} 等 ${names.length} 项` : `获得 ${text}`,
      best >= 5 ? 'gold' : 'good');
    if (it) this.overlay.note(it.x, (it.y ?? 0) + 1.1, it.z, `+${names[0]}`, 'good');
  }

  /**
   * 探索度 moved.
   *
   * The percentage itself is never computed here: the server derives it from the world-progress
   * rows it just wrote (`shared/data/exploration.js`) and sends `{ pct, gained, found, total }`,
   * so the number in this toast is the same number the map panel prints and the same one the
   * 踏遍此地 achievement reads. `explore` is null for a 秘境 (a dungeon's progress is 层数/星数),
   * and `gained` is 0 for anything that found nothing new — both mean silence.
   *
   * `claimable` rides along on the same block, so the discovery that crossed 60% says the reward
   * is waiting instead of leaving a player to open the map on the off chance. It is a *list* of
   * thresholds rather than a boolean because a save that predates the ladder can have four steps
   * waiting at once, and 「探索奖励 ×4」 is the number that gets somebody to press the button.
   */
  _reportExplore(explore) {
    if (!explore) return;
    const zone = zoneById(this.zoneId)?.name || '';
    const ready = explore.claimable?.length || 0;
    const prize = ready
      ? `探索奖励可领取${ready > 1 ? ` ×${ready}` : ''}（M 键 → 领取）`
      : '';
    if (!(explore.gained > 0)) return;
    if (explore.pct >= 100) {
      this.banner('探索完成', `${zone} 探索度 100%${prize ? ` · ${prize}` : ''}`);
    } else {
      this.toast(`探索度 ${explore.pct}%（+${explore.gained}%）${prize ? ` · ${prize}` : ''}`, 'good');
    }
  }

  /**
   * Light one monument of a puzzle. The reward only lands when the last one is lit — the
   * server decides that, because it is the side that knows which monuments are already lit
   * (world progress), and it is the side paying.
   */
  async _solvePuzzle(it) {
    if (it.done) return;
    const puzzleId = it.puzzleId || it.id;
    const res = await api.solvePuzzle(this.zoneId, puzzleId, it.node?.id);
    it.done = true;
    it.prop.setLit?.(true);
    const color = ELEMENTS[it.node?.element || it.poi.element]?.color ?? 0xffe9a8;
    this.vfx.pillar(it.x, it.y, it.z, color, 1.4, 12, 1.2);
    this.audio.sfx('puzzle');
    this._applyPlayer(res.player);
    if (!res.solved) {
      // Not done: say how many are left, and say it *at the monument*, because the player is
      // standing at one of several and has to know where to walk next.
      this.overlay.note(it.x, it.y + 1.6, it.z, `${res.lit}/${res.total}`, 'good');
      this.toast(`已点亮 ${res.lit}/${res.total}`, 'info');
      return;
    }
    this.world.markPuzzleSolved(puzzleId);
    this.toast(`谜题解开 +${res.reward.primogem}原石`, 'gold');
    // After the reward, not before it: a solved puzzle pays first and is a discovery second.
    // (The partial branch above returned already; its `explore.gained` is 0 in any case,
    // because a lit monument is `{lit}` and only `{solved}` counts.)
    this._reportExplore(res.explore);
    this._applyQuestUpdates(res.questUpdates);
    // Chests gated on this puzzle become openable; the prop shows it immediately — and a toast
    // says so as well, because the note is anchored *at the chest* and `overlay.note` draws
    // nothing when that point is off screen. `tools/puzzle-check.mjs` caught exactly that: the
    // ring is solved from whichever monument is last, the luxurious chest is eight metres away
    // behind the camera, and the reward the puzzle exists for went unannounced.
    let unlocked = 0;
    for (const p of this.world.pois) {
      if (p.poi.requires !== `puzzle:${puzzleId}`) continue;
      unlocked++;
      this.overlay.note(p.x, p.y + 1.4, p.z, '已解锁', 'good');
    }
    if (unlocked) this.toast(`${unlocked} 个宝箱已解锁`, 'good');
  }

  /**
   * Why a chest cannot be opened yet, or '' when it can.
   *
   * Both forms of `requires` are read from the same world progress the server checks, so the
   * prompt cannot disagree with the 403 — the dungeon reward chests need every chamber cleared.
   */
  _chestLock(it) {
    const req = it.poi.requires;
    if (!req) return '';
    if (req === 'clear') {
      const zone = zoneById(this.zoneId);
      const floors = (zone?.chambers || []).map((c) => c.floor);
      const done = floors.filter((f) => (this.player?.abyss?.[this.zoneId]?.[f]?.stars ?? 0) > 0);
      return done.length >= floors.length && floors.length ? '' : `需通关秘境 ${done.length}/${floors.length}`;
    }
    if (req.startsWith('puzzle:')) {
      const solved = this.world.poiById(req.slice(7))?.done;
      return solved ? '' : '需先解开谜题';
    }
    return '暂时无法开启';
  }

  async _unlock(it) {
    const res = await api.unlock(this.zoneId, it.id);
    it.unlocked = true;
    it.prop.setLit?.(true);
    this.vfx.teleport(it.x, it.y, it.z, true);
    this.audio.sfx('unlock');
    if (res.first) {
      const label = it.type === 'statue' ? '神像共鸣' : it.type === 'warmth' ? '篝火点燃' : '锚点激活';
      this.banner(label, it.name || '');
      if (res.reward?.primogem) this.toast(`+${res.reward.primogem} 原石`, 'gold');
    }
    this._applyPlayer(res.player);
    this._reportExplore(res.explore);
    this._applyQuestUpdates(res.questUpdates);
    if (it.type === 'waypoint') this.emit('togglePanel', { panel: 'map', open: true });
  }

  /**
   * Pick a teammate up. Free, unlike standing yourself up — the price is walking over.
   *
   * Guarded on their state rather than sent blind: the gateway answers `not_downed` to a body
   * that someone else already reached, and an error toast for winning a race reads like a bug.
   */
  _reviveFriend(playerId) {
    const p = this.actors.playerById(playerId);
    if (!p || p.alive) return;
    if (Math.hypot(p.x - this.me.x, p.z - this.me.z) > REVIVE_RANGE) {
      this.me.setGoal(p.x, p.z, 'rescue', { playerId });
      return;
    }
    this.me.ry = Math.atan2(p.x - this.me.x, p.z - this.me.z);
    this.me.actor.playAction('gather');
    this.socket.revive(playerId);
    this.vfx.heal(p.x, p.y + 1, p.z, 1);
    this.audio.sfx('unlock');
    this.toast(`正在救援 ${p.nickname || '队友'}`, 'good');
  }

  _enterDungeon(it) {
    const targetId = it.poi.target;
    const zdef = zoneById(targetId);
    if (!zdef) return;
    if (!canEnterZone(zdef, this.player.adventureRank)) {
      this.toast(`需要冒险等阶 ${zoneEntryRank(zdef)}`, 'bad');
      return;
    }
    this.emit('confirmDungeon', {
      zone: zdef,
      accept: () => this.enterZone(targetId),
    });
  }

  /**
   * Pick a gather node.
   *
   * The node disappears immediately on the server's ack rather than optimistically:
   * a flower that vanishes and then comes back because the request was rejected
   * (already picked on another device, out of range) is worse than a quarter-second
   * of delay.
   */
  async _gather(it) {
    if (it.done) return;
    const res = await api.gather(this.zoneId, it.id, it.kind);
    this.world.markGathered(it.id);
    if (this.prompt?.entry === it) { this.prompt = null; this.emit('prompt', null); }
    const glow = it.color ?? 0xa8e06a;
    this.vfx.ring(it.x, it.y + 0.1, it.z, glow, 0.7, 0.5, 0.7);
    this.vfx.loot(it.x, it.y + 0.4, it.z, 2);
    this.audio.sfx('pickup');
    for (const [id, n] of Object.entries(res.items || {})) {
      this.toast(`${itemDef(id)?.icon || ''}${itemName(id)} ×${n}`, 'good');
      this.overlay.note(it.x, it.y + 0.9, it.z, `+${itemName(id)} ×${n}`, 'good');
    }
    this._applyPlayer(res.player);
    this._applyQuestUpdates(res.questUpdates);
  }

  async _talk(it) {
    const res = await api.talk(this.zoneId, it.id);
    this.me.faceDirection(it.x - this.me.x, it.z - this.me.z, 1);
    // Turn the NPC to the player: being addressed by someone's back is worse
    // than no dialogue at all.
    it.rig.group.rotation.y = Math.atan2(this.me.x - it.x, this.me.z - it.z);
    it.animator.play('idle');
    this.emit('dialogue', {
      npc: res.npc, started: res.started,
      lines: res.npc.lines || [res.npc.greeting || '……'],
    });
    if (res.started) this.banner('新任务', res.started.name);
    this._applyPlayer(res.player);
    this._applyQuestUpdates(res.questUpdates);
  }

  /* ------------------------------------------------------- zone transitions -- */

  async enterZone(zoneId, at = null, { follow = null } = {}) {
    if (this._pendingZone) return;
    this._pendingZone = zoneId;
    this.emit('loading', { zone: zoneById(zoneId), on: true });
    this.setPaused(true);
    try {
      const done = new Promise((resolve, reject) => {
        const off = this.socket.on(S2C.ZONE_STATE, (d) => { off(); offErr(); resolve(d); });
        const offErr = this.socket.on(S2C.ERROR, (d) => {
          // Only zone-entry failures matter here; anything else is unrelated.
          // The follow errors belong here too: a friend who logged out between the
          // panel's REST snapshot and this message is the *common* case, and without
          // them the player watches a loading screen for the full 20 s timeout.
          if (['bad_zone', 'rank_too_low', 'no_player',
            'not_friends', 'friend_offline', 'friend_is_solo', 'world_full',
            'solo_no_party'].includes(d.error)) {
            off(); offErr(); reject(Object.assign(new Error(d.error), { code: d.error }));
          }
        });
        setTimeout(() => { off(); offErr(); reject(new Error('timeout')); }, 20000);
      });
      this.socket.joinZone(zoneId, at, follow);
      const d = await done;
      this.player.zone = d.zone;
      this.stats = d.stats || this.stats;
      this.mode = d.mode || this.mode;
      await this._buildZone(d.zone, d.you, d.state, (f, m) => this.emit('loading', { progress: f, message: m, on: true }));
      const zdef = zoneById(d.zone);
      this.banner(zdef?.name || d.zone, zdef?.subtitle || '');
    } catch (e) {
      this.toast(errorText(e), 'bad');
    } finally {
      this._pendingZone = null;
      this.emit('loading', { on: false });
      this.setPaused(false);
    }
  }

  /**
   * Co-op: land in a friend's world, next to them.
   *
   * `zone` is only a hint for the loading screen — the server resolves the friend's
   * *current* zone and shard and answers with whichever it actually joined, and
   * `enterZone` builds from that answer, so a friend who walked into a different
   * region a second ago still works.
   */
  async joinFriend(playerId, zone = null) {
    if (this.mode === 'solo') { this.toast(errorText({ code: 'solo_no_party' }), 'bad'); return; }
    await this.enterZone(zone || this.zoneId, null, { follow: Number(playerId) });
  }

  /** Fast travel through a waypoint: REST moves the save, then we rejoin. */
  async teleport(zoneId, poiId) {
    try {
      const res = await api.teleport(zoneId, poiId);
      this._applyPlayer(res.player);
      this.vfx.teleport(this.me.x, this.me.y, this.me.z, true);
      this.audio.sfx('teleport');
      if (zoneId === this.zoneId) {
        // Same zone: no rebuild needed, just move and tell the server.
        const y = this.world.heightAt(res.pos.x, res.pos.z);
        this.me.teleportTo(res.pos.x, y, res.pos.z);
        this.rig.snapToFocus({ x: res.pos.x, y, z: res.pos.z }, this.me.height);
        this.socket.joinZone(zoneId, { x: res.pos.x, z: res.pos.z });
        this.vfx.teleport(res.pos.x, y, res.pos.z, false);
      } else {
        await this.enterZone(zoneId, { x: res.pos.x, z: res.pos.z });
      }
      this._applyQuestUpdates(res.questUpdates);
    } catch (e) {
      this.toast(errorText(e), 'bad');
    }
  }

  startChamber(floor) {
    this.socket.startChamber(floor);
  }

  _syncChamber(c) {
    const before = this.chamber;
    this.chamber = c || null;
    if (!c && before) this.emit('chamber', { state: 'end' });
    else if (c && (!before || before.floor !== c.floor || before.state !== c.state)) {
      this.emit('chamber', c);
    } else if (c) {
      this.emit('chamberTick', c);
    }
  }

  /* -------------------------------------------------------- party switching -- */

  switchTo(slot) {
    const charId = this.party[slot];
    if (!charId || slot === this.activeSlot) return;
    if ((this.stats[charId]?.maxHp ?? 0) > 0 && this._hpOf(charId) <= 0) {
      this.toast('该角色已倒下', 'bad');
      return;
    }
    this.socket.switchChar(charId);
    // Optimistic: the model swap is the whole point of pressing the key, and the
    // server confirms with a switchOk action a frame or two later.
    this.activeSlot = slot;
    this.me.setCharacter(charId, this._weaponOf(charId));
    this.vfx.cast(this.me.x, this.me.y, this.me.z, CHARACTERS[charId]?.element || 'physical', 2.2);
    this.audio.sfx('switch');
    // Below the two early returns: a switch to a downed character, or to the slot already on
    // field, taught nothing.
    this.tutorial.mark('switch');
    this.emit('party', { party: this.party, activeSlot: slot });
  }

  /**
   * Fold a build the player just changed over HTTP into the running game.
   *
   * The client twin of the server's `publishStats`. Showing the new number in the panel is
   * only half of it: the simulation keeps its own copy of the stat block and the roster,
   * and in 单机 mode that copy lives in this browser, where nothing else would ever push to
   * it (`LocalSocket.applyBuild`). Online the gateway has already applied the change and
   * announces it with `statsRefresh`, which lands here as well — so the two modes realign
   * the active slot and the model through the same lines. Panels reach this through
   * `_act`, deliberately the only door, so no future panel action can forget the step.
   */
  applyBuild(stats, party = null, charId = null) {
    if (stats) this.stats = stats;
    if (party?.length) this.party = party.slice();
    // `Socket` has no `applyBuild`: online the entity belongs to the gateway.
    const res = this.socket.applyBuild?.(this.stats, this.party) || null;
    // Dropping the character you were controlling has to move the model, not just the
    // roster — the authority (local entity or gateway) says who is on field now.
    const want = charId || res?.charId || this.party[this.activeSlot] || this.party[0];
    const slot = this.party.indexOf(want);
    this.activeSlot = slot >= 0 ? slot : 0;
    const active = this.party[this.activeSlot];
    if (active && this.me && this.me.charId !== active) {
      this.me.setCharacter(active, this._weaponOf(active));
    }
    this.emit('party', { party: this.party, activeSlot: this.activeSlot });
    return this.party;
  }

  _hpOf(charId) {
    const win = this.socket.latest();
    const byChar = win?.hpByChar;
    if (byChar && byChar[charId] != null) return byChar[charId];
    return this.stats[charId]?.maxHp ?? 1;
  }

  /* --------------------------------------------------------------- labels ---- */

  _drawLabels() {
    if (!this.settings.showNames) { this.overlay.beginLabels(); this.overlay.endLabels(); return; }
    this.overlay.beginLabels();

    for (const [id, e] of this.actors.enemies) {
      if (!e.alive) continue;
      const boss = !!e.actor.def.boss;
      this.overlay.label({
        x: e.x, y: e.y + e.actor.height + 0.42, z: e.z,
        name: e.actor.def.name, level: e.level,
        hp: e.hp, maxHp: e.maxHp, shield: e.shield,
        // Which element the shield is made of decides who in the party should be hitting it
        // (`shieldBreakMul`), so the bar is drawn in that element's colour instead of the one
        // gold every shield used to share. Read off the same def the server spawned from —
        // nothing new on the wire.
        shieldElement: e.actor.def.shield?.element,
        aura: e.frozen ? 'ice' : e.aura,
        kind: 'enemy', boss,
        // Which phase a boss is in, and how many it has. The banner announces the change for
        // three and a half seconds; the plate is what a player who looked away can read, and
        // the ticks on its bar are where the next change will happen.
        phase: boss ? (e.phase || 1) : 0,
        phases: boss ? (e.actor.def.phases || 1) : 0,
        maxDist: boss ? 160 : 95,
      });
    }
    for (const [id, e] of this.actors.players) {
      this.overlay.label({
        x: e.x, y: e.y + e.actor.height + 0.5, z: e.z,
        name: e.nickname || '旅行者', level: null,
        hp: e.hp, maxHp: e.maxHp, shield: e.shield,
        // Another player's shield is made of something too, and in co-op knowing that the
        // person you are healing is wearing a cryo shard is the same information the enemy
        // nameplate gives about a mage.
        shieldElement: e.shieldElement,
        kind: 'player', maxDist: 120,
      });
    }
    for (const n of this.world.npcs) {
      this.overlay.label({
        x: n.x, y: n.y + n.height + 0.4, z: n.z,
        name: n.name, kind: 'npc', maxHp: 0, maxDist: 42,
      });
    }
    for (const p of this.world.pois) {
      if (p.type === 'chest' && p.done) continue;
      this.overlay.label({
        x: p.x, y: p.y + p.height + 0.35, z: p.z,
        name: p.name || this._promptText(p).txt, kind: 'poi', maxHp: 0,
        maxDist: p.type === 'waypoint' || p.type === 'statue' ? 130 : 46,
      });
    }
    this.overlay.endLabels();
  }

  /* -------------------------------------------------------- server → client -- */

  _bindLocal() {
    this.me.on('arrived', ({ kind, payload }) => {
      if (kind === 'interact' && payload) this._interact(payload);
      else if (kind === 'approach' && this.target) this.me.attack(this.actors);
      else if (kind === 'rescue' && payload?.playerId) this._reviveFriend(payload.playerId);
    });
    this.me.on('nostamina', () => this.emit('nostamina'));
    this.me.on('noenergy', () => this.toast('元素能量不足', 'bad'));
    this.me.on('cooldown', ({ which, left }) => {
      this.emit('cooldownDenied', { which, left });
      this.audio.sfx('error');
    });
    this.me.on('footstep', () => this.audio.sfx('step'));
    // The local player is the listener, so none of these take `at`: they are at
    // distance zero by definition and must not be attenuated by their own position.
    this.me.on('swing', ({ charged }) => {
      this.audio.sfx('swing', { gain: charged ? 1.3 : 1 });
      this.tutorial.mark('attack');
    });
    this.me.on('jump', () => this.audio.sfx('jump'));
    // Grabbing a wall is a scuff of boots on rock, and it is also the moment the climb step is
    // earned — the event fires from the branch that actually entered the climb, never from the
    // key, so pushing at a slope that turns out to be walkable teaches nothing and marks nothing.
    this.me.on('climb', ({ on }) => {
      this.audio.sfx('step', { gain: on ? 1.1 : 0.8 });
      if (on) this.tutorial.mark('climb');
    });
    // Louder the further you fell: the 3.5 m/s floor is a step off a rock, 20 is a
    // plunge attack, and one flat thud for both is what makes falling feel weightless.
    this.me.on('land', ({ speed }) => this.audio.sfx('land', { gain: Math.min(1.6, speed / 9) }));
    // The guide listens to the LocalPlayer rather than to `_handleKeys`, because these four
    // events fire *after* the stamina, energy and cooldown checks: they mean the move
    // actually happened.
    this.me.on('dash', () => {
      this.audio.sfx('dash');
      this.tutorial.mark('dash');
    });
    // Every cast is two sounds: the element, and the character. `voice` is the pitch of
    // their 发声 (110 Hz for 伊格纳, 300 for 塞莉丝) and was authored on all fourteen of them
    // and read by nothing — so every character cast a spell in silence.
    this.me.on('skillCast', () => {
      this.audio.sfx('skill');
      this.audio.sfx('effort', { pitch: this.me.def.voice });
      this.tutorial.mark('skill');
    });
    this.me.on('burstCast', () => {
      this.audio.sfx('burst');
      this.audio.sfx('effort', { pitch: this.me.def.voice, gain: 1.3, long: true });
      this.tutorial.mark('burst');
    });
    this.me.on('down', () => {
      this._deaths++;
      this.emit('down', { deaths: this._deaths });
      // No 「按 R」: R is `aim` in KEYMAP and always was, so that sub-line taught a key that
      // does nothing while the mouse-driven panel underneath it is the actual answer.
      this.banner('角色倒下', '在面板上选择复苏方式，或等待队友救援');
      this.audio.sfx('down');
    });
    this.me.on('revived', () => {
      this.emit('revived');
      this.vfx.heal(this.me.x, this.me.y + 1, this.me.z, 1);
    });
    // 护盾升起. `vfx.shieldUp(x, y, z, element)` had been written, took an element, and had no
    // caller anywhere — which was consistent, because until now a shield had no element to give
    // it. The edge is detected on the authoritative shield value, so 结晶 (a shard picked up
    // mid-combo), a skill shield and 圣咏回响's overheal shield all announce themselves the same
    // way, in 单机 and 多人 alike.
    // No toast: a geo party crystallises every few seconds and this would be a wall of them. The
    // shell is in the shield's colour and the HUD bar is too, which is the same information
    // without a queue.
    this.me.on('shield', ({ element }) => {
      this.vfx.shieldUp(this.me.x, this.me.y, this.me.z, element || 'earth');
      // Unpositioned: it is my own shield, so it is not a thing happening somewhere in the
      // world. The shell is a half-second flash on a character the camera may be looking past.
      this.audio.sfx('shield');
    });
  }

  _bindSocket() {
    const s = this.socket;

    s.on(S2C.DAMAGE, (d) => this._onDamage(d));
    s.on(S2C.ENEMY_DIED, (d) => this._onEnemyDied(d));
    s.on(S2C.ENEMY_ATTACK, (d) => this._onEnemyAttack(d));
    s.on(S2C.PLAYER_ACTION, (d) => this._onPlayerAction(d));
    s.on(S2C.LOOT, (d) => this._onLoot(d));
    s.on(S2C.CHAT, (d) => this.emit('chat', d));
    s.on(S2C.QUEST_UPDATE, (d) => this._applyQuestUpdates(d.updates));
    s.on(S2C.CHAMBER, (d) => this._onChamber(d));
    s.on(S2C.PLAYER_DOWN, (d) => this._onPlayerDown(d));
    s.on(S2C.REVIVED, (d) => this._onRevived(d));
    s.on(S2C.BUFF, (d) => this._onBuff(d));
    s.on(S2C.PARTY, (d) => this._onParty(d));
    s.on(S2C.PLAYER_LEAVE, (d) => {
      // Named before the actor goes away: the remote player entry is the only place the
      // client still knows who that id was. The nickname lives on the entry `_syncPlayers`
      // builds (`e.nickname`), not on the `CharacterActor` it wraps.
      const who = this.actors.players.get(Number(d.playerId))?.nickname;
      this.actors.removePlayer(d.playerId);
      if (who) this.emit('chat', { channel: 'sys', body: `${who} 离开了此区域` });
    });
    s.on(S2C.PLAYER_JOIN, (d) => {
      // The payload is `{ player: <serialized entity> }`, and `PlayerEntity.serialize`
      // uses short keys — `n` for the nickname, `id` for the player id. Reading
      // `d.nickname`/`d.playerId` meant both were undefined, so every arrival printed
      // "undefined 进入了此区域" and the "is that me" guard never actually fired.
      const pl = d.player || d;
      const nick = pl.n ?? pl.nickname;
      if (Number(pl.id ?? d.playerId) !== this.playerId && nick) {
        this.emit('chat', { channel: 'sys', body: `${nick} 进入了此区域` });
      }
    });
    s.on(S2C.ENEMY_SPAWN, (d) => {
      const e = d.enemy;
      if (!e) return;
      // This is not "a monster appeared in front of you": `updateCamps` spawns a whole camp
      // as soon as any player is within 110 m, and `AOI_RADIUS` streams it at 130 m, so most
      // of these events are the world loading in around someone who is still walking towards
      // it. Anything further than a stone's throw gets no effect at all — the enemy is simply
      // already there when the player arrives, which is what the player expects to see.
      const far = !this.me || Math.hypot(e.x - this.me.x, e.z - this.me.z) > 40;
      if (far) return;
      const def = ENEMIES[e.t];
      // `physical` is 0xd8d8d8 — a white flash, which is the one colour that reads as a
      // magic effect rather than as a body pushing dust aside. Machines and hilichurls get
      // dust; only an aura'd enemy gets its element.
      const el = e.au || def?.element;
      const col = el && el !== 'physical' ? (ELEMENTS[el]?.color ?? 0xd8c8a8) : 0xd8c8a8;
      this.vfx.spawnIn(e.x, e.y, e.z, col, (def?.hitbox?.h ?? 1.8) / 1.8, def?.hitbox?.r ?? 0.5);
    });
    s.on(S2C.EMOTE, (d) => this._onEmote(d));
    s.on(S2C.MARK, (d) => this._onMark(d));
    s.on(S2C.ERROR, (d) => this._onError(d));

    s.on('close', () => this.emit('connection', { state: 'down' }));
    s.on('reconnect', () => this.emit('connection', { state: 'reconnecting' }));
    s.on('open', () => this.emit('connection', { state: 'up' }));
    s.on('fatal', (d) => this.emit('fatal', d));
  }

  /**
   * A boss crossed an hp threshold and changed phase.
   *
   * The simulation has always done this (`Entity.damage`: the phase index steps up, the
   * creature is staggered for 1.2 s, `chooseMove` opens the rest of its move pool and
   * `zoneInstance` shortens its windups by 15-40%), and `ph` has been on the wire since the
   * first snapshot — with nothing on the client reading it. So the fight silently got faster
   * and the player was given no reason: not a sound, not a line of text, not a light.
   *
   * Four channels on purpose, because the three things the player has to do about it are
   * different: *stop attacking* for a moment (the wind-up is now shorter than your combo),
   * *use the stagger* (1.2 s of free hits, right now), and *expect the new moves*.
   */
  _onBossPhase({ name, phase, phases, x, y, z, height }) {
    const top = y + (height || 2) * 0.9;
    this.emit('bossPhase', { name, phase, phases });
    this.overlay.note(x, top, z, `第 ${phase} 阶段`, 'bad');
    // A shockwave the size of the creature, in its own element's white-hot centre: the same
    // shape as a shield breaking, which is the other "the fight just changed" beat.
    this.vfx.shell(x, y + (height || 2) * 0.45, z, 0xfff0d0, Math.max(2.2, (height || 2) * 0.9), 0.6);
    this.vfx.ring(x, y + 0.06, z, 0xffb13b, Math.max(3, (height || 2) * 1.4), 0.8, 1.6);
    this.audio.sfx('bossPhase', { at: [x, y, z] });
  }

  _onDamage(d) {
    const showNum = this.settings.showDamage;
    if (d.target === 'enemy') {
      const e = this.actors.enemyById(d.id);
      const x = d.x ?? e?.x ?? 0, y = d.y ?? (e ? e.y + e.actor.height * 0.7 : 0), z = d.z ?? e?.z ?? 0;
      if (e) {
        e.actor.flash(1);
        // A shield eats part of the hit, so the number on screen is not what the body lost:
        // predicting with the full amount drained the bar and let the next snapshot 50 ms
        // later put it back, which on a 3200-point shield is a bar that shakes for ten
        // seconds and then finally starts moving.
        e.hp = Math.max(0, e.hp - Math.max(0, d.amount - (d.absorbed || 0)));
      }
      if (showNum) this.overlay.damage({ ...d, x, y, z });
      const dir = e ? new THREE.Vector3(e.x - this.me.x, 0, e.z - this.me.z).normalize() : null;
      this.vfx.hit(x, y, z, d.element, d.crit, dir);
      if (d.reaction) {
        this.vfx.reaction(x, y, z, d.reaction, d.element);
        // A reaction is worth its own sound: it is the one combat event whose whole payoff is
        // a multiplier the player cannot see, and until now the loudest thing in the game's
        // damage model was silent. Positioned, and played for *anyone's* reaction — a teammate
        // vaporizing across the camp is exactly the cue that says "keep applying 水".
        this.audio.sfx(REACTION_SFX[d.reaction], { at: [x, y, z] });
        this.emit('reaction', { kind: d.reaction, name: REACTIONS[d.reaction]?.name });
      }
      if (d.shieldBroke) {
        this.vfx.shell(x, y, z, 0xffffff, 1.6, 0.4);
        this.overlay.note(x, y + 0.6, z, '护盾破碎', 'good');
        // Not gated on `d.by`: a mage's shield going down is the moment the whole party has
        // been waiting for, and whoever landed the last hit, everyone should hear it. Positioned,
        // so a shield breaking across the camp is quieter than the one in front of you.
        this.audio.sfx('shieldBreak', { at: [x, y, z] });
      } else if (d.shieldMul && d.by === this.playerId) {
        // 元素护盾 teaches itself or it is not a mechanic. The shield bar drains at
        // `shieldMul` × the rate, but a bar that moves twice as fast is not something a player
        // can read while fighting, so the hit says which of the three cases it was. Only for
        // my own hits: eight players' worth of these would be a wall of text.
        if (d.shieldMul >= 1.5) this.overlay.note(x, y + 0.6, z, `破盾 ×${d.shieldMul.toFixed(1)}`, 'good');
        else if (d.shieldMul < 1) this.overlay.note(x, y + 0.6, z, '同元素 · 护盾吸收', 'weak');
        else this.overlay.note(x, y + 0.6, z, '护盾抵挡', 'weak');
      }
      // 弱点. The number is already three times bigger, but a number alone reads as a lucky
      // crit; the mechanic only teaches itself if the shot says *why* it was big. Anchored
      // on the weak point rather than on the damage number's own height, because on a 3.6 m
      // machine those are a metre apart and the point is to show where to aim next time.
      if (d.weak) {
        const wy = e ? e.y + (e.actor.def.weakspot?.offset?.[1] ?? 0) : y;
        this.vfx.shell(x, wy, z, 0xffd15c, 1.1, 0.3);
        this.overlay.note(x, wy + 0.4, z, '弱点', 'good');
        if (d.by === this.playerId && this.settings.cameraShake) this.rig.addShake(0.22);
      }
      if (d.by === this.playerId) {
        // Positioned even though it is my own hit: a melee swing lands inside the flat
        // 2 m of the rolloff, but an arrow lands where the arrow landed.
        this.audio.sfx(d.crit ? 'crit' : 'hit', { at: [x, y, z] });
        if (this.settings.cameraShake) this.rig.addShake(d.crit ? 0.16 : 0.07);
      }
      // Any hit we land is a target worth keeping, so a stray click that landed on
      // a different enemy does not silently retarget the auto-attack.
      if (d.by === this.playerId && !this.target && e?.alive) this.setTarget(d.id);
      return;
    }

    // target === 'player'
    const isMe = d.id === this.playerId;
    const p = isMe ? this.me : this.actors.playerById(d.id);
    const px = isMe ? this.me.x : p?.x ?? 0;
    const py = (isMe ? this.me.y : p?.y ?? 0) + (isMe ? this.me.height : p?.actor.height ?? 1.7) * 0.8;
    const pz = isMe ? this.me.z : p?.z ?? 0;
    const heal = d.kind === 'heal' || d.amount < 0;
    // 护盾吸收. The server now reports a hit the shield ate entirely (it used to emit nothing at
    // all, so a shielded fight was completely silent), and `amount` is what got *through* — so a
    // fully blocked hit must not print a bare 「0」, and the character must not scream and flinch
    // for a hit they did not feel.
    const shielded = (d.absorbed || 0) > 0;
    const blocked = shielded && Math.round(d.amount) <= 0;

    if (showNum && !blocked) this.overlay.damage({ ...d, x: px, y: py, z: pz, taken: !heal });
    if (isMe && shielded) {
      const col = ELEMENTS[this.me.shieldElement]?.color ?? 0xd8c890;
      if (d.shieldBroke) {
        this.vfx.shell(px, py, pz, 0xffffff, 1.7, 0.45);
        this.overlay.note(px, py + 0.5, pz, '护盾破碎', 'weak');
        this.audio.sfx('shieldBreak');
      } else {
        this.vfx.shell(px, py, pz, col, 1.25, 0.32);
        if (d.shieldMul >= 1.5) this.overlay.note(px, py + 0.5, pz, `护盾被克制 ×${d.shieldMul.toFixed(1)}`, 'weak');
        else if (d.shieldMul < 1) this.overlay.note(px, py + 0.5, pz, `同元素 · 护盾抵挡 ×${d.shieldMul.toFixed(1)}`, 'good');
        else if (blocked) this.overlay.note(px, py + 0.5, pz, '护盾抵挡', 'good');
      }
    }
    // 反应也会打在玩家自己身上. `zoneInstance` runs the player's own aura through the same
    // `resolveReaction` and puts the key on the wire for `target: 'player'` damage too — a
    // hilichurl shaman 感电ing a wet character is the same mechanic as the player's own combo —
    // and this branch used to drop `d.reaction` on the floor, so the multiplier that just
    // doubled the hit had no picture, no sound and no name anywhere on screen. Outside the
    // heal/blocked split because a reaction lands whether or not the shield ate the damage.
    if (d.reaction) {
      this.vfx.reaction(px, py, pz, d.reaction, d.element);
      this.audio.sfx(REACTION_SFX[d.reaction], { at: [px, py, pz] });
      // Only my own: the toast is a HUD line about what happened to *me*, and eight
      // players' worth of reaction toasts is a scrolling wall during any group fight.
      if (isMe) this.emit('reaction', { kind: d.reaction, name: REACTIONS[d.reaction]?.name });
    }
    if (heal) {
      this.vfx.heal(px, py, pz, Math.abs(d.amount));
      if (isMe) this.audio.sfx('heal');
    } else if (blocked) {
      // One sound, and it is *not* `hurt`: a hit that never reached the character must not
      // sound like one, but total silence reads as "the game dropped the attack". Muffled and
      // short, so a mage tanking a hilichurl camp behind 磐岩壁垒 is a series of thuds rather
      // than a series of screams.
      if (isMe) this.audio.sfx('shieldBlock');
      // Nothing else: no red screen flash, no camera shake, no flinch, and no `hurt` event —
      // `hud.flashHurt()` hangs off that one and a red vignette for a hit that never reached the
      // character is exactly the wrong signal. The shell above is the whole feedback, which is
      // the point of standing behind a shield.
    } else {
      if (isMe) {
        this.r.flash(d.element === 'physical' ? 0xff4040 : (ELEMENTS[d.element]?.color ?? 0xff4040), 0.3);
        this.emit('hurt', { amount: d.amount, element: d.element, kind: d.kind });
        if (this.settings.cameraShake) this.rig.addShake(Math.min(0.5, d.amount / 900 + 0.1));
        this.audio.sfx('hurt');
        this.me.actor.flash(1);
        // The body reacts, not just the shader. Until now taking a hit was a red screen flash,
        // a colour flash on the material and a camera shake, while the character kept walking
        // through it — the `hit` clip existed, was in the ACTION enum, and nothing ever played
        // it. `flinch` owns the rate limit and the "not during a cast" rule.
        this.me.flinch();
      } else if (p) {
        p.actor.flash(1);
        // Remote players flinch off the same event. Their base pose comes from the next
        // snapshot, so this is an overlay that plays out and hands control straight back.
        if (p.actor.animator && !p.actor.animator.busy) p.actor.playAction('hit');
      }
      this.vfx.hit(px, py, pz, d.element, false, null);
    }
  }

  _onEnemyDied(d) {
    const e = this.actors.killEnemy(d.id);
    const el = e?.aura || 'physical';
    this.vfx.death(d.x, d.y + (e?.actor.height ?? 1.6) * 0.5, d.z, el, !!(d.boss || d.elite));
    this.audio.sfx(d.boss ? 'bossDie' : 'die', { at: [d.x, d.y, d.z] });
    if (this.target === d.id) this._clearTarget();
    if (d.boss) this.banner('讨伐成功', e?.actor.def.name || '');
  }

  _onEnemyAttack(d) {
    const e = this.actors.enemyById(d.id);
    if (!e) return;
    const mv = ATTACK_MOVES[d.move];
    if (d.phase === 'windup') {
      // Telegraph: without a visible wind-up, every hit taken feels unfair. Its shape is the
      // move's own authored geometry (`attackShape`), which is also what `resolveEnemyAttack`
      // tests — so stepping out of the drawn shape really is stepping out of the damage. Before
      // that it was one ring sized off the *creature's* hitbox for all seventeen moves, so a
      // 2.4 m jab and a 6 m spike field looked identical and the only way to learn a boss's
      // moves was to die to each of them.
      const el = mv?.element || e.actor.def.element || 'physical';
      this.vfx.telegraph(attackShape(mv, e.actor.def), e.x, e.z, d.ry ?? e.ry,
        ELEMENTS[el]?.color ?? 0xff6a2b, Math.max(0.3, d.duration),
        (x, z) => this.world.heightAt(x, z));
    } else {
      e.attacking = d.move;
      // A camp streams in at 110 m and every one of its monsters keeps swinging at
      // whoever woke it: without the distance rolloff this is the whole shard's combat
      // played at your ear, which is the audible twin of the fast-travel pillar that
      // used to fire for every spawn.
      this.audio.sfx('enemyAttack', { at: [e.x, e.y + 1, e.z] });
      // A heavy blow shakes the camera — but only for someone close enough to be in it. The
      // same rolloff argument as the sound above: `mv.shake` is authored on four moves (slam
      // 0.6, chargeRoll 0.5, divebomb 1.0) and until now was read by nothing at all, so the
      // tyrant's dive landed with no more weight than a slime's nudge.
      if (mv?.shake && this.settings.cameraShake) {
        const reach = attackShape(mv, e.actor.def).hit;
        const dist = Math.hypot(e.x - this.me.x, e.z - this.me.z);
        const near = 1 - clamp((dist - reach) / reach, 0, 1);   // full inside it, nothing at 2×
        if (near > 0) this.rig.addShake(mv.shake * near);
      }
    }
  }

  _onPlayerAction(d) {
    const mine = d.playerId === this.playerId;

    switch (d.action) {
      case 'switchOk':
        if (mine) {
          // Authoritative confirmation; realign in case the optimistic switch was
          // for a different slot than the server accepted.
          const slot = this.party.indexOf(d.charId);
          if (slot >= 0) this.activeSlot = slot;
          this.me.setCharacter(d.charId, this._weaponOf(d.charId));
          this.emit('party', { party: this.party, activeSlot: this.activeSlot });
        }
        return;

      case 'correction':
        if (mine) this.me.correct(d.x, d.y, d.z);
        return;

      case 'rooted':
        if (mine) {
          this.me.rooted = Math.max(this.me.rooted, d.duration || 0.5);
          this.me.clearGoal();
          this.emit('rooted', d);
        }
        return;

      case 'statsRefresh':
        if (mine) {
          // `party`/`charId` ride along because the roster can change under the player:
          // dropping the active character in the team panel makes the authority switch
          // for them, and the HUD would keep drawing the old one.
          this.applyBuild(d.stats, d.party, d.charId);
          if (d.levels?.length) this._onLevels(d.levels);
          this.emit('playerState', { player: this.player, stats: this.stats });
        }
        return;

      case 'interact': {
        if (!mine) {
          const p = this.actors.playerById(d.playerId);
          if (p) p.actor.playAction('gather');
        }
        return;
      }

      case 'useItem': {
        // The gateway is authoritative about the stack, so trust `left` rather than
        // decrementing locally — a rejected use never gets here at all.
        if (mine) {
          if (this.player?.inventory) this.player.inventory[d.itemId] = d.left ?? 0;
          this.me?.actor?.playAction('gather');
          this.audio.sfx('pickup');
          this.emit('playerState', { player: this.player, stats: this.stats });
        } else {
          const p = this.actors.playerById(d.playerId);
          if (p) p.actor.playAction('gather');
        }
        return;
      }

      default: break;
    }

    // Remote combat: the local player already played its own prediction.
    if (mine) return;
    const p = this.actors.playerById(d.playerId);
    const el = d.element || 'physical';
    const x = d.x ?? p?.x ?? 0, y = (d.y ?? p?.y ?? 0), z = d.z ?? p?.z ?? 0;
    switch (d.action) {
      case 'normal':
      case 'charged':
        if (p) {
          p.actor.playAction(d.action === 'charged' ? 'charged' : `attack${(d.combo % 5) + 1}`);
          p.autoLoco = false;
        }
        this.audio.sfx('swing', { at: [x, y, z] });
        break;
      // An ally's cast draws the same boundary the player's own does, from `charId` — the packet
      // used to carry a `radius` that this end then defaulted to 3 while the sim tested 4.
      case 'skill': {
        if (p) { p.actor.playAction('skill'); p.actor.pulseAura(0.8, 1); }
        const sh = playerAttackShape('skill', CHARACTERS[d.charId]);
        const yaw = Array.isArray(d.dir) ? Math.atan2(d.dir[0], d.dir[2]) : (d.ry ?? p?.ry ?? 0);
        if (sh) {
          this.vfx.strike(sh, x, z, yaw, ELEMENTS[el]?.color ?? 0xffffff, 0.5,
            (gx, gz) => this.world.heightAt(gx, gz), 0.95);
        }
        this.vfx.cast(x, y, z, el, sh?.radius ?? SKILL_RADIUS);
        this.audio.sfx('skill', { at: [x, y, z] });
        break;
      }
      case 'burst': {
        if (p) { p.actor.playAction('burst'); p.actor.pulseAura(1.5, 2); }
        const sh = playerAttackShape('burst', CHARACTERS[d.charId]);
        if (sh) {
          this.vfx.strike(sh, x, z, d.ry ?? p?.ry ?? 0, ELEMENTS[el]?.color ?? 0xffffff, 0.75,
            (gx, gz) => this.world.heightAt(gx, gz));
        }
        this.vfx.burst(x, y, z, el, sh?.radius);
        this.audio.sfx('burst', { at: [x, y, z] });
        break;
      }
      default: break;
    }
  }

  _onLoot(d) {
    // `d.items` already contains the mora: `grantKillRewards` builds one map (`{...loot.items,
    // mora}`) and pays it in a single write, so naming `d.mora` a second time is what made the
    // loot line read 「获得 史莱姆凝液、摩拉 ×50、摩拉 ×50」. It is only added here for a
    // producer that sends the two separately.
    const items = { ...(d.items || {}) };
    if (d.mora && !items.mora) items.mora = d.mora;
    const names = [];
    for (const [itemId, n] of Object.entries(items)) {
      names.push(`${itemName(itemId) || itemId}${n > 1 ? ` ×${n}` : ''}`);
    }
    const e = this.actors.enemyById(d.enemyId);
    if (e) {
      this.vfx.loot(e.x, e.y + 0.6, e.z, 3);
      this.audio.sfx('loot', { at: [e.x, e.y + 0.6, e.z] });
    }
    if (names.length) {
      this.emit('loot', { items: d.items, mora: d.mora, xp: d.xp, assist: !!d.assist, text: names.join('、') });
    }
    if (d.player) this._applyPlayer(d.player, true);
    this._creditLoot({ items: d.items }, d.player);
    if (d.ar?.levels?.length || d.ar?.leveled) this._onAdventureRank(d.ar);
    if (d.levels) this._onLevels(d.levels);
  }

  /**
   * Fold a gateway-side drop into the local save.
   *
   * REST replies carry a whole `publicPlayer` (inventory and equipment included), so
   * `_applyPlayer` is enough for those; the gateway sends only the currency fields,
   * because a full save on every kill is 50 kB down the socket. The consequence was
   * that anything dropped in a live shard was invisible in the bag until the page was
   * reloaded — the server had it, the panel was reading a boot-time snapshot.
   *
   * `applied` is whatever player document came with the event: if it has an `inventory`
   * (single-player builds these events out of the REST reply, which is a whole save)
   * then the drop is already in it and adding it here would double every count.
   */
  _creditLoot(drop, applied = null) {
    if (!drop || !this.player || applied?.inventory) return;
    for (const [id, n] of Object.entries(drop.items || {})) {
      if (id === 'mora' || id === 'primogem') continue;   // currencies live on `player`
      if (id === 'wishTicket') this.player.wishTicket = (this.player.wishTicket || 0) + n;
      else if (this.player.inventory) this.player.inventory[id] = (this.player.inventory[id] || 0) + n;
    }
    if (drop.artifacts?.length || drop.weapons?.length) {
      this.player.equipment = this.player.equipment || [];
      for (const e of [...(drop.artifacts || []), ...(drop.weapons || [])]) {
        this.player.equipment.push({ ...e, equippedBy: null });
      }
    }
    this.emit('playerState', { player: this.player, stats: this.stats });
  }

  _onLevels(levels) {
    for (const l of levels || []) {
      if (!l || !l.charId) continue;
      if (l.leveled || l.level > (this.player?.characters?.[l.charId]?.level ?? 0)) {
        if (this.player?.characters?.[l.charId]) this.player.characters[l.charId].level = l.level;
        if (l.charId === this.party[this.activeSlot]) {
          this.vfx.levelUp(this.me.x, this.me.y, this.me.z);
          this.audio.sfx('levelUp');
        }
        this.toast(`${CHARACTERS[l.charId]?.name || l.charId} 升至 Lv.${l.level}`, 'good');
      }
    }
  }

  _onAdventureRank(ar) {
    if (!ar) return;
    // `progression.grantAdventureXp` calls the field `adventureRank`; only some REST
    // responses shorten it to `rank`. Reading just one of them put "冒险等阶 undefined"
    // on the banner for every rank-up earned in combat.
    const rank = ar.adventureRank ?? ar.rank;
    if (rank && this.player) this.player.adventureRank = rank;
    if (ar.leveled || ar.rankUp) {
      this.banner(`冒险等阶 ${rank}`, '世界等级提升，新的区域已开放');
      this.vfx.levelUp(this.me.x, this.me.y, this.me.z);
      this.audio.sfx('rankUp');
    }
    this.emit('playerState', { player: this.player, stats: this.stats });
  }

  _onChamber(d) {
    switch (d.state) {
      case 'start': {
        // The disorder is the one thing a player has to know *before* the first swing —
        // it is the difference between bringing a claymore and bringing an ice carry — so
        // it goes in the opening banner, not only in the HUD chip.
        const bits = [`限时 ${Math.round(d.timeLimit)} 秒`, `${d.enemies} 名敌人`];
        if (d.waves > 1) bits.push(`共 ${d.waves} 波`);
        if (d.disorder) bits.push(d.disorder.hint);
        this.banner(d.disorder ? `第 ${d.floor} 间 · ${d.disorder.name}` : `第 ${d.floor} 间`,
          bits.join(' · '));
        this.audio.sfx('chamberStart');
        break;
      }
      case 'wave':
        this.toast(`第 ${d.wave}/${d.waves} 波 · ${d.enemies} 名敌人`, 'gold');
        this.audio.sfx('chamberStart');
        break;
      case 'cleared':
        this.banner('挑战成功', `${'★'.repeat(d.stars)}${'☆'.repeat(3 - d.stars)} · ${d.time.toFixed(1)} 秒`);
        this.audio.sfx('victory');
        // Nothing to claim from here. Whichever host ran the fight pays for it: the
        // gateway calls `progression.grantChamberClear` itself and follows this event
        // with `state:'reward'`, and in 单机 the host is this tab, which posts
        // `/api/world/chamber` from `localSocket._grantChamber`. This used to fire the
        // REST call in online mode *as well*, which is one fight read by two writers —
        // and now that a clear also spends resin for its drop, the second call would
        // charge the player twice for one run.
        break;
      case 'failed':
        this.banner('挑战失败', d.reason === 'wiped' ? '队伍全员倒下' : `剩余敌人 ${d.remaining}`);
        this.audio.sfx('defeat');
        break;
      case 'reward':
        this.emit('chamberReward', d);
        if (d.reward?.primogem) this.toast(`+${d.reward.primogem} 原石`, 'gold');
        if (d.resin?.short) this.toast(`树脂不足，未获得秘境掉落（需 ${d.resin.cost}）`, 'bad');
        this._applyPlayer(d.player, true);
        this._creditLoot(d.drops, d.player);
        this._applyQuestUpdates(d.questUpdates);
        break;
      default: break;
    }
    this.emit('chamber', d);
  }

  _onPlayerDown(d) {
    if (d.playerId === this.playerId) return;   // handled by LocalPlayer.applyServer
    const p = this.actors.playerById(d.playerId);
    if (p) p.actor.playAction('down');
    this.emit('chat', { channel: 'sys', body: `${p?.nickname || '队友'} 倒下了` });
  }

  _onRevived(d) {
    if (d.playerId === this.playerId) {
      // A respawn moves the *simulation's* entity; this client predicts its own position, so
      // without an explicit teleport the only thing that would move us is the anti-teleport
      // correction on the next input packet — i.e. the body stays lying in the middle of the
      // camp that killed it for a moment, then slides. `anchor` is only present on the
      // respawn paths (auto timer and the panel button); a teammate's revive has no position.
      if (Number.isFinite(d.x) && Number.isFinite(d.z)) {
        this.me.teleportTo(d.x, d.y ?? this.me.y, d.z);
        this.vfx.teleport(d.x, d.y ?? this.me.y, d.z, true);
      }
      this.emit('revived', d);
      this.vfx.heal(this.me.x, this.me.y + 1, this.me.z, 1);
      const where = d.anchorName ? `在${d.anchorName}恢复` : '在最近的锚点恢复';
      this.banner('重新振作', d.anchor || d.auto ? where : '队友将你救起');
      return;
    }
    const p = this.actors.playerById(d.playerId);
    if (p) this.vfx.heal(p.x, p.y + 1, p.z, 1);
  }

  /**
   * A food buff landed on someone. Only the local player's buffs are tracked —
   * a teammate's attack bonus is their business, and the HUD has no room for it.
   *
   * `duration` arrives in seconds rather than an absolute time because the server's
   * tick clock and the browser's clock have no shared origin; the client re-anchors
   * to its own `now` and lets the tiny latency error be a rounding artefact on a
   * five-minute timer.
   */
  _onBuff(d) {
    if (d.playerId !== this.playerId) return;
    const now = performance.now() / 1000;
    if (d.kind === 'gear') return this._onGearBuff(d, now);
    this.buffs = this.buffs.filter((b) => b.kind !== 'food' && b.endsAt > now);
    this.buffs.push({
      kind: 'food', item: d.item, name: d.name,
      atkPct: d.atkPct || 0, critRate: d.critRate || 0,
      endsAt: now + (d.duration || 180), duration: d.duration || 180,
    });
    const parts = [];
    if (d.atkPct) parts.push(`攻击 +${Math.round(d.atkPct * 100)}%`);
    if (d.critRate) parts.push(`暴击率 +${Math.round(d.critRate * 100)}%`);
    this.toast(`${d.name}：${parts.join('，')}`, 'gold');
    this.vfx.heal(this.me.x, this.me.y + 1, this.me.z, 0.6);
    this.emit('buffs', { buffs: this.buffs });
  }

  /**
   * A weapon passive or 4-piece set effect fired (`shared/src/world/procs.js`).
   *
   * These arrive far more often than meals — one per skill cast, per kill, per reaction —
   * so they get no toast and no particle burst, only the same countdown chip food uses.
   * Keyed by `tag` (the *source* of the effect) and replaced rather than appended, so
   * killing five enemies leaves one 余烬裂斩 chip reading ×2, not five chips.
   */
  _onGearBuff(d, now) {
    this.buffs = this.buffs.filter((b) => b.tag !== d.tag && b.endsAt > now);
    const dur = d.duration || 6;
    this.buffs.push({
      kind: 'gear', tag: d.tag, name: d.name, n: d.n || 1, icon: '✦',
      atkPct: d.atkPct || 0, critRate: d.critRate || 0, defPct: d.defPct || 0,
      atkSpeed: d.atkSpeed || 0, em: d.em || 0, moveSpeed: d.moveSpeed || 0,
      endsAt: now + dur, duration: dur,
    });
    this._syncSpeedBonus(now);
    this.emit('buffs', { buffs: this.buffs });
  }

  /**
   * 疾影's 移动速度提升 is the one gear effect the simulation cannot apply itself:
   * `localPlayer` owns the character's motion so that walking stays responsive offline.
   * So the buff rides over as a normal BUFF event and gets summed into one number here.
   */
  _syncSpeedBonus(now) {
    let bonus = 0;
    for (const b of this.buffs) if (b.moveSpeed && b.endsAt > now) bonus += b.moveSpeed;
    if (this.me) this.me.speedBonus = bonus;
  }

  /** Live food/ability buffs, expired entries dropped. Read by the HUD each frame. */
  activeBuffs() {
    const now = performance.now() / 1000;
    if (this.buffs.some((b) => b.endsAt <= now)) {
      this.buffs = this.buffs.filter((b) => b.endsAt > now);
      this._syncSpeedBonus(now);
      this.emit('buffs', { buffs: this.buffs });
    }
    return this.buffs;
  }

  /**
   * Eat one consumable.
   *
   * Food has to go through the socket: the REST route only decrements the stack,
   * and the only place that can heal the live entity or hang a buff on it is the
   * zone instance. Resin refills are the exception — they are pure account state,
   * and the gateway bounces them back with `use_via_menu`.
   */
  async useConsumable(itemId) {
    const def = MATERIALS[itemId];
    if (!def || def.kind !== 'consumable') throw Object.assign(new Error('not_consumable'), { code: 'not_consumable' });
    if (def.resin) return api.useItem(itemId, 1);
    if ((this.player?.inventory?.[itemId] || 0) < 1) throw Object.assign(new Error('none_left'), { code: 'none_left' });
    this.socket.useItem(itemId);
    return { ok: true, viaSocket: true };
  }

  _onParty(d) {
    if (d.invite) {
      this.emit('partyInvite', d.invite);
      return;
    }
    this.partyRoster = d.members || [];
    this.emit('partyRoster', { members: this.partyRoster });
  }

  _onEmote(d) {
    const p = d.playerId === this.playerId ? null : this.actors.playerById(d.playerId);
    const who = p ? { x: p.x, y: p.y, z: p.z } : { x: this.me.x, y: this.me.y, z: this.me.z };
    this.overlay.note(who.x, who.y + 2.1, who.z, d.emote === 'wave' ? '👋' : '✨');
  }

  _onMark(d) {
    this.vfx.pillar(d.x, this.world.heightAt(d.x, d.z), d.z, 0x6fd6e0, 0.7, 8, 2.4);
    this.emit('mark', d);
  }

  _onError(d) {
    // The gateway is chatty about things the player does not need to see (an
    // attack that arrived a frame early, for instance). Only surface the ones
    // that explain a failed intent.
    const quiet = ['not_authed', 'not_in_zone', 'chat_rate_limited'];
    if (quiet.includes(d.error)) return;
    if (d.error === 'no_stamina') { this.emit('nostamina'); return; }
    if (d.error === 'on_cooldown' || d.error === 'no_energy') return;  // the HUD already shows it
    this.toast(errorText(Object.assign(new Error(d.error), { code: d.error, status: 0 })), 'bad');
  }

  /* ------------------------------------------------------------- state sync -- */

  /** Merge a publicPlayer patch from any REST response. */
  _applyPlayer(p, partial = false) {
    if (!p) return;
    if (partial) Object.assign(this.player, p);
    else this.player = { ...this.player, ...p };
    // 单机 hosts the simulation in this browser, and the sim reads the *save* document, not
    // `game.player` — `PlayerEntity.save` is where `nearestAnchor` looks up which anchors are
    // activated. `_applyPlayer` replaces `this.player` with a fresh object, so without this the
    // two drift apart the first time any REST route answers: you could light a statue, watch the
    // map update, and still wake up at the zone entry. Online this is a no-op; the gateway holds
    // the one live document (`playerCache`) and has already written it.
    this.socket.applySave?.(p);
    if (p.party) this.party = p.party.slice();
    if (p.activeSlot != null) this.activeSlot = clamp(p.activeSlot, 0, this.party.length - 1);
    this.emit('playerState', { player: this.player, stats: this.stats });
  }

  /**
   * Fold `progression.advanceQuests` results into the local quest document.
   *
   * The server sends a delta — `{ questId, stageIndex, stageDone, done, progress }`
   * with `stageIndex` already advanced — not a whole record, so the counters are
   * patched by hand. Doing it here (rather than refetching the player) is what keeps
   * the HUD tracker counting up during a fight without a round trip per kill.
   */
  _applyQuestUpdates(updates) {
    if (!updates?.length) return;
    for (const u of updates) {
      if (!u) continue;
      const id = u.questId || u.id;
      const rec = id ? this.player?.quests?.[id] : null;
      if (rec) {
        if (u.progress?.key) rec.counters = { ...(rec.counters || {}), [u.progress.key]: u.progress.have };
        if (Number.isFinite(u.stageIndex)) rec.stageIndex = u.stageIndex;
        if (u.done) rec.state = 'done';
      }
      // The chain hands over here. The server already wrote the follow-up row and sent it along;
      // inserting it means the tracker, the quest panel and the map pin all move to the next
      // objective in the same frame the last one completed, instead of going blank until the
      // player happens to reload.
      if (u.done && u.next?.id && u.next.rec && !this.player?.quests?.[u.next.id]) {
        if (this.player?.quests) this.player.quests[u.next.id] = { ...u.next.rec, counters: u.next.rec.counters || {} };
      }
      if (u.done) {
        this.audio.sfx('quest');
        // A story chapter closes with the card (`questHasEnding` — the same predicate the data
        // gate uses); a 每日委托 closes with the banner it always had.
        if (questHasEnding(QUESTS[id])) this.emit('questComplete', { ...u, id });
        else {
          this.banner('委托完成', u.name || id);
          if (u.rewards?.primogem) this.toast(`+${u.rewards.primogem} 原石`, 'gold');
          if (u.rewards?.mora) this.toast(`+${u.rewards.mora} 摩拉`, 'gold');
        }
      } else if (u.stageDone) {
        this.toast(`任务推进：${u.stageDesc || u.name || id}`, 'good');
      }
    }
    this.emit('quest', { updates });
    // The tracker and the quest panel both read straight out of the player document.
    this.emit('playerState', { player: this.player, stats: this.stats });
  }

  /** Persist position and settings occasionally so a refresh resumes in place. */
  async persist(force = false) {
    const now = performance.now();
    if (!force && now - this._lastSaveAt < 20000) return;
    this._lastSaveAt = now;
    try {
      await api.save({
        zone: this.zoneId,
        pos: { x: +this.me.x.toFixed(2), y: +this.me.y.toFixed(2), z: +this.me.z.toFixed(2), ry: +this.me.ry.toFixed(2) },
        activeSlot: this.activeSlot,
        settings: this.settings,
      });
    } catch { /* a failed autosave is not worth interrupting play for */ }
  }

  /* --------------------------------------------------------------- HUD feed -- */

  /** Everything the HUD needs, gathered once per frame by the UI layer. */
  hudState() {
    const snap = this.socket.latest();
    const party = this.party.map((charId, slot) => {
      const def = CHARACTERS[charId];
      const st = this.stats[charId] || {};
      const hp = snap?.hpByChar?.[charId] ?? st.maxHp ?? 1;
      return {
        charId, slot, name: def?.name || charId, element: def?.element || 'physical',
        level: this.player?.characters?.[charId]?.level ?? 1,
        hp, maxHp: st.maxHp || 1,
        energy: snap?.energy?.[charId] ?? 0,
        energyMax: def?.burst?.cost ?? 60,
        // Per-character 冷却 straight off the snapshot (`Player.cooldownMap`), which is the only
        // place it can come from for a character standing off the field. For the active one the
        // local prediction is the fresher of the two, so the card uses it and the ring below
        // agrees with the card.
        skillCd: slot === this.activeSlot ? this.me.skillCd : (snap?.cds?.[`${charId}:skill`] ?? 0),
        skillCdMax: def?.skill?.cd ?? 1,
        active: slot === this.activeSlot,
        dead: hp <= 0,
      };
    });
    return {
      party, activeSlot: this.activeSlot,
      me: {
        hp: this.me.hp, maxHp: this.me.maxHp, shield: this.me.shield,
        shieldElement: this.me.shieldElement,
        // 元素附着 on the character standing on the field, for the card's pip. It sits next to
        // the shield's element for the same reason that one does: both are states the *server*
        // holds about my body, and both change what the next hit does.
        aura: this.me.aura,
        stamina: this.me.stamina, staminaMax: 240,
        energy: this.me.energy, energyMax: this.me.energyMax,
        skillCd: this.me.skillCd, skillCdMax: this.me.def.skill?.cd ?? 1,
        burstCd: this.me.burstCd, burstCdMax: this.me.def.burst?.cd ?? 1,
        charging: this._leftHold > 0 ? Math.min(1, this._leftHold / this.me.chargeTime) : 0,
        alive: this.me.alive, cold: this.me.cold,
        x: this.me.x, y: this.me.y, z: this.me.z, ry: this.me.ry,
      },
      def: this.me.def,
      zone: zoneById(this.zoneId),
      player: this.player,
      chamber: this.chamber,
      target: this.target ? this.actors.enemyById(this.target) : null,
      latency: this.socket.latency,
      stale: this.socket.stale,
      mode: this.mode,
      fps: this.r.fps,
      // Both, so the HUD can tell "running at 高" from "asked for 高, running at 标准".
      quality: this.quality,
      qualityAsked: this.settings.quality,
      aiming: this.aiming,
      buffs: this.activeBuffs(),
    };
  }

  dispose() {
    this.stop();
    this.input.dispose();
    this.actors.dispose();
    this.me?.dispose();
    this.world?.dispose();
    this.vfx.dispose();
    this.overlay.clear();
    this.audio.dispose();
    this.socket.close?.();
  }
}
