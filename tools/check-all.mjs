// Run the whole gate suite, serially, and say which probes actually proved something.
//
// Why this exists. The repo has 30-odd probes and no way to run them; every iteration ran the
// three or four that touched the files it had just edited, from memory, with hand-typed argv.
// An audit of the goal found the consequence: about twenty probes had no run on the current
// build at all, so "every module is verified" was a claim about the past. Worse, the argv
// shapes differ (`mp-check` and `build-check` take `host:port`, everything else takes a URL),
// and getting one wrong does not look like a mistake — `node tools/mp-check.mjs
// http://127.0.0.1:5173` dies with `getaddrinfo ENOTFOUND http`, which reads like a server
// being down. Encoding each probe's real invocation *once*, here, is most of the value.
//
// Three rules it enforces that a plain `for f in tools/*-check.mjs` loop cannot:
//
//  1. **Exit 0 is not evidence.** A probe that booted a browser, threw before its first
//     assertion and still returned 0 is the failure mode this repo has hit repeatedly (a
//     `check()` that returned nothing, a `default: break` that could not fail, an autorun loop
//     that reported `up` for 23 hours while every iteration died). So a run is GREEN only if
//     the process exited 0 *and* the log carries a parsed assertion count greater than zero.
//     Anything else is NO-EVIDENCE, which is a failure, not a pass.
//  2. **One at a time.** Every browser probe drives the same Xvfb display and the same Vite
//     dev server; two at once steal each other's focus, Firefox throttles rAF in the
//     unfocused page, and both read stale frames. It also means the summary's wall-clock
//     numbers are comparable between runs.
//  3. **Preconditions are checked, not assumed.** Server health, client index, the X display
//     and `/tmp/world-token.txt` are verified before the first probe, and a probe whose
//     precondition is missing is SKIPPED by name instead of failing obscurely 90 s in.
//
//   node tools/check-all.mjs                        # everything, in order
//   node tools/check-all.mjs --group data,http      # the fast half (no browser)
//   node tools/check-all.mjs --only death,mp        # substring match on the name
//   node tools/check-all.mjs --skip wish,tour       # everything except these
//   node tools/check-all.mjs --list                 # print the plan and exit
//
// Exit code is the number of probes that were not GREEN. Logs and artifacts land in
// /tmp/check-all-<stamp>/, one file per probe, plus SUMMARY.md.

import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, existsSync, createWriteStream, readdirSync, readFileSync, rmSync,
  statfsSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';

const APP = process.env.GAME_APP || 'http://127.0.0.1:5173';
const API = process.env.GAME_API || 'http://127.0.0.1:8787';
const HOSTPORT = API.replace(/^https?:\/\//, '');
const DISPLAY = process.env.DISPLAY || ':99';
const MIN = 60_000;

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? '') : dflt;
};
const LIST = argv.includes('--list');
const BAIL = argv.includes('--bail');
const ONLY = (flag('only') || '').split(',').filter(Boolean);
const SKIP = (flag('skip') || '').split(',').filter(Boolean);
const GROUPS = (flag('group') || 'data,http,browser,visual').split(',').filter(Boolean);

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const runDir = `/tmp/check-all-${stamp}`;
mkdirSync(runDir, { recursive: true });

/* ------------------------------------------------------------------ the plan -- */

/**
 * `art: true` means the probe takes `[base, outDir]` — verified by reading each one, because
 * this is precisely the thing that cannot be guessed. Everything else is called with no
 * arguments, whose defaults (`:5173` for the app, `:8787` for the api) are already right.
 *
 * `evidence` overrides the default "N passed, M failed" parse for the probes that report in
 * their own shape; `needs` names a precondition from the checks below.
 */
const SPEC = [
  // --- pure data / shared logic: no server, no browser, seconds each ---------------
  { name: 'balance-check',   group: 'data' },
  { name: 'char-check',      group: 'data' },
  { name: 'chamber-check',   group: 'data' },
  { name: 'resonance-check', group: 'data' },
  { name: 'proc-check',      group: 'data' },
  { name: 'quality-check',   group: 'data', evidence: /all checks passed|(\d+) check\(s\) failed/ },
  { name: 'gamut-check',      group: 'data', evidence: /(\d+) colours, (\d+) out of gamut/ },
  { name: 'humanoid-check',  group: 'data', evidence: /all garments clear the skin|wear their own skin colour/ },

  // --- server + database + redis, over http/ws ------------------------------------
  { name: 'api-check',   group: 'http', needs: 'api', timeout: 6 * MIN },
  { name: 'mp-check',    group: 'http', needs: 'api', args: [HOSTPORT] },
  { name: 'build-check', group: 'http', needs: 'api', args: [HOSTPORT] },
  // The slowest non-browser probe by far (~15 min): it plays all eight floors of 深渊试炼场
  // with two armed clients, because the 3★ time gate, the deeper 地脉异变 and the boss phases
  // are only reachable by winning fights. Nothing else in the suite gets past floor 1.
  { name: 'deep-check',  group: 'http', needs: 'api', args: [HOSTPORT], timeout: 25 * MIN },

  // --- browser: one display, one at a time ----------------------------------------
  { name: 'solo-check',      group: 'browser', art: true },
  // The two halves of 支持单机和多人在线, side by side: solo-check owns the offline half, and
  // mp-view is the only thing that photographs a *second* player instead of trusting the
  // snapshot stream mp-check validates.
  { name: 'mp-view',         group: 'browser', art: true, timeout: 12 * MIN },
  // 支持鼠标点击 is a headline promise, and until mouse-check existed nothing in this list
  // pressed a mouse button on the canvas — every probe here clicked DOM buttons only.
  { name: 'mouse-check',     group: 'browser', art: true, timeout: 15 * MIN },
  { name: 'nan-scan',        group: 'browser', args: [APP], timeout: 15 * MIN },
  { name: 'quest-check',     group: 'browser', art: true },
  { name: 'questnav-check',  group: 'browser', art: true, timeout: 12 * MIN },
  { name: 'questend-check',  group: 'browser', art: true, timeout: 15 * MIN },
  { name: 'tutorial-check',  group: 'browser', art: true, timeout: 12 * MIN },
  { name: 'death-check',     group: 'browser', art: true, timeout: 12 * MIN },
  { name: 'bag-check',       group: 'browser', art: true },
  { name: 'shop-check',      group: 'browser', art: true },
  { name: 'mail-check',      group: 'browser', art: true },
  { name: 'ach-check',       group: 'browser', art: true },
  { name: 'puzzle-check',    group: 'browser', art: true, timeout: 12 * MIN },
  // 探索度 end to end: the map's percentage, the chest toast that moves it (a call to a method
  // that did not exist — every chest open threw), and the 探索完成 banner at 100%.
  { name: 'explore-check',   group: 'browser', art: true, timeout: 15 * MIN },
  { name: 'social-check',    group: 'browser', art: true, timeout: 12 * MIN },
  { name: 'food-check',      group: 'browser', timeout: 15 * MIN },
  { name: 'wish-check',      group: 'browser', timeout: 20 * MIN },
  { name: 'audio-check',     group: 'browser', timeout: 12 * MIN },
  // 元素反应's whole presentation layer, which had three separate holes and no gate: the client
  // spelled 冻结 `frozen` against the wire's `freeze`, so the commonest reaction in the game fell
  // through the switch's `default` and drew a generic bloom; reactions had no sound at all; and
  // the player-target damage branch dropped `d.reaction` on the floor. Promoted with a mutation
  // log — restoring the `frozen` typo turns the source scan *and* both photograph rows red at
  // 0 px difference from the default branch's own frame.
  // Long because section 4 is a real fight: three page boots (one to mint the account, one to
  // level it through the growth routes, one to join with the levelled party), a walk out to a
  // camp, and up to three attempts at the two-character rotation at llvmpipe's 3 fps.
  { name: 'react-check',     group: 'browser', art: true, timeout: 30 * MIN },
  { name: 'enemy-check',     group: 'browser', timeout: 12 * MIN },
  // Whether a wind-up tells you where the blow lands, measured in metres from 40 m overhead: the
  // client used to draw one ring sized off the *creature's* hitbox for all seventeen moves, so a
  // 2.4 m jab and a 6 m spike field were the same picture. Promoted with a mutation log —
  // restoring `max(1.6, hitbox.r * 2.4)` turns 23 rows red, including every "these are five
  // different shapes" claim (a sector reading 68% of its disc, a ring with no hole). Sections 1b
  // and 7 hold the player's own attacks to the same standard — the melee sweep is 0.85π of a
  // 4.8-5.8 m circle, `burst.radius` runs 4 m to 8 m, and the client drew a 7 m ring for all of
  // them; restoring that ring turns 9 rows red.
  { name: 'telegraph-check', group: 'browser', art: true, timeout: 20 * MIN },
  { name: 'chamber-ui',      group: 'browser', art: true, timeout: 12 * MIN },
  { name: 'party-ui',        group: 'browser', art: true },
  { name: 'resonance-ui',    group: 'browser', art: true, timeout: 12 * MIN },
  // The pixels of both shield bars. Promoted the day it was written, because its very first
  // run found that `PlayerEntity.serialize` gated the shield on `Date.now() / 1000` while
  // `shieldUntil` is on the instance clock — so the player's own shield bar had never been
  // drawn at all, for any shield, while every simulation-side probe passed.
  { name: 'shield-ui',       group: 'browser', art: true, timeout: 12 * MIN },
  // The two things a boss fight has that no other fight does: legs that keep walking (the gait
  // clock used to be pinned to the battle phase, which froze every walker in the game) and a
  // phase change the player is told about — banner, plate pips, bar thresholds, cue. Promoted
  // with a mutation log: it goes red for a frozen clock through the real frame loop, a dropped
  // sfx call, a missing pips write and a missing top-edge clamp, one identifiable red each.
  { name: 'boss-check',      group: 'browser', art: true, timeout: 15 * MIN },
  // 探索派遣, end to end through the panel: G opens it (the only proof the derived
  // `PANEL_ACTIONS` loop reaches a panel added after that loop was written), a locked
  // destination refuses the click with the rule's own sentence, and a real dispatch is watched
  // across the crossing into 可领取 — the countdown has to move and the 领取 button and the 🧭
  // chip have to appear with nobody clicking anything. Rewinds `started_at` instead of waiting
  // four hours, and refetches through the panel's own 30 s staleness path.
  { name: 'expedition-ui',   group: 'browser', art: true, timeout: 12 * MIN },

  // --- the picture itself: four shots a quarter-turn apart in all six zones --------
  { name: 'tour', group: 'visual', needs: 'token', timeout: 25 * MIN, evidence: /errors ->/ },
  // The half of the picture `tour` structurally cannot see: it shoots at pitch 0.24, i.e.
  // slightly *down*, which is where the third-person camera sits while you walk, so the top
  // of frame is always wall and no dungeon ceiling has ever been in one of its screenshots.
  // This one pitches to the camera's own up-clamp in the three indoor zones and asserts the
  // lid is there, has form, is darker than the floor and is not the fog colour. It was
  // already written and passing 29 of 30 — the missing one was its own luma metric — which
  // is worse than not existing: a probe nobody runs is a folder of PNGs nobody re-measures.
  { name: 'vault-cam', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['--out', `${runDir}/art-vault-cam`] },
  // And the floor of the same three rooms, for the same reason: `tour` shoots the ground at
  // walking pitch and grades its texture, but the arena *pattern* — two rings, eight spokes and
  // a medallion, scaled by `terrain.inlayStrength` — had never been photographed anywhere except
  // 黄金屋, by hand, once. It found the other two arenas painting that pattern in their own floor
  // colour: authored, mixed, tone-mapped and invisible.
  { name: 'inlay-cam', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['--out', `${runDir}/art-inlay-cam`] },
  // Everything between the floor and the lid. `tour` gates the ground and `vault-cam` the
  // ceiling; until these four ran here, no prop, no wall, no villager and no enemy had a single
  // quantified assertion in the suite — and three of the four were *already written and
  // passing*, sitting outside it exactly like vault-cam was. An asserting probe nobody runs is a
  // folder of PNGs nobody re-measures, so the rule is now: if it counts assertions, it is listed.
  //
  // prop-check is the new one and the widest: every kind the six zones build, identified by
  // hiding it and measured over its own silhouette.
  { name: 'prop-check',  group: 'visual', needs: 'token', timeout: 30 * MIN, args: ['--out', `${runDir}/art-prop-check`] },
  { name: 'npc-cam',     group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['--out', `${runDir}/art-npc-cam`] },
  // `--out` takes a value, so the defId has to be spelled out: `enemy-cam --out DIR` alone read
  // the directory as the zone and reported "no camp in /tmp/... spawns 'ruinGuard'".
  { name: 'enemy-cam',   group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['ruinGuard', '--out', `${runDir}/art-enemy-cam`] },
  // Three kinds, not one, because the two defects this probe has actually caught were both
  // invisible on `ruinGuard`: the slime is the only `rigged: false` kind and it hand-animated
  // `group.position.y`, which is the *actor's* node — all three slime kinds were drawn at world
  // y ≈ 0, i.e. 5-30 m underground everywhere in the open world; and the two abyss kinds
  // authored their faces inside their own head volumes. One kind per rig style is the minimum
  // that can fail: a mech, a blob, and a floater in a robe.
  { name: 'enemy-cam', label: 'enemy-cam-slime', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['slimeWater', '--out', `${runDir}/art-enemy-cam-slime`] },
  { name: 'enemy-cam', label: 'enemy-cam-mage', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['abyssMage', '--out', `${runDir}/art-enemy-cam-mage`] },
  // A fourth: the storm tyrant, which stands in no camp anywhere — it exists only inside two
  // dungeon waves, so the probe has to boot 单机 and ask the tab's own `ZoneInstance` to spawn it.
  // That path was worth building because the game's only three-phase boss was also the only model
  // nothing had ever photographed, and it was broken in exactly the way this sheet catches: the
  // neck pointed backward out of the bird's back while the head floated in front of it.
  { name: 'enemy-cam', label: 'enemy-cam-boss', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['stormTyrant', '--out', `${runDir}/art-enemy-cam-boss`] },
  // Two more rigs, added after a hand-run over all nine spawnable kinds found something the four
  // above cannot see: the readings are per-kind, so a kind with no row has no gate. The vishap is
  // the quadruped-with-a-plated-back, on snow (its far spark once read 605 px of *floor*, which is
  // the reading the isolation rewrite below the sparks section fixed); the herald is the wide-panel
  // robe whose four white bands this sheet already caught once. Same hand-run found 霜狼 failing
  // the washed-patch gate on the back yaw (2.17 % against a 2 % bar).
  { name: 'enemy-cam', label: 'enemy-cam-vishap', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['geoVishap', '--out', `${runDir}/art-enemy-cam-vishap`] },
  { name: 'enemy-cam', label: 'enemy-cam-herald', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['abyssHerald', '--out', `${runDir}/art-enemy-cam-herald`] },
  // ...and the remaining six, which is every spawnable kind. The six above cover every *rig* in the
  // game; these six are the ones that differ only by *colour*, and colour is exactly what the wash
  // and highlight-hue sections measure — 霜狼's white rump was an albedo two stops too pale, and the
  // hue reading is derived from each kind's own `model.color`. A kind whose only distinguishing
  // feature is its palette therefore still needs its own row: this is the last of the "no row = no
  // gate" hole, 12 of 12. It costs about 75 s per kind on llvmpipe.
  { name: 'enemy-cam', label: 'enemy-cam-wolf', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['frostWolf', '--out', `${runDir}/art-enemy-cam-wolf`] },
  { name: 'enemy-cam', label: 'enemy-cam-hili', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['hilichurl', '--out', `${runDir}/art-enemy-cam-hili`] },
  { name: 'enemy-cam', label: 'enemy-cam-hili-archer', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['hilichurlArcher', '--out', `${runDir}/art-enemy-cam-hili-archer`] },
  { name: 'enemy-cam', label: 'enemy-cam-hili-pyro', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['hilichurlPyro', '--out', `${runDir}/art-enemy-cam-hili-pyro`] },
  { name: 'enemy-cam', label: 'enemy-cam-slime-fire', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['slimeFire', '--out', `${runDir}/art-enemy-cam-slime-fire`] },
  { name: 'enemy-cam', label: 'enemy-cam-slime-electro', group: 'visual', needs: 'token', timeout: 15 * MIN, args: ['slimeElectro', '--out', `${runDir}/art-enemy-cam-slime-electro`] },
  { name: 'light-space', group: 'visual', needs: 'token', timeout: 12 * MIN, args: ['mondstadt', '--out', `${runDir}/art-light-space`] },
  // The one thing in frame that *moves*. Every probe above shoots a world holding still; the 24
  // clips in `animator.js` had no pixel gate at all, and the cost of that was four clips that were
  // authored, in the ACTION enum, exported to other players — and played by nobody (`hit`, `sit`,
  // `aim`, `climb`). This one photographs each clip's silhouette against a hidden-avatar frame and
  // also walks the vocabulary in both directions, including the level below: a state key pinned to
  // a literal (`climbing: false`) satisfies a "the key is present" check and still plays nothing.
  //
  // `needs: 'browser'` rather than the `'token'` its neighbours use: it mints its own guest
  // token, and what it actually cannot run without is the display and the app.
  { name: 'motion-check', group: 'visual', needs: 'browser', timeout: 25 * MIN, args: ['--out', `${runDir}/art-motion-check`] },
  // The one thing in frame that moves on its own, without anybody pressing a key: the sun.
  // Every other visual probe here photographs one hour of the day (noon, now pinned explicitly),
  // so the whole day outside that hour was ungated — which is how `uStars` and `uNight` sat in
  // sky.js from the day it was written with no zone ever authoring either key. This one walks the
  // clock instead of the world: it asserts 12:00 returns each zone's authored sky term-for-term
  // (the reason those ~500 calibrated thresholds still hold), sweeps a whole day per zone, hides
  // each night-only uniform to prove it draws pixels, and — the part that protects the rest of
  // this list — greps every pixel probe and fails if one stops pinning the hour.
  { name: 'daylight-check', group: 'visual', needs: 'browser', timeout: 20 * MIN, args: ['--out', `${runDir}/art-daylight-check`] },
  // The second thing that moves on its own: the forecast. Same shape as the clock — a pure function
  // of epoch ms, so nothing is broadcast and 单机 agrees with 多人 — and the same danger to this
  // list, which is why its loudest assertion is that **day 0 is each zone's authored weather, at
  // every hour, `===`**: a pinned hour is day 0, so every calibrated threshold above keeps the
  // frame it was calibrated on. It also photographs the same hour on a rainy day and a clear one
  // (one camera, one sun, two pictures), and it is the gate on the dead comparison that started the
  // round — `zone.weather === 'blizzard'` compared a string to an object, so the cold thin wind bed
  // had never played anywhere.
  { name: 'weather-check', group: 'visual', needs: 'browser', timeout: 20 * MIN, args: ['--out', `${runDir}/art-weather-check`] },
  // The third thing nobody was measuring: whether anything casts a shadow on the ground. The rig is
  // elaborate and 48 probes photograph the world without once checking that a shadow lands, because
  // they all shoot 12:00 — the one hour where the avatar's shadow is 1.2 m long and under her feet.
  // This one hides the caster and shoots the same frame at three hours, so the ground's own mottle
  // cannot answer for it. It is also the only probe that has to pin `high`: llvmpipe boots at `low`,
  // where `shadowMap.enabled` is false and every shadow assertion would fail for the wrong reason.
  { name: 'shadow-check', group: 'visual', needs: 'browser', timeout: 20 * MIN, args: ['--out', `${runDir}/art-shadow-check`] },
  // The HUD, graded against the 3D scene under it. Every UI probe above reads text content or a
  // rect with the canvas *hidden*, which is exactly the frame the player never sees: 细腻画面 put
  // 13 px cream CJK on sunlit grass and nothing measured the two together. This one shoots each
  // floating line three times — as drawn, with `color: transparent` (which keeps every text-shadow,
  // because a shadow is painted from the glyph's alpha, so that frame *is* the backdrop the ink was
  // laid on), and hidden — and scores WCAG contrast of the authored colour against its own halo. It
  // found four: the banner subtitle had no shadow at all (2.02:1 over grass, under its own 3.66:1
  // title), `.dmg`/`.dmg.crit`'s soft drops left the pixel beside a stroke at ~80 % of a bright
  // body, and `.wlabel`'s single 4 px blur was too weak on noon meadow.
  { name: 'legible-check', group: 'visual', needs: 'browser', timeout: 20 * MIN, args: ['--out', `${runDir}/art-legible-check`] },
  // The aura the player is wearing — element pips, the reaction flash, the frozen shell — shot
  // against the character rather than against the frame, because "something changed" is what a
  // reaction looks like anywhere on screen. It takes its out dir as a bare path, not `--out`.
  // Registered late: it was committed without a row, so the "no probe on disk goes unnamed" gate
  // below was refusing to run the whole suite, and the probe itself had never run in one. It is
  // red at 45/6/2 as registered, all six about *where* the aura is drawn (its centre is 6.6 m from
  // the character's own projection) — a defect this row exists to keep visible, not to hide.
  { name: 'player-aura-check', group: 'visual', needs: 'browser', timeout: 30 * MIN, args: [`${runDir}/art-player-aura`] },
  // No screenshots and no tier: it marches rigs and reads bone matrices, so it is the one
  // motion probe that cannot be fooled by a stale frame.
  { name: 'gait-check', group: 'browser', needs: 'browser', timeout: 10 * MIN },
];

// A group name that is not in the default set is a probe that never runs: the row is written,
// `--list` shows it, and the default invocation quietly filters it out (`gait-check` shipped as
// `group: 'sim'` and sat out a whole 49-probe run that reported GREEN). The registration and the
// group vocabulary have to be checked against each other, in this file, before anything runs.
const KNOWN_GROUPS = ['data', 'http', 'browser', 'visual'];
{
  const bad = SPEC.filter((s) => !KNOWN_GROUPS.includes(s.group)).map((s) => `${s.name}:${s.group}`);
  if (bad.length) {
    console.error(`check-all: unknown group(s) — these probes would never run: ${bad.join(', ')}`);
    console.error(`  known groups: ${KNOWN_GROUPS.join(', ')}`);
    process.exit(2);
  }
  const unknownFlag = GROUPS.filter((g) => !KNOWN_GROUPS.includes(g));
  if (unknownFlag.length) {
    console.error(`check-all: --group names nothing: ${unknownFlag.join(', ')} (known: ${KNOWN_GROUPS.join(', ')})`);
    process.exit(2);
  }
  // The other direction: a `tools/*-check.mjs` that nothing here names is a probe somebody wrote
  // and forgot to enlist, which is the same silence as the wrong group. Only `*-check` is bound
  // this way — the `*-cam` files are cameras first and some are only ever run by hand.
  const listed = new Set(SPEC.map((s) => s.name));
  const onDisk = readdirSync(new URL('.', import.meta.url))
    .filter((f) => /-check\.mjs$/.test(f)).map((f) => f.replace(/\.mjs$/, ''));
  const orphans = onDisk.filter((f) => !listed.has(f));
  if (orphans.length) {
    console.error(`check-all: probe(s) on disk that no row names: ${orphans.join(', ')}`);
    console.error('  add a SPEC row (or rename the file if it is not a probe).');
    process.exit(2);
  }
  const missing = SPEC.map((s) => s.name).filter((n) => !existsSync(new URL(`${n}.mjs`, import.meta.url)));
  if (missing.length) {
    console.error(`check-all: SPEC names file(s) that do not exist: ${[...new Set(missing)].join(', ')}`);
    process.exit(2);
  }
}

// One probe can be listed more than once with different arguments — `enemy-cam` runs on three
// enemy kinds — so the *row* is identified by `label`, not by the file. Without it the second
// entry's log would overwrite the first at `${runDir}/${name}.log` and the table would print the
// same name twice with no way to tell which kind was red.
const idOf = (s) => s.label || s.name;

const wanted = SPEC.filter((s) => GROUPS.includes(s.group))
  .filter((s) => !ONLY.length || ONLY.some((o) => idOf(s).includes(o)))
  .filter((s) => !SKIP.some((o) => idOf(s).includes(o)));

/* ---------------------------------------------------------- preconditions -- */

const ok200 = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
};

/**
 * /tmp is a 16 GB tmpfs — i.e. RAM — and one full run of this suite writes 120–520 MB of
 * screenshots into it and leaves a ~95 MB Firefox profile behind for every browser Puppeteer
 * had to SIGKILL. Sixty run directories and fifty-four orphaned profiles later a run died
 * *mid-suite* with `ENOSPC` thrown out of a log WriteStream: no red row, no tally, just a Node
 * stack trace where the 26th of 60 probes should have been, and 29 probes that never ran at all.
 * So the runner does its own housekeeping before it starts, and says out loud how much it
 * reclaimed and how much is left. Nothing here is a taste knob: the floor is one worst-case
 * run's artefacts plus one leaked profile per browser probe.
 */
const KEEP_RUNS = 4;
const FLOOR_MB = 4096;
const mb = (bytes) => Math.round(bytes / 1048576);

function reclaimTmp(notes) {
  let freed = 0;
  const sizeOf = (dir) => {
    const r = spawnSync('du', ['-sk', dir], { encoding: 'utf8' });
    return (+(r.stdout || '').split(/\s+/)[0] || 0) * 1024;
  };
  // Older run directories, newest `KEEP_RUNS` kept (the current one is not in this list yet
  // when it is empty, but exclude it by name anyway — deleting the directory the run is about
  // to write into is exactly the kind of cleanup that ruins a suite).
  const runs = readdirSync('/tmp').filter((f) => /^check-all-\d{8}-\d{6}$/.test(f))
    .filter((f) => `/tmp/${f}` !== runDir).sort();
  for (const d of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) {
    freed += sizeOf(`/tmp/${d}`);
    rmSync(`/tmp/${d}`, { recursive: true, force: true });
  }
  // Leaked browser profiles. Only when no browser is alive: a probe of ours could be running
  // in another terminal, and its profile is a live directory, not garbage.
  const alive = spawnSync('pgrep', ['-c', '-f', 'firefox'], { encoding: 'utf8' });
  const busy = (+(alive.stdout || '').trim() || 0) > 0;
  let profiles = 0;
  if (!busy) {
    for (const f of readdirSync('/tmp').filter((n) => /^puppeteer_dev_\w+_profile-/.test(n))) {
      freed += sizeOf(`/tmp/${f}`);
      rmSync(`/tmp/${f}`, { recursive: true, force: true });
      profiles++;
    }
  }
  const kept = Math.min(runs.length, KEEP_RUNS);
  notes.push(`tmp reclaimed ${mb(freed)} MB (${runs.length - kept} old runs, ${profiles} stale browser`
    + ` profiles${busy ? '; skipped, a browser is running' : ''}), keeping the ${kept} newest runs`);
  return freed;
}

async function preflight() {
  const have = new Set();
  const notes = [];

  // The interpreter the children will get — see the `process.execPath` note at the spawn. Print
  // it, because "which node ran the suite" is otherwise invisible in the log, and refuse the run
  // outright when it has no global `WebSocket`: six probes open a gateway socket, and on such an
  // interpreter they all print a handful of green lines and then die on a `ReferenceError` that
  // reads like the gateway is broken. A suite that cannot run its own probes is not evidence.
  notes.push(`node ${process.version} at ${process.execPath}`);
  if (typeof WebSocket === 'function') have.add('ws');
  else notes.push('this node has no global WebSocket — every gateway probe would die on it');

  reclaimTmp(notes);
  const fsStat = statfsSync('/tmp');
  const freeMb = mb(fsStat.bavail * fsStat.bsize);
  if (freeMb >= FLOOR_MB) {
    have.add('disk');
    notes.push(`tmp ${freeMb} MB free (floor ${FLOOR_MB} MB)`);
  } else notes.push(`tmp only ${freeMb} MB free, under the ${FLOOR_MB} MB floor`);

  const health = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.json()).catch(() => null);
  if (health?.ok) { have.add('api'); notes.push(`api ${API} ok (redis: ${health.redis})`); }
  else notes.push(`api ${API} DOWN — ./tools/daemon.sh restart server`);

  if (await ok200(APP)) { have.add('app'); notes.push(`app ${APP} ok`); }
  else notes.push(`app ${APP} DOWN — ./tools/daemon.sh restart client`);

  // A browser probe with no display dies with "no DISPLAY environment variable specified",
  // which says nothing about Xvfb being the thing that is missing. Tested by the socket the
  // X server binds rather than with `xdpyinfo`, which is not installed on this box — a
  // precondition check that depends on an absent tool reports every display as missing.
  const sock = `/tmp/.X11-unix/X${DISPLAY.replace(/^.*:/, '').replace(/\..*$/, '')}`;
  if (existsSync(sock)) { have.add('display'); notes.push(`display ${DISPLAY} ok (${sock})`); }
  else notes.push(`display ${DISPLAY} MISSING (no ${sock}) — Xvfb ${DISPLAY} -screen 0 1600x900x24 &`);

  // tour.mjs reads a token off disk rather than logging in, so mint one if it is absent or
  // stale. It is the only precondition this runner can satisfy by itself.
  if (have.has('api')) {
    const tok = await fetch(`${API}/api/guest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json()).catch(() => null);
    if (tok?.token) {
      writeFileSync('/tmp/world-token.txt', tok.token);
      have.add('token');
      notes.push('token /tmp/world-token.txt minted');
    } else notes.push('token could not be minted — /api/guest failed');
  }

  return { have, notes };
}

/* ------------------------------------------------------------------- runner -- */

function run(cmd, args, { capture = false, timeout = 15 * MIN, logPath = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const sink = logPath ? createWriteStream(logPath) : null;
    const take = (buf) => {
      if (capture) out += buf;
      sink?.write(buf);
    };
    // A log sink that throws takes the *runner* down with it — the disk filling up mid-suite
    // arrived as an unhandled 'error' event on this stream and ended 60 probes at 26. Swallowed
    // into the captured text instead, so the row goes red with the reason on it and the rest of
    // the suite still runs.
    sink?.on('error', (e) => { out += `\n[log write failed] ${e.message}\n`; });
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.on('error', (e) => { take(`\n[spawn error] ${e.message}\n`); });
    child.on('close', (code) => {
      clearTimeout(t);
      sink?.end();
      resolve({ code: timedOut ? 'TIMEOUT' : code, out });
    });
  });
}

/**
 * What the log proves. `passed`/`failed` when the probe reports in the common shape, else the
 * probe's own `evidence` line, else a count of result lines — and if none of those turn up
 * anything, `assertions` stays 0 and the caller must not call the run green.
 */
function readLog(text, spec) {
  const m = text.match(/(\d+)\s+passed,\s*(\d+)\s+failed(?:,\s*(\d+)\s+skipped)?/);
  if (m) return { passed: +m[1], failed: +m[2], skipped: +(m[3] || 0), how: 'counts' };
  if (/\ball passed\b/.test(text)) {
    const n = (text.match(/^\s*(ok|PASS)\b/gm) || []).length;
    return { passed: n, failed: 0, skipped: 0, how: 'all-passed' };
  }
  const fail = text.match(/(\d+)\s+FAILED:/);
  if (fail) {
    const n = (text.match(/^\s*(ok|PASS)\b/gm) || []).length;
    return { passed: n, failed: +fail[1], skipped: 0, how: 'failed-list' };
  }
  if (spec.evidence && spec.evidence.test(text)) {
    const bad = (text.match(/^\s*(FAIL|BAD)\b/gm) || []).length;
    const good = (text.match(/^\s*(ok|PASS)\b/gm) || []).length;
    return { passed: Math.max(good, 1), failed: bad, skipped: 0, how: 'evidence' };
  }
  const good = (text.match(/^\s*(ok|PASS)\b/gm) || []).length;
  const bad = (text.match(/^\s*(FAIL|BAD)\b/gm) || []).length;
  return { passed: good, failed: bad, skipped: 0, how: good + bad ? 'lines' : 'none' };
}

const rows = [];
const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const { have, notes } = await preflight();
  console.log(`check-all → ${runDir}`);
  for (const n of notes) console.log(`  · ${n}`);
  console.log(`  · ${wanted.length} probes: ${GROUPS.join(',')}\n`);

  if (LIST) {
    for (const s of wanted) {
      console.log(`${pad(s.group, 8)} ${pad(idOf(s), 18)} node tools/${s.name}.mjs ${(argsFor(s)).join(' ')}`);
    }
    return 0;
  }

  // Refuse rather than start: with /tmp this full the suite does not fail, it *stops* — the
  // ENOSPC that killed the run this check was written for arrived as an unhandled stream error
  // 26 probes in, and the 34 rows after it were never attempted or reported.
  // Same shape of refusal, one line earlier in the chain: an interpreter without `WebSocket`
  // turns six probes red for a reason that has nothing to do with the game.
  if (!have.has('ws')) {
    console.error(`check-all: ${process.version} (${process.execPath}) has no global WebSocket.`);
    console.error('  run the suite with node >= 22, e.g.'
      + ' ~/.nvm/versions/node/v22.22.3/bin/node tools/check-all.mjs');
    return 2;
  }

  if (!have.has('disk')) {
    console.error(`check-all: not enough room in /tmp for a full run (floor ${FLOOR_MB} MB).`);
    console.error('  the housekeeping above already ran; free something by hand'
      + ` (du -sh /tmp/* | sort -h | tail) or lower KEEP_RUNS=${KEEP_RUNS}.`);
    return 2;
  }

  // And refuse to be the *second* copy. Every browser probe drives one page on one X display
  // (`:99`), so two suites at once are two hands on one mouse: a launch that ran twice put two
  // probes on the display for 23 minutes and produced three reds that were pure collateral —
  // mouse-check's walk order arrived with no goal, death-check read an empty toast box, and both
  // runners' rows interleaved into one log so even the summary was unreadable. There is no safe
  // way to share the display, so the newer copy stops here and says which pid owns it.
  // Only the *newer* copy stops, or the two of them kill each other: the first version of this
  // check had both copies see each other and both exit, which is a suite that never ran at all —
  // worse than the collision it was written for. The tie is broken by age (`ps -o etimes`, and a
  // lower pid if two started inside the same second), so the run that got here first keeps going.
  // Read /proc rather than shelling out to `pgrep -f`: this very process was launched from a
  // `bash -c` whose own command line *contains* "node tools/check-all.mjs", so a `-f` match finds
  // the wrapper, calls it an older run, and the suite refuses to start against its own shell.
  // Only argv[0] === node with this script in argv counts, and the age comes from the same clock
  // for everyone (`/proc/uptime` minus field 22 of `/proc/<pid>/stat`).
  const older = [];
  {
    const sysUp = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    const ageOf = (pid) => {
      const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const after = st.slice(st.lastIndexOf(')') + 2).split(' ');
      return sysUp - Number(after[19]) / 100; // field 22 overall = starttime, in clock ticks
    };
    const mine = ageOf(process.pid);
    for (const d of readdirSync('/proc')) {
      const pid = Number(d);
      if (!pid || pid === process.pid) continue;
      let argv = [];
      try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
      if (!/(^|\/)node$/.test(argv[0] || '')) continue;
      if (!argv.some((a) => a.endsWith('tools/check-all.mjs'))) continue;
      let age = NaN;
      try { age = ageOf(pid); } catch { continue; }
      if (age > mine + 0.5 || (Math.abs(age - mine) <= 0.5 && pid < process.pid)) {
        older.push(`${pid} (${Math.round(age)}s in)`);
      }
    }
  }
  if (older.length) {
    console.error(`check-all: another run is already going — pid ${older.join(', ')}.`);
    console.error('  two suites share one X display and one game server; they would fail each other.'
      + '  wait for it, or kill it first.');
    return 2;
  }

  for (const s of wanted) {
    const need = s.needs || (s.group === 'browser' ? 'browser' : null);
    const missing = need === 'browser' ? ['display', 'app', 'api'].filter((k) => !have.has(k))
      : need && !have.has(need) ? [need] : [];
    if (missing.length) {
      rows.push({ ...s, status: 'SKIP', detail: `missing ${missing.join('+')}`, secs: 0 });
      console.log(`${pad('SKIP', 12)} ${pad(idOf(s), 18)} missing ${missing.join('+')}`);
      continue;
    }
    const file = `tools/${s.name}.mjs`;
    if (!existsSync(new URL(`../${file}`, import.meta.url))) {
      rows.push({ ...s, status: 'MISSING', detail: file, secs: 0 });
      console.log(`${pad('MISSING', 12)} ${pad(idOf(s), 18)} ${file}`);
      continue;
    }

    const logPath = `${runDir}/${idOf(s)}.log`;
    const t0 = Date.now();
    // `process.execPath`, not `'node'`: PATH here resolves to /usr/bin/node v18, which has no
    // global `WebSocket` and no `path.join` tolerance for the URL forms these probes use — so a
    // suite started from an nvm shell (v22) handed four probes a different interpreter and they
    // died on `ReferenceError: WebSocket is not defined` after their first few green lines.
    // That reads exactly like a product regression in the gateway. The suite must run its
    // children on the interpreter it is itself running on.
    const r = await run(process.execPath, [file, ...argsFor(s)], {
      timeout: s.timeout || 15 * MIN, logPath,
      env: { DISPLAY, LIBGL_ALWAYS_SOFTWARE: '1', GAME_API: API, GAME_APP: APP, API_BASE: API },
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    const text = await readFile(logPath, 'utf8').catch(() => '');
    const a = readLog(text, s);
    const status = r.code === 'TIMEOUT' ? 'TIMEOUT'
      : a.failed > 0 || r.code !== 0 ? 'RED'
        : a.passed === 0 ? 'NO-EVIDENCE'
          : 'GREEN';
    const detail = status === 'TIMEOUT' ? `killed after ${secs}s`
      : status === 'NO-EVIDENCE' ? `exit ${r.code} but no assertion count in the log`
        : `${a.passed} passed, ${a.failed} failed${a.skipped ? `, ${a.skipped} skipped` : ''} (exit ${r.code})`;
    rows.push({ ...s, status, detail, secs, ...a, exit: r.code });
    console.log(`${pad(status, 12)} ${pad(idOf(s), 18)} ${pad(`${secs}s`, 7)} ${detail}`);
    if (BAIL && status !== 'GREEN') break;
  }

  /* ------------------------------------------------------------- summary -- */
  const bad = rows.filter((r) => r.status !== 'GREEN' && r.status !== 'SKIP');
  const green = rows.filter((r) => r.status === 'GREEN');
  const asserts = green.reduce((n, r) => n + (r.passed || 0), 0);
  const lines = [
    `# check-all ${stamp}`, '',
    `- app ${APP}, api ${API}, display ${DISPLAY}`,
    `- ${green.length}/${rows.length} probes GREEN, ${asserts} assertions passed`,
    `- ${bad.length} not green, ${rows.filter((r) => r.status === 'SKIP').length} skipped`,
    `- wall clock ${Math.round(rows.reduce((n, r) => n + r.secs, 0) / 60)} min`, '',
    '| probe | group | status | assertions | secs | log |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${idOf(r)} | ${r.group} | ${r.status} | ${r.detail} | ${r.secs} | ${idOf(r)}.log |`),
  ];
  writeFileSync(`${runDir}/SUMMARY.md`, `${lines.join('\n')}\n`);

  console.log(`\n${green.length}/${rows.length} GREEN · ${asserts} assertions · ${bad.length} not green`);
  if (bad.length) console.log(`not green: ${bad.map((r) => `${idOf(r)}(${r.status})`).join(' ')}`);
  console.log(`summary → ${runDir}/SUMMARY.md`);
  return bad.length;
}

function argsFor(s) {
  if (s.args) return s.args;
  if (s.art) return [APP, `${runDir}/art-${idOf(s)}`];
  return [];
}

process.exit(await main());
