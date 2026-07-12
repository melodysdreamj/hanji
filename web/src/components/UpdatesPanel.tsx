"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { activeDateLocale } from "@/lib/i18n";
import { i18next } from "@/i18n";
import { InboxChats } from "./InboxChats";
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

const ACTIVITY_FILTER_VALUES: ActivityFilter[] = [
  "all",
  "unread",
  "comments",
  "mentions",
  "edits",
];

function richText(body: unknown) {
  if (typeof body === "string") return body;
  const rich = (body as { rich?: TextSpan[] } | undefined)?.rich;
  return Array.isArray(rich) ? rich.map((span) => span.text).join("") : "";
}

function timeLabel(value?: string) {
  if (!value) return i18next.t("updatesPanel:time.justNow");
  return new Date(value).toLocaleString(activeDateLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function timeLabelFromMs(value?: number) {
  if (!value) return i18next.t("updatesPanel:time.justNow");
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
  if (startOfActivityDay === startOfToday) return i18next.t("updatesPanel:time.today");
  if (startOfActivityDay === startOfToday - 86_400_000) return i18next.t("updatesPanel:time.yesterday");
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
  const { t } = useTranslation(["updatesPanel", "common"]);
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
  // Inbox mode: the notification feed stays intact; "chats" swaps the list
  // for the messenger-style per-page room view (2026-07-10 contract revision).
  const [inboxMode, setInboxMode] = useState<"updates" | "chats">("updates");
  const [readActivityKeys, setReadActivityKeys] = useState<Set<string>>(() => readUpdateActivityKeys());
  const [serverReadActivityKeys, setServerReadActivityKeys] = useState<Set<string>>(new Set());
  const [serverNotifications, setServerNotifications] = useState<NotificationRecord[]>([]);
  const panelTitle =
    title ?? (pageId ? t("updatesPanel:header.pageHistory") : t("updatesPanel:header.updates"));
  const page = pageId ? pagesById[pageId] : undefined;
  const pageLocked = !!page?.isLocked;
  const availableFilters = useMemo(
    () =>
      ACTIVITY_FILTER_VALUES.filter((value) => !pageId || value !== "unread").map((value) => ({
        value,
        label: t(`updatesPanel:filters.${value}`),
      })),
    [pageId, t],
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
          title:
            index === 0
              ? t("updatesPanel:versions.previousVersion")
              : t("updatesPanel:versions.versionsAgo", { count: index + 1 }),
        })),
    [blockHistory, t],
  );
  const nextVersions = useMemo(
    () =>
      [...(blockHistory?.future ?? [])]
        .reverse()
        .slice(0, 4)
        .map((entry, index) => ({
          entry,
          steps: index + 1,
          title:
            index === 0
              ? t("updatesPanel:versions.nextVersion")
              : t("updatesPanel:versions.versionsAhead", { count: index + 1 }),
        })),
    [blockHistory, t],
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
      // Tell the sidebar inbox dot immediately (optimistic) — the server
      // write below can land after the sidebar's close-time refetch, which
      // would otherwise leave a stale unread dot until the next focus poll.
      window.dispatchEvent(
        new CustomEvent("hanji:updates-read-changed", { detail: { allRead: true } }),
      );
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
    notify(
      ok
        ? t(direction === "previous" ? "updatesPanel:versions.restoredPrevious" : "updatesPanel:versions.restoredNext")
        : t(direction === "previous" ? "updatesPanel:versions.noVersionPrevious" : "updatesPanel:versions.noVersionNext"),
      ok ? "success" : "default",
    );
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
          ? t(direction === "previous" ? "updatesPanel:versions.restoredPrevious" : "updatesPanel:versions.restoredNext")
          : t("updatesPanel:versions.restoredVersions", { count: restored })
        : t(direction === "previous" ? "updatesPanel:versions.noVersionPrevious" : "updatesPanel:versions.noVersionNext"),
      restored > 0 ? "success" : "default",
    );
  }

  function versionBlockLabel(blockCount: number) {
    return t("updatesPanel:versions.blockCount", { count: blockCount });
  }

  function activityBadge(activity: Activity) {
    if (activity.kind === "comment") return t("updatesPanel:badges.comment");
    if (activity.kind === "notification") return notificationBadge(activity.notification);
    if (activity.kind === "reference") {
      return activity.reference.kind === "mention"
        ? t("updatesPanel:badges.mention")
        : t("updatesPanel:badges.linked");
    }
    return t("updatesPanel:badges.edited");
  }

  function notificationBadge(notification: NotificationRecord) {
    const source = notificationMetadataSource(notification);
    if (notification.kind === "mention") {
      return source === "reply" ? t("updatesPanel:badges.replyMention") : t("updatesPanel:badges.mention");
    }
    if (notification.kind === "comment")
      return source === "reply" ? t("updatesPanel:badges.reply") : t("updatesPanel:badges.comment");
    if (notification.kind === "link") return t("updatesPanel:badges.linked");
    if (notification.kind === "page_edit") return t("updatesPanel:badges.edited");
    if (source === "share") return t("updatesPanel:badges.shared");
    if (source === "membership") return t("updatesPanel:badges.member");
    return t("updatesPanel:badges.system");
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
    if (activity.kind === "comment")
      return t("updatesPanel:rows.byActor", { name: actorLabel(activity.comment.authorId, userId) });
    if (activity.kind === "notification") {
      return activity.notification.actorId
        ? t("updatesPanel:rows.byActor", { name: actorLabel(activity.notification.actorId, userId) })
        : t("updatesPanel:rows.forYou");
    }
    if (activity.kind === "reference") {
      return t("updatesPanel:rows.byActor", {
        name: actorLabel(
          activity.reference.block.createdBy ?? activity.reference.page.lastEditedBy ?? activity.reference.page.createdBy,
          userId,
        ),
      });
    }
    return t("updatesPanel:rows.byActor", {
      name: actorLabel(activity.page.lastEditedBy ?? activity.page.createdBy, userId),
    });
  }

  function activityPreview(activity: Activity) {
    if (activity.kind === "comment") return richText(activity.comment.body) || t("updatesPanel:rows.emptyComment");
    if (activity.kind === "notification") return activity.notification.preview || t("updatesPanel:rows.notification");
    if (activity.kind === "reference") {
      return t(
        activity.reference.kind === "mention"
          ? "updatesPanel:rows.referenceMention"
          : "updatesPanel:rows.referenceLink",
        {
          title: pageTitle(activity.reference.targetPage),
          preview: activity.reference.preview,
        },
      );
    }
    return pagePathOrWorkspaceRoot(activity.page, pagesById);
  }

  function activityTitle(activity: Activity) {
    if (activity.kind === "notification") {
      return activity.page
        ? pageTitle(activity.page)
        : activity.notification.title || t("updatesPanel:rows.workspaceUpdate");
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
          aria-label={t("updatesPanel:header.closeUpdates")}
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
          <div className={styles.headerText}>
            <div id={titleId} className={styles.title}>
              {panelTitle}
            </div>
            <div className={styles.subtitle}>
              {unreadCount > 0
                ? t("updatesPanel:header.unreadOfTotal", { unread: unreadCount, total: activities.length })
                : t("updatesPanel:header.recentUpdates", { count: activities.length })}
            </div>
          </div>
          <div className={styles.headerActions}>
            {!pageId && (
              <div className={styles.modeToggle} role="tablist" aria-label={t("updatesPanel:header.inboxMode")}>
                {([
                  ["updates", t("updatesPanel:header.modeUpdates")],
                  ["chats", t("updatesPanel:header.modeChats")],
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={inboxMode === mode}
                    data-inbox-mode={mode}
                    className={styles.modeButton}
                    onClick={() => setInboxMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {!pageId && inboxMode === "updates" && (
              <button
                type="button"
                className={styles.markRead}
                onClick={markAllRead}
                disabled={unreadCount === 0}
                aria-label={t("updatesPanel:header.markAllReadAria")}
              >
                <CheckIcon size={14} aria-hidden="true" />
                <span>{t("updatesPanel:header.markAllRead")}</span>
              </button>
            )}
            <button
              ref={closeRef}
              type="button"
              className={styles.close}
              onClick={close}
              aria-label={t("updatesPanel:header.closeUpdates")}
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {(pageId || inboxMode === "updates") && (
        <div className={styles.tabs} role="tablist" aria-label={t("updatesPanel:header.updateType")}>
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
        )}

        {!pageId && inboxMode === "chats" && workspaceId && (
          <InboxChats workspaceId={workspaceId} />
        )}

        {pageId && (
          <div className={styles.historyArea}>
            <div className={styles.historyStrip} role="group" aria-label={t("updatesPanel:header.pageHistory")}>
              <div className={styles.historyText}>
                <span>{t("updatesPanel:versions.versionCount", { count: localVersionCount })}</span>
                <span>
                  {pageLocked
                    ? t("updatesPanel:versions.pageLocked")
                    : historyPastCount > 0
                      ? t("updatesPanel:versions.previousSnapshots", { count: historyPastCount })
                      : t("updatesPanel:versions.currentVersionOnly")}
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
                  <span>{t("updatesPanel:versions.previous")}</span>
                </button>
                <button
                  type="button"
                  className={styles.historyButton}
                  onClick={() => void restoreAdjacentVersion("next")}
                  disabled={pageLocked || historyFutureCount === 0}
                >
                  <span>{t("updatesPanel:versions.next")}</span>
                  <ArrowRight size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className={styles.versionList} aria-label={t("updatesPanel:versions.versionsAria")}>
              <div className={styles.versionRow} data-current="true">
                <span className={styles.versionIcon} aria-hidden="true">
                  <ClockIcon size={13} />
                </span>
                <span className={styles.versionText}>
                  <span className={styles.versionTitle}>{t("updatesPanel:versions.currentVersion")}</span>
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

        {(pageId || inboxMode === "updates") && (
        <div id={listId} className={`${styles.list} nscroll`}>
          {initialLoading && <div className={styles.empty} role="status">{t("updatesPanel:empty.loadingUpdates")}</div>}
          {!initialLoading && activities.length === 0 && (
            <div className={styles.empty} role="status">
              {pageId ? t("updatesPanel:empty.noPageHistoryYet") : t("updatesPanel:empty.noUpdatesYet")}
            </div>
          )}
          {!initialLoading && activities.length > 0 && visibleActivities.length === 0 && (
            <div className={styles.empty} role="status">
              {activeFilter === "unread"
                ? t("updatesPanel:empty.allCaughtUp")
                : t("updatesPanel:empty.noFilteredUpdatesYet", {
                    filter: (
                      availableFilters.find((item) => item.value === activeFilter)?.label ?? ""
                    ).toLowerCase(),
                  })}
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
                                  title={t("updatesPanel:rows.unreadDot")}
                                  aria-label={t("updatesPanel:rows.unreadDot")}
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
        )}
      </aside>
    </>
  );
}
