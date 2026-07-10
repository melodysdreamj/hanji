#!/usr/bin/env node
// Bootstrap pages-delta smoke (local-first roadmap §7): a client that echoes
// the pagesSyncedAt watermark back as pagesSince must receive only changed
// pages plus the visible-id list (which also conveys deletions), instead of
// the full page payload.

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_BASE_URL,
  assert,
  assertRuntimeReachable,
  callFunction,
  normalizeBaseUrl,
  signIn,
} from './lib/harness.mjs';

const options = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL bootstrap delta smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
}

async function main() {
  const apiUrl = normalizeBaseUrl(options.apiUrl);
  console.log(`Bootstrap delta smoke target: ${apiUrl}`);
  await assertRuntimeReachable(apiUrl);

  const session = await signIn(apiUrl);
  const full = await callFunction(apiUrl, session.accessToken, 'workspace-bootstrap', {});
  const workspaceId = full?.workspace?.id;
  assert(workspaceId, 'full bootstrap must return a workspace');
  assert(Array.isArray(full.pages), 'full bootstrap must return the pages array');
  assert(typeof full.pagesSyncedAt === 'string' && full.pagesSyncedAt, 'full bootstrap must return pagesSyncedAt');
  assert(full.pagesDelta === undefined, 'full bootstrap must not be flagged as a delta');

  // Unchanged workspace (ids mode): the delta must not re-ship the full page
  // set. The boundary-inclusive '>=' filter that closes the same-millisecond
  // race re-delivers only pages sitting at exactly the watermark ms, and those
  // are always already-known ids the client merges idempotently — never a new
  // or unseen page. It must stay strictly smaller than the full payload.
  const noop = await callFunction(apiUrl, session.accessToken, 'workspace-bootstrap', {
    workspaceId,
    pagesSince: full.pagesSyncedAt,
  });
  assert(noop.pagesDelta === true, 'watermark request must return a delta');
  assert(noop.pages === undefined, 'delta must not include the full pages array');
  assert(Array.isArray(noop.visiblePageIds) && noop.visiblePageIds.length === full.pages.length,
    `delta id list must match the full set (${noop.visiblePageIds?.length} vs ${full.pages.length})`);
  const knownIds = new Set(noop.visiblePageIds);
  assert(Array.isArray(noop.changedPages) && noop.changedPages.length <= knownIds.size,
    `unchanged workspace must not re-ship more than the visible set (got ${noop.changedPages?.length} of ${knownIds.size})`);
  assert(noop.changedPages.every((page) => knownIds.has(page.id)),
    'unchanged workspace must surface no new/unknown page in changedPages (only harmless boundary re-delivery is allowed)');

  // Create a page: the next delta must carry exactly that change.
  const pageId = randomUUID();
  await callFunction(apiUrl, session.accessToken, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Delta smoke ${Date.now()}`,
    position: Date.now(),
  });
  const afterCreate = await callFunction(apiUrl, session.accessToken, 'workspace-bootstrap', {
    workspaceId,
    pagesSince: full.pagesSyncedAt,
  });
  assert(afterCreate.pagesDelta === true, 'post-create request must return a delta');
  assert(afterCreate.changedPages.some((page) => page.id === pageId),
    'delta changedPages must include the created page');
  assert(afterCreate.visiblePageIds.includes(pageId),
    'delta visiblePageIds must include the created page');
  assert(afterCreate.pagesSyncedAt > full.pagesSyncedAt,
    'watermark must advance past the created page');

  // Change-feed mode (§7 v2): with BOTH cursors and an untouched-permissions
  // window, the response is O(changes) — no id list at all.
  assert(typeof full.changesSyncedAt === 'string' && full.changesSyncedAt,
    'full bootstrap must return changesSyncedAt');
  const changesNoop = await callFunction(apiUrl, session.accessToken, 'workspace-bootstrap', {
    workspaceId,
    pagesSince: afterCreate.pagesSyncedAt,
    changesSince: afterCreate.changesSyncedAt,
  });
  assert(changesNoop.pagesDelta === true && changesNoop.deltaMode === 'changes',
    `unchanged window must use changes mode (got ${changesNoop.deltaMode})`);
  assert(changesNoop.visiblePageIds === undefined,
    'changes mode must not ship the visible-id list');
  assert(Array.isArray(changesNoop.deletedPageIds) && changesNoop.deletedPageIds.length === 0,
    'unchanged window must have no tombstones');
  assert(changesNoop.changedPages.length === 0, 'unchanged window must ship 0 page records');

  // Delete it: the tombstone must arrive through the change feed.
  await callFunction(apiUrl, session.accessToken, 'page-mutation', {
    action: 'delete',
    id: pageId,
  });
  const afterDelete = await callFunction(apiUrl, session.accessToken, 'workspace-bootstrap', {
    workspaceId,
    pagesSince: afterCreate.pagesSyncedAt,
    changesSince: afterCreate.changesSyncedAt,
  });
  assert(afterDelete.pagesDelta === true, 'post-delete request must return a delta');
  assert(afterDelete.deltaMode === 'changes',
    `post-delete delta must stay in changes mode (got ${afterDelete.deltaMode})`);
  assert(afterDelete.deletedPageIds.includes(pageId),
    'change-log tombstone must report the deleted page');
  assert(!afterDelete.changedPages.some((page) => page.id === pageId),
    'deleted page must not reappear in changedPages');

  // Legacy ids mode still answers when only the watermark is available.
  const idsMode = await callFunction(apiUrl, session.accessToken, 'workspace-bootstrap', {
    workspaceId,
    pagesSince: afterCreate.pagesSyncedAt,
  });
  assert(idsMode.deltaMode === 'ids' && Array.isArray(idsMode.visiblePageIds),
    'watermark-only requests must keep the id-list mode');
  assert(!idsMode.visiblePageIds.includes(pageId),
    'deleted page must vanish from the id list');

  console.log('PASS bootstrap pages delta: ids mode, changes mode, create, and tombstone delete flows behave.');
}

function parseArgs(args) {
  const parsed = {
    apiUrl: process.env.NOTIONLIKE_EDGEBASE_API_URL ?? DEFAULT_BASE_URL,
  };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--api-url') parsed.apiUrl = args[++i] ?? parsed.apiUrl;
  }
  return parsed;
}
