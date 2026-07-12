import { describe, expect, it } from 'vitest';

import {
  POST,
  IMPORT_EXPORT_REQUEST_MAX_BYTES,
  IMPORT_TEXT_RAW_MAX_BYTES,
  blockChildrenByParent,
  blockTreeMarkdown,
  nativeImportPagesParentFirst,
} from '../../functions/import-export';
import { fakeDb, type FakeDb, type FakeTransactOperation, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';

function baseDb(extra: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws-1', name: 'Workspace', ownerId: OWNER }],
    workspace_members: [{ id: 'm1', workspaceId: 'ws-1', userId: OWNER, role: 'owner' }],
    pages: [],
    blocks: [],
    db_properties: [],
    db_views: [],
    page_permissions: [],
    organization_members: [],
    ...extra,
  });
}

function pageRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws-1',
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: id,
    position: 0,
    inTrash: false,
    isLocked: false,
    createdBy: OWNER,
    ...extra,
  };
}

function blockRow(id: string, position: number): Row {
  return {
    id,
    pageId: 'page-1',
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: `old ${id}` }] },
    plainText: `old ${id}`,
    position,
    createdBy: OWNER,
  };
}

// Poison one table's insert so the Nth call fails; the counter is shared
// across db.table() calls so multi-lookup flows still trip it.
function poisonInsert(db: FakeDb, tableName: string, failOnCall: number, message: string) {
  const realTable = db.table.bind(db);
  let calls = 0;
  (db as { table: FakeDb['table'] }).table = <T,>(name: string) => {
    const table = realTable<T>(name);
    if (name !== tableName) return table;
    const realInsert = table.insert.bind(table);
    return {
      ...table,
      getOne: table.getOne.bind(table),
      update: table.update.bind(table),
      delete: table.delete.bind(table),
      where: table.where.bind(table),
      page: table.page.bind(table),
      limit: table.limit.bind(table),
      getList: table.getList.bind(table),
      async insert(row: Partial<T>) {
        calls += 1;
        if (calls === failOnCall) throw Object.assign(new Error(message), { code: 500 });
        return realInsert(row);
      },
    };
  };
}

describe('markdown/CSV import payload caps (#7)', () => {
  it('rejects an oversized markdown payload before creating any page', async () => {
    const db = baseDb();
    const res = await callFunction(POST, db, OWNER, {
      action: 'importMarkdownPage',
      workspaceId: 'ws-1',
      markdown: 'a'.repeat(IMPORT_EXPORT_REQUEST_MAX_BYTES + 1),
    });
    await expectErrorResponse(res, 413, 'Import/export request payload is too large.');
    expect(db.tables.pages).toHaveLength(0);
    expect(db.tables.blocks).toHaveLength(0);
  });

  it('counts JSON escaping against the serialized request cap before the raw-text ceiling', async () => {
    const db = baseDb();
    const escapedText = '\\'.repeat(Math.floor(IMPORT_EXPORT_REQUEST_MAX_BYTES / 2) + 100);
    expect(new TextEncoder().encode(escapedText).byteLength).toBeLessThan(IMPORT_TEXT_RAW_MAX_BYTES);
    const res = await callFunction(POST, db, OWNER, {
      action: 'importMarkdownPage',
      workspaceId: 'ws-1',
      markdown: escapedText,
    });
    await expectErrorResponse(res, 413, 'Import/export request payload is too large.');
    expect(db.tables.pages).toHaveLength(0);
    expect(db.tables.blocks).toHaveLength(0);
  });

  it('rejects markdown that parses into more blocks than the native limit', async () => {
    const db = baseDb();
    const res = await callFunction(POST, db, OWNER, {
      action: 'importMarkdownPage',
      workspaceId: 'ws-1',
      markdown: Array.from({ length: 20_001 }, (_, index) => `line ${index}`).join('\n'),
    });
    await expectErrorResponse(res, 413, 'limited to 20000 blocks');
    expect(db.tables.pages).toHaveLength(0);
    expect(db.tables.blocks).toHaveLength(0);
  });

  it('still imports a small markdown page', async () => {
    const db = baseDb();
    const result = (await callFunction(POST, db, OWNER, {
      action: 'importMarkdownPage',
      workspaceId: 'ws-1',
      markdown: '# Title\n\n- item',
    })) as { count: number };
    expect(result.count).toBe(2);
    expect(db.tables.pages).toHaveLength(1);
    expect(db.tables.blocks).toHaveLength(2);
  });

  it('rejects a CSV with more data rows than the import row cap', async () => {
    const db = baseDb();
    const csv = ['Name,Value', ...Array.from({ length: 10_001 }, (_, index) => `row-${index},1`)].join('\n');
    const res = await callFunction(POST, db, OWNER, {
      action: 'importCsvDatabase',
      workspaceId: 'ws-1',
      csv,
    });
    await expectErrorResponse(res, 413, 'limited to 10000 rows');
    expect(db.tables.pages).toHaveLength(0);
    expect(db.tables.db_properties).toHaveLength(0);
  });

  it('applies the byte ceiling to CSV payloads too', async () => {
    const db = baseDb();
    const res = await callFunction(POST, db, OWNER, {
      action: 'importCsvDatabase',
      workspaceId: 'ws-1',
      csv: `Name\n${'b'.repeat(IMPORT_EXPORT_REQUEST_MAX_BYTES + 1)}`,
    });
    await expectErrorResponse(res, 413, 'Import/export request payload is too large.');
    expect(db.tables.pages).toHaveLength(0);
  });
});

describe('native import parent ordering', () => {
  it('stably places every imported page before its descendants', () => {
    const pages = [
      { id: 'row', parentId: 'database', parentType: 'database' as const },
      { id: 'grandchild', parentId: 'child', parentType: 'page' as const },
      { id: 'root-b', parentId: null, parentType: 'workspace' as const },
      { id: 'child', parentId: 'root-a', parentType: 'page' as const },
      { id: 'database', parentId: null, parentType: 'workspace' as const },
      { id: 'root-a', parentId: null, parentType: 'workspace' as const },
    ];

    expect(nativeImportPagesParentFirst(pages).map((page) => page.id)).toEqual([
      'root-b',
      'database',
      'root-a',
      'row',
      'child',
      'grandchild',
    ]);
  });

  it('fails closed if an invalid document somehow reaches import with an unresolved parent', () => {
    expect(() => nativeImportPagesParentFirst([
      { id: 'child', parentId: 'missing', parentType: 'page' as const },
    ])).toThrow('Invalid Hanji export: page parent is unresolved');
  });
});

describe('replaceMarkdownPage compensates partial failures (#8)', () => {
  it('rejects imported local storage references before creating or appending blocks', async () => {
    const key = 'workspaces/ws-1/uploads/shared.png';
    const db = baseDb({
      pages: [pageRow('page-1')],
      file_uploads: [{
        id: 'upload-shared', workspaceId: 'ws-1', pageId: 'page-1', key,
        url: `/api/storage/files/${key}`, status: 'uploaded',
      }],
    });
    const markdown = `![Copied](/api/storage/files/${key})`;

    const imported = await callFunction(POST, db, OWNER, {
      action: 'importMarkdownPage', workspaceId: 'ws-1', markdown,
    });
    await expectErrorResponse(imported, 409, 'Stored files cannot be attached');
    expect(db.tables.pages.map((row) => row.id)).toEqual(['page-1']);

    const appended = await callFunction(POST, db, OWNER, {
      action: 'appendMarkdownToPage', workspaceId: 'ws-1', pageId: 'page-1', markdown,
    });
    await expectErrorResponse(appended, 409, 'Stored files cannot be attached');
    expect(db.tables.blocks).toEqual([]);
    expect(db.tables.file_uploads[0]).toMatchObject({ status: 'uploaded', key });
  });

  it('does not replace an existing block that still owns a stored file', async () => {
    const key = 'workspaces/ws-1/uploads/existing.png';
    const existing = blockRow('file-block', 1);
    existing.type = 'image';
    existing.content = { url: `/api/storage/files/${key}`, name: 'existing.png' };
    const db = baseDb({
      pages: [pageRow('page-1')],
      blocks: [existing],
      file_uploads: [{
        id: 'upload-existing', workspaceId: 'ws-1', pageId: 'page-1',
        blockId: 'file-block', key, url: `/api/storage/files/${key}`, status: 'uploaded',
      }],
    });

    const result = await callFunction(POST, db, OWNER, {
      action: 'replaceMarkdownPage',
      workspaceId: 'ws-1',
      pageId: 'page-1',
      markdown: 'replacement',
    });

    await expectErrorResponse(result, 409, 'cannot remove blocks containing stored files');
    expect(db.tables.blocks).toEqual([existing]);
    expect(db.tables.file_uploads[0]).toMatchObject({ status: 'uploaded', key });
  });

  it('rolls the new blocks back when an insert fails mid-way, keeping old content', async () => {
    const db = baseDb({
      pages: [pageRow('page-1')],
      blocks: [blockRow('b1', 1), blockRow('b2', 2)],
    });
    poisonInsert(db, 'blocks', 3, 'simulated block storage failure');
    const res = await callFunction(POST, db, OWNER, {
      action: 'replaceMarkdownPage',
      workspaceId: 'ws-1',
      pageId: 'page-1',
      markdown: 'one\n\ntwo\n\nthree\n\nfour',
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(500);
    // Old content intact, no half-written replacement blocks left behind.
    expect(db.tables.blocks.map((row) => row.id).sort()).toEqual(['b1', 'b2']);
  });

  it('restores deleted old blocks and removes new ones when the delete phase fails', async () => {
    const db = baseDb({
      pages: [pageRow('page-1')],
      blocks: [blockRow('b1', 1), blockRow('b2', 2)],
    });
    // Block deletes run through boundedDb's transact (delete + change_log
    // tombstone); poison the b2 delete there.
    const realTransact = db.transact.bind(db);
    db.transact = async (operations: FakeTransactOperation[]) => {
      if (operations.some((op) => op.table === 'blocks' && op.op === 'delete' && op.id === 'b2')) {
        throw Object.assign(new Error('simulated delete failure'), { code: 500 });
      }
      return realTransact(operations);
    };
    const res = await callFunction(POST, db, OWNER, {
      action: 'replaceMarkdownPage',
      workspaceId: 'ws-1',
      pageId: 'page-1',
      markdown: 'new one\n\nnew two',
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(500);
    // The page must not keep both versions: old restored, new rolled back.
    expect(db.tables.blocks.map((row) => row.id).sort()).toEqual(['b1', 'b2']);
    expect(db.tables.blocks.map((row) => row.plainText).sort()).toEqual(['old b1', 'old b2']);
  });

  it('replaces content atomically in the happy path', async () => {
    const db = baseDb({
      pages: [pageRow('page-1')],
      blocks: [blockRow('b1', 1)],
    });
    const result = (await callFunction(POST, db, OWNER, {
      action: 'replaceMarkdownPage',
      workspaceId: 'ws-1',
      pageId: 'page-1',
      markdown: 'fresh',
    })) as { count: number; deletedIds: string[] };
    expect(result.count).toBe(1);
    expect(result.deletedIds).toEqual(['b1']);
    expect(db.tables.blocks).toHaveLength(1);
    expect(db.tables.blocks[0].plainText).toBe('fresh');
  });
});

describe('importCsvDatabase compensates partial failures (#8)', () => {
  it('removes the database, schema, view, rows, and routing indexes when a row insert fails', async () => {
    const db = baseDb();
    // pages inserts: 1 = database container, 2 = first row, 3 = second row (fails).
    poisonInsert(db, 'pages', 3, 'simulated row storage failure');
    const res = await callFunction(POST, db, OWNER, {
      action: 'importCsvDatabase',
      workspaceId: 'ws-1',
      csv: 'Name,Value\nrow-1,1\nrow-2,2',
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(500);
    expect(db.tables.pages).toHaveLength(0);
    expect(db.tables.db_properties).toHaveLength(0);
    expect(db.tables.db_views).toHaveLength(0);
    expect(db.tables.page_workspace_index ?? []).toHaveLength(0);
  });

  it('imports a small CSV database in the happy path', async () => {
    const db = baseDb();
    const result = (await callFunction(POST, db, OWNER, {
      action: 'importCsvDatabase',
      workspaceId: 'ws-1',
      csv: 'Name,Value\nrow-1,1\nrow-2,2',
    })) as { count: number; properties: unknown[] };
    expect(result.count).toBe(2);
    expect(result.properties).toHaveLength(2);
    // 1 database container + 2 rows.
    expect(db.tables.pages).toHaveLength(3);
    expect(db.tables.db_views).toHaveLength(1);
  });

  it('persists Korean missing headers, database title, and table view for the product locale', async () => {
    const db = baseDb();
    const result = (await callFunction(POST, db, OWNER, {
      action: 'importCsvDatabase',
      workspaceId: 'ws-1',
      locale: 'ko',
      csv: ',,Amount\nalpha,1,2',
    })) as {
      page: { title: string };
      properties: Array<{ name: string }>;
      view: { name: string };
    };
    expect(result.page.title).toBe('가져온 데이터베이스');
    expect(result.properties.map((property) => property.name)).toEqual(['이름', '열 2', 'Amount']);
    expect(result.view.name).toBe('표');
  });

  it('keeps omitted API locale defaults in English and rejects unsupported locale values', async () => {
    const db = baseDb();
    const result = (await callFunction(POST, db, OWNER, {
      action: 'importCsvDatabase',
      workspaceId: 'ws-1',
      csv: ',,Amount\nalpha,1,2',
    })) as {
      page: { title: string };
      properties: Array<{ name: string }>;
      view: { name: string };
    };
    expect(result.page.title).toBe('Imported database');
    expect(result.properties.map((property) => property.name)).toEqual(['Name', 'Column 2', 'Amount']);
    expect(result.view.name).toBe('Table');

    const invalid = await callFunction(POST, baseDb(), OWNER, {
      action: 'importCsvDatabase',
      workspaceId: 'ws-1',
      locale: 'ko-KR',
      csv: 'Name\nalpha',
    });
    await expectErrorResponse(invalid, 400, 'locale must be "en" or "ko".');
  });
});

describe('blockTreeMarkdown cycle guard (#9)', () => {
  const context = { fileUrl: async (value: string) => value };

  function cycleBlock(id: string, parentId: string, position: number) {
    return {
      id,
      pageId: 'page-1',
      parentId,
      type: 'paragraph',
      content: { rich: [{ text: `text ${id}` }] },
      plainText: `text ${id}`,
      position,
    };
  }

  it('terminates on a synthetic parent cycle instead of recursing forever', async () => {
    // Direct writes can corrupt parent links into a->b->a; the walk must visit
    // each block once and stop.
    const a = cycleBlock('a', 'b', 0);
    const b = cycleBlock('b', 'a', 1);
    const markdown = await blockTreeMarkdown(
      a as never,
      blockChildrenByParent([a, b] as never[]),
      context,
    );
    expect(markdown).toContain('text a');
    expect(markdown).toContain('text b');
  });

  it('builds one children map with position-sorted siblings', () => {
    const blocks = [
      cycleBlock('late', 'root', 5),
      cycleBlock('early', 'root', 1),
      { ...cycleBlock('root', '', 0), parentId: null },
    ];
    const map = blockChildrenByParent(blocks as never[]);
    expect(map.get('root')?.map((block) => (block as { id: string }).id)).toEqual(['early', 'late']);
    expect(map.has('')).toBe(false);
  });

  it('emits only canonical Hanji mention links in new Markdown exports', async () => {
    const block = {
      id: 'root',
      pageId: 'page-1',
      parentId: null,
      type: 'paragraph',
      content: {
        rich: [
          { text: 'Today', mention: 'date', date: '2026-07-12' },
          { text: 'Owner', mention: 'person', userId: 'user-1' },
        ],
      },
      plainText: 'TodayOwner',
      position: 0,
    };
    const markdown = await blockTreeMarkdown(
      block as never,
      blockChildrenByParent([block] as never[]),
      context,
    );
    expect(markdown).toContain('hanji://date/2026-07-12');
    expect(markdown).toContain('hanji://person/user-1');
  });
});
