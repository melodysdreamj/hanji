// Native Hanji export/import document — the `.hanji.json` format and the
// pure id-remap engine that lets a page/database/workspace round-trip between
// two Hanji instances losslessly (files excluded by design).
//
// Design note: `duplicate-page.ts` performs the same class of remap for an
// in-instance clone, but it threads several id maps (pages/blocks/props-per-db)
// against a live database. A native import already knows every source id at
// export time, so it uses ONE global `oldId -> newId` map and rewrites every
// cross-reference in a single pure pass — no live two-pass relink. The helpers
// here are intentionally single-map and add file-stripping + user policy that
// the in-instance clone does not need, so they are kept separate rather than
// shared with duplicate-page.

import type { Block, Comment, DbProperty, DbTemplate, DbView, Page } from './app-types';

export const NATIVE_FORMAT = 'hanji.export';
export const NATIVE_FORMAT_VERSION = 1;

export interface NativeDocumentLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxEntities: number;
  maxPages: number;
  maxBlocks: number;
  maxDbProperties: number;
  maxDbViews: number;
  maxDbTemplates: number;
  maxComments: number;
}

// These synchronous-request bounds leave headroom over a large real-world
// workspace (~950 pages / ~14k blocks) without allowing a single authenticated
// request to enqueue hundreds of thousands of sequential writes. Larger
// workspaces must be split into subtree exports until native transfer moves to
// a resumable background job. The byte limit is UTF-8, not JS code units.
export const NATIVE_DOCUMENT_LIMITS: NativeDocumentLimits = Object.freeze({
  maxBytes: 12 * 1024 * 1024,
  maxDepth: 32,
  maxNodes: 250_000,
  maxEntities: 25_000,
  maxPages: 2_500,
  maxBlocks: 20_000,
  maxDbProperties: 5_000,
  maxDbViews: 2_500,
  maxDbTemplates: 2_500,
  maxComments: 10_000,
});

export type NativeScopeKind = 'workspace' | 'subtree';

export interface RelationPair {
  databaseId: string;
  propertyId: string;
  reciprocalDatabaseId: string;
  reciprocalPropertyId: string;
}

export interface NativeWarning {
  code:
    | 'stripped_file'
    | 'stripped_image_icon'
    | 'stripped_cover'
    | 'out_of_scope_relation'
    | 'dropped_person'
    | 'dropped_block'
    | 'dropped_relation_target'
    | 'dropped_unknown_property'
    | 'redacted_sensitive_metadata';
  entityId?: string;
  detail?: string;
}

export interface NativeEntities {
  pages: Page[];
  blocks: Block[];
  dbProperties: DbProperty[];
  dbViews: DbView[];
  dbTemplates: DbTemplate[];
  comments: Comment[];
}

export interface NativeExportEnvelope {
  format: typeof NATIVE_FORMAT;
  formatVersion: number;
  generatedAt: string;
  app?: { name: string; version?: string };
  scope: { kind: NativeScopeKind; rootIds: string[] };
  source: { workspaceId: string; workspaceName?: string; workspaceIcon?: string };
  counts: Record<string, number>;
  files: { included: false; strippedReferences: number };
  entities: NativeEntities;
  relationPairs: RelationPair[];
  warnings: NativeWarning[];
}

function cloneJson<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isWebUrl(value: unknown): value is string {
  return typeof value === 'string' && /^(?:https?:)?\/\//i.test(value.trim());
}

const ALWAYS_REDACTED_KEYS = new Set([
  'actorid',
  'authorid',
  'createdby',
  'lasteditedby',
  'verifiedby',
  'userid',
  'actor_id',
  'author_id',
  'created_by',
  'last_edited_by',
  'verified_by',
  'user_id',
]);
const SECRET_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'credential',
  'apikey',
  'signature',
  'signedurl',
]);
const SECRET_KEY_RE = /(?:^|_)(?:access_?token|refresh_?token|token|secret|password|authorization|cookie|credential|api_?key|signature|signed_?url)(?:$|_)/i;
const METADATA_URL_KEY_RE = /(?:^|_)(?:url|uri|href|avatar|avatar_?url|file|external)(?:$|_)/i;
const METADATA_PII_KEY_RE = /(?:^|_)(?:email|phone|phone_?number|owner|bot|person|people)(?:$|_)/i;
const METADATA_CONTAINER_KEYS = new Set([
  'notion',
  'sourcemetadata',
  'importmetadata',
  'rawnotion',
  'rawpayload',
]);

interface RedactionState {
  redacted: number;
}

// Native content may legitimately contain a URL/email property. We preserve
// those ordinary property values. Redaction becomes aggressive only inside
// source/import metadata (`__notion`, `config.notion`, etc.), while actor/user
// ids and secret-shaped fields are removed at every depth.
function redactNativeValue(
  value: unknown,
  state: RedactionState,
  metadataContext = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactNativeValue(entry, state, metadataContext));
  }
  if (!isRecord(value)) {
    if (metadataContext && isWebUrl(value)) {
      state.redacted += 1;
      return undefined;
    }
    return value;
  }

  const objectKind = typeof value.object === 'string' ? value.object.toLowerCase() : '';
  const typeKind = typeof value.type === 'string' ? value.type.toLowerCase() : '';
  const looksLikeUser = metadataContext && (
    objectKind === 'user' ||
    typeKind === 'person' ||
    ('person' in value && isRecord(value.person))
  );
  if (looksLikeUser) {
    state.redacted += 1;
    return { object: objectKind || 'user', redacted: true };
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (normalized === '__notion') {
      state.redacted += 1;
      continue;
    }
    if (ALWAYS_REDACTED_KEYS.has(normalized) || SECRET_KEYS.has(normalized) || SECRET_KEY_RE.test(normalized)) {
      state.redacted += 1;
      continue;
    }
    const childMetadataContext = metadataContext || METADATA_CONTAINER_KEYS.has(normalized) || normalized.startsWith('__notion');
    if (childMetadataContext && (METADATA_URL_KEY_RE.test(normalized) || METADATA_PII_KEY_RE.test(normalized))) {
      state.redacted += 1;
      continue;
    }
    const next = redactNativeValue(raw, state, childMetadataContext);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

export function redactNativeExportValue(value: unknown): { value: unknown; redacted: number } {
  const state: RedactionState = { redacted: 0 };
  return { value: redactNativeValue(value, state), redacted: state.redacted };
}

// ─── File stripping (EXPORT side) ────────────────────────────────────────────
// Files are excluded from the native format by product decision. On export we
// replace every attachment reference with a name-only placeholder so nothing
// silently vanishes (the import contract wants explicit placeholders), and the
// file bytes/URLs never leave the source instance.

function attachmentName(item: unknown): string {
  if (typeof item === 'string') return item.split(/[/?#]/).filter(Boolean).at(-1) || 'File';
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    const name = record.name ?? record.fileName;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return 'File';
}

// Convert a files-property value into name-only placeholders; returns the new
// value plus how many references were stripped.
export function stripFilesValue(value: unknown): { value: unknown; stripped: number } {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  if (items.length === 0) return { value, stripped: 0 };
  let stripped = 0;
  const placeholders = items.map((item) => {
    const alreadyStripped = isRecord(item) && item.strippedFile === true &&
      !['url', 'src', 'href', 'uploadId', 'fileKey', 'key', 'storageKey'].some((key) => key in item);
    if (!alreadyStripped) stripped += 1;
    return { name: attachmentName(item), strippedFile: true as const };
  });
  return { value: placeholders, stripped };
}

const MEDIA_BLOCK_TYPES = new Set(['image', 'file', 'video', 'audio', 'pdf', 'bookmark', 'embed']);

// Strip the hosted URL/key from a media block's content, keeping caption/name.
export function stripBlockContentFiles(
  type: string,
  content: Record<string, unknown> | undefined,
): { content: Record<string, unknown> | undefined; stripped: number } {
  if (!content) return { content, stripped: 0 };
  let stripped = 0;
  let next = content;
  if (MEDIA_BLOCK_TYPES.has(type)) {
    const url = content.url ?? content.src ?? content.href;
    const hasFile = typeof url === 'string' && !!url.trim();
    const uploadKeys = ['url', 'src', 'href', 'uploadId', 'fileKey', 'key', 'storageKey'];
    const hasReference = uploadKeys.some((key) => key in content);
    if (hasReference) {
      next = cloneJson(content);
      for (const key of uploadKeys) delete next[key];
      next.strippedFile = true;
      if (hasFile || content.strippedFile !== true) stripped += 1;
    }
  }
  if (Array.isArray(next.buttonTemplate)) {
    if (next === content) next = cloneJson(content);
    const nested = stripTemplateBlocksFiles(next.buttonTemplate);
    next.buttonTemplate = nested.blocks;
    stripped += nested.stripped;
  }
  return { content: next, stripped };
}

export function stripTemplateBlocksFiles(blocks: unknown): { blocks: unknown[]; stripped: number } {
  if (!Array.isArray(blocks)) return { blocks: [], stripped: 0 };
  let stripped = 0;
  const next = blocks.map((entry) => {
    if (!isRecord(entry)) return entry;
    const block = cloneJson(entry);
    const result = stripBlockContentFiles(typeof block.type === 'string' ? block.type : '', isRecord(block.content) ? block.content : undefined);
    if (result.content !== undefined) block.content = result.content;
    stripped += result.stripped;
    if (Array.isArray(block.children)) {
      const children = stripTemplateBlocksFiles(block.children);
      block.children = children.blocks;
      stripped += children.stripped;
    }
    return block;
  });
  return { blocks: next, stripped };
}

export interface SanitizedNativeEntities {
  entities: NativeEntities;
  warnings: NativeWarning[];
  strippedReferences: number;
}

const PERSON_PROPERTY_TYPES = new Set(['person', 'people', 'created_by', 'last_edited_by']);

function redactedRecord(
  value: Record<string, unknown> | undefined,
): { value: Record<string, unknown> | undefined; redacted: number } {
  if (!value) return { value, redacted: 0 };
  const result = redactNativeExportValue(value);
  return {
    value: isRecord(result.value) ? result.value : {},
    redacted: result.redacted,
  };
}

// Applies the export boundary in one place. It is also run on import so a
// hand-authored/hostile file cannot bypass the documented files/person/source
// metadata exclusions merely by skipping our exporter.
export function sanitizeNativeEntitiesForExport(entities: NativeEntities): SanitizedNativeEntities {
  const warnings: NativeWarning[] = [];
  let strippedReferences = 0;
  const propTypesByDb = new Map<string, Map<string, string>>();
  for (const prop of entities.dbProperties) {
    const types = propTypesByDb.get(prop.databaseId) ?? new Map<string, string>();
    types.set(prop.id, prop.type);
    propTypesByDb.set(prop.databaseId, types);
  }

  const pages = entities.pages.map((page) => {
    const next = cloneJson(page);
    delete next.verifiedAt;
    delete next.verifiedBy;
    delete next.verificationExpiresAt;
    delete next.createdBy;
    delete next.lastEditedBy;
    next.isFavorite = false;
    next.inTrash = false;
    delete next.trashedAt;
    if (next.iconType === 'image') {
      next.icon = '';
      next.iconType = 'none';
      warnings.push({ code: 'stripped_image_icon', entityId: page.id });
    }
    if (typeof next.cover === 'string' && next.cover.length > 0) {
      delete next.cover;
      delete next.coverPosition;
      warnings.push({ code: 'stripped_cover', entityId: page.id });
    }

    if (isRecord(next.properties)) {
      const properties = { ...next.properties };
      const types = page.parentType === 'database' && page.parentId
        ? propTypesByDb.get(page.parentId)
        : undefined;
      for (const [propertyId, raw] of Object.entries(properties)) {
        const type = types?.get(propertyId);
        if (type === 'files') {
          const result = stripFilesValue(raw);
          properties[propertyId] = result.value;
          strippedReferences += result.stripped;
          if (result.stripped > 0) {
            warnings.push({ code: 'stripped_file', entityId: page.id, detail: `property ${propertyId}` });
          }
        } else if (type && PERSON_PROPERTY_TYPES.has(type)) {
          delete properties[propertyId];
          warnings.push({ code: 'dropped_person', entityId: page.id, detail: `property ${propertyId}` });
        }
      }
      const redacted = redactedRecord(properties);
      next.properties = redacted.value;
      if (redacted.redacted > 0) {
        warnings.push({ code: 'redacted_sensitive_metadata', entityId: page.id, detail: `${redacted.redacted} field(s)` });
      }
    }
    return next;
  });

  const blocks = entities.blocks.map((block) => {
    const next = cloneJson(block);
    delete next.createdBy;
    const files = stripBlockContentFiles(next.type, next.content);
    next.content = files.content;
    strippedReferences += files.stripped;
    if (files.stripped > 0) {
      warnings.push({ code: 'stripped_file', entityId: block.id, detail: block.type });
    }
    const redacted = redactedRecord(next.content);
    next.content = redacted.value;
    if (redacted.redacted > 0) {
      warnings.push({ code: 'redacted_sensitive_metadata', entityId: block.id, detail: `${redacted.redacted} field(s)` });
    }
    return next;
  });

  const dbProperties = entities.dbProperties.map((property) => {
    const next = cloneJson(property);
    const redacted = redactedRecord(next.config);
    next.config = redacted.value;
    if (redacted.redacted > 0) {
      warnings.push({ code: 'redacted_sensitive_metadata', entityId: property.id, detail: `${redacted.redacted} field(s)` });
    }
    return next;
  });

  const dbViews = entities.dbViews.map((view) => {
    const next = cloneJson(view);
    const redacted = redactedRecord(next.config);
    next.config = redacted.value;
    if (redacted.redacted > 0) {
      warnings.push({ code: 'redacted_sensitive_metadata', entityId: view.id, detail: `${redacted.redacted} field(s)` });
    }
    return next;
  });

  const dbTemplates = entities.dbTemplates.map((template) => {
    const next = cloneJson(template);
    const types = propTypesByDb.get(template.databaseId);
    if (isRecord(next.properties)) {
      const properties = { ...next.properties };
      for (const [propertyId, raw] of Object.entries(properties)) {
        const type = types?.get(propertyId);
        if (type === 'files') {
          const result = stripFilesValue(raw);
          properties[propertyId] = result.value;
          strippedReferences += result.stripped;
          if (result.stripped > 0) {
            warnings.push({ code: 'stripped_file', entityId: template.id, detail: `property ${propertyId}` });
          }
        } else if (type && PERSON_PROPERTY_TYPES.has(type)) {
          delete properties[propertyId];
          warnings.push({ code: 'dropped_person', entityId: template.id, detail: `property ${propertyId}` });
        }
      }
      const redacted = redactedRecord(properties);
      next.properties = redacted.value;
      if (redacted.redacted > 0) {
        warnings.push({ code: 'redacted_sensitive_metadata', entityId: template.id, detail: `${redacted.redacted} field(s)` });
      }
    }
    const files = stripTemplateBlocksFiles(next.blocks);
    next.blocks = files.blocks;
    strippedReferences += files.stripped;
    if (files.stripped > 0) {
      warnings.push({ code: 'stripped_file', entityId: template.id, detail: 'template blocks' });
    }
    const redacted = redactNativeExportValue(next.blocks);
    next.blocks = Array.isArray(redacted.value) ? redacted.value : [];
    if (redacted.redacted > 0) {
      warnings.push({ code: 'redacted_sensitive_metadata', entityId: template.id, detail: `${redacted.redacted} field(s)` });
    }
    if (isWebUrl(next.icon)) delete next.icon;
    return next;
  });

  const comments = entities.comments.map((comment) => {
    const next = cloneJson(comment);
    next.authorId = '';
    const redacted = redactNativeExportValue(next.body);
    next.body = redacted.value;
    if (redacted.redacted > 0) {
      warnings.push({ code: 'redacted_sensitive_metadata', entityId: comment.id, detail: `${redacted.redacted} field(s)` });
    }
    return next;
  });

  return {
    entities: { pages, blocks, dbProperties, dbViews, dbTemplates, comments },
    warnings,
    strippedReferences,
  };
}

// ─── Reference remap (IMPORT side) ───────────────────────────────────────────

function remapRelationArray(value: unknown, idMap: Map<string, string>): { value: unknown; dropped: number } {
  const ids = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  if (ids.length === 0) return { value, dropped: 0 };
  const mapped: string[] = [];
  let dropped = 0;
  for (const id of ids) {
    const next = typeof id === 'string' ? idMap.get(id) : undefined;
    if (next) mapped.push(next);
    else dropped += 1; // target lives outside the exported set → unresolved
  }
  return { value: Array.isArray(value) ? mapped : mapped[0] ?? null, dropped };
}

function remapRecordKeys(record: unknown, idMap: Map<string, string>): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    const mapped = idMap.get(key);
    if (mapped) next[mapped] = value;
  }
  return next;
}

function remapPropertyIdField(record: Record<string, unknown>, key: string, idMap: Map<string, string>) {
  if (typeof record[key] !== 'string') return;
  const mapped = idMap.get(record[key] as string);
  if (mapped) record[key] = mapped;
  else delete record[key];
}

function remapFilterGroup(group: Record<string, unknown>, idMap: Map<string, string>): Record<string, unknown> {
  return {
    ...group,
    filters: Array.isArray(group.filters)
      ? group.filters.map((filter) => {
          if (!filter || typeof filter !== 'object') return filter;
          const next = { ...(filter as Record<string, unknown>) };
          remapPropertyIdField(next, 'propertyId', idMap);
          return next;
        })
      : group.filters,
    groups: Array.isArray(group.groups)
      ? group.groups.map((sub) =>
          sub && typeof sub === 'object' ? remapFilterGroup(sub as Record<string, unknown>, idMap) : sub,
        )
      : group.groups,
  };
}

const VIEW_PROPERTY_ID_KEYS = [
  'groupBy',
  'subGroupBy',
  'calendarBy',
  'timelineBy',
  'timelineEndBy',
  'dependencyProperty',
  'coverProperty',
  'chartGroupBy',
  'chartAggregateBy',
];

export function remapViewConfig(config: Record<string, unknown> | undefined, idMap: Map<string, string>) {
  const next = cloneJson(config ?? {});
  const mapList = (value: unknown) => {
    if (!Array.isArray(value)) return value;
    return value.flatMap((id) => {
      if (typeof id !== 'string') return [];
      const mapped = idMap.get(id);
      return mapped ? [mapped] : [];
    });
  };
  next.visibleProperties = mapList(next.visibleProperties);
  next.hiddenProperties = mapList(next.hiddenProperties);
  next.propertyOrder = mapList(next.propertyOrder);
  next.rowPagePropertyOrder = mapList(next.rowPagePropertyOrder);
  next.wrappedColumns = mapList(next.wrappedColumns);
  next.propertyWidths = remapRecordKeys(next.propertyWidths, idMap);
  next.tableCalculations = remapRecordKeys(next.tableCalculations, idMap);
  if (Array.isArray(next.filters)) {
    next.filters = next.filters.map((filter) => {
      if (!filter || typeof filter !== 'object') return filter;
      const term = { ...(filter as Record<string, unknown>) };
      remapPropertyIdField(term, 'propertyId', idMap);
      return term;
    });
  }
  if (Array.isArray(next.quickFilters)) {
    next.quickFilters = next.quickFilters.map((filter) => {
      if (!filter || typeof filter !== 'object') return filter;
      const term = { ...(filter as Record<string, unknown>) };
      remapPropertyIdField(term, 'propertyId', idMap);
      return term;
    });
  }
  if (next.filterGroup && typeof next.filterGroup === 'object') {
    next.filterGroup = remapFilterGroup(next.filterGroup as Record<string, unknown>, idMap);
  }
  if (Array.isArray(next.sorts)) {
    next.sorts = next.sorts.map((sort) => {
      if (!sort || typeof sort !== 'object') return sort;
      const term = { ...(sort as Record<string, unknown>) };
      remapPropertyIdField(term, 'propertyId', idMap);
      return term;
    });
  }
  for (const key of VIEW_PROPERTY_ID_KEYS) {
    remapPropertyIdField(next, key, idMap);
  }
  return next;
}

function remapMentionSpans(spans: unknown, idMap: Map<string, string>, keepUserIds: boolean): unknown {
  if (!Array.isArray(spans)) return spans;
  return spans.map((span) => {
    if (!span || typeof span !== 'object') return span;
    const next = { ...(span as Record<string, unknown>) };
    for (const key of ['pageId', 'commentId']) {
      if (typeof next[key] !== 'string') continue;
      const mapped = idMap.get(next[key] as string);
      if (mapped) next[key] = mapped;
      else delete next[key];
    }
    if (!keepUserIds) delete next.userId;
    return next;
  });
}

function remapTemplateBlocks(blocks: unknown, idMap: Map<string, string>, keepUserIds: boolean): unknown {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const record = cloneJson(block as Record<string, unknown>);
    record.content = remapBlockContent(record.content as Record<string, unknown> | undefined, idMap, keepUserIds);
    record.children = remapTemplateBlocks(record.children, idMap, keepUserIds);
    return record;
  });
}

export function remapBlockContent(
  content: Record<string, unknown> | undefined,
  idMap: Map<string, string>,
  keepUserIds = false,
): Record<string, unknown> | undefined {
  if (!content) return content;
  const next = cloneJson(content);
  for (const key of ['childPageId', 'syncedBlockId', 'syncedPageId', 'databaseViewId']) {
    if (typeof next[key] !== 'string') continue;
    const mapped = idMap.get(next[key] as string);
    if (mapped) next[key] = mapped;
    else delete next[key];
  }
  if (Array.isArray(next.databaseViewIds)) {
    next.databaseViewIds = next.databaseViewIds.flatMap((id) => {
      if (typeof id !== 'string') return [];
      const mapped = idMap.get(id);
      return mapped ? [mapped] : [];
    });
  }
  if (next.templateSelfFilter && typeof next.templateSelfFilter === 'object') {
    const filter = { ...(next.templateSelfFilter as Record<string, unknown>) };
    for (const key of ['sourceDatabaseId', 'relationPropertyId']) {
      if (typeof filter[key] !== 'string') continue;
      const mapped = idMap.get(filter[key] as string);
      if (mapped) filter[key] = mapped;
      else delete filter[key];
    }
    next.templateSelfFilter = filter;
  }
  next.rich = remapMentionSpans(next.rich, idMap, keepUserIds);
  next.caption = remapMentionSpans(next.caption, idMap, keepUserIds);
  next.buttonTemplate = remapTemplateBlocks(next.buttonTemplate, idMap, keepUserIds);
  return next;
}

export function remapPropertyConfig(
  type: string,
  config: Record<string, unknown> | undefined,
  idMap: Map<string, string>,
): Record<string, unknown> | undefined {
  if (!config) return config;
  const next = cloneJson(config);
  if (typeof next.relationDatabaseId === 'string') {
    const mapped = idMap.get(next.relationDatabaseId);
    if (mapped) next.relationDatabaseId = mapped;
    else delete next.relationDatabaseId;
  }
  for (const key of ['rollupRelationPropertyId', 'rollupTargetPropertyId', 'rollupVia']) {
    if (typeof next[key] !== 'string') continue;
    const mapped = idMap.get(next[key] as string);
    if (mapped) next[key] = mapped;
    else delete next[key];
  }
  // Formula expressions reference property NAMES (prop("Name")), which are
  // carried verbatim, so no id remap is needed for `formula`.
  void type;
  return next;
}

export interface RemapOptions {
  // old propertyId -> property type, used to know which row values are relations
  // (id arrays) or people (cross-instance user ids).
  propTypeByOldId: Map<string, string>;
  // Keep person/people property values and person mentions. Default false: user
  // ids differ across instances, so person values are dropped with a warning.
  keepUserIds?: boolean;
}

function remapPropertiesRecord(
  properties: Record<string, unknown> | undefined,
  idMap: Map<string, string>,
  opts: RemapOptions,
  warnings: NativeWarning[],
  entityId: string,
): Record<string, unknown> | undefined {
  if (!properties) return properties;
  const out: Record<string, unknown> = {};
  for (const [oldKey, rawValue] of Object.entries(properties)) {
    if (oldKey.startsWith('__')) {
      out[oldKey] = rawValue; // preserve internal placeholders (e.g. unresolved)
      continue;
    }
    const type = opts.propTypeByOldId.get(oldKey);
    const newKey = idMap.get(oldKey);
    if (!type || !newKey) {
      warnings.push({ code: 'dropped_unknown_property', entityId, detail: `property ${oldKey}` });
      continue;
    }
    if (type === 'person' && !opts.keepUserIds) {
      warnings.push({ code: 'dropped_person', entityId, detail: `property ${oldKey}` });
      continue;
    }
    if (type === 'relation') {
      const { value, dropped } = remapRelationArray(rawValue, idMap);
      if (dropped > 0) {
        warnings.push({ code: 'dropped_relation_target', entityId, detail: `${dropped} target(s)` });
      }
      out[newKey] = value;
      continue;
    }
    out[newKey] = rawValue;
  }
  return out;
}

export interface RemappedDocument {
  pages: Page[];
  blocks: Block[];
  dbProperties: DbProperty[];
  dbViews: DbView[];
  dbTemplates: DbTemplate[];
  comments: Comment[];
  warnings: NativeWarning[];
}

// Pure: rewrites every id reference in the document through `idMap`. Does NOT
// touch workspaceId / createdBy / root re-parenting — the caller applies those
// after remap (see writeNativeDocument). This is the unit-test seam.
export function remapNativeDocument(
  entities: NativeEntities,
  idMap: Map<string, string>,
  opts: RemapOptions,
): RemappedDocument {
  const warnings: NativeWarning[] = [];
  const has = (id: string) => idMap.has(id);

  const pages: Page[] = entities.pages.map((page) => {
    const next = cloneJson(page);
    next.id = idMap.get(page.id) ?? page.id;
    next.parentId = page.parentType === 'workspace'
      ? null
      : typeof page.parentId === 'string'
        ? idMap.get(page.parentId) ?? null
        : null;
    next.properties = remapPropertiesRecord(page.properties, idMap, opts, warnings, page.id);
    return next;
  });

  const blocks: Block[] = [];
  for (const block of entities.blocks) {
    if (!has(block.pageId)) {
      warnings.push({ code: 'dropped_block', entityId: block.id, detail: 'page not in export' });
      continue;
    }
    const next = cloneJson(block);
    next.id = idMap.get(block.id) ?? block.id;
    next.pageId = idMap.get(block.pageId) ?? block.pageId;
    next.parentId = typeof block.parentId === 'string' ? idMap.get(block.parentId) ?? null : null;
    next.content = remapBlockContent(block.content, idMap, opts.keepUserIds === true);
    blocks.push(next);
  }

  const dbProperties: DbProperty[] = entities.dbProperties.map((prop) => {
    const next = cloneJson(prop);
    next.id = idMap.get(prop.id) ?? prop.id;
    next.databaseId = idMap.get(prop.databaseId) ?? prop.databaseId;
    next.config = remapPropertyConfig(prop.type, prop.config, idMap);
    return next;
  });

  const dbViews: DbView[] = entities.dbViews.map((view) => {
    const next = cloneJson(view);
    next.id = idMap.get(view.id) ?? view.id;
    next.databaseId = idMap.get(view.databaseId) ?? view.databaseId;
    next.config = remapViewConfig(view.config, idMap);
    return next;
  });

  const dbTemplates: DbTemplate[] = entities.dbTemplates.map((template) => {
    const next = cloneJson(template);
    next.id = idMap.get(template.id) ?? template.id;
    next.databaseId = idMap.get(template.databaseId) ?? template.databaseId;
    next.properties = remapPropertiesRecord(template.properties, idMap, opts, warnings, template.id);
    next.blocks = remapTemplateBlocks(template.blocks, idMap, opts.keepUserIds === true) as unknown[];
    return next;
  });

  const comments: Comment[] = [];
  for (const comment of entities.comments) {
    if (!has(comment.pageId)) continue; // comment's page not in export
    const next = cloneJson(comment);
    next.id = idMap.get(comment.id) ?? comment.id;
    next.pageId = idMap.get(comment.pageId) ?? comment.pageId;
    next.blockId = typeof comment.blockId === 'string' ? idMap.get(comment.blockId) ?? null : (comment.blockId ?? null);
    next.parentId =
      typeof comment.parentId === 'string' ? idMap.get(comment.parentId) ?? null : (comment.parentId ?? null);
    comments.push(next);
  }

  return { pages, blocks, dbProperties, dbViews, dbTemplates, comments, warnings };
}

// Build the property-type lookup an import needs (old propertyId -> type).
export function propTypeMap(dbProperties: DbProperty[]): Map<string, string> {
  return new Map(dbProperties.map((prop) => [prop.id, prop.type]));
}

const NATIVE_ID_MAX_LENGTH = 128;
const NATIVE_SHORT_TEXT_MAX_LENGTH = 4_096;
const NATIVE_CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function invalidNative(path: string, message: string): never {
  throw new Error(`Invalid Hanji export: ${path} ${message}`);
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalidNative(path, 'must be an object.');
  return value;
}

function requiredArray(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) invalidNative(path, 'must be an array.');
  if (value.length > max) invalidNative(path, `must have at most ${max} items.`);
  return value;
}

function requiredString(value: unknown, path: string, max = NATIVE_SHORT_TEXT_MAX_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0) invalidNative(path, 'must be a non-empty string.');
  if (value.length > max) invalidNative(path, `must be at most ${max} characters.`);
  return value;
}

function requiredId(value: unknown, path: string): string {
  const id = requiredString(value, path, NATIVE_ID_MAX_LENGTH);
  if (NATIVE_CONTROL_CHARS_RE.test(id)) invalidNative(path, 'contains invalid characters.');
  return id;
}

function optionalId(value: unknown, path: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredId(value, path);
}

function finitePosition(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidNative(path, 'must be a finite number.');
  return value;
}

function assertJsonBounds(value: unknown, limits: NativeDocumentLimits): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalidNative('document', 'must be serializable JSON.');
  }
  if (typeof serialized !== 'string') invalidNative('document', 'must be serializable JSON.');
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > limits.maxBytes) {
    throw new Error(`Native Hanji export payload is too large. Maximum size is ${limits.maxBytes} bytes.`);
  }

  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > limits.maxNodes) invalidNative('document', `must have at most ${limits.maxNodes} JSON nodes.`);
    if (!current.value || typeof current.value !== 'object') continue;
    if (current.depth >= limits.maxDepth) invalidNative('document', `must be at most ${limits.maxDepth} levels deep.`);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
}

function assertAcyclic(
  ids: Iterable<string>,
  parentFor: (id: string) => string | null,
  path: string,
): void {
  const complete = new Set<string>();
  for (const start of ids) {
    if (complete.has(start)) continue;
    const chain = new Set<string>();
    let current: string | null = start;
    while (current) {
      if (chain.has(current)) invalidNative(path, `contains a parent cycle at ${current}.`);
      if (complete.has(current)) break;
      chain.add(current);
      current = parentFor(current);
    }
    for (const id of chain) complete.add(id);
  }
}

// Full schema + entity-closure validation. In particular, database-owned rows
// can target only a database page included in this same document. That makes
// it impossible for an editable destination-parent grant to be abused to add
// schema/view/template rows to an unrelated existing destination database.
export function validateNativeEnvelope(
  value: unknown,
  limits: NativeDocumentLimits = NATIVE_DOCUMENT_LIMITS,
): NativeExportEnvelope {
  assertJsonBounds(value, limits);
  const document = requiredRecord(value, 'document');
  if (document.format !== NATIVE_FORMAT) invalidNative('format', `must equal "${NATIVE_FORMAT}".`);
  if (!Number.isInteger(document.formatVersion)) invalidNative('formatVersion', 'must be an integer.');
  if ((document.formatVersion as number) > NATIVE_FORMAT_VERSION) {
    throw new Error('This Hanji file was exported by a newer version of Hanji.');
  }
  if (document.formatVersion !== NATIVE_FORMAT_VERSION) {
    invalidNative('formatVersion', `must equal ${NATIVE_FORMAT_VERSION}.`);
  }
  requiredString(document.generatedAt, 'generatedAt');

  const scope = requiredRecord(document.scope, 'scope');
  if (scope.kind !== 'workspace' && scope.kind !== 'subtree') {
    invalidNative('scope.kind', 'must be workspace or subtree.');
  }
  const rootIds = requiredArray(scope.rootIds, 'scope.rootIds', limits.maxPages).map((id, index) =>
    requiredId(id, `scope.rootIds[${index}]`),
  );
  if (new Set(rootIds).size !== rootIds.length) invalidNative('scope.rootIds', 'must not contain duplicates.');
  const source = requiredRecord(document.source, 'source');
  const sourceWorkspaceId = requiredId(source.workspaceId, 'source.workspaceId');
  requiredRecord(document.counts, 'counts');
  const files = requiredRecord(document.files, 'files');
  if (files.included !== false) invalidNative('files.included', 'must be false for format version 1.');
  if (typeof files.strippedReferences !== 'number' || !Number.isSafeInteger(files.strippedReferences) || files.strippedReferences < 0) {
    invalidNative('files.strippedReferences', 'must be a non-negative safe integer.');
  }

  const rawEntities = requiredRecord(document.entities, 'entities');
  const rawPages = requiredArray(rawEntities.pages, 'entities.pages', limits.maxPages);
  const rawBlocks = requiredArray(rawEntities.blocks, 'entities.blocks', limits.maxBlocks);
  const rawDbProperties = requiredArray(rawEntities.dbProperties, 'entities.dbProperties', limits.maxDbProperties);
  const rawDbViews = requiredArray(rawEntities.dbViews, 'entities.dbViews', limits.maxDbViews);
  const rawDbTemplates = requiredArray(rawEntities.dbTemplates, 'entities.dbTemplates', limits.maxDbTemplates);
  const rawComments = requiredArray(rawEntities.comments, 'entities.comments', limits.maxComments);
  const entityCount = rawPages.length + rawBlocks.length + rawDbProperties.length +
    rawDbViews.length + rawDbTemplates.length + rawComments.length;
  if (entityCount > limits.maxEntities) {
    invalidNative('entities', `must contain at most ${limits.maxEntities} total items.`);
  }
  const rawRelationPairs = requiredArray(document.relationPairs, 'relationPairs', limits.maxDbProperties);
  requiredArray(document.warnings, 'warnings', limits.maxNodes);

  const allIds = new Map<string, string>();
  const register = (id: string, path: string) => {
    const previous = allIds.get(id);
    if (previous) invalidNative(path, `duplicates id ${id} already used by ${previous}.`);
    allIds.set(id, path);
  };

  const pages = rawPages.map((raw, index) => {
    const path = `entities.pages[${index}]`;
    const page = requiredRecord(raw, path);
    const id = requiredId(page.id, `${path}.id`);
    register(id, path);
    const workspaceId = requiredId(page.workspaceId, `${path}.workspaceId`);
    if (workspaceId !== sourceWorkspaceId) invalidNative(`${path}.workspaceId`, 'must match source.workspaceId.');
    if (page.parentType !== 'workspace' && page.parentType !== 'page' && page.parentType !== 'database') {
      invalidNative(`${path}.parentType`, 'must be workspace, page, or database.');
    }
    if (page.kind !== 'page' && page.kind !== 'database') invalidNative(`${path}.kind`, 'must be page or database.');
    const parentId = optionalId(page.parentId, `${path}.parentId`);
    finitePosition(page.position, `${path}.position`);
    return { record: page, id, parentId, parentType: page.parentType, kind: page.kind };
  });
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const databaseIds = new Set(pages.filter((page) => page.kind === 'database').map((page) => page.id));
  const declaredRootIds = new Set(rootIds);
  for (const [index, page] of pages.entries()) {
    const path = `entities.pages[${index}]`;
    if (page.parentType === 'workspace') {
      if (page.parentId && page.parentId !== sourceWorkspaceId) {
        invalidNative(`${path}.parentId`, 'must be null or source.workspaceId for a workspace root.');
      }
      if (!declaredRootIds.has(page.id)) invalidNative(path, 'workspace roots must appear in scope.rootIds.');
      continue;
    }
    if (!page.parentId) invalidNative(`${path}.parentId`, `is required for parentType ${page.parentType}.`);
    const parent = pagesById.get(page.parentId);
    if (!parent) invalidNative(`${path}.parentId`, 'must reference a page in this export.');
    if (page.parentType === 'database' && parent.kind !== 'database') {
      invalidNative(`${path}.parentId`, 'must reference an exported database.');
    }
    if (page.parentType === 'page' && parent.kind !== 'page') {
      invalidNative(`${path}.parentId`, 'must reference an exported regular page.');
    }
    if (page.kind === 'database' && page.parentType === 'database') {
      invalidNative(path, 'a database cannot be a row of another database.');
    }
  }
  assertAcyclic(
    pages.map((page) => page.id),
    (id) => {
      const page = pagesById.get(id);
      return page?.parentType === 'workspace' ? null : page?.parentId ?? null;
    },
    'entities.pages',
  );
  for (const [index, rootId] of rootIds.entries()) {
    const root = pagesById.get(rootId);
    if (!root) invalidNative(`scope.rootIds[${index}]`, 'must reference an exported page.');
    if (root.parentType !== 'workspace') invalidNative(`scope.rootIds[${index}]`, 'must reference an export root.');
  }

  const blocks = rawBlocks.map((raw, index) => {
    const path = `entities.blocks[${index}]`;
    const block = requiredRecord(raw, path);
    const id = requiredId(block.id, `${path}.id`);
    register(id, path);
    const pageId = requiredId(block.pageId, `${path}.pageId`);
    if (!pagesById.has(pageId)) invalidNative(`${path}.pageId`, 'must reference a page in this export.');
    const parentId = optionalId(block.parentId, `${path}.parentId`);
    requiredString(block.type, `${path}.type`);
    finitePosition(block.position, `${path}.position`);
    return { record: block, id, pageId, parentId };
  });
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  for (const [index, block] of blocks.entries()) {
    if (!block.parentId) continue;
    const parent = blocksById.get(block.parentId);
    if (!parent || parent.pageId !== block.pageId) {
      invalidNative(`entities.blocks[${index}].parentId`, 'must reference a block on the same exported page.');
    }
  }
  assertAcyclic(blocks.map((block) => block.id), (id) => blocksById.get(id)?.parentId ?? null, 'entities.blocks');

  const dbProperties = rawDbProperties.map((raw, index) => {
    const path = `entities.dbProperties[${index}]`;
    const property = requiredRecord(raw, path);
    const id = requiredId(property.id, `${path}.id`);
    register(id, path);
    const databaseId = requiredId(property.databaseId, `${path}.databaseId`);
    if (!databaseIds.has(databaseId)) invalidNative(`${path}.databaseId`, 'must reference a database in this export.');
    requiredString(property.name, `${path}.name`);
    requiredString(property.type, `${path}.type`);
    finitePosition(property.position, `${path}.position`);
    return { record: property, id, databaseId };
  });
  const propertiesById = new Map(dbProperties.map((property) => [property.id, property]));

  const validateDbOwned = (raw: unknown, index: number, collection: 'dbViews' | 'dbTemplates') => {
    const path = `entities.${collection}[${index}]`;
    const entity = requiredRecord(raw, path);
    const id = requiredId(entity.id, `${path}.id`);
    register(id, path);
    const databaseId = requiredId(entity.databaseId, `${path}.databaseId`);
    if (!databaseIds.has(databaseId)) invalidNative(`${path}.databaseId`, 'must reference a database in this export.');
    requiredString(entity.name, `${path}.name`);
    finitePosition(entity.position, `${path}.position`);
    return { entity, id, databaseId };
  };
  rawDbViews.forEach((raw, index) => {
    const validated = validateDbOwned(raw, index, 'dbViews');
    requiredString(validated.entity.type, `entities.dbViews[${index}].type`);
  });
  rawDbTemplates.forEach((raw, index) => validateDbOwned(raw, index, 'dbTemplates'));

  const comments = rawComments.map((raw, index) => {
    const path = `entities.comments[${index}]`;
    const comment = requiredRecord(raw, path);
    const id = requiredId(comment.id, `${path}.id`);
    register(id, path);
    const pageId = requiredId(comment.pageId, `${path}.pageId`);
    if (!pagesById.has(pageId)) invalidNative(`${path}.pageId`, 'must reference a page in this export.');
    const blockId = optionalId(comment.blockId, `${path}.blockId`);
    const parentId = optionalId(comment.parentId, `${path}.parentId`);
    return { id, pageId, blockId, parentId };
  });
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
  for (const [index, comment] of comments.entries()) {
    if (comment.blockId) {
      const block = blocksById.get(comment.blockId);
      if (!block || block.pageId !== comment.pageId) {
        invalidNative(`entities.comments[${index}].blockId`, 'must reference a block on the same exported page.');
      }
    }
    if (comment.parentId) {
      const parent = commentsById.get(comment.parentId);
      if (!parent || parent.pageId !== comment.pageId) {
        invalidNative(`entities.comments[${index}].parentId`, 'must reference a comment on the same exported page.');
      }
    }
  }
  assertAcyclic(comments.map((comment) => comment.id), (id) => commentsById.get(id)?.parentId ?? null, 'entities.comments');

  rawRelationPairs.forEach((raw, index) => {
    const path = `relationPairs[${index}]`;
    const pair = requiredRecord(raw, path);
    const databaseId = requiredId(pair.databaseId, `${path}.databaseId`);
    const propertyId = requiredId(pair.propertyId, `${path}.propertyId`);
    const reciprocalDatabaseId = requiredId(pair.reciprocalDatabaseId, `${path}.reciprocalDatabaseId`);
    const reciprocalPropertyId = requiredId(pair.reciprocalPropertyId, `${path}.reciprocalPropertyId`);
    const property = propertiesById.get(propertyId);
    const reciprocal = propertiesById.get(reciprocalPropertyId);
    if (!databaseIds.has(databaseId) || property?.databaseId !== databaseId || property.record.type !== 'relation') {
      invalidNative(path, 'must reference an exported relation property and its owning database.');
    }
    if (!databaseIds.has(reciprocalDatabaseId) || reciprocal?.databaseId !== reciprocalDatabaseId || reciprocal.record.type !== 'relation') {
      invalidNative(path, 'must reference an exported reciprocal relation and its owning database.');
    }
  });

  return value as NativeExportEnvelope;
}

// Cheap discriminator for callers that only need to distinguish this file
// family. Import entry points must call validateNativeEnvelope before use.
export function isNativeEnvelope(value: unknown): value is NativeExportEnvelope {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.format !== NATIVE_FORMAT) return false;
  const entities = record.entities as Record<string, unknown> | undefined;
  if (!entities || typeof entities !== 'object') return false;
  return Array.isArray(entities.pages);
}
