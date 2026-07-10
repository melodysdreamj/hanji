#!/usr/bin/env node

import {
  DEFAULT_BASE_URL,
  assert,
  assertRuntimeReachable,
  callFunction as harnessCallFunction,
  callPublicFunction,
  expectPublicFunctionStatus,
  fetchWithTimeout,
  normalizeBaseUrl,
  resolveUrl,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';

const DEFAULT_TIMEOUT_MS = 8_000;

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

let owner;
let workspaceId = '';
let rootPageId = '';
let childPageId = '';
let privateSiblingId = '';
let linkedExternalPageId = '';
let publishedLinkedPageId = '';
let databaseId = '';
let rowId = '';
let relatedRowId = '';
let rootFileBlockId = '';
let rootUploadId = '';
let rowUploadId = '';
let uploadKeysById = new Map();

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL public share smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`WARN cleanup failed: ${message}`);
  });
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Public share smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl, { timeoutMs: options.timeoutMs });
  owner = await signIn(baseUrl);

  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');

  const suffix = Date.now();
  rootPageId = crypto.randomUUID();
  const rootTitle = `Public share smoke ${suffix}`;
  const createdRoot = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: rootPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: rootTitle,
    position: suffix,
  });
  assert(createdRoot?.page?.id === rootPageId, 'owner must be able to create a share root');

  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: rootPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Published root paragraph' }] },
    plainText: 'Published root paragraph',
    position: 1,
  });

  rootFileBlockId = crypto.randomUUID();
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: rootFileBlockId,
    pageId: rootPageId,
    parentId: null,
    type: 'file',
    content: { rich: [], url: '', fileName: 'public-root-file.txt' },
    plainText: 'public-root-file.txt',
    position: 2,
  });

  const rootUpload = await uploadWorkspaceFile(baseUrl, owner.token, {
    pageId: rootPageId,
    blockId: rootFileBlockId,
    scope: 'blocks/files',
    name: 'public-root-file.txt',
    content: `public root file ${suffix}`,
    contentType: 'text/plain',
  });
  rootUploadId = rootUpload.id;
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'update',
    id: rootFileBlockId,
    pageId: rootPageId,
    patch: {
      content: { rich: [], url: rootUpload.url, fileName: rootUpload.name },
      plainText: rootUpload.name,
    },
  });

  childPageId = crypto.randomUUID();
  const createdChild = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: childPageId,
    workspaceId,
    parentId: rootPageId,
    parentType: 'page',
    kind: 'page',
    title: 'Public share child page',
    position: suffix + 1,
  });
  assert(createdChild?.page?.id === childPageId, 'owner must be able to create a shared child page');
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: childPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Published child paragraph' }] },
    plainText: 'Published child paragraph',
    position: 1,
  });

  privateSiblingId = crypto.randomUUID();
  await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: privateSiblingId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: 'Private sibling should stay hidden',
    position: suffix + 2,
  });

  linkedExternalPageId = crypto.randomUUID();
  await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: linkedExternalPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: 'Linked page outside shared subtree',
    position: suffix + 2.5,
  });
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: linkedExternalPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Linked external page paragraph' }] },
    plainText: 'Linked external page paragraph',
    position: 1,
  });
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: rootPageId,
    parentId: null,
    type: 'child_page',
    content: { childPageId: linkedExternalPageId },
    plainText: 'Linked page outside shared subtree',
    position: 3,
  });

  // A NON-descendant page referenced from the shared root that IS independently
  // published: it must be followed into the public graph (unlike the private
  // linkedExternalPageId above). Guards the security fix that a child_page /
  // link_to_page reference only widens exposure to pages that are themselves
  // public — an unpublished referenced page must never be republished by
  // embedding its id in a shared page.
  publishedLinkedPageId = crypto.randomUUID();
  await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: publishedLinkedPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: 'Published linked page outside subtree',
    position: suffix + 2.75,
  });
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: publishedLinkedPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Published linked page paragraph' }] },
    plainText: 'Published linked page paragraph',
    position: 1,
  });
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: rootPageId,
    parentId: null,
    type: 'link_to_page',
    content: { childPageId: publishedLinkedPageId },
    plainText: 'Published linked page outside subtree',
    position: 3.5,
  });
  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: publishedLinkedPageId,
    enabled: true,
  });

  databaseId = crypto.randomUUID();
  const createdDatabase = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: databaseId,
    workspaceId,
    parentId: rootPageId,
    parentType: 'page',
    kind: 'database',
    title: 'Public share database',
    position: suffix + 3,
  });
  assert(createdDatabase?.page?.id === databaseId, 'owner must be able to create a shared database');

  const titlePropertyId = crypto.randomUUID();
  const filePropertyId = crypto.randomUUID();
  const estimatePropertyId = crypto.randomUUID();
  const duePropertyId = crypto.randomUUID();
  const relatedRowsPropertyId = crypto.randomUUID();
  const formulaPropertyId = crypto.randomUUID();
  const importedFallbackFormulaPropertyId = crypto.randomUUID();
  const rollupPropertyId = crypto.randomUUID();
  const dueRangeRollupPropertyId = crypto.randomUUID();
  const viewId = crypto.randomUUID();
  const templateId = crypto.randomUUID();
  const linkedDatabaseId = crypto.randomUUID();
  const linkedNotionDatabaseId = crypto.randomUUID();
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: titlePropertyId,
      databaseId,
      name: 'Name',
      type: 'title',
      position: 1,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: filePropertyId,
      databaseId,
      name: 'Attachment',
      type: 'files',
      position: 2,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: estimatePropertyId,
      databaseId,
      name: 'Estimate',
      type: 'number',
      config: { numberFormat: 'number' },
      position: 3,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: relatedRowsPropertyId,
      databaseId,
      name: 'Related rows',
      type: 'relation',
      config: { relationDatabaseId: databaseId },
      position: 4,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: duePropertyId,
      databaseId,
      name: 'Due',
      type: 'date',
      position: 5,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: formulaPropertyId,
      databaseId,
      name: 'Estimate label',
      type: 'formula',
      config: {
        formula:
          'lets(dueRange, prop("Due"), staticRange, dateRange(parseDate("2026-06-24"), parseDate("2026-06-30")), concat(upper("estimate"), repeat("!", 2), " ", format(toNumber("0") + prop("Estimate")), " due ", formatDate(dateAdd(dueRange, 1, "days"), "YYYY-MM-DD"), " math ", format(round(sqrt(5), 2)), " range ", dateStart(dueRange), " ", dateEnd(dueRange), " static ", format(dateBetween(dateEnd(staticRange), dateStart(staticRange), "days"))))',
      },
      position: 6,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: rollupPropertyId,
      databaseId,
      name: 'Related names',
      type: 'rollup',
      config: {
        rollupRelationPropertyId: relatedRowsPropertyId,
        rollupTargetPropertyId: titlePropertyId,
        rollupFunction: 'show_original',
      },
      position: 7,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: importedFallbackFormulaPropertyId,
      databaseId,
      name: 'Imported fallback formula',
      type: 'formula',
      config: {
        formula: '',
        notionFormula: { expression: 'map(prop("Name"))' },
        unsupportedFormulaFunctions: ['map'],
      },
      position: 8,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: dueRangeRollupPropertyId,
      databaseId,
      name: 'Related due range',
      type: 'rollup',
      config: {
        rollupRelationPropertyId: relatedRowsPropertyId,
        rollupTargetPropertyId: duePropertyId,
        rollupFunction: 'date_range',
      },
      position: 9,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_views',
    record: {
      id: viewId,
      databaseId,
      name: 'Public table',
      type: 'table',
      config: {
        visibleProperties: [
          titlePropertyId,
          filePropertyId,
          estimatePropertyId,
          relatedRowsPropertyId,
          duePropertyId,
          formulaPropertyId,
          importedFallbackFormulaPropertyId,
          rollupPropertyId,
          dueRangeRollupPropertyId,
        ],
        notion: { parent: { database_id: linkedNotionDatabaseId } },
      },
      position: 1,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_templates',
    record: {
      id: templateId,
      databaseId,
      name: 'Public row template',
      title: 'Template row',
      properties: {},
      blocks: [],
      isDefault: false,
      position: 1,
    },
  });

  const rowFileUpload = await uploadWorkspaceFile(baseUrl, owner.token, {
    databaseId,
    propertyId: filePropertyId,
    scope: 'database/files',
    name: 'public-row-file.txt',
    content: `public row file ${suffix}`,
    contentType: 'text/plain',
  });
  rowUploadId = rowFileUpload.id;

  relatedRowId = crypto.randomUUID();
  const createdRelatedRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: relatedRowId,
    databaseId,
    title: 'Public related row',
    properties: {
      [estimatePropertyId]: 4,
      [duePropertyId]: '2026-06-23',
    },
  });
  assert(createdRelatedRow?.row?.id === relatedRowId, 'owner must be able to create a shared related row');

  rowId = crypto.randomUUID();
  const createdRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: rowId,
    databaseId,
    title: 'Public row',
    properties: {
      [filePropertyId]: [
        {
          id: rowFileUpload.id,
          name: rowFileUpload.name,
          url: rowFileUpload.url,
          type: rowFileUpload.contentType,
          size: rowFileUpload.size,
        },
      ],
      [estimatePropertyId]: 7,
      [duePropertyId]: '2026-06-24/2026-06-30',
      [relatedRowsPropertyId]: [relatedRowId],
    },
  });
  assert(createdRow?.row?.id === rowId, 'owner must be able to create a shared database row');
  await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'update',
    id: rowId,
    patch: {
      properties: {
        ...(createdRow.row.properties ?? {}),
        [importedFallbackFormulaPropertyId]: 'Imported computed value from Notion',
      },
    },
  });
  const linkedDatabase = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: linkedDatabaseId,
    workspaceId,
    parentId: rowId,
    parentType: 'page',
    kind: 'database',
    title: 'Linked public row database',
    properties: {
      notionLinkedDatabaseSourceUnavailable: true,
      notionDatabaseId: linkedNotionDatabaseId,
    },
    position: 1,
  });
  assert(linkedDatabase?.page?.id === linkedDatabaseId, 'owner must be able to create a linked database placeholder');
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: rowId,
    parentId: null,
    type: 'inline_database',
    content: { childPageId: linkedDatabaseId },
    plainText: 'Linked public row database',
    position: 1,
  });

  await expectPublicFunctionStatus(baseUrl, 'share-mutation', {
    action: 'publicPage',
    token: 'missing-public-share-token',
  }, 404);
  console.log('PASS missing public share tokens are denied.');

  const sharing = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: rootPageId,
    enabled: true,
    expiresIn: '7d',
  });
  const shareToken = sharing?.shareLink?.token;
  assert(shareToken, 'setWebSharing must return a public share token');
  assert(sharing.shareLink?.expiresAt, 'setWebSharing must persist public share expiration');

  const shared = await callPublicFunction(baseUrl, 'share-mutation', {
    action: 'publicPage',
    token: shareToken,
  });
  assert(shared?.page?.id === rootPageId, 'public share must return the shared root page');
  assert(shared.shareLink?.enabled === true, 'public share payload must include the enabled share link');

  const publicPageIds = new Set((shared.pages ?? []).map((page) => page.id));
  // Genuine subpage (parentId chains to root) and an independently-published
  // referenced page are included; the private referenced page is not.
  for (const expectedId of [rootPageId, childPageId, publishedLinkedPageId]) {
    assert(publicPageIds.has(expectedId), `public share must include page ${expectedId}`);
  }
  for (const hiddenId of [databaseId, relatedRowId, rowId]) {
    assert(!publicPageIds.has(hiddenId), `root public share must not include hidden embedded database page ${hiddenId}`);
  }
  assert(!publicPageIds.has(privateSiblingId), 'public share must not include pages outside the shared subtree');
  // A child_page / link_to_page block can reference an arbitrary, unvalidated
  // page id. An unpublished referenced page must NOT be republished merely
  // because a shared page embeds/links it.
  assert(
    !publicPageIds.has(linkedExternalPageId),
    'public share must not leak an unpublished page referenced by a child_page/link_to_page block',
  );
  assert(
    !(shared.blocks ?? []).some((block) => block.type === 'inline_database' || block.type === 'child_database'),
    'root public share must omit embedded database blocks by default',
  );
  console.log('PASS public share snapshots include shared pages while hiding embedded databases by default.');

  assert(
    (shared.blocks ?? []).some((block) => block.pageId === childPageId && block.plainText === 'Published child paragraph'),
    'public share must include child page blocks',
  );
  assert(
    (shared.blocks ?? []).some((block) => block.pageId === publishedLinkedPageId && block.plainText === 'Published linked page paragraph'),
    'public share must include blocks for independently-published linked pages outside the parent subtree',
  );
  assert(
    !(shared.blocks ?? []).some((block) => block.pageId === linkedExternalPageId),
    'public share must not include blocks for an unpublished referenced page',
  );
  const sharedFileBlock = (shared.blocks ?? []).find((block) => block.id === rootFileBlockId);
  assert(sharedFileBlock, 'public share must include the shared file block');
  assertSignedUrl(sharedFileBlock.content?.url, rootUpload.url, 'shared file block URL');
  console.log('PASS public share signs uploaded file block URLs.');

  const databaseSharing = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: databaseId,
    enabled: true,
    expiresAt: null,
  });
  const databaseShareToken = databaseSharing?.shareLink?.token;
  assert(databaseShareToken, 'setWebSharing must return a public share token for direct databases');
  const databaseShared = await callPublicFunction(baseUrl, 'share-mutation', {
    action: 'publicPage',
    token: databaseShareToken,
  });
  assert(databaseShared?.page?.id === databaseId, 'direct public database share must return the shared database as root page');
  const databasePublicPageIds = new Set((databaseShared.pages ?? []).map((page) => page.id));
  for (const expectedId of [databaseId, relatedRowId, rowId]) {
    assert(databasePublicPageIds.has(expectedId), `direct public database share must include database page ${expectedId}`);
  }

  assert(
    (databaseShared.properties ?? []).some((property) => property.id === filePropertyId && property.type === 'files'),
    'direct public database share must include shared database file properties',
  );
  assert(
    (databaseShared.views ?? []).some((view) => view.id === viewId && view.type === 'table'),
    'direct public database share must include shared database views',
  );
  assert(
    (databaseShared.templates ?? []).some((template) => template.id === templateId),
    'direct public database share must include shared database templates',
  );
  const sharedRow = (databaseShared.pages ?? []).find((page) => page.id === rowId);
  const sharedRowFiles = sharedRow?.properties?.[filePropertyId];
  const sharedRowUrl = Array.isArray(sharedRowFiles) ? sharedRowFiles[0]?.url : undefined;
  assertSignedUrl(sharedRowUrl, rowFileUpload.url, 'shared database row file URL');
  const sharedFormula = sharedRow?.__computed?.[formulaPropertyId];
  const sharedImportedFallbackFormula = sharedRow?.__computed?.[importedFallbackFormulaPropertyId];
  const sharedRollup = sharedRow?.__computed?.[rollupPropertyId];
  const sharedDueRangeRollup = sharedRow?.__computed?.[dueRangeRollupPropertyId];
  assert(
    sharedFormula?.value === 'ESTIMATE!! 7 due 2026-06-25 math 2.24 range 2026-06-24 2026-06-30 static 6',
    'public share must include shared formula values',
  );
  assert(
    sharedFormula?.formatted === 'ESTIMATE!! 7 due 2026-06-25 math 2.24 range 2026-06-24 2026-06-30 static 6',
    'public share must include formatted shared formula values',
  );
  assert(
    sharedImportedFallbackFormula?.value === 'Imported computed value from Notion',
    'public share must include imported computed fallback formula values',
  );
  assert(
    sharedImportedFallbackFormula?.formatted === 'Imported computed value from Notion',
    'public share must include formatted imported computed fallback formula values',
  );
  assert(sharedRollup?.value === 'Public related row', 'public share must include shared rollup values');
  assert(sharedRollup?.formatted === 'Public related row', 'public share must include formatted shared rollup values');
  assert(sharedDueRangeRollup?.value === '2026-06-23', 'public share must include advanced shared rollup values');
  assert(sharedDueRangeRollup?.formatted === '2026-06-23', 'public share must include formatted advanced shared rollup values');
  console.log('PASS direct public database shares include metadata, computed values, and signed row file attachments.');

  const rowSharing = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: rowId,
    enabled: true,
    expiresAt: null,
  });
  const rowShareToken = rowSharing?.shareLink?.token;
  assert(rowShareToken, 'setWebSharing must return a public share token for direct database rows');
  const directRowShare = await callPublicFunction(baseUrl, 'share-mutation', {
    action: 'publicPage',
    token: rowShareToken,
  });
  assert(directRowShare?.page?.id === rowId, 'direct public row share must return the shared row as root page');
  const directNavigableIds = new Set(directRowShare.navigablePageIds ?? []);
  assert(directNavigableIds.has(rowId), 'direct public row share must mark the shared row as navigable');
  assert(
    !directNavigableIds.has(databaseId),
    'direct public row share must not make the private parent database page navigable just to render row properties',
  );
  assert(
    !directNavigableIds.has(relatedRowId),
    'direct public row share must not make relation previews or linked-database support rows navigable',
  );
  assert(
    (directRowShare.properties ?? []).some((property) => property.id === estimatePropertyId && property.databaseId === databaseId),
    'direct public row share must include parent database properties so row properties render',
  );
  assert(
    (directRowShare.views ?? []).some((view) => view.id === viewId && view.databaseId === databaseId),
    'direct public row share must include parent database row-detail view metadata',
  );
  const directRootRow = (directRowShare.pages ?? []).find((page) => page.id === rowId);
  assert(directRootRow?.properties?.[estimatePropertyId] === 7, 'direct public row share must include filled row property values');
  const directRowFiles = directRootRow?.properties?.[filePropertyId];
  const directRowUrl = Array.isArray(directRowFiles) ? directRowFiles[0]?.url : undefined;
  assertSignedUrl(directRowUrl, rowFileUpload.url, 'direct shared database row file URL');
  const directRelatedPreview = (directRowShare.pages ?? []).find((page) => page.id === relatedRowId);
  assert(
    directRelatedPreview?.title === 'Public related row',
    'direct public row share must include relation target title previews for read-only relation chips',
  );
  assert(
    !(directRowShare.blocks ?? []).some((block) => block.type === 'inline_database' || block.type === 'child_database'),
    'direct public row share must omit embedded database blocks by default',
  );
  assert(
    !(directRowShare.properties ?? []).some((property) => property.databaseId === linkedDatabaseId),
    'direct public row share must not include embedded linked database placeholder properties by default',
  );
  assert(
    !(directRowShare.views ?? []).some((view) => view.databaseId === linkedDatabaseId),
    'direct public row share must not include embedded linked database placeholder views by default',
  );
  assert(
    !(directRowShare.pages ?? []).some((page) => page.id === linkedDatabaseId || page.parentId === linkedDatabaseId),
    'direct public row share must not include embedded linked database pages or rows by default',
  );
  console.log('PASS direct public database-row shares include row properties while hiding embedded database bodies.');

  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: rootPageId,
    enabled: true,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  await expectPublicFunctionStatus(baseUrl, 'share-mutation', {
    action: 'publicPage',
    token: shareToken,
  }, 404);
  const unexpiredSharing = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: rootPageId,
    enabled: true,
    expiresAt: null,
  });
  assert(unexpiredSharing.shareLink?.expiresAt === null, 'setWebSharing must clear public share expiration');
  const unexpiredShared = await callPublicFunction(baseUrl, 'share-mutation', {
    action: 'publicPage',
    token: shareToken,
  });
  assert(unexpiredShared?.page?.id === rootPageId, 'clearing expiration must restore the public share');
  console.log('PASS public share expiration is enforced and can be cleared.');

  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: rootPageId,
    enabled: false,
  });
  await expectPublicFunctionStatus(baseUrl, 'share-mutation', {
    action: 'publicPage',
    token: shareToken,
  }, 404);
  console.log('PASS disabling Share to web blocks public snapshots.');

  await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'delete',
    id: rootPageId,
  });
  rootPageId = '';
  childPageId = '';
  databaseId = '';
  rowId = '';
  relatedRowId = '';
  rootFileBlockId = '';
  rootUploadId = '';
  rowUploadId = '';

  await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'delete',
    id: privateSiblingId,
  });
  privateSiblingId = '';

  await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'delete',
    id: linkedExternalPageId,
  });
  linkedExternalPageId = '';

  console.log('\nPASS public share snapshot flow works through product APIs.');
}

async function uploadWorkspaceFile(baseUrl, token, input) {
  const bytes = new TextEncoder().encode(input.content);
  const prepared = await callFunction(baseUrl, token, 'file-mutation', {
    action: 'prepareUpload',
    pageId: input.pageId,
    blockId: input.blockId,
    databaseId: input.databaseId,
    propertyId: input.propertyId,
    scope: input.scope,
    name: input.name,
    size: bytes.byteLength,
    contentType: input.contentType,
  });
  const upload = prepared?.upload;
  assert(upload?.id && upload?.key, 'prepareUpload must return an upload id and key');
  if (input.scope === 'blocks/files') rootUploadId ||= upload.id;
  if (input.scope === 'database/files') rowUploadId ||= upload.id;
  uploadKeysById.set(upload.id, upload.key);
  assert(
    prepared.uploadUrl,
    'prepareUpload must return a signed upload URL in the local EdgeBase runtime',
  );

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: input.contentType }), upload.key);
  form.append('key', upload.key);
  form.append('customMetadata', JSON.stringify({
    uploadId: upload.id,
    workspaceId: upload.workspaceId,
    pageId: upload.pageId ?? '',
    blockId: upload.blockId ?? '',
    databaseId: upload.databaseId ?? '',
    propertyId: upload.propertyId ?? '',
    originalName: input.name,
  }));

  const uploadResponse = await fetchWithTimeout(prepared.uploadUrl, {
    method: 'POST',
    body: form,
  });
  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`signed file upload returned HTTP ${uploadResponse.status}: ${text.slice(0, 200)}`);
  }

  const url = storageUrl(baseUrl, upload.bucket || 'files', upload.key);
  const completed = await callFunction(baseUrl, token, 'file-mutation', {
    action: 'completeUpload',
    id: upload.id,
    key: upload.key,
    url,
  });
  const completedUpload = completed?.upload;
  assert(completedUpload?.status === 'uploaded', 'completeUpload must mark the file uploaded');
  assert(completedUpload.url === url, 'completeUpload must preserve the storage URL');
  return completedUpload;
}

async function cleanup() {
  if (!owner?.token) return;
  const baseUrl = normalizeBaseUrl(options.url);

  for (const uploadId of [rowUploadId, rootUploadId].filter(Boolean)) {
    await callFunction(baseUrl, owner.token, 'file-mutation', {
      action: 'delete',
      uploadId,
      // Routing hint for the workspace-DO split: keys embed the workspace id.
      key: uploadKeysById.get(uploadId),
    }).catch(() => {});
  }
  rowUploadId = '';
  rootUploadId = '';

  for (const pageId of [rootPageId, privateSiblingId, linkedExternalPageId].filter(Boolean)) {
    await callFunction(baseUrl, owner.token, 'page-mutation', {
      action: 'delete',
      id: pageId,
    }).catch(() => {});
  }
  rootPageId = '';
  childPageId = '';
  privateSiblingId = '';
  linkedExternalPageId = '';
  databaseId = '';
  rowId = '';
  relatedRowId = '';
  rootFileBlockId = '';
}

function parseArgs(args) {
  const parsed = {
    url: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
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
  console.log(`Usage: node scripts/public-share-smoke.mjs [options]

Checks public Share to web snapshots, subtree scoping, database metadata, and
signed shared file URLs against a running Notionlike EdgeBase runtime.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or http://127.0.0.1:8787.
  --timeout-ms <number>   Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
`);
}

// This smoke keeps request bodies in callFunction failure messages (its
// pre-harness behavior); the harness exposes that via `includeBodyInError`.
function callFunction(baseUrl, token, name, body) {
  return harnessCallFunction(baseUrl, token, name, body, { includeBodyInError: true });
}

function storageUrl(baseUrl, bucket, key) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return resolveUrl(baseUrl, `/api/storage/${encodeURIComponent(bucket)}/${encodedKey}`);
}

function assertSignedUrl(value, rawUrl, label) {
  assert(typeof value === 'string' && value, `${label} must be present`);
  assert(value !== rawUrl, `${label} must be a signed URL, not the raw storage URL`);
}
