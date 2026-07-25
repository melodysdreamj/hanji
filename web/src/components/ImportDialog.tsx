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
  advanceNotionApplyStallState,
  advanceNotionDiscoveryStallState,
  isNotionDiscoveryConflict,
  NOTION_APPLY_STALL_LIMIT,
  NOTION_DISCOVERY_STALL_LIMIT,
  notionApplyFileRecoveryRetryLimitReached,
  notionApplyRequestBudget,
  notionImportOperationIsActive,
  notionDiscoveryShouldContinue,
  waitForNotionApplyRetryAfter,
} from "@/lib/notionImportResume";
import { estimateImportRunMetrics } from "@/lib/importRunMetrics";
import {
  isNotionImportLive,
  isNotionImportProblemTerminal,
  isNotionImportTerminal,
  reconcileNotionImportJob,
  selectNotionImportJobForRemount,
} from "@/lib/notionImportReconciliation";
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
import type { ParsedNativeArchive } from "@/lib/nativeArchive";
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
const NOTION_DISCOVERY_CONFLICT_POLL_INTERVAL_MS = 1_000;
const NOTION_DISCOVERY_CONFLICT_POLL_DEADLINE_MS = 10 * 60 * 1_000;
// Apply is also a persisted, resumable operation. Keep each product-write
// request small enough for the DO and loop the server's `partial` responses
// until it reports the job completed.
const NOTION_APPLY_MAX_RETRIES = 5;
const NOTION_APPLY_DATA_SOURCE_BATCH_SIZE = 5;
const NOTION_APPLY_DATABASE_BATCH_SIZE = 25;
const NOTION_APPLY_FILE_BATCH_SIZE = 10;
const NOTION_APPLY_PAGE_BATCH_SIZE = 20;
const NOTION_APPLY_REMAP_BATCH_SIZE = 20;
const NOTION_STATUS_POLL_INTERVAL_MS = 3_000;
// Discovery deliberately survives dialog unmounts. Keep one runner per job at
// module scope so reopening the dialog joins the in-flight runner instead of
// starting a second cursor/progress writer for the same durable job.
type NotionDiscoveryRunner = {
  completion: Promise<void>;
  controller: AbortController;
  generation: number;
};

const notionDiscoveryRunners = new Map<string, NotionDiscoveryRunner>();
let notionDiscoveryRunnerGeneration = 0;

function notionRunnerAbortError() {
  return new DOMException("Notion import runner aborted.", "AbortError");
}

function checkNotionRunnerAborted(signal: AbortSignal) {
  if (signal.aborted) throw notionRunnerAbortError();
}

function isNotionRunnerAbort(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function waitForNotionRunnerDelay(ms: number, signal: AbortSignal) {
  checkNotionRunnerAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(notionRunnerAbortError());
    const timer = window.setTimeout(() => finish(), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type NotionImportActivitySummary = {
  jobId: string;
  mode: "discover" | "apply";
  percent?: number;
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
    terminal: {
      failed: t("importDialog:terminal.failed"),
      cancelled: t("importDialog:terminal.cancelled"),
    },
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
      serverRunningHint: t("importDialog:wizard.serverRunningHint"),
      serverRunnerStatus: t("importDialog:wizard.serverRunnerStatus"),
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
      filesIncluded: t("importDialog:hanji.filesIncluded"),
      filesExcluded: t("importDialog:hanji.filesExcluded"),
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
  return isNotionImportLive(job);
}

function isServerOwnedNotionJob(job: NotionImportJob) {
  return job.options?.runnerMode === "server";
}

function isMonitorableNotionJob(job: NotionImportJob) {
  return isLiveNotionJob(job) || (isServerOwnedNotionJob(job) && !isNotionImportTerminal(job));
}

function newServerRunRequestId() {
  return crypto.randomUUID().replace(/-/g, "_");
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
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const oauthCallbackHandledRef = useRef(false);
  const rootScanRunRef = useRef(0);
  const rootScanCredentialKeyRef = useRef("");
  const notify = useStore((s) => s.notify);
  const userId = useStore((s) => s.userId);
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
  const [notionImportPagesFullWidth, setNotionImportPagesFullWidth] = useState(true);
  const [notionRootIds, setNotionRootIds] = useState("");
  const [notionRootCandidates, setNotionRootCandidates] = useState<NotionImportRootCandidate[]>([]);
  const [selectedNotionRootKeys, setSelectedNotionRootKeys] = useState<string[]>([]);
  const [notionRootScanBusy, setNotionRootScanBusy] = useState(false);
  const [notionRootScanError, setNotionRootScanError] = useState("");
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
  const notionResultRef = useRef<{
    job: NotionImportJob;
    itemCount: number;
  } | null>(null);
  const notionObservedJobsRef = useRef<Map<string, NotionImportJob>>(new Map());
  const notionBusyGenerationRef = useRef(0);
  const [importedRootPage, setImportedRootPage] = useState<{ jobId: string; pageId: string } | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  // Wizard position for the Notion tab: 1 connect, 2 scope, 3 discover,
  // 4 apply/result. Auto-advances on job transitions; manual back is allowed.
  const [notionStep, setNotionStep] = useState(1);
  const notionStepJobKeyRef = useRef("");
  const autoResumeJobIdRef = useRef("");
  const autoApplyJobIdRef = useRef("");
  const credentialPromptJobIdRef = useRef("");
  // Retain the same opaque id after an ambiguous create response. Replaying
  // it returns the already-committed server job instead of starting a second
  // import; clear it only after the server response is observed.
  const notionServerRunRequestIdRef = useRef("");
  const notionApplyRunRef = useRef<{
    jobId: string;
    workspaceId?: string;
    controller: AbortController;
  } | null>(null);
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

  // ─── Native Hanji import (.hanji.json or .hanji.zip) ───
  const hanjiInputRef = useRef<HTMLInputElement>(null);
  const [hanjiMode, setHanjiMode] = useState<"file" | "live">("file");
  const [hanjiSelection, setHanjiSelection] = useState<(
    | { kind: "json"; document: HanjiExportDocument }
    | { kind: "archive"; archive: ParsedNativeArchive; batchId: string }
  ) & {
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

  const beginNotionBusy = useCallback(() => {
    const generation = notionBusyGenerationRef.current + 1;
    notionBusyGenerationRef.current = generation;
    setNotionBusy(true);
    return generation;
  }, []);

  const finishNotionBusy = useCallback((generation: number) => {
    if (notionBusyGenerationRef.current === generation) setNotionBusy(false);
  }, []);

  const invalidateNotionBusy = useCallback(() => {
    notionBusyGenerationRef.current += 1;
    setNotionBusy(false);
  }, []);

  const abortNotionWorkForTerminalJob = useCallback((job: NotionImportJob) => {
    if (!isNotionImportTerminal(job)) return;
    const ownsCurrentWork = notionResultRef.current?.job.id === job.id;
    const workspaceId = job.workspaceId || notionTargetWorkspaceRef.current;
    const runnerKey = workspaceId ? `${workspaceId}:${job.id}` : "";
    const runner = runnerKey ? notionDiscoveryRunners.get(runnerKey) : undefined;
    if (runner) {
      runner.controller.abort();
    }
    if (notionApplyRunRef.current?.jobId === job.id) {
      notionApplyRunRef.current.controller.abort();
    }
    if (ownsCurrentWork) invalidateNotionBusy();
  }, [invalidateNotionBusy]);

  const reconcileNotionJobForPublication = useCallback((
    incoming: NotionImportJob,
    currentResult: { job: NotionImportJob; itemCount: number } | null,
  ) => {
    const known = reconcileNotionImportJob(
      notionObservedJobsRef.current.get(incoming.id),
      incoming,
    );
    const job = currentResult?.job.id === incoming.id
      ? reconcileNotionImportJob(currentResult.job, known)
      : known;
    if (
      isServerOwnedNotionJob(job)
      && job.options?.serverRunRequestId === notionServerRunRequestIdRef.current
    ) {
      notionServerRunRequestIdRef.current = "";
    }
    notionObservedJobsRef.current.set(job.id, job);
    return job;
  }, []);

  const commitNotionResult = useCallback((job: NotionImportJob, itemCount: number) => {
    const nextResult = { job, itemCount };
    notionResultRef.current = nextResult;
    setNotionResult(nextResult);
  }, []);

  const clearTerminalNotionResult = useCallback(() => {
    const current = notionResultRef.current?.job;
    if (current && !isNotionImportTerminal(current)) return;
    rootScanRunRef.current += 1;
    rootScanCredentialKeyRef.current = "";
    notionResultRef.current = null;
    setNotionResult(null);
    setImportedRootPage(null);
    setSelectedConnectionId("");
    notionStepJobKeyRef.current = "";
    setNotionStep(1);
  }, []);

  const abortNotionWorkForTerminalJobs = useCallback((jobs: NotionImportJob[]) => {
    for (const job of jobs) abortNotionWorkForTerminalJob(job);
  }, [abortNotionWorkForTerminalJob]);

  const publishNotionJob = useCallback((
    incoming: NotionImportJob,
    options: { itemCount?: number; surface?: boolean } = {},
  ) => {
    const currentResult = notionResultRef.current;
    const job = reconcileNotionJobForPublication(incoming, currentResult);

    setNotionJobs((current) => {
      const index = current.findIndex((entry) => entry.id === job.id);
      if (index < 0) return [job, ...current].slice(0, 5);
      return current.map((entry) => entry.id === job.id
        ? reconcileNotionImportJob(entry, job)
        : entry);
    });

    if (options.surface || currentResult?.job.id === job.id) {
      const retainedCurrent = currentResult?.job.id === job.id && job === currentResult.job;
      const itemCount = retainedCurrent
        ? currentResult.itemCount
        : options.itemCount ?? itemCountFromJob(job, currentResult?.itemCount ?? 0);
      commitNotionResult(job, itemCount);
    }
    abortNotionWorkForTerminalJobs([job]);
    return job;
  }, [abortNotionWorkForTerminalJobs, commitNotionResult, reconcileNotionJobForPublication]);

  const publishNotionJobList = useCallback((incomingJobs: NotionImportJob[]) => {
    const currentResult = notionResultRef.current;
    const jobs = incomingJobs.map((incoming) =>
      reconcileNotionJobForPublication(incoming, currentResult)
    );
    setNotionJobs(jobs);

    const refreshedCurrent = currentResult
      ? jobs.find((job) => job.id === currentResult.job.id)
      : undefined;
    const selected = refreshedCurrent ?? (!currentResult
      ? selectNotionImportJobForRemount(jobs)
      : null);
    if (selected) {
      commitNotionResult(
        selected,
        itemCountFromJob(
          selected,
          currentResult?.job.id === selected.id ? currentResult.itemCount : 0,
        ),
      );
    }
    abortNotionWorkForTerminalJobs(jobs);
    return jobs;
  }, [abortNotionWorkForTerminalJobs, commitNotionResult, reconcileNotionJobForPublication]);

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
      publishNotionJobList(jobs);
      setNotionConnections(connections);
      setNotionConnectionStorageAvailable(connectionsResult.connectionStorageAvailable !== false);
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
  }, [publishNotionJobList, workspace?.id]);

  const refreshNotionImportStateFresh = useCallback(async () => {
    // A mutation may finish while a poll that started before it is still in
    // flight. Let that single flight settle, then issue one guaranteed
    // post-mutation read so the older response cannot overwrite the result.
    const inFlight = notionRefreshInFlightRef.current;
    if (inFlight) await inFlight.promise.catch(() => {});
    await refreshNotionImportState();
  }, [refreshNotionImportState]);

  const notionPollingJobId =
    (notionResult && isMonitorableNotionJob(notionResult.job) ? notionResult.job.id : undefined) ??
    notionJobs.find(isMonitorableNotionJob)?.id;

  const close = useCallback((restoreFocus = true) => {
    closedRef.current = true;
    rootScanRunRef.current += 1;
    rootScanCredentialKeyRef.current = "";
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
      notionApplyRunRef.current?.controller.abort();
    },
    []
  );

  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  useEffect(() => {
    if (!open || !initialTab || initialTab === sourceRef.current) return;
    sourceRef.current = initialTab;
    notionRefreshRunRef.current += 1;
    hanjiReadRunRef.current += 1;
    remoteExportRunRef.current += 1;
    remoteExportAbortRef.current?.abort();
    remoteExportAbortRef.current = null;
    setRemoteBusy(false);
    setHanjiSelection(null);
    setSource(initialTab);
  }, [initialTab, open]);

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
    notionApplyRunRef.current?.controller.abort();
    invalidateNotionBusy();
    notionTargetWorkspaceRef.current = workspace?.id;
    notionRefreshRunRef.current += 1;
    notionRefreshInFlightRef.current = null;
    notionObservedJobsRef.current.clear();
    notionResultRef.current = null;
    setNotionJobs([]);
    setNotionResult(null);
    setImportedRootPage(null);
    setSelectedConnectionId("");
  }, [invalidateNotionBusy, workspace?.id]);

  useEffect(() => {
    // The sidebar keeps this controller mounted with `onActivityChange` even
    // while the modal is closed. That controller must read a durable live job
    // after a fresh browser load so it can restore the sidebar progress action
    // (and resume stored-connection work). Keep that cold check jobs-only and
    // wait for authenticated store state; connection metadata and repair work
    // remain tied to an explicitly opened Notion dialog.
    const workspaceId = workspace?.id;
    if (source !== "notion" || !workspaceId) return;
    let mounted = true;
    if (!open) {
      if (!onActivityChange || !userId) return;
      void listNotionImportJobsRemote({ workspaceId, limit: 5 })
        .then((jobsResult) => {
          if (
            !mounted ||
            sourceRef.current !== "notion" ||
            useStore.getState().workspace?.id !== workspaceId
          ) {
            return;
          }
          const jobs = jobsResult.jobs ?? [];
          publishNotionJobList(jobs);
        })
        .catch(() => {
          // A cold/offline shell may not be able to read protected state yet.
          // Opening the dialog performs the full authenticated refresh.
        });
      return () => {
        mounted = false;
      };
    }
    refreshNotionImportState()
      .catch(() => {
        if (!mounted) return;
        setNotionJobs([]);
        setNotionConnections([]);
      });
    return () => {
      mounted = false;
    };
  }, [onActivityChange, open, publishNotionJobList, source, userId, workspace?.id, refreshNotionImportState]);

  // One-shot self-heal for legacy/interrupted imports: rebuild page routing,
  // unwrap completed staging roots, and hide failed partial output.
  const repairedWorkspacesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const workspaceId = workspace?.id;
    if (!open || source !== "notion" || !workspaceId) return;
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
  }, [open, refreshWorkspacePages, source, workspace?.id]);

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
        const snapshot = await getNotionImportJobRemote(jobId, workspaceId, { compact: true });
        if (
          cancelled ||
          sourceRef.current !== "notion" ||
          useStore.getState().workspace?.id !== workspaceId
        ) {
          return;
        }
        publishNotionJob(snapshot.job);
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
  }, [publishNotionJob, source, workspace?.id, notionPollingJobId]);

  useEffect(() => {
    rootScanRunRef.current += 1;
    rootScanCredentialKeyRef.current = "";
    setNotionRootCandidates([]);
    setSelectedNotionRootKeys([]);
    setNotionRootScanSummary(null);
    setNotionRootScanWorkspace(null);
    setNotionRootScanError("");
    // Keep an older request marked busy until it settles. The latest
    // credential is queued by the auto-scan effect below, so credential edits
    // can never create overlapping Notion search reads.
  }, [notionToken, selectedConnectionId, workspace?.id]);

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
    const busyGeneration = beginNotionBusy();
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
        finishNotionBusy(busyGeneration);
      });
  }, [
    beginNotionBusy,
    finishNotionBusy,
    workspace?.id,
    notify,
    notionConnectionName,
    refreshNotionImportStateFresh,
  ]);

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
      const {
        createNativeArchiveBatchId,
        hanjiFileSourceFingerprint,
        readHanjiImportFile,
        summarizeDocument,
      } = await import("./nativeExport");
      const fingerprint = hanjiFileSourceFingerprint(file);
      const selected = await readHanjiImportFile(file);
      if (closedRef.current || hanjiReadRunRef.current !== runId) return;
      const common = {
        fingerprint,
        label: L.hanji.selected(file.name),
        summary: summarizeDocument(
          selected.kind === "archive" ? selected.archive.document : selected.document
        ),
      };
      setHanjiSelection(selected.kind === "archive"
        ? { ...common, kind: "archive", archive: selected.archive, batchId: createNativeArchiveBatchId() }
        : { ...common, kind: "json", document: selected.document });
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
        kind: "json",
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
      const result = hanjiSelection.kind === "archive"
        ? await (async () => {
            const { importParsedNativeArchive } = await import("./nativeExport");
            return importParsedNativeArchive({
              workspaceId: workspace.id,
              batchId: hanjiSelection.batchId,
              archive: hanjiSelection.archive,
            });
          })()
        : await importNativeRemote({
            workspaceId: workspace.id,
            document: hanjiSelection.document,
          });
      await refreshWorkspacePages();
      const imported = result.counts.pages ?? 0;
      const hasPlaceholders = (result.warnings ?? []).some(
        (warning: NativeExportWarning) => warning.code === "stripped_file"
      );
      notify(
        `${L.hanji.importedItems(imported)}${
          hanjiSelection.kind === "archive"
            ? ` ${L.hanji.filesIncluded}`
            : hasPlaceholders ? ` ${L.hanji.placeholderNote}` : ""
        }`,
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
    return uniqueRootIds([
      ...selectedRootCandidates(notionRootCandidates, selectedNotionRootKeys)
        .filter((candidate) => candidate.notionObject === "page")
        .map((candidate) => candidate.id),
      ...parseNotionRootInput(notionRootIds),
    ]);
  }

  function rootDataSourceIds() {
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
    if (!retryJobId && pageRootIds.length === 0 && dataSourceRootIds.length === 0) {
      notify(L.rootPagesRequired, "error");
      return;
    }
    const busyGeneration = beginNotionBusy();
    let attemptedServerOwned = false;
    try {
      const credential = await resolveNotionCredential(enteredToken, selectedConnectionId);
      const { token, connectionId } = credential;
      const serverOwned = Boolean(connectionId);
      attemptedServerOwned = serverOwned;
      // No-secret local mode deliberately keeps the token request-only, so it
      // retains the bounded browser runner. A saved encrypted connection uses
      // only create/monitor/cancel/retry from this point; discovery, planning,
      // and apply are owned by the durable server queue.
      if (!retryJobId && !serverOwned) {
        await runStreamingNotionDiscovery({
          workspaceId: workspace.id,
          connectionKind: "manual_token",
          token,
          rootNotionPageIds: pageRootIds,
          rootNotionDataSourceIds: dataSourceRootIds,
        });
        return;
      }
      const serverRunRequestId = serverOwned
        ? notionServerRunRequestIdRef.current || newServerRunRequestId()
        : undefined;
      if (serverRunRequestId) notionServerRunRequestIdRef.current = serverRunRequestId;
      const result = retryJobId
        ? await retryNotionImportJobRemote({
            workspaceId: workspace.id,
            jobId: retryJobId,
            notionToken: token || undefined,
            connectionId,
            importPagesFullWidth: notionImportPagesFullWidth,
            deferDiscovery: !serverOwned,
            serverOwned,
            serverRunRequestId,
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
            serverOwned,
            serverRunRequestId,
          });
      const itemCount = result.items?.length ?? itemCountFromJob(result.job);
      if (!serverOwned && retryJobId && result.job.status === "queued") {
        await runStreamingNotionDiscovery({
          workspaceId: workspace.id,
          connectionKind: result.job.connectionKind,
          connectionId,
          token,
          resumeJob: result.job,
        });
        return;
      }
      const publishedJob = publishNotionJob(result.job, { itemCount, surface: true });
      if (serverOwned) notionServerRunRequestIdRef.current = "";
      await refreshNotionImportStateFresh().catch(() => {});
      notify(
        publishedJob.status === "ready" ? L.foundItems(itemCount) : L.jobCreated,
        publishedJob.status === "ready" ? "success" : "default"
      );
      if (connectionId) setNotionToken("");
    } catch (error) {
      if (attemptedServerOwned) {
        const ambiguousRequestId = notionServerRunRequestIdRef.current;
        await refreshNotionImportStateFresh().catch(() => {});
        if (ambiguousRequestId && notionServerRunRequestIdRef.current !== ambiguousRequestId) {
          notify(L.jobCreated, "default");
          return;
        }
      }
      notify(error instanceof Error ? error.message : L.cantStartImport, "error");
    } finally {
      finishNotionBusy(busyGeneration);
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
    // Every inbound snapshot takes the same reconciliation path. If a poll has
    // already observed this job terminal, a stale resume snapshot cannot revive
    // it or start another discovery mutation.
    let job = publishNotionJob(created.job, { itemCount: 0, surface: true });
    if (isNotionImportTerminal(job)) return;

    const runnerKey = `${args.workspaceId}:${jobId}`;
    const existingRunner = notionDiscoveryRunners.get(runnerKey);
    if (existingRunner) {
      await existingRunner.completion;
      const snapshot = await getNotionImportJobRemote(jobId, args.workspaceId, { compact: true }).catch(() => null);
      if (snapshot?.job) publishNotionJob(snapshot.job, { surface: true });
      await refreshNotionImportStateFresh().catch(() => {});
      return;
    }

    let finishRunner!: () => void;
    const controller = new AbortController();
    const runner: NotionDiscoveryRunner = {
      completion: new Promise<void>((resolve) => {
        finishRunner = resolve;
      }),
      controller,
      generation: ++notionDiscoveryRunnerGeneration,
    };
    notionDiscoveryRunners.set(runnerKey, runner);
    const { signal } = controller;
    try {
      // Incremental discovery: each discover() call does a bounded amount of
      // work. The controller also owns retry/conflict waits so terminal polling
      // can stop the loop before one more mutation is issued.
      let discoveryStallState = advanceNotionDiscoveryStallState(undefined, job);
      let continueFromCursor = args.resumeJob
        ? notionDiscoveryShouldContinue(args.resumeJob)
        : false;
      let consecutiveErrors = 0;
      let conflictPollDeadlineAt = 0;
      for (let chunk = 0; chunk < NOTION_MAX_DISCOVER_CHUNKS; chunk += 1) {
        checkNotionRunnerAborted(signal);
        let res: Awaited<ReturnType<typeof discoverNotionImportJobRemote>>;
        try {
          res = await discoverNotionImportJobRemote({
            jobId,
            workspaceId: args.workspaceId,
            notionToken: args.token || undefined,
            connectionId: args.connectionId,
            continueFromCursor,
            incremental: true,
            compact: true,
          });
          checkNotionRunnerAborted(signal);
          consecutiveErrors = 0;
          conflictPollDeadlineAt = 0;
        } catch (chunkError) {
          checkNotionRunnerAborted(signal);
          if (isNotionDiscoveryConflict(chunkError)) {
            conflictPollDeadlineAt ||= Date.now() + NOTION_DISCOVERY_CONFLICT_POLL_DEADLINE_MS;
            let snapshot: Awaited<ReturnType<typeof getNotionImportJobRemote>> | null = null;
            while (Date.now() < conflictPollDeadlineAt) {
              await waitForNotionRunnerDelay(
                Math.min(
                  NOTION_DISCOVERY_CONFLICT_POLL_INTERVAL_MS,
                  Math.max(1, conflictPollDeadlineAt - Date.now()),
                ),
                signal,
              );
              snapshot = await withTimeout(
                getNotionImportJobRemote(jobId, args.workspaceId, { compact: true }),
                Math.max(1, conflictPollDeadlineAt - Date.now()),
                () => new Error("Notion discovery conflict status polling timed out."),
              );
              checkNotionRunnerAborted(signal);
              job = publishNotionJob(snapshot.job, { surface: true });
              if (isNotionImportTerminal(job) || !notionImportOperationIsActive(snapshot)) break;
            }
            checkNotionRunnerAborted(signal);
            if (!snapshot || notionImportOperationIsActive(snapshot)) {
              throw new Error("Notion discovery conflict did not settle before the bounded polling deadline.");
            }
            if (job.status === "ready" || isNotionImportTerminal(job)) break;
            continueFromCursor = notionDiscoveryShouldContinue(job);
            consecutiveErrors = 0;
            continue;
          }
          consecutiveErrors += 1;
          if (consecutiveErrors >= NOTION_DISCOVER_MAX_RETRIES) throw chunkError;
          await waitForNotionRunnerDelay(
            Math.min(8_000, 1_000 * consecutiveErrors),
            signal,
          );
          continue;
        }
        continueFromCursor = true;
        job = publishNotionJob(res.job, {
          itemCount: itemCountFromJob(res.job),
          surface: true,
        });
        if (isNotionImportTerminal(job)) break;
        checkNotionRunnerAborted(signal);
        discoveryStallState = advanceNotionDiscoveryStallState(discoveryStallState, job);
        if (
          job.progress?.hasMore === true &&
          discoveryStallState.unchangedChunks >= NOTION_DISCOVERY_STALL_LIMIT
        ) break;
        if (job.status === "ready" || job.progress?.hasMore !== true) break;
      }
      checkNotionRunnerAborted(signal);
      const final = await getNotionImportJobRemote(
        jobId,
        args.workspaceId,
        { compact: true },
      ).catch(() => null);
      checkNotionRunnerAborted(signal);
      if (final?.job) {
        job = publishNotionJob(final.job, { surface: true });
        checkNotionRunnerAborted(signal);
      }
      if (job.status === "ready") {
        notify(L.foundItems(itemCountFromJob(job)), "success");
      } else if (!isNotionImportTerminal(job)) {
        notify(L.discoveryPaused, "default");
      }
      await refreshNotionImportStateFresh().catch(() => {});
      checkNotionRunnerAborted(signal);
    } catch (error) {
      if (isNotionRunnerAbort(error, signal)) return;
      notify(error instanceof Error ? error.message : L.cantStartImport, "error");
      await refreshNotionImportStateFresh().catch(() => {});
    } finally {
      finishRunner();
      if (notionDiscoveryRunners.get(runnerKey)?.generation === runner.generation) {
        notionDiscoveryRunners.delete(runnerKey);
      }
    }
  }

  async function resumeNotionDiscovery(job: NotionImportJob, automatic = false) {
    if (!workspace?.id || notionBusy) return;
    if (isServerOwnedNotionJob(job)) return;
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
    const busyGeneration = beginNotionBusy();
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
    } finally {
      finishNotionBusy(busyGeneration);
    }
  }

  async function startNotionOAuthConnection() {
    if (!workspace?.id || notionBusy || !notionOAuthConfigured) return;
    const busyGeneration = beginNotionBusy();
    try {
      const result = await beginNotionOAuthConnectionRemote({
        workspaceId: workspace.id,
        name: notionConnectionName.trim() || undefined,
        redirectUri: notionOAuthRedirectUri(),
      });
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantStartOAuth, "error");
      finishNotionBusy(busyGeneration);
    }
  }

  async function scanNotionRootCandidates() {
    if (closedRef.current || !workspace?.id || notionRootScanBusy) return;
    const token = notionToken.trim();
    if (!validateEnteredNotionToken(token)) return;
    const connectionId = token ? undefined : selectedConnectionId || undefined;
    if (!token && !connectionId) {
      notify(L.rootScanNeedsCredential, "error");
      return;
    }

    rootScanCredentialKeyRef.current = token
      ? `${workspace.id}:token:${token}`
      : `${workspace.id}:connection:${connectionId}`;
    const runId = rootScanRunRef.current + 1;
    rootScanRunRef.current = runId;
    setNotionRootScanBusy(true);
    setNotionRootScanError("");
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
      const message = error instanceof Error ? error.message : L.cantScanRoots;
      setNotionRootScanSummary((prev) => (prev ? { ...prev, running: false } : prev));
      setNotionRootScanError(message);
      notify(message, "error");
    } finally {
      // Only one root scan can enter this function while busy. Even if its
      // credential became stale, settling it releases the queued latest
      // credential through the effect below; no overlap is possible.
      setNotionRootScanBusy(false);
    }
  }

  useEffect(() => {
    const workspaceId = workspace?.id;
    const token = notionToken.trim();
    const connectionId = token ? "" : selectedConnectionId;
    const credentialReady = token
      ? isAllowedNotionToken(token) && token.length >= 8
      : Boolean(connectionId);
    const hasActiveJob = Boolean(
      notionResult?.job || notionJobs.some((job) => isMonitorableNotionJob(job)),
    );
    if (
      !open ||
      closedRef.current ||
      source !== "notion" ||
      !workspaceId ||
      !credentialReady ||
      hasActiveJob ||
      notionRootScanBusy
    ) {
      return;
    }
    const credentialKey = token
      ? `${workspaceId}:token:${token}`
      : `${workspaceId}:connection:${connectionId}`;
    if (rootScanCredentialKeyRef.current === credentialKey) return;

    // Token typing gets a short debounce. Stored-connection selection can
    // begin immediately; both paths still enter the same serialized scanner.
    const timer = window.setTimeout(
      () => void scanNotionRootCandidates(),
      token ? 350 : 0,
    );
    return () => window.clearTimeout(timer);
    // scanNotionRootCandidates intentionally reads the render snapshot named
    // by credentialKey; adding its changing function identity would rearm the
    // debounce on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    source,
    workspace?.id,
    notionToken,
    selectedConnectionId,
    notionRootScanBusy,
    notionResult?.job,
    notionJobs,
  ]);

  async function revokeNotionConnection(connectionId: string) {
    if (!connectionId || notionBusy) return;
    const busyGeneration = beginNotionBusy();
    try {
      await revokeNotionImportConnectionRemote(connectionId, workspace?.id);
      if (selectedConnectionId === connectionId) setSelectedConnectionId("");
      await refreshNotionImportStateFresh();
      notify(L.connectionRemoved, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantRemoveConnection, "error");
    } finally {
      finishNotionBusy(busyGeneration);
    }
  }

  async function reviewNotionImport(jobId: string) {
    if (notionBusy) return;
    const busyGeneration = beginNotionBusy();
    try {
      const result = await planNotionImportJobRemote(jobId, workspace?.id);
      await refreshNotionImportStateFresh();
      const estimated = result.plan?.estimatedWrites ?? {};
      const itemCount =
        safeCount(estimated.pages) +
        safeCount(estimated.databases) +
        safeCount(estimated.rows);
      publishNotionJob(result.job, { itemCount, surface: true });
      notify(L.reviewReady, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantReview, "error");
    } finally {
      finishNotionBusy(busyGeneration);
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
    const busyGeneration = beginNotionBusy();
    try {
      const credential = await resolveNotionCredential(enteredToken, fallbackConnectionId);
      if (!workspace?.id) throw new Error(L.cantExpand);
      await runStreamingNotionDiscovery({
        workspaceId: workspace.id,
        connectionKind: credential.connectionId
          ? credential.connectionKind ?? "internal_integration"
          : "manual_token",
        connectionId: credential.connectionId,
        token: credential.token,
        resumeJob: job,
      });
      if (credential.connectionId) setNotionToken("");
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantExpand, "error");
    } finally {
      finishNotionBusy(busyGeneration);
    }
  }

  async function applyNotionImport(jobId: string) {
    if (notionBusy || notionApplyRunRef.current) return;
    const enteredToken = notionToken.trim();
    if (!validateEnteredNotionToken(enteredToken)) return;
    // The just-finished runner response is newer than the periodically
    // refreshed list. A manual Retry must read that durable cursor (especially
    // retryAfterAt) rather than racing from the older list snapshot.
    const job = notionResultRef.current?.job.id === jobId
      ? notionResultRef.current.job
      : notionJobs.find((item) => item.id === jobId);
    if (job && isServerOwnedNotionJob(job)) return;
    const fallbackConnectionId = job?.connectionId || selectedConnectionId || undefined;
    const applyRun = {
      jobId,
      workspaceId: workspace?.id,
      controller: new AbortController(),
    };
    notionApplyRunRef.current = applyRun;
    setNotionStep(4);
    const busyGeneration = beginNotionBusy();
    try {
      const credential = await resolveNotionCredential(enteredToken, fallbackConnectionId);
      checkNotionRunnerAborted(applyRun.controller.signal);
      // Re-entering a cursor that already hit the automatic recovery ceiling
      // is the user's one explicit retry allowance. Honor the checkpoint's
      // existing deadline before that first request; a ceiling reached by a
      // response later in this same run still returns immediately below.
      if (job) {
        const mayStart = await waitForNotionApplyRetryAfter(
          job,
          applyRun.controller.signal,
        );
        checkNotionRunnerAborted(applyRun.controller.signal);
        if (!mayStart) return;
      }
      let result: Awaited<ReturnType<typeof applyNotionImportJobRemote>> | null = null;
      let consecutiveErrors = 0;
      let applyChunkBudget = notionApplyRequestBudget(job);
      let applyStallState: ReturnType<typeof advanceNotionApplyStallState> | undefined;
      for (let chunk = 0; chunk < applyChunkBudget; chunk += 1) {
        checkNotionRunnerAborted(applyRun.controller.signal);
        let chunkResult: Awaited<ReturnType<typeof applyNotionImportJobRemote>>;
        try {
          chunkResult = await applyNotionImportJobRemote({
            workspaceId: workspace?.id,
            jobId,
            notionToken: credential.token || undefined,
            connectionId: credential.connectionId,
            importPagesFullWidth: notionImportPagesFullWidth,
            compact: true,
            applyDataSourceBatchSize: NOTION_APPLY_DATA_SOURCE_BATCH_SIZE,
            applyDatabaseBatchSize: NOTION_APPLY_DATABASE_BATCH_SIZE,
            applyFileBatchSize: NOTION_APPLY_FILE_BATCH_SIZE,
            applyPageBatchSize: NOTION_APPLY_PAGE_BATCH_SIZE,
            applyRemapBatchSize: NOTION_APPLY_REMAP_BATCH_SIZE,
          });
          checkNotionRunnerAborted(applyRun.controller.signal);
          consecutiveErrors = 0;
        } catch (chunkError) {
          checkNotionRunnerAborted(applyRun.controller.signal);
          const record = chunkError && typeof chunkError === "object"
            ? chunkError as { code?: unknown; status?: unknown }
            : null;
          const status = Number(record?.status ?? record?.code);
          const retryable = status === 429 || status === 502 || status === 503 || status === 504;
          consecutiveErrors += 1;
          if (!retryable || consecutiveErrors >= NOTION_APPLY_MAX_RETRIES) throw chunkError;
          await waitForNotionRunnerDelay(
            Math.min(8_000, 1_000 * consecutiveErrors),
            applyRun.controller.signal,
          );
          chunk -= 1;
          continue;
        }
        result = chunkResult;
        const publishedJob = publishNotionJob(chunkResult.job, {
          itemCount: itemCountFromJob(chunkResult.job),
          surface: true,
        });
        if (
          isNotionImportTerminal(publishedJob) &&
          (publishedJob !== chunkResult.job || publishedJob.status !== "completed")
        ) return;
        if (chunkResult.partial !== true || chunkResult.job.status === "completed") break;
        applyChunkBudget = Math.max(
          applyChunkBudget,
          notionApplyRequestBudget(chunkResult.job, chunk + 1),
        );
        applyStallState = advanceNotionApplyStallState(applyStallState, chunkResult.job);
        if (applyStallState.unchangedChunks >= NOTION_APPLY_STALL_LIMIT) {
          throw new Error("Notion apply stopped because its durable cursor did not advance.");
        }
        // The server keeps this cursor durable. Once automatic file recovery
        // has outlived its recovery TTL, end only the browser runner so the
        // existing interrupted-apply UI offers an explicit retry; do not mark
        // the job failed or discard its staged/product progress.
        if (notionApplyFileRecoveryRetryLimitReached(chunkResult.job)) return;
        const shouldContinue = await waitForNotionApplyRetryAfter(
          chunkResult.job,
          applyRun.controller.signal,
        );
        checkNotionRunnerAborted(applyRun.controller.signal);
        if (!shouldContinue) return;
      }
      if (!result || result.partial === true || result.job.status !== "completed") {
        throw new Error(L.cantApply);
      }
      // Publishing this run's own completed response intentionally trips the
      // shared terminal abort controller. The remaining work is read-only
      // reconciliation and local UI finalization, so it must not reinterpret
      // that self-owned terminal signal as an external cancellation.
      const jobs = workspace?.id
        ? await listNotionImportJobsRemote({ workspaceId: workspace.id, limit: 5 })
        : { jobs: [] };
      publishNotionJobList(jobs.jobs ?? []);
      publishNotionJob(result.job, {
        itemCount: typeof result.applied?.pages === "number"
          ? result.applied.pages + (result.applied.databases ?? 0) + (result.applied.rows ?? 0)
          : 0,
        surface: true,
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
      const importedRootPageId = result.importedRootPageId || rootMapping?.localId;
      if (importedRootPageId) setImportedRootPage({ jobId, pageId: importedRootPageId });
      // Imported pages were written server-side; pull them into the sidebar tree.
      void refreshWorkspacePages().catch(() => {});
      notify(L.importApplied, "success");
      if (credential.connectionId) setNotionToken("");
    } catch (error) {
      if (isNotionRunnerAbort(error, applyRun.controller.signal)) return;
      // A failed apply moves its partial product pages to Trash server-side;
      // refresh immediately so stale staging entries disappear from the tree.
      void refreshWorkspacePages().catch(() => {});
      const snapshot = workspace?.id
        ? await getNotionImportJobRemote(jobId, workspace.id, { compact: true }).catch(() => null)
        : null;
      if (snapshot?.job) {
        publishNotionJob(snapshot.job, { surface: true });
      }
      if (snapshot?.job.status !== "cancelled" && snapshot?.job.status !== "failed") {
        notify(error instanceof Error ? error.message : L.cantApply, "error");
      }
    } finally {
      if (notionApplyRunRef.current === applyRun) notionApplyRunRef.current = null;
      finishNotionBusy(busyGeneration);
    }
  }

  async function retryNotionFileCopies(jobId: string) {
    if (notionBusy) return;
    const busyGeneration = beginNotionBusy();
    try {
      const result = await retryNotionImportFileCopiesRemote(jobId, workspace?.id);
      const jobs = workspace?.id
        ? await listNotionImportJobsRemote({ workspaceId: workspace.id, limit: 5 })
        : { jobs: [] };
      publishNotionJobList(jobs.jobs ?? []);
      const fileRetry = result.fileRetry ?? {};
      publishNotionJob(result.job, {
        itemCount: safeCount(fileRetry.copied) + safeCount(fileRetry.skipped),
        surface: true,
      });
      notify(
        L.fileRetryFinished(safeCount(fileRetry.copied), safeCount(fileRetry.skipped)),
        safeCount(fileRetry.skipped) ? "default" : "success"
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : L.cantRetryFiles, "error");
    } finally {
      finishNotionBusy(busyGeneration);
    }
  }

  async function cancelNotionImport(jobId: string) {
    if (cancellingJobId) return;
    setCancellingJobId(jobId);
    try {
      const result = await cancelNotionImportJobRemote(jobId, workspace?.id);
      publishNotionJob(result.job, { surface: true });
      await refreshNotionImportStateFresh().catch(() => {});
      // The server-side cancellation fence already owns the old job. Do not
      // keep the fresh-start controls disabled while an obsolete Notion
      // request is still returning in the background.
      invalidateNotionBusy();
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
    // Live ownership and cancellation stay in the single-flow action footer,
    // not inside the scrolling activity panel.
    if (
      (isServerOwnedNotionJob(job) && !isNotionImportTerminal(job)) ||
      isLiveNotionJob(job)
    ) {
      return null;
    }
    // Failed/cancelled retry is the single-flow footer's primary action.
    if (job.status === "ready") {
      // Apply itself lives in the single-flow footer; the panel offers the
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
    if (isNotionImportProblemTerminal(job)) {
      return (
        <section
          className={styles.stepCard}
          data-run-panel={mode}
          data-terminal-status={job.status}
        >
          <header className={styles.stepHeader}>
            <strong>{mode === "apply" ? L.progressSteps.apply : L.progressSteps.discover}</strong>
            <span className={styles.statusPill} data-status={job.status}>
              {statusLabel(job)}
            </span>
          </header>
          <div className={styles.runCurrent} role="status">
            <strong>{statusLabel(job)}</strong>
          </div>
          <p className={styles.terminalNotice} role="alert">
            {job.status === "failed" ? L.terminal.failed : L.terminal.cancelled}
          </p>
        </section>
      );
    }
    const runRecent = activeRecent;
    const startedAt =
      progressStepStartedAt(job, mode === "apply" ? "apply" : "discover") ??
      (typeof job.createdAt === "string" ? job.createdAt : undefined);
    const elapsed = elapsedText(startedAt, runNowMs);
    // Speed = overall average throughput (items done ÷ total elapsed), not a
    // recent-window rate. The persisted activity feed is bounded and does not
    // contain one entry for every processed object, so it is narration only.
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
    let rateText = "";
    const runMetrics = activeLive
      ? estimateImportRunMetrics({
          doneCount,
          elapsedSeconds: elapsedSecs,
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
    const rawProgressPercent = Number(job.progress?.percent);
    const determinatePercent = Number.isFinite(rawProgressPercent)
      ? Math.max(0, Math.min(100, Math.round(rawProgressPercent)))
      : null;
    const discoveryFrontierClosed =
      mode === "apply" ||
      job.progress?.hasMore === false ||
      job.progress?.searchComplete === true ||
      job.status === "ready" ||
      job.status === "completed";
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

        {activeLive && discoveryFrontierClosed && determinatePercent !== null ? (
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-label={currentLine}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={determinatePercent}
          >
            <span style={{ width: `${determinatePercent}%` }} />
          </div>
        ) : null}

        {activeLive ? (
          isServerOwnedNotionJob(job) ? (
            <p className={styles.browserRunnerWarning} role="note" data-server-runner-status>
              {L.wizard.serverRunnerStatus}
            </p>
          ) : (
            <p className={styles.browserRunnerWarning} role="note" data-browser-runner-warning>
              {L.wizard.browserRunnerWarning}
            </p>
          )
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

        <div className={styles.notionActions}>{jobActions(job)}</div>
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
    notionJobs.find((job) => isMonitorableNotionJob(job)) ??
    null;
  const activeSteps = activeJob ? progressStepsOf(activeJob) : [];
  const activeApplied = activeJob ? appliedStats(activeJob) : undefined;
  const activeDiscovered = activeJob ? discoveredEntries(activeJob, L) : [];
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
  // Starting discovery is the user's import confirmation. Once the current
  // run has a complete durable snapshot, applying it is the next phase of the
  // same operation rather than a second decision point.
  const automaticApplyPending = Boolean(
    activeJob &&
      !isServerOwnedNotionJob(activeJob) &&
      notionResult?.job.id === activeJob.id &&
      activeJob.status === "ready" &&
      activeJob.progress?.hasMore !== true &&
      !applyStarted,
  );
  // Keep the lifecycle guard and shell activity continuous across the brief
  // durable ready boundary before the first apply request starts.
  const activeLive = activeJob
    ? !isNotionImportTerminal(activeJob) &&
      (isLiveNotionJob(activeJob) ||
        (isServerOwnedNotionJob(activeJob) && !isNotionImportTerminal(activeJob)) ||
        automaticApplyPending ||
        (notionBusy && notionStep === 4))
    : false;
  const interruptedApply = Boolean(
    activeJob &&
      !isServerOwnedNotionJob(activeJob) &&
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
    activeJob &&
      !activeJob.connectionId &&
      (
        (isLiveNotionJob(activeJob) && notionStep === 1) ||
        (interruptedApply && !notionToken.trim())
      ),
  );

  useEffect(() => {
    if (!onActivityChange) return;
    if (!activeJob || !activeLive) {
      onActivityChange(null);
      return;
    }
    const rawPercent = Number(activeJob.progress?.percent);
    const mode = applyStarted || automaticApplyPending ? "apply" : "discover";
    const determinate =
      mode === "apply" ||
      activeJob.progress?.hasMore === false ||
      activeJob.progress?.searchComplete === true ||
      activeJob.status === "ready" ||
      activeJob.status === "completed";
    const percent = determinate && Number.isFinite(rawPercent)
      ? Math.round(Math.max(0, Math.min(100, rawPercent)))
      : undefined;
    onActivityChange({
      jobId: activeJob.id,
      mode,
      percent,
    });
  }, [activeJob, activeLive, applyStarted, automaticApplyPending, onActivityChange]);

  useEffect(() => () => onActivityChange?.(null), [onActivityChange]);

  // Request-only local imports are still driven by bounded requests from this
  // mounted browser controller, so destructive navigation needs a warning.
  // Saved-connection imports are owned by the durable server queue and skip
  // this browser lifecycle guard entirely.
  useEffect(() => {
    if (!activeLive || (activeJob && isServerOwnedNotionJob(activeJob))) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [activeJob, activeLive]);

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

  // Discovery and apply are one continuous import run. Claim the ready job in
  // a ref before starting so React Strict Mode or a fast status refresh cannot
  // issue duplicate apply loops. The persisted apply cursor still owns reload
  // resume after the first apply request begins.
  useEffect(() => {
    if (!automaticApplyPending || notionBusy || !activeJob) return;
    if (autoApplyJobIdRef.current === activeJob.id) return;
    autoApplyJobIdRef.current = activeJob.id;
    void applyNotionImport(activeJob.id);
    // applyNotionImport intentionally owns the long-running lifecycle; the
    // stable job-state dependencies below are the only automatic trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJob?.id, automaticApplyPending, notionBusy]);

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
    if (isServerOwnedNotionJob(activeJob)) return;
    const runnerKey = workspace?.id ? `${workspace.id}:${activeJob.id}` : "";
    if (!activeJob.connectionId) {
      if (
        runnerKey &&
        !notionDiscoveryRunners.has(runnerKey) &&
        credentialPromptJobIdRef.current !== activeJob.id
      ) {
        setNotionStep(1);
        if (open) {
          credentialPromptJobIdRef.current = activeJob.id;
          notify(L.resumeNeedsCredential, "default");
        }
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
    if (isNotionImportProblemTerminal(job)) {
      logJobIdRef.current = job.id;
      logSeenRef.current = new Set();
      setLogEntries([]);
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
  }, [activeJob?.id, activeJob?.status, activeRecentStamp]);

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
                    {` · ${hanjiSelection.kind === "archive" ? L.hanji.filesIncluded : L.hanji.filesExcluded}`}
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
                accept=".hanji.zip,.hanji.json,.json,application/vnd.hanji.archive+zip,application/zip,application/json"
                className={styles.hiddenInput}
                onChange={onHanjiInputChange}
              />
            </div>
          ) : (
            <div className={styles.panel} data-notion-single-flow="">
              {!activeJob || manualResumeRequired ? (
                <>
                  <section
                    className={styles.stepCard}
                    data-done={selectedConnection ? "true" : undefined}
                    data-notion-connection=""
                  >
                    <header className={styles.stepHeader}>
                      <strong>{L.stepConnect}</strong>
                      {selectedConnection ? (
                        <span className={styles.stepDone}>
                          {L.connectedTo(
                            selectedConnection.notionWorkspaceName ||
                              selectedConnection.name ||
                              L.notionWorkspace,
                          )}
                        </span>
                      ) : null}
                    </header>

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
                            notionToken.trim() && !isAllowedNotionToken(notionToken.trim())
                              ? "true"
                              : undefined
                          }
                        />
                      </label>
                      {notionConnectionStorageAvailable && notionToken.trim() ? (
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
                      ) : null}
                    </div>

                    {!notionConnectionStorageAvailable ? (
                      <p className={styles.stepHint}>
                        {L.connectionStorageUnavailable}
                      </p>
                    ) : null}

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
                                {connection.name ||
                                  connection.notionWorkspaceName ||
                                  L.notionConnectionFallback}
                              </option>
                            ))}
                          </select>
                        </label>
                        {selectedConnectionId ? (
                          <button
                            type="button"
                            className={styles.secondary}
                            onClick={() => void revokeNotionConnection(selectedConnectionId)}
                            disabled={
                              notionBusy ||
                              notionRootScanBusy ||
                              !notionRootScanSummary ||
                              notionRootScanSummary.running
                            }
                          >
                            {L.remove}
                          </button>
                        ) : null}
                      </div>
                    ) : null}

                    <NotionTokenGuide />

                    <div className={styles.tokenGuide} data-token-guide="">
                      <div className={styles.tokenGuideCopy}>
                        <strong>{L.tokenIntroTitle}</strong>
                        <p>{L.tokenIntroDesc}</p>
                      </div>
                      <div className={styles.tokenGuideActions}>
                        <a
                          className={styles.externalButton}
                          href={NOTION_TOKEN_URL}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {L.openTokenPage}
                        </a>
                      </div>
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
                      <a
                        className={styles.textLink}
                        href={NOTION_TOKEN_HELP_URL}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {L.tokenHelpLink}
                      </a>
                    </details>
                  </section>

                  <div className={styles.destBanner}>
                    <span className={styles.destRoute}>
                      <GlobeIcon size={14} aria-hidden="true" />
                      <strong>{sourceWorkspaceName || L.notion}</strong>
                      <span aria-hidden="true">→</span>
                      <strong>{workspace?.name || ""}</strong>
                    </span>
                    <span className={styles.destNote}>{L.destinationNote}</span>
                  </div>

                  {!manualResumeRequired ? (
                    <section className={styles.stepCard} data-notion-root-selection="">
                      <header className={styles.stepHeader}>
                        <strong>{L.rootPickerTitle}</strong>
                      </header>
                      <div className={styles.rootPicker}>
                        <div className={styles.rootScanRow}>
                          <span
                            className={styles.rootScanSummary}
                            role="status"
                            aria-live="polite"
                          >
                            {notionRootScanSummary
                              ? notionRootScanSummary.running
                                ? L.rootScanProgress(
                                    notionRootCandidates.length,
                                    notionRootScanSummary.scanned,
                                    notionRootScanSummary.searchPagesFetched,
                                  )
                                : [
                                    L.rootScanFound(
                                      notionRootCandidates.length,
                                      notionRootScanSummary.scanned,
                                    ),
                                    notionRootScanWorkspace?.name
                                      ? L.rootScanWorkspaceLabel(notionRootScanWorkspace.name)
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")
                              : hasCredential
                                ? L.scanningRoots
                                : L.rootScanHint}
                          </span>
                        </div>

                        {notionRootScanSummary?.hasMore ? (
                          <p className={styles.stepHint}>{L.rootScanHasMore}</p>
                        ) : null}

                        {notionRootScanError ? (
                          <div className={styles.rootScanError} role="alert">
                            <span>{notionRootScanError}</span>
                            <button
                              type="button"
                              className={styles.secondary}
                              onClick={() => {
                                rootScanCredentialKeyRef.current = "";
                                void scanNotionRootCandidates();
                              }}
                              disabled={notionRootScanBusy}
                            >
                              {L.retry}
                            </button>
                          </div>
                        ) : null}

                        {notionRootCandidates.length ? (
                          <div
                            className={styles.rootList}
                            role="group"
                            aria-label={L.rootPickerTitle}
                          >
                            <div className={styles.rootListHeader}>
                              <strong>{L.rootPickerTitle}</strong>
                              <span>
                                {L.rootSelectionCount(
                                  selectedRoots.length,
                                  notionRootCandidates.length,
                                )}
                              </span>
                              <button
                                type="button"
                                className={styles.inlineButton}
                                disabled={notionRootScanBusy}
                                onClick={() =>
                                  setSelectedNotionRootKeys(
                                    notionRootCandidates.map(notionRootCandidateKey),
                                  )
                                }
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
                                  <label
                                    key={key}
                                    className={styles.rootCandidate}
                                    data-selected={checked ? "true" : undefined}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      disabled={notionRootScanBusy}
                                      onChange={(event) => {
                                        const isChecked = event.currentTarget.checked;
                                        setSelectedNotionRootKeys((current) => {
                                          if (isChecked) {
                                            return current.includes(key)
                                              ? current
                                              : [...current, key];
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
                                      <strong>
                                        {candidate.title || generatedLabels.untitled}
                                      </strong>
                                      <span>{rootCandidateKindLabel(candidate, L)}</span>
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        ) : notionRootScanSummary &&
                          !notionRootScanSummary.running &&
                          !notionRootScanError ? (
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
                            <p>
                              {L.rootScanEmptyOtherWorkspace(notionRootScanWorkspace?.name)}
                            </p>
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
                          {rootIdCount ? L.pagesRecognized(rootIdCount) : L.scopeWarning}
                        </p>

                        {/* Localized text is nested below the native checkbox. */}
                        {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
                        <label className={styles.optionRow}>
                          <input
                            type="checkbox"
                            checked={notionImportPagesFullWidth}
                            onChange={(event) =>
                              setNotionImportPagesFullWidth(event.currentTarget.checked)
                            }
                          />
                          <span className={styles.optionText}>
                            <strong>{L.fullWidthPages}</strong>
                            <span>{L.fullWidthPagesDesc}</span>
                          </span>
                        </label>
                      </div>
                    </section>
                  ) : null}

                  <div className={styles.actionBar} data-notion-import-consent="">
                    <span className={styles.actionBarHint}>
                      {manualResumeRequired
                        ? L.resumeNeedsCredential
                        : notionRootScanBusy
                          ? L.scanningRoots
                          : rootIdCount
                            ? L.rootSelectionCount(
                                selectedRoots.length,
                                notionRootCandidates.length,
                              )
                            : L.wizard.needRootsHint}
                    </span>
                    {manualResumeRequired && activeJob ? (
                      <>
                        <button
                          type="button"
                          className={styles.secondary}
                          onClick={() => void cancelNotionImport(activeJob.id)}
                          disabled={cancellingJobId !== null}
                        >
                          {cancellingJobId === activeJob.id
                            ? L.cancellingImport
                            : L.cancelImport}
                        </button>
                        <button
                          type="button"
                          className={styles.primary}
                          disabled={notionBusy || !notionToken.trim()}
                          onClick={() => {
                            if (applyStarted) {
                              void applyNotionImport(activeJob.id);
                            } else {
                              void resumeNotionDiscovery(activeJob);
                            }
                          }}
                        >
                          {notionBusy
                            ? L.resumingImport
                            : applyStarted
                              ? L.retry
                              : L.resumeImport}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={styles.primary}
                        onClick={() => void startNotionImport()}
                        disabled={
                          notionBusy ||
                          notionRootScanBusy ||
                          !workspace?.id ||
                          !hasCredential ||
                          rootIdCount === 0
                        }
                      >
                        {notionBusy ? L.discovering : L.hanji.importButton}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.destBanner}>
                    <span className={styles.destRoute}>
                      <GlobeIcon size={14} aria-hidden="true" />
                      <strong>{sourceWorkspaceName || L.notion}</strong>
                      <span aria-hidden="true">→</span>
                      <strong>{workspace?.name || ""}</strong>
                    </span>
                    <span className={styles.destNote}>{L.destinationNote}</span>
                  </div>

                  {renderRunPanel(
                    applyStarted || automaticApplyPending ? "apply" : "discover",
                  )}

                  <div className={styles.actionBar} data-notion-action-footer="">
                    <span className={styles.actionBarHint}>
                      {statusLabel(activeJob)}
                    </span>
                    {isNotionImportProblemTerminal(activeJob) ? (
                        <button
                          type="button"
                          className={styles.primary}
                          disabled={notionBusy}
                          onClick={() => void startNotionImport(activeJob.id)}
                        >
                          {L.retry}
                        </button>
                    ) : interruptedApply ? (
                        <button
                          type="button"
                          className={styles.primary}
                          onClick={() => void applyNotionImport(activeJob.id)}
                        >
                          {L.retry}
                        </button>
                    ) : activeJob.status === "completed" ? (
                        <>
                          <button
                            type="button"
                            className={styles.secondary}
                            onClick={() => {
                              clearTerminalNotionResult();
                              close();
                            }}
                          >
                            {L.wizard.done}
                          </button>
                          {importedRootPage?.jobId === activeJob.id ? (
                            <button
                              type="button"
                              className={styles.primary}
                              onClick={() => {
                                clearTerminalNotionResult();
                                close(false);
                                router.push(pageHref(importedRootPage.pageId));
                              }}
                            >
                              {L.openImportedPage}
                            </button>
                          ) : null}
                        </>
                    ) : (
                        <>
                          {!isServerOwnedNotionJob(activeJob) &&
                          isLiveNotionJob(activeJob) &&
                          !notionBusy ? (
                            <button
                              type="button"
                              className={styles.secondary}
                              onClick={() => {
                                if (applyStarted) {
                                  void applyNotionImport(activeJob.id);
                                } else {
                                  void resumeNotionDiscovery(activeJob);
                                }
                              }}
                            >
                              {applyStarted ? L.retry : L.resumeImport}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className={styles.secondary}
                            onClick={() => void cancelNotionImport(activeJob.id)}
                            disabled={cancellingJobId !== null}
                          >
                            {cancellingJobId === activeJob.id
                              ? L.cancellingImport
                              : L.cancelImport}
                          </button>
                        </>
                    )}
                  </div>
                </>
              )}
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
