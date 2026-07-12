import { describe, expect, it } from 'vitest';

import type { Block, Comment, DbProperty, DbTemplate, DbView, Page } from '../../lib/app-types';
import {
  isNativeEnvelope,
  NATIVE_FORMAT,
  NATIVE_DOCUMENT_LIMITS,
  propTypeMap,
  scrubNativeStoredFileReferences,
  sanitizeNativeEntitiesForExport,
  remapNativeDocument,
  stripBlockContentFiles,
  stripFilesValue,
  validateNativeEnvelope,
  type NativeExportEnvelope,
  type NativeEntities,
} from '../../lib/native-document';

// Build an oldId -> newId map (deterministic "new-<old>" ids) for every id in
// the entity set so assertions can predict the remapped values.
function idMapFor(entities: NativeEntities): Map<string, string> {
  const map = new Map<string, string>();
  const add = (id?: string) => {
    if (id && !map.has(id)) map.set(id, `new-${id}`);
  };
  for (const page of entities.pages) add(page.id);
  for (const block of entities.blocks) add(block.id);
  for (const prop of entities.dbProperties) add(prop.id);
  for (const view of entities.dbViews) add(view.id);
  for (const template of entities.dbTemplates) add(template.id);
  for (const comment of entities.comments) add(comment.id);
  return map;
}

function empty(): NativeEntities {
  return { pages: [], blocks: [], dbProperties: [], dbViews: [], dbTemplates: [], comments: [] };
}

function validEnvelope(entities: NativeEntities): NativeExportEnvelope {
  const roots = entities.pages
    .filter((page) => page.parentType === 'workspace')
    .map((page) => page.id);
  return {
    format: NATIVE_FORMAT,
    formatVersion: 1,
    generatedAt: '2026-07-10T00:00:00.000Z',
    scope: { kind: 'workspace', rootIds: roots },
    source: { workspaceId: 'ws' },
    counts: {
      pages: entities.pages.filter((page) => page.kind === 'page').length,
      databases: entities.pages.filter((page) => page.kind === 'database').length,
      blocks: entities.blocks.length,
      dbProperties: entities.dbProperties.length,
      dbViews: entities.dbViews.length,
      dbTemplates: entities.dbTemplates.length,
      comments: entities.comments.length,
    },
    files: { included: false, strippedReferences: 0 },
    entities,
    relationPairs: [],
    warnings: [],
  };
}

function remap(entities: NativeEntities, opts?: { keepUserIds?: boolean }) {
  const idMap = idMapFor(entities);
  return remapNativeDocument(entities, idMap, {
    propTypeByOldId: propTypeMap(entities.dbProperties),
    keepUserIds: opts?.keepUserIds ?? false,
  });
}

describe('remapNativeDocument — id relinking', () => {
  // A fixture with two databases, a dual relation, a rollup, a formula, a view
  // referencing multiple prop ids, a block page-mention, and a template relation.
  function fixture(): NativeEntities {
    const dbA: Page = { id: 'dbA', workspaceId: 'ws', parentType: 'workspace', kind: 'database', title: 'A', position: 1 };
    const dbB: Page = { id: 'dbB', workspaceId: 'ws', parentType: 'workspace', kind: 'database', title: 'B', position: 2 };
    const rowB1: Page = { id: 'rowB1', workspaceId: 'ws', parentId: 'dbB', parentType: 'database', kind: 'page', title: 'b1', position: 1 };
    const rowA1: Page = {
      id: 'rowA1',
      workspaceId: 'ws',
      parentId: 'dbA',
      parentType: 'database',
      kind: 'page',
      title: 'a1',
      position: 1,
      properties: { pA_rel: ['rowB1'], pA_person: ['user1'], pA_num: 42 },
    };
    const dbProperties: DbProperty[] = [
      { id: 'pA_rel', databaseId: 'dbA', name: 'B link', type: 'relation', config: { relationDatabaseId: 'dbB' }, position: 1 },
      {
        id: 'pA_roll',
        databaseId: 'dbA',
        name: 'Count',
        type: 'rollup',
        config: { rollupRelationPropertyId: 'pA_rel', rollupTargetPropertyId: 'pB_title', rollupFunction: 'count' },
        position: 2,
      },
      { id: 'pA_f', databaseId: 'dbA', name: 'Formula', type: 'formula', config: { formula: 'prop("Name")' }, position: 3 },
      { id: 'pA_person', databaseId: 'dbA', name: 'Owner', type: 'person', config: {}, position: 4 },
      { id: 'pA_num', databaseId: 'dbA', name: 'Num', type: 'number', config: {}, position: 5 },
      { id: 'pB_rel', databaseId: 'dbB', name: 'A link', type: 'relation', config: { relationDatabaseId: 'dbA' }, position: 1 },
      { id: 'pB_title', databaseId: 'dbB', name: 'Name', type: 'title', config: {}, position: 2 },
    ];
    const view: DbView = {
      id: 'viewA',
      databaseId: 'dbA',
      name: 'Table',
      type: 'table',
      config: {
        visibleProperties: ['pA_rel', 'pA_roll'],
        propertyWidths: { pA_rel: 200 },
        filters: [{ propertyId: 'pA_rel', operator: 'is_not_empty' }],
        sorts: [{ propertyId: 'pA_roll', direction: 'asc' }],
        groupBy: 'pA_person',
      },
      position: 1,
    };
    const block: Block = {
      id: 'blk1',
      pageId: 'dbA',
      type: 'paragraph',
      position: 1,
      content: { rich: [{ text: 'see', mention: 'page', pageId: 'rowB1' }], childPageId: 'dbB' },
    };
    const template: DbTemplate = {
      id: 'tplA',
      databaseId: 'dbA',
      name: 'Default',
      title: 'New',
      properties: { pA_rel: ['rowB1'] },
      blocks: [{ type: 'paragraph', content: { rich: [{ text: 'x', mention: 'page', pageId: 'rowB1' }] } }],
      position: 1,
    };
    return { pages: [dbA, dbB, rowB1, rowA1], blocks: [block], dbProperties, dbViews: [view], dbTemplates: [template], comments: [] };
  }

  it('remaps relation row values to the new target ids', () => {
    const { pages } = remap(fixture());
    const rowA1 = pages.find((page) => page.id === 'new-rowA1');
    expect(rowA1?.properties?.['new-pA_rel']).toEqual(['new-rowB1']);
    expect(rowA1?.properties?.['new-pA_num']).toBe(42); // non-relation values untouched
  });

  it('remaps rollup config property references but leaves formula expressions intact', () => {
    const { dbProperties } = remap(fixture());
    const rollup = dbProperties.find((prop) => prop.id === 'new-pA_roll');
    expect(rollup?.config?.rollupRelationPropertyId).toBe('new-pA_rel');
    expect(rollup?.config?.rollupTargetPropertyId).toBe('new-pB_title');
    expect(rollup?.config?.rollupFunction).toBe('count');
    const relation = dbProperties.find((prop) => prop.id === 'new-pA_rel');
    expect(relation?.config?.relationDatabaseId).toBe('new-dbB');
    const formula = dbProperties.find((prop) => prop.id === 'new-pA_f');
    expect(formula?.config?.formula).toBe('prop("Name")'); // name-based, no id remap
  });

  it('remaps every property-id reference inside a view config', () => {
    const { dbViews } = remap(fixture());
    const config = dbViews[0].config as Record<string, unknown>;
    expect(config.visibleProperties).toEqual(['new-pA_rel', 'new-pA_roll']);
    expect(config.propertyWidths).toEqual({ 'new-pA_rel': 200 });
    expect((config.filters as Array<{ propertyId: string }>)[0].propertyId).toBe('new-pA_rel');
    expect((config.sorts as Array<{ propertyId: string }>)[0].propertyId).toBe('new-pA_roll');
    expect(config.groupBy).toBe('new-pA_person');
  });

  it('remaps block page mentions, childPageId, and template relations', () => {
    const { blocks, dbTemplates } = remap(fixture());
    const content = blocks[0].content as Record<string, unknown>;
    expect((content.rich as Array<{ pageId: string }>)[0].pageId).toBe('new-rowB1');
    expect(content.childPageId).toBe('new-dbB');
    expect(dbTemplates[0].properties?.['new-pA_rel']).toEqual(['new-rowB1']);
    const tplBlocks = dbTemplates[0].blocks as Array<{ content: { rich: Array<{ pageId: string }> } }>;
    expect(tplBlocks[0].content.rich[0].pageId).toBe('new-rowB1');
  });

  it('re-parents pages under mapped parents; roots become null for the caller', () => {
    const { pages } = remap(fixture());
    expect(pages.find((page) => page.id === 'new-dbA')?.parentId).toBeNull(); // workspace root
    expect(pages.find((page) => page.id === 'new-rowA1')?.parentId).toBe('new-dbA'); // row under its db
  });

  it('drops person values by default and records a warning', () => {
    const result = remap(fixture());
    const rowA1 = result.pages.find((page) => page.id === 'new-rowA1');
    expect(rowA1?.properties && 'new-pA_person' in rowA1.properties).toBe(false);
    expect(result.warnings.some((w) => w.code === 'dropped_person')).toBe(true);
  });

  it('keeps person values when keepUserIds is set', () => {
    const result = remap(fixture(), { keepUserIds: true });
    const rowA1 = result.pages.find((page) => page.id === 'new-rowA1');
    expect(rowA1?.properties?.['new-pA_person']).toEqual(['user1']);
  });

  it('drops relation targets outside the exported set with a warning', () => {
    const entities = empty();
    entities.dbProperties = [
      { id: 'p1', databaseId: 'db1', name: 'rel', type: 'relation', config: { relationDatabaseId: 'db2' }, position: 1 },
    ];
    entities.pages = [
      { id: 'db1', workspaceId: 'ws', parentType: 'workspace', kind: 'database', title: 'x', position: 1 },
      {
        id: 'r1',
        workspaceId: 'ws',
        parentId: 'db1',
        parentType: 'database',
        kind: 'page',
        title: 'r1',
        position: 1,
        properties: { p1: ['outsider', 'db1'] }, // 'outsider' is not in the export
      },
    ];
    const result = remap(entities);
    const row = result.pages.find((page) => page.id === 'new-r1');
    expect(row?.properties?.['new-p1']).toEqual(['new-db1']); // only the in-scope id survives
    expect(result.warnings.some((w) => w.code === 'dropped_relation_target')).toBe(true);
  });

  it('drops blocks whose page is not in the export', () => {
    const entities = empty();
    entities.pages = [{ id: 'p1', workspaceId: 'ws', parentType: 'workspace', kind: 'page', title: 'p', position: 1 }];
    entities.blocks = [
      { id: 'b1', pageId: 'p1', type: 'paragraph', position: 1 },
      { id: 'b2', pageId: 'ghost', type: 'paragraph', position: 2 },
    ];
    const result = remap(entities);
    expect(result.blocks.map((block) => block.id)).toEqual(['new-b1']);
    expect(result.warnings.some((w) => w.code === 'dropped_block')).toBe(true);
  });

  it('remaps comment page/block/thread references', () => {
    const entities = empty();
    entities.pages = [{ id: 'p1', workspaceId: 'ws', parentType: 'workspace', kind: 'page', title: 'p', position: 1 }];
    entities.blocks = [{ id: 'b1', pageId: 'p1', type: 'paragraph', position: 1 }];
    const comment: Comment = { id: 'c1', pageId: 'p1', blockId: 'b1', authorId: 'user1', body: { text: 'hi' } };
    entities.comments = [comment];
    const result = remap(entities);
    expect(result.comments[0]).toMatchObject({ id: 'new-c1', pageId: 'new-p1', blockId: 'new-b1' });
  });
});

describe('file stripping (export side)', () => {
  it('converts a files value into name-only placeholders', () => {
    const result = stripFilesValue([
      { id: 'f1', name: 'report.pdf', url: 'https://x/report.pdf', uploadId: 'u1' },
      { name: 'photo.png', url: '/api/storage/files/photo.png' },
    ]);
    expect(result.stripped).toBe(2);
    expect(result.value).toEqual([
      { name: 'report.pdf', strippedFile: true },
      { name: 'photo.png', strippedFile: true },
    ]);
  });

  it('strips a media block URL but keeps its caption', () => {
    const result = stripBlockContentFiles('image', {
      url: 'https://x/pic.png',
      caption: [{ text: 'a caption' }],
    });
    expect(result.stripped).toBe(1);
    expect(result.content).toEqual({ caption: [{ text: 'a caption' }], strippedFile: true });
  });

  it('leaves non-media blocks untouched', () => {
    const content = { rich: [{ text: 'hello' }] };
    const result = stripBlockContentFiles('paragraph', content);
    expect(result.stripped).toBe(0);
    expect(result.content).toBe(content);
  });

  it('strips file references recursively from button/template children', () => {
    const result = stripBlockContentFiles('button', {
      buttonTemplate: [
        {
          type: 'paragraph',
          content: { rich: [{ text: 'Nested' }] },
          children: [{ type: 'file', content: { name: 'secret.pdf', url: 'https://files.example/secret?token=x' } }],
        },
      ],
    });
    expect(result.stripped).toBe(1);
    expect(JSON.stringify(result.content)).not.toContain('files.example');
    expect(JSON.stringify(result.content)).not.toContain('token=x');
    expect(result.content).toMatchObject({
      buttonTemplate: [{ children: [{ content: { name: 'secret.pdf', strippedFile: true } }] }],
    });
  });

  it('scrubs local storage locators independently of property or block schema', () => {
    const result = scrubNativeStoredFileReferences({
      hiddenAfterTypeChange: [{
        name: 'private.pdf',
        url: '/api/storage/files/workspaces/ws/private.pdf',
        uploadId: 'upload-private',
      }],
      paragraphPayload: {
        nested: {
          href: 'https://hanji.example/api/storage/files/workspaces/ws/secret.png',
          storageKey: 'workspaces/ws/secret.png',
        },
      },
      ordinaryUrl: 'https://customer.example/public',
    });

    const serialized = JSON.stringify(result.value);
    expect(result.stripped).toBeGreaterThan(0);
    expect(serialized).not.toContain('/api/storage/');
    expect(serialized).not.toContain('workspaces/ws/');
    expect(serialized).not.toContain('upload-private');
    expect(serialized).toContain('https://customer.example/public');
  });
});

describe('native export security boundary', () => {
  it('applies the schema-independent storage scrub to hidden row and non-media block payloads', () => {
    const entities = empty();
    entities.pages = [
      { id: 'db1', workspaceId: 'ws', parentType: 'workspace', kind: 'database', title: 'DB', position: 0 },
      {
        id: 'row1', workspaceId: 'ws', parentType: 'database', parentId: 'db1', kind: 'page', title: 'Row', position: 0,
        properties: {
          changedType: [{
            name: 'hidden.pdf',
            url: '/api/storage/files/workspaces/ws/hidden.pdf',
            uploadId: 'upload-hidden',
          }],
        },
      },
    ];
    entities.dbProperties = [
      { id: 'changedType', databaseId: 'db1', name: 'Now text', type: 'text', position: 0 },
    ];
    entities.blocks = [{
      id: 'block1', pageId: 'row1', type: 'paragraph', position: 0,
      content: {
        nested: {
          src: 'https://hanji.example/api/storage/files/workspaces/ws/nested.png',
          fileUploadId: 'upload-nested',
        },
      },
    }];

    const result = sanitizeNativeEntitiesForExport(entities);
    const serialized = JSON.stringify(result.entities);
    expect(serialized).not.toContain('/api/storage/');
    expect(serialized).not.toContain('workspaces/ws/');
    expect(serialized).not.toContain('upload-hidden');
    expect(serialized).not.toContain('upload-nested');
    expect(result.strippedReferences).toBeGreaterThanOrEqual(2);
    expect(result.warnings.some((warning) => warning.code === 'stripped_file')).toBe(true);
  });

  it('recursively redacts source metadata and actor/person identity while preserving authored URL/email values', () => {
    const entities = empty();
    entities.pages = [
      {
        id: 'db1', workspaceId: 'ws', parentType: 'workspace', kind: 'database', title: 'DB', position: 0,
        createdBy: 'source-user', lastEditedBy: 'source-user',
      },
      {
        id: 'row1', workspaceId: 'ws', parentType: 'database', parentId: 'db1', kind: 'page', title: 'Row', position: 0,
        properties: {
          pFiles: [{ name: 'report.pdf', url: 'https://signed.example/report?X-Amz-Signature=secret' }],
          pPerson: ['notion-user-1'],
          pEmail: 'customer@example.com',
          pUrl: 'https://customer.example/path?keep=yes',
          __notion: {
            access_token: 'ntn_secret',
            files: [{ url: 'https://notion-signed.example/file?token=secret' }],
            created_by: { object: 'user', id: 'notion-user-1', name: 'Source Person', person: { email: 'source@example.com' } },
          },
        },
      },
    ];
    entities.dbProperties = [
      { id: 'pFiles', databaseId: 'db1', name: 'Files', type: 'files', position: 0 },
      { id: 'pPerson', databaseId: 'db1', name: 'Person', type: 'person', position: 1 },
      { id: 'pEmail', databaseId: 'db1', name: 'Email', type: 'email', position: 2 },
      { id: 'pUrl', databaseId: 'db1', name: 'URL', type: 'url', position: 3 },
    ];
    entities.dbViews = [{
      id: 'view1', databaseId: 'db1', name: 'View', type: 'table', position: 0,
      config: {
        notion: {
          id: 'source-view-id',
          url: 'https://notion.so/view?token=view-secret',
          owner: { object: 'user', id: 'owner-1', person: { email: 'owner@example.com' } },
          nested: { refreshToken: 'refresh-secret', signedUrl: 'https://signed.example/raw?token=secret' },
        },
      },
    }];
    entities.blocks = [{
      id: 'block1', pageId: 'row1', type: 'paragraph', position: 0, createdBy: 'source-user',
      content: {
        rich: [{ text: 'Hello', mention: 'person', userId: 'source-user' }],
        notion: { href: 'https://notion.so/private?signature=secret', email: 'block@example.com' },
      },
    }];
    entities.comments = [{
      id: 'comment1', pageId: 'row1', authorId: 'source-user',
      body: { rich: [{ text: 'Keep authored link', link: 'https://comment.example/path' }] },
    }];

    const result = sanitizeNativeEntitiesForExport(entities);
    const row = result.entities.pages.find((page) => page.id === 'row1');
    expect(row?.properties?.pEmail).toBe('customer@example.com');
    expect(row?.properties?.pUrl).toBe('https://customer.example/path?keep=yes');
    expect(row?.properties?.pFiles).toEqual([{ name: 'report.pdf', strippedFile: true }]);
    expect(row?.properties && 'pPerson' in row.properties).toBe(false);
    expect(row?.properties && '__notion' in row.properties).toBe(false);
    expect(result.entities.comments[0].authorId).toBe('');
    expect((result.entities.comments[0].body as { rich: Array<{ link: string }> }).rich[0].link)
      .toBe('https://comment.example/path');

    const serialized = JSON.stringify(result.entities);
    expect(serialized).not.toContain('ntn_secret');
    expect(serialized).not.toContain('refresh-secret');
    expect(serialized).not.toContain('source@example.com');
    expect(serialized).not.toContain('owner@example.com');
    expect(serialized).not.toContain('notion-signed.example');
    expect(serialized).not.toContain('notion-user-1');
    expect(serialized).not.toContain('source-user');
    expect(result.warnings.some((warning) => warning.code === 'redacted_sensitive_metadata')).toBe(true);
  });

  it('drops unmapped cross-instance ids instead of preserving ids that could collide at the destination', () => {
    const entities = empty();
    entities.pages = [{ id: 'db1', workspaceId: 'ws', parentType: 'workspace', kind: 'database', title: 'DB', position: 0 }];
    entities.dbProperties = [{
      id: 'relation1', databaseId: 'db1', name: 'External', type: 'relation', position: 0,
      config: { relationDatabaseId: 'victim-db' },
    }];
    entities.dbViews = [{
      id: 'view1', databaseId: 'db1', name: 'View', type: 'table', position: 0,
      config: { visibleProperties: ['relation1', 'victim-property'] },
    }];
    entities.blocks = [{
      id: 'block1', pageId: 'db1', type: 'paragraph', position: 0,
      content: { childPageId: 'victim-page', rich: [{ text: 'Person', userId: 'victim-user' }] },
    }];

    const result = remap(entities);
    expect(result.dbProperties[0].config).not.toHaveProperty('relationDatabaseId');
    expect(result.dbViews[0].config?.visibleProperties).toEqual(['new-relation1']);
    expect(result.blocks[0].content).not.toHaveProperty('childPageId');
    expect((result.blocks[0].content?.rich as Array<Record<string, unknown>>)[0]).not.toHaveProperty('userId');
  });
});

describe('validateNativeEnvelope', () => {
  it('accepts a closed, well-formed document', () => {
    const entities = empty();
    entities.pages = [{ id: 'db1', workspaceId: 'ws', parentType: 'workspace', kind: 'database', title: 'DB', position: 0 }];
    entities.dbProperties = [{ id: 'title1', databaseId: 'db1', name: 'Name', type: 'title', position: 0 }];
    expect(validateNativeEnvelope(validEnvelope(entities))).toMatchObject({ format: NATIVE_FORMAT });
  });

  it('normalizes the former native format to the canonical Hanji format on import', () => {
    const entities = empty();
    entities.pages = [{ id: 'page1', workspaceId: 'ws', parentType: 'workspace', kind: 'page', title: 'Page', position: 0 }];
    const legacyFormat = ['ink', 'line.export'].join('');
    expect(validateNativeEnvelope({
      ...validEnvelope(entities),
      format: legacyFormat,
    })).toMatchObject({ format: NATIVE_FORMAT });
  });

  it('rejects a database schema entity whose database is outside the document', () => {
    const entities = empty();
    entities.pages = [{ id: 'page1', workspaceId: 'ws', parentType: 'workspace', kind: 'page', title: 'Page', position: 0 }];
    entities.dbProperties = [{ id: 'attack-prop', databaseId: 'victim-db', name: 'Injected', type: 'text', position: 0 }];
    expect(() => validateNativeEnvelope(validEnvelope(entities)))
      .toThrow('entities.dbProperties[0].databaseId must reference a database in this export');
  });

  it('rejects duplicate ids across entity tables because the remap uses one global id map', () => {
    const entities = empty();
    entities.pages = [{ id: 'same', workspaceId: 'ws', parentType: 'workspace', kind: 'page', title: 'Page', position: 0 }];
    entities.blocks = [{ id: 'same', pageId: 'same', type: 'paragraph', position: 0 }];
    expect(() => validateNativeEnvelope(validEnvelope(entities))).toThrow('duplicates id same');
  });

  it('enforces UTF-8 payload and entity-count limits before remapping or writes', () => {
    const entities = empty();
    entities.pages = [{ id: 'p1', workspaceId: 'ws', parentType: 'workspace', kind: 'page', title: 'Page', position: 0 }];
    const document = validEnvelope(entities);
    document.source.workspaceName = '한'.repeat(200);
    expect(() => validateNativeEnvelope(document, { ...NATIVE_DOCUMENT_LIMITS, maxBytes: 200 }))
      .toThrow('payload is too large');
    const tooManyPages = validEnvelope(entities);
    tooManyPages.scope.rootIds = [];
    expect(() => validateNativeEnvelope(tooManyPages, { ...NATIVE_DOCUMENT_LIMITS, maxPages: 0 }))
      .toThrow('entities.pages must have at most 0 items');

    const tooManyCombinedEntities = validEnvelope(entities);
    tooManyCombinedEntities.entities.blocks = [
      { id: 'b1', pageId: 'p1', type: 'paragraph', position: 0 },
    ];
    expect(() => validateNativeEnvelope(tooManyCombinedEntities, {
      ...NATIVE_DOCUMENT_LIMITS,
      maxEntities: 1,
    })).toThrow('entities must contain at most 1 total items');
  });
});

describe('isNativeEnvelope', () => {
  it('accepts a well-formed envelope and rejects other JSON', () => {
    expect(isNativeEnvelope({ format: NATIVE_FORMAT, entities: { pages: [] } })).toBe(true);
    expect(isNativeEnvelope({ format: ['ink', 'line.export'].join(''), entities: { pages: [] } })).toBe(true);
    expect(isNativeEnvelope({ format: 'other', entities: { pages: [] } })).toBe(false);
    expect(isNativeEnvelope({ tables: {} })).toBe(false); // an instance snapshot, not a native export
    expect(isNativeEnvelope(null)).toBe(false);
  });
});
