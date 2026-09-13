// Full-screen panels: character, inventory, quests, wish, map, party, settings,
// plus the two transient modals (NPC dialogue, dungeon confirmation).
//
// Panels are built on open and thrown away on close. Unlike the HUD they are not
// on the frame path, so the cheap thing is to re-render whole subtrees from the
// server's player document after every mutation — that way the panel can never
// disagree with the authoritative state, which is the failure mode that actually
// bites in a game with a server-side inventory.

import { frag, h, q, on, text, num, pct, hexColor, ELEMENT_GLYPH, clearChildren } from './dom.js';
import { api, errorText } from '../net/api.js';
import { CHARACTERS, WEAPON_TYPES } from '@teyvat/shared/data/characters.js';
import { ELEMENTS } from '@teyvat/shared/data/elements.js';
import {
  WEAPONS, ARTIFACT_SETS, ARTIFACT_SLOTS, SLOT_NAMES, MATERIALS, rewardList, itemIcon, itemName,
  equipName, equipIcon,
} from '@teyvat/shared/data/items.js';
import { QUESTS } from '@teyvat/shared/data/quests.js';
import { questTarget, trackedQuest } from '@teyvat/shared/data/questNav.js';
import { TELEPORT_TYPES, isAnchorUnlocked, zoneProgress } from '@teyvat/shared/data/anchors.js';
import {
  zoneExploration, exploreClaim, EXPLORED_KINDS, isFound,
} from '@teyvat/shared/data/exploration.js';
import { consumableRefusal } from '@teyvat/shared/world/consumables.js';
import {
  RECIPES, RECIPE_IDS, QUALITY, cookOdds, maxPortions, ingredientText,
} from '@teyvat/shared/data/recipes.js';
import { xpForLevel } from '@teyvat/shared/sim/formulas.js';
import {
  enhanceArtifact, artifactFodderXp, artifactLevelCost, artifactXpToCap,
  ARTIFACT_LEVEL_CAP, ARTIFACT_MORA_PER_XP,
  weaponStats, weaponCapFor, weaponXpForLevel, weaponXpToLevel, levelUpWeapon,
  oreXp, refineMul, canRefineWith, wishRate5,
  WEAPON_ORE, WEAPON_MORA_PER_XP, WEAPON_REFINE_MAX, WISH_CONVERSION,
} from '@teyvat/shared/sim/loot.js';
import {
  ZONES, zoneById, zoneEntryRank, canEnterZone, DOMAIN_RESIN, chamberEnemies, chamberEntry,
  npcRoleName,
} from '@teyvat/shared/data/zones.js';
import { disorderById, disorderHint } from '@teyvat/shared/data/disorders.js';
import {
  RESONANCES, partyResonances, resonanceHint, resonanceCondition,
} from '@teyvat/shared/data/resonance.js';
import { SHOP_IDS, isCurrency, GEM_PER_WISH } from '@teyvat/shared/data/shop.js';
import { attachLines, hasAttachments } from '@teyvat/shared/data/mail.js';
import {
  ACH_GROUPS, ACH_STATS, achByGroup, achSummary, tierGems, TIER_LABELS,
} from '@teyvat/shared/data/achievements.js';
import {
  EXPEDITIONS, EXPEDITION_HOURS, expeditionEntry, expeditionPayout, expeditionState,
  expeditionTotal, isDestRefusal,
} from '@teyvat/shared/data/expeditions.js';
import { untilText } from '@teyvat/shared/sim/clock.js';
import { controlGroups } from '../game/input.js';
import { navWhere } from './navtext.js';
import { drawFullMap, bakeZoneMap } from './mapview.js';
import { Portrait } from './portrait.js';

const TITLES = {
  character: '角色', inventory: '背包', quests: '任务',
  wish: '祈愿', map: '地图', party: '队伍', settings: '设置',
  cook: '料理', social: '好友', shop: '商店', mail: '邮件',
  achievements: '成就', expedition: '派遣',
};

/**
 * How long a 派遣 has left. `untilText` stops at minutes, which reads 「0分」 for the last sixty
 * seconds of a trip — the one minute the player is actually watching the number.
 */
function remainText(sec) {
  return sec >= 60 ? untilText(sec * 1000) : `${sec} 秒`;
}

/**
 * An item map as one line: `{ ironChunk: 4 }` → `⛏铁块 ×4`.
 *
 * `rewardList` next door answers about a *reward* (mora, 原石, xp, then items as pairs); a 派遣
 * pays materials only, and its payout is already an id→count map in the order the destination
 * declares its nodes. Insertion order is kept on purpose: the biggest yield comes first, which
 * is how `buildDestinations` sorts them.
 */
function itemLine(map) {
  return Object.entries(map || {})
    .map(([id, n]) => `${itemIcon(id)}${itemName(id)} ×${num(n)}`)
    .join(' · ');
}

/**
 * A letter's date. The `short` form exists because the list column is ~200px wide and
 * "冒险家协会 · 凯瑟琳 · 9月5日 14:27" wrapped mid-date there, splitting "9月5" from "日 14:27".
 */
function mailDate(ts, short = false) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return short ? `${d.getMonth() + 1}/${d.getDate()} ${clock}`
    : `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
}

/** How long a limited entry's stock label reads: the period, not the deadline. */
const PERIOD_NAME = { permanent: '不限', daily: '今日', weekly: '本周', monthly: '本月' };

/** Stat display: label plus whether the value is a ratio. */
const STAT_LABEL = {
  hp: ['生命值', 0], atk: ['攻击力', 0], def: ['防御力', 0],
  hpPct: ['生命值', 1], atkPct: ['攻击力', 1], defPct: ['防御力', 1],
  critRate: ['暴击率', 1], critDmg: ['暴击伤害', 1],
  em: ['元素精通', 0], er: ['元素充能效率', 1], healBonus: ['治疗加成', 1],
  physical: ['物理伤害加成', 1], fire: ['炎元素伤害加成', 1], water: ['水元素伤害加成', 1],
  ice: ['冰元素伤害加成', 1], lightning: ['雷元素伤害加成', 1], wind: ['风元素伤害加成', 1],
  earth: ['岩元素伤害加成', 1], light: ['光元素伤害加成', 1],
  normalDmg: ['普通攻击伤害', 1], chargedDmg: ['重击伤害', 1], skillDmg: ['元素战技伤害', 1],
  burstDmg: ['元素爆发伤害', 1], aimedDmg: ['瞄准射击伤害', 1],
  atkSpeed: ['攻击速度', 1], cdReduction: ['冷却缩减', 1],
  shieldStrength: ['护盾强效', 1], dr: ['伤害减免', 1], defShred: ['减防', 1],
};

function statText(key, value) {
  const [label, isPct] = STAT_LABEL[key] || [key, 0];
  return [label, isPct ? `${(value * 100).toFixed(1)}%` : num(value)];
}

const PIN_GLYPH = {
  waypoint: '◈', chest: '▣', puzzle: '✦', dungeon: '⊗',
  statue: '⛩', warmth: '✹', npc: '☻', quest: '❢',
};

/** Leaderboard tabs, in the order the party panel shows them. */
const LEADERBOARDS = [['score', '冒险经验'], ['abyss', '深境星数'], ['damage', '最高伤害'], ['kills', '讨伐数']];

/**
 * Wish change, in display order. Derived from the shared conversion table rather than typed,
 * so a third kind of change (or a renamed one) shows up in the panel by itself — the table is
 * what the server pays out with.
 */
const CHANGE_IDS = [...new Set(Object.values(WISH_CONVERSION)
  .flatMap((v) => (v.starglitter || v.stardust ? [v] : Object.values(v)))
  .flatMap((m) => Object.keys(m)))];

/** `{ starglitter: 2 }` → `✦星辉 +2`, in `CHANGE_IDS` order. Empty map gives ''. */
function changeLine(map) {
  return CHANGE_IDS
    .filter((id) => map?.[id])
    .map((id) => `${MATERIALS[id].icon}${MATERIALS[id].name} +${num(map[id])}`)
    .join(' · ');
}

/** Must match the 画质 dropdown below and the HUD's downgrade notice. */
const QUALITY_NAME = { low: '流畅', medium: '标准', high: '高', ultra: '极致' };

/** The number a board row is ranked by, formatted for its board. */
function boardValue(board, r) {
  if (board === 'abyss') return `${r.abyss_stars ?? 0} ★ · 第 ${r.abyss_floor ?? 0} 间`;
  if (board === 'damage') return num(r.max_damage ?? 0);
  if (board === 'kills') return `${num(r.kills ?? 0)} 击破`;
  return num(r.score ?? 0);
}

export class Panels {
  constructor(root, game) {
    this.game = game;
    this.root = root;
    this.name = null;
    this.el = null;
    this.modal = null;
    this._state = {
      charId: null, invTab: 'material', selUid: null, selItem: null,
      pool: 'featured', mapZone: null, board: 'score',
      // Artifact enhancement: the uid being levelled, and the pieces marked to be eaten.
      enhancing: null, fodder: new Set(),
      // Weapon growth: the uid being levelled, and how many of each ore is offered.
      // Ore is a counted material rather than a bag of items, so it needs a stepper
      // per kind instead of the artifact grid's click-to-mark.
      wpnUp: null, ore: {},
      // Shop: which counter is open. The catalogue itself is not kept here — it is
      // fetched into `_shopView` because stock has to be re-read from the server, and
      // caching it in panel state is how a sold-out row survives its own reset.
      shop: SHOP_IDS[0],
      // Mail: which letter is open, by row id. The box itself is `_mailBox`, dropped with
      // the panel for the same reason the shop view is.
      mail: null,
      // Achievements: which category is open. Progress is server-derived (`_achView`).
      ach: ACH_GROUPS[0].id,
      // 派遣: the destination row selected, the duration pill, and who is being sent. All
      // three are only *proposals* — `expeditionEntry` decides whether they add up.
      expDest: null, expHours: EXPEDITION_HOURS[0], expChar: null,
    };
    this._offs = [];
    // Live character portrait; built on first use of the character panel because it
    // costs a WebGL context, torn down with the panel.
    this._portrait = null;
    this._bind();
    // The first mailbox fetch is also what hands out today's sign-in gift (the GET is the
    // scheduler — see `server/src/routes/mail.js`), so it runs at boot instead of waiting for
    // the player to press I. A reward nobody is told about is not a reward, and the HUD badge
    // this feeds is the only thing that says the mailbox is worth opening.
    this._mailBoot = setTimeout(() => this._loadMail(), 1200);
    // Achievements are derived from state, so nothing pushes "you earned one" over the wire —
    // the number only changes when the snapshot is re-read. A slow poll is what turns that into
    // a live trophy badge; it is one small query, and 90 s is chosen so a kill that finishes an
    // achievement is noticed within a fight rather than at the next panel opening.
    this._achBoot = setTimeout(() => this._loadAch(), 1800);
    this._achPoll = setInterval(() => this._loadAch(true), 90_000);
    // 派遣 is the one system whose state changes while nobody is playing, so the boot fetch is
    // not a nicety: a player who logs in the morning after sending four characters out has to
    // be *told*, and the HUD chip this feeds is the only thing that says so. The poll is slow
    // on purpose — a trip is hours long, and the panel does its own per-second arithmetic on
    // the snapshot it already holds rather than asking the server what time it is.
    this._expBoot = setTimeout(() => this._loadExp(true), 2200);
    this._expPoll = setInterval(() => this._loadExp(true), 120_000);
    // The second-hand runs whether or not the panel is open, and that is the point: the moment a
    // trip finishes is the moment the HUD chip has to appear, and a player who is fighting rather
    // than reading a panel would otherwise not be told until the next poll two minutes later. It
    // costs one comparison a second against data already in memory — no request, no DOM — and
    // only touches the countdown text when the panel is actually on screen.
    this._expClock = setInterval(() => this._expTick(), 1000);
  }

  get isOpen() { return !!this.el; }
  get modalOpen() { return !!this.modal; }

  _bind() {
    const g = this.game;
    g.on('togglePanel', ({ panel, open, zone }) => {
      if (open) this.open(panel);
      else this.toggle(panel);
      // `open()` resets the map's selection to the zone the player is standing in, so a caller that
      // named a zone (the HUD's 🎁 chip) has to be honoured *after* it — setting `_state.mapZone`
      // first would be overwritten and the click would land on the wrong zone's footer button.
      if (zone && this.name === panel && this._state.mapZone !== zone) {
        this._state.mapZone = zone;
        this._render();
      }
    });
    g.on('dialogue', (d) => this.dialogue(d));
    g.on('confirmDungeon', (d) => this.confirmDungeon(d));
    g.on('chamberReward', (d) => this.chamberReward(d));
    g.on('partyInvite', (d) => this.partyInvite(d));
    // Character and inventory read straight out of the player document, so any
    // server-side mutation has to redraw them; the other panels either own their
    // own refresh (wish results, map pins) or would lose transient state.
    g.on('playerState', () => {
      if (this.name === 'character' || this.name === 'inventory') this._render();
    });
  }

  /* ----------------------------------------------------------------- shell -- */

  toggle(name) {
    if (this.name === name) this.close();
    else this.open(name);
  }

  open(name) {
    if (!TITLES[name]) return;
    if (this.el) this._teardown();
    this.name = name;
    const g = this.game;
    // 新手引导: this line, not the hotkey handler, is the moment a panel is *open* — the key
    // only emits `togglePanel`, and a second press of the same key closes it again. The map is
    // its own step because it is the one panel that is also a navigation tool.
    g.tutorial?.mark(name === 'map' ? 'map' : 'panel');
    this._state.charId = this._state.charId || g.party?.[g.activeSlot] || null;
    this._state.mapZone = g.zoneId;

    this.el = frag(`
      <div class="scrim">
        <div class="panel">
          <header>
            <h2></h2>
            <div class="tabs"></div>
            <div class="spacer"></div>
            <button class="close" title="关闭 (Esc)">✕</button>
          </header>
          <div class="body"></div>
          <footer></footer>
        </div>
      </div>`);
    this.root.appendChild(this.el);
    text(q(this.el, 'h2'), TITLES[name]);

    // Top-level tabs double as panel navigation; a player in the inventory who
    // wants the character screen should not have to close and press a key.
    const tabs = q(this.el, '.tabs');
    for (const [k, label] of Object.entries(TITLES)) {
      const t = h('div', `tab${k === name ? ' active' : ''}`, label);
      t.dataset.panel = k;
      tabs.appendChild(t);
    }
    this._offs.push(on(tabs, 'click', (e) => {
      const p = e.target.closest('.tab')?.dataset.panel;
      if (p && p !== this.name) this.open(p);
    }));

    this._offs.push(on(q(this.el, '.close'), 'click', () => this.close()));
    // Click-outside closes: the scrim is the click target only when the click
    // missed the panel itself.
    this._offs.push(on(this.el, 'mousedown', (e) => { if (e.target === this.el) this.close(); }));

    this.game.setPaused(true);
    this._render();
    // Also on a tab switch, which goes through here: the panel really did change, and
    // `close` already answers on the way out.
    this.game.audio.sfx('open');
  }

  close() {
    if (!this.el) return;
    this._teardown();
    this.name = null;
    if (!this.modal) this.game.setPaused(false);
    this.game.audio.sfx('close');
  }

  _teardown() {
    for (const off of this._offs) off();
    this._offs = [];
    // The portrait owns a WebGL context; leaving it alive behind a closed panel keeps
    // a second context and a rAF loop running for the rest of the session.
    this._portrait?.dispose();
    this._portrait = null;
    // Server-owned views die with the panel. Both of these are resolved against the wall
    // clock — shop stock belongs to a period, an attachment expires — so a view kept across
    // openings can insist a daily limit is spent in a period that has already ended.
    this._shopView = null;
    this._mailBox = null;
    this._achView = null;
    // The 派遣 snapshot deliberately survives, unlike the three above (see `_expCounts`): it is
    // what the HUD chip counts, and nothing in it can go stale. Its second hand is not stopped
    // here either — it belongs to the session, not to the panel.
    this.el.remove();
    this.el = null;
  }

  _render() {
    if (!this.el) return;
    const body = q(this.el, '.body');
    const foot = q(this.el, 'footer');
    clearChildren(body);
    clearChildren(foot);
    switch (this.name) {
      case 'character': this._character(body, foot); break;
      case 'inventory': this._inventory(body, foot); break;
      case 'quests': this._quests(body, foot); break;
      case 'wish': this._wish(body, foot); break;
      case 'cook': this._cook(body, foot); break;
      case 'map': this._map(body, foot); break;
      case 'party': this._party(body, foot); break;
      case 'social': this._social(body, foot); break;
      case 'shop': this._shop(body, foot); break;
      case 'mail': this._mail(body, foot); break;
      case 'achievements': this._achievements(body, foot); break;
      case 'expedition': this._expedition(body, foot); break;
      case 'settings': this._settings(body, foot); break;
      default: break;
    }
  }

  /**
   * Run an API call and fold its authoritative response back into the game.
   * Applying the player document emits `playerState`, which is what redraws the
   * panel — callers that need a redraw for other reasons ask for one themselves.
   */
  async _act(fn, okMsg) {
    try {
      const res = await fn();
      if (res?.stats) this.game.stats = res.stats;
      if (res?.player) this.game._applyPlayer(res.player, false);
      // Every build change in this file answers with `stats` (and a party edit with
      // `party`), and a stat block the panel prints but the simulation never hears is the
      // whole progression loop going nowhere until the next zone load. One door here, one
      // door on the server (`publishStats`).
      if (res?.stats || res?.party) this.game.applyBuild(res.stats, res.party || res.player?.party);
      if (okMsg) this.game.toast(okMsg, 'good');
      return res;
    } catch (e) {
      this.game.toast(errorText(e), 'bad');
      return null;
    }
  }

  /* ------------------------------------------------------------- character -- */

  _character(body, foot) {
    const g = this.game;
    const owned = Object.keys(g.player?.characters || {});
    if (!owned.includes(this._state.charId)) this._state.charId = owned[0];
    const charId = this._state.charId;

    const side = h('div', 'col side');
    for (const id of owned) {
      const def = CHARACTERS[id];
      const inst = g.player.characters[id];
      const row = frag(`<div class="list-row${id === charId ? ' sel' : ''}">
        <div class="t"><b></b><small></small></div>
        <span class="stars"></span>
      </div>`);
      row.dataset.char = id;
      q(row, 'b').textContent = def?.name || id;
      q(row, 'small').textContent = `Lv.${inst.level} · ${ELEMENTS[def?.element]?.name || ''}${inst.dupes ? ` · C${inst.dupes}` : ''}`;
      q(row, '.stars').textContent = '★'.repeat(def?.rarity || 4);
      side.appendChild(row);
    }
    this._offs.push(on(side, 'click', (e) => {
      const id = e.target.closest('[data-char]')?.dataset.char;
      if (id) { this._state.charId = id; this._render(); }
    }));

    const def = CHARACTERS[charId];
    const inst = g.player.characters[charId];
    const st = g.stats?.[charId] || {};
    const main = h('div', 'col main');
    if (!def || !inst) { main.appendChild(h('p', 'muted', '没有可显示的角色。')); body.append(side, main); return; }

    const elColor = hexColor(ELEMENTS[def.element]?.color);
    const wrap = frag(`
      <div style="display:flex;gap:18px;align-items:flex-start">
        <div style="flex:0 0 210px">
          <div class="portrait"><div class="big"></div><div class="el-badge"></div></div>
          <div class="stars center"></div>
          <div class="center tiny muted" data-f="title"></div>
        </div>
        <div style="flex:1;min-width:0">
          <h3 class="sec" data-f="name"></h3>
          <dl class="stats" data-f="stats"></dl>
          <hr class="sep">
          <h3 class="sec">天赋</h3>
          <div data-f="talents"></div>
          <hr class="sep">
          <h3 class="sec">装备</h3>
          <div class="grid" data-f="equip"></div>
        </div>
      </div>`);
    const portrait = q(wrap, '.portrait');
    portrait.style.setProperty('--el', elColor);
    q(wrap, '.big').textContent = def.name[0];
    // Live 3D render of the actual rig. Kept on `this` so switching characters in the
    // side list reuses one GL context instead of leaking one per click; disposed in
    // _teardown. The glyph above stays as the fallback if the context fails.
    try {
      this._portrait ||= new Portrait();
      this._portrait.setCharacter(charId);
      portrait.appendChild(this._portrait.canvas);
      portrait.classList.add('has3d');
      this._portrait.start();
    } catch (e) {
      console.warn('[panels] portrait render unavailable:', e.message);
      this._portrait = null;
    }
    q(wrap, '.el-badge').textContent = ELEMENT_GLYPH[def.element] || '?';
    q(wrap, '.stars').textContent = '★'.repeat(def.rarity);
    q(wrap, '[data-f="title"]').textContent = def.title || '';
    q(wrap, '[data-f="name"]').textContent = `${def.name} · Lv.${inst.level}${inst.ascension ? ` ✦${inst.ascension}` : ''}`;

    const dl = q(wrap, '[data-f="stats"]');
    const rows = [
      ['等级经验', `${num(inst.xp)} / ${num(xpForLevel(inst.level))}`],
      ['武器类型', WEAPON_TYPES[def.weapon]?.name || def.weapon],
      ...[['maxHp', st.maxHp], ['atk', st.atk], ['def', st.def]].map(([k, v]) => {
        const label = k === 'maxHp' ? '生命值上限' : k === 'atk' ? '攻击力' : '防御力';
        return [label, num(v || 0)];
      }),
      ['暴击率', `${((st.critRate || 0) * 100).toFixed(1)}%`],
      ['暴击伤害', `${((st.critDmg || 0) * 100).toFixed(1)}%`],
      ['元素精通', num(st.em || 0)],
      ['元素充能效率', `${((st.er || 1) * 100).toFixed(1)}%`],
    ];
    const elemBonus = st.elemBonus?.[def.element] || 0;
    if (elemBonus) rows.push([`${ELEMENTS[def.element]?.name || ''}伤害加成`, `${(elemBonus * 100).toFixed(1)}%`]);
    for (const [k, v] of rows) {
      dl.append(h('dt', '', k), h('dd', '', v));
    }
    // The weapon's own passive, in the wielder's panel: it is scaled by refinement here
    // (`weaponStats` applied `refineMul` before this text was picked), so an R3 sword
    // shows the number it actually deals rather than the rank-1 text from the bag.
    const wDef = st.weaponId ? WEAPONS[st.weaponId] : null;
    if (wDef?.desc) dl.append(h('dt', 'gold', `${wDef.name} 被动`), h('dd', 'up', wDef.desc));
    for (const s of st.activeSets || []) {
      const set = ARTIFACT_SETS[s.setId];
      if (!set) continue;
      const four = s.pieces >= 4;
      // A 4-piece bonus with an unmet precondition (角斗士的终幕礼 on a catalyst) is
      // listed but marked: the tooltip used to promise it unconditionally, and now the
      // stats really do withhold it.
      const dead = four && s.fourActive === false;
      dl.append(
        h('dt', dead ? '' : 'gold', `${set.name} ${s.pieces}件`),
        h('dd', dead ? 'tiny' : 'up', four
          ? set.fourDesc + (dead ? '（当前武器类型不满足条件，未生效）' : '')
          : set.twoDesc),
      );
    }

    // Talents. Costs live server-side, so the button just tries and reports.
    const tal = q(wrap, '[data-f="talents"]');
    for (const [which, label, source] of [
      ['normal', '普通攻击', { name: `${WEAPON_TYPES[def.weapon]?.name || ''}·连击`, desc: `${def.normal.hits.length} 段连击，重击倍率 ${def.charged.mult.toFixed(2)}×` }],
      ['skill', '元素战技', def.skill],
      ['burst', '元素爆发', def.burst],
    ]) {
      const lvl = inst.talents?.[which] || 1;
      const row = frag(`<div class="talent">
        <div class="tico"></div>
        <div class="tinfo"><b></b><small></small></div>
        <button class="btn small" data-talent="">Lv.${lvl} ↑</button>
      </div>`);
      q(row, '.tico').textContent = which === 'normal' ? '⚔' : which === 'skill' ? ELEMENT_GLYPH[def.element] : '❋';
      q(row, 'b').textContent = `${label}：${source.name || ''}`;
      q(row, 'small').textContent = source.desc || '';
      q(row, 'button').dataset.talent = which;
      tal.appendChild(row);
    }
    this._offs.push(on(tal, 'click', (e) => {
      const which = e.target.dataset.talent;
      if (which) this._act(() => api.talent(charId, which), '天赋提升');
    }));

    // Equipment: weapon + five artifact slots, click to open the picker.
    const eq = q(wrap, '[data-f="equip"]');
    eq.appendChild(this._equipSlot('weapon', inst.weapon, charId));
    for (const slot of ARTIFACT_SLOTS) eq.appendChild(this._equipSlot(slot, inst.artifacts?.[slot], charId));
    this._offs.push(on(eq, 'click', (e) => {
      const slot = e.target.closest('[data-slot]')?.dataset.slot;
      if (slot) this._equipPicker(charId, slot);
    }));

    main.appendChild(wrap);
    body.append(side, main);

    // Footer: XP feeding and ascension.
    const xpBtns = h('div', '', '经验书：');
    for (const id of ['adventurerXp', 'heroWit']) {
      const have = g.player.inventory?.[id] || 0;
      const b = h('button', 'btn small', `${MATERIALS[id].icon} ${MATERIALS[id].name} ×${have}`);
      b.disabled = have <= 0;
      b.onclick = () => this._act(() => api.levelUp(charId, { [id]: Math.min(have, 20) }), '等级提升');
      xpBtns.appendChild(b);
    }
    const ascend = h('button', 'btn primary small', '突破');
    ascend.onclick = () => this._act(() => api.ascend(charId), '突破成功');
    const auto = h('button', 'btn small', '自动装备');
    auto.onclick = () => this._act(() => api.autoEquip(charId), '已装备最优组合');
    foot.append(xpBtns, h('div', 'spacer'), auto, ascend);
  }

  _equipSlot(slot, item, charId) {
    const label = slot === 'weapon' ? '武器' : SLOT_NAMES[slot];
    const el = frag(`<div class="slot${item ? '' : ' empty'}">
      <div class="ico"></div><div class="nm"></div><div class="lv"></div>
    </div>`);
    el.dataset.slot = slot;
    if (item) {
      const info = itemInfo(item);
      el.classList.add(`r${info.rarity}`);
      q(el, '.ico').textContent = info.icon;
      q(el, '.nm').textContent = info.name;
      q(el, '.lv').textContent = `Lv.${item.level}`;
    } else {
      q(el, '.ico').textContent = '＋';
      q(el, '.nm').textContent = label;
    }
    return el;
  }

  /** A narrow modal listing the equipment that fits one slot. */
  _equipPicker(charId, slot) {
    const g = this.game;
    const wType = CHARACTERS[charId]?.weapon;
    const pool = (g.player.equipment || []).filter((e) => (
      slot === 'weapon'
        ? e.kind === 'weapon' && WEAPONS[e.weaponId]?.type === wType
        : e.kind === 'artifact' && e.slot === slot
    ));
    const inst = g.player.characters[charId];
    const current = slot === 'weapon' ? inst.weapon : inst.artifacts?.[slot];

    const list = h('div', '');
    if (!pool.length) list.appendChild(h('p', 'muted', '没有可装备的物品。'));
    for (const it of pool) {
      const info = itemInfo(it);
      const row = frag(`<div class="list-row${current?.uid === it.uid ? ' sel' : ''}">
        <div class="t"><b></b><small></small></div>
        <span class="stars"></span>
      </div>`);
      row.dataset.uid = it.uid;
      q(row, 'b').textContent = `${info.icon} ${info.name}`;
      q(row, 'small').textContent = `${info.detail}${it.equippedBy && it.equippedBy !== charId ? ` · ${CHARACTERS[it.equippedBy]?.name || it.equippedBy} 已装备` : ''}`;
      q(row, '.stars').textContent = '★'.repeat(info.rarity);
      list.appendChild(row);
    }

    const m = this._modal(slot === 'weapon' ? '选择武器' : `选择${SLOT_NAMES[slot]}`, list, [
      current && ['卸下', 'ghost', async () => {
        this._closeModal();
        await this._act(() => api.unequip(charId, slot), '已卸下');
      }],
    ].filter(Boolean));
    this._offs.push(on(list, 'click', async (e) => {
      const uid = e.target.closest('[data-uid]')?.dataset.uid;
      if (!uid) return;
      this._closeModal();
      await this._act(() => api.equip(charId, uid, slot), '已装备');
    }));
    return m;
  }

  /* ------------------------------------------------------------- inventory -- */

  _inventory(body, foot) {
    const g = this.game;
    const tabs = { material: '材料', consumable: '食物', weapon: '武器', artifact: '圣遗物' };
    const side = h('div', 'col side');
    const tabRow = h('div', 'tabs');
    tabRow.style.flexDirection = 'column';
    for (const [k, label] of Object.entries(tabs)) {
      const t = h('div', `tab${k === this._state.invTab ? ' active' : ''}`, label);
      t.dataset.tab = k;
      tabRow.appendChild(t);
    }
    side.appendChild(tabRow);
    this._offs.push(on(tabRow, 'click', (e) => {
      const k = e.target.dataset.tab;
      if (k) {
        this._state.invTab = k;
        this._state.selUid = null;
        this._state.selItem = null;
        this._state.enhancing = null;
        this._state.fodder = new Set();
        this._state.wpnUp = null;
        this._state.ore = {};
        this._render();
      }
    }));

    side.append(h('hr', 'sep'), h('h3', 'sec', '详情'));
    const detail = h('div', '', h('p', 'muted tiny', '选择一个物品。'));
    side.appendChild(detail);

    const main = h('div', 'col main');
    const grid = h('div', 'grid');
    const tab = this._state.invTab;

    if (tab === 'material' || tab === 'consumable') {
      const entries = Object.entries(g.player.inventory || {})
        .filter(([id, qty]) => qty > 0 && MATERIALS[id] && MATERIALS[id].kind === (tab === 'material' ? 'material' : 'consumable'))
        .sort((a, b) => (MATERIALS[b[0]].xp || 0) - (MATERIALS[a[0]].xp || 0));
      if (!entries.length) grid.appendChild(h('p', 'muted', '空无一物。'));
      for (const [id, qty] of entries) {
        const def = MATERIALS[id];
        const slot = frag(`<div class="slot r${def.xp ? 4 : 3}${this._state.selItem === id ? ' sel' : ''}">
          <div class="ico"></div><div class="nm"></div><div class="ct"></div>
        </div>`);
        slot.dataset.item = id;
        q(slot, '.ico').textContent = def.icon;
        q(slot, '.nm').textContent = def.name;
        q(slot, '.ct').textContent = `×${num(qty)}`;
        grid.appendChild(slot);
      }
    } else {
      const items = (g.player.equipment || []).filter((e) => e.kind === tab);
      if (!items.length) grid.appendChild(h('p', 'muted', '空无一物。'));
      items.sort((a, b) => (itemInfo(b).rarity - itemInfo(a).rarity) || (b.level - a.level));
      const enh = this._state.enhancing;
      for (const it of items) {
        const info = itemInfo(it);
        // The weapon being levelled gets the same gold frame the enhancement target does;
        // ore is not in this grid, so there is nothing to mark as fodder alongside it.
        const mark = enh
          ? (it.uid === enh ? ' target' : this._state.fodder.has(it.uid) ? ' fodder' : '')
          : this._state.wpnUp === it.uid ? ' target'
            : (this._state.selUid === it.uid ? ' sel' : '');
        const slot = frag(`<div class="slot r${info.rarity}${mark}${it.equippedBy ? ' equipped' : ''}">
          <div class="ico"></div><div class="nm"></div><div class="lv"></div>
        </div>`);
        slot.dataset.uid = it.uid;
        q(slot, '.ico').textContent = info.icon;
        q(slot, '.nm').textContent = info.name;
        q(slot, '.lv').textContent = `${it.locked ? '🔒' : ''}Lv.${it.level}`
          + ((it.refinement || 1) > 1 ? ` R${it.refinement}` : '');
        grid.appendChild(slot);
      }
    }
    main.appendChild(grid);
    body.append(side, main);

    this._offs.push(on(grid, 'click', (e) => {
      const slot = e.target.closest('.slot');
      if (!slot) return;
      // In fodder-pick mode a click marks or unmarks material instead of changing the
      // selection — the target has to stay put while its fodder is chosen.
      if (this._state.enhancing) {
        const uid = slot.dataset.uid;
        if (!uid || uid === this._state.enhancing) return;
        const it = (this.game.player.equipment || []).find((x) => x.uid === uid);
        if (!it || it.equippedBy || it.locked) return this.game.toast('装备中或已锁定的圣遗物不能作为素材', 'bad');
        if (this._state.fodder.has(uid)) this._state.fodder.delete(uid);
        else if (this._state.fodder.size >= 20) return this.game.toast('一次最多 20 件素材', 'bad');
        else this._state.fodder.add(uid);
        return this._render();
      }
      this._state.selUid = slot.dataset.uid || null;
      this._state.selItem = slot.dataset.item || null;
      // The weapon pane has no fodder to pick in the grid, so a click there means "level
      // that one instead" — retarget rather than leaving the pane on a weapon the player
      // has visibly stopped pointing at, and drop the ore chosen for the old one.
      if (this._state.wpnUp && this._state.selUid && this._state.selUid !== this._state.wpnUp) {
        this._state.wpnUp = this._state.selUid;
        this._state.ore = {};
      }
      this._render();
    }));

    // Detail column for whatever is selected.
    clearChildren(detail);
    if (this._state.enhancing) {
      this._enhancePane(detail);
    } else if (this._state.wpnUp) {
      this._weaponPane(detail);
    } else if (this._state.selItem) {
      const def = MATERIALS[this._state.selItem];
      const qty = g.player.inventory?.[this._state.selItem] || 0;
      detail.append(
        h('h4', '', `${def.icon} ${def.name}`),
        h('p', 'tiny muted', materialDesc(def)),
        h('p', 'tiny', `持有 ${num(qty)}`),
      );
      if (def.kind === 'consumable') {
        const b = h('button', 'btn small primary', '使用');
        // Why it cannot be eaten right now, from the same function both hosts refuse with
        // (`shared/world/consumables.js`). A dish that would do nothing used to be spent
        // anyway, so the panel offered a button whose only effect was to destroy the item.
        // `use_via_menu` is not a refusal here — 浓缩树脂 *is* used from this menu, over REST.
        const why = g.me && def.kind === 'consumable' && !def.resin
          ? consumableRefusal(def, { hp: g.me.hp, maxHp: g.me.maxHp, alive: g.me.alive })
          : null;
        if (why) detail.appendChild(h('p', 'tiny down', errorText({ code: why })));
        // Food goes through the socket (see Game.useConsumable) — the REST route
        // would take the item and heal nobody. The gateway answers with events, not
        // a player document, so the count is patched here for an immediate redraw.
        b.onclick = () => this._act(async () => {
          const res = await g.useConsumable(this._state.selItem);
          if (res?.viaSocket) g.player.inventory[this._state.selItem] = Math.max(0, qty - 1);
          return res;
        }, `使用了${def.name}`).then(() => this._render());
        b.disabled = qty < 1 || !!why;
        detail.appendChild(b);
      }
    } else if (this._state.selUid) {
      const it = (g.player.equipment || []).find((e) => e.uid === this._state.selUid);
      if (it) {
        const info = itemInfo(it);
        detail.append(
          h('h4', '', `${info.icon} ${info.name}`),
          h('div', 'stars', '★'.repeat(info.rarity)),
          h('p', 'tiny muted', info.desc),
        );
        const dl = h('dl', 'stats');
        for (const [k, v] of info.stats) dl.append(h('dt', '', k), h('dd', '', v));
        detail.appendChild(dl);
        if (it.equippedBy) detail.appendChild(h('p', 'tiny gold', `${CHARACTERS[it.equippedBy]?.name || it.equippedBy} 装备中`));
        if (it.kind === 'artifact') {
          const lv = it.level || 0;
          if (lv >= ARTIFACT_LEVEL_CAP) detail.appendChild(h('p', 'tiny gold', `已满级 +${ARTIFACT_LEVEL_CAP}`));
          else {
            const next = artifactLevelCost(it.rarity, lv);
            detail.appendChild(h('p', 'tiny muted',
              `下一级需 ${num(next)} 强化经验（${num(Math.round(next * ARTIFACT_MORA_PER_XP))} 摩拉），`
              + `满级还需 ${num(artifactXpToCap(it))}`));
            const b = h('button', 'btn small primary', '强化');
            b.onclick = () => { this._state.enhancing = it.uid; this._state.fodder = new Set(); this._render(); };
            detail.appendChild(b);
          }
        }
        if (it.kind === 'weapon') {
          const rarity = WEAPONS[it.weaponId]?.rarity ?? 4;
          const cap = weaponCapFor(it, g.player.adventureRank);
          const hard = weaponCapFor(it, 99);
          const r = it.refinement || 1;
          if (it.level >= cap) {
            // Two very different ceilings, and saying which one it is matters: one is
            // "this weapon is finished", the other is "come back at a higher rank".
            detail.appendChild(h('p', 'tiny gold', cap >= hard
              ? `已满级 Lv.${cap}`
              : `Lv.${cap} 是当前冒险等级的上限（这把武器最高 Lv.${hard}）`));
          } else {
            const next = weaponXpForLevel(rarity, it.level);
            detail.appendChild(h('p', 'tiny muted',
              `下一级需 ${num(Math.max(0, next - (it.xp || 0)))} 强化经验，`
              + `Lv.${cap} 还需 ${num(weaponXpToLevel(rarity, cap) - weaponXpToLevel(rarity, it.level) - (it.xp || 0))}`));
            const b = h('button', 'btn small primary', '强化');
            b.onclick = () => { this._state.wpnUp = it.uid; this._state.ore = {}; this._render(); };
            detail.appendChild(b);
          }
          if (r > 1) {
            // The `desc` above is the rank-1 text (it is one authored string in
            // `items.js`), so the multiplier has to say that it applies *to that text* —
            // otherwise a refined weapon reads as if nothing changed.
            detail.appendChild(h('p', 'tiny gold',
              `精炼 ${r}／${WEAPON_REFINE_MAX} · 被动效果 ×${refineMul(r).toFixed(2)}`
              + '（上面描述里的数值按此倍率生效）'));
          }
          const dupes = (g.player.equipment || []).filter((e) => canRefineWith(it, e));
          if (r < WEAPON_REFINE_MAX && dupes.length) {
            const b = h('button', 'btn small', `精炼（${dupes.length} 把同名武器）`);
            b.onclick = () => this._act(
              () => api.refineWeapon(it.uid, dupes.map((e) => e.uid)),
              null,
            ).then((res) => {
              if (res) g.toast(`精炼 ${res.from} → ${res.refinement}，消耗 ${res.consumed} 把`, 'good');
              this._render();
            });
            detail.appendChild(b);
          } else if (r >= WEAPON_REFINE_MAX) {
            detail.appendChild(h('p', 'tiny muted', '已是满精炼。'));
          }
        }
        const lock = h('button', 'btn small', it.locked ? '解锁' : '锁定');
        lock.onclick = () => this._act(() => api.lockItem(it.uid, !it.locked),
          it.locked ? '已解锁' : '已锁定，不会被分解或当作强化素材').then(() => this._render());
        detail.appendChild(lock);
        if (!it.equippedBy) {
          const b = h('button', 'btn small', '分解');
          b.disabled = !!it.locked;
          b.onclick = () => this._act(() => api.salvage([it.uid]), '已分解');
          detail.appendChild(b);
        }
      }
    } else {
      detail.appendChild(h('p', 'muted tiny', '选择一个物品。'));
    }

    const counts = `摩拉 ${num(g.player.mora)} · 原石 ${num(g.player.primogem)} · 树脂 ${num(g.player.resin)}`;
    foot.append(h('span', '', counts), h('div', 'spacer'));
    if (this._state.invTab === 'artifact') {
      const b = h('button', 'btn small', '分解全部未装备的三星');
      b.onclick = () => {
        const uids = (g.player.equipment || [])
          .filter((e) => e.kind === 'artifact' && !e.equippedBy && !e.locked && e.rarity <= 4 && e.level < 4)
          .map((e) => e.uid);
        if (!uids.length) return this.game.toast('没有可分解的圣遗物', 'bad');
        return this._act(() => api.salvage(uids), `分解了 ${uids.length} 件`);
      };
      foot.appendChild(b);
    }
  }

  /**
   * The enhancement pane: target on top, marked fodder below, the resulting level in
   * between.
   *
   * The preview calls the same `enhanceArtifact` the route calls, with a throwaway seed:
   * only `level` and `spent` are read, and those two are deterministic — the sub-stat
   * rolls are not, and pretending otherwise would show the player numbers the server is
   * about to contradict. Fodder is deliberately picked by hand rather than auto-selected
   * by rarity: a 5★ piece with two crit sub-stats and the wrong main stat is worth more
   * to a considered player than any heuristic here could know.
   */
  _enhancePane(detail) {
    const g = this.game;
    const all = g.player.equipment || [];
    const it = all.find((e) => e.uid === this._state.enhancing);
    if (!it) { this._state.enhancing = null; return; }
    const info = itemInfo(it);
    const picked = [...this._state.fodder].map((u) => all.find((e) => e.uid === u)).filter(Boolean);
    const xp = picked.reduce((a, e) => a + artifactFodderXp(e), 0);
    const pre = enhanceArtifact(it, xp, 1);
    const mora = Math.round(pre.spent * ARTIFACT_MORA_PER_XP);
    const short = mora > (g.player.mora || 0);

    detail.append(
      h('h4', '', `强化 ${info.icon} ${info.name}`),
      h('div', 'stars', '★'.repeat(info.rarity)),
      h('p', 'tiny', `+${it.level}${pre.levels > 0 ? ` → +${pre.level}` : ''}`
        + `　满级 +${ARTIFACT_LEVEL_CAP}`),
      h('p', 'tiny muted', '在左侧点选要吃掉的圣遗物。装备中和已锁定的不能选，'
        + '只会消耗到满级所需的那几件——多点的留在背包里。'),
      h('p', 'tiny', `已选 ${picked.length} 件 · 强化经验 ${num(xp)}`
        + ` / 满级还需 ${num(artifactXpToCap(it))}`),
      h('p', short ? 'tiny bad' : 'tiny', `摩拉 ${num(mora)}`
        + (short ? `（持有 ${num(g.player.mora || 0)}，不够）` : '')),
    );
    if (pre.levels <= 0 && picked.length) {
      detail.appendChild(h('p', 'tiny bad',
        `还不够升一级（需 ${num(artifactLevelCost(it.rarity, it.level))}）`));
    }
    if (pre.xpLeft > 0 && pre.level >= ARTIFACT_LEVEL_CAP) {
      detail.appendChild(h('p', 'tiny muted', '已经够满级了，多余的素材不会被消耗。'));
    }

    const go = h('button', 'btn small primary', '确认强化');
    go.disabled = pre.levels <= 0 || short;
    go.onclick = () => this._act(
      () => api.enhanceArtifact(it.uid, [...this._state.fodder]),
      null,
    ).then((res) => {
      if (!res) return this._render();
      const bits = [`+${res.from} → +${res.level}`];
      if (res.newSubs?.length) {
        bits.push(`新词条 ${res.newSubs.map((s) => STAT_LABEL[s.key]?.[0] || s.key).join('、')}`);
      }
      g.toast(`强化成功 ${bits.join(' · ')}`, 'good');
      this._state.fodder = new Set();
      if (res.level >= ARTIFACT_LEVEL_CAP) this._state.enhancing = null;
      this._render();
    });
    const cancel = h('button', 'btn small', '返回');
    cancel.onclick = () => { this._state.enhancing = null; this._state.fodder = new Set(); this._render(); };
    detail.append(go, cancel);
  }

  /**
   * The weapon levelling pane: one stepper per ore kind, with the resulting level above.
   *
   * Ore is a counted material, not a bag of individually interesting items, so this is a
   * quantity form rather than the artifact grid's click-to-mark — there is no such thing
   * as "that particular iron chunk". The preview calls the same `levelUpWeapon` the route
   * calls, and unlike the artifact preview it is exact: weapon xp banks, so there is no
   * random component and nothing for the server to contradict.
   *
   * Cheapest ore first, matching the route: a player who taps 全部 on everything should
   * not watch starsilver disappear into a level iron would have paid for.
   */
  _weaponPane(detail) {
    const g = this.game;
    const all = g.player.equipment || [];
    const it = all.find((e) => e.uid === this._state.wpnUp);
    if (!it) { this._state.wpnUp = null; return; }
    const info = itemInfo(it);
    const rarity = WEAPONS[it.weaponId]?.rarity ?? 4;
    const cap = weaponCapFor(it, g.player.adventureRank);
    const need = Math.max(0, weaponXpToLevel(rarity, cap) - weaponXpToLevel(rarity, it.level) - (it.xp || 0));

    // Spend cheapest-first and only up to `need`, exactly as the route does.
    let xp = 0;
    const use = {};
    for (const oreId of WEAPON_ORE) {
      if (xp >= need) break;
      const want = Math.floor(this._state.ore[oreId] || 0);
      const have = g.player.inventory?.[oreId] || 0;
      const per = oreXp(oreId);
      const take = Math.min(want, have, Math.ceil((need - xp) / per));
      if (take <= 0) continue;
      use[oreId] = take;
      xp += take * per;
    }
    const pre = levelUpWeapon(it, xp, cap);
    const mora = Math.round(xp * WEAPON_MORA_PER_XP);
    const short = mora > (g.player.mora || 0);

    // Everything below goes inside one wrapper so the pane can tighten its own vertical
    // rhythm: `p` still carries the browser's 1em margins, and eight paragraphs of that is
    // ~160 px — enough to push 确认强化 out of the bottom of a 234 px column, which is the
    // same as having no confirm button at all.
    detail = detail.appendChild(h('div', 'wpn-up'));

    detail.append(
      h('h4', '', `强化 ${info.icon} ${info.name}`),
      h('div', 'stars', '★'.repeat(info.rarity)),
      h('p', 'tiny', `Lv.${it.level}${pre.levels > 0 ? ` → Lv.${pre.level}` : ''}　上限 Lv.${cap}`),
      h('p', 'tiny muted', '矿石是武器的经验，一档抵两块下一档；零碎的经验会存在武器上。'),
    );
    // Four ore kinds against a 234 px column: the label has to be its own line, or it
    // wraps *inside* the stepper and shoves 全部 down past the confirm button. Kinds the
    // player has none of are named on one shared line rather than given a dead stepper
    // each — same information, three rows less of it.
    const missing = [];
    for (const oreId of WEAPON_ORE) {
      const have = g.player.inventory?.[oreId] || 0;
      const def = MATERIALS[oreId] || {};
      const label = `${def.icon || '🪨'} ${def.name || oreId}　${num(oreXp(oreId))} 经验／块`;
      if (have <= 0) { missing.push(def.name || oreId); continue; }
      const picked = Math.floor(this._state.ore[oreId] || 0);
      detail.appendChild(h('p', 'tiny', `${label}　持有 ${have}`));
      const stepper = h('div', 'stepper');
      const minus = h('button', 'btn small', '−');
      const plus = h('button', 'btn small', '+');
      const allBtn = h('button', 'btn small ghost', '全部');
      minus.disabled = picked <= 0;
      plus.disabled = picked >= have;
      const set = (n) => { this._state.ore[oreId] = Math.max(0, Math.min(have, n)); this._render(); };
      minus.onclick = () => set(picked - 1);
      plus.onclick = () => set(picked + 1);
      allBtn.onclick = () => set(have);
      stepper.append(minus, h('b', 'num', String(picked)), plus, allBtn);
      stepper.dataset.ore = oreId;
      detail.appendChild(stepper);
    }
    if (missing.length) {
      detail.appendChild(h('p', 'tiny muted', `暂无：${missing.join('、')}`));
    }
    const offered = Object.values(use).reduce((a, n) => a + n, 0);
    detail.append(
      h('p', 'tiny', `投入 ${offered} 块 · 强化经验 ${num(xp)} / 上限还需 ${num(need)}`),
      h('p', short ? 'tiny bad' : 'tiny', `摩拉 ${num(mora)}`
        + (short ? `（持有 ${num(g.player.mora || 0)}，不够）` : '')),
    );
    if (pre.levels <= 0 && xp > 0) {
      detail.appendChild(h('p', 'tiny muted',
        `还不够升一级，${num(xp)} 点会存在武器上（已存 ${num(it.xp || 0)}）。`));
    }
    const overflow = Object.entries(this._state.ore)
      .filter(([id, n]) => Math.floor(n || 0) > (use[id] || 0));
    if (overflow.length) {
      detail.appendChild(h('p', 'tiny muted', '够到上限了，多选的矿石不会被消耗。'));
    }

    const go = h('button', 'btn small primary', '确认强化');
    go.disabled = xp <= 0 || short;
    go.onclick = () => this._act(
      () => api.levelUpWeapon(it.uid, this._state.ore),
      null,
    ).then((res) => {
      if (!res) return this._render();
      g.toast(res.levels > 0
        ? `强化成功 Lv.${res.from} → Lv.${res.level}`
        : `存入 ${num(res.xpGain)} 点强化经验`, 'good');
      this._state.ore = {};
      if (res.level >= res.cap) this._state.wpnUp = null;
      this._render();
    });
    const cancel = h('button', 'btn small', '返回');
    cancel.onclick = () => { this._state.wpnUp = null; this._state.ore = {}; this._render(); };
    detail.append(go, cancel);
  }

  /* ---------------------------------------------------------------- quests -- */

  async _quests(body, foot) {
    const g = this.game;
    const main = h('div', 'col main');
    main.appendChild(h('p', 'muted', '载入中…'));
    body.appendChild(main);
    foot.appendChild(h('span', '', '任务奖励会在完成阶段时自动发放'));

    let quests = [];
    let resetAt = null;
    try {
      const res = await api.quests();
      quests = res.quests || [];
      resetAt = res.dailyResetAt || null;
    } catch (e) { /* fall through to empty */ }
    if (!this.el || this.name !== 'quests') return;
    clearChildren(main);
    // The commissions refresh at 04:00 by period key, with nothing on a timer, so the panel
    // says when — an offline player crossing the boundary otherwise has no way to tell that
    // the four委托 they see are today's. Rendered from the server's number, never compared.
    if (resetAt) {
      clearChildren(foot);
      foot.appendChild(h('span', '', `每日委托 ${untilText(resetAt - Date.now())}后刷新 · `
        + '任务奖励会在完成阶段时自动发放'));
    }

    const order = { active: 0, done: 1 };
    quests.sort((a, b) => (order[a.state] ?? 2) - (order[b.state] ?? 2)
      || (a.type === 'story' ? -1 : 1));
    if (!quests.length) main.appendChild(h('p', 'muted', '还没有接到任务，去和 NPC 交谈吧。'));

    for (const qd of quests) {
      const card = frag(`<div class="quest${qd.state === 'done' ? ' done' : ''}">
        <h4><span class="type"></span><span data-f="nm"></span></h4>
        <p data-f="desc"></p>
      </div>`);
      const type = q(card, '.type');
      type.classList.add(qd.type);
      type.textContent = { story: '魔神任务', side: '传说任务', daily: '每日委托', world: '世界任务' }[qd.type] || qd.type;
      q(card, '[data-f="nm"]').textContent = `${qd.chapter ? `${qd.chapter} · ` : ''}${qd.name}`;
      q(card, '[data-f="desc"]').textContent = QUESTS[qd.id]?.intro || '';
      for (let i = 0; i < qd.stages.length; i++) {
        const s = qd.stages[i];
        const done = s.done || qd.state === 'done';
        const active = !done && i === qd.stageIndex;
        const row = frag(`<div class="prog">
          <span></span><div class="bar"><i></i></div><span class="num"></span>
        </div>`);
        row.children[0].textContent = `${done ? '✓' : active ? '▸' : '·'} ${s.desc}`;
        row.children[0].className = done ? 'good' : active ? 'gold' : 'muted';
        q(row, 'i').style.width = pct(done ? s.count : s.have, s.count);
        q(row, '.num').textContent = `${Math.min(s.have, s.count)}/${s.count}`;
        card.appendChild(row);
      }
      // Where the current objective is. The panel is where a player goes when the one-line
      // tracker is not enough, so it gets the same answer in full: the place, its zone, the
      // distance, and a button that opens the map with the pin already on it.
      if (qd.state === 'active' && QUESTS[qd.id]) {
        const t = questTarget(QUESTS[qd.id], { state: 'active', stageIndex: qd.stageIndex, counters: {} }, {
          zoneId: g.zoneId, pos: { x: g.me?.x ?? 0, z: g.me?.z ?? 0 },
          pois: g.world?.pois, gathers: g.world?.gathers,
        });
        if (t) {
          const row = h('p', 'tiny qwhere');
          // Same sentence the tracker prints, from the same function: the panel only adds the
          // zone and the distance, because it has the width for them.
          row.appendChild(h('span', 'gold', '目标位置：'));
          row.appendChild(h('span', '', navWhere(t, { zone: true, dist: true })));
          if (t.kind === 'place' && t.zone === g.zoneId) {
            const btn = h('button', 'btn small ghost', '在地图上查看');
            btn.onclick = () => this.open('map');
            row.appendChild(btn);
          }
          card.appendChild(row);
        }
      }
      // `rewardList` is the shared list the completion card prints, so the panel's preview and
      // the screen a player sees when they finish cannot name different things — and neither of
      // them can fall back to a raw id, because an id that names nothing fails the quest gate.
      const bits = rewardList(qd.rewards || {}).map((r) => `${r.name} ×${num(r.n)}`);
      if (bits.length) card.appendChild(h('p', 'tiny muted', `奖励：${bits.join('、')}`));
      main.appendChild(card);
    }
  }

  /* ------------------------------------------------------------------ wish -- */

  async _wish(body, foot) {
    const g = this.game;
    const main = h('div', 'col main');
    main.style.display = 'flex';
    main.style.flexDirection = 'column';
    main.style.padding = '0';

    const hero = frag(`<div class="wish-hero">
      <div class="halo"></div><div class="halo"></div>
      <div class="txt"><h3></h3><p></p></div>
    </div>`);
    const results = h('div', 'pulls');
    results.style.padding = '12px 16px';
    main.append(hero, results);

    const side = h('div', 'col side');
    body.append(side, main);

    let pools = [];
    try { pools = (await api.wishPools()).pools || []; } catch { /* offline: no pools */ }
    if (!this.el || this.name !== 'wish') return;

    if (!pools.some((p) => p.id === this._state.pool)) this._state.pool = pools[0]?.id;
    const pool = pools.find((p) => p.id === this._state.pool);

    for (const p of pools) {
      const row = frag(`<div class="list-row${p.id === this._state.pool ? ' sel' : ''}">
        <div class="t"><b></b><small></small></div></div>`);
      row.dataset.pool = p.id;
      q(row, 'b').textContent = p.name;
      const feat = CHARACTERS[p.featuredFive]?.name;
      q(row, 'small').textContent = feat ? `限定五星：${feat}` : '常驻池';
      side.appendChild(row);
    }
    this._offs.push(on(side, 'click', (e) => {
      const id = e.target.closest('[data-pool]')?.dataset.pool;
      if (id) { this._state.pool = id; this._render(); }
    }));

    const pity = g.player.wishState?.[this._state.pool]
      || { pity5: 0, pity4: 0, total: 0, guaranteed5: false, guaranteed4: false };
    side.append(h('hr', 'sep'), h('h3', 'sec', '概率'));
    const dl = h('dl', 'stats');
    // Every value here is keyed so a pull can patch it by name. It used to patch
    // `querySelectorAll('dd')[1..3]` by index, which meant adding one row above them moved
    // three numbers onto the wrong labels — and the one row that was never patched at all
    // was 大保底, i.e. the single most important piece of gacha state.
    const val = (key, text, cls = '') => {
      const dd = h('dd', cls, text);
      dd.dataset.k = key;
      return dd;
    };
    // `wishRate5` is the same function the server rolls with, fed the pool's own published
    // numbers: at 80 pity 「五星基础概率 0.60%」 is a number the simulation abandoned six
    // pulls ago, and this row is the one a player actually decides on.
    const rateNow = (n) => wishRate5({ rate: pool.rate5, pity: pool.pity5 }, n + 1);
    if (pool) {
      dl.append(
        h('dt', '', '五星基础概率'), val('rate5', `${(pool.rate5 * 100).toFixed(2)}%`),
        h('dt', '', '当前五星概率'),
        val('rateNow', `${(rateNow(pity.pity5) * 100).toFixed(2)}%`,
          rateNow(pity.pity5) > pool.rate5 * 1.5 ? 'up' : ''),
        h('dt', '', '五星保底'),
        val('pity5', `${pity.pity5} / ${pool.pity5}`, pity.pity5 >= pool.pity5 - 10 ? 'up' : ''),
        h('dt', '', '四星基础概率'), val('rate4', `${(pool.rate4 * 100).toFixed(2)}%`),
        h('dt', '', '四星保底'), val('pity4', `${pity.pity4} / ${pool.pity4}`),
        h('dt', '', '累计祈愿'), val('total', num(pity.total)),
      );
      if (pool.featuredChance5 != null) {
        dl.append(h('dt', 'gold', '限定五星'),
          val('feat5', pity.guaranteed5 ? '大保底：必定为限定' : `${Math.round(pool.featuredChance5 * 100)}%`,
            pity.guaranteed5 ? 'up' : ''));
      }
      if (pool.featuredChance4 != null) {
        dl.append(h('dt', '', '限定四星'),
          val('feat4', pity.guaranteed4 ? '下次必定为限定' : `${Math.round(pool.featuredChance4 * 100)}%`,
            pity.guaranteed4 ? 'up' : ''));
      }
    }
    side.appendChild(dl);
    if (pool?.softPity) {
      // Says out loud what `wishRate5` does, so 当前五星概率 climbing is explained rather than
      // surprising: the curve is published by the server, not guessed here.
      side.appendChild(h('p', 'tiny muted',
        `软保底：第 ${pool.softPity.start} 抽起每抽 +${(pool.softPity.step * 100).toFixed(1)}%，`
        + `第 ${pool.pity5} 抽必出`));
    }

    q(hero, 'h3').textContent = pool?.name || '祈愿';
    const feat4 = (pool?.featuredFour || []).map((c) => CHARACTERS[c]?.name || c).filter(Boolean);
    q(hero, 'p').textContent = CHARACTERS[pool?.featuredFive]
      ? `${CHARACTERS[pool.featuredFive].name} · ${CHARACTERS[pool.featuredFive].title}`
        + (feat4.length ? `　限定四星：${feat4.join(' · ')}` : '')
      : '命运的丝线在此交汇';

    // The conversion rate is the shop's constant, not a literal: the route charges
    // `GEM_PER_WISH` per missing ticket, and a footer quoting its own number is how a banner
    // starts lying about a price.
    const gemRate = pool?.gemPerWish ?? GEM_PER_WISH;
    const perPull = pool?.cost?.wishTicket ?? 1;
    // 星辉/星尘 are shown here because here is where they are earned. They are only spendable
    // in 派蒙的十日谈, and a currency a player never sees accumulate is one they never spend —
    // which is the state a C6 duplicate used to leave them in, holding nothing at all.
    const changeText = () => CHANGE_IDS
      .map((id) => `${MATERIALS[id].icon}${MATERIALS[id].name} ${num(g.player.inventory?.[id] || 0)}`)
      .join(' · ');
    const countsText = () => `${MATERIALS.wishTicket.name} ${num(g.player.wishTicket)}`
      + ` · 原石 ${num(g.player.primogem)} · ${changeText()}`
      + `（每次 ${perPull} 缘，不足时按 ${gemRate} 原石折算）`;

    const doPull = async (count) => {
      const res = await this._act(() => api.pull(this._state.pool, count));
      if (!res) return;
      g.audio.sfx(res.results.some((r) => r.rarity === 5) ? 'wish5' : 'wish');
      const box = q(this.el, '.pulls');
      if (!box) return;
      clearChildren(box);
      for (const r of res.results) {
        const isChar = r.type === 'character';
        const def = isChar ? CHARACTERS[r.id] : WEAPONS[r.id];
        const card = frag(`<div class="pull r${r.rarity}">
          <div class="ico"></div><div class="nm"></div><div class="tag"></div><div class="cv"></div></div>`);
        q(card, '.ico').textContent = isChar ? (ELEMENT_GLYPH[def?.element] || '☆') : '⚔';
        q(card, '.nm').textContent = def?.name || r.id;
        q(card, '.tag').textContent = isChar
          // A duplicate that cannot raise the constellation any further says so, because the
          // card would otherwise read 「命之座 C6」 twice over and look like nothing happened —
          // which is exactly what used to happen. The change on the line below is the reward.
          ? (r.dupe ? (r.capped ? '命之座已满' : `命之座 C${r.dupes}`) : '新角色！')
          : WEAPON_TYPES[def?.type]?.name || '武器';
        q(card, '.cv').textContent = changeLine(r.converted);
        box.appendChild(card);
      }
      // The total, once, under the ten cards: adding ten little numbers in your head is not
      // a thing to ask of a player.
      const change = changeLine(res.converted);
      if (change) box.appendChild(h('p', 'pull-change', `本次共获得 ${change}`));
      const five = res.results.find((r) => r.rarity === 5);
      if (five) {
        const def = five.type === 'character' ? CHARACTERS[five.id] : WEAPONS[five.id];
        g.banner('★★★★★', def?.name || '');
      }
      // The panel deliberately does not re-render (that would wipe the reveal),
      // so the two numbers a pull changes are patched by hand.
      const counts = q(this.el, 'footer span');
      if (counts) counts.textContent = countsText();
      const p5 = res.pity;
      const dlBox = q(this.el, '.col.side .stats');
      if (dlBox && pool) {
        const put = (key, txt, up) => {
          const dd = q(dlBox, `[data-k="${key}"]`);
          if (!dd) return;
          dd.textContent = txt;
          dd.classList.toggle('up', !!up);
        };
        const r = rateNow(p5.pity5);
        put('rateNow', `${(r * 100).toFixed(2)}%`, r > pool.rate5 * 1.5);
        put('pity5', `${p5.pity5} / ${pool.pity5}`, p5.pity5 >= pool.pity5 - 10);
        put('pity4', `${p5.pity4} / ${pool.pity4}`);
        put('total', num(p5.total));
        if (pool.featuredChance5 != null) {
          put('feat5', p5.guaranteed5 ? '大保底：必定为限定' : `${Math.round(pool.featuredChance5 * 100)}%`,
            p5.guaranteed5);
        }
        if (pool.featuredChance4 != null) {
          put('feat4', p5.guaranteed4 ? '下次必定为限定' : `${Math.round(pool.featuredChance4 * 100)}%`,
            p5.guaranteed4);
        }
      }
    };

    const one = h('button', 'btn', '祈愿 ×1');
    const ten = h('button', 'btn primary', '祈愿 ×10');
    one.onclick = () => doPull(1);
    ten.onclick = () => doPull(10);
    foot.append(h('span', '', countsText()), h('div', 'spacer'), one, ten);
  }

  /* ------------------------------------------------------------------ cook -- */

  /**
   * The cooking panel: pick a recipe, pick a batch size, cook.
   *
   * Everything shown here is computed from the same shared tables the server uses
   * (`maxPortions`, `cookOdds`), so "可制作 3 份" is the number the server will
   * agree to. The batch size is clamped to what the inventory affords rather than
   * letting the player ask for five and get an error — the interesting failure in
   * cooking is a ruined dish, not a rejected request.
   */
  _cook(body, foot) {
    const g = this.game;
    const inv = g.player?.inventory || {};
    const ar = g.player?.adventureRank ?? 1;

    const ids = RECIPE_IDS.slice().sort((a, b) => RECIPES[a].rank - RECIPES[b].rank);
    if (!ids.includes(this._state.recipe)) this._state.recipe = ids[0];
    const recipe = RECIPES[this._state.recipe];
    const dish = MATERIALS[recipe.id];
    const locked = ar < recipe.rank;
    const afford = maxPortions(recipe.id, inv, 20);

    // --- recipe list ------------------------------------------------------
    const side = h('div', 'col side');
    side.appendChild(h('h3', 'sec', '食谱'));
    for (const id of ids) {
      const r = RECIPES[id];
      const d = MATERIALS[id];
      const lk = ar < r.rank;
      const can = maxPortions(id, inv, 20);
      const row = frag(`<div class="list-row"><div class="t"><b></b><small></small></div><span class="qty"></span></div>`);
      row.dataset.recipe = id;
      if (id === this._state.recipe) row.classList.add('sel');
      if (lk) row.classList.add('dim');
      q(row, 'b').textContent = `${d?.icon || '🍽'} ${d?.name || id}`;
      q(row, 'small').textContent = lk ? `冒险等阶 ${r.rank} 解锁` : ingredientText(id);
      q(row, '.qty').textContent = lk ? '🔒' : (can > 0 ? `×${can}` : '—');
      if (!lk && can > 0) q(row, '.qty').classList.add('up');
      side.appendChild(row);
    }
    this._offs.push(on(side, 'click', (e) => {
      const id = e.target.closest('[data-recipe]')?.dataset.recipe;
      if (id && id !== this._state.recipe) {
        this._state.recipe = id;
        this._state.cookQty = 1;
        this._render();
      }
    }));

    // --- selected dish ----------------------------------------------------
    const main = h('div', 'col main');
    const head = frag(`<div class="cook-head">
      <div class="ico"></div>
      <div class="t"><h3></h3><p class="tiny muted"></p><p class="tiny gold"></p></div>
    </div>`);
    q(head, '.ico').textContent = dish?.icon || '🍽';
    q(head, 'h3').textContent = dish?.name || recipe.id;
    q(head, 'p.muted').textContent = recipe.desc;
    q(head, 'p.gold').textContent = dish ? materialDesc(dish) : '';
    main.appendChild(head);

    main.appendChild(h('h3', 'sec', '食材'));
    const table = h('div', 'cook-ing');
    for (const [id, need] of Object.entries(recipe.ingredients)) {
      const have = inv[id] || 0;
      const row = frag(`<div class="ing"><span class="ico"></span><span class="nm"></span><span class="n"></span></div>`);
      q(row, '.ico').textContent = MATERIALS[id]?.icon || '·';
      q(row, '.nm').textContent = MATERIALS[id]?.name || id;
      q(row, '.n').textContent = `${num(have)} / ${need}`;
      q(row, '.n').classList.add(have >= need ? 'up' : 'down');
      table.appendChild(row);
    }
    main.appendChild(table);

    // --- odds -------------------------------------------------------------
    main.appendChild(h('h3', 'sec', '成功率'));
    const odds = cookOdds(recipe, ar);
    const bar = h('div', 'cook-odds');
    for (const key of ['perfect', 'normal', 'ruined']) {
      const seg = h('i', `seg ${key}`);
      seg.style.width = `${(odds[key] * 100).toFixed(1)}%`;
      seg.title = `${QUALITY[key].name} ${(odds[key] * 100).toFixed(0)}%`;
      bar.appendChild(seg);
    }
    main.appendChild(bar);
    const legend = h('div', 'cook-legend');
    for (const key of ['perfect', 'normal', 'ruined']) {
      legend.appendChild(h('span', `lg ${key}`, `${QUALITY[key].name} ${(odds[key] * 100).toFixed(0)}%`));
    }
    main.append(legend, h('p', 'tiny muted', '完美出锅可得双份；失败会做出「奇怪的料理」，仍能少量回复生命。'));

    body.append(side, main);

    // --- batch size & cook ------------------------------------------------
    const qty = Math.max(1, Math.min(this._state.cookQty || 1, Math.max(1, afford)));
    this._state.cookQty = qty;
    const stepper = h('div', 'stepper');
    const minus = h('button', 'btn small', '−');
    const plus = h('button', 'btn small', '+');
    const all = h('button', 'btn small ghost', '最多');
    const nEl = h('b', 'num', String(qty));
    minus.onclick = () => { this._state.cookQty = Math.max(1, qty - 1); this._render(); };
    plus.onclick = () => { this._state.cookQty = Math.min(Math.max(1, afford), qty + 1); this._render(); };
    all.onclick = () => { this._state.cookQty = Math.max(1, afford); this._render(); };
    stepper.append(minus, nEl, plus, all);

    const go = h('button', 'btn primary', `开始烹饪 ×${qty}`);
    go.disabled = locked || afford < 1;
    go.onclick = async () => {
      const res = await this._act(() => api.cook(recipe.id, this._state.cookQty || 1));
      if (!res) return;
      g.audio.sfx('pickup');
      const t = res.tally || {};
      const bits = [];
      if (t.perfect) bits.push(`完美 ×${t.perfect}`);
      if (t.normal) bits.push(`普通 ×${t.normal}`);
      if (t.ruined) bits.push(`失败 ×${t.ruined}`);
      g.toast(`${dish?.name || ''}：${bits.join('，') || '无产出'}`, t.ruined && !t.perfect && !t.normal ? 'bad' : 'good');
      if (t.perfect) g.banner('完美出锅', `${dish?.name || ''} ×${t.perfect * 2}`);
      this._state.cookQty = 1;
      this._render();
    };

    foot.append(
      h('span', '', locked ? `冒险等阶 ${recipe.rank} 才能学会这道菜` : `可制作 ${afford} 份`),
      h('div', 'spacer'), stepper, go,
    );
  }

  /* ------------------------------------------------------------------ shop -- */

  /**
   * Open the shop at a particular counter. Called by the NPC dialogue, which knows the
   * keeper the player is standing in front of — a merchant who opened the panel on some
   * other shop's tab would be worse than no shortcut at all.
   */
  openShop(shopId) {
    if (shopId) this._state.shop = shopId;
    this._shopView = null;
    this.open('shop');
  }

  /**
   * Fetch the catalogue with its stock resolved.
   *
   * Deliberately not cached across openings: the whole point of `shared/sim/clock.js` is
   * that a limit belongs to a period, and a view held in panel state would keep claiming a
   * daily entry was sold out after 04:00 rolled it over. Cheap, too — one GET per opening.
   */
  async _loadShop() {
    if (this._shopLoading) return;
    this._shopLoading = true;
    try {
      const res = await api.shop();
      this._shopView = res.shops || [];
      this._shopNow = res.now || Date.now();
    } catch (e) {
      this._shopView = [];
      this.game.toast(errorText(e), 'bad');
    } finally {
      this._shopLoading = false;
    }
    if (this.name === 'shop') this._render();
  }

  _shop(body, foot) {
    const g = this.game;
    if (!this._shopView) {
      body.appendChild(h('p', 'muted', '正在盘点货架……'));
      this._loadShop();
      return;
    }
    const shops = this._shopView;
    if (!shops.length) { body.appendChild(h('p', 'muted', '没有能光顾的商店。')); return; }
    let shop = shops.find((x) => x.id === this._state.shop);
    if (!shop) { shop = shops[0]; this._state.shop = shop.id; }

    // --- counters ---------------------------------------------------------
    const side = h('div', 'col side');
    side.appendChild(h('h3', 'sec', '商铺'));
    for (const sh of shops) {
      const row = frag(`<div class="list-row"><div class="t"><b></b><small></small></div><span class="qty"></span></div>`);
      row.dataset.shop = sh.id;
      if (sh.id === shop.id) row.classList.add('sel');
      if (!sh.unlocked) row.classList.add('dim');
      q(row, 'b').textContent = sh.name;
      // Where the keeper stands is information the player needs before walking: the
      // panel is reachable anywhere, but the flavour is that these are real counters.
      const place = sh.zone === '*' ? '随行' : (ZONES[sh.zone]?.name || sh.zone);
      q(row, 'small').textContent = `${sh.keeper} · ${place}`;
      // A tab's badge counts what is buyable right now, which is the one number that
      // decides whether opening the tab is worth the click.
      const ready = sh.entries.filter((e) => e.canBuy > 0).length;
      q(row, '.qty').textContent = sh.unlocked ? (ready ? `${ready} 可购` : '—') : '🔒';
      if (ready && sh.unlocked) q(row, '.qty').classList.add('up');
      side.appendChild(row);
    }
    this._offs.push(on(side, 'click', (e) => {
      const id = e.target.closest('[data-shop]')?.dataset.shop;
      if (id && id !== this._state.shop) { this._state.shop = id; this._render(); }
    }));

    // --- shelves ----------------------------------------------------------
    const main = h('div', 'col main');
    const head = frag(`<div class="cook-head">
      <div class="ico">🏷</div>
      <div class="t"><h3></h3><p class="tiny muted"></p><p class="tiny gold"></p></div>
    </div>`);
    q(head, 'h3').textContent = `${shop.name} · ${shop.keeper}`;
    q(head, 'p.muted').textContent = shop.desc;
    q(head, 'p.gold').textContent = shop.unlocked ? '' : `冒险等阶 ${shop.minRank} 才会有人接待你`;
    main.appendChild(head);

    const list = h('div', `shop-list${shop.unlocked ? '' : ' locked'}`);
    for (const e of shop.entries) {
      const info = shopItemInfo(e.item);
      const row = frag(`<div class="shop-row">
        <div class="ico"></div>
        <div class="t"><b></b><div class="cost"></div></div>
        <div class="stk"><span class="n"></span><span class="tiny muted rs"></span></div>
        <div class="acts"></div>
      </div>`);
      // The entry id on the row, so a probe can name the thing it is buying: without it
      // `tools/shop-check.mjs` has to identify a row by its Chinese label, which is the
      // one part of the panel that is meant to change.
      row.dataset.entry = e.id;
      q(row, '.ico').textContent = info.icon;
      q(row, 'b').textContent = `${info.name}${e.count > 1 ? ` ×${e.count}` : ''}`;
      if (info.rarity) q(row, 'b').classList.add(`r${info.rarity}`);

      // Price, one chip per cost line. Barter entries have two, and the chip that the
      // player is short of has to be the one that looks wrong — a single red price on a
      // mixed cost hides which material is missing.
      const cost = q(row, '.cost');
      for (const [id, qty] of Object.entries(e.cost)) {
        const c = shopItemInfo(id);
        const have = isCurrency(id) ? (g.player?.[id] ?? 0) : (g.player?.inventory?.[id] ?? 0);
        const chip = h('span', `pchip ${have >= qty ? 'up' : 'down'}`, `${c.icon} ${num(qty)}`);
        chip.title = `${c.name}：持有 ${num(have)}`;
        cost.appendChild(chip);
      }

      const stock = q(row, '.n');
      if (e.limit) {
        stock.textContent = `${PERIOD_NAME[e.period] || ''} ${e.limit - e.left}/${e.limit}`;
        if (e.left === 0) stock.classList.add('down');
        q(row, '.rs').textContent = e.resetsAt ? `${untilText(e.resetsAt - Date.now())}后补货` : '';
      } else {
        stock.textContent = '不限量';
      }

      const acts = q(row, '.acts');
      const one = h('button', 'btn small', '购买');
      one.disabled = !shop.unlocked || e.canBuy < 1;
      one.onclick = () => this._buy(e.id, 1);
      acts.appendChild(one);
      // The bulk button only appears when it would do something different from the
      // first one, so the row does not grow a permanently dead control.
      if (e.canBuy > 1) {
        const many = h('button', 'btn small ghost', `×${e.canBuy}`);
        many.onclick = () => this._buy(e.id, e.canBuy);
        acts.appendChild(many);
      }
      if (e.minRank > (g.player?.adventureRank ?? 1)) {
        row.classList.add('dim');
        one.disabled = true;
        q(row, '.rs').textContent = `需冒险等阶 ${e.minRank}`;
      }
      list.appendChild(row);
    }
    main.appendChild(list);
    body.append(side, main);

    // Purse in the footer rather than trusting the HUD: two of the three currencies the
    // shops take are not on the HUD at all, and a price the player cannot compare to a
    // balance is just a number.
    const purse = h('div', 'shop-purse');
    for (const id of ['mora', 'primogem', 'wishTicket']) {
      const c = shopItemInfo(id);
      purse.appendChild(h('span', 'pchip', `${c.icon} ${num(g.player?.[id] ?? 0)}`));
    }
    foot.append(purse, h('div', 'spacer'),
      h('span', 'tiny muted', '限购在每日 04:00（UTC+8）刷新'));
  }

  /** One purchase. The server clamps the count, so the response is the truth about it. */
  async _buy(entryId, count) {
    const res = await this._act(() => api.shopBuy(entryId, count));
    if (!res) return;
    this.game.audio.sfx('pickup');
    const bits = (res.gained || []).map((gd) => {
      const info = shopItemInfo(gd.id);
      return `${info.name}${gd.count > 1 ? ` ×${gd.count}` : ''}`;
    });
    // Reporting `bought` matters when it is less than what was asked for: the clamp is
    // silent server-side, and a player who pressed ×6 needs to see they got 4.
    const short = res.bought < res.requested ? `（只买到 ${res.bought}/${res.requested}）` : '';
    this.game.toast(`${bits.join('，') || '成交'}${short}`, 'good');
    await this._loadShop();
  }

  /* ------------------------------------------------------------------ mail -- */

  /**
   * Fetch the mailbox. The GET is also what *creates* today's letter server-side (see
   * `server/src/routes/mail.js`), so this is not a read-only refresh — which is exactly why
   * the HUD asks for it once at boot: the sign-in gift should be waiting, not conjured by
   * the player happening to press I.
   */
  async _loadMail() {
    if (this._mailLoading) return;
    this._mailLoading = true;
    try {
      const res = await api.mail();
      this._mailBox = res.mail || [];
      this._mailAt = Date.now();
      this._mailCounts = { total: res.total, unread: res.unread, claimable: res.claimable };
      this.game.emit('mailCounts', this._mailCounts);
    } catch (e) {
      this._mailBox = [];
      this.game.toast(errorText(e), 'bad');
    } finally {
      this._mailLoading = false;
    }
    if (this.name === 'mail') this._render();
  }

  _mail(body, foot) {
    if (!this._mailBox) {
      body.appendChild(h('p', 'muted', '正在取信……'));
      this._loadMail();
      return;
    }
    // The boot fetch may have filled the box minutes ago, and a new letter can arrive from a
    // period boundary while the client is up. Refresh behind the render rather than in front
    // of it: `_loadMail` re-renders when it lands, and it stamps `_mailAt`, so this cannot loop.
    if (Date.now() - (this._mailAt || 0) > 5000) this._loadMail();
    const box = this._mailBox;
    if (!box.length) {
      body.appendChild(h('p', 'muted', '信箱是空的。签到奖励、排行榜结算和补偿都会寄到这里。'));
      return;
    }
    let sel = box.find((m) => m.id === this._state.mail);
    // Default to the first letter that still owes something, not simply the newest: the
    // reason to open this panel is almost always an unclaimed attachment.
    if (!sel) sel = box.find((m) => !m.claimed && hasAttachments(m)) || box[0];
    this._state.mail = sel.id;

    const side = h('div', 'col side');
    side.appendChild(h('h3', 'sec', `信件 ${box.length}`));
    for (const m of box) {
      const row = frag(`<div class="list-row mail-row"><div class="t"><b></b><small></small><i class="dt"></i></div><span class="qty"></span></div>`);
      row.dataset.mail = String(m.id);
      if (m.id === sel.id) row.classList.add('sel');
      if (!m.seen) row.classList.add('unread');
      if (m.claimed) row.classList.add('dim');
      q(row, 'b').textContent = m.subject;
      q(row, 'small').textContent = m.sender;
      q(row, '.dt').textContent = mailDate(m.at, true);
      // One badge, three states: a gift waiting, a gift taken, or nothing attached. The
      // 已领 tick matters because a claimed letter keeps its text and would otherwise look
      // identical to one the player has not opened yet.
      const attached = hasAttachments(m);
      q(row, '.qty').textContent = attached ? (m.claimed ? '✓' : '🎁') : '';
      if (attached && !m.claimed) q(row, '.qty').classList.add('up');
      side.appendChild(row);
    }
    this._offs.push(on(side, 'click', (e) => {
      const id = Number(e.target.closest('[data-mail]')?.dataset.mail || 0);
      if (id && id !== this._state.mail) {
        this._state.mail = id;
        // Reading marks read. Doing it here rather than in the render keeps the panel from
        // silently clearing the badge on whatever letter it defaulted to.
        const m = box.find((x) => x.id === id);
        if (m && !m.seen) { m.seen = true; this._seenMail([id]); }
        this._render();
      }
    }));
    if (!sel.seen) { sel.seen = true; this._seenMail([sel.id]); }

    const main = h('div', 'col main');
    const head = frag(`<div class="cook-head">
      <div class="ico">✉</div>
      <div class="t"><h3></h3><p class="tiny muted"></p><p class="tiny gold"></p></div>
    </div>`);
    q(head, 'h3').textContent = sel.subject;
    q(head, 'p.muted').textContent = `${sel.sender} · ${mailDate(sel.at)}`;
    // The countdown is the whole reason expiry can be a read filter instead of a sweep:
    // nothing deletes an unclaimed reward quietly, but the player has to be told.
    q(head, 'p.gold').textContent = sel.claimed ? ''
      : `${untilText(sel.expiresAt - Date.now())}后过期`;
    main.appendChild(head);
    main.appendChild(h('p', 'mail-body', sel.body));

    const lines = attachLines(sel.attach);
    if (lines.length) {
      main.appendChild(h('h3', 'sec', sel.claimed ? '已领取' : '附件'));
      const grid = h('div', `mail-attach${sel.claimed ? ' taken' : ''}`);
      for (const ln of lines) {
        const cell = frag(`<div class="att"><span class="ico"></span><span class="n"></span><span class="nm tiny muted"></span></div>`);
        q(cell, '.ico').textContent = ln.icon;
        q(cell, '.n').textContent = `×${num(ln.count)}`;
        q(cell, '.nm').textContent = ln.name;
        grid.appendChild(cell);
      }
      main.appendChild(grid);
      const take = h('button', 'btn', sel.claimed ? '已领取' : '领取');
      take.disabled = sel.claimed;
      take.dataset.act = 'claim-one';
      take.onclick = () => this._claimMail([sel.id]);
      main.appendChild(take);
    }
    body.append(side, main);

    const claimable = box.filter((m) => !m.claimed && hasAttachments(m));
    const all = h('button', 'btn', `一键领取${claimable.length ? ` (${claimable.length})` : ''}`);
    all.disabled = claimable.length === 0;
    all.dataset.act = 'claim-all';
    all.onclick = () => this._claimMail(null);
    // Deleting is limited to letters with nothing left on them, and the server enforces the
    // same rule — a 清空 that binned an unopened reward is the one unrecoverable mistake here.
    const spent = box.filter((m) => m.claimed || !hasAttachments(m));
    const wipe = h('button', 'btn ghost', `删除已读 (${spent.length})`);
    wipe.disabled = spent.length === 0;
    wipe.dataset.act = 'delete-read';
    wipe.onclick = () => this._deleteMail(null);
    foot.append(all, wipe, h('div', 'spacer'),
      h('span', 'tiny muted', '附件 30 天内有效，过期不再显示'));
  }

  /** Fire-and-forget: a read receipt that fails is not worth a toast. */
  _seenMail(ids) {
    api.mailSeen(ids).then((r) => {
      this._mailCounts = { total: r.total, unread: r.unread, claimable: r.claimable };
      this.game.emit('mailCounts', this._mailCounts);
    }).catch(() => {});
  }

  async _claimMail(ids) {
    const res = await this._act(() => api.mailClaim(ids));
    if (!res) return;
    this.game.audio.sfx('pickup');
    const bits = (res.lines || []).map((ln) => `${ln.name}${ln.count > 1 ? ` ×${ln.count}` : ''}`);
    this.game.toast(bits.join('，') || '已领取', 'good');
    // The response carries the whole box, so there is no second GET — and no window where
    // the panel shows a claimed letter as still claimable.
    this._mailBox = res.mail || [];
    this._mailCounts = { total: res.total, unread: res.unread, claimable: res.claimable };
    this.game.emit('mailCounts', this._mailCounts);
    if (this.name === 'mail') this._render();
  }

  async _deleteMail(ids) {
    try {
      const res = await api.mailDelete(ids);
      this.game.toast(res.deleted.length ? `删除了 ${res.deleted.length} 封` : '没有可删除的信件',
        res.deleted.length ? 'good' : 'warn');
      await this._loadMail();
    } catch (e) {
      this.game.toast(errorText(e), 'bad');
    }
  }

  /* ---------------------------------------------------------- achievements -- */

  /**
   * Fetch the derived snapshot. `quiet` is the poll: it must not toast a network error every
   * 90 seconds, and it must not redraw a panel the player is reading unless something moved.
   *
   * The comparison that decides "something moved" is `claimableTiers`, not `earnedTiers` —
   * earning is what the player did, but *collectable* is what the badge is for, and a claim
   * lowers it. A rise while the game is running is a genuine "成就达成".
   */
  async _loadAch(quiet = false) {
    if (this._achLoading) return;
    this._achLoading = true;
    const before = this._achCounts?.claimableTiers ?? null;
    try {
      const res = await api.achievements();
      this._achView = { progress: res.progress || {}, claimed: res.claimed || {} };
      this._achAt = Date.now();
      this._achCounts = res.summary || achSummary(res.progress, res.claimed);
      this.game.emit('achCounts', this._achCounts);
      const now = this._achCounts.claimableTiers || 0;
      if (before !== null && now > before) {
        this.game.toast(`成就达成，可领取 ${now - before} 项奖励`, 'gold');
      }
    } catch (e) {
      if (!quiet) { this._achView = { progress: {}, claimed: {} }; this.game.toast(errorText(e), 'bad'); }
    } finally {
      this._achLoading = false;
    }
    if (this.name === 'achievements') this._render();
  }

  _achievements(body, foot) {
    if (!this._achView) {
      body.appendChild(h('p', 'muted', '正在核对成就……'));
      this._loadAch();
      return;
    }
    // Same pattern as the mailbox: refresh behind the paint, never in front of it. The snapshot
    // is derived, so it is stale the moment the player kills anything.
    if (Date.now() - (this._achAt || 0) > 5000) this._loadAch(true);
    const { progress, claimed } = this._achView;
    const groups = achByGroup(progress, claimed);
    let gsel = groups.find((g) => g.id === this._state.ach) || groups[0];
    this._state.ach = gsel.id;

    const side = h('div', 'col side');
    side.appendChild(h('h3', 'sec', '分类'));
    for (const g of groups) {
      const done = g.items.filter((i) => i.st.done).length;
      const row = frag(`<div class="list-row ach-cat"><div class="t"><b></b><small></small></div><span class="qty"></span></div>`);
      row.dataset.achGroup = g.id;
      if (g.id === gsel.id) row.classList.add('sel');
      q(row, 'b').textContent = `${g.icon} ${g.name}`;
      q(row, 'small').textContent = `${done}/${g.items.length} 全数达成`;
      // The count on the right is what is *collectable*, which is the only number that asks the
      // player to do something. A category with nothing to take shows nothing.
      q(row, '.qty').textContent = g.claimable ? String(g.claimable) : '';
      if (g.claimable) q(row, '.qty').classList.add('up');
      side.appendChild(row);
    }
    this._offs.push(on(side, 'click', (e) => {
      const id = e.target.closest('[data-ach-group]')?.dataset.achGroup;
      if (id && id !== this._state.ach) { this._state.ach = id; this._render(); }
    }));

    const main = h('div', 'col main');
    for (const { def, st } of gsel.items) {
      const card = frag(`<div class="ach">
        <div class="row">
          <span class="tier"></span>
          <div class="t"><b></b><small class="muted"></small></div>
          <div class="pay"></div>
        </div>
        <div class="prog"><div class="bar"><i></i></div><span class="num"></span></div>
      </div>`);
      if (st.done) card.classList.add('done');
      if (st.claimable) card.classList.add('ready');
      // The tier badge reads as the tier already *earned*; an achievement nobody has touched
      // shows the dot so the row still has a left column and the list stays aligned.
      q(card, '.tier').textContent = st.earned ? TIER_LABELS[Math.min(st.earned - 1, TIER_LABELS.length - 1)] : '·';
      q(card, 'b').textContent = def.name;
      const unit = ACH_STATS[def.stat]?.unit || '';
      q(card, 'small').textContent = st.done
        ? `${def.desc} · 全部达成`
        : `${def.desc} · 下一档 ${num(st.target)}${unit}`;
      q(card, '.bar > i').style.width = pct(st.done ? 1 : st.frac, 1);
      q(card, '.num').textContent = st.done
        ? `${num(st.have)}${unit}`
        : `${num(Math.min(st.have, st.target))}/${num(st.target)}`;

      const pay = q(card, '.pay');
      if (st.claimable) {
        const btn = h('button', 'btn tiny-btn', `领取 ${st.gems}原石`);
        btn.dataset.act = 'ach-claim';
        btn.dataset.ach = def.id;
        btn.onclick = () => this._claimAch(def.id);
        pay.appendChild(btn);
      } else if (st.claimed >= def.targets.length) {
        pay.appendChild(h('span', 'tiny good', '已领取'));
      } else {
        // What the next tier is worth, so a bar in progress still says why it matters.
        pay.appendChild(h('span', 'tiny muted', `${tierGems(st.claimed)}原石`));
      }
      main.appendChild(card);
    }
    body.append(side, main);

    const s = this._achCounts || achSummary(progress, claimed);
    const all = h('button', 'btn', `全部领取${s.claimableTiers ? ` (${s.claimableTiers})` : ''}`);
    all.disabled = !s.claimableTiers;
    all.dataset.act = 'ach-claim-all';
    all.onclick = () => this._claimAch(null);
    foot.append(all, h('div', 'spacer'),
      h('span', 'tiny muted',
        `全数达成 ${s.done}/${s.total} · 已达成 ${s.earnedTiers}/${s.tiers} 档${s.gems ? ` · 待领 ${s.gems} 原石` : ''}`));
  }

  async _claimAch(id) {
    const res = await this._act(() => api.achClaim(id));
    if (!res) return;
    this.game.audio.sfx('pickup');
    const names = (res.took || []).map((t) => t.name);
    this.game.toast(`${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 项` : ''} +${res.gained?.primogem || 0} 原石`, 'gold');
    // The claim response carries the snapshot it priced, so the panel never redraws from a
    // second read that could disagree with what was just paid.
    this._achView = { progress: res.progress || {}, claimed: res.claimed || {} };
    this._achAt = Date.now();
    this._achCounts = res.summary;
    this.game.emit('achCounts', this._achCounts);
    if (this.name === 'achievements') this._render();
  }

  /* -------------------------------------------------------------- 探索派遣 -- */

  /**
   * The server's clock, as well as this browser can tell it.
   *
   * Every snapshot carries the server's own `now` next to the rows, and the difference is kept
   * rather than discarded: a browser clock two minutes fast would otherwise count a trip down
   * to 可领取, enable the button, and be answered 「派遣还没有结束」 by the route that owns the
   * only clock that matters.
   */
  _expNow() { return Date.now() + (this._expSkew || 0); }

  /**
   * What the HUD chip counts, derived from the held snapshot rather than fetched.
   *
   * This is why the 派遣 view survives the panel closing while the shop's and the mailbox's do
   * not (see `_teardown`): a row says when it *started* and how long it takes, so readiness is
   * arithmetic on data that cannot go stale. That is the whole reason the table stores no
   * deadline — there is nothing here for a wall clock to invalidate.
   */
  _expCounts() {
    const v = this._expView;
    if (!v) return { ready: 0, inFlight: 0, slots: 0 };
    const now = this._expNow();
    return {
      ready: (v.entries || []).filter((e) => expeditionState(e, now).ready).length,
      inFlight: (v.entries || []).length,
      slots: v.slots || 0,
    };
  }

  /**
   * Fetch the snapshot. `quiet` is the poll and the boot fetch: no toast if the network is down.
   *
   * Unlike the achievements poll there is no `before !== null` guard on the announcement, and
   * that is deliberate — the *first* load is the one that matters most here. 派遣 is the only
   * system whose state advances while the game is closed, so a player who sent four characters
   * out last night should be told on arrival, not the next time they happen to press G.
   */
  async _loadExp(quiet = false) {
    if (this._expLoading) return;
    this._expLoading = true;
    const before = this._expCounts().ready;
    try {
      const res = await api.expeditions();
      this._expSkew = (res.now || Date.now()) - Date.now();
      this._expView = res;
      this._expAt = Date.now();
      const counts = this._expCounts();
      this._expReady = counts.ready;
      this.game.emit('expCounts', counts);
      if (counts.ready > before) this.game.toast(`有 ${counts.ready} 支派遣已归来，可以领取了`, 'gold');
    } catch (e) {
      if (!quiet) this.game.toast(errorText(e), 'bad');
    } finally {
      this._expLoading = false;
    }
    if (this.name === 'expedition') this._render();
  }

  /**
   * The second hand. Two jobs, in this order:
   *
   *  1. Notice a trip *crossing* into 可领取 and announce it, panel or no panel — that is the
   *     moment the HUD chip has to appear, and it needs no request to know: the arithmetic is on
   *     a snapshot already in memory, which is exactly what storing no deadline buys.
   *  2. If the panel happens to be open, rewrite the countdowns in place. A crossing redraws
   *     instead, because that is when a 领取 button has to appear.
   */
  _expTick() {
    if (!this._expView) return;
    const now = this._expNow();
    const ready = (this._expView.entries || []).filter((e) => expeditionState(e, now).ready).length;
    const crossed = ready !== (this._expReady ?? 0);
    this._expReady = ready;
    if (crossed) this.game.emit('expCounts', this._expCounts());
    if (this.name !== 'expedition' || !this.el) return;
    if (crossed) { this._render(); return; }
    for (const e of this._expView.entries || []) {
      const rem = this.el.querySelector(`[data-exp-slot="${e.slot}"] .rem`);
      if (!rem) continue;
      const st = expeditionState(e, now);
      rem.textContent = st.ready ? '可领取' : `剩余 ${remainText(st.remainSec)}`;
    }
  }

  _expedition(body, foot) {
    const g = this.game;
    if (!this._expView) {
      body.appendChild(h('p', 'muted', '正在联系冒险家协会……'));
      this._loadExp();
      return;
    }
    // Behind the paint, like the mailbox and the trophy list. Half a minute is enough: the
    // numbers on screen are recomputed every second from the snapshot already in hand, and the
    // only thing a refetch can add is somebody else's device having claimed a trip.
    if (Date.now() - (this._expAt || 0) > 30_000) this._loadExp(true);

    const view = this._expView;
    const now = this._expNow();
    const rows = view.entries || [];
    const owned = Object.keys(g.player?.characters || {});
    const busy = new Set(rows.map((r) => r.charId));
    const ctx = { adventureRank: g.player?.adventureRank ?? 1, owned, rows };

    // Repair the three proposals against what is actually possible before anything is drawn: a
    // character who left on a trip must not stay selected, or the button would offer a dispatch
    // the rule refuses for a reason the player cannot see.
    if (!EXPEDITION_HOURS.includes(this._state.expHours)) [this._state.expHours] = EXPEDITION_HOURS;
    if (!this._state.expChar || !owned.includes(this._state.expChar) || busy.has(this._state.expChar)) {
      this._state.expChar = owned.find((id) => !busy.has(id)) || owned[0] || null;
    }
    const hours = this._state.expHours;
    const entryOf = (destId) => expeditionEntry(destId, this._state.expChar, hours, ctx);
    const dests = Object.values(EXPEDITIONS);
    if (!this._state.expDest || !EXPEDITIONS[this._state.expDest]) {
      this._state.expDest = (dests.find((d) => !isDestRefusal(entryOf(d.id).error)) || dests[0])?.id || null;
    }

    /* --- 目的地 ------------------------------------------------------------ */
    const side = h('div', 'col side');
    side.appendChild(h('h3', 'sec', '目的地'));
    for (const d of dests) {
      const entry = entryOf(d.id);
      // Only the destination's own refusals lock the row; a busy character or a full slate is a
      // property of the dispatch, and belongs on the button (`isDestRefusal`).
      const locked = !entry.ok && isDestRefusal(entry.error);
      const row = frag(`<div class="list-row">
        <div class="t"><b></b><small></small></div><span class="qty"></span>
      </div>`);
      row.dataset.expDest = d.id;
      if (d.id === this._state.expDest) row.classList.add('sel');
      if (locked) {
        row.classList.add('dim');
        row.dataset.locked = entry.error;
      }
      // 🔒 leads the line for the same reason it does in the 秘境 floor list: these names wrap.
      q(row, 'b').textContent = `${locked ? '🔒 ' : ''}${d.name}`;
      q(row, 'small').textContent = locked
        ? `${errorText({ code: entry.error })}${entry.need ? `（需要 ${entry.need} 阶）` : ''}`
        : d.hint;
      // What the currently selected duration would bring back — the number that makes one
      // destination worth choosing over another, at the duration being considered.
      q(row, '.qty').textContent = `${expeditionTotal(d, hours)} 件`;
      row.title = locked ? errorText({ code: entry.error }) : `${d.hint} · ${hours} 小时约 ${expeditionTotal(d, hours)} 件材料`;
      side.appendChild(row);
    }
    this._offs.push(on(side, 'click', (e) => {
      const row = e.target.closest('[data-exp-dest]');
      if (!row) return;
      if (row.dataset.locked) { g.toast(errorText({ code: row.dataset.locked }), 'bad'); return; }
      if (row.dataset.expDest !== this._state.expDest) {
        this._state.expDest = row.dataset.expDest;
        this._render();
      }
    }));

    /* --- 派遣队 ----------------------------------------------------------- */
    const main = h('div', 'col main');
    main.appendChild(h('h3', 'sec', '派遣队'));
    // A row whose slot index sits above the current cap cannot happen through the route, but if
    // one ever did it would be a reward nobody could reach: draw every row, then pad to the cap.
    const cards = Math.max(view.slots || 0, rows.reduce((m, r) => Math.max(m, r.slot + 1), 0));
    for (let i = 0; i < cards; i++) {
      const row = rows.find((r) => r.slot === i);
      const card = frag(`<div class="exp">
        <div class="row">
          <span class="who"></span>
          <div class="t"><b></b><small class="muted"></small></div>
          <div class="pay"></div>
        </div>
      </div>`);
      card.dataset.expSlot = String(i);
      if (!row) {
        card.classList.add('idle');
        q(card, '.who').textContent = '·';
        q(card, 'b').textContent = `第 ${i + 1} 个派遣位 · 空闲`;
        q(card, 'small').textContent = '在左侧选一个目的地，然后按下方的派遣';
        main.appendChild(card);
        continue;
      }
      const st = expeditionState(row, now);
      const dest = EXPEDITIONS[row.destId];
      card.dataset.ready = st.ready ? '1' : '0';
      if (st.ready) card.classList.add('ready');
      q(card, '.who').textContent = (CHARACTERS[row.charId]?.name || row.charId).slice(0, 1);
      q(card, 'b').textContent = `${CHARACTERS[row.charId]?.name || row.charId} · ${dest?.name || row.destId}`;
      // The row's own `payout` comes from the server, which recomputed it from `(destId, hours)`;
      // the fallback recomputes the same thing here, so a card can never print a number the
      // claim would not pay.
      q(card, 'small').textContent = `${row.hours} 小时 · ${itemLine(row.payout || expeditionPayout(row.destId, row.hours))}`;
      const pay = q(card, '.pay');
      pay.appendChild(h('span', `rem tiny ${st.ready ? 'gold' : 'muted'}`,
        st.ready ? '可领取' : `剩余 ${remainText(st.remainSec)}`));
      if (st.ready) {
        const btn = h('button', 'btn tiny-btn', '领取');
        btn.dataset.act = 'exp-claim';
        btn.dataset.slot = String(i);
        btn.onclick = () => this._claimExp(i);
        pay.appendChild(btn);
      }
      main.appendChild(card);
    }

    /* --- 派遣 ------------------------------------------------------------- */
    main.appendChild(h('hr', 'sep'));
    main.appendChild(h('h3', 'sec', '派出'));
    const dest = EXPEDITIONS[this._state.expDest];
    const entry = entryOf(this._state.expDest);

    const hourRow = h('div', 'exp-pick');
    hourRow.appendChild(h('span', 'tiny muted', '时长'));
    for (const hv of EXPEDITION_HOURS) {
      const pill = h('button', `chip${hv === hours ? ' sel' : ''}`, `${hv} 小时`);
      pill.dataset.expHours = String(hv);
      // The count is on the pill because the whole point of the long trips is that they are
      // *linear* — a player who can see 4h/8h/12h/20h side by side can see there is no bonus
      // to hunt for, which is the promise `expeditionPayout` makes in shared/data.
      if (dest) pill.title = `${dest.name} · ${expeditionTotal(dest, hv)} 件材料`;
      hourRow.appendChild(pill);
    }
    this._offs.push(on(hourRow, 'click', (e) => {
      const v = Number(e.target.closest('[data-exp-hours]')?.dataset.expHours);
      if (v && v !== this._state.expHours) { this._state.expHours = v; this._render(); }
    }));

    const charRow = h('div', 'exp-pick');
    charRow.appendChild(h('span', 'tiny muted', '角色'));
    for (const id of owned) {
      const def = CHARACTERS[id];
      const out = busy.has(id);
      const pill = h('button', `chip${id === this._state.expChar ? ' sel' : ''}${out ? ' dim' : ''}`,
        `${ELEMENT_GLYPH[def?.element] || ''}${def?.name || id}`);
      pill.dataset.expChar = id;
      if (out) pill.dataset.locked = 'character_busy';
      pill.title = out ? errorText({ code: 'character_busy' })
        : `Lv.${g.player.characters[id]?.level || 1} · 派往${dest?.name || '目的地'}`;
      charRow.appendChild(pill);
    }
    this._offs.push(on(charRow, 'click', (e) => {
      const pill = e.target.closest('[data-exp-char]');
      if (!pill) return;
      if (pill.dataset.locked) { g.toast(errorText({ code: pill.dataset.locked }), 'bad'); return; }
      if (pill.dataset.expChar !== this._state.expChar) {
        this._state.expChar = pill.dataset.expChar;
        this._render();
      }
    }));
    main.append(hourRow, charRow);

    const send = h('button', 'btn primary', entry.ok ? `派遣 · ${hours} 小时` : '无法派遣');
    send.dataset.act = 'exp-start';
    // Disabled *and* explained: a dead button with no sentence next to it is the failure the
    // 秘境 floor list was fixed for. The reason is the server's own code, translated once.
    send.disabled = !entry.ok;
    if (!entry.ok) send.dataset.locked = entry.error;
    send.title = entry.ok
      ? `${dest?.name} · ${itemLine(entry.payout)}`
      : errorText({ code: entry.error });
    send.onclick = () => this._startExp();
    const preview = h('div', 'exp-preview');
    preview.appendChild(send);
    preview.appendChild(h('span', 'tiny muted', entry.ok
      ? `预计带回 ${itemLine(entry.payout)}`
      : errorText({ code: entry.error }) + (entry.need ? `（需要 ${entry.need} 阶）` : '')));
    main.append(preview);
    body.append(side, main);

    /* --- footer ----------------------------------------------------------- */
    const counts = this._expCounts();
    const all = h('button', 'btn', `一键领取${counts.ready ? ` (${counts.ready})` : ''}`);
    all.disabled = !counts.ready;
    all.dataset.act = 'exp-claim-all';
    all.onclick = () => this._claimExp(null);
    const nextReady = rows
      .map((r) => expeditionState(r, now))
      .filter((s) => !s.ready)
      .sort((a, b) => a.remainSec - b.remainSec)[0];
    foot.append(all, h('div', 'spacer'),
      h('span', 'tiny muted',
        `派遣位 ${counts.inFlight}/${counts.slots}`
        + (counts.ready ? ` · 可领取 ${counts.ready}` : '')
        + (nextReady ? ` · 最近一支还需 ${remainText(nextReady.remainSec)}` : '')));
  }

  async _startExp() {
    const { expDest, expChar, expHours } = this._state;
    const res = await this._act(() => api.expeditionStart(expDest, expChar, expHours));
    if (!res) return;
    this.game.audio.sfx('quest');
    const name = CHARACTERS[expChar]?.name || expChar;
    this.game.toast(`${name} 已派往${EXPEDITIONS[expDest]?.name || expDest}，${expHours} 小时后归来`, 'good');
    // The response *is* the snapshot the server priced, so the panel never redraws from a
    // second read that could disagree with the row it just created.
    this._expApply(res);
  }

  async _claimExp(slot) {
    const res = await this._act(() => api.expeditionClaim(slot));
    if (!res) return;
    this.game.audio.sfx('pickup');
    this.game.toast(`派遣归来：${itemLine(res.items) || '没有收获'}`, 'gold');
    this._expApply(res);
  }

  /** Fold a mutation's answer back in, including the clock it answered with. */
  _expApply(res) {
    this._expSkew = (res.now || Date.now()) - Date.now();
    this._expView = { ...this._expView, ...res };
    this._expAt = Date.now();
    this._expReady = this._expCounts().ready;
    this.game.emit('expCounts', this._expCounts());
    if (this.name === 'expedition') this._render();
  }

  /* ------------------------------------------------------------------- map -- */

  _map(body, foot) {
    const g = this.game;
    const zoneId = this._state.mapZone || g.zoneId;
    const zone = zoneById(zoneId);

    const side = h('div', 'col side');
    // Two sections in one scrolling column, and the order matters: with 区域 first, the six
    // region rows filled the whole column and the 深境层数 list — the *only* way into a
    // 秘境 — sat entirely below the fold, unscrolled, with nothing saying it was there. So a
    // dungeon puts its floors first (that is what the player opened the map for while standing
    // in one) and keeps the region list underneath.
    const zoneBox = h('div', 'zones');
    const floorBox = h('div', 'floors');
    zoneBox.appendChild(h('h3', 'sec', '区域'));
    for (const z of Object.values(ZONES)) {
      const ok = canEnterZone(z, g.player?.adventureRank ?? 1);
      const row = frag(`<div class="list-row${z.id === zoneId ? ' sel' : ''}">
        <div class="t"><b></b><small></small></div><span class="explore tiny"></span></div>`);
      row.dataset.zone = z.id;
      q(row, 'b').textContent = z.name;
      q(row, 'small').textContent = `${z.subtitle} · 推荐 Lv.${z.recommendedLevel}${ok ? '' : ` · 需 AR ${zoneEntryRank(z)}`}`;
      // 探索度 on the row that picks the zone: it is the number that decides *where to go next*,
      // and it is derived from the same world progress the pins below are drawn from, so the two
      // halves of this panel cannot disagree. Dungeons carry no percentage (see
      // `EXPLORED_KINDS`) — their row already shows 深境层数 stars underneath.
      if (EXPLORED_KINDS.has(z.kind)) {
        const zp = zoneProgress(g.player?.worldProgress, z.id);
        const ex = zoneExploration(z, zp);
        const cl = exploreClaim(z, zp);
        const tag = q(row, '.explore');
        // 🎁 in the text, not only a colour: this row is how a player decides which zone to walk
        // into next, and an unclaimed milestone is a reason to pick this one.
        tag.textContent = `${ex.pct}%${cl.claimable.length ? ' 🎁' : ''}`;
        tag.title = `探索度 ${ex.found}/${ex.total}${ex.byType.map((b) => ` · ${b.label} ${b.found}/${b.total}`).join('')}`
          + (cl.claimable.length ? `\n有 ${cl.claimable.length} 档探索奖励可领取` : '');
        if (ex.pct >= 100) tag.classList.add('full');
        if (cl.claimable.length) tag.classList.add('ready');
        row.dataset.explore = String(ex.pct);
        row.dataset.exploreReady = String(cl.claimable.length);
      }
      if (!ok) row.classList.add('muted');
      zoneBox.appendChild(row);
    }
    this._offs.push(on(side, 'click', (e) => {
      const id = e.target.closest('[data-zone]')?.dataset.zone;
      if (id) { this._state.mapZone = id; this._render(); }
    }));

    // Dungeon floors get a chamber list, which is how the abyss is entered.
    if (zone?.chambers?.length) {
      floorBox.appendChild(h('h3', 'sec', '深境层数'));
      if (zone.domain) {
        const cost = zone.domain.resin ?? DOMAIN_RESIN;
        const sets = zone.domain.sets.map((s) => ARTIFACT_SETS[s]?.name || s).join('、');
        floorBox.append(h('p', 'tiny muted', `每次通关消耗 ${cost} 树脂换取掉落（${sets}）· 现有树脂 ${num(g.player?.resin ?? 0)}`));
      }
      const best = g.player?.abyss?.[zone.id] || {};
      // The same rule the three enforcers apply (`chamberEntry`), read here so the row can
      // *show* the lock instead of offering a click the server is going to refuse — the
      // argument the locked teleport pin above already makes. The live chamber only counts
      // when this is the zone the player is standing in; the map of another dungeon knows
      // nothing about a run, and the click handler refuses that case first anyway.
      const entryOf = (floor) => chamberEntry(zone, floor, {
        adventureRank: g.player?.adventureRank ?? 0,
        abyss: g.player?.abyss,
        chamber: zone.id === g.zoneId ? g.chamber : null,
      });
      for (const c of zone.chambers) {
        const rec = best[c.floor] || best[String(c.floor)];
        const row = frag(`<div class="list-row"><div class="t"><b></b><small></small></div>
          <span class="stars"></span></div>`);
        row.dataset.floor = String(c.floor);
        const dz = disorderById(c.disorder);
        const entry = entryOf(c.floor);
        // A locked row reads as locked three ways: a 🔒 in the title, the row dimmed, and the
        // reason on hover. `data-locked` is what the probe reads, so the DOM cannot claim a
        // lock the pixels do not show (the class is what paints it).
        const running = entry.error === 'chamber_in_progress' && entry.runningFloor === c.floor;
        if (!entry.ok) {
          // `dim` (the row's own 45% opacity), not `muted`: muted only recolours the title, and
          // over this dark panel a 50%-alpha cream reads as the same cream — 89 vs 85 in the
          // brightest tail of the glyphs, which is not a difference a player sees. Dimming the
          // whole row takes the stars and the second line with it.
          row.classList.add('dim');
          row.dataset.locked = entry.error;
          row.title = errorText({ code: entry.error })
            + (entry.error === 'rank_too_low' ? `（需要 ${entry.need} 阶）` : '');
        }
        // 🔒 leads the line rather than trailing it: the titles are long enough to wrap, and a
        // lock orphaned onto its own second line reads like a bullet for the row below.
        q(row, 'b').textContent = (!entry.ok && !running ? '🔒 ' : '')
          + `第 ${c.floor} 间${c.boss ? ' · 首领' : ''}${dz ? ` · ${dz.name}` : ''}`
          + (running ? ' · 进行中' : '');
        // Two lines: what the floor costs (level, waves, clock) and what it changes. A
        // player picks a floor from this list, so the disorder has to be readable *before*
        // entering — it decides which party they bring.
        q(row, 'small').textContent = `Lv.${c.level} · ${c.waves.length} 波 ${chamberEnemies(c).length} 敌`
          + ` · 限时 ${c.timeLimit}s · 三星 ${c.stars[2]}s${rec?.bestTime ? ` · 最佳 ${rec.bestTime.toFixed(1)}s` : ''}`
          + (dz ? `\n${disorderHint(dz)}` : '');
        q(row, 'small').style.whiteSpace = 'pre-line';
        q(row, '.stars').textContent = '★'.repeat(rec?.stars || 0) + '☆'.repeat(3 - (rec?.stars || 0));
        floorBox.appendChild(row);
      }
      this._offs.push(on(side, 'click', (e) => {
        const f = e.target.closest('[data-floor]')?.dataset.floor;
        if (!f) return;
        if (g.zoneId !== zone.id) return g.toast('需要先进入该秘境', 'bad');
        // Refuse here, with the same reason and the same words the server would answer, and
        // without closing the panel: the player is still choosing a floor. Restarting matters
        // most — in co-op the run this click would reset is somebody else's.
        const entry = entryOf(Number(f));
        if (!entry.ok) return g.toast(errorText({ code: entry.error }), 'bad');
        this.close();
        g.startChamber(Number(f));
      }));
    }
    // Floors first when there are floors (see `zoneBox` above), regions otherwise.
    if (floorBox.childElementCount) side.append(floorBox, h('hr', 'sep'));
    side.appendChild(zoneBox);

    const main = h('div', 'col main');
    main.style.cssText = 'display:flex;flex-direction:column;padding:0';
    const wrap = h('div', 'mapwrap');
    const canvas = h('canvas');
    const pins = h('div', 'map-pins');
    wrap.append(canvas, pins);
    main.appendChild(wrap);
    body.append(side, main);

    // Canvas has to be laid out before it can be sized; one frame is enough.
    requestAnimationFrame(() => {
      if (!this.el || this.name !== 'map' || !zone) return;
      const rect = wrap.getBoundingClientRect();
      canvas.width = Math.max(64, Math.floor(rect.width));
      canvas.height = Math.max(64, Math.floor(rect.height));
      const tf = drawFullMap(canvas, bakedFor(zone), {});
      clearChildren(pins);

      // POIs: from the live world when it is the current zone (so opened chests
      // read as opened), otherwise straight from the static zone definition.
      // A chest opened in a zone you are not standing in is still opened: `done` falls back to the
      // world progress the percentage is computed from, so the map of another region shows what is
      // left there instead of drawing everything as untouched.
      const zoneProgFor = zoneProgress(g.player?.worldProgress, zone.id);
      const list = zone.id === g.zoneId
        ? g.world.pois.map((p) => ({ id: p.id, type: p.type, x: p.x, z: p.z, name: p.name, done: p.done }))
        : (zone.poi || []).map((p) => ({
          id: p.id, type: p.type, x: p.at[0], z: p.at[1], name: p.name,
          done: isFound(zone, p, zoneProgFor),
        }));
      // An anchor you have not stood on yet is drawn locked and refuses the click. The route
      // enforces this too (`anchor_locked`); the pin says so first, because a map that offers a
      // jump and then rejects it is worse than one that shows the jump is not earned yet.
      const zoneProg = zoneProgress(g.player?.worldProgress, zone.id);
      for (const p of list) {
        const [px, py] = tf.toScreen(p.x, p.z);
        const anchor = TELEPORT_TYPES.has(p.type);
        const locked = anchor && !isAnchorUnlocked(zone, { id: p.id, type: p.type }, zoneProg);
        const pin = h('div', `pin ${p.type}${p.done ? ' done' : ''}${locked ? ' locked' : ''}`,
          locked ? '🔒' : (PIN_GLYPH[p.type] || '•'));
        pin.style.left = `${px}px`;
        pin.style.top = `${py}px`;
        pin.title = locked ? `${p.name || p.type} · 未激活，走到这里激活后才能传送` : (p.name || p.type);
        pin.dataset.poi = p.id;
        pin.dataset.type = p.type;
        if (locked) pin.dataset.locked = '1';
        pins.appendChild(pin);
      }
      if (zone.id === g.zoneId) {
        const [px, py] = tf.toScreen(g.me.x, g.me.z);
        const me = h('div', 'pin me', '✦');
        me.style.left = `${px}px`;
        me.style.top = `${py}px`;
        me.title = '当前位置';
        pins.appendChild(me);
      }

      // The tracked objective, resolved by the same function the HUD tracker uses. The pin
      // carries its own label because this is the view a player opens *to ask where to go* —
      // a bare marker on a 440 m map still leaves them guessing which of the three it means.
      const pick = trackedQuest(g.player?.quests);
      const t = pick && questTarget(pick.def, pick.rec, {
        zoneId: g.zoneId, pos: { x: g.me.x, z: g.me.z },
        pois: zone.id === g.zoneId ? g.world.pois : null,
        gathers: zone.id === g.zoneId ? g.world.gathers : null,
      });
      if (t && t.kind === 'place' && t.zone === zone.id) {
        const [px, py] = tf.toScreen(t.x, t.z);
        const pin = h('div', 'pin quest', '❢');
        pin.style.left = `${px}px`;
        pin.style.top = `${py}px`;
        pin.title = `${pick.def.name} · ${t.name}`;
        pins.appendChild(pin);
        const tag = h('div', 'pin-label', `${t.name}${t.dist != null ? ` · ${Math.round(t.dist)} m` : ''}`);
        tag.style.left = `${px}px`;
        tag.style.top = `${py + 16}px`;
        pins.appendChild(tag);
      }

      // Only anchors teleport — everything else is a label.
      this._offs.push(on(pins, 'click', async (e) => {
        const pin = e.target.closest('[data-poi]');
        if (!pin || !TELEPORT_TYPES.has(pin.dataset.type)) return;
        if (pin.dataset.locked) {
          g.toast('这个锚点还没有激活，先走过去点亮它', 'bad');
          return;
        }
        this.close();
        await g.teleport(zone.id, pin.dataset.poi);
      }));
    });

    // The footer is where the selected zone's 探索度 is spelled out: the row above has room for a
    // percentage only, and 「差一个宝箱」 is the part a player can act on.
    const ex = zone && EXPLORED_KINDS.has(zone.kind)
      ? zoneExploration(zone, zoneProgress(g.player?.worldProgress, zone.id)) : null;
    const cl = zone ? exploreClaim(zone, zoneProgress(g.player?.worldProgress, zone.id)) : null;
    foot.append(
      h('span', '', zone ? `${zone.name} · ${zone.subtitle} · ${zone.size}×${zone.size} m` : ''),
      h('div', 'spacer'),
      ...(ex ? [h('span', 'tiny', `探索度 ${ex.pct}% (${ex.found}/${ex.total})`
        + ex.byType.map((b) => ` · ${b.label} ${b.found}/${b.total}`).join(''))] : []),
      h('div', 'spacer'),
      ...(cl ? [this._exploreClaimButton(zone, cl)]
        : [h('span', 'tiny muted', '点击锚点或神像传送')]),
    );
  }

  /**
   * 「领取探索奖励」 for the selected zone, and — when there is nothing to collect — what the next
   * step is worth.
   *
   * Both halves matter. A disabled button with no price is a dead end; 「下一档 80% · 5667 摩拉 ·
   * 4 原石」 is the sentence that makes the last two chests worth hunting, which is the entire
   * reason the ladder exists (探索度 used to pay only through two global achievements, so the
   * second and third zone paid nothing at all for the same walk).
   *
   * Every number here comes from `exploreClaim` — the same function the route pays from — and is
   * formatted by `rewardList`, the same list the quest card and the completion screen print. The
   * panel cannot promise an amount the server will not pay, and cannot spell 摩拉 differently.
   */
  _exploreClaimButton(zone, cl) {
    const price = (r) => rewardList(r).map((row) => `${row.name} ×${num(row.n)}`).join(' · ');
    const ready = cl.claimable.length;
    const btn = h('button', 'btn', ready
      ? `领取探索奖励 ${ready > 1 ? `×${ready} ` : ''}· ${price(cl.reward)}`
      : (cl.next ? `下一档 ${cl.next.pct}% · ${price(cl.next.rewards)}` : '探索奖励已全部领取'));
    btn.disabled = !ready;
    btn.dataset.act = 'explore-claim';
    btn.dataset.zone = zone.id;
    btn.dataset.ready = String(ready);
    btn.title = cl.steps
      .map((s) => `${s.pct}% ${price(s.rewards)}${s.state === 'paid' ? ' ✓' : s.state === 'ready' ? ' ←可领取' : ''}`)
      .join('\n');
    btn.onclick = async () => {
      const res = await this._act(() => api.exploreClaim(zone.id));
      if (!res) return;
      this.game.audio.sfx('pickup');
      const steps = (res.took || []).map((t) => `${t.pct}%`).join('、');
      this.game.toast(`探索奖励 ${steps}：${price(res.gained || {})}`, 'gold');
      // `_act` has already applied the player the route answered with, and the paid mark is one of
      // its `worldProgress` rows — so a re-render reads the new state rather than a second fetch.
      if (this.name === 'map') this._render();
    };
    return btn;
  }

  /* ----------------------------------------------------------------- party -- */

  async _party(body, foot) {
    const g = this.game;
    const side = h('div', 'col side');
    side.appendChild(h('h3', 'sec', '当前队伍'));
    const partyBox = h('div', 'grid');
    for (let i = 0; i < 4; i++) {
      const charId = g.party[i];
      const def = charId ? CHARACTERS[charId] : null;
      const slot = frag(`<div class="slot${def ? ` r${def.rarity}` : ' empty'}">
        <div class="ico"></div><div class="nm"></div><div class="lv"></div></div>`);
      slot.dataset.slotIndex = String(i);
      q(slot, '.ico').textContent = def ? (ELEMENT_GLYPH[def.element] || '?') : '＋';
      q(slot, '.nm').textContent = def?.name || `位置 ${i + 1}`;
      q(slot, '.lv').textContent = charId ? `Lv.${g.player.characters[charId]?.level || 1}` : '';
      partyBox.appendChild(slot);
    }
    side.appendChild(partyBox);
    this._offs.push(on(partyBox, 'click', (e) => {
      const idx = e.target.closest('[data-slot-index]')?.dataset.slotIndex;
      if (idx == null) return;
      const party = [...g.party];
      if (party[Number(idx)] && party.length > 1) {
        party.splice(Number(idx), 1);
        // `_act` folds the authoritative roster in (and pushes it to the sim); just redraw.
        this._act(() => api.setParty(party)).then(() => this._render());
      }
    }));

    // 元素共鸣 ------------------------------------------------------------------
    // Before this block the team screen only ever asked one question — who has the biggest
    // numbers — because nothing on it depended on the *combination* of the four. Both
    // halves are drawn: what the current party gives, and what the rest of the table would
    // give. A resonance whose condition is one character away has to be legible, otherwise
    // the rule may as well not exist for anyone who has not read the code.
    side.append(h('hr', 'sep'), h('h3', 'sec', '元素共鸣'));
    const activeRes = new Set(partyResonances(g.party).map((r) => r.id));
    const resBox = h('div', 'res-list');
    // Active first, table order within each group. 四象庇护 is the last entry of the table
    // and the whole list is eight rows in a scrolling column: in table order the resonance
    // the player *has* was below the fold, which `resonance-ui.mjs` caught by reading the
    // lit row's pixels and finding the page background behind it.
    const resRows = Object.values(RESONANCES)
      .sort((a, b) => (activeRes.has(b.id) ? 1 : 0) - (activeRes.has(a.id) ? 1 : 0));
    for (const r of resRows) {
      const lit = activeRes.has(r.id);
      const row = frag(`<div class="res-row${lit ? ' on' : ''}">
        <b></b><i></i><small></small></div>`);
      row.dataset.res = r.id;
      q(row, 'b').textContent = r.name;
      q(row, 'i').textContent = lit ? '已激活' : resonanceCondition(r);
      q(row, 'small').textContent = resonanceHint(r);
      resBox.appendChild(row);
    }
    side.appendChild(resBox);

    side.append(h('hr', 'sep'), h('h3', 'sec', '拥有的角色'));
    const roster = h('div', '');
    for (const [id, inst] of Object.entries(g.player.characters || {})) {
      const def = CHARACTERS[id];
      const inParty = g.party.includes(id);
      const row = frag(`<div class="list-row${inParty ? ' sel' : ''}">
        <div class="t"><b></b><small></small></div></div>`);
      row.dataset.add = id;
      q(row, 'b').textContent = def?.name || id;
      q(row, 'small').textContent = `Lv.${inst.level} · ${ELEMENTS[def?.element]?.name || ''}${inParty ? ' · 已在队伍中' : ''}`;
      roster.appendChild(row);
    }
    side.appendChild(roster);
    this._offs.push(on(roster, 'click', (e) => {
      const id = e.target.closest('[data-add]')?.dataset.add;
      if (!id || g.party.includes(id) || g.party.length >= 4) return;
      const party = [...g.party, id];
      // `_act` folds the authoritative roster in (and pushes it to the sim); just redraw.
      this._act(() => api.setParty(party)).then(() => this._render());
    }));

    const main = h('div', 'col main');
    main.append(h('h3', 'sec', '在线的旅行者'));
    const onlineBox = h('div', '');
    main.append(onlineBox, h('hr', 'sep'));

    // The board keeps four tallies; showing only one of them wasted the data the
    // server already writes on every kill and every chamber clear.
    const board = this._state.board || 'score';
    const head = h('div', 'lb-head');
    head.appendChild(h('h3', 'sec', '排行榜'));
    const tabs = h('div', 'lb-tabs');
    for (const [key, label] of LEADERBOARDS) {
      const t = h('button', `chip${key === board ? ' sel' : ''}`, label);
      t.dataset.board = key;
      tabs.appendChild(t);
    }
    head.appendChild(tabs);
    main.appendChild(head);
    this._offs.push(on(tabs, 'click', (e) => {
      const k = e.target.closest('[data-board]')?.dataset.board;
      if (!k || k === board) return;
      this._state.board = k;
      this._render();
    }));
    const lbBox = h('div', '');
    main.appendChild(lbBox);
    body.append(side, main);

    const [onlineRes, lbRes] = await Promise.all([
      api.online().catch(() => ({ players: [], count: 0 })),
      api.leaderboard(board).catch(() => ({ top: [] })),
    ]);
    if (!this.el || this.name !== 'party') return;

    if (!onlineRes.players?.length) onlineBox.appendChild(h('p', 'muted tiny', '现在没有其他旅行者在线。'));
    for (const p of onlineRes.players || []) {
      const zdef = zoneById(p.zone);
      const row = frag(`<div class="list-row"><div class="t"><b></b><small></small></div>
        <button class="btn small ghost" data-friend="">加好友</button>
        <button class="btn small" data-invite="">邀请组队</button></div>`);
      q(row, 'b').textContent = p.nickname;
      q(row, 'small').textContent = `AR ${p.adventureRank} · ${zdef?.name || p.zone}`;
      q(row, '[data-invite]').dataset.invite = String(p.playerId);
      q(row, '[data-friend]').dataset.friend = String(p.playerId);
      // Nothing to do to yourself: the friend route answers `not_yourself` and the
      // invite would go nowhere.
      if (p.playerId === g.playerId) for (const b of [...row.querySelectorAll('button')]) b.remove();
      onlineBox.appendChild(row);
    }
    this._offs.push(on(onlineBox, 'click', async (e) => {
      // `closest`, not `e.target.dataset`: the button carries the id but a click can
      // land on a text node inside it.
      const btn = e.target.closest('button[data-invite], button[data-friend]');
      if (!btn) return;
      if (btn.dataset.invite) {
        g.socket.partyInvite(Number(btn.dataset.invite));
        g.toast('已发送组队邀请', 'good');
        return;
      }
      // Adding a friend from here is the path that actually gets used: this list is
      // where a player first sees somebody else's name.
      const r = await this._act(() => api.friendRequest(Number(btn.dataset.friend)));
      if (r) g.toast(r.state === 'accepted' ? `已和 ${r.nickname} 成为好友` : `已向 ${r.nickname} 发送申请`, 'good');
    }));

    for (const r of lbRes.top || []) {
      const row = frag(`<div class="list-row"><div class="t"><b></b><small></small></div>
        <span class="num"></span></div>`);
      const ar = r.adventure_rank ?? r.adventureRank;
      const zone = zoneById(r.zone)?.name;
      q(row, 'b').textContent = `${r.rank}. ${r.nickname || '旅行者'}`;
      // Only what the row actually carries: the board is fed from several places and a
      // redis-backed fallback row has neither rank nor zone.
      q(row, 'small').textContent = [ar != null ? `AR ${ar}` : null, zone].filter(Boolean).join(' · ');
      q(row, '.num').textContent = boardValue(board, r);
      if (r.playerId === g.playerId) row.classList.add('sel');
      lbBox.appendChild(row);
    }
    if (!lbRes.top?.length) lbBox.appendChild(h('p', 'muted tiny', '榜单还是空的。'));

    const members = g.partyRoster?.length || 0;
    foot.append(h('span', '', `在线 ${onlineRes.count || 0} 人${members ? ` · 小队 ${members} 人` : ''}`), h('div', 'spacer'));
  }

  /* ---------------------------------------------------------------- social -- */

  /**
   * Friends. The one persistent thing about co-op in this game: `/api/online` is
   * whoever is connected this second and a party dies with the process, so without
   * this panel the only way to play with somebody was to catch them in the same shard
   * and know their numeric id.
   *
   * Three lists, because a friendship has three states a player can act on: accepted
   * (play together, or remove), received (accept or decline), sent (withdraw). The
   * server returns all three in one request precisely so this panel is one round trip.
   */
  async _social(body, foot) {
    const g = this.game;
    const solo = g.mode === 'solo';

    const side = h('div', 'col side');
    side.appendChild(h('h3', 'sec', '添加好友'));
    const addRow = h('div', 'add-friend');
    const input = document.createElement('input');
    input.className = 'field';
    input.type = 'text';
    input.maxLength = 40;
    input.placeholder = '旅行者昵称';
    // Survives the redraw that every accept/remove triggers: losing half-typed text
    // because somebody else's request arrived would be its own small bug.
    input.value = this._state.friendQuery || '';
    const addBtn = h('button', 'btn small primary', '申请');
    addRow.append(input, addBtn);
    side.appendChild(addRow);
    side.appendChild(h('p', 'tiny muted', '好友可以直接加入对方的世界，只要对方正在开放世界里（秘境和单机世界不行）。'));
    this._offs.push(on(input, 'input', () => { this._state.friendQuery = input.value; }));
    const submit = async () => {
      const name = input.value.trim();
      if (!name) return;
      const r = await this._act(() => api.friendRequest(name));
      if (r) {
        this._state.friendQuery = '';
        g.toast(r.state === 'accepted' ? `已和 ${r.nickname} 成为好友` : `已向 ${r.nickname} 发送申请`, 'good');
        this._render();
      }
    };
    this._offs.push(on(addBtn, 'click', submit));
    this._offs.push(on(input, 'keydown', (e) => { if (e.key === 'Enter') submit(); }));

    const inBox = h('div', '');
    const outBox = h('div', '');
    side.append(h('hr', 'sep'), h('h3', 'sec', '收到的申请'), inBox,
      h('hr', 'sep'), h('h3', 'sec', '已发送'), outBox);

    const main = h('div', 'col main');
    const listBox = h('div', '');
    main.append(h('h3', 'sec', '好友'), listBox);
    body.append(side, main);

    const res = await api.friends().catch(() => null);
    if (!this.el || this.name !== 'social') return;
    if (!res) {
      listBox.appendChild(h('p', 'muted tiny', '读不到好友列表，可能是网络问题。'));
      return;
    }

    // `data-*` on the buttons rather than a closure per row: the lists are rebuilt on
    // every action, and one delegated handler cannot leak listeners the way N do.
    const rowFor = (f, buttons) => {
      const row = h('div', `list-row${f.online ? '' : ' dim'}`);
      const t = h('div', 't');
      t.append(h('b', '', f.nickname || '旅行者'), h('small', '', [
        `AR ${f.adventureRank}`,
        f.online ? (zoneById(f.zone)?.name || f.zone || '在线') : '离线',
        // Three states, not two: a teammate inside a 秘境 *can* be followed (same party,
        // same private shard), which is what co-op dungeons are; a friend in a 秘境 who is
        // not in my party, or one playing 单机, cannot.
        f.online && !f.joinable ? '（秘境／单人世界）'
          : f.online && f.private ? '（秘境 · 队伍中，可跟随）' : null,
      ].filter(Boolean).join(' · ')));
      row.appendChild(t);
      for (const [act, label, cls] of buttons) {
        const btn = h('button', `btn small${cls ? ` ${cls}` : ''}`, label);
        btn.dataset.act = act;
        btn.dataset.pid = String(f.playerId);
        row.appendChild(btn);
      }
      return row;
    };

    for (const f of res.incoming) {
      inBox.appendChild(rowFor(f, [['accept', '同意', 'primary'], ['decline', '拒绝', 'ghost']]));
    }
    if (!res.incoming.length) inBox.appendChild(h('p', 'muted tiny', '没有新的好友申请。'));

    for (const f of res.outgoing) outBox.appendChild(rowFor(f, [['cancel', '取消', 'ghost']]));
    if (!res.outgoing.length) outBox.appendChild(h('p', 'muted tiny', '没有等待回应的申请。'));

    for (const f of res.friends) {
      const buttons = [];
      // Hidden rather than disabled when they cannot be used: a 单机 world has no
      // gateway to invite through, and an offline friend has no shard to join.
      if (!solo && f.online) buttons.push(['invite', '邀请组队', '']);
      if (!solo && f.joinable) {
        buttons.push(['join', f.private ? '加入Ta的秘境' : '前往Ta的世界', 'primary']);
      }
      buttons.push(['remove', '删除', 'ghost']);
      listBox.appendChild(rowFor(f, buttons));
    }
    if (!res.friends.length) {
      listBox.appendChild(h('p', 'muted tiny', '还没有好友。在「队伍」里能看到在线的旅行者，也可以直接用昵称申请。'));
    }

    this._offs.push(on(body, 'click', async (e) => {
      const btn = e.target.closest('button[data-act][data-pid]');
      if (!btn) return;
      const pid = Number(btn.dataset.pid);
      const f = [...res.friends, ...res.incoming, ...res.outgoing].find((x) => x.playerId === pid);
      switch (btn.dataset.act) {
        case 'accept':
          if (await this._act(() => api.friendAccept(pid), '已添加好友')) this._render();
          break;
        case 'decline': case 'cancel': case 'remove':
          if (await this._act(() => api.friendRemove(pid))) this._render();
          break;
        case 'invite':
          g.socket.partyInvite(pid);
          g.toast('已发送组队邀请', 'good');
          break;
        case 'join':
          // Closes first: `joinFriend` runs the loading screen and rebuilds the world,
          // and a panel left open over it would swallow the clicks that follow.
          this.close();
          g.joinFriend(pid, f?.zone || null);
          break;
        default: break;
      }
    }));

    const online = res.friends.filter((f) => f.online).length;
    foot.append(h('span', '', `好友 ${res.friends.length}/${res.max} 人${online ? ` · 在线 ${online} 人` : ''}`),
      h('div', 'spacer'));
  }

  /* -------------------------------------------------------------- settings -- */

  _settings(body, foot) {
    const g = this.game;
    const main = h('div', 'col main');
    const add = (label, hint, control) => {
      const row = h('div', 'setting');
      const l = h('label', '', label);
      if (hint) l.appendChild(h('small', '', hint));
      row.append(l, control);
      main.appendChild(row);
    };

    const sel = (value, options, fn) => {
      const s = document.createElement('select');
      s.className = 'field';
      for (const [v, label] of options) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        if (v === value) o.selected = true;
        s.appendChild(o);
      }
      s.onchange = () => fn(s.value);
      return s;
    };
    const range = (value, fn) => {
      const r = document.createElement('input');
      r.type = 'range';
      r.min = '0'; r.max = '1'; r.step = '0.05';
      r.value = String(value);
      r.oninput = () => fn(Number(r.value));
      return r;
    };
    const check = (value, fn) => {
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = !!value;
      c.onchange = () => fn(c.checked);
      return c;
    };

    main.appendChild(h('h3', 'sec', '画面'));
    add('画质', '低画质会关闭阴影与后处理', sel(g.settings.quality, [
      ['low', '流畅'], ['medium', '标准'], ['high', '高'], ['ultra', '极致'],
    ], (v) => { g.setQuality(v); this._save(); }));
    // The chosen tier is a ceiling, and this row is where that gets said out loud — plus
    // the tier actually in use when the two differ, so a player who sees fewer trees than
    // the dropdown promises can find out why here instead of assuming it is broken.
    add('自动画质',
      g.quality !== g.settings.quality
        ? `帧率过低时自动降低画质（当前：${QUALITY_NAME[g.quality] || g.quality}）`
        : '帧率过低时自动降低画质，恢复后再调回',
      check(g.settings.autoQuality !== false, (v) => { g.setAutoQuality(v); this._save(); }));
    add('伤害数字', null, check(g.settings.showDamage, (v) => { g.settings.showDamage = v; this._save(); }));
    add('角色名称', null, check(g.settings.showNames, (v) => { g.settings.showNames = v; this._save(); }));
    add('镜头震动', null, check(g.settings.cameraShake, (v) => { g.settings.cameraShake = v; this._save(); }));
    // 时间. The world clock runs off the wall clock (a day is 24 real minutes, so the sky moves
    // while you play and every client agrees on the hour with nothing on the wire); this row
    // freezes it, which is a real player preference — someone who wants to look at 蒙德 at dusk
    // should not have to wait twelve minutes — and the same lever every screenshot probe pins.
    add('世界时间',
      g.worldTimePin === null
        ? `跟随时钟，一天 24 分钟（现在 ${g.clock?.label || '—'}）`
        : '已固定，天色不再随时间变化',
      sel(g.worldTimePin === null ? '' : String(Math.round(g.worldTimePin * 24)), [
        ['', '跟随时钟'], ['6', '06:00 黎明'], ['9', '09:00 上午'], ['12', '12:00 正午'],
        ['15', '15:00 午后'], ['18', '18:00 黄昏'], ['21', '21:00 入夜'], ['0', '00:00 深夜'],
      ], (v) => { g.setWorldTime(v === '' ? null : Number(v)); this._save(); }));

    main.append(h('hr', 'sep'), h('h3', 'sec', '音效'));
    add('音乐音量', null, range(g.settings.musicVolume, (v) => {
      g.settings.musicVolume = v;
      g.audio.setVolumes(v, g.settings.sfxVolume);
      this._save();
    }));
    add('音效音量', null, range(g.settings.sfxVolume, (v) => {
      g.settings.sfxVolume = v;
      g.audio.setVolumes(g.settings.musicVolume, v);
      g.audio.sfx('click');
      this._save();
    }));

    main.append(h('hr', 'sep'), h('h3', 'sec', '操作'));
    add('镜头灵敏度', null, sel(String(g.settings.sensitivity), [
      ['0.6', '低'], ['1', '标准'], ['1.5', '高'], ['2', '很高'],
    ], (v) => { g.settings.sensitivity = Number(v); this._save(); }));
    add('反转纵向视角', null, check(g.settings.invertY, (v) => { g.settings.invertY = v; this._save(); }));
    add('自动攻击锁定目标', '点击敌人后持续攻击直到目标死亡', check(g.settings.autoAttack, (v) => { g.settings.autoAttack = v; this._save(); }));

    // 新手引导 is re-playable, and this is the only door back to it. A guide you can only see
    // once is a guide you cannot consult, and「跳过」would otherwise be irreversible.
    const tv = g.tutorial.view();
    const replay = h('button', 'btn ghost small', tv.step ? '从头开始' : '重新引导');
    replay.dataset.act = 'guide-replay';
    replay.onclick = () => {
      g.tutorial.reset();
      g.audio.sfx('click');
      this.close();
    };
    add('新手引导',
      tv.skipped ? '已跳过'
        : tv.complete ? '已全部完成'
          : `进行中 ${tv.done.length}/${tv.total}`,
      replay);

    // The full control scheme, derived from KEYMAP (see input.js) instead of written out
    // here: this section replaced one 300-character line of prose in the footer that listed
    // every key and — in a game whose primary control is the mouse — not one mouse gesture.
    main.append(h('hr', 'sep'), h('h3', 'sec', '操作说明'));
    const ref = h('div', 'keyref');
    for (const { group, rows } of controlGroups()) {
      ref.appendChild(h('div', 'kgroup', group));
      // Only the mouse group gets the phrase pill. Testing the glyph for CJK instead put 「空格」
      // — a key, and one of the most important ones — in the rounded accent style reserved for
      // gestures, which is exactly the confusion the two styles exist to prevent.
      const word = group === '鼠标' ? ' word' : '';
      for (const r of rows) {
        const keys = h('div', 'kk');
        for (const k of r.keys) keys.appendChild(h('span', `kcap${word}`, k));
        ref.append(keys, h('div', 'kwhat', r.what));
      }
    }
    main.appendChild(ref);

    main.append(h('hr', 'sep'), h('h3', 'sec', '账号'));
    const logout = h('button', 'btn ghost small', '登出并返回标题');
    logout.onclick = async () => {
      await g.persist(true).catch(() => {});
      api.clearToken();
      location.reload();
    };
    add('当前账号', api.nickname || '旅行者', logout);

    body.appendChild(main);
    const playtime = Math.round((g.player?.playtimeSec || 0) / 60);
    foot.append(
      h('span', '', `游戏时长 ${Math.floor(playtime / 60)} 小时 ${playtime % 60} 分 · 完整键位与鼠标操作见上方「操作说明」`),
    );
  }

  _save() {
    clearTimeout(this._saveT);
    // Coalesce slider drags into one request.
    this._saveT = setTimeout(() => {
      api.save({ settings: this.game.settings }).catch(() => {});
    }, 400);
  }

  /* ---------------------------------------------------------------- modals -- */

  _modal(title, content, buttons = []) {
    this._closeModal();
    const el = frag(`
      <div class="scrim">
        <div class="panel narrow">
          <header><h2></h2><div class="spacer"></div><button class="close">✕</button></header>
          <div class="body"><div class="col main"></div></div>
          <footer><div class="spacer"></div></footer>
        </div>
      </div>`);
    text(q(el, 'h2'), title);
    q(el, '.col.main').appendChild(content);
    const foot = q(el, 'footer');
    for (const [label, kind, fn] of buttons) {
      const b = h('button', `btn small ${kind || ''}`.trim(), label);
      b.onclick = fn;
      foot.appendChild(b);
    }
    on(q(el, '.close'), 'click', () => this._closeModal());
    on(el, 'mousedown', (e) => { if (e.target === el) this._closeModal(); });
    this.root.appendChild(el);
    this.modal = el;
    this.game.setPaused(true);
    return el;
  }

  _closeModal() {
    if (!this.modal) return;
    this.modal.remove();
    this.modal = null;
    if (!this.el) this.game.setPaused(false);
  }

  /** NPC conversation: lines advance on click, quests announce themselves. */
  dialogue({ npc, lines, started }) {
    const body = h('div', '');
    // `npc.role` is a slug ('forge', 'guild'); it was being printed raw, so the guild
    // receptionist introduced herself as "凯瑟琳 · guild".
    const who = h('h3', 'sec', `${npc.name}${npcRoleName(npc.role) ? ` · ${npcRoleName(npc.role)}` : ''}`);
    const p = h('p', '', '');
    body.append(who, p);
    let i = 0;
    const all = lines?.length ? lines : ['……'];
    p.textContent = all[0];

    const next = h('button', 'btn primary small', all.length > 1 ? '继续' : '结束');
    next.onclick = () => {
      i++;
      if (i >= all.length) return this._closeModal();
      p.textContent = all[i];
      next.textContent = i === all.length - 1 ? '结束' : '继续';
    };
    if (started) {
      body.append(h('hr', 'sep'), h('p', 'gold', `接到新任务：${started.name}`));
      const open = h('button', 'btn small', '查看任务');
      open.onclick = () => { this._closeModal(); this.open('quests'); };
      body.appendChild(open);
    }
    this._modal('对话', body, [['关闭', 'ghost', () => this._closeModal()]]);
    // A keeper's counter opens from the conversation, at *his* tab: the panel is reachable
    // from anywhere, but walking up to the blacksmith and being shown Paimon's stall would
    // make the NPC pointless.
    if (npc.shop) {
      const shopBtn = h('button', 'btn small', '看看货');
      shopBtn.onclick = () => { this._closeModal(); this.openShop(npc.shop); };
      q(this.modal, 'footer').appendChild(shopBtn);
    }
    q(this.modal, 'footer').appendChild(next);
  }

  confirmDungeon({ zone, accept }) {
    const body = h('div', '');
    body.append(
      h('h3', 'sec', zone.name),
      h('p', 'muted', `${zone.subtitle} · 推荐等级 ${zone.recommendedLevel} · 共 ${zone.chambers?.length || 1} 间`),
      h('p', 'tiny muted', '进入秘境后将与当前区域的其他旅行者分离，队伍会一同传送。'),
    );
    if (zone.domain) {
      const cost = zone.domain.resin ?? DOMAIN_RESIN;
      body.appendChild(h('p', 'tiny muted',
        `每通关一间消耗 ${cost} 树脂，换取圣遗物与天赋材料掉落；星数奖励只结算一次，树脂不足也照常记录。`));
    }
    this._modal('进入秘境', body, [
      ['取消', 'ghost', () => this._closeModal()],
      ['进入', 'primary', () => { this._closeModal(); accept(); }],
    ]);
  }

  chamberReward(d) {
    const body = h('div', '');
    const stars = '★'.repeat(d.stars || 0) + '☆'.repeat(3 - (d.stars || 0));
    body.append(
      h('h3', 'sec', `第 ${d.floor} 间 · ${stars}`),
      h('p', 'muted', `用时 ${(d.time || 0).toFixed(1)} 秒`),
    );
    const dl = h('dl', 'stats');
    const rw = d.reward || {};
    if (rw.mora) dl.append(h('dt', '', '摩拉'), h('dd', 'up', num(rw.mora)));
    if (rw.primogem) dl.append(h('dt', '', '原石'), h('dd', 'up', num(rw.primogem)));
    if (rw.xp) dl.append(h('dt', '', '冒险经验'), h('dd', 'up', num(rw.xp)));
    // `reward` is a flat {itemId: count} map from the world manager, so anything
    // that is not a currency key is a material.
    for (const [id, n] of Object.entries(rw)) {
      if (id === 'mora' || id === 'primogem' || id === 'xp') continue;
      dl.append(h('dt', '', MATERIALS[id]?.name || id), h('dd', 'up', `×${n}`));
    }
    if (d.ar?.leveled) dl.append(h('dt', 'gold', '冒险等阶'), h('dd', 'up', `→ ${d.ar.adventureRank}`));
    body.appendChild(dl);

    // The resin-paid drop, which unlike the stars is earned again on every run — so it
    // gets its own block, and the reason it is missing has to be visible when it is.
    const res = d.resin;
    if (res?.short) {
      body.append(
        h('hr', 'sep'),
        h('p', 'tiny bad', `树脂不足（需 ${res.cost} 点），本次没有秘境掉落。星数与经验已结算。`),
      );
    } else if (d.drops) {
      body.append(h('hr', 'sep'), h('h3', 'sec', `秘境掉落 · 消耗 ${res?.spent ?? 0} 树脂`));
      // Same slot markup as the bag, so a piece looks the same here as where it lands.
      const grid = h('div', 'grid');
      for (const a of d.drops.artifacts || []) {
        const info = itemInfo(a);
        const slot = frag(`<div class="slot r${info.rarity}">
          <div class="ico"></div><div class="nm"></div><div class="lv"></div></div>`);
        text(q(slot, '.ico'), info.icon);
        text(q(slot, '.nm'), info.name);
        text(q(slot, '.lv'), `+${a.level}`);
        grid.appendChild(slot);
      }
      body.appendChild(grid);
      const dl2 = h('dl', 'stats');
      if (d.drops.mora) dl2.append(h('dt', '', '摩拉'), h('dd', 'up', num(d.drops.mora)));
      for (const [id, n] of Object.entries(d.drops.items || {})) {
        dl2.append(h('dt', '', MATERIALS[id]?.name || id), h('dd', 'up', `×${n}`));
      }
      body.appendChild(dl2);
      if (res) body.appendChild(h('p', 'tiny muted', `剩余树脂 ${res.left}`));
    }
    this._modal('挑战奖励', body, [['确定', 'primary', () => this._closeModal()]]);
  }

  /** `d` is the gateway's invite record: { from, nickname, partyId }. */
  partyInvite(d) {
    const body = h('div', '', h('p', '', `${d.nickname || '一位旅行者'} 邀请你组队。`));
    this._modal('组队邀请', body, [
      ['拒绝', 'ghost', () => this._closeModal()],
      ['接受', 'primary', () => {
        this.game.socket.partyAccept(d.partyId);
        this._closeModal();
      }],
    ]);
  }

  /** Escape closes the top-most layer only. */
  escape() {
    if (this.modal) { this._closeModal(); return true; }
    if (this.el) { this.close(); return true; }
    return false;
  }

  destroy() {
    clearTimeout(this._mailBoot);
    clearTimeout(this._achBoot);
    clearInterval(this._achPoll);
    clearTimeout(this._expBoot);
    clearInterval(this._expPoll);
    clearInterval(this._expClock);
    this._closeModal();
    if (this.el) this._teardown();
    this.name = null;
  }
}

/* ------------------------------------------------------------------ helpers -- */

/** Display shape for a weapon or artifact instance. */
function itemInfo(it) {
  if (it.kind === 'weapon') {
    const def = WEAPONS[it.weaponId] || {};
    // `weaponStats`, not a second copy of the curve: this used to recompute
    // `baseAtk * (1 + 5.4 * t^1.08)` and the sub-stat ramp inline, which is the same
    // arithmetic the server levels the weapon with and would have drifted the moment
    // either side changed.
    const ws = weaponStats(it);
    const stats = [['基础攻击力', num(ws.atk)]];
    if (ws.sub) stats.push(statText(ws.sub.key, ws.sub.value));
    const r = it.refinement || 1;
    return {
      icon: equipIcon(it), name: equipName(it), rarity: def.rarity || 3,
      detail: `${WEAPON_TYPES[def.type]?.name || ''} · Lv.${it.level}${r > 1 ? ` · 精炼 ${r}` : ''}`,
      desc: def.desc || '', stats,
    };
  }
  const set = ARTIFACT_SETS[it.setId] || {};
  const stats = [];
  if (it.main) stats.push(statText(it.main.key, it.main.value));
  for (const s of it.subs || []) stats.push(statText(s.key, s.value));
  return {
    icon: equipIcon(it),
    name: equipName(it),
    rarity: it.rarity || 4,
    detail: `${SLOT_NAMES[it.slot] || it.slot} · +${it.level}`,
    desc: `2件：${set.twoDesc || '—'}\n4件：${set.fourDesc || '—'}`,
    stats,
  };
}

/**
 * Label for anything a shop can name — a material, a currency or a weapon.
 *
 * `itemInfo` above wants an *instance* (a rolled artifact, a levelled weapon); a shop row
 * only has an id, and the two tables it could be in are disjoint.
 */
function shopItemInfo(id) {
  const m = MATERIALS[id];
  if (m) return { icon: itemIcon(id), name: m.name || id, rarity: m.rarity || 0 };
  const w = WEAPONS[id];
  if (w) return { icon: itemIcon(id), name: w.name || id, rarity: w.rarity || 3 };
  return { icon: '·', name: id, rarity: 0 };
}

function materialDesc(def) {
  if (def.xp) return `角色经验材料，可提供 ${num(def.xp)} 点经验。`;
  if (def.heal) return `食用后恢复 ${num(def.heal.flat)} 点生命值，并额外恢复 ${(def.heal.hpPct * 100).toFixed(0)}% 上限。`;
  // 40% is the dish's own `revive.hpPct`, and since the fix in `entity.revive` it is also
  // the number the simulation uses — it used to hand back a hardcoded 50%.
  if (def.revive) return `倒下时使用：全队复苏并恢复 ${(def.revive.hpPct * 100).toFixed(0)}% 生命值。`;
  if (def.buff) {
    const bits = [];
    if (def.buff.atkPct) bits.push(`攻击力提升 ${(def.buff.atkPct * 100).toFixed(0)}%`);
    if (def.buff.critRate) bits.push(`暴击率提升 ${(def.buff.critRate * 100).toFixed(0)}%`);
    return `${bits.join('，')}，持续 ${def.buff.duration} 秒。`;
  }
  if (def.resin) return `立即回复 ${def.resin} 点树脂。`;
  return '可用于角色养成或任务提交的材料。';
}

/**
 * Bake cache keyed by zone. The map panel can show any zone, not just the one
 * being played, and a bake costs ~50 ms — worth keeping once paid.
 */
const bakeCache = new Map();
function bakedFor(zone) {
  let b = bakeCache.get(zone.id);
  if (!b) {
    b = bakeZoneMap(zone);
    bakeCache.set(zone.id, b);
  }
  return b;
}
