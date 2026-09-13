// 倒下与锚点 probe: what happens when you die, and what an activated anchor is worth.
//
//   DISPLAY=:99 node tools/death-check.mjs [baseUrl] [outDir]
//
// One cluster of defects, all of the same shape — a promise with no consumer:
//
//   1. The death panel offered 「原地复苏」 and 「返回最近的锚点」 and both buttons sent
//      `C2S.REVIVE`. So the second one spent a 提神醒脑的汤 you probably did not have, failed with
//      `no_revive_item`, and left you lying in the grass with nothing to do but wait.
//   2. `world_progress` has stored `{unlocked:true}` for waypoints and statues since the first
//      commit, an achievement counted those rows and the map drew them. `POST /api/world/teleport`
//      never read them: any pin was a free jump, so the 5 原石 an anchor pays bought a diamond on
//      the map and nothing else, and walking there was optional in a game about walking there.
//   3. The auto-respawn went to `poi.find(p => p.type === 'waypoint')` — the *first* waypoint in
//      the table, not the nearest, and not one you had earned. 「最近的锚点」 was a sentence on a
//      button that no code implemented.
//   4. The banner under a death said 「按 R 复活」. `KEYMAP.aim` is `KeyR`; R has never revived
//      anyone. The same drift shipped a boot tip pointing at Tab (the map) for the friend list.
//   5. The gateway's teammate branch of `C2S.REVIVE` (free, within `REVIVE_RANGE`) had no caller
//      anywhere in the client, and downed teammates were `setVisible(false)` — there was nothing
//      to click and nothing to walk to.
//
// Sections 1–3 are node: the anchor rules against the real zone tables, the structural rules that
// keep one sentence in one place, and the REST lock on a freshly minted guest. Section 4 downs a
// real character in a real browser: it activates a second anchor through the product's own unlock
// path first, because with only the entry lit 「最近的锚点」 has one candidate and proves nothing.
//
// Exit code is 1 if anything failed.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { decodePng, rectStats } from './lib/png.mjs';
import {
  TELEPORT_TYPES, anchorList, defaultAnchor, isAnchorUnlocked, nearestAnchor, unlockedAnchors,
  anchorName, zoneProgress,
} from '../shared/src/data/anchors.js';
import { ZONES, ZONE_IDS } from '../shared/src/data/zones.js';
import { C2S } from '../shared/src/protocol.js';
import { AUTO_RESPAWN_SEC } from '../shared/src/world/zoneInstance.js';
import { REVIVE_RANGE, REVIVE_HP_PCT } from '../shared/src/world/entity.js';
import { KEYMAP, ACTION_INFO } from '../client/src/game/input.js';
import { MATERIALS } from '../shared/src/data/items.js';

const base = process.argv[2] || 'http://127.0.0.1:5173';
const outDir = process.argv[3] || '/tmp/death-check';
const ORIGIN = process.env.API_BASE || 'http://127.0.0.1:8787';
const W = 1600, H = 900;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0, skip = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return !!ok;
}
function note(name, why) { skip++; console.log(`  SKIP ${name} — ${why}`); }

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const nocomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = {
  hud: read('client/src/ui/hud.js'),
  game: read('client/src/game/game.js'),
  panels: read('client/src/ui/panels.js'),
  actors: read('client/src/game/actors.js'),
  socket: read('client/src/net/socket.js'),
  local: read('client/src/net/localSocket.js'),
  gateway: read('server/src/ws/gateway.js'),
  world: read('server/src/routes/world.js'),
  inst: read('shared/src/world/zoneInstance.js'),
  anchors: read('shared/src/data/anchors.js'),
  entity: read('shared/src/world/entity.js'),
  localPlayer: read('client/src/game/localPlayer.js'),
  input: read('client/src/game/input.js'),
  api: read('client/src/net/api.js'),
  css: read('client/src/ui/style.css'),
};

const MOND = ZONES.mondstadt;
const ENTRY = defaultAnchor(MOND);
const FAR = anchorList(MOND).find((p) => p.id !== ENTRY.id && p.type === 'waypoint');
const STATUE = anchorList(MOND).find((p) => p.type === 'statue');
const DISH = MATERIALS.reviveDish?.name || '复苏道具';

/* ================================= 1. anchors are a query on the save ============ */

console.log('--- 1. which anchors exist, and which of them you have earned');

check('every zone has an anchor to arrive at',
  ZONE_IDS.every((id) => !!defaultAnchor(ZONES[id])),
  ZONE_IDS.filter((id) => !defaultAnchor(ZONES[id])).join(' ') || `${ZONE_IDS.length} zones`);
check('...and a zone\'s anchors are its waypoints and statues, nothing else',
  ZONE_IDS.every((id) => anchorList(ZONES[id]).every((p) => TELEPORT_TYPES.has(p.type))),
  `${ZONE_IDS.reduce((n, id) => n + anchorList(ZONES[id]).length, 0)} anchors in ${ZONE_IDS.length} zones`);
check('...and every open zone has several, or "nearest" is a constant',
  ZONE_IDS.filter((id) => ZONES[id].kind === 'open').every((id) => anchorList(ZONES[id]).length >= 2),
  ZONE_IDS.filter((id) => ZONES[id].kind === 'open')
    .map((id) => `${id}:${anchorList(ZONES[id]).length}`).join(' '));

check('the anchor you arrive at is travellable with an empty save',
  isAnchorUnlocked(MOND, ENTRY, {}), `${anchorName(ENTRY)} (${ENTRY.id})`);
check('...and every other anchor is not',
  anchorList(MOND).filter((p) => p.id !== ENTRY.id).every((p) => !isAnchorUnlocked(MOND, p, {})),
  anchorList(MOND).filter((p) => p.id !== ENTRY.id).map((p) => p.id).join(' '));
check('...so a fresh save can travel to exactly one place in 蒙德',
  unlockedAnchors(MOND, {}).length === 1, `${unlockedAnchors(MOND, {}).length} unlocked`);
check('...and activating one adds exactly that one',
  unlockedAnchors(MOND, { [FAR.id]: { unlocked: true } }).map((p) => p.id).sort().join(',')
  === [ENTRY.id, FAR.id].sort().join(','), `${ENTRY.id} + ${FAR.id}`);

// The claim the button's label makes: nearest *among the ones you have earned*.
check('standing on an anchor you have not earned, you fall back to the entry',
  nearestAnchor(MOND, FAR.at[0], FAR.at[1], {}).id === ENTRY.id,
  `at (${FAR.at.join(', ')}) → ${nearestAnchor(MOND, FAR.at[0], FAR.at[1], {}).id}`);
check('...and once it is earned, that is where you come back',
  nearestAnchor(MOND, FAR.at[0], FAR.at[1], { [FAR.id]: { unlocked: true } }).id === FAR.id,
  `at (${FAR.at.join(', ')}) → ${anchorName(FAR)}`);
check('...and it is genuinely nearest, not first: from the entry you get the entry',
  nearestAnchor(MOND, 4, 4, { [FAR.id]: { unlocked: true } }).id === ENTRY.id,
  `at (4, 4) → ${nearestAnchor(MOND, 4, 4, { [FAR.id]: { unlocked: true } }).id}`);
{
  const selfWrong = [];
  for (const id of ZONE_IDS) {
    const z = ZONES[id];
    const prog = Object.fromEntries(anchorList(z).map((p) => [p.id, { unlocked: true }]));
    for (const p of anchorList(z)) {
      if (nearestAnchor(z, p.at[0], p.at[1], prog).id !== p.id) selfWrong.push(`${id}/${p.id}`);
    }
  }
  check('with everything unlocked, every anchor is its own nearest anchor',
    selfWrong.length === 0, selfWrong.join(' ') || 'every anchor of every zone');
}
check('a chest is never a destination, even with a row against its id',
  (MOND.poi || []).filter((p) => !TELEPORT_TYPES.has(p.type))
    .every((p) => !anchorList(MOND).some((a) => a.id === p.id)),
  `${(MOND.poi || []).filter((p) => !TELEPORT_TYPES.has(p.type)).length} chests/puzzles/npcs excluded`);
check('the progress reader survives the shapes its callers actually hold',
  JSON.stringify(zoneProgress(null, 'mondstadt')) === '{}'
  && JSON.stringify(zoneProgress(undefined, 'mondstadt')) === '{}'
  && JSON.stringify(zoneProgress({}, 'mondstadt')) === '{}'
  && zoneProgress({ mondstadt: { a: 1 } }, 'mondstadt').a === 1);

// A gate that cannot fail is a comment. These are the two rules that actually shipped, kept here
// as functions: if the assertions above cannot tell them apart from the new ones, they are not
// testing anything. Both disagree with the current code on a real save.
{
  const shippedRespawn = (zdef) => (zdef.poi || []).find((x) => x.type === 'waypoint');
  const shippedTeleportAllows = () => true;
  const prog = { [FAR.id]: { unlocked: true } };
  check('the respawn assertions tell the new rule from the one that shipped',
    shippedRespawn(MOND).id !== nearestAnchor(MOND, FAR.at[0], FAR.at[1], prog).id,
    `first-waypoint says ${shippedRespawn(MOND).id}, nearest-unlocked says ${FAR.id}`);
  check('...and the lock assertions likewise',
    shippedTeleportAllows(FAR) !== isAnchorUnlocked(MOND, FAR, {}),
    `the old route allowed ${FAR.id} on an empty save, the new one does not`);
}

/* ================================= 2. one sentence, one place ==================== */

console.log('\n--- 2. the message, the button and the key all come from one place');

// Both hosts must answer every message the client can send. A word with a sender and no handler
// in one host is a feature that silently only works online, or only solo.
{
  // Either dispatch form counts: the handshake is answered before the switch in both hosts
  // (`if (t === C2S.HELLO)`), everything else is a `case`.
  const handled = (src, k) => new RegExp(`case C2S\\.${k}\\b|t === C2S\\.${k}\\b`).test(src);
  const keys = Object.keys(C2S);
  const gaps = keys.filter((k) => !handled(nocomment(code.gateway), k) || !handled(nocomment(code.local), k));
  check('every C2S message is handled by both hosts', gaps.length === 0 && keys.length > 0,
    gaps.join(' ') || `${keys.length} messages × 2 hosts`);
  const nosender = keys.filter((k) => !new RegExp(`C2S\\.${k}\\b`).test(nocomment(code.socket)));
  check('...and every one of them has a sender in the client', nosender.length === 0,
    nosender.join(' ') || `${keys.length} senders in socket.js`);
  check('...including the one this iteration added',
    !!C2S.RESPAWN && handled(nocomment(code.gateway), 'RESPAWN') && handled(nocomment(code.local), 'RESPAWN')
    && /respawn\(\)\s*\{\s*this\.send\(C2S\.RESPAWN/.test(nocomment(code.socket)),
    `C2S.RESPAWN = '${C2S.RESPAWN}'`);
  check('...with a UI caller, or it is a door nobody can open',
    /socket\.respawn\(\)/.test(nocomment(code.hud)), 'hud.js dispatches it');
}

// The defect that started this: two buttons, one behaviour.
{
  const hud = nocomment(code.hud);
  const revive = hud.match(/act === 'revive'\)([^\n;]*)/)?.[1] || '';
  const respawn = hud.match(/act === 'respawn'\)([^\n;]*)/)?.[1] || '';
  check('the death panel has both buttons wired', !!revive.trim() && !!respawn.trim(),
    `${revive.trim()} / ${respawn.trim()}`);
  check('...and they do different things',
    revive.trim() !== respawn.trim() && /revive\(/.test(revive) && /respawn\(/.test(respawn),
    `原地复苏 → ${revive.trim()} | 返回锚点 → ${respawn.trim()}`);
  check('...and the panel names the item the first spends and the anchor the second reaches',
    /reviveDish/.test(hud) && /anchorName\(/.test(hud));
  check('...and disables the first when the item is gone, with a reason',
    /revivebtn\.disabled\s*=/.test(hud) && /revivebtn\.title\s*=/.test(hud));
  check('the countdown uses the simulation\'s own constant, not a typed 8',
    /AUTO_RESPAWN_SEC/.test(hud) && /world\/zoneInstance\.js'/.test(hud)
    && !/8 秒后/.test(hud), `AUTO_RESPAWN_SEC = ${AUTO_RESPAWN_SEC}`);
  check('...and has somewhere to be drawn', /\.downed \.wait/.test(code.css));
  check('...and counts off a clock, not off the frame\'s clamped dt',
    /AUTO_RESPAWN_SEC - \(now\(\) - this\._downAt\)/.test(hud) && !/_downT/.test(hud),
    'a dt sum runs slow whenever a frame is long, and the sim\'s timer does not');
  check('...and is blanked on the way up, so the next death does not open on a stale line',
    /revived'[\s\S]{0,200}downedwait/.test(hud));
}

// The auto timer and the button must land in the same place, or there are two mechanics.
{
  const inst = nocomment(code.inst);
  check('the respawn is one method on the instance',
    /respawnAtAnchor\(p, \{ auto = false \} = \{\}\)/.test(inst)
    && /this\.respawnAtAnchor\(p, \{ auto: true \}\)/.test(inst),
    'defined once; the timer and C2S.RESPAWN both call it');
  check('...and it asks the shared function where to go',
    /nearestAnchor\(/.test(inst) && /from '\.\.\/data\/anchors\.js'/.test(inst));
  check('...reading the player\'s own progress, not the zone table',
    /zoneProgress\(p\.save\?\.worldProgress, this\.zoneId\)/.test(inst));
  check('both hosts call it rather than repeating it',
    /respawnAtAnchor\(entity/.test(nocomment(code.gateway))
    && /respawnAtAnchor\(entity/.test(nocomment(code.local)));
  check('the REVIVED event carries the position and the anchor, or the client cannot move',
    /S2C\.REVIVED, \{[\s\S]{0,260}anchor:/.test(inst) && /anchorName:/.test(inst));
  // Anchored on the *definition*: `_onRevived` also appears in the `s.on(S2C.REVIVED, …)` line
  // 370 lines earlier, and a window opened there reads a different method's body entirely.
  const onRevived = nocomment(code.game).match(/_onRevived\(d\) \{[\s\S]{0,900}/)?.[0] || '';
  check('...and the client teleports on it instead of waiting for a correction to drag it home',
    /Number\.isFinite\(d\.x\)/.test(onRevived) && /teleportTo\(d\.x/.test(onRevived));
  check('...and names the anchor it woke up at, from the event rather than from a guess',
    /d\.anchorName/.test(onRevived) && /最近的锚点/.test(onRevived));
  check('the timer lives in shared/, where both hosts read it',
    /export const AUTO_RESPAWN_SEC/.test(code.inst), `${AUTO_RESPAWN_SEC} s`);
}

// The duplicated `find(type === 'waypoint')` this iteration replaced: five copies of one rule is
// five places for it to drift, and one of them was the auto-respawn.
{
  const dupes = Object.entries(code)
    .filter(([f]) => f !== 'anchors')
    .filter(([, src]) => /\.find\(\s*\(?\w+\)?\s*=>\s*\w+\.type === 'waypoint'\s*\)/.test(nocomment(src)))
    .map(([f]) => f);
  check('nobody hand-rolls "the first waypoint" any more', dupes.length === 0,
    dupes.join(' ') || 'every caller goes through defaultAnchor');
  check('...and the rules live in shared/, because two hosts and one route read them',
    /export function nearestAnchor/.test(code.anchors) && /export function defaultAnchor/.test(code.anchors)
    && /export function isAnchorUnlocked/.test(code.anchors));
}

// Fast travel has to read the rows the unlock route writes.
{
  const w = nocomment(code.world);
  const tp = w.slice(w.indexOf("'/api/world/teleport'"));
  const next = tp.indexOf('app.post', 10);
  const body = tp.slice(0, next > 0 ? next : 4000);
  check('the teleport route asks whether the anchor is unlocked',
    /isAnchorUnlocked\(/.test(body) && /anchor_locked/.test(body));
  check('...and refuses a POI that is not an anchor, instead of silently using the entry',
    /TELEPORT_TYPES\.has\(/.test(body) && /no_such_anchor/.test(body));
  check('...and the unlock route still writes the row it reads',
    /worldProgress\[[^\]]+\]\[[^\]]+\] = \{ unlocked: true \}/.test(w));
  check('the map pin shows the lock before the route has to answer for it',
    /isAnchorUnlocked\(/.test(nocomment(code.panels)) && /dataset\.locked/.test(nocomment(code.panels))
    && /\.pin\.locked/.test(code.css));
  check('...and both new error codes have Chinese text',
    ['anchor_locked', 'no_such_anchor'].every((c) => new RegExp(`  ${c}: '`).test(code.api)));
}

// A key promise is a claim about a table in another file. It has to be looked up.
{
  const walk = (d, out = []) => {
    for (const f of readdirSync(d)) {
      const path = `${d}/${f}`;
      if (statSync(path).isDirectory()) walk(path, out);
      else if (f.endsWith('.js')) out.push(path);
    }
    return out;
  };
  const files = walk(new URL('../client/src', import.meta.url).pathname);
  // Two forms, because the UI used both: 「按 R 复活」 in prose, and 「有未领取的邮件 (I)」 in a
  // tooltip. The second is the same claim about `KEYMAP` with the verb left off.
  const RE = '按(?:住)?\\s*(?:<kbd>)?([A-Za-z][A-Za-z0-9]*)\\b';
  const TITLE_RE = 'title="[^"]*\\(([A-Z])\\)"';
  const offenders = [];
  for (const f of files) {
    if (f.endsWith('/game/input.js')) continue;      // the one file allowed to name a key
    const src = nocomment(readFileSync(f, 'utf8'));
    const where = f.split('/client/src/')[1];
    for (const m of src.matchAll(new RegExp(RE, 'g'))) offenders.push(`${where}: 按 ${m[1]}`);
    for (const m of src.matchAll(new RegExp(TITLE_RE, 'g'))) offenders.push(`${where}: title (${m[1]})`);
  }
  check('no UI string types a key name — every one is looked up in KEYMAP',
    offenders.length === 0, offenders.join(' | ') || `${files.length} client files scanned`);
  check('...in a tooltip either, which is where three of them were hiding',
    new RegExp(TITLE_RE).test('title="有未领取的邮件 (I)"')
    && !new RegExp(TITLE_RE).test('title="有未领取的邮件，点击或按 I 打开"'));
  check('...and the lookup exists', /export function keyHint/.test(code.input));
  // The negative control: the rule has to reject the line that shipped for months.
  check('...and the rule would have caught 「按 R 复活」',
    new RegExp(RE).test('按 R 复活，或等待队友救援'));
  const rAction = Object.entries(KEYMAP).find(([, codes]) => codes.includes('KeyR'))?.[0];
  check('...which is the interesting case: R is bound, to something else entirely',
    !!rAction && !/复活|复苏/.test(ACTION_INFO[rAction]?.what || ''),
    `KeyR → ${rAction} (${ACTION_INFO[rAction]?.what})`);
  const tabAction = Object.entries(KEYMAP).find(([, codes]) => codes.includes('Tab'))?.[0];
  check('...as is Tab, which the boot tip used to offer for the friend list',
    tabAction === 'map' && KEYMAP.social?.[0] === 'KeyU',
    `Tab → ${tabAction}, 好友 → ${KEYMAP.social?.join('/')}`);
}

// The teammate branch of REVIVE had no caller for as long as it has existed.
{
  const g = nocomment(code.game);
  check('a downed teammate can be clicked',
    /pickPlayer\(/.test(nocomment(code.actors)) && /pickPlayer\(/.test(g),
    'actors.pickPlayer + a branch in _leftClick');
  check('...and stays on screen to be clicked at all',
    /setVisible\(true\)/.test(nocomment(code.actors))
    && !/setVisible\(e\.alive\)/.test(nocomment(code.actors)));
  check('...and out of range the click walks there and revives on arrival',
    /'rescue'/.test(g) && /=== 'rescue'/.test(g) && /'rescue'/.test(nocomment(code.localPlayer)));
  check('...and client and gateway agree on the range, from one constant',
    /REVIVE_RANGE/.test(g) && /REVIVE_RANGE/.test(nocomment(code.gateway))
    && /export const REVIVE_RANGE/.test(code.entity),
    `${REVIVE_RANGE} m, free pick-up at ${Math.round(REVIVE_HP_PCT * 100)}% hp`);
}

/* ================================= 3. the lock, over REST ======================== */

console.log('\n--- 3. a fresh guest cannot jump to an anchor they have not lit');

let token = '';
async function callApi(method, path, body) {
  const r = await fetch(ORIGIN + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* empty body */ }
  return { status: r.status, b: json ?? {} };
}

const health = await callApi('GET', '/api/health');
if (health.status !== 200) {
  note('the REST lock', `server not answering on ${ORIGIN}`);
} else {
  const guest = await callApi('POST', '/api/guest', {});
  token = guest.b.token || '';
  check('a guest to test the lock on', !!token, `player ${guest.b.playerId}`);

  const locked = await callApi('POST', '/api/world/teleport', { zone: 'mondstadt', poiId: FAR.id });
  check(`travelling to a dark ${anchorName(FAR)} is refused`,
    locked.status === 403 && locked.b.error === 'anchor_locked', `${locked.status} ${locked.b.error}`);
  const chest = (MOND.poi || []).find((x) => !TELEPORT_TYPES.has(x.type));
  const notAnchor = await callApi('POST', '/api/world/teleport', { zone: 'mondstadt', poiId: chest.id });
  check('...and a chest is not a destination, rather than a quiet fallback to the entry',
    notAnchor.status === 404 && notAnchor.b.error === 'no_such_anchor',
    `${chest.type} ${chest.id} → ${notAnchor.status} ${notAnchor.b.error}`);
  const entry = await callApi('POST', '/api/world/teleport', { zone: 'mondstadt', poiId: ENTRY.id });
  check('...but the anchor you arrive at is always open',
    entry.status === 200 && Math.hypot(entry.b.pos.x - ENTRY.at[0], entry.b.pos.z - ENTRY.at[1]) < 14,
    `${entry.status} → (${Math.round(entry.b.pos?.x)}, ${Math.round(entry.b.pos?.z)})`);
  const noPoi = await callApi('POST', '/api/world/teleport', { zone: 'mondstadt' });
  check('...and so is travelling with no anchor named at all', noPoi.status === 200, `${noPoi.status}`);

  const unlock = await callApi('POST', '/api/world/unlock', { zone: 'mondstadt', poiId: FAR.id });
  check(`lighting ${anchorName(FAR)} pays and records`,
    unlock.status === 200 && unlock.b.first === true
    && unlock.b.player?.worldProgress?.mondstadt?.[FAR.id]?.unlocked === true,
    `+${unlock.b.reward?.primogem || 0} 原石`);
  const now = await callApi('POST', '/api/world/teleport', { zone: 'mondstadt', poiId: FAR.id });
  check('...and only then does the jump work',
    now.status === 200 && Math.hypot(now.b.pos.x - FAR.at[0], now.b.pos.z - FAR.at[1]) < 14,
    `${now.status} → (${Math.round(now.b.pos?.x)}, ${Math.round(now.b.pos?.z)})`);
  const stillLocked = await callApi('POST', '/api/world/teleport', { zone: 'mondstadt', poiId: STATUE.id });
  check('...while the statue beside the entry is still dark',
    stillLocked.status === 403 && stillLocked.b.error === 'anchor_locked',
    `${anchorName(STATUE)} → ${stillLocked.status} ${stillLocked.b.error}`);

  // The same question the simulation asks, on the save the server just wrote.
  const state = await callApi('GET', '/api/player/state');
  const prog = zoneProgress(state.b.player?.worldProgress, 'mondstadt');
  check('the save now names two travellable anchors', unlockedAnchors(MOND, prog).length === 2,
    unlockedAnchors(MOND, prog).map((x) => x.id).join(' '));
  check('...so dying beside the far one would come back to the far one',
    nearestAnchor(MOND, FAR.at[0] + 6, FAR.at[1] + 6, prog).id === FAR.id);
  check('...and dying beside the dark statue comes back to the nearest *lit* anchor, not to it',
    nearestAnchor(MOND, STATUE.at[0], STATUE.at[1], prog).id === ENTRY.id,
    `→ ${nearestAnchor(MOND, STATUE.at[0], STATUE.at[1], prog).id}`);
}

/* ================================= 4. dying, in a real browser =================== */

console.log('\n--- 4. the death panel, and coming back');

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
const NOISE = /favicon|AudioContext|WebGL warning|Content-Security/i;
const errors = [];
p.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text().slice(0, 200)); });
p.on('pageerror', (e) => { if (!NOISE.test(String(e))) errors.push(`[pageerror] ${String(e).slice(0, 200)}`); });

let step = 0;
async function shot(name) {
  step++;
  const file = `${outDir}/${String(step).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file });
  console.log(`  → ${file}`);
}
/** llvmpipe renders this page at ~3 fps, so waiting in milliseconds is waiting on nothing. */
async function frames(n = 3) {
  const from = await p.evaluate(() => window.__probeFrames || 0);
  for (let i = 0; i < 500; i++) {
    const now = await p.evaluate(() => window.__probeFrames || 0);
    if (now - from >= n) return now - from;
    await sleep(120);
  }
  return -1;
}
/** Everything the death panel is saying, plus the state behind it. */
const panel = () => p.evaluate(() => {
  const btn = (f) => {
    const e = document.querySelector(`[data-f="${f}"]`);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return {
      text: e.textContent, disabled: !!e.disabled, title: e.title,
      w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y),
    };
  };
  const g = window.game;
  return {
    shown: !!document.querySelector('[data-f="downed"]')?.classList.contains('show'),
    sub: document.querySelector('[data-f="downedsub"]')?.textContent || '',
    wait: document.querySelector('[data-f="downedwait"]')?.textContent || '',
    revive: btn('revivebtn'),
    respawn: btn('respawnbtn'),
    alive: !!g.me.alive,
    hp: Math.round(g.me.hp),
    at: { x: +g.me.x.toFixed(1), z: +g.me.z.toFixed(1) },
    dishes: g.player?.inventory?.reviveDish || 0,
    banners: [...(window.__banners || [])],
    toasts: [...document.querySelectorAll('[data-f="toasts"] .toast')].map((t) => t.textContent),
  };
});
/**
 * Down the player through the simulation — the same call an enemy's hit makes.
 *
 * One lethal hit is not a death: `PlayerEntity.takeDamage` swaps to the next party member with
 * hp left and only sets `alive = false` when none is (蒙德 starts you with a party, so the first
 * hit just changes who you are playing). A probe that hits once is testing a state the game
 * never shows — it reads `hp 1290` on a standing character and calls the panel broken.
 */
const downMe = () => p.evaluate(() => {
  const g = window.game;
  window.__banners = [];
  const e = g.socket.entity || g.socket.inst.players.get(g.playerId);
  const knocked = [];
  for (let i = 0; i < 8 && e.alive; i++) {
    knocked.push(e.charId);
    e.takeDamage(e.maxHp() * 99, g.socket.inst.now);
  }
  return { alive: e.alive, downedAt: +e.downedAt.toFixed(2), knocked };
});
const simAnchor = () => p.evaluate(() => {
  const g = window.game;
  const e = g.socket.entity || g.socket.inst.players.get(g.playerId);
  const a = g.socket.inst.respawnAnchor(e);
  return a ? { id: a.id, name: a.name, x: a.at[0], z: a.at[1] } : null;
});
const closeModal = async () => {
  await p.evaluate(() => { document.querySelector('.scrim .close')?.click(); });
  await sleep(500);
};

try {
  await p.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await (await p.$('[data-act="solo"]')).click();
  await sleep(500);
  // 「继续冒险」 is in the DOM on every boot with its row `hidden`, so picking it by selector
  // clicks a button the player cannot see — and with no stored token that path boots straight
  // into 「登录状态已失效」 and no `game.me` at all. Ask which row is actually showing.
  const how = await p.evaluate(() => {
    const resume = document.querySelector('[data-row="resume"]');
    const sel = resume && !resume.hidden ? '[data-act="resume"]' : '[data-act="guest"]';
    document.querySelector(sel).click();
    return sel;
  });
  console.log(`  (entering via ${how})`);
  for (let i = 0; i < 90; i++) {
    if (await p.evaluate(() => !!window.game?._running)) break;
    await sleep(1000);
  }
  check('the solo world booted',
    await p.evaluate(() => !!window.game?._running && window.game.mode === 'solo'));
  await p.evaluate(() => {
    window.__probeFrames = 0;
    window.__banners = [];
    window.game.on('frame', () => { window.__probeFrames++; });
    window.game.on('banner', (d) => window.__banners.push(`${d.title} ${d.sub || ''}`.trim()));
    window.game.tutorial?.skip?.();
  });
  // llvmpipe boots every probe at `low` and the governor keeps walking it down; pin the tier so
  // the frame this reads is the frame the target hardware shows.
  await p.evaluate(() => {
    window.game.setAutoQuality(false);
    window.game.setQuality('high');
    // Noon, pinned: see daylight-check.mjs — the authored sky is what 12:00 returns.
    window.game.setWorldTime(12);
  });
  await sleep(1500);
  check('the quality tier is pinned to high', (await p.evaluate(() => window.game.quality)) === 'high');
  check('the page is rendering, so a stale frame cannot pass for a fresh one', (await frames(4)) >= 4);

  const start = await panel();
  check('nothing is on screen while the traveller is standing', !start.shown && start.alive,
    `hp ${start.hp}, ${start.dishes} ${DISH}`);

  /* ------------------------------------------- the lock, through the client's own path -- */
  const beforeJump = { ...start.at };
  await p.evaluate((id) => window.game.teleport('mondstadt', id), FAR.id);
  await frames(3);
  const refused = await panel();
  const jumpMoved = Math.hypot(refused.at.x - beforeJump.x, refused.at.z - beforeJump.z);
  const wasLocked = check(`a fresh save cannot fast-travel to ${anchorName(FAR)}`, jumpMoved < 8,
    `moved ${jumpMoved.toFixed(1)} m`);
  check('...and the refusal is in Chinese, not a code',
    refused.toasts.some((t) => /还没有激活/.test(t)), refused.toasts.join(' | ') || '(no toast)');
  if (!wasLocked) note('the browser save', 'this account had already lit the far anchor');

  // Activate it the way walking into it does, so the browser has two lit anchors and 「最近的
  // 锚点」 is a real choice rather than the only candidate.
  const lit = await p.evaluate(async (id) => {
    const g = window.game;
    await g._unlock(g.world.poiById(id));
    return {
      row: !!g.player?.worldProgress?.mondstadt?.[id]?.unlocked,
      banners: [...(window.__banners || [])],
    };
  }, FAR.id);
  await frames(2);
  await closeModal();      // `_unlock` opens the map on a waypoint, as it does for a player
  check(`activating ${anchorName(FAR)} writes the row the route reads`, lit.row,
    lit.banners.join(' | '));
  await p.evaluate((id) => window.game.teleport('mondstadt', id), FAR.id);
  await frames(4);
  const arrived = await panel();
  check('...and now the jump lands there',
    Math.hypot(arrived.at.x - FAR.at[0], arrived.at.z - FAR.at[1]) < 14,
    `(${arrived.at.x}, ${arrived.at.z}) vs (${FAR.at.join(', ')})`);

  /* ------------------------------------------------------------ dying, away from it -- */
  // A few steps off the anchor: landing back on it has to be a move, not a no-op.
  await p.evaluate(() => { const g = window.game; g.me.setGoal(g.me.x + 22, g.me.z + 14, 'move'); });
  for (let i = 0; i < 30; i++) {
    await frames(3);
    if (!(await p.evaluate(() => !!window.game.me.goal))) break;
    if (await p.evaluate((at) => Math.hypot(window.game.me.x - at[0], window.game.me.z - at[1]) > 18, FAR.at)) break;
  }
  const away = await panel();
  let offAnchor = Math.hypot(away.at.x - FAR.at[0], away.at.z - FAR.at[1]);
  let farEnough = check('the traveller walked off the anchor before dying', offAnchor > 8,
    `${offAnchor.toFixed(1)} m from ${anchorName(FAR)}`);

  const dropped = await downMe();
  await frames(3);
  const dead = await panel();
  await shot('downed');
  check('downing the whole party downs the traveller', !dropped.alive && !dead.alive,
    `${dropped.knocked.join(' → ')} all out, hp ${dead.hp}`);
  check('...and the death panel comes up', dead.shown, dead.sub);

  // The countdown is measured *here*, first thing, and not further down with the rest of the
  // panel. Everything below (four frame waits and two screenshots) costs more wall time at 3 fps
  // than the whole 8 s window, and when the window closes the label correctly reads
  // 「正在返回锚点…」 — no digits in it — which a probe pulling a number out of that string scores
  // as "0 s" and reports as a frozen counter. It ran red exactly that way, on a build whose timer
  // was fine. Cf. the note on _downedTick in ui/hud.js: this assertion has caught a real frozen
  // counter before, so it is worth keeping pointed at a window it can actually see.
  const t1 = Number((dead.wait.match(/(\d+)/) || [])[1] || 0);
  check('the countdown is running, in seconds', /\d+ 秒后自动返回锚点/.test(dead.wait), dead.wait || '(empty)');
  check('...starting from the number the simulation uses',
    t1 <= AUTO_RESPAWN_SEC && t1 >= AUTO_RESPAWN_SEC - 3, `${t1} vs AUTO_RESPAWN_SEC=${AUTO_RESPAWN_SEC}`);
  // Polled, not slept: the event of interest is the *first* decrease, and a fixed 2.3 s sleep
  // spends a third of the window waiting for something that already happened.
  let t2 = t1, ms = 0, ended = '';
  for (let i = 0; i < 20 && t2 >= t1 && !ended; i++) {
    await sleep(350);
    ms += 350;
    const s = await panel();
    if (!s.shown || s.alive || /正在返回锚点/.test(s.wait)) { ended = s.wait || '(panel gone)'; break; }
    t2 = Number((s.wait.match(/(\d+)/) || [])[1] || 0);
  }
  check('...and it moves', t2 > 0 && t2 < t1,
    `${t1} s → ${t2} s after ${ms} ms${ended ? ` (window ended: ${ended})` : ''}`);
  check('...and the banner tells them where to look without naming a key',
    dead.banners.some((t) => /倒下/.test(t)) && !dead.banners.some((t) => /按\s*[A-Za-z]/.test(t)),
    dead.banners.join(' | ') || '(no banner)');
  check('the two buttons say different things',
    !!dead.revive && !!dead.respawn && dead.revive.text !== dead.respawn.text,
    `「${dead.revive?.text}」 vs 「${dead.respawn?.text}」`);
  check('...the first counts the item it would spend',
    new RegExp(`${DISH} ×${dead.dishes}\\b`).test(dead.revive.text || ''),
    `${dead.dishes} in the bag → 「${dead.revive.text}」`);
  check('...and is disabled exactly when there is none, with the reason on it',
    dead.revive.disabled === (dead.dishes < 1)
    && (dead.dishes >= 1 ? !dead.revive.title : /没有/.test(dead.revive.title)),
    `disabled=${dead.revive.disabled}, title 「${dead.revive.title}」`);
  const expect = await simAnchor();
  check('...and the second names the anchor the simulation would actually use',
    !!expect?.name && (dead.respawn.text || '').includes(expect.name),
    `sim says ${expect?.name} (${expect?.id}) → 「${dead.respawn.text}」`);
  check('...which is the one just activated, not the zone entry', expect?.id === FAR.id, `${expect?.id}`);
  check('both buttons are on screen, the anchor one below the item one',
    dead.revive.w > 40 && dead.respawn.w > 40 && dead.respawn.y > dead.revive.y,
    `${dead.revive.w}×${dead.revive.h} at y${dead.revive.y}, ${dead.respawn.w}×${dead.respawn.h} at y${dead.respawn.y}`);

  // The disabled button from the other side: the panel is keyed on the bag, so putting bowls in
  // it must flip the button. (The click itself is not driven — spending one needs the item in the
  // database, which is `/api/inventory/use`'s own probe.)
  //
  // Measured in pixels as well as in the DOM. `disabled` is a property; what makes a dead button
  // *look* dead is one line of css (`.btn:disabled { opacity: 0.42 }`), and a probe that reads the
  // property passes just as happily on a build where that rule was deleted and the greyed-out
  // 原地复苏 sits there looking clickable. The scene behind the panel is still animating, so the
  // canvas is hidden for the two reads — otherwise this would be measuring the sky.
  const btnRect = await p.evaluate(() => {
    const r = document.querySelector('[data-f="revivebtn"]').getBoundingClientRect();
    return {
      x: Math.round(r.x + 4), y: Math.round(r.y + 4),
      w: Math.max(8, Math.round(r.width - 8)), h: Math.max(8, Math.round(r.height - 8)),
    };
  });
  const setDishes = (n) => p.evaluate((v) => {
    window.game.player.inventory.reviveDish = v;
    window.ui.hud._refreshDowned();
    const e = document.querySelector('[data-f="revivebtn"]');
    return { text: e.textContent, disabled: !!e.disabled, title: e.title };
  }, n);
  await p.evaluate(() => { document.getElementById('scene').style.visibility = 'hidden'; });
  await frames(2);
  const offShot = await p.screenshot();
  const flipped = await setDishes(2);
  await frames(2);
  const onShot = await p.screenshot();
  await setDishes(dead.dishes);
  await p.evaluate(() => { document.getElementById('scene').style.visibility = ''; });
  check('with two bowls in the bag the same button is enabled and counts them',
    !flipped.disabled && new RegExp(`${DISH} ×2`).test(flipped.text) && !flipped.title,
    `「${flipped.text}」 disabled=${flipped.disabled}`);
  const offPix = rectStats(decodePng(offShot), { ...btnRect, label: 'off' });
  const onPix = rectStats(decodePng(onShot), { ...btnRect, label: 'on' });
  check('...and the two states are told apart by the pixels, not only by the property',
    onPix.lum > offPix.lum * 1.25 && onPix.lum - offPix.lum > 8,
    `${btnRect.w}×${btnRect.h} at (${btnRect.x}, ${btnRect.y}): disabled lum ${offPix.lum} rgb ${offPix.rgb} → enabled lum ${onPix.lum} rgb ${onPix.rgb}`);
  if (dead.dishes < 1) note('clicking 原地复苏', `no ${DISH} on this account; the item route is food-check's`);

  // The click below only means anything while the panel is up, and the sim stands the character
  // up on its own after AUTO_RESPAWN_SEC — so a click test that races that timer passes for free
  // whenever the machine is slow. The reads above spend most of the window, so re-establish it:
  // walk off the anchor and go down again, because after an auto-respawn the character is *on*
  // the anchor and "the button moved the body" would then be measuring nothing.
  let ticked = await panel();
  if (ticked.alive || !ticked.shown) {
    console.log(`  ...  the 8 s timer closed the panel during the pixel reads; re-downing off the anchor`);
    await p.evaluate(() => { const g = window.game; g.me.setGoal(g.me.x + 22, g.me.z + 14, 'move'); });
    for (let i = 0; i < 30; i++) {
      await frames(3);
      if (!(await p.evaluate(() => !!window.game.me.goal))) break;
      if (await p.evaluate((at) => Math.hypot(window.game.me.x - at[0], window.game.me.z - at[1]) > 18, FAR.at)) break;
    }
    await downMe();
    await frames(3);
    ticked = await panel();
    offAnchor = Math.hypot(ticked.at.x - FAR.at[0], ticked.at.z - FAR.at[1]);
    farEnough = offAnchor > 8;
  }
  check('the panel is still up when the anchor button is clicked', !ticked.alive && ticked.shown,
    `alive=${ticked.alive} shown=${ticked.shown}, ${offAnchor.toFixed(1)} m off the anchor`);

  /* ------------------------------------------------------ the button, not the timer -- */
  const before = { ...ticked.at };
  await p.evaluate(() => document.querySelector('[data-f="respawnbtn"]').click());
  await frames(4);
  const back = await panel();
  await shot('respawned');
  const moved = Math.hypot(back.at.x - before.x, back.at.z - before.z);
  const toAnchor = Math.hypot(back.at.x - FAR.at[0], back.at.z - FAR.at[1]);
  const toEntry = Math.hypot(back.at.x - ENTRY.at[0], back.at.z - ENTRY.at[1]);
  check('clicking 返回最近的锚点 stands the character up', back.alive && back.hp > 0, `hp ${back.hp}`);
  check('...without spending the revive item', back.dishes === dead.dishes,
    `${dead.dishes} → ${back.dishes} ${DISH}`);
  check('...and moves the body', farEnough ? moved > 6 : moved >= 0,
    `(${before.x}, ${before.z}) → (${back.at.x}, ${back.at.z}) = ${moved.toFixed(1)} m`);
  check('...to the anchor the button named', toAnchor < 14,
    `${toAnchor.toFixed(1)} m from ${anchorName(FAR)}`);
  check('...and not to the first waypoint in the table, which is what shipped',
    toEntry > 40, `${toEntry.toFixed(1)} m from ${anchorName(ENTRY)}`);
  check('...and the panel goes away', !back.shown);
  check('...and the countdown is cleared for the next death', back.wait === '', back.wait || '(empty)');
  if (!farEnough) note('the distance moved', `the walk only reached ${offAnchor.toFixed(1)} m off the anchor`);

  /* ---------------------------------------------------- and the timer, unattended --- */
  await p.evaluate(() => { const g = window.game; g.me.setGoal(g.me.x + 20, g.me.z + 12, 'move'); });
  for (let i = 0; i < 24; i++) {
    await frames(3);
    if (!(await p.evaluate(() => !!window.game.me.goal))) break;
  }
  const at2 = await p.evaluate(() => ({ x: +window.game.me.x.toFixed(1), z: +window.game.me.z.toFixed(1) }));
  await downMe();
  await frames(2);
  const t0 = Date.now();
  let woke = null;
  // The instance ticks on its own timer, not on rendered frames, so this is a real 8 seconds.
  while (Date.now() - t0 < 24000) {
    await sleep(600);
    const s = await panel();
    if (s.alive) { woke = { ...s, ms: Date.now() - t0 }; break; }
  }
  if (!woke) {
    check('nobody stays down forever: the timer stands the character up', false, 'still down after 24 s');
    await shot('still-down');
  } else {
    check('nobody stays down forever: the timer stands the character up', true,
      `${(woke.ms / 1000).toFixed(1)} s`);
    check('...at about the advertised time',
      woke.ms > (AUTO_RESPAWN_SEC - 2) * 1000 && woke.ms < (AUTO_RESPAWN_SEC + 9) * 1000,
      `${(woke.ms / 1000).toFixed(1)} s vs AUTO_RESPAWN_SEC=${AUTO_RESPAWN_SEC}`);
    check('...in the same place the button would have put them',
      Math.hypot(woke.at.x - FAR.at[0], woke.at.z - FAR.at[1]) < 14,
      `from (${at2.x}, ${at2.z}) → (${woke.at.x}, ${woke.at.z})`);
    check('...and the panel is gone without a click', !woke.shown);
  }

  /* ------------------------------------------------------------------ the map ------ */
  // The other half of the anchor: a pin you have not earned must look locked and refuse the jump.
  await p.evaluate(() => window.game.emit('togglePanel', { panel: 'map', open: true }));
  await sleep(2000);
  await frames(3);
  const map = await p.evaluate(() => {
    const all = [...document.querySelectorAll('.map-pins [data-poi]')];
    const anchors = all.filter((e) => e.dataset.type === 'waypoint' || e.dataset.type === 'statue');
    return {
      pins: all.length,
      anchors: anchors.map((e) => ({
        id: e.dataset.poi, type: e.dataset.type, locked: !!e.dataset.locked,
        glyph: e.textContent, klass: e.className, title: e.title,
      })),
    };
  });
  await shot('map-locks');
  check('the map drew this zone\'s anchors', map.anchors.length >= 3,
    `${map.anchors.length} anchors among ${map.pins} pins`);
  const lockedPins = map.anchors.filter((a) => a.locked);
  const openPins = map.anchors.filter((a) => !a.locked);
  check('...with both kinds on screen, or the next assertion is free',
    lockedPins.length > 0 && openPins.length > 0,
    `open ${openPins.map((a) => a.id).join(' ')} | locked ${lockedPins.map((a) => a.id).join(' ')}`);
  check('...the locked ones look locked',
    lockedPins.every((a) => /\blocked\b/.test(a.klass) && a.glyph === '🔒'),
    lockedPins.map((a) => `${a.id}:${a.glyph}`).join(' '));
  check('...and say why', lockedPins.every((a) => /未激活/.test(a.title)), lockedPins[0]?.title || '');
  check('...and the two the traveller has stood on are open, glyph and all',
    openPins.length === 2 && openPins.every((a) => a.glyph !== '🔒')
    && openPins.map((a) => a.id).sort().join(',') === [ENTRY.id, FAR.id].sort().join(','),
    openPins.map((a) => `${a.id}:${a.glyph}`).join(' '));

  // Record the toast channel *before* the click. A toast removes itself 3.5 s after it is created,
  // and the read below is a 1.5 s sleep plus three rendered frames — which is under a second on a
  // warm page and over two on llvmpipe at 2 fps. That is how this row failed once as "(no toast)"
  // with the product working: the node had already swept itself away. Subscribing to the event bus
  // records what was *said*, at the moment it was said.
  await p.evaluate(() => {
    window.__toasts = [];
    window.game.on('toast', (t) => window.__toasts.push(t.text));
  });
  const clicked = await p.evaluate(() => {
    const el = [...document.querySelectorAll('.map-pins [data-poi]')].find((e) => e.dataset.locked);
    const at = { x: window.game.me.x, z: window.game.me.z };
    el.click();
    return { id: el.dataset.poi, at };
  });
  await sleep(1500);
  await frames(3);
  const afterClick = await p.evaluate(() => ({
    x: +window.game.me.x.toFixed(1), z: +window.game.me.z.toFixed(1),
    mapOpen: !!document.querySelector('.map-pins'),
    said: window.__toasts || [],
    toasts: [...document.querySelectorAll('[data-f="toasts"] .toast')].map((t) => t.textContent),
  }));
  const slid = Math.hypot(afterClick.x - clicked.at.x, afterClick.z - clicked.at.z);
  check('clicking a locked pin does not teleport', slid < 4, `${clicked.id}: moved ${slid.toFixed(1)} m`);
  check('...and says so', afterClick.said.some((t) => /还没有激活/.test(t)),
    afterClick.said.join(' | ') || '(nothing said)');
  check('...and leaves the map open so another one can be picked', afterClick.mapOpen);
  await closeModal();

  check('no page errors through the whole run', errors.length === 0,
    errors.slice(0, 3).join(' | ') || 'clean console');
} catch (e) {
  fail++;
  console.log(`  FAIL the browser run threw — ${e.message}`);
  try { await shot('crash'); } catch { /* the page may be gone */ }
} finally {
  await b.close();
}

console.log(`\ndeath-check: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
