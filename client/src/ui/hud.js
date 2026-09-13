// The always-on HUD: party cards, currency, minimap, action bar, stamina wheel,
// chat log, interaction prompt, damage vignettes, chamber timer, quest tracker.
//
// Built once, then mutated in place every frame. The frame path deliberately does
// no allocation and no innerHTML: it writes text and CSS custom properties through
// the guarded helpers in dom.js, so an unchanged value costs a comparison instead
// of a style recalculation.

import { frag, h, q, qa, text, css, cssVar, cls, pct, num, on, hexColor, ELEMENT_GLYPH } from './dom.js';
import { ELEMENTS } from '@teyvat/shared/data/elements.js';
import { CHARACTERS } from '@teyvat/shared/data/characters.js';
import { QUESTS } from '@teyvat/shared/data/quests.js';
import { questTarget, trackedQuest } from '@teyvat/shared/data/questNav.js';
import { navWhere } from './navtext.js';
import { keyHint } from '../game/input.js';
import { MATERIALS } from '@teyvat/shared/data/items.js';
import { disorderById, disorderHint } from '@teyvat/shared/data/disorders.js';
import { STAMINA } from '@teyvat/shared/sim/formulas.js';
import { AUTO_RESPAWN_SEC } from '@teyvat/shared/world/zoneInstance.js';
import { nearestAnchor, anchorName, zoneProgress } from '@teyvat/shared/data/anchors.js';
import { ZONES } from '@teyvat/shared/data/zones.js';
import { exploreClaims } from '@teyvat/shared/data/exploration.js';
import { bakeZoneMap, drawMinimap } from './mapview.js';

/** Same names the settings panel uses, so a downgrade notice matches the dropdown. */
const QUALITY_NAME = { low: '流畅', medium: '标准', high: '高', ultra: '极致' };

/** Wall clock in seconds, the same units the instance's own timer uses. */
const now = () => performance.now() / 1000;

const HTML = `
<div class="hud" data-hud>
  <div class="hud-tl">
    <div class="hud-player">
      <span data-f="nick">旅行者</span>
      <span class="ar" data-f="ar">AR 1</span>
      <span class="tiny muted" data-f="mode"></span>
    </div>
    <div class="party" data-f="party"></div>
    <div class="tracker hidden" data-f="tracker"><b></b><span></span>
      <div class="qnav hidden" data-f="qnav"><i class="qarrow" data-f="qarrow">↑</i><em data-f="qwhere"></em><s data-f="qdist"></s></div>
    </div>
    <div class="buffs" data-f="buffs"></div>
  </div>

  <div class="hud-tr">
    <div class="currency">
      <span class="mail-chip click hidden" data-f="mailbtn" data-act="mail" title="有未领取的邮件，点击或${keyHint('mail', '打开')}">✉<b data-f="mailn">0</b></span>
      <span class="mail-chip ach click hidden" data-f="achbtn" data-act="achievements" title="有可领取的成就奖励，点击或${keyHint('achievements', '打开')}">★<b data-f="achn">0</b></span>
      <span class="mail-chip gift click hidden" data-f="giftbtn" data-act="explore" title="有可领取的探索奖励">🎁<b data-f="giftn">0</b></span>
      <span class="mail-chip exp click hidden" data-f="expbtn" data-act="expedition" title="有派遣已归来，点击或${keyHint('expedition', '打开')}">🧭<b data-f="expn">0</b></span>
      <span title="摩拉"><i class="cur-ico mora"></i><b data-f="mora">0</b></span>
      <span title="原石"><i class="cur-ico gem"></i><b data-f="gem">0</b></span>
      <span title="纠缠之缘"><i class="cur-ico ticket"></i><b data-f="ticket">0</b></span>
      <span title="树脂"><i class="cur-ico resin"></i><b data-f="resin">0</b></span>
    </div>
    <div class="minimap-wrap click" data-f="minimap" title="点击或${keyHint('map', '打开大地图')}">
      <canvas width="296" height="296"></canvas>
      <div class="compass">N</div>
    </div>
    <div class="zone-name"><b data-f="zone">—</b><span data-f="zonesub"></span></div>
    <div class="worldclock" data-f="clockwrap" title="世界时间：1 现实秒 = 1 游戏分钟，一天 24 分钟">
      <i class="wc-dial" data-f="clockdial"></i><b data-f="clock">--:--</b><span data-f="clockname"></span><em data-f="clocknote" class="hidden"></em>
      <span class="wc-sky hidden" data-f="weather"></span>
    </div>
    <div class="hud-status">
      <div><i class="ping-dot" data-f="pingdot"></i><span data-f="ping">—</span></div>
      <div data-f="coldwrap" class="hidden"><div class="cold-meter"><i data-f="cold"></i></div></div>
    </div>
  </div>

  <div class="hud-br">
    <div class="stamina" data-f="stamina"><div class="ring"></div></div>
    <div class="skills">
      <div class="skill click" data-f="skillbtn" data-act="skill">
        <span class="glyph" data-f="skillglyph">✦</span>
        <span class="kb">E</span>
        <span class="cd"></span>
        <span class="cdnum"></span>
      </div>
      <div class="skill burst click" data-f="burstbtn" data-act="burst">
        <span class="ring"></span>
        <span class="glyph" data-f="burstglyph">❋</span>
        <span class="kb">Q</span>
        <span class="cd"></span>
        <span class="cdnum"></span>
      </div>
    </div>
  </div>

  <div class="hud-bl">
    <div class="chatlog" data-f="chatlog"></div>
    <div class="chatbar" data-f="chatbar">
      <select data-f="channel">
        <option value="world">世界</option>
        <option value="zone">区域</option>
        <option value="party">队伍</option>
      </select>
      <input class="field" data-f="chatinput" maxlength="300" placeholder="说点什么…">
    </div>
  </div>

  <div class="prompt" data-f="prompt">
    <span class="k">F</span><span class="txt"></span><span class="sub"></span>
  </div>

  <div class="guide" data-f="guide">
    <div class="ghead">
      <b data-f="guidetitle"></b>
      <span class="gn" data-f="guiden">1/1</span>
    </div>
    <p data-f="guidehint"></p>
    <div class="gkeys" data-f="guidekeys"></div>
    <div class="gbar"><i data-f="guidebar"></i></div>
    <button class="gskip" data-act="guideSkip">跳过引导</button>
  </div>
  <div class="reticle" data-f="reticle"></div>
  <div class="chamber" data-f="chamber">
    <div class="clock">0:00</div>
    <div class="sub"></div>
    <div class="dis"></div>
  </div>

  <div class="toasts" data-f="toasts"></div>
  <div class="hurt" data-f="hurt"></div>
  <div class="frost" data-f="frost"></div>
  <div class="downed" data-f="downed">
    <div class="box">
      <h2>力竭</h2>
      <p data-f="downedsub">等待队友救援，或使用复苏道具</p>
      <button class="btn primary" data-act="revive" data-f="revivebtn">原地复苏</button>
      <button class="btn ghost" data-act="respawn" data-f="respawnbtn">返回最近的锚点</button>
      <div class="wait" data-f="downedwait"></div>
    </div>
  </div>
</div>`;

export class Hud {
  constructor(root, game) {
    this.game = game;
    this.el = frag(HTML);
    root.appendChild(this.el);
    this.f = {};
    for (const el of qa(this.el, '[data-f]')) this.f[el.dataset.f] = el;

    this.minimapCanvas = q(this.f.minimap, 'canvas');
    this.baked = null;
    this.mapRange = 90;
    this.cards = [];
    this._cardKey = '';
    this._chatLines = 0;
    this._banner = null;
    this._mapAcc = 0;
    this._hurtT = 0;
    this._lastStaminaEmpty = false;
    this.chatOpen = false;
    this._buffKey = '';
    this._buffChips = [];
    this._downAt = 0;       // when we went down, on the same clock the countdown reads
    this._downKey = '';
    this._giftZone = null;  // which zone the 🎁 chip's click should select on the map

    this._bind();
    // Mount is the same hook as a state change (`state-ui-needs-a-mount-write`): logging in with a
    // half-explored zone is exactly when this chip has something to say.
    this.refreshGift();
  }

  _bind() {
    const g = this.game;

    on(this.el, 'click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'skill') g.me.useSkill(g.actors);
      else if (act === 'burst') g.me.useBurst(g.actors);
      else if (act === 'mail') g.emit('togglePanel', { panel: 'mail' });
      else if (act === 'achievements') g.emit('togglePanel', { panel: 'achievements' });
      else if (act === 'expedition') g.emit('togglePanel', { panel: 'expedition' });
      // The 探索奖励 chip is the only one of the three that has to say *where*: the mailbox and the
      // trophy case are single places, but the ladder is per zone and the button lives on the map's
      // selected zone. So the click carries the zone it is counting for — otherwise it lands the
      // player on whatever zone they happen to be standing in and the reward is still hidden.
      else if (act === 'explore') {
        g.emit('togglePanel', { panel: 'map', open: true, zone: this._giftZone || undefined });
      }
      // Two buttons, two mechanics. They both called `revive` before, so 「返回最近的锚点」 was a
      // second copy of 「原地复苏」 that failed with `no_revive_item` and left you lying there.
      else if (act === 'revive') g.socket.revive(g.playerId);
      else if (act === 'respawn') g.socket.respawn();
      else if (act === 'guideSkip') g.tutorial.skip();
    });

    on(this.f.minimap, 'click', () => g.emit('togglePanel', { panel: 'map' }));
    on(this.f.minimap, 'wheel', (e) => {
      e.preventDefault();
      this.mapRange = Math.max(40, Math.min(240, this.mapRange * (1 + Math.sign(e.deltaY) * 0.15)));
    }, { passive: false });

    // Party cards are click targets — the whole point of a mouse-driven game.
    on(this.f.party, 'click', (e) => {
      const card = e.target.closest('.pcard');
      if (card) g.switchTo(Number(card.dataset.slot));
    });

    on(this.f.chatinput, 'keydown', (e) => {
      if (e.key === 'Enter') {
        const body = this.f.chatinput.value.trim();
        if (body) g.socket.chat(this.f.channel.value, body);
        this.f.chatinput.value = '';
        this.closeChat();
        e.stopPropagation();
      } else if (e.key === 'Escape') {
        this.f.chatinput.value = '';
        this.closeChat();
        e.stopPropagation();
      }
    });

    // Game → HUD
    g.on('zone', ({ zone }) => this.setZone(zone));
    g.on('clock', (c) => this.setClock(c));
    g.on('weather', (w) => this.setWeather(w));
    g.on('chat', (d) => this.chat(d));
    g.on('toast', ({ text: t, kind }) => this.toast(t, kind));
    g.on('banner', ({ title, sub }) => this.banner(title, sub));
    // A boss changing phase gets the zone banner's weight, in the boss's colour and one line
    // higher, because it is the same kind of statement ("where you are has changed") and it
    // has to be readable from the middle of a dodge. The plate keeps the state afterwards.
    g.on('bossPhase', ({ name, phase, phases }) => this.banner(
      name, phases > 1 ? `第 ${phase} / ${phases} 阶段 · 硬直 1.2 秒` : '第二阶段 · 硬直 1.2 秒', 'phase'));
    g.on('prompt', (p) => this.setPrompt(p));
    // 「助战」 is the whole explanation for a drop that arrived with no corpse of your own
    // under it: in co-op the last hit is somebody else's, and the line has to say why you
    // were paid anyway (`assist` comes from the gateway, see `world/manager.handleKill`).
    g.on('loot', (d) => this.chat({ channel: 'loot', body: `${d.assist ? '助战 ' : ''}获得 ${d.text}` }));
    g.on('hurt', () => this.flashHurt());
    g.on('down', () => { cls(this.f.downed, 'show', true); this._downAt = now(); this._refreshDowned(); });
    // Blank the countdown as well as hiding the panel: `_downedTick` only runs while the
    // character is down, so a leftover 「正在返回锚点…」 would be the first thing the *next*
    // death shows, for the frame before the tick overwrites it.
    g.on('revived', () => { cls(this.f.downed, 'show', false); this._downAt = 0; text(this.f.downedwait, ''); });
    g.on('aiming', ({ on: v }) => cls(this.f.reticle, 'show', v));
    g.on('nostamina', () => this.shakeStamina());
    g.on('tutorial', (v) => this.setGuide(v));
    // The badge counts *claimable* letters, not unread ones: an unread letter with nothing
    // attached is a notice, and a badge that will not go away when you read it is noise.
    g.on('mailCounts', (c) => this.setMail(c));
    g.on('achCounts', (c) => this.setAch(c));
    g.on('expCounts', (c) => this.setExp(c));
    g.on('quest', () => this.refreshTracker());
    // `playerState` is the one line every writer repeats (`Game._applyPlayer`), which is what makes
    // the 🎁 chip live without a poll: the milestone rows arrive inside the same `publicPlayer` the
    // chest that moved 探索度 answered with.
    g.on('playerState', () => { this.refreshTracker(); this.refreshGift(); });
    g.on('connection', ({ state }) => {
      if (state === 'reconnecting') this.chat({ channel: 'warn', body: '与服务器的连接中断，正在重连…' });
      if (state === 'up' && this._wasDown) this.chat({ channel: 'sys', body: '已重新连接' });
      this._wasDown = state !== 'up';
    });
  }

  /* ------------------------------------------------------------------ zone -- */

  setZone(zone) {
    text(this.f.zone, zone?.name || '');
    text(this.f.zonesub, zone?.subtitle || '');
    // Baking is ~50 ms; doing it on zone entry (already a loading screen) keeps it
    // off the frame path entirely.
    this.baked = zone ? bakeZoneMap(zone) : null;
    cls(this.f.coldwrap, 'hidden', !zone?.mechanic?.sheerCold);
    this.mapRange = Math.max(60, Math.min(140, (zone?.size || 400) / 4));
    // The tracker is a *state*, not a notification. It used to be written only by the 'quest'
    // and 'playerState' events, and neither of them fires on arrival: the intro quest is
    // granted with the account and the daily commissions are rolled before the first frame, so
    // a player logged in with five active quests and an empty corner of the screen until the
    // next kill happened to emit something. This is also the hook a zone change needs — the
    // objective has to be re-resolved against the zone the player is now in, or the arrow keeps
    // counting metres to a place that is no longer here.
    this.refreshTracker();
    // Same reason as the tracker: the clock is a state. A zone change re-emits it (enterZone
    // forces a daylight update), but reading it here as well means the HUD is right even if it
    // was built after that emit — which is exactly what happens on the first zone.
    if (this.game.clock) this.setClock(this.game.clock);
    if (this.game.weather) this.setWeather(this.game.weather);
  }

  /* ------------------------------------------------------------ world clock -- */

  /**
   * 世界时间. The hour, what to call it, and a dial that takes its colour from the sun the sky is
   * actually using — so the widget cannot drift from the picture the way a hard-coded gold sun
   * and a blue night would.
   *
   * `note` carries the two cases where the number is not the whole truth: underground, where the
   * sky is a vault and does not move, and pinned, where the player (or a probe) has frozen it.
   */
  setClock(c) {
    if (!c) return;
    text(this.f.clock, c.label);
    text(this.f.clockname, c.name || '');
    text(this.f.clocknote, c.note || '');
    cls(this.f.clocknote, 'hidden', !c.note);
    cls(this.f.clockwrap, 'pinned', !!c.pinned);
    // The tooltip carries the sun's elevation, which is the one number that says *why* the scene
    // looks the way it does — 0° is the golden hour, negative is night — and it is also the only
    // reader of `elevation`, which is what keeps that term from becoming another dead key.
    this.f.clockwrap.title = `世界时间 ${c.label} · ${c.name}`
      + `${typeof c.elev === 'number' ? ` · 太阳高度 ${c.elev > 0 ? '+' : ''}${c.elev}°` : ''}`
      + `${c.pinned ? ' · 已固定' : ' · 一天 24 分钟'}`;
    const s = c.sunColor || [1, 1, 1];
    const b = (i) => Math.round(Math.max(0, Math.min(1, s[i])) * 255);
    const rgb = `${b(0)}, ${b(1)}, ${b(2)}`;
    // Night is a crescent, and the dial dims with the day: a full-brightness disc at 02:00 reads
    // as "the sun is up" no matter what colour it is.
    const lum = 0.45 + 0.55 * (c.day ?? 1);
    this.f.clockdial.style.background = `rgb(${rgb})`;
    this.f.clockdial.style.opacity = String(lum);
    this.f.clockdial.style.boxShadow = `0 0 ${c.night > 0.5 ? 7 : 10}px rgba(${rgb}, ${0.35 + 0.4 * (c.day ?? 1)})`;
    cls(this.f.clockdial, 'moon', (c.night ?? 0) > 0.5);
  }

  /**
   * 天气. Sits inside the clock widget because it is the same fact — what the sky is doing — and
   * because a storm arriving is something the player should be able to *read*, not just notice: the
   * name comes from `weatherAt`, so the words, the particles and the sheer-cold rate are all the one
   * expression. Hidden when there is nothing to say (a clear day, or a dungeon with no sky).
   */
  setWeather(w) {
    if (!w) return;
    const showing = w.type !== 'none' && w.type !== 'clear';
    text(this.f.weather, showing ? w.name : '');
    cls(this.f.weather, 'hidden', !showing);
    cls(this.f.weather, 'wet', w.type === 'rain');
    cls(this.f.weather, 'snowy', w.type === 'snow' || w.type === 'blizzard');
    // Intensity rides on the text's own weight rather than a second element: 暴雨 should read
    // heavier than 零星细雨 without adding a meter nobody asked for.
    this.f.weather.style.opacity = String(0.55 + 0.45 * (w.intensity || 0));
    // The day's own name (今日天气) goes in the tooltip: the chip says what it is doing *now*, the
    // tooltip says what the day is, which is the only reader of `dayName` and `dayIndex`.
    this.f.weather.title = `今日天气：${w.dayName}（第 ${w.dayIndex} 天）`
      + `${w.coldMul > 1.001 ? ` · 严寒加剧 ×${w.coldMul.toFixed(2)}` : ''}`;
  }

  /* ----------------------------------------------------------------- guide -- */

  /**
   * 新手引导 card. One step at a time, on the left where nothing else lives, and gone the
   * moment the last step is done or the player presses 跳过.
   *
   * The card is rebuilt only when the step changes (`_guideId`), because it is a real
   * innerHTML write and the alternative is doing it sixty times a second for a panel whose
   * text cannot change without the step changing.
   */
  setGuide(v = {}) {
    const step = v.step || null;
    cls(this.f.guide, 'show', !!step);
    if (!step) { this._guideId = null; return; }
    text(this.f.guiden, `${v.at}/${v.total}`);
    // The bar counts finished steps, so it reads 0 on the first step and never shows the
    // current one as already done.
    css(this.f.guidebar, 'width', pct(v.done.length, v.total));
    if (this._guideId === step.id) return;
    this._guideId = step.id;
    text(this.f.guidetitle, step.title);
    text(this.f.guidehint, step.hint);
    const keys = this.f.guidekeys;
    keys.innerHTML = '';
    for (const k of step.keys || []) keys.appendChild(h('span', 'gk', k));
    // The mouse glyph is a different shape from a key cap on purpose: the thing this guide
    // exists to teach is that the game can be played with the mouse alone, and a 「左键点地面」
    // pill that looks like the W key would read as one more key to press.
    if (step.mouse) keys.appendChild(h('span', 'gk mouse', step.mouse));
  }

  /** Mail badge. Hidden entirely when there is nothing to collect. */
  setMail(counts = {}) {
    const n = counts.claimable || 0;
    text(this.f.mailn, String(n));
    cls(this.f.mailbtn, 'hidden', n === 0);
  }

  /**
   * The trophy chip counts *collectable tiers*, not achievements earned: an achievement whose
   * reward is already in the purse must not keep asking to be visited.
   */
  setAch(summary = {}) {
    const n = summary.claimableTiers || 0;
    text(this.f.achn, String(n));
    cls(this.f.achbtn, 'hidden', n === 0);
  }

  /**
   * 探索派遣: how many characters are standing at the door with a full bag.
   *
   * Only the *finished* trips count. A chip that showed 「2 派遣中」 would be a permanent
   * decoration for the twenty hours nothing can be done about them, and the tooltip carries the
   * only other number worth knowing — how full the slate is, which is what 领取 frees.
   */
  setExp(counts = {}) {
    const n = counts.ready || 0;
    text(this.f.expn, String(n));
    cls(this.f.expbtn, 'hidden', n === 0);
    if (n) {
      this.f.expbtn.title = `${n} 支派遣已归来（派遣位 ${counts.inFlight || 0}/${counts.slots || 0}）`
        + `，点击或${keyHint('expedition', '打开')}`;
    }
  }

  /**
   * The 探索奖励 chip: how many milestone steps are waiting, across every zone.
   *
   * Derived, not pushed and not polled — the rows live in the save this HUD already holds, so this
   * runs on `playerState` *and* once at mount. Mount matters: the boot sequence applies the player
   * document before this object exists in some paths, and an event-only chip on a save that walked
   * 龙脊雪山 to 60% last session would stay hidden until the next chest.
   */
  refreshGift(player = this.game.player) {
    const sum = exploreClaims(player?.worldProgress);
    this._giftZone = sum.best?.zone || null;
    text(this.f.giftn, String(sum.rungs));
    cls(this.f.giftbtn, 'hidden', sum.rungs === 0);
    // The number alone is a dead end (the same reason the map's disabled button still prices its
    // next step): the tooltip has to name the zone to walk to and what the press is worth.
    if (sum.rungs) {
      const lines = sum.zones.map((z) => `${ZONES[z.zone]?.name || z.zone} ${z.pct}% · `
        + `${z.claimable.length} 档 · 摩拉 ${num(z.reward.mora)} · 原石 ${num(z.reward.primogem)}`);
      this.f.giftbtn.title = `有 ${sum.rungs} 档探索奖励可领取（点击打开地图领取）\n${lines.join('\n')}`;
    }
  }

  /* ------------------------------------------------------------------ chat -- */

  chat(d) {
    const log = this.f.chatlog;
    const ln = document.createElement('div');
    const chan = d.channel || 'world';
    ln.className = `ln ${chan}`;
    if (chan !== 'sys' && chan !== 'warn' && chan !== 'err' && chan !== 'loot') {
      const ch = document.createElement('span');
      ch.className = 'ch';
      ch.textContent = chan === 'party' ? '[队伍]' : chan === 'zone' ? '[区域]' : '[世界]';
      ln.appendChild(ch);
    }
    if (d.nickname) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `${d.nickname}：`;
      ln.appendChild(who);
    }
    ln.appendChild(document.createTextNode(d.body || ''));
    log.appendChild(ln);
    // Cap the log. An unbounded chat log in a long session is a slow memory leak
    // and a slow layout.
    if (++this._chatLines > 60) {
      log.removeChild(log.firstChild);
      this._chatLines--;
    }
    log.scrollTop = log.scrollHeight;
  }

  openChat() {
    this.chatOpen = true;
    cls(this.f.chatbar, 'open', true);
    cls(this.f.chatlog, 'interactive', true);
    this.f.chatinput.focus();
  }

  closeChat() {
    this.chatOpen = false;
    cls(this.f.chatbar, 'open', false);
    cls(this.f.chatlog, 'interactive', false);
    this.f.chatinput.blur();
  }

  /* ---------------------------------------------------------------- notices -- */

  toast(t, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`.trim();
    el.textContent = t;
    this.f.toasts.appendChild(el);
    // The CSS animation ends at 3.35 s; remove a little after so the node is gone
    // but the fade is never cut short.
    setTimeout(() => el.remove(), 3500);
    while (this.f.toasts.childElementCount > 5) this.f.toasts.firstChild.remove();
  }

  banner(title, sub = '', kind = '') {
    this._banner?.remove();
    const el = frag(`<div class="banner${kind ? ` ${kind}` : ''}"><div class="t"></div><div class="s"></div><div class="rule"></div></div>`);
    q(el, '.t').textContent = title;
    q(el, '.s').textContent = sub;
    this.el.appendChild(el);
    this._banner = el;
    setTimeout(() => { if (this._banner === el) { el.remove(); this._banner = null; } }, 3500);
  }

  setPrompt(p) {
    if (!p) { cls(this.f.prompt, 'show', false); return; }
    const k = q(this.f.prompt, '.k');
    text(k, 'F');
    text(q(this.f.prompt, '.txt'), p.txt || '');
    text(q(this.f.prompt, '.sub'), p.sub || '');
    css(this.f.prompt, 'opacity', p.disabled ? '0.5' : '');
    cls(this.f.prompt, 'show', true);
  }

  flashHurt() {
    this._hurtT = 0.16;
    cls(this.f.hurt, 'on', true);
  }

  shakeStamina() {
    // Re-adding the class restarts the CSS shake; without the reflow read the
    // browser coalesces remove+add into no change at all.
    this.f.stamina.classList.remove('empty');
    void this.f.stamina.offsetWidth;
    this.f.stamina.classList.add('empty');
    this._lastStaminaEmpty = true;
  }

  /* ---------------------------------------------------------------- tracker -- */

  refreshTracker() {
    // Which quest is tracked is `trackedQuest`'s answer, not a loop of its own: the map draws a
    // pin for the same objective, and two independent "pick the tracked quest" rules is how the
    // pin ends up belonging to a different quest from the line of text above it.
    const pick = trackedQuest(this.game.player?.quests);
    if (!pick) { cls(this.f.tracker, 'hidden', true); this.navTarget = null; return; }
    const stage = pick.def.stages?.[pick.rec.stageIndex];
    cls(this.f.tracker, 'hidden', false);
    text(q(this.f.tracker, 'b'), pick.def.name);
    // Counters are keyed by stage id, matching progression.advanceQuests.
    const goal = stage?.count || 0;
    const have = stage ? (pick.rec.counters?.[stage.id] ?? 0) : 0;
    text(q(this.f.tracker, 'span'), stage
      ? `${stage.desc || ''}${goal > 1 ? ` (${Math.min(have, goal)}/${goal})` : ''}`
      : '');
    this._resolveNav(pick);
  }

  /* ------------------------------------------------------------- navigation -- */

  /**
   * Where the tracked objective is. Resolved here rather than per frame: the answer only
   * changes when the stage, the zone or the world's own progress changes (an opened chest
   * makes the next one the target), and all three arrive as events. What the frame path does
   * with it is arithmetic on two numbers — see `_navTick`.
   */
  _resolveNav(pick = trackedQuest(this.game.player?.quests)) {
    const g = this.game;
    if (!pick || !g.world) { this.navTarget = null; cls(this.f.qnav, 'hidden', true); return; }
    const t = questTarget(pick.def, pick.rec, {
      zoneId: g.zoneId,
      pos: { x: g.me?.x ?? 0, z: g.me?.z ?? 0 },
      // The live lists, so 'done' is real: an opened chest is not a destination.
      pois: g.world.pois,
      gathers: g.world.gathers,
    });
    this.navTarget = t;
    cls(this.f.qnav, 'hidden', !t);
    if (!t) return;
    // A place is the only case with a bearing; the other three are sentences.
    cls(this.f.qnav, 'far', t.kind !== 'place');
    // The sentence itself is `ui/navtext.js`, because the quest panel prints the same answer and
    // the two phrasings had already drifted.
    text(this.f.qwhere, navWhere(t));
    if (t.kind !== 'place') text(this.f.qdist, '');
  }

  /**
   * Distance and bearing. The arrow is relative to the *camera*, not to north: the player reads
   * it as "turn left", and the minimap right above it is the north-up view.
   *
   * Which is exactly why the arrow is aimed every frame while the text below it is written at
   * 6 Hz. A mouse turn changes the arrow's answer without changing anything in the world, so a
   * throttled arrow lags the turn by up to 167 ms and reads as the glyph stuttering after the
   * camera. One atan2 and one CSS variable per frame is cheaper than that.
   */
  _navTick(dt) {
    if (!this.game.player?.quests) return;
    this._navAim(this.navTarget);
    this._navAcc = (this._navAcc || 0) + dt;
    if (this._navAcc < 1 / 6) return;
    this._navAcc = 0;
    // Most of what changes a target arrives as an event, but two things do not announce
    // themselves loudly enough to bet on: a chest opened by someone else in the shard, and a
    // gather node regrowing. Re-resolving every 5 s is a few array scans and removes the class
    // of bug where the arrow keeps pointing at something that is no longer there.
    this._navAge = (this._navAge || 0) + 1 / 6;
    if (this._navAge > 5) { this._navAge = 0; this._resolveNav(); }
    const t = this.navTarget;
    if (!t || t.kind !== 'place') return;
    const g = this.game;
    const dx = t.x - g.me.x, dz = t.z - g.me.z;
    const d = Math.hypot(dx, dz);
    text(this.f.qdist, d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`);
    cls(this.f.qnav, 'arrived', d < 12);
  }

  /**
   * Point the glyph at a place target, in camera space.
   *
   * The camera looks along `(-sin yaw, -cos yaw)`, so straight ahead is world bearing `yaw + π`;
   * the arrow glyph points up, and CSS rotates clockwise, which is the same handedness as
   * bearings measured from +Z toward +X. Hence one subtraction and no minus sign — a target on
   * the camera's right gets a positive rotation.
   */
  _navAim(t) {
    if (!t || t.kind !== 'place') return;
    const g = this.game;
    const rel = Math.atan2(t.x - g.me.x, t.z - g.me.z) - (g.rig?.yaw ?? 0) - Math.PI;
    cssVar(this.f.qarrow, '--rot', `${(rel * 180 / Math.PI).toFixed(1)}deg`);
  }

  /* ------------------------------------------------------------------ buffs -- */

  /**
   * Food buffs, as one chip per buff with a live countdown.
   *
   * Rebuilds the row only when the *set* of buffs changes and writes the seconds
   * text every frame; a five-minute timer that re-creates three DOM nodes sixty
   * times a second is the kind of thing that shows up as jank on a 30 fps machine.
   */
  _buffs(list) {
    // Gear procs share the row with food, so the identity of a chip is `item || tag`,
    // and the stack count is part of it: 余烬裂斩 going from x1 to x2 has to relabel.
    const key = list.map((b) => `${b.item || b.tag || ''}${b.n > 1 ? `x${b.n}` : ''}`).join(',');
    if (key !== this._buffKey) {
      this._buffKey = key;
      this.f.buffs.innerHTML = '';
      this._buffChips = list.map((b) => {
        const el = frag(`<div class="buff"><span class="ico"></span><span class="t"><b></b><small></small></span></div>`);
        const def = b.item ? MATERIALS[b.item] : null;
        q(el, '.ico').textContent = def?.icon || b.icon || '✦';
        q(el, 'b').textContent = (b.name || def?.name || '') + (b.n > 1 ? ` ×${b.n}` : '');
        if (b.kind === 'gear') el.classList.add('gear');
        this.f.buffs.appendChild(el);
        return q(el, 'small');
      });
    }
    const now = performance.now() / 1000;
    for (let i = 0; i < this._buffChips.length; i++) {
      const left = Math.max(0, list[i].endsAt - now);
      // A 六秒 gear buff written as 0:06 reads like a stopwatch; seconds are what the
      // player is actually counting down at that length.
      text(this._buffChips[i], left < 60
        ? `${left.toFixed(left < 10 ? 1 : 0)}s`
        : `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`);
    }
  }

  /* ------------------------------------------------------------------ downed -- */

  /**
   * Write the death panel from state.
   *
   * The panel used to be three fixed strings and two buttons that did the same thing, so it
   * could not answer either of the questions a downed player actually has: *can* I stand up
   * here (do I still have a 提神醒脑的汤?), and where will I wake up if I do not. Both answers
   * come from data the client already holds — the inventory it draws in the bag panel, and the
   * anchors it draws on the map.
   */
  _refreshDowned() {
    const g = this.game;
    const dishes = g.player?.inventory?.reviveDish || 0;
    const dishName = MATERIALS.reviveDish?.name || '复苏道具';
    const zdef = ZONES[g.zoneId];
    const anchor = zdef
      ? nearestAnchor(zdef, g.me?.x || 0, g.me?.z || 0, zoneProgress(g.player?.worldProgress, g.zoneId))
      : null;
    const solo = g.socket?.mode !== 'online';
    const key = `${dishes}|${anchor?.id || ''}|${solo}`;
    if (key === this._downKey) return;
    this._downKey = key;
    text(this.f.downedsub, solo
      ? `使用${dishName}原地站起，或返回锚点重整`
      : `等待队友靠近救援，或自己选一种起身方式`);
    text(this.f.revivebtn, `原地复苏（${dishName} ×${dishes}）`);
    this.f.revivebtn.disabled = dishes < 1;
    this.f.revivebtn.title = dishes < 1 ? `没有${dishName}，可在料理面板制作` : '';
    text(this.f.respawnbtn, anchor ? `返回最近的锚点（${anchorName(anchor)}）` : '返回最近的锚点');
  }

  /**
   * Count the auto-respawn down on screen, in the sim's own units.
   *
   * Read off a timestamp rather than integrated from the frame's `dt`: `dt` is clamped (a long
   * frame must not teleport anyone), so on a slow machine the sum runs slower than the clock and
   * the label sat at 「8 秒后」 for the whole eight seconds before the sim stood the character up
   * — `tools/death-check.mjs` caught it at 3 fps, where 2.3 s of waiting moved the number by
   * 0.35. The instance's timer is wall-clock (`this.now`), so this has to be too.
   */
  _downedTick() {
    this._refreshDowned();
    if (!this._downAt) { text(this.f.downedwait, ''); return; }
    // Inside a live 秘境 run the sim deliberately does *not* stand anyone up (see
    // `zoneInstance.updatePlayer`), so counting down to something that will not happen is the
    // same lie this label was rewritten to stop telling. What is true then is the other line:
    // a teammate, or one of the two buttons above.
    if (this.game.chamber?.state === 'running') {
      text(this.f.downedwait, '挑战进行中，不会自动返回锚点');
      return;
    }
    const left = AUTO_RESPAWN_SEC - (now() - this._downAt);
    text(this.f.downedwait, left > 0.05
      ? `${Math.ceil(left)} 秒后自动返回锚点`
      : '正在返回锚点…');
  }

  /* -------------------------------------------------------------- per frame -- */

  update(dt, st) {
    this._buffs(st.buffs || []);

    // --- party cards -------------------------------------------------------
    const key = st.party.map((p) => p.charId).join(',');
    if (key !== this._cardKey) this._rebuildCards(st.party);
    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i], p = st.party[i];
      if (!p) continue;
      cls(c.root, 'active', p.active);
      cls(c.root, 'dead', p.dead);
      text(c.lv, `Lv.${p.level}`);
      css(c.hpFill, 'width', pct(p.hp, p.maxHp));
      cls(c.hpBar, 'low', p.hp / Math.max(1, p.maxHp) < 0.3);
      css(c.enFill, 'width', pct(p.energy, p.energyMax));
      // 元素战技's cooldown, for this card's character — the snapshot carries every party
      // member's now, so an off-field portrait can say whether its skill is ready. Rounded up,
      // like the action bar's, so «1» never means «already ready».
      cls(c.root, 'cooling', p.skillCd > 0.05);
      if (p.skillCd > 0.05) {
        text(c.cd, `${Math.ceil(p.skillCd)}`);
        cssVar(c.root, '--cd', (p.skillCd / Math.max(0.1, p.skillCdMax)).toFixed(2));
      }
      // Only the active character has a shield, and it is drawn over the HP bar.
      css(c.shield, 'width', p.active ? pct(st.me.shield, p.maxHp) : '0%');
      // 护盾的元素. A crystallize shard is made of whatever the geo hit reacted with, and that
      // decides how much of the next hit it eats (`shieldBreakMul`) — so the bar says which one
      // is on, instead of the single gold `--shield` every shield used to share. Through
      // `cssVar` (which memoises) rather than by writing `background`: the browser normalises a
      // gradient string on the way back in, so `css()`'s "only when it changed" test would never
      // match and every card would be restyled on every frame.
      const shCol = p.active && st.me.shield > 0 && st.me.shieldElement
        ? (ELEMENTS[st.me.shieldElement]?.color ?? null) : null;
      cssVar(c.root, '--shield', shCol === null ? 'var(--shield-gold)' : hexColor(shCol));
      cssVar(c.root, '--shield-dark', shCol === null ? 'var(--shield-gold-dark)'
        : hexColor((shCol >> 1) & 0x7f7f7f));
      // 元素附着 on me, in the element's own colour and glyph — the same reading an enemy's
      // nameplate has always given about *it*. Only on the active card, because the aura is on
      // the body standing on the field and the wire carries one `au` per player, not per
      // character. Until this pip existed the field was drawn nowhere at all: being 湿身 (and
      // therefore one 雷 orb away from 感电) was invisible until the reaction already happened.
      const aur = p.active ? st.me.aura : null;
      const auCol = aur ? (ELEMENTS[aur]?.color ?? null) : null;
      cls(c.aura, 'on', !!auCol);
      if (auCol !== null) {
        cssVar(c.aura, '--au', hexColor(auCol));
        text(c.aura, ELEMENT_GLYPH[aur] || '✦');
        if (c.aura.title !== `元素附着：${ELEMENTS[aur]?.name || aur}`) {
          c.aura.title = `元素附着：${ELEMENTS[aur]?.name || aur}`;
        }
      }
    }

    // --- player line & currency -------------------------------------------
    const pl = st.player || {};
    text(this.f.nick, pl.nickname || '旅行者');
    text(this.f.ar, `AR ${pl.adventureRank ?? 1}`);
    text(this.f.mode, st.mode === 'solo' ? '单机' : '在线');
    text(this.f.mora, num(pl.mora));
    text(this.f.gem, num(pl.primogem));
    text(this.f.ticket, num(pl.wishTicket));
    text(this.f.resin, num(pl.resin));

    // --- status ------------------------------------------------------------
    const lat = st.latency;
    // The tier is named only when it is *not* the one the player chose, i.e. when the
    // governor has stepped down. Otherwise it would be a permanent label restating the
    // settings panel; shown on a drop it explains why the shadows just went away.
    const tier = st.quality && st.quality !== st.qualityAsked ? ` · ${QUALITY_NAME[st.quality] || st.quality}` : '';
    text(this.f.ping, st.stale ? '离线' : `${lat} ms · ${Math.round(st.fps)} fps${tier}`);
    const dot = this.f.pingdot;
    cls(dot, 'off', st.stale);
    cls(dot, 'bad', !st.stale && lat > 180);
    cls(dot, 'mid', !st.stale && lat > 90 && lat <= 180);

    const coldMax = st.zone?.mechanic?.sheerCold ? 100 : 0;
    if (coldMax) {
      css(this.f.cold, 'width', pct(st.me.cold, coldMax));
      css(this.f.frost, 'opacity', String(Math.min(0.9, (st.me.cold / coldMax) * 0.9)));
    } else if (this.f.frost.style.opacity !== '0') {
      css(this.f.frost, 'opacity', '0');
    }

    // --- action bar --------------------------------------------------------
    const def = st.def;
    const elColor = hexColor(ELEMENTS[def.element]?.color);
    this._skill(this.f.skillbtn, {
      glyph: this.f.skillglyph, name: def.skill?.name, color: elColor,
      cd: st.me.skillCd, cdMax: st.me.skillCdMax, ready: st.me.skillCd <= 0,
    });
    this._skill(this.f.burstbtn, {
      glyph: this.f.burstglyph, name: def.burst?.name, color: elColor,
      cd: st.me.burstCd, cdMax: st.me.burstCdMax,
      ready: st.me.burstCd <= 0 && st.me.energy >= st.me.energyMax,
      fill: st.me.energy / Math.max(1, st.me.energyMax),
    });
    text(this.f.skillglyph, ELEMENT_GLYPH[def.element] || '✦');
    text(this.f.burstglyph, ELEMENT_GLYPH[def.element] || '❋');

    // --- stamina wheel -----------------------------------------------------
    const sfill = st.me.stamina / STAMINA.max;
    cssVar(this.f.stamina, '--fill', sfill.toFixed(3));
    cls(this.f.stamina, 'full', sfill > 0.995);
    if (sfill > 0.2 && this._lastStaminaEmpty) {
      this.f.stamina.classList.remove('empty');
      this._lastStaminaEmpty = false;
    }

    // --- reticle -----------------------------------------------------------
    cls(this.f.reticle, 'show', st.aiming || st.me.charging > 0);
    cls(this.f.reticle, 'charged', st.me.charging >= 1);

    // --- chamber timer -----------------------------------------------------
    // Only while the floor is actually running. `zoneInstance` keeps its chamber block
    // after the last enemy dies (state 'cleared' / 'failed') so it can refuse a second
    // settlement, and the snapshot ships it — so the old `state !== 'idle'` test ('idle'
    // is a value the sim never sends) left the chip on screen for the rest of the visit,
    // frozen at "剩余敌人 0" with the finished floor's ley line still named. The result
    // has its own banner; the chip is the live run.
    if (st.chamber && st.chamber.state === 'running') {
      cls(this.f.chamber, 'show', true);
      const left = Math.max(0, st.chamber.timeLeft ?? 0);
      text(q(this.f.chamber, '.clock'), `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`);
      // Which wave, and what the ley line is doing to this fight. Both come off the
      // snapshot rather than off the CHAMBER event, so a player who reloaded mid-run — or
      // joined a shard already fighting — still sees them.
      const c = st.chamber;
      const waveTxt = c.waves > 1 ? ` · 第 ${c.wave}/${c.waves} 波` : '';
      const bodies = c.waveIn > 0 ? `下一波 ${Math.ceil(c.waveIn)}s` : `剩余敌人 ${c.remaining}`;
      text(q(this.f.chamber, '.sub'), `第 ${c.floor} 间${waveTxt} · ${bodies}`);
      // Built once per disorder, not once per frame: `disorderHint` formats a string, and
      // this is the frame path.
      if (c.disorder !== this._disorderId) {
        this._disorderId = c.disorder;
        const dz = disorderById(c.disorder);
        text(q(this.f.chamber, '.dis'), dz ? `${dz.name} · ${disorderHint(dz)}` : '');
      }
      cls(this.f.chamber, 'urgent', left <= 20);
    } else {
      cls(this.f.chamber, 'show', false);
    }

    // --- hurt vignette -----------------------------------------------------
    if (this._hurtT > 0) {
      this._hurtT -= dt;
      if (this._hurtT <= 0) cls(this.f.hurt, 'on', false);
    }
    cls(this.f.downed, 'show', !st.me.alive);
    if (!st.me.alive) this._downedTick();

    // --- quest navigation --------------------------------------------------
    this._navTick(dt);

    // --- minimap -----------------------------------------------------------
    // 12 Hz is plenty; a canvas redraw is the most expensive thing on the HUD.
    this._mapAcc += dt;
    if (this.baked && this._mapAcc > 1 / 12) {
      this._mapAcc = 0;
      const g = this.game;
      drawMinimap(this.minimapCanvas, this.baked, {
        x: st.me.x, z: st.me.z, ry: st.me.ry, range: this.mapRange,
        pois: g.world.pois,
        // The objective, if it is a point in this zone. Off the edge of the disc it becomes an
        // arrow pinned to the rim — a marker that simply vanishes at 90 m is worse than none,
        // because "no marker" then means both "arrived" and "far away".
        quest: this.navTarget?.kind === 'place' && this.navTarget.zone === g.zoneId
          ? { x: this.navTarget.x, z: this.navTarget.z } : null,
        enemies: [...g.actors.enemies.values()].filter((e) => e.alive)
          .map((e) => ({ x: e.x, z: e.z, boss: !!e.actor.def.boss })),
        players: [...g.actors.players.values()].map((p) => ({ x: p.x, z: p.z })),
      });
    }
  }

  _skill(btn, o) {
    const frac = o.cdMax > 0 ? Math.max(0, Math.min(1, o.cd / o.cdMax)) : 0;
    cssVar(btn, '--cd', frac.toFixed(3));
    cssVar(btn, '--el', o.color);
    text(q(btn, '.cdnum'), o.cd > 0.05 ? (o.cd >= 10 ? Math.ceil(o.cd) : o.cd.toFixed(1)) : '');
    cls(btn, 'ready', o.ready);
    if (o.fill != null) {
      const ring = q(btn, '.ring');
      cssVar(ring, '--fill', Math.min(1, o.fill).toFixed(3));
      cls(btn, 'charged', o.fill >= 1);
    }
    if (btn.title !== (o.name || '')) btn.title = o.name || '';
  }

  _rebuildCards(party) {
    this._cardKey = party.map((p) => p.charId).join(',');
    this.f.party.textContent = '';
    this.cards = party.map((p, i) => {
      const def = CHARACTERS[p.charId];
      const root = frag(`
        <div class="pcard" data-slot="${i}">
          <div class="av"><span class="g"></span><span class="cd"></span><span class="lv">Lv.1</span><i class="aura"></i></div>
          <div class="info">
            <div class="nm"></div>
            <div class="bar hp"><i></i><i class="shield"></i></div>
            <div class="bar en"><i></i></div>
          </div>
          <span class="key">${i + 1}</span>
        </div>`);
      root.style.setProperty('--el', hexColor(ELEMENTS[p.element]?.color));
      q(root, '.g').textContent = ELEMENT_GLYPH[p.element] || '?';
      q(root, '.nm').textContent = def?.name || p.charId;
      this.f.party.appendChild(root);
      const hpBar = q(root, '.bar.hp');
      return {
        root, lv: q(root, '.lv'), hpBar,
        hpFill: hpBar.children[0], shield: hpBar.children[1],
        enFill: q(root, '.bar.en > i'), cd: q(root, '.av .cd'),
        aura: q(root, '.av .aura'),
      };
    });
  }

  destroy() { this.el.remove(); }
}
