// Mail: the delivery channel for everything that happens while nobody is looking.
//
// Every reward in the game so far is handed over *synchronously*: a chest pays the hand that
// opened it, a chamber pays at the results screen, a shop trades across a counter. That
// works right up to the first reward whose moment is a clock tick rather than a click — a
// daily sign-in, a weekly ladder payout, a compensation grant for a bug — and there was
// nowhere for those to land. A mailbox is that place, and it is also the only place a
// grant can wait for a player who is offline when it is decided.
//
// Three rules, and the first is the one that makes the rest cheap:
//
//  1. **Period mail is derived, never scheduled.** A row carries a `dedupe` key naming what
//     it is and which period it belongs to (`login:2026-09-05`, `board:w2953`), and a unique
//     index makes "insert it if it is not there" the entire cron. Opening the mailbox is
//     what materialises today's letter. Same trick as the shop's stock counters
//     (`sim/clock.js`), for the same reason: a scheduler is a second source of truth about
//     the clock, and it is the one that breaks when a process restarts at the wrong minute.
//  2. **Attachments are an item map.** `{itemId: qty}`, exactly the shape `repo.addItems`
//     takes and the shop's `cost` uses — so claiming a letter is one call, and mora,
//     primogems and materials need no special cases beyond the currency/column split that
//     already exists everywhere else.
//  3. **Expiry is a filter, not a sweep.** A letter older than `MAIL_TTL_DAYS` stops being
//     listed; nothing deletes it on a timer. An unclaimed attachment expiring with it is
//     intended, and it is why the client has to shout about unread mail.

import { MATERIALS } from './items.js';
import { periodKey } from '../sim/clock.js';

export const MAIL_TTL_DAYS = 30;

/** How many letters one mailbox holds. Older ones fall off the bottom, oldest first. */
export const MAIL_CAP = 50;

/**
 * The seven-day sign-in rotation, indexed by the calendar day — *not* by a login streak.
 *
 * A streak needs a stored counter, which is a second piece of state about the same clock the
 * period key already describes, and the two disagree the first time a player is offline
 * across a boundary (does a missed day reset it? did the reset run?). Keying off the day
 * itself gives the same "something different every day" feel, costs no state, and cannot
 * desync — every player who logs in on the same server-day gets the same letter.
 */
export const LOGIN_GIFTS = [
  { attach: { mora: 20000 }, note: '协会的例行补贴。' },
  { attach: { adventurerXp: 5 }, note: '拿去练练手。' },
  { attach: { primogem: 60 }, note: '这个月的余款，别乱花。' },
  { attach: { condensedResin: 2 }, note: '浓缩过的，省着用。' },
  { attach: { heroWit: 2 }, note: '大英雄的经验，很贵的。' },
  { attach: { mora: 30000, sweetMadame: 3 }, note: '顺手做了点吃的。' },
  { attach: { primogem: 120, wishTicket: 1 }, note: '周末了，去试试运气吧。' },
];

/**
 * Weekly ladder payout by rank. This is the first thing that reads `leaderboard` for
 * anything other than display — a ladder nobody is paid for is a scoreboard, not a system.
 */
export const BOARD_TIERS = [
  { max: 1, label: '榜首', attach: { primogem: 300, mora: 100000, heroWit: 5 } },
  { max: 3, label: '前三', attach: { primogem: 200, mora: 60000, heroWit: 3 } },
  { max: 10, label: '前十', attach: { primogem: 120, mora: 40000, heroWit: 2 } },
  { max: 50, label: '前五十', attach: { primogem: 60, mora: 20000 } },
];

/** Everyone who scored at all gets something; a payout only the top 50 see is invisible. */
export const BOARD_CONSOLATION = { label: '参与', attach: { primogem: 20, mora: 10000 } };

export function boardTier(rank) {
  if (!rank || rank < 1) return null;
  return BOARD_TIERS.find((t) => rank <= t.max) || BOARD_CONSOLATION;
}

/**
 * Today's sign-in letter.
 *
 * The day index comes out of the daily period key rather than `Date`: the key is already the
 * thing that decides which server-day it is (04:00 UTC+8), and computing the rotation from
 * anything else would let the letter and its dedupe key disagree about the date.
 */
export function loginMail(now = Date.now()) {
  const key = periodKey('daily', now);
  const [y, m, d] = key.split('-').map(Number);
  const dayIdx = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const gift = LOGIN_GIFTS[((dayIdx % LOGIN_GIFTS.length) + LOGIN_GIFTS.length) % LOGIN_GIFTS.length];
  return {
    dedupe: `login:${key}`,
    sender: '冒险家协会 · 凯瑟琳',
    subject: `每日签到 · ${key}`,
    body: `旅行者，今天的补给已经备好了。${gift.note}`,
    attach: gift.attach,
  };
}

/** Last week's ladder payout, or null for a player who never scored. */
export function boardMail(rank, score, now = Date.now()) {
  const tier = boardTier(rank);
  if (!tier || !score) return null;
  // Keyed by the week that is *ending*, so the letter says which week it paid for and a
  // second call in the same week finds the row already there.
  //
  // Known simplification: the board is not snapshotted, so the rank paid is the player's
  // standing at the moment they first open the mailbox in the new week, not at the boundary.
  // Snapshotting means a weekly job, which is the one thing this module exists to avoid; the
  // honest cost is that logging in earlier can pay a slightly better tier.
  const key = periodKey('weekly', now);
  return {
    dedupe: `board:${key}`,
    sender: '冒险家协会 · 排行榜',
    subject: `上周结算 · ${tier.label}`,
    body: `你在上周的冒险经验榜上排到第 ${rank} 位（${score} 分）。这是协会的奖励，收好。`,
    attach: tier.attach,
  };
}

export function welcomeMail() {
  return {
    dedupe: 'welcome',
    sender: '冒险家协会 · 凯瑟琳',
    subject: '欢迎来到提瓦特',
    body: '初次见面，旅行者。这是协会给新人的见面礼——先去蒙德城逛逛，'
      + '有委托要接的时候记得来找我。附件三十天内领取有效。',
    attach: { mora: 30000, primogem: 300, adventurerXp: 5, condensedResin: 2 },
  };
}

/** A one-off letter from the system, for compensation and quest hand-offs. */
export function systemMail(subject, body, attach = {}, dedupe = null) {
  return { dedupe, sender: '系统', subject, body, attach };
}

/** Attachment lines shaped for display: `[{ id, name, icon, count }]`. */
export function attachLines(attach = {}) {
  return Object.entries(attach)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => ({
      id, count: n,
      name: MATERIALS[id]?.name || id,
      icon: MATERIALS[id]?.icon || '·',
    }));
}

export function hasAttachments(mail) {
  return attachLines(mail?.attach).length > 0;
}
