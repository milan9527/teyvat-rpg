// Mint a probe account and put it at the adventure rank the probe needs.
//
// Why every multi-zone probe needs this. Four of the six zones are rank-gated (龙脊雪山 AR 4,
// 冰封洞窟 5, 璃月 7, 黄金屋 18) and the gate is enforced in *four* places on purpose: the client
// refuses the transition (`game.js` `enterZone`), 单机's `localSocket` refuses `JOIN_ZONE`, the
// gateway refuses it for online play, and `/api/world/teleport` refuses the REST warp. A fresh
// guest is AR 1, so a probe that boots and warps can only ever reach 蒙德 and 深渊试炼场 — and the
// refusal surfaces as "the game is still in mondstadt", which is indistinguishable from a broken
// zone stream. `tour.mjs` died that way with a misleading message and `nan-scan` reported four
// FAILs that were the account's rank, not the geometry.
//
// The rank has to be raised *before the page boots*, not after, because all four gates read a
// copy of the save that is loaded once: `Game.load` fetches `/api/player/state`, `localSocket`
// keeps that document as `this._save`, and the gateway pulls its own from the cache at connect.
// Raising it on a live session leaves every one of those copies at AR 1. So the shape is always:
// mint a token here, raise the rank over http, inject the token into `localStorage`, *then* load.
//
//   const acct = await mintGuest(API);
//   const rank = await raiseRank(API, acct.token, 18);
//   if (!rank.ok) …skip the gated zones, printing rank.reason…
//
// `raiseRank` never throws and never fails a probe by itself: when the hook is absent (a
// production build, or a server that has not been restarted since `routes/dev.js` landed) it
// returns `{ ok: false, reason }` so the caller can SKIP the zones it cannot reach *by name*.
// A probe that silently tested two zones and said "all passed" is the failure this whole file
// exists to prevent.

const j = { 'content-type': 'application/json' };

/** Throwaway account, same route the 「立即游玩」 button uses. Throws: a probe with no account has nothing to test. */
export async function mintGuest(api) {
  const r = await fetch(`${api}/api/guest`, { method: 'POST', headers: j, body: '{}' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.token) throw new Error(`mintGuest: ${api}/api/guest → ${r.status} ${JSON.stringify(body)}`);
  return body;   // { token, playerId, nickname, guest }
}

/**
 * Put the account at `rank` through the dev hook, which grants xp along the real curve.
 * Returns `{ ok, rank, moved, reason }` — `ok: false` means the zones above this rank are
 * unreachable and the caller must skip them out loud.
 */
export async function raiseRank(api, token, rank) {
  let r, body;
  try {
    r = await fetch(`${api}/api/dev/rank`, {
      method: 'POST',
      headers: { ...j, authorization: `Bearer ${token}` },
      body: JSON.stringify({ rank }),
    });
    body = await r.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, rank: null, moved: false, reason: `POST /api/dev/rank failed: ${e.message}` };
  }
  if (r.status === 404) {
    return {
      ok: false, rank: null, moved: false,
      reason: 'the server has no /api/dev/rank — it is registered only when NODE_ENV !== production, '
        + 'and a server started before routes/dev.js landed needs ./tools/daemon.sh restart server',
    };
  }
  if (!r.ok) return { ok: false, rank: null, moved: false, reason: `POST /api/dev/rank → ${r.status} ${JSON.stringify(body)}` };
  if (body.rank < rank) {
    return { ok: false, rank: body.rank, moved: !!body.moved, reason: `asked for AR ${rank}, account is AR ${body.rank}` };
  }
  return { ok: true, rank: body.rank, moved: !!body.moved, reason: null, player: body.player };
}

/** Mint + raise in one call, for the common case. Never throws on the raise half. */
export async function guestAtRank(api, rank) {
  const acct = await mintGuest(api);
  const raised = await raiseRank(api, acct.token, rank);
  return { ...acct, rank: raised.rank, rankOk: raised.ok, rankReason: raised.reason };
}
