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
  beginNotionOAuthConnectionRemote,
  cancelNotionImportJobRemote,
  completeNotionOAuthConnectionRemote,
  createNotionImportConnectionRemote,
  createNotionImportJobRemote,
  discoverNotionImportJobRemote,
  fetchRuntimeConfigRemote,
  getNotionImportJobRemote,
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
import { useTranslation } from "react-i18next";
import { useRouter } from "@/lib/router";
import { pageHref } from "@/lib/navigation";
import {
  advanceNotionDiscoveryStallState,
  NOTION_DISCOVERY_STALL_LIMIT,
  notionDiscoveryShouldContinue,
} from "@/lib/notionImportResume";
import { estimateImportRunMetrics } from "@/lib/importRunMetrics";
import {
  activePersistentGeneratedLabels,
  persistentGeneratedLabels,
  productLocaleFromLanguage,
} from "@/lib/persistentGeneratedLabels";
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
// Per-batch client timeout. The SDK's functions.post has no abort option, so a
// stalled/dead backend would otherwise leave the scan spinning forever ("요청
// 0회 · 스캔 중"). This bound is generous enough for a slow /search page plus
// server-side retry/backoff, but still surfaces "server not responding" instead
// of an infinite spinner.
const NOTION_ROOT_SCAN_BATCH_TIMEOUT_MS = 60_000;
// Safety cap on incremental discover chunks (each enriches a small batch). Far
// above any real workspace's need; a runaway backstop, not a functional limit.
const NOTION_MAX_DISCOVER_CHUNKS = 2000;
// Consecutive discover-chunk failures tolerated before surfacing the error;
// a brief 503/timeout should not tear down a long import (chunks retry with
// backoff and unchanged cursor/seed state).
const NOTION_DISCOVER_MAX_RETRIES = 5;
// Apply is also a persisted, resumable operation. Keep each product-write
// request small enough for the DO and loop the server's `partial` responses
// until it reports the job completed.
const NOTION_MAX_APPLY_CHUNKS = 2_000;
const NOTION_APPLY_MAX_RETRIES = 5;
const NOTION_APPLY_DATABASE_BATCH_SIZE = 25;
const NOTION_APPLY_PAGE_BATCH_SIZE = 20;
const NOTION_STATUS_POLL_INTERVAL_MS = 3_000;
// Discovery deliberately survives dialog unmounts. Keep one runner per job at
// module scope so reopening the dialog joins the in-flight runner instead of
// starting a second cursor/progress writer for the same durable job.
const notionDiscoveryRunnerCompletions = new Map<string, Promise<void>>();

export type NotionImportActivitySummary = {
  jobId: string;
  mode: "discover" | "apply";
  percent: number;
};

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

type Translate = (key: string, options?: Record<string, unknown>) => string;

// UI copy for the import dialog is resolved through react-i18next. The render
// tree keeps reading `labels.<field>`; this builder produces that shape from the
// active `t` (English is the source catalog, Korean/other languages are
// translations). Interpolation and plural selection are delegated to i18next.
function buildImportLabels(t: Translate) {
  const obj = (key: string) =>
    t(key, { returnObjects: true }) as unknown as Record<string, string>;
  const list = (key: string) => t(key, { returnObjects: true }) as unknown as string[];
  return {
    title: t("importDialog:title"),
    close: t("importDialog:close"),
    navAria: t("importDialog:navAria"),
    file: t("importDialog:file"),
    notion: t("importDialog:notion"),
    chooseFile: t("importDialog:chooseFile"),
    chooseFileButton: t("importDialog:chooseFileButton"),
    importingFile: t("importDialog:importingFile"),
    dropToImport: t("importDialog:dropToImport"),
    preparingImport: t("importDialog:preparingImport"),
    supportedImports: t("importDialog:supportedImports"),
    markdownExts: t("importDialog:markdownExts"),
    destinationNote: t("importDialog:destinationNote"),
    stepConnect: t("importDialog:stepConnect"),
    stepScope: t("importDialog:stepScope"),
    stepProgress: t("importDialog:stepProgress"),
    connectedTo: (name: string) => t("importDialog:connectedTo", { name }),
    savedConnection: t("importDialog:savedConnection"),
    oneTimeToken: t("importDialog:oneTimeToken"),
    remove: t("importDialog:remove"),
    shareReminder: t("importDialog:shareReminder"),
    tokenIntroTitle: t("importDialog:tokenIntroTitle"),
    tokenIntroDesc: t("importDialog:tokenIntroDesc"),
    openTokenPage: t("importDialog:openTokenPage"),
    tokenHelpLink: t("importDialog:tokenHelpLink"),
    tokenInstructionsTitle: t("importDialog:tokenInstructionsTitle"),
    tokenInstructionItems: list("importDialog:tokenInstructionItems"),
    tokenSummary: t("importDialog:tokenSummary"),
    tokenLabel: t("importDialog:tokenLabel"),
    tokenPlaceholder: t("importDialog:tokenPlaceholder"),
    connectionNameLabel: t("importDialog:connectionNameLabel"),
    optional: t("importDialog:optional"),
    saveConnection: t("importDialog:saveConnection"),
    connectWithNotion: t("importDialog:connectWithNotion"),
    oauthConfiguredHint: t("importDialog:oauthConfiguredHint"),
    cantStartOAuth: t("importDialog:cantStartOAuth"),
    connectionStorageUnavailable: t("importDialog:connectionStorageUnavailable"),
    scopeWorkspace: t("importDialog:scopeWorkspace"),
    recommended: t("importDialog:recommended"),
    scopeWorkspaceDesc: t("importDialog:scopeWorkspaceDesc"),
    scopePages: t("importDialog:scopePages"),
    scopePagesDesc: t("importDialog:scopePagesDesc"),
    scanRoots: t("importDialog:scanRoots"),
    scanningRoots: t("importDialog:scanningRoots"),
    rootScanHint: t("importDialog:rootScanHint"),
    rootScanProgress: (roots: number, scanned: number, pages: number) =>
      t("importDialog:rootScanProgress", {
        roots,
        scanned,
        pages,
        candidate: t("importDialog:units.candidate", { count: roots }),
        item: t("importDialog:units.item", { count: scanned }),
        request: t("importDialog:units.request", { count: pages }),
      }),
    rootScanFound: (roots: number, scanned: number) =>
      t("importDialog:rootScanFound", {
        roots,
        scanned,
        candidate: t("importDialog:units.candidate", { count: roots }),
        item: t("importDialog:units.item", { count: scanned }),
      }),
    rootScanComplete: (roots: number) => t("importDialog:rootScanComplete", { count: roots }),
    rootScanEmpty: t("importDialog:rootScanEmpty"),
    rootScanWorkspaceLabel: (name: string) => t("importDialog:rootScanWorkspaceLabel", { name }),
    rootScanEmptyTitle: (workspaceName?: string | null) =>
      workspaceName
        ? t("importDialog:rootScanEmptyTitleNamed", { workspaceName })
        : t("importDialog:rootScanEmptyTitleAnon"),
    rootScanEmptyWhy: t("importDialog:rootScanEmptyWhy"),
    rootScanEmptyStep1: t("importDialog:rootScanEmptyStep1"),
    rootScanEmptyStep2: t("importDialog:rootScanEmptyStep2"),
    rootScanEmptyStep3: t("importDialog:rootScanEmptyStep3"),
    rootScanEmptyOtherWorkspace: (workspaceName?: string | null) =>
      workspaceName
        ? t("importDialog:rootScanEmptyOtherWorkspaceNamed", { workspaceName })
        : t("importDialog:rootScanEmptyOtherWorkspaceAnon"),
    rootScanHasMore: t("importDialog:rootScanHasMore"),
    rootPickerTitle: t("importDialog:rootPickerTitle"),
    rootSelectionCount: (selected: number, total: number) =>
      t("importDialog:rootSelectionCount", { selected, total }),
    selectAllRoots: t("importDialog:selectAllRoots"),
    clearRootSelection: t("importDialog:clearRootSelection"),
    manualRootFallback: t("importDialog:manualRootFallback"),
    rootKindPage: t("importDialog:rootKindPage"),
    rootKindDataSource: t("importDialog:rootKindDataSource"),
    rootIdsLabel: t("importDialog:rootIdsLabel"),
    rootIdsPlaceholder: t("importDialog:rootIdsPlaceholder"),
    pagesRecognized: (count: number) => t("importDialog:pagesRecognized", { count }),
    scopeWarning: t("importDialog:scopeWarning"),
    fullWidthPages: t("importDialog:fullWidthPages"),
    fullWidthPagesDesc: t("importDialog:fullWidthPagesDesc"),
    startDiscovery: t("importDialog:startDiscovery"),
    discovering: t("importDialog:discovering"),
    discoveredStat: t("importDialog:discoveredStat"),
    processedStat: t("importDialog:processedStat"),
    processedItems: (count: number) => t("importDialog:processedItems", { count }),
    importedStat: t("importDialog:importedStat"),
    filesStat: t("importDialog:filesStat"),
    copied: t("importDialog:copied"),
    skipped: t("importDialog:skipped"),
    ofTotal: (done: number, total: number) => t("importDialog:ofTotal", { done, total }),
    moreAvailable: t("importDialog:moreAvailable"),
    entireWorkspaceScope: t("importDialog:entireWorkspaceScope"),
    rootPagesScope: (count: number) => t("importDialog:rootPagesScope", { count }),
    discoveredItems: (count: number) => t("importDialog:discoveredItems", { count }),
    importedItems: (count: number) => t("importDialog:importedItems", { count }),
    noDiscovered: t("importDialog:noDiscovered"),
    formatMetric: (value: number, label: string) =>
      t("importDialog:formatMetric", { value, label }),
    review: t("importDialog:review"),
    apply: t("importDialog:apply"),
    expand: t("importDialog:expand"),
    retry: t("importDialog:retry"),
    retryFiles: t("importDialog:retryFiles"),
    cancelImport: t("importDialog:cancelImport"),
    cancellingImport: t("importDialog:cancellingImport"),
    resumeImport: t("importDialog:resumeImport"),
    resumingImport: t("importDialog:resumingImport"),
    resumeNeedsCredential: t("importDialog:resumeNeedsCredential"),
    discoveryPaused: t("importDialog:discoveryPaused"),
    importCancelled: t("importDialog:importCancelled"),
    cantCancelImport: t("importDialog:cantCancelImport"),
    openImportedPage: t("importDialog:openImportedPage"),
    notionWorkspace: t("importDialog:notionWorkspace"),
    status: obj("importDialog:status"),
    progressSteps: obj("importDialog:progressSteps"),
    metric: (key: string) => t(`importDialog:metricLabels.${key}`, { defaultValue: key }),
    countUnit: (key: string, value: number) =>
      t("importDialog:countUnitFormat", {
        value,
        unit: t(`importDialog:countUnits.${key}`, { defaultValue: key }),
      }),
    issueGroups: obj("importDialog:issueGroups"),
    markdownNoun: (kind: string, count: number) =>
      t("importDialog:markdownNoun", {
        n: count,
        noun: t(kind === "database" ? "importDialog:units.row" : "importDialog:units.block", {
          count,
        }),
      }),
    emptyDatabaseImported: t("importDialog:emptyDatabaseImported"),
    noMarkdownBlocks: t("importDialog:noMarkdownBlocks"),
    useSupportedFile: t("importDialog:useSupportedFile"),
    cantImportFile: t("importDialog:cantImportFile"),
    tokenOrConnectionRequired: t("importDialog:tokenOrConnectionRequired"),
    rootPagesRequired: t("importDialog:rootPagesRequired"),
    foundItems: (count: number) => t("importDialog:foundItems", { count }),
    jobCreated: t("importDialog:jobCreated"),
    cantStartImport: t("importDialog:cantStartImport"),
    tokenRequired: t("importDialog:tokenRequired"),
    tokenMustStartWithNtn: t("importDialog:tokenMustStartWithNtn"),
    connectionSaved: t("importDialog:connectionSaved"),
    cantSaveConnection: t("importDialog:cantSaveConnection"),
    oauthSaved: t("importDialog:oauthSaved"),
    oauthCancelled: (reason: string) => t("importDialog:oauthCancelled", { reason }),
    oauthMissingCode: t("importDialog:oauthMissingCode"),
    cantFinishOAuth: t("importDialog:cantFinishOAuth"),
    connectionRemoved: t("importDialog:connectionRemoved"),
    cantRemoveConnection: t("importDialog:cantRemoveConnection"),
    reviewReady: t("importDialog:reviewReady"),
    cantReview: t("importDialog:cantReview"),
    expandNeedsCredential: t("importDialog:expandNeedsCredential"),
    rootScanNeedsCredential: t("importDialog:rootScanNeedsCredential"),
    discoveryExpanded: (count: number) => t("importDialog:discoveryExpanded", { count }),
    cantScanRoots: t("importDialog:cantScanRoots"),
    rootScanTimedOut: t("importDialog:rootScanTimedOut"),
    cantExpand: t("importDialog:cantExpand"),
    importApplied: t("importDialog:importApplied"),
    cantApply: t("importDialog:cantApply"),
    fileRetryFinished: (copied: number, skipped: number) =>
      t("importDialog:fileRetryFinished", { copied, skipped }),
    cantRetryFiles: t("importDialog:cantRetryFiles"),
    importFileFallback: t("importDialog:importFileFallback"),
    issueFallback: t("importDialog:issueFallback"),
    notionConnectionFallback: t("importDialog:notionConnectionFallback"),
    wizard: {
      stepsAria: t("importDialog:wizard.stepsAria"),
      stepLabels: list("importDialog:wizard.stepLabels"),
      back: t("importDialog:wizard.back"),
      next: t("importDialog:wizard.next"),
      needCredentialHint: t("importDialog:wizard.needCredentialHint"),
      needRootsHint: t("importDialog:wizard.needRootsHint"),
      applyNow: t("importDialog:wizard.applyNow"),
      applying: t("importDialog:wizard.applying"),
      readyHint: (count: number) => t("importDialog:wizard.readyHint", { count }),
      runningHint: t("importDialog:wizard.runningHint"),
      browserRunnerWarning: t("importDialog:wizard.browserRunnerWarning"),
      noJobHint: t("importDialog:wizard.noJobHint"),
      applyLocksHint: t("importDialog:wizard.applyLocksHint"),
      done: t("common:actions.done"),
    },
    installer: {
      elapsed: t("importDialog:installer.elapsed"),
      speed: t("importDialog:installer.speed"),
      itemsPerSecond: (rate: string) => t("importDialog:installer.itemsPerSecond", { rate }),
      foundCount: (count: number) => t("importDialog:installer.foundCount", { count }),
      activityLog: t("importDialog:installer.activityLog"),
      waitingForProgress: t("importDialog:installer.waitingForProgress"),
      searching: t("importDialog:installer.searching"),
      objectTypes: obj("importDialog:installer.objectTypes"),
      activity: (kind: string, title?: string, count?: number, total?: number) => {
        const titleText = title ? `“${title}”` : "";
        const suffix =
          count !== undefined && total !== undefined && total > 0 ? ` (${count}/${total})` : "";
        const named = titleText || t("importDialog:installer.activity.untitled");
        switch (kind) {
          case "search_complete":
            return t("importDialog:installer.activity.searchComplete", { n: count ?? 0 });
          case "discovery_complete":
            return t("importDialog:installer.activity.discoveryComplete", { n: count ?? 0 });
          case "read_page":
            return t("importDialog:installer.activity.readPage", { title: named, suffix });
          case "read_data_source":
            return t("importDialog:installer.activity.readDataSource", { title: named, suffix });
          case "create_database":
            return t("importDialog:installer.activity.createDatabase", { title: named, suffix });
          case "create_page":
            return t("importDialog:installer.activity.createPage", { title: named, suffix });
          case "create_row":
            return t("importDialog:installer.activity.createRow", { title: named, suffix });
          case "remap_relations":
            return t("importDialog:installer.activity.remapRelations");
          default:
            return t("importDialog:installer.activity.fallback", {
              kind: kind.replace(/_/g, " "),
              titlePart: titleText ? ` ${titleText}` : "",
              suffix,
            });
        }
      },
    },
    hanji: {
      tab: t("importDialog:hanji.tab"),
      title: t("importDialog:hanji.title"),
      fromFile: t("importDialog:hanji.fromFile"),
      fromLive: t("importDialog:hanji.fromLive"),
      choose: t("importDialog:hanji.choose"),
      chooseButton: t("importDialog:hanji.chooseButton"),
      fileHint: t("importDialog:hanji.fileHint"),
      selected: (name: string) => t("importDialog:hanji.selected", { name }),
      importButton: t("importDialog:hanji.importButton"),
      importing: t("importDialog:hanji.importing"),
      remoteUrl: t("importDialog:hanji.remoteUrl"),
      remoteUrlPlaceholder: t("importDialog:hanji.remoteUrlPlaceholder"),
      remoteWorkspace: t("importDialog:hanji.remoteWorkspace"),
      remoteToken: t("importDialog:hanji.remoteToken"),
      remoteTokenOptional: t("importDialog:hanji.remoteTokenOptional"),
      fetch: t("importDialog:hanji.fetch"),
      fetching: t("importDialog:hanji.fetching"),
      liveHint: t("importDialog:hanji.liveHint"),
      review: (summary: string) => t("importDialog:hanji.review", { summary }),
      placeholderNote: t("importDialog:hanji.placeholderNote"),
      importedItems: (count: number) => t("importDialog:hanji.importedItems", { count }),
      cantRead: t("importDialog:hanji.cantRead"),
      cantImport: t("importDialog:hanji.cantImport"),
      needFile: t("importDialog:hanji.needFile"),
      needRemote: t("importDialog:hanji.needRemote"),
    },
  };
}

type ImportDialogLabels = ReturnType<typeof buildImportLabels>;

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

// Reject if `promise` doesn't settle within `ms`. The underlying request can't
// be aborted (the SDK exposes no signal), so on timeout it keeps running in the
// background and its late result is ignored; callers guard with a run id.
function withTimeout<T>(promise: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
    // Database rows (a page whose parent is a database/data source) are never
    // standalone import roots — they come in with their database. Skipping them
    // stops a partial scan page from flagging rows as "accessible_parent_missing"
    // (their data source isn't in that same 100-item page) and flooding the picker.
    if (item.parentType === "database_id" || item.parentType === "data_source_id") continue;
    const normalizedId = normalizedNotionRootId(item.id);
    if (!normalizedId || candidates.has(normalizedId)) continue;
    const normalizedParentId = normalizedNotionRootId(item.parentNotionId);
    const isWorkspaceParent = item.parentType === "workspace";
    const isAccessibleParentMissing = !!normalizedParentId && !knownIds.has(normalizedParentId);
    if (!isWorkspaceParent && !isAccessibleParentMissing) continue;
    candidates.set(normalizedId, {
      id: item.id,
      notionObject: item.notionObject,
      title: item.title || activePersistentGeneratedLabels().untitled,
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

// Items whose snapshot has been captured = discovered total − still-pending.
// Monotonic: finding a new reference bumps both total and pending (no change);
// enriching one drops pending (count goes up). Never decreases.
function processedItemCount(job: NotionImportJob): number | undefined {
  const pending = (job.progress as { pendingEnrichment?: unknown } | undefined)?.pendingEnrichment;
  if (typeof pending !== "number" || !Number.isFinite(pending)) return undefined;
  const total = Object.values(discoveredByTypeOf(job)).reduce((sum, value) => sum + value, 0);
  return Math.max(0, total - Math.max(0, pending));
}

function progressSummaryText(job: NotionImportJob, labels: ImportDialogLabels) {
  const progress = job.progress ?? {};
  // Once the job is finished, the last step label ("Applying...") is stale;
  // the status pill/current line owns the settled state. Percentages are
  // deliberately not surfaced because discovery grows its own total and apply
  // phases have very different costs, so a determinate value is false precision.
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return "";
  }
  // Localize through the step KEY — the backend's currentLabel is English-only.
  const stepKey = typeof progress.currentStep === "string" ? progress.currentStep : "";
  const label =
    (stepKey && labels.progressSteps[stepKey]) ||
    (typeof progress.currentLabel === "string" && progress.currentLabel.trim()
      ? progress.currentLabel.trim()
      : typeof progress.step === "string" && progress.step.trim()
        ? progress.step.trim().replace(/_/g, " ")
        : "");
  return label;
}

type ImportActivityEntry = {
  at?: string;
  kind: string;
  title?: string;
  count?: number;
  total?: number;
  // Running discovered total at the moment this line was first logged, stamped
  // client-side so the scrolling feed shows how many items were found over time.
  discoveredAt?: number;
};

// The server activity ring is small and resets per discover chunk; the client
// keeps its own rolling window of the newest lines across chunks so the feed
// reads like an installer log. Older lines beyond this cap are dropped.
const IMPORT_LOG_MAX_LINES = 100;

function discoveredTotalOf(job: NotionImportJob): number {
  return Object.values(discoveredByTypeOf(job)).reduce((sum, value) => sum + value, 0);
}

function activityEntryKey(entry: ImportActivityEntry): string {
  return `${entry.at ?? ""}|${entry.kind}|${entry.title ?? ""}|${entry.count ?? ""}|${entry.total ?? ""}`;
}

function recentActivityOf(job: NotionImportJob): ImportActivityEntry[] {
  const raw = (job.progress as { recent?: unknown } | undefined)?.recent;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is ImportActivityEntry =>
      !!item && typeof item === "object" && typeof (item as { kind?: unknown }).kind === "string",
  );
}

function discoveredByTypeOf(job: NotionImportJob): Record<string, number> {
  const raw = (job.progress as { byType?: unknown } | undefined)?.byType;
  if (!raw || typeof raw !== "object") return {};
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) next[key] = value;
  }
  return next;
}

function activityTimeText(at?: string) {
  if (!at) return "";
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}

function formatDuration(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds)) return "";
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function elapsedText(startedAt?: string, nowMs?: number) {
  if (!startedAt) return "";
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "";
  return formatDuration(((nowMs ?? Date.now()) - started) / 1000);
}

function progressStepStartedAt(job: NotionImportJob, key: string) {
  const raw = job.progress?.steps;
  if (!Array.isArray(raw)) return undefined;
  const step = raw.find(
    (item) => !!item && typeof item === "object" && (item as Record<string, unknown>).key === key,
  ) as Record<string, unknown> | undefined;
  return typeof step?.startedAt === "string" ? step.startedAt : undefined;
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
  const fromCounts = displayCounts(job).map(([key, value]) => labels.countUnit(key, value));
  if (fromCounts.length) return fromCounts;
  // Live discovery: the final counts are not written yet, but the throttled
  // progress snapshot already carries a by-type breakdown — never show
  // "no discovered items" while the summary line is counting up.
  const byType = discoveredByTypeOf(job);
  const fromByType = Object.entries(byType)
    .filter(([key]) => !(key === "data_source" && (byType.database ?? 0) > 0))
    .map(([key, value]) => labels.countUnit(key, value));
  if (fromByType.length) return fromByType;
  const discovered = job.progress?.discovered;
  if (typeof discovered === "number" && Number.isFinite(discovered) && discovered > 0) {
    return [labels.discoveredItems(discovered)];
  }
  return [];
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

export function ImportDialog({
  open = true,
  onClose,
  onActivityChange,
  initialTab,
}: {
  open?: boolean;
  onClose: () => void;
  onActivityChange?: (activity: NotionImportActivitySummary | null) => void;
  initialTab?: "file" | "notion" | "hanji";
}) {
  const { t, i18n } = useTranslation(["importDialog", "common"]);
  const generatedLabels = persistentGeneratedLabels(t);
  const productLocale = productLocaleFromLanguage(i18n.resolvedLanguage ?? i18n.language);
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
  const L = buildImportLabels(t as unknown as Translate);
  // `buildImportLabels()` returns a fresh object each render, so the one-shot OAuth
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
  // on it by default; creation flows can land directly on another tab (e.g.
  // the Hanji cross-instance pull) via initialTab.
  const [source, setSource] = useState<"file" | "notion" | "hanji">(initialTab ?? "notion");
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
  const [notionOAuthConfigured, setNotionOAuthConfigured] = useState(false);
  const [notionJobs, setNotionJobs] = useState<NotionImportJob[]>([]);
  const [notionResult, setNotionResult] = useState<{
    job: NotionImportJob;
    itemCount: number;
  } | null>(null);
  const [importedRootPage, setImportedRootPage] = useState<{ jobId: string; pageId: string } | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  // Wizard position for the Notion tab: 1 connect, 2 scope, 3 discover,
  // 4 apply/result. Auto-advances on job transitions; manual back is allowed.
  const [notionStep, setNotionStep] = useState(1);
  const notionStepJobKeyRef = useRef("");
  const autoResumeJobIdRef = useRef("");
  const credentialPromptJobIdRef = useRef("");
  // 1s clock for the installer-style run panel (elapsed time keeps counting
  // between polls).
  const [runNowMs, setRunNowMs] = useState(() => Date.now());
  const runLogRef = useRef<HTMLDivElement>(null);
  // Rolling client-side activity feed (see IMPORT_LOG_MAX_LINES). Accumulated
  // from each poll's server ring, deduped, and capped — reset per job.
  const [logEntries, setLogEntries] = useState<ImportActivityEntry[]>([]);
  const logJobIdRef = useRef("");
  const logSeenRef = useRef<Set<string>>(new Set());
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
  const notionTargetWorkspaceRef = useRef(workspace?.id);

  const refreshNotionImportState = useCallback((): Promise<void> => {
    const workspaceId = workspace?.id;
    if (!workspaceId || sourceRef.current !== "notion") {
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

  const notionPollingJobId =
    (notionResult && isLiveNotionJob(notionResult.job) ? notionResult.job.id : undefined) ??
    notionJobs.find(isLiveNotionJob)?.id;

  const close = useCallback((restoreFocus = true) => {
    closedRef.current = true;
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
    let mounted = true;
    fetchRuntimeConfigRemote()
      .then((config) => {
        if (mounted) setNotionOAuthConfigured(config.notionOAuthConfigured);
      })
      .catch(() => {
        if (mounted) setNotionOAuthConfigured(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

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
    if (!open) return;
    closedRef.current = false;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (notionTargetWorkspaceRef.current === workspace?.id) return;
    notionTargetWorkspaceRef.current = workspace?.id;
    notionRefreshRunRef.current += 1;
    notionRefreshInFlightRef.current = null;
    setNotionJobs([]);
    setNotionResult(null);
    setImportedRootPage(null);
    setSelectedConnectionId("");
  }, [workspace?.id]);

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

  // One-shot self-heal for legacy/interrupted imports: rebuild page routing,
  // unwrap completed staging roots, and hide failed partial output.
  const repairedWorkspacesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const workspaceId = workspace?.id;
    if (source !== "notion" || !workspaceId) return;
    if (repairedWorkspacesRef.current.has(workspaceId)) return;
    repairedWorkspacesRef.current.add(workspaceId);
    void repairNotionImportPageIndexesRemote(workspaceId)
      .then((result) => {
        if ((result.unwrapped ?? 0) > 0 || (result.trashed ?? 0) > 0) {
          return refreshWorkspacePages();
        }
      })
      .catch(() => {
        repairedWorkspacesRef.current.delete(workspaceId);
      });
  }, [refreshWorkspacePages, source, workspace?.id]);

  useEffect(() => {
    const workspaceId = workspace?.id;
    const jobId = notionPollingJobId;
    if (source !== "notion" || !workspaceId || !jobId) return;
    let cancelled = false;
    let timer = 0;
    // The initial/full refresh above owns job and connection lists. While one
    // import is active, read only that job every 3s; connection metadata does
    // not change with discovery progress. Schedule after settlement so slow
    // status reads can never overlap.
    const tick = async () => {
      try {
        const snapshot = await getNotionImportJobRemote(jobId, workspaceId);
        if (
          cancelled ||
          sourceRef.current !== "notion" ||
          useStore.getState().workspace?.id !== workspaceId
        ) {
          return;
        }
        setNotionJobs((current) => {
          const index = current.findIndex((job) => job.id === jobId);
          if (index < 0) return [snapshot.job, ...current].slice(0, 5);
          return current.map((job) => (job.id === jobId ? snapshot.job : job));
        });
        setNotionResult((current) =>
          current?.job.id === jobId
            ? {
                job: snapshot.job,
                itemCount: itemCountFromJob(snapshot.job, current.itemCount),
              }
            : current
        );
      } catch {
        // A dropped status read is harmless; the next tick reads the durable job.
      }
      if (!cancelled) timer = window.setTimeout(tick, NOTION_STATUS_POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(tick, NOTION_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, workspace?.id, notionPollingJobId]);

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
    setImportingFileName(file.name || L.importFileFallback);
    try {
      const { importWorkspaceFile } = await import("./pageMarkdownImport");
      const result = await importWorkspaceFile(file, {
        locale: productLocale,
        untitled: generatedLabels.untitled,
      });
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

  async function persistEnteredNotionToken(token: string) {
    if (!workspace?.id) throw new Error(L.cantSaveConnection);
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
    return result.connection;
  }

  async function resolveNotionCredential(token: string, fallbackConnectionId?: string) {
    if (token && notionConnectionStorageAvailable) {
      const connection = await persistEnteredNotionToken(token);
      return {
        token: "",
        connectionId: connection.id,
        connectionKind: connection.connectionKind,
        connection,
      };
    }
    const connectionId = token ? undefined : fallbackConnectionId || undefined;
    const connection = connectionId
      ? notionConnections.find((item) => item.id === connectionId)
      : undefined;
    return {
      token,
      connectionId,
      connectionKind: connection?.connectionKind,
      connection,
    };
  }

  async function advanceNotionConnectionStep() {
    if (!workspace?.id || notionBusy) return;
    const token = notionToken.trim();
    if (!validateEnteredNotionToken(token)) return;
    if (!token || !notionConnectionStorageAvailable) {
      setNotionStep(2);
      return;
    }
    setNotionBusy(true);
    try {
      await persistEnteredNotionToken(token);
      setNotionStep(2);
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantSaveConnection, "error");
    } finally {
      setNotionBusy(false);
    }
  }

  async function startNotionImport(retryJobId?: string) {
    if (!workspace?.id || notionBusy) return;
    const enteredToken = notionToken.trim();
    if (!validateEnteredNotionToken(enteredToken)) return;
    if (!enteredToken && !selectedConnectionId) {
      setNotionStep(1);
      notify(retryJobId ? L.resumeNeedsCredential : L.tokenOrConnectionRequired, "error");
      return;
    }
    const pageRootIds = rootIds();
    const dataSourceRootIds = rootDataSourceIds();
    if (!retryJobId && notionScope === "pages" && pageRootIds.length === 0 && dataSourceRootIds.length === 0) {
      notify(L.rootPagesRequired, "error");
      return;
    }
    // Every fresh API discovery uses bounded incremental calls. A selected root
    // can still fan out to hundreds of pages in a large imported homepage,
    // so treating page-scoped imports as a short inline request makes a dev
    // worker restart lose the whole in-memory graph.
    const useStreamingDiscovery = !retryJobId;
    setNotionBusy(true);
    try {
      const credential = await resolveNotionCredential(enteredToken, selectedConnectionId);
      const { token, connectionId } = credential;
      if (useStreamingDiscovery) {
        await runStreamingNotionDiscovery({
          workspaceId: workspace.id,
          connectionKind: connectionId
            ? credential.connectionKind ?? "internal_integration"
            : "manual_token",
          connectionId,
          token,
          rootNotionPageIds: pageRootIds,
          rootNotionDataSourceIds: dataSourceRootIds,
        });
        if (connectionId) setNotionToken("");
        return;
      }
      const result = retryJobId
        ? await retryNotionImportJobRemote({
            workspaceId: workspace.id,
            jobId: retryJobId,
            notionToken: token || undefined,
            connectionId,
            importPagesFullWidth: notionImportPagesFullWidth,
            deferDiscovery: true,
          })
        : await createNotionImportJobRemote({
            workspaceId: workspace.id,
            connectionKind: connectionId
              ? credential.connectionKind ?? "internal_integration"
              : "manual_token",
            connectionId,
            notionToken: token || undefined,
            rootNotionPageIds: pageRootIds,
            rootNotionDataSourceIds: dataSourceRootIds,
            importPagesFullWidth: notionImportPagesFullWidth,
            locale: productLocale,
          });
      const itemCount = result.items?.length ?? itemCountFromJob(result.job);
      if (retryJobId && result.job.status === "queued") {
        await runStreamingNotionDiscovery({
          workspaceId: workspace.id,
          connectionKind: result.job.connectionKind,
          connectionId,
          token,
          resumeJob: result.job,
        });
        if (connectionId) setNotionToken("");
        return;
      }
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

  // Stream both workspace-wide and selected-root discovery through bounded
  // incremental calls. A single selected root can fan out to a large graph, so
  // it needs the same durable progress and restart boundary as a whole workspace.
  async function runStreamingNotionDiscovery(args: {
    workspaceId: string;
    connectionKind: NotionImportConnection["connectionKind"];
    connectionId?: string;
    token: string;
    resumeJob?: NotionImportJob;
    rootNotionPageIds?: string[];
    rootNotionDataSourceIds?: string[];
  }) {
    try {
      const created = args.resumeJob
        ? { job: args.resumeJob }
        : await createNotionImportJobRemote({
            workspaceId: args.workspaceId,
            connectionKind: args.connectionKind,
            connectionId: args.connectionId,
            notionToken: args.token || undefined,
            rootNotionPageIds: args.rootNotionPageIds ?? [],
            rootNotionDataSourceIds: args.rootNotionDataSourceIds ?? [],
            importPagesFullWidth: notionImportPagesFullWidth,
            locale: productLocale,
            deferDiscovery: true,
          });
      const jobId = created.job.id;
      // A deferred job is "live" (queued), so this advances the wizard to the run
      // panel immediately instead of stalling on the scope step.
      setNotionResult({ job: created.job, itemCount: 0 });

      const runnerKey = `${args.workspaceId}:${jobId}`;
      const existingRunner = notionDiscoveryRunnerCompletions.get(runnerKey);
      if (existingRunner) {
        await existingRunner;
        const snapshot = await getNotionImportJobRemote(jobId, args.workspaceId).catch(() => null);
        if (snapshot?.job) {
          setNotionResult({
            job: snapshot.job,
            itemCount: itemCountFromJob(snapshot.job),
          });
        }
        await refreshNotionImportStateFresh().catch(() => {});
        return;
      }
      let finishRunner!: () => void;
      const runnerCompletion = new Promise<void>((resolve) => {
        finishRunner = resolve;
      });
      notionDiscoveryRunnerCompletions.set(runnerKey, runnerCompletion);
      try {

      // Incremental discovery: each discover() call does a BOUNDED amount of work
      // (searches a page and/or enriches a small batch of items), persists, and
      // reports whether more remains — so no single request can grind for
      // minutes on a large workspace. Loop short calls until the job reports it
      // is done. The shared active-job poll above streams persisted progress
      // without separately re-reading job and connection lists.
      let job = created.job;
      let discoveryStallState = advanceNotionDiscoveryStallState(undefined, job);

      let discoverError: unknown = null;
      try {
        let continueFromCursor = args.resumeJob
          ? notionDiscoveryShouldContinue(args.resumeJob)
          : false;
        // A single discover chunk can transiently fail (e.g. a 503 if the
        // Durable Object is briefly saturated). Retry the same chunk a few
        // times with backoff instead of tearing down the whole multi-minute
        // import — only give up after several consecutive failures.
        let consecutiveErrors = 0;
        for (let chunk = 0; chunk < NOTION_MAX_DISCOVER_CHUNKS; chunk += 1) {
          let res: Awaited<ReturnType<typeof discoverNotionImportJobRemote>>;
          try {
            res = await discoverNotionImportJobRemote({
              jobId,
              workspaceId: args.workspaceId,
              notionToken: args.token || undefined,
              connectionId: args.connectionId,
              continueFromCursor,
              incremental: true,
            });
            consecutiveErrors = 0;
          } catch (chunkError) {
            consecutiveErrors += 1;
            const record = chunkError && typeof chunkError === "object"
              ? chunkError as { code?: unknown; status?: unknown }
              : null;
            const status = Number(record?.status ?? record?.code);
            if (status === 409) throw chunkError;
            if (consecutiveErrors >= NOTION_DISCOVER_MAX_RETRIES) throw chunkError;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(8000, 1000 * consecutiveErrors))
            );
            continue; // retry the same chunk; cursor/seed state is unchanged
          }
          // Every successful chunk persists either a cursor, a completed-search
          // marker, or both. Later calls continue from that durable boundary.
          continueFromCursor = true;
          job = res.job;
          setNotionResult({ job, itemCount: itemCountFromJob(job) });
          discoveryStallState = advanceNotionDiscoveryStallState(discoveryStallState, job);
          if (
            job.progress?.hasMore === true &&
            discoveryStallState.unchangedChunks >= NOTION_DISCOVERY_STALL_LIMIT
          ) {
            // A successful response that repeats the same durable boundary is
            // not forward progress. Pause instead of issuing up to 2,000
            // identical chunks; the user can retry after reviewing access.
            break;
          }
          // Done when the job flips to ready (no search remaining AND nothing
          // left to enrich).
          if (
            job.status === "ready" ||
            job.status === "failed" ||
            job.status === "cancelled" ||
            job.status === "completed" ||
            job.progress?.hasMore !== true
          ) break;
        }
      } catch (error) {
        discoverError = error;
      }

      if (discoverError) {
        notify(discoverError instanceof Error ? discoverError.message : L.cantStartImport, "error");
      } else {
        const final = await getNotionImportJobRemote(jobId, args.workspaceId).catch(() => null);
        if (final?.job) {
          job = final.job;
          setNotionResult({ job, itemCount: itemCountFromJob(job) });
        }
        if (job.status === "ready" || (job.status !== "cancelled" && job.progress?.hasMore !== true)) {
          notify(L.foundItems(itemCountFromJob(job)), "success");
        } else if (job.status !== "cancelled") {
          notify(L.discoveryPaused, "default");
        }
      }
      await refreshNotionImportStateFresh().catch(() => {});
      } finally {
        finishRunner();
        if (notionDiscoveryRunnerCompletions.get(runnerKey) === runnerCompletion) {
          notionDiscoveryRunnerCompletions.delete(runnerKey);
        }
      }
    } finally {
      setNotionBusy(false);
    }
  }

  async function resumeNotionDiscovery(job: NotionImportJob, automatic = false) {
    if (!workspace?.id || notionBusy) return;
    const enteredToken = automatic ? "" : notionToken.trim();
    if (!validateEnteredNotionToken(enteredToken)) return;
    const fallbackConnectionId = job.connectionId || selectedConnectionId || undefined;
    if (!enteredToken && !fallbackConnectionId) {
      autoResumeJobIdRef.current = "";
      setNotionStep(1);
      notify(L.resumeNeedsCredential, "error");
      return;
    }
    // The job already existed before this manual resume, so the active-job
    // transition effect has no new key to observe. Move to the run panel
    // explicitly instead of leaving the user on Connect with a static
    // "Discovering..." button for the whole resumed chunk sequence.
    setNotionStep(3);
    setNotionBusy(true);
    try {
      const credential = await resolveNotionCredential(enteredToken, fallbackConnectionId);
      await runStreamingNotionDiscovery({
        workspaceId: workspace.id,
        connectionKind: credential.connectionKind ?? job.connectionKind,
        connectionId: credential.connectionId,
        token: credential.token,
        resumeJob: job,
      });
      if (credential.connectionId) setNotionToken("");
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantStartImport, "error");
      setNotionBusy(false);
    }
  }

  async function startNotionOAuthConnection() {
    if (!workspace?.id || notionBusy || !notionOAuthConfigured) return;
    setNotionBusy(true);
    try {
      const result = await beginNotionOAuthConnectionRemote({
        workspaceId: workspace.id,
        name: notionConnectionName.trim() || undefined,
        redirectUri: notionOAuthRedirectUri(),
      });
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantStartOAuth, "error");
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
      await persistEnteredNotionToken(token);
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
        const result = await withTimeout(
          listNotionImportRootsRemote({
            workspaceId: workspace.id,
            notionToken: token || undefined,
            connectionId,
            maxSearchPages: NOTION_ROOT_SCAN_BATCH_PAGES,
            startCursor: cursor,
            includeWorkspace: batch === 0,
            recordAudit: batch === 0,
          }),
          NOTION_ROOT_SCAN_BATCH_TIMEOUT_MS,
          () => new Error(L.rootScanTimedOut),
        );
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
      // Clear the "running" flag so a failed/timed-out scan stops showing
      // "스캔 중… 요청 0회" forever; the button already resets via busy below.
      setNotionRootScanSummary((prev) => (prev ? { ...prev, running: false } : prev));
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
    const enteredToken = notionToken.trim();
    if (!validateEnteredNotionToken(enteredToken)) return;
    const fallbackConnectionId = job.connectionId || selectedConnectionId || undefined;
    if (!enteredToken && !fallbackConnectionId) {
      notify(L.expandNeedsCredential, "error");
      return;
    }
    setNotionBusy(true);
    try {
      const credential = await resolveNotionCredential(enteredToken, fallbackConnectionId);
      const result = await discoverNotionImportJobRemote({
        workspaceId: workspace?.id,
        jobId: job.id,
        notionToken: credential.token || undefined,
        connectionId: credential.connectionId,
        continueFromCursor: typeof job.progress?.nextCursor === "string" && job.progress.nextCursor.length > 0,
      });
      await refreshNotionImportStateFresh();
      const itemCount = result.items?.length ?? itemCountFromJob(result.job);
      setNotionResult({ job: result.job, itemCount });
      notify(L.discoveryExpanded(itemCount), "success");
      if (credential.connectionId) setNotionToken("");
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantExpand, "error");
    } finally {
      setNotionBusy(false);
    }
  }

  async function applyNotionImport(jobId: string) {
    if (notionBusy) return;
    const enteredToken = notionToken.trim();
    if (!validateEnteredNotionToken(enteredToken)) return;
    const job = notionJobs.find((item) => item.id === jobId) ?? notionResult?.job;
    const fallbackConnectionId = job?.connectionId || selectedConnectionId || undefined;
    setNotionStep(4);
    setNotionBusy(true);
    try {
      const credential = await resolveNotionCredential(enteredToken, fallbackConnectionId);
      let result: Awaited<ReturnType<typeof applyNotionImportJobRemote>> | null = null;
      let consecutiveErrors = 0;
      for (let chunk = 0; chunk < NOTION_MAX_APPLY_CHUNKS; chunk += 1) {
        let chunkResult: Awaited<ReturnType<typeof applyNotionImportJobRemote>>;
        try {
          chunkResult = await applyNotionImportJobRemote({
            workspaceId: workspace?.id,
            jobId,
            notionToken: credential.token || undefined,
            connectionId: credential.connectionId,
            importPagesFullWidth: notionImportPagesFullWidth,
            applyDatabaseBatchSize: NOTION_APPLY_DATABASE_BATCH_SIZE,
            applyPageBatchSize: NOTION_APPLY_PAGE_BATCH_SIZE,
          });
          consecutiveErrors = 0;
        } catch (chunkError) {
          const record = chunkError && typeof chunkError === "object"
            ? chunkError as { code?: unknown; status?: unknown }
            : null;
          const status = Number(record?.status ?? record?.code);
          const retryable = status === 429 || status === 502 || status === 503 || status === 504;
          consecutiveErrors += 1;
          if (!retryable || consecutiveErrors >= NOTION_APPLY_MAX_RETRIES) throw chunkError;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(8_000, 1_000 * consecutiveErrors))
          );
          chunk -= 1;
          continue;
        }
        result = chunkResult;
        setNotionResult({
          job: chunkResult.job,
          itemCount: itemCountFromJob(chunkResult.job),
        });
        if (chunkResult.partial !== true || chunkResult.job.status === "completed") break;
      }
      if (!result || result.partial === true || result.job.status !== "completed") {
        throw new Error(L.cantApply);
      }
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
      if (credential.connectionId) setNotionToken("");
    } catch (error) {
      // A failed apply moves its partial product pages to Trash server-side;
      // refresh immediately so stale staging entries disappear from the tree.
      void refreshWorkspacePages().catch(() => {});
      const snapshot = workspace?.id
        ? await getNotionImportJobRemote(jobId, workspace.id).catch(() => null)
        : null;
      if (snapshot?.job) {
        setNotionResult({
          job: snapshot.job,
          itemCount: itemCountFromJob(snapshot.job),
        });
      }
      if (snapshot?.job.status !== "cancelled") {
        notify(error instanceof Error ? error.message : L.cantApply, "error");
      }
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
      // The server-side cancellation fence already owns the old job. Do not
      // keep the fresh-start controls disabled while an obsolete Notion
      // request is still returning in the background.
      setNotionBusy(false);
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
        <span className={styles.jobActions}>
          {!notionBusy ? (
            <button
              type="button"
              className={styles.secondary}
              onClick={() => void resumeNotionDiscovery(job)}
            >
              {L.resumeImport}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void cancelNotionImport(job.id)}
            disabled={cancellingJobId !== null}
          >
            {cancellingJobId === job.id ? L.cancellingImport : L.cancelImport}
          </button>
        </span>
      );
    }
    // Failed/cancelled retry is the wizard footer's primary action.
    if (job.status === "ready") {
      // Apply itself lives in the wizard footer; the panel offers the
      // secondary inspection actions.
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

  function renderRunPanel(mode: "discover" | "apply") {
    const job = activeJob;
    if (!job) {
      return (
        <section className={styles.stepCard}>
          <p className={styles.stepHint}>{L.wizard.noJobHint}</p>
        </section>
      );
    }
    const runRecent = activeRecent;
    const startedAt =
      progressStepStartedAt(job, mode === "apply" ? "apply" : "discover") ??
      (typeof job.createdAt === "string" ? job.createdAt : undefined);
    const elapsed = elapsedText(startedAt, runNowMs);
    // Throughput straight off the persisted activity ring — pure derivation,
    // refreshed by the ~1s poll.
    // Speed = overall average throughput (items done ÷ total elapsed), not a
    // recent-window rate. The windowed rate swung wildly (0.6 → 0.3 …) as heavy
    // items passed; the running average is stable and honest.
    const elapsedSecs = startedAt
      ? Math.max(0, ((runNowMs ?? Date.now()) - new Date(startedAt).getTime()) / 1000)
      : 0;
    const lastEntry = runRecent[runRecent.length - 1];
    const doneCount =
      mode === "apply"
        ? typeof lastEntry?.count === "number"
          ? lastEntry.count
          : undefined
        : processedItemCount(job);
    const completionKinds = mode === "apply"
      ? new Set(["create_page", "create_row", "create_database"])
      : new Set(["read_page", "read_data_source"]);
    const completionTimesMs = logEntries
      .filter((entry) => completionKinds.has(entry.kind) && typeof entry.at === "string")
      .map((entry) => new Date(entry.at as string).getTime())
      .filter(Number.isFinite);
    let rateText = "";
    const runMetrics = activeLive
      ? estimateImportRunMetrics({
          doneCount,
          elapsedSeconds: elapsedSecs,
          nowMs: runNowMs,
          completionTimesMs,
        })
      : undefined;
    if (runMetrics) {
      const rate = runMetrics.rate;
      const formattedRate = rate >= 10
        ? String(Math.round(rate))
        : rate >= 0.1
          ? rate.toFixed(1)
          : rate.toFixed(2);
      rateText = L.installer.itemsPerSecond(formattedRate);
    }
    const latest = runRecent[runRecent.length - 1];
    // Live: narrate the newest activity. Settled: show the plain status label.
    const currentLine =
      activeLive && latest
        ? L.installer.activity(latest.kind, latest.title, latest.count, latest.total)
        : activeLive
          ? progressSummaryText(job, L) || L.installer.searching
          : statusLabel(job);
    const discoveredText = [
      activeDiscovered.length ? activeDiscovered.join(" · ") : L.noDiscovered,
      discoveryDetailText(job),
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <section className={styles.stepCard} data-live={activeLive ? "true" : undefined} data-run-panel={mode}>
        <header className={styles.stepHeader}>
          <strong>{mode === "apply" ? L.progressSteps.apply : L.progressSteps.discover}</strong>
          <span className={styles.statusPill} data-status={job.status}>
            {statusLabel(job)}
          </span>
        </header>

        <div className={styles.runCurrent} role="status">
          <strong>{currentLine}</strong>
        </div>

        {activeLive ? (
          <div className={styles.progressTrack} role="progressbar" aria-label={currentLine}>
            <span data-indeterminate="true" />
          </div>
        ) : null}

        {activeLive ? (
          <p className={styles.browserRunnerWarning} role="note" data-browser-runner-warning>
            {L.wizard.browserRunnerWarning}
          </p>
        ) : null}

        <div className={styles.statGrid}>
          <div className={styles.statBlock}>
            <span className={styles.statLabel}>{L.discoveredStat}</span>
            <span className={styles.statValue}>{discoveredText}</span>
          </div>
          {mode === "discover" && processedItemCount(job) !== undefined ? (
            <div className={styles.statBlock}>
              <span className={styles.statLabel}>{L.processedStat}</span>
              <span className={styles.statValue}>{L.processedItems(processedItemCount(job) ?? 0)}</span>
            </div>
          ) : null}
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
          {elapsed ? (
            <div className={styles.statBlock}>
              <span className={styles.statLabel}>{L.installer.elapsed}</span>
              <span className={styles.statValue}>{elapsed}</span>
            </div>
          ) : null}
          {rateText ? (
            <div className={styles.statBlock}>
              <span className={styles.statLabel}>{L.installer.speed}</span>
              <span className={styles.statValue}>{rateText}</span>
            </div>
          ) : null}
        </div>

        <div className={styles.runLog} aria-label={L.installer.activityLog} ref={runLogRef}>
          {logEntries.length ? (
            logEntries.map((entry, index) => (
              <div key={`${entry.at ?? ""}-${index}`} className={styles.runLogLine}>
                <span className={styles.runLogTime}>{activityTimeText(entry.at)}</span>
                <span className={styles.runLogText}>
                  {L.installer.activity(entry.kind, entry.title, entry.count, entry.total)}
                </span>
                {typeof entry.discoveredAt === "number" && entry.discoveredAt > 0 ? (
                  <span className={styles.runLogCount}>{L.installer.foundCount(entry.discoveredAt)}</span>
                ) : null}
              </div>
            ))
          ) : (
            <div className={styles.runLogLine} data-empty="true">
              <span className={styles.runLogText}>
                {activeLive ? L.installer.waitingForProgress : statusLabel(job)}
              </span>
            </div>
          )}
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

        {reportSummaryText(job, L) || writeSummaryText(job, L) ? (
          <div className={styles.reportPanel}>
            {writeSummaryText(job, L) ? (
              <div className={styles.planWrites}>{writeSummaryText(job, L)}</div>
            ) : null}
            {reportMetricEntries(job, L).length ? (
              <div className={styles.reportMetrics}>
                {reportMetricEntries(job, L).map((entry) => (
                  <span key={entry.key}>{L.formatMetric(entry.value, entry.label)}</span>
                ))}
              </div>
            ) : null}
            {reportIssueGroups(job, L).length ? (
              <div className={styles.reportGroups}>
                {reportIssueGroups(job, L).map((group) => (
                  <details key={group.key} className={styles.reportGroup} open>
                    <summary>
                      <span>{group.label}</span>
                      <span>{group.issues.length}</span>
                    </summary>
                    <ul className={styles.reportIssues}>
                      {group.issues.slice(0, 6).map((issue, index) => (
                        <li key={`${issue.code ?? group.key}-${issue.notionId ?? index}`}>
                          {issue.message || issue.code || L.issueFallback}
                        </li>
                      ))}
                      {group.issues.length > 6 ? <li>{group.issues.length - 6} more</li> : null}
                    </ul>
                  </details>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={styles.notionActions}>
          {jobActions(job)}
          {mode === "apply" && job.status === "completed" && importedRootPage?.jobId === job.id ? (
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
    );
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
  const activeSteps = activeJob ? progressStepsOf(activeJob) : [];
  const activeApplied = activeJob ? appliedStats(activeJob) : undefined;
  const activeDiscovered = activeJob ? discoveredEntries(activeJob, L) : [];
  // A settled discovery can become `ready` one render before the client runner
  // releases its busy flag. Trust the durable job state there so the panel does
  // not show a contradictory Ready pill plus a live progress bar. Apply keeps
  // the immediate busy affordance while its first persisted chunk is starting.
  const activeLive = activeJob
    ? isLiveNotionJob(activeJob) || (notionBusy && notionStep === 4 && activeJob.status !== "completed")
    : false;
  const selectedRoots = selectedRootCandidates(notionRootCandidates, selectedNotionRootKeys);
  const rootIdCount = rootIds().length + rootDataSourceIds().length;
  const activeCurrentStep =
    typeof activeJob?.progress?.currentStep === "string" ? activeJob.progress.currentStep : "";
  const applyStarted = Boolean(
    activeJob &&
      (activeCurrentStep === "apply" ||
        activeCurrentStep === "file_copy_retry" ||
        activeJob.status === "completed"),
  );
  const interruptedApply = Boolean(
    activeJob &&
      activeJob.status === "ready" &&
      applyStarted &&
      activeJob.progress?.currentStatus === "running" &&
      !notionBusy,
  );
  const activeRecent = activeJob ? recentActivityOf(activeJob) : [];
  const activeRecentStamp = activeRecent.length
    ? `${activeRecent[activeRecent.length - 1].at ?? ""}:${activeRecent.length}`
    : "";
  const manualResumeRequired = Boolean(
    activeJob && isLiveNotionJob(activeJob) && !activeJob.connectionId && notionStep === 1,
  );

  useEffect(() => {
    if (!onActivityChange) return;
    if (!activeJob || !isLiveNotionJob(activeJob)) {
      onActivityChange(null);
      return;
    }
    const rawPercent = Number(activeJob.progress?.percent);
    const percent = Number.isFinite(rawPercent)
      ? Math.max(0, Math.min(100, rawPercent))
      : 0;
    onActivityChange({
      jobId: activeJob.id,
      mode: applyStarted ? "apply" : "discover",
      percent: Math.round(percent),
    });
  }, [activeJob, applyStarted, onActivityChange]);

  useEffect(() => () => onActivityChange?.(null), [onActivityChange]);

  // Notion discovery/apply is currently driven by bounded requests from this
  // mounted browser controller. Closing only the modal is safe because the
  // controller stays mounted in Sidebar; closing or reloading the tab pauses
  // the runner until Hanji is opened again. Ask the browser to confirm that
  // destructive navigation while the durable job is live, even if the user
  // switches to another import source before dismissing the modal.
  useEffect(() => {
    if (!activeLive) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [activeLive]);

  const wizardStepUnlocked = (step: number) => {
    if (step <= 2) return true;
    if (step === 3) return Boolean(activeJob);
    return applyStarted;
  };

  // Follow job transitions (including dialog reopen onto a live job): jump to
  // the discover step when a job appears, and to apply once applying starts.
  // Keyed so manual back-navigation between transitions is respected. Advance
  // synchronously in the effect (NOT via requestAnimationFrame) — rAF callbacks
  // are frozen while the tab is hidden/backgrounded, so an rAF-gated advance
  // would leave a user who switches away right after "Start discovery" stuck on
  // the scope step until they returned. A direct setState fires regardless.
  useEffect(() => {
    if (source !== "notion" || !activeJob) return;
    const key = `${activeJob.id}:${applyStarted ? "apply" : isLiveNotionJob(activeJob) ? "live" : activeJob.status}`;
    if (notionStepJobKeyRef.current === key) return;
    notionStepJobKeyRef.current = key;
    setNotionStep(applyStarted ? 4 : 3);
  }, [source, activeJob, applyStarted]);

  // A stored connection can resume an interrupted/reloaded discovery without
  // asking for the secret again. A one-time token is deliberately never
  // persisted: after a full reload (where no module-scoped runner survives),
  // return to Connect and ask for the token instead of leaving a stalled job on
  // a progress panel that still looks live. Closing/reopening just the dialog
  // keeps the existing runner and therefore needs no credential prompt.
  useEffect(() => {
    if (
      source !== "notion" ||
      !activeJob ||
      !isLiveNotionJob(activeJob) ||
      notionBusy ||
      autoResumeJobIdRef.current === activeJob.id
    ) {
      return;
    }
    const runnerKey = workspace?.id ? `${workspace.id}:${activeJob.id}` : "";
    if (!activeJob.connectionId) {
      if (
        runnerKey &&
        !notionDiscoveryRunnerCompletions.has(runnerKey) &&
        credentialPromptJobIdRef.current !== activeJob.id
      ) {
        credentialPromptJobIdRef.current = activeJob.id;
        setNotionStep(1);
        if (open) notify(L.resumeNeedsCredential, "default");
      }
      return;
    }
    autoResumeJobIdRef.current = activeJob.id;
    if (applyStarted) {
      void applyNotionImport(activeJob.id);
    } else {
      void resumeNotionDiscovery(activeJob, true);
    }
    // resumeNotionDiscovery intentionally owns the long-running lifecycle;
    // re-running this effect for callback identity changes would duplicate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, activeJob?.id, activeJob?.status, activeJob?.connectionId, applyStarted, notionBusy, open, workspace?.id]);

  // Tick the run panel clock while a job is live so elapsed time counts up
  // between polls.
  useEffect(() => {
    if (source !== "notion" || !activeLive) return;
    const timer = window.setInterval(() => setRunNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [source, activeLive]);

  // Accumulate the server's per-chunk activity ring into a rolling client-side
  // feed: dedupe against what we've shown, stamp each new line with the running
  // discovered total, cap at IMPORT_LOG_MAX_LINES, and reset when the job flips.
  useEffect(() => {
    const job = activeJob;
    if (!job) {
      if (logJobIdRef.current) {
        logJobIdRef.current = "";
        logSeenRef.current = new Set();
        setLogEntries([]);
      }
      return;
    }
    const jobChanged = logJobIdRef.current !== job.id;
    if (jobChanged) {
      logJobIdRef.current = job.id;
      logSeenRef.current = new Set();
    }
    const seen = logSeenRef.current;
    const discoveredTotal = discoveredTotalOf(job);
    const fresh: ImportActivityEntry[] = [];
    for (const entry of activeRecent) {
      const key = activityEntryKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push({ ...entry, discoveredAt: discoveredTotal });
    }
    if (jobChanged) {
      setLogEntries(fresh.slice(-IMPORT_LOG_MAX_LINES));
      return;
    }
    if (fresh.length) {
      setLogEntries((prev) => {
        const next = prev.concat(fresh);
        return next.length > IMPORT_LOG_MAX_LINES ? next.slice(next.length - IMPORT_LOG_MAX_LINES) : next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJob?.id, activeRecentStamp]);

  // Keep the live activity feed pinned to the newest line, installer-style.
  useEffect(() => {
    const el = runLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logEntries.length, notionStep]);

  if (!open) return null;

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

              <div className={styles.wizardSteps} role="tablist" aria-label={L.wizard.stepsAria}>
                {[1, 2, 3, 4].map((step) => (
                  <button
                    key={step}
                    type="button"
                    role="tab"
                    aria-selected={notionStep === step}
                    className={styles.wizardStep}
                    data-active={notionStep === step ? "true" : undefined}
                    data-done={step < notionStep ? "true" : undefined}
                    disabled={!wizardStepUnlocked(step)}
                    onClick={() => setNotionStep(step)}
                  >
                    <span className={styles.wizardStepBadge} aria-hidden="true">
                      {step}
                    </span>
                    <span>{L.wizard.stepLabels[step - 1]}</span>
                  </button>
                ))}
              </div>

              {notionStep === 1 ? (
              <section className={styles.stepCard} data-done={selectedConnection ? "true" : undefined}>
                <header className={styles.stepHeader}>
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
                        <option value="">
                          {notionConnectionStorageAvailable ? L.tokenSummary : L.oneTimeToken}
                        </option>
                        {notionConnections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.name || connection.notionWorkspaceName || L.notionConnectionFallback}
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
                {notionOAuthConfigured ? (
                  <div className={styles.tokenGuide} data-notion-oauth-option="">
                    <div className={styles.tokenGuideCopy}>
                      <strong>{L.connectWithNotion}</strong>
                      <p>{L.oauthConfiguredHint}</p>
                    </div>
                    <div className={styles.tokenGuideActions}>
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => void startNotionOAuthConnection()}
                        disabled={notionBusy || !workspace?.id}
                      >
                        {L.connectWithNotion}
                      </button>
                    </div>
                  </div>
                ) : null}
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
              ) : null}

              {notionStep === 2 ? (
              <section className={styles.stepCard}>
                <header className={styles.stepHeader}>
                  <strong>{L.stepScope}</strong>
                </header>
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
                                  <strong>{candidate.title || generatedLabels.untitled}</strong>
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
                {/* Secondary option below the scope choice so the mobile step
                    keeps the scan controls above the fold. */}
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
              </section>
              ) : null}

              {notionStep === 3 ? renderRunPanel("discover") : null}
              {notionStep === 4 ? renderRunPanel("apply") : null}

              <div className={styles.wizardFooter}>
                {notionStep > 1 ? (
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => setNotionStep(notionStep - 1)}
                  >
                    {L.wizard.back}
                  </button>
                ) : null}
                <span className={styles.wizardHint}>
                  {notionStep === 1
                    ? hasCredential
                      ? ""
                      : L.wizard.needCredentialHint
                    : notionStep === 2
                      ? notionScope === "pages" && rootIdCount === 0
                        ? L.wizard.needRootsHint
                        : `${notionScope === "workspace" ? L.scopeWorkspace : L.scopePages} · ${workspace?.name || ""}`
                      : notionStep === 3
                        ? activeJob?.status === "ready"
                          ? `${L.wizard.readyHint(activeItemCount)} ${L.wizard.applyLocksHint}`
                          : activeJob && activeLive
                            ? L.wizard.runningHint
                            : activeJob
                              ? ""
                              : L.wizard.noJobHint
                        : activeJob && activeLive
                          ? L.wizard.runningHint
                          : ""}
                </span>
                {notionStep === 1 && manualResumeRequired && activeJob ? (
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => void cancelNotionImport(activeJob.id)}
                    disabled={cancellingJobId !== null}
                  >
                    {cancellingJobId === activeJob.id ? L.cancellingImport : L.cancelImport}
                  </button>
                ) : null}
                {notionStep === 1 ? (
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={notionBusy || (manualResumeRequired ? !notionToken.trim() : !hasCredential)}
                    onClick={() => {
                      if (manualResumeRequired && activeJob) {
                        if (applyStarted) {
                          void applyNotionImport(activeJob.id);
                        } else {
                          void resumeNotionDiscovery(activeJob);
                        }
                        return;
                      }
                      void advanceNotionConnectionStep();
                    }}
                  >
                    {notionBusy
                      ? applyStarted
                        ? L.resumingImport
                        : L.discovering
                      : manualResumeRequired
                        ? applyStarted
                          ? L.retry
                          : L.resumeImport
                        : L.wizard.next}
                  </button>
                ) : null}
                {notionStep === 2 ? (
                  <button
                    type="button"
                    className={styles.primary}
                    onClick={() => void startNotionImport()}
                    disabled={
                      notionBusy ||
                      notionRootScanBusy ||
                      !workspace?.id ||
                      !hasCredential ||
                      (notionScope === "pages" && rootIdCount === 0)
                    }
                  >
                    {notionBusy ? L.discovering : L.startDiscovery}
                  </button>
                ) : null}
                {notionStep === 3 ? (
                  activeJob?.status === "ready" ? (
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={notionBusy}
                      onClick={() => {
                        setNotionStep(4);
                        void applyNotionImport(activeJob.id);
                      }}
                    >
                      {L.wizard.applyNow}
                    </button>
                  ) : activeJob && (activeJob.status === "failed" || activeJob.status === "cancelled") ? (
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={notionBusy}
                      onClick={() => void startNotionImport(activeJob.id)}
                    >
                      {L.retry}
                    </button>
                  ) : (
                    <button type="button" className={styles.primary} disabled>
                      {activeJob && activeLive ? L.discovering : L.wizard.applyNow}
                    </button>
                  )
                ) : null}
                {notionStep === 4 ? (
                  activeJob && (activeJob.status === "failed" || activeJob.status === "cancelled") ? (
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={notionBusy}
                      onClick={() => void startNotionImport(activeJob.id)}
                    >
                      {L.retry}
                    </button>
                  ) : activeJob && interruptedApply ? (
                    <button
                      type="button"
                      className={styles.primary}
                      onClick={() => void applyNotionImport(activeJob.id)}
                    >
                      {L.retry}
                    </button>
                  ) : activeJob?.status === "completed" && importedRootPage?.jobId === activeJob.id ? (
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
                  ) : activeJob?.status === "completed" ? (
                    <button type="button" className={styles.primary} onClick={() => close()}>
                      {L.wizard.done}
                    </button>
                  ) : (
                    <button type="button" className={styles.primary} disabled>
                      {activeJob && activeLive ? L.wizard.applying : L.wizard.applyNow}
                    </button>
                  )
                ) : null}
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
