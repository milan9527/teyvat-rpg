// Root UI controller. Owns the HUD and the panel stack, and is the only place
// that knows about both the game and the DOM.
//
// The game never touches the DOM and the UI never touches the scene graph; they
// meet here, through `game.on(...)` events one way and public game methods the
// other. That boundary is what makes it possible to reason about a 60 fps render
// loop and a DOM-mutating panel at the same time.

import { frag, q, h, on, text, cls } from './dom.js';
import { Hud } from './hud.js';
import { Panels } from './panels.js';
import { QuestEnd } from './questend.js';

export class Ui {
  /** `boot` is the `#boot` overlay, reused for zone transitions. */
  constructor(root, game, boot = document.getElementById('boot')) {
    this.game = game;
    this.root = root;
    this.boot = boot;
    this.bootFill = boot && q(boot, '#boot-fill');
    this.bootMsg = boot && q(boot, '#boot-msg');
    this.bootTitle = boot && q(boot, '.game-title');
    this.bootSub = boot && q(boot, '.game-sub');

    this.hud = new Hud(root, game);
    this.panels = new Panels(root, game);
    this.questEnd = new QuestEnd(root, game);
    this._offs = [];
    this._bind();
    if (game.world?.zone) this.hud.setZone(game.world.zone);
  }

  _bind() {
    const g = this.game;

    // Escape and Enter belong to the UI, not the game. This listener is on the
    // capture phase and the input layer's is on the bubble phase, so stopping
    // propagation here is what keeps the game from *also* acting on the key —
    // without it, Escape closes a panel and the game's own `settings` binding
    // immediately reopens one.
    this._offs.push(on(window, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (this.hud.chatOpen) { this.hud.closeChat(); return; }
        // The completion card is dismissible but not a panel: it does not pause the game and it
        // is not on the panel stack, so Escape has to clear it before falling through to the
        // pause menu — otherwise the first Escape opens 设置 *behind* a card that is still up.
        if (this.questEnd.close()) return;
        if (this.panels.escape()) return;
        this.panels.open('settings');   // where "log out" lives
        return;
      }
      if (this.hud.chatOpen) { e.stopPropagation(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.hud.openChat();
      }
    }, true));

    g.on('openChat', () => this.hud.openChat());
    // A story chapter ends on a card, not a three-word banner: what the giver said, everything
    // the quest paid, and the objective the next one starts on.
    g.on('questComplete', (u) => this.questEnd.show(u));
    g.on('loading', (d) => this._loading(d));
    g.on('fatal', (d) => this._fatal(d));
    g.on('mark', (d) => this.hud.chat({
      channel: 'party',
      body: `${d.nickname || '队友'} 标记了位置 (${Math.round(d.x)}, ${Math.round(d.z)})`,
    }));
    g.on('reaction', (d) => { if (d.name) this.hud.toast(d.name, 'gold'); });
    g.on('cooldownDenied', () => this.hud.toast('技能还在冷却', 'bad'));
    g.on('rooted', () => this.hud.toast('无法移动', 'bad'));
    g.on('partyRoster', ({ members }) => {
      if (members?.length > 1) {
        this.hud.chat({ channel: 'party', body: `小队成员：${members.map((m) => m.nickname).join('、')}` });
      }
    });
  }

  /** Called once per frame by the game loop. */
  update(dt) {
    this.hud.update(dt, this.game.hudState());
  }

  /* --------------------------------------------------------------- loading -- */

  // Zone transitions reuse the boot overlay: same painted sky, same bar, so the
  // transition looks authored instead of like a second loading screen.
  _loading({ on: show, zone, progress, message }) {
    if (!this.boot) return;
    if (show === false) {
      cls(this.boot, 'hidden', true);
      return;
    }
    cls(this.boot, 'hidden', false);
    if (zone) {
      text(this.bootTitle, zone.name);
      text(this.bootSub, (zone.subtitle || '').toUpperCase());
      this.hud.setZone(zone);
    }
    if (progress != null && this.bootFill) {
      this.bootFill.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
    }
    if (message) text(this.bootMsg, message);
  }

  _fatal(d) {
    const box = frag(`<div class="scrim"><div class="panel narrow">
      <header><h2>连接中断</h2></header>
      <div class="body"><div class="col main"><p></p></div></div>
      <footer><div class="spacer"></div></footer>
    </div></div>`);
    q(box, 'p').textContent = d?.reason === 'protocol'
      ? '客户端版本与服务器不一致，请刷新页面。'
      : d?.reason === 'auth'
        ? '登录状态失效，请重新登录。'
        : '与服务器的连接已断开，无法继续。';
    const again = h('button', 'btn primary small', '重新载入');
    again.onclick = () => location.reload();
    q(box, 'footer').appendChild(again);
    this.root.appendChild(box);
  }

  destroy() {
    for (const off of this._offs) off();
    this._offs = [];
    this.questEnd.destroy();
    this.panels.destroy();
    this.hud.destroy();
  }
}
