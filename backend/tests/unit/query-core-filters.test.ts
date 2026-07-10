import { describe, expect, it } from 'vitest';
import {
  dateKey,
  filterMatches,
  type QueryAdapters,
  type QueryPage,
  type QueryProperty,
} from '../../../shared/database/query-core';

// Regression tests for the shared filter engine (shared/database/query-core.ts):
//  #9  aggregate rollups compare the scalar cell value (equals/does_not_equal
//      must agree with greater_than/less_than) while surfacing rollups still
//      match relation membership.
//  #17 an empty-value negation filter (does_not_contain / does_not_equal with
//      q === "") is an inert no-op instead of hiding every row.
//  #26 a string already leading with an ISO date keeps that literal YYYY-MM-DD
//      prefix rather than being UTC-shifted off its calendar day.

function prop(id: string, type: string, config?: Record<string, unknown>): QueryProperty {
  return { id, type, config: config ?? null };
}

function row(id: string, properties: Record<string, unknown>, extra: Partial<QueryPage> = {}): QueryPage {
  return { id, properties, ...extra };
}

// Adapters where a rollup's cellValue is its aggregate scalar and rollupTargetIds
// are the individual related leaf values — the shape that made #9 contradictory.
function adapters(overrides: Partial<QueryAdapters> = {}): QueryAdapters {
  const cellValue = (r: QueryPage, p: QueryProperty) => {
    if (p.type === 'title') return r.title;
    return r.properties?.[p.id];
  };
  return {
    cellValue,
    displayText: (r, p) => {
      const v = cellValue(r, p);
      return v == null ? '' : Array.isArray(v) ? v.join(' ') : String(v);
    },
    asText: (value) => (value == null ? '' : Array.isArray(value) ? value.join(' ') : String(value)),
    personIds: (value) => (Array.isArray(value) ? value.map(String) : value ? [String(value)] : []),
    rollupTargetIds: () => [],
    ...overrides,
  };
}

describe('#9 aggregate rollup equals/does_not_equal compare the scalar', () => {
  // A SUM rollup over related leaves [3, 3] → aggregate 6. The leaf values are
  // exposed through rollupTargetIds, the aggregate through cellValue.
  const sumRollup = prop('ru', 'rollup', { rollupFunction: 'sum' });
  // cellValue/displayText read the aggregate stored under the property id; the
  // individual related leaf values are surfaced only through rollupTargetIds.
  const a = adapters({
    rollupTargetIds: (r) => (r.properties?.leaves as string[]) ?? [],
  });
  const sumRow = row('r', { ru: 6, leaves: ['3', '3'] });

  it('equals compares against the aggregate (6 matches, 3 does not)', () => {
    expect(filterMatches(sumRow, sumRollup, { propertyId: 'ru', operator: 'equals', value: 6 }, a)).toBe(true);
    expect(filterMatches(sumRow, sumRollup, { propertyId: 'ru', operator: 'equals', value: 3 }, a)).toBe(false);
  });

  it('greater_than agrees with equals (both read the aggregate)', () => {
    expect(filterMatches(sumRow, sumRollup, { propertyId: 'ru', operator: 'greater_than', value: 5 }, a)).toBe(true);
    // equals 6 and greater_than 5 no longer contradict: the row satisfies both.
    expect(filterMatches(sumRow, sumRollup, { propertyId: 'ru', operator: 'equals', value: 6 }, a)).toBe(true);
  });

  it('does_not_equal compares against the aggregate', () => {
    expect(filterMatches(sumRow, sumRollup, { propertyId: 'ru', operator: 'does_not_equal', value: 3 }, a)).toBe(true);
    expect(filterMatches(sumRow, sumRollup, { propertyId: 'ru', operator: 'does_not_equal', value: 6 }, a)).toBe(false);
  });

  it('a show_original rollup still filters by relation membership', () => {
    const surfacing = prop('ru', 'rollup', { rollupFunction: 'show_original' });
    const memberRow = row('r', { ru: 6, leaves: ['3', '3'] });
    expect(filterMatches(memberRow, surfacing, { propertyId: 'ru', operator: 'equals', value: '3' }, a)).toBe(true);
    expect(filterMatches(memberRow, surfacing, { propertyId: 'ru', operator: 'equals', value: '9' }, a)).toBe(false);
    expect(filterMatches(memberRow, surfacing, { propertyId: 'ru', operator: 'does_not_equal', value: '9' }, a)).toBe(true);
  });
});

describe('#17 empty-value negation filters are inert', () => {
  const a = adapters();
  const title = prop('t', 'title');
  const rows = [
    row('a', {}, { title: 'Alpha' }),
    row('b', {}, { title: '' }),
    row('c', {}, { title: 'Gamma' }),
  ];

  it('does_not_contain with q === "" returns true for all rows', () => {
    for (const r of rows) {
      expect(filterMatches(r, title, { propertyId: 't', operator: 'does_not_contain', value: '' }, a)).toBe(true);
    }
  });

  it('does_not_equal with q === "" returns true for all rows', () => {
    for (const r of rows) {
      expect(filterMatches(r, title, { propertyId: 't', operator: 'does_not_equal', value: '' }, a)).toBe(true);
    }
  });
});

describe('#26 dateKey keeps a literal leading ISO prefix', () => {
  it('does not UTC-shift a zoned datetime off its calendar day', () => {
    expect(dateKey('2024-03-15T02:00:00+09:00')).toBe('2024-03-15');
  });

  it('leaves date-only and Z-suffixed strings unchanged', () => {
    expect(dateKey('2024-03-15')).toBe('2024-03-15');
    expect(dateKey('2024-03-15T00:00:00Z')).toBe('2024-03-15');
  });
});
