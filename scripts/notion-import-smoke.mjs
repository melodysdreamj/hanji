#!/usr/bin/env node

import { createServer } from 'node:http';
import {
  assert,
  assertRuntimeReachable,
  callFunction,
  expectFunctionStatus,
  normalizeBaseUrl,
  postFunction,
  readJson,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';

const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_MOCK_NOTION_API_BASE = process.env.HANJI_MOCK_NOTION_API_BASE ?? '';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_EXPECT_STORED_CONNECTION = process.env.HANJI_EXPECT_STORED_NOTION_CONNECTION === '1';
const SYNTHETIC_PDF_DATA_URL = 'data:application/pdf;base64,JVBERi0xLjQK';
const SYNTHETIC_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const SYNTHETIC_LINK_PREVIEW_URL = 'https://github.com/example/example-repo/pull/1234';
const SYNTHETIC_UNSUPPORTED_FILE_URL = 'ftp://example.com/notion-import/unsupported.pdf';
const MOCK_VIEW_FILTER_ROW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MOCK_TEMPLATE_LINKED_VIEW_ID = 'mock-template-linked-view';
const NOTION_IMPORT_CREATED_TIME = '2025-01-02T03:04:05.000Z';
const NOTION_IMPORT_EDITED_TIME = '2025-01-03T04:05:06.000Z';
const NOTION_IMPORT_ROW_CREATED_TIME = '2025-02-02T03:04:05.000Z';
const NOTION_IMPORT_ROW_EDITED_TIME = '2025-02-03T04:05:06.000Z';
const NOTION_IMPORT_BLOCK_CREATED_TIME = '2025-03-02T03:04:05.000Z';
const NOTION_IMPORT_BLOCK_EDITED_TIME = '2025-03-03T04:05:06.000Z';
const IMPORT_PROGRESS_ORDER = ['connect', 'discover', 'review', 'apply', 'file_copy_retry', 'cancel'];
const SYNTHETIC_MCP_DATABASE_PAGE_ID = '0f4c812a-7c8e-4e9b-b3d1-2a6f9450c8e1';
const SYNTHETIC_MCP_DATA_SOURCE_ID = '6a1e7d42-92b5-4c3f-a8d6-1f0b7e5c2d94';
const SYNTHETIC_MCP_RELATION_SOURCE_ID = 'b7c3e190-5d2a-4f86-9e41-8a0d6c2b735f';
const SYNTHETIC_MCP_VIEW_ID = '3d9a5b71-6e24-4c8f-91a2-7b0e5d3c684f';
const SYNTHETIC_MCP_DIRECT_PAGE_ID = 'a2e94d63-1b7f-4c50-86d9-3f7a2b8e5c14';
const SYNTHETIC_MCP_DIRECT_SOURCE_ID = 'c8f16a24-3d90-4b7e-a5c2-9e6d1f0b7348';
const SYNTHETIC_MCP_ROW_PAGE_ID = 'e4b79c12-6a35-4d8f-b1e0-2c9a7f536d84';
const SYNTHETIC_MCP_RELATED_PAGE_ID = '91d3f7a5-2c68-4b0e-a9d1-6e4f8c725b30';
const SYNTHETIC_MCP_ROW_AMOUNT = 731250;
const SYNTHETIC_MCP_ROW_DATE = '2031-08-19';
const SYNTHETIC_MCP_ROW_STATUS = '검토완료';

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

function flattenFilters(term) {
  if (!term || typeof term !== 'object') return [];
  const record = term;
  if (typeof record.conjunction === 'string') {
    return [
      ...(Array.isArray(record.filters) ? record.filters.flatMap(flattenFilters) : []),
      ...(Array.isArray(record.groups) ? record.groups.flatMap(flattenFilters) : []),
    ];
  }
  return [record];
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL Notion import smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  let mockNotionApi;
  console.log(`Notion import smoke target: ${baseUrl}`);

  try {
  if (options.mockNotionApiBase) {
    mockNotionApi = await startMockNotionApi(options.mockNotionApiBase);
    console.log(`Mock Notion API target: ${normalizeBaseUrl(options.mockNotionApiBase)}`);
  }

  await assertRuntimeReachable(baseUrl);
  const owner = await signIn(baseUrl);
  const viewer = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');
  const organizationId = bootstrap?.organization?.id ?? bootstrap?.workspace?.organizationId;
  assert(organizationId, 'workspace-bootstrap must return an organization id for Notion import audit checks');

  const connections = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'listConnections',
    workspaceId,
  });
  assert(Array.isArray(connections.connections), 'Notion import connections must be listable');
  await expectFunctionStatus(baseUrl, viewer.token, 'notion-import', {
    action: 'listConnections',
    workspaceId,
  }, 403);
  console.log('PASS Notion import connections are listed through workspace permissions without exposing credentials.');

  if (mockNotionApi) {
    await verifyMockNotionStoredConnection(baseUrl, owner.token, workspaceId, organizationId, options.expectStoredConnection);
    await verifyMockNotionOAuthConnection(baseUrl, owner.token, workspaceId, organizationId, options.expectStoredConnection);
  }

  const created = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    rootNotionPageIds: ['notion-root-smoke'],
  });
  const jobId = created?.job?.id;
  assert(jobId, 'Notion import create must return a job id');
  assert(created.job.status === 'queued', 'Notion import without a token must be queued');
  assert(created.job.apiVersion === '2026-03-11', 'Notion import must use the latest configured Notion API version');
  assert(created.job.options?.tokenStored === false, 'Notion import job must not store a token');
  assert(created.job.options?.maxEnrichedItems === 500, 'Notion import job must store recursive graph enrichment batch size');
  assertJobProgress(created.job, 'connect', 'pending', 5, 'queued Notion imports', [
    { key: 'connect', status: 'pending' },
  ]);
  await assertOrganizationAuditEvent(baseUrl, owner.token, organizationId, {
    action: 'notion_import.create',
    targetType: 'notion_import_job',
    targetId: jobId,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.connectionKind === 'manual_token' &&
      event.metadata?.snapshotItems === 0,
    message: 'Notion import create must record a filterable organization audit event',
  });
  console.log('PASS Notion import job can be queued without storing credentials.');

  const listed = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'list',
    workspaceId,
  });
  assert(
    listed.jobs?.some((job) => job.id === jobId),
    'Notion import list must include the queued job',
  );

  const inspected = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'get',
    workspaceId,
    jobId,
  });
  assert(inspected.job?.id === jobId, 'Notion import get must return the queued job');
  assert(Array.isArray(inspected.items), 'Notion import get must return an items array');
  await expectFunctionStatus(baseUrl, viewer.token, 'notion-import', {
    action: 'get',
    workspaceId,
    jobId,
  }, 403);
  console.log('PASS Notion import jobs are readable only through workspace permissions.');

  const cancelled = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'cancel',
    workspaceId,
    jobId,
  });
  assert(cancelled.job?.status === 'cancelled', 'Notion import cancel must mark the job cancelled');
  assertJobProgress(cancelled.job, 'cancel', 'cancelled', undefined, 'cancelled Notion imports', [
    { key: 'cancel', status: 'cancelled' },
  ]);
  await assertOrganizationAuditEvent(baseUrl, owner.token, organizationId, {
    action: 'notion_import.cancel',
    targetType: 'notion_import_job',
    targetId: jobId,
    predicate: (event) => event.workspaceId === workspaceId,
    message: 'Notion import cancel must record a filterable organization audit event',
  });

  const retry = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'retry',
    workspaceId,
    jobId,
  });
  assert(retry.job?.id && retry.job.id !== jobId, 'Notion import retry must create a new job');
  assert(retry.job.retryOfJobId === jobId, 'Notion import retry must link to the previous job');
  assert(retry.job.status === 'queued', 'Notion import retry without token must be queued');
  assertJobProgress(retry.job, 'connect', 'pending', 5, 'retried queued Notion imports', [
    { key: 'connect', status: 'pending' },
  ]);
  await assertOrganizationAuditEvent(baseUrl, owner.token, organizationId, {
    action: 'notion_import.create',
    targetType: 'notion_import_job',
    targetId: retry.job.id,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.retryOfJobId === jobId,
    message: 'Notion import retry must record a new audited import job linked to the previous job',
  });
  console.log('PASS Notion import cancel and retry controls work through the product API.');

  const snapshot = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    rootNotionPageIds: ['notion-page-root'],
    snapshotItems: syntheticSnapshotItems(),
  });
  const snapshotJobId = snapshot?.job?.id;
  assert(snapshotJobId, 'snapshot import must create a job');
  assert(snapshot.job.status === 'ready', 'snapshot import must be ready to apply');
  assert(snapshot.items?.length >= 3, 'snapshot import must persist discovered items');
  assertJobProgress(snapshot.job, 'discover', 'completed', 50, 'snapshot Notion imports', [
    { key: 'discover', status: 'completed' },
  ]);
  await assertOrganizationAuditEvent(baseUrl, owner.token, organizationId, {
    action: 'notion_import.create',
    targetType: 'notion_import_job',
    targetId: snapshotJobId,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.snapshotItems >= 3,
    message: 'Notion import snapshot create must record snapshot item counts in organization audit',
  });

  const planned = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'plan',
    workspaceId,
    jobId: snapshotJobId,
  });
  assert(planned.job?.status === 'ready', 'Notion import plan must keep the job ready');
  assert(planned.plan?.canApply === true, 'Notion import plan must mark ready jobs as applyable');
  assert(planned.plan?.estimatedWrites?.databases === 3, 'Notion import plan must estimate canonical and placeholder databases');
  assert(planned.plan?.estimatedWrites?.rows === 4, 'Notion import plan must estimate database row pages');
  assert(planned.plan?.estimatedWrites?.templates === 1, 'Notion import plan must estimate database templates');
  assert(planned.plan?.conversion?.summary?.unsupportedBlocks >= 1, 'Notion import plan must count unsupported block fallbacks');
  assert(planned.plan?.conversion?.summary?.unsupportedProperties >= 1, 'Notion import plan must count unsupported property fallbacks');
  assert(planned.plan?.conversion?.summary?.fileReferences >= 5, 'Notion import plan must count preserved file references');
  assert(planned.plan?.conversion?.summary?.filesNeedCopy >= 5, 'Notion import plan must flag preserved file references for later storage copy');
  assert(planned.plan?.conversion?.summary?.temporaryFileReferences >= 2, 'Notion import plan must count temporary Notion-hosted file references');
  assert(planned.plan?.conversion?.summary?.notionUserReferences >= 2, 'Notion import plan must count preserved Notion user references');
  assert(
    planned.plan?.conversion?.summary?.inferredRowSnapshotProperties >= 1,
    'Notion import plan must infer row-only properties missing from the data source schema',
  );
  assert(
    planned.plan?.conversion?.summary?.ignoredStaleHiddenViewPropertySettings >= 1,
    'Notion import plan must ignore stale hidden view property settings that are absent from schema and rows',
  );
  assert(
    planned.plan?.conversion?.summary?.unresolvedViewPropertyReferences >= 1,
    'Notion import plan must report view settings that reference unknown properties',
  );
  assert(
    planned.plan?.conversion?.summary?.unresolvedFormulaPropertyReferences >= 1,
    'Notion import plan must report formula expressions that reference unknown properties',
  );
  assert(
    planned.plan?.conversion?.summary?.unresolvedLinkedTargets >= 1,
    'Notion import plan must report linked database/page targets missing from the discovered graph',
  );
  assert(
    planned.plan?.conversion?.summary?.unresolvedLinkedViews >= 1,
    'Notion import plan must report linked database views missing from the discovered graph',
  );
  assert(
    planned.plan?.conversion?.summary?.unsupportedViewSettings >= 1,
    'Notion import plan must count unsupported view settings that are preserved raw',
  );
  assert(
    planned.plan?.conversion?.summary?.viewPropertyLayoutUnavailable >= 1,
    'Notion import plan must count table views whose property layout is not exposed by Notion',
  );
  assert(
    planned.plan?.conversion?.summary?.unsupportedFormulaFunctions >= 1,
    'Notion import plan must count unsupported formula functions that need computed fallback values',
  );
  assert(
    planned.plan?.conversion?.summary?.discoveryIncomplete >= 3,
    'Notion import plan must count discovery truncation warnings before apply',
  );
  assert(
    planned.plan?.conversion?.unresolvedReferences?.some((issue) => issue.code === 'view_property_unresolved'),
    'Notion import plan must list unresolved view property references',
  );
  assert(
    !planned.plan?.conversion?.unresolvedReferences?.some((issue) =>
      /Row-only rollup|notion-prop-row-only-rollup|notion-prop-stale-hidden-view-only/.test(issue.message ?? '')
    ),
    'Notion import plan must not report row-inferred or ignored stale hidden view properties as unresolved',
  );
  assert(
    planned.plan?.conversion?.unresolvedReferences?.some((issue) => issue.code === 'formula_property_unresolved'),
    'Notion import plan must list unresolved formula property references',
  );
  assert(
    !planned.plan?.conversion?.unresolvedReferences?.some((issue) =>
      issue.code === 'rollup_property_unresolved' &&
        /Project name rollup/.test(issue.message ?? '') &&
        /notion-prop-project-name/.test(issue.message ?? '')
    ),
    'Notion import plan must not report valid cross-database rollup target properties as unresolved',
  );
  assert(
    planned.plan?.conversion?.unresolvedReferences?.some((issue) =>
      issue.code === 'rollup_property_unresolved' &&
        /Imported rollup fallback/.test(issue.message ?? '') &&
        /notion-prop-missing-relation/.test(issue.message ?? '')
    ),
    'Notion import plan must still report rollups whose relation property is missing',
  );
  assert(
    planned.plan?.conversion?.unresolvedReferences?.some((issue) => issue.code === 'linked_target_unresolved') &&
      planned.plan?.conversion?.unresolvedReferences?.some((issue) => issue.code === 'linked_view_unresolved'),
    'Notion import plan must list unresolved linked target and linked view references',
  );
  assert(
    planned.plan?.conversion?.warnings?.some((issue) => issue.code === 'view_table_calculation_unsupported'),
    'Notion import plan must list unsupported table calculation view settings',
  );
  assert(
    planned.plan?.conversion?.warnings?.some((issue) => issue.code === 'view_property_width_unsupported'),
    'Notion import plan must list unsupported property width view settings',
  );
  assert(
    planned.plan?.conversion?.warnings?.some((issue) => issue.code === 'view_property_layout_unavailable'),
    'Notion import plan must list table view layout fallbacks when Notion does not expose property order',
  );
  assert(
    planned.plan?.conversion?.unsupported?.some((issue) => issue.code === 'formula_function_unsupported'),
    'Notion import plan must list unsupported formula functions',
  );
  assert(
    planned.plan?.conversion?.warnings?.some((issue) => issue.code === 'page_children_truncated') &&
      planned.plan?.conversion?.warnings?.some((issue) => issue.code === 'data_source_rows_truncated') &&
      planned.plan?.conversion?.warnings?.some((issue) => issue.code === 'data_source_views_truncated'),
    'Notion import plan must list page/data-source discovery truncation warnings',
  );
  assert(planned.job?.report?.plan?.estimatedWrites?.databases === 3, 'Notion import plan must be persisted into the job report');
  assertJobProgress(planned.job, 'review', 'completed', 60, 'planned Notion imports', [
    { key: 'discover', status: 'completed' },
    { key: 'review', status: 'completed' },
  ]);
  await assertOrganizationAuditEvent(baseUrl, owner.token, organizationId, {
    action: 'notion_import.plan',
    targetType: 'notion_import_job',
    targetId: snapshotJobId,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.estimatedWrites?.databases === 3 &&
      event.metadata?.conversionSummary?.unsupportedBlocks >= 1,
    message: 'Notion import plan must record estimated writes and conversion summary in organization audit',
  });
  console.log('PASS Notion import dry-run review estimates writes and conversion issues before apply.');

  const applied = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'apply',
    workspaceId,
    jobId: snapshotJobId,
  });
  assert(applied.job?.status === 'completed', 'Notion import apply must complete the job');
  assertJobProgress(applied.job, 'apply', 'completed', 100, 'applied Notion imports', [
    { key: 'discover', status: 'completed' },
    { key: 'review', status: 'completed' },
    { key: 'apply', status: 'completed' },
  ]);
  await assertOrganizationAuditEvent(baseUrl, owner.token, organizationId, {
    action: 'notion_import.apply',
    targetType: 'notion_import_job',
    targetId: snapshotJobId,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.databases === 3 &&
      event.metadata?.rows === 4,
    message: 'Notion import apply must record applied write counts in organization audit',
  });
  assert(applied.applied?.databases === 3, 'Notion import apply must create canonical and placeholder databases');
  assert(applied.applied?.properties >= 7, 'Notion import apply must create database properties');
  assert(applied.applied?.views >= 1, 'Notion import apply must create database views');
  assert(applied.applied?.templates === 1, 'Notion import apply must create imported database templates');
  assert(applied.applied?.rows === 4, 'Notion import apply must create database row pages');
  assert(applied.applied?.pages >= 1, 'Notion import apply must create regular pages');
  assert(applied.applied?.remappedProperties >= 2, 'Notion import apply must remap relation/rollup property config');
  assert(applied.applied?.remappedRowRelations >= 1, 'Notion import apply must remap relation row values');
  assert(applied.applied?.remappedTemplateRelations >= 1, 'Notion import apply must remap template relation defaults');
  assert(
    applied.applied?.unresolvedImportReferences >= 2,
    'Notion import apply must count unresolved row/template relation references',
  );
  assert(
    applied.job?.report?.conversion?.summary?.unsupportedBlocks >= 1,
    'Notion import apply report must count unsupported block fallbacks',
  );
  assert(
    applied.job?.report?.conversion?.summary?.unsupportedProperties >= 1,
    'Notion import apply report must count unsupported property fallbacks',
  );
  assert(
    applied.job?.report?.conversion?.summary?.fileReferences >= 5,
    'Notion import apply report must count preserved file references',
  );
  assert(
    applied.job?.report?.conversion?.summary?.fileCopies >= 5,
    'Notion import apply report must count file references copied into EdgeBase storage',
  );
  assert(
    (applied.job?.report?.conversion?.summary?.fileCopySkipped ?? 0) === 0,
    'Notion import apply must not complete with skipped file copies when storage copy is required',
  );
  assert(
    applied.job?.report?.conversion?.summary?.notionUserReferences >= 2,
    'Notion import apply report must count preserved Notion user references',
  );
  assert(
    applied.job?.report?.conversion?.summary?.remappedRichTextMentions >= 3,
    `Notion import apply report must count remapped rich text page/database mentions; got ${applied.job?.report?.conversion?.summary?.remappedRichTextMentions ?? 0}`,
  );
  assert(
    applied.job?.report?.conversion?.summary?.unresolvedRichTextMentions >= 2,
    'Notion import apply report must count unresolved rich text page/database mentions',
  );
  assert(
    applied.job?.report?.conversion?.summary?.remappedSyncedBlocks >= 1,
    `Notion import apply report must count remapped synced block copies; got ${applied.job?.report?.conversion?.summary?.remappedSyncedBlocks ?? 0}`,
  );
  assert(
    applied.job?.report?.conversion?.summary?.inferredRowSnapshotProperties >= 1,
    'Notion import apply report must count row-only properties inferred from row snapshots',
  );
  assert(
    applied.job?.report?.conversion?.summary?.ignoredStaleHiddenViewPropertySettings >= 1,
    'Notion import apply report must count ignored stale hidden view property settings',
  );
  assert(
    applied.job?.report?.conversion?.summary?.unresolvedViewPropertyReferences >= 1,
    'Notion import apply report must count view settings that reference unknown properties',
  );
  assert(
    applied.job?.report?.conversion?.summary?.unresolvedLinkedTargets >= 1,
    'Notion import apply report must count linked database/page targets missing from the discovered graph',
  );
  assert(
    applied.job?.report?.conversion?.summary?.unresolvedLinkedViews >= 1,
    'Notion import apply report must count linked database views missing from the discovered graph',
  );
  assert(
    applied.job?.report?.conversion?.summary?.unresolvedRowRelationValues >= 1,
    'Notion import apply report must count unresolved row relation values',
  );
  assert(
    applied.job?.report?.conversion?.summary?.unresolvedTemplateRelationValues >= 1,
    'Notion import apply report must count unresolved template relation defaults',
  );
  assert(
    applied.job?.report?.conversion?.summary?.unsupportedViewSettings >= 1,
    'Notion import apply report must count unsupported view settings',
  );
  assert(
    applied.job?.report?.conversion?.summary?.viewPropertyLayoutUnavailable >= 1,
    'Notion import apply report must count table views whose property layout is not exposed by Notion',
  );
  assert(
    applied.job?.report?.conversion?.summary?.discoveryIncomplete >= 3,
    'Notion import apply report must count discovery truncation warnings',
  );
  assert(
    applied.job?.report?.conversion?.summary?.wrappedTabChildren >= 1,
    'Notion import apply report must count non-paragraph tab children wrapped for visible import',
  );
  assert(
    applied.job?.report?.conversion?.unsupported?.some((issue) => issue.code === 'unsupported_block_type'),
    'Notion import apply report must list unsupported block issues',
  );
  assert(
    applied.job?.report?.conversion?.warnings?.some((issue) => issue.code === 'view_table_calculation_unsupported'),
    'Notion import apply report must list unsupported table calculation warnings',
  );
  assert(
    applied.job?.report?.conversion?.warnings?.some((issue) => issue.code === 'view_property_width_unsupported'),
    'Notion import apply report must list unsupported property width warnings',
  );
  assert(
    applied.job?.report?.conversion?.warnings?.some((issue) => issue.code === 'view_property_layout_unavailable'),
    'Notion import apply report must list table view layout fallbacks when Notion does not expose property order',
  );
  assert(
    applied.job?.report?.conversion?.warnings?.some((issue) => issue.code === 'tab_child_wrapped'),
    'Notion import apply report must list non-paragraph tab children wrapped for visible import',
  );
  assert(
    applied.job?.report?.conversion?.unsupported?.some((issue) =>
      issue.code === 'unsupported_block_type' &&
        /internal block type "form"/.test(issue.message ?? '')
    ),
    'Notion import apply report must preserve Notion unsupported.block_type context',
  );
  assert(
    applied.job?.report?.conversion?.unsupported?.some((issue) => issue.code === 'unsupported_property_type'),
    'Notion import apply report must list unsupported property issues',
  );
  assert(
    applied.job?.report?.conversion?.summary?.unsupportedFormulaFunctions >= 1 &&
      applied.job.report.conversion.unsupported?.some((issue) => issue.code === 'formula_function_unsupported'),
    'Notion import apply report must list unsupported formula functions',
  );
  assert(
    applied.job?.report?.conversion?.warnings?.some((issue) => issue.code === 'file_reference_copied'),
    'Notion import apply report must list copied file reference warnings',
  );
  assert(
    !applied.job?.report?.conversion?.warnings?.some((issue) => issue.code === 'file_copy_skipped'),
    'Notion import apply report must not preserve skipped file-copy warnings on the successful product path',
  );
  assert(
    applied.job?.report?.conversion?.warnings?.some((issue) => issue.code === 'page_children_truncated') &&
      applied.job?.report?.conversion?.warnings?.some((issue) => issue.code === 'data_source_rows_truncated') &&
      applied.job?.report?.conversion?.warnings?.some((issue) => issue.code === 'data_source_views_truncated'),
    'Notion import apply report must list page/data-source discovery truncation warnings',
  );
  assert(
    applied.job?.report?.conversion?.summary?.unresolvedFormulaPropertyReferences >= 1,
    'Notion import apply report must count formula expressions that reference unknown properties',
  );
  assert(
    applied.job?.report?.conversion?.unresolvedReferences?.some((issue) => issue.code === 'view_property_unresolved'),
    'Notion import apply report must list unresolved view property references',
  );
  assert(
    !applied.job?.report?.conversion?.unresolvedReferences?.some((issue) =>
      /Row-only rollup|notion-prop-row-only-rollup|notion-prop-stale-hidden-view-only/.test(issue.message ?? '')
    ),
    'Notion import apply report must not list row-inferred or ignored stale hidden view properties as unresolved',
  );
  assert(
    applied.job?.report?.conversion?.unresolvedReferences?.some((issue) => issue.code === 'formula_property_unresolved'),
    'Notion import apply report must list unresolved formula property references',
  );
  assert(
    applied.job?.report?.conversion?.unresolvedReferences?.some((issue) => issue.code === 'linked_target_unresolved') &&
      applied.job?.report?.conversion?.unresolvedReferences?.some((issue) => issue.code === 'linked_view_unresolved'),
    'Notion import apply report must list unresolved linked target and linked view references',
  );
  assert(
    applied.job?.report?.conversion?.unresolvedReferences?.some((issue) => issue.code === 'row_relation_values_unresolved'),
    'Notion import apply report must list unresolved row relation values',
  );
  assert(
    applied.job?.report?.conversion?.unresolvedReferences?.some((issue) => issue.code === 'template_relation_values_unresolved'),
    'Notion import apply report must list unresolved template relation defaults',
  );
  assert(
    applied.job?.report?.conversion?.unresolvedReferences?.some((issue) => issue.code === 'rich_text_mention_unresolved'),
    'Notion import apply report must list unresolved rich text page/database mentions',
  );
  assert(
    applied.mappings?.some((mapping) => mapping.notionId === 'notion-ds-tasks' && mapping.localType === 'database'),
    'Notion import apply must create a canonical data source mapping',
  );
  const taskDatabaseId = mappingLocalId(applied, 'notion-ds-tasks', 'database');
  const projectDatabaseId = mappingLocalId(applied, 'notion-ds-projects', 'database');
  const projectRowId = mappingLocalId(applied, 'notion-project-alpha', 'page');
  const rootPageId = mappingLocalId(applied, 'notion-page-root', 'page');
  const childPageBoundaryId = mappingLocalId(applied, 'notion-block-child-page-boundary', 'page');
  const taskViewId = mappingLocalId(applied, 'notion-view-table', 'db_view');
  const taskBoardViewId = mappingLocalId(applied, 'notion-view-board', 'db_view');
  const taskRollupLinkedViewId = mappingLocalId(applied, 'notion-view-rollup-linked', 'db_view');
  const hiddenInlineDatabaseId = mappingLocalId(applied, 'notion-db-hidden-inline-placeholder', 'database');
  const rootPage = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'page',
    pageId: rootPageId,
  });
  // pageId-only page-query resolves the owning workspace through the central
  // page_workspace_index — so this call passing proves the imported root page
  // was indexed (written per-page during apply, not only at the batch end).
  assert(rootPage.page?.id === rootPageId, 'Imported root page must resolve by pageId-only routing (page_workspace_index)');

  // Recovery action re-derives the index from this workspace's import mappings
  // (heals older/interrupted imports whose pages were left unindexed).
  const repair = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'repairPageIndexes',
    workspaceId,
  });
  assert(
    typeof repair.repaired === 'number' && repair.repaired >= 1,
    `repairPageIndexes must re-index the imported pages, got ${JSON.stringify(repair)}`,
  );
  const rootPageAfterRepair = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'page',
    pageId: rootPageId,
  });
  assert(rootPageAfterRepair.page?.id === rootPageId, 'Imported root page must stay openable by pageId after repair');

  assert(rootPage.page?.iconType === 'image', 'Imported page icon type must be preserved as an image icon');
  assert(isStoredFileUrl(rootPage.page?.icon), 'Imported page icon must be copied into local EdgeBase storage');
  assert(isStoredFileUrl(rootPage.page?.cover), 'Imported page cover must be copied into local EdgeBase storage');
  assert(rootPage.page?.coverPosition === 50, 'Imported page cover must use the default focal position');
  assert(rootPage.page?.createdAt === NOTION_IMPORT_CREATED_TIME, 'Imported pages must preserve Notion created_time metadata');
  assert(rootPage.page?.updatedAt === NOTION_IMPORT_EDITED_TIME, 'Imported pages must preserve Notion last_edited_time metadata');
  assert(
    rootPage.page?.isFavorite === true,
    'Explicit Notion import root pages should be anchored in Favorites because the Notion API does not expose favorite state',
  );
  assert(
    rootPage.page?.fullWidth === true,
    'Imported non-row pages with Notion column_list layout must preserve dashboard-style full-width rendering',
  );
  const taskSnapshot = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'database',
    databaseId: taskDatabaseId,
  });
  const projectSnapshot = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'database',
    databaseId: projectDatabaseId,
  });
  const taskProps = taskSnapshot.properties ?? [];
  const taskTemplates = taskSnapshot.templates ?? [];
  const projectProps = projectSnapshot.properties ?? [];
  const relationProp = propByName(taskProps, 'Project');
  const assetsProp = propByName(taskProps, 'Assets');
  const assigneeProp = propByName(taskProps, 'Assignee');
  const estimateProp = propByName(taskProps, 'Estimate');
  const taskIdProp = propByName(taskProps, 'Task ID');
  const statusProp = propByName(taskProps, 'Status');
  const fundingTypeProp = propByName(taskProps, 'Funding type');
  const formulaProp = propByName(taskProps, 'Name formula');
  const idFormulaProp = propByName(taskProps, 'ID formula');
  const blockTokenFormulaProp = propByName(taskProps, 'Block token formula');
  const brokenFormulaProp = propByName(taskProps, 'Broken formula');
  const unsupportedFormulaProp = propByName(taskProps, 'Unsupported formula');
  const rollupProp = propByName(taskProps, 'Project name rollup');
  const projectRelationRollupProp = propByName(taskProps, 'Project relation rollup');
  const ifsFormulaProp = propByName(taskProps, 'Status label formula');
  const complexFormulaProp = propByName(taskProps, 'Complex formula');
  const importedRollupFallbackProp = propByName(taskProps, 'Imported rollup fallback');
  const rowOnlyRollupProp = propByName(taskProps, 'Row-only rollup');
  const projectNameProp = propByName(projectProps, 'Name');
  const taskTableView = (taskSnapshot.views ?? []).find((view) => view.name === 'All tasks');
  const inferredPurchaseInvoiceView = (taskSnapshot.views ?? []).find((view) => view.name === 'Purchase invoice');
  const inferredCollectionView = (taskSnapshot.views ?? []).find((view) => view.name === '수금');
  const inferredPaymentView = (taskSnapshot.views ?? []).find((view) => view.name === '지급');
  const inferredSyntheticExpenseView = (taskSnapshot.views ?? []).find((view) => view.name === '가상 지출');
  const taskRollupLinkedView = (taskSnapshot.views ?? []).find((view) => view.id === taskRollupLinkedViewId);
  assert(taskTableView, 'Notion import apply must create the imported task table view');
  assert(inferredPurchaseInvoiceView, 'Notion import apply must create the inferred-filter task table view');
  assert(inferredCollectionView, 'Notion import apply must create the Korean collection inferred-filter view');
  assert(inferredPaymentView, 'Notion import apply must create the Korean payment inferred-filter view');
  assert(inferredSyntheticExpenseView, 'Notion import apply must create the synthetic expense inferred-filter view');
  assert(taskRollupLinkedView, 'Notion import apply must create the API-linked rollup-filtered task view');
  assert(
    taskTableView.config?.sorts?.[0]?.propertyId === statusProp.id &&
      taskTableView.config?.sorts?.[0]?.direction === 'desc',
    'Imported Notion view sorts must be remapped to local property ids',
  );
  assert(
    Array.isArray(taskTableView.config?.visibleProperties) &&
      taskTableView.config.visibleProperties[0] === statusProp.id &&
      taskTableView.config.visibleProperties[1] === relationProp.id,
    'Imported Notion visible property order must be remapped to local property ids',
  );
  assert(
    Array.isArray(taskTableView.config?.hiddenProperties) &&
      taskTableView.config.hiddenProperties[0] === assetsProp.id,
    'Imported Notion hidden properties must be remapped to local property ids',
  );
  assert(
    Array.isArray(taskTableView.config?.propertyOrder) &&
      taskTableView.config.propertyOrder[0] === statusProp.id &&
      taskTableView.config.propertyOrder[1] === relationProp.id,
    'Imported Notion property order must be remapped to local property ids',
  );
  assert(
      taskTableView.config?.propertyWidths?.[statusProp.id] === 180 &&
      taskTableView.config?.propertyWidths?.[relationProp.id] === 220 &&
      taskTableView.config?.propertyWidths?.[rowOnlyRollupProp.id] === 140 &&
      taskTableView.config?.propertyWidths?.[formulaProp.id] === undefined,
    'Imported Notion property widths, including row-inferred properties, must be remapped to local property ids',
  );
  assert(
    taskTableView.config?.tableCalculations?.[statusProp.id] === 'count_all' &&
      taskTableView.config?.tableCalculations?.[relationProp.id] === 'count_values' &&
      taskTableView.config?.tableCalculations?.[assetsProp.id] === 'count_empty' &&
      taskTableView.config?.tableCalculations?.[assigneeProp.id] === 'count_unique' &&
      taskTableView.config?.tableCalculations?.[estimateProp.id] === 'sum' &&
      taskTableView.config?.tableCalculations?.[rowOnlyRollupProp.id] === 'sum' &&
      taskTableView.config?.tableCalculations?.[formulaProp.id] === undefined,
    'Imported Notion table calculations, including row-inferred numeric SUM summaries, must be normalized and remapped to local property ids',
  );
  assert(
    taskTableView.config?.wrappedColumns?.[0] === formulaProp.id,
    'Imported Notion wrapped columns from nested layout settings must be remapped to local property ids',
  );
  assert(
    taskTableView.config?.groupBy === statusProp.id &&
      taskTableView.config?.coverProperty === assetsProp.id &&
      taskTableView.config?.dependencyProperty === relationProp.id,
    'Imported Notion view group, cover, and dependency properties must be remapped to local property ids',
  );
  const taskTableFilters = flattenFilters(taskTableView.config?.filterGroup);
  const remappedStatusFilter = taskTableFilters.find(
    (filter) => filter?.propertyId === statusProp.id,
  );
  assert(
    remappedStatusFilter?.operator === 'equals' &&
      remappedStatusFilter?.value === 'status-todo',
    'Imported Notion view filters must be remapped to local property ids',
  );
  assert(
    inferredPurchaseInvoiceView.config?.filterGroup?.filters?.[0]?.propertyId === fundingTypeProp.id &&
      inferredPurchaseInvoiceView.config.filterGroup.filters[0].operator === 'equals' &&
      inferredPurchaseInvoiceView.config.filterGroup.filters[0].value === 'funding-tax-purchase' &&
      inferredPurchaseInvoiceView.config?.inferredFilter?.inferredFrom === 'view_name_select_option',
    'Imported Notion views with missing API filters must infer a select filter from an unambiguous view name',
  );
  assert(
    inferredCollectionView.config?.filterGroup?.filters?.[0]?.propertyId === fundingTypeProp.id &&
      inferredCollectionView.config.filterGroup.filters[0].operator === 'equals' &&
      inferredCollectionView.config.filterGroup.filters[0].value === 'funding-collection' &&
      inferredCollectionView.config?.inferredFilter?.inferredFrom === 'view_name_select_option',
    'Imported collection views with filter:null and quick_filters:null must infer a select filter from the Korean view name',
  );
  assert(
    inferredPaymentView.config?.filterGroup?.filters?.[0]?.propertyId === fundingTypeProp.id &&
      inferredPaymentView.config.filterGroup.filters[0].operator === 'equals' &&
      inferredPaymentView.config.filterGroup.filters[0].value === 'funding-payment' &&
      inferredPaymentView.config?.inferredFilter?.inferredFrom === 'view_name_select_option',
    'Imported payment views with filter:null and quick_filters:null must infer a select filter from the Korean view name',
  );
  assert(
    inferredSyntheticExpenseView.config?.filterGroup?.filters?.[0]?.propertyId === fundingTypeProp.id &&
      inferredSyntheticExpenseView.config.filterGroup.filters[0].operator === 'equals' &&
      inferredSyntheticExpenseView.config.filterGroup.filters[0].value === 'funding-synthetic-expense-ko' &&
      inferredSyntheticExpenseView.config?.inferredFilter?.inferredFrom === 'view_name_select_option',
    'Imported synthetic-expense views with filter:null and quick_filters:null must infer the parenthetical Korean select option',
  );
  const projectFilter = taskTableFilters.find(
    (filter) => filter?.propertyId === relationProp.id,
  );
  assert(
    projectFilter?.operator === 'contains' &&
      projectFilter?.value === projectRowId,
    'Imported Notion relation view filters must remap source page ids to local row ids',
  );
  assert(
    !Array.isArray(taskTableView.config?.quickFilters),
    'Imported Notion quick filters must be normalized into filterGroup, not stored as quickFilters',
  );
  const statusQuickFilter = taskTableFilters.find(
    (filter) => filter?.propertyId === statusProp.id,
  );
  assert(
    statusQuickFilter?.operator === 'equals' &&
      statusQuickFilter?.value === 'status-todo',
    'Imported Notion quick filters must be remapped into filterGroup with local property ids',
  );
  const projectQuickFilter = taskTableFilters.find(
    (filter) => filter?.propertyId === relationProp.id,
  );
  assert(
    projectQuickFilter?.operator === 'contains' &&
      projectQuickFilter?.value === projectRowId,
    'Imported Notion relation quick filters must remap source page ids to local row ids',
  );
  const rollupQuickFilter = flattenFilters(taskRollupLinkedView.config?.filterGroup).find(
    (filter) => filter?.propertyId === projectRelationRollupProp.id,
  );
  assert(
    rollupQuickFilter?.operator === 'contains' &&
      rollupQuickFilter?.value === projectRowId,
    'Imported Notion rollup relation quick filters must remap source page ids to local row ids',
  );
  assert(
      taskTableView.config?.rowHeight === 'tall' &&
      taskTableView.config?.wrap === true &&
      taskTableView.config?.openPageIn === 'side' &&
      taskTableView.config?.timelineZoom === 'week' &&
      taskTableView.config?.cardSize === 'large',
    'Imported Notion view layout options must be normalized into local view config',
  );
  assert(
    relationProp.config?.relationDatabaseId === projectDatabaseId,
    'Notion relation property must be remapped to the local canonical target database',
  );
  assert(
    formulaProp.config?.formula === 'prop("Name")',
    'Notion formula expression must be preserved as local formula config',
  );
  assert(
    idFormulaProp.config?.formula === 'prop("Name")' &&
      idFormulaProp.config?.notionFormulaExpression === 'prop("notion-prop-name")',
    'Notion formula property-id references must be remapped to local property names while preserving the source expression',
  );
  assert(
    blockTokenFormulaProp.config?.formula === 'if(prop("Status") == "To do", prop("Name"), "")' &&
      blockTokenFormulaProp.config?.notionFormulaExpression ===
        'if({{notion:block_property:notion-prop-status:notion-ds-tasks:notion-workspace}} == "To do", {{notion:block_property:notion-prop-name:notion-ds-tasks:notion-workspace}}, "")',
    'Notion internal block_property formula tokens must be remapped to local prop() references while preserving the source expression',
  );
  assert(
    brokenFormulaProp.config?.formula === 'prop("notion-prop-missing-formula")' &&
      brokenFormulaProp.config?.unresolvedFormulaPropertyReferences?.[0] === 'notion-prop-missing-formula',
    'Notion formulas with missing property references must preserve unresolved references in property config',
  );
  assert(
    unsupportedFormulaProp.config?.formula === 'map(prop("Name"))' &&
      unsupportedFormulaProp.config?.unsupportedFormulaFunctions?.[0] === 'map',
    'Notion formulas with unsupported local functions must preserve unsupported function metadata',
  );
  assert(
    ifsFormulaProp.config?.formula ===
      'ifs(prop("Status") == "To do", concat("Todo from ifs ", format(round(sqrt(5), 2)), " ", format(hour(parseDate("2026-06-24T13:45Z")))), true, "Other")',
    'Notion ifs() formula expression must be preserved as local formula config',
  );
  assert(
    complexFormulaProp.config?.formula ===
      'lets(value, prop("Name"), window, dateRange(parseDate("2026-06-24"), parseDate("2026-06-30")), concat(value, repeat("!", 2), " ", format(dateBetween(dateEnd(window), dateStart(window), "days"))))',
    'Notion repeat()/dateRange() formula expression must be preserved as local formula config',
  );
  assert(
    rollupProp.config?.rollupRelationPropertyId === relationProp.id,
    'Notion rollup relation property must be remapped to the local relation property id',
  );
  assert(
    rollupProp.config?.rollupTargetPropertyId === projectNameProp.id,
    'Notion rollup target property must be remapped to the local target property id',
  );
  assert(
    rollupProp.config?.rollupFunction === 'show_original',
    'Notion rollup function must be preserved',
  );
  assert(
    projectRelationRollupProp.config?.rollupRelationPropertyId === relationProp.id,
    'Notion relation-rollup filters must keep the local source relation property id',
  );
  const importedTemplate = taskTemplates.find((template) => template.name === 'Bug report');
  assert(importedTemplate, 'Notion import apply must create database templates from data source snapshots');
  assert(importedTemplate.isDefault === true, 'Imported Notion database template must preserve default state');
  assert(importedTemplate.icon === 'BT', 'Imported Notion database template must preserve icon metadata');
  assert(importedTemplate.title === 'New bug', 'Imported Notion database template must preserve default title');
  assert(
    importedTemplate.properties?.[relationProp.id]?.[0] === projectRowId,
    'Imported Notion database template must remap relation property defaults to local row ids',
  );
  assert(
    importedTemplate.properties?.[relationProp.id]?.length === 1 &&
      !Object.prototype.hasOwnProperty.call(importedTemplate.properties ?? {}, '__notionRelationUnresolved'),
    'Imported Notion database template must drop unresolved relation defaults from template data after reporting them',
  );
  assert(
    importedTemplate.properties?.[assigneeProp.id]?.[0]?.id === 'notion-user:notion-user-ada' &&
      importedTemplate.properties[assigneeProp.id][0].displayName === 'Ada Importer',
    'Imported Notion database template must preserve Notion person defaults',
  );
  assert(
    taskIdProp.config?.idPrefix === 'TASK',
    'Imported Notion unique_id properties must preserve their prefix configuration',
  );
  assert(
    Array.isArray(importedTemplate.blocks) &&
      importedTemplate.blocks[0]?.plainText === 'Steps to reproduce for Alpha project',
    'Imported Notion database template must preserve template body blocks',
  );
  assert(
    importedTemplate.blocks?.[0]?.content?.rich?.some((span) =>
      span.text === 'Alpha project' &&
      span.mention === 'page' &&
      span.pageId === projectRowId &&
      span.notionPageId === 'notion-project-alpha'
    ),
    'Imported Notion database template rich text page mentions must remap to local row page ids',
  );
  const unresolvedTemplateMentionBlock = importedTemplate.blocks?.find(
    (block) => block.plainText === 'Template unresolved mention: Missing template page',
  );
  assert(
    unresolvedTemplateMentionBlock?.content?.rich?.some((span) =>
      span.text === 'Missing template page' &&
      span.notionPageId === 'notion-page-missing-template-mention' &&
      !span.pageId
    ),
    'Imported Notion database template must preserve unresolved rich text page mentions without linking them to a local page',
  );
  const templatedRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    databaseId: taskDatabaseId,
    templateId: importedTemplate.id,
  });
  assert(templatedRow.row?.title === 'New bug', 'Rows created from imported templates must use the template title');
  assert(templatedRow.row?.icon === 'BT', 'Rows created from imported templates must use the template icon');
  assert(
    templatedRow.row?.properties?.[relationProp.id]?.[0] === projectRowId,
    'Rows created from imported templates must apply remapped relation defaults',
  );
  assert(
    templatedRow.row?.properties?.[assigneeProp.id]?.[0]?.id === 'notion-user:notion-user-ada',
    'Rows created from imported templates must apply preserved Notion person defaults',
  );
  assert(
    templatedRow.row?.properties?.[taskIdProp.id] === 43,
    'Rows created after import must continue from imported Notion unique_id numbers',
  );
  assert(
    templatedRow.blocks?.[0]?.plainText === 'Steps to reproduce for Alpha project',
    'Rows created from imported templates must insert the imported template body',
  );
  assert(
    templatedRow.blocks?.[0]?.content?.rich?.some((span) =>
      span.text === 'Alpha project' &&
      span.mention === 'page' &&
      span.pageId === projectRowId
    ),
    'Rows created from imported templates must preserve remapped rich text page mentions',
  );
  const taskRows = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'databaseRows',
    databaseId: taskDatabaseId,
    includeComputed: true,
  });
  const alphaTask = (taskRows.rows ?? []).find((row) => row.title === 'Alpha task');
  assert(alphaTask, 'Imported task row must be readable through page-query');
  assert(alphaTask.iconType === 'image', 'Imported database row icon type must be preserved as an image icon');
  assert(isStoredFileUrl(alphaTask.icon), 'Imported database row icon must be copied into local EdgeBase storage');
  assert(isStoredFileUrl(alphaTask.cover), 'Imported database row cover must be copied into local EdgeBase storage');
  assert(
    Array.isArray(alphaTask.properties?.[relationProp.id]) &&
      alphaTask.properties[relationProp.id][0] === projectRowId,
    'Imported relation row value must use the local project row id',
  );
  assert(
    alphaTask.properties?.[relationProp.id]?.length === 1 &&
      alphaTask.properties?.__notionRelationUnresolved?.[relationProp.id]?.includes('notion-project-missing-row'),
    'Imported rows must drop unresolved relation row values from active relations while preserving unresolved Notion ids for reporting',
  );
  assert(
    Array.isArray(alphaTask.properties?.[assetsProp.id]) &&
      alphaTask.properties[assetsProp.id].length >= 2 &&
      alphaTask.properties[assetsProp.id].every((file) => isStoredFileUrl(file.url)) &&
      alphaTask.properties[assetsProp.id].every((file) =>
        !file.sourceUrl && !file.notionFile && !file.notionFileExpiryTime
      ),
    'Imported files property must use local storage without retaining source credentials or temporary URLs',
  );
  assert(
    alphaTask.properties?.[assigneeProp.id]?.[0]?.id === 'notion-user:notion-user-ada' &&
      alphaTask.properties[assigneeProp.id][0].email === 'ada@example.com',
    'Imported people property must preserve Notion user references and email metadata',
  );
  assert(
    alphaTask.properties?.[taskIdProp.id] === 42,
    'Imported rows must preserve Notion unique_id numbers as local unique ID values',
  );
  assert(
    alphaTask.properties?.[rowOnlyRollupProp.id] === 7,
    'Imported rows must preserve row-only properties inferred from Notion row snapshots',
  );
  assert(alphaTask.createdAt === NOTION_IMPORT_ROW_CREATED_TIME, 'Imported row pages must preserve Notion created_time metadata');
  assert(alphaTask.updatedAt === NOTION_IMPORT_ROW_EDITED_TIME, 'Imported row pages must preserve Notion last_edited_time metadata');
  assert(
    taskRows.computed?.[alphaTask.id]?.[formulaProp.id]?.formatted === 'Alpha task',
    'Imported formula properties must still compute locally when the expression is supported',
  );
  assert(
    taskRows.computed?.[alphaTask.id]?.[idFormulaProp.id]?.formatted === 'Alpha task',
    'Imported formula properties must compute locally after Notion property-id references are remapped',
  );
  assert(
    taskRows.computed?.[alphaTask.id]?.[blockTokenFormulaProp.id]?.formatted === 'Alpha task',
    'Imported formula properties must compute locally after Notion internal block_property tokens are remapped',
  );
  assert(
    taskRows.computed?.[alphaTask.id]?.[unsupportedFormulaProp.id]?.formatted === 'Unsupported formula from Notion',
    'Imported unsupported formula functions must fall back to preserved Notion computed values',
  );
  assert(
    taskRows.computed?.[alphaTask.id]?.[ifsFormulaProp.id]?.formatted === 'Todo from ifs 2.24 13',
    'Imported ifs() formula properties must compute locally when the expression is supported',
  );
  assert(
    taskRows.computed?.[alphaTask.id]?.[rollupProp.id]?.formatted === 'Alpha project',
    'Imported rollup properties must still compute locally when relation and target properties are remapped',
  );
  assert(
    taskRows.computed?.[alphaTask.id]?.[complexFormulaProp.id]?.formatted === 'Alpha task!! 6',
    'Imported lets()/repeat()/dateRange() formula properties must compute locally when the expression is supported',
  );
  assert(
    taskRows.computed?.[alphaTask.id]?.[importedRollupFallbackProp.id]?.formatted === 'Fallback rollup from Notion',
    'Imported rollup properties must fall back to preserved Notion computed values when local rollup remapping cannot evaluate them',
  );
  const alphaTaskBlocks = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'blocks',
    pageId: alphaTask.id,
  });
  const alphaTaskProjectBlock = (alphaTaskBlocks.blocks ?? []).find((block) => block.plainText === 'Related project: Alpha project');
  assert(alphaTaskProjectBlock, 'Imported row pages must preserve Notion row body blocks');
  assert(
    alphaTaskProjectBlock.content?.rich?.some((span) =>
      span.text === 'Alpha project' &&
      span.mention === 'page' &&
      span.pageId === projectRowId &&
      span.notionPageId === 'notion-project-alpha'
    ),
    `Imported row page rich text page mentions must remap to local row page ids; got ${JSON.stringify(alphaTaskProjectBlock.content?.rich ?? [])}`,
  );
  const rootBlocks = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'blocks',
    pageId: rootPageId,
  });
  const childPageBoundary = (rootBlocks.blocks ?? []).find((block) =>
    block.type === 'child_page' &&
      block.plainText === 'Child page boundary'
  );
  assert(childPageBoundary, 'Imported child_page blocks must preserve their title as a page-link row');
  assert(
    childPageBoundary.content?.childPageId === childPageBoundaryId &&
      childPageBoundary.content?.childPageIcon === '📋' &&
      childPageBoundary.content?.childPageIconType === 'emoji',
    'Imported child_page blocks must remap deferred page targets and display the linked page icon',
  );
  assert(
    !(rootBlocks.blocks ?? []).some((block) => block.parentId === childPageBoundary.id),
    'Imported child_page blocks must not import nested child blocks into the parent page body',
  );
  assert(
    !(rootBlocks.blocks ?? []).some((block) => block.plainText === 'This belongs inside the child page, not the parent.'),
    'Imported child_page children must stay behind the child page boundary instead of leaking into the parent page',
  );
  const childDatabaseBoundary = (rootBlocks.blocks ?? []).find((block) =>
    block.type === 'child_database' &&
      block.plainText === 'Full page database boundary'
  );
  assert(childDatabaseBoundary, 'Imported non-inline child_database blocks must preserve their title as a database-link row');
  assert(
    childDatabaseBoundary.content?.childPageId === taskDatabaseId,
    'Imported non-inline child_database blocks must link to the local canonical database page without expanding inline',
  );
  assert(
    !(rootBlocks.blocks ?? []).some((block) => block.parentId === childDatabaseBoundary.id),
    'Imported non-inline child_database blocks must not import nested database blocks into the parent page body',
  );
  assert(
    !(rootBlocks.blocks ?? []).some((block) => block.plainText === 'This belongs inside the child database, not the parent.'),
    'Imported child_database children must stay behind the child database boundary instead of leaking into the parent page',
  );
  assert(
    !(rootBlocks.blocks ?? []).some((block) =>
      block.type === 'column' &&
        !block.parentId &&
        block.content?.notionBlock?.id === 'notion-block-empty-top-level-column'
    ),
    'Imported pages must ignore empty top-level Notion column fragments that are not attached to a column_list',
  );
  const introBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Imported from Notion API for Ada Importer on January 2, 2025. See Tasks.');
  assert(introBlock, 'Imported page must preserve rich text paragraph plain text');
  const introRich = introBlock.content?.rich ?? [];
  assert(
    introRich.some((span) => span.text === 'Imported' && span.bold === true && span.color === 'blue'),
    'Imported Notion rich text must preserve bold/color annotations',
  );
  assert(
    introRich.some((span) =>
      span.text === 'Notion API' &&
      span.underline === true &&
      span.link === 'https://developers.notion.com/'
    ),
    'Imported Notion rich text must preserve links and underline annotations',
  );
  assert(
    introRich.some((span) =>
      span.text === 'Ada Importer' &&
      span.italic === true &&
      span.mention === 'person' &&
      span.userId === 'notion-user:notion-user-ada' &&
      span.notionUser?.email === 'ada@example.com'
    ),
    'Imported Notion rich text must preserve user mentions as stable Notion user references',
  );
  assert(
    introRich.some((span) =>
      span.text === 'January 2, 2025' &&
      span.mention === 'date' &&
      span.date === '2025-01-02'
    ),
    'Imported Notion rich text must preserve date mentions',
  );
  assert(
    introRich.some((span) =>
      span.text === 'Tasks' &&
      span.mention === 'page' &&
      span.pageId === taskDatabaseId &&
      span.notionDataSourceId === 'notion-ds-tasks'
    ),
    'Imported Notion rich text data source mentions must remap to local database page ids',
  );
  const unresolvedMentionBlock = (rootBlocks.blocks ?? []).find(
    (block) => block.plainText === 'Unresolved mention target: Missing page',
  );
  assert(
    unresolvedMentionBlock?.content?.rich?.some((span) =>
      span.text === 'Missing page' &&
      span.notionPageId === 'notion-page-missing-rich-mention' &&
      !span.pageId
    ),
    'Imported Notion page blocks must preserve unresolved rich text page mentions without linking them to a local page',
  );
  const coloredParagraphBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Colored import paragraph');
  assert(
    coloredParagraphBlock?.content?.color === 'blue_background',
    'Imported Notion block colors must preserve local block color tokens',
  );
  const calloutBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Remember import colors');
  assert(
    calloutBlock?.type === 'callout' &&
      calloutBlock.content?.color === 'green_background' &&
      calloutBlock.content?.icon === '🧭',
    'Imported Notion callouts must preserve color and emoji icon metadata',
  );
  const linkPreviewBlock = (rootBlocks.blocks ?? []).find((block) => block.content?.url === SYNTHETIC_LINK_PREVIEW_URL);
  assert(
    linkPreviewBlock?.type === 'bookmark' &&
      linkPreviewBlock.plainText === SYNTHETIC_LINK_PREVIEW_URL &&
      linkPreviewBlock.content?.notionBlock?.type === 'link_preview',
    'Imported Notion link_preview blocks must preserve their URL as local bookmark blocks',
  );
  const unsupportedNotionBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Unsupported Notion block: form');
  assert(
    unsupportedNotionBlock?.type === 'paragraph' &&
      unsupportedNotionBlock.content?.notionBlock?.type === 'unsupported' &&
      unsupportedNotionBlock.content?.notionBlock?.unsupported?.block_type === 'form',
    'Imported Notion unsupported blocks must preserve unsupported.block_type context in fallback blocks',
  );
  const partialNotionButtonBlock = (rootBlocks.blocks ?? []).find((block) => block.content?.notionBlock?.id === 'notion-block-unsupported-button');
  assert(
    partialNotionButtonBlock?.type === 'button' &&
      partialNotionButtonBlock.content?.buttonLabel === 'Notion button' &&
      partialNotionButtonBlock.content?.notionButtonPartial === true &&
      Array.isArray(partialNotionButtonBlock.content?.buttonTemplate) &&
      partialNotionButtonBlock.content.buttonTemplate.length === 0,
    'API-hidden Notion button blocks must import as disabled partial buttons without inventing a default local action',
  );
  const templateButtonBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Add project follow-up');
  const templateButtonTemplate = templateButtonBlock?.content?.buttonTemplate?.[0];
  assert(
    templateButtonBlock?.type === 'button' &&
      templateButtonBlock.content?.buttonLabel === 'Add project follow-up' &&
      templateButtonTemplate?.type === 'to_do' &&
      templateButtonTemplate.content?.checked === false &&
      templateButtonTemplate.content?.rich?.some((span) =>
        span.text === 'Alpha project' &&
          span.mention === 'page' &&
          span.pageId === projectRowId
      ),
    'Imported Notion template blocks must become local button blocks with remapped template body mentions',
  );
  assert(
    !(rootBlocks.blocks ?? []).some((block) => block.plainText === 'Template follow-up for Alpha project'),
    'Imported Notion template children must stay inside buttonTemplate instead of being inserted as page child blocks',
  );
  const toggleHeadingBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Toggle heading import');
  const toggleHeadingChildBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Inside toggle heading');
  assert(
    toggleHeadingBlock?.type === 'toggle_heading_2' &&
      toggleHeadingChildBlock?.parentId === toggleHeadingBlock.id,
    'Imported Notion toggleable heading blocks must become local toggle heading blocks with nested children',
  );
  const headingFourBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Fine-grained heading import');
  assert(
    headingFourBlock?.type === 'heading_4',
    'Imported Notion heading_4 blocks must preserve their dedicated local heading_4 type',
  );
  const toggleHeadingFourBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Tiny toggle heading import');
  const toggleHeadingFourChildBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Inside tiny toggle heading');
  assert(
    toggleHeadingFourBlock?.type === 'toggle_heading_4' &&
      toggleHeadingFourChildBlock?.parentId === toggleHeadingFourBlock.id,
    'Imported Notion toggleable heading_4 blocks must become local toggle_heading_4 blocks with nested children',
  );
  const meetingNotesBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Team import sync');
  const meetingNotesChildBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Summary from imported meeting notes');
  assert(
    meetingNotesBlock?.type === 'toggle' &&
      meetingNotesBlock.content?.notionBlock?.type === 'meeting_notes' &&
      meetingNotesBlock.content?.notionBlock?.meeting_notes?.status === 'notes_ready' &&
      meetingNotesChildBlock?.parentId === meetingNotesBlock.id,
    'Imported Notion meeting_notes blocks must become local toggle containers while preserving metadata and nested content',
  );
  const transcriptionBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Customer call transcript');
  const transcriptionChildBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Transcript highlight from customer call');
  assert(
    transcriptionBlock?.type === 'toggle' &&
      transcriptionBlock.content?.notionBlock?.type === 'transcription' &&
      transcriptionBlock.content?.notionBlock?.transcription?.status === 'completed' &&
      transcriptionBlock.content?.notionBlock?.transcription?.source?.name === 'customer-call.mp3' &&
      transcriptionChildBlock?.type === 'quote' &&
      transcriptionChildBlock.parentId === transcriptionBlock.id,
    'Imported Notion transcription blocks must become local toggle containers while preserving source metadata and nested transcript highlights',
  );
  const tabBlock = (rootBlocks.blocks ?? []).find((block) => block.type === 'tab');
  const tabLabelBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Launch');
  const tabContentBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Launch tab content');
  const wrappedTabLabelBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Imported tab 3');
  const wrappedTabContentBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Loose tab quote content');
  assert(
    tabBlock &&
      tabLabelBlock?.parentId === tabBlock.id &&
      tabLabelBlock.content?.icon === '🚀' &&
      tabContentBlock?.parentId === tabLabelBlock.id,
    'Imported Notion tab blocks must preserve paragraph tab labels, tab icons, and nested tab content hierarchy',
  );
  assert(
    tabBlock &&
      wrappedTabLabelBlock?.parentId === tabBlock.id &&
      wrappedTabContentBlock?.type === 'quote' &&
      wrappedTabContentBlock.parentId === wrappedTabLabelBlock.id,
    'Imported Notion tab blocks must wrap non-paragraph direct children in a visible tab label instead of hiding them',
  );
  const syncedSourceChildBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Synced source content');
  const syncedSourceBlock = (rootBlocks.blocks ?? []).find((block) => block.id === syncedSourceChildBlock?.parentId);
  const syncedCopyBlock = (rootBlocks.blocks ?? []).find((block) =>
    block.type === 'synced_block' &&
      block.id !== syncedSourceBlock?.id &&
      block.content?.syncedBlockId === syncedSourceBlock?.id
  );
  assert(
    syncedSourceBlock?.type === 'synced_block' &&
      !syncedSourceBlock.content?.syncedBlockId &&
      syncedSourceChildBlock?.parentId === syncedSourceBlock.id,
    'Imported Notion synced block sources must remain local source blocks with nested source children',
  );
  assert(
    syncedCopyBlock?.content?.syncedPageId === rootPageId &&
      syncedCopyBlock.content?.notionSyncedBlockSourceId === 'notion-block-synced-source',
    'Imported Notion synced block copies must remap to the local source block and source page',
  );
  const toggleBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Nested import checklist');
  const nestedChildBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Verify child block nesting');
  assert(
    toggleBlock &&
      nestedChildBlock &&
      nestedChildBlock.parentId === toggleBlock.id &&
      nestedChildBlock.type === 'to_do' &&
      nestedChildBlock.content?.checked === true,
    'Imported Notion nested block children must preserve local parentId hierarchy and child block content',
  );
  const tableBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Name\tOwner\nLaunch\tAda Importer');
  assert(
    tableBlock &&
      tableBlock.type === 'simple_table' &&
      tableBlock.content?.headerRow === true &&
      tableBlock.content?.headerColumn === false &&
      tableBlock.content?.table?.[0]?.[0] === 'Name' &&
      tableBlock.content?.table?.[1]?.[1] === 'Ada Importer' &&
      !(rootBlocks.blocks ?? []).some((block) => block.parentId === tableBlock.id && block.type === 'paragraph'),
    'Imported Notion table blocks must become local simple_table blocks without leaking table_row children',
  );
  const equationBlock = (rootBlocks.blocks ?? []).find((block) => block.type === 'equation');
  assert(
    equationBlock?.plainText === 'E = mc^2' &&
      equationBlock.content?.expression === 'E = mc^2',
    'Imported Notion equation blocks must preserve their expression as local equation blocks',
  );
  assert(
    (rootBlocks.blocks ?? []).some((block) => block.type === 'table_of_contents') &&
      (rootBlocks.blocks ?? []).some((block) => block.type === 'breadcrumb'),
    'Imported Notion TOC and breadcrumb blocks must preserve their dedicated local block types',
  );
  const columnListBlock = (rootBlocks.blocks ?? []).find((block) => block.type === 'column_list');
  const leftColumnBlock = (rootBlocks.blocks ?? []).find((block) => block.type === 'column' && block.content?.width === 0.4);
  const rightColumnBlock = (rootBlocks.blocks ?? []).find((block) => block.type === 'column' && block.content?.width === 0.6);
  const leftColumnText = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Left import column');
  const rightColumnText = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Right import column');
  assert(
    columnListBlock &&
      leftColumnBlock?.parentId === columnListBlock.id &&
      rightColumnBlock?.parentId === columnListBlock.id &&
      leftColumnText?.parentId === leftColumnBlock.id &&
      rightColumnText?.parentId === rightColumnBlock.id,
    'Imported Notion column lists must preserve column hierarchy, child blocks, and width ratios',
  );
  const fileBlock = (rootBlocks.blocks ?? []).find((block) =>
    block.type === 'file' && block.content?.fileName === 'Source PDF'
  );
  assert(fileBlock, 'Imported page must include the locally copied file block');
  assert(fileBlock.type === 'file', 'Notion PDF blocks must import as local file blocks');
  assert(fileBlock.content?.fileName === 'Source PDF', 'Imported file blocks must preserve a usable filename');
  assert(isStoredFileUrl(fileBlock.content?.url), 'Imported file blocks must point to local EdgeBase storage after apply');
  assert(
    !fileBlock.content?.sourceUrl &&
      !fileBlock.content?.notionFile &&
      !fileBlock.content?.notionFileExpiryTime,
    'Imported file blocks must remove source credentials and temporary Notion file metadata after copy',
  );
  assert(
    !(rootBlocks.blocks ?? []).some((block) => block.content?.url === SYNTHETIC_UNSUPPORTED_FILE_URL),
    'Successful Notion import apply must not leave unsupported source URLs in final file blocks',
  );
  assert(fileBlock.createdAt === NOTION_IMPORT_BLOCK_CREATED_TIME, 'Imported blocks must preserve Notion created_time metadata');
  assert(fileBlock.updatedAt === NOTION_IMPORT_BLOCK_EDITED_TIME, 'Imported blocks must preserve Notion last_edited_time metadata');
  const linkedDbBlock = (rootBlocks.blocks ?? []).find((block) => block.plainText === 'Linked tasks');
  assert(linkedDbBlock, 'Imported page must include a linked database block');
  assert(linkedDbBlock.type === 'inline_database', 'Linked Notion data source block must import as inline_database');
  assert(
    linkedDbBlock.content?.childPageId === taskDatabaseId,
    'Linked database block must point to the local canonical database',
  );
  assert(
    linkedDbBlock.content?.databaseViewId === taskViewId,
    'Linked database block must point to the local imported database view',
  );
  assert(
    linkedDbBlock.content?.linkedDatabaseSource === true &&
      Array.isArray(linkedDbBlock.content?.databaseViewIds) &&
      linkedDbBlock.content.databaseViewIds[0] === taskViewId &&
      linkedDbBlock.content.databaseViewIds.includes(taskBoardViewId),
    'Imported linked database blocks must use native Hanji linked-database fields for source and view tabs',
  );
  const linkedDbMetadata = linkedDbBlock.content?.notionLinkedDatabase;
  assert(
    Array.isArray(linkedDbMetadata?.targetIds) &&
      linkedDbMetadata.targetIds.includes('notion-ds-tasks') &&
      Array.isArray(linkedDbMetadata?.viewIds) &&
      linkedDbMetadata.viewIds[0] === 'notion-view-table' &&
      linkedDbMetadata.viewIds.includes('notion-view-table') &&
      linkedDbMetadata.viewIds.includes('notion-view-board') &&
      linkedDbMetadata.selectedViewId === 'notion-view-table' &&
      linkedDbMetadata.localTargetId === taskDatabaseId &&
      linkedDbMetadata.localTargetType === 'database' &&
      linkedDbMetadata.localViewId === taskViewId &&
      Array.isArray(linkedDbMetadata?.viewReferences) &&
      linkedDbMetadata.viewReferences.some((view) =>
        view.id === 'notion-view-table' &&
        view.name === 'All tasks' &&
        view.type === 'table' &&
        view.layout === 'table' &&
        view.role === 'selected'
      ) &&
      linkedDbMetadata.viewReferences.some((view) =>
        view.id === 'notion-view-board' &&
        view.name === 'By status' &&
        view.type === 'board' &&
        view.layout === 'board' &&
        view.role === 'candidate'
    ),
    'Imported linked database blocks must prioritize the selected Notion view while retaining candidate view metadata for UI reconstruction',
  );
  const hiddenInlineDatabasePage = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'page',
    pageId: hiddenInlineDatabaseId,
  });
  assert(
    hiddenInlineDatabasePage.page?.title === 'Contextual database page',
    `API-hidden inline database placeholders must use the parent page title instead of generic Imported database; got ${hiddenInlineDatabasePage.page?.title}`,
  );
  const contextualPageId = mappingLocalId(applied, 'notion-page-contextual-database', 'page');
  const contextualPageBlocks = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'blocks',
    pageId: contextualPageId,
  });
  const hiddenInlineDatabaseBlock = (contextualPageBlocks.blocks ?? []).find((block) =>
    block.type === 'inline_database' &&
      block.content?.childPageId === hiddenInlineDatabaseId
  );
  assert(
    hiddenInlineDatabaseBlock?.content?.childPageTitle === 'Contextual database page',
    'Imported hidden inline database blocks must snapshot the recovered parent-title fallback',
  );
  const apiLinkedDatabaseBlock = (contextualPageBlocks.blocks ?? []).find((block) =>
    block.type === 'inline_database' &&
      block.content?.childPageId === taskDatabaseId &&
      block.content?.databaseViewId === taskRollupLinkedViewId
  );
  assert(
    apiLinkedDatabaseBlock,
    'API-hidden linked database blocks must use the view whose Notion parent.database_id matches the hidden database container',
  );
  assert(
    apiLinkedDatabaseBlock.content?.linkedDatabaseSource === true &&
      Array.isArray(apiLinkedDatabaseBlock.content?.databaseViewIds) &&
      apiLinkedDatabaseBlock.content.databaseViewIds.includes(taskRollupLinkedViewId),
    'API-hidden linked database blocks must be represented through native Hanji linked-database fields',
  );
  const apiLinkedDatabaseMapping = (applied.mappings ?? []).find((mapping) =>
    mapping.notionId === 'notion-db-api-linked-inline' && mapping.localType === 'database'
  );
  assert(
    apiLinkedDatabaseMapping?.localId === taskDatabaseId &&
      apiLinkedDatabaseMapping.relationKind === 'database_container_inferred_from_view_context' &&
      apiLinkedDatabaseMapping.metadata?.sourceUnavailable === true,
    'API-hidden linked database containers must map to the canonical data source instead of creating parent-title placeholders',
  );
  const taskSourcePage = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'page',
    pageId: taskDatabaseId,
  });
  assert(
    taskSourcePage.page?.parentId !== contextualPageId,
    'API-hidden linked database containers must not reparent the canonical source database under the row page',
  );
  const rollupFilteredRows = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'databaseRows',
    databaseId: taskDatabaseId,
    viewId: taskRollupLinkedViewId,
  });
  assert(
    (rollupFilteredRows.rows ?? []).some((row) => row.title === 'Alpha task') &&
      !(rollupFilteredRows.rows ?? []).some((row) => row.title === 'Beta task'),
    'Imported Notion rollup quick filters must scope linked database rows through relation rollup targets',
  );

  const forcedRepairFirst = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'repairImportedPageBlocks',
    workspaceId,
    jobId: snapshotJobId,
    maxPages: 1,
    force: true,
  });
  assert(forcedRepairFirst.repaired?.pages === 1, 'Forced Notion import repair must repair one page when maxPages is 1');
  assert(forcedRepairFirst.partial === true, 'Forced Notion import repair must report more pages when stopped by maxPages');
  assert(
    forcedRepairFirst.nextCursor?.startAfterNotionPageId &&
      forcedRepairFirst.nextCursor?.startAfterLocalPageId,
    'Forced Notion import repair must return a resume cursor when partial',
  );
  const forcedRepairSecond = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'repairImportedPageBlocks',
    workspaceId,
    jobId: snapshotJobId,
    maxPages: 1,
    force: true,
    ...forcedRepairFirst.nextCursor,
  });
  assert(forcedRepairSecond.repaired?.pages === 1, 'Forced Notion import repair must resume and repair the next page');
  assert(
    forcedRepairSecond.lastRepaired?.notionPageId &&
      forcedRepairSecond.lastRepaired.notionPageId !== forcedRepairFirst.lastRepaired?.notionPageId,
    'Forced Notion import repair cursor must avoid repeating the first repaired page',
  );

  const reapplied = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'apply',
    workspaceId,
    jobId: snapshotJobId,
  });
  assert(reapplied.job?.status === 'completed', 'completed Notion import must remain completed when reapplied');
  assert(reapplied.applied?.databases === 3, 'completed Notion import must return prior apply counts');
  console.log('PASS Notion import snapshot apply creates canonical local pages, databases, views, templates, rows, relation remaps, and mappings.');

  const mcpSnapshot = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    mcpFetches: [syntheticMcpHiddenDatabaseFetch(), syntheticMcpRowPageFetch()],
  });
  const mcpSnapshotJobId = mcpSnapshot?.job?.id;
  assert(mcpSnapshotJobId, 'MCP-assisted Notion import must create a snapshot job');
  assert(mcpSnapshot.job.status === 'ready', 'MCP-assisted Notion import must be ready to apply');
  assert(
    mcpSnapshot.items?.some(
      (item) =>
        item.notionObject === 'data_source' &&
        item.notionId === SYNTHETIC_MCP_DATA_SOURCE_ID,
    ),
    'MCP-assisted Notion import must discover API-hidden collection data sources',
  );
  const mcpPlanned = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'plan',
    workspaceId,
    jobId: mcpSnapshotJobId,
  });
  assert(mcpPlanned.plan?.estimatedWrites?.databases === 1, 'MCP-assisted Notion import must plan the hidden collection as a database');
  assert(mcpPlanned.plan?.estimatedWrites?.rows === 1, 'MCP-assisted Notion import must plan MCP row page snapshots');
  assert(mcpPlanned.plan?.estimatedWrites?.views === 1, 'MCP-assisted Notion import must plan MCP view snapshots');
  assert(mcpPlanned.plan?.estimatedWrites?.properties >= 7, 'MCP-assisted Notion import must plan MCP schema properties');
  const mcpApplied = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'apply',
    workspaceId,
    jobId: mcpSnapshotJobId,
  });
  assert(mcpApplied.job?.status === 'completed', 'MCP-assisted Notion import apply must complete');
  assert(mcpApplied.applied?.databases === 1, 'MCP-assisted Notion import apply must create a canonical database');
  assert(mcpApplied.applied?.rows === 1, 'MCP-assisted Notion import apply must create MCP row page snapshots');
  assert(mcpApplied.applied?.views === 1, 'MCP-assisted Notion import apply must create the MCP table view');
  assert(mcpApplied.applied?.properties >= 7, 'MCP-assisted Notion import apply must create MCP schema properties');
  const mcpDatabaseId = mappingLocalId(mcpApplied, SYNTHETIC_MCP_DATA_SOURCE_ID, 'database');
  const mcpDatabase = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'database',
    databaseId: mcpDatabaseId,
  });
  const mcpProps = mcpDatabase.properties ?? [];
  const mcpAmountProp = propByName(mcpProps, '가상금액');
  const mcpRelationProp = propByName(mcpProps, '샘플연결');
  const mcpRollupProp = propByName(mcpProps, '연결대상명');
  const mcpDateProp = propByName(mcpProps, '기준일');
  const mcpView = (mcpDatabase.views ?? []).find((view) => view.name === '가상 기본 보기');
  assert(mcpAmountProp.type === 'number', 'MCP-assisted Notion import must preserve number schema types');
  assert(
    mcpAmountProp.config?.notion?.number?.format === 'won',
    'MCP-assisted Notion import must preserve Notion number formats from MCP schema',
  );
  assert(
    mcpRelationProp.type === 'relation' &&
      mcpRelationProp.config?.relationTargetNotionId === SYNTHETIC_MCP_RELATION_SOURCE_ID,
    'MCP-assisted Notion import must preserve relation targets from collection schema',
  );
  assert(
    mcpRollupProp.type === 'rollup' &&
      mcpRollupProp.config?.rollupRelationPropertyNotionId === 'synthetic-relation' &&
      mcpRollupProp.config?.rollupTargetPropertyNotionId === 'synthetic-target-title',
    'MCP-assisted Notion import must preserve rollup relation and target property references',
  );
  assert(mcpView, 'MCP-assisted Notion import must create the default MCP view');
  assert(
    Array.isArray(mcpView.config?.sorts) &&
      mcpView.config.sorts[0]?.propertyId === mcpDateProp.id &&
      mcpView.config.sorts[0]?.direction === 'desc',
    'MCP-assisted Notion import must remap MCP view sorts to local property ids',
  );
  const mcpRowPageId = mappingLocalId(mcpApplied, SYNTHETIC_MCP_ROW_PAGE_ID, 'page');
  const mcpRowPage = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'page',
    pageId: mcpRowPageId,
  });
  assert(
    mcpRowPage.page?.parentType === 'database' &&
      mcpRowPage.page?.parentId === mcpDatabaseId,
    'MCP-assisted Notion row snapshots must import as database rows',
  );
  assert(
    mcpRowPage.page?.properties?.[mcpAmountProp.id] === SYNTHETIC_MCP_ROW_AMOUNT,
    'MCP-assisted Notion row snapshots must preserve number values',
  );
  assert(
    mcpRowPage.page?.properties?.[propByName(mcpProps, '처리단계').id] === SYNTHETIC_MCP_ROW_STATUS,
    'MCP-assisted Notion row snapshots must preserve select labels',
  );
  assert(
    mcpRowPage.page?.properties?.[mcpDateProp.id]?.start === SYNTHETIC_MCP_ROW_DATE,
    'MCP-assisted Notion row snapshots must preserve expanded date properties',
  );
  console.log('PASS MCP-assisted Notion import recovers API-hidden database schema, row values, relation, rollup, and view metadata.');

  const directMcpSnapshot = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    mcpFetches: [syntheticMcpDirectDataSourceFetch()],
  });
  const directMcpJobId = directMcpSnapshot?.job?.id;
  assert(directMcpJobId, 'direct MCP data source snapshot must create a job');
  assert(
    directMcpSnapshot.items?.some(
      (item) =>
        item.notionObject === 'data_source' &&
        item.notionId === SYNTHETIC_MCP_DIRECT_SOURCE_ID,
    ),
    'direct MCP data source snapshot must discover collection fetch payloads without a database wrapper',
  );
  const directMcpApply = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'apply',
    workspaceId,
    jobId: directMcpJobId,
  });
  const directMcpDatabaseId = mappingLocalId(
    directMcpApply,
    SYNTHETIC_MCP_DIRECT_SOURCE_ID,
    'database',
  );
  const directMcpDatabase = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'database',
    databaseId: directMcpDatabaseId,
  });
  assert(
    propByName(directMcpDatabase.properties ?? [], '기록명').type === 'title',
    'direct MCP data source snapshots must preserve title properties',
  );
  assert(
    propByName(directMcpDatabase.properties ?? [], '가상분류').type === 'select',
    'direct MCP data source snapshots must preserve select properties',
  );
  console.log('PASS direct collection:// MCP fetch payloads import without a database wrapper.');

  const disabledCopyCreate = await expectFunctionStatus(baseUrl, owner.token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    rootNotionPageIds: ['notion-page-root'],
    copyFilesToStorage: false,
    snapshotItems: syntheticSnapshotItems(),
  }, 400);
  assert(
    /copyFilesToStorage cannot be disabled/.test(disabledCopyCreate.message ?? ''),
    'Notion import must reject attempts to disable file copying at job creation',
  );
  console.log('PASS Notion import refuses the old disabled file-copy option.');

  const unsupportedFileSnapshot = await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    rootNotionPageIds: ['notion-page-root'],
    snapshotItems: syntheticSnapshotItems({ includeUnsupportedFileUrl: true }),
  });
  const unsupportedFileJobId = unsupportedFileSnapshot?.job?.id;
  assert(unsupportedFileJobId, 'snapshot import with an unsupported file URL must create a job');
  const unsupportedApply = await expectFunctionStatus(baseUrl, owner.token, 'notion-import', {
    action: 'apply',
    workspaceId,
    jobId: unsupportedFileJobId,
  }, 400);
  assert(
    /could not copy file "Unsupported source"/.test(unsupportedApply.message ?? '') &&
      /unsupported file URL scheme/.test(unsupportedApply.message ?? ''),
    'Notion import apply must fail clearly when a required file cannot be copied during the initial apply',
  );
  // A mid-apply failure must leave the job in a `failed` state with the error
  // recorded, not stuck at ready/running (regression guard for markApplyJobFailed).
  const failedApplyJob = (await callFunction(baseUrl, owner.token, 'notion-import', {
    action: 'get',
    workspaceId,
    jobId: unsupportedFileJobId,
  })).job;
  assert(
    failedApplyJob?.status === 'failed',
    'a mid-apply failure must mark the import job failed, not leave it stuck at ready/running',
  );
  assert(
    /unsupported file URL scheme/.test(failedApplyJob?.error ?? ''),
    'the failed import job must record the apply error message',
  );
  console.log('PASS Notion import apply refuses to complete when required file storage copy fails.');

  if (mockNotionApi) {
    await verifyMockNotionDiscoveryContinuation(baseUrl, owner.token, workspaceId, organizationId);
    await verifyMockNotionRateLimitRetry(baseUrl, owner.token, workspaceId, organizationId);
    await verifyMockNotionSearchFailureRootFallback(baseUrl, owner.token, workspaceId, organizationId);
    await verifyMockNotionMissingExplicitRootFails(baseUrl, owner.token, workspaceId, organizationId);
    await verifyMockNotionDiscoveryFailureAudit(baseUrl, owner.token, workspaceId, organizationId);
    await verifyMockNotionDatabaseDataSourceDiscovery(baseUrl, owner.token, workspaceId, organizationId);
  }
  } finally {
    await mockNotionApi?.close();
  }
}

function syntheticSnapshotItems(options = {}) {
  const includeUnsupportedFileUrl = options.includeUnsupportedFileUrl === true;
  return [
    {
      notionId: 'notion-page-root',
      notionObject: 'page',
      title: 'Imported Project Home',
      status: 'discovered',
      phase: 'page_snapshot',
      metadata: {
        createdTime: NOTION_IMPORT_CREATED_TIME,
        lastEditedTime: NOTION_IMPORT_EDITED_TIME,
        icon: {
          type: 'external',
          external: { url: SYNTHETIC_IMAGE_DATA_URL },
        },
        cover: {
          type: 'file',
          file: {
            url: SYNTHETIC_IMAGE_DATA_URL,
            expiry_time: '2026-03-11T00:00:00.000Z',
          },
        },
        pageSnapshot: {
          childBlocks: [
            {
              id: 'notion-block-intro',
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [
                  {
                    type: 'text',
                    plain_text: 'Imported',
                    text: { content: 'Imported', link: null },
                    annotations: {
                      bold: true,
                      italic: false,
                      strikethrough: false,
                      underline: false,
                      code: false,
                      color: 'blue',
                    },
                  },
                  {
                    type: 'text',
                    plain_text: ' from ',
                    text: { content: ' from ', link: null },
                    annotations: {
                      bold: false,
                      italic: false,
                      strikethrough: false,
                      underline: false,
                      code: false,
                      color: 'default',
                    },
                  },
                  {
                    type: 'text',
                    plain_text: 'Notion API',
                    href: 'https://developers.notion.com/',
                    text: { content: 'Notion API', link: { url: 'https://developers.notion.com/' } },
                    annotations: {
                      bold: false,
                      italic: false,
                      strikethrough: false,
                      underline: true,
                      code: false,
                      color: 'default',
                    },
                  },
                  {
                    type: 'text',
                    plain_text: ' for ',
                    text: { content: ' for ', link: null },
                    annotations: {
                      bold: false,
                      italic: false,
                      strikethrough: false,
                      underline: false,
                      code: false,
                      color: 'default',
                    },
                  },
                  {
                    type: 'mention',
                    plain_text: 'Ada Importer',
                    mention: {
                      type: 'user',
                      user: syntheticNotionUser(),
                    },
                    annotations: {
                      bold: false,
                      italic: true,
                      strikethrough: false,
                      underline: false,
                      code: false,
                      color: 'default',
                    },
                  },
                  {
                    type: 'text',
                    plain_text: ' on ',
                    text: { content: ' on ', link: null },
                    annotations: {
                      bold: false,
                      italic: false,
                      strikethrough: false,
                      underline: false,
                      code: false,
                      color: 'default',
                    },
                  },
                  {
                    type: 'mention',
                    plain_text: 'January 2, 2025',
                    mention: {
                      type: 'date',
                      date: { start: '2025-01-02' },
                    },
                    annotations: {
                      bold: false,
                      italic: false,
                      strikethrough: false,
                      underline: false,
                      code: false,
                      color: 'default',
                    },
                  },
                  {
                    type: 'text',
                    plain_text: '. See ',
                    text: { content: '. See ', link: null },
                    annotations: {
                      bold: false,
                      italic: false,
                      strikethrough: false,
                      underline: false,
                      code: false,
                      color: 'default',
                    },
                  },
                  notionMentionDataSource('Tasks', 'notion-ds-tasks'),
                  notionText('.'),
                ],
              },
            },
            {
              id: 'notion-block-linked-tasks',
              object: 'block',
              type: 'link_to_page',
              link_to_page: {
                type: 'data_source_id',
                source: {
                  type: 'data_source_id',
                  id: 'notion-ds-tasks',
                },
                views: [
                  {
                    id: 'notion-view-board',
                    name: 'By status',
                    type: 'board',
                    layout: { type: 'board' },
                  },
                  {
                    id: 'notion-view-table',
                    name: 'All tasks',
                    type: 'table',
                    layout: { type: 'table' },
                  },
                ],
                current_view: {
                  id: 'notion-view-table',
                  name: 'All tasks',
                  type: 'table',
                  layout: { type: 'table' },
                },
                rich_text: [{ plain_text: 'Linked tasks' }],
              },
            },
            {
              id: 'notion-block-linked-missing',
              object: 'block',
              type: 'link_to_page',
              link_to_page: {
                type: 'data_source_id',
                source: {
                  type: 'data_source_id',
                  id: 'notion-ds-missing-linked',
                },
                current_view: {
                  id: 'notion-view-missing-linked',
                },
                rich_text: [{ plain_text: 'Missing linked source' }],
              },
            },
            {
              id: 'notion-block-child-page-boundary',
              object: 'block',
              type: 'child_page',
              child_page: {
                title: 'Child page boundary',
              },
              children: [
                {
                  id: 'notion-block-child-page-boundary-leaked-child',
                  object: 'block',
                  type: 'paragraph',
                  paragraph: {
                    rich_text: [{ plain_text: 'This belongs inside the child page, not the parent.' }],
                  },
                },
              ],
            },
            {
              id: 'notion-db-full-page-boundary',
              object: 'block',
              type: 'child_database',
              child_database: {
                title: 'Full page database boundary',
              },
              children: [
                {
                  id: 'notion-block-child-database-boundary-leaked-child',
                  object: 'block',
                  type: 'paragraph',
                  paragraph: {
                    rich_text: [{ plain_text: 'This belongs inside the child database, not the parent.' }],
                  },
                },
              ],
            },
            {
              id: 'notion-page-contextual-database',
              object: 'block',
              type: 'child_page',
              child_page: {
                title: 'Contextual database page',
              },
            },
            {
              id: 'notion-block-empty-top-level-column',
              object: 'block',
              type: 'column',
              column: {},
            },
            {
              id: 'notion-block-unresolved-rich-mention',
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [
                  notionText('Unresolved mention target: '),
                  notionMentionPage('Missing page', 'notion-page-missing-rich-mention'),
                ],
              },
            },
            {
              id: 'notion-block-colored-paragraph',
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [{ plain_text: 'Colored import paragraph' }],
                color: 'blue_background',
              },
            },
            {
              id: 'notion-block-callout',
              object: 'block',
              type: 'callout',
              callout: {
                rich_text: [{ plain_text: 'Remember import colors' }],
                color: 'green_background',
                icon: {
                  type: 'emoji',
                  emoji: '🧭',
                },
              },
            },
            {
              id: 'notion-block-link-preview',
              object: 'block',
              type: 'link_preview',
              link_preview: {
                url: SYNTHETIC_LINK_PREVIEW_URL,
              },
            },
            {
              id: 'notion-block-unsupported-button',
              object: 'block',
              type: 'unsupported',
              unsupported: {
                block_type: 'button',
              },
            },
            {
              id: 'notion-block-heading-four',
              object: 'block',
              type: 'heading_4',
              heading_4: {
                rich_text: [{ plain_text: 'Fine-grained heading import' }],
                is_toggleable: false,
              },
            },
            {
              id: 'notion-block-template-button',
              object: 'block',
              type: 'template',
              template: {
                rich_text: [{ plain_text: 'Add project follow-up' }],
                children: [
                  {
                    id: 'notion-block-template-button-child',
                    object: 'block',
                    type: 'to_do',
                    to_do: {
                      rich_text: [
                        notionText('Template follow-up for '),
                        notionMentionPage('Alpha project', 'notion-project-alpha'),
                      ],
                      checked: false,
                    },
                  },
                ],
              },
            },
            {
              id: 'notion-block-synced-source',
              object: 'block',
              type: 'synced_block',
              synced_block: {
                synced_from: null,
                children: [
                  {
                    id: 'notion-block-synced-source-child',
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                      rich_text: [{ plain_text: 'Synced source content' }],
                    },
                  },
                ],
              },
            },
            {
              id: 'notion-block-synced-copy',
              object: 'block',
              type: 'synced_block',
              synced_block: {
                synced_from: {
                  type: 'block_id',
                  block_id: 'notion-block-synced-source',
                },
              },
            },
            {
              id: 'notion-block-toggle-heading',
              object: 'block',
              type: 'heading_2',
              heading_2: {
                rich_text: [{ plain_text: 'Toggle heading import' }],
                is_toggleable: true,
                children: [
                  {
                    id: 'notion-block-toggle-heading-child',
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                      rich_text: [{ plain_text: 'Inside toggle heading' }],
                    },
                  },
                ],
              },
            },
            {
              id: 'notion-block-toggle-heading-four',
              object: 'block',
              type: 'heading_4',
              heading_4: {
                rich_text: [{ plain_text: 'Tiny toggle heading import' }],
                is_toggleable: true,
                children: [
                  {
                    id: 'notion-block-toggle-heading-four-child',
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                      rich_text: [{ plain_text: 'Inside tiny toggle heading' }],
                    },
                  },
                ],
              },
            },
            {
              id: 'notion-block-meeting-notes',
              object: 'block',
              type: 'meeting_notes',
              meeting_notes: {
                title: [{ plain_text: 'Team import sync' }],
                status: 'notes_ready',
                children: {
                  summary_block_id: 'notion-block-meeting-summary',
                  notes_block_id: null,
                  transcript_block_id: null,
                },
                calendar_event: {
                  attendees: ['notion-user-ada'],
                  start_time: '2026-02-24T10:00:00.000Z',
                  end_time: '2026-02-24T10:45:00.000Z',
                },
                recording: {
                  start_time: '2026-02-24T10:00:00.000Z',
                  end_time: '2026-02-24T10:45:00.000Z',
                },
              },
              children: [
                {
                  id: 'notion-block-meeting-summary',
                  object: 'block',
                  type: 'paragraph',
                  paragraph: {
                    rich_text: [{ plain_text: 'Summary from imported meeting notes' }],
                  },
                },
              ],
            },
            {
              id: 'notion-block-transcription',
              object: 'block',
              type: 'transcription',
              transcription: {
                title: [{ plain_text: 'Customer call transcript' }],
                status: 'completed',
                source: {
                  type: 'audio',
                  name: 'customer-call.mp3',
                },
                children: [
                  {
                    id: 'notion-block-transcription-child',
                    object: 'block',
                    type: 'quote',
                    quote: {
                      rich_text: [{ plain_text: 'Transcript highlight from customer call' }],
                    },
                  },
                ],
              },
            },
            {
              id: 'notion-block-tabs',
              object: 'block',
              type: 'tab',
              tab: {},
              children: [
                {
                  id: 'notion-block-tab-launch',
                  object: 'block',
                  type: 'paragraph',
                  paragraph: {
                    rich_text: [{ plain_text: 'Launch' }],
                    color: 'default',
                    icon: {
                      type: 'emoji',
                      emoji: '🚀',
                    },
                    children: [
                      {
                        id: 'notion-block-tab-launch-content',
                        object: 'block',
                        type: 'paragraph',
                        paragraph: {
                          rich_text: [{ plain_text: 'Launch tab content' }],
                        },
                      },
                    ],
                  },
                },
                {
                  id: 'notion-block-tab-notes',
                  object: 'block',
                  type: 'paragraph',
                  paragraph: {
                    rich_text: [{ plain_text: 'Notes' }],
                    color: 'default',
                    children: [
                      {
                        id: 'notion-block-tab-notes-content',
                        object: 'block',
                        type: 'to_do',
                        to_do: {
                          rich_text: [{ plain_text: 'Follow up from tabs' }],
                          checked: false,
                        },
                      },
                    ],
                  },
                },
                {
                  id: 'notion-block-tab-loose-quote',
                  object: 'block',
                  type: 'quote',
                  quote: {
                    rich_text: [{ plain_text: 'Loose tab quote content' }],
                  },
                },
              ],
            },
            {
              id: 'notion-block-nested-toggle',
              object: 'block',
              type: 'toggle',
              toggle: {
                rich_text: [{ plain_text: 'Nested import checklist' }],
                children: [
                  {
                    id: 'notion-block-nested-child',
                    object: 'block',
                    type: 'to_do',
                    to_do: {
                      rich_text: [{ plain_text: 'Verify child block nesting' }],
                      checked: true,
                    },
                  },
                ],
              },
            },
            {
              id: 'notion-block-simple-table',
              object: 'block',
              type: 'table',
              table: {
                table_width: 2,
                has_column_header: true,
                has_row_header: false,
                children: [
                  {
                    id: 'notion-block-simple-table-row-1',
                    object: 'block',
                    type: 'table_row',
                    table_row: {
                      cells: [
                        [{ plain_text: 'Name' }],
                        [{ plain_text: 'Owner' }],
                      ],
                    },
                  },
                  {
                    id: 'notion-block-simple-table-row-2',
                    object: 'block',
                    type: 'table_row',
                    table_row: {
                      cells: [
                        [{ plain_text: 'Launch' }],
                        [{ plain_text: 'Ada Importer' }],
                      ],
                    },
                  },
                ],
              },
            },
            {
              id: 'notion-block-equation',
              object: 'block',
              type: 'equation',
              equation: {
                expression: 'E = mc^2',
              },
            },
            {
              id: 'notion-block-toc',
              object: 'block',
              type: 'table_of_contents',
              table_of_contents: {},
            },
            {
              id: 'notion-block-breadcrumb',
              object: 'block',
              type: 'breadcrumb',
              breadcrumb: {},
            },
            {
              id: 'notion-block-columns',
              object: 'block',
              type: 'column_list',
              column_list: {
                children: [
                  {
                    id: 'notion-block-column-left',
                    object: 'block',
                    type: 'column',
                    column: {
                      width_ratio: 0.4,
                      children: [
                        {
                          id: 'notion-block-column-left-text',
                          object: 'block',
                          type: 'paragraph',
                          paragraph: {
                            rich_text: [{ plain_text: 'Left import column' }],
                          },
                        },
                      ],
                    },
                  },
                  {
                    id: 'notion-block-column-right',
                    object: 'block',
                    type: 'column',
                    column: {
                      width_ratio: 0.6,
                      children: [
                        {
                          id: 'notion-block-column-right-text',
                          object: 'block',
                          type: 'paragraph',
                          paragraph: {
                            rich_text: [{ plain_text: 'Right import column' }],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
            {
              id: 'notion-block-pdf',
              object: 'block',
              created_time: NOTION_IMPORT_BLOCK_CREATED_TIME,
              last_edited_time: NOTION_IMPORT_BLOCK_EDITED_TIME,
              type: 'pdf',
              pdf: {
                type: 'file',
                name: 'Source PDF',
                file: {
                  url: SYNTHETIC_PDF_DATA_URL,
                  expiry_time: '2026-03-11T00:00:00.000Z',
                },
                caption: [{ plain_text: 'Source PDF' }],
              },
            },
            {
              id: 'notion-block-unsupported-file-url',
              object: 'block',
              type: 'file',
              file: {
                type: 'external',
                name: includeUnsupportedFileUrl ? 'Unsupported source' : 'Secondary source',
                external: {
                  url: includeUnsupportedFileUrl ? SYNTHETIC_UNSUPPORTED_FILE_URL : SYNTHETIC_PDF_DATA_URL,
                },
                caption: [{ plain_text: includeUnsupportedFileUrl ? 'Unsupported source' : 'Secondary source' }],
              },
            },
            {
              id: 'notion-block-unsupported',
              object: 'block',
              type: 'unsupported',
              unsupported: {
                block_type: 'form',
              },
            },
          ],
          childrenHasMore: true,
          childrenNextCursor: 'notion-child-next',
        },
      },
    },
    {
      notionId: 'notion-block-child-page-boundary',
      notionObject: 'page',
      parentNotionId: 'notion-page-root',
      title: 'Child page boundary',
      status: 'discovered',
      phase: 'page_snapshot',
      metadata: {
        icon: {
          type: 'emoji',
          emoji: '📋',
        },
        pageSnapshot: {
          childBlocks: [
            {
              id: 'notion-block-child-page-boundary-page-body',
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [{ plain_text: 'This belongs inside the child page body.' }],
              },
            },
          ],
        },
      },
    },
    {
      notionId: 'notion-page-contextual-database',
      notionObject: 'page',
      parentNotionId: 'notion-page-root',
      title: 'Contextual database page',
      status: 'discovered',
      phase: 'page_snapshot',
      metadata: {
        pageSnapshot: {
          childBlocks: [
            {
              id: 'notion-db-hidden-inline-placeholder',
              object: 'block',
              type: 'child_database',
              child_database: {
                title: 'Untitled',
              },
            },
            {
              id: 'notion-db-api-linked-inline',
              object: 'block',
              type: 'child_database',
              child_database: {
                title: 'Untitled',
              },
            },
          ],
        },
      },
    },
    {
      notionId: 'notion-db-hidden-inline-placeholder',
      notionObject: 'database',
      parentNotionId: 'notion-page-contextual-database',
      title: 'Untitled',
      status: 'discovered',
      phase: 'database_snapshot',
      metadata: {
        database: {
          id: 'notion-db-hidden-inline-placeholder',
          object: 'database',
          is_inline: true,
          parent: {
            type: 'page_id',
            page_id: 'notion-page-contextual-database',
          },
          title: [{ plain_text: 'Untitled' }],
          data_sources: [],
        },
        dataSources: [],
      },
    },
    {
      notionId: 'notion-db-api-linked-inline',
      notionObject: 'database',
      parentNotionId: 'notion-page-contextual-database',
      title: 'Untitled',
      status: 'discovered',
      phase: 'database_snapshot',
      metadata: {
        database: {
          id: 'notion-db-api-linked-inline',
          object: 'database',
          is_inline: true,
          parent: {
            type: 'page_id',
            page_id: 'notion-page-contextual-database',
          },
          title: [{ plain_text: 'Untitled' }],
          data_sources: [],
        },
        dataSources: [],
      },
    },
    {
      notionId: 'notion-ds-projects',
      notionObject: 'data_source',
      title: 'Projects',
      status: 'discovered',
      phase: 'data_source_snapshot',
      metadata: {
        dataSourceSnapshot: {
          dataSource: {
            id: 'notion-ds-projects',
            object: 'data_source',
            properties: {
              Name: {
                id: 'notion-prop-project-name',
                name: 'Name',
                type: 'title',
                title: {},
              },
              Priority: {
                id: 'notion-prop-project-priority',
                name: 'Priority',
                type: 'select',
                select: {
                  options: [
                    { id: 'priority-high', name: 'High', color: 'red' },
                    { id: 'priority-low', name: 'Low', color: 'blue' },
                  ],
                },
              },
              Self: {
                id: 'notion-prop-project-self',
                name: 'Self',
                type: 'relation',
                relation: {
                  data_source_id: 'notion-ds-projects',
                },
              },
              Verification: {
                id: 'notion-prop-project-verification',
                name: 'Verification',
                type: 'verification',
                verification: {},
              },
            },
          },
          views: [
            {
              id: 'notion-view-projects-table',
              name: 'All projects',
              type: 'table',
              sorts: [{ property: 'Name', direction: 'ascending' }],
            },
          ],
          rowReferences: [
            {
              id: 'notion-project-alpha',
              object: 'page',
              title: 'Alpha project',
              properties: {
                Name: {
                  id: 'notion-prop-project-name',
                  type: 'title',
                  title: [{ plain_text: 'Alpha project' }],
                },
                Priority: {
                  id: 'notion-prop-project-priority',
                  type: 'select',
                  select: { id: 'priority-high', name: 'High', color: 'red' },
                },
                Self: {
                  id: 'notion-prop-project-self',
                  type: 'relation',
                  relation: [{ id: 'notion-project-alpha' }],
                },
              },
            },
            {
              id: 'notion-project-beta',
              object: 'page',
              title: 'Beta project',
              properties: {
                Name: {
                  id: 'notion-prop-project-name',
                  type: 'title',
                  title: [{ plain_text: 'Beta project' }],
                },
                Priority: {
                  id: 'notion-prop-project-priority',
                  type: 'select',
                  select: { id: 'priority-low', name: 'Low', color: 'blue' },
                },
                Self: {
                  id: 'notion-prop-project-self',
                  type: 'relation',
                  relation: [{ id: 'notion-project-beta' }],
                },
              },
            },
          ],
        },
      },
    },
    {
      notionId: 'notion-db-full-page-boundary',
      notionObject: 'database',
      title: 'Full page database boundary',
      status: 'discovered',
      phase: 'database_snapshot',
      metadata: {
        database: {
          id: 'notion-db-full-page-boundary',
          object: 'database',
          is_inline: false,
          parent: {
            type: 'page_id',
            page_id: 'notion-page-root',
          },
          title: [{ plain_text: 'Full page database boundary' }],
          data_sources: [
            {
              id: 'notion-ds-tasks',
              object: 'data_source',
              name: 'Tasks',
            },
          ],
        },
        dataSources: [
          {
            id: 'notion-ds-tasks',
            object: 'data_source',
            name: 'Tasks',
          },
        ],
      },
    },
    {
      notionId: 'notion-ds-tasks',
      notionObject: 'data_source',
      title: 'Tasks',
      status: 'discovered',
      phase: 'data_source_snapshot',
      metadata: {
        dataSourceSnapshot: {
          dataSource: {
            id: 'notion-ds-tasks',
            object: 'data_source',
            properties: {
              Name: {
                id: 'notion-prop-name',
                name: 'Name',
                type: 'title',
                title: {},
              },
              Status: {
                id: 'notion-prop-status',
                name: 'Status',
                type: 'status',
                status: {
                  options: [
                    { id: 'status-todo', name: 'To do', color: 'gray' },
                    { id: 'status-done', name: 'Done', color: 'green' },
                  ],
                },
              },
              'Funding type': {
                id: 'notion-prop-funding-type',
                name: 'Funding type',
                type: 'select',
                select: {
                  options: [
	                    { id: 'funding-received', name: 'Received', color: 'green' },
	                    { id: 'funding-paid', name: 'Paid', color: 'red' },
	                    { id: 'funding-tax-purchase', name: 'Tax invoice (purchase)', color: 'purple' },
	                    { id: 'funding-collection', name: '수금', color: 'green' },
	                    { id: 'funding-payment', name: '지급', color: 'red' },
	                    { id: 'funding-synthetic-expense-ko', name: '가상지출(테스트)', color: 'purple' },
	                  ],
                },
              },
              Project: {
                id: 'notion-prop-project',
                name: 'Project',
                type: 'relation',
                relation: {
                  data_source_id: 'notion-ds-projects',
                  synced_property_id: 'notion-prop-related-tasks',
                  synced_property_name: 'Tasks',
                },
              },
              Assets: {
                id: 'notion-prop-assets',
                name: 'Assets',
                type: 'files',
                files: {},
              },
              Assignee: {
                id: 'notion-prop-assignee',
                name: 'Assignee',
                type: 'people',
                people: {},
              },
              Estimate: {
                id: 'notion-prop-estimate',
                name: 'Estimate',
                type: 'number',
                number: {
                  format: 'dollar',
                },
              },
              'Task ID': {
                id: 'notion-prop-task-id',
                name: 'Task ID',
                type: 'unique_id',
                unique_id: {
                  prefix: 'TASK',
                },
              },
              'Name formula': {
                id: 'notion-prop-name-formula',
                name: 'Name formula',
                type: 'formula',
                formula: {
                  expression: 'prop("Name")',
                },
              },
              'ID formula': {
                id: 'notion-prop-id-formula',
                name: 'ID formula',
                type: 'formula',
                formula: {
                  expression: 'prop("notion-prop-name")',
                },
              },
              'Block token formula': {
                id: 'notion-prop-block-token-formula',
                name: 'Block token formula',
                type: 'formula',
                formula: {
                  expression:
                    'if({{notion:block_property:notion-prop-status:notion-ds-tasks:notion-workspace}} == "To do", {{notion:block_property:notion-prop-name:notion-ds-tasks:notion-workspace}}, "")',
                },
              },
              'Broken formula': {
                id: 'notion-prop-broken-formula',
                name: 'Broken formula',
                type: 'formula',
                formula: {
                  expression: 'prop("notion-prop-missing-formula")',
                },
              },
              'Unsupported formula': {
                id: 'notion-prop-unsupported-formula',
                name: 'Unsupported formula',
                type: 'formula',
                formula: {
                  expression: 'map(prop("Name"))',
                },
              },
              'Status label formula': {
                id: 'notion-prop-status-label-formula',
                name: 'Status label formula',
                type: 'formula',
                formula: {
                  expression:
                    'ifs(prop("Status") == "To do", concat("Todo from ifs ", format(round(sqrt(5), 2)), " ", format(hour(parseDate("2026-06-24T13:45Z")))), true, "Other")',
                },
              },
              'Project name rollup': {
                id: 'notion-prop-project-name-rollup',
                name: 'Project name rollup',
                type: 'rollup',
                rollup: {
                  relation_property_id: 'notion-prop-project',
                  rollup_property_id: 'notion-prop-project-name',
                  function: 'show_original',
                },
              },
              'Project relation rollup': {
                id: 'notion-prop-project-relation-rollup',
                name: 'Project relation rollup',
                type: 'rollup',
                rollup: {
                  relation_property_id: 'notion-prop-project',
                  rollup_property_id: 'notion-prop-project-self',
                  function: 'show_original',
                },
              },
              'Complex formula': {
                id: 'notion-prop-complex-formula',
                name: 'Complex formula',
                type: 'formula',
                formula: {
                  expression:
                    'lets(value, prop("Name"), window, dateRange(parseDate("2026-06-24"), parseDate("2026-06-30")), concat(value, repeat("!", 2), " ", format(dateBetween(dateEnd(window), dateStart(window), "days"))))',
                },
              },
              'Imported rollup fallback': {
                id: 'notion-prop-imported-rollup-fallback',
                name: 'Imported rollup fallback',
                type: 'rollup',
                rollup: {
                  relation_property_id: 'notion-prop-missing-relation',
                  rollup_property_id: 'notion-prop-project-name',
                  function: 'show_original',
                },
              },
            },
          },
          views: [
            {
              id: 'notion-view-table',
              name: 'All tasks',
              type: 'table',
              query: {
                where: {
                  Status: {
                    equals: 'To do',
                  },
                  Project: {
                    relation: {
                      contains: 'notion-project-alpha',
                    },
                  },
                  'Missing property': {
                    rich_text: {
                      contains: 'ghost',
                    },
                  },
                },
                sort: {
                  Status: { direction: 'descending' },
                  'Missing property': 'ascending',
                },
              },
              filter_chips: {
                Status: {
                  status: {
                    equals: 'To do',
                  },
                },
                Project: {
                  relation: {
                    contains: 'notion-project-alpha',
                  },
                },
                'Missing property': {
                  rich_text: {
                    contains: 'ghost quick',
                  },
                },
              },
              format: {
                table_properties: {
                  Status: {
                    property: { id: 'notion-prop-status' },
                    visible: true,
                    width: { width: 180 },
                    calculation: 'count',
                  },
                  Project: {
                    property_id: 'notion-prop-project',
                    visible: true,
                    width: { value: '220' },
                    table_calculation: { calculation: 'count_not_empty' },
                  },
                  Assets: {
                    property: { id: 'notion-prop-assets' },
                    hidden: true,
                    tableCalculation: 'empty',
                  },
                  Assignee: {
                    id: 'notion-prop-assignee',
                    table_calculation: 'unique_values',
                  },
                  Estimate: {
                    property_id: 'notion-prop-estimate',
                    visible: true,
                    table_calculation: 'sum',
                  },
                  'Name formula': {
                    name: 'Name formula',
                    width: { width: 'auto' },
                    table_calculation: 'show_as_bar',
                    wrap: true,
                  },
                  'Status label formula': {
                    name: 'Status label formula',
                  },
                  'Row-only rollup': {
                    property_id: 'notion-prop-row-only-rollup',
                    property_name: 'Row-only rollup',
                    visible: true,
                    width: 140,
                    table_calculation: 'sum',
                  },
                  'Stale hidden property': {
                    property_id: 'notion-prop-stale-hidden-view-only',
                    visible: false,
                    width: 80,
                  },
                  'Missing property': {
                    name: 'Missing property',
                    hidden: true,
                    width: 160,
                    table_calculation: 'sum',
                  },
                },
                table: {
                  table_row_height: 'large',
                  table_wrap: true,
                  page_open: 'side_peek',
                  zoom: 'week',
                  gallery_card_size: 'large',
                  group_property: { property_id: 'notion-prop-status' },
                  card_cover: { property: { id: 'notion-prop-assets' } },
                  timeline_dependency: { property: { id: 'notion-prop-project' } },
                },
              },
            },
            {
              id: 'notion-view-board',
              name: 'By status',
              type: 'board',
              format: {
                board: {
                  group_property: { property_id: 'notion-prop-status' },
                  card_size: 'medium',
                },
              },
            },
	            {
	              id: 'notion-view-purchase-invoice',
	              name: 'Purchase invoice',
	              type: 'table',
	              filter: null,
	              quick_filters: null,
	            },
	            {
	              id: 'notion-view-korean-collection',
	              name: '수금',
	              type: 'table',
	              filter: null,
	              quick_filters: null,
	            },
	            {
	              id: 'notion-view-korean-payment',
	              name: '지급',
	              type: 'table',
	              filter: null,
	              quick_filters: null,
	            },
	            {
	              id: 'notion-view-korean-purchase-invoice',
	              name: '가상 지출',
	              type: 'table',
	              filter: null,
	              quick_filters: null,
	            },
	            {
	              id: 'notion-view-rollup-linked',
              name: 'Default view',
              type: 'table',
              parent: {
                type: 'database_id',
                database_id: 'notion-db-api-linked-inline',
              },
              data_source_id: 'notion-ds-tasks',
              quick_filters: {
                'notion-prop-project-relation-rollup': {
                  rollup: {
                    any: {
                      relation: {
                        contains: 'notion-project-alpha',
                      },
                    },
                  },
                },
              },
              configuration: {
                type: 'table',
                properties: [
                  { property_id: 'notion-prop-name', visible: true },
                  { property_id: 'notion-prop-project-relation-rollup', visible: true },
                ],
              },
            },
          ],
          rowsHasMore: true,
          rowsNextCursor: 'notion-row-next',
          viewsHasMore: true,
          viewsNextCursor: 'notion-view-next',
          templates: [
            {
              id: 'notion-template-bug',
              name: 'Bug report',
              icon: 'BT',
              title: 'New bug',
              is_default: true,
              properties: {
                Name: {
                  id: 'notion-prop-name',
                  type: 'title',
                  title: [{ plain_text: 'New bug' }],
                },
                Status: {
                  id: 'notion-prop-status',
                  type: 'status',
                  status: { id: 'status-todo', name: 'To do', color: 'gray' },
                },
                Project: {
                  id: 'notion-prop-project',
                  type: 'relation',
                  relation: [
                    { id: 'notion-project-alpha' },
                    { id: 'notion-project-missing-template' },
                  ],
                },
                Estimate: {
                  id: 'notion-prop-estimate',
                  type: 'number',
                  number: 13,
                },
                Assignee: {
                  id: 'notion-prop-assignee',
                  type: 'people',
                  people: [syntheticNotionUser()],
                },
              },
              blocks: [
                {
                  id: 'notion-template-block-steps',
                  object: 'block',
                  type: 'paragraph',
                  paragraph: {
                    rich_text: [
                      notionText('Steps to reproduce for '),
                      notionMentionPage('Alpha project', 'notion-project-alpha'),
                    ],
                  },
                },
                {
                  id: 'notion-template-block-unresolved-mention',
                  object: 'block',
                  type: 'paragraph',
                  paragraph: {
                    rich_text: [
                      notionText('Template unresolved mention: '),
                      notionMentionPage('Missing template page', 'notion-page-missing-template-mention'),
                    ],
                  },
                },
              ],
            },
          ],
          rowReferences: [
            {
              id: 'notion-row-alpha',
              object: 'page',
              title: 'Alpha task',
              icon: {
                type: 'external',
                external: { url: SYNTHETIC_IMAGE_DATA_URL },
              },
              cover: {
                type: 'file',
                file: {
                  url: SYNTHETIC_IMAGE_DATA_URL,
                  expiry_time: '2026-03-11T00:00:00.000Z',
                },
              },
              properties: {
                Name: {
                  id: 'notion-prop-name',
                  type: 'title',
                  title: [{ plain_text: 'Alpha task' }],
                },
                Status: {
                  id: 'notion-prop-status',
                  type: 'status',
                  status: { id: 'status-todo', name: 'To do', color: 'gray' },
                },
                Project: {
                  id: 'notion-prop-project',
                  type: 'relation',
                  relation: [
                    { id: 'notion-project-alpha' },
                    { id: 'notion-project-missing-row' },
                  ],
                },
                Assets: {
                  id: 'notion-prop-assets',
                  type: 'files',
                  files: [
                    {
                      name: 'Brief.pdf',
                      type: 'external',
                      external: { url: SYNTHETIC_PDF_DATA_URL },
                    },
                    {
                      name: 'Temporary image',
                      type: 'file',
                      file: {
                        url: SYNTHETIC_IMAGE_DATA_URL,
                        expiry_time: '2026-03-11T00:00:00.000Z',
                      },
                    },
                  ],
                },
                Assignee: {
                  id: 'notion-prop-assignee',
                  type: 'people',
                  people: [syntheticNotionUser()],
                },
                'Task ID': {
                  id: 'notion-prop-task-id',
                  type: 'unique_id',
                  unique_id: {
                    prefix: 'TASK',
                    number: 42,
                  },
                },
                'Name formula': {
                  id: 'notion-prop-name-formula',
                  type: 'formula',
                  formula: {
                    type: 'string',
                    string: 'Alpha task',
                  },
                },
                'Status label formula': {
                  id: 'notion-prop-status-label-formula',
                  type: 'formula',
                  formula: {
                    type: 'string',
                    string: 'Todo from ifs 2.24 13',
                  },
                },
                'Block token formula': {
                  id: 'notion-prop-block-token-formula',
                  type: 'formula',
                  formula: {
                    type: 'string',
                    string: 'Alpha task',
                  },
                },
                'Unsupported formula': {
                  id: 'notion-prop-unsupported-formula',
                  type: 'formula',
                  formula: {
                    type: 'string',
                    string: 'Unsupported formula from Notion',
                  },
                },
                'Project name rollup': {
                  id: 'notion-prop-project-name-rollup',
                  type: 'rollup',
                  rollup: {
                    type: 'array',
                    array: [{ type: 'title', title: [{ plain_text: 'Alpha project' }] }],
                    function: 'show_original',
                  },
                },
                'Complex formula': {
                  id: 'notion-prop-complex-formula',
                  type: 'formula',
                  formula: {
                    type: 'string',
                    string: 'Alpha task!! 6',
                  },
                },
                'Imported rollup fallback': {
                  id: 'notion-prop-imported-rollup-fallback',
                  type: 'rollup',
                  rollup: {
                    type: 'array',
                    array: [{ type: 'title', title: [{ plain_text: 'Fallback rollup from Notion' }] }],
                    function: 'show_original',
                  },
                },
                'Row-only rollup': {
                  id: 'notion-prop-row-only-rollup',
                  type: 'rollup',
                  rollup: {
                    type: 'number',
                    number: 7,
                    function: 'sum',
                  },
                },
              },
            },
            {
              id: 'notion-row-beta',
              object: 'page',
              title: 'Beta task',
              properties: {
                Name: {
                  id: 'notion-prop-name',
                  type: 'title',
                  title: [{ plain_text: 'Beta task' }],
                },
                Status: {
                  id: 'notion-prop-status',
                  type: 'status',
                  status: { id: 'status-todo', name: 'To do', color: 'gray' },
                },
                Project: {
                  id: 'notion-prop-project',
                  type: 'relation',
                  relation: [{ id: 'notion-project-beta' }],
                },
                Estimate: {
                  id: 'notion-prop-estimate',
                  type: 'number',
                  number: 5,
                },
              },
            },
          ],
        },
      },
    },
    {
      notionId: 'notion-project-alpha',
      notionObject: 'page',
      parentNotionId: 'notion-ds-projects',
      title: 'Alpha project',
      status: 'referenced',
      phase: 'data_source_row_reference',
      metadata: {
        dataSourceId: 'notion-ds-projects',
        properties: {
          Name: {
            id: 'notion-prop-project-name',
            type: 'title',
            title: [{ plain_text: 'Alpha project' }],
          },
          Priority: {
            id: 'notion-prop-project-priority',
            type: 'select',
            select: { id: 'priority-high', name: 'High', color: 'red' },
          },
          Self: {
            id: 'notion-prop-project-self',
            type: 'relation',
            relation: [{ id: 'notion-project-alpha' }],
          },
        },
      },
    },
    {
      notionId: 'notion-row-alpha',
      notionObject: 'page',
      parentNotionId: 'notion-ds-tasks',
      title: 'Alpha task',
      status: 'referenced',
      phase: 'data_source_row_reference',
      metadata: {
        dataSourceId: 'notion-ds-tasks',
        createdTime: NOTION_IMPORT_ROW_CREATED_TIME,
        lastEditedTime: NOTION_IMPORT_ROW_EDITED_TIME,
        icon: {
          type: 'external',
          external: { url: SYNTHETIC_IMAGE_DATA_URL },
        },
        cover: {
          type: 'file',
          file: {
            url: SYNTHETIC_IMAGE_DATA_URL,
            expiry_time: '2026-03-11T00:00:00.000Z',
          },
        },
        properties: {
          Name: {
            id: 'notion-prop-name',
            type: 'title',
            title: [{ plain_text: 'Alpha task' }],
          },
          Status: {
            id: 'notion-prop-status',
            type: 'status',
            status: { id: 'status-todo', name: 'To do', color: 'gray' },
          },
          Project: {
            id: 'notion-prop-project',
            type: 'relation',
            relation: [
              { id: 'notion-project-alpha' },
              { id: 'notion-project-missing-row' },
            ],
          },
          Estimate: {
            id: 'notion-prop-estimate',
            type: 'number',
            number: 13,
          },
          Assets: {
            id: 'notion-prop-assets',
            type: 'files',
            files: [
              {
                name: 'Brief.pdf',
                type: 'external',
                external: { url: SYNTHETIC_PDF_DATA_URL },
              },
              {
                name: 'Temporary image',
                type: 'file',
                file: {
                  url: SYNTHETIC_IMAGE_DATA_URL,
                  expiry_time: '2026-03-11T00:00:00.000Z',
                },
              },
            ],
          },
          Assignee: {
            id: 'notion-prop-assignee',
            type: 'people',
            people: [syntheticNotionUser()],
          },
          'Task ID': {
            id: 'notion-prop-task-id',
            type: 'unique_id',
            unique_id: {
              prefix: 'TASK',
              number: 42,
            },
          },
          'Name formula': {
            id: 'notion-prop-name-formula',
            type: 'formula',
            formula: {
              type: 'string',
              string: 'Alpha task',
            },
          },
          'Status label formula': {
            id: 'notion-prop-status-label-formula',
            type: 'formula',
            formula: {
              type: 'string',
              string: 'Todo from ifs 2.24 13',
            },
          },
          'Project name rollup': {
            id: 'notion-prop-project-name-rollup',
            type: 'rollup',
            rollup: {
              type: 'array',
              array: [{ type: 'title', title: [{ plain_text: 'Alpha project' }] }],
              function: 'show_original',
            },
          },
          'Complex formula': {
            id: 'notion-prop-complex-formula',
            type: 'formula',
            formula: {
              type: 'string',
              string: 'Alpha task!! 6',
            },
          },
          'Imported rollup fallback': {
            id: 'notion-prop-imported-rollup-fallback',
            type: 'rollup',
            rollup: {
              type: 'array',
              array: [{ type: 'title', title: [{ plain_text: 'Fallback rollup from Notion' }] }],
              function: 'show_original',
            },
          },
          'Row-only rollup': {
            id: 'notion-prop-row-only-rollup',
            type: 'rollup',
            rollup: {
              type: 'number',
              number: 7,
              function: 'sum',
            },
          },
        },
        pageSnapshot: {
          childBlocks: [
            {
              id: 'notion-row-alpha-body-project',
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [
                  notionText('Related project: '),
                  notionMentionPage('Alpha project', 'notion-project-alpha'),
                ],
              },
            },
          ],
        },
      },
    },
  ];
}

function syntheticMcpUrl(id) {
  return `https://example.com/notion/${id}`;
}

function syntheticMcpHiddenDatabaseFetch() {
  return {
    metadata: { type: 'database' },
    title: '🧪 가상 비용 기록',
    url: syntheticMcpUrl(SYNTHETIC_MCP_DATABASE_PAGE_ID),
    text: `<database url="{{${syntheticMcpUrl(SYNTHETIC_MCP_DATABASE_PAGE_ID)}}}" inline="true">
The title of this Database is: 🧪 가상 비용 기록
<data-sources>
<data-source url="{{collection://${SYNTHETIC_MCP_DATA_SOURCE_ID}}}">
The title of this Data Source is: 🧪 가상 비용 기록
<data-source-state>
${JSON.stringify({
  name: '🧪 가상 비용 기록',
  url: `{{collection://${SYNTHETIC_MCP_DATA_SOURCE_ID}}}`,
  schema: {
    샘플항목: {
      name: '샘플항목',
      type: 'title',
      propertyUrl: `collectionProperty://${SYNTHETIC_MCP_DATA_SOURCE_ID}/synthetic-title`,
    },
    기준일: {
      name: '기준일',
      type: 'date',
      propertyUrl: `collectionProperty://${SYNTHETIC_MCP_DATA_SOURCE_ID}/synthetic-date`,
    },
    샘플파일: {
      name: '샘플파일',
      type: 'file',
      propertyUrl: `collectionProperty://${SYNTHETIC_MCP_DATA_SOURCE_ID}/synthetic-file`,
    },
    테스트메모: {
      name: '테스트메모',
      type: 'text',
      propertyUrl: `collectionProperty://${SYNTHETIC_MCP_DATA_SOURCE_ID}/synthetic-memo`,
    },
    가상금액: {
      name: '가상금액',
      type: 'number',
      number_format: 'won',
      propertyUrl: `collectionProperty://${SYNTHETIC_MCP_DATA_SOURCE_ID}/synthetic-amount`,
    },
    처리단계: {
      name: '처리단계',
      type: 'select',
      propertyUrl: `collectionProperty://${SYNTHETIC_MCP_DATA_SOURCE_ID}/synthetic-status`,
      options: [
        { id: 'synthetic-review', name: '검토중', color: 'blue' },
        { id: 'synthetic-complete', name: SYNTHETIC_MCP_ROW_STATUS, color: 'green' },
      ],
    },
    샘플연결: {
      name: '샘플연결',
      type: 'relation',
      propertyUrl: `collectionProperty://${SYNTHETIC_MCP_DATA_SOURCE_ID}/synthetic-relation`,
      dataSourceUrl: `collection://${SYNTHETIC_MCP_RELATION_SOURCE_ID}`,
    },
    연결대상명: {
      name: '연결대상명',
      type: 'rollup',
      relationPropertyUrl: `collectionProperty://${SYNTHETIC_MCP_DATA_SOURCE_ID}/synthetic-relation`,
      targetPropertyUrl: `collectionProperty://${SYNTHETIC_MCP_RELATION_SOURCE_ID}/synthetic-target-title`,
      function: 'show_original',
    },
  },
})}
</data-source-state>
</data-source>
</data-sources>
<views>
<view url="{{view://${SYNTHETIC_MCP_VIEW_ID}}}">
${JSON.stringify({
  dataSourceUrl: `{{collection://${SYNTHETIC_MCP_DATA_SOURCE_ID}}}`,
  displayProperties: ['샘플항목', '기준일', '샘플파일', '테스트메모', '가상금액'],
  name: '가상 기본 보기',
  sorts: [{ direction: 'descending', property: '기준일' }],
  type: 'table',
})}
</view>
</views>
</database>`,
  };
}

function syntheticMcpDirectDataSourceFetch() {
  return {
    metadata: { type: 'data_source' },
    title: '가상 분석 기록',
    url: syntheticMcpUrl(SYNTHETIC_MCP_DIRECT_PAGE_ID),
    text: `<data-source url="{{collection://${SYNTHETIC_MCP_DIRECT_SOURCE_ID}}}">
The title of this Data Source is: 가상 분석 기록
<data-source-state>
${JSON.stringify({
  name: '가상 분석 기록',
  url: `{{collection://${SYNTHETIC_MCP_DIRECT_SOURCE_ID}}}`,
  schema: {
    기록명: { name: '기록명', type: 'title' },
    가상분류: {
      name: '가상분류',
      type: 'select',
      options: [
        { id: 'synthetic-lab', name: '가상 실험', color: 'blue' },
        { id: 'synthetic-review', name: '모의 검토', color: 'green' },
      ],
    },
    작성일: { name: '작성일', type: 'date' },
  },
})}
</data-source-state>
</data-source>`,
  };
}

function syntheticMcpRowPageFetch() {
  const title = '🧪 [가상비용] 테스트랩 장비 대여 (2031년 8월)';
  return {
    metadata: { type: 'page' },
    title,
    url: syntheticMcpUrl(SYNTHETIC_MCP_ROW_PAGE_ID),
    text: `<page url="${syntheticMcpUrl(SYNTHETIC_MCP_ROW_PAGE_ID)}" icon="🧪">
<ancestor-path>
<parent-data-source url="collection://${SYNTHETIC_MCP_DATA_SOURCE_ID}" name="가상 비용 기록"/>
</ancestor-path>
<properties>
${JSON.stringify({
  'date:기준일:is_datetime': 0,
  'date:기준일:start': SYNTHETIC_MCP_ROW_DATE,
  url: syntheticMcpUrl(SYNTHETIC_MCP_ROW_PAGE_ID),
  샘플항목: title,
  샘플연결: [syntheticMcpUrl(SYNTHETIC_MCP_RELATED_PAGE_ID)],
  테스트메모: '가상 장비 대여료 731,250 + 모의 세액 73,125',
  가상금액: SYNTHETIC_MCP_ROW_AMOUNT,
  가상유형: '가상비용',
  처리단계: SYNTHETIC_MCP_ROW_STATUS,
  샘플파일: [SYNTHETIC_PDF_DATA_URL],
})}
</properties>
<blank-page>This page is blank and has no content.</blank-page>
</page>`,
  };
}
function mappingLocalId(result, notionId, localType) {
  const mapping = result.mappings?.find((item) => item.notionId === notionId && item.localType === localType);
  assert(mapping?.localId, `mapping ${notionId} -> ${localType} must exist`);
  return mapping.localId;
}

function propByName(props, name) {
  const prop = props.find((item) => item.name === name);
  assert(prop, `database property ${name} must exist`);
  return prop;
}

function isStoredFileUrl(value) {
  return typeof value === 'string' && value.includes('/api/storage/files/');
}

function syntheticNotionUser() {
  return {
    object: 'user',
    id: 'notion-user-ada',
    type: 'person',
    name: 'Ada Importer',
    avatar_url: 'https://example.com/ada.png',
    person: { email: 'ada@example.com' },
  };
}

function defaultNotionAnnotations(overrides = {}) {
  return {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: 'default',
    ...overrides,
  };
}

function notionText(content, options = {}) {
  return {
    type: 'text',
    plain_text: content,
    text: {
      content,
      link: options.link ? { url: options.link } : null,
    },
    ...(options.link ? { href: options.link } : {}),
    annotations: defaultNotionAnnotations(options.annotations),
  };
}

function notionMentionPage(plainText, pageId, options = {}) {
  return {
    type: 'mention',
    plain_text: plainText,
    mention: {
      type: 'page',
      page: { id: pageId },
    },
    annotations: defaultNotionAnnotations(options.annotations),
  };
}

function notionMentionDataSource(plainText, dataSourceId, options = {}) {
  return {
    type: 'mention',
    plain_text: plainText,
    mention: {
      type: 'data_source',
      data_source: { id: dataSourceId },
    },
    annotations: defaultNotionAnnotations(options.annotations),
  };
}

async function verifyMockNotionStoredConnection(baseUrl, token, workspaceId, organizationId, expectStoredConnection) {
  const response = await postFunction(baseUrl, token, 'notion-import', {
    action: 'createConnection',
    workspaceId,
    connectionKind: 'internal_integration',
    name: 'Mock stored connection',
    notionToken: 'mock-notion-token',
  });
  const json = await readJson(response);
  if (!response.ok) {
    const message = JSON.stringify(json);
    if (!expectStoredConnection && message.includes('HANJI_NOTION_IMPORT_SECRET')) {
      console.log('SKIP Notion stored connection smoke because HANJI_NOTION_IMPORT_SECRET is not configured.');
      return;
    }
    throw new Error(`notion-import stored connection create returned HTTP ${response.status}: ${message}`);
  }

  const connection = json.connection;
  assert(connection?.id, 'Stored Notion connection must return a connection id');
  assert(connection.hasStoredCredential === true, 'Stored Notion connection must report that an encrypted credential exists');
  assert(!Object.prototype.hasOwnProperty.call(connection, 'credentialCiphertext'), 'Stored Notion connection must not expose credential ciphertext');
  assert(connection.notionWorkspaceId === 'mock-notion-workspace', 'Stored Notion connection must preserve safe Notion workspace metadata');
  await assertOrganizationAuditEvent(baseUrl, token, organizationId, {
    action: 'notion_import.connection.create',
    targetType: 'notion_import_connection',
    targetId: connection.id,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.connectionKind === 'internal_integration' &&
      event.metadata?.notionWorkspaceId === 'mock-notion-workspace',
    message: 'Stored Notion connection create must record a filterable organization audit event',
  });

  const listed = await callFunction(baseUrl, token, 'notion-import', {
    action: 'listConnections',
    workspaceId,
  });
  assert(
    listed.connections?.some((item) => item.id === connection.id && item.hasStoredCredential === true && !item.credentialCiphertext),
    'Stored Notion connection list must include safe metadata without credentials',
  );

  const created = await callFunction(baseUrl, token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'internal_integration',
    connectionId: connection.id,
    maxDiscoveryPages: 1,
    maxEnrichedItems: 10,
    maxChildrenPages: 1,
    maxDataSourceQueryPages: 1,
    maxViewPages: 1,
  });
  assert(created.job?.status === 'ready', 'Stored Notion connection must be usable for discovery without resupplying a token');
  assert(created.job?.connectionId === connection.id, 'Stored Notion connection discovery must persist the connection id on the job');
  assert(created.job?.options?.credentialSource === 'connection', 'Stored Notion connection discovery must record the credential source');
  assert(created.job?.options?.tokenStored === false, 'Notion import jobs must not store the raw token even when using a connection');
  assert(created.job?.report?.credentialSource === 'connection', 'Stored Notion connection discovery report must record the credential source');
  assert(created.items?.some((item) => item.notionId === 'mock-page-first'), 'Stored Notion connection discovery must import mock search results');

  const revoked = await callFunction(baseUrl, token, 'notion-import', {
    action: 'revokeConnection',
    connectionId: connection.id,
  });
  assert(revoked.connection?.status === 'revoked', 'Stored Notion connection revoke must mark the connection revoked');
  assert(revoked.connection?.hasStoredCredential === false, 'Stored Notion connection revoke must remove the encrypted credential');
  await assertOrganizationAuditEvent(baseUrl, token, organizationId, {
    action: 'notion_import.connection.revoke',
    targetType: 'notion_import_connection',
    targetId: connection.id,
    predicate: (event) => event.workspaceId === workspaceId,
    message: 'Stored Notion connection revoke must record a filterable organization audit event',
  });
  await expectFunctionStatus(baseUrl, token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'internal_integration',
    connectionId: connection.id,
  }, 400);
  console.log('PASS Notion stored connections encrypt credentials, support discovery, and revoke safely.');
}

async function verifyMockNotionOAuthConnection(baseUrl, token, workspaceId, organizationId, expectOAuthConnection) {
  const redirectUri = 'http://127.0.0.1:3001/?notion_import_oauth=1';
  const beginResponse = await postFunction(baseUrl, token, 'notion-import', {
    action: 'beginOAuthConnection',
    workspaceId,
    name: 'Mock OAuth connection',
    redirectUri,
  });
  const beginJson = await readJson(beginResponse);
  if (!beginResponse.ok) {
    const message = JSON.stringify(beginJson);
    if (
      !expectOAuthConnection &&
      (
        message.includes('HANJI_NOTION_OAUTH_ENABLED') ||
        message.includes('HANJI_NOTION_OAUTH_CLIENT_ID') ||
        message.includes('HANJI_NOTION_OAUTH_CLIENT_SECRET')
      )
    ) {
      console.log('SKIP Notion OAuth smoke because Notion OAuth environment variables are not configured.');
      return;
    }
    throw new Error(`notion-import OAuth begin returned HTTP ${beginResponse.status}: ${message}`);
  }

  assert(beginJson.authorizationUrl, 'Notion OAuth begin must return an authorization URL');
  assert(beginJson.state, 'Notion OAuth begin must return a signed state');
  assert(beginJson.redirectUri === redirectUri, 'Notion OAuth begin must preserve the callback redirect URI');
  const authorizationUrl = new URL(beginJson.authorizationUrl);
  assert(authorizationUrl.pathname.endsWith('/oauth/authorize'), 'Notion OAuth authorization URL must target the authorize endpoint');
  assert(authorizationUrl.searchParams.get('client_id'), 'Notion OAuth authorization URL must include the client id');
  assert(authorizationUrl.searchParams.get('redirect_uri') === redirectUri, 'Notion OAuth authorization URL must include the redirect URI');
  assert(authorizationUrl.searchParams.get('response_type') === 'code', 'Notion OAuth authorization URL must request an authorization code');
  assert(authorizationUrl.searchParams.get('owner') === 'user', 'Notion OAuth authorization URL must request user ownership');
  assert(authorizationUrl.searchParams.get('state') === beginJson.state, 'Notion OAuth authorization URL must include the signed state');
  await assertOrganizationAuditEvent(baseUrl, token, organizationId, {
    action: 'notion_import.oauth.begin',
    targetType: 'notion_import_connection',
    targetId: workspaceId,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.connectionKind === 'oauth' &&
      event.metadata?.redirectUri === redirectUri,
    message: 'Notion OAuth begin must record a filterable organization audit event',
  });

  const completeResponse = await postFunction(baseUrl, token, 'notion-import', {
    action: 'completeOAuthConnection',
    code: 'mock-oauth-code',
    state: beginJson.state,
    redirectUri,
  });
  const completeJson = await readJson(completeResponse);
  if (!completeResponse.ok) {
    const message = JSON.stringify(completeJson);
    if (!expectOAuthConnection && message.includes('HANJI_NOTION_IMPORT_SECRET')) {
      console.log('SKIP Notion OAuth completion smoke because HANJI_NOTION_IMPORT_SECRET is not configured.');
      return;
    }
    throw new Error(`notion-import OAuth complete returned HTTP ${completeResponse.status}: ${message}`);
  }

  const connection = completeJson.connection;
  assert(connection?.id, 'Notion OAuth complete must return a connection id');
  assert(connection.connectionKind === 'oauth', 'Notion OAuth complete must store an OAuth connection');
  assert(connection.hasStoredCredential === true, 'Notion OAuth connection must store encrypted credentials');
  assert(!Object.prototype.hasOwnProperty.call(connection, 'credentialCiphertext'), 'Notion OAuth connection must not expose credential ciphertext');
  assert(connection.notionWorkspaceId === 'mock-notion-workspace', 'Notion OAuth connection must preserve workspace metadata');
  assert(connection.metadata?.oauth?.hasRefreshToken === true, 'Notion OAuth connection metadata must record refresh-token availability without exposing it');
  await assertOrganizationAuditEvent(baseUrl, token, organizationId, {
    action: 'notion_import.oauth.complete',
    targetType: 'notion_import_connection',
    targetId: connection.id,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.connectionKind === 'oauth' &&
      event.metadata?.notionWorkspaceId === 'mock-notion-workspace' &&
      event.metadata?.hasRefreshToken === true,
    message: 'Notion OAuth completion must record a filterable organization audit event',
  });

  const discovered = await callFunction(baseUrl, token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'oauth',
    connectionId: connection.id,
    maxDiscoveryPages: 1,
    maxEnrichedItems: 10,
    maxChildrenPages: 1,
    maxDataSourceQueryPages: 1,
    maxViewPages: 1,
  });
  assert(discovered.job?.status === 'ready', 'Notion OAuth connection must be usable for discovery');
  assert(discovered.job?.connectionKind === 'oauth', 'Notion OAuth discovery job must keep the OAuth connection kind');
  assert(discovered.job?.options?.credentialSource === 'connection', 'Notion OAuth discovery must use the stored connection credential');
  assert(
    discovered.job?.options?.tokenFingerprint !== connection.tokenFingerprint,
    'Notion OAuth discovery must record the refreshed access token fingerprint',
  );
  assert(discovered.items?.some((item) => item.notionId === 'mock-page-first'), 'Notion OAuth discovery must read mock search results');

  const listedAfterRefresh = await callFunction(baseUrl, token, 'notion-import', {
    action: 'listConnections',
    workspaceId,
  });
  const refreshedConnection = listedAfterRefresh.connections?.find((item) => item.id === connection.id);
  assert(refreshedConnection?.hasStoredCredential === true, 'Refreshed Notion OAuth connection must keep encrypted credentials');
  assert(!Object.prototype.hasOwnProperty.call(refreshedConnection, 'credentialCiphertext'), 'Refreshed Notion OAuth connection must not expose credential ciphertext');
  assert(
    refreshedConnection?.tokenFingerprint !== connection.tokenFingerprint,
    'Refreshed Notion OAuth connection must rotate the stored token fingerprint',
  );
  assert(
    refreshedConnection?.metadata?.oauth?.requestId === 'mock-oauth-refresh-request',
    'Refreshed Notion OAuth connection metadata must record the refresh response safely',
  );
  assert(
    typeof refreshedConnection?.metadata?.oauth?.refreshedAt === 'string',
    'Refreshed Notion OAuth connection metadata must record when the refresh happened',
  );

  const revoked = await callFunction(baseUrl, token, 'notion-import', {
    action: 'revokeConnection',
    connectionId: connection.id,
  });
  assert(revoked.connection?.status === 'revoked', 'Notion OAuth connection revoke must mark the connection revoked');
  assert(revoked.connection?.hasStoredCredential === false, 'Notion OAuth connection revoke must remove encrypted credentials');
  await assertOrganizationAuditEvent(baseUrl, token, organizationId, {
    action: 'notion_import.connection.revoke',
    targetType: 'notion_import_connection',
    targetId: connection.id,
    predicate: (event) => event.workspaceId === workspaceId,
    message: 'Notion OAuth connection revoke must record a filterable organization audit event',
  });
  console.log('PASS Notion OAuth creates signed authorization URLs, rotates refresh tokens, supports discovery, and revokes safely.');
}

async function verifyMockNotionDiscoveryContinuation(baseUrl, token, workspaceId, organizationId) {
  const created = await callFunction(baseUrl, token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    notionToken: 'mock-notion-token',
    maxDiscoveryPages: 1,
    maxEnrichedItems: 10,
    maxChildrenPages: 1,
    maxDataSourceQueryPages: 1,
    maxViewPages: 1,
  });
  assert(created.job?.status === 'ready', 'Mock Notion discovery job must become ready after the first page');
  assertJobProgress(created.job, 'discover', 'completed', 50, 'mock Notion discovery jobs', [
    { key: 'discover', status: 'completed' },
  ]);
  assert(created.job?.progress?.hasMore === true, 'Mock Notion discovery must preserve hasMore from the first search page');
  assert(created.job?.progress?.nextCursor === 'cursor-second', 'Mock Notion discovery must store the next Notion search cursor');
  assert(
    created.items?.some((item) => item.notionId === 'mock-page-first'),
    'Mock Notion discovery must include the first search page item',
  );
  const mockFirstPage = created.items?.find((item) => item.notionId === 'mock-page-first');
  const mockNestedParent = mockFirstPage?.metadata?.pageSnapshot?.childBlocks?.find((block) => block.id === 'mock-nested-parent');
  assert(
    mockNestedParent?.children?.some((block) => block.id === 'mock-nested-child'),
    'Mock Notion discovery must fetch nested block children for blocks with has_children',
  );
  assert(
    created.items?.some((item) =>
      item.notionId === 'mock-rich-mentioned-ds' &&
      item.notionObject === 'data_source' &&
      item.phase === 'data_source_snapshot'
    ) &&
      created.items?.some((item) =>
        item.notionId === 'mock-rich-mentioned-db' &&
        item.notionObject === 'database'
      ),
    `Mock Notion discovery must follow rich text data source mentions into data source and database snapshots; got ${
      (created.items ?? []).map((item) => `${item.notionId}:${item.notionObject}:${item.phase}`).join(', ')
    }`,
  );
  assert(
    !created.items?.some((item) => item.notionId === 'mock-page-second'),
    'Mock Notion discovery must not include later search page items before continuation',
  );
  await assertOrganizationAuditEvent(baseUrl, token, organizationId, {
    action: 'notion_import.discover',
    targetType: 'notion_import_job',
    targetId: created.job.id,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.hasMore === true &&
      event.metadata?.continuedFromCursor === false &&
      event.metadata?.searchPagesFetched === 1,
    message: 'Initial Notion discovery must record cursor and page-count metadata in organization audit',
  });
  const firstPlan = await callFunction(baseUrl, token, 'notion-import', {
    action: 'plan',
    workspaceId,
    jobId: created.job.id,
  });
  assert(
    firstPlan.plan?.conversion?.warnings?.some((issue) => issue.code === 'notion_search_has_more'),
    'Mock Notion discovery plan must report when workspace search still has a saved next cursor',
  );

  const continued = await callFunction(baseUrl, token, 'notion-import', {
    action: 'discover',
    workspaceId,
    jobId: created.job.id,
    notionToken: 'mock-notion-token',
    continueFromCursor: true,
    maxDiscoveryPages: 1,
    maxEnrichedItems: 10,
    maxChildrenPages: 1,
    maxDataSourceQueryPages: 1,
    maxViewPages: 1,
  });
  assert(continued.job?.status === 'ready', 'Continued mock Notion discovery must leave the job ready');
  assertJobProgress(continued.job, 'discover', 'completed', 50, 'continued mock Notion discovery jobs', [
    { key: 'discover', status: 'completed' },
  ]);
  assert(continued.job?.progress?.continuedFromCursor === true, 'Continued mock discovery must record cursor continuation');
  assert(
    continued.job?.progress?.searchStartCursor === 'cursor-second',
    'Continued mock discovery must start from the stored Notion cursor',
  );
  assert(continued.job?.progress?.hasMore === false, 'Continued mock discovery must clear hasMore at the end of search');
  assert(continued.job?.progress?.totalKnown >= 2, 'Continued mock discovery must keep prior items and add later items');
  assert(continued.job?.counts?.page >= 2, 'Continued mock discovery must report total graph counts');
  assert(
    continued.items?.some((item) => item.notionId === 'mock-page-first') &&
      continued.items?.some((item) => item.notionId === 'mock-page-second'),
    'Continued mock discovery must merge search pages instead of replacing the graph',
  );
  await assertOrganizationAuditEvent(baseUrl, token, organizationId, {
    action: 'notion_import.discover',
    targetType: 'notion_import_job',
    targetId: created.job.id,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.hasMore === false &&
      event.metadata?.continuedFromCursor === true &&
      event.metadata?.searchStartCursor === 'cursor-second' &&
      event.metadata?.searchPagesFetched === 1,
    message: 'Continued Notion discovery must record cursor continuation metadata in organization audit',
  });
  console.log('PASS Notion import discovery can continue from a saved Notion cursor and merge the graph.');
}

async function verifyMockNotionRateLimitRetry(baseUrl, token, workspaceId, organizationId) {
  const created = await callFunction(baseUrl, token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    notionToken: 'mock-rate-limit-token',
    maxDiscoveryPages: 1,
    maxEnrichedItems: 10,
    maxChildrenPages: 1,
    maxDataSourceQueryPages: 1,
    maxViewPages: 1,
  });
  assert(created.job?.status === 'ready', 'Mock Notion discovery must recover from a retryable search rate limit');
  assert(
    created.items?.some((item) => item.notionId === 'mock-rate-limited-page'),
    'Mock Notion discovery must include results returned after a rate-limit retry',
  );
  assert(
    created.job?.report?.warnings?.some((issue) => issue.code === 'notion_api_retry'),
    'Mock Notion discovery must report retryable Notion API rate limits',
  );
  await assertOrganizationAuditEvent(baseUrl, token, organizationId, {
    action: 'notion_import.discover',
    targetType: 'notion_import_job',
    targetId: created.job.id,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.warnings >= 1 &&
      event.metadata?.searchCounts?.page === 1,
    message: 'Retry-recovered Notion discovery must record warning counts in organization audit',
  });
  console.log('PASS Notion import discovery retries retryable Notion API rate limits.');
}

async function verifyMockNotionSearchFailureRootFallback(baseUrl, token, workspaceId, organizationId) {
  const created = await callFunction(baseUrl, token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    notionToken: 'mock-search-error-token',
    rootNotionPageIds: ['mock-page-first'],
    maxDiscoveryPages: 1,
    maxEnrichedItems: 10,
    maxChildrenPages: 1,
    maxDataSourceQueryPages: 1,
    maxViewPages: 1,
  });
  assert(created.job?.status === 'ready', 'Mock search failure with root fallback must leave the job ready');
  assert(
    created.items?.some((item) => item.notionId === 'mock-page-first' && item.phase === 'page_snapshot'),
    'Mock explicit root discovery must enrich the requested root page',
  );
  assert(
    !created.job?.report?.missingPermissions?.some((issue) => issue.code === 'search_unavailable'),
    'Mock explicit root discovery should not depend on workspace search',
  );
  await assertOrganizationAuditEvent(baseUrl, token, organizationId, {
    action: 'notion_import.discover',
    targetType: 'notion_import_job',
    targetId: created.job.id,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.missingPermissions === 0 &&
      event.metadata?.searchPagesFetched === 0,
    message: 'Explicit root Notion discovery must skip workspace search and record scoped discovery audit metadata',
  });
  console.log('PASS Notion import discovery scopes explicit root pages without importing the broader workspace graph.');
}

async function verifyMockNotionMissingExplicitRootFails(baseUrl, token, workspaceId, organizationId) {
  const missingRootPageId = `mock-missing-root-${Date.now()}`;
  await expectFunctionStatus(baseUrl, token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    notionToken: 'mock-root-missing-token',
    rootNotionPageIds: [missingRootPageId],
    maxDiscoveryPages: 1,
    maxEnrichedItems: 10,
    maxChildrenPages: 1,
    maxDataSourceQueryPages: 1,
    maxViewPages: 1,
  }, 400);

  const listed = await callFunction(baseUrl, token, 'notion-import', {
    action: 'list',
    workspaceId,
    limit: 100,
  });
  const failedJob = (listed.jobs ?? []).find((job) =>
    job.status === 'failed' &&
      Array.isArray(job.rootNotionPageIds) &&
      job.rootNotionPageIds.includes(missingRootPageId)
  );
  assert(failedJob?.id, 'Missing explicit root import must keep a failed job record');
  assert(
    (failedJob.error ?? '').includes('could not read requested root page'),
    `Missing explicit root import must explain the scoped import failure: ${failedJob.error ?? ''}`,
  );
  await assertOrganizationAuditEvent(baseUrl, token, organizationId, {
    action: 'notion_import.discover_failed',
    targetType: 'notion_import_job',
    targetId: failedJob.id,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
        event.metadata?.credentialSource === 'request' &&
        event.metadata?.continuedFromCursor === false &&
        (event.metadata?.error ?? '').includes('could not read requested root page'),
    message: 'Missing explicit root discovery must record a failed audit event instead of importing a different graph',
  });
  console.log('PASS Notion import rejects missing explicit root pages instead of falling back to another accessible graph.');
}

async function verifyMockNotionDiscoveryFailureAudit(baseUrl, token, workspaceId, organizationId) {
  const failingRootPageId = `mock-user-error-root-${Date.now()}`;
  await expectFunctionStatus(baseUrl, token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    notionToken: 'mock-user-error-token',
    rootNotionPageIds: [failingRootPageId],
    maxDiscoveryPages: 1,
    maxEnrichedItems: 10,
    maxChildrenPages: 1,
    maxDataSourceQueryPages: 1,
    maxViewPages: 1,
  }, 400);

  const listed = await callFunction(baseUrl, token, 'notion-import', {
    action: 'list',
    workspaceId,
    limit: 100,
  });
  const failedJob = (listed.jobs ?? []).find((job) =>
    job.status === 'failed' &&
      Array.isArray(job.rootNotionPageIds) &&
      job.rootNotionPageIds.includes(failingRootPageId)
  );
  assert(failedJob?.id, 'Failed Notion discovery must keep a failed job record for audit and review');
  assertJobProgress(failedJob, 'discover', 'failed', undefined, 'failed Notion discovery jobs', [
    { key: 'discover', status: 'failed' },
  ]);
  assert(
    /users\/me|Mock token cannot read users\/me|HTTP 401/.test(failedJob.error ?? ''),
    'Failed Notion discovery job must preserve the safe upstream error summary',
  );
  await assertOrganizationAuditEvent(baseUrl, token, organizationId, {
    action: 'notion_import.discover_failed',
    targetType: 'notion_import_job',
    targetId: failedJob.id,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.credentialSource === 'request' &&
      event.metadata?.continuedFromCursor === false &&
      event.metadata?.maxDiscoveryPages === 1 &&
      /users\/me|Mock token cannot read users\/me|HTTP 401/.test(event.metadata?.error ?? ''),
    message: 'Failed Notion discovery must record a filterable organization audit event without storing the token',
  });
  console.log('PASS Notion import discovery failures are preserved as failed jobs and organization audit events.');
}

async function verifyMockNotionDatabaseDataSourceDiscovery(baseUrl, token, workspaceId, organizationId) {
  const created = await callFunction(baseUrl, token, 'notion-import', {
    action: 'create',
    workspaceId,
    connectionKind: 'manual_token',
    notionToken: 'mock-database-token',
    maxDiscoveryPages: 1,
    maxEnrichedItems: 10,
    maxChildrenPages: 1,
    maxDataSourceQueryPages: 1,
    maxViewPages: 1,
  });
  assert(created.job?.status === 'ready', 'Mock database discovery job must become ready');
  assert(
    created.items?.some((item) => item.notionId === 'mock-db-container' && item.notionObject === 'database') &&
      created.items?.some((item) => item.notionId === 'mock-ds-from-db' && item.notionObject === 'data_source') &&
	      created.items?.some((item) =>
	        item.notionId === 'mock-row-from-db' &&
	        item.notionObject === 'page' &&
	        item.phase === 'page_snapshot'
	      ) &&
	      created.items?.some((item) =>
	        item.notionId === MOCK_VIEW_FILTER_ROW_ID &&
	        item.notionObject === 'page' &&
	        item.phase === 'page_snapshot' &&
	        item.metadata?.dataSourceId === 'mock-ds-from-db'
	      ) &&
	      created.items?.some((item) => item.notionId === 'mock-row-linked-db' && item.notionObject === 'database') &&
	      created.items?.some((item) => item.notionId === 'mock-ds-row-linked' && item.notionObject === 'data_source') &&
	      created.items?.some((item) => item.notionId === 'mock-row-linked-view' && item.notionObject === 'view') &&
	      created.items?.some((item) => item.notionId === 'mock-row-linked-context-view' && item.notionObject === 'view') &&
	      created.items?.some((item) => item.notionId === MOCK_TEMPLATE_LINKED_VIEW_ID && item.notionObject === 'view') &&
	      created.items?.some((item) => item.notionId === 'mock-view-from-db' && item.notionObject === 'view'),
	    'Mock database discovery must follow database.data_sources, row-page linked databases, template linked views, and view filter row references into snapshots and views',
	  );
  const discoveredDataSource = created.items?.find((item) => item.notionId === 'mock-ds-from-db');
  const discoveredTemplates = discoveredDataSource?.metadata?.dataSourceSnapshot?.templates ?? [];
  assert(
    discoveredTemplates.some((template) =>
      template.id === 'mock-template-default' &&
        template.name === 'Mock default row' &&
        template.is_default === true &&
        template.properties?.Name?.title?.[0]?.plain_text === 'Default mock row' &&
        template.blocks?.some((block) => block.id === 'mock-template-default-body')
    ),
    'Mock database discovery must fetch data source templates, default-template state, page properties, and template body blocks through the Notion API',
  );
  await assertOrganizationAuditEvent(baseUrl, token, organizationId, {
    action: 'notion_import.discover',
    targetType: 'notion_import_job',
    targetId: created.job.id,
    predicate: (event) =>
      event.workspaceId === workspaceId &&
      event.metadata?.currentDiscoveryCounts?.database >= 1 &&
      event.metadata?.currentDiscoveryCounts?.data_source >= 1 &&
      event.metadata?.currentDiscoveryCounts?.view >= 1,
    message: 'Database-container Notion discovery must record object-type graph counts in organization audit',
  });

  const applied = await callFunction(baseUrl, token, 'notion-import', {
    action: 'apply',
    workspaceId,
    jobId: created.job.id,
  });
	  assert(applied.job?.status === 'completed', 'Mock database-only import must apply successfully');
	  assert(applied.applied?.databases === 2, 'Mock database-only import must create canonical databases from discovered and row-linked data sources');
	  assert(applied.applied?.rows === 2, 'Mock database-only import must create rows from discovered queries and view filter references');
	  assert(applied.applied?.views === 4, 'Mock database-only import must create views from discovered, row-linked, row-context, and template-linked data source views');
	  assert(applied.applied?.templates === 1, 'Mock database-only import must create templates discovered from the official data source templates API');
	  const databaseId = mappingLocalId(applied, 'mock-ds-from-db', 'database');
	  const linkedDatabaseId = mappingLocalId(applied, 'mock-ds-row-linked', 'database');
	  const rowId = mappingLocalId(applied, 'mock-row-from-db', 'page');
	  const filterRowId = mappingLocalId(applied, MOCK_VIEW_FILTER_ROW_ID, 'page');
	  const viewId = mappingLocalId(applied, 'mock-view-from-db', 'db_view');
	  const linkedViewId = mappingLocalId(applied, 'mock-row-linked-view', 'db_view');
	  const linkedContextViewId = mappingLocalId(applied, 'mock-row-linked-context-view', 'db_view');
	  const templateLinkedViewId = mappingLocalId(applied, MOCK_TEMPLATE_LINKED_VIEW_ID, 'db_view');
	  const templateId = mappingLocalId(applied, 'mock-template-default', 'db_template');
  const pageSnapshot = await callFunction(baseUrl, token, 'page-query', {
    action: 'page',
    pageId: databaseId,
  });
	  const databaseSnapshot = await callFunction(baseUrl, token, 'page-query', {
	    action: 'database',
	    databaseId,
	  });
	  const linkedDatabaseSnapshot = await callFunction(baseUrl, token, 'page-query', {
	    action: 'database',
	    databaseId: linkedDatabaseId,
	  });
	  const rowsSnapshot = await callFunction(baseUrl, token, 'page-query', {
	    action: 'databaseRows',
	    databaseId,
  });
  const rowBlocks = await callFunction(baseUrl, token, 'page-query', {
    action: 'blocks',
    pageId: rowId,
  });
	  assert(
	    pageSnapshot.page?.title === 'Mock database source' &&
	      rowsSnapshot.rows?.some((row) => row.id === rowId && row.title === 'Mock database row') &&
	      rowsSnapshot.rows?.some((row) => row.id === filterRowId && row.title === 'Mock filter referenced row') &&
	      databaseSnapshot.views?.some((view) => view.id === viewId && view.name === 'Mock table'),
	    'Mock database-only import must expose the canonical database, query rows, filter-referenced rows, and views through page-query',
	  );
	  const mockNameProp = propByName(databaseSnapshot.properties ?? [], 'Name');
	  const mockStatusProp = propByName(databaseSnapshot.properties ?? [], 'Status');
	  const importedMockView = databaseSnapshot.views?.find((view) => view.id === viewId);
	  assert(
	    importedMockView?.config?.visibleProperties?.includes(mockNameProp.id) &&
	      importedMockView.config.hiddenProperties?.includes(mockStatusProp.id) &&
	      importedMockView.config.propertyOrder?.[0] === mockNameProp.id &&
	      importedMockView.config.propertyOrder?.[1] === mockStatusProp.id &&
	      importedMockView.config.propertyWidths?.[mockNameProp.id] === 240 &&
	      importedMockView.config.propertyWidths?.[mockStatusProp.id] === 180,
	    'Mock database-only import must preserve hidden/visible property settings from official Notion view detail configuration',
	  );
	  const linkedRelationProp = propByName(linkedDatabaseSnapshot.properties ?? [], 'Related source row');
	  const linkedView = (linkedDatabaseSnapshot.views ?? []).find((view) => view.id === linkedViewId);
	  const linkedContextView = (linkedDatabaseSnapshot.views ?? []).find((view) => view.id === linkedContextViewId);
	  const templateLinkedView = (linkedDatabaseSnapshot.views ?? []).find((view) => view.id === templateLinkedViewId);
	  assert(
	    flattenFilters(linkedView?.config?.filterGroup).some((filter) =>
	      filter?.propertyId === linkedRelationProp.id &&
	        filter.operator === 'contains' &&
	        filter.value === filterRowId
	    ) &&
	      !Array.isArray(linkedView?.config?.quickFilters),
	    'Mock database-only import must fetch view filter row references and normalize quick filter page ids into filterGroup',
	  );
  const rowContextFilter = flattenFilters(linkedContextView?.config?.filterGroup).find((filter) =>
    filter?.propertyId === linkedRelationProp.id
  );
  assert(
    linkedContextView?.config?.hanjiImportedRowContextFilter === true &&
      rowContextFilter?.operator === 'contains' &&
      rowContextFilter?.value === rowId,
    'Mock database-only import must persist row-context linked database filters during migration apply',
  );
	  const importedTemplate = databaseSnapshot.templates?.find((template) => template.id === templateId);
	  const importedTemplateLinkedDbBlock = importedTemplate?.blocks?.find((block) =>
	    block.type === 'inline_database' && block.plainText === 'Template linked row database'
	  );
	  const templateQuickFilter = flattenFilters(templateLinkedView?.config?.filterGroup).find((filter) =>
	    filter?.propertyId === linkedRelationProp.id && filter.operator === 'contains'
	  );
	  assert(
	    importedTemplate?.name === 'Mock default row' &&
	      importedTemplate.isDefault === true &&
	      importedTemplate.title === 'Default mock row' &&
	      importedTemplate.properties?.[mockStatusProp.id] === 'mock-status-closed' &&
	      importedTemplate.blocks?.some((block) => block.plainText === 'Mock template body from Notion'),
	    'Mock database-only import must preserve discovered template name, default state, property defaults, title defaults, and body blocks',
	  );
	  assert(
	    importedTemplateLinkedDbBlock?.content?.childPageId === linkedDatabaseId &&
	      importedTemplateLinkedDbBlock?.content?.databaseViewId === templateLinkedViewId &&
	      importedTemplateLinkedDbBlock?.content?.linkedDatabaseSource === true &&
	      Array.isArray(importedTemplateLinkedDbBlock?.content?.databaseViewIds) &&
	      importedTemplateLinkedDbBlock.content.databaseViewIds.includes(templateLinkedViewId) &&
	      importedTemplateLinkedDbBlock?.content?.templateSelfFilter?.sourceDatabaseId === databaseId &&
	      importedTemplateLinkedDbBlock?.content?.templateSelfFilter?.relationPropertyId === linkedRelationProp.id &&
	      templateLinkedView?.config?.templateLinkedView === true &&
	      templateLinkedView.config.templateLinkedSourceDatabaseId === databaseId &&
	      templateLinkedView.config.templateLinkedRelationPropertyId === linkedRelationProp.id &&
	      templateQuickFilter?.value?.kind === 'hanji.current_page' &&
	      !(applied.job?.report?.conversion?.summary?.unresolvedViewRelationFilterValues > 0),
	    'Mock database-only import must convert template linked database relation filters to Current page instead of unresolved Notion template ids',
	  );
  assert(
    rowBlocks.blocks?.some((block) => block.plainText === 'Mock row body from Notion'),
    'Mock database-only import must preserve row page body blocks discovered from the Notion row page',
  );
  const importedLinkedRowDbBlock = rowBlocks.blocks?.find((block) =>
    block.plainText === 'Linked row database' && block.type === 'inline_database'
  );
  const importedLinkedRowDbMetadata = importedLinkedRowDbBlock?.content?.notionLinkedDatabase;
  assert(
    importedLinkedRowDbBlock?.content?.childPageId === linkedDatabaseId &&
      importedLinkedRowDbBlock?.content?.databaseViewId === linkedViewId &&
      importedLinkedRowDbBlock?.content?.linkedDatabaseSource === true &&
      Array.isArray(importedLinkedRowDbBlock?.content?.databaseViewIds) &&
      importedLinkedRowDbBlock.content.databaseViewIds.includes(linkedViewId),
    'Mock database-only import must preserve linked database blocks as native Hanji linked-database blocks inside row page bodies',
  );
  assert(
    Array.isArray(importedLinkedRowDbMetadata?.targetIds) &&
      importedLinkedRowDbMetadata.targetIds.includes('mock-row-linked-db') &&
      Array.isArray(importedLinkedRowDbMetadata?.viewIds) &&
      importedLinkedRowDbMetadata.viewIds.includes('mock-row-linked-view') &&
      importedLinkedRowDbMetadata.selectedViewId === 'mock-row-linked-view' &&
      importedLinkedRowDbMetadata.localTargetId === linkedDatabaseId &&
      importedLinkedRowDbMetadata.localViewId === linkedViewId &&
      Array.isArray(importedLinkedRowDbMetadata?.viewReferences) &&
      importedLinkedRowDbMetadata.viewReferences.some((view) =>
        view.id === 'mock-row-linked-view' &&
        view.name === 'Linked row table' &&
        view.type === 'table' &&
        view.layout === 'table'
      ),
    'Mock database-only import must retain normalized Notion linked database target/view metadata for UI reconstruction',
  );
  console.log('PASS Notion import discovery follows database containers into data source snapshots.');
}

async function startMockNotionApi(apiBase) {
  const base = new URL(apiBase);
  if (!base.port) {
    throw new Error('--mock-notion-api-base must include an explicit localhost port');
  }
  const prefix = base.pathname.replace(/\/+$/, '') || '/v1';
  const state = {
    oauthRefreshAttempts: 0,
    rateLimitedSearchAttempts: 0,
  };
  const server = createServer((request, response) => {
    handleMockNotionRequest(request, response, prefix, state).catch((error) => {
      writeJson(response, 500, { message: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(base.port), base.hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

async function handleMockNotionRequest(request, response, prefix, state) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith(prefix)) {
    writeJson(response, 404, { message: 'Mock Notion path was not found.' });
    return;
  }
  const route = url.pathname.slice(prefix.length) || '/';

  if (request.method === 'POST' && route === '/oauth/token') {
    const body = await readRequestJson(request);
    const auth = Array.isArray(request.headers.authorization)
      ? request.headers.authorization.join(' ')
      : request.headers.authorization ?? '';
    if (!auth.startsWith('Basic ')) {
      writeJson(response, 401, { code: 'unauthorized', message: 'Basic auth is required.' });
      return;
    }
    if (body.grant_type === 'refresh_token') {
      if (body.refresh_token !== 'mock-oauth-refresh-token') {
        writeJson(response, 400, { code: 'invalid_grant', message: 'Mock OAuth refresh token was invalid.' });
        return;
      }
      state.oauthRefreshAttempts += 1;
      writeJson(response, 200, {
        access_token: 'mock-oauth-access-token-refreshed',
        token_type: 'bearer',
        refresh_token: 'mock-oauth-refresh-token-rotated',
        bot_id: 'mock-oauth-bot',
        workspace_icon: 'https://example.com/mock-workspace.png',
        workspace_name: 'Mock Notion Workspace',
        workspace_id: 'mock-notion-workspace',
        owner: {
          type: 'user',
          user: {
            object: 'user',
            id: 'mock-oauth-user',
            type: 'person',
            name: 'Mock OAuth User',
            person: { email: 'hidden@example.com' },
          },
        },
        duplicated_template_id: null,
        request_id: 'mock-oauth-refresh-request',
      });
      return;
    }
    if (body.grant_type !== 'authorization_code' || body.code !== 'mock-oauth-code') {
      writeJson(response, 400, { code: 'invalid_grant', message: 'Mock OAuth code was invalid.' });
      return;
    }
    writeJson(response, 200, {
      access_token: 'mock-oauth-access-token',
      token_type: 'bearer',
      refresh_token: 'mock-oauth-refresh-token',
      bot_id: 'mock-oauth-bot',
      workspace_icon: 'https://example.com/mock-workspace.png',
      workspace_name: 'Mock Notion Workspace',
      workspace_id: 'mock-notion-workspace',
      owner: {
        type: 'user',
        user: {
          object: 'user',
          id: 'mock-oauth-user',
          type: 'person',
          name: 'Mock OAuth User',
          person: { email: 'hidden@example.com' },
        },
      },
      duplicated_template_id: null,
      request_id: 'mock-oauth-request',
    });
    return;
  }

  if (request.method === 'GET' && route === '/users/me') {
    const auth = Array.isArray(request.headers.authorization)
      ? request.headers.authorization.join(' ')
      : request.headers.authorization ?? '';
    if (auth.includes('mock-user-error-token')) {
      writeJson(response, 401, { code: 'unauthorized', message: 'Mock token cannot read users/me.' });
      return;
    }
    writeJson(response, 200, {
      object: 'user',
      id: 'mock-bot',
      type: 'bot',
      bot: {
        workspace_id: 'mock-notion-workspace',
        workspace_name: 'Mock Notion Workspace',
      },
    });
    return;
  }

  if (request.method === 'POST' && route === '/search') {
    const body = await readRequestJson(request);
    const auth = Array.isArray(request.headers.authorization)
      ? request.headers.authorization.join(' ')
      : request.headers.authorization ?? '';
    if (auth.includes('mock-oauth-access-token') && !auth.includes('mock-oauth-access-token-refreshed')) {
      writeJson(response, 401, { code: 'unauthorized', message: 'OAuth token was not refreshed before search.' });
      return;
    }
    if (auth.includes('mock-database-token')) {
      writeJson(response, 200, {
        object: 'list',
        results: [mockNotionDatabase('mock-db-container', 'Mock database container')],
        has_more: false,
        next_cursor: null,
      });
      return;
    }
    if (auth.includes('mock-rate-limit-token')) {
      state.rateLimitedSearchAttempts += 1;
      if (state.rateLimitedSearchAttempts === 1) {
        writeJson(
          response,
          429,
          { code: 'rate_limited', message: 'Rate limited by mock Notion API.' },
          { 'Retry-After': '0' },
        );
        return;
      }
      writeJson(response, 200, {
        object: 'list',
        results: [mockNotionPage('mock-rate-limited-page', 'Mock rate limited page')],
        has_more: false,
        next_cursor: null,
      });
      return;
    }
    if (auth.includes('mock-search-error-token')) {
      writeJson(response, 403, { message: 'Search access unavailable for this mock token.' });
      return;
    }
    if (body.start_cursor === 'cursor-second') {
      writeJson(response, 200, {
        object: 'list',
        results: [mockNotionPage('mock-page-second', 'Mock second page')],
        has_more: false,
        next_cursor: null,
      });
      return;
    }
    writeJson(response, 200, {
      object: 'list',
      results: [mockNotionPage('mock-page-first', 'Mock first page')],
      has_more: true,
      next_cursor: 'cursor-second',
    });
    return;
  }

  const pageMatch = /^\/pages\/([^/]+)$/.exec(route);
  if (request.method === 'GET' && pageMatch) {
    const pageId = decodeURIComponent(pageMatch[1]);
    const auth = Array.isArray(request.headers.authorization)
      ? request.headers.authorization.join(' ')
      : request.headers.authorization ?? '';
    if (auth.includes('mock-root-missing-token') && pageId.includes('mock-missing-root')) {
      writeJson(response, 404, {
        code: 'object_not_found',
        message: `Mock missing root page ${pageId} is not shared with the integration.`,
      });
      return;
    }
	    if (pageId === 'mock-template-default') {
	      writeJson(response, 200, mockNotionTemplatePage());
	      return;
	    }
	    if (pageId === MOCK_VIEW_FILTER_ROW_ID) {
	      writeJson(response, 200, mockNotionFilterReferencedRow());
	      return;
	    }
	    writeJson(response, 200, mockNotionPage(pageId, `Mock page ${pageId}`));
	    return;
	  }

  if (request.method === 'GET' && route === '/databases/mock-db-container') {
    writeJson(response, 200, mockNotionDatabase('mock-db-container', 'Mock database container', [
      { id: 'mock-ds-from-db', name: 'Mock database source' },
    ]));
    return;
  }

  if (request.method === 'GET' && route === '/databases/mock-row-linked-db') {
    writeJson(response, 200, mockNotionDatabase('mock-row-linked-db', 'Mock row linked database', [
      { id: 'mock-ds-row-linked', name: 'Mock row linked source' },
    ]));
    return;
  }

  if (request.method === 'GET' && route === '/databases/mock-rich-mentioned-db') {
    writeJson(response, 200, mockNotionDatabase('mock-rich-mentioned-db', 'Mock rich text mentioned database', [
      { id: 'mock-rich-mentioned-ds', name: 'Mock rich text mentioned source' },
    ]));
    return;
  }

  if (request.method === 'GET' && route === '/data_sources/mock-ds-from-db') {
    writeJson(response, 200, mockNotionDataSource());
    return;
  }

  if (request.method === 'GET' && route === '/data_sources/mock-ds-row-linked') {
    writeJson(response, 200, mockNotionLinkedRowDataSource());
    return;
  }

  if (request.method === 'GET' && route === '/data_sources/mock-rich-mentioned-ds') {
    writeJson(response, 200, mockNotionRichMentionedDataSource());
    return;
  }

  if (request.method === 'GET' && route === '/data_sources/mock-ds-from-db/templates') {
    writeJson(response, 200, {
      object: 'list',
      templates: [
        {
          id: 'mock-template-default',
          name: 'Mock default row',
          is_default: true,
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  if (
    request.method === 'GET' &&
    (route === '/data_sources/mock-ds-row-linked/templates' || route === '/data_sources/mock-rich-mentioned-ds/templates')
  ) {
    writeJson(response, 200, {
      object: 'list',
      templates: [],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  if (request.method === 'POST' && route === '/data_sources/mock-ds-from-db/query') {
    writeJson(response, 200, {
      object: 'list',
      results: [
        {
          object: 'page',
          id: 'mock-row-from-db',
          parent: { type: 'data_source_id', data_source_id: 'mock-ds-from-db' },
          properties: {
            Name: {
              id: 'mock-prop-name',
              type: 'title',
              title: [{ plain_text: 'Mock database row' }],
            },
            Status: {
              id: 'mock-prop-status',
              type: 'status',
              status: { id: 'mock-status-open', name: 'Open', color: 'green' },
            },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  if (request.method === 'POST' && route === '/data_sources/mock-ds-row-linked/query') {
    writeJson(response, 200, {
      object: 'list',
      results: [],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  if (request.method === 'POST' && route === '/data_sources/mock-rich-mentioned-ds/query') {
    writeJson(response, 200, {
      object: 'list',
      results: [],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  if (request.method === 'GET' && route === '/views' && url.searchParams.get('data_source_id') === 'mock-ds-from-db') {
    writeJson(response, 200, {
      object: 'list',
      results: [
        {
          id: 'mock-view-from-db',
          name: 'Mock table',
          type: 'table',
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  const viewMatch = /^\/views\/([^/]+)$/.exec(route);
  if (request.method === 'GET' && viewMatch) {
    const viewId = decodeURIComponent(viewMatch[1]);
    if (viewId === 'mock-view-from-db') {
      writeJson(response, 200, {
        object: 'view',
        id: 'mock-view-from-db',
        name: 'Mock table',
        type: 'table',
        data_source_id: 'mock-ds-from-db',
        sorts: [{ property: 'Status', direction: 'ascending' }],
        configuration: {
          type: 'table',
          properties: [
            { property_id: 'mock-prop-name', property_name: 'Name', visible: true, width: 240 },
            { property_id: 'mock-prop-status', property_name: 'Status', visible: false, width: 180 },
          ],
        },
      });
      return;
    }
    writeJson(response, 404, { message: `Mock view ${viewId} was not found.` });
    return;
  }

  if (request.method === 'GET' && route === '/views' && url.searchParams.get('data_source_id') === 'mock-ds-row-linked') {
    writeJson(response, 200, {
      object: 'list',
	      results: [
	        {
	          id: 'mock-row-linked-view',
	          name: 'Linked row table',
	          type: 'table',
	          visible_properties: ['Name', 'Related source row'],
	          property_order: ['Name', 'Related source row'],
	          quick_filters: {
	            'Related source row': {
	              relation: {
	                contains: MOCK_VIEW_FILTER_ROW_ID,
	              },
	            },
	          },
	        },
	        {
	          id: 'mock-row-linked-context-view',
	          name: 'Linked row context table',
	          type: 'table',
	          visible_properties: ['Name', 'Related source row'],
	          property_order: ['Name', 'Related source row'],
	        },
	        {
	          id: MOCK_TEMPLATE_LINKED_VIEW_ID,
	          name: 'Template linked table',
	          type: 'table',
	          visible_properties: ['Name', 'Related source row'],
	          property_order: ['Name', 'Related source row'],
	          parent: {
	            type: 'database_id',
	            database_id: 'mock-template-linked-db',
	          },
	          data_source_id: 'mock-ds-row-linked',
	          quick_filters: {
	            'Related source row': {
	              relation: {
	                contains: 'mock-template-default',
	              },
	            },
	          },
	        },
	      ],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  if (request.method === 'GET' && route === '/views' && url.searchParams.get('data_source_id') === 'mock-rich-mentioned-ds') {
    writeJson(response, 200, {
      object: 'list',
      results: [],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  if (request.method === 'GET' && route === '/blocks/mock-page-first/children') {
    writeJson(response, 200, {
      object: 'list',
      results: [
        {
          id: 'mock-page-first-rich-mention',
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [
              notionText('Mentioned source: '),
              notionMentionDataSource('Mock rich source', 'mock-rich-mentioned-ds'),
            ],
          },
        },
        {
          id: 'mock-nested-parent',
          object: 'block',
          type: 'toggle',
          has_children: true,
          toggle: {
            rich_text: [{ plain_text: 'Mock nested parent' }],
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  if (request.method === 'GET' && route === '/blocks/mock-nested-parent/children') {
    writeJson(response, 200, {
      object: 'list',
      results: [
        {
          id: 'mock-nested-child',
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ plain_text: 'Mock nested child' }],
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  if (request.method === 'GET' && route === '/blocks/mock-template-default/children') {
    writeJson(response, 200, {
      object: 'list',
      results: [
        {
          id: 'mock-template-default-body',
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ plain_text: 'Mock template body from Notion' }],
          },
        },
        {
          id: 'mock-template-linked-db-block',
          object: 'block',
          type: 'link_to_page',
          link_to_page: {
            type: 'database_id',
            source: {
              type: 'database_id',
              id: 'mock-row-linked-db',
            },
            default_view: {
              id: MOCK_TEMPLATE_LINKED_VIEW_ID,
              name: 'Template linked table',
              type: 'table',
              layout: { type: 'table' },
            },
            views: [
              {
                id: MOCK_TEMPLATE_LINKED_VIEW_ID,
                name: 'Template linked table',
                type: 'table',
                layout: { type: 'table' },
              },
            ],
            rich_text: [{ plain_text: 'Template linked row database' }],
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  if (request.method === 'GET' && route === '/blocks/mock-row-from-db/children') {
    writeJson(response, 200, {
      object: 'list',
      results: [
        {
          id: 'mock-row-body-block',
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ plain_text: 'Mock row body from Notion' }],
          },
        },
        {
          id: 'mock-row-linked-db-block',
          object: 'block',
          type: 'link_to_page',
          link_to_page: {
            type: 'database_id',
            source: {
              type: 'database_id',
              id: 'mock-row-linked-db',
            },
            default_view: {
              id: 'mock-row-linked-view',
              name: 'Linked row table',
              type: 'table',
              layout: { type: 'table' },
            },
            views: [
              {
                id: 'mock-row-linked-view',
                name: 'Linked row table',
                type: 'table',
                layout: { type: 'table' },
              },
            ],
            rich_text: [{ plain_text: 'Linked row database' }],
          },
        },
        {
          id: 'mock-row-linked-context-db-block',
          object: 'block',
          type: 'link_to_page',
          link_to_page: {
            type: 'database_id',
            source: {
              type: 'database_id',
              id: 'mock-row-linked-db',
            },
            default_view: {
              id: 'mock-row-linked-context-view',
              name: 'Linked row context table',
              type: 'table',
              layout: { type: 'table' },
            },
            views: [
              {
                id: 'mock-row-linked-context-view',
                name: 'Linked row context table',
                type: 'table',
                layout: { type: 'table' },
              },
            ],
            rich_text: [{ plain_text: 'Linked row context database' }],
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  if (request.method === 'GET' && /^\/blocks\/[^/]+\/children$/.test(route)) {
    writeJson(response, 200, {
      object: 'list',
      results: [],
      has_more: false,
      next_cursor: null,
    });
    return;
  }

  const markdownMatch = /^\/pages\/([^/]+)\/markdown$/.exec(route);
  if (request.method === 'GET' && markdownMatch) {
    writeJson(response, 200, {
      markdown: `# ${decodeURIComponent(markdownMatch[1])}`,
      truncated: false,
      unknown_block_ids: [],
    });
    return;
  }

  writeJson(response, 404, { message: `Mock Notion route not implemented: ${request.method} ${route}` });
}

function mockNotionPage(id, title) {
  return {
    object: 'page',
    id,
    title: [{ plain_text: title }],
    parent: { type: 'workspace', workspace: true },
    archived: false,
    in_trash: false,
    created_time: '2026-03-11T00:00:00.000Z',
    last_edited_time: '2026-03-11T00:00:00.000Z',
  };
}

function mockNotionDatabase(id, title, dataSources = []) {
  return {
    object: 'database',
    id,
    title: [{ plain_text: title }],
    parent: { type: 'workspace', workspace: true },
    data_sources: dataSources.map((source) => ({
      object: 'data_source',
      id: source.id,
      name: source.name,
    })),
  };
}

function mockNotionDataSource() {
  return {
    object: 'data_source',
    id: 'mock-ds-from-db',
    name: 'Mock database source',
    parent: {
      type: 'database_id',
      database_id: 'mock-db-container',
    },
    properties: {
      Name: {
        id: 'mock-prop-name',
        name: 'Name',
        type: 'title',
        title: {},
      },
      Status: {
        id: 'mock-prop-status',
        name: 'Status',
        type: 'status',
        status: {
          options: [
            { id: 'mock-status-open', name: 'Open', color: 'green' },
            { id: 'mock-status-closed', name: 'Closed', color: 'gray' },
          ],
        },
      },
    },
  };
}

function mockNotionTemplatePage() {
  return {
    object: 'page',
    id: 'mock-template-default',
    parent: {
      type: 'data_source_id',
      data_source_id: 'mock-ds-from-db',
    },
    icon: {
      type: 'emoji',
      emoji: '🧩',
    },
    properties: {
      Name: {
        id: 'mock-prop-name',
        type: 'title',
        title: [{ plain_text: 'Default mock row' }],
      },
      Status: {
        id: 'mock-prop-status',
        type: 'status',
        status: { id: 'mock-status-closed', name: 'Closed', color: 'gray' },
      },
    },
    created_time: '2026-03-11T00:00:00.000Z',
    last_edited_time: '2026-03-11T00:00:00.000Z',
  };
}

function mockNotionFilterReferencedRow() {
  return {
    object: 'page',
    id: MOCK_VIEW_FILTER_ROW_ID,
    parent: {
      type: 'data_source_id',
      data_source_id: 'mock-ds-from-db',
    },
    properties: {
      Name: {
        id: 'mock-prop-name',
        type: 'title',
        title: [{ plain_text: 'Mock filter referenced row' }],
      },
      Status: {
        id: 'mock-prop-status',
        type: 'status',
        status: { id: 'mock-status-open', name: 'Open', color: 'green' },
      },
    },
    created_time: '2026-03-11T00:00:00.000Z',
    last_edited_time: '2026-03-11T00:00:00.000Z',
  };
}

function mockNotionLinkedRowDataSource() {
  return {
    object: 'data_source',
    id: 'mock-ds-row-linked',
    name: 'Mock row linked source',
    parent: {
      type: 'database_id',
      database_id: 'mock-row-linked-db',
    },
    properties: {
      Name: {
        id: 'mock-row-linked-prop-name',
        name: 'Name',
        type: 'title',
        title: {},
      },
      'Related source row': {
        id: 'mock-row-linked-prop-related-source-row',
        name: 'Related source row',
        type: 'relation',
        relation: {
          data_source_id: 'mock-ds-from-db',
        },
      },
    },
  };
}

function mockNotionRichMentionedDataSource() {
  return {
    object: 'data_source',
    id: 'mock-rich-mentioned-ds',
    name: 'Mock rich text mentioned source',
    parent: {
      type: 'database_id',
      database_id: 'mock-rich-mentioned-db',
    },
    properties: {
      Name: {
        id: 'mock-rich-mentioned-prop-name',
        name: 'Name',
        type: 'title',
        title: {},
      },
    },
  };
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function writeJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function parseArgs(args) {
  const parsed = {
    url: DEFAULT_BASE_URL,
    mockNotionApiBase: DEFAULT_MOCK_NOTION_API_BASE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    expectStoredConnection: DEFAULT_EXPECT_STORED_CONNECTION,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--url') {
      parsed.url = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive number');
      }
      i += 1;
      continue;
    }
    if (arg === '--mock-notion-api-base') {
      parsed.mockNotionApiBase = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--expect-stored-connection') {
      parsed.expectStoredConnection = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/notion-import-smoke.mjs [options]

Checks Notion API import job creation, listing, permission denial, cancel, and
retry controls against a running Hanji EdgeBase runtime. It does not call
the external Notion API unless a real token path is tested separately.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or http://127.0.0.1:8787.
  --mock-notion-api-base <url>
                          Start a small mock Notion API at this URL and verify cursor continuation.
                          The EdgeBase runtime must also be started with HANJI_NOTION_API_BASE=<url>.
  --expect-stored-connection
                          Require encrypted stored Notion connection checks to pass.
                          The EdgeBase runtime must have HANJI_NOTION_IMPORT_SECRET configured.
  --timeout-ms <number>   Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
`);
}

async function assertOrganizationAuditEvent(baseUrl, token, organizationId, options) {
  const directory = await callFunction(baseUrl, token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
    auditAction: options.action,
    auditTargetType: options.targetType,
    auditLimit: options.auditLimit ?? 20,
  });
  const events = Array.isArray(directory?.organizationAuditEvents)
    ? directory.organizationAuditEvents
    : [];
  const event = events.find((item) =>
    item?.action === options.action &&
      (!options.targetType || item.targetType === options.targetType) &&
      (!options.targetId || item.targetId === options.targetId)
  );
  assert(event, options.message);
  if (options.predicate) {
    assert(options.predicate(event), options.message);
  }
  return event;
}

function assertJobProgress(job, currentStep, currentStatus, percent, label, expectedSteps = []) {
  assert(job?.progress?.currentStep === currentStep, `${label} must expose current progress step "${currentStep}"`);
  assert(job?.progress?.currentStatus === currentStatus, `${label} must expose progress status "${currentStatus}"`);
  assert(typeof job.progress.currentLabel === 'string' && job.progress.currentLabel.length > 0, `${label} must expose a current progress label`);
  assert(
    typeof job.progress.percent === 'number' &&
      Number.isFinite(job.progress.percent) &&
      job.progress.percent >= 0 &&
      job.progress.percent <= 100,
    `${label} must expose bounded numeric progress`,
  );
  if (percent !== undefined) {
    assert(job.progress.percent === percent, `${label} must expose ${percent}% progress`);
  }
  const steps = Array.isArray(job?.progress?.steps) ? job.progress.steps : [];
  const stepKeys = steps.map((item) => item?.key).filter((key) => typeof key === 'string');
  assert(new Set(stepKeys).size === stepKeys.length, `${label} must not duplicate progress step entries`);
  for (let index = 1; index < stepKeys.length; index += 1) {
    const previousOrder = IMPORT_PROGRESS_ORDER.indexOf(stepKeys[index - 1]);
    const currentOrder = IMPORT_PROGRESS_ORDER.indexOf(stepKeys[index]);
    assert(
      (previousOrder === -1 ? 999 : previousOrder) <= (currentOrder === -1 ? 999 : currentOrder),
      `${label} must keep progress step history in product order`,
    );
  }
  const step = steps.find((item) => item?.key === currentStep);
  assert(step?.status === currentStatus, `${label} must keep a structured progress step entry`);
  assert(typeof step?.label === 'string' && step.label.length > 0, `${label} must keep a structured progress step label`);
  for (const expectedStep of expectedSteps) {
    const matchedStep = steps.find((item) => item?.key === expectedStep.key);
    assert(matchedStep, `${label} must keep progress history for step "${expectedStep.key}"`);
    assert(
      matchedStep.status === expectedStep.status,
      `${label} must keep progress step "${expectedStep.key}" status "${expectedStep.status}"`,
    );
    assert(typeof matchedStep.label === 'string' && matchedStep.label.length > 0, `${label} must label progress step "${expectedStep.key}"`);
  }
  assert(typeof job.progress.lastUpdatedAt === 'string', `${label} must record when progress last changed`);
}
