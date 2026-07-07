import { describe, expect, it } from 'vitest';
import {
  biweeklyShouldRun,
  computeWindow,
  isoWeek,
  localParts,
  toSearchTimestamp,
  zonedMidnightUtcMs
} from '../src/util/time.js';
import { ActionError } from '../src/errors.js';

// Fixed "now": Monday 2026-07-06 14:30:00 UTC
const NOW = Date.UTC(2026, 6, 6, 14, 30, 0);

describe('localParts', () => {
  it('computes local calendar parts across timezones', () => {
    expect(localParts(NOW, 'UTC')).toMatchObject({ year: 2026, month: 7, day: 6, hour: 14, dow: 1 });
    // Montevideo is UTC-3: 11:30 local, still Monday
    expect(localParts(NOW, 'America/Montevideo')).toMatchObject({ year: 2026, month: 7, day: 6, hour: 11, dow: 1 });
    // Tokyo is UTC+9: 23:30 local, still Monday
    expect(localParts(NOW, 'Asia/Tokyo')).toMatchObject({ year: 2026, month: 7, day: 6, hour: 23, dow: 1 });
    // Auckland is UTC+12 (July = winter, no DST): Tuesday 02:30
    expect(localParts(NOW, 'Pacific/Auckland')).toMatchObject({ year: 2026, month: 7, day: 7, hour: 2, dow: 2 });
  });
});

describe('zonedMidnightUtcMs', () => {
  it('is plain UTC midnight for UTC', () => {
    expect(zonedMidnightUtcMs(2026, 7, 6, 'UTC')).toBe(Date.UTC(2026, 6, 6));
  });
  it('accounts for fixed offsets', () => {
    // Montevideo midnight = 03:00 UTC
    expect(zonedMidnightUtcMs(2026, 7, 6, 'America/Montevideo')).toBe(Date.UTC(2026, 6, 6, 3));
  });
  it('rolls forward when midnight does not exist (Chile spring-forward)', () => {
    // America/Santiago jumps 00:00 -> 01:00 on 2026-09-06; local midnight does
    // not exist, so the window boundary is the first valid instant (04:00Z).
    const ms = zonedMidnightUtcMs(2026, 9, 6, 'America/Santiago');
    const local = localParts(ms, 'America/Santiago');
    expect([local.year, local.month, local.day]).toEqual([2026, 9, 6]);
  });

  it('handles DST-observing zones', () => {
    // Madrid in July is UTC+2 → local midnight = 22:00 UTC previous day
    expect(zonedMidnightUtcMs(2026, 7, 6, 'Europe/Madrid')).toBe(Date.UTC(2026, 6, 5, 22));
    // Madrid in January is UTC+1
    expect(zonedMidnightUtcMs(2026, 1, 6, 'Europe/Madrid')).toBe(Date.UTC(2026, 0, 5, 23));
  });
});

describe('computeWindow', () => {
  it('weekly = previous complete Mon..Sun week', () => {
    const w = computeWindow({ period: 'weekly', timezone: 'UTC', nowMs: NOW });
    expect(w.startDate).toBe('2026-06-29');
    expect(w.endDate).toBe('2026-07-05');
    expect(w.startUtcMs).toBe(Date.UTC(2026, 5, 29));
    expect(w.endUtcMs).toBe(Date.UTC(2026, 6, 6));
  });

  it('weekly window respects timezone day boundaries', () => {
    // In Auckland it is already Tuesday Jul 7 → same "previous week" as UTC Monday
    const w = computeWindow({ period: 'weekly', timezone: 'Pacific/Auckland', nowMs: NOW });
    expect(w.startDate).toBe('2026-06-29');
    expect(w.endDate).toBe('2026-07-05');
  });

  it('weekly from a mid-week run still covers the previous complete week', () => {
    const thursday = Date.UTC(2026, 6, 9, 9, 17);
    const w = computeWindow({ period: 'weekly', timezone: 'UTC', nowMs: thursday });
    expect(w.startDate).toBe('2026-06-29');
    expect(w.endDate).toBe('2026-07-05');
  });

  it('biweekly = previous two complete weeks', () => {
    const w = computeWindow({ period: 'biweekly', timezone: 'UTC', nowMs: NOW });
    expect(w.startDate).toBe('2026-06-22');
    expect(w.endDate).toBe('2026-07-05');
  });

  it('daily = yesterday', () => {
    const w = computeWindow({ period: 'daily', timezone: 'UTC', nowMs: NOW });
    expect(w.startDate).toBe('2026-07-05');
    expect(w.endDate).toBe('2026-07-05');
  });

  it('monthly = previous calendar month, incl. year wrap', () => {
    const w = computeWindow({ period: 'monthly', timezone: 'UTC', nowMs: NOW });
    expect(w.startDate).toBe('2026-06-01');
    expect(w.endDate).toBe('2026-06-30');

    const january = Date.UTC(2026, 0, 15);
    const wj = computeWindow({ period: 'monthly', timezone: 'UTC', nowMs: january });
    expect(wj.startDate).toBe('2025-12-01');
    expect(wj.endDate).toBe('2025-12-31');
  });

  it('custom = inclusive date range', () => {
    const w = computeWindow({
      period: 'custom',
      timezone: 'UTC',
      nowMs: NOW,
      startDate: '2026-06-01',
      endDate: '2026-06-15'
    });
    expect(w.startUtcMs).toBe(Date.UTC(2026, 5, 1));
    expect(w.endUtcMs).toBe(Date.UTC(2026, 5, 16));
    expect(w.endDate).toBe('2026-06-15');
  });

  it('custom without dates throws E_CUSTOM_DATES', () => {
    expect(() => computeWindow({ period: 'custom', timezone: 'UTC', nowMs: NOW })).toThrowError(ActionError);
  });

  it('custom with inverted dates throws', () => {
    expect(() =>
      computeWindow({
        period: 'custom',
        timezone: 'UTC',
        nowMs: NOW,
        startDate: '2026-06-15',
        endDate: '2026-06-01'
      })
    ).toThrowError(/start-date must be on or before/);
  });

  it('rejects bad timezones and impossible dates', () => {
    expect(() => computeWindow({ period: 'weekly', timezone: 'Mars/Olympus', nowMs: NOW })).toThrowError(
      /Invalid IANA timezone/
    );
    expect(() =>
      computeWindow({ period: 'custom', timezone: 'UTC', nowMs: NOW, startDate: '2026-02-30', endDate: '2026-03-01' })
    ).toThrowError(/not a real calendar date/);
  });
});

describe('isoWeek / biweekly parity', () => {
  it('computes ISO week numbers', () => {
    expect(isoWeek(2026, 1, 1)).toBe(1); // Thu Jan 1 2026
    expect(isoWeek(2026, 7, 6)).toBe(28);
    expect(isoWeek(2021, 1, 1)).toBe(53); // ISO week-53 year edge
  });

  it('gates on parity but always runs manual dispatches', () => {
    // 2026-07-06 falls in an even fortnight-index week
    expect(biweeklyShouldRun({ nowMs: NOW, timezone: 'UTC', anchor: 'even', isManualDispatch: false })).toBe(true);
    expect(biweeklyShouldRun({ nowMs: NOW, timezone: 'UTC', anchor: 'odd', isManualDispatch: false })).toBe(false);
    expect(biweeklyShouldRun({ nowMs: NOW, timezone: 'UTC', anchor: 'odd', isManualDispatch: true })).toBe(true);
  });

  it('parity stays continuous across 53-week ISO years (no double/missed fortnight)', () => {
    // ISO weeks 53 (2026-12-28) and 1 (2027-01-04) are BOTH odd — the old
    // ISO-parity gate would run twice or skip; fortnight parity alternates.
    const dec28 = Date.UTC(2026, 11, 28, 9);
    const jan04 = Date.UTC(2027, 0, 4, 9);
    const runsDec = biweeklyShouldRun({ nowMs: dec28, timezone: 'UTC', anchor: 'even', isManualDispatch: false });
    const runsJan = biweeklyShouldRun({ nowMs: jan04, timezone: 'UTC', anchor: 'even', isManualDispatch: false });
    expect(runsDec).not.toBe(runsJan);
  });
});

describe('toSearchTimestamp', () => {
  it('renders second-precision ISO-8601 UTC', () => {
    expect(toSearchTimestamp(Date.UTC(2026, 5, 29, 3, 0, 0))).toBe('2026-06-29T03:00:00Z');
  });
});
