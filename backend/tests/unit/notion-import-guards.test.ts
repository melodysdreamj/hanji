import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_UNKNOWN_LENGTH_IMPORTED_FILE_SIZE,
  POST,
  readResponseBodyWithByteCap,
  responseBodyWithExactByteCount,
  assertSafeNotionImportSourceReferences,
  listActiveNotionImportItems,
  notionOAuthEnabled,
  notionOAuthRedirectUri,
  replaceDiscoveredItems,
  sanitizeNotionCredentialMetadata,
  type NotionImportJob,
} from '../../functions/notion-import';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse, handlerOf } from './helpers/function-context';

const notionImportSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../functions/notion-import.ts'),
  'utf8',
);

describe('Notion incremental discovery live progress', () => {
  it('persists the current pending-enrichment count during a chunk', () => {
    expect(notionImportSource).toContain('pendingEnrichment: snapshot.pendingEnrichment');
    expect(notionImportSource).toContain('notionDiscoveryItemNeedsEnrichment');
  });

  it('bounds linked-database reads and persists terminal versus retryable attempts', () => {
    expect(notionImportSource).toContain('const waveSize = notionEnrichmentWaveSize({');
    expect(notionImportSource).toContain('databaseFetchStatus: result.fetchStatus');
    expect(notionImportSource).toContain("fetchStatus: response.retryable ? 'retryable_error' as const : 'unavailable' as const");
    expect(notionImportSource).toContain('const enrichable = notionDiscoveryEnrichmentCandidates(');
  });

  it('does not mark an incremental chunk complete while enrichment remains', () => {
    expect(notionImportSource).toContain(
      "status: discoveryWorkRemaining ? 'running' : 'completed'",
    );
    expect(notionImportSource).toContain(
      "phase: discoveryWorkRemaining ? 'discovery_enrichment' : 'discovery_complete'",
    );
    expect(notionImportSource).toContain(
      'finishedAt: discoveryWorkRemaining ? null : finishedAt',
    );
    expect(notionImportSource).toMatch(
      /if \(!hasMore && pendingEnrichment === 0\) \{\s*pushImportActivity\(recentActivity, \{\s*kind: 'discovery_complete'/,
    );
  });
});

describe('Notion import completion markers', () => {
  it('hands relation remapping the page only after block-completion markers are durable', () => {
    const pageCreation = notionImportSource.indexOf('const insertedBlocks = await insertPageBlocksFromSnapshot(');
    const completion = notionImportSource.indexOf('page = await markImportedBlocksComplete(db, page);', pageCreation);
    const pageContext = notionImportSource.indexOf('importedPageBlockContexts.push({ page, notionId: item.notionId });', completion);
    const rowContext = notionImportSource.indexOf('importedRowContexts.push({ page, dataSourceId: sourceId, notionId: item.notionId });', completion);

    expect(pageCreation).toBeGreaterThanOrEqual(0);
    expect(completion).toBeGreaterThan(pageCreation);
    expect(pageContext).toBeGreaterThan(completion);
    expect(rowContext).toBeGreaterThan(completion);
  });
});

describe('Notion import staging-root recovery', () => {
  it('unwraps a completed localized staging root into ordinary Pages', async () => {
    const completedJob = job('job-completed', {
      status: 'completed',
      phase: 'applied',
      rootNotionPageIds: ['notion-selected-root'],
    });
    const db = workspaceDb({
      notion_import_jobs: [completedJob],
      notion_import_mappings: [
        {
          id: 'mapping-root',
          workspaceId: 'ws-1',
          jobId: 'job-completed',
          notionId: 'notion-import-root:job-completed',
          notionType: 'import_root',
          localId: 'staging-root',
          localType: 'page',
          relationKind: 'import_root',
        },
        {
          id: 'mapping-selected',
          workspaceId: 'ws-1',
          jobId: 'job-completed',
          notionId: 'notion-selected-root',
          notionType: 'page',
          localId: 'selected-page',
          localType: 'page',
          relationKind: 'page',
        },
        {
          id: 'mapping-supporting-db',
          workspaceId: 'ws-1',
          jobId: 'job-completed',
          notionId: 'notion-supporting-db',
          notionType: 'data_source',
          localId: 'supporting-db',
          localType: 'database',
          relationKind: 'canonical_data_source',
        },
      ],
      pages: [
        {
          id: 'staging-root', workspaceId: 'ws-1', parentType: 'workspace', kind: 'page',
          title: 'Localized staging title', properties: { notionImportJobId: 'job-completed' },
        },
        {
          id: 'selected-page', workspaceId: 'ws-1', parentId: 'staging-root', parentType: 'page',
          kind: 'page', title: 'Selected page', isFavorite: true, inTrash: true,
          trashedAt: '2026-07-13T00:00:00.000Z',
        },
        {
          id: 'supporting-db', workspaceId: 'ws-1', parentId: 'staging-root', parentType: 'page',
          kind: 'database', title: 'Supporting database',
        },
      ],
    });

    const result = await callFunction(POST, db, 'owner-1', {
      action: 'repairPageIndexes',
      workspaceId: 'ws-1',
    }) as { unwrapped?: number; moved?: number };

    expect(result).toEqual(expect.objectContaining({ unwrapped: 1, moved: 2 }));
    expect(db.tables.pages.some((page) => page.id === 'staging-root')).toBe(false);
    expect(db.tables.notion_import_mappings.some((mapping) => mapping.id === 'mapping-root')).toBe(false);
    expect(db.tables.page_workspace_index.some((row) => row.id === 'staging-root')).toBe(false);
    expect(db.tables.pages.find((page) => page.id === 'selected-page')).toEqual(
      expect.objectContaining({
        parentId: null,
        parentType: 'workspace',
        isFavorite: false,
        inTrash: false,
        trashedAt: null,
      }),
    );
    expect(db.tables.pages.find((page) => page.id === 'supporting-db')).toEqual(
      expect.objectContaining({ parentId: 'selected-page', parentType: 'page' }),
    );
  });

  it('moves failed partial-import pages to Trash instead of exposing them', async () => {
    const db = workspaceDb({
      notion_import_jobs: [job('job-failed', { status: 'failed', phase: 'apply_failed' })],
      notion_import_mappings: [
        {
          id: 'failed-root-mapping', workspaceId: 'ws-1', jobId: 'job-failed',
          notionId: 'notion-import-root:job-failed', notionType: 'import_root',
          localId: 'failed-root', localType: 'page', relationKind: 'import_root',
        },
        {
          id: 'failed-child-mapping', workspaceId: 'ws-1', jobId: 'job-failed',
          notionId: 'failed-child-notion', notionType: 'page',
          localId: 'failed-child', localType: 'page', relationKind: 'page',
        },
      ],
      pages: [
        {
          id: 'failed-root', workspaceId: 'ws-1', parentType: 'workspace', kind: 'page',
          title: 'Failed staging root', isFavorite: false,
        },
        {
          id: 'failed-child', workspaceId: 'ws-1', parentId: 'failed-root', parentType: 'page',
          kind: 'page', title: 'Partial child', isFavorite: true,
        },
      ],
    });

    const result = await callFunction(POST, db, 'owner-1', {
      action: 'repairPageIndexes',
      workspaceId: 'ws-1',
    }) as { trashed?: number };

    expect(result.trashed).toBe(2);
    expect(db.tables.pages).toEqual([
      expect.objectContaining({ id: 'failed-root', inTrash: true, isFavorite: false }),
      expect.objectContaining({ id: 'failed-child', inTrash: true, isFavorite: false }),
    ]);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('Notion OAuth configured redirect boundary', () => {
  const configured = 'https://app.example.com/?notion_import_oauth=1';

  it('pins the callback to the configured URI and allows only an exact request match', () => {
    const env = {
      HANJI_NOTION_OAUTH_ENABLED: 'true',
      HANJI_NOTION_OAUTH_REDIRECT_URI: configured,
    };
    expect(notionOAuthRedirectUri(env, {})).toBe(configured);
    expect(notionOAuthRedirectUri(env, { redirectUri: configured })).toBe(configured);
    expect(() => notionOAuthRedirectUri(env, {
      redirectUri: 'https://attacker.example/callback',
    })).toThrow('redirectUri must exactly match HANJI_NOTION_OAUTH_REDIRECT_URI.');
    expect(() => notionOAuthRedirectUri(env, {
      redirectUri: `${configured}/`,
    })).toThrow('redirectUri must exactly match HANJI_NOTION_OAUTH_REDIRECT_URI.');
  });

  it('accepts a request callback only when no callback is configured', () => {
    const env = { HANJI_NOTION_OAUTH_ENABLED: 'true' };
    expect(notionOAuthRedirectUri(env, { redirectUri: configured })).toBe(configured);
    expect(() => notionOAuthRedirectUri(env, {})).toThrow(
      'redirectUri is required for Notion OAuth.',
    );
  });

  it('requires exact true before reading a stale configured callback', () => {
    for (const enabled of [undefined, 'false', 'TRUE', '1']) {
      const env = {
        HANJI_NOTION_OAUTH_ENABLED: enabled,
        HANJI_NOTION_OAUTH_REDIRECT_URI: configured,
        HANJI_NOTION_OAUTH_CLIENT_ID: 'stale-client',
        HANJI_NOTION_OAUTH_CLIENT_SECRET: 'stale-secret',
        HANJI_NOTION_OAUTH_STATE_SECRET: 'stale-state',
      };
      expect(notionOAuthEnabled(env)).toBe(false);
      expect(() => notionOAuthRedirectUri(env, {})).toThrow(
        'HANJI_NOTION_OAUTH_ENABLED=true is required for Notion OAuth.',
      );
    }
  });

  it('rejects the begin action before stale OAuth configuration can be used', async () => {
    const db = workspaceDb();
    const result = await handlerOf(POST)({
      auth: { id: 'owner-1' },
      admin: { db: () => db },
      env: {
        HANJI_NOTION_OAUTH_ENABLED: 'false',
        HANJI_NOTION_OAUTH_REDIRECT_URI: configured,
        HANJI_NOTION_OAUTH_CLIENT_ID: 'stale-client',
        HANJI_NOTION_OAUTH_CLIENT_SECRET: 'stale-secret',
        HANJI_NOTION_OAUTH_STATE_SECRET: 'stale-state',
      },
      request: new Request('https://app.example.com/functions/notion-import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'beginOAuthConnection', workspaceId: 'ws-1' }),
      }),
    });

    await expectErrorResponse(
      result,
      400,
      'HANJI_NOTION_OAUTH_ENABLED=true is required for Notion OAuth.',
    );
  });

  it('rejects an existing OAuth connection before decrypting or using it while disabled', async () => {
    const db = workspaceDb({
      notion_import_connections: [{
        id: 'oauth-connection',
        workspaceId: 'ws-1',
        actorId: 'owner-1',
        connectionKind: 'oauth',
        status: 'active',
        credentialCiphertext: 'stale-ciphertext',
      }],
    });
    const result = await handlerOf(POST)({
      auth: { id: 'owner-1' },
      admin: { db: () => db },
      env: {
        HANJI_NOTION_OAUTH_ENABLED: 'false',
        HANJI_NOTION_IMPORT_SECRET: 'stale-storage-secret',
        HANJI_NOTION_OAUTH_CLIENT_ID: 'stale-client',
        HANJI_NOTION_OAUTH_CLIENT_SECRET: 'stale-secret',
        HANJI_NOTION_OAUTH_STATE_SECRET: 'stale-state',
      },
      request: new Request('https://app.example.com/functions/notion-import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'listAccessibleRoots',
          workspaceId: 'ws-1',
          connectionId: 'oauth-connection',
        }),
      }),
    });

    await expectErrorResponse(
      result,
      400,
      'HANJI_NOTION_OAUTH_ENABLED=true is required for Notion OAuth.',
    );
  });
});

describe('Notion import stored-file source boundary', () => {
  it('rejects absolute and protocol-relative storage routes even through host aliases', async () => {
    const db = workspaceDb({ file_uploads: [] });
    await expect(assertSafeNotionImportSourceReferences(db, {
      file: { url: 'https://alias.example/api/storage/files/workspaces/ws-1/orphan.png' },
    })).rejects.toMatchObject({ code: 409 });
    await expect(assertSafeNotionImportSourceReferences(db, {
      file: { sourceUrl: '//alias.example/api/storage/files/workspaces/ws-1/orphan.png' },
    })).rejects.toMatchObject({ code: 409 });
  });

  it('rejects legacy key-shaped attachment ids and sourceUrl fields', async () => {
    const db = workspaceDb({ file_uploads: [] });
    await expect(assertSafeNotionImportSourceReferences(db, {
      files: [{
        id: 'workspaces/ws-1/uploads/foreign.png',
        sourceUrl: '/api/storage/files/workspaces/ws-1/uploads/foreign.png',
      }],
    })).rejects.toMatchObject({ code: 409 });
  });

  it('allows ordinary external Notion and public file URLs', async () => {
    const db = workspaceDb({ file_uploads: [] });
    await expect(assertSafeNotionImportSourceReferences(db, {
      icon: 'https://www.notion.so/image/example.png',
      file: { sourceUrl: 'https://cdn.example.com/public/document.pdf' },
    })).resolves.toBeUndefined();
  });
});

describe('Notion import Azure SAS credential scrubbing', () => {
  it('scrubs a nested URL carrying an exact standalone sig parameter', () => {
    const sanitized = sanitizeNotionCredentialMetadata({
      attachment: {
        name: 'private.pdf',
        download: {
          url: 'https://cdn.example/private.pdf?sig=standalone-bearer-secret',
        },
      },
    });

    expect(sanitized).toEqual({
      attachment: {
        name: 'private.pdf',
        download: {},
      },
    });
    expect(JSON.stringify(sanitized)).not.toContain('standalone-bearer-secret');
  });

  it('scrubs canonical mixed-case Azure SAS keys including percent-encoded parameter names', () => {
    const azureSas =
      'https://account.blob.core.windows.net/container/private.pdf' +
      '?%53%69%47=azure-secret&%53%56=2025-05-05&Se=2026-07-12T00%3A00%3A00Z' +
      '&sP=r&Sr=b&St=2026-07-11T00%3A00%3A00Z&sPr=https&SkOiD=oid&SkTiD=tid';

    const sanitized = sanitizeNotionCredentialMetadata({
      nested: [{ file: { url: azureSas } }],
    });

    expect(sanitized).toEqual({ nested: [{ file: {} }] });
    expect(JSON.stringify(sanitized)).not.toContain('azure-secret');
  });

  it('preserves ordinary query names that merely contain the letters sig', () => {
    const ordinary = 'https://product.example/report?signal=green&designature=visible';
    expect(sanitizeNotionCredentialMetadata({ url: ordinary })).toEqual({ url: ordinary });
  });
});

function job(id: string, extra: Partial<NotionImportJob> = {}): Row {
  return {
    id,
    workspaceId: 'ws-1',
    source: 'notion_api',
    connectionKind: 'manual_token',
    status: 'ready',
    phase: 'review',
    apiVersion: '2022-06-28',
    createdAt: isoAgo(DAY_MS),
    updatedAt: isoAgo(DAY_MS),
    ...extra,
  } as unknown as Row;
}

function workspaceDb(extra: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws-1', name: 'Workspace', ownerId: 'owner-1' }],
    workspace_members: [
      { id: 'm-owner', workspaceId: 'ws-1', userId: 'owner-1', role: 'owner' },
      { id: 'm-guest', workspaceId: 'ws-1', userId: 'guest-1', role: 'guest' },
      { id: 'm-member', workspaceId: 'ws-1', userId: 'member-1', role: 'member' },
    ],
    notion_import_items: [],
    ...extra,
  });
}

function enforceFileUploadForeignKeys(db: ReturnType<typeof workspaceDb>) {
  const originalTable = db.table.bind(db);
  db.table = ((name: string) => {
    const table = originalTable(name);
    if (name !== 'file_uploads') return table;
    return {
      ...table,
      async insert(data: Partial<Row>) {
        const blockId = typeof data.blockId === 'string' ? data.blockId : '';
        if (blockId && !db.tables.blocks.some((block) => block.id === blockId)) {
          throw new Error('Referenced record does not exist (column: SQLITE_CONSTRAINT)');
        }
        return table.insert(data);
      },
    };
  }) as typeof db.table;

  let transactionalBlockAssociations = 0;
  const originalTransact = db.transact.bind(db);
  db.transact = async (operations) => {
    const visibleBlockIds = new Set(db.tables.blocks.map((block) => block.id));
    for (const operation of operations) {
      if (operation.table === 'blocks' && operation.op === 'insert') {
        const id = typeof operation.data.id === 'string' ? operation.data.id : '';
        if (id) visibleBlockIds.add(id);
      }
      if (
        operation.table === 'file_uploads'
        && (operation.op === 'insert' || operation.op === 'update')
      ) {
        const blockId = typeof operation.data.blockId === 'string' ? operation.data.blockId : '';
        if (blockId) {
          transactionalBlockAssociations += 1;
          if (!visibleBlockIds.has(blockId)) {
            throw new Error('Referenced record does not exist (column: SQLITE_CONSTRAINT)');
          }
        }
      }
    }
    return originalTransact(operations);
  };
  return { get transactionalBlockAssociations() { return transactionalBlockAssociations; } };
}

function verifiedStorage() {
  const objects = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
  const storage = {
    bucket() {
      return storage;
    },
    async put(
      key: string,
      value: ReadableStream<Uint8Array> | ArrayBuffer | string,
      options?: { contentType?: string },
    ) {
      const bytes = await new Response(value as BodyInit).arrayBuffer();
      objects.set(key, { bytes, contentType: options?.contentType ?? 'application/octet-stream' });
    },
    async head(key: string) {
      const stored = objects.get(key);
      return stored
        ? {
            key,
            size: stored.bytes.byteLength,
            etag: `etag-${stored.bytes.byteLength}`,
            contentType: stored.contentType,
          }
        : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return { storage, objects };
}

async function applyWithStorage(
  db: ReturnType<typeof workspaceDb>,
  storage: ReturnType<typeof verifiedStorage>['storage'],
  extraBody: Record<string, unknown> = {},
) {
  return handlerOf(POST)({
    auth: { id: 'owner-1' },
    admin: { db: () => db },
    storage,
    request: new Request('http://localhost:8787/functions/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'apply',
        jobId: 'job-1',
        workspaceId: 'ws-1',
        ...extraBody,
      }),
    }),
  });
}

const SAFE_TEMPLATE_IMAGE = 'data:image/png;base64,AQIDBA==';

function resumableTemplateDataSource(fullFileGraph = true): Row {
  return {
    id: 'item-ds-resume',
    workspaceId: 'ws-1',
    jobId: 'job-1',
    notionId: 'ds-resume',
    notionObject: 'data_source',
    title: 'Resumable database',
    status: 'discovered',
    phase: 'data_source_snapshot',
    metadata: {
      dataSourceSnapshot: {
        dataSource: {
          id: 'ds-resume',
          properties: {
            Name: { id: 'title-prop', name: 'Name', type: 'title', title: {} },
            ...(fullFileGraph
              ? { Files: { id: 'files-prop', name: 'Files', type: 'files', files: {} } }
              : {}),
          },
        },
        templates: [{
          id: 'template-resume',
          name: 'Resumable template',
          icon: { type: 'external', external: { url: SAFE_TEMPLATE_IMAGE } },
          properties: fullFileGraph
            ? {
                Files: {
                  id: 'files-prop',
                  type: 'files',
                  files: [{
                    name: 'property.png',
                    type: 'external',
                    external: { url: SAFE_TEMPLATE_IMAGE },
                  }],
                },
              }
            : {},
          blocks: fullFileGraph
            ? [
                {
                  id: 'template-file-block',
                  type: 'image',
                  image: { type: 'external', name: 'block.png', external: { url: SAFE_TEMPLATE_IMAGE } },
                  children: [{
                    id: 'template-child-file-block',
                    type: 'file',
                    file: { type: 'external', name: 'child.png', external: { url: SAFE_TEMPLATE_IMAGE } },
                  }],
                },
                {
                  id: 'template-button-block',
                  type: 'template',
                  template: { rich_text: [{ plain_text: 'Insert' }] },
                  children: [{
                    id: 'template-button-file',
                    type: 'image',
                    image: { type: 'external', name: 'button.png', external: { url: SAFE_TEMPLATE_IMAGE } },
                  }],
                },
              ]
            : [],
        }],
      },
    },
  };
}

function resumableDatabaseContainer(index: number): Row {
  return {
    id: `item-database-${index}`,
    workspaceId: 'ws-1',
    jobId: 'job-1',
    notionId: `database-${index}`,
    notionObject: 'database',
    title: `Database container ${index}`,
    status: 'discovered',
    phase: 'database_snapshot',
    metadata: {
      database: { id: `database-${index}` },
      dataSources: [{ id: 'ds-resume' }],
    },
  };
}

function resumableTemplateDb(fullFileGraph = true) {
  return workspaceDb({
    notion_import_jobs: [job('job-1')],
    notion_import_items: [
      resumableTemplateDataSource(fullFileGraph),
      resumableDatabaseContainer(1),
      resumableDatabaseContainer(2),
    ],
    notion_import_mappings: [],
    notion_import_apply_locks: [],
    pages: [],
    blocks: [],
    db_properties: [],
    db_views: [],
    db_templates: [],
    file_uploads: [],
  });
}

describe('applyJob authorizes before arming the failure marker (#6)', () => {
  it("an unauthorized stranger's 403 leaves the ready job untouched", async () => {
    const db = workspaceDb({ notion_import_jobs: [job('job-1')] });
    const res = await callFunction(POST, db, 'intruder-1', {
      action: 'apply',
      jobId: 'job-1',
      workspaceId: 'ws-1',
    });
    await expectErrorResponse(res, 403, 'Workspace access required.');
    const row = db.tables.notion_import_jobs.find((candidate) => candidate.id === 'job-1');
    expect(row?.status).toBe('ready');
    expect(row?.error ?? null).toBeNull();
    expect(row?.finishedAt ?? null).toBeNull();
  });

  it('still marks the job failed when an authorized apply fails after the guard', async () => {
    // No discovered items → applyJobCore throws after assertWritableJob passed,
    // so the failure marker must record it (progress must not stay stuck).
    const db = workspaceDb({ notion_import_jobs: [job('job-1')] });
    const res = await callFunction(POST, db, 'owner-1', {
      action: 'apply',
      jobId: 'job-1',
      workspaceId: 'ws-1',
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBeGreaterThanOrEqual(400);
    const row = db.tables.notion_import_jobs.find((candidate) => candidate.id === 'job-1');
    expect(row?.status).toBe('failed');
    expect(row?.phase).toBe('apply_failed');
  });
});

describe('apply lease and mapping idempotency', () => {
  function discoveredPage(id = 'notion-page-1'): Row {
    return {
      id: `item-${id}`,
      workspaceId: 'ws-1',
      jobId: 'job-1',
      notionId: id,
      notionObject: 'page',
      title: 'Imported page',
      status: 'discovered',
      phase: 'page_snapshot',
      metadata: { pageSnapshot: { childBlocks: [] } },
    };
  }

  it('reads first-generation import rows without issuing a nullable generation filter', async () => {
    const legacyItem = discoveredPage();
    const getList = vi.fn(async () => ({ items: [legacyItem], hasMore: false }));
    const query = {
      where: vi.fn(() => {
        throw new Error('nullable generation filter must not be issued');
      }),
      page: vi.fn(() => query),
      limit: vi.fn(() => query),
      getList,
    };
    const table = {
      where: vi.fn((field: string) => {
        expect(field).toBe('jobId');
        return query;
      }),
    };

    const items = await listActiveNotionImportItems(
      { table: vi.fn(() => table) } as never,
      job('job-1') as unknown as NotionImportJob,
    );

    expect(items).toEqual([legacyItem]);
    expect(query.where).not.toHaveBeenCalled();
    expect(getList).toHaveBeenCalledTimes(1);
  });

  it('allows only one concurrent apply and creates one native graph', async () => {
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [discoveredPage()],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
    });
    const body = { action: 'apply', jobId: 'job-1', workspaceId: 'ws-1' };
    const results = await Promise.all([
      callFunction(POST, db, 'owner-1', body),
      callFunction(POST, db, 'owner-1', body),
    ]);
    const failures = results.filter((result): result is Response => result instanceof Response);
    expect(failures).toHaveLength(1);
    await expectErrorResponse(failures[0], 409, 'already being applied');
    expect(results.filter((result) => !(result instanceof Response))).toHaveLength(1);
    expect(db.tables.pages).toHaveLength(1); // imported page; staging root is removed
    expect(db.tables.pages[0]).toEqual(expect.objectContaining({ parentType: 'workspace', isFavorite: false }));
    expect(db.tables.notion_import_mappings).toHaveLength(1);
    expect(new Set(db.tables.notion_import_mappings.map((mapping) => mapping.mappingKey)).size).toBe(1);
    expect(db.tables.notion_import_apply_locks).toHaveLength(0);
    expect(db.tables.notion_import_jobs[0].status).toBe('completed');
  });

  it('reclaims a stranded same-actor apply lease after its heartbeat is stale', async () => {
    const staleAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [discoveredPage()],
      notion_import_mappings: [],
      notion_import_apply_locks: [{
        id: 'job-1',
        workspaceId: 'ws-1',
        jobId: 'job-1',
        leaseId: 'stranded-apply-lease',
        actorId: 'owner-1',
        purpose: 'apply',
        expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
        createdAt: staleAt,
        updatedAt: staleAt,
      }],
      pages: [],
      blocks: [],
    });

    const result = await callFunction(POST, db, 'owner-1', {
      action: 'apply',
      jobId: 'job-1',
      workspaceId: 'ws-1',
    });

    expect(result).not.toBeInstanceOf(Response);
    expect(db.tables.notion_import_jobs[0].status).toBe('completed');
    expect(db.tables.notion_import_apply_locks).toHaveLength(0);
  });

  it('cancels a stranded discovery and removes its job-scoped lease immediately', async () => {
    const discoveringJob = job('job-1', {
      status: 'discovering',
      phase: 'api_search',
      progress: { currentStatus: 'running' },
    });
    const db = workspaceDb({
      notion_import_jobs: [discoveringJob],
      notion_import_apply_locks: [{
        id: 'job-1',
        workspaceId: 'ws-1',
        jobId: 'job-1',
        leaseId: 'stranded-lease',
        actorId: 'owner-1',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }],
    });

    const result = await callFunction(POST, db, 'owner-1', {
      action: 'cancel',
      jobId: 'job-1',
      workspaceId: 'ws-1',
    });

    expect(result).not.toBeInstanceOf(Response);
    expect(db.tables.notion_import_jobs[0]).toMatchObject({
      status: 'cancelled',
      phase: 'cancelled',
    });
    expect(db.tables.notion_import_apply_locks).toHaveLength(0);
  });

  it('applies only the active generation when stale rows remain physically present', async () => {
    const db = workspaceDb({
      notion_import_jobs: [job('job-1', { activeItemGeneration: 'fresh-generation' })],
      notion_import_items: [
        {
          ...discoveredPage(),
          id: 'stale-item',
          itemGeneration: 'stale-generation',
          title: 'Stale imported page',
        },
        {
          ...discoveredPage(),
          id: 'fresh-item',
          itemGeneration: 'fresh-generation',
          title: 'Fresh imported page',
        },
      ],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
    });

    const result = await callFunction(POST, db, 'owner-1', {
      action: 'apply',
      jobId: 'job-1',
      workspaceId: 'ws-1',
    });

    expect(result).not.toBeInstanceOf(Response);
    expect(db.tables.pages.map((page) => page.title)).toEqual(['Fresh imported page']);
    expect(db.tables.pages.some((page) => page.title === 'Stale imported page')).toBe(false);
    expect(db.tables.notion_import_mappings).toHaveLength(1);
    expect(db.tables.notion_import_jobs[0].status).toBe('completed');
  });

  it('persists Korean placeholder database schema and view names from the durable job locale', async () => {
    const db = workspaceDb({
      notion_import_jobs: [job('job-1', { options: { locale: 'ko' } })],
      notion_import_items: [{
        id: 'item-database-placeholder',
        workspaceId: 'ws-1',
        jobId: 'job-1',
        notionId: 'database-placeholder',
        notionObject: 'database',
        title: 'Untitled',
        status: 'discovered',
        phase: 'database_snapshot',
        metadata: {},
      }],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      db_properties: [],
      db_views: [],
      db_templates: [],
      file_uploads: [],
    });

    const result = await callFunction(POST, db, 'owner-1', {
      action: 'apply',
      jobId: 'job-1',
      workspaceId: 'ws-1',
    });

    expect(result).not.toBeInstanceOf(Response);
    expect(db.tables.pages.map((page) => page.title)).toEqual(['연결된 데이터베이스']);
    expect(db.tables.db_properties).toEqual([
      expect.objectContaining({ name: '이름', type: 'title' }),
    ]);
    expect(db.tables.db_views).toEqual([
      expect.objectContaining({ name: '표', type: 'table' }),
    ]);
  });

  it('synthesizes a Korean title property and table view for an incomplete data-source snapshot', async () => {
    const db = workspaceDb({
      notion_import_jobs: [job('job-1', { options: { locale: 'ko' } })],
      notion_import_items: [{
        id: 'item-data-source-empty',
        workspaceId: 'ws-1',
        jobId: 'job-1',
        notionId: 'data-source-empty',
        notionObject: 'data_source',
        title: '',
        status: 'discovered',
        phase: 'data_source_snapshot',
        metadata: {
          dataSourceSnapshot: {
            dataSource: { id: 'data-source-empty', properties: {} },
            views: [],
          },
        },
      }],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      db_properties: [],
      db_views: [],
      db_templates: [],
      file_uploads: [],
    });

    const result = await callFunction(POST, db, 'owner-1', {
      action: 'apply',
      jobId: 'job-1',
      workspaceId: 'ws-1',
    });

    expect(result).not.toBeInstanceOf(Response);
    expect(db.tables.pages.map((page) => page.title)).toEqual(['가져온 데이터베이스']);
    expect(db.tables.db_properties).toEqual([
      expect.objectContaining({ name: '이름', type: 'title' }),
    ]);
    expect(db.tables.db_views).toEqual([
      expect.objectContaining({ name: '표', type: 'table' }),
    ]);
  });

  it('copies active-content Notion attachments and leaves safe delivery to EdgeBase', async () => {
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [
        {
          ...discoveredPage(),
          metadata: {
            pageSnapshot: {
              childBlocks: [
                {
                  id: 'notion-file-block',
                  object: 'block',
                  type: 'file',
                  file: {
                    type: 'external',
                    name: 'payload.html',
                    external: { url: 'data:text/html,<script>alert(1)</script>' },
                  },
                },
              ],
            },
          },
        },
      ],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      file_uploads: [],
    });
    const { storage, objects } = verifiedStorage();

    const result = await applyWithStorage(db, storage);

    expect(result).not.toBeInstanceOf(Response);
    expect(db.tables.notion_import_jobs[0].status).toBe('completed');
    expect(db.tables.blocks).toHaveLength(1);
    expect(db.tables.blocks[0]).toMatchObject({
      type: 'file',
      content: {
        fileName: 'payload.html',
        notionFileCopied: true,
        fileUploadId: expect.any(String),
      },
    });
    expect(JSON.stringify(db.tables.blocks)).not.toContain('data:');
    expect(db.tables.file_uploads).toEqual([
      expect.objectContaining({
        name: 'payload.html',
        contentType: 'text/html',
        status: 'uploaded',
        blockId: db.tables.blocks[0].id,
      }),
    ]);
    expect(objects.size).toBe(1);
    expect(Array.from(objects.values())[0]?.contentType).toBe('text/html');
  });

  it('copies arbitrary page chrome without retaining source URLs', async () => {
    const safeImage = 'data:image/png;base64,AQIDBA==';
    const unsafeCover = 'data:text/html,<script>alert(1)</script>';
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [{
        ...discoveredPage(),
        metadata: {
          pageSnapshot: {
            icon: { type: 'external', external: { url: safeImage } },
            cover: { type: 'external', external: { url: unsafeCover } },
            childBlocks: [],
          },
        },
      }],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      file_uploads: [],
    });
    const { storage, objects } = verifiedStorage();

    const result = await applyWithStorage(db, storage);

    expect(result).not.toBeInstanceOf(Response);
    expect(db.tables.notion_import_jobs[0].status).toBe('completed');
    const imported = db.tables.pages.find((page) => page.title === 'Imported page');
    expect(imported).toMatchObject({
      iconType: 'image',
      icon: expect.stringContaining('/api/storage/files/'),
      cover: expect.stringContaining('/api/storage/files/'),
    });
    expect(JSON.stringify(imported)).not.toContain('data:');
    expect(db.tables.file_uploads).toHaveLength(2);
    expect(db.tables.file_uploads.every((upload) => upload.status === 'uploaded')).toBe(true);
    expect(db.tables.file_uploads.map((upload) => upload.contentType).sort()).toEqual([
      'image/png',
      'text/html',
    ]);
    expect(objects.size).toBe(2);
    expect(JSON.stringify(db.tables.notion_import_items)).not.toContain('data:');
  });

  it('copies passive media and active attachments into separate durable owners', async () => {
    const safeImage = 'data:image/png;base64,AQIDBA==';
    const unsafeFile = 'data:text/html,<script>alert(1)</script>';
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [{
        ...discoveredPage(),
        metadata: {
          pageSnapshot: {
            childBlocks: [
              {
                id: 'safe-file-block',
                object: 'block',
                type: 'image',
                image: { type: 'external', name: 'safe.png', external: { url: safeImage } },
              },
              {
                id: 'unsafe-file-block',
                object: 'block',
                type: 'file',
                file: { type: 'external', name: 'payload.html', external: { url: unsafeFile } },
              },
            ],
          },
        },
      }],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      file_uploads: [],
    });
    const { storage } = verifiedStorage();

    const result = await applyWithStorage(db, storage);

    expect(result).not.toBeInstanceOf(Response);
    expect(db.tables.notion_import_jobs[0].status).toBe('completed');
    expect(db.tables.blocks).toHaveLength(2);
    expect(db.tables.blocks.map((block) => block.type)).toEqual(['image', 'file']);
    expect(JSON.stringify(db.tables.blocks)).not.toContain('data:');
    expect(JSON.stringify(db.tables.pages)).not.toContain('data:');
    expect(db.tables.file_uploads).toHaveLength(2);
    expect(db.tables.file_uploads.every((upload) =>
      upload.status === 'uploaded'
      && db.tables.blocks.some((block) => block.id === upload.blockId)
    )).toBe(true);
    expect(db.tables.file_uploads.map((upload) => upload.contentType).sort()).toEqual([
      'image/png',
      'text/html',
    ]);
  });

  it('copies file blocks embedded in a page template button without retaining its source URL', async () => {
    const safeImage = 'data:image/png;base64,AQIDBA==';
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [{
        ...discoveredPage(),
        metadata: {
          pageSnapshot: {
            childBlocks: [{
              id: 'page-template-button',
              type: 'template',
              template: { rich_text: [{ plain_text: 'Insert' }] },
              children: [{
                id: 'page-template-file',
                type: 'image',
                image: { type: 'external', name: 'button.png', external: { url: safeImage } },
              }],
            }],
          },
        },
      }],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      file_uploads: [],
    });
    const { storage } = verifiedStorage();

    const result = await applyWithStorage(db, storage);

    expect(result).not.toBeInstanceOf(Response);
    expect(db.tables.blocks).toHaveLength(1);
    expect(JSON.stringify(db.tables.blocks[0])).not.toContain('data:');
    expect(db.tables.file_uploads).toHaveLength(1);
    expect(db.tables.file_uploads[0]).toMatchObject({
      status: 'uploaded',
      blockId: db.tables.blocks[0].id,
    });
  });

  it('creates file block owners before attaching upload foreign keys in the same transaction', async () => {
    const safePdf = 'data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrCg==';
    const safeImage = 'data:image/png;base64,AQIDBA==';
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [{
        ...discoveredPage(),
        title: 'Imported Project Home',
        metadata: {
          pageSnapshot: {
            childBlocks: [
              {
                id: 'notion-source-pdf',
                object: 'block',
                type: 'pdf',
                pdf: {
                  type: 'file',
                  name: 'Source PDF',
                  file: { url: safePdf },
                  caption: [{ plain_text: 'Source PDF' }],
                },
              },
              {
                id: 'page-template-button',
                type: 'template',
                template: { rich_text: [{ plain_text: 'Insert' }] },
                children: [{
                  id: 'page-template-file',
                  type: 'image',
                  image: { type: 'external', name: 'button.png', external: { url: safeImage } },
                }],
              },
            ],
          },
        },
      }],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      file_uploads: [],
    });
    const fkGuard = enforceFileUploadForeignKeys(db);
    const { storage } = verifiedStorage();

    const result = await applyWithStorage(db, storage);

    expect(result).not.toBeInstanceOf(Response);
    expect(db.tables.blocks).toHaveLength(2);
    expect(db.tables.file_uploads).toHaveLength(2);
    expect(fkGuard.transactionalBlockAssociations).toBe(2);
    for (const upload of db.tables.file_uploads) {
      expect(upload).toMatchObject({ status: 'uploaded', blockId: expect.any(String) });
      expect(db.tables.blocks.some((block) => block.id === upload.blockId)).toBe(true);
    }
    expect(JSON.stringify(db.tables.blocks)).not.toContain('data:');
  });

  it('rejects an oversized deferred block file graph before creating any upload, object, or quota row', async () => {
    const safeImage = 'data:image/png;base64,AQIDBA==';
    const embeddedFiles = Array.from({ length: 120 }, (_, index) => ({
      id: `page-template-file-${index}`,
      type: 'image',
      image: {
        type: 'external',
        name: `button-${index}.png`,
        external: { url: safeImage },
      },
    }));
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [{
        ...discoveredPage(),
        metadata: {
          pageSnapshot: {
            childBlocks: [{
              id: 'oversized-page-template-button',
              type: 'template',
              template: { rich_text: [{ plain_text: 'Insert' }] },
              children: embeddedFiles,
            }],
          },
        },
      }],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      file_uploads: [],
      organization_storage_reservations: [],
      organization_storage_usage: [],
    });
    const { storage, objects } = verifiedStorage();

    const result = await applyWithStorage(db, storage);

    await expectErrorResponse(result, 413, 'Imported block contains too many stored files.');
    expect(db.tables.blocks).toHaveLength(0);
    expect(db.tables.file_uploads).toHaveLength(0);
    expect(db.tables.organization_storage_reservations).toHaveLength(0);
    expect(db.tables.organization_storage_usage).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it('rolls back the block and leaves a durable cleanup row when the owner transaction fails', async () => {
    const safePdf = 'data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrCg==';
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [{
        ...discoveredPage(),
        metadata: {
          pageSnapshot: {
            childBlocks: [{
              id: 'notion-source-pdf',
              object: 'block',
              type: 'pdf',
              pdf: {
                type: 'file',
                name: 'Source PDF',
                file: { url: safePdf },
              },
            }],
          },
        },
      }],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      file_uploads: [],
    });
    const originalTransact = db.transact.bind(db);
    db.transact = async (operations) => {
      if (
        operations.some((operation) => operation.table === 'blocks' && operation.op === 'insert')
        && operations.some((operation) =>
          operation.table === 'file_uploads'
          && operation.op === 'update'
          && typeof operation.data.blockId === 'string')
      ) {
        throw Object.assign(new Error('simulated owner transaction failure'), { code: 409 });
      }
      return originalTransact(operations);
    };
    const { storage, objects } = verifiedStorage();

    const result = await applyWithStorage(db, storage);

    await expectErrorResponse(result, 409, 'simulated owner transaction failure');
    expect(db.tables.blocks).toHaveLength(0);
    expect(db.tables.file_uploads).toHaveLength(1);
    expect(db.tables.file_uploads[0]).toMatchObject({
      status: 'deleting',
      deletionPreviousStatus: 'uploaded',
    });
    expect(db.tables.file_uploads[0].blockId ?? null).toBeNull();
    expect(objects.size).toBe(1);
    expect(db.tables.notion_import_jobs[0]).toMatchObject({
      status: 'failed',
      error: 'simulated owner transaction failure',
    });
  });

  it('preserves a concurrently edited file-block owner and retires only its now-orphaned upload', async () => {
    const safePdf = 'data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrCg==';
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [{
        ...discoveredPage(),
        metadata: {
          pageSnapshot: {
            childBlocks: [
              {
                id: 'notion-source-pdf',
                object: 'block',
                type: 'pdf',
                pdf: {
                  type: 'file',
                  name: 'Source PDF',
                  file: { url: safePdf },
                },
              },
              {
                id: 'later-failing-block',
                object: 'block',
                type: 'paragraph',
                paragraph: { rich_text: [{ plain_text: 'Later block' }] },
              },
            ],
          },
        },
      }],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      file_uploads: [],
    });
    const originalTable = db.table.bind(db);
    let injectedEdit = false;
    db.table = ((name: string) => {
      const table = originalTable(name);
      if (name !== 'blocks') return table;
      return {
        ...table,
        async insert(data: Partial<Row>) {
          if (data.type === 'paragraph' && !injectedEdit) {
            injectedEdit = true;
            const importedOwner = db.tables.blocks.find((block) => block.type === 'file');
            expect(importedOwner).toBeTruthy();
            importedOwner!.type = 'paragraph';
            importedOwner!.content = { rich: [{ text: 'User replacement survives' }] };
            importedOwner!.plainText = 'User replacement survives';
            importedOwner!.updatedAt = new Date().toISOString();
            throw Object.assign(new Error('simulated later import failure'), { code: 409 });
          }
          return table.insert(data);
        },
      };
    }) as typeof db.table;
    const { storage, objects } = verifiedStorage();

    const result = await applyWithStorage(db, storage);

    await expectErrorResponse(result, 409, 'simulated later import failure');
    expect(injectedEdit).toBe(true);
    expect(db.tables.blocks).toHaveLength(1);
    expect(db.tables.blocks[0]).toMatchObject({
      type: 'paragraph',
      content: { rich: [{ text: 'User replacement survives' }] },
      plainText: 'User replacement survives',
    });
    expect(db.tables.file_uploads).toHaveLength(1);
    expect(db.tables.file_uploads[0]).toMatchObject({
      status: 'deleting',
      deletionPreviousStatus: 'uploaded',
      blockId: db.tables.blocks[0].id,
    });
    expect(objects.size).toBe(1);
  });

  it('preserves existing blocks and fails closed instead of deleting before replacement is ready', async () => {
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [{
        ...discoveredPage(),
        metadata: {
          pageSnapshot: {
            childBlocks: [{ id: 'new-block', type: 'paragraph', paragraph: { rich_text: [] } }],
          },
        },
      }],
      notion_import_mappings: [{
        id: 'mapping-page',
        workspaceId: 'ws-1',
        jobId: 'job-1',
        mappingKey: 'job-1:notion-page-1',
        notionId: 'notion-page-1',
        notionType: 'page',
        localId: 'existing-page',
        localType: 'page',
        relationKind: 'page',
      }],
      notion_import_apply_locks: [],
      pages: [{
        id: 'existing-page',
        workspaceId: 'ws-1',
        parentType: 'workspace',
        parentId: null,
        kind: 'page',
        title: 'Existing',
        properties: {},
      }],
      blocks: [{
        id: 'old-block',
        pageId: 'existing-page',
        parentId: null,
        type: 'paragraph',
        content: { rich: [{ text: 'Keep me' }] },
        plainText: 'Keep me',
        position: 1,
      }],
      file_uploads: [],
    });

    const result = await callFunction(POST, db, 'owner-1', {
      action: 'apply',
      jobId: 'job-1',
      workspaceId: 'ws-1',
    });

    await expectErrorResponse(result, 409, 'Existing content was preserved.');
    expect(db.tables.blocks).toHaveLength(1);
    expect(db.tables.blocks[0]).toMatchObject({ id: 'old-block', plainText: 'Keep me' });
  });

  it('treats a forced repair of an already-current block graph as an idempotent verification', async () => {
    const db = workspaceDb({
      notion_import_jobs: [job('job-1', { status: 'completed', phase: 'completed' })],
      notion_import_items: [{
        ...discoveredPage(),
        metadata: {
          pageSnapshot: {
            childBlocks: [{ id: 'source-block', type: 'paragraph', paragraph: { rich_text: [] } }],
          },
        },
      }],
      notion_import_mappings: [{
        id: 'mapping-page',
        workspaceId: 'ws-1',
        jobId: 'job-1',
        mappingKey: 'job-1:notion-page-1',
        notionId: 'notion-page-1',
        notionType: 'page',
        localId: 'existing-page',
        localType: 'page',
        relationKind: 'page',
      }],
      pages: [{
        id: 'existing-page',
        workspaceId: 'ws-1',
        parentType: 'workspace',
        parentId: null,
        kind: 'page',
        title: 'Existing',
        properties: {
          __notionImportBlocksComplete: true,
          __notionImportBlockBoundaryRepairVersion: 5,
        },
      }],
      blocks: [{
        id: 'current-block',
        pageId: 'existing-page',
        parentId: null,
        type: 'paragraph',
        content: { rich: [{ text: 'Keep current graph' }] },
        plainText: 'Keep current graph',
        position: 1,
      }],
      file_uploads: [],
    });

    const result = await callFunction(POST, db, 'owner-1', {
      action: 'repairImportedPageBlocks',
      jobId: 'job-1',
      workspaceId: 'ws-1',
      maxPages: 1,
      force: true,
    });

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({
      repaired: { pages: 1, skippedAlreadyRepaired: 1 },
      lastRepaired: { notionPageId: 'notion-page-1', localPageId: 'existing-page' },
    });
    expect(db.tables.blocks).toEqual([
      expect.objectContaining({ id: 'current-block', plainText: 'Keep current graph' }),
    ]);
    expect(db.tables.file_uploads).toHaveLength(0);
  });

  it('copies template icon, file property, and nested file block before committing the template', async () => {
    const safeImage = 'data:image/png;base64,AQIDBA==';
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [{
        id: 'item-ds-1',
        workspaceId: 'ws-1',
        jobId: 'job-1',
        notionId: 'ds-1',
        notionObject: 'data_source',
        title: 'Imported database',
        status: 'discovered',
        phase: 'data_source_snapshot',
        metadata: {
          dataSourceSnapshot: {
            dataSource: {
              id: 'ds-1',
              properties: {
                Name: { id: 'title-prop', name: 'Name', type: 'title', title: {} },
                Files: { id: 'files-prop', name: 'Files', type: 'files', files: {} },
              },
            },
            templates: [{
              id: 'template-notion-1',
              name: 'With files',
              icon: { type: 'external', external: { url: safeImage } },
              properties: {
                Files: {
                  id: 'files-prop',
                  type: 'files',
                  files: [{ name: 'property.png', type: 'external', external: { url: safeImage } }],
                },
              },
              blocks: [
                {
                  id: 'template-file-block',
                  type: 'image',
                  image: { type: 'external', name: 'block.png', external: { url: safeImage } },
                  children: [{
                    id: 'template-child-file-block',
                    type: 'file',
                    file: { type: 'external', name: 'child.png', external: { url: safeImage } },
                  }],
                },
                {
                  id: 'template-button-block',
                  type: 'template',
                  template: { rich_text: [{ plain_text: 'Insert' }] },
                  children: [{
                    id: 'template-button-file',
                    type: 'image',
                    image: { type: 'external', name: 'button.png', external: { url: safeImage } },
                  }],
                },
              ],
            }],
          },
        },
      }],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      db_properties: [],
      db_views: [],
      db_templates: [],
      file_uploads: [],
    });
    const { storage } = verifiedStorage();

    const result = await applyWithStorage(db, storage);

    expect(result).not.toBeInstanceOf(Response);
    expect(db.tables.notion_import_jobs[0].status).toBe('completed');
    expect(db.tables.db_templates).toHaveLength(1);
    const template = db.tables.db_templates[0];
    expect(JSON.stringify(template)).not.toContain('data:');
    expect(db.tables.file_uploads).toHaveLength(5);
    expect(db.tables.file_uploads.every((upload) =>
      upload.status === 'uploaded'
      && upload.templateId === template.id
      && upload.databaseId === template.databaseId
      && typeof upload.completedAt === 'string'
    )).toBe(true);
  });

  it('reuses the exact completed template uploads across a chunked apply resume', async () => {
    const db = resumableTemplateDb(true);
    db.tables.workspaces[0].organizationId = 'org-1';
    db.tables.organizations = [{ id: 'org-1', storageLimitBytes: 1_000_000 }];
    db.tables.organization_storage_usage = [];
    db.tables.organization_storage_reservations = [];
    const { storage, objects } = verifiedStorage();

    const first = await applyWithStorage(db, storage, { applyDatabaseBatchSize: 1 }) as {
      partial?: boolean;
    };
    expect(first.partial).toBe(true);
    expect(db.tables.notion_import_jobs[0].status).toBe('ready');
    expect(db.tables.notion_import_jobs[0].progress?.applyCursor).toMatchObject({
      phase: 'apply_database_containers',
      databasePass: 'direct',
      databaseIndex: 1,
    });
    expect(db.tables.file_uploads).toHaveLength(5);
    expect(objects.size).toBe(5);
    const firstUploadIds = db.tables.file_uploads.map((upload) => upload.id).sort();
    const firstObjectKeys = Array.from(objects.keys()).sort();
    const firstReservedBytes = db.tables.organization_storage_usage[0]?.reservedBytes;
    expect(db.tables.organization_storage_reservations.filter((row) => row.status === 'active')).toHaveLength(5);

    const second = await applyWithStorage(db, storage, { applyDatabaseBatchSize: 1 });

    expect(second).not.toBeInstanceOf(Response);
    expect(db.tables.notion_import_jobs[0].status).toBe('completed');
    expect(db.tables.file_uploads).toHaveLength(5);
    expect(db.tables.file_uploads.map((upload) => upload.id).sort()).toEqual(firstUploadIds);
    expect(Array.from(objects.keys()).sort()).toEqual(firstObjectKeys);
    expect(db.tables.organization_storage_usage[0]?.reservedBytes).toBe(firstReservedBytes);
    expect(db.tables.organization_storage_reservations.filter((row) => row.status === 'active')).toHaveLength(5);
    const template = db.tables.db_templates[0];
    for (const uploadId of firstUploadIds) {
      expect(JSON.stringify(template)).toContain(uploadId);
    }
  });

  it('retires only unreferenced extras from the old duplicate-copy bug and keeps the complete owner set', async () => {
    const db = resumableTemplateDb(false);
    db.tables.workspaces[0].organizationId = 'org-1';
    db.tables.organizations = [{ id: 'org-1', storageLimitBytes: 1_000_000 }];
    db.tables.organization_storage_usage = [];
    db.tables.organization_storage_reservations = [];
    const { storage, objects } = verifiedStorage();
    const first = await applyWithStorage(db, storage, { applyDatabaseBatchSize: 1 }) as {
      partial?: boolean;
    };
    expect(first.partial).toBe(true);
    const template = db.tables.db_templates[0];
    const ownerUpload = db.tables.file_uploads[0];
    const ownerUploadId = ownerUpload.id;
    const orphanKey = `workspaces/ws-1/notion-import/job-1/icons/orphan-extra.png`;
    const orphanUrl = `http://localhost:8787/api/storage/files/${orphanKey}`;
    db.tables.file_uploads.push({
      id: 'orphan-extra',
      workspaceId: 'ws-1',
      bucket: 'files',
      key: orphanKey,
      scope: 'icons',
      databaseId: template.databaseId,
      templateId: template.id,
      name: 'orphan-extra.png',
      contentType: 'image/png',
      size: 4,
      status: 'uploaded',
      url: orphanUrl,
      completedAt: new Date().toISOString(),
    });
    db.tables.organization_storage_usage[0].reservedBytes += 4;
    db.tables.organization_storage_reservations.push({
      id: 'orphan-extra',
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      bytes: 4,
      status: 'active',
    });
    objects.set(orphanKey, {
      bytes: new Uint8Array([1, 2, 3, 4]).buffer,
      contentType: 'image/png',
    });

    const second = await applyWithStorage(db, storage, { applyDatabaseBatchSize: 1 });

    expect(second).not.toBeInstanceOf(Response);
    expect(db.tables.notion_import_jobs[0].status).toBe('completed');
    expect(objects.has(orphanKey)).toBe(false);
    expect(db.tables.file_uploads.find((upload) => upload.id === 'orphan-extra')).toMatchObject({
      status: 'expired',
    });
    expect(db.tables.file_uploads.filter((upload) => upload.status === 'uploaded')).toHaveLength(1);
    expect(db.tables.file_uploads.find((upload) => upload.id === ownerUploadId)).toMatchObject({
      status: 'uploaded',
    });
    expect(db.tables.organization_storage_usage[0].reservedBytes).toBe(4);
    expect(db.tables.organization_storage_reservations.find((row) => row.id === 'orphan-extra')).toMatchObject({
      status: 'released',
    });
    expect(JSON.stringify(db.tables.db_templates[0])).toContain(ownerUploadId);
    expect(JSON.stringify(db.tables.db_templates[0])).not.toContain('orphan-extra');
  });

  it('recovers a source-only owner plus interrupted partial upload before migrating once', async () => {
    const db = resumableTemplateDb(false);
    db.tables.workspaces[0].organizationId = 'org-1';
    db.tables.organizations = [{ id: 'org-1', storageLimitBytes: 1_000_000 }];
    db.tables.organization_storage_usage = [];
    db.tables.organization_storage_reservations = [];
    const { storage, objects } = verifiedStorage();
    const first = await applyWithStorage(db, storage, { applyDatabaseBatchSize: 1 }) as {
      partial?: boolean;
    };
    expect(first.partial).toBe(true);
    const template = db.tables.db_templates[0];
    const interrupted = db.tables.file_uploads[0];
    const interruptedId = interrupted.id;
    const interruptedKey = interrupted.key as string;
    template.icon = SAFE_TEMPLATE_IMAGE;
    interrupted.status = 'pending';
    interrupted.completedAt = null;
    interrupted.expiresAt = new Date(Date.now() + DAY_MS).toISOString();

    const second = await applyWithStorage(db, storage, { applyDatabaseBatchSize: 1 });

    expect(second).not.toBeInstanceOf(Response);
    expect(db.tables.notion_import_jobs[0].status).toBe('completed');
    expect(db.tables.file_uploads.find((upload) => upload.id === interruptedId)).toMatchObject({
      status: 'expired',
    });
    expect(objects.has(interruptedKey)).toBe(false);
    const active = db.tables.file_uploads.filter((upload) => upload.status === 'uploaded');
    expect(active).toHaveLength(1);
    expect(active[0].id).not.toBe(interruptedId);
    expect(objects.size).toBe(1);
    expect(db.tables.organization_storage_usage[0].reservedBytes).toBe(4);
    expect(db.tables.organization_storage_reservations.find((row) => row.id === interruptedId)).toMatchObject({
      status: 'released',
    });
    expect(db.tables.organization_storage_reservations.find((row) => row.id === active[0].id)).toMatchObject({
      status: 'active',
    });
    expect(JSON.stringify(db.tables.db_templates[0])).toContain(active[0].id);
    expect(JSON.stringify(db.tables.db_templates[0])).not.toContain(interruptedId);
  });

  it('fails closed on a contradictory owner marker without compensating the prior completed owner', async () => {
    const db = resumableTemplateDb(false);
    const { storage } = verifiedStorage();
    const first = await applyWithStorage(db, storage, { applyDatabaseBatchSize: 1 }) as {
      partial?: boolean;
    };
    expect(first.partial).toBe(true);
    const template = db.tables.db_templates[0];
    const completed = db.tables.file_uploads[0];
    const completedUrl = template.icon;
    template.properties = {
      ...(template.properties ?? {}),
      unexpectedStoredOwner: {
        uploadId: 'missing-upload',
        key: 'workspaces/ws-1/notion-import/job-1/database/files/missing.png',
      },
    };

    const second = await applyWithStorage(db, storage, { applyDatabaseBatchSize: 1 });

    await expectErrorResponse(second, 409, 'partial or contradictory stored-file owner graph');
    expect(db.tables.notion_import_jobs[0].status).toBe('failed');
    expect(db.tables.file_uploads.find((upload) => upload.id === completed.id)).toMatchObject({
      status: 'uploaded',
      completedAt: expect.any(String),
    });
    expect(db.tables.db_templates[0].icon).toBe(completedUrl);
  });

  it('copies an active attachment in a template file property without making the import partial', async () => {
    const safeImage = 'data:image/png;base64,AQIDBA==';
    const activeFile = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cscript%3Ealert(1)%3C/script%3E%3C/svg%3E';
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [{
        id: 'item-ds-template-failure',
        workspaceId: 'ws-1',
        jobId: 'job-1',
        notionId: 'ds-template-failure',
        notionObject: 'data_source',
        title: 'Imported database',
        status: 'discovered',
        phase: 'data_source_snapshot',
        metadata: {
          dataSourceSnapshot: {
            dataSource: {
              id: 'ds-template-failure',
              properties: {
                Name: { id: 'title-prop', name: 'Name', type: 'title', title: {} },
                Files: { id: 'files-prop', name: 'Files', type: 'files', files: {} },
              },
            },
            templates: [{
              id: 'template-failure',
              name: 'Unsafe template',
              icon: { type: 'external', external: { url: safeImage } },
              properties: {
                Files: {
                  id: 'files-prop',
                  type: 'files',
                  files: [{ name: 'diagram.svg', type: 'external', external: { url: activeFile } }],
                },
              },
              blocks: [],
            }],
          },
        },
      }],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      db_properties: [],
      db_views: [],
      db_templates: [],
      file_uploads: [],
    });
    const { storage, objects } = verifiedStorage();

    const result = await applyWithStorage(db, storage);

    expect(result).not.toBeInstanceOf(Response);
    expect(db.tables.notion_import_jobs[0].status).toBe('completed');
    expect(db.tables.db_templates).toHaveLength(1);
    const template = db.tables.db_templates[0];
    expect(JSON.stringify(template)).not.toContain('data:');
    expect(JSON.stringify(template)).toContain('diagram.svg');
    expect(db.tables.file_uploads).toHaveLength(2);
    expect(db.tables.file_uploads.every((upload) =>
      upload.status === 'uploaded'
      && upload.templateId === template.id
      && upload.databaseId === template.databaseId
    )).toBe(true);
    expect(db.tables.file_uploads.map((upload) => upload.contentType).sort()).toEqual([
      'image/png',
      'image/svg+xml',
    ]);
    expect(objects.size).toBe(2);
    expect(JSON.stringify(db.tables.pages)).not.toContain('data:');
    expect(JSON.stringify(db.tables.notion_import_items)).not.toContain('data:');
  });

  it('rejects an app-local storage locator before creating the import root', async () => {
    const db = workspaceDb({
      notion_import_jobs: [job('job-1')],
      notion_import_items: [{
        ...discoveredPage(),
        metadata: {
          pageSnapshot: {
            childBlocks: [{
              id: 'squatted-block',
              object: 'block',
              type: 'image',
              image: {
                type: 'external',
                external: { url: '/api/storage/files/workspaces/ws-1/uploads/foreign.png' },
              },
            }],
          },
        },
      }],
      notion_import_mappings: [],
      notion_import_apply_locks: [],
      pages: [],
      blocks: [],
      file_uploads: [],
    });

    const result = await callFunction(POST, db, 'owner-1', {
      action: 'apply',
      jobId: 'job-1',
      workspaceId: 'ws-1',
    });

    await expectErrorResponse(
      result,
      409,
      'Stored files cannot be attached while creating this item',
    );
    expect(db.tables.pages).toHaveLength(0);
    expect(db.tables.blocks).toHaveLength(0);
    expect(db.tables.notion_import_mappings).toHaveLength(0);
  });

  it('rejects an exact existing upload URL before persisting supplied snapshot items', async () => {
    const storedUrl = 'https://hanji.example/api/storage/files/workspaces/ws-1/uploads/existing.png';
    const db = workspaceDb({
      notion_import_jobs: [],
      notion_import_items: [],
      file_uploads: [{
        id: 'existing-upload',
        workspaceId: 'ws-1',
        bucket: 'files',
        key: 'workspaces/ws-1/uploads/existing.png',
        url: storedUrl,
        name: 'existing.png',
        size: 4,
        status: 'uploaded',
      }],
    });

    const result = await callFunction(POST, db, 'owner-1', {
      action: 'create',
      workspaceId: 'ws-1',
      connectionKind: 'manual_token',
      snapshotItems: [{
        notionId: 'notion-page-foreign',
        notionObject: 'page',
        metadata: {
          pageSnapshot: {
            childBlocks: [{
              id: 'foreign-url-block',
              object: 'block',
              type: 'image',
              image: { type: 'external', external: { url: storedUrl } },
            }],
          },
        },
      }],
    });

    await expectErrorResponse(
      result,
      409,
      'Stored files cannot be attached while creating this item',
    );
    expect(db.tables.notion_import_jobs).toHaveLength(0);
    expect(db.tables.notion_import_items).toHaveLength(0);
  });
});

describe('Notion import generated locale durability', () => {
  it('stores an explicit product locale on a new job', async () => {
    const db = workspaceDb({
      notion_import_jobs: [],
      notion_import_items: [],
      file_uploads: [],
    });
    const result = (await callFunction(POST, db, 'owner-1', {
      action: 'create',
      workspaceId: 'ws-1',
      connectionKind: 'manual_token',
      locale: 'ko',
      snapshotItems: [{
        notionId: 'synthetic-page',
        notionObject: 'page',
        title: '',
        metadata: { pageSnapshot: { childBlocks: [] } },
      }],
    })) as { job: { options?: Record<string, unknown> } };

    expect(result.job.options?.locale).toBe('ko');
    expect(db.tables.notion_import_jobs[0].options).toMatchObject({ locale: 'ko' });
  });

  it('preserves the original locale across retry even if the UI language later changes', async () => {
    const db = workspaceDb({
      notion_import_jobs: [job('failed-job', {
        status: 'failed',
        options: { locale: 'ko', maxDiscoveryPages: 4 },
      })],
      notion_import_items: [],
      file_uploads: [],
    });
    const result = (await callFunction(POST, db, 'owner-1', {
      action: 'retry',
      jobId: 'failed-job',
      workspaceId: 'ws-1',
      locale: 'en',
    })) as { job: { id: string; options?: Record<string, unknown> } };

    expect(result.job.id).not.toBe('failed-job');
    expect(result.job.options).toMatchObject({ locale: 'ko', maxDiscoveryPages: 4 });
  });

  it('rejects an unsupported product locale before creating a job', async () => {
    const db = workspaceDb({
      notion_import_jobs: [],
      notion_import_items: [],
      file_uploads: [],
    });
    const result = await callFunction(POST, db, 'owner-1', {
      action: 'create',
      workspaceId: 'ws-1',
      connectionKind: 'manual_token',
      locale: 'ko-KR',
      snapshotItems: [{ notionId: 'synthetic-page', notionObject: 'page' }],
    });

    await expectErrorResponse(result, 400, 'locale must be "en" or "ko".');
    expect(db.tables.notion_import_jobs).toHaveLength(0);
  });
});

describe('Notion import snapshot staging durability', () => {
  it('never exposes a partially inserted snapshot as ready for plan or apply', async () => {
    const db = workspaceDb({
      notion_import_jobs: [],
      notion_import_items: [],
      notion_import_apply_locks: [],
      notion_import_mappings: [],
      file_uploads: [],
      pages: [],
      blocks: [],
    });
    const originalTransact = db.transact.bind(db);
    let rejectedStaging = false;
    db.transact = async (operations) => {
      if (
        !rejectedStaging
        && operations.some((operation) => (
          operation.table === 'notion_import_items' && operation.op === 'insert'
        ))
      ) {
        rejectedStaging = true;
        throw new Error('synthetic snapshot staging failure');
      }
      return originalTransact(operations);
    };

    const createResult = await callFunction(POST, db, 'owner-1', {
      action: 'create',
      workspaceId: 'ws-1',
      connectionKind: 'manual_token',
      snapshotItems: [
        { notionId: 'synthetic-page-1', notionObject: 'page' },
        { notionId: 'synthetic-page-2', notionObject: 'page' },
        { notionId: 'synthetic-page-3', notionObject: 'page' },
      ],
    });

    // Unexpected storage failures are intentionally redacted at the HTTP
    // boundary; the durable job keeps the actionable internal reason.
    await expectErrorResponse(createResult, 500, 'Internal server error.');
    expect(db.tables.notion_import_items).toHaveLength(0);
    expect(db.tables.notion_import_jobs).toHaveLength(1);
    expect(db.tables.notion_import_jobs[0]).toMatchObject({
      status: 'failed',
      phase: 'snapshot_staging_failed',
      error: 'synthetic snapshot staging failure',
    });

    const jobId = db.tables.notion_import_jobs[0].id;
    const planResult = (await callFunction(POST, db, 'owner-1', {
      action: 'plan',
      workspaceId: 'ws-1',
      jobId,
    })) as { job: { status: string }; plan: { status: string; canApply: boolean } };
    expect(planResult.job.status).toBe('failed');
    expect(planResult.plan).toMatchObject({ status: 'blocked', canApply: false });

    const applyResult = await callFunction(POST, db, 'owner-1', {
      action: 'apply',
      workspaceId: 'ws-1',
      jobId,
    });
    await expectErrorResponse(applyResult, 409, 'must be ready before apply');
    expect(db.tables.pages).toHaveLength(0);
    expect(db.tables.blocks).toHaveLength(0);
    expect(db.tables.notion_import_mappings).toHaveLength(0);
  });

  it('switches generations atomically and hides an undeleted stale tail', async () => {
    const activeItemGeneration = 'generation-old';
    const oldItems = Array.from({ length: 501 }, (_, index): Row => ({
      id: `old-${index}`,
      workspaceId: 'ws-1',
      jobId: 'job-1',
      itemGeneration: activeItemGeneration,
      notionId: index === 500 ? 'shared-notion-id' : `old-notion-${index}`,
      notionObject: 'page',
      title: `Old ${index}`,
      status: 'discovered',
      phase: 'discovery',
    }));
    const db = workspaceDb({
      notion_import_jobs: [job('job-1', { activeItemGeneration })],
      notion_import_items: oldItems,
      notion_import_mappings: [],
      file_uploads: [],
    });
    const originalTransact = db.transact.bind(db);
    db.transact = async (operations) => {
      if (
        operations.some((operation) => (
          operation.table === 'notion_import_items'
          && operation.op === 'delete'
          && operation.id === 'old-500'
        ))
      ) {
        throw new Error('synthetic stale cleanup failure');
      }
      return originalTransact(operations);
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const currentJob = db.tables.notion_import_jobs[0] as unknown as NotionImportJob;
      const inserted = await replaceDiscoveredItems(db, currentJob, [
        {
          notionId: 'shared-notion-id',
          notionObject: 'page',
          title: 'Fresh shared page',
        },
        {
          notionId: 'fresh-notion-id',
          notionObject: 'page',
          title: 'Fresh only page',
        },
      ]);
      expect(inserted).toHaveLength(2);
    } finally {
      consoleError.mockRestore();
    }

    // Earlier cleanup transactions committed, while the final stale tail
    // survived. It is physically present but cannot leak through readers.
    expect(db.tables.notion_import_items.length).toBeGreaterThan(2);
    expect(db.tables.notion_import_items.some((item) => item.id === 'old-500')).toBe(true);
    const refreshedJob = db.tables.notion_import_jobs[0] as unknown as NotionImportJob;
    expect(refreshedJob.activeItemGeneration).not.toBe(activeItemGeneration);
    const activeItems = await listActiveNotionImportItems(db, refreshedJob);
    expect(activeItems.map((item) => item.notionId).sort()).toEqual([
      'fresh-notion-id',
      'shared-notion-id',
    ]);

    const getResult = (await callFunction(POST, db, 'owner-1', {
      action: 'get',
      workspaceId: 'ws-1',
      jobId: 'job-1',
    })) as { items: Array<{ notionId: string; title?: string }> };
    expect(getResult.items).toHaveLength(2);
    expect(getResult.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ notionId: 'shared-notion-id', title: 'Fresh shared page' }),
      expect.objectContaining({ notionId: 'fresh-notion-id', title: 'Fresh only page' }),
    ]));

    const planResult = (await callFunction(POST, db, 'owner-1', {
      action: 'plan',
      workspaceId: 'ws-1',
      jobId: 'job-1',
    })) as { plan: { counts: Record<string, number>; canApply: boolean } };
    expect(planResult.plan.canApply).toBe(true);
    expect(planResult.plan.counts.page).toBe(2);
  });

  it('rolls back completed insert batches and keeps the previous generation active', async () => {
    const activeItemGeneration = 'generation-old';
    const db = workspaceDb({
      notion_import_jobs: [job('job-1', {
        status: 'discovering',
        phase: 'snapshot_staging',
        activeItemGeneration,
      })],
      notion_import_items: [{
        id: 'old-active',
        workspaceId: 'ws-1',
        jobId: 'job-1',
        itemGeneration: activeItemGeneration,
        notionId: 'old-active-notion-id',
        notionObject: 'page',
        status: 'discovered',
        phase: 'discovery',
      }],
      notion_import_apply_locks: [],
      notion_import_mappings: [],
      file_uploads: [],
      pages: [],
      blocks: [],
    });
    const originalTransact = db.transact.bind(db);
    let insertBatch = 0;
    let maxOperations = 0;
    db.transact = async (operations) => {
      maxOperations = Math.max(maxOperations, operations.length);
      if (operations.some((operation) => (
        operation.table === 'notion_import_items' && operation.op === 'insert'
      ))) {
        insertBatch += 1;
        if (insertBatch === 2) throw new Error('synthetic second insert batch failure');
      }
      return originalTransact(operations);
    };
    const replacement = Array.from({ length: 501 }, (_, index) => ({
      notionId: `new-notion-${index}`,
      notionObject: 'page',
    }));

    await expect(replaceDiscoveredItems(
      db,
      db.tables.notion_import_jobs[0] as unknown as NotionImportJob,
      replacement,
    )).rejects.toThrow('synthetic second insert batch failure');

    expect(maxOperations).toBeLessThanOrEqual(500);
    expect(db.tables.notion_import_jobs[0].activeItemGeneration).toBe(activeItemGeneration);
    expect(db.tables.notion_import_items).toEqual([
      expect.objectContaining({ id: 'old-active', itemGeneration: activeItemGeneration }),
    ]);
    const activeItems = await listActiveNotionImportItems(
      db,
      db.tables.notion_import_jobs[0] as unknown as NotionImportJob,
    );
    expect(activeItems.map((item) => item.notionId)).toEqual(['old-active-notion-id']);

    const planResult = (await callFunction(POST, db, 'owner-1', {
      action: 'plan',
      workspaceId: 'ws-1',
      jobId: 'job-1',
    })) as { plan: { status: string; canApply: boolean } };
    expect(planResult.plan).toMatchObject({ status: 'blocked', canApply: false });
    const applyResult = await callFunction(POST, db, 'owner-1', {
      action: 'apply',
      workspaceId: 'ws-1',
      jobId: 'job-1',
    });
    await expectErrorResponse(applyResult, 409, 'must be ready before apply');
  });
});

describe('listJobs gates the destructive prune on edit access (#10)', () => {
  const staleJobs = () => [
    job('stale-1', { status: 'failed', createdAt: isoAgo(60 * DAY_MS), updatedAt: isoAgo(60 * DAY_MS) }),
    job('fresh-1', { status: 'completed' }),
  ];

  it('a view-only member lists jobs without hard-deleting stale rows', async () => {
    const db = workspaceDb({ notion_import_jobs: staleJobs() });
    const result = (await callFunction(POST, db, 'guest-1', {
      action: 'list',
      workspaceId: 'ws-1',
    })) as { jobs: Array<{ id: string }> };
    expect(result.jobs.map((item) => item.id).sort()).toEqual(['fresh-1', 'stale-1']);
    expect(db.tables.notion_import_jobs.map((row) => row.id).sort()).toEqual(['fresh-1', 'stale-1']);
  });

  it("an editor's listing still prunes stale jobs", async () => {
    const db = workspaceDb({ notion_import_jobs: staleJobs() });
    const result = (await callFunction(POST, db, 'member-1', {
      action: 'list',
      workspaceId: 'ws-1',
    })) as { jobs: Array<{ id: string }> };
    expect(result.jobs.map((item) => item.id)).toEqual(['fresh-1']);
    expect(db.tables.notion_import_jobs.map((row) => row.id)).toEqual(['fresh-1']);
  });
});

describe('discovery progress writes cannot land after the terminal update (#11)', () => {
  // The throttled onDiscoveryProgress writer lives in a closure inside
  // discoverJob (not unit-isolable without a live Notion fetch), so pin the
  // ordering contract at the source level: the finalizer must stop new ticks,
  // await the in-flight write, and run before BOTH terminal job updates.
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../functions/notion-import.ts'),
    'utf8',
  );

  it('onDiscoveryProgress skips once finalized and tracks the in-flight promise', () => {
    expect(source).toContain('if (progressFinalized || progressWriteInFlight) return;');
    expect(source).toContain('progressWriteInFlight = bestEffort(');
  });

  it('the finalizer awaits the in-flight write before ready and failed updates', () => {
    expect(source).toContain('const finalizeDiscoveryProgress = async () => {');
    expect(source).toMatch(/progressFinalized = true;\s*const inFlight = progressWriteInFlight;\s*if \(inFlight\) await inFlight\.catch/);
    expect(source).toMatch(/await finalizeDiscoveryProgress\(\);\s*const updated = await updateNotionJobIfStatus\(db, job\.id, 'discovering', \{\s*status: 'ready',/);
    expect(source).toMatch(/await finalizeDiscoveryProgress\(\);\s*const current = await getExisting\(jobs, job\.id\);/);
  });

  it('single-flights discovery and never overwrites a concurrent cancel', () => {
    expect(source).toContain("acquireNotionApplyLease(db, job, actorId, 'discover')");
    expect(source).toContain('NOTION_DISCOVER_LEASE_TTL_MS = 90 * 1000');
    expect(source).toContain("'already being discovered'");
    expect(source).toContain("updateNotionJobIfStatus(db, job.id, 'discovering'");
    const cancelStart = source.indexOf('async function cancelJob(');
    const cancelEnd = source.indexOf('async function retryJob(', cancelStart);
    const cancelBody = source.slice(cancelStart, cancelEnd);
    expect(cancelBody).toContain('updateNotionJobIfStatus(db, job.id, job.status');
    expect(cancelBody).toContain("db.table<NotionImportApplyLock>('notion_import_apply_locks').delete(job.id)");
  });

  it('declares the persisted lease purpose used by discovery lock transactions', () => {
    const configSource = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../edgebase.config.ts'),
      'utf8',
    );
    const lockStart = configSource.indexOf('notion_import_apply_locks:');
    const lockEnd = configSource.indexOf('// ─── Comments', lockStart);
    expect(configSource.slice(lockStart, lockEnd)).toContain(
      "purpose: { type: 'string', default: 'apply' }",
    );
  });

  it('keeps selected-root discovery recursive across linked graph references', () => {
    expect(source).not.toContain('if (rootScopedDiscovery) return;');
    expect(source).toMatch(/for \(const target of dataSourceSnapshot\.relationTargetReferences\)/);
    expect(source).toMatch(/for \(const pageId of notionPageIdsFromViewFilters/);
  });

  it('applies a finite deadline to every imported-file fetch', () => {
    const body = source.slice(
      source.indexOf('async function fetchFileForImport('),
      source.indexOf('function fileCopyFailureMessage', source.indexOf('async function fetchFileForImport(')),
    );
    expect(body).toContain('AbortSignal.timeout(60_000)');
    expect(body).toContain('fetchPublicResource(reference.url, fetchInit)');
    expect(body).toContain('fetch(reference.url, fetchInit)');
  });
});

describe('readResponseBodyWithByteCap (#12)', () => {
  function chunkedResponse(chunks: Uint8Array[], onPull?: () => void) {
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          onPull?.();
          controller.enqueue(chunks[index]);
          index += 1;
        } else {
          controller.close();
        }
      },
    });
    return new Response(stream);
  }

  it('assembles a chunked body under the cap in order', async () => {
    const response = chunkedResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    const buffer = await readResponseBodyWithByteCap(response, 10);
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('keeps unknown-length buffering far below the normal 5 GiB file ceiling', () => {
    expect(MAX_UNKNOWN_LENGTH_IMPORTED_FILE_SIZE).toBe(64 * 1024 * 1024);
    expect(MAX_UNKNOWN_LENGTH_IMPORTED_FILE_SIZE).toBeLessThan(128 * 1024 * 1024);
  });

  it('aborts as soon as the running total crosses the cap instead of draining the stream', async () => {
    let pulls = 0;
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(1024));
    const response = chunkedResponse(chunks, () => {
      pulls += 1;
    });
    await expect(readResponseBodyWithByteCap(response, 2048)).rejects.toThrow('source file is too large');
    // The reader must stop pulling once the cap is crossed — buffering all 100
    // chunks first is exactly the memory-exhaustion bug this guards against.
    expect(pulls).toBeLessThan(10);
  });

  it('handles a bodyless response through the fallback path', async () => {
    const buffer = await readResponseBodyWithByteCap(new Response(null), 4);
    expect(buffer.byteLength).toBe(0);
  });

  it('still rejects an oversized response when no body stream is exposed', async () => {
    const response = new Response('x'.repeat(64));
    Object.defineProperty(response, 'body', { value: null });
    await expect(readResponseBodyWithByteCap(response, 16)).rejects.toThrow('source file is too large');
  });
});

describe('responseBodyWithExactByteCount', () => {
  function stream(...chunks: number[][]) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    });
  }

  it('passes through a stream whose actual size matches Content-Length', async () => {
    const response = new Response(responseBodyWithExactByteCount(stream([1, 2], [3]), 3, 10));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('restores a Workers fixed-length stream after validating Content-Length', async () => {
    const lengths: Array<number | bigint> = [];
    class TestFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
      constructor(length: number | bigint) {
        super();
        lengths.push(length);
      }
    }
    const response = new Response(responseBodyWithExactByteCount(
      stream([1, 2], [3]),
      3,
      10,
      TestFixedLengthStream,
    ));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(lengths).toEqual([3]);
  });

  it('aborts before storage can ingest bytes beyond the claimed length', async () => {
    const response = new Response(responseBodyWithExactByteCount(stream([1, 2], [3, 4]), 3, 10));
    await expect(response.arrayBuffer()).rejects.toThrow('source file size did not match Content-Length');
  });

  it('rejects a truncated response whose actual size is below the claim', async () => {
    const response = new Response(responseBodyWithExactByteCount(stream([1, 2]), 3, 10));
    await expect(response.arrayBuffer()).rejects.toThrow('source file size did not match Content-Length');
  });
});
