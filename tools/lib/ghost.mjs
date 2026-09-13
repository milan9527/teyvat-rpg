// A headless player: the second body in a multiplayer probe.
//
// Why a socket and not a second browser. Two WebGL contexts under llvmpipe is about 1 fps
// each, and worse, Firefox throttles rAF in whichever page does not have focus — so the
// obvious "open two tabs and look at both" probe measures two stale frames and calls the
// result multiplayer (see the notes in tools/vault-cam.mjs about the same trap with one
// page). The way out is asymmetry: **one** real browser, which is the thing whose pixels we
// want to judge, and one player made of nothing but the messages `client/src/net/socket.js`
// would have sent. The gateway cannot tell the difference — it is the same `/ws?token=`
// handshake, the same `C2S.HELLO`, the same `C2S.INPUT` stream — so what the browser
// renders is what it would render for a real second player.
//
// Everything here is deliberately thin. It is *not* a client: it does not interpolate, it
// does not simulate, and it holds no opinion about the world. It only sends what a player's
// hands would produce and records what came back, so an assertion can be written about
// either side.
//
//   const g = await connectGhost(API, await mintGuest(API));
//   await g.hello('mondstadt', 'online');       // → the WELCOME payload, or null
//   await g.walkTo(x, z);                       // → { x, z }, in steps the server accepts
//   g.close();
//
// Modelled on the socket driver inside tools/mp-check.mjs, which was the only thing that had
// one; that probe still carries its own (it drives four sockets through a party and a co-op
// dungeon and wants them inline). Worth knowing when editing either: "walk without tripping
// the anti-teleport check" now exists twice, and the failure mode of a drifting copy is a
// `correction` packet the probe never looks at — which is why `g.corrected` is recorded here
// and asserted by the caller rather than silently followed.
import { C2S, S2C, ACTION } from '../../shared/src/protocol.js';
import { MAX_SPEED } from '../../shared/src/world/actions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Open a socket for an account minted elsewhere (`mintGuest`). Resolves once the socket is
 * open — the HELLO is a separate call so a probe can assert on the handshake itself.
 */
export function connectGhost(api, acc, { tag = acc.tag || 'ghost' } = {}) {
  const host = String(api).replace(/^https?:\/\//, '');
  const ws = new WebSocket(`ws://${host}/ws?token=${encodeURIComponent(acc.token)}`);
  const g = {
    ...acc, tag, ws,
    playerId: acc.playerId ?? acc.player?.id,
    nickname: acc.nickname ?? acc.player?.nickname,
    log: [], by: new Map(), welcome: null, x: 0, y: 0, z: 0, ry: 0,

    got(t) { return this.by.get(t) || []; },
    send(t, d) { if (ws.readyState === 1) ws.send(JSON.stringify({ t, d })); },

    /** Wait for any message of type `t` that has arrived at all (including before the call). */
    async waitFor(t, ms = 6000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (this.got(t).length) return this.got(t);
        await sleep(80);
      }
      return null;
    },

    /** Wait for a message of type `t` satisfying `pred`. */
    async waitWhere(t, pred, ms = 6000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const hit = this.got(t).find(pred);
        if (hit) return hit;
        await sleep(80);
      }
      return null;
    },

    /** Identify to the gateway and wait for the WELCOME. Returns the payload or null. */
    async hello(zone, mode = 'online', ms = 8000) {
      this.send(C2S.HELLO, { token: this.token, zone, mode });
      await this.waitFor(S2C.WELCOME, ms);
      return this.welcome;
    },

    /**
     * Walk to (x, z) in packets the server will accept.
     *
     * `handleInput`'s anti-teleport check allows `MAX_SPEED * dt + 1.5` metres per packet,
     * where dt is the gap since this socket's *previous* packet — so the constraint is on
     * the step, not on the speed, and one long jump is refused with a `correction` that
     * silently snaps the player back to where they started. Hence steps: 0.9 m every 150 ms
     * is 6 m/s, a run rather than a teleport, which is also what makes the receiving client
     * blend its locomotion animation instead of snapping the model.
     *
     * `y` is sent but not trusted: the server clamps it to the terrain (`entity.y = clamp(ny,
     * gh - 0.6, gh + 60)`), so a ghost that knows nothing about the height field still
     * stands on the ground rather than inside it.
     */
    async walkTo(x, z, { y = 0, step = 0.9, ms = 150, action = ACTION.run, stamina = 240 } = {}) {
      const dist = Math.hypot(x - this.x, z - this.z);
      const n = Math.max(1, Math.ceil(dist / step));
      const budget = MAX_SPEED * (ms / 1000) + 1.5;
      if (dist / n > budget) throw new Error(`walkTo: ${(dist / n).toFixed(2)} m per packet exceeds the ${budget.toFixed(2)} m the server allows`);
      const x0 = this.x, z0 = this.z;
      // Face the direction of travel, so the receiving client has something to rotate the
      // model to — a ghost that walks sideways looks like a bug in the remote animation.
      const ry = Math.atan2(x - x0, z - z0);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        this.send(C2S.INPUT, {
          x: x0 + (x - x0) * t, z: z0 + (z - z0) * t, y, ry, a: action, st: stamina,
        });
        await sleep(ms);
      }
      this.x = x; this.z = z; this.ry = ry;
      return { x, z };
    },

    /** Stand still, which is a message too: without it the last packet says "running". */
    async stand({ ry = this.ry, y = 0, beats = 3, ms = 150 } = {}) {
      for (let i = 0; i < beats; i++) {
        this.send(C2S.INPUT, { x: this.x, z: this.z, y, ry, a: ACTION.idle, st: 240 });
        await sleep(ms);
      }
      this.ry = ry;
    },

    close() { try { ws.close(); } catch { /* already gone */ } },
  };

  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    g.log.push(m);
    if (!g.by.has(m.t)) g.by.set(m.t, []);
    g.by.get(m.t).push(m.d);
    if (m.t === S2C.WELCOME) {
      g.welcome = m.d;
      g.x = m.d.you?.x ?? 0; g.y = m.d.you?.y ?? 0; g.z = m.d.you?.z ?? 0;
      // The WELCOME is the authority on who this socket is, and it is the only place the
      // identity is guaranteed: `/api/guest` has answered with the id under two different
      // key paths over this project's life (`playerId` and `player.id`), and a probe that
      // reads the wrong one compares `undefined` against a remote player's id and passes
      // nothing while looking green.
      g.playerId = m.d.playerId ?? g.playerId;
      g.nickname = m.d.nickname ?? g.nickname;
    }
    // A correction means the walk above was refused and this ghost is not where it thinks
    // it is. Record it rather than resync: a probe that quietly follows the correction
    // reports a passing movement test on a build where movement was rejected.
    if (m.t === S2C.PLAYER_ACTION && m.d?.action === 'correction'
      && Number(m.d.playerId) === Number(g.playerId)) {
      g.corrected = { x: m.d.x, z: m.d.z, at: Date.now() };
    }
  });

  return new Promise((res, rej) => {
    ws.addEventListener('open', () => res(g));
    ws.addEventListener('error', (e) => rej(new Error(`${tag} ws error: ${e.message || 'refused'}`)));
  });
}
