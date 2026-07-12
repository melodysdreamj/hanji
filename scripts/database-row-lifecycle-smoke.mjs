#!/usr/bin/env node

import {
  DEFAULT_BASE_URL,
  assert,
  assertRuntimeReachable,
  callFunction,
  expectFunctionStatus,
  fetchWithTimeout,
  normalizeBaseUrl,
  permanentlyDeletePage,
  permanentlyDeleteDatabaseRow,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';

const DEFAULT_TIMEOUT_MS = 8_000;

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

let owner;
let workspaceId = '';
let organizationId = '';
let databaseId = '';
let rowId = '';
let childPageId = '';
const uploadIds = [];

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database row lifecycle smoke: ${message}`);
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
  console.log(`Database row lifecycle smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  owner = await signIn(baseUrl);

  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  workspaceId = bootstrap?.workspace?.id;
  organizationId = bootstrap?.organization?.id ?? '';
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');
  assert(organizationId, 'workspace-bootstrap must return an organization id');

  const suffix = Date.now();
  databaseId = crypto.randomUUID();
  const database = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `Row lifecycle smoke ${suffix}`,
    position: suffix,
    seedRows: false,
  });
  assert(database?.page?.id === databaseId, 'owner must be able to create a lifecycle smoke database');

  rowId = crypto.randomUUID();
  const row = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: rowId,
    databaseId,
    title: 'Lifecycle row',
  });
  assert(row?.row?.id === rowId, 'owner must be able to create a database row');

  const secondRowId = crypto.randomUUID();
  const thirdRowId = crypto.randomUUID();
  const secondRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: secondRowId,
    databaseId,
    title: 'Lifecycle row second',
  });
  const thirdRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: thirdRowId,
    databaseId,
    title: 'Lifecycle row third',
  });
  assert(secondRow?.row?.id === secondRowId, 'owner must be able to create a second database row');
  assert(thirdRow?.row?.id === thirdRowId, 'owner must be able to create a third database row');

  const movedThird = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'move',
    id: thirdRowId,
    targetId: rowId,
    side: 'before',
  });
  assert(movedThird?.row?.id === thirdRowId, 'row move must return the moved row');
  assert(
    movedThird.row.position < row.row.position,
    'moving the third row before the first row must assign an earlier position',
  );
  await expectFunctionStatus(baseUrl, owner.token, 'database-row-mutation', {
    action: 'move',
    id: rowId,
    targetId: thirdRowId,
    side: 'middle',
  }, 400);
  await expectFunctionStatus(baseUrl, owner.token, 'database-row-mutation', {
    action: 'move',
    id: rowId,
    targetId: rowId,
    side: 'after',
  }, 400);
  console.log('PASS database rows can be moved through product APIs.');

  const rowBlockId = crypto.randomUUID();
  const rowBlock = await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: rowBlockId,
    pageId: rowId,
    parentId: null,
    type: 'file',
    content: { rich: [], url: '', fileName: 'row-lifecycle.txt' },
    plainText: 'row-lifecycle.txt',
    position: 1,
  });
  assert(rowBlock?.block?.id === rowBlockId, 'owner must be able to create a row block');

  const comment = await callFunction(baseUrl, owner.token, 'comment-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: rowId,
    blockId: rowBlockId,
    body: { rich: [{ text: 'Row lifecycle comment' }] },
  });
  assert(comment?.comment?.id, 'owner must be able to comment on a row page');

  const operation = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: rowId,
    blockId: rowBlockId,
    clientId: 'row-lifecycle-owner',
    kind: 'text',
    operation: { type: 'replace', from: 0, to: 0, text: 'row lifecycle' },
    beforeText: '',
    afterText: 'row lifecycle',
    revision: 1,
  });
  assert(operation?.operation?.id, 'owner must be able to create row collaboration operations');

  const prepared = await callFunction(baseUrl, owner.token, 'file-mutation', {
    action: 'prepareUpload',
    pageId: rowId,
    blockId: rowBlockId,
    scope: 'blocks/files',
    name: 'row-lifecycle-upload.txt',
    size: 16,
    contentType: 'text/plain',
  });
  const uploadId = prepared?.upload?.id;
  assert(uploadId, 'row upload preparation must return an upload id');
  uploadIds.push(uploadId);
  const upload = prepared?.upload;
  assert(upload?.key && prepared?.uploadUrl, 'row upload preparation must return a key and signed URL');
  const uploadBytes = new Uint8Array(16).fill(65);
  const uploadForm = new FormData();
  uploadForm.append('file', new Blob([uploadBytes], { type: 'text/plain' }), upload.key);
  uploadForm.append('key', upload.key);
  uploadForm.append('customMetadata', JSON.stringify({
    uploadId,
    workspaceId,
    pageId: rowId,
    blockId: rowBlockId,
    originalName: upload.name,
  }));
  const uploadResponse = await fetchWithTimeout(prepared.uploadUrl, {
    method: 'POST',
    body: uploadForm,
  });
  assert(uploadResponse.ok, `signed row upload returned HTTP ${uploadResponse.status}`);
  const completed = await callFunction(baseUrl, owner.token, 'file-mutation', {
    action: 'completeUpload',
    id: uploadId,
    key: upload.key,
    url: `${baseUrl}/api/storage/${upload.bucket || 'files'}/${upload.key}`,
  });
  assert(completed?.upload?.status === 'uploaded', 'row upload must be completed before lifecycle deletion');

  childPageId = crypto.randomUUID();
  const child = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: childPageId,
    workspaceId,
    parentId: rowId,
    parentType: 'page',
    kind: 'page',
    title: 'Lifecycle child page',
    position: suffix + 1,
  });
  assert(child?.page?.id === childPageId, 'owner must be able to create a child page under a row');

  const childBlock = await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: childPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Child page content' }] },
    plainText: 'Child page content',
    position: 1,
  });
  assert(childBlock?.block?.id, 'owner must be able to create a child page block');
  console.log('PASS database rows can hold page content, comments, files, collaboration logs, and child pages.');

  const trashed = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'trash',
    id: rowId,
  });
  assert(
    Array.isArray(trashed?.pages) &&
      trashed.pages.some((page) => page.id === rowId && page.inTrash === true) &&
      trashed.pages.some((page) => page.id === childPageId && page.inTrash === true),
    'trashing a row must trash the row subtree',
  );
  const trashedRow = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'page',
    pageId: rowId,
  });
  assert(
    trashedRow?.page?.id === rowId && trashedRow.page.inTrash === true,
    'trashed row page must remain readable as a trash-state projection',
  );
  const visibleRows = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'databaseRows',
    databaseId,
  });
  assert(
    Array.isArray(visibleRows?.rows) && !visibleRows.rows.some((item) => item.id === rowId),
    'trashed rows must disappear from default database row listings',
  );
  console.log('PASS database row trash marks the row subtree and hides rows from default listings.');

  const restored = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'restore',
    id: rowId,
  });
  assert(
    Array.isArray(restored?.pages) &&
      restored.pages.some((page) => page.id === rowId && page.inTrash === false) &&
      restored.pages.some((page) => page.id === childPageId && page.inTrash === false),
    'restoring a row must restore the row subtree',
  );
  const restoredRow = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'page',
    pageId: rowId,
  });
  assert(restoredRow?.page?.id === rowId, 'restored row page must be readable again');
  console.log('PASS database row restore brings the row subtree back.');

  const deleted = await permanentlyDeleteDatabaseRow(baseUrl, owner.token, rowId, { call: callFunction });
  const deletedIds = new Set(deleted?.deletedIds ?? []);
  assert(deletedIds.has(rowId), 'permanent row delete must include the row id');
  assert(deletedIds.has(childPageId), 'permanent row delete must include child page ids');
  assert(deleted?.cleanup?.blocks >= 2, 'permanent row delete must clean row subtree blocks');
  assert(deleted?.cleanup?.comments >= 1, 'permanent row delete must clean row subtree comments');
  assert(
    deleted?.cleanup?.collaborationOperations >= 1,
    'permanent row delete must clean row collaboration logs',
  );
  assert(deleted?.cleanup?.fileUploads >= 1, 'permanent row delete must clean attached upload grants');
  const rowDeleteAudit = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
    auditAction: 'database_row.delete',
    auditLimit: 10,
  });
  assert(
    rowDeleteAudit?.organizationAuditEvents?.some(
      (event) =>
        event.targetId === rowId &&
        event.metadata?.rowId === rowId &&
        event.metadata?.databaseId === databaseId &&
        event.metadata?.deletedPageCount >= 2,
    ),
    'permanent database row delete must record a filterable organization audit event',
  );
  removeUploadId(uploadId);
  rowId = '';
  childPageId = '';
  console.log('PASS permanent database row delete cleans content and records organization audit events.');

  console.log('\nPASS database row lifecycle works through product APIs.');
}

async function cleanup() {
  if (!owner?.token) return;
  const baseUrl = normalizeBaseUrl(options.url);

  for (const uploadId of [...uploadIds].reverse()) {
    await callFunction(baseUrl, owner.token, 'file-mutation', {
      action: 'delete',
      uploadId,
    }).catch(() => {});
    removeUploadId(uploadId);
  }

  if (rowId) {
    await permanentlyDeleteDatabaseRow(baseUrl, owner.token, rowId, { call: callFunction }).catch(() => {});
    rowId = '';
    childPageId = '';
  }

  if (databaseId) {
    await permanentlyDeletePage(baseUrl, owner.token, databaseId, { call: callFunction }).catch(() => {});
    databaseId = '';
  }
}

function removeUploadId(uploadId) {
  const index = uploadIds.indexOf(uploadId);
  if (index >= 0) uploadIds.splice(index, 1);
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
  console.log(`Usage: node scripts/database-row-lifecycle-smoke.mjs [options]

Checks database row trash, restore, permanent delete, and row-page cleanup for
blocks, comments, collaboration logs, files, and child pages against a running
Hanji EdgeBase runtime.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or http://127.0.0.1:8787.
  --timeout-ms <number>   Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
`);
}
