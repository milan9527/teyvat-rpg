// Shops: the mora sink.
//
// Written because the economy had income and no outlet. A level-42 save had 254,182 mora
// and the only thing in the game that took currency was the wish banner, which takes
// primogems — so mora accumulated forever and every drop of it was noise. A shop is not
// content for its own sake here; it is what makes the number on the HUD mean something.
//
// Three rules the catalogue follows, and they are worth keeping:
//
//  1. **Mora never buys premium currency.** It buys consumables, ore, fodder weapons and
//     ingredients — things that are otherwise a walk or a fight away. Primogems buy resin
//     and wishes. If mora could buy primogems the whole progression curve would collapse
//     into "grind mora".
//  2. **Every limited entry declares its period, not its reset time.** See
//     `sim/clock.js`: a stock count carries the key of the period it belongs to, so reset
//     is derived rather than scheduled.
//  3. **Barter entries cost materials, not currency.** `cost` is a plain item map, so the
//     abyss trader charging 20 chaos cores needs no new machinery — the same code path
//     that spends mora spends chaos cores, because mora *is* an inventory item.

import { MATERIALS, WEAPONS } from './items.js';
import { periodKey, periodEndsAt } from '../sim/clock.js';

/** Primogems per wish. Shared with the wish route's auto-convert so the two cannot drift. */
export const GEM_PER_WISH = 160;

/**
 * What a 纠缠之缘 costs in wish change.
 *
 * These two are the *anchor* of the whole dupe-conversion rule, not a second set of numbers
 * next to it: `sim/loot.js` derives what a maxed-out duplicate pays out from
 * `GLITTER_PER_WISH`, so a 4★ character already at C6 hands back exactly the pull that
 * bought it and a 5★ hands back five. Change the price here and the payout follows —
 * inventing both ends separately is how a rebate quietly becomes an arbitrage.
 *
 * Both entries are capped monthly (see `bargains`), so this is a floor under bad luck
 * rather than a way to farm wishes out of 3★ weapons.
 */
export const GLITTER_PER_WISH = 5;
export const DUST_PER_WISH = 75;

export const SHOPS = {
  general: {
    id: 'general', name: '万有铺', keeper: '花语', zone: 'mondstadt',
    desc: '蒙德城广场的杂货铺。食材与常备补给，每日补货。',
    entries: [
      { id: 'gen_sweetFlower', item: 'sweetFlower', count: 5, cost: { mora: 1500 }, limit: 6, period: 'daily' },
      { id: 'gen_mint', item: 'mint', count: 5, cost: { mora: 1200 }, limit: 6, period: 'daily' },
      { id: 'gen_mushroom', item: 'mushroom', count: 5, cost: { mora: 1000 }, limit: 6, period: 'daily' },
      { id: 'gen_wheat', item: 'wheat', count: 5, cost: { mora: 900 }, limit: 6, period: 'daily' },
      { id: 'gen_sweetMadame', item: 'sweetMadame', count: 1, cost: { mora: 2400 }, limit: 5, period: 'daily' },
      { id: 'gen_northernStew', item: 'northernStew', count: 1, cost: { mora: 4200 }, limit: 3, period: 'daily' },
      { id: 'gen_reviveDish', item: 'reviveDish', count: 1, cost: { mora: 9000 }, limit: 2, period: 'daily' },
      { id: 'gen_adventurerXp', item: 'adventurerXp', count: 5, cost: { mora: 12000 }, limit: 10, period: 'weekly' },
    ],
  },

  blacksmith: {
    id: 'blacksmith', name: '铁匠铺', keeper: '瓦格纳', zone: 'mondstadt',
    desc: '矿石与武器胚子。三星武器在这里是精炼用的料，不是收藏品。',
    entries: [
      { id: 'smith_iron', item: 'ironChunk', count: 10, cost: { mora: 5000 }, limit: 5, period: 'weekly' },
      { id: 'smith_whiteIron', item: 'whiteIronChunk', count: 6, cost: { mora: 9000 }, limit: 5, period: 'weekly' },
      { id: 'smith_crystal', item: 'crystalChunk', count: 3, cost: { mora: 18000 }, limit: 4, period: 'weekly' },
      { id: 'smith_starsilver', item: 'starsilver', count: 2, cost: { mora: 24000 }, limit: 3, period: 'weekly', minRank: 8 },
      { id: 'smith_sword', item: 'travelersBlade', count: 1, cost: { mora: 20000 }, limit: 2, period: 'weekly' },
      { id: 'smith_claymore', item: 'ironGreatsword', count: 1, cost: { mora: 20000 }, limit: 2, period: 'weekly' },
      { id: 'smith_bow', item: 'huntersBow', count: 1, cost: { mora: 20000 }, limit: 2, period: 'weekly' },
      { id: 'smith_polearm', item: 'ironSpear', count: 1, cost: { mora: 20000 }, limit: 2, period: 'weekly' },
      { id: 'smith_catalyst', item: 'apprenticeTome', count: 1, cost: { mora: 20000 }, limit: 2, period: 'weekly' },
    ],
  },

  liyueMarket: {
    id: 'liyueMarket', name: '万民堂前市集', keeper: '诚哥', zone: 'liyue',
    desc: '璃月港的集市。这里能买到别处买不到的宴席与仙家吃食。',
    entries: [
      { id: 'ly_qingxin', item: 'qingxin', count: 3, cost: { mora: 6000 }, limit: 5, period: 'daily' },
      { id: 'ly_crystalCore', item: 'crystalCore', count: 3, cost: { mora: 7500 }, limit: 5, period: 'daily' },
      { id: 'ly_mushroomPizza', item: 'mushroomPizza', count: 1, cost: { mora: 3600 }, limit: 4, period: 'daily' },
      { id: 'ly_mintJelly', item: 'mintJelly', count: 1, cost: { mora: 5200 }, limit: 3, period: 'daily' },
      { id: 'ly_adeptus', item: 'adeptusTemptation', count: 1, cost: { mora: 42000 }, limit: 1, period: 'weekly', minRank: 12 },
      { id: 'ly_heroWit', item: 'heroWit', count: 3, cost: { mora: 45000 }, limit: 5, period: 'weekly', minRank: 10 },
    ],
  },

  bargains: {
    id: 'bargains', name: '派蒙的十日谈', keeper: '派蒙', zone: '*',
    desc: '用原石换取树脂与纠缠之缘，用祈愿换来的星辉与星尘换回缘分。摩拉在这里买不到任何东西。',
    entries: [
      // The exchange rate is imported, not typed: the wish route already converts
      // primogems to tickets at this rate when a player is short, and a shop offering a
      // different one would be an arbitrage bug rather than a feature.
      { id: 'bar_wish', item: 'wishTicket', count: 1, cost: { primogem: GEM_PER_WISH }, limit: 0, period: 'permanent' },
      { id: 'bar_resin', item: 'condensedResin', count: 1, cost: { primogem: 60 }, limit: 6, period: 'daily' },
      { id: 'bar_resinPack', item: 'condensedResin', count: 5, cost: { primogem: 300 }, limit: 2, period: 'weekly' },
      // Wish change comes back out here. Monthly caps are what keep it a rebate: 5 tickets a
      // month from 星辉 and 5 from 星尘, so a heap of 3★ weapons is worth something without
      // becoming a wish printer. Everything past the cap has the other two sinks below.
      { id: 'bar_glitterWish', item: 'wishTicket', count: 1, cost: { starglitter: GLITTER_PER_WISH }, limit: 5, period: 'monthly' },
      { id: 'bar_dustWish', item: 'wishTicket', count: 1, cost: { stardust: DUST_PER_WISH }, limit: 5, period: 'monthly' },
      { id: 'bar_dustMora', item: 'mora', count: 10000, cost: { stardust: 15 }, limit: 10, period: 'monthly' },
      // The 星辉 sink that is not a wish: one 4★ weapon a month, priced at just under seven
      // pulls' worth of change, which is roughly what a month of pulling produces.
      { id: 'bar_glitterWeapon', item: 'windriderEdge', count: 1, cost: { starglitter: 34 }, limit: 1, period: 'monthly', minRank: 15 },
    ],
  },

  abyssTrader: {
    id: 'abyssTrader', name: '深渊商人', keeper: '兜帽人', zone: 'abyssTrial', minRank: 10,
    desc: '只收深境里的东西。他说不清自己从哪来，货却是真的。',
    entries: [
      // Barter, not currency: these are the two chase materials the dungeons drop, and
      // trading a heap of the common one for the rare one is the whole point of a
      // monthly limit — it is a floor on bad luck, not a shortcut.
      { id: 'ab_crown', item: 'crownFragment', count: 1, cost: { chaosCore: 20, mora: 50000 }, limit: 1, period: 'monthly', minRank: 18 },
      { id: 'ab_wit', item: 'heroWit', count: 10, cost: { abyssalCrystal: 5, mora: 20000 }, limit: 4, period: 'monthly' },
      { id: 'ab_shard', item: 'agnidusShard', count: 2, cost: { chaosDevice: 8, mora: 8000 }, limit: 3, period: 'monthly' },
      { id: 'ab_frost', item: 'shivadaShard', count: 2, cost: { wolfClaw: 8, mora: 8000 }, limit: 3, period: 'monthly' },
      { id: 'ab_blade', item: 'windriderEdge', count: 1, cost: { heraldsInsignia: 10, mora: 60000 }, limit: 1, period: 'monthly', minRank: 20 },
    ],
  },
};

export const SHOP_IDS = Object.keys(SHOPS);

const ENTRY_INDEX = (() => {
  const m = new Map();
  for (const shop of Object.values(SHOPS)) {
    for (const e of shop.entries) m.set(e.id, { ...e, shopId: shop.id });
  }
  return m;
})();

/** An entry plus its shop id, or null. The only lookup either side should use. */
export function shopEntry(entryId) {
  return ENTRY_INDEX.get(entryId) || null;
}

/** What one entry hands over. Weapons mint equipment; everything else is an item stack. */
export function entryGrant(entry) {
  if (WEAPONS[entry.item]) return { kind: 'weapon', id: entry.item, count: entry.count ?? 1 };
  if (MATERIALS[entry.item]) return { kind: 'item', id: entry.item, count: entry.count ?? 1 };
  return null;
}

/** Cost of `n` purchases, as an item map. Linear — no bulk discount, no escalating price. */
export function entryCost(entry, n = 1) {
  const out = {};
  for (const [id, qty] of Object.entries(entry.cost)) out[id] = qty * n;
  return out;
}

/**
 * How many of `entry` this player could buy right now.
 *
 * `bought` is the count already spent *in the current period* — the caller resolves that,
 * because only the server knows the stored period key. Currency lives on the player
 * record and materials live in the inventory, so both are checked through one accessor.
 */
export function maxBuyable(entry, player, bought = 0, want = 99) {
  if ((entry.minRank ?? 0) > (player.adventureRank ?? 1)) return 0;
  let n = want;
  if (entry.limit) n = Math.min(n, Math.max(0, entry.limit - bought));
  for (const [id, qty] of Object.entries(entry.cost)) {
    if (qty <= 0) continue;
    n = Math.min(n, Math.floor(held(player, id) / qty));
  }
  return Math.max(0, n);
}

/**
 * The three currencies live in columns on the player row, everything else in the
 * inventory table. Both sides of a purchase have to respect that split — paying with
 * mora and being *paid* in wish tickets go through different storage — so the list is
 * exported rather than re-tested with an `if` chain at each call site.
 */
export const CURRENCIES = ['mora', 'primogem', 'wishTicket'];
export function isCurrency(id) { return CURRENCIES.includes(id); }

export function held(player, id) {
  if (isCurrency(id)) return player[id] ?? 0;
  return player.inventory?.[id] ?? 0;
}

/** Whether a shop is open to this player at all — used to grey out a tab, not to gate a buy. */
export function shopUnlocked(shop, player) {
  return (shop.minRank ?? 0) <= (player.adventureRank ?? 1);
}

/**
 * The whole catalogue shaped for a client, with stock resolved.
 *
 * `purchases` maps entryId -> { bought, period }: a row whose stored period key is not the
 * current one has expired and reads as zero, which is the entire reset mechanism.
 */
export function shopView(player, purchases = {}, now = Date.now()) {
  return Object.values(SHOPS).map((shop) => ({
    id: shop.id, name: shop.name, keeper: shop.keeper, zone: shop.zone,
    desc: shop.desc, minRank: shop.minRank ?? 0, unlocked: shopUnlocked(shop, player),
    entries: shop.entries.map((e) => {
      const rec = purchases[e.id];
      const key = periodKey(e.period, now);
      const bought = rec && rec.period === key ? rec.bought : 0;
      return {
        id: e.id, item: e.item, count: e.count ?? 1, cost: e.cost,
        limit: e.limit ?? 0, period: e.period ?? 'permanent',
        minRank: e.minRank ?? 0,
        bought, left: e.limit ? Math.max(0, e.limit - bought) : null,
        resetsAt: periodEndsAt(e.period, now),
        canBuy: maxBuyable(e, player, bought),
      };
    }),
  }));
}
