// The quest completion card: the screen a story chapter ends on.
//
// Why this file exists. Finishing 风起之时 used to produce a three-word banner, a chime and two
// toasts — and the quest's `outro`, the line the giver says when it is over, was authored for
// ten quests and printed by nobody. The rewards were worse than unprinted: 御风之刃 (a 4★ sword),
// 大英雄的经验 ×2 and 纠缠之缘 ×2 were all granted silently, because the toasts only covered
// mora and primogems. And the *next* chapter, which the server activates in the same breath,
// was never announced at all.
//
// So this card says all four things in one place: which chapter closed, what its giver said,
// everything it paid (from `rewardList`, the same list the quest panel prints), and what the
// story asks for next — with the first objective spelled out, because that is the sentence the
// tracker is about to start counting metres to.
//
// It does **not** pause the game and it does not sit under a scrim. A completion lands the
// instant the last enemy dies, which in multiplayer is a moment when something else is usually
// still swinging at you; a modal that eats the keyboard there would be a way to die to your own
// reward screen. It is a centred card with a 继续 button, it dismisses on click, on Escape (via
// the UI's key handler) or by itself after 14 seconds, and the world keeps running behind it.

import { frag, q, h, on, text, num } from './dom.js';
import { QUESTS } from '@teyvat/shared/data/quests.js';
import { rewardList } from '@teyvat/shared/data/items.js';

const LINGER_MS = 14000;

export class QuestEnd {
  constructor(root, game) {
    this.game = game;
    this.root = root;
    this.el = null;
    this._timer = null;
    this._offs = [];
  }

  /** True while a card is on screen — the UI asks before letting Escape open the pause menu. */
  get open() { return !!this.el; }

  /**
   * Show the card for one completion update.
   *
   * `u` is the delta `progression.advanceQuests` pushed: `{ questId, name, chapter, outro,
   * rewards, next: { id, name, chapter, intro, stageDesc } }`. Everything is read off the
   * update rather than looked up again, except the fallback to `QUESTS` for a build where the
   * server is older than the client — one of the two has the copy, and a card with no text is
   * the worst possible outcome here.
   */
  show(u) {
    if (!u) return;
    const def = QUESTS[u.questId || u.id] || {};
    const chapter = u.chapter || def.chapter || '';
    const name = u.name || def.name || '';
    const outro = u.outro || def.outro || '';
    const rewards = u.rewards || def.rewards || {};
    const next = u.next || null;

    this.close();
    const el = frag(`<div class="questend">
      <div class="qe-card">
        <div class="qe-glow"></div>
        <header>
          <span class="qe-tag">任务完成</span>
          <h3><span class="qe-chapter"></span><span class="qe-name"></span></h3>
        </header>
        <p class="qe-outro"></p>
        <div class="qe-rewards"><span class="qe-label">获得奖励</span><div class="qe-grid" data-f="rewards"></div></div>
        <div class="qe-next hidden" data-f="next">
          <span class="qe-label">接下来</span>
          <b data-f="nextname"></b>
          <p data-f="nextintro"></p>
          <p class="qe-goal"><span>目标</span><em data-f="nextgoal"></em></p>
        </div>
        <footer><button class="btn primary small" data-f="ok">继续</button></footer>
      </div>
    </div>`);

    text(q(el, '.qe-chapter'), chapter ? `${chapter} · ` : '');
    text(q(el, '.qe-name'), name);
    text(q(el, '.qe-outro'), outro);

    // One reward row per thing the quest paid, named and counted. `rewardList` is shared with
    // the quest panel so the card cannot invent a different set — and an unnamed id is a gate
    // failure in `questGateReport()`, not a `windriderEdge ×1` on a player's screen.
    const grid = q(el, '[data-f="rewards"]');
    for (const r of rewardList(rewards)) {
      const row = h('div', 'qe-item');
      row.appendChild(h('i', 'qe-ico', r.icon));
      row.appendChild(h('span', 'qe-nm', r.name));
      row.appendChild(h('b', 'qe-n', `×${num(r.n)}`));
      grid.appendChild(row);
    }

    if (next?.name) {
      q(el, '[data-f="next"]').classList.remove('hidden');
      text(q(el, '[data-f="nextname"]'), `${next.chapter ? `${next.chapter} · ` : ''}${next.name}`);
      text(q(el, '[data-f="nextintro"]'), next.intro || '');
      text(q(el, '[data-f="nextgoal"]'), next.stageDesc || '');
    }

    const ok = q(el, '[data-f="ok"]');
    this._offs.push(on(ok, 'click', () => this.close()));
    // The whole card is a dismiss target as well: a player who has read it clicks anywhere, and
    // the click must not fall through to the world and set a walk order.
    this._offs.push(on(el, 'click', (e) => { e.stopPropagation(); this.close(); }));

    this.root.appendChild(el);
    this.el = el;
    this._timer = setTimeout(() => this.close(), LINGER_MS);
    return el;
  }

  close() {
    for (const off of this._offs) off();
    this._offs = [];
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this.el) { this.el.remove(); this.el = null; return true; }
    return false;
  }

  destroy() { this.close(); }
}
