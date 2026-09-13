// Teleport anchors: which POIs you can travel to, and which of them you have earned.
//
// Why this file exists. `world_progress` has carried `{unlocked:true}` rows for waypoints and
// statues since the first commit; `POST /api/world/unlock` writes them, the achievement
// 「七天神像的指引」 counts them, and the map panel draws a diamond for every one of them. What
// nothing did was *read* them before travelling: `POST /api/world/teleport` only checked the
// zone's adventure rank, so a fresh account could open the map and jump to 奔狼领 without ever
// having walked there. Activating an anchor paid 5 原石 and bought nothing else — exploration was
// optional in a game whose whole middle is exploration.
//
// The same question comes up in a second place, which is why the answer lives here rather than in
// the route: when a downed player stands up at 「最近的锚点」, *nearest* has to mean nearest among
// the ones they have activated. One function, two callers (the route and `ZoneInstance`), plus the
// HUD which needs the anchor's name to put on the button.

/** POI types you can travel to. Anything else is a label on the map, and fails closed. */
export const TELEPORT_TYPES = new Set(['waypoint', 'statue']);

/** Every anchor in a zone, in table order. */
export function anchorList(zdef) {
  return (zdef?.poi || []).filter((p) => TELEPORT_TYPES.has(p.type));
}

/**
 * The anchor a zone is entered at when no specific one is asked for.
 *
 * Always travellable, unlocked or not: it is how you arrive in a zone for the first time, and
 * `unlock` needs you standing in the zone. Every zone's table starts with one (`zoneGate.js`
 * fails on a zone with no waypoint), so this is not an empty case in practice.
 */
export function defaultAnchor(zdef) {
  return (zdef?.poi || []).find((p) => p.type === 'waypoint') || null;
}

/** The `world_progress` sub-map for one zone, tolerating the two shapes callers hold. */
export function zoneProgress(progress, zoneId) {
  if (!progress) return {};
  return (zoneId ? progress[zoneId] : progress) || {};
}

/**
 * Has this anchor been activated?
 *
 * The zone's default anchor answers true without a row: see `defaultAnchor`.
 */
export function isAnchorUnlocked(zdef, poi, zoneProg = {}) {
  if (!poi) return false;
  const def = defaultAnchor(zdef);
  if (def && poi.id === def.id) return true;
  return !!zoneProg[poi.id]?.unlocked;
}

/** Every anchor the player can travel to right now. */
export function unlockedAnchors(zdef, zoneProg = {}) {
  return anchorList(zdef).filter((p) => isAnchorUnlocked(zdef, p, zoneProg));
}

/**
 * The unlocked anchor closest to `(x, z)`, falling back to the zone's default anchor.
 *
 * Distance is measured on the flat, which is what the player reads off the map, and ties break on
 * table order so two hosts computing this from the same save get the same answer.
 */
export function nearestAnchor(zdef, x, z, zoneProg = {}) {
  let best = null, bestD = Infinity;
  for (const p of unlockedAnchors(zdef, zoneProg)) {
    const d = Math.hypot(p.at[0] - x, p.at[1] - z);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best || defaultAnchor(zdef);
}

/** What to call an anchor on a button. */
export function anchorName(poi) {
  return poi?.name || (poi?.type === 'statue' ? '七天神像' : '传送锚点');
}
