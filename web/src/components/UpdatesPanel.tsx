"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import {
  listAllBlocks,
  mergedBlocks,
  pageReferenceHits,
  type PageReferenceHit,
} from "@/lib/backlinks";
import {
  listNotificationsRemote,
  markAllNotificationsReadRemote,
  markNotificationsReadRemote,
  syncNotificationsRemote,
  type NotificationActivityInput,
} from "@/lib/edgebase";
import { activeDateLocale, pickLabels } from "@/lib/i18n";
import { pageHref } from "@/lib/navigation";
import { pagePathOrWorkspaceRoot } from "@/lib/pagePath";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { Block, Comment, NotificationRecord, Page, TextSpan } from "@/lib/types";
import { useStore } from "@/lib/store";
import {
  compactUpdateReadKeys,
  readUpdateActivityKeys,
  updateActivityReadKey,
  writeUpdateActivityKeys,
} from "@/lib/updateReadState";
import { actorLabel } from "./database/people";
import { ArrowLeft, ArrowRight, Bell, CheckIcon, ClockIcon, X } from "./icons";
import { PageIconGlyph } from "./PageIcon";
import styles from "./UpdatesPanel.module.css";

type Activity =
  | {
      kind: "comment";
      id: string;
      page: Page;
      comment: Comment;
      at: number;
    }
  | {
      kind: "page";
      id: string;
      page: Page;
      at: number;
    }
  | {
      kind: "reference";
      id: string;
      page: Page;
      reference: PageReferenceHit;
      at: number;
    }
  | {
      kind: "notification";
      id: string;
      notification: NotificationRecord;
      page?: Page;
      at: number;
    };
type ActivityFilter = "all" | "unread" | "comments" | "mentions" | "edits";

const UPDATES_PANEL_LABELS = {
  en: {
    // Filter tabs
    filterAll: "All",
    filterComments: "Comments",
    filterEdits: "Edits",
    filterMentions: "Mentions",
    filterUnread: "Unread",
    // Header
    closeUpdates: "Close updates",
    markAllRead: "Mark all as read",
    markAllReadAria: "Mark all updates as read",
    pageHistory: "Page history",
    recentUpdates: (count: number) => `${count} recent update${count === 1 ? "" : "s"}`,
    unreadOfTotal: (unread: number, total: number) => `${unread} unread of ${total} updates`,
    updateType: "Update type",
    updates: "Updates",
    // Time
    justNow: "Just now",
    today: "Today",
    yesterday: "Yesterday",
    // Page history / versions
    blockCount: (count: number) => `${count} block${count === 1 ? "" : "s"}`,
    currentVersion: "Current version",
    currentVersionOnly: "Current version only",
    next: "Next",
    nextVersion: "Next version",
    noVersion: (direction: "previous" | "next") => `No ${direction} version`,
    pageLocked: "Page locked",
    previous: "Previous",
    previousSnapshots: (count: number) => `${count} previous snapshot${count === 1 ? "" : "s"}`,
    previousVersion: "Previous version",
    restoredVersion: (direction: "previous" | "next") => `Restored ${direction} version`,
    restoredVersions: (count: number) => `Restored ${count} versions`,
    versionCount: (count: number) => `${count} version${count === 1 ? "" : "s"}`,
    versionsAgo: (count: number) => `${count} versions ago`,
    versionsAhead: (count: number) => `${count} versions ahead`,
    versionsAria: "Versions",
    // Activity badges
    badgeComment: "Comment",
    badgeEdited: "Edited",
    badgeLinked: "Linked",
    badgeMember: "Member",
    badgeMention: "Mention",
    badgeReply: "Reply",
    badgeReplyMention: "Reply mention",
    badgeShared: "Shared",
    badgeSystem: "System",
    // Activity rows
    byActor: (name: string) => `by ${name}`,
    emptyComment: "Empty comment",
    forYou: "for you",
    notification: "Notification",
    referencePreview: (kind: "mention" | "link", title: string, preview: string) =>
      `${kind === "mention" ? "Mentioned" : "Linked to"} ${title} · ${preview}`,
    unreadDot: "Unread",
    workspaceUpdate: "Workspace update",
    // Empty states
    allCaughtUp: "You're all caught up.",
    loadingUpdates: "Loading updates...",
    noFilteredUpdatesYet: (filterLabel: string) => `No ${filterLabel.toLowerCase()} yet.`,
    noPageHistoryYet: "No page history yet.",
    noUpdatesYet: "No updates yet.",
  },
  ko: {
    // Filter tabs
    filterAll: "전체",
    filterComments: "댓글",
    filterEdits: "편집",
    filterMentions: "멘션",
    filterUnread: "안 읽음",
    // Header
    closeUpdates: "업데이트 닫기",
    markAllRead: "모두 읽음으로 표시",
    markAllReadAria: "모든 업데이트를 읽음으로 표시",
    pageHistory: "페이지 기록",
    recentUpdates: (count: number) => `최근 업데이트 ${count}개`,
    unreadOfTotal: (unread: number, total: number) => `업데이트 ${total}개 중 ${unread}개 안 읽음`,
    updateType: "업데이트 유형",
    updates: "업데이트",
    // Time
    justNow: "방금 전",
    today: "오늘",
    yesterday: "어제",
    // Page history / versions
    blockCount: (count: number) => `블록 ${count}개`,
    currentVersion: "현재 버전",
    currentVersionOnly: "현재 버전만 있어요",
    next: "다음",
    nextVersion: "다음 버전",
    noVersion: (direction: "previous" | "next") =>
      direction === "previous" ? "이전 버전이 없어요" : "다음 버전이 없어요",
    pageLocked: "페이지 잠김",
    previous: "이전",
    previousSnapshots: (count: number) => `이전 스냅샷 ${count}개`,
    previousVersion: "이전 버전",
    restoredVersion: (direction: "previous" | "next") =>
      direction === "previous" ? "이전 버전으로 복원했어요" : "다음 버전으로 복원했어요",
    restoredVersions: (count: number) => `버전 ${count}개를 복원했어요`,
    versionCount: (count: number) => `버전 ${count}개`,
    versionsAgo: (count: number) => `${count}개 이전 버전`,
    versionsAhead: (count: number) => `${count}개 다음 버전`,
    versionsAria: "버전 목록",
    // Activity badges
    badgeComment: "댓글",
    badgeEdited: "편집됨",
    badgeLinked: "링크됨",
    badgeMember: "멤버",
    badgeMention: "멘션",
    badgeReply: "답글",
    badgeReplyMention: "답글 멘션",
    badgeShared: "공유됨",
    badgeSystem: "시스템",
    // Activity rows
    byActor: (name: string) => `${name}님`,
    emptyComment: "빈 댓글",
    forYou: "나에게",
    notification: "알림",
    referencePreview: (kind: "mention" | "link", title: string, preview: string) =>
      `${title} ${kind === "mention" ? "멘션" : "링크"} · ${preview}`,
    unreadDot: "안 읽음",
    workspaceUpdate: "워크스페이스 업데이트",
    // Empty states
    allCaughtUp: "모든 업데이트를 확인했어요.",
    loadingUpdates: "업데이트를 불러오는 중...",
    noFilteredUpdatesYet: (filterLabel: string) => `아직 ${filterLabel} 항목이 없어요.`,
    noPageHistoryYet: "아직 페이지 기록이 없어요.",
    noUpdatesYet: "아직 업데이트가 없어요.",
  },
} as const;

// Locale cannot change mid-session (same convention as WorkspaceSettingsDialog),
// so resolve the dictionary once at module load.
const LABELS = pickLabels(UPDATES_PANEL_LABELS);

const ACTIVITY_FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: LABELS.filterAll },
  { value: "unread", label: LABELS.filterUnread },
  { value: "comments", label: LABELS.filterComments },
  { value: "mentions", label: LABELS.filterMentions },
  { value: "edits", label: LABELS.filterEdits },
];

function richText(body: unknown) {
  if (typeof body === "string") return body;
  const rich = (body as { rich?: TextSpan[] } | undefined)?.rich;
  return Array.isArray(rich) ? rich.map((span) => span.text).join("") : "";
}

function timeLabel(value?: string) {
  if (!value) return LABELS.justNow;
  return new Date(value).toLocaleString(activeDateLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function timeLabelFromMs(value?: number) {
  if (!value) return LABELS.justNow;
  return new Date(value).toLocaleString(activeDateLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function timeValue(value?: string) {
  return Date.parse(value ?? "") || 0;
}

function blockUpdatedAt(block: Block) {
  return timeValue(block.updatedAt ?? block.createdAt);
}

function pageTitle(page: Page) {
  return pageDisplayTitle(page);
}

function activityMatchesFilter(activity: Activity, filter: ActivityFilter, readKeys: Set<string>) {
  if (filter === "all") return true;
  if (filter === "unread") return !readKeys.has(activityReadKey(activity));
  if (filter === "comments") {
    return (
      activity.kind === "comment" ||
      (activity.kind === "notification" && notificationMatchesFilter(activity.notification, "comments"))
    );
  }
  if (filter === "mentions") {
    return (
      (activity.kind === "reference" && activity.reference.kind === "mention") ||
      (activity.kind === "notification" && notificationMatchesFilter(activity.notification, "mentions"))
    );
  }
  return (
    activity.kind === "page" ||
    (activity.kind === "reference" && activity.reference.kind !== "mention") ||
    (activity.kind === "notification" && notificationMatchesFilter(activity.notification, "edits"))
  );
}

function activityReadKey(activity: Activity) {
  return activity.kind === "notification"
    ? activity.notification.activityKey
    : updateActivityReadKey(activity);
}

function notificationMetadataSource(notification: NotificationRecord) {
  return typeof notification.metadata?.source === "string" ? notification.metadata.source : "";
}

function notificationMatchesFilter(
  notification: NotificationRecord,
  filter: Exclude<ActivityFilter, "all" | "unread">,
) {
  const source = notificationMetadataSource(notification);
  if (filter === "comments") return notification.kind === "comment" || source === "reply";
  if (filter === "mentions") return notification.kind === "mention";
  return notification.kind === "page_edit" || notification.kind === "link" || notification.kind === "system";
}

function notificationActivityId(notification: NotificationRecord) {
  return `notification:${notification.id || notification.activityKey}`;
}

function notificationActivityAt(notification: NotificationRecord) {
  return timeValue(notification.occurredAt ?? notification.updatedAt ?? notification.createdAt);
}

function activitySection(at: number) {
  const date = new Date(at);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfActivityDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (startOfActivityDay === startOfToday) return LABELS.today;
  if (startOfActivityDay === startOfToday - 86_400_000) return LABELS.yesterday;
  return date.toLocaleDateString(activeDateLocale(), { month: "long", day: "numeric" });
}

function notificationReadKeys(notifications: NotificationRecord[]) {
  return new Set(
    notifications
      .filter((notification) => !!notification.readAt)
      .map((notification) => notification.activityKey),
  );
}

function sameStringSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export function UpdatesPanel({
  initialFilter = "all",
  onClose,
  pageId,
  placement = "sidebar",
  title,
  exiting = false,
}: {
  initialFilter?: ActivityFilter;
  onClose: () => void;
  pageId?: string;
  placement?: "sidebar" | "topbar" | "sidebar-inline";
  title?: string;
  /** When true, the inline placement plays its exit animation before the parent unmounts it. */
  exiting?: boolean;
}) {
  const router = useRouter();
  // "sidebar-inline" renders the feed inside the sidebar column (Notion-style
  // inbox that swaps the page tree) instead of as a floating overlay: no
  // backdrop, no modal focus trap, and no aggressive auto-focus on open.
  const inline = placement === "sidebar-inline";
  const titleId = useId();
  const listId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const pages = useStore(
    useShallow((s) =>
      pageId
        ? s.pagesById[pageId] && !s.pagesById[pageId].inTrash
          ? [s.pagesById[pageId]]
          : []
        : Object.values(s.pagesById)
            .filter((page) => !page.inTrash)
            .sort((a, b) => pageTitle(a).localeCompare(pageTitle(b))),
    ),
  );
  const pagesById = useStore((s) => s.pagesById);
  const commentsByPage = useStore((s) => s.commentsByPage);
  const loadedCommentPages = useStore((s) => s.loadedCommentPages);
  const loadComments = useStore((s) => s.loadComments);
  const blocksByPage = useStore((s) => s.blocksByPage);
  const loadedBlockPages = useStore((s) => s.loadedBlockPages);
  const blockHistory = useStore((s) => (pageId ? s.blockHistoryByPage[pageId] : undefined));
  const undoBlockChange = useStore((s) => s.undoBlockChange);
  const redoBlockChange = useStore((s) => s.redoBlockChange);
  const notify = useStore((s) => s.notify);
  const workspaceId = useStore((s) => s.workspace?.id);
  const userId = useStore((s) => s.userId);
  const [fetchedBlocks, setFetchedBlocks] = useState<Block[]>([]);
  const [referencesLoaded, setReferencesLoaded] = useState(false);
  const [filter, setFilter] = useState<ActivityFilter>(initialFilter);
  const [readActivityKeys, setReadActivityKeys] = useState<Set<string>>(() => readUpdateActivityKeys());
  const [serverReadActivityKeys, setServerReadActivityKeys] = useState<Set<string>>(new Set());
  const [serverNotifications, setServerNotifications] = useState<NotificationRecord[]>([]);
  const panelTitle = title ?? (pageId ? LABELS.pageHistory : LABELS.updates);
  const page = pageId ? pagesById[pageId] : undefined;
  const pageLocked = !!page?.isLocked;
  const availableFilters = useMemo(
    () => ACTIVITY_FILTERS.filter((item) => !pageId || item.value !== "unread"),
    [pageId],
  );
  const activeFilter = pageId && filter === "unread" ? "all" : filter;
  const historyPastCount = blockHistory?.past.length ?? 0;
  const historyFutureCount = blockHistory?.future.length ?? 0;
  const localVersionCount = historyPastCount + historyFutureCount + 1;
  const currentBlocks = pageId ? (blocksByPage[pageId] ?? []) : [];
  const currentVersionAt =
    Math.max(timeValue(page?.updatedAt ?? page?.createdAt), ...currentBlocks.map(blockUpdatedAt)) || 0;
  const previousVersions = useMemo(
    () =>
      [...(blockHistory?.past ?? [])]
        .reverse()
        .slice(0, 8)
        .map((entry, index) => ({
          entry,
          steps: index + 1,
          title: index === 0 ? LABELS.previousVersion : LABELS.versionsAgo(index + 1),
        })),
    [blockHistory],
  );
  const nextVersions = useMemo(
    () =>
      [...(blockHistory?.future ?? [])]
        .reverse()
        .slice(0, 4)
        .map((entry, index) => ({
          entry,
          steps: index + 1,
          title: index === 0 ? LABELS.nextVersion : LABELS.versionsAhead(index + 1),
        })),
    [blockHistory],
  );

  const pageIds = useMemo(() => pages.map((page) => page.id), [pages]);
  const pageIdsKey = pageIds.join("|");

  const applyServerNotifications = useCallback(
    (notifications: NotificationRecord[]) => {
      setServerNotifications(notifications);
      const serverKeys = notificationReadKeys(notifications);
      setServerReadActivityKeys((current) => (sameStringSet(current, serverKeys) ? current : serverKeys));
      if (serverKeys.size === 0) return;
      setReadActivityKeys((current) => {
        const next = compactUpdateReadKeys([...current, ...serverKeys]);
        if (next.length === current.size && next.every((key) => current.has(key))) return current;
        writeUpdateActivityKeys(workspaceId, next);
        return new Set(next);
      });
    },
    [workspaceId],
  );

  const close = useCallback(() => {
    onClose();
    window.requestAnimationFrame(() => {
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
      restoreFocusRef.current = null;
    });
  }, [onClose]);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (inline) return;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [inline]);

  useEffect(() => {
    void Promise.all(pageIds.map((pageId) => loadComments(pageId)));
  }, [loadComments, pageIds, pageIdsKey]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setReadActivityKeys(readUpdateActivityKeys(workspaceId));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setServerNotifications([]);
      setServerReadActivityKeys(new Set());
      return;
    }
    let cancelled = false;
    void listNotificationsRemote({ workspaceId, includeRead: true, limit: 100 })
      .then((result) => {
        if (!cancelled) applyServerNotifications(result.notifications ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setServerNotifications([]);
          setServerReadActivityKeys(new Set());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyServerNotifications, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    listAllBlocks()
      .then((blocks) => {
        if (!cancelled) setFetchedBlocks(blocks);
      })
      .catch(() => {
        if (!cancelled) setFetchedBlocks([]);
      })
      .finally(() => {
        if (!cancelled) setReferencesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loading = pageIds.some((pageId) => !loadedCommentPages.has(pageId)) || !referencesLoaded;

  const activities = useMemo<Activity[]>(() => {
    const scopedPageIds = pageId ? new Set(pageIds) : null;
    const scopedNotifications = serverNotifications.filter((notification) => {
      if (!notificationActivityAt(notification)) return false;
      if (scopedPageIds && (!notification.pageId || !scopedPageIds.has(notification.pageId))) return false;
      return true;
    });
    const serverCommentIds = new Set(
      scopedNotifications
        .map((notification) => notification.commentId)
        .filter((commentId): commentId is string => typeof commentId === "string" && commentId.length > 0),
    );
    const serverReferenceBlockIds = new Set(
      scopedNotifications
        .filter((notification) => !notification.commentId && ["mention", "link"].includes(notification.kind))
        .map((notification) => notification.blockId)
        .filter((blockId): blockId is string => typeof blockId === "string" && blockId.length > 0),
    );
    const commentItems: Activity[] = [];
    for (const [commentPageId, comments] of Object.entries(commentsByPage)) {
      if (scopedPageIds && !scopedPageIds.has(commentPageId)) continue;
      const page = pagesById[commentPageId];
      if (!page || page.inTrash) continue;
      for (const comment of comments) {
        if (serverCommentIds.has(comment.id)) continue;
        commentItems.push({
          kind: "comment",
          id: `comment:${comment.id}`,
          page,
          comment,
          at: timeValue(comment.updatedAt ?? comment.createdAt),
        });
      }
    }

    const pageItems: Activity[] = pages.map((page) => ({
      kind: "page",
      id: `page:${page.id}`,
      page,
      at: timeValue(page.updatedAt ?? page.createdAt),
    }));

    const referenceBlocks = mergedBlocks(fetchedBlocks, blocksByPage, loadedBlockPages);
    const referenceItems: Activity[] = pageReferenceHits(referenceBlocks, pagesById)
      .filter((reference) => !scopedPageIds || scopedPageIds.has(reference.page.id))
      .filter((reference) => !serverReferenceBlockIds.has(reference.block.id))
      .map((reference) => ({
        kind: "reference",
        id: `reference:${reference.block.id}:${reference.targetPage.id}:${reference.kind}`,
        page: reference.page,
        reference,
        at: timeValue(reference.block.updatedAt ?? reference.block.createdAt ?? reference.page.updatedAt),
      }));

    const localItems = [...commentItems, ...referenceItems, ...pageItems];
    const localKeys = new Set(localItems.map((activity) => updateActivityReadKey(activity)));
    const notificationItems: Activity[] = scopedNotifications
      .filter((notification) => !localKeys.has(notification.activityKey))
      .map((notification) => ({
        kind: "notification",
        id: notificationActivityId(notification),
        notification,
        page: notification.pageId ? pagesById[notification.pageId] : undefined,
        at: notificationActivityAt(notification),
      }));

    return [...notificationItems, ...localItems]
      .filter((activity) => activity.at > 0)
      .sort((a, b) => b.at - a.at)
      .slice(0, 40);
  }, [
    blocksByPage,
    commentsByPage,
    fetchedBlocks,
    loadedBlockPages,
    pageId,
    pageIds,
    pages,
    pagesById,
    serverNotifications,
  ]);

  function activityHash(activity: Activity) {
    if (activity.kind === "comment" && activity.comment.blockId) {
      return `#comment-${encodeURIComponent(activity.comment.id)}`;
    }
    if (activity.kind === "reference") {
      return `#block-${encodeURIComponent(activity.reference.block.id)}`;
    }
    if (activity.kind === "notification" && activity.notification.target?.includes("#")) {
      return activity.notification.target.slice(activity.notification.target.indexOf("#"));
    }
    return "";
  }

  function activityActorId(activity: Activity) {
    if (activity.kind === "comment") return activity.comment.authorId;
    if (activity.kind === "notification") return activity.notification.actorId;
    if (activity.kind === "reference") {
      return activity.reference.block.createdBy ?? activity.reference.page.lastEditedBy ?? activity.reference.page.createdBy;
    }
    return activity.page.lastEditedBy ?? activity.page.createdBy;
  }

  function activityNotificationKind(activity: Activity): NotificationActivityInput["kind"] {
    if (activity.kind === "comment") return "comment";
    if (activity.kind === "notification") return activity.notification.kind;
    if (activity.kind === "reference") return activity.reference.kind === "mention" ? "mention" : "link";
    return "page_edit";
  }

  function activityNotificationInput(activity: Activity): NotificationActivityInput {
    if (activity.kind === "notification") {
      return {
        activityKey: activity.notification.activityKey,
        kind: activity.notification.kind,
        pageId: activity.notification.pageId ?? null,
        blockId: activity.notification.blockId ?? null,
        commentId: activity.notification.commentId ?? null,
        actorId: activity.notification.actorId ?? null,
        title: activity.notification.title,
        preview: activity.notification.preview,
        target: activity.notification.target,
        metadata: activity.notification.metadata,
        occurredAt: activity.notification.occurredAt,
      };
    }
    return {
      activityKey: activityReadKey(activity),
      kind: activityNotificationKind(activity),
      pageId: activity.page.id,
      blockId:
        activity.kind === "comment"
          ? activity.comment.blockId ?? null
          : activity.kind === "reference"
            ? activity.reference.block.id
            : null,
      commentId: activity.kind === "comment" ? activity.comment.id : null,
      actorId: activityActorId(activity) ?? null,
      title: pageTitle(activity.page),
      preview: activityPreview(activity),
      target: `${pageHref(activity.page.id)}${activityHash(activity)}`,
      metadata:
        activity.kind === "reference"
          ? {
              referenceKind: activity.reference.kind,
              targetPageId: activity.reference.targetPage.id,
            }
          : undefined,
      occurredAt: new Date(activity.at).toISOString(),
    };
  }

  // The notification-sync effect re-runs on `activitySyncKey` (a content hash of
  // the activities), not on the identity of this per-render transform function.
  // Read it through a ref so the effect isn't forced to list an unstable closure
  // in its deps (which would re-run it on every render).
  const activityNotificationInputRef = useRef(activityNotificationInput);
  useEffect(() => {
    activityNotificationInputRef.current = activityNotificationInput;
  });

  const effectiveReadActivityKeys = useMemo(
    () => new Set([...readActivityKeys, ...serverReadActivityKeys]),
    [readActivityKeys, serverReadActivityKeys],
  );

  const activitySyncKey = useMemo(
    () =>
      workspaceId && !pageId && !loading
        ? activities.map((activity) => activityReadKey(activity)).join("|")
        : "",
    [activities, loading, pageId, workspaceId],
  );

  useEffect(() => {
    if (!workspaceId || pageId || loading || activities.length === 0) return;
    let cancelled = false;
    const localReadKeys = activities
      .map((activity) => activityReadKey(activity))
      .filter((key) => readActivityKeys.has(key));
    void syncNotificationsRemote(workspaceId, activities.map((activity) => activityNotificationInputRef.current(activity)))
      .then(async (result) => {
        if (localReadKeys.length === 0) return result;
        return markNotificationsReadRemote(workspaceId, localReadKeys);
      })
      .then((result) => {
        if (!cancelled) applyServerNotifications(result.notifications ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activities, activitySyncKey, applyServerNotifications, loading, pageId, readActivityKeys, workspaceId]);

  const filterCounts = useMemo(() => {
    return {
      all: activities.length,
      unread: activities.filter((activity) => !effectiveReadActivityKeys.has(activityReadKey(activity))).length,
      comments: activities.filter((activity) => activityMatchesFilter(activity, "comments", effectiveReadActivityKeys)).length,
      mentions: activities.filter((activity) => activityMatchesFilter(activity, "mentions", effectiveReadActivityKeys)).length,
      edits: activities.filter((activity) => activityMatchesFilter(activity, "edits", effectiveReadActivityKeys)).length,
    } satisfies Record<ActivityFilter, number>;
  }, [activities, effectiveReadActivityKeys]);

  const unreadCount = filterCounts.unread;
  // `loading` stays true until every page's comments and all blocks are fetched,
  // which in a large (e.g. imported) workspace can take a long time or never fully
  // settle. Server notifications populate `activities` well before that, so only
  // show the loading state when there is genuinely nothing to render yet; otherwise
  // render what we have and let comments/references fill in progressively.
  const initialLoading = loading && activities.length === 0;

  const visibleActivities = useMemo(
    () => activities.filter((activity) => activityMatchesFilter(activity, activeFilter, effectiveReadActivityKeys)),
    [activeFilter, activities, effectiveReadActivityKeys],
  );

  const groupedActivities = useMemo(() => {
    const groups: { section: string; items: Activity[] }[] = [];
    for (const activity of visibleActivities) {
      const section = activitySection(activity.at);
      const last = groups[groups.length - 1];
      if (last?.section === section) {
        last.items.push(activity);
      } else {
        groups.push({ section, items: [activity] });
      }
    }
    return groups;
  }, [visibleActivities]);

  function openActivity(activity: Activity) {
    markActivityRead(activity);
    if (activity.kind === "notification") {
      const target = activity.notification.target || (activity.notification.pageId ? pageHref(activity.notification.pageId) : "/settings");
      router.push(target);
    } else {
      router.push(`${pageHref(activity.page.id)}${activityHash(activity)}`);
    }
    onClose();
  }

  function markActivityRead(activity: Activity) {
    const key = activityReadKey(activity);
    if (effectiveReadActivityKeys.has(key)) return;
    setReadActivityKeys((current) => {
      const next = compactUpdateReadKeys([...current, key]);
      writeUpdateActivityKeys(workspaceId, next);
      return new Set(next);
    });
    if (workspaceId && !pageId) {
      void markNotificationsReadRemote(workspaceId, [key])
        .then((result) => applyServerNotifications(result.notifications ?? []))
        .catch(() => {});
    }
  }

  function markAllRead() {
    const keys = activities.map((activity) => activityReadKey(activity));
    setReadActivityKeys((current) => {
      const next = compactUpdateReadKeys([...current, ...keys]);
      writeUpdateActivityKeys(workspaceId, next);
      return new Set(next);
    });
    if (workspaceId && !pageId) {
      void markAllNotificationsReadRemote(workspaceId)
        .then((result) => applyServerNotifications(result.notifications ?? []))
        .catch(() => {});
    }
  }

  async function restoreAdjacentVersion(direction: "previous" | "next") {
    if (!pageId) return;
    const ok =
      direction === "previous"
        ? await undoBlockChange(pageId)
        : await redoBlockChange(pageId);
    notify(ok ? LABELS.restoredVersion(direction) : LABELS.noVersion(direction), ok ? "success" : "default");
  }

  async function restoreVersionSteps(direction: "previous" | "next", steps: number) {
    if (!pageId) return;
    let restored = 0;
    for (let step = 0; step < steps; step += 1) {
      const ok =
        direction === "previous"
          ? await undoBlockChange(pageId)
          : await redoBlockChange(pageId);
      if (!ok) break;
      restored += 1;
    }
    notify(
      restored > 0
        ? restored === 1
          ? LABELS.restoredVersion(direction)
          : LABELS.restoredVersions(restored)
        : LABELS.noVersion(direction),
      restored > 0 ? "success" : "default",
    );
  }

  function versionBlockLabel(blockCount: number) {
    return LABELS.blockCount(blockCount);
  }

  function activityBadge(activity: Activity) {
    if (activity.kind === "comment") return LABELS.badgeComment;
    if (activity.kind === "notification") return notificationBadge(activity.notification);
    if (activity.kind === "reference") {
      return activity.reference.kind === "mention" ? LABELS.badgeMention : LABELS.badgeLinked;
    }
    return LABELS.badgeEdited;
  }

  function notificationBadge(notification: NotificationRecord) {
    const source = notificationMetadataSource(notification);
    if (notification.kind === "mention") {
      return source === "reply" ? LABELS.badgeReplyMention : LABELS.badgeMention;
    }
    if (notification.kind === "comment") return source === "reply" ? LABELS.badgeReply : LABELS.badgeComment;
    if (notification.kind === "link") return LABELS.badgeLinked;
    if (notification.kind === "page_edit") return LABELS.badgeEdited;
    if (source === "share") return LABELS.badgeShared;
    if (source === "membership") return LABELS.badgeMember;
    return LABELS.badgeSystem;
  }

  function activityTone(activity: Activity) {
    if (activity.kind === "comment") return "comment";
    if (activity.kind === "notification") return notificationTone(activity.notification);
    if (activity.kind === "reference") return activity.reference.kind === "mention" ? "mention" : "linked";
    return "edited";
  }

  function notificationTone(notification: NotificationRecord) {
    if (notification.kind === "mention") return "mention";
    if (notification.kind === "comment") return "comment";
    if (notification.kind === "link") return "linked";
    if (notification.kind === "page_edit") return "edited";
    return "system";
  }

  function activityTime(activity: Activity) {
    if (activity.kind === "comment") return activity.comment.updatedAt ?? activity.comment.createdAt;
    if (activity.kind === "notification") return activity.notification.occurredAt;
    if (activity.kind === "reference") {
      return activity.reference.block.updatedAt ?? activity.reference.block.createdAt ?? activity.reference.page.updatedAt;
    }
    return activity.page.updatedAt;
  }

  function activityActor(activity: Activity) {
    if (activity.kind === "comment") return LABELS.byActor(actorLabel(activity.comment.authorId, userId));
    if (activity.kind === "notification") {
      return activity.notification.actorId
        ? LABELS.byActor(actorLabel(activity.notification.actorId, userId))
        : LABELS.forYou;
    }
    if (activity.kind === "reference") {
      return LABELS.byActor(actorLabel(
        activity.reference.block.createdBy ?? activity.reference.page.lastEditedBy ?? activity.reference.page.createdBy,
        userId,
      ));
    }
    return LABELS.byActor(actorLabel(activity.page.lastEditedBy ?? activity.page.createdBy, userId));
  }

  function activityPreview(activity: Activity) {
    if (activity.kind === "comment") return richText(activity.comment.body) || LABELS.emptyComment;
    if (activity.kind === "notification") return activity.notification.preview || LABELS.notification;
    if (activity.kind === "reference") {
      return LABELS.referencePreview(
        activity.reference.kind === "mention" ? "mention" : "link",
        pageTitle(activity.reference.targetPage),
        activity.reference.preview,
      );
    }
    return pagePathOrWorkspaceRoot(activity.page, pagesById);
  }

  function activityTitle(activity: Activity) {
    if (activity.kind === "notification") {
      return activity.page ? pageTitle(activity.page) : activity.notification.title || LABELS.workspaceUpdate;
    }
    return pageTitle(activity.page);
  }

  function focusFilterTab(nextFilter: ActivityFilter) {
    window.requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLButtonElement>(`[data-updates-tab="${nextFilter}"]`)
        ?.focus();
    });
  }

  function setFilterAndFocus(nextFilter: ActivityFilter) {
    setFilter(nextFilter);
    focusFilterTab(nextFilter);
  }

  function onFilterTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, currentFilter: ActivityFilter) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const filters = availableFilters.map((item) => item.value);
    const currentIndex = filters.indexOf(currentFilter);
    let nextIndex = currentIndex;
    if (e.key === "ArrowRight") nextIndex = (currentIndex + 1) % filters.length;
    else if (e.key === "ArrowLeft") nextIndex = currentIndex > 0 ? currentIndex - 1 : filters.length - 1;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = filters.length - 1;
    setFilterAndFocus(filters[nextIndex]);
  }

  function panelFocusables() {
    return Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([type="hidden"]):not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function onPanelKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    if (inline) return;
    const focusables = panelFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      {!inline && (
        <button
          type="button"
          className={styles.backdrop}
          onClick={close}
          tabIndex={-1}
          aria-label={LABELS.closeUpdates}
        />
      )}
      <aside
        ref={panelRef}
        className={styles.panel}
        data-placement={placement}
        data-closing={exiting ? "true" : undefined}
        role="dialog"
        aria-modal={inline ? undefined : true}
        aria-labelledby={titleId}
        onKeyDown={onPanelKeyDown}
      >
        <div className={styles.header}>
          <div>
            <div id={titleId} className={styles.title}>
              {panelTitle}
            </div>
            <div className={styles.subtitle}>
              {unreadCount > 0
                ? LABELS.unreadOfTotal(unreadCount, activities.length)
                : LABELS.recentUpdates(activities.length)}
            </div>
          </div>
          <div className={styles.headerActions}>
            {!pageId && (
              <button
                type="button"
                className={styles.markRead}
                onClick={markAllRead}
                disabled={unreadCount === 0}
                aria-label={LABELS.markAllReadAria}
              >
                <CheckIcon size={14} aria-hidden="true" />
                <span>{LABELS.markAllRead}</span>
              </button>
            )}
            <button
              ref={closeRef}
              type="button"
              className={styles.close}
              onClick={close}
              aria-label={LABELS.closeUpdates}
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div className={styles.tabs} role="tablist" aria-label={LABELS.updateType}>
          {availableFilters.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={activeFilter === item.value}
              aria-controls={listId}
              tabIndex={activeFilter === item.value ? 0 : -1}
              data-updates-tab={item.value}
              className={styles.tab}
              onClick={() => setFilter(item.value)}
              onKeyDown={(e) => onFilterTabKeyDown(e, item.value)}
            >
              <span>{item.label}</span>
              <span>{filterCounts[item.value]}</span>
            </button>
          ))}
        </div>

        {pageId && (
          <div className={styles.historyArea}>
            <div className={styles.historyStrip} role="group" aria-label={LABELS.pageHistory}>
              <div className={styles.historyText}>
                <span>{LABELS.versionCount(localVersionCount)}</span>
                <span>
                  {pageLocked
                    ? LABELS.pageLocked
                    : historyPastCount > 0
                      ? LABELS.previousSnapshots(historyPastCount)
                      : LABELS.currentVersionOnly}
                </span>
              </div>
              <div className={styles.historyActions}>
                <button
                  type="button"
                  className={styles.historyButton}
                  onClick={() => void restoreAdjacentVersion("previous")}
                  disabled={pageLocked || historyPastCount === 0}
                >
                  <ArrowLeft size={13} aria-hidden="true" />
                  <span>{LABELS.previous}</span>
                </button>
                <button
                  type="button"
                  className={styles.historyButton}
                  onClick={() => void restoreAdjacentVersion("next")}
                  disabled={pageLocked || historyFutureCount === 0}
                >
                  <span>{LABELS.next}</span>
                  <ArrowRight size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className={styles.versionList} aria-label={LABELS.versionsAria}>
              <div className={styles.versionRow} data-current="true">
                <span className={styles.versionIcon} aria-hidden="true">
                  <ClockIcon size={13} />
                </span>
                <span className={styles.versionText}>
                  <span className={styles.versionTitle}>{LABELS.currentVersion}</span>
                  <span className={styles.versionMeta}>
                    {timeLabelFromMs(currentVersionAt)} · {versionBlockLabel(currentBlocks.length)}
                  </span>
                </span>
              </div>
              {previousVersions.map((version) => (
                <button
                  key={`past:${version.entry.at}:${version.steps}`}
                  type="button"
                  className={styles.versionRow}
                  disabled={pageLocked}
                  onClick={() => void restoreVersionSteps("previous", version.steps)}
                >
                  <span className={styles.versionIcon} aria-hidden="true">
                    <ClockIcon size={13} />
                  </span>
                  <span className={styles.versionText}>
                    <span className={styles.versionTitle}>{version.title}</span>
                    <span className={styles.versionMeta}>
                      {timeLabelFromMs(version.entry.at)} · {versionBlockLabel(version.entry.blocks.length)}
                    </span>
                  </span>
                </button>
              ))}
              {nextVersions.map((version) => (
                <button
                  key={`future:${version.entry.at}:${version.steps}`}
                  type="button"
                  className={styles.versionRow}
                  disabled={pageLocked}
                  onClick={() => void restoreVersionSteps("next", version.steps)}
                >
                  <span className={styles.versionIcon} aria-hidden="true">
                    <ClockIcon size={13} />
                  </span>
                  <span className={styles.versionText}>
                    <span className={styles.versionTitle}>{version.title}</span>
                    <span className={styles.versionMeta}>
                      {timeLabelFromMs(version.entry.at)} · {versionBlockLabel(version.entry.blocks.length)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div id={listId} className={`${styles.list} nscroll`}>
          {initialLoading && <div className={styles.empty} role="status">{LABELS.loadingUpdates}</div>}
          {!initialLoading && activities.length === 0 && (
            <div className={styles.empty} role="status">
              {pageId ? LABELS.noPageHistoryYet : LABELS.noUpdatesYet}
            </div>
          )}
          {!initialLoading && activities.length > 0 && visibleActivities.length === 0 && (
            <div className={styles.empty} role="status">
              {activeFilter === "unread"
                ? LABELS.allCaughtUp
                : LABELS.noFilteredUpdatesYet(
                    availableFilters.find((item) => item.value === activeFilter)?.label ?? "",
                  )}
            </div>
          )}
          {!initialLoading &&
            groupedActivities.map((group) => (
              <section key={group.section} className={styles.section} aria-label={group.section}>
                <div className={styles.sectionLabel}>{group.section}</div>
                <ul className={styles.sectionList} aria-label={`${panelTitle}: ${group.section}`}>
                  {group.items.map((activity) => {
                    const unread = !effectiveReadActivityKeys.has(activityReadKey(activity));
                    return (
                      <li key={activity.id}>
                        <button
                          type="button"
                          className={styles.item}
                          data-unread={unread ? "true" : undefined}
                          onClick={() => openActivity(activity)}
                        >
                          <span className={styles.icon} aria-hidden="true">
                            {activity.kind === "notification" && !activity.page ? (
                              <Bell size={15} />
                            ) : (
                              <PageIconGlyph
                                page={activity.kind === "notification" ? activity.page! : activity.page}
                                size={17}
                              />
                            )}
                          </span>
                          <span className={styles.itemText}>
                            <span className={styles.itemTop}>
                              {unread && (
                                <span
                                  className={styles.unreadDot}
                                  title={LABELS.unreadDot}
                                  aria-label={LABELS.unreadDot}
                                />
                              )}
                              <span className={styles.badge} data-kind={activityTone(activity)}>
                                {activityBadge(activity)}
                              </span>
                              <span>{timeLabel(activityTime(activity))}</span>
                              <span className={styles.actor}>{activityActor(activity)}</span>
                            </span>
                            <span className={styles.itemTitle}>{activityTitle(activity)}</span>
                            <span className={styles.itemPreview}>
                              {activityPreview(activity)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
        </div>
      </aside>
    </>
  );
}
