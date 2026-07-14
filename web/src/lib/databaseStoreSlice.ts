import type { StoreApi } from "zustand";
import type {
  DatabaseCreateEffect,
  RowFileRemovalEffect,
} from "./outbox";
import type {
  DbProperty,
  DbTemplate,
  DbView,
  Page,
  PropertyConfig,
  ViewConfig,
} from "./types";
import type {
  AppState,
  CachedRowsMeta,
  DatabaseStoreRuntime,
  DeletedPropertyOptionSnapshot,
  DeletedPropertySnapshot,
} from "./store";

type DatabaseStoreActions = Pick<
  AppState,
  | "loadDatabase"
  | "loadDatabaseRows"
  | "loadMoreDatabaseRows"
  | "warmDatabaseRowDetail"
  | "dbProperties"
  | "dbViews"
  | "dbTemplates"
  | "dbRows"
  | "createDatabase"
  | "addProperty"
  | "updateProperty"
  | "setRelationDatabase"
  | "setRelationTwoWay"
  | "deleteProperty"
  | "restoreDeletedProperty"
  | "deletePropertyOption"
  | "restoreDeletedPropertyOption"
  | "addView"
  | "updateView"
  | "deleteView"
  | "restoreDeletedView"
  | "addTemplate"
  | "duplicateTemplate"
  | "updateTemplate"
  | "deleteTemplate"
  | "restoreDeletedTemplate"
  | "addRow"
  | "moveDatabaseRow"
  | "setRowProperty"
  | "removeRowFilePropertyItem"
  | "setRelation"
>;

export function createDatabaseStoreActions(
  set: StoreApi<AppState>["setState"],
  get: StoreApi<AppState>["getState"],
  runtime: DatabaseStoreRuntime
): DatabaseStoreActions {
  const {
    CLIENT_PROPERTY_OPTION_DELETE_ENABLED,
    CLIENT_SCHEMA_RESTORE_ENABLED,
    DATABASE_INITIAL_ROW_LIMIT,
    DATABASE_ROW_LOAD_MORE_LIMIT,
    appendUniqueIds,
    asIdArray,
    assertDatabaseUnlocked,
    bySortPos,
    cacheCurrentDatabaseMetadata,
    cacheReplaceTable,
    cacheSetMeta,
    canCreatePageInState,
    canEditPageInState,
    cleanUniqueIds,
    cloneJson,
    configChanged,
    currentChangesSyncedAt,
    currentRelativeRouteHref,
    databaseCreateRowsQueryKey,
    databaseLoadPromises,
    databaseMetadataRevalidated,
    databaseNeedsComputedValues,
    databaseRowCacheKeys,
    databaseRowLoadMorePromises,
    databaseRowPageSatisfiesInitialLoad,
    databaseRowsForcedAgain,
    databaseRowsLoadErrorMessage,
    databaseRowsQueryKey,
    databaseRowsQueryPromises,
    durableRemoteCall,
    ensureAuth,
    feedSaysUnchanged,
    finishOptimisticDatabaseCreate,
    getDatabaseRowsRemote,
    getDatabaseSnapshotRemote,
    hasDatabaseTemplateStoredFileReference,
    hydrateDatabaseMetaFromCache,
    hydrateDatabaseRowsFromCache,
    hydrateRowsViaLocalEngine,
    i18next,
    iconTypeForValue,
    isDatabaseLocked,
    isKoreanLocale,
    isTemplateEditorPageId,
    lastHydratedRowsFeedStamp,
    linkedDatabaseResolvedTitle,
    mergeById,
    mirrorPendingPage,
    moveIdRelative,
    newId,
    normalizeDatabaseRowsQuery,
    nowIso,
    optimisticStarterDatabaseSchema,
    outboxUserId,
    pageDisplayTitle,
    pendingDatabaseCreate,
    pendingDatabaseRowCreate,
    pendingPage,
    pendingPageLikeCreateHas,
    pendingPropertyCreate,
    pendingViewCreate,
    permanentDeleteIds,
    persistErrorStatus,
    persistOptimisticTemplateCreate,
    persistableRowProperties,
    positionBetween,
    publishDatabaseRowsMutation,
    publishDatabaseSchemaMutation,
    publishDatabaseTemplatesMutation,
    publishDatabaseViewsMutation,
    recordCacheMeta,
    recordValue,
    registerRowsCacheKey,
    releaseOptimisticCreateDependents,
    reloadBlocksFromServer,
    remotePageWithOptimisticOverlay,
    replaceRoute,
    rollbackDependentWritesForFailedCreate,
    rollbackMatchingFields,
    rollbackOptimisticDatabaseCreate,
    rollbackOptimisticRowProperty,
    routeInfoFromPath,
    rowFileStorageKey,
    stampDatabaseCached,
    startBackgroundDurableCall,
    storeMessages,
    templateTitleValue,
    valueReferencesPendingCreate,
    viewConfigWithoutFilterProperty,
    viewConfigWithoutProperty,
    withoutLoadedDatabaseProperty,
  } = runtime;

  return {
    // ── databases ───────────────────────────────────────────────────────
    async loadDatabase(dbId, options = {}) {
      if (pendingDatabaseCreate.has(dbId)) return;
      const loadUserId = outboxUserId();
      if (loadUserId && permanentDeleteIds(loadUserId).has(dbId)) return;
      const force = options.force === true;
      const includeRows = options.rows !== false;
      const requestedViewIds = cleanUniqueIds(options.viewIds);
      const databasePage = get().pagesById[dbId];
      const needsLinkedDatabaseResolution =
        databasePage?.kind === "database" &&
        databasePage.properties?.notionLinkedDatabaseSourceUnavailable === true &&
        !linkedDatabaseResolvedTitle(databasePage);
      const currentViews = get().viewsByDb[dbId] ?? [];
      const needsRequestedViews = requestedViewIds.some(
        (viewId) => !currentViews.some((view) => view.id === viewId)
      );
      const hasMetadata =
        !!get().propsByDb[dbId] ||
        !!get().viewsByDb[dbId] ||
        !!get().templatesByDb[dbId];
      const metadataRevalidated = databaseMetadataRevalidated.has(dbId);
      const currentRowPage = get().databaseRowPagesByDb[dbId];
      const rowRefreshPending = currentRowPage?.loading === true || currentRowPage?.loadingMore === true;
      if (
        !force
        && metadataRevalidated
        && includeRows
        && get().loadedDbs.has(dbId)
        && !rowRefreshPending
        && !needsLinkedDatabaseResolution
        && !needsRequestedViews
      ) return;
      if (
        !force
        && metadataRevalidated
        && !includeRows
        && hasMetadata
        && !needsLinkedDatabaseResolution
        && !needsRequestedViews
      ) return;
      const promiseKey = `${dbId}:${includeRows ? "rows" : "metadata"}:${requestedViewIds.join(",")}:${force ? "force" : "cached"}`;
      const pending = databaseLoadPromises.get(promiseKey);
      if (pending) return pending;
      const loadPromise = (async () => {
        // SWR: surface cached schema/views/templates immediately; the snapshot
        // fetch below still runs and reconciles.
        const hydratedMeta =
          !force && !hasMetadata ? await hydrateDatabaseMetaFromCache(dbId) : false;
        // Always revalidate hydrated database metadata. The workspace feed is a
        // page/change accelerator, but a schema/view/template mutation can land
        // without a changedDatabaseIds entry that covers this cache generation.
        // Treating that absence as proof of freshness was the reload bug: rows
        // returned while recently-created properties/views stayed missing.
        const needsSnapshot =
          force ||
          needsLinkedDatabaseResolution ||
          needsRequestedViews ||
          !metadataRevalidated ||
          !hasMetadata;
        if (needsSnapshot) {
          let snapshot: Awaited<ReturnType<typeof getDatabaseSnapshotRemote>>;
          try {
            snapshot = await getDatabaseSnapshotRemote(dbId, { viewIds: requestedViewIds });
            if (
              loadUserId && permanentDeleteIds(loadUserId).has(dbId)
            ) return;
          } catch (error) {
            // Offline with cached metadata: keep serving it; rows below get the
            // same treatment via their own cache.
            if (!hydratedMeta) throw error;
            if (includeRows && !get().loadedDbs.has(dbId)) {
              await get().loadDatabaseRows(dbId, {
                force,
                limit: DATABASE_INITIAL_ROW_LIMIT,
                offset: 0,
                reset: true,
              });
            }
            return;
          }
          const props = snapshot.properties.sort(bySortPos);
          const views = snapshot.views.sort(bySortPos);
          const templates = snapshot.templates.sort(bySortPos);
          const resolvedDatabaseTitle =
            typeof snapshot.resolvedDatabaseTitle === "string" && snapshot.resolvedDatabaseTitle.trim()
              ? snapshot.resolvedDatabaseTitle.trim()
              : undefined;
          set((s) => {
            const pagesById = { ...s.pagesById };
            if (resolvedDatabaseTitle && pagesById[dbId]) {
              const page = pagesById[dbId];
              pagesById[dbId] = {
                ...page,
                properties: {
                  ...(page.properties ?? {}),
                  notionLinkedDatabaseResolvedTitle: resolvedDatabaseTitle,
                  notionLinkedDatabaseResolvedId: snapshot.resolvedDatabaseId,
                  notionLinkedDatabaseResolvedFromNotionId: snapshot.resolvedFromNotionDatabaseId,
                },
              };
            }
            return {
              pagesById,
              propsByDb: { ...s.propsByDb, [dbId]: props },
              viewsByDb: { ...s.viewsByDb, [dbId]: mergeById(s.viewsByDb[dbId], views) },
              templatesByDb: { ...s.templatesByDb, [dbId]: mergeById(s.templatesByDb[dbId], templates) },
            };
          });
          const cacheUserId = outboxUserId();
          // A snapshot can have started before a local-first view/property
          // mutation committed. State reconciliation above preserves local
          // records by id; cache that reconciled state too. Persisting the raw
          // earlier snapshot here made a reload hydrate an old schema even
          // though the server and the just-finished tab already had the change.
          cacheCurrentDatabaseMetadata(dbId);
          cacheSetMeta(
            cacheUserId,
            recordCacheMeta.databaseMetadataStamp(dbId),
            currentChangesSyncedAt || ""
          );
          stampDatabaseCached(cacheUserId, dbId);
          databaseMetadataRevalidated.add(dbId);
        }

        const rowPage = get().databaseRowPagesByDb[dbId];
        if (
          includeRows
          && (
            force
            || !get().loadedDbs.has(dbId)
            || rowPage?.loading === true
            || rowPage?.loadingMore === true
          )
        ) {
          await get().loadDatabaseRows(dbId, {
            force,
            limit: DATABASE_INITIAL_ROW_LIMIT,
            offset: 0,
            reset: true,
          });
        }
      })();
      databaseLoadPromises.set(promiseKey, loadPromise);
      try {
        await loadPromise;
      } finally {
        if (databaseLoadPromises.get(promiseKey) === loadPromise) {
          databaseLoadPromises.delete(promiseKey);
        }
      }
    },

    async loadDatabaseRows(dbId, query = {}) {
      if (pendingDatabaseCreate.has(dbId)) {
        const queryKey = databaseRowsQueryKey(query);
        set((state) => {
          const current = state.databaseRowPagesByDb[dbId];
          return {
            databaseRowPagesByDb: {
              ...state.databaseRowPagesByDb,
              [dbId]: {
                ...(current ?? { loadedCount: 0, totalCount: 0, hasMore: false }),
                queryKey,
                loading: false,
                loadingMore: false,
                error: undefined,
              },
            },
          };
        });
        return;
      }
      const loadUserId = outboxUserId();
      if (loadUserId && permanentDeleteIds(loadUserId).has(dbId)) return;
      const force = query.force === true;
      const normalized = normalizeDatabaseRowsQuery(query);
      const queryKey = databaseRowsQueryKey(query);
      const offset = query.offset ?? 0;
      const limit = query.limit ?? DATABASE_INITIAL_ROW_LIMIT;
      const reset = query.reset !== false;
      const promiseKey = `${dbId}:${queryKey}:${offset}:${limit}:${reset ? "reset" : "append"}:${force ? "force" : "cached"}`;
      const pending = databaseRowsQueryPromises.get(promiseKey);
      if (pending) {
        if (force) databaseRowsForcedAgain.add(promiseKey);
        await pending;
        if (force && databaseRowsForcedAgain.delete(promiseKey)) {
          if (databaseRowsQueryPromises.get(promiseKey) === pending) {
            databaseRowsQueryPromises.delete(promiseKey);
          }
          return get().loadDatabaseRows(dbId, query);
        }
        // A competing query for the same database can supersede this pending
        // request. Its response is then deliberately discarded by the queryKey
        // guard below. A caller that joined the old promise must verify that the
        // requested first page actually won; otherwise the view can remain bound
        // to the competing query forever without another state change to retrigger
        // its effect.
        if (
          reset &&
          offset === 0 &&
          !databaseRowPageSatisfiesInitialLoad(
            get().databaseRowPagesByDb[dbId],
            queryKey,
            limit
          )
        ) {
          if (databaseRowsQueryPromises.get(promiseKey) === pending) {
            databaseRowsQueryPromises.delete(promiseKey);
          }
          return get().loadDatabaseRows(dbId, query);
        }
        return;
      }
      if (
        !force &&
        reset &&
        offset === 0 &&
        databaseRowPageSatisfiesInitialLoad(get().databaseRowPagesByDb[dbId], queryKey, limit)
      ) {
        return;
      }

      const loadPromise = (async () => {
        set((s) => {
          const current = s.databaseRowPagesByDb[dbId];
          return {
            ...(reset
              ? { databaseRowIdsByDb: { ...s.databaseRowIdsByDb, [dbId]: [] } }
              : {}),
            databaseRowPagesByDb: {
              ...s.databaseRowPagesByDb,
              [dbId]: {
                ...(current?.queryKey === queryKey
                  ? current
                  : { loadedCount: 0, hasMore: false }),
                queryKey,
                loading: reset,
                loadingMore: !reset,
                error: undefined,
              },
            },
          };
        });

        // SWR: if this exact query's first page is cached, render it now (with
        // queued outbox row edits overlaid); the fetch below reconciles.
        const hydratedRows =
          reset && offset === 0 && !force && !(get().databaseRowIdsByDb[dbId] ?? []).length
            ? await hydrateDatabaseRowsFromCache(dbId, queryKey)
            : false;
        // §7 v2: this boot's change feed proves the db untouched since the
        // cache was written — the hydrated render IS current; skip the refetch.
        if (hydratedRows && feedSaysUnchanged(dbId, lastHydratedRowsFeedStamp.get(dbId))) {
          set((s) => {
            const current = s.databaseRowPagesByDb[dbId];
            if (current?.queryKey !== queryKey) return {};
            return {
              databaseRowPagesByDb: {
                ...s.databaseRowPagesByDb,
                [dbId]: { ...current, loading: false, loadingMore: false, error: undefined },
              },
            };
          });
          return;
        }
        try {
          const props = get().dbProperties(dbId);
          const rowsResult = await getDatabaseRowsRemote(dbId, {
            includeComputed: databaseNeedsComputedValues(props),
            includeRelationTargets: true,
            limit,
            offset,
            viewId: normalized.viewId || undefined,
            search: normalized.search || undefined,
            currentPageId: normalized.currentPageId || undefined,
          });
          if (
            loadUserId && permanentDeleteIds(loadUserId).has(dbId)
          ) return;
          const deleted = loadUserId ? permanentDeleteIds(loadUserId) : new Set<string>();
          const liveRows = (rowsResult.rows ?? []).filter((row) => !deleted.has(row.id));
          const liveRelatedPages = (rowsResult.relatedPages ?? []).filter(
            (page) => !deleted.has(page.id)
          );
          const rowOffset = rowsResult.offset ?? offset;
          const incomingRowIds = liveRows.map((row) => row.id);
          const rowsById = Object.fromEntries(
            liveRows.map((row, index) => [
              row.id,
              { ...row, __databaseRowOrder: rowOffset + index + 1 },
            ])
          );
          const relatedPagesById = Object.fromEntries(
            liveRelatedPages.map((page) => [page.id, page])
          );
          set((s) => {
            const current = s.databaseRowPagesByDb[dbId];
            if (current?.queryKey !== queryKey) return {};
            // Overlay queued, in-flight, or not-yet-observed optimistic edits on
            // top of the server snapshot. High-latency mutation events can make
            // an earlier forced query finish after a later local edit.
            const withPendingEdits = (byId: Record<string, Page>) => {
              let merged: Record<string, Page> | null = null;
              for (const id of Object.keys(byId)) {
                const projected = remotePageWithOptimisticOverlay(byId[id]);
                if (projected !== byId[id]) {
                  merged ??= { ...byId };
                  merged[id] = projected;
                }
              }
              return merged ?? byId;
            };
            const existingIds = reset || rowOffset === 0 ? [] : s.databaseRowIdsByDb[dbId] ?? [];
            const rowIds = appendUniqueIds(existingIds, incomingRowIds);
            const hydratedRelationTargetIds = new Set(s.hydratedRelationTargetIds);
            for (const id of rowsResult.relationTargetIds ?? []) {
              hydratedRelationTargetIds.add(id);
            }
            if (!rowsResult.relationTargetIds) {
              for (const page of liveRelatedPages) {
                hydratedRelationTargetIds.add(page.id);
              }
            }
            return {
              pagesById: { ...s.pagesById, ...withPendingEdits(relatedPagesById), ...withPendingEdits(rowsById) },
              hydratedRelationTargetIds,
              databaseRowIdsByDb: { ...s.databaseRowIdsByDb, [dbId]: rowIds },
              databaseRowPagesByDb: {
                ...s.databaseRowPagesByDb,
                [dbId]: {
                  queryKey,
                  loadedCount: rowOffset + incomingRowIds.length,
                  totalCount: rowsResult.totalCount,
                  hasMore: rowsResult.hasMore === true,
                  nextOffset: rowsResult.nextOffset,
                  loading: false,
                  loadingMore: false,
                  error: undefined,
                },
              },
              loadedDbs: new Set(s.loadedDbs).add(dbId),
            };
          });
          if (reset && rowOffset === 0) {
            const cacheUserId = outboxUserId();
            const keys = databaseRowCacheKeys(dbId, queryKey);
            cacheReplaceTable(
              cacheUserId,
              keys.dataTable,
              liveRows.map((row) => ({
                id: row.id,
                value: remotePageWithOptimisticOverlay(row),
              }))
            );
            cacheReplaceTable(
              cacheUserId,
              keys.relatedPagesTable,
              liveRelatedPages.map((page) => ({
                id: page.id,
                value: remotePageWithOptimisticOverlay(page),
              }))
            );
            cacheSetMeta(cacheUserId, keys.meta, {
              hasMore: rowsResult.hasMore === true,
              nextOffset: rowsResult.nextOffset,
              queryKey,
              rowIds: incomingRowIds,
              totalCount: rowsResult.totalCount,
              feedStamp: currentChangesSyncedAt || undefined,
            } satisfies CachedRowsMeta);
            registerRowsCacheKey(cacheUserId, dbId, keys.suffix);
            stampDatabaseCached(cacheUserId, dbId);
          }
        } catch (error) {
          if (hydratedRows) {
            // Offline refresh behind a cached render: keep the rows visible and
            // skip the failure toast; queued edits keep retrying.
            set((s) => {
              const current = s.databaseRowPagesByDb[dbId];
              if (current?.queryKey !== queryKey) return {};
              return {
                databaseRowPagesByDb: {
                  ...s.databaseRowPagesByDb,
                  [dbId]: { ...current, loading: false, loadingMore: false, error: undefined },
                },
              };
            });
            return;
          }
          // No cache for this exact query: try computing the view locally from
          // a complete cached base set before surfacing an error.
          if (
            reset &&
            offset === 0 &&
            (await hydrateRowsViaLocalEngine(dbId, queryKey, normalized).catch(() => false))
          ) {
            return;
          }
          const message = databaseRowsLoadErrorMessage(error);
          set((s) => {
            const current = s.databaseRowPagesByDb[dbId];
            if (current?.queryKey !== queryKey) return {};
            return {
              databaseRowPagesByDb: {
                ...s.databaseRowPagesByDb,
                [dbId]: { ...current, loading: false, loadingMore: false, error: message },
              },
            };
          });
          get().notify(message, "error");
        }
      })();
      databaseRowsQueryPromises.set(promiseKey, loadPromise);
      try {
        await loadPromise;
      } finally {
        if (databaseRowsQueryPromises.get(promiseKey) === loadPromise) {
          databaseRowsQueryPromises.delete(promiseKey);
        }
      }
    },

    async loadMoreDatabaseRows(dbId, query) {
      if (pendingDatabaseCreate.has(dbId)) return;
      const current = get().databaseRowPagesByDb[dbId];
      const queryKey = query ? databaseRowsQueryKey(query) : current?.queryKey ?? databaseRowsQueryKey();
      if (!current?.hasMore || current.loading || current.loadingMore || current.queryKey !== queryKey) return;
      const pending = databaseRowLoadMorePromises.get(dbId);
      if (pending) return pending;
      const loadPromise = get().loadDatabaseRows(dbId, {
        ...(query ?? {}),
        limit: query?.limit ?? DATABASE_ROW_LOAD_MORE_LIMIT,
        offset: current.nextOffset ?? current.loadedCount,
        reset: false,
      });
      databaseRowLoadMorePromises.set(dbId, loadPromise);
      try {
        await loadPromise;
      } finally {
        if (databaseRowLoadMorePromises.get(dbId) === loadPromise) {
          databaseRowLoadMorePromises.delete(dbId);
        }
      }
    },

    warmDatabaseRowDetail(dbId, rowId) {
      const state = get();
      const row = state.pagesById[rowId];
      if (!row || row.inTrash) return;
      void state.loadBlocks(rowId).catch(() => {});

      const relationTargetDbIds = new Set<string>();
      for (const prop of state.dbProperties(dbId)) {
        if (prop.type !== "relation") continue;
        const configuredTarget = prop.config?.relationDatabaseId;
        const targetDbId =
          typeof configuredTarget === "string" && configuredTarget.trim()
            ? configuredTarget.trim()
            : prop.databaseId;
        if (targetDbId) relationTargetDbIds.add(targetDbId);
      }
      for (const targetDbId of relationTargetDbIds) {
        void state.loadDatabase(targetDbId, { rows: false }).catch(() => {});
      }
    },

    dbProperties(dbId) {
      return (get().propsByDb[dbId] ?? []).slice().sort(bySortPos);
    },
    dbViews(dbId) {
      return (get().viewsByDb[dbId] ?? []).slice().sort(bySortPos);
    },
    dbTemplates(dbId) {
      return (get().templatesByDb[dbId] ?? []).slice().sort(bySortPos);
    },
    dbRows(dbId) {
      const state = get();
      const loadedRowIds = state.databaseRowIdsByDb[dbId];
      if (loadedRowIds) {
        return loadedRowIds
          .map((id) => state.pagesById[id])
          .filter((page): page is Page => !!page && !page.inTrash);
      }
      if (!state.loadedDbs.has(dbId) && state.pagesById[dbId]?.kind === "database") return [];
      return Object.values(state.pagesById)
        .filter((p) => p.parentType === "database" && p.parentId === dbId && !p.inTrash)
        .sort(bySortPos);
    },

    async createDatabase(opts) {
      const ws = get().workspace;
      if (!ws) throw new Error("no workspace");
      if (opts.parentId && get().pagesById[opts.parentId]?.isLocked) {
        throw new Error("Page is locked.");
      }
      const userId = get().userId || (await ensureAuth());
      if (userId && userId !== get().userId) set({ userId });
      const id = newId();
      const originHref = currentRelativeRouteHref();
      const viewType = opts.viewType ?? "table";
      const { properties, view } = optimisticStarterDatabaseSchema(
        id,
        viewType,
        opts.properties
      );
      const now = nowIso();
      const siblings = Object.values(get().pagesById)
        .filter(
          (page) =>
            page.parentId === opts.parentId &&
            page.parentType === opts.parentType &&
            !page.inTrash
        )
        .sort(bySortPos);
      const page: Page = {
        id,
        workspaceId: ws.id,
        parentId: opts.parentId,
        parentType: opts.parentType,
        kind: "database",
        title: typeof opts.title === "string" ? opts.title.trim() : "",
        iconType: "none",
        font: "default",
        smallText: false,
        fullWidth: false,
        isLocked: false,
        backlinksDisplay: "default",
        pageCommentsDisplay: "default",
        position: positionBetween(
          opts.afterPosition ?? siblings[siblings.length - 1]?.position,
          undefined
        ),
        isFavorite: false,
        isPublic: false,
        inTrash: false,
        createdBy: userId || undefined,
        lastEditedBy: userId || undefined,
        createdAt: now,
        updatedAt: now,
      };
      const createEffect: DatabaseCreateEffect = {
        databaseId: id,
        kind: "database_create",
        originHref,
        page,
        properties,
        rows: [],
        templates: [],
        views: [view],
      };
      set((s) => ({
        pagesById: { ...s.pagesById, [id]: page },
        pageRolesById: { ...s.pageRolesById, [id]: "edit" },
        propsByDb: { ...s.propsByDb, [id]: properties.slice().sort(bySortPos) },
        viewsByDb: { ...s.viewsByDb, [id]: [view] },
        templatesByDb: { ...s.templatesByDb, [id]: [] },
        databaseRowIdsByDb: { ...s.databaseRowIdsByDb, [id]: [] },
        databaseRowPagesByDb: {
          ...s.databaseRowPagesByDb,
          [id]: {
            queryKey: databaseCreateRowsQueryKey(createEffect),
            loadedCount: 0,
            totalCount: 0,
            hasMore: false,
            loading: false,
            loadingMore: false,
          },
        },
        loadedDbs: new Set(s.loadedDbs).add(id),
      }));
      pendingDatabaseCreate.set(id, opts.parentId ?? "");
      startBackgroundDurableCall({
        args: [
          {
            id,
            viewId: view.id,
            workspaceId: ws.id,
            parentId: opts.parentId,
            parentType: opts.parentType,
            title: page.title,
            afterPosition: opts.afterPosition,
            viewType,
            seedRows: opts.seedRows,
            locale: isKoreanLocale() ? "ko" : "en",
            properties,
          },
        ],
        effect: createEffect,
        fnKey: "createDatabaseRemote",
        opKey: `create-database:${id}`,
        userId: userId || "",
        waitsFor: () => pendingPageLikeCreateHas(opts.parentId),
        onSuccess: (rawResult) => finishOptimisticDatabaseCreate(createEffect, rawResult),
        onDrop: () => rollbackOptimisticDatabaseCreate(createEffect),
      });
      return page;
    },

    async addProperty(dbId, type, name, config) {
      assertDatabaseUnlocked(get().pagesById, dbId);
      const existing = get().dbProperties(dbId);
      const views = get().dbViews(dbId);
      const prop: DbProperty = {
        id: newId(),
        databaseId: dbId,
        name,
        type,
        config,
        position: positionBetween(existing[existing.length - 1]?.position, undefined),
      };
      const updatedViews: DbView[] = [];
      for (const view of views) {
        let changed = false;
        const nextConfig: ViewConfig = { ...(view.config ?? {}) };
        if (nextConfig.propertyOrder && !nextConfig.propertyOrder.includes(prop.id)) {
          nextConfig.propertyOrder = [...nextConfig.propertyOrder, prop.id];
          changed = true;
        }
        if (nextConfig.visibleProperties && !nextConfig.visibleProperties.includes(prop.id)) {
          nextConfig.visibleProperties = [...nextConfig.visibleProperties, prop.id];
          changed = true;
        }
        if (changed) updatedViews.push({ ...view, config: nextConfig });
      }
      set((s) => ({
        propsByDb: { ...s.propsByDb, [dbId]: [...(s.propsByDb[dbId] ?? []), prop] },
        viewsByDb:
          updatedViews.length > 0
            ? {
                ...s.viewsByDb,
                [dbId]: (s.viewsByDb[dbId] ?? []).map(
                  (view) => updatedViews.find((updated) => updated.id === view.id) ?? view
                ),
              }
            : s.viewsByDb,
      }));
      cacheCurrentDatabaseMetadata(dbId);
      pendingPropertyCreate.set(prop.id, dbId);
      startBackgroundDurableCall({
        args: [prop as Partial<DbProperty>],
        fnKey: "createPropertyRemote",
        opKey: `create-property:${prop.id}`,
        userId: outboxUserId(),
        // A newly-created reciprocal relation points at the still-creating
        // primary relation, and a newly-created rollup can point at a
        // still-creating relation/target property. Sending those inserts in
        // parallel lets the dependent insert overtake its prerequisite and
        // leaves a one-sided relation or a missing rollup after reload. Ignore
        // only this property's own id; every other pending id in the record is a
        // real create dependency.
        waitsFor: () =>
          pendingDatabaseCreate.has(dbId) || valueReferencesPendingCreate(prop, prop.id),
        onSuccess: (result) => {
          pendingPropertyCreate.delete(prop.id);
          const persisted = result as DbProperty | undefined;
          if (persisted) {
            set((state) => ({
              propsByDb: {
                ...state.propsByDb,
                [dbId]: (state.propsByDb[dbId] ?? []).map((current) =>
                  current.id === prop.id ? { ...persisted, ...current } : current
                ),
              },
            }));
          }
          for (const optimisticView of updatedViews) {
            const currentView = get()
              .dbViews(dbId)
              .find((view) => view.id === optimisticView.id);
            if (!currentView) continue;
            void durableRemoteCall("updateViewRemote", [
              currentView.id,
              { config: currentView.config } as Partial<DbView>,
              dbId,
            ]).then((call) => {
              if (call.status === "ok") {
                publishDatabaseViewsMutation(dbId, "view_property_visibility_updated", [
                  currentView.id,
                ]);
              } else if (call.status === "dropped") {
                set((state) => ({
                  viewsByDb: {
                    ...state.viewsByDb,
                    [dbId]: (state.viewsByDb[dbId] ?? []).map((view) =>
                      view.id === currentView.id
                        ? { ...view, config: viewConfigWithoutProperty(view.config, prop.id) }
                        : view
                    ),
                  },
                }));
                void get()
                  .loadDatabase(dbId, { force: true, rows: false })
                  .catch(() => {});
              }
            });
          }
          publishDatabaseSchemaMutation(dbId, "property_created", [prop.id]);
          releaseOptimisticCreateDependents(prop.id);
        },
        onDrop: () => {
          pendingPropertyCreate.delete(prop.id);
          rollbackDependentWritesForFailedCreate(prop.id);
          set((state) => ({
            propsByDb: {
              ...state.propsByDb,
              [dbId]: (state.propsByDb[dbId] ?? []).filter((item) => item.id !== prop.id),
            },
            viewsByDb: {
              ...state.viewsByDb,
              [dbId]: (state.viewsByDb[dbId] ?? []).map((view) => ({
                ...view,
                config: viewConfigWithoutProperty(view.config, prop.id),
              })),
            },
          }));
          cacheCurrentDatabaseMetadata(dbId);
        },
      });
      // Back-fill sequential ids for a new unique_id property so existing rows aren't blank.
      if (type === "unique_id") {
        const existing = get().dbRows(dbId);
        existing.forEach((row, index) => {
          get().setRowProperty(row.id, prop.id, index + 1, { debounce: false });
        });
      }
      return prop;
    },

    updateProperty(id, patch) {
      const dbId = Object.keys(get().propsByDb).find((key) =>
        (get().propsByDb[key] ?? []).some((p) => p.id === id)
      );
      if (isDatabaseLocked(get().pagesById, dbId)) return;
      const prevType = dbId
        ? get().propsByDb[dbId]?.find((p) => p.id === id)?.type
        : undefined;
      const typeChanged = patch.type !== undefined && patch.type !== prevType;

      set((s) => {
        const next = { ...s.propsByDb };
        for (const db of Object.keys(next)) {
          const idx = next[db].findIndex((p) => p.id === id);
          if (idx >= 0) {
            const arr = next[db].slice();
            arr[idx] = { ...arr[idx], ...patch };
            next[db] = arr;
            break;
          }
        }
        return { propsByDb: next };
      });
      if (dbId) cacheCurrentDatabaseMetadata(dbId);
      // dbId is the routing hint (workspace-per-DO). It is derived from the same
      // cache the optimistic set above walked, so an unresolved dbId means the
      // edit already no-op'd locally — firing a hint-less remote mutation would
      // only 404. Persist only when we can route.
      if (dbId) {
        void durableRemoteCall("updatePropertyRemote", [id, patch as Partial<DbProperty>, dbId]).then(
          (call) => {
            if (call.status === "ok") publishDatabaseSchemaMutation(dbId, "property_updated", [id]);
            // Terminal rejection: reconcile the optimistic schema edit from the
            // server (refresh loops don't cover DB schema).
            if (call.status === "dropped") void get().loadDatabase(dbId, { force: true, rows: false });
          }
        );
      }

      if (typeChanged && dbId) {
        // A filter built for the old type has an operator/value that no longer
        // applies and would silently drop every row — remove those filters.
        const updatedViews: DbView[] = [];
        for (const view of get().dbViews(dbId)) {
          const config = viewConfigWithoutFilterProperty(view.config, id);
          if (configChanged(view.config, config)) updatedViews.push({ ...view, config });
        }
        if (updatedViews.length) {
          set((s) => ({
            viewsByDb: {
              ...s.viewsByDb,
              [dbId]: (s.viewsByDb[dbId] ?? []).map(
                (view) => updatedViews.find((u) => u.id === view.id) ?? view
              ),
            },
          }));
          for (const view of updatedViews) {
            void durableRemoteCall("updateViewRemote", [
              view.id,
              { config: view.config } as Partial<DbView>,
              view.databaseId,
            ]).then((call) => {
              if (call.status === "ok") {
                publishDatabaseViewsMutation(view.databaseId, "view_filter_type_guard_updated", [view.id]);
              }
              if (call.status === "dropped") {
                void get().loadDatabase(view.databaseId, { force: true, rows: false });
              }
            });
          }
        }
      }
    },

    async setRelationDatabase(id, targetDatabaseId) {
      const dbId = Object.keys(get().propsByDb).find((key) =>
        (get().propsByDb[key] ?? []).some((p) => p.id === id)
      );
      if (!dbId) return;
      const prop = get().dbProperties(dbId).find((item) => item.id === id);
      if (!prop || prop.type !== "relation") return;
      const currentTarget = prop.config?.relationDatabaseId ?? prop.databaseId;
      if (currentTarget === targetDatabaseId) return;
      const previousRelatedPropertyId = prop.config?.relatedPropertyId;
      const config: PropertyConfig = {
        ...(prop.config ?? {}),
        relationDatabaseId: targetDatabaseId,
        relatedPropertyId: undefined,
      };
      // Repointing a paired relation used to enqueue unlink, reciprocal delete,
      // and target update as three independent requests. A slower unlink could
      // overtake the new target and leave the old reciprocal orphaned. Persist a
      // single source update instead; the backend uses the previous pair id to
      // finish reciprocal cleanup idempotently, including after a retry.
      set((state) => ({
        propsByDb: {
          ...state.propsByDb,
          [dbId]: (state.propsByDb[dbId] ?? []).map((item) =>
            item.id === id ? { ...item, config } : item
          ),
        },
      }));
      if (previousRelatedPropertyId) {
        set((state) => withoutLoadedDatabaseProperty(state, currentTarget, previousRelatedPropertyId));
      }
      cacheCurrentDatabaseMetadata(dbId);
      if (previousRelatedPropertyId) cacheCurrentDatabaseMetadata(currentTarget);
      const call = await durableRemoteCall("updatePropertyRemote", [
        id,
        { config } as Partial<DbProperty>,
        dbId,
        previousRelatedPropertyId,
      ]);
      if (call.status === "ok") {
        publishDatabaseSchemaMutation(dbId, "property_updated", [id]);
        if (previousRelatedPropertyId) {
          publishDatabaseSchemaMutation(currentTarget, "property_deleted", [
            previousRelatedPropertyId,
          ]);
        }
      } else if (call.status === "dropped") {
        void get().loadDatabase(dbId, { force: true, rows: false });
        if (previousRelatedPropertyId) {
          void get().loadDatabase(currentTarget, { force: true, rows: true });
        }
      }
    },

    async setRelationTwoWay(id, enabled, reciprocalName) {
      const dbId = Object.keys(get().propsByDb).find((key) =>
        (get().propsByDb[key] ?? []).some((p) => p.id === id)
      );
      if (!dbId) return;
      assertDatabaseUnlocked(get().pagesById, dbId);
      const prop = get().dbProperties(dbId).find((item) => item.id === id);
      if (!prop || prop.type !== "relation") return;
      const targetDbId = prop.config?.relationDatabaseId ?? prop.databaseId;

      if (enabled) {
        if (prop.config?.relatedPropertyId) return; // already two-way
        // Load the target schema so the reciprocal lands with a correct position
        // and is added to that database's existing views.
        await get().loadDatabase(targetDbId, { rows: false }).catch(() => {});
        const targetProps = get().dbProperties(targetDbId);
        const sourceDb = get().pagesById[dbId];
        const baseName =
          (reciprocalName ?? "").trim() ||
          (sourceDb ? pageDisplayTitle(sourceDb) : "") ||
          "Related";
        const usedNames = new Set(targetProps.map((item) => item.name));
        let name = baseName;
        for (let i = 2; usedNames.has(name); i += 1) name = `${baseName} ${i}`;
        // Reuse addProperty so the reciprocal inherits view order/visibility and
        // durable-outbox handling; it is created already pointing back at `id`.
        const reciprocal = await get().addProperty(targetDbId, "relation", name, {
          relationDatabaseId: dbId,
          relatedPropertyId: id,
        });
        if (!reciprocal) return; // create was dropped; leave the primary one-way
        const fresh = get().dbProperties(dbId).find((item) => item.id === id);
        get().updateProperty(id, {
          config: { ...(fresh?.config ?? {}), relatedPropertyId: reciprocal.id },
        });
        return;
      }

      // Disable is one durable source mutation. The backend removes the exact
      // previous reciprocal before acknowledging success, and the previous id is
      // retained in the outbox payload so a retry can finish cleanup even when
      // the source unlink itself already committed.
      const reciprocalId = prop.config?.relatedPropertyId;
      const config: PropertyConfig = { ...(prop.config ?? {}), relatedPropertyId: undefined };
      set((state) => ({
        propsByDb: {
          ...state.propsByDb,
          [dbId]: (state.propsByDb[dbId] ?? []).map((item) =>
            item.id === id ? { ...item, config } : item
          ),
        },
      }));
      if (reciprocalId) {
        set((state) => withoutLoadedDatabaseProperty(state, targetDbId, reciprocalId));
      }
      cacheCurrentDatabaseMetadata(dbId);
      if (reciprocalId) cacheCurrentDatabaseMetadata(targetDbId);
      const call = await durableRemoteCall("updatePropertyRemote", [
        id,
        { config } as Partial<DbProperty>,
        dbId,
        reciprocalId,
      ]);
      if (call.status === "ok") {
        publishDatabaseSchemaMutation(dbId, "property_updated", [id]);
        if (reciprocalId) {
          publishDatabaseSchemaMutation(targetDbId, "property_deleted", [reciprocalId]);
        }
      } else if (call.status === "dropped") {
        void get().loadDatabase(dbId, { force: true, rows: false });
        if (reciprocalId) {
          void get().loadDatabase(targetDbId, { force: true, rows: true });
        }
      }
    },

    async deleteProperty(id, opts) {
      const dbId = Object.keys(get().propsByDb).find((key) =>
        (get().propsByDb[key] ?? []).some((prop) => prop.id === id)
      );
      if (!dbId) return null;
      assertDatabaseUnlocked(get().pagesById, dbId);
      const prop = get().dbProperties(dbId).find((item) => item.id === id);
      if (!prop || prop.type === "title") return null;

      // Two-way relations: the backend owns the reciprocal lifecycle (database-
      // mutation cascades the paired property's deletion), so we only forward the
      // request and pass skipReciprocal through. skipReciprocal is set for the
      // two-way→one-way teardown, where the caller deletes just the reciprocal and
      // keeps this side one-way. Optimistically drop the reciprocal from the
      // (possibly loaded) target database so its column disappears at once; the
      // backend cascade makes it durable and a reload reconciles any drift.
      if (!opts?.skipReciprocal && prop.type === "relation" && prop.config?.relatedPropertyId) {
        const targetDbId = prop.config.relationDatabaseId ?? prop.databaseId;
        const reciprocalId = prop.config.relatedPropertyId;
        set((s) => {
          const targetProps = s.propsByDb[targetDbId];
          if (!targetProps?.some((item) => item.id === reciprocalId)) return {};
          return {
            propsByDb: {
              ...s.propsByDb,
              [targetDbId]: targetProps.filter((item) => item.id !== reciprocalId),
            },
          };
        });
        cacheCurrentDatabaseMetadata(targetDbId);
      }

      const updatedRows: Page[] = [];
      const snapshotRows: DeletedPropertySnapshot["rows"] = [];
      for (const row of get().dbRows(dbId)) {
        if (!row.properties || !(id in row.properties)) continue;
        snapshotRows.push({ id: row.id, properties: cloneJson(row.properties) });
        const properties = { ...row.properties };
        delete properties[id];
        updatedRows.push({ ...row, properties });
      }

      const updatedViews: DbView[] = [];
      const snapshotViews: DeletedPropertySnapshot["views"] = [];
      for (const view of get().dbViews(dbId)) {
        const config = viewConfigWithoutProperty(view.config, id);
        if (configChanged(view.config, config)) {
          snapshotViews.push({ id: view.id, config: cloneJson(view.config) });
          updatedViews.push({ ...view, config });
        }
      }

      const updatedTemplates: DbTemplate[] = [];
      const snapshotTemplates: DeletedPropertySnapshot["templates"] = [];
      for (const template of get().dbTemplates(dbId)) {
        if (!template.properties || !(id in template.properties)) continue;
        snapshotTemplates.push({ id: template.id, properties: cloneJson(template.properties) });
        const properties = { ...template.properties };
        delete properties[id];
        updatedTemplates.push({ ...template, properties });
      }

      const originalProps = get().dbProperties(dbId);
      const updatedProps = originalProps
        .filter((item) => item.id !== id)
        .map((item) => {
          const config = { ...(item.config ?? {}) };
          let changed = false;
          if (config.rollupRelationPropertyId === id) {
            config.rollupRelationPropertyId = undefined;
            config.rollupTargetPropertyId = undefined;
            changed = true;
          }
          if (config.rollupTargetPropertyId === id) {
            config.rollupTargetPropertyId = undefined;
            changed = true;
          }
          return changed ? { ...item, config } : item;
        });
      const affectedPropUpdates = updatedProps.filter((item) =>
        configChanged(
          originalProps.find((existing) => existing.id === item.id)?.config,
          item.config
        )
      );
      const snapshotRelatedProperties: DeletedPropertySnapshot["relatedProperties"] =
        affectedPropUpdates.map((item) => ({
          id: item.id,
          config: cloneJson(originalProps.find((existing) => existing.id === item.id)?.config),
        }));

      for (const row of updatedRows) {
        const pending = pendingPage.get(row.id);
        if (pending?.properties && id in pending.properties) {
          const properties = { ...pending.properties };
          delete properties[id];
          pendingPage.set(row.id, { ...pending, properties });
          mirrorPendingPage(row.id);
        }
      }

      set((s) => {
        const propsByDb = { ...s.propsByDb, [dbId]: updatedProps };
        const viewsByDb =
          updatedViews.length > 0
            ? {
                ...s.viewsByDb,
                [dbId]: (s.viewsByDb[dbId] ?? []).map(
                  (view) => updatedViews.find((updated) => updated.id === view.id) ?? view
                ),
              }
            : s.viewsByDb;
        const templatesByDb =
          updatedTemplates.length > 0
            ? {
                ...s.templatesByDb,
                [dbId]: (s.templatesByDb[dbId] ?? []).map(
                  (template) =>
                    updatedTemplates.find((updated) => updated.id === template.id) ?? template
                ),
              }
            : s.templatesByDb;
        const pagesById = { ...s.pagesById };
        for (const row of updatedRows) pagesById[row.id] = row;
        return { propsByDb, viewsByDb, templatesByDb, pagesById };
      });
      cacheCurrentDatabaseMetadata(dbId);

      // The backend owns the whole tombstone + row/view/template cleanup now.
      // Sending the same dependent writes concurrently can race the tombstone
      // and produce false terminal failures, so persist one durable delete.
      const deleteCall = await durableRemoteCall("deletePropertyRemote", [
        id,
        dbId,
        opts?.skipReciprocal,
        prop.type === "relation" ? prop.config?.relatedPropertyId : undefined,
      ]);
      if (deleteCall.status === "dropped") {
        const status = persistErrorStatus(deleteCall.error);
        if (status !== 401 && status !== 403 && status !== 404) {
          for (const row of snapshotRows) {
            const pending = pendingPage.get(row.id);
            if (pending) {
              pendingPage.set(row.id, {
                ...pending,
                properties: {
                  ...(pending.properties ?? {}),
                  [id]: cloneJson(row.properties?.[id]),
                },
              });
              mirrorPendingPage(row.id);
            }
          }
          set((s) => {
            const propsByDb = {
              ...s.propsByDb,
              [dbId]: [...(s.propsByDb[dbId] ?? []), cloneJson(prop)].sort(bySortPos),
            };
            for (const related of snapshotRelatedProperties) {
              propsByDb[dbId] = propsByDb[dbId].map((candidate) =>
                candidate.id === related.id
                  && !configChanged(
                    candidate.config,
                    affectedPropUpdates.find((updated) => updated.id === related.id)?.config
                  )
                  ? { ...candidate, config: cloneJson(related.config) }
                  : candidate
              );
            }
            const pagesById = { ...s.pagesById };
            for (const row of snapshotRows) {
              const current = pagesById[row.id];
              if (current) {
                pagesById[row.id] = {
                  ...current,
                  properties: {
                    ...(current.properties ?? {}),
                    [id]: cloneJson(row.properties?.[id]),
                  },
                };
              }
            }
            return {
              propsByDb,
              pagesById,
              viewsByDb: {
                ...s.viewsByDb,
                [dbId]: (s.viewsByDb[dbId] ?? []).map((view) => {
                  const original = snapshotViews.find((item) => item.id === view.id);
                  const deleted = updatedViews.find((item) => item.id === view.id);
                  return original && deleted && !configChanged(view.config, deleted.config)
                    ? { ...view, config: cloneJson(original.config) }
                    : view;
                }),
              },
              templatesByDb: {
                ...s.templatesByDb,
                [dbId]: (s.templatesByDb[dbId] ?? []).map((template) => {
                  const original = snapshotTemplates.find((item) => item.id === template.id);
                  return original
                    ? {
                        ...template,
                        properties: {
                          ...(template.properties ?? {}),
                          [id]: cloneJson(original.properties?.[id]),
                        },
                      }
                    : template;
                }),
              },
            };
          });
        }
        await get().loadDatabase(dbId, { force: true, rows: true }).catch(() => {});
        return null;
      }
      if (deleteCall.status === "ok") {
        publishDatabaseSchemaMutation(dbId, "property_deleted", [
          id,
          ...affectedPropUpdates.map((item) => item.id),
        ]);
        if (updatedRows.length > 0) publishDatabaseRowsMutation(dbId, "property_deleted_rows_updated", updatedRows.map((row) => row.id));
        if (updatedViews.length > 0) publishDatabaseViewsMutation(dbId, "property_deleted_views_updated", updatedViews.map((view) => view.id));
        if (updatedTemplates.length > 0) publishDatabaseTemplatesMutation(dbId, "property_deleted_templates_updated");
      }
      return {
        dbId,
        property: cloneJson(prop),
        rows: snapshotRows,
        views: snapshotViews,
        templates: snapshotTemplates,
        relatedProperties: snapshotRelatedProperties,
      };
    },

    async restoreDeletedProperty(snapshot) {
      if (!CLIENT_SCHEMA_RESTORE_ENABLED) return false;
      const { dbId } = snapshot;
      if (isDatabaseLocked(get().pagesById, dbId)) return false;
      if (get().dbProperties(dbId).some((prop) => prop.id === snapshot.property.id)) return false;

      const existingRows = snapshot.rows.filter((row) => !!get().pagesById[row.id]);
      const existingViewIds = new Set(get().dbViews(dbId).map((view) => view.id));
      const existingTemplateIds = new Set(get().dbTemplates(dbId).map((template) => template.id));
      const existingPropIds = new Set(get().dbProperties(dbId).map((prop) => prop.id));
      const restoredViews = snapshot.views.filter((view) => existingViewIds.has(view.id));
      const restoredTemplates = snapshot.templates.filter((template) => existingTemplateIds.has(template.id));
      const restoredRelatedProperties = snapshot.relatedProperties.filter((prop) => existingPropIds.has(prop.id));

      for (const row of existingRows) {
        const pending = pendingPage.get(row.id);
        if (pending) {
          pendingPage.set(row.id, { ...pending, properties: cloneJson(row.properties) });
          mirrorPendingPage(row.id);
        }
      }

      set((s) => {
        const propsByDb = {
          ...s.propsByDb,
          [dbId]: [...(s.propsByDb[dbId] ?? []), cloneJson(snapshot.property)].sort(bySortPos),
        };
        for (const related of restoredRelatedProperties) {
          propsByDb[dbId] = propsByDb[dbId].map((prop) =>
            prop.id === related.id ? { ...prop, config: cloneJson(related.config) } : prop
          );
        }
        const pagesById = { ...s.pagesById };
        for (const row of existingRows) {
          const page = pagesById[row.id];
          if (page) pagesById[row.id] = { ...page, properties: cloneJson(row.properties) };
        }
        const viewsByDb =
          restoredViews.length > 0
            ? {
                ...s.viewsByDb,
                [dbId]: (s.viewsByDb[dbId] ?? []).map((view) => {
                  const restored = restoredViews.find((item) => item.id === view.id);
                  return restored ? { ...view, config: cloneJson(restored.config) } : view;
                }),
              }
            : s.viewsByDb;
        const templatesByDb =
          restoredTemplates.length > 0
            ? {
                ...s.templatesByDb,
                [dbId]: (s.templatesByDb[dbId] ?? []).map((template) => {
                  const restored = restoredTemplates.find((item) => item.id === template.id);
                  return restored ? { ...template, properties: cloneJson(restored.properties) } : template;
                }),
              }
            : s.templatesByDb;
        return { propsByDb, pagesById, viewsByDb, templatesByDb };
      });

      // Recreate the schema row first. A pending backend tombstone owns the same
      // id and must be cancelled before row/template file references can be
      // restored; starting every request concurrently can strand that marker.
      const propertyRestoreCall = await durableRemoteCall(
        "createPropertyRemote",
        [snapshot.property as Partial<DbProperty>]
      );
      if (propertyRestoreCall.status === "dropped") {
        for (const row of existingRows) {
          const pending = pendingPage.get(row.id);
          if (pending?.properties && snapshot.property.id in pending.properties) {
            const properties = { ...pending.properties };
            delete properties[snapshot.property.id];
            pendingPage.set(row.id, { ...pending, properties });
            mirrorPendingPage(row.id);
          }
        }
        set((s) => {
          const propsByDb = {
            ...s.propsByDb,
            [dbId]: (s.propsByDb[dbId] ?? [])
              .filter((prop) => prop.id !== snapshot.property.id)
              .map((prop) => {
                const config = { ...(prop.config ?? {}) };
                if (config.rollupRelationPropertyId === snapshot.property.id) {
                  config.rollupRelationPropertyId = undefined;
                  config.rollupTargetPropertyId = undefined;
                }
                if (config.rollupTargetPropertyId === snapshot.property.id) {
                  config.rollupTargetPropertyId = undefined;
                }
                return { ...prop, config };
              }),
          };
          const pagesById = { ...s.pagesById };
          for (const row of existingRows) {
            const current = pagesById[row.id];
            if (!current?.properties || !(snapshot.property.id in current.properties)) continue;
            const properties = { ...current.properties };
            delete properties[snapshot.property.id];
            pagesById[row.id] = { ...current, properties };
          }
          return {
            propsByDb,
            pagesById,
            viewsByDb: {
              ...s.viewsByDb,
              [dbId]: (s.viewsByDb[dbId] ?? []).map((view) => ({
                ...view,
                config: viewConfigWithoutProperty(view.config, snapshot.property.id),
              })),
            },
            templatesByDb: {
              ...s.templatesByDb,
              [dbId]: (s.templatesByDb[dbId] ?? []).map((template) => {
                const properties = { ...(template.properties ?? {}) };
                delete properties[snapshot.property.id];
                return { ...template, properties };
              }),
            },
          };
        });
        return false;
      }
      const dependentRestoreCalls = await Promise.all([
        ...existingRows.map((row) =>
          durableRemoteCall("updatePageRemote", [
            row.id,
            { properties: persistableRowProperties(row) } as Partial<Page>,
          ])
        ),
        ...restoredViews.map((view) =>
          durableRemoteCall("updateViewRemote", [
            view.id,
            { config: view.config } as Partial<DbView>,
            dbId,
          ])
        ),
        ...restoredTemplates.map((template) =>
          durableRemoteCall("updateTemplateRemote", [
            template.id,
            { properties: template.properties } as Partial<DbTemplate>,
            dbId,
          ])
        ),
        ...restoredRelatedProperties.map((prop) =>
          durableRemoteCall("updatePropertyRemote", [
            prop.id,
            { config: prop.config } as Partial<DbProperty>,
            dbId,
          ])
        ),
      ]);
      const restoreCalls = [propertyRestoreCall, ...dependentRestoreCalls];
      if (dependentRestoreCalls.some((call) => call.status === "dropped")) {
        await get().loadDatabase(dbId, { force: true, rows: true }).catch(() => {});
        return false;
      }
      if (restoreCalls.every((call) => call.status === "ok")) {
        publishDatabaseSchemaMutation(dbId, "property_restored", [
          snapshot.property.id,
          ...restoredRelatedProperties.map((prop) => prop.id),
        ]);
        if (existingRows.length > 0) publishDatabaseRowsMutation(dbId, "property_restored_rows_updated", existingRows.map((row) => row.id));
        if (restoredViews.length > 0) publishDatabaseViewsMutation(dbId, "property_restored_views_updated", restoredViews.map((view) => view.id));
        if (restoredTemplates.length > 0) publishDatabaseTemplatesMutation(dbId, "property_restored_templates_updated");
      }
      return true;
    },

    async deletePropertyOption(propertyId, optionId) {
      if (!CLIENT_PROPERTY_OPTION_DELETE_ENABLED) return null;
      const dbId = Object.keys(get().propsByDb).find((key) =>
        (get().propsByDb[key] ?? []).some((prop) => prop.id === propertyId)
      );
      if (!dbId || isDatabaseLocked(get().pagesById, dbId)) return null;
      const prop = get().dbProperties(dbId).find((item) => item.id === propertyId);
      const options = prop?.config?.options ?? [];
      const optionIndex = options.findIndex((option) => option.id === optionId);
      if (!prop || optionIndex < 0) return null;

      const option = options[optionIndex];
      const config: PropertyConfig = {
        ...(prop.config ?? {}),
        options: options.filter((item) => item.id !== optionId),
      };
      const updatedProp = { ...prop, config };
      const updatedRows: Page[] = [];
      const snapshotRows: DeletedPropertyOptionSnapshot["rows"] = [];
      const isMulti = prop.type === "multi_select";

      for (const row of get().dbRows(dbId)) {
        const raw = row.properties?.[propertyId];
        if (isMulti) {
          const ids = Array.isArray(raw) ? raw.map(String) : [];
          if (!ids.includes(optionId)) continue;
          snapshotRows.push({ id: row.id, value: cloneJson(raw) });
          updatedRows.push({
            ...row,
            properties: { ...(row.properties ?? {}), [propertyId]: ids.filter((id) => id !== optionId) },
          });
        } else if (String(raw ?? "") === optionId) {
          snapshotRows.push({ id: row.id, value: cloneJson(raw) });
          updatedRows.push({ ...row, properties: { ...(row.properties ?? {}), [propertyId]: null } });
        }
      }

      for (const row of updatedRows) {
        const pending = pendingPage.get(row.id);
        if (pending) {
          pendingPage.set(row.id, { ...pending, properties: cloneJson(row.properties) });
          mirrorPendingPage(row.id);
        }
      }

      set((s) => {
        const propsByDb = {
          ...s.propsByDb,
          [dbId]: (s.propsByDb[dbId] ?? []).map((item) => (item.id === propertyId ? updatedProp : item)),
        };
        const pagesById = { ...s.pagesById };
        for (const row of updatedRows) pagesById[row.id] = row;
        return { propsByDb, pagesById };
      });

      const propertyCall = await durableRemoteCall("updatePropertyRemote", [
        propertyId,
        { config } as Partial<DbProperty>,
        dbId,
      ]);
      if (propertyCall.status === "dropped") {
        set((s) => ({
          propsByDb: {
            ...s.propsByDb,
            [dbId]: (s.propsByDb[dbId] ?? []).map((current) => {
              if (current.id !== propertyId) return current;
              const currentOptions = current.config?.options ?? [];
              if (currentOptions.some((item) => item.id === optionId)) return current;
              const insertAt = Math.max(0, Math.min(optionIndex, currentOptions.length));
              return {
                ...current,
                config: {
                  ...(current.config ?? {}),
                  options: [
                    ...currentOptions.slice(0, insertAt),
                    cloneJson(option),
                    ...currentOptions.slice(insertAt),
                  ],
                },
              };
            }),
          },
        }));
        for (const row of updatedRows) {
          const previous = snapshotRows.find((item) => item.id === row.id);
          if (!previous) continue;
          rollbackOptimisticRowProperty(
            row.id,
            propertyId,
            row.properties?.[propertyId],
            { [propertyId]: previous.value }
          );
        }
        return null;
      }

      const rowCalls = await Promise.all(
        updatedRows.map((row) =>
          durableRemoteCall("updatePageRemote", [
            row.id,
            { properties: persistableRowProperties(row) } as Partial<Page>,
          ])
        )
      );
      const droppedRowIndexes = rowCalls.flatMap((call, index) =>
        call.status === "dropped" ? [index] : []
      );
      for (const index of droppedRowIndexes) {
        const row = updatedRows[index]!;
        const previous = snapshotRows.find((item) => item.id === row.id);
        if (!previous) continue;
        rollbackOptimisticRowProperty(
          row.id,
          propertyId,
          row.properties?.[propertyId],
          { [propertyId]: previous.value }
        );
      }
      if (
        droppedRowIndexes.length > 0 &&
        propertyCall.status === "ok" &&
        rowCalls.every((call) => call.status !== "queued")
      ) {
        await get().loadDatabase(dbId, { force: true, rows: true }).catch(() => {});
      }
      if (propertyCall.status === "ok" && rowCalls.every((call) => call.status === "ok")) {
        publishDatabaseSchemaMutation(dbId, "property_option_deleted", [propertyId]);
        if (updatedRows.length > 0) publishDatabaseRowsMutation(dbId, "property_option_deleted_rows_updated", updatedRows.map((row) => row.id));
      }
      if (droppedRowIndexes.length > 0) return null;
      return { dbId, propertyId, option: cloneJson(option), optionIndex, rows: snapshotRows };
    },

    async restoreDeletedPropertyOption(snapshot) {
      if (!CLIENT_SCHEMA_RESTORE_ENABLED) return false;
      const { dbId, propertyId } = snapshot;
      if (isDatabaseLocked(get().pagesById, dbId)) return false;
      const prop = get().dbProperties(dbId).find((item) => item.id === propertyId);
      if (!prop) return false;
      const options = prop.config?.options ?? [];
      if (options.some((option) => option.id === snapshot.option.id)) return false;
      const optionIndex = Math.max(0, Math.min(snapshot.optionIndex, options.length));
      const restoredOption = cloneJson(snapshot.option);
      const config: PropertyConfig = {
        ...(prop.config ?? {}),
        options: [
          ...options.slice(0, optionIndex),
          restoredOption,
          ...options.slice(optionIndex),
        ],
      };
      const updatedProp = { ...prop, config };
      const existingRows = snapshot.rows.filter((row) => !!get().pagesById[row.id]);
      const previousRowProperties = new Map(
        existingRows.map((row) => [
          row.id,
          cloneJson(get().pagesById[row.id]?.properties ?? {}),
        ])
      );

      for (const row of existingRows) {
        const pending = pendingPage.get(row.id);
        if (pending) {
          pendingPage.set(row.id, {
            ...pending,
            properties: { ...(pending.properties ?? get().pagesById[row.id]?.properties ?? {}), [propertyId]: cloneJson(row.value) },
          });
          mirrorPendingPage(row.id);
        }
      }

      set((s) => {
        const propsByDb = {
          ...s.propsByDb,
          [dbId]: (s.propsByDb[dbId] ?? []).map((item) => (item.id === propertyId ? updatedProp : item)),
        };
        const pagesById = { ...s.pagesById };
        for (const row of existingRows) {
          const page = pagesById[row.id];
          if (!page) continue;
          pagesById[row.id] = {
            ...page,
            properties: { ...(page.properties ?? {}), [propertyId]: cloneJson(row.value) },
          };
        }
        return { propsByDb, pagesById };
      });

      const propertyCall = await durableRemoteCall("updatePropertyRemote", [
        propertyId,
        { config } as Partial<DbProperty>,
        dbId,
      ]);
      if (propertyCall.status === "dropped") {
        set((s) => ({
          propsByDb: {
            ...s.propsByDb,
            [dbId]: (s.propsByDb[dbId] ?? []).map((current) =>
              current.id === propertyId
                ? {
                    ...current,
                    config: {
                      ...(current.config ?? {}),
                      options: (current.config?.options ?? []).filter(
                        (item) => item.id !== restoredOption.id
                      ),
                    },
                  }
                : current
            ),
          },
        }));
        for (const row of existingRows) {
          rollbackOptimisticRowProperty(
            row.id,
            propertyId,
            row.value,
            previousRowProperties.get(row.id) ?? {}
          );
        }
        return false;
      }

      const rowCalls = await Promise.all(
        existingRows.map((row) => {
          const page = get().pagesById[row.id];
          return durableRemoteCall("updatePageRemote", [
            row.id,
            { properties: page ? persistableRowProperties(page) : {} } as Partial<Page>,
          ]);
        })
      );
      const droppedRowIndexes = rowCalls.flatMap((call, index) =>
        call.status === "dropped" ? [index] : []
      );
      for (const index of droppedRowIndexes) {
        const row = existingRows[index]!;
        rollbackOptimisticRowProperty(
          row.id,
          propertyId,
          row.value,
          previousRowProperties.get(row.id) ?? {}
        );
      }
      if (
        droppedRowIndexes.length > 0 &&
        propertyCall.status === "ok" &&
        rowCalls.every((call) => call.status !== "queued")
      ) {
        await get().loadDatabase(dbId, { force: true, rows: true }).catch(() => {});
      }
      if (propertyCall.status === "ok" && rowCalls.every((call) => call.status === "ok")) {
        publishDatabaseSchemaMutation(dbId, "property_option_restored", [propertyId]);
        if (existingRows.length > 0) publishDatabaseRowsMutation(dbId, "property_option_restored_rows_updated", existingRows.map((row) => row.id));
      }
      if (droppedRowIndexes.length > 0) return false;
      return true;
    },

    async addView(dbId, type, name, opts) {
      assertDatabaseUnlocked(get().pagesById, dbId);
      const existing = get().dbViews(dbId);
      const view: DbView = {
        id: newId(),
        databaseId: dbId,
        name: name ?? type[0].toUpperCase() + type.slice(1),
        type,
        position: opts?.position ?? positionBetween(existing[existing.length - 1]?.position, undefined),
        config: opts?.config ?? {},
      };
      set((s) => ({
        viewsByDb: { ...s.viewsByDb, [dbId]: [...(s.viewsByDb[dbId] ?? []), view] },
      }));
      cacheCurrentDatabaseMetadata(dbId);
      pendingViewCreate.set(view.id, dbId);
      startBackgroundDurableCall({
        args: [view as Partial<DbView>],
        fnKey: "createViewRemote",
        opKey: `create-view:${view.id}`,
        userId: outboxUserId(),
        waitsFor: () => pendingDatabaseCreate.has(dbId),
        onSuccess: (result) => {
          pendingViewCreate.delete(view.id);
          const persisted = result as DbView | undefined;
          if (persisted) {
            set((state) => ({
              viewsByDb: {
                ...state.viewsByDb,
                [dbId]: (state.viewsByDb[dbId] ?? []).map((current) =>
                  current.id === view.id ? { ...persisted, ...current } : current
                ),
              },
            }));
          }
          publishDatabaseViewsMutation(dbId, "view_created", [view.id]);
          releaseOptimisticCreateDependents(view.id);
        },
        onDrop: () => {
          pendingViewCreate.delete(view.id);
          set((state) => ({
            viewsByDb: {
              ...state.viewsByDb,
              [dbId]: (state.viewsByDb[dbId] ?? []).filter((item) => item.id !== view.id),
            },
          }));
          cacheCurrentDatabaseMetadata(dbId);
        },
      });
      return view;
    },

    updateView(id, patch) {
      const dbId = Object.keys(get().viewsByDb).find((key) =>
        (get().viewsByDb[key] ?? []).some((view) => view.id === id)
      );
      if (isDatabaseLocked(get().pagesById, dbId)) return;
      set((s) => {
        const next = { ...s.viewsByDb };
        for (const db of Object.keys(next)) {
          const idx = next[db].findIndex((v) => v.id === id);
          if (idx >= 0) {
            const arr = next[db].slice();
            arr[idx] = { ...arr[idx], ...patch };
            next[db] = arr;
            break;
          }
        }
        return { viewsByDb: next };
      });
      // Routing hint derived from viewsByDb (see updateProperty): only persist
      // when the view resolves to a database, else the mutation can't be routed.
      if (dbId) {
        const callPromise = durableRemoteCall("updateViewRemote", [id, patch as Partial<DbView>, dbId]);
        // The durable call is already in the outbox. Mirror the optimistic view
        // set into the record cache as well so a reload cannot hydrate the
        // pre-edit config while that call lands or waits for retry.
        cacheCurrentDatabaseMetadata(dbId);
        void callPromise.then(
          (call) => {
            if (call.status === "ok") publishDatabaseViewsMutation(dbId, "view_updated", [id]);
            // Terminal rejection: reconcile the optimistic view edit from the
            // server (refresh loops don't cover DB schema).
            if (call.status === "dropped") void get().loadDatabase(dbId, { force: true, rows: false });
          }
        );
      }
    },

    async deleteView(id) {
      const dbId = Object.keys(get().viewsByDb).find((key) =>
        (get().viewsByDb[key] ?? []).some((view) => view.id === id)
      );
      if (!dbId || isDatabaseLocked(get().pagesById, dbId)) return null;
      const snapshot = get().viewsByDb[dbId]?.find((view) => view.id === id);
      if (!snapshot) return null;
      set((s) => {
        const next = { ...s.viewsByDb, [dbId]: (s.viewsByDb[dbId] ?? []).filter((v) => v.id !== id) };
        return { viewsByDb: next };
      });
      cacheCurrentDatabaseMetadata(dbId);
      const call = await durableRemoteCall("deleteViewRemote", [id, dbId]);
      if (call.status === "dropped") {
        set((s) => ({
          viewsByDb: {
            ...s.viewsByDb,
            [dbId]: (s.viewsByDb[dbId] ?? []).some((view) => view.id === snapshot.id)
              ? s.viewsByDb[dbId] ?? []
              : [...(s.viewsByDb[dbId] ?? []), cloneJson(snapshot)].sort(bySortPos),
          },
        }));
        cacheCurrentDatabaseMetadata(dbId);
        await get().loadDatabase(dbId, { force: true, rows: false }).catch(() => {});
        return null;
      }
      if (call.status === "ok") publishDatabaseViewsMutation(dbId, "view_deleted", [id]);
      return cloneJson(snapshot);
    },

    async restoreDeletedView(view) {
      const dbId = view.databaseId;
      if (!get().pagesById[dbId] || isDatabaseLocked(get().pagesById, dbId)) return false;
      if (get().dbViews(dbId).some((existing) => existing.id === view.id)) return false;
      const restored = cloneJson(view);
      set((s) => ({
        viewsByDb: {
          ...s.viewsByDb,
          [dbId]: [...(s.viewsByDb[dbId] ?? []), restored].sort(bySortPos),
        },
      }));
      cacheCurrentDatabaseMetadata(dbId);
      const call = await durableRemoteCall("createViewRemote", [restored as Partial<DbView>]);
      if (call.status === "dropped") {
        set((s) => ({
          viewsByDb: {
            ...s.viewsByDb,
            [dbId]: (s.viewsByDb[dbId] ?? []).filter((item) => item.id !== restored.id),
          },
        }));
        cacheCurrentDatabaseMetadata(dbId);
        await get().loadDatabase(dbId, { force: true, rows: false }).catch(() => {});
        return false;
      }
      if (call.status === "ok") publishDatabaseViewsMutation(dbId, "view_restored", [restored.id]);
      return true;
    },

    async addTemplate(dbId, name = "") {
      assertDatabaseUnlocked(get().pagesById, dbId);
      const templates = get().dbTemplates(dbId);
      const template: DbTemplate = {
        id: newId(),
        databaseId: dbId,
        name,
        title: "",
        properties: {},
        blocks: [{ type: "paragraph", content: { rich: [] } }],
        isDefault: false,
        position: positionBetween(templates[templates.length - 1]?.position, undefined),
      };
      set((s) => ({
        templatesByDb: {
          ...s.templatesByDb,
          [dbId]: [...(s.templatesByDb[dbId] ?? []), template].sort(bySortPos),
        },
      }));
      cacheCurrentDatabaseMetadata(dbId);
      persistOptimisticTemplateCreate(template, "template_created");
      return template;
    },

    async duplicateTemplate(id) {
      let dbId = "";
      let source: DbTemplate | undefined;
      for (const [candidateDbId, templates] of Object.entries(get().templatesByDb)) {
        source = templates.find((template) => template.id === id);
        if (!source) continue;
        dbId = candidateDbId;
        break;
      }
      if (!dbId || !source) return null;
      assertDatabaseUnlocked(get().pagesById, dbId);
      if (hasDatabaseTemplateStoredFileReference(source, get().dbProperties(dbId))) {
        return null;
      }

      const templates = get().dbTemplates(dbId);
      const index = templates.findIndex((template) => template.id === id);
      const nextPosition = templates[index + 1]?.position;
      const sourceName = source.name.trim();
      const copySourceName = sourceName || i18next.t("databaseView:newTemplate");
      const copy: DbTemplate = {
        id: newId(),
        databaseId: source.databaseId,
        name: i18next.t("databaseView:copyName", { name: copySourceName }),
        icon: source.icon,
        title: templateTitleValue(source),
        properties: cloneJson(source.properties ?? {}),
        blocks: cloneJson(source.blocks ?? [{ type: "paragraph", content: { rich: [] } }]),
        isDefault: false,
        position: positionBetween(source.position, nextPosition),
      };

      set((s) => ({
        templatesByDb: {
          ...s.templatesByDb,
          [dbId]: [...(s.templatesByDb[dbId] ?? []), copy].sort(bySortPos),
        },
      }));
      cacheCurrentDatabaseMetadata(dbId);
      persistOptimisticTemplateCreate(copy, "template_duplicated");
      return copy;
    },

    async updateTemplate(id, patch) {
      const targetDbId = Object.keys(get().templatesByDb).find((key) =>
        (get().templatesByDb[key] ?? []).some((template) => template.id === id)
      );
      if (isDatabaseLocked(get().pagesById, targetDbId)) return false;
      let dbId = "";
      let previousDefaults: string[] = [];
      let beforeTemplates: DbTemplate[] = [];
      let optimisticTemplates: DbTemplate[] = [];
      set((s) => {
        const templatesByDb = { ...s.templatesByDb };
        for (const [candidateDbId, templates] of Object.entries(templatesByDb)) {
          const index = templates.findIndex((template) => template.id === id);
          if (index < 0) continue;
          dbId = candidateDbId;
          beforeTemplates = templates.map((template) => cloneJson(template));
          const next = templates.map((template, itemIndex) => {
            if (patch.isDefault && template.id !== id && template.isDefault) {
              previousDefaults = [...previousDefaults, template.id];
              return { ...template, isDefault: false };
            }
            if (itemIndex !== index) return template;
            return { ...template, ...patch };
          });
          optimisticTemplates = next.sort(bySortPos);
          templatesByDb[candidateDbId] = optimisticTemplates;
          break;
        }
        return { templatesByDb };
      });
      if (!dbId) return false;
      cacheCurrentDatabaseMetadata(dbId);

      // Persist the selected template before clearing the prior default(s). A
      // primary terminal rejection must not strand the database with no default.
      const primaryCall = await durableRemoteCall("updateTemplateRemote", [
        id,
        patch as Partial<DbTemplate>,
        dbId,
      ]);
      if (primaryCall.status === "dropped") {
        const patchFields = new Set<keyof DbTemplate>(Object.keys(patch) as Array<keyof DbTemplate>);
        patchFields.add("isDefault");
        set((s) => ({
          templatesByDb: {
            ...s.templatesByDb,
            [dbId]: (s.templatesByDb[dbId] ?? []).map((current) => {
              const before = beforeTemplates.find((template) => template.id === current.id);
              const optimistic = optimisticTemplates.find((template) => template.id === current.id);
              return before && optimistic
                ? rollbackMatchingFields(current, optimistic, before, patchFields)
                : current;
            }),
          },
        }));
        cacheCurrentDatabaseMetadata(dbId);
        await get().loadDatabase(dbId, { force: true, rows: false }).catch(() => {});
        return false;
      }

      const secondaryCalls = patch.isDefault
        ? await Promise.all(
            previousDefaults.map((previousId) =>
              durableRemoteCall("updateTemplateRemote", [
                previousId,
                { isDefault: false },
                dbId,
              ])
            )
          )
        : [];
      const droppedPreviousDefaults = new Set(
        secondaryCalls.flatMap((call, index) =>
          call.status === "dropped" ? [previousDefaults[index]!] : []
        )
      );
      if (droppedPreviousDefaults.size > 0) {
        set((s) => ({
          templatesByDb: {
            ...s.templatesByDb,
            [dbId]: (s.templatesByDb[dbId] ?? []).map((current) => {
              if (!droppedPreviousDefaults.has(current.id)) return current;
              const before = beforeTemplates.find((template) => template.id === current.id);
              const optimistic = optimisticTemplates.find((template) => template.id === current.id);
              return before &&
                optimistic &&
                current.isDefault === optimistic.isDefault
                ? { ...current, isDefault: before.isDefault }
                : current;
            }),
          },
        }));
        cacheCurrentDatabaseMetadata(dbId);
        if (
          primaryCall.status === "ok" &&
          secondaryCalls.every((call) => call.status !== "queued")
        ) {
          await get().loadDatabase(dbId, { force: true, rows: false }).catch(() => {});
        }
        return false;
      }

      if (primaryCall.status === "ok") {
        publishDatabaseTemplatesMutation(dbId, "template_updated");
      }
      if (secondaryCalls.some((call) => call.status === "ok")) {
        publishDatabaseTemplatesMutation(dbId, "template_default_updated");
      }
      return true;
    },

    async deleteTemplate(id) {
      const dbId = Object.keys(get().templatesByDb).find((key) =>
        (get().templatesByDb[key] ?? []).some((template) => template.id === id)
      );
      if (!dbId || isDatabaseLocked(get().pagesById, dbId)) return null;
      const snapshot = get().templatesByDb[dbId]?.find((template) => template.id === id);
      if (!snapshot) return null;
      set((s) => {
        const templatesByDb = { ...s.templatesByDb };
        templatesByDb[dbId] = (templatesByDb[dbId] ?? []).filter((template) => template.id !== id);
        return { templatesByDb };
      });
      cacheCurrentDatabaseMetadata(dbId);
      const call = await durableRemoteCall("deleteTemplateRemote", [id, dbId]);
      if (call.status === "dropped") {
        set((s) => ({
          templatesByDb: {
            ...s.templatesByDb,
            [dbId]: (s.templatesByDb[dbId] ?? []).some(
              (template) => template.id === snapshot.id
            )
              ? s.templatesByDb[dbId] ?? []
              : [...(s.templatesByDb[dbId] ?? []), cloneJson(snapshot)].sort(bySortPos),
          },
        }));
        cacheCurrentDatabaseMetadata(dbId);
        await get().loadDatabase(dbId, { force: true, rows: false }).catch(() => {});
        return null;
      }
      if (call.status === "ok") publishDatabaseTemplatesMutation(dbId, "template_deleted");
      return cloneJson(snapshot);
    },

    async restoreDeletedTemplate(template) {
      const dbId = template.databaseId;
      if (!get().pagesById[dbId] || isDatabaseLocked(get().pagesById, dbId)) return false;
      if (get().dbTemplates(dbId).some((existing) => existing.id === template.id)) return false;
      const restored = cloneJson(template);
      let previousDefaults: string[] = [];
      const beforeTemplates = get().dbTemplates(dbId).map((item) => cloneJson(item));
      set((s) => {
        const current = s.templatesByDb[dbId] ?? [];
        const next = restored.isDefault
          ? current.map((item) => {
              if (item.isDefault) previousDefaults = [...previousDefaults, item.id];
              return item.isDefault ? { ...item, isDefault: false } : item;
            })
          : current;
        return {
          templatesByDb: {
            ...s.templatesByDb,
            [dbId]: [...next, restored].sort(bySortPos),
          },
        };
      });
      cacheCurrentDatabaseMetadata(dbId);
      const createCall = await durableRemoteCall("createTemplateRemote", [
        restored as Partial<DbTemplate>,
      ]);
      if (createCall.status === "dropped") {
        set((s) => ({
          templatesByDb: {
            ...s.templatesByDb,
            [dbId]: (s.templatesByDb[dbId] ?? [])
              .filter((item) => item.id !== restored.id)
              .map((current) => {
                const before = beforeTemplates.find((item) => item.id === current.id);
                return before && current.isDefault === false && before.isDefault
                  ? { ...current, isDefault: true }
                  : current;
              }),
          },
        }));
        cacheCurrentDatabaseMetadata(dbId);
        await get().loadDatabase(dbId, { force: true, rows: false }).catch(() => {});
        return false;
      }

      const secondaryCalls = await Promise.all(
        previousDefaults.map((id) =>
          durableRemoteCall("updateTemplateRemote", [id, { isDefault: false }, dbId])
        )
      );
      const droppedPreviousDefaults = new Set(
        secondaryCalls.flatMap((call, index) =>
          call.status === "dropped" ? [previousDefaults[index]!] : []
        )
      );
      if (droppedPreviousDefaults.size > 0) {
        set((s) => ({
          templatesByDb: {
            ...s.templatesByDb,
            [dbId]: (s.templatesByDb[dbId] ?? []).map((current) => {
              if (!droppedPreviousDefaults.has(current.id)) return current;
              const before = beforeTemplates.find((item) => item.id === current.id);
              return before && current.isDefault === false
                ? { ...current, isDefault: before.isDefault }
                : current;
            }),
          },
        }));
        cacheCurrentDatabaseMetadata(dbId);
        if (
          createCall.status === "ok" &&
          secondaryCalls.every((call) => call.status !== "queued")
        ) {
          await get().loadDatabase(dbId, { force: true, rows: false }).catch(() => {});
        }
        return false;
      }
      if (createCall.status === "ok" && secondaryCalls.every((call) => call.status === "ok")) {
        publishDatabaseTemplatesMutation(dbId, "template_restored");
      }
      return true;
    },

    async addRow(dbId, atEnd = true, templateId, opts) {
      assertDatabaseUnlocked(get().pagesById, dbId);
      const ws = get().workspace;
      if (!ws) throw new Error("no workspace");
      const userId = get().userId || (await ensureAuth());
      if (userId && userId !== get().userId) set({ userId });
      if (!canCreatePageInState(get(), dbId, userId)) {
        throw new Error("Page access required.");
      }
      const originHref = currentRelativeRouteHref();
      const rows = get().dbRows(dbId);
      const templates = get().dbTemplates(dbId);
      const template =
        templateId === ""
          ? undefined
          : templateId
            ? templates.find((item) => item.id === templateId)
            : templates.find((item) => item.isDefault);
      if (
        template &&
        hasDatabaseTemplateStoredFileReference(template, get().dbProperties(dbId))
      ) {
        throw new Error("Database templates containing stored files cannot be applied yet.");
      }
      const id = newId();
      const now = nowIso();
      // Auto-assign values for any unique_id properties (max existing + 1).
      const properties: Record<string, unknown> = cloneJson(template?.properties ?? {});
      for (const p of get().dbProperties(dbId)) {
        if (p.type !== "unique_id") continue;
        let max = 0;
        for (const r of rows) {
          const v = Number(r.properties?.[p.id]);
          if (Number.isFinite(v) && v > max) max = v;
        }
        properties[p.id] = max + 1;
      }
      const row: Page = {
        id,
        createdAt: now,
        updatedAt: now,
        workspaceId: ws.id,
        parentId: dbId,
        parentType: "database",
        kind: "page",
        title: templateTitleValue(template),
        icon: template?.icon,
        iconType: iconTypeForValue(template?.icon),
        font: "default",
        smallText: false,
        fullWidth: false,
        isLocked: false,
        backlinksDisplay: "default",
        pageCommentsDisplay: "default",
        properties,
        position: positionBetween(atEnd ? rows[rows.length - 1]?.position : undefined, undefined),
        isFavorite: false,
        isPublic: false,
        inTrash: false,
        createdBy: userId || undefined,
        lastEditedBy: userId || undefined,
      };
      set((s) => ({
        pagesById: { ...s.pagesById, [id]: row },
        databaseRowIdsByDb: {
          ...s.databaseRowIdsByDb,
          [dbId]: appendUniqueIds(s.databaseRowIdsByDb[dbId] ?? [], [id]),
        },
        databaseRowPagesByDb: {
          ...s.databaseRowPagesByDb,
          [dbId]: {
            ...(s.databaseRowPagesByDb[dbId] ?? { loadedCount: rows.length, hasMore: false }),
            loadedCount: (s.databaseRowPagesByDb[dbId]?.loadedCount ?? rows.length) + 1,
            totalCount:
              typeof s.databaseRowPagesByDb[dbId]?.totalCount === "number"
                ? (s.databaseRowPagesByDb[dbId]?.totalCount ?? 0) + 1
                : s.databaseRowPagesByDb[dbId]?.totalCount,
          },
        },
        ...(opts?.focusTitle ? { focusPageId: id } : {}),
      }));
      pendingDatabaseRowCreate.set(id, dbId);
      startBackgroundDurableCall({
        args: [
          {
            id,
            databaseId: dbId,
            title: row.title,
            templateId,
            empty: templateId === "",
            position: row.position,
          },
        ],
        fnKey: "createDatabaseRowRemote",
        opKey: `create-row:${id}`,
        userId: userId || "",
        waitsFor: () => pendingDatabaseCreate.has(dbId),
        onSuccess: (result) => {
          pendingDatabaseRowCreate.delete(id);
          const created = result as
            | Awaited<ReturnType<DatabaseStoreRuntime["createDatabaseRowRemote"]>>
            | undefined;
          if (created) {
            set((state) => {
              const current = state.pagesById[id];
              return {
                pagesById: current
                  ? { ...state.pagesById, [id]: { ...created.row, ...current } }
                  : state.pagesById,
                blocksByPage: {
                  ...state.blocksByPage,
                  [id]: created.blocks.slice().sort(bySortPos),
                },
                loadedBlockPages: new Set(state.loadedBlockPages).add(id),
              };
            });
          } else {
            void get().loadDatabase(dbId, { force: true, rows: true });
            void reloadBlocksFromServer(id);
          }
          publishDatabaseRowsMutation(dbId, "row_created", [id]);
          releaseOptimisticCreateDependents(id);
        },
        onDrop: () => {
          pendingDatabaseRowCreate.delete(id);
          rollbackDependentWritesForFailedCreate(id);
          set((state) => {
            const pagesById = { ...state.pagesById };
            const blocksByPage = { ...state.blocksByPage };
            delete pagesById[id];
            delete blocksByPage[id];
            const loadedBlockPages = new Set(state.loadedBlockPages);
            loadedBlockPages.delete(id);
            const pageState = state.databaseRowPagesByDb[dbId];
            return {
              pagesById,
              blocksByPage,
              loadedBlockPages,
              ...(state.focusPageId === id
                ? { focusPageId: undefined, focusPageTarget: undefined }
                : {}),
              databaseRowIdsByDb: {
                ...state.databaseRowIdsByDb,
                [dbId]: (state.databaseRowIdsByDb[dbId] ?? []).filter((rid) => rid !== id),
              },
              ...(pageState
                ? {
                    databaseRowPagesByDb: {
                      ...state.databaseRowPagesByDb,
                      [dbId]: {
                        ...pageState,
                        loadedCount: Math.max(0, pageState.loadedCount - 1),
                        totalCount:
                          typeof pageState.totalCount === "number"
                            ? Math.max(0, pageState.totalCount - 1)
                            : pageState.totalCount,
                      },
                    },
                  }
                : {}),
            };
          });
          if (typeof window !== "undefined") {
            const route = routeInfoFromPath(window.location.pathname);
            if (route.kind === "page" && route.pageId === id) replaceRoute(originHref);
          }
        },
      });
      return row;
    },

    async moveDatabaseRow(rowId, targetId, side) {
      const pagesById = get().pagesById;
      const row = pagesById[rowId];
      const target = pagesById[targetId];
      if (!row || !target) return undefined;
      if (row.isLocked) return undefined;
      if (row.parentType !== "database" || target.parentType !== "database") return undefined;
      if (!row.parentId || row.parentId !== target.parentId) return undefined;
      if (isDatabaseLocked(pagesById, row.parentId)) return undefined;
      if (row.id === target.id) return undefined;

      const siblings = Object.values(pagesById)
        .filter((page) =>
          page.parentType === "database" &&
          page.parentId === row.parentId &&
          !page.inTrash &&
          page.id !== row.id
        )
        .sort(bySortPos);
      const targetIndex = siblings.findIndex((page) => page.id === target.id);
      if (targetIndex < 0) return undefined;

      const insertionIndex = targetIndex + (side === "after" ? 1 : 0);
      const previous = siblings[insertionIndex - 1];
      const next = siblings[insertionIndex];
      const position = positionBetween(previous?.position, next?.position);
      const userId = get().userId;
      const optimistic: Partial<Page> = {
        position,
        updatedAt: nowIso(),
        ...(userId ? { lastEditedBy: userId } : {}),
      };
      const before = row;
      // Capture the pre-move row order so a terminal rejection can restore it;
      // dbRows() orders strictly by databaseRowIdsByDb, so rolling back only the
      // row's position would leave the visible order wrong.
      const beforeOrder = row.parentId ? get().databaseRowIdsByDb[row.parentId] : undefined;
      set((s) => ({
        pagesById: {
          ...s.pagesById,
          [rowId]: { ...row, ...optimistic },
        },
        databaseRowIdsByDb: row.parentId
          ? {
              ...s.databaseRowIdsByDb,
              [row.parentId]: moveIdRelative(s.databaseRowIdsByDb[row.parentId] ?? [], rowId, targetId, side),
            }
          : s.databaseRowIdsByDb,
      }));

      const moveCall = await durableRemoteCall("moveDatabaseRowRemote", [rowId, targetId, side]);
      if (moveCall.status === "dropped") {
        // Terminal rejection: undo the optimistic reorder (the durable layer
        // already toasted unless the row was simply gone).
        set((s) => {
          const current = s.pagesById[rowId];
          if (!current) return {};
          return {
            pagesById: {
              ...s.pagesById,
              [rowId]: { ...current, position: before.position, updatedAt: before.updatedAt },
            },
            ...(row.parentId && beforeOrder
              ? {
                  databaseRowIdsByDb: {
                    ...s.databaseRowIdsByDb,
                    [row.parentId]: beforeOrder,
                  },
                }
              : {}),
          };
        });
        return undefined;
      }
      if (moveCall.status === "queued") {
        // Offline/transient: keep the optimistic order; the durable op lands later.
        return undefined;
      }
      const persisted = moveCall.result as Awaited<
        ReturnType<DatabaseStoreRuntime["moveDatabaseRowRemote"]>
      >;
      set((s) => {
        const current = s.pagesById[rowId];
        if (!current) return {};
        return {
          pagesById: {
            ...s.pagesById,
            [rowId]: { ...current, ...persisted },
          },
        };
      });
      publishDatabaseRowsMutation(row.parentId, "row_moved", [rowId]);
      return persisted;
    },

    setRowProperty(rowId, propId, value, opts) {
      const cur = get().pagesById[rowId];
      if (!cur) return;
      if (cur.isLocked) {
        get().notify(storeMessages().pageLockedSave, "default");
        return;
      }
      if (cur.parentType === "database" && isDatabaseLocked(get().pagesById, cur.parentId)) {
        get().notify(storeMessages().databaseLockedSave, "default");
        return;
      }
      const properties = { ...(cur.properties ?? {}), [propId]: value };
      get().updatePage(rowId, { properties }, { debounce: opts?.debounce ?? true });
    },

    async removeRowFilePropertyItem({ rowId, propertyId, fileId, expectedStorageKey }) {
      const cur = get().pagesById[rowId];
      if (!cur || cur.parentType !== "database" || !cur.parentId) return "ignored";
      if (!canEditPageInState(get(), cur)) {
        get().notify(storeMessages().editAccessDeniedSave, "default");
        return "dropped";
      }
      if (cur.isLocked) {
        get().notify(storeMessages().pageLockedSave, "default");
        return "dropped";
      }
      if (isDatabaseLocked(get().pagesById, cur.parentId)) {
        get().notify(storeMessages().databaseLockedSave, "default");
        return "dropped";
      }

      const previousValue = cur.properties?.[propertyId];
      if (!Array.isArray(previousValue)) return "ignored";
      const removedIndex = previousValue.findIndex((value) => {
        const file = recordValue(value);
        if (!file || file.id !== fileId) return false;
        return !expectedStorageKey || rowFileStorageKey(file) === expectedStorageKey;
      });
      if (removedIndex < 0) return "ignored";

      const removedItem = previousValue[removedIndex];
      const remaining = previousValue.filter((_value, index) => index !== removedIndex);
      const nextValue = remaining.length ? remaining : null;
      const now = nowIso();
      set((state) => {
        const current = state.pagesById[rowId];
        if (!current) return {};
        return {
          pagesById: {
            ...state.pagesById,
            [rowId]: {
              ...current,
              properties: { ...(current.properties ?? {}), [propertyId]: nextValue },
              updatedAt: now,
              ...(state.userId ? { lastEditedBy: state.userId } : {}),
            },
          },
        };
      });

      const effect: RowFileRemovalEffect = {
        cacheKey: expectedStorageKey || undefined,
        databaseId: cur.parentId,
        kind: "row_file_remove",
        nextValue,
        previousValue,
        propertyId,
        removedIndex,
        removedItem,
        rowId,
      };
      const call = await durableRemoteCall(
        "updateDatabaseRowRemote",
        [rowId, { properties: { [propertyId]: nextValue } }],
        effect
      );
      return call.status;
    },

    setRelation(rowId, prop, nextIds) {
      const cur = get().pagesById[rowId];
      if (!cur) return;
      const prevIds = asIdArray(cur.properties?.[prop.id]);
      get().setRowProperty(rowId, prop.id, nextIds.length ? nextIds : null, { debounce: false });
      if (isTemplateEditorPageId(rowId)) return;

      // Keep a reciprocal relation in sync: if the target database has a relation
      // property pointing back at this row's database, mirror the link there.
      const sourceDbId = prop.databaseId;
      const targetDbId = prop.config?.relationDatabaseId ?? prop.databaseId;
      if (!targetDbId) return;
      const targetProps = get().propsByDb[targetDbId] ?? [];
      // Prefer the explicit two-way pair link; fall back to the "any relation
      // pointing back" heuristic for legacy/imported pairs (see backend
      // reciprocalRelationProperty).
      const linkedId = prop.config?.relatedPropertyId;
      const reciprocal =
        (linkedId
          ? targetProps.find(
              (p) =>
                p.id === linkedId &&
                p.type === "relation" &&
                (p.config?.relationDatabaseId ?? p.databaseId) === sourceDbId
            )
          : undefined) ??
        targetProps.find(
          (p) =>
            p.type === "relation" &&
            p.id !== prop.id &&
            (p.config?.relationDatabaseId ?? p.databaseId) === sourceDbId
        );
      if (!reciprocal) return;

      const added = nextIds.filter((id) => !prevIds.includes(id));
      const removed = prevIds.filter((id) => !nextIds.includes(id));
      for (const targetId of added) {
        const target = get().pagesById[targetId];
        if (!target) continue;
        const ids = asIdArray(target.properties?.[reciprocal.id]);
        if (!ids.includes(rowId)) {
          get().setRowProperty(targetId, reciprocal.id, [...ids, rowId], { debounce: false });
        }
      }
      for (const targetId of removed) {
        const target = get().pagesById[targetId];
        if (!target) continue;
        const ids = asIdArray(target.properties?.[reciprocal.id]);
        if (ids.includes(rowId)) {
          const next = ids.filter((id) => id !== rowId);
          get().setRowProperty(targetId, reciprocal.id, next.length ? next : null, { debounce: false });
        }
      }
    },
  };
}
