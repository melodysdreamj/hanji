import { describe, expect, it } from 'vitest';

import {
  databasePropertyIndexKey,
  databasePropertyIndexMap,
  deleteDatabasePropertyIndexes,
  deleteDatabaseRowIndexes,
  ensureDatabasePropertyIndexes,
  indexedDisplayText,
  indexedSortValue,
  upsertDatabaseIndexesForRows,
  upsertDatabaseRowIndexes,
  type DatabaseIndexPage,
  type DatabaseIndexProperty,
  type DbPropertyIndex,
  type DbRef,
} from '../../lib/database-index';
import { fakeDb as makeFakeDb, type Row } from './helpers/fake-db';

function fakeDb(tables: Record<string, Row[]> = {}) {
  return makeFakeDb(tables) as unknown as DbRef & { tables: Record<string, Row[]> };
}

function row(id: string, extra: Partial<DatabaseIndexPage> = {}): DatabaseIndexPage {
  return { id, workspaceId: 'ws1', parentId: 'db1', parentType: 'database', properties: {}, ...extra };
}

function prop(id: string, type: string, extra: Partial<DatabaseIndexProperty> = {}): DatabaseIndexProperty {
  return { id, databaseId: 'db1', type, ...extra };
}

async function indexFor(
  value: unknown,
  property: DatabaseIndexProperty,
  rowExtra: Partial<DatabaseIndexPage> = {},
) {
  const db = fakeDb();
  const target = row('r1', { properties: { [property.id]: value }, ...rowExtra });
  const [index] = await upsertDatabaseRowIndexes(db, target, [property]);
  return index as DbPropertyIndex;
}

describe('index key helpers', () => {
  it('builds keys from rowId and propertyId', () => {
    expect(databasePropertyIndexKey('r1', 'p1')).toBe('r1:p1');
  });

  it('maps indexes by row/property key', () => {
    const a = { rowId: 'r1', propertyId: 'p1' } as DbPropertyIndex;
    const b = { rowId: 'r2', propertyId: 'p1' } as DbPropertyIndex;
    const map = databasePropertyIndexMap([a, b]);
    expect(map.get('r1:p1')).toBe(a);
    expect(map.get('r2:p1')).toBe(b);
    expect(map.size).toBe(2);
  });
});

describe('value normalization', () => {
  it('indexes numeric values with number, string, and search text', async () => {
    const index = await indexFor('42.5', prop('p1', 'number'));
    expect(index.valueKind).toBe('number');
    expect(index.numberValue).toBe(42.5);
    expect(index.stringValue).toBe('42.5');
    expect(index.searchText).toBe('42.5');
  });

  it('drops non-numeric number values but keeps the value kind', async () => {
    const index = await indexFor('not a number', prop('p1', 'number'));
    expect(index.valueKind).toBe('number');
    expect(index.numberValue).toBeUndefined();
    expect(index.stringValue).toBeUndefined();
    expect(index.searchText).toBeUndefined();
  });

  it('leaves empty number cells unindexed instead of coercing to zero', async () => {
    const nullIndex = await indexFor(null, prop('p1', 'number'));
    expect(nullIndex.numberValue).toBeUndefined();
    expect(nullIndex.stringValue).toBeUndefined();
    const blankIndex = await indexFor('   ', prop('p1', 'number'));
    expect(blankIndex.numberValue).toBeUndefined();
    const zeroIndex = await indexFor(0, prop('p1', 'number'));
    expect(zeroIndex.numberValue).toBe(0);
    expect(zeroIndex.stringValue).toBe('0');
  });

  it('treats unique_id like a number', async () => {
    const index = await indexFor(7, prop('p1', 'unique_id'));
    expect(index.valueKind).toBe('number');
    expect(index.numberValue).toBe(7);
  });

  it('indexes checkbox booleans from boolean and string forms', async () => {
    const checked = await indexFor(true, prop('p1', 'checkbox'));
    expect(checked.valueKind).toBe('boolean');
    expect(checked.booleanValue).toBe(true);
    expect(checked.stringValue).toBe('true');
    expect(checked.searchText).toBe('checked true yes');

    const checkedString = await indexFor('true', prop('p1', 'checkbox'));
    expect(checkedString.booleanValue).toBe(true);

    const unchecked = await indexFor(false, prop('p1', 'checkbox'));
    expect(unchecked.booleanValue).toBe(false);
    expect(unchecked.stringValue).toBe('false');
    expect(unchecked.searchText).toBe('unchecked false no');
  });

  it('normalizes date strings to YYYY-MM-DD', async () => {
    const index = await indexFor('2024-01-05T10:30:00.000Z', prop('p1', 'date'));
    expect(index.valueKind).toBe('date');
    expect(index.dateValue).toBe('2024-01-05');
    expect(index.stringValue).toBe('2024-01-05');
    expect(index.searchText).toBe('2024-01-05');
  });

  it('reads dates from { start } objects', async () => {
    const index = await indexFor({ start: '2023-12-31' }, prop('p1', 'date'));
    expect(index.dateValue).toBe('2023-12-31');
  });

  it('keeps the first ten characters of unparseable date strings', async () => {
    const index = await indexFor('not-a-real-date', prop('p1', 'date'));
    expect(index.dateValue).toBe('not-a-real');
  });

  it('stores an empty dateValue for missing dates', async () => {
    const index = await indexFor(undefined, prop('p1', 'date'));
    expect(index.dateValue).toBe('');
    expect(index.stringValue).toBeUndefined();
  });

  it('resolves select option ids to option names', async () => {
    const property = prop('p1', 'select', {
      config: { options: [{ id: 'opt1', name: 'Backlog' }, { id: 'opt2', name: 'Done' }] },
    });
    const index = await indexFor('opt2', property);
    expect(index.valueKind).toBe('option');
    expect(index.stringValue).toBe('Done');
    expect(index.searchText).toBe('done');
  });

  it('falls back to the raw id for unknown or unnamed options', async () => {
    const unnamed = prop('p1', 'select', { config: { options: [{ id: 'opt1', name: '  ' }] } });
    expect((await indexFor('opt1', unnamed)).stringValue).toBe('opt1');
    expect((await indexFor('missing', prop('p1', 'select'))).stringValue).toBe('missing');
  });

  it('matches select options by name as well as id', async () => {
    const property = prop('p1', 'status', { config: { options: [{ id: 'opt1', name: 'In Progress' }] } });
    const index = await indexFor('In Progress', property);
    expect(index.stringValue).toBe('In Progress');
  });

  it('leaves empty selects without a string value', async () => {
    const index = await indexFor('', prop('p1', 'select'));
    expect(index.valueKind).toBe('option');
    expect(index.stringValue).toBeUndefined();
  });

  it('joins multi_select option names with spaces', async () => {
    const property = prop('p1', 'multi_select', {
      config: { options: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] },
    });
    const index = await indexFor(['a', 'b'], property);
    expect(index.valueKind).toBe('options');
    expect(index.stringValue).toBe('Alpha Beta');
    expect(index.searchText).toBe('alpha beta');
  });

  it('extracts person names from objects and arrays', async () => {
    const single = await indexFor({ name: 'Test User' }, prop('p1', 'person'));
    expect(single.valueKind).toBe('person');
    expect(single.stringValue).toBe('Test User');

    const many = await indexFor([{ name: 'A' }, { name: 'B' }], prop('p1', 'person'));
    expect(many.stringValue).toBe('A B');
  });

  it('joins relation ids with spaces', async () => {
    const index = await indexFor(['row-a', 'row-b'], prop('p1', 'relation'));
    expect(index.valueKind).toBe('relation');
    expect(index.stringValue).toBe('row-a row-b');
  });

  it('uses row metadata for title and system properties', async () => {
    const metadata = {
      title: 'My Row',
      createdAt: '2024-02-01T00:00:00.000Z',
      updatedAt: '2024-02-02T00:00:00.000Z',
      createdBy: 'user-1',
      lastEditedBy: 'user-2',
    };
    expect((await indexFor(undefined, prop('p1', 'title'), metadata)).stringValue).toBe('My Row');
    expect((await indexFor(undefined, prop('p1', 'created_time'), metadata)).dateValue).toBe('2024-02-01');
    expect((await indexFor(undefined, prop('p1', 'last_edited_time'), metadata)).dateValue).toBe('2024-02-02');
    expect((await indexFor(undefined, prop('p1', 'created_by'), metadata)).stringValue).toBe('user-1');
    expect((await indexFor(undefined, prop('p1', 'last_edited_by'), metadata)).stringValue).toBe('user-2');
  });

  it('flattens rich text arrays into plain text', async () => {
    const index = await indexFor([{ text: 'Hello' }, { text: 'World' }], prop('p1', 'rich_text'));
    expect(index.valueKind).toBe('text');
    expect(index.stringValue).toBe('Hello World');
    expect(index.searchText).toBe('hello world');
  });

  it('serializes unrecognized objects to JSON', async () => {
    const index = await indexFor({ foo: 'bar' }, prop('p1', 'rich_text'));
    expect(index.stringValue).toBe('{"foo":"bar"}');
  });

  it('lowercases search text but preserves the display string', async () => {
    const index = await indexFor('HELLO There', prop('p1', 'rich_text'));
    expect(index.stringValue).toBe('HELLO There');
    expect(index.searchText).toBe('hello there');
  });

  it('truncates long values to 2048 characters', async () => {
    const index = await indexFor('x'.repeat(3000), prop('p1', 'rich_text'));
    expect(index.stringValue).toHaveLength(2048);
    expect(index.searchText).toHaveLength(2048);
  });
});

describe('upsertDatabaseRowIndexes', () => {
  it('skips rows that are not database rows', async () => {
    const db = fakeDb();
    expect(await upsertDatabaseRowIndexes(db, row('r1', { parentType: 'page' }), [prop('p1', 'title')])).toEqual([]);
    expect(await upsertDatabaseRowIndexes(db, row('r1', { parentId: null }), [prop('p1', 'title')])).toEqual([]);
    expect(db.tables.db_property_indexes ?? []).toHaveLength(0);
  });

  it('only indexes properties belonging to the row database', async () => {
    const db = fakeDb();
    const indexes = await upsertDatabaseRowIndexes(db, row('r1', { title: 'T' }), [
      prop('p1', 'title'),
      prop('p2', 'title', { databaseId: 'other-db' }),
    ]);
    expect(indexes).toHaveLength(1);
    expect(indexes[0].propertyId).toBe('p1');
    expect(indexes[0].databaseId).toBe('db1');
    expect(indexes[0].workspaceId).toBe('ws1');
    expect(indexes[0].rowId).toBe('r1');
  });

  it('updates existing indexes in place instead of duplicating', async () => {
    const db = fakeDb();
    const target = row('r1', { title: 'First' });
    const [first] = await upsertDatabaseRowIndexes(db, target, [prop('p1', 'title')]);
    const [second] = await upsertDatabaseRowIndexes(db, { ...target, title: 'Second' }, [prop('p1', 'title')]);
    expect(second.id).toBe(first.id);
    expect(second.stringValue).toBe('Second');
    expect(db.tables.db_property_indexes).toHaveLength(1);
  });

  it('deletes stale indexes for properties that were removed', async () => {
    const db = fakeDb();
    const target = row('r1', { title: 'T' });
    await upsertDatabaseRowIndexes(db, target, [prop('p1', 'title'), prop('p2', 'rich_text')]);
    expect(db.tables.db_property_indexes).toHaveLength(2);

    const remaining = await upsertDatabaseRowIndexes(db, target, [prop('p1', 'title')]);
    expect(remaining).toHaveLength(1);
    expect(db.tables.db_property_indexes).toHaveLength(1);
    expect((db.tables.db_property_indexes[0] as unknown as DbPropertyIndex).propertyId).toBe('p1');
  });

  it('carries row and property update stamps onto the index', async () => {
    const db = fakeDb();
    const target = row('r1', { title: 'T', updatedAt: '2024-03-01T00:00:00.000Z' });
    const [index] = await upsertDatabaseRowIndexes(db, target, [
      prop('p1', 'title', { updatedAt: '2024-03-02T00:00:00.000Z' }),
    ]);
    expect(index.rowUpdatedAt).toBe('2024-03-01T00:00:00.000Z');
    expect(index.propertyUpdatedAt).toBe('2024-03-02T00:00:00.000Z');
    expect(index.propertyType).toBe('title');
  });
});

describe('delete helpers', () => {
  it('deleteDatabaseRowIndexes removes only that row', async () => {
    const db = fakeDb();
    await upsertDatabaseRowIndexes(db, row('r1', { title: 'A' }), [prop('p1', 'title')]);
    await upsertDatabaseRowIndexes(db, row('r2', { title: 'B' }), [prop('p1', 'title')]);
    await deleteDatabaseRowIndexes(db, 'r1');
    const left = db.tables.db_property_indexes as unknown as DbPropertyIndex[];
    expect(left).toHaveLength(1);
    expect(left[0].rowId).toBe('r2');
  });

  it('deleteDatabasePropertyIndexes removes only that property', async () => {
    const db = fakeDb();
    await upsertDatabaseRowIndexes(db, row('r1', { title: 'A' }), [prop('p1', 'title'), prop('p2', 'rich_text')]);
    await deleteDatabasePropertyIndexes(db, 'p2');
    const left = db.tables.db_property_indexes as unknown as DbPropertyIndex[];
    expect(left).toHaveLength(1);
    expect(left[0].propertyId).toBe('p1');
  });
});

describe('upsertDatabaseIndexesForRows', () => {
  it('returns an empty list when no rows have a database parent', async () => {
    const db = fakeDb();
    expect(await upsertDatabaseIndexesForRows(db, [])).toEqual([]);
    expect(await upsertDatabaseIndexesForRows(db, [row('r1', { parentId: null })])).toEqual([]);
  });

  it('loads properties per database and indexes each row', async () => {
    const db = fakeDb({
      db_properties: [
        prop('p1', 'title') as unknown as Row,
        prop('p2', 'number') as unknown as Row,
        prop('p9', 'title', { databaseId: 'db2' }) as unknown as Row,
      ],
    });
    const rows = [
      row('r1', { title: 'One', properties: { p2: 1 } }),
      row('r2', { title: 'Two', properties: { p2: 2 } }),
      row('r3', { parentId: 'db2', title: 'Other' }),
    ];
    const indexes = await upsertDatabaseIndexesForRows(db, rows);
    expect(indexes).toHaveLength(5);
    expect(indexes.filter((index) => index.databaseId === 'db1')).toHaveLength(4);
    expect(indexes.filter((index) => index.databaseId === 'db2')).toHaveLength(1);
  });

  it('skips non-database rows even when they have a parentId', async () => {
    const db = fakeDb({ db_properties: [prop('p1', 'title') as unknown as Row] });
    const indexes = await upsertDatabaseIndexesForRows(db, [row('r1', { parentType: 'page' })]);
    expect(indexes).toEqual([]);
  });
});

describe('ensureDatabasePropertyIndexes', () => {
  const database = { id: 'db1', workspaceId: 'ws1' };

  it('creates missing indexes for database rows only', async () => {
    const db = fakeDb();
    const rows = [
      row('r1', { title: 'A', updatedAt: 't1' }),
      row('r2', { title: 'B', updatedAt: 't1', parentType: 'page' }),
      row('r3', { title: 'C', updatedAt: 't1', parentId: 'db2' }),
    ];
    const indexes = await ensureDatabasePropertyIndexes(db, database, rows, [prop('p1', 'title')]);
    expect(indexes).toHaveLength(1);
    expect(indexes[0].rowId).toBe('r1');
    expect(indexes[0].stringValue).toBe('A');
  });

  it('leaves fresh indexes untouched on a second pass', async () => {
    const db = fakeDb();
    const rows = [row('r1', { title: 'A', updatedAt: 't1' })];
    const props = [prop('p1', 'title', { updatedAt: 'pt1' })];
    await ensureDatabasePropertyIndexes(db, database, rows, props);
    db.tables.db_property_indexes[0].updatedAt = 'marker';

    const indexes = await ensureDatabasePropertyIndexes(db, database, rows, props);
    expect(indexes).toHaveLength(1);
    expect(db.tables.db_property_indexes[0].updatedAt).toBe('marker');
  });

  it('refreshes indexes when the row was updated', async () => {
    const db = fakeDb();
    const props = [prop('p1', 'title', { updatedAt: 'pt1' })];
    await ensureDatabasePropertyIndexes(db, database, [row('r1', { title: 'Old', updatedAt: 't1' })], props);
    const indexes = await ensureDatabasePropertyIndexes(
      db,
      database,
      [row('r1', { title: 'New', updatedAt: 't2' })],
      props,
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0].stringValue).toBe('New');
    expect(indexes[0].rowUpdatedAt).toBe('t2');
  });

  it('refreshes indexes when the property type changed', async () => {
    const db = fakeDb();
    const rows = [row('r1', { title: 'A', updatedAt: 't1', properties: { p1: '12' } })];
    await ensureDatabasePropertyIndexes(db, database, rows, [prop('p1', 'rich_text', { updatedAt: 'pt1' })]);
    const indexes = await ensureDatabasePropertyIndexes(db, database, rows, [
      prop('p1', 'number', { updatedAt: 'pt1' }),
    ]);
    expect(indexes[0].propertyType).toBe('number');
    expect(indexes[0].numberValue).toBe(12);
  });

  it('deletes indexes for rows or properties that no longer exist', async () => {
    const db = fakeDb();
    const props = [prop('p1', 'title', { updatedAt: 'pt1' }), prop('p2', 'rich_text', { updatedAt: 'pt1' })];
    const rows = [row('r1', { title: 'A', updatedAt: 't1' }), row('r2', { title: 'B', updatedAt: 't1' })];
    await ensureDatabasePropertyIndexes(db, database, rows, props);
    expect(db.tables.db_property_indexes).toHaveLength(4);

    const indexes = await ensureDatabasePropertyIndexes(
      db,
      database,
      [rows[0]],
      [props[0]],
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0].rowId).toBe('r1');
    expect(indexes[0].propertyId).toBe('p1');
    expect(db.tables.db_property_indexes).toHaveLength(1);
  });
});

describe('indexedSortValue', () => {
  it('returns undefined without an index', () => {
    expect(indexedSortValue(undefined, 'number')).toBeUndefined();
  });

  it('returns finite numbers for numeric types', () => {
    expect(indexedSortValue({ numberValue: 5 } as DbPropertyIndex, 'number')).toBe(5);
    expect(indexedSortValue({ numberValue: 5 } as DbPropertyIndex, 'unique_id')).toBe(5);
    expect(indexedSortValue({} as DbPropertyIndex, 'number')).toBeUndefined();
  });

  it('maps checkboxes to 1/0', () => {
    expect(indexedSortValue({ booleanValue: true } as DbPropertyIndex, 'checkbox')).toBe(1);
    expect(indexedSortValue({ booleanValue: false } as DbPropertyIndex, 'checkbox')).toBe(0);
    expect(indexedSortValue({} as DbPropertyIndex, 'checkbox')).toBe(0);
  });

  it('returns date values, treating empty dates as undefined', () => {
    expect(indexedSortValue({ dateValue: '2024-01-01' } as DbPropertyIndex, 'date')).toBe('2024-01-01');
    expect(indexedSortValue({ dateValue: '' } as DbPropertyIndex, 'created_time')).toBeUndefined();
  });

  it('lowercases textual sort values', () => {
    expect(indexedSortValue({ stringValue: 'Hello' } as DbPropertyIndex, 'title')).toBe('hello');
    expect(indexedSortValue({ stringValue: 'A@B.C' } as DbPropertyIndex, 'email')).toBe('a@b.c');
  });

  it('returns undefined for unsupported types', () => {
    expect(indexedSortValue({ stringValue: 'Done' } as DbPropertyIndex, 'select')).toBeUndefined();
  });
});

describe('indexedDisplayText', () => {
  it('returns undefined without an index or for unsupported types', () => {
    expect(indexedDisplayText(undefined, 'title')).toBeUndefined();
    expect(indexedDisplayText({ stringValue: 'r1' } as DbPropertyIndex, 'relation')).toBeUndefined();
  });

  it('uses search text for checkboxes', () => {
    expect(indexedDisplayText({ searchText: 'checked true yes' } as DbPropertyIndex, 'checkbox')).toBe('checked true yes');
  });

  it('prefers search text, then string value, then empty string', () => {
    expect(indexedDisplayText({ searchText: 'hello', stringValue: 'Hello' } as DbPropertyIndex, 'title')).toBe('hello');
    expect(indexedDisplayText({ stringValue: 'Hello' } as DbPropertyIndex, 'title')).toBe('Hello');
    expect(indexedDisplayText({} as DbPropertyIndex, 'title')).toBe('');
  });
});
