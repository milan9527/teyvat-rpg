// Entry point. Drives the boot overlay, runs the title screen, builds the game,
// mounts the UI, and starts the loop.
//
// Everything here happens once, in order, and each step reports into the same
// progress bar so the player sees one continuous load rather than a series of
// blank frames.

import { Game } from './game/game.js';
import { guessTier } from './engine/perf.js';
import { Ui } from './ui/ui.js';
import { Login } from './ui/login.js';
import { api, errorText } from './net/api.js';
import { q } from './ui/dom.js';
import { keyHint } from './game/input.js';

/** Boot tips are `innerHTML`, so the key gets a <kbd> box. */
const kh = (action, what) => keyHint(action, what, { kbd: true });

const boot = document.getElementById('boot');
const bootFill = document.getElementById('boot-fill');
const bootMsg = document.getElementById('boot-msg');
const bootInner = q(boot, '.boot-inner');
const canvas = document.getElementById('scene');
const uiRoot = document.getElementById('ui-root');

function progress(fraction, message) {
  if (fraction != null) bootFill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  if (message) {
    bootMsg.textContent = message;
    bootMsg.classList.remove('error');
  }
}

function bootError(message) {
  bootMsg.textContent = message;
  bootMsg.classList.add('error');
  boot.classList.remove('hidden');
}

/** WebGL check up front: a clear message beats a black screen. */
function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

// Keys come out of `KEYMAP` through `keyHint`, never typed: the tip that used to send players
// to Tab for the friend list (Tab is the map; the friend list is U) is exactly what a
// hand-written key promise decays into.
const TIPS = [
  '左键点击地面移动，点击敌人锁定并攻击',
  `${kh('skill', '释放元素战技')}，${kh('burst', '释放元素爆发')}`,
  '不同元素叠加会触发反应：水 + 雷 = 感电，火 + 冰 = 融化',
  `${kh('sprint', '冲刺')}，长按左键蓄力重击`,
  `${kh('map', '打开地图')}，点击已激活的锚点可以传送`,
  '龙脊雪山会持续累积严寒，靠近篝火可以驱散',
  `${kh('social', '查看在线的旅行者')}，邀请他们一起冒险`,
];

function showTip() {
  let tip = q(boot, '.boot-tip');
  if (!tip) {
    tip = document.createElement('p');
    tip.className = 'boot-tip';
    bootInner.appendChild(tip);
  }
  tip.innerHTML = TIPS[Math.floor(Math.random() * TIPS.length)];
  return tip;
}

async function main() {
  if (!webglAvailable()) {
    bootError('这台设备或浏览器不支持 WebGL，无法运行游戏。');
    return;
  }

  progress(0.02, '正在初始化…');

  // 1. Title screen. Resolves once a token is in hand and a mode is chosen.
  const { mode } = await new Promise((resolve) => {
    progress(0, '');
    new Login(bootInner, resolve);
  });

  const tip = showTip();
  progress(0.04, '正在进入提瓦特…');

  // 2. Build the game. `load` walks the boot bar from 0.05 to 1.
  const game = new Game(canvas, {
    overlayRoot: document.getElementById('world-overlay'),
    // Passed in rather than assigned afterwards: the mode decides which socket the game
    // constructs, and by the time the constructor returns the actor system and every
    // event handler are already bound to it.
    mode: mode === 'solo' ? 'solo' : 'online',
    quality: 'high',
    // The tier to *start* at while the governor has no measurements yet. `quality` above
    // stays the ceiling, so this only ever saves a slow machine the first ten seconds; it
    // never caps a fast one. See engine/perf.js.
    startQuality: guessTier('high'),
  });
  window.game = game;   // handy in the console; harmless in production

  // The AudioContext must start from a user gesture. The click that dismissed
  // the title screen qualifies, but Chrome only honours it inside the handler,
  // so try now and again on the next pointer press as a fallback.
  const unlock = () => game.audio.unlock();
  unlock();
  window.addEventListener('pointerdown', unlock, { once: true });

  let ui = null;
  try {
    await game.load((f, m) => progress(0.04 + f * 0.92, m));
  } catch (e) {
    if (e?.message === 'timeout') bootError('连接服务器超时，请确认服务器已启动后刷新页面。');
    else if (e?.message === 'auth' || e?.status === 401) {
      api.clearToken();
      bootError('登录状态已失效，请刷新页面重新登录。');
    } else bootError(`载入失败：${errorText(e) || e?.message || e}`);
    console.error('[boot] load failed', e);
    return;
  }

  // 3. Mount the UI and hand it the frame.
  ui = new Ui(uiRoot, game, boot);
  window.ui = ui;       // same reason as `window.game`: consoles and probes

  game.on('frame', ({ dt }) => ui.update(dt));

  // 4. Go.
  progress(1, '进入提瓦特');
  tip.remove();
  game.start();
  // One frame of grace so the first rendered image is a complete one before the
  // overlay fades off it.
  requestAnimationFrame(() => requestAnimationFrame(() => boot.classList.add('hidden')));

  ui.hud.chat({ channel: 'sys', body: `欢迎来到提瓦特，${api.nickname || '旅行者'}。左键点击地面开始移动。` });
  game.banner('提瓦特之境', game.world?.zone?.name || '');

  // 5. Persist on the way out. `keepalive` in the api layer is not available for
  // this path, so a synchronous best-effort save is all we can do.
  window.addEventListener('beforeunload', () => { game.persist(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) game.persist(false);
  });
}

main().catch((e) => {
  console.error('[boot] fatal', e);
  bootError(`启动失败：${e?.message || e}`);
});
