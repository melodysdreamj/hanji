"use client";

import {
  lazy,
  Suspense,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useRouter } from "@/lib/router";
import { copyText } from "@/lib/clipboard";
import {
  getPageAccessRemote,
  invitePageAccessRemote,
  removePagePermissionRemote,
  searchOrganizationPeopleRemote,
  setPageWebSharingRemote,
  updatePagePermissionRemote,
} from "@/lib/edgebase";
import { activeDateLocale, pickLabels } from "@/lib/i18n";
import { isSyntheticNotionImportRootPage } from "@/lib/importedNotionUi";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { isPageVerified } from "@/lib/pageVerification";
import { canEditPage } from "@/lib/permissions";
import type {
  BacklinksDisplay,
  Block,
  Page,
  PageCommentsDisplay,
  PageFont,
  PagePermission,
  OrganizationProfile,
  SharePrincipalType,
  ShareLink,
  ShareRole,
} from "@/lib/types";
import { spansToPlainText } from "@/lib/types";
import { absolutePageUrl, openPageInNewTab, pageHref } from "@/lib/navigation";
import { getOfflinePins, setOfflinePin } from "@/lib/recordCache";
import { isPageOfflineReady, useStore, warmPageOfflineScope } from "@/lib/store";
import { actorLabel } from "./database/people";
import {
  ChevronDown,
  ChevronRight,
  ClockIcon,
  Copy,
  Download,
  DotsHorizontal,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  MenuIcon,
  MoveIcon,
  OpenInNew,
  SharePeopleIcon,
  Settings,
  Star,
  StarFilled,
  Trash,
  UnlockIcon,
  Upload,
  CheckIcon,
  CommentIcon,
} from "@/icons/hanji";
import { PageIconGlyph } from "./PageIcon";
import { PagePresence, type PagePresenceSnapshot } from "./PagePresence";
import styles from "./TopBar.module.css";

const MoveToDialog = lazy(() =>
  import("./MoveToDialog").then(({ MoveToDialog }) => ({ default: MoveToDialog }))
);
const UpdatesPanel = lazy(() =>
  import("./UpdatesPanel").then(({ UpdatesPanel }) => ({ default: UpdatesPanel }))
);

type CopyTarget = "page" | "web";

function menuItems(root: HTMLDivElement | null) {
  return Array.from(
    root?.querySelectorAll<HTMLButtonElement>("[data-menu-item]") ?? [],
  ).filter((item) => !item.disabled && item.offsetParent !== null && item.tabIndex >= 0);
}

function menuFocusables(root: HTMLDivElement | null) {
  return Array.from(
    root?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([type="hidden"]):not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
}

function moveMenuFocus(
  e: ReactKeyboardEvent<HTMLDivElement>,
  root: HTMLDivElement | null,
) {
  if (!["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(e.key)) return;
  const items = menuItems(root);
  if (items.length === 0) return;

  e.preventDefault();
  e.stopPropagation();
  const activeIndex = items.findIndex((item) => item === document.activeElement);
  let nextIndex = activeIndex >= 0 ? activeIndex : 0;

  if (e.key === "ArrowDown") {
    nextIndex = activeIndex >= 0 ? (activeIndex + 1) % items.length : 0;
  } else if (e.key === "ArrowUp") {
    nextIndex = activeIndex > 0 ? activeIndex - 1 : items.length - 1;
  } else if (e.key === "PageDown") {
    nextIndex = Math.min((activeIndex >= 0 ? activeIndex : 0) + 5, items.length - 1);
  } else if (e.key === "PageUp") {
    nextIndex = Math.max((activeIndex >= 0 ? activeIndex : items.length - 1) - 5, 0);
  } else if (e.key === "Home") {
    nextIndex = 0;
  } else if (e.key === "End") {
    nextIndex = items.length - 1;
  }

  items[nextIndex]?.focus();
}

function onTopbarMenuKeyDown(
  e: ReactKeyboardEvent<HTMLDivElement>,
  root: HTMLDivElement | null,
  onClose: () => void,
) {
  if (e.defaultPrevented) return;
  if (isComposingKeyEvent(e)) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    onClose();
    return;
  }
  if (e.key === "Tab") {
    const focusables = menuFocusables(root);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      e.stopPropagation();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      e.stopPropagation();
      first.focus();
    }
    return;
  }
  moveMenuFocus(e, root);
}

const PAGE_FONTS: { value: PageFont; sample: string }[] = [
  { value: "default", sample: "Ag" },
  { value: "serif", sample: "Ag" },
  { value: "mono", sample: "Ag" },
];
const BACKLINKS_DISPLAY_OPTIONS: { value: BacklinksDisplay }[] = [
  { value: "default" },
  { value: "expanded" },
  { value: "off" },
];
const PAGE_COMMENTS_DISPLAY_OPTIONS: { value: PageCommentsDisplay }[] = [
  { value: "default" },
  { value: "expanded" },
  { value: "off" },
];
const EMPTY_BLOCKS: Block[] = [];
const EMPTY_CRUMB_PAGES: Page[] = [];
const SIDEBAR_COLLAPSED_KEY = "notionlike:sidebar-collapsed";

const TOPBAR_LABELS = {
  en: {
    addComment: "Add comment",
    addCommentTo: (pageTitle: string) => `Add comment to ${pageTitle}`,
    addFavorite: (pageTitle: string) => `Add ${pageTitle} to favorites`,
    anyoneWithLink: "Anyone with the link",
    canViewAccessNotice:
      "You can view access, but only owners, admins, and full access users can change sharing.",
    canComment: "Can comment",
    canEdit: "Can edit",
    canView: "Can view",
    closePageMenu: "Close page menu",
    closeSidebar: "Close sidebar",
    comment: (count: number) => `Comment${count ? ` ${count}` : ""}`,
    copiedPageLink: "Copied page link",
    copiedWebLink: "Copied web link",
    copyPageLink: (copied: boolean) => (copied ? "Copied page link" : "Copy link"),
    copyPageLinkButton: "Copy page link",
    copyWebLink: "Copy web link",
    customExpiration: "Custom expiration",
    disableWebSharing: (pageTitle: string) => `Disable web sharing for ${pageTitle}`,
    enableWebSharing: (pageTitle: string) => `Enable web sharing for ${pageTitle}`,
    expired: "Expired",
    expiresAt: (formatted: string) => `Expires ${formatted}`,
    fullAccess: "Full access",
    guest: "Guest",
    group: "Group",
    integration: "Integration",
    hiddenBreadcrumbPages: "Hidden breadcrumb pages",
    verified: "Verified",
    locked: "Locked",
    removeVerificationFor: (pageTitle: string) => `Remove verification for ${pageTitle}`,
    unlockNamedPage: (pageTitle: string) => `Unlock ${pageTitle}`,
    removeFromFavorites: "Remove from Favorites",
    addToFavorites: "Add to Favorites",
    openInNewTab: "Open in new tab",
    availableOffline: "Available offline",
    duplicate: "Duplicate",
    moveTo: "Move to",
    exporting: "Exporting…",
    exportAsMarkdown: "Export as Markdown",
    exportAsHanji: "Export as Hanji file",
    importing: "Importing…",
    importMarkdown: "Import Markdown",
    unlockPage: "Unlock page",
    lockPage: "Lock page",
    pageHistory: "Page history",
    removeVerification: "Remove verification",
    verifyPage: "Verify page",
    customizePage: "Customize page",
    backlinks: "Backlinks",
    backlinksDisplay: "Backlinks display",
    pageComments: "Page comments",
    pageCommentsDisplay: "Page comments display",
    style: "Style",
    pageFont: "Page font",
    fontDefault: "Default",
    fontSerif: "Serif",
    fontMono: "Mono",
    displayDefault: "Default",
    displayExpanded: "Expanded",
    customized: "Customized",
    smallText: "Small text",
    fullWidth: "Full width",
    created: "Created",
    createdBy: "Created by",
    lastEdited: "Last edited",
    editedBy: "Edited by",
    words: "Words",
    characters: "Characters",
    blocks: "Blocks",
    moveToTrash: "Move to Trash",
    invite: "Invite",
    invitePeople: "Invite people",
    invitePlaceholder: "Add people, groups, or emails",
    linkExpires: "Link expires",
    memberStatusFallback: "Organization member",
    newInvitePermission: "New invite permission",
    never: "Never",
    neverExpires: "Never expires",
    off: "Off",
    offlinePinPending:
      "Marked for offline use. Some items will finish saving on your next online visit.",
    offlinePinReady: "This page is now available offline.",
    offlinePinRemoved: "Offline use turned off.",
    on: "On",
    oneDay: "24 hours",
    openSidebar: "Open sidebar",
    moreActions: (pageTitle: string) => `More actions for ${pageTitle}`,
    openComments: (count: number, pageTitle: string) =>
      `Open ${count} comment${count === 1 ? "" : "s"} for ${pageTitle}`,
    organizationGroups: "Organization groups",
    organizationPeople: "Organization people",
    pageActions: "Page actions",
    pageFallback: "page",
    pendingCount: (count: number) => `${count} pending`,
    privateAccess: "Private",
    publish: "Publish",
    publicLinkExpiration: "Public link expiration",
    removeFavorite: (pageTitle: string) => `Remove ${pageTitle} from favorites`,
    removeAccess: "Remove",
    share: "Share",
    shareDialog: (pageTitle: string) => `Share ${pageTitle}`,
    sharePage: (pageTitle: string) => `Share ${pageTitle}`,
    shareToWeb: "Share to web",
    sevenDays: "7 days",
    thirtyDays: "30 days",
    undo: "Undo",
    member: "Member",
    justNow: "Just now",
    todayAt: (time: string) => `Today at ${time}`,
    yesterdayAt: (time: string) => `Yesterday at ${time}`,
    dateAt: (date: string, time: string) => `${date} at ${time}`,
    toast: {
      pageAccessRequired: "Page access required.",
      couldntCopyLink: "Couldn't copy link",
      verificationRemoved: "Verification removed",
      pageVerified: "Page verified",
      removedFromFavorites: "Removed from Favorites",
      addedToFavorites: "Added to Favorites",
      couldntUpdateFavorites: "Couldn't update Favorites",
      couldntDuplicatePage: "Couldn't duplicate page",
      duplicatedPage: "Duplicated page",
      pageLocked: "Page locked",
      pageUnlocked: "Page unlocked",
      movedToTrash: "Moved to Trash",
      restoredPage: "Restored page",
      couldntMoveToTrash: "Couldn't move to Trash",
      exportedMarkdown: "Exported Markdown",
      couldntExportMarkdown: "Couldn't export Markdown",
      exportedHanji: "Exported as an Hanji file.",
      exportedHanjiWithPlaceholders:
        "Exported as an Hanji file — attachments were left as placeholders.",
      couldntExportHanji: "Couldn't export Hanji file.",
      importedBlocks: (count: number) => `Imported ${count} block${count === 1 ? "" : "s"}`,
      nothingToImport: "Nothing to import",
      couldntImportMarkdown: "Couldn't import Markdown",
      cantChangeSharing: "You can't change sharing for this page",
      webSharingEnabled: "Web sharing enabled",
      webSharingDisabled: "Web sharing disabled",
      couldntUpdateWebSharing: "Couldn't update web sharing",
      updatedWebLinkExpiration: "Updated web link expiration",
      couldntUpdateWebLink: "Couldn't update web link",
      alreadyHasAccess: "Already has access",
      addedToAccessList: "Added to access list",
      couldntAddAccess: "Couldn't add access",
      couldntUpdateAccess: "Couldn't update access",
      removedFromAccessList: "Removed from access list",
      couldntRemoveAccess: "Couldn't remove access",
      couldntLoadAccessList: "Couldn't load access list",
    },
    user: "User",
    whoHasAccess: "Who has access",
    workspace: "Workspace",
    workspaceCount: (count: number) => `${count} workspace${count === 1 ? "" : "s"}`,
    you: "You",
  },
  ko: {
    addComment: "댓글 추가",
    addCommentTo: (pageTitle: string) => `${pageTitle}에 댓글 추가`,
    addFavorite: (pageTitle: string) => `${pageTitle} 즐겨찾기에 추가`,
    anyoneWithLink: "링크가 있는 모든 사용자",
    canViewAccessNotice:
      "접근 권한을 볼 수 있지만, 공유 변경은 소유자, 관리자, 전체 권한 사용자만 할 수 있습니다.",
    canComment: "댓글 가능",
    canEdit: "편집 가능",
    canView: "보기 가능",
    closePageMenu: "페이지 메뉴 닫기",
    closeSidebar: "사이드바 닫기",
    comment: (count: number) => `댓글${count ? ` ${count}` : ""}`,
    copiedPageLink: "페이지 링크 복사됨",
    copiedWebLink: "웹 링크 복사됨",
    copyPageLink: (copied: boolean) => (copied ? "페이지 링크 복사됨" : "링크 복사"),
    copyPageLinkButton: "페이지 링크 복사",
    copyWebLink: "웹 링크 복사",
    customExpiration: "사용자 지정 만료",
    disableWebSharing: (pageTitle: string) => `${pageTitle} 웹 공유 끄기`,
    enableWebSharing: (pageTitle: string) => `${pageTitle} 웹 공유 켜기`,
    expired: "만료됨",
    expiresAt: (formatted: string) => `${formatted} 만료`,
    fullAccess: "전체 권한",
    guest: "게스트",
    group: "그룹",
    integration: "연동",
    hiddenBreadcrumbPages: "숨겨진 상위 페이지",
    verified: "인증됨",
    locked: "잠김",
    removeVerificationFor: (pageTitle: string) => `${pageTitle} 인증 해제`,
    unlockNamedPage: (pageTitle: string) => `${pageTitle} 잠금 해제`,
    removeFromFavorites: "즐겨찾기에서 제거",
    addToFavorites: "즐겨찾기에 추가",
    openInNewTab: "새 탭에서 열기",
    availableOffline: "오프라인에서 사용",
    duplicate: "복제",
    moveTo: "이동",
    exporting: "내보내는 중…",
    exportAsMarkdown: "마크다운으로 내보내기",
    exportAsHanji: "Hanji 파일로 내보내기",
    importing: "가져오는 중…",
    importMarkdown: "마크다운 가져오기",
    unlockPage: "페이지 잠금 해제",
    lockPage: "페이지 잠금",
    pageHistory: "페이지 기록",
    removeVerification: "인증 해제",
    verifyPage: "페이지 인증",
    customizePage: "페이지 맞춤 설정",
    backlinks: "백링크",
    backlinksDisplay: "백링크 표시",
    pageComments: "페이지 댓글",
    pageCommentsDisplay: "페이지 댓글 표시",
    style: "스타일",
    pageFont: "페이지 글꼴",
    fontDefault: "기본",
    fontSerif: "세리프",
    fontMono: "고정폭",
    displayDefault: "기본",
    displayExpanded: "펼침",
    customized: "사용자 지정",
    smallText: "작은 텍스트",
    fullWidth: "전체 너비",
    created: "생성",
    createdBy: "생성자",
    lastEdited: "마지막 편집",
    editedBy: "편집자",
    words: "단어",
    characters: "문자",
    blocks: "블록",
    moveToTrash: "휴지통으로 이동",
    invite: "초대",
    invitePeople: "사용자 초대",
    invitePlaceholder: "사용자, 그룹 또는 이메일 추가",
    linkExpires: "링크 만료",
    memberStatusFallback: "조직 멤버",
    newInvitePermission: "새 초대 권한",
    never: "없음",
    neverExpires: "만료 없음",
    off: "끔",
    offlinePinPending:
      "오프라인 사용으로 표시했어요. 일부 항목은 다음 온라인 방문에서 마저 저장돼요.",
    offlinePinReady: "이 페이지를 오프라인에서 사용할 수 있어요.",
    offlinePinRemoved: "오프라인 사용을 해제했어요.",
    on: "켬",
    oneDay: "24시간",
    openSidebar: "사이드바 열기",
    moreActions: (pageTitle: string) => `${pageTitle} 더보기`,
    openComments: (count: number, pageTitle: string) => `${pageTitle} 댓글 ${count}개 열기`,
    organizationGroups: "조직 그룹",
    organizationPeople: "조직 사용자",
    pageActions: "페이지 작업",
    pageFallback: "페이지",
    pendingCount: (count: number) => `대기 ${count}개`,
    privateAccess: "비공개",
    publish: "게시",
    publicLinkExpiration: "공개 링크 만료",
    removeFavorite: (pageTitle: string) => `${pageTitle} 즐겨찾기에서 제거`,
    removeAccess: "권한 제거",
    share: "공유",
    shareDialog: (pageTitle: string) => `${pageTitle} 공유`,
    sharePage: (pageTitle: string) => `${pageTitle} 공유`,
    shareToWeb: "웹에 공유",
    sevenDays: "7일",
    thirtyDays: "30일",
    undo: "실행 취소",
    member: "멤버",
    justNow: "방금",
    todayAt: (time: string) => `오늘 ${time}`,
    yesterdayAt: (time: string) => `어제 ${time}`,
    dateAt: (date: string, time: string) => `${date} ${time}`,
    toast: {
      pageAccessRequired: "페이지 접근 권한이 필요합니다.",
      couldntCopyLink: "링크를 복사하지 못했습니다",
      verificationRemoved: "인증이 해제되었습니다",
      pageVerified: "페이지가 인증되었습니다",
      removedFromFavorites: "즐겨찾기에서 제거됨",
      addedToFavorites: "즐겨찾기에 추가됨",
      couldntUpdateFavorites: "즐겨찾기를 업데이트하지 못했습니다",
      couldntDuplicatePage: "페이지를 복제하지 못했습니다",
      duplicatedPage: "페이지를 복제했습니다",
      pageLocked: "페이지가 잠겼습니다",
      pageUnlocked: "페이지 잠금이 해제되었습니다",
      movedToTrash: "휴지통으로 이동됨",
      restoredPage: "페이지를 복원했습니다",
      couldntMoveToTrash: "휴지통으로 이동하지 못했습니다",
      exportedMarkdown: "마크다운을 내보냈습니다",
      couldntExportMarkdown: "마크다운을 내보내지 못했습니다",
      exportedHanji: "Hanji 파일로 내보냈습니다.",
      exportedHanjiWithPlaceholders:
        "Hanji 파일로 내보냈습니다. 첨부 파일은 자리표시자로 남았습니다.",
      couldntExportHanji: "Hanji 파일을 내보내지 못했습니다.",
      importedBlocks: (count: number) => `블록 ${count}개를 가져왔습니다`,
      nothingToImport: "가져올 내용이 없습니다",
      couldntImportMarkdown: "마크다운을 가져오지 못했습니다",
      cantChangeSharing: "이 페이지의 공유를 변경할 수 없습니다",
      webSharingEnabled: "웹 공유가 켜졌습니다",
      webSharingDisabled: "웹 공유가 꺼졌습니다",
      couldntUpdateWebSharing: "웹 공유를 업데이트하지 못했습니다",
      updatedWebLinkExpiration: "웹 링크 만료를 업데이트했습니다",
      couldntUpdateWebLink: "웹 링크를 업데이트하지 못했습니다",
      alreadyHasAccess: "이미 접근 권한이 있습니다",
      addedToAccessList: "접근 목록에 추가됨",
      couldntAddAccess: "접근 권한을 추가하지 못했습니다",
      couldntUpdateAccess: "접근 권한을 업데이트하지 못했습니다",
      removedFromAccessList: "접근 목록에서 제거됨",
      couldntRemoveAccess: "접근 권한을 제거하지 못했습니다",
      couldntLoadAccessList: "접근 목록을 불러오지 못했습니다",
    },
    user: "사용자",
    whoHasAccess: "접근 권한",
    workspace: "워크스페이스",
    workspaceCount: (count: number) => `워크스페이스 ${count}개`,
    you: "나",
  },
} as const;

type TopbarLabels = (typeof TOPBAR_LABELS)[keyof typeof TOPBAR_LABELS];

function topbarLabels() {
  return pickLabels(TOPBAR_LABELS);
}

function pageFontLabel(value: PageFont, labels: TopbarLabels) {
  if (value === "serif") return labels.fontSerif;
  if (value === "mono") return labels.fontMono;
  return labels.fontDefault;
}

function pageDisplayOptionLabel(
  value: BacklinksDisplay | PageCommentsDisplay,
  labels: TopbarLabels
) {
  if (value === "expanded") return labels.displayExpanded;
  if (value === "off") return labels.off;
  return labels.displayDefault;
}

function blockPlainText(block: Block) {
  const content = block.content;
  return [
    block.plainText || spansToPlainText(content?.rich),
    spansToPlainText(content?.caption),
    content?.expression,
    content?.fileName,
    content?.table?.flat().join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

function countWords(text: string) {
  return (
    text.match(
      /[\uac00-\ud7af]+|[\u3040-\u30ff\u3400-\u9fff]|[A-Za-z0-9]+(?:[’'-][A-Za-z0-9]+)*/g,
    )?.length ?? 0
  );
}

function isSameLocalDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatMenuTimestamp(value: string | undefined, labels: TopbarLabels) {
  if (!value) return labels.justNow;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return labels.justNow;

  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const locale = activeDateLocale();
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

  if (isSameLocalDay(date, now)) return labels.todayAt(time);
  if (isSameLocalDay(date, yesterday)) return labels.yesterdayAt(time);

  const datePart = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
  return labels.dateAt(datePart, time);
}

function pageDocumentStats(blocks: Block[]) {
  const text = blocks.map(blockPlainText).join(" ").trim();
  return {
    blocks: blocks.length,
    characters: Array.from(text.replace(/\s/g, "")).length,
    words: countWords(text),
  };
}

export function TopBar({
  pageId,
  presence,
  scrolled = false,
  title,
}: {
  pageId?: string;
  presence?: PagePresenceSnapshot;
  scrolled?: boolean;
  title?: string;
}) {
  const router = useRouter();
  // Narrow subscriptions (no whole-pagesById map): the top bar renders only
  // the active page, its ancestor crumbs, and a couple of derived booleans,
  // so unrelated page edits must not re-render it.
  const page = useStore((s) => (pageId ? s.pagesById[pageId] : undefined));
  const pageRoles = useStore((s) => s.pageRolesById);
  const workspace = useStore((s) => s.workspace);
  const currentMember = useStore((s) => s.currentMember);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed);
  const pageBlocks = useStore((s) => (pageId ? s.blocksByPage[pageId] ?? EMPTY_BLOCKS : EMPTY_BLOCKS));
  const duplicatePage = useStore((s) => s.duplicatePage);
  const updatePage = useStore((s) => s.updatePage);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const trashPage = useStore((s) => s.trashPage);
  const restorePage = useStore((s) => s.restorePage);
  const openComments = useStore((s) => s.openComments);
  const notify = useStore((s) => s.notify);
  const userId = useStore((s) => s.userId);
  const commentCount = useStore((s) =>
    pageId
      ? (s.commentsByPage[pageId]?.filter(
          // Match PageHeader: count only page-level (non-block-anchored)
          // unresolved comments, since this button opens the page comments.
          (comment) => !comment.blockId && !comment.parentId && !comment.resolved,
        ).length ?? 0)
      : 0
  );
  const [shareOpenFor, setShareOpenFor] = useState<string | null>(null);
  const [moreOpenFor, setMoreOpenFor] = useState<string | null>(null);
  const [crumbMenuOpenFor, setCrumbMenuOpenFor] = useState<string | null>(null);
  const [historyOpenFor, setHistoryOpenFor] = useState<string | null>(null);
  const [moveOpenFor, setMoveOpenFor] = useState<string | null>(null);
  const [customizeOpenFor, setCustomizeOpenFor] = useState<string | null>(null);
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const [exportingFor, setExportingFor] = useState<string | null>(null);
  const [importingFor, setImportingFor] = useState<string | null>(null);
  const [offlinePinned, setOfflinePinned] = useState(false);
  const [crumbMenuStyle, setCrumbMenuStyle] = useState<CSSProperties | undefined>();
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const crumbMenuRef = useRef<HTMLDivElement>(null);
  const crumbButtonRef = useRef<HTMLButtonElement>(null);
  const shareButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const activeMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingImportPageRef = useRef<Page | null>(null);
  const shareMenuId = useId();
  const moreMenuId = useId();
  const labels = topbarLabels();
  const pageTitle = page ? pageDisplayTitle(page) : title ?? labels.pageFallback;
  const pageStats = page ? pageDocumentStats(pageBlocks) : { blocks: 0, characters: 0, words: 0 };
  const backlinksDisplay = page?.backlinksDisplay ?? "default";
  const pageCommentsDisplay = page?.pageCommentsDisplay ?? "default";
  const customizeSummaryLabel =
    backlinksDisplay === "default" && pageCommentsDisplay === "default"
      ? labels.displayDefault
      : labels.customized;
  const pageLocked = !!page?.isLocked;
  const pageVerified = isPageVerified(page);
  const shareOpen = !!pageId && shareOpenFor === pageId;
  const moreOpen = !!pageId && moreOpenFor === pageId;
  const crumbMenuOpen = !!pageId && crumbMenuOpenFor === pageId;
  const historyOpen = !!pageId && historyOpenFor === pageId;
  const moveOpen = !!pageId && moveOpenFor === pageId;
  const customizeOpen = !!pageId && customizeOpenFor === pageId;
  const copiedPageLink = !!pageId && copiedFor === `${pageId}:page`;
  const copiedWebLink = !!pageId && copiedFor === `${pageId}:web`;
  const canEditThisPage = useStore((s) => {
    const current = pageId ? s.pagesById[pageId] : undefined;
    return (
      !!current &&
      canEditPage({
        page: current,
        pagesById: s.pagesById,
        pageRoles: s.pageRolesById,
        workspace: s.workspace,
        currentMember: s.currentMember,
        userId: s.userId,
      })
    );
  });

  function canEditTarget(target: Page) {
    if (target.id === page?.id) return canEditThisPage;
    // Event-time read: the full page map is only needed for the ancestor-lock
    // walk inside canEditPage, so don't subscribe to it.
    const pagesById = useStore.getState().pagesById;
    return canEditPage({ page: target, pagesById, pageRoles, workspace, currentMember, userId });
  }

  // Offline pin (local-first Phase 3): pinned pages are exempt from record
  // cache eviction; toggling on also makes sure the blocks are cached.
  useEffect(() => {
    if (!pageId || !userId) return;
    let mounted = true;
    void getOfflinePins(userId).then((pins) => {
      if (mounted) setOfflinePinned(!!pins[pageId]);
    });
    return () => {
      mounted = false;
    };
  }, [pageId, userId]);

  async function toggleOfflinePin(target: Page) {
    if (!userId) return;
    const next = !offlinePinned;
    setOfflinePinned(next);
    await setOfflinePin(userId, target.id, next);
    if (next) {
      // Pin scope: cache the page's blocks and its embedded databases now.
      const dbIds = await warmPageOfflineScope(target.id);
      for (const dbId of dbIds.slice(0, 5)) {
        await useStore.getState().loadDatabase(dbId, {}).catch(() => {});
      }
      const ready = await isPageOfflineReady(target.id).catch(() => false);
      useStore
        .getState()
        .notify(
          ready ? topbarLabels().offlinePinReady : topbarLabels().offlinePinPending,
          "default"
        );
    } else {
      useStore.getState().notify(topbarLabels().offlinePinRemoved, "default");
    }
  }

  // Build ancestry breadcrumb for a page. Subscribed shallowly to just the
  // ancestor chain so edits to unrelated pages don't re-render the top bar.
  const crumbPages = useStore(
    useShallow((s) => {
      if (!pageId) return EMPTY_CRUMB_PAGES;
      const chain: Page[] = [];
      let cur: Page | undefined = s.pagesById[pageId];
      const guard = new Set<string>();
      while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        chain.unshift(cur);
        cur = cur.parentId ? s.pagesById[cur.parentId] : undefined;
      }
      return chain;
    })
  );
  const crumbs = crumbPages.map((crumb) => ({
    id: crumb.id,
    label: pageDisplayTitle(crumb),
    page: crumb,
  }));
  const displayCrumbs = crumbs.filter((crumb) => !isSyntheticNotionImportRootPage(crumb.page));

  function pageUrl() {
    if (!pageId) return "";
    return absolutePageUrl(pageId, { preserveCurrentSearch: true, omitSearchParams: ["p", "pm"] });
  }

  async function copyLink(href?: string, target: CopyTarget = "page") {
    const url = href || pageUrl();
    if (!url) return;
    const ok = await copyText(url);
    const copiedKey = pageId ? `${pageId}:${target}` : null;
    setCopiedFor(copiedKey);
    window.setTimeout(() => {
      setCopiedFor((current) => (current === copiedKey ? null : current));
    }, 1200);
    notify(
      ok
        ? (target === "web" ? labels.copiedWebLink : labels.copiedPageLink)
        : labels.toast.couldntCopyLink,
      ok ? "success" : "error",
    );
  }

  function togglePageVerification(target: Page) {
    if (!canEditTarget(target)) {
      notify(labels.toast.pageAccessRequired, "default");
      return;
    }
    const verified = isPageVerified(target);
    updatePage(
      target.id,
      verified
        ? {
            verifiedAt: null,
            verifiedBy: null,
            verificationExpiresAt: null,
          }
        : {
            verifiedAt: new Date().toISOString(),
            verifiedBy: userId || "local-user",
            verificationExpiresAt: null,
          }
    );
    notify(verified ? labels.toast.verificationRemoved : labels.toast.pageVerified, "success");
  }

  async function togglePageFavorite(target: Page) {
    if (!canEditTarget(target)) {
      notify(labels.toast.pageAccessRequired, "default");
      return;
    }
    const wasFavorite = !!target.isFavorite;
    try {
      await toggleFavorite(target.id);
      notify(wasFavorite ? labels.toast.removedFromFavorites : labels.toast.addedToFavorites, "success");
    } catch {
      notify(labels.toast.couldntUpdateFavorites, "error");
    }
  }

  async function duplicateCurrentPage(target: Page) {
    if (!canEditTarget(target)) {
      notify(labels.toast.pageAccessRequired, "default");
      return;
    }
    try {
      const copyPage = await duplicatePage(target.id);
      if (!copyPage) {
        notify(labels.toast.couldntDuplicatePage, "error");
        return;
      }
      notify(labels.toast.duplicatedPage, "success");
      router.push(pageHref(copyPage.id));
    } catch {
      notify(labels.toast.couldntDuplicatePage, "error");
    }
  }

  function setPageLocked(target: Page, locked: boolean) {
    if (!canEditTarget(target)) {
      notify(labels.toast.pageAccessRequired, "default");
      return;
    }
    updatePage(target.id, { isLocked: locked });
    notify(locked ? labels.toast.pageLocked : labels.toast.pageUnlocked, "success");
  }

  async function movePageToTrash(target: Page) {
    if (!canEditTarget(target)) {
      notify(labels.toast.pageAccessRequired, "default");
      return;
    }
    try {
      await trashPage(target.id);
      notify(labels.toast.movedToTrash, "success", {
        label: labels.undo,
        onClick: async () => {
          await restorePage(target.id);
          notify(labels.toast.restoredPage, "success");
          if (target.id === pageId) router.push(pageHref(target.id));
        },
      });
      // Only navigate away when trashing the page being viewed.
      if (target.id === pageId) router.push("/");
    } catch {
      notify(labels.toast.couldntMoveToTrash, "error");
    }
  }

  async function exportMarkdown(target: Page) {
    setExportingFor(target.id);
    try {
      const { exportPageAsMarkdown } = await import("./pageMarkdownExport");
      await exportPageAsMarkdown(target);
      notify(labels.toast.exportedMarkdown, "success");
    } catch {
      notify(labels.toast.couldntExportMarkdown, "error");
    } finally {
      setExportingFor((current) => (current === target.id ? null : current));
    }
  }

  async function exportNative(target: Page) {
    setExportingFor(target.id);
    try {
      const { exportPageAsNative } = await import("./nativeExport");
      const { warnings } = await exportPageAsNative(target);
      notify(
        warnings.length
          ? labels.toast.exportedHanjiWithPlaceholders
          : labels.toast.exportedHanji,
        "success"
      );
    } catch {
      notify(labels.toast.couldntExportHanji, "error");
    } finally {
      setExportingFor((current) => (current === target.id ? null : current));
    }
  }

  function chooseImportFile(target: Page) {
    if (!canEditTarget(target)) {
      notify(labels.toast.pageAccessRequired, "default");
      return;
    }
    pendingImportPageRef.current = target;
    if (importInputRef.current) {
      importInputRef.current.value = "";
      importInputRef.current.click();
    }
  }

  async function onImportFile(file?: File) {
    const target = pendingImportPageRef.current;
    pendingImportPageRef.current = null;
    if (!target || !file) return;
    setImportingFor(target.id);
    try {
      const { importMarkdownIntoPage } = await import("./pageMarkdownImport");
      const count = await importMarkdownIntoPage(target, file);
      notify(
        count > 0 ? labels.toast.importedBlocks(count) : labels.toast.nothingToImport,
        count > 0 ? "success" : "default"
      );
    } catch {
      notify(labels.toast.couldntImportMarkdown, "error");
    } finally {
      setImportingFor((current) => (current === target.id ? null : current));
    }
  }

  const positionCrumbMenu = useCallback(() => {
    const button = crumbButtonRef.current;
    if (!button || typeof window === "undefined") return;
    const rect = button.getBoundingClientRect();
    const width = 260;
    const margin = 8;
    setCrumbMenuStyle({
      position: "fixed",
      top: rect.bottom + 6,
      left: Math.max(
        margin,
        Math.min(rect.left, window.innerWidth - width - margin)
      ),
    });
  }, []);

  const closeMenus = useCallback((restoreFocus = false) => {
    setShareOpenFor(null);
    setMoreOpenFor(null);
    setCrumbMenuOpenFor(null);
    setHistoryOpenFor(null);
    setCustomizeOpenFor(null);
    setCrumbMenuStyle(undefined);
    if (restoreFocus) {
      window.requestAnimationFrame(() => activeMenuTriggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const frame = window.requestAnimationFrame(() => {
      menuItems(moreMenuRef.current)[0]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [moreOpen]);

  useEffect(() => {
    if (!crumbMenuOpen) return;
    positionCrumbMenu();
    const frame = window.requestAnimationFrame(() => {
      menuItems(crumbMenuRef.current)[0]?.focus();
    });
    window.addEventListener("resize", positionCrumbMenu);
    window.addEventListener("scroll", positionCrumbMenu, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", positionCrumbMenu);
      window.removeEventListener("scroll", positionCrumbMenu, true);
    };
  }, [crumbMenuOpen, positionCrumbMenu]);

  const hiddenCrumbs = displayCrumbs.length > 3 ? displayCrumbs.slice(1, -2) : [];
  const visibleCrumbs =
    hiddenCrumbs.length > 0
      ? [displayCrumbs[0], ...displayCrumbs.slice(-2)]
      : displayCrumbs;

  function openCrumb(e: ReactMouseEvent<HTMLAnchorElement | HTMLButtonElement>, id: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setShareOpenFor(null);
    setMoreOpenFor(null);
    setCrumbMenuOpenFor(null);
    setCrumbMenuStyle(undefined);
    router.push(pageHref(id));
  }

  function toggleSidebarChrome() {
    const desktop =
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 768px)").matches;
    if (desktop) {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "false");
      setSidebarCollapsed(false);
      return;
    }
    setSidebarOpen(!sidebarOpen);
  }

  function crumbContent(c: { label: string; page: Page }) {
    const showIcon = c.page.kind === "database" || (c.page.iconType !== "none" && !!c.page.icon);
    return (
      <>
        {showIcon && (
          <span className={styles.crumbIcon} data-topbar-crumb-icon aria-hidden="true">
            <PageIconGlyph page={c.page} size={16} fallback="none" />
          </span>
        )}
        <span className={styles.crumbLabel} data-topbar-crumb-label>
          {c.label}
        </span>
      </>
    );
  }

  return (
    <header className={styles.topbar} data-scrolled={scrolled ? "true" : undefined}>
      <button
        type="button"
        className={styles.hamburger}
        data-topbar-sidebar-toggle
        data-desktop-visible={sidebarCollapsed ? "true" : undefined}
        onClick={toggleSidebarChrome}
        aria-label={sidebarCollapsed || !sidebarOpen ? labels.openSidebar : labels.closeSidebar}
        aria-expanded={sidebarCollapsed ? false : sidebarOpen}
      >
        <MenuIcon size={20} />
      </button>
      <div className={styles.left}>
        {title ? (
          <span className={styles.crumb}>{title}</span>
        ) : hiddenCrumbs.length > 0 ? (
          <>
            <span className={styles.crumbWrap}>
              <a
                className={styles.crumb}
                href={pageHref(visibleCrumbs[0].id)}
                onClick={(e) => openCrumb(e, visibleCrumbs[0].id)}
              >
                {crumbContent(visibleCrumbs[0])}
              </a>
            </span>
            <span className={styles.crumbWrap}>
              <span className={styles.sep}><ChevronRight size={14} /></span>
              <button
                ref={crumbButtonRef}
                type="button"
                className={styles.crumb}
                aria-label={labels.hiddenBreadcrumbPages}
                aria-haspopup="menu"
                aria-expanded={crumbMenuOpen}
                onClick={() => {
                  if (crumbMenuOpen) {
                    closeMenus(true);
                    return;
                  }
                  activeMenuTriggerRef.current = crumbButtonRef.current;
                  setShareOpenFor(null);
                  setMoreOpenFor(null);
                  setHistoryOpenFor(null);
                  setCrumbMenuOpenFor(pageId ?? null);
                }}
              >
                <DotsHorizontal size={16} />
              </button>
            </span>
            {visibleCrumbs.slice(1).map((c) => (
              <span key={c.id} className={styles.crumbWrap}>
                <span className={styles.sep}><ChevronRight size={14} /></span>
                <a
                  className={styles.crumb}
                  href={pageHref(c.id)}
                  onClick={(e) => openCrumb(e, c.id)}
                >
                  {crumbContent(c)}
                </a>
              </span>
            ))}
          </>
        ) : (
          visibleCrumbs.map((c, i) => (
            <span key={c.id} className={styles.crumbWrap}>
              {i > 0 && <span className={styles.sep}><ChevronRight size={14} /></span>}
              <a
                className={styles.crumb}
                href={pageHref(c.id)}
                onClick={(e) => openCrumb(e, c.id)}
              >
                {crumbContent(c)}
              </a>
            </span>
          ))
        )}
      </div>
      {crumbMenuOpen && (
        <div
          ref={crumbMenuRef}
          className={styles.crumbMenu}
          style={crumbMenuStyle}
          role="menu"
          tabIndex={-1}
          aria-label={labels.hiddenBreadcrumbPages}
          onKeyDown={(e) => onTopbarMenuKeyDown(e, crumbMenuRef.current, () => closeMenus(true))}
        >
          {hiddenCrumbs.map((c) => (
            <button
              key={c.id}
              type="button"
              className={styles.menuItem}
              data-menu-item
              role="menuitem"
              onClick={(e) => openCrumb(e, c.id)}
            >
              <span className={styles.crumbMenuIcon} aria-hidden="true">
                <PageIconGlyph page={c.page} size={16} />
              </span>
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className={styles.right}>
        {page && (
          <>
            {pageVerified && (
              <button
                type="button"
                className={styles.verifiedPill}
                title={labels.removeVerificationFor(pageTitle)}
                aria-label={labels.removeVerificationFor(pageTitle)}
                disabled={!canEditThisPage}
                onClick={() => togglePageVerification(page)}
              >
                <CheckIcon size={14} />
                <span>{labels.verified}</span>
              </button>
            )}
            {pageLocked && (
              <button
                type="button"
                className={styles.lockPill}
                title={labels.unlockNamedPage(pageTitle)}
                aria-label={labels.unlockNamedPage(pageTitle)}
                disabled={!canEditThisPage}
                onClick={() => setPageLocked(page, false)}
              >
                <LockIcon size={14} />
                <span>{labels.locked}</span>
              </button>
            )}
            {presence && <PagePresence presence={presence} variant="topbar" />}
            <button
              ref={shareButtonRef}
              type="button"
              className={`${styles.action} ${styles.shareAction}`}
              data-topbar-share-action
              title={labels.sharePage(pageTitle)}
              aria-label={labels.sharePage(pageTitle)}
              aria-haspopup="dialog"
              aria-expanded={shareOpen}
              aria-controls={shareOpen ? shareMenuId : undefined}
              onClick={() => {
                if (shareOpen) {
                  closeMenus(true);
                  return;
                }
                activeMenuTriggerRef.current = shareButtonRef.current;
                setMoreOpenFor(null);
                setCrumbMenuOpenFor(null);
                setHistoryOpenFor(null);
                setShareOpenFor(page.id);
              }}
            >
              <SharePeopleIcon size={15} aria-hidden="true" />
              <span>{labels.share}</span>
            </button>
            <button
              type="button"
              className={`${styles.iconAction} ${styles.linkAction}`}
              data-topbar-icon-action
              data-topbar-link-action
              aria-label={labels.copyPageLinkButton}
              title={labels.copyPageLink(copiedPageLink)}
              onClick={() => {
                closeMenus();
                void copyLink(undefined, "page");
              }}
            >
              <LinkIcon size={17} aria-hidden="true" />
            </button>
            {pageCommentsDisplay !== "off" && (
              <button
                type="button"
                className={`${styles.action} ${styles.commentAction}`}
                data-topbar-comment-action
                title={
                  commentCount
                    ? labels.openComments(commentCount, pageTitle)
                    : labels.addCommentTo(pageTitle)
                }
                aria-label={
                  commentCount
                    ? labels.openComments(commentCount, pageTitle)
                    : labels.addCommentTo(pageTitle)
                }
                onClick={() => {
                  closeMenus();
                  openComments(page.id);
                }}
              >
                <CommentIcon size={17} aria-hidden="true" />
                <span data-topbar-comment-label>
                  {labels.comment(commentCount)}
                </span>
              </button>
            )}
            <button
              type="button"
              className={styles.iconAction}
              data-topbar-icon-action
              data-favorite={page.isFavorite ? "true" : undefined}
              aria-label={page.isFavorite ? labels.removeFavorite(pageTitle) : labels.addFavorite(pageTitle)}
              title={page.isFavorite ? labels.removeFavorite(pageTitle) : labels.addFavorite(pageTitle)}
              disabled={!canEditThisPage}
              onClick={() => {
                closeMenus();
                void togglePageFavorite(page);
              }}
            >
              {page.isFavorite ? (
                <StarFilled size={18} aria-hidden="true" />
              ) : (
                <Star size={18} aria-hidden="true" />
              )}
            </button>
            <button
              ref={moreButtonRef}
              type="button"
              className={styles.iconAction}
              data-topbar-icon-action
              aria-label={labels.moreActions(pageTitle)}
              title={labels.moreActions(pageTitle)}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-controls={moreOpen ? moreMenuId : undefined}
              onClick={() => {
                if (moreOpen) {
                  closeMenus(true);
                  return;
                }
                activeMenuTriggerRef.current = moreButtonRef.current;
                setShareOpenFor(null);
                setCrumbMenuOpenFor(null);
                setHistoryOpenFor(null);
                setCustomizeOpenFor(null);
                setMoreOpenFor(page.id);
              }}
            >
              <DotsHorizontal size={18} aria-hidden="true" />
            </button>
            {(shareOpen || moreOpen || crumbMenuOpen) && (
              <button
                type="button"
                className={styles.menuBackdrop}
                onClick={() => closeMenus(true)}
                tabIndex={-1}
                aria-label={labels.closePageMenu}
              />
            )}
            {shareOpen && (
              <ShareMenu
                key={page.id}
                id={shareMenuId}
                page={page}
                copiedPageLink={copiedPageLink}
                copiedWebLink={copiedWebLink}
                onCopy={(target, href) => void copyLink(href, target)}
                onClose={() => closeMenus(true)}
              />
            )}
            {moreOpen && (
              <div
                id={moreMenuId}
                ref={moreMenuRef}
                className={styles.moreMenu}
                role="menu"
                tabIndex={-1}
                aria-label={labels.pageActions}
                onKeyDown={(e) => {
                  if (
                    !e.defaultPrevented &&
                    !isComposingKeyEvent(e) &&
                    (e.metaKey || e.ctrlKey) &&
                    !e.shiftKey &&
                    !e.altKey &&
                    !e.repeat &&
                    e.key.toLowerCase() === "d"
                  ) {
                    e.preventDefault();
                    e.stopPropagation();
                    void duplicateCurrentPage(page);
                    closeMenus();
                    return;
                  }
                  if (
                    !e.defaultPrevented &&
                    !isComposingKeyEvent(e) &&
                    (e.metaKey || e.ctrlKey) &&
                    !e.shiftKey &&
                    !e.altKey &&
                    !e.repeat &&
                    (e.key === "Backspace" || e.key === "Delete")
                  ) {
                    e.preventDefault();
                    e.stopPropagation();
                    void movePageToTrash(page);
                    closeMenus();
                    return;
                  }
                  onTopbarMenuKeyDown(e, moreMenuRef.current, () => closeMenus(true));
                }}
              >
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitem"
                  disabled={!canEditThisPage}
                  onClick={() => {
                    void togglePageFavorite(page);
                    closeMenus();
                  }}
                >
                  {page.isFavorite ? (
                    <StarFilled size={16} aria-hidden="true" />
                  ) : (
                    <Star size={16} aria-hidden="true" />
                  )}
                  <span>
                    {page.isFavorite ? labels.removeFromFavorites : labels.addToFavorites}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitem"
                  onClick={() => {
                    openPageInNewTab(page.id, { preserveCurrentSearch: true, omitSearchParams: ["p", "pm"] });
                    closeMenus();
                  }}
                >
                  <OpenInNew size={16} aria-hidden="true" />
                  <span>{labels.openInNewTab}</span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  data-testid="offline-pin-toggle"
                  role="menuitemcheckbox"
                  aria-checked={offlinePinned}
                  onClick={() => {
                    void toggleOfflinePin(page);
                    closeMenus();
                  }}
                >
                  <Download size={16} aria-hidden="true" />
                  <span>{labels.availableOffline}</span>
                  {/* Same right-aligned switch convention as Small text /
                      Full width (and current Notion's offline row). */}
                  <span
                    className={styles.menuSwitch}
                    data-on={offlinePinned ? "true" : undefined}
                    aria-hidden="true"
                  >
                    <span />
                  </span>
                </button>
                <div className={styles.menuDivider} />
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitem"
                  disabled={!canEditThisPage}
                  onClick={() => {
                    void duplicateCurrentPage(page);
                    closeMenus();
                  }}
                >
                  <Copy size={16} aria-hidden="true" />
                  <span>{labels.duplicate}</span>
                  <span className={styles.itemHint}>⌘D</span>
                </button>
                <div className={styles.menuDivider} />
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitem"
                  disabled={!canEditThisPage}
                  onClick={() => {
                    setMoreOpenFor(null);
                    setMoveOpenFor(page.id);
                  }}
                >
                  <MoveIcon size={16} aria-hidden="true" />
                  <span>{labels.moveTo}</span>
                  <span className={styles.itemHint}>⌘⇧P</span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitem"
                  onClick={() => {
                    void copyLink(undefined, "page");
                    closeMenus();
                  }}
                >
                  <LinkIcon size={16} aria-hidden="true" />
                  <span>{labels.copyPageLink(copiedPageLink)}</span>
                  <span className={styles.itemHint}>⌘L</span>
                </button>
                <div className={styles.menuDivider} />
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitem"
                  disabled={exportingFor === page.id}
                  onClick={() => {
                    void exportMarkdown(page);
                    closeMenus();
                  }}
                >
                  <Download size={16} aria-hidden="true" />
                  <span>{exportingFor === page.id ? labels.exporting : labels.exportAsMarkdown}</span>
                  <span className={styles.itemHint}>.md</span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitem"
                  disabled={exportingFor === page.id}
                  onClick={() => {
                    void exportNative(page);
                    closeMenus();
                  }}
                >
                  <Download size={16} aria-hidden="true" />
                  <span>{exportingFor === page.id ? labels.exporting : labels.exportAsHanji}</span>
                  <span className={styles.itemHint}>.hanji.json</span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitem"
                  disabled={!canEditThisPage || pageLocked || importingFor === page.id}
                  onClick={() => {
                    if (!canEditThisPage || pageLocked || importingFor === page.id) return;
                    chooseImportFile(page);
                    closeMenus();
                  }}
                >
                  <Upload size={16} aria-hidden="true" />
                  <span>{importingFor === page.id ? labels.importing : labels.importMarkdown}</span>
                  <span className={styles.itemHint}>.md</span>
                </button>
                <div className={styles.menuDivider} />
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitemcheckbox"
                  aria-checked={pageLocked}
                  disabled={!canEditThisPage}
                  onClick={() => {
                    setPageLocked(page, !pageLocked);
                    closeMenus();
                  }}
                >
                  {pageLocked ? (
                    <UnlockIcon size={16} aria-hidden="true" />
                  ) : (
                    <LockIcon size={16} aria-hidden="true" />
                  )}
                  <span>{pageLocked ? labels.unlockPage : labels.lockPage}</span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitem"
                  onClick={() => {
                    setMoreOpenFor(null);
                    setShareOpenFor(null);
                    setCrumbMenuOpenFor(null);
                    setHistoryOpenFor(page.id);
                  }}
                >
                  <ClockIcon size={16} aria-hidden="true" />
                  <span>{labels.pageHistory}</span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitemcheckbox"
                  aria-checked={pageVerified}
                  disabled={!canEditThisPage}
                  onClick={() => {
                    togglePageVerification(page);
                    closeMenus();
                  }}
                >
                  <CheckIcon size={16} aria-hidden="true" />
                  <span>{pageVerified ? labels.removeVerification : labels.verifyPage}</span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitem"
                  aria-expanded={customizeOpen}
                  onClick={() => setCustomizeOpenFor(customizeOpen ? null : page.id)}
                >
                  <Settings size={16} aria-hidden="true" />
                  <span>{labels.customizePage}</span>
                  <span className={styles.itemHint}>{customizeSummaryLabel}</span>
                  <ChevronRight
                    className={styles.menuDisclosure}
                    data-open={customizeOpen ? "true" : undefined}
                    size={14}
                    aria-hidden="true"
                  />
                </button>
                {customizeOpen && (
                  <div className={styles.customizePanel} role="group" aria-label={labels.customizePage}>
                    <div className={styles.customizeRow}>
                      <span>{labels.backlinks}</span>
                      <div className={styles.segmentedMenu} role="group" aria-label={labels.backlinksDisplay}>
                        {BACKLINKS_DISPLAY_OPTIONS.map((option) => {
                          const active = backlinksDisplay === option.value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              className={styles.segmentedMenuItem}
                              data-active={active ? "true" : undefined}
                              data-menu-item
                              role="menuitemradio"
                              aria-checked={active}
                              disabled={!canEditThisPage || pageLocked}
                              onClick={() => updatePage(page.id, { backlinksDisplay: option.value })}
                            >
                              {pageDisplayOptionLabel(option.value, labels)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className={styles.customizeRow}>
                      <span>{labels.pageComments}</span>
                      <div className={styles.segmentedMenu} role="group" aria-label={labels.pageCommentsDisplay}>
                        {PAGE_COMMENTS_DISPLAY_OPTIONS.map((option) => {
                          const active = pageCommentsDisplay === option.value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              className={styles.segmentedMenuItem}
                              data-active={active ? "true" : undefined}
                              data-menu-item
                              role="menuitemradio"
                              aria-checked={active}
                              disabled={!canEditThisPage || pageLocked}
                              onClick={() => updatePage(page.id, { pageCommentsDisplay: option.value })}
                            >
                              {pageDisplayOptionLabel(option.value, labels)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
                <div className={styles.menuDivider} />
                <div className={styles.menuSectionLabel}>{labels.style}</div>
                <div className={styles.fontPicker} role="group" aria-label={labels.pageFont}>
                  {PAGE_FONTS.map((font) => {
                    const active = (page.font ?? "default") === font.value;
                    return (
                      <button
                        key={font.value}
                        type="button"
                        className={styles.fontOption}
                        data-font={font.value}
                        data-active={active ? "true" : undefined}
                        data-menu-item
                        role="menuitemradio"
                        aria-checked={active}
                        disabled={!canEditThisPage || pageLocked}
                        onClick={() => updatePage(page.id, { font: font.value })}
                      >
                        {active && (
                          <span className={styles.fontCheck} aria-hidden="true">
                            <CheckIcon size={11} />
                          </span>
                        )}
                        <span className={styles.fontSample}>{font.sample}</span>
                        <span>{pageFontLabel(font.value, labels)}</span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitemcheckbox"
                  aria-checked={!!page.smallText}
                  disabled={!canEditThisPage || pageLocked}
                  onClick={() => updatePage(page.id, { smallText: !page.smallText })}
                >
                  <span>{labels.smallText}</span>
                  <span className={styles.menuSwitch} data-on={page.smallText ? "true" : undefined} aria-hidden="true">
                    <span />
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  data-menu-item
                  role="menuitemcheckbox"
                  aria-checked={!!page.fullWidth}
                  disabled={!canEditThisPage || pageLocked}
                  onClick={() => updatePage(page.id, { fullWidth: !page.fullWidth })}
                >
                  <span>{labels.fullWidth}</span>
                  <span className={styles.menuSwitch} data-on={page.fullWidth ? "true" : undefined} aria-hidden="true">
                    <span />
                  </span>
                </button>
                <div className={styles.menuDivider} />
                <div className={styles.menuMeta}>
                  <span>{labels.created}</span>
                  <span>{formatMenuTimestamp(page.createdAt, labels)}</span>
                </div>
                <div className={styles.menuMeta}>
                  <span>{labels.createdBy}</span>
                  <span>{actorLabel(page.createdBy, userId)}</span>
                </div>
                <div className={styles.menuMeta}>
                  <span>{labels.lastEdited}</span>
                  <span>{formatMenuTimestamp(page.updatedAt, labels)}</span>
                </div>
                <div className={styles.menuMeta}>
                  <span>{labels.editedBy}</span>
                  <span>{actorLabel(page.lastEditedBy ?? page.createdBy, userId)}</span>
                </div>
                {pageVerified && (
                  <div className={styles.menuMeta}>
                    <span>{labels.verified}</span>
                    <span>{formatMenuTimestamp(page.verifiedAt ?? undefined, labels)}</span>
                  </div>
                )}
                <div className={styles.menuDivider} />
                <div className={styles.menuMeta}>
                  <span>{labels.words}</span>
                  <span>{pageStats.words.toLocaleString()}</span>
                </div>
                <div className={styles.menuMeta}>
                  <span>{labels.characters}</span>
                  <span>{pageStats.characters.toLocaleString()}</span>
                </div>
                <div className={styles.menuMeta}>
                  <span>{labels.blocks}</span>
                  <span>{pageStats.blocks.toLocaleString()}</span>
                </div>
                <div className={styles.menuDivider} />
                <button
                  type="button"
                  className={`${styles.menuItem} ${styles.danger}`}
                  data-menu-item
                  role="menuitem"
                  disabled={!canEditThisPage}
                  onClick={() => {
                    void movePageToTrash(page);
                    closeMenus();
                  }}
                >
                  <Trash size={16} aria-hidden="true" />
                  <span>{labels.moveToTrash}</span>
                  <span className={styles.itemHint}>⌘⌫</span>
                </button>
              </div>
            )}
            <Suspense fallback={null}>
              {moveOpen && (
                <MoveToDialog
                  pageId={page.id}
                  onClose={() => {
                    setMoveOpenFor(null);
                    window.requestAnimationFrame(() => moreButtonRef.current?.focus());
                  }}
                />
              )}
              {historyOpen && (
                <UpdatesPanel
                  pageId={page.id}
                  placement="topbar"
                  title={labels.pageHistory}
                  onClose={() => {
                    setHistoryOpenFor(null);
                    window.requestAnimationFrame(() => moreButtonRef.current?.focus());
                  }}
                />
              )}
            </Suspense>
          </>
        )}
      </div>
      <input
        ref={importInputRef}
        type="file"
        accept=".md,.markdown,text/markdown,text/plain"
        className={styles.hiddenFileInput}
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => void onImportFile(e.currentTarget.files?.[0])}
      />
    </header>
  );
}

type ShareInvite = PagePermission;
type SharePermission = "Full access" | "Can edit" | "Can comment" | "Can view";
type ShareExpiryOption = "never" | "1d" | "7d" | "30d" | "custom";
type SharePrincipalDraft = {
  label: string;
  principalType: SharePrincipalType;
  principalId?: string;
};

const SHARE_PERMISSION_OPTIONS: SharePermission[] = [
  "Full access",
  "Can edit",
  "Can comment",
  "Can view",
];
const SHARE_EXPIRY_OPTIONS: ShareExpiryOption[] = ["never", "1d", "7d", "30d"];

function inviteInitial(label: string) {
  return label.trim().slice(0, 1).toUpperCase() || "G";
}

function sharePermissionToRole(permission: SharePermission): ShareRole {
  if (permission === "Full access") return "full_access";
  if (permission === "Can edit") return "edit";
  if (permission === "Can comment") return "comment";
  return "view";
}

function shareRoleToPermission(role: ShareRole): SharePermission {
  if (role === "full_access") return "Full access";
  if (role === "edit") return "Can edit";
  if (role === "comment") return "Can comment";
  return "Can view";
}

function sharePermissionLabel(permission: SharePermission, labels: TopbarLabels) {
  if (permission === "Full access") return labels.fullAccess;
  if (permission === "Can edit") return labels.canEdit;
  if (permission === "Can comment") return labels.canComment;
  return labels.canView;
}

function shareInvitePermission(invite: ShareInvite) {
  return shareRoleToPermission(invite.role);
}

function shareInviteKindLabel(invite: ShareInvite, labels: TopbarLabels) {
  if (invite.principalType === "group") return labels.group;
  if (invite.principalType === "user") return labels.user;
  if (invite.principalType === "integration") return labels.integration;
  return labels.guest;
}

function organizationProfileShareLabel(profile: OrganizationProfile, labels: TopbarLabels) {
  return profile.displayName?.trim() || profile.email?.trim() || profile.userId || labels.member;
}

function organizationProfileShareSubtext(profile: OrganizationProfile, labels: TopbarLabels) {
  const workspaceCount = profile.workspaceMemberships?.length ?? 0;
  const inviteCount = profile.pendingInvitations?.length ?? 0;
  return [
    profile.email,
    workspaceCount ? labels.workspaceCount(workspaceCount) : null,
    inviteCount ? labels.pendingCount(inviteCount) : null,
  ].filter(Boolean).join(" · ") || profile.status || labels.memberStatusFallback;
}

function shareLinkExpired(shareLink: ShareLink | null) {
  if (!shareLink?.expiresAt) return false;
  const expiresAt = new Date(shareLink.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function shareLinkHref(shareLink: ShareLink | null) {
  if (!shareLink?.token || !shareLink.enabled || shareLinkExpired(shareLink)) return "";
  if (typeof window === "undefined") return `/share/${encodeURIComponent(shareLink.token)}`;
  return new URL(`/share/${encodeURIComponent(shareLink.token)}`, window.location.origin).toString();
}

function expiryOptionFromLink(shareLink: ShareLink | null): ShareExpiryOption {
  if (!shareLink?.expiresAt) return "never";
  const expiresAt = new Date(shareLink.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return "custom";
  const remaining = expiresAt - Date.now();
  const windows: Array<[ShareExpiryOption, number]> = [
    ["1d", 24 * 60 * 60 * 1000],
    ["7d", 7 * 24 * 60 * 60 * 1000],
    ["30d", 30 * 24 * 60 * 60 * 1000],
  ];
  for (const [option, ms] of windows) {
    if (Math.abs(remaining - ms) < 5 * 60 * 1000) return option;
  }
  return "custom";
}

function expiresAtForOption(option: ShareExpiryOption) {
  if (option === "never") return null;
  const days = option === "1d" ? 1 : option === "7d" ? 7 : option === "30d" ? 30 : 0;
  if (!days) return undefined;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function shareExpiryOptionLabel(option: ShareExpiryOption, labels: TopbarLabels) {
  if (option === "never") return labels.never;
  if (option === "1d") return labels.oneDay;
  if (option === "7d") return labels.sevenDays;
  if (option === "30d") return labels.thirtyDays;
  return labels.customExpiration;
}

function shareExpiryLabel(shareLink: ShareLink | null, labels: TopbarLabels) {
  if (!shareLink?.expiresAt) return labels.neverExpires;
  const expiresAt = new Date(shareLink.expiresAt);
  if (!Number.isFinite(expiresAt.getTime())) return labels.customExpiration;
  if (expiresAt.getTime() <= Date.now()) return labels.expired;
  return labels.expiresAt(new Intl.DateTimeFormat(typeof navigator === "undefined" ? undefined : navigator.language, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(expiresAt));
}

function ShareMenu({
  id,
  page,
  copiedPageLink,
  copiedWebLink,
  onCopy,
  onClose,
}: {
  id: string;
  page: Page;
  copiedPageLink: boolean;
  copiedWebLink: boolean;
  onCopy: (target: CopyTarget, href?: string) => void;
  onClose: () => void;
}) {
  const shareMenuRef = useRef<HTMLDivElement>(null);
  const inviteInputRef = useRef<HTMLInputElement>(null);
  const workspace = useStore((s) => s.workspace);
  const organization = useStore((s) => s.organization);
  const organizationGroups = useStore((s) => s.organizationGroups);
  const applyRemotePage = useStore((s) => s.applyRemotePage);
  const notify = useStore((s) => s.notify);
  const [inviteDraft, setInviteDraft] = useState("");
  const [selectedInvitePrincipal, setSelectedInvitePrincipal] = useState<SharePrincipalDraft | null>(null);
  const [peopleSuggestions, setPeopleSuggestions] = useState<OrganizationProfile[]>([]);
  const [invitePermission, setInviteDraftPermission] = useState<SharePermission>("Can view");
  const [invitePermissionOpen, setInvitePermissionOpen] = useState(false);
  const [invites, setInvites] = useState<ShareInvite[]>([]);
  const [shareLink, setShareLink] = useState<ShareLink | null>(null);
  const [expiryOption, setExpiryOption] = useState<ShareExpiryOption>("never");
  const [activeShareTab, setActiveShareTab] = useState<"share" | "publish">("share");
  const [inviteMenuFor, setInviteMenuFor] = useState<string | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessLoaded, setAccessLoaded] = useState(false);
  const [accessLoadFailed, setAccessLoadFailed] = useState(false);
  const [canManageAccess, setCanManageAccess] = useState(false);
  const labels = topbarLabels();
  const accountLabel = labels.fullAccess;
  const userInitial = (workspace?.name.trim().slice(0, 1).toUpperCase() || "Y");
  const shareControlsDisabled = accessBusy || !accessLoaded || !canManageAccess;
  const canInvite = inviteDraft.trim().length > 0 && !shareControlsDisabled;
  const pageTitle = pageDisplayTitle(page);
  const publicHref = shareLinkHref(shareLink);
  const shareToWeb = !!page.isPublic && (!shareLink || (shareLink.enabled && !shareLinkExpired(shareLink)));
  const inviteQuery = inviteDraft.trim();
  const filteredInviteGroups = organizationGroups
    .filter((group) => {
      const query = inviteQuery.toLowerCase();
      if (!query) return true;
      return group.name.toLowerCase().includes(query);
    })
    .filter(
      (group) =>
        !invites.some(
          (invite) =>
            invite.principalType === "group" &&
            (invite.principalId === group.id ||
              invite.label.trim().toLowerCase() === group.name.trim().toLowerCase()),
        ),
    )
    .slice(0, 4);
  const filteredPeopleSuggestions = peopleSuggestions
    .filter((profile) => {
      if (!profile.userId) return false;
      return !invites.some(
        (invite) =>
          (invite.principalType === "user" && invite.principalId === profile.userId) ||
          (profile.email &&
            invite.principalType === "email" &&
            invite.label.trim().toLowerCase() === profile.email.trim().toLowerCase()),
      );
    })
    .slice(0, 4);

  function principalForInvite(label: string): SharePrincipalDraft {
    if (
      selectedInvitePrincipal &&
      selectedInvitePrincipal.label.trim().toLowerCase() === label.trim().toLowerCase()
    ) {
      return selectedInvitePrincipal;
    }
    const matchingGroup = organizationGroups.find(
      (group) => group.name.trim().toLowerCase() === label.trim().toLowerCase()
    );
    if (matchingGroup) {
      return {
        label: matchingGroup.name,
        principalType: "group",
        principalId: matchingGroup.id,
      };
    }
    return { label, principalType: "email" };
  }

  function updateInviteDraft(value: string) {
    setInviteDraft(value);
    setSelectedInvitePrincipal(null);
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inviteInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAccessLoaded(false);
    setAccessLoadFailed(false);
    setCanManageAccess(false);
    setAccessBusy(true);
    getPageAccessRemote(page.id)
      .then((result) => {
        if (cancelled) return;
        applyRemotePage(result.page);
        setShareLink(result.shareLink ?? null);
        setExpiryOption(expiryOptionFromLink(result.shareLink ?? null));
        setInvites(result.permissions ?? []);
        setCanManageAccess(!!result.canManage);
        setAccessLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) {
          setAccessLoadFailed(true);
          setCanManageAccess(false);
          // Use the module-level accessor (stable) rather than the per-render
          // `labels` so this effect's dep array stays as it was.
          notify(topbarLabels().toast.couldntLoadAccessList, "error");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAccessBusy(false);
          setAccessLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyRemotePage, notify, page.id]);

  useEffect(() => {
    let cancelled = false;
    const organizationId = organization?.id;
    const query = inviteDraft.trim();
    if (!organizationId || !canManageAccess || query.length < 1) {
      setPeopleSuggestions([]);
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setTimeout(() => {
      searchOrganizationPeopleRemote({
        organizationId,
        query,
        limit: 6,
      })
        .then((result) => {
          if (!cancelled) setPeopleSuggestions(result.people ?? []);
        })
        .catch(() => {
          if (!cancelled) setPeopleSuggestions([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [canManageAccess, inviteDraft, organization?.id]);

  async function toggleWebSharing() {
    if (!canManageAccess) {
      notify(labels.toast.cantChangeSharing, "default");
      return;
    }
    const next = !shareToWeb;
    applyRemotePage({ ...page, isPublic: next });
    setAccessBusy(true);
    try {
      const result = await setPageWebSharingRemote(page.id, next, next && shareLinkExpired(shareLink) ? null : undefined);
      applyRemotePage(result.page);
      setShareLink(result.shareLink ?? null);
      setExpiryOption(expiryOptionFromLink(result.shareLink ?? null));
      setInvites(result.permissions ?? []);
      setCanManageAccess(result.canManage ?? true);
      notify(next ? labels.toast.webSharingEnabled : labels.toast.webSharingDisabled, "success");
    } catch {
      applyRemotePage(page);
      notify(labels.toast.couldntUpdateWebSharing, "error");
    } finally {
      setAccessBusy(false);
    }
  }

  async function updateShareExpiry(option: ShareExpiryOption) {
    if (option === "custom") return;
    if (!canManageAccess) {
      notify(labels.toast.cantChangeSharing, "default");
      return;
    }
    const previousLink = shareLink;
    const previousOption = expiryOption;
    const expiresAt = expiresAtForOption(option);
    setExpiryOption(option);
    setAccessBusy(true);
    try {
      const result = await setPageWebSharingRemote(page.id, true, expiresAt);
      applyRemotePage(result.page);
      setShareLink(result.shareLink ?? null);
      setExpiryOption(expiryOptionFromLink(result.shareLink ?? null));
      setInvites(result.permissions ?? []);
      setCanManageAccess(result.canManage ?? true);
      notify(labels.toast.updatedWebLinkExpiration, "success");
    } catch {
      setShareLink(previousLink);
      setExpiryOption(previousOption);
      notify(labels.toast.couldntUpdateWebLink, "error");
    } finally {
      setAccessBusy(false);
    }
  }

  async function submitInvite() {
    if (!canManageAccess) {
      notify(labels.toast.cantChangeSharing, "default");
      return;
    }
    if (!canInvite) {
      inviteInputRef.current?.focus();
      return;
    }
    const label = inviteDraft.trim().replace(/\s+/g, " ");
    const principal = principalForInvite(label);
    const normalizedKey = `${principal.principalType}:${
      principal.principalId ?? principal.label
    }`.toLowerCase();
    if (
      invites.some(
        (invite) =>
          `${invite.principalType}:${invite.principalId ?? invite.label}`.toLowerCase() ===
          normalizedKey,
      )
    ) {
      notify(labels.toast.alreadyHasAccess, "default");
      setInviteDraft("");
      window.requestAnimationFrame(() => inviteInputRef.current?.focus());
      return;
    }
    setAccessBusy(true);
    try {
      const result = await invitePageAccessRemote(
        page.id,
        principal.label,
        sharePermissionToRole(invitePermission),
        principal.principalType,
        principal.principalId,
      );
      applyRemotePage(result.page);
      setInvites(result.permissions ?? []);
      setCanManageAccess(result.canManage ?? true);
      if (result.warnings?.length) {
        notify(result.warnings[0], "default");
      } else {
        notify(labels.toast.addedToAccessList, "success");
      }
      setInvitePermissionOpen(false);
      setInviteDraft("");
      setSelectedInvitePrincipal(null);
      setPeopleSuggestions([]);
      window.requestAnimationFrame(() => inviteInputRef.current?.focus());
    } catch {
      notify(labels.toast.couldntAddAccess, "error");
    } finally {
      setAccessBusy(false);
    }
  }

  function selectInviteGroup(groupId: string) {
    const group = organizationGroups.find((item) => item.id === groupId);
    if (!group) return;
    setInviteDraft(group.name);
    setSelectedInvitePrincipal({
      label: group.name,
      principalType: "group",
      principalId: group.id,
    });
    setPeopleSuggestions([]);
    window.requestAnimationFrame(() => inviteInputRef.current?.focus());
  }

  function selectInvitePerson(profile: OrganizationProfile) {
    if (!profile.userId) return;
    const label = organizationProfileShareLabel(profile, labels);
    setInviteDraft(label);
    setSelectedInvitePrincipal({
      label,
      principalType: "user",
      principalId: profile.userId,
    });
    setPeopleSuggestions([]);
    window.requestAnimationFrame(() => inviteInputRef.current?.focus());
  }

  async function setExistingInvitePermission(inviteId: string, permission: SharePermission) {
    if (!canManageAccess) {
      notify(labels.toast.cantChangeSharing, "default");
      return;
    }
    const previous = invites;
    setInvites(
      invites.map((invite) =>
        invite.id === inviteId ? { ...invite, role: sharePermissionToRole(permission) } : invite
      )
    );
    setInviteMenuFor(null);
    setAccessBusy(true);
    try {
      const result = await updatePagePermissionRemote(inviteId, sharePermissionToRole(permission));
      applyRemotePage(result.page);
      setInvites(result.permissions ?? []);
      setCanManageAccess(result.canManage ?? true);
      if (result.warnings?.length) notify(result.warnings[0], "default");
    } catch {
      setInvites(previous);
      notify(labels.toast.couldntUpdateAccess, "error");
    } finally {
      setAccessBusy(false);
    }
  }

  async function removeInvite(inviteId: string) {
    if (!canManageAccess) {
      notify(labels.toast.cantChangeSharing, "default");
      return;
    }
    const previous = invites;
    setInvites(invites.filter((invite) => invite.id !== inviteId));
    setInviteMenuFor(null);
    setAccessBusy(true);
    try {
      const result = await removePagePermissionRemote(inviteId);
      if (result.page) applyRemotePage(result.page);
      setInvites(result.permissions ?? []);
      setCanManageAccess(result.canManage ?? true);
      notify(labels.toast.removedFromAccessList, "success");
    } catch {
      setInvites(previous);
      notify(labels.toast.couldntRemoveAccess, "error");
    } finally {
      setAccessBusy(false);
    }
  }

  function closePermissionMenus() {
    setInvitePermissionOpen(false);
    setInviteMenuFor(null);
  }

  function closePermissionMenusUnless(target: EventTarget | null) {
    const el = target instanceof HTMLElement ? target : null;
    if (el?.closest("[data-share-permission-root]")) return;
    closePermissionMenus();
  }

  return (
    <div
      id={id}
      ref={shareMenuRef}
      className={styles.shareMenu}
      data-share-menu="true"
      role="dialog"
      aria-label={labels.shareDialog(pageDisplayTitle(page))}
      onPointerDownCapture={(e) => closePermissionMenusUnless(e.target)}
      onFocusCapture={(e) => closePermissionMenusUnless(e.target)}
      onKeyDown={(e) => {
        if (
          !e.defaultPrevented &&
          !isComposingKeyEvent(e) &&
          e.key === "Escape" &&
          (invitePermissionOpen || inviteMenuFor)
        ) {
          e.preventDefault();
          e.stopPropagation();
          closePermissionMenus();
          inviteInputRef.current?.focus();
          return;
        }
        onTopbarMenuKeyDown(e, shareMenuRef.current, onClose);
      }}
    >
      <div className={styles.shareTabs} data-share-tabs="true" role="tablist" aria-label={labels.shareDialog(pageTitle)}>
        <button
          type="button"
          className={styles.shareTab}
          data-share-tab="share"
          data-active={activeShareTab === "share" ? "true" : undefined}
          role="tab"
          aria-selected={activeShareTab === "share"}
          onClick={() => {
            closePermissionMenus();
            setActiveShareTab("share");
            window.requestAnimationFrame(() => inviteInputRef.current?.focus());
          }}
        >
          {labels.share}
        </button>
        <button
          type="button"
          className={styles.shareTab}
          data-share-tab="publish"
          data-active={activeShareTab === "publish" ? "true" : undefined}
          role="tab"
          aria-selected={activeShareTab === "publish"}
          onClick={() => {
            closePermissionMenus();
            setActiveShareTab("publish");
          }}
        >
          {labels.publish}
        </button>
      </div>
      {activeShareTab === "share" ? (
        <div className={styles.sharePanel} data-share-panel="share" role="tabpanel">
          <div className={styles.shareInviteRow}>
            <input
              ref={inviteInputRef}
              value={inviteDraft}
              aria-label={labels.invitePeople}
              placeholder={labels.invitePlaceholder}
              disabled={shareControlsDisabled}
              onChange={(e) => updateInviteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (isComposingKeyEvent(e)) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitInvite();
                }
              }}
            />
            <span className={styles.shareInvitePermissionWrap} data-share-permission-root="true">
              <button
                type="button"
                className={styles.shareInvitePermissionButton}
                data-menu-item
                aria-haspopup="menu"
                aria-expanded={invitePermissionOpen}
                aria-label={labels.newInvitePermission}
                disabled={shareControlsDisabled}
                onClick={() => {
                  setInviteMenuFor(null);
                  setInvitePermissionOpen((current) => !current);
                }}
              >
                {sharePermissionLabel(invitePermission, labels)}
                <ChevronDown size={12} aria-hidden="true" />
              </button>
              {invitePermissionOpen && (
                <span className={styles.sharePermissionMenu} role="menu">
                  {SHARE_PERMISSION_OPTIONS.map((permission) => (
                    <button
                      key={permission}
                      type="button"
                      data-menu-item
                      role="menuitemradio"
                      aria-checked={invitePermission === permission}
                      onClick={() => {
                        setInviteDraftPermission(permission);
                        setInvitePermissionOpen(false);
                        window.requestAnimationFrame(() => inviteInputRef.current?.focus());
                      }}
                    >
                      {sharePermissionLabel(permission, labels)}
                    </button>
                  ))}
                </span>
              )}
            </span>
            <button type="button" className={styles.shareInviteSubmit} disabled={!canInvite} onClick={() => void submitInvite()}>
              {labels.invite}
            </button>
          </div>
          {filteredPeopleSuggestions.length > 0 && canManageAccess && (
            <div className={styles.sharePeopleSuggestions} aria-label={labels.organizationPeople}>
              {filteredPeopleSuggestions.map((profile) => (
                <button
                  key={profile.userId ?? profile.email ?? profile.organizationMemberId}
                  type="button"
                  data-menu-item
                  disabled={shareControlsDisabled}
                  onClick={() => selectInvitePerson(profile)}
                >
                  <span className={styles.shareSuggestionAvatar}>{inviteInitial(organizationProfileShareLabel(profile, labels))}</span>
                  <span className={styles.shareSuggestionText}>
                    <span>{organizationProfileShareLabel(profile, labels)}</span>
                    <span>{organizationProfileShareSubtext(profile, labels)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {filteredInviteGroups.length > 0 && canManageAccess && (
            <div className={styles.shareGroupSuggestions} aria-label={labels.organizationGroups}>
              {filteredInviteGroups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  data-menu-item
                  disabled={shareControlsDisabled}
                  onClick={() => selectInviteGroup(group.id)}
                >
                  {group.name}
                </button>
              ))}
            </div>
          )}
          {accessLoaded && !accessLoadFailed && !canManageAccess && (
            <div className={styles.shareAccessNotice}>
              {labels.canViewAccessNotice}
            </div>
          )}
          <div className={styles.shareSectionLabel}>{labels.whoHasAccess}</div>
          <div className={styles.shareRow}>
            <span className={styles.shareAvatar}>{userInitial}</span>
            <span className={styles.shareText}>
              <span>{labels.you}</span>
              <span>{accountLabel}</span>
            </span>
            <span className={styles.sharePermission}>{labels.fullAccess}</span>
          </div>
          {invites.map((invite) => (
            <div key={invite.id} className={styles.shareRow}>
              <span className={styles.shareAvatar}>{inviteInitial(invite.label)}</span>
              <span className={styles.shareText}>
                <span>{invite.label}</span>
                <span>{shareInviteKindLabel(invite, labels)}</span>
              </span>
              <span className={styles.sharePermissionWrap} data-share-permission-root="true">
                <button
                  type="button"
                  className={styles.sharePermissionButton}
                  data-menu-item
                  aria-haspopup="menu"
                  aria-expanded={inviteMenuFor === invite.id}
                  disabled={shareControlsDisabled}
                  onClick={() => {
                    setInvitePermissionOpen(false);
                    setInviteMenuFor((current) => (current === invite.id ? null : invite.id));
                  }}
                >
                  {sharePermissionLabel(shareInvitePermission(invite), labels)}
                  <ChevronDown size={12} aria-hidden="true" />
                </button>
                {inviteMenuFor === invite.id && (
                  <span className={styles.sharePermissionMenu} role="menu">
                    {SHARE_PERMISSION_OPTIONS.map((permission) => (
                      <button
                        key={permission}
                        type="button"
                        data-menu-item
                        role="menuitemradio"
                        aria-checked={shareInvitePermission(invite) === permission}
                        onClick={() => void setExistingInvitePermission(invite.id, permission)}
                      >
                        {sharePermissionLabel(permission, labels)}
                      </button>
                    ))}
                    <button
                      type="button"
                      data-menu-item
                      role="menuitem"
                      className={styles.sharePermissionDanger}
                      onClick={() => void removeInvite(invite.id)}
                    >
                      {labels.removeAccess}
                    </button>
                  </span>
                )}
              </span>
            </div>
          ))}
          <div className={styles.shareAccessRow}>
            <span className={styles.shareAccessIcon}>
              {shareToWeb ? (
                <GlobeIcon size={15} aria-hidden="true" />
              ) : (
                <LockIcon size={15} aria-hidden="true" />
              )}
            </span>
            <span>
              <span>{shareToWeb ? labels.anyoneWithLink : labels.privateAccess}</span>
              <span>{shareToWeb ? labels.canView : workspace?.name ?? labels.workspace}</span>
            </span>
          </div>
          <div className={styles.menuDivider} />
          <div className={styles.copyLinks}>
            <button
              type="button"
              className={styles.copyLink}
              data-menu-item
              onClick={() => onCopy("page")}
            >
              <LinkIcon size={16} aria-hidden="true" />
              <span>{copiedPageLink ? labels.copiedPageLink : labels.copyPageLinkButton}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.sharePanel} data-share-panel="publish" role="tabpanel">
          <button
            type="button"
            className={styles.shareWebRow}
            data-menu-item
            role="switch"
            aria-checked={shareToWeb}
            aria-label={shareToWeb ? labels.disableWebSharing(pageTitle) : labels.enableWebSharing(pageTitle)}
            disabled={shareControlsDisabled}
            onClick={() => void toggleWebSharing()}
          >
            <span className={styles.shareAccessIcon}>
              <GlobeIcon size={15} aria-hidden="true" />
            </span>
            <span className={styles.shareWebText}>
              <span>{labels.shareToWeb}</span>
              <span>{shareToWeb ? labels.on : labels.off}</span>
            </span>
            <span className={styles.shareSwitch} data-on={shareToWeb ? "true" : undefined} aria-hidden="true" />
          </button>
          {shareToWeb && (
            <label className={styles.shareExpiryRow}>
              <span className={styles.shareAccessIcon}>
                <ClockIcon size={15} aria-hidden="true" />
              </span>
              <span className={styles.shareExpiryText}>
                <span>{labels.linkExpires}</span>
                <span>{shareExpiryLabel(shareLink, labels)}</span>
              </span>
              <select
                value={expiryOption}
                disabled={shareControlsDisabled}
                aria-label={labels.publicLinkExpiration}
                onChange={(event) => void updateShareExpiry(event.currentTarget.value as ShareExpiryOption)}
              >
                {SHARE_EXPIRY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {shareExpiryOptionLabel(option, labels)}
                  </option>
                ))}
                {expiryOption === "custom" && <option value="custom">{labels.customExpiration}</option>}
              </select>
            </label>
          )}
          <div className={styles.shareAccessRow}>
            <span className={styles.shareAccessIcon}>
              {shareToWeb ? (
                <GlobeIcon size={15} aria-hidden="true" />
              ) : (
                <LockIcon size={15} aria-hidden="true" />
              )}
            </span>
            <span>
              <span>{shareToWeb ? labels.anyoneWithLink : labels.privateAccess}</span>
              <span>{shareToWeb ? labels.canView : workspace?.name ?? labels.workspace}</span>
            </span>
          </div>
          <div className={styles.menuDivider} />
          <div className={styles.copyLinks}>
            {shareToWeb && (
              <button
                type="button"
                className={styles.copyLink}
                data-menu-item
                disabled={!publicHref}
                onClick={() => onCopy("web", publicHref)}
              >
                <GlobeIcon size={16} aria-hidden="true" />
                <span>{copiedWebLink ? labels.copiedWebLink : labels.copyWebLink}</span>
              </button>
            )}
            <button
              type="button"
              className={styles.copyLink}
              data-menu-item
              onClick={() => onCopy("page")}
            >
              <LinkIcon size={16} aria-hidden="true" />
              <span>{copiedPageLink ? labels.copiedPageLink : labels.copyPageLinkButton}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
