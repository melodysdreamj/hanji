import type { StoreApi } from "zustand";
import type {
  Block,
  Comment,
} from "./types";
import {
  buttonResultRequiresConfirmation,
  type ExecutePageButtonResult,
} from "./edgebase";
import type {
  AppState,
  BlockStoreRuntime,
  BlockHistory,
  BlockHistoryEntry,
  BlockStructureHistoryOperation,
} from "./store";
import {
  applyDefinitiveReadDenial,
  applyLatestRead,
  beginReadApplication,
  invalidateReadApplication,
  readApplicationIsLatest,
  readApplicationKey,
} from "./readApplicationGuard";
import { contentForNewBlock } from "./blockDefaults";
import { prepareButtonPageResultAdoption } from "./buttonResultAdoption";

type BlockStoreActions = Pick<
  AppState,
  | "loadBlocks"
  | "topLevelBlocks"
  | "childBlocks"
  | "addBlockLocal"
  | "createBlock"
  | "persistBlockCreateBatch"
  | "updateBlock"
  | "applyRemoteBlockText"
  | "deleteBlock"
  | "moveBlockToPage"
  | "copyBlockToPage"
  | "captureBlockStructureHistory"
  | "captureBlockHistory"
  | "undoBlockChange"
  | "redoBlockChange"
  | "runPageButton"
  | "discardPageButtonExecution"
>;

const deferredBlockCreateIds = new Set<string>();
const BLOCK_LOCATION_CACHE_LIMIT = 4_096;

function debugBlockReadBlocks(blocks: Block[]) {
  return blocks.slice(0, 500).map((block) => ({
    id: block.id,
    lastMutationId: block.lastMutationId ?? null,
    plainText: block.plainText?.slice(0, 500) ?? null,
    updatedAt: block.updatedAt ?? null,
  }));
}

function debugBlockReadOutbox(entries: unknown[]) {
  return entries.slice(0, 100).map((entry) => {
    const value = entry && typeof entry === "object"
      ? (entry as { value?: Record<string, unknown> }).value
      : undefined;
    const operation = value?.operation && typeof value.operation === "object"
      ? value.operation as Record<string, unknown>
      : undefined;
    return {
      id: value?.id ?? operation?.id ?? null,
      kind: value?.kind ?? null,
      operationKind: operation?.kind ?? null,
    };
  });
}

function recordBlockReadDebug(entry: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem("hanji.debugPresence") !== "1") return;
    const debugWindow = window as Window & {
      __hanjiBlockReadDebug?: Array<Record<string, unknown>>;
    };
    const entries = debugWindow.__hanjiBlockReadDebug ?? [];
    entries.push({ at: new Date().toISOString(), ...entry });
    debugWindow.__hanjiBlockReadDebug = entries.slice(-40);
  } catch {
    // Debug-only observation must never affect block loading.
  }
}

export function resetDeferredBlockCreates() {
  deferredBlockCreateIds.clear();
}

export function clearDeferredBlockCreatesForPage(pageId: string, blocks: Block[]) {
  for (const block of blocks) {
    if (block.pageId === pageId) deferredBlockCreateIds.delete(block.id);
  }
}

export function createBlockStoreActions(
  set: StoreApi<AppState>["setState"],
  get: StoreApi<AppState>["getState"],
  runtime: BlockStoreRuntime
): BlockStoreActions {
  const {
    EMPTY_BLOCK_LIST,
    HISTORY_LIMIT,
    MERGE_WINDOW_MS,
    blockStructureInvalidation,
    blockLoadPromises,
    blockStructureSources,
    blocksCacheFresh,
    byCreated,
    bySortPos,
    applyEmbeddedDatabaseSnapshots,
    cacheCurrentComments,
    cacheReplaceTable,
    cacheSetMeta,
    canEditPageInState,
    cancelPendingBlock,
    childBlocksCache,
    cloneBlocks,
    consumeLinkedTwin,
    durableRemoteCall,
    ensureAuth,
    executePageButtonRemote,
    firstDroppedDurableCall,
    flushBlock,
    getPageBlocksRemote,
    getPageCommentsRemote,
    historyOperationTarget,
    hydrateBlocksFromCache,
    inferStructureAction,
    isStructureOnlyPatch,
    isTemplateEditorPageId,
    mirrorPendingBlock,
    newId,
    nowIso,
    optimisticBlockOverlays,
    outboxAllEntries,
    outboxUserId,
    overlayOutboxOnBlocks,
    pendingBlock,
    pendingBlockBase,
    pendingBlockCreate,
    pendingBlockExpectedMutationId,
    pendingBlockMutationId,
    pendingBlockPage,
    inFlightBlockMutationId,
    pendingPageLikeCreateHas,
    permanentDeleteIds,
    persistErrorStatus,
    persistBlockCreate,
    persistBlockDelete,
    persistBlockSnapshot,
    persistBlockStructureOperation,
    positionBetween,
    publishBlockStructureMutation,
    publishDatabaseRowsMutation,
    publishCommentsMutation,
    reconcilePersistedBlockMutation,
    recordCacheMeta,
    recordCacheTables,
    remapBlockContent,
    remoteBlockWithOptimisticOverlay,
    remotePageWithOptimisticOverlay,
    removeBlocksFromPages,
    serializeBlockHistory,
    scheduleBlockBatch,
    snapshotsEqual,
    spansToPlainText,
    stampBlocksCached,
    storeMessages,
    structureBlockSnapshot,
    topLevelBlocksCache,
    touchPageForBlockChange,
    upsertBlocksIntoPages,
  } = runtime;

  type BlockLocation = { index: number; pageId: string };
  const recentBlockLocations = new Map<string, BlockLocation>();
  const pageButtonExecutionPromises = new Map<string, Promise<ExecutePageButtonResult | undefined>>();
  const pageButtonRetryIds = new Map<string, string>();
  const PAGE_BUTTON_RETRY_LIMIT = 256;

  function rememberBlockLocation(id: string, location: BlockLocation) {
    recentBlockLocations.delete(id);
    recentBlockLocations.set(id, location);
    if (recentBlockLocations.size <= BLOCK_LOCATION_CACHE_LIMIT) return;
    const oldestId = recentBlockLocations.keys().next().value;
    if (typeof oldestId === "string") recentBlockLocations.delete(oldestId);
  }

  function resolveBlockLocation(id: string, preferredPageId?: string): BlockLocation | undefined {
    const blocksByPage = get().blocksByPage;
    const cached = recentBlockLocations.get(id);
    if (cached && blocksByPage[cached.pageId]?.[cached.index]?.id === id) {
      rememberBlockLocation(id, cached);
      return cached;
    }
    recentBlockLocations.delete(id);

    if (preferredPageId) {
      const preferredIndex = (blocksByPage[preferredPageId] ?? []).findIndex(
        (block) => block.id === id,
      );
      if (preferredIndex >= 0) {
        const location = { index: preferredIndex, pageId: preferredPageId };
        rememberBlockLocation(id, location);
        return location;
      }
    }

    for (const [pageId, blocks] of Object.entries(blocksByPage)) {
      if (pageId === preferredPageId) continue;
      const index = blocks.findIndex((block) => block.id === id);
      if (index < 0) continue;
      const location = { index, pageId };
      rememberBlockLocation(id, location);
      return location;
    }
    return undefined;
  }

  function structuralSource(blocks: Block[]) {
    return blockStructureSources.get(blocks) ?? blocks;
  }

  function replaceProjectedBlock(
    blocks: Block[],
    previousBlock: Block,
    nextBlock: Block,
  ): Block[] | undefined {
    const index = blocks.findIndex((block) => block.id === previousBlock.id);
    if (index < 0) return undefined;
    const next = blocks.slice();
    next[index] = nextBlock;
    return next;
  }

  function advanceContentOnlyProjections(
    pageId: string,
    previousSource: Block[],
    nextSource: Block[],
    previousBlock: Block,
    nextBlock: Block,
  ) {
    const source = structuralSource(previousSource);
    blockStructureSources.set(nextSource, source);

    if (previousBlock.parentId == null) {
      const cached = topLevelBlocksCache.get(pageId);
      if (cached?.source === source) {
        const result = replaceProjectedBlock(cached.result, previousBlock, nextBlock);
        if (result) topLevelBlocksCache.set(pageId, { source, result });
        else topLevelBlocksCache.delete(pageId);
      }
      return;
    }

    const key = `${pageId}:${previousBlock.parentId}`;
    const cached = childBlocksCache.get(key);
    if (cached?.source !== source) return;
    const result = replaceProjectedBlock(cached.result, previousBlock, nextBlock);
    if (result) childBlocksCache.set(key, { source, result });
    else childBlocksCache.delete(key);
  }

  return {
// ── blocks ──────────────────────────────────────────────────────────
  async loadBlocks(pageId, opts) {
    const loadUserId = outboxUserId();
    if (loadUserId && permanentDeleteIds(loadUserId).has(pageId)) return;
    if (pendingPageLikeCreateHas(pageId)) return;
    const force = opts?.force === true;
    if (!force && get().loadedBlockPages.has(pageId)) return;
    // Dedup is keyed by force-ness (like loadDatabase): a forced reload
    // (conflict recovery) must hit the network even when a plain load is in
    // flight, instead of being satisfied by its possibly-stale response.
    const promiseKey = `${pageId}:${force ? "force" : "cached"}`;
    const existing = blockLoadPromises.get(promiseKey);
    if (existing) return existing;
    const promise = (async () => {
      // SWR: render cached blocks (with queued outbox edits overlaid) right
      // away, then refresh from the server and reconcile. A forced reload
      // (conflict recovery) skips both the cache render and the fresh-skip.
      const hydrated = force ? false : await hydrateBlocksFromCache(pageId);
      if (hydrated && (await blocksCacheFresh(pageId))) return;
      // A cache-only load has no remote response to order and must not retire
      // an already-started forced reconciliation generation. Acquire the
      // application token only when this lane will actually issue a read.
      const readToken = beginReadApplication(readApplicationKey.blocks(pageId));
      try {
        const result = await getPageBlocksRemote(pageId);
        recordBlockReadDebug({
          event: "response",
          force,
          pageId,
          remote: debugBlockReadBlocks(result.blocks),
          state: debugBlockReadBlocks(get().blocksByPage[pageId] ?? []),
        });
        const applicationTurnAccepted = await applyLatestRead(readToken, async () => {
          if (
            loadUserId && permanentDeleteIds(loadUserId).has(pageId)
          ) return;
          const entries = loadUserId ? await outboxAllEntries(loadUserId) : [];
          if (
            loadUserId && permanentDeleteIds(loadUserId).has(pageId)
          ) return;
          // Projection intentionally waits until after the async outbox read.
          // A local write can be accepted during that await; its application
          // barrier makes this token stale, so never apply or cache the older
          // server snapshot and never let it clear a newer optimistic overlay.
          if (!readApplicationIsLatest(readToken)) {
            recordBlockReadDebug({
              event: "stale_after_outbox",
              force,
              outbox: debugBlockReadOutbox(entries),
              pageId,
              remote: debugBlockReadBlocks(result.blocks),
              state: debugBlockReadBlocks(get().blocksByPage[pageId] ?? []),
            });
            return;
          }
          const blocks = result.blocks
            .map(remoteBlockWithOptimisticOverlay)
            .sort(bySortPos);
          const projectedBlocks = overlayOutboxOnBlocks(entries, pageId, blocks);
          const currentDeferredBlocks = (get().blocksByPage[pageId] ?? []).filter(
            (block) => deferredBlockCreateIds.has(block.id),
          );
          set((s) => {
            const fetchedIds = new Set(projectedBlocks.map((block) => block.id));
            const currentBlocks = overlayOutboxOnBlocks(
              entries,
              pageId,
              s.blocksByPage[pageId] ?? []
            );
            const optimisticBlocks = currentBlocks.filter(
              (block) =>
                !fetchedIds.has(block.id) &&
                (pendingBlockCreate.has(block.id) ||
                  pendingBlock.has(block.id) ||
                  optimisticBlockOverlays.has(block.id) ||
                  (projectedBlocks.length === 0 && deferredBlockCreateIds.has(block.id)))
            );
            // Overlay still-pending debounced edits so a patch typed between the
            // cache render and this refresh isn't visually reverted.
            const withPending = projectedBlocks.map((block) => {
              const pending = pendingBlock.get(block.id);
              return pending && Object.keys(pending).length ? { ...block, ...pending } : block;
            });
            return {
              blocksByPage: {
                ...s.blocksByPage,
                [pageId]: [...withPending, ...optimisticBlocks].sort(bySortPos),
              },
              loadedBlockPages: new Set(s.loadedBlockPages).add(pageId),
            };
          });
          recordBlockReadDebug({
            event: "applied",
            force,
            outbox: debugBlockReadOutbox(entries),
            pageId,
            remote: debugBlockReadBlocks(result.blocks),
            state: debugBlockReadBlocks(get().blocksByPage[pageId] ?? []),
          });
          if (projectedBlocks.length > 0) {
            clearDeferredBlockCreatesForPage(pageId, currentDeferredBlocks);
          }
          await Promise.all([
            applyEmbeddedDatabaseSnapshots(result.embeddedDatabases ?? [], readToken),
            cacheReplaceTable(
              outboxUserId(),
              recordCacheTables.blocks(pageId),
              blocks.map((block) => ({ id: block.id, value: block }))
            ),
            stampBlocksCached(outboxUserId(), pageId),
            cacheSetMeta(
              outboxUserId(),
              recordCacheMeta.blocksStamp(pageId),
              get().pagesById[pageId]?.updatedAt ?? ""
            ),
          ]);
        });
        if (!applicationTurnAccepted) {
          recordBlockReadDebug({
            event: "application_turn_rejected",
            force,
            pageId,
            remote: debugBlockReadBlocks(result.blocks),
            state: debugBlockReadBlocks(get().blocksByPage[pageId] ?? []),
          });
        }
      } catch (error) {
        const status = persistErrorStatus(error);
        if (status === 401 || status === 403 || status === 404) {
          await applyDefinitiveReadDenial(readToken, async () => {
            const cacheUserId = outboxUserId();
            await Promise.all([
              cacheReplaceTable(cacheUserId, recordCacheTables.blocks(pageId), []),
              cacheSetMeta(cacheUserId, recordCacheMeta.blocksStamp(pageId), ""),
            ]);
            clearDeferredBlockCreatesForPage(pageId, get().blocksByPage[pageId] ?? []);
            set((state) => {
              const blocksByPage = { ...state.blocksByPage };
              delete blocksByPage[pageId];
              const loadedBlockPages = new Set(state.loadedBlockPages);
              loadedBlockPages.delete(pageId);
              return { blocksByPage, loadedBlockPages };
            });
          });
          throw error;
        }
        // Offline with a cached render: the cache stands and queued edits
        // keep retrying; without a cache the caller sees the failure.
        if (!hydrated) throw error;
      }
    })().finally(() => {
      blockLoadPromises.delete(promiseKey);
    });
    blockLoadPromises.set(promiseKey, promise);
    return promise;
  },

  async runPageButton(pageId, blockId, confirmationToken) {
    const key = `${pageId}\u001f${blockId}`;
    const active = pageButtonExecutionPromises.get(key);
    if (active) return active;

    const run = (async () => {
      if (!get().userId) await ensureAuth();
      const beforeFlush = get().pagesById[pageId];
      const sourceBeforeFlush = (get().blocksByPage[pageId] ?? []).find((block) => block.id === blockId);
      if (!beforeFlush || !sourceBeforeFlush || sourceBeforeFlush.type !== "button") return undefined;
      if (!canEditPageInState(get(), beforeFlush)) {
        get().notify(storeMessages().editAccessDeniedSave, "default");
        return undefined;
      }
      if (beforeFlush.isLocked) {
        get().notify(storeMessages().pageLockedSave, "default");
        return undefined;
      }
      await flushBlock(blockId);
      const page = get().pagesById[pageId];
      const source = (get().blocksByPage[pageId] ?? []).find((block) => block.id === blockId);
      if (!page || !source || source.type !== "button") return undefined;

      let executionId = pageButtonRetryIds.get(key);
      if (!executionId) {
        executionId = newId();
        pageButtonRetryIds.set(key, executionId);
        while (pageButtonRetryIds.size > PAGE_BUTTON_RETRY_LIMIT) {
          const oldest = pageButtonRetryIds.keys().next().value as string | undefined;
          if (!oldest) break;
          pageButtonRetryIds.delete(oldest);
        }
      }
      try {
        const result = await executePageButtonRemote({
          workspaceId: page.workspaceId,
          pageId,
          blockId,
          executionId,
          ...(confirmationToken ? { confirmationToken } : {}),
        });
        if (buttonResultRequiresConfirmation(result)) return result;
        pageButtonRetryIds.delete(key);
        const pageAdoption = prepareButtonPageResultAdoption(
          result,
          remotePageWithOptimisticOverlay,
        );
        set((state) => {
          return {
            blocksByPage: upsertBlocksIntoPages(state.blocksByPage, result.insertedBlocks),
            ...pageAdoption.apply(state),
          };
        });
        if (result.insertedBlocks.length > 0) {
          publishBlockStructureMutation(
            pageId,
            "page-button-execute",
            result.insertedBlocks.map((block) => block.id),
          );
        }
        for (const mutation of pageAdoption.mutations) {
          publishDatabaseRowsMutation(
            mutation.databaseId,
            mutation.reason,
            mutation.rowIds,
          );
        }
        return {
          ...result,
          createdPages: pageAdoption.createdPages,
          updatedPages: pageAdoption.updatedPages,
        };
      } catch (error) {
        const status = persistErrorStatus(error);
        if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
          pageButtonRetryIds.delete(key);
        }
        throw error;
      }
    })();
    pageButtonExecutionPromises.set(key, run);
    try {
      return await run;
    } finally {
      if (pageButtonExecutionPromises.get(key) === run) {
        pageButtonExecutionPromises.delete(key);
      }
    }
  },

  discardPageButtonExecution(pageId, blockId) {
    pageButtonRetryIds.delete(`${pageId}\u001f${blockId}`);
  },

  topLevelBlocks(pageId) {
    // Content-only writes retain structural source identity and advance only
    // the affected projection. Membership/order changes use a fresh identity.
    const source = get().blocksByPage[pageId] ?? EMPTY_BLOCK_LIST;
    const projectionSource = structuralSource(source);
    const cached = topLevelBlocksCache.get(pageId);
    if (cached && cached.source === projectionSource) return cached.result;
    const result = source.filter((b) => b.parentId == null).sort(bySortPos);
    topLevelBlocksCache.set(pageId, { source: projectionSource, result });
    return result;
  },

  childBlocks(pageId, parentId) {
    const source = get().blocksByPage[pageId] ?? EMPTY_BLOCK_LIST;
    const projectionSource = structuralSource(source);
    const key = `${pageId}:${parentId}`;
    const cached = childBlocksCache.get(key);
    if (cached && cached.source === projectionSource) return cached.result;
    const result = source.filter((b) => b.parentId === parentId).sort(bySortPos);
    childBlocksCache.set(key, { source: projectionSource, result });
    return result;
  },

  addBlockLocal(opts) {
    const id = newId();
    const type = opts.type ?? "paragraph";
    const content = contentForNewBlock(type, opts.content);
    const now = nowIso();
    const block: Block = {
      id,
      createdAt: now,
      updatedAt: now,
      pageId: opts.pageId,
      parentId: opts.parentId ?? null,
      type,
      content,
      plainText: opts.plainText ?? spansToPlainText(content.rich),
      position: opts.position,
      createdBy: get().userId,
      lastEditedBy: get().userId,
    };
    if (opts.history !== false) {
      get().captureBlockStructureHistory(opts.pageId, {
        action: "create",
        blockIds: [block.id],
        before: [],
        after: [structureBlockSnapshot(block)],
      });
    }
    invalidateReadApplication(
      readApplicationKey.blocks(opts.pageId),
      `block_add_local:${id}`,
    );
    set((s) => ({
      blocksByPage: {
        ...s.blocksByPage,
        [opts.pageId]: [...(s.blocksByPage[opts.pageId] ?? []), block].sort(
          bySortPos
        ),
      },
    }));
    if (!isTemplateEditorPageId(opts.pageId)) {
      if (opts.deferPersistUntilMutation === true) {
        deferredBlockCreateIds.add(block.id);
      } else {
        touchPageForBlockChange(get().updatePage, opts.pageId);
        if (opts.persist !== false) persistBlockCreate(block);
      }
    }
    return block;
  },

  async createBlock(opts) {
    if (get().pagesById[opts.pageId]?.isLocked) {
      throw new Error("Page is locked.");
    }
    return get().addBlockLocal(opts);
  },

  async persistBlockCreateBatch(blocks) {
    if (blocks.length === 0) return;
    const persistable = blocks.filter((block) => !isTemplateEditorPageId(block.pageId));
    if (persistable.length === 0) return;
    for (const block of persistable) deferredBlockCreateIds.delete(block.id);
    const ids = new Set(persistable.map((block) => block.id));
    const pageIds = Array.from(new Set(persistable.map((block) => block.pageId)));
    const invalidation = blockStructureInvalidation(pageIds, ids);
    // `durableRemoteCall` mirrors the full batch (including generated ids and
    // parent ids) before attempting the network call. A transient failure can
    // therefore replay the same graph after a crash/reload without losing a
    // child or racing it ahead of its parent.
    const call = await durableRemoteCall(
      "createBlocksRemote",
      [persistable],
      undefined,
      invalidation,
      undefined,
      () => {
        for (const id of ids) cancelPendingBlock(id);
        set((s) => {
          const blocksByPage = { ...s.blocksByPage };
          for (const pageId of pageIds) {
            blocksByPage[pageId] = (blocksByPage[pageId] ?? []).filter(
              (block) => !ids.has(block.id)
            );
          }
          return { blocksByPage };
        });
      }
    );
    if (call.status === "ok") {
      const persisted = Array.isArray(call.result) ? call.result as Block[] : persistable;
      await Promise.all(
        persisted.map((block) => reconcilePersistedBlockMutation(block.id, block, block.pageId))
      );
    }
  },

  updateBlock(id, patch, opts) {
    const current = get().blocksByPage;
    const location = resolveBlockLocation(id, opts?.pageId);
    if (!location) return;
    const { pageId } = location;
    const currentBlock = current[pageId]?.[location.index];
    if (!currentBlock || currentBlock.id !== id) return;
    if (get().pagesById[pageId]?.isLocked) return;
    if (opts?.history !== false) {
      if (isStructureOnlyPatch(patch)) {
        const nextBlock = structureBlockSnapshot({
          ...currentBlock,
          ...patch,
          parentId: "parentId" in patch ? patch.parentId ?? null : currentBlock.parentId ?? null,
          updatedAt: "updatedAt" in patch ? patch.updatedAt : nowIso(),
        });
        get().captureBlockStructureHistory(pageId, {
          action: inferStructureAction([structureBlockSnapshot(currentBlock)], [nextBlock]),
          blockIds: [id],
          before: [structureBlockSnapshot(currentBlock)],
          after: [nextBlock],
        }, opts?.history ?? "push");
      } else {
        get().captureBlockHistory(pageId, opts?.history ?? "push");
      }
    }
    const nextPatch: Partial<Block> = { ...patch };
    if (!("updatedAt" in nextPatch)) nextPatch.updatedAt = nowIso();
    if (!("lastEditedBy" in nextPatch)) nextPatch.lastEditedBy = get().userId;
    invalidateReadApplication(
      readApplicationKey.blocks(pageId),
      `block_update_local:${id}`,
    );
    set((s) => {
      const source = s.blocksByPage[pageId] ?? [];
      const resolvedIndex = source[location.index]?.id === id
        ? location.index
        : source.findIndex((block) => block.id === id);
      if (resolvedIndex < 0) {
        recentBlockLocations.delete(id);
        return {};
      }
      const next = { ...s.blocksByPage };
      const previousBlock = source[resolvedIndex];
      const updatedBlock = { ...previousBlock, ...nextPatch };
      const arr = source.slice();
      arr[resolvedIndex] = updatedBlock;
      const structureChanged =
        previousBlock.id !== updatedBlock.id ||
        previousBlock.pageId !== updatedBlock.pageId ||
        (previousBlock.parentId ?? null) !== (updatedBlock.parentId ?? null) ||
        previousBlock.position !== updatedBlock.position;
      if (previousBlock.position !== updatedBlock.position) arr.sort(bySortPos);
      if (!structureChanged) {
        advanceContentOnlyProjections(pageId, source, arr, previousBlock, updatedBlock);
      }
      next[pageId] = arr;
      if (updatedBlock.id !== id) recentBlockLocations.delete(id);
      const updatedIndex = previousBlock.position === updatedBlock.position
        ? resolvedIndex
        : arr.findIndex((block) => block.id === updatedBlock.id);
      if (updatedIndex >= 0) {
        rememberBlockLocation(updatedBlock.id, { index: updatedIndex, pageId });
      }
      return { blocksByPage: next };
    });
    if (isTemplateEditorPageId(pageId)) return;
    if (deferredBlockCreateIds.delete(id)) {
      const materialized = get().blocksByPage[pageId]?.find((block) => block.id === id);
      if (materialized) persistBlockCreate(materialized, { touchPage: true });
      return;
    }
    if (!pendingBlock.has(id)) {
      // First patch of this burst: remember the last server-known stamp so an
      // offline replay can detect that another device changed the block since.
      const inFlightMutationId = inFlightBlockMutationId.get(id);
      if (inFlightMutationId) {
        // Keep the pre-flight server stamp as an alternate base. On refresh,
        // the server accepts the newer snapshot whether the in-flight write
        // never landed (timestamp still matches) or landed without its ack
        // (the prior mutation receipt matches).
        pendingBlockExpectedMutationId.set(id, inFlightMutationId);
        if (!pendingBlockBase.has(id)) {
          const base = currentBlock?.updatedAt;
          if (base) pendingBlockBase.set(id, base);
        }
      } else {
        const base = currentBlock?.updatedAt;
        if (base) pendingBlockBase.set(id, base);
        else pendingBlockBase.delete(id);
        const baseMutationId = currentBlock?.lastMutationId;
        if (baseMutationId) pendingBlockExpectedMutationId.set(id, baseMutationId);
        else pendingBlockExpectedMutationId.delete(id);
      }
      pendingBlockMutationId.set(id, newId());
    }
    pendingBlock.set(id, { ...(pendingBlock.get(id) ?? {}), ...nextPatch });
    optimisticBlockOverlays.set(id, {
      ...(optimisticBlockOverlays.get(id) ?? {}),
      ...nextPatch,
    });
    if (pageId) pendingBlockPage.set(id, pageId);
    mirrorPendingBlock(id);
    // Text snapshots already carry their own updatedAt and are the canonical
    // durable write. A separate debounced page touch doubles the slow-NAS
    // request load for every typing burst without preserving any extra input.
    if (!opts?.debounce) touchPageForBlockChange(get().updatePage, pageId, opts);
    if (opts?.debounce) {
      const debounceMs = typeof opts.debounceMs === "number" && Number.isFinite(opts.debounceMs)
        ? Math.max(0, opts.debounceMs)
        : undefined;
      scheduleBlockBatch(pageId, debounceMs);
    } else {
      void flushBlock(id);
    }
  },

  applyRemoteBlockText(id, patch) {
    const location = resolveBlockLocation(id);
    if (!location) return;
    const { pageId } = location;
    if (get().pagesById[pageId]?.isLocked) return;

    // Collaboration timestamps order room/document snapshots; they are not a
    // revision of the canonical block row. Keeping one on Block.updatedAt
    // makes the next ordinary outbox generation send a base the server has
    // never stored and falsely reject the same user's edit with 409.
    const textPatch: Pick<Partial<Block>, "content" | "plainText"> = {};
    if (patch.content !== undefined) textPatch.content = patch.content;
    if (patch.plainText !== undefined) textPatch.plainText = patch.plainText;

    // A safe CRDT merge received while this tab already owns a canonical
    // generation updates that same bounded generation. It must not cancel the
    // durable outbox entry, change its captured server base, or mint a second
    // mutation receipt.
    const pending = pendingBlock.get(id);
    if (pending) {
      pendingBlock.set(id, { ...pending, ...textPatch });
      optimisticBlockOverlays.set(id, {
        ...(optimisticBlockOverlays.get(id) ?? {}),
        ...textPatch,
      });
      mirrorPendingBlock(id);
    }

    set((s) => {
      const list = s.blocksByPage[pageId] ?? [];
      const idx = list[location.index]?.id === id
        ? location.index
        : list.findIndex((block) => block.id === id);
      if (idx < 0) return {};
      const arr = list.slice();
      const previousBlock = arr[idx];
      const nextBlock = { ...previousBlock, ...textPatch, ...(pendingBlock.get(id) ?? {}) };
      arr[idx] = nextBlock;
      const structureChanged =
        previousBlock.id !== nextBlock.id ||
        previousBlock.pageId !== nextBlock.pageId ||
        (previousBlock.parentId ?? null) !== (nextBlock.parentId ?? null) ||
        previousBlock.position !== nextBlock.position;
      if (previousBlock.position !== nextBlock.position) arr.sort(bySortPos);
      if (!structureChanged) {
        advanceContentOnlyProjections(pageId, list, arr, previousBlock, nextBlock);
      }
      const nextIndex = previousBlock.position === nextBlock.position
        ? idx
        : arr.findIndex((block) => block.id === nextBlock.id);
      if (nextIndex >= 0) rememberBlockLocation(nextBlock.id, { index: nextIndex, pageId });
      return {
        blocksByPage: {
          ...s.blocksByPage,
          [pageId]: arr,
        },
      };
    });
  },

  async deleteBlock(id, opts) {
    let pageId = "";
    const blocks = get().blocksByPage;
    const toRemove = new Set<string>();
    for (const [pid, list] of Object.entries(blocks)) {
      if (!list.some((b) => b.id === id)) continue;
      pageId = pid;
      const collect = (blockId: string) => {
        toRemove.add(blockId);
        for (const child of list) {
          if (child.parentId === blockId) collect(child.id);
        }
      };
      collect(id);
      break;
    }
    if (pageId && get().pagesById[pageId]?.isLocked) return;
    if (pageId && opts?.history !== false) {
      const removedBlocks = (blocks[pageId] ?? [])
        .filter((block) => toRemove.has(block.id))
        .map(structureBlockSnapshot);
      get().captureBlockStructureHistory(pageId, {
        action: "delete",
        blockIds: Array.from(toRemove),
        before: removedBlocks,
        after: [],
      }, opts?.history ?? "push");
    }
    for (const blockId of toRemove) cancelPendingBlock(blockId);
    const durableIds = Array.from(toRemove).filter(
      (blockId) => !deferredBlockCreateIds.delete(blockId),
    );
    if (pageId) {
      invalidateReadApplication(
        readApplicationKey.blocks(pageId),
        `block_delete_local:${Array.from(toRemove).sort().join(",")}`,
      );
      set((s) => ({
        blocksByPage: {
          ...s.blocksByPage,
          [pageId]: (s.blocksByPage[pageId] ?? []).filter((b) => !toRemove.has(b.id)),
        },
      }));
      if (!isTemplateEditorPageId(pageId) && durableIds.length > 0) {
        touchPageForBlockChange(get().updatePage, pageId);
      }
    }
    if (pageId && !isTemplateEditorPageId(pageId) && durableIds.length > 0) {
      await persistBlockDelete(durableIds, pageId);
    }
  },

  async moveBlockToPage(id, targetPageId) {
    const targetPage = get().pagesById[targetPageId];
    if (!targetPage || targetPage.kind !== "page") return;

    let sourcePageId = "";
    for (const [pid, list] of Object.entries(get().blocksByPage)) {
      if (list.some((block) => block.id === id)) {
        sourcePageId = pid;
        break;
      }
    }
    if (!sourcePageId || sourcePageId === targetPageId) return;
    if (get().pagesById[sourcePageId]?.isLocked || targetPage.isLocked) return;

    await get().loadBlocks(targetPageId);
    const sourceBlocks = get().blocksByPage[sourcePageId] ?? [];
    const targetBlocks = get().blocksByPage[targetPageId] ?? [];
    const root = sourceBlocks.find((block) => block.id === id);
    if (!root) return;

    const movingIds = new Set<string>();
    const collect = (blockId: string) => {
      movingIds.add(blockId);
      for (const child of sourceBlocks) {
        if (child.parentId === blockId) collect(child.id);
      }
    };
    collect(id);
    const movedBlocks = sourceBlocks.filter((block) => movingIds.has(block.id));
    if (movedBlocks.length === 0) return;

    await Promise.all(Array.from(movingIds, (blockId) => flushBlock(blockId)));

    const lastTargetTop = targetBlocks
      .filter((block) => block.parentId == null)
      .sort(bySortPos)
      .at(-1);
    const rootPosition = positionBetween(lastTargetTop?.position, undefined);
    const updatedBlocks = movedBlocks.map((block) => ({
      ...block,
      pageId: targetPageId,
      parentId: block.id === id ? null : block.parentId,
      position: block.id === id ? rootPosition : block.position,
    }));

    // ONE logical undo unit: twin operation entries (shared link id) go onto
    // BOTH pages' stacks. Undo/redo from either page replays the shared move
    // operation (a structural update on both pages — never a delete or a
    // re-create) and consumes the twin, so per-page snapshot undo can no
    // longer split-brain the move.
    const moveOperation: BlockStructureHistoryOperation = {
      action: "move",
      pageId: sourcePageId,
      blockIds: Array.from(movingIds),
      before: movedBlocks.map(structureBlockSnapshot),
      after: updatedBlocks.map(structureBlockSnapshot),
      occurredAt: nowIso(),
    };
    const linkId = newId();
    const linkedAt = Date.now();
    const sourceHistoryBefore = get().blockHistoryByPage[sourcePageId];
    const targetHistoryBefore = get().blockHistoryByPage[targetPageId];
    set((s) => {
      const entryFor = (pageId: string, otherPageId: string): BlockHistoryEntry => ({
        actorId: get().userId,
        blocks: cloneBlocks(s.blocksByPage[pageId] ?? []),
        operations: [moveOperation],
        at: linkedAt,
        mode: "push",
        link: { id: linkId, pageId: otherPageId },
      });
      const pushEntry = (pageId: string, entry: BlockHistoryEntry): BlockHistory => {
        const existing = s.blockHistoryByPage[pageId] ?? { past: [], future: [] };
        return { past: existing.past.concat(entry).slice(-HISTORY_LIMIT), future: [] };
      };
      return {
        blockHistoryByPage: {
          ...s.blockHistoryByPage,
          [sourcePageId]: pushEntry(sourcePageId, entryFor(sourcePageId, targetPageId)),
          [targetPageId]: pushEntry(targetPageId, entryFor(targetPageId, sourcePageId)),
        },
      };
    });

    const optimisticSourceBlocks = sourceBlocks.filter(
      (block) => !movingIds.has(block.id)
    );
    const optimisticTargetBlocks = [
      ...targetBlocks.filter((block) => !movingIds.has(block.id)),
      ...updatedBlocks,
    ].sort(bySortPos);

    // Apply the move locally BEFORE any network round-trip so an offline move
    // still lands (and the history entries above never dangle unapplied).
    set((s) => ({
      blocksByPage: {
        ...s.blocksByPage,
        [sourcePageId]: optimisticSourceBlocks,
        [targetPageId]: optimisticTargetBlocks,
      },
      loadedBlockPages: new Set(s.loadedBlockPages).add(targetPageId),
    }));
    touchPageForBlockChange(get().updatePage, sourcePageId);
    touchPageForBlockChange(get().updatePage, targetPageId);
    const sourceHistoryAfter = get().blockHistoryByPage[sourcePageId];
    const targetHistoryAfter = get().blockHistoryByPage[targetPageId];

    const movedRoot = updatedBlocks.find((block) => block.id === id)!;
    const blocksPersist = await durableRemoteCall(
      "updateBlockRemote",
      [
        movedRoot.id,
        {
          pageId: movedRoot.pageId,
          parentId: movedRoot.parentId,
          position: movedRoot.position,
        } as Partial<Block>,
        targetPageId,
      ],
      undefined,
      blockStructureInvalidation([sourcePageId, targetPageId], movingIds),
      undefined,
      () => {
        set((s) => {
          const blockHistoryByPage = { ...s.blockHistoryByPage };
          if (s.blockHistoryByPage[sourcePageId] === sourceHistoryAfter) {
            if (sourceHistoryBefore) blockHistoryByPage[sourcePageId] = sourceHistoryBefore;
            else delete blockHistoryByPage[sourcePageId];
          }
          if (s.blockHistoryByPage[targetPageId] === targetHistoryAfter) {
            if (targetHistoryBefore) blockHistoryByPage[targetPageId] = targetHistoryBefore;
            else delete blockHistoryByPage[targetPageId];
          }
          return {
            blocksByPage: {
              ...s.blocksByPage,
              ...(snapshotsEqual(s.blocksByPage[sourcePageId] ?? [], optimisticSourceBlocks)
                ? { [sourcePageId]: sourceBlocks }
                : {}),
              ...(snapshotsEqual(s.blocksByPage[targetPageId] ?? [], optimisticTargetBlocks)
                ? { [targetPageId]: targetBlocks }
                : {}),
            },
            blockHistoryByPage,
          };
        });
      }
    );
    if (blocksPersist.status === "dropped") {
      throw blocksPersist.error;
    }
    // Comment migration is best-effort AFTER the move: a failed fetch (e.g.
    // offline) skips it with a toast instead of blocking the move or leaving
    // a stray history entry for a move that never applied.
    let movedComments: Comment[] = [];
    try {
      movedComments = (await getPageCommentsRemote(sourcePageId)).comments
        .filter((comment) => comment.blockId && movingIds.has(comment.blockId))
        .map((comment) => ({ ...comment, pageId: targetPageId }));
    } catch {
      get().notify(storeMessages().blockMoveCommentsSkipped, "error");
      return;
    }
    const sourceCommentsBefore = get().commentsByPage[sourcePageId];
    const targetCommentsBefore = get().commentsByPage[targetPageId];
    set((s) => {
      const commentsByPage = { ...s.commentsByPage };
      if (commentsByPage[sourcePageId]) {
        commentsByPage[sourcePageId] = commentsByPage[sourcePageId].filter(
          (comment) => !comment.blockId || !movingIds.has(comment.blockId)
        );
      }
      if (commentsByPage[targetPageId] && movedComments.length > 0) {
        commentsByPage[targetPageId] = [...commentsByPage[targetPageId], ...movedComments].sort(
          byCreated
        );
      }
      return { commentsByPage };
    });
    const sourceCommentsAfter = get().commentsByPage[sourcePageId];
    const targetCommentsAfter = get().commentsByPage[targetPageId];
    void Promise.all([
      cacheCurrentComments(sourcePageId),
      cacheCurrentComments(targetPageId),
    ]);

    // No comments on the moved blocks means no secondary write. When there is
    // one, a terminal drop is a partial operation: reconcile both comment
    // lists and reject so callers do not announce an unqualified success.
    if (movedComments.length > 0) {
      const commentsCall = await durableRemoteCall("updateCommentsRemote", [
        movedComments.map((comment) => ({
          id: comment.id,
          patch: { pageId: targetPageId } as Partial<Comment>,
        })),
        targetPageId,
      ], undefined, undefined, {
        commentPageIds: [sourcePageId, targetPageId],
      }, async () => {
        set((s) => {
          const commentsByPage = { ...s.commentsByPage };
          if (s.commentsByPage[sourcePageId] === sourceCommentsAfter) {
            if (sourceCommentsBefore) commentsByPage[sourcePageId] = sourceCommentsBefore;
            else delete commentsByPage[sourcePageId];
          }
          if (s.commentsByPage[targetPageId] === targetCommentsAfter) {
            if (targetCommentsBefore) commentsByPage[targetPageId] = targetCommentsBefore;
            else delete commentsByPage[targetPageId];
          }
          return { commentsByPage };
        });
        await Promise.all([
          cacheCurrentComments(sourcePageId),
          cacheCurrentComments(targetPageId),
        ]);
      });
      if (commentsCall.status === "dropped") {
        throw commentsCall.error;
      }
      if (commentsCall.status === "ok") {
        publishCommentsMutation(sourcePageId);
        publishCommentsMutation(targetPageId);
      }
    }
  },

  async copyBlockToPage(id, targetPageId) {
    const targetPage = get().pagesById[targetPageId];
    if (!targetPage || targetPage.kind !== "page" || targetPage.isLocked) return undefined;

    let sourcePageId = "";
    for (const [pid, list] of Object.entries(get().blocksByPage)) {
      if (list.some((block) => block.id === id)) {
        sourcePageId = pid;
        break;
      }
    }
    if (!sourcePageId) return undefined;

    await get().loadBlocks(targetPageId);
    const sourceBlocks = get().blocksByPage[sourcePageId] ?? [];
    const targetBlocks = get().blocksByPage[targetPageId] ?? [];
    const root = sourceBlocks.find((block) => block.id === id);
    if (!root) return undefined;

    const copyIds = new Set<string>();
    const collect = (blockId: string) => {
      copyIds.add(blockId);
      for (const child of sourceBlocks) {
        if (child.parentId === blockId) collect(child.id);
      }
    };
    collect(id);
    const copiedSourceBlocks = sourceBlocks.filter((block) => copyIds.has(block.id));
    if (copiedSourceBlocks.length === 0) return undefined;

    const now = nowIso();
    const actorId = get().userId;
    const blockIdMap = new Map(copiedSourceBlocks.map((block) => [block.id, newId()]));
    const lastTargetTop = targetBlocks
      .filter((block) => block.parentId == null)
      .sort(bySortPos)
      .at(-1);
    const rootPosition = positionBetween(lastTargetTop?.position, undefined);
    const newBlocks: Block[] = copiedSourceBlocks.map((block) => ({
      id: blockIdMap.get(block.id) as string,
      createdAt: now,
      updatedAt: now,
      pageId: targetPageId,
      parentId: block.id === id ? null : blockIdMap.get(block.parentId ?? "") ?? null,
      type: block.type,
      content: remapBlockContent(block.content, undefined, blockIdMap),
      plainText: block.plainText,
      position: block.id === id ? rootPosition : block.position,
      createdBy: actorId || undefined,
    }));

	    const historyBefore = get().blockHistoryByPage[targetPageId];
	    get().captureBlockHistory(targetPageId);
	    set((s) => ({
	      blocksByPage: {
	        ...s.blocksByPage,
	        [targetPageId]: [...(s.blocksByPage[targetPageId] ?? []), ...newBlocks].sort(bySortPos),
	      },
	      loadedBlockPages: new Set(s.loadedBlockPages).add(targetPageId),
	    }));
	    touchPageForBlockChange(get().updatePage, targetPageId);

	    const copiedIds = new Set(newBlocks.map((block) => block.id));
	    const historyAfter = get().blockHistoryByPage[targetPageId];
	    const call = await durableRemoteCall(
        "createBlocksRemote",
        [newBlocks],
        undefined,
        blockStructureInvalidation([targetPageId], copiedIds),
        undefined,
        () => {
          set((s) => {
            const blockHistoryByPage = { ...s.blockHistoryByPage };
            if (s.blockHistoryByPage[targetPageId] === historyAfter) {
              if (historyBefore) blockHistoryByPage[targetPageId] = historyBefore;
              else delete blockHistoryByPage[targetPageId];
            }
            return {
              blocksByPage: {
                ...s.blocksByPage,
                [targetPageId]: (s.blocksByPage[targetPageId] ?? []).filter(
                  (block) => !copiedIds.has(block.id)
                ),
              },
              blockHistoryByPage,
            };
          });
        }
      );
    if (call.status === "dropped") {
      return undefined;
    }
    return newBlocks.find((block) => block.parentId == null);
  },

  captureBlockStructureHistory(pageId, operation, mode = "push") {
    const before = operation.before.map(structureBlockSnapshot);
    const after = operation.after.map(structureBlockSnapshot);
    if (before.length === 0 && after.length === 0) return;
    const occurredAt = operation.occurredAt ?? nowIso();
    const entryOperation: BlockStructureHistoryOperation = {
      action: operation.action,
      pageId: operation.pageId ?? pageId,
      blockIds: Array.from(new Set(operation.blockIds.length ? operation.blockIds : [
        ...before.map((block) => block.id),
        ...after.map((block) => block.id),
      ])),
      before,
      after,
      occurredAt,
    };
    const existing = get().blockHistoryByPage[pageId] ?? { past: [], future: [] };
    const last = existing.past[existing.past.length - 1];
    const now = Date.now();
    const snapshot = cloneBlocks(get().blocksByPage[pageId] ?? []);
    const canMerge =
      mode === "merge" &&
      last?.mode === "merge" &&
      last.operations?.length === 1 &&
      now - last.at < MERGE_WINDOW_MS &&
      last.operations[0].action === entryOperation.action &&
      JSON.stringify(last.operations[0].blockIds) === JSON.stringify(entryOperation.blockIds);
    const past = canMerge
      ? existing.past.slice(0, -1).concat({
          ...last,
          operations: [{
            ...entryOperation,
            before: last.operations?.[0]?.before ?? entryOperation.before,
          }],
          at: now,
          actorId: get().userId,
        })
      : existing.past
          .concat({ actorId: get().userId, blocks: snapshot, operations: [entryOperation], at: now, mode })
          .slice(-HISTORY_LIMIT);
    set((s) => ({
      blockHistoryByPage: {
        ...s.blockHistoryByPage,
        [pageId]: { past, future: [] },
      },
    }));
  },

  captureBlockHistory(pageId, mode = "push") {
    const existing = get().blockHistoryByPage[pageId] ?? { past: [], future: [] };
    const last = existing.past[existing.past.length - 1];
    const now = Date.now();

    if (mode === "merge" && last?.mode === "merge" && now - last.at < MERGE_WINDOW_MS) {
      const past = existing.past.slice(0, -1).concat({ ...last, actorId: get().userId, at: now });
      set((s) => ({
        blockHistoryByPage: {
          ...s.blockHistoryByPage,
          [pageId]: { past, future: [] },
        },
      }));
      return;
    }

    // A compatible text burst already owns the complete pre-burst snapshot in
    // `last`; later characters only extend that generation's time boundary.
    // Materialize the page only when a new undo generation can actually start.
    const snapshot = cloneBlocks(get().blocksByPage[pageId] ?? []);
    if (last && snapshotsEqual(last.blocks, snapshot)) return;

    const past = existing.past
      .concat({ actorId: get().userId, blocks: snapshot, at: now, mode })
      .slice(-HISTORY_LIMIT);
    set((s) => ({
      blockHistoryByPage: {
        ...s.blockHistoryByPage,
        [pageId]: { past, future: [] },
      },
    }));
  },

  async undoBlockChange(pageId) {
    // Serialized per page: a re-entrant Cmd+Z during the awaited persist
    // below would read the same stacks and collapse two undos into one.
    // Queueing (not ignoring) preserves user intent — N keystrokes, N undos.
    return serializeBlockHistory(pageId, async () => {
      if (get().pagesById[pageId]?.isLocked) return false;
      const history = get().blockHistoryByPage[pageId];
      const entry = history?.past.at(-1);
      if (!entry) return false;
      if (entry.operations?.length) {
        for (const operation of [...entry.operations].reverse()) {
          const target = historyOperationTarget(operation, "undo");
          const removeIds = new Set(target.remove.map((block) => block.id));
          const operationPageIds = new Set([
            operation.pageId,
            ...operation.before.map((block) => block.pageId),
            ...operation.after.map((block) => block.pageId),
          ]);
          const blocksBefore = new Map(
            Array.from(operationPageIds, (affectedPageId) => [
              affectedPageId,
              cloneBlocks(get().blocksByPage[affectedPageId] ?? []),
            ])
          );
          for (const blockId of removeIds) cancelPendingBlock(blockId);
          for (const block of target.upsert) cancelPendingBlock(block.id);
          set((s) => {
            const removed = removeBlocksFromPages(s.blocksByPage, removeIds);
            return {
              blocksByPage: upsertBlocksIntoPages(removed, target.upsert, {
                structuralOnly: target.structuralOnly,
              }),
            };
          });
          const blocksAfter = new Map(
            Array.from(operationPageIds, (affectedPageId) => [
              affectedPageId,
              cloneBlocks(get().blocksByPage[affectedPageId] ?? []),
            ])
          );
          if (!isTemplateEditorPageId(operation.pageId)) {
            touchPageForBlockChange(get().updatePage, operation.pageId);
            const calls = await persistBlockStructureOperation(operation, "undo", () => {
              set((s) => {
                const blocksByPage = { ...s.blocksByPage };
                for (const [affectedPageId, blocks] of blocksBefore) {
                  if (
                    snapshotsEqual(
                      s.blocksByPage[affectedPageId] ?? [],
                      blocksAfter.get(affectedPageId) ?? []
                    )
                  ) {
                    blocksByPage[affectedPageId] = blocks;
                  }
                }
                return { blocksByPage };
              });
            });
            if (firstDroppedDurableCall(calls)) {
              return false;
            }
          }
        }
        set((s) => ({
          blockHistoryByPage: consumeLinkedTwin(
            {
              ...s.blockHistoryByPage,
              [pageId]: {
                past: history.past.slice(0, -1),
                future: history.future.concat(entry).slice(-HISTORY_LIMIT),
              },
            },
            entry.link,
            "undo"
          ),
        }));
        if (entry.link) {
          // A linked (cross-page move) undo changed both pages; the loop
          // above only touched the operation's own pageId.
          for (const touchId of [pageId, entry.link.pageId]) {
            if (!isTemplateEditorPageId(touchId)) touchPageForBlockChange(get().updatePage, touchId);
          }
        }
        return true;
      }
      if (!entry.blocks) return false;
      const current = cloneBlocks(get().blocksByPage[pageId] ?? []);
      const restored = cloneBlocks(entry.blocks);
      set((s) => ({
        blocksByPage: { ...s.blocksByPage, [pageId]: restored },
        blockHistoryByPage: {
          ...s.blockHistoryByPage,
          [pageId]: {
            past: history.past.slice(0, -1),
            future: history.future
              .concat({ actorId: get().userId, blocks: current, at: Date.now(), mode: "push" })
              .slice(-HISTORY_LIMIT),
          },
        },
      }));
      if (!isTemplateEditorPageId(pageId)) {
        touchPageForBlockChange(get().updatePage, pageId);
        const historyAfter = get().blockHistoryByPage[pageId];
        const calls = await persistBlockSnapshot(pageId, current, restored, () => {
          set((s) => ({
            blocksByPage: {
              ...s.blocksByPage,
              ...(snapshotsEqual(s.blocksByPage[pageId] ?? [], restored)
                ? { [pageId]: current }
                : {}),
            },
            blockHistoryByPage: s.blockHistoryByPage[pageId] === historyAfter
              ? { ...s.blockHistoryByPage, [pageId]: history }
              : s.blockHistoryByPage,
          }));
        });
        if (firstDroppedDurableCall(calls)) {
          return false;
        }
      }
      return true;
    });
  },

  async redoBlockChange(pageId) {
    // Same serialization as undoBlockChange (shared per-page gate, so undo
    // and redo cannot interleave against the same stacks either).
    return serializeBlockHistory(pageId, async () => {
      if (get().pagesById[pageId]?.isLocked) return false;
      const history = get().blockHistoryByPage[pageId];
      const entry = history?.future.at(-1);
      if (!entry) return false;
      if (entry.operations?.length) {
        for (const operation of entry.operations) {
          const target = historyOperationTarget(operation, "redo");
          const removeIds = new Set(target.remove.map((block) => block.id));
          const operationPageIds = new Set([
            operation.pageId,
            ...operation.before.map((block) => block.pageId),
            ...operation.after.map((block) => block.pageId),
          ]);
          const blocksBefore = new Map(
            Array.from(operationPageIds, (affectedPageId) => [
              affectedPageId,
              cloneBlocks(get().blocksByPage[affectedPageId] ?? []),
            ])
          );
          for (const blockId of removeIds) cancelPendingBlock(blockId);
          for (const block of target.upsert) cancelPendingBlock(block.id);
          set((s) => {
            const removed = removeBlocksFromPages(s.blocksByPage, removeIds);
            return {
              blocksByPage: upsertBlocksIntoPages(removed, target.upsert, {
                structuralOnly: target.structuralOnly,
              }),
            };
          });
          const blocksAfter = new Map(
            Array.from(operationPageIds, (affectedPageId) => [
              affectedPageId,
              cloneBlocks(get().blocksByPage[affectedPageId] ?? []),
            ])
          );
          if (!isTemplateEditorPageId(operation.pageId)) {
            touchPageForBlockChange(get().updatePage, operation.pageId);
            const calls = await persistBlockStructureOperation(operation, "redo", () => {
              set((s) => {
                const blocksByPage = { ...s.blocksByPage };
                for (const [affectedPageId, blocks] of blocksBefore) {
                  if (
                    snapshotsEqual(
                      s.blocksByPage[affectedPageId] ?? [],
                      blocksAfter.get(affectedPageId) ?? []
                    )
                  ) {
                    blocksByPage[affectedPageId] = blocks;
                  }
                }
                return { blocksByPage };
              });
            });
            if (firstDroppedDurableCall(calls)) {
              return false;
            }
          }
        }
        set((s) => ({
          blockHistoryByPage: consumeLinkedTwin(
            {
              ...s.blockHistoryByPage,
              [pageId]: {
                past: history.past.concat(entry).slice(-HISTORY_LIMIT),
                future: history.future.slice(0, -1),
              },
            },
            entry.link,
            "redo"
          ),
        }));
        if (entry.link) {
          // See undoBlockChange: a linked redo changed both pages.
          for (const touchId of [pageId, entry.link.pageId]) {
            if (!isTemplateEditorPageId(touchId)) touchPageForBlockChange(get().updatePage, touchId);
          }
        }
        return true;
      }
      if (!entry.blocks) return false;
      const current = cloneBlocks(get().blocksByPage[pageId] ?? []);
      const restored = cloneBlocks(entry.blocks);
      set((s) => ({
        blocksByPage: { ...s.blocksByPage, [pageId]: restored },
        blockHistoryByPage: {
          ...s.blockHistoryByPage,
          [pageId]: {
            past: history.past
              .concat({ actorId: get().userId, blocks: current, at: Date.now(), mode: "push" })
              .slice(-HISTORY_LIMIT),
            future: history.future.slice(0, -1),
          },
        },
      }));
      if (!isTemplateEditorPageId(pageId)) {
        touchPageForBlockChange(get().updatePage, pageId);
        const historyAfter = get().blockHistoryByPage[pageId];
        const calls = await persistBlockSnapshot(pageId, current, restored, () => {
          set((s) => ({
            blocksByPage: {
              ...s.blocksByPage,
              ...(snapshotsEqual(s.blocksByPage[pageId] ?? [], restored)
                ? { [pageId]: current }
                : {}),
            },
            blockHistoryByPage: s.blockHistoryByPage[pageId] === historyAfter
              ? { ...s.blockHistoryByPage, [pageId]: history }
              : s.blockHistoryByPage,
          }));
        });
        if (firstDroppedDurableCall(calls)) {
          return false;
        }
      }
      return true;
    });
  },
  };
}
