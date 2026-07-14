"use client";

import {
  lazy,
  Suspense,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { positionBetween } from "@/lib/ids";
import { useTranslation } from "react-i18next";
import {
  isHanjiStarterWelcomePage,
  isPromotableSyntheticNotionImportChild,
  isSyntheticNotionImportRootPage,
} from "@/lib/importedNotionUi";
import { pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { canCreateWorkspacePage, canEditPage, workspaceMemberShareRole } from "@/lib/permissions";
import { resolveTheme, useTheme } from "@/lib/theme";
import { clearDurableOutboxOnSignOut, useStore } from "@/lib/store";
import {
  claimNotionImportOnboardingRemote,
  listNotificationsRemote,
  signOutRemote,
  suppressNotionImportOnboardingRemote,
} from "@/lib/edgebase";
import type { Block, Page } from "@/lib/types";
import { spansToPlainText } from "@/lib/types";
import type { WorkspaceCreateChoice } from "./WorkspaceCreateDialog";
import type { NotionImportActivitySummary } from "./ImportDialog";
import { BLOCK_DRAG_IDS_TYPE, BLOCK_DRAG_TYPE, PAGE_DRAG_TYPE } from "./dndTypes";
import { TEXT_BLOCKS } from "./editor/textBlockTypes";
import { ErrorBoundary } from "./ErrorBoundary";
import { LegalNotice } from "./LegalNotice";
import { WorkspaceIconGlyph } from "./PageIcon";
import { PageTreeItem } from "./PageTreeItem";
import { SidebarSponsorRoll } from "./SidebarSponsorRoll";
import {
  CheckIcon,
  ChevronDown,
  ChevronRight,
  DoubleChevronLeft,
  DotsHorizontal,
  FileText,
  Home,
  LibraryIcon,
  Download,
  LogOutIcon,
  MailIcon,
  Plus,
  Search,
  Settings,
  Trash,
  Upload,
  UserIcon,
} from "@/icons/hanji";
import styles from "./Sidebar.module.css";

const ImportDialog = lazy(() =>
  import("./ImportDialog").then(({ ImportDialog }) => ({ default: ImportDialog }))
);

export function notionOAuthCallbackPending(params: URLSearchParams) {
  return params.get("notion_import_oauth") === "1";
}
const WorkspaceCreateDialog = lazy(() =>
  import("./WorkspaceCreateDialog").then(({ WorkspaceCreateDialog }) => ({
    default: WorkspaceCreateDialog,
  }))
);
const NotionImportOnboardingDialog = lazy(() =>
  import("./NotionImportOnboardingDialog").then(({ NotionImportOnboardingDialog }) => ({
    default: NotionImportOnboardingDialog,
  }))
);
const TemplatesDialog = lazy(() =>
  import("./TemplatesDialog").then(({ TemplatesDialog }) => ({ default: TemplatesDialog }))
);
const UpdatesPanel = lazy(() =>
  import("./UpdatesPanel").then(({ UpdatesPanel }) => ({ default: UpdatesPanel }))
);

type SidebarSection = "favorites" | "shared" | "private";

const SIDEBAR_SECTION_COLLAPSED_KEY = "hanji:sidebar-section-collapsed";
const SIDEBAR_TOP_RAIL_ICON_SIZE = 19;
const PRIVATE_SECTION_INITIAL_LIMIT = 12;

function readCollapsedSections() {
  if (typeof window === "undefined") return new Set<SidebarSection>();
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(SIDEBAR_SECTION_COLLAPSED_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return new Set<SidebarSection>();
    return new Set(
      parsed.filter((item): item is SidebarSection =>
        item === "favorites" || item === "shared" || item === "private",
      ),
    );
  } catch {
    return new Set<SidebarSection>();
  }
}

function writeCollapsedSections(sections: Set<SidebarSection>) {
  try {
    window.localStorage.setItem(
      SIDEBAR_SECTION_COLLAPSED_KEY,
      JSON.stringify(Array.from(sections)),
    );
  } catch {
    // localStorage can be unavailable in private or constrained contexts.
  }
}

function pageSubtreeIds(pagesById: Record<string, Page>, rootIds: Set<string>) {
  const hidden = new Set(rootIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const page of Object.values(pagesById)) {
      if (page.inTrash || hidden.has(page.id) || !page.parentId) continue;
      if (hidden.has(page.parentId)) {
        hidden.add(page.id);
        changed = true;
      }
    }
  }
  return hidden;
}

function pageHasDescendant(pagesById: Record<string, Page>, rootId: string, targetIds: Set<string>) {
  if (targetIds.has(rootId)) return true;
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const currentId = queue.shift();
    if (!currentId || seen.has(currentId)) continue;
    seen.add(currentId);
    for (const page of Object.values(pagesById)) {
      if (page.inTrash || page.parentId !== currentId || page.parentType !== "page") continue;
      if (targetIds.has(page.id)) return true;
      queue.push(page.id);
    }
  }
  return false;
}

export function Sidebar({
  collapsed,
  onResizeStart,
  onResizeNudge,
  onResizeReset,
  width,
  minWidth,
  maxWidth,
  resizing = false,
  onToggle,
  mobile,
  open,
}: {
  collapsed: boolean;
  onResizeStart?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onResizeNudge?: (delta: number) => void;
  onResizeReset?: () => void;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  resizing?: boolean;
  onToggle: () => void;
  mobile: boolean;
  open: boolean;
}) {
  const { t } = useTranslation(["sidebar", "common"]);
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const searchParams = useSearchParams();
  const notionOAuthCallback = notionOAuthCallbackPending(searchParams);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // A Notion OAuth callback is a full-page return. Open the lazy dialog on the
  // first render so its completion effect cannot be stranded behind a false
  // local `importOpen` state.
  const [importOpen, setImportOpen] = useState(notionOAuthCallback);
  const [notionImportActivity, setNotionImportActivity] =
    useState<NotionImportActivitySummary | null>(null);
  const [notionOnboardingOpen, setNotionOnboardingOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceCreateOpen, setWorkspaceCreateOpen] = useState(false);
  // Creation flows that import land the ImportDialog on the matching tab.
  const [importInitialTab, setImportInitialTab] = useState<"notion" | "hanji" | undefined>(undefined);
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<string | null>(null);
  const [creatingPage, setCreatingPage] = useState(false);
  const [privateShowAll, setPrivateShowAll] = useState(false);
  const [privateSectionMenuOpen, setPrivateSectionMenuOpen] = useState(false);
  const [rootDropActive, setRootDropActive] = useState(false);
  const [rootDropCopy, setRootDropCopy] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<SidebarSection>>(
    readCollapsedSections,
  );
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const mobileRestoreFocusRef = useRef<HTMLElement | null>(null);
  const notionOnboardingCheckedWorkspaceIdsRef = useRef(new Set<string>());
  const [themePref, setThemePref] = useTheme();
  const workspace = useStore((s) => s.workspace);
  const workspaces = useStore((s) => s.workspaces);
  const organization = useStore((s) => s.organization);
  const currentOrganizationMember = useStore((s) => s.currentOrganizationMember);
  const currentMember = useStore((s) => s.currentMember);
  const isInstanceAdmin = useStore((s) => s.isInstanceAdmin);
  const userId = useStore((s) => s.userId);
  const roots = useStore(useShallow((s) => s.childPages(null)));
  const favorites = useStore(useShallow((s) => s.favoritePages()));
  const pagesById = useStore((s) => s.pagesById);
  const pageRoles = useStore((s) => s.pageRolesById);
  const explicitSharedPageIds = useStore((s) => s.sharedPageIds);
  const createPage = useStore((s) => s.createPage);
  const duplicatePage = useStore((s) => s.duplicatePage);

  useEffect(() => {
    if (!notionOAuthCallback) return;
    setImportInitialTab("notion");
    setImportOpen(true);
  }, [notionOAuthCallback, pathname]);
  const movePage = useStore((s) => s.movePage);
  const moveBlockToPage = useStore((s) => s.moveBlockToPage);
  const copyBlockToPage = useStore((s) => s.copyBlockToPage);
  const deleteBlock = useStore((s) => s.deleteBlock);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const setUpdatesOpen = useStore((s) => s.setUpdatesOpen);
  const updatesOpen = useStore((s) => s.updatesOpen);
  // Deferred unmount so the inline inbox can play an exit animation on close:
  // `inboxRendered` keeps it mounted, `inboxExiting` triggers the closing animation,
  // and a matching timeout (0ms under reduced motion) does the final unmount.
  const [inboxRendered, setInboxRendered] = useState(false);
  const [inboxExiting, setInboxExiting] = useState(false);
  const [inboxUnread, setInboxUnread] = useState(false);
  const notify = useStore((s) => s.notify);
  const createWorkspace = useStore((s) => s.createWorkspace);
  const switchWorkspace = useStore((s) => s.switchWorkspace);

  // Inbox unread dot. There is no realtime notification push yet, so the dot
  // refreshes on workspace change, when the tab regains focus/visibility
  // (throttled), and when the inbox closes after reading. Server list/read
  // state stays authoritative.
  useEffect(() => {
    const workspaceId = workspace?.id;
    if (!workspaceId) return;
    let mounted = true;
    let lastRefresh = 0;
    const refresh = (force = false) => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (!force && now - lastRefresh < 30_000) return;
      lastRefresh = now;
      listNotificationsRemote({ workspaceId, limit: 1, includeRead: false })
        .then((result) => {
          if (mounted) setInboxUnread((result.unreadCount ?? 0) > 0);
        })
        .catch(() => {});
    };
    refresh(true);
    const onFocus = () => refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [workspace?.id]);

  // Closing the inbox re-checks the dot immediately (items were likely read).
  useEffect(() => {
    const workspaceId = workspace?.id;
    if (updatesOpen || !workspaceId) return;
    listNotificationsRemote({ workspaceId, limit: 1, includeRead: false })
      .then((result) => setInboxUnread((result.unreadCount ?? 0) > 0))
      .catch(() => {});
  }, [updatesOpen, workspace?.id]);

  // Optimistic read-state signal from the Updates panel: mark-all-read clears
  // the dot immediately (the server write can lag behind the close-time
  // refetch above), then a delayed refetch reconfirms against the server.
  useEffect(() => {
    const workspaceId = workspace?.id;
    if (!workspaceId) return;
    let timer: number | undefined;
    const onReadChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ allRead?: boolean }>).detail;
      if (detail?.allRead) setInboxUnread(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        listNotificationsRemote({ workspaceId, limit: 1, includeRead: false })
          .then((result) => setInboxUnread((result.unreadCount ?? 0) > 0))
          .catch(() => {});
      }, 2000);
    };
    window.addEventListener("hanji:updates-read-changed", onReadChanged);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hanji:updates-read-changed", onReadChanged);
    };
  }, [workspace?.id]);

  // Mount the inline inbox when it opens (desktop sidebar or mobile drawer); on
  // close, keep it mounted and flag it exiting so its slide-out animation can play
  // before the tree returns.
  useEffect(() => {
    if (updatesOpen) {
      setInboxRendered(true);
      setInboxExiting(false);
    } else {
      setInboxExiting((wasExiting) => (inboxRendered ? true : wasExiting));
    }
  }, [updatesOpen, inboxRendered]);

  useEffect(() => {
    if (!inboxExiting) return;
    const reduceMotion =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;
    const timer = window.setTimeout(() => {
      setInboxRendered(false);
      setInboxExiting(false);
    }, reduceMotion ? 0 : 210);
    return () => window.clearTimeout(timer);
  }, [inboxExiting]);

  const activePageId =
    typeof params?.pageId === "string"
      ? params.pageId
      : typeof params?.databaseId === "string"
        ? params.databaseId
      : undefined;
  const organizationRole =
    organization?.ownerId === userId ? "owner" : currentOrganizationMember?.role;
  const workspaceCreationPolicy =
    organization?.workspaceCreationPolicy === "members" ? "members" : "owners_admins";
  const canCreateWorkspaceInOrganization =
    !organization?.id ||
    organizationRole === "owner" ||
    organizationRole === "admin" ||
    (workspaceCreationPolicy === "members" && organizationRole === "member");
  const workspaceRole = workspaceMemberShareRole({ workspace, currentMember, userId });
  const canCreateRootPage = canCreateWorkspacePage({ workspace, currentMember, userId });
  const canUseFooterNewPage = canCreateRootPage;
  const canManageWorkspaceSettings =
    workspaceRole === "full_access" || organizationRole === "owner" || organizationRole === "admin";
  const canOpenAdminConsole =
    canManageWorkspaceSettings ||
    organizationRole === "security_admin" ||
    organizationRole === "billing_admin";
  // The server console is instance-wide and only loads for instance admins, so
  // gate its entry point on instance-admin status (not workspace/org role) —
  // otherwise a workspace owner would open a console that fails to load.
  const canOpenServerConsole = isInstanceAdmin;

  useEffect(() => {
    const workspaceId = workspace?.id;
    if (
      !workspaceId ||
      !isInstanceAdmin ||
      !canManageWorkspaceSettings ||
      notionOAuthCallback ||
      importOpen ||
      templatesOpen ||
      workspaceCreateOpen ||
      notionOnboardingCheckedWorkspaceIdsRef.current.has(workspaceId)
    ) {
      return;
    }
    notionOnboardingCheckedWorkspaceIdsRef.current.add(workspaceId);
    let cancelled = false;
    claimNotionImportOnboardingRemote(workspaceId)
      .then(({ show }) => {
        if (!cancelled && show) setNotionOnboardingOpen(true);
      })
      .catch(() => {
        // A failed claim did not consume the server record. Let a later
        // workspace/modal transition retry instead of blocking the app shell.
        notionOnboardingCheckedWorkspaceIdsRef.current.delete(workspaceId);
      });
    return () => {
      cancelled = true;
    };
  }, [
    canManageWorkspaceSettings,
    importOpen,
    isInstanceAdmin,
    notionOAuthCallback,
    templatesOpen,
    workspace?.id,
    workspaceCreateOpen,
  ]);

  useEffect(() => {
    setNotionOnboardingOpen(false);
  }, [workspace?.id]);
  const workspaceSettingsLabel = t("sidebar:accountConsole");
  // The inbox is "active" while it is open and while its inline view is still
  // animating out, so the rail label and Home stay in sync with the body during
  // the exit transition instead of flipping a frame early.
  const inboxActive = updatesOpen || inboxRendered;
  const homeActionActive =
    !inboxActive &&
    (pathname === "/" ||
      pathname.startsWith("/workspace/") ||
      pathname.startsWith("/p/") ||
      pathname.startsWith("/database/"));
  const favoritesCollapsed = collapsedSections.has("favorites");
  const sharedCollapsed = collapsedSections.has("shared");
  const privateCollapsed = collapsedSections.has("private");
  const resolvedTheme = resolveTheme(themePref);
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  const hasSyntheticImportRoot = useMemo(
    () => roots.some((page) => isSyntheticNotionImportRootPage(page)),
    [roots],
  );
  const syntheticImportRootIds = useMemo(
    () => new Set(roots.filter((page) => isSyntheticNotionImportRootPage(page)).map((page) => page.id)),
    [roots],
  );
  const sharedPages = useMemo(
    () => {
      const byId = new Map<string, Page>();
      for (const page of Object.values(pagesById)) {
        if (!page.inTrash && explicitSharedPageIds.has(page.id)) {
          byId.set(page.id, page);
        }
      }
      if (!canCreateRootPage) {
        for (const page of roots) {
          if (!page.inTrash && pageRoles[page.id]) byId.set(page.id, page);
        }
      }
      return Array.from(byId.values())
        .sort((a, b) => {
          const byEdited = (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? "");
          if (byEdited !== 0) return byEdited;
          return pageDisplayTitle(a).localeCompare(pageDisplayTitle(b));
        });
    },
    [canCreateRootPage, explicitSharedPageIds, pageRoles, pagesById, roots],
  );
  const sharedPageIds = useMemo(() => new Set(sharedPages.map((page) => page.id)), [sharedPages]);
  const privateTreeHiddenPageIds = useMemo(
    () => pageSubtreeIds(pagesById, sharedPageIds),
    [pagesById, sharedPageIds],
  );
  const sidebarAnchorPageIds = useMemo(
    () => new Set([...sharedPageIds, ...favorites.map((page) => page.id)]),
    [favorites, sharedPageIds],
  );
  const anchoredSyntheticImportRootIds = useMemo(() => {
    const rootIds = new Set<string>();
    for (const pageId of sidebarAnchorPageIds) {
      const page = pagesById[pageId];
      if (page?.parentType === "page" && page.parentId && syntheticImportRootIds.has(page.parentId)) {
        rootIds.add(page.parentId);
      }
    }
    return rootIds;
  }, [pagesById, sidebarAnchorPageIds, syntheticImportRootIds]);
  const privateRootPages = useMemo(
    () => {
      const directRoots = roots.filter((page) => {
        if (privateTreeHiddenPageIds.has(page.id)) return false;
        if (hasSyntheticImportRoot && isHanjiStarterWelcomePage(page)) return false;
        return !(
          isSyntheticNotionImportRootPage(page) &&
          pageHasDescendant(pagesById, page.id, sidebarAnchorPageIds)
        );
      });
      const promotedImportedRoots = Object.values(pagesById)
        .filter((page) => {
          if (page.inTrash || page.parentType !== "page" || !page.parentId) return false;
          if (!syntheticImportRootIds.has(page.parentId)) return false;
          if (anchoredSyntheticImportRootIds.has(page.parentId) && !sidebarAnchorPageIds.has(page.id)) {
            return false;
          }
          if (!isPromotableSyntheticNotionImportChild(page)) return false;
          if (privateTreeHiddenPageIds.has(page.id)) return false;
          if (sharedPageIds.has(page.id)) return false;
          return true;
        })
        .sort((a, b) => a.position - b.position || pageDisplayTitle(a).localeCompare(pageDisplayTitle(b)));
      return [...directRoots, ...promotedImportedRoots];
    },
    [
      anchoredSyntheticImportRootIds,
      hasSyntheticImportRoot,
      pagesById,
      privateTreeHiddenPageIds,
      roots,
      sharedPageIds,
      sidebarAnchorPageIds,
      syntheticImportRootIds,
    ],
  );
  const privateActiveIndex = activePageId
    ? privateRootPages.findIndex((page) => page.id === activePageId)
    : -1;
  const privateNeedsShowMore = privateRootPages.length > PRIVATE_SECTION_INITIAL_LIMIT;
  const visiblePrivateRootPages = useMemo(() => {
    if (!privateNeedsShowMore || privateShowAll) return privateRootPages;
    const visible = privateRootPages.slice(0, PRIVATE_SECTION_INITIAL_LIMIT);
    if (privateActiveIndex >= PRIVATE_SECTION_INITIAL_LIMIT) {
      return [
        ...visible.slice(0, Math.max(PRIVATE_SECTION_INITIAL_LIMIT - 1, 0)),
        privateRootPages[privateActiveIndex],
      ];
    }
    return visible;
  }, [privateActiveIndex, privateNeedsShowMore, privateRootPages, privateShowAll]);
  const labels = {
    addPrivatePage: t("sidebar:addPrivatePage"),
    closeSidebar: t("sidebar:closeSidebar"),
    createFirstPrivatePage: t("sidebar:createFirstPrivatePage"),
    creating: t("sidebar:creating"),
    workspace: t("sidebar:workspace"),
    workspaces: t("sidebar:workspaces"),
    newWorkspace: t("sidebar:newWorkspace"),
    sidebar: t("sidebar:sidebar"),
    openWorkspaceMenu: t("sidebar:openWorkspaceMenu"),
    closeWorkspaceMenu: t("sidebar:closeWorkspaceMenu"),
    workspaceMenu: t("sidebar:workspaceMenu"),
    exportWorkspace: t("sidebar:exportWorkspace"),
    exportedWorkspace: t("sidebar:exportedWorkspace"),
    exportedWorkspaceWithPlaceholders: t("sidebar:exportedWorkspaceWithPlaceholders"),
    couldntExportWorkspace: t("sidebar:couldntExportWorkspace"),
    darkMode: t("sidebar:darkMode"),
    lightMode: t("sidebar:lightMode"),
    couldntSwitchWorkspace: t("sidebar:couldntSwitchWorkspace"),
    untitledWorkspace: t("sidebar:untitledWorkspace"),
    createdWorkspace: t("sidebar:createdWorkspace"),
    pageAccessRequired: t("sidebar:pageAccessRequired"),
    couldntCreatePage: t("sidebar:couldntCreatePage"),
    untitledPage: t("sidebar:untitledPage"),
    cantCopyPageHere: t("sidebar:cantCopyPageHere"),
    cantMovePageHere: t("sidebar:cantMovePageHere"),
    couldntCopyPage: t("sidebar:couldntCopyPage"),
    couldntMovePage: t("sidebar:couldntMovePage"),
    copiedPage: t("sidebar:copiedPage"),
    movedPage: t("sidebar:movedPage"),
    cantCopyBlocksHere: t("sidebar:cantCopyBlocksHere"),
    cantMoveBlocksHere: t("sidebar:cantMoveBlocksHere"),
    copiedBlocksToNewPage: t("sidebar:copiedBlocksToNewPage"),
    movedBlocksToNewPage: t("sidebar:movedBlocksToNewPage"),
    couldntCopyBlocks: t("sidebar:couldntCopyBlocks"),
    couldntMoveBlocks: t("sidebar:couldntMoveBlocks"),
    switchToDarkMode: t("sidebar:switchToDarkMode"),
    switchToLightMode: t("sidebar:switchToLightMode"),
    logOut: t("sidebar:logOut"),
    resizeSidebar: t("sidebar:resizeSidebar"),
    favoritePages: t("sidebar:favoritePages"),
    favorites: t("sidebar:favorites"),
    home: t("sidebar:home"),
    import: t("sidebar:import"),
    importInProgress: t("sidebar:importInProgress"),
    importProgress: (percent: number) => t("sidebar:importProgress", { percent }),
    inbox: t("sidebar:inbox"),
    inboxUnread: t("sidebar:inboxUnread"),
    newPage: t("sidebar:newPage"),
    openPrivateLibrary: t("sidebar:openPrivateLibrary"),
    openPrivateOptions: t("sidebar:openPrivateOptions"),
    openWorkspaceHome: t("sidebar:openWorkspaceHome"),
    private: t("sidebar:private"),
    privatePages: t("sidebar:privatePages"),
    privateOptions: t("sidebar:privateOptions"),
    quickFind: t("sidebar:quickFind"),
    shared: t("sidebar:shared"),
    sharedPages: t("sidebar:sharedPages"),
    showFewerPrivatePages: t("sidebar:showFewerPrivatePages"),
    showMorePrivatePages: t("sidebar:showMorePrivatePages"),
    serverConsole: t("sidebar:serverConsole"),
    templates: t("sidebar:templates"),
    trash: t("sidebar:trash"),
    workspaceActions: t("sidebar:workspaceActions"),
    workspaceConsole: t("sidebar:workspaceConsole"),
  };

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const menu = workspaceMenuRef.current;
      if (!menu) return;
      // The first item can be the active workspace, which renders disabled;
      // focusing it silently fails and leaves Escape/arrow keys dead.
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("[data-workspace-menu-item]"));
      const target = items.find((item) => !item.disabled) ?? menu;
      target.focus({ preventScroll: true });
      menu
        .querySelector<HTMLButtonElement>('[data-workspace-menu-item][data-active="true"]')
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [workspaceMenuOpen]);

  function closeWorkspaceMenu(restoreFocus = false) {
    setWorkspaceMenuOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => workspaceButtonRef.current?.focus());
    }
  }

  function openInbox() {
    // The inbox swaps the sidebar content in place (Notion-style) on both desktop
    // and the mobile drawer. Read the current store value at click time rather
    // than the render-time closure: a just-finished route cleanup can otherwise
    // make a fresh click write the same false value back and leave Inbox closed.
    setUpdatesOpen(!useStore.getState().updatesOpen);
  }

  function settingsHrefFromCurrentRoute(section?: "members") {
    const sectionParam = section ? `section=${encodeURIComponent(section)}` : "";
    if (typeof window === "undefined") return sectionParam ? `/account?${sectionParam}` : "/account";
    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const fromParam = pathname === "/settings" || pathname === "/account" ? "" : `from=${encodeURIComponent(currentPath)}`;
    const params = [fromParam, sectionParam].filter(Boolean).join("&");
    return params ? `/account?${params}` : "/account";
  }

  function workspaceConsoleHref(section?: "workspace" | "members" | "domains" | "sharing" | "usage") {
    const params = new URLSearchParams({ admin: "workspace" });
    if (section) params.set("section", section);
    return `/settings?${params.toString()}`;
  }

  function serverConsoleHref(section?: "accounts" | "signup" | "users") {
    const params = new URLSearchParams({ admin: "server" });
    if (section) params.set("section", section);
    return `/settings?${params.toString()}`;
  }

  function openSettingsRoute() {
    if (mobile && open) onToggle();
    router.push(settingsHrefFromCurrentRoute());
  }

  async function signOut() {
    closeWorkspaceMenu(false);
    // Start the SDK's local-first sign-out before any storage or network work.
    // Unsynced writes are deliberately discarded by the shared-device privacy
    // contract; they must never delay credential removal or hiding private UI.
    void signOutRemote().catch(() => {});
    try {
      await clearDurableOutboxOnSignOut();
    } finally {
      window.location.assign("/");
    }
  }

  function workspaceMenuItems() {
    return Array.from(
      workspaceMenuRef.current?.querySelectorAll<HTMLButtonElement>("[data-workspace-menu-item]") ??
        [],
    ).filter((item) => !item.disabled && item.offsetParent !== null);
  }

  function onWorkspaceMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeWorkspaceMenu(true);
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(e.key)) return;
    const items = workspaceMenuItems();
    if (items.length === 0) return;
    e.preventDefault();
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    let nextIndex = activeIndex >= 0 ? activeIndex : 0;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      nextIndex = activeIndex >= 0 ? (activeIndex + 1) % items.length : 0;
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      nextIndex = activeIndex > 0 ? activeIndex - 1 : items.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }
    items[nextIndex]?.focus();
  }

  function toggleTheme() {
    setThemePref(nextTheme);
    notify(nextTheme === "dark" ? labels.darkMode : labels.lightMode, "success");
    closeWorkspaceMenu(true);
  }

  function workspaceRoute(target = workspace) {
    const slug = target?.domain?.trim();
    return slug ? `/workspace/${encodeURIComponent(slug)}` : "/";
  }

  async function switchToWorkspace(id: string) {
    if (!id || id === workspace?.id || switchingWorkspaceId) return;
    setSwitchingWorkspaceId(id);
    try {
      const next = await switchWorkspace(id);
      closeWorkspaceMenu(false);
      router.push(workspaceRoute(next));
    } catch (error) {
      notify(error instanceof Error ? error.message : labels.couldntSwitchWorkspace, "error");
    } finally {
      setSwitchingWorkspaceId(null);
    }
  }

  async function createWorkspaceFromDialog({
    name,
    choice,
  }: {
    name: string;
    choice: WorkspaceCreateChoice;
  }) {
    const next = await createWorkspace({
      name: name || labels.untitledWorkspace,
      icon: "📓",
      organizationId: organization?.id ?? null,
      // Import flows skip the starter pages so the imported tree arrives clean.
      skipDefaultPages: choice !== "blank",
    });
    // This flow already asked how the workspace should start, so it must not
    // trigger the first-login prompt on the newly selected workspace.
    notionOnboardingCheckedWorkspaceIdsRef.current.add(next.id);
    void suppressNotionImportOnboardingRemote(next.id).catch(() => {});
    setWorkspaceCreateOpen(false);
    router.push(workspaceRoute(next));
    notify(labels.createdWorkspace, "success");
    if (choice !== "blank") {
      setImportInitialTab(choice);
      setImportOpen(true);
    }
    return next;
  }

  function openNotionImportFromOnboarding() {
    setNotionOnboardingOpen(false);
    setImportInitialTab("notion");
    setImportOpen(true);
  }

  function setSectionCollapsed(section: SidebarSection, nextCollapsed: boolean) {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (nextCollapsed) next.add(section);
      else next.delete(section);
      writeCollapsedSections(next);
      return next;
    });
  }

  function toggleSection(section: SidebarSection) {
    setSectionCollapsed(section, !collapsedSections.has(section));
  }

  function closePrivateSectionMenu() {
    setPrivateSectionMenuOpen(false);
  }

  async function newRootPage() {
    if (creatingPage) return;
    if (!canCreateRootPage) {
      notify(labels.pageAccessRequired, "default");
      return;
    }
    setSectionCollapsed("private", false);
    setCreatingPage(true);
    try {
      const last = privateRootPages[privateRootPages.length - 1];
      const page = await createPage({
        parentId: null,
        parentType: "workspace",
        afterPosition: last?.position,
      });
      router.push(pageHref(page.id));
    } catch (error) {
      notify(error instanceof Error ? error.message : labels.couldntCreatePage, "error");
    } finally {
      setCreatingPage(false);
    }
  }

  function openWorkspaceHome() {
    if (mobile && open) onToggle();
    router.push(workspaceRoute());
  }

  function openSearch() {
    if (mobile && open) onToggle();
    setSearchOpen(true);
  }

  function openTemplates() {
    if (mobile && open) onToggle();
    setTemplatesOpen(true);
  }

  function droppedPageId(e: React.DragEvent) {
    return (
      e.dataTransfer.getData(PAGE_DRAG_TYPE) ||
      e.dataTransfer.getData("text/plain")
    );
  }

  function droppedBlockIds(e: React.DragEvent) {
    const raw = e.dataTransfer.getData(BLOCK_DRAG_IDS_TYPE);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
        }
      } catch {
        // Fall back to the single-block payload.
      }
    }
    const id = e.dataTransfer.getData(BLOCK_DRAG_TYPE);
    return id ? [id] : [];
  }

  // blocksByPage is read at event time (drag/drop handlers only) instead of
  // being subscribed: its identity changes on every editor keystroke and a
  // subscription re-rendered the whole sidebar with it.
  function findBlock(blockId?: string) {
    if (!blockId) return undefined;
    for (const blocks of Object.values(useStore.getState().blocksByPage)) {
      const block = blocks.find((item) => item.id === blockId);
      if (block) return block;
    }
    return undefined;
  }

  function directChildBlockIds(block: Block) {
    return (useStore.getState().blocksByPage[block.pageId] ?? [])
      .filter((candidate) => candidate.parentId === block.id)
      .sort((a, b) => a.position - b.position)
      .map((candidate) => candidate.id);
  }

  function blockTitle(block?: Block) {
    if (!block) return "";
    return (
      spansToPlainText(block.content?.rich) ||
      block.plainText ||
      block.content?.expression ||
      block.content?.fileName ||
      ""
    ).trim();
  }

  function canDropOnPrivateRoot(pageId?: string) {
    if (!canCreateRootPage) return false;
    const page = pageId ? pagesById[pageId] : undefined;
    if (
      page &&
      !canEditPage({ page, pagesById, pageRoles, workspace, currentMember, userId })
    ) {
      return false;
    }
    const sourceParent = page?.parentId ? pagesById[page.parentId] : undefined;
    return !!page && !page.inTrash && !sourceParent?.isLocked;
  }

  function canDropBlocksOnPrivateRoot(blockIds: string[], copy = false) {
    if (!canCreateRootPage) return false;
    if (blockIds.length === 0) return false;
    const sourcePages = blockIds.map((id) => {
      const block = findBlock(id);
      return block ? pagesById[block.pageId] : undefined;
    });
    if (sourcePages.some((sourcePage) => !sourcePage)) return false;
    if (copy) return true;
    return sourcePages.every((sourcePage) => !sourcePage?.isLocked);
  }

  async function dropPageToPrivateRoot(pageId: string, copy: boolean) {
    if (!canDropOnPrivateRoot(pageId)) {
      notify(copy ? labels.cantCopyPageHere : labels.cantMovePageHere, "default");
      return;
    }
    try {
      const droppedPage = copy ? await duplicatePage(pageId) : undefined;
      const droppedPageId = copy ? droppedPage?.id : pageId;
      if (!droppedPageId) {
        notify(copy ? labels.couldntCopyPage : labels.couldntMovePage, "error");
        return;
      }
      const positionSource = copy ? privateRootPages : privateRootPages.filter((page) => page.id !== pageId);
      await movePage(
        droppedPageId,
        null,
        "workspace",
        positionBetween(positionSource[positionSource.length - 1]?.position, undefined)
      );
      setSectionCollapsed("private", false);
      notify(copy ? labels.copiedPage : labels.movedPage, "success");
    } catch {
      notify(copy ? labels.couldntCopyPage : labels.couldntMovePage, "error");
    }
  }

  async function dropBlocksToNewRootPage(blockIds: string[], copy: boolean) {
    if (!canDropBlocksOnPrivateRoot(blockIds, copy)) {
      notify(copy ? labels.cantCopyBlocksHere : labels.cantMoveBlocksHere, "default");
      return;
    }
    try {
      const firstBlock = findBlock(blockIds[0]);
      const title = blockTitle(firstBlock);
      const page = await createPage({
        parentId: null,
        parentType: "workspace",
        title: title || labels.untitledPage,
        afterPosition: privateRootPages[privateRootPages.length - 1]?.position,
        focusTitle: false,
      });

      const firstBlockBecomesTitle = !!firstBlock && title.length > 0 && TEXT_BLOCKS.has(firstBlock.type);
      const blocksToMove = firstBlockBecomesTitle ? blockIds.slice(1) : blockIds;
      if (firstBlockBecomesTitle) {
        for (const childId of directChildBlockIds(firstBlock)) {
          if (copy) {
            const copied = await copyBlockToPage(childId, page.id);
            if (!copied) throw new Error("Block copy was not persisted.");
          }
          else await moveBlockToPage(childId, page.id);
        }
        if (!copy) {
          await deleteBlock(firstBlock.id, { history: false });
        }
      }
      for (const blockId of blocksToMove) {
        if (copy) {
          const copied = await copyBlockToPage(blockId, page.id);
          if (!copied) throw new Error("Block copy was not persisted.");
        }
        else await moveBlockToPage(blockId, page.id);
      }
      setSectionCollapsed("private", false);
      router.push(pageHref(page.id));
      notify(copy ? labels.copiedBlocksToNewPage : labels.movedBlocksToNewPage, "success");
    } catch {
      notify(copy ? labels.couldntCopyBlocks : labels.couldntMoveBlocks, "error");
    }
  }

  function onPrivateRootDragOver(e: React.DragEvent<HTMLDivElement>) {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target?.closest('[data-page-tree-item="true"]')) {
      setRootDropActive(false);
      setRootDropCopy(false);
      return;
    }
    const types = Array.from(e.dataTransfer.types);
    const canDrop =
      types.includes(BLOCK_DRAG_TYPE)
        ? canDropBlocksOnPrivateRoot(droppedBlockIds(e), e.altKey)
        : canDropOnPrivateRoot(droppedPageId(e));
    if (!canDrop) {
      setRootDropActive(false);
      setRootDropCopy(false);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
    setRootDropActive(true);
    setRootDropCopy(e.altKey);
  }

  function onPrivateRootDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (
      e.relatedTarget instanceof Node &&
      e.currentTarget.contains(e.relatedTarget)
    ) {
      return;
    }
    setRootDropActive(false);
    setRootDropCopy(false);
  }

  function onPrivateRootDrop(e: React.DragEvent<HTMLDivElement>) {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target?.closest('[data-page-tree-item="true"]')) return;
    e.preventDefault();
    e.stopPropagation();
    const types = Array.from(e.dataTransfer.types);
    if (types.includes(BLOCK_DRAG_TYPE)) {
      const blockIds = droppedBlockIds(e);
      setRootDropActive(false);
      setRootDropCopy(false);
      void dropBlocksToNewRootPage(blockIds, e.altKey);
      return;
    }
    const pageId = droppedPageId(e);
    setRootDropActive(false);
    setRootDropCopy(false);
    void dropPageToPrivateRoot(pageId, e.altKey);
  }

  const interactive = open && !collapsed;
  const topLevelDialogOpen = templatesOpen || importOpen || workspaceCreateOpen;

  useEffect(() => {
    if (!topLevelDialogOpen) return;
    const main = document.querySelector<HTMLElement>('[data-app-main="true"]');
    if (!main) return;
    main.inert = true;
    return () => {
      main.inert = main.dataset.shellInert === "true";
    };
  }, [topLevelDialogOpen]);

  useEffect(() => {
    if (!mobile || !open) return;
    mobileRestoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => workspaceButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      const restore = mobileRestoreFocusRef.current;
      mobileRestoreFocusRef.current = null;
      if (restore?.isConnected) window.requestAnimationFrame(() => restore.focus());
    };
  }, [mobile, open]);

  function onSidebarKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (!mobile || !interactive || topLevelDialogOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onToggle();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = Array.from(
      asideRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <aside
        ref={asideRef}
        className={styles.sidebar}
        role={mobile ? "dialog" : undefined}
        aria-modal={mobile && interactive ? true : undefined}
        data-app-sidebar="true"
        data-mobile={mobile}
        data-open={open}
        data-collapsed={collapsed ? "true" : undefined}
        data-resizing={resizing ? "true" : undefined}
        aria-label={labels.sidebar}
        aria-hidden={interactive && !topLevelDialogOpen ? undefined : true}
        inert={interactive && !topLevelDialogOpen ? undefined : true}
        onKeyDown={onSidebarKeyDown}
      >
        <div className={styles.header}>
          <button
            ref={workspaceButtonRef}
            type="button"
            className={styles.workspaceBtn}
            data-sidebar-workspace-button
            onClick={() => setWorkspaceMenuOpen((current) => !current)}
            aria-label={labels.openWorkspaceMenu}
            aria-haspopup="menu"
            aria-expanded={workspaceMenuOpen}
          >
            <span className={styles.wsIcon} aria-hidden="true">
              <WorkspaceIconGlyph icon={workspace?.icon} size={18} />
            </span>
            <span className={styles.wsName}>{workspace?.name ?? labels.workspace}</span>
            <ChevronDown
              className={styles.wsChevron}
              data-sidebar-workspace-chevron
              size={14}
              aria-hidden="true"
            />
          </button>
          {workspaceMenuOpen && (
            <>
              <button
                type="button"
                className={styles.workspaceMenuBackdrop}
                onClick={() => closeWorkspaceMenu(true)}
                tabIndex={-1}
                aria-label={labels.closeWorkspaceMenu}
              />
              <div
                ref={workspaceMenuRef}
                className={styles.workspaceMenu}
                role="menu"
                tabIndex={-1}
                aria-label={labels.workspaceMenu}
                onKeyDown={onWorkspaceMenuKeyDown}
              >
                <div className={styles.workspaceMenuAccount}>
                  <span className={styles.workspaceMenuIcon} aria-hidden="true">
                    <WorkspaceIconGlyph icon={workspace?.icon} size={20} />
                  </span>
                  <span>
                    <strong>{workspace?.name ?? labels.workspace}</strong>
                    <span>{labels.workspace}</span>
                  </span>
                </div>
                <div className={styles.workspaceMenuDivider} />
                {workspaces.length > 1 && (
                  <>
                    <div className={styles.workspaceMenuGroup} role="group" aria-label={labels.workspaces}>
                      {workspaces.map((item) => {
                        const active = item.id === workspace?.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={styles.workspaceMenuItem}
                            data-workspace-menu-item
                            data-active={active ? "true" : undefined}
                            role="menuitemradio"
                            aria-checked={active}
                            disabled={active || switchingWorkspaceId === item.id}
                            onClick={() => void switchToWorkspace(item.id)}
                          >
                            {active ? (
                              <CheckIcon size={16} aria-hidden="true" />
                            ) : (
                              <WorkspaceIconGlyph icon={item.icon} size={16} />
                            )}
                            <span>{item.name}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className={styles.workspaceMenuDivider} />
                  </>
                )}
                {canCreateWorkspaceInOrganization ? (
                  <button
                    type="button"
                    className={styles.workspaceMenuItem}
                    data-workspace-menu-item
                    role="menuitem"
                    onClick={() => {
                      closeWorkspaceMenu(false);
                      setWorkspaceCreateOpen(true);
                    }}
                  >
                    <Plus size={16} aria-hidden="true" />
                    <span>{labels.newWorkspace}</span>
                  </button>
                ) : null}
                <div className={styles.workspaceMenuDivider} />
                <button
                  type="button"
                  className={styles.workspaceMenuItem}
                  data-workspace-menu-item
                  role="menuitem"
                  onClick={() => {
                    closeWorkspaceMenu(false);
                    openSettingsRoute();
                  }}
                >
                  <UserIcon size={16} aria-hidden="true" />
                  <span>{workspaceSettingsLabel}</span>
                </button>
                {canOpenAdminConsole ? (
                  <button
                    type="button"
                    className={styles.workspaceMenuItem}
                    data-workspace-menu-item
                    role="menuitem"
                    onClick={() => {
                      closeWorkspaceMenu(false);
                      router.push(workspaceConsoleHref());
                    }}
                  >
                    <UserIcon size={16} aria-hidden="true" />
                    <span>{labels.workspaceConsole}</span>
                  </button>
                ) : null}
                {canOpenServerConsole ? (
                  <button
                    type="button"
                    className={styles.workspaceMenuItem}
                    data-workspace-menu-item
                    role="menuitem"
                    onClick={() => {
                      closeWorkspaceMenu(false);
                      router.push(serverConsoleHref());
                    }}
                  >
                    <Settings size={16} aria-hidden="true" />
                    <span>{labels.serverConsole}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.workspaceMenuItem}
                  data-workspace-menu-item
                  role="menuitem"
                  onClick={() => {
                    closeWorkspaceMenu(false);
                    setTemplatesOpen(true);
                  }}
                >
                  <FileText size={16} aria-hidden="true" />
                  <span>{labels.templates}</span>
                </button>
                <button
                  type="button"
                  className={styles.workspaceMenuItem}
                  data-workspace-menu-item
                  role="menuitem"
                  onClick={() => {
                    closeWorkspaceMenu(false);
                    setImportOpen(true);
                  }}
                >
                  <Upload size={16} aria-hidden="true" />
                  <span>{labels.import}</span>
                </button>
                <button
                  type="button"
                  className={styles.workspaceMenuItem}
                  data-workspace-menu-item
                  role="menuitem"
                  onClick={() => {
                    closeWorkspaceMenu(false);
                    if (!workspace?.id) return;
                    const targetId = workspace.id;
                    const targetName = workspace.name;
                    void (async () => {
                      try {
                        const { exportWorkspaceAsNative } = await import("./nativeExport");
                        const { warnings } = await exportWorkspaceAsNative(targetId, targetName);
                        notify(
                          warnings.length
                            ? labels.exportedWorkspaceWithPlaceholders
                            : labels.exportedWorkspace,
                          "success"
                        );
                      } catch {
                        notify(labels.couldntExportWorkspace, "error");
                      }
                    })();
                  }}
                >
                  <Download size={16} aria-hidden="true" />
                  <span>{labels.exportWorkspace}</span>
                </button>
                <button
                  type="button"
                  className={styles.workspaceMenuItem}
                  data-workspace-menu-item
                  role="menuitem"
                  onClick={() => {
                    closeWorkspaceMenu(false);
                    router.push("/trash");
                  }}
                >
                  <Trash size={16} aria-hidden="true" />
                  <span>{labels.trash}</span>
                </button>
                <div className={styles.workspaceMenuDivider} />
                <button
                  type="button"
                  className={styles.workspaceMenuItem}
                  data-workspace-menu-item
                  role="menuitemcheckbox"
                  aria-checked={resolvedTheme === "dark"}
                  onClick={toggleTheme}
                >
                  <CheckIcon
                    className={styles.workspaceMenuCheck}
                    size={16}
                    aria-hidden="true"
                    data-hidden={resolvedTheme === "dark" ? undefined : "true"}
                  />
                  <span>{nextTheme === "dark" ? labels.switchToDarkMode : labels.switchToLightMode}</span>
                </button>
                <button
                  type="button"
                  className={styles.workspaceMenuItem}
                  data-workspace-menu-item
                  role="menuitem"
                  onClick={() => void signOut()}
                >
                  <LogOutIcon size={16} aria-hidden="true" />
                  <span>{labels.logOut}</span>
                </button>
              </div>
            </>
          )}
          <button
            type="button"
            className={styles.collapseBtn}
            data-sidebar-collapse-action
            onClick={onToggle}
            title={labels.closeSidebar}
            aria-label={labels.closeSidebar}
          >
            <DoubleChevronLeft size={18} />
          </button>
        </div>

        <nav className={styles.actions} aria-label={labels.workspaceActions} data-sidebar-top-actions>
          {/* Notion-style rail: only the active destination expands to show its
              label; the others stay compact icon buttons. */}
          <button
            type="button"
            className={homeActionActive ? `${styles.topAction} ${styles.homeAction}` : styles.topActionIcon}
            data-active={homeActionActive ? "true" : undefined}
            data-sidebar-home-action
            data-sidebar-rail-slot="home"
            onClick={openWorkspaceHome}
            aria-label={labels.openWorkspaceHome}
            title={labels.home}
          >
            <Home size={SIDEBAR_TOP_RAIL_ICON_SIZE} weight="regular" aria-hidden="true" />
            {homeActionActive && <span className={styles.homeLabel}>{labels.home}</span>}
          </button>
          <button
            type="button"
            className={inboxActive ? `${styles.topAction} ${styles.homeAction}` : styles.topActionIcon}
            data-active={inboxActive ? "true" : undefined}
            aria-pressed={inboxActive}
            data-sidebar-icon-action
            data-sidebar-rail-slot="inbox"
            onClick={openInbox}
            aria-label={inboxUnread ? labels.inboxUnread : labels.inbox}
            title={inboxUnread ? labels.inboxUnread : labels.inbox}
            data-unread={inboxUnread ? "true" : undefined}
          >
            <MailIcon size={SIDEBAR_TOP_RAIL_ICON_SIZE} weight="regular" aria-hidden="true" />
            {inboxUnread ? <span className={styles.inboxUnreadDot} aria-hidden="true" /> : null}
            {inboxActive && <span className={styles.homeLabel}>{labels.inbox}</span>}
          </button>
          <button
            type="button"
            className={styles.topActionIcon}
            data-sidebar-icon-action
            data-sidebar-rail-slot="search"
            onClick={openSearch}
            aria-label={labels.quickFind}
            title={labels.quickFind}
          >
            <Search size={SIDEBAR_TOP_RAIL_ICON_SIZE} weight="regular" aria-hidden="true" />
          </button>
        </nav>

        {inboxRendered ? (
          <Suspense fallback={<div className={styles.inboxLoading} aria-hidden="true" />}>
            <ErrorBoundary scope="sidebar-inbox">
              <UpdatesPanel
                placement="sidebar-inline"
                exiting={inboxExiting}
                onClose={() => setUpdatesOpen(false)}
              />
            </ErrorBoundary>
          </Suspense>
        ) : (
        <>
        <div className={`${styles.scroll} nscroll`}>
          {favorites.length > 0 && (
            <section className={styles.section}>
              <div className={styles.sectionLabel}>
                <button
                  type="button"
                  className={styles.sectionToggle}
                  aria-expanded={!favoritesCollapsed}
                  aria-controls="sidebar-favorites-section"
                  onClick={() => toggleSection("favorites")}
                >
                  <span className={styles.sectionTitle}>{labels.favorites}</span>
                  <ChevronRight className={styles.sectionChevron} size={12} aria-hidden="true" />
                </button>
              </div>
              {!favoritesCollapsed && (
                <div
                  id="sidebar-favorites-section"
                  className={styles.tree}
                  role="tree"
                  aria-label={labels.favoritePages}
                >
                  {favorites.map((p, index) => (
                    <PageTreeItem
                      key={p.id}
                      pageId={p.id}
                      depth={0}
                      index={index}
                      setSize={favorites.length}
                      expandableShortcut
                      flat
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          <section className={styles.section}>
            <div className={styles.sectionLabel}>
              <button
                type="button"
                className={`${styles.sectionToggle} ${styles.privateSectionToggle}`}
                aria-expanded={!privateCollapsed}
                aria-controls="sidebar-private-section"
                onClick={() => toggleSection("private")}
              >
                <span className={styles.sectionTitle}>{labels.private}</span>
                <ChevronDown className={styles.sectionChevron} size={12} aria-hidden="true" />
              </button>
              <div
                className={styles.sectionActions}
                data-section-actions="private"
                data-open={privateSectionMenuOpen ? "true" : undefined}
              >
                <button
                  type="button"
                  className={styles.sectionAction}
                  aria-label={labels.openPrivateLibrary}
                  onClick={openWorkspaceHome}
                >
                  <LibraryIcon size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.sectionAction}
                  aria-label={labels.openPrivateOptions}
                  aria-haspopup="menu"
                  aria-expanded={privateSectionMenuOpen}
                  onClick={() => setPrivateSectionMenuOpen((current) => !current)}
                >
                  <DotsHorizontal size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`${styles.sectionAction} ${styles.sectionAdd}`}
                  aria-label={labels.addPrivatePage}
                  disabled={creatingPage || !canCreateRootPage}
                  onClick={newRootPage}
                >
                  <Plus size={16} aria-hidden="true" />
                </button>
              </div>
              {privateSectionMenuOpen && (
                <div
                  className={styles.sectionMenu}
                  role="menu"
                  aria-label={labels.privateOptions}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.sectionMenuItem}
                    onClick={() => {
                      toggleSection("private");
                      closePrivateSectionMenu();
                    }}
                  >
                    <ChevronRight size={15} aria-hidden="true" />
                    <span>{privateCollapsed ? "Expand section" : "Collapse section"}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.sectionMenuItem}
                    disabled={creatingPage || !canCreateRootPage}
                    onClick={() => {
                      closePrivateSectionMenu();
                      void newRootPage();
                    }}
                  >
                    <Plus size={15} aria-hidden="true" />
                    <span>{labels.newPage}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.sectionMenuItem}
                    onClick={() => {
                      closePrivateSectionMenu();
                      setImportOpen(true);
                    }}
                  >
                    <Upload size={15} aria-hidden="true" />
                    <span>{labels.import}</span>
                  </button>
                </div>
              )}
            </div>
            {!privateCollapsed && (
              <div
                className={styles.rootDropArea}
                data-drop-active={rootDropActive ? "true" : undefined}
                data-drop-copy={rootDropCopy ? "true" : undefined}
                onDragOver={onPrivateRootDragOver}
                onDragLeave={onPrivateRootDragLeave}
                onDrop={onPrivateRootDrop}
              >
                <div
                  id="sidebar-private-section"
                  className={styles.tree}
                  role="tree"
                  aria-label={labels.privatePages}
                >
                  {visiblePrivateRootPages.map((p, index) => (
                    <PageTreeItem
                      key={p.id}
                      pageId={p.id}
                      depth={0}
                      excludePageIds={privateTreeHiddenPageIds}
                      index={index}
                      setSize={visiblePrivateRootPages.length}
                    />
                  ))}
                </div>
                {privateNeedsShowMore && (
                  <button
                    type="button"
                    className={styles.emptyTreeAction}
                    data-sidebar-private-more
                    aria-expanded={privateShowAll}
                    onClick={() => setPrivateShowAll((current) => !current)}
                  >
                    <DotsHorizontal size={15} aria-hidden="true" />
                    <span>
                      {privateShowAll
                        ? labels.showFewerPrivatePages
                        : labels.showMorePrivatePages}
                    </span>
                  </button>
                )}
                {privateRootPages.length === 0 && (
                  <button
                    type="button"
                    className={styles.emptyTreeAction}
                    aria-label={labels.createFirstPrivatePage}
                    disabled={creatingPage || !canCreateRootPage}
                    onClick={newRootPage}
                  >
                    <Plus size={15} aria-hidden="true" />
                    <span>{creatingPage ? labels.creating : labels.newPage}</span>
                  </button>
                )}
                <div className={styles.rootDropIndicator} aria-hidden="true" />
              </div>
            )}
          </section>

          {sharedPages.length > 0 && (
            <section className={styles.section}>
              <div className={styles.sectionLabel}>
                <button
                  type="button"
                  className={styles.sectionToggle}
                  aria-expanded={!sharedCollapsed}
                  aria-controls="sidebar-shared-section"
                  onClick={() => toggleSection("shared")}
                >
                  <span className={styles.sectionTitle}>{labels.shared}</span>
                  <ChevronRight className={styles.sectionChevron} size={12} aria-hidden="true" />
                </button>
              </div>
              {!sharedCollapsed && (
                <div
                  id="sidebar-shared-section"
                  className={styles.tree}
                  role="tree"
                  aria-label={labels.sharedPages}
                >
                  {sharedPages.map((p, index) => (
                    <PageTreeItem
                      key={p.id}
                      pageId={p.id}
                      depth={0}
                      index={index}
                      setSize={sharedPages.length}
                      expandableShortcut
                      flat
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        <div className={styles.footer} data-sidebar-footer>
          <button
            type="button"
            className={styles.actionRow}
            onClick={openTemplates}
            data-sidebar-footer-action
          >
            <FileText size={17} />
            <span className={styles.actionLabel}>{labels.templates}</span>
          </button>
          <button
            type="button"
            className={styles.actionRow}
            onClick={() => setImportOpen(true)}
            data-sidebar-footer-action
            data-import-running={notionImportActivity ? "true" : undefined}
            aria-label={
              notionImportActivity
                ? labels.importProgress(notionImportActivity.percent)
                : undefined
            }
          >
            <Upload size={17} />
            <span className={styles.actionLabel}>
              {notionImportActivity ? labels.importInProgress : labels.import}
            </span>
            {notionImportActivity ? (
              <span className={styles.importProgress} data-import-progress aria-hidden="true">
                <span className={styles.importProgressDot} />
                {notionImportActivity.percent}%
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className={styles.actionRow}
            onClick={() => router.push("/trash")}
            data-sidebar-footer-action
          >
            <Trash size={17} />
            <span className={styles.actionLabel}>{labels.trash}</span>
          </button>
          <button
            type="button"
            className={styles.newBtn}
            disabled={creatingPage || !canUseFooterNewPage}
            onClick={newRootPage}
            data-sidebar-footer-new-page
          >
            <Plus size={16} />
            <span className={styles.actionLabel}>{creatingPage ? labels.creating : labels.newPage}</span>
            <kbd className={styles.shortcutHint} aria-hidden="true">⌘N</kbd>
          </button>
          <SidebarSponsorRoll />
          <LegalNotice inline alignStart />
        </div>
        </>
        )}
        {!mobile && onResizeStart && (
          <div
            className={styles.resizeHandle}
            role="separator"
            aria-orientation="vertical"
            aria-label={labels.resizeSidebar}
            tabIndex={0}
            aria-valuemin={minWidth}
            aria-valuemax={maxWidth}
            aria-valuenow={width}
            onPointerDown={onResizeStart}
            onDoubleClick={onResizeReset}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                onResizeNudge?.(e.shiftKey ? -24 : -8);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                onResizeNudge?.(e.shiftKey ? 24 : 8);
              } else if (e.key === "Home") {
                e.preventDefault();
                onResizeReset?.();
              }
            }}
          />
        )}
      </aside>
      <Suspense fallback={null}>
        {/* Each dialog gets its own ErrorBoundary INSIDE the open-conditional so a
            render crash degrades to the boundary's visible fallback instead of
            unmounting the whole app (these sit outside the route ErrorBoundary),
            and closing + reopening mounts a fresh boundary with clean state. */}
        {templatesOpen && (
          <ErrorBoundary scope="templates-dialog">
            <TemplatesDialog onClose={() => setTemplatesOpen(false)} />
          </ErrorBoundary>
        )}
        {notionOnboardingOpen && (
          <ErrorBoundary scope="notion-import-onboarding-dialog">
            <NotionImportOnboardingDialog
              onImport={openNotionImportFromOnboarding}
              onLater={() => setNotionOnboardingOpen(false)}
            />
          </ErrorBoundary>
        )}
        <ErrorBoundary scope="import-dialog">
          <ImportDialog
            open={importOpen}
            initialTab={importInitialTab}
            onActivityChange={setNotionImportActivity}
            onClose={() => {
              setImportOpen(false);
              setImportInitialTab(undefined);
            }}
          />
        </ErrorBoundary>
        {workspaceCreateOpen && (
          <ErrorBoundary scope="workspace-create-dialog">
            <WorkspaceCreateDialog
              onClose={() => setWorkspaceCreateOpen(false)}
              onCreate={createWorkspaceFromDialog}
            />
          </ErrorBoundary>
        )}
      </Suspense>
    </>
  );
}
