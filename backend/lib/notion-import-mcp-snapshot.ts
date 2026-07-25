import { newId } from './table-utils';
import {
  DATABASE_PROPERTY_TYPES,
  OMIT_DATABASE_PROPERTY_IMPORT_VALUE,
  normalizeDatabasePropertyImportValue,
} from './database-property-types';
import {
  NOTION_DATABASE_VIEW_TYPES,
  normalizeDatabaseViewStorageRecord,
} from './database-view-types';
import {
  NOTION_IMPORT_MCP_EMBEDDED_JSON_AGGREGATE_MAX_BYTES,
  NOTION_IMPORT_MCP_EMBEDDED_JSON_MAX_BYTES,
  NOTION_IMPORT_MCP_FETCH_PAYLOADS_PER_REQUEST_MAX,
  NOTION_IMPORT_MCP_TEXT_MAX_BYTES,
  NOTION_IMPORT_MCP_VIEW_ASSIGNMENT_WORK_MAX,
  NOTION_IMPORT_REQUEST_JSON_MAX_DEPTH,
  NOTION_IMPORT_REQUEST_JSON_MAX_NODES,
  NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX,
  assertBoundedSnapshotJsonValue,
  assertNotionImportJsonShape,
  boundedUtf8Bytes,
  normalizedNotionId,
  notionImportPayloadTooLarge,
  type DiscoveredNotionItem,
  type NotionImportJsonShapeBudget,
  type NotionImportRequestJsonBudget,
} from './notion-import-request-limits';

const NOTION_IMPORT_ITEM_SAFETY_LIMIT = 100_000;
const MCP_SNAPSHOT_WARNINGS_PER_ITEM_MAX = 100;
const SUPPORTED_NOTION_PROPERTY_TYPES = new Set<string>([
  ...DATABASE_PROPERTY_TYPES,
  'people',
  'phone_number',
]);
const SUPPORTED_MCP_SNAPSHOT_VIEW_TYPES = new Set<string>(
  NOTION_DATABASE_VIEW_TYPES,
);

interface McpSnapshotWarning {
  code: string;
  message: string;
  notionId?: string;
  notionObject?: string;
}

interface McpSnapshotWarningBag {
  warnings: McpSnapshotWarning[];
  total: number;
}

function mcpSnapshotWarningBag(): McpSnapshotWarningBag {
  return { warnings: [], total: 0 };
}

function pushMcpSnapshotWarning(
  bag: McpSnapshotWarningBag,
  warning: McpSnapshotWarning,
) {
  bag.total += 1;
  if (bag.warnings.length < MCP_SNAPSHOT_WARNINGS_PER_ITEM_MAX) {
    bag.warnings.push(warning);
  }
}

function mcpSnapshotWarningMetadata(bag: McpSnapshotWarningBag) {
  return {
    mcpSnapshotWarnings: bag.warnings,
    mcpSnapshotWarningsTruncated: Math.max(
      0,
      bag.total - bag.warnings.length,
    ),
  };
}

function mcpSnapshotValidationMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function optionColor(color: unknown) {
  return typeof color === 'string' && color.trim() ? color.trim() : 'default';
}

function notionPropertyConfig(prop: Record<string, unknown>, notionType: string) {
  return prop[notionType] && typeof prop[notionType] === 'object'
    ? prop[notionType] as Record<string, unknown>
    : {};
}

function fileNameFromUrl(url: string) {
  const value = url.trim();
  if (!value) return 'Untitled';
  try {
    const pathname = new URL(value).pathname;
    return decodeURIComponent(pathname.split('/').filter(Boolean).at(-1) ?? '') || 'Untitled';
  } catch {
    return decodeURIComponent(value.split('/').filter(Boolean).at(-1) ?? '') || 'Untitled';
  }
}

function mergeMetadata(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
) {
  const merged = { ...(current ?? {}), ...(next ?? {}) };
  if (next && Object.hasOwn(next, 'mcpSnapshotWarnings')) {
    if (!Array.isArray(next.mcpSnapshotWarnings) || next.mcpSnapshotWarnings.length === 0) {
      delete merged.mcpSnapshotWarnings;
    }
  }
  if (next && Object.hasOwn(next, 'mcpSnapshotWarningsTruncated')) {
    if (
      typeof next.mcpSnapshotWarningsTruncated !== 'number' ||
      next.mcpSnapshotWarningsTruncated <= 0
    ) {
      delete merged.mcpSnapshotWarningsTruncated;
    }
  }
  return merged;
}

function putDiscoveredItem(items: Map<string, DiscoveredNotionItem>, item: DiscoveredNotionItem) {
  const existing = items.get(item.notionId);
  if (!existing) {
    items.set(item.notionId, item.metadata
      ? { ...item, metadata: mergeMetadata(undefined, item.metadata) }
      : item);
    return;
  }
  const keepExistingSnapshotPhase =
    typeof existing.phase === 'string' &&
    existing.phase.includes('snapshot') &&
    !(typeof item.phase === 'string' && item.phase.includes('snapshot'));
  items.set(item.notionId, {
    ...existing,
    ...item,
    title: item.title || existing.title,
    status: existing.status === 'discovered' && item.status === 'referenced'
      ? existing.status
      : item.status ?? existing.status,
    phase: keepExistingSnapshotPhase ? existing.phase : item.phase ?? existing.phase,
    parentNotionId: item.parentNotionId ?? existing.parentNotionId,
    metadata: mergeMetadata(existing.metadata, item.metadata),
    error: item.error ?? existing.error,
  });
}

function notionObjectId(record: Record<string, unknown>) {
  return typeof record.id === 'string' && record.id.trim() ? record.id.trim() : undefined;
}

function itemMetadata(item: DiscoveredNotionItem) {
  return item.metadata && typeof item.metadata === 'object'
    ? item.metadata as Record<string, unknown>
    : {};
}

function dataSourceSnapshot(item: DiscoveredNotionItem) {
  const snapshot = itemMetadata(item).dataSourceSnapshot;
  return snapshot && typeof snapshot === 'object'
    ? snapshot as Record<string, unknown>
    : undefined;
}

function notionPropertiesFromSnapshot(snapshot: Record<string, unknown> | undefined) {
  const dataSource = snapshot?.dataSource;
  if (!dataSource || typeof dataSource !== 'object') return {};
  const properties = (dataSource as Record<string, unknown>).properties;
  return properties && typeof properties === 'object'
    ? properties as Record<string, unknown>
    : {};
}

interface McpFetchPayload {
  text: string;
  title?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

interface McpEmbeddedJsonBudget {
  bytes: number;
  shape: NotionImportJsonShapeBudget;
}

interface McpTransformWorkBudget {
  viewInspections: number;
}

interface HtmlTagBlock {
  attributes: string;
  content: string;
  raw: string;
}

function parseJsonLike(
  value: string,
  budget: McpEmbeddedJsonBudget,
  baseDepth: number,
  label: string,
) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  const bytes = boundedUtf8Bytes(
    trimmed,
    NOTION_IMPORT_MCP_EMBEDDED_JSON_MAX_BYTES,
    `${label} embedded JSON`,
  );
  budget.bytes += bytes;
  if (budget.bytes > NOTION_IMPORT_MCP_EMBEDDED_JSON_AGGREGATE_MAX_BYTES) {
    notionImportPayloadTooLarge(
      `mcpFetches embedded JSON exceeds ${NOTION_IMPORT_MCP_EMBEDDED_JSON_AGGREGATE_MAX_BYTES} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  assertNotionImportJsonShape(parsed, budget.shape, baseDepth, 'mcpFetches embedded JSON');
  return parsed;
}

function unwrapMcpReference(value: string) {
  let next = value.trim();
  if (next.startsWith('{{') && next.endsWith('}}')) next = next.slice(2, -2).trim();
  return next;
}

export function dashedUuid(value: string) {
  const compact = value.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) return value.trim();
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
}

function mcpReferenceId(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const cleaned = unwrapMcpReference(value);
  const schemeMatch = /^(?:collection|view|block|page|database|dataSource):\/\/([0-9a-f-]{32,36})/i.exec(cleaned);
  if (schemeMatch?.[1]) return dashedUuid(schemeMatch[1]);
  const collectionPropertyMatch = /^collectionProperty:\/\/([0-9a-f-]{32,36})\//i.exec(cleaned);
  if (collectionPropertyMatch?.[1]) return dashedUuid(collectionPropertyMatch[1]);
  const compactMatches = cleaned.match(/[0-9a-f]{32}/gi);
  if (compactMatches?.length) return dashedUuid(compactMatches[compactMatches.length - 1]);
  const uuidMatch = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(cleaned);
  if (uuidMatch?.[0]) return dashedUuid(uuidMatch[0]);
  const trimmed = cleaned.trim();
  return trimmed || undefined;
}

function mcpCollectionPropertyId(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const cleaned = unwrapMcpReference(value);
  const match = /^collectionProperty:\/\/[^/]+\/([^/?#]+)/i.exec(cleaned);
  return match?.[1] ? safeDecode(match[1]).trim() : undefined;
}

function mcpCollectionPropertyDataSourceId(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const cleaned = unwrapMcpReference(value);
  const match = /^collectionProperty:\/\/([0-9a-f-]{32,36})\//i.exec(cleaned);
  return match?.[1] ? dashedUuid(match[1]) : undefined;
}

function extractTagBlocks(text: string, tag: string): HtmlTagBlock[] {
  const blocks: HtmlTagBlock[] = [];
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (blocks.length >= NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX) {
      notionImportPayloadTooLarge(
        `mcpFetches contains more than ${NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX} <${tag}> blocks`,
      );
    }
    blocks.push({
      attributes: match[1] ?? '',
      content: match[2] ?? '',
      raw: match[0] ?? '',
    });
  }
  return blocks;
}

function extractSelfClosingTagAttributes(text: string, tag: string) {
  const blocks: string[] = [];
  const pattern = new RegExp(`<${tag}\\b([^>]*)\\/?>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (blocks.length >= NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX) {
      notionImportPayloadTooLarge(
        `mcpFetches contains more than ${NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX} <${tag}> tags`,
      );
    }
    blocks.push(match[1] ?? '');
  }
  return blocks;
}

function tagAttribute(attributes: string, name: string) {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(attributes);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return typeof value === 'string' && value.trim() ? unwrapMcpReference(value) : undefined;
}

function firstTagJson(
  content: string,
  tag: string,
  embeddedJsonBudget: McpEmbeddedJsonBudget,
) {
  const block = extractTagBlocks(content, tag)[0];
  if (!block) return undefined;
  return parseJsonLike(block.content, embeddedJsonBudget, 0, `mcpFetches <${tag}>`);
}

function mcpTitleFromText(text: string, label: string) {
  const pattern = new RegExp(`The title of this ${label} is:\\s*([^\\n<]+)`, 'i');
  const match = pattern.exec(text);
  return match?.[1]?.trim();
}

function mcpRichTextTitle(title: string | undefined) {
  const text = title?.trim() || 'Untitled';
  return [
    {
      type: 'text',
      plain_text: text,
      text: { content: text, link: null },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
      },
    },
  ];
}

function collectMcpFetchPayloads(
  value: unknown,
  embeddedJsonBudget: McpEmbeddedJsonBudget,
): McpFetchPayload[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const payloads: McpFetchPayload[] = [];
  const stack: Array<{ candidate: unknown; depth: number }> = [];
  if (values.length > NOTION_IMPORT_REQUEST_JSON_MAX_NODES) {
    notionImportPayloadTooLarge(
      `mcpFetches exceeds ${NOTION_IMPORT_REQUEST_JSON_MAX_NODES} JSON nodes`,
    );
  }
  for (let index = values.length - 1; index >= 0; index -= 1) {
    stack.push({ candidate: values[index], depth: 0 });
  }
  let nodes = 0;
  let textBytes = 0;

  const addPayload = (payload: McpFetchPayload) => {
    if (payloads.length >= NOTION_IMPORT_MCP_FETCH_PAYLOADS_PER_REQUEST_MAX) {
      notionImportPayloadTooLarge(
        `mcpFetches has more than ${NOTION_IMPORT_MCP_FETCH_PAYLOADS_PER_REQUEST_MAX} text payloads`,
      );
    }
    const remaining = NOTION_IMPORT_MCP_TEXT_MAX_BYTES - textBytes;
    textBytes += boundedUtf8Bytes(payload.text, Math.max(0, remaining), 'mcpFetches text');
    payloads.push(payload);
  };

  while (stack.length) {
    const { candidate, depth } = stack.pop()!;
    if (depth > NOTION_IMPORT_REQUEST_JSON_MAX_DEPTH) {
      notionImportPayloadTooLarge(
        `mcpFetches exceeds JSON depth ${NOTION_IMPORT_REQUEST_JSON_MAX_DEPTH}`,
      );
    }
    nodes += 1;
    if (nodes > NOTION_IMPORT_REQUEST_JSON_MAX_NODES) {
      notionImportPayloadTooLarge(
        `mcpFetches exceeds ${NOTION_IMPORT_REQUEST_JSON_MAX_NODES} JSON nodes`,
      );
    }
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === 'string') {
      const parsed = parseJsonLike(
        candidate,
        embeddedJsonBudget,
        depth + 1,
        'mcpFetches wrapper',
      );
      if (parsed !== undefined) {
        stack.push({ candidate: parsed, depth: depth + 1 });
      } else if (candidate.trim()) {
        addPayload({ text: candidate });
      }
      continue;
    }
    if (Array.isArray(candidate)) {
      if (
        candidate.length
          > NOTION_IMPORT_REQUEST_JSON_MAX_NODES - nodes - stack.length
      ) {
        notionImportPayloadTooLarge(
          `mcpFetches exceeds ${NOTION_IMPORT_REQUEST_JSON_MAX_NODES} JSON nodes`,
        );
      }
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        stack.push({ candidate: candidate[index], depth: depth + 1 });
      }
      continue;
    }
    const record = asRecord(candidate);
    if (!record) continue;
    const metadata = asRecord(record.metadata);
    const title = optionalString(record.title ?? metadata?.title);
    const url = optionalString(record.url ?? metadata?.url);
    const text =
      optionalString(record.text) ??
      optionalString(record.markdown) ??
      optionalString(record.contentText);
    if (text) {
      addPayload({ text, title, url, metadata });
      continue;
    }
    if (Array.isArray(record.content)) {
      if (
        record.content.length
          > NOTION_IMPORT_REQUEST_JSON_MAX_NODES - nodes - stack.length
      ) {
        notionImportPayloadTooLarge(
          `mcpFetches exceeds ${NOTION_IMPORT_REQUEST_JSON_MAX_NODES} JSON nodes`,
        );
      }
      for (let index = record.content.length - 1; index >= 0; index -= 1) {
        stack.push({ candidate: record.content[index], depth: depth + 1 });
      }
      continue;
    }
    if (record.result !== undefined && record.result !== null) {
      stack.push({ candidate: record.result, depth: depth + 1 });
    }
  }
  return payloads;
}

export function mcpFetchPayloads(value: unknown): McpFetchPayload[] {
  return collectMcpFetchPayloads(value, {
    bytes: 0,
    shape: { nodes: 0 },
  });
}

function mcpSchemaNotionType(value: unknown) {
  const type = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (type === 'text') return 'rich_text';
  if (type === 'file') return 'files';
  if (type === 'person') return 'people';
  if (type === 'phone') return 'phone_number';
  if (SUPPORTED_NOTION_PROPERTY_TYPES.has(type)) return type;
  return 'rich_text';
}

function mcpSchemaOptions(prop: Record<string, unknown>) {
  const source =
    Array.isArray(prop.options) ? prop.options :
      Array.isArray(prop.select_options) ? prop.select_options :
        Array.isArray(prop.selectOptions) ? prop.selectOptions :
          [];
  return source
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((option) => ({
      id:
        optionalString(option.id) ??
        mcpReferenceId(option.url) ??
        mcpReferenceId(option.valueUrl) ??
        newId(),
      name: optionalString(option.name ?? option.value ?? option.label) ?? 'Option',
      color: optionColor(option.color),
    }));
}

function mcpSchemaPropertyId(prop: Record<string, unknown>, fallback: string) {
  return (
    optionalString(prop.id) ??
    mcpCollectionPropertyId(prop.propertyUrl) ??
    mcpCollectionPropertyId(prop.url) ??
    optionalString(prop.code) ??
    optionalString(prop.key) ??
    fallback
  );
}

function mcpSchemaRelationTarget(prop: Record<string, unknown>) {
  return (
    mcpReferenceId(prop.dataSourceUrl) ??
    mcpReferenceId(prop.data_source_url) ??
    mcpReferenceId(prop.collectionUrl) ??
    mcpReferenceId(prop.databaseUrl) ??
    mcpReferenceId(prop.targetDataSourceUrl) ??
    mcpReferenceId(prop.target_data_source_url)
  );
}

function mcpSchemaPropertyConfig(prop: Record<string, unknown>, notionType: string) {
  if (notionType === 'number') {
    return {
      format: optionalString(prop.number_format ?? prop.numberFormat ?? prop.format) ?? 'number',
    };
  }
  if (notionType === 'select' || notionType === 'multi_select' || notionType === 'status') {
    return { options: mcpSchemaOptions(prop) };
  }
  if (notionType === 'relation') {
    const target = mcpSchemaRelationTarget(prop);
    return target ? { data_source_id: target } : {};
  }
  if (notionType === 'rollup') {
    return {
      relation_property_id:
        optionalString(prop.relation_property_id) ??
        mcpCollectionPropertyId(prop.relationPropertyUrl ?? prop.relation_property_url),
      rollup_property_id:
        optionalString(prop.rollup_property_id) ??
        mcpCollectionPropertyId(prop.targetPropertyUrl ?? prop.rollupPropertyUrl ?? prop.rollup_property_url),
      function: optionalString(prop.function ?? prop.rollupFunction ?? prop.aggregation) ?? 'show_original',
    };
  }
  if (notionType === 'formula') {
    return {
      expression: optionalString(prop.expression ?? prop.formula) ?? '',
      formula_code_url: optionalString(prop.codeUrl ?? prop.formulaCodeUrl),
    };
  }
  return {};
}

function mcpSchemaProperties(state: Record<string, unknown> | undefined) {
  const schema = asRecord(state?.schema ?? state?.properties);
  if (!schema) return {};
  const properties: Record<string, unknown> = {};
  for (const [key, rawProp] of Object.entries(schema)) {
    const prop = asRecord(rawProp);
    if (!prop) continue;
    const name = optionalString(prop.name) ?? key;
    const notionType = mcpSchemaNotionType(prop.type);
    const id = mcpSchemaPropertyId(prop, name);
    properties[name] = {
      id,
      name,
      type: notionType,
      [notionType]: mcpSchemaPropertyConfig(prop, notionType),
    };
  }
  return properties;
}

function mcpRelationTargetReferencesFromProperties(properties: Record<string, unknown>) {
  const refs = new Map<string, { id: string; notionObject: 'data_source' }>();
  for (const property of Object.values(properties)) {
    const prop = asRecord(property);
    if (!prop) continue;
    const notionType = optionalString(prop.type);
    const config = notionType ? notionPropertyConfig(prop, notionType) : {};
    const target = notionType === 'relation' ? optionalString(config.data_source_id) : undefined;
    if (target) refs.set(target, { id: target, notionObject: 'data_source' });
    const rollupTarget = notionType === 'rollup'
      ? mcpCollectionPropertyDataSourceId(config.rollup_property_id) ??
        mcpCollectionPropertyDataSourceId((config.notion as Record<string, unknown> | undefined)?.targetPropertyUrl)
      : undefined;
    if (rollupTarget) refs.set(rollupTarget, { id: rollupTarget, notionObject: 'data_source' });
  }
  return Array.from(refs.values());
}

function mcpStringList(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  return items.length ? items : undefined;
}

function mcpViewRecord(
  rawView: Record<string, unknown>,
  viewId: string | undefined,
  dataSourceId: string,
  warningBag: McpSnapshotWarningBag,
) {
  const rawType = optionalString(rawView.type) ?? 'table';
  const resolvedViewId = viewId ?? optionalString(rawView.id) ?? newId();
  const name = optionalString(rawView.name) ?? 'Default view';
  const displayProperties =
    mcpStringList(rawView.displayProperties) ??
    mcpStringList(rawView.visibleProperties) ??
    mcpStringList(rawView.visible_properties);
  const rawSorts = Array.isArray(rawView.sorts) ? rawView.sorts : [];
  const projected: Record<string, unknown> = {
    ...structuredClone(rawView),
    id: resolvedViewId,
    name,
    type: rawType,
    data_source_id: dataSourceId,
    visible_properties: displayProperties,
    // Keep the two serialized view fields independent. The bounded snapshot
    // guard intentionally rejects object aliases, even when JSON.stringify
    // would duplicate the shared array into valid JSON.
    property_order: displayProperties ? [...displayProperties] : undefined,
    sorts: rawSorts
      .filter((sort): sort is Record<string, unknown> => !!sort && typeof sort === 'object')
      .map((sort) => ({
        property: optionalString(sort.property ?? sort.property_id ?? sort.id ?? sort.name),
        direction: optionalString(sort.direction) ?? 'ascending',
      }))
      .filter((sort) => sort.property),
  };

  try {
    const normalizedView = normalizeDatabaseViewStorageRecord({
      type: rawType,
      config: rawView.configuration,
    });
    projected.type = normalizedView.type;
    if ('configuration' in rawView) {
      projected.configuration = structuredClone(normalizedView.config);
    }
    return projected;
  } catch (error) {
    pushMcpSnapshotWarning(warningBag, {
      code: 'mcp_snapshot_view_validation_fallback',
      notionId: resolvedViewId,
      notionObject: 'view',
      message:
        `View "${name}" could not use the canonical view validator: ` +
        `${mcpSnapshotValidationMessage(error)} Raw MCP view metadata was preserved for fallback import.`,
    });

    if (!SUPPORTED_MCP_SNAPSHOT_VIEW_TYPES.has(rawType.toLowerCase())) {
      // A future view type is already isolated by the downstream import
      // fallback. Archive the complete raw object under one field and expose
      // only safe identity projections, so no unknown top-level or nested key
      // can be reinterpreted as typed fallback configuration or display state.
      const futureView: Record<string, unknown> = {
        id: resolvedViewId,
        name,
        type: rawType,
        data_source_id: dataSourceId,
        rawMcpView: structuredClone(rawView),
      };
      return futureView;
    }

    // Known view types still have to satisfy the canonical storage contract
    // later in apply. Remove only the malformed discriminator-bearing field;
    // preserve it separately on this raw import-boundary record.
    if ('configuration' in rawView) {
      projected.rawMcpConfiguration = structuredClone(rawView.configuration);
      delete projected.configuration;
    }
    return projected;
  }
}

interface McpParsedView {
  rawView: Record<string, unknown>;
  sourceId?: string;
  viewId?: string;
}

function parseMcpViews(
  content: string,
  embeddedJsonBudget: McpEmbeddedJsonBudget,
): McpParsedView[] {
  const views: McpParsedView[] = [];
  for (const viewBlock of extractTagBlocks(content, 'view')) {
    const parsed = parseJsonLike(
      viewBlock.content,
      embeddedJsonBudget,
      0,
      'mcpFetches <view>',
    );
    const rawView = asRecord(parsed);
    if (!rawView) continue;
    views.push({
      rawView,
      sourceId: mcpReferenceId(rawView.dataSourceUrl ?? rawView.data_source_url),
      viewId: mcpReferenceId(tagAttribute(viewBlock.attributes, 'url')),
    });
  }
  return views;
}

function mcpViewsForDataSource(
  parsedViews: McpParsedView[],
  dataSourceId: string,
  workBudget: McpTransformWorkBudget,
) {
  const normalizedDataSourceId = normalizedNotionId(dataSourceId);
  const views: Record<string, unknown>[] = [];
  const warningBag = mcpSnapshotWarningBag();
  for (const view of parsedViews) {
    workBudget.viewInspections += 1;
    if (workBudget.viewInspections > NOTION_IMPORT_MCP_VIEW_ASSIGNMENT_WORK_MAX) {
      notionImportPayloadTooLarge(
        `mcpFetches exceeds ${NOTION_IMPORT_MCP_VIEW_ASSIGNMENT_WORK_MAX} view assignments`,
      );
    }
    if (view.sourceId && normalizedNotionId(view.sourceId) !== normalizedDataSourceId) continue;
    views.push(mcpViewRecord(view.rawView, view.viewId, dataSourceId, warningBag));
  }
  return { views, warningBag };
}

function mcpTextSpans(value: unknown) {
  const text = value === undefined || value === null ? '' : String(value);
  return mcpRichTextTitle(text);
}

function mcpRowPageDateParts(rawProperties: Record<string, unknown>, name: string) {
  const start = optionalString(rawProperties[`date:${name}:start`]);
  const end = optionalString(rawProperties[`date:${name}:end`]);
  const isDatetime = rawProperties[`date:${name}:is_datetime`];
  if (!start && !end && isDatetime === undefined) return undefined;
  return {
    start: start ?? end ?? '',
    end,
    time_zone: null,
  };
}

function mcpRowPageFileValues(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .map((url) => ({
      type: 'external',
      name: fileNameFromUrl(url),
      external: { url },
    }));
}

function mcpRowPagePropertyValue(
  name: string,
  value: unknown,
  sourceProperty: Record<string, unknown> | undefined,
  rawProperties: Record<string, unknown>,
  warningBag: McpSnapshotWarningBag,
) {
  const notionType = optionalString(sourceProperty?.type) ?? (typeof value === 'number' ? 'number' : 'rich_text');
  const id = optionalString(sourceProperty?.id) ?? name;
  if (notionType === 'title' || notionType === 'rich_text') {
    return { id, type: notionType, [notionType]: mcpTextSpans(value) };
  }
  if (notionType === 'number') return { id, type: notionType, number: typeof value === 'number' ? value : Number(value) };
  if (notionType === 'select' || notionType === 'status') {
    return {
      id,
      type: notionType,
      [notionType]: value === undefined || value === null || value === '' ? null : { name: String(value) },
    };
  }
  if (notionType === 'multi_select') {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    return {
      id,
      type: notionType,
      multi_select: values
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
        .map((item) => ({ name: item })),
    };
  }
  if (notionType === 'date') {
    return { id, type: notionType, date: mcpRowPageDateParts(rawProperties, name) ?? null };
  }
  if (notionType === 'relation') {
    const values = Array.isArray(value) ? value : [];
    return {
      id,
      type: notionType,
      relation: values
        .map((item) => mcpReferenceId(item))
        .filter((item): item is string => !!item)
        .map((item) => ({ id: item })),
    };
  }
  if (notionType === 'files') return { id, type: notionType, files: mcpRowPageFileValues(value) };
  if (notionType === 'checkbox') return { id, type: notionType, checkbox: value === true || value === '__YES__' };
  if (
    notionType === 'button' ||
    notionType === 'location' ||
    notionType === 'verification' ||
    notionType === 'last_visited_time' ||
    notionType === 'place'
  ) {
    try {
      const normalized = normalizeDatabasePropertyImportValue(notionType, value);
      if (normalized === OMIT_DATABASE_PROPERTY_IMPORT_VALUE) return undefined;
      return { id, type: notionType, [notionType]: structuredClone(normalized) };
    } catch (error) {
      if (notionType !== 'place' && notionType !== 'verification') throw error;
      pushMcpSnapshotWarning(warningBag, {
        code: 'mcp_snapshot_property_value_invalid',
        notionId: id,
        notionObject: 'property',
        message:
          `Property "${name}" had an invalid ${notionType} MCP snapshot value: ` +
          `${mcpSnapshotValidationMessage(error)} The typed value was degraded to null; ` +
          'the raw value remains in rawMcpProperties.',
      });
      return { id, type: notionType, [notionType]: null };
    }
  }
  if (notionType === 'formula') {
    return {
      id,
      type: notionType,
      formula: { type: 'string', string: value === undefined || value === null ? '' : String(value) },
    };
  }
  if (notionType === 'rollup') {
    return {
      id,
      type: notionType,
      rollup: { type: 'array', array: [] },
    };
  }
  if (notionType === 'url' || notionType === 'email' || notionType === 'phone_number') {
    return { id, type: notionType, [notionType]: value === undefined || value === null ? null : String(value) };
  }
  return { id, type: 'rich_text', rich_text: mcpTextSpans(value) };
}

function mcpRowPageProperties(rawProperties: Record<string, unknown>, sourceProperties: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const warningBag = mcpSnapshotWarningBag();
  const sourceNames = new Set(Object.keys(sourceProperties));
  for (const name of sourceNames) {
    const sourceProperty = asRecord(sourceProperties[name]);
    if (!sourceProperty) continue;
    const hasDirectValue = Object.prototype.hasOwnProperty.call(rawProperties, name);
    const hasDateValue =
      optionalString(rawProperties[`date:${name}:start`]) ||
      optionalString(rawProperties[`date:${name}:end`]) ||
      rawProperties[`date:${name}:is_datetime`] !== undefined;
    if (!hasDirectValue && !hasDateValue) continue;
    const property = mcpRowPagePropertyValue(
      name,
      rawProperties[name],
      sourceProperty,
      rawProperties,
      warningBag,
    );
    if (property) out[name] = property;
  }
  for (const [name, value] of Object.entries(rawProperties)) {
    if (name === 'url' || name.startsWith('date:') || sourceNames.has(name)) continue;
    const property = mcpRowPagePropertyValue(
      name,
      value,
      undefined,
      rawProperties,
      warningBag,
    );
    if (property) out[name] = property;
  }
  return { properties: out, warningBag };
}

function putMcpDataSourceSnapshot(
  items: Map<string, DiscoveredNotionItem>,
  dataSourceBlock: HtmlTagBlock,
  parsedViews: McpParsedView[],
  payload: McpFetchPayload,
  databaseId: string | undefined,
  fallbackTitle: string | undefined,
  embeddedJsonBudget: McpEmbeddedJsonBudget,
  workBudget: McpTransformWorkBudget,
) {
  const state = asRecord(
    firstTagJson(dataSourceBlock.content, 'data-source-state', embeddedJsonBudget),
  );
  const dataSourceId =
    mcpReferenceId(tagAttribute(dataSourceBlock.attributes, 'url')) ??
    mcpReferenceId(state?.url) ??
    mcpReferenceId(state?.dataSourceUrl);
  if (!dataSourceId) return undefined;
  const title =
    mcpTitleFromText(dataSourceBlock.content, 'Data Source') ??
    optionalString(state?.name ?? state?.title) ??
    fallbackTitle ??
    payload.title ??
    'Untitled data source';
  const properties = mcpSchemaProperties(state);
  const { views, warningBag } = mcpViewsForDataSource(
    parsedViews,
    dataSourceId,
    workBudget,
  );
  const dataSourceRef = {
    id: dataSourceId,
    object: 'data_source',
    name: title,
    title: mcpRichTextTitle(title),
  };
  putDiscoveredItem(items, {
    notionId: dataSourceId,
    notionObject: 'data_source',
    parentNotionId: databaseId,
    title,
    status: 'discovered',
    phase: 'mcp_data_source_snapshot',
    metadata: {
      discoveredFrom: 'mcp_fetch',
      ...(databaseId ? { databaseId } : {}),
      ...mcpSnapshotWarningMetadata(warningBag),
      dataSourceSnapshot: {
        dataSource: {
          id: dataSourceId,
          object: 'data_source',
          ...(databaseId ? { parent: { type: 'database_id', database_id: databaseId } } : {}),
          title: mcpRichTextTitle(title),
          name: title,
          properties,
        },
        rowReferences: [],
        relationTargetReferences: mcpRelationTargetReferencesFromProperties(properties),
        views,
        templates: [],
        mcpSource: {
          title: payload.title,
          url: payload.url,
          metadata: payload.metadata,
        },
      },
    },
  });
  return dataSourceRef;
}

function putMcpPageSnapshot(
  items: Map<string, DiscoveredNotionItem>,
  pageBlock: HtmlTagBlock,
  payload: McpFetchPayload,
  embeddedJsonBudget: McpEmbeddedJsonBudget,
) {
  const pageUrl = tagAttribute(pageBlock.attributes, 'url') ?? payload.url;
  const pageId = mcpReferenceId(pageUrl);
  if (!pageId) return;
  const parentDataSourceAttributes = extractSelfClosingTagAttributes(pageBlock.content, 'parent-data-source')[0];
  const dataSourceId = parentDataSourceAttributes
    ? mcpReferenceId(tagAttribute(parentDataSourceAttributes, 'url'))
    : undefined;
  const sourceItem = dataSourceId ? items.get(dataSourceId) : undefined;
  const sourceProperties = sourceItem ? notionPropertiesFromSnapshot(dataSourceSnapshot(sourceItem)) : {};
  const rawProperties = asRecord(
    firstTagJson(pageBlock.content, 'properties', embeddedJsonBudget),
  ) ?? {};
  const rowSnapshot = dataSourceId
    ? mcpRowPageProperties(rawProperties, sourceProperties)
    : { properties: rawProperties, warningBag: mcpSnapshotWarningBag() };
  putDiscoveredItem(items, {
    notionId: pageId,
    notionObject: 'page',
    parentNotionId: dataSourceId,
    title: payload.title ?? optionalString(rawProperties.title) ?? optionalString(rawProperties.Name),
    status: 'discovered',
    phase: dataSourceId ? 'mcp_data_source_row_snapshot' : 'mcp_page_snapshot',
    metadata: {
      discoveredFrom: 'mcp_fetch',
      ...(dataSourceId ? { dataSourceId } : {}),
      ...mcpSnapshotWarningMetadata(rowSnapshot.warningBag),
      properties: rowSnapshot.properties,
      rawMcpProperties: rawProperties,
      icon: tagAttribute(pageBlock.attributes, 'icon')
        ? { type: 'emoji', emoji: tagAttribute(pageBlock.attributes, 'icon') }
        : undefined,
      pageSnapshot: { childBlocks: [] },
      mcpSource: {
        title: payload.title,
        url: payload.url,
        metadata: payload.metadata,
      },
    },
  });
}

function assertRequestDiscoveredItemCount(
  items: Map<string, DiscoveredNotionItem>,
  label: string,
) {
  if (items.size > NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX) {
    notionImportPayloadTooLarge(
      `${label} expands beyond ${NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX} items`,
    );
  }
}

export function assertBoundedRequestDiscoveredItems(
  items: DiscoveredNotionItem[],
  label: string,
) {
  if (items.length > NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX) {
    notionImportPayloadTooLarge(
      `${label} has more than ${NOTION_IMPORT_SNAPSHOT_ITEMS_PER_REQUEST_MAX} items`,
    );
  }
  const budget: NotionImportRequestJsonBudget = { bytes: 0, nodes: 0 };
  items.forEach((item, index) => {
    assertBoundedSnapshotJsonValue(item, budget, `${label}[${index}]`);
  });
}

export function parseMcpFetchItems(value: unknown): DiscoveredNotionItem[] {
  const items = new Map<string, DiscoveredNotionItem>();
  const embeddedJsonBudget: McpEmbeddedJsonBudget = {
    bytes: 0,
    shape: { nodes: 0 },
  };
  const workBudget: McpTransformWorkBudget = { viewInspections: 0 };
  const payloads = collectMcpFetchPayloads(value, embeddedJsonBudget);
  for (const payload of payloads) {
    const databaseBlocks = extractTagBlocks(payload.text, 'database');
    for (const databaseBlock of databaseBlocks) {
      const parsedViews = parseMcpViews(databaseBlock.content, embeddedJsonBudget);
      const databaseUrl = tagAttribute(databaseBlock.attributes, 'url') ?? payload.url;
      const databaseId = mcpReferenceId(databaseUrl);
      if (!databaseId) continue;
      const databaseTitle =
        mcpTitleFromText(databaseBlock.content, 'Database') ??
        payload.title ??
        'Untitled database';
      const dataSourceRefs: Record<string, unknown>[] = [];

      for (const dataSourceBlock of extractTagBlocks(databaseBlock.content, 'data-source')) {
        const dataSourceRef = putMcpDataSourceSnapshot(
          items,
          dataSourceBlock,
          parsedViews,
          payload,
          databaseId,
          databaseTitle,
          embeddedJsonBudget,
          workBudget,
        );
        if (dataSourceRef) dataSourceRefs.push(dataSourceRef);
        assertRequestDiscoveredItemCount(items, 'mcpFetches');
      }

      putDiscoveredItem(items, {
        notionId: databaseId,
        notionObject: 'database',
        title: databaseTitle,
        status: 'discovered',
        phase: 'mcp_database_snapshot',
        metadata: {
          discoveredFrom: 'mcp_fetch',
          database: {
            id: databaseId,
            object: 'database',
            title: mcpRichTextTitle(databaseTitle),
            data_sources: dataSourceRefs,
          },
          // Deep-clone so the data-source refs are not aliased under both
          // `database.data_sources` and `dataSources`. The bounded-request guard
          // (assertBoundedSnapshotJsonValue) rejects any object reached twice
          // within one item, so the two fields must own independent subtrees.
          dataSources: structuredClone(dataSourceRefs),
          mcpSource: {
            title: payload.title,
            url: payload.url,
            metadata: payload.metadata,
          },
        },
      });
      assertRequestDiscoveredItemCount(items, 'mcpFetches');
    }
    if (databaseBlocks.length === 0) {
      const parsedViews = parseMcpViews(payload.text, embeddedJsonBudget);
      for (const dataSourceBlock of extractTagBlocks(payload.text, 'data-source')) {
        putMcpDataSourceSnapshot(
          items,
          dataSourceBlock,
          parsedViews,
          payload,
          undefined,
          payload.title,
          embeddedJsonBudget,
          workBudget,
        );
        assertRequestDiscoveredItemCount(items, 'mcpFetches');
      }
    }
  }
  for (const payload of payloads) {
    for (const pageBlock of extractTagBlocks(payload.text, 'page')) {
      putMcpPageSnapshot(items, pageBlock, payload, embeddedJsonBudget);
      assertRequestDiscoveredItemCount(items, 'mcpFetches');
    }
  }
  const parsed = Array.from(items.values());
  assertBoundedRequestDiscoveredItems(parsed, 'mcpFetchItems');
  return parsed;
}

export function expandSnapshotItems(
  items: DiscoveredNotionItem[],
  maxItems = NOTION_IMPORT_ITEM_SAFETY_LIMIT,
) {
  if (items.length > maxItems) {
    notionImportPayloadTooLarge(`snapshot input expands beyond ${maxItems} items`);
  }
  const byId = new Map<string, DiscoveredNotionItem>();
  const assertWithinLimit = () => {
    if (byId.size > maxItems) {
      notionImportPayloadTooLarge(`snapshot expansion exceeds ${maxItems} items`);
    }
  };
  for (const item of items) {
    putDiscoveredItem(byId, item);
    assertWithinLimit();
  }

  for (const item of items) {
    if (item.notionObject !== 'data_source') continue;
    const snapshot = dataSourceSnapshot(item);
    const rowReferences = Array.isArray(snapshot?.rowReferences) ? snapshot.rowReferences : [];
    for (let rowIndex = 0; rowIndex < rowReferences.length; rowIndex += 1) {
      const row = rowReferences[rowIndex];
      if (!row || typeof row !== 'object') continue;
      const rowRecord = row as Record<string, unknown>;
      const id = optionalString(rowRecord.id);
      if (!id) continue;
      putDiscoveredItem(byId, {
        notionId: id,
        notionObject: optionalString(rowRecord.object) ?? 'page',
        parentNotionId: item.notionId,
        title: optionalString(rowRecord.title),
        status: 'referenced',
        phase: 'data_source_row_reference',
        metadata: {
          discoveredFrom: 'snapshot_data_source_query',
          dataSourceId: item.notionId,
          notionQueryOrder: rowIndex,
          ...(optionalString(rowRecord.createdTime) ?? optionalString(rowRecord.created_time)
            ? { createdTime: optionalString(rowRecord.createdTime) ?? optionalString(rowRecord.created_time) }
            : {}),
          ...(optionalString(rowRecord.lastEditedTime) ?? optionalString(rowRecord.last_edited_time)
            ? { lastEditedTime: optionalString(rowRecord.lastEditedTime) ?? optionalString(rowRecord.last_edited_time) }
            : {}),
          properties: rowRecord.properties,
          icon: rowRecord.icon,
          cover: rowRecord.cover,
        },
      });
      assertWithinLimit();
    }

    const views = Array.isArray(snapshot?.views) ? snapshot.views : [];
    for (const view of views) {
      if (!view || typeof view !== 'object') continue;
      const viewRecord = view as Record<string, unknown>;
      const id = notionObjectId(viewRecord);
      if (!id) continue;
      putDiscoveredItem(byId, {
        notionId: id,
        notionObject: 'view',
        parentNotionId: item.notionId,
        title: optionalString(viewRecord.name),
        status: 'discovered',
        phase: 'view_snapshot',
        metadata: {
          discoveredFrom: 'snapshot_views',
          dataSourceId: item.notionId,
          view: viewRecord,
        },
      });
      assertWithinLimit();
    }
  }

  return Array.from(byId.values());
}
