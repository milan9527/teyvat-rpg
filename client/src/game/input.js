// Keyboard + mouse input.
//
// Two things make this more than a keydown map:
//
//  1. The game is playable entirely with the mouse (click to move, click to
//     attack), so the pointer has to be classified per press: a press that turns
//     into a drag orbits the camera, a press that releases quickly is a click on
//     the world. Deciding that on *release* rather than on press is what stops
//     every camera orbit from also issuing a move order.
//
//  2. Held mouse buttons drive continuous actions (hold-to-charge a bow, hold
//     left button to keep attacking), so we track button state, not just events.
//
// The module owns no game state; it publishes intents and lets the controller
// decide what they mean.

const DRAG_THRESHOLD = 5;       // px before a press counts as a camera drag
const CLICK_MAX_MS = 320;       // press longer than this is a hold, not a click
const DBL_MS = 280;

export const KEYMAP = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  interact: ['KeyF'],
  skill: ['KeyE'],
  burst: ['KeyQ'],
  dodge: ['KeyC'],
  aim: ['KeyR'],
  char1: ['Digit1'],
  char2: ['Digit2'],
  char3: ['Digit3'],
  char4: ['Digit4'],
  map: ['KeyM', 'Tab'],
  inventory: ['KeyB'],
  character: ['KeyK'],
  quests: ['KeyJ'],
  wish: ['KeyP'],
  party: ['KeyO'],
  cook: ['KeyL'],
  shop: ['KeyN'],
  mail: ['KeyI'],
  social: ['KeyU'],
  achievements: ['KeyH'],
  expedition: ['KeyG'],
  chat: ['Enter', 'NumpadEnter'],
  emote: ['KeyV'],
  sit: ['KeyX'],
  settings: ['Escape'],
};

/**
 * What each action *is*, for the 操作 reference in the settings panel.
 *
 * It lives here, next to `KEYMAP`, because the reference used to be a single hand-written
 * line of prose in panels.js — and prose in another file cannot be kept honest. That line had
 * drifted (it promised nothing about the mouse, which is the primary control scheme) and
 * nothing could have noticed. Keyed by action, so `tools/tutorial-check.mjs` can require the
 * two objects to have exactly the same keys: a new binding with no description fails, and a
 * description for an action nobody can trigger fails too.
 */
export const ACTION_INFO = {
  forward:      { group: '移动', what: '前进（推向陡坡即开始攀爬，消耗体力）' },
  back:         { group: '移动', what: '后退' },
  left:         { group: '移动', what: '左移' },
  right:        { group: '移动', what: '右移' },
  jump:         { group: '移动', what: '跳跃 / 攀爬时向上' },
  sprint:       { group: '移动', what: '冲刺（消耗体力）' },
  dodge:        { group: '移动', what: '闪避翻滚（消耗体力）' },
  sit:          { group: '移动', what: '坐下 / 起身（移动或跳跃自动起身）' },
  skill:        { group: '战斗', what: '元素战技' },
  burst:        { group: '战斗', what: '元素爆发（需要元素能量）' },
  aim:          { group: '战斗', what: '瞄准模式（弓箭精准射击）' },
  char1:        { group: '战斗', what: '切换到队伍第 1 位' },
  char2:        { group: '战斗', what: '切换到队伍第 2 位' },
  char3:        { group: '战斗', what: '切换到队伍第 3 位' },
  char4:        { group: '战斗', what: '切换到队伍第 4 位' },
  interact:     { group: '战斗', what: '与最近的宝箱 / 矿石 / NPC 交互' },
  map:          { group: '界面', what: '大地图与传送' },
  inventory:    { group: '界面', what: '背包' },
  character:    { group: '界面', what: '角色（升级、天赋、武器、圣遗物）' },
  quests:       { group: '界面', what: '任务' },
  wish:         { group: '界面', what: '祈愿' },
  party:        { group: '界面', what: '队伍编成' },
  cook:         { group: '界面', what: '料理' },
  shop:         { group: '界面', what: '商店' },
  mail:         { group: '界面', what: '邮件' },
  social:       { group: '界面', what: '好友与多人组队' },
  achievements: { group: '界面', what: '成就' },
  expedition:   { group: '界面', what: '探索派遣（派角色出去采集，按小时结算）' },
  chat:         { group: '界面', what: '聊天' },
  emote:        { group: '界面', what: '挥手表情' },
  settings:     { group: '界面', what: '设置 / 关闭当前界面' },
};

/**
 * 界面 actions that are *not* a panel of their own name: chat opens the chat bar, emote plays a
 * wave, and 设置 is the one panel opened by Escape — which the UI consumes before the input
 * layer ever sees it, because Escape also has to close whatever is on top.
 */
const NON_PANEL_UI = new Set(['chat', 'emote', 'settings']);

/**
 * Actions whose whole job is to open the panel of the same name.
 *
 * `game.js` loops over this instead of repeating `if (justPressed('mail')) emit(…)` eleven
 * times. That list was a fourth place a new panel had to be registered — after `KEYMAP`,
 * `ACTION_INFO` and the panel's own title — and the one place where forgetting produces a key
 * the 操作 reference advertises and nothing performs. Derived from `ACTION_INFO`, so a 界面
 * binding is dispatched by virtue of being described; `tools/tutorial-check.mjs` requires every
 * name here to be a real binding, and `tools/expedition-ui.mjs` presses G to prove the loop
 * reaches a panel that did not exist when it was written.
 */
export const PANEL_ACTIONS = Object.keys(ACTION_INFO)
  .filter((a) => ACTION_INFO[a].group === '界面' && !NON_PANEL_UI.has(a));

/**
 * The mouse half of the scheme, which no keymap can express — these are gestures, and their
 * meanings are decided in `game.js:_leftClick` / `_handleMouse` rather than by a key code.
 * Listed with the same shape as the derived key rows so the panel renders one table.
 */
export const MOUSE_CONTROLS = [
  // 双击 used to say 「跑过去」, which was true of a single click as well: a click order already
  // runs (`wish` reaches 1 and the cap is RUN), so the row promised a difference that did not
  // exist. It does now — a double click sprints, out of the same stamina bar Shift spends — and
  // it also drops a party ping, which the row never mentioned. See tools/mouse-check.mjs.
  { keys: ['左键点地面'], what: '走到那里；双击是冲刺过去，并给队友标记该点' },
  { keys: ['左键点敌人'], what: '锁定并靠近攻击，目标死亡前持续攻击' },
  { keys: ['按住左键'], what: '蓄力重击，松手放出' },
  { keys: ['左键点宝箱/NPC'], what: '走过去并交互（点身上就行，不必点脚下）' },
  { keys: ['按住右键拖动'], what: '旋转镜头（也可用中键）' },
  { keys: ['右键单击'], what: '取消锁定、停下' },
  { keys: ['滚轮'], what: '拉近 / 拉远镜头' },
  { keys: ['点头像/技能图标'], what: '切换角色、放战技与爆发' },
];

/** `KeyboardEvent.code` → what is printed on the key. */
export function keyGlyph(code) {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return { Up: '↑', Down: '↓', Left: '←', Right: '→' }[code.slice(5)] || code;
  if (code === 'Space') return '空格';
  if (code === 'Escape') return 'Esc';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'NumpadEnter') return 'Enter';
  return code;
}

/**
 * 「按 <kbd>E</kbd> 释放元素战技」, with the key looked up rather than typed.
 *
 * Every sentence in the UI that tells the player to press something goes through here, and
 * `tools/death-check.mjs` forbids the literal form outside this file. The reason is a line that
 * shipped for months: the death banner said 「按 R 复活」 while `KEYMAP.aim` is `KeyR` — R has
 * never revived anyone. A hand-typed key is a claim about a table in another file, and nothing
 * can keep it honest; the same drift also had a boot tip sending players to Tab (the map) to
 * find the friend list. `kbd` off by default so it is safe in `textContent`.
 */
export function keyHint(action, what, { kbd = false } = {}) {
  const code = KEYMAP[action]?.[0];
  const glyph = code ? keyGlyph(code) : '';
  if (!glyph) return what;
  const key = kbd ? `<kbd>${glyph}</kbd>` : glyph;
  // Shift/空格 are held, not tapped, and the difference matters for a sprint.
  const verb = glyph === 'Shift' ? '按住' : '按';
  return `${verb} ${key} ${what}`;
}

/**
 * The whole control scheme, grouped, ready to render. Duplicate glyphs are collapsed
 * (ShiftLeft/ShiftRight are one key to a player), and the mouse is a group like any other so
 * it cannot be forgotten again.
 */
export function controlGroups() {
  const groups = new Map();
  for (const [action, codes] of Object.entries(KEYMAP)) {
    const info = ACTION_INFO[action];
    if (!info) continue;
    if (!groups.has(info.group)) groups.set(info.group, []);
    groups.get(info.group).push({ keys: [...new Set(codes.map(keyGlyph))], what: info.what });
  }
  const out = [...groups].map(([group, rows]) => ({ group, rows }));
  out.push({ group: '鼠标', rows: MOUSE_CONTROLS });
  return out;
}

/** Reverse index: code → action name. */
const CODE_TO_ACTION = {};
for (const [action, codes] of Object.entries(KEYMAP)) {
  for (const c of codes) CODE_TO_ACTION[c] = action;
}

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.down = new Set();          // action names currently held
    this.pressed = new Set();       // actions pressed since last endFrame()
    this.released = new Set();

    // Pointer
    this.mouse = { x: 0, y: 0, ndcX: 0, ndcY: 0 };
    this.buttons = new Set();       // 0 left, 1 middle, 2 right
    this.wheel = 0;
    this.dragX = 0;
    this.dragY = 0;
    this.leftHeldMs = 0;
    this.rightHeldMs = 0;

    // Consumed by the controller each frame.
    this.clicks = [];               // { button, ndcX, ndcY, x, y, double, shift }
    this.enabled = true;            // false while a modal panel has focus

    this._press = new Map();        // button → { t, x, y, dragged }
    this._lastClickAt = 0;
    this._lastClickBtn = -1;
    this._listeners = [];
    this._bind();
  }

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _bind() {
    // --- keyboard ---------------------------------------------------------
    this._on(window, 'keydown', (e) => {
      // Typing in the chat bar or a panel field must never move the character.
      const el = document.activeElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      const action = CODE_TO_ACTION[e.code];
      if (typing) {
        // Escape and Enter still need to reach the UI while typing.
        if (action === 'settings' || action === 'chat') this.pressed.add(action);
        return;
      }
      // Tab would move focus out of the canvas; the map binding owns it.
      if (e.code === 'Tab') e.preventDefault();
      // Space scrolls the page in some embeddings.
      if (e.code === 'Space') e.preventDefault();
      if (!action) return;
      if (!e.repeat) this.pressed.add(action);
      this.down.add(action);
    });

    this._on(window, 'keyup', (e) => {
      const action = CODE_TO_ACTION[e.code];
      if (!action) return;
      this.down.delete(action);
      this.released.add(action);
    });

    // Losing focus mid-run leaves the key latched and the character sprints
    // into the horizon; drop everything instead.
    this._on(window, 'blur', () => {
      for (const a of this.down) this.released.add(a);
      this.down.clear();
      this.buttons.clear();
      this._press.clear();
    });

    // --- pointer ----------------------------------------------------------
    const setMouse = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
      this.mouse.ndcX = (this.mouse.x / r.width) * 2 - 1;
      this.mouse.ndcY = -(this.mouse.y / r.height) * 2 + 1;
    };

    this._on(this.canvas, 'pointerdown', (e) => {
      if (!this.enabled) return;
      setMouse(e);
      this.canvas.setPointerCapture?.(e.pointerId);
      this.buttons.add(e.button);
      this._press.set(e.button, {
        t: performance.now(), x: e.clientX, y: e.clientY, dragged: false, pid: e.pointerId,
      });
      if (e.button === 1) e.preventDefault();
    });

    this._on(window, 'pointermove', (e) => {
      setMouse(e);
      if (!this.enabled) return;
      for (const [btn, p] of this._press) {
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        if (!p.dragged && Math.hypot(dx, dy) > DRAG_THRESHOLD) p.dragged = true;
        if (p.dragged && (btn === 2 || btn === 1)) {
          // Only the right/middle buttons orbit — a left drag is a steering
          // gesture handled by the controller, and orbiting on it would fight
          // click-to-move.
          this.dragX += e.movementX || (e.clientX - p.x);
          this.dragY += e.movementY || (e.clientY - p.y);
        }
        p.x = e.clientX;
        p.y = e.clientY;
      }
    });

    this._on(window, 'pointerup', (e) => {
      const p = this._press.get(e.button);
      this._press.delete(e.button);
      this.buttons.delete(e.button);
      if (!this.enabled || !p) return;
      const heldMs = performance.now() - p.t;
      if (p.dragged || heldMs > CLICK_MAX_MS) return;   // drag or hold, not a click
      const now = performance.now();
      const double = this._lastClickBtn === e.button && now - this._lastClickAt < DBL_MS;
      this._lastClickAt = now;
      this._lastClickBtn = e.button;
      this.clicks.push({
        button: e.button,
        ndcX: this.mouse.ndcX, ndcY: this.mouse.ndcY,
        x: this.mouse.x, y: this.mouse.y,
        double, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey,
      });
    });

    this._on(this.canvas, 'wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      // Normalise across deltaMode: line-based wheels report ~3, pixel ~100.
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      this.wheel += (e.deltaY * k) / 100;
    }, { passive: false });

    // The right button is the camera; its context menu is never wanted.
    this._on(this.canvas, 'contextmenu', (e) => e.preventDefault());
  }

  /* -------------------------------------------------------------- queries -- */

  isDown(action) { return this.down.has(action); }
  justPressed(action) { return this.pressed.has(action); }
  justReleased(action) { return this.released.has(action); }
  get leftDown() { return this.buttons.has(0); }
  get rightDown() { return this.buttons.has(2); }

  /** WASD as a normalised 2-vector in camera space (x right, y forward). */
  moveAxis() {
    let x = 0, y = 0;
    if (this.isDown('forward')) y += 1;
    if (this.isDown('back')) y -= 1;
    if (this.isDown('right')) x += 1;
    if (this.isDown('left')) x -= 1;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    return { x, y, len: Math.min(1, l) };
  }

  get hasKeyboardMove() {
    return this.isDown('forward') || this.isDown('back') || this.isDown('left') || this.isDown('right');
  }

  /** Camera-orbit delta accumulated this frame, then cleared. */
  takeDrag() {
    const d = { x: this.dragX, y: this.dragY };
    this.dragX = 0; this.dragY = 0;
    return d;
  }

  takeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  takeClicks() {
    const c = this.clicks;
    this.clicks = [];
    return c;
  }

  update(dt) {
    this.leftHeldMs = this.buttons.has(0) ? this.leftHeldMs + dt * 1000 : 0;
    this.rightHeldMs = this.buttons.has(2) ? this.rightHeldMs + dt * 1000 : 0;
  }

  /** Must be called at the end of every frame. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
  }

  /** Suppress world input (a modal is open) without losing key-up events. */
  setEnabled(v) {
    if (!v) {
      this.buttons.clear();
      this._press.clear();
      this.clicks.length = 0;
      // Held movement keys are dropped so the character stops when a panel opens.
      for (const a of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) this.down.delete(a);
    }
    this.enabled = v;
  }

  dispose() {
    for (const [t, ty, fn, o] of this._listeners) t.removeEventListener(ty, fn, o);
    this._listeners.length = 0;
  }
}
