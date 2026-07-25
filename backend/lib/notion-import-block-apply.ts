import { notionIsoTimestamp } from './notion-api-client';
import { normalizedNotionId, type DiscoveredNotionItem } from './notion-import-request-limits';
import { sanitizeNotionCredentialMetadata } from './notion-import-metadata';
import { withFileWorkspaceLease } from './file-operation-lock';
import {
  bestEffort,
  getExisting,
  newId,
  nowIso,
  type TableQuery,
  type TransactOperation,
} from './table-utils';
import {
  ensurePageWorkspaceIndex,
  MAX_RAW_TRANSACT_OPS,
  type AdminDbAccessor,
} from './workspace-db';
import type {
  Block,
  DbRef,
  DbView,
  FileUpload,
  ImportedBlockMapping,
  NotionFileCopyContext,
  NotionFileCopyTarget,
  NotionFileReference,
  Page,
  TemplateBlock,
} from './notion-import-apply';
import type {
  ImportConversionReport,
  NotionImportItem,
  NotionImportJob,
  NotionImportMapping,
} from './notion-import-contracts';

interface NotionImportApplyLock {
  id: string;
  workspaceId: string;
  jobId: string;
  leaseId: string;
  actorId: string;
  purpose?: 'apply' | 'discover';
  expiresAt: string;
  createdAt?: string;
  updatedAt?: string;
}

type ImportedPatchOwnerTable =
  | 'pages'
  | 'blocks'
  | 'db_properties'
  | 'db_views'
  | 'db_templates';

interface ImportedTextSpan {
  text: string;
}

export interface NotionImportBlockApplyRuntime {
  NOTION_BLOCK_CHILD_TOTAL_LIMIT: number;
  NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION: number;
  NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION_KEY: string;
  NOTION_IMPORT_BLOCK_RECOVERY_KEY: string;
  NOTION_IMPORT_BLOCKS_COMPLETE_KEY: string;
  NOTION_PAGE_COVER_REFERENCE_KEY: string;
  NOTION_PAGE_ICON_REFERENCE_KEY: string;
  asRecord(value: unknown): Record<string, unknown> | undefined;
  assertImportedBlockFileTransactionCapacity(fileCount: number): void;
  contentWithStoredNotionFile(
    content: Record<string, unknown> | undefined,
    copied: NotionFileReference,
  ): Record<string, unknown>;
  copyImportedEmbeddedTemplateBlockFiles(
    context: NotionFileCopyContext,
    rawBlocks: Record<string, unknown>[],
    localBlocks: TemplateBlock[],
    target: Pick<
      NotionFileCopyTarget,
      'pageId' | 'blockId' | 'databaseId' | 'templateId' | 'notionPageId'
    > & {
      notionId: string;
      notionObject: string;
      label: string;
    },
    deferredBlockUploadIds?: string[],
    structuralPath?: string,
    fileRole?: string,
  ): Promise<TemplateBlock[]>;
  copyNotionFileReference(
    context: NotionFileCopyContext,
    target: NotionFileCopyTarget,
    reference: NotionFileReference,
    precomputedSlotKey?: string,
  ): Promise<NotionFileReference>;
  countImportedEmbeddedTemplateBlockFiles(
    rawBlocks: Record<string, unknown>[],
    localBlocks: TemplateBlock[],
    label: string,
  ): number;
  databaseViewMatchingImportedSection(
    views: DbView[],
    heading: string | undefined,
  ): DbView | undefined;
  fileCopyScopeForBlockType(type: string): NotionFileCopyTarget['scope'];
  fileReferenceFromNotionBlock(
    block: Record<string, unknown>,
  ): NotionFileReference | undefined;
  flattenImportablePageBlocksForPlan(
    blocks: Record<string, unknown>[],
  ): Record<string, unknown>[];
  importedDatabaseMappingSourceUnavailable(
    mapping: NotionImportMapping | undefined,
  ): boolean;
  importedNotionDatabaseIsInline(
    item: NotionImportItem | undefined,
  ): boolean | undefined;
  importedPatchOwnerSnapshotMatches(
    expected: { id: string },
    current: { id: string } | null | undefined,
    table: ImportedPatchOwnerTable,
  ): boolean;
  importedPatchOwnerTransactionWhere(
    owner: { id: string },
    table: ImportedPatchOwnerTable,
  ): Array<[string, '==', unknown]>;
  importRootNotionId(jobId: string): string;
  inferredLinkedDatabaseViewMapping(
    mapping: NotionImportMapping | undefined,
    mappingsByNotionId: Map<string, NotionImportMapping>,
  ): NotionImportMapping | undefined;
  isApplyLeaseConflict(error: unknown): boolean;
  isRetryableNotionTemplateCleanupError(error: unknown): boolean;
  jsonEquivalent(a: unknown, b: unknown): boolean;
  linkedDatabaseHeadingMatchesLabel(heading: string, label: string): boolean;
  linkedNotionTargetIdsFromBlock(block: Record<string, unknown>): string[];
  linkedNotionViewIdsFromBlock(block: Record<string, unknown>): string[];
  listAll<T>(query: TableQuery<T>, maxItems?: number): Promise<T[]>;
  localBlockFromNotion(
    block: Record<string, unknown>,
    pageId: string,
    actorId: string,
    position: number,
  ): Block;
  mappedLocalDatabaseViewIds(
    notionViewIds: string[],
    mappingsByNotionId: Map<string, NotionImportMapping>,
  ): string[];
  nestedNotionBlockIds(blocks: Record<string, unknown>[]): Set<string>;
  normalizeFileName(value: unknown): string;
  notionBlockChildren(
    block: Record<string, unknown>,
  ): Record<string, unknown>[];
  notionBlockHeadingText(block: Record<string, unknown>): string;
  notionImportMappingExpectation(
    mapping: NotionImportMapping,
  ): TransactOperation;
  notionImportMappingSnapshotMatches(
    expected: NotionImportMapping,
    current: NotionImportMapping | null | undefined,
  ): boolean;
  notionObjectId(record: Record<string, unknown>): string | undefined;
  optionalString(value: unknown): string | undefined;
  pageSnapshot(
    item: NotionImportItem | DiscoveredNotionItem,
  ): Record<string, unknown> | undefined;
  preserveImportedBlockTimestamps(
    db: DbRef,
    block: Block,
    rawBlock: Record<string, unknown>,
  ): Promise<Block>;
  remapImportedRichTextMentionsInContent(
    content: Record<string, unknown> | undefined,
    mappingsByNotionId: Map<string, NotionImportMapping>,
  ): {
    content: Record<string, unknown> | undefined;
    changed: boolean;
    remapped: number;
    observedRemapped: number;
    unresolved: string[];
  };
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
  renewNotionApplyLease(
    db: DbRef,
    lease: { id: string; leaseId: string },
    purpose?: 'apply' | 'discover',
  ): Promise<void>;
  reportBlockConversion(
    report: ImportConversionReport | undefined,
    block: Record<string, unknown>,
    item: NotionImportItem,
  ): void;
  reportBlockFileReference(
    report: ImportConversionReport | undefined,
    item: NotionImportItem,
    block: Record<string, unknown>,
  ): void;
  reportBlockRichTextUserReferences(
    report: ImportConversionReport | undefined,
    item: NotionImportItem,
    block: Record<string, unknown>,
  ): void;
  reportImportedBlockLinkedViewResolutionFromRaw(
    report: ImportConversionReport | undefined,
    item: NotionImportItem,
    rawBlock: Record<string, unknown>,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    itemsByNotionId?: Map<string, NotionImportItem>,
  ): void;
  reportImportedPageMarkdownFallback(
    report: ImportConversionReport | undefined,
    item: NotionImportItem,
    markdownValue: unknown,
  ): void;
  rich(text: string): ImportedTextSpan[];
  storedNotionFileReference(
    value: unknown,
  ): NotionFileReference | undefined;
  tabBlockChildrenForImport(
    block: Record<string, unknown>,
    report: ImportConversionReport | undefined,
    item: NotionImportItem,
  ): Record<string, unknown>[];
  templateBlockChildren(
    block: Record<string, unknown>,
  ): Record<string, unknown>[];
  withNativeHanjiLinkedDatabaseFields(
    content: Record<string, unknown> | undefined,
    mapping: {
      localTargetId?: string;
      localTargetType?: string;
      localViewId?: string;
      localViewIds?: string[];
      linkedDatabaseSource?: boolean;
    },
  ): Record<string, unknown>;
}

export function createNotionImportBlockApplyRuntime(
  runtime: NotionImportBlockApplyRuntime,
) {
  const {
    NOTION_BLOCK_CHILD_TOTAL_LIMIT,
    NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION,
    NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION_KEY,
    NOTION_IMPORT_BLOCK_RECOVERY_KEY,
    NOTION_IMPORT_BLOCKS_COMPLETE_KEY,
    NOTION_PAGE_COVER_REFERENCE_KEY,
    NOTION_PAGE_ICON_REFERENCE_KEY,
    asRecord,
    assertImportedBlockFileTransactionCapacity,
    contentWithStoredNotionFile,
    copyImportedEmbeddedTemplateBlockFiles,
    copyNotionFileReference,
    countImportedEmbeddedTemplateBlockFiles,
    databaseViewMatchingImportedSection,
    fileCopyScopeForBlockType,
    fileReferenceFromNotionBlock,
    flattenImportablePageBlocksForPlan,
    importedDatabaseMappingSourceUnavailable,
    importedNotionDatabaseIsInline,
    importedPatchOwnerSnapshotMatches,
    importedPatchOwnerTransactionWhere,
    importRootNotionId,
    inferredLinkedDatabaseViewMapping,
    isApplyLeaseConflict,
    isRetryableNotionTemplateCleanupError,
    jsonEquivalent,
    linkedDatabaseHeadingMatchesLabel,
    linkedNotionTargetIdsFromBlock,
    linkedNotionViewIdsFromBlock,
    listAll,
    localBlockFromNotion,
    mappedLocalDatabaseViewIds,
    nestedNotionBlockIds,
    normalizeFileName,
    notionBlockChildren,
    notionBlockHeadingText,
    notionImportMappingExpectation,
    notionImportMappingSnapshotMatches,
    notionObjectId,
    optionalString,
    pageSnapshot,
    preserveImportedBlockTimestamps,
    remapImportedRichTextMentionsInContent,
    remapImportedTemplateBlocksRichTextMentions,
    renewNotionApplyLease,
    reportBlockConversion,
    reportBlockFileReference,
    reportBlockRichTextUserReferences,
    reportImportedBlockLinkedViewResolutionFromRaw,
    reportImportedPageMarkdownFallback,
    rich,
    storedNotionFileReference,
    tabBlockChildrenForImport,
    templateBlockChildren,
    withNativeHanjiLinkedDatabaseFields,
  } = runtime;

  async function transactImportedFileOwner(
    context: NotionFileCopyContext,
    ownerOperation: TransactOperation,
    rawUploadIds: string[],
    ownerOverrides: Partial<Pick<FileUpload, 'pageId' | 'blockId' | 'databaseId' | 'propertyId' | 'templateId'>> = {},
    companionOperations: TransactOperation[] = [],
    preOwnerOperations: TransactOperation[] = [],
  ) {
    const uploadIds = Array.from(new Set(rawUploadIds));
    const recoveryPageOperations: TransactOperation[] = context.blockRecoveryPage
      ? [importedPageBlockRecoveryPageExpectation(context.blockRecoveryPage)]
      : [];
    const fenceOperationCount = context.applyLease && context.itemSnapshotRevision ? 2 : 0;
    if (uploadIds.length === 0) {
      const operations: TransactOperation[] = [];
      if (context.applyLease && context.itemSnapshotRevision) {
        operations.push(
          {
            table: 'notion_import_jobs', op: 'expect', id: context.job.id,
            where: [['status', '==', context.job.status], ['itemSnapshotRevision', '==', context.itemSnapshotRevision]],
            exists: true,
          },
          {
            table: 'notion_import_apply_locks', op: 'expect', id: context.applyLease.id,
            where: [['leaseId', '==', context.applyLease.leaseId], ['purpose', '==', 'apply']],
            exists: true,
          },
        );
      }
      operations.push(
        ...recoveryPageOperations,
        ...preOwnerOperations,
        ownerOperation,
        ...companionOperations,
      );
      if (context.blockRecoveryPage) {
        await transactImportedPageBlockRecovery(
          context.db,
          operations,
          context.blockRecoveryPage,
          context,
          'block publication',
        );
      } else {
        await context.db.transact(operations);
      }
      return;
    }
    if (
      uploadIds.length * 2 + 1 + companionOperations.length + preOwnerOperations.length + fenceOperationCount
        + recoveryPageOperations.length
      > MAX_RAW_TRANSACT_OPS
    ) {
      throw Object.assign(new Error('Imported owner contains too many stored files.'), { code: 413 });
    }
    await withFileWorkspaceLease(
      context.db,
      context.job.workspaceId,
      context.actorId,
      'notion-import-file-owner-commit',
      async (lease) => {
        await lease.assertOwned();
        const uploads = context.db.table<FileUpload>('file_uploads');
        const rows: Array<{ upload: FileUpload; target: NotionFileCopyTarget }> = [];
        for (const uploadId of uploadIds) {
          const upload = await getExisting(uploads, uploadId);
          const target = context.pendingCheckpointTargets?.get(uploadId);
          if (!upload || !target || upload.workspaceId !== context.job.workspaceId || upload.status !== 'uploaded') {
            throw Object.assign(new Error('Imported file checkpoint changed before owner commit.'), { code: 409 });
          }
          const expected = {
            pageId: ownerOverrides.pageId ?? target.pageId,
            blockId: ownerOverrides.blockId ?? target.blockId,
            databaseId: ownerOverrides.databaseId ?? target.databaseId,
            propertyId: ownerOverrides.propertyId ?? target.propertyId,
            templateId: ownerOverrides.templateId ?? target.templateId,
          };
          for (const key of ['pageId', 'blockId', 'databaseId', 'propertyId', 'templateId'] as const) {
            // Every upload has one exact product-owner tuple. An association in
            // a field the new owner does not expect is just as conflicting as a
            // different id in an expected field (for example, reusing a block
            // upload as page chrome must never add a second owner).
            if (upload[key] && upload[key] !== expected[key]) {
              throw Object.assign(new Error('Imported file checkpoint already belongs to another owner.'), { code: 409 });
            }
          }
          if (
            context.itemSnapshotRevision
            && (
              upload.notionImportJobId !== context.job.id
              || upload.notionImportSnapshotRevision !== context.itemSnapshotRevision
              || !upload.notionImportSlotKey
            )
          ) {
            throw Object.assign(new Error('Imported file checkpoint identity changed before owner commit.'), { code: 409 });
          }
          rows.push({ upload, target: { ...target, ...expected } });
        }
        const operations: TransactOperation[] = [];
        if (context.applyLease && context.itemSnapshotRevision) {
          operations.push(
            {
              table: 'notion_import_jobs',
              op: 'expect',
              id: context.job.id,
              where: [
                ['status', '==', context.job.status],
                ['itemSnapshotRevision', '==', context.itemSnapshotRevision],
              ],
              exists: true,
            },
            {
              table: 'notion_import_apply_locks',
              op: 'expect',
              id: context.applyLease.id,
              where: [
                ['leaseId', '==', context.applyLease.leaseId],
                ['purpose', '==', 'apply'],
              ],
              exists: true,
            },
          );
        }
        operations.push(...recoveryPageOperations);
        operations.push(...rows.map(({ upload }): TransactOperation => ({
          table: 'file_uploads',
          op: 'expect',
          id: upload.id,
          where: [
            ['workspaceId', '==', context.job.workspaceId],
            ['status', '==', 'uploaded'],
            ['updatedAt', '==', upload.updatedAt ?? null],
            ['notionImportJobId', '==', upload.notionImportJobId ?? null],
            ['notionImportSnapshotRevision', '==', upload.notionImportSnapshotRevision ?? null],
            ['notionImportSlotKey', '==', upload.notionImportSlotKey ?? null],
          ],
          exists: true,
        })));
        operations.push(...preOwnerOperations);
        operations.push(ownerOperation);
        operations.push(...companionOperations);
        operations.push(...rows.map(({ upload, target }): TransactOperation => ({
          table: 'file_uploads',
          op: 'update',
          id: upload.id,
          data: {
            ...(target.pageId ? { pageId: target.pageId } : {}),
            ...(target.blockId ? { blockId: target.blockId } : {}),
            ...(target.databaseId ? { databaseId: target.databaseId } : {}),
            ...(target.propertyId ? { propertyId: target.propertyId } : {}),
            ...(target.templateId ? { templateId: target.templateId } : {}),
            updatedAt: nowIso(),
          },
        })));
        if (context.blockRecoveryPage) {
          await transactImportedPageBlockRecovery(
            context.db,
            operations,
            context.blockRecoveryPage,
            context,
            'stored-file block publication',
          );
        } else {
          await context.db.transact(operations);
        }
      },
    );
  }

  function storedUploadIds(value: unknown, out = new Set<string>(), seen = new Set<object>(), depth = 0) {
    if (!value || typeof value !== 'object' || depth > 32 || seen.has(value)) return out;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) storedUploadIds(item, out, seen, depth + 1);
    } else {
      const record = value as Record<string, unknown>;
      const uploadId = optionalString(record.uploadId) ?? optionalString(record.fileUploadId);
      if (uploadId) out.add(uploadId);
      else for (const item of Object.values(record)) storedUploadIds(item, out, seen, depth + 1);
    }
    seen.delete(value);
    return out;
  }

  /**
   * Imported file bytes are finalized before their block owner is made durable,
   * so a failed copy can never leave a block containing the temporary Notion
   * source URL. `file_uploads.blockId` is a real FK, however, and therefore
   * cannot point at the preallocated block id until that block exists. Register
   * those copies page-scoped, then publish the local-only block and claim every
   * upload in one ordered transaction (insert owner first, attach FKs second).
   */
  async function insertImportedBlockWithDeferredFileUploads(
    context: NotionFileCopyContext,
    block: Block,
    rawUploadIds: string[],
    companionOperations: TransactOperation[] = [],
  ) {
    const uploadIds = Array.from(new Set(rawUploadIds));
    if (uploadIds.length === 0) {
      if (context.applyLease && context.itemSnapshotRevision) {
        // File-bearing blocks already commit under the apply lease inside
        // transactImportedFileOwner. Keep ordinary blocks on the same boundary:
        // after a crashed request's lease is replaced it must not append another
        // block behind the recovery worker.
        const operations: TransactOperation[] = [
          {
            table: 'notion_import_jobs',
            op: 'expect',
            id: context.job.id,
            where: [
              ['status', '==', context.job.status],
              ['itemSnapshotRevision', '==', context.itemSnapshotRevision],
            ],
            exists: true,
          },
          {
            table: 'notion_import_apply_locks',
            op: 'expect',
            id: context.applyLease.id,
            where: [
              ['leaseId', '==', context.applyLease.leaseId],
              ['purpose', '==', 'apply'],
            ],
            exists: true,
          },
          ...(context.blockRecoveryPage
            ? [importedPageBlockRecoveryPageExpectation(context.blockRecoveryPage)]
            : []),
          { table: 'blocks', op: 'insert', data: block as unknown as Record<string, unknown> },
          ...companionOperations,
        ];
        if (context.blockRecoveryPage) {
          await transactImportedPageBlockRecovery(
            context.db,
            operations,
            context.blockRecoveryPage,
            context,
            'block publication',
          );
        } else {
          await context.db.transact(operations);
        }
        return block;
      }
      if (companionOperations.length > 0) {
        await context.db.transact([
          { table: 'blocks', op: 'insert', data: block as unknown as Record<string, unknown> },
          ...companionOperations,
        ]);
        return block;
      }
      return context.db.table<Block>('blocks').insert(block);
    }
    await transactImportedFileOwner(
      context,
      { table: 'blocks', op: 'insert', data: block as unknown as Record<string, unknown> },
      uploadIds,
      { pageId: block.pageId, blockId: block.id },
      companionOperations,
    );
    return block;
  }

  async function insertPageBlocksFromSnapshot(
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
  ) {
    const snapshot = pageSnapshot(item);
    const childBlocks = Array.isArray(snapshot?.childBlocks) ? snapshot.childBlocks : [];
    const nestedBlockIds = nestedNotionBlockIds(childBlocks);
    const blocks: Block[] = [];
    const linkedPageSnapshotCache = new Map<string, Page | null>();

    const linkedPageSnapshot = async (localPageId: string) => {
      if (!linkedPageSnapshotCache.has(localPageId)) {
        linkedPageSnapshotCache.set(localPageId, await getExisting(db.table<Page>('pages'), localPageId));
      }
      return linkedPageSnapshotCache.get(localPageId) ?? null;
    };

    const shouldImportChildrenInsideCurrentPage = (rawBlock: Record<string, unknown>) => {
      const notionType = typeof rawBlock.type === 'string' ? rawBlock.type : '';
      return notionType !== 'child_page' && notionType !== 'child_database';
    };

    const insertBlockTree = async (
      rawBlock: Record<string, unknown>,
      parentId: string | null,
      position: number,
      siblingHeadingBefore?: string,
      structuralPath = `page-blocks/${position - 1}`,
    ): Promise<Block[]> => {
      const rawBlockRecord = rawBlock as Record<string, unknown>;
      const sourceNotionBlockId = notionObjectId(rawBlockRecord);
      // The crashed request's in-memory report is lost. Replaying these pure
      // observations for a verified prefix keeps conversion/user-reference
      // reporting complete without rebuilding its durable blocks.
      reportBlockConversion(conversionReport, rawBlockRecord, item);
      reportBlockRichTextUserReferences(conversionReport, item, rawBlockRecord);
      reportImportedBlockLinkedViewResolutionFromRaw(
        conversionReport,
        item,
        rawBlockRecord,
        mappingsByNotionId,
        itemsByNotionId,
      );
      const verifiedExisting = sourceNotionBlockId
        ? existingBlocksByNotionId?.get(sourceNotionBlockId)
        : undefined;
      if (verifiedExisting) {
        blockMappingsByNotionId?.set(sourceNotionBlockId!, {
          localId: verifiedExisting.id,
          pageId: verifiedExisting.pageId,
        });
        const insertedChildren: Block[] = [];
        const children = shouldImportChildrenInsideCurrentPage(rawBlockRecord)
          ? tabBlockChildrenForImport(rawBlockRecord, conversionReport, item)
          : [];
        let childPosition = 1;
        let childSiblingHeading = '';
        for (const child of children) {
          if (rawBlockRecord.type === 'table' && child.type === 'table_row') continue;
          if (rawBlockRecord.type === 'template') continue;
          insertedChildren.push(...await insertBlockTree(
            child,
            verifiedExisting.id,
            childPosition,
            childSiblingHeading || undefined,
            `${structuralPath}/children/${childPosition - 1}`,
          ));
          const heading = notionBlockHeadingText(child);
          if (heading) childSiblingHeading = heading;
          childPosition += 1;
        }
        return insertedChildren;
      }
      const block = localBlockFromNotion(rawBlockRecord, pageId, actorId, position);
      block.parentId = parentId;
      const blockCompanionOperations: TransactOperation[] = [];
      let linkedTargetMove: { mapping: NotionImportMapping; page: Page } | undefined;
      const richTextMentionRemap = remapImportedRichTextMentionsInContent(block.content, mappingsByNotionId);
      if (richTextMentionRemap.changed) {
        block.content = richTextMentionRemap.content;
      }
      const buttonTemplateRemap = remapImportedTemplateBlocksRichTextMentions(
        block.content?.buttonTemplate as TemplateBlock[] | undefined,
        mappingsByNotionId,
      );
      if (buttonTemplateRemap.changed) {
        block.content = {
          ...(block.content ?? {}),
          buttonTemplate: buttonTemplateRemap.blocks,
        };
      }
      if (block.type === 'inline_database' && rawBlockRecord.type === 'child_database') {
        const targetIds = linkedNotionTargetIdsFromBlock(rawBlockRecord);
        const targetItem = targetIds
          .map((targetId) => itemsByNotionId?.get(targetId))
          .find((candidate) => candidate?.notionObject === 'database');
        if (importedNotionDatabaseIsInline(targetItem) === false) {
          const restContent = { ...(block.content ?? {}) };
          delete restContent.notionLinkedDatabase;
          delete restContent.notionLinkedViewIds;
          block.type = 'child_database';
          block.content = restContent;
        }
      }

      if (block.type === 'inline_database' || block.type === 'child_database' || block.type === 'child_page' || block.type === 'link_to_page') {
        const linkedTargetIds = linkedNotionTargetIdsFromBlock(rawBlockRecord);
        const wantsDatabaseTarget = block.type === 'inline_database' || block.type === 'child_database';
        const linked = linkedTargetIds
          .map((targetId) => mappingsByNotionId.get(targetId))
          .find((mapping) =>
            wantsDatabaseTarget
              ? mapping?.localType === 'database'
              : mapping?.localType === 'page',
        );
        if (linked) {
          const linkedPage = await linkedPageSnapshot(linked.localId);
          const sourceUnavailableLinkedDatabase = importedDatabaseMappingSourceUnavailable(linked);
          block.content = {
            ...withNativeHanjiLinkedDatabaseFields(block.content, {
              localTargetId: linked.localId,
              localTargetType: linked.localType,
              linkedDatabaseSource: block.type === 'inline_database' && linked.localType === 'database',
            }),
            childPageId: linked.localId,
            ...(linkedPage?.title ? { childPageTitle: linkedPage.title } : {}),
            ...(linkedPage?.icon ? { childPageIcon: linkedPage.icon } : {}),
            ...(linkedPage?.iconType ? { childPageIconType: linkedPage.iconType } : {}),
            ...(linkedPage?.kind ? { childPageKind: linkedPage.kind } : {}),
          };
          const movesLinkedTarget = (
            linked.localType === 'database'
            && rawBlockRecord.type === 'child_database'
            && !sourceUnavailableLinkedDatabase
          ) || (
            linked.localType === 'page'
            && rawBlockRecord.type === 'child_page'
          );
          if (movesLinkedTarget) {
            const linkedProperties = linkedPage?.properties ?? {};
            const expectedSourceIds = new Set([
              linked.notionId,
              optionalString(asRecord(linked.metadata)?.dataSourceId),
            ].map((value) => normalizedNotionId(value)).filter(Boolean));
            const targetSourceIds = [
              optionalString(linkedPage?.notionImportSourceId),
              optionalString(linkedProperties.notionPageId),
              optionalString(linkedProperties.notionDataSourceId),
              optionalString(linkedProperties.notionDatabaseId),
            ].map((value) => normalizedNotionId(value)).filter(Boolean);
            const targetJobIds = [
              optionalString(linkedPage?.notionImportJobId),
              optionalString(linkedProperties.notionImportJobId),
            ].filter((value): value is string => !!value);
            const expectedSourceKinds = linked.localType === 'page'
              ? new Set(['page'])
              : new Set(['database', 'data_source']);
            if (
              !fileCopyContext?.applyLease
              || !fileCopyContext.itemSnapshotRevision
              || !linkedPage
              || linked.workspaceId !== fileCopyContext.job.workspaceId
              || linked.jobId !== fileCopyContext.job.id
              || linked.localId !== linkedPage.id
              || linkedPage.workspaceId !== fileCopyContext.job.workspaceId
              || linkedPage.kind !== linked.localType
              || targetJobIds.length === 0
              || targetJobIds.some((value) => value !== fileCopyContext.job.id)
              || targetSourceIds.length === 0
              || targetSourceIds.some((value) => !expectedSourceIds.has(value))
              || !expectedSourceKinds.has(optionalString(linkedPage.notionImportSourceKind) ?? '')
            ) {
              throw Object.assign(
                new Error('Notion import linked child target provenance changed before block publication.'),
                { code: 409, notionImportRecoveryPending: true },
              );
            }
            // Query rows may be mutable object references in local runtimes.
            // Freeze the exact pre-transaction snapshots used by the CAS so a
            // concurrent mutation cannot also rewrite our diagnostic baseline.
            linkedTargetMove = {
              mapping: structuredClone(linked),
              page: structuredClone(linkedPage),
            };
            blockCompanionOperations.push(
              notionImportMappingExpectation(linked),
              {
                table: 'pages',
                op: 'expect',
                id: linkedPage.id,
                where: importedPatchOwnerTransactionWhere(linkedPage, 'pages'),
                exists: true,
              },
              {
                table: 'pages',
                op: 'update',
                id: linked.localId,
                data: { parentId: pageId, parentType: 'page', position },
              },
            );
          }
          if (block.type === 'inline_database' && linked.localType === 'database') {
            const inferredLinkedView = inferredLinkedDatabaseViewMapping(linked, mappingsByNotionId);
            if (inferredLinkedView) {
              const localViewIds = mappedLocalDatabaseViewIds(
                linkedNotionViewIdsFromBlock(rawBlockRecord),
                mappingsByNotionId,
              );
              block.content = {
                ...withNativeHanjiLinkedDatabaseFields(block.content, {
                  localViewId: inferredLinkedView.localId,
                  localViewIds,
                }),
                notionHiddenDatabaseTitleContext: {
                  inferredFrom: asRecord(linked.metadata)?.inferredFrom ?? 'view_parent_database_id',
                  heading: siblingHeadingBefore,
                  matchedViewId: inferredLinkedView.notionId,
                },
              };
            }
          }
          if (block.type === 'inline_database' && linked.localType === 'database' && !block.content?.databaseViewId && siblingHeadingBefore) {
            const linkedViews = await listAll(db.table<DbView>('db_views').where('databaseId', '==', linked.localId), 100);
            const inferredView = databaseViewMatchingImportedSection(linkedViews, siblingHeadingBefore);
            if (inferredView) {
              const inferredFrom = linkedDatabaseHeadingMatchesLabel(siblingHeadingBefore, inferredView.name)
                ? 'sibling_heading_view_name'
                : 'sibling_heading_view_context';
              block.content = {
                ...withNativeHanjiLinkedDatabaseFields(block.content, {
                  localViewId: inferredView.id,
                }),
                ...(inferredFrom === 'sibling_heading_view_name' ? { hideDatabaseTitle: true } : {}),
                notionHiddenDatabaseTitleContext: {
                  inferredFrom,
                  heading: siblingHeadingBefore,
                  matchedViewName: inferredView.name,
                },
              };
            }
          }
        }
        if (block.type === 'inline_database') {
          const linkedViewIds = linkedNotionViewIdsFromBlock(rawBlockRecord);
          const localViewIds = mappedLocalDatabaseViewIds(linkedViewIds, mappingsByNotionId);
          const linkedView = linkedViewIds
            .map((viewId) => mappingsByNotionId.get(viewId))
            .find((mapping) => mapping?.localType === 'db_view');
          if (linkedView) {
            block.content = withNativeHanjiLinkedDatabaseFields(block.content, {
              localViewId: linkedView.localId,
              localViewIds,
            });
          }
        }
      }
      const rawButtonTemplateBlocks = rawBlockRecord.type === 'template'
        ? templateBlockChildren(rawBlockRecord)
        : [];
      const localButtonTemplateBlocks = Array.isArray(block.content?.buttonTemplate)
        ? block.content.buttonTemplate as TemplateBlock[]
        : [];
      const fileReference = fileReferenceFromNotionBlock(rawBlockRecord);
      if (fileCopyContext) {
        const embeddedFileCount = countImportedEmbeddedTemplateBlockFiles(
          rawButtonTemplateBlocks,
          localButtonTemplateBlocks,
          `template button on "${item.title || item.notionId}"`,
        );
        assertImportedBlockFileTransactionCapacity(embeddedFileCount + (fileReference ? 1 : 0));
      }
      const deferredBlockUploadIds: string[] = [];
      if (
        fileCopyContext
        && (rawButtonTemplateBlocks.length > 0 || localButtonTemplateBlocks.length > 0)
      ) {
        block.content = {
          ...(block.content ?? {}),
          buttonTemplate: await copyImportedEmbeddedTemplateBlockFiles(
            fileCopyContext,
            rawButtonTemplateBlocks,
            localButtonTemplateBlocks,
            {
              notionId: notionObjectId(rawBlockRecord) ?? item.notionId,
              notionObject: 'button_template_block',
              label: `template button on "${item.title || item.notionId}"`,
              pageId,
              notionPageId: item.notionId,
            },
            deferredBlockUploadIds,
            `${structuralPath}/button`,
            'page_button_block_file',
          ),
        };
      }
      if (fileReference && fileCopyContext) {
        const notionBlockId = notionObjectId(rawBlockRecord);
        const copied = await copyNotionFileReference(fileCopyContext, {
          notionId: notionBlockId ?? item.notionId,
          notionObject: 'block',
          label: `block on "${item.title || item.notionId}"`,
          scope: fileCopyScopeForBlockType(block.type),
          pageId,
          notionBlockId,
          notionPageId: item.notionId,
          notionFileRole: 'page_block_file',
          notionFileStructuralPath: structuralPath,
          notionFileOrdinal: 0,
        }, fileReference);
        if (copied !== fileReference) {
          block.content = contentWithStoredNotionFile(block.content, copied);
        }
        if (copied.uploadId) deferredBlockUploadIds.push(copied.uploadId);
      } else if (fileReference) {
        reportBlockFileReference(conversionReport, item, rawBlockRecord);
      }
      // A file-bearing block becomes a durable owner only after every byte was
      // copied, HEAD-verified, and registered. If copy fails there is no block
      // row containing the temporary signed/source URL to leak or revive later.
      let inserted: Block;
      try {
        inserted = fileCopyContext
          ? await insertImportedBlockWithDeferredFileUploads(
              fileCopyContext,
              block,
              deferredBlockUploadIds,
              blockCompanionOperations,
            )
          : blockCompanionOperations.length > 0
            ? await (async () => {
                await db.transact([
                  { table: 'blocks', op: 'insert', data: block as unknown as Record<string, unknown> },
                  ...blockCompanionOperations,
                ]);
                return block;
              })()
            : await db.table<Block>('blocks').insert(block);
      } catch (error) {
        if (
          linkedTargetMove
          && fileCopyContext?.applyLease
          && fileCopyContext.itemSnapshotRevision
          && isApplyLeaseConflict(error)
        ) {
          const [currentJob, currentLease, currentMapping, currentPage] = await Promise.all([
            getExisting(db.table<NotionImportJob>('notion_import_jobs'), fileCopyContext.job.id).catch(() => null),
            getExisting(
              db.table<NotionImportApplyLock>('notion_import_apply_locks'),
              fileCopyContext.applyLease.id,
            ).catch(() => null),
            getExisting(
              db.table<NotionImportMapping>('notion_import_mappings'),
              linkedTargetMove.mapping.id,
            ).catch(() => null),
            getExisting(db.table<Page>('pages'), linkedTargetMove.page.id).catch(() => null),
          ]);
          const stillOwnsApply = currentJob?.status === fileCopyContext.job.status
            && currentJob.itemSnapshotRevision === fileCopyContext.itemSnapshotRevision
            && currentLease?.leaseId === fileCopyContext.applyLease.leaseId
            && currentLease.purpose === 'apply';
          if (
            stillOwnsApply
            && (
              !notionImportMappingSnapshotMatches(linkedTargetMove.mapping, currentMapping)
              || !importedPatchOwnerSnapshotMatches(linkedTargetMove.page, currentPage, 'pages')
            )
          ) {
            throw Object.assign(
              new Error('Notion import linked child target changed concurrently; no block or target move was published.'),
              { code: 409, notionImportRecoveryPending: true, cause: error },
            );
          }
        }
        throw error;
      }
      inserted = await preserveImportedBlockTimestamps(db, inserted, rawBlockRecord);
      if (sourceNotionBlockId && blockMappingsByNotionId) {
        blockMappingsByNotionId.set(sourceNotionBlockId, {
          localId: inserted.id,
          pageId: inserted.pageId,
        });
      }
      const insertedBlocks = [inserted];
      const children = shouldImportChildrenInsideCurrentPage(rawBlockRecord)
        ? tabBlockChildrenForImport(rawBlockRecord, conversionReport, item)
        : [];
      let childPosition = 1;
      let childSiblingHeading = '';
      for (const child of children) {
        if (rawBlockRecord.type === 'table' && child.type === 'table_row') continue;
        if (rawBlockRecord.type === 'template') continue;
        insertedBlocks.push(...await insertBlockTree(
          child,
          inserted.id,
          childPosition,
          childSiblingHeading || undefined,
          `${structuralPath}/children/${childPosition - 1}`,
        ));
        const heading = notionBlockHeadingText(child);
        if (heading) childSiblingHeading = heading;
        childPosition += 1;
      }
      return insertedBlocks;
    };

    let position = 1;
    let siblingHeading = '';
    for (let rawBlockIndex = 0; rawBlockIndex < childBlocks.length; rawBlockIndex += 1) {
      const rawBlock = childBlocks[rawBlockIndex];
      if (!rawBlock || typeof rawBlock !== 'object') continue;
      const rawBlockRecord = rawBlock as Record<string, unknown>;
      const rawBlockId = notionObjectId(rawBlockRecord);
      if (rawBlockId && nestedBlockIds.has(rawBlockId)) continue;
      if (rawBlockRecord.type === 'column' && notionBlockChildren(rawBlockRecord).length === 0) continue;
      blocks.push(...await insertBlockTree(
        rawBlockRecord,
        null,
        position,
        siblingHeading || undefined,
        `page-blocks/${rawBlockIndex}`,
      ));
      const heading = notionBlockHeadingText(rawBlockRecord);
      if (heading) siblingHeading = heading;
      position += 1;
    }
    const markdown = snapshot?.markdown;
    const markdownText = markdown && typeof markdown === 'object'
      ? (markdown as Record<string, unknown>).text
      : undefined;
    reportImportedPageMarkdownFallback(conversionReport, item, markdown);
    if (blocks.length === 0 && typeof markdownText === 'string' && markdownText.trim()) {
      const markdownBlock: Block = {
        id: newId(),
        pageId,
        parentId: null,
        type: 'paragraph',
        content: {
          rich: rich(markdownText.slice(0, 10_000)),
          notionMarkdown: markdown,
        },
        plainText: markdownText.slice(0, 10_000),
        position: 1,
        createdBy: actorId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      const block = fileCopyContext
        ? await insertImportedBlockWithDeferredFileUploads(fileCopyContext, markdownBlock, [])
        : await db.table<Block>('blocks').insert(markdownBlock);
      blocks.push(block);
    }
    return blocks;
  }

  async function retryImportedPageFileCopies(
    context: NotionFileCopyContext,
    page: Page,
  ) {
    const blocks = await listAll(
      context.db.table<Block>('blocks').where('pageId', '==', page.id),
      NOTION_BLOCK_CHILD_TOTAL_LIMIT,
    );
    let scanned = 0;

    for (const block of blocks) {
      const content = asRecord(block.content) ?? {};
      const reference = storedNotionFileReference(content.notionFileReference);
      if (!reference) continue;
      scanned += 1;
      const copied = await copyNotionFileReference(context, {
        notionId: optionalString(content.notionBlockId) ?? block.id,
        notionObject: 'block',
        label: `block on "${page.title || page.id}"`,
        scope: fileCopyScopeForBlockType(block.type),
        pageId: page.id,
        blockId: block.id,
      }, reference);
      if (copied === reference) continue;
      await context.db.table<Block>('blocks').update(block.id, {
        content: contentWithStoredNotionFile(content, copied),
      });
    }

    const properties = asRecord(page.properties);
    if (!properties) return scanned;

    let propertiesChanged = false;
    const nextProperties = { ...properties };
    const pagePatch: Partial<Page> = {};

    const iconReference = storedNotionFileReference(nextProperties[NOTION_PAGE_ICON_REFERENCE_KEY]);
    if (iconReference && page.iconType === 'image') {
      scanned += 1;
      const copied = await copyNotionFileReference(context, {
        notionId: page.id,
        notionObject: 'page',
        label: `page icon on "${page.title || page.id}"`,
        scope: 'icons',
        pageId: page.id,
      }, iconReference);
      if (copied !== iconReference) {
        nextProperties[NOTION_PAGE_ICON_REFERENCE_KEY] = copied;
        pagePatch.icon = copied.url;
        propertiesChanged = true;
      }
    }

    const coverReference = storedNotionFileReference(nextProperties[NOTION_PAGE_COVER_REFERENCE_KEY]);
    if (coverReference && page.cover) {
      scanned += 1;
      const copied = await copyNotionFileReference(context, {
        notionId: page.id,
        notionObject: 'page',
        label: `page cover on "${page.title || page.id}"`,
        scope: 'covers',
        pageId: page.id,
      }, coverReference);
      if (copied !== coverReference) {
        nextProperties[NOTION_PAGE_COVER_REFERENCE_KEY] = copied;
        pagePatch.cover = copied.url;
        propertiesChanged = true;
      }
    }

    for (const [propertyId, value] of Object.entries(properties)) {
      const values = Array.isArray(value) ? value : [];
      if (values.length === 0) continue;
      let changed = false;
      const nextValues: unknown[] = [];
      for (const item of values) {
        const reference = storedNotionFileReference(item);
        if (!reference) {
          nextValues.push(item);
          continue;
        }
        scanned += 1;
        const copied = await copyNotionFileReference(context, {
          notionId: propertyId,
          notionObject: 'property',
          label: `file property "${propertyId}" on "${page.title || page.id}"`,
          scope: 'database/files',
          pageId: page.id,
          databaseId: page.parentType === 'database' ? page.parentId ?? undefined : undefined,
          propertyId,
        }, reference);
        nextValues.push(copied);
        if (copied !== reference) changed = true;
      }
      if (changed) {
        nextProperties[propertyId] = nextValues;
        propertiesChanged = true;
      }
    }

    if (propertiesChanged || Object.keys(pagePatch).length > 0) {
      await context.db.table<Page>('pages').update(page.id, {
        ...pagePatch,
        ...(propertiesChanged ? { properties: nextProperties } : {}),
      });
    }

    return scanned;
  }

  function itemHasImportablePageBody(item: NotionImportItem) {
    const snapshot = pageSnapshot(item);
    const childBlocks = Array.isArray(snapshot?.childBlocks) ? snapshot.childBlocks : [];
    const markdown = snapshot?.markdown;
    const markdownText = markdown && typeof markdown === 'object'
      ? (markdown as Record<string, unknown>).text
      : undefined;
    return flattenImportablePageBlocksForPlan(childBlocks).length > 0 ||
      (typeof markdownText === 'string' && markdownText.trim().length > 0);
  }

  function importedBlocksComplete(page: Page) {
    const properties = asRecord(page.properties) ?? {};
    return properties[NOTION_IMPORT_BLOCKS_COMPLETE_KEY] === true;
  }

  function importedBlockBoundaryRepairComplete(page: Page) {
    const properties = asRecord(page.properties) ?? {};
    return properties[NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION_KEY] === NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION;
  }

  interface ExpectedImportedPageBlock {
    raw: Record<string, unknown>;
    notionId: string;
    parentExpectedIndex: number | null;
    type: string;
    plainText?: string;
    position: number;
    fileNames: string[];
  }

  function expectedImportedBlockOwnedFileNames(rawBlock: Record<string, unknown>) {
    const names: string[] = [];
    const direct = fileReferenceFromNotionBlock(rawBlock);
    if (direct) names.push(normalizeFileName(direct.name));
    if (rawBlock.type === 'template') {
      const visit = (block: Record<string, unknown>) => {
        const reference = fileReferenceFromNotionBlock(block);
        if (reference) names.push(normalizeFileName(reference.name));
        for (const child of templateBlockChildren(block)) visit(child);
      };
      for (const child of templateBlockChildren(rawBlock)) visit(child);
    }
    return names.sort();
  }

  function expectedImportedPageBlocks(item: NotionImportItem) {
    const snapshot = pageSnapshot(item);
    const childBlocks = Array.isArray(snapshot?.childBlocks) ? snapshot.childBlocks : [];
    const nestedBlockIds = nestedNotionBlockIds(childBlocks);
    const expected: ExpectedImportedPageBlock[] = [];

    const visit = (
      rawBlock: Record<string, unknown>,
      parentExpectedIndex: number | null,
      siblingPosition: number,
    ) => {
      const notionId = notionObjectId(rawBlock);
      if (!notionId) return false;
      const local = localBlockFromNotion(rawBlock, '', '', siblingPosition);
      const expectedIndex = expected.length;
      expected.push({
        raw: rawBlock,
        notionId,
        parentExpectedIndex,
        type: local.type,
        plainText: local.plainText,
        position: local.position,
        fileNames: expectedImportedBlockOwnedFileNames(rawBlock),
      });
      if (
        rawBlock.type === 'template'
        || rawBlock.type === 'child_page'
        || rawBlock.type === 'child_database'
      ) {
        return true;
      }
      let childPosition = 1;
      for (const child of tabBlockChildrenForImport(rawBlock, undefined, item)) {
        if (rawBlock.type === 'table' && child.type === 'table_row') continue;
        if (!visit(child, expectedIndex, childPosition)) return false;
        childPosition += 1;
      }
      return true;
    };

    let position = 1;
    for (const rawBlock of childBlocks) {
      if (!rawBlock || typeof rawBlock !== 'object') continue;
      const rawBlockRecord = rawBlock as Record<string, unknown>;
      const rawBlockId = notionObjectId(rawBlockRecord);
      if (rawBlockId && nestedBlockIds.has(rawBlockId)) continue;
      if (rawBlockRecord.type === 'column' && notionBlockChildren(rawBlockRecord).length === 0) continue;
      if (!visit(rawBlockRecord, null, position)) {
        return { expected, recoverable: false };
      }
      position += 1;
    }
    return { expected, recoverable: true };
  }

  function replayImportedPageBlockMetrics(
    item: NotionImportItem,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    conversionReport?: ImportConversionReport,
    itemsByNotionId?: Map<string, NotionImportItem>,
  ) {
    const snapshot = pageSnapshot(item);
    const childBlocks = Array.isArray(snapshot?.childBlocks) ? snapshot.childBlocks : [];
    const importedBlocks: Record<string, unknown>[] = [];
    const nestedBlockIds = nestedNotionBlockIds(childBlocks);
    const visit = (rawBlock: Record<string, unknown>) => {
      importedBlocks.push(rawBlock);
      if (
        rawBlock.type === 'template'
        || rawBlock.type === 'child_page'
        || rawBlock.type === 'child_database'
      ) return;
      for (const child of tabBlockChildrenForImport(rawBlock, conversionReport, item)) {
        if (rawBlock.type === 'table' && child.type === 'table_row') continue;
        visit(child);
      }
    };
    for (const rawBlock of childBlocks) {
      const rawBlockId = notionObjectId(rawBlock);
      if (rawBlockId && nestedBlockIds.has(rawBlockId)) continue;
      if (rawBlock.type === 'column' && notionBlockChildren(rawBlock).length === 0) continue;
      visit(rawBlock);
    }
    for (const rawBlock of importedBlocks) {
      reportBlockConversion(conversionReport, rawBlock, item);
      reportBlockRichTextUserReferences(conversionReport, item, rawBlock);
      reportImportedBlockLinkedViewResolutionFromRaw(
        conversionReport,
        item,
        rawBlock,
        mappingsByNotionId,
        itemsByNotionId,
      );
    }
    reportImportedPageMarkdownFallback(conversionReport, item, snapshot?.markdown);
    if (importedBlocks.length > 0) return importedBlocks.length;
    const markdown = asRecord(snapshot?.markdown);
    return typeof markdown?.text === 'string' && markdown.text.trim() ? 1 : 0;
  }

  function incompleteImportedBlockRecoveryError(message: string) {
    return Object.assign(new Error(message), {
      code: 409,
      // The page is intentionally left ready for an explicit repair/retry. The
      // top-level apply catch must not mark the whole job failed or trash the
      // user-preserved graph merely because recovery refused a destructive step.
      notionImportRecoveryPending: true,
    });
  }

  type ImportedPageBlockRecoveryPage = NonNullable<NotionFileCopyContext['blockRecoveryPage']>;

  function importedPageBlockRecoveryPageExpectation(
    page: ImportedPageBlockRecoveryPage,
  ): TransactOperation {
    return {
      table: 'pages',
      op: 'expect',
      id: page.id,
      where: [
        ['workspaceId', '==', page.workspaceId],
        ['parentId', '==', page.parentId ?? null],
        ['parentType', '==', page.parentType ?? null],
        ['inTrash', '==', page.inTrash ?? null],
        ['trashedAt', '==', page.trashedAt ?? null],
        ['position', '==', page.position ?? null],
        ['isLocked', '==', page.isLocked ?? null],
        ['updatedAt', '==', page.updatedAt ?? null],
      ],
      exists: true,
    };
  }

  function importedPageBlockRecoveryPageChanged(
    expected: ImportedPageBlockRecoveryPage,
    current: Page | null | undefined,
  ) {
    if (!current) return true;
    if (current.workspaceId !== expected.workspaceId) return true;
    const fields = [
      'parentId',
      'parentType',
      'inTrash',
      'trashedAt',
      'position',
      'isLocked',
      'updatedAt',
    ] as const;
    return fields.some((field) => (current[field] ?? null) !== (expected[field] ?? null));
  }

  async function normalizeImportedPageBlockRecoveryConflict(
    db: DbRef,
    expectedPage: ImportedPageBlockRecoveryPage,
    context: NotionFileCopyContext,
    action: string,
    error: unknown,
  ): Promise<never> {
    if (
      isRetryableNotionTemplateCleanupError(error)
      || !isApplyLeaseConflict(error)
      || !context.applyLease
      || !context.itemSnapshotRevision
    ) {
      throw error;
    }
    let currentJob: NotionImportJob | null | undefined;
    let currentLease: NotionImportApplyLock | null | undefined;
    let currentPage: Page | null | undefined;
    try {
      [currentJob, currentLease, currentPage] = await Promise.all([
        getExisting(db.table<NotionImportJob>('notion_import_jobs'), context.job.id),
        getExisting(db.table<NotionImportApplyLock>('notion_import_apply_locks'), context.applyLease.id),
        getExisting(db.table<Page>('pages'), expectedPage.id),
      ]);
    } catch {
      // A diagnostic read failure is not proof that the page CAS lost. Preserve
      // the original error so the ordinary apply failure/lease path decides it.
      throw error;
    }
    const stillOwnsApply = currentJob?.status === context.job.status
      && currentJob.itemSnapshotRevision === context.itemSnapshotRevision
      && currentLease?.leaseId === context.applyLease.leaseId
      && currentLease.purpose === 'apply';
    if (!stillOwnsApply || !importedPageBlockRecoveryPageChanged(expectedPage, currentPage)) {
      // In particular, a stale worker that lost its apply lease must not turn
      // the lease-fence conflict into a retryable page mutation.
      throw error;
    }
    throw incompleteImportedBlockRecoveryError(
      `Notion import ${action} paused because the recovery page changed concurrently. Existing content was preserved.`,
    );
  }

  async function transactImportedPageBlockRecovery(
    db: DbRef,
    operations: TransactOperation[],
    expectedPage: ImportedPageBlockRecoveryPage,
    context: NotionFileCopyContext,
    action: string,
  ) {
    try {
      return await db.transact(operations);
    } catch (error) {
      return normalizeImportedPageBlockRecoveryConflict(
        db,
        expectedPage,
        context,
        action,
        error,
      );
    }
  }

  async function classifyIncompleteImportedPageBlockGraph(
    db: DbRef,
    page: Page,
    item: NotionImportItem,
    existingBlocks: Block[],
    context: NotionFileCopyContext,
  ) {
    const { expected, recoverable } = expectedImportedPageBlocks(item);
    const snapshot = pageSnapshot(item);
    const markdown = asRecord(snapshot?.markdown);
    const markdownText = typeof markdown?.text === 'string' ? markdown.text : '';

    if (expected.length === 0 && markdownText.trim()) {
      if (existingBlocks.length === 0) {
        return {
          state: 'prefix' as const,
          blockMappings: new Map<string, ImportedBlockMapping>(),
          existingBlocksByNotionId: new Map<string, Block>(),
          verifiedBlockCount: 0,
        };
      }
      const [block] = existingBlocks;
      const exactFallback = existingBlocks.length === 1
        && block?.type === 'paragraph'
        && block.parentId == null
        && block.position === 1
        && !block.lastEditedBy
        && !block.lastMutationId
        && block.plainText === markdownText.slice(0, 10_000)
        && jsonEquivalent(asRecord(block.content)?.notionMarkdown, markdown);
      if (exactFallback) {
        return {
          state: 'complete' as const,
          blockMappings: new Map<string, ImportedBlockMapping>(),
          existingBlocksByNotionId: new Map<string, Block>(),
          verifiedBlockCount: 1,
        };
      }
      throw incompleteImportedBlockRecoveryError(
        'Notion import found an edited or contradictory incomplete markdown block. Existing content was preserved.',
      );
    }

    if (!recoverable && existingBlocks.length > 0) {
      throw incompleteImportedBlockRecoveryError(
        'Notion import cannot prove ownership of an id-less incomplete block graph. Existing content was preserved.',
      );
    }
    if (existingBlocks.length === 0) {
      return {
        state: 'prefix' as const,
        blockMappings: new Map<string, ImportedBlockMapping>(),
        existingBlocksByNotionId: new Map<string, Block>(),
        verifiedBlockCount: 0,
      };
    }

    const expectedNotionIds = new Set<string>();
    for (const descriptor of expected) {
      if (expectedNotionIds.has(descriptor.notionId)) {
        throw incompleteImportedBlockRecoveryError(
          'Notion import source contained duplicate block identities; incomplete content was preserved.',
        );
      }
      expectedNotionIds.add(descriptor.notionId);
    }

    const actualById = new Map(existingBlocks.map((block) => [block.id, block]));
    const childrenByParent = new Map<string | null, Block[]>();
    for (const block of existingBlocks) {
      const parentId = block.parentId ?? null;
      if (parentId && !actualById.has(parentId)) {
        throw incompleteImportedBlockRecoveryError(
          'Notion import found an orphaned incomplete block. Existing content was preserved.',
        );
      }
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(block);
      childrenByParent.set(parentId, siblings);
    }
    for (const siblings of childrenByParent.values()) {
      siblings.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
      if (new Set(siblings.map((block) => block.position)).size !== siblings.length) {
        throw incompleteImportedBlockRecoveryError(
          'Notion import found contradictory sibling positions in an incomplete block graph. Existing content was preserved.',
        );
      }
    }
    const actualPreorder: Block[] = [];
    const visited = new Set<string>();
    const visitActual = (block: Block) => {
      if (visited.has(block.id)) {
        throw incompleteImportedBlockRecoveryError(
          'Notion import found a cyclic incomplete block graph. Existing content was preserved.',
        );
      }
      visited.add(block.id);
      actualPreorder.push(block);
      for (const child of childrenByParent.get(block.id) ?? []) visitActual(child);
    };
    for (const block of childrenByParent.get(null) ?? []) visitActual(block);
    if (actualPreorder.length !== existingBlocks.length || actualPreorder.length > expected.length) {
      throw incompleteImportedBlockRecoveryError(
        'Notion import found a non-prefix incomplete block graph. Existing content was preserved.',
      );
    }

    const blockMappings = new Map<string, ImportedBlockMapping>();
    const existingBlocksByNotionId = new Map<string, Block>();
    const actualByExpectedIndex: Block[] = [];
    const keyPrefix = exactNotionImportObjectKeyPrefix(context.job);
    for (let index = 0; index < actualPreorder.length; index += 1) {
      const block = actualPreorder[index]!;
      const descriptor = expected[index]!;
      if (block.lastEditedBy || block.lastMutationId) {
        throw incompleteImportedBlockRecoveryError(
          'Notion import found a user-edited incomplete block. Existing content was preserved.',
        );
      }
      const expectedParentId = descriptor.parentExpectedIndex === null
        ? null
        : actualByExpectedIndex[descriptor.parentExpectedIndex]?.id;
      if (
        (block.parentId ?? null) !== (expectedParentId ?? null)
        || block.type !== descriptor.type
        || block.position !== descriptor.position
        || block.plainText !== descriptor.plainText
      ) {
        throw incompleteImportedBlockRecoveryError(
          'Notion import found a modified or reparented incomplete block. Existing content was preserved.',
        );
      }
      const blockContent = asRecord(block.content) ?? {};
      const rawNotionBlock = asRecord(blockContent.notionBlock);
      const durableNotionBlockId = optionalString(blockContent.notionBlockId);
      if (durableNotionBlockId && durableNotionBlockId !== descriptor.notionId) {
        throw incompleteImportedBlockRecoveryError(
          'Notion import found contradictory durable block provenance. Existing content was preserved.',
        );
      }
      if (rawNotionBlock && (
        notionObjectId(rawNotionBlock) !== descriptor.notionId
        || !jsonEquivalent(rawNotionBlock, sanitizeNotionCredentialMetadata(descriptor.raw))
      )) {
        throw incompleteImportedBlockRecoveryError(
          'Notion import found a modified incomplete block. Existing content was preserved.',
        );
      }
      const storedIds = Array.from(storedUploadIds(block.content));
      const sourceCreatedAt = notionIsoTimestamp(descriptor.raw.created_time);
      const sourceUpdatedAt = notionIsoTimestamp(descriptor.raw.last_edited_time);
      const hasExactLegacyFileProvenance = (
        !rawNotionBlock
        && !durableNotionBlockId
        && descriptor.fileNames.length > 0
        && !!sourceCreatedAt
        && !!sourceUpdatedAt
        && block.createdAt === sourceCreatedAt
        && block.updatedAt === sourceUpdatedAt
      );
      if (
        !rawNotionBlock
        && durableNotionBlockId !== descriptor.notionId
        && !hasExactLegacyFileProvenance
      ) {
        throw incompleteImportedBlockRecoveryError(
          'Notion import cannot prove the source identity of an incomplete block. Existing content was preserved.',
        );
      }
      if (storedIds.length !== descriptor.fileNames.length) {
        throw incompleteImportedBlockRecoveryError(
          'Notion import found an incomplete stored-file owner graph. Existing content was preserved.',
        );
      }
      const actualFileNames: string[] = [];
      for (const uploadId of storedIds) {
        const upload = await getExisting(db.table<FileUpload>('file_uploads'), uploadId);
        if (
          !upload
          || upload.workspaceId !== page.workspaceId
          || upload.pageId !== page.id
          || upload.blockId !== block.id
          || upload.status !== 'uploaded'
          || !upload.key.startsWith(keyPrefix)
          || !upload.scope.startsWith('blocks/')
        ) {
          throw incompleteImportedBlockRecoveryError(
            'Notion import found a contradictory stored-file owner graph. Existing content was preserved.',
          );
        }
        actualFileNames.push(normalizeFileName(upload.name));
      }
      actualFileNames.sort();
      if (!jsonEquivalent(actualFileNames, descriptor.fileNames)) {
        throw incompleteImportedBlockRecoveryError(
          'Notion import could not uniquely align a legacy file block to its source slot. Existing content was preserved.',
        );
      }
      actualByExpectedIndex[index] = block;
      blockMappings.set(descriptor.notionId, { localId: block.id, pageId: block.pageId });
      existingBlocksByNotionId.set(descriptor.notionId, block);
    }
    return {
      state: actualPreorder.length === expected.length ? 'complete' as const : 'prefix' as const,
      blockMappings,
      existingBlocksByNotionId,
      verifiedBlockCount: actualPreorder.length,
    };
  }

  function importedPageBlockRecoveryFence(context: NotionFileCopyContext): TransactOperation[] {
    if (!context.applyLease || !context.itemSnapshotRevision) {
      throw incompleteImportedBlockRecoveryError(
        'Notion import block recovery requires the active apply lease and immutable snapshot revision.',
      );
    }
    return [
      {
        table: 'notion_import_jobs',
        op: 'expect',
        id: context.job.id,
        where: [
          ['status', '==', context.job.status],
          ['itemSnapshotRevision', '==', context.itemSnapshotRevision],
        ],
        exists: true,
      },
      {
        table: 'notion_import_apply_locks',
        op: 'expect',
        id: context.applyLease.id,
        where: [
          ['leaseId', '==', context.applyLease.leaseId],
          ['purpose', '==', 'apply'],
        ],
        exists: true,
      },
    ];
  }

  function exactNotionImportObjectKeyPrefix(job: NotionImportJob) {
    return `workspaces/${job.workspaceId}/notion-import/${job.id}/`;
  }

  function importedPageBlockRecoveryMarker(
    page: Page,
    context: NotionFileCopyContext,
  ) {
    const marker = asRecord(asRecord(page.properties)?.[NOTION_IMPORT_BLOCK_RECOVERY_KEY]);
    if (!marker) return undefined;
    if (
      marker.jobId !== context.job.id
      || marker.itemSnapshotRevision !== context.itemSnapshotRevision
    ) {
      throw incompleteImportedBlockRecoveryError(
        'Notion import found a page lock owned by another recovery revision. Existing content was preserved.',
      );
    }
    return marker;
  }

  async function beginImportedPageBlockRecovery(
    db: DbRef,
    page: Page,
    context: NotionFileCopyContext,
  ) {
    const existingMarker = importedPageBlockRecoveryMarker(page, context);
    if (existingMarker) {
      if (page.isLocked !== true) {
        throw incompleteImportedBlockRecoveryError(
          'Notion import recovery marker was present on an unlocked page. Existing content was preserved.',
        );
      }
      return page;
    }
    if (page.isLocked === true) {
      throw incompleteImportedBlockRecoveryError(
        'Notion import will not override a user-locked incomplete page. Existing content was preserved.',
      );
    }
    const properties = {
      ...(page.properties ?? {}),
      [NOTION_IMPORT_BLOCK_RECOVERY_KEY]: {
        jobId: context.job.id,
        itemSnapshotRevision: context.itemSnapshotRevision,
      },
    };
    await transactImportedPageBlockRecovery(db, [
      ...importedPageBlockRecoveryFence(context),
      importedPageBlockRecoveryPageExpectation(page),
      {
        table: 'pages',
        op: 'update',
        id: page.id,
        data: { isLocked: true, properties },
      },
    ], page, context, 'lock acquisition');
    return await getExisting(db.table<Page>('pages'), page.id) ?? { ...page, isLocked: true, properties };
  }

  async function releaseImportedPageBlockRecovery(
    db: DbRef,
    page: Page,
    context: NotionFileCopyContext,
  ) {
    const marker = importedPageBlockRecoveryMarker(page, context);
    if (!marker) return page;
    const properties = { ...(page.properties ?? {}) };
    delete properties[NOTION_IMPORT_BLOCK_RECOVERY_KEY];
    await transactImportedPageBlockRecovery(db, [
      ...importedPageBlockRecoveryFence(context),
      importedPageBlockRecoveryPageExpectation(page),
      {
        table: 'pages',
        op: 'update',
        id: page.id,
        data: { isLocked: false, properties },
      },
    ], page, context, 'lock release');
    return await getExisting(db.table<Page>('pages'), page.id) ?? { ...page, isLocked: false, properties };
  }

  async function recoverIncompleteImportedPageBlocks(
    db: DbRef,
    page: Page,
    item: NotionImportItem,
    mappingsByNotionId: Map<string, NotionImportMapping>,
    context: NotionFileCopyContext,
  ) {
    const properties = asRecord(page.properties) ?? {};
    const pageMapping = mappingsByNotionId.get(item.notionId);
    const rootMapping = mappingsByNotionId.get(importRootNotionId(context.job.id));
    if (
      properties.notionImportJobId !== context.job.id
      || properties.notionPageId !== item.notionId
      || pageMapping?.jobId !== context.job.id
      || pageMapping.localType !== 'page'
      || pageMapping.localId !== page.id
      || rootMapping?.jobId !== context.job.id
      || rootMapping.relationKind !== 'import_root'
    ) {
      throw incompleteImportedBlockRecoveryError(
        'Notion import cannot prove that the incomplete page is still job-owned staging content. Existing content was preserved.',
      );
    }

    const inheritedRecoveryMarker = !!importedPageBlockRecoveryMarker(page, context);
    const recoveryPage = await beginImportedPageBlockRecovery(db, page, context);
    try {
      const graph = await withFileWorkspaceLease(
        db,
        context.job.workspaceId,
        context.actorId,
        'notion-import-page-block-recovery-verify',
        async (fileLease) => {
          await fileLease.assertOwned();
          if (context.applyLease) await renewNotionApplyLease(db, context.applyLease);
          const freshBlocks = await listAll(
            db.table<Block>('blocks').where('pageId', '==', recoveryPage.id),
            NOTION_BLOCK_CHILD_TOTAL_LIMIT,
          );
          return classifyIncompleteImportedPageBlockGraph(
            db,
            recoveryPage,
            item,
            freshBlocks,
            context,
          );
        },
      );
      return {
        complete: graph.state === 'complete',
        page: recoveryPage,
        blockMappings: graph.blockMappings,
        existingBlocksByNotionId: graph.existingBlocksByNotionId,
        verifiedBlockCount: graph.verifiedBlockCount,
      };
    } catch (error) {
      // Validation failures are fail-closed but non-destructive. Restore the
      // user's unlocked staging state when the same apply lease still owns it;
      // a lost lease leaves the durable marker locked for its new owner.
      if (!inheritedRecoveryMarker) {
        await bestEffort(
          'notion-import release rejected block recovery lock',
          releaseImportedPageBlockRecovery(db, recoveryPage, context),
        );
      }
      throw error;
    }
  }

  async function markImportedBlocksComplete(
    db: DbRef,
    page: Page,
    context?: NotionFileCopyContext,
  ) {
    const recoveryMarker = context ? importedPageBlockRecoveryMarker(page, context) : undefined;
    const properties = { ...(page.properties ?? {}) };
    delete properties[NOTION_IMPORT_BLOCK_RECOVERY_KEY];
    Object.assign(properties, {
      [NOTION_IMPORT_BLOCKS_COMPLETE_KEY]: true,
      [NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION_KEY]: NOTION_IMPORT_BLOCK_BOUNDARY_REPAIR_VERSION,
    });
    if (context?.applyLease && context.itemSnapshotRevision) {
      await transactImportedPageBlockRecovery(db, [
        ...importedPageBlockRecoveryFence(context),
        importedPageBlockRecoveryPageExpectation(page),
        {
          table: 'pages',
          op: 'update',
          id: page.id,
          data: {
            properties,
            ...(recoveryMarker ? { isLocked: false } : {}),
          },
        },
      ], page, context, 'completion publication');
      return await getExisting(db.table<Page>('pages'), page.id) ?? {
        ...page,
        properties,
        ...(recoveryMarker ? { isLocked: false } : {}),
      };
    }
    return await db.table<Page>('pages').update(page.id, { properties });
  }

  async function replaceImportedBlocksForPage(
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
  ) {
    const existingBlocks = await listAll(db.table<Block>('blocks').where('pageId', '==', page.id), NOTION_BLOCK_CHILD_TOTAL_LIMIT);
    let verifiedExistingBlocks = new Map<string, Block>();
    let verifiedReusedBlockCount = 0;
    let recoveredCompleteMappings: Map<string, ImportedBlockMapping> | undefined;
    if (existingBlocks.length > 0) {
      const recovered = await recoverIncompleteImportedPageBlocks(
        db,
        page,
        item,
        mappingsByNotionId,
        fileCopyContext,
      );
      page = recovered.page;
      verifiedExistingBlocks = recovered.existingBlocksByNotionId;
      verifiedReusedBlockCount = recovered.verifiedBlockCount;
      if (recovered.complete) {
        recoveredCompleteMappings = recovered.blockMappings;
      }
    } else if (fileCopyContext.applyLease && fileCopyContext.itemSnapshotRevision) {
      // Finish a prior cleanup that died after the last block delete. This is a
      // no-op for a genuinely new empty page.
      const recovered = await recoverIncompleteImportedPageBlocks(
        db,
        page,
        item,
        mappingsByNotionId,
        fileCopyContext,
      );
      page = recovered.page;
      verifiedExistingBlocks = recovered.existingBlocksByNotionId;
      verifiedReusedBlockCount = recovered.verifiedBlockCount;
    }
    const previousRecoveryPage = fileCopyContext.blockRecoveryPage;
    fileCopyContext.blockRecoveryPage = page;
    try {
      if (prepareRecoveredPage) {
        page = await prepareRecoveredPage(page);
        fileCopyContext.blockRecoveryPage = page;
      }
      if (recoveredCompleteMappings) {
        // The request that committed the final block can die before the page and
        // conversion report checkpoint. Rebuild the pure report observations
        // even though no product block needs to be inserted again.
        replayImportedPageBlockMetrics(
          item,
          mappingsByNotionId,
          conversionReport,
          itemsByNotionId,
        );
        const updatedPage = await markImportedBlocksComplete(db, page, fileCopyContext);
        for (const [notionBlockId, mapping] of recoveredCompleteMappings) {
          importedBlockMappingsByNotionId.set(notionBlockId, mapping);
        }
        return {
          page: updatedPage,
          insertedBlocks: [] as Block[],
          reusedBlocks: verifiedReusedBlockCount,
        };
      }
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
        verifiedExistingBlocks,
      );
      const updatedPage = await markImportedBlocksComplete(db, page, fileCopyContext);
      return {
        page: updatedPage,
        insertedBlocks,
        reusedBlocks: verifiedReusedBlockCount,
      };
    } finally {
      fileCopyContext.blockRecoveryPage = previousRecoveryPage;
    }
  }

  async function ensureImportedPageWorkspaceIndexes(
    admin: AdminDbAccessor,
    mappings: NotionImportMapping[],
    workspaceId: string,
  ) {
    const localPageIds = new Set<string>();
    for (const mapping of mappings) {
      if (
        (mapping.localType === 'page' || mapping.localType === 'database') &&
        typeof mapping.localId === 'string' &&
        mapping.localId.length > 0
      ) {
        localPageIds.add(mapping.localId);
      }
    }
    for (const pageId of localPageIds) {
      await ensurePageWorkspaceIndex(admin, pageId, workspaceId);
    }
  }

  return {
    ensureImportedPageWorkspaceIndexes,
    importedBlockBoundaryRepairComplete,
    importedBlocksComplete,
    importedPageBlockRecoveryFence,
    importedPageBlockRecoveryPageExpectation,
    insertPageBlocksFromSnapshot,
    itemHasImportablePageBody,
    markImportedBlocksComplete,
    recoverIncompleteImportedPageBlocks,
    replayImportedPageBlockMetrics,
    replaceImportedBlocksForPage,
    retryImportedPageFileCopies,
    storedUploadIds,
    transactImportedFileOwner,
    transactImportedPageBlockRecovery,
  };
}
