// 新手引导: the first ten minutes of the game, as a list of things the player has to
// actually do.
//
// Why this exists: every control in this game was reachable and none of it was *findable*.
// The only place that named a key was one line of prose at the bottom of the settings panel
// («键位：WASD 移动 / 空格跳跃 / …»), which a first-time player reaches by pressing Escape —
// a key that line is itself trying to teach. Worse, it never mentioned the mouse at all,
// even though the game is playable entirely with it: click the ground to walk, click an
// enemy to attack. A feature nobody can find is indistinguishable from a feature nobody
// built.
//
// Two decisions that shape the file:
//
//  * **A step is completed by doing the thing, never by clicking 「下一步」.** Each `id` is
//    also the name of a signal the client raises from the code path that *performed* the
//    action (`swing`, `skillCast`, an actual panel open) — not from the keypress that asked
//    for it. Pressing E on cooldown does not teach you that E works, because it did not.
//  * **The order is the order a player needs them in.** Move before look, look before
//    click-to-move, attack before 战技 before 爆发 (which needs energy, which needs the
//    first two). The list is walked front to back and the first unfinished step is the one
//    on screen, so it is impossible to be shown step 7 while step 2 is still a mystery.
//
// Progress lives in `players.settings.tutorial` (a JSONB column that already existed, so
// this needed no migration): `{ done: [id…], skipped: bool }`.

/**
 * The steps, in order. `keys` and `mouse` are the glyphs the HUD card prints; a step with
 * neither would be unteachable, which `tutorial-check` treats as a defect.
 */
export const TUTORIAL_STEPS = [
  {
    id: 'move',
    title: '先走两步',
    hint: 'WASD 移动，镜头会跟着你。走上坡、跳下坎都不用切换模式。',
    keys: ['W', 'A', 'S', 'D'],
  },
  {
    id: 'look',
    title: '转一圈看看',
    hint: '按住鼠标拖动转视角，滚轮拉远拉近。视角朝哪，攻击就朝哪。',
    mouse: '按住拖动',
  },
  {
    id: 'clickMove',
    title: '点哪走哪',
    hint: '左键单击地面，角色自己走过去；双击是跑过去。整局游戏都可以只用鼠标玩。',
    mouse: '左键点地面',
  },
  {
    id: 'attack',
    title: '打一下试试',
    hint: '左键点敌人就会靠上去普攻，连点接连段；按住左键是蓄力重击。',
    mouse: '左键点敌人',
  },
  {
    id: 'skill',
    title: '元素战技',
    hint: 'E 释放战技，这是元素附着的主要来源，有冷却。',
    keys: ['E'],
  },
  {
    id: 'switch',
    title: '换人打反应',
    hint: '1-4 或点左上角头像换人。两种元素叠在同一个敌人身上会触发反应，伤害比硬砍高得多。',
    keys: ['1', '2', '3', '4'],
    mouse: '点头像',
  },
  {
    id: 'dash',
    title: '冲刺闪避',
    hint: 'Shift 冲刺、C 闪避，都吃体力；体力空了要等它回。',
    keys: ['Shift', 'C'],
  },
  {
    id: 'burst',
    title: '元素爆发',
    hint: '打怪攒元素能量，攒满按 Q。一队四个人的爆发轮着放，是战斗的节奏。',
    keys: ['Q'],
  },
  {
    id: 'interact',
    title: '伸手拿东西',
    hint: '靠近宝箱、矿石、NPC 时按 F，或者直接左键点它。矿石是武器的经验。',
    keys: ['F'],
    mouse: '左键点它',
  },
  {
    id: 'panel',
    title: '打开一个面板',
    hint: 'B 背包 / K 角色 / J 任务 / O 队伍 / P 祈愿 / N 商店 / L 料理 / Esc 设置。',
    keys: ['B', 'K', 'J', 'O', 'P'],
  },
  {
    id: 'map',
    title: '地图与传送',
    hint: 'M 打开大地图。点亮过的传送锚点可以直接传送，秘境入口也在图上。',
    keys: ['M'],
  },
  // Last on purpose: the card shows the first *unfinished* step, and the nearest face steep
  // enough to climb is a couple of hundred metres from the 蒙德 spawn — a step you cannot finish
  // where you start would stall every step behind it.
  {
    id: 'climb',
    title: '爬上去',
    hint: '顶着陡坡按住 W 就开始攀爬，边爬边掉体力；攀爬中按空格向上蹿一段，体力空了会松手。',
    keys: ['W', '空格'],
  },
];

/** Every step id — also the complete vocabulary of signals the client may raise. */
export const TUTORIAL_IDS = TUTORIAL_STEPS.map((s) => s.id);

/**
 * The whole state of the guide, derived from the stored `{ done, skipped }`.
 *
 * Unknown ids are dropped rather than counted: a renamed or deleted step would otherwise
 * keep a stale account's progress bar at 11/10 forever, and the count is what the card
 * prints. `step` is null exactly when there is nothing left to show.
 */
export function tutorialView(state = {}) {
  const stored = Array.isArray(state?.done) ? state.done : [];
  const done = TUTORIAL_IDS.filter((id) => stored.includes(id));
  const skipped = !!state?.skipped;
  const step = skipped ? null : TUTORIAL_STEPS.find((s) => !done.includes(s.id)) || null;
  return {
    step,
    /** Position of the step on screen, 1-based, so the card can print `3 / 11`. */
    at: step ? TUTORIAL_STEPS.indexOf(step) + 1 : TUTORIAL_STEPS.length,
    total: TUTORIAL_STEPS.length,
    done,
    complete: !skipped && !step,
    skipped,
  };
}
