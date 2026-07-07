/**
 * Timezone-aware calendar windows without date libraries.
 *
 * The reporting window is always the previous COMPLETE calendar period in the
 * configured IANA timezone (frozen product decision): reproducible under cron
 * drift and reruns — no gaps or double-counting between consecutive runs.
 */
import { ActionError } from '../errors.js';
import type { Period } from '../schema/types.js';

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  /** ISO day of week: 1=Mon … 7=Sun */
  dow: number;
}

export interface ReportWindow {
  /** UTC instant, inclusive */
  startUtcMs: number;
  /** UTC instant, exclusive */
  endUtcMs: number;
  /** Local calendar date YYYY-MM-DD, inclusive */
  startDate: string;
  /** Local calendar date YYYY-MM-DD, inclusive (day before the exclusive bound) */
  endDate: string;
  period: Period;
  timezone: string;
}

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
};

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(timeZone: string): Intl.DateTimeFormat {
  let fmt = dtfCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short'
    });
    dtfCache.set(timeZone, fmt);
  }
  return fmt;
}

export function assertValidTimezone(timeZone: string): void {
  try {
    dtf(timeZone);
  } catch {
    throw new ActionError('E_BAD_INPUT', `Invalid IANA timezone: "${timeZone}"`, [
      'Use an identifier like "UTC", "America/Montevideo" or "Europe/Madrid".'
    ]);
  }
}

export function localParts(utcMs: number, timeZone: string): LocalParts {
  const parts = dtf(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    // Intl may render midnight as "24" with some ICU versions; normalize.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    dow: WEEKDAY_TO_ISO[get('weekday')] ?? 0
  };
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const p = localParts(utcMs, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * UTC instant of local midnight for the given calendar date.
 * Two-pass offset resolution handles DST transitions; when midnight does not
 * exist (spring-forward at 00:00, e.g. America/Santiago), rolls forward to
 * the first valid instant of the requested day.
 */
export function zonedMidnightUtcMs(year: number, month: number, day: number, timeZone: string): number {
  const naive = Date.UTC(year, month - 1, day);
  let utc = naive - zoneOffsetMs(naive, timeZone);
  const refined = naive - zoneOffsetMs(utc, timeZone);
  if (refined !== utc) utc = refined;
  // Skipped-midnight guard: if we landed on the previous local day, advance
  // hour by hour (bounded) until we reach the requested calendar date.
  for (let i = 0; i < 4; i += 1) {
    const local = localParts(utc, timeZone);
    if (local.year === year && local.month === month && local.day === day) break;
    if (Date.UTC(local.year, local.month - 1, local.day) < naive) utc += 3_600_000;
    else break;
  }
  return utc;
}

/** Pure calendar-space day arithmetic (no timezone involved). */
export function addDaysYmd(
  ymd: { year: number; month: number; day: number },
  days: number
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function formatYmd(ymd: { year: number; month: number; day: number }): string {
  const mm = String(ymd.month).padStart(2, '0');
  const dd = String(ymd.day).padStart(2, '0');
  return `${ymd.year}-${mm}-${dd}`;
}

export function parseYmd(s: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new ActionError('E_CUSTOM_DATES', `Invalid date "${s}" — expected YYYY-MM-DD.`);
  const ymd = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const roundTrip = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  if (
    roundTrip.getUTCFullYear() !== ymd.year ||
    roundTrip.getUTCMonth() + 1 !== ymd.month ||
    roundTrip.getUTCDate() !== ymd.day
  ) {
    throw new ActionError('E_CUSTOM_DATES', `"${s}" is not a real calendar date.`);
  }
  return ymd;
}

/** ISO-8601 week number (1-53) for a calendar date. */
export function isoWeek(year: number, month: number, day: number): number {
  // Thursday-based algorithm on pure UTC calendar math.
  const date = new Date(Date.UTC(year, month - 1, day));
  const dow = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 4 - dow); // nearest Thursday
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
}

export interface WindowOptions {
  period: Period;
  timezone: string;
  /** "now" — injectable for tests; defaults to Date.now() at call sites */
  nowMs: number;
  startDate?: string;
  endDate?: string;
}

export function computeWindow(opts: WindowOptions): ReportWindow {
  const { period, timezone, nowMs } = opts;
  assertValidTimezone(timezone);
  const today = localParts(nowMs, timezone);

  let startYmd: { year: number; month: number; day: number };
  let endYmdExclusive: { year: number; month: number; day: number };

  switch (period) {
    case 'daily': {
      endYmdExclusive = { year: today.year, month: today.month, day: today.day };
      startYmd = addDaysYmd(endYmdExclusive, -1);
      break;
    }
    case 'weekly':
    case 'biweekly': {
      // Monday of the current local week = exclusive end bound.
      const currentMonday = addDaysYmd(today, -(today.dow - 1));
      endYmdExclusive = currentMonday;
      startYmd = addDaysYmd(currentMonday, period === 'weekly' ? -7 : -14);
      break;
    }
    case 'monthly': {
      endYmdExclusive = { year: today.year, month: today.month, day: 1 };
      const prev = today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };
      startYmd = { ...prev, day: 1 };
      break;
    }
    case 'custom': {
      if (!opts.startDate || !opts.endDate) {
        throw new ActionError(
          'E_CUSTOM_DATES',
          'period=custom requires both start-date and end-date (YYYY-MM-DD).',
          ['Wire them to workflow_dispatch inputs for on-demand reports.']
        );
      }
      startYmd = parseYmd(opts.startDate);
      const endInclusive = parseYmd(opts.endDate);
      if (formatYmd(startYmd) > formatYmd(endInclusive)) {
        throw new ActionError('E_CUSTOM_DATES', 'start-date must be on or before end-date.');
      }
      endYmdExclusive = addDaysYmd(endInclusive, 1);
      break;
    }
  }

  return {
    startUtcMs: zonedMidnightUtcMs(startYmd.year, startYmd.month, startYmd.day, timezone),
    endUtcMs: zonedMidnightUtcMs(endYmdExclusive.year, endYmdExclusive.month, endYmdExclusive.day, timezone),
    startDate: formatYmd(startYmd),
    endDate: formatYmd(addDaysYmd(endYmdExclusive, -1)),
    period,
    timezone
  };
}

/**
 * Absolute fortnight index of a calendar date's week: weeks counted from
 * Monday 1970-01-05, continuous across year boundaries — unlike ISO-week
 * parity, which repeats (53→1) across 53-week ISO years and would double or
 * skip a fortnight.
 */
export function weekIndex(year: number, month: number, day: number, dow: number): number {
  const monday = addDaysYmd({ year, month, day }, -(dow - 1));
  const daysSinceEpoch = Math.round(Date.UTC(monday.year, monday.month - 1, monday.day) / 86_400_000);
  return Math.floor((daysSinceEpoch - 4) / 7); // 1970-01-05 (day 4) = week 0
}

/**
 * Biweekly parity gate: with a weekly cron, only alternate weeks run
 * (anchor picks which of the two fortnight phases).
 * workflow_dispatch bypasses this — a human asking for a report gets one.
 */
export function biweeklyShouldRun(opts: {
  nowMs: number;
  timezone: string;
  anchor: 'even' | 'odd';
  isManualDispatch: boolean;
}): boolean {
  if (opts.isManualDispatch) return true;
  const today = localParts(opts.nowMs, opts.timezone);
  const index = weekIndex(today.year, today.month, today.day, today.dow);
  const parity = ((index % 2) + 2) % 2;
  return opts.anchor === 'even' ? parity === 0 : parity === 1;
}

/** ISO-8601 UTC timestamp (second precision) for GitHub search qualifiers. */
export function toSearchTimestamp(utcMs: number): string {
  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
