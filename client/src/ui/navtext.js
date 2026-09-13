// The one-line answer to 「目标在哪」, shared by the HUD tracker and the quest panel.
//
// It started as two copies and they drifted inside one iteration: the tracker said
// 「按 L 打开料理」, with the key read out of `KEYMAP`, while the panel printed 「料理」 and left
// the player with a place-name that is not a place. Three of the four answer kinds have no
// position at all (`here`, `zone`, `panel`), so for them this sentence *is* the whole answer,
// and there is no reason for two views to phrase it differently.
//
// The key is never typed here — see `game/input.js`. A hint that names a binding has to be
// derived from the binding, or it outlives it.

import { keyHint, KEYMAP } from '../game/input.js';

/**
 * @param t      a `questTarget()` answer, or null
 * @param zone   append the zone name (the panel has room; the tracker does not)
 * @param dist   append the distance (the tracker prints it in its own element instead)
 */
export function navWhere(t, { zone = false, dist = false } = {}) {
  if (!t) return '';
  if (t.kind === 'place') {
    const bits = [t.name || ''];
    if (zone && t.zoneName) bits.push(t.zoneName);
    if (dist && t.dist != null) bits.push(`${Math.round(t.dist)} m`);
    return bits.join(' · ');
  }
  if (t.kind === 'here') return t.hint || `就在${t.zoneName || '这里'}`;
  if (t.kind === 'zone') return `${t.name || t.zoneName}${t.hint ? ` · ${t.hint}` : ''}`;
  // Through `keyHint` like every other key promise in the UI, so there is exactly one place
  // that turns an action into a key.
  return KEYMAP[t.panel]
    ? keyHint(t.panel, `打开${t.name || ''}`)
    : `打开${t.name || ''}面板`;
}
