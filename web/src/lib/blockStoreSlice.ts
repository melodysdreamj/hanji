import type { StoreApi } from "zustand";
import type {
  Block,
  CollaborationBlockStructureBlock,
  Comment,
} from "./types";
import type {
  AppState,
  BlockStoreRuntime,
  BlockHistory,
  BlockHistoryEntry,
  BlockStructureHistoryOperation,
} from "./store";

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
  | "applyRemoteBlockStructure"
  | "deleteBlock"
  | "moveBlockToPage"
  | "copyBlockToPage"
  | "captureBlockStructureHistory"
  | "captureBlockHistory"
  | "undoBlockChange"
  | "redoBlockChange"
>;

export function createBlockStoreActions(
  set: StoreApi<AppState>["setState"],
  get: StoreApi<AppState>["getState"],
  runtime: BlockStoreRuntime
): BlockStoreActions {
  const {
    EMPTY_BLOCK_LIST,
    HISTORY_LIMIT,
    MERGE_WINDOW_MS,
    blockLoadPromises,
    blockTimers,
    blocksCacheFresh,
    byCreated,
    bySortPos,
    cacheReplaceTable,
    cacheSetMeta,
    cancelPendingBlock,
    childBlocksCache,
    cloneBlocks,
    consumeLinkedTwin,
    durableRemoteCall,
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
    pendingBlockPage,
    pendingPageLikeCreateHas,
    permanentDeleteIds,
    persistBlockCreate,
    persistBlockDelete,
    persistBlockSnapshot,
    persistBlockStructureOperation,
    positionBetween,
    publishCommentsMutation,
    reconcilePersistedBlockMutation,
    recordBlockStructureOperation,
    recordCacheMeta,
    recordCacheTables,
    reloadBlocksFromServer,
    remapBlockContent,
    remoteBlockWithOptimisticOverlay,
    removeBlocksFromPages,
    serializeBlockHistory,
    snapshotsEqual,
    spansToPlainText,
    stampBlocksCached,
    storeMessages,
    structureBlockSnapshot,
    topLevelBlocksCache,
    touchPageForBlockChange,
    upsertBlocksIntoPages,
  } = runtime;

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
      try {
        const blocks = (await getPageBlocksRemote(pageId)).blocks
          .map(remoteBlockWithOptimisticOverlay)
          .sort(bySortPos);
        if (
          loadUserId && permanentDeleteIds(loadUserId).has(pageId)
        ) return;
        const entries = loadUserId ? await outboxAllEntries(loadUserId) : [];
        const projectedBlocks = overlayOutboxOnBlocks(entries, pageId, blocks);
        set((s) => {
          const fetchedIds = new Set(projectedBlocks.map((block) => block.id));
          const currentBlocks = overlayOutboxOnBlocks(
            entries,
            pageId,
            s.blocksByPage[pageId] ?? []
          );
          const optimisticBlocks = currentBlocks.filter(
            (block) => !fetchedIds.has(block.id)
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
        cacheReplaceTable(
          outboxUserId(),
          recordCacheTables.blocks(pageId),
          blocks.map((block) => ({ id: block.id, value: block }))
        );
        stampBlocksCached(outboxUserId(), pageId);
        cacheSetMeta(
          outboxUserId(),
          recordCacheMeta.blocksStamp(pageId),
          get().pagesById[pageId]?.updatedAt ?? ""
        );
      } catch (error) {
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

  topLevelBlocks(pageId) {
    // Memoized on the page's block-array identity: repeated calls between
    // store writes return the SAME array, so useShallow subscribers don't
    // re-render the whole editor for unrelated store changes.
    const source = get().blocksByPage[pageId] ?? EMPTY_BLOCK_LIST;
    const cached = topLevelBlocksCache.get(pageId);
    if (cached && cached.source === source) return cached.result;
    const result = source.filter((b) => b.parentId == null).sort(bySortPos);
    topLevelBlocksCache.set(pageId, { source, result });
    return result;
  },

  childBlocks(pageId, parentId) {
    const source = get().blocksByPage[pageId] ?? EMPTY_BLOCK_LIST;
    const key = `${pageId}:${parentId}`;
    const cached = childBlocksCache.get(key);
    if (cached && cached.source === source) return cached.result;
    const result = source.filter((b) => b.parentId === parentId).sort(bySortPos);
    childBlocksCache.set(key, { source, result });
    return result;
  },

  addBlockLocal(opts) {
    const id = newId();
    const content = opts.content ?? { rich: [] };
    const now = nowIso();
    const block: Block = {
      id,
      createdAt: now,
      updatedAt: now,
      pageId: opts.pageId,
      parentId: opts.parentId ?? null,
      type: opts.type ?? "paragraph",
      content,
      plainText: opts.plainText ?? spansToPlainText(content.rich),
      position: opts.position,
      createdBy: get().userId,
    };
    if (opts.history !== false) {
      get().captureBlockStructureHistory(opts.pageId, {
        action: "create",
        blockIds: [block.id],
        before: [],
        after: [structureBlockSnapshot(block)],
      });
    }
    set((s) => ({
      blocksByPage: {
        ...s.blocksByPage,
        [opts.pageId]: [...(s.blocksByPage[opts.pageId] ?? []), block].sort(
          bySortPos
        ),
      },
    }));
    if (!isTemplateEditorPageId(opts.pageId)) {
      touchPageForBlockChange(get().updatePage, opts.pageId);
      if (opts.persist !== false) persistBlockCreate(block);
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
    // `durableRemoteCall` mirrors the full batch (including generated ids and
    // parent ids) before attempting the network call. A transient failure can
    // therefore replay the same graph after a crash/reload without losing a
    // child or racing it ahead of its parent.
    const call = await durableRemoteCall("createBlocksRemote", [persistable]);
    if (call.status === "ok") {
      const persisted = Array.isArray(call.result) ? call.result as Block[] : persistable;
      await Promise.all(
        persisted.map((block) => reconcilePersistedBlockMutation(block.id, block, block.pageId))
      );
    }
    if (call.status === "dropped") {
      const ids = new Set(persistable.map((block) => block.id));
      const pageIds = Array.from(new Set(persistable.map((block) => block.pageId)));
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
      await Promise.all(
        pageIds.map((pageId) => reloadBlocksFromServer(pageId).catch(() => {}))
      );
    }
  },

  updateBlock(id, patch, opts) {
    let pageId = "";
    const current = get().blocksByPage;
    for (const pid of Object.keys(current)) {
      if (current[pid].some((b) => b.id === id)) {
        pageId = pid;
        break;
      }
    }
    if (!pageId) return;
    if (get().pagesById[pageId]?.isLocked) return;
    if (opts?.history !== false) {
      const currentBlock = current[pageId]?.find((b) => b.id === id);
      if (currentBlock && isStructureOnlyPatch(patch)) {
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
    set((s) => {
      const next = { ...s.blocksByPage };
      const idx = next[pageId].findIndex((b) => b.id === id);
      const arr = next[pageId].slice();
      arr[idx] = { ...arr[idx], ...nextPatch };
      next[pageId] = arr.sort(bySortPos);
      return { blocksByPage: next };
    });
    if (isTemplateEditorPageId(pageId)) return;
    if (!pendingBlock.has(id)) {
      // First patch of this burst: remember the last server-known stamp so an
      // offline replay can detect that another device changed the block since.
      const base = current[pageId]?.find((b) => b.id === id)?.updatedAt;
      if (base) pendingBlockBase.set(id, base);
      else pendingBlockBase.delete(id);
    }
    pendingBlock.set(id, { ...(pendingBlock.get(id) ?? {}), ...nextPatch });
    optimisticBlockOverlays.set(id, {
      ...(optimisticBlockOverlays.get(id) ?? {}),
      ...nextPatch,
    });
    if (pageId) pendingBlockPage.set(id, pageId);
    mirrorPendingBlock(id);
    touchPageForBlockChange(get().updatePage, pageId, opts);
    if (opts?.debounce) {
      const t = blockTimers.get(id);
      if (t) clearTimeout(t);
      blockTimers.set(id, setTimeout(() => void flushBlock(id), 400));
    } else {
      void flushBlock(id);
    }
  },

  applyRemoteBlockText(id, patch) {
    let pageId = "";
    const current = get().blocksByPage;
    for (const pid of Object.keys(current)) {
      if (current[pid].some((b) => b.id === id)) {
        pageId = pid;
        break;
      }
    }
    if (!pageId) return;
    if (get().pagesById[pageId]?.isLocked) return;
    cancelPendingBlock(id);

    set((s) => {
      const list = s.blocksByPage[pageId] ?? [];
      const idx = list.findIndex((b) => b.id === id);
      if (idx < 0) return {};
      const arr = list.slice();
      arr[idx] = { ...arr[idx], ...patch };
      return {
        blocksByPage: {
          ...s.blocksByPage,
          [pageId]: arr.sort(bySortPos),
        },
      };
    });
  },

  // Forward-apply a collaborator's structure operation (indent/move/create/
  // delete/restore) from the op log. Same target semantics as a local redo of
  // the operation; never captures local history and never persists — the
  // origin client already did.
  applyRemoteBlockStructure(pageId, operation) {
    if (get().pagesById[pageId]?.isLocked) return;
    const loaded = get().blocksByPage[pageId];
    // Blocks not loaded yet: loadBlocks will fetch server truth including this
    // change, so applying a partial snapshot here would only fight it.
    if (!loaded) return;

    const toBlock = (payload: CollaborationBlockStructureBlock): Block =>
      structureBlockSnapshot({
        id: payload.id,
        pageId: payload.pageId,
        parentId: payload.parentId ?? null,
        type: (payload.type ?? "paragraph") as Block["type"],
        content: (payload.content ?? {}) as Block["content"],
        plainText: payload.plainText ?? "",
        position: payload.position,
        createdBy: payload.createdBy,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
      } as Block);

    const target = historyOperationTarget(
      {
        action: operation.action,
        pageId,
        blockIds: operation.blockIds,
        before: (operation.before ?? []).map(toBlock),
        after: (operation.after ?? []).map(toBlock),
        occurredAt: "",
      },
      "redo"
    );

    const byId = new Map(loaded.map((block) => [block.id, block]));
    const removeIds = new Set(
      target.remove.filter((block) => block.pageId === pageId).map((block) => block.id)
    );
    const upsert = target.upsert.filter((block) => {
      // Op-log records are scoped to this page; ignore anything else.
      if (block.pageId !== pageId) return false;
      const current = byId.get(block.id);
      // A structural patch (move/indent) for a block we don't have would
      // resurrect it from a stale snapshot — skip; create/restore may insert.
      if (target.structuralOnly && !current) return false;
      // Don't let an older remote snapshot undo a newer local change.
      const localAt = Date.parse(current?.updatedAt ?? "");
      const remoteAt = Date.parse(block.updatedAt ?? "");
      if (Number.isFinite(localAt) && Number.isFinite(remoteAt) && remoteAt < localAt) {
        return false;
      }
      return true;
    });
    if (removeIds.size === 0 && upsert.length === 0) return;

    for (const id of removeIds) cancelPendingBlock(id);
    set((s) => {
      const removed = removeBlocksFromPages(s.blocksByPage, removeIds);
      return {
        blocksByPage: upsertBlocksIntoPages(removed, upsert, {
          structuralOnly: target.structuralOnly,
        }),
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
    if (pageId) {
      set((s) => ({
        blocksByPage: {
          ...s.blocksByPage,
          [pageId]: (s.blocksByPage[pageId] ?? []).filter((b) => !toRemove.has(b.id)),
        },
      }));
      if (!isTemplateEditorPageId(pageId)) touchPageForBlockChange(get().updatePage, pageId);
    }
    if (pageId && !isTemplateEditorPageId(pageId)) {
      await persistBlockDelete(Array.from(toRemove), pageId);
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

    // Apply the move locally BEFORE any network round-trip so an offline move
    // still lands (and the history entries above never dangle unapplied).
    set((s) => ({
      blocksByPage: {
        ...s.blocksByPage,
        [sourcePageId]: (s.blocksByPage[sourcePageId] ?? []).filter(
          (block) => !movingIds.has(block.id)
        ),
        [targetPageId]: [
          ...(s.blocksByPage[targetPageId] ?? []).filter((block) => !movingIds.has(block.id)),
          ...updatedBlocks,
        ].sort(bySortPos),
      },
      loadedBlockPages: new Set(s.loadedBlockPages).add(targetPageId),
    }));
    touchPageForBlockChange(get().updatePage, sourcePageId);
    touchPageForBlockChange(get().updatePage, targetPageId);

    const movedRoot = updatedBlocks.find((block) => block.id === id)!;
    const blocksPersist = await durableRemoteCall("updateBlockRemote", [
      movedRoot.id,
      {
        pageId: movedRoot.pageId,
        parentId: movedRoot.parentId,
        position: movedRoot.position,
      } as Partial<Block>,
      targetPageId,
    ]);
    if (blocksPersist.status === "dropped") {
      set((s) => {
        const blockHistoryByPage = { ...s.blockHistoryByPage };
        if (sourceHistoryBefore) blockHistoryByPage[sourcePageId] = sourceHistoryBefore;
        else delete blockHistoryByPage[sourcePageId];
        if (targetHistoryBefore) blockHistoryByPage[targetPageId] = targetHistoryBefore;
        else delete blockHistoryByPage[targetPageId];
        return {
          blocksByPage: {
            ...s.blocksByPage,
            [sourcePageId]: sourceBlocks,
            [targetPageId]: targetBlocks,
          },
          blockHistoryByPage,
        };
      });
      await Promise.all([
        reloadBlocksFromServer(sourcePageId).catch(() => {}),
        reloadBlocksFromServer(targetPageId).catch(() => {}),
      ]);
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
      ]);
      if (commentsCall.status === "dropped") {
        await Promise.all([
          get().loadComments(sourcePageId, { force: true }).catch(() => {}),
          get().loadComments(targetPageId, { force: true }).catch(() => {}),
        ]);
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

	    const call = await durableRemoteCall("createBlocksRemote", [newBlocks]);
    if (call.status === "dropped") {
      const copiedIds = new Set(newBlocks.map((block) => block.id));
      set((s) => {
        const blockHistoryByPage = { ...s.blockHistoryByPage };
        if (historyBefore) blockHistoryByPage[targetPageId] = historyBefore;
        else delete blockHistoryByPage[targetPageId];
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
      await reloadBlocksFromServer(targetPageId).catch(() => {});
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
        })
      : existing.past
          .concat({ blocks: snapshot, operations: [entryOperation], at: now, mode })
          .slice(-HISTORY_LIMIT);
    set((s) => ({
      blockHistoryByPage: {
        ...s.blockHistoryByPage,
        [pageId]: { past, future: [] },
      },
    }));
    if (!isTemplateEditorPageId(entryOperation.pageId)) {
      recordBlockStructureOperation(entryOperation);
    }
  },

  captureBlockHistory(pageId, mode = "push") {
    const snapshot = cloneBlocks(get().blocksByPage[pageId] ?? []);
    const existing = get().blockHistoryByPage[pageId] ?? { past: [], future: [] };
    const last = existing.past[existing.past.length - 1];
    const now = Date.now();
    if (last && snapshotsEqual(last.blocks, snapshot)) return;

    if (mode === "merge" && last?.mode === "merge" && now - last.at < MERGE_WINDOW_MS) {
      const past = existing.past.slice(0, -1).concat({ ...last, at: now });
      set((s) => ({
        blockHistoryByPage: {
          ...s.blockHistoryByPage,
          [pageId]: { past, future: [] },
        },
      }));
      return;
    }

    const past = existing.past
      .concat({ blocks: snapshot, at: now, mode })
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
        const affectedPageIds = new Set<string>([
          pageId,
          ...(entry.link ? [entry.link.pageId] : []),
          ...entry.operations.flatMap((operation) => [
            operation.pageId,
            ...operation.before.map((block) => block.pageId),
            ...operation.after.map((block) => block.pageId),
          ]),
        ]);
        const blocksBefore = new Map(
          Array.from(affectedPageIds, (affectedPageId) => [
            affectedPageId,
            cloneBlocks(get().blocksByPage[affectedPageId] ?? []),
          ])
        );
        for (const operation of [...entry.operations].reverse()) {
          const target = historyOperationTarget(operation, "undo");
          const removeIds = new Set(target.remove.map((block) => block.id));
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
          if (!isTemplateEditorPageId(operation.pageId)) {
            touchPageForBlockChange(get().updatePage, operation.pageId);
            const calls = await persistBlockStructureOperation(operation, "undo");
            if (firstDroppedDurableCall(calls)) {
              set((s) => {
                const blocksByPage = { ...s.blocksByPage };
                for (const [affectedPageId, blocks] of blocksBefore) {
                  blocksByPage[affectedPageId] = blocks;
                }
                return { blocksByPage };
              });
              await Promise.all(
                Array.from(affectedPageIds, (affectedPageId) =>
                  reloadBlocksFromServer(affectedPageId).catch(() => {})
                )
              );
              return false;
            }
            recordBlockStructureOperation(operation, "inverse");
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
              .concat({ blocks: current, at: Date.now(), mode: "push" })
              .slice(-HISTORY_LIMIT),
          },
        },
      }));
      if (!isTemplateEditorPageId(pageId)) {
        touchPageForBlockChange(get().updatePage, pageId);
        const calls = await persistBlockSnapshot(pageId, current, restored);
        if (firstDroppedDurableCall(calls)) {
          set((s) => ({
            blocksByPage: { ...s.blocksByPage, [pageId]: current },
            blockHistoryByPage: { ...s.blockHistoryByPage, [pageId]: history },
          }));
          await reloadBlocksFromServer(pageId).catch(() => {});
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
        const affectedPageIds = new Set<string>([
          pageId,
          ...(entry.link ? [entry.link.pageId] : []),
          ...entry.operations.flatMap((operation) => [
            operation.pageId,
            ...operation.before.map((block) => block.pageId),
            ...operation.after.map((block) => block.pageId),
          ]),
        ]);
        const blocksBefore = new Map(
          Array.from(affectedPageIds, (affectedPageId) => [
            affectedPageId,
            cloneBlocks(get().blocksByPage[affectedPageId] ?? []),
          ])
        );
        for (const operation of entry.operations) {
          const target = historyOperationTarget(operation, "redo");
          const removeIds = new Set(target.remove.map((block) => block.id));
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
          if (!isTemplateEditorPageId(operation.pageId)) {
            touchPageForBlockChange(get().updatePage, operation.pageId);
            const calls = await persistBlockStructureOperation(operation, "redo");
            if (firstDroppedDurableCall(calls)) {
              set((s) => {
                const blocksByPage = { ...s.blocksByPage };
                for (const [affectedPageId, blocks] of blocksBefore) {
                  blocksByPage[affectedPageId] = blocks;
                }
                return { blocksByPage };
              });
              await Promise.all(
                Array.from(affectedPageIds, (affectedPageId) =>
                  reloadBlocksFromServer(affectedPageId).catch(() => {})
                )
              );
              return false;
            }
            recordBlockStructureOperation(operation);
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
              .concat({ blocks: current, at: Date.now(), mode: "push" })
              .slice(-HISTORY_LIMIT),
            future: history.future.slice(0, -1),
          },
        },
      }));
      if (!isTemplateEditorPageId(pageId)) {
        touchPageForBlockChange(get().updatePage, pageId);
        const calls = await persistBlockSnapshot(pageId, current, restored);
        if (firstDroppedDurableCall(calls)) {
          set((s) => ({
            blocksByPage: { ...s.blocksByPage, [pageId]: current },
            blockHistoryByPage: { ...s.blockHistoryByPage, [pageId]: history },
          }));
          await reloadBlocksFromServer(pageId).catch(() => {});
          return false;
        }
      }
      return true;
    });
  },
  };
}
