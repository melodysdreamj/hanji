import { describe, expect, it } from 'vitest';
import {
  compareKeys,
  effectiveFilterGroup,
  filterMatches,
  matchesFilterGroup,
  sortKey,
  type QueryAdapters,
  type QueryPage,
  type QueryProperty,
} from '../../../shared/database/query-core';
import {
  evaluateRollup,
  type RollupContext,
  type RollupPage,
  type RollupProperty,
} from '../../../shared/database/rollup-core';

// The shared filter/sort/rollup engine is now the single implementation behind
// both web (query.ts/rollup.ts) and backend (page-query.ts/share-mutation.ts).
// These tests lock the operator predicates, sort keys, and the behaviours that
// were unified across the old divergent copies (UTC date keys, id-or-name
// option matching, 2-decimal rollup percents).

function prop(id: string, type: string, config?: Record<string, unknown>): QueryProperty {
  return { id, type, config: config ?? null };
}

function row(id: string, properties: Record<string, unknown>, extra: Partial<QueryPage> = {}): QueryPage {
  return { id, properties, ...extra };
}

// Minimal adapters: raw property read, simple display text, no relations.
function adapters(overrides: Partial<QueryAdapters> = {}): QueryAdapters {
  const cellValue = (r: QueryPage, p: QueryProperty) => {
    if (p.type === 'title') return r.title;
    return r.properties?.[p.id];
  };
  const optionName = (p: QueryProperty, id: string) => {
    const options = (p.config?.options as Array<{ id: string; name: string }> | undefined) ?? [];
    return options.find((o) => o.id === id)?.name ?? id;
  };
  const displayText = (r: QueryPage, p: QueryProperty) => {
    const v = cellValue(r, p);
    if (p.type === 'select' || p.type === 'multi_select' || p.type === 'status') {
      return (Array.isArray(v) ? v : v ? [v] : []).map((id) => optionName(p, String(id))).join(' ');
    }
    return v == null ? '' : String(v);
  };
  return {
    cellValue,
    displayText,
    asText: (value) => (value == null ? '' : Array.isArray(value) ? value.join(' ') : String(value)),
    personIds: (value) => (Array.isArray(value) ? value.map(String) : value ? [String(value)] : []),
    rollupTargetIds: () => [],
    ...overrides,
  };
}

const STATUS = prop('s', 'status', {
  options: [
    { id: 'todo', name: 'To Do' },
    { id: 'doing', name: 'Doing' },
    { id: 'done', name: 'Done' },
  ],
});

describe('filterMatches operators', () => {
  const a = adapters();
  it('matches select equals by option id', () => {
    expect(filterMatches(row('r', { s: 'doing' }), STATUS, { propertyId: 's', operator: 'equals', value: 'doing' }, a)).toBe(true);
    expect(filterMatches(row('r', { s: 'todo' }), STATUS, { propertyId: 's', operator: 'equals', value: 'doing' }, a)).toBe(false);
  });

  it('matches select by option NAME (id-or-name unification)', () => {
    expect(filterMatches(row('r', { s: 'doing' }), STATUS, { propertyId: 's', operator: 'equals', value: 'Doing' }, a)).toBe(true);
  });

  it('handles number greater_than / is_empty', () => {
    const num = prop('n', 'number');
    expect(filterMatches(row('r', { n: 5 }), num, { propertyId: 'n', operator: 'greater_than', value: 3 }, a)).toBe(true);
    expect(filterMatches(row('r', { n: 2 }), num, { propertyId: 'n', operator: 'greater_than', value: 3 }, a)).toBe(false);
    expect(filterMatches(row('r', {}), num, { propertyId: 'n', operator: 'is_empty', value: null }, a)).toBe(true);
  });

  it('normalizes dates to UTC for equals / on_or_after', () => {
    const date = prop('d', 'date');
    expect(filterMatches(row('r', { d: '2026-03-15' }), date, { propertyId: 'd', operator: 'equals', value: '2026-03-15' }, a)).toBe(true);
    expect(filterMatches(row('r', { d: '2026-03-15' }), date, { propertyId: 'd', operator: 'on_or_after', value: '2026-03-01' }, a)).toBe(true);
    // A UTC datetime instant keys by its UTC day.
    expect(filterMatches(row('r', { d: '2026-03-15T23:30:00Z' }), date, { propertyId: 'd', operator: 'equals', value: '2026-03-15' }, a)).toBe(true);
  });

  it('matches text contains and checkbox equals', () => {
    const title = prop('t', 'title');
    expect(filterMatches(row('r', {}, { title: 'Hello World' }), title, { propertyId: 't', operator: 'contains', value: 'world' }, a)).toBe(true);
    const check = prop('c', 'checkbox');
    expect(filterMatches(row('r', { c: true }), check, { propertyId: 'c', operator: 'equals', value: true }, a)).toBe(true);
    expect(filterMatches(row('r', { c: false }), check, { propertyId: 'c', operator: 'equals', value: true }, a)).toBe(false);
  });
});

describe('matchesFilterGroup', () => {
  const a = adapters();
  const byId = new Map<string, QueryProperty>([['s', STATUS]]);
  it('combines leaves with and/or and skips unknown properties', () => {
    const r = row('r', { s: 'done' });
    expect(matchesFilterGroup(r, { conjunction: 'or', filters: [
      { propertyId: 's', operator: 'equals', value: 'todo' },
      { propertyId: 's', operator: 'equals', value: 'done' },
    ] }, a, byId)).toBe(true);
    expect(matchesFilterGroup(r, { conjunction: 'and', filters: [
      { propertyId: 's', operator: 'equals', value: 'todo' },
      { propertyId: 's', operator: 'equals', value: 'done' },
    ] }, a, byId)).toBe(false);
    // Unknown property leaf is skipped → empty group matches.
    expect(matchesFilterGroup(r, { conjunction: 'and', filters: [
      { propertyId: 'missing', operator: 'equals', value: 'x' },
    ] }, a, byId)).toBe(true);
  });
});

describe('sortKey / compareKeys', () => {
  const a = adapters();
  it('orders selects by option position (id-or-name)', () => {
    expect(sortKey(row('r', { s: 'todo' }), STATUS, a)).toBe(0);
    expect(sortKey(row('r', { s: 'done' }), STATUS, a)).toBe(2);
    expect(sortKey(row('r', { s: 'Doing' }), STATUS, a)).toBe(1); // by name
    expect(sortKey(row('r', {}), STATUS, a)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('sorts numbers numerically and empty dates last', () => {
    const num = prop('n', 'number');
    expect(compareKeys(sortKey(row('r', { n: 2 }), num, a), sortKey(row('r', { n: 10 }), num, a))).toBeLessThan(0);
    const date = prop('d', 'date');
    expect(sortKey(row('r', { d: '2026-01-01' }), date, a)).toBe('2026-01-01');
    expect(sortKey(row('r', {}), date, a)).toBe('￿');
  });
});

describe('effectiveFilterGroup', () => {
  it('folds quick filters into the stored group', () => {
    const group = effectiveFilterGroup({
      filters: [{ propertyId: 's', operator: 'equals', value: 'done' }],
      filterConjunction: 'and',
      quickFilters: [{ propertyId: 's', operator: 'is_not_empty' }],
    });
    expect(group?.conjunction).toBe('and');
    expect(group?.groups?.length).toBe(2);
  });

  it('returns undefined with no filters', () => {
    expect(effectiveFilterGroup({})).toBeUndefined();
  });
});

describe('evaluateRollup', () => {
  const DB = 'db';
  const TARGET_DB = 'tdb';
  const relationProp: RollupProperty = { id: 'rel', databaseId: DB, type: 'relation', config: { relationDatabaseId: TARGET_DB } };
  const targetNum: RollupProperty = { id: 'amount', databaseId: TARGET_DB, type: 'number', config: null };
  const related: Record<string, RollupPage> = {
    a: { id: 'a', properties: { amount: 10 } },
    b: { id: 'b', properties: { amount: 5 } },
    c: { id: 'c', properties: { amount: null } },
  };
  function ctx(): RollupContext {
    return {
      pagesById: (id) => related[id],
      propsByDb: (dbId) => (dbId === DB ? [relationProp] : dbId === TARGET_DB ? [targetNum] : []),
      rawValue: (page, p) => (p.type === 'title' ? undefined : page.properties?.[p.id]),
      displayValue: (page, p) => String(page.properties?.[p.id] ?? ''),
    };
  }
  const sourceProps = [relationProp];
  const targetProps = [targetNum];
  function rollupProp(fn: string): RollupProperty {
    return { id: 'ru', databaseId: DB, type: 'rollup', config: { rollupRelationPropertyId: 'rel', rollupTargetPropertyId: 'amount', rollupFunction: fn } };
  }
  const rowWith = (): RollupPage => ({ id: 'row', properties: { rel: ['a', 'b', 'c'] } });

  it('counts, sums, and averages related values', () => {
    expect(evaluateRollup(rowWith(), rollupProp('count_all'), sourceProps, targetProps, ctx())).toBe(3);
    expect(evaluateRollup(rowWith(), rollupProp('sum'), sourceProps, targetProps, ctx())).toBe(15);
    expect(evaluateRollup(rowWith(), rollupProp('count_values'), sourceProps, targetProps, ctx())).toBe(2);
    expect(evaluateRollup(rowWith(), rollupProp('count_empty'), sourceProps, targetProps, ctx())).toBe(1);
  });

  it('formats percents to 2 decimals (unified)', () => {
    // 2 of 3 present → 66.67%.
    expect(evaluateRollup(rowWith(), rollupProp('percent_not_empty'), sourceProps, targetProps, ctx())).toBe('66.67%');
  });
});
