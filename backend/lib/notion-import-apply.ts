import { notionApiBase } from "./notion-import-credentials";
import {
  normalizedNotionId,
  type DiscoveredNotionItem,
} from "./notion-import-request-limits";
import { type AdminDbAccessor } from "./workspace-db";
import { recordWorkspaceAudit } from "./org-audit";
import {
  requireString,
  getExisting,
  listAll as listAllComplete,
  nowIso,
  newId,
  supportsFieldProjection,
  type TableQuery,
  type TransactDb,
  type TransactOperation,
} from "./table-utils";
import {
  parsePersistentGeneratedLocale,
  persistentGeneratedLabels,
  type PersistentGeneratedLocale,
} from "./persistent-generated-labels";
import type { DatabasePropertyType } from "./database-property-types";
import type { NotionDatabaseViewType } from "./database-view-types";
import type { NotionImportActivityEntry } from "./notion-import-discovery-progress";
import type { NotionImportProgressEvent } from "./notion-import-job-lifecycle";
import type {
  NotionImportConnectionDb,
  NotionImportConnectionKind,
  NotionTokenSource,
} from "./notion-import-connections";
import type {
  ImportConversionReport,
  NotionImportJob,
  NotionImportItem,
  NotionImportMapping,
  NotionImportStatus,
  NotionImportWarning,
} from "./notion-import-contracts";

export interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: string;
  kind?: string;
  title?: string;
  icon?: string;
  iconType?: string;
  cover?: string;
  coverPosition?: number;
  font?: string;
  smallText?: boolean;
  fullWidth?: boolean;
  isLocked?: boolean;
  isPublic?: boolean;
  backlinksDisplay?: string;
  pageCommentsDisplay?: string;
  properties?: Record<string, unknown>;
  notionImportJobId?: string | null;
  notionImportSourceId?: string | null;
  notionImportSourceKind?: string | null;
  notionImportStaging?: boolean;
  isFavorite?: boolean;
  inTrash?: boolean;
  trashedAt?: string | null;
  position?: number;
  createdBy?: string;
  lastEditedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Block {
  id: string;
  pageId: string;
  parentId?: string | null;
  type: string;
  content?: Record<string, unknown>;
  plainText?: string;
  position: number;
  createdBy?: string;
  lastEditedBy?: string;
  lastMutationId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DbProperty {
  id: string;
  databaseId: string;
  notionImportJobId?: string;
  notionDataSourceId?: string;
  notionPropertyId?: string;
  name: string;
  description?: string;
  type: DatabasePropertyType;
  config?: Record<string, unknown>;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface DbView {
  id: string;
  databaseId: string;
  notionImportJobId?: string;
  notionDataSourceId?: string;
  notionViewId?: string;
  notionViewStructuralIndex?: number;
  notionImportSnapshotRevision?: string;
  notionViewFingerprint?: string;
  notionRowContextJobId?: string;
  notionRowContextSnapshotRevision?: string;
  notionRowContextBlockId?: string;
  notionRowContextSourceViewId?: string;
  notionRowContextFingerprint?: string;
  name: string;
  type: NotionDatabaseViewType;
  config?: Record<string, unknown>;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface TemplateBlock {
  type: string;
  content?: Record<string, unknown>;
  plainText?: string;
  children?: TemplateBlock[];
}

export interface DbTemplate {
  id: string;
  databaseId: string;
  notionImportJobId?: string;
  notionTemplateId?: string;
  notionDataSourceId?: string;
  notionTemplateStructuralIndex?: number;
  notionImportSnapshotRevision?: string;
  notionTemplateFingerprint?: string;
  name: string;
  icon?: string;
  title?: string;
  properties?: Record<string, unknown>;
  blocks?: TemplateBlock[];
  isDefault?: boolean;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface FileUpload {
  id: string;
  workspaceId: string;
  bucket: string;
  key: string;
  scope: string;
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  propertyId?: string;
  templateId?: string;
  name: string;
  contentType?: string;
  size: number;
  etag?: string;
  status: 'preparing' | 'pending' | 'uploaded' | 'deleting' | 'deleted' | 'expired';
  url?: string;
  createdBy?: string;
  expiresAt?: string | null;
  completedAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string;
  deletionPreviousStatus?: 'preparing' | 'pending' | 'uploaded' | null;
  notionImportJobId?: string;
  notionImportSnapshotRevision?: string;
  notionImportSlotKey?: string;
  notionImportTerminalSweepAfter?: string | null;
  notionImportTerminalSweepCompletedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotionFileReference {
  id: string;
  name: string;
  url: string;
  type?: string;
  size?: number;
  notionFileSource: 'external' | 'notion_file' | 'direct_url' | 'unknown';
  notionFileExpiryTime?: string;
  notionFile?: Record<string, unknown>;
  uploadId?: string;
  bucket?: string;
  key?: string;
  sourceUrl?: string;
  notionFileCopied?: boolean;
  notionFileCopiedAt?: string | null;
}

interface NotionFileCopyStats {
  fileCopies: number;
  fileCopySkipped: number;
}

export interface NotionFileCopyTarget {
  notionId?: string;
  notionObject: string;
  label: string;
  scope: 'icons' | 'covers' | 'blocks/images' | 'blocks/videos' | 'blocks/audio' | 'blocks/files' | 'database/files';
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  propertyId?: string;
  templateId?: string;
  notionPageId?: string;
  notionBlockId?: string;
  notionPropertyId?: string;
  notionPropertyName?: string;
  notionFileIndex?: number;
  notionFileName?: string;
  notionPageFileKind?: 'icon' | 'cover';
  notionFileRole?: string;
  notionFileStructuralPath?: string;
  notionFileOrdinal?: number;
}

export interface NotionFileCopyContext {
  db: DbRef;
  admin: AdminDbAccessor;
  job: NotionImportJob;
  actorId: string;
  storage?: FunctionStorageProxy;
  request?: Request;
  conversionReport?: ImportConversionReport;
  requireStoredFileCopies: boolean;
  notionToken?: string;
  apiVersion: string;
  apiBase?: string;
  stats: NotionFileCopyStats;
  createdUploadIds?: string[];
  itemSnapshotRevision?: string;
  checkpointUploadsBySlotKey?: Map<string, FileUpload>;
  checkpointSlotKeysByCoordinates?: Map<string, string>;
  applyLease?: { id: string; leaseId: string };
  checkpointOnly?: boolean;
  requireFileCopyCheckpoint?: boolean;
  onRequiredCheckpointUnavailable?: (
    slotKey: string,
    target: NotionFileCopyTarget,
    reason: 'missing' | 'not_uploaded',
  ) => Promise<never>;
  verifiedCheckpointUploadIds?: Set<string>;
  pendingCheckpointTargets?: Map<string, NotionFileCopyTarget>;
  blockRecoveryPage?: Pick<
    Page,
    | 'id'
    | 'workspaceId'
    | 'parentId'
    | 'parentType'
    | 'inTrash'
    | 'trashedAt'
    | 'position'
    | 'isLocked'
    | 'updatedAt'
  >;
}

export interface NotionImportFileCopySlot {
  slotKey: string;
  reference: NotionFileReference;
  target: NotionFileCopyTarget;
}

interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

export interface FunctionStorageProxy {
  bucket?(bucket: string): FunctionStorageProxy;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | string,
    options?: { contentType?: string; customMetadata?: Record<string, string> },
  ): Promise<void>;
  head(key: string): Promise<{
    key: string;
    size: number;
    etag?: string;
    contentType: string;
    customMetadata?: Record<string, string>;
  } | null>;
  delete(key: string): Promise<void>;
  getSignedUrl?(key: string, options?: { expiresIn?: number }): Promise<string>;
}

export interface ImportedPropertyContext {
  dataSourceId: string;
  notionPropertyId: string;
  notionPropertyName: string;
  notionProperty: Record<string, unknown>;
  property: DbProperty;
}

export interface ImportedRowContext {
  page: Page;
  dataSourceId: string;
  notionId: string;
}

export interface ImportedPageBlockContext {
  page: Page;
  notionId: string;
}

export interface ImportedBlockMapping {
  localId: string;
  pageId: string;
}

interface ImportedBlockOwnerContext {
  pageNotionId: string;
  blockNotionId: string;
  blockType?: string;
  parentBlockNotionId?: string | null;
  position?: number;
}

export interface ImportedTemplateContext {
  template: DbTemplate;
  dataSourceId: string;
  notionId?: string;
}

type ImportedPageIconType = 'none' | 'emoji' | 'image';

interface ImportedPageChrome {
  icon?: string;
  iconType: ImportedPageIconType;
  cover?: string;
  coverPosition?: number;
  iconReference?: NotionFileReference;
  coverReference?: NotionFileReference;
}

type ImportedPatchOwnerTable = 'pages' | 'blocks' | 'db_properties' | 'db_views' | 'db_templates';

interface NotionImportMappingInput {
  notionId: string;
  notionType: string;
  localId: string;
  localType: string;
  relationKind?: string;
  metadata?: Record<string, unknown>;
}

type NotionImportCredentialScrubMutationCollector = (
  operation: TransactOperation,
) => Promise<void>;

interface NotionImportConnectionTokenJob {
  connectionId?: string | null;
  options?: Record<string, unknown>;
}

type CleanNotionImportJob = Omit<
  NotionImportJob,
  | 'activeItemGeneration'
  | 'itemSnapshotRevision'
  | 'options'
  | 'counts'
  | 'progress'
  | 'report'
> & {
  options: Record<string, unknown>;
  counts: Record<string, number>;
  progress: Record<string, unknown>;
  report: Record<string, unknown>;
};

export interface NotionImportApplyRuntime {
  NOTION_API_VERSION: string;
  NOTION_BLOCK_CHILD_TOTAL_LIMIT: number;
  NOTION_IMPORT_PUBLICATION_BOUNDARY_VERSION: number;
  GENERATED_NOTION_TITLE_PROPERTY_ID: string;
  notionAppliedCountsFromMappings(
    mappings: Pick<NotionImportMapping, 'localId' | 'localType' | 'relationKind'>[],
  ): Record<string, number>;
  withImportProgress(
    previousProgress: Record<string, unknown> | undefined,
    event: NotionImportProgressEvent,
  ): Record<string, unknown>;
  optionalString(value: unknown): string | undefined;
  parsePositiveInt(value: unknown, fallback: number, max: number): number;
  listAll<T>(query: TableQuery<T>, maxItems?: number): Promise<T[]>;
  assertWritableJob(
    db: DbRef,
    job: NotionImportJob,
    actorId: string,
  ): Promise<void>;
  notionTokenForJob(
    db: NotionImportConnectionDb,
    body: Record<string, unknown>,
    job: NotionImportConnectionTokenJob,
    actorId: string,
    env: Record<string, unknown> | undefined,
  ): Promise<NotionTokenSource>;
  cleanJob(job: NotionImportJob): CleanNotionImportJob;
  assertSafeNotionImportSourceReferences(db: DbRef, value: unknown): Promise<void>;
  notionObjectId(record: Record<string, unknown>): string | undefined;
  itemMetadata(
    item: NotionImportItem | DiscoveredNotionItem,
  ): Record<string, unknown>;
  dataSourceSnapshot(
    item: NotionImportItem | DiscoveredNotionItem,
  ): Record<string, unknown> | undefined;
  viewSnapshot(
    item: NotionImportItem | DiscoveredNotionItem,
  ): Record<string, unknown> | undefined;
  notionPropertiesFromSnapshot(
    snapshot: Record<string, unknown> | undefined,
  ): Record<string, unknown>;
  augmentNotionPropertiesFromRowSnapshots(
    sourceProperties: Record<string, unknown>,
    dataSourceId: string,
    items: NotionImportItem[],
  ): { properties: Record<string, unknown>; inferred: number };
  withGeneratedTitleProperty(
    properties: Record<string, unknown>,
    locale: PersistentGeneratedLocale,
  ): Record<string, unknown>;
  notionPropertyMappingId(dataSourceId: string, propertyId: string): string;
  asRecord(value: unknown): Record<string, unknown> | undefined;
  importedPageChromeFromItem(
    item: NotionImportItem | DiscoveredNotionItem,
  ): ImportedPageChrome;
  importedPageShouldUseFullWidth(
    item: NotionImportItem | DiscoveredNotionItem,
    importPagesFullWidth?: boolean,
  ): boolean;
  pagePropertiesWithChromeReferences(
    properties: Record<string, unknown> | undefined,
    chrome: ImportedPageChrome,
  ): Record<string, unknown> | undefined;
  initialImportedPageChrome(chrome: ImportedPageChrome): {
    icon: string | undefined;
    iconType: 'none' | 'emoji';
    cover: undefined;
    coverPosition: undefined;
  };
  emptyConversionReport(): ImportConversionReport;
  incrementReport(report: ImportConversionReport, key: string, by?: number): void;
  pushReportIssue(
    list: NotionImportWarning[],
    issue: NotionImportWarning,
    maxItems?: number,
  ): void;
  reportUnsupportedProperty(
    report: ImportConversionReport,
    dataSourceId: string,
    propertyId: string,
    propertyName: string,
    notionType: string,
  ): void;
  reportUnsupportedView(
    report: ImportConversionReport,
    dataSourceId: string,
    view: Record<string, unknown>,
  ): void;
  parseOptionalBoolean(value: unknown): boolean | undefined;
  assertNotionFileCopyNotDisabled(body?: Record<string, unknown>): void;
  dbPropertyFromNotion(
    databaseId: string,
    notionPropertyId: string,
    notionProperty: unknown,
    position: number,
  ): DbProperty;
  setViewPropertyMapping(
    propertyMappings: Map<string, string>,
    key: unknown,
    localId: string,
  ): void;
  dbViewFromNotion(
    databaseId: string,
    view: Record<string, unknown>,
    position: number,
    propertyMappings?: Map<string, string>,
    report?: ImportConversionReport,
    dataSourceId?: string,
    localProperties?: DbProperty[],
  ): DbView;
  rawTemplatesFromSnapshot(
    snapshot: Record<string, unknown> | undefined,
  ): Record<string, unknown>[];
  rawTemplateBlocks(template: Record<string, unknown>): Record<string, unknown>[];
  dbTemplateFromNotion(
    databaseId: string,
    template: Record<string, unknown>,
    propertyMappings: Map<string, string>,
    position: number,
    report?: ImportConversionReport,
    dataSourceId?: string,
  ): DbTemplate;
  reportTemplateBlockRichTextUserReferences(
    report: ImportConversionReport | undefined,
    item: NotionImportItem,
    block: Record<string, unknown>,
  ): void;
  compareNotionImportViewItems(a: NotionImportItem, b: NotionImportItem): number;
  localizedImportableNotionViews(
    rawViews: Record<string, unknown>[],
    locale: PersistentGeneratedLocale,
  ): Record<string, unknown>[];
  inferCanonicalDataSourceForHiddenLinkedDatabase(
    databaseItem: NotionImportItem,
    items: NotionImportItem[],
    dataSourceItems: NotionImportItem[],
    mappingsByNotionId: Map<string, NotionImportMapping>,
  ): {
    mapping: NotionImportMapping;
    dataSourceItem: NotionImportItem;
    heading?: string;
    matchedLabel: string;
    matchedView?: Record<string, unknown>;
    matchedViewId?: string;
    matchedViewIds?: string[];
    inferredFrom: 'view_parent_database_id' | 'sibling_heading_view_name';
  } | undefined;
  meaningfulImportedTitle(value: unknown): string;
  hiddenLinkedDatabaseFallbackTitle(
    item: NotionImportItem,
    items: NotionImportItem[],
    database: Record<string, unknown> | undefined,
    locale?: PersistentGeneratedLocale,
  ): string;
  pushImportActivity(
    ring: NotionImportActivityEntry[],
    entry: { kind: string; title?: string; count?: number; total?: number },
  ): void;
  importActivityRingOf(
    progress: Record<string, unknown> | undefined,
  ): NotionImportActivityEntry[];
  listActiveNotionImportDiscoverySeeds(
    db: DbRef,
    job: NotionImportJob,
  ): Promise<NotionImportItem[]>;
  listActiveNotionImportItems(
    db: DbRef,
    job: NotionImportJob,
  ): Promise<NotionImportItem[]>;
  collectNotionImportFileCopySlots(
    allItems: NotionImportItem[],
    revision: string,
    includedItemIds?: Set<string>,
  ): Promise<NotionImportFileCopySlot[]>;
  notionImportFileSlotCoordinates(
    revision: string,
    target: NotionFileCopyTarget,
  ): string;
  loadNotionImportFileCheckpoints(
    db: DbRef,
    jobId: string,
    revision: string,
  ): Promise<Map<string, FileUpload>>;
  loadNotionImportFileCheckpointBySlotKey(
    db: DbRef,
    jobId: string,
    revision: string,
    slotKey: string,
  ): Promise<FileUpload>;
  cleanupUnownedNotionImportFileCheckpoints(
    context: NotionFileCopyContext,
  ): Promise<void>;
  copyNotionImportFileSlot(
    context: NotionFileCopyContext,
    slot: NotionImportFileCopySlot,
  ): Promise<NotionFileReference>;
  scrubAppliedImportCredentialMetadata(
    db: DbRef,
    items: NotionImportItem[],
    collectMutation?: NotionImportCredentialScrubMutationCollector,
  ): Promise<void>;
  finalizeConversionReport(report: ImportConversionReport): ImportConversionReport;
  basePage(input: {
    workspaceId: string;
    parentId?: string | null;
    parentType?: string;
    kind: 'page' | 'database';
    title: string;
    icon?: string;
    iconType?: ImportedPageIconType;
    cover?: string;
    coverPosition?: number;
    fullWidth?: boolean;
    isFavorite?: boolean;
    position: number;
    actorId: string;
    properties?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }): Page;
  importedItemTimestamps(item: NotionImportItem): {
    createdAt: string | undefined;
    updatedAt: string | undefined;
  };
  transactImportedOwnerPatch<T extends { id: string }>(
    context: NotionFileCopyContext,
    input: {
      table: ImportedPatchOwnerTable;
      owner: T;
      patch: Partial<T>;
      requiredWhere: Array<[string, '==', unknown]>;
      extraExpectations?: TransactOperation[];
      label: string;
    },
  ): Promise<T>;
  preserveImportedPageTimestamps(
    context: NotionFileCopyContext,
    page: Page,
    item: NotionImportItem,
  ): Promise<Page>;
  loadMappings(
    db: DbRef,
    jobId: string,
  ): Promise<Map<string, NotionImportMapping>>;
  buildImportedBlockOwnerContexts(
    items: NotionImportItem[],
  ): Map<string, ImportedBlockOwnerContext>;
  resolveImportedPageParentFromNotionBlocks(
    item: NotionImportItem,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    blockOwnerContextsByNotionId: Map<string, ImportedBlockOwnerContext>,
  ): { parentId?: string; position?: number };
  moveImportedPageToResolvedParent(
    context: NotionFileCopyContext,
    page: Page,
    resolvedParent: { parentId?: string; position?: number },
  ): Promise<Page>;
  createMapping(
    db: DbRef,
    admin: AdminDbAccessor,
    job: NotionImportJob,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    input: NotionImportMappingInput,
  ): Promise<NotionImportMapping>;
  publishRecoveredImportedOwnerMapping(
    context: NotionFileCopyContext,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    input: NotionImportMappingInput,
    ownerExpectation: {
      table: 'pages' | 'db_templates' | 'db_properties' | 'db_views';
      id: string;
      where: Array<[string, '==', unknown]>;
      patch?: Record<string, unknown>;
      uniqueWhere?: Array<[string, '==', unknown]>;
    },
  ): Promise<NotionImportMapping>;
  publishImportedDatabaseAliasMapping(
    context: NotionFileCopyContext,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    input: NotionImportMappingInput,
    owner: Page,
    canonicalDataSourceId: string,
    patchCanonicalProperties?: boolean,
  ): Promise<{ mapping: NotionImportMapping; created: boolean }>;
  insertImportedDatabaseChildWithMapping<T extends DbProperty | DbView>(
    context: NotionFileCopyContext,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    table: 'db_properties' | 'db_views',
    owner: T,
    input?: Omit<NotionImportMappingInput, 'localId'>,
    uniqueWhere?: Array<[string, '==', unknown]>,
  ): Promise<{ owner: T; mapping: NotionImportMapping | undefined }>;
  claimRecoveredImportedDatabaseChild(
    context: NotionFileCopyContext,
    table: 'db_properties' | 'db_views' | 'db_templates',
    ownerId: string,
    where: Array<[string, '==', unknown]>,
    patch: Record<string, unknown>,
    uniqueWhere?: Array<[string, '==', unknown]>,
    extraExpectations?: TransactOperation[],
  ): Promise<void>;
  insertImportedPageWithMapping(
    context: NotionFileCopyContext,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    page: Page,
    input: Omit<NotionImportMappingInput, 'localId'>,
    stageBlockRecovery?: boolean,
  ): Promise<{ page: Page; mapping: NotionImportMapping }>;
  ensureImportRoot(
    db: DbRef,
    admin: AdminDbAccessor,
    job: NotionImportJob,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    actorId: string,
    applyLease?: { id: string; leaseId: string },
  ): Promise<string>;
  stageIncompleteImportPages(
    db: DbRef,
    job: NotionImportJob,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    applyLease?: { id: string; leaseId: string },
  ): Promise<{ complete: boolean; staged: number }>;
  unwrapImportRoot(
    db: DbRef,
    admin: AdminDbAccessor,
    job: NotionImportJob,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    applyLease?: { id: string; leaseId: string },
    expectedJobStatus?: NotionImportStatus,
  ): Promise<{ unwrapped: number; moved: number }>;
  rowDataSourceId(
    item: NotionImportItem,
    dataSourceIds: Set<string>,
  ): string | undefined;
  rowPropertiesForDataSource(
    rawProperties: unknown,
    propertyMappings: Map<string, string>,
    reportContext?: {
      report?: ImportConversionReport;
      notionId?: string;
      notionObject?: string;
    },
    options?: { omitFileValuesNeedingStorage?: boolean },
  ): Record<string, unknown>;
  copyImportedRowFileProperties(
    context: NotionFileCopyContext,
    page: Page,
    databaseId: string,
    rawProperties: unknown,
    propertyMappings: Map<string, string>,
    item: NotionImportItem,
  ): Promise<Page>;
  importedRowFilePropertiesNeedCopy(
    pageProperties: Record<string, unknown> | undefined,
    rawProperties: unknown,
    propertyMappings: Map<string, string>,
  ): boolean;
  copyImportedPageChromeFiles(
    context: NotionFileCopyContext,
    page: Page,
    item: NotionImportItem,
  ): Promise<Page>;
  existingImportedTemplateFileState(
    context: NotionFileCopyContext,
    template: DbTemplate,
    rawTemplate: Record<string, unknown>,
    propertyMappings: Map<string, string>,
  ): Promise<'complete' | 'source_only'>;
  copyImportedTemplateFiles(
    context: NotionFileCopyContext,
    template: DbTemplate,
    rawTemplate: Record<string, unknown>,
    propertyMappings: Map<string, string>,
    item: NotionImportItem,
    templateStructuralPath: string,
  ): Promise<DbTemplate>;
  insertImportedTemplateWithFiles(
    context: NotionFileCopyContext,
    template: DbTemplate,
    mappingCommit?: {
      mappingsByNotionId: Map<string, NotionImportMapping>;
      input: Omit<NotionImportMappingInput, 'localId'>;
    },
    uniqueWhere?: Array<[string, '==', unknown]>,
  ): Promise<DbTemplate>;
  updateImportedTemplateWithFiles(
    context: NotionFileCopyContext,
    template: DbTemplate,
    patch: Partial<DbTemplate>,
  ): Promise<DbTemplate>;
  remapImportedDatabaseProperties(
    applyContext: NotionFileCopyContext,
    contexts: ImportedPropertyContext[],
    propertyMappingsByDataSource: Map<string, Map<string, string>>,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    conversionReport?: ImportConversionReport,
  ): Promise<{ remapped: number; unresolved: number }>;
  remapImportedTemplateBlocksRichTextMentions(
    blocks: TemplateBlock[] | undefined,
    mappingsByNotionId: Map<string, NotionImportMapping>,
  ): {
    blocks: TemplateBlock[] | undefined;
    changed: boolean;
    remapped: number;
    observedRemapped: number;
    unresolved: string[];
  };
  reportRichTextMentionRemap(
    report: ImportConversionReport | undefined,
    notionId: string | undefined,
    notionObject: string,
    label: string,
    result: {
      remapped: number;
      observedRemapped?: number;
      unresolved: string[];
    },
    options?: { reportUnresolved?: boolean },
  ): void;
  remapImportedPageBlockRichTextMentions(
    applyContext: NotionFileCopyContext,
    pages: ImportedPageBlockContext[],
    mappingsByNotionId: Map<string, NotionImportMapping>,
    conversionReport?: ImportConversionReport,
  ): Promise<number>;
  remapImportedPageLinkBlocks(
    applyContext: NotionFileCopyContext,
    pages: ImportedPageBlockContext[],
    mappingsByNotionId: Map<string, NotionImportMapping>,
    conversionReport?: ImportConversionReport,
  ): Promise<{
    updatedBlocks: number;
    mappedBlocks: number;
    remappedTargets: number;
    unresolvedTargets: number;
  }>;
  remapImportedSyncedBlocks(
    applyContext: NotionFileCopyContext,
    pages: ImportedPageBlockContext[],
    blockMappingsByNotionId: Map<string, ImportedBlockMapping>,
    conversionReport?: ImportConversionReport,
    resolveMissingSource?: (
      notionBlockId: string,
    ) => Promise<ImportedBlockMapping | undefined>,
  ): Promise<{ remapped: number; observedRemapped: number; unresolved: number }>;
  remapImportedRowRelationProperties(
    row: Page,
    relationProps: DbProperty[],
    mappingsByNotionId: Map<string, NotionImportMapping>,
  ): Record<string, unknown> | undefined;
  remapImportedTemplateRelationProperties(
    template: DbTemplate,
    relationProps: DbProperty[],
    mappingsByNotionId: Map<string, NotionImportMapping>,
  ): {
    properties: Record<string, unknown> | undefined;
    unresolved: Record<string, string[]>;
  };
  remapImportedDatabaseViewRelationFilters(
    context: NotionFileCopyContext,
    dataSourceItems: NotionImportItem[],
    propertyRecordsByDataSource: Map<string, DbProperty[]>,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    conversionReport?: ImportConversionReport,
  ): Promise<{ updatedViews: number; remapped: number; unresolved: number }>;
  addImportedLinkedDatabaseRowContextFilters(
    context: NotionFileCopyContext,
    pages: ImportedPageBlockContext[],
    conversionReport?: ImportConversionReport,
  ): Promise<{ updatedViews: number }>;
  remapImportedTemplateLinkedDatabaseBlocks(
    context: NotionFileCopyContext,
    templateContext: ImportedTemplateContext,
    mappingsByNotionId: Map<string, NotionImportMapping>,
  ): Promise<{ blocks: TemplateBlock[] | undefined; changed: boolean }>;
  insertPageBlocksFromSnapshot(
    db: DbRef,
    pageId: string,
    item: NotionImportItem,
    actorId: string,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    conversionReport?: ImportConversionReport,
    fileCopyContext?: NotionFileCopyContext,
    blockMappingsByNotionId?: Map<string, ImportedBlockMapping>,
    itemsByNotionId?: Map<string, NotionImportItem>,
    existingBlocksByNotionId?: Map<string, Block>,
  ): Promise<Block[]>;
  inspectDiscoveryCompletenessForReport(
    report: ImportConversionReport,
    job: NotionImportJob,
    items: NotionImportItem[],
  ): void;
  itemHasImportablePageBody(item: NotionImportItem): boolean;
  replayImportedPageBlockMetrics(
    item: NotionImportItem,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    conversionReport?: ImportConversionReport,
    itemsByNotionId?: Map<string, NotionImportItem>,
  ): number;
  importedBlocksComplete(page: Page): boolean;
  markImportedBlocksComplete(
    db: DbRef,
    page: Page,
    context?: NotionFileCopyContext,
  ): Promise<Page>;
  replaceImportedBlocksForPage(
    db: DbRef,
    page: Page,
    item: NotionImportItem,
    actorId: string,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    conversionReport: ImportConversionReport,
    fileCopyContext: NotionFileCopyContext,
    importedBlockMappingsByNotionId: Map<string, ImportedBlockMapping>,
    itemsByNotionId?: Map<string, NotionImportItem>,
    prepareRecoveredPage?: (page: Page) => Promise<Page>,
  ): Promise<{ page: Page; insertedBlocks: Block[]; reusedBlocks: number }>;
  ensureImportedPageWorkspaceIndexes(
    admin: AdminDbAccessor,
    mappings: NotionImportMapping[],
    workspaceId: string,
  ): Promise<void>;
  renewNotionApplyLease(
    db: DbRef,
    lease: { id: string; leaseId: string },
    purpose?: 'apply' | 'discover',
  ): Promise<void>;
  updateNotionJobIfStatus(
    db: DbRef,
    jobId: string,
    expectedStatus: NotionImportStatus,
    data: Partial<NotionImportJob>,
    options?: {
      expectedItemGeneration?: string | null;
      extraExpectations?: TransactOperation[];
    },
  ): Promise<NotionImportJob | null>;
}

interface NotionImportApplySnapshotCacheEntry {
  items: NotionImportItem[];
  mappingsByNotionId: Map<string, NotionImportMapping>;
  blockOwnerContextsByNotionId: ReturnType<NotionImportApplyRuntime['buildImportedBlockOwnerContexts']>;
  importedBlockMappingsByNotionId: Map<string, ImportedBlockMapping>;
  complete: boolean;
  /** Immutable, revision-scoped inventory for the dedicated pre-copy phase.
   * It is derived once per worker cache lifetime; a restart recomputes it from
   * the durable item snapshot without affecting correctness. */
  fileCopySlots?: NotionImportFileCopySlot[];
  fileCheckpointUploadsBySlotKey?: Awaited<ReturnType<
    NotionImportApplyRuntime['loadNotionImportFileCheckpoints']
  >>;
  fileSlotKeysByCoordinates?: Map<string, string>;
  preparation?: {
    seeds: NotionImportItem[];
  };
}

// A resumable apply releases its durable lease between deliberately small HTTP
// chunks. Re-reading and decoding the same multi-megabyte staging graph on
// every chunk starved health checks on small NAS CPUs. Cache at most two
// immutable, revision-keyed graphs; a worker restart simply rebuilds one, and
// every discovery/append publication changes the revision so stale data cannot
// be reused.
// Two jobs can legitimately interleave chunks on the same worker. Keeping two
// immutable graphs prevents them from evicting one another on every request;
// correctness never depends on this cache (all cursors and remaps are durable).
const NOTION_IMPORT_APPLY_SNAPSHOT_CACHE_LIMIT = 2;
const NOTION_IMPORT_APPLY_PREPARE_BATCH_SIZE = 5;
const NOTION_IMPORT_APPLY_PREPARE_BATCH_SIZE_MAX = 50;
const NOTION_IMPORT_APPLY_FILE_BATCH_SIZE = 10;
const NOTION_IMPORT_APPLY_FILE_BATCH_SIZE_MAX = 10;
const NOTION_IMPORT_APPLY_FILE_DEADLINE_MS = 8_000;
const SOURCE_UNAVAILABLE_PLACEHOLDER_VIEW_ID = '__hanji_source_unavailable_default_view__';
const notionImportApplySnapshotCache = new Map<string, NotionImportApplySnapshotCacheEntry>();

type ConversionIssueKey = Exclude<keyof ImportConversionReport, 'summary'>;
const CONVERSION_ISSUE_KEYS = [
  'warnings',
  'unsupported',
  'missingPermissions',
  'unresolvedReferences',
] as const satisfies readonly ConversionIssueKey[];
const CONVERSION_ISSUE_KEY_SET = new Set<string>(CONVERSION_ISSUE_KEYS);

export const NOTION_IMPORT_APPLY_ORDER_VERSION = 'code-unit-v1';

export function compareNotionImportApplyStableKeys(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function applyCursorRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function normalizeNotionImportApplyCursorOrder(
  cursor: Record<string, unknown>,
): Record<string, unknown> {
  const phase = typeof cursor.phase === 'string' ? cursor.phase : undefined;
  const alreadyCurrent = cursor.orderVersion === NOTION_IMPORT_APPLY_ORDER_VERSION;
  const normalized: Record<string, unknown> = {
    ...cursor,
    orderVersion: NOTION_IMPORT_APPLY_ORDER_VERSION,
  };

  if (!alreadyCurrent) {
    if (phase === 'apply_prepare' || phase === 'apply_scrub') normalized.itemIndex = 0;
    if (phase === 'apply_file_copies') {
      normalized.fileIndex = 0;
      delete normalized.lastSlotKey;
    }
    if (phase === 'apply_data_sources' || phase === 'apply_global_remap') {
      normalized.dataSourceIndex = 0;
    }
    if (phase === 'apply_database_containers') normalized.databaseIndex = 0;
    if (phase === 'apply_pages') normalized.pageIndex = 0;
    if (phase === 'apply_remap') normalized.remapIndex = 0;
    if (phase === 'apply_finalize_indexes') normalized.mappingIndex = 0;
  }

  for (const nestedKey of ['resumeCursor', 'resumeFileCursor'] as const) {
    const nested = applyCursorRecord(cursor[nestedKey]);
    if (nested) normalized[nestedKey] = normalizeNotionImportApplyCursorOrder(nested);
  }
  return normalized;
}

function stableImportItemKey(item: NotionImportItem) {
  return `${item.id ?? ''}\n${item.notionObject}\n${item.notionId}`;
}

function compareStableImportItems(left: NotionImportItem, right: NotionImportItem) {
  return compareNotionImportApplyStableKeys(
    stableImportItemKey(left),
    stableImportItemKey(right),
  );
}

function stableMappingKey(mapping: NotionImportMapping) {
  return `${mapping.mappingKey ?? ''}\n${mapping.id ?? ''}\n${mapping.notionId}`;
}

function compareStableMappings(left: NotionImportMapping, right: NotionImportMapping) {
  return compareNotionImportApplyStableKeys(
    stableMappingKey(left),
    stableMappingKey(right),
  );
}

function canonicalImportedViewFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalImportedViewFingerprintValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalImportedViewFingerprintValue(item)]),
  );
}

// View owners still carry the original unversioned collation fingerprint.
// Keep that compatibility lane isolated until it has its own atomic migration;
// template fingerprints use the versioned code-unit canonicalizer below.
function importedSnapshotFingerprint(value: Record<string, unknown>) {
  const canonical = JSON.stringify(canonicalImportedViewFingerprintValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function importedViewFingerprint(view: Record<string, unknown>) {
  return importedSnapshotFingerprint(view);
}

export const NOTION_IMPORT_TEMPLATE_FINGERPRINT_VERSION = 'code-unit-v1';

function canonicalImportTemplateFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalImportTemplateFingerprintValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareNotionImportApplyStableKeys(left, right))
      .map(([key, item]) => [key, canonicalImportTemplateFingerprintValue(item)]),
  );
}

export function canonicalNotionImportTemplateSnapshot(value: Record<string, unknown>) {
  return JSON.stringify(canonicalImportTemplateFingerprintValue(value));
}

export function notionImportTemplateFingerprint(value: Record<string, unknown>) {
  const canonical = canonicalNotionImportTemplateSnapshot(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${NOTION_IMPORT_TEMPLATE_FINGERPRINT_VERSION}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function importedTemplateFingerprint(template: Record<string, unknown>) {
  return notionImportTemplateFingerprint(template);
}

function importedTemplateImmutableOwnerSnapshot(template: DbTemplate) {
  return canonicalImportTemplateFingerprintValue({
    databaseId: template.databaseId,
    name: template.name,
    icon: template.icon ?? null,
    title: template.title ?? null,
    properties: template.properties ?? null,
    blocks: template.blocks ?? [],
    isDefault: template.isDefault === true,
    position: template.position,
  });
}

function importedTemplateOwnerMatchesImmutableSnapshot(
  candidate: DbTemplate,
  expected: DbTemplate,
) {
  return JSON.stringify(importedTemplateImmutableOwnerSnapshot(candidate))
    === JSON.stringify(importedTemplateImmutableOwnerSnapshot(expected));
}

const IMPORTED_TEMPLATE_FILE_BLOCK_TYPES = new Set(['image', 'video', 'audio', 'file', 'pdf']);
const IMPORTED_TEMPLATE_FILE_CONTENT_FIELDS = new Set([
  'url',
  'sourceUrl',
  'fileName',
  'fileUploadId',
  'fileKey',
  'fileBucket',
  'notionFileReference',
  'notionFileSource',
  'notionFileExpiryTime',
  'notionFileCopied',
  // Stored-file publication deliberately removes this credential-bearing raw
  // shadow. Ignore it only on a raw block that is itself a file slot; captions,
  // rich text, children, and every non-file block field remain comparable.
  'notionBlock',
]);

function importRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rawImportedTemplateBlockChildren(block: Record<string, unknown>) {
  const type = typeof block.type === 'string' ? block.type : '';
  const payload = type ? importRecord(block[type]) : undefined;
  for (const value of [block.children, block.childBlocks, payload?.children, payload?.childBlocks]) {
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => !!importRecord(item));
    }
  }
  return [];
}

function comparableImportedTemplateFileBlockContent(value: unknown) {
  const content = importRecord(value);
  if (!content) return value;
  return Object.fromEntries(
    Object.entries(content).filter(([field]) => !IMPORTED_TEMPLATE_FILE_CONTENT_FIELDS.has(field)),
  );
}

function comparableImportedTemplateBlocks(
  value: unknown,
  rawBlocks: Record<string, unknown>[],
): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item, index) => {
    const block = importRecord(item);
    const rawBlock = rawBlocks[index];
    if (!block || !rawBlock) return item;
    const rawChildren = rawImportedTemplateBlockChildren(rawBlock);
    const next: Record<string, unknown> = { ...block };
    if (IMPORTED_TEMPLATE_FILE_BLOCK_TYPES.has(String(rawBlock.type ?? ''))) {
      next.content = comparableImportedTemplateFileBlockContent(block.content);
    }
    if (Array.isArray(block.children) || rawChildren.length > 0) {
      next.children = comparableImportedTemplateBlocks(block.children ?? [], rawChildren);
    }
    const content = importRecord(next.content);
    if (rawBlock.type === 'template' && content && Array.isArray(content.buttonTemplate)) {
      next.content = {
        ...content,
        buttonTemplate: comparableImportedTemplateBlocks(content.buttonTemplate, rawChildren),
      };
    }
    return next;
  });
}

function rawImportedTemplateProperties(template: Record<string, unknown>) {
  return importRecord(template.properties)
    ?? importRecord(template.default_properties)
    ?? importRecord(template.defaultProperties)
    ?? importRecord(importRecord(template.template)?.properties);
}

function rawImportedTemplateBlocks(template: Record<string, unknown>) {
  for (const candidate of [
    template.blocks,
    template.childBlocks,
    template.children,
    importRecord(template.template)?.blocks,
  ]) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is Record<string, unknown> => !!importRecord(item));
    }
  }
  return [];
}

function importedTemplateHasFileIcon(expected: DbTemplate) {
  return typeof expected.icon === 'string' && /^(?:https?:|data:)/i.test(expected.icon);
}

function comparableImportedTemplateStoredFileOwnerSnapshot(
  template: DbTemplate,
  expected: DbTemplate,
  rawTemplate: Record<string, unknown>,
  propertyMappings: Map<string, string>,
) {
  const properties = template.properties ? { ...template.properties } : undefined;
  const expectedProperties = expected.properties ?? {};
  for (const [nameOrId, rawValue] of Object.entries(rawImportedTemplateProperties(rawTemplate) ?? {})) {
    const rawProperty = importRecord(rawValue);
    if (rawProperty?.type !== 'files' || !Array.isArray(rawProperty.files)) continue;
    const notionPropertyId = typeof rawProperty.id === 'string' ? rawProperty.id : nameOrId;
    const localPropertyId = propertyMappings.get(notionPropertyId) ?? propertyMappings.get(nameOrId);
    if (!localPropertyId) continue;
    const expectedValue = expectedProperties[localPropertyId];
    if (!Array.isArray(expectedValue) || expectedValue.length === 0) continue;
    if (properties) {
      properties[localPropertyId] = { notionImportedFileSlotCount: expectedValue.length };
    }
  }
  return canonicalImportTemplateFingerprintValue({
    databaseId: template.databaseId,
    name: template.name,
    icon: importedTemplateHasFileIcon(expected) ? '__notion_imported_file__' : template.icon ?? null,
    title: template.title ?? null,
    properties: properties ?? null,
    blocks: comparableImportedTemplateBlocks(
      template.blocks ?? [],
      rawImportedTemplateBlocks(rawTemplate),
    ),
    isDefault: template.isDefault === true,
    position: template.position,
  });
}

function importedTemplateStoredFileOwnerMatchesImmutableSnapshot(
  candidate: DbTemplate,
  expected: DbTemplate,
  rawTemplate: Record<string, unknown>,
  propertyMappings: Map<string, string>,
) {
  return JSON.stringify(comparableImportedTemplateStoredFileOwnerSnapshot(
    candidate,
    expected,
    rawTemplate,
    propertyMappings,
  )) === JSON.stringify(comparableImportedTemplateStoredFileOwnerSnapshot(
    expected,
    expected,
    rawTemplate,
    propertyMappings,
  ));
}

function importedTemplateHasNoDurableProvenance(template: DbTemplate) {
  return !template.notionImportJobId
    && !template.notionTemplateId
    && !template.notionDataSourceId
    && template.notionTemplateStructuralIndex === undefined
    && !template.notionImportSnapshotRevision
    && !template.notionTemplateFingerprint;
}

function legacyNotionPropertyMappingCoordinates(
  notionId: unknown,
  knownDataSourceIds: Set<string>,
) {
  if (typeof notionId !== 'string' || !notionId.startsWith('notion-property:')) return undefined;
  const encoded = notionId.slice('notion-property:'.length);
  // The deterministic legacy key does not escape separators. Match against
  // graph ids (longest first) rather than splitting on `:`.
  const dataSourceId = [...knownDataSourceIds]
    .filter((candidate) => encoded.startsWith(`${candidate}:`))
    .sort((left, right) => right.length - left.length)[0];
  if (!dataSourceId) return undefined;
  const notionPropertyId = encoded.slice(dataSourceId.length + 1);
  return notionPropertyId ? { dataSourceId, notionPropertyId } : undefined;
}

function selectedImportedRootLocalPageId(
  job: Pick<NotionImportJob, 'rootNotionPageIds' | 'rootNotionDataSourceIds'>,
  mappings: NotionImportMapping[],
) {
  const localByNotionId = new Map(
    mappings
      .filter((mapping) => mapping.localType === 'page' || mapping.localType === 'database')
      .map((mapping) => [normalizedNotionId(mapping.notionId), mapping.localId] as const)
      .filter(([notionId, localId]) => !!notionId && typeof localId === 'string' && !!localId),
  );
  for (const notionId of [...(job.rootNotionPageIds ?? []), ...(job.rootNotionDataSourceIds ?? [])]) {
    const localId = localByNotionId.get(normalizedNotionId(notionId));
    if (localId) return localId;
  }
  return undefined;
}

function applySnapshotCacheKey(job: NotionImportJob) {
  const revision = typeof job.itemSnapshotRevision === 'string'
    ? job.itemSnapshotRevision.trim()
    : '';
  if (!revision) return undefined;
  return `${job.id}:${job.activeItemGeneration ?? 'legacy'}:${revision}`;
}

function cachedApplySnapshot(job: NotionImportJob) {
  const key = applySnapshotCacheKey(job);
  if (!key) return undefined;
  const cached = notionImportApplySnapshotCache.get(key);
  if (!cached) return undefined;
  // Refresh insertion order for the tiny LRU.
  notionImportApplySnapshotCache.delete(key);
  notionImportApplySnapshotCache.set(key, cached);
  return cached;
}

function rememberApplySnapshot(job: NotionImportJob, entry: NotionImportApplySnapshotCacheEntry) {
  const key = applySnapshotCacheKey(job);
  if (!key) return;
  notionImportApplySnapshotCache.delete(key);
  notionImportApplySnapshotCache.set(key, entry);
  while (notionImportApplySnapshotCache.size > NOTION_IMPORT_APPLY_SNAPSHOT_CACHE_LIMIT) {
    const oldest = notionImportApplySnapshotCache.keys().next().value as string | undefined;
    if (!oldest) break;
    notionImportApplySnapshotCache.delete(oldest);
  }
}

export function clearNotionImportApplySnapshotCache(jobId: string) {
  for (const key of notionImportApplySnapshotCache.keys()) {
    if (key.startsWith(`${jobId}:`)) notionImportApplySnapshotCache.delete(key);
  }
}

export function assertNotionImportApplyPreparationCursor(
  jobId: string,
  storedApplyPhase: string | undefined,
  snapshotComplete: boolean,
) {
  if (!snapshotComplete || storedApplyPhase !== 'apply_prepare') return;
  // A completed in-memory graph is published before the durable phase
  // transition. If that transition fails outside the HTTP wrapper, the next
  // core call must rebuild from the immutable item snapshot instead of
  // treating apply_prepare as an empty downstream phase and completing with
  // zero product mappings.
  clearNotionImportApplySnapshotCache(jobId);
  throw Object.assign(
    new Error('Notion import apply preparation did not durably advance; retry the immutable snapshot.'),
    { code: 409, notionImportRecoveryPending: true },
  );
}

export function applyRequestUsesBoundedPipeline(body: Record<string, unknown>) {
  return [
    body.applyPrepareBatchSize,
    body.applyDataSourceBatchSize,
    body.applyFileBatchSize,
    body.applyDatabaseBatchSize,
    body.applyPageBatchSize,
    body.applyRemapBatchSize,
    body.applyScrubBatchSize,
    body.applyFinalizeBatchSize,
  ].some((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
}

function applyItemProjectionQuery(db: DbRef, job: NotionImportJob) {
  const byJob = db.table<NotionImportItem>('notion_import_items').where('jobId', '==', job.id);
  const generation = job.activeItemGeneration ?? null;
  return generation !== null && typeof byJob.where === 'function'
    ? byJob.where('itemGeneration', '==', generation)
    : byJob;
}

export async function applyJobCoreWithRuntime(
  db: DbRef,
  admin: AdminDbAccessor,
  body: Record<string, unknown>,
  actorId: string,
  runtime: () => NotionImportApplyRuntime,
  storage?: FunctionStorageProxy,
  request?: Request,
  env?: Record<string, unknown>,
  applyLease?: { id: string; leaseId: string },
  createdUploadIds: string[] = [],
) {
  const {
    NOTION_API_VERSION,
    NOTION_BLOCK_CHILD_TOTAL_LIMIT,
    NOTION_IMPORT_PUBLICATION_BOUNDARY_VERSION,
    GENERATED_NOTION_TITLE_PROPERTY_ID,
    notionAppliedCountsFromMappings,
    withImportProgress,
    optionalString,
    parsePositiveInt,
    listAll,
    assertWritableJob,
    notionTokenForJob,
    cleanJob,
    assertSafeNotionImportSourceReferences,
    notionObjectId,
    itemMetadata,
    dataSourceSnapshot,
    viewSnapshot,
    notionPropertiesFromSnapshot,
    augmentNotionPropertiesFromRowSnapshots,
    withGeneratedTitleProperty,
    notionPropertyMappingId,
    asRecord,
    importedPageChromeFromItem,
    importedPageShouldUseFullWidth,
    pagePropertiesWithChromeReferences,
    initialImportedPageChrome,
    emptyConversionReport,
    incrementReport,
    pushReportIssue,
    reportUnsupportedProperty,
    reportUnsupportedView,
    parseOptionalBoolean,
    assertNotionFileCopyNotDisabled,
    dbPropertyFromNotion,
    setViewPropertyMapping,
    dbViewFromNotion,
    rawTemplatesFromSnapshot,
    rawTemplateBlocks,
    dbTemplateFromNotion,
    reportTemplateBlockRichTextUserReferences,
    compareNotionImportViewItems,
    localizedImportableNotionViews,
    inferCanonicalDataSourceForHiddenLinkedDatabase,
    meaningfulImportedTitle,
    hiddenLinkedDatabaseFallbackTitle,
    pushImportActivity,
    importActivityRingOf,
    listActiveNotionImportDiscoverySeeds,
    listActiveNotionImportItems,
    collectNotionImportFileCopySlots,
    notionImportFileSlotCoordinates,
    loadNotionImportFileCheckpoints,
    loadNotionImportFileCheckpointBySlotKey,
    cleanupUnownedNotionImportFileCheckpoints,
    copyNotionImportFileSlot,
    scrubAppliedImportCredentialMetadata,
    finalizeConversionReport,
    basePage,
    importedItemTimestamps,
    transactImportedOwnerPatch,
    preserveImportedPageTimestamps,
    loadMappings,
    buildImportedBlockOwnerContexts,
    resolveImportedPageParentFromNotionBlocks,
    moveImportedPageToResolvedParent,
    publishRecoveredImportedOwnerMapping,
    publishImportedDatabaseAliasMapping,
    insertImportedDatabaseChildWithMapping,
    claimRecoveredImportedDatabaseChild,
    insertImportedPageWithMapping,
    ensureImportRoot,
    stageIncompleteImportPages,
    unwrapImportRoot,
    rowDataSourceId,
    rowPropertiesForDataSource,
    copyImportedRowFileProperties,
    importedRowFilePropertiesNeedCopy,
    copyImportedPageChromeFiles,
    existingImportedTemplateFileState,
    copyImportedTemplateFiles,
    insertImportedTemplateWithFiles,
    updateImportedTemplateWithFiles,
    remapImportedDatabaseProperties,
    remapImportedTemplateBlocksRichTextMentions,
    reportRichTextMentionRemap,
    remapImportedPageBlockRichTextMentions,
    remapImportedPageLinkBlocks,
    remapImportedSyncedBlocks,
    remapImportedRowRelationProperties,
    remapImportedTemplateRelationProperties,
    remapImportedDatabaseViewRelationFilters,
    addImportedLinkedDatabaseRowContextFilters,
    remapImportedTemplateLinkedDatabaseBlocks,
    insertPageBlocksFromSnapshot,
    inspectDiscoveryCompletenessForReport,
    itemHasImportablePageBody,
    replayImportedPageBlockMetrics,
    importedBlocksComplete,
    markImportedBlocksComplete,
    replaceImportedBlocksForPage,
    ensureImportedPageWorkspaceIndexes,
    renewNotionApplyLease,
    updateNotionJobIfStatus,
  } = runtime();

  const jobId = requireString(body.jobId, 'jobId');
  const jobs = db.table<NotionImportJob>('notion_import_jobs');
  const job = await getExisting(jobs, jobId);
  if (!job) throw new Error('Notion import job was not found.');
  await assertWritableJob(db, job, actorId);
  const compact = body.compact === true;
  const locale = parsePersistentGeneratedLocale(asRecord(job.options)?.locale);
  const generatedLabels = persistentGeneratedLabels(locale);
  if (job.status === 'completed') {
    const importedRootPageId = optionalString(asRecord(job.report)?.importedRootPageId);
    if (compact) {
      return {
        job: cleanJob(job),
        applied: (job.progress as { applied?: Record<string, number> } | undefined)?.applied ?? {},
        ...(importedRootPageId ? { importedRootPageId } : {}),
      };
    }
    const existingMappings = await loadMappings(db, job.id);
    const mappings = Array.from(existingMappings.values());
    await ensureImportedPageWorkspaceIndexes(admin, mappings, job.workspaceId);
    return {
      job: cleanJob(job),
      applied: (job.progress as { applied?: Record<string, number> } | undefined)?.applied ?? {},
      importedRootPageId: importedRootPageId ?? selectedImportedRootLocalPageId(job, mappings),
      ...(compact ? {} : { mappings }),
    };
  }
  if (job.status !== 'ready') {
    throw new Error('Notion import job must be ready before apply.');
  }

  // Legacy/pre-revision ready jobs get one immutable apply revision before the
  // first write. Discovery and snapshot append publish a new revision, while
  // append is rejected once applyCursor exists, so a cache hit always names
  // the exact graph this resumable apply started from.
  let currentJob = job;
  if (!applySnapshotCacheKey(currentJob)) {
    const revisioned = await updateNotionJobIfStatus(db, job.id, 'ready', {
      itemSnapshotRevision: newId(),
    });
    if (!revisioned) throw new Error('Notion import job state changed before apply started.');
    currentJob = revisioned;
  }

  const rawStoredApplyCursor =
    asRecord(asRecord(currentJob.progress)?.applyCursor) ??
    asRecord(asRecord(currentJob.report)?.applyCursor);
  const storedApplyCursor = rawStoredApplyCursor
    ? normalizeNotionImportApplyCursorOrder(rawStoredApplyCursor)
    : undefined;
  const storedApplyPhase = optionalString(storedApplyCursor?.phase);
  // A cache miss can interrupt the dedicated file-copy phase itself. Keep the
  // file cursor as a sibling of the preparation resume cursor: nesting it in
  // `resumeCursor` would turn apply_file_copies into its own downstream phase
  // and reset fileIndex every time the immutable snapshot cache is rebuilt.
  const storedPreparationFileCursor = storedApplyPhase === 'apply_file_copies'
    ? storedApplyCursor
    : storedApplyPhase === 'apply_prepare'
      ? asRecord(storedApplyCursor?.resumeFileCursor)
      : undefined;
  const storedPreparationResumeCursor = storedApplyPhase === 'apply_prepare'
    ? asRecord(storedApplyCursor?.resumeCursor)
    : storedApplyPhase === 'apply_file_copies'
      ? asRecord(storedApplyCursor?.resumeCursor)
      : storedApplyCursor;
  const preparationResumeCursor = optionalString(storedPreparationResumeCursor?.phase) === 'apply_prepare'
    ? undefined
    : storedPreparationResumeCursor;

  let applySnapshot = cachedApplySnapshot(currentJob);
  const usesIncrementalPreparation =
    supportsFieldProjection(applyItemProjectionQuery(db, currentJob)) &&
    (
      applyRequestUsesBoundedPipeline(body)
      || storedApplyPhase === 'apply_prepare'
      || storedApplyPhase === 'apply_file_copies'
    );
  assertNotionImportApplyPreparationCursor(
    job.id,
    storedApplyPhase,
    applySnapshot?.complete === true,
  );
  if (!applySnapshot && usesIncrementalPreparation) {
    const seeds = (await listActiveNotionImportDiscoverySeeds(db, currentJob))
      .sort(compareStableImportItems);
    if (seeds.length === 0) {
      throw new Error(
        'Notion import found no items. Share pages with the integration, or wait a ' +
          'few minutes if the Notion API rate-limited discovery, then run discovery again.',
      );
    }
    applySnapshot = {
      items: [],
      mappingsByNotionId: new Map(),
      blockOwnerContextsByNotionId: new Map(),
      importedBlockMappingsByNotionId: new Map(),
      complete: false,
      preparation: { seeds },
    };
    rememberApplySnapshot(currentJob, applySnapshot);
  }

  if (applySnapshot && !applySnapshot.complete) {
    const preparation = applySnapshot.preparation;
    if (!preparation) {
      clearNotionImportApplySnapshotCache(job.id);
      throw new Error('Notion import apply preparation state is incomplete.');
    }
    const preparedBefore = applySnapshot.items.length;
    const prepareBatchSize = parsePositiveInt(
      body.applyPrepareBatchSize,
      NOTION_IMPORT_APPLY_PREPARE_BATCH_SIZE,
      NOTION_IMPORT_APPLY_PREPARE_BATCH_SIZE_MAX,
    );
    const itemTable = db.table<NotionImportItem>('notion_import_items');
    const hydrationSeeds = preparation.seeds.slice(
      preparedBefore,
      preparedBefore + prepareBatchSize,
    );
    const hydrationIds = hydrationSeeds.map((seed) => seed.id);
    const requestedIds = new Set(hydrationIds);
    if (requestedIds.size !== hydrationIds.length) {
      throw new Error('Notion import apply preparation contained duplicate item ids.');
    }
    const hydratedRows = await listAllComplete(
      itemTable.where('id', 'in', hydrationIds),
      {
        maxItems: hydrationIds.length,
        pageSize: hydrationIds.length,
        label: 'Notion import apply preparation',
      },
    );
    const hydratedById = new Map<string, NotionImportItem>();
    for (const item of hydratedRows) {
      if (!requestedIds.has(item.id) || hydratedById.has(item.id)) {
        throw new Error('Notion import apply preparation returned an unexpected item.');
      }
      hydratedById.set(item.id, item);
    }
    const hydrated: NotionImportItem[] = [];
    for (const seed of hydrationSeeds) {
      const item = hydratedById.get(seed.id);
      if (
        !item ||
        item.jobId !== currentJob.id ||
        (item.itemGeneration ?? null) !== (currentJob.activeItemGeneration ?? null)
      ) {
        throw new Error('Notion import item snapshot changed while apply was preparing.');
      }
      hydrated.push(item);
    }
    if (hydrated.length === 0) {
      throw new Error('Notion import apply preparation made no progress.');
    }
    if (applyLease) await renewNotionApplyLease(db, applyLease);
    await assertSafeNotionImportSourceReferences(
      db,
      hydrated.map((item) => item.metadata),
    );
    applySnapshot.items.push(...hydrated);
    for (const [notionId, context] of buildImportedBlockOwnerContexts(hydrated)) {
      if (!applySnapshot.blockOwnerContextsByNotionId.has(notionId)) {
        applySnapshot.blockOwnerContextsByNotionId.set(notionId, context);
      }
    }

    const preparedItems = applySnapshot.items.length;
    const preparationFinished = preparedItems >= preparation.seeds.length;
    if (preparationFinished) {
      applySnapshot.items.sort(compareStableImportItems);
      applySnapshot.mappingsByNotionId = await loadMappings(db, job.id);
      applySnapshot.complete = true;
      delete applySnapshot.preparation;
    }
    rememberApplySnapshot(currentJob, applySnapshot);

    const preparedResumeCursor = preparationResumeCursor ?? {
      phase: 'apply_data_sources',
      dataSourceIndex: 0,
      totalDataSources: preparation.seeds.filter((item) => item.notionObject === 'data_source').length,
    };
    const rawNextCursor = preparationFinished
      ? storedPreparationFileCursor ?? {
            phase: 'apply_file_copies',
            fileIndex: 0,
            itemSnapshotRevision: currentJob.itemSnapshotRevision,
            resumeCursor: preparedResumeCursor,
            paused: true,
          }
      : {
          phase: 'apply_prepare',
          itemIndex: preparedItems,
          totalItems: preparation.seeds.length,
          itemBatchSize: prepareBatchSize,
          itemSnapshotRevision: currentJob.itemSnapshotRevision,
          ...(preparationResumeCursor ? { resumeCursor: preparationResumeCursor } : {}),
          ...(storedPreparationFileCursor ? { resumeFileCursor: storedPreparationFileCursor } : {}),
          paused: true,
        };
    const nextCursor = normalizeNotionImportApplyCursorOrder({
      ...rawNextCursor,
      orderVersion: NOTION_IMPORT_APPLY_ORDER_VERSION,
    });
    const nextPhase = optionalString(nextCursor.phase) ?? 'apply_prepare';
    const partialApplied =
      asRecord(asRecord(currentJob.progress)?.partialApplied) ??
      asRecord(asRecord(currentJob.report)?.partialApplied) ??
      {};
    const nextJob = await updateNotionJobIfStatus(db, job.id, 'ready', {
      phase: nextPhase,
      error: null,
      finishedAt: null,
      progress: {
        ...withImportProgress(currentJob.progress, {
          key: 'apply',
          status: 'running',
          legacyStep: nextPhase,
          percent: preparationFinished ? 56 : 55,
          counts: partialApplied,
        }),
        applyCursor: nextCursor,
        partialApplied,
      },
      report: {
        ...(currentJob.report ?? {}),
        applyCursor: nextCursor,
        partialApplied,
      },
    }, {
      extraExpectations: [
        {
          table: 'notion_import_jobs',
          op: 'expect',
          id: job.id,
          where: [
            ['status', '==', 'ready'],
            ['itemSnapshotRevision', '==', currentJob.itemSnapshotRevision],
          ],
          exists: true,
        },
        ...(applyLease ? [{
            table: 'notion_import_apply_locks',
            op: 'expect' as const,
            id: applyLease.id,
            where: [
              ['leaseId', '==', applyLease.leaseId],
              ['purpose', '==', 'apply'],
            ] as Array<[string, '==', unknown]>,
            exists: true,
          }] : []),
      ],
    });
    if (!nextJob) {
      const latest = await getExisting(jobs, job.id);
      if (latest?.status === 'cancelled') throw new Error('Notion import job is cancelled.');
      throw new Error('Notion import job state changed while apply was preparing.');
    }
    currentJob = nextJob;
    return {
      job: cleanJob(currentJob),
      applied: partialApplied,
      partial: true as const,
    };
  }

  if (!applySnapshot) {
    const items = await listActiveNotionImportItems(db, currentJob);
    if (items.length === 0) {
      // A discovery that legitimately found nothing (nothing shared with the
      // integration, or the Notion search was rate-limited into an empty result)
      // is a user-actionable state, not a server fault — surface a clean 422.
      throw new Error(
        'Notion import found no items. Share pages with the integration, or wait a ' +
          'few minutes if the Notion API rate-limited discovery, then run discovery again.',
      );
    }
    // Re-check the immutable snapshot once per worker/revision, not once per
    // 5/20-item chunk. Discovery already guards every staged delta; this is the
    // defense-in-depth check for legacy or externally-corrupted rows.
    await assertSafeNotionImportSourceReferences(
      db,
      items.map((item) => item.metadata),
    );
    applySnapshot = {
      items,
      mappingsByNotionId: await loadMappings(db, job.id),
      blockOwnerContextsByNotionId: buildImportedBlockOwnerContexts(items),
      importedBlockMappingsByNotionId: new Map(),
      complete: true,
    };
    rememberApplySnapshot(currentJob, applySnapshot);
  }
  const items = applySnapshot.items;
  // Every numeric cursor below indexes this immutable ordering. SQL pagination
  // order is not a contract, so a worker/cache rebuild must sort explicitly or
  // it can skip one item and process another twice.
  const stableItems = [...items].sort(compareStableImportItems);
  const existingMappings = applySnapshot.mappingsByNotionId;
  const itemsByNotionId = new Map(items.map((item) => [item.notionId, item]));
  const blockOwnerContextsByNotionId = applySnapshot.blockOwnerContextsByNotionId;

  const applyPageBatchSize = parsePositiveInt(body.applyPageBatchSize, 0, 500);
  const applyDatabaseBatchSize = parsePositiveInt(
    body.applyDatabaseBatchSize,
    // Preserve the public API's legacy one-shot behavior when callers do not
    // opt into batching. Product callers pass an explicit database batch.
    applyPageBatchSize > 0 ? applyPageBatchSize : 0,
    500,
  );
  const boundedDataSourcesRequested =
    applyPageBatchSize > 0 ||
    typeof body.applyDataSourceBatchSize === 'number' ||
    typeof body.applyRemapBatchSize === 'number';
  const applyDataSourceBatchSize = parsePositiveInt(
    body.applyDataSourceBatchSize,
    boundedDataSourcesRequested ? Math.min(5, applyDatabaseBatchSize || 5) : 0,
    50,
  );
  const applyRemapBatchSize = parsePositiveInt(
    body.applyRemapBatchSize,
    applyPageBatchSize > 0 ? Math.min(20, applyPageBatchSize) : 0,
    100,
  );
  const applyScrubBatchSize = parsePositiveInt(
    body.applyScrubBatchSize,
    applyPageBatchSize > 0 ? 20 : 0,
    100,
  );
  const applyFinalizeBatchSize = parsePositiveInt(
    body.applyFinalizeBatchSize,
    applyPageBatchSize > 0 ? 25 : 0,
    100,
  );
  const boundedPagePipelineRequested =
    applyDataSourceBatchSize > 0 || applyPageBatchSize > 0 || applyRemapBatchSize > 0;
  const rawExistingApplyCursor =
    asRecord(asRecord(currentJob.progress)?.applyCursor) ??
    asRecord(asRecord(currentJob.report)?.applyCursor);
  const existingApplyCursor = rawExistingApplyCursor
    ? normalizeNotionImportApplyCursorOrder(rawExistingApplyCursor)
    : undefined;
  const rawStoredApplyPhase = optionalString(existingApplyCursor?.phase);
  const existingFileCopyCursor = rawStoredApplyPhase === 'apply_file_copies'
    ? existingApplyCursor
    : undefined;
  let logicalApplyCursor = existingFileCopyCursor
    ? asRecord(existingFileCopyCursor.resumeCursor)
    : existingApplyCursor;
  // Repair the short-lived local development shape that could nest the file
  // phase into itself after a cache miss. The outer cursor owns fileIndex;
  // only the innermost non-file cursor is the product-write resume point.
  for (let depth = 0; depth < 4 && optionalString(logicalApplyCursor?.phase) === 'apply_file_copies'; depth += 1) {
    logicalApplyCursor = asRecord(logicalApplyCursor?.resumeCursor);
  }
  const rawExistingApplyPhase = optionalString(logicalApplyCursor?.phase);
  // `apply_block_map` existed briefly as an in-memory-cache-dependent phase.
  // Resume such a local/dev job safely at remap; synced sources are now
  // resolved from the durable owner page for each bounded remap window.
  const existingApplyPhase = rawExistingApplyPhase === 'apply_block_map'
    ? 'apply_remap'
    : rawExistingApplyPhase;
  const resumeDataSourceIndex = existingApplyPhase === 'apply_data_sources' &&
    typeof logicalApplyCursor?.dataSourceIndex === 'number' &&
    Number.isFinite(logicalApplyCursor.dataSourceIndex)
    ? Math.max(0, Math.floor(logicalApplyCursor.dataSourceIndex))
    : 0;
  const resumePageIndex = existingApplyPhase === 'apply_pages' &&
    typeof logicalApplyCursor?.pageIndex === 'number' &&
    Number.isFinite(logicalApplyCursor.pageIndex)
    ? Math.max(0, Math.floor(logicalApplyCursor.pageIndex))
    : 0;
  const resumeRemapIndex = existingApplyPhase === 'apply_remap' && rawExistingApplyPhase !== 'apply_block_map' &&
    typeof logicalApplyCursor?.remapIndex === 'number' &&
    Number.isFinite(logicalApplyCursor.remapIndex)
    ? Math.max(0, Math.floor(logicalApplyCursor.remapIndex))
    : 0;
  const resumeGlobalDataSourceIndex = existingApplyPhase === 'apply_global_remap' &&
    typeof logicalApplyCursor?.dataSourceIndex === 'number' &&
    Number.isFinite(logicalApplyCursor.dataSourceIndex)
    ? Math.max(0, Math.floor(logicalApplyCursor.dataSourceIndex))
    : 0;
  const resumeScrubIndex = existingApplyPhase === 'apply_scrub' &&
    typeof logicalApplyCursor?.itemIndex === 'number' &&
    Number.isFinite(logicalApplyCursor.itemIndex)
    ? Math.max(0, Math.floor(logicalApplyCursor.itemIndex))
    : 0;
  const resumeFinalizeMappingIndex = existingApplyPhase === 'apply_finalize_indexes' &&
    typeof logicalApplyCursor?.mappingIndex === 'number' &&
    Number.isFinite(logicalApplyCursor.mappingIndex)
    ? Math.max(0, Math.floor(logicalApplyCursor.mappingIndex))
    : 0;
  const shouldChunkDatabaseContainers =
    !existingApplyPhase ||
    existingApplyPhase === 'apply_data_sources' ||
    existingApplyPhase === 'apply_database_containers';
  const resumeDatabasePass = existingApplyPhase === 'apply_database_containers'
    ? optionalString(logicalApplyCursor?.databasePass)
    : undefined;
  const resumeDatabaseIndex = existingApplyPhase === 'apply_database_containers' &&
    typeof logicalApplyCursor?.databaseIndex === 'number' &&
    Number.isFinite(logicalApplyCursor.databaseIndex)
    ? Math.max(0, Math.floor(logicalApplyCursor.databaseIndex))
    : 0;
  const mappingsByNotionId = existingMappings;
  if (
    asRecord(currentJob.report)?.importPublicationBoundaryVersion
    !== NOTION_IMPORT_PUBLICATION_BOUNDARY_VERSION
    && existingApplyPhase !== 'apply_finalize'
  ) {
    const publicationBoundary = await stageIncompleteImportPages(
      db,
      currentJob,
      mappingsByNotionId,
      applyLease,
    );
    if (publicationBoundary.complete) {
      const publicationBoundaryJob = await updateNotionJobIfStatus(db, job.id, 'ready', {
        report: {
          ...(currentJob.report ?? {}),
          importPublicationBoundaryVersion: NOTION_IMPORT_PUBLICATION_BOUNDARY_VERSION,
        },
      }, {
        extraExpectations: applyLease ? [{
          table: 'notion_import_apply_locks',
          op: 'expect',
          id: applyLease.id,
          where: [
            ['leaseId', '==', applyLease.leaseId],
            ['purpose', '==', 'apply'],
          ],
          exists: true,
        }] : [],
      });
      if (!publicationBoundaryJob) {
        throw Object.assign(
          new Error('Notion import publication boundary changed concurrently.'),
          { code: 409, notionImportRecoveryPending: true },
        );
      }
      currentJob = publicationBoundaryJob;
    }
  }
  const stableMappings = () => Array.from(mappingsByNotionId.values()).sort(compareStableMappings);
  const dataSourceItems = stableItems.filter((item) => item.notionObject === 'data_source');
  const dataSourceIds = new Set(dataSourceItems.map((item) => item.notionId));
  // Notion exposes database templates as page objects too. Discovery can
  // therefore retain the same source id both as a standalone page seed and
  // inside its data-source template snapshot. The template phase is the
  // canonical owner: it creates a db_template mapping and preserves template
  // properties/blocks/files. Feeding that duplicate page seed through the
  // ordinary page pass would incorrectly reject the valid db_template mapping
  // as an incompatible page owner (or, without that guard, duplicate it as a
  // row/page). Build the exclusion from the immutable source snapshot rather
  // than from mutable mappings so first apply, cache loss, and resume choose
  // the same owner class.
  const templatePageNotionIds = new Set(
    dataSourceItems.flatMap((item) => (
      rawTemplatesFromSnapshot(dataSourceSnapshot(item))
        .map((template) => normalizedNotionId(notionObjectId(template)))
        .filter((notionId): notionId is string => !!notionId)
    )),
  );
  const pageItems = stableItems.filter((item) => (
    item.notionObject === 'page'
    && !templatePageNotionIds.has(normalizedNotionId(item.notionId))
  ));
  const applyingPageWindowEnd = applyPageBatchSize > 0
    ? Math.min(pageItems.length, resumePageIndex + applyPageBatchSize)
    : pageItems.length;
  const remapWindowEnd = applyRemapBatchSize > 0
    ? Math.min(pageItems.length, resumeRemapIndex + applyRemapBatchSize)
    : pageItems.length;
  const activePageWindow = [
    'apply_global_remap',
    'apply_scrub',
    'apply_finalize_indexes',
    'apply_finalize',
  ].includes(existingApplyPhase ?? '')
    ? []
    : existingApplyPhase === 'apply_remap'
      ? pageItems.slice(resumeRemapIndex, remapWindowEnd)
      : pageItems.slice(resumePageIndex, applyingPageWindowEnd);
  const activeDataSourceIds = new Set(
    activePageWindow
      .map((item) => rowDataSourceId(item, dataSourceIds))
      .filter((id): id is string => !!id),
  );
  const dataSourceItemsForRun = !existingApplyPhase || existingApplyPhase === 'apply_data_sources'
    ? dataSourceItems.slice(
        resumeDataSourceIndex,
        applyDataSourceBatchSize > 0
          ? Math.min(dataSourceItems.length, resumeDataSourceIndex + applyDataSourceBatchSize)
          : dataSourceItems.length,
      )
    : existingApplyPhase === 'apply_global_remap'
      ? dataSourceItems.slice(
          resumeGlobalDataSourceIndex,
          applyDataSourceBatchSize > 0
            ? Math.min(dataSourceItems.length, resumeGlobalDataSourceIndex + applyDataSourceBatchSize)
          : dataSourceItems.length,
        )
      : existingApplyPhase === 'apply_database_containers' && applyDataSourceBatchSize === 0
        // Legacy callers that only chunk database containers rely on this
        // resume pass to validate/repair an interrupted template file graph.
        // Product callers use explicit data-source batching and do not repeat
        // the full source graph here.
        ? dataSourceItems
      : existingApplyPhase === 'apply_pages' || existingApplyPhase === 'apply_remap'
        ? dataSourceItems.filter((item) => activeDataSourceIds.has(item.notionId))
        : [];
  const propertyMappingsByDataSource = new Map<string, Map<string, string>>();
  // Rollups may target a property owned by a data source outside the current
  // five-source batch. Reconstruct the compact cross-source property map from
  // durable mapping metadata before hydrating any heavy data-source snapshot.
  for (const mapping of stableMappings()) {
    if (mapping.localType !== 'db_property') continue;
    const metadata = asRecord(mapping.metadata);
    const legacyCoordinates = legacyNotionPropertyMappingCoordinates(mapping.notionId, dataSourceIds);
    const dataSourceId = optionalString(metadata?.dataSourceId) ?? legacyCoordinates?.dataSourceId;
    if (!dataSourceId) continue;
    const propMap = propertyMappingsByDataSource.get(dataSourceId) ?? new Map<string, string>();
    propertyMappingsByDataSource.set(dataSourceId, propMap);
    const notionPropertyId = optionalString(metadata?.notionPropertyId) ?? legacyCoordinates?.notionPropertyId;
    const propertyName = optionalString(metadata?.name);
    if (notionPropertyId) setViewPropertyMapping(propMap, notionPropertyId, mapping.localId);
    if (propertyName) setViewPropertyMapping(propMap, propertyName, mapping.localId);
  }
  const propertyRecordsByDataSource = new Map<string, DbProperty[]>();
  const importedPropertyContexts: ImportedPropertyContext[] = [];
  const importedRowContexts: ImportedRowContext[] = [];
  const importedPageBlockContexts: ImportedPageBlockContext[] = [];
  const importedTemplateContexts: ImportedTemplateContext[] = [];
  const importedBlockMappingsByNotionId = applySnapshot.importedBlockMappingsByNotionId;
  const conversionReport = emptyConversionReport();
  const previousPartialConversion = asRecord(asRecord(currentJob.report)?.partialConversion);
  if (!previousPartialConversion) inspectDiscoveryCompletenessForReport(conversionReport, job, items);
  const cumulativeConversionReport = emptyConversionReport();
  const previousSummary = asRecord(previousPartialConversion?.summary);
  for (const [key, value] of Object.entries(previousSummary ?? {})) {
    if (
      typeof value === 'number' && Number.isFinite(value) &&
      !CONVERSION_ISSUE_KEY_SET.has(key)
    ) {
      cumulativeConversionReport.summary[key] = value;
    }
  }
  const mergeConversionIssues = <T>(target: T[], source: unknown) => {
    const seen = new Set(target.map((entry) => JSON.stringify(entry)));
    for (const entry of Array.isArray(source) ? source : []) {
      if (!entry || typeof entry !== 'object') continue;
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      target.push(entry as T);
      if (target.length >= 200) break;
    }
  };
  for (const key of CONVERSION_ISSUE_KEYS) {
    mergeConversionIssues(cumulativeConversionReport[key], previousPartialConversion?.[key]);
  }
  let conversionSummaryCheckpoint: Record<string, number> = {};
  const durableConversionReport = () => {
    for (const [key, value] of Object.entries(conversionReport.summary)) {
      if (CONVERSION_ISSUE_KEY_SET.has(key)) continue;
      const previous = conversionSummaryCheckpoint[key] ?? 0;
      const delta = value - previous;
      if (delta > 0) {
        cumulativeConversionReport.summary[key] = (cumulativeConversionReport.summary[key] ?? 0) + delta;
      }
    }
    conversionSummaryCheckpoint = { ...conversionReport.summary };
    for (const key of CONVERSION_ISSUE_KEYS) {
      mergeConversionIssues(cumulativeConversionReport[key], conversionReport[key]);
    }
    return finalizeConversionReport(cumulativeConversionReport);
  };
  assertNotionFileCopyNotDisabled(body);
  const storedImportPagesFullWidth = parseOptionalBoolean(asRecord(job.options)?.importPagesFullWidth);
  const importPagesFullWidth = parseOptionalBoolean(body.importPagesFullWidth) ?? storedImportPagesFullWidth;
  let tokenSource: Awaited<ReturnType<typeof notionTokenForJob>> | undefined;
  try {
    tokenSource = await notionTokenForJob(db, body, job, actorId, env);
  } catch (error) {
    // Snapshot-only imports historically apply without a Notion credential.
    // A job tied to a stored connection is different: every bounded apply
    // chunk must freshly validate/decrypt that connection so revocation cannot
    // be silently downgraded to a file-copy omission.
    if (job.connectionId || optionalString(body.connectionId)) throw error;
  }
  const durableApplied = notionAppliedCountsFromMappings(Array.from(existingMappings.values()));
  const previousPartialApplied =
    asRecord(asRecord(job.progress)?.partialApplied) ??
    asRecord(asRecord(job.report)?.partialApplied);
  const previousAppliedCount = (key: string) => {
    const value = previousPartialApplied?.[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0;
  };
  const created = {
    pages: durableApplied.pages,
    databases: durableApplied.databases,
    blocks: previousAppliedCount('blocks'),
    properties: Math.max(durableApplied.properties, previousAppliedCount('properties')),
    views: Math.max(durableApplied.views, previousAppliedCount('views')),
    templates: Math.max(durableApplied.templates, previousAppliedCount('templates')),
    rows: durableApplied.rows,
    mappings: durableApplied.mappings,
    remappedProperties: previousAppliedCount('remappedProperties'),
    remappedViewRelationFilters: previousAppliedCount('remappedViewRelationFilters'),
    remappedLinkedDatabaseContextFilters: previousAppliedCount('remappedLinkedDatabaseContextFilters'),
    remappedRowRelations: previousAppliedCount('remappedRowRelations'),
    remappedTemplateRelations: previousAppliedCount('remappedTemplateRelations'),
    remappedLinkBlocks: previousAppliedCount('remappedLinkBlocks'),
    unresolvedImportReferences: previousAppliedCount('unresolvedImportReferences'),
    fileCopies: previousAppliedCount('fileCopies'),
    fileCopySkipped: previousAppliedCount('fileCopySkipped'),
    repairedPageParents: previousAppliedCount('repairedPageParents'),
  };
  const checkpointUploadsBySlotKey = applySnapshot.fileCheckpointUploadsBySlotKey ?? new Map();
  if (!applySnapshot.fileCheckpointUploadsBySlotKey) {
    applySnapshot.fileCheckpointUploadsBySlotKey = checkpointUploadsBySlotKey;
  }
  const fileCopyContext: NotionFileCopyContext = {
    db,
    admin,
    job: currentJob,
    actorId,
    storage,
    request,
    conversionReport,
    requireStoredFileCopies: true,
    notionToken: tokenSource?.token,
    apiVersion: job.apiVersion || NOTION_API_VERSION,
    apiBase: notionApiBase(env),
    stats: created,
    createdUploadIds,
    itemSnapshotRevision: currentJob.itemSnapshotRevision ?? undefined,
    checkpointUploadsBySlotKey,
    checkpointSlotKeysByCoordinates: applySnapshot.fileSlotKeysByCoordinates,
    applyLease,
    verifiedCheckpointUploadIds: new Set(),
    pendingCheckpointTargets: new Map(),
  };
  // Apply owns the 55→99% band; pages/rows dominate the work, so their loop
  // index drives most of it. Container phases get fixed early marks.
  const applyPercent = (phase: string, cursor: Record<string, unknown>) => {
    if (phase === 'apply_file_copies') {
      const index = typeof cursor.fileIndex === 'number' ? cursor.fileIndex : 0;
      const total = typeof cursor.totalFiles === 'number' && cursor.totalFiles > 0 ? cursor.totalFiles : 0;
      return total ? Math.min(57, 56 + Math.round(index / total)) : 56;
    }
    if (phase === 'apply_data_sources') return 56;
    if (phase === 'apply_database_containers') return 58;
    if (phase === 'apply_pages') {
      const index = typeof cursor.pageIndex === 'number' ? cursor.pageIndex : 0;
      const total = typeof cursor.totalPages === 'number' && cursor.totalPages > 0 ? cursor.totalPages : 0;
      if (!total) return 60;
      return Math.min(96, 60 + Math.round((index / total) * 36));
    }
    if (phase === 'apply_remap') return 98;
    if (phase === 'apply_global_remap') return 99;
    if (phase === 'apply_scrub' || phase === 'apply_finalize_indexes' || phase === 'apply_finalize') return 99;
    return 75;
  };
  const applyActivityRing = importActivityRingOf(currentJob.progress as Record<string, unknown> | undefined);
  let lastApplyProgressWriteMs = 0;
  const updateApplyProgress = async (
    phase: string,
    cursor: Record<string, unknown> = {},
    activity?: { kind: string; title?: string; count?: number; total?: number },
    options: {
      exactApplyCursor?: Record<string, unknown>;
      reportPatch?: Record<string, unknown>;
    } = {},
  ) => {
    if (applyLease) await renewNotionApplyLease(db, applyLease);
    const rawApplyCursor = options.exactApplyCursor ?? { phase, ...cursor };
    const applyCursor = normalizeNotionImportApplyCursorOrder({
      ...rawApplyCursor,
      orderVersion: NOTION_IMPORT_APPLY_ORDER_VERSION,
    });
    if (activity) pushImportActivity(applyActivityRing, activity);
    const nextJob = await updateNotionJobIfStatus(db, job.id, 'ready', {
      phase,
      connectionId: tokenSource?.connectionId ?? currentJob.connectionId,
      connectionKind: tokenSource?.connection?.connectionKind ?? currentJob.connectionKind,
      error: null,
      finishedAt: null,
      progress: {
        ...withImportProgress(currentJob.progress, {
          key: 'apply',
          status: 'running',
          legacyStep: phase,
          percent: applyPercent(phase, cursor),
          counts: created,
        }),
        applyCursor,
        partialApplied: created,
        recent: applyActivityRing.slice(),
      },
      report: {
        ...(currentJob.report ?? {}),
        applyCursor,
        partialApplied: created,
        partialConversion: durableConversionReport(),
        ...(options.reportPatch ?? {}),
      },
      options: importPagesFullWidth !== undefined
        ? {
            ...(currentJob.options ?? {}),
            importPagesFullWidth,
          }
        : currentJob.options,
    }, {
      extraExpectations: [
        {
          table: 'notion_import_jobs',
          op: 'expect',
          id: job.id,
          where: [
            ['status', '==', 'ready'],
            ['itemSnapshotRevision', '==', fileCopyContext.itemSnapshotRevision],
          ],
          exists: true,
        },
        ...(applyLease ? [{
          table: 'notion_import_apply_locks',
          op: 'expect' as const,
          id: applyLease.id,
          where: [
            ['leaseId', '==', applyLease.leaseId],
            ['purpose', '==', 'apply'],
          ] as Array<[string, '==', unknown]>,
          exists: true,
        }] : []),
      ],
    });
    if (!nextJob) {
      const latest = await getExisting(jobs, job.id);
      if (latest?.status === 'cancelled') {
        throw new Error('Notion import job is cancelled.');
      }
      throw new Error('Notion import job state changed while apply was running.');
    }
    currentJob = nextJob;
  };

  fileCopyContext.onRequiredCheckpointUnavailable = async (slotKey, target, reason) => {
    const revision = optionalString(currentJob.itemSnapshotRevision);
    if (!revision) {
      throw Object.assign(new Error('Notion import file checkpoint revision was missing.'), { code: 409 });
    }
    const resumeCursor = logicalApplyCursor ?? {
      phase: 'apply_data_sources',
      dataSourceIndex: 0,
      totalDataSources: dataSourceItems.length,
    };
    // Re-enter the bounded pre-copy phase at its lower bound. Existing slots
    // are reused through their durable slot keys; only the missing/nonuploaded
    // checkpoint is recovered or copied. Clearing the completion marker makes
    // the phase transition explicit across cache loss and process restart.
    await updateApplyProgress('apply_file_copies', {
      fileIndex: 0,
      itemSnapshotRevision: revision,
      resumeCursor,
      invalidatedSlotKey: slotKey,
      invalidatedSlotReason: reason,
      invalidatedSlotRole: target.notionFileRole ?? 'unknown',
      invalidatedSlotPath: target.notionFileStructuralPath ?? 'unknown',
      paused: true,
    }, undefined, {
      reportPatch: { fileCopyCheckpointRevision: null },
    });
    throw Object.assign(
      new Error(
        `Notion import file checkpoint was ${reason === 'missing' ? 'missing' : 'not uploaded'}; ` +
        'the job was returned to the bounded file-copy phase.',
      ),
      { code: 503, notionImportRecoveryPending: true },
    );
  };

  const partialApplyResult = () => ({
    job: cleanJob(currentJob),
    applied: created,
    // The product runner only needs durable job progress between chunks.
    // Preserve the old mapping payload for explicit non-compact final calls,
    // but never serialize a growing graph into a partial response.
    partial: true as const,
  });

  const publishCompletedApply = async () => {
    // Completion is the last lease-fenced opportunity to prove every durable
    // revision checkpoint was consumed by an exact product owner. Safely
    // retire any legacy-resume surplus before publishing a completed job.
    await cleanupUnownedNotionImportFileCheckpoints(fileCopyContext);
    const importedRootPageId = selectedImportedRootLocalPageId(job, stableMappings());
    await unwrapImportRoot(db, admin, currentJob, mappingsByNotionId, applyLease);
    // unwrapImportRoot removes the synthetic staging-root mapping from the
    // durable map. Build the compatibility payload afterwards so non-compact
    // callers never observe a mapping that has already been deleted.
    const allMappings = stableMappings();
    const finishedAt = nowIso();
    const conversion = durableConversionReport();
    const updated = await updateNotionJobIfStatus(db, job.id, 'ready', {
      status: 'completed',
      phase: 'applied',
      progress: {
        ...withImportProgress(currentJob.progress, {
          key: 'apply',
          status: 'completed',
          legacyStep: 'applied_to_local_workspace',
          percent: 100,
          at: finishedAt,
          counts: created,
        }),
        applied: created,
      },
      report: {
        ...(currentJob.report ?? {}),
        applied: created,
        conversion,
        partialConversion: conversion,
        ...(importedRootPageId ? { importedRootPageId } : {}),
        completedAt: finishedAt,
      },
      options: importPagesFullWidth !== undefined
        ? {
            ...(currentJob.options ?? {}),
            importPagesFullWidth,
          }
        : currentJob.options,
      finishedAt,
    }, {
      extraExpectations: applyLease
        ? [{
            table: 'notion_import_apply_locks',
            op: 'expect',
            id: applyLease.id,
            where: [
              ['leaseId', '==', applyLease.leaseId],
              ['purpose', '==', 'apply'],
            ],
            exists: true,
          }]
        : [],
    });
    if (!updated) {
      const latest = await getExisting(jobs, job.id);
      if (latest?.status === 'cancelled') throw new Error('Notion import job is cancelled.');
      throw new Error('Notion import job state changed before apply completed.');
    }
    await recordWorkspaceAudit(db, {
      workspaceId: job.workspaceId,
      actorId,
      action: 'notion_import.apply',
      targetType: 'notion_import_job',
      targetId: job.id,
      metadata: created,
      occurredAt: finishedAt,
    });
    clearNotionImportApplySnapshotCache(job.id);
    return {
      job: cleanJob(updated),
      applied: created,
      ...(importedRootPageId ? { importedRootPageId } : {}),
      ...(compact ? {} : { mappings: allMappings }),
    };
  };

  const itemSnapshotRevision = optionalString(currentJob.itemSnapshotRevision);
  if (!itemSnapshotRevision) {
    throw new Error('Notion import apply requires an immutable item snapshot revision.');
  }
  const checkpointRevision = optionalString(asRecord(currentJob.report)?.fileCopyCheckpointRevision);
  const shouldRunFileCopyPhase =
    !!existingFileCopyCursor
    || checkpointRevision !== itemSnapshotRevision;
  const usesDurableFileCheckpoints = shouldRunFileCopyPhase || checkpointRevision === itemSnapshotRevision;

  if (usesDurableFileCheckpoints) {
    if (!applySnapshot.fileCheckpointUploadsBySlotKey) {
      // This branch is defensive for older in-process cache entries. New
      // entries install the shared map when the file context is constructed.
      applySnapshot.fileCheckpointUploadsBySlotKey = checkpointUploadsBySlotKey;
    }
    if (checkpointUploadsBySlotKey.size === 0 && !applySnapshot.fileCopySlots) {
      const durableCheckpoints = await loadNotionImportFileCheckpoints(
        db,
        currentJob.id,
        itemSnapshotRevision,
      );
      checkpointUploadsBySlotKey.clear();
      for (const [slotKey, upload] of durableCheckpoints) {
        checkpointUploadsBySlotKey.set(slotKey, upload);
      }
    }
    created.fileCopies = Math.max(
      created.fileCopies,
      Array.from(checkpointUploadsBySlotKey.values()).filter((upload) => upload.status === 'uploaded').length,
    );
  }

  if (shouldRunFileCopyPhase) {
    const defaultResumeCursor: Record<string, unknown> = {
      phase: 'apply_data_sources',
      dataSourceIndex: 0,
      totalDataSources: dataSourceItems.length,
    };
    const fileResumeCursor = logicalApplyCursor ?? defaultResumeCursor;
    const fileCursorRevision = optionalString(existingFileCopyCursor?.itemSnapshotRevision);
    if (fileCursorRevision && fileCursorRevision !== itemSnapshotRevision) {
      throw Object.assign(new Error('Notion import file cursor revision changed before resume.'), { code: 409 });
    }
    const retryAfterAt = optionalString(existingFileCopyCursor?.retryAfterAt);
    const retryAfterMs = retryAfterAt ? Date.parse(retryAfterAt) : NaN;
    if (Number.isFinite(retryAfterMs) && retryAfterMs > Date.now()) {
      // Enforce backoff in the server as well as the product runner. API/MCP
      // callers that immediately replay a partial response must not hammer
      // Notion or object storage before the durable retry window opens.
      return partialApplyResult();
    }

    let fileSlots = applySnapshot.fileCopySlots;
    if (!fileSlots) {
      // A durable product cursor is a lower bound, not proof that every later
      // item is untouched: the page loop can finish N+1 before its next cadence
      // write. Inventory the suffix, then remove pages whose durable completion
      // marker proves that all chrome, row files, and blocks already committed.
      const includedItemIds = new Set<string>();
      const addItems = (candidates: NotionImportItem[]) => {
        for (const candidate of candidates) includedItemIds.add(candidate.id);
      };
      if (!existingApplyPhase || existingApplyPhase === 'apply_data_sources') {
        addItems(dataSourceItems.slice(resumeDataSourceIndex));
        addItems(stableItems.filter((item) => item.notionObject === 'database'));
        addItems(pageItems);
      } else if (existingApplyPhase === 'apply_database_containers') {
        // Legacy database-only chunking deliberately re-validates the complete
        // source/template graph on resume (see dataSourceItemsForRun below).
        // Inventory those possible repair owners before that path can run.
        if (applyDataSourceBatchSize === 0) addItems(dataSourceItems);
        addItems(stableItems.filter((item) => item.notionObject === 'database'));
        addItems(pageItems);
      } else if (existingApplyPhase === 'apply_pages') {
        addItems(pageItems.slice(resumePageIndex));
      }

      if (includedItemIds.size > 0) {
        for (const pageItem of pageItems) {
          if (!includedItemIds.has(pageItem.id)) continue;
          const mapping = mappingsByNotionId.get(pageItem.notionId);
          if (mapping?.localType !== 'page') continue;
          const existingPage = await getExisting(db.table<Page>('pages'), mapping.localId);
          if (existingPage && importedBlocksComplete(existingPage)) {
            includedItemIds.delete(pageItem.id);
          }
        }
      }

      fileSlots = await collectNotionImportFileCopySlots(
        stableItems,
        itemSnapshotRevision,
        includedItemIds,
      );
      applySnapshot.fileCopySlots = fileSlots;
      applySnapshot.fileSlotKeysByCoordinates = new Map(fileSlots.map((slot) => [
        notionImportFileSlotCoordinates(itemSnapshotRevision, slot.target),
        slot.slotKey,
      ]));
      fileCopyContext.checkpointSlotKeysByCoordinates = applySnapshot.fileSlotKeysByCoordinates;
      rememberApplySnapshot(currentJob, applySnapshot);
    } else if (!applySnapshot.fileSlotKeysByCoordinates) {
      applySnapshot.fileSlotKeysByCoordinates = new Map(fileSlots.map((slot) => [
        notionImportFileSlotCoordinates(itemSnapshotRevision, slot.target),
        slot.slotKey,
      ]));
      fileCopyContext.checkpointSlotKeysByCoordinates = applySnapshot.fileSlotKeysByCoordinates;
    }
    const fileIndex = existingFileCopyCursor
      && typeof existingFileCopyCursor.fileIndex === 'number'
      && Number.isFinite(existingFileCopyCursor.fileIndex)
      ? Math.max(0, Math.floor(existingFileCopyCursor.fileIndex))
      : 0;
    if (fileIndex > fileSlots.length) {
      throw Object.assign(new Error('Notion import file cursor exceeded the immutable inventory.'), { code: 409 });
    }
    const storedTotalFiles = existingFileCopyCursor?.totalFiles;
    if (
      typeof storedTotalFiles === 'number'
      && Number.isFinite(storedTotalFiles)
      && Math.floor(storedTotalFiles) !== fileSlots.length
    ) {
      throw Object.assign(new Error('Notion import file inventory changed before resume.'), { code: 409 });
    }
    const lastSlotKey = optionalString(existingFileCopyCursor?.lastSlotKey);
    if (fileIndex > 0 && lastSlotKey !== fileSlots[fileIndex - 1]?.slotKey) {
      throw Object.assign(new Error('Notion import file cursor no longer matches its last durable slot.'), { code: 409 });
    }

    const applyFileBatchSize = parsePositiveInt(
      body.applyFileBatchSize,
      NOTION_IMPORT_APPLY_FILE_BATCH_SIZE,
      NOTION_IMPORT_APPLY_FILE_BATCH_SIZE_MAX,
    );
    if (fileSlots.length === 0) {
      // The pre-copy invariant is trivially satisfied. Preserve legacy
      // one-shot behavior for file-free imports while still publishing the
      // revision marker before the first product write.
      const restoredPhase = optionalString(fileResumeCursor.phase) ?? 'apply_data_sources';
      await updateApplyProgress(restoredPhase, fileResumeCursor, undefined, {
        exactApplyCursor: fileResumeCursor,
        reportPatch: { fileCopyCheckpointRevision: itemSnapshotRevision },
      });
      fileCopyContext.checkpointOnly = false;
      fileCopyContext.requireFileCopyCheckpoint = true;
    } else {
    const endIndex = Math.min(fileSlots.length, fileIndex + applyFileBatchSize);
    fileCopyContext.checkpointOnly = true;
    fileCopyContext.requireFileCopyCheckpoint = false;
    let nextFileIndex = fileIndex;
    const fileBatchStartedAt = Date.now();
    try {
      for (; nextFileIndex < endIndex; nextFileIndex += 1) {
        if (nextFileIndex > fileIndex && Date.now() - fileBatchStartedAt >= NOTION_IMPORT_APPLY_FILE_DEADLINE_MS) {
          break;
        }
        const slot = fileSlots[nextFileIndex]!;
        const currentCheckpoint = await loadNotionImportFileCheckpointBySlotKey(
          db,
          currentJob.id,
          itemSnapshotRevision,
          slot.slotKey,
        );
        if (currentCheckpoint) checkpointUploadsBySlotKey.set(slot.slotKey, currentCheckpoint);
        else checkpointUploadsBySlotKey.delete(slot.slotKey);
        await copyNotionImportFileSlot(fileCopyContext, slot);
      }
    } catch (error) {
      const retryable = !!error && typeof error === 'object' && (
        (error as { notionImportFileRetryable?: unknown }).notionImportFileRetryable === true
        || (error as { notionImportRecoveryPending?: unknown }).notionImportRecoveryPending === true
      );
      if (!retryable) throw error;
      const retryCount = typeof existingFileCopyCursor?.retryCount === 'number'
        && Number.isFinite(existingFileCopyCursor.retryCount)
        ? Math.max(0, Math.floor(existingFileCopyCursor.retryCount)) + 1
        : 1;
      await updateApplyProgress('apply_file_copies', {
        fileIndex: nextFileIndex,
        totalFiles: fileSlots.length,
        fileBatchSize: applyFileBatchSize,
        itemSnapshotRevision,
        ...(nextFileIndex > 0 ? { lastSlotKey: fileSlots[nextFileIndex - 1]!.slotKey } : {}),
        retryCount,
        retryAfterAt: new Date(Date.now() + Math.min(30_000, 500 * 2 ** Math.min(retryCount, 6))).toISOString(),
        resumeCursor: fileResumeCursor,
        paused: true,
      });
      return partialApplyResult();
    }

    if (nextFileIndex < fileSlots.length) {
      await updateApplyProgress('apply_file_copies', {
        fileIndex: nextFileIndex,
        totalFiles: fileSlots.length,
        fileBatchSize: applyFileBatchSize,
        itemSnapshotRevision,
        lastSlotKey: fileSlots[nextFileIndex - 1]!.slotKey,
        resumeCursor: fileResumeCursor,
        paused: true,
      }, {
        kind: 'copy_file',
        count: nextFileIndex,
        total: fileSlots.length,
      });
      return partialApplyResult();
    }

    // Restore the exact product cursor that was nested when pre-copy began.
    // This is intentionally a separate request boundary: no root/page/database
    // write can share the request that performs the last remote object copy.
    const restoredPhase = optionalString(fileResumeCursor.phase) ?? 'apply_data_sources';
    await updateApplyProgress(restoredPhase, fileResumeCursor, undefined, {
      exactApplyCursor: fileResumeCursor,
      reportPatch: { fileCopyCheckpointRevision: itemSnapshotRevision },
    });
    return partialApplyResult();
    }
  }

  if (checkpointRevision === itemSnapshotRevision) {
    fileCopyContext.checkpointOnly = false;
    fileCopyContext.requireFileCopyCheckpoint = true;
  }

  if (existingApplyPhase === 'apply_scrub') {
    const itemIndex = applyScrubBatchSize > 0
      ? Math.min(items.length, resumeScrubIndex + applyScrubBatchSize)
      : items.length;
    await scrubAppliedImportCredentialMetadata(db, stableItems.slice(resumeScrubIndex, itemIndex));
    if (itemIndex < items.length) {
      await updateApplyProgress('apply_scrub', {
        itemIndex,
        totalItems: items.length,
        itemBatchSize: applyScrubBatchSize,
        paused: true,
      });
      return partialApplyResult();
    }
    const indexMappings = stableMappings().filter(
      (mapping) => mapping.localType === 'page' || mapping.localType === 'database',
    );
    await updateApplyProgress('apply_finalize_indexes', {
      mappingIndex: 0,
      totalMappings: indexMappings.length,
      mappingBatchSize: applyFinalizeBatchSize,
    });
    return partialApplyResult();
  }

  if (existingApplyPhase === 'apply_finalize_indexes') {
    const indexMappings = stableMappings().filter(
      (mapping) => mapping.localType === 'page' || mapping.localType === 'database',
    );
    const mappingIndex = applyFinalizeBatchSize > 0
      ? Math.min(indexMappings.length, resumeFinalizeMappingIndex + applyFinalizeBatchSize)
      : indexMappings.length;
    await ensureImportedPageWorkspaceIndexes(
      admin,
      indexMappings.slice(resumeFinalizeMappingIndex, mappingIndex),
      job.workspaceId,
    );
    if (mappingIndex < indexMappings.length) {
      await updateApplyProgress('apply_finalize_indexes', {
        mappingIndex,
        totalMappings: indexMappings.length,
        mappingBatchSize: applyFinalizeBatchSize,
        paused: true,
      });
      return partialApplyResult();
    }
    await updateApplyProgress('apply_finalize', {
      mappingIndex: indexMappings.length,
      totalMappings: indexMappings.length,
    });
    return partialApplyResult();
  }

  if (existingApplyPhase === 'apply_finalize') {
    return await publishCompletedApply();
  }

  // File pre-copy above is the hard side-effect boundary. Do not create even
  // the synthetic import root until every required remote object is durable.
  const rootPageId = await ensureImportRoot(
    db,
    admin,
    currentJob,
    mappingsByNotionId,
    actorId,
    applyLease,
  );
  const checkpointOwnerPageIds = new Set<string>();
  const checkpointOwnerTemplateIds = new Set<string>();
  for (const upload of checkpointUploadsBySlotKey.values()) {
    if (upload.pageId) checkpointOwnerPageIds.add(upload.pageId);
    if (upload.databaseId) checkpointOwnerPageIds.add(upload.databaseId);
    if (upload.templateId) checkpointOwnerTemplateIds.add(upload.templateId);
  }
  const checkpointOwnerPages = new Map<string, Page | null>();
  const checkpointOwnerTemplates = new Map<string, DbTemplate | null>();
  const findUnmappedImportedPageOwner = async (
    notionProperty: 'notionDataSourceId' | 'notionDatabaseId' | 'notionPageId',
    notionId: string,
    kind: Page['kind'],
  ) => {
    const matchesById = new Map<string, Page>();
    for (const pageId of checkpointOwnerPageIds) {
      if (!checkpointOwnerPages.has(pageId)) {
        checkpointOwnerPages.set(pageId, await getExisting(db.table<Page>('pages'), pageId));
      }
      const candidate = checkpointOwnerPages.get(pageId);
      if (!candidate) continue;
      if (
      candidate.kind === kind
      && optionalString(candidate.properties?.notionImportJobId) === job.id
      && optionalString(candidate.properties?.[notionProperty]) === notionId
      ) {
        matchesById.set(candidate.id, candidate);
      }
    }
    const sourceKind = notionProperty === 'notionPageId'
      ? 'page'
      : notionProperty === 'notionDataSourceId'
        ? 'data_source'
        : 'database';
    const locatorByJob = db.table<Page>('pages').where('notionImportJobId', '==', job.id);
    if (typeof locatorByJob.where !== 'function') {
      throw Object.assign(new Error('Notion import page locator requires compound equality queries.'), { code: 503 });
    }
    const locatorBySource = locatorByJob.where('notionImportSourceId', '==', notionId);
    if (typeof locatorBySource.where !== 'function') {
      throw Object.assign(new Error('Notion import page locator requires compound equality queries.'), { code: 503 });
    }
    const locatorMatches = await listAll(
      locatorBySource.where('notionImportSourceKind', '==', sourceKind),
      100_000,
    );
    if (locatorMatches.length > 1) {
      throw Object.assign(
        new Error(`Notion import found duplicate durable owners for source ${notionId}.`),
        { code: 409 },
      );
    }
    for (const candidate of locatorMatches) {
      matchesById.set(candidate.id, candidate);
    }
    const matches = Array.from(matchesById.values());
    if (matches.length > 1) {
      throw Object.assign(
        new Error(`Notion import found duplicate durable owners for source ${notionId}.`),
        { code: 409 },
      );
    }
    return matches[0];
  };
  const findImportedTemplateOwner = async (input: {
    databaseId: string;
    notionTemplateId?: string;
    notionDataSourceId: string;
    structuralIndex: number;
    snapshotRevision: string;
    fingerprint: string;
    expectedTemplate: DbTemplate;
    databaseTemplates: DbTemplate[];
    mappedTemplate?: DbTemplate;
  }) => {
    const sourceLabel = input.notionTemplateId ?? `index ${input.structuralIndex}`;
    const checkpointCandidates: DbTemplate[] = [];
    for (const templateId of checkpointOwnerTemplateIds) {
      if (!checkpointOwnerTemplates.has(templateId)) {
        checkpointOwnerTemplates.set(
          templateId,
          await getExisting(db.table<DbTemplate>('db_templates'), templateId),
        );
      }
      const candidate = checkpointOwnerTemplates.get(templateId);
      if (candidate?.databaseId === input.databaseId) checkpointCandidates.push(candidate);
    }

    let locator = db.table<DbTemplate>('db_templates').where('notionImportJobId', '==', job.id);
    const coordinates: Array<readonly [string, unknown]> = input.notionTemplateId
      ? [
          ['notionTemplateId', input.notionTemplateId],
          ['notionDataSourceId', input.notionDataSourceId],
        ]
      : [
          ['notionDataSourceId', input.notionDataSourceId],
          ['notionTemplateStructuralIndex', input.structuralIndex],
          ['notionImportSnapshotRevision', input.snapshotRevision],
          ['notionTemplateFingerprint', input.fingerprint],
        ];
    for (const [field, value] of coordinates) {
      if (typeof locator.where !== 'function') {
        throw Object.assign(
          new Error('Notion import template locator requires compound equality queries.'),
          { code: 503 },
        );
      }
      locator = locator.where(field, '==', value);
    }
    const locatorMatches = await listAll(locator, 100_000);
    if (locatorMatches.length > 1) {
      throw Object.assign(
        new Error(`Notion import found duplicate durable template owners for source ${sourceLabel}.`),
        { code: 409 },
      );
    }

    const exactProvenance = (candidate: DbTemplate) => (
      candidate.databaseId === input.databaseId
      && candidate.notionImportJobId === job.id
      && candidate.notionDataSourceId === input.notionDataSourceId
      && (input.notionTemplateId
        ? candidate.notionTemplateId === input.notionTemplateId
        : !optionalString(candidate.notionTemplateId))
      && candidate.notionTemplateStructuralIndex === input.structuralIndex
      && candidate.notionImportSnapshotRevision === input.snapshotRevision
      && candidate.notionTemplateFingerprint === input.fingerprint
    );
    const exactById = new Map<string, DbTemplate>();
    for (const candidate of [
      ...locatorMatches,
      ...checkpointCandidates,
      ...input.databaseTemplates,
      ...(input.mappedTemplate ? [input.mappedTemplate] : []),
    ]) {
      if (exactProvenance(candidate)) exactById.set(candidate.id, candidate);
    }
    const exactMatches = Array.from(exactById.values());
    if (exactMatches.length > 1) {
      throw Object.assign(
        new Error(`Notion import found duplicate durable template owners for source ${sourceLabel}.`),
        { code: 409 },
      );
    }
    if (exactMatches[0]) return { template: exactMatches[0], provenance: 'exact' as const };

    const hasNewProvenance = (candidate: DbTemplate) => (
      candidate.notionTemplateStructuralIndex !== undefined
      || !!candidate.notionImportSnapshotRevision
      || !!candidate.notionTemplateFingerprint
    );
    const coordinateCandidates = new Map<string, DbTemplate>();
    for (const candidate of [
      ...locatorMatches,
      ...checkpointCandidates,
      ...input.databaseTemplates,
      ...(input.mappedTemplate ? [input.mappedTemplate] : []),
    ]) {
      if (candidate.databaseId !== input.databaseId) continue;
      const sameSource = input.notionTemplateId
        ? candidate.notionImportJobId === job.id
          && candidate.notionTemplateId === input.notionTemplateId
          && candidate.notionDataSourceId === input.notionDataSourceId
        : candidate.notionImportJobId === job.id
          && candidate.notionDataSourceId === input.notionDataSourceId
          && candidate.notionTemplateStructuralIndex === input.structuralIndex;
      if (sameSource) coordinateCandidates.set(candidate.id, candidate);
    }
    const legacyFingerprintCandidates = Array.from(coordinateCandidates.values()).filter((candidate) => (
      candidate.notionTemplateStructuralIndex === input.structuralIndex
      && candidate.notionImportSnapshotRevision === input.snapshotRevision
      && typeof candidate.notionTemplateFingerprint === 'string'
      && /^fnv1a32:[0-9a-f]{8}$/.test(candidate.notionTemplateFingerprint)
    ));
    // The unversioned prefix is the only legacy comparator identity. Exact
    // durable coordinates select at most one candidate here; the caller then
    // validates its complete immutable owner snapshot before a fenced rewrite.
    if (legacyFingerprintCandidates.length > 1) {
      throw Object.assign(
        new Error(`Notion import found duplicate legacy-fingerprint template owners for source ${sourceLabel}.`),
        { code: 409 },
      );
    }
    if (legacyFingerprintCandidates.length === 1 && coordinateCandidates.size === 1) {
      return {
        template: legacyFingerprintCandidates[0],
        provenance: 'legacy_fingerprint' as const,
      };
    }
    if (Array.from(coordinateCandidates.values()).some(hasNewProvenance)) {
      throw Object.assign(
        new Error(`Notion import template provenance changed for source ${sourceLabel}.`),
        { code: 409 },
      );
    }

    const legacyCandidates = input.databaseTemplates.filter((candidate) => (
      candidate.databaseId === input.databaseId
      && candidate.position === input.expectedTemplate.position
      && !hasNewProvenance(candidate)
      && (!candidate.notionImportJobId || candidate.notionImportJobId === job.id)
      && (!candidate.notionDataSourceId || candidate.notionDataSourceId === input.notionDataSourceId)
      && (input.notionTemplateId
        ? !candidate.notionTemplateId || candidate.notionTemplateId === input.notionTemplateId
        : !candidate.notionTemplateId)
    ));
    if (legacyCandidates.length > 1) {
      throw Object.assign(
        new Error(`Notion import found ambiguous legacy template owners for source ${sourceLabel}.`),
        { code: 409 },
      );
    }
    const legacy = legacyCandidates[0];
    if (!legacy) return undefined;
    if (!importedTemplateOwnerMatchesImmutableSnapshot(legacy, input.expectedTemplate)) {
      throw Object.assign(
        new Error(`Notion import legacy template snapshot changed for source ${sourceLabel}.`),
        { code: 409 },
      );
    }
    return { template: legacy, provenance: 'legacy' as const };
  };
  const findUnmappedImportedPropertyOwner = async (
    databaseId: string,
    notionDataSourceId: string,
    notionPropertyId: string,
    databaseProperties: DbProperty[],
  ) => {
    const matchesById = new Map<string, DbProperty>();
    for (const candidate of databaseProperties) {
      if (optionalString(asRecord(candidate.config)?.notionPropertyId) === notionPropertyId) {
        matchesById.set(candidate.id, candidate);
      }
    }
    let locator = db.table<DbProperty>('db_properties').where('databaseId', '==', databaseId);
    for (const [field, value] of [
      ['notionImportJobId', job.id],
      ['notionDataSourceId', notionDataSourceId],
      ['notionPropertyId', notionPropertyId],
    ] as const) {
      if (typeof locator.where !== 'function') {
        throw Object.assign(new Error('Notion import property locator requires compound equality queries.'), { code: 503 });
      }
      locator = locator.where(field, '==', value);
    }
    for (const candidate of await listAll(locator, 100_000)) matchesById.set(candidate.id, candidate);
    const matches = Array.from(matchesById.values());
    if (matches.length > 1) {
      throw Object.assign(
        new Error(`Notion import found duplicate durable property owners for source ${notionPropertyId}.`),
        { code: 409 },
      );
    }
    return matches[0];
  };
  const findUnmappedImportedViewOwner = async (input: {
    databaseId: string;
    notionDataSourceId: string;
    notionViewId?: string;
    structuralIndex: number;
    snapshotRevision: string;
    fingerprint: string;
    databaseViews: DbView[];
  }) => {
    const matchesById = new Map<string, DbView>();
    for (const candidate of input.databaseViews) {
      if (candidate.notionImportJobId) continue;
      const config = asRecord(candidate.config);
      const legacyViewId = optionalString(config?.notionViewId);
      const legacyNotionView = asRecord(config?.notion);
      if (
        (input.notionViewId && legacyViewId === input.notionViewId)
        || (
          !input.notionViewId
          && !legacyViewId
          && legacyNotionView
          && importedViewFingerprint(legacyNotionView) === input.fingerprint
        )
      ) {
        matchesById.set(candidate.id, candidate);
      }
    }
    let locator = db.table<DbView>('db_views').where('databaseId', '==', input.databaseId);
    const coordinates: Array<readonly [string, unknown]> = input.notionViewId
      ? [
          ['notionImportJobId', job.id],
          ['notionDataSourceId', input.notionDataSourceId],
          ['notionViewId', input.notionViewId],
        ]
      : [
          ['notionImportJobId', job.id],
          ['notionDataSourceId', input.notionDataSourceId],
          ['notionViewStructuralIndex', input.structuralIndex],
        ];
    for (const [field, value] of coordinates) {
      if (typeof locator.where !== 'function') {
        throw Object.assign(new Error('Notion import view locator requires compound equality queries.'), { code: 503 });
      }
      locator = locator.where(field, '==', value);
    }
    for (const candidate of await listAll(locator, 100_000)) matchesById.set(candidate.id, candidate);
    const matches = Array.from(matchesById.values());
    if (matches.length > 1) {
      throw Object.assign(
        new Error(`Notion import found duplicate durable view owners for source ${input.notionViewId ?? input.structuralIndex}.`),
        { code: 409 },
      );
    }
    const match = matches[0];
    if (
      match
      && !input.notionViewId
      && match.notionImportJobId
      && (
        match.notionImportSnapshotRevision !== input.snapshotRevision
        || match.notionViewFingerprint !== input.fingerprint
      )
    ) {
      throw Object.assign(new Error('Notion import id-less view provenance changed before recovery.'), { code: 409 });
    }
    return match;
  };
  const applyingDataSources = !existingApplyPhase || existingApplyPhase === 'apply_data_sources';
  if (applyingDataSources) {
    await updateApplyProgress('apply_data_sources', {
      totalDataSources: dataSourceItems.length,
      dataSourceIndex: resumeDataSourceIndex,
      dataSourceBatchSize: applyDataSourceBatchSize,
    });
  }

  let dataSourcesProcessedThisRun = 0;
  for (const item of dataSourceItemsForRun) {
    dataSourcesProcessedThisRun += 1;
    const existingMapping = mappingsByNotionId.get(item.notionId);
    if (existingMapping && existingMapping.localType !== 'database') {
      throw Object.assign(
        new Error('Notion import data-source mapping has an incompatible owner type.'),
        { code: 409 },
      );
    }
    let databaseId = existingMapping?.localId;
    if (databaseId) {
      let existingDatabase = await getExisting(db.table<Page>('pages'), databaseId);
      if (!existingDatabase) {
        throw Object.assign(new Error('Notion import database mapping owner was missing.'), { code: 409 });
      }
      await ensureImportedPageWorkspaceIndexes(admin, [existingMapping!], job.workspaceId);
      existingDatabase = await copyImportedPageChromeFiles(fileCopyContext, existingDatabase, item);
      await preserveImportedPageTimestamps(fileCopyContext, existingDatabase, item);
    }
    if (!databaseId) {
      let recoveredPage = await findUnmappedImportedPageOwner('notionDataSourceId', item.notionId, 'database');
      if (recoveredPage) {
        // The page+file owner commits before the mapping by design. Recover
        // that exact durable owner after a worker death instead of inserting a
        // duplicate database or stranding its checkpoint attachments.
        recoveredPage = await copyImportedPageChromeFiles(fileCopyContext, recoveredPage, item);
        recoveredPage = await preserveImportedPageTimestamps(fileCopyContext, recoveredPage, item);
        databaseId = recoveredPage.id;
        await publishRecoveredImportedOwnerMapping(fileCopyContext, mappingsByNotionId, {
          notionId: item.notionId,
          notionType: item.notionObject,
          localId: databaseId,
          localType: 'database',
          relationKind: 'canonical_data_source',
          metadata: { title: item.title },
        }, {
          table: 'pages',
          id: recoveredPage.id,
          where: [
            ['workspaceId', '==', job.workspaceId],
            ['kind', '==', 'database'],
            ['notionImportJobId', '==', job.id],
            ['notionImportSourceId', '==', item.notionId],
            ['notionImportSourceKind', '==', 'data_source'],
          ],
        });
        created.databases += 1;
        created.mappings += 1;
      }
    }
    if (!databaseId) {
      const chrome = importedPageChromeFromItem(item);
      const initialChrome = initialImportedPageChrome(chrome);
      const pageOwner = basePage({
          workspaceId: job.workspaceId,
          parentId: rootPageId,
          parentType: 'page',
          kind: 'database',
          title: item.title || generatedLabels.importedDatabase,
          icon: initialChrome.icon,
          iconType: initialChrome.iconType,
          cover: initialChrome.cover,
          coverPosition: initialChrome.coverPosition,
          position: created.databases + 1,
          actorId,
          ...importedItemTimestamps(item),
          properties: pagePropertiesWithChromeReferences({
            notionImportJobId: job.id,
            notionDataSourceId: item.notionId,
          }, chrome),
        });
      let { page } = await insertImportedPageWithMapping(
        fileCopyContext,
        mappingsByNotionId,
        pageOwner,
        {
          notionId: item.notionId,
          notionType: item.notionObject,
          localType: 'database',
          relationKind: 'canonical_data_source',
          metadata: { title: item.title },
        },
      );
      page = await copyImportedPageChromeFiles(fileCopyContext, page, item);
      page = await preserveImportedPageTimestamps(fileCopyContext, page, item);
      databaseId = page.id;
      created.databases += 1;
      created.mappings += 1;
      if (Date.now() - lastApplyProgressWriteMs >= 1_000) {
        lastApplyProgressWriteMs = Date.now();
        await updateApplyProgress('apply_data_sources', {
          totalDataSources: dataSourceItems.length,
          // The database container exists, but this source is not durable as
          // complete until its properties, views, templates, and files finish.
          // Keep the cursor on the current item so a worker death retries it.
          dataSourceIndex: Math.max(
            resumeDataSourceIndex,
            resumeDataSourceIndex + dataSourcesProcessedThisRun - 1,
          ),
          dataSourceBatchSize: applyDataSourceBatchSize,
        }, {
          kind: 'create_database',
          title: item.title || undefined,
          count: created.databases,
          total: dataSourceItems.length,
        });
      }
    }

    const propMap = propertyMappingsByDataSource.get(item.notionId) ?? new Map<string, string>();
    propertyMappingsByDataSource.set(item.notionId, propMap);
    propertyRecordsByDataSource.set(item.notionId, []);
    const augmentedProperties = augmentNotionPropertiesFromRowSnapshots(
      notionPropertiesFromSnapshot(dataSourceSnapshot(item)),
      item.notionId,
      items,
    );
    if (applyingDataSources && augmentedProperties.inferred > 0) {
      incrementReport(conversionReport, 'inferredRowSnapshotProperties', augmentedProperties.inferred);
    }
    const properties = withGeneratedTitleProperty(augmentedProperties.properties, locale);
    const existingDatabaseProperties = databaseId
      ? await listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', databaseId), 100_000)
      : [];
    let propIndex = 0;
    for (const [nameOrId, rawProperty] of Object.entries(properties)) {
      const notionProperty = rawProperty && typeof rawProperty === 'object' ? rawProperty as Record<string, unknown> : {};
      const notionPropertyId = typeof notionProperty.id === 'string' ? notionProperty.id : nameOrId;
      const notionType = typeof notionProperty.type === 'string' ? notionProperty.type : 'rich_text';
      if (applyingDataSources) {
        reportUnsupportedProperty(
          conversionReport,
          item.notionId,
          notionPropertyId,
          String(notionProperty.name ?? nameOrId),
          notionType,
        );
      }
      const propertyMappingNotionId = notionPropertyMappingId(item.notionId, notionPropertyId);
      let existingPropertyMapping = mappingsByNotionId.get(propertyMappingNotionId);
      if (existingPropertyMapping && existingPropertyMapping.localType !== 'db_property') {
        throw Object.assign(new Error('Notion import property mapping has an incompatible owner type.'), { code: 409 });
      }
      const mappedPropertyOwnerId = existingPropertyMapping?.localId;
      let existingProperty = mappedPropertyOwnerId
        ? existingDatabaseProperties.find((property) => property.id === mappedPropertyOwnerId) ??
          await getExisting(db.table<DbProperty>('db_properties'), mappedPropertyOwnerId)
        : undefined;
      if (existingPropertyMapping && !existingProperty) {
        throw Object.assign(new Error('Notion import property mapping owner was missing.'), { code: 409 });
      }
      if (existingProperty && existingProperty.databaseId !== databaseId) {
        throw Object.assign(new Error('Notion import property mapping belongs to another database.'), { code: 409 });
      }
      let recoveredProperty = false;
      if (!existingPropertyMapping) {
        existingProperty = await findUnmappedImportedPropertyOwner(
          databaseId,
          item.notionId,
          notionPropertyId,
          existingDatabaseProperties,
        );
        if (existingProperty) {
          const propertyRecoveryWhere: Array<[string, '==', unknown]> = [
            ['databaseId', '==', databaseId],
            ['name', '==', existingProperty.name],
            ['type', '==', existingProperty.type],
            ['position', '==', existingProperty.position],
            ['updatedAt', '==', existingProperty.updatedAt ?? null],
          ];
          if (existingProperty.notionImportJobId) {
            propertyRecoveryWhere.push(
              ['notionImportJobId', '==', job.id],
              ['notionDataSourceId', '==', item.notionId],
              ['notionPropertyId', '==', notionPropertyId],
            );
          }
          existingPropertyMapping = await publishRecoveredImportedOwnerMapping(
            fileCopyContext,
            mappingsByNotionId,
            {
              notionId: propertyMappingNotionId,
              notionType: 'property',
              localId: existingProperty.id,
              localType: 'db_property',
              relationKind: 'database_property',
              metadata: {
                dataSourceId: item.notionId,
                databaseId,
                name: existingProperty.name,
                notionPropertyId,
              },
            },
            {
              table: 'db_properties',
              id: existingProperty.id,
              where: propertyRecoveryWhere,
              patch: {
                notionImportJobId: job.id,
                notionDataSourceId: item.notionId,
                notionPropertyId,
              },
            },
          );
          Object.assign(existingProperty, {
            notionImportJobId: job.id,
            notionDataSourceId: item.notionId,
            notionPropertyId,
          });
          recoveredProperty = true;
        }
      }
      if (existingProperty) {
        setViewPropertyMapping(propMap, notionPropertyId, existingProperty.id);
        setViewPropertyMapping(propMap, nameOrId, existingProperty.id);
        setViewPropertyMapping(propMap, existingProperty.name, existingProperty.id);
        if (notionPropertyId === GENERATED_NOTION_TITLE_PROPERTY_ID) {
          setViewPropertyMapping(propMap, 'Name', existingProperty.id);
          setViewPropertyMapping(propMap, 'title', existingProperty.id);
        }
        propertyRecordsByDataSource.get(item.notionId)?.push(existingProperty);
        importedPropertyContexts.push({
          dataSourceId: item.notionId,
          notionPropertyId,
          notionPropertyName: nameOrId,
          notionProperty: { ...notionProperty, name: notionProperty.name ?? nameOrId },
          property: existingProperty,
        });
        if (recoveredProperty) {
          created.properties += 1;
          created.mappings += 1;
        }
        propIndex += 1;
        continue;
      }
      const property: DbProperty = {
        ...dbPropertyFromNotion(
          databaseId,
          notionPropertyId,
          { ...notionProperty, name: notionProperty.name ?? nameOrId },
          propIndex,
        ),
        notionImportJobId: job.id,
        notionDataSourceId: item.notionId,
        notionPropertyId,
      };
      const { owner: inserted } = await insertImportedDatabaseChildWithMapping(
        fileCopyContext,
        mappingsByNotionId,
        'db_properties',
        property,
        {
          notionId: propertyMappingNotionId,
          notionType: 'property',
          localType: 'db_property',
          relationKind: 'database_property',
          metadata: {
            dataSourceId: item.notionId,
            databaseId,
            name: property.name,
            notionPropertyId,
          },
        },
      );
      setViewPropertyMapping(propMap, notionPropertyId, inserted.id);
      setViewPropertyMapping(propMap, nameOrId, inserted.id);
      setViewPropertyMapping(propMap, inserted.name, inserted.id);
      if (notionPropertyId === GENERATED_NOTION_TITLE_PROPERTY_ID) {
        setViewPropertyMapping(propMap, 'Name', inserted.id);
        setViewPropertyMapping(propMap, 'title', inserted.id);
      }
      propertyRecordsByDataSource.get(item.notionId)?.push(inserted);
      importedPropertyContexts.push({
        dataSourceId: item.notionId,
        notionPropertyId,
        notionPropertyName: nameOrId,
        notionProperty: { ...notionProperty, name: notionProperty.name ?? nameOrId },
        property: inserted,
      });
      created.properties += 1;
      created.mappings += 1;
      propIndex += 1;
    }

    const directViewItems = items
      .filter((viewItem) => viewItem.notionObject === 'view' && viewItem.parentNotionId === item.notionId)
      .sort(compareNotionImportViewItems);
    const snapshotViews = dataSourceSnapshot(item)?.views;
    const rawViews = directViewItems.length
      ? directViewItems.map((viewItem) => viewSnapshot(viewItem)).filter((view): view is Record<string, unknown> => !!view)
      : Array.isArray(snapshotViews)
        ? snapshotViews.filter((view): view is Record<string, unknown> => !!view && typeof view === 'object')
        : [];
    const viewsToCreate = localizedImportableNotionViews(rawViews, locale);
    const existingViews = databaseId
      ? await listAll(db.table<DbView>('db_views').where('databaseId', '==', databaseId), 100_000)
      : [];
    for (let index = 0; index < viewsToCreate.length; index += 1) {
      if (applyingDataSources) reportUnsupportedView(conversionReport, item.notionId, viewsToCreate[index]);
      const viewToCreate = viewsToCreate[index];
      const notionViewId = typeof viewToCreate.id === 'string' ? viewToCreate.id : undefined;
      const viewFingerprint = importedViewFingerprint(viewToCreate);
      let existingViewMapping = notionViewId ? mappingsByNotionId.get(notionViewId) : undefined;
      if (existingViewMapping && existingViewMapping.localType !== 'db_view') {
        throw Object.assign(new Error('Notion import view mapping has an incompatible owner type.'), { code: 409 });
      }
      const mappedViewOwnerId = existingViewMapping?.localId;
      let existingView = mappedViewOwnerId
        ? existingViews.find((view) => view.id === mappedViewOwnerId)
          ?? await getExisting(db.table<DbView>('db_views'), mappedViewOwnerId)
        : undefined;
      if (existingViewMapping && !existingView) {
        throw Object.assign(new Error('Notion import view mapping owner was missing.'), { code: 409 });
      }
      if (existingView && existingView.databaseId !== databaseId) {
        throw Object.assign(new Error('Notion import view mapping belongs to another database.'), { code: 409 });
      }
      let recoveredView = false;
      if (!existingViewMapping) {
        existingView = await findUnmappedImportedViewOwner({
          databaseId,
          notionDataSourceId: item.notionId,
          notionViewId,
          structuralIndex: index,
          snapshotRevision: itemSnapshotRevision,
          fingerprint: viewFingerprint,
          databaseViews: existingViews,
        });
        const viewRecoveryWhere: Array<[string, '==', unknown]> | undefined = existingView
          ? [
              ['databaseId', '==', databaseId],
              ['name', '==', existingView.name],
              ['type', '==', existingView.type],
              ['position', '==', existingView.position],
              ['updatedAt', '==', existingView.updatedAt ?? null],
            ]
          : undefined;
        if (existingView?.notionImportJobId && viewRecoveryWhere) {
          viewRecoveryWhere.push(
            ['notionImportJobId', '==', job.id],
            ['notionDataSourceId', '==', item.notionId],
            ['notionViewStructuralIndex', '==', index],
            ['notionImportSnapshotRevision', '==', itemSnapshotRevision],
            ['notionViewFingerprint', '==', viewFingerprint],
          );
          if (notionViewId) viewRecoveryWhere.push(['notionViewId', '==', notionViewId]);
        }
        if (existingView && notionViewId && viewRecoveryWhere) {
          existingViewMapping = await publishRecoveredImportedOwnerMapping(
            fileCopyContext,
            mappingsByNotionId,
            {
              notionId: notionViewId,
              notionType: 'view',
              localId: existingView.id,
              localType: 'db_view',
              relationKind: 'database_view',
              metadata: { dataSourceId: item.notionId },
            },
            {
              table: 'db_views',
              id: existingView.id,
              where: viewRecoveryWhere,
              patch: {
                notionImportJobId: job.id,
                notionDataSourceId: item.notionId,
                notionViewId,
                notionViewStructuralIndex: index,
                notionImportSnapshotRevision: itemSnapshotRevision,
                notionViewFingerprint: viewFingerprint,
              },
            },
          );
        } else if (existingView && viewRecoveryWhere) {
          await claimRecoveredImportedDatabaseChild(
            fileCopyContext,
            'db_views',
            existingView.id,
            viewRecoveryWhere,
            {
              notionImportJobId: job.id,
              notionDataSourceId: item.notionId,
              notionViewId: null,
              notionViewStructuralIndex: index,
              notionImportSnapshotRevision: itemSnapshotRevision,
              notionViewFingerprint: viewFingerprint,
            },
          );
        }
        if (existingView) {
          Object.assign(existingView, {
            notionImportJobId: job.id,
            notionDataSourceId: item.notionId,
            notionViewId,
            notionViewStructuralIndex: index,
            notionImportSnapshotRevision: itemSnapshotRevision,
            notionViewFingerprint: viewFingerprint,
          });
          recoveredView = true;
        }
      }
      if (existingView) {
        if (recoveredView && applyingDataSources) {
          created.views += 1;
          if (notionViewId) created.mappings += 1;
        }
        continue;
      }
      const viewOwner: DbView = {
        ...dbViewFromNotion(
          databaseId,
          viewToCreate,
          index,
          propMap,
          conversionReport,
          item.notionId,
          propertyRecordsByDataSource.get(item.notionId) ?? [],
        ),
        notionImportJobId: job.id,
        notionDataSourceId: item.notionId,
        notionViewId,
        notionViewStructuralIndex: index,
        notionImportSnapshotRevision: itemSnapshotRevision,
        notionViewFingerprint: viewFingerprint,
      };
      await insertImportedDatabaseChildWithMapping(
        fileCopyContext,
        mappingsByNotionId,
        'db_views',
        viewOwner,
        notionViewId
          ? {
              notionId: notionViewId,
              notionType: 'view',
              localType: 'db_view',
              relationKind: 'database_view',
              metadata: { dataSourceId: item.notionId },
            }
          : undefined,
      );
      created.views += 1;
      if (notionViewId) {
        created.mappings += 1;
      }
    }

    const templatesToCreate = rawTemplatesFromSnapshot(dataSourceSnapshot(item));
    const existingTemplates = databaseId
      ? await listAll(db.table<DbTemplate>('db_templates').where('databaseId', '==', databaseId), 100_000)
      : [];
    for (let index = 0; index < templatesToCreate.length; index += 1) {
      const rawTemplate = templatesToCreate[index]!;
      if (applyingDataSources) {
        for (const block of rawTemplateBlocks(rawTemplate)) {
          reportTemplateBlockRichTextUserReferences(conversionReport, item, block);
        }
      }
      const notionTemplateId = notionObjectId(rawTemplate);
      const templateFingerprint = importedTemplateFingerprint(rawTemplate);
      const templateProvenance = {
        notionImportJobId: job.id,
        ...(notionTemplateId ? { notionTemplateId } : {}),
        notionDataSourceId: item.notionId,
        notionTemplateStructuralIndex: index,
        notionImportSnapshotRevision: itemSnapshotRevision,
        notionTemplateFingerprint: templateFingerprint,
      };
      const sourceTemplate: DbTemplate = {
        ...dbTemplateFromNotion(
          databaseId,
          rawTemplate,
          propMap,
          index,
          applyingDataSources ? conversionReport : undefined,
          item.notionId,
        ),
        ...templateProvenance,
      };
      const templateUniqueWhere: Array<[string, '==', unknown]> = notionTemplateId
        ? [
            ['notionImportJobId', '==', job.id],
            ['notionTemplateId', '==', notionTemplateId],
            ['notionDataSourceId', '==', item.notionId],
          ]
        : [
            ['notionImportJobId', '==', job.id],
            ['notionDataSourceId', '==', item.notionId],
            ['notionTemplateStructuralIndex', '==', index],
            ['notionImportSnapshotRevision', '==', itemSnapshotRevision],
            ['notionTemplateFingerprint', '==', templateFingerprint],
          ];
      const templateOwnerWhere = (template: DbTemplate): Array<[string, '==', unknown]> => [
        ['databaseId', '==', template.databaseId],
        ['name', '==', template.name],
        ['icon', '==', template.icon ?? null],
        ['title', '==', template.title ?? null],
        ['isDefault', '==', template.isDefault ?? null],
        ['position', '==', template.position],
        ['createdAt', '==', template.createdAt ?? null],
        ['updatedAt', '==', template.updatedAt ?? null],
        ['notionImportJobId', '==', template.notionImportJobId ?? null],
        ['notionTemplateId', '==', template.notionTemplateId ?? null],
        ['notionDataSourceId', '==', template.notionDataSourceId ?? null],
        ['notionTemplateStructuralIndex', '==', template.notionTemplateStructuralIndex ?? null],
        ['notionImportSnapshotRevision', '==', template.notionImportSnapshotRevision ?? null],
        ['notionTemplateFingerprint', '==', template.notionTemplateFingerprint ?? null],
      ];
      let existingTemplateMapping = notionTemplateId ? mappingsByNotionId.get(notionTemplateId) : undefined;
      if (existingTemplateMapping && existingTemplateMapping.localType !== 'db_template') {
        throw Object.assign(
          new Error('Notion import template mapping has an incompatible owner type.'),
          { code: 409 },
        );
      }
      const mappedTemplateId = existingTemplateMapping?.localId;
      const mappedTemplate = mappedTemplateId
        ? existingTemplates.find((template) => template.id === mappedTemplateId) ??
          await getExisting(db.table<DbTemplate>('db_templates'), mappedTemplateId) ?? undefined
        : undefined;
      if (existingTemplateMapping && !mappedTemplate) {
        throw Object.assign(new Error('Notion import template mapping owner was missing.'), { code: 409 });
      }
      if (mappedTemplate && mappedTemplate.databaseId !== databaseId) {
        throw Object.assign(
          new Error('Notion import template mapping belongs to another database.'),
          { code: 409 },
        );
      }

      let mappedLegacyFileState: 'complete' | 'source_only' | undefined;
      let resolvedTemplate: Awaited<ReturnType<typeof findImportedTemplateOwner>>;
      if (
        notionTemplateId
        && existingTemplateMapping
        && mappedTemplate
        && importedTemplateHasNoDurableProvenance(mappedTemplate)
      ) {
        const mappingMetadata = importRecord(existingTemplateMapping.metadata);
        if (
          existingTemplateMapping.workspaceId !== job.workspaceId
          || existingTemplateMapping.jobId !== job.id
          || existingTemplateMapping.notionId !== notionTemplateId
          || existingTemplateMapping.notionType !== 'template'
          || existingTemplateMapping.localId !== mappedTemplate.id
          || existingTemplateMapping.localType !== 'db_template'
          || existingTemplateMapping.relationKind !== 'database_template'
          || mappingMetadata?.dataSourceId !== item.notionId
          || mappingMetadata?.databaseId !== databaseId
        ) {
          throw Object.assign(
            new Error('Notion import legacy template mapping coordinates were inconsistent.'),
            { code: 409 },
          );
        }

        // A legacy owner may already contain native stored-file locators, so a
        // raw source-template equality check would reject a valid import. First
        // prove every stored locator belongs to one complete upload on this
        // exact template/database. Then compare all non-file immutable content;
        // source-only owners still require full byte-for-byte JSON equality.
        mappedLegacyFileState = await existingImportedTemplateFileState(
          fileCopyContext,
          mappedTemplate,
          rawTemplate,
          propMap,
        );
        const immutableSnapshotMatches = mappedLegacyFileState === 'complete'
          ? importedTemplateStoredFileOwnerMatchesImmutableSnapshot(
              mappedTemplate,
              sourceTemplate,
              rawTemplate,
              propMap,
            )
          : importedTemplateOwnerMatchesImmutableSnapshot(mappedTemplate, sourceTemplate);
        if (!immutableSnapshotMatches) {
          throw Object.assign(
            new Error('Notion import legacy mapped template snapshot changed before provenance recovery.'),
            { code: 409 },
          );
        }

        await claimRecoveredImportedDatabaseChild(
          fileCopyContext,
          'db_templates',
          mappedTemplate.id,
          [
            ['databaseId', '==', mappedTemplate.databaseId],
            ['name', '==', mappedTemplate.name],
            ['icon', '==', mappedTemplate.icon ?? null],
            ['title', '==', mappedTemplate.title ?? null],
            ['isDefault', '==', mappedTemplate.isDefault ?? null],
            ['position', '==', mappedTemplate.position],
            ['createdAt', '==', mappedTemplate.createdAt ?? null],
            ['updatedAt', '==', mappedTemplate.updatedAt ?? null],
            ['notionImportJobId', '==', null],
            ['notionTemplateId', '==', null],
            ['notionDataSourceId', '==', null],
            ['notionTemplateStructuralIndex', '==', null],
            ['notionImportSnapshotRevision', '==', null],
            ['notionTemplateFingerprint', '==', null],
          ],
          templateProvenance,
          templateUniqueWhere,
          [{
            table: 'notion_import_mappings',
            op: 'expect',
            id: existingTemplateMapping.id,
            where: [
              ['workspaceId', '==', existingTemplateMapping.workspaceId],
              ['jobId', '==', existingTemplateMapping.jobId],
              ['mappingKey', '==', existingTemplateMapping.mappingKey ?? null],
              ['notionId', '==', existingTemplateMapping.notionId],
              ['notionType', '==', existingTemplateMapping.notionType],
              ['localId', '==', existingTemplateMapping.localId],
              ['localType', '==', existingTemplateMapping.localType],
              ['relationKind', '==', existingTemplateMapping.relationKind],
            ],
            exists: true,
          }],
        );
        Object.assign(mappedTemplate, templateProvenance);
        resolvedTemplate = { template: mappedTemplate, provenance: 'exact' };
      } else {
        resolvedTemplate = await findImportedTemplateOwner({
          databaseId,
          notionTemplateId,
          notionDataSourceId: item.notionId,
          structuralIndex: index,
          snapshotRevision: itemSnapshotRevision,
          fingerprint: templateFingerprint,
          expectedTemplate: sourceTemplate,
          databaseTemplates: existingTemplates,
          mappedTemplate,
        });
      }
      if (resolvedTemplate?.provenance === 'legacy_fingerprint') {
        const legacyFingerprintOwner = resolvedTemplate.template;
        const legacyFileState = await existingImportedTemplateFileState(
          fileCopyContext,
          legacyFingerprintOwner,
          rawTemplate,
          propMap,
        );
        const immutableSnapshotMatches = legacyFileState === 'complete'
          ? importedTemplateStoredFileOwnerMatchesImmutableSnapshot(
              legacyFingerprintOwner,
              sourceTemplate,
              rawTemplate,
              propMap,
            )
          : importedTemplateOwnerMatchesImmutableSnapshot(legacyFingerprintOwner, sourceTemplate);
        if (!immutableSnapshotMatches) {
          throw Object.assign(
            new Error('Notion import legacy-fingerprint template snapshot changed before migration.'),
            { code: 409 },
          );
        }
        await claimRecoveredImportedDatabaseChild(
          fileCopyContext,
          'db_templates',
          legacyFingerprintOwner.id,
          templateOwnerWhere(legacyFingerprintOwner),
          { notionTemplateFingerprint: templateFingerprint },
          notionTemplateId ? undefined : templateUniqueWhere,
        );
        legacyFingerprintOwner.notionTemplateFingerprint = templateFingerprint;
        mappedLegacyFileState = legacyFileState;
        resolvedTemplate = { template: legacyFingerprintOwner, provenance: 'exact' };
      }
      if (
        existingTemplateMapping
        && (!resolvedTemplate || resolvedTemplate.template.id !== existingTemplateMapping.localId)
      ) {
        throw Object.assign(
          new Error('Notion import template mapping contradicted its durable owner provenance.'),
          { code: 409 },
        );
      }

      const existingTemplate = resolvedTemplate?.template;
      const recoveredWithoutMapping = !!existingTemplate && !existingTemplateMapping;
      if (existingTemplate && resolvedTemplate?.provenance === 'legacy') {
        const recoveryWhere = templateOwnerWhere(existingTemplate);
        if (notionTemplateId && !existingTemplateMapping) {
          existingTemplateMapping = await publishRecoveredImportedOwnerMapping(
            fileCopyContext,
            mappingsByNotionId,
            {
            notionId: notionTemplateId,
            notionType: 'template',
            localId: existingTemplate.id,
            localType: 'db_template',
            relationKind: 'database_template',
            metadata: { dataSourceId: item.notionId, databaseId },
            },
            {
              table: 'db_templates',
              id: existingTemplate.id,
              where: recoveryWhere,
              patch: templateProvenance,
              uniqueWhere: templateUniqueWhere,
            },
          );
        } else {
          await claimRecoveredImportedDatabaseChild(
            fileCopyContext,
            'db_templates',
            existingTemplate.id,
            recoveryWhere,
            templateProvenance,
            templateUniqueWhere,
          );
        }
        Object.assign(existingTemplate, templateProvenance);
      } else if (existingTemplate && notionTemplateId && !existingTemplateMapping) {
        existingTemplateMapping = await publishRecoveredImportedOwnerMapping(
          fileCopyContext,
          mappingsByNotionId,
          {
            notionId: notionTemplateId,
            notionType: 'template',
            localId: existingTemplate.id,
            localType: 'db_template',
            relationKind: 'database_template',
            metadata: { dataSourceId: item.notionId, databaseId },
          },
          {
            table: 'db_templates',
            id: existingTemplate.id,
            where: templateOwnerWhere(existingTemplate),
          },
        );
      }
      if (recoveredWithoutMapping && applyingDataSources) {
        created.templates += 1;
        if (notionTemplateId) created.mappings += 1;
      }
      if (existingTemplate) {
        const fileState = mappedLegacyFileState ?? await existingImportedTemplateFileState(
          fileCopyContext,
          existingTemplate,
          rawTemplate,
          propMap,
        );
        if (fileState === 'complete') {
          importedTemplateContexts.push({
            template: existingTemplate,
            dataSourceId: item.notionId,
            notionId: notionTemplateId,
          });
          continue;
        }
        const copiedExistingTemplate = await copyImportedTemplateFiles(
          fileCopyContext,
          existingTemplate,
          rawTemplate,
          propMap,
          item,
          `data-source:${item.notionId}/templates/${index}`,
        );
        const repairedExistingTemplate = await updateImportedTemplateWithFiles(
          fileCopyContext,
          existingTemplate,
          {
            icon: copiedExistingTemplate.icon,
            properties: copiedExistingTemplate.properties,
            blocks: copiedExistingTemplate.blocks,
            updatedAt: nowIso(),
          },
        );
        importedTemplateContexts.push({
          template: repairedExistingTemplate,
          dataSourceId: item.notionId,
          notionId: notionTemplateId,
        });
        continue;
      }
      // Template ids are allocated before copy so every upload gets an
      // independent templateId/databaseId association, but the template row
      // itself is committed only after icon, file properties, and all nested
      // file blocks have been copied and verified.
      const copiedTemplate = await copyImportedTemplateFiles(
        fileCopyContext,
        sourceTemplate,
        rawTemplate,
        propMap,
        item,
        `data-source:${item.notionId}/templates/${index}`,
      );
      const inserted = await insertImportedTemplateWithFiles(
        fileCopyContext,
        copiedTemplate,
        notionTemplateId
          ? {
              mappingsByNotionId,
              input: {
                notionId: notionTemplateId,
                notionType: 'template',
                localType: 'db_template',
                relationKind: 'database_template',
                metadata: { dataSourceId: item.notionId, databaseId },
              },
            }
          : undefined,
        templateUniqueWhere,
      );
      importedTemplateContexts.push({
        template: inserted,
        dataSourceId: item.notionId,
        notionId: notionTemplateId,
      });
      created.templates += 1;
      if (notionTemplateId) {
        created.mappings += 1;
      }
    }
  }

  if (applyingDataSources) {
    const dataSourceIndex = Math.min(
      dataSourceItems.length,
      resumeDataSourceIndex + dataSourceItemsForRun.length,
    );
    if (dataSourceIndex < dataSourceItems.length) {
      await updateApplyProgress('apply_data_sources', {
        totalDataSources: dataSourceItems.length,
        dataSourceIndex,
        dataSourceBatchSize: applyDataSourceBatchSize,
        paused: true,
      });
      return partialApplyResult();
    }
    // Bounded callers yield at the phase boundary. This keeps the final
    // data-source batch small and lets the next request hydrate only the
    // sources needed by its database/page delta. Legacy one-shot callers keep
    // the original single-request behavior when no batch option was supplied.
    await updateApplyProgress('apply_database_containers', {
      totalDataSources: dataSourceItems.length,
      totalDatabases: items.filter((candidate) => candidate.notionObject === 'database').length,
      databasePass: 'direct',
      databaseIndex: 0,
      databaseBatchSize: applyDatabaseBatchSize,
    });
    if (existingApplyPhase === 'apply_data_sources' || applyDataSourceBatchSize > 0) {
      return partialApplyResult();
    }
  }

  if (existingApplyPhase === 'apply_database_containers') {
    await updateApplyProgress('apply_database_containers', {
      totalDataSources: dataSourceItems.length,
    });
  }

  const databaseItems = stableItems.filter((candidate) => candidate.notionObject === 'database');
  const applyingDatabaseContainers = !existingApplyPhase || existingApplyPhase === 'apply_database_containers';
  if (applyingDatabaseContainers) {
  let databaseItemsTouchedThisRun = 0;
  let databaseIndex = 0;
  if (resumeDatabasePass !== 'placeholder') {
    for (const item of databaseItems) {
      databaseIndex += 1;
      if (resumeDatabasePass === 'direct' && databaseIndex <= resumeDatabaseIndex) continue;
      const metadata = itemMetadata(item);
      const dataSources = Array.isArray(metadata.dataSources) ? metadata.dataSources : [];
      const firstDataSourceId = dataSources
        .map((source) => source && typeof source === 'object' ? notionObjectId(source as Record<string, unknown>) : undefined)
        .find((id): id is string => !!id && !!mappingsByNotionId.get(id));
      const dataSourceMapping = firstDataSourceId ? mappingsByNotionId.get(firstDataSourceId) : undefined;
      if (dataSourceMapping && firstDataSourceId) {
        const localDatabase = await getExisting(db.table<Page>('pages'), dataSourceMapping.localId);
        if (!localDatabase) {
          throw Object.assign(new Error('Notion database alias canonical owner was missing.'), { code: 409 });
        }
        const published = await publishImportedDatabaseAliasMapping(fileCopyContext, mappingsByNotionId, {
          notionId: item.notionId,
          notionType: 'database',
          localId: dataSourceMapping.localId,
          localType: 'database',
          relationKind: 'database_container',
          metadata: { dataSourceId: firstDataSourceId },
        }, localDatabase, firstDataSourceId, true);
        if (published.created) created.mappings += 1;
      }
      databaseItemsTouchedThisRun += 1;
      if (
        shouldChunkDatabaseContainers &&
        applyDatabaseBatchSize > 0 &&
        databaseItemsTouchedThisRun >= applyDatabaseBatchSize &&
        databaseIndex < databaseItems.length
      ) {
        await updateApplyProgress('apply_database_containers', {
          totalDataSources: dataSourceItems.length,
          totalDatabases: databaseItems.length,
          databasePass: 'direct',
          databaseIndex,
          databaseBatchSize: applyDatabaseBatchSize,
          databasesTouchedThisRun: databaseItemsTouchedThisRun,
          paused: true,
        });
        return partialApplyResult();
      }
    }
  }

  if (shouldChunkDatabaseContainers) {
    await updateApplyProgress('apply_database_containers', {
      totalDataSources: dataSourceItems.length,
      totalDatabases: databaseItems.length,
      databasePass: 'placeholder',
      databaseIndex: resumeDatabasePass === 'placeholder' ? resumeDatabaseIndex : 0,
      databaseBatchSize: applyDatabaseBatchSize,
    });
    if (existingApplyPhase === 'apply_database_containers' && resumeDatabasePass !== 'placeholder') {
      return partialApplyResult();
    }
  }
  databaseIndex = 0;
  for (const item of databaseItems) {
    databaseIndex += 1;
    if (resumeDatabasePass === 'placeholder' && databaseIndex <= resumeDatabaseIndex) continue;
    const existingDatabaseMapping = mappingsByNotionId.get(item.notionId);
    if (existingDatabaseMapping && existingDatabaseMapping.relationKind !== 'database_placeholder') continue;
    const inferredSource = existingDatabaseMapping
      ? undefined
      : inferCanonicalDataSourceForHiddenLinkedDatabase(item, items, dataSourceItems, mappingsByNotionId);
    if (inferredSource) {
      const inferredFrom = inferredSource.inferredFrom ?? 'sibling_heading_view_name';
      const localDatabase = await getExisting(
        db.table<Page>('pages'),
        inferredSource.mapping.localId,
      );
      if (!localDatabase) {
        throw Object.assign(new Error('Inferred Notion database alias canonical owner was missing.'), { code: 409 });
      }
      const published = await publishImportedDatabaseAliasMapping(fileCopyContext, mappingsByNotionId, {
        notionId: item.notionId,
        notionType: 'database',
        localId: inferredSource.mapping.localId,
        localType: 'database',
        relationKind: 'database_container_inferred_from_view_context',
        metadata: {
          dataSourceId: inferredSource.dataSourceItem.notionId,
          inferredFrom,
          heading: inferredSource.heading,
          matchedLabel: inferredSource.matchedLabel,
          ...(inferredSource.matchedViewId ? { selectedViewId: inferredSource.matchedViewId } : {}),
          ...(inferredSource.matchedViewIds?.length ? { viewIds: inferredSource.matchedViewIds } : {}),
          sourceUnavailable: true,
        },
      }, localDatabase, inferredSource.dataSourceItem.notionId);
      if (published.created) created.mappings += 1;
      incrementReport(conversionReport, 'inferredLinkedDatabases');
      const inferredFromText =
        inferredFrom === 'view_parent_database_id'
          ? `Notion view "${inferredSource.matchedViewId || inferredSource.matchedLabel}" parent.database_id`
          : `sibling heading "${inferredSource.heading}" and view label "${inferredSource.matchedLabel}"`;
      pushReportIssue(conversionReport.warnings, {
        code: 'linked_database_source_inferred',
        notionId: item.notionId,
        notionObject: 'database',
        message:
          `Notion database "${item.title || item.notionId}" did not expose data sources, ` +
          `so Hanji linked it to imported data source "${inferredSource.dataSourceItem.title || inferredSource.dataSourceItem.notionId}" ` +
          `from ${inferredFromText}.`,
      });
      databaseItemsTouchedThisRun += 1;
      if (
        shouldChunkDatabaseContainers &&
        applyDatabaseBatchSize > 0 &&
        databaseItemsTouchedThisRun >= applyDatabaseBatchSize &&
        databaseIndex < databaseItems.length
      ) {
        await updateApplyProgress('apply_database_containers', {
          totalDataSources: dataSourceItems.length,
          totalDatabases: databaseItems.length,
          databasePass: 'placeholder',
          databaseIndex,
          databaseBatchSize: applyDatabaseBatchSize,
          databasesTouchedThisRun: databaseItemsTouchedThisRun,
          paused: true,
        });
        return partialApplyResult();
      }
      continue;
    }
    const metadata = itemMetadata(item);
    const database = asRecord(metadata.database);
    const chrome = importedPageChromeFromItem(item);
    const initialChrome = initialImportedPageChrome(chrome);
    const fallbackTitle = hiddenLinkedDatabaseFallbackTitle(item, items, database, locale);
    let page = existingDatabaseMapping
      ? await getExisting(db.table<Page>('pages'), existingDatabaseMapping.localId)
      : await findUnmappedImportedPageOwner('notionDatabaseId', item.notionId, 'database');
    if (existingDatabaseMapping && !page) {
      throw Object.assign(new Error('Notion import placeholder mapping owner was missing.'), { code: 409 });
    }
    if (existingDatabaseMapping) {
      await ensureImportedPageWorkspaceIndexes(admin, [existingDatabaseMapping], job.workspaceId);
    }
    let createdPlaceholderMapping = false;
    if (!page) {
      const pageOwner = basePage({
        workspaceId: job.workspaceId,
        parentId: rootPageId,
        parentType: 'page',
        kind: 'database',
        title: fallbackTitle,
        icon: initialChrome.icon,
        iconType: initialChrome.iconType,
        cover: initialChrome.cover,
        coverPosition: initialChrome.coverPosition,
        position: created.databases + 1,
        actorId,
        ...importedItemTimestamps(item),
        properties: pagePropertiesWithChromeReferences({
          notionImportJobId: job.id,
          notionDatabaseId: item.notionId,
          notionLinkedDatabaseSourceUnavailable: true,
        }, chrome),
      });
      ({ page } = await insertImportedPageWithMapping(
        fileCopyContext,
        mappingsByNotionId,
        pageOwner,
        {
          notionId: item.notionId,
          notionType: 'database',
          localType: 'database',
          relationKind: 'database_placeholder',
          metadata: { title: item.title, sourceUnavailable: true },
        },
      ));
      createdPlaceholderMapping = true;
    } else if (!existingDatabaseMapping) {
      await publishRecoveredImportedOwnerMapping(fileCopyContext, mappingsByNotionId, {
        notionId: item.notionId,
        notionType: 'database',
        localId: page.id,
        localType: 'database',
        relationKind: 'database_placeholder',
        metadata: { title: item.title, sourceUnavailable: true },
      }, {
        table: 'pages',
        id: page.id,
        where: [
          ['workspaceId', '==', job.workspaceId],
          ['kind', '==', 'database'],
          ['notionImportJobId', '==', job.id],
          ['notionImportSourceId', '==', item.notionId],
          ['notionImportSourceKind', '==', 'database'],
        ],
      });
      createdPlaceholderMapping = true;
    }
    page = await copyImportedPageChromeFiles(fileCopyContext, page, item);
    page = await preserveImportedPageTimestamps(fileCopyContext, page, item);
    const existingPlaceholderProperties = await listAll(
      db.table<DbProperty>('db_properties').where('databaseId', '==', page.id),
      1_000,
    );
    const compatibleTitleProperties = existingPlaceholderProperties.filter((property) => (
      property.type === 'title'
      && optionalString(asRecord(property.config)?.notionDatabaseId) === item.notionId
      && asRecord(property.config)?.notionSourceUnavailable === true
    ));
    const durableTitleProperties = existingPlaceholderProperties.filter((property) => (
      property.notionImportJobId === job.id
      && property.notionDataSourceId === item.notionId
      && property.notionPropertyId === GENERATED_NOTION_TITLE_PROPERTY_ID
    ));
    if (durableTitleProperties.length > 1 || compatibleTitleProperties.length > 1) {
      throw Object.assign(new Error('Notion import found duplicate source-unavailable title properties.'), { code: 409 });
    }
    let titleProperty = durableTitleProperties[0] ?? compatibleTitleProperties[0];
    if (titleProperty && !compatibleTitleProperties.includes(titleProperty)) {
      throw Object.assign(new Error('Notion import source-unavailable title property changed before recovery.'), { code: 409 });
    }
    if (titleProperty && !durableTitleProperties.includes(titleProperty)) {
      await claimRecoveredImportedDatabaseChild(
        fileCopyContext,
        'db_properties',
        titleProperty.id,
        [
          ['databaseId', '==', page.id],
          ['name', '==', titleProperty.name],
          ['type', '==', titleProperty.type],
          ['position', '==', titleProperty.position],
          ['updatedAt', '==', titleProperty.updatedAt ?? null],
          ['notionImportJobId', '==', titleProperty.notionImportJobId ?? null],
          ['notionDataSourceId', '==', titleProperty.notionDataSourceId ?? null],
          ['notionPropertyId', '==', titleProperty.notionPropertyId ?? null],
        ],
        {
          notionImportJobId: job.id,
          notionDataSourceId: item.notionId,
          notionPropertyId: GENERATED_NOTION_TITLE_PROPERTY_ID,
        },
      );
      Object.assign(titleProperty, {
        notionImportJobId: job.id,
        notionDataSourceId: item.notionId,
        notionPropertyId: GENERATED_NOTION_TITLE_PROPERTY_ID,
      });
    }
    if (!titleProperty) {
      const titleOwner: DbProperty = {
        id: newId(),
        databaseId: page.id,
        notionImportJobId: job.id,
        notionDataSourceId: item.notionId,
        notionPropertyId: GENERATED_NOTION_TITLE_PROPERTY_ID,
        name: generatedLabels.propertyNames.name,
        type: 'title',
        position: 1,
        config: {
          notionDatabaseId: item.notionId,
          notionSourceUnavailable: true,
        },
      };
      ({ owner: titleProperty } = await insertImportedDatabaseChildWithMapping(
        fileCopyContext,
        mappingsByNotionId,
        'db_properties',
        titleOwner,
        undefined,
        [
          ['databaseId', '==', page.id],
          ['notionImportJobId', '==', job.id],
          ['notionDataSourceId', '==', item.notionId],
          ['notionPropertyId', '==', GENERATED_NOTION_TITLE_PROPERTY_ID],
        ],
      ));
    }
    const existingPlaceholderViews = await listAll(
      db.table<DbView>('db_views').where('databaseId', '==', page.id),
      1_000,
    );
    const placeholderViewSource = {
      name: meaningfulImportedTitle(item.title) || generatedLabels.viewNames.table,
      type: 'table',
      sourceUnavailable: true,
      notionDatabaseId: item.notionId,
    };
    const placeholderViewFingerprint = importedViewFingerprint(placeholderViewSource);
    const compatiblePlaceholderViews = existingPlaceholderViews.filter((view) => {
      const notionSource = asRecord(asRecord(view.config)?.notion);
      return view.type === 'table'
        && notionSource?.sourceUnavailable === true
        && optionalString(notionSource.notionDatabaseId) === item.notionId;
    });
    const durablePlaceholderViews = existingPlaceholderViews.filter((view) => (
      view.notionImportJobId === job.id
      && view.notionDataSourceId === item.notionId
      && view.notionViewId === SOURCE_UNAVAILABLE_PLACEHOLDER_VIEW_ID
    ));
    if (durablePlaceholderViews.length > 1 || compatiblePlaceholderViews.length > 1) {
      throw Object.assign(new Error('Notion import found duplicate source-unavailable database views.'), { code: 409 });
    }
    let placeholderView = durablePlaceholderViews[0] ?? compatiblePlaceholderViews[0];
    if (placeholderView && !compatiblePlaceholderViews.includes(placeholderView)) {
      throw Object.assign(new Error('Notion import source-unavailable database view changed before recovery.'), { code: 409 });
    }
    if (
      placeholderView
      && durablePlaceholderViews.includes(placeholderView)
      && (
        placeholderView.notionViewStructuralIndex !== 0
        || placeholderView.notionImportSnapshotRevision !== itemSnapshotRevision
        || placeholderView.notionViewFingerprint !== placeholderViewFingerprint
      )
    ) {
      throw Object.assign(new Error('Notion import source-unavailable database view provenance changed.'), { code: 409 });
    }
    if (placeholderView && !durablePlaceholderViews.includes(placeholderView)) {
      await claimRecoveredImportedDatabaseChild(
        fileCopyContext,
        'db_views',
        placeholderView.id,
        [
          ['databaseId', '==', page.id],
          ['name', '==', placeholderView.name],
          ['type', '==', placeholderView.type],
          ['position', '==', placeholderView.position],
          ['updatedAt', '==', placeholderView.updatedAt ?? null],
          ['notionImportJobId', '==', placeholderView.notionImportJobId ?? null],
          ['notionDataSourceId', '==', placeholderView.notionDataSourceId ?? null],
          ['notionViewId', '==', placeholderView.notionViewId ?? null],
          ['notionViewStructuralIndex', '==', placeholderView.notionViewStructuralIndex ?? null],
          ['notionImportSnapshotRevision', '==', placeholderView.notionImportSnapshotRevision ?? null],
          ['notionViewFingerprint', '==', placeholderView.notionViewFingerprint ?? null],
        ],
        {
          notionImportJobId: job.id,
          notionDataSourceId: item.notionId,
          notionViewId: SOURCE_UNAVAILABLE_PLACEHOLDER_VIEW_ID,
          notionViewStructuralIndex: 0,
          notionImportSnapshotRevision: itemSnapshotRevision,
          notionViewFingerprint: placeholderViewFingerprint,
        },
      );
      Object.assign(placeholderView, {
        notionImportJobId: job.id,
        notionDataSourceId: item.notionId,
        notionViewId: SOURCE_UNAVAILABLE_PLACEHOLDER_VIEW_ID,
        notionViewStructuralIndex: 0,
        notionImportSnapshotRevision: itemSnapshotRevision,
        notionViewFingerprint: placeholderViewFingerprint,
      });
    }
    if (!placeholderView) {
      const viewOwner: DbView = {
        ...dbViewFromNotion(
          page.id,
          placeholderViewSource,
          0,
          new Map([
            ['Name', titleProperty.id],
            [generatedLabels.propertyNames.name, titleProperty.id],
            ['title', titleProperty.id],
          ]),
          conversionReport,
          item.notionId,
        ),
        notionImportJobId: job.id,
        notionDataSourceId: item.notionId,
        notionViewId: SOURCE_UNAVAILABLE_PLACEHOLDER_VIEW_ID,
        notionViewStructuralIndex: 0,
        notionImportSnapshotRevision: itemSnapshotRevision,
        notionViewFingerprint: placeholderViewFingerprint,
      };
      ({ owner: placeholderView } = await insertImportedDatabaseChildWithMapping(
        fileCopyContext,
        mappingsByNotionId,
        'db_views',
        viewOwner,
        undefined,
        [
          ['databaseId', '==', page.id],
          ['notionImportJobId', '==', job.id],
          ['notionDataSourceId', '==', item.notionId],
          ['notionViewId', '==', SOURCE_UNAVAILABLE_PLACEHOLDER_VIEW_ID],
        ],
      ));
    }
    if (createdPlaceholderMapping) {
      created.databases += 1;
      created.properties += 1;
      created.views += 1;
      created.mappings += 1;
    }
    incrementReport(conversionReport, 'placeholderDatabases');
    pushReportIssue(conversionReport.warnings, {
      code: 'database_source_unavailable',
      notionId: item.notionId,
      notionObject: 'database',
      message:
        `Notion database "${item.title || item.notionId}" did not expose data sources through the API, ` +
        'so Hanji imported a placeholder database instead of leaving the linked database broken.',
    });
    databaseItemsTouchedThisRun += 1;
    if (
      shouldChunkDatabaseContainers &&
      applyDatabaseBatchSize > 0 &&
      databaseItemsTouchedThisRun >= applyDatabaseBatchSize &&
      databaseIndex < databaseItems.length
    ) {
      await updateApplyProgress('apply_database_containers', {
        totalDataSources: dataSourceItems.length,
        totalDatabases: databaseItems.length,
        databasePass: 'placeholder',
        databaseIndex,
        databaseBatchSize: applyDatabaseBatchSize,
        databasesTouchedThisRun: databaseItemsTouchedThisRun,
        paused: true,
      });
      return partialApplyResult();
    }
  }

    await updateApplyProgress('apply_pages', {
      pageIndex: 0,
      totalPages: pageItems.length,
      pageBatchSize: applyPageBatchSize,
    });
    if (existingApplyPhase === 'apply_database_containers' || boundedPagePipelineRequested) {
      return partialApplyResult();
    }
  }

  let pageIndex = 0;
  let pagesTouchedThisRun = 0;
  const applyingPages = !existingApplyPhase || existingApplyPhase === 'apply_pages';
  if (applyingPages) {
  for (const item of pageItems) {
    pageIndex += 1;
    if (pageIndex <= resumePageIndex) continue;
    if (pageIndex > applyingPageWindowEnd) {
      pageIndex = applyingPageWindowEnd;
      break;
    }
    const sourceId = rowDataSourceId(item, dataSourceIds);
    const sourceMapping = sourceId ? mappingsByNotionId.get(sourceId) : undefined;
    const parentMapping = item.parentNotionId ? mappingsByNotionId.get(item.parentNotionId) : undefined;
    const isRow = !!sourceMapping && sourceMapping.localType === 'database';
    const propMap = sourceId ? propertyMappingsByDataSource.get(sourceId) : undefined;
    const metadata = itemMetadata(item);
    const chrome = importedPageChromeFromItem(item);
    const initialChrome = initialImportedPageChrome(chrome);
    const resolvedParent = isRow
      ? {}
      : resolveImportedPageParentFromNotionBlocks(item, mappingsByNotionId, blockOwnerContextsByNotionId);
    let existingPageMapping = mappingsByNotionId.get(item.notionId);
    if (existingPageMapping && existingPageMapping.localType !== 'page') {
      throw Object.assign(
        new Error('Notion import page mapping has an incompatible owner type.'),
        { code: 409 },
      );
    }
    if (!existingPageMapping) {
      let recoveredPage = await findUnmappedImportedPageOwner('notionPageId', item.notionId, 'page');
      if (recoveredPage) {
        recoveredPage = await copyImportedPageChromeFiles(fileCopyContext, recoveredPage, item);
        recoveredPage = await preserveImportedPageTimestamps(fileCopyContext, recoveredPage, item);
        existingPageMapping = await publishRecoveredImportedOwnerMapping(fileCopyContext, mappingsByNotionId, {
          notionId: item.notionId,
          notionType: 'page',
          localId: recoveredPage.id,
          localType: 'page',
          relationKind: isRow ? 'database_row' : 'page',
          metadata: { dataSourceId: sourceId },
        }, {
          table: 'pages',
          id: recoveredPage.id,
          where: [
            ['workspaceId', '==', job.workspaceId],
            ['kind', '==', 'page'],
            ['notionImportJobId', '==', job.id],
            ['notionImportSourceId', '==', item.notionId],
            ['notionImportSourceKind', '==', 'page'],
          ],
        });
        created.mappings += 1;
        if (isRow) created.rows += 1;
        else created.pages += 1;
      }
    }
    if (existingPageMapping?.localType === 'page') {
      let existingPage = await getExisting(db.table<Page>('pages'), existingPageMapping.localId);
      if (!existingPage) {
        throw Object.assign(new Error('Notion import page mapping owner was missing.'), { code: 409 });
      }
      await ensureImportedPageWorkspaceIndexes(admin, [existingPageMapping], job.workspaceId);
      const prepareExistingPage = async (pageToPrepare: Page) => {
        let preparedPage = await copyImportedPageChromeFiles(fileCopyContext, pageToPrepare, item);
        preparedPage = await preserveImportedPageTimestamps(fileCopyContext, preparedPage, item);
        if (!isRow) {
          const movedPage = await moveImportedPageToResolvedParent(
            fileCopyContext,
            preparedPage,
            resolvedParent,
          );
          if (movedPage !== preparedPage) created.repairedPageParents += 1;
          preparedPage = movedPage;
        }
        if (
          isRow &&
          sourceId &&
          propMap &&
          sourceMapping?.localId &&
          importedRowFilePropertiesNeedCopy(preparedPage.properties, metadata.properties, propMap)
        ) {
          preparedPage = await copyImportedRowFileProperties(
            fileCopyContext,
            preparedPage,
            sourceMapping.localId,
            metadata.properties,
            propMap,
            item,
          );
        }
        return preparedPage;
      };
      const hasImportableBody = itemHasImportablePageBody(item);
      if (hasImportableBody && !importedBlocksComplete(existingPage)) {
        const replaced = await replaceImportedBlocksForPage(
          db,
          existingPage,
          item,
          actorId,
          mappingsByNotionId,
          conversionReport,
          fileCopyContext,
          importedBlockMappingsByNotionId,
          itemsByNotionId,
          prepareExistingPage,
        );
        // An interrupted page has not checkpointed its block count yet. Count
        // the exact verified prefix together with the newly published suffix.
        created.blocks += replaced.reusedBlocks + replaced.insertedBlocks.length;
        importedPageBlockContexts.push({ page: replaced.page, notionId: item.notionId });
        if (isRow && sourceId && propMap && sourceMapping?.localId) {
          importedRowContexts.push({ page: replaced.page, dataSourceId: sourceId, notionId: item.notionId });
        }
        pagesTouchedThisRun += 1;
        continue;
      }
      existingPage = await prepareExistingPage(existingPage);
      if (existingPage) {
        if (hasImportableBody && importedBlocksComplete(existingPage)) {
          // Completion can commit immediately before the worker dies while
          // the pageIndex/report checkpoint is still stale. This loop only
          // visits indices beyond the durable cursor, so replay exactly once.
          created.blocks += replayImportedPageBlockMetrics(
            item,
            mappingsByNotionId,
            conversionReport,
            itemsByNotionId,
          );
        }
        importedPageBlockContexts.push({ page: existingPage, notionId: item.notionId });
        if (isRow && sourceId && propMap && sourceMapping?.localId) {
          importedRowContexts.push({ page: existingPage, dataSourceId: sourceId, notionId: item.notionId });
        }
      }
      continue;
    }
    const pageProperties = isRow && propMap
      ? {
          ...rowPropertiesForDataSource(metadata.properties, propMap, {
          report: conversionReport,
          notionId: item.notionId,
          notionObject: 'page',
        }, {
          omitFileValuesNeedingStorage: fileCopyContext.requireStoredFileCopies,
          }),
          notionImportJobId: job.id,
          notionPageId: item.notionId,
          ...(sourceId ? { notionDataSourceId: sourceId } : {}),
        }
      : {
          notionImportJobId: job.id,
          notionPageId: item.notionId,
        };
    const pageOwner = basePage({
        workspaceId: job.workspaceId,
        parentId: isRow
          ? sourceMapping.localId
          : resolvedParent.parentId
            ? resolvedParent.parentId
            : parentMapping?.localType === 'page'
              ? parentMapping.localId
            : rootPageId,
        parentType: isRow ? 'database' : 'page',
        kind: 'page',
        title: isRow ? (item.title ?? '') : (item.title || generatedLabels.untitled),
        icon: initialChrome.icon,
        iconType: initialChrome.iconType,
        cover: initialChrome.cover,
        coverPosition: initialChrome.coverPosition,
        fullWidth: !isRow && importedPageShouldUseFullWidth(item, importPagesFullWidth),
        // Notion's favorite state is not available through the API. Do not
        // invent it: selected roots become ordinary pages after staging unwrap.
        isFavorite: false,
        position: resolvedParent.position ?? created.pages + created.rows + 1,
        actorId,
        ...importedItemTimestamps(item),
        properties: pagePropertiesWithChromeReferences(pageProperties, chrome),
      });
    const stagesImportedBlocks = itemHasImportablePageBody(item);
    let { page } = await insertImportedPageWithMapping(
      fileCopyContext,
      mappingsByNotionId,
      pageOwner,
      {
        notionId: item.notionId,
        notionType: 'page',
        localType: 'page',
        relationKind: isRow ? 'database_row' : 'page',
        metadata: { dataSourceId: sourceId },
      },
      stagesImportedBlocks,
    );
    page = await copyImportedPageChromeFiles(fileCopyContext, page, item);
    created.mappings += 1;
    if (isRow) created.rows += 1;
    else created.pages += 1;
    if (isRow && sourceId && propMap && sourceMapping?.localId) {
      page = await copyImportedRowFileProperties(fileCopyContext, page, sourceMapping.localId, metadata.properties, propMap, item);
    }
    page = await preserveImportedPageTimestamps(fileCopyContext, page, item);
    const previousRecoveryPage = fileCopyContext.blockRecoveryPage;
    if (stagesImportedBlocks) fileCopyContext.blockRecoveryPage = page;
    try {
      const insertedBlocks = await insertPageBlocksFromSnapshot(
        db,
        page.id,
        item,
        actorId,
        mappingsByNotionId,
        conversionReport,
        fileCopyContext,
        importedBlockMappingsByNotionId,
        itemsByNotionId,
      );
      created.blocks += insertedBlocks.length;
      page = await markImportedBlocksComplete(db, page, fileCopyContext);
    } finally {
      fileCopyContext.blockRecoveryPage = previousRecoveryPage;
    }
    // Later relation remapping writes the complete page-properties object.
    // Register the page only after the durable completion markers are present,
    // otherwise a row remap can overwrite them with this pre-import snapshot
    // and make a subsequent repair incorrectly refuse its existing blocks.
    importedPageBlockContexts.push({ page, notionId: item.notionId });
    if (isRow && sourceId && propMap && sourceMapping?.localId) {
      importedRowContexts.push({ page, dataSourceId: sourceId, notionId: item.notionId });
    }
    pagesTouchedThisRun += 1;
    // Time-based cadence (~1s) so the UI's live feed moves like an installer
    // even when individual pages are slow; %50 keeps a floor on huge fast runs.
    if (pageIndex % 50 === 0 || Date.now() - lastApplyProgressWriteMs >= 1_000) {
      lastApplyProgressWriteMs = Date.now();
      await updateApplyProgress('apply_pages', {
        pageIndex,
        totalPages: pageItems.length,
      }, {
        kind: isRow ? 'create_row' : 'create_page',
        title: item.title || undefined,
        count: pageIndex,
        total: pageItems.length,
      });
    }
  }
  if (applyingPageWindowEnd < pageItems.length) {
    await updateApplyProgress('apply_pages', {
      pageIndex: applyingPageWindowEnd,
      totalPages: pageItems.length,
      pageBatchSize: applyPageBatchSize,
      pagesTouchedThisRun,
      paused: true,
    });
    return partialApplyResult();
  }
  if (boundedPagePipelineRequested || existingApplyPhase === 'apply_pages') {
    await updateApplyProgress('apply_remap', {
      pageIndex: pageItems.length,
      totalPages: pageItems.length,
      remapIndex: 0,
      remapBatchSize: applyRemapBatchSize,
    }, {
      kind: 'remap_relations',
      count: pageItems.length,
    });
    return partialApplyResult();
  }
  }

  const remapPageItems = existingApplyPhase === 'apply_global_remap'
    ? []
    : existingApplyPhase === 'apply_remap'
      ? activePageWindow
      : pageItems;
  if (existingApplyPhase === 'apply_global_remap') {
    await updateApplyProgress('apply_global_remap', {
      pageIndex: pageItems.length,
      totalPages: pageItems.length,
      dataSourceIndex: resumeGlobalDataSourceIndex,
      totalDataSources: dataSourceItems.length,
      dataSourceBatchSize: applyDataSourceBatchSize,
    });
  } else if (existingApplyPhase === 'apply_remap') {
    await updateApplyProgress('apply_remap', {
      pageIndex: pageItems.length,
      totalPages: pageItems.length,
      remapIndex: resumeRemapIndex,
      remapBatchSize: applyRemapBatchSize,
    });
    // The page-creation request no longer has to revisit its completed prefix.
    // Rehydrate only this bounded remap window from durable mappings.
    for (const item of remapPageItems) {
      const pageMapping = mappingsByNotionId.get(item.notionId);
      if (pageMapping?.localType !== 'page') continue;
      const page = await getExisting(db.table<Page>('pages'), pageMapping.localId);
      if (!page) continue;
      importedPageBlockContexts.push({ page, notionId: item.notionId });
      const sourceId = rowDataSourceId(item, dataSourceIds);
      const sourceMapping = sourceId ? mappingsByNotionId.get(sourceId) : undefined;
      if (sourceId && sourceMapping?.localType === 'database') {
        importedRowContexts.push({ page, dataSourceId: sourceId, notionId: item.notionId });
      }
    }
  } else {
    await updateApplyProgress('apply_remap', {
      pageIndex,
      totalPages: pageItems.length,
    }, {
      kind: 'remap_relations',
      count: pageItems.length,
    });
  }

  for (const item of remapPageItems) {
    const sourceId = rowDataSourceId(item, dataSourceIds);
    const sourceMapping = sourceId ? mappingsByNotionId.get(sourceId) : undefined;
    if (sourceMapping?.localType === 'database') continue;
    const pageMapping = mappingsByNotionId.get(item.notionId);
    if (pageMapping?.localType !== 'page') continue;
    const page = await getExisting(db.table<Page>('pages'), pageMapping.localId);
    if (!page) continue;
    const resolvedParent = resolveImportedPageParentFromNotionBlocks(item, mappingsByNotionId, blockOwnerContextsByNotionId);
    const movedPage = await moveImportedPageToResolvedParent(fileCopyContext, page, resolvedParent);
    if (movedPage !== page) created.repairedPageParents += 1;
  }

  await remapImportedPageBlockRichTextMentions(
    fileCopyContext,
    importedPageBlockContexts,
    mappingsByNotionId,
    conversionReport,
  );

  const pageLinkRemap = await remapImportedPageLinkBlocks(
    fileCopyContext,
    importedPageBlockContexts,
    mappingsByNotionId,
    conversionReport,
  );
  // `mappedBlocks` is derived from immutable Notion target ids retained on
  // the block. It therefore replays after a committed patch response is lost;
  // `updatedBlocks` only describes writes performed by this invocation.
  created.remappedLinkBlocks += pageLinkRemap.mappedBlocks;
  created.unresolvedImportReferences += pageLinkRemap.unresolvedTargets;

  const localPageMappingsByNormalizedNotionId = new Map(
    stableMappings()
      .filter((mapping) => mapping.localType === 'page')
      .map((mapping) => [normalizedNotionId(mapping.notionId), mapping] as const)
      .filter(([notionId]) => !!notionId),
  );
  const scannedSyncedSourcePages = new Map<string, Promise<void>>();
  const resolveImportedSyncedBlockSource = async (sourceNotionId: string) => {
    const normalizedSourceId = normalizedNotionId(sourceNotionId);
    const alreadyMapped = importedBlockMappingsByNotionId.get(sourceNotionId) ??
      importedBlockMappingsByNotionId.get(normalizedSourceId);
    if (alreadyMapped) return alreadyMapped;
    const owner = blockOwnerContextsByNotionId.get(normalizedSourceId);
    const ownerPageMapping = owner
      ? localPageMappingsByNormalizedNotionId.get(normalizedNotionId(owner.pageNotionId))
      : undefined;
    if (!ownerPageMapping) return undefined;
    let scan = scannedSyncedSourcePages.get(ownerPageMapping.localId);
    if (!scan) {
      scan = (async () => {
        const blocks = await listAll(
          db.table<Block>('blocks').where('pageId', '==', ownerPageMapping.localId),
          NOTION_BLOCK_CHILD_TOTAL_LIMIT,
        );
        for (const block of blocks) {
          const content = asRecord(block.content);
          const rawNotionBlock = asRecord(content?.notionBlock);
          const notionBlockId = optionalString(content?.notionBlockId) ??
            (rawNotionBlock ? notionObjectId(rawNotionBlock) : undefined);
          if (!notionBlockId) continue;
          const mapping = { localId: block.id, pageId: block.pageId };
          importedBlockMappingsByNotionId.set(notionBlockId, mapping);
          const normalizedBlockId = normalizedNotionId(notionBlockId);
          if (normalizedBlockId) importedBlockMappingsByNotionId.set(normalizedBlockId, mapping);
        }
      })();
      scannedSyncedSourcePages.set(ownerPageMapping.localId, scan);
    }
    await scan;
    return importedBlockMappingsByNotionId.get(sourceNotionId) ??
      importedBlockMappingsByNotionId.get(normalizedSourceId);
  };

  await remapImportedSyncedBlocks(
    fileCopyContext,
    importedPageBlockContexts,
    importedBlockMappingsByNotionId,
    conversionReport,
    resolveImportedSyncedBlockSource,
  );

  const runsGlobalRemap = !existingApplyPhase || existingApplyPhase === 'apply_global_remap';
  if (runsGlobalRemap) {
    const propertyRemap = await remapImportedDatabaseProperties(
      fileCopyContext,
      importedPropertyContexts,
      propertyMappingsByDataSource,
      mappingsByNotionId,
      conversionReport,
    );
    created.remappedProperties += propertyRemap.remapped;
    created.unresolvedImportReferences += propertyRemap.unresolved;
    if (propertyRemap.unresolved > 0) {
      incrementReport(conversionReport, 'unresolvedPropertyReferences', propertyRemap.unresolved);
      pushReportIssue(conversionReport.unresolvedReferences, {
        code: 'property_reference_unresolved',
        notionObject: 'property',
        message: `${propertyRemap.unresolved} relation, rollup, or formula property reference(s) could not be mapped to local IDs.`,
      });
    }

    const viewRelationFilterRemap = await remapImportedDatabaseViewRelationFilters(
      fileCopyContext,
      existingApplyPhase === 'apply_global_remap' ? dataSourceItemsForRun : dataSourceItems,
      propertyRecordsByDataSource,
      mappingsByNotionId,
      conversionReport,
    );
    created.remappedViewRelationFilters += viewRelationFilterRemap.updatedViews;
    created.unresolvedImportReferences += viewRelationFilterRemap.unresolved;
  }

  for (const rowContext of importedRowContexts) {
    const relationProps = (propertyRecordsByDataSource.get(rowContext.dataSourceId) ?? [])
      .filter((prop) => prop.type === 'relation');
    if (relationProps.length === 0) continue;
    const rawNotionProperties = asRecord(rowContext.page.properties?.__notion);
    const observationPropertyMappings = new Map<string, string>();
    for (const prop of relationProps) {
      for (const key of [
        prop.notionPropertyId,
        optionalString(asRecord(prop.config)?.notionPropertyId),
        prop.name,
        prop.id,
      ]) {
        if (key) observationPropertyMappings.set(key, prop.id);
      }
    }
    const observationPage = rawNotionProperties
      ? {
          ...rowContext.page,
          properties: rowPropertiesForDataSource(rawNotionProperties, observationPropertyMappings),
        }
      : rowContext.page;
    // Product properties may already contain local IDs after a successful
    // commit whose response was lost. Recompute the logical observation from
    // the immutable `__notion` property snapshot, separately from deciding
    // whether this invocation still needs a patch.
    const observedProperties = remapImportedRowRelationProperties(
      observationPage,
      relationProps,
      mappingsByNotionId,
    );
    const properties = remapImportedRowRelationProperties(rowContext.page, relationProps, mappingsByNotionId);
    if (properties) {
      rowContext.page = await transactImportedOwnerPatch(fileCopyContext, {
        table: 'pages',
        owner: rowContext.page,
        patch: { properties },
        requiredWhere: [
          ['workspaceId', '==', job.workspaceId],
          ['parentType', '==', 'database'],
          ['notionImportJobId', '==', job.id],
          ['notionImportSourceId', '==', rowContext.notionId],
          ['notionImportSourceKind', '==', 'page'],
        ],
        label: 'database row relation remap',
      });
    }
    if (!observedProperties) continue;
    created.remappedRowRelations += 1;
    const unresolved = observedProperties.__notionRelationUnresolved;
    if (unresolved && typeof unresolved === 'object') {
      const unresolvedCount = Object.values(unresolved as Record<string, unknown>)
        .reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
      created.unresolvedImportReferences += unresolvedCount;
      if (unresolvedCount > 0) {
        incrementReport(conversionReport, 'unresolvedRowRelationValues', unresolvedCount);
        pushReportIssue(conversionReport.unresolvedReferences, {
          code: 'row_relation_values_unresolved',
          notionId: rowContext.notionId,
          notionObject: 'page',
          message: `${unresolvedCount} relation value(s) on "${rowContext.page.title || rowContext.notionId}" could not be mapped to local row pages.`,
        });
      }
    }
  }

  const linkedDatabaseContextFilterRemap = (
    !existingApplyPhase || existingApplyPhase === 'apply_remap'
  )
    ? await addImportedLinkedDatabaseRowContextFilters(
        fileCopyContext,
        importedPageBlockContexts,
        conversionReport,
      )
    : { updatedViews: 0 };
  created.remappedLinkedDatabaseContextFilters += linkedDatabaseContextFilterRemap.updatedViews;

  if (existingApplyPhase === 'apply_remap') {
    if (remapWindowEnd < pageItems.length) {
      await updateApplyProgress('apply_remap', {
        pageIndex: pageItems.length,
        totalPages: pageItems.length,
        remapIndex: remapWindowEnd,
        remapBatchSize: applyRemapBatchSize,
        paused: true,
      });
      return partialApplyResult();
    }
    await updateApplyProgress('apply_global_remap', {
      pageIndex: pageItems.length,
      totalPages: pageItems.length,
      dataSourceIndex: 0,
      totalDataSources: dataSourceItems.length,
      dataSourceBatchSize: applyDataSourceBatchSize,
    });
    return partialApplyResult();
  }

  if (runsGlobalRemap) {
  for (const templateContext of importedTemplateContexts) {
    const templateOwner = templateContext.template;
    const relationProps = (propertyRecordsByDataSource.get(templateContext.dataSourceId) ?? [])
      .filter((prop) => prop.type === 'relation');
    const patch: Partial<DbTemplate> = {};
    const relationRemap = relationProps.length > 0
      ? remapImportedTemplateRelationProperties(templateOwner, relationProps, mappingsByNotionId)
      : { properties: undefined, unresolved: {} };
    const properties = relationRemap.properties;
    if (properties) {
      patch.properties = properties;
      created.remappedTemplateRelations += 1;
      const unresolved = relationRemap.unresolved;
      if (unresolved && typeof unresolved === 'object') {
        const unresolvedCount = Object.values(unresolved as Record<string, unknown>)
          .reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
        created.unresolvedImportReferences += unresolvedCount;
        if (unresolvedCount > 0) {
          incrementReport(conversionReport, 'unresolvedTemplateRelationValues', unresolvedCount);
          pushReportIssue(conversionReport.unresolvedReferences, {
            code: 'template_relation_values_unresolved',
            notionId: templateContext.notionId,
            notionObject: 'template',
            message: `${unresolvedCount} relation default value(s) on imported template "${templateOwner.name || templateOwner.id}" could not be mapped to local row pages.`,
          });
        }
      }
    }

    let templateBlocks = templateOwner.blocks;
    const blockMentionRemap = remapImportedTemplateBlocksRichTextMentions(templateBlocks, mappingsByNotionId);
    if (blockMentionRemap.changed) {
      templateBlocks = blockMentionRemap.blocks;
    }
    reportRichTextMentionRemap(
      conversionReport,
      templateContext.notionId,
      'template',
      `template "${templateOwner.name || templateOwner.id}"`,
      blockMentionRemap,
    );

    const linkedBlockRemap = await remapImportedTemplateLinkedDatabaseBlocks(
      fileCopyContext,
      {
        ...templateContext,
        template: { ...templateOwner, blocks: templateBlocks },
      },
      mappingsByNotionId,
    );
    if (linkedBlockRemap.changed) {
      templateBlocks = linkedBlockRemap.blocks;
    }
    if (templateBlocks !== templateOwner.blocks || blockMentionRemap.changed || linkedBlockRemap.changed) {
      patch.blocks = templateBlocks;
    }

    if (Object.keys(patch).length === 0) continue;
    templateContext.template = await transactImportedOwnerPatch(fileCopyContext, {
      table: 'db_templates',
      owner: templateOwner,
      patch,
      requiredWhere: [
        ['databaseId', '==', templateOwner.databaseId],
        ['notionImportJobId', '==', job.id],
        ['notionTemplateId', '==', templateOwner.notionTemplateId ?? null],
        ['notionDataSourceId', '==', templateContext.dataSourceId],
      ],
      extraExpectations: [{
        table: 'pages', op: 'expect', id: templateOwner.databaseId,
        where: [
          ['workspaceId', '==', job.workspaceId],
          ['kind', '==', 'database'],
          ['notionImportJobId', '==', job.id],
          ['notionImportSourceId', '==', templateContext.dataSourceId],
          ['notionImportSourceKind', '==', 'data_source'],
        ],
        exists: true,
      }],
      label: 'database template remap',
    });
  }
  }

  if (existingApplyPhase === 'apply_global_remap') {
    const dataSourceIndex = Math.min(
      dataSourceItems.length,
      resumeGlobalDataSourceIndex + dataSourceItemsForRun.length,
    );
    if (dataSourceIndex < dataSourceItems.length) {
      await updateApplyProgress('apply_global_remap', {
        pageIndex: pageItems.length,
        totalPages: pageItems.length,
        dataSourceIndex,
        totalDataSources: dataSourceItems.length,
        dataSourceBatchSize: applyDataSourceBatchSize,
        paused: true,
      });
      return partialApplyResult();
    }
    await updateApplyProgress('apply_scrub', {
      itemIndex: 0,
      totalItems: items.length,
      itemBatchSize: applyScrubBatchSize,
    });
    return partialApplyResult();
  }

  // Legacy unbounded callers retain one-shot semantics. Product callers enter
  // the durable apply_scrub/apply_finalize_indexes phases above instead.
  await scrubAppliedImportCredentialMetadata(db, stableItems);
  await ensureImportedPageWorkspaceIndexes(
    admin,
    stableMappings(),
    job.workspaceId,
  );
  return await publishCompletedApply();
}
