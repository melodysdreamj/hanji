import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { POST } from '../../functions/collaboration-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';
const MEMBER = 'member-1';
const GUEST = 'guest-1';
const STRANGER = 'stranger-1';
const T0 = '2026-01-01T00:00:00.000Z';

function pageRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Page ${id}`,
    position: 0,
    inTrash: false,
    isLocked: false,
    createdBy: OWNER,
    ...extra,
  };
}

function blockRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    pageId: 'p1',
    parentId: null,
    type: 'paragraph',
    plainText: `Block ${id}`,
    position: 0,
    createdBy: OWNER,
    ...extra,
  };
}

function operationRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    pageId: 'p1',
    blockId: 'b1',
    clientId: 'client-1',
    kind: 'text',
    revision: 1,
    actorId: OWNER,
    occurredAt: T0,
    ...extra,
  };
}

function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    workspace_members: [
      { id: 'm1', workspaceId: 'ws1', userId: MEMBER, role: 'member' },
      { id: 'm2', workspaceId: 'ws1', userId: GUEST, role: 'guest' },
    ],
    pages: [pageRow('p1')],
    blocks: [blockRow('b1')],
    ...tables,
  });
}

function yTextUpdateBase64(text: string) {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
}

function decodedText(stateBase64: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(stateBase64, 'base64'));
  return doc.getText('t').toString();
}

function createBody(extra: Record<string, unknown> = {}) {
  return {
    action: 'create',
    pageId: 'p1',
    clientId: 'client-1',
    occurredAt: T0,
    ...extra,
  };
}

describe('collaboration-mutation POST', () => {
  it('requires authentication', async () => {
    const res = await callFunction(POST, db(), null, createBody());
    await expectErrorResponse(res, 401, 'Authentication required.');
  });

  it('rejects a body without a pageId routing hint', async () => {
    const res = await callFunction(POST, db(), OWNER, { action: 'create', clientId: 'client-1' });
    await expectErrorResponse(res, 400, 'pageId is required.');
  });

  it('rejects an unknown action', async () => {
    const res = await callFunction(POST, db(), OWNER, { action: 'bogus', pageId: 'p1' });
    await expectErrorResponse(res, 400, 'Unknown collaboration mutation action.');
  });

  describe('authorization', () => {
    it('lets the workspace owner create a text operation', async () => {
      const database = db();
      const res = (await callFunction(POST, database, OWNER, createBody({ blockId: 'b1' }))) as {
        operation: Row;
        document?: Row;
      };
      expect(res.operation.workspaceId).toBe('ws1');
      expect(res.operation.pageId).toBe('p1');
      expect(res.operation.blockId).toBe('b1');
      expect(res.operation.actorId).toBe(OWNER);
      expect(res.operation.kind).toBe('text');
      expect(res.operation.revision).toBe(Date.parse(T0));
      // Plain text operations do not upsert a CRDT document.
      expect(res.document).toBeUndefined();
      expect(database.tables.collaboration_operations).toHaveLength(1);
    });

    it('lets an edit-role workspace member create operations', async () => {
      const res = (await callFunction(POST, db(), MEMBER, createBody())) as { operation: Row };
      expect(res.operation.actorId).toBe(MEMBER);
    });

    it('denies a view-role workspace guest', async () => {
      const res = await callFunction(POST, db(), GUEST, createBody());
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('denies strangers with no relation to the workspace', async () => {
      const res = await callFunction(POST, db(), STRANGER, createBody());
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('honors an edit permission inherited from an ancestor page', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('child', { parentId: 'p1', parentType: 'page' })],
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'edit',
          },
        ],
      });
      const res = (await callFunction(POST, database, STRANGER, createBody({ pageId: 'child' }))) as {
        operation: Row;
      };
      expect(res.operation.pageId).toBe('child');
    });

    it('rejects a direct grant weaker than edit', async () => {
      const database = db({
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'user',
            principalId: STRANGER,
            role: 'comment',
          },
        ],
      });
      const res = await callFunction(POST, database, STRANGER, createBody());
      await expectErrorResponse(res, 403, 'Page access required.');
    });

    it('rejects deactivated organization members even when they are workspace members', async () => {
      const database = fakeDb({
        workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
        organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
        organization_members: [
          { id: 'om1', organizationId: 'org1', userId: MEMBER, status: 'deactivated' },
        ],
        workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: MEMBER, role: 'member' }],
        pages: [pageRow('p1')],
      });
      const res = await callFunction(POST, database, MEMBER, createBody());
      await expectErrorResponse(res, 403, 'Organization active access required.');
    });

    it('rejects pages in trash', async () => {
      const database = db({ pages: [pageRow('p1', { inTrash: true })] });
      const res = await callFunction(POST, database, OWNER, createBody());
      await expectErrorResponse(res, 400, 'Page is in trash.');
    });

    it('rejects locked pages with 423', async () => {
      const database = db({ pages: [pageRow('p1', { isLocked: true })] });
      const res = await callFunction(POST, database, OWNER, createBody());
      await expectErrorResponse(res, 423, 'Page is locked.');
    });

    it('requires edit access even for the read-only list action', async () => {
      const res = await callFunction(POST, db(), GUEST, { action: 'list', pageId: 'p1' });
      await expectErrorResponse(res, 403, 'Page access required.');
    });
  });

  describe('validation', () => {
    it('requires a clientId', async () => {
      const res = await callFunction(POST, db(), OWNER, { action: 'create', pageId: 'p1' });
      await expectErrorResponse(res, 400, 'clientId is required.');
    });

    it('rejects a blockId that lives on another page', async () => {
      const database = db({
        pages: [pageRow('p1'), pageRow('p2')],
        blocks: [blockRow('b1'), blockRow('foreign', { pageId: 'p2' })],
      });
      const res = await callFunction(POST, database, OWNER, createBody({ blockId: 'foreign' }));
      await expectErrorResponse(res, 404, 'Block is outside the page.');
    });
  });

  describe('crdt_update operations', () => {
    it('rejects a non-yjs engine', async () => {
      const res = await callFunction(POST, db(), OWNER, createBody({
        kind: 'crdt_update',
        operation: { engine: 'automerge', updateBase64: yTextUpdateBase64('x') },
      }));
      await expectErrorResponse(res, 400, 'CRDT update engine must be "yjs".');
    });

    it('requires updateBase64', async () => {
      const res = await callFunction(POST, db(), OWNER, createBody({
        kind: 'crdt_update',
        operation: { engine: 'yjs' },
      }));
      await expectErrorResponse(res, 400, 'updateBase64 is required for CRDT updates.');
    });

    it('rejects malformed base64', async () => {
      const res = await callFunction(POST, db(), OWNER, createBody({
        kind: 'crdt_update',
        operation: { engine: 'yjs', updateBase64: '!!not-base64!!' },
      }));
      await expectErrorResponse(res, 400, 'updateBase64 must be valid base64.');
    });

    it('rejects valid base64 that is not a mergeable yjs update', async () => {
      const res = await callFunction(POST, db(), OWNER, createBody({
        kind: 'crdt_update',
        operation: { engine: 'yjs', updateBase64: Buffer.from([1, 2, 3, 4]).toString('base64') },
      }));
      await expectErrorResponse(res, 400, 'CRDT update payload could not be merged.');
    });

    it('creates the operation and checkpoints a page-scoped document', async () => {
      const database = db();
      const res = (await callFunction(POST, database, OWNER, createBody({
        kind: 'crdt_update',
        operation: { engine: 'yjs', updateBase64: yTextUpdateBase64('alpha') },
      }))) as { operation: Row; document: Row };
      expect(res.document.documentId).toBe('page:p1');
      expect(res.document.engine).toBe('yjs');
      expect(res.document.updateCount).toBe(1);
      expect(res.document.lastOperationId).toBe(res.operation.id);
      expect(decodedText(res.document.stateBase64 as string)).toBe('alpha');
      expect(database.tables.collaboration_documents).toHaveLength(1);
    });

    it('merges a second update into the same document row', async () => {
      const database = db();
      await callFunction(POST, database, OWNER, createBody({
        kind: 'crdt_update',
        operation: { engine: 'yjs', updateBase64: yTextUpdateBase64('alpha') },
      }));
      const res = (await callFunction(POST, database, MEMBER, createBody({
        clientId: 'client-2',
        kind: 'crdt_update',
        operation: { engine: 'yjs', updateBase64: yTextUpdateBase64('beta') },
      }))) as { document: Row };
      expect(database.tables.collaboration_documents).toHaveLength(1);
      expect(res.document.updateCount).toBe(2);
      const merged = decodedText(res.document.stateBase64 as string);
      expect(merged).toContain('alpha');
      expect(merged).toContain('beta');
    });

    it('keeps a single row and monotonic updateCount across repeated checkpoints', async () => {
      // Exercises the atomic read-merge-write guard: every checkpoint expects
      // the row still at the version it merged against, so no update is lost and
      // no duplicate document row is created.
      const database = db();
      for (let i = 0; i < 5; i += 1) {
        await callFunction(POST, database, OWNER, createBody({
          clientId: `client-${i}`,
          kind: 'crdt_update',
          operation: { engine: 'yjs', updateBase64: yTextUpdateBase64(`edit${i}`) },
        }));
      }
      expect(database.tables.collaboration_documents).toHaveLength(1);
      expect(database.tables.collaboration_documents[0].updateCount).toBe(5);
    });

    it('merges into a document row that already exists (concurrent first-insert guard)', async () => {
      const database = db();
      // Simulate a concurrent creator having already inserted the row.
      database.tables.collaboration_documents = [{
        id: 'doc-existing',
        workspaceId: 'ws1',
        pageId: 'p1',
        documentId: 'page:p1',
        engine: 'yjs',
        updateCount: 3,
        stateBase64: yTextUpdateBase64('preexisting'),
      } as Row];
      const res = (await callFunction(POST, database, OWNER, createBody({
        kind: 'crdt_update',
        operation: { engine: 'yjs', updateBase64: yTextUpdateBase64('added') },
      }))) as { document: Row };
      expect(database.tables.collaboration_documents).toHaveLength(1);
      expect(res.document.updateCount).toBe(4);
    });

    it('prunes superseded crdt ops beyond the retention tail after a checkpoint', async () => {
      // 520 already-superseded crdt ops + the new one land at-or-before the
      // fresh checkpoint cursor (521 total); retention keeps the newest 500
      // and deletes the oldest overflow so the table stays bounded.
      const seeded = Array.from({ length: 520 }, (_, index) =>
        operationRow(`op${String(index).padStart(4, '0')}`, {
          blockId: null,
          kind: 'crdt_update',
          revision: index + 1,
          occurredAt: T0,
        }),
      );
      const database = db({ collaboration_operations: seeded });
      await callFunction(POST, database, OWNER, createBody({
        kind: 'crdt_update',
        operation: { engine: 'yjs', updateBase64: yTextUpdateBase64('alpha') },
      }));
      const remaining = database.tables.collaboration_operations;
      expect(remaining).toHaveLength(500);
      const ids = new Set(remaining.map((operation) => operation.id));
      // The oldest superseded ops were the victims; the fresh op survives.
      for (let index = 0; index < 21; index += 1) {
        expect(ids.has(`op${String(index).padStart(4, '0')}`)).toBe(false);
      }
    });

    it('leaves non-crdt operations alone when pruning', async () => {
      const seeded = Array.from({ length: 520 }, (_, index) =>
        operationRow(`text${index}`, { blockId: null, kind: 'text', revision: index + 1, occurredAt: T0 }),
      );
      const database = db({ collaboration_operations: seeded });
      await callFunction(POST, database, OWNER, createBody({
        kind: 'crdt_update',
        operation: { engine: 'yjs', updateBase64: yTextUpdateBase64('alpha') },
      }));
      expect(database.tables.collaboration_operations).toHaveLength(521);
    });

    it('derives a block-scoped documentId from the blockId', async () => {
      const res = (await callFunction(POST, db(), OWNER, createBody({
        blockId: 'b1',
        kind: 'crdt_update',
        operation: { engine: 'yjs', updateBase64: yTextUpdateBase64('alpha') },
      }))) as { document: Row };
      expect(res.document.documentId).toBe('block:b1');
      expect(res.document.blockId).toBe('b1');
    });
  });

  describe('block_structure operations', () => {
    it('rejects an unknown structure action', async () => {
      const res = await callFunction(POST, db(), OWNER, createBody({
        kind: 'block_structure',
        operation: { action: 'transmogrify', blockIds: ['b1'] },
      }));
      await expectErrorResponse(res, 400, 'Block structure operation action is invalid.');
    });

    it('rejects structure blocks that cross pages', async () => {
      const res = await callFunction(POST, db(), OWNER, createBody({
        kind: 'block_structure',
        operation: {
          action: 'create',
          after: [{ id: 'b9', pageId: 'p2', parentId: null, position: 1 }],
        },
      }));
      await expectErrorResponse(res, 400, 'Block structure operation cannot cross pages.');
    });

    it('requires before or after block snapshots', async () => {
      const res = await callFunction(POST, db(), OWNER, createBody({
        blockId: 'b1',
        kind: 'block_structure',
        operation: { action: 'move' },
      }));
      await expectErrorResponse(res, 400, 'Block structure operation must include before or after blocks.');
    });

    it('stores a cleaned structure payload with collected block ids', async () => {
      const res = (await callFunction(POST, db(), OWNER, createBody({
        kind: 'block_structure',
        operation: {
          action: 'create',
          after: [{ id: 'b9', parentId: null, position: 2, type: 'paragraph', plainText: 'hi' }],
        },
      }))) as { operation: Row };
      const payload = res.operation.operation as Record<string, unknown>;
      expect(payload.engine).toBe('block_structure');
      expect(payload.action).toBe('create');
      expect(payload.blockIds).toEqual(['b9']);
      expect(Array.isArray(payload.after)).toBe(true);
    });
  });

  describe('list', () => {
    it('returns operations after the revision watermark in ascending order', async () => {
      const database = db({
        collaboration_operations: [
          operationRow('op1', { revision: 1 }),
          operationRow('op3', { revision: 3 }),
          operationRow('op2', { revision: 2 }),
        ],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'list',
        pageId: 'p1',
        afterRevision: 1,
      })) as { operations: Row[] };
      expect(res.operations.map((operation) => operation.id)).toEqual(['op2', 'op3']);
    });

    it('breaks revision ties with the occurredAt/id cursor and honors the limit', async () => {
      const database = db({
        collaboration_operations: [
          operationRow('op-a', { revision: 5, occurredAt: T0 }),
          operationRow('op-b', { revision: 5, occurredAt: T0 }),
          operationRow('op-c', { revision: 5, occurredAt: '2026-01-02T00:00:00.000Z' }),
        ],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'list',
        pageId: 'p1',
        afterRevision: 5,
        afterOccurredAt: T0,
        afterId: 'op-a',
        limit: 1,
      })) as { operations: Row[] };
      expect(res.operations.map((operation) => operation.id)).toEqual(['op-b']);
    });
  });

  describe('document / documents', () => {
    it('returns null when no checkpoint exists', async () => {
      const res = (await callFunction(POST, db(), OWNER, {
        action: 'document',
        pageId: 'p1',
      })) as { document: Row | null };
      expect(res.document).toBeNull();
    });

    it('rebuilds a missing document from the operation log with repair: true', async () => {
      const database = db();
      const created = (await callFunction(POST, database, OWNER, createBody({
        kind: 'crdt_update',
        operation: { engine: 'yjs', updateBase64: yTextUpdateBase64('alpha') },
      }))) as { operation: Row };
      // Simulate a lost checkpoint: the operation log survives, the document row does not.
      database.tables.collaboration_documents.splice(0);

      const res = (await callFunction(POST, database, OWNER, {
        action: 'document',
        pageId: 'p1',
        repair: true,
      })) as { document: Row };
      expect(res.document.documentId).toBe('page:p1');
      expect(res.document.updateCount).toBe(1);
      expect(res.document.lastOperationId).toBe(created.operation.id);
      expect(decodedText(res.document.stateBase64 as string)).toBe('alpha');
      // The rebuilt state is persisted, not just returned.
      expect(database.tables.collaboration_documents).toHaveLength(1);
    });

    it('lists documents filtered by blockIds', async () => {
      const database = db({ blocks: [blockRow('b1'), blockRow('b2')] });
      for (const blockId of ['b1', 'b2']) {
        await callFunction(POST, database, OWNER, createBody({
          blockId,
          kind: 'crdt_update',
          operation: { engine: 'yjs', updateBase64: yTextUpdateBase64(`text-${blockId}`) },
        }));
      }
      const res = (await callFunction(POST, database, OWNER, {
        action: 'documents',
        pageId: 'p1',
        blockIds: ['b2'],
      })) as { documents: Row[] };
      expect(res.documents.map((document) => document.documentId)).toEqual(['block:b2']);
    });
  });
});
