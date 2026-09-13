// Wire protocol shared by client and server.

export const PROTOCOL_VERSION = 3;
export const TICK_RATE = 20;              // server sim ticks / second
export const TICK_MS = 1000 / TICK_RATE;
export const SNAPSHOT_RATE = 10;          // full state broadcasts / second
export const CLIENT_SEND_RATE = 15;       // input packets / second

/** client -> server */
export const C2S = {
  HELLO: 'hello',
  JOIN_ZONE: 'joinZone',
  INPUT: 'input',
  ATTACK: 'attack',
  SKILL: 'skill',
  BURST: 'burst',
  SWITCH_CHAR: 'switchChar',
  INTERACT: 'interact',
  CHAT: 'chat',
  PING: 'ping',
  PARTY_INVITE: 'partyInvite',
  PARTY_ACCEPT: 'partyAccept',
  PARTY_LEAVE: 'partyLeave',
  REVIVE: 'revive',      // stand up where you fell (spends a 提神醒脑的汤), or pick a teammate up
  RESPAWN: 'respawn',    // give up and return to the nearest anchor you have activated
  USE_ITEM: 'useItem',
  START_CHAMBER: 'startChamber',
  EMOTE: 'emote',
  MARK: 'mark',
};

/** server -> client */
export const S2C = {
  WELCOME: 'welcome',
  ZONE_STATE: 'zoneState',
  SNAPSHOT: 'snapshot',
  PLAYER_JOIN: 'playerJoin',
  PLAYER_LEAVE: 'playerLeave',
  DAMAGE: 'damage',
  ENEMY_DIED: 'enemyDied',
  ENEMY_SPAWN: 'enemySpawn',
  ENEMY_ATTACK: 'enemyAttack',
  PLAYER_ACTION: 'playerAction',
  CHAT: 'chat',
  PONG: 'pong',
  LOOT: 'loot',
  PARTY: 'party',
  ERROR: 'error',
  QUEST_UPDATE: 'questUpdate',
  CHAMBER: 'chamber',
  PLAYER_DOWN: 'playerDown',
  REVIVED: 'revived',
  EMOTE: 'emote',
  MARK: 'mark',
  INTERACT_RESULT: 'interactResult',
  BUFF: 'buff',
};

export const ACTION = {
  idle: 0, walk: 1, run: 2, sprint: 3, jump: 4, fall: 5,
  attack1: 6, attack2: 7, attack3: 8, attack4: 9, attack5: 10,
  charged: 11, skill: 12, burst: 13, hit: 14, down: 15,
  climb: 16, glide: 17, swim: 18, aim: 19, dash: 20, plunge: 21, gather: 22, sit: 23,
};

export const ACTION_NAMES = Object.fromEntries(Object.entries(ACTION).map(([k, v]) => [v, k]));

/** Compact snapshot field order (documented for readability; JSON is used on the wire). */
export const MAX_PLAYERS_PER_ZONE = 8;
export const AOI_RADIUS = 130;  // area-of-interest for entity streaming

export function nowMs() {
  return Date.now();
}
