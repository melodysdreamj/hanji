"use client";

// Sync-status affordance (local-first Phase 2 — docs/local-first-roadmap.md).
// Shows nothing while online with an empty queue; otherwise a small pill with
// the offline state and the number of durably queued local changes. Going
// back online immediately flushes the pending queues instead of waiting for
// the retry timers. `navigator.onLine` can't see a dead server behind live
// wifi, so the store's syncDegraded flag (consecutive persist failures)
// drives an additional "can't reach server" state with a click-to-retry.

import { useEffect, useState } from "react";

import { pickLabels } from "@/lib/i18n";
import { outboxAllEntries } from "@/lib/outbox";
import { flushAllPending, useStore } from "@/lib/store";

import styles from "./SyncStatusBadge.module.css";

const POLL_MS = 2500;

const SYNC_BADGE_LABELS = {
  en: {
    offline: "Offline",
    offlinePending: (pending: number) =>
      `Offline · ${pending} change${pending === 1 ? "" : "s"} pending`,
    syncing: (pending: number) => `Syncing · ${pending}`,
    unreachable: "Can't reach the server",
    unreachablePending: (pending: number) =>
      `Can't reach the server · ${pending} change${pending === 1 ? "" : "s"} pending`,
    retryHint: "Click to retry now",
  },
  ko: {
    offline: "오프라인",
    offlinePending: (pending: number) => `오프라인 · 변경 ${pending}개 대기 중`,
    syncing: (pending: number) => `동기화 중 · ${pending}개`,
    unreachable: "서버에 연결할 수 없어요",
    unreachablePending: (pending: number) => `서버에 연결할 수 없어요 · 변경 ${pending}개 대기 중`,
    retryHint: "지금 다시 시도하려면 클릭하세요",
  },
} as const;

function syncBadgeLabels() {
  return pickLabels(SYNC_BADGE_LABELS);
}

export default function SyncStatusBadge() {
  const userId = useStore((s) => s.userId);
  const degraded = useStore((s) => s.syncDegraded);
  const [offline, setOffline] = useState(
    () => typeof navigator !== "undefined" && navigator.onLine === false
  );
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const goOnline = () => {
      setOffline(false);
      // Reconnect: flush now instead of waiting for the retry backoff.
      void flushAllPending();
    };
    const goOffline = () => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  useEffect(() => {
    if (!userId) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const entries = await outboxAllEntries(userId).catch(() => []);
      if (!mounted) return;
      setPending(entries.length);
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [userId]);

  const showDegraded = degraded && !offline;
  if (!offline && !showDegraded && pending === 0) return null;
  const labels = syncBadgeLabels();
  const text = offline
    ? pending > 0
      ? labels.offlinePending(pending)
      : labels.offline
    : showDegraded
      ? pending > 0
        ? labels.unreachablePending(pending)
        : labels.unreachable
      : labels.syncing(pending);
  const content = (
    <>
      <span aria-hidden className={styles.dot} />
      {text}
    </>
  );

  if (showDegraded) {
    return (
      <button
        type="button"
        className={styles.badge}
        data-degraded="true"
        data-testid="sync-status-badge"
        onClick={() => void flushAllPending()}
        title={labels.retryHint}
        aria-label={`${text}. ${labels.retryHint}`}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={styles.badge}
      data-offline={offline ? "true" : undefined}
      data-testid="sync-status-badge"
      role="status"
    >
      {content}
    </div>
  );
}
