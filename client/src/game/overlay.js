// DOM overlay pinned to world positions: damage numbers, name plates, enemy
// health bars, interaction markers, click rings.
//
// Text is DOM rather than sprites on purpose. Crisp CJK glyphs at arbitrary sizes
// need real font rasterisation, and a canvas-atlas approach would either blur
// under scaling or cost an atlas rebuild per distinct string. The tradeoff is
// that every element costs a style write per frame, so:
//
//   * elements are pooled and reused, never created per hit;
//   * positions are written with `translate3d` so they stay on the compositor;
//   * anything behind the camera or past the cull distance is detached from the
//     layout entirely (display:none) rather than positioned off-screen.

import * as THREE from 'three';
import { REACTIONS, ELEMENTS } from '@teyvat/shared/data/elements.js';

const V = new THREE.Vector3();

/** Pool of same-class DOM nodes, reused by index. */
class NodePool {
  constructor(root, html, max) {
    this.root = root;
    this.html = html;
    this.max = max;
    this.nodes = [];
    this.used = 0;
  }

  begin() { this.used = 0; }

  take() {
    if (this.used >= this.max) return null;
    let n = this.nodes[this.used];
    if (!n) {
      const t = document.createElement('template');
      t.innerHTML = this.html.trim();
      n = t.content.firstElementChild;
      this.root.appendChild(n);
      this.nodes.push(n);
    }
    this.used++;
    n.style.display = '';
    return n;
  }

  /** Hide every node the frame did not claim. */
  end() {
    for (let i = this.used; i < this.nodes.length; i++) {
      if (this.nodes[i].style.display !== 'none') this.nodes[i].style.display = 'none';
    }
  }

  clear() {
    for (const n of this.nodes) n.remove();
    this.nodes.length = 0;
    this.used = 0;
  }
}

// `pips` and `tk` are appended *after* the elements the rest of this file indexes by
// position (`.nm`'s three children, `.ebar`'s two), so adding them cannot move anything.
// How far down the screen a boss plate's *anchor* may be pushed, in CSS pixels. The element is
// translated -100% vertically, so this is its own height plus a margin: name line, pips, and the
// 5-pixel health bar under them.
const LABEL_TOP = 46;

const LABEL_HTML = `
<div class="wlabel">
  <div class="nm"><span class="lv"></span><span class="who"></span><i class="aura"></i><span class="pips"></span></div>
  <div class="ebar"><i></i><i class="sh"></i><i class="tk"></i></div>
</div>`;

export class Overlay {
  constructor(root, camera) {
    this.root = root;
    this.camera = camera;
    this.labels = new NodePool(root, LABEL_HTML, 48);
    // Damage numbers are fire-and-forget: the CSS animation ends them, so they
    // are *not* pooled by index — they are appended and self-remove. A pool would
    // have to interrupt running animations to recycle a node mid-flight.
    this.dmgLive = [];
    this.maxDmg = 40;
    this.cullDist = 120;
    this.enabled = true;
    this.showNames = true;
    this._w = 0;
    this._h = 0;
  }

  resize(w, h) { this._w = w; this._h = h; }

  /**
   * Project a world point to CSS pixels.
   * Returns null when the point is behind the camera or too far to bother with.
   *
   * `topMargin` is how far *above* the viewport the point may land and still count. The default
   * 160 px is the same "a label that is half off-screen should still show" allowance as the other
   * three edges; a caller that intends to hold the result at the top edge instead of positioning
   * it there passes something larger, because for a 10-metre boss at melee range the anchor is
   * thousands of pixels up and the cull, not the clamp, is what would lose the plate.
   */
  project(x, y, z, maxDist = this.cullDist, topMargin = 160) {
    V.set(x, y, z);
    const dist = V.distanceTo(this.camera.position);
    if (dist > maxDist) return null;
    V.project(this.camera);
    // z outside [-1, 1] means outside the frustum depth range — behind the near
    // plane in particular, where the projection flips and labels appear mirrored
    // on the far side of the screen.
    if (V.z < -1 || V.z > 1) return null;
    const sx = (V.x * 0.5 + 0.5) * this._w;
    const sy = (-V.y * 0.5 + 0.5) * this._h;
    // Allow a generous margin so a label that is half off-screen still shows.
    if (sx < -240 || sx > this._w + 240 || sy < -topMargin || sy > this._h + 160) return null;
    return { x: sx, y: sy, dist };
  }

  /* --------------------------------------------------------- damage numbers -- */

  /**
   * `spec`: { x, y, z, amount, crit, element, kind, reaction, taken }
   *
   * A negative amount with kind 'heal' is a heal — that is how the server sends
   * them, and keeping the same convention here means the damage feed needs no
   * translation layer.
   */
  damage(spec) {
    if (!this.enabled) return;
    const p = this.project(spec.x, spec.y, spec.z, 90);
    if (!p) return;
    if (this.dmgLive.length > this.maxDmg) {
      // Over budget: drop the oldest rather than skipping the newest, since the
      // newest is the hit the player just landed and cares about.
      const old = this.dmgLive.shift();
      old?.remove();
    }

    const el = document.createElement('div');
    const cls = ['dmg'];
    let text;

    if (spec.reaction) {
      cls.push('reaction');
      text = REACTIONS[spec.reaction]?.name ?? spec.reaction;
      el.style.color = `#${(REACTIONS[spec.reaction]?.color ?? 0xffffff).toString(16).padStart(6, '0')}`;
    } else if (spec.kind === 'heal' || spec.amount < 0) {
      cls.push('heal');
      text = `+${Math.round(Math.abs(spec.amount))}`;
    } else if (spec.immune) {
      cls.push('immune');
      text = '免疫';
    } else {
      if (spec.crit) cls.push('crit');
      if (spec.taken) cls.push('taken');
      else if (spec.element && spec.element !== 'physical') cls.push(spec.element);
      text = String(Math.round(spec.amount));
    }

    el.className = cls.join(' ');
    el.textContent = text;
    // Scatter horizontally so a five-hit combo does not stack into one blur.
    const jitter = (Math.random() - 0.5) * 46;
    el.style.transform = '';
    el.style.left = `${p.x + jitter}px`;
    el.style.top = `${p.y - Math.random() * 18}px`;
    // Distant numbers shrink, which keeps a crowded fight readable.
    const s = Math.max(0.62, Math.min(1.15, 22 / Math.max(6, p.dist)));
    if (s !== 1) el.style.fontSize = `${Math.round(parseFloat(spec.crit ? 30 : 21) * s)}px`;
    this.root.appendChild(el);
    this.dmgLive.push(el);
    el.addEventListener('animationend', () => {
      el.remove();
      const i = this.dmgLive.indexOf(el);
      if (i >= 0) this.dmgLive.splice(i, 1);
    }, { once: true });
  }

  /** Floating text with no numeric semantics: '拾取 ×2', '已解锁'. */
  note(x, y, z, text, cls = '') {
    if (!this.enabled) return;
    const p = this.project(x, y, z, 90);
    if (!p) return;
    const el = document.createElement('div');
    el.className = `dmg reaction ${cls}`;
    el.textContent = text;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    this.root.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }

  /* ------------------------------------------------------------ click ring -- */

  clickRing(screenX, screenY) {
    const el = document.createElement('div');
    el.className = 'click-ring';
    el.style.left = `${screenX}px`;
    el.style.top = `${screenY}px`;
    this.root.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }

  /* ---------------------------------------------------------------- labels -- */

  beginLabels() { this.labels.begin(); }

  /**
   * `spec`: { x, y, z, name, level, hp, maxHp, shield, aura, kind, boss, phase, phases }
   * `kind` ∈ enemy | player | npc | poi.
   */
  label(spec) {
    if (!this.enabled || !this.showNames) return;
    // A boss plate is exempt from the "too far above the viewport" cull, because it is about to
    // be held at the top edge instead (see below). Every other label keeps the default.
    const p = this.project(spec.x, spec.y, spec.z, spec.maxDist ?? this.cullDist,
      spec.boss ? Infinity : undefined);
    if (!p) return;
    const n = this.labels.take();
    if (!n) return;

    const cls = `wlabel ${spec.kind || 'enemy'}${spec.boss ? ' boss' : ''}`;
    if (n.className !== cls) n.className = cls;
    // 顶部钳制, and only for bosses. A plate is pinned above its creature's head, and 暴风之主
    // stands 9.9 metres tall and flies: at any distance a player would actually fight it from,
    // its head projects *above* the top of the screen and the plate goes with it. That plate is
    // the only place the game shows a boss's hp, shield element and battle phase, so losing it
    // at melee range means the phase pips and the threshold ticks on the bar are unreadable
    // exactly when they matter. Sliding it along the top edge keeps it attached to the boss
    // horizontally — which is what makes it readable as *that* creature's bar — and costs
    // nothing anywhere else: ordinary enemies are untouched, and a boss whose plate was already
    // in frame is written the same pixel it was before.
    const py = spec.boss ? Math.max(LABEL_TOP, p.y) : p.y;
    n.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(py)}px, 0) translate(-50%, -100%)`;
    // Fade out with distance instead of popping off at the cull radius.
    const fade = 1 - Math.max(0, (p.dist - 45) / 55);
    n.style.opacity = fade < 1 ? String(Math.max(0, fade)) : '';

    const lv = n.children[0].children[0];
    const who = n.children[0].children[1];
    const aura = n.children[0].children[2];
    const bar = n.children[1];

    const lvText = spec.level != null ? `Lv.${spec.level}` : '';
    if (lv.textContent !== lvText) lv.textContent = lvText;
    if (who.textContent !== spec.name) who.textContent = spec.name;

    if (spec.aura) {
      const c = `#${(ELEMENTS[spec.aura]?.color ?? 0xffffff).toString(16).padStart(6, '0')}`;
      aura.style.display = 'inline-block';
      if (aura.style.color !== c) aura.style.color = c;
      aura.style.background = c;
    } else if (aura.style.display !== 'none') {
      aura.style.display = 'none';
    }

    // 阶段. A boss's phase is a *state*, and the banner that announced it is gone in three and
    // a half seconds — a player who was dodging when it fired has to be able to read the plate
    // and see both where the fight is and how many phases are left. Filled/hollow lozenges
    // rather than a number, so it survives at 60 m without being read as a level.
    const pips = n.children[0].children[3];
    if (spec.phases > 1) {
      const ph = Math.max(1, Math.min(spec.phases, spec.phase || 1));
      const txt = `${'◆'.repeat(ph)}${'◇'.repeat(spec.phases - ph)}`;
      if (pips.textContent !== txt) pips.textContent = txt;
      if (pips.style.display !== 'inline') pips.style.display = 'inline';
    } else if (pips.style.display !== 'none') {
      pips.style.display = 'none';
      pips.textContent = '';
    }

    if (spec.maxHp > 0) {
      bar.style.display = '';
      const pct = Math.max(0, Math.min(1, spec.hp / spec.maxHp)) * 100;
      bar.children[0].style.width = `${pct}%`;
      const sh = spec.shield > 0 ? Math.min(1, spec.shield / spec.maxHp) * 100 : 0;
      bar.children[1].style.width = `${sh}%`;
      bar.children[1].style.display = sh > 0 ? '' : 'none';
      // An elemental shield is drawn in its own element. Every shield used to be the same gold
      // (`--shield` in style.css), which is correct for the crystallize shield a player wears
      // and wrong for the two enemies whose shield can only be broken efficiently by one
      // element: the mage's ice and the herald's water looked identical.
      // Compared against what was last written to *this* node rather than against
      // `style.background`: the browser normalises a gradient string on the way back in, so
      // reading it would restyle every label every frame.
      const sc = sh > 0 && spec.shieldElement
        ? `linear-gradient(90deg, rgba(0,0,0,0.5), #${(ELEMENTS[spec.shieldElement]?.color ?? 0xffffff).toString(16).padStart(6, '0')})`
        : '';
      if (n._shBg !== sc) { n._shBg = sc; bar.children[1].style.background = sc; }

      // Where the *next* phase starts, drawn over the fill rather than under it: the
      // thresholds are below the current hp, which is exactly the part of the bar the fill
      // covers. `phases: 3` means lines at 1/3 and 2/3. Memoised by phase count — this runs
      // for every label every frame.
      const tk = bar.children[2];
      const key = spec.phases > 1 ? String(spec.phases) : '';
      if (n._tk !== key) {
        n._tk = key;
        tk.style.backgroundImage = key
          ? Array.from({ length: spec.phases - 1 }, (_, i) => {
            const pc = (((i + 1) / spec.phases) * 100).toFixed(2);
            return `linear-gradient(90deg, transparent ${pc}%, rgba(255,232,196,0.9) ${pc}%,`
              + ` rgba(255,232,196,0.9) calc(${pc}% + 1.5px), transparent calc(${pc}% + 1.5px))`;
          }).join(', ')
          : '';
      }
    } else if (bar.style.display !== 'none') {
      bar.style.display = 'none';
    }
  }

  endLabels() { this.labels.end(); }

  clear() {
    this.labels.clear();
    for (const d of this.dmgLive) d.remove();
    this.dmgLive.length = 0;
  }
}
