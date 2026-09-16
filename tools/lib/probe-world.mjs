// Driving the running game from a probe: boot a page into the world, freeze it into a
// still-life, and walk the character about on the product's own locomotion.
//
// Everything here was written inside `react-check.mjs` for its end-to-end fight and then moved
// out when a second probe (`player-aura-check.mjs`) needed the same page. The move is the point:
// `__isolate` and `__canon` are *measurement preconditions* — a second copy that forgot the fog,
// or forgot that `SparkField.cursor` keeps rotating, would compare frames that differ for reasons
// nobody named and still be green. One copy, imported by both.
//
// Nothing in here calls `check()`: a library that decides what is a failure cannot be reused by a
// probe that wants to *measure* the same thing. `bootWorld` is the one exception and it takes the
// caller's `check` as an argument, because "the world never came up" is fatal to every probe.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Page-side instrumentation, installed once per boot.
 *
 * `__isolate` and `__canon` are what make a live page measurable at all, and both are here rather
 * than in the probes because they are *measurement preconditions* — a section whose copy of
 * `__isolate` forgot the fog, or whose `__canon` forgot the spark cursor, would still be green
 * while comparing frames that differ for reasons nobody named.
 */
export const INSTALL = `(() => {
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
  //
  // \`keep\` is for the probe that is photographing a *body* rather than an effect: the local
  // player's own group is a scene child like any other, so measuring the 元素附着 glow on the
  // model against black means asking for it by name. Everything else still goes.
  window.__isolate = (keep = []) => {
    const own = new Set([g.vfx.sparks.points, ...keep]);
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
  // problem — a live game never draws the same frame twice — but it is a probe's, because
  // every claim there is a pixel count and some of them demand exact equality.
  window.__canon = () => {
    g.vfx.clear();
    g.overlay.clear?.();
    g.vfx.sparks.cursor = 0;
    for (const pool of g.vfx.meshPools()) pool.free.sort((a, b) => a.id - b.id);
  };
  return true;
})()`;

/**
 * Boot a page all the way into the world, from the launcher, as a guest.
 *
 * `check` is the caller's assertion function; a page that never reached the world is fatal, so
 * this throws after saying so in the probe's own voice.
 */
export const bootWorld = async (p, { base, check, label = '' }) => {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  // Which button depends on whether this browser already holds an account, and the launcher
  // offers *both* either way — so the choice is made on the token rather than on what is on
  // screen. Clicking 游客登录 with a session in hand mints a **second, level-1 guest**: that is
  // how react-check's second boot threw away the party it had just levelled and walked a fresh
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

/**
 * The world-driving helpers, bound to one page.
 *
 * All four are written for a browser drawing 3-4 fps on llvmpipe, which is the constraint behind
 * every re-issue and every poll in them: `dt` is clamped to 50 ms, so a second of wall clock is
 * about 150 ms of simulated walking, and anything that sleeps for a fixed time is spending a
 * budget it cannot see.
 */
export const worldHelpers = (p) => {
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
  /**
   * `onTick` runs once per poll, and exists because a walk is not a pause in the fight. A probe
   * that keeps its party alive between polls stops keeping it alive for the whole of an
   * `approach` — player-aura-check walked the last two metres into a camp of four with a budget
   * of 20 s and arrived dead, so the loop that eats never ran a single iteration.
   */
  const approach = async (id, want, budgetMs, tol = 1.2, onTick = null) => {
    const t0 = Date.now();
    let st = await look(id);
    while (Date.now() - t0 < budgetMs) {
      if (onTick && (await onTick(st)) === false) return st;
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
      if (onTick && (await onTick(st)) === false) return st;
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
  const travelTo = async ([tx, tz], budgetMs, arrive = 24) => {
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
      if (d <= arrive || !st.alive) return { ...st, d };
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
   * Everything alive nearby, biggest first, with how many neighbours each one brings.
   *
   * `crowd` is the load-bearing field: standing at 2 m from one creature in the middle of a
   * six-strong camp means being hit by all six for as long as the probe stands there, and only
   * the character on the field takes damage.
   */
  const census = () => p.evaluate(() => {
    const g = window.game;
    const live = [...g.actors.enemies].filter(([, e]) => e.alive && e.hp > 0);
    const out = [];
    for (const [id, e] of live) {
      if (!e.alive || e.hp <= 0) continue;
      const crowd = live.filter(([oid, o]) => oid !== id && Math.hypot(o.x - e.x, o.z - e.z) <= 14).length;
      out.push({ id, d: +Math.hypot(e.x - g.me.x, e.z - g.me.z).toFixed(2), hp: e.hp, maxHp: e.maxHp,
        crowd, lv: e.level, defId: e.defId, name: e.actor.def.name, aura: e.aura });
    }
    return out.sort((a, b) => (b.maxHp - a.maxHp) || (a.d - b.d));
  });

  /**
   * The party sheet, per character — because only the character **on the field** takes damage,
   * and a character at 0 hp cannot be switched to at all (`switchTo` → 「该角色已倒下」).
   */
  const partyHp = () => p.evaluate(() => {
    const g = window.game;
    return Object.fromEntries(g.party.filter(Boolean).map((c) => [c, Math.round(g._hpOf(c))]));
  });

  /**
   * Give the keyboard back to the world, and say what had taken it.
   *
   * Anything the UI opens — a panel or a modal — calls `game.setPaused(true)`, and a paused world
   * reads **no** keys: `_handleKeys` sits inside the pause gate in `_frame` while
   * `input.endFrame()` keeps clearing the press set outside it. So a key press vanishes with no
   * error anywhere, which is indistinguishable from a dropped press. Closing it goes through the
   * product's own 关闭 button rather than Escape (Escape is the UI's, and it opens 设置 when there
   * is nothing to close).
   */
  const unpause = () => p.evaluate(() => {
    const g = window.game, u = window.ui;
    const st = {
      paused: !!g._paused, panel: u?.panels?.name || null,
      modal: document.querySelector('.scrim h2')?.textContent || null,
      chat: !!u?.hud?.chatOpen, typing: document.activeElement?.tagName || 'none',
    };
    for (const b of document.querySelectorAll('.scrim .close')) b.click();
    if (u?.hud?.chatOpen) u.hud.closeChat();
    document.activeElement?.blur?.();
    st.took = st.paused || !!st.panel || !!st.modal || st.chat;
    return st;
  });

  return { look, approach, travelTo, census, partyHp, unpause };
};

/**
 * Level a party through the game's own growth routes, then say what it bought.
 *
 * `POST /api/dev/supply` hands over **materials and mora only**, billed from the same cost tables
 * a player pays out of, and every level is then bought through `/api/char/levelup` and
 * `/api/char/ascend` — the routes the character screen calls. If those are broken the party stays
 * weak and the probe that needed the levels goes red, which is correct.
 *
 * The climb is bought one route call at a time with **exactly** the books the remaining xp needs,
 * because `levelUpCharacter` spends everything it is handed (one book is 20 000 xp and level 30 is
 * 359 679 of them, so `heroWit: 1` twelve times stops at 25 and `heroWit: 9999` lands wherever the
 * shelf runs out).
 */
export const levelParty = async ({ base, token, want, totalXpTo }) => {
  const rest = async (route, body) => {
    const r = await fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, b: await r.json().catch(() => ({})) };
  };
  await rest('/api/dev/rank', { rank: 10 });
  const sup = await rest('/api/dev/supply', { level: want });
  const st0 = await rest('/api/player/state');
  for (const charId of Object.keys(st0.b.player?.characters || {})) {
    for (let round = 0; round < 10; round++) {
      const inst = (await rest('/api/player/state')).b.player?.characters?.[charId] || {};
      if ((inst.level || 1) >= want) break;
      const books = Math.max(1, Math.ceil((totalXpTo(want)
        - totalXpTo(inst.level || 1) - (inst.xp || 0)) / 20000));
      const lv = await rest('/api/char/levelup', { charId, materials: { heroWit: books } });
      // No progress is either "no books left" or "at the ascension cap" (20 without one, which
      // level 30 is above); the second is worth one 突破 and then another go at the books.
      if (lv.status !== 200 || (lv.b?.level || 0) <= (inst.level || 1)) {
        if ((await rest('/api/char/ascend', { charId })).status !== 200) break;
      }
    }
  }
  const st1 = (await rest('/api/player/state')).b.player || {};
  return {
    granted: sup.b?.granted || {},
    chars: Object.values(st1.characters || {}).map((c) => c.level),
    rank: st1.adventureRank, worldLevel: st1.worldLevel,
    rest,
  };
};
