import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/database-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';

function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    ...tables,
  });
}

describe('database-mutation createDatabase', () => {
  it('preserves the client-generated starter view id for local-first creation', async () => {
    const result = await callFunction(POST, db(), OWNER, {
      action: 'createDatabase',
      id: 'db-client-view-id',
      viewId: 'view-client-generated',
      workspaceId: 'ws1',
      parentId: null,
      parentType: 'workspace',
      viewType: 'table',
      seedRows: false,
    }) as { views: Row[] };

    expect(result.views).toHaveLength(1);
    expect(result.views[0]?.id).toBe('view-client-generated');
  });

  it('uses opt-in Korean starter names while preserving English defaults for existing API callers', async () => {
    const english = (await callFunction(POST, db(), OWNER, {
      action: 'createDatabase',
      id: 'db-default-en',
      workspaceId: 'ws1',
      parentId: null,
      parentType: 'workspace',
      viewType: 'calendar',
      seedRows: false,
    })) as { properties: Row[]; views: Row[] };
    expect(english.properties.map((property) => property.name)).toEqual([
      'Name', 'Status', 'Tags', 'Date',
    ]);
    expect(english.views[0]?.name).toBe('Calendar');

    const korean = (await callFunction(POST, db(), OWNER, {
      action: 'createDatabase',
      id: 'db-locale-ko',
      workspaceId: 'ws1',
      parentId: null,
      parentType: 'workspace',
      viewType: 'calendar',
      locale: 'ko-KR',
      seedRows: false,
    })) as { properties: Row[]; views: Row[] };
    expect(korean.properties.map((property) => property.name)).toEqual([
      '이름', '상태', '태그', '날짜',
    ]);
    expect(korean.views[0]?.name).toBe('캘린더');
    expect((korean.properties[1]?.config as { options?: Row[] })?.options?.map((option) => option.name))
      .toEqual(['시작 전', '진행 중', '완료']);
  });

  it.each([
    [undefined, ['Name', 'Title'], 'Title 2'],
    ['ko-KR', ['이름', '제목'], '제목 2'],
  ] as const)(
    'generates a collision-free localized title when both base labels already exist (%s)',
    async (locale, names, expectedTitle) => {
      const result = await callFunction(POST, db(), OWNER, {
        action: 'createDatabase', id: `db-title-${locale ?? 'en'}`, workspaceId: 'ws1',
        parentId: null, parentType: 'workspace', locale, seedRows: false,
        properties: names.map((name, index) => ({
          id: `prop-${index}`, name, type: 'rich_text', position: index + 1,
        })),
      }) as { properties: Row[] };
      expect(result.properties[0]).toMatchObject({ type: 'title', name: expectedTitle });
      expect(new Set(result.properties.map((property) => property.name)).size)
        .toBe(result.properties.length);
    },
  );

  it.each([
    ['calendar', undefined, 'Existing date', 'calendarBy'],
    ['timeline', 'ko-KR', '기존 날짜', 'timelineBy'],
  ] as const)(
    'reuses a custom date property as the %s axis (%s)',
    async (viewType, locale, dateName, axis) => {
      const result = await callFunction(POST, db(), OWNER, {
        action: 'createDatabase', id: `db-date-${viewType}`, workspaceId: 'ws1',
        parentId: null, parentType: 'workspace', locale, viewType, seedRows: false,
        properties: [
          { id: 'prop-title', name: locale ? '이름' : 'Name', type: 'title', position: 1 },
          { id: 'prop-existing-date', name: dateName, type: 'date', position: 2 },
        ],
      }) as { properties: Row[]; views: Row[] };
      expect(result.properties).toHaveLength(2);
      expect(result.properties.filter((property) => property.type === 'date')).toEqual([
        expect.objectContaining({ id: 'prop-existing-date', name: dateName }),
      ]);
      expect(result.views[0]?.config).toMatchObject({ [axis]: 'prop-existing-date' });
    },
  );

  it.each([
    [undefined, 'Date', 'Date 2', ['Option 1', 'Option 2']],
    ['ko-KR', '날짜', '날짜 2', ['옵션 1', '옵션 2']],
  ] as const)(
    'uses collision-free date and option fallbacks for locale %s',
    async (locale, reservedDateName, expectedDateName, expectedOptions) => {
      const result = await callFunction(POST, db(), OWNER, {
        action: 'createDatabase', id: `db-fallback-${locale ?? 'en'}`, workspaceId: 'ws1',
        parentId: null, parentType: 'workspace', locale, viewType: 'calendar', seedRows: false,
        properties: [
          { id: 'prop-title', name: locale ? '이름' : 'Name', type: 'title', position: 1 },
          { id: 'prop-date-name', name: reservedDateName, type: 'rich_text', position: 2 },
          {
            id: 'prop-select', name: locale ? '선택' : 'Select', type: 'select', position: 3,
            options: [{}, ''],
          },
        ],
      }) as { properties: Row[] };
      expect(result.properties.find((property) => property.type === 'date')?.name)
        .toBe(expectedDateName);
      const select = result.properties.find((property) => property.id === 'prop-select');
      expect((select?.config as { options?: Row[] }).options?.map((option) => option.name))
        .toEqual(expectedOptions);
    },
  );

  it('preserves a blank database title instead of storing New database', async () => {
    const database = db();
    const res = (await callFunction(POST, database, OWNER, {
      action: 'createDatabase',
      id: 'db-empty-title',
      workspaceId: 'ws1',
      parentId: null,
      parentType: 'workspace',
      title: '',
      seedRows: false,
      properties: [{ id: 'prop-name', name: 'Name', type: 'title', position: 1 }],
    })) as { page: Row; rows: Row[] };

    expect(res.page.id).toBe('db-empty-title');
    expect(res.page.title).toBe('');
    expect(database.tables.pages.find((page) => page.id === 'db-empty-title')?.title).toBe('');
    expect(res.rows).toHaveLength(0);
  });

  it('still preserves an explicitly typed New database title', async () => {
    const res = (await callFunction(POST, db(), OWNER, {
      action: 'createDatabase',
      id: 'db-explicit-title',
      workspaceId: 'ws1',
      parentId: null,
      parentType: 'workspace',
      title: 'New database',
      seedRows: false,
      properties: [{ id: 'prop-name', name: 'Name', type: 'title', position: 1 }],
    })) as { page: Row };

    expect(res.page.title).toBe('New database');
  });

  it('creates page, schema, view, and starter rows in one all-or-nothing content transaction', async () => {
    const database = db();
    const originalTransact = database.transact.bind(database);
    let creationOperations: Array<{ table: string; op: string }> = [];
    database.transact = async (operations) => {
      if (operations.some((operation) => (
        operation.table === 'pages'
        && operation.op === 'insert'
        && 'data' in operation
        && operation.data.id === 'db-atomic-failure'
      ))) {
        creationOperations = operations.map((operation) => ({
          table: operation.table,
          op: operation.op,
        }));
        throw new Error('synthetic content transaction outage');
      }
      return originalTransact(operations);
    };

    const response = await callFunction(POST, database, OWNER, {
      action: 'createDatabase',
      id: 'db-atomic-failure',
      workspaceId: 'ws1',
      parentId: null,
      parentType: 'workspace',
      viewType: 'table',
      properties: [{ id: 'prop-name', name: 'Name', type: 'title', position: 1 }],
    });

    await expectErrorResponse(response, 500, 'Internal server error');
    expect(
      creationOperations
        .filter((operation) => operation.table !== 'change_log')
        .map((operation) => operation.table),
    ).toEqual([
      'pages',
      'db_properties',
      'db_views',
      'pages',
      'pages',
      'pages',
    ]);
    expect(database.tables.pages ?? []).toEqual([]);
    expect(database.tables.db_properties ?? []).toEqual([]);
    expect(database.tables.db_views ?? []).toEqual([]);
  });

  it.each([
    ['local key', 'workspaces/ws1/icons/existing.png', []],
    ['canonical route', '/api/storage/files/workspaces/ws1/icons/existing.png', []],
    [
      'exact registered URL',
      'https://storage.example/api/storage/files/workspaces/ws1/icons/existing.png',
      [{
        id: 'existing-upload', workspaceId: 'ws1', pageId: 'other-page', bucket: 'files',
        key: 'workspaces/ws1/icons/existing.png',
        url: 'https://storage.example/api/storage/files/workspaces/ws1/icons/existing.png',
        status: 'uploaded',
      }],
    ],
  ])('rejects an unowned stored-file database icon at create time: %s', async (
    _label,
    icon,
    uploads,
  ) => {
    const database = db({ file_uploads: uploads as Row[] });
    const response = await callFunction(POST, database, OWNER, {
      action: 'createDatabase', id: 'db-file-icon', workspaceId: 'ws1',
      parentId: null, parentType: 'workspace', icon, seedRows: false,
      properties: [{ id: 'prop-name', name: 'Name', type: 'title', position: 1 }],
    });

    await expectErrorResponse(response, 409, 'create it first, then upload');
    expect(database.tables.pages ?? []).toEqual([]);
  });

  it('allows emoji and ordinary external database icons', async () => {
    const emoji = await callFunction(POST, db(), OWNER, {
      action: 'createDatabase', id: 'db-emoji', workspaceId: 'ws1',
      parentId: null, parentType: 'workspace', icon: '📚', seedRows: false,
      properties: [{ id: 'prop-name', name: 'Name', type: 'title', position: 1 }],
    }) as { page: Row };
    expect(emoji.page.icon).toBe('📚');

    const external = await callFunction(POST, db(), OWNER, {
      action: 'createDatabase', id: 'db-external', workspaceId: 'ws1',
      parentId: null, parentType: 'workspace', icon: 'https://images.example/database.png',
      seedRows: false,
      properties: [{ id: 'prop-name', name: 'Name', type: 'title', position: 1 }],
    }) as { page: Row };
    expect(external.page.icon).toBe('https://images.example/database.png');
  });
});
