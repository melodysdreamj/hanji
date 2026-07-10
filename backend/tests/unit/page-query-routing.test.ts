import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/page-query';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';
const STRANGER = 'stranger-1';

function db() {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    workspace_members: [],
    pages: [
      {
        id: 'p1',
        workspaceId: 'ws1',
        parentId: null,
        parentType: 'workspace',
        kind: 'page',
        title: 'Private page',
        position: 0,
        inTrash: false,
        createdBy: OWNER,
      } satisfies Row,
    ],
    blocks: [
      {
        id: 'b1',
        pageId: 'p1',
        parentId: null,
        type: 'paragraph',
        content: { rich: [{ text: 'private body' }] },
        plainText: 'private body',
        position: 1,
      } satisfies Row,
    ],
  });
}

describe('page-query routing and access statuses', () => {
  it('maps an unknown pageId routing hint to 404, not an unhandled 500', async () => {
    // The boundedDbFromPageHint call must run inside the try/catch (same
    // class as the comment-mutation routing fix): an unknown page id throws
    // "Page was not found." and has to surface as a mapped 404.
    const res = await callFunction(POST, db(), STRANGER, {
      action: 'blocks',
      pageId: 'missing-page',
    });
    await expectErrorResponse(res, 404, 'Page was not found.');
  });

  it('denies a stranger reading blocks of a private page with 403', async () => {
    const res = await callFunction(POST, db(), STRANGER, { action: 'blocks', pageId: 'p1' });
    await expectErrorResponse(res, 403, 'Page access required.');
  });

  it('returns blocks for the workspace owner', async () => {
    const result = (await callFunction(POST, db(), OWNER, {
      action: 'blocks',
      pageId: 'p1',
    })) as { blocks?: Array<{ id: string }> };
    expect(result.blocks?.map((block) => block.id)).toEqual(['b1']);
  });

  it('degrades workspace block search to a flagged partial result over the materialization cap', async () => {
    // >20k blocks used to 413 the whole search/backlinks feature; it now
    // truncates and reports the partial window.
    const database = db();
    database.tables.blocks = Array.from({ length: 20_001 }, (_, index) => ({
      id: `b${index}`,
      pageId: 'p1',
      parentId: null,
      type: 'paragraph',
      plainText: index === 0 ? 'needle text' : `filler ${index}`,
      position: index,
    }));
    const result = (await callFunction(POST, database, OWNER, {
      action: 'searchBlocks',
      workspaceId: 'ws1',
      query: 'needle',
    })) as { blocks: Array<{ id: string }>; truncated?: boolean };
    expect(result.blocks.map((block) => block.id)).toEqual(['b0']);
    expect(result.truncated).toBe(true);
  });

  it('reads a linked database whose imported parent row was deleted', async () => {
    // The linked-database context filter walks parentId with raw getOne; a
    // deleted parent row used to 404 the whole database read instead of
    // falling back to "no context filter".
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
      workspace_members: [],
      pages: [
        {
          id: 'req-db',
          workspaceId: 'ws1',
          parentId: 'deleted-row',
          parentType: 'page',
          kind: 'database',
          title: 'Linked view',
          position: 0,
          inTrash: false,
          createdBy: OWNER,
          properties: {
            notionLinkedDatabaseSourceUnavailable: true,
            notionDatabaseId: 'abc123',
          },
        } satisfies Row,
        {
          id: 'source-db',
          workspaceId: 'ws1',
          parentId: null,
          parentType: 'workspace',
          kind: 'database',
          title: 'Source database',
          position: 1,
          inTrash: false,
          createdBy: OWNER,
        } satisfies Row,
      ],
      db_views: [
        {
          id: 'v1',
          databaseId: 'source-db',
          name: 'Table',
          type: 'table',
          position: 0,
          config: { notion: { parent: { database_id: 'abc123' } } },
        } satisfies Row,
      ],
    });
    const result = (await callFunction(POST, database, OWNER, {
      action: 'database',
      databaseId: 'req-db',
    })) as { resolvedDatabaseId?: string; views?: Array<{ id: string }> };
    expect(result.resolvedDatabaseId).toBe('source-db');
    expect(result.views?.map((view) => view.id)).toEqual(['v1']);
  });
});
