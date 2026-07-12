"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listNotificationsRemote } from "@/lib/edgebase";
import type { NotificationRecord } from "@/lib/types";
import { pageHref } from "@/lib/navigation";
import { personLabel } from "@/lib/peopleDirectory";
import { useRouter } from "@/lib/router";
import { useStore } from "@/lib/store";
import { spansToPlainText } from "@/lib/types";
import styles from "./InboxChats.module.css";

// Inbox chat rooms (approved 2026-07-10 revision of the sidebar chat
// contract): every page with comment/mention traffic involving me is a
// "room", listed most-recent-first like a messenger app. Opening a room
// opens the page's existing comment thread; mentioning someone in a comment
// is how a participant calls another member in. Leaving hides the room until
// a NEWER mention calls me back. Leave state is per browser (localStorage)
// for this MVP — a server-side membership model is the follow-up.

interface ChatRoom {
  pageId: string;
  title: string;
  lastAt: string;
  preview: string;
  actorIds: string[];
  unread: boolean;
  lastMentionAt: string | null;
}

function leftKey(workspaceId: string, userId: string) {
  return `hanji:chat-left:${workspaceId}:${userId}`;
}

function readLeftMap(workspaceId: string, userId: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(leftKey(workspaceId, userId));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Groups my comment/mention notifications (+ my own local comments) into rooms. */
export function buildChatRooms(
  notifications: readonly NotificationRecord[],
  myCommentPages: ReadonlyArray<{ pageId: string; lastAt: string; preview: string }>,
  titleFor: (pageId: string) => string | undefined,
  leftMap: Readonly<Record<string, string>>,
): ChatRoom[] {
  const rooms = new Map<string, ChatRoom>();
  const upsert = (pageId: string, at: string, preview: string, actorId: string | null, opts?: { unread?: boolean; mention?: boolean }) => {
    const current = rooms.get(pageId) ?? {
      pageId,
      title: "",
      lastAt: at,
      preview,
      actorIds: [],
      unread: false,
      lastMentionAt: null,
    };
    if (at >= current.lastAt) {
      current.lastAt = at;
      current.preview = preview || current.preview;
    }
    if (actorId && !current.actorIds.includes(actorId)) current.actorIds.push(actorId);
    if (opts?.unread) current.unread = true;
    if (opts?.mention && (!current.lastMentionAt || at > current.lastMentionAt)) {
      current.lastMentionAt = at;
    }
    rooms.set(pageId, current);
  };

  for (const notification of notifications) {
    if (!notification.pageId) continue;
    if (notification.kind !== "comment" && notification.kind !== "mention") continue;
    upsert(
      notification.pageId,
      notification.occurredAt,
      notification.preview ?? "",
      notification.actorId ?? null,
      { unread: !notification.readAt, mention: notification.kind === "mention" },
    );
  }
  for (const mine of myCommentPages) {
    upsert(mine.pageId, mine.lastAt, mine.preview, null);
  }

  return Array.from(rooms.values())
    .map((room) => ({ ...room, title: titleFor(room.pageId) ?? "" }))
    .filter((room) => {
      const leftAt = leftMap[room.pageId];
      if (!leftAt) return true;
      // A newer mention calls me back into a left room.
      return Boolean(room.lastMentionAt && room.lastMentionAt > leftAt);
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

function relativeTime(iso: string, locale: string) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((Date.now() - at) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}

export function InboxChats({ workspaceId }: { workspaceId: string }) {
  const { t, i18n } = useTranslation(["inboxChats", "common"]);
  const router = useRouter();
  const userId = useStore((s) => s.userId);
  const pagesById = useStore((s) => s.pagesById);
  const commentsByPage = useStore((s) => s.commentsByPage);
  const openComments = useStore((s) => s.openComments);
  const [notifications, setNotifications] = useState<NotificationRecord[] | null>(null);
  const [leftMap, setLeftMap] = useState<Record<string, string>>(() =>
    userId ? readLeftMap(workspaceId, userId) : {},
  );

  useEffect(() => {
    let mounted = true;
    listNotificationsRemote({ workspaceId, includeRead: true, limit: 200 })
      .then((result) => {
        if (mounted) setNotifications(result.notifications ?? []);
      })
      .catch(() => {
        if (mounted) setNotifications([]);
      });
    return () => {
      mounted = false;
    };
  }, [workspaceId]);

  const rooms = useMemo(() => {
    if (!notifications) return null;
    const myCommentPages = Object.entries(commentsByPage)
      .map(([pageId, comments]) => {
        const mine = comments.filter((comment) => comment.authorId === userId);
        if (!mine.length) return null;
        const last = mine.reduce((a, b) => ((a.createdAt ?? "") > (b.createdAt ?? "") ? a : b));
        const body = last.body as { rich?: unknown } | undefined;
        return {
          pageId,
          lastAt: last.createdAt ?? "",
          preview: spansToPlainText(Array.isArray(body?.rich) ? body.rich : []).slice(0, 120),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return buildChatRooms(
      notifications,
      myCommentPages,
      (pageId) => pagesById[pageId]?.title,
      leftMap,
    );
  }, [notifications, commentsByPage, pagesById, userId, leftMap]);

  function leaveRoom(pageId: string) {
    if (!userId) return;
    const next = { ...leftMap, [pageId]: new Date().toISOString() };
    setLeftMap(next);
    try {
      window.localStorage.setItem(leftKey(workspaceId, userId), JSON.stringify(next));
    } catch {
      // Browser-only convenience state; losing it just re-shows the room.
    }
  }

  function openRoom(room: ChatRoom) {
    router.push(pageHref(room.pageId));
    openComments(room.pageId);
  }

  const locale = i18n.language;

  if (!rooms) return <div className={styles.empty}>{t("inboxChats:loading")}</div>;
  if (rooms.length === 0) return <div className={styles.empty}>{t("inboxChats:empty")}</div>;

  return (
    <ul className={styles.list} data-testid="inbox-chat-rooms">
      {rooms.map((room) => {
        const title = room.title || t("inboxChats:untitled");
        const participantNames = room.actorIds
          .map((actorId) => personLabel(actorId, userId ?? undefined))
          .filter(Boolean)
          .slice(0, 3)
          .join(", ");
        const participantCount = room.actorIds.length + 1;
        return (
          <li key={room.pageId} className={styles.room} data-unread={room.unread ? "true" : undefined}>
            <button
              type="button"
              className={styles.roomBody}
              aria-label={t("inboxChats:open", { title })}
              onClick={() => openRoom(room)}
            >
              <span className={styles.roomTitleRow}>
                <span className={styles.roomTitle}>{title}</span>
                <span className={styles.roomTime}>{relativeTime(room.lastAt, locale)}</span>
              </span>
              <span className={styles.roomMeta}>
                {participantNames
                  ? `${participantNames} · ${t("inboxChats:participants", { count: participantCount })}`
                  : t("inboxChats:participants", { count: participantCount })}
              </span>
              {room.preview ? <span className={styles.roomPreview}>{room.preview}</span> : null}
            </button>
            <button
              type="button"
              className={styles.leave}
              aria-label={t("inboxChats:leaveAria", { title })}
              onClick={() => leaveRoom(room.pageId)}
            >
              {t("inboxChats:leave")}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
