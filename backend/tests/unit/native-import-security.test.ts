import { describe, expect, it, vi } from 'vitest';

import { mapNativeExportWithConcurrency, POST } from '../../functions/import-export';
import { NATIVE_FORMAT, type NativeExportEnvelope } from '../../lib/native-document';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';
const EDITOR = 'editor-1';

function page(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: id,
    position: 0,
    inTrash: false,
    ...extra,
  };
}

function database() {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Destination', ownerId: OWNER }],
    pages: [
      page('editable-parent'),
      page('victim-db', { kind: 'database', title: 'Private database' }),
    ],
    page_permissions: [{
      id: 'parent-edit',
      pageId: 'editable-parent',
      workspaceId: 'ws1',
      principalType: 'user',
      principalId: EDITOR,
      role: 'edit',
    }],
    db_properties: [{
      id: 'victim-title',
      databaseId: 'victim-db',
      name: 'Name',
      type: 'title',
      position: 0,
    }],
  });
}

function envelope(extra: Partial<NativeExportEnvelope> = {}): NativeExportEnvelope {
  return {
    format: NATIVE_FORMAT,
    formatVersion: 1,
    generatedAt: '2026-07-10T00:00:00.000Z',
    scope: { kind: 'subtree', rootIds: ['source-root'] },
    source: { workspaceId: 'source-ws', workspaceName: 'Source' },
    counts: { pages: 1, databases: 0, blocks: 0, dbProperties: 0, dbViews: 0, dbTemplates: 0, comments: 0 },
    files: { included: false, strippedReferences: 0 },
    entities: {
      pages: [{
        id: 'source-root',
        workspaceId: 'source-ws',
        parentId: null,
        parentType: 'workspace',
        kind: 'page',
        title: 'Imported root',
        position: 0,
      }],
      blocks: [],
      dbProperties: [],
      dbViews: [],
      dbTemplates: [],
      comments: [],
    },
    relationPairs: [],
    warnings: [],
    ...extra,
  };
}

function envelopeWithBlock(): NativeExportEnvelope {
  const document = envelope();
  document.counts.blocks = 1;
  document.entities.blocks = [{
    id: 'source-block',
    pageId: 'source-root',
    parentId: null,
    type: 'paragraph',
    content: { text: 'Rollback probe' },
    position: 0,
  }];
  return document;
}

describe('native import security boundary', () => {
  it('bounds native-export fan-out while preserving result order', async () => {
    let active = 0;
    let maxActive = 0;
    const result = await mapNativeExportWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });
    expect(maxActive).toBe(2);
    expect(result).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it('maps routing-hint failures inside the handler catch', async () => {
    const result = await callFunction(POST, database(), OWNER, { action: 'exportPageNative' });
    await expectErrorResponse(result, 400, 'pageId is required');
  });

  it('exports through the sanitizer and detaches subtree roots from omitted ancestors', async () => {
    const db = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Source', ownerId: OWNER }],
      pages: [
        page('parent'),
        page('child', {
          parentId: 'parent',
          parentType: 'page',
          createdBy: 'source-user',
          properties: {
            __notion: {
              access_token: 'ntn_secret',
              url: 'https://signed.example/file?token=secret',
              created_by: { object: 'user', id: 'notion-user', person: { email: 'source@example.com' } },
            },
          },
        }),
      ],
      blocks: [],
      comments: [],
      db_properties: [],
      db_views: [],
      db_templates: [],
    });
    const result = await callFunction(POST, db, OWNER, { action: 'exportPageNative', pageId: 'child' }) as {
      document: NativeExportEnvelope;
    };
    expect(result.document.scope.rootIds).toEqual(['child']);
    expect(result.document.entities.pages[0]).toMatchObject({
      id: 'child',
      parentId: null,
      parentType: 'workspace',
    });
    const serialized = JSON.stringify(result.document);
    expect(serialized).not.toContain('ntn_secret');
    expect(serialized).not.toContain('source@example.com');
    expect(serialized).not.toContain('source-user');
    expect(serialized).not.toContain('signed.example');
  });

  it('requires edit access to the selected destination parent', async () => {
    const result = await callFunction(POST, database(), 'stranger', {
      action: 'importNative',
      workspaceId: 'ws1',
      parentId: 'editable-parent',
      parentType: 'page',
      document: envelope(),
    });
    await expectErrorResponse(result, 403, 'Page access required.');
  });

  it('imports a valid closed document only under the authorized destination', async () => {
    const db = database();
    const result = await callFunction(POST, db, EDITOR, {
      action: 'importNative',
      workspaceId: 'ws1',
      parentId: 'editable-parent',
      parentType: 'page',
      document: envelope(),
    }) as { rootPageIds: string[]; counts: Record<string, number> };
    expect(result.rootPageIds).toHaveLength(1);
    expect(result.counts.pages).toBe(1);
    const imported = db.tables.pages.find((row) => row.id === result.rootPageIds[0]);
    expect(imported).toMatchObject({
      workspaceId: 'ws1',
      parentId: 'editable-parent',
      parentType: 'page',
      title: 'Imported root',
      createdBy: EDITOR,
      lastEditedBy: EDITOR,
    });
  });

  it('cannot use parent edit access to inject schema into an unrelated destination database', async () => {
    const db = database();
    const malicious = envelope();
    malicious.entities.dbProperties = [{
      id: 'attack-property',
      databaseId: 'victim-db',
      name: 'Injected',
      type: 'rich_text',
      position: 1,
    }];
    malicious.counts.dbProperties = 1;

    const result = await callFunction(POST, db, EDITOR, {
      action: 'importNative',
      workspaceId: 'ws1',
      parentId: 'editable-parent',
      parentType: 'page',
      document: malicious,
    });

    await expectErrorResponse(result, 400, 'databaseId must reference a database in this export');
    expect(db.tables.db_properties.map((property) => property.id)).toEqual(['victim-title']);
    expect(db.tables.pages.map((row) => row.id).sort()).toEqual(['editable-parent', 'victim-db']);
  });

  it('removes page workspace indexes when a native import rolls back', async () => {
    const db = database();
    const originalTable = db.table.bind(db);
    db.table = ((name: string) => {
      const table = originalTable(name);
      if (name !== 'blocks') return table;
      return {
        ...table,
        async insert() {
          throw Object.assign(new Error('blocks/duplicate already exists'), { code: 409 });
        },
      };
    }) as typeof db.table;

    const result = await callFunction(POST, db, EDITOR, {
      action: 'importNative',
      workspaceId: 'ws1',
      parentId: 'editable-parent',
      parentType: 'page',
      document: envelopeWithBlock(),
    });

    await expectErrorResponse(result, 409, 'already exists');
    expect(db.tables.pages.map((row) => row.id).sort()).toEqual(['editable-parent', 'victim-db']);
    expect(db.tables.page_workspace_index.map((row) => row.id).sort()).toEqual([
      'editable-parent',
      'victim-db',
    ]);
  });

  it('surfaces an incomplete native-import rollback as an internal failure', async () => {
    const db = database();
    const originalTable = db.table.bind(db);
    db.table = ((name: string) => {
      const table = originalTable(name);
      if (name === 'blocks') {
        return {
          ...table,
          async insert() {
            throw Object.assign(new Error('blocks/duplicate already exists'), { code: 409 });
          },
        };
      }
      if (name === 'page_workspace_index') {
        return {
          ...table,
          async delete(id: string) {
            if (!['editable-parent', 'victim-db'].includes(id)) {
              throw new Error('forced page workspace index cleanup failure');
            }
            return table.delete(id);
          },
        };
      }
      return table;
    }) as typeof db.table;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await callFunction(POST, db, EDITOR, {
        action: 'importNative',
        workspaceId: 'ws1',
        parentId: 'editable-parent',
        parentType: 'page',
        document: envelopeWithBlock(),
      });

      await expectErrorResponse(result, 500, 'Internal server error.');
      const loggedError = errorLog.mock.calls[0]?.[1] as
        | (Error & { cleanupFailures?: unknown[]; originalError?: unknown })
        | undefined;
      expect(loggedError?.name).toBe('NativeImportRollbackError');
      expect(loggedError?.cleanupFailures).toHaveLength(1);
      expect(loggedError?.originalError).toMatchObject({ code: 409 });
      expect(db.tables.pages.map((row) => row.id).sort()).toEqual(['editable-parent', 'victim-db']);
      expect(db.tables.page_workspace_index).toHaveLength(3);
    } finally {
      errorLog.mockRestore();
    }
  });
});
