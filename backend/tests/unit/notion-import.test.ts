import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeDb as makeFakeDb, type Row } from './helpers/fake-db';
import {
  buildImportPlan,
  dashedUuid,
  expandSnapshotItems,
  inferredNotionPropertyFromRowValue,
  discoveryProgressPercent,
  importedPageShouldUseFullWidth,
  isLiveImportJob,
  missingRequestedRootIds,
  pruneStaleImportJobs,
  notionAccessibleRootCandidates,
  notionConnectionStorageAvailable,
  normalizedNotionId,
  notionRichTextSpans,
  notionTitle,
  parseSnapshotItems,
  relationTargetIds,
  relationTargetReferences,
  remapFormulaExpressionPropertyReferences,
  remapImportedRichTextMentionSpans,
  remapImportedRowRelationProperties,
  remapImportedViewRelationFilterConfig,
  remappedViewFilterGroup,
  remappedViewFilterList,
  remappedViewPropertySettings,
  remappedViewSorts,
  type DbProperty,
  type DiscoveredNotionItem,
  type ImportedPropertyContext,
  type NotionImportItem,
  type NotionImportJob,
  type NotionImportMapping,
  type Page,
} from '../../functions/notion-import';

const NOTION_PAGE_A = '11111111-2222-3333-4444-555555555555';
const NOTION_PAGE_B = '66666666-7777-8888-9999-aaaaaaaaaaaa';

function importMapping(
  notionId: string,
  localId: string,
  localType = 'page',
): NotionImportMapping {
  return {
    id: `mapping-${notionId}`,
    workspaceId: 'ws1',
    jobId: 'job1',
    notionId,
    notionType: 'page',
    localId,
    localType,
    relationKind: 'item',
  };
}

function mappingsByNotionId(...entries: NotionImportMapping[]) {
  return new Map(entries.map((entry) => [entry.notionId, entry]));
}

function dbProp(id: string, type: string, extra: Partial<DbProperty> = {}): DbProperty {
  return { id, databaseId: 'db1', name: id, type, position: 0, ...extra };
}

function collector() {
  return { unresolved: [] as { source: string; property: string }[], seen: new Set<string>() };
}

function importItem(
  notionId: string,
  notionObject: string,
  extra: Partial<NotionImportItem> = {},
): NotionImportItem {
  return {
    id: `item-${notionId}`,
    workspaceId: 'ws1',
    jobId: 'job1',
    notionId,
    notionObject,
    status: 'discovered',
    phase: 'discover',
    ...extra,
  };
}

function readyJob(extra: Partial<NotionImportJob> = {}): NotionImportJob {
  return {
    id: 'job1',
    workspaceId: 'ws1',
    source: 'notion_api',
    connectionKind: 'personal_access_token',
    status: 'ready',
    phase: 'review',
    apiVersion: '2026-03-11',
    ...extra,
  };
}

describe('notionConnectionStorageAvailable', () => {
  // envString falls back to process.env, so clear the secrets for hermetic runs.
  const savedSecret = process.env.NOTIONLIKE_NOTION_IMPORT_SECRET;
  const savedLegacySecret = process.env.NOTION_IMPORT_SECRET;

  beforeEach(() => {
    delete process.env.NOTIONLIKE_NOTION_IMPORT_SECRET;
    delete process.env.NOTION_IMPORT_SECRET;
  });

  afterAll(() => {
    if (savedSecret !== undefined) process.env.NOTIONLIKE_NOTION_IMPORT_SECRET = savedSecret;
    if (savedLegacySecret !== undefined) process.env.NOTION_IMPORT_SECRET = savedLegacySecret;
  });

  it('is true when NOTIONLIKE_NOTION_IMPORT_SECRET is set', () => {
    expect(notionConnectionStorageAvailable({ NOTIONLIKE_NOTION_IMPORT_SECRET: 'secret' })).toBe(true);
  });

  it('accepts the legacy NOTION_IMPORT_SECRET name', () => {
    expect(notionConnectionStorageAvailable({ NOTION_IMPORT_SECRET: 'legacy-secret' })).toBe(true);
  });

  it('is false without a secret or with a blank secret', () => {
    expect(notionConnectionStorageAvailable({})).toBe(false);
    expect(notionConnectionStorageAvailable(undefined)).toBe(false);
    expect(notionConnectionStorageAvailable({ NOTIONLIKE_NOTION_IMPORT_SECRET: '   ' })).toBe(false);
  });
});

describe('notion id normalization', () => {
  it('normalizedNotionId strips dashes, trims, and lowercases', () => {
    expect(normalizedNotionId(' 1111AAAA-BBBB-CCCC-DDDD-eeee2222ffff ')).toBe(
      '1111aaaabbbbccccddddeeee2222ffff',
    );
  });

  it('normalizedNotionId returns empty string for non-strings', () => {
    expect(normalizedNotionId(undefined)).toBe('');
    expect(normalizedNotionId(42)).toBe('');
    expect(normalizedNotionId({ id: 'x' })).toBe('');
  });

  it('dashedUuid converts a compact 32-hex id into dashed uuid form', () => {
    expect(dashedUuid('112233445566778899aabbccddeeff00')).toBe(
      '11223344-5566-7788-99aa-bbccddeeff00',
    );
  });

  it('dashedUuid normalizes an already dashed uppercase uuid', () => {
    expect(dashedUuid('11223344-5566-7788-99AA-BBCCDDEEFF00')).toBe(
      '11223344-5566-7788-99aa-bbccddeeff00',
    );
  });

  it('dashedUuid leaves non-uuid values as trimmed strings', () => {
    expect(dashedUuid('  not-a-uuid  ')).toBe('not-a-uuid');
  });
});

describe('missingRequestedRootIds', () => {
  const items: DiscoveredNotionItem[] = [
    { notionId: NOTION_PAGE_A, notionObject: 'page' },
  ];

  it('returns nothing when no roots were requested', () => {
    expect(missingRequestedRootIds([], items)).toEqual([]);
  });

  it('matches requested ids across dashed/compact and case variants', () => {
    const compactUpper = NOTION_PAGE_A.replace(/-/g, '').toUpperCase();
    expect(missingRequestedRootIds([compactUpper], items)).toEqual([]);
  });

  it('reports unmatched roots and skips blank requested ids', () => {
    expect(missingRequestedRootIds([NOTION_PAGE_B, '  '], items)).toEqual([NOTION_PAGE_B]);
  });
});

describe('parseSnapshotItems', () => {
  it('returns an empty list for non-array payloads', () => {
    expect(parseSnapshotItems(undefined)).toEqual([]);
    expect(parseSnapshotItems({ notionId: 'x' })).toEqual([]);
  });

  it('accepts id/object aliases and applies snapshot defaults', () => {
    const items = parseSnapshotItems([
      { id: 'n1', object: 'page', title: 'Doc', metadata: { url: 'https://x' } },
    ]);
    expect(items).toEqual([
      {
        notionId: 'n1',
        notionObject: 'page',
        parentNotionId: undefined,
        title: 'Doc',
        status: 'discovered',
        phase: 'snapshot',
        metadata: { url: 'https://x' },
        error: undefined,
      },
    ]);
  });

  it('drops malformed entries but keeps valid siblings', () => {
    const items = parseSnapshotItems([
      null,
      'nope',
      { object: 'page' },
      { id: 'n2' },
      { notionId: 'n3', notionObject: 'data_source', status: 'enriched', phase: 'discover' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      notionId: 'n3',
      notionObject: 'data_source',
      status: 'enriched',
      phase: 'discover',
      metadata: {},
    });
  });
});

describe('expandSnapshotItems', () => {
  const dataSource: DiscoveredNotionItem = {
    notionId: 'ds-1',
    notionObject: 'data_source',
    status: 'discovered',
    phase: 'snapshot',
    metadata: {
      dataSourceSnapshot: {
        rowReferences: [
          {
            id: 'row-1',
            title: 'Row one',
            created_time: '2024-01-02T00:00:00.000Z',
            properties: { Name: { type: 'title' } },
          },
          { title: 'row without id is skipped' },
        ],
        views: [{ id: 'view-1', name: 'All', type: 'table' }, 'not-a-view'],
      },
    },
  };

  it('expands data source row references into referenced page items', () => {
    const expanded = expandSnapshotItems([dataSource]);
    const row = expanded.find((item) => item.notionId === 'row-1');
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      notionObject: 'page',
      parentNotionId: 'ds-1',
      title: 'Row one',
      status: 'referenced',
      phase: 'data_source_row_reference',
    });
    expect(row?.metadata).toMatchObject({
      dataSourceId: 'ds-1',
      notionQueryOrder: 0,
      createdTime: '2024-01-02T00:00:00.000Z',
      properties: { Name: { type: 'title' } },
    });
    // The id-less row reference must not create a phantom item.
    expect(expanded).toHaveLength(3);
  });

  it('expands snapshot views into view items', () => {
    const expanded = expandSnapshotItems([dataSource]);
    const view = expanded.find((item) => item.notionId === 'view-1');
    expect(view).toMatchObject({
      notionObject: 'view',
      parentNotionId: 'ds-1',
      title: 'All',
      phase: 'view_snapshot',
    });
    expect(view?.metadata).toMatchObject({ dataSourceId: 'ds-1', view: { id: 'view-1' } });
  });

  it('does not downgrade an already discovered item to referenced and merges metadata', () => {
    const discoveredRow: DiscoveredNotionItem = {
      notionId: 'row-1',
      notionObject: 'page',
      title: 'Row one (full)',
      status: 'discovered',
      phase: 'discover',
      metadata: { pageSnapshot: { childBlocks: [] } },
    };
    const expanded = expandSnapshotItems([discoveredRow, dataSource]);
    const row = expanded.find((item) => item.notionId === 'row-1');
    expect(row?.status).toBe('discovered');
    expect(row?.metadata).toMatchObject({
      pageSnapshot: { childBlocks: [] },
      dataSourceId: 'ds-1',
    });
  });
});

describe('importedPageShouldUseFullWidth', () => {
  const dashboardPage = importItem('page-dashboard', 'page', {
    metadata: {
      pageSnapshot: {
        childBlocks: [{ type: 'heading_1' }, { type: 'column_list' }],
      },
    },
  });
  const normalPage = importItem('page-normal', 'page', {
    metadata: {
      pageSnapshot: {
        childBlocks: [{ type: 'paragraph' }],
      },
    },
  });

  it('keeps the legacy column_list inference when no import option is provided', () => {
    expect(importedPageShouldUseFullWidth(dashboardPage)).toBe(true);
    expect(importedPageShouldUseFullWidth(normalPage)).toBe(false);
  });

  it('lets the import option force regular imported pages wide or narrow', () => {
    expect(importedPageShouldUseFullWidth(normalPage, true)).toBe(true);
    expect(importedPageShouldUseFullWidth(dashboardPage, false)).toBe(false);
  });
});

describe('notionRichTextSpans', () => {
  it('converts annotations, colors, and links', () => {
    const spans = notionRichTextSpans([
      {
        plain_text: 'bold',
        annotations: { bold: true, italic: true, code: true, color: 'red' },
        href: 'https://example.com',
      },
      { plain_text: 'plain', annotations: { color: 'default' } },
    ]);
    expect(spans).toEqual([
      {
        text: 'bold',
        bold: true,
        italic: true,
        code: true,
        color: 'red',
        link: 'https://example.com',
      },
      { text: 'plain' },
    ]);
  });

  it('falls back to text.content and equation.expression for text', () => {
    const spans = notionRichTextSpans([
      { text: { content: 'from content' } },
      { equation: { expression: 'a^2' } },
    ]);
    expect(spans.map((span) => span.text)).toEqual(['from content', 'a^2']);
  });

  it('drops empty and malformed parts and non-array input', () => {
    expect(notionRichTextSpans(undefined)).toEqual([]);
    expect(notionRichTextSpans([null, 'raw', { plain_text: '' }, { plain_text: 'ok' }])).toEqual([
      { text: 'ok' },
    ]);
  });

  it('converts user and date mentions to local mention spans', () => {
    const spans = notionRichTextSpans([
      {
        plain_text: '@June',
        mention: { type: 'user', user: { id: 'user-1', name: 'June' } },
      },
      {
        plain_text: 'Jan 1',
        mention: { type: 'date', date: { start: '2024-01-01' } },
      },
    ]);
    expect(spans[0]).toMatchObject({ text: '@June', mention: 'person' });
    expect(spans[0].userId).toBeTruthy();
    expect(spans[1]).toMatchObject({ text: 'Jan 1', mention: 'date', date: '2024-01-01' });
  });

  it('keeps notion target ids for page/database/data_source mentions for later remapping', () => {
    const spans = notionRichTextSpans([
      { plain_text: 'Page', mention: { type: 'page', page: { id: 'np-1' } } },
      { plain_text: 'DB', mention: { type: 'database', database: { id: 'nd-1' } } },
      { plain_text: 'DS', mention: { type: 'data_source', data_source: { id: 'ns-1' } } },
    ]);
    expect(spans[0].notionPageId).toBe('np-1');
    expect(spans[1].notionDatabaseId).toBe('nd-1');
    expect(spans[2].notionDataSourceId).toBe('ns-1');
    expect(spans[0].notionMention).toEqual({ type: 'page', page: { id: 'np-1' } });
  });
});

describe('notionTitle', () => {
  it('reads the direct rich-text title', () => {
    expect(notionTitle({ title: [{ plain_text: 'Direct' }] })).toBe('Direct');
  });

  it('falls back to the title-typed property', () => {
    expect(
      notionTitle({
        properties: {
          Name: { type: 'title', title: [{ plain_text: 'From property' }] },
          Status: { type: 'select' },
        },
      }),
    ).toBe('From property');
  });

  it('falls back to name and then Untitled', () => {
    expect(notionTitle({ name: '  Data source name  ' })).toBe('Data source name');
    expect(notionTitle({})).toBe('Untitled');
  });
});

describe('notionAccessibleRootCandidates', () => {
  it('keeps workspace-parent records and direct shares whose parent is not accessible', () => {
    const roots = notionAccessibleRootCandidates([
      {
        object: 'page',
        id: 'root-page',
        title: [{ plain_text: 'Root page' }],
        parent: { type: 'workspace', workspace: true },
        last_edited_time: '2026-07-07T10:00:00.000Z',
      },
      {
        object: 'page',
        id: 'child-page',
        title: [{ plain_text: 'Child page' }],
        parent: { type: 'page_id', page_id: 'root-page' },
        last_edited_time: '2026-07-07T11:00:00.000Z',
      },
      {
        object: 'data_source',
        id: 'shared-data-source',
        title: [{ plain_text: 'Shared database' }],
        parent: { type: 'page_id', page_id: 'missing-parent' },
        last_edited_time: '2026-07-07T09:00:00.000Z',
      },
      {
        object: 'page',
        id: 'trashed-page',
        title: [{ plain_text: 'Trashed' }],
        parent: { type: 'workspace', workspace: true },
        in_trash: true,
      },
    ]);

    expect(roots).toEqual([
      expect.objectContaining({
        id: 'root-page',
        notionObject: 'page',
        title: 'Root page',
        reason: 'workspace_parent',
      }),
      expect.objectContaining({
        id: 'shared-data-source',
        notionObject: 'data_source',
        title: 'Shared database',
        parentNotionId: 'missing-parent',
        reason: 'accessible_parent_missing',
      }),
    ]);
  });

  it('dedupes ids across dashed and compact variants', () => {
    const roots = notionAccessibleRootCandidates([
      {
        object: 'page',
        id: '11111111-2222-3333-4444-555555555555',
        title: [{ plain_text: 'First' }],
        parent: { type: 'workspace', workspace: true },
      },
      {
        object: 'page',
        id: '11111111222233334444555555555555',
        title: [{ plain_text: 'Duplicate' }],
        parent: { type: 'workspace', workspace: true },
      },
    ]);

    expect(roots).toHaveLength(1);
    expect(roots[0].title).toBe('First');
  });
});

describe('relation target extraction', () => {
  it('relationTargetIds collects relation values, config targets, and rollup references', () => {
    const ids = relationTargetIds({
      Related: {
        type: 'relation',
        relation: [{ id: 'target-1' }, { id: 'target-1' }, { bad: true }],
      },
      Linked: { type: 'relation', relation: { data_source_id: 'ds-9' } },
      Roll: {
        type: 'rollup',
        rollup: { relation_property_id: 'rel-prop', rollup_property_id: 'roll-prop' },
      },
    });
    expect(ids).toEqual(expect.arrayContaining(['target-1', 'ds-9', 'rel-prop', 'roll-prop']));
    expect(ids.filter((id) => id === 'target-1')).toHaveLength(1);
  });

  it('relationTargetIds returns empty for non-object payloads', () => {
    expect(relationTargetIds(undefined)).toEqual([]);
    expect(relationTargetIds('nope')).toEqual([]);
  });

  it('relationTargetReferences prefers data_source over database and dedups', () => {
    const refs = relationTargetReferences({
      A: { type: 'relation', relation: { data_source_id: 'ds-1', database_id: 'db-1' } },
      B: { type: 'relation', relation: { database_id: 'db-2' } },
      C: { type: 'relation', relation: { database_id: 'db-2' } },
      NotRelation: { type: 'rollup', rollup: { database_id: 'db-3' } },
    });
    expect(refs).toEqual([
      { id: 'ds-1', notionObject: 'data_source' },
      { id: 'db-2', notionObject: 'database' },
    ]);
  });
});

describe('inferredNotionPropertyFromRowValue', () => {
  it('infers a select property with its option from a row value', () => {
    const property = inferredNotionPropertyFromRowValue('Status', {
      id: 'st',
      type: 'select',
      select: { id: 'opt-1', name: 'Done', color: 'green' },
    });
    expect(property).toMatchObject({
      id: 'st',
      name: 'Status',
      type: 'select',
      inferredFromRowPropertySnapshot: true,
      select: { options: [{ id: 'opt-1', name: 'Done' }] },
    });
  });

  it('dedups multi_select options by id or name', () => {
    const property = inferredNotionPropertyFromRowValue('Tags', {
      id: 'tg',
      type: 'multi_select',
      multi_select: [
        { id: 'a', name: 'Alpha' },
        { id: 'a', name: 'Alpha again' },
        { name: 'Beta' },
      ],
    });
    const config = property?.multi_select as { options: Array<Record<string, unknown>> };
    expect(config.options).toHaveLength(2);
    expect(config.options[1]).toMatchObject({ id: 'Beta', name: 'Beta' });
  });

  it('returns undefined for malformed row values', () => {
    expect(inferredNotionPropertyFromRowValue('X', undefined)).toBeUndefined();
    expect(inferredNotionPropertyFromRowValue('X', 'text')).toBeUndefined();
    expect(inferredNotionPropertyFromRowValue('X', { id: 'no-type' })).toBeUndefined();
  });

  it('infers non-select types with an empty option config', () => {
    const property = inferredNotionPropertyFromRowValue('Notes', { id: 'nt', type: 'rich_text' });
    expect(property).toMatchObject({ id: 'nt', name: 'Notes', type: 'rich_text', rich_text: {} });
  });
});

describe('remappedViewSorts', () => {
  const propertyMappings = new Map([
    ['Name', 'local-name'],
    ['prop-2', 'local-2'],
  ]);

  it('remaps property references and normalizes directions', () => {
    const sorts = remappedViewSorts(propertyMappings, [
      { property: 'Name', direction: 'descending' },
      { property_id: 'prop-2', direction: 'ascending' },
    ]);
    expect(sorts).toEqual([
      { propertyId: 'local-name', direction: 'desc' },
      { propertyId: 'local-2', direction: 'asc' },
    ]);
  });

  it('drops unmapped properties and records them as unresolved', () => {
    const seen = collector();
    const sorts = remappedViewSorts(
      propertyMappings,
      [{ property: 'Ghost', direction: 'desc' }, { property: 'Name' }],
      seen,
    );
    expect(sorts).toEqual([{ propertyId: 'local-name', direction: 'asc' }]);
    expect(seen.unresolved).toEqual([{ source: 'sort', property: 'Ghost' }]);
  });

  it('supports property-keyed sort records', () => {
    expect(remappedViewSorts(propertyMappings, { Name: 'desc' })).toEqual([
      { propertyId: 'local-name', direction: 'desc' },
    ]);
  });

  it('returns undefined for unusable payloads', () => {
    expect(remappedViewSorts(propertyMappings, undefined)).toBeUndefined();
    expect(remappedViewSorts(propertyMappings, [{ property: 'Ghost' }])).toBeUndefined();
  });
});

describe('remappedViewFilterGroup / remappedViewFilterList', () => {
  const propertyMappings = new Map([
    ['Status', 'p-status'],
    ['Score', 'p-score'],
    ['Name', 'p-name'],
  ]);
  const localPropertiesById = new Map<string, DbProperty>([
    [
      'p-status',
      dbProp('p-status', 'select', {
        name: 'Status',
        config: { options: [{ id: 'opt-done', name: 'Done' }] },
      }),
    ],
    ['p-score', dbProp('p-score', 'number', { name: 'Score' })],
    ['p-name', dbProp('p-name', 'text', { name: 'Name' })],
  ]);

  it('remaps an and-group and normalizes select values to option ids', () => {
    const group = remappedViewFilterGroup(
      propertyMappings,
      {
        and: [
          { property: 'Status', select: { equals: 'Done' } },
          { property: 'Score', number: { greater_than_or_equal_to: 5 } },
        ],
      },
      undefined,
      localPropertiesById,
    );
    expect(group).toEqual({
      conjunction: 'and',
      filters: [
        { propertyId: 'p-status', operator: 'equals', value: 'opt-done' },
        { propertyId: 'p-score', operator: 'greater_than', value: 5 },
      ],
      groups: [],
    });
  });

  it('preserves nested or-groups and drops unmapped leaves', () => {
    const seen = collector();
    const group = remappedViewFilterGroup(
      propertyMappings,
      {
        and: [
          { property: 'Name', rich_text: { is_not_empty: true } },
          {
            or: [
              { property: 'Score', number: { less_than: 3 } },
              { property: 'Ghost', number: { equals: 1 } },
            ],
          },
        ],
      },
      seen,
      localPropertiesById,
    );
    expect(group).toEqual({
      conjunction: 'and',
      filters: [{ propertyId: 'p-name', operator: 'is_not_empty' }],
      groups: [
        {
          conjunction: 'or',
          filters: [{ propertyId: 'p-score', operator: 'less_than', value: 3 }],
          groups: [],
        },
      ],
    });
    expect(seen.unresolved).toEqual([{ source: 'filter', property: 'Ghost' }]);
  });

  it('wraps a bare leaf record into an and-group', () => {
    const group = remappedViewFilterGroup(
      propertyMappings,
      { property: 'Name', rich_text: { contains: 'plan' } },
      undefined,
      localPropertiesById,
    );
    expect(group).toEqual({
      conjunction: 'and',
      filters: [{ propertyId: 'p-name', operator: 'contains', value: 'plan' }],
      groups: [],
    });
  });

  it('returns undefined when nothing survives remapping', () => {
    expect(
      remappedViewFilterGroup(propertyMappings, { and: [{ property: 'Ghost' }] }),
    ).toBeUndefined();
    expect(remappedViewFilterGroup(propertyMappings, 'nonsense')).toBeUndefined();
  });

  it('remappedViewFilterList handles filters wrappers and property-keyed records', () => {
    const wrapped = remappedViewFilterList(
      propertyMappings,
      { filters: [{ property: 'Name', rich_text: { contains: 'a' } }] },
      undefined,
      localPropertiesById,
    );
    expect(wrapped).toEqual([{ propertyId: 'p-name', operator: 'contains', value: 'a' }]);

    const keyed = remappedViewFilterList(
      propertyMappings,
      { Status: { equals: 'Done' }, Ghost: { equals: 'x' } },
      undefined,
      localPropertiesById,
    );
    expect(keyed).toEqual([{ propertyId: 'p-status', operator: 'equals', value: 'opt-done' }]);
  });
});

describe('remappedViewPropertySettings', () => {
  const propertyMappings = new Map([
    ['Name', 'p-name'],
    ['Status', 'p-status'],
    ['Tags', 'p-tags'],
  ]);

  it('maps visibility, width, wrap, and calculation settings onto local ids', () => {
    const settings = remappedViewPropertySettings(propertyMappings, [
      { property: 'Name', visible: true, width: 240 },
      { property: 'Status', hidden: true },
      { property: 'Tags', wrap: true, calculation: 'count' },
    ]);
    expect(settings).toMatchObject({
      visibleProperties: ['p-name'],
      hiddenProperties: ['p-status'],
      propertyOrder: ['p-name', 'p-status', 'p-tags'],
      propertyWidths: { 'p-name': 240 },
      wrappedColumns: ['p-tags'],
    });
    expect(settings?.tableCalculations?.['p-tags']).toBeTruthy();
  });

  it('supports property-name keyed setting records', () => {
    const settings = remappedViewPropertySettings(propertyMappings, {
      Name: { visible: false },
      Status: { width: '180' },
    });
    expect(settings).toMatchObject({
      hiddenProperties: ['p-name'],
      propertyOrder: ['p-name', 'p-status'],
      propertyWidths: { 'p-status': 180 },
    });
  });

  it('maps official view configuration property visibility entries', () => {
    const liveApiMappings = new Map([
      ['title', 'p-title'],
      ['거래처명', 'p-title'],
      ['Yq>T', 'p-contact-phone'],
      ['담당자 연락처', 'p-contact-phone'],
      ['EUvr', 'p-installer-contracts'],
      ['계약DB(설치기사)', 'p-installer-contracts'],
    ]);
    const settings = remappedViewPropertySettings(liveApiMappings, [
      { property_id: 'title', property_name: '거래처명', visible: true, width: 260 },
      { property_id: 'Yq%3ET', property_name: '담당자 연락처', visible: false },
      { property_id: 'EUvr', property_name: '계약DB(설치기사)', visible: false, width: '180' },
    ]);
    expect(settings).toMatchObject({
      visibleProperties: ['p-title'],
      hiddenProperties: ['p-contact-phone', 'p-installer-contracts'],
      propertyOrder: ['p-title', 'p-contact-phone', 'p-installer-contracts'],
      propertyWidths: { 'p-title': 260, 'p-installer-contracts': 180 },
    });
  });

  it('ignores stale hidden settings without names but records other unresolved refs', () => {
    const seen = collector();
    const settings = remappedViewPropertySettings(
      propertyMappings,
      [
        { property: 'stale%3Aid', hidden: true },
        { property: 'Ghost', property_name: 'Ghost', visible: true },
        { property: 'Name', visible: true },
      ],
      seen,
    );
    expect(settings?.propertyOrder).toEqual(['p-name']);
    expect(seen.unresolved).toEqual([{ source: 'property settings', property: 'Ghost' }]);
  });

  it('returns undefined when there are no usable entries', () => {
    expect(remappedViewPropertySettings(propertyMappings, undefined)).toBeUndefined();
    expect(remappedViewPropertySettings(propertyMappings, [])).toBeUndefined();
  });
});

describe('remapFormulaExpressionPropertyReferences', () => {
  function formulaFixture(localNamesByNotionName: Record<string, string>) {
    const dataSourceId = 'ds-1';
    const contexts = new Map<string, ImportedPropertyContext>();
    let index = 0;
    for (const [notionName, localName] of Object.entries(localNamesByNotionName)) {
      index += 1;
      const context: ImportedPropertyContext = {
        dataSourceId,
        notionPropertyId: `np-${index}`,
        notionPropertyName: notionName,
        notionProperty: { id: `np-${index}`, name: notionName, type: 'rich_text' },
        property: dbProp(`local-${index}`, 'text', { name: localName }),
      };
      contexts.set(`${dataSourceId}\n${notionName}`, context);
      contexts.set(`${dataSourceId}\nnp-${index}`, context);
    }
    const selfContext: ImportedPropertyContext = {
      dataSourceId,
      notionPropertyId: 'np-self',
      notionPropertyName: 'Formula',
      notionProperty: { id: 'np-self', name: 'Formula', type: 'formula' },
      property: dbProp('local-self', 'formula', { name: 'Formula' }),
    };
    return { selfContext, contexts };
  }

  it('rewrites prop() references to the local property names', () => {
    const { selfContext, contexts } = formulaFixture({ 'Old Name': 'New Name' });
    const result = remapFormulaExpressionPropertyReferences(
      'prop("Old Name") + 1',
      selfContext,
      contexts,
    );
    expect(result.expression).toBe('prop("New Name") + 1');
    expect(result.remapped).toBe(1);
    expect(result.unresolved).toEqual([]);
  });

  it('leaves string literals untouched while remapping real references', () => {
    const { selfContext, contexts } = formulaFixture({ Old: 'Renamed' });
    const result = remapFormulaExpressionPropertyReferences(
      'concat("prop(\'Old\') stays", prop(\'Old\'))',
      selfContext,
      contexts,
    );
    expect(result.expression).toBe('concat("prop(\'Old\') stays", prop(\'Renamed\'))');
    expect(result.remapped).toBe(1);
  });

  it('collects unresolved references once and keeps the expression intact', () => {
    const { selfContext, contexts } = formulaFixture({});
    const result = remapFormulaExpressionPropertyReferences(
      'prop("Missing") + prop("Missing")',
      selfContext,
      contexts,
    );
    expect(result.expression).toBe('prop("Missing") + prop("Missing")');
    expect(result.remapped).toBe(0);
    expect(result.unresolved).toEqual(['Missing']);
  });

  it('replaces notion block property tokens with local prop() calls', () => {
    const { selfContext, contexts } = formulaFixture({ 'Old Name': 'New Name' });
    const result = remapFormulaExpressionPropertyReferences(
      '{{notion:block_property:Old%20Name:ds-1}} * 2',
      selfContext,
      contexts,
    );
    expect(result.expression).toBe('prop("New Name") * 2');
    expect(result.remapped).toBe(1);
  });

  it('escapes quotes inside remapped property names', () => {
    const { selfContext, contexts } = formulaFixture({ Old: 'Say "Hi"' });
    const result = remapFormulaExpressionPropertyReferences('prop("Old")', selfContext, contexts);
    expect(result.expression).toBe('prop("Say \\"Hi\\"")');
  });
});

describe('remapImportedRichTextMentionSpans', () => {
  it('rewrites page mentions to local page ids', () => {
    const result = remapImportedRichTextMentionSpans(
      [{ text: '@Doc', notionPageId: 'np-1' }],
      mappingsByNotionId(importMapping('np-1', 'local-page-1')),
    );
    expect(result.changed).toBe(true);
    expect(result.remapped).toBe(1);
    expect(result.value).toEqual([
      {
        text: '@Doc',
        notionPageId: 'np-1',
        mention: 'page',
        pageId: 'local-page-1',
        notionMentionLocalId: 'local-page-1',
        notionMentionLocalType: 'page',
      },
    ]);
  });

  it('resolves targets nested inside the raw notionMention payload', () => {
    const result = remapImportedRichTextMentionSpans(
      [{ text: '@DB', notionMention: { type: 'database', database: { id: 'nd-1' } } }],
      mappingsByNotionId(importMapping('nd-1', 'local-db-1', 'database')),
    );
    expect(result.remapped).toBe(1);
    const span = (result.value as Record<string, unknown>[])[0];
    expect(span).toMatchObject({
      mention: 'page',
      pageId: 'local-db-1',
      notionMentionLocalType: 'database',
    });
  });

  it('collects unresolved target ids without touching the span', () => {
    const spans = [{ text: '@Gone', notionPageId: 'np-missing' }];
    const result = remapImportedRichTextMentionSpans(spans, mappingsByNotionId());
    expect(result.changed).toBe(false);
    expect(result.unresolved).toEqual(['np-missing']);
    expect((result.value as unknown[])[0]).toBe(spans[0]);
  });

  it('is a no-op for spans that are already remapped and for non-array values', () => {
    const already = {
      text: '@Doc',
      notionPageId: 'np-1',
      mention: 'page',
      pageId: 'local-page-1',
      notionMentionLocalId: 'local-page-1',
    };
    const result = remapImportedRichTextMentionSpans(
      [already],
      mappingsByNotionId(importMapping('np-1', 'local-page-1')),
    );
    expect(result.changed).toBe(false);
    expect(result.remapped).toBe(0);

    const nonArray = remapImportedRichTextMentionSpans('rich', mappingsByNotionId());
    expect(nonArray.changed).toBe(false);
    expect(nonArray.value).toBe('rich');
  });
});

describe('remapImportedRowRelationProperties', () => {
  const relationProps = [dbProp('p-rel', 'relation')];

  function row(properties: Record<string, unknown>): Page {
    return { id: 'row-1', workspaceId: 'ws1', properties };
  }

  it('replaces notion ids with local page ids', () => {
    const properties = remapImportedRowRelationProperties(
      row({ 'p-rel': ['np-a', 'np-b'], 'p-text': 'kept' }),
      relationProps,
      mappingsByNotionId(importMapping('np-a', 'local-a'), importMapping('np-b', 'local-b')),
    );
    expect(properties).toEqual({ 'p-rel': ['local-a', 'local-b'], 'p-text': 'kept' });
  });

  it('moves unmapped ids into the unresolved bucket per property', () => {
    const properties = remapImportedRowRelationProperties(
      row({ 'p-rel': ['np-a', 'np-missing'] }),
      relationProps,
      mappingsByNotionId(importMapping('np-a', 'local-a')),
    );
    expect(properties).toEqual({
      'p-rel': ['local-a'],
      __notionRelationUnresolved: { 'p-rel': ['np-missing'] },
    });
  });

  it('treats mappings to non-page targets as unresolved', () => {
    const properties = remapImportedRowRelationProperties(
      row({ 'p-rel': ['np-db'] }),
      relationProps,
      mappingsByNotionId(importMapping('np-db', 'local-db', 'database')),
    );
    expect(properties).toEqual({
      'p-rel': [],
      __notionRelationUnresolved: { 'p-rel': ['np-db'] },
    });
  });

  it('returns undefined when no relation values need remapping', () => {
    expect(
      remapImportedRowRelationProperties(
        row({ 'p-rel': [], 'p-text': 'x' }),
        relationProps,
        mappingsByNotionId(),
      ),
    ).toBeUndefined();
    expect(
      remapImportedRowRelationProperties(
        { id: 'row-2', workspaceId: 'ws1' },
        relationProps,
        mappingsByNotionId(),
      ),
    ).toBeUndefined();
  });
});

describe('remapImportedViewRelationFilterConfig', () => {
  const relationPropsById = new Map<string, DbProperty>([
    ['p-rel', dbProp('p-rel', 'relation')],
    ['p-roll', dbProp('p-roll', 'rollup')],
  ]);
  const localPageIds = new Set(['local-1', 'local-2']);

  it('remaps relation filter values from notion ids to local page ids', () => {
    const result = remapImportedViewRelationFilterConfig(
      {
        filterGroup: {
          conjunction: 'and',
          filters: [{ propertyId: 'p-rel', operator: 'contains', value: [NOTION_PAGE_A] }],
          groups: [],
        },
      },
      relationPropsById,
      mappingsByNotionId(importMapping(NOTION_PAGE_A, 'local-1')),
      localPageIds,
    );
    expect(result.remapped).toBe(1);
    expect(result.unresolved).toEqual([]);
    const config = result.config as {
      filterGroup: { filters: Array<{ value: unknown }> };
    };
    expect(config.filterGroup.filters[0].value).toEqual(['local-1']);
  });

  it('recurses through nested groups and matches compact-vs-dashed notion ids', () => {
    const compact = NOTION_PAGE_A.replace(/-/g, '');
    const result = remapImportedViewRelationFilterConfig(
      {
        filterGroup: {
          conjunction: 'and',
          filters: [],
          groups: [
            {
              conjunction: 'or',
              filters: [{ propertyId: 'p-rel', operator: 'equals', value: compact }],
              groups: [],
            },
          ],
        },
      },
      relationPropsById,
      mappingsByNotionId(importMapping(NOTION_PAGE_A, 'local-2')),
      localPageIds,
    );
    expect(result.remapped).toBe(1);
    const config = result.config as {
      filterGroup: { groups: Array<{ filters: Array<{ value: unknown }> }> };
    };
    expect(config.filterGroup.groups[0].filters[0].value).toBe('local-2');
  });

  it('keeps already-local values and reports unresolved notion ids', () => {
    const result = remapImportedViewRelationFilterConfig(
      {
        filterGroup: {
          conjunction: 'and',
          filters: [
            { propertyId: 'p-rel', operator: 'contains', value: ['local-1', NOTION_PAGE_B] },
          ],
          groups: [],
        },
      },
      relationPropsById,
      mappingsByNotionId(),
      localPageIds,
    );
    expect(result.remapped).toBe(0);
    expect(result.unresolved).toEqual([NOTION_PAGE_B]);
    const config = result.config as {
      filterGroup: { filters: Array<{ value: unknown }> };
    };
    expect(config.filterGroup.filters[0].value).toEqual(['local-1', NOTION_PAGE_B]);
  });

  it('converts db_template targets into a current-page filter value', () => {
    const result = remapImportedViewRelationFilterConfig(
      {
        filterGroup: {
          conjunction: 'and',
          filters: [{ propertyId: 'p-rel', operator: 'contains', value: NOTION_PAGE_A }],
          groups: [],
        },
      },
      relationPropsById,
      mappingsByNotionId(importMapping(NOTION_PAGE_A, 'tpl-1', 'db_template')),
      localPageIds,
    );
    expect(result.remapped).toBe(1);
    const config = result.config as {
      filterGroup: { filters: Array<{ value: unknown }> };
    };
    expect(config.filterGroup.filters[0].value).toEqual({ kind: 'notionlike.current_page' });
  });

  it('leaves rollup values alone unless they look like notion ids', () => {
    const result = remapImportedViewRelationFilterConfig(
      {
        filterGroup: {
          conjunction: 'and',
          filters: [{ propertyId: 'p-roll', operator: 'equals', value: 'plain text' }],
          groups: [],
        },
      },
      relationPropsById,
      mappingsByNotionId(),
      localPageIds,
    );
    expect(result.remapped).toBe(0);
    expect(result.unresolved).toEqual([]);
    const config = result.config as {
      filterGroup: { filters: Array<{ value: unknown }> };
    };
    expect(config.filterGroup.filters[0].value).toBe('plain text');
  });

  it('merges legacy filters and quickFilters into a single filterGroup', () => {
    const result = remapImportedViewRelationFilterConfig(
      {
        filters: [{ propertyId: 'p-rel', operator: 'contains', value: [NOTION_PAGE_A] }],
        quickFilters: [{ propertyId: 'p-roll', operator: 'is_not_empty' }],
      },
      relationPropsById,
      mappingsByNotionId(importMapping(NOTION_PAGE_A, 'local-1')),
      localPageIds,
    );
    expect(result.changed).toBe(true);
    const config = result.config as Record<string, unknown>;
    expect(config.filters).toBeUndefined();
    expect(config.quickFilters).toBeUndefined();
    expect(config.filterGroup).toEqual({
      conjunction: 'and',
      filters: [],
      groups: [
        {
          conjunction: 'and',
          filters: [{ propertyId: 'p-rel', operator: 'contains', value: ['local-1'] }],
          groups: [],
        },
        {
          conjunction: 'and',
          filters: [{ propertyId: 'p-roll', operator: 'is_not_empty' }],
          groups: [],
        },
      ],
    });
  });

  it('does nothing without relation properties or a config record', () => {
    const config = { filterGroup: { conjunction: 'and', filters: [], groups: [] } };
    const noProps = remapImportedViewRelationFilterConfig(
      config,
      new Map(),
      mappingsByNotionId(),
      localPageIds,
    );
    expect(noProps.changed).toBe(false);
    expect(noProps.config).toBe(config);

    const noRecord = remapImportedViewRelationFilterConfig(
      undefined,
      relationPropsById,
      mappingsByNotionId(),
      localPageIds,
    );
    expect(noRecord.changed).toBe(false);
  });
});

describe('buildImportPlan', () => {
  const dataSourceItem = importItem('ds-1', 'data_source', {
    title: 'Tasks',
    metadata: {
      dataSourceSnapshot: {
        dataSource: {
          properties: {
            Name: { id: 'title', name: 'Name', type: 'title' },
            Status: { id: 'st', name: 'Status', type: 'select', select: { options: [] } },
          },
        },
        views: [{ id: 'view-1', name: 'All tasks', type: 'table' }],
      },
    },
  });
  const rowItem = importItem('row-1', 'page', {
    parentNotionId: 'ds-1',
    metadata: { dataSourceId: 'ds-1' },
  });
  const pageItem = importItem('pg-1', 'page', {
    metadata: {
      pageSnapshot: {
        childBlocks: [
          {
            object: 'block',
            id: 'b1',
            type: 'paragraph',
            paragraph: { rich_text: [{ plain_text: 'hello' }] },
          },
        ],
      },
    },
  });

  it('counts rows, pages, properties, and views into estimated writes', () => {
    const plan = buildImportPlan(readyJob(), [dataSourceItem, rowItem, pageItem]);
    expect(plan.status).toBe('ready');
    expect(plan.canApply).toBe(true);
    expect(plan.counts).toEqual({ data_source: 1, page: 2 });
    expect(plan.estimatedWrites).toMatchObject({
      pages: 3, // 1 page + 1 row + 1 import root
      databases: 1,
      rows: 1,
      blocks: 1,
      properties: 2,
      views: 1,
    });
  });

  it('plans a placeholder database with a warning when no data source is exposed', () => {
    const placeholder = importItem('db-x', 'database', { title: 'Legacy', metadata: {} });
    const plan = buildImportPlan(readyJob(), [dataSourceItem, rowItem, placeholder]);
    expect(plan.estimatedWrites.databases).toBe(2);
    const warning = plan.conversion.warnings.find(
      (issue) => issue.code === 'database_source_unavailable',
    );
    expect(warning).toMatchObject({ notionId: 'db-x', notionObject: 'database' });
  });

  it('is blocked when the job is not ready or there are no items', () => {
    const notReady = buildImportPlan(readyJob({ status: 'discovering' }), [pageItem]);
    expect(notReady.status).toBe('blocked');
    expect(notReady.canApply).toBe(false);

    const empty = buildImportPlan(readyJob(), []);
    expect(empty.status).toBe('blocked');
    expect(empty.canApply).toBe(false);
  });
});

function fakeDb(tables: Record<string, Row[]> = {}) {
  return makeFakeDb(tables) as unknown as Parameters<typeof pruneStaleImportJobs>[0] & {
    tables: Record<string, Row[]>;
  };
}

function jobRow(id: string, extra: Partial<NotionImportJob> = {}): NotionImportJob {
  return {
    id,
    workspaceId: 'ws-1',
    source: 'notion_api',
    connectionKind: 'manual_token',
    status: 'completed',
    phase: 'done',
    apiVersion: '2022-06-28',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  } as NotionImportJob;
}

const DAY_MS = 24 * 60 * 60 * 1000;
function isoAgo(ms: number) {
  return new Date(Date.now() - ms).toISOString();
}

describe('isLiveImportJob', () => {
  it('treats queued/discovering and apply-in-progress as live, others as prunable', () => {
    expect(isLiveImportJob(jobRow('a', { status: 'queued' }))).toBe(true);
    expect(isLiveImportJob(jobRow('b', { status: 'discovering' }))).toBe(true);
    expect(
      isLiveImportJob(jobRow('c', { status: 'ready', progress: { currentStatus: 'running' } })),
    ).toBe(true);
    expect(isLiveImportJob(jobRow('d', { status: 'ready' }))).toBe(false);
    expect(isLiveImportJob(jobRow('e', { status: 'completed' }))).toBe(false);
    expect(isLiveImportJob(jobRow('f', { status: 'failed' }))).toBe(false);
    expect(isLiveImportJob(jobRow('g', { status: 'cancelled' }))).toBe(false);
  });
});

describe('pruneStaleImportJobs', () => {
  it('deletes stale non-live jobs (and their items) past the retention window, keeping live + recent', async () => {
    const jobs = [
      jobRow('recent', { status: 'ready', createdAt: isoAgo(DAY_MS), updatedAt: isoAgo(DAY_MS) }),
      jobRow('old-failed', { status: 'failed', createdAt: isoAgo(30 * DAY_MS), updatedAt: isoAgo(30 * DAY_MS) }),
      jobRow('old-empty-ready', { status: 'ready', createdAt: isoAgo(20 * DAY_MS), updatedAt: isoAgo(20 * DAY_MS) }),
      // Old but still live (mid-apply): must NEVER be pruned regardless of age.
      jobRow('old-live', {
        status: 'ready',
        progress: { currentStatus: 'running' },
        createdAt: isoAgo(40 * DAY_MS),
        updatedAt: isoAgo(40 * DAY_MS),
      }),
    ];
    const db = fakeDb({
      notion_import_jobs: jobs.map((job) => ({ ...job })) as unknown as Row[],
      notion_import_items: [
        { id: 'i1', jobId: 'old-failed', workspaceId: 'ws-1' },
        { id: 'i2', jobId: 'old-empty-ready', workspaceId: 'ws-1' },
        { id: 'i3', jobId: 'recent', workspaceId: 'ws-1' },
      ] as unknown as Row[],
    });

    const pruned = await pruneStaleImportJobs(db, jobs, undefined);

    expect([...pruned].sort()).toEqual(['old-empty-ready', 'old-failed']);
    const remainingJobs = db.tables.notion_import_jobs.map((row) => row.id).sort();
    expect(remainingJobs).toEqual(['old-live', 'recent']);
    // Items belonging to pruned jobs are gone; the surviving job keeps its item.
    const remainingItems = db.tables.notion_import_items.map((row) => row.id).sort();
    expect(remainingItems).toEqual(['i3']);
  });

  it('prunes non-live jobs beyond the per-workspace keep cap even when recent', async () => {
    // 30 recent completed jobs → keep cap is 25 → 5 oldest pruned.
    const jobs = Array.from({ length: 30 }, (_, index) =>
      jobRow(`job-${String(index).padStart(2, '0')}`, {
        status: 'completed',
        // index 0 is the OLDEST (createdAt ascending with index).
        createdAt: isoAgo((30 - index) * 60_000),
        updatedAt: isoAgo((30 - index) * 60_000),
      }),
    );
    const db = fakeDb({ notion_import_jobs: jobs.map((job) => ({ ...job })) as unknown as Row[] });

    const pruned = await pruneStaleImportJobs(db, jobs, undefined);

    // Batch cap is 12; there are only 5 over the keep cap, so all 5 oldest go.
    expect([...pruned].sort()).toEqual([
      'job-00',
      'job-01',
      'job-02',
      'job-03',
      'job-04',
    ]);
    expect(db.tables.notion_import_jobs.length).toBe(25);
  });

  it('never prunes when everything is live or within retention and cap', async () => {
    const jobs = [
      jobRow('live', { status: 'discovering', createdAt: isoAgo(90 * DAY_MS) }),
      jobRow('fresh', { status: 'completed', createdAt: isoAgo(DAY_MS), updatedAt: isoAgo(DAY_MS) }),
    ];
    const db = fakeDb({ notion_import_jobs: jobs.map((job) => ({ ...job })) as unknown as Row[] });
    const pruned = await pruneStaleImportJobs(db, jobs, undefined);
    expect(pruned.size).toBe(0);
    expect(db.tables.notion_import_jobs.length).toBe(2);
  });
});

describe('discoveryProgressPercent', () => {
  it('reports the search phase at a fixed early tick', () => {
    expect(discoveryProgressPercent({ phase: 'search', enrichedPages: 0, enrichedDataSources: 0, enrichableTotal: 0 })).toBe(27);
  });

  it('rises monotonically from 30 to 48 with the enriched fraction and caps at 48', () => {
    const at = (enriched: number, total: number) =>
      discoveryProgressPercent({ phase: 'enrich', enrichedPages: enriched, enrichedDataSources: 0, enrichableTotal: total });
    expect(at(0, 100)).toBe(30);
    expect(at(50, 100)).toBe(39);
    expect(at(100, 100)).toBe(48);
    // Referenced pages can push enriched beyond the initial enrichable estimate.
    expect(at(140, 100)).toBe(48);
    // Values never regress as more items are enriched.
    let previous = 0;
    for (let enriched = 0; enriched <= 100; enriched += 5) {
      const percent = at(enriched, 100);
      expect(percent).toBeGreaterThanOrEqual(previous);
      previous = percent;
    }
  });

  it('stays at the enrichment floor when the total is unknown', () => {
    expect(discoveryProgressPercent({ phase: 'enrich', enrichedPages: 5, enrichedDataSources: 3, enrichableTotal: 0 })).toBe(30);
  });
});
