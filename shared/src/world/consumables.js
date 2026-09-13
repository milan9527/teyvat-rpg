// What a dish would actually do, right now.
//
// Eating is the only action in the game that spends an item *before* anyone asks whether
// the item has anything to do. Both hosts used to decide that inline and identically:
// check `alive`, decrement, then run `if (def.heal)` / `if (def.buff)` / `if (def.revive)`
// over whatever the item happens to carry. That is fine for the buff dishes and wrong for
// the other two thirds of the menu:
//
//   * 北地烟熏鸡 at full health healed `0` and was gone anyway — 3400 HP of soup poured on
//     the floor, with no message, because `entity.heal()` returning 0 only suppresses the
//     floating number.
//   * 提神醒脑的汤 carries `revive` and nothing else, so eating it while standing up did
//     *nothing at all* — the `if (def.revive && !entity.alive)` branch simply did not run.
//     A player who ate it to top up lost the one item that could have picked them up.
//
// In solo mode it is the worse half of the split that spends: `localSocket` decrements
// through `POST /api/inventory/use` (the save is the server's) and only then applies the
// effect to the live entity, so a no-op eat is durable — the item is gone from the database.
//
// So the question "would this do anything?" gets exactly one implementation, and both hosts
// ask it before they spend. It takes a plain `{ hp, maxHp, alive }` rather than an entity so
// that the inventory panel can ask it too, and grey the button out with the reason instead
// of letting the player find out by losing a dish.
//
// `POST /api/inventory/use` deliberately stays a raw decrement: it is the door the hosts
// spend through, and it has no live entity to judge against. The gate lives where the
// health bar does.

/** Effect keys a consumable may carry. Anything else is authored data nothing reads. */
export const CONSUMABLE_EFFECTS = Object.freeze({
  heal:   'world/consumables.consumableEffect -> entity.heal（生命值未满时）',
  buff:   'world/consumables.consumableEffect -> entity.buffs（kind:food，一次只留一个）',
  revive: 'world/consumables.consumableEffect -> entity.revive（仅在倒下时）',
  resin:  'routes/player.js POST /api/inventory/use（纯账号状态，走菜单而不是战斗）',
});

/**
 * Why a consumable cannot be eaten right now, or `null` if it can.
 *
 * The strings are error codes the client already translates (`client/src/net/api.js`),
 * because a refusal the player cannot read is the same as no refusal at all.
 */
export function consumableRefusal(def, who) {
  if (!def || def.kind !== 'consumable') return 'not_consumable';
  if (def.resin) return 'use_via_menu';
  if (!who) return 'not_in_zone';
  const alive = who.alive !== false;
  if (!alive) return def.revive ? null : 'is_downed';
  // Standing up: `revive` is spent, `heal` needs a wound, `buff` always lands.
  if (def.buff) return null;
  if (def.heal) return who.hp < who.maxHp - 1 ? null : 'hp_full';
  return 'not_downed';
}

/**
 * The parts of `def` that apply to `who` — the same three branches both hosts run, minus
 * the ones that would be no-ops. `refusal` being set means "do not spend this".
 */
export function consumableEffect(def, who) {
  const refusal = consumableRefusal(def, who);
  if (refusal) return { refusal, heal: null, buff: null, revive: null };
  const alive = who.alive !== false;
  return {
    refusal: null,
    revive: !alive && def.revive ? def.revive : null,
    heal: alive && def.heal && who.hp < who.maxHp - 1 ? def.heal : (!alive && def.heal ? def.heal : null),
    buff: def.buff || null,
  };
}
