// Minimal DOM helpers. No framework: the HUD is a fixed set of nodes whose text
// and widths change every frame, which is exactly the case where a virtual DOM
// costs more than it saves. What we do need is terse construction and a cheap way
// to avoid redundant writes, since a layout-triggering style write on every frame
// for thirty nodes is what turns a 60 fps HUD into a 40 fps one.

/**
 * Build an element from a CSS-ish spec: `h('div.pcard.active > ...')` is not
 * supported — keep it explicit — but `h('div', 'pcard active', ...children)` is.
 */
export function h(tag, cls, ...children) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Parse an HTML string into its single root element. */
export function frag(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Query within a root, scoped and short. */
export const q = (root, sel) => root.querySelector(sel);
export const qa = (root, sel) => [...root.querySelectorAll(sel)];

/** Set textContent only when it changed. */
export function text(el, v) {
  const s = v == null ? '' : String(v);
  if (el.textContent !== s) el.textContent = s;
}

/** Set a style property only when it changed (avoids needless style recalc). */
export function css(el, prop, v) {
  if (el.style[prop] !== v) el.style[prop] = v;
}

/** Set a custom property only when it changed. */
export function cssVar(el, name, v) {
  const s = String(v);
  if (el.__vars?.[name] === s) return;
  el.__vars = el.__vars || {};
  el.__vars[name] = s;
  el.style.setProperty(name, s);
}

/** Toggle a class only when the state changed. */
export function cls(el, name, on) {
  if (el.classList.contains(name) === !!on) return;
  el.classList.toggle(name, !!on);
}

/** Percentage string for a bar width, clamped and rounded to avoid churn. */
export function pct(v, max) {
  if (!(max > 0)) return '0%';
  return `${Math.max(0, Math.min(100, Math.round((v / max) * 1000) / 10))}%`;
}

export function on(el, type, fn, opts) {
  el.addEventListener(type, fn, opts);
  return () => el.removeEventListener(type, fn, opts);
}

/** Big numbers with thin separators — 1,240,000 reads, 1240000 does not. */
export function num(n) {
  return Math.round(n || 0).toLocaleString('en-US');
}

export function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Element colour as a CSS hex string. */
export function hexColor(v) {
  return `#${(v ?? 0xffffff).toString(16).padStart(6, '0')}`;
}

/** A one-glyph icon for an element/item, since we ship no image assets. */
export const ELEMENT_GLYPH = {
  wind: '风', fire: '火', water: '水', ice: '冰',
  lightning: '雷', earth: '岩', light: '光', physical: '物',
};
