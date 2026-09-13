// The 新手引导 runtime: holds which steps the player has finished, decides what the HUD
// card shows, and persists progress.
//
// The one rule that shaped this file: **a step completes when the action happens, not when
// the key is pressed.** So nothing here reads the keyboard. `mark(id)` is called from the
// code path that actually did the thing — `me.on('skillCast')` (which the LocalPlayer only
// emits after the cooldown and energy checks passed), `panels.open()`, the branch of
// `_leftClick` that really issued a walk order. Pressing E during a cooldown teaches the
// player nothing about E, and a guide that advances anyway is lying to them about why the
// screen did not change.
//
// The two continuous steps (walking, turning the camera) cannot be one event, so they are
// *sampled*: distance travelled and radians of camera rotation are accumulated per frame and
// the step marks itself once past a threshold big enough that it can't be satisfied by a
// stray twitch. `orbit()` is fed the rotation the rig actually applied from a drag, not
// `rig.yaw` — the rig also turns itself when locking onto an enemy, and crediting the player
// for that would tick 「转一圈看看」 off without them ever touching the mouse.
//
// Persistence is `players.settings.tutorial`, merged server-side by /api/player/save, so
// progress survives a reload and follows the account across devices. Writes are debounced
// because the first minute of a session marks several steps in a few seconds.

import { TUTORIAL_IDS, tutorialView } from '@teyvat/shared/data/tutorial.js';
import { api } from '../net/api.js';

/** How much walking counts as "you know how to walk". About four body lengths. */
const MOVE_DISTANCE = 4;
/** Radians of dragged camera rotation that count as "you know how to look around". */
const LOOK_RADIANS = 0.9;
const SAVE_DEBOUNCE = 600;

export class Tutorial {
  /** @param {{ emit: Function, settings: Object }} game */
  constructor(game) {
    this.game = game;
    this.done = new Set();
    this.skipped = false;
    this._moved = 0;
    this._turned = 0;
    this._x = null;
    this._z = null;
    this._saveTimer = 0;
    this._dirty = false;
  }

  /**
   * Adopt the stored progress (called once the player document has loaded). Unknown ids are
   * dropped by `tutorialView`, so a step renamed in a later build cannot leave an account
   * stuck at 12/11.
   */
  sync(state = {}) {
    const v = tutorialView(state);
    this.done = new Set(v.done);
    this.skipped = v.skipped;
    this.publish();
    return v;
  }

  view() {
    return tutorialView({ done: [...this.done], skipped: this.skipped });
  }

  /** Tell the HUD what to draw. The card is the only consumer; it may show nothing. */
  publish() {
    this.game.emit('tutorial', this.view());
  }

  /**
   * Record a completed action. Returns true only when this call changed something, so
   * callers on hot paths (every swing, every frame) cost one Set lookup and nothing else.
   */
  mark(id) {
    if (!TUTORIAL_IDS.includes(id)) {
      console.warn(`[tutorial] unknown step "${id}"`);
      return false;
    }
    if (this.skipped || this.done.has(id)) return false;
    const wasShowing = this.view().step;
    this.done.add(id);
    this._persist();
    this.publish();
    // Only the step the player was looking at deserves a sound; the other ten get marked
    // incidentally (you walk before the guide asks you to) and a chime for each would be
    // a slot machine.
    if (wasShowing && wasShowing.id === id) {
      const v = this.view();
      this.game.audio?.sfx(v.complete ? 'unlock' : 'click');
      if (v.complete) this.game.banner?.('新手引导完成', '随时可在设置里重看操作说明');
    }
    return true;
  }

  /** 跳过: stop showing the card, remember that the player asked. */
  skip() {
    if (this.skipped) return false;
    this.skipped = true;
    this._persist();
    this.publish();
    return true;
  }

  /** 重新引导 from the settings panel: forget everything and start over. */
  reset() {
    this.done = new Set();
    this.skipped = false;
    this._moved = 0;
    this._turned = 0;
    this._persist();
    this.publish();
    return true;
  }

  /* ------------------------------------------------------- continuous steps -- */

  /** Per-frame position sample. `x`/`z` are the local player's feet. */
  sample(x, z) {
    if (this.done.has('move')) { this._x = x; this._z = z; return; }
    if (this._x !== null) {
      const d = Math.hypot(x - this._x, z - this._z);
      // A teleport is not walking. Anything larger than a sprint stride in one frame is a
      // zone change or a waypoint jump, and counting it would complete the step before the
      // player has pressed a key.
      if (d < 2) this._moved += d;
      if (this._moved >= MOVE_DISTANCE) this.mark('move');
    }
    this._x = x;
    this._z = z;
  }

  /** Radians of camera rotation that a mouse drag just caused. */
  orbit(rad) {
    if (this.done.has('look')) return;
    this._turned += Math.abs(rad);
    if (this._turned >= LOOK_RADIANS) this.mark('look');
  }

  /* -------------------------------------------------------------- persistence -- */

  _persist() {
    this.game.settings.tutorial = { done: [...this.done], skipped: this.skipped };
    this._dirty = true;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE);
  }

  /**
   * Write now. `Game.persist` sends the whole settings object as well (on a 20 s timer, on
   * tab hide and on unload), so this is not the only route to the database — but it is the
   * only one that runs within a second of the step being finished, which is what makes a
   * reload straight after 「点哪走哪」 come back with the step still ticked off.
   *
   * Only `tutorial` is sent, never the whole settings object: this fires while the player may
   * be mid-drag on a volume slider, and posting a snapshot of the settings from here would be
   * a second writer racing the panel's own debounced save. The server merges per key.
   */
  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    clearTimeout(this._saveTimer);
    api.save({ settings: { tutorial: this.game.settings.tutorial } })
      .catch((e) => console.warn('[tutorial] save failed', e));
  }
}
