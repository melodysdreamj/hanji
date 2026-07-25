import { pageAccessRole } from './page-access';
import { type DbRef, listAll } from './mcp-oauth';
import { getExisting } from './table-utils';

const MEETING_NOTE_STATUSES = new Set([
  'transcription_not_started',
  'transcription_paused',
  'transcription_in_progress',
  'transcription_failed',
  'summary_in_progress',
  'notes_ready',
]);

const FILTER_PROPERTIES = new Set([
  'title',
  'attendees',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
]);
const MEETING_ATTENDEES_PROPERTY = 'notion://meeting_notes/attendees';

interface BlockRecord {
  id: string;
  pageId: string;
  parentId?: string | null;
  type: string;
  content?: Record<string, unknown> | null;
  plainText?: string | null;
  position?: number | null;
  createdBy?: string | null;
  lastEditedBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface PageRecord {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: string;
  createdBy?: string | null;
  inTrash?: boolean | null;
  properties?: Record<string, unknown> | null;
}

interface NotionImportConnection {
  id: string;
  workspaceId: string;
  actorId?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface RichTextSpan {
  text?: unknown;
  content?: string;
  plain_text?: string;
  href?: string | null;
  link?: string | null | { url?: string | null };
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
  annotations?: Record<string, unknown>;
  type?: string;
}

interface MeetingNoteModel {
  block: BlockRecord;
  page: PageRecord;
  imported: boolean;
  payload: Record<string, unknown>;
  title: RichTextSpan[];
  titleText: string;
  attendees: string[];
  createdBy: string;
  lastEditedBy: string;
  createdTime: string;
  lastEditedTime: string;
  sourceChildIds: Record<string, string>;
  sourceType: 'meeting_notes' | 'transcription';
}

interface MeetingNoteResultModel extends MeetingNoteModel {
  result: Record<string, unknown>;
}

export interface QueryMeetingNotesInput {
  filter?: unknown;
  sort?: unknown;
  limit?: unknown;
  /** Internal fetch narrowing used by MCP include_transcript. */
  page_id?: unknown;
  /** Internal fetch expansion; the public query response stays metadata-only by default. */
  include_transcript?: unknown;
}

export interface QueryMeetingNotesContext {
  db: DbRef;
  workspaceId: string;
  actorId: string;
  actorEmail?: string | null;
  /** Optional MCP-local consent narrowing; omitted for normal REST calls. */
  allowedPageIds?: Iterable<string>;
  allowedDatabaseIds?: Iterable<string>;
}

export class MeetingNotesUnavailableError extends Error {
  readonly status = 400;
  readonly code = 'validation_error';

  constructor(message = 'Meeting notes are not available for this workspace user.') {
    super(message);
  }
}

export class MeetingNotesValidationError extends Error {
  readonly status = 400;
  readonly code = 'validation_error';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return item.trim();
    const record = asRecord(item);
    return text(record?.id ?? record?.userId ?? record?.value);
  }).filter(Boolean);
}

function richTextSource(value: unknown): RichTextSpan[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RichTextSpan => !!item && typeof item === 'object');
}

function spanText(span: RichTextSpan) {
  const textRecord = asRecord((span as Record<string, unknown>).text);
  return text(
    span.plain_text
      ?? span.content
      ?? textRecord?.content
      ?? (typeof span.text === 'string' ? span.text : ''),
  );
}

function richTextPlainText(value: RichTextSpan[]) {
  return value.map(spanText).join('');
}

function notionRichText(value: RichTextSpan[], fallback: string) {
  const source = value.length > 0 ? value : fallback ? [{ text: fallback }] : [];
  return source.map((span) => {
    const content = spanText(span);
    const annotations = asRecord(span.annotations);
    const linkRecord = asRecord(span.link);
    const href = text(span.href ?? linkRecord?.url ?? (typeof span.link === 'string' ? span.link : '')) || null;
    return {
      type: 'text',
      text: {
        content,
        link: href ? { url: href } : null,
      },
      annotations: {
        bold: annotations?.bold === true || span.bold === true,
        italic: annotations?.italic === true || span.italic === true,
        strikethrough: annotations?.strikethrough === true || span.strikethrough === true,
        underline: annotations?.underline === true || span.underline === true,
        code: annotations?.code === true || span.code === true,
        color: text(annotations?.color ?? span.color) || 'default',
      },
      plain_text: content,
      href,
    };
  });
}

function sourceMeetingNote(block: Pick<BlockRecord, 'type' | 'content'>) {
  const content = asRecord(block.content) ?? {};
  const nativePayload = asRecord(content.meetingNotes ?? content.meeting_notes);
  if (block.type === 'meeting_notes' && nativePayload) {
    return {
      imported: false,
      payload: nativePayload,
      raw: null as Record<string, unknown> | null,
      sourceType: 'meeting_notes' as const,
    };
  }
  const raw = asRecord(content.notionBlock);
  const rawType = text(raw?.type);
  if (rawType !== 'meeting_notes' && rawType !== 'transcription') return null;
  const payload = asRecord(raw?.[rawType]);
  if (!payload) return null;
  return { imported: true, payload, raw, sourceType: rawType as 'meeting_notes' | 'transcription' };
}

function meetingTitle(payload: Record<string, unknown>, block: BlockRecord) {
  const content = asRecord(block.content) ?? {};
  const source = richTextSource(payload.title ?? payload.rich_text ?? payload.richText);
  if (source.length > 0) return source;
  return richTextSource(content.rich);
}

function meetingAttendees(payload: Record<string, unknown>) {
  const event = asRecord(payload.calendar_event ?? payload.calendarEvent);
  return Array.from(new Set([
    ...stringArray(event?.attendees),
    ...stringArray(payload.attendees),
    ...stringArray(payload.attendeeUserIds),
  ]));
}

function meetingChildIds(payload: Record<string, unknown>) {
  const children = asRecord(payload.children) ?? {};
  const out: Record<string, string> = {};
  for (const key of ['summary_block_id', 'notes_block_id', 'transcript_block_id']) {
    const camel = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const id = text(children[key] ?? children[camel]);
    if (id) out[key] = id;
  }
  return out;
}

function meetingModel(block: BlockRecord, page: PageRecord): MeetingNoteModel | null {
  const source = sourceMeetingNote(block);
  if (!source) return null;
  const title = meetingTitle(source.payload, block);
  const titleText = richTextPlainText(title) || text(block.plainText);
  const raw = asRecord(asRecord(block.content)?.notionBlock);
  const createdBy = text(block.createdBy);
  const lastEditedBy = text(block.lastEditedBy) || createdBy;
  const createdTime = text(block.createdAt ?? raw?.created_time);
  const lastEditedTime = text(block.updatedAt ?? raw?.last_edited_time) || createdTime;
  if (!createdBy || !createdTime) {
    throw new MeetingNotesValidationError(
      `Meeting note ${block.id} is missing canonical creator or timestamp metadata.`,
    );
  }
  return {
    block,
    page,
    imported: source.imported,
    payload: source.payload,
    title,
    titleText,
    attendees: meetingAttendees(source.payload),
    createdBy,
    lastEditedBy,
    createdTime,
    lastEditedTime,
    sourceChildIds: meetingChildIds(source.payload),
    sourceType: source.sourceType,
  };
}

function sourceOwnerUserIds(connection: NotionImportConnection) {
  const metadata = asRecord(connection.metadata);
  const oauth = asRecord(metadata?.oauth);
  const owner = asRecord(oauth?.owner);
  const ownerUser = asRecord(owner?.user);
  return stringArray([
    ownerUser?.id,
    asRecord(ownerUser?.person)?.id,
  ]);
}

async function importedActorSourceUserIds(db: DbRef, workspaceId: string, actorId: string) {
  const connections = await listAll(
    db.table<NotionImportConnection>('notion_import_connections').where('workspaceId', '==', workspaceId),
  );
  return new Set(
    connections
      .filter((connection) =>
        connection.actorId === actorId && (connection.status ?? 'active') === 'active'
      )
      .flatMap(sourceOwnerUserIds),
  );
}

/**
 * Canonical transcript-visibility check for callers that already hold an
 * authorized page and its bounded block materialization. Unlike the public
 * query shape, this helper has no 50-result presentation cap.
 */
export async function meetingNoteTranscriptBlockIdsForActor(
  context: Pick<QueryMeetingNotesContext, 'db' | 'workspaceId' | 'actorId'>,
  blocks: Iterable<{
    id: string;
    type: string;
    content?: Record<string, unknown> | null;
    createdBy?: string | null;
  }>,
) {
  const importedSourceUserIds = await importedActorSourceUserIds(
    context.db,
    context.workspaceId,
    context.actorId,
  );
  const visible = new Set<string>();
  for (const block of blocks) {
    const source = sourceMeetingNote(block);
    if (!source) continue;
    const attendees = meetingAttendees(source.payload);
    // Listing a creator-owned note and revealing its attendee-only transcript
    // are different capabilities. Transcript expansion follows the attendee
    // identity boundary for both native and imported notes.
    const allowed = source.imported
      ? attendees.some((attendee) => importedSourceUserIds.has(attendee))
      : attendees.includes(context.actorId);
    if (allowed) visible.add(block.id);
  }
  return visible;
}

function actorIsMeetingAttendee(
  model: MeetingNoteModel,
  actorId: string,
  importedSourceUserIds: Set<string>,
) {
  if (model.createdBy === actorId) return true;
  if (!model.imported) return model.attendees.includes(actorId);
  return model.attendees.some((attendee) => importedSourceUserIds.has(attendee));
}

function localSourceBlockId(block: BlockRecord) {
  const raw = asRecord(asRecord(block.content)?.notionBlock);
  return text(raw?.id);
}

function calendarEvent(payload: Record<string, unknown>) {
  const source = asRecord(payload.calendar_event ?? payload.calendarEvent);
  if (!source) return undefined;
  const startTime = text(source.start_time ?? source.startTime);
  const endTime = text(source.end_time ?? source.endTime);
  if (!startTime || !endTime) return undefined;
  const attendees = stringArray(source.attendees);
  return {
    start_time: startTime,
    end_time: endTime,
    ...(attendees.length > 0 ? { attendees } : {}),
  };
}

function recording(payload: Record<string, unknown>) {
  const source = asRecord(payload.recording);
  if (!source) return undefined;
  const startTime = text(source.start_time ?? source.startTime);
  const endTime = text(source.end_time ?? source.endTime);
  if (!startTime && !endTime) return undefined;
  return {
    ...(startTime ? { start_time: startTime } : {}),
    ...(endTime ? { end_time: endTime } : {}),
  };
}

function status(payload: Record<string, unknown>) {
  const value = text(payload.status);
  return MEETING_NOTE_STATUSES.has(value) ? value : undefined;
}

function resolvedMeetingChildIds(model: MeetingNoteModel, pageBlocks: BlockRecord[]) {
  const sourceToLocal = new Map<string, string>();
  const localIds = new Set<string>();
  for (const block of pageBlocks) {
    localIds.add(block.id);
    const sourceId = localSourceBlockId(block);
    if (sourceId) sourceToLocal.set(sourceId, block.id);
  }
  const children: Record<string, string> = {};
  for (const [key, sourceId] of Object.entries(model.sourceChildIds)) {
    const localId = sourceToLocal.get(sourceId) ?? (localIds.has(sourceId) ? sourceId : '');
    if (localId) children[key] = localId;
  }
  return children;
}

function transcriptBlockText(block: BlockRecord) {
  const direct = text(block.plainText);
  if (direct) return direct;
  const content = asRecord(block.content) ?? {};
  const rich = richTextSource(content.rich);
  if (rich.length > 0) return richTextPlainText(rich);
  const raw = asRecord(content.notionBlock);
  const rawType = text(raw?.type);
  const payload = rawType ? asRecord(raw?.[rawType]) : null;
  const rawRich = richTextSource(payload?.rich_text ?? payload?.richText);
  if (rawRich.length > 0) return richTextPlainText(rawRich);
  return text(content.expression);
}

function transcriptBlockMarkdown(block: BlockRecord) {
  const value = transcriptBlockText(block);
  if (!value) return '';
  if (block.type === 'heading_1') return `# ${value}`;
  if (block.type === 'heading_2') return `## ${value}`;
  if (block.type === 'heading_3') return `### ${value}`;
  if (block.type === 'heading_4') return `#### ${value}`;
  if (block.type === 'bulleted_list_item') return `- ${value}`;
  if (block.type === 'numbered_list_item') return `1. ${value}`;
  if (block.type === 'to_do') return `- [${asRecord(block.content)?.checked === true ? 'x' : ' '}] ${value}`;
  if (block.type === 'quote') return `> ${value}`;
  if (block.type === 'code') return `\`\`\`\n${value}\n\`\`\``;
  return value;
}

function transcriptForModel(
  model: MeetingNoteModel,
  pageBlocks: BlockRecord[],
  resolvedChildren: Record<string, string>,
) {
  const transcriptBlockId = resolvedChildren.transcript_block_id
    ?? (model.sourceType === 'transcription' ? model.block.id : '');
  if (!transcriptBlockId) return null;
  const blocksByParent = new Map<string | null, BlockRecord[]>();
  for (const block of pageBlocks) {
    const parentId = block.parentId ?? null;
    const siblings = blocksByParent.get(parentId) ?? [];
    siblings.push(block);
    blocksByParent.set(parentId, siblings);
  }
  for (const siblings of blocksByParent.values()) {
    siblings.sort((left, right) =>
      (left.position ?? 0) - (right.position ?? 0) || left.id.localeCompare(right.id)
    );
  }
  const root = pageBlocks.find((block) => block.id === transcriptBlockId);
  if (!root) return null;
  const ordered: BlockRecord[] = [];
  const visited = new Set<string>();
  const visit = (block: BlockRecord) => {
    if (visited.has(block.id)) return;
    visited.add(block.id);
    ordered.push(block);
    for (const child of blocksByParent.get(block.id) ?? []) visit(child);
  };
  visit(root);
  const blocks = ordered.map((block) => ({
    id: block.id,
    type: block.type,
    parent_id: block.parentId ?? null,
    text: transcriptBlockText(block),
  }));
  return {
    block_id: transcriptBlockId,
    text: blocks.map((block) => block.text).filter(Boolean).join('\n'),
    markdown: ordered.map(transcriptBlockMarkdown).filter(Boolean).join('\n'),
    blocks,
  };
}

async function resultForModel(
  model: MeetingNoteModel,
  pageBlocks: BlockRecord[],
  includeTranscript = false,
): Promise<MeetingNoteResultModel> {
  const children = resolvedMeetingChildIds(model, pageBlocks);
  const payload: Record<string, unknown> = {
    title: notionRichText(model.title, model.titleText),
  };
  const currentStatus = status(model.payload);
  if (currentStatus) payload.status = currentStatus;
  if (Object.keys(children).length > 0) payload.children = children;
  const event = calendarEvent(model.payload);
  if (event) payload.calendar_event = event;
  const recordingWindow = recording(model.payload);
  if (recordingWindow) payload.recording = recordingWindow;
  const directChildren = pageBlocks.some((block) => block.parentId === model.block.id);
  return {
    ...model,
    result: {
      object: 'block',
      id: model.block.id,
      type: 'meeting_notes',
      parent: model.block.parentId
        ? { type: 'block_id', block_id: model.block.parentId }
        : { type: 'page_id', page_id: model.block.pageId },
      meeting_notes: payload,
      created_time: model.createdTime,
      last_edited_time: model.lastEditedTime,
      created_by: { object: 'user', id: model.createdBy },
      last_edited_by: { object: 'user', id: model.lastEditedBy },
      has_children: directChildren,
      in_trash: model.page.inTrash === true,
      ...(includeTranscript ? { transcript: transcriptForModel(model, pageBlocks, children) } : {}),
    },
  };
}

function exactValue(value: unknown) {
  const record = asRecord(value);
  if (!record) return value;
  return record.value;
}

function personFilterIds(value: unknown) {
  const normalized = exactValue(value);
  if (!Array.isArray(normalized)) {
    const record = asRecord(normalized);
    const id = text(record?.id ?? normalized);
    return id ? [id] : [];
  }
  return normalized.map((item) => {
    const entry = asRecord(item);
    const nested = asRecord(entry?.value);
    return text(nested?.id ?? entry?.id ?? item);
  }).filter(Boolean);
}

function textCondition(actual: string, operator: string, rawValue: unknown) {
  if (operator === 'is_empty') return actual.length === 0;
  if (operator === 'is_not_empty') return actual.length > 0;
  const expected = text(exactValue(rawValue));
  const left = actual.toLocaleLowerCase();
  const right = expected.toLocaleLowerCase();
  if (operator === 'string_contains') return left.includes(right);
  if (operator === 'string_does_not_contain') return !left.includes(right);
  if (operator === 'string_equals') return left === right;
  if (operator === 'string_does_not_equal') return left !== right;
  throw new MeetingNotesValidationError(`Unsupported title filter operator: ${operator}.`);
}

function personCondition(actual: string[], operator: string, rawValue: unknown) {
  if (operator === 'is_empty') return actual.length === 0;
  if (operator === 'is_not_empty') return actual.length > 0;
  const expected = personFilterIds(rawValue);
  if (expected.length === 0) throw new MeetingNotesValidationError(`${operator} requires a person id.`);
  const contains = expected.some((id) => actual.includes(id));
  if (operator === 'person_contains') return contains;
  if (operator === 'person_does_not_contain') return !contains;
  throw new MeetingNotesValidationError(`Unsupported person filter operator: ${operator}.`);
}

function startOfUtcDay(date: Date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function addUtc(dateMs: number, count: number, unit: string) {
  const date = new Date(dateMs);
  if (unit === 'day') date.setUTCDate(date.getUTCDate() + count);
  else if (unit === 'week') date.setUTCDate(date.getUTCDate() + count * 7);
  else if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + count);
  else if (unit === 'year') date.setUTCFullYear(date.getUTCFullYear() + count);
  else throw new MeetingNotesValidationError(`Unsupported relative date unit: ${unit}.`);
  return date.getTime();
}

function dateRange(value: unknown, nowMs = Date.now()) {
  const wrapper = asRecord(value);
  const kind = text(wrapper?.type);
  const raw = wrapper ? wrapper.value : value;
  const nested = asRecord(raw);
  if (kind === 'relative') {
    const shorthand = text(raw);
    const day = startOfUtcDay(new Date(nowMs));
    if (shorthand === 'today') return [day, addUtc(day, 1, 'day') - 1] as const;
    if (shorthand === 'yesterday') return [addUtc(day, -1, 'day'), day - 1] as const;
    if (shorthand === 'tomorrow') return [addUtc(day, 1, 'day'), addUtc(day, 2, 'day') - 1] as const;
    const relative = shorthand.match(/^(past|next)_(day|week|month|year)$/);
    if (relative) {
      return relative[1] === 'past'
        ? [addUtc(nowMs, -1, relative[2]), nowMs] as const
        : [nowMs, addUtc(nowMs, 1, relative[2])] as const;
    }
  }
  if (wrapper?.direction && wrapper?.unit) {
    const direction = text(wrapper.direction);
    const unit = text(wrapper.unit);
    const count = typeof wrapper.count === 'number' && Number.isFinite(wrapper.count)
      ? Math.max(0, wrapper.count)
      : 1;
    return direction === 'past'
      ? [addUtc(nowMs, -count, unit), nowMs] as const
      : [nowMs, addUtc(nowMs, count, unit)] as const;
  }
  if (nested) {
    const start = text(nested.start_date ?? nested.startTime ?? nested.start_time);
    const end = text(nested.end_date ?? nested.endTime ?? nested.end_time);
    const startMs = Date.parse(start);
    const endMs = end ? Date.parse(end) : start.length === 10 ? addUtc(Date.parse(start), 1, 'day') - 1 : startMs;
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) return [startMs, endMs] as const;
  }
  const rawText = text(raw);
  const startMs = Date.parse(rawText);
  if (!Number.isFinite(startMs)) throw new MeetingNotesValidationError('Date filter value is invalid.');
  const endMs = rawText.length === 10 ? addUtc(startMs, 1, 'day') - 1 : startMs;
  return [startMs, endMs] as const;
}

function dateCondition(actual: string, operator: string, rawValue: unknown) {
  if (operator === 'is_empty') return !actual;
  if (operator === 'is_not_empty') return !!actual;
  const actualMs = Date.parse(actual);
  if (!Number.isFinite(actualMs)) return false;
  const [start, end] = dateRange(rawValue);
  if (['date_equals', 'equals', 'date_is'].includes(operator)) return actualMs >= start && actualMs <= end;
  if (['date_does_not_equal', 'does_not_equal', 'date_is_not'].includes(operator)) return actualMs < start || actualMs > end;
  if (['date_before', 'before', 'date_is_before'].includes(operator)) return actualMs < start;
  if (['date_after', 'after', 'date_is_after'].includes(operator)) return actualMs > end;
  if (['date_on_or_before', 'on_or_before', 'date_is_on_or_before'].includes(operator)) return actualMs <= end;
  if (['date_on_or_after', 'on_or_after', 'date_is_on_or_after'].includes(operator)) return actualMs >= start;
  throw new MeetingNotesValidationError(`Unsupported date filter operator: ${operator}.`);
}

function propertyCondition(model: MeetingNoteResultModel, node: Record<string, unknown>) {
  const rawProperty = text(node.property);
  const property = rawProperty === MEETING_ATTENDEES_PROPERTY ? 'attendees' : rawProperty;
  if (!FILTER_PROPERTIES.has(property)) throw new MeetingNotesValidationError(`Unsupported meeting note property: ${property}.`);
  const condition = asRecord(node.filter);
  const operator = text(condition?.operator);
  if (!condition || !operator) throw new MeetingNotesValidationError('A meeting note property filter requires an operator.');
  if (property === 'title') return textCondition(model.titleText, operator, condition.value);
  if (property === 'attendees') return personCondition(model.attendees, operator, condition.value);
  if (property === 'created_by') return personCondition([model.createdBy], operator, condition.value);
  if (property === 'last_edited_by') return personCondition([model.lastEditedBy], operator, condition.value);
  if (property === 'created_time') return dateCondition(model.createdTime, operator, condition.value);
  return dateCondition(model.lastEditedTime, operator, condition.value);
}

function filterCondition(model: MeetingNoteResultModel, raw: unknown, depth = 0): boolean {
  const node = asRecord(raw);
  if (!node) throw new MeetingNotesValidationError('Meeting notes filter must be an object.');
  if ('property' in node) return propertyCondition(model, node);
  const operator = text(node.operator);
  const filters = Array.isArray(node.filters) ? node.filters : null;
  if (!filters || (operator !== 'and' && operator !== 'or')) {
    throw new MeetingNotesValidationError('Meeting notes combinator requires and/or plus filters.');
  }
  if (depth >= 2) throw new MeetingNotesValidationError('Meeting notes filters may be nested only two levels.');
  if (filters.length === 0 || filters.length > 100) {
    throw new MeetingNotesValidationError('Meeting notes filters must contain between 1 and 100 items.');
  }
  return operator === 'and'
    ? filters.every((filter) => filterCondition(model, filter, depth + 1))
    : filters.some((filter) => filterCondition(model, filter, depth + 1));
}

interface MeetingSort {
  property: string;
  direction: 'ascending' | 'descending';
}

function normalizeSort(value: unknown): MeetingSort[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new MeetingNotesValidationError('sort must be an array with at most 100 entries.');
  }
  return value.map((item) => {
    const record = asRecord(item);
    const rawProperty = text(record?.property);
    const property = rawProperty === MEETING_ATTENDEES_PROPERTY ? 'attendees' : rawProperty;
    const direction = text(record?.direction);
    if (!FILTER_PROPERTIES.has(property)) throw new MeetingNotesValidationError(`Unsupported meeting note sort: ${property}.`);
    if (direction !== 'ascending' && direction !== 'descending') {
      throw new MeetingNotesValidationError('Meeting note sort direction must be ascending or descending.');
    }
    return { property, direction };
  });
}

function sortValue(model: MeetingNoteResultModel, property: string): string | number {
  if (property === 'title') return model.titleText.toLocaleLowerCase();
  if (property === 'attendees') return model.attendees.join('\u0000');
  if (property === 'created_by') return model.createdBy;
  if (property === 'last_edited_by') return model.lastEditedBy;
  if (property === 'created_time') return Date.parse(model.createdTime) || 0;
  return Date.parse(model.lastEditedTime) || 0;
}

function compare(left: string | number, right: string | number) {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function queryLimit(value: unknown) {
  if (value === undefined) return 50;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50) {
    throw new MeetingNotesValidationError('limit must be an integer between 1 and 50.');
  }
  return value;
}

/**
 * Queries real meeting-note artifacts only. A candidate is either a future
 * native `meeting_notes` block with canonical content, or an imported Notion
 * meeting_notes/transcription block whose original payload was preserved in
 * `content.notionBlock`. Ordinary toggles/pages are never inferred by title.
 */
export async function queryMeetingNotes(
  context: QueryMeetingNotesContext,
  input: QueryMeetingNotesInput = {},
) {
  const { db, workspaceId, actorId, actorEmail } = context;
  const allowedPageIds = new Set(context.allowedPageIds ?? []);
  const allowedDatabaseIds = new Set(context.allowedDatabaseIds ?? []);
  const resourceNarrowed = allowedPageIds.size > 0 || allowedDatabaseIds.size > 0;
  const pageId = input.page_id === undefined ? '' : text(input.page_id);
  if (input.page_id !== undefined && !pageId) {
    throw new MeetingNotesValidationError('page_id must be a non-empty string.');
  }
  if (input.include_transcript !== undefined && typeof input.include_transcript !== 'boolean') {
    throw new MeetingNotesValidationError('include_transcript must be a boolean.');
  }
  const includeTranscript = input.include_transcript === true;
  const limit = queryLimit(input.limit);
  const sorts = normalizeSort(input.sort);
  const [nativeBlocks, toggleBlocks, sourceActorIds] = await Promise.all([
    listAll(db.table<BlockRecord>('blocks').where('type', '==', 'meeting_notes'), {
      label: 'Native meeting notes',
    }),
    listAll(db.table<BlockRecord>('blocks').where('type', '==', 'toggle'), {
      label: 'Imported meeting notes',
    }),
    importedActorSourceUserIds(db, workspaceId, actorId),
  ]);
  const candidates = [...nativeBlocks, ...toggleBlocks];
  const pageCache = new Map<string, PageRecord | null>();
  const pageBlocksCache = new Map<string, BlockRecord[]>();
  const recognized: MeetingNoteModel[] = [];

  const allowedByResourceConsent = async (page: PageRecord) => {
    if (!resourceNarrowed) return true;
    const visited = new Set<string>();
    let current: PageRecord | null = page;
    while (current && !visited.has(current.id)) {
      if (allowedPageIds.has(current.id) || allowedDatabaseIds.has(current.id)) return true;
      if (current.parentType === 'database' && current.parentId && allowedDatabaseIds.has(current.parentId)) {
        return true;
      }
      visited.add(current.id);
      const logicalDatabaseParent: string | null = typeof current.properties?.notionParentDatabaseId === 'string'
        && current.properties.notionParentDatabaseId.trim()
        && current.properties.notionParentDatabaseId !== current.id
        ? current.properties.notionParentDatabaseId
        : null;
      const parentId: string | null | undefined = logicalDatabaseParent || current.parentId;
      if (!parentId) break;
      let parent = pageCache.get(parentId);
      if (parent === undefined) {
        parent = await getExisting(db.table<PageRecord>('pages'), parentId);
        pageCache.set(parentId, parent);
      }
      current = parent;
    }
    return false;
  };

  for (const block of candidates) {
    let page = pageCache.get(block.pageId);
    if (page === undefined) {
      page = await getExisting(db.table<PageRecord>('pages'), block.pageId);
      pageCache.set(block.pageId, page);
    }
    if (!page || page.workspaceId !== workspaceId || (pageId && page.id !== pageId)) continue;
    if (!(await allowedByResourceConsent(page))) continue;
    const role = await pageAccessRole(db, page, actorId, undefined, actorEmail);
    if (!role) continue;
    const model = meetingModel(block, page);
    if (model) recognized.push(model);
  }

  if (recognized.length === 0) {
    if (pageId) return { results: [], has_more: false };
    throw new MeetingNotesUnavailableError();
  }
  const visible = recognized.filter((model) => actorIsMeetingAttendee(model, actorId, sourceActorIds));
  const modeled: MeetingNoteResultModel[] = [];
  for (const model of visible) {
    let pageBlocks = pageBlocksCache.get(model.block.pageId);
    if (!pageBlocks) {
      pageBlocks = await listAll(
        db.table<BlockRecord>('blocks').where('pageId', '==', model.block.pageId),
        { label: `Meeting note page ${model.block.pageId}` },
      );
      pageBlocksCache.set(model.block.pageId, pageBlocks);
    }
    modeled.push(await resultForModel(model, pageBlocks, includeTranscript));
  }

  const filtered = input.filter === undefined
    ? modeled
    : modeled.filter((model) => filterCondition(model, input.filter));
  const indexed = filtered.map((model, index) => ({ model, index }));
  if (sorts.length > 0) {
    indexed.sort((left, right) => {
      for (const sort of sorts) {
        const delta = compare(sortValue(left.model, sort.property), sortValue(right.model, sort.property));
        if (delta !== 0) return sort.direction === 'ascending' ? delta : -delta;
      }
      return left.index - right.index;
    });
  }
  return {
    results: indexed.slice(0, limit).map(({ model }) => model.result),
    has_more: indexed.length > limit,
  };
}
