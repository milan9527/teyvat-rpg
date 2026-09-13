// 背包 / 圣遗物强化 probe: the inventory panel, clicked through a real browser.
//
//   DISPLAY=:99 node tools/bag-check.mjs [baseUrl] [outDir]
//
// `api-check.mjs` already proves `POST /api/inventory/enhance` — the cost curve, the
// fodder accounting, the lock, the by-reference stat refresh. What it cannot prove is
// that a player can *reach* any of it: that the 圣遗物 tab lists the pieces a domain
// dropped, that clicking one shows what the next level costs, that 强化 turns the grid
// into a fodder picker, that the marked pieces read as doomed rather than merely
// selected, and that confirming redraws the panel with the new level instead of leaving
// a stale one on screen until the bag is reopened.
//
// It boots in 单机 mode on purpose. The seeding below runs `POST /api/world/chamber`
// straight from Node, and that route answers 409 `use_socket` to anyone holding a live
// gateway connection (the guard that stops one fight being paid twice) — so an online
// browser would make its own probe impossible to set up.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
import { ZONES, gatherNodes } from '../shared/src/data/zones.js';
import { WEAPON_ORE } from '../shared/src/sim/loot.js';
import { MATERIALS } from '../shared/src/data/items.js';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/bag';
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  // Returns the verdict so a section can be *guarded* by its own precondition, the way
  // `api-check` does. Without it `if (check(...)) { … }` is a silently empty block: the
  // check passes, prints PASS, and everything it was gating is skipped — which is how the
  // whole 精炼 section below ran zero assertions and still reported "0 failed".
  return !!ok;
}

async function rest(token, path, body) {
  const r = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, b: await r.json().catch(() => ({})) };
}

const b = await puppeteer.launch({
  browser: 'firefox', headless: false,
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', GALLIUM_DRIVER: 'llvmpipe' },
  extraPrefsFirefox: {
    'webgl.force-enabled': true,
    'webgl.disable-fail-if-major-performance-caveat': true,
    'media.autoplay.default': 0,
  },
  defaultViewport: { width: W, height: H },
});
const p = await b.newPage();

let logs = [];
const errors = [];
p.on('console', (m) => {
  const line = `[${m.type()}] ${m.text()}`;
  logs.push(line);
  if (m.type() === 'error') errors.push(line);
});
p.on('pageerror', (e) => { const l = `[pageerror] ${e.message}`; logs.push(l); errors.push(l); });

let step = 0;
async function shot(name) {
  step++;
  const file = `${outDir}/${String(step).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file });
  const drained = logs; logs = [];
  console.log(`\n=== ${step}. ${name} → ${file}`);
  if (drained.length) console.log(drained.slice(-12).join('\n'));
}

const panelTitle = () => p.evaluate(() => document.querySelector('.panel h2')?.textContent ?? null);

/** The artifact grid as the player sees it: label, level text, and the state classes. */
const slots = () => p.evaluate(() => [...document.querySelectorAll('.panel .grid .slot')].map((s) => ({
  uid: s.dataset.uid || null,
  name: s.querySelector('.nm')?.textContent || '',
  lv: s.querySelector('.lv')?.textContent || '',
  cls: [...s.classList].filter((c) => c !== 'slot').join(' '),
})));

/**
 * Everything the detail column says, as one string.
 *
 * It is the last child of the side column, after the 详情 heading — the panel builds it
 * as a bare `div` with no class of its own, so there is nothing more specific to ask for.
 */
const detail = () => p.evaluate(() => {
  const side = document.querySelector('.panel .col.side');
  return side ? (side.lastElementChild?.textContent || '') : '';
});

/** The inventory tabs are `div.tab`, not buttons. */
const clickTab = (key) => p.evaluate((k) => {
  const t = document.querySelector(`.panel .col.side .tab[data-tab="${k}"]`);
  if (!t) return false;
  t.click();
  return true;
}, key);

/** Click the button in the panel whose label contains `label`. */
const clickBtn = (label) => p.evaluate((l) => {
  const btn = [...document.querySelectorAll('.panel button')].find((x) => x.textContent.includes(l));
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}, label);

const clickSlot = (uid) => p.evaluate((u) => {
  const s = [...document.querySelectorAll('.panel .grid .slot')].find((x) => x.dataset.uid === u);
  if (!s) return false;
  s.click();
  return true;
}, uid);

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await shot('title');

  // 单机模式 first, then the guest button: see the header.
  check('the login screen offers 单机模式', await p.evaluate(() => {
    const btn = document.querySelector('[data-act="solo"]');
    if (!btn) return false;
    btn.click();
    return true;
  }));
  await sleep(400);
  await (await p.$('[data-act="guest"]')).click();
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  const me = await p.evaluate(() => ({
    running: !!window.game?._running, mode: window.game?.mode,
    playerId: window.game?.playerId, arts: (window.game?.player?.equipment || [])
      .filter((e) => e.kind === 'artifact').length,
  }));
  check('the solo world booted', me.running === true && me.mode === 'solo' && !!me.playerId,
    `player ${me.playerId}, ${me.arts} artifacts to start`);
  const token = await p.evaluate(() => localStorage.getItem('teyvat.token'));
  check('the page is holding a token the probe can seed through', !!token);

  // Farm the first domain until the resin bar is dry. Every clear costs DOMAIN_RESIN and
  // pays an artifact, so a full bar is the pile enhancement needs.
  const dz = Object.values(ZONES).find((z) => z.kind === 'dungeon' && z.domain);
  const floor = dz.chambers[0].floor ?? 1;
  let runs = 0, dropped = 0;
  for (let i = 0; i < 12; i++) {
    const r = await rest(token, '/api/world/chamber', { zone: dz.id, floor, time: 1 });
    if (r.status !== 200) break;
    runs++;
    dropped += r.b.drops?.artifacts?.length || 0;
    if (r.b.resin?.short) break;
  }
  check('the domain can be farmed for artifacts', runs > 0 && dropped >= 4,
    `${runs} runs of ${dz.name} f${floor} → ${dropped} pieces`);

  // Seed the weapon half the same way: mine every ore cluster in 蒙德平原 (ore is the
  // weapon's experience) and pull ten wishes, which the 3-star pool guarantees will leave
  // duplicates — the fodder refinement needs. Both go through REST before the reload
  // below, so the panel is reading them out of the save rather than out of a boot cache.
  const oreNodes = gatherNodes(ZONES.mondstadt).filter((n) => WEAPON_ORE.includes(n.kind));
  let chunks = 0;
  for (const n of oreNodes) {
    const r = await rest(token, '/api/world/gather', { zone: 'mondstadt', nodeId: n.id });
    if (r.status === 200) chunks += Object.values(r.b.items || {}).reduce((a, v) => a + v, 0);
  }
  check('the world has ore to mine for weapons', chunks > 0,
    `${oreNodes.length} clusters → ${chunks} chunks`);
  const pull = await rest(token, '/api/wish/pull', { pool: 'standard', count: 10 });
  check('ten wishes can be pulled for duplicate weapons', pull.status === 200,
    `status ${pull.status}`);

  // The panel reads the save, so it has to be told the save moved. Reloading is the
  // honest way to prove the panel renders server state rather than a boot snapshot.
  // The token is still in localStorage, so the reload lands on 继续冒险 rather than the
  // guest button — and the mode buttons reset to 多人在线, which would defeat the point.
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await p.evaluate(() => document.querySelector('[data-act="solo"]')?.click());
  await sleep(400);
  await p.evaluate(() => document.querySelector('[data-act="resume"]')?.click());
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  await sleep(1500);
  const back = await p.evaluate(() => ({
    running: !!window.game?._running, mode: window.game?.mode,
    arts: (window.game?.player?.equipment || []).filter((e) => e.kind === 'artifact').length,
  }));
  check('the reloaded session sees the farmed pieces',
    back.running === true && back.mode === 'solo' && back.arts >= dropped,
    `${back.arts} artifacts after ${dropped} drops`);

  await p.keyboard.press('KeyB');
  await sleep(1200);
  check('B opens the bag', (await panelTitle()) === '背包');
  check('the 圣遗物 tab is reachable', await clickTab('artifact'));
  await sleep(800);
  let grid = await slots();
  check('the farmed artifacts are listed', grid.length >= dropped,
    `${grid.length} slots, e.g. ${grid[0]?.name} ${grid[0]?.lv}`);
  await shot('artifacts');

  // Pick the lowest piece as the target: it has the most room to climb.
  const lvOf = (s) => Number((s.lv.match(/(\d+)/) || [0, 0])[1]);
  const sorted = [...grid].filter((s) => s.uid).sort((a, l) => lvOf(a) - lvOf(l));
  const target = sorted[0];
  check('a piece can be selected', await clickSlot(target.uid), `${target.name} ${target.lv}`);
  await sleep(600);
  let text = await detail();
  check('the detail column prices the next level',
    /下一级需 [\d,]+ 强化经验/.test(text) && /满级还需 [\d,]+/.test(text),
    text.replace(/\s+/g, ' ').slice(0, 120));
  check('and offers both 强化 and 锁定', text.includes('强化') && text.includes('锁定'));
  await shot('selected');

  check('强化 opens the fodder picker', await clickBtn('强化'));
  await sleep(700);
  text = await detail();
  check('the picker explains what will be eaten', text.includes('已选 0 件'),
    text.replace(/\s+/g, ' ').slice(0, 140));
  grid = await slots();
  check('the target is marked as the target',
    grid.find((s) => s.uid === target.uid)?.cls.includes('target'),
    grid.find((s) => s.uid === target.uid)?.cls);
  check('confirming with nothing marked is refused',
    (await clickBtn('确认强化')) === false);

  // Mark fodder until the pane says a level would actually be gained.
  const others = sorted.filter((s) => s.uid !== target.uid);
  let marked = 0;
  for (const s of others) {
    await clickSlot(s.uid);
    marked++;
    await sleep(350);
    text = await detail();
    if (/→ \+\d+/.test(text)) break;
  }
  check('marking fodder previews the level it buys', /→ \+\d+/.test(text),
    `${marked} marked: ${text.replace(/\s+/g, ' ').slice(0, 140)}`);
  grid = await slots();
  check('the marked pieces read as fodder, not as selection',
    grid.filter((s) => s.cls.includes('fodder')).length === marked,
    grid.filter((s) => s.cls.includes('fodder')).map((s) => s.lv).join(' '));
  await shot('fodder');

  const before = lvOf(target);
  check('确认强化 is clickable', await clickBtn('确认强化'));
  await sleep(2000);
  grid = await slots();
  const after = grid.find((s) => s.uid === target.uid);
  check('the level in the grid went up without reopening the bag',
    !!after && lvOf(after) > before, `+${before} → ${after?.lv}`);
  check('the eaten pieces left the grid', grid.length === (await p.evaluate(() =>
    (window.game?.player?.equipment || []).filter((e) => e.kind === 'artifact').length)),
    `${grid.length} slots`);
  const toast = await p.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
  check('the player is told what changed', /强化成功/.test(toast), toast.slice(0, 120));
  await shot('enhanced');

  // The lock is the only protection against a mis-click, so it has to survive a redraw.
  const keeper = grid.find((s) => s.uid && s.uid !== target.uid);
  if (keeper) {
    await clickBtn('返回');
    await sleep(500);
    await clickSlot(keeper.uid);
    await sleep(500);
    check('a piece can be locked from the panel', await clickBtn('锁定'));
    await sleep(1200);
    grid = await slots();
    check('the lock shows on the slot after the redraw',
      (grid.find((s) => s.uid === keeper.uid)?.lv || '').includes('🔒'),
      grid.find((s) => s.uid === keeper.uid)?.lv);
    text = await detail();
    check('and the panel now offers to unlock it instead', text.includes('解锁'));
    await shot('locked');
  }

  /* ---------------------------------------------------------- 武器强化/精炼 --- */

  // Same question as the artifact half, asked of the other axis: `api-check` proves the
  // two routes, this proves a player can find them. The ore stepper is the part that only
  // a browser can answer — it is the one input in the whole panel that is not a click on
  // a grid slot, so nothing else in the suite would notice if 全部 stopped adding up.
  await clickBtn('返回');
  await sleep(400);
  check('the 武器 tab is reachable', await clickTab('weapon'));
  await sleep(800);
  grid = await slots();
  check('the pulled weapons are listed', grid.length >= 3,
    `${grid.length} slots, e.g. ${grid[0]?.name} ${grid[0]?.lv}`);
  await shot('weapons');

  const wLv = (s) => Number((s.lv.match(/Lv\.(\d+)/) || [0, 0])[1]);
  const wpn = [...grid].filter((s) => s.uid).sort((a, l) => wLv(a) - wLv(l))[0];
  check('a weapon can be selected', await clickSlot(wpn.uid), `${wpn.name} ${wpn.lv}`);
  await sleep(600);
  text = await detail();
  check('the detail column prices the next weapon level',
    /下一级需 [\d,]+ 强化经验/.test(text) && /Lv\.\d+ 还需 [\d,]+/.test(text),
    text.replace(/\s+/g, ' ').slice(0, 140));
  check('强化 opens the ore pane', await clickBtn('强化'));
  await sleep(700);
  const oreState = await p.evaluate(() => ({
    steppers: [...document.querySelectorAll('.panel .stepper[data-ore]')].map((s) => s.dataset.ore),
    held: window.game?.player?.inventory || {},
  }));
  // Every kind is listed (that is how the ×2 ladder is legible) but only the kinds the
  // player actually holds get controls — a stepper you cannot move is furniture, and in a
  // 200 px column it is furniture that pushes 确认强化 off the bottom.
  const held = WEAPON_ORE.filter((o) => (oreState.held[o] || 0) > 0);
  check('the pane offers a stepper for every ore kind the player holds',
    held.length > 0 && held.every((o) => oreState.steppers.includes(o))
      && oreState.steppers.every((o) => held.includes(o)),
    `holds ${held.join(' ')} / steppers ${oreState.steppers.join(' ')}`);
  const paneText = await detail();
  check('and still names all four kinds, including the ones held at zero',
    WEAPON_ORE.every((o) => paneText.includes(MATERIALS[o].name)),
    WEAPON_ORE.filter((o) => !paneText.includes(MATERIALS[o].name)).join(' ') || 'all four named');
  // The primary action has to be on screen without scrolling — a confirm button below the
  // fold of a 234 px column is the same as no confirm button.
  const reach = await p.evaluate(() => {
    const btn = [...document.querySelectorAll('.panel button')].find((x) => x.textContent.includes('确认强化'));
    if (!btn) return null;
    const col = btn.closest('.col');
    const b = btn.getBoundingClientRect(), c = col.getBoundingClientRect();
    return { bottom: Math.round(b.bottom), limit: Math.round(c.bottom), scroll: col.scrollTop };
  });
  check('确认强化 is visible without scrolling the column',
    reach && reach.scroll === 0 && reach.bottom <= reach.limit,
    reach ? `button bottom ${reach.bottom} vs column ${reach.limit}` : 'no button');
  // 全部 on the cheapest ore. The pane clamps to what a full climb needs, so this is also
  // the check that the client's preview agrees with the route about the stopping point.
  check('全部 pours the cheapest ore in', await p.evaluate(() => {
    const row = document.querySelector('.panel .stepper[data-ore="ironChunk"]');
    const btn = row && [...row.querySelectorAll('button')].find((x) => x.textContent.includes('全部'));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }));
  await sleep(700);
  text = await detail();
  check('the pane previews the level the ore buys', /Lv\.\d+ → Lv\.(\d+)/.test(text),
    text.replace(/\s+/g, ' ').slice(0, 160));
  check('and prices it in mora', /摩拉 [\d,]+/.test(text));
  await shot('ore');

  const wBefore = wLv(wpn);
  check('确认强化 is clickable for a weapon', await clickBtn('确认强化'));
  await sleep(2000);
  grid = await slots();
  const wAfter = grid.find((s) => s.uid === wpn.uid);
  check('the weapon level in the grid went up without reopening the bag',
    !!wAfter && wLv(wAfter) > wBefore, `Lv.${wBefore} → ${wAfter?.lv}`);
  const wToast = await p.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
  check('the player is told how far the weapon got', /强化/.test(wToast), wToast.slice(0, 120));
  await shot('weapon-levelled');

  // Refinement is the promise the README has been making since the first commit ("15 把
  // 武器可精炼") and the panel is where it either exists or does not.
  const dupe = await p.evaluate(() => {
    const eq = (window.game?.player?.equipment || []).filter((e) => e.kind === 'weapon');
    const by = {};
    for (const e of eq) (by[e.weaponId] = by[e.weaponId] || []).push(e);
    const stack = Object.values(by).find((v) => v.filter((e) => !e.equippedBy && !e.locked).length >= 2);
    return stack ? { uid: stack.find((e) => !e.equippedBy && !e.locked).uid, id: stack[0].weaponId } : null;
  });
  if (check('the pulls left a duplicate weapon in the bag', !!dupe, dupe?.id)) {
    await clickSlot(dupe.uid);
    await sleep(600);
    text = await detail();
    check('the panel offers to refine with the duplicate it found',
      /精炼（\d+ 把同名武器）/.test(text), text.replace(/\s+/g, ' ').slice(0, 160));
    check('精炼 is clickable', await clickBtn('精炼（'));
    await sleep(2000);
    grid = await slots();
    check('the refinement rank shows on the slot after the redraw',
      (grid.find((s) => s.uid === dupe.uid)?.lv || '').includes('R'),
      grid.find((s) => s.uid === dupe.uid)?.lv);
    text = await detail();
    check('and the detail column says what the passive is now worth',
      /精炼 \d／\d · 被动效果 ×[\d.]+/.test(text), text.replace(/\s+/g, ' ').slice(0, 160));
    await shot('refined');
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('probe ran to completion', false, e?.message || String(e));
  await shot('crash').catch(() => {});
} finally {
  await b.close().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail);
