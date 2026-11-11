/**
 * Working-day and time-zone helpers for reminder v2 (fast track, Task D1).
 *
 * Every calculation is done on the person's LOCAL calendar date (IANA zone,
 * via Intl), never on the server's clock and never by adding 24h to an
 * instant — so daylight-saving changes neither skip nor repeat a day, and
 * 11pm Pacific on Tuesday is still Tuesday even though UTC is on Wednesday.
 *
 * lib/pacificTime.ts is unchanged and still used by v1 code.
 *
 * TODO(holidays): business days are Mon–Fri only. Studio holidays are not
 * skipped yet; add a holiday list (reminders_v2 settings) when the client
 * confirms which days the studio is closed.
 */

export const DEFAULT_TZ = 'America/Los_Angeles';

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** A zone Intl accepts, or the studio default. */
export function safeZone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** The calendar date in `tz` at that instant, as YYYY-MM-DD. */
export function localDateFor(date: Date, tz: string = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: safeZone(tz), year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Day of the week (0 = Sunday … 6 = Saturday) in `tz` at that instant. */
export function localWeekday(date: Date, tz: string = DEFAULT_TZ): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: safeZone(tz), weekday: 'short' }).format(date);
  return WEEKDAYS[name] ?? 0;
}

/** Monday–Friday in `tz`. TODO(holidays). */
export function isBusinessDay(date: Date, tz: string = DEFAULT_TZ): boolean {
  const day = localWeekday(date, tz);
  return day >= 1 && day <= 5;
}

// ---- calendar-date arithmetic (YYYY-MM-DD strings, zone-free) ----

/** Noon UTC of a calendar date: a safe anchor for stepping whole days. */
const anchor = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
function shiftYmd(ymd: string, days: number): string {
  const d = anchor(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return ymdOf(d);
}
const ymdWeekday = (ymd: string) => anchor(ymd).getUTCDay();
const ymdIsBusinessDay = (ymd: string) => {
  const day = ymdWeekday(ymd);
  return day >= 1 && day <= 5;
};

/** Minutes `tz` is ahead of UTC at that instant (negative west of Greenwich). */
function offsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - (date.getTime() - date.getMilliseconds())) / 60_000);
}

/** The instant whose wall clock in `tz` reads `ymd` at the same time of day as `like`. */
function sameWallTimeOn(ymd: string, like: Date, tz: string): Date {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(like);
  const guess = new Date(`${ymd}T${time}Z`);
  // Two passes settle the offset even on a daylight-saving changeover day.
  let result = new Date(guess.getTime() - offsetMinutes(guess, tz) * 60_000);
  result = new Date(guess.getTime() - offsetMinutes(result, tz) * 60_000);
  return new Date(result.getTime() + like.getMilliseconds());
}

/**
 * `n` business days after (or, for negative n, before) `date`, at the same
 * local time of day. Weekends are stepped over: Friday + 1 → Monday, and
 * Saturday + 1 → Monday (the first business day after it).
 */
export function addBusinessDays(date: Date, n: number, tz: string = DEFAULT_TZ): Date {
  const zone = safeZone(tz);
  let ymd = localDateFor(date, zone);
  const step = n >= 0 ? 1 : -1;
  let remaining = Math.abs(Math.trunc(n));
  while (remaining > 0) {
    ymd = shiftYmd(ymd, step);
    if (ymdIsBusinessDay(ymd)) remaining -= 1;
  }
  return sameWallTimeOn(ymd, date, zone);
}

/**
 * Business days from `a`'s local date to `b`'s local date: the business days
 * strictly after `a` up to and including `b`. Negative when `b` is earlier.
 *
 *   due Friday, checked Monday   → 1   (not 3)
 *   due Friday, checked Saturday → 0
 *   due Thursday, checked Monday → 2
 *   same day                     → 0
 */
export function businessDaysBetween(a: Date, b: Date, tz: string = DEFAULT_TZ): number {
  const zone = safeZone(tz);
  const from = localDateFor(a, zone);
  const to = localDateFor(b, zone);
  if (from === to) return 0;
  const forward = from < to;
  const end = forward ? to : from;
  let cursor = forward ? from : to;
  let count = 0;
  while (cursor < end) {
    cursor = shiftYmd(cursor, 1);
    if (ymdIsBusinessDay(cursor)) count += 1;
  }
  return forward ? count : -count;
}

export interface LocalTime {
  timezone: string;
  /** YYYY-MM-DD in the person's zone. */
  date: string;
  /** HH:MM, 24-hour, in the person's zone. */
  time: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  isBusinessDay: boolean;
}

/** Where a person's clock is right now (or at `now`), from profiles.timezone. */
export function localTimeFor(profile: { timezone?: string | null } | null | undefined, now: Date = new Date()): LocalTime {
  const timezone = safeZone(profile?.timezone);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(now);
  const weekday = localWeekday(now, timezone);
  return { timezone, date: localDateFor(now, timezone), time, weekday, isBusinessDay: weekday >= 1 && weekday <= 5 };
}
