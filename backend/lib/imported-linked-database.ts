import { listAll, type TableQuery } from './table-utils';

export interface ImportedLinkedDatabasePage {
  id: string;
  workspaceId: string;
  kind?: 'page' | 'database';
  inTrash?: boolean;
  notionImportJobId?: string | null;
  properties?: Record<string, unknown>;
}

interface ImportedLinkedDatabaseView {
  id: string;
  databaseId: string;
  notionImportJobId?: string | null;
  config?: Record<string, unknown>;
  position?: number;
}

interface ImportedLinkedDatabaseMapping {
  id: string;
  workspaceId: string;
  jobId: string;
  mappingKey?: string | null;
  notionId: string;
  notionType?: string | null;
  localId: string;
  localType: string;
  relationKind?: string | null;
}

interface ImportedLinkedDatabaseTable<T> extends TableQuery<T> {
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface ImportedLinkedDatabaseDb {
  table<T>(name: string): ImportedLinkedDatabaseTable<T>;
}

const LINKED_DATABASE_ALIAS_LIMIT = 240;
const LINKED_DATABASE_IMPORT_JOB_LIMIT = 32;
const LINKED_DATABASE_LEGACY_MAPPING_LIMIT = 240;
const LINKED_DATABASE_JOB_VIEW_LIMIT = 10_000;
const LINKED_DATABASE_SOURCE_LIMIT = 240;
// EdgeBase's DO SQLite backend accepts at most 100 bound parameters in one
// statement. Chained legacy lookups spend one parameter on jobId and must
// reserve one more for listAll's cursor continuation, leaving 98 for notionId.
const EDGEBASE_IN_VALUE_LIMIT = 100;
const EDGEBASE_CHAINED_IN_VALUE_LIMIT = EDGEBASE_IN_VALUE_LIMIT - 2;
const CANONICAL_DATABASE_MAPPING_KINDS = new Set([
  'database_container',
  'database_container_inferred_from_view_context',
]);

function linkedDatabaseError(message: string, status = 409) {
  return Object.assign(new Error(message), { status });
}

function chunksOf<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function listBoundedQueries<T extends { id: string }>(
  queries: Array<() => TableQuery<T>>,
  maxItems: number,
  label: string,
) {
  const out: T[] = [];
  const seenIds = new Set<string>();
  for (const query of queries) {
    const remaining = Math.max(1, maxItems - out.length);
    const items = await listAll(query(), {
      maxItems: remaining,
      pageSize: Math.min(1_000, remaining),
      label,
    });
    if (out.length + items.length > maxItems) {
      throw Object.assign(new Error(`${label} materialization limit exceeded (${maxItems} rows).`), { status: 413 });
    }
    for (const item of items) {
      if (seenIds.has(item.id)) {
        throw linkedDatabaseError(`${label} returned duplicate rows across disjoint key batches.`);
      }
      seenIds.add(item.id);
      out.push(item);
    }
  }
  return out;
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeNotionScopeId(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const clean = value
    .replace(/^collection:\/\//i, '')
    .replace(/^data_source:\/\//i, '')
    .replace(/-/g, '')
    .trim()
    .toLowerCase();
  return clean || undefined;
}

function notionScopeIdQueryVariants(value: string) {
  const raw = value
    .trim()
    .replace(/^collection:\/\//i, '')
    .replace(/^data_source:\/\//i, '')
    .toLowerCase();
  const normalized = normalizeNotionScopeId(raw);
  const canonicalUuid = normalized && /^[a-f0-9]{32}$/.test(normalized)
    ? `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`
    : undefined;
  return Array.from(new Set([raw, normalized, canonicalUuid].filter((item): item is string => !!item)));
}

function pageNotionDatabaseId(page: ImportedLinkedDatabasePage) {
  const value = page.properties?.notionDatabaseId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pageNotionImportJobId(page: ImportedLinkedDatabasePage) {
  const value = page.notionImportJobId ?? page.properties?.notionImportJobId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isImportedLinkedDatabaseAlias(page: ImportedLinkedDatabasePage) {
  return page.properties?.notionLinkedDatabaseSourceUnavailable === true;
}

function notionParentDatabaseId(view: ImportedLinkedDatabaseView) {
  const notion = recordObject(view.config?.notion);
  if (!notion) return undefined;
  const parent = recordObject(notion.parent);
  if (parent) {
    const id = parent.database_id ?? parent.databaseId ?? parent.id;
    if (typeof id === 'string') return id;
  }
  const fallback =
    notion.parent_database_id
    ?? notion.parentDatabaseId
    ?? notion.database_id
    ?? notion.databaseId;
  return typeof fallback === 'string' ? fallback : undefined;
}

function mappingMatchesAlias(
  mapping: ImportedLinkedDatabaseMapping,
  page: ImportedLinkedDatabasePage,
  jobId: string,
  notionDatabaseId: string,
) {
  return mapping.workspaceId === page.workspaceId
    && mapping.jobId === jobId
    && mapping.localType === 'database'
    && mapping.notionType === 'database'
    && normalizeNotionScopeId(mapping.notionId) === notionDatabaseId;
}

type AliasDescriptor = {
  page: ImportedLinkedDatabasePage;
  jobId: string;
  rawNotionDatabaseId: string;
  notionDatabaseId: string;
  mappingKey: string;
};

type AliasLocator =
  | { mode: 'mapped'; sourceId: string }
  | { mode: 'job_views'; jobId: string };

function classifyMappings(
  mappings: ImportedLinkedDatabaseMapping[],
  descriptor: AliasDescriptor,
): AliasLocator {
  if (mappings.length === 0) return { mode: 'job_views', jobId: descriptor.jobId };
  if (mappings.some((mapping) => !mappingMatchesAlias(
    mapping,
    descriptor.page,
    descriptor.jobId,
    descriptor.notionDatabaseId,
  ))) {
    throw linkedDatabaseError('Linked database mapping does not match the requested alias.');
  }
  if (mappings.every((mapping) => CANONICAL_DATABASE_MAPPING_KINDS.has(mapping.relationKind ?? ''))) {
    const sourceIds = Array.from(new Set(mappings.map((mapping) => mapping.localId))).sort();
    if (sourceIds.length !== 1 || sourceIds[0] === descriptor.page.id) {
      throw linkedDatabaseError('Linked database mapping has an ambiguous canonical source.');
    }
    return { mode: 'mapped', sourceId: sourceIds[0] };
  }
  if (mappings.every((mapping) => (
    mapping.relationKind === 'database_placeholder'
    && mapping.localId === descriptor.page.id
  ))) {
    return { mode: 'job_views', jobId: descriptor.jobId };
  }
  throw linkedDatabaseError('Linked database mapping has contradictory source ownership.');
}

function compareViews(a: ImportedLinkedDatabaseView, b: ImportedLinkedDatabaseView) {
  return (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id);
}

async function legacyMappingsByAlias(
  db: ImportedLinkedDatabaseDb,
  descriptors: AliasDescriptor[],
) {
  const mappingsTable = db.table<ImportedLinkedDatabaseMapping>('notion_import_mappings');
  const byAliasId = new Map<string, ImportedLinkedDatabaseMapping[]>();
  const byJob = new Map<string, AliasDescriptor[]>();
  for (const descriptor of descriptors) {
    const existing = byJob.get(descriptor.jobId);
    if (existing) existing.push(descriptor);
    else byJob.set(descriptor.jobId, [descriptor]);
  }

  const queries: Array<() => TableQuery<ImportedLinkedDatabaseMapping>> = [];
  for (const [jobId, jobDescriptors] of byJob) {
    const variants = Array.from(new Set(
      jobDescriptors.flatMap((descriptor) => notionScopeIdQueryVariants(descriptor.rawNotionDatabaseId)),
    ));
    for (const chunk of chunksOf(variants, EDGEBASE_CHAINED_IN_VALUE_LIMIT)) {
      queries.push(() => {
        const jobQuery = mappingsTable.where('jobId', '==', jobId);
        if (typeof jobQuery.where !== 'function') {
          throw new Error('Linked database legacy mapping lookup requires chained filters.');
        }
        return jobQuery.where('notionId', 'in', chunk);
      });
    }
  }
  const mappings = await listBoundedQueries(
    queries,
    LINKED_DATABASE_LEGACY_MAPPING_LIMIT,
    'Linked database legacy alias mappings',
  );
  const mappingsByNotionKey = new Map<string, ImportedLinkedDatabaseMapping[]>();
  for (const mapping of mappings) {
    const normalized = normalizeNotionScopeId(mapping.notionId);
    if (!normalized) continue;
    const key = `${mapping.jobId}:${normalized}`;
    const existing = mappingsByNotionKey.get(key);
    if (existing) existing.push(mapping);
    else mappingsByNotionKey.set(key, [mapping]);
  }
  for (const descriptor of descriptors) {
    byAliasId.set(
      descriptor.page.id,
      mappingsByNotionKey.get(`${descriptor.jobId}:${descriptor.notionDatabaseId}`) ?? [],
    );
  }

  return byAliasId;
}

/**
 * Resolves imported linked-database aliases to their physical source pages.
 *
 * The caller supplies already-bounded requested page rows. Current mapping
 * keys and source pages are collected in indexed bind-safe batches, legacy
 * mappings are grouped by import job, and unresolved placeholder views are
 * read once per job with a hard ceiling.
 */
export async function resolveImportedLinkedDatabaseTargets(
  db: ImportedLinkedDatabaseDb,
  requestedPages: ImportedLinkedDatabasePage[],
) {
  const targets = new Map<string, ImportedLinkedDatabasePage>();
  const uniquePages = Array.from(new Map(requestedPages.map((page) => [page.id, page])).values());
  for (const page of uniquePages) {
    // Relation-only references used to pass through assertRelationConfig,
    // which rejected trashed/non-database aliases before any rewrite. Preserve
    // that fail-closed boundary for both direct pages and linked aliases.
    if (page.kind !== 'database') throw new Error('Page is not a database.');
    if (page.inTrash) throw new Error('Database is in trash.');
    targets.set(page.id, page);
  }

  const linkedPages = uniquePages.filter(isImportedLinkedDatabaseAlias);
  if (linkedPages.length === 0) return targets;
  if (linkedPages.length > LINKED_DATABASE_ALIAS_LIMIT) {
    throw linkedDatabaseError(
      `Linked database alias limit exceeded (${LINKED_DATABASE_ALIAS_LIMIT} databases).`,
      413,
    );
  }

  const descriptors = linkedPages.map((page): AliasDescriptor => {
    const rawNotionDatabaseId = pageNotionDatabaseId(page);
    const notionDatabaseId = normalizeNotionScopeId(rawNotionDatabaseId);
    const jobId = pageNotionImportJobId(page);
    if (!rawNotionDatabaseId || !notionDatabaseId || !jobId) {
      throw linkedDatabaseError('Linked database source metadata is incomplete.');
    }
    return {
      page,
      jobId,
      rawNotionDatabaseId,
      notionDatabaseId,
      mappingKey: `${jobId}:${notionDatabaseId}`,
    };
  });
  const descriptorJobIds = new Set(descriptors.map((descriptor) => descriptor.jobId));
  if (descriptorJobIds.size > LINKED_DATABASE_IMPORT_JOB_LIMIT) {
    throw linkedDatabaseError(
      `Linked database import-job limit exceeded (${LINKED_DATABASE_IMPORT_JOB_LIMIT} jobs).`,
      413,
    );
  }

  const mappingsTable = db.table<ImportedLinkedDatabaseMapping>('notion_import_mappings');
  const mappingKeys = Array.from(new Set(descriptors.map((descriptor) => descriptor.mappingKey)));
  const currentMappings = await listBoundedQueries(
    chunksOf(mappingKeys, EDGEBASE_IN_VALUE_LIMIT).map((chunk) => (
      () => mappingsTable.where('mappingKey', 'in', chunk)
    )),
    LINKED_DATABASE_ALIAS_LIMIT,
    'Linked database current alias mappings',
  );
  const currentByKey = new Map<string, ImportedLinkedDatabaseMapping[]>();
  for (const mapping of currentMappings) {
    const key = typeof mapping.mappingKey === 'string' ? mapping.mappingKey : '';
    const existing = currentByKey.get(key);
    if (existing) existing.push(mapping);
    else currentByKey.set(key, [mapping]);
  }

  const missingCurrent = descriptors.filter((descriptor) => !currentByKey.has(descriptor.mappingKey));
  const legacyByAliasId = await legacyMappingsByAlias(db, missingCurrent);
  const locators = new Map<string, AliasLocator>();
  for (const descriptor of descriptors) {
    const mappings = currentByKey.get(descriptor.mappingKey)
      ?? legacyByAliasId.get(descriptor.page.id)
      ?? [];
    locators.set(descriptor.page.id, classifyMappings(mappings, descriptor));
  }

  const fallbackJobIds = Array.from(new Set(
    Array.from(locators.values())
      .filter((locator): locator is Extract<AliasLocator, { mode: 'job_views' }> => locator.mode === 'job_views')
      .map((locator) => locator.jobId),
  ));
  if (fallbackJobIds.length > LINKED_DATABASE_IMPORT_JOB_LIMIT) {
    throw linkedDatabaseError(
      `Linked database import-job limit exceeded (${LINKED_DATABASE_IMPORT_JOB_LIMIT} jobs).`,
      413,
    );
  }
  const viewsByJob = new Map<string, ImportedLinkedDatabaseView[]>();
  const perJobViewLimit = Math.max(
    1,
    Math.floor(LINKED_DATABASE_JOB_VIEW_LIMIT / Math.max(1, fallbackJobIds.length)),
  );
  await Promise.all(fallbackJobIds.map(async (jobId) => {
    const views = await listAll(
      db.table<ImportedLinkedDatabaseView>('db_views').where('notionImportJobId', '==', jobId),
      {
        maxItems: perJobViewLimit,
        pageSize: Math.min(1_000, perJobViewLimit),
        label: 'Linked database import-job views',
      },
    );
    viewsByJob.set(jobId, views);
  }));

  const sourceIdByAliasId = new Map<string, string>();
  for (const descriptor of descriptors) {
    const locator = locators.get(descriptor.page.id)!;
    if (locator.mode === 'mapped') {
      sourceIdByAliasId.set(descriptor.page.id, locator.sourceId);
      continue;
    }
    const sourceId = (viewsByJob.get(locator.jobId) ?? [])
      .filter((view) => (
        view.databaseId !== descriptor.page.id
        && normalizeNotionScopeId(notionParentDatabaseId(view)) === descriptor.notionDatabaseId
      ))
      .sort(compareViews)[0]?.databaseId;
    if (!sourceId) throw linkedDatabaseError('Linked database canonical source could not be resolved.');
    sourceIdByAliasId.set(descriptor.page.id, sourceId);
  }

  const sourceIds = Array.from(new Set(sourceIdByAliasId.values()));
  if (sourceIds.length > LINKED_DATABASE_SOURCE_LIMIT) {
    throw linkedDatabaseError(
      `Linked database source limit exceeded (${LINKED_DATABASE_SOURCE_LIMIT} databases).`,
      413,
    );
  }
  const sourcePagesTable = db.table<ImportedLinkedDatabasePage>('pages');
  const sourcePages = await listBoundedQueries(
    chunksOf(sourceIds, EDGEBASE_IN_VALUE_LIMIT).map((chunk) => (
      () => sourcePagesTable.where('id', 'in', chunk)
    )),
    LINKED_DATABASE_SOURCE_LIMIT,
    'Linked database canonical source pages',
  );
  const sourcePagesById = new Map(sourcePages.map((page) => [page.id, page]));
  for (const descriptor of descriptors) {
    const sourceId = sourceIdByAliasId.get(descriptor.page.id)!;
    const source = sourcePagesById.get(sourceId);
    if (
      !source
      || source.id === descriptor.page.id
      || source.workspaceId !== descriptor.page.workspaceId
      || source.kind !== 'database'
      || source.inTrash
      || isImportedLinkedDatabaseAlias(source)
    ) {
      throw linkedDatabaseError('Linked database canonical source is unavailable.');
    }
    targets.set(descriptor.page.id, source);
  }

  return targets;
}
