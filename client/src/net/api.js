// REST client.
//
// Every gameplay mutation that must survive a disconnect (levelling, equipping,
// wishes, chests, quests) goes through HTTP; only per-frame movement and combat
// go over the socket. That split is deliberate: HTTP gives us the server's
// authoritative player document back on every call, so the UI never has to guess
// what the new state is after an action.
//
// The token lives in localStorage so a refresh resumes the same account. Guest
// accounts are real accounts server-side, they just have a generated login.

const TOKEN_KEY = 'teyvat.token';
const NAME_KEY = 'teyvat.nickname';

export class ApiError extends Error {
  constructor(status, body) {
    // Prefer the server's machine-readable code — the UI maps a handful of them
    // ('rank_too_low', 'not_enough_currency') to specific messages.
    super(body?.error || `http_${status}`);
    this.status = status;
    this.body = body || {};
    this.code = body?.error || `http_${status}`;
  }
}

/** Human text for the error codes the server can return. */
// Every key here is a code the server actually emits — the list was taken from
// the routes rather than invented, because a message that never fires is worse
// than no message: it hides the real failure behind a plausible-looking string.
const ERROR_TEXT = {
  // auth
  bad_credentials: '用户名或密码不正确',
  username_taken: '该用户名已被注册',
  banned: '该账号已被封禁',
  guest_failed: '创建旅行者失败，请重试',
  unauthorized: '登录已过期，请重新登录',
  too_many_requests: '操作太频繁，请稍后再试',
  invalid_input: '输入有误',
  no_player: '找不到角色数据',
  not_found: '找不到目标',

  // progression
  // Shared by characters (ascension cap) and weapons (rarity ceiling / adventure rank),
  // so it must not name a mechanism only one of them has.
  level_capped: '已达到当前等级上限',
  need_ascension: '需要先突破',
  max_ascension: '已完成全部突破',
  max_talent: '天赋已满级',
  bad_talent: '没有这个天赋',
  level_too_low: '角色等级不足',
  no_materials: '材料不足',
  missing_material: '缺少突破材料',
  not_enough_mora: '摩拉不足',
  not_enough_currency: '原石或纠缠之缘不足',
  character_not_owned: '尚未获得该角色',
  no_valid_characters: '队伍中没有可用角色',

  // inventory / equipment
  item_not_found: '没有这个物品',
  not_a_weapon: '这不是武器',
  not_an_artifact: '这不是圣遗物',
  not_consumable: '这个物品无法使用',
  // Both hosts refuse an eat that would do nothing (`shared/world/consumables.js`), and
  // the bag panel prints the same line under the 使用 button before it is pressed.
  hp_full: '生命值已满，留着受伤时再吃',
  wrong_slot: '部位不匹配',
  wrong_weapon_type: '武器类型不匹配',
  nothing_salvageable: '没有可分解的物品',
  none_left: '数量不足',
  already_max: '已经是满级了',
  no_usable_fodder: '没有可用的强化素材（装备中和已锁定的不算）',
  not_enough_xp: '强化经验不够升一级',
  no_usable_ore: '没有可用的矿石（铁块／白铁块／水晶块／星银矿石）',
  no_usable_dupe: '没有可用的同名武器（装备中和已锁定的不算）',

  // cooking
  no_such_recipe: '没有这个食谱',
  recipe_locked: '冒险等阶不足，还学不会这道菜',
  missing_ingredients: '食材不足',
  use_via_menu: '请在背包中使用',
  item_rate_limited: '吃得太快了，缓一缓',

  // world
  bad_zone: '没有这个区域',
  rank_too_low: '冒险等阶不足，无法前往',
  already_opened: '这个宝箱已经开过了',
  already_solved: '这个谜题已经解开了',
  already_lit: '这座方碑已经点亮了',
  no_such_monument: '找不到这座方碑',
  // `locked` covers both forms of a chest's `requires`: a puzzle to solve, or a dungeon to
  // clear. The prompt on the chest itself says which one, so this only has to say "not yet".
  locked: '还打不开：先解开封印或通关秘境',
  not_regrown: '这里的资源还没有长回来',
  // 探索度 milestones: a 秘境 has no percentage, and a lost race has already paid once.
  no_exploration: '秘境没有探索度',
  already_claimed: '这份探索奖励已经领过了',
  // Answered by three routes (mail, achievements, exploration) and translated by none of them
  // until now — `errorText` falls back to the raw code, so a mistimed 一键领取 said
  // 「nothing_to_claim」 in a toast.
  nothing_to_claim: '没有可领取的奖励',

  // 探索派遣. Five of these six come out of the one shared rule (`expeditionEntry`), so the
  // panel dims a row with the same sentence the route answers a click with — see the 秘境
  // 层数锁 section in README for why the UI has to be a *reader* of the rule and not a
  // second copy of it. `rank_too_low` is shared with 传送 above and needs no second wording.
  no_such_expedition: '没有这个派遣目的地',
  bad_hours: '没有这个派遣时长',
  character_not_owned: '你还没有这个角色',
  character_busy: 'Ta 已经在派遣中了',
  no_free_slot: '派遣位已满，先领取已完成的派遣',
  not_finished: '派遣还没有结束',
  no_such_chest: '找不到这个宝箱',
  no_such_puzzle: '找不到这个谜题',
  no_such_poi: '找不到这个地点',
  // Fast travel only reaches anchors you have activated; the map pin already shows the lock,
  // so this is the belt to that braces (a stale map, a second device).
  anchor_locked: '这个锚点还没有激活，先走过去点亮它',
  no_such_anchor: '这里不是可以传送的锚点',
  no_such_npc: '找不到这个人',
  no_such_chamber: '找不到这个间',
  previous_floor_locked: '需要先通过前一层',
  // Restarting is what the sim refuses — in co-op it would be somebody else's run being
  // thrown away. The map panel's floor list now marks the live floor 进行中 and refuses the
  // click with this same wording (`chamberEntry`), so this is the belt to that brace: a stale
  // panel, a second device, or a teammate whose click raced the snapshot.
  chamber_in_progress: '挑战正在进行中，先打完这一层',
  not_a_dungeon: '这里不是秘境',
  too_fast: '操作太快了，稍等一下',
  no_such_enemy: '没有这种敌人',
  not_in_zone: '这个区域没有这种敌人',
  use_socket: '你正在联机世界中，战利品由服务器结算',

  // gateway
  // Two callers: reviving a teammate who is standing, and eating 提神醒脑的汤 with nobody down.
  not_downed: '没有倒下的角色',
  too_far: '距离太远',
  no_revive_item: '没有可用的复苏道具',
  no_stamina: '体力不足',
  no_energy: '元素能量不足',
  on_cooldown: '技能冷却中',
  cannot_switch: '无法切换到这个角色',
  is_downed: '角色已倒下',
  solo_no_party: '单机模式下无法组队',

  // social
  no_such_player: '找不到这位旅行者',
  not_yourself: '不能添加自己为好友',
  already_friends: '你们已经是好友了',
  request_pending: '已经发送过申请了',
  friends_full: '好友列表已满',
  no_request: '这条好友申请已经不在了',
  not_friends: '你们还不是好友',
  friend_offline: 'Ta 现在不在线',
  // A teammate *can* follow into a 秘境 now, so this refusal means one of the two cases that
  // are still closed: Ta 在单机（模拟跑在 Ta 自己的浏览器里，谁都进不去），或者那座秘境
  // 不是你们这支队伍的。
  friend_is_solo: 'Ta 在单人世界，或在你队伍之外的秘境里',
  world_full: '那个世界已经满了',

  // transport
  network: '网络连接失败',
  http_400: '请求有误',
  http_401: '登录已过期，请重新登录',
  http_403: '条件不满足',
  http_404: '找不到目标',
  http_409: '状态已改变，请刷新',
  http_429: '操作太快了，稍等一下',
  http_500: '服务器出错了',
};

export function errorText(err) {
  if (!err) return '';
  const code = err.code || err.message;
  return ERROR_TEXT[code] || code;
}

export class Api {
  constructor(base = '') {
    this.base = base;
    this.token = localStorage.getItem(TOKEN_KEY) || null;
    this.nickname = localStorage.getItem(NAME_KEY) || null;
    this.playerId = null;
  }

  get authed() { return !!this.token; }

  setToken(token, nickname, playerId) {
    this.token = token || null;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    if (nickname) {
      this.nickname = nickname;
      localStorage.setItem(NAME_KEY, nickname);
    }
    if (playerId) this.playerId = playerId;
  }

  clearToken() {
    this.token = null;
    localStorage.removeItem(TOKEN_KEY);
  }

  async req(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // Network-level failure (server down, offline). Surface it as a 0 so
      // callers can distinguish it from a rejected request.
      throw new ApiError(0, { error: 'network' });
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (!res.ok) {
      // A dead token is unrecoverable — drop it so the next boot shows login.
      if (res.status === 401) this.clearToken();
      throw new ApiError(res.status, data);
    }
    return data;
  }

  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }

  /* ------------------------------------------------------------- auth -- */

  async register(username, password, nickname) {
    const r = await this.post('/api/register', { username, password, nickname });
    this.setToken(r.token, r.nickname, r.playerId);
    return r;
  }

  async login(username, password) {
    const r = await this.post('/api/login', { username, password });
    this.setToken(r.token, r.nickname, r.playerId);
    return r;
  }

  async guest() {
    const r = await this.post('/api/guest', {});
    this.setToken(r.token, r.nickname, r.playerId);
    return r;
  }

  /* ----------------------------------------------------------- player -- */

  playerState() { return this.get('/api/player/state'); }
  save(patch) { return this.post('/api/player/save', patch); }
  setParty(party) { return this.post('/api/player/party', { party }); }

  levelUp(charId, materials) { return this.post('/api/char/levelup', { charId, materials }); }
  ascend(charId) { return this.post('/api/char/ascend', { charId }); }
  talent(charId, which) { return this.post('/api/char/talent', { charId, which }); }
  equip(charId, uid, slot) { return this.post('/api/char/equip', { charId, uid, slot }); }
  unequip(charId, slot) { return this.post('/api/char/unequip', { charId, slot }); }
  autoEquip(charId) { return this.post('/api/char/autoequip', { charId }); }

  useItem(itemId, count = 1) { return this.post('/api/inventory/use', { itemId, count }); }
  salvage(uids) { return this.post('/api/inventory/salvage', { uids }); }
  enhanceArtifact(uid, fodder) { return this.post('/api/inventory/enhance', { uid, fodder }); }
  lockItem(uid, locked) { return this.post('/api/inventory/lock', { uid, locked }); }
  levelUpWeapon(uid, ore) { return this.post('/api/inventory/weapon/levelup', { uid, ore }); }
  refineWeapon(uid, fodder) { return this.post('/api/inventory/weapon/refine', { uid, fodder }); }
  cook(recipeId, count = 1) { return this.post('/api/player/cook', { recipeId, count }); }

  /* ----------------------------------------------------------- quests -- */

  // No `questEvent` and no `resetDailies`: quests advance through the route that owns the
  // action (`openChest`, `killEnemy`, `cook`, …), which is the only place the server can check
  // that the action happened, and the dailies roll over by period key on the server. Both
  // methods existed here and were called by nothing — see the comment above `/api/quests` in
  // `server/src/routes/player.js` for what they were paying out.
  quests() { return this.get('/api/quests'); }

  /* ------------------------------------------------------------ world -- */

  zones() { return this.get('/api/zones'); }
  openChest(zone, poiId) { return this.post('/api/world/chest', { zone, poiId }); }
  // `nodeId` is one monument of the puzzle's ring; the server pays only for the last one.
  solvePuzzle(zone, poiId, nodeId) { return this.post('/api/world/puzzle', { zone, poiId, nodeId }); }
  unlock(zone, poiId) { return this.post('/api/world/unlock', { zone, poiId }); }
  // No amount and no step list on the wire: the route derives what is owed from the same rows
  // the map panel derives the button's label from (`shared/data/exploration.js`).
  exploreClaim(zone) { return this.post('/api/world/explore/claim', { zone }); }
  gather(zone, nodeId, kind) { return this.post('/api/world/gather', { zone, nodeId, kind }); }
  teleport(zone, poiId) { return this.post('/api/world/teleport', { zone, poiId }); }
  talk(zone, npcId) { return this.post('/api/world/talk', { zone, npcId }); }
  chamberResult(zone, floor, time) { return this.post('/api/world/chamber', { zone, floor, time }); }
  // Only 单机 calls this: online, the gateway witnesses the kill and pays for it over
  // the socket. `level` is a ceiling request — the route clamps it to the hardest place
  // the zone tables put that enemy, so it cannot be used to buy a boss's loot.
  killEnemy(zone, enemyId, level) { return this.post('/api/world/kill', { zone, enemyId, level }); }

  /* ------------------------------------------------------------- wish -- */

  wishPools() { return this.get('/api/wish/pools'); }
  wishHistory() { return this.get('/api/wish/history'); }
  pull(pool, count) { return this.post('/api/wish/pull', { pool, count }); }

  /* -------------------------------------------------------------- shop -- */

  // The catalogue is fetched, never derived from `shared/data/shop.js` alone: the table
  // says what is for sale, only the server knows what is left in the current period.
  shop() { return this.get('/api/shop'); }
  shopBuy(entryId, count = 1) { return this.post('/api/shop/buy', { entryId, count }); }

  // `ids` omitted means "all of them" on every one of these; the server decides which rows
  // that covers, because it is the only side that knows what is still unclaimed.
  mail() { return this.get('/api/mail'); }
  mailClaim(ids = null) { return this.post('/api/mail/claim', ids ? { ids } : {}); }
  mailSeen(ids = null) { return this.post('/api/mail/seen', ids ? { ids } : {}); }
  mailDelete(ids = null) { return this.post('/api/mail/delete', ids ? { ids } : {}); }

  achievements() { return this.get('/api/achievements'); }
  achClaim(id = null) { return this.post('/api/achievements/claim', id ? { id } : {}); }

  /* -------------------------------------------------------- 探索派遣 -- */

  // The snapshot carries the server's `now` alongside the rows, and the panel keeps the
  // difference: a browser clock that is two minutes fast would otherwise count a trip down
  // to 可领取 and then be told 「派遣还没有结束」.
  expeditions() { return this.get('/api/expeditions'); }
  expeditionStart(destId, charId, hours) {
    return this.post('/api/expedition/start', { destId, charId, hours });
  }
  // `slot` omitted means every finished trip, like `mailClaim`/`achClaim` above.
  expeditionClaim(slot = null) {
    return this.post('/api/expedition/claim', slot === null ? {} : { slot });
  }

  /* ---------------------------------------------------------- social --- */

  friends() { return this.get('/api/social/friends'); }
  // Either key works; the panel sends a nickname when the player typed one and an id
  // when the row they clicked already carries it.
  friendRequest(target) {
    return this.post('/api/social/request',
      typeof target === 'number' ? { playerId: target } : { nickname: String(target) });
  }
  friendAccept(playerId) { return this.post('/api/social/accept', { playerId }); }
  friendRemove(playerId) { return this.post('/api/social/remove', { playerId }); }

  /* ------------------------------------------------------------ meta --- */

  leaderboard(which = 'score') { return this.get(`/api/leaderboard?which=${encodeURIComponent(which)}`); }
  online() { return this.get('/api/online'); }
  recentChat(channel = 'world') { return this.get(`/api/chat/recent?channel=${encodeURIComponent(channel)}`); }
  health() { return this.get('/api/health'); }
  serverStats() { return this.get('/api/stats'); }
}

export const api = new Api();
