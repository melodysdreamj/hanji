"use client";

// Sync-status affordance (local-first Phase 2 — docs/local-first-roadmap.md).
// Shows nothing while online with an empty queue; otherwise a small pill with
// the offline state and the number of durably queued local changes. Going
// back online immediately flushes the pending queues instead of waiting for
// the retry timers. `navigator.onLine` can't see a dead server behind live
// wifi, so the store's syncDegraded flag (consecutive persist failures)
// drives an additional "can't reach server" state with a click-to-retry.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { outboxAllEntries } from "@/lib/outbox";
import { flushAllPending, useStore } from "@/lib/store";

import styles from "./SyncStatusBadge.module.css";

const POLL_MS = 2500;

export default function SyncStatusBadge() {
  const { t } = useTranslation(["syncStatusBadge", "common"]);
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
  const text = offline
    ? pending > 0
      ? t("syncStatusBadge:offlinePending", { count: pending })
      : t("syncStatusBadge:offline")
    : showDegraded
      ? pending > 0
        ? t("syncStatusBadge:unreachablePending", { count: pending })
        : t("syncStatusBadge:unreachable")
      : t("syncStatusBadge:syncing", { count: pending });
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
        title={t("syncStatusBadge:retryHint")}
        aria-label={`${text}. ${t("syncStatusBadge:retryHint")}`}
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
