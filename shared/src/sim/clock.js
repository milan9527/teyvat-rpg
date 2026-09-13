// Server-day arithmetic: the one place that decides when "today" rolls over.
//
// Anything with a daily/weekly/monthly limit needs two things that must never disagree:
// which bucket a purchase counts against, and when the next bucket starts. Storing a
// "resets at" timestamp gives you two sources of truth — the stored deadline and the
// clock — and they drift the moment a row is written by an older build, a player is
// offline across a boundary, or two processes disagree about the hour. So nothing here
// stores a deadline: a count carries the *key of the period it belongs to*, and a count
// whose key is not the current key reads as zero. Reset then costs nothing, happens
// everywhere at once, and cannot be forgotten.
//
// The boundary is 04:00 at UTC+8, which is what the genre trained players to expect: a
// session that runs past midnight is still "today", and the reset lands while nobody is
// playing. It is deliberately *not* the host's local midnight — the server and every
// client have to agree, and they are not in the same timezone.

export const RESET_HOUR = 4;
export const RESET_TZ_OFFSET_MIN = 480;   // UTC+8

export const PERIODS = ['permanent', 'daily', 'weekly', 'monthly'];

/** Milliseconds since the epoch, shifted into "server local" time and back by the reset hour. */
function shifted(now) {
  return now + RESET_TZ_OFFSET_MIN * 60_000 - RESET_HOUR * 3_600_000;
}

/**
 * The bucket a purchase made at `now` belongs to.
 *
 * Keys are human-readable on purpose: a support question about a stuck stock limit is
 * answered by reading the row, and `'2026-09-05'` says more than an epoch second does.
 */
export function periodKey(period, now = Date.now()) {
  if (period === 'permanent' || !period) return '*';
  const d = new Date(shifted(now));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (period === 'daily') return `${y}-${m}-${day}`;
  if (period === 'monthly') return `${y}-${m}`;
  if (period === 'weekly') {
    // Monday-based week index counted from the epoch, not an ISO week number: the ISO
    // rules for week 1 need a year boundary special case that buys nothing here, and a
    // running index cannot produce two different weeks with the same key.
    const dayIdx = Math.floor(shifted(now) / 86_400_000);
    return `w${Math.floor((dayIdx - 3) / 7)}`;      // epoch day 0 was a Thursday
  }
  return '*';
}

/** When the current period ends, as an epoch ms — for a countdown, never for a limit check. */
export function periodEndsAt(period, now = Date.now()) {
  if (period === 'permanent' || !period) return null;
  const s = shifted(now);
  const d = new Date(s);
  let next;
  if (period === 'daily') {
    next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  } else if (period === 'monthly') {
    next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  } else if (period === 'weekly') {
    const dayIdx = Math.floor(s / 86_400_000);
    const intoWeek = ((dayIdx - 3) % 7 + 7) % 7;
    next = (dayIdx - intoWeek + 7) * 86_400_000;
  } else {
    return null;
  }
  return next - RESET_TZ_OFFSET_MIN * 60_000 + RESET_HOUR * 3_600_000;
}

/** Human countdown for a panel: "3天 4小时" / "12小时" / "48分钟". */
export function untilText(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分`;
}
