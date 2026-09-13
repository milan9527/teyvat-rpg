// Authoritative-server socket client.
//
// Responsibilities:
//   * handshake (HELLO → WELCOME) and zone changes
//   * send local input at CLIENT_SEND_RATE, not per frame
//   * buffer snapshots so actors can be interpolated instead of teleporting
//   * round-trip latency via PING/PONG
//   * reconnect with backoff, preserving the last zone
//
// Everything else is an event: `on(type, fn)` where `type` is an S2C constant or
// one of the synthetic lifecycle events ('open', 'welcome', 'close', 'reconnect',
// 'fatal').

import {
  C2S, S2C, CLIENT_SEND_RATE, PROTOCOL_VERSION, nowMs,
} from '@teyvat/shared/protocol.js';

const SEND_INTERVAL = 1000 / CLIENT_SEND_RATE;

/**
 * Snapshots arrive at 10 Hz but we render at 60. Holding a short history and
 * rendering ~120 ms in the past turns the stepped stream into smooth motion; the
 * alternative (snapping to the newest snapshot) makes every remote actor stutter
 * at exactly the snapshot rate.
 */
export const INTERP_DELAY_MS = 120;
const HISTORY = 24;

export class Socket {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.handlers = new Map();
    this.state = 'idle';        // idle | connecting | open | closed
    this.playerId = null;
    this.nickname = null;
    this.zone = null;
    this.shard = null;
    this.mode = 'online';
    this.tickRate = 20;
    this.authed = false;        // true once WELCOME has been accepted

    this.snapshots = [];        // ring of { serverNow, clientNow, data }
    this.latency = 0;
    this.clockOffset = 0;       // serverNow - clientNow, smoothed
    this.lastSnapshotAt = 0;

    this._sendAcc = 0;
    this._pingAcc = 0;
    this._pingSeq = 0;
    this._pending = [];         // messages queued while the socket is opening
    this._retries = 0;
    this._retryTimer = null;
    this._closedByUs = false;
    this._wantZone = null;
    this._wantMode = 'online';
  }

  /* --------------------------------------------------------------- events -- */

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (e) { console.error(`[socket] handler ${type}`, e); }
    }
  }

  /* ------------------------------------------------------------ lifecycle -- */

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  connect(zone, mode = 'online') {
    this._wantZone = zone ?? this._wantZone;
    this._wantMode = mode ?? this._wantMode;
    this._closedByUs = false;
    if (this.ws && (this.state === 'connecting' || this.state === 'open')) return;
    this.state = 'connecting';

    const ws = new WebSocket(this.url());
    this.ws = ws;

    ws.onopen = () => {
      this.state = 'open';
      this._retries = 0;
      this.emit('open');
      this.send(C2S.HELLO, {
        token: this.token,
        zone: this._wantZone || undefined,
        mode: this._wantMode === 'solo' ? 'solo' : undefined,
        protocol: PROTOCOL_VERSION,
      });
      // Flush anything queued before the socket came up.
      const q = this._pending;
      this._pending = [];
      for (const m of q) ws.send(m);
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this._route(msg);
    };

    ws.onerror = () => { /* onclose always follows; handle it there. */ };

    ws.onclose = (ev) => {
      const wasOpen = this.state === 'open';
      this.state = 'closed';
      this.ws = null;
      this.emit('close', { code: ev.code, wasOpen });
      this.authed = false;
      // 4001/4003 are auth failures from the gateway — retrying cannot help.
      if (this._closedByUs || ev.code === 4001 || ev.code === 4003) {
        if (!this._closedByUs) this.emit('fatal', { reason: 'auth', code: ev.code });
        return;
      }
      this._scheduleRetry();
    };
  }

  _scheduleRetry() {
    if (this._retryTimer) return;
    // Exponential-ish backoff capped at 8 s, so a server restart is picked up
    // quickly but a genuinely dead server is not hammered.
    const delay = Math.min(8000, 600 * 2 ** Math.min(4, this._retries));
    this._retries++;
    this.emit('reconnect', { attempt: this._retries, delay });
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.connect(this._wantZone, this._wantMode);
    }, delay);
  }

  close() {
    this._closedByUs = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this.ws?.close();
    this.ws = null;
    this.state = 'closed';
  }

  /* -------------------------------------------------------------- routing -- */

  _route(msg) {
    const { t, d } = msg;
    switch (t) {
      case S2C.WELCOME:
        // A protocol mismatch means the two sides disagree about message shapes;
        // playing on would produce silent nonsense, so stop here.
        if (d.protocol !== PROTOCOL_VERSION) {
          this.emit('fatal', { reason: 'protocol', got: d.protocol, want: PROTOCOL_VERSION });
          this.close();
          return;
        }
        this.authed = true;
        this.playerId = d.playerId;
        this.nickname = d.nickname;
        this.zone = d.zone;
        this.shard = d.shard;
        this.mode = d.mode || 'online';
        this.tickRate = d.tickRate || 20;
        this._wantZone = d.zone;
        this.snapshots.length = 0;
        this.emit('welcome', d);
        return;

      case S2C.ZONE_STATE:
        this.zone = d.zone;
        this.shard = d.shard;
        this._wantZone = d.zone;
        // A zone change invalidates every buffered position. It also invalidates
        // the clock offset: each instance runs its own sim clock from zero, so
        // smoothing towards the new one would leave several seconds of frozen
        // actors. Zeroing it makes the next snapshot re-lock immediately.
        this.snapshots.length = 0;
        this.clockOffset = 0;
        break;

      case S2C.SNAPSHOT: {
        const clientNow = performance.now();
        // The server's sim clock counts *seconds* since the instance started;
        // everything downstream (interpolation delay, snapshot spans, animation
        // speed derivation) is in milliseconds, so convert once here rather than
        // scattering factors of 1000 through the render path.
        const serverNow = d.now * 1000;
        // Smooth the clock offset rather than tracking it exactly: individual
        // packets jitter, and a jumpy offset makes interpolation stutter.
        const off = serverNow - clientNow;
        this.clockOffset = this.clockOffset === 0 ? off : this.clockOffset * 0.94 + off * 0.06;
        this.lastSnapshotAt = clientNow;
        this.snapshots.push({ serverNow, clientNow, data: d });
        if (this.snapshots.length > HISTORY) this.snapshots.shift();
        break;
      }

      case S2C.ERROR:
        // The gateway answers a bad HELLO with an error rather than a close, so
        // an auth failure before WELCOME has to be promoted to fatal or the
        // connect promise would sit there until its timeout.
        if (!this.authed && (d?.error === 'unauthorized' || d?.error === 'no_player')) {
          this.emit('fatal', { reason: 'auth', error: d.error });
          this.close();
          return;
        }
        break;

      case S2C.PONG: {
        const sent = this._pingSent?.[d.c];
        if (sent != null) {
          this.latency = Math.round(performance.now() - sent);
          delete this._pingSent[d.c];
        }
        break;
      }
      default: break;
    }
    this.emit(t, d);
  }

  /* -------------------------------------------------------------- sending -- */

  send(t, d) {
    const raw = JSON.stringify(d === undefined ? { t } : { t, d });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(raw);
    else if (this._pending.length < 32) this._pending.push(raw);
  }

  /**
   * Called every frame with the local player's transform. Rate-limits itself to
   * CLIENT_SEND_RATE and skips duplicates while standing perfectly still, which
   * is most of the traffic in a party standing at a waypoint.
   */
  sendInput(dt, snap) {
    this._sendAcc += dt * 1000;
    if (this._sendAcc < SEND_INTERVAL) return false;
    this._sendAcc = 0;
    const p = this._lastInput;
    if (p && p.a === snap.a
      && Math.abs(p.x - snap.x) < 0.004 && Math.abs(p.y - snap.y) < 0.004
      && Math.abs(p.z - snap.z) < 0.004 && Math.abs(p.ry - snap.ry) < 0.006
      && Math.abs(p.st - snap.st) < 0.6) {
      // Still send a heartbeat every ~1 s so the server's idle timeout and the
      // AOI bookkeeping both stay happy.
      this._idleFrames = (this._idleFrames || 0) + 1;
      if (this._idleFrames < CLIENT_SEND_RATE) return false;
    }
    this._idleFrames = 0;
    this._lastInput = { ...snap };
    this.send(C2S.INPUT, snap);
    return true;
  }

  ping(dt) {
    this._pingAcc += dt;
    if (this._pingAcc < 2) return;
    this._pingAcc = 0;
    const c = ++this._pingSeq;
    this._pingSent = this._pingSent || {};
    this._pingSent[c] = performance.now();
    this.send(C2S.PING, { c });
  }

  /* --------------------------------------------------------- game actions -- */

  // `follow` is a friend's player id: the server then picks both the zone and the
  // shard, because it knows where they are standing this instant and the caller only
  // knows what a REST snapshot said. `zone` is still sent — it is what the server
  // falls back to, and what the loading screen names.
  joinZone(zone, at, follow = null) {
    this._wantZone = zone;
    this.send(C2S.JOIN_ZONE, follow ? { zone, at, follow } : { zone, at });
  }
  attack(dir, charged = false) { this.send(C2S.ATTACK, { dir, charged }); }
  skill(dir) { this.send(C2S.SKILL, { dir }); }
  burst(dir) { this.send(C2S.BURST, { dir }); }
  switchChar(charId) { this.send(C2S.SWITCH_CHAR, { charId }); }
  interact(kind, id) { this.send(C2S.INTERACT, { kind, id }); }
  chat(channel, body) { this.send(C2S.CHAT, { channel, body }); }
  revive(playerId) { this.send(C2S.REVIVE, { playerId }); }
  respawn() { this.send(C2S.RESPAWN, {}); }
  useItem(itemId) { this.send(C2S.USE_ITEM, { itemId }); }
  startChamber(floor) { this.send(C2S.START_CHAMBER, { floor }); }
  // The gateway keys invites by numeric player id and accepts by party id — the
  // invite broadcast carries both, so the UI hands back what it was given.
  partyInvite(playerId) { this.send(C2S.PARTY_INVITE, { playerId }); }
  partyAccept(partyId) { this.send(C2S.PARTY_ACCEPT, { partyId }); }
  partyLeave() { this.send(C2S.PARTY_LEAVE, {}); }
  emote(emote) { this.send(C2S.EMOTE, { emote }); }
  mark(x, z) { this.send(C2S.MARK, { x, z }); }

  /* -------------------------------------------------- snapshot sampling -- */

  /** Server time we are rendering at (deliberately in the past). */
  renderTime() {
    return performance.now() + this.clockOffset - INTERP_DELAY_MS;
  }

  /**
   * The two snapshots bracketing `renderTime()`, plus the blend factor. Returns
   * null before two have arrived.
   */
  sampleWindow() {
    const n = this.snapshots.length;
    if (n === 0) return null;
    const t = this.renderTime();
    if (n === 1) return { a: this.snapshots[0], b: this.snapshots[0], u: 0 };
    for (let i = n - 1; i > 0; i--) {
      const b = this.snapshots[i], a = this.snapshots[i - 1];
      if (t >= a.serverNow && t <= b.serverNow) {
        const span = b.serverNow - a.serverNow;
        return { a, b, u: span > 1 ? (t - a.serverNow) / span : 0 };
      }
    }
    // Render time ran past the newest snapshot (packet loss / stall): hold the
    // latest rather than extrapolating, which would rubber-band on recovery.
    if (t > this.snapshots[n - 1].serverNow) {
      const b = this.snapshots[n - 1];
      return { a: this.snapshots[n - 2], b, u: 1 };
    }
    return { a: this.snapshots[0], b: this.snapshots[1], u: 0 };
  }

  /** The most recent snapshot, for data that must not lag (own HP, energy). */
  latest() {
    return this.snapshots.length ? this.snapshots[this.snapshots.length - 1].data : null;
  }

  get stale() {
    return this.state !== 'open'
      || (this.lastSnapshotAt > 0 && performance.now() - this.lastSnapshotAt > 2500);
  }
}

/**
 * One socket per page. The game only ever needs a single connection, and making
 * it a module singleton means the UI can import it for a latency readout without
 * threading a reference through every constructor.
 */
export const socket = new Socket();
