import { describe, expect, it } from 'vitest';
import {
  dateKey,
  dateSortKey,
  filterMatches,
  sortKey,
  type QueryAdapters,
  type QueryPage,
  type QueryProperty,
} from '../../../shared/database/query-core';

// Regression tests for the timezone / empty-value fixes:
//  - dateKey resolves an absolute instant to the viewer's calendar day when a
//    timeZone is supplied (created_time stored as "…Z" filters on the day the
//    cell actually displays), but keeps the literal day when none is given.
//  - number filters/sorts never coerce a cleared cell to 0.
//  - date sorting is sub-day precise so same-day rows order by time.

function prop(id: string, type: string, config?: Record<string, unknown>): QueryProperty {
  return { id, type, config: config ?? null };
}
function row(id: string, properties: Record<string, unknown>): QueryPage {
  return { id, properties };
}
function adapters(overrides: Partial<QueryAdapters> = {}): QueryAdapters {
  const cellValue = (r: QueryPage, p: QueryProperty) => r.properties?.[p.id];
  return {
    cellValue,
    displayText: (r, p) => {
      const v = cellValue(r, p);
      return v == null ? '' : String(v);
    },
    asText: (value) => (value == null ? '' : String(value)),
    personIds: () => [],
    rollupTargetIds: () => [],
    ...overrides,
  };
}

describe('dateKey timezone resolution', () => {
  it('keeps the UTC/literal day with no timeZone (backend default)', () => {
    // 2024-03-15T16:00:00Z leads with an ISO date → literal prefix.
    expect(dateKey('2024-03-15T16:00:00Z')).toBe('2024-03-15');
  });

  it('resolves a "…Z" instant to the local calendar day when a timeZone is given', () => {
    // 16:00Z is 01:00 next day in Seoul (UTC+9).
    expect(dateKey('2024-03-15T16:00:00Z', 'Asia/Seoul')).toBe('2024-03-16');
    // …and stays the same day in a UTC zone.
    expect(dateKey('2024-03-15T16:00:00Z', 'UTC')).toBe('2024-03-15');
  });

  it('leaves a day-only value verbatim regardless of timeZone', () => {
    expect(dateKey('2024-03-15', 'Asia/Seoul')).toBe('2024-03-15');
  });

  it('handles epoch-millisecond numbers', () => {
    expect(dateKey(Date.UTC(2024, 2, 15, 16, 0, 0), 'Asia/Seoul')).toBe('2024-03-16');
  });
});

describe('created_time filter matches the displayed local day', () => {
  const created = prop('c', 'created_time');
  const r = row('r1', { c: '2024-03-15T16:00:00Z' }); // Seoul: Mar 16
  it('matches "equals 2024-03-16" for a KST viewer', () => {
    const a = adapters({ timeZone: 'Asia/Seoul' });
    expect(filterMatches(r, created, { propertyId: 'c', operator: 'equals', value: '2024-03-16' }, a)).toBe(true);
    expect(filterMatches(r, created, { propertyId: 'c', operator: 'equals', value: '2024-03-15' }, a)).toBe(false);
  });
});

describe('number filters treat cleared cells as empty, not 0', () => {
  const price = prop('p', 'number');
  const cleared = row('r', { p: null });
  const a = adapters();
  it('cleared cell does not match equals 0', () => {
    expect(filterMatches(cleared, price, { propertyId: 'p', operator: 'equals', value: 0 }, a)).toBe(false);
  });
  it('cleared cell does not match greater_than -1', () => {
    expect(filterMatches(cleared, price, { propertyId: 'p', operator: 'greater_than', value: -1 }, a)).toBe(false);
  });
  it('cleared cell satisfies is_empty and does_not_equal', () => {
    expect(filterMatches(cleared, price, { propertyId: 'p', operator: 'is_empty', value: null }, a)).toBe(true);
    expect(filterMatches(cleared, price, { propertyId: 'p', operator: 'does_not_equal', value: 0 }, a)).toBe(true);
  });
  it('sorts cleared cells last, not among real zeros', () => {
    const zero = sortKey(row('z', { p: 0 }), price, a);
    const empty = sortKey(cleared, price, a);
    expect(zero).toBe(0);
    expect(empty).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('date sorting is sub-day precise', () => {
  it('orders same-day datetimes by time', () => {
    const morning = dateSortKey('2024-03-15T09:00:00Z');
    const evening = dateSortKey('2024-03-15T17:00:00Z');
    expect(morning < evening).toBe(true);
  });
  it('a day-only value precedes same-day datetimes', () => {
    expect(dateSortKey('2024-03-15') < dateSortKey('2024-03-15T09:00:00Z')).toBe(true);
  });
});
