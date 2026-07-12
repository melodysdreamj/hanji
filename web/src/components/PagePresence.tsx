"use client";

import type { CSSProperties } from "react";
import type { PagePresencePeer, usePagePresence } from "@/lib/pagePresence";
import styles from "./PageView.module.css";

const MAX_VISIBLE_PEERS = 4;
export type PagePresenceSnapshot = ReturnType<typeof usePagePresence>;

function initialsForPeer(peer: PagePresencePeer) {
  const label = peer.label.trim();
  if (!label) return "?";
  const parts = label.split(/\s+/);
  if (parts[0]?.toLowerCase() === "user" && parts[1]) {
    const idToken = parts.slice(1).join("").replace(/[^a-zA-Z0-9]/g, "");
    return (idToken.slice(-2) || parts[1].slice(0, 2)).toUpperCase();
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function statusLabel(status: ReturnType<typeof usePagePresence>["status"], activeCount: number) {
  if (status === "connected" || activeCount > 1) return `${activeCount} connected`;
  if (status === "connecting") return "Connecting";
  if (status === "reconnecting") return "Reconnecting";
  if (status === "auth_lost") return "Authentication lost";
  if (status === "kicked") return "Disconnected";
  return "Offline";
}

function awarenessLabel(awareness: ReturnType<typeof usePagePresence>["awareness"]) {
  const first = awareness[0];
  if (!first) return "";
  const verb = first.mode === "selecting" ? "selecting" : "editing";
  const suffix = awareness.length > 1 ? ` +${awareness.length - 1}` : "";
  return `${first.label} ${verb}${suffix}`;
}

export function PagePresence({
  disabled = false,
  presence,
  variant = "floating",
}: {
  disabled?: boolean;
  presence: PagePresenceSnapshot;
  variant?: "floating" | "topbar";
}) {
  const { activeCount, awareness, peers, status } = presence;
  const topbar = variant === "topbar";
  const hasRemotePeer = peers.length > 1;
  const shouldShowStatus =
    hasRemotePeer &&
    (status === "auth_lost" ||
      status === "kicked" ||
      status === "disconnected");
  // The floating indicator also renders for connected peers who are merely
  // viewing (no awareness activity), so idle collaborators stay visible —
  // same peer data source as the topbar variant.
  const shouldShow =
    !disabled && (topbar ? peers.length > 0 : hasRemotePeer || awareness.length > 0 || shouldShowStatus);

  if (!shouldShow) return null;

  const visiblePeers = peers.slice(0, topbar ? 3 : MAX_VISIBLE_PEERS);
  const hiddenCount = Math.max(0, peers.length - visiblePeers.length);
  const label = statusLabel(status, activeCount);
  const activeAwareness = awarenessLabel(awareness);
  const accessibilityLabel = !topbar && activeAwareness ? `${label}, ${activeAwareness}` : label;

  return (
    <div
      className={styles.presence}
      data-status={status}
      data-variant={variant}
      data-topbar-presence={topbar ? "true" : undefined}
      data-testid={topbar ? "topbar-page-presence" : "page-presence"}
      aria-label={accessibilityLabel}
      title={accessibilityLabel}
    >
      {!topbar && <span className={styles.presenceDot} aria-hidden="true" />}
      <div className={styles.presenceStack}>
        {visiblePeers.map((peer) => (
          <span
            key={peer.memberId}
            className={styles.presenceAvatar}
            style={{ "--presence-color": peer.color } as CSSProperties}
            title={`${peer.label}${peer.isCurrent ? " (you)" : ""}`}
          >
            {initialsForPeer(peer)}
          </span>
        ))}
        {hiddenCount > 0 && (
          <span className={`${styles.presenceAvatar} ${styles.presenceMore}`}>
            +{hiddenCount}
          </span>
        )}
      </div>
      {!topbar && activeAwareness && <span className={styles.presenceActivity}>{activeAwareness}</span>}
    </div>
  );
}
