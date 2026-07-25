import { useEffect, useMemo } from "react";
import { listNotificationsRemote } from "@/lib/edgebase";

const UNREAD_REFRESH_THROTTLE_MS = 30_000;

type RefreshMode = "fresh" | "normal";

interface UnreadRefreshLane {
  active?: Promise<void>;
  lastSuccessAt?: number;
  retryAfterFailure: boolean;
  trailingGeneration?: number;
}

interface SidebarUnreadRefreshCoordinatorOptions {
  onUnreadChange: (unread: boolean) => void;
  readNotifications?: typeof listNotificationsRemote;
}

function createSidebarUnreadRefreshCoordinator({
  onUnreadChange,
  readNotifications = listNotificationsRemote,
}: SidebarUnreadRefreshCoordinatorOptions) {
  const lanes = new Map<string, UnreadRefreshLane>();
  let currentGeneration = 0;
  let currentWorkspaceId: string | undefined;
  let inboxOpen: boolean | undefined;
  let mounted = false;

  const laneFor = (workspaceId: string) => {
    const existing = lanes.get(workspaceId);
    if (existing) return existing;
    const lane: UnreadRefreshLane = { retryAfterFailure: false };
    lanes.set(workspaceId, lane);
    return lane;
  };

  const start = (
    lane: UnreadRefreshLane,
    workspaceId: string,
    requestGeneration: number,
  ) => {
    const run = (async () => {
      // Defer the reader invocation until `lane.active` owns this generation.
      // This also turns a synchronous reader failure into the normal rejection path.
      await Promise.resolve();
      try {
        const result = await readNotifications({
          workspaceId,
          limit: 1,
          includeRead: false,
        });
        lane.lastSuccessAt = Date.now();
        lane.retryAfterFailure = false;

        // A fresh trigger that arrived during this request owns the next result.
        // Do not briefly re-apply the older generation while that trailing read drains.
        if (
          lane.trailingGeneration === undefined
          && mounted
          && currentWorkspaceId === workspaceId
          && currentGeneration === requestGeneration
        ) {
          onUnreadChange((result.unreadCount ?? 0) > 0);
        }
      } catch {
        // A failed forced refresh must not inherit an earlier successful throttle.
        lane.retryAfterFailure = true;
      }
    })();
    lane.active = run;
    void run.then(() => {
      if (lane.active !== run) return;
      lane.active = undefined;
      const trailingGeneration = lane.trailingGeneration;
      lane.trailingGeneration = undefined;

      if (
        trailingGeneration !== undefined
        && mounted
        && currentWorkspaceId === workspaceId
        && currentGeneration === trailingGeneration
      ) {
        start(lane, workspaceId, trailingGeneration);
      } else if (currentWorkspaceId !== workspaceId) {
        lanes.delete(workspaceId);
      }
    });
  };

  const refresh = (mode: RefreshMode) => {
    const workspaceId = currentWorkspaceId;
    if (!mounted || !workspaceId) return;
    const lane = laneFor(workspaceId);
    if (lane.active) {
      if (mode === "fresh") lane.trailingGeneration = currentGeneration;
      return;
    }
    if (
      mode === "normal"
      && !lane.retryAfterFailure
      && lane.lastSuccessAt !== undefined
      && Date.now() - lane.lastSuccessAt < UNREAD_REFRESH_THROTTLE_MS
    ) {
      return;
    }
    start(lane, workspaceId, currentGeneration);
  };

  return {
    mount() {
      mounted = true;
    },
    unmount() {
      mounted = false;
    },
    setWorkspace(workspaceId: string | undefined, refreshWhenVisible: boolean) {
      const changed = currentWorkspaceId !== workspaceId;
      if (changed) {
        const previousWorkspaceId = currentWorkspaceId;
        currentWorkspaceId = workspaceId;
        currentGeneration += 1;
        if (previousWorkspaceId) {
          const previousLane = lanes.get(previousWorkspaceId);
          if (previousLane && !previousLane.active) lanes.delete(previousWorkspaceId);
        }
      }
      if (!workspaceId || !refreshWhenVisible) return;

      // Re-entering a workspace whose older generation is still active requires
      // one post-settlement read; a normal StrictMode replay simply joins it.
      const lane = laneFor(workspaceId);
      refresh(changed && lane.active ? "fresh" : "normal");
    },
    setInboxOpen(open: boolean) {
      if (inboxOpen === undefined) {
        inboxOpen = open;
        return;
      }
      const justClosed = inboxOpen && !open;
      inboxOpen = open;
      if (justClosed) refresh("fresh");
    },
    refreshFresh() {
      refresh("fresh");
    },
    refreshNormal() {
      refresh("normal");
    },
    markAllReadOptimistically() {
      if (mounted && currentWorkspaceId) onUnreadChange(false);
    },
  };
}

export function useSidebarUnreadRefresh({
  onUnreadChange,
  updatesOpen,
  workspaceId,
}: {
  onUnreadChange: (unread: boolean) => void;
  updatesOpen: boolean;
  workspaceId: string | undefined;
}) {
  const coordinator = useMemo(
    () => createSidebarUnreadRefreshCoordinator({ onUnreadChange }),
    [onUnreadChange],
  );

  useEffect(() => {
    coordinator.mount();
    coordinator.setWorkspace(workspaceId, document.visibilityState !== "hidden");
    return () => coordinator.unmount();
  }, [coordinator, workspaceId]);

  useEffect(() => {
    coordinator.setInboxOpen(updatesOpen);
  }, [coordinator, updatesOpen]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") coordinator.refreshNormal();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [coordinator]);

  useEffect(() => {
    if (!workspaceId) return;
    let timer: number | undefined;
    const onReadChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ allRead?: boolean }>).detail;
      if (detail?.allRead) coordinator.markAllReadOptimistically();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => coordinator.refreshFresh(), 2000);
    };
    window.addEventListener("hanji:updates-read-changed", onReadChanged);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hanji:updates-read-changed", onReadChanged);
    };
  }, [coordinator, workspaceId]);
}
