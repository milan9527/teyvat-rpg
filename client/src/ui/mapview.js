// Map rendering, shared by the round minimap and the full-screen map.
//
// Both views draw from one baked canvas: the zone's height field and biome table
// are sampled once when the zone loads and painted into an offscreen bitmap with
// hillshading. Baking is the only sane option — sampling fBm per pixel per frame
// for a 148 px minimap is thousands of noise evaluations a frame, and the terrain
// never changes, so it is pure waste.

import { heightAt, slopeAt, biomeAt, normalAt } from '@teyvat/shared/data/zones.js';
import { ARENA_SLAB } from '../gfx/terrain.js';

const BAKE = 256;   // texels per side; the zone is square

/** Bake one zone into an offscreen canvas. Costs ~50 ms, done at zone load. */
export function bakeZoneMap(zone) {
  const c = document.createElement('canvas');
  c.width = BAKE;
  c.height = BAKE;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(BAKE, BAKE);
  const d = img.data;
  const half = zone.size / 2;
  const step = zone.size / BAKE;
  const water = zone.water?.level ?? -999;

  for (let j = 0; j < BAKE; j++) {
    // Image rows run +Z downward so north (−Z) is up, matching the compass.
    const wz = -half + (j + 0.5) * step;
    for (let i = 0; i < BAKE; i++) {
      const wx = -half + (i + 0.5) * step;
      const y = heightAt(zone, wx, wz);
      const b = biomeAt(zone, wx, wz);
      let r = (b.color >> 16) & 255, g = (b.color >> 8) & 255, bl = b.color & 255;

      if (y < water) {
        // Blend toward water colour with depth so shorelines read as shorelines.
        const depth = Math.min(1, (water - y) / 6);
        const wc = zone.water?.color ?? 0x2f6f9e;
        const wr = (wc >> 16) & 255, wg = (wc >> 8) & 255, wb = wc & 255;
        const k = 0.35 + depth * 0.55;
        r += (wr - r) * k; g += (wg - g) * k; bl += (wb - bl) * k;
      }

      // Hillshade from the analytic normal, lit from the north-west. Without it a
      // biome-coloured map is a flat blob and unreadable as terrain.
      const n = normalAt(zone, wx, wz);
      const lambert = Math.max(0, n[0] * -0.55 + n[1] * 0.72 + n[2] * -0.42);
      const shade = 0.55 + lambert * 0.62;
      // Steep ground darkens further; cliffs are the main navigation feature.
      const steep = 1 - Math.min(0.45, slopeAt(zone, wx, wz) * 0.35);

      const o = (j * BAKE + i) * 4;
      d[o] = Math.min(255, r * shade * steep);
      d[o + 1] = Math.min(255, g * shade * steep);
      d[o + 2] = Math.min(255, bl * shade * steep);
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (zone.indoor && zone.terrain.arena) bakeArenaFloor(ctx, zone);
  return { canvas: c, zone, size: zone.size };
}

/**
 * Overlay the dungeon floor's architecture on a baked indoor map.
 *
 * A dungeon arena is deliberately flat — that is what makes it a place to fight in —
 * so hillshading a height field with 4 m of relief gives one uniform disc, and the
 * map of a hall was a coloured circle with two pins on it. The floor the player is
 * actually looking at has flagstones, two concentric bands, eight spokes and a centre
 * medallion, all struck from the arena centre. Those come from constants in the
 * terrain shader, so they can be reproduced here exactly rather than approximated.
 *
 * Keep in sync with the `uArenaR` branch in gfx/terrain.js.
 */
function bakeArenaFloor(ctx, zone) {
  const t = zone.terrain;
  const R = t.arena.radius;
  const px = BAKE / zone.size;              // texels per metre
  const cx = BAKE / 2, cy = BAKE / 2;
  const inlay = t.inlayColor ?? t.biomes[1]?.color ?? 0xffffff;
  const rgb = `${(inlay >> 16) & 255},${(inlay >> 8) & 255},${inlay & 255}`;
  // The same `terrain.inlayStrength` the shader mixes with, so a zone that turns its inlay
  // up gets a map that turns up with it. The two alphas keep their old *relation* to it
  // (bands a little stronger than the floor mix, medallion equal to it) rather than being
  // two more constants to forget: this file and gfx/terrain.js drifting apart is exactly
  // how the map of a hall ends up showing a pattern the floor does not have.
  const strength = t.inlayStrength ?? 0.45;

  ctx.save();
  // Everything below is inside the wall; the terrain outside it is real geometry and
  // already baked.
  ctx.beginPath();
  ctx.arc(cx, cy, R * px, 0, Math.PI * 2);
  ctx.clip();

  // Flagstones, on the shader's own course (`ARENA_SLAB`) rather than a second copy of the
  // number. Drawn every n-th joint, where n is the smallest multiple whose spacing clears
  // 3.5 texels: at BAKE 256 over a 160 m zone one metre is 1.6 texels, so the floor's 1.5 m
  // course would put a line every 2.4 texels and the map would be grey mush. A map is
  // allowed to draw a coarser course than the floor; it is not allowed to draw a *different*
  // one, which is what an unrelated literal here would eventually become.
  const step = ARENA_SLAB * Math.max(1, Math.ceil(3.5 / (ARENA_SLAB * px)));
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.20)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let m = -R; m <= R; m += step) {
    const p = cx + m * px;
    ctx.moveTo(p, cy - R * px); ctx.lineTo(p, cy + R * px);
    ctx.moveTo(cx - R * px, p); ctx.lineTo(cx + R * px, p);
  }
  ctx.stroke();

  // Two inlay bands.
  ctx.strokeStyle = `rgba(${rgb}, ${Math.min(0.95, strength + 0.10).toFixed(2)})`;
  for (const [band, width] of [[0.24, 2.2], [0.52, 3.2]]) {
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(cx, cy, R * band * px, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Eight spokes, from just outside the medallion to just outside the second band.
  ctx.lineWidth = 1.6;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R * 0.19 * px, cy + Math.sin(a) * R * 0.19 * px);
    ctx.lineTo(cx + Math.cos(a) * R * 0.53 * px, cy + Math.sin(a) * R * 0.53 * px);
    ctx.stroke();
  }

  // Centre medallion.
  ctx.fillStyle = `rgba(${rgb}, ${strength.toFixed(2)})`;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.065 * px, 0, Math.PI * 2);
  ctx.fill();

  // Shadow gathering under the wall, so the disc has a rim instead of a hard edge.
  const grad = ctx.createRadialGradient(cx, cy, R * 0.55 * px, cx, cy, R * px);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(cx - R * px, cy - R * px, R * 2 * px, R * 2 * px);
  ctx.restore();
}

/* ------------------------------------------------------------------ minimap -- */

/**
 * Draw the round minimap: a rotated, zoomed crop of the bake centred on the
 * player, with POI and entity pips on top.
 *
 * The map is *north-up* rather than rotating with the camera. Rotating minimaps
 * are disorienting for click-to-move, where the player is picking destinations in
 * world space, and it lets the compass letter stay put.
 */
export function drawMinimap(canvas, baked, view) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const { zone } = baked;
  const range = view.range ?? 90;              // metres visible across the disc
  const half = zone.size / 2;
  const scale = w / (range * 2);               // px per metre

  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, w / 2 - 1, 0, Math.PI * 2);
  ctx.clip();

  // Source rect in bake texels.
  const texPerM = BAKE / zone.size;
  const sx = (view.x + half - range) * texPerM;
  const sy = (view.z + half - range) * texPerM;
  const sw = range * 2 * texPerM;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(baked.canvas, sx, sy, sw, sw, 0, 0, w, h);

  const toScreen = (wx, wz) => [
    w / 2 + (wx - view.x) * scale,
    h / 2 + (wz - view.z) * scale,
  ];

  // POIs
  for (const p of view.pois || []) {
    const [px, py] = toScreen(p.x, p.z);
    if (px < -8 || py < -8 || px > w + 8 || py > h + 8) continue;
    ctx.beginPath();
    ctx.fillStyle = PIN_COLOR[p.type] || '#e8c56a';
    ctx.globalAlpha = p.done ? 0.4 : 1;
    if (p.type === 'waypoint' || p.type === 'dungeon') {
      // Diamonds for travel points so they read differently from collectibles.
      ctx.moveTo(px, py - 4); ctx.lineTo(px + 4, py); ctx.lineTo(px, py + 4); ctx.lineTo(px - 4, py);
    } else {
      ctx.arc(px, py, 3, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Enemies and party members
  for (const e of view.enemies || []) {
    const [px, py] = toScreen(e.x, e.z);
    ctx.fillStyle = e.boss ? '#ff5a3c' : '#e05e4e';
    ctx.beginPath();
    ctx.arc(px, py, e.boss ? 4 : 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const p of view.players || []) {
    const [px, py] = toScreen(p.x, p.z);
    ctx.fillStyle = '#6fd6e0';
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // The tracked objective. Inside the disc it is a diamond with a ring so it reads as a
  // *goal* rather than as another collectible; outside it, it is clamped to the rim and drawn
  // as a triangle pointing off-map, because the useful information at 300 m is the direction.
  if (view.quest) {
    const [qx, qy] = toScreen(view.quest.x, view.quest.z);
    const cx = w / 2, cy = h / 2, R = w / 2 - 7;
    const dx = qx - cx, dy = qy - cy;
    const len = Math.hypot(dx, dy);
    ctx.save();
    ctx.fillStyle = '#ffd15c';
    ctx.strokeStyle = 'rgba(30,22,8,.85)';
    ctx.lineWidth = 1.2;
    if (len > R) {
      const k = R / (len || 1);
      ctx.translate(cx + dx * k, cy + dy * k);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.beginPath();
      ctx.moveTo(6, 0); ctx.lineTo(-4, 4.5); ctx.lineTo(-4, -4.5);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    } else {
      ctx.translate(qx, qy);
      ctx.beginPath();
      ctx.moveTo(0, -6); ctx.lineTo(4.5, 0); ctx.lineTo(0, 6); ctx.lineTo(-4.5, 0);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,209,92,.55)';
      ctx.stroke();
    }
    ctx.restore();
  }

  // Player arrow, always centred, pointing where the character faces.
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-view.ry + Math.PI);
  ctx.beginPath();
  ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6);
  ctx.closePath();
  ctx.fillStyle = '#fff6d8';
  ctx.strokeStyle = 'rgba(0,0,0,.6)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

export const PIN_COLOR = {
  waypoint: '#6fd6e0',
  chest: '#e8c56a',
  puzzle: '#b586f0',
  dungeon: '#ff7a4d',
  statue: '#ffe9a8',
  warmth: '#ff8a3c',
  npc: '#9fd8b0',
};

/* ---------------------------------------------------------------- full map -- */

/** Draw the whole zone to a canvas, letterboxed to fit. Returns the transform. */
export function drawFullMap(canvas, baked, view) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const side = Math.min(w, h);
  const ox = (w - side) / 2, oy = (h - side) / 2;
  ctx.drawImage(baked.canvas, 0, 0, BAKE, BAKE, ox, oy, side, side);

  // Border and a faint grid so distances are estimable.
  ctx.strokeStyle = 'rgba(226,210,168,.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + 0.5, oy + 0.5, side - 1, side - 1);
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    ctx.moveTo(ox + (side * i) / 4, oy);
    ctx.lineTo(ox + (side * i) / 4, oy + side);
    ctx.moveTo(ox, oy + (side * i) / 4);
    ctx.lineTo(ox + side, oy + (side * i) / 4);
  }
  ctx.strokeStyle = 'rgba(226,210,168,.10)';
  ctx.stroke();

  const half = baked.zone.size / 2;
  return {
    /** World → canvas pixels. */
    toScreen: (wx, wz) => [
      ox + ((wx + half) / baked.zone.size) * side,
      oy + ((wz + half) / baked.zone.size) * side,
    ],
    /** Canvas pixels → world. */
    toWorld: (px, py) => [
      ((px - ox) / side) * baked.zone.size - half,
      ((py - oy) / side) * baked.zone.size - half,
    ],
    ox, oy, side,
  };
}
