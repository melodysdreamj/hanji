import type { PersistentGeneratedLocale } from "./persistent-generated-labels";
import type {
  ImportConversionReport,
  NotionImportItem,
  NotionImportJob,
  NotionImportPlan,
  NotionImportPlanRuntime,
  NotionImportWarning,
} from "../functions/notion-import";

export function createNotionImportPlanner(runtime: NotionImportPlanRuntime) {
  const {
    asRecord,
    augmentNotionPropertiesFromRowSnapshots,
    compareNotionImportViewItems,
    dataSourceSnapshot,
    emptyConversionReport,
    finalizeConversionReport,
    flattenImportablePageBlocksForPlan,
    formulaPropertyReferences,
    incrementReport,
    inferDataSourceForHiddenLinkedDatabase,
    inspectViewPropertyReferences,
    itemMetadata,
    linkedNotionTargetIdsFromBlock,
    linkedNotionViewIdsFromBlock,
    localBlockTypeFromNotion,
    localizedImportableNotionViews,
    notionFilePropertyReferences,
    notionObjectId,
    notionPropertiesFromSnapshot,
    notionPropertyConfig,
    notionPropertyReferenceVariants,
    notionUserReferencesFromPropertyValue,
    nowIso,
    optionalString,
    pageSnapshot,
    parsePersistentGeneratedLocale,
    progressObject,
    pushReportIssue,
    rawTemplateBlocks,
    rawTemplatesFromSnapshot,
    relationTargetNotionId,
    reportBlockConversion,
    reportBlockFileReference,
    reportBlockRichTextUserReferences,
    reportNotionFileReferences,
    reportNotionUserReferences,
    reportPageChromeFileReferences,
    reportTemplateBlockRichTextUserReferences,
    reportUnresolvedFormulaPropertyReference,
    reportUnsupportedFormulaFunctions,
    reportUnsupportedProperty,
    reportUnsupportedView,
    rowDataSourceId,
    templatePropertiesFromNotion,
    unsupportedFormulaFunctions,
    viewPropertyMappingsFromRawProperties,
    viewSnapshot,
    withGeneratedTitleProperty,
  } = runtime;

  function rawViewsForPlan(
    items: NotionImportItem[],
    dataSourceItem: NotionImportItem,
    locale: PersistentGeneratedLocale = 'en',
  ) {
    const directViewItems = items
      .filter((viewItem) => viewItem.notionObject === 'view' && viewItem.parentNotionId === dataSourceItem.notionId)
      .sort(compareNotionImportViewItems);
    const snapshotViews = dataSourceSnapshot(dataSourceItem)?.views;
    const rawViews = directViewItems.length
      ? directViewItems.map((viewItem) => viewSnapshot(viewItem)).filter((view): view is Record<string, unknown> => !!view)
      : Array.isArray(snapshotViews)
        ? snapshotViews.filter((view): view is Record<string, unknown> => !!view && typeof view === 'object')
        : [];
    return localizedImportableNotionViews(rawViews, locale);
  }

  function inspectMarkdownFallbackForPlan(
    report: ImportConversionReport,
    item: NotionImportItem,
    snapshot: Record<string, unknown> | undefined,
  ) {
    const markdown = snapshot?.markdown;
    const unknownBlockIds = markdown && typeof markdown === 'object' && Array.isArray((markdown as Record<string, unknown>).unknownBlockIds)
      ? (markdown as Record<string, unknown>).unknownBlockIds as unknown[]
      : [];
    if (unknownBlockIds.length > 0) {
      incrementReport(report, 'unknownMarkdownBlocks', unknownBlockIds.length);
      pushReportIssue(report.unsupported, {
        code: 'markdown_unknown_blocks',
        notionId: item.notionId,
        notionObject: 'page',
        message: `${unknownBlockIds.length} Notion block(s) on "${item.title || item.notionId}" are unknown in the markdown fallback.`,
      });
    }
    if (markdown && typeof markdown === 'object' && (markdown as Record<string, unknown>).truncated === true) {
      incrementReport(report, 'truncatedMarkdownPages');
      pushReportIssue(report.warnings, {
        code: 'markdown_truncated',
        notionId: item.notionId,
        notionObject: 'page',
        message: `Markdown fallback for "${item.title || item.notionId}" is truncated.`,
      });
    }
  }

  function reportDiscoveryIncomplete(
    report: ImportConversionReport,
    issue: NotionImportWarning,
  ) {
    incrementReport(report, 'discoveryIncomplete');
    pushReportIssue(report.warnings, issue);
  }

  function inspectDiscoveryCompletenessForReport(
    report: ImportConversionReport,
    job: NotionImportJob,
    items: NotionImportItem[],
  ) {
    const jobProgress = progressObject(job.progress);
    const jobReport = progressObject(job.report);
    const hasMoreFromSearch = jobProgress.hasMore === true || jobReport.hasMoreFromSearch === true;
    const nextCursor = optionalString(jobProgress.nextCursor) ?? optionalString(jobReport.nextCursor);
    if (hasMoreFromSearch) {
      reportDiscoveryIncomplete(report, {
        code: 'notion_search_has_more',
        notionObject: 'workspace',
        message:
          'Notion workspace search still has more results. Continue discovery before applying if you want a fuller workspace graph.' +
          (nextCursor ? ` Saved cursor: ${nextCursor}.` : ''),
      });
    }

    for (const item of items) {
      if (item.notionObject === 'page') {
        const snapshot = pageSnapshot(item);
        if (snapshot?.childrenHasMore === true) {
          const next = optionalString(snapshot.childrenNextCursor);
          reportDiscoveryIncomplete(report, {
            code: 'page_children_truncated',
            notionId: item.notionId,
            notionObject: 'page',
            message:
              `Page "${item.title || item.notionId}" has more child blocks than this discovery pass fetched.` +
              (next ? ` Next children cursor: ${next}.` : ''),
          });
        }
      }

      if (item.notionObject === 'data_source') {
        const snapshot = dataSourceSnapshot(item);
        if (snapshot?.rowsHasMore === true) {
          const next = optionalString(snapshot.rowsNextCursor);
          reportDiscoveryIncomplete(report, {
            code: 'data_source_rows_truncated',
            notionId: item.notionId,
            notionObject: 'data_source',
            message:
              `Data source "${item.title || item.notionId}" has more rows than this discovery pass fetched.` +
              (next ? ` Next row cursor: ${next}.` : ''),
          });
        }
        if (snapshot?.viewsHasMore === true) {
          const next = optionalString(snapshot.viewsNextCursor);
          reportDiscoveryIncomplete(report, {
            code: 'data_source_views_truncated',
            notionId: item.notionId,
            notionObject: 'data_source',
            message:
              `Data source "${item.title || item.notionId}" has more views than this discovery pass fetched.` +
              (next ? ` Next view cursor: ${next}.` : ''),
          });
        }
        if (snapshot?.templatesHasMore === true) {
          const next = optionalString(snapshot.templatesNextCursor);
          reportDiscoveryIncomplete(report, {
            code: 'data_source_templates_truncated',
            notionId: item.notionId,
            notionObject: 'data_source',
            message:
              `Data source "${item.title || item.notionId}" has more templates than this discovery pass fetched.` +
              (next ? ` Next template cursor: ${next}.` : ''),
          });
        }
      }
    }
  }

  function inspectLinkedBlockForPlan(
    report: ImportConversionReport,
    item: NotionImportItem,
    rawBlock: Record<string, unknown>,
    knownNotionIds: Set<string>,
  ) {
    const notionType = typeof rawBlock.type === 'string' ? rawBlock.type : 'paragraph';
    const localType = localBlockTypeFromNotion(notionType, rawBlock);
    if (localType !== 'inline_database' && localType !== 'child_page' && localType !== 'link_to_page') return;

    const targetIds = linkedNotionTargetIdsFromBlock(rawBlock);
    if (targetIds.length && !targetIds.some((targetId) => knownNotionIds.has(targetId))) {
      incrementReport(report, 'unresolvedLinkedTargets');
      pushReportIssue(report.unresolvedReferences, {
        code: 'linked_target_unresolved',
        notionId: targetIds[0],
        notionObject: 'block',
        message: `Linked ${localType === 'inline_database' ? 'database' : 'page'} target on "${item.title || item.notionId}" is not present in the discovered graph.`,
      });
    }

    if (localType !== 'inline_database') return;
    const viewIds = linkedNotionViewIdsFromBlock(rawBlock);
    if (viewIds.length && !viewIds.some((viewId) => knownNotionIds.has(viewId))) {
      incrementReport(report, 'unresolvedLinkedViews');
      pushReportIssue(report.unresolvedReferences, {
        code: 'linked_view_unresolved',
        notionId: viewIds[0],
        notionObject: 'view',
        message: `Linked database view on "${item.title || item.notionId}" is not present in the discovered graph.`,
      });
    }
  }

  function inspectFilePropertiesForPlan(
    report: ImportConversionReport,
    item: NotionImportItem,
    rawProperties: unknown,
  ) {
    if (!rawProperties || typeof rawProperties !== 'object') return;
    for (const [nameOrId, rawValue] of Object.entries(rawProperties as Record<string, unknown>)) {
      const prop = rawValue && typeof rawValue === 'object' ? rawValue as Record<string, unknown> : {};
      const notionPropId = typeof prop.id === 'string' ? prop.id : nameOrId;
      reportNotionFileReferences(
        report,
        notionPropId,
        'property',
        `file property "${nameOrId}" on "${item.title || item.notionId}"`,
        notionFilePropertyReferences(rawValue),
      );
    }
  }

  function inspectNotionUserPropertiesForPlan(
    report: ImportConversionReport,
    item: NotionImportItem,
    rawProperties: unknown,
    labelPrefix = 'property',
  ) {
    if (!rawProperties || typeof rawProperties !== 'object') return;
    for (const [nameOrId, rawValue] of Object.entries(rawProperties as Record<string, unknown>)) {
      const prop = rawValue && typeof rawValue === 'object' ? rawValue as Record<string, unknown> : {};
      const notionPropId = typeof prop.id === 'string' ? prop.id : nameOrId;
      reportNotionUserReferences(
        report,
        notionPropId,
        'property',
        `${labelPrefix} "${nameOrId}" on "${item.title || item.notionId}"`,
        notionUserReferencesFromPropertyValue(rawValue),
      );
    }
  }

  function inspectPropertyReferencesForPlan(
    report: ImportConversionReport,
    dataSourceId: string,
    properties: Record<string, unknown>,
    dataSourceIds: Set<string>,
    propertiesByDataSource: Map<string, Record<string, unknown>>,
  ) {
    const propertyIds = notionPropertyReferenceIds(properties);

    for (const [nameOrId, rawProperty] of Object.entries(properties)) {
      const notionProperty = rawProperty && typeof rawProperty === 'object' ? rawProperty as Record<string, unknown> : {};
      const notionType = typeof notionProperty.type === 'string' ? notionProperty.type : 'rich_text';
      const config = notionPropertyConfig(notionProperty, notionType);
      if (notionType === 'relation') {
        const targetId = relationTargetNotionId(config);
        if (targetId && !dataSourceIds.has(targetId)) {
          incrementReport(report, 'unresolvedPropertyReferences');
          pushReportIssue(report.unresolvedReferences, {
            code: 'relation_target_unresolved',
            notionId: targetId,
            notionObject: 'property',
            message: `Relation property "${String(notionProperty.name ?? nameOrId)}" points to a data source that is not present in the discovered graph.`,
          });
        }
      }
      if (notionType === 'rollup') {
        const relationPropertyId = typeof config.relation_property_id === 'string' ? config.relation_property_id : undefined;
        const rollupPropertyId = typeof config.rollup_property_id === 'string' ? config.rollup_property_id : undefined;
        const relationProperty = relationPropertyId
          ? notionPropertyFromRawProperties(properties, relationPropertyId)
          : undefined;
        const relationTargetDataSourceId = relationProperty
          ? relationTargetNotionId(notionPropertyConfig(relationProperty, 'relation'))
          : undefined;

        if (relationPropertyId && !propertyIds.has(relationPropertyId)) {
          incrementReport(report, 'unresolvedPropertyReferences');
          pushReportIssue(report.unresolvedReferences, {
            code: 'rollup_property_unresolved',
            notionId: relationPropertyId,
            notionObject: 'property',
            message: `Rollup property "${String(notionProperty.name ?? nameOrId)}" references relation property "${relationPropertyId}" that is not present in data source ${dataSourceId}.`,
          });
        }

        if (!rollupPropertyId) continue;
        const targetProperties = relationTargetDataSourceId
          ? propertiesByDataSource.get(relationTargetDataSourceId)
          : undefined;
        const targetPropertyIds = targetProperties ? notionPropertyReferenceIds(targetProperties) : undefined;
        const rollupTargetIsKnown = targetPropertyIds
          ? targetPropertyIds.has(rollupPropertyId)
          : propertyIds.has(rollupPropertyId);
        if (rollupTargetIsKnown) continue;
        incrementReport(report, 'unresolvedPropertyReferences');
        pushReportIssue(report.unresolvedReferences, {
          code: 'rollup_property_unresolved',
          notionId: rollupPropertyId,
          notionObject: 'property',
          message:
            `Rollup property "${String(notionProperty.name ?? nameOrId)}" references target property "${rollupPropertyId}" ` +
            `that is not present in ${relationTargetDataSourceId ? `related data source ${relationTargetDataSourceId}` : `data source ${dataSourceId}`}.`,
        });
      }
      if (notionType === 'formula') {
        const expression = typeof config.expression === 'string' ? config.expression : '';
        const formulaPropertyId = typeof notionProperty.id === 'string' ? notionProperty.id : nameOrId;
        reportUnsupportedFormulaFunctions(
          report,
          dataSourceId,
          formulaPropertyId,
          String(notionProperty.name ?? nameOrId),
          unsupportedFormulaFunctions(expression),
        );
        for (const referencedProperty of formulaPropertyReferences(expression)) {
          if (propertyIds.has(referencedProperty)) continue;
          reportUnresolvedFormulaPropertyReference(
            report,
            dataSourceId,
            formulaPropertyId,
            String(notionProperty.name ?? nameOrId),
            referencedProperty,
          );
        }
      }
    }
  }

  function notionPropertyReferenceIds(properties: Record<string, unknown>) {
    const propertyIds = new Set<string>();
    for (const [nameOrId, rawProperty] of Object.entries(properties)) {
      const notionProperty = rawProperty && typeof rawProperty === 'object' ? rawProperty as Record<string, unknown> : {};
      const references = [
        typeof notionProperty.id === 'string' ? notionProperty.id : nameOrId,
        nameOrId,
        typeof notionProperty.name === 'string' ? notionProperty.name : undefined,
      ];
      for (const reference of references) {
        for (const candidate of notionPropertyReferenceVariants(reference)) {
          propertyIds.add(candidate);
        }
      }
    }
    return propertyIds;
  }

  function notionPropertyFromRawProperties(properties: Record<string, unknown>, reference: string) {
    const references = notionPropertyReferenceVariants(reference);
    if (references.length === 0) return undefined;
    for (const [nameOrId, rawProperty] of Object.entries(properties)) {
      const notionProperty = rawProperty && typeof rawProperty === 'object' ? rawProperty as Record<string, unknown> : {};
      const notionPropertyId = typeof notionProperty.id === 'string' ? notionProperty.id.trim() : '';
      const notionPropertyName = typeof notionProperty.name === 'string' ? notionProperty.name.trim() : '';
      const candidates = [
        ...notionPropertyReferenceVariants(notionPropertyId),
        ...notionPropertyReferenceVariants(nameOrId),
        ...notionPropertyReferenceVariants(notionPropertyName),
      ];
      if (references.some((value) => candidates.includes(value))) return notionProperty;
    }
    return undefined;
  }

  function buildImportPlan(job: NotionImportJob, items: NotionImportItem[]): NotionImportPlan {
    const locale = parsePersistentGeneratedLocale(asRecord(job.options)?.locale);
    const report = emptyConversionReport();
    const counts = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.notionObject] = (acc[item.notionObject] ?? 0) + 1;
      return acc;
    }, {});
    const knownNotionIds = new Set(items.map((item) => item.notionId));
    const databaseItems = items.filter((item) => item.notionObject === 'database');
    const dataSourceItems = items.filter((item) => item.notionObject === 'data_source');
    const dataSourceIds = new Set(dataSourceItems.map((item) => item.notionId));
    const inferredLinkedDatabaseItems = new Map<string, ReturnType<typeof inferDataSourceForHiddenLinkedDatabase>>();
    const placeholderDatabaseItems = databaseItems.filter((item) => {
      const metadata = itemMetadata(item);
      const dataSources = Array.isArray(metadata.dataSources) ? metadata.dataSources : [];
      const hasMappedSource = dataSources.some((source) => {
        const id = source && typeof source === 'object'
          ? notionObjectId(source as Record<string, unknown>)
          : undefined;
        return !!id && dataSourceIds.has(id);
      });
      if (hasMappedSource) return false;
      const inferred = inferDataSourceForHiddenLinkedDatabase(item, items, dataSourceItems);
      if (inferred) {
        inferredLinkedDatabaseItems.set(item.notionId, inferred);
        return false;
      }
      return true;
    });
    const pageItems = items.filter((item) => item.notionObject === 'page');
    const propertiesByDataSource = new Map<string, Record<string, unknown>>();
    for (const item of dataSourceItems) {
      const augmented = augmentNotionPropertiesFromRowSnapshots(
        notionPropertiesFromSnapshot(dataSourceSnapshot(item)),
        item.notionId,
        pageItems,
      );
      if (augmented.inferred > 0) incrementReport(report, 'inferredRowSnapshotProperties', augmented.inferred);
      propertiesByDataSource.set(
        item.notionId,
        withGeneratedTitleProperty(augmented.properties, locale),
      );
    }
    let properties = 0;
    let views = 0;
    let viewMappings = 0;
    let templates = 0;
    let rows = 0;
    let pages = 0;
    let blocks = 0;

    inspectDiscoveryCompletenessForReport(report, job, items);

    for (const item of dataSourceItems) {
      const sourceProperties = propertiesByDataSource.get(item.notionId) ?? {};
      reportPageChromeFileReferences(report, item);
      inspectPropertyReferencesForPlan(report, item.notionId, sourceProperties, dataSourceIds, propertiesByDataSource);
      for (const [nameOrId, rawProperty] of Object.entries(sourceProperties)) {
        const notionProperty = rawProperty && typeof rawProperty === 'object' ? rawProperty as Record<string, unknown> : {};
        const notionPropertyId = typeof notionProperty.id === 'string' ? notionProperty.id : nameOrId;
        const notionType = typeof notionProperty.type === 'string' ? notionProperty.type : 'rich_text';
        reportUnsupportedProperty(report, item.notionId, notionPropertyId, String(notionProperty.name ?? nameOrId), notionType);
        properties += 1;
      }
      const propertyMappingsForPlan = viewPropertyMappingsFromRawProperties(sourceProperties);
      const viewsToCreate = rawViewsForPlan(items, item, locale);
      views += viewsToCreate.length;
      for (const view of viewsToCreate) {
        if (typeof view.id === 'string' && view.id.trim()) viewMappings += 1;
        reportUnsupportedView(report, item.notionId, view);
        inspectViewPropertyReferences(report, item.notionId, view, propertyMappingsForPlan, sourceProperties);
      }
      const rawTemplates = rawTemplatesFromSnapshot(dataSourceSnapshot(item));
      templates += rawTemplates.length;
      for (const template of rawTemplates) {
        inspectNotionUserPropertiesForPlan(report, item, templatePropertiesFromNotion(template), 'template property');
        for (const block of rawTemplateBlocks(template)) {
          reportTemplateBlockRichTextUserReferences(report, item, block);
        }
      }
    }

    for (const item of pageItems) {
      if (rowDataSourceId(item, dataSourceIds)) rows += 1;
      else pages += 1;

      const snapshot = pageSnapshot(item);
      reportPageChromeFileReferences(report, item);
      const childBlocks = Array.isArray(snapshot?.childBlocks) ? snapshot.childBlocks : [];
      for (const rawBlock of childBlocks) {
        if (!rawBlock || typeof rawBlock !== 'object') continue;
        const rawBlockRecord = rawBlock as Record<string, unknown>;
        reportBlockConversion(report, rawBlockRecord, item);
        reportBlockRichTextUserReferences(report, item, rawBlockRecord);
        inspectLinkedBlockForPlan(report, item, rawBlockRecord, knownNotionIds);
        reportBlockFileReference(report, item, rawBlockRecord);
      }
      inspectFilePropertiesForPlan(report, item, itemMetadata(item).properties);
      inspectNotionUserPropertiesForPlan(report, item, itemMetadata(item).properties);
      inspectMarkdownFallbackForPlan(report, item, snapshot);
      const markdown = snapshot?.markdown;
      const markdownText = markdown && typeof markdown === 'object'
        ? (markdown as Record<string, unknown>).text
        : undefined;
      blocks += flattenImportablePageBlocksForPlan(childBlocks).length || (typeof markdownText === 'string' && markdownText.trim() ? 1 : 0);
    }

    for (const item of placeholderDatabaseItems) {
      incrementReport(report, 'placeholderDatabases');
      pushReportIssue(report.warnings, {
        code: 'database_source_unavailable',
        notionId: item.notionId,
        notionObject: 'database',
        message:
          `Notion database "${item.title || item.notionId}" did not expose data sources through the API, ` +
          'so Hanji will import a placeholder database instead of leaving the linked database broken.',
      });
    }

    for (const [notionId, inferred] of inferredLinkedDatabaseItems) {
      if (!inferred) continue;
      incrementReport(report, 'inferredLinkedDatabases');
      const inferredFrom =
        inferred.inferredFrom === 'view_parent_database_id'
          ? `Notion view "${inferred.matchedViewId || inferred.matchedLabel}" parent.database_id`
          : `sibling heading "${inferred.heading}" and view label "${inferred.matchedLabel}"`;
      pushReportIssue(report.warnings, {
        code: 'linked_database_source_inferred',
        notionId,
        notionObject: 'database',
        message:
          `Notion database "${notionId}" does not expose data sources, ` +
          `so Hanji will link it to imported data source "${inferred.dataSourceItem.title || inferred.dataSourceItem.notionId}" ` +
          `from ${inferredFrom}.`,
      });
    }

    const placeholderDatabases = placeholderDatabaseItems.length;
    const estimatedWrites = {
      pages: pages + rows + 1,
      databases: dataSourceItems.length + placeholderDatabases,
      rows,
      blocks,
      properties: properties + placeholderDatabases,
      views: views + placeholderDatabases,
      templates,
      mappings: dataSourceItems.length + pageItems.length + databaseItems.length + viewMappings + templates + properties,
    };

    return {
      status: items.length > 0 && job.status === 'ready' ? 'ready' : 'blocked',
      generatedAt: nowIso(),
      counts,
      estimatedWrites,
      conversion: finalizeConversionReport(report),
      canApply: items.length > 0 && job.status === 'ready',
    };
  }

  return {
    rawViewsForPlan,
    buildImportPlan,
    inspectDiscoveryCompletenessForReport,
    notionPropertyFromRawProperties,
  };
}
