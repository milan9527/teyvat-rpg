// The title screen: account entry and the single-player / online choice.
//
// It lives inside the boot overlay (`#boot`) so the title art and the loading bar
// are the same element — the player never sees a flash of empty canvas between
// "logging in" and "loading the world".

import { frag, q, on } from './dom.js';
import { api, errorText } from '../net/api.js';

const HTML = `
<div class="login">
  <div class="row" data-row="mode">
    <button class="btn primary" data-act="online">多人在线</button>
    <button class="btn" data-act="solo">单机模式</button>
  </div>
  <div class="row" data-row="guest">
    <button class="btn" data-act="guest">以旅行者身份开始</button>
  </div>
  <input class="field" data-f="user" placeholder="账号" autocomplete="username" maxlength="24">
  <input class="field" data-f="pass" type="password" placeholder="密码" autocomplete="current-password" maxlength="64">
  <div class="row">
    <button class="btn" data-act="login">登录</button>
    <button class="btn" data-act="register">注册</button>
  </div>
  <div class="login-msg" data-f="msg"></div>
  <div class="row" data-row="resume" hidden>
    <button class="btn primary" data-act="resume">继续冒险</button>
    <button class="btn ghost" data-act="logout">切换账号</button>
  </div>
</div>`;

export class Login {
  /** `onDone({ mode })` runs once an auth token is in hand. */
  constructor(bootRoot, onDone) {
    this.root = frag(HTML);
    this.onDone = onDone;
    this.mode = 'online';
    bootRoot.appendChild(this.root);

    this.msg = q(this.root, '[data-f="msg"]');
    this.user = q(this.root, '[data-f="user"]');
    this.pass = q(this.root, '[data-f="pass"]');
    this.resumeRow = q(this.root, '[data-row="resume"]');
    this.modeButtons = {
      online: q(this.root, '[data-act="online"]'),
      solo: q(this.root, '[data-act="solo"]'),
    };

    // A stored token means we can skip straight in; still offer the switch.
    if (api.token) {
      this.resumeRow.hidden = false;
      const who = api.nickname ? `，${api.nickname}` : '';
      this.say(`欢迎回来${who}`, false);
    }

    on(this.root, 'click', (e) => {
      const act = e.target?.dataset?.act;
      if (act) this._act(act, e.target);
    });
    // Enter submits from either field — nobody wants to reach for the mouse here.
    on(this.root, 'keydown', (e) => {
      if (e.key === 'Enter' && (e.target === this.user || e.target === this.pass)) {
        e.preventDefault();
        this._act(api.token ? 'resume' : 'login');
      }
    });
    this._setMode('online');
  }

  say(text, error = true) {
    this.msg.textContent = text || '';
    this.msg.style.color = error ? '' : 'rgba(242,234,214,.6)';
  }

  _setMode(mode) {
    this.mode = mode;
    for (const [k, b] of Object.entries(this.modeButtons)) {
      b.classList.toggle('primary', k === mode);
    }
  }

  _busy(v) {
    for (const b of this.root.querySelectorAll('.btn')) b.disabled = v;
  }

  async _act(act, el) {
    if (act === 'online' || act === 'solo') { this._setMode(act); return; }
    if (act === 'logout') {
      api.clearToken();
      this.resumeRow.hidden = true;
      this.say('已登出', false);
      return;
    }
    if (act === 'resume') { this._finish(); return; }

    const u = this.user.value.trim();
    const p = this.pass.value;
    if (act !== 'guest') {
      if (u.length < 3) return this.say('账号至少 3 个字符');
      if (p.length < 6) return this.say('密码至少 6 个字符');
    }

    this._busy(true);
    this.say(act === 'guest' ? '创建旅行者…' : act === 'login' ? '登录中…' : '注册中…', false);
    try {
      if (act === 'guest') await api.guest();
      else if (act === 'login') await api.login(u, p);
      else await api.register(u, p);
      this._finish();
    } catch (e) {
      this.say(errorText(e));
      this._busy(false);
    }
  }

  _finish() {
    this.destroy();
    this.onDone({ mode: this.mode });
  }

  destroy() {
    this.root.remove();
  }
}
