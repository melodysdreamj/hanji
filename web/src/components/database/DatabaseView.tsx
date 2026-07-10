"use client";

import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { pickLabels } from "@/lib/i18n";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { pageFaviconHref, setDocumentChrome } from "@/lib/documentChrome";
import { motionSafeScrollBehavior } from "@/lib/motion";
import { databaseDisplayTitle, pageDisplayTitle } from "@/lib/pageTitle";
import type {
  PageAwarenessMode,
  PageAwarenessTextRange,
  PagePresenceAwareness,
} from "@/lib/pagePresence";
import {
  spansToPlainText,
  type Block,
  type BlockType,
  type ButtonTemplateBlock,
  type DbProperty,
  type DbTemplate,
  type DbView,
  type FilterGroup,
  type FilterOperator,
  type OrganizationProfile,
  type Page,
  type PropertyType,
  type TextSpan,
  type ViewFilter,
  type ViewSort,
  type ViewType,
  type WorkspaceMember,
} from "@/lib/types";
import { databaseRowsQueryKey, useStore, type DatabaseRowsQuery } from "@/lib/store";
import {
  LOCAL_DATABASE_MUTATION_EVENT,
  PAGE_ROOM_MUTATION_RECEIVED_EVENT,
  publishPageRoomMutation,
  type LocalDatabaseMutationChange,
  type PageRoomMutationReceived,
} from "@/lib/pageRoomEvents";
import { positionBetween } from "@/lib/ids";
import { copyText } from "@/lib/clipboard";
import {
  absolutePageUrl,
  absoluteSharedPageUrl,
  openPageInNewTab,
  openSharedPageInNewTab,
  pageHref,
  sharedPageHref,
} from "@/lib/navigation";
import { parseInlineMarkdown } from "../editor/markdownPaste";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BoardIcon,
  CalendarIcon,
  ChartIcon,
  CheckIcon,
  ChevronDown,
  ChevronRight,
  ClockIcon,
  CommentIcon,
  Copy,
  DotsHorizontal,
  DoubleChevronRight,
  DragHandleIcon,
  EyeIcon,
  EyeSlashIcon,
  FileText,
  FilterIcon,
  GalleryIcon,
  LayoutIcon,
  LinkIcon,
  ListIcon,
  LockIcon,
  OpenAsPage,
  OpenInNew,
  Plus,
  PropertiesIcon,
  Search,
  SelectIcon,
  SharePeopleIcon,
  SortIcon,
  Star,
  StarFilled,
  StatusIcon,
  TableIcon,
  TimelineIcon,
  Trash,
  X,
} from "@/icons/hanji";
import { PageCover } from "../PageCover";
import { PageIconGlyph } from "../PageIcon";
import { PageFindBar, selectedTextForPageFind } from "../PageFindBar";
import { PageHeader } from "../PageHeader";
import { RowMenu } from "../RowMenu";
import { EmojiPicker } from "../EmojiPicker";
import { Editor } from "../editor/Editor";
import { RowProperties } from "./RowProperties";
import { TableView } from "./TableView";
import { DateTextInput } from "./DateTextInput";
import { NumberTextInput } from "./NumberTextInput";
import { NotionSelect } from "./NotionSelect";
import { PropertyTypeConfig } from "./PropertyTypeConfig";
import { PropertyTypeIcon } from "./PropertyTypeIcon";
import { BoardView } from "./BoardView";
import { ChartView } from "./ChartView";
import { ListView } from "./ListView";
import { GalleryView } from "./GalleryView";
import { CalendarView } from "./CalendarView";
import { TimelineView } from "./TimelineView";
import {
  CARD_PREVIEW_NONE,
  CARD_PREVIEW_PAGE,
  cardPreviewMode,
  isCoverProperty,
} from "./cardPreview";
import { personLabel } from "./people";
import {
  configForType,
  CREATABLE_PROPERTY_TYPES,
  localizedPropertyTypeLabel,
  PROPERTY_TYPES,
  propertyTypeLabel as typeLabel,
} from "./propertyTypes";
import { usePropertyTypeChangeConfirm } from "./PropertyTypeChangeConfirm";
import {
  applyView,
  applyViewFilterSeeds,
  currentPageFilterValue,
  effectiveFilterGroup,
  isCurrentPageFilterValue,
  isQueryableProperty,
  orderViewProperties,
  TABLE_INITIAL_LOAD_OPTIONS,
  tableInitialLoadLimit,
  TIMELINE_LOAD_LIMIT_OPTIONS,
  timelineLoadLimit,
  viewFilterSeedValues,
} from "./query";
import styles from "./database.module.css";
import filterStyles from "./filterGroups.module.css";

const NOTION_2023_VIEW_TYPES: { type: ViewType; label: string; description: string }[] = [
  { type: "table", label: "Table", description: "Rows and columns for structured data." },
  { type: "board", label: "Board", description: "Kanban cards grouped by status or select." },
  { type: "list", label: "List", description: "A compact page list for quick browsing." },
  { type: "gallery", label: "Gallery", description: "Cards with page covers or file previews." },
  { type: "calendar", label: "Calendar", description: "Pages arranged by a date property." },
  { type: "timeline", label: "Timeline", description: "A horizontal schedule from date properties." },
  { type: "chart", label: "Chart", description: "Bars, lines, or donuts aggregated from rows." },
];
const RENDERABLE_IMPORTED_VIEW_TYPE_SET = new Set<ViewType>(
  NOTION_2023_VIEW_TYPES.map((item) => item.type)
);
const INLINE_SCOPED_VIEW_TYPES: ViewType[] = [
  "table",
  "board",
  "gallery",
  "list",
  "timeline",
  "calendar",
  "chart",
];

const DATABASE_VIEW_LABELS = {
  en: {
    addComment: "Add a comment",
    addCommentTo: (title: string) => `Add a comment to ${title}`,
    addDateProperty: "Add date property",
    addEndDateProperty: "Add end date property",
    addNewView: "New view",
    addToFavorites: (title: string) => `Add ${title} to favorites`,
    addedToFavorites: "Added to favorites",
    aiAutofill: "AI autofill",
    automations: "Automations",
    backToProperties: "Back to properties",
    backToPropertyList: "Back to property list",
    backToViewSettings: "Back to view settings",
    calendarBy: "Show calendar by",
    calendarView: "Calendar view",
    cannotAddCalendarView: "Can't add a new calendar view to this database",
    cardPreview: "Card preview",
    cardSize: "Card size",
    center: "Center peek",
    changeIcon: "Change icon",
    changeTemplateIcon: "Change template icon",
    close: "Close",
    closeProperties: "Close properties",
    closePropertyVisibility: "Close property visibility",
    closeTemplateEditor: (title: string) => `Close ${title} template editor`,
    closeViewSettings: "Close view settings",
    collapseTemplateEditor: "Return template editor to center view",
    comments: "Comments",
    conditionalColor: "Conditional color",
    copiedViewLink: "Copied view link",
    copyLink: (title: string) => `Copy link to ${title}`,
    copyLinkFailed: "Couldn't copy link",
    copyShareLink: (title: string) => `Copy share link for ${title}`,
    copyViewLink: "Copy view link",
    copyViewLinkFailed: "Couldn't copy view link",
    countSuffix: (count: number) => `${count}`,
    createEmptyPage: "Create an empty page",
    choosePage: "Choose page",
    createPropertyFailed: "Couldn't create property",
    createTemplate: "New template",
    createTemplateAria: "Create new database template",
    createWithoutTemplate: "Create without template",
    createdProperty: (name: string) => `Created ${name} property`,
    currentPage: "Current page",
    dataSourceSettings: "Data source settings",
    database: "Database",
    databaseFallbackTitle: "Database",
    day: "Day",
    defaultLabel: "Default",
    defaultSuffix: " · Default",
    defaultTemplateForNewPages: "Default template for new pages",
    deleteProperty: "Delete property",
    deletePropertyFailed: "Couldn't delete property",
    deleteTemplateAria: (name: string) => `Delete ${name}`,
    deleteView: "Delete view",
    deletedProperties: "Deleted properties",
    deletedPropertiesNotLinked: "Deleted properties aren't connected yet",
    deletedProperty: "Deleted property",
    duplicate: "Duplicate",
    duplicateGive: "Duplicate",
    duplicateTemplateAria: (name: string) => `Duplicate ${name}`,
    duplicateView: "Duplicate view",
    edit: "Edit",
    editProperties: "Edit properties",
    editingTemplateIn: "You're editing a template in",
    expandTemplateEditor: "Expand template editor",
    filter: "Filter",
    fitImage: "Fit image",
    full: "Full page",
    group: "Group",
    hiddenCountSuffix: (count: number) => `${count} hidden`,
    hideAll: "Hide all",
    hiddenInTable: "Hidden in table",
    initialLoad: "Initial load",
    large: "Large",
    layout: "Layout",
    linkCopied: (title: string) => `${title} link copied`,
    linkCopiedToast: "Copied link",
    loadLimit: "Load limit",
    loadMore: "Load more",
    loadingDatabase: "Loading database",
    loadingMore: "Loading ...",
    locked: "Locked",
    me: "Me",
    medium: "Medium",
    month: "Month",
    moreSettings: "More settings",
    moreViews: (count: number) => `${count} more`,
    newDatabasePage: "New database page",
    newFromTemplate: (name: string) => `New from ${name}`,
    newPage: "New page",
    newPageFromTemplate: (name: string) => `New page from ${name}`,
    newPageMenuItem: "Create new page",
    newProperty: "New property",
    newPropertyIn: (title: string) => `New property in ${title}`,
    newTemplate: "New template",
    noDateProperties: "No date properties",
    noSearchResults: "No results",
    noTemplates: "No templates yet",
    noTemplatesFound: "No templates found",
    noViewToCopy: "No view to copy",
    noViewToDuplicate: "No view to duplicate",
    none: "None",
    openActions: (title: string) => `Open ${title} actions`,
    openAsFullPage: "Open as full page",
    openAsPage: (title: string) => `Open ${title} as page`,
    openComments: (title: string, count: number) =>
      `Open ${count} comment${count === 1 ? "" : "s"} on ${title}`,
    openPagesIn: "Open pages in",
    openTemplateActions: "Open template actions",
    pageCover: "Page cover",
    peekOptions: (title: string) => `${title} preview options`,
    closePeek: (title: string) => `Close ${title} preview`,
    properties: "Properties",
    propertyHelp: "Learn about properties",
    propertyHelpNotLinked: "Property help isn't connected yet",
    propertyVisibility: "Property visibility",
    removeFromFavorites: (title: string) => `Remove ${title} from favorites`,
    removedFromFavorites: "Removed from favorites",
    renamedView: "Renamed view",
    restorePropertyFailed: "Couldn't restore property",
    restoredProperty: "Restored property",
    rowHeight: "Row height",
    searchProperties: "Search for a property",
    searchTemplates: "Search templates",
    setDefault: "Set",
    share: "Share",
    short: "Short",
    shownInTable: "Shown in table",
    showAll: "Show all",
    showTable: "Show table",
    side: "Side peek",
    small: "Small",
    sort: "Sort",
    tall: "Tall",
    templateBodyPlaceholder: "Press Enter to continue with an empty page.",
    templatePageTitlePlaceholder: "New page",
    templateSearchLabel: "Search templates",
    templateViewOptions: (title: string) => `${title} template view options`,
    timeUnit: "Time scale",
    timelineBy: "Show timeline by",
    timelineEndDate: "End date",
    timelineZoomAria: "Timeline time scale",
    toolbarNew: "New",
    type: "Type",
    unlock: (title: string) => `Unlock ${title}`,
    updateFavoritesFailed: "Couldn't update favorites",
    viewName: "View name",
    viewSettings: "View settings",
    viewSettingsLabel: "View settings",
    viewTypes: {
      table: "Table",
      board: "Board",
      gallery: "Gallery",
      list: "List",
      timeline: "Timeline",
      calendar: "Calendar",
      chart: "Chart",
    } as Record<ViewType, string>,
    week: "Week",
    wrapProperties: "Wrap properties",
    addIcon: "Add icon",
    addTemplateIcon: "Add template icon",
    newFromTemplatesLabel: "New from template",
    toast: {
      couldntCreateDefaultTableView: "Couldn't create default table view",
      duplicatedView: "Duplicated view",
      createdView: "Created view",
      removedViewFromInline: "Removed view from this inline database",
      couldntDeleteView: "Couldn't delete view",
      deletedView: "Deleted view",
      couldntRestoreView: "Couldn't restore view",
      restoredView: "Restored view",
      pageUnlocked: "Page unlocked",
      clearedFilters: "Cleared filters",
      restoredFilters: "Restored filters",
      clearedSort: "Cleared sort",
      clearedSorts: "Cleared sorts",
      restoredSort: "Restored sort",
      restoredSorts: "Restored sorts",
      createdTemplate: "Created template",
      couldntCreateTemplate: "Couldn't create template",
      couldntDuplicateTemplate: "Couldn't duplicate template",
      duplicatedTemplate: "Duplicated template",
      setDefaultTemplate: "Set default template",
      defaultTemplateRemoved: "Default template removed",
      couldntDeleteTemplate: "Couldn't delete template",
      deletedTemplate: "Deleted template",
      restoredTemplate: "Restored template",
      couldntRestoreTemplate: "Couldn't restore template",
    },
  },
  ko: {
    addComment: "댓글 추가",
    addCommentTo: (title: string) => `${title}에 댓글 추가`,
    addDateProperty: "날짜 속성 추가",
    addEndDateProperty: "종료일 속성 추가",
    addNewView: "새 보기 추가",
    addToFavorites: (title: string) => `${title} 즐겨찾기에 추가`,
    addedToFavorites: "즐겨찾기에 추가했어요",
    aiAutofill: "AI 자동 채우기",
    automations: "자동화",
    backToProperties: "속성으로 돌아가기",
    backToPropertyList: "속성 목록으로 돌아가기",
    backToViewSettings: "보기 설정으로 돌아가기",
    calendarBy: "캘린더 기준",
    calendarView: "캘린더 보기",
    cannotAddCalendarView: "이 데이터베이스에는 새 캘린더 보기를 추가할 수 없어요",
    cardPreview: "카드 미리보기",
    cardSize: "카드 크기",
    center: "중앙",
    changeIcon: "아이콘 변경",
    changeTemplateIcon: "템플릿 아이콘 변경",
    close: "닫기",
    closeProperties: "속성 닫기",
    closePropertyVisibility: "속성 표시 여부 닫기",
    closeTemplateEditor: (title: string) => `${title} 템플릿 편집 닫기`,
    closeViewSettings: "보기 설정 닫기",
    collapseTemplateEditor: "템플릿 편집 가운데 보기로 돌아가기",
    comments: "댓글",
    conditionalColor: "조건부 색상",
    copiedViewLink: "보기 링크를 복사했어요",
    copyLink: (title: string) => `${title} 링크 복사`,
    copyLinkFailed: "링크를 복사하지 못했어요",
    copyShareLink: (title: string) => `${title} 공유 링크 복사`,
    copyViewLink: "보기 링크 복사",
    copyViewLinkFailed: "보기 링크를 복사하지 못했어요",
    countSuffix: (count: number) => `${count}개`,
    createEmptyPage: "빈 페이지 만들기",
    choosePage: "페이지 선택",
    createPropertyFailed: "속성을 만들지 못했어요",
    createTemplate: "새 템플릿 만들기",
    createTemplateAria: "새 데이터베이스 템플릿 만들기",
    createWithoutTemplate: "템플릿 없이 만들기",
    createdProperty: (name: string) => `${name} 속성을 만들었어요`,
    currentPage: "현재 페이지",
    dataSourceSettings: "데이터 소스 설정",
    database: "데이터베이스",
    databaseFallbackTitle: "데이터베이스",
    day: "일",
    defaultLabel: "기본",
    defaultSuffix: " · 기본",
    defaultTemplateForNewPages: "새 페이지 기본 템플릿",
    deleteProperty: "속성 삭제",
    deletePropertyFailed: "속성을 삭제하지 못했어요",
    deleteTemplateAria: (name: string) => `${name} 삭제`,
    deleteView: "보기 삭제",
    deletedProperties: "삭제한 속성",
    deletedPropertiesNotLinked: "삭제한 속성 목록은 아직 연결되지 않았어요",
    deletedProperty: "속성을 삭제했어요",
    duplicate: "복제",
    duplicateGive: "복제 주기",
    duplicateTemplateAria: (name: string) => `${name} 복제`,
    duplicateView: "보기 복제",
    edit: "편집",
    editProperties: "속성 편집",
    editingTemplateIn: "다음에서 템플릿을 편집 중입니다.",
    expandTemplateEditor: "템플릿 편집 크게 열기",
    filter: "필터",
    fitImage: "이미지 맞춤",
    full: "전체",
    group: "그룹화",
    hiddenCountSuffix: (count: number) => `${count}개 숨김`,
    hideAll: "모두 숨기기",
    hiddenInTable: "표에서 숨기기",
    initialLoad: "처음 불러오기",
    large: "크게",
    layout: "레이아웃",
    linkCopied: (title: string) => `${title} 링크 복사됨`,
    linkCopiedToast: "링크를 복사했어요",
    loadLimit: "로드 제한",
    loadMore: "더 불러오기 ...",
    loadingDatabase: "데이터베이스 불러오는 중",
    loadingMore: "불러오는 중 ...",
    locked: "잠김",
    me: "나",
    medium: "보통",
    month: "월",
    moreSettings: "추가 설정",
    moreViews: (count: number) => `${count}개 더 보기`,
    newDatabasePage: "새 데이터베이스 페이지",
    newFromTemplate: (name: string) => `${name}에서 새로 만들기`,
    newPage: "새 페이지",
    newPageFromTemplate: (name: string) => `${name}에서 새 페이지 만들기`,
    newPageMenuItem: "새 페이지 만들기",
    newProperty: "새 속성",
    newPropertyIn: (title: string) => `${title}의 새 속성`,
    newTemplate: "새 템플릿",
    noDateProperties: "날짜 속성 없음",
    noSearchResults: "검색 결과가 없습니다",
    noTemplates: "템플릿이 없습니다",
    noTemplatesFound: "템플릿을 찾을 수 없습니다",
    noViewToCopy: "복사할 보기가 없어요",
    noViewToDuplicate: "복제할 보기가 없어요",
    none: "없음",
    openActions: (title: string) => `${title} 작업 열기`,
    openAsFullPage: "전체 페이지로 열기",
    openAsPage: (title: string) => `${title} 페이지로 열기`,
    openComments: (title: string, count: number) => `${title} 댓글 ${count}개 열기`,
    openPagesIn: "페이지 보기 선택",
    openTemplateActions: "템플릿 작업 열기",
    pageCover: "페이지 커버",
    peekOptions: (title: string) => `${title} 미리보기 옵션`,
    closePeek: (title: string) => `${title} 미리보기 닫기`,
    properties: "속성",
    propertyHelp: "속성 사용법",
    propertyHelpNotLinked: "속성 사용법 도움말은 아직 연결되지 않았어요",
    propertyVisibility: "속성 표시 여부",
    removeFromFavorites: (title: string) => `${title} 즐겨찾기에서 제거`,
    removedFromFavorites: "즐겨찾기에서 제거했어요",
    renamedView: "보기 이름을 바꿨어요",
    restorePropertyFailed: "속성을 복원하지 못했어요",
    restoredProperty: "속성을 복원했어요",
    rowHeight: "행 높이",
    searchProperties: "속성을 검색하세요",
    searchTemplates: "템플릿 검색",
    setDefault: "설정",
    share: "공유",
    short: "낮게",
    shownInTable: "표에 표시하기",
    showAll: "모두 표시하기",
    showTable: "표 표시",
    side: "사이드",
    small: "작게",
    sort: "정렬",
    tall: "높게",
    templateBodyPlaceholder: "Enter 키를 눌러 빈 페이지에 입력을 시작하세요.",
    templatePageTitlePlaceholder: "새 페이지",
    templateSearchLabel: "템플릿 검색",
    templateViewOptions: (title: string) => `${title} 템플릿 보기 옵션`,
    timeUnit: "시간 단위",
    timelineBy: "타임라인 기준",
    timelineEndDate: "종료일",
    timelineZoomAria: "타임라인 시간 단위",
    toolbarNew: "새로 만들기",
    type: "유형",
    unlock: (title: string) => `${title} 잠금 해제`,
    updateFavoritesFailed: "즐겨찾기를 업데이트하지 못했어요",
    viewName: "보기 이름",
    viewSettings: "보기 설정",
    viewSettingsLabel: "설정 보기",
    viewTypes: {
      table: "표",
      board: "보드",
      gallery: "갤러리",
      list: "리스트",
      timeline: "타임라인",
      calendar: "캘린더",
      chart: "차트",
    } as Record<ViewType, string>,
    week: "주",
    wrapProperties: "속성 줄바꿈",
    addIcon: "아이콘 추가",
    addTemplateIcon: "템플릿 아이콘 추가",
    newFromTemplatesLabel: "템플릿에서 새로 만들기",
    toast: {
      couldntCreateDefaultTableView: "기본 표 보기를 만들지 못했어요",
      duplicatedView: "보기를 복제했어요",
      createdView: "보기를 만들었어요",
      removedViewFromInline: "이 인라인 데이터베이스에서 보기를 제거했어요",
      couldntDeleteView: "보기를 삭제하지 못했어요",
      deletedView: "보기를 삭제했어요",
      couldntRestoreView: "보기를 복원하지 못했어요",
      restoredView: "보기를 복원했어요",
      pageUnlocked: "페이지 잠금이 해제되었어요",
      clearedFilters: "필터를 지웠어요",
      restoredFilters: "필터를 복원했어요",
      clearedSort: "정렬을 지웠어요",
      clearedSorts: "정렬을 지웠어요",
      restoredSort: "정렬을 복원했어요",
      restoredSorts: "정렬을 복원했어요",
      createdTemplate: "템플릿을 만들었어요",
      couldntCreateTemplate: "템플릿을 만들지 못했어요",
      couldntDuplicateTemplate: "템플릿을 복제하지 못했어요",
      duplicatedTemplate: "템플릿을 복제했어요",
      setDefaultTemplate: "기본 템플릿으로 설정했어요",
      defaultTemplateRemoved: "기본 템플릿이 해제되었어요",
      couldntDeleteTemplate: "템플릿을 삭제하지 못했어요",
      deletedTemplate: "템플릿을 삭제했어요",
      restoredTemplate: "템플릿을 복원했어요",
      couldntRestoreTemplate: "템플릿을 복원하지 못했어요",
    },
  },
} as const;

function databaseViewLabels() {
  return pickLabels(DATABASE_VIEW_LABELS);
}
const INLINE_DATABASE_COMMAND_EVENT = "notionlike:inline-database-command";
const INLINE_DATABASE_TOOLBAR_MENU_EVENT = "notionlike:open-inline-database-toolbar-menu";
const IMPORTED_VIEW_CONFIG_KEYS = [
  "notionViewId",
  "notionType",
  "notionChromeCreatedTime",
  "unsupportedNotionViewType",
  "notion",
  "notionFilter",
  "notionSorts",
  "notionVisibleProperties",
  "notionHiddenProperties",
  "notionPropertyOrder",
  "notionPropertySettings",
  "notionQuickFilters",
  "unresolvedPropertyReferences",
  "viewTabOrderEditedAt",
];

function viewTypeSettingsLabel(type: ViewType) {
  return (
    databaseViewLabels().viewTypes[type] ??
    NOTION_2023_VIEW_TYPES.find((item) => item.type === type)?.label ??
    type
  );
}

function isRenderableDatabaseView(view: DbView) {
  return RENDERABLE_IMPORTED_VIEW_TYPE_SET.has(view.type);
}

function isImportedUntitledView(view: DbView) {
  const name = (view.name || "").trim().toLowerCase();
  return (name === "" || name === "untitled") && typeof view.config?.notionViewId === "string";
}

function isImportedNotionView(view: DbView) {
  return typeof view.config?.notionViewId === "string" && !!view.config?.notion;
}

function isTemplateLinkedView(view: DbView) {
  return view.config?.templateLinkedView === true;
}

function inlineDatabaseScopedViewOwner(view: DbView) {
  const owner = view.config?.inlineDatabaseBlockId;
  return typeof owner === "string" && owner.trim().length > 0 ? owner : undefined;
}

function isInlineDatabaseScopedView(view: DbView) {
  return !!inlineDatabaseScopedViewOwner(view);
}

function cloneInlineScopedViewConfig(
  config: DbView["config"],
  ownerId: string,
  sourceViewId?: string
) {
  const next = (config ? JSON.parse(JSON.stringify(config)) : {}) as Record<string, unknown>;
  for (const key of IMPORTED_VIEW_CONFIG_KEYS) delete next[key];
  next.inlineDatabaseBlockId = ownerId;
  if (sourceViewId) next.inlineDatabaseSourceViewId = sourceViewId;
  else delete next.inlineDatabaseSourceViewId;
  return next as DbView["config"];
}

function appendScopedViewId(ids: string[], viewId: string, afterId?: string) {
  const next = ids.filter((id) => id !== viewId);
  const index = afterId ? next.indexOf(afterId) : -1;
  next.splice(index >= 0 ? index + 1 : next.length, 0, viewId);
  return next;
}

function normalizedNotionScopeId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/^collection:\/\//i, "")
    .replace(/^data_source:\/\//i, "")
    .replace(/-/g, "")
    .trim()
    .toLowerCase();
  return clean || undefined;
}

function notionParentDatabaseId(view: DbView) {
  const notion = view.config?.notion;
  if (!notion || typeof notion !== "object") return undefined;
  const record = notion as Record<string, unknown>;
  const parent = record.parent;
  if (parent && typeof parent === "object") {
    const parentRecord = parent as Record<string, unknown>;
    const id =
      parentRecord.database_id ??
      parentRecord.databaseId ??
      parentRecord.id;
    if (typeof id === "string") return id;
  }
  const fallback =
    record.parent_database_id ??
    record.parentDatabaseId ??
    record.database_id ??
    record.databaseId;
  return typeof fallback === "string" ? fallback : undefined;
}

function notionViewCreatedAtMs(view: DbView) {
  const notion = view.config?.notion;
  if (!notion || typeof notion !== "object") return undefined;
  const createdTime = (notion as Record<string, unknown>).created_time;
  if (typeof createdTime !== "string") return undefined;
  const ms = Date.parse(createdTime);
  return Number.isFinite(ms) ? ms : undefined;
}

function notionViewChromeCreatedAtMs(view: DbView) {
  const createdTime = view.config?.notionChromeCreatedTime;
  if (typeof createdTime === "string") {
    const ms = Date.parse(createdTime);
    if (Number.isFinite(ms)) return ms;
  }
  return notionViewCreatedAtMs(view);
}

function notionViewCreatedTime(view: DbView) {
  const notion = view.config?.notion;
  if (!notion || typeof notion !== "object") return undefined;
  const createdTime = (notion as Record<string, unknown>).created_time;
  return typeof createdTime === "string" ? createdTime : undefined;
}

function notionViewDataSourceId(view: DbView) {
  const notion = view.config?.notion;
  if (!notion || typeof notion !== "object") return undefined;
  const dataSourceId = (notion as Record<string, unknown>).data_source_id;
  return typeof dataSourceId === "string" ? normalizedNotionScopeId(dataSourceId) : undefined;
}

function importedVisiblePropertySignature(view: DbView) {
  const visibleProperties = view.config?.visibleProperties;
  if (!Array.isArray(visibleProperties)) return "";
  return visibleProperties.map(String).join("|");
}

function hasUserEditedViewTabOrder(view: DbView) {
  return typeof view.config?.viewTabOrderEditedAt === "string";
}

function restoreImportedPeerViewsForLinkedTarget(allViews: DbView[], scopedViews: DbView[]) {
  if (scopedViews.length === 0) return scopedViews;
  const restored = scopedViews.map((view) => {
    if (!isImportedNotionView(view)) return view;
    if (view.name.trim().toLowerCase() !== "default view") return view;
    const dataSourceId = notionViewDataSourceId(view);
    const propertySignature = importedVisiblePropertySignature(view);
    if (!dataSourceId || !propertySignature) return view;

    const peers = allViews
      .filter((candidate) =>
        candidate.type === view.type &&
        isImportedNotionView(candidate) &&
        candidate.name.trim().toLowerCase() === view.name.trim().toLowerCase() &&
        notionViewDataSourceId(candidate) === dataSourceId &&
        importedVisiblePropertySignature(candidate) === propertySignature &&
        notionViewCreatedAtMs(candidate) != null
      )
      .sort((a, b) =>
        (notionViewCreatedAtMs(a) ?? 0) - (notionViewCreatedAtMs(b) ?? 0) ||
        a.position - b.position ||
        a.id.localeCompare(b.id)
      );
    const peer = peers[0];
    const peerCreatedTime = peer ? notionViewCreatedTime(peer) : undefined;
    const peerCreatedAt = peer ? notionViewCreatedAtMs(peer) : undefined;
    const viewCreatedAt = notionViewCreatedAtMs(view);
    if (!peerCreatedTime || peerCreatedAt == null || (viewCreatedAt != null && peerCreatedAt >= viewCreatedAt)) {
      return view;
    }

    return {
      ...view,
      config: {
        ...view.config,
        notionChromeCreatedTime: peerCreatedTime,
      },
    };
  });

  const seen = new Set<string>();
  return restored.filter((view) => {
    if (seen.has(view.id)) return false;
    seen.add(view.id);
    return true;
  });
}

function filterViewsByNotionLinkedDatabaseTargets(views: DbView[], targetIds?: string[]) {
  const allowed = new Set((targetIds ?? []).map(normalizedNotionScopeId).filter(Boolean));
  if (allowed.size === 0) return views;
  const scoped = views.filter((view) => {
    const parentId = normalizedNotionScopeId(notionParentDatabaseId(view));
    return !!parentId && allowed.has(parentId);
  });
  return scoped.length > 0 ? restoreImportedPeerViewsForLinkedTarget(views, scoped) : views;
}

function orderImportedInlineViewsForNotionChrome(views: DbView[]) {
  if (views.some(hasUserEditedViewTabOrder)) return views;
  const defaultTableView = views.find(
    (view) => view.name.trim().toLowerCase() === "default view" && view.type === "table"
  );
  const shouldOrderSmallTableBoardSet =
    views.length === 3 &&
    !!defaultTableView &&
    importedVisiblePropertySignature(defaultTableView) !== "" &&
    views.filter((view) => view.type === "table").length >= 2 &&
    views.some((view) => view.type === "board");
  if (views.length < 4 && !shouldOrderSmallTableBoardSet) return views;
  if (!views.every(isImportedNotionView)) return views;
  if (!views.some((view) => view.name.trim().toLowerCase() === "default view")) return views;
  const created = views.map((view) => ({ view, createdAt: notionViewChromeCreatedAtMs(view) }));
  if (created.some((item) => item.createdAt == null)) return views;

  const byCreatedAt = created
    .slice()
    .sort((a, b) =>
      (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
      a.view.position - b.view.position ||
      a.view.name.localeCompare(b.view.name)
    )
    .map((item) => item.view);

  return byCreatedAt[0]?.id === views[0]?.id ? views : byCreatedAt;
}

function effectiveOpenPageIn(view?: DbView): "side" | "center" | "full" {
  if (!view) return "side";
  if (view.config?.openPageIn) return view.config.openPageIn;
  return view.type === "gallery" || view.type === "calendar"
    ? "center"
    : "side";
}

function ViewTypeIcon({ type, size = 14 }: { type: ViewType; size?: number }) {
  if (type === "table") return <TableIcon size={size} aria-hidden="true" />;
  if (type === "board") return <BoardIcon size={size} aria-hidden="true" />;
  if (type === "list") return <ListIcon size={size} aria-hidden="true" />;
  if (type === "gallery") return <GalleryIcon size={size} aria-hidden="true" />;
  if (type === "calendar") return <CalendarIcon size={size} aria-hidden="true" />;
  if (type === "timeline") return <TimelineIcon size={size} aria-hidden="true" />;
  if (type === "chart") return <ChartIcon size={size} aria-hidden="true" />;
  return <TableIcon size={size} aria-hidden="true" />;
}

function ImportedUnsupportedView({ view }: { view: DbView }) {
  const notionType = view.config?.unsupportedNotionViewType ?? view.config?.notionType ?? view.type;
  const typeLabel = notionType === "chart" ? "Chart" : notionType || "Unsupported";
  return (
    <div className={styles.unsupportedImportedView} role="note">
      <span className={styles.unsupportedImportedViewIcon} aria-hidden="true">
        <ChartIcon size={18} />
      </span>
      <span className={styles.unsupportedImportedViewText}>
        <strong>{typeLabel} view</strong>
        <span>This Notion view was imported, but the matching renderer is still pending.</span>
      </span>
    </div>
  );
}

function DatabaseLoadingShell({ placement }: { placement: "page" | "inline" }) {
  const hideSingleInlineViewTab = placement === "inline";
  const hasRowGutter = false;
  const cells = placement === "inline" ? [0] : [0, 1, 2];
  const dataColumns = cells.map((_, index) => (index === 0 ? "260px" : "180px")).join(" ");
  const columns = hasRowGutter
    ? `112px ${dataColumns} 58px`
    : `${dataColumns} 58px`;
  const rowColumns = hasRowGutter ? `112px ${dataColumns}` : dataColumns;
  return (
    <div
      className={`${styles.db} ${styles.dbLoadingShell}`}
      data-placement={placement}
      data-imported-notion-inline={placement === "inline" ? "true" : undefined}
      aria-busy="true"
      aria-label={databaseViewLabels().loadingDatabase}
    >
      <div className={styles.dbChrome} data-database-chrome>
        <div
          className={`${styles.viewTabs} ${styles.loadingViewTabs}`}
          data-view-tabs-hidden={hideSingleInlineViewTab ? "true" : undefined}
          aria-hidden={hideSingleInlineViewTab ? "true" : undefined}
        >
          <div className={`${styles.viewTabWrap} ${styles.loadingViewTabWrap}`} data-active="true">
            <div className={`${styles.viewTab} ${styles.viewTabActive} ${styles.loadingViewTab}`}>
              <span className={styles.viewGlyph}>
                <TableIcon size={14} aria-hidden="true" />
              </span>
              <span>Default view</span>
            </div>
          </div>
        </div>
        <div className={`${styles.dbToolbar} ${styles.loadingToolbar}`} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className={styles.viewBody}>
        <div className={styles.tableScroll}>
          <div
            className={`${styles.table} ${styles.loadingTable}`}
            data-row-gutter={hasRowGutter ? "true" : undefined}
            data-row-height="medium"
          >
            <div className={styles.tableHead} style={{ gridTemplateColumns: columns }}>
              {hasRowGutter && <div className={styles.rowGutterHead} aria-hidden="true" />}
              {cells.map((cell, index) => (
                <div
                  key={`loading-head-${cell}`}
                  className={`${styles.headCell} ${styles.loadingHeadCell}`}
                  data-first={index === 0 ? "true" : undefined}
                >
                  <span />
                </div>
              ))}
              <div className={styles.addCol} aria-hidden="true">
                <span className={styles.loadingAddCol} />
              </div>
            </div>
            {Array.from({ length: 3 }).map((_, rowIndex) => (
              <div
                key={`loading-row-${rowIndex}`}
                className={styles.tableSkeletonRow}
                data-table-rows-loading
                style={{ gridTemplateColumns: rowColumns }}
              >
                {hasRowGutter && <div className={styles.rowGutterCell} aria-hidden="true" />}
                {cells.map((cell, index) => (
                  <div
                    key={`loading-cell-${rowIndex}-${cell}`}
                    className={styles.tableSkeletonCell}
                    data-first={index === 0 ? "true" : undefined}
                  >
                    <span />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function isImageIcon(icon: string) {
  return /^(https?:\/\/|data:image\/|blob:|\/)/i.test(icon);
}

function TemplateIconGlyph({ icon, size = 14 }: { icon?: string; size?: number }) {
  const cleanIcon = icon?.trim();
  if (!cleanIcon) return <FileText size={size} aria-hidden="true" />;
  if (isImageIcon(cleanIcon)) return <img src={cleanIcon} alt="" />;
  return cleanIcon;
}

const FILTER_OPERATOR_LABELS = {
  en: {
    equals: "Is",
    does_not_equal: "Is not",
    contains: "Contains",
    does_not_contain: "Does not contain",
    is_empty: "Is empty",
    is_not_empty: "Is not empty",
    greater_than: "Greater than",
    less_than: "Less than",
    on_or_before: "On or before",
    on_or_after: "On or after",
  } satisfies Record<FilterOperator, string>,
  ko: {
    equals: "값이 같음",
    does_not_equal: "값이 다름",
    contains: "포함",
    does_not_contain: "포함하지 않음",
    is_empty: "비어 있음",
    is_not_empty: "비어 있지 않음",
    greater_than: "초과",
    less_than: "미만",
    on_or_before: "이전 또는 당일",
    on_or_after: "이후 또는 당일",
  } satisfies Record<FilterOperator, string>,
} as const;

const NO_VALUE_FILTERS = new Set<FilterOperator>(["is_empty", "is_not_empty"]);
const NUMERIC_ROLLUP_FUNCTIONS = new Set([
  "count_all",
  "count_values",
  "count_unique",
  "count_empty",
  "percent_empty",
  "percent_not_empty",
  "checked",
  "unchecked",
  "percent_checked",
  "percent_unchecked",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
]);
const DATE_ROLLUP_FUNCTIONS = new Set(["earliest_date", "latest_date", "date_range"]);
const VIEW_TAB_DRAG = "application/x-notionlike-db-view";
const TOOLBAR_PROPERTY_DRAG = "application/x-notionlike-toolbar-property";
const VIEW_TAB_ADD_BUTTON_WIDTH = 34;
const VIEW_TAB_OVERFLOW_MIN_WIDTH = 92;
const VIEW_TAB_FIT_SAFETY = 10;
const VIEW_TAB_INLINE_TOOLBAR_RESERVE = 72;
const ROW_PEEK_PARAM = "p";
const ROW_PEEK_MODE_PARAM = "pm";
const ROW_PEEK_MODE_SIDE = "s";
const ROW_PEEK_MODE_CENTER = "c";
const HASH_BLOCK_PREFIX = "block-";

function viewTabId(viewId: string) {
  return `database-view-tab-${viewId}`;
}

function viewPanelId(viewId: string) {
  return `database-view-panel-${viewId}`;
}

function viewTabTextWidth(label: string) {
  return Array.from(label || "Untitled").reduce((width, char) => {
    if (/\p{Emoji_Presentation}/u.test(char)) return width + 16;
    if (/[가-힣ㄱ-ㅎㅏ-ㅣ一-龥ぁ-ゟ゠-ヿ]/u.test(char)) return width + 13.5;
    if (/[A-Z0-9]/.test(char)) return width + 8.2;
    if (char === " ") return width + 4;
    return width + 7.2;
  }, 0);
}

function estimateViewTabWidth(view: DbView) {
  const textWidth = Math.min(160, Math.max(22, viewTabTextWidth(view.name)));
  return Math.ceil(8 + 16 + 6 + textWidth + 22 + 2);
}

function estimateOverflowViewTabWidth(count: number) {
  if (count <= 0) return 0;
  return Math.max(
    VIEW_TAB_OVERFLOW_MIN_WIDTH,
    Math.ceil(8 + viewTabTextWidth(databaseViewLabels().moreViews(count)) + 17 + 8)
  );
}

function importedVisibleViewTabsForWidth(
  views: DbView[],
  activeId: string | undefined,
  availableWidth: number,
  reserveAddView: boolean
) {
  if (views.length <= 4) return views;
  const firstView = views[0];
  if (!firstView) return [];

  if (availableWidth <= 0) {
    const primary = views.slice(0, 3);
    const active = activeId ? views.find((view) => view.id === activeId) : undefined;
    return active && !primary.some((view) => view.id === active.id)
      ? [...views.slice(0, 2), active]
      : primary;
  }

  const mandatoryIds = new Set<string>();
  if (views[0]) mandatoryIds.add(views[0].id);
  if (activeId) mandatoryIds.add(activeId);

  let visibleIds = new Set(mandatoryIds);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const hiddenCount = views.length - visibleIds.size;
    const reservedWidth =
      (reserveAddView ? VIEW_TAB_ADD_BUTTON_WIDTH : 0) +
      estimateOverflowViewTabWidth(hiddenCount) +
      VIEW_TAB_INLINE_TOOLBAR_RESERVE +
      VIEW_TAB_FIT_SAFETY;
    const budget = Math.max(estimateViewTabWidth(firstView), availableWidth - reservedWidth);
    const nextVisibleIds = new Set(mandatoryIds);
    let used = views
      .filter((view) => nextVisibleIds.has(view.id))
      .reduce((total, view) => total + estimateViewTabWidth(view), 0);

    for (const view of views) {
      if (nextVisibleIds.has(view.id)) continue;
      const width = estimateViewTabWidth(view);
      if (used + width <= budget) {
        nextVisibleIds.add(view.id);
        used += width;
      }
    }

    if (nextVisibleIds.size === visibleIds.size) {
      visibleIds = nextVisibleIds;
      break;
    }
    visibleIds = nextVisibleIds;
  }

  return views.filter((view) => visibleIds.has(view.id));
}

function onSegmentedOptionGroupKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.defaultPrevented) return;
  if (isComposingKeyEvent(e)) return;
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(e.key)) return;

  const options = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-segmented-option]:not(:disabled)")
  ).filter((option) => option.offsetParent !== null);
  if (options.length === 0) return;

  e.preventDefault();
  e.stopPropagation();

  const current = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLButtonElement>("[data-segmented-option]")
    : null;
  const currentIndex = current ? options.indexOf(current) : -1;
  let nextIndex = currentIndex >= 0 ? currentIndex : 0;

  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    nextIndex = currentIndex >= 0 ? (currentIndex + 1) % options.length : 0;
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    nextIndex = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
  } else if (e.key === "Home") {
    nextIndex = 0;
  } else if (e.key === "End") {
    nextIndex = options.length - 1;
  }

  options[nextIndex]?.focus();
  options[nextIndex]?.click();
}

function currentUrlViewId() {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get("v");
}

function currentUrlRowPeekId() {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(ROW_PEEK_PARAM);
}

function replaceUrlViewId(viewId: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (viewId) url.searchParams.set("v", viewId);
  else url.searchParams.delete("v");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function writeUrlRowPeekId(
  pageId: string | null,
  mode: "push" | "replace",
  opts: { clearHash?: boolean; peekMode?: "side" | "center" } = {}
) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (pageId) {
    url.searchParams.set(ROW_PEEK_PARAM, pageId);
    url.searchParams.set(
      ROW_PEEK_MODE_PARAM,
      opts.peekMode === "center" ? ROW_PEEK_MODE_CENTER : ROW_PEEK_MODE_SIDE
    );
  } else {
    url.searchParams.delete(ROW_PEEK_PARAM);
    url.searchParams.delete(ROW_PEEK_MODE_PARAM);
  }
  if (opts.clearHash) url.hash = "";
  const href = `${url.pathname}${url.search}${url.hash}`;
  if (href === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  const state = window.history.state;
  if (mode === "push") window.history.pushState(state, "", href);
  else window.history.replaceState(state, "", href);
}

function rowPeekUrlOwnership(
  rowId: string | null,
  dbId: string,
  rows: Page[],
  pagesById: Record<string, Page>
): "none" | "belongs" | "foreign" | "unknown" {
  if (!rowId) return "none";
  if (rows.some((row) => row.id === rowId)) return "belongs";

  const row = pagesById[rowId];
  if (!row) return "unknown";
  if (row.parentType === "database" && row.parentId === dbId && !row.inTrash) return "belongs";
  return "foreign";
}

function databaseViewLink(databaseId: string, viewId: string) {
  if (typeof window === "undefined") return `${pageHref(databaseId)}?v=${encodeURIComponent(viewId)}`;
  const url = new URL(pageHref(databaseId), window.location.origin);
  url.searchParams.set("v", viewId);
  return url.toString();
}

const TEMPLATE_EDITOR_PAGE_PREFIX = "template:";

function templateBodyPlaceholder() {
  return databaseViewLabels().templateBodyPlaceholder;
}

function templateEditorPageId(templateId: string) {
  return `${TEMPLATE_EDITOR_PAGE_PREFIX}${templateId}`;
}

function cloneTemplateBlockContent(
  content?: ButtonTemplateBlock["content"]
): NonNullable<ButtonTemplateBlock["content"]> {
  const value = content ?? { rich: [] };
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as NonNullable<ButtonTemplateBlock["content"]>;
}

function templateEditorBlockId(pageId: string, path: number[]) {
  return `${pageId}:block:${path.join(".")}`;
}

function templateBlocksToEditorBlocks(
  pageId: string,
  blocks: ButtonTemplateBlock[],
  now: string,
  parentId: string | null = null,
  path: number[] = []
): Block[] {
  return blocks.flatMap((block, index) => {
    const currentPath = [...path, index];
    const content = cloneTemplateBlockContent(block.content);
    const id = templateEditorBlockId(pageId, currentPath);
    const editorBlock: Block = {
      id,
      pageId,
      parentId,
      type: block.type,
      content,
      plainText: spansToPlainText(content.rich) || content.expression || content.url || content.fileName || "",
      position: index + 1,
      createdAt: now,
      updatedAt: now,
    };
    return [
      editorBlock,
      ...templateBlocksToEditorBlocks(pageId, block.children ?? [], now, id, currentPath),
    ];
  });
}

function editorBlocksToTemplateBlocks(blocks: Block[], parentId: string | null = null): ButtonTemplateBlock[] {
  return blocks
    .filter((block) => (block.parentId ?? null) === parentId)
    .sort((a, b) => a.position - b.position)
    .map((block) => {
      const next: ButtonTemplateBlock = {
        type: block.type,
        content: cloneTemplateBlockContent(block.content),
      };
      const children = editorBlocksToTemplateBlocks(blocks, block.id);
      if (children.length > 0) next.children = children;
      return next;
    });
}

function makeTemplateBlock(type: BlockType = "paragraph", text = ""): ButtonTemplateBlock {
  if (type === "divider") return { type, content: { rich: [] } };
  if (type === "inline_database") return { type, content: { rich: [] } };
  if (type === "equation") return { type, content: { expression: text } };
  if (type === "code") return { type, content: { rich: text ? [{ text }] : [], language: "" } };
  if (type === "to_do") return { type, content: { rich: parseInlineMarkdown(text), checked: false } };
  if (type === "callout") return { type, content: { rich: parseInlineMarkdown(text), icon: "💡" } };
  return { type, content: { rich: parseInlineMarkdown(text) } };
}

function templateBlocksOrDefault(blocks?: ButtonTemplateBlock[]) {
  return blocks && blocks.length > 0 ? blocks : [makeTemplateBlock()];
}

function startsWithEmojiIcon(value: string) {
  return /^[\u{1F000}-\u{1FAFF}]/u.test(value.trim());
}

function searchTerms(query: string) {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function templateNameValue(template: Pick<DbTemplate, "name">) {
  const name = template.name.trim();
  return name.toLowerCase() === "untitled template" ? "" : name;
}

function templateTitleValue(template: Pick<DbTemplate, "title">) {
  const title = template.title?.trim() ?? "";
  return title.toLowerCase() === "untitled" ? "" : (template.title ?? "");
}

function templateDisplayName(template: Pick<DbTemplate, "name" | "title">) {
  return templateNameValue(template) || templateTitleValue(template) || databaseViewLabels().newTemplate;
}

// --- Nested filter tree helpers (pure, immutable) -------------------------------
// A `path` is the chain of group indices from the root: [] = root group, [0] = its
// first sub-group, [0,2] = the third sub-group of that, and so on. Every transform
// clones the groups it touches so React state is never mutated in place.

/** Read the current tree, lazily migrating any existing flat filters into the root. */
function readFilterTree(config: DbView["config"]): FilterGroup {
  return effectiveFilterGroup(config) ?? {
    conjunction: config?.filterConjunction === "or" ? "or" : "and",
    filters: config?.filters ?? [],
    groups: [],
  };
}

function cloneViewConfigPart<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value)) as T;
}

/** Count every leaf condition in the tree (used for the toolbar button badge). */
function countLeaves(group: FilterGroup): number {
  let total = group.filters.length;
  for (const sub of group.groups ?? []) total += countLeaves(sub);
  return total;
}

function effectiveFilterOperator(prop: DbProperty, operator: FilterOperator): FilterOperator {
  const operators = operatorsFor(prop);
  return operators.includes(operator) ? operator : operators[0];
}

function placeViewTabMenu(trigger: HTMLElement, width: number): CSSProperties {
  const margin = 8;
  const rect = trigger.getBoundingClientRect();
  const menuWidth = Math.max(220, Math.min(width, window.innerWidth - margin * 2));
  const preferredLeft = rect.left + menuWidth > window.innerWidth - margin
    ? rect.right - menuWidth
    : rect.left;
  const left = Math.min(
    Math.max(margin, preferredLeft),
    Math.max(margin, window.innerWidth - menuWidth - margin)
  );
  const top = Math.max(margin, Math.min(rect.bottom + 4, window.innerHeight - margin - 180));
  return {
    position: "fixed",
    top,
    left,
    width: menuWidth,
    maxWidth: `calc(100vw - ${margin * 2}px)`,
    maxHeight: Math.max(180, window.innerHeight - top - margin),
  };
}

/**
 * Return a new tree where the group at `path` is replaced by `fn(group)`. The path
 * and every ancestor are rebuilt with fresh objects/arrays; untouched branches are
 * shared by reference.
 */
function updateGroupAtPath(
  root: FilterGroup,
  path: number[],
  fn: (group: FilterGroup) => FilterGroup
): FilterGroup {
  if (path.length === 0) return fn(root);
  const [index, ...rest] = path;
  const groups = root.groups ?? [];
  const child = groups[index];
  if (!child) return root;
  const nextChild = updateGroupAtPath(child, rest, fn);
  const nextGroups = groups.map((g, i) => (i === index ? nextChild : g));
  return { ...root, groups: nextGroups };
}

export function DatabaseView({
  db,
  skipRemoteLoad = false,
  readOnly: inheritedReadOnly = false,
  publicReadOnly = false,
  sharedToken,
  initialViewId,
  visibleViewIds,
  notionLinkedDatabaseTargetIds,
  syncUrl = true,
  placement = "page",
  contextPageId,
  scopedViewOwnerId,
  onScopedViewsChange,
  publishAwareness,
  remoteAwarenessByBlock = {},
  syncRowUrl: syncRowUrlProp,
}: {
  db: Page;
  skipRemoteLoad?: boolean;
  readOnly?: boolean;
  publicReadOnly?: boolean;
  sharedToken?: string;
  initialViewId?: string;
  visibleViewIds?: string[];
  notionLinkedDatabaseTargetIds?: string[];
  syncUrl?: boolean;
  placement?: "page" | "inline";
  contextPageId?: string;
  scopedViewOwnerId?: string;
  onScopedViewsChange?: (viewIds: string[], activeViewId: string | null) => void;
  publishAwareness?: (
    blockId: string,
    mode: PageAwarenessMode,
    selectedBlockIds?: string[],
    textRange?: PageAwarenessTextRange,
  ) => void;
  remoteAwarenessByBlock?: Record<string, PagePresenceAwareness[]>;
  syncRowUrl?: boolean;
}) {
  const router = useRouter();
  const reactSelectionSlotId = useId();
  const tableSelectionChromeSlotId = `table-selection-chrome-${reactSelectionSlotId.replace(/:/g, "")}`;
  const loadDatabase = useStore((s) => s.loadDatabase);
  const loadDatabaseRows = useStore((s) => s.loadDatabaseRows);
  const loadMoreDatabaseRows = useStore((s) => s.loadMoreDatabaseRows);
  const warmDatabaseRowDetail = useStore((s) => s.warmDatabaseRowDetail);
  const views = useStore(useShallow((s) => s.dbViews(db.id)));
  const props = useStore(useShallow((s) => s.dbProperties(db.id)));
  const storeRows = useStore(useShallow((s) => s.dbRows(db.id)));
  const rowPage = useStore(useShallow((s) => s.databaseRowPagesByDb[db.id]));
  const pagesById = useStore((s) => s.pagesById);
  const contextPage = contextPageId ? pagesById[contextPageId] : undefined;
  const containingRowPageId =
    contextPage?.parentType === "database" && !contextPage.inTrash ? contextPage.id : undefined;
  const loaded = useStore((s) => s.loadedDbs.has(db.id));
  const metadataLoaded = loaded || views.length > 0 || props.length > 0;
  const addView = useStore((s) => s.addView);
  const updateView = useStore((s) => s.updateView);
  const deleteView = useStore((s) => s.deleteView);
  const restoreDeletedView = useStore((s) => s.restoreDeletedView);
  const notify = useStore((s) => s.notify);
  const [activeId, setActiveId] = useState<string | null>(() =>
    syncUrl ? currentUrlViewId() ?? initialViewId ?? null : initialViewId ?? null
  );
  const [addOpen, setAddOpen] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [newViewType, setNewViewType] = useState<ViewType>("table");
  const [viewMenuId, setViewMenuId] = useState<string | null>(null);
  const [viewSearches, setViewSearches] = useState<Record<string, string>>({});
  const [draggingViewId, setDraggingViewId] = useState<string | null>(null);
  const [dragOverViewId, setDragOverViewId] = useState<string | null>(null);
  const [dragOverViewSide, setDragOverViewSide] = useState<"before" | "after">("before");
  const [addViewMenuStyle, setAddViewMenuStyle] = useState<CSSProperties | undefined>();
  const [viewActionMenuStyle, setViewActionMenuStyle] = useState<CSSProperties | undefined>();
  const [viewOverflowOpen, setViewOverflowOpen] = useState(false);
  const [viewOverflowMenuStyle, setViewOverflowMenuStyle] = useState<CSSProperties | undefined>();
  const [viewTabsAvailableWidth, setViewTabsAvailableWidth] = useState(0);
  const syncRowUrl = syncRowUrlProp ?? syncUrl;
  const metadataViewIds = useMemo(() => {
    const ids = [...(visibleViewIds ?? [])];
    if (initialViewId) ids.push(initialViewId);
    return ids.filter((id, index) => id.trim().length > 0 && ids.indexOf(id) === index);
  }, [initialViewId, visibleViewIds]);
  const metadataViewIdsKey = metadataViewIds.join(",");
  // The metadata-load effect keys off `metadataViewIdsKey` (a stable content
  // hash) so it fires only when the set of view ids actually changes, not on
  // every render where `metadataViewIds` gets a new array identity. Read the
  // array itself through a ref so the effect can pass it to loadDatabase.
  const metadataViewIdsRef = useRef(metadataViewIds);
  useEffect(() => {
    metadataViewIdsRef.current = metadataViewIds;
  });
  const [peekId, setPeekId] = useState<string | null>(() => (syncUrl && syncRowUrl ? currentUrlRowPeekId() : null));
  const [renderedPeekId, setRenderedPeekId] = useState<string | null>(peekId);
  const [rowPeekClosing, setRowPeekClosing] = useState(false);
  const [rowPropertiesMenuRequest, setRowPropertiesMenuRequest] = useState<{
    pageId: string;
    tick: number;
  } | null>(null);
  const [searchFocusTick, setSearchFocusTick] = useState(0);
  const peekReturnRef = useRef<HTMLElement | null>(null);
  const peekIdRef = useRef<string | null>(peekId);
  const viewTabsRef = useRef<HTMLDivElement>(null);
  const dbRootRef = useRef<HTMLDivElement>(null);
  const addViewButtonRef = useRef<HTMLButtonElement>(null);
  const viewOverflowButtonRef = useRef<HTMLButtonElement>(null);
  const newViewNameRef = useRef<HTMLInputElement>(null);
  const addViewMenuRef = useRef<HTMLDivElement>(null);
  const viewActionMenuRef = useRef<HTMLDivElement>(null);
  const viewOverflowMenuRef = useRef<HTMLDivElement>(null);
  const viewActionReturnRef = useRef<HTMLElement | null>(null);

  function focusViewTab(viewId: string) {
    viewTabsRef.current
      ?.querySelector<HTMLButtonElement>(`[data-view-tab="${viewId}"]`)
      ?.focus();
  }

  function focusViewActionButton(viewId: string) {
    viewTabsRef.current
      ?.querySelector<HTMLButtonElement>(`[data-view-actions="${viewId}"]`)
      ?.focus();
  }

  function scrollViewTabIntoView(viewId: string, opts: { preferStart?: boolean } = {}) {
    const align = () => {
      const tablist = viewTabsRef.current;
      if (!tablist) return;
      const tabItems = Array.from(tablist.querySelectorAll<HTMLElement>("[data-view-tab-wrap]"));
      const targetIndex = tabItems.findIndex((item) => item.getAttribute("data-view-tab-wrap") === viewId);
      const target = targetIndex >= 0 ? tabItems[targetIndex] : null;
      if (!target) return;

      const margin = 6;
      const tablistRect = tablist.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const visibleLeft = tablist.scrollLeft;
      const visibleRight = visibleLeft + tablist.clientWidth;
      const targetLeft = tablist.scrollLeft + targetRect.left - tablistRect.left;
      const targetRight = tablist.scrollLeft + targetRect.right - tablistRect.left;
      const maxScrollLeft = Math.max(0, tablist.scrollWidth - tablist.clientWidth);
      let nextScrollLeft = tablist.scrollLeft;
      const shouldPreferStart =
        opts.preferStart &&
        window.matchMedia("(max-width: 720px)").matches &&
        targetIndex >= 3;
      const startMargin = shouldPreferStart ? 0 : margin;

      if (shouldPreferStart || targetLeft < visibleLeft + margin || targetRight > visibleRight - margin) {
        nextScrollLeft = targetLeft - startMargin;
      }

      tablist.scrollLeft = Math.min(maxScrollLeft, Math.max(0, nextScrollLeft));
    };

    align();
    window.setTimeout(align, 0);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(align);
      window.setTimeout(align, 80);
      window.setTimeout(align, 140);
    });
  }

  function alignViewTabElementToCleanStart(element: HTMLElement | null) {
    const tablist = viewTabsRef.current;
    if (!tablist || !element || !window.matchMedia("(max-width: 720px)").matches) return;

    const tablistRect = tablist.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const elementLeft = tablist.scrollLeft + elementRect.left - tablistRect.left;
    const maxScrollLeft = Math.max(0, tablist.scrollWidth - tablist.clientWidth);
    tablist.scrollLeft = Math.min(maxScrollLeft, Math.max(0, elementLeft));
  }

  function closeAddViewMenu(restoreFocus = false) {
    setAddOpen(false);
    setAddViewMenuStyle(undefined);
    setNewViewName("");
    setNewViewType("table");
    if (restoreFocus) {
      window.requestAnimationFrame(() => addViewButtonRef.current?.focus());
    }
  }

  function closeViewActionMenu(restoreFocus = false) {
    const id = viewMenuId;
    const returnTarget = viewActionReturnRef.current;
    viewActionReturnRef.current = null;
    setViewMenuId(null);
    setViewActionMenuStyle(undefined);
    if (restoreFocus && id) {
      window.requestAnimationFrame(() => {
        if (returnTarget?.isConnected) {
          returnTarget.focus();
          return;
        }
        focusViewActionButton(id);
      });
    }
  }

  function closeViewOverflowMenu(restoreFocus = false) {
    setViewOverflowOpen(false);
    setViewOverflowMenuStyle(undefined);
    if (restoreFocus) {
      window.requestAnimationFrame(() => viewOverflowButtonRef.current?.focus());
    }
  }

  const warmRowDetail = useCallback(
    (pageId: string) => {
      if (skipRemoteLoad || publicReadOnly) return;
      warmDatabaseRowDetail(db.id, pageId);
    },
    [db.id, publicReadOnly, skipRemoteLoad, warmDatabaseRowDetail],
  );

  function openRowInMode(pageId: string, mode: "side" | "center" | "full") {
    warmRowDetail(pageId);
    if (mode === "full" && (!publicReadOnly || sharedToken)) {
      router.push(publicReadOnly && sharedToken ? sharedPageHref(sharedToken, pageId) : pageHref(pageId));
      return;
    }
    const activeElement = document.activeElement;
    peekReturnRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    setPeekId(pageId);
    if (syncRowUrl) {
      writeUrlRowPeekId(pageId, "push", {
        clearHash: true,
        peekMode: mode === "center" ? "center" : "side",
      });
    }
  }

  function openRowPeek(pageId: string) {
    openRowInMode(pageId, activeOpenPageIn === "full" ? "full" : activeOpenPageIn === "center" ? "center" : "side");
  }

  function openRowPropertiesMenu(pageId: string) {
    setRowPropertiesMenuRequest({ pageId, tick: Date.now() });
    openRowInMode(pageId, "side");
  }

  function closeRowPeek() {
    setPeekId(null);
    if (syncRowUrl) writeUrlRowPeekId(null, "replace", { clearHash: true });
    window.requestAnimationFrame(() => {
      peekReturnRef.current?.focus();
      peekReturnRef.current = null;
    });
  }

  function switchRowPeek(pageId: string) {
    warmRowDetail(pageId);
    setPeekId(pageId);
    if (syncRowUrl) {
      writeUrlRowPeekId(pageId, "replace", {
        clearHash: true,
        peekMode: activeOpenPageIn === "center" ? "center" : "side",
      });
    }
  }

  useEffect(() => {
    if (!skipRemoteLoad) void loadDatabase(db.id, { rows: false, viewIds: metadataViewIdsRef.current });
  }, [db.id, loadDatabase, metadataViewIdsKey, skipRemoteLoad]);

  useEffect(() => {
    peekIdRef.current = peekId;
    if (peekId) warmRowDetail(peekId);
  }, [peekId, warmRowDetail]);

  useEffect(() => {
    if (peekId) {
      setRenderedPeekId(peekId);
      setRowPeekClosing(false);
      return;
    }
    if (renderedPeekId) setRowPeekClosing(true);
  }, [peekId, renderedPeekId]);

  useEffect(() => {
    if (!rowPeekClosing) return;
    const timeout = window.setTimeout(() => {
      setRenderedPeekId(null);
      setRowPeekClosing(false);
    }, ROW_PEEK_EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [rowPeekClosing]);

  useEffect(() => {
    if (!syncUrl && !syncRowUrl) return;

    function restorePeekFocus() {
      window.requestAnimationFrame(() => {
        peekReturnRef.current?.focus();
        peekReturnRef.current = null;
      });
    }

    function syncViewFromUrl() {
      if (syncUrl) setActiveId(currentUrlViewId());
      if (!syncRowUrl) return;

      const nextPeekId = currentUrlRowPeekId();
      const ownership = rowPeekUrlOwnership(nextPeekId, db.id, storeRows, pagesById);
      if (ownership === "none") {
        if (peekIdRef.current) restorePeekFocus();
        setPeekId(null);
        return;
      }
      if (ownership === "belongs" || (syncUrl && ownership === "unknown")) {
        setPeekId(nextPeekId);
        return;
      }
      if (ownership === "foreign") {
        if (nextPeekId && containingRowPageId && nextPeekId === containingRowPageId) {
          if (peekIdRef.current) restorePeekFocus();
          setPeekId(null);
          return;
        }
        if (nextPeekId && peekIdRef.current) return;
        if (peekIdRef.current) restorePeekFocus();
        setPeekId(null);
      }
    }

    syncViewFromUrl();
    window.addEventListener("popstate", syncViewFromUrl);
    return () => window.removeEventListener("popstate", syncViewFromUrl);
  }, [containingRowPageId, db.id, pagesById, storeRows, syncRowUrl, syncUrl]);

  useEffect(() => {
    if (!addOpen) return;
    const frame = window.requestAnimationFrame(() => {
      if (scopedViewOwnerId) {
        addViewMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
        return;
      }
      newViewNameRef.current?.focus();
      newViewNameRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [addOpen, scopedViewOwnerId]);

  useEffect(() => {
    if (!viewMenuId) return;
    const frame = window.requestAnimationFrame(() => {
      const input = viewActionMenuRef.current?.querySelector<HTMLInputElement>("input");
      input?.focus();
      input?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [viewMenuId]);

  const readOnly = inheritedReadOnly || !!db.isLocked;
  const scopedToViewIds = !!visibleViewIds?.length;
  const canCreateScopedViews = !!scopedViewOwnerId && !!onScopedViewsChange;
  const visibleViews = useMemo(() => {
    let supported = views.filter(isRenderableDatabaseView);
    if (!visibleViewIds?.length) {
      supported = supported.filter(
        (view) => !isTemplateLinkedView(view) && !isInlineDatabaseScopedView(view)
      );
    }
    if (placement === "inline") {
      const ownedScoped = scopedViewOwnerId
        ? supported.filter((view) => inlineDatabaseScopedViewOwner(view) === scopedViewOwnerId)
        : [];
      const targetable = supported.filter((view) => {
        const owner = inlineDatabaseScopedViewOwner(view);
        if (!owner) return true;
        return owner !== scopedViewOwnerId ? false : !ownedScoped.some((owned) => owned.id === view.id);
      });
      const filtered = filterViewsByNotionLinkedDatabaseTargets(targetable, notionLinkedDatabaseTargetIds);
      if (ownedScoped.length > 0) {
        const seen = new Set(filtered.map((view) => view.id));
        supported = filtered.concat(ownedScoped.filter((view) => !seen.has(view.id)));
      } else {
        supported = filtered;
      }
      const withoutImportedUntitled = supported.filter((view) => !isImportedUntitledView(view));
      if (withoutImportedUntitled.length > 0) supported = withoutImportedUntitled;
      supported = orderImportedInlineViewsForNotionChrome(supported);
    }
    if (!visibleViewIds?.length) return supported;
    const allowed = new Set(visibleViewIds);
    const order = new Map(visibleViewIds.map((id, index) => [id, index]));
    const scoped = supported
      .filter((view) => allowed.has(view.id))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return scoped;
  }, [notionLinkedDatabaseTargetIds, placement, scopedViewOwnerId, views, visibleViewIds]);
  const viewChromeReadOnly = readOnly || (scopedToViewIds && !canCreateScopedViews);
  const canAddView = !readOnly && (!scopedToViewIds || canCreateScopedViews);
  const viewTabDragReadOnly = readOnly || (scopedToViewIds && !canCreateScopedViews);
  function canMutateViewTab(view: DbView) {
    if (readOnly) return false;
    if (scopedViewOwnerId) return inlineDatabaseScopedViewOwner(view) === scopedViewOwnerId;
    return !scopedToViewIds;
  }
  function canOpenViewActionMenu(_view: DbView) {
    if (readOnly) return false;
    if (scopedViewOwnerId) return true;
    return !scopedToViewIds;
  }
  function currentScopedViewIds() {
    const ids = visibleViewIds?.length ? visibleViewIds : visibleViews.map((view) => view.id);
    return ids.filter((id, index) => id && ids.indexOf(id) === index);
  }
  function openAddViewMenu(anchor: HTMLElement) {
    if (!canAddView) return;
    alignViewTabElementToCleanStart(anchor.closest("[data-view-add-wrap]"));
    closeViewActionMenu(false);
    closeViewOverflowMenu(false);
    setAddViewMenuStyle(placeViewTabMenu(anchor, scopedViewOwnerId ? 280 : 360));
    setAddOpen(true);
  }
  function renderAddViewMenuLayer() {
    if (!addOpen) return null;
    const layer = (
      <>
        <button
          type="button"
          className={styles.menuBackdrop}
          onClick={() => closeAddViewMenu(true)}
          tabIndex={-1}
          aria-label="Close add view menu"
        />
        <div
          ref={addViewMenuRef}
          className={`${styles.viewMenu} ${styles.addViewMenuPanel} ${
            scopedViewOwnerId ? styles.inlineAddViewMenuPanel : ""
          }`}
          style={addViewMenuStyle}
          role="dialog"
          aria-label={scopedViewOwnerId ? databaseViewLabels().addNewView : "New view"}
          onKeyDown={onAddViewMenuKeyDown}
        >
          {scopedViewOwnerId ? (
            <div className={styles.inlineAddViewMenu}>
              <div className={styles.inlineAddViewTitle}>{databaseViewLabels().addNewView}</div>
              <div className={styles.inlineAddViewGrid} role="menu">
                {INLINE_SCOPED_VIEW_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={styles.inlineAddViewType}
                    role="menuitem"
                    onClick={() => void createNewView(type)}
                  >
                    <span className={styles.viewGlyph}>
                      <ViewTypeIcon type={type} />
                    </span>
                    <span>{databaseViewLabels().viewTypes[type]}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <form
              className={styles.addViewForm}
              onSubmit={(e) => {
                e.preventDefault();
                void createNewView();
              }}
            >
              <div className={styles.addViewTitle}>
                <span>Add view</span>
                <span>Choose how this database should appear.</span>
              </div>
              <div className={styles.addViewSectionLabel}>View type</div>
              <div
                className={styles.addViewTypeGrid}
                role="radiogroup"
                tabIndex={-1}
                aria-label="View type"
                onKeyDown={onSegmentedOptionGroupKeyDown}
              >
                {NOTION_2023_VIEW_TYPES.map((t) => (
                  <button
                    type="button"
                    key={t.type}
                    className={styles.addViewType}
                    data-add-view-type
                    data-segmented-option
                    data-active={newViewType === t.type ? "true" : undefined}
                    role="radio"
                    aria-checked={newViewType === t.type}
                    tabIndex={newViewType === t.type ? 0 : -1}
                    onClick={() => setNewViewType(t.type)}
                  >
                    <span className={styles.viewGlyph}>
                      <ViewTypeIcon type={t.type} />
                    </span>
                    <span className={styles.addViewTypeText}>
                      <span>{t.label}</span>
                      <span>{t.description}</span>
                    </span>
                    {newViewType === t.type && (
                      <span className={styles.check}>
                        <CheckIcon size={14} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <label className={styles.addViewField}>
                <span>View name</span>
                <input
                  ref={newViewNameRef}
                  value={newViewName}
                  onChange={(e) => setNewViewName(e.target.value)}
                  placeholder={NOTION_2023_VIEW_TYPES.find((item) => item.type === newViewType)?.label ?? "Table"}
                />
              </label>
              <div className={styles.addViewActions}>
                <button type="button" onClick={() => closeAddViewMenu(true)}>
                  Cancel
                </button>
                <button type="submit" className={styles.addViewCreate}>
                  Create
                </button>
              </div>
            </form>
          )}
        </div>
      </>
    );
    return typeof document === "undefined" ? layer : createPortal(layer, document.body);
  }

  function renderViewTabMenuLayer(children: ReactNode) {
    return typeof document === "undefined" ? children : createPortal(children, document.body);
  }

  useEffect(() => {
    const root = dbRootRef.current;
    if (!root) return;
    function onOpenAddView(event: Event) {
      if (!canAddView) return;
      const anchor = (event as CustomEvent<{ anchor?: HTMLElement }>).detail?.anchor;
      if (!(anchor instanceof HTMLElement)) return;
      event.preventDefault();
      event.stopPropagation();
      openAddViewMenu(anchor);
    }
    root.addEventListener("notionlike:open-inline-add-view", onOpenAddView);
    return () => root.removeEventListener("notionlike:open-inline-add-view", onOpenAddView);
  });
  useEffect(() => {
    if (syncUrl || !initialViewId || activeId === initialViewId) return;
    if (!visibleViews.some((view) => view.id === initialViewId)) return;
    setActiveId(initialViewId);
  }, [activeId, initialViewId, syncUrl, visibleViews]);
  useEffect(() => {
    if (!loaded || readOnly || scopedToViewIds || visibleViews.length > 0) return;
    let cancelled = false;
    void addView(db.id, "table", "Table")
      .then((view) => {
        if (!cancelled) setActiveId(view.id);
      })
      .catch(() => {
        if (!cancelled) notify(databaseViewLabels().toast.couldntCreateDefaultTableView, "error");
      });
    return () => {
      cancelled = true;
    };
  }, [addView, db.id, loaded, notify, readOnly, scopedToViewIds, visibleViews.length]);
  const active = visibleViews.find((v) => v.id === activeId) ?? visibleViews[0];
  const hasImportedNotionInlineViews = placement === "inline" && visibleViews.some(isImportedNotionView);
  const hideSingleInlineViewTab = placement === "inline" && visibleViews.length === 1;
  const visibleViewTabs = useMemo(() => {
    if (hideSingleInlineViewTab) return [];
    if (!hasImportedNotionInlineViews) return visibleViews;
    return importedVisibleViewTabsForWidth(
      visibleViews,
      active?.id,
      viewTabsAvailableWidth,
      canAddView
    );
  }, [
    active?.id,
    canAddView,
    hasImportedNotionInlineViews,
    hideSingleInlineViewTab,
    viewTabsAvailableWidth,
    visibleViews,
  ]);
  const overflowViewTabs = useMemo(() => {
    if (hideSingleInlineViewTab) return [];
    const visibleIds = new Set(visibleViewTabs.map((view) => view.id));
    return visibleViews.filter((view) => !visibleIds.has(view.id));
  }, [hideSingleInlineViewTab, visibleViewTabs, visibleViews]);
  const activeTabIsRendered = !!active && visibleViewTabs.some((view) => view.id === active.id);
  const activeOpenPageIn = effectiveOpenPageIn(active);
  const activeSearch = active ? viewSearches[active.id] ?? "" : "";
  const activeViewId = active?.id;
  const activeInitialLoadLimit =
    active?.type === "table" ? tableInitialLoadLimit(active) : undefined;
  const activeRowsQuery = useMemo<DatabaseRowsQuery | undefined>(
    () =>
      activeViewId
        ? {
            viewId: activeViewId,
            search: activeSearch,
            currentPageId: contextPageId,
            limit: activeInitialLoadLimit,
          }
        : undefined,
    [activeViewId, activeInitialLoadLimit, activeSearch, contextPageId]
  );
  const activeRowsViewSignature = active
    ? JSON.stringify({
        type: active.type,
        config: active.config ?? {},
      })
    : "";
  const activeRowsQueryKey = activeRowsQuery ? databaseRowsQueryKey(activeRowsQuery) : "";
  const activeRowPage = rowPage?.queryKey === activeRowsQueryKey ? rowPage : undefined;
  const rowsReady = skipRemoteLoad || !active || rowPage?.queryKey === activeRowsQueryKey;
  const rows = useMemo(() => (rowsReady ? storeRows : []), [rowsReady, storeRows]);
  const rowsLoading = !skipRemoteLoad && !!active && (!activeRowPage || activeRowPage.loading === true);
  const visibleRowIds = useMemo(
    () =>
      active
        ? applyView(rows, props, active, pagesById, {
            search: activeSearch,
            currentPageId: contextPageId,
          }).map((row) => row.id)
        : [],
    [active, activeSearch, contextPageId, pagesById, props, rows]
  );

  const roomPageId = contextPageId || db.id;

  useEffect(() => {
    function onLocalDatabaseMutation(event: Event) {
      const detail = (event as CustomEvent<LocalDatabaseMutationChange>).detail;
      if (!detail || detail.databaseId !== db.id) return;
      publishPageRoomMutation({
        ...detail,
        pageId: roomPageId,
      });
      if (detail.reason === "database_meta_changed" && detail.patch && detail.targetPageId) {
        publishPageRoomMutation({
          kind: "page_meta_changed",
          pageId: roomPageId,
          patch: detail.patch,
          reason: detail.reason,
          revision: detail.revision,
          targetPageId: detail.targetPageId,
          updatedAt: detail.updatedAt,
        });
      }
    }

    window.addEventListener(LOCAL_DATABASE_MUTATION_EVENT, onLocalDatabaseMutation);
    return () => window.removeEventListener(LOCAL_DATABASE_MUTATION_EVENT, onLocalDatabaseMutation);
  }, [db.id, roomPageId]);

  useEffect(() => {
    if (skipRemoteLoad) return;
    function onRoomMutation(event: Event) {
      const detail = (event as CustomEvent<PageRoomMutationReceived>).detail;
      if (!detail || detail.pageId !== roomPageId) return;
      const targetsThisDatabase = detail.databaseId === db.id || detail.targetPageId === db.id;
      if (!targetsThisDatabase) return;

      if (detail.kind === "page_meta_changed" && detail.targetPageId === db.id && detail.patch) {
        useStore.getState().applyRemotePagePatch(db.id, detail.patch);
      }

      if (detail.kind === "database_rows_changed") {
        if (activeRowsQuery) {
          void loadDatabaseRows(db.id, { ...activeRowsQuery, force: true, reset: true });
        } else {
          void loadDatabase(db.id, { force: true, rows: true, viewIds: metadataViewIds });
        }
        return;
      }

      if (
        detail.kind === "database_schema_changed" ||
        detail.kind === "database_views_changed" ||
        detail.kind === "database_templates_changed"
      ) {
        void loadDatabase(db.id, { force: true, rows: false, viewIds: metadataViewIds });
        if (activeRowsQuery) {
          void loadDatabaseRows(db.id, { ...activeRowsQuery, force: true, reset: true });
        }
      }
    }

    window.addEventListener(PAGE_ROOM_MUTATION_RECEIVED_EVENT, onRoomMutation);
    return () => window.removeEventListener(PAGE_ROOM_MUTATION_RECEIVED_EVENT, onRoomMutation);
  }, [
    activeRowsQuery,
    db.id,
    loadDatabase,
    loadDatabaseRows,
    metadataViewIds,
    roomPageId,
    skipRemoteLoad,
  ]);

  useEffect(() => {
    if (skipRemoteLoad || !metadataLoaded || !activeRowsQuery) return;
    const timer = window.setTimeout(() => {
      void loadDatabaseRows(db.id, { ...activeRowsQuery, reset: true });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [
    activeRowsQuery,
    activeRowsViewSignature,
    db.id,
    loadDatabaseRows,
    metadataLoaded,
    rowPage?.queryKey,
    skipRemoteLoad,
  ]);

  useEffect(() => {
    if (!syncUrl || !activeId || !active || active.id === activeId) return;
    replaceUrlViewId(active.id);
  }, [active, activeId, syncUrl]);
  useLayoutEffect(() => {
    if (!active?.id) return;
    scrollViewTabIntoView(active.id, { preferStart: true });
  }, [active?.id]);
  useLayoutEffect(() => {
    const tablist = viewTabsRef.current;
    if (!tablist) return;

    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setViewTabsAvailableWidth(Math.round(tablist.clientWidth));
      });
    };

    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(tablist);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [
    active?.id,
    hasImportedNotionInlineViews,
    hideSingleInlineViewTab,
    visibleViews.length,
    viewChromeReadOnly,
  ]);

  function activateView(viewId: string | null, shouldSyncUrl = true) {
    setActiveId(viewId);
    if (syncUrl && shouldSyncUrl) replaceUrlViewId(viewId);
  }

  function selectView(viewId: string) {
    activateView(viewId);
    if (canCreateScopedViews) onScopedViewsChange?.(currentScopedViewIds(), viewId);
    scrollViewTabIntoView(viewId, { preferStart: true });
    setAddOpen(false);
    closeViewActionMenu(false);
    closeViewOverflowMenu(false);
  }

  function openViewActionMenu(view: DbView, trigger: HTMLElement) {
    if (!canOpenViewActionMenu(view)) return;
    alignViewTabElementToCleanStart(trigger.closest("[data-view-tab-wrap]"));
    activateView(view.id);
    if (canCreateScopedViews) onScopedViewsChange?.(currentScopedViewIds(), view.id);
    scrollViewTabIntoView(view.id, { preferStart: true });
    setAddOpen(false);
    setAddViewMenuStyle(undefined);
    closeViewOverflowMenu(false);
    viewActionReturnRef.current = trigger;
    setViewMenuId(view.id);
    setViewActionMenuStyle(placeViewTabMenu(trigger, 260));
    window.requestAnimationFrame(() => trigger.focus());
  }

  function openViewAsFullPage(view: DbView) {
    window.open(databaseViewLink(db.id, view.id), "_blank", "noopener,noreferrer");
    closeViewActionMenu(true);
  }

  function setActiveSearch(next: string) {
    if (!active) return;
    setViewSearches((current) => ({
      ...current,
      [active.id]: next,
    }));
  }

  async function copyViewLink(view: DbView) {
    const copied = await copyText(databaseViewLink(db.id, view.id));
    notify(
      copied ? databaseViewLabels().copiedViewLink : databaseViewLabels().copyViewLinkFailed,
      copied ? "success" : "error"
    );
    closeViewActionMenu(true);
  }

  function onViewTabKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, viewId: string) {
    if (isComposingKeyEvent(e)) return;
    const current = visibleViews.find((view) => view.id === viewId);
    if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && current && canOpenViewActionMenu(current)) {
      e.preventDefault();
      e.stopPropagation();
      openViewActionMenu(current, e.currentTarget);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const index = visibleViews.findIndex((view) => view.id === viewId);
    if (index < 0) return;

    e.preventDefault();
    e.stopPropagation();
    let nextIndex = index;
    if (e.key === "ArrowRight") {
      nextIndex = (index + 1) % visibleViews.length;
    } else if (e.key === "ArrowLeft") {
      nextIndex = index > 0 ? index - 1 : visibleViews.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = visibleViews.length - 1;
    }

    const next = visibleViews[nextIndex];
    if (!next) return;
    selectView(next.id);
    window.requestAnimationFrame(() => focusViewTab(next.id));
  }

  function onAddViewMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (handleViewMenuShellKey(e, addViewMenuRef.current, () => closeAddViewMenu(true))) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement && (e.key === "Home" || e.key === "End")) return;

    const items = Array.from(
      addViewMenuRef.current?.querySelectorAll<HTMLElement>(
        'input:not(:disabled), button:not(:disabled)',
      ) ?? [],
    ).filter((element) => element.offsetParent !== null);
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const index = items.findIndex((item) => item === document.activeElement);
    let nextIndex = index >= 0 ? index : 0;
    if (e.key === "ArrowDown") {
      nextIndex = index >= 0 ? (index + 1) % items.length : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex = index > 0 ? index - 1 : items.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }
    items[nextIndex]?.focus();
  }

  function viewActionMenuItems() {
    return Array.from(
      viewActionMenuRef.current?.querySelectorAll<HTMLElement>(
        'input:not(:disabled), button:not(:disabled)',
      ) ?? [],
    ).filter((element) => element.offsetParent !== null);
  }

  function viewMenuFocusables(root: HTMLDivElement | null) {
    return Array.from(
      root?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => element.offsetParent !== null && element.tabIndex >= 0);
  }

  function handleViewMenuShellKey(
    e: ReactKeyboardEvent<HTMLDivElement>,
    root: HTMLDivElement | null,
    onClose: () => void
  ) {
    if (e.defaultPrevented) return true;
    if (isComposingKeyEvent(e)) return true;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return true;
    }
    if (e.key !== "Tab") return false;
    const focusables = viewMenuFocusables(root);
    if (focusables.length === 0) return false;
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
    return true;
  }

  function onViewActionMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (handleViewMenuShellKey(e, viewActionMenuRef.current, () => closeViewActionMenu(true))) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement && (e.key === "Home" || e.key === "End")) return;

    const items = viewActionMenuItems();
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const index = items.findIndex((item) => item === document.activeElement);
    let nextIndex = index >= 0 ? index : 0;
    if (e.key === "ArrowDown") {
      nextIndex = index >= 0 ? (index + 1) % items.length : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex = index > 0 ? index - 1 : items.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }
    items[nextIndex]?.focus();
  }

  function onViewOverflowMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (handleViewMenuShellKey(e, viewOverflowMenuRef.current, () => closeViewOverflowMenu(true))) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = viewMenuFocusables(viewOverflowMenuRef.current);
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const index = items.findIndex((item) => item === document.activeElement);
    let nextIndex = index >= 0 ? index : 0;
    if (e.key === "ArrowDown") {
      nextIndex = index >= 0 ? (index + 1) % items.length : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex = index > 0 ? index - 1 : items.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }
    items[nextIndex]?.focus();
  }

  function cloneViewConfig(config: DbView["config"]) {
    return config ? JSON.parse(JSON.stringify(config)) as DbView["config"] : {};
  }

  function copyViewName(view: DbView) {
    const base = `${(view.name || "Untitled").trim() || "Untitled"} copy`;
    const names = new Set(views.map((item) => item.name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base} ${i}`;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
    return `${base} ${views.length + 1}`;
  }

  async function duplicateView(view: DbView) {
    if (!canMutateViewTab(view) && !(scopedViewOwnerId && canCreateScopedViews)) return;
    // Insert the copy directly after its source instead of at the far right.
    const sourceIndex = views.findIndex((v) => v.id === view.id);
    const nextView = sourceIndex >= 0 ? views[sourceIndex + 1] : undefined;
    const copy = await addView(db.id, view.type, copyViewName(view), {
      config: scopedViewOwnerId
        ? cloneInlineScopedViewConfig(view.config, scopedViewOwnerId, view.id)
        : cloneViewConfig(view.config),
      position: positionBetween(view.position, nextView?.position),
    });
    if (canCreateScopedViews) {
      const nextIds = appendScopedViewId(currentScopedViewIds(), copy.id, view.id);
      onScopedViewsChange?.(nextIds, copy.id);
    }
    activateView(copy.id);
    setViewMenuId(null);
    notify(databaseViewLabels().toast.duplicatedView, "success");
    window.requestAnimationFrame(() => focusViewTab(copy.id));
  }

  async function createNewView(type = newViewType) {
    if (!canAddView) return;
    const typeLabel = NOTION_2023_VIEW_TYPES.find((item) => item.type === type)?.label ?? "Table";
    const scopedTypeLabel = databaseViewLabels().viewTypes[type] ?? typeLabel;
    const currentIndex = active ? views.findIndex((view) => view.id === active.id) : -1;
    const nextView = currentIndex >= 0 ? views[currentIndex + 1] : undefined;
    const next = await addView(db.id, type, newViewName.trim() || (scopedViewOwnerId ? scopedTypeLabel : typeLabel), {
      config: scopedViewOwnerId
        ? cloneInlineScopedViewConfig(active?.config, scopedViewOwnerId, active?.id)
        : undefined,
      position: active ? positionBetween(active.position, nextView?.position) : undefined,
    });
    if (canCreateScopedViews) {
      const nextIds = appendScopedViewId(currentScopedViewIds(), next.id, active?.id);
      onScopedViewsChange?.(nextIds, next.id);
    }
    activateView(next.id);
    closeAddViewMenu(false);
    notify(databaseViewLabels().toast.createdView, "success");
    window.requestAnimationFrame(() => focusViewTab(next.id));
  }

  async function removeView(view: DbView) {
    if (visibleViews.length <= 1) return;
    const index = visibleViews.findIndex((item) => item.id === view.id);
    const next = visibleViews[index + 1] ?? visibleViews[index - 1] ?? null;
    if (scopedViewOwnerId && !canMutateViewTab(view)) {
      const nextIds = currentScopedViewIds().filter((id) => id !== view.id);
      onScopedViewsChange?.(nextIds, next?.id ?? null);
      activateView(next?.id ?? null);
      setViewMenuId(null);
      notify(databaseViewLabels().toast.removedViewFromInline, "success");
      return;
    }
    if (!canMutateViewTab(view)) return;
    const snapshot = await deleteView(view.id);
    if (!snapshot) {
      notify(databaseViewLabels().toast.couldntDeleteView, "error");
      return;
    }
    const nextScopedIds = canCreateScopedViews
      ? currentScopedViewIds().filter((id) => id !== view.id)
      : undefined;
    if (nextScopedIds) onScopedViewsChange?.(nextScopedIds, next?.id ?? null);
    activateView(next?.id ?? null);
    setViewMenuId(null);
    notify(databaseViewLabels().toast.deletedView, "success", {
      label: "Undo",
      onClick: async () => {
        const restored = await restoreDeletedView(snapshot);
        if (!restored) {
          notify(databaseViewLabels().toast.couldntRestoreView, "error");
          return;
        }
        if (canCreateScopedViews) {
          const restoredIds = appendScopedViewId(nextScopedIds ?? currentScopedViewIds(), snapshot.id, next?.id);
          onScopedViewsChange?.(restoredIds, snapshot.id);
        }
        activateView(snapshot.id);
        notify(databaseViewLabels().toast.restoredView, "success");
        window.requestAnimationFrame(() => focusViewTab(snapshot.id));
      },
    });
    window.requestAnimationFrame(() => {
      if (next) focusViewTab(next.id);
      else addViewButtonRef.current?.focus();
    });
  }

  useEffect(() => {
    const root = dbRootRef.current;
    if (!root) return;
    function onInlineDatabaseCommand(event: Event) {
      const command = (event as CustomEvent<{ command?: string }>).detail?.command;
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      if (command === "copy-active-view-link") {
        if (!active) {
          notify(databaseViewLabels().noViewToCopy, "default");
          return;
        }
        void copyViewLink(active);
        return;
      }
      if (command === "duplicate-active-view") {
        if (!active) {
          notify(databaseViewLabels().noViewToDuplicate, "default");
          return;
        }
        void duplicateView(active);
        return;
      }
      if (command === "ensure-calendar-view") {
        const calendarView = visibleViews.find((view) => view.type === "calendar");
        if (calendarView) {
          selectView(calendarView.id);
          window.requestAnimationFrame(() => focusViewTab(calendarView.id));
          return;
        }
        if (!canAddView) {
          notify(databaseViewLabels().cannotAddCalendarView, "default");
          return;
        }
        void createNewView("calendar");
      }
    }
    root.addEventListener(INLINE_DATABASE_COMMAND_EVENT, onInlineDatabaseCommand);
    return () => root.removeEventListener(INLINE_DATABASE_COMMAND_EVENT, onInlineDatabaseCommand);
  });

  function beginViewTabDrag(viewId: string, e: ReactDragEvent<HTMLElement>) {
    if (viewTabDragReadOnly) {
      e.preventDefault();
      return;
    }
    setDraggingViewId(viewId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(VIEW_TAB_DRAG, viewId);
  }

  function updateViewTabDragTarget(viewId: string, e: ReactDragEvent<HTMLElement>) {
    if (viewTabDragReadOnly) return;
    if (!draggingViewId && !Array.from(e.dataTransfer.types).includes(VIEW_TAB_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    setDragOverViewSide(e.clientX > rect.left + rect.width / 2 ? "after" : "before");
    setDragOverViewId(viewId);
  }

  function clearViewTabDragState() {
    setDraggingViewId(null);
    setDragOverViewId(null);
    setDragOverViewSide("before");
  }

  function reorderView(sourceId: string, targetId: string, side: "before" | "after") {
    if (!sourceId || sourceId === targetId) return;
    const next = visibleViews.slice();
    const sourceIndex = next.findIndex((view) => view.id === sourceId);
    const targetIndex = next.findIndex((view) => view.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [source] = next.splice(sourceIndex, 1);
    const insertionIndex = next.findIndex((view) => view.id === targetId);
    next.splice(insertionIndex + (side === "after" ? 1 : 0), 0, source);
    if (canCreateScopedViews) {
      onScopedViewsChange?.(next.map((view) => view.id), active?.id ?? sourceId);
      clearViewTabDragState();
      return;
    }
    const editedAt = new Date().toISOString();
    next.forEach((view, index) => {
      updateView(view.id, {
        config: {
          ...(view.config ?? {}),
          viewTabOrderEditedAt: editedAt,
        },
        position: index + 1,
      });
    });
    clearViewTabDragState();
  }

  function onDatabaseKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (isComposingKeyEvent(e)) return;
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
    const target = e.target as HTMLElement | null;
    if (target?.closest(`.${styles.rowPeek}`)) return;
    e.preventDefault();
    e.stopPropagation();
    setViewMenuId(null);
    setAddOpen(false);
    setSearchFocusTick((tick) => tick + 1);
  }

  if (!metadataLoaded) return <DatabaseLoadingShell placement={placement} />;

  const activePeekId = peekId ?? renderedPeekId;
  const activePeekClosing = !peekId && !!renderedPeekId && rowPeekClosing;

  return (
    <div
      ref={dbRootRef}
      className={styles.db}
      data-placement={placement}
      data-public-read-only={publicReadOnly ? "true" : undefined}
      data-imported-notion-inline={
        hasImportedNotionInlineViews ? "true" : undefined
      }
      onKeyDown={onDatabaseKeyDown}
    >
      <div className={styles.dbChrome} data-database-chrome>
        <div
          className={styles.viewTabs}
          data-view-tabs-hidden={hideSingleInlineViewTab ? "true" : undefined}
          ref={viewTabsRef}
          role={hideSingleInlineViewTab ? undefined : "tablist"}
          aria-hidden={hideSingleInlineViewTab ? "true" : undefined}
          aria-label={hideSingleInlineViewTab ? undefined : `${databaseDisplayTitle(db)} views`}
          aria-orientation={hideSingleInlineViewTab ? undefined : "horizontal"}
        >
          {visibleViewTabs.map((v) => (
            <div
              key={v.id}
              className={styles.viewTabWrap}
              data-view-tab-wrap={v.id}
              data-active={active?.id === v.id ? "true" : undefined}
              data-drag-over={dragOverViewId === v.id ? "true" : undefined}
              data-drop-side={dragOverViewId === v.id ? dragOverViewSide : undefined}
              draggable={!viewTabDragReadOnly}
              onDragStart={(e) => beginViewTabDrag(v.id, e)}
              onDragOver={(e) => updateViewTabDragTarget(v.id, e)}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setDragOverViewId((cur) => (cur === v.id ? null : cur));
              }}
              onDrop={(e) => {
                if (viewTabDragReadOnly) return;
                e.preventDefault();
                reorderView(e.dataTransfer.getData(VIEW_TAB_DRAG) || draggingViewId || "", v.id, dragOverViewSide);
              }}
              onDragEnd={clearViewTabDragState}
            >
              <button
                className={`${styles.viewTab} ${active?.id === v.id ? styles.viewTabActive : ""}`}
                data-view-tab={v.id}
                type="button"
                draggable={!viewTabDragReadOnly}
                id={viewTabId(v.id)}
                role="tab"
                aria-label={v.name}
                aria-selected={active?.id === v.id}
                aria-controls={viewPanelId(v.id)}
                aria-haspopup={canOpenViewActionMenu(v) ? "dialog" : undefined}
                aria-expanded={viewMenuId === v.id ? true : undefined}
                tabIndex={active?.id === v.id ? 0 : -1}
                onClick={(e) => {
                  if (active?.id === v.id && canOpenViewActionMenu(v)) {
                    openViewActionMenu(v, e.currentTarget);
                    return;
                  }
                  selectView(v.id);
                }}
                onContextMenu={(e) => {
                  if (!canOpenViewActionMenu(v)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  openViewActionMenu(v, e.currentTarget);
                }}
                onDragStart={(e) => beginViewTabDrag(v.id, e)}
                onKeyDown={(e) => onViewTabKeyDown(e, v.id)}
              >
                <span className={styles.viewGlyph}>
                  <ViewTypeIcon type={v.type} />
                </span>
                <span className={styles.viewTabName} data-view-tab-name={v.id}>
                  {v.name}
                </span>
              </button>
              <button
                type="button"
                className={styles.viewTabMore}
                data-view-actions={v.id}
                aria-label={`${v.name} view actions`}
                aria-haspopup="dialog"
                aria-expanded={viewMenuId === v.id}
                tabIndex={active?.id === v.id || viewMenuId === v.id ? 0 : -1}
                disabled={!canOpenViewActionMenu(v)}
                onClick={(e) => {
                  if (!canOpenViewActionMenu(v)) return;
                  if (viewMenuId === v.id) {
                    closeViewActionMenu(true);
                    return;
                  }
                  openViewActionMenu(v, e.currentTarget);
                }}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {viewMenuId === v.id &&
                renderViewTabMenuLayer(
                  <>
                  <button
                    type="button"
                    className={styles.menuBackdrop}
                    onClick={() => closeViewActionMenu(true)}
                    tabIndex={-1}
                    aria-label="Close view actions"
                  />
                  <div
                    ref={viewActionMenuRef}
                    className={styles.viewTabMenu}
                    style={viewActionMenuStyle}
                    role="dialog"
                    aria-label={`${v.name} view actions`}
                    onKeyDown={onViewActionMenuKeyDown}
                  >
                    <ViewNameField
                      name={v.name}
                      onCommit={(name) => {
                        updateView(v.id, { name });
                        notify(databaseViewLabels().renamedView, "success");
                      }}
                      onClose={() => closeViewActionMenu(true)}
                    />
                    <button type="button" className={styles.viewMenuItem} onClick={() => openViewAsFullPage(v)}>
                      <OpenInNew size={15} aria-hidden="true" />
                      <span>{databaseViewLabels().openAsFullPage}</span>
                    </button>
                    <button type="button" className={styles.viewMenuItem} onClick={() => void copyViewLink(v)}>
                      <LinkIcon size={15} aria-hidden="true" />
                      <span>{databaseViewLabels().copyViewLink}</span>
                    </button>
                    <button type="button" className={styles.viewMenuItem} onClick={() => void duplicateView(v)}>
                      <Copy size={15} aria-hidden="true" />
                      <span>{databaseViewLabels().duplicateView}</span>
                    </button>
                    <button
                      type="button"
                      className={`${styles.viewMenuItem} ${styles.viewMenuDanger}`}
                      disabled={visibleViews.length <= 1}
                      onClick={() => void removeView(v)}
                    >
                      <Trash size={15} aria-hidden="true" />
                      <span>{databaseViewLabels().deleteView}</span>
                    </button>
                  </div>
                  </>
                )}
            </div>
          ))}
          {overflowViewTabs.length > 0 && (
            <div className={`${styles.viewTabWrap} ${styles.viewOverflowWrap}`} data-view-overflow-wrap>
              <button
                type="button"
                className={`${styles.viewTab} ${styles.viewOverflowButton}`}
                ref={viewOverflowButtonRef}
                data-view-overflow
                aria-haspopup="menu"
                aria-expanded={viewOverflowOpen}
                onClick={(e) => {
                  if (viewOverflowOpen) {
                    closeViewOverflowMenu(true);
                    return;
                  }
                  setAddOpen(false);
                  setAddViewMenuStyle(undefined);
                  setViewMenuId(null);
                  setViewActionMenuStyle(undefined);
                  setViewOverflowMenuStyle(placeViewTabMenu(e.currentTarget, 220));
                  setViewOverflowOpen(true);
                }}
              >
                {databaseViewLabels().moreViews(overflowViewTabs.length)}
                <ChevronDown size={13} aria-hidden="true" />
              </button>
              {viewOverflowOpen &&
                renderViewTabMenuLayer(
                  <>
                  <button
                    type="button"
                    className={styles.menuBackdrop}
                    onClick={() => closeViewOverflowMenu(true)}
                    tabIndex={-1}
                    aria-label="Close hidden views"
                  />
                  <div
                    ref={viewOverflowMenuRef}
                    className={styles.viewTabMenu}
                    style={viewOverflowMenuStyle}
                    role="menu"
                    tabIndex={-1}
                    aria-label="Hidden views"
                    onKeyDown={onViewOverflowMenuKeyDown}
                  >
                    {overflowViewTabs.map((view) => (
                      <button
                        key={view.id}
                        type="button"
                        className={styles.viewMenuItem}
                        role="menuitemradio"
                        aria-checked={active?.id === view.id}
                        onClick={() => {
                          selectView(view.id);
                          window.requestAnimationFrame(() => focusViewTab(view.id));
                        }}
                      >
                        <ViewTypeIcon type={view.type} size={15} />
                        <span>{view.name}</span>
                        {active?.id === view.id && <CheckIcon size={13} aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                  </>
                )}
            </div>
          )}
          {canAddView && (
            <div className={styles.addViewWrap} data-view-add-wrap>
              <button
                type="button"
                className={styles.addView}
                ref={addViewButtonRef}
                aria-label={
                  scopedViewOwnerId
                    ? databaseViewLabels().addNewView
                    : visibleViews.length === 0
                      ? "Add a view"
                      : "Add view"
                }
                aria-haspopup="dialog"
                aria-expanded={addOpen}
                disabled={!canAddView}
                onClick={(e) => {
                  if (!canAddView) return;
                  if (addOpen) {
                    closeAddViewMenu(true);
                    return;
                  }
                  openAddViewMenu(e.currentTarget);
                }}
              >
                <Plus size={15} aria-hidden="true" /> {visibleViews.length === 0 ? "Add a view" : ""}
              </button>
              {renderAddViewMenuLayer()}
            </div>
          )}
        </div>

        <div
          id={tableSelectionChromeSlotId}
          className={styles.tableSelectionChromeSlot}
          data-table-selection-chrome-slot
          aria-live="polite"
        />
        {active && (
          <DatabaseToolbar
            key={active.id}
            dbId={db.id}
            view={active}
            compactImportedInline={placement === "inline"}
            readOnly={readOnly}
            search={activeSearch}
            searchFocusTick={searchFocusTick}
            contextPageId={contextPageId}
            onSearchChange={setActiveSearch}
            onOpenRow={openRowPeek}
          />
        )}
      </div>

      <div
        className={styles.viewBody}
        id={active ? viewPanelId(active.id) : undefined}
        role="tabpanel"
        aria-labelledby={activeTabIsRendered ? viewTabId(active.id) : undefined}
      >
        {!active && <div className={styles.dbLoading} />}
        {active?.type === "table" && (
          <TableView
            db={db}
            view={active}
            rows={rows}
            rowQuery={activeRowsQuery}
            readOnly={readOnly}
            search={activeSearch}
            loadingRows={!metadataLoaded || rowsLoading}
            placement={placement}
            contextPageId={contextPageId}
            selectionChromeSlotId={tableSelectionChromeSlotId}
            publishAwareness={publishAwareness}
            remoteAwarenessByBlock={remoteAwarenessByBlock}
            onOpenRow={openRowPeek}
            onEditRowProperties={openRowPropertiesMenu}
            onOpenRowIn={openRowInMode}
            onWarmRow={warmRowDetail}
          />
        )}
        {active?.type === "board" && (
          <BoardView
            db={db}
            view={active}
            rows={rows}
            readOnly={readOnly}
            search={activeSearch}
            contextPageId={contextPageId}
            onOpenRow={openRowPeek}
            onEditRowProperties={openRowPropertiesMenu}
            onOpenRowIn={openRowInMode}
          />
        )}
        {active?.type === "list" && (
          <ListView
            db={db}
            view={active}
            rows={rows}
            readOnly={readOnly}
            search={activeSearch}
            contextPageId={contextPageId}
            onOpenRow={openRowPeek}
            onEditRowProperties={openRowPropertiesMenu}
            onOpenRowIn={openRowInMode}
          />
        )}
        {active?.type === "gallery" && (
          <GalleryView
            db={db}
            view={active}
            rows={rows}
            readOnly={readOnly}
            search={activeSearch}
            contextPageId={contextPageId}
            onOpenRow={openRowPeek}
            onEditRowProperties={openRowPropertiesMenu}
            onOpenRowIn={openRowInMode}
          />
        )}
        {active?.type === "calendar" && (
          <CalendarView
            db={db}
            view={active}
            rows={rows}
            readOnly={readOnly}
            search={activeSearch}
            contextPageId={contextPageId}
            onOpenRow={openRowPeek}
            onEditRowProperties={openRowPropertiesMenu}
            onOpenRowIn={openRowInMode}
          />
        )}
        {active?.type === "timeline" && (
          <TimelineView
            db={db}
            view={active}
            rows={rows}
            readOnly={readOnly}
            search={activeSearch}
            contextPageId={contextPageId}
            onOpenRow={openRowPeek}
            onEditRowProperties={openRowPropertiesMenu}
            onOpenRowIn={openRowInMode}
          />
        )}
        {active?.type === "chart" && (
          <ChartView
            db={db}
            view={active}
            rows={rows}
            readOnly={readOnly}
            search={activeSearch}
            contextPageId={contextPageId}
          />
        )}
        {/* Genuinely unsupported (unknown) view types keep the imported
            placeholder instead of rendering nothing. */}
        {active && !isRenderableDatabaseView(active) && <ImportedUnsupportedView view={active} />}
        {active &&
          active.type !== "table" &&
          activeRowsQuery &&
          activeRowPage?.hasMore && (
            <button
              type="button"
              className={styles.viewLoadMore}
              data-view-load-more
              disabled={activeRowPage.loadingMore}
              onClick={() => void loadMoreDatabaseRows(db.id, activeRowsQuery)}
            >
              <ArrowDown size={14} aria-hidden="true" />
              {activeRowPage.loadingMore ? databaseViewLabels().loadingMore : databaseViewLabels().loadMore}
            </button>
          )}
      </div>
      {activePeekId && (
        <RowPeek
          dbId={db.id}
          pageId={activePeekId}
          view={active}
          mode={activeOpenPageIn === "center" ? "center" : "side"}
          openPropertiesTick={
            rowPropertiesMenuRequest?.pageId === activePeekId ? rowPropertiesMenuRequest.tick : 0
          }
          rowIds={visibleRowIds}
          closing={activePeekClosing}
          readOnly={readOnly}
          publicReadOnly={publicReadOnly}
          sharedToken={sharedToken}
          onClose={closeRowPeek}
          onOpenPage={(targetPageId) =>
            router.push(
              publicReadOnly && sharedToken ? sharedPageHref(sharedToken, targetPageId) : pageHref(targetPageId)
            )
          }
          onSwitchRow={switchRowPeek}
        />
      )}
    </div>
  );
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return !!target.closest('[contenteditable="true"], [role="textbox"]');
}

function rowPeekBlockSearchText(block: {
  plainText?: string;
  content?: {
    rich?: TextSpan[];
    caption?: TextSpan[];
    expression?: string;
    fileName?: string;
    table?: string[][];
  };
}) {
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

const EMPTY_ROW_PEEK_BLOCKS: Block[] = [];
const ROW_PEEK_WIDTH_KEY = "notionlike:row-peek-side-width:v2";
const ROW_PEEK_FALLBACK_WIDTH = 640;
const ROW_PEEK_MIN_WIDTH = 420;
const ROW_PEEK_VIEWPORT_GAP = 80;
const ROW_PEEK_DEFAULT_VIEWPORT_RATIO = 0.5;
const ROW_PEEK_EXIT_MS = 220;
const ROW_PEEK_TOGGLE_BLOCK_TYPES = new Set<BlockType>([
  "toggle",
  "toggle_heading_1",
  "toggle_heading_2",
  "toggle_heading_3",
]);

function rowPeekMaxWidth() {
  if (typeof window === "undefined") return ROW_PEEK_FALLBACK_WIDTH;
  return Math.max(ROW_PEEK_MIN_WIDTH, window.innerWidth - ROW_PEEK_VIEWPORT_GAP);
}

function clampRowPeekWidth(width: number) {
  return Math.min(Math.max(Math.round(width), ROW_PEEK_MIN_WIDTH), rowPeekMaxWidth());
}

function rowPeekDefaultWidth() {
  if (typeof window === "undefined") return ROW_PEEK_FALLBACK_WIDTH;
  return clampRowPeekWidth(window.innerWidth * ROW_PEEK_DEFAULT_VIEWPORT_RATIO);
}

function storedRowPeekWidth() {
  const fallback = rowPeekDefaultWidth();
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(ROW_PEEK_WIDTH_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(parsed) ? clampRowPeekWidth(parsed) : fallback;
}

function RowPeek({
  dbId,
  pageId,
  view,
  mode,
  openPropertiesTick = 0,
  rowIds,
  closing = false,
  readOnly: inheritedReadOnly = false,
  publicReadOnly = false,
  sharedToken,
  onClose,
  onOpenPage,
  onSwitchRow,
}: {
  dbId: string;
  pageId: string;
  view?: DbView | null;
  mode: "side" | "center";
  openPropertiesTick?: number;
  rowIds: string[];
  closing?: boolean;
  readOnly?: boolean;
  publicReadOnly?: boolean;
  sharedToken?: string;
  onClose: () => void;
  onOpenPage: (pageId: string) => void;
  onSwitchRow: (pageId: string) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const findRootRef = useRef<HTMLDivElement>(null);
  const page = useStore((s) => s.pagesById[pageId]);
  const dbPage = useStore((s) => s.pagesById[dbId]);
  const blocks = useStore((s) => s.blocksByPage[pageId] ?? EMPTY_ROW_PEEK_BLOCKS);
  const ready = useStore((s) => s.ready);
  const loadBlocks = useStore((s) => s.loadBlocks);
  const loadComments = useStore((s) => s.loadComments);
  const openComments = useStore((s) => s.openComments);
  const updatePage = useStore((s) => s.updatePage);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const notify = useStore((s) => s.notify);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const dbPageRef = useRef(dbPage);
  const resizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const sideWidthRef = useRef(rowPeekDefaultWidth());
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocusTick, setFindFocusTick] = useState(0);
  const [findInitialQuery, setFindInitialQuery] = useState("");
  const [sideWidth, setSideWidth] = useState(storedRowPeekWidth);
  const [resizingSide, setResizingSide] = useState(false);
  const [entered, setEntered] = useState(false);
  const commentCount = useStore(
    (s) => s.commentsByPage[pageId]?.filter((comment) => !comment.parentId && !comment.resolved).length ?? 0
  );
  const findRevision = useMemo(
    () => [page?.title ?? "", ...blocks.map((block) => `${block.id}:${rowPeekBlockSearchText(block)}`)].join("\u0000"),
    [blocks, page?.title],
  );
  const rowIndex = rowIds.indexOf(pageId);
  const previousRowId = rowIndex > 0 ? rowIds[rowIndex - 1] : null;
  const nextRowId = rowIndex >= 0 && rowIndex < rowIds.length - 1 ? rowIds[rowIndex + 1] : null;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!ready) return;
    void loadBlocks(pageId);
    void loadComments(pageId);
  }, [ready, pageId, loadBlocks, loadComments]);

  useEffect(() => {
    dbPageRef.current = dbPage;
  }, [dbPage]);

  useEffect(() => {
    if (!page) return;
    setDocumentChrome({
      title: `${pageDisplayTitle(page)} - Hanji`,
      iconHref: pageFaviconHref(page),
    });
  }, [page]);

  useEffect(() => {
    return () => {
      const parentPage = dbPageRef.current;
      setDocumentChrome({
        title: parentPage ? `${pageDisplayTitle(parentPage)} - Hanji` : "Hanji",
        iconHref: pageFaviconHref(parentPage),
      });
    };
  }, []);

  // Lock background scroll while the peek overlay is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus();
      setMenuAnchor(null);
      setFindOpen(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pageId]);

  useEffect(() => {
    sideWidthRef.current = sideWidth;
  }, [sideWidth]);

  useEffect(() => {
    const onResize = () => {
      const next = clampRowPeekWidth(sideWidthRef.current);
      sideWidthRef.current = next;
      setSideWidth(next);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!resizingSide) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (event: PointerEvent) => {
      if (!resizeStartRef.current) return;
      const next = clampRowPeekWidth(
        resizeStartRef.current.startWidth + resizeStartRef.current.startX - event.clientX
      );
      sideWidthRef.current = next;
      setSideWidth(next);
    };
    const endResize = () => {
      setResizingSide(false);
      resizeStartRef.current = null;
      window.localStorage.setItem(ROW_PEEK_WIDTH_KEY, String(sideWidthRef.current));
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endResize, { once: true });
    window.addEventListener("pointercancel", endResize, { once: true });
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endResize);
      window.removeEventListener("pointercancel", endResize);
    };
  }, [resizingSide]);

  useEffect(() => {
    let clearTimer: number | undefined;
    let frame: number | undefined;

    function scrollToHashBlock() {
      let hashId = "";
      try {
        hashId = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        hashId = window.location.hash.slice(1);
      }
      if (!hashId.startsWith(HASH_BLOCK_PREFIX)) return;

      const blockId = hashId.slice(HASH_BLOCK_PREFIX.length);
      const st = useStore.getState();
      const pageBlocks = st.blocksByPage[pageId] ?? [];
      const byId = new Map(pageBlocks.map((candidate) => [candidate.id, candidate]));
      if (!byId.has(blockId)) return;

      let current = byId.get(blockId);
      while (current?.parentId) {
        const parent = byId.get(current.parentId);
        if (!parent) break;
        if (ROW_PEEK_TOGGLE_BLOCK_TYPES.has(parent.type) && parent.content?.collapsed) {
          st.updateBlock(
            parent.id,
            { content: { ...parent.content, collapsed: false } },
            { history: false }
          );
        }
        current = parent;
      }

      function scrollWhenRendered(attempt = 0) {
        const target = document.getElementById(hashId);
        if (!target) {
          if (attempt < 30) frame = window.requestAnimationFrame(() => scrollWhenRendered(attempt + 1));
          return;
        }
        document
          .querySelectorAll(".blockLinkTarget")
          .forEach((el) => el.classList.remove("blockLinkTarget"));
        target.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
        target.classList.add("blockLinkTarget");
        if (clearTimer) window.clearTimeout(clearTimer);
        clearTimer = window.setTimeout(() => {
          target.classList.remove("blockLinkTarget");
        }, 1800);
      }

      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => scrollWhenRendered());
    }

    scrollToHashBlock();
    window.addEventListener("hashchange", scrollToHashBlock);
    return () => {
      window.removeEventListener("hashchange", scrollToHashBlock);
      if (frame) window.cancelAnimationFrame(frame);
      if (clearTimer) window.clearTimeout(clearTimer);
    };
  }, [blocks.length, pageId]);

  function focusableItems() {
    return Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter((element) => element.offsetParent !== null);
  }

  function onPanelKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.defaultPrevented) return;
    if (isComposingKeyEvent(e)) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      setMenuAnchor(null);
      setFindInitialQuery(selectedTextForPageFind(findRootRef.current));
      setFindOpen(true);
      setFindFocusTick((tick) => tick + 1);
      return;
    }
    if (
      (!publicReadOnly || sharedToken) &&
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key === "Enter" &&
      !isEditableTarget(e.target)
    ) {
      e.preventDefault();
      e.stopPropagation();
      onOpenPage(pageId);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (menuAnchor) {
        setMenuAnchor(null);
        window.requestAnimationFrame(() => menuButtonRef.current?.focus());
        return;
      }
      onClose();
      return;
    }
    if (!isEditableTarget(e.target)) {
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        switchRow(previousRowId);
        return;
      }
      if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        switchRow(nextRowId);
        return;
      }
    }
    if (e.key !== "Tab") return;

    const items = focusableItems();
    if (items.length === 0) {
      e.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!page) return null;
  const rowLocked = !!page.isLocked;
  const readOnly = inheritedReadOnly || rowLocked;
  const rowTitle = pageDisplayTitle(page);
  const canOpenRowPage = !publicReadOnly || !!sharedToken;
  const openAsPageShortcut =
    typeof navigator !== "undefined" && navigator.platform.includes("Mac")
      ? "⌘Enter"
      : "Ctrl+Enter";

  async function copyRowLink() {
    const ok = await copyText(
      publicReadOnly && sharedToken ? absoluteSharedPageUrl(sharedToken, pageId) : absolutePageUrl(pageId)
    );
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 1200);
    notify(
      ok ? databaseViewLabels().linkCopiedToast : databaseViewLabels().copyLinkFailed,
      ok ? "success" : "error"
    );
  }

  async function toggleRowFavorite() {
    const wasFavorite = !!page.isFavorite;
    try {
      await toggleFavorite(pageId);
      notify(
        wasFavorite ? databaseViewLabels().removedFromFavorites : databaseViewLabels().addedToFavorites,
        "success"
      );
    } catch {
      notify(databaseViewLabels().updateFavoritesFailed, "error");
    }
  }

  function unlockRow() {
    updatePage(page.id, { isLocked: false });
    notify(databaseViewLabels().toast.pageUnlocked, "success");
  }

  function switchRow(nextPageId: string | null) {
    if (!nextPageId || nextPageId === pageId) return;
    setMenuAnchor(null);
    setCopied(false);
    onSwitchRow(nextPageId);
  }

  function commitSideWidth(next: number) {
    const width = clampRowPeekWidth(next);
    sideWidthRef.current = width;
    setSideWidth(width);
    window.localStorage.setItem(ROW_PEEK_WIDTH_KEY, String(width));
  }

  function startSideResize(e: ReactPointerEvent<HTMLDivElement>) {
    if (mode !== "side" || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeStartRef.current = { startX: e.clientX, startWidth: sideWidthRef.current };
    setResizingSide(true);
  }

  function onResizeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (mode !== "side") return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 80 : 24;
    if (e.key === "ArrowLeft") commitSideWidth(sideWidthRef.current + step);
    else if (e.key === "ArrowRight") commitSideWidth(sideWidthRef.current - step);
    else if (e.key === "Home") commitSideWidth(ROW_PEEK_MIN_WIDTH);
    else if (e.key === "End") commitSideWidth(rowPeekMaxWidth());
  }

  const rowPeekStyle =
    mode === "side"
      ? ({ "--row-peek-width": `${sideWidth}px` } as CSSProperties)
      : undefined;
  const motionState = closing ? "closing" : entered ? "open" : "opening";

  const peek = (
    <>
      <button
        type="button"
        className={styles.rowPeekBackdrop}
        data-mode={mode}
        data-row-peek-backdrop
        data-motion-state={motionState}
        onClick={onClose}
        disabled={closing}
        tabIndex={-1}
        aria-label="Close database row preview"
      />
      <aside
        ref={panelRef}
        className={styles.rowPeek}
        data-mode={mode}
        data-row-peek-panel
        data-motion-state={motionState}
        data-resizing={resizingSide ? "true" : undefined}
        style={rowPeekStyle}
        role="dialog"
        aria-modal="true"
        aria-label={`${rowTitle} preview`}
        aria-hidden={closing ? true : undefined}
        inert={closing ? true : undefined}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        {mode === "side" && (
          <div
            className={styles.rowPeekResizeHandle}
            role="separator"
            tabIndex={0}
            title="Resize side preview"
            aria-label="Resize side preview"
            aria-orientation="vertical"
            aria-valuemin={ROW_PEEK_MIN_WIDTH}
            aria-valuemax={rowPeekMaxWidth()}
            aria-valuenow={sideWidth}
            onPointerDown={startSideResize}
            onKeyDown={onResizeKeyDown}
          />
        )}
        <PageFindBar
          focusTick={findFocusTick}
          initialQuery={findInitialQuery}
          onClose={() => setFindOpen(false)}
          open={findOpen}
          pageId={pageId}
          revision={findRevision}
          rootRef={findRootRef}
        />
        <div className={styles.rowPeekTop}>
          <div
            className={styles.rowPeekChromeSide}
            data-row-peek-chrome-side
            aria-label={databaseViewLabels().peekOptions(rowTitle)}
          >
            <button
              type="button"
              className={styles.rowPeekIconAction}
              data-row-peek-close="side-rail"
              title={databaseViewLabels().closePeek(rowTitle)}
              aria-label={databaseViewLabels().closePeek(rowTitle)}
              onClick={onClose}
            >
              <DoubleChevronRight size={16} aria-hidden="true" />
            </button>
            {canOpenRowPage && (
              <button
                type="button"
                className={styles.rowPeekIconAction}
                data-row-peek-open-page
                data-row-peek-open-page-glyph="arrow-square-out"
                title={`${databaseViewLabels().openAsPage(rowTitle)} (${openAsPageShortcut})`}
                aria-label={databaseViewLabels().openAsPage(rowTitle)}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey) {
                    if (publicReadOnly && sharedToken) openSharedPageInNewTab(sharedToken, pageId);
                    else openPageInNewTab(pageId);
                    return;
                  }
                  onOpenPage(pageId);
                }}
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  if (publicReadOnly && sharedToken) openSharedPageInNewTab(sharedToken, pageId);
                  else openPageInNewTab(pageId);
                }}
              >
                <OpenAsPage size={15} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className={styles.rowPeekActions} data-row-peek-actions>
            {rowLocked && !inheritedReadOnly && (
              <button
                type="button"
                className={`${styles.rowPeekLockPill} ${styles.rowPeekShareAction}`}
                title={databaseViewLabels().unlock(rowTitle)}
                aria-label={databaseViewLabels().unlock(rowTitle)}
                onClick={unlockRow}
              >
                <LockIcon size={14} aria-hidden="true" />
                <span>{databaseViewLabels().locked}</span>
              </button>
            )}
            {canOpenRowPage && (
              <>
                {!publicReadOnly && (
                  <button
                    type="button"
                    className={styles.rowPeekIconAction}
                    title={
                      commentCount
                        ? databaseViewLabels().openComments(rowTitle, commentCount)
                        : databaseViewLabels().addCommentTo(rowTitle)
                    }
                    aria-label={
                      commentCount
                        ? databaseViewLabels().openComments(rowTitle, commentCount)
                        : databaseViewLabels().addCommentTo(rowTitle)
                    }
                    onClick={() => openComments(pageId)}
                  >
                    <CommentIcon size={15} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className={styles.rowPeekShareAction}
                  title={copied ? databaseViewLabels().linkCopied(rowTitle) : databaseViewLabels().copyShareLink(rowTitle)}
                  aria-label={copied ? databaseViewLabels().linkCopied(rowTitle) : databaseViewLabels().copyShareLink(rowTitle)}
                  onClick={() => void copyRowLink()}
                >
                  <LockIcon size={14} aria-hidden="true" />
                  <span>{databaseViewLabels().share}</span>
                </button>
                <button
                  type="button"
                  className={styles.rowPeekIconAction}
                  title={copied ? databaseViewLabels().linkCopied(rowTitle) : databaseViewLabels().copyLink(rowTitle)}
                  aria-label={copied ? databaseViewLabels().linkCopied(rowTitle) : databaseViewLabels().copyLink(rowTitle)}
                  onClick={() => void copyRowLink()}
                >
                  <LinkIcon size={16} aria-hidden="true" />
                </button>
              </>
            )}
            {!publicReadOnly && (
              <>
                <button
                  type="button"
                  className={styles.rowPeekIconAction}
                  title={
                    page.isFavorite
                      ? databaseViewLabels().removeFromFavorites(rowTitle)
                      : databaseViewLabels().addToFavorites(rowTitle)
                  }
                  aria-label={
                    page.isFavorite
                      ? databaseViewLabels().removeFromFavorites(rowTitle)
                      : databaseViewLabels().addToFavorites(rowTitle)
                  }
                  onClick={() => void toggleRowFavorite()}
                >
                  {page.isFavorite ? (
                    <StarFilled size={17} aria-hidden="true" />
                  ) : (
                    <Star size={17} aria-hidden="true" />
                  )}
                </button>
                <button
                  ref={menuButtonRef}
                  type="button"
                  className={styles.rowPeekIconAction}
                  title={databaseViewLabels().openActions(rowTitle)}
                  aria-label={databaseViewLabels().openActions(rowTitle)}
                  aria-haspopup="menu"
                  aria-expanded={!!menuAnchor}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMenuAnchor((current) =>
                      current ? null : { x: rect.left, y: rect.bottom }
                    );
                  }}
                >
                  <DotsHorizontal size={16} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        </div>
        {menuAnchor && !publicReadOnly && (
          <RowMenu
            pageId={pageId}
            anchor={menuAnchor}
            onClose={() => {
              setMenuAnchor(null);
              window.requestAnimationFrame(() => menuButtonRef.current?.focus());
            }}
          />
        )}
        <div className={`${styles.rowPeekScroll} nscroll`}>
          <PageCover pageId={pageId} compact readOnly={readOnly} />
          <div
            ref={findRootRef}
            className={styles.rowPeekDoc}
            data-has-cover={!!page.cover}
            data-row-page="true"
            data-row-peek-search-root
          >
            <PageHeader pageId={pageId} readOnly={readOnly} publicReadOnly={publicReadOnly} />
            <RowProperties
              dbId={dbId}
              row={page}
              view={view ?? undefined}
              openCustomizeTick={openPropertiesTick}
              readOnly={readOnly}
              onOpenPage={onOpenPage}
              pageHrefForRelation={(targetPageId) =>
                publicReadOnly && sharedToken
                  ? sharedPageHref(sharedToken, targetPageId)
                  : pageHref(targetPageId)
              }
              relationNavigation={!publicReadOnly}
              showBackReferences={false}
              showPropertyControls={false}
            />
            <div className={styles.rowPeekEditor}>
              <Editor
                pageId={pageId}
                readOnly={readOnly}
                publicReadOnly={publicReadOnly}
                sharedToken={sharedToken}
                showPageStarter={false}
                emptyBodyPrompt={publicReadOnly ? undefined : templateBodyPlaceholder()}
                skipRemoteLoad={publicReadOnly}
              />
            </div>
          </div>
        </div>
      </aside>
    </>
  );

  return typeof document === "undefined" ? peek : createPortal(peek, document.body);
}

type ToolbarMenu =
  | "settings"
  | "layout"
  | "group"
  | "properties"
  | "sourceProperties"
  | "filter"
  | "sort"
  | "templates";

function toolbarMenuWidth(menu: ToolbarMenu) {
  if (menu === "settings") return 276;
  if (menu === "layout") return 560;
  if (menu === "group") return 320;
  if (menu === "properties") return 360;
  if (menu === "sourceProperties") return 320;
  if (menu === "filter" || menu === "sort") return 520;
  return 360;
}

function placeToolbarMenu(trigger: HTMLElement, menu: ToolbarMenu): CSSProperties {
  const margin = 8;
  const rect = trigger.getBoundingClientRect();
  const width = Math.max(240, Math.min(toolbarMenuWidth(menu), window.innerWidth - margin * 2));
  const preferredLeft = menu === "templates" ? rect.right - width : rect.left;
  const left = Math.min(
    Math.max(margin, preferredLeft),
    Math.max(margin, window.innerWidth - width - margin)
  );
  const top = Math.max(margin, Math.min(rect.bottom + 8, window.innerHeight - margin - 180));
  return {
    position: "fixed",
    top,
    right: "auto",
    left,
    width,
    maxWidth: `calc(100vw - ${margin * 2}px)`,
    maxHeight: Math.max(180, window.innerHeight - top - margin),
  };
}

function isVisibleToolbarItem(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function DatabaseToolbar({
  dbId,
  view,
  compactImportedInline = false,
  readOnly = false,
  search,
  searchFocusTick = 0,
  contextPageId,
  onSearchChange,
  onOpenRow,
}: {
  dbId: string;
  view: DbView;
  compactImportedInline?: boolean;
  readOnly?: boolean;
  search: string;
  searchFocusTick?: number;
  contextPageId?: string;
  onSearchChange: (search: string) => void;
  onOpenRow?: (pageId: string) => void;
}) {
  const props = useStore(useShallow((s) => s.dbProperties(dbId)));
  const templates = useStore(useShallow((s) => s.dbTemplates(dbId)));
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const updateView = useStore((s) => s.updateView);
  const addProperty = useStore((s) => s.addProperty);
  const updateProperty = useStore((s) => s.updateProperty);
  const deleteProperty = useStore((s) => s.deleteProperty);
  const restoreDeletedProperty = useStore((s) => s.restoreDeletedProperty);
  const notify = useStore((s) => s.notify);
  const addRow = useStore((s) => s.addRow);
  const setRowProperty = useStore((s) => s.setRowProperty);
  const updatePage = useStore((s) => s.updatePage);
  const addTemplate = useStore((s) => s.addTemplate);
  const duplicateTemplate = useStore((s) => s.duplicateTemplate);
  const updateTemplate = useStore((s) => s.updateTemplate);
  const deleteTemplate = useStore((s) => s.deleteTemplate);
  const restoreDeletedTemplate = useStore((s) => s.restoreDeletedTemplate);
  const [open, setOpen] = useState<ToolbarMenu | null>(null);
  const [toolbarMenuStyle, setToolbarMenuStyle] = useState<CSSProperties | undefined>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [pendingRuleFocus, setPendingRuleFocus] = useState<"filter" | "sort" | null>(null);
  const [propertiesReturnMenu, setPropertiesReturnMenu] = useState<ToolbarMenu | null>(null);
  const [sourcePropertyDetailId, setSourcePropertyDetailId] = useState<string | null>(null);
  const [sourcePropertyCreateOpen, setSourcePropertyCreateOpen] = useState(false);
  const [draggingPropertyId, setDraggingPropertyId] = useState<string | null>(null);
  const [dragOverPropertyId, setDragOverPropertyId] = useState<string | null>(null);
  const [dragOverPropertySide, setDragOverPropertySide] = useState<"before" | "after">("before");
  const toolbarRootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toolbarMenuRef = useRef<HTMLDivElement>(null);
  const activeToolbarButtonRef = useRef<HTMLElement | null>(null);
  const { confirmPropertyTypeChange, typeChangeConfirmDialog } = usePropertyTypeChangeConfirm();
  const filterTree = readFilterTree(view.config);
  const filterCount = countLeaves(filterTree);
  const hasFilterTerms = filterCount > 0 || (filterTree.groups?.length ?? 0) > 0;
  const sorts = view.config?.sorts ?? [];
  const [propertySearch, setPropertySearch] = useState("");
  const [templateSearch, setTemplateSearch] = useState("");
  const templateSearchRef = useRef<HTMLInputElement>(null);
  const orderedProps = orderViewProperties(props, view);
  const queryableProps = props.filter(isQueryableProperty);
  const hasActiveFilterTerms = hasFilterTerms;
  const hiddenIds = new Set(view.config?.hiddenProperties ?? []);
  const titlePropertyId = props.find((p) => p.type === "title")?.id;
  const visibleIds = new Set(
    view.config?.visibleProperties ?? props.filter((p) => !hiddenIds.has(p.id)).map((p) => p.id)
  );
  const hiddenCount = props.filter((p) => p.type !== "title" && !visibleIds.has(p.id)).length;
  const propertySearchTerms = searchTerms(propertySearch);
  const sourcePropertyDetail = props.find((prop) => prop.id === sourcePropertyDetailId);
  const sourcePropertyEditorProps = propertySearchTerms.length > 0
    ? props.filter((prop) => {
        const haystack = `${prop.name} ${propertyTypeLabel(prop)} ${prop.description ?? ""}`.toLowerCase();
        return propertySearchTerms.every((term) => haystack.includes(term));
      })
    : props;
  const filteredOrderedProps = propertySearchTerms.length > 0
    ? orderedProps.filter((prop) => {
        const haystack = `${prop.name} ${propertyTypeLabel(prop)} ${prop.description ?? ""}`.toLowerCase();
        return propertySearchTerms.every((term) => haystack.includes(term));
      })
    : orderedProps;
  const visibleFilteredProps = filteredOrderedProps.filter(
    (prop) => prop.type === "title" || visibleIds.has(prop.id)
  );
  const hiddenFilteredProps = filteredOrderedProps.filter(
    (prop) => prop.type !== "title" && !visibleIds.has(prop.id)
  );
  const isCardView = view.type === "board" || view.type === "gallery";
  const isCalendarView = view.type === "calendar";
  const isTimelineView = view.type === "timeline";
  const isBoardView = view.type === "board";
  const dateProps = props.filter((prop) => prop.type === "date");
  const coverProps = props.filter(isCoverProperty);
  const groupProps = props.filter((prop) => prop.type === "select" || prop.type === "status");
  const activeGroupProp =
    groupProps.find((prop) => prop.id === view.config?.groupBy) ?? groupProps[0];
  const activeTimelineStartId =
    view.config?.timelineBy ?? view.config?.calendarBy ?? dateProps[0]?.id;
  const coverPropertyOptions = [
    { value: CARD_PREVIEW_PAGE, label: databaseViewLabels().pageCover },
    { value: CARD_PREVIEW_NONE, label: databaseViewLabels().none },
    ...coverProps.map((prop) => ({
      value: prop.id,
      label: prop.name || "Untitled",
      icon: <PropertyTypeIcon type={prop.type} size={14} />,
    })),
  ];
  const cardPreviewValue = isBoardView
    ? view.config?.coverProperty ?? CARD_PREVIEW_NONE
    : cardPreviewMode(view.config?.coverProperty);
  const datePropertyOptions =
    dateProps.length > 0
      ? dateProps.map((prop) => ({
          value: prop.id,
          label: prop.name || "Untitled",
          icon: <PropertyTypeIcon type={prop.type} size={14} />,
        }))
      : [{ value: "", label: databaseViewLabels().noDateProperties, disabled: true }];
  const timelineEndPropertyOptions = [
    { value: "", label: databaseViewLabels().none },
    ...dateProps
      .filter((prop) => prop.id !== activeTimelineStartId)
      .map((prop) => ({
        value: prop.id,
        label: prop.name || "Untitled",
        icon: <PropertyTypeIcon type={prop.type} size={14} />,
      })),
  ];
  const layoutActive =
    !!view.config?.wrap ||
    !!view.config?.fitImage ||
    !!view.config?.calendarLayout ||
    !!view.config?.cardSize ||
    !!view.config?.coverProperty ||
    !!view.config?.calendarBy ||
    !!view.config?.timelineBy ||
    !!view.config?.timelineEndBy ||
    !!view.config?.timelineZoom ||
    !!view.config?.timelineShowTable ||
    !!view.config?.timelineLoadLimit ||
    !!view.config?.openPageIn ||
    !!view.config?.rowHeight ||
    !!view.config?.initialLoadLimit;
  const showLayoutOptions = !compactImportedInline;
  const showDirectProperties = !compactImportedInline;
  const openPageIn = effectiveOpenPageIn(view);
  const rowHeight = view.config?.rowHeight ?? "medium";
  const initialLoadLimit = tableInitialLoadLimit(view);
  const timelineLimit = timelineLoadLimit(view);
  const defaultTemplate = templates.find((template) => template.isDefault);
  const newPageLabel = compactImportedInline ? databaseViewLabels().toolbarNew : "New";
  const editingTemplate = templates.find((template) => template.id === editingTemplateId);
  const templateSearchTerms = searchTerms(templateSearch);
  const filteredTemplates =
    templateSearchTerms.length > 0
      ? templates.filter((template) => {
          const haystack = `${templateNameValue(template)} ${templateTitleValue(template)}`.toLowerCase();
          return templateSearchTerms.every((term) => haystack.includes(term));
        })
      : templates;

  function updateConfig(config: Partial<DbView["config"]>) {
    if (readOnly) return;
    updateView(view.id, { config: { ...view.config, ...config } });
  }

  function updateViewType(type: ViewType) {
    if (readOnly) return;
    if (type === view.type) return;
    updateView(view.id, { type });
  }

  // Single immutable writer for the whole filter tree. Clears the legacy flat
  // `filters`/`filterConjunction` so `filterGroup` is unambiguously the source of
  // truth (applyView prefers it regardless, but this keeps configs clean).
  function setFilterTree(next: FilterGroup) {
    if (readOnly) return;
    updateView(view.id, {
      config: {
        ...view.config,
        filterGroup: next,
        filters: undefined,
        filterConjunction: undefined,
        quickFilters: undefined,
      },
    });
  }

  function setSorts(next: ViewSort[]) {
    if (readOnly) return;
    updateView(view.id, { config: { ...view.config, sorts: next } });
  }

  function handleSearchChange(next: string) {
    onSearchChange(next);
  }
  function clearSearchNow() {
    onSearchChange("");
  }

  const closeToolbarMenu = useCallback((restoreFocus = false) => {
    setOpen(null);
    setToolbarMenuStyle(undefined);
    setPropertySearch("");
    setPropertiesReturnMenu(null);
    setSourcePropertyDetailId(null);
    setSourcePropertyCreateOpen(false);
    setTemplateSearch("");
    clearPropertyDragState();
    if (restoreFocus) {
      window.requestAnimationFrame(() => activeToolbarButtonRef.current?.focus());
    }
  }, []);

  function toggleMenu(menu: ToolbarMenu, trigger: HTMLButtonElement) {
    if (readOnly) return;
    setSearchOpen(false);
    const propertyMenuOpening = menu === "properties" || menu === "sourceProperties";
    const propertyMenuAlreadyOpen = open === "properties" || open === "sourceProperties";
    if (!propertyMenuOpening || !propertyMenuAlreadyOpen) setPropertySearch("");
    if (menu !== "sourceProperties") {
      setSourcePropertyDetailId(null);
      setSourcePropertyCreateOpen(false);
    }
    if (menu !== "templates" || open !== "templates") setTemplateSearch("");
    setPropertiesReturnMenu(null);
    activeToolbarButtonRef.current = trigger;
    if (open === menu) closeToolbarMenu(true);
    else {
      setToolbarMenuStyle(placeToolbarMenu(trigger, menu));
      setOpen(menu);
    }
  }

  function openRelatedToolbarMenu(menu: ToolbarMenu) {
    if (readOnly) return;
    const trigger = activeToolbarButtonRef.current;
    if (!trigger) return;
    if (menu === "sourceProperties") {
      setSourcePropertyDetailId(null);
      setSourcePropertyCreateOpen(false);
    }
    setPropertiesReturnMenu(
      (menu === "properties" || menu === "sourceProperties") && open === "settings" ? "settings" : null
    );
    setToolbarMenuStyle(placeToolbarMenu(trigger, menu));
    setOpen(menu);
  }

  function goBackFromPropertiesMenu() {
    if (open === "sourceProperties" && sourcePropertyDetailId) {
      setSourcePropertyDetailId(null);
      return;
    }
    if (open === "sourceProperties" && sourcePropertyCreateOpen) {
      setSourcePropertyCreateOpen(false);
      return;
    }
    const trigger = activeToolbarButtonRef.current;
    if (propertiesReturnMenu && trigger) {
      setPropertySearch("");
      setPropertiesReturnMenu(null);
      setToolbarMenuStyle(placeToolbarMenu(trigger, propertiesReturnMenu));
      setOpen(propertiesReturnMenu);
      return;
    }
    closeToolbarMenu(true);
  }

  async function copyActiveViewLink() {
    const copied = await copyText(databaseViewLink(dbId, view.id));
    notify(
      copied ? databaseViewLabels().copiedViewLink : databaseViewLabels().copyViewLinkFailed,
      copied ? "success" : "error"
    );
    closeToolbarMenu(true);
  }

  function renderToolbarMenuLayer(children: ReactNode) {
    return typeof document === "undefined" ? children : createPortal(children, document.body);
  }

  useEffect(() => {
    const toolbarRoot = toolbarRootRef.current;
    const databaseRoot = toolbarRoot?.closest<HTMLElement>('[data-placement="inline"]');
    if (!toolbarRoot || !databaseRoot) return;
    const toolbarTrigger = toolbarRoot;
    function onOpenInlineToolbarMenu(event: Event) {
      if (readOnly) return;
      const menu = (event as CustomEvent<{ menu?: ToolbarMenu }>).detail?.menu;
      if (
        menu !== "settings" &&
        menu !== "layout" &&
        menu !== "properties" &&
        menu !== "sourceProperties" &&
        menu !== "filter" &&
        menu !== "sort"
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(false);
      setPropertySearch("");
      setTemplateSearch("");
      setPropertiesReturnMenu(null);
      if (menu === "sourceProperties") {
        setSourcePropertyDetailId(null);
        setSourcePropertyCreateOpen(false);
      }
      activeToolbarButtonRef.current = toolbarTrigger;
      setToolbarMenuStyle(placeToolbarMenu(toolbarTrigger, menu));
      setOpen(menu);
    }
    databaseRoot.addEventListener(INLINE_DATABASE_TOOLBAR_MENU_EVENT, onOpenInlineToolbarMenu);
    return () => databaseRoot.removeEventListener(INLINE_DATABASE_TOOLBAR_MENU_EVENT, onOpenInlineToolbarMenu);
  }, [readOnly]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = activeToolbarButtonRef.current;
      if (!trigger) return;
      setToolbarMenuStyle(placeToolbarMenu(trigger, open));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  function toolbarMenuItems() {
    return Array.from(
      toolbarMenuRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => isVisibleToolbarItem(element) && element.tabIndex >= 0);
  }

  function onToolbarMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (isComposingKeyEvent(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeToolbarMenu(true);
      return;
    }
    if (e.key === "Tab") {
      const items = toolbarMenuItems();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
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
    const target = e.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLInputElement && target.type !== "checkbox") return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;

    const items = toolbarMenuItems();
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const index = items.findIndex((item) => item === document.activeElement);
    let nextIndex = index >= 0 ? index : 0;
    if (e.key === "ArrowDown") {
      nextIndex = index >= 0 ? (index + 1) % items.length : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex = index > 0 ? index - 1 : items.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }

    items[nextIndex]?.focus();
  }

  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    if (searchFocusTick <= 0) return;
    let focusFrame: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      setOpen(null);
      setSearchOpen(true);
      focusFrame = window.requestAnimationFrame(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (focusFrame) window.cancelAnimationFrame(focusFrame);
    };
  }, [searchFocusTick]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (open === "templates") templateSearchRef.current?.focus();
      else toolbarMenuItems()[0]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!pendingRuleFocus) return;
    const selector = pendingRuleFocus === "filter" ? "[data-filter-row]" : "[data-sort-row]";
    const frame = window.requestAnimationFrame(() => {
      const rows = toolbarMenuRef.current?.querySelectorAll<HTMLElement>(selector) ?? [];
      rows[rows.length - 1]
        ?.querySelector<HTMLElement>(
          'button:not(:disabled), input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        )
        ?.focus();
      setPendingRuleFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filterCount, pendingRuleFocus, sorts.length]);

  // --- Tree edits: each rebuilds the group at `path` immutably, then persists. ---

  function addFilterAt(path: number[]) {
    const prop = queryableProps[0];
    if (!prop) return;
    const leaf: ViewFilter = {
      propertyId: prop.id,
      operator: defaultOperator(prop),
      value: defaultValue(prop),
    };
    setFilterTree(
      updateGroupAtPath(filterTree, path, (g) => ({ ...g, filters: [...g.filters, leaf] }))
    );
    setPendingRuleFocus("filter");
  }

  function addGroupAt(path: number[]) {
    const prop = queryableProps[0];
    const newGroup: FilterGroup = {
      conjunction: "and",
      filters: prop
        ? [{ propertyId: prop.id, operator: defaultOperator(prop), value: defaultValue(prop) }]
        : [],
      groups: [],
    };
    setFilterTree(
      updateGroupAtPath(filterTree, path, (g) => ({
        ...g,
        groups: [...(g.groups ?? []), newGroup],
      }))
    );
    setPendingRuleFocus("filter");
  }

  function setConjunctionAt(path: number[], next: "and" | "or") {
    setFilterTree(updateGroupAtPath(filterTree, path, (g) => ({ ...g, conjunction: next })));
  }

  function updateFilterAt(path: number[], index: number, patch: Partial<ViewFilter>) {
    setFilterTree(
      updateGroupAtPath(filterTree, path, (g) => ({
        ...g,
        filters: g.filters.map((filter, i) => {
          if (i !== index) return filter;
          const merged = { ...filter, ...patch };
          if (NO_VALUE_FILTERS.has(merged.operator)) {
            return { propertyId: merged.propertyId, operator: merged.operator };
          }
          return merged;
        }),
      }))
    );
  }

  function removeFilterAt(path: number[], index: number) {
    setFilterTree(
      updateGroupAtPath(filterTree, path, (g) => ({
        ...g,
        filters: g.filters.filter((_, i) => i !== index),
      }))
    );
  }

  function removeGroupAt(parentPath: number[], index: number) {
    setFilterTree(
      updateGroupAtPath(filterTree, parentPath, (g) => ({
        ...g,
        groups: (g.groups ?? []).filter((_, i) => i !== index),
      }))
    );
  }

  function clearFilters() {
    if (readOnly || !hasFilterTerms) return;
    const previousFilterGroup = cloneViewConfigPart(filterTree);
    updateView(view.id, {
      config: {
        ...view.config,
        filterGroup: undefined,
        filters: undefined,
        filterConjunction: undefined,
        quickFilters: undefined,
      },
    });
    setPendingRuleFocus(null);
    notify(databaseViewLabels().toast.clearedFilters, "success", {
      label: "Undo",
      onClick: () => {
        const currentView = useStore.getState().dbViews(dbId).find((item) => item.id === view.id);
        updateView(view.id, {
          config: {
            ...(currentView?.config ?? {}),
            filterGroup: previousFilterGroup,
            filters: undefined,
            filterConjunction: undefined,
            quickFilters: undefined,
          },
        });
        notify(databaseViewLabels().toast.restoredFilters, "success");
      },
    });
  }

  function addSort() {
    const prop = queryableProps[0];
    if (!prop) return;
    setSorts([...sorts, { propertyId: prop.id, direction: "asc" }]);
    setPendingRuleFocus("sort");
  }

  function moveSort(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= sorts.length) return;
    const next = sorts.slice();
    [next[index], next[target]] = [next[target], next[index]];
    setSorts(next);
  }

  function clearSorts() {
    if (readOnly || sorts.length === 0) return;
    const previousSorts = cloneViewConfigPart(sorts);
    setSorts([]);
    setPendingRuleFocus(null);
    notify(sorts.length === 1 ? databaseViewLabels().toast.clearedSort : databaseViewLabels().toast.clearedSorts, "success", {
      label: "Undo",
      onClick: () => {
        const currentView = useStore.getState().dbViews(dbId).find((item) => item.id === view.id);
        updateView(view.id, {
          config: {
            ...(currentView?.config ?? {}),
            sorts: previousSorts,
          },
        });
        notify(sorts.length === 1 ? databaseViewLabels().toast.restoredSort : databaseViewLabels().toast.restoredSorts, "success");
      },
    });
  }

  function setVisibleProperty(id: string, visible: boolean) {
    if (readOnly) return;
    const allIds = props.map((p) => p.id);
    const titleId = props.find((p) => p.type === "title")?.id;
    const current = new Set(view.config?.visibleProperties ?? allIds);
    if (visible) current.add(id);
    else current.delete(id);
    if (titleId) current.add(titleId);
    updateView(view.id, {
      config: {
        ...view.config,
        visibleProperties: allIds.filter((propId) => current.has(propId)),
      },
    });
  }

  function setAllPropertiesVisible(visible: boolean) {
    if (readOnly) return;
    const allIds = props.map((p) => p.id);
    updateView(view.id, {
      config: {
        ...view.config,
        visibleProperties: visible ? allIds : allIds.filter((id) => id === titlePropertyId),
      },
    });
  }

  function persistPropertyOrder(ids: string[]) {
    const visibleSet = view.config?.visibleProperties ? new Set(view.config.visibleProperties) : null;
    const nextVisibleProperties = visibleSet ? ids.filter((id) => visibleSet.has(id)) : undefined;
    updateView(view.id, {
      config: {
        ...view.config,
        propertyOrder: ids,
        ...(nextVisibleProperties ? { visibleProperties: nextVisibleProperties } : {}),
      },
    });
  }

  function beginPropertyDrag(prop: DbProperty, e: ReactDragEvent<HTMLElement>) {
    if (readOnly) {
      e.preventDefault();
      return;
    }
    setDraggingPropertyId(prop.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(TOOLBAR_PROPERTY_DRAG, prop.id);
  }

  function updatePropertyDragTarget(prop: DbProperty, e: ReactDragEvent<HTMLElement>) {
    if (readOnly) return;
    if (!draggingPropertyId && !Array.from(e.dataTransfer.types).includes(TOOLBAR_PROPERTY_DRAG)) return;
    const sourceId = e.dataTransfer.getData(TOOLBAR_PROPERTY_DRAG) || draggingPropertyId;
    if (!sourceId || sourceId === prop.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const side = e.clientY > rect.top + rect.height / 2 ? "after" : "before";
    setDragOverPropertyId(prop.id);
    setDragOverPropertySide(side);
  }

  function clearPropertyDragState() {
    setDraggingPropertyId(null);
    setDragOverPropertyId(null);
    setDragOverPropertySide("before");
  }

  function reorderPropertyFromMenu(sourceId: string, targetId: string, side: "before" | "after") {
    if (readOnly || !sourceId || sourceId === targetId) {
      clearPropertyDragState();
      return;
    }
    const ids = orderedProps.map((prop) => prop.id);
    const sourceIndex = ids.indexOf(sourceId);
    if (sourceIndex < 0) {
      clearPropertyDragState();
      return;
    }
    const [source] = ids.splice(sourceIndex, 1);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) {
      clearPropertyDragState();
      return;
    }
    const insertAt = targetIndex + (side === "after" ? 1 : 0);
    ids.splice(insertAt, 0, source);
    persistPropertyOrder(ids);
    clearPropertyDragState();
  }

  async function createGroupProperty(type: Extract<PropertyType, "select" | "status">) {
    if (readOnly) return;
    const prop = await addProperty(
      dbId,
      type,
      type === "status" ? "Status" : "Select",
      {
        options:
          type === "status"
            ? [
                { id: "todo", name: "Not started", color: "gray" },
                { id: "doing", name: "In progress", color: "blue" },
                { id: "done", name: "Done", color: "green" },
              ]
            : [
                { id: "option-1", name: "Option 1", color: "gray" },
                { id: "option-2", name: "Option 2", color: "blue" },
              ],
      }
    );
    updateConfig({ groupBy: prop.id });
  }

  async function createDateViewProperty(target: "calendar" | "timeline-start" | "timeline-end") {
    if (readOnly) return;
    const prop = await addProperty(
      dbId,
      "date",
      target === "timeline-end" ? "End date" : "Date"
    );
    if (target === "calendar") updateConfig({ calendarBy: prop.id });
    else if (target === "timeline-end") updateConfig({ timelineEndBy: prop.id });
    else updateConfig({ timelineBy: prop.id });
  }

  function sourcePropertyTypeLabel(type: PropertyType) {
    return localizedPropertyTypeLabel(type);
  }

  const sourcePropertyCreateTypes = CREATABLE_PROPERTY_TYPES.filter((item) => item.type !== "title").sort((a, b) => {
    const order: PropertyType[] = [
      "rich_text",
      "number",
      "select",
      "multi_select",
      "status",
      "date",
      "person",
      "files",
      "checkbox",
      "url",
      "email",
      "phone",
      "formula",
      "relation",
      "rollup",
      "created_time",
      "created_by",
      "last_edited_time",
      "last_edited_by",
      "unique_id",
    ];
    return order.indexOf(a.type) - order.indexOf(b.type);
  });

  async function createSourceProperty(type: PropertyType) {
    if (readOnly) return;
    try {
      const prop = await addProperty(
        dbId,
        type,
        sourcePropertyTypeLabel(type),
        configForType(type, undefined, dbId)
      );
      setSourcePropertyCreateOpen(false);
      setSourcePropertyDetailId(prop.id);
      notify(databaseViewLabels().createdProperty(prop.name), "success");
    } catch {
      notify(databaseViewLabels().createPropertyFailed, "error");
    }
  }

  function editableSourcePropertyTypes(prop: DbProperty) {
    const systemTypes = new Set<PropertyType>([
      "created_time",
      "last_edited_time",
      "created_by",
      "last_edited_by",
    ]);
    return PROPERTY_TYPES.filter(
      (type) => type.type === prop.type || !systemTypes.has(type.type)
    ).map((type) => ({
      value: type.type,
      label: type.label,
      icon: <PropertyTypeIcon type={type.type} size={14} />,
    }));
  }

  async function deleteSourcePropertyWithFeedback(prop: DbProperty) {
    if (prop.type === "title") return;
    try {
      const snapshot = await deleteProperty(prop.id);
      if (!snapshot) {
        notify(databaseViewLabels().deletePropertyFailed, "error");
        return;
      }
      setSourcePropertyDetailId(null);
      notify(databaseViewLabels().deletedProperty, "success", {
        label: "Undo",
        onClick: async () => {
          const restored = await restoreDeletedProperty(snapshot);
          notify(
            restored ? databaseViewLabels().restoredProperty : databaseViewLabels().restorePropertyFailed,
            restored ? "success" : "error"
          );
        },
      });
    } catch {
      notify(databaseViewLabels().deletePropertyFailed, "error");
    }
  }

  async function createRowFromTemplate(templateId?: string) {
    if (readOnly) return;
    const row = await addRow(dbId, true, templateId, { focusTitle: true });
    applyViewFilterSeeds(
      row.id,
      viewFilterSeedValues(props, view, [], { currentPageId: contextPageId }),
      updatePage,
      setRowProperty
    );
    setOpen(null);
    onOpenRow?.(row.id);
  }

  async function createTemplate() {
    if (readOnly) return;
    try {
      const template = await addTemplate(dbId);
      setOpen(null);
      setEditingTemplateId(template.id);
      notify(databaseViewLabels().toast.createdTemplate, "success");
    } catch {
      notify(databaseViewLabels().toast.couldntCreateTemplate, "error");
    }
  }

  async function duplicateAndEditTemplate(templateId: string) {
    if (readOnly) return;
    try {
      const template = await duplicateTemplate(templateId);
      if (!template) {
        notify(databaseViewLabels().toast.couldntDuplicateTemplate, "error");
        return;
      }
      setOpen(null);
      setEditingTemplateId(template.id);
      notify(databaseViewLabels().toast.duplicatedTemplate, "success");
    } catch {
      notify(databaseViewLabels().toast.couldntDuplicateTemplate, "error");
    }
  }

  function toggleTemplateDefault(template: DbTemplate) {
    if (readOnly) return;
    const nextDefault = !template.isDefault;
    updateTemplate(template.id, { isDefault: nextDefault });
    notify(nextDefault ? databaseViewLabels().toast.setDefaultTemplate : databaseViewLabels().toast.defaultTemplateRemoved, "success");
  }

  async function deleteTemplateWithFeedback(template: DbTemplate) {
    if (readOnly) return;
    try {
      const snapshot = await deleteTemplate(template.id);
      if (!snapshot) {
        notify(databaseViewLabels().toast.couldntDeleteTemplate, "error");
        return;
      }
      notify(databaseViewLabels().toast.deletedTemplate, "success", {
        label: "Undo",
        onClick: async () => {
          const restored = await restoreDeletedTemplate(snapshot);
          notify(restored ? databaseViewLabels().toast.restoredTemplate : databaseViewLabels().toast.couldntRestoreTemplate, restored ? "success" : "error");
        },
      });
    } catch {
      notify(databaseViewLabels().toast.couldntDeleteTemplate, "error");
    }
  }

  function renderPropertyRow(prop: DbProperty) {
    const isTitle = prop.type === "title";
    const visible = isTitle || visibleIds.has(prop.id);
    return (
      <div
        key={prop.id}
        className={styles.propertyRuleRow}
        data-property-row={prop.id}
        data-property-title={isTitle ? "true" : undefined}
        data-property-dragging={draggingPropertyId === prop.id ? "true" : undefined}
        data-property-drag-over={dragOverPropertyId === prop.id ? "true" : undefined}
        data-drop-side={dragOverPropertyId === prop.id ? dragOverPropertySide : undefined}
        tabIndex={-1}
        onDragOver={(e) => updatePropertyDragTarget(prop, e)}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragOverPropertyId((current) => (current === prop.id ? null : current));
        }}
        onDrop={(e) => {
          if (readOnly) return;
          e.preventDefault();
          reorderPropertyFromMenu(
            e.dataTransfer.getData(TOOLBAR_PROPERTY_DRAG) || draggingPropertyId || "",
            prop.id,
            dragOverPropertySide
          );
        }}
        onDragEnd={clearPropertyDragState}
      >
        <button
          type="button"
          className={styles.propertyDragHandle}
          draggable={!readOnly}
          disabled={readOnly}
          data-property-drag-handle="true"
          aria-label={`Drag ${prop.name} property`}
          onDragStart={(e) => beginPropertyDrag(prop, e)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <DragHandleIcon size={14} aria-hidden="true" />
        </button>
        <div className={styles.propertyVisibilityMain}>
          <span className={styles.propertyVisibilityIcon}>
            <PropertyTypeIcon type={prop.type} size={18} />
          </span>
          <span className={styles.propertyName}>{prop.name}</span>
        </div>
        <button
          type="button"
          className={styles.propertyVisibilityToggle}
          disabled={isTitle}
          data-property-visible={visible ? "true" : "false"}
          aria-label={visible ? `Hide ${prop.name}` : `Show ${prop.name}`}
          onClick={() => setVisibleProperty(prop.id, !visible)}
        >
          {visible ? <EyeIcon size={18} /> : <EyeSlashIcon size={18} />}
        </button>
      </div>
    );
  }

  function renderSourcePropertyEditorRow(prop: DbProperty) {
    return (
      <button
        key={prop.id}
        type="button"
        className={styles.sourcePropertyEditRow}
        data-source-property-row={prop.id}
        onClick={() => setSourcePropertyDetailId(prop.id)}
      >
        <span className={styles.sourcePropertyIcon}>
          <PropertyTypeIcon type={prop.type} size={20} />
        </span>
        <span className={styles.sourcePropertyName}>{prop.name}</span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div
      ref={toolbarRootRef}
      className={styles.dbToolbar}
      role="toolbar"
      aria-label="Database toolbar"
      data-compact-imported-inline={compactImportedInline ? "true" : undefined}
    >
      <div className={styles.dbToolbarGroup}>
        {(showLayoutOptions || open === "layout") && (
          <div className={styles.toolbarPopoverWrap}>
            {showLayoutOptions && (
              <button
                type="button"
                className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
                data-active={layoutActive ? "true" : undefined}
                aria-label="Layout"
                aria-haspopup="dialog"
                aria-expanded={open === "layout"}
                disabled={readOnly}
                title="Layout"
                onClick={(e) => toggleMenu("layout", e.currentTarget)}
              >
                <LayoutIcon size={14} aria-hidden="true" />
                <span className={styles.toolbarLabel}>Layout</span>
              </button>
            )}
            {open === "layout" &&
              renderToolbarMenuLayer(
              <>
                <button
                  type="button"
                  className={styles.menuBackdrop}
                  onClick={() => closeToolbarMenu(true)}
                  tabIndex={-1}
                  aria-label="Close layout options"
                />
                <div
                  ref={toolbarMenuRef}
                  className={`${styles.toolbarMenu} ${styles.layoutMenu}`}
                  style={toolbarMenuStyle}
                  role="dialog"
                  aria-label="Layout options"
                  onKeyDown={onToolbarMenuKeyDown}
                >
                  <div className={styles.toolbarMenuLabel}>{databaseViewLabels().layout}</div>
                  <div
                    className={styles.layoutTypeGrid}
                    role="radiogroup"
                    tabIndex={-1}
                    aria-label="Database view type"
                    onKeyDown={onSegmentedOptionGroupKeyDown}
                  >
                    {NOTION_2023_VIEW_TYPES.map((typeOption) => (
                      <button
                        key={typeOption.type}
                        type="button"
                        className={styles.layoutTypeButton}
                        data-segmented-option
                        data-active={view.type === typeOption.type ? "true" : undefined}
                        role="radio"
                        aria-checked={view.type === typeOption.type}
                        tabIndex={view.type === typeOption.type ? 0 : -1}
                        onClick={() => updateViewType(typeOption.type)}
                      >
                        <span className={styles.viewGlyph}>
                          <ViewTypeIcon type={typeOption.type} />
                        </span>
                        <span>{viewTypeSettingsLabel(typeOption.type)}</span>
                        {view.type === typeOption.type && (
                          <span className={styles.check}>
                            <CheckIcon size={14} />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className={styles.layoutSectionDivider} />
                  <div className={styles.layoutRow}>
                    <span>{databaseViewLabels().openPagesIn}</span>
                    <div
                      className={styles.segmented}
                      role="radiogroup"
                      tabIndex={-1}
                      aria-label="Open database pages in"
                      onKeyDown={onSegmentedOptionGroupKeyDown}
                    >
                      {(["side", "center", "full"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          data-segmented-option
                          data-active={openPageIn === m ? "true" : undefined}
                          role="radio"
                          aria-checked={openPageIn === m}
                          tabIndex={openPageIn === m ? 0 : -1}
                          onClick={() => updateConfig({ openPageIn: m })}
                        >
                          {m === "side"
                            ? databaseViewLabels().side
                            : m === "center"
                              ? databaseViewLabels().center
                              : databaseViewLabels().full}
                        </button>
                      ))}
                    </div>
                  </div>
                  {view.type === "table" && (
                    <>
                      <div className={styles.layoutRow}>
                        <span>{databaseViewLabels().rowHeight}</span>
                        <div
                          className={styles.segmented}
                          role="radiogroup"
                          tabIndex={-1}
                          aria-label="Table row height"
                          onKeyDown={onSegmentedOptionGroupKeyDown}
                        >
                          {(["short", "medium", "tall"] as const).map((h) => (
                            <button
                              key={h}
                              type="button"
                              data-segmented-option
                              data-active={rowHeight === h ? "true" : undefined}
                              role="radio"
                              aria-checked={rowHeight === h}
                              tabIndex={rowHeight === h ? 0 : -1}
                              onClick={() => updateConfig({ rowHeight: h })}
                            >
                              {h === "short"
                                ? databaseViewLabels().short
                                : h === "medium"
                                  ? databaseViewLabels().medium
                                  : databaseViewLabels().tall}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().initialLoad}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().initialLoad}
                          value={String(initialLoadLimit)}
                          options={TABLE_INITIAL_LOAD_OPTIONS.map((limit) => ({
                            value: String(limit),
                            label: String(limit),
                          }))}
                          onChange={(value) => updateConfig({ initialLoadLimit: Number(value) })}
                        />
                      </label>
                    </>
                  )}
                  {isCardView && (
                    <>
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().cardPreview}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().cardPreview}
                          value={cardPreviewValue}
                          options={coverPropertyOptions}
                          onChange={(value) =>
                            updateConfig({
                              coverProperty:
                                value === CARD_PREVIEW_PAGE && !isBoardView ? undefined : value,
                            })
                          }
                        />
                      </label>
                      <div className={styles.layoutRow}>
                        <span>{databaseViewLabels().cardSize}</span>
                        <div
                          className={styles.segmented}
                          role="radiogroup"
                          tabIndex={-1}
                          aria-label={databaseViewLabels().cardSize}
                          onKeyDown={onSegmentedOptionGroupKeyDown}
                        >
                          {(["small", "medium", "large"] as const).map((size) => (
                            <button
                              key={size}
                              type="button"
                              data-segmented-option
                              data-active={(view.config?.cardSize ?? "medium") === size ? "true" : undefined}
                              role="radio"
                              aria-checked={(view.config?.cardSize ?? "medium") === size}
                              tabIndex={(view.config?.cardSize ?? "medium") === size ? 0 : -1}
                              onClick={() => updateConfig({ cardSize: size })}
                            >
                              {size === "small"
                                ? databaseViewLabels().small
                                : size === "medium"
                                  ? databaseViewLabels().medium
                                  : databaseViewLabels().large}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className={styles.layoutToggle}>
                        <input
                          type="checkbox"
                          checked={!!view.config?.fitImage}
                          onChange={(e) => updateConfig({ fitImage: e.target.checked || undefined })}
                        />
                        {databaseViewLabels().fitImage}
                      </label>
                      <label className={styles.layoutToggle}>
                        <input
                          type="checkbox"
                          checked={!!view.config?.wrap}
                          onChange={(e) => updateConfig({ wrap: e.target.checked || undefined })}
                        />
                        {databaseViewLabels().wrapProperties}
                      </label>
                    </>
                  )}

                  {isCalendarView && (
                    <>
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().calendarBy}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().calendarBy}
                          value={view.config?.calendarBy ?? dateProps[0]?.id ?? ""}
                          options={datePropertyOptions}
                          disabled={dateProps.length === 0}
                          onChange={(value) => updateConfig({ calendarBy: value || undefined })}
                        />
                      </label>
                      <div className={styles.layoutRow}>
                        <span>{databaseViewLabels().calendarView}</span>
                        <div
                          className={styles.segmented}
                          role="radiogroup"
                          tabIndex={-1}
                          aria-label={databaseViewLabels().calendarView}
                          onKeyDown={onSegmentedOptionGroupKeyDown}
                        >
                          {(["month", "week"] as const).map((layout) => (
                            <button
                              key={layout}
                              type="button"
                              data-segmented-option
                              data-active={(view.config?.calendarLayout ?? "month") === layout ? "true" : undefined}
                              role="radio"
                              aria-checked={(view.config?.calendarLayout ?? "month") === layout}
                              tabIndex={(view.config?.calendarLayout ?? "month") === layout ? 0 : -1}
                              onClick={() => updateConfig({ calendarLayout: layout === "month" ? undefined : layout })}
                            >
                              {layout === "month" ? databaseViewLabels().month : databaseViewLabels().week}
                            </button>
                          ))}
                        </div>
                      </div>
                      {dateProps.length === 0 && (
                        <div className={styles.layoutActions}>
                          <button type="button" onClick={() => void createDateViewProperty("calendar")}>
                            <Plus size={14} /> {databaseViewLabels().addDateProperty}
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {isTimelineView && (
                    <>
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().timelineBy}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().timelineBy}
                          value={view.config?.timelineBy ?? view.config?.calendarBy ?? dateProps[0]?.id ?? ""}
                          options={datePropertyOptions}
                          disabled={dateProps.length === 0}
                          onChange={(value) => updateConfig({ timelineBy: value || undefined })}
                        />
                      </label>
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().timelineEndDate}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().timelineEndDate}
                          value={view.config?.timelineEndBy ?? ""}
                          options={timelineEndPropertyOptions}
                          disabled={dateProps.length === 0}
                          onChange={(value) => updateConfig({ timelineEndBy: value || undefined })}
                        />
                      </label>
                      <div className={styles.layoutRow}>
                        <span>{databaseViewLabels().timeUnit}</span>
                        <div
                          className={styles.segmented}
                          role="radiogroup"
                          tabIndex={-1}
                          aria-label={databaseViewLabels().timelineZoomAria}
                          onKeyDown={onSegmentedOptionGroupKeyDown}
                        >
                          {(["day", "week", "month"] as const).map((zoom) => (
                            <button
                              key={zoom}
                              type="button"
                              data-segmented-option
                              data-active={(view.config?.timelineZoom ?? "day") === zoom ? "true" : undefined}
                              role="radio"
                              aria-checked={(view.config?.timelineZoom ?? "day") === zoom}
                              tabIndex={(view.config?.timelineZoom ?? "day") === zoom ? 0 : -1}
                              onClick={() => updateConfig({ timelineZoom: zoom === "day" ? undefined : zoom })}
                            >
                              {zoom === "day"
                                ? databaseViewLabels().day
                                : zoom === "week"
                                  ? databaseViewLabels().week
                                  : databaseViewLabels().month}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().loadLimit}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().loadLimit}
                          value={String(timelineLimit)}
                          options={TIMELINE_LOAD_LIMIT_OPTIONS.map((limit) => ({
                            value: String(limit),
                            label: String(limit),
                          }))}
                          onChange={(value) => updateConfig({ timelineLoadLimit: Number(value) })}
                        />
                      </label>
                      <label className={styles.layoutToggle}>
                        <input
                          type="checkbox"
                          checked={!!view.config?.timelineShowTable}
                          onChange={(e) => updateConfig({ timelineShowTable: e.target.checked || undefined })}
                        />
                        {databaseViewLabels().showTable}
                      </label>
                      <div className={styles.layoutActions}>
                        {dateProps.length === 0 && (
                          <button type="button" onClick={() => void createDateViewProperty("timeline-start")}>
                            <Plus size={14} /> {databaseViewLabels().addDateProperty}
                          </button>
                        )}
                        {dateProps.length > 0 && (
                          <button type="button" onClick={() => void createDateViewProperty("timeline-end")}>
                            <Plus size={14} /> {databaseViewLabels().addEndDateProperty}
                          </button>
                        )}
                      </div>
                    </>
                  )}

                </div>
              </>
              )}
          </div>
        )}

        {isBoardView && (
          <div className={styles.toolbarPopoverWrap}>
            <button
              type="button"
              className={`${styles.toolbarBtn} ${compactImportedInline ? styles.iconToolbarBtn : ""}`}
              data-active={activeGroupProp ? "true" : undefined}
              aria-label={`Group${activeGroupProp ? `: ${activeGroupProp.name}` : ""}`}
              aria-haspopup="dialog"
              aria-expanded={open === "group"}
              disabled={readOnly}
              title={`Group${activeGroupProp ? `: ${activeGroupProp.name}` : ""}`}
              onClick={(e) => toggleMenu("group", e.currentTarget)}
            >
              {compactImportedInline ? (
                <>
                  <StatusIcon size={14} aria-hidden="true" />
                  <span className={styles.toolbarLabel}>
                    Group{activeGroupProp ? `: ${activeGroupProp.name}` : ""}
                  </span>
                </>
              ) : (
                <>Group{activeGroupProp ? `: ${activeGroupProp.name}` : ""}</>
              )}
            </button>
            {open === "group" &&
              renderToolbarMenuLayer(
                <>
                <button
                  type="button"
                  className={styles.menuBackdrop}
                  onClick={() => closeToolbarMenu(true)}
                  tabIndex={-1}
                  aria-label="Close group options"
                />
                <div
                  ref={toolbarMenuRef}
                  className={`${styles.toolbarMenu} ${styles.groupMenu}`}
                  style={toolbarMenuStyle}
                  role="dialog"
                  aria-label="Group by"
                  onKeyDown={onToolbarMenuKeyDown}
                >
                  <div className={styles.toolbarMenuLabel}>Group by</div>
                  {groupProps.length > 0 ? (
                    <div className={styles.groupList}>
                      {groupProps.map((prop) => (
                        <button
                          key={prop.id}
                          type="button"
                          className={styles.groupItem}
                          data-active={activeGroupProp?.id === prop.id ? "true" : undefined}
                          onClick={() => updateConfig({ groupBy: prop.id })}
                        >
                          <span className={styles.groupGlyph}>
                            {prop.type === "status" ? (
                              <StatusIcon size={14} />
                            ) : (
                              <SelectIcon size={14} />
                            )}
                          </span>
                          <span>{prop.name}</span>
                          {activeGroupProp?.id === prop.id && (
                            <span className={styles.check}>
                              <CheckIcon size={14} />
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.toolbarEmpty}>Boards group by Select or Status.</div>
                  )}
                  <div className={styles.groupActions}>
                    <button type="button" onClick={() => void createGroupProperty("status")}>
                      <Plus size={14} /> Add status property
                    </button>
                    <button type="button" onClick={() => void createGroupProperty("select")}>
                      <Plus size={14} /> Add select property
                    </button>
                  </div>
                </div>
                </>
              )}
          </div>
        )}

        {(showDirectProperties || open === "properties" || open === "sourceProperties") && (
        <div className={styles.toolbarPopoverWrap}>
          {showDirectProperties && (
            <button
              type="button"
              className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
              data-active={hiddenCount > 0 ? "true" : undefined}
              aria-label="Properties"
              aria-haspopup="dialog"
              aria-expanded={open === "properties"}
              disabled={readOnly}
              title="Properties"
              onClick={(e) => toggleMenu("properties", e.currentTarget)}
            >
              <PropertiesIcon size={14} aria-hidden="true" />
              <span className={styles.toolbarLabel}>Properties</span>
            </button>
          )}
          {open === "properties" &&
            renderToolbarMenuLayer(
            <>
              <button
                type="button"
                className={styles.menuBackdrop}
                onClick={() => closeToolbarMenu(true)}
                tabIndex={-1}
                aria-label="Close properties menu"
              />
              <div
                ref={toolbarMenuRef}
                className={`${styles.toolbarMenu} ${styles.propertiesMenu}`}
                style={toolbarMenuStyle}
                role="dialog"
                aria-label={databaseViewLabels().propertyVisibility}
                onKeyDown={onToolbarMenuKeyDown}
              >
                <div className={styles.propertiesVisibilityHead}>
                  <button
                    type="button"
                    className={styles.propertiesVisibilityBack}
                    aria-label={
                      propertiesReturnMenu
                        ? databaseViewLabels().backToViewSettings
                        : databaseViewLabels().closePropertyVisibility
                    }
                    onClick={goBackFromPropertiesMenu}
                  >
                    <ArrowLeft size={18} aria-hidden="true" />
                  </button>
                  <div className={styles.propertiesVisibilityTitle}>{databaseViewLabels().propertyVisibility}</div>
                  <button
                    type="button"
                    className={styles.propertiesVisibilityClose}
                    aria-label={databaseViewLabels().closePropertyVisibility}
                    onClick={() => closeToolbarMenu(true)}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
                <div className={styles.propertiesSearch}>
                  <Search size={14} aria-hidden="true" />
                  <input
                    type="text"
                    value={propertySearch}
                    placeholder={databaseViewLabels().searchProperties}
                    aria-label={databaseViewLabels().searchProperties}
                    onChange={(e) => setPropertySearch(e.target.value)}
                  />
                </div>
                <div className={styles.propertiesList}>
                  {visibleFilteredProps.length > 0 && (
                    <div className={styles.propertiesSection}>
                      <div className={styles.propertiesSectionHead}>
                        <span>{databaseViewLabels().shownInTable}</span>
                        <button
                          type="button"
                          disabled={!visibleFilteredProps.some((prop) => prop.type !== "title")}
                          onClick={() => setAllPropertiesVisible(false)}
                        >
                          {databaseViewLabels().hideAll}
                        </button>
                      </div>
                      {visibleFilteredProps.map(renderPropertyRow)}
                    </div>
                  )}
                  {hiddenFilteredProps.length > 0 && (
                    <div className={styles.propertiesSection}>
                      <div className={styles.propertiesSectionHead}>
                        <span>{databaseViewLabels().hiddenInTable}</span>
                        <button type="button" onClick={() => setAllPropertiesVisible(true)}>
                          {databaseViewLabels().showAll}
                        </button>
                      </div>
                      {hiddenFilteredProps.map(renderPropertyRow)}
                    </div>
                  )}
                  {filteredOrderedProps.length === 0 && (
                    <div className={styles.propertiesEmpty}>{databaseViewLabels().noSearchResults}</div>
                  )}
                </div>
              </div>
              </>
            )}
          {open === "sourceProperties" &&
            renderToolbarMenuLayer(
            <>
              <button
                type="button"
                className={styles.menuBackdrop}
                onClick={() => closeToolbarMenu(true)}
                tabIndex={-1}
                aria-label="Close source properties menu"
              />
              <div
                ref={toolbarMenuRef}
                className={`${styles.toolbarMenu} ${styles.propertiesMenu} ${styles.sourcePropertiesMenu}`}
                style={toolbarMenuStyle}
                role="dialog"
                aria-label={databaseViewLabels().properties}
                onKeyDown={onToolbarMenuKeyDown}
              >
                <div className={styles.propertiesVisibilityHead}>
                  <button
                    type="button"
                    className={styles.propertiesVisibilityBack}
                    aria-label={
                      sourcePropertyDetail
                        ? databaseViewLabels().backToPropertyList
                        : sourcePropertyCreateOpen
                          ? databaseViewLabels().backToProperties
                        : propertiesReturnMenu
                          ? databaseViewLabels().backToViewSettings
                          : databaseViewLabels().closeProperties
                    }
                    onClick={goBackFromPropertiesMenu}
                  >
                    <ArrowLeft size={18} aria-hidden="true" />
                  </button>
                  <div className={styles.propertiesVisibilityTitle}>
                    {sourcePropertyDetail
                      ? sourcePropertyDetail.name
                      : sourcePropertyCreateOpen
                        ? databaseViewLabels().newPropertyIn(databaseDisplayTitle(pagesById[dbId]))
                        : databaseViewLabels().properties}
                  </div>
                  <button
                    type="button"
                    className={styles.propertiesVisibilityClose}
                    aria-label={databaseViewLabels().closeProperties}
                    onClick={() => closeToolbarMenu(true)}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
                {sourcePropertyDetail ? (
                  <div className={styles.sourcePropertyDetail}>
                    <label className={styles.propertyHeaderField}>
                      <span>Name</span>
                        <input
                          value={sourcePropertyDetail.name}
                          autoFocus
                          onChange={(e) => updateProperty(sourcePropertyDetail.id, { name: e.target.value })}
                          onKeyDown={(e) => {
                            if (isComposingKeyEvent(e)) return;
                            if (e.key !== "Escape" && e.key !== "Enter") return;
                            e.preventDefault();
                            setSourcePropertyDetailId(null);
                          }}
                        />
                    </label>
                    <div className={styles.propertyHeaderField}>
                      <span>Type</span>
                      <NotionSelect
                        ariaLabel="Property type"
                        value={sourcePropertyDetail.type}
                        disabled={sourcePropertyDetail.type === "title"}
                        options={editableSourcePropertyTypes(sourcePropertyDetail)}
                        onChange={(value) => {
                          const type = value as PropertyType;
                          confirmPropertyTypeChange(sourcePropertyDetail, type, () => {
                            updateProperty(sourcePropertyDetail.id, {
                              type,
                              config: configForType(type, sourcePropertyDetail.config, dbId),
                            });
                          });
                        }}
                      />
                    </div>
                    <label className={styles.propertyHeaderField}>
                      <span>Description</span>
                      <textarea
                        value={sourcePropertyDetail.description ?? ""}
                        placeholder="Add a description"
                        rows={2}
                        onChange={(e) =>
                          updateProperty(sourcePropertyDetail.id, {
                            description: e.target.value || undefined,
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key !== "Escape") return;
                          e.preventDefault();
                          setSourcePropertyDetailId(null);
                        }}
                      />
                    </label>
                    <PropertyTypeConfig prop={sourcePropertyDetail} onClose={() => setSourcePropertyDetailId(null)} />
                    <div className={styles.propertyHeaderDivider} />
                    <button
                      type="button"
                      className={`${styles.propertyHeaderItem} ${styles.propertyDanger}`}
                      disabled={sourcePropertyDetail.type === "title"}
                      onClick={() => void deleteSourcePropertyWithFeedback(sourcePropertyDetail)}
                    >
                      {databaseViewLabels().deleteProperty}
                    </button>
                  </div>
                ) : sourcePropertyCreateOpen ? (
                  <div className={styles.sourcePropertyTypePicker}>
                    <div className={styles.sourcePropertyTypeHeader}>
                      <span>{databaseViewLabels().type}</span>
                      <Search size={20} aria-hidden="true" />
                    </div>
                    <div className={styles.sourcePropertyTypeList}>
                      {sourcePropertyCreateTypes.map((item) => (
                        <button
                          key={item.type}
                          type="button"
                          className={styles.sourcePropertyTypeRow}
                          data-source-property-type={item.type}
                          onClick={() => void createSourceProperty(item.type)}
                        >
                          <span className={styles.sourcePropertyIcon}>
                            <PropertyTypeIcon type={item.type} size={22} />
                          </span>
                          <span>{sourcePropertyTypeLabel(item.type)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.propertiesSearch}>
                      <Search size={14} aria-hidden="true" />
                      <input
                        type="text"
                        value={propertySearch}
                        placeholder={databaseViewLabels().searchProperties}
                        aria-label={databaseViewLabels().searchProperties}
                        onChange={(e) => setPropertySearch(e.target.value)}
                      />
                    </div>
                    <div className={styles.sourcePropertiesList}>
                      {sourcePropertyEditorProps.length === 0 ? (
                        <div className={styles.propertiesEmpty}>{databaseViewLabels().noSearchResults}</div>
                      ) : (
                        sourcePropertyEditorProps.map(renderSourcePropertyEditorRow)
                      )}
                    </div>
                    <div className={styles.sourcePropertyFooter}>
                      <button
                        type="button"
                        className={styles.sourcePropertyFooterRow}
                        onClick={() => setSourcePropertyCreateOpen(true)}
                      >
                        <Plus size={20} aria-hidden="true" />
                        <span>{databaseViewLabels().newProperty}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.sourcePropertyFooterRow}
                        onClick={() => notify(databaseViewLabels().deletedPropertiesNotLinked)}
                      >
                        <Trash size={20} aria-hidden="true" />
                        <span>{databaseViewLabels().deletedProperties}</span>
                        <span className={styles.sourcePropertyMeta}>0</span>
                        <ChevronRight size={18} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={styles.sourcePropertyFooterRow}
                        onClick={() => notify(databaseViewLabels().propertyHelpNotLinked)}
                      >
                        <ClockIcon size={20} aria-hidden="true" />
                        <span>{databaseViewLabels().propertyHelp}</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
              </>
            )}
        </div>
        )}

        <div className={styles.toolbarPopoverWrap}>
          <button
            type="button"
            className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
            data-active={hasActiveFilterTerms ? "true" : undefined}
            aria-label={databaseViewLabels().filter}
            aria-haspopup="dialog"
            aria-expanded={open === "filter"}
            disabled={readOnly}
            title={databaseViewLabels().filter}
            onClick={(e) => toggleMenu("filter", e.currentTarget)}
          >
            <FilterIcon size={14} aria-hidden="true" />
            <span className={styles.toolbarLabel}>{databaseViewLabels().filter}</span>
          </button>
          {open === "filter" &&
            renderToolbarMenuLayer(
              <>
              <button
                type="button"
                className={styles.menuBackdrop}
                onClick={() => closeToolbarMenu(true)}
                tabIndex={-1}
                aria-label="Close filters menu"
              />
              <div
                ref={toolbarMenuRef}
                className={styles.toolbarMenu}
                style={toolbarMenuStyle}
                role="dialog"
                aria-label="Filters"
                onKeyDown={onToolbarMenuKeyDown}
              >
                <div className={styles.toolbarMenuHead}>
                  <div className={styles.toolbarMenuLabel}>Filters</div>
                  {hasFilterTerms && (
                    <button type="button" className={styles.toolbarMenuClear} onClick={clearFilters}>
                      Clear all
                    </button>
                  )}
                </div>
                {!hasFilterTerms && (
                  <div className={styles.toolbarEmpty}>Only show rows that match rules.</div>
                )}
                <FilterGroupEditor
                  group={filterTree}
                  path={[]}
                  props={queryableProps}
                  onSetConjunction={setConjunctionAt}
                  onUpdateFilter={updateFilterAt}
                  onRemoveFilter={removeFilterAt}
                  onRemoveGroup={removeGroupAt}
                  onAddFilter={addFilterAt}
                  onAddGroup={addGroupAt}
                />
              </div>
              </>
            )}
        </div>

        <div className={styles.toolbarPopoverWrap}>
          <button
            type="button"
            className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
            data-active={sorts.length > 0 ? "true" : undefined}
            aria-label={databaseViewLabels().sort}
            aria-haspopup="dialog"
            aria-expanded={open === "sort"}
            disabled={readOnly}
            title={databaseViewLabels().sort}
            onClick={(e) => toggleMenu("sort", e.currentTarget)}
          >
            <SortIcon size={14} aria-hidden="true" />
            <span className={styles.toolbarLabel}>{databaseViewLabels().sort}</span>
          </button>
          {open === "sort" &&
            renderToolbarMenuLayer(
              <>
              <button
                type="button"
                className={styles.menuBackdrop}
                onClick={() => closeToolbarMenu(true)}
                tabIndex={-1}
                aria-label="Close sorts menu"
              />
              <div
                ref={toolbarMenuRef}
                className={styles.toolbarMenu}
                style={toolbarMenuStyle}
                role="dialog"
                aria-label="Sorts"
                onKeyDown={onToolbarMenuKeyDown}
              >
                <div className={styles.toolbarMenuHead}>
                  <div className={styles.toolbarMenuLabel}>Sorts</div>
                  {sorts.length > 0 && (
                    <button type="button" className={styles.toolbarMenuClear} onClick={clearSorts}>
                      Clear all
                    </button>
                  )}
                </div>
                {sorts.length === 0 && (
                  <div className={styles.toolbarEmpty}>Order rows by a property.</div>
                )}
                {sorts.map((sort, index) => (
                  <SortRow
                    key={`${sort.propertyId}-${index}`}
                    sort={sort}
                    props={queryableProps}
                    canMoveUp={index > 0}
                    canMoveDown={index < sorts.length - 1}
                    onMove={(dir) => moveSort(index, dir)}
                    onChange={(patch) =>
                      setSorts(sorts.map((item, i) => (i === index ? { ...item, ...patch } : item)))
                    }
                    onRemove={() => setSorts(sorts.filter((_, i) => i !== index))}
                  />
                ))}
                <button type="button" className={styles.toolbarAdd} onClick={addSort}>
                  <Plus size={14} /> Add sort
                </button>
              </div>
              </>
            )}
        </div>

        {searchOpen || search ? (
          <div
            className={styles.dbSearchBox}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              if (search) clearSearchNow();
              else setSearchOpen(false);
            }}
          >
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              value={search}
              aria-label="Search database rows"
              placeholder="Search"
              onChange={(e) => handleSearchChange(e.target.value)}
              onFocus={() => {
                setOpen(null);
                setSearchOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (search) clearSearchNow();
                  else setSearchOpen(false);
                }
              }}
            />
            <button
              type="button"
              aria-label="Close search"
              onClick={() => {
                clearSearchNow();
                setSearchOpen(false);
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
            aria-label="Search database rows"
            title="Search"
            onClick={() => {
              setOpen(null);
              setSearchOpen(true);
            }}
          >
            <Search size={14} aria-hidden="true" />
            <span className={styles.toolbarLabel}>Search</span>
          </button>
        )}
        {compactImportedInline && (
          <>
            <button
              type="button"
              className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
              aria-label="Open database as page"
              title="Open as page"
              onClick={() => {
                window.open(databaseViewLink(dbId, view.id), "_blank", "noopener,noreferrer");
              }}
            >
              <OpenInNew size={14} aria-hidden="true" />
              <span className={styles.toolbarLabel}>Open as page</span>
            </button>
            <button
              type="button"
              className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
              aria-label="Database settings"
              aria-haspopup="dialog"
              aria-expanded={open === "settings"}
              title="Settings"
              disabled={readOnly}
              onClick={(e) => toggleMenu("settings", e.currentTarget)}
            >
              <ListIcon size={14} aria-hidden="true" />
              <span className={styles.toolbarLabel}>Settings</span>
            </button>
            {open === "settings" &&
              renderToolbarMenuLayer(
                <>
                <button
                  type="button"
                  className={styles.menuBackdrop}
                  onClick={() => closeToolbarMenu(true)}
                  tabIndex={-1}
                  aria-label="Close view settings"
                />
                <div
                  ref={toolbarMenuRef}
                  className={`${styles.toolbarMenu} ${styles.viewSettingsMenu}`}
                  style={toolbarMenuStyle}
                  role="dialog"
                  aria-label={databaseViewLabels().viewSettings}
                  onKeyDown={onToolbarMenuKeyDown}
                >
                  <div className={styles.toolbarMenuHead}>
                    <div className={styles.toolbarMenuLabel}>{databaseViewLabels().viewSettingsLabel}</div>
                    <button
                      type="button"
                      className={styles.toolbarMenuClear}
                      aria-label={databaseViewLabels().closeViewSettings}
                      onClick={() => closeToolbarMenu(true)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                  <button
                    type="button"
                    className={styles.viewSettingsViewRow}
                    onClick={() => openRelatedToolbarMenu("layout")}
                  >
                    <span className={styles.viewGlyph}>
                      <ViewTypeIcon type={view.type} />
                    </span>
                    <span>{view.name || "Default view"}</span>
                  </button>
                  <div className={styles.layoutSectionDivider} />
                  <div className={styles.viewSettingsList}>
                    <button type="button" onClick={() => openRelatedToolbarMenu("layout")}>
                      <LayoutIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().layout}</span>
                      <span>{viewTypeSettingsLabel(view.type)}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => openRelatedToolbarMenu("properties")}>
                      <PropertiesIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().propertyVisibility}</span>
                      <span>{hiddenCount > 0 ? databaseViewLabels().hiddenCountSuffix(hiddenCount) : ""}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => openRelatedToolbarMenu("filter")}>
                      <FilterIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().filter}</span>
                      <span>{filterCount > 0 ? databaseViewLabels().countSuffix(filterCount) : ""}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => openRelatedToolbarMenu("sort")}>
                      <SortIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().sort}</span>
                      <span>{sorts.length > 0 ? databaseViewLabels().countSuffix(sorts.length) : ""}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => (isBoardView ? openRelatedToolbarMenu("group") : undefined)}
                      disabled={!isBoardView}
                    >
                      <StatusIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().group}</span>
                      <span>{activeGroupProp && isBoardView ? activeGroupProp.name : ""}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" disabled>
                      <SelectIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().conditionalColor}</span>
                      <span />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => void copyActiveViewLink()}>
                      <LinkIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().copyViewLink}</span>
                      <span />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <div className={styles.layoutSectionDivider} />
                  <div className={styles.toolbarMenuLabel}>{databaseViewLabels().dataSourceSettings}</div>
                  <div className={styles.viewSettingsList}>
                    <button
                      type="button"
                      onClick={() => window.open(databaseViewLink(dbId, view.id), "_blank", "noopener,noreferrer")}
                    >
                      <TableIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().database}</span>
                      <span>{databaseDisplayTitle(pagesById[dbId])}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => openRelatedToolbarMenu("sourceProperties")}>
                      <PropertiesIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().editProperties}</span>
                      <span />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" disabled>
                      <StatusIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().automations}</span>
                      <span />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" disabled>
                      <DotsHorizontal size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().aiAutofill}</span>
                      <span />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" disabled>
                      <Plus size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().moreSettings}</span>
                      <span />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                </>
              )}
          </>
        )}
      </div>
      <div className={styles.dbToolbarSpacer} />
      {!readOnly && (
        <div className={styles.toolbarPopoverWrap}>
          <div className={styles.newTemplateSplit}>
            <button
              type="button"
              className={styles.newTemplateButton}
              onClick={() => void createRowFromTemplate()}
              aria-label={
                defaultTemplate
                  ? databaseViewLabels().newPageFromTemplate(templateDisplayName(defaultTemplate))
                  : databaseViewLabels().newDatabasePage
              }
              title={
                defaultTemplate
                  ? databaseViewLabels().newFromTemplate(templateDisplayName(defaultTemplate))
                  : databaseViewLabels().newPage
              }
            >
              <Plus size={14} aria-hidden="true" />
              {newPageLabel}
            </button>
            <button
              type="button"
              className={styles.newTemplateArrow}
              aria-label="Choose database template"
              aria-haspopup="dialog"
              aria-expanded={open === "templates"}
              onClick={(e) => toggleMenu("templates", e.currentTarget)}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </div>
          {open === "templates" &&
            renderToolbarMenuLayer(
              <>
              <button
                type="button"
                className={styles.menuBackdrop}
                onClick={() => closeToolbarMenu(true)}
                tabIndex={-1}
                aria-label="Close new page menu"
              />
              <div
                ref={toolbarMenuRef}
                className={`${styles.toolbarMenu} ${styles.templateMenu}`}
                style={toolbarMenuStyle}
                role="dialog"
                aria-label="New database page"
                onKeyDown={onToolbarMenuKeyDown}
              >
                <button
                  type="button"
                  className={styles.templatePrimary}
                  onClick={() => void createRowFromTemplate("")}
                >
                  <span className={styles.templateIcon}>
                    <FileText size={15} aria-hidden="true" />
                  </span>
                  <span>
                    <span>{databaseViewLabels().newPage}</span>
                    <span>
                      {defaultTemplate
                        ? databaseViewLabels().createWithoutTemplate
                        : databaseViewLabels().createEmptyPage}
                    </span>
                  </span>
                </button>
                <div className={styles.templateSearch}>
                  <Search size={14} aria-hidden="true" />
                  <input
                    ref={templateSearchRef}
                    value={templateSearch}
                    placeholder={databaseViewLabels().searchTemplates}
                    aria-label={databaseViewLabels().searchTemplates}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowDown") return;
                      e.preventDefault();
                      const items = toolbarMenuItems();
                      const index = items.findIndex((item) => item === e.currentTarget);
                      items[index + 1]?.focus();
                    }}
                  />
                </div>
                <div className={styles.toolbarMenuLabel}>{databaseViewLabels().newFromTemplatesLabel}</div>
                {templates.length === 0 ? (
                  <div className={styles.templateEmpty}>{databaseViewLabels().noTemplates}</div>
                ) : filteredTemplates.length === 0 ? (
                  <div className={styles.templateEmpty}>{databaseViewLabels().noTemplatesFound}</div>
                ) : (
                  <div className={styles.templateList}>
                    {filteredTemplates.map((template) => (
                      <div className={styles.templateRow} key={template.id}>
                        <button
                          type="button"
                          className={styles.templateUse}
                          onClick={() => void createRowFromTemplate(template.id)}
                        >
                          <span className={styles.templateIcon}>
                            <TemplateIconGlyph icon={template.icon} />
                          </span>
                          <span>
                            {templateDisplayName(template)}
                            {template.isDefault ? databaseViewLabels().defaultSuffix : ""}
                          </span>
                        </button>
                        <button
                          type="button"
                          className={styles.templateDefault}
                          data-active={template.isDefault ? "true" : undefined}
                          onClick={() => toggleTemplateDefault(template)}
                        >
                          {template.isDefault ? databaseViewLabels().defaultLabel : databaseViewLabels().setDefault}
                        </button>
                        <button
                          type="button"
                          className={styles.templateEdit}
                          onClick={() => {
                            setOpen(null);
                            setEditingTemplateId(template.id);
                          }}
                        >
                          {databaseViewLabels().edit}
                        </button>
                        <button
                          type="button"
                          className={styles.templateDuplicate}
                          aria-label={databaseViewLabels().duplicateTemplateAria(templateDisplayName(template))}
                          title={databaseViewLabels().duplicate}
                          onClick={() => void duplicateAndEditTemplate(template.id)}
                        >
                          <Copy />
                        </button>
                        <button
                          type="button"
                          className={styles.templateDelete}
                          aria-label={databaseViewLabels().deleteTemplateAria(templateDisplayName(template))}
                          onClick={() => void deleteTemplateWithFeedback(template)}
                        >
                          <Trash size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className={styles.templateSectionDivider} />
                <button
                  type="button"
                  className={styles.templateNewItem}
                  aria-label={databaseViewLabels().createTemplateAria}
                  onClick={() => void createTemplate()}
                >
                  <span className={styles.templateIcon}>
                    <Plus size={15} aria-hidden="true" />
                  </span>
                  <span>{databaseViewLabels().createTemplate}</span>
                </button>
              </div>
              </>
            )}
        </div>
      )}
      {editingTemplate && (
        <TemplateEditorDialog
          key={editingTemplate.id}
          dbId={dbId}
          view={view}
          readOnly={readOnly}
          template={editingTemplate}
          onClose={() => setEditingTemplateId(null)}
          onUse={() => {
            setEditingTemplateId(null);
            void createRowFromTemplate(editingTemplate.id);
          }}
          onDuplicate={() => void duplicateAndEditTemplate(editingTemplate.id)}
          onUpdate={(patch) => updateTemplate(editingTemplate.id, patch)}
        />
      )}
      {typeChangeConfirmDialog}
    </div>
  );
}

function TemplateEditorDialog({
  dbId,
  view,
  readOnly = false,
  template,
  onClose,
  onUse,
  onDuplicate,
  onUpdate,
}: {
  dbId: string;
  view?: DbView;
  readOnly?: boolean;
  template: DbTemplate;
  onClose: () => void;
  onUse: () => void;
  onDuplicate: () => void;
  onUpdate: (patch: Partial<DbTemplate>) => void;
}) {
  const dbPage = useStore((s) => s.pagesById[dbId]);
  const notify = useStore((s) => s.notify);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const dialogRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dbTitle = dbPage ? pageDisplayTitle(dbPage) : databaseViewLabels().databaseFallbackTitle;
  const templateTitle = templateDisplayName(template);
  const showBannerSourceIcon = !!dbPage?.icon || !startsWithEmojiIcon(dbTitle);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      document.body.style.overflow = previous;
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  function close() {
    onClose();
  }

  function useTemplate() {
    setMenuOpen(false);
    onUse();
  }

  async function copyTemplateSourceLink() {
    const ok = await copyText(absolutePageUrl(dbId));
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 1200);
    notify(
      ok ? databaseViewLabels().linkCopiedToast : databaseViewLabels().copyLinkFailed,
      ok ? "success" : "error"
    );
  }

  async function toggleTemplateSourceFavorite() {
    if (!dbPage) return;
    const wasFavorite = !!dbPage.isFavorite;
    try {
      await toggleFavorite(dbId);
      notify(
        wasFavorite ? databaseViewLabels().removedFromFavorites : databaseViewLabels().addedToFavorites,
        "success"
      );
    } catch {
      notify(databaseViewLabels().updateFavoritesFailed, "error");
    }
  }

  const dialog = (
    <>
      <button
        type="button"
        className={styles.templateEditorBackdrop}
        data-mode={expanded ? "page" : "peek"}
        onClick={close}
        tabIndex={-1}
        aria-label="Close template editor"
      />
      <section
        ref={dialogRef}
        className={styles.templateEditor}
        data-mode={expanded ? "page" : "peek"}
        role="dialog"
        aria-modal="true"
        aria-label="Edit database template"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          close();
        }}
      >
        <div className={styles.templateEditorTop}>
          <div
            className={styles.templateEditorChromeSide}
            aria-label={databaseViewLabels().templateViewOptions(templateTitle)}
          >
            <button
              type="button"
              className={styles.templatePeekIcon}
              data-template-editor-close="true"
              title={databaseViewLabels().closeTemplateEditor(templateTitle)}
              aria-label={databaseViewLabels().closeTemplateEditor(templateTitle)}
              onClick={close}
            >
              <DoubleChevronRight size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.templatePeekIcon}
              data-template-editor-open-page="true"
              title={expanded ? databaseViewLabels().collapseTemplateEditor : databaseViewLabels().expandTemplateEditor}
              aria-label={
                expanded ? databaseViewLabels().collapseTemplateEditor : databaseViewLabels().expandTemplateEditor
              }
              aria-pressed={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              <OpenAsPage size={15} aria-hidden="true" />
            </button>
          </div>
          <div className={styles.templateEditorActions}>
            <button
              type="button"
              className={styles.templateShareAction}
              title={copied ? databaseViewLabels().linkCopied(dbTitle) : databaseViewLabels().copyShareLink(dbTitle)}
              aria-label={copied ? databaseViewLabels().linkCopied(dbTitle) : databaseViewLabels().copyShareLink(dbTitle)}
              onClick={() => void copyTemplateSourceLink()}
            >
              <SharePeopleIcon size={15} aria-hidden="true" />
              <span>{databaseViewLabels().share}</span>
            </button>
            <button
              type="button"
              className={styles.templateIconAction}
              title={copied ? databaseViewLabels().linkCopied(dbTitle) : databaseViewLabels().copyLink(dbTitle)}
              aria-label={copied ? databaseViewLabels().linkCopied(dbTitle) : databaseViewLabels().copyLink(dbTitle)}
              onClick={() => void copyTemplateSourceLink()}
            >
              <LinkIcon size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.templateIconAction}
              title={
                dbPage?.isFavorite
                  ? databaseViewLabels().removeFromFavorites(dbTitle)
                  : databaseViewLabels().addToFavorites(dbTitle)
              }
              aria-label={
                dbPage?.isFavorite
                  ? databaseViewLabels().removeFromFavorites(dbTitle)
                  : databaseViewLabels().addToFavorites(dbTitle)
              }
              onClick={() => void toggleTemplateSourceFavorite()}
            >
              {dbPage?.isFavorite ? (
                <StarFilled size={17} aria-hidden="true" />
              ) : (
                <Star size={17} aria-hidden="true" />
              )}
            </button>
            <div className={styles.templateActionWrap} ref={menuRef}>
              <button
                type="button"
                className={styles.templateIconAction}
                title={databaseViewLabels().openTemplateActions}
                aria-label={databaseViewLabels().openTemplateActions}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((current) => !current)}
              >
                <DotsHorizontal size={16} aria-hidden="true" />
              </button>
              {menuOpen && (
                <div className={styles.templateActionMenu} role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onDuplicate();
                    }}
                  >
                    <Copy size={14} aria-hidden="true" />
                    {databaseViewLabels().duplicate}
                  </button>
                  <button type="button" role="menuitem" onClick={useTemplate}>
                    <Plus size={14} aria-hidden="true" />
                    {databaseViewLabels().newPageMenuItem}
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!template.isDefault}
                      onChange={(e) => {
                        onUpdate({ isDefault: e.target.checked });
                        setMenuOpen(false);
                      }}
                    />
                    {databaseViewLabels().defaultTemplateForNewPages}
                  </label>
                  <button type="button" role="menuitem" onClick={close}>
                    <X size={14} aria-hidden="true" />
                    {databaseViewLabels().close}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className={styles.templateEditorBanner}>
          <span>{databaseViewLabels().editingTemplateIn}</span>
          <span className={styles.templateEditorBannerSource}>
            {showBannerSourceIcon ? <TemplateIconGlyph icon={dbPage?.icon} size={16} /> : null}
            {dbTitle}
          </span>
          <span className={styles.templateBannerHelp} aria-hidden="true">
            ?
          </span>
          <button type="button" className={styles.templateBannerDuplicate} onClick={onDuplicate}>
            <Copy size={14} aria-hidden="true" />
            {databaseViewLabels().duplicateGive}
          </button>
        </div>
        {menuOpen && (
          <button
            type="button"
            className={styles.menuBackdrop}
            onClick={() => setMenuOpen(false)}
            tabIndex={-1}
            aria-label="Close template actions"
          />
        )}
        <div className={`${styles.templateEditorScroll} nscroll`}>
          <div className={styles.templateEditorDoc}>
            <TemplateIconPicker template={template} onUpdate={onUpdate} />
            <input
              className={styles.templateEditorName}
              value={templateTitleValue(template)}
              aria-label="Template page title"
              placeholder={databaseViewLabels().templatePageTitlePlaceholder}
              onChange={(e) => onUpdate({ title: e.target.value })}
            />
            <TemplatePageContent
              dbId={dbId}
              view={view}
              readOnly={readOnly}
              template={template}
              onUpdate={onUpdate}
            />
          </div>
        </div>
      </section>
    </>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

const EMPTY_TEMPLATE_EDITOR_BLOCKS: Block[] = [];

function templateIconType(icon?: string): Page["iconType"] {
  if (!icon) return "none";
  if (/^(https?:|data:|blob:)/.test(icon)) return "image";
  return "emoji";
}

function templatePropertiesOrEmpty(properties?: Record<string, unknown>) {
  return properties ?? {};
}

function cleanTemplateProperties(properties?: Record<string, unknown>) {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (value == null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    next[key] = value;
  }
  return next;
}

function TemplatePageContent({
  dbId,
  view,
  readOnly = false,
  template,
  onUpdate,
}: {
  dbId: string;
  view?: DbView;
  readOnly?: boolean;
  template: DbTemplate;
  onUpdate: (patch: Partial<DbTemplate>) => void;
}) {
  const pageId = useMemo(() => templateEditorPageId(template.id), [template.id]);
  const workspaceId = useStore((s) => s.pagesById[dbId]?.workspaceId ?? s.workspace?.id ?? "");
  const row = useStore((s) => s.pagesById[pageId]);
  const blocks = useStore(
    useShallow((s) => s.blocksByPage[pageId] ?? EMPTY_TEMPLATE_EDITOR_BLOCKS)
  );
  const seededTemplateRef = useRef<string | null>(null);
  const lastBlocksSerializedRef = useRef("");
  const lastPropertiesSerializedRef = useRef("");
  // The seed effect below fires once per template.id (guarded by
  // seededTemplateRef) and must NOT re-seed when other template fields change —
  // those changes are handed to the sync effects that follow. Read the live
  // template through a ref so the seed reads current values without listing
  // every field as a dep (which would re-run and wipe the synthetic page).
  const templateRef = useRef(template);
  useEffect(() => {
    templateRef.current = template;
  });
  const templateTitle = templateTitleValue(template);

  useEffect(() => {
    const liveTemplate = templateRef.current;
    const now = new Date().toISOString();
    const initialBlocks = templateBlocksToEditorBlocks(
      pageId,
      templateBlocksOrDefault(liveTemplate.blocks),
      now
    );
    const initialProperties = templatePropertiesOrEmpty(liveTemplate.properties);
    const syntheticPage: Page = {
      id: pageId,
      workspaceId,
      parentId: dbId,
      parentType: "database",
      kind: "page",
      title: templateTitleValue(liveTemplate) || "Untitled",
      icon: liveTemplate.icon ?? "",
      iconType: templateIconType(liveTemplate.icon),
      properties: initialProperties,
      position: liveTemplate.position,
      createdAt: liveTemplate.createdAt ?? now,
      updatedAt: liveTemplate.updatedAt ?? now,
    };

    lastBlocksSerializedRef.current = JSON.stringify(editorBlocksToTemplateBlocks(initialBlocks));
    lastPropertiesSerializedRef.current = JSON.stringify(cleanTemplateProperties(initialProperties));
    seededTemplateRef.current = template.id;
    useStore.setState((state) => ({
      pagesById: {
        ...state.pagesById,
        [pageId]: syntheticPage,
      },
      blocksByPage: {
        ...state.blocksByPage,
        [pageId]: initialBlocks,
      },
      loadedBlockPages: new Set(state.loadedBlockPages).add(pageId),
    }));

    return () => {
      seededTemplateRef.current = null;
      useStore.setState((state) => {
        const pagesById = { ...state.pagesById };
        const blocksByPage = { ...state.blocksByPage };
        const blockHistoryByPage = { ...state.blockHistoryByPage };
        delete pagesById[pageId];
        delete blocksByPage[pageId];
        delete blockHistoryByPage[pageId];
        const loadedBlockPages = new Set(state.loadedBlockPages);
        loadedBlockPages.delete(pageId);
        return {
          pagesById,
          blocksByPage,
          blockHistoryByPage,
          loadedBlockPages,
        };
      });
    };
  }, [
    dbId,
    pageId,
    template.id,
    workspaceId,
  ]);

  useEffect(() => {
    const nextProperties = templatePropertiesOrEmpty(template.properties);
    lastPropertiesSerializedRef.current = JSON.stringify(cleanTemplateProperties(nextProperties));
    useStore.setState((state) => {
      const page = state.pagesById[pageId];
      if (!page) return {};
      return {
        pagesById: {
          ...state.pagesById,
          [pageId]: {
            ...page,
            title: templateTitle || "Untitled",
            icon: template.icon ?? "",
            iconType: templateIconType(template.icon),
            properties: nextProperties,
            updatedAt: template.updatedAt ?? page.updatedAt,
          },
        },
      };
    });
  }, [pageId, templateTitle, template.icon, template.properties, template.updatedAt]);

  useEffect(() => {
    if (seededTemplateRef.current !== template.id || !row) return;
    const next = cleanTemplateProperties(row.properties);
    const serialized = JSON.stringify(next);
    if (serialized === lastPropertiesSerializedRef.current) return;
    lastPropertiesSerializedRef.current = serialized;
    onUpdate({ properties: next });
  }, [onUpdate, row, template.id]);

  useEffect(() => {
    if (seededTemplateRef.current !== template.id) return;
    const next = templateBlocksOrDefault(editorBlocksToTemplateBlocks(blocks));
    const serialized = JSON.stringify(next);
    if (serialized === lastBlocksSerializedRef.current) return;
    lastBlocksSerializedRef.current = serialized;
    onUpdate({ blocks: next });
  }, [blocks, onUpdate, template.id]);

  return (
    <>
      {row && (
        <div className={styles.templateSharedProperties} data-template-shared-properties="true">
          <RowProperties
            dbId={dbId}
            row={row}
            view={view}
            readOnly={readOnly}
            showBackReferences={false}
            showPropertyControls={false}
          />
        </div>
      )}
      <div className={styles.templateCommentsStub}>
        <div className={styles.templateCommentsHeading}>{databaseViewLabels().comments}</div>
        <div className={styles.templateCommentAdd}>
          <span>{databaseViewLabels().me}</span>
          <span>{databaseViewLabels().addComment}</span>
        </div>
      </div>
      <div className={styles.templateBodyDivider} />
      <div className={styles.templateSharedEditor} data-template-shared-editor="true">
        <Editor
          pageId={pageId}
          templateMode
          skipRemoteLoad
          readOnly={readOnly}
          showPageStarter={false}
          emptyBodyPrompt={templateBodyPlaceholder()}
        />
      </div>
    </>
  );
}

function TemplateIconPicker({
  template,
  onUpdate,
}: {
  template: DbTemplate;
  onUpdate: (patch: Partial<DbTemplate>) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  function closePicker() {
    setOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  }

  function updateIcon(icon?: string) {
    onUpdate({ icon });
    closePicker();
  }

  return (
    <div
      className={styles.templateIconField}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.preventDefault();
        e.stopPropagation();
        closePicker();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.templateIconButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={template.icon ? databaseViewLabels().changeTemplateIcon : databaseViewLabels().addTemplateIcon}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.templateIconLarge}>
          <TemplateIconGlyph icon={template.icon} size={18} />
        </span>
        <span>{template.icon ? databaseViewLabels().changeIcon : databaseViewLabels().addIcon}</span>
      </button>
      {open && (
        <EmojiPicker
          placement="inline"
          onPick={(emoji) => updateIcon(emoji)}
          onPickImage={(url) => updateIcon(url)}
          onRemove={() => updateIcon(undefined)}
          onClose={closePicker}
        />
      )}
    </div>
  );
}

function propertyTypeLabel(prop: DbProperty) {
  return typeLabel(prop.type);
}

function ViewNameField({
  name,
  onCommit,
  onClose,
}: {
  name: string;
  onCommit: (name: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(name);

  function commit() {
    const next = draft.trim() || "Untitled";
    if (next !== name) onCommit(next);
  }

  return (
    <label className={styles.viewNameField}>
      <span>{databaseViewLabels().viewName}</span>
      <input
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (isComposingKeyEvent(e)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            onClose();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(name);
            onClose();
          }
        }}
      />
    </label>
  );
}

type FilterGroupEditorProps = {
  group: FilterGroup;
  path: number[];
  props: DbProperty[];
  onSetConjunction: (path: number[], next: "and" | "or") => void;
  onUpdateFilter: (path: number[], index: number, patch: Partial<ViewFilter>) => void;
  onRemoveFilter: (path: number[], index: number) => void;
  onRemoveGroup: (parentPath: number[], index: number) => void;
  onAddFilter: (path: number[]) => void;
  onAddGroup: (path: number[]) => void;
};

/**
 * Recursive editor for one filter group. Its terms are this group's leaf rows
 * followed by its sub-groups; the And/Or connector sits before every term after
 * the first. The first connector is the editable toggle that flips the whole
 * group's conjunction; later connectors are static labels (matching the existing
 * flat-filter UX). Sub-groups render the same editor one level deeper and carry a
 * left border for visual nesting.
 */
function FilterGroupEditor(props: FilterGroupEditorProps) {
  const {
    group,
    path,
    props: dbProps,
    onSetConjunction,
    onUpdateFilter,
    onRemoveFilter,
    onRemoveGroup,
    onAddFilter,
    onAddGroup,
  } = props;
  const subgroups = group.groups ?? [];
  const conjunction = group.conjunction === "or" ? "or" : "and";

  // `termIndex` is the position of a term among (leaves + subgroups) so the
  // connector logic matches the original flat UX: editable toggle at index 1,
  // static label at index 2+.
  function connector(termIndex: number) {
    if (termIndex === 0) return null;
    return (
      <div className={filterStyles.conjunctionRow}>
        {termIndex === 1 ? (
          <div className={filterStyles.conjunctionToggle}>
            {(["and", "or"] as const).map((c) => (
              <button
                key={c}
                type="button"
                data-active={conjunction === c ? "true" : undefined}
                onClick={() => onSetConjunction(path, c)}
              >
                {c === "and" ? "And" : "Or"}
              </button>
            ))}
          </div>
        ) : (
          <span className={filterStyles.conjunctionLabel}>
            {conjunction === "and" ? "And" : "Or"}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={filterStyles.group}>
      {group.filters.map((filter, index) => (
        <div key={`leaf-${index}`}>
          {connector(index)}
          <FilterRow
            filter={filter}
            props={dbProps}
            onChange={(patch) => onUpdateFilter(path, index, patch)}
            onRemove={() => onRemoveFilter(path, index)}
          />
        </div>
      ))}
      {subgroups.map((sub, subIndex) => {
        const termIndex = group.filters.length + subIndex;
        return (
          <div key={`group-${subIndex}`}>
            {connector(termIndex)}
            <div className={filterStyles.subgroup}>
              <div className={filterStyles.subgroupHead}>
                <span className={filterStyles.conjunctionLabel}>Filter group</span>
                <button
                  type="button"
                  className={filterStyles.groupRemove}
                  aria-label="Remove filter group"
                  onClick={() => onRemoveGroup(path, subIndex)}
                >
                  <X size={14} />
                </button>
              </div>
              <FilterGroupEditor
                group={sub}
                path={[...path, subIndex]}
                props={dbProps}
                onSetConjunction={onSetConjunction}
                onUpdateFilter={onUpdateFilter}
                onRemoveFilter={onRemoveFilter}
                onRemoveGroup={onRemoveGroup}
                onAddFilter={onAddFilter}
                onAddGroup={onAddGroup}
              />
            </div>
          </div>
        );
      })}
      <div className={filterStyles.addRow}>
        <button type="button" className={filterStyles.addBtn} onClick={() => onAddFilter(path)}>
          <Plus size={14} /> Add filter
        </button>
        <button type="button" className={filterStyles.addBtn} onClick={() => onAddGroup(path)}>
          <Plus size={14} /> Add filter group
        </button>
      </div>
    </div>
  );
}

function FilterRow({
  filter,
  props,
  onChange,
  onRemove,
}: {
  filter: ViewFilter;
  props: DbProperty[];
  onChange: (patch: Partial<ViewFilter>) => void;
  onRemove: () => void;
}) {
  const prop = props.find((p) => p.id === filter.propertyId) ?? props[0];
  if (!prop) return null;
  const operators = operatorsFor(prop);
  const operator = effectiveFilterOperator(prop, filter.operator);
  const propertyOptions = props.map((p) => ({
    value: p.id,
    label: p.name || "Untitled",
    icon: <PropertyTypeIcon type={p.type} size={14} />,
  }));
  const operatorLabels = pickLabels(FILTER_OPERATOR_LABELS);
  const operatorOptions = operators.map((op) => ({ value: op, label: operatorLabels[op] }));

  return (
    <div className={styles.ruleRow} data-filter-row>
      <NotionSelect
        ariaLabel="Filter property"
        value={prop.id}
        options={propertyOptions}
        onChange={(value) => {
          const nextProp = props.find((p) => p.id === value) ?? prop;
          onChange({
            propertyId: nextProp.id,
            operator: defaultOperator(nextProp),
            value: defaultValue(nextProp),
          });
        }}
      />
      <NotionSelect
        ariaLabel="Filter condition"
        value={operator}
        options={operatorOptions}
        onChange={(value) => onChange({ operator: value as FilterOperator })}
      />
      {!NO_VALUE_FILTERS.has(operator) ? (
        <FilterValueInput
          prop={prop}
          value={filter.value}
          onChange={(value) => onChange({ operator, value })}
        />
      ) : (
        <span className={styles.ruleSpacer} />
      )}
      <button type="button" className={styles.ruleRemove} aria-label="Remove filter" onClick={onRemove}>
        <X size={14} />
      </button>
    </div>
  );
}

function SortRow({
  sort,
  props,
  canMoveUp,
  canMoveDown,
  onMove,
  onChange,
  onRemove,
}: {
  sort: ViewSort;
  props: DbProperty[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onChange: (patch: Partial<ViewSort>) => void;
  onRemove: () => void;
}) {
  const propertyOptions = props.map((p) => ({
    value: p.id,
    label: p.name || "Untitled",
    icon: <PropertyTypeIcon type={p.type} size={14} />,
  }));
  return (
    <div className={styles.ruleRow} data-sort-row>
      <NotionSelect
        ariaLabel="Sort property"
        value={sort.propertyId}
        options={propertyOptions}
        onChange={(value) => onChange({ propertyId: value })}
      />
      <NotionSelect
        ariaLabel="Sort direction"
        value={sort.direction}
        options={[
          { value: "asc", label: "Ascending" },
          { value: "desc", label: "Descending" },
        ]}
        onChange={(value) => onChange({ direction: value as ViewSort["direction"] })}
      />
      <div className={styles.ruleReorder}>
        <button
          type="button"
          aria-label="Move sort up"
          disabled={!canMoveUp}
          onClick={() => onMove(-1)}
        >
          <ArrowUp size={13} />
        </button>
        <button
          type="button"
          aria-label="Move sort down"
          disabled={!canMoveDown}
          onClick={() => onMove(1)}
        >
          <ArrowDown size={13} />
        </button>
      </div>
      <button type="button" className={styles.ruleRemove} aria-label="Remove sort" onClick={onRemove}>
        <X size={14} />
      </button>
    </div>
  );
}

function FilterValueInput({
  prop,
  value,
  onChange,
}: {
  prop: DbProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (prop.type === "checkbox") {
    return (
      <NotionSelect
        ariaLabel={`Filter value for ${prop.name}`}
        value={String(value ?? true)}
        options={[
          { value: "true", label: "Checked" },
          { value: "false", label: "Unchecked" },
        ]}
        onChange={(next) => onChange(next === "true")}
      />
    );
  }

  if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") {
    return (
      <NotionSelect
        ariaLabel={`Filter value for ${prop.name}`}
        value={selectFilterValue(prop, value)}
        options={selectFilterOptions(prop, value)}
        onChange={onChange}
      />
    );
  }

  if (prop.type === "person" || prop.type === "created_by" || prop.type === "last_edited_by") {
    return <PersonFilterValue value={value} onChange={onChange} label={prop.name} />;
  }

  if (prop.type === "relation") {
    return <RelationFilterValue prop={prop} value={value} onChange={onChange} />;
  }

  if (prop.type === "rollup") {
    return <RollupFilterValue prop={prop} value={value} onChange={onChange} />;
  }

  if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") {
    return (
      <DateTextInput
        ariaLabel={`Filter value for ${prop.name}`}
        value={value}
        onChange={onChange}
      />
    );
  }

  if (prop.type === "number" || prop.type === "unique_id") {
    return (
      <NumberTextInput
        ariaLabel={`Filter value for ${prop.name}`}
        value={value}
        placeholder="Value"
        onChange={onChange}
      />
    );
  }

  return (
    <input
      aria-label={`Filter value for ${prop.name}`}
      type="text"
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Value"
    />
  );
}

function PersonFilterValue({
  value,
  onChange,
  label,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
}) {
  const userId = useStore((s) => s.userId) ?? "local-user";
  const workspaceMembers = useStore(useShallow((s) => s.workspaceMembers));
  const organizationProfiles = useStore(useShallow((s) => s.organizationProfiles));
  const selectedValue = String(value ?? "").trim();
  const options = personFilterOptions({
    currentUserId: userId,
    organizationProfiles,
    selectedValue,
    workspaceMembers,
  });
  return (
    <NotionSelect
      ariaLabel={`Filter value for ${label}`}
      value={selectedValue}
      options={options}
      onChange={onChange}
    />
  );
}

function RelationFilterValue({
  prop,
  value,
  onChange,
}: {
  prop: DbProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const targetDbId = prop.config?.relationDatabaseId ?? prop.databaseId;
  const loadDatabase = useStore((s) => s.loadDatabase);
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const rows = useStore(useShallow((s) => (targetDbId ? s.dbRows(targetDbId) : [])));
  const selectedValue = relationFilterSelectValue(value);
  const selectedRowId = selectedValue === "__current_page__" ? "" : selectedValue;
  const selectedRow = selectedRowId ? pagesById[selectedRowId] : undefined;
  const rowOptions = rows.map((row) => ({
    value: row.id,
    label: pageDisplayTitle(row),
    icon: <PageIconGlyph page={row} size={14} />,
  }));
  const selectedRowOption = selectedRowId
    ? rowOptions.find((option) => option.value === selectedRowId)
    : undefined;
  const orderedRowOptions = selectedRowOption
    ? [
        selectedRowOption,
        ...rowOptions.filter((option) => option.value !== selectedRowOption.value),
      ]
    : rowOptions;
  const selectedFallbackOption =
    selectedRowId && !selectedRowOption
      ? [
          {
            value: selectedRowId,
            label: selectedRow ? pageDisplayTitle(selectedRow) : selectedRowId,
            icon: selectedRow ? <PageIconGlyph page={selectedRow} size={14} /> : undefined,
          },
        ]
      : [];

  useEffect(() => {
    if (!targetDbId) return;
    void loadDatabase(targetDbId);
  }, [loadDatabase, targetDbId]);

  return (
    <NotionSelect
      ariaLabel={`Filter value for ${prop.name}`}
      value={selectedValue}
      options={[
        { value: "", label: databaseViewLabels().choosePage, disabled: true },
        { value: "__current_page__", label: databaseViewLabels().currentPage },
        ...selectedFallbackOption,
        ...orderedRowOptions,
      ]}
      onChange={(next) => onChange(next === "__current_page__" ? currentPageFilterValue() : next)}
    />
  );
}

function RollupFilterValue({
  prop,
  value,
  onChange,
}: {
  prop: DbProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const sourceProps = useStore(useShallow((s) => s.dbProperties(prop.databaseId)));
  const loadDatabase = useStore((s) => s.loadDatabase);
  const relationProp = sourceProps.find(
    (candidate) => candidate.type === "relation" && candidate.id === prop.config?.rollupRelationPropertyId
  );
  const firstHopDbId = relationProp?.config?.relationDatabaseId ?? relationProp?.databaseId;
  const firstHopProps = useStore(useShallow((s) => (firstHopDbId ? s.dbProperties(firstHopDbId) : [])));
  const targetProp = firstHopProps.find((candidate) => candidate.id === prop.config?.rollupTargetPropertyId);
  const rollupFunction = prop.config?.rollupFunction ?? "show_original";

  useEffect(() => {
    if (firstHopDbId) void loadDatabase(firstHopDbId, { rows: false });
  }, [firstHopDbId, loadDatabase]);

  if (NUMERIC_ROLLUP_FUNCTIONS.has(rollupFunction)) {
    return (
      <NumberTextInput
        ariaLabel={`Filter value for ${prop.name}`}
        value={value}
        placeholder="Value"
        onChange={onChange}
      />
    );
  }

  if (DATE_ROLLUP_FUNCTIONS.has(rollupFunction)) {
    return (
      <DateTextInput
        ariaLabel={`Filter value for ${prop.name}`}
        value={value}
        onChange={onChange}
      />
    );
  }

  const relationTargetDbId =
    !targetProp
      ? firstHopDbId
      : targetProp.type === "relation"
        ? targetProp.config?.relationDatabaseId ?? targetProp.databaseId
        : undefined;

  if (relationTargetDbId) {
    const relationLikeProp: DbProperty = {
      ...prop,
      type: "relation",
      config: { ...(prop.config ?? {}), relationDatabaseId: relationTargetDbId },
    };
    return <RelationFilterValue prop={relationLikeProp} value={value} onChange={onChange} />;
  }

  return (
    <input
      aria-label={`Filter value for ${prop.name}`}
      type="text"
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Value"
    />
  );
}

function relationFilterSelectValue(value: unknown) {
  if (isCurrentPageFilterValue(value)) return "__current_page__";
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => isCurrentPageFilterValue(item))) return "__current_page__";
  return values.map((item) => String(item ?? "").trim()).find(Boolean) ?? "";
}

function selectFilterValue(prop: DbProperty, value: unknown) {
  const raw = String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  return (
    prop.config?.options?.find(
      (option) => option.id.toLowerCase() === lower || option.name.toLowerCase() === lower
    )?.id ?? raw
  );
}

function selectFilterOptions(prop: DbProperty, value: unknown) {
  const selected = selectFilterValue(prop, value);
  const options = [
    { value: "", label: "Choose option", disabled: true },
    ...(prop.config?.options ?? []).map((option) => ({
      value: option.id,
      label: option.name,
    })),
  ];
  if (!selected || options.some((option) => option.value === selected)) return options;
  return [
    ...options,
    { value: selected, label: String(Array.isArray(value) ? value[0] ?? selected : value ?? selected) },
  ];
}

function operatorsFor(prop: DbProperty): FilterOperator[] {
  switch (prop.type) {
    case "number":
    case "unique_id":
      return ["equals", "does_not_equal", "greater_than", "less_than", "is_empty", "is_not_empty"];
    case "date":
    case "created_time":
    case "last_edited_time":
      return ["on_or_after", "on_or_before", "equals", "is_empty", "is_not_empty"];
    case "checkbox":
      return ["equals", "does_not_equal"];
    case "select":
    case "status":
      return ["equals", "does_not_equal", "is_empty", "is_not_empty"];
    case "multi_select":
      return ["contains", "does_not_contain", "is_empty", "is_not_empty"];
    case "person":
    case "created_by":
    case "last_edited_by":
    case "relation":
      return ["contains", "does_not_contain", "is_empty", "is_not_empty"];
    case "files":
      return ["is_empty", "is_not_empty"];
    case "rollup":
      if (NUMERIC_ROLLUP_FUNCTIONS.has(prop.config?.rollupFunction ?? "show_original")) {
        return ["equals", "does_not_equal", "greater_than", "less_than", "is_empty", "is_not_empty"];
      }
      if (DATE_ROLLUP_FUNCTIONS.has(prop.config?.rollupFunction ?? "show_original")) {
        return ["on_or_after", "on_or_before", "equals", "is_empty", "is_not_empty"];
      }
      return ["contains", "does_not_contain", "equals", "does_not_equal", "is_empty", "is_not_empty"];
    default:
      return ["contains", "does_not_contain", "equals", "does_not_equal", "is_empty", "is_not_empty"];
  }
}

function defaultOperator(prop: DbProperty): FilterOperator {
  // A select/status with no options can only sensibly filter on empty/not-empty;
  // defaulting to "equals (no value)" would silently hide every non-empty row.
  if (
    (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") &&
    !prop.config?.options?.length
  ) {
    return "is_not_empty";
  }
  return operatorsFor(prop)[0];
}

function defaultValue(prop: DbProperty): unknown {
  if (prop.type === "checkbox") return true;
  if (prop.type === "number") return 0;
  if (prop.type === "unique_id") return 0;
  if (prop.type === "rollup" && NUMERIC_ROLLUP_FUNCTIONS.has(prop.config?.rollupFunction ?? "show_original")) return 0;
  if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") {
    return prop.config?.options?.[0]?.id ?? "";
  }
  return "";
}

function personFilterOptions({
  currentUserId,
  organizationProfiles,
  selectedValue,
  workspaceMembers,
}: {
  currentUserId: string;
  organizationProfiles: OrganizationProfile[];
  selectedValue: string;
  workspaceMembers: WorkspaceMember[];
}) {
  const options = new Map<string, { value: string; label: string }>();
  const add = (id: string | null | undefined, label?: string | null, email?: string | null) => {
    const value = id?.trim();
    if (!value || options.has(value)) return;
    const display = label?.trim() || email?.trim() || personLabel(value, currentUserId);
    options.set(value, { value, label: display });
  };

  add(currentUserId, personLabel(currentUserId, currentUserId));
  for (const member of workspaceMembers) add(member.userId, member.displayName, member.email);
  for (const profile of organizationProfiles) add(profile.userId, profile.displayName, profile.email);
  if (selectedValue && !options.has(selectedValue)) {
    options.set(selectedValue, { value: selectedValue, label: personLabel(selectedValue, currentUserId) });
  }

  return [
    { value: "", label: "Choose person", disabled: true },
    ...Array.from(options.values()).slice(0, 80),
  ];
}
