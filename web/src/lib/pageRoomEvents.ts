"use client";

import type { IconType, Page } from "./types";

export const PAGE_ROOM_MUTATION_SIGNAL = "page_mutation";
export const PAGE_ROOM_MUTATION_EVENT = "hanji:page-room-mutation";
export const PAGE_ROOM_MUTATION_RECEIVED_EVENT = "hanji:page-room-mutation-received";
export const LOCAL_DATABASE_MUTATION_EVENT = "hanji:local-database-mutation";
export const PAGE_ROOM_MUTATION_COLLECTION_MS = 0;
const MAX_PAGE_ROOM_MUTATION_IDS = 100;
const TERMINAL_PAGE_ROOM_SIGNAL_ERRORS = new Set([
  "User not authenticated",
  "Join the room before sending signals",
  "Denied by room signal access rule",
  "Rejected by room signal hook",
]);

export type PageRoomMutationKind =
  | "page_meta_changed"
  | "database_rows_changed"
  | "database_schema_changed"
  | "database_views_changed"
  | "database_templates_changed"
  | "block_structure_changed"
  | "comments_changed"
  | "permissions_changed";

export type PageMetaMutationPatch = Partial<
  Pick<
    Page,
    | "backlinksDisplay"
    | "cover"
    | "coverPosition"
    | "font"
    | "fullWidth"
    | "icon"
    | "iconType"
    | "isFavorite"
    | "isLocked"
    | "lastEditedBy"
    | "pageCommentsDisplay"
    | "smallText"
    | "title"
    | "updatedAt"
    | "verificationExpiresAt"
    | "verifiedAt"
    | "verifiedBy"
  >
>;

export interface PageRoomMutationChange {
  blockIds?: string[];
  databaseId?: string;
  kind: PageRoomMutationKind;
  pageId: string;
  patch?: PageMetaMutationPatch;
  propertyIds?: string[];
  reason?: string;
  revision?: number;
  rowIds?: string[];
  targetPageId?: string;
  updatedAt?: string;
  viewIds?: string[];
}

export interface BlockStructureRoomMutationChange extends PageRoomMutationChange {
  kind: "block_structure_changed";
}

export interface PageRoomMutationReceived extends PageRoomMutationChange {
  label?: string;
  memberId?: string;
  receivedAt: number;
  userId: string;
}

export interface LocalDatabaseMutationChange
  extends Omit<PageRoomMutationChange, "kind" | "pageId"> {
  databaseId: string;
  kind:
    | "database_rows_changed"
    | "database_schema_changed"
    | "database_views_changed"
    | "database_templates_changed";
}

type BlockStructureMutationBatcherOptions = {
  isConnected: () => boolean;
  send: (change: BlockStructureRoomMutationChange) => Promise<void>;
};

function mergeMutationIds(previous?: string[], next?: string[]) {
  const merged = Array.from(
    new Set(
      [...(previous ?? []), ...(next ?? [])]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).slice(0, MAX_PAGE_ROOM_MUTATION_IDS);
  return merged.length > 0 ? merged : undefined;
}

function mergeBlockStructureMutations(
  previous: BlockStructureRoomMutationChange,
  next: BlockStructureRoomMutationChange,
): BlockStructureRoomMutationChange {
  return {
    ...previous,
    ...next,
    blockIds: mergeMutationIds(previous.blockIds, next.blockIds),
    kind: "block_structure_changed",
  };
}

function isTerminalPageRoomSignalError(error: unknown) {
  return error instanceof Error && TERMINAL_PAGE_ROOM_SIGNAL_ERRORS.has(error.message);
}

/**
 * Bound and aggregate one mounted page's block-structure invalidations.
 *
 * The page owns a single O(1) pending summary and a declared zero-wait
 * collection window: the first connected invalidation starts immediately,
 * while only events accepted during that held send coalesce into a trailing
 * summary. This removes the commit-to-route-unmount loss window while keeping
 * wire peak concurrency at one.
 *
 * Block ids are bounded advisory diagnostics: consumers always force-reload
 * the entire canonical page, so omitting the 101st id cannot omit state.
 * Sends drain sequentially without another collection delay. A failed summary
 * is re-queued beneath any newer one; reconnect, lifecycle, or a later event
 * supplies the next bounded retry instead of a hot failure loop. Other page,
 * database, comment, and permission signal kinds deliberately do not enter
 * this structure-only lane.
 */
export function createBlockStructureMutationBatcher({
  isConnected,
  send,
}: BlockStructureMutationBatcherOptions) {
  let pending: BlockStructureRoomMutationChange | undefined;
  let active: Promise<void> | undefined;
  let accepting = true;
  let disposePromise: Promise<void> | undefined;
  let disposed = false;
  let requestedWhileActive = false;

  function put(change: BlockStructureRoomMutationChange, beforeNewer = false) {
    pending = pending
      ? beforeNewer
        ? mergeBlockStructureMutations(change, pending)
        : mergeBlockStructureMutations(pending, change)
      : change;
  }

  function enqueue(change: BlockStructureRoomMutationChange) {
    if (!accepting || disposed) return;
    put(change);
    if (isConnected()) void flush();
  }

  function flush(): Promise<void> {
    if (disposed || !isConnected()) return Promise.resolve();
    if (active) {
      requestedWhileActive = true;
      return active;
    }

    let blockedByFailure = false;
    const generation = (async () => {
      do {
        requestedWhileActive = false;
        const change = pending;
        pending = undefined;
        if (!change) return;

        if (!isConnected()) {
          put(change, true);
          blockedByFailure = true;
          return;
        }
        try {
          await send(change);
        } catch (error) {
          // These fixed protocol denials cannot become valid by replaying the
          // same summary. Drop that denied item so lifecycle/disposal cannot
          // broaden authority or spend the shared retry budget on it.
          if (isTerminalPageRoomSignalError(error)) {
            blockedByFailure = true;
            return;
          }
          // A newer event may have arrived during the held send. Requeue the
          // failed older summary underneath it so the newest revision wins
          // while every bounded advisory id is retained. Only that distinct
          // accepted trailing work authorizes one immediate sequential
          // handoff; a lone failure parks for lifecycle/cleanup instead of
          // creating a self-sustaining retry loop.
          const hasAcceptedTrailingWork = Boolean(pending);
          put(change, true);
          if (!hasAcceptedTrailingWork) {
            blockedByFailure = true;
            return;
          }
        }
      } while ((requestedWhileActive || pending) && isConnected());
    })();

    const settled = generation.finally(() => {
      if (active !== settled) return;
      active = undefined;
      if (
        !disposed &&
        !blockedByFailure &&
        requestedWhileActive &&
        pending &&
        isConnected()
      ) {
        return flush();
      }
    });
    active = settled;
    return settled;
  }

  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    accepting = false;
    disposePromise = (async () => {
      // Keep the room alive until the already-started send and its one
      // coalesced trailing summary settle. If the first send rejected and
      // re-queued its summary, cleanup gives it one explicit final flush; a
      // persistent transport failure still falls back to peer lifecycle
      // canonical catch-up instead of spinning indefinitely.
      if (active) await active;
      if (pending && isConnected()) await flush();
      disposed = true;
      pending = undefined;
    })();
    return disposePromise;
  }

  return {
    dispose,
    enqueue,
    flush,
    pendingCount: () => Number(Boolean(pending)),
  };
}

type PageBlockCatchupState = {
  active?: Promise<void>;
  /** One coalesced generation requested while the current generation runs. */
  trailing: boolean;
};

/**
 * Coalesce canonical block reloads without losing a mutation that arrives
 * while the current read is on the wire.
 *
 * Each page owns an independent lane. A burst for one page starts one read;
 * every request received during that read collapses into one fresh trailing
 * generation. If another event arrives while the trailing generation runs it
 * becomes the next single trailing generation, so the queue fully drains
 * without parallel reads or a second collection delay.
 */
export function createPageBlockCatchupCoordinator(
  load: (pageId: string) => Promise<void>,
) {
  const states = new Map<string, PageBlockCatchupState>();

  function request(pageId: string): Promise<void> {
    const key = pageId.trim();
    if (!key) return Promise.resolve();
    const state = states.get(key) ?? { trailing: false };
    states.set(key, state);
    if (state.active) {
      state.trailing = true;
      return state.active;
    }

    const generation = (async () => {
      let firstError: unknown;
      do {
        state.trailing = false;
        try {
          await load(key);
        } catch (error) {
          firstError ??= error;
        }
      } while (state.trailing);
      if (firstError !== undefined) throw firstError;
    })();
    const active = generation.finally(() => {
      if (state.active !== active) return;
      state.active = undefined;
      // A request may run in the microtask gap after the loop observed
      // trailing=false but before this settlement callback. It received this
      // active promise, so hand off to (and await) a new drain here instead of
      // leaving trailing=true with no owner.
      if (state.trailing) return request(key);
      states.delete(key);
    });
    state.active = active;
    return active;
  }

  return { request };
}

const PAGE_META_KEYS = new Set<keyof PageMetaMutationPatch>([
  "backlinksDisplay",
  "cover",
  "coverPosition",
  "font",
  "fullWidth",
  "icon",
  "iconType",
  "isFavorite",
  "isLocked",
  "lastEditedBy",
  "pageCommentsDisplay",
  "smallText",
  "title",
  "updatedAt",
  "verificationExpiresAt",
  "verifiedAt",
  "verifiedBy",
]);

function isIconType(value: unknown): value is IconType {
  return value === "emoji" || value === "image" || value === "none";
}

export function pageMetaMutationPatch(patch: Partial<Page>): PageMetaMutationPatch | undefined {
  const out: PageMetaMutationPatch = {};
  for (const [key, value] of Object.entries(patch) as [keyof PageMetaMutationPatch, unknown][]) {
    if (!PAGE_META_KEYS.has(key)) continue;
    if (key === "iconType" && !isIconType(value)) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function publishPageRoomMutation(change: PageRoomMutationChange) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PageRoomMutationChange>(PAGE_ROOM_MUTATION_EVENT, { detail: change }));
}

export function publishLocalDatabaseMutation(change: LocalDatabaseMutationChange) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<LocalDatabaseMutationChange>(LOCAL_DATABASE_MUTATION_EVENT, { detail: change }),
  );
}
