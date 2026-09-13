// Cooking: recipes, the ingredient arithmetic, and the quality roll.
//
// Isomorphic on purpose. The client needs the recipe list to draw the cooking
// panel and to grey out what the player cannot afford; the server needs the exact
// same table to charge for a dish it hands out. Anything that decides *what the
// player gets* — ingredient counts, quality odds, the bonus on a perfect dish —
// lives here and is called from `routes/player.js`, never re-implemented there.
//
// Why cooking exists at all: gathering produces plants, and without a sink for them
// a meadow full of sweet flowers is scenery with an inventory counter attached. Food
// is also the only healing a party has outside a healer's kit, so it is what makes
// exploring at low level survivable.

import { Rand } from '../sim/rng.js';
import { MATERIALS } from './items.js';

/**
 * Recipes, keyed by id (which is also the dish item id — one recipe per dish).
 *
 * `rank` is the unlock gate in adventure ranks, and doubles as the difficulty: a
 * rank-4 dish is worth more and is harder to get right.
 */
export const RECIPES = {
  sweetMadame: {
    id: 'sweetMadame', rank: 1,
    ingredients: { sweetFlower: 2, wheat: 1 },
    desc: '甜甜花的蜜香裹着烤过的麦饼。旅行者的第一道菜，几乎不可能做坏。',
  },
  mintJelly: {
    id: 'mintJelly', rank: 1,
    ingredients: { mint: 3, sweetFlower: 1 },
    desc: '薄荷与甜甜花冰镇成糕。吃下后一段时间内攻击更加轻快。',
  },
  mushroomPizza: {
    id: 'mushroomPizza', rank: 2,
    ingredients: { mushroom: 3, wheat: 2 },
    desc: '铺满菌菇的薄饼，出炉时香气能飘过半个山谷。',
  },
  northernStew: {
    id: 'northernStew', rank: 3,
    ingredients: { mushroom: 2, wheat: 2, mint: 1 },
    desc: '北地做法的浓汤，适合翻越雪山之前先喝一碗。',
  },
  reviveDish: {
    id: 'reviveDish', rank: 3,
    ingredients: { qingxin: 1, mint: 2, sweetFlower: 2 },
    desc: '清心入汤，气味清冽。倒进倒下的同伴嘴里比什么药都快。',
  },
  adeptusTemptation: {
    id: 'adeptusTemptation', rank: 5,
    ingredients: { qingxin: 2, mushroom: 2, wheat: 2, crystalCore: 1 },
    desc: '仙人也会翻墙来偷吃的一锅。所有食材都难得，成功一次值得记住。',
  },
};

export const RECIPE_IDS = Object.keys(RECIPES);

/** Quality tiers. A dish is one of these three, and the label is player-facing. */
export const QUALITY = {
  perfect: { key: 'perfect', name: '完美', bonus: 1, color: '#ffd76a' },
  normal: { key: 'normal', name: '普通', bonus: 0, color: '#dfe6f0' },
  ruined: { key: 'ruined', name: '失败', bonus: 0, color: '#9aa4b2' },
};

/**
 * Odds of each outcome for one attempt.
 *
 * Skill comes from adventure rank, and the curve is deliberately generous: a
 * cooking minigame that fails a quarter of the time makes players stop cooking, and
 * the failure result (a suspicious dish that heals a little) is a consolation
 * rather than a punishment. A recipe above the player's rank is where the real risk
 * lives — that is what the rank field is for.
 */
export function cookOdds(recipe, adventureRank = 1) {
  const over = Math.max(0, recipe.rank - Math.max(1, adventureRank) * 0.6);
  const ruined = Math.min(0.42, 0.04 + over * 0.09);
  const perfect = Math.max(0.05, 0.34 + Math.min(0.28, adventureRank * 0.012) - over * 0.10);
  return { ruined, perfect, normal: Math.max(0, 1 - ruined - perfect) };
}

/**
 * Cook `count` portions.
 *
 * Rolls each portion separately: a batch of five that all share one roll is
 * effectively one dish with a multiplier, and the interesting part of a batch is
 * that some of it comes out perfect. Returns what to add and what to consume, so
 * the caller does inventory arithmetic in one place.
 */
export function cook(recipeId, count, adventureRank, seed) {
  const recipe = RECIPES[recipeId];
  if (!recipe) return null;
  const rand = new Rand(seed >>> 0);
  const odds = cookOdds(recipe, adventureRank);
  const gained = {};
  const tally = { perfect: 0, normal: 0, ruined: 0 };
  for (let i = 0; i < count; i++) {
    const r = rand.float(0, 1);
    if (r < odds.ruined) {
      tally.ruined++;
      gained.suspiciousFood = (gained.suspiciousFood || 0) + 1;
    } else if (r < odds.ruined + odds.perfect) {
      tally.perfect++;
      // A perfect dish yields two portions. That is the whole reward for cooking
      // something well — the dish itself is identical, because a separate "perfect
      // sweet madame" item would double the size of the item table for no play.
      gained[recipe.id] = (gained[recipe.id] || 0) + 2;
    } else {
      tally.normal++;
      gained[recipe.id] = (gained[recipe.id] || 0) + 1;
    }
  }
  const consumed = {};
  for (const [id, n] of Object.entries(recipe.ingredients)) consumed[id] = n * count;
  return { recipe, gained, consumed, tally };
}

/** How many portions the given inventory can afford, capped at `cap`. */
export function maxPortions(recipeId, inventory = {}, cap = 99) {
  const recipe = RECIPES[recipeId];
  if (!recipe) return 0;
  let n = cap;
  for (const [id, need] of Object.entries(recipe.ingredients)) {
    n = Math.min(n, Math.floor((inventory[id] || 0) / need));
  }
  return Math.max(0, n);
}

/** Human-readable ingredient list, for the panel and for error messages. */
export function ingredientText(recipeId) {
  const recipe = RECIPES[recipeId];
  if (!recipe) return '';
  return Object.entries(recipe.ingredients)
    .map(([id, n]) => `${MATERIALS[id]?.name ?? id}×${n}`)
    .join(' + ');
}
