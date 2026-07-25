import type { StoreApi } from "zustand";
import type {
  Block,
  ButtonTemplateBlock,
  DbProperty,
  DbTemplate,
  DbView,
  Page,
  PageParentType,
  PropertyConfig,
  ViewConfig,
} from "./types";
import type {
  AppState,
  DatabaseRowPageState,
  PageStoreRuntime,
} from "./store";

type PageStoreActions = Pick<
  AppState,
  | "childPages"
  | "recentPages"
  | "recordPageVisit"
  | "favoritePages"
  | "trashedPages"
  | "canPermanentlyDeletePage"
  | "createPage"
  | "applyRemotePage"
  | "applyRemotePagePatch"
  | "refreshWorkspacePages"
  | "refreshPageAccess"
  | "applySharedPageSnapshot"
  | "updatePage"
  | "trashPage"
  | "restorePage"
  | "deletePage"
  | "emptyTrash"
  | "duplicatePage"
  | "toggleFavorite"
  | "movePage"
>;

export function createPageStoreActions(
  set: StoreApi<AppState>["setState"],
  get: StoreApi<AppState>["getState"],
  runtime: PageStoreRuntime
): PageStoreActions {
  const {
    RECENT_LIMIT,
    activePersistentGeneratedLabels,
    bootstrapWorkspace,
    bySortPos,
    canCreatePageInState,
    canEditPageInState,
    canPermanentlyDeletePageInState,
    cancelPendingBlock,
    cancelPendingBlockCreate,
    cancelPendingPage,
    clearOfflineWorkspaceFileCache,
    collectPageSubtree,
    createBlocksRemote,
    createPageRemote,
    createPropertyRemote,
    createTemplateRemote,
    createViewRemote,
    currentRelativeRouteHref,
    deleteDatabaseRowRemote,
    deletePageRemote,
    duplicatePageRemote,
    durableRemoteCall,
    ensureAuth,
    flushPage,
    getDatabaseSnapshotRemote,
    getPageBlocksRemote,
    hasTrashedAncestor,
    isKoreanLocale,
    isPageParentLocked,
    isTemplateEditorPageId,
    lockedPageAllowsPatch,
    markPermanentDeleteCacheCleanupPending,
    materializeOutboxEffects,
    mirrorPendingPage,
    newId,
    nowIso,
    optimisticPageOverlays,
    outboxAllEntries,
    overlayOutboxOnPages,
    pageDisplayTitle,
    pageTimers,
    pendingBlockCreate,
    pendingBlockPage,
    pendingPage,
    pendingPageBase,
    pendingPageBefore,
    pendingPageExpectedMutationId,
    pendingPageMutationId,
    inFlightPageMutationId,
    inFlightPagePatch,
    persistPageCreate,
    persistablePagePatch,
    positionBetween,
    reconcilePersistedPageMutation,
    recordCacheClear,
    remapBlockContent,
    remapViewConfigPropertyIds,
    rememberPermanentDeleteIds,
    remotePageWithOptimisticOverlay,
    setWorkspacePeople,
    storeMessages,
    stripComputedFromPages,
    advanceWorkspaceDataEpoch,
    clearRecentDatabaseRowsQueries,
    writeRecentPageIds,
    writeTreeExpandedPageIds,
  } = runtime;

  const emptyChildPages: Page[] = [];
  let pageTreeSnapshot: {
    source: AppState["pagesById"];
    childPagesByParent: Map<string | null, Page[]>;
    favoritePages: Page[];
  } | undefined;

  function currentPageTreeSnapshot() {
    const pagesById = get().pagesById;
    if (pageTreeSnapshot?.source === pagesById) return pageTreeSnapshot;

    const childPagesByParent = new Map<string | null, Page[]>();
    const favoritePages: Page[] = [];
    for (const page of Object.values(pagesById)) {
      if (page.inTrash) continue;
      if (page.isFavorite) favoritePages.push(page);

      let treeParentId: string | null | undefined;
      if (page.parentType === "workspace" || page.parentId == null) {
        treeParentId = null;
      } else if (page.parentType === "page") {
        treeParentId = page.parentId;
      }
      if (treeParentId === undefined) continue;

      const children = childPagesByParent.get(treeParentId);
      if (children) children.push(page);
      else childPagesByParent.set(treeParentId, [page]);
    }
    for (const children of childPagesByParent.values()) children.sort(bySortPos);
    favoritePages.sort(bySortPos);

    pageTreeSnapshot = { source: pagesById, childPagesByParent, favoritePages };
    return pageTreeSnapshot;
  }

  function invalidateDatabaseRowsForPages(pages: Array<Page | undefined>) {
    const databaseIds = new Set<string>();
    for (const page of pages) {
      if (page?.parentType === "database" && page.parentId) {
        databaseIds.add(page.parentId);
      }
    }
    for (const databaseId of databaseIds) clearRecentDatabaseRowsQueries(databaseId);
  }

  return {
// ── pages ───────────────────────────────────────────────────────────
  childPages(parentId) {
    return currentPageTreeSnapshot().childPagesByParent.get(parentId) ?? emptyChildPages;
  },

  recentPages() {
    const pagesById = get().pagesById;
    return get()
      .recentPageIds.map((id) => pagesById[id])
      .filter((page): page is Page => !!page && !page.inTrash);
  },

  recordPageVisit(id) {
    const page = get().pagesById[id];
    if (!page || page.inTrash) return;
    set((s) => {
      const recentPageIds = [id, ...s.recentPageIds.filter((item) => item !== id)].slice(0, RECENT_LIMIT);
      writeRecentPageIds(s.workspace?.id, recentPageIds);
      return { recentPageIds };
    });
  },

  favoritePages() {
    return currentPageTreeSnapshot().favoritePages;
  },

  trashedPages() {
    const pagesById = get().pagesById;
    return Object.values(pagesById)
      .filter((p) => p.inTrash)
      .filter((p) => !hasTrashedAncestor(pagesById, p))
      .sort((a, b) => (b.trashedAt ?? "").localeCompare(a.trashedAt ?? ""));
  },

  canPermanentlyDeletePage(id) {
    return canPermanentlyDeletePageInState(get(), get().pagesById[id]);
  },

  async createPage(opts) {
    const ws = get().workspace;
    if (!ws) throw new Error("no workspace");
    const userId = get().userId || (await ensureAuth());
    if (userId && userId !== get().userId) set({ userId });
    if (!canCreatePageInState(get(), opts.parentId, userId, opts.teamspaceId)) {
      throw new Error("Page access required.");
    }
    if (opts.parentId && get().pagesById[opts.parentId]?.isLocked) {
      throw new Error("Page is locked.");
    }
    const originHref = currentRelativeRouteHref();
    const id = newId();
    const now = nowIso();
    const position = positionBetween(opts.afterPosition, opts.beforePosition);
    const page: Page = {
      id,
      createdAt: now,
      updatedAt: now,
      workspaceId: ws.id,
      parentId: opts.parentId,
      parentType: opts.parentType,
      ...(opts.parentType === "workspace" && opts.teamspaceId
        ? { teamspaceId: opts.teamspaceId, teamspacePermissionMode: "inherit" as const }
        : {}),
      kind: opts.kind ?? "page",
      title: opts.title ?? "",
      iconType: "none",
      font: "default",
      smallText: false,
      fullWidth: false,
      isLocked: false,
      backlinksDisplay: "default",
      pageCommentsDisplay: "default",
      position,
      isFavorite: false,
      isPublic: false,
      inTrash: false,
      createdBy: userId || undefined,
      lastEditedBy: userId || undefined,
    };
    const focusTarget = opts.focusTarget ?? (opts.focusTitle === false ? undefined : "title");
    invalidateDatabaseRowsForPages([page]);
    set((s) => ({
      pagesById: { ...s.pagesById, [id]: page },
      pageRolesById: { ...s.pageRolesById, [id]: "edit" },
      ...(focusTarget ? { focusPageId: id, focusPageTarget: focusTarget } : {}),
      ...(page.kind === "page"
        ? {
            blocksByPage: { ...s.blocksByPage, [id]: [] },
            loadedBlockPages: new Set(s.loadedBlockPages).add(id),
          }
        : {}),
    }));
    // Navigation callers await this method. Return the complete optimistic
    // page now and persist in the background so a slow NAS cannot hold the
    // route transition hostage. The create queue gates title/block/child
    // writes until the server owns this client id.
    persistPageCreate(page, originHref, userId || "");
    return page;
  },

  async applyRemotePage(page) {
    invalidateDatabaseRowsForPages([get().pagesById[page.id], page]);
    set((s) => ({
      pagesById: { ...s.pagesById, [page.id]: remotePageWithOptimisticOverlay(page) },
    }));
    await reconcilePersistedPageMutation(page.id, page);
  },

  applyRemotePagePatch(id, patch) {
    const current = get().pagesById[id];
    invalidateDatabaseRowsForPages([
      current,
      current ? { ...current, ...patch } : undefined,
    ]);
    set((s) => {
      const current = s.pagesById[id];
      if (!current) return {};
      return { pagesById: { ...s.pagesById, [id]: { ...current, ...patch } } };
    });
  },

  // Re-fetch the workspace page list and merge it into the tree. Needed after
  // server-side bulk writes (e.g. a Notion import) that bypass local actions.
  async refreshWorkspacePages() {
    if (get().activeDataScope?.kind === "public_share") return;
    const ws = get().workspace;
    if (!ws) return;
    const {
      pages = [],
      pageRoles = {},
      sharedPageIds = [],
      teamspaces = [],
      discoverableTeamspaces = [],
      teamspaceSettings,
    } = await bootstrapWorkspace({ workspaceId: ws.id });
    const entries = await outboxAllEntries(get().userId ?? "");
    const projectedPages = overlayOutboxOnPages(entries, pages);
    const before = get();
    const returnedPageIds = new Set(projectedPages.map((page) => page.id));
    const revokedTeamspacePageIds = new Set<string>();
    for (const page of Object.values(before.pagesById)) {
      if (
        page.parentType !== "workspace"
        || !page.teamspaceId
        || returnedPageIds.has(page.id)
      ) {
        continue;
      }
      for (const pageId of collectPageSubtree(before.pagesById, page.id)) {
        revokedTeamspacePageIds.add(pageId);
      }
    }
    if (revokedTeamspacePageIds.size) {
      const pendingBlockIds = new Set<string>();
      for (const pageId of revokedTeamspacePageIds) {
        cancelPendingPage(pageId);
        for (const block of before.blocksByPage[pageId] ?? []) pendingBlockIds.add(block.id);
      }
      for (const [blockId, pageId] of pendingBlockPage) {
        if (revokedTeamspacePageIds.has(pageId)) pendingBlockIds.add(blockId);
      }
      for (const block of pendingBlockCreate.values()) {
        if (revokedTeamspacePageIds.has(block.pageId)) pendingBlockIds.add(block.id);
      }
      for (const blockId of pendingBlockIds) {
        cancelPendingBlock(blockId);
        cancelPendingBlockCreate(blockId);
      }
    }
    clearRecentDatabaseRowsQueries();
    set((s) => {
      const pagesById = { ...s.pagesById };
      const pageRolesById = { ...s.pageRolesById };
      const blocksByPage = { ...s.blocksByPage };
      const blockHistoryByPage = { ...s.blockHistoryByPage };
      const commentsByPage = { ...s.commentsByPage };
      const propsByDb = { ...s.propsByDb };
      const viewsByDb = { ...s.viewsByDb };
      const templatesByDb = { ...s.templatesByDb };
      const databaseRowIdsByDb = { ...s.databaseRowIdsByDb };
      const databaseRowPagesByDb = { ...s.databaseRowPagesByDb };
      const loadedBlockPages = new Set(s.loadedBlockPages);
      const loadedCommentPages = new Set(s.loadedCommentPages);
      const loadedDbs = new Set(s.loadedDbs);
      const treeExpandedPageIds = new Set(s.treeExpandedPageIds);
      const hydratedRelationTargetIds = new Set(s.hydratedRelationTargetIds);
      for (const pageId of revokedTeamspacePageIds) {
        delete pagesById[pageId];
        delete pageRolesById[pageId];
        delete blocksByPage[pageId];
        delete blockHistoryByPage[pageId];
        delete commentsByPage[pageId];
        delete propsByDb[pageId];
        delete viewsByDb[pageId];
        delete templatesByDb[pageId];
        delete databaseRowIdsByDb[pageId];
        delete databaseRowPagesByDb[pageId];
        loadedBlockPages.delete(pageId);
        loadedCommentPages.delete(pageId);
        loadedDbs.delete(pageId);
        treeExpandedPageIds.delete(pageId);
        hydratedRelationTargetIds.delete(pageId);
      }
      for (const [databaseId, rowIds] of Object.entries(databaseRowIdsByDb)) {
        databaseRowIdsByDb[databaseId] = rowIds.filter(
          (pageId) => !revokedTeamspacePageIds.has(pageId),
        );
      }
      for (const page of projectedPages) pagesById[page.id] = page;
      Object.assign(pageRolesById, pageRoles);
      return {
        activeDataScope:
          s.activeDataScope?.kind === "workspace" &&
          s.activeDataScope.workspaceId === ws.id
            ? s.activeDataScope
            : {
                kind: "workspace" as const,
                membershipAuthority: "cached" as const,
                workspaceId: ws.id,
              },
        pagesById,
        teamspaces,
        discoverableTeamspaces,
        teamspaceSettings,
        pageRolesById,
        blocksByPage,
        blockHistoryByPage,
        commentsByPage,
        propsByDb,
        viewsByDb,
        templatesByDb,
        databaseRowIdsByDb,
        databaseRowPagesByDb,
        loadedBlockPages,
        loadedCommentPages,
        loadedDbs,
        treeExpandedPageIds,
        hydratedRelationTargetIds,
        recentPageIds: s.recentPageIds.filter(
          (pageId) => !revokedTeamspacePageIds.has(pageId),
        ),
        sharedPageIds: new Set(sharedPageIds),
        ...(s.commentPanel && revokedTeamspacePageIds.has(s.commentPanel.pageId)
          ? { commentPanel: undefined }
          : {}),
        ...(s.focusPageId && revokedTeamspacePageIds.has(s.focusPageId)
          ? { focusPageId: undefined, focusPageTarget: undefined }
          : {}),
      };
    });
    if (revokedTeamspacePageIds.size) {
      await Promise.all([
        recordCacheClear(before.userId ?? ""),
        clearOfflineWorkspaceFileCache(),
      ]);
    }
    materializeOutboxEffects(entries);
  },

  async refreshPageAccess(pageId) {
    if (get().activeDataScope?.kind === "public_share") return;
    const targetPageId = pageId.trim();
    if (!targetPageId) return;
    const {
      workspace: ws,
      currentMember,
      members = [],
      pages = [],
      pageRoles = {},
      sharedPageIds = [],
      workspaces = [],
      organizationProfiles = [],
      teamspaces = [],
      discoverableTeamspaces = [],
      teamspaceSettings,
    } = await bootstrapWorkspace({ pageId: targetPageId });
    const entries = await outboxAllEntries(get().userId ?? "");
    const projectedPages = overlayOutboxOnPages(entries, pages);
    clearRecentDatabaseRowsQueries();
    setWorkspacePeople(members, organizationProfiles);
    set((s) => {
      const pagesById = { ...s.pagesById };
      for (const page of projectedPages) pagesById[page.id] = page;
      return {
        workspace: ws,
        activeDataScope: {
          kind: "workspace" as const,
          membershipAuthority: "fresh" as const,
          workspaceId: ws.id,
        },
        currentMember,
        workspaceMembers: members,
        teamspaces,
        discoverableTeamspaces,
        teamspaceSettings,
        workspaces: workspaces.length ? workspaces : s.workspaces,
        pagesById,
        pageRolesById: { ...s.pageRolesById, ...pageRoles },
        sharedPageIds: new Set(sharedPageIds),
      };
    });
    materializeOutboxEffects(entries);
  },

  applySharedPageSnapshot(snapshot, shareKey) {
    clearRecentDatabaseRowsQueries();
    const blocksByPage = new Map<string, Block[]>();
    for (const block of snapshot.blocks ?? []) {
      const list = blocksByPage.get(block.pageId) ?? [];
      list.push(block);
      blocksByPage.set(block.pageId, list);
    }
    const propsByDb = new Map<string, DbProperty[]>();
    for (const prop of snapshot.properties ?? []) {
      const list = propsByDb.get(prop.databaseId) ?? [];
      list.push(prop);
      propsByDb.set(prop.databaseId, list);
    }
    const viewsByDb = new Map<string, DbView[]>();
    for (const view of snapshot.views ?? []) {
      const list = viewsByDb.get(view.databaseId) ?? [];
      list.push(view);
      viewsByDb.set(view.databaseId, list);
    }
    const templatesByDb = new Map<string, DbTemplate[]>();
    for (const template of snapshot.templates ?? []) {
      const list = templatesByDb.get(template.databaseId) ?? [];
      list.push(template);
      templatesByDb.set(template.databaseId, list);
    }

    set(() => {
      const workspaceId = snapshot.page.workspaceId;
      // Public data is a separate mounted scope, not a merge into the signed-in
      // workspace cache. Filter defensively to the root workspace and replace
      // every page-derived map so a prior private page/role/database cannot
      // leak into the public tree or influence rendering.
      const scopedPages = [snapshot.page, ...(snapshot.pages ?? [])].filter(
        (page, index, all) =>
          page.workspaceId === workspaceId && all.findIndex((candidate) => candidate.id === page.id) === index
      );
      const pagesById = Object.fromEntries(scopedPages.map((page) => [page.id, page]));
      const scopedPageIds = new Set(Object.keys(pagesById));

      const nextBlocksByPage: Record<string, Block[]> = {};
      const loadedBlockPages = new Set<string>();
      for (const page of scopedPages) {
        nextBlocksByPage[page.id] = (blocksByPage.get(page.id) ?? []).sort(bySortPos);
        loadedBlockPages.add(page.id);
      }

      const nextPropsByDb: Record<string, DbProperty[]> = {};
      const nextViewsByDb: Record<string, DbView[]> = {};
      const nextTemplatesByDb: Record<string, DbTemplate[]> = {};
      const databaseRowIdsByDb: Record<string, string[]> = {};
      const databaseRowPagesByDb: Record<string, DatabaseRowPageState> = {};
      const loadedDbs = new Set<string>();
      const metadataDbIds = new Set<string>([
        ...Array.from(propsByDb.keys()).filter((id) => scopedPageIds.has(id)),
        ...Array.from(viewsByDb.keys()).filter((id) => scopedPageIds.has(id)),
        ...Array.from(templatesByDb.keys()).filter((id) => scopedPageIds.has(id)),
        ...scopedPages
          .filter((page) => page.kind === "database")
          .map((page) => page.id),
      ]);
      for (const dbId of metadataDbIds) {
        nextPropsByDb[dbId] = (propsByDb.get(dbId) ?? []).sort(bySortPos);
        nextViewsByDb[dbId] = (viewsByDb.get(dbId) ?? []).sort(bySortPos);
        nextTemplatesByDb[dbId] = (templatesByDb.get(dbId) ?? []).sort(bySortPos);
        const rowIds = scopedPages
          .filter((row) => row.parentType === "database" && row.parentId === dbId && !row.inTrash)
          .sort(bySortPos)
          .map((row) => row.id);
        databaseRowIdsByDb[dbId] = rowIds;
        databaseRowPagesByDb[dbId] = {
          loadedCount: rowIds.length,
          totalCount: rowIds.length,
          hasMore: false,
        };
        loadedDbs.add(dbId);
      }

      return {
        activeDataScope: { kind: "public_share" as const, shareKey, workspaceId },
        pagesById,
        pageRolesById: {},
        sharedPageIds: new Set<string>(),
        recentPageIds: [],
        treeExpandedPageIds: new Set<string>(),
        blocksByPage: nextBlocksByPage,
        loadedBlockPages,
        blockHistoryByPage: {},
        commentsByPage: {},
        loadedCommentPages: new Set<string>(),
        commentPanel: undefined,
        propsByDb: nextPropsByDb,
        viewsByDb: nextViewsByDb,
        templatesByDb: nextTemplatesByDb,
        databaseRowIdsByDb,
        databaseRowPagesByDb,
        loadedDbs,
        hydratedRelationTargetIds: new Set<string>(),
      };
    });
  },

  updatePage(id, patch, opts) {
    const cur = get().pagesById[id];
    if (!cur) return;
    if (!canEditPageInState(get(), cur)) {
      get().notify(storeMessages().editAccessDeniedSave, "default");
      return;
    }
    if (cur.isLocked && !lockedPageAllowsPatch(patch)) {
      get().notify(storeMessages().pageLockedSave, "default");
      return;
    }
    const userId = get().userId;
    const nextPatch: Partial<Page> = { ...patch };
    if (!("updatedAt" in nextPatch)) nextPatch.updatedAt = nowIso();
    if (userId && !("lastEditedBy" in nextPatch)) nextPatch.lastEditedBy = userId;
    const invalidatesComputed = "properties" in nextPatch;
    const localPatch = invalidatesComputed ? { ...nextPatch, __computed: undefined } : nextPatch;
    invalidateDatabaseRowsForPages([cur, { ...cur, ...localPatch }]);
    set((s) => {
      const pagesById = invalidatesComputed ? stripComputedFromPages(s.pagesById) : s.pagesById;
      return { pagesById: { ...pagesById, [id]: { ...cur, ...localPatch } } };
    });
    if (isTemplateEditorPageId(id)) return;
    if (!pendingPage.has(id)) {
      pendingPageBefore.set(id, cur);
      const predecessorMutationId = inFlightPageMutationId.get(id);
      const predecessorPatch = inFlightPagePatch.get(id);
      if (predecessorMutationId) {
        pendingPageExpectedMutationId.set(id, predecessorMutationId);
      } else {
        pendingPageExpectedMutationId.delete(id);
        if (cur.updatedAt) pendingPageBase.set(id, cur.updatedAt);
        else pendingPageBase.delete(id);
      }
      pendingPageMutationId.set(id, newId());
      pendingPage.set(id, { ...(predecessorPatch ?? {}), ...nextPatch });
    } else {
      pendingPage.set(id, { ...(pendingPage.get(id) ?? {}), ...nextPatch });
    }
    optimisticPageOverlays.set(id, {
      ...(optimisticPageOverlays.get(id) ?? {}),
      ...persistablePagePatch(nextPatch, cur),
    });
    mirrorPendingPage(id);
    if (opts?.debounce) {
      const t = pageTimers.get(id);
      if (t) clearTimeout(t);
      const debounceMs = typeof opts.debounceMs === "number" && Number.isFinite(opts.debounceMs)
        ? Math.max(0, opts.debounceMs)
        : 500;
      pageTimers.set(id, setTimeout(() => void flushPage(id), debounceMs));
    } else {
      void flushPage(id);
    }
  },

  async trashPage(id) {
    const pagesById = get().pagesById;
    const root = pagesById[id];
    if (!root) return;
    if (!canEditPageInState(get(), root)) throw new Error("Page access required.");
    const ts = nowIso();
    const userId = get().userId;
    const patches: Array<{ before: Page; id: string; patch: Partial<Page> }> = [];

    for (const pageId of collectPageSubtree(pagesById, id)) {
      const page = pagesById[pageId];
      if (!page || (page.inTrash && pageId !== id)) continue;
      await flushPage(pageId);
      const patch: Partial<Page> = {
        inTrash: true,
        trashedAt: ts,
        updatedAt: ts,
        ...(userId ? { lastEditedBy: userId } : {}),
      };
      patches.push({ before: page, id: pageId, patch });
    }

    if (patches.length === 0) return;
    invalidateDatabaseRowsForPages(patches.map((item) => item.before));
    set((s) => {
      const next = { ...s.pagesById };
      for (const item of patches) {
        const page = next[item.id];
        if (page) next[item.id] = { ...page, ...item.patch };
      }
      return { pagesById: next };
    });
    const trashCall = await durableRemoteCall(
      root.parentType === "database" ? "trashDatabaseRowRemote" : "trashPageRemote",
      [id],
      undefined,
      undefined,
      root.parentType === "database" && root.parentId
        ? { databaseRowIds: [root.parentId] }
        : { pageIds: [id] },
      () => {
        // Revert only lifecycle fields that still carry this optimistic
        // generation. The durable core then applies the exact canonical page
        // or database-row authority before its final acknowledgement.
        set((state) => {
          const next = { ...state.pagesById };
          for (const item of patches) {
            const current = next[item.id];
            if (
              !current ||
              current.inTrash !== item.patch.inTrash ||
              current.trashedAt !== item.patch.trashedAt
            ) {
              continue;
            }
            const sameMutationStamp = current.updatedAt === item.patch.updatedAt;
            next[item.id] = {
              ...current,
              inTrash: item.before.inTrash,
              trashedAt: item.before.trashedAt,
              ...(sameMutationStamp
                ? {
                    updatedAt: item.before.updatedAt,
                    lastEditedBy: item.before.lastEditedBy,
                  }
                : {}),
            };
          }
          return { pagesById: next };
        });
      }
    );
    if (trashCall.status === "dropped") {
      throw trashCall.error;
    }
    const persisted = trashCall.status === "ok" ? (trashCall.result as Page[]) : [];
    if (persisted.length) {
      set((s) => {
        const next = { ...s.pagesById };
        for (const page of persisted) next[page.id] = { ...(next[page.id] ?? page), ...page };
        return { pagesById: next };
      });
    }
  },

  async restorePage(id) {
    const pagesById = get().pagesById;
    const root = pagesById[id];
    if (!root) return;
    const restoreStamp = root.trashedAt;
    const now = nowIso();
    const userId = get().userId;
    const patches: Array<{ before: Page; id: string; patch: Partial<Page> }> = [];

    for (const pageId of collectPageSubtree(pagesById, id)) {
      const page = pagesById[pageId];
      if (!page?.inTrash) continue;
      if (pageId !== id && restoreStamp && page.trashedAt !== restoreStamp) continue;
      await flushPage(pageId);
      const patch: Partial<Page> = {
        inTrash: false,
        trashedAt: null,
        updatedAt: now,
        ...(userId ? { lastEditedBy: userId } : {}),
      };
      patches.push({ before: page, id: pageId, patch });
    }

    if (patches.length === 0) return;
    invalidateDatabaseRowsForPages(patches.map((item) => item.before));
    set((s) => {
      const next = { ...s.pagesById };
      for (const item of patches) {
        const page = next[item.id];
        if (page) next[item.id] = { ...page, ...item.patch };
      }
      return { pagesById: next };
    });
    const restoreCall = await durableRemoteCall(
      root.parentType === "database" ? "restoreDatabaseRowRemote" : "restorePageRemote",
      [id],
      undefined,
      undefined,
      root.parentType === "database" && root.parentId
        ? { databaseRowIds: [root.parentId] }
        : { pageIds: [id] },
      () => {
        set((state) => {
          const next = { ...state.pagesById };
          for (const item of patches) {
            const current = next[item.id];
            if (
              !current ||
              current.inTrash !== item.patch.inTrash ||
              current.trashedAt !== item.patch.trashedAt
            ) {
              continue;
            }
            const sameMutationStamp = current.updatedAt === item.patch.updatedAt;
            next[item.id] = {
              ...current,
              inTrash: item.before.inTrash,
              trashedAt: item.before.trashedAt,
              ...(sameMutationStamp
                ? {
                    updatedAt: item.before.updatedAt,
                    lastEditedBy: item.before.lastEditedBy,
                  }
                : {}),
            };
          }
          return { pagesById: next };
        });
      }
    );
    if (restoreCall.status === "dropped") {
      throw restoreCall.error;
    }
    const persisted = restoreCall.status === "ok" ? (restoreCall.result as Page[]) : [];
    if (persisted.length) {
      set((s) => {
        const next = { ...s.pagesById };
        for (const page of persisted) next[page.id] = { ...(next[page.id] ?? page), ...page };
        return { pagesById: next };
      });
    }
  },

  async deletePage(id) {
    const before = get();
    const root = before.pagesById[id];
    if (!root) return;
    if (!root.inTrash) throw new Error("Page must be in trash before permanent deletion.");
    if (!canPermanentlyDeletePageInState(before, root)) {
      throw new Error("Full page access is required for permanent deletion.");
    }

    // Permanent deletion is deliberately online-confirmed, not optimistic or
    // background-queued. A transient/offline failure must leave the page in
    // Trash, and a terminal permission failure must never produce a phantom
    // local success. Flush any older page patches before the delete request.
    const expectedSubtree = collectPageSubtree(before.pagesById, id);
    await Promise.all(Array.from(expectedSubtree, (pageId) => flushPage(pageId)));
    const deletedIds = await (root.parentType === "database"
      ? deleteDatabaseRowRemote(id, root.workspaceId)
      : deletePageRemote(id, root.workspaceId));
    const deleted = new Set(deletedIds);
    if (!deleted.has(id)) throw new Error("Permanent deletion was not confirmed by the server.");
    const deletionUserId = before.userId ?? "";
    rememberPermanentDeleteIds(deletionUserId, deleted);
    advanceWorkspaceDataEpoch();
    // Start broad privacy cleanup immediately. Selective pruning cannot find
    // every historic bootstrap/deep-link key or rowsrelated cache, whereas a
    // full record/attachment clear cannot leave deleted content behind.
    const recordClear = recordCacheClear(deletionUserId);
    const attachmentClear = clearOfflineWorkspaceFileCache();

    const deletedDatabaseIds = new Set(
      deletedIds.filter((pageId) => get().pagesById[pageId]?.kind === "database")
    );
    const pendingBlockIds = new Set<string>();
    const current = get();
    for (const pageId of deleted) {
      cancelPendingPage(pageId);
      for (const block of current.blocksByPage[pageId] ?? []) pendingBlockIds.add(block.id);
    }
    for (const [blockId, pageId] of pendingBlockPage) {
      if (deleted.has(pageId)) pendingBlockIds.add(blockId);
    }
    for (const block of pendingBlockCreate.values()) {
      if (deleted.has(block.pageId)) pendingBlockIds.add(block.id);
    }
    for (const blockId of pendingBlockIds) {
      cancelPendingBlock(blockId);
      cancelPendingBlockCreate(blockId);
    }

    set((s) => {
      const pagesById = { ...s.pagesById };
      const pageRolesById = { ...s.pageRolesById };
      const blocksByPage = { ...s.blocksByPage };
      const blockHistoryByPage = { ...s.blockHistoryByPage };
      const commentsByPage = { ...s.commentsByPage };
      const propsByDb = { ...s.propsByDb };
      const viewsByDb = { ...s.viewsByDb };
      const templatesByDb = { ...s.templatesByDb };
      const databaseRowIdsByDb = { ...s.databaseRowIdsByDb };
      const databaseRowPagesByDb = { ...s.databaseRowPagesByDb };
      const loadedBlockPages = new Set(s.loadedBlockPages);
      const loadedCommentPages = new Set(s.loadedCommentPages);
      const loadedDbs = new Set(s.loadedDbs);
      const sharedPageIds = new Set(s.sharedPageIds);
      const treeExpandedPageIds = new Set(s.treeExpandedPageIds);
      const hydratedRelationTargetIds = new Set(s.hydratedRelationTargetIds);

      for (const pageId of deleted) {
        delete pagesById[pageId];
        delete pageRolesById[pageId];
        delete blocksByPage[pageId];
        delete blockHistoryByPage[pageId];
        delete commentsByPage[pageId];
        loadedBlockPages.delete(pageId);
        loadedCommentPages.delete(pageId);
        sharedPageIds.delete(pageId);
        treeExpandedPageIds.delete(pageId);
        hydratedRelationTargetIds.delete(pageId);
      }
      for (const databaseId of deletedDatabaseIds) {
        delete propsByDb[databaseId];
        delete viewsByDb[databaseId];
        delete templatesByDb[databaseId];
        delete databaseRowIdsByDb[databaseId];
        delete databaseRowPagesByDb[databaseId];
        loadedDbs.delete(databaseId);
      }
      for (const [databaseId, rowIds] of Object.entries(databaseRowIdsByDb)) {
        const nextIds = rowIds.filter((rowId) => !deleted.has(rowId));
        if (nextIds.length === rowIds.length) continue;
        databaseRowIdsByDb[databaseId] = nextIds;
        const pageState = databaseRowPagesByDb[databaseId];
        if (pageState) {
          const removedCount = rowIds.length - nextIds.length;
          databaseRowPagesByDb[databaseId] = {
            ...pageState,
            loadedCount: Math.max(0, pageState.loadedCount - removedCount),
            ...(typeof pageState.totalCount === "number"
              ? { totalCount: Math.max(0, pageState.totalCount - removedCount) }
              : {}),
          };
        }
      }

      const recentPageIds = s.recentPageIds.filter((pageId) => !deleted.has(pageId));
      writeRecentPageIds(s.workspace?.id, recentPageIds);
      writeTreeExpandedPageIds(s.workspace?.id, Array.from(treeExpandedPageIds));
      return {
        pagesById,
        pageRolesById,
        blocksByPage,
        loadedBlockPages,
        blockHistoryByPage,
        commentsByPage,
        loadedCommentPages,
        propsByDb,
        viewsByDb,
        templatesByDb,
        loadedDbs,
        databaseRowIdsByDb,
        databaseRowPagesByDb,
        hydratedRelationTargetIds,
        sharedPageIds,
        recentPageIds,
        treeExpandedPageIds,
        ...(s.commentPanel && deleted.has(s.commentPanel.pageId) ? { commentPanel: undefined } : {}),
        ...(s.focusPageId && deleted.has(s.focusPageId)
          ? { focusPageId: undefined, focusPageTarget: undefined }
          : {}),
      };
    });
    const [recordCleared] = await Promise.all([recordClear, attachmentClear]);
    markPermanentDeleteCacheCleanupPending(deletionUserId, !recordCleared);
  },

  async emptyTrash() {
    // Permanently delete every top-level trashed page; deletePage removes each
    // subtree, so nested trashed pages are covered by their trashed root.
    const roots = get().trashedPages();
    if (roots.some((page) => !get().canPermanentlyDeletePage(page.id))) {
      throw new Error("Full access to every trashed root is required to empty Trash.");
    }
    for (const page of roots) {
      await get().deletePage(page.id);
    }
  },

  async duplicatePage(id) {
    const source = get().pagesById[id];
    if (!source) return null;
    if (!canEditPageInState(get(), source)) return null;
    if (isPageParentLocked(get().pagesById, source.parentId)) return null;
    invalidateDatabaseRowsForPages([source]);
    const useRemoteDuplicate = true;
    if (useRemoteDuplicate) {
      const result = await duplicatePageRemote(id, {
        locale: isKoreanLocale() ? "ko" : "en",
      });
      if (!result.page) return null;
      const duplicatedPage = result.page;
      const blocksByNewPage = new Map<string, Block[]>();
      for (const block of result.blocks ?? []) {
        const list = blocksByNewPage.get(block.pageId) ?? [];
        list.push(block);
        blocksByNewPage.set(block.pageId, list);
      }
      const propsByDb = new Map<string, DbProperty[]>();
      for (const prop of result.properties ?? []) {
        const list = propsByDb.get(prop.databaseId) ?? [];
        list.push(prop);
        propsByDb.set(prop.databaseId, list);
      }
      const viewsByDb = new Map<string, DbView[]>();
      for (const view of result.views ?? []) {
        const list = viewsByDb.get(view.databaseId) ?? [];
        list.push(view);
        viewsByDb.set(view.databaseId, list);
      }
      const templatesByDb = new Map<string, DbTemplate[]>();
      for (const template of result.templates ?? []) {
        const list = templatesByDb.get(template.databaseId) ?? [];
        list.push(template);
        templatesByDb.set(template.databaseId, list);
      }

      set((s) => {
        const pagesById = { ...s.pagesById };
        for (const page of result.pages ?? []) pagesById[page.id] = page;
        pagesById[duplicatedPage.id] = duplicatedPage;

        const blocksByPage = { ...s.blocksByPage };
        const loadedBlockPages = new Set(s.loadedBlockPages);
        for (const [pageId, blocks] of blocksByNewPage) {
          blocksByPage[pageId] = blocks.sort(bySortPos);
          loadedBlockPages.add(pageId);
        }

        const nextPropsByDb = { ...s.propsByDb };
        const nextViewsByDb = { ...s.viewsByDb };
        const nextTemplatesByDb = { ...s.templatesByDb };
        let databaseRowIdsByDb = s.databaseRowIdsByDb;
        const loadedDbs = new Set(s.loadedDbs);
        for (const [dbId, props] of propsByDb) {
          nextPropsByDb[dbId] = props.sort(bySortPos);
          loadedDbs.add(dbId);
        }
        for (const [dbId, views] of viewsByDb) {
          nextViewsByDb[dbId] = views.sort(bySortPos);
          loadedDbs.add(dbId);
        }
        for (const [dbId, templates] of templatesByDb) {
          nextTemplatesByDb[dbId] = templates.sort(bySortPos);
          loadedDbs.add(dbId);
        }
        const sourceDatabaseId =
          source.parentType === "database" &&
          typeof source.parentId === "string" &&
          source.parentId === duplicatedPage.parentId
            ? source.parentId
            : undefined;
        if (sourceDatabaseId) {
          const ids = s.databaseRowIdsByDb[sourceDatabaseId] ?? [];
          const sourceIndex = ids.indexOf(source.id);
          const nextIds = ids.filter((id) => id !== duplicatedPage.id);
          nextIds.splice(sourceIndex >= 0 ? sourceIndex + 1 : nextIds.length, 0, duplicatedPage.id);
          databaseRowIdsByDb = { ...s.databaseRowIdsByDb, [sourceDatabaseId]: nextIds };
        }

        return {
          pagesById,
          blocksByPage,
          loadedBlockPages,
          propsByDb: nextPropsByDb,
          viewsByDb: nextViewsByDb,
          templatesByDb: nextTemplatesByDb,
          databaseRowIdsByDb,
          loadedDbs,
        };
      });
      return duplicatedPage;
    }
    const actorId = get().userId || (await ensureAuth());
    if (actorId && actorId !== get().userId) set({ userId: actorId });

    const sameParent = Object.values(get().pagesById)
      .filter(
        (p) =>
          !p.inTrash &&
          p.id !== id &&
          p.parentId === source.parentId &&
          p.parentType === source.parentType
      )
      .sort(bySortPos);
    const after = source.position;
    const before = sameParent.find((p) => p.position > source.position)?.position;
    const dbSnapshotCache = new Map<string, ReturnType<typeof getDatabaseSnapshotRemote>>();

    function loadDatabaseSnapshot(dbId: string) {
      const cached = dbSnapshotCache.get(dbId);
      if (cached) return cached;
      const promise = getDatabaseSnapshotRemote(dbId);
      dbSnapshotCache.set(dbId, promise);
      return promise;
    }

    async function loadPageBlocks(pageId: string) {
      const cached = get().blocksByPage[pageId];
      if (cached) return cached.slice().sort(bySortPos);
      return (await getPageBlocksRemote(pageId)).blocks.sort(bySortPos);
    }

    async function loadDbProps(dbId: string) {
      const cached = get().propsByDb[dbId];
      if (cached) return cached.slice().sort(bySortPos);
      return (await loadDatabaseSnapshot(dbId)).properties.sort(bySortPos);
    }

    async function loadDbViews(dbId: string) {
      const cached = get().viewsByDb[dbId];
      if (cached) return cached.slice().sort(bySortPos);
      return (await loadDatabaseSnapshot(dbId)).views.sort(bySortPos);
    }

    async function loadDbTemplates(dbId: string) {
      const cached = get().templatesByDb[dbId];
      if (cached) return cached.slice().sort(bySortPos);
      return (await loadDatabaseSnapshot(dbId)).templates.sort(bySortPos);
    }

    function cloneValue<T>(value: T): T {
      if (value == null) return value;
      if (typeof structuredClone === "function") return structuredClone(value);
      return JSON.parse(JSON.stringify(value)) as T;
    }

    function remapRelationValue(value: unknown, pageMap?: Map<string, string>) {
      if (!pageMap) return value;
      if (Array.isArray(value)) {
        return value.map((id) => pageMap.get(String(id)) ?? id);
      }
      if (value == null || value === "") return value;
      return pageMap.get(String(value)) ?? value;
    }

    function remapProperties(
      properties: Record<string, unknown> | undefined,
      propMap?: Map<string, string>,
      pageMap?: Map<string, string>,
      propsById?: Map<string, DbProperty>
    ) {
      const cloned = cloneValue(properties ?? {});
      if (!propMap) return cloned;
      const remapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(cloned)) {
        const prop = propsById?.get(key);
        remapped[propMap.get(key) ?? key] =
          prop?.type === "relation" ? remapRelationValue(value, pageMap) : value;
      }
      return remapped;
    }

    function remapTemplateBlocks(
      blocks: ButtonTemplateBlock[] | undefined,
      pageMap?: Map<string, string>
    ): ButtonTemplateBlock[] | undefined {
      if (!blocks) return blocks;
      return cloneValue(blocks).map((block) => ({
        ...block,
        content: remapBlockContent(block.content, pageMap),
        children: remapTemplateBlocks(block.children, pageMap),
      }));
    }

    function remapViewConfig(config: ViewConfig | undefined, propMap: Map<string, string>) {
      return remapViewConfigPropertyIds(config, propMap);
    }

    function remapPropertyConfig(
      config: PropertyConfig | undefined,
      propMap: Map<string, string>,
      sourceDbId: string,
      targetDbId: string
    ): PropertyConfig | undefined {
      if (!config) return config;
      const next = cloneValue(config);
      if (next.relationDatabaseId === sourceDbId) next.relationDatabaseId = targetDbId;
      if (next.rollupRelationPropertyId) {
        next.rollupRelationPropertyId =
          propMap.get(next.rollupRelationPropertyId) ?? next.rollupRelationPropertyId;
      }
      if (next.rollupTargetPropertyId) {
        next.rollupTargetPropertyId =
          propMap.get(next.rollupTargetPropertyId) ?? next.rollupTargetPropertyId;
      }
      if (next.rollupVia) next.rollupVia = propMap.get(next.rollupVia) ?? next.rollupVia;
      return next;
    }

    async function duplicateTree(
      sourceId: string,
      parentId: string | null,
      parentType: PageParentType,
      position: number,
      title?: string,
      propMap?: Map<string, string>,
      pageMap?: Map<string, string>,
      propsById?: Map<string, DbProperty>
    ): Promise<Page> {
      const cur = get().pagesById[sourceId];
      if (!cur) throw new Error("page not found");
      const now = nowIso();
      const newPageId = pageMap?.get(sourceId) ?? newId();
      pageMap?.set(sourceId, newPageId);
      const childPages = Object.values(get().pagesById)
        .filter((p) => p.parentType === "page" && p.parentId === cur.id && !p.inTrash)
        .sort(bySortPos);
      const sourceRows =
        cur.kind === "database"
          ? Object.values(get().pagesById)
              .filter((p) => p.parentType === "database" && p.parentId === cur.id && !p.inTrash)
              .sort(bySortPos)
          : [];
      for (const child of childPages) {
        if (!pageMap?.has(child.id)) pageMap?.set(child.id, newId());
      }
      for (const row of sourceRows) {
        if (!pageMap?.has(row.id)) pageMap?.set(row.id, newId());
      }

      const newPage: Page = {
        id: newPageId,
        createdAt: now,
        updatedAt: now,
        workspaceId: cur.workspaceId,
        parentId,
        parentType,
        kind: cur.kind,
        title: title ?? cur.title,
        icon: cur.icon,
        iconType: cur.iconType,
        cover: cur.cover,
        coverPosition: cur.coverPosition,
        font: cur.font ?? "default",
        smallText: !!cur.smallText,
        fullWidth: !!cur.fullWidth,
        isLocked: false,
        backlinksDisplay: cur.backlinksDisplay ?? "default",
        pageCommentsDisplay: cur.pageCommentsDisplay ?? "default",
        properties: remapProperties(cur.properties, propMap, pageMap, propsById),
        isFavorite: false,
        isPublic: false,
        inTrash: false,
        position,
        createdBy: actorId || undefined,
        lastEditedBy: actorId || undefined,
      };

      set((s) => ({ pagesById: { ...s.pagesById, [newPage.id]: newPage } }));
      const persistedPage = await createPageRemote(newPage);
      set((s) => ({
        pagesById: { ...s.pagesById, [newPage.id]: { ...newPage, ...persistedPage } },
      }));

      const blocks = await loadPageBlocks(cur.id);
      const blockIdMap = new Map<string, string>();
      for (const block of blocks) blockIdMap.set(block.id, newId());
      const newBlocks: Block[] = blocks.map((block) => ({
        id: blockIdMap.get(block.id) as string,
        createdAt: now,
        updatedAt: now,
        pageId: newPage.id,
        parentId: block.parentId ? blockIdMap.get(block.parentId) ?? null : null,
        type: block.type,
        content: remapBlockContent(block.content, pageMap, blockIdMap),
        plainText: block.plainText,
        position: block.position,
        createdBy: actorId || undefined,
      }));
      if (newBlocks.length) {
        set((s) => ({
          blocksByPage: { ...s.blocksByPage, [newPage.id]: newBlocks },
          loadedBlockPages: new Set(s.loadedBlockPages).add(newPage.id),
        }));
        await createBlocksRemote(newBlocks);
      }

      let dbPropMap: Map<string, string> | undefined;
      if (cur.kind === "database") {
        const props = await loadDbProps(cur.id);
        dbPropMap = new Map(props.map((prop) => [prop.id, newId()]));
        const newProps = props.map((prop) => ({
          ...prop,
          id: dbPropMap?.get(prop.id) as string,
          databaseId: newPage.id,
          config: remapPropertyConfig(prop.config, dbPropMap as Map<string, string>, cur.id, newPage.id),
        }));
        const views = await loadDbViews(cur.id);
        const newViews = views.map((view) => ({
          ...view,
          id: newId(),
          databaseId: newPage.id,
          config: remapViewConfig(view.config, dbPropMap as Map<string, string>),
        }));
        const templates = await loadDbTemplates(cur.id);
        const newTemplates = templates.map((template) => ({
          ...template,
          id: newId(),
          databaseId: newPage.id,
          properties: remapProperties(template.properties, dbPropMap, pageMap, new Map(props.map((prop) => [prop.id, prop]))),
          blocks: remapTemplateBlocks(template.blocks, pageMap),
        }));
        set((s) => ({
          propsByDb: { ...s.propsByDb, [newPage.id]: newProps },
          viewsByDb: { ...s.viewsByDb, [newPage.id]: newViews },
          templatesByDb: { ...s.templatesByDb, [newPage.id]: newTemplates },
          loadedDbs: new Set(s.loadedDbs).add(newPage.id),
        }));
        await Promise.all([
          ...newProps.map((prop) => createPropertyRemote(prop as Partial<DbProperty>)),
          ...newViews.map((view) => createViewRemote(view as Partial<DbView>)),
          ...newTemplates.map((template) => createTemplateRemote(template as Partial<DbTemplate>)),
        ]);

        const originalPropsById = new Map(props.map((prop) => [prop.id, prop]));
        for (const row of sourceRows) {
          await duplicateTree(
            row.id,
            newPage.id,
            "database",
            row.position,
            row.title,
            dbPropMap,
            pageMap,
            originalPropsById
          );
        }
      }

      for (const child of childPages) {
        await duplicateTree(child.id, newPage.id, "page", child.position, undefined, undefined, pageMap);
      }

      return newPage;
    }

    return duplicateTree(
      id,
      source.parentId ?? null,
      source.parentType,
      positionBetween(after, before),
      activePersistentGeneratedLabels().copyName(pageDisplayTitle(source)),
      undefined,
      new Map()
    );
  },

  async toggleFavorite(id) {
    const cur = get().pagesById[id];
    if (!cur) return;
    get().updatePage(id, { isFavorite: !cur.isFavorite });
  },

  async movePage(id, newParentId, newParentType, position) {
    const pagesById = get().pagesById;
    const cur = pagesById[id];
    if (!cur) return;
    if (!canEditPageInState(get(), cur)) return;
    if (!canCreatePageInState(get(), newParentId, get().userId)) return;
    if (isPageParentLocked(pagesById, cur.parentId)) return;
    if (isPageParentLocked(pagesById, newParentId)) return;
    const patch = {
      parentId: newParentId,
      parentType: newParentType,
      position,
    };
    get().updatePage(id, patch);
  },
  };
}
