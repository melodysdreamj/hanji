"use client";

import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  applyNotionImportJobRemote,
  cancelNotionImportJobRemote,
  completeNotionOAuthConnectionRemote,
  createNotionImportConnectionRemote,
  createNotionImportJobRemote,
  discoverNotionImportJobRemote,
  listNotionImportConnectionsRemote,
  listNotionImportJobsRemote,
  listNotionImportRootsRemote,
  planNotionImportJobRemote,
  repairNotionImportPageIndexesRemote,
  revokeNotionImportConnectionRemote,
  retryNotionImportFileCopiesRemote,
  retryNotionImportJobRemote,
  importNativeRemote,
  type HanjiExportDocument,
  type NativeExportWarning,
} from "@/lib/edgebase";
import { useRouter } from "@/lib/router";
import { pageHref } from "@/lib/navigation";
import { pickLabels } from "@/lib/i18n";
import type {
  NotionImportConnection,
  NotionImportJob,
  NotionImportRootCandidate,
  NotionImportRootScanItem,
} from "@/lib/types";
import { Database, FileText, GlobeIcon, TableIcon, Upload, X } from "./icons";
import NotionTokenGuide from "./NotionTokenGuide";
import { useStore } from "@/lib/store";
import styles from "./ImportDialog.module.css";

const ACCEPTED_IMPORTS = ".md,.markdown,.txt,.csv,text/markdown,text/plain,text/csv,application/csv";
const NOTION_OAUTH_CALLBACK_PARAM = "notion_import_oauth";
const NOTION_TOKEN_URL = "https://www.notion.so/profile/integrations";
const NOTION_TOKEN_HELP_URL = "https://www.notion.com/help/create-integrations-with-the-notion-api";
const NOTION_ROOT_SCAN_BATCH_PAGES = 1;
const NOTION_ROOT_SCAN_MAX_BATCHES = 50;

type ImportReportIssue = {
  code?: string;
  message?: string;
  notionId?: string;
  notionObject?: string;
};

type ImportConversionReport = {
  summary?: Record<string, number>;
  warnings?: ImportReportIssue[];
  unsupported?: ImportReportIssue[];
  missingPermissions?: ImportReportIssue[];
  unresolvedReferences?: ImportReportIssue[];
};

type ImportReport = {
  conversion?: ImportConversionReport;
  fileRetry?: {
    scanned?: number;
    copied?: number;
    skipped?: number;
    conversion?: ImportConversionReport;
  };
  plan?: {
    estimatedWrites?: Record<string, number>;
    conversion?: ImportConversionReport;
  };
  warnings?: unknown[];
  unsupported?: unknown[];
  missingPermissions?: unknown[];
  applied?: Record<string, number>;
};

type ImportProgressStep = {
  key: string;
  label?: string;
  status?: string;
};

const WRITE_KEYS = [
  "pages",
  "databases",
  "rows",
  "blocks",
  "properties",
  "views",
  "templates",
  "mappings",
  "fileCopies",
  "fileCopySkipped",
  "remappedProperties",
  "remappedRowRelations",
  "remappedTemplateRelations",
];

const SUMMARY_KEYS = [
  "unsupportedBlocks",
  "unsupportedProperties",
  "unsupportedViews",
  "unresolvedLinkedTargets",
  "unresolvedLinkedViews",
  "unresolvedPropertyReferences",
  "unresolvedRowRelationValues",
  "unresolvedTemplateRelationValues",
  "fileReferences",
  "fileCopies",
  "fileCopySkipped",
  "filesNeedCopy",
  "temporaryFileReferences",
  "externalFileReferences",
  "truncatedMarkdownPages",
  "unknownMarkdownBlocks",
  "discoveryIncomplete",
  "notionUserReferences",
  "remappedRichTextMentions",
  "unresolvedRichTextMentions",
];

const METRIC_LABELS_EN: Record<string, string> = {
  blocks: "blocks",
  databases: "databases",
  discoveryIncomplete: "incomplete discovery",
  externalFileReferences: "external files",
  fileCopies: "files copied",
  fileCopySkipped: "files skipped",
  fileReferences: "file refs",
  filesNeedCopy: "files needing copy",
  mappings: "mappings",
  missing: "missing access",
  notionUserReferences: "Notion user refs",
  pages: "pages",
  properties: "properties",
  remappedProperties: "property remaps",
  remappedRichTextMentions: "rich text link remaps",
  remappedRowRelations: "row relation remaps",
  remappedTemplateRelations: "template relation remaps",
  rows: "rows",
  templates: "templates",
  temporaryFileReferences: "temporary files",
  truncatedMarkdownPages: "truncated markdown",
  unknownMarkdownBlocks: "unknown markdown blocks",
  unresolved: "unresolved",
  unresolvedLinkedTargets: "unresolved links",
  unresolvedLinkedViews: "unresolved views",
  unresolvedPropertyReferences: "unresolved properties",
  unresolvedRichTextMentions: "unresolved rich text links",
  unresolvedRowRelationValues: "unresolved row values",
  unresolvedTemplateRelationValues: "unresolved template values",
  unsupported: "unsupported",
  unsupportedBlocks: "unsupported blocks",
  unsupportedProperties: "unsupported properties",
  unsupportedViews: "unsupported views",
  views: "views",
  warnings: "warnings",
};

const METRIC_LABELS_KO: Record<string, string> = {
  blocks: "블록",
  databases: "데이터베이스",
  discoveryIncomplete: "미완료 검색",
  externalFileReferences: "외부 파일",
  fileCopies: "복사한 파일",
  fileCopySkipped: "건너뛴 파일",
  fileReferences: "파일 참조",
  filesNeedCopy: "복사 필요 파일",
  mappings: "매핑",
  missing: "접근 권한 없음",
  notionUserReferences: "Notion 사용자 참조",
  pages: "페이지",
  properties: "속성",
  remappedProperties: "속성 재연결",
  remappedRichTextMentions: "본문 링크 재연결",
  remappedRowRelations: "행 관계 재연결",
  remappedTemplateRelations: "템플릿 관계 재연결",
  rows: "행",
  templates: "템플릿",
  temporaryFileReferences: "임시 파일",
  truncatedMarkdownPages: "잘린 마크다운",
  unknownMarkdownBlocks: "알 수 없는 마크다운 블록",
  unresolved: "미해결",
  unresolvedLinkedTargets: "미해결 링크",
  unresolvedLinkedViews: "미해결 뷰",
  unresolvedPropertyReferences: "미해결 속성",
  unresolvedRichTextMentions: "미해결 본문 링크",
  unresolvedRowRelationValues: "미해결 행 값",
  unresolvedTemplateRelationValues: "미해결 템플릿 값",
  unsupported: "미지원",
  unsupportedBlocks: "미지원 블록",
  unsupportedProperties: "미지원 속성",
  unsupportedViews: "미지원 뷰",
  views: "뷰",
  warnings: "경고",
};

const COUNT_UNITS_KO: Record<string, string> = {
  page: "페이지",
  database: "데이터베이스",
  data_source: "데이터베이스",
  root_page: "루트 페이지",
  block: "블록",
  view: "뷰",
  comment: "댓글",
};

const IMPORT_LABELS = {
  en: {
    title: "Import",
    close: "Close import",
    navAria: "Import sources",
    file: "File",
    notion: "Notion",
    chooseFile: "Choose a file",
    chooseFileButton: "Choose file",
    importingFile: "Importing...",
    dropToImport: "Drop to import",
    preparingImport: "Preparing import",
    supportedImports: "Supported imports",
    markdownExts: ".md, .markdown, .txt",
    destinationNote: "Imported content is added to this workspace as new top-level pages.",
    stepConnect: "Prepare Notion token",
    stepScope: "Choose what to import",
    stepProgress: "Progress",
    connectedTo: (name: string) => `Connected to ${name}`,
    savedConnection: "Saved connection",
    oneTimeToken: "Use one-time token",
    remove: "Remove",
    shareReminder:
      "A token does not automatically see every page. Share the top-level pages or databases you want to import with this connection in Notion first.",
    tokenIntroTitle: "Import with a Notion API token",
    tokenIntroDesc:
      "For local hosting, pasting a token you create in Notion is the most reliable setup. No OAuth app secret is needed in this app.",
    openTokenPage: "Open Notion token page",
    tokenHelpLink: "Setup guide",
    tokenInstructionsTitle: "Before importing",
    tokenInstructionItems: [
      "Open the Notion token page, create a personal access token or internal connection, and copy the token.",
      "Use a current Notion API token that starts with ntn_.",
      "Give the connection read content access. Add user-info access if you need people fields.",
      "In Notion, open each top-level page or database, then use Share or Connections to add this connection.",
    ],
    tokenSummary: "Use an API token",
    tokenLabel: "Notion API token",
    tokenPlaceholder: "ntn_...",
    connectionNameLabel: "Connection name",
    optional: "Optional",
    saveConnection: "Save connection",
    connectionStorageUnavailable:
      "Tokens are used for this import only and are never stored on this server. To enable saved connections, configure NOTIONLIKE_NOTION_IMPORT_SECRET on the backend.",
    scopeWorkspace: "Entire workspace",
    recommended: "Recommended",
    scopeWorkspaceDesc: "Everything the connection can access. Database relations between pages stay intact.",
    scopePages: "Specific pages",
    scopePagesDesc: "Scan accessible top-level items, then import only the selected pages/databases and their children.",
    scanRoots: "Scan accessible roots",
    scanningRoots: "Scanning...",
    rootScanHint:
      "Scans pages and data sources shared with the token or saved connection above.",
    rootScanProgress: (roots: number, scanned: number, pages: number) =>
      `Scanning... ${roots} root candidate${roots === 1 ? "" : "s"} · ${scanned} item${scanned === 1 ? "" : "s"} checked · ${pages} request${pages === 1 ? "" : "s"}`,
    rootScanFound: (roots: number, scanned: number) => `${roots} root candidate${roots === 1 ? "" : "s"} · ${scanned} item${scanned === 1 ? "" : "s"} checked`,
    rootScanComplete: (roots: number) => `Found ${roots} accessible root candidate${roots === 1 ? "" : "s"}.`,
    rootScanEmpty: "No shared top-level items were found. Share a top-level page or database with the connection in Notion, then scan again.",
    rootScanWorkspaceLabel: (name: string) => `Notion workspace: ${name}`,
    rootScanEmptyTitle: (workspaceName?: string | null) =>
      workspaceName
        ? `The token works and is connected to the Notion workspace “${workspaceName}” — but no pages are shared with this integration yet.`
        : "The token works — but no pages are shared with this integration yet.",
    rootScanEmptyWhy:
      "Notion integrations can only see pages that are explicitly connected to them. Creating a token alone shows nothing.",
    rootScanEmptyStep1:
      "In Notion, open the top-level page you want to import → ··· menu → Connections → add this integration.",
    rootScanEmptyStep2:
      "Or open notion.so/profile/integrations → your integration → Access tab, and pick pages there.",
    rootScanEmptyStep3:
      "Sharing one top-level page includes all of its subpages and databases. Then scan again here.",
    rootScanEmptyOtherWorkspace: (workspaceName?: string | null) =>
      workspaceName
        ? `If the pages live in a Notion workspace other than “${workspaceName}”, this token can't see them — create an integration in that workspace and use its token instead.`
        : "If the pages live in a different Notion workspace, this token can't see them — create an integration in that workspace and use its token instead.",
    rootScanHasMore: "Notion returned more items. If a root is missing, share only the root pages you need or use entire workspace import.",
    rootPickerTitle: "Accessible top-level items",
    rootSelectionCount: (selected: number, total: number) => `${selected} of ${total} selected`,
    selectAllRoots: "Select all",
    clearRootSelection: "Clear",
    manualRootFallback: "Paste links or IDs instead (advanced)",
    rootKindPage: "Page",
    rootKindDataSource: "Database",
    rootIdsLabel: "Page links or IDs",
    rootIdsPlaceholder: "Paste Notion page links or IDs — one per line",
    pagesRecognized: (count: number) => `${count} root item${count === 1 ? "" : "s"} selected`,
    scopeWarning: "Relations that point at databases outside these pages may import as empty placeholders.",
    fullWidthPages: "Import pages in full width",
    fullWidthPagesDesc:
      "Notion doesn't expose the original Full width toggle. Keep this on to make imported non-database-row pages wide.",
    startDiscovery: "Start discovery",
    discovering: "Discovering...",
    discoveredStat: "Discovered",
    importedStat: "Imported",
    filesStat: "Files",
    copied: "copied",
    skipped: "skipped",
    ofTotal: (done: number, total: number) => `${done} of ${total}`,
    moreAvailable: "more available",
    entireWorkspaceScope: "entire workspace",
    rootPagesScope: (count: number) => `${count} root page${count === 1 ? "" : "s"}`,
    discoveredItems: (count: number) => `${count} discovered item${count === 1 ? "" : "s"}`,
    importedItems: (count: number) => `${count} imported item${count === 1 ? "" : "s"}`,
    noDiscovered: "No discovered items",
    formatMetric: (value: number, label: string) => `${value} ${label}`,
    review: "Review",
    apply: "Apply",
    expand: "Expand",
    retry: "Retry",
    retryFiles: "Retry files",
    cancelImport: "Cancel import",
    cancellingImport: "Cancelling...",
    importCancelled: "Notion import cancelled.",
    cantCancelImport: "Couldn't cancel Notion import.",
    openImportedPage: "Open imported page",
    notionWorkspace: "Notion workspace",
    status: {
      queued: "Queued",
      discovering: "Discovering",
      ready: "Ready",
      completed: "Complete",
      failed: "Failed",
      cancelled: "Cancelled",
    } as Record<string, string>,
    progressSteps: {
      connect: "Connect",
      discover: "Discover",
      review: "Review",
      apply: "Apply",
      file_copy_retry: "File retry",
      cancel: "Cancel",
    } as Record<string, string>,
    metric: (key: string) => METRIC_LABELS_EN[key] ?? key,
    countUnit: (key: string, value: number) => `${value} ${key}`,
    issueGroups: {
      unsupported: "Unsupported",
      unresolved: "Unresolved",
      missing: "Missing access",
      warnings: "Warnings",
    } as Record<string, string>,
    markdownNoun: (kind: string, count: number) => {
      const noun = kind === "database" ? "row" : "block";
      return `Imported ${count} ${noun}${count === 1 ? "" : "s"}.`;
    },
    emptyDatabaseImported: "Imported an empty database.",
    noMarkdownBlocks: "No Markdown blocks found.",
    useSupportedFile: "Use a Markdown, text, or CSV file.",
    cantImportFile: "Couldn't import file.",
    tokenOrConnectionRequired: "Enter a Notion API token or select a saved connection.",
    rootPagesRequired: "Select at least one scanned root item, paste a page link or ID, or switch to entire workspace.",
    foundItems: (count: number) => `Found ${count} Notion item${count === 1 ? "" : "s"}.`,
    jobCreated: "Notion import job created.",
    cantStartImport: "Couldn't start Notion import.",
    tokenRequired: "Notion token is required.",
    tokenMustStartWithNtn: "Use a Notion API token that starts with ntn_.",
    connectionSaved: "Notion connection saved.",
    cantSaveConnection: "Couldn't save Notion connection.",
    oauthSaved: "Notion OAuth connection saved.",
    oauthCancelled: (reason: string) => `Notion connection cancelled: ${reason}`,
    oauthMissingCode: "Notion connection callback was missing code or state.",
    cantFinishOAuth: "Couldn't finish Notion OAuth.",
    connectionRemoved: "Notion connection removed.",
    cantRemoveConnection: "Couldn't remove Notion connection.",
    reviewReady: "Notion import review ready.",
    cantReview: "Couldn't review Notion import.",
    expandNeedsCredential: "Enter a Notion token or select a saved connection to expand discovery.",
    rootScanNeedsCredential: "Enter a Notion API token or select a saved connection before scanning.",
    discoveryExpanded: (count: number) => `Discovery expanded: ${count} Notion item${count === 1 ? "" : "s"}.`,
    cantScanRoots: "Couldn't scan Notion roots.",
    cantExpand: "Couldn't expand Notion discovery.",
    importApplied: "Notion import applied.",
    cantApply: "Couldn't apply Notion import.",
    fileRetryFinished: (copied: number, skipped: number) =>
      `File copy retry finished: ${copied} copied, ${skipped} skipped.`,
    cantRetryFiles: "Couldn't retry Notion file copies.",
    hanji: {
      tab: "Hanji",
      title: "Import from Hanji",
      fromFile: "From a file",
      fromLive: "From a live instance",
      choose: "Choose an .hanji.json file",
      chooseButton: "Choose file",
      fileHint:
        "Export a page, database, or workspace from another Hanji, then import it here. Relations, rollups, formulas, views, and templates are preserved. Attachments are not included.",
      selected: (name: string) => `Selected: ${name}`,
      importButton: "Import",
      importing: "Importing...",
      remoteUrl: "Remote Hanji URL",
      remoteUrlPlaceholder: "https://…",
      remoteWorkspace: "Workspace id",
      remoteToken: "Access token",
      remoteTokenOptional: "optional",
      fetch: "Fetch export",
      fetching: "Fetching...",
      liveHint:
        "Pull a workspace directly from another running Hanji (for example a Docker dev instance). The remote must allow requests from this address.",
      review: (summary: string) => `Ready to import: ${summary}`,
      placeholderNote: "Some attachments were left as placeholders.",
      importedItems: (count: number) => `Imported ${count} item${count === 1 ? "" : "s"} from the Hanji file.`,
      cantRead: "Couldn't read the Hanji file.",
      cantImport: "Couldn't import the Hanji file.",
      needFile: "Choose an Hanji file first.",
      needRemote: "Enter the remote Hanji URL and workspace id.",
    },
  },
  ko: {
    title: "가져오기",
    close: "가져오기 닫기",
    navAria: "가져오기 소스",
    file: "파일",
    notion: "Notion",
    chooseFile: "파일 선택",
    chooseFileButton: "파일 선택",
    importingFile: "가져오는 중...",
    dropToImport: "여기에 놓아서 가져오기",
    preparingImport: "가져오기 준비 중",
    supportedImports: "지원 형식",
    markdownExts: ".md, .markdown, .txt",
    destinationNote: "가져온 콘텐츠는 이 워크스페이스에 새 최상위 페이지로 추가됩니다.",
    stepConnect: "Notion API 토큰 준비",
    stepScope: "가져올 범위 선택",
    stepProgress: "진행 상황",
    connectedTo: (name: string) => `${name}에 연결됨`,
    savedConnection: "저장된 연결",
    oneTimeToken: "일회용 토큰 사용",
    remove: "삭제",
    shareReminder:
      "토큰만으로는 워크스페이스 전체를 자동으로 볼 수 없어요. 가져올 최상위 페이지나 데이터베이스를 Notion에서 이 연결에 공유해 주세요.",
    tokenIntroTitle: "Notion API 토큰으로 가져오기",
    tokenIntroDesc:
      "로컬호스팅에서는 OAuth 앱 비밀값을 따로 운영하는 대신, Notion에서 만든 토큰을 붙여넣는 방식이 가장 안정적이에요.",
    openTokenPage: "Notion 토큰 만들기",
    tokenHelpLink: "설정 방법 보기",
    tokenInstructionsTitle: "토큰을 만들 때 확인할 것",
    tokenInstructionItems: [
      "Notion 토큰 페이지를 열고 개인 액세스 토큰 또는 내부 연결을 만든 뒤 토큰을 복사해 주세요.",
      "현재 Notion API 토큰은 ntn_... 형태만 사용해 주세요.",
      "콘텐츠 읽기 권한을 켜 주세요. 담당자/사용자 정보를 가져와야 하면 사용자 정보 읽기도 허용해 주세요.",
      "가져올 최상위 페이지나 데이터베이스에서 공유 또는 연결 메뉴를 열고, 방금 만든 연결을 추가해 주세요.",
    ],
    tokenSummary: "API 토큰으로 직접 연결",
    tokenLabel: "Notion API 토큰",
    tokenPlaceholder: "ntn_...",
    connectionNameLabel: "연결 이름",
    optional: "선택 사항",
    saveConnection: "연결 저장",
    connectionStorageUnavailable:
      "토큰은 이번 가져오기에만 사용되고 이 서버에 저장되지 않아요. 연결을 저장해 두려면 백엔드에 NOTIONLIKE_NOTION_IMPORT_SECRET 환경변수를 설정해 주세요.",
    scopeWorkspace: "워크스페이스 전체",
    recommended: "권장",
    scopeWorkspaceDesc: "연결이 접근할 수 있는 모든 페이지와 데이터베이스를 가져옵니다. 페이지 사이의 데이터베이스 관계가 그대로 유지돼요.",
    scopePages: "특정 페이지만",
    scopePagesDesc: "토큰으로 접근 가능한 최상위 후보를 스캔한 뒤, 선택한 페이지/데이터베이스와 하위 항목만 가져옵니다.",
    scanRoots: "접근 가능한 최상위 항목 스캔",
    scanningRoots: "스캔 중...",
    rootScanHint:
      "위 토큰이나 저장된 연결에 공유된 페이지와 데이터베이스를 Notion에서 찾아요.",
    rootScanProgress: (roots: number, scanned: number, pages: number) =>
      `스캔 중... 후보 ${roots}개 · 항목 ${scanned}개 확인 · 요청 ${pages}회`,
    rootScanFound: (roots: number, scanned: number) => `후보 ${roots}개 · 항목 ${scanned}개 확인`,
    rootScanComplete: (roots: number) => `접근 가능한 최상위 후보 ${roots}개를 찾았어요.`,
    rootScanEmpty: "공유된 최상위 항목을 찾지 못했어요. Notion에서 가져올 페이지나 데이터베이스를 이 연결에 공유한 뒤 다시 스캔해 주세요.",
    rootScanWorkspaceLabel: (name: string) => `Notion 워크스페이스: ${name}`,
    rootScanEmptyTitle: (workspaceName?: string | null) =>
      workspaceName
        ? `토큰은 정상이고 Notion “${workspaceName}” 워크스페이스에 연결돼 있어요. 다만 이 통합에 공유된 페이지가 아직 없습니다.`
        : "토큰은 정상이에요. 다만 이 통합에 공유된 페이지가 아직 없습니다.",
    rootScanEmptyWhy:
      "Notion 통합은 명시적으로 연결(공유)한 페이지만 볼 수 있어요. 토큰을 만들기만 하면 아무것도 보이지 않아요.",
    rootScanEmptyStep1:
      "Notion에서 가져올 최상위 페이지를 열고 → 우측 상단 ··· 메뉴 → 연결 → 이 통합을 추가하세요.",
    rootScanEmptyStep2:
      "또는 notion.so/profile/integrations에서 통합을 열고 액세스 탭에서 페이지를 선택해도 돼요.",
    rootScanEmptyStep3:
      "최상위 페이지 하나만 공유하면 하위 페이지/데이터베이스가 모두 포함돼요. 그다음 여기서 다시 스캔하세요.",
    rootScanEmptyOtherWorkspace: (workspaceName?: string | null) =>
      workspaceName
        ? `가져올 페이지가 “${workspaceName}”이(가) 아닌 다른 Notion 워크스페이스에 있다면 이 토큰으로는 볼 수 없어요. 그 워크스페이스에서 통합을 만들어 그 토큰을 사용해 주세요.`
        : "가져올 페이지가 다른 Notion 워크스페이스에 있다면 이 토큰으로는 볼 수 없어요. 그 워크스페이스에서 통합을 만들어 그 토큰을 사용해 주세요.",
    rootScanHasMore: "Notion에 항목이 더 있어요. 필요한 루트가 안 보이면 가져올 루트 페이지만 연결에 공유하거나 워크스페이스 전체 가져오기를 사용해 주세요.",
    rootPickerTitle: "접근 가능한 최상위 항목",
    rootSelectionCount: (selected: number, total: number) => `${total}개 중 ${selected}개 선택`,
    selectAllRoots: "모두 선택",
    clearRootSelection: "선택 해제",
    manualRootFallback: "링크/ID 직접 붙여넣기(고급)",
    rootKindPage: "페이지",
    rootKindDataSource: "데이터베이스",
    rootIdsLabel: "페이지 링크/ID",
    rootIdsPlaceholder: "Notion 페이지 링크나 ID를 한 줄에 하나씩 붙여넣기",
    pagesRecognized: (count: number) => `루트 항목 ${count}개 선택됨`,
    scopeWarning: "선택한 페이지 밖의 데이터베이스를 참조하는 관계는 빈 자리 표시자로 들어올 수 있어요.",
    fullWidthPages: "페이지를 전체 너비로 가져오기",
    fullWidthPagesDesc:
      "Notion API가 원본 Full width 설정을 알려주지 않아요. 켜두면 데이터베이스 행이 아닌 가져온 페이지를 넓게 표시합니다.",
    startDiscovery: "가져올 항목 찾기",
    discovering: "찾는 중...",
    discoveredStat: "발견",
    importedStat: "가져옴",
    filesStat: "파일",
    copied: "복사",
    skipped: "건너뜀",
    ofTotal: (done: number, total: number) => `${total}개 중 ${done}개`,
    moreAvailable: "더 있음",
    entireWorkspaceScope: "워크스페이스 전체",
    rootPagesScope: (count: number) => `루트 페이지 ${count}개`,
    discoveredItems: (count: number) => `발견한 항목 ${count}개`,
    importedItems: (count: number) => `가져온 항목 ${count}개`,
    noDiscovered: "발견한 항목 없음",
    formatMetric: (value: number, label: string) => `${label} ${value}`,
    review: "검토",
    apply: "가져오기 실행",
    expand: "더 찾기",
    retry: "다시 시도",
    retryFiles: "파일 다시 복사",
    cancelImport: "가져오기 취소",
    cancellingImport: "취소하는 중...",
    importCancelled: "Notion 가져오기를 취소했어요.",
    cantCancelImport: "Notion 가져오기를 취소하지 못했어요.",
    openImportedPage: "가져온 페이지 열기",
    notionWorkspace: "Notion 워크스페이스",
    status: {
      queued: "대기 중",
      discovering: "찾는 중",
      ready: "준비됨",
      completed: "완료",
      failed: "실패",
      cancelled: "취소됨",
    } as Record<string, string>,
    progressSteps: {
      connect: "연결",
      discover: "검색",
      review: "검토",
      apply: "적용",
      file_copy_retry: "파일 재시도",
      cancel: "취소",
    } as Record<string, string>,
    metric: (key: string) => METRIC_LABELS_KO[key] ?? METRIC_LABELS_EN[key] ?? key,
    countUnit: (key: string, value: number) => `${COUNT_UNITS_KO[key] ?? key} ${value}`,
    issueGroups: {
      unsupported: "미지원",
      unresolved: "미해결",
      missing: "접근 권한 없음",
      warnings: "경고",
    } as Record<string, string>,
    markdownNoun: (kind: string, count: number) => {
      const noun = kind === "database" ? "행" : "블록";
      return `${noun} ${count}개를 가져왔어요.`;
    },
    emptyDatabaseImported: "빈 데이터베이스를 가져왔어요.",
    noMarkdownBlocks: "마크다운 블록을 찾지 못했어요.",
    useSupportedFile: "Markdown, 텍스트, CSV 파일을 사용해 주세요.",
    cantImportFile: "파일을 가져오지 못했어요.",
    tokenOrConnectionRequired: "Notion API 토큰을 입력하거나 저장된 연결을 선택해 주세요.",
    rootPagesRequired: "스캔한 후보에서 하나 이상 선택하거나, 페이지 링크/ID를 넣거나, 워크스페이스 전체로 바꿔 주세요.",
    foundItems: (count: number) => `Notion 항목 ${count}개를 찾았어요.`,
    jobCreated: "Notion 가져오기 작업을 만들었어요.",
    cantStartImport: "Notion 가져오기를 시작하지 못했어요.",
    tokenRequired: "Notion 토큰이 필요해요.",
    tokenMustStartWithNtn: "ntn_로 시작하는 Notion API 토큰을 입력해 주세요.",
    connectionSaved: "Notion 연결을 저장했어요.",
    cantSaveConnection: "Notion 연결을 저장하지 못했어요.",
    oauthSaved: "Notion OAuth 연결을 저장했어요.",
    oauthCancelled: (reason: string) => `Notion 연결이 취소됐어요: ${reason}`,
    oauthMissingCode: "Notion 연결 콜백에 code 또는 state가 없어요.",
    cantFinishOAuth: "Notion OAuth를 완료하지 못했어요.",
    connectionRemoved: "Notion 연결을 삭제했어요.",
    cantRemoveConnection: "Notion 연결을 삭제하지 못했어요.",
    reviewReady: "가져오기 검토가 준비됐어요.",
    cantReview: "가져오기 검토에 실패했어요.",
    expandNeedsCredential: "검색을 확장하려면 Notion 토큰을 입력하거나 저장된 연결을 선택해 주세요.",
    rootScanNeedsCredential: "스캔하려면 먼저 Notion API 토큰을 입력하거나 저장된 연결을 선택해 주세요.",
    discoveryExpanded: (count: number) => `검색을 확장했어요: Notion 항목 ${count}개.`,
    cantScanRoots: "Notion 최상위 항목을 스캔하지 못했어요.",
    cantExpand: "검색을 확장하지 못했어요.",
    importApplied: "Notion 가져오기를 적용했어요.",
    cantApply: "Notion 가져오기를 적용하지 못했어요.",
    fileRetryFinished: (copied: number, skipped: number) =>
      `파일 복사 재시도 완료: ${copied}개 복사, ${skipped}개 건너뜀.`,
    cantRetryFiles: "Notion 파일 복사를 재시도하지 못했어요.",
    hanji: {
      tab: "Hanji",
      title: "Hanji에서 가져오기",
      fromFile: "파일에서",
      fromLive: "다른 인스턴스에서",
      choose: ".hanji.json 파일 선택",
      chooseButton: "파일 선택",
      fileHint:
        "다른 Hanji에서 페이지·데이터베이스·워크스페이스를 내보낸 뒤 여기로 가져옵니다. 관계·롤업·수식·뷰·템플릿이 그대로 유지돼요. 첨부 파일은 포함되지 않아요.",
      selected: (name: string) => `선택됨: ${name}`,
      importButton: "가져오기",
      importing: "가져오는 중...",
      remoteUrl: "원격 Hanji 주소",
      remoteUrlPlaceholder: "https://…",
      remoteWorkspace: "워크스페이스 ID",
      remoteToken: "액세스 토큰",
      remoteTokenOptional: "선택",
      fetch: "내보내기 가져오기",
      fetching: "가져오는 중...",
      liveHint:
        "실행 중인 다른 Hanji(예: Docker dev 인스턴스)에서 워크스페이스를 바로 가져옵니다. 원격이 이 주소의 요청을 허용해야 해요.",
      review: (summary: string) => `가져올 준비 완료: ${summary}`,
      placeholderNote: "일부 첨부 파일은 자리표시자로 남았어요.",
      importedItems: (count: number) => `Hanji 파일에서 항목 ${count}개를 가져왔어요.`,
      cantRead: "Hanji 파일을 읽지 못했어요.",
      cantImport: "Hanji 파일을 가져오지 못했어요.",
      needFile: "먼저 Hanji 파일을 선택해 주세요.",
      needRemote: "원격 Hanji 주소와 워크스페이스 ID를 입력해 주세요.",
    },
  },
} as const;

type ImportDialogLabels = (typeof IMPORT_LABELS)["en"] | (typeof IMPORT_LABELS)["ko"];

function importLabels(): ImportDialogLabels {
  return pickLabels(IMPORT_LABELS);
}

function isImportable(file: File) {
  return (
    /\.(md|markdown|txt|csv)$/i.test(file.name) ||
    ["text/markdown", "text/plain", "text/csv", "application/csv"].includes(file.type)
  );
}

function notionOAuthRedirectUri() {
  const url = new URL(window.location.href);
  url.pathname = "/";
  url.hash = "";
  url.search = "";
  for (const key of ["code", "state", "error"]) {
    url.searchParams.delete(key);
  }
  url.searchParams.set(NOTION_OAUTH_CALLBACK_PARAM, "1");
  return url.toString();
}

function clearNotionOAuthCallbackParams() {
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of [NOTION_OAUTH_CALLBACK_PARAM, "code", "state", "error"]) {
    if (!url.searchParams.has(key)) continue;
    url.searchParams.delete(key);
    changed = true;
  }
  if (changed) {
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }
}

// Accepts raw Notion IDs, dashed UUIDs, and full notion.so page URLs; returns
// compact 32-hex ids (backend normalizes the format again on its side).
function parseNotionRootInput(raw: string): string[] {
  const tokens = raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const ids: string[] = [];
  for (const token of tokens) {
    const isUrl = token.includes("://") || token.startsWith("www.");
    const cleaned = isUrl ? (token.split(/[?#]/)[0] ?? token) : token;
    const dashed = cleaned.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    const compact = dashed?.length
      ? dashed[dashed.length - 1].replace(/-/g, "")
      : cleaned.match(/[0-9a-f]{32}(?![0-9a-z])/gi)?.pop() ?? "";
    const id = compact ? compact.toLowerCase() : isUrl ? "" : token;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function notionRootCandidateKey(candidate: NotionImportRootCandidate) {
  return `${candidate.notionObject}:${candidate.id}`;
}

function normalizedNotionRootId(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/-/g, "").toLowerCase() : "";
}

function uniqueRootIds(ids: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const normalized = normalizedNotionRootId(id);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(id);
  }
  return result;
}

function mergeRootScanItems(
  current: NotionImportRootScanItem[],
  next: NotionImportRootScanItem[],
) {
  const byId = new Map<string, NotionImportRootScanItem>();
  for (const item of [...current, ...next]) {
    const normalized = normalizedNotionRootId(item.id);
    if (!normalized) continue;
    byId.set(normalized, item);
  }
  return Array.from(byId.values());
}

function rootCandidatesFromScannedItems(items: NotionImportRootScanItem[]): NotionImportRootCandidate[] {
  const knownIds = new Set(items.map((item) => normalizedNotionRootId(item.id)).filter(Boolean));
  const candidates = new Map<string, NotionImportRootCandidate>();

  for (const item of items) {
    if (item.notionObject !== "page" && item.notionObject !== "data_source") continue;
    if (item.archived || item.inTrash) continue;
    const normalizedId = normalizedNotionRootId(item.id);
    if (!normalizedId || candidates.has(normalizedId)) continue;
    const normalizedParentId = normalizedNotionRootId(item.parentNotionId);
    const isWorkspaceParent = item.parentType === "workspace";
    const isAccessibleParentMissing = !!normalizedParentId && !knownIds.has(normalizedParentId);
    if (!isWorkspaceParent && !isAccessibleParentMissing) continue;
    candidates.set(normalizedId, {
      id: item.id,
      notionObject: item.notionObject,
      title: item.title || "Untitled",
      parentNotionId: item.parentNotionId ?? null,
      parentType: item.parentType ?? null,
      createdTime: item.createdTime ?? null,
      lastEditedTime: item.lastEditedTime ?? null,
      url: item.url ?? null,
      icon: item.icon ?? null,
      reason: isWorkspaceParent ? "workspace_parent" : "accessible_parent_missing",
    });
  }

  return Array.from(candidates.values()).sort((a, b) => {
    const reasonScore = (root: NotionImportRootCandidate) => root.reason === "workspace_parent" ? 0 : 1;
    const scoreDelta = reasonScore(a) - reasonScore(b);
    if (scoreDelta !== 0) return scoreDelta;
    const editedDelta = String(b.lastEditedTime ?? "").localeCompare(String(a.lastEditedTime ?? ""));
    if (editedDelta !== 0) return editedDelta;
    return a.title.localeCompare(b.title);
  });
}

function selectedRootCandidates(
  candidates: NotionImportRootCandidate[],
  selectedKeys: string[],
) {
  const selected = new Set(selectedKeys);
  return candidates.filter((candidate) => selected.has(notionRootCandidateKey(candidate)));
}

function rootCandidateKindLabel(candidate: NotionImportRootCandidate, labels: ImportDialogLabels) {
  return candidate.notionObject === "data_source" ? labels.rootKindDataSource : labels.rootKindPage;
}

function notionImportReport(job: NotionImportJob): ImportReport {
  return job.report && typeof job.report === "object" ? (job.report as ImportReport) : {};
}

function safeCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function conversionForJob(job: NotionImportJob) {
  const report = notionImportReport(job);
  return report.fileRetry?.conversion ?? report.conversion ?? report.plan?.conversion;
}

function countEntries(values: Record<string, unknown> | undefined, keys: string[], labels: ImportDialogLabels) {
  return keys
    .map((key) => ({ key, label: labels.metric(key), value: safeCount(values?.[key]) }))
    .filter((entry) => entry.value > 0);
}

function reportSummary(job: NotionImportJob) {
  const report = notionImportReport(job);
  const conversion = conversionForJob(job);
  const summary = conversion?.summary ?? {};
  const unsupported = safeCount(summary.unsupported) || (conversion?.unsupported?.length ?? report.unsupported?.length ?? 0);
  const unresolved = safeCount(summary.unresolvedReferences) || (conversion?.unresolvedReferences?.length ?? 0);
  const warnings = safeCount(summary.warnings) || (conversion?.warnings?.length ?? report.warnings?.length ?? 0);
  const missing = safeCount(summary.missingPermissions) || (conversion?.missingPermissions?.length ?? report.missingPermissions?.length ?? 0);
  const discoveryIncomplete = safeCount(summary.discoveryIncomplete);
  return { unsupported, unresolved, warnings, missing, discoveryIncomplete };
}

function hasRetryableFileCopies(job: NotionImportJob) {
  const report = notionImportReport(job);
  if (typeof report.fileRetry?.skipped === "number") return report.fileRetry.skipped > 0;
  const summary = report.conversion?.summary ?? {};
  return safeCount(summary.fileCopySkipped) > 0 || safeCount(summary.filesNeedCopy) > safeCount(summary.fileCopies);
}

function reportSummaryText(job: NotionImportJob, labels: ImportDialogLabels) {
  const summary = reportSummary(job);
  const parts = [
    summary.unsupported ? labels.formatMetric(summary.unsupported, labels.metric("unsupported")) : "",
    summary.unresolved ? labels.formatMetric(summary.unresolved, labels.metric("unresolved")) : "",
    summary.missing ? labels.formatMetric(summary.missing, labels.metric("missing")) : "",
    summary.warnings
      ? labels.formatMetric(
          summary.warnings,
          labels.metric("warnings").replace(/s$/, summary.warnings === 1 ? "" : "s")
        )
      : "",
    summary.discoveryIncomplete
      ? labels.formatMetric(summary.discoveryIncomplete, labels.metric("discoveryIncomplete"))
      : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function reportMetricEntries(job: NotionImportJob, labels: ImportDialogLabels) {
  const conversion = conversionForJob(job);
  const categoryEntries = Object.entries(reportSummary(job))
    .map(([key, value]) => ({ key, label: labels.metric(key), value }))
    .filter((entry) => entry.value > 0);
  const detailedEntries = countEntries(conversion?.summary, SUMMARY_KEYS, labels);
  const seen = new Set(categoryEntries.map((entry) => entry.key));
  return [
    ...categoryEntries,
    ...detailedEntries.filter((entry) => {
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    }),
  ].slice(0, 14);
}

function reportIssueGroups(job: NotionImportJob, labels: ImportDialogLabels) {
  const conversion = conversionForJob(job);
  return [
    { key: "unsupported", label: labels.issueGroups.unsupported, issues: conversion?.unsupported ?? [] },
    { key: "unresolved", label: labels.issueGroups.unresolved, issues: conversion?.unresolvedReferences ?? [] },
    { key: "missing", label: labels.issueGroups.missing, issues: conversion?.missingPermissions ?? [] },
    { key: "warnings", label: labels.issueGroups.warnings, issues: conversion?.warnings ?? [] },
  ].filter((group) => group.issues.length > 0);
}

function writeEntries(job: NotionImportJob, labels: ImportDialogLabels) {
  const report = notionImportReport(job);
  return countEntries(report.applied ?? report.plan?.estimatedWrites, WRITE_KEYS, labels);
}

function writeSummaryText(job: NotionImportJob, labels: ImportDialogLabels) {
  return writeEntries(job, labels)
    .slice(0, 8)
    .map((entry) => labels.formatMetric(entry.value, entry.label))
    .join(" · ");
}

function jobPercent(job: NotionImportJob) {
  const progress = job.progress ?? {};
  return typeof progress.percent === "number" && Number.isFinite(progress.percent)
    ? Math.max(0, Math.min(100, Math.round(progress.percent)))
    : undefined;
}

function progressSummaryText(job: NotionImportJob) {
  const progress = job.progress ?? {};
  const percent = jobPercent(job);
  // Once the job is finished, the last step label ("Applying...") is stale.
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return percent !== undefined ? `${percent}%` : "";
  }
  const label =
    typeof progress.currentLabel === "string" && progress.currentLabel.trim()
      ? progress.currentLabel.trim()
      : typeof progress.step === "string" && progress.step.trim()
        ? progress.step.trim().replace(/_/g, " ")
        : "";
  if (percent !== undefined && label) return `${percent}% · ${label}`;
  if (percent !== undefined) return `${percent}%`;
  return label;
}

function progressStepsOf(job: NotionImportJob): ImportProgressStep[] {
  const raw = job.progress?.steps;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): ImportProgressStep | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      if (typeof record.key !== "string" || !record.key) return null;
      return {
        key: record.key,
        label: typeof record.label === "string" ? record.label : undefined,
        status: typeof record.status === "string" ? record.status : undefined,
      };
    })
    .filter((item): item is ImportProgressStep => !!item);
}

function appliedStats(job: NotionImportJob) {
  const progress = job.progress ?? {};
  const report = notionImportReport(job);
  const partial = progress.partialApplied;
  const finished = progress.applied ?? report.applied;
  const source = (finished ?? partial) as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") return undefined;
  return {
    pages: safeCount(source.pages),
    databases: safeCount(source.databases),
    rows: safeCount(source.rows),
    blocks: safeCount(source.blocks),
    fileCopies: safeCount(source.fileCopies),
    fileCopySkipped: safeCount(source.fileCopySkipped),
    inFlight: !finished,
  };
}

// Notion reports databases twice (as `database` and `data_source`); collapse
// the duplicate so counts read naturally.
function displayCounts(job: NotionImportJob) {
  const counts = job.counts ?? {};
  return Object.entries(counts).filter(
    ([key, value]) =>
      Number.isFinite(value) &&
      value > 0 &&
      !(key === "data_source" && safeCount(counts.database) > 0)
  );
}

function discoveredEntries(job: NotionImportJob, labels: ImportDialogLabels) {
  return displayCounts(job).map(([key, value]) => labels.countUnit(key, value));
}

function itemCountFromJob(job: NotionImportJob, fallback = 0) {
  const countTotal = displayCounts(job).reduce(
    (sum, [, value]) => sum + (Number.isFinite(value) ? value : 0),
    0
  );
  if (countTotal > 0) return countTotal;
  const progress = job.progress ?? {};
  if (typeof progress.totalKnown === "number" && Number.isFinite(progress.totalKnown)) return progress.totalKnown;
  if (typeof progress.discovered === "number" && Number.isFinite(progress.discovered)) return progress.discovered;
  return fallback;
}

function isLiveNotionJob(job: NotionImportJob) {
  if (job.status === "queued" || job.status === "discovering") return true;
  return job.progress?.currentStatus === "running";
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const titleId = useId();
  const scopeGroupId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const oauthCallbackHandledRef = useRef(false);
  const rootScanRunRef = useRef(0);
  const notify = useStore((s) => s.notify);
  const workspace = useStore((s) => s.workspace);
  const refreshWorkspacePages = useStore((s) => s.refreshWorkspacePages);
  const L = importLabels();
  // `importLabels()` returns a fresh object each render, so the one-shot OAuth
  // callback effect below reads labels through a ref (refreshed every render)
  // instead of depending on `L` directly — otherwise it would re-run on every
  // render even though it is guarded to fire once.
  const labelsRef = useRef(L);
  useEffect(() => {
    labelsRef.current = L;
  });
  const [dragActive, setDragActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importingFileName, setImportingFileName] = useState("");
  // Notion is the primary migration path for this product, so the dialog opens
  // on it; the file (Markdown/CSV) tab stays one click away for other sources.
  const [source, setSource] = useState<"file" | "notion" | "hanji">("notion");
  const [notionToken, setNotionToken] = useState("");
  const [notionConnectionName, setNotionConnectionName] = useState("");
  const [notionScope, setNotionScope] = useState<"workspace" | "pages">("workspace");
  const [notionImportPagesFullWidth, setNotionImportPagesFullWidth] = useState(true);
  const [notionRootIds, setNotionRootIds] = useState("");
  const [notionRootCandidates, setNotionRootCandidates] = useState<NotionImportRootCandidate[]>([]);
  const [selectedNotionRootKeys, setSelectedNotionRootKeys] = useState<string[]>([]);
  const [notionRootScanBusy, setNotionRootScanBusy] = useState(false);
  const [notionRootScanSummary, setNotionRootScanSummary] = useState<{
    scanned: number;
    hasMore: boolean;
    searchPagesFetched: number;
    running: boolean;
  } | null>(null);
  const [notionRootScanWorkspace, setNotionRootScanWorkspace] = useState<{
    id?: string | null;
    name?: string | null;
  } | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [notionBusy, setNotionBusy] = useState(false);
  const [notionConnections, setNotionConnections] = useState<NotionImportConnection[]>([]);
  const [notionConnectionStorageAvailable, setNotionConnectionStorageAvailable] = useState(true);
  const [notionJobs, setNotionJobs] = useState<NotionImportJob[]>([]);
  const [notionResult, setNotionResult] = useState<{
    job: NotionImportJob;
    itemCount: number;
  } | null>(null);
  const [importedRootPage, setImportedRootPage] = useState<{ jobId: string; pageId: string } | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  // Set once the user dismisses the dialog; a local file import still running
  // in the background must not re-close or navigate under them when it lands.
  const closedRef = useRef(false);
  const sourceRef = useRef(source);
  const notionRefreshRunRef = useRef(0);
  const notionRefreshInFlightRef = useRef<{
    workspaceId: string;
    promise: Promise<void>;
  } | null>(null);

  // ─── Native Hanji import (.hanji.json) ───
  const hanjiInputRef = useRef<HTMLInputElement>(null);
  const [hanjiMode, setHanjiMode] = useState<"file" | "live">("file");
  const [hanjiSelection, setHanjiSelection] = useState<{
    document: HanjiExportDocument;
    fingerprint: string;
    label: string;
    summary: string;
  } | null>(null);
  const [hanjiImporting, setHanjiImporting] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteWorkspaceId, setRemoteWorkspaceId] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [remoteBusy, setRemoteBusy] = useState(false);
  const hanjiReadRunRef = useRef(0);
  const remoteExportRunRef = useRef(0);
  const remoteExportAbortRef = useRef<AbortController | null>(null);
  const hanjiTargetWorkspaceRef = useRef(workspace?.id);

  const refreshNotionImportState = useCallback((): Promise<void> => {
    const workspaceId = workspace?.id;
    if (!workspaceId || sourceRef.current !== "notion" || closedRef.current) {
      return Promise.resolve();
    }
    const current = notionRefreshInFlightRef.current;
    if (current?.workspaceId === workspaceId) return current.promise;

    const runId = notionRefreshRunRef.current + 1;
    notionRefreshRunRef.current = runId;
    const promise = (async () => {
      const [jobsResult, connectionsResult] = await Promise.all([
        listNotionImportJobsRemote({ workspaceId, limit: 5 }),
        listNotionImportConnectionsRemote({ workspaceId, limit: 20 }),
      ]);
      if (
        closedRef.current ||
        sourceRef.current !== "notion" ||
        notionRefreshRunRef.current !== runId ||
        useStore.getState().workspace?.id !== workspaceId
      ) {
        return;
      }
      const jobs = jobsResult.jobs ?? [];
      const connections = (connectionsResult.connections ?? []).filter(
        (connection) => connection.status === "active"
      );
      setNotionJobs(jobs);
      setNotionConnections(connections);
      setNotionConnectionStorageAvailable(connectionsResult.connectionStorageAvailable !== false);
      setNotionResult((currentResult) => {
        if (!currentResult) return currentResult;
        const refreshed = jobs.find((job) => job.id === currentResult.job.id);
        if (!refreshed) return currentResult;
        return {
          job: refreshed,
          itemCount: itemCountFromJob(refreshed, currentResult.itemCount),
        };
      });
      setSelectedConnectionId((currentId) => {
        if (currentId && !connections.some((connection) => connection.id === currentId)) return "";
        if (!currentId && connections.length) return connections[0].id;
        return currentId;
      });
    })().finally(() => {
      if (notionRefreshInFlightRef.current?.promise === promise) {
        notionRefreshInFlightRef.current = null;
      }
    });
    notionRefreshInFlightRef.current = { workspaceId, promise };
    return promise;
  }, [workspace?.id]);

  const refreshNotionImportStateFresh = useCallback(async () => {
    // A mutation may finish while a poll that started before it is still in
    // flight. Let that single flight settle, then issue one guaranteed
    // post-mutation read so the older response cannot overwrite the result.
    const inFlight = notionRefreshInFlightRef.current;
    if (inFlight) await inFlight.promise.catch(() => {});
    await refreshNotionImportState();
  }, [refreshNotionImportState]);

  const shouldPollNotionImports =
    notionBusy ||
    notionJobs.some(isLiveNotionJob) ||
    (notionResult ? isLiveNotionJob(notionResult.job) : false);
  const notionPollDelay = shouldPollNotionImports ? 1000 : 4500;

  const close = useCallback((restoreFocus = true) => {
    closedRef.current = true;
    notionRefreshRunRef.current += 1;
    hanjiReadRunRef.current += 1;
    remoteExportRunRef.current += 1;
    remoteExportAbortRef.current?.abort();
    remoteExportAbortRef.current = null;
    onClose();
    if (!restoreFocus) return;
    window.requestAnimationFrame(() => {
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
      restoreFocusRef.current = null;
    });
  }, [onClose]);

  useEffect(
    () => () => {
      remoteExportAbortRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  useEffect(() => {
    if (hanjiTargetWorkspaceRef.current === workspace?.id) return;
    hanjiTargetWorkspaceRef.current = workspace?.id;
    // A preview is approved for one destination workspace as well as one
    // source. If the active destination changes under an open dialog, abort
    // any read and require a fresh preview before importing there.
    hanjiReadRunRef.current += 1;
    remoteExportRunRef.current += 1;
    remoteExportAbortRef.current?.abort();
    remoteExportAbortRef.current = null;
    setRemoteBusy(false);
    setHanjiSelection(null);
  }, [workspace?.id]);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (source !== "notion" || !workspace?.id) return;
    let mounted = true;
    refreshNotionImportState()
      .catch(() => {
        if (!mounted) return;
        setNotionJobs([]);
        setNotionConnections([]);
      });
    return () => {
      mounted = false;
    };
  }, [source, workspace?.id, refreshNotionImportState]);

  // One-shot self-heal: older/interrupted imports may have created pages without
  // their central page_workspace_index row, so /p/:id deep links 404. Re-derive
  // the index from this workspace's import mappings once per workspace per open.
  const repairedWorkspacesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const workspaceId = workspace?.id;
    if (source !== "notion" || !workspaceId) return;
    if (repairedWorkspacesRef.current.has(workspaceId)) return;
    repairedWorkspacesRef.current.add(workspaceId);
    void repairNotionImportPageIndexesRemote(workspaceId).catch(() => {
      repairedWorkspacesRef.current.delete(workspaceId);
    });
  }, [source, workspace?.id]);

  useEffect(() => {
    if (source !== "notion" || !workspace?.id) return;
    if (!shouldPollNotionImports) return;
    let cancelled = false;
    let timer = 0;
    // While an import is in flight, poll ~1s so the backend's live discovery
    // progress surfaces promptly. Schedule the next poll only after the current
    // pair of requests settles, so a slow response can never overlap another
    // poll or land after a newer response.
    const tick = async () => {
      await refreshNotionImportState().catch(() => {});
      if (!cancelled) timer = window.setTimeout(tick, notionPollDelay);
    };
    timer = window.setTimeout(tick, notionPollDelay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, workspace?.id, notionPollDelay, shouldPollNotionImports, refreshNotionImportState]);

  useEffect(() => {
    rootScanRunRef.current += 1;
    setNotionRootCandidates([]);
    setSelectedNotionRootKeys([]);
    setNotionRootScanSummary(null);
    setNotionRootScanBusy(false);
  }, [notionToken, selectedConnectionId]);

  useEffect(() => {
    if (!workspace?.id || oauthCallbackHandledRef.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(NOTION_OAUTH_CALLBACK_PARAM) !== "1") return;
    oauthCallbackHandledRef.current = true;
    setSource("notion");
    const code = params.get("code") ?? "";
    const state = params.get("state") ?? "";
    const oauthError = params.get("error") ?? "";
    if (oauthError) {
      clearNotionOAuthCallbackParams();
      notify(labelsRef.current.oauthCancelled(oauthError), "error");
      return;
    }
    if (!code || !state) {
      clearNotionOAuthCallbackParams();
      notify(labelsRef.current.oauthMissingCode, "error");
      return;
    }
    setNotionBusy(true);
    completeNotionOAuthConnectionRemote({
      workspaceId: workspace.id,
      code,
      state,
      redirectUri: notionOAuthRedirectUri(),
      name: notionConnectionName.trim() || undefined,
    })
      .then(async (result) => {
        await refreshNotionImportStateFresh();
        setSelectedConnectionId(result.connection.id);
        setNotionConnectionName("");
        notify(labelsRef.current.oauthSaved, "success");
      })
      .catch((error) => {
        notify(error instanceof Error ? error.message : labelsRef.current.cantFinishOAuth, "error");
      })
      .finally(() => {
        clearNotionOAuthCallbackParams();
        setNotionBusy(false);
      });
  }, [workspace?.id, notify, notionConnectionName, refreshNotionImportStateFresh]);

  function dialogFocusables() {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented) return;
    // Closing is always allowed — a running local import keeps going in the
    // background and reports through a toast, so the user is never trapped.
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = dialogFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function importFile(file?: File) {
    if (!file || importing) return;
    if (!isImportable(file)) {
      notify(L.useSupportedFile, "error");
      return;
    }
    setImporting(true);
    setImportingFileName(file.name || "Import file");
    try {
      const { importWorkspaceFile } = await import("./pageMarkdownImport");
      const result = await importWorkspaceFile(file);
      notify(
        result.count > 0
          ? L.markdownNoun(result.kind, result.count)
          : result.kind === "database"
            ? L.emptyDatabaseImported
            : L.noMarkdownBlocks,
        result.count > 0 ? "success" : "default"
      );
      setImporting(false);
      setImportingFileName("");
      setDragActive(false);
      // If the user dismissed the dialog mid-import, the toast above is
      // enough feedback — don't yank navigation away from where they went.
      if (!closedRef.current) {
        close(false);
        router.push(pageHref(result.page.id));
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantImportFile, "error");
      setImporting(false);
      setImportingFileName("");
      setDragActive(false);
    }
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    void importFile(file);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    void importFile(event.dataTransfer.files[0]);
  }

  async function selectHanjiFile(file?: File) {
    if (!file) return;
    const runId = hanjiReadRunRef.current + 1;
    hanjiReadRunRef.current = runId;
    remoteExportRunRef.current += 1;
    remoteExportAbortRef.current?.abort();
    remoteExportAbortRef.current = null;
    setHanjiSelection(null);
    try {
      const { hanjiFileSourceFingerprint, readHanjiFile, summarizeDocument } = await import("./nativeExport");
      const fingerprint = hanjiFileSourceFingerprint(file);
      const doc = await readHanjiFile(file);
      if (closedRef.current || hanjiReadRunRef.current !== runId) return;
      setHanjiSelection({
        document: doc,
        fingerprint,
        label: L.hanji.selected(file.name),
        summary: summarizeDocument(doc),
      });
    } catch (error) {
      if (hanjiReadRunRef.current !== runId) return;
      notify(error instanceof Error ? error.message : L.hanji.cantRead, "error");
    }
  }

  function onHanjiInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    void selectHanjiFile(file);
  }

  function invalidateHanjiSource() {
    hanjiReadRunRef.current += 1;
    remoteExportRunRef.current += 1;
    remoteExportAbortRef.current?.abort();
    remoteExportAbortRef.current = null;
    setRemoteBusy(false);
    setHanjiSelection(null);
  }

  function selectImportSource(next: "file" | "notion" | "hanji") {
    if (next === source) return;
    sourceRef.current = next;
    notionRefreshRunRef.current += 1;
    invalidateHanjiSource();
    setSource(next);
  }

  function selectHanjiMode(next: "file" | "live") {
    if (next === hanjiMode) return;
    invalidateHanjiSource();
    setHanjiMode(next);
  }

  async function fetchRemoteExport() {
    if (!workspace?.id || remoteBusy) return;
    const base = remoteUrl.trim();
    const remoteWs = remoteWorkspaceId.trim();
    if (!base || !remoteWs) {
      notify(L.hanji.needRemote, "error");
      return;
    }
    const token = remoteToken.trim() || undefined;
    const runId = remoteExportRunRef.current + 1;
    remoteExportRunRef.current = runId;
    hanjiReadRunRef.current += 1;
    remoteExportAbortRef.current?.abort();
    const controller = new AbortController();
    remoteExportAbortRef.current = controller;
    setHanjiSelection(null);
    setRemoteBusy(true);
    try {
      const {
        fetchRemoteHanjiExport,
        hanjiRemoteSourceFingerprint,
        summarizeDocument,
      } = await import("./nativeExport");
      const fingerprint = hanjiRemoteSourceFingerprint(base, remoteWs, token);
      const doc = await fetchRemoteHanjiExport(base, remoteWs, token, {
        signal: controller.signal,
        timeoutMs: 15_000,
      });
      if (closedRef.current || remoteExportRunRef.current !== runId) return;
      setHanjiSelection({
        document: doc,
        fingerprint,
        label: L.hanji.selected(`${base} · ${remoteWs}`),
        summary: summarizeDocument(doc),
      });
    } catch (error) {
      if (remoteExportRunRef.current !== runId || controller.signal.aborted) return;
      notify(error instanceof Error ? error.message : L.hanji.cantRead, "error");
    } finally {
      if (remoteExportRunRef.current === runId) {
        remoteExportAbortRef.current = null;
        setRemoteBusy(false);
      }
    }
  }

  async function runHanjiImport() {
    if (!workspace?.id || hanjiImporting) return;
    if (!hanjiSelection) {
      notify(L.hanji.needFile, "error");
      return;
    }
    setHanjiImporting(true);
    try {
      const result = await importNativeRemote({
        workspaceId: workspace.id,
        document: hanjiSelection.document,
      });
      await refreshWorkspacePages();
      const imported = result.counts.pages ?? 0;
      const hasPlaceholders = (result.warnings ?? []).some(
        (warning: NativeExportWarning) => warning.code === "stripped_file"
      );
      notify(
        `${L.hanji.importedItems(imported)}${hasPlaceholders ? ` ${L.hanji.placeholderNote}` : ""}`,
        "success"
      );
      const rootId = result.rootPageIds?.[0];
      if (rootId && !closedRef.current) {
        close(false);
        router.push(pageHref(rootId));
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : L.hanji.cantImport, "error");
    } finally {
      setHanjiImporting(false);
    }
  }

  function rootIds() {
    if (notionScope !== "pages") return [];
    return uniqueRootIds([
      ...selectedRootCandidates(notionRootCandidates, selectedNotionRootKeys)
        .filter((candidate) => candidate.notionObject === "page")
        .map((candidate) => candidate.id),
      ...parseNotionRootInput(notionRootIds),
    ]);
  }

  function rootDataSourceIds() {
    if (notionScope !== "pages") return [];
    return uniqueRootIds(
      selectedRootCandidates(notionRootCandidates, selectedNotionRootKeys)
        .filter((candidate) => candidate.notionObject === "data_source")
        .map((candidate) => candidate.id),
    );
  }

  function isAllowedNotionToken(token: string) {
    return token.startsWith("ntn_");
  }

  function validateEnteredNotionToken(token: string) {
    if (!token || isAllowedNotionToken(token)) return true;
    notify(L.tokenMustStartWithNtn, "error");
    return false;
  }

  async function startNotionImport(retryJobId?: string) {
    if (!workspace?.id || notionBusy) return;
    const token = notionToken.trim();
    if (!validateEnteredNotionToken(token)) return;
    const connectionId = token ? undefined : selectedConnectionId || undefined;
    if (!token && !connectionId && !retryJobId) {
      notify(L.tokenOrConnectionRequired, "error");
      return;
    }
    const pageRootIds = rootIds();
    const dataSourceRootIds = rootDataSourceIds();
    if (!retryJobId && notionScope === "pages" && pageRootIds.length === 0 && dataSourceRootIds.length === 0) {
      notify(L.rootPagesRequired, "error");
      return;
    }
    setNotionBusy(true);
    try {
      const selectedConnection = connectionId
        ? notionConnections.find((connection) => connection.id === connectionId)
        : undefined;
      const result = retryJobId
        ? await retryNotionImportJobRemote({
            workspaceId: workspace.id,
            jobId: retryJobId,
            notionToken: token || undefined,
            connectionId,
            importPagesFullWidth: notionImportPagesFullWidth,
          })
        : await createNotionImportJobRemote({
            workspaceId: workspace.id,
            connectionKind: connectionId
              ? selectedConnection?.connectionKind ?? "internal_integration"
              : "manual_token",
            connectionId,
            notionToken: token || undefined,
            rootNotionPageIds: pageRootIds,
            rootNotionDataSourceIds: dataSourceRootIds,
            importPagesFullWidth: notionImportPagesFullWidth,
          });
      const itemCount = result.items?.length ?? itemCountFromJob(result.job);
      await refreshNotionImportStateFresh();
      setNotionResult({ job: result.job, itemCount });
      notify(
        result.job.status === "ready" ? L.foundItems(itemCount) : L.jobCreated,
        result.job.status === "ready" ? "success" : "default"
      );
      if (connectionId) setNotionToken("");
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantStartImport, "error");
    } finally {
      setNotionBusy(false);
    }
  }

  async function saveNotionConnection() {
    if (!workspace?.id || notionBusy) return;
    const token = notionToken.trim();
    if (!token) {
      notify(L.tokenRequired, "error");
      return;
    }
    if (!validateEnteredNotionToken(token)) return;
    setNotionBusy(true);
    try {
      const result = await createNotionImportConnectionRemote({
        workspaceId: workspace.id,
        name: notionConnectionName.trim() || undefined,
        connectionKind: "internal_integration",
        notionToken: token,
      });
      await refreshNotionImportStateFresh();
      setSelectedConnectionId(result.connection.id);
      setNotionToken("");
      setNotionConnectionName("");
      notify(L.connectionSaved, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantSaveConnection, "error");
    } finally {
      setNotionBusy(false);
    }
  }

  async function scanNotionRootCandidates() {
    if (!workspace?.id || notionRootScanBusy) return;
    const token = notionToken.trim();
    if (!validateEnteredNotionToken(token)) return;
    const connectionId = token ? undefined : selectedConnectionId || undefined;
    if (!token && !connectionId) {
      notify(L.rootScanNeedsCredential, "error");
      return;
    }

    const runId = rootScanRunRef.current + 1;
    rootScanRunRef.current = runId;
    setNotionRootScanBusy(true);
    setNotionRootCandidates([]);
    setSelectedNotionRootKeys([]);
    setNotionRootScanWorkspace(null);
    setNotionRootScanSummary({
      scanned: 0,
      hasMore: true,
      searchPagesFetched: 0,
      running: true,
    });
    try {
      let cursor: string | undefined;
      let accumulatedItems: NotionImportRootScanItem[] = [];
      let roots: NotionImportRootCandidate[] = [];
      let scanned = 0;
      let searchPagesFetched = 0;
      let hasMore = true;

      for (let batch = 0; batch < NOTION_ROOT_SCAN_MAX_BATCHES; batch += 1) {
        const result = await listNotionImportRootsRemote({
          workspaceId: workspace.id,
          notionToken: token || undefined,
          connectionId,
          maxSearchPages: NOTION_ROOT_SCAN_BATCH_PAGES,
          startCursor: cursor,
          includeWorkspace: batch === 0,
          recordAudit: batch === 0,
        });
        if (rootScanRunRef.current !== runId) return;

        if (result.notionWorkspace?.id || result.notionWorkspace?.name) {
          setNotionRootScanWorkspace(result.notionWorkspace);
        }
        const batchItems = result.items?.length ? result.items : [];
        accumulatedItems = mergeRootScanItems(accumulatedItems, batchItems);
        roots = accumulatedItems.length
          ? rootCandidatesFromScannedItems(accumulatedItems)
          : result.roots ?? [];
        scanned += result.scanned ?? batchItems.length;
        searchPagesFetched += result.searchPagesFetched ?? 1;
        hasMore = result.hasMore === true && !!result.nextCursor;

        setNotionRootCandidates(roots);
        setSelectedNotionRootKeys(roots.map(notionRootCandidateKey));
        setNotionRootScanSummary({
          scanned,
          hasMore,
          searchPagesFetched,
          running: hasMore,
        });

        if (!hasMore) break;
        cursor = result.nextCursor ?? undefined;
      }

      if (rootScanRunRef.current !== runId) return;
      setNotionRootScanSummary({
        scanned,
        hasMore,
        searchPagesFetched,
        running: false,
      });
      notify(
        roots.length ? L.rootScanComplete(roots.length) : L.rootScanEmpty,
        roots.length ? "success" : "default",
      );
    } catch (error) {
      if (rootScanRunRef.current !== runId) return;
      notify(error instanceof Error ? error.message : L.cantScanRoots, "error");
    } finally {
      if (rootScanRunRef.current === runId) setNotionRootScanBusy(false);
    }
  }

  async function revokeNotionConnection(connectionId: string) {
    if (!connectionId || notionBusy) return;
    setNotionBusy(true);
    try {
      await revokeNotionImportConnectionRemote(connectionId, workspace?.id);
      if (selectedConnectionId === connectionId) setSelectedConnectionId("");
      await refreshNotionImportStateFresh();
      notify(L.connectionRemoved, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantRemoveConnection, "error");
    } finally {
      setNotionBusy(false);
    }
  }

  async function reviewNotionImport(jobId: string) {
    if (notionBusy) return;
    setNotionBusy(true);
    try {
      const result = await planNotionImportJobRemote(jobId, workspace?.id);
      await refreshNotionImportStateFresh();
      const estimated = result.plan?.estimatedWrites ?? {};
      const itemCount =
        safeCount(estimated.pages) +
        safeCount(estimated.databases) +
        safeCount(estimated.rows);
      setNotionResult({
        job: result.job,
        itemCount,
      });
      notify(L.reviewReady, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantReview, "error");
    } finally {
      setNotionBusy(false);
    }
  }

  async function expandNotionDiscovery(job: NotionImportJob) {
    if (notionBusy) return;
    const token = notionToken.trim();
    if (!validateEnteredNotionToken(token)) return;
    const connectionId = token ? undefined : job.connectionId || selectedConnectionId || undefined;
    if (!token && !connectionId) {
      notify(L.expandNeedsCredential, "error");
      return;
    }
    setNotionBusy(true);
    try {
      const result = await discoverNotionImportJobRemote({
        workspaceId: workspace?.id,
        jobId: job.id,
        notionToken: token || undefined,
        connectionId,
        continueFromCursor: typeof job.progress?.nextCursor === "string" && job.progress.nextCursor.length > 0,
      });
      await refreshNotionImportStateFresh();
      const itemCount = result.items?.length ?? itemCountFromJob(result.job);
      setNotionResult({ job: result.job, itemCount });
      notify(L.discoveryExpanded(itemCount), "success");
      if (connectionId) setNotionToken("");
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantExpand, "error");
    } finally {
      setNotionBusy(false);
    }
  }

  async function applyNotionImport(jobId: string) {
    if (notionBusy) return;
    const token = notionToken.trim();
    if (!validateEnteredNotionToken(token)) return;
    const job = notionJobs.find((item) => item.id === jobId) ?? notionResult?.job;
    const connectionId = token ? undefined : job?.connectionId || selectedConnectionId || undefined;
    setNotionBusy(true);
    try {
      const result = await applyNotionImportJobRemote({
        workspaceId: workspace?.id,
        jobId,
        notionToken: token || undefined,
        connectionId,
        importPagesFullWidth: notionImportPagesFullWidth,
      });
      const jobs = workspace?.id
        ? await listNotionImportJobsRemote({ workspaceId: workspace.id, limit: 5 })
        : { jobs: [] };
      setNotionJobs(jobs.jobs ?? []);
      setNotionResult({
        job: result.job,
        itemCount: typeof result.applied?.pages === "number"
          ? result.applied.pages + (result.applied.databases ?? 0) + (result.applied.rows ?? 0)
          : 0,
      });
      const rootIds = (result.job.rootNotionPageIds ?? job?.rootNotionPageIds ?? []).map((id) =>
        id.replace(/-/g, "").toLowerCase()
      );
      const rootMapping = (result.mappings ?? []).find(
        (mapping) =>
          mapping.localType === "page" &&
          typeof mapping.localId === "string" &&
          mapping.localId &&
          rootIds.includes(String(mapping.notionId ?? "").replace(/-/g, "").toLowerCase())
      );
      if (rootMapping?.localId) setImportedRootPage({ jobId, pageId: rootMapping.localId });
      // Imported pages were written server-side; pull them into the sidebar tree.
      void refreshWorkspacePages().catch(() => {});
      notify(L.importApplied, "success");
      if (token) setNotionToken("");
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantApply, "error");
    } finally {
      setNotionBusy(false);
    }
  }

  async function retryNotionFileCopies(jobId: string) {
    if (notionBusy) return;
    setNotionBusy(true);
    try {
      const result = await retryNotionImportFileCopiesRemote(jobId, workspace?.id);
      const jobs = workspace?.id
        ? await listNotionImportJobsRemote({ workspaceId: workspace.id, limit: 5 })
        : { jobs: [] };
      setNotionJobs(jobs.jobs ?? []);
      const fileRetry = result.fileRetry ?? {};
      setNotionResult({
        job: result.job,
        itemCount: safeCount(fileRetry.copied) + safeCount(fileRetry.skipped),
      });
      notify(
        L.fileRetryFinished(safeCount(fileRetry.copied), safeCount(fileRetry.skipped)),
        safeCount(fileRetry.skipped) ? "default" : "success"
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantRetryFiles, "error");
    } finally {
      setNotionBusy(false);
    }
  }

  async function cancelNotionImport(jobId: string) {
    if (cancellingJobId) return;
    setCancellingJobId(jobId);
    try {
      const result = await cancelNotionImportJobRemote(jobId, workspace?.id);
      setNotionResult((current) =>
        current && current.job.id === jobId
          ? { job: result.job, itemCount: itemCountFromJob(result.job, current.itemCount) }
          : current
      );
      setNotionJobs((current) =>
        current.map((job) => (job.id === jobId ? result.job : job))
      );
      await refreshNotionImportStateFresh().catch(() => {});
      notify(L.importCancelled, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantCancelImport, "error");
    } finally {
      setCancellingJobId(null);
    }
  }

  function statusLabel(job: NotionImportJob) {
    return L.status[job.status] ?? L.status.queued;
  }

  function scopeText(job: NotionImportJob) {
    const roots = job.rootNotionPageIds ?? [];
    const dataSourceRoots = job.rootNotionDataSourceIds ?? [];
    const totalRoots = roots.length + dataSourceRoots.length;
    return totalRoots ? L.rootPagesScope(totalRoots) : L.entireWorkspaceScope;
  }

  function discoveryDetailText(job: NotionImportJob) {
    const parts = [
      scopeText(job),
      job.progress?.hasMore === true ? L.moreAvailable : "",
    ].filter(Boolean);
    return parts.join(" · ");
  }

  function jobActions(job: NotionImportJob) {
    if (isLiveNotionJob(job)) {
      // A running import must stay cancellable even while other Notion calls
      // are busy, so this button only locks while its own cancel is in flight.
      return (
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void cancelNotionImport(job.id)}
          disabled={cancellingJobId !== null}
        >
          {cancellingJobId === job.id ? L.cancellingImport : L.cancelImport}
        </button>
      );
    }
    if (job.status === "failed" || job.status === "cancelled") {
      return (
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void startNotionImport(job.id)}
          disabled={notionBusy}
        >
          {L.retry}
        </button>
      );
    }
    if (job.status === "ready") {
      return (
        <span className={styles.jobActions}>
          {job.progress?.hasMore === true ? (
            <button
              type="button"
              className={styles.secondary}
              onClick={() => void expandNotionDiscovery(job)}
              disabled={notionBusy}
            >
              {L.expand}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void reviewNotionImport(job.id)}
            disabled={notionBusy}
          >
            {L.review}
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={() => void applyNotionImport(job.id)}
            disabled={notionBusy}
          >
            {L.apply}
          </button>
        </span>
      );
    }
    if (job.status === "completed" && hasRetryableFileCopies(job)) {
      return (
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void retryNotionFileCopies(job.id)}
          disabled={notionBusy}
        >
          {L.retryFiles}
        </button>
      );
    }
    return null;
  }

  const selectedConnection = notionConnections.find((connection) => connection.id === selectedConnectionId);
  const sourceWorkspaceName =
    selectedConnection?.notionWorkspaceName ||
    notionResult?.job.notionWorkspaceName ||
    notionJobs.find((job) => job.notionWorkspaceName)?.notionWorkspaceName ||
    "";
  const hasCredential = Boolean(selectedConnectionId || notionToken.trim());
  // The progress panel reflects the CURRENT interaction: a result from this
  // session (`notionResult`), or a job still genuinely running in the
  // background. A previous "ready"/"completed" job must not auto-fill the panel
  // when the dialog is reopened to start a new import — it stays in the recent
  // jobs list below (with its own Review/Apply/Retry actions) instead of
  // resurfacing stale discovery over a fresh scope selection.
  const activeJob =
    notionResult?.job ??
    notionJobs.find((job) => isLiveNotionJob(job)) ??
    null;
  const activeItemCount = notionResult ? notionResult.itemCount : activeJob ? itemCountFromJob(activeJob) : 0;
  const activePercent = activeJob ? jobPercent(activeJob) : undefined;
  const activeSteps = activeJob ? progressStepsOf(activeJob) : [];
  const activeApplied = activeJob ? appliedStats(activeJob) : undefined;
  const activeDiscovered = activeJob ? discoveredEntries(activeJob, L) : [];
  const activeLive = activeJob ? isLiveNotionJob(activeJob) || notionBusy : false;
  const selectedRoots = selectedRootCandidates(notionRootCandidates, selectedNotionRootKeys);
  const rootIdCount = rootIds().length + rootDataSourceIds().length;

  return (
    <div className={styles.overlay}>
      <button
        type="button"
        className={styles.backdrop}
        onClick={() => close()}
        tabIndex={-1}
        aria-label={L.close}
      />
      <section
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onDialogKeyDown}
      >
        <header className={styles.header}>
          <h2 id={titleId}>{L.title}</h2>
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            onClick={() => close()}
            aria-label={L.close}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.body}>
          <aside className={styles.nav} aria-label={L.navAria}>
            <button
              type="button"
              className={styles.navItem}
              data-active={source === "file" ? "true" : undefined}
              onClick={() => selectImportSource("file")}
            >
              <Upload size={16} aria-hidden="true" />
              <span>{L.file}</span>
            </button>
            <button
              type="button"
              className={styles.navItem}
              data-active={source === "notion" ? "true" : undefined}
              onClick={() => selectImportSource("notion")}
            >
              <GlobeIcon size={16} aria-hidden="true" />
              <span>{L.notion}</span>
            </button>
            <button
              type="button"
              className={styles.navItem}
              data-active={source === "hanji" ? "true" : undefined}
              onClick={() => selectImportSource("hanji")}
            >
              <Database size={16} aria-hidden="true" />
              <span>{L.hanji.tab}</span>
            </button>
          </aside>

          {source === "file" ? (
            <div className={styles.panel}>
              <div
                className={styles.dropzone}
                data-active={dragActive ? "true" : undefined}
                data-busy={importing ? "true" : undefined}
                onDragOver={onDragOver}
                onDragEnter={onDragOver}
                onDragLeave={() => setDragActive(false)}
                onDrop={onDrop}
              >
                <span className={styles.dropIcon} aria-hidden="true">
                  <Upload size={22} />
                </span>
                <strong>{importing ? L.importingFile : dragActive ? L.dropToImport : L.chooseFile}</strong>
                <button
                  type="button"
                  className={styles.primary}
                  onClick={() => inputRef.current?.click()}
                  disabled={importing}
                >
                  {L.chooseFileButton}
                </button>
                {importing && (
                  <div className={styles.importProgress} role="status" aria-live="polite">
                    <span>{importingFileName || L.preparingImport}</span>
                    <div
                      className={styles.importProgressTrack}
                      role="progressbar"
                      aria-label={importingFileName || L.preparingImport}
                    >
                      <span />
                    </div>
                  </div>
                )}
              </div>

              <div className={styles.formats} aria-label={L.supportedImports}>
                <div className={styles.formatRow}>
                  <span className={styles.formatIcon}>
                    <FileText size={17} aria-hidden="true" />
                  </span>
                  <span className={styles.formatText}>
                    <strong>Markdown</strong>
                    <span>{L.markdownExts}</span>
                  </span>
                </div>
                <div className={styles.formatRow}>
                  <span className={styles.formatIcon}>
                    <TableIcon size={17} aria-hidden="true" />
                  </span>
                  <span className={styles.formatText}>
                    <strong>CSV</strong>
                    <span>.csv</span>
                  </span>
                  <Database size={15} className={styles.trailingIcon} aria-hidden="true" />
                </div>
              </div>
            </div>
          ) : source === "hanji" ? (
            <div className={styles.panel}>
              <div className={styles.destBanner}>
                <span className={styles.destRoute}>
                  <Database size={15} aria-hidden="true" />
                  <strong>{L.hanji.title}</strong>
                </span>
                <span className={styles.destNote}>{L.destinationNote}</span>
              </div>

              <div className={styles.scopeGroup} role="radiogroup" aria-label={L.hanji.title}>
                <button
                  type="button"
                  className={styles.scopeOption}
                  data-active={hanjiMode === "file" ? "true" : undefined}
                  role="radio"
                  aria-checked={hanjiMode === "file"}
                  onClick={() => selectHanjiMode("file")}
                >
                  <span className={styles.scopeText}>
                    <span className={styles.scopeTitle}>{L.hanji.fromFile}</span>
                    <span className={styles.scopeDesc}>{L.hanji.fileHint}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.scopeOption}
                  data-active={hanjiMode === "live" ? "true" : undefined}
                  role="radio"
                  aria-checked={hanjiMode === "live"}
                  onClick={() => selectHanjiMode("live")}
                >
                  <span className={styles.scopeText}>
                    <span className={styles.scopeTitle}>{L.hanji.fromLive}</span>
                    <span className={styles.scopeDesc}>{L.hanji.liveHint}</span>
                  </span>
                </button>
              </div>

              {hanjiMode === "file" ? (
                <div className={styles.dropzone}>
                  <span className={styles.dropIcon} aria-hidden="true">
                    <Upload size={22} />
                  </span>
                  <strong>{L.hanji.choose}</strong>
                  <button
                    type="button"
                    className={styles.primary}
                    onClick={() => hanjiInputRef.current?.click()}
                  >
                    {L.hanji.chooseButton}
                  </button>
                </div>
              ) : (
                <div className={styles.notionForm}>
                  <label className={styles.field}>
                    <span>{L.hanji.remoteUrl}</span>
                    <input
                      type="url"
                      value={remoteUrl}
                      placeholder={L.hanji.remoteUrlPlaceholder}
                      onChange={(event) => {
                        invalidateHanjiSource();
                        setRemoteUrl(event.currentTarget.value);
                      }}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>{L.hanji.remoteWorkspace}</span>
                    <input
                      type="text"
                      value={remoteWorkspaceId}
                      onChange={(event) => {
                        invalidateHanjiSource();
                        setRemoteWorkspaceId(event.currentTarget.value);
                      }}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>
                      {L.hanji.remoteToken} ({L.hanji.remoteTokenOptional})
                    </span>
                    <input
                      type="password"
                      value={remoteToken}
                      autoComplete="off"
                      onChange={(event) => {
                        invalidateHanjiSource();
                        setRemoteToken(event.currentTarget.value);
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => void fetchRemoteExport()}
                    disabled={remoteBusy}
                  >
                    {remoteBusy ? L.hanji.fetching : L.hanji.fetch}
                  </button>
                </div>
              )}

              {hanjiSelection ? (
                <div className={styles.actionBar} data-source-fingerprint={hanjiSelection.fingerprint}>
                  <span className={styles.actionBarHint}>
                    {hanjiSelection.label}
                    {hanjiSelection.summary ? ` · ${hanjiSelection.summary}` : ""}
                  </span>
                  <button
                    type="button"
                    className={styles.primary}
                    onClick={() => void runHanjiImport()}
                    disabled={hanjiImporting}
                  >
                    {hanjiImporting ? L.hanji.importing : L.hanji.importButton}
                  </button>
                </div>
              ) : null}

              <input
                ref={hanjiInputRef}
                type="file"
                accept=".hanji.json,.json,application/json"
                className={styles.hiddenInput}
                onChange={onHanjiInputChange}
              />
            </div>
          ) : (
            <div className={styles.panel}>
              <div className={styles.destBanner}>
                <span className={styles.destRoute}>
                  <GlobeIcon size={14} aria-hidden="true" />
                  <strong>{sourceWorkspaceName || L.notion}</strong>
                  <span aria-hidden="true">→</span>
                  <strong>{workspace?.name || ""}</strong>
                </span>
                <span className={styles.destNote}>{L.destinationNote}</span>
              </div>

              <section className={styles.stepCard} data-done={selectedConnection ? "true" : undefined}>
                <header className={styles.stepHeader}>
                  <span className={styles.stepBadge} aria-hidden="true">1</span>
                  <strong>{L.stepConnect}</strong>
                  {selectedConnection ? (
                    <span className={styles.stepDone}>
                      {L.connectedTo(
                        selectedConnection.notionWorkspaceName || selectedConnection.name || L.notionWorkspace,
                      )}
                    </span>
                  ) : null}
                </header>
                <NotionTokenGuide />
                {notionConnections.length ? (
                  <div className={styles.connectionPicker}>
                    <label className={styles.field}>
                      <span>{L.savedConnection}</span>
                      <select
                        value={selectedConnectionId}
                        onChange={(event) => setSelectedConnectionId(event.currentTarget.value)}
                      >
                        <option value="">{L.oneTimeToken}</option>
                        {notionConnections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.name || connection.notionWorkspaceName || "Notion connection"}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedConnectionId ? (
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => void revokeNotionConnection(selectedConnectionId)}
                        disabled={notionBusy}
                      >
                        {L.remove}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div className={styles.tokenGuide} data-token-guide="">
                  <div className={styles.tokenGuideCopy}>
                    <strong>{L.tokenIntroTitle}</strong>
                    <p>{L.tokenIntroDesc}</p>
                  </div>
                  <div className={styles.tokenGuideActions}>
                    <a className={styles.externalButton} href={NOTION_TOKEN_URL} target="_blank" rel="noreferrer">
                      {L.openTokenPage}
                    </a>
                  </div>
                </div>
                <div className={styles.tokenFields}>
                  <label className={styles.field}>
                    <span>{L.tokenLabel}</span>
                    <input
                      type="password"
                      value={notionToken}
                      onChange={(event) => setNotionToken(event.currentTarget.value)}
                      placeholder={L.tokenPlaceholder}
                      autoComplete="off"
                      aria-invalid={
                        notionToken.trim() && !isAllowedNotionToken(notionToken.trim()) ? "true" : undefined
                      }
                    />
                  </label>
                  {notionConnectionStorageAvailable ? (
                    <>
                      <label className={styles.field}>
                        <span>{L.connectionNameLabel}</span>
                        <input
                          type="text"
                          value={notionConnectionName}
                          onChange={(event) => setNotionConnectionName(event.currentTarget.value)}
                          placeholder={L.optional}
                          autoComplete="off"
                        />
                      </label>
                      {notionToken.trim() ? (
                        <div>
                          <button
                            type="button"
                            className={styles.secondary}
                            onClick={() => void saveNotionConnection()}
                            disabled={notionBusy || !workspace?.id}
                          >
                            {L.saveConnection}
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className={styles.stepHint}>{L.connectionStorageUnavailable}</p>
                  )}
                </div>
                <details className={styles.tokenInstructions}>
                  <summary>{L.tokenInstructionsTitle}</summary>
                  <ol>
                    {L.tokenInstructionItems.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ol>
                  <a className={styles.textLink} href={NOTION_TOKEN_HELP_URL} target="_blank" rel="noreferrer">
                    {L.tokenHelpLink}
                  </a>
                </details>
              </section>

              <section className={styles.stepCard}>
                <header className={styles.stepHeader}>
                  <span className={styles.stepBadge} aria-hidden="true">2</span>
                  <strong>{L.stepScope}</strong>
                </header>
                {/* The localized variable is visible label text; htmlFor/id is explicit below. */}
                {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
                <label
                  className={styles.optionRow}
                  htmlFor={`${scopeGroupId}-full-width`}
                >
                  <input
                    id={`${scopeGroupId}-full-width`}
                    type="checkbox"
                    checked={notionImportPagesFullWidth}
                    onChange={(event) => setNotionImportPagesFullWidth(event.currentTarget.checked)}
                  />
                  <span className={styles.optionText}>
                    <strong>{L.fullWidthPages}</strong>
                    <span>{L.fullWidthPagesDesc}</span>
                  </span>
                </label>
                <div className={styles.scopeGroup} role="radiogroup" aria-label={L.stepScope}>
                  {/* Localized label text plus explicit htmlFor/id; the rule cannot resolve L.*. */}
                  {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
                  <label
                    className={styles.scopeOption}
                    data-selected={notionScope === "workspace" ? "true" : undefined}
                    htmlFor={`${scopeGroupId}-workspace`}
                  >
                    <input
                      id={`${scopeGroupId}-workspace`}
                      type="radio"
                      name={scopeGroupId}
                      checked={notionScope === "workspace"}
                      onChange={() => setNotionScope("workspace")}
                    />
                    <span className={styles.scopeText}>
                      <span className={styles.scopeTitle}>
                        {L.scopeWorkspace}
                        <em>{L.recommended}</em>
                      </span>
                      <span className={styles.scopeDesc}>{L.scopeWorkspaceDesc}</span>
                    </span>
                  </label>
                  {/* Localized label text plus explicit htmlFor/id; the rule cannot resolve L.*. */}
                  {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
                  <label
                    className={styles.scopeOption}
                    data-selected={notionScope === "pages" ? "true" : undefined}
                    htmlFor={`${scopeGroupId}-pages`}
                  >
                    <input
                      id={`${scopeGroupId}-pages`}
                      type="radio"
                      name={scopeGroupId}
                      checked={notionScope === "pages"}
                      onChange={() => setNotionScope("pages")}
                    />
                    <span className={styles.scopeText}>
                      <span className={styles.scopeTitle}>{L.scopePages}</span>
                      <span className={styles.scopeDesc}>{L.scopePagesDesc}</span>
                    </span>
                  </label>
                </div>
                {notionScope === "pages" ? (
                  <div className={styles.rootPicker}>
                    <div className={styles.rootScanRow}>
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => void scanNotionRootCandidates()}
                        disabled={notionBusy || notionRootScanBusy || !hasCredential || !workspace?.id}
                      >
                        {notionRootScanBusy ? L.scanningRoots : L.scanRoots}
                      </button>
                      <span className={styles.rootScanSummary}>
                        {notionRootScanSummary
                          ? notionRootScanSummary.running
                            ? L.rootScanProgress(
                                notionRootCandidates.length,
                                notionRootScanSummary.scanned,
                                notionRootScanSummary.searchPagesFetched,
                              )
                            : [
                                L.rootScanFound(notionRootCandidates.length, notionRootScanSummary.scanned),
                                notionRootScanWorkspace?.name
                                  ? L.rootScanWorkspaceLabel(notionRootScanWorkspace.name)
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")
                          : L.rootScanHint}
                      </span>
                    </div>
                    {notionRootScanBusy ? (
                      <div className={styles.rootScanProgressBar} aria-hidden="true">
                        <span />
                      </div>
                    ) : null}
                    {notionRootScanSummary?.hasMore ? (
                      <p className={styles.stepHint}>{L.rootScanHasMore}</p>
                    ) : null}
                    {notionRootCandidates.length ? (
                      <div className={styles.rootList} role="group" aria-label={L.rootPickerTitle}>
                        <div className={styles.rootListHeader}>
                          <strong>{L.rootPickerTitle}</strong>
                          <span>{L.rootSelectionCount(selectedRoots.length, notionRootCandidates.length)}</span>
                          <button
                            type="button"
                            className={styles.inlineButton}
                            disabled={notionRootScanBusy}
                            onClick={() => setSelectedNotionRootKeys(notionRootCandidates.map(notionRootCandidateKey))}
                          >
                            {L.selectAllRoots}
                          </button>
                          <button
                            type="button"
                            className={styles.inlineButton}
                            disabled={notionRootScanBusy}
                            onClick={() => setSelectedNotionRootKeys([])}
                          >
                            {L.clearRootSelection}
                          </button>
                        </div>
                        <div className={styles.rootCandidateList}>
                          {notionRootCandidates.map((candidate) => {
                            const key = notionRootCandidateKey(candidate);
                            const checked = selectedNotionRootKeys.includes(key);
                            return (
                              <label key={key} className={styles.rootCandidate} data-selected={checked ? "true" : undefined}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={notionRootScanBusy}
                                  onChange={(event) => {
                                    // Read the checkbox value synchronously: React nulls
                                    // `event.currentTarget` once the handler returns, and the
                                    // state updater below runs later during render — reading
                                    // it there throws and unmounts the (unbounded) dialog.
                                    const isChecked = event.currentTarget.checked;
                                    setSelectedNotionRootKeys((current) => {
                                      if (isChecked) {
                                        return current.includes(key) ? current : [...current, key];
                                      }
                                      return current.filter((item) => item !== key);
                                    });
                                  }}
                                />
                                <span className={styles.rootCandidateIcon} aria-hidden="true">
                                  {candidate.notionObject === "data_source" ? (
                                    <Database size={15} />
                                  ) : (
                                    <FileText size={15} />
                                  )}
                                </span>
                                <span className={styles.rootCandidateText}>
                                  <strong>{candidate.title || "Untitled"}</strong>
                                  <span>{rootCandidateKindLabel(candidate, L)}</span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ) : notionRootScanSummary && !notionRootScanSummary.running ? (
                      <div className={styles.rootScanEmptyNotice} role="note">
                        <p className={styles.rootScanEmptyTitle}>
                          {L.rootScanEmptyTitle(notionRootScanWorkspace?.name)}
                        </p>
                        <p>{L.rootScanEmptyWhy}</p>
                        <ol>
                          <li>{L.rootScanEmptyStep1}</li>
                          <li>{L.rootScanEmptyStep2}</li>
                          <li>{L.rootScanEmptyStep3}</li>
                        </ol>
                        <p>{L.rootScanEmptyOtherWorkspace(notionRootScanWorkspace?.name)}</p>
                      </div>
                    ) : null}
                    <details className={styles.manualRootFallback}>
                      <summary>{L.manualRootFallback}</summary>
                      <label className={styles.field}>
                        <span>{L.rootIdsLabel}</span>
                        <textarea
                          value={notionRootIds}
                          onChange={(event) => setNotionRootIds(event.currentTarget.value)}
                          placeholder={L.rootIdsPlaceholder}
                          rows={3}
                        />
                      </label>
                    </details>
                    <p className={styles.stepHint} data-tone={rootIdCount ? "ok" : undefined}>
                      {rootIdCount ? `${L.pagesRecognized(rootIdCount)} · ` : ""}
                      {L.scopeWarning}
                    </p>
                  </div>
                ) : null}
              </section>

              {activeJob ? (
                <section className={styles.stepCard} data-live={activeLive ? "true" : undefined}>
                  <header className={styles.stepHeader}>
                    <span className={styles.stepBadge} aria-hidden="true">3</span>
                    <strong>{L.stepProgress}</strong>
                    <span className={styles.statusPill} data-status={activeJob.status}>
                      {statusLabel(activeJob)}
                    </span>
                  </header>

                  <div className={styles.jobSummary} role="status">
                    <strong>{statusLabel(activeJob)}</strong>
                    <span>
                      {activeJob.status === "completed" && activeApplied
                        ? L.importedItems(activeApplied.pages + activeApplied.databases + activeApplied.rows)
                        : L.discoveredItems(activeItemCount)}
                      {progressSummaryText(activeJob) ? ` · ${progressSummaryText(activeJob)}` : ""}
                      {discoveryDetailText(activeJob) ? ` · ${discoveryDetailText(activeJob)}` : ""}
                    </span>
                  </div>

                  {activeSteps.length ? (
                    <ol className={styles.progressSteps}>
                      {activeSteps.map((step) => (
                        <li key={step.key} className={styles.progressStep} data-status={step.status ?? "pending"}>
                          <span className={styles.progressStepDot} aria-hidden="true" />
                          {L.progressSteps[step.key] ?? step.label ?? step.key}
                        </li>
                      ))}
                    </ol>
                  ) : null}

                  <div
                    className={styles.progressTrack}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={activePercent}
                  >
                    <span
                      style={activePercent !== undefined ? { width: `${activePercent}%` } : undefined}
                      data-indeterminate={activePercent === undefined && activeLive ? "true" : undefined}
                    />
                  </div>

                  <div className={styles.statGrid}>
                    <div className={styles.statBlock}>
                      <span className={styles.statLabel}>{L.discoveredStat}</span>
                      <span className={styles.statValue}>
                        {activeDiscovered.length ? activeDiscovered.join(" · ") : L.noDiscovered}
                        {activeJob.progress?.hasMore === true ? ` · ${L.moreAvailable}` : ""}
                      </span>
                    </div>
                    {activeApplied ? (
                      <div className={styles.statBlock}>
                        <span className={styles.statLabel}>{L.importedStat}</span>
                        <span className={styles.statValue}>
                          {[
                            activeApplied.pages ? L.countUnit("page", activeApplied.pages) : "",
                            activeApplied.databases ? L.countUnit("database", activeApplied.databases) : "",
                            activeApplied.rows ? L.formatMetric(activeApplied.rows, L.metric("rows")) : "",
                            activeApplied.blocks ? L.formatMetric(activeApplied.blocks, L.metric("blocks")) : "",
                          ]
                            .filter(Boolean)
                            .join(" · ") || "0"}
                        </span>
                      </div>
                    ) : null}
                    {activeApplied && (activeApplied.fileCopies || activeApplied.fileCopySkipped) ? (
                      <div className={styles.statBlock}>
                        <span className={styles.statLabel}>{L.filesStat}</span>
                        <span className={styles.statValue}>
                          {`${activeApplied.fileCopies} ${L.copied}`}
                          {activeApplied.fileCopySkipped ? ` · ${activeApplied.fileCopySkipped} ${L.skipped}` : ""}
                        </span>
                      </div>
                    ) : null}
                  </div>

                  {reportSummaryText(activeJob, L) || writeSummaryText(activeJob, L) ? (
                    <div className={styles.reportPanel}>
                      {writeSummaryText(activeJob, L) ? (
                        <div className={styles.planWrites}>{writeSummaryText(activeJob, L)}</div>
                      ) : null}
                      {reportMetricEntries(activeJob, L).length ? (
                        <div className={styles.reportMetrics}>
                          {reportMetricEntries(activeJob, L).map((entry) => (
                            <span key={entry.key}>{L.formatMetric(entry.value, entry.label)}</span>
                          ))}
                        </div>
                      ) : null}
                      {reportIssueGroups(activeJob, L).length ? (
                        <div className={styles.reportGroups}>
                          {reportIssueGroups(activeJob, L).map((group) => (
                            <details key={group.key} className={styles.reportGroup} open={group.key !== "warnings"}>
                              <summary>
                                <span>{group.label}</span>
                                <span>{group.issues.length}</span>
                              </summary>
                              <ul className={styles.reportIssues}>
                                {group.issues.slice(0, 6).map((issue, index) => (
                                  <li key={`${issue.code ?? group.key}-${issue.notionId ?? index}`}>
                                    {issue.message || issue.code || "Import issue"}
                                  </li>
                                ))}
                                {group.issues.length > 6 ? (
                                  <li>{group.issues.length - 6} more</li>
                                ) : null}
                              </ul>
                            </details>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className={styles.notionActions}>
                    {jobActions(activeJob)}
                    {activeJob.status === "completed" && importedRootPage?.jobId === activeJob.id ? (
                      <button
                        type="button"
                        className={styles.primary}
                        onClick={() => {
                          close(false);
                          router.push(pageHref(importedRootPage.pageId));
                        }}
                      >
                        {L.openImportedPage}
                      </button>
                    ) : null}
                  </div>
                </section>
              ) : null}

              <div className={styles.actionBar}>
                <button
                  type="button"
                  className={styles.primary}
                  onClick={() => void startNotionImport()}
                  disabled={notionBusy || notionRootScanBusy || !workspace?.id || !hasCredential}
                >
                  {notionBusy ? L.discovering : L.startDiscovery}
                </button>
                <span className={styles.actionBarHint}>
                  {notionScope === "workspace" ? L.scopeWorkspace : L.scopePages}
                  {" · "}
                  {workspace?.name || ""}
                </span>
              </div>
            </div>
          )}
        </div>

        <input
          ref={inputRef}
          className={styles.hiddenInput}
          type="file"
          accept={ACCEPTED_IMPORTS}
          tabIndex={-1}
          aria-hidden="true"
          onChange={onInputChange}
        />
      </section>
    </div>
  );
}
