import { notionApiBase } from "./notion-import-credentials";
import { type AdminDbAccessor } from "./workspace-db";
import { recordWorkspaceAudit } from "./org-audit";
import { requireString, getExisting, nowIso, newId } from "./table-utils";
import { parsePersistentGeneratedLocale, persistentGeneratedLabels } from "./persistent-generated-labels";
import type {
  NotionImportApplyRuntime,
  Page,
  DbProperty,
  DbView,
  DbTemplate,
  NotionImportJob,
  NotionFileCopyContext,
  DbRef,
  FunctionStorageProxy,
  ImportedPropertyContext,
  ImportedRowContext,
  ImportedPageBlockContext,
  ImportedBlockMapping,
  ImportedTemplateContext
} from "../functions/notion-import";

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
    listActiveNotionImportItems,
    scrubAppliedImportCredentialMetadata,
    finalizeConversionReport,
    basePage,
    importedItemTimestamps,
    preserveImportedPageTimestamps,
    loadMappings,
    buildImportedBlockOwnerContexts,
    resolveImportedPageParentFromNotionBlocks,
    moveImportedPageToResolvedParent,
    createMapping,
    ensureImportRoot,
    unwrapImportRoot,
    rowDataSourceId,
    rowPropertiesForDataSource,
    copyImportedRowFileProperties,
    importedRowFilePropertiesNeedCopy,
    copyImportedPageChromeFiles,
    existingImportedTemplateFileState,
    copyImportedTemplateFiles,
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
  const locale = parsePersistentGeneratedLocale(asRecord(job.options)?.locale);
  const generatedLabels = persistentGeneratedLabels(locale);
  const existingMappings = await loadMappings(db, job.id);
  if (job.status === 'completed') {
    const mappings = Array.from(existingMappings.values());
    await ensureImportedPageWorkspaceIndexes(admin, mappings, job.workspaceId);
    return {
      job: cleanJob(job),
      applied: (job.progress as { applied?: Record<string, number> } | undefined)?.applied ?? {},
      mappings,
    };
  }
  if (job.status !== 'ready') {
    throw new Error('Notion import job must be ready before apply.');
  }

  const items = await listActiveNotionImportItems(db, job);
  if (items.length === 0) {
    // A discovery that legitimately found nothing (nothing shared with the
    // integration, or the Notion search was rate-limited into an empty result)
    // is a user-actionable state, not a server fault — surface a clean 422.
    throw new Error(
      'Notion import found no items. Share pages with the integration, or wait a ' +
        'few minutes if the Notion API rate-limited discovery, then run discovery again.',
    );
  }
  // Re-check durable staging immediately before any page/root write. This is
  // a defense-in-depth fence for legacy rows and any out-of-band corruption;
  // only references copied and registered by this apply may become local
  // stored-file owners.
  await assertSafeNotionImportSourceReferences(
    db,
    items.map((item) => item.metadata),
  );
  const itemsByNotionId = new Map(items.map((item) => [item.notionId, item]));
  const blockOwnerContextsByNotionId = buildImportedBlockOwnerContexts(items);

  const applyPageBatchSize = parsePositiveInt(body.applyPageBatchSize, 0, 500);
  const applyDatabaseBatchSize = parsePositiveInt(
    body.applyDatabaseBatchSize,
    applyPageBatchSize > 0 ? applyPageBatchSize : 50,
    500,
  );
  const existingApplyCursor =
    asRecord(asRecord(job.progress)?.applyCursor) ??
    asRecord(asRecord(job.report)?.applyCursor);
  const existingApplyPhase = optionalString(existingApplyCursor?.phase);
  const shouldChunkDatabaseContainers =
    !existingApplyPhase ||
    existingApplyPhase === 'apply_data_sources' ||
    existingApplyPhase === 'apply_database_containers';
  const resumeDatabasePass = existingApplyPhase === 'apply_database_containers'
    ? optionalString(existingApplyCursor?.databasePass)
    : undefined;
  const resumeDatabaseIndex = existingApplyPhase === 'apply_database_containers' &&
    typeof existingApplyCursor?.databaseIndex === 'number' &&
    Number.isFinite(existingApplyCursor.databaseIndex)
    ? Math.max(0, Math.floor(existingApplyCursor.databaseIndex))
    : 0;
  const mappingsByNotionId = existingMappings;
  const rootPageId = await ensureImportRoot(db, admin, job, mappingsByNotionId, actorId);
  const dataSourceItems = items.filter((item) => item.notionObject === 'data_source');
  const dataSourceIds = new Set(dataSourceItems.map((item) => item.notionId));
  const propertyMappingsByDataSource = new Map<string, Map<string, string>>();
  const propertyRecordsByDataSource = new Map<string, DbProperty[]>();
  const importedPropertyContexts: ImportedPropertyContext[] = [];
  const importedRowContexts: ImportedRowContext[] = [];
  const importedPageBlockContexts: ImportedPageBlockContext[] = [];
  const importedTemplateContexts: ImportedTemplateContext[] = [];
  const importedBlockMappingsByNotionId = new Map<string, ImportedBlockMapping>();
  const conversionReport = emptyConversionReport();
  inspectDiscoveryCompletenessForReport(conversionReport, job, items);
  assertNotionFileCopyNotDisabled(body);
  const storedImportPagesFullWidth = parseOptionalBoolean(asRecord(job.options)?.importPagesFullWidth);
  const importPagesFullWidth = parseOptionalBoolean(body.importPagesFullWidth) ?? storedImportPagesFullWidth;
  const tokenSource = await notionTokenForJob(db, body, job, actorId, env).catch(() => undefined);
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
    properties: durableApplied.properties,
    views: durableApplied.views,
    templates: durableApplied.templates,
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
  const fileCopyContext: NotionFileCopyContext = {
    db,
    admin,
    job,
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
  };
  let currentJob = job;
  // Apply owns the 55→99% band; pages/rows dominate the work, so their loop
  // index drives most of it. Container phases get fixed early marks.
  const applyPercent = (phase: string, cursor: Record<string, unknown>) => {
    if (phase === 'apply_data_sources') return 56;
    if (phase === 'apply_database_containers') return 58;
    if (phase === 'apply_pages') {
      const index = typeof cursor.pageIndex === 'number' ? cursor.pageIndex : 0;
      const total = typeof cursor.totalPages === 'number' && cursor.totalPages > 0 ? cursor.totalPages : 0;
      if (!total) return 60;
      return Math.min(96, 60 + Math.round((index / total) * 36));
    }
    if (phase === 'apply_remap') return 98;
    return 75;
  };
  const applyActivityRing = importActivityRingOf(currentJob.progress as Record<string, unknown> | undefined);
  let lastApplyProgressWriteMs = 0;
  const updateApplyProgress = async (
    phase: string,
    cursor: Record<string, unknown> = {},
    activity?: { kind: string; title?: string; count?: number; total?: number },
  ) => {
    if (applyLease) await renewNotionApplyLease(db, applyLease);
    const applyCursor = { phase, ...cursor };
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
      },
      options: importPagesFullWidth !== undefined
        ? {
            ...(currentJob.options ?? {}),
            importPagesFullWidth,
          }
        : currentJob.options,
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

  await updateApplyProgress('apply_data_sources', {
    totalDataSources: dataSourceItems.length,
  });

  for (const item of dataSourceItems) {
    const existingMapping = mappingsByNotionId.get(item.notionId);
    let databaseId = existingMapping?.localId;
    if (!databaseId) {
      const chrome = importedPageChromeFromItem(item);
      const initialChrome = initialImportedPageChrome(chrome);
      let page = await db.table<Page>('pages').insert(
        basePage({
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
        }),
      );
      page = await copyImportedPageChromeFiles(fileCopyContext, page, item);
      page = await preserveImportedPageTimestamps(db, page, item);
      databaseId = page.id;
      await createMapping(db, admin, job, mappingsByNotionId, {
        notionId: item.notionId,
        notionType: item.notionObject,
        localId: databaseId,
        localType: 'database',
        relationKind: 'canonical_data_source',
        metadata: { title: item.title },
      });
      created.databases += 1;
      created.mappings += 1;
      if (Date.now() - lastApplyProgressWriteMs >= 1_000) {
        lastApplyProgressWriteMs = Date.now();
        await updateApplyProgress('apply_data_sources', {
          totalDataSources: dataSourceItems.length,
        }, {
          kind: 'create_database',
          title: item.title || undefined,
          count: created.databases,
          total: dataSourceItems.length,
        });
      }
    }

    const propMap = new Map<string, string>();
    propertyMappingsByDataSource.set(item.notionId, propMap);
    propertyRecordsByDataSource.set(item.notionId, []);
    const augmentedProperties = augmentNotionPropertiesFromRowSnapshots(
      notionPropertiesFromSnapshot(dataSourceSnapshot(item)),
      item.notionId,
      items,
    );
    if (augmentedProperties.inferred > 0) {
      incrementReport(conversionReport, 'inferredRowSnapshotProperties', augmentedProperties.inferred);
    }
    const properties = withGeneratedTitleProperty(augmentedProperties.properties, locale);
    const existingDatabaseProperties = databaseId
      ? await listAll(db.table<DbProperty>('db_properties').where('databaseId', '==', databaseId), 1000)
      : [];
    let propIndex = 0;
    for (const [nameOrId, rawProperty] of Object.entries(properties)) {
      const notionProperty = rawProperty && typeof rawProperty === 'object' ? rawProperty as Record<string, unknown> : {};
      const notionPropertyId = typeof notionProperty.id === 'string' ? notionProperty.id : nameOrId;
      const notionType = typeof notionProperty.type === 'string' ? notionProperty.type : 'rich_text';
      reportUnsupportedProperty(conversionReport, item.notionId, notionPropertyId, String(notionProperty.name ?? nameOrId), notionType);
      const existingPropertyMapping = mappingsByNotionId.get(notionPropertyMappingId(item.notionId, notionPropertyId));
      const existingProperty = existingPropertyMapping
        ? existingDatabaseProperties.find((property) => property.id === existingPropertyMapping.localId) ??
          await getExisting(db.table<DbProperty>('db_properties'), existingPropertyMapping.localId)
        : undefined;
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
        propIndex += 1;
        continue;
      }
      const property = dbPropertyFromNotion(databaseId, notionPropertyId, { ...notionProperty, name: notionProperty.name ?? nameOrId }, propIndex);
      const inserted = await db.table<DbProperty>('db_properties').insert(property);
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
      await createMapping(db, admin, job, mappingsByNotionId, {
        notionId: notionPropertyMappingId(item.notionId, notionPropertyId),
        notionType: 'property',
        localId: inserted.id,
        localType: 'db_property',
        relationKind: 'database_property',
        metadata: {
          dataSourceId: item.notionId,
          databaseId,
          name: inserted.name,
          notionPropertyId,
        },
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
      ? await listAll(db.table<DbView>('db_views').where('databaseId', '==', databaseId), 1000)
      : [];
    for (let index = 0; index < viewsToCreate.length; index += 1) {
      reportUnsupportedView(conversionReport, item.notionId, viewsToCreate[index]);
      const viewToCreate = viewsToCreate[index];
      const notionViewId = typeof viewToCreate.id === 'string' ? viewToCreate.id : undefined;
      const existingViewMapping = notionViewId ? mappingsByNotionId.get(notionViewId) : undefined;
      if (existingViewMapping && existingViews.some((view) => view.id === existingViewMapping.localId)) {
        continue;
      }
      if (!notionViewId && existingViews.some((view) =>
        view.name === (optionalString(viewToCreate.name) ?? generatedLabels.viewNames.table) &&
        view.type === (optionalString(viewToCreate.type) ?? 'table')
      )) {
        continue;
      }
      const inserted = await db.table<DbView>('db_views').insert(
        dbViewFromNotion(
          databaseId,
          viewToCreate,
          index,
          propMap,
          conversionReport,
          item.notionId,
          propertyRecordsByDataSource.get(item.notionId) ?? [],
        ),
      );
      created.views += 1;
      if (notionViewId) {
        await createMapping(db, admin, job, mappingsByNotionId, {
          notionId: notionViewId,
          notionType: 'view',
          localId: inserted.id,
          localType: 'db_view',
          relationKind: 'database_view',
          metadata: { dataSourceId: item.notionId },
        });
        created.mappings += 1;
      }
    }

    const templatesToCreate = rawTemplatesFromSnapshot(dataSourceSnapshot(item));
    const existingTemplates = databaseId
      ? await listAll(db.table<DbTemplate>('db_templates').where('databaseId', '==', databaseId), 1000)
      : [];
    for (let index = 0; index < templatesToCreate.length; index += 1) {
      for (const block of rawTemplateBlocks(templatesToCreate[index])) {
        reportTemplateBlockRichTextUserReferences(conversionReport, item, block);
      }
      const notionTemplateId = notionObjectId(templatesToCreate[index]);
      const existingTemplateMapping = notionTemplateId ? mappingsByNotionId.get(notionTemplateId) : undefined;
      const existingTemplate = existingTemplateMapping
        ? existingTemplates.find((template) => template.id === existingTemplateMapping.localId) ??
          await getExisting(db.table<DbTemplate>('db_templates'), existingTemplateMapping.localId)
        : undefined;
      if (existingTemplate) {
        const fileState = await existingImportedTemplateFileState(
          fileCopyContext,
          existingTemplate,
          templatesToCreate[index],
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
          templatesToCreate[index],
          propMap,
          item,
        );
        const repairedExistingTemplate = await db.table<DbTemplate>('db_templates').update(
          existingTemplate.id,
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
      const preparedTemplate = dbTemplateFromNotion(
        databaseId,
        templatesToCreate[index],
        propMap,
        index,
        conversionReport,
        item.notionId,
      );
      // Template ids are allocated before copy so every upload gets an
      // independent templateId/databaseId association, but the template row
      // itself is committed only after icon, file properties, and all nested
      // file blocks have been copied and verified.
      const copiedTemplate = await copyImportedTemplateFiles(
        fileCopyContext,
        preparedTemplate,
        templatesToCreate[index],
        propMap,
        item,
      );
      const inserted = await db.table<DbTemplate>('db_templates').insert(copiedTemplate);
      importedTemplateContexts.push({
        template: inserted,
        dataSourceId: item.notionId,
        notionId: notionTemplateId,
      });
      created.templates += 1;
      if (notionTemplateId) {
        await createMapping(db, admin, job, mappingsByNotionId, {
          notionId: notionTemplateId,
          notionType: 'template',
          localId: inserted.id,
          localType: 'db_template',
          relationKind: 'database_template',
          metadata: { dataSourceId: item.notionId, databaseId },
        });
        created.mappings += 1;
      }
    }
  }
  await updateApplyProgress('apply_database_containers', {
    totalDataSources: dataSourceItems.length,
  });

  const databaseItems = items.filter((candidate) => candidate.notionObject === 'database');
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
      if (dataSourceMapping && !mappingsByNotionId.has(item.notionId)) {
        const localDatabase = await getExisting(db.table<Page>('pages'), dataSourceMapping.localId);
        const existingNotionDatabaseId = optionalString(localDatabase?.properties?.notionDatabaseId);
        if (localDatabase?.kind === 'database' && !existingNotionDatabaseId) {
          await db.table<Page>('pages').update(localDatabase.id, {
            properties: {
              ...(localDatabase.properties ?? {}),
              notionDatabaseId: item.notionId,
              notionDataSourceId: firstDataSourceId,
            },
          });
        }
        await createMapping(db, admin, job, mappingsByNotionId, {
          notionId: item.notionId,
          notionType: 'database',
          localId: dataSourceMapping.localId,
          localType: 'database',
          relationKind: 'database_container',
          metadata: { dataSourceId: firstDataSourceId },
        });
        created.mappings += 1;
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
        return {
          job: cleanJob(currentJob),
          applied: created,
          mappings: Array.from(mappingsByNotionId.values()),
          partial: true,
        };
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
  }
  databaseIndex = 0;
  for (const item of databaseItems) {
    databaseIndex += 1;
    if (resumeDatabasePass === 'placeholder' && databaseIndex <= resumeDatabaseIndex) continue;
    if (mappingsByNotionId.has(item.notionId)) continue;
    const inferredSource = inferCanonicalDataSourceForHiddenLinkedDatabase(item, items, dataSourceItems, mappingsByNotionId);
    if (inferredSource) {
      const inferredFrom = inferredSource.inferredFrom ?? 'sibling_heading_view_name';
      await createMapping(db, admin, job, mappingsByNotionId, {
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
      });
      created.mappings += 1;
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
        return {
          job: cleanJob(currentJob),
          applied: created,
          mappings: Array.from(mappingsByNotionId.values()),
          partial: true,
        };
      }
      continue;
    }
    const metadata = itemMetadata(item);
    const database = asRecord(metadata.database);
    const chrome = importedPageChromeFromItem(item);
    const initialChrome = initialImportedPageChrome(chrome);
    const fallbackTitle = hiddenLinkedDatabaseFallbackTitle(item, items, database, locale);
    let page = await db.table<Page>('pages').insert(
      basePage({
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
      }),
    );
    page = await copyImportedPageChromeFiles(fileCopyContext, page, item);
    page = await preserveImportedPageTimestamps(db, page, item);
    const titleProperty = await db.table<DbProperty>('db_properties').insert({
      id: newId(),
      databaseId: page.id,
      name: generatedLabels.propertyNames.name,
      type: 'title',
      position: 1,
      config: {
        notionDatabaseId: item.notionId,
        notionSourceUnavailable: true,
      },
    });
    await db.table<DbView>('db_views').insert(
      dbViewFromNotion(
        page.id,
        {
          name: meaningfulImportedTitle(item.title) || generatedLabels.viewNames.table,
          type: 'table',
          sourceUnavailable: true,
          notionDatabaseId: item.notionId,
        },
        0,
        new Map([
          ['Name', titleProperty.id],
          [generatedLabels.propertyNames.name, titleProperty.id],
          ['title', titleProperty.id],
        ]),
        conversionReport,
        item.notionId,
      ),
    );
    await createMapping(db, admin, job, mappingsByNotionId, {
      notionId: item.notionId,
      notionType: 'database',
      localId: page.id,
      localType: 'database',
      relationKind: 'database_placeholder',
      metadata: {
        title: item.title,
        sourceUnavailable: true,
      },
    });
    created.databases += 1;
    created.properties += 1;
    created.views += 1;
    created.mappings += 1;
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
      return {
        job: cleanJob(currentJob),
        applied: created,
        mappings: Array.from(mappingsByNotionId.values()),
        partial: true,
      };
    }
  }

  const pageItems = items.filter((item) => item.notionObject === 'page');
  let pageIndex = 0;
  let pagesTouchedThisRun = 0;
  let pageBatchPaused = false;
  for (const item of pageItems) {
    pageIndex += 1;
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
    const existingPageMapping = mappingsByNotionId.get(item.notionId);
    if (existingPageMapping?.localType === 'page') {
      let existingPage = await getExisting(db.table<Page>('pages'), existingPageMapping.localId);
      if (existingPage && !isRow) {
        const movedPage = await moveImportedPageToResolvedParent(db, existingPage, resolvedParent);
        if (movedPage !== existingPage) {
          existingPage = movedPage;
          created.repairedPageParents += 1;
        }
      }
      if (
        existingPage &&
        isRow &&
        sourceId &&
        propMap &&
        sourceMapping?.localId &&
        importedRowFilePropertiesNeedCopy(existingPage.properties, metadata.properties, propMap)
      ) {
        existingPage = await copyImportedRowFileProperties(
          fileCopyContext,
          existingPage,
          sourceMapping.localId,
          metadata.properties,
          propMap,
          item,
        );
      }
      if (
        existingPage &&
        itemHasImportablePageBody(item) &&
        !importedBlocksComplete(existingPage)
      ) {
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
        );
        created.blocks += replaced.insertedBlocks.length;
        importedPageBlockContexts.push({ page: replaced.page, notionId: item.notionId });
        if (isRow && sourceId && propMap && sourceMapping?.localId) {
          importedRowContexts.push({ page: replaced.page, dataSourceId: sourceId, notionId: item.notionId });
        }
        pagesTouchedThisRun += 1;
        if (applyPageBatchSize > 0 && pagesTouchedThisRun >= applyPageBatchSize) {
          pageBatchPaused = true;
        }
      } else if (existingPage) {
        importedPageBlockContexts.push({ page: existingPage, notionId: item.notionId });
        if (isRow && sourceId && propMap && sourceMapping?.localId) {
          importedRowContexts.push({ page: existingPage, dataSourceId: sourceId, notionId: item.notionId });
        }
      }
      if (pageBatchPaused) {
        await updateApplyProgress('apply_pages', {
          pageIndex,
          totalPages: pageItems.length,
          pageBatchSize: applyPageBatchSize,
          pagesTouchedThisRun,
          paused: true,
        });
        return {
          job: cleanJob(currentJob),
          applied: created,
          mappings: Array.from(mappingsByNotionId.values()),
          partial: true,
        };
      }
      continue;
    }
    if (existingPageMapping) continue;
    const pageProperties = isRow && propMap
      ? rowPropertiesForDataSource(metadata.properties, propMap, {
          report: conversionReport,
          notionId: item.notionId,
          notionObject: 'page',
        }, {
          omitFileValuesNeedingStorage: fileCopyContext.requireStoredFileCopies,
        })
      : {
          notionImportJobId: job.id,
          notionPageId: item.notionId,
        };
    let page = await db.table<Page>('pages').insert(
      basePage({
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
      }),
    );
    page = await copyImportedPageChromeFiles(fileCopyContext, page, item);
    await createMapping(db, admin, job, mappingsByNotionId, {
      notionId: item.notionId,
      notionType: 'page',
      localId: page.id,
      localType: 'page',
      relationKind: isRow ? 'database_row' : 'page',
      metadata: { dataSourceId: sourceId },
    });
    created.mappings += 1;
    if (isRow) created.rows += 1;
    else created.pages += 1;
    if (isRow && sourceId && propMap && sourceMapping?.localId) {
      page = await copyImportedRowFileProperties(fileCopyContext, page, sourceMapping.localId, metadata.properties, propMap, item);
    }
    page = await preserveImportedPageTimestamps(db, page, item);
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
    page = await markImportedBlocksComplete(db, page);
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
    if (applyPageBatchSize > 0 && pagesTouchedThisRun >= applyPageBatchSize) {
      await updateApplyProgress('apply_pages', {
        pageIndex,
        totalPages: pageItems.length,
        pageBatchSize: applyPageBatchSize,
        pagesTouchedThisRun,
        paused: true,
      });
      return {
        job: cleanJob(currentJob),
        applied: created,
        mappings: Array.from(mappingsByNotionId.values()),
        partial: true,
      };
    }
  }
  await updateApplyProgress('apply_remap', {
    pageIndex,
    totalPages: pageItems.length,
  }, {
    kind: 'remap_relations',
    count: pageItems.length,
  });

  for (const item of pageItems) {
    const sourceId = rowDataSourceId(item, dataSourceIds);
    const sourceMapping = sourceId ? mappingsByNotionId.get(sourceId) : undefined;
    if (sourceMapping?.localType === 'database') continue;
    const pageMapping = mappingsByNotionId.get(item.notionId);
    if (pageMapping?.localType !== 'page') continue;
    const page = await getExisting(db.table<Page>('pages'), pageMapping.localId);
    if (!page) continue;
    const resolvedParent = resolveImportedPageParentFromNotionBlocks(item, mappingsByNotionId, blockOwnerContextsByNotionId);
    const movedPage = await moveImportedPageToResolvedParent(db, page, resolvedParent);
    if (movedPage !== page) created.repairedPageParents += 1;
  }

  await remapImportedPageBlockRichTextMentions(
    db,
    importedPageBlockContexts,
    mappingsByNotionId,
    conversionReport,
  );

  const pageLinkRemap = await remapImportedPageLinkBlocks(
    db,
    importedPageBlockContexts,
    mappingsByNotionId,
    conversionReport,
  );
  created.remappedLinkBlocks = pageLinkRemap.updatedBlocks;
  created.unresolvedImportReferences += pageLinkRemap.unresolvedTargets;

  await remapImportedSyncedBlocks(
    db,
    importedPageBlockContexts,
    importedBlockMappingsByNotionId,
    conversionReport,
  );

  const propertyRemap = await remapImportedDatabaseProperties(
    db,
    importedPropertyContexts,
    propertyMappingsByDataSource,
    mappingsByNotionId,
    conversionReport,
  );
  created.remappedProperties = propertyRemap.remapped;
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
    db,
    dataSourceItems,
    propertyRecordsByDataSource,
    mappingsByNotionId,
    conversionReport,
  );
  created.remappedViewRelationFilters = viewRelationFilterRemap.updatedViews;
  created.unresolvedImportReferences += viewRelationFilterRemap.unresolved;

  for (const rowContext of importedRowContexts) {
    const relationProps = (propertyRecordsByDataSource.get(rowContext.dataSourceId) ?? [])
      .filter((prop) => prop.type === 'relation');
    if (relationProps.length === 0) continue;
    const properties = remapImportedRowRelationProperties(rowContext.page, relationProps, mappingsByNotionId);
    if (!properties) continue;
    await db.table<Page>('pages').update(rowContext.page.id, { properties });
    created.remappedRowRelations += 1;
    const unresolved = properties.__notionRelationUnresolved;
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

  const linkedDatabaseContextFilterRemap = await addImportedLinkedDatabaseRowContextFilters(
    db,
    importedPageBlockContexts,
    conversionReport,
  );
  created.remappedLinkedDatabaseContextFilters = linkedDatabaseContextFilterRemap.updatedViews;

  for (const templateContext of importedTemplateContexts) {
    const relationProps = (propertyRecordsByDataSource.get(templateContext.dataSourceId) ?? [])
      .filter((prop) => prop.type === 'relation');
    const patch: Partial<DbTemplate> = {};
    const relationRemap = relationProps.length > 0
      ? remapImportedTemplateRelationProperties(templateContext.template, relationProps, mappingsByNotionId)
      : { properties: undefined, unresolved: {} };
    const properties = relationRemap.properties;
    if (properties) {
      patch.properties = properties;
      templateContext.template.properties = properties;
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
            message: `${unresolvedCount} relation default value(s) on imported template "${templateContext.template.name || templateContext.template.id}" could not be mapped to local row pages.`,
          });
        }
      }
    }

    let templateBlocks = templateContext.template.blocks;
    const blockMentionRemap = remapImportedTemplateBlocksRichTextMentions(templateBlocks, mappingsByNotionId);
    if (blockMentionRemap.changed) {
      templateBlocks = blockMentionRemap.blocks;
    }
    reportRichTextMentionRemap(
      conversionReport,
      templateContext.notionId,
      'template',
      `template "${templateContext.template.name || templateContext.template.id}"`,
      blockMentionRemap,
    );

    if (templateBlocks !== templateContext.template.blocks) {
      templateContext.template.blocks = templateBlocks;
    }
    const linkedBlockRemap = await remapImportedTemplateLinkedDatabaseBlocks(
      db,
      templateContext,
      mappingsByNotionId,
    );
    if (linkedBlockRemap.changed) {
      templateBlocks = linkedBlockRemap.blocks;
      templateContext.template.blocks = linkedBlockRemap.blocks;
    }
    if (templateBlocks !== templateContext.template.blocks || blockMentionRemap.changed || linkedBlockRemap.changed) {
      patch.blocks = templateBlocks;
    }

    if (Object.keys(patch).length === 0) continue;
    await db.table<DbTemplate>('db_templates').update(templateContext.template.id, patch);
  }

  await unwrapImportRoot(db, admin, job, mappingsByNotionId);
  const allMappings = Array.from(mappingsByNotionId.values());
  const finishedAt = nowIso();
  const conversion = finalizeConversionReport(conversionReport);
  // Apply no longer needs temporary Notion/AWS bearer URLs once every required
  // file copy has succeeded. Scrub the staging snapshot before declaring the
  // job complete so a completed import never becomes a credential archive.
  await scrubAppliedImportCredentialMetadata(db, items);
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
      completedAt: finishedAt,
    },
    options: importPagesFullWidth !== undefined
      ? {
          ...(currentJob.options ?? {}),
          importPagesFullWidth,
        }
      : currentJob.options,
    finishedAt,
  });
  if (!updated) {
    const latest = await getExisting(jobs, job.id);
    if (latest?.status === 'cancelled') {
      throw new Error('Notion import job is cancelled.');
    }
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

  // Imported pages/databases are page rows; write their routing index rows
  // synchronously so pageId-only entry points resolve the moment apply
  // returns (the async DB trigger remains the safety net).
  await ensureImportedPageWorkspaceIndexes(admin, allMappings, job.workspaceId);

  return {
    job: cleanJob(updated),
    applied: created,
    mappings: allMappings,
  };
}
