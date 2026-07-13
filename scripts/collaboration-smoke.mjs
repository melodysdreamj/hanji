#!/usr/bin/env node

import { createRequire } from 'node:module';

import {
  finalizeRegisteredSmokeAccounts,
  permanentlyDeletePage,
  DEFAULT_BASE_URL,
  assert,
  assertRuntimeReachable,
  callFunction,
  expectFunctionStatus,
  normalizeBaseUrl,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';

const DEFAULT_TIMEOUT_MS = 8_000;
const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url));

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);
let yjsModulePromise;

let owner;
let viewer;
let workspaceId = '';
let pageId = '';
let blockId = '';
let permissionId = '';

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL collaboration smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`WARN cleanup failed: ${message}`);
  });
  await finalizeRegisteredSmokeAccounts('collaboration smoke');
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Collaboration smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl, { timeoutMs: options.timeoutMs });
  owner = await signIn(baseUrl);
  viewer = await signIn(baseUrl);
  assert(owner.userId !== viewer.userId, 'owner and viewer must be different users');

  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');

  pageId = crypto.randomUUID();
  const created = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Collaboration smoke ${new Date().toISOString()}`,
    position: Date.now(),
  });
  assert(created?.page?.id === pageId, 'owner must be able to create a smoke page');

  blockId = crypto.randomUUID();
  const block = await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Initial collaboration smoke text' }] },
    plainText: 'Initial collaboration smoke text',
    position: 1,
  });
  assert(block?.block?.id === blockId, 'owner must be able to create a smoke block');
  console.log('PASS owner can create a page and block for collaboration replay.');

  await expectFunctionStatus(baseUrl, viewer.token, 'collaboration-mutation', {
    action: 'create',
    pageId,
    blockId,
    clientId: 'viewer-unshared',
    kind: 'text',
    beforeText: '',
    afterText: 'blocked',
    revision: 1,
  }, 403);
  console.log('PASS unshared viewer cannot write collaboration operations.');

  const ownerOperationId = crypto.randomUUID();
  const ownerOccurredAt = '2026-01-01T00:00:00.000Z';
  const ownerOperation = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'create',
    id: ownerOperationId,
    pageId,
    blockId,
    clientId: 'owner-client',
    kind: 'text',
    operation: { type: 'replace', from: 0, to: 0, text: 'owner seed' },
    beforeText: '',
    afterText: 'owner seed',
    revision: 100,
    occurredAt: ownerOccurredAt,
  });
  assert(ownerOperation?.operation?.id === ownerOperationId, 'owner operation must be persisted');

  const ownerReplay = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'list',
    pageId,
    afterRevision: 0,
  });
  assert(
    Array.isArray(ownerReplay?.operations) &&
      ownerReplay.operations.some((operation) => operation.id === ownerOperationId),
    'owner must be able to replay persisted collaboration operations',
  );
  console.log('PASS owner can persist and replay collaboration operations.');

  const share = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'user',
    principalId: viewer.userId,
    label: 'Collaboration smoke viewer',
    role: 'comment',
  });
  permissionId = share?.permission?.id;
  assert(permissionId, 'share invite must return a permission id');

  await expectFunctionStatus(baseUrl, viewer.token, 'collaboration-mutation', {
    action: 'list',
    pageId,
    afterRevision: 0,
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'collaboration-mutation', {
    action: 'create',
    pageId,
    blockId,
    clientId: 'viewer-comment',
    kind: 'text',
    beforeText: 'owner seed',
    afterText: 'comment role blocked',
    revision: 101,
  }, 403);
  console.log('PASS comment-level access cannot replay or write collaboration operations.');

  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'updatePermission',
    permissionId,
    role: 'edit',
  });

  const viewerReplay = await callFunction(baseUrl, viewer.token, 'collaboration-mutation', {
    action: 'list',
    pageId,
    afterRevision: 0,
  });
  assert(
    Array.isArray(viewerReplay?.operations) &&
      viewerReplay.operations.some((operation) => operation.id === ownerOperationId),
    'edit access must allow viewer collaboration replay',
  );

  const viewerOperationId = crypto.randomUUID();
  const viewerOccurredAt = '2026-01-01T00:00:01.000Z';
  const viewerOperation = await callFunction(baseUrl, viewer.token, 'collaboration-mutation', {
    action: 'create',
    id: viewerOperationId,
    pageId,
    blockId,
    clientId: 'viewer-client',
    kind: 'text',
    operation: { type: 'replace', from: 10, to: 10, text: ' viewer edit' },
    beforeText: 'owner seed',
    afterText: 'owner seed viewer edit',
    revision: 101,
    occurredAt: viewerOccurredAt,
  });
  assert(viewerOperation?.operation?.id === viewerOperationId, 'viewer operation must be persisted after edit grant');

  await expectFunctionStatus(baseUrl, viewer.token, 'collaboration-mutation', {
    action: 'create',
    pageId,
    blockId,
    clientId: 'viewer-crdt-client',
    kind: 'crdt_update',
    operation: {
      engine: 'yjs',
      documentId: `page:${pageId}`,
      updateBase64: 'not-base64',
    },
    revision: 102,
  }, 400);

  const crdtOperationId = crypto.randomUUID();
  const crdtOccurredAt = '2026-01-01T00:00:02.000Z';
  const validCrdtPayload = await syntheticYjsUpdatePayload(`block:${blockId}`, blockId);
  const crdtOperation = await callFunction(baseUrl, viewer.token, 'collaboration-mutation', {
    action: 'create',
    id: crdtOperationId,
    pageId,
    blockId,
    clientId: 'viewer-crdt-client',
    kind: 'crdt_update',
    operation: validCrdtPayload,
    revision: 102,
    occurredAt: crdtOccurredAt,
  });
  assert(crdtOperation?.operation?.id === crdtOperationId, 'CRDT operation must be persisted with its id');
  assert(crdtOperation.operation.kind === 'crdt_update', 'CRDT operation must keep its operation kind');
  assert(
    crdtOperation?.document?.documentId === `block:${blockId}` &&
      crdtOperation.document.updateCount >= 1 &&
      typeof crdtOperation.document.stateBase64 === 'string',
    'CRDT operation must update a durable merged document state',
  );
  assert(
    crdtOperation.operation.operation?.engine === 'yjs' &&
      crdtOperation.operation.operation.updateBase64 === validCrdtPayload.updateBase64 &&
      crdtOperation.operation.operation.originClientId === 'viewer-crdt-client',
    'CRDT operation payload must be normalized and preserved for replay',
  );
  const decodedCrdtSnapshot = await decodeYjsBlockTextSnapshot(
    crdtOperation.operation.operation.updateBase64,
    blockId,
  );
  assert(
    decodedCrdtSnapshot?.plainText === 'CRDT smoke update',
    'persisted CRDT update must decode back into a block text snapshot',
  );

  // H1 convergence: two collaborators editing the same block from a shared base
  // must MERGE over one base on the server's durable document, not concatenate
  // it. Each payload seeds the identical deterministic base and appends its own
  // suffix as a minimal diff (mirroring the real client encoder).
  const convergenceBlockId = crypto.randomUUID();
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: convergenceBlockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Shared base ' }] },
    plainText: 'Shared base ',
    position: 30,
  });
  const convergenceDocId = `block:${convergenceBlockId}`;
  const aliceOp = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId,
    blockId: convergenceBlockId,
    clientId: 'owner-alice-client',
    kind: 'crdt_update',
    operation: await convergentClientPayload(convergenceDocId, convergenceBlockId, 'Shared base ', 'Shared base Alice'),
    revision: 130,
    occurredAt: '2026-01-01T00:00:03.100Z',
  });
  const bobOp = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId,
    blockId: convergenceBlockId,
    clientId: 'owner-bob-client',
    kind: 'crdt_update',
    operation: await convergentClientPayload(convergenceDocId, convergenceBlockId, 'Shared base ', 'Shared base Bob'),
    revision: 131,
    occurredAt: '2026-01-01T00:00:03.200Z',
  });
  const mergedDurableState = bobOp?.document?.stateBase64;
  assert(typeof mergedDurableState === 'string', 'concurrent CRDT edits must produce a durable merged state');
  const mergedText = (await decodeYjsBlockTextSnapshot(mergedDurableState, convergenceBlockId))?.plainText ?? '';
  assert(
    mergedText.includes('Alice') && mergedText.includes('Bob'),
    `concurrent CRDT edits must both survive on the server (got ${JSON.stringify(mergedText)})`,
  );
  assert(
    !mergedText.includes('Shared base Shared base'),
    `concurrent CRDT edits must converge over one shared base, not concatenate it (got ${JSON.stringify(mergedText)})`,
  );
  assert(
    mergedText.length === 'Shared base '.length + 'Alice'.length + 'Bob'.length,
    `merged CRDT text must be base + both suffixes exactly, never the base twice (got ${JSON.stringify(mergedText)})`,
  );
  void aliceOp;

  const markedCrdtOperationId = crypto.randomUUID();
  const markedCrdtOccurredAt = '2026-01-01T00:00:02.500Z';
  const markedRichText = [
    { text: 'Marked ', bold: true },
    { text: 'link', link: 'https://example.com/collaboration-rich-text' },
    { text: ' note', code: true, color: 'red' },
  ];
  const markedPayload = await syntheticYjsTextInsertPayload(
    `block:${blockId}`,
    blockId,
    markedRichText,
    markedCrdtOccurredAt,
  );
  const markedOperation = await callFunction(baseUrl, viewer.token, 'collaboration-mutation', {
    action: 'create',
    id: markedCrdtOperationId,
    pageId,
    blockId,
    clientId: 'viewer-crdt-rich-client',
    kind: 'crdt_update',
    operation: markedPayload,
    revision: 102.5,
    occurredAt: markedCrdtOccurredAt,
  });
  assert(markedOperation?.operation?.id === markedCrdtOperationId, 'marked CRDT operation must be persisted');
  const decodedMarkedSnapshot = await decodeYjsBlockTextSnapshot(
    markedOperation.operation.operation.updateBase64,
    blockId,
  );
  const decodedMarkedYText = await decodeYjsBlockTextRich(
    markedOperation.operation.operation.updateBase64,
    blockId,
  );
  assert(
    decodedMarkedSnapshot?.plainText === 'Marked link note' &&
      Array.isArray(decodedMarkedSnapshot.rich) &&
      decodedMarkedSnapshot.rich.some((span) => span.text === 'Marked ' && span.bold === true) &&
      decodedMarkedSnapshot.rich.some((span) => span.text === 'link' && span.link === 'https://example.com/collaboration-rich-text') &&
      decodedMarkedSnapshot.rich.some((span) => span.text === ' note' && span.code === true && span.color === 'red'),
    `persisted CRDT update must preserve rich text span metadata, got ${JSON.stringify(decodedMarkedSnapshot)}`,
  );
  assert(
    decodedMarkedYText.some((span) => span.text === 'Marked ' && span.bold === true) &&
      decodedMarkedYText.some((span) => span.text === 'link' && span.link === 'https://example.com/collaboration-rich-text') &&
      decodedMarkedYText.some((span) => span.text === ' note' && span.code === true && span.color === 'red'),
    `persisted CRDT update must encode rich text marks as Y.Text attributes, got ${JSON.stringify(decodedMarkedYText)}`,
  );
  assert(
    markedOperation?.document?.updateCount >= 2 &&
      typeof markedOperation.document.stateBase64 === 'string' &&
      markedOperation.document.lastOperationId === markedCrdtOperationId &&
      markedOperation.document.lastOperationRevision === 102.5 &&
      markedOperation.document.lastOperationOccurredAt === markedCrdtOccurredAt,
    'marked CRDT operation must merge into durable checkpointed document state',
  );
  const decodedMarkedDurableSnapshot = await decodeYjsBlockTextSnapshot(
    markedOperation.document.stateBase64,
    blockId,
  );
  const decodedMarkedDurableYText = await decodeYjsBlockTextRich(
    markedOperation.document.stateBase64,
    blockId,
  );
  assert(
    Array.isArray(decodedMarkedDurableSnapshot?.rich) &&
      decodedMarkedDurableSnapshot.rich.some((span) => span.text === 'link' && span.link === 'https://example.com/collaboration-rich-text'),
    `durable CRDT state must preserve rich text snapshot metadata, got ${JSON.stringify(decodedMarkedDurableSnapshot)}`,
  );
  assert(
    decodedMarkedDurableYText.some((span) => span.text === 'link' && span.link === 'https://example.com/collaboration-rich-text'),
    `durable CRDT state must preserve rich text through Y.Text attributes, got ${JSON.stringify(decodedMarkedDurableYText)}`,
  );

  const cursorReplay = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'list',
    pageId,
    afterRevision: 100,
    afterOccurredAt: ownerOccurredAt,
    afterId: ownerOperationId,
  });
  assert(
    Array.isArray(cursorReplay?.operations) &&
      cursorReplay.operations.some((operation) => operation.id === viewerOperationId) &&
      !cursorReplay.operations.some((operation) => operation.id === ownerOperationId),
    'cursor replay must resume after the exact revision/occurredAt/id tuple',
  );
  const crdtReplay = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'list',
    pageId,
    afterRevision: 101,
    afterOccurredAt: viewerOccurredAt,
    afterId: viewerOperationId,
  });
  assert(
    Array.isArray(crdtReplay?.operations) &&
      crdtReplay.operations.some((operation) =>
          operation.id === crdtOperationId &&
          operation.kind === 'crdt_update' &&
          operation.operation?.engine === 'yjs' &&
          operation.operation?.updateBase64 === validCrdtPayload.updateBase64
      ) &&
      crdtReplay.operations.some((operation) =>
        operation.id === markedCrdtOperationId &&
          operation.kind === 'crdt_update' &&
          operation.operation?.engine === 'yjs' &&
          operation.operation?.updateBase64 === markedPayload.updateBase64
      ),
    'CRDT updates must replay through the same collaboration product API cursor path',
  );
  await assertLongOfflineReplay(baseUrl);

  const concurrentOwnerOperationId = crypto.randomUUID();
  const concurrentViewerOperationId = crypto.randomUUID();
  const concurrentOwnerPayload = await syntheticYjsTextInsertPayload(
    `block:${blockId}`,
    blockId,
    'owner concurrent',
    '2026-01-01T00:00:03.000Z',
  );
  const concurrentViewerPayload = await syntheticYjsTextInsertPayload(
    `block:${blockId}`,
    blockId,
    'viewer concurrent',
    '2026-01-01T00:00:03.000Z',
  );
  await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'create',
    id: concurrentOwnerOperationId,
    pageId,
    blockId,
    clientId: 'owner-crdt-concurrent-client',
    kind: 'crdt_update',
    operation: concurrentOwnerPayload,
    revision: 103,
    occurredAt: '2026-01-01T00:00:03.000Z',
  });
  await callFunction(baseUrl, viewer.token, 'collaboration-mutation', {
    action: 'create',
    id: concurrentViewerOperationId,
    pageId,
    blockId,
    clientId: 'viewer-crdt-concurrent-client',
    kind: 'crdt_update',
    operation: concurrentViewerPayload,
    revision: 103,
    occurredAt: '2026-01-01T00:00:03.000Z',
  });
  const concurrentReplay = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'list',
    pageId,
    afterRevision: 102.5,
    afterOccurredAt: markedCrdtOccurredAt,
    afterId: markedCrdtOperationId,
  });
  const concurrentUpdates = (concurrentReplay?.operations ?? [])
    .filter((operation) =>
      operation.kind === 'crdt_update' &&
      (operation.id === concurrentOwnerOperationId || operation.id === concurrentViewerOperationId)
    )
    .map((operation) => operation.operation?.updateBase64)
    .filter(Boolean);
  assert(concurrentUpdates.length === 2, 'both concurrent CRDT updates must replay');
  const mergedConcurrentText = await decodeMergedYjsBlockText(concurrentUpdates, blockId);
  assert(
    mergedConcurrentText.includes('owner concurrent') &&
      mergedConcurrentText.includes('viewer concurrent'),
    `merged CRDT text must keep both concurrent inserts, got ${JSON.stringify(mergedConcurrentText)}`,
  );

  const parallelLabels = Array.from({ length: 50 }, (_, index) => `parallel crdt ${index}`);
  const parallelPayloads = await Promise.all(
    parallelLabels.map((label, index) =>
      syntheticYjsTextInsertPayload(
        `block:${blockId}`,
        blockId,
        [
          { text: `${label} `, bold: index % 2 === 0 },
          { text: 'link', link: `https://example.com/parallel-${index}` },
        ],
        '2026-01-01T00:00:04.000Z',
      )
    ),
  );
  await Promise.all(
    parallelPayloads.map((payload, index) =>
      callFunction(baseUrl, index % 2 === 0 ? owner.token : viewer.token, 'collaboration-mutation', {
        action: 'create',
        id: crypto.randomUUID(),
        pageId,
        blockId,
        clientId: `parallel-crdt-client-${index}`,
        kind: 'crdt_update',
        operation: payload,
        revision: 104,
        occurredAt: '2026-01-01T00:00:04.000Z',
      })
    ),
  );
  const parallelDocument = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'document',
    pageId,
    blockId,
    repair: true,
  });
  const parallelDurableText = await decodeMergedYjsBlockText([parallelDocument.document.stateBase64], blockId);
  assert(
    parallelLabels.every((label) => parallelDurableText.includes(label)),
    `durable CRDT state must repair from the operation log after parallel writes, got ${JSON.stringify(parallelDurableText)}`,
  );
  const parallelDurableRich = await decodeYjsBlockTextRich(parallelDocument.document.stateBase64, blockId);
  assert(
    parallelDurableRich.some((span) => span.text === 'link' && span.link === 'https://example.com/parallel-0'),
    `parallel durable CRDT state must keep Y.Text rich attributes, got ${JSON.stringify(parallelDurableRich)}`,
  );

  const durableDocument = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'document',
    pageId,
    blockId,
  });
  assert(
    durableDocument?.document?.documentId === `block:${blockId}` &&
      durableDocument.document.updateCount >= 3,
    'collaboration document API must return the durable merged CRDT state for the block',
  );
  const durableMergedText = await decodeMergedYjsBlockText([durableDocument.document.stateBase64], blockId);
  assert(
    durableMergedText.includes('CRDT smoke update') &&
    durableMergedText.includes('Marked link note') &&
    durableMergedText.includes('owner concurrent') &&
      durableMergedText.includes('viewer concurrent') &&
      parallelLabels.every((label) => durableMergedText.includes(label)),
    `durable merged CRDT state must keep replayed and concurrent inserts, got ${JSON.stringify(durableMergedText)}`,
  );
  const durableDocuments = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'documents',
    pageId,
    blockIds: [blockId],
    repair: 'auto',
  });
  assert(
    Array.isArray(durableDocuments?.documents) &&
      durableDocuments.documents.some(
        (document) =>
          document.documentId === `block:${blockId}` &&
          document.stateBase64 === durableDocument.document.stateBase64 &&
          document.lastOperationId === durableDocument.document.lastOperationId &&
          typeof document.checkpointedAt === 'string',
      ),
    'collaboration documents API must return page-scoped checkpoint states for editor resync',
  );

  const structureMergeIds = {
    first: crypto.randomUUID(),
    middle: crypto.randomUUID(),
    last: crypto.randomUUID(),
  };
  const [structureFirst, structureMiddle, structureLast] = await Promise.all([
    callFunction(baseUrl, owner.token, 'block-mutation', {
      action: 'create',
      id: structureMergeIds.first,
      pageId,
      parentId: null,
      type: 'paragraph',
      content: { rich: [{ text: 'Structure merge first' }] },
      plainText: 'Structure merge first',
      position: 20,
    }),
    callFunction(baseUrl, owner.token, 'block-mutation', {
      action: 'create',
      id: structureMergeIds.middle,
      pageId,
      parentId: null,
      type: 'paragraph',
      content: { rich: [{ text: 'Structure merge middle' }] },
      plainText: 'Structure merge middle',
      position: 21,
    }),
    callFunction(baseUrl, owner.token, 'block-mutation', {
      action: 'create',
      id: structureMergeIds.last,
      pageId,
      parentId: null,
      type: 'paragraph',
      content: { rich: [{ text: 'Structure merge last' }] },
      plainText: 'Structure merge last',
      position: 22,
    }),
  ]);
  const beforeFirst = structureFirst.block;
  const beforeMiddle = structureMiddle.block;
  const beforeLast = structureLast.block;
  assert(beforeFirst?.id && beforeMiddle?.id && beforeLast?.id, 'structure merge seed blocks must be created');
  const movedFirst = {
    ...beforeFirst,
    parentId: null,
    position: 23,
    updatedAt: '2026-01-01T00:02:00.000Z',
  };
  const indentedMiddle = {
    ...beforeMiddle,
    parentId: structureMergeIds.first,
    position: 1,
    updatedAt: '2026-01-01T00:02:01.000Z',
  };
  await Promise.all([
    callFunction(baseUrl, owner.token, 'block-mutation', {
      action: 'update',
      id: structureMergeIds.first,
      pageId,
      patch: {
        parentId: movedFirst.parentId,
        position: movedFirst.position,
        updatedAt: movedFirst.updatedAt,
      },
    }),
    callFunction(baseUrl, viewer.token, 'block-mutation', {
      action: 'update',
      id: structureMergeIds.middle,
      pageId,
      patch: {
        parentId: indentedMiddle.parentId,
        position: indentedMiddle.position,
        updatedAt: indentedMiddle.updatedAt,
      },
    }),
  ]);
  await Promise.all([
    callFunction(baseUrl, owner.token, 'collaboration-mutation', {
      action: 'create',
      pageId,
      blockId: structureMergeIds.first,
      clientId: 'owner-structure-client',
      kind: 'block_structure',
      operation: {
        engine: 'block_structure',
        schemaVersion: 1,
        action: 'move',
        blockIds: [structureMergeIds.first],
        before: [beforeFirst],
        after: [movedFirst],
      },
      revision: 108,
      occurredAt: '2026-01-01T00:02:00.000Z',
    }),
    callFunction(baseUrl, viewer.token, 'collaboration-mutation', {
      action: 'create',
      pageId,
      blockId: structureMergeIds.middle,
      clientId: 'viewer-structure-client',
      kind: 'block_structure',
      operation: {
        engine: 'block_structure',
        schemaVersion: 1,
        action: 'indent',
        blockIds: [structureMergeIds.middle],
        before: [beforeMiddle],
        after: [indentedMiddle],
      },
      revision: 108.5,
      occurredAt: '2026-01-01T00:02:01.000Z',
    }),
  ]);
  const structureBlocks = await fetchPageBlocks(baseUrl, owner.token, pageId);
  assertStructureIntegrity(structureBlocks, Object.values(structureMergeIds));
  const persistedFirst = structureBlocks.find((block) => block.id === structureMergeIds.first);
  const persistedMiddle = structureBlocks.find((block) => block.id === structureMergeIds.middle);
  assert(
    persistedFirst?.parentId == null &&
      persistedFirst.position === movedFirst.position &&
      persistedMiddle?.parentId === structureMergeIds.first &&
      persistedMiddle.position === indentedMiddle.position,
    'concurrent structure mutations must preserve both move and indent without duplicate or cycle',
  );
  const structureReplay = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
    action: 'list',
    pageId,
    afterRevision: 107,
  });
  assert(
    Array.isArray(structureReplay?.operations) &&
      structureReplay.operations.some(
        (operation) =>
          operation.kind === 'block_structure' &&
          operation.operation?.action === 'move' &&
          operation.operation?.blockIds?.includes(structureMergeIds.first),
      ) &&
      structureReplay.operations.some(
        (operation) =>
          operation.kind === 'block_structure' &&
          operation.operation?.action === 'indent' &&
          operation.operation?.blockIds?.includes(structureMergeIds.middle),
      ),
    'structure collaboration operations must replay move and indent actions',
  );

  const structureParentId = crypto.randomUUID();
  const structureChildId = crypto.randomUUID();
  const structureParent = await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: structureParentId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Structure parent' }] },
    plainText: 'Structure parent',
    position: 2,
  });
  await callFunction(baseUrl, viewer.token, 'block-mutation', {
    action: 'create',
    id: structureChildId,
    pageId,
    parentId: structureParentId,
    type: 'paragraph',
    content: { rich: [{ text: 'Structure child' }] },
    plainText: 'Structure child',
    position: 1,
  });
  await expectFunctionStatus(baseUrl, viewer.token, 'block-mutation', {
    action: 'update',
    id: structureParentId,
    pageId,
    patch: {
      parentId: structureChildId,
      position: 3,
    },
  }, 400);
  assert(structureParent?.block?.updatedAt, 'structure parent must have an updatedAt value');
  await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'update',
    id: structureParentId,
    pageId,
    patch: {
      plainText: 'Structure parent fresh edit',
      content: { rich: [{ text: 'Structure parent fresh edit' }] },
      updatedAt: '2026-01-01T00:00:05.000Z',
    },
  });
  await expectFunctionStatus(baseUrl, viewer.token, 'block-mutation', {
    action: 'update',
    id: structureParentId,
    pageId,
    expectedUpdatedAt: structureParent.block.updatedAt,
    patch: { position: 4 },
  }, 409);
  await expectFunctionStatus(baseUrl, viewer.token, 'block-mutation', {
    action: 'delete',
    id: structureParentId,
    pageId,
    expectedUpdatedAt: structureParent.block.updatedAt,
  }, 409);
  const structureDelete = await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'delete',
    id: structureParentId,
    pageId,
  });
  assert(
    Array.isArray(structureDelete?.deletedIds) &&
      structureDelete.deletedIds.includes(structureParentId) &&
      structureDelete.deletedIds.includes(structureChildId),
    'fresh structure delete must still remove parent and child blocks',
  );
  console.log('PASS edit access can replay, append, long-offline cursor-page, and CRDT collaboration operations.');

  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'removePermission',
    permissionId,
  });
  permissionId = '';
  await expectFunctionStatus(baseUrl, viewer.token, 'collaboration-mutation', {
    action: 'list',
    pageId,
    afterRevision: 0,
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'collaboration-mutation', {
    action: 'document',
    pageId,
    blockId,
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'collaboration-mutation', {
    action: 'documents',
    pageId,
    blockIds: [blockId],
  }, 403);
  console.log('PASS revoking edit access blocks collaboration replay again.');

  const deleted = await permanentlyDeletePage(baseUrl, owner.token, pageId);
  assert(deleted?.cleanup?.blocks >= 1, 'permanent delete must clean collaboration smoke blocks');
  assert(
    deleted?.cleanup?.collaborationOperations >= 4,
    'permanent delete must clean collaboration operation logs',
  );
  assert(
    deleted?.cleanup?.collaborationDocuments >= 1,
    'permanent delete must clean durable collaboration document state',
  );
  pageId = '';
  blockId = '';
  console.log('PASS permanent page delete cleans collaboration operation logs and durable document state.');

  console.log('\nPASS multi-user collaboration operation and CRDT-update flow works through product APIs.');
}

async function loadYjs() {
  if (!yjsModulePromise) yjsModulePromise = import(requireFromWeb.resolve('yjs'));
  return yjsModulePromise;
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function syntheticYjsUpdatePayload(documentId, blockId) {
  return syntheticYjsTextInsertPayload(
    documentId,
    blockId,
    'CRDT smoke update',
    '2026-01-01T00:00:02.000Z',
  );
}

// Mirror the real client's convergent encoder (web/src/lib/collaborationCrdt.ts):
// a deterministic shared base under clientID 1, then a minimal prefix/suffix
// diff edit under the doc's own clientID. Two of these from the same base model
// two collaborators; the server merges them like any crdt_update, so the result
// exercises the actual convergence path end-to-end.
async function convergentClientPayload(documentId, blockId, baseText, editedText) {
  const Y = await loadYjs();
  const textKey = `block:${blockId}:plainText`;
  const base = new Y.Doc();
  base.clientID = 1;
  base.transact(() => {
    base.getText(textKey).insert(0, baseText);
  });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
  const text = doc.getText(textKey);
  const cur = text.toString();
  let prefix = 0;
  const maxPrefix = Math.min(cur.length, editedText.length);
  while (prefix < maxPrefix && cur[prefix] === editedText[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(cur.length - prefix, editedText.length - prefix);
  while (suffix < maxSuffix && cur[cur.length - 1 - suffix] === editedText[editedText.length - 1 - suffix]) {
    suffix += 1;
  }
  const deleteCount = cur.length - prefix - suffix;
  const insert = editedText.slice(prefix, editedText.length - suffix);
  doc.transact(() => {
    if (deleteCount > 0) text.delete(prefix, deleteCount);
    if (insert) text.insert(prefix, insert);
    doc.getMap('blocks').set(blockId, {
      kind: 'block_text_snapshot',
      schemaVersion: 2,
      rich: [{ text: editedText }],
      plainText: editedText,
      crdtTextKey: textKey,
      updatedAt: '2026-01-01T00:00:03.000Z',
    });
  });
  return {
    engine: 'yjs',
    schemaVersion: 2,
    documentId,
    updateBase64: bytesToBase64(Y.encodeStateAsUpdate(doc)),
    stateVectorBase64: bytesToBase64(Y.encodeStateVector(doc)),
  };
}

async function assertLongOfflineReplay(baseUrl) {
  const total = 125;
  const firstRevision = 1_000;
  const operationIds = [];

  for (let index = 0; index < total; index += 1) {
    const id = crypto.randomUUID();
    const revision = firstRevision + index;
    const occurredAt = new Date(Date.UTC(2026, 0, 1, 0, 10, index)).toISOString();
    const result = await callFunction(baseUrl, owner.token, 'collaboration-mutation', {
      action: 'create',
      id,
      pageId,
      blockId,
      clientId: 'owner-long-offline-replay',
      kind: 'text',
      operation: { type: 'replace', from: index, to: index, text: ` replay-${index}` },
      beforeText: `before ${index}`,
      afterText: `after ${index}`,
      revision,
      occurredAt,
    });
    assert(result?.operation?.id === id, 'long offline replay setup operation must be persisted');
    operationIds.push(id);
  }

  const replayedIds = [];
  let cursor = {
    revision: firstRevision - 1,
    occurredAt: '',
    id: '',
  };

  for (let page = 0; page < 10 && replayedIds.length < total; page += 1) {
    const replay = await callFunction(baseUrl, viewer.token, 'collaboration-mutation', {
      action: 'list',
      pageId,
      afterRevision: cursor.revision,
      afterOccurredAt: cursor.occurredAt,
      afterId: cursor.id,
      limit: 40,
    });
    const operations = Array.isArray(replay?.operations) ? replay.operations : [];
    assert(operations.length > 0, `long offline replay page ${page + 1} must return operations`);
    for (const operation of operations) {
      if (operationIds.includes(operation.id)) replayedIds.push(operation.id);
    }
    const last = operations.at(-1);
    cursor = {
      revision: last?.revision ?? cursor.revision,
      occurredAt: last?.occurredAt ?? cursor.occurredAt,
      id: last?.id ?? cursor.id,
    };
  }

  assert(
    replayedIds.length === operationIds.length &&
      replayedIds.every((id, index) => id === operationIds[index]),
    'long offline replay must recover every queued operation across cursor pages in order',
  );
  console.log('PASS long offline collaboration replay recovers queued operations across cursor pages.');
}

async function syntheticYjsTextInsertPayload(documentId, blockId, richOrText, updatedAt) {
  const Y = await loadYjs();
  const doc = new Y.Doc();
  const textKey = `block:${blockId}:plainText`;
  const rich = Array.isArray(richOrText) ? richOrText : [{ text: String(richOrText) }];
  const textValue = rich.map((span) => typeof span.text === 'string' ? span.text : '').join('');
  doc.transact(() => {
    const text = doc.getText(textKey);
    let index = 0;
    for (const span of rich) {
      if (!span?.text) continue;
      text.insert(index, span.text, spanToYTextAttributes(span));
      index += span.text.length;
    }
    doc.getMap('blocks').set(blockId, {
      kind: 'block_text_snapshot',
      schemaVersion: 2,
      rich,
      plainText: textValue,
      crdtTextKey: textKey,
      updatedAt,
    });
  });
  return {
    engine: 'yjs',
    schemaVersion: 2,
    documentId,
    updateBase64: bytesToBase64(Y.encodeStateAsUpdate(doc)),
    stateVectorBase64: bytesToBase64(Y.encodeStateVector(doc)),
  };
}

function spanToYTextAttributes(span) {
  const attributes = {};
  if (span.bold === true) attributes.bold = true;
  if (span.italic === true) attributes.italic = true;
  if (span.underline === true) attributes.underline = true;
  if (span.strikethrough === true) attributes.strikethrough = true;
  if (span.code === true) attributes.code = true;
  if (typeof span.color === 'string') attributes.color = span.color;
  if (typeof span.link === 'string') attributes.link = span.link;
  if (typeof span.commentId === 'string') attributes.commentId = span.commentId;
  if (span.mention === 'page' || span.mention === 'date' || span.mention === 'person') attributes.mention = span.mention;
  if (typeof span.pageId === 'string') attributes.pageId = span.pageId;
  if (typeof span.date === 'string') attributes.date = span.date;
  if (typeof span.userId === 'string') attributes.userId = span.userId;
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

async function decodeYjsBlockTextSnapshot(updateBase64, blockId) {
  const Y = await loadYjs();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(updateBase64, 'base64'));
  const snapshot = doc.getMap('blocks').get(blockId);
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const textKey = typeof snapshot.crdtTextKey === 'string' ? snapshot.crdtTextKey : `block:${blockId}:plainText`;
  return {
    ...snapshot,
    plainText: doc.getText(textKey).toString() || snapshot.plainText,
  };
}

async function decodeYjsBlockTextRich(updateBase64, blockId) {
  const Y = await loadYjs();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(updateBase64, 'base64'));
  return doc.getText(`block:${blockId}:plainText`).toDelta()
    .filter((delta) => typeof delta.insert === 'string' && delta.insert.length > 0)
    .map((delta) => ({ text: delta.insert, ...(delta.attributes ?? {}) }));
}

async function decodeMergedYjsBlockText(updateBase64Values, blockId) {
  const Y = await loadYjs();
  const doc = new Y.Doc();
  for (const value of updateBase64Values) {
    Y.applyUpdate(doc, Buffer.from(value, 'base64'));
  }
  return doc.getText(`block:${blockId}:plainText`).toString();
}

async function fetchPageBlocks(baseUrl, token, targetPageId) {
  const result = await callFunction(baseUrl, token, 'page-query', {
    action: 'blocks',
    pageId: targetPageId,
  });
  return Array.isArray(result?.blocks) ? result.blocks : [];
}

function assertStructureIntegrity(blocks, blockIds) {
  const ids = new Set(blockIds);
  const matching = blocks.filter((block) => ids.has(block.id));
  assert(
    matching.length === ids.size &&
      new Set(matching.map((block) => block.id)).size === ids.size,
    `structure blocks must exist exactly once, got ${JSON.stringify(matching.map((block) => block.id))}`,
  );
  const byId = new Map(blocks.map((block) => [block.id, block]));
  for (const block of matching) {
    const seen = new Set([block.id]);
    let current = block;
    while (current?.parentId) {
      assert(!seen.has(current.parentId), `structure cycle detected at ${current.parentId}`);
      seen.add(current.parentId);
      current = byId.get(current.parentId);
      if (!current) break;
    }
  }
}

async function cleanup() {
  if (!owner?.token) return;
  const baseUrl = normalizeBaseUrl(options.url);

  if (permissionId) {
    await callFunction(baseUrl, owner.token, 'share-mutation', {
      action: 'removePermission',
      permissionId,
    }).catch(() => {});
    permissionId = '';
  }

  if (pageId) {
    await permanentlyDeletePage(baseUrl, owner.token, pageId).catch(() => {});
    pageId = '';
    blockId = '';
  }
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
  console.log(`Usage: node scripts/collaboration-smoke.mjs [options]

Checks multi-user collaboration operation permissions, long offline replay
cursors, CRDT update payload validation/replay, and operation cleanup against a running
Hanji EdgeBase runtime.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or http://127.0.0.1:8787.
  --timeout-ms <number>   Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
`);
}
