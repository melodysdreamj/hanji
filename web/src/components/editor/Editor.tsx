"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { i18next } from "@/i18n";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { copyTextWithBlocks } from "@/lib/clipboard";
import {
  listCollaborationOperationsRemote,
  listCollaborationDocumentsRemote,
  recordCollaborationOperationRemote,
  type CollaborationDocumentRecord,
  type CollaborationOperationRecord,
  type CreateDatabaseInput,
} from "@/lib/edgebase";
import {
  applyBlockTextRemoteCrdtUpdatesToUndoSession,
  captureBlockTextLocalEdit,
  createBlockTextCrdtUpdateFromUndoSession,
  markBlockTextCollaborationPristine,
  mergeBlockTextCrdtUpdates,
  readBlockTextCrdtDocumentState,
  readBlockTextCrdtUpdate,
  redoBlockTextLocalEdit,
  rememberBlockTextDurableState,
  syncBlockTextRemoteEdit,
  undoBlockTextLocalEdit,
  type BlockTextUndoResult,
} from "@/lib/collaborationCrdt";
import { pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { uploadWorkspaceFile } from "@/lib/storage";
import { hasStoredFileReference } from "@/lib/storedFileReferences";
import {
  PAGE_CRDT_UPDATE_RECEIVED_EVENT,
  PAGE_TEXT_UPDATE_RECEIVED_EVENT,
  publishPageCrdtUpdate,
  publishPageAwareness,
  publishPageTextUpdate,
  type PageCrdtUpdateReceived,
  type PageAwarenessMode,
  type PageAwarenessTextRange,
  type PagePresenceAwareness,
  type PageTextUpdateReceived,
} from "@/lib/pagePresence";
import { useStore } from "@/lib/store";
import {
  applyTextOperationToSpans,
  createTextOperation,
  sanitizeTextSpanOperation,
  textSpansEqual,
} from "@/lib/textOperations";
import { sanitizeBlockStructureOperation } from "@/lib/blockStructureOperations";
import { positionBetween } from "@/lib/ids";
import type { Block, BlockContent, BlockType, ButtonTemplateBlock, Page, TextSpan, ViewType } from "@/lib/types";
import { spansToPlainText } from "@/lib/types";
import {
  BoardIcon,
  CalendarIcon,
  ChevronDown,
  FileText,
  GalleryIcon,
  ListIcon,
  TableIcon,
  TimelineIcon,
  Upload,
} from "@/icons/hanji";
import { TemplatesDialog } from "../TemplatesDialog";
import { blocksClipboardHtml, blockTreeHtml, blockTreeMarkdown } from "./blockMarkdown";
import { BLOCK_DEFS, getDef, TEXT_BLOCKS } from "./blocks";
import {
  focusBlockControlSettled,
  focusEditable,
  focusEditableSettled,
  getEditable,
  selectEditableRange,
  selectionOffsetsIn,
} from "./focus";
import {
  blockUploadErrorMessage,
  blockUploadProgressLabel,
  blockUploadScope,
  dataTransferHasFiles,
  droppedFiles,
  fileBlockType,
  fileDragAutoScrollDelta,
  type BlockUploadProgress,
  type FileDropPlacement,
} from "./fileDrop";
import { coalesce, concatSpans, spansToHtml } from "./richtext";
import { BlockItem } from "./BlockItem";
import { BlockIcon } from "./BlockIcon";
import { BlockMoveToDialog } from "./BlockMoveToDialog";
import { rememberEditorColor } from "./colorMemory";
import {
  databaseTitleFromText,
  DEFAULT_DATABASE_TITLE,
  inlineDatabasePlaceholderTitle,
} from "./databaseTitles";
import { SelectionToolbar } from "./SelectionToolbar";
import type { PastedBlock } from "./markdownPaste";
import {
  consumePendingPageStarterDismiss,
  PAGE_STARTER_DISMISS_REQUEST,
  type PageStarterDismissDetail,
} from "./pageStarterDismiss";
import styles from "./editor.module.css";

const TOGGLE_BLOCKS: Set<BlockType> = new Set([
  "toggle",
  "toggle_heading_1",
  "toggle_heading_2",
  "toggle_heading_3",
  "toggle_heading_4",
]);

const STRUCTURAL_BLOCKS: Set<BlockType> = new Set(["column_list", "column"]);
const EMPTY_BLOCKS: Block[] = [];
// Stable default for the remoteAwareness prop: a `= []` default would mint a
// new array identity every render and defeat the memoized ops facade below.
const EMPTY_AWARENESS: PagePresenceAwareness[] = [];

const EDITOR_SELECTION_REQUEST = "hanji:editor-selection-request";
const COLLABORATION_LOG_DEBOUNCE_MS = 750;
// Batch size for the durable-CRDT resync request. This is NOT a correctness
// cap — every text block is primed across batches; it only bounds per-request
// payload size.
const DURABLE_CRDT_RESYNC_BATCH_SIZE = 120;

type PendingCollaborationTextLog = {
  beforeSpans: TextSpan[];
  latestSpans: TextSpan[];
  revision: number;
  timer?: number;
  updatedAt: string;
};

type CollaborationReplayCursor = {
  revision: number;
  occurredAt: string;
  id: string;
};

type PendingCrdtReplayBatch = {
  afterCursor: CollaborationReplayCursor;
  beforeCursor: CollaborationReplayCursor;
  records: CollaborationOperationRecord[];
};

function collaborationRecordCursor(record: CollaborationOperationRecord): CollaborationReplayCursor {
  return {
    revision: record.revision ?? 0,
    occurredAt: record.occurredAt ?? "",
    id: record.id,
  };
}

function collaborationDocumentCursor(
  document: CollaborationDocumentRecord
): CollaborationReplayCursor | undefined {
  if (!document.lastOperationId) return undefined;
  if (typeof document.lastOperationRevision !== "number") return undefined;
  return {
    revision: document.lastOperationRevision,
    occurredAt: document.lastOperationOccurredAt ?? document.updatedAt ?? "",
    id: document.lastOperationId,
  };
}

function collaborationCursorIsAfter(
  current: CollaborationReplayCursor,
  cursor: CollaborationReplayCursor
) {
  if (current.revision !== cursor.revision) return current.revision > cursor.revision;
  if (current.occurredAt !== cursor.occurredAt) return current.occurredAt > cursor.occurredAt;
  return current.id > cursor.id;
}

function activeEditorTextBlockId(editor: HTMLElement | null) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !editor?.contains(active)) return null;
  if (!active.closest("[data-rt-editable='true']")) return null;
  return active.closest<HTMLElement>("[data-block-id]")?.dataset.blockId ?? null;
}

function cloneTextSpans(spans: TextSpan[]): TextSpan[] {
  return spans.map((span) => ({ ...span }));
}

function emptyParagraphContent(content?: BlockContent): BlockContent {
  const next = { ...(content ?? {}), rich: [] };
  delete next.checked;
  delete next.collapsed;
  delete next.icon;
  delete next.language;
  delete next.lineNumbers;
  delete next.wrap;
  return next;
}

function blockTreesHaveStoredFiles(roots: Block[], allBlocks: Block[]) {
  const children = new Map<string, Block[]>();
  for (const block of allBlocks) {
    if (!block.parentId) continue;
    const list = children.get(block.parentId) ?? [];
    list.push(block);
    children.set(block.parentId, list);
  }
  const seen = new Set<string>();
  const visit = (block: Block): boolean => {
    if (seen.has(block.id)) return false;
    seen.add(block.id);
    return hasStoredFileReference(block.content)
      || (children.get(block.id) ?? []).some(visit);
  };
  return roots.some(visit);
}

function notifyStoredFileCloneBlocked() {
  useStore.getState().notify(i18next.t("editor:storedFileCloneBlocked"), "error");
}

function textBlockContentFrom(block: Block): BlockContent {
  const rich =
    block.content?.rich ??
    block.content?.caption ??
    (block.content?.expression ? [{ text: block.content.expression }] : undefined) ??
    (block.plainText ? [{ text: block.plainText }] : []);
  return {
    rich,
    ...(block.content?.color ? { color: block.content.color } : {}),
  };
}

// Block types that can hold nested children (valid indent targets). A divider,
// image, bookmark, etc. cannot be a container, so Tab won't nest under them.
const CONTAINER_BLOCKS: Set<BlockType> = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "toggle_heading_1",
  "toggle_heading_2",
  "toggle_heading_3",
  "toggle_heading_4",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "tab",
  "quote",
  "callout",
]);

const EMPTY_ENTER_EXITS_TO_PARAGRAPH: Set<BlockType> = new Set([
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "quote",
  "callout",
]);

function blockContinuesOnEnter(type: BlockType) {
  return getDef(type).continues === true;
}

type BlockTextMark = "bold" | "italic" | "underline" | "strikethrough" | "code";

const BLOCK_SELECTION_TURN_TYPES: BlockType[] = [
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "to_do",
  "bulleted_list_item",
  "numbered_list_item",
  "toggle",
  "quote",
  "callout",
  "code",
];

const BLOCK_SELECTION_TEXT_COLORS = [
  { token: "default" },
  { token: "gray" },
  { token: "brown" },
  { token: "orange" },
  { token: "yellow" },
  { token: "green" },
  { token: "blue" },
  { token: "purple" },
  { token: "pink" },
  { token: "red" },
] as const;

const BLOCK_SELECTION_BACKGROUND_COLORS = [
  { token: "gray_background" },
  { token: "brown_background" },
  { token: "orange_background" },
  { token: "yellow_background" },
  { token: "green_background" },
  { token: "blue_background" },
  { token: "purple_background" },
  { token: "pink_background" },
  { token: "red_background" },
] as const;

export interface EditorOps {
  pageId: string;
  readOnly: boolean;
  templateMode: boolean;
  publicReadOnly: boolean;
  sharedToken?: string;
  selectedBlockId: string | null;
  selectedBlockIds: Set<string>;
  blockActionMenuFor: string | null;
  selectBlock: (id: string | null) => void;
  selectAllBlocks: (anchorId?: string) => void;
  openBlockActionMenu: (id: string | null) => void;
  openMoveDialog: (id: string) => void;
  selectAdjacentBlock: (id: string, direction: "up" | "down") => void;
  selectEdgeBlock: (edge: "first" | "last") => void;
  extendSelection: (id: string, direction: "up" | "down") => void;
  extendSelectionToEdge: (id: string, edge: "first" | "last") => void;
  deleteSelectedBlocks: () => void;
  moveSelectedBlock: (id: string, direction: "up" | "down") => boolean;
  moveSelectedBlocks: (id: string, direction: "up" | "down") => boolean;
  copyBlock: (id: string) => Promise<boolean>;
  copySelectedBlocks: (id: string) => Promise<boolean>;
  cutBlock: (id: string) => Promise<boolean>;
  cutSelectedBlocks: (id: string) => Promise<boolean>;
  duplicateBlock: (id: string) => Promise<Block | undefined>;
  duplicateSelectedBlocks: (id: string) => Promise<Block[]>;
  setSelectedBlockColor: (id: string, token: string) => boolean;
  toggleSelectedBlockState: (id: string) => boolean;
  toggleSelectedTextMark: (id: string, mark: BlockTextMark) => boolean;
  insertBlocksAfter: (id: string, blocks: PastedBlock[]) => Block | undefined;
  replaceSelectedBlocks: (id: string, blocks: PastedBlock[]) => Block | undefined;
  removeSelectedBlock: (id: string) => void;
  setText: (id: string, spans: TextSpan[]) => void;
  changeType: (id: string, type: BlockType, caret?: "start" | "end" | number) => void;
  changeSelectedType: (id: string, type: BlockType, caret?: "start" | "end" | number) => void;
  splitBlock: (id: string, before: TextSpan[], after: TextSpan[]) => void;
  backspace: (id: string, curSpans: TextSpan[]) => boolean; // true if handled
  deleteForward: (id: string, curSpans: TextSpan[]) => boolean;
  arrowUp: (id: string) => void;
  arrowDown: (id: string) => void;
  indentBlock: (id: string, opts?: { preserveSelection?: boolean }) => void;
  outdentBlock: (id: string, opts?: { preserveSelection?: boolean }) => void;
  indentSelectedBlocks: (id: string) => void;
  outdentSelectedBlocks: (id: string) => void;
  moveBlock: (id: string, targetId: string, placement: "before" | "after" | "inside") => boolean;
  moveSelectedBlocksTo: (id: string, targetId: string, placement: "before" | "after" | "inside") => boolean;
  copySelectedBlocksTo: (id: string, targetId: string, placement: "before" | "after" | "inside") => Block[];
  moveSelectedBlocksToPage: (id: string, targetPageId: string) => Promise<boolean>;
  uploadDroppedFiles: (
    files: File[],
    targetId: string | null,
    placement: FileDropPlacement
  ) => Promise<void>;
  insertAfter: (id: string, type?: BlockType) => Block | undefined;
  insertChildBlock: (parentId: string, type?: BlockType) => Block | undefined;
  replaceWithBlocks: (id: string, blocks: PastedBlock[]) => void;
  remove: (id: string) => void;
  createChildPage: (id: string) => void;
  createPageLink: (id: string) => void;
  createDatabase: (id?: string, viewType?: StarterDatabaseView) => Promise<Page | undefined>;
  createInlineDatabase: (id: string, viewType?: StarterDatabaseView) => Promise<Page | undefined>;
  linkDatabase: (
    id: string,
    databaseId: string,
    type: "child_database" | "inline_database",
    viewType?: StarterDatabaseView,
  ) => void;
  createColumns: (id: string, count: number) => void;
  createSimpleTable: (id: string) => void;
  createEquation: (id: string) => void;
  createSyncedBlock: (id: string) => void;
  createSyncedBlockCopy: (id: string) => void;
  unsyncSyncedBlock: (id: string) => Promise<Block[]>;
  createButton: (id: string) => void;
  createTab: (id: string) => void;
  runButton: (id: string) => void;
  captureNextBlockToButton: (id: string) => void;
  publishAwareness: (
    blockId: string,
    mode: PageAwarenessMode,
    selectedBlockIds?: string[],
    textRange?: PageAwarenessTextRange,
  ) => void;
  remoteAwarenessByBlock: Record<string, PagePresenceAwareness[]>;
}

type StarterDatabaseView = Extract<
  ViewType,
  "table" | "board" | "list" | "gallery" | "calendar" | "timeline"
>;

const STARTER_DATABASE_VIEWS: { type: StarterDatabaseView }[] = [
  { type: "table" },
  { type: "board" },
  { type: "list" },
  { type: "timeline" },
  { type: "calendar" },
  { type: "gallery" },
];
function blankDatabaseProperties(): NonNullable<CreateDatabaseInput["properties"]> {
  return [{ name: i18next.t("databaseView:name"), type: "title", position: 1 }];
}

function starterDatabaseToastLabel(type: StarterDatabaseView) {
  return i18next.t(`editor:views.${type}`);
}

function databaseTitleFromBlock(block?: Block | null, fallback = DEFAULT_DATABASE_TITLE) {
  return databaseTitleFromText(spansToPlainText(block?.content?.rich), fallback);
}

function databaseTitleFromStarterPage(page?: Page, block?: Block | null) {
  const blockTitle = databaseTitleFromText(spansToPlainText(block?.content?.rich));
  if (blockTitle !== DEFAULT_DATABASE_TITLE) return blockTitle;
  const pageTitle = page?.title?.trim();
  return pageTitle || DEFAULT_DATABASE_TITLE;
}

function StarterDatabaseIcon({ type }: { type: StarterDatabaseView }) {
  if (type === "table") return <TableIcon size={16} aria-hidden="true" />;
  if (type === "board") return <BoardIcon size={16} aria-hidden="true" />;
  if (type === "list") return <ListIcon size={16} aria-hidden="true" />;
  if (type === "timeline") return <TimelineIcon size={16} aria-hidden="true" />;
  if (type === "calendar") return <CalendarIcon size={16} aria-hidden="true" />;
  return <GalleryIcon size={16} aria-hidden="true" />;
}

function PageStarter({
  ops,
  blockId,
  onDismiss,
}: {
  ops: EditorOps;
  blockId: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation(["editor", "common"]);
  const page = useStore((s) => s.pagesById[ops.pageId]);
  const notify = useStore((s) => s.notify);
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const starterRef = useRef<HTMLDivElement>(null);
  const [importing, setImporting] = useState(false);
  const [creatingView, setCreatingView] = useState<StarterDatabaseView | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  function focusEmptyPage() {
    onDismiss();
    focusEditableSettled(blockId, "start");
  }

  function starterButtons() {
    return Array.from(
      starterRef.current?.querySelectorAll<HTMLButtonElement>("[data-page-starter-action]") ?? [],
    ).filter((button) => !button.disabled && button.offsetParent !== null);
  }

  function onStarterKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      focusEmptyPage();
      return;
    }
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const buttons = starterButtons();
    if (buttons.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const currentIndex = buttons.findIndex((button) => button === document.activeElement);
    let nextIndex = currentIndex >= 0 ? currentIndex : 0;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      nextIndex = currentIndex >= 0 ? (currentIndex + 1) % buttons.length : 0;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      nextIndex = currentIndex > 0 ? currentIndex - 1 : buttons.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = buttons.length - 1;
    }
    buttons[nextIndex]?.focus();
  }

  async function importMarkdownFile(file?: File) {
    if (!file || !page) return;
    setImporting(true);
    try {
      const { importMarkdownIntoPage } = await import("../pageMarkdownImport");
      const count = await importMarkdownIntoPage(page, file);
      if (count > 0) {
        const st = useStore.getState();
        const placeholder = st.blocksByPage[ops.pageId]?.find((block) => block.id === blockId);
        if (
          placeholder?.type === "paragraph" &&
          spansToPlainText(placeholder.content?.rich).length === 0
        ) {
          await st.deleteBlock(blockId, { history: false });
        }
        notify(i18next.t("editor:importedBlocks", { count }), "success");
      } else {
        notify(i18next.t("editor:noMarkdownBlocks"), "default");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : i18next.t("editor:couldntImportMarkdown"), "error");
    } finally {
      setImporting(false);
    }
  }

  function onImportChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    void importMarkdownFile(file);
  }

  async function createDatabaseView(type: StarterDatabaseView) {
    if (creatingView) return;
    setCreatingView(type);
    try {
      const st = useStore.getState();
      const block = st.blocksByPage[ops.pageId]?.find((item) => item.id === blockId);
      if (!block) return;

      const replaceCurrentPage =
        page?.kind === "page" &&
        page.parentType !== "database" &&
        useStore.getState().childPages(page.id).length === 0;
      const title = databaseTitleFromStarterPage(page, block);
      st.captureBlockHistory(ops.pageId);
      const db = await st.createDatabase({
        parentId: replaceCurrentPage ? page.parentId ?? null : ops.pageId,
        parentType: replaceCurrentPage ? page.parentType : "page",
        title,
        afterPosition: replaceCurrentPage ? page.position : undefined,
        viewType: type,
        seedRows: false,
        properties: blankDatabaseProperties(),
      });

      router.push(pageHref(db.id));
      if (replaceCurrentPage) {
        // Permanent deletion is intentionally server-gated behind the trash
        // lifecycle. The starter conversion may remove an empty source page,
        // but it must still traverse that same recoverable boundary.
        const currentStore = useStore.getState();
        await currentStore.trashPage(page.id);
        await currentStore.deletePage(page.id);
      } else {
        useStore.getState().updateBlock(
          blockId,
          {
            type: "child_database",
            content: { childPageId: db.id },
            plainText: db.title,
          },
          { history: false }
        );
      }
      notify(
        i18next.t("editor:databaseCreated", { viewLabel: starterDatabaseToastLabel(type) }),
        "success",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : i18next.t("editor:couldntCreateDatabase"), "error");
    } finally {
      setCreatingView(null);
    }
  }

  return (
    <div
      ref={starterRef}
      className={styles.pageStarter}
      contentEditable={false}
      role="group"
      aria-label={t("editor:starter.region")}
      onKeyDown={onStarterKeyDown}
    >
      <div className={styles.pageStarterLabel}>{t("editor:starter.getStarted")}</div>
      <div className={styles.pageStarterPrimary} role="group" aria-label={t("editor:starter.actions")}>
        <button
          type="button"
          className={styles.pageStarterButton}
          data-page-starter-action
          onClick={() => void createDatabaseView("table")}
          disabled={creatingView !== null}
        >
          <span className={styles.pageStarterIcon}>
            <TableIcon size={16} />
          </span>
          <span className={styles.pageStarterText}>
            {creatingView === "table" ? t("editor:starter.creating") : t("editor:starter.database")}
          </span>
        </button>
        <button
          type="button"
          className={styles.pageStarterButton}
          data-page-starter-action
          onClick={() => setTemplatesOpen(true)}
        >
          <span className={styles.pageStarterIcon}>
            <FileText size={16} />
          </span>
          <span className={styles.pageStarterText}>{t("editor:starter.templates")}</span>
        </button>
        <button
          type="button"
          className={styles.pageStarterButton}
          data-page-starter-action
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
        >
          <span className={styles.pageStarterIcon}>
            <Upload size={16} />
          </span>
          <span className={styles.pageStarterText}>{importing ? t("editor:starter.importing") : t("editor:starter.import")}</span>
        </button>
        <button
          type="button"
          className={styles.pageStarterButton}
          data-page-starter-action
          aria-expanded={moreOpen}
          aria-controls="page-starter-more"
          onClick={() => setMoreOpen((current) => !current)}
        >
          <span className={styles.pageStarterIcon}>
            <ChevronDown size={16} aria-hidden="true" />
          </span>
          <span className={styles.pageStarterText}>{t("editor:starter.more")}</span>
        </button>
      </div>
      {moreOpen && (
        <div
          id="page-starter-more"
          className={styles.pageStarterMore}
          role="group"
          aria-label={t("editor:starter.moreOptions")}
        >
          {STARTER_DATABASE_VIEWS.filter((view) => view.type !== "table").map((view) => (
            <button
              type="button"
              key={view.type}
              className={styles.pageStarterButton}
              data-page-starter-action
              onClick={() => void createDatabaseView(view.type)}
              disabled={creatingView !== null}
            >
              <span className={styles.pageStarterGlyph}>
                <StarterDatabaseIcon type={view.type} />
              </span>
              <span className={styles.pageStarterText}>
                {creatingView === view.type
                  ? t("editor:starter.creating")
                  : t(`editor:views.${view.type}`)}
              </span>
            </button>
          ))}
        </div>
      )}
      <input
        ref={fileInputRef}
        className={styles.pageStarterFile}
        type="file"
        accept=".md,.markdown,text/markdown,text/plain"
        onChange={onImportChange}
      />
      {templatesOpen && (
        <TemplatesDialog
          targetPageId={ops.pageId}
          placeholderBlockId={blockId}
          onClose={() => setTemplatesOpen(false)}
        />
      )}
    </div>
  );
}

function EditorContentLoadingFallback() {
  const { t } = useTranslation(["editor", "common"]);
  return (
    <div className={styles.editorContentLoading} aria-busy="true" aria-label={t("editor:content.loadingPageBody")}>
      <div className={styles.editorContentLoadingTextLine} aria-hidden="true" />
      <div className={styles.editorContentLoadingTextLine} aria-hidden="true" />
      <div className={styles.editorContentLoadingTextLine} aria-hidden="true" />
    </div>
  );
}

type EditorFileDropIndicator = {
  targetId: string | null;
  placement: FileDropPlacement;
  top: number;
  left: number;
  width: number;
};

function EditorFileUploadProgress({
  blockId,
  progress,
}: {
  blockId: string;
  progress: BlockUploadProgress;
}) {
  return (
    <div
      className={styles.editorFileUploadProgress}
      data-editor-file-upload={blockId}
      role="status"
      aria-live="polite"
    >
      <div className={styles.editorFileUploadProgressHeader}>
        <strong>{blockUploadProgressLabel(progress)}</strong>
        <span>{progress.percent}%</span>
      </div>
      <div className={styles.editorFileUploadProgressName}>{progress.fileName}</div>
      <div
        className={styles.editorFileUploadProgressTrack}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-label={i18next.t("blockItem:uploadingFile", { fileName: progress.fileName })}
      >
        <span style={{ width: `${progress.percent}%` }} />
      </div>
    </div>
  );
}

export function Editor({
  pageId,
  collaborationStatus,
  readOnly = false,
  canComment = false,
  templateMode = false,
  publicReadOnly = false,
  sharedToken,
  remoteAwareness = EMPTY_AWARENESS,
  skipRemoteLoad = false,
  showPageStarter = true,
  emptyBodyPrompt,
}: {
  pageId: string;
  collaborationStatus?: string;
  readOnly?: boolean;
  canComment?: boolean;
  templateMode?: boolean;
  publicReadOnly?: boolean;
  sharedToken?: string;
  remoteAwareness?: PagePresenceAwareness[];
  skipRemoteLoad?: boolean;
  showPageStarter?: boolean;
  emptyBodyPrompt?: string;
}) {
  const { t } = useTranslation(["editor", "common"]);
  const router = useRouter();
  const blocks = useStore(useShallow((s) => s.topLevelBlocks(pageId)));
  const blocksLoaded = useStore((s) => s.loadedBlockPages.has(pageId));
  const loadBlocks = useStore((s) => s.loadBlocks);
  const undoBlockChange = useStore((s) => s.undoBlockChange);
  const redoBlockChange = useStore((s) => s.redoBlockChange);
  const ensured = useRef<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const replayedCollaborationOperationIds = useRef<Set<string>>(new Set());
  const collaborationReplayCursor = useRef({ revision: 0, occurredAt: "", id: "" });
  const collaborationReplayInFlight = useRef(false);
  const durableDocumentSyncInFlight = useRef(false);
  const syncedDurableDocumentKeys = useRef<Set<string>>(new Set());
  const durableCrdtReplayCursors = useRef<Map<string, CollaborationReplayCursor>>(new Map());
  const pendingCollaborationTextLogs = useRef<Map<string, PendingCollaborationTextLog>>(
    new Map()
  );
  const [selectedBlockId, setSelectedBlockIdState] = useState<string | null>(null);
  // The full multi-block selection. `selectedBlockId` is the anchor within it.
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(() => new Set());
  const [dismissedStarterBlockId, setDismissedStarterBlockId] = useState<string | null>(null);
  const [blockActionMenuFor, setBlockActionMenuFor] = useState<string | null>(null);
  const [moveDialogFor, setMoveDialogFor] = useState<string | null>(null);
  const [fileDropIndicator, setFileDropIndicator] = useState<EditorFileDropIndicator | null>(null);
  const [fileUploadProgressByBlock, setFileUploadProgressByBlock] = useState<
    Record<string, BlockUploadProgress>
  >({});
  // The moving endpoint of a Shift+Arrow selection (handler-only, never read in render).
  const selectionFocusRef = useRef<string | null>(null);
  // Mutable state of an in-progress rubber-band drag (viewport coords). Held in a
  // ref so reads/writes happen only in pointer handlers, never during render.
  const rubberBandRef = useRef<{
    startX: number;
    startY: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);
  // The visual selection rectangle, in viewport coordinates. `null` when idle.
  const [marquee, setMarquee] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  // Detaches any window listeners from an in-progress rubber-band drag. Written
  // only in pointer handlers; the unmount effect reads it to avoid a leak if the
  // editor unmounts mid-drag.
  const detachDragRef = useRef<(() => void) | null>(null);

  const publishEditorAwareness = useCallback(
    (
      blockId: string,
      mode: PageAwarenessMode,
      selectedIds?: string[],
      textRange?: PageAwarenessTextRange,
    ) => {
      if (readOnly || templateMode) return;
      publishPageAwareness({
        blockId,
        mode,
        pageId,
        selectedBlockIds: selectedIds,
        textRange,
      });
    },
    [pageId, readOnly, templateMode],
  );

  // Setting a single selection (or clearing it) keeps the set in sync.
  const setSelectedBlockId = (id: string | null) => {
    setSelectedBlockIdState(id);
    setSelectedBlockIds(id ? new Set([id]) : new Set());
    selectionFocusRef.current = id;
  };
  const pagePlaceholderBlockId =
    blocks.length === 1 &&
    blocks[0].type === "paragraph" &&
    spansToPlainText(blocks[0].content?.rich).length === 0
      ? blocks[0].id
      : null;
  const pageStarterVisible =
    showPageStarter &&
    !readOnly &&
    !!pagePlaceholderBlockId &&
    dismissedStarterBlockId !== pagePlaceholderBlockId;
  const emptyBodyPromptVisible =
    !showPageStarter &&
    !readOnly &&
    !!emptyBodyPrompt &&
    !!pagePlaceholderBlockId &&
    dismissedStarterBlockId !== pagePlaceholderBlockId;
  const contentLoadingVisible = !blocksLoaded && !skipRemoteLoad && blocks.length === 0;
  const remoteAwarenessByBlock = useMemo(() => {
    const byBlock: Record<string, PagePresenceAwareness[]> = {};
    for (const awareness of remoteAwareness) {
      const ids =
        awareness.selectedBlockIds.length > 0
          ? awareness.selectedBlockIds
          : awareness.blockId
            ? [awareness.blockId]
            : [];
      for (const id of ids) {
        byBlock[id] = [...(byBlock[id] ?? []), awareness];
      }
    }
    return byBlock;
  }, [remoteAwareness]);

  useEffect(() => {
    if (!blocksLoaded && !skipRemoteLoad) void loadBlocks(pageId);
  }, [blocksLoaded, loadBlocks, pageId, skipRemoteLoad]);

  useEffect(() => {
    replayedCollaborationOperationIds.current = new Set();
    collaborationReplayCursor.current = { revision: 0, occurredAt: "", id: "" };
    collaborationReplayInFlight.current = false;
    durableDocumentSyncInFlight.current = false;
    syncedDurableDocumentKeys.current = new Set();
  }, [pageId]);

  const applyRemoteTextUpdate = useCallback(
    (detail: PageTextUpdateReceived) => {
      if (readOnly || templateMode || !detail || detail.pageId !== pageId) return false;
      if (activeEditorTextBlockId(editorRef.current) === detail.blockId) return false;
      const state = useStore.getState();
      const block = state.blocksByPage[pageId]?.find((item) => item.id === detail.blockId);
      if (!block) return false;
      if (detail.operation) {
        const currentPlainText = spansToPlainText(block.content?.rich ?? []);
        if (currentPlainText === detail.operation.afterText) return true;
        const rich = applyTextOperationToSpans(block.content?.rich ?? [], detail.operation);
        if (!rich) return false;
        state.applyRemoteBlockText(detail.blockId, {
          content: { ...block.content, rich },
          plainText: spansToPlainText(rich),
          updatedAt: detail.updatedAt,
        });
        void syncBlockTextRemoteEdit({
          blockId: detail.blockId,
          rich,
          updatedAt: detail.updatedAt ?? new Date().toISOString(),
        }).catch(() => {});
        return true;
      }
      if (block.plainText === detail.plainText) return true;
      state.applyRemoteBlockText(detail.blockId, {
        content: detail.content,
        plainText: detail.plainText,
        updatedAt: detail.updatedAt,
      });
      void syncBlockTextRemoteEdit({
        blockId: detail.blockId,
        rich: detail.content.rich,
        updatedAt: detail.updatedAt ?? new Date().toISOString(),
      }).catch(() => {});
      return true;
    },
    [pageId, readOnly, templateMode],
  );

  // Remote CRDT text queued while the target block is mid-IME-composition
  // (Hangul etc.): applying immediately would rewrite the editable's DOM under
  // the live composition session. Latest payload wins per block; flushed by
  // the document-level compositionend listener below.
  const pendingCompositionRemoteTextRef = useRef(
    new Map<
      string,
      {
        blockId: string;
        plainText: string;
        rich: TextSpan[];
        syncUndoSession?: boolean;
        updatedAt?: string;
      }
    >()
  );

  const applyRemoteCrdtBlockText = useCallback(
    ({
      blockId,
      plainText,
      rich,
      syncUndoSession = true,
      updatedAt,
    }: {
      blockId: string;
      plainText: string;
      rich: TextSpan[];
      syncUndoSession?: boolean;
      updatedAt?: string;
    }) => {
      if (readOnly || templateMode) return false;
      // Defer while the target block is actively composing (BlockItem stamps
      // data-composing on its editable): the queued payload re-applies on
      // compositionend with the same guards, so a stale remote edit that no
      // longer contains the local text is still rejected, not force-applied.
      if (getEditable(blockId)?.dataset.composing === "true") {
        pendingCompositionRemoteTextRef.current.set(blockId, {
          blockId,
          plainText,
          rich,
          syncUndoSession,
          updatedAt,
        });
        return true;
      }
      const state = useStore.getState();
      const block = state.blocksByPage[pageId]?.find((item) => item.id === blockId);
      if (!block) return false;
      if (block.plainText === plainText) {
        // Same plain text but the marks may differ (a remote bold/italic/link).
        // Apply that formatting-only edit so it isn't silently dropped — but
        // only when this block is NOT the active editor and the remote edit
        // isn't stale, so we never disturb the local caret or revert a newer
        // local format. An active block re-syncs on blur/reload.
        const active = activeEditorTextBlockId(editorRef.current) === blockId;
        const localUpdatedAt = Date.parse(block.updatedAt ?? "");
        const incomingUpdatedAt = Date.parse(updatedAt ?? "");
        const remoteIsStale =
          Number.isFinite(localUpdatedAt) &&
          Number.isFinite(incomingUpdatedAt) &&
          incomingUpdatedAt < localUpdatedAt;
        if (!active && !remoteIsStale && !textSpansEqual(block.content?.rich ?? [], rich)) {
          state.applyRemoteBlockText(blockId, {
            content: { ...block.content, rich },
            plainText,
            updatedAt,
          });
        }
        if (!syncUndoSession) return true;
        void syncBlockTextRemoteEdit({
          blockId,
          rich,
          updatedAt: updatedAt ?? block.updatedAt ?? new Date().toISOString(),
        }).catch(() => {});
        return true;
      }

      const blockUpdatedAt = Date.parse(block.updatedAt ?? "");
      const remoteUpdatedAt = Date.parse(updatedAt ?? "");
      if (
        Number.isFinite(blockUpdatedAt) &&
        Number.isFinite(remoteUpdatedAt) &&
        remoteUpdatedAt < blockUpdatedAt
      ) {
        return true;
      }

      const active = activeEditorTextBlockId(editorRef.current) === blockId;
      let selection: { start: number; end: number } | null = null;
      if (active) {
        const editable = getEditable(blockId);
        selection = editable ? selectionOffsetsIn(editable) : null;
        const currentText = spansToPlainText(block.content?.rich ?? []);
        if (currentText && !plainText.includes(currentText)) return false;
      }

      state.applyRemoteBlockText(blockId, {
        content: { ...block.content, rich },
        plainText,
        updatedAt,
      });
      if (syncUndoSession) {
        void syncBlockTextRemoteEdit({
          blockId,
          rich,
          updatedAt: updatedAt ?? new Date().toISOString(),
        }).catch(() => {});
      }

      if (active && selection) {
        const nextLength = plainText.length;
        const start = Math.min(selection.start, nextLength);
        const end = Math.min(selection.end, nextLength);
        window.requestAnimationFrame(() => {
          const editable = getEditable(blockId);
          if (editable) selectEditableRange(editable, start, end);
        });
      }
      return true;
    },
    [pageId, readOnly, templateMode],
  );

  const mergeActiveEditorCrdtConflict = useCallback(
    async ({
      blockId,
      operations,
      updatedAt,
    }: {
      blockId: string;
      operations: unknown[];
      updatedAt?: string;
    }) => {
      if (readOnly || templateMode || activeEditorTextBlockId(editorRef.current) !== blockId) return false;
      const state = useStore.getState();
      const block = state.blocksByPage[pageId]?.find((item) => item.id === blockId);
      if (!block) return false;
      const localRich = cloneTextSpans(block.content?.rich ?? []);
      const localPlainText = spansToPlainText(localRich);
      if (!localPlainText) return false;

      const localUpdate = await createBlockTextCrdtUpdateFromUndoSession({
        blockId,
        rich: localRich,
        updatedAt: block.updatedAt ?? updatedAt ?? new Date().toISOString(),
      });
      // If the block isn't base-safe yet (un-primed grown content) we can't
      // build a shareable local update, so we can't safely merge here — bail
      // without touching the session; the remote text still arrives via the
      // operation-replay path.
      if (!localUpdate) return false;

      // Compute the tentative merge in a THROWAWAY doc first, WITHOUT mutating
      // the live undo session. The old code applied the remote ops into the
      // session before this acceptance check, so a rejected merge (return false)
      // left session.doc/lastRich = merged while the DOM still showed local
      // text — the next minimal-diff keystroke then diffed against the merged
      // state and silently reverted the peer's edit. Previewing keeps the
      // invariant "session state always matches rendered content" on the bail.
      const preview = await mergeBlockTextCrdtUpdates([localUpdate, ...operations], blockId);
      if (!preview || !preview.plainText.includes(localPlainText)) return false;

      // Accepted: now commit the merge into the live session and the DOM.
      const sessionMerged = await applyBlockTextRemoteCrdtUpdatesToUndoSession({
        blockId,
        fallbackRich: localRich,
        operations,
        updatedAt: updatedAt ?? block.updatedAt ?? new Date().toISOString(),
      });
      const merged = sessionMerged ?? preview;
      return applyRemoteCrdtBlockText({
        blockId,
        plainText: merged.plainText,
        rich: merged.rich,
        syncUndoSession: !sessionMerged,
        updatedAt: merged.updatedAt ?? updatedAt,
      });
    },
    [applyRemoteCrdtBlockText, pageId, readOnly, templateMode],
  );

  const applyRemoteCrdtUpdateWithActiveMerge = useCallback(
    async (detail: {
      blockId: string;
      operation: unknown;
      pageId: string;
      receivedAt: number;
      revision?: number;
      updatedAt?: string;
      userId: string;
    }) => {
      if (readOnly || templateMode || !detail || detail.pageId !== pageId) return false;
      const snapshot = await readBlockTextCrdtUpdate(detail.operation, detail.blockId);
      if (!snapshot) return true;
      const applied = applyRemoteCrdtBlockText({
        blockId: detail.blockId,
        plainText: snapshot.plainText,
        rich: snapshot.rich,
        updatedAt: snapshot.updatedAt ?? detail.updatedAt,
      });
      if (applied) return true;
      return mergeActiveEditorCrdtConflict({
        blockId: detail.blockId,
        operations: [detail.operation],
        updatedAt: snapshot.updatedAt ?? detail.updatedAt,
      });
    },
    [applyRemoteCrdtBlockText, mergeActiveEditorCrdtConflict, pageId, readOnly, templateMode],
  );

  const applyMergedRemoteCrdtUpdates = useCallback(
    async ({
      blockId,
      operations,
      updatedAt,
    }: {
      blockId: string;
      operations: unknown[];
      updatedAt?: string;
    }) => {
      if (readOnly || templateMode || operations.length === 0) return false;
      const merged = await mergeBlockTextCrdtUpdates(operations, blockId);
      if (!merged) return true;
      const applied = applyRemoteCrdtBlockText({
        blockId,
        plainText: merged.plainText,
        rich: merged.rich,
        updatedAt: merged.updatedAt ?? updatedAt,
      });
      if (applied) return true;
      return mergeActiveEditorCrdtConflict({
        blockId,
        operations,
        updatedAt: merged.updatedAt ?? updatedAt,
      });
    },
    [applyRemoteCrdtBlockText, mergeActiveEditorCrdtConflict, readOnly, templateMode],
  );

  // Flush remote CRDT text that was queued while its block was composing.
  // Deferred by a tick so the browser commits the composed text (and
  // BlockItem's own compositionend handlers run) before the re-apply, which
  // then goes through applyRemoteCrdtBlockText's normal guards.
  useEffect(() => {
    function flushPendingCompositionRemoteText() {
      if (pendingCompositionRemoteTextRef.current.size === 0) return;
      window.setTimeout(() => {
        const pending = Array.from(pendingCompositionRemoteTextRef.current.values());
        pendingCompositionRemoteTextRef.current.clear();
        for (const payload of pending) applyRemoteCrdtBlockText(payload);
      }, 0);
    }
    document.addEventListener("compositionend", flushPendingCompositionRemoteText, true);
    return () =>
      document.removeEventListener("compositionend", flushPendingCompositionRemoteText, true);
  }, [applyRemoteCrdtBlockText]);

  useEffect(() => {
    if (readOnly || templateMode || skipRemoteLoad || !blocksLoaded) return;
    let cancelled = false;

    async function resyncDurableCrdtDocuments() {
      if (durableDocumentSyncInFlight.current) return;
      durableDocumentSyncInFlight.current = true;
      try {
        const state = useStore.getState();
        // Prime EVERY text block, not just the first N. The old 120-block cap
        // was a correctness boundary: any text block past it (or edited before
        // this resync ran) would seed its CRDT session from grown content with
        // no durable base to prove it was the shared origin, reintroducing the
        // H1 duplication. We now fetch all text blocks in batches and record
        // both the blocks that HAVE a durable document and those that don't (so
        // seeding a genuinely never-collaborated block stays safe-by-construction).
        const candidates = (state.blocksByPage[pageId] ?? []).filter((block) =>
          TEXT_BLOCKS.has(block.type),
        );
        if (candidates.length === 0) return;

        const candidateIds = new Set(candidates.map((block) => block.id));
        const returnedBlockIds = new Set<string>();
        const allCandidateIds = Array.from(candidateIds);

        for (let offset = 0; offset < allCandidateIds.length; offset += DURABLE_CRDT_RESYNC_BATCH_SIZE) {
          if (cancelled) return;
          const batchIds = allCandidateIds.slice(offset, offset + DURABLE_CRDT_RESYNC_BATCH_SIZE);
          const documents = await listCollaborationDocumentsRemote({
            pageId,
            blockIds: batchIds,
            limit: DURABLE_CRDT_RESYNC_BATCH_SIZE,
            repair: "auto",
          });
          if (cancelled) return;

          for (const documentState of documents) {
          if (cancelled) return;
          if (
            documentState.engine !== "yjs" ||
            !documentState.blockId ||
            !candidateIds.has(documentState.blockId) ||
            typeof documentState.stateBase64 !== "string"
          ) {
            continue;
          }
          returnedBlockIds.add(documentState.blockId);
          // Prime the block-text session cache with the authoritative durable
          // state so a subsequent local edit hydrates its CRDT session from the
          // real shared base instead of re-seeding grown content (H1 duplication).
          rememberBlockTextDurableState(documentState.blockId, documentState.stateBase64);
          const syncKey = [
            documentState.documentId,
            documentState.updatedAt,
            documentState.lastOperationId ?? "",
            documentState.updateCount ?? 0,
          ].join(":");
          if (syncedDurableDocumentKeys.current.has(syncKey)) continue;

          const snapshot = await readBlockTextCrdtDocumentState(
            documentState.stateBase64,
            documentState.blockId,
          );
          if (!snapshot) {
            syncedDurableDocumentKeys.current.add(syncKey);
            continue;
          }
          let applied = applyRemoteCrdtBlockText({
            blockId: documentState.blockId,
            plainText: snapshot.plainText,
            rich: snapshot.rich,
            updatedAt: snapshot.updatedAt ?? documentState.updatedAt,
          });
          if (!applied) {
            applied = await mergeActiveEditorCrdtConflict({
              blockId: documentState.blockId,
              operations: [
                {
                  engine: "yjs",
                  updateBase64: documentState.stateBase64,
                },
              ],
              updatedAt: snapshot.updatedAt ?? documentState.updatedAt,
            });
          }
          if (applied) {
            syncedDurableDocumentKeys.current.add(syncKey);
            const cursor = collaborationDocumentCursor(documentState);
            if (cursor) durableCrdtReplayCursors.current.set(documentState.blockId, cursor);
          }
          }
        }

        // Every candidate the server did NOT return a durable document for has
        // never been collaborated on — mark it pristine so seeding its content
        // under the reserved base clientID stays safe-by-construction.
        for (const blockId of candidateIds) {
          if (!returnedBlockIds.has(blockId)) markBlockTextCollaborationPristine(blockId);
        }
      } catch {
        // Durable state resync is a recovery path; operation replay still runs below.
      } finally {
        durableDocumentSyncInFlight.current = false;
      }
    }

    void resyncDurableCrdtDocuments();

    function resyncSoon() {
      void resyncDurableCrdtDocuments();
    }

    window.addEventListener("focus", resyncSoon);
    window.addEventListener("online", resyncSoon);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", resyncSoon);
      window.removeEventListener("online", resyncSoon);
    };
  }, [
    applyRemoteCrdtBlockText,
    mergeActiveEditorCrdtConflict,
    blocks.length,
    blocksLoaded,
    pageId,
    readOnly,
    skipRemoteLoad,
    templateMode,
  ]);

  useEffect(() => {
    if (readOnly || templateMode) return;
    function onRemoteTextUpdate(event: Event) {
      const detail = (event as CustomEvent<PageTextUpdateReceived>).detail;
      if (detail) applyRemoteTextUpdate(detail);
    }
    window.addEventListener(PAGE_TEXT_UPDATE_RECEIVED_EVENT, onRemoteTextUpdate);
    return () => window.removeEventListener(PAGE_TEXT_UPDATE_RECEIVED_EVENT, onRemoteTextUpdate);
  }, [applyRemoteTextUpdate, readOnly, templateMode]);

  useEffect(() => {
    if (readOnly || templateMode) return;
    function onRemoteCrdtUpdate(event: Event) {
      const detail = (event as CustomEvent<PageCrdtUpdateReceived>).detail;
      if (detail) void applyRemoteCrdtUpdateWithActiveMerge(detail).catch(() => {});
    }
    window.addEventListener(PAGE_CRDT_UPDATE_RECEIVED_EVENT, onRemoteCrdtUpdate);
    return () => window.removeEventListener(PAGE_CRDT_UPDATE_RECEIVED_EVENT, onRemoteCrdtUpdate);
  }, [applyRemoteCrdtUpdateWithActiveMerge, readOnly, templateMode]);

  useEffect(() => {
    if (readOnly || templateMode || skipRemoteLoad || !blocksLoaded) return;
    let cancelled = false;

    async function replayCollaborationOperations() {
      if (collaborationReplayInFlight.current) return;
      collaborationReplayInFlight.current = true;
      try {
        for (let page = 0; page < 20; page += 1) {
          const cursor = collaborationReplayCursor.current;
          const operations = await listCollaborationOperationsRemote({
            pageId,
            afterId: cursor.id,
            afterOccurredAt: cursor.occurredAt,
            afterRevision: cursor.revision,
            limit: 200,
          });
          if (cancelled || operations.length === 0) return;
          let nextCursor = cursor;
          let pendingCrdtBatch: PendingCrdtReplayBatch | null = null;
          const flushPendingCrdtBatch = async () => {
            if (!pendingCrdtBatch) return true;
            const batch = pendingCrdtBatch;
            const recordsByBlock = new Map<
              string,
              { records: CollaborationOperationRecord[]; updatedAt?: string }
            >();
            for (const record of batch.records) {
              if (!record.blockId) continue;
              const current = recordsByBlock.get(record.blockId) ?? { records: [] };
              current.records.push(record);
              current.updatedAt = record.occurredAt || current.updatedAt;
              recordsByBlock.set(record.blockId, current);
            }
            for (const [blockId, group] of recordsByBlock) {
              const durableCursor = durableCrdtReplayCursors.current.get(blockId);
              const records = durableCursor
                ? group.records.filter((record) =>
                    collaborationCursorIsAfter(collaborationRecordCursor(record), durableCursor)
                  )
                : group.records;
              if (records.length === 0) continue;
              const applied = await applyMergedRemoteCrdtUpdates({
                blockId,
                operations: records.map((record) => record.operation),
                updatedAt: group.updatedAt ?? batch.afterCursor.occurredAt,
              });
              if (!applied) {
                collaborationReplayCursor.current = batch.beforeCursor;
                return false;
              }
            }
            for (const record of batch.records) {
              replayedCollaborationOperationIds.current.add(record.id);
            }
            nextCursor = batch.afterCursor;
            pendingCrdtBatch = null;
            return true;
          };
          for (const record of operations) {
            if (cancelled) return;
            const recordCursor = collaborationRecordCursor(record);
            // Structure operations (indent/move/create/delete/restore) carry
            // block snapshots, not text spans — and create/delete records have
            // no blockId — so handle them before the blockId guard below.
            // Previously they fell through to sanitizeTextSpanOperation and
            // were silently dropped, leaving remote structure changes
            // invisible until a full reload.
            if (record.kind === "block_structure") {
              if (!(await flushPendingCrdtBatch())) return;
              if (!replayedCollaborationOperationIds.current.has(record.id)) {
                const structure = sanitizeBlockStructureOperation(record.operation);
                if (structure) {
                  useStore.getState().applyRemoteBlockStructure(pageId, structure);
                }
                replayedCollaborationOperationIds.current.add(record.id);
              }
              nextCursor = recordCursor;
              continue;
            }
            if (!record.blockId || replayedCollaborationOperationIds.current.has(record.id)) {
              if (!(await flushPendingCrdtBatch())) return;
              nextCursor = recordCursor;
              continue;
            }
            if (record.kind === "crdt_update") {
              if (!pendingCrdtBatch) {
                pendingCrdtBatch = {
                  afterCursor: recordCursor,
                  beforeCursor: nextCursor,
                  records: [],
                };
              }
              pendingCrdtBatch.records.push(record);
              pendingCrdtBatch.afterCursor = recordCursor;
              continue;
            }
            if (!(await flushPendingCrdtBatch())) return;
            const operation = sanitizeTextSpanOperation(record.operation);
            if (!operation) {
              replayedCollaborationOperationIds.current.add(record.id);
              nextCursor = recordCursor;
              continue;
            }
            const applied = applyRemoteTextUpdate({
              blockId: record.blockId,
              color: undefined,
              content: { rich: operation.insert },
              label: undefined,
              memberId: undefined,
              operation,
              pageId,
              plainText: record.afterText ?? operation.afterText,
              receivedAt: Date.now(),
              revision: record.revision,
              updatedAt: record.occurredAt,
              userId: record.actorId ?? record.clientId,
            });
            if (!applied) {
              collaborationReplayCursor.current = nextCursor;
              return;
            }
            replayedCollaborationOperationIds.current.add(record.id);
            nextCursor = recordCursor;
          }
          if (!(await flushPendingCrdtBatch())) return;
          collaborationReplayCursor.current = nextCursor;
          if (operations.length < 200) return;
        }
      } finally {
        collaborationReplayInFlight.current = false;
      }
    }

    void replayCollaborationOperations().catch(() => {});
    if (collaborationStatus !== "connected") return () => {
      cancelled = true;
    };

    function replaySoon() {
      void replayCollaborationOperations().catch(() => {});
    }

    window.addEventListener("focus", replaySoon);
    window.addEventListener("online", replaySoon);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", replaySoon);
      window.removeEventListener("online", replaySoon);
    };
  }, [
    applyMergedRemoteCrdtUpdates,
    applyRemoteTextUpdate,
    blocksLoaded,
    collaborationStatus,
    pageId,
    readOnly,
    skipRemoteLoad,
    templateMode,
  ]);

  useEffect(() => {
    if (readOnly || templateMode || selectedBlockIds.size === 0) return;
    const selectedIds = Array.from(selectedBlockIds);
    publishEditorAwareness(
      selectedBlockId ?? selectedIds[0],
      selectedIds.length > 1 ? "selecting" : "editing",
      selectedIds,
    );
  }, [publishEditorAwareness, readOnly, selectedBlockId, selectedBlockIds, templateMode]);

  // Ensure a fresh page always has one editable paragraph.
  useEffect(() => {
    const st = useStore.getState();
    if (
      !readOnly &&
      blocksLoaded &&
      st.topLevelBlocks(pageId).length === 0 &&
      ensured.current !== pageId
    ) {
      ensured.current = pageId;
      void st.createBlock({ pageId, position: 1 });
    }
  }, [blocks.length, blocksLoaded, pageId, readOnly]);

  function applyBlockTextUndoResult(blockId: string, result: BlockTextUndoResult) {
    const st = useStore.getState();
    const block = st.blocksByPage[pageId]?.find((item) => item.id === blockId);
    if (!block) return;

    const beforeSpans = cloneTextSpans(block.content?.rich ?? []);
    const operation = createTextOperation(beforeSpans, result.rich);
    const revision = Date.now();
    const editable = getEditable(blockId);
    const selection = editable ? selectionOffsetsIn(editable) : null;

    st.updateBlock(
      blockId,
      {
        content: { ...block.content, rich: result.rich },
        plainText: result.plainText,
        updatedAt: result.updatedAt,
      },
      { debounce: true, history: false }
    );

    if (!templateMode) {
      publishPageTextUpdate({
        blockId,
        content: { rich: result.rich },
        operation,
        pageId,
        plainText: result.plainText,
        revision,
        updatedAt: result.updatedAt,
      });
      publishPageCrdtUpdate({
        blockId,
        operation: result.operation,
        pageId,
        revision,
        updatedAt: result.updatedAt,
      });

      void recordCollaborationOperationRemote({
        afterText: operation?.afterText ?? result.plainText,
        beforeText: operation?.beforeText ?? spansToPlainText(beforeSpans),
        blockId,
        kind: operation ? "text" : "text_snapshot",
        operation,
        pageId,
        revision,
        occurredAt: result.updatedAt,
      }).catch(() => {});
      void recordCollaborationOperationRemote({
        blockId,
        kind: "crdt_update",
        operation: result.operation,
        pageId,
        revision,
        occurredAt: result.updatedAt,
      }).catch(() => {});
    }

    const nextOffset = Math.min(selection?.start ?? result.plainText.length, result.plainText.length);
    window.requestAnimationFrame(() => {
      const nextEditable = getEditable(blockId);
      if (!nextEditable) return;
      nextEditable.focus();
      selectEditableRange(nextEditable, nextOffset, nextOffset);
    });
  }

  async function applyTextUndoOrRedo(blockId: string, mode: "redo" | "undo") {
    const result =
      mode === "redo"
        ? await redoBlockTextLocalEdit(blockId)
        : await undoBlockTextLocalEdit(blockId);
    if (!result) return false;
    applyBlockTextUndoResult(blockId, result);
    return true;
  }

  // The keydown listener below is a document-level subscription that must not
  // re-register on every render. It only needs to invoke the latest
  // applyTextUndoOrRedo at fire time, so keep it in a ref refreshed each render.
  const applyTextUndoOrRedoRef = useRef(applyTextUndoOrRedo);
  useEffect(() => {
    applyTextUndoOrRedoRef.current = applyTextUndoOrRedo;
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (readOnly) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      const target = e.target as HTMLElement | null;
      if (!target?.closest(`[data-editor-page="${pageId}"]`)) return;

      if (e.altKey && !e.shiftKey && key === "t") {
        const st = useStore.getState();
        const toggles = (st.blocksByPage[pageId] ?? []).filter((block) =>
          TOGGLE_BLOCKS.has(block.type)
        );
        if (toggles.length === 0) return;
        const collapsed = toggles.some((block) => !block.content?.collapsed);
        const targets = toggles.filter((block) => !!block.content?.collapsed !== collapsed);
        if (targets.length === 0) return;
        e.preventDefault();
        st.captureBlockHistory(pageId);
        for (const block of targets) {
          st.updateBlock(
            block.id,
            { content: { ...block.content, collapsed } },
            { history: false }
          );
        }
        return;
      }

      if (e.altKey) return;
      if (key !== "z" && key !== "y") return;
      e.preventDefault();
      const mode = key === "y" || (key === "z" && e.shiftKey) ? "redo" : "undo";
      const blockId = activeEditorTextBlockId(editorRef.current);
      void (async () => {
        if (blockId && (await applyTextUndoOrRedoRef.current(blockId, mode))) return;
        if (mode === "redo") await redoBlockChange(pageId);
        else await undoBlockChange(pageId);
      })();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pageId, readOnly, redoBlockChange, undoBlockChange]);

  // Detach any lingering rubber-band listeners if the editor unmounts mid-drag.
  useEffect(() => () => detachDragRef.current?.(), []);

  function siblings(parentId: string | null | undefined): Block[] {
    const normalized = parentId ?? null;
    return (useStore.getState().blocksByPage[pageId] ?? [])
      .filter((b) => (b.parentId ?? null) === normalized)
      .sort((a, b) => a.position - b.position);
  }

  function blockById(id: string): Block | undefined {
    return (useStore.getState().blocksByPage[pageId] ?? []).find((b) => b.id === id);
  }

  function visibleOrder(parentId: string | null = null): Block[] {
    const out: Block[] = [];
    for (const b of siblings(parentId)) {
      if (!STRUCTURAL_BLOCKS.has(b.type)) out.push(b);
      if (!(TOGGLE_BLOCKS.has(b.type) && b.content?.collapsed)) {
        out.push(...visibleOrder(b.id));
      }
    }
    return out;
  }

  function flushPendingCollaborationTextLog(blockId: string) {
    if (templateMode) return;
    const pending = pendingCollaborationTextLogs.current.get(blockId);
    if (!pending) return;
    if (pending.timer) window.clearTimeout(pending.timer);
    pendingCollaborationTextLogs.current.delete(blockId);

    const operation = createTextOperation(pending.beforeSpans, pending.latestSpans);
    const spansChanged =
      JSON.stringify(pending.beforeSpans) !== JSON.stringify(pending.latestSpans);
    if (!operation && !spansChanged) return;

    const plainText = spansToPlainText(pending.latestSpans);
    void recordCollaborationOperationRemote({
      afterText: operation?.afterText ?? plainText,
      beforeText: operation?.beforeText ?? spansToPlainText(pending.beforeSpans),
      blockId,
      kind: operation ? "text" : "text_snapshot",
      operation,
      pageId,
      revision: pending.revision,
      occurredAt: pending.updatedAt,
    }).catch(() => {});

    void createBlockTextCrdtUpdateFromUndoSession({
      blockId,
      rich: pending.latestSpans,
      updatedAt: pending.updatedAt,
    })
      .then((crdtUpdate) => {
        // undefined => the block isn't base-safe yet (un-primed grown content).
        // Skip the CRDT publish/record to avoid propagating a base-clientID copy
        // that would duplicate on merge (H1). The plain-text operation recorded
        // above still carries the edit; once primed, a later edit encodes CRDT.
        if (!crdtUpdate) return;
        publishPageCrdtUpdate({
          blockId,
          operation: crdtUpdate,
          pageId,
          revision: pending.revision,
          updatedAt: pending.updatedAt,
        });
        return recordCollaborationOperationRemote({
          blockId,
          kind: "crdt_update",
          operation: crdtUpdate,
          pageId,
          revision: pending.revision,
          occurredAt: pending.updatedAt,
        });
      })
      .catch(() => {});
  }

  function flushPendingCollaborationTextLogs() {
    for (const blockId of Array.from(pendingCollaborationTextLogs.current.keys())) {
      flushPendingCollaborationTextLog(blockId);
    }
  }

  // The effect below only flushes on pageId change / unmount (via its cleanup),
  // so it must not re-run on every render. Read the latest flush closure through
  // a ref instead of listing the per-render function as a dependency.
  const flushPendingCollaborationTextLogsRef = useRef(flushPendingCollaborationTextLogs);
  useEffect(() => {
    flushPendingCollaborationTextLogsRef.current = flushPendingCollaborationTextLogs;
  });

  function queueCollaborationTextLog(
    blockId: string,
    beforeSpans: TextSpan[],
    latestSpans: TextSpan[],
    updatedAt: string,
    revision: number
  ) {
    const pending = pendingCollaborationTextLogs.current.get(blockId);
    if (pending?.timer) window.clearTimeout(pending.timer);
    const next: PendingCollaborationTextLog = {
      beforeSpans: pending?.beforeSpans ?? cloneTextSpans(beforeSpans),
      latestSpans: cloneTextSpans(latestSpans),
      revision,
      updatedAt,
    };
    next.timer = window.setTimeout(
      () => flushPendingCollaborationTextLog(blockId),
      COLLABORATION_LOG_DEBOUNCE_MS
    );
    pendingCollaborationTextLogs.current.set(blockId, next);
  }

  useEffect(() => () => flushPendingCollaborationTextLogsRef.current(), [pageId]);

  useEffect(() => {
    function onSelectionRequest(event: Event) {
      if (readOnly) return;
      const detail = (event as CustomEvent<{ pageId?: string; mode?: "first" | "all" }>).detail;
      if (detail?.pageId !== pageId) return;

      const allBlocks = useStore.getState().blocksByPage[pageId] ?? [];
      const blocksByParent = new Map<string, Block[]>();
      for (const block of allBlocks) {
        const key = block.parentId ?? "";
        blocksByParent.set(key, [...(blocksByParent.get(key) ?? []), block]);
      }
      const ordered: Block[] = [];
      function collect(parentId: string | null = null) {
        const children = (blocksByParent.get(parentId ?? "") ?? [])
          .slice()
          .sort((a, b) => a.position - b.position);
        for (const child of children) {
          if (!STRUCTURAL_BLOCKS.has(child.type)) ordered.push(child);
          if (!(TOGGLE_BLOCKS.has(child.type) && child.content?.collapsed)) collect(child.id);
        }
      }
      collect();
      if (ordered.length === 0) return;

      const ids = detail?.mode === "all" ? ordered.map((block) => block.id) : [ordered[0].id];
      const anchor = ids[0];
      setSelectedBlockIdState(anchor);
      setSelectedBlockIds(new Set(ids));
      selectionFocusRef.current = ids[ids.length - 1] ?? anchor;
    }

    document.addEventListener(EDITOR_SELECTION_REQUEST, onSelectionRequest);
    return () => document.removeEventListener(EDITOR_SELECTION_REQUEST, onSelectionRequest);
  }, [pageId, readOnly]);

  useEffect(() => {
    function onStarterDismissRequest(event: Event) {
      if (!pagePlaceholderBlockId) return;
      const detail = (event as CustomEvent<PageStarterDismissDetail>).detail;
      if (detail?.pageId !== pageId) return;
      if (detail.blockId && detail.blockId !== pagePlaceholderBlockId) return;
      consumePendingPageStarterDismiss(pageId, pagePlaceholderBlockId);
      setDismissedStarterBlockId(pagePlaceholderBlockId);
    }

    document.addEventListener(PAGE_STARTER_DISMISS_REQUEST, onStarterDismissRequest);
    if (
      pagePlaceholderBlockId &&
      consumePendingPageStarterDismiss(pageId, pagePlaceholderBlockId)
    ) {
      document.dispatchEvent(
        new CustomEvent<PageStarterDismissDetail>(PAGE_STARTER_DISMISS_REQUEST, {
          detail: { pageId, blockId: pagePlaceholderBlockId },
        })
      );
    }
    return () => document.removeEventListener(PAGE_STARTER_DISMISS_REQUEST, onStarterDismissRequest);
  }, [pageId, pagePlaceholderBlockId]);

  function selectedIdsFor(id: string) {
    return selectedBlockIds.has(id) ? selectedBlockIds : new Set([id]);
  }

  function hasSelectedAncestor(block: Block, selectedIds: Set<string>) {
    let parentId = block.parentId ?? null;
    while (parentId) {
      if (selectedIds.has(parentId)) return true;
      parentId = blockById(parentId)?.parentId ?? null;
    }
    return false;
  }

  function selectedBlocksFor(id: string) {
    const selectedIds = selectedIdsFor(id);
    const selected = visibleOrder().filter((block) => selectedIds.has(block.id));
    if (selected.length > 0) return selected;
    const fallback = blockById(id);
    return fallback ? [fallback] : [];
  }

  function selectedRootBlocksFor(id: string) {
    const selectedIds = selectedIdsFor(id);
    return selectedBlocksFor(id).filter((block) => !hasSelectedAncestor(block, selectedIds));
  }

  function preserveBlockSelection(ids: string[], anchorId = selectedBlockId) {
    if (ids.length === 0) return setSelectedBlockId(null);
    const nextAnchor = anchorId && ids.includes(anchorId) ? anchorId : ids[0];
    setSelectedBlockIdState(nextAnchor);
    setSelectedBlockIds(new Set(ids));
    selectionFocusRef.current = ids[ids.length - 1] ?? nextAnchor;
  }

  function parentGroups(blocks: Block[]) {
    const groups = new Map<string, Block[]>();
    for (const block of blocks) {
      const key = block.parentId ?? "";
      groups.set(key, [...(groups.get(key) ?? []), block]);
    }
    return Array.from(groups.values());
  }

  function selectedSiblingSegments(list: Block[], selectedIds: Set<string>) {
    const segments: { start: number; end: number; blocks: Block[] }[] = [];
    let current: { start: number; blocks: Block[] } | null = null;

    for (let index = 0; index < list.length; index++) {
      const block = list[index];
      if (!selectedIds.has(block.id)) {
        if (current) {
          segments.push({
            start: current.start,
            end: index - 1,
            blocks: current.blocks,
          });
          current = null;
        }
        continue;
      }
      if (!current) current = { start: index, blocks: [] };
      current.blocks.push(block);
    }

    if (current) {
      segments.push({
        start: current.start,
        end: list.length - 1,
        blocks: current.blocks,
      });
    }

    return segments;
  }

  function captureStructureMove(
    st: ReturnType<typeof useStore.getState>,
    block: Block,
    action: "move" | "indent" | "outdent",
    parentId: string | null,
    position: number
  ) {
    st.captureBlockStructureHistory(pageId, {
      action,
      blockIds: [block.id],
      before: [block],
      after: [{ ...block, parentId, position, updatedAt: new Date().toISOString() }],
    });
  }

  function moveBlockWithinSiblings(id: string, direction: "up" | "down", captureHistory = true) {
    const st = useStore.getState();
    const cur = blockById(id);
    if (!cur) return false;
    const list = siblings(cur.parentId);
    const index = list.findIndex((block) => block.id === id);
    if (direction === "up") {
      if (index <= 0) return false;
      const previous = list[index - 1];
      const beforePrevious = list[index - 2];
      const position = positionBetween(beforePrevious?.position, previous.position);
      if (captureHistory) captureStructureMove(st, cur, "move", cur.parentId ?? null, position);
      st.updateBlock(
        id,
        { position },
        { history: false }
      );
      return true;
    }

    if (index < 0 || index >= list.length - 1) return false;
    const next = list[index + 1];
    const afterNext = list[index + 2];
    const position = positionBetween(next.position, afterNext?.position);
    if (captureHistory) captureStructureMove(st, cur, "move", cur.parentId ?? null, position);
    st.updateBlock(
      id,
      { position },
      { history: false }
    );
    return true;
  }

  function clearsContentOnType(type: BlockType) {
    return (
      type === "divider" ||
      type === "equation" ||
      type === "table_of_contents" ||
      type === "synced_block" ||
      type === "button" ||
      type === "tab" ||
      type === "breadcrumb" ||
      type === "inline_database" ||
      type === "simple_table" ||
      type === "link_to_page" ||
      type === "embed" ||
      type === "file" ||
      type === "video" ||
      type === "audio" ||
      type === "column_list" ||
      type === "column"
    );
  }

  function blockTypePatch(id: string, type: BlockType): Partial<Block> {
    const patch: Partial<Block> = { type };
    const cur = blockById(id);
    if (clearsContentOnType(type)) {
      patch.content = { rich: [] };
      patch.plainText = "";
    } else if (cur) {
      const content = textBlockContentFrom(cur);
      if (type === "to_do") content.checked = false;
      if (type === "callout") content.icon = cur.content?.icon ?? "💡";
      patch.content = content;
      patch.plainText = spansToPlainText(content.rich);
    }
    return patch;
  }

  function spansWithText(spans: TextSpan[] | undefined) {
    return (spans ?? []).filter((span) => span.text.length > 0);
  }

  function blockControlFocusSelector(id: string, type: BlockType) {
    const block = blockById(id);
    const captionVisible =
      block?.content?.showCaption === true || spansToPlainText(block?.content?.caption).length > 0;
    if (type === "simple_table") return `[data-table-cell="${id}:0:0"]`;
    if (type === "equation") return `textarea[data-equation-input="${id}"]`;
    if (type === "image") {
      if (!block?.content?.url) return '[data-block-control="image-link"]';
      return captionVisible ? '[data-block-control="image-caption"]' : null;
    }
    if (type === "video") {
      if (!block?.content?.url) return '[data-block-control="video-link"]';
      return captionVisible ? '[data-block-control="video-caption"]' : null;
    }
    if (type === "audio") {
      if (!block?.content?.url) return '[data-block-control="audio-link"]';
      return captionVisible ? '[data-block-control="audio-caption"]' : null;
    }
    if (type === "bookmark") return block?.content?.url ? null : '[data-block-control="bookmark-link"]';
    if (type === "embed") {
      if (!block?.content?.url) return '[data-block-control="embed-link"]';
      return captionVisible ? '[data-block-control="embed-caption"]' : null;
    }
    if (type === "file") {
      if (!block?.content?.url) return '[data-block-control="file-link"]';
      return captionVisible ? '[data-block-control="file-caption"]' : null;
    }
    return null;
  }

  function focusBlockWritingTarget(
    id: string,
    type: BlockType,
    caret: "start" | "end" | number = "end"
  ) {
    if (TEXT_BLOCKS.has(type)) {
      setSelectedBlockId(null);
      focusEditableSettled(id, caret);
      return true;
    }
    const selector = blockControlFocusSelector(id, type);
    if (selector) {
      setSelectedBlockId(null);
      focusBlockControlSettled(id, selector);
      return true;
    }
    return false;
  }

  function focusOrSelectBlock(id: string, type: BlockType, caret: "start" | "end" | number = "end") {
    if (!focusBlockWritingTarget(id, type, caret)) setSelectedBlockId(id);
  }

  function focusAfterMove(id: string) {
    const block = blockById(id);
    if (block) focusOrSelectBlock(id, block.type, "end");
    else requestAnimationFrame(() => focusEditable(id, "end"));
  }

  function focusAfterTypeChange(id: string, caret: "start" | "end" | number) {
    const block = blockById(id);
    focusOrSelectBlock(id, block?.type ?? "paragraph", caret);
  }

  function focusEditableAfterLayout(id: string, caret: "start" | "end" | number = "start") {
    requestAnimationFrame(() => focusEditableSettled(id, caret));
  }

  function isFinalChild(blockId: string, parentId: string) {
    const currentLevel = siblings(parentId);
    const currentIndex = currentLevel.findIndex((block) => block.id === blockId);
    return currentIndex >= 0 && currentIndex === currentLevel.length - 1;
  }

  function emptyEnterCanEscapeParent(parent: Block) {
    return CONTAINER_BLOCKS.has(parent.type) && parent.type !== "tab";
  }

  function moveBlockAfterParent(
    st: ReturnType<typeof useStore.getState>,
    block: Block,
    parent: Block,
    patch: Partial<Block>
  ) {
    const parentList = siblings(parent.parentId);
    const parentIndex = parentList.findIndex((candidate) => candidate.id === parent.id);
    const nextAfterParent = parentList[parentIndex + 1];
    st.captureBlockHistory(pageId);
    flushSync(() => {
      st.updateBlock(
        block.id,
        {
          ...patch,
          parentId: parent.parentId ?? null,
          position: positionBetween(parent.position, nextAfterParent?.position),
        },
        { history: false }
      );
    });
    focusEditableAfterLayout(block.id, "start");
  }

  function convertEmptyBlockToParagraph(
    st: ReturnType<typeof useStore.getState>,
    block: Block
  ) {
    flushSync(() => {
      st.updateBlock(block.id, {
        type: "paragraph",
        content: emptyParagraphContent(block.content),
        plainText: "",
      });
    });
    focusEditableAfterLayout(block.id, "start");
  }

  function expandToggleForChildInsertion(
    st: ReturnType<typeof useStore.getState>,
    target: Block | undefined
  ) {
    if (!target || !TOGGLE_BLOCKS.has(target.type) || !target.content?.collapsed) return;
    st.updateBlock(
      target.id,
      { content: { ...target.content, collapsed: false } },
      { history: false }
    );
  }

  function pastedContent(spec: PastedBlock): BlockContent {
    return cloneContent(spec.content ?? { rich: [] });
  }

  function pastedPlainText(spec: PastedBlock) {
    return spec.plainText ?? spansToPlainText(spec.content?.rich);
  }

  function selectAdjacentBlock(id: string, direction: "up" | "down") {
    const list = visibleOrder();
    const index = list.findIndex((block) => block.id === id);
    if (selectedBlockIds.size > 1) {
      const selectedIndexes = list
        .map((block, blockIndex) => (selectedBlockIds.has(block.id) ? blockIndex : -1))
        .filter((blockIndex) => blockIndex >= 0);
      if (selectedIndexes.length === 0) return;
      const firstIndex = selectedIndexes[0];
      const lastIndex = selectedIndexes[selectedIndexes.length - 1];
      const targetIndex =
        direction === "up"
          ? Math.max(0, firstIndex - 1)
          : Math.min(list.length - 1, lastIndex + 1);
      const target = list[targetIndex];
      if (target) setSelectedBlockId(target.id);
      return;
    }
    if (index < 0) return;
    const next = list[index + (direction === "up" ? -1 : 1)];
    if (next) setSelectedBlockId(next.id);
  }

  function selectEdgeBlock(edge: "first" | "last") {
    const list = visibleOrder();
    const next = edge === "first" ? list[0] : list.at(-1);
    if (next) setSelectedBlockId(next.id);
  }

  function selectAllBlocks(anchorId?: string) {
    const list = visibleOrder();
    if (list.length === 0) return;
    const ids = list.map((block) => block.id);
    const anchor = anchorId && ids.includes(anchorId) ? anchorId : ids[0];
    setSelectedBlockIdState(anchor);
    setSelectedBlockIds(new Set(ids));
    selectionFocusRef.current = ids[ids.length - 1] ?? anchor;
  }

  // Extend the multi-selection up/down across visibleOrder(). The anchor stays
  // fixed; the moving endpoint (selectionFocusRef) advances one block each press,
  // so repeated Shift+Arrow grows/shrinks the range past two blocks.
  function extendSelection(id: string, direction: "up" | "down") {
    const list = visibleOrder();
    const anchorId = selectedBlockId ?? id;
    const anchorIdx = list.findIndex((b) => b.id === anchorId);
    const focusId = selectionFocusRef.current ?? anchorId;
    const focusIdx = list.findIndex((b) => b.id === focusId);
    if (anchorIdx < 0 || focusIdx < 0) return;
    const targetIdx = focusIdx + (direction === "up" ? -1 : 1);
    if (targetIdx < 0 || targetIdx >= list.length) return;
    // Build the contiguous range between the fixed anchor and the new endpoint.
    const lo = Math.min(anchorIdx, targetIdx);
    const hi = Math.max(anchorIdx, targetIdx);
    const range = new Set<string>();
    for (let i = lo; i <= hi; i++) range.add(list[i].id);
    selectionFocusRef.current = list[targetIdx].id;
    setSelectedBlockIdState(anchorId);
    setSelectedBlockIds(range);
  }

  function extendSelectionToEdge(id: string, edge: "first" | "last") {
    const list = visibleOrder();
    const anchorId = selectedBlockId ?? id;
    const anchorIdx = list.findIndex((b) => b.id === anchorId);
    if (anchorIdx < 0 || list.length === 0) return;
    const targetIdx = edge === "first" ? 0 : list.length - 1;
    const lo = Math.min(anchorIdx, targetIdx);
    const hi = Math.max(anchorIdx, targetIdx);
    const range = new Set<string>();
    for (let i = lo; i <= hi; i++) range.add(list[i].id);
    selectionFocusRef.current = list[targetIdx].id;
    setSelectedBlockIdState(anchorId);
    setSelectedBlockIds(range);
  }

  function deleteSelectedBlocks() {
    if (readOnly) return;
    const ids = Array.from(selectedBlockIds);
    if (ids.length === 0) return;
    const st = useStore.getState();
    const list = visibleOrder();
    const firstIdx = Math.min(
      ...ids.map((id) => list.findIndex((b) => b.id === id)).filter((i) => i >= 0)
    );
    const nextSelection = list[firstIdx - 1] ?? undefined;
    st.captureBlockHistory(pageId);
    for (const id of ids) void st.deleteBlock(id, { history: false });
    setSelectedBlockId(nextSelection?.id ?? null);
  }

  function isDescendant(candidateId: string, ancestorId: string): boolean {
    let cur = blockById(candidateId);
    while (cur?.parentId) {
      if (cur.parentId === ancestorId) return true;
      cur = blockById(cur.parentId);
    }
    return false;
  }

  function moveChildren(sourceId: string, targetParentId: string) {
    const st = useStore.getState();
    const children = siblings(sourceId);
    if (children.length === 0) return;
    let lastPosition = siblings(targetParentId).at(-1)?.position;
    for (const child of children) {
      const position = positionBetween(lastPosition, undefined);
      st.updateBlock(child.id, { parentId: targetParentId, position }, { history: false });
      lastPosition = position;
    }
  }

  function isEmptyParagraph(block: Block | undefined) {
    return (
      !!block &&
      block.type === "paragraph" &&
      spansToPlainText(block.content?.rich).length === 0
    );
  }

  function focusPageEnd() {
    if (readOnly) return;
    const st = useStore.getState();
    const topLevel = st.topLevelBlocks(pageId);
    const lastTopLevel = topLevel.at(-1);
    if (lastTopLevel && isEmptyParagraph(lastTopLevel)) {
      focusEditableSettled(lastTopLevel.id, "start");
      return;
    }

    const paragraph = st.addBlockLocal({
      pageId,
      parentId: null,
      type: "paragraph",
      position: positionBetween(lastTopLevel?.position, undefined),
    });
    focusEditableSettled(paragraph.id, "start");
  }

  function onEditorBlankMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (readOnly) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target !== e.currentTarget && !target.closest("[data-editor-tail]")) return;
    e.preventDefault();
    focusPageEnd();
  }

  function updateFileUploadProgress(blockId: string, progress: BlockUploadProgress | null) {
    setFileUploadProgressByBlock((current) => {
      if (!progress) {
        if (!(blockId in current)) return current;
        const next = { ...current };
        delete next[blockId];
        return next;
      }
      return { ...current, [blockId]: progress };
    });
  }

  function insertDroppedFileBlock(
    anchorId: string | null,
    placement: Exclude<FileDropPlacement, "replace">,
    type: Extract<BlockType, "image" | "video" | "audio" | "file">,
    fileName: string
  ) {
    const st = useStore.getState();
    const anchor = anchorId ? blockById(anchorId) : undefined;
    const parentId = anchor?.parentId ?? null;
    const list = siblings(parentId);
    const anchorIndex = anchor ? list.findIndex((candidate) => candidate.id === anchor.id) : -1;
    const before =
      anchorIndex < 0
        ? list.at(-1)
        : placement === "before"
          ? list[anchorIndex - 1]
          : anchor;
    const after =
      anchorIndex < 0
        ? undefined
        : placement === "before"
          ? anchor
          : list[anchorIndex + 1];
    let inserted: Block | undefined;
    flushSync(() => {
      inserted = st.addBlockLocal({
        pageId,
        parentId,
        type,
        content: { fileName, caption: [] },
        plainText: fileName,
        position: positionBetween(before?.position, after?.position),
        persist: false,
      });
    });
    return inserted;
  }

  async function uploadDroppedFiles(
    incomingFiles: File[],
    targetId: string | null,
    initialPlacement: FileDropPlacement
  ) {
    if (readOnly) return;
    const files = incomingFiles.filter((file) => file.size > 0);
    if (files.length === 0) return;

    let anchorId = targetId;
    let placement = initialPlacement;
    let replaceCurrent = placement === "replace" && !!targetId;
    let uploadedCount = 0;
    let lastUploadedId: string | null = null;

    for (const file of files) {
      const type = fileBlockType(file);
      let uploadBlockId = anchorId;
      let insertedForUpload: Block | undefined;

      if (!replaceCurrent) {
        const inserted = insertDroppedFileBlock(
          anchorId,
          placement === "before" ? "before" : "after",
          type,
          file.name
        );
        if (!inserted) continue;
        uploadBlockId = inserted.id;
        insertedForUpload = inserted;
      }
      if (!uploadBlockId) continue;

      const fallbackName = file.name || type;
      updateFileUploadProgress(uploadBlockId, {
        phase: "preparing",
        percent: 0,
        fileName: fallbackName,
      });

      try {
        if (insertedForUpload) {
          await useStore.getState().persistBlockCreateBatch([insertedForUpload]);
        }
        const uploaded = await uploadWorkspaceFile(
          file,
          blockUploadScope(type),
          { pageId, blockId: uploadBlockId },
          {
            onProgress: (progress) =>
              updateFileUploadProgress(uploadBlockId!, { ...progress, fileName: fallbackName }),
          }
        );
        const plainText = file.name || uploaded.name || type;
        useStore.getState().updateBlock(uploadBlockId, {
          type,
          content: {
            url: uploaded.url,
            fileName: file.name || uploaded.name || plainText,
            caption: [],
          },
          plainText,
        });
        uploadedCount += 1;
        lastUploadedId = uploadBlockId;
        anchorId = uploadBlockId;
        placement = "after";
        replaceCurrent = false;
      } catch (error) {
        if (insertedForUpload) {
          await useStore.getState().deleteBlock(uploadBlockId).catch(() => {});
        }
        useStore.getState().notify(blockUploadErrorMessage(error, file.name), "error");
      } finally {
        updateFileUploadProgress(uploadBlockId, null);
      }
    }

    if (uploadedCount > 0 && lastUploadedId) {
      setSelectedBlockId(lastUploadedId);
      useStore.getState().notify(
        uploadedCount === 1
          ? i18next.t("blockItem:uploadedFile")
          : i18next.t("blockItem:uploadedFiles", { count: uploadedCount }),
        "success"
      );
    }
  }

  function editorCanvasFileDropTarget(clientY: number): EditorFileDropIndicator {
    const root = editorRef.current;
    if (!root) {
      return { targetId: null, placement: "after", top: 0, left: 0, width: 0 };
    }
    const rootRect = root.getBoundingClientRect();
    const rows = Array.from(root.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .map((group) => {
        const targetId = group.dataset.blockId;
        const row = group.querySelector<HTMLElement>(":scope > [data-type]");
        return targetId && row ? { targetId, rect: row.getBoundingClientRect() } : null;
      })
      .filter((entry): entry is { targetId: string; rect: DOMRect } => !!entry)
      .sort((a, b) => a.rect.top - b.rect.top);

    if (rows.length === 0) {
      return {
        targetId: null,
        placement: "after",
        top: Math.max(2, clientY - rootRect.top),
        left: 0,
        width: rootRect.width,
      };
    }

    const first = rows[0];
    if (clientY <= first.rect.top + first.rect.height * 0.5) {
      return {
        targetId: first.targetId,
        placement: "before",
        top: first.rect.top - rootRect.top,
        left: first.rect.left - rootRect.left,
        width: first.rect.width,
      };
    }

    for (let index = 0; index < rows.length - 1; index += 1) {
      const current = rows[index];
      const next = rows[index + 1];
      if (clientY <= next.rect.top + next.rect.height * 0.5) {
        return {
          targetId: current.targetId,
          placement: "after",
          top: current.rect.bottom - rootRect.top,
          left: current.rect.left - rootRect.left,
          width: current.rect.width,
        };
      }
    }

    const last = rows.at(-1)!;
    const lastBlock = blockById(last.targetId);
    const replaceLast = isEmptyParagraph(lastBlock) && siblings(last.targetId).length === 0;
    return {
      targetId: last.targetId,
      placement: replaceLast ? "replace" : "after",
      top: last.rect.bottom - rootRect.top,
      left: last.rect.left - rootRect.left,
      width: last.rect.width,
    };
  }

  function autoScrollFileDrag(clientY: number) {
    const root = editorRef.current;
    if (!root) return;
    let scrollContainer: HTMLElement | null = root.parentElement;
    while (scrollContainer) {
      const style = window.getComputedStyle(scrollContainer);
      if (
        /(auto|scroll|overlay)/.test(style.overflowY) &&
        scrollContainer.scrollHeight > scrollContainer.clientHeight + 1
      ) {
        break;
      }
      scrollContainer = scrollContainer.parentElement;
    }
    const viewport = scrollContainer?.getBoundingClientRect();
    const delta = fileDragAutoScrollDelta(
      clientY,
      viewport?.top ?? 0,
      viewport?.bottom ?? window.innerHeight
    );
    if (delta === 0) return;
    if (scrollContainer) scrollContainer.scrollBy({ top: delta });
    else window.scrollBy({ top: delta });
  }

  function onEditorFileDragOverCapture(e: React.DragEvent<HTMLDivElement>) {
    if (readOnly || !dataTransferHasFiles(e.dataTransfer)) return;
    autoScrollFileDrag(e.clientY);
    if ((e.target as HTMLElement).closest("[data-block-id]")) setFileDropIndicator(null);
  }

  function onEditorFileDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (readOnly || !dataTransferHasFiles(e.dataTransfer)) return;
    if ((e.target as HTMLElement).closest("[data-block-id]")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setFileDropIndicator(editorCanvasFileDropTarget(e.clientY));
  }

  function onEditorFileDrop(e: React.DragEvent<HTMLDivElement>) {
    if (readOnly || !dataTransferHasFiles(e.dataTransfer)) return;
    if ((e.target as HTMLElement).closest("[data-block-id]")) return;
    const files = droppedFiles(e.dataTransfer);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = fileDropIndicator ?? editorCanvasFileDropTarget(e.clientY);
    setFileDropIndicator(null);
    void uploadDroppedFiles(files, target.targetId, target.placement);
  }

  // Update the multi-selection to every block row whose DOM rect intersects the
  // given viewport rectangle. Runs only from pointer handlers.
  function selectBlocksInRect(rect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }) {
    const root = editorRef.current;
    if (!root) return;
    const next = new Set<string>();
    let anchor: string | null = null;
    for (const el of root.querySelectorAll<HTMLElement>("[data-block-id]")) {
      const id = el.dataset.blockId;
      if (!id) continue;
      const r = el.getBoundingClientRect();
      const intersects =
        r.left < rect.right &&
        r.right > rect.left &&
        r.top < rect.bottom &&
        r.bottom > rect.top;
      if (intersects) {
        next.add(id);
        anchor ??= id;
      }
    }
    setSelectedBlockIdState(anchor);
    setSelectedBlockIds(next);
    selectionFocusRef.current = anchor;
  }

  function onEditorPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (readOnly) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Never start a rubber-band from inside editable text or an interactive
    // control — those own their own pointer/selection behavior.
    if (
      target.closest('[contenteditable="true"]') ||
      target.closest("input, textarea, select, button, a, [role='textbox']")
    ) {
      return;
    }
    rubberBandRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      moved: false,
    };
    window.addEventListener("pointermove", onRubberBandMove);
    window.addEventListener("pointerup", onRubberBandUp);
    detachDragRef.current = () => {
      window.removeEventListener("pointermove", onRubberBandMove);
      window.removeEventListener("pointerup", onRubberBandUp);
    };
  }

  function onRubberBandMove(e: PointerEvent) {
    const drag = rubberBandRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const left = Math.min(drag.startX, e.clientX);
    const top = Math.min(drag.startY, e.clientY);
    const width = Math.abs(e.clientX - drag.startX);
    const height = Math.abs(e.clientY - drag.startY);
    // Ignore micro-movements so a plain click is still treated as a click.
    if (!drag.moved && width < 4 && height < 4) return;
    drag.moved = true;
    // Suppress the native text selection that a drag would otherwise create.
    e.preventDefault();
    setMarquee({ left, top, width, height });
    selectBlocksInRect({ left, top, right: left + width, bottom: top + height });
  }

  function onRubberBandUp() {
    const drag = rubberBandRef.current;
    detachDragRef.current?.();
    detachDragRef.current = null;
    rubberBandRef.current = null;
    setMarquee(null);
    // A click on empty space (no drag) clears any existing selection.
    if (drag && !drag.moved) setSelectedBlockId(null);
  }

  // Freshly rebuilt every render — reads of component state inside these
  // handlers stay current. BlockItem never sees this object directly; it gets
  // the memoized facade below, which delegates through `opsRef`.
  const opsImpl: EditorOps = {
    pageId,
    readOnly,
    templateMode,
    publicReadOnly,
    sharedToken,
    selectedBlockId,
    selectedBlockIds,
    blockActionMenuFor,
    selectBlock: setSelectedBlockId,
    selectAllBlocks,
    openBlockActionMenu: setBlockActionMenuFor,
    openMoveDialog: setMoveDialogFor,
    selectAdjacentBlock,
    selectEdgeBlock,
    extendSelection,
    extendSelectionToEdge,
    deleteSelectedBlocks,

    moveSelectedBlock(id, direction) {
      if (readOnly) return false;
      const moved = moveBlockWithinSiblings(id, direction);
      if (moved) setSelectedBlockId(id);
      return moved;
    },

    moveSelectedBlocks(id, direction) {
      if (readOnly) return false;
      const selectedIds = selectedBlocksFor(id).map((block) => block.id);
      const roots = selectedRootBlocksFor(id);
      if (roots.length === 0) return false;
      if (roots.length === 1) {
        const moved = moveBlockWithinSiblings(roots[0].id, direction);
        if (moved) preserveBlockSelection(selectedIds);
        return moved;
      }

      const st = useStore.getState();
      let changed = false;

      for (const group of parentGroups(roots)) {
        const parentId = group[0].parentId ?? null;
        const rootIds = new Set(group.map((block) => block.id));
        const list = siblings(parentId);
        const segments = selectedSiblingSegments(list, rootIds);

        for (const segment of segments) {
          if (direction === "up") {
            if (segment.start <= 0) continue;
            const previous = list[segment.start - 1];
            const beforePrevious = list[segment.start - 2];
            let lastPosition = beforePrevious?.position;
            for (const root of segment.blocks) {
              const position = positionBetween(lastPosition, previous.position);
              st.captureBlockStructureHistory(pageId, {
                action: "move",
                blockIds: [root.id],
                before: [root],
                after: [{ ...root, position, updatedAt: new Date().toISOString() }],
              });
              st.updateBlock(root.id, { position }, { history: false });
              lastPosition = position;
              changed = true;
            }
          } else {
            if (segment.end >= list.length - 1) continue;
            const next = list[segment.end + 1];
            const afterNext = list[segment.end + 2];
            let lastPosition = next.position;
            for (const root of segment.blocks) {
              const position = positionBetween(lastPosition, afterNext?.position);
              st.captureBlockStructureHistory(pageId, {
                action: "move",
                blockIds: [root.id],
                before: [root],
                after: [{ ...root, position, updatedAt: new Date().toISOString() }],
              });
              st.updateBlock(root.id, { position }, { history: false });
              lastPosition = position;
              changed = true;
            }
          }
        }
      }

      if (changed) preserveBlockSelection(selectedIds);
      return changed;
    },

    async copyBlock(id) {
      return ops.copySelectedBlocks(id);
    },

    async copySelectedBlocks(id) {
      const st = useStore.getState();
      const blocks = st.blocksByPage[pageId] ?? [];
      const roots = selectedRootBlocksFor(id);
      if (roots.length === 0) return false;
      const childrenOf = (sourceId: string) =>
        blocks
          .filter((candidate) => candidate.parentId === sourceId)
          .sort((a, b) => a.position - b.position);
      const toPastedBlock = (block: Block): PastedBlock => ({
        type: block.type,
        content: cloneContent(block.content ?? { rich: [] }),
        plainText: block.plainText,
        children: childrenOf(block.id).map(toPastedBlock),
      });
      const markdown = roots.map((block) => blockTreeMarkdown(block, blocks)).join("\n");
      const html = blocksClipboardHtml(
        roots.map((block) => blockTreeHtml(block, blocks)).join("")
      );
      const payload = JSON.stringify({
        version: 1,
        blocks: roots.map(toPastedBlock),
      });
      return copyTextWithBlocks(markdown, payload, html);
    },

    async cutBlock(id) {
      return ops.cutSelectedBlocks(id);
    },

    async cutSelectedBlocks(id) {
      if (readOnly) return false;
      const st = useStore.getState();
      const roots = selectedRootBlocksFor(id);
      if (blockTreesHaveStoredFiles(roots, st.blocksByPage[pageId] ?? [])) {
        notifyStoredFileCloneBlocked();
        return false;
      }
      const copied = await ops.copySelectedBlocks(id);
      if (!copied) return false;
      if (selectedBlockIds.has(id)) {
        ops.deleteSelectedBlocks();
      } else {
        ops.removeSelectedBlock(id);
      }
      return true;
    },

    async duplicateBlock(id) {
      if (readOnly) return undefined;
      const st = useStore.getState();
      const source = blockById(id);
      if (!source) return undefined;
      const allBlocks = st.blocksByPage[pageId] ?? [];
      const parentId = source.parentId ?? null;
      const list = siblings(parentId);
      const index = list.findIndex((block) => block.id === source.id);
      const next = list[index + 1];
      const childrenOf = (sourceId: string) =>
        allBlocks
          .filter((block) => block.parentId === sourceId)
          .sort((a, b) => a.position - b.position);
      if (blockTreesHaveStoredFiles([source], allBlocks)) {
        notifyStoredFileCloneBlocked();
        return undefined;
      }

      st.captureBlockHistory(pageId);
      const duplicateTree = (
        block: Block,
        nextParentId: string | null,
        position: number
      ): Block => {
        const copy = st.addBlockLocal({
          pageId: block.pageId,
          parentId: nextParentId,
          type: block.type,
          content: cloneContent(block.content ?? { rich: [] }),
          position,
          history: false,
        });
        if (block.plainText !== copy.plainText) {
          st.updateBlock(copy.id, { plainText: block.plainText }, { history: false });
        }
        for (const child of childrenOf(block.id)) {
          duplicateTree(child, copy.id, child.position);
        }
        return copy;
      };

      const copy = duplicateTree(
        source,
        parentId,
        positionBetween(source.position, next?.position)
      );
      setSelectedBlockId(copy.id);
      return copy;
    },

    async duplicateSelectedBlocks(id) {
      if (readOnly) return [];
      const st = useStore.getState();
      const roots = selectedRootBlocksFor(id);
      if (roots.length === 0) return [];
      const allBlocks = st.blocksByPage[pageId] ?? [];
      const childrenOf = (sourceId: string) =>
        allBlocks
          .filter((block) => block.parentId === sourceId)
          .sort((a, b) => a.position - b.position);
      if (blockTreesHaveStoredFiles(roots, allBlocks)) {
        notifyStoredFileCloneBlocked();
        return [];
      }

      st.captureBlockHistory(pageId);
      const copiedRoots: Block[] = [];
      const duplicateTree = (
        block: Block,
        nextParentId: string | null,
        position: number
      ): Block => {
        const copy = st.addBlockLocal({
          pageId: block.pageId,
          parentId: nextParentId,
          type: block.type,
          content: cloneContent(block.content ?? { rich: [] }),
          position,
          history: false,
        });
        if (block.plainText !== copy.plainText) {
          st.updateBlock(copy.id, { plainText: block.plainText }, { history: false });
        }
        for (const child of childrenOf(block.id)) {
          duplicateTree(child, copy.id, child.position);
        }
        return copy;
      };

      const parentIds = new Set(roots.map((root) => root.parentId ?? null));
      if (parentIds.size === 1) {
        const parentId = roots[0].parentId ?? null;
        const rootIds = new Set(roots.map((root) => root.id));
        const list = siblings(parentId);
        const lastRootIndex = list.reduce(
          (last, candidate, index) => (rootIds.has(candidate.id) ? index : last),
          -1
        );
        const next = list[lastRootIndex + 1];
        let previousPosition = list[lastRootIndex]?.position ?? roots[roots.length - 1].position;
        for (const root of roots) {
          const position = positionBetween(previousPosition, next?.position);
          const copy = duplicateTree(root, parentId, position);
          copiedRoots.push(copy);
          previousPosition = position;
        }
      } else {
        for (const root of roots) {
          const parentId = root.parentId ?? null;
          const list = siblings(parentId);
          const index = list.findIndex((block) => block.id === root.id);
          const next = list[index + 1];
          copiedRoots.push(
            duplicateTree(root, parentId, positionBetween(root.position, next?.position))
          );
        }
      }

      const copiedIds = new Set(copiedRoots.map((copy) => copy.id));
      const anchorId = copiedRoots[0]?.id ?? null;
      setSelectedBlockIdState(anchorId);
      setSelectedBlockIds(copiedIds);
      selectionFocusRef.current = anchorId;
      return copiedRoots;
    },

    setSelectedBlockColor(id, token) {
      if (readOnly) return false;
      const targets = selectedBlocksFor(id);
      if (targets.length === 0) return false;
      const st = useStore.getState();
      st.captureBlockHistory(pageId);
      for (const target of targets) {
        const content = { ...(target.content ?? {}) };
        if (token === "default") delete content.color;
        else content.color = token;
        st.updateBlock(target.id, { content }, { history: false });
      }
      return true;
    },

    toggleSelectedBlockState(id) {
      if (readOnly) return false;
      const selected = selectedBlocksFor(id);
      const targets = selected.filter(
        (target) => target.type === "to_do" || TOGGLE_BLOCKS.has(target.type)
      );
      if (targets.length === 0) return false;

      const todos = targets.filter((target) => target.type === "to_do");
      const toggles = targets.filter((target) => TOGGLE_BLOCKS.has(target.type));
      const nextChecked =
        todos.length > 0 ? todos.some((target) => !target.content?.checked) : undefined;
      const nextCollapsed =
        toggles.length > 0 ? toggles.some((target) => !target.content?.collapsed) : undefined;

      const st = useStore.getState();
      st.captureBlockHistory(pageId);
      for (const target of targets) {
        if (target.type === "to_do") {
          st.updateBlock(
            target.id,
            { content: { ...target.content, checked: nextChecked } },
            { history: false }
          );
        } else {
          st.updateBlock(
            target.id,
            { content: { ...target.content, collapsed: nextCollapsed } },
            { history: false }
          );
        }
      }
      preserveBlockSelection(selected.map((target) => target.id));
      return true;
    },

    toggleSelectedTextMark(id, mark) {
      if (readOnly) return false;
      const selected = selectedBlocksFor(id);
      const targets = selected.filter(
        (target) =>
          target.type !== "code" &&
          TEXT_BLOCKS.has(target.type) &&
          spansWithText(target.content?.rich).length > 0
      );
      if (targets.length === 0) return false;

      const enabled = targets.every((target) =>
        spansWithText(target.content?.rich).every((span) => !!span[mark])
      );
      const st = useStore.getState();
      st.captureBlockHistory(pageId);

      for (const target of targets) {
        const rich = coalesce(
          (target.content?.rich ?? []).map((span) =>
            span.text.length === 0
              ? span
              : { ...span, [mark]: enabled ? undefined : true }
          )
        );
        st.updateBlock(
          target.id,
          {
            content: { ...target.content, rich },
            plainText: spansToPlainText(rich),
          },
          { history: false }
        );
      }

      preserveBlockSelection(selected.map((target) => target.id));
      return true;
    },

    insertBlocksAfter(id, blockSpecs) {
      if (readOnly) return undefined;
      if (hasStoredFileReference(blockSpecs)) {
        notifyStoredFileCloneBlocked();
        return undefined;
      }
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur || blockSpecs.length === 0) return undefined;
      const list = siblings(cur.parentId);
      const index = list.findIndex((block) => block.id === id);
      const next = list[index + 1];
      st.captureBlockHistory(pageId);
      const createdBlocks: Block[] = [];

      const insertChildren = (parentId: string, children?: PastedBlock[]) => {
        let previousPosition: number | undefined;
        let lastInserted: Block | undefined;
        for (const child of children ?? []) {
          const position = positionBetween(previousPosition, undefined);
          const inserted = st.addBlockLocal({
            pageId,
            parentId,
            type: child.type,
            content: pastedContent(child),
            plainText: pastedPlainText(child),
            position,
            history: false,
            persist: false,
          });
          createdBlocks.push(inserted);
          lastInserted = insertChildren(inserted.id, child.children) ?? inserted;
          previousPosition = position;
        }
        return lastInserted;
      };

      let previousPosition = cur.position;
      let lastInserted: Block | undefined;
      flushSync(() => {
        for (const spec of blockSpecs) {
          const position = positionBetween(previousPosition, next?.position);
          const inserted = st.addBlockLocal({
            pageId,
            parentId: cur.parentId ?? null,
            type: spec.type,
            content: pastedContent(spec),
            plainText: pastedPlainText(spec),
            position,
            history: false,
            persist: false,
          });
          createdBlocks.push(inserted);
          lastInserted = insertChildren(inserted.id, spec.children) ?? inserted;
          previousPosition = position;
        }
      });

      if (!templateMode && createdBlocks.length > 0) {
        void st.persistBlockCreateBatch(createdBlocks);
      }
      if (lastInserted) setSelectedBlockId(lastInserted.id);
      return lastInserted;
    },

    replaceSelectedBlocks(id, blockSpecs) {
      if (readOnly) return undefined;
      if (blockSpecs.length === 0) return undefined;
      if (hasStoredFileReference(blockSpecs)) {
        notifyStoredFileCloneBlocked();
        return undefined;
      }
      const roots = selectedRootBlocksFor(id);
      const anchor = roots[0] ?? blockById(id);
      if (!anchor) return undefined;

      const st = useStore.getState();
      const parentId = anchor.parentId ?? null;
      const list = siblings(parentId);
      const sameParentRootIds = new Set(
        roots.filter((root) => (root.parentId ?? null) === parentId).map((root) => root.id)
      );
      const anchorIndex = list.findIndex((block) => block.id === anchor.id);
      const previous = list
        .slice(0, Math.max(0, anchorIndex))
        .reverse()
        .find((block) => !sameParentRootIds.has(block.id));
      const lastSelectedIndex = list.reduce(
        (last, block, index) => (sameParentRootIds.has(block.id) ? index : last),
        anchorIndex
      );
      const next = list
        .slice(Math.max(anchorIndex, lastSelectedIndex) + 1)
        .find((block) => !sameParentRootIds.has(block.id));
      const insertChildren = (insertedParentId: string, children?: PastedBlock[]) => {
        let previousPosition: number | undefined;
        let lastInserted: Block | undefined;
        for (const child of children ?? []) {
          const position = positionBetween(previousPosition, undefined);
          const inserted = st.addBlockLocal({
            pageId,
            parentId: insertedParentId,
            type: child.type,
            content: pastedContent(child),
            plainText: pastedPlainText(child),
            position,
            history: false,
            persist: false,
          });
          createdBlocks.push(inserted);
          lastInserted = insertChildren(inserted.id, child.children) ?? inserted;
          previousPosition = position;
        }
        return lastInserted;
      };

      let previousPosition = previous?.position;
      let lastInserted: Block | undefined;
      const createdBlocks: Block[] = [];
      st.captureBlockHistory(pageId);
      flushSync(() => {
        for (const root of roots.length > 0 ? roots : [anchor]) {
          void st.deleteBlock(root.id, { history: false });
        }
        for (const spec of blockSpecs) {
          const position = positionBetween(previousPosition, next?.position);
          const inserted = st.addBlockLocal({
            pageId,
            parentId,
            type: spec.type,
            content: pastedContent(spec),
            plainText: pastedPlainText(spec),
            position,
            history: false,
            persist: false,
          });
          createdBlocks.push(inserted);
          lastInserted = insertChildren(inserted.id, spec.children) ?? inserted;
          previousPosition = position;
        }
      });

      if (!lastInserted) {
        setSelectedBlockId(null);
        return undefined;
      }
      focusOrSelectBlock(lastInserted.id, lastInserted.type, "end");
      if (!templateMode && createdBlocks.length > 0) {
        void st.persistBlockCreateBatch(createdBlocks);
      }
      return lastInserted;
    },

    removeSelectedBlock(id) {
      if (readOnly) return;
      const st = useStore.getState();
      const list = visibleOrder();
      const index = list.findIndex((block) => block.id === id);
      const nextSelection = index >= 0 ? list[index - 1] ?? list[index + 1] : undefined;
      void st.deleteBlock(id);
      setSelectedBlockId(nextSelection?.id ?? null);
    },

    setText(id, spans) {
      if (readOnly) return;
      if (selectedBlockId) setSelectedBlockId(null);
      const beforeContent = currentContent(id);
      const operation = createTextOperation(beforeContent.rich ?? [], spans);
      const plainText = spansToPlainText(spans);
      const updatedAt = new Date().toISOString();
      const revision = Date.now();
      const spansChanged = JSON.stringify(beforeContent.rich ?? []) !== JSON.stringify(spans);
      useStore.getState().updateBlock(
        id,
        { content: { ...beforeContent, rich: spans }, plainText, updatedAt },
        { debounce: true, history: "merge" }
      );
      if (!templateMode) {
        publishPageTextUpdate({
          blockId: id,
          content: { rich: spans },
          operation,
          pageId,
          plainText,
          revision,
          updatedAt,
        });
      }
      if (!templateMode && (operation || spansChanged)) {
        void captureBlockTextLocalEdit({
          beforeRich: beforeContent.rich ?? [],
          blockId: id,
          rich: spans,
          updatedAt,
        }).catch(() => {});
        queueCollaborationTextLog(id, beforeContent.rich ?? [], spans, updatedAt, revision);
      }
    },

    changeType(id, type, caret = "end") {
      if (readOnly) return;
      const patch = blockTypePatch(id, type);
      useStore.getState().updateBlock(id, patch);
      focusAfterTypeChange(id, caret);
    },

    changeSelectedType(id, type, caret = "end") {
      if (readOnly) return;
      const targets = selectedBlocksFor(id);
      if (targets.length <= 1) {
        ops.changeType(id, type, caret);
        return;
      }
      const st = useStore.getState();
      st.captureBlockHistory(pageId);
      for (const target of targets) {
        st.updateBlock(target.id, blockTypePatch(target.id, type), { history: false });
      }
      const targetIds = new Set(targets.map((target) => target.id));
      const anchorId = targets.find((target) => target.id === selectedBlockId)?.id ?? targets[0].id;
      setSelectedBlockIdState(anchorId);
      setSelectedBlockIds(targetIds);
      selectionFocusRef.current = targets.at(-1)?.id ?? anchorId;
    },

    splitBlock(id, before, after) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = st.blocksByPage[pageId]?.find((b) => b.id === id);
      if (!cur) return;
      const def = getDef(cur.type);

      if (before.length === 0 && after.length === 0) {
        const parent = cur.parentId ? blockById(cur.parentId) : undefined;
        const currentIsFinalChild = parent ? isFinalChild(id, parent.id) : false;
        const canEscapeParent = !!parent && emptyEnterCanEscapeParent(parent) && currentIsFinalChild;

        // A blank nested list/to-do item should climb one indentation level.
        // At the top of its current list/container it exits back to plain text.
        if (def.continues) {
          if (parent && blockContinuesOnEnter(parent.type) && currentIsFinalChild) {
            moveBlockAfterParent(st, cur, parent, {
              content: { ...cur.content, rich: [] },
              plainText: "",
            });
            return;
          }
          convertEmptyBlockToParagraph(st, cur);
          return;
        }

        // A blank final child line exits its current container on Enter. This
        // keeps list, quote, callout, and toggle bodies from trapping the caret.
        if (cur.type === "paragraph" && parent && canEscapeParent && siblings(id).length === 0) {
          moveBlockAfterParent(st, cur, parent, {
            content: emptyParagraphContent(cur.content),
            plainText: "",
          });
          return;
        }

        // Pressing Enter on an empty styled block exits back to plain text.
        if (EMPTY_ENTER_EXITS_TO_PARAGRAPH.has(cur.type)) {
          convertEmptyBlockToParagraph(st, cur);
          return;
        }
      }

      // Enter at the end of an expanded toggle/toggle-heading creates the first
      // CHILD paragraph inside the toggle (Notion behavior) rather than a sibling.
      // We only do this when splitting at the very end (after is empty); a split
      // in the middle keeps the continuation as a sibling so text isn't buried.
      if (TOGGLE_BLOCKS.has(cur.type) && after.length === 0) {
        st.captureBlockHistory(pageId);
        const patch: Partial<Block> = {
          content: { ...cur.content, rich: before, collapsed: false },
          plainText: spansToPlainText(before),
        };
        st.updateBlock(id, patch, { history: false });
        const firstChild = siblings(id)[0];
        const childPos = positionBetween(undefined, firstChild?.position);
        let child: Block | undefined;
        flushSync(() => {
          child = st.addBlockLocal({
            pageId,
            parentId: id,
            type: "paragraph",
            content: { rich: [] },
            position: childPos,
            history: false,
          });
        });
        if (child) focusEditableSettled(child.id, "start");
        return;
      }

      const list = siblings(cur.parentId);
      const idx = list.findIndex((b) => b.id === id);
      const next = list[idx + 1];
      const pos = positionBetween(cur.position, next?.position);
      const newType: BlockType = def.continues ? cur.type : "paragraph";

      // (the caller has already trimmed the current block's DOM to `before`)
      st.captureBlockHistory(pageId);
      st.updateBlock(
        id,
        {
          content: { ...cur.content, rich: before },
          plainText: spansToPlainText(before),
        },
        { history: false }
      );
      let nb: Block | undefined;
      flushSync(() => {
        nb = st.addBlockLocal({
          pageId,
          parentId: cur.parentId ?? null,
          type: newType,
          content: { rich: after },
          position: pos,
          history: false,
        });
      });
      if (nb) focusOrSelectBlock(nb.id, nb.type, "start");
    },

    backspace(id, curSpans) {
      if (readOnly) return false;
      const st = useStore.getState();
      const cur = st.blocksByPage[pageId]?.find((b) => b.id === id);
      if (!cur) return false;
      const parent = cur.parentId ? blockById(cur.parentId) : undefined;
      if (parent && !STRUCTURAL_BLOCKS.has(parent.type)) {
        ops.outdentBlock(id);
        return true;
      }
      // First Backspace at start of a styled block → plain paragraph.
      if (cur.type !== "paragraph") {
        st.updateBlock(id, blockTypePatch(id, "paragraph"));
        return true;
      }
      // Merge into the previous text block (preserving marks).
      const list = visibleOrder();
      const idx = list.findIndex((b) => b.id === id);
      const prev = list[idx - 1];
      if (!prev) {
        if (cur.type === "paragraph") {
          focusEditable(`title:${pageId}`, "end");
          return true;
        }
        return false; // first non-empty block — let default happen
      }
      // A previous code block must not absorb prose. Don't merge or delete the
      // current block — just move the caret to the end of the code (Notion's
      // first-backspace-navigates behavior).
      if (prev.type === "code") {
        focusEditable(prev.id, "end");
        return true;
      }
      if (TEXT_BLOCKS.has(prev.type) && prev.type !== "divider") {
        st.captureBlockHistory(pageId);
        const prevSpans = prev.content?.rich ?? [];
        const merged = concatSpans(prevSpans, curSpans);
        st.updateBlock(
          prev.id,
          {
            content: { ...prev.content, rich: merged },
            plainText: spansToPlainText(merged),
          },
          { history: false }
        );
        const el = getEditable(prev.id);
        if (el) {
          el.innerHTML = spansToHtml(merged);
          el.dataset.empty = String(merged.length === 0);
        }
        moveChildren(id, prev.id);
        void st.deleteBlock(id, { history: false });
        focusEditable(prev.id, spansToPlainText(prevSpans).length);
      } else {
        // Non-text blocks cannot absorb paragraph content. Notion moves from
        // the caret to a whole-block selection instead: an empty paragraph is
        // removed first, then a second Backspace/Delete removes the selected
        // media/embed/table/etc. A non-empty paragraph must stay intact while
        // the preceding block becomes selected.
        if (spansToPlainText(curSpans).length === 0) {
          st.captureBlockHistory(pageId);
          moveChildren(id, prev.id);
          void st.deleteBlock(id, { history: false });
        }
        setSelectedBlockId(prev.id);
      }
      return true;
    },

    deleteForward(id, curSpans) {
      if (readOnly) return false;
      const st = useStore.getState();
      const cur = st.blocksByPage[pageId]?.find((b) => b.id === id);
      if (!cur) return false;
      const list = visibleOrder();
      const idx = list.findIndex((b) => b.id === id);
      const next = list[idx + 1];
      if (!next || STRUCTURAL_BLOCKS.has(next.type)) return false;
      // Don't pull a following code block's text into prose.
      if (next.type === "code") return false;

      st.captureBlockHistory(pageId);
      if (TEXT_BLOCKS.has(next.type) && next.type !== "divider") {
        const merged = concatSpans(curSpans, next.content?.rich ?? []);
        st.updateBlock(
          id,
          {
            content: { ...cur.content, rich: merged },
            plainText: spansToPlainText(merged),
          },
          { history: false }
        );
        const el = getEditable(id);
        if (el) {
          el.innerHTML = spansToHtml(merged);
          el.dataset.empty = String(merged.length === 0);
        }
        moveChildren(next.id, id);
        void st.deleteBlock(next.id, { history: false });
        focusEditable(id, spansToPlainText(curSpans).length);
      } else {
        moveChildren(next.id, id);
        void st.deleteBlock(next.id, { history: false });
        focusEditable(id, "end");
      }
      return true;
    },

    arrowUp(id) {
      const list = visibleOrder();
      const idx = list.findIndex((b) => b.id === id);
      for (let i = idx - 1; i >= 0; i--) {
        if (list[i].type !== "divider") return void focusEditable(list[i].id, "end");
      }
      focusEditable(`title:${pageId}`, "end");
    },

    arrowDown(id) {
      const list = visibleOrder();
      const idx = list.findIndex((b) => b.id === id);
      for (let i = idx + 1; i < list.length; i++) {
        if (list[i].type !== "divider") return void focusEditable(list[i].id, "start");
      }
    },

    indentBlock(id, opts) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur) return;
      const list = siblings(cur.parentId);
      const idx = list.findIndex((b) => b.id === id);
      const prev = list[idx - 1];
      if (!prev) return;
      // Refuse to indent under a non-container previous sibling (divider, image…).
      if (!CONTAINER_BLOCKS.has(prev.type)) return;
      const children = siblings(prev.id);
      const last = children[children.length - 1];
      const position = positionBetween(last?.position, undefined);
      captureStructureMove(st, cur, "indent", prev.id, position);
      expandToggleForChildInsertion(st, prev);
      st.updateBlock(
        id,
        {
          parentId: prev.id,
          position,
        },
        { history: false }
      );
      if (opts?.preserveSelection) setSelectedBlockId(id);
      else focusAfterMove(id);
    },

    outdentBlock(id, opts) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur?.parentId) return;
      const parent = blockById(cur.parentId);
      if (!parent) return;
      const parentList = siblings(parent.parentId);
      const parentIdx = parentList.findIndex((b) => b.id === parent.id);
      const next = parentList[parentIdx + 1];
      const currentLevel = siblings(parent.id);
      const currentIdx = currentLevel.findIndex((b) => b.id === cur.id);
      const followingSiblings = currentIdx >= 0 ? currentLevel.slice(currentIdx + 1) : [];
      const curChildren = siblings(cur.id);
      let lastChildPosition = curChildren.at(-1)?.position;
      const position = positionBetween(parent.position, next?.position);
      captureStructureMove(st, cur, "outdent", parent.parentId ?? null, position);
      st.updateBlock(
        id,
        {
          parentId: parent.parentId ?? null,
          position,
        },
        { history: false }
      );
      for (const sibling of followingSiblings) {
        const position = positionBetween(lastChildPosition, undefined);
        st.updateBlock(
          sibling.id,
          {
            parentId: cur.id,
            position,
          },
          { history: false }
        );
        lastChildPosition = position;
      }
      if (opts?.preserveSelection) setSelectedBlockId(id);
      else focusAfterMove(id);
    },

    indentSelectedBlocks(id) {
      if (readOnly) return;
      const roots = selectedRootBlocksFor(id);
      if (roots.length <= 1) {
        ops.indentBlock(id, { preserveSelection: true });
        return;
      }
      const selectedIds = selectedBlocksFor(id).map((block) => block.id);
      const st = useStore.getState();
      let changed = false;

      for (const group of parentGroups(roots)) {
        const parentId = group[0].parentId ?? null;
        const rootIds = new Set(group.map((block) => block.id));
        const list = siblings(parentId);
        const firstIndex = list.findIndex((block) => rootIds.has(block.id));
        if (firstIndex <= 0) continue;
        const target = list[firstIndex - 1];
        if (!CONTAINER_BLOCKS.has(target.type)) continue;
        const children = siblings(target.id);
        let lastPosition = children.at(-1)?.position;
        for (const root of group) {
          if (!changed) st.captureBlockHistory(pageId);
          expandToggleForChildInsertion(st, target);
          const position = positionBetween(lastPosition, undefined);
          st.updateBlock(
            root.id,
            { parentId: target.id, position },
            { history: false }
          );
          lastPosition = position;
          changed = true;
        }
      }

      if (changed) preserveBlockSelection(selectedIds);
    },

    outdentSelectedBlocks(id) {
      if (readOnly) return;
      const roots = selectedRootBlocksFor(id);
      if (roots.length <= 1) {
        ops.outdentBlock(id, { preserveSelection: true });
        return;
      }
      const selectedIds = selectedBlocksFor(id).map((block) => block.id);
      const st = useStore.getState();
      let changed = false;

      for (const group of parentGroups(roots)) {
        const parentId = group[0].parentId;
        if (!parentId) continue;
        const parent = blockById(parentId);
        if (!parent) continue;
        const parentList = siblings(parent.parentId);
        const parentIndex = parentList.findIndex((block) => block.id === parent.id);
        const next = parentList[parentIndex + 1];
        const rootIds = new Set(group.map((block) => block.id));
        const currentLevel = siblings(parent.id);
        const lastIndex = currentLevel.reduce(
          (last, candidate, index) => (rootIds.has(candidate.id) ? index : last),
          -1
        );
        if (lastIndex < 0) continue;

        let outPosition = parent.position;
        for (const root of group) {
          if (!changed) st.captureBlockHistory(pageId);
          const position = positionBetween(outPosition, next?.position);
          st.updateBlock(
            root.id,
            { parentId: parent.parentId ?? null, position },
            { history: false }
          );
          outPosition = position;
          changed = true;
        }

        const lastRoot = group[group.length - 1];
        const followingSiblings = currentLevel.slice(lastIndex + 1);
        let lastChildPosition = siblings(lastRoot.id).at(-1)?.position;
        for (const sibling of followingSiblings) {
          const position = positionBetween(lastChildPosition, undefined);
          st.updateBlock(
            sibling.id,
            { parentId: lastRoot.id, position },
            { history: false }
          );
          lastChildPosition = position;
        }
      }

      if (changed) preserveBlockSelection(selectedIds);
    },

    moveBlock(id, targetId, placement) {
      if (readOnly) return false;
      const st = useStore.getState();
      const cur = blockById(id);
      const target = blockById(targetId);
      if (!cur || !target || cur.id === target.id) return false;
      if (isDescendant(target.id, cur.id)) return false;

      if (placement === "inside") {
        const children = siblings(target.id).filter((b) => b.id !== cur.id);
        const last = children[children.length - 1];
        const position = positionBetween(last?.position, undefined);
        captureStructureMove(st, cur, "indent", target.id, position);
        expandToggleForChildInsertion(st, target);
        st.updateBlock(
          id,
          {
            parentId: target.id,
            position,
          },
          { history: false }
        );
        focusAfterMove(id);
        return true;
      }

      const parentId = target.parentId ?? null;
      const list = siblings(parentId).filter((b) => b.id !== cur.id);
      const idx = list.findIndex((b) => b.id === target.id);
      if (idx < 0) return false;
      const before = placement === "before" ? list[idx - 1] : target;
      const after = placement === "before" ? target : list[idx + 1];
      const position = positionBetween(before?.position, after?.position);
      const action: "move" | "indent" | "outdent" =
        cur.parentId && cur.parentId !== parentId
          ? "outdent"
          : parentId && cur.parentId !== parentId
            ? "indent"
            : "move";
      captureStructureMove(st, cur, action, parentId, position);
      st.updateBlock(
        id,
        {
          parentId,
          position,
        },
        { history: false }
      );
      focusAfterMove(id);
      return true;
    },

    moveSelectedBlocksTo(id, targetId, placement) {
      if (readOnly) return false;
      if (!selectedBlockIds.has(id)) {
        return ops.moveBlock(id, targetId, placement);
      }

      const roots = selectedRootBlocksFor(id);
      if (roots.length <= 1) {
        return ops.moveBlock(id, targetId, placement);
      }

      const target = blockById(targetId);
      if (!target) return false;
      if (roots.some((root) => root.id === target.id || isDescendant(target.id, root.id))) {
        return false;
      }

      const selectedIds = selectedBlocksFor(id).map((block) => block.id);
      const rootIds = new Set(roots.map((root) => root.id));
      const st = useStore.getState();

      if (placement === "inside") {
        const children = siblings(target.id).filter((child) => !rootIds.has(child.id));
        let lastPosition = children.at(-1)?.position;
        st.captureBlockHistory(pageId);
        expandToggleForChildInsertion(st, target);
        for (const root of roots) {
          const position = positionBetween(lastPosition, undefined);
          st.updateBlock(
            root.id,
            { parentId: target.id, position },
            { history: false }
          );
          lastPosition = position;
        }
        preserveBlockSelection(selectedIds);
        return true;
      }

      const parentId = target.parentId ?? null;
      const list = siblings(parentId).filter((block) => !rootIds.has(block.id));
      const targetIndex = list.findIndex((block) => block.id === target.id);
      if (targetIndex < 0) return false;

      const before = placement === "before" ? list[targetIndex - 1] : target;
      const after = placement === "before" ? target : list[targetIndex + 1];
      let lastPosition = before?.position;
      st.captureBlockHistory(pageId);
      for (const root of roots) {
        const position = positionBetween(lastPosition, after?.position);
        st.updateBlock(
          root.id,
          { parentId, position },
          { history: false }
        );
        lastPosition = position;
      }
      preserveBlockSelection(selectedIds);
      return true;
    },

    copySelectedBlocksTo(id, targetId, placement) {
      if (readOnly) return [];
      const target = blockById(targetId);
      if (!target) return [];
      const roots = selectedRootBlocksFor(id);
      if (roots.length === 0) return [];
      if (
        placement === "inside" &&
        roots.some((root) => root.id === target.id || isDescendant(target.id, root.id))
      ) {
        return [];
      }

      const st = useStore.getState();
      const allBlocks = st.blocksByPage[pageId] ?? [];
      if (blockTreesHaveStoredFiles(roots, allBlocks)) {
        notifyStoredFileCloneBlocked();
        return [];
      }
      const childrenOf = (sourceId: string) =>
        allBlocks
          .filter((block) => block.parentId === sourceId)
          .sort((a, b) => a.position - b.position);
      const copiedRoots: Block[] = [];

      const duplicateTree = (
        block: Block,
        nextParentId: string | null,
        position: number
      ): Block => {
        const copy = st.addBlockLocal({
          pageId: block.pageId,
          parentId: nextParentId,
          type: block.type,
          content: cloneContent(block.content ?? { rich: [] }),
          position,
          history: false,
        });
        if (block.plainText !== copy.plainText) {
          st.updateBlock(copy.id, { plainText: block.plainText }, { history: false });
        }
        for (const child of childrenOf(block.id)) {
          duplicateTree(child, copy.id, child.position);
        }
        return copy;
      };

      st.captureBlockHistory(pageId);
      if (placement === "inside") {
        expandToggleForChildInsertion(st, target);
        let lastPosition = siblings(target.id).at(-1)?.position;
        for (const root of roots) {
          const position = positionBetween(lastPosition, undefined);
          const copy = duplicateTree(root, target.id, position);
          copiedRoots.push(copy);
          lastPosition = position;
        }
      } else {
        const parentId = target.parentId ?? null;
        const list = siblings(parentId);
        const targetIndex = list.findIndex((block) => block.id === target.id);
        if (targetIndex < 0) return [];
        const before = placement === "before" ? list[targetIndex - 1] : target;
        const after = placement === "before" ? target : list[targetIndex + 1];
        let lastPosition = before?.position;
        for (const root of roots) {
          const position = positionBetween(lastPosition, after?.position);
          const copy = duplicateTree(root, parentId, position);
          copiedRoots.push(copy);
          lastPosition = position;
        }
      }

      const copiedIds = copiedRoots.map((block) => block.id);
      preserveBlockSelection(copiedIds, copiedRoots[0]?.id);
      return copiedRoots;
    },

    async moveSelectedBlocksToPage(id, targetPageId) {
      if (readOnly) return false;
      const roots = selectedRootBlocksFor(id);
      if (roots.length === 0) return false;
      const st = useStore.getState();
      for (const root of roots) {
        await st.moveBlockToPage(root.id, targetPageId);
      }
      setSelectedBlockId(null);
      return true;
    },

    uploadDroppedFiles,

    insertAfter(id, type = "paragraph") {
      if (readOnly) return undefined;
      const st = useStore.getState();
      const cur = blockById(id);
      const list = siblings(cur?.parentId);
      const idx = list.findIndex((b) => b.id === id);
      const next = list[idx + 1];
      const pos = positionBetween(cur?.position, next?.position);
      let nb: Block | undefined;
      flushSync(() => {
        nb = st.addBlockLocal({ pageId, parentId: cur?.parentId ?? null, type, position: pos });
      });
      if (nb) focusOrSelectBlock(nb.id, nb.type, "start");
      return nb;
    },

    insertChildBlock(parentId, type = "paragraph") {
      if (readOnly) return undefined;
      const st = useStore.getState();
      const parent = blockById(parentId);
      if (!parent) return undefined;
      // Expand the toggle so the new child is visible.
      if (TOGGLE_BLOCKS.has(parent.type) && parent.content?.collapsed) {
        st.updateBlock(parentId, { content: { ...parent.content, collapsed: false } });
      }
      const firstChild = siblings(parentId)[0];
      const pos = positionBetween(undefined, firstChild?.position);
      let nb: Block | undefined;
      flushSync(() => {
        nb = st.addBlockLocal({ pageId, parentId, type, position: pos });
      });
      if (nb) focusOrSelectBlock(nb.id, nb.type, "start");
      return nb;
    },

    replaceWithBlocks(id, blockSpecs) {
      if (readOnly) return;
      if (hasStoredFileReference(blockSpecs)) {
        notifyStoredFileCloneBlocked();
        return;
      }
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur || blockSpecs.length === 0) return;
      const list = siblings(cur.parentId);
      const idx = list.findIndex((b) => b.id === id);
      const next = list[idx + 1];
      st.captureBlockHistory(pageId);

      const [first, ...rest] = blockSpecs;
      const applySpecToExisting = (blockId: string, spec: PastedBlock) => {
        st.updateBlock(
          blockId,
          {
            type: spec.type,
            content: pastedContent(spec),
            plainText: pastedPlainText(spec),
          },
          { history: false }
        );
      };
      const insertChildren = (parentId: string, children?: PastedBlock[]) => {
        let previousPosition: number | undefined;
        let lastInserted: Block | undefined;
        for (const child of children ?? []) {
          const position = positionBetween(previousPosition, undefined);
          const inserted = st.addBlockLocal({
            pageId,
            parentId,
            type: child.type,
            content: pastedContent(child),
            plainText: pastedPlainText(child),
            position,
            history: false,
            persist: false,
          });
          createdBlocks.push(inserted);
          const childLast = insertChildren(inserted.id, child.children);
          previousPosition = position;
          lastInserted = childLast ?? inserted;
        }
        return lastInserted;
      };

      applySpecToExisting(id, first);
      const existingChildren = siblings(id);

      let previousPosition = cur.position;
      let lastId = id;
      let lastType = first.type;
      const createdBlocks: Block[] = [];
      flushSync(() => {
        for (const child of existingChildren) {
          void st.deleteBlock(child.id, { history: false });
        }
        const firstChildLast = insertChildren(id, first.children);
        if (firstChildLast) {
          lastId = firstChildLast.id;
          lastType = firstChildLast.type;
        }
        for (const spec of rest) {
          const position = positionBetween(previousPosition, next?.position);
          const inserted = st.addBlockLocal({
            pageId,
            parentId: cur.parentId ?? null,
            type: spec.type,
            content: pastedContent(spec),
            plainText: pastedPlainText(spec),
            position,
            history: false,
            persist: false,
          });
          createdBlocks.push(inserted);
          previousPosition = position;
          lastId = inserted.id;
          lastType = inserted.type;
          const childLast = insertChildren(inserted.id, spec.children);
          if (childLast) {
            lastId = childLast.id;
            lastType = childLast.type;
          }
        }
      });

      if (!templateMode && createdBlocks.length > 0) {
        void st.persistBlockCreateBatch(createdBlocks);
      }
      focusOrSelectBlock(lastId, lastType, "end");
    },

    remove(id) {
      if (readOnly) return;
      const st = useStore.getState();
      const list = visibleOrder();
      const idx = list.findIndex((b) => b.id === id);
      const prev = list[idx - 1];
      void st.deleteBlock(id);
      if (prev) focusOrSelectBlock(prev.id, prev.type, "end");
    },

    createChildPage(id) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur) return;
      if (templateMode) {
        st.updateBlock(id, {
          type: "paragraph",
          content: textBlockContentFrom(cur),
          plainText: spansToPlainText(textBlockContentFrom(cur).rich),
        });
        setSelectedBlockId(id);
        return;
      }
      const titleText = spansToPlainText(cur.content?.rich).trim();
      const title = titleText;
      const childIds = siblings(id).map((child) => child.id);
      st.captureBlockHistory(pageId);
      void st
        .createPage({
          parentId: pageId,
          parentType: "page",
          title,
          focusTarget: titleText.length === 0 ? "title" : "body",
        })
        .then(async (page) => {
          st.updateBlock(
            id,
            {
              type: "child_page",
              content: { childPageId: page.id },
              plainText: pageDisplayTitle(page),
            },
            { history: false }
          );
          for (const childId of childIds) {
            await useStore.getState().moveBlockToPage(childId, page.id);
          }
          router.push(pageHref(page.id));
        });
    },

    createPageLink(id) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur) return;
      const rawQuery = spansToPlainText(cur.content?.rich).trim();
      const query = rawQuery.toLowerCase();
      const pages = Object.values(st.pagesById).filter((page) => !page.inTrash);
      const match =
        query.length > 0
          ? pages.find((page) => pageDisplayTitle(page).toLowerCase() === query) ??
            pages.find((page) => pageDisplayTitle(page).toLowerCase().includes(query))
          : undefined;
      st.updateBlock(id, {
        type: "link_to_page",
        content: { childPageId: match?.id },
        plainText: match ? pageDisplayTitle(match) : rawQuery,
      });
      setSelectedBlockId(id);
    },

    async createDatabase(id, viewType = "table") {
      if (readOnly) return undefined;
      const st = useStore.getState();
      const cur = id ? blockById(id) : undefined;
      if (templateMode) {
        if (id && cur) {
          st.updateBlock(
            id,
            {
              type: "inline_database",
              content: { rich: [] },
              plainText: inlineDatabasePlaceholderTitle(),
            },
            { history: false }
          );
          setSelectedBlockId(null);
        }
        return undefined;
      }
      const title = databaseTitleFromBlock(cur);
      if (id) st.captureBlockHistory(pageId);
      const db = await st.createDatabase({
        parentId: pageId,
        parentType: "page",
        title,
        viewType,
        seedRows: false,
        properties: blankDatabaseProperties(),
      });
      if (id) {
        st.updateBlock(
          id,
          {
            type: "child_database",
            content: { childPageId: db.id },
            plainText: db.title,
          },
          { history: false }
        );
      }
      st.setFocusPageId(db.id, "title");
      router.push(pageHref(db.id));
      return db;
    },

    async createInlineDatabase(id, viewType = "table") {
      if (readOnly) return undefined;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur) return undefined;
      if (templateMode) {
        st.updateBlock(
          id,
          {
            type: "inline_database",
            content: { rich: [] },
            plainText: inlineDatabasePlaceholderTitle(),
          },
          { history: false }
        );
        setSelectedBlockId(null);
        return undefined;
      }
      // Keep the persisted database title empty. The locale-aware "New
      // database" copy belongs to the title input's placeholder; storing it as
      // content turns display chrome into user data and breaks language
      // switching as well as immediate rename semantics.
      const title = databaseTitleFromBlock(cur);
      st.captureBlockHistory(pageId);
      const db = await st.createDatabase({
        parentId: pageId,
        parentType: "page",
        title,
        viewType,
        seedRows: false,
        properties: blankDatabaseProperties(),
      });
      st.updateBlock(
        id,
        {
          type: "inline_database",
          content: { childPageId: db.id, autoFocusDatabaseTitle: true },
          plainText: db.title,
        },
        { history: false }
      );
      setSelectedBlockId(null);
      return db;
    },

    linkDatabase(id, databaseId, type, viewType = "table") {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      const db = st.pagesById[databaseId];
      if (!cur || !db || db.kind !== "database" || db.inTrash) return;
      const matchingView = (st.viewsByDb[databaseId] ?? []).find((view) => view.type === viewType);
      st.captureBlockHistory(pageId);
      st.updateBlock(
        id,
        {
          type,
          content: {
            childPageId: db.id,
            ...(type === "inline_database" ? { linkedDatabaseSource: true } : {}),
            ...(type === "inline_database" && matchingView
              ? { databaseViewId: matchingView.id }
              : {}),
          },
          plainText: pageDisplayTitle(db),
        },
        { history: false }
      );
      setSelectedBlockId(type === "inline_database" ? null : id);
      if (type === "child_database") router.push(pageHref(db.id));
    },

    createColumns(id, count) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur) return;
      const columnCount = Math.max(2, Math.min(5, Math.floor(count)));
      const rich = cur.content?.rich ?? [];
      let firstParagraph: Block | undefined;
      const createdBlocks: Block[] = [];

      st.captureBlockHistory(pageId);
      flushSync(() => {
        st.updateBlock(
          id,
          {
            type: "column_list",
            content: { rich: [] },
            plainText: "",
          },
          { history: false }
        );

        let lastColumnPosition: number | undefined;
        for (let index = 0; index < columnCount; index++) {
          const columnPosition = positionBetween(lastColumnPosition, undefined);
          const column = st.addBlockLocal({
            pageId,
            parentId: id,
            type: "column",
            content: { width: 1 / columnCount },
            position: columnPosition,
            history: false,
            persist: false,
          });
          createdBlocks.push(column);
          lastColumnPosition = columnPosition;

          const paragraph = st.addBlockLocal({
            pageId,
            parentId: column.id,
            type: "paragraph",
            content: { rich: index === 0 ? rich : [] },
            position: 1,
            history: false,
            persist: false,
          });
          createdBlocks.push(paragraph);
          if (index === 0) firstParagraph = paragraph;
        }
      });

      if (!templateMode) void st.persistBlockCreateBatch(createdBlocks);
      if (firstParagraph) focusEditableSettled(firstParagraph.id, "end");
    },

    createSimpleTable(id) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur) return;
      const firstCell = spansToPlainText(cur.content?.rich).trim();
      const table = [
        [firstCell, ""],
        ["", ""],
      ];
      st.updateBlock(id, {
        type: "simple_table",
        content: { table, headerRow: true, headerColumn: false },
        plainText: table.flat().join("\n"),
      });
      focusBlockControlSettled(id, `[data-table-cell="${id}:0:0"]`);
    },

    createEquation(id) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur) return;
      const expression = spansToPlainText(cur.content?.rich).trim();
      st.updateBlock(id, {
        type: "equation",
        content: { expression },
        plainText: expression,
      });
      focusBlockControlSettled(id, `textarea[data-equation-input="${id}"]`);
    },

    createSyncedBlock(id) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur) return;
      const rich = cur.content?.rich ?? [];
      const existingChildren = siblings(id);
      const firstPosition = existingChildren[0]?.position;
      const childPosition = positionBetween(undefined, firstPosition);
      let firstChild: Block | undefined;

      st.captureBlockHistory(pageId);
      flushSync(() => {
        st.updateBlock(
          id,
          {
            type: "synced_block",
            content: { rich: [] },
            plainText: "",
          },
          { history: false }
        );
        if (rich.length > 0 || existingChildren.length === 0) {
          firstChild = st.addBlockLocal({
            pageId,
            parentId: id,
            type: "paragraph",
            content: { rich },
            position: childPosition,
            history: false,
          });
        }
      });

      if (firstChild) focusEditableSettled(firstChild.id, "end");
    },

    createSyncedBlockCopy(id) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur || cur.type !== "synced_block") return;
      const sourceId = cur.content?.syncedBlockId ?? cur.id;
      const sourcePageId = cur.content?.syncedPageId ?? cur.pageId;
      const list = siblings(cur.parentId);
      const idx = list.findIndex((b) => b.id === cur.id);
      const next = list[idx + 1];
      st.captureBlockHistory(pageId);
      st.addBlockLocal({
        pageId,
        parentId: cur.parentId ?? null,
        type: "synced_block",
        content: { rich: [], syncedBlockId: sourceId, syncedPageId: sourcePageId },
        position: positionBetween(cur.position, next?.position),
        history: false,
      });
    },

    async unsyncSyncedBlock(id) {
      if (readOnly) return [];
      let st = useStore.getState();
      const cur = blockById(id);
      if (!cur || cur.type !== "synced_block" || !cur.content?.syncedBlockId) return [];

      const sourceId = cur.content.syncedBlockId;
      const sourcePageId = cur.content.syncedPageId ?? cur.pageId;
      await st.loadBlocks(sourcePageId);

      st = useStore.getState();
      const current = (st.blocksByPage[pageId] ?? []).find((block) => block.id === id);
      if (!current) return [];

      const sourceBlocks = st.blocksByPage[sourcePageId] ?? [];
      const sourceRootChildren = sourceBlocks
        .filter((block) => block.parentId === sourceId)
        .sort((a, b) => a.position - b.position);
      const childrenOf = (sourceBlockId: string) =>
        sourceBlocks
          .filter((block) => block.parentId === sourceBlockId)
          .sort((a, b) => a.position - b.position);
      const currentChildren = (st.blocksByPage[pageId] ?? []).filter((block) => block.parentId === id);

      if (blockTreesHaveStoredFiles(sourceRootChildren, sourceBlocks)) {
        notifyStoredFileCloneBlocked();
        return [];
      }

      st.captureBlockHistory(pageId);
      for (const child of currentChildren) {
        await st.deleteBlock(child.id, { history: false });
      }

      if (sourceRootChildren.length === 0) {
        st.updateBlock(
          id,
          { type: "paragraph", content: { rich: [] }, plainText: "" },
          { history: false }
        );
        setSelectedBlockId(id);
        requestAnimationFrame(() => focusEditableSettled(id, "end"));
        return [current];
      }

      const parentId = current.parentId ?? null;
      const nextSibling = (useStore.getState().blocksByPage[pageId] ?? [])
        .filter((block) => (block.parentId ?? null) === parentId && block.id !== id)
        .sort((a, b) => a.position - b.position)
        .find((block) => block.position > current.position);
      const copiedRoots: Block[] = [];

      const cloneTree = (
        sourceBlock: Block,
        nextParentId: string | null,
        position: number
      ): Block => {
        const copy = st.addBlockLocal({
          pageId,
          parentId: nextParentId,
          type: sourceBlock.type,
          content: cloneContent(sourceBlock.content ?? { rich: [] }),
          position,
          history: false,
        });
        if (sourceBlock.plainText !== copy.plainText) {
          st.updateBlock(copy.id, { plainText: sourceBlock.plainText }, { history: false });
        }
        for (const child of childrenOf(sourceBlock.id)) {
          cloneTree(child, copy.id, child.position);
        }
        return copy;
      };

      const [firstSource, ...restSources] = sourceRootChildren;
      st.updateBlock(
        id,
        {
          type: firstSource.type,
          content: cloneContent(firstSource.content ?? { rich: [] }),
          plainText: firstSource.plainText,
        },
        { history: false }
      );
      for (const child of childrenOf(firstSource.id)) {
        cloneTree(child, id, child.position);
      }
      copiedRoots.push({
        ...current,
        type: firstSource.type,
        content: cloneContent(firstSource.content ?? { rich: [] }),
        plainText: firstSource.plainText,
      });

      let previousPosition = current.position;
      for (const sourceBlock of restSources) {
        const position = positionBetween(previousPosition, nextSibling?.position);
        const copy = cloneTree(sourceBlock, parentId, position);
        copiedRoots.push(copy);
        previousPosition = position;
      }

      setSelectedBlockIdState(id);
      setSelectedBlockIds(new Set(copiedRoots.map((block) => block.id)));
      selectionFocusRef.current = id;
      if (TEXT_BLOCKS.has(firstSource.type)) {
        requestAnimationFrame(() => focusEditableSettled(id, "end"));
      }
      return copiedRoots;
    },

    createButton(id) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur) return;
      const label = spansToPlainText(cur.content?.rich).trim() || "New button";
      st.updateBlock(id, {
        type: "button",
        content: {
          rich: [],
          buttonLabel: label,
          buttonTemplate: defaultButtonTemplate(),
        },
        plainText: label,
      });
      ops.insertAfter(id, "paragraph");
    },

    createTab(id) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur) return;
      const label = spansToPlainText(cur.content?.rich).trim() || "Tab 1";
      let firstTabBody: Block | undefined;
      const createdBlocks: Block[] = [];

      st.captureBlockHistory(pageId);
      flushSync(() => {
        st.updateBlock(
          id,
          {
            type: "tab",
            content: { rich: [] },
            plainText: "",
          },
          { history: false }
        );

        const firstTabPosition = positionBetween(undefined, undefined);
        const firstTab = st.addBlockLocal({
          pageId,
          parentId: id,
          type: "paragraph",
          content: { rich: [{ text: label }] },
          position: firstTabPosition,
          history: false,
          persist: false,
        });
        createdBlocks.push(firstTab);

        firstTabBody = st.addBlockLocal({
          pageId,
          parentId: firstTab.id,
          type: "paragraph",
          content: { rich: [] },
          position: 1,
          history: false,
          persist: false,
        });
        createdBlocks.push(firstTabBody);

        const secondTab = st.addBlockLocal({
          pageId,
          parentId: id,
          type: "paragraph",
          content: { rich: [{ text: "Tab 2" }] },
          position: positionBetween(firstTabPosition, undefined),
          history: false,
          persist: false,
        });
        createdBlocks.push(secondTab);
      });

      if (!templateMode) void st.persistBlockCreateBatch(createdBlocks);
      if (firstTabBody) focusEditableSettled(firstTabBody.id, "end");
    },

    runButton(id) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur) return;
      const hasImportedPartialButton = cur.content?.notionButtonPartial === true;
      if (hasImportedPartialButton && (!cur.content?.buttonTemplate || cur.content.buttonTemplate.length === 0)) {
        return;
      }
      const template =
        cur.content?.buttonTemplate && cur.content.buttonTemplate.length > 0
          ? cur.content.buttonTemplate
          : defaultButtonTemplate();
      if (hasStoredFileReference(template)) {
        notifyStoredFileCloneBlocked();
        return;
      }
      const list = siblings(cur.parentId);
      const idx = list.findIndex((b) => b.id === cur.id);
      const next = list[idx + 1];
      let previousPosition = cur.position;
      let first: Block | undefined;

      st.captureBlockHistory(pageId);
      flushSync(() => {
        for (const item of template) {
          const position = positionBetween(previousPosition, next?.position);
          const inserted = insertTemplateBlock(item, cur.parentId ?? null, position);
          first ??= inserted;
          previousPosition = position;
        }
      });

      if (first) focusOrSelectBlock(first.id, first.type, "end");

      function insertTemplateBlock(
        item: ButtonTemplateBlock,
        parentId: string | null,
        position: number
      ): Block {
        const inserted = st.addBlockLocal({
          pageId,
          parentId,
          type: item.type,
          content: cloneContent(item.content ?? { rich: [] }),
          position,
          history: false,
        });
        let childPosition: number | undefined;
        for (const child of item.children ?? []) {
          const nextChildPosition = positionBetween(childPosition, undefined);
          insertTemplateBlock(child, inserted.id, nextChildPosition);
          childPosition = nextChildPosition;
        }
        return inserted;
      }
    },

    captureNextBlockToButton(id) {
      if (readOnly) return;
      const st = useStore.getState();
      const cur = blockById(id);
      if (!cur || cur.type !== "button") return;
      const list = siblings(cur.parentId);
      const idx = list.findIndex((b) => b.id === cur.id);
      const source = list[idx + 1];
      if (!source) return;
      const template =
        cur.content?.buttonTemplate && cur.content.buttonTemplate.length > 0
          ? cur.content.buttonTemplate
          : cur.content?.notionButtonPartial === true
            ? []
            : defaultButtonTemplate();
      const allBlocks = st.blocksByPage[pageId] ?? [];
      const childrenOf = (sourceId: string) =>
        allBlocks
          .filter((candidate) => candidate.parentId === sourceId)
          .sort((a, b) => a.position - b.position);
      const cloneTemplate = (sourceBlock: Block): ButtonTemplateBlock => ({
        type: sourceBlock.type,
        content: cloneContent(sourceBlock.content ?? { rich: [] }),
        children: childrenOf(sourceBlock.id).map(cloneTemplate),
      });

      if (blockTreesHaveStoredFiles([source], allBlocks)) {
        notifyStoredFileCloneBlocked();
        return;
      }

      st.updateBlock(id, {
        content: {
          ...cur.content,
          rich: [],
          buttonLabel: cur.content?.buttonLabel ?? cur.plainText ?? "New button",
          buttonTemplate: [...template, cloneTemplate(source)],
          notionButtonPartial: undefined,
        },
      });
    },
    publishAwareness: publishEditorAwareness,
    remoteAwarenessByBlock,
  };

  // Keystrokes replace the edited block and re-render the Editor; if `ops`
  // were the fresh object above, every memoized <BlockItem> would re-render on
  // every keystroke. Instead expose a facade whose identity changes only when
  // the data it carries (selection, menus, awareness) changes. Its methods
  // delegate through `opsRef`, so even a memo-frozen BlockItem always invokes
  // the latest handler implementations — no stale closures.
  const opsRef = useRef(opsImpl);
  useLayoutEffect(() => {
    opsRef.current = opsImpl;
  });
  const ops = useMemo<EditorOps>(
    () => ({
      pageId,
      readOnly,
      templateMode,
      publicReadOnly,
      sharedToken,
      selectedBlockId,
      selectedBlockIds,
      blockActionMenuFor,
      remoteAwarenessByBlock,
      selectBlock: (id) => opsRef.current.selectBlock(id),
      selectAllBlocks: (anchorId) => opsRef.current.selectAllBlocks(anchorId),
      openBlockActionMenu: (id) => opsRef.current.openBlockActionMenu(id),
      openMoveDialog: (id) => opsRef.current.openMoveDialog(id),
      selectAdjacentBlock: (id, direction) => opsRef.current.selectAdjacentBlock(id, direction),
      selectEdgeBlock: (edge) => opsRef.current.selectEdgeBlock(edge),
      extendSelection: (id, direction) => opsRef.current.extendSelection(id, direction),
      extendSelectionToEdge: (id, edge) => opsRef.current.extendSelectionToEdge(id, edge),
      deleteSelectedBlocks: () => opsRef.current.deleteSelectedBlocks(),
      moveSelectedBlock: (id, direction) => opsRef.current.moveSelectedBlock(id, direction),
      moveSelectedBlocks: (id, direction) => opsRef.current.moveSelectedBlocks(id, direction),
      copyBlock: (id) => opsRef.current.copyBlock(id),
      copySelectedBlocks: (id) => opsRef.current.copySelectedBlocks(id),
      cutBlock: (id) => opsRef.current.cutBlock(id),
      cutSelectedBlocks: (id) => opsRef.current.cutSelectedBlocks(id),
      duplicateBlock: (id) => opsRef.current.duplicateBlock(id),
      duplicateSelectedBlocks: (id) => opsRef.current.duplicateSelectedBlocks(id),
      setSelectedBlockColor: (id, token) => opsRef.current.setSelectedBlockColor(id, token),
      toggleSelectedBlockState: (id) => opsRef.current.toggleSelectedBlockState(id),
      toggleSelectedTextMark: (id, mark) => opsRef.current.toggleSelectedTextMark(id, mark),
      insertBlocksAfter: (id, pasted) => opsRef.current.insertBlocksAfter(id, pasted),
      replaceSelectedBlocks: (id, pasted) => opsRef.current.replaceSelectedBlocks(id, pasted),
      removeSelectedBlock: (id) => opsRef.current.removeSelectedBlock(id),
      setText: (id, spans) => opsRef.current.setText(id, spans),
      changeType: (id, type, caret) => opsRef.current.changeType(id, type, caret),
      changeSelectedType: (id, type, caret) => opsRef.current.changeSelectedType(id, type, caret),
      splitBlock: (id, before, after) => opsRef.current.splitBlock(id, before, after),
      backspace: (id, curSpans) => opsRef.current.backspace(id, curSpans),
      deleteForward: (id, curSpans) => opsRef.current.deleteForward(id, curSpans),
      arrowUp: (id) => opsRef.current.arrowUp(id),
      arrowDown: (id) => opsRef.current.arrowDown(id),
      indentBlock: (id, opts) => opsRef.current.indentBlock(id, opts),
      outdentBlock: (id, opts) => opsRef.current.outdentBlock(id, opts),
      indentSelectedBlocks: (id) => opsRef.current.indentSelectedBlocks(id),
      outdentSelectedBlocks: (id) => opsRef.current.outdentSelectedBlocks(id),
      moveBlock: (id, targetId, placement) => opsRef.current.moveBlock(id, targetId, placement),
      moveSelectedBlocksTo: (id, targetId, placement) =>
        opsRef.current.moveSelectedBlocksTo(id, targetId, placement),
      copySelectedBlocksTo: (id, targetId, placement) =>
        opsRef.current.copySelectedBlocksTo(id, targetId, placement),
      moveSelectedBlocksToPage: (id, targetPageId) =>
        opsRef.current.moveSelectedBlocksToPage(id, targetPageId),
      uploadDroppedFiles: (files, targetId, placement) =>
        opsRef.current.uploadDroppedFiles(files, targetId, placement),
      insertAfter: (id, type) => opsRef.current.insertAfter(id, type),
      insertChildBlock: (parentId, type) => opsRef.current.insertChildBlock(parentId, type),
      replaceWithBlocks: (id, pasted) => opsRef.current.replaceWithBlocks(id, pasted),
      remove: (id) => opsRef.current.remove(id),
      createChildPage: (id) => opsRef.current.createChildPage(id),
      createPageLink: (id) => opsRef.current.createPageLink(id),
      createDatabase: (id, viewType) => opsRef.current.createDatabase(id, viewType),
      createInlineDatabase: (id, viewType) => opsRef.current.createInlineDatabase(id, viewType),
      linkDatabase: (id, databaseId, type, viewType) =>
        opsRef.current.linkDatabase(id, databaseId, type, viewType),
      createColumns: (id, count) => opsRef.current.createColumns(id, count),
      createSimpleTable: (id) => opsRef.current.createSimpleTable(id),
      createEquation: (id) => opsRef.current.createEquation(id),
      createSyncedBlock: (id) => opsRef.current.createSyncedBlock(id),
      createSyncedBlockCopy: (id) => opsRef.current.createSyncedBlockCopy(id),
      unsyncSyncedBlock: (id) => opsRef.current.unsyncSyncedBlock(id),
      createButton: (id) => opsRef.current.createButton(id),
      createTab: (id) => opsRef.current.createTab(id),
      runButton: (id) => opsRef.current.runButton(id),
      captureNextBlockToButton: (id) => opsRef.current.captureNextBlockToButton(id),
      publishAwareness: (blockId, mode, selectedIds, textRange) =>
        opsRef.current.publishAwareness(blockId, mode, selectedIds, textRange),
    }),
    [
      blockActionMenuFor,
      pageId,
      publicReadOnly,
      readOnly,
      remoteAwarenessByBlock,
      selectedBlockId,
      selectedBlockIds,
      sharedToken,
      templateMode,
    ]
  );

  const dismissPageStarter = useCallback(() => {
    setDismissedStarterBlockId(pagePlaceholderBlockId);
  }, [pagePlaceholderBlockId]);

  return (
    <div
      ref={editorRef}
      className={styles.editor}
      data-editor-page={pageId}
      data-page-starter-visible={pageStarterVisible ? "true" : undefined}
      data-empty-body-prompt-visible={emptyBodyPromptVisible ? "true" : undefined}
      data-file-drop-active={fileDropIndicator ? "true" : undefined}
      role="region"
      aria-label={t("editor:content.pageBody")}
      onMouseDown={onEditorBlankMouseDown}
      onPointerDown={onEditorPointerDown}
      onDragOverCapture={onEditorFileDragOverCapture}
      onDragOver={onEditorFileDragOver}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setFileDropIndicator(null);
      }}
      onDrop={onEditorFileDrop}
    >
      {contentLoadingVisible && <EditorContentLoadingFallback />}
      {blocks.map((b) => (
        <BlockItem
          key={b.id}
          block={b}
          ops={ops}
          pagePlaceholder={b.id === pagePlaceholderBlockId}
          pagePlaceholderText={
            b.id === pagePlaceholderBlockId && emptyBodyPromptVisible
              ? emptyBodyPrompt
              : undefined
          }
          onPagePlaceholderInput={
            b.id === pagePlaceholderBlockId ? dismissPageStarter : undefined
          }
        />
      ))}
      {fileDropIndicator && (
        <div
          className={styles.editorFileDropIndicator}
          data-editor-file-drop-indicator={fileDropIndicator.placement}
          aria-hidden="true"
          style={{
            top: fileDropIndicator.top,
            left: fileDropIndicator.left,
            width: fileDropIndicator.width,
          }}
        />
      )}
      {pageStarterVisible && pagePlaceholderBlockId && (
        <PageStarter
          ops={ops}
          blockId={pagePlaceholderBlockId}
          onDismiss={() => setDismissedStarterBlockId(pagePlaceholderBlockId)}
        />
      )}
      <div className={styles.editorTail} data-editor-tail aria-hidden="true" />
      {Object.keys(fileUploadProgressByBlock).length > 0 && (
        <div className={styles.editorFileUploadQueue}>
          {Object.entries(fileUploadProgressByBlock).map(([blockId, progress]) => (
            <EditorFileUploadProgress
              key={blockId}
              blockId={blockId}
              progress={progress}
            />
          ))}
        </div>
      )}
      {marquee && (
        <div
          className={styles.selectionMarquee}
          aria-hidden="true"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      )}
      {moveDialogFor && !templateMode && (
        <BlockMoveToDialog
          blockId={moveDialogFor}
          sourcePageId={pageId}
          title={t("editor:moveBlocksTo", {
            count:
              selectedBlockIds.has(moveDialogFor) && selectedBlockIds.size > 1
                ? selectedBlockIds.size
                : 1,
          })}
          onChooseDestination={async (destinationPageId) => {
            await ops.moveSelectedBlocksToPage(moveDialogFor, destinationPageId);
          }}
          onClose={() => setMoveDialogFor(null)}
        />
      )}
      {/* Comment-role users are read-only for blocks but may still comment on a
          selection, so show the toolbar in comment-only mode when canComment. */}
      {(!readOnly || canComment) && <SelectionToolbar commentOnly={readOnly} />}
      {!readOnly && <BlockSelectionToolbar ops={ops} />}
    </div>
  );
}

function BlockSelectionToolbar({ ops }: { ops: EditorOps }) {
  const { t } = useTranslation(["editor", "common"]);
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const [menuState, setMenuState] = useState<{ key: string; kind: "turn" | "color" } | null>(null);
  const [moveDialogFor, setMoveDialogFor] = useState<string | null>(null);
  const blocks = useStore((s) => s.blocksByPage[ops.pageId] ?? EMPTY_BLOCKS);
  const openComments = useStore((s) => s.openComments);
  const notify = useStore((s) => s.notify);
  const undoBlockChange = useStore((s) => s.undoBlockChange);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const count = ops.selectedBlockIds.size;
  const anchorId = ops.selectedBlockId ?? Array.from(ops.selectedBlockIds)[0];
  const selectionKey = anchorId ? `${anchorId}:${count}` : "";
  const copied = copiedFor === selectionKey;
  const menu = menuState?.key === selectionKey ? menuState.kind : null;
  const moveDialog = moveDialogFor === selectionKey;
  const selectedBlocks = blocks.filter((block) => ops.selectedBlockIds.has(block.id));
  const hasMarkableSelectedText = selectedBlocks.some(
    (block) =>
      block.type !== "code" &&
      TEXT_BLOCKS.has(block.type) &&
      spansToPlainText(block.content?.rich).length > 0
  );

  useEffect(() => {
    if (!menu) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("[data-block-selection-menu-item]")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (toolbarRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuState(null);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menu]);

  if (count <= 1 || !anchorId) return null;

  async function copySelection() {
    if (!anchorId) return;
    const ok = await ops.copySelectedBlocks(anchorId);
    if (!ok) {
      notify(t("editor:couldntCopy"), "error");
      return;
    }
    setCopiedFor(selectionKey);
    window.setTimeout(() => setCopiedFor((current) => (current === selectionKey ? null : current)), 1400);
    notify(t("editor:copiedToClipboard"), "success");
  }

  async function duplicateSelection() {
    if (!anchorId) return;
    const copies = await ops.duplicateSelectedBlocks(anchorId);
    if (copies.length > 0) {
      notify(t("editor:duplicatedBlocks", { count: copies.length }), "success", {
        label: t("editor:undo"),
        onClick: async () => {
          const restored = await undoBlockChange(ops.pageId);
          notify(restored ? t("editor:undidDuplicate") : t("editor:nothingToUndo"), restored ? "success" : "default");
        },
      });
    }
  }

  function deleteSelection() {
    ops.deleteSelectedBlocks();
    notify(t("editor:deletedBlocks", { count }), "success", {
      label: t("editor:undo"),
      onClick: async () => {
        const restored = await undoBlockChange(ops.pageId);
        notify(restored ? t("editor:restoredBlocks") : t("editor:nothingToUndo"), restored ? "success" : "default");
      },
    });
  }

  function turnSelection(type: BlockType) {
    ops.changeSelectedType(anchorId, type);
    setMenuState(null);
    notify(t("editor:changedBlockType"), "success");
  }

  function colorSelection(token: string) {
    rememberEditorColor(token);
    const changed = ops.setSelectedBlockColor(anchorId, token);
    setMenuState(null);
    if (changed) notify(token === "default" ? t("editor:clearedColor") : t("editor:changedColor"), "success");
  }

  function quoteSelectedBlocks() {
    const lines = selectedBlocks
      .sort((a, b) => a.position - b.position)
      .map((block) => spansToPlainText(block.content?.rich).trim() || block.plainText || block.type)
      .filter(Boolean);
    const quote = lines.slice(0, 6).join("\n");
    const suffix = lines.length > 6 ? "\n..." : "";
    return quote ? `${quote}${suffix}` : t("editor:toolbar.quoteFallback", { count });
  }

  function commentSelection() {
    setMenuState(null);
    openComments(ops.pageId, anchorId, { quote: quoteSelectedBlocks() });
  }

  function toolbarButtons() {
    return Array.from(
      toolbarRef.current?.querySelectorAll<HTMLButtonElement>(`button.${styles.tbBtn}`) ?? []
    ).filter((button) => !button.disabled);
  }

  function menuItems() {
    return Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("[data-block-selection-menu-item]") ?? []
    ).filter((item) => !item.disabled && item.getClientRects().length > 0);
  }

  function onToolbarKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setMenuState(null);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const buttons = toolbarButtons();
    if (buttons.length === 0) return;
    e.preventDefault();
    const index = buttons.findIndex((button) => button === document.activeElement);
    const current = index >= 0 ? index : 0;
    let nextIndex = current;
    if (e.key === "ArrowRight") nextIndex = (current + 1) % buttons.length;
    else if (e.key === "ArrowLeft") nextIndex = current > 0 ? current - 1 : buttons.length - 1;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = buttons.length - 1;
    buttons[nextIndex]?.focus();
  }

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMenuState(null);
      toolbarRef.current?.querySelector<HTMLButtonElement>("[aria-expanded='true']")?.focus();
      return;
    }
    if (!["Tab", "ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(e.key)) return;
    const items = menuItems();
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const index = items.findIndex((item) => item === document.activeElement);
    const current = index >= 0 ? index : 0;
    let nextIndex = current;
    if (e.key === "Tab") {
      nextIndex =
        index < 0 ? 0 : (index + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    } else if (e.key === "ArrowDown") nextIndex = (current + 1) % items.length;
    else if (e.key === "ArrowUp") nextIndex = current > 0 ? current - 1 : items.length - 1;
    else if (e.key === "PageDown") nextIndex = Math.min(current + 6, items.length - 1);
    else if (e.key === "PageUp") nextIndex = Math.max(current - 6, 0);
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = items.length - 1;
    items[nextIndex]?.focus();
    items[nextIndex]?.scrollIntoView({ block: "nearest" });
  }

  return (
    <>
      {moveDialog && !ops.templateMode && (
        <BlockMoveToDialog
          blockId={anchorId}
          sourcePageId={ops.pageId}
          title={t("editor:moveBlocksTo", { count })}
          onChooseDestination={async (destinationPageId) => {
            await ops.moveSelectedBlocksToPage(anchorId, destinationPageId);
          }}
          onClose={() => setMoveDialogFor(null)}
        />
      )}
      {menu === "turn" && (
        <div
          ref={menuRef}
          className={styles.blockSelectionMenu}
          role="menu"
          tabIndex={-1}
          aria-label={t("editor:toolbar.turnSelectedInto")}
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={onMenuKeyDown}
        >
          <div className={styles.tbColorLabel}>{t("editor:toolbar.turnInto")}</div>
          {BLOCK_SELECTION_TURN_TYPES.map((type) => {
            const def = BLOCK_DEFS.find((item) => item.type === type);
            return (
              <button
                key={type}
                type="button"
                className={styles.tbTurnItem}
                role="menuitem"
                data-block-selection-menu-item
                onClick={() => turnSelection(type)}
              >
                <span className={styles.tbTurnGlyph} aria-hidden="true">
                  <BlockIcon def={def} type={type} glyph={def?.glyph} size={15} />
                </span>
                <span>{def?.label ?? type}</span>
              </button>
            );
          })}
        </div>
      )}
      {menu === "color" && (
        <div
          ref={menuRef}
          className={styles.blockSelectionMenu}
          role="menu"
          tabIndex={-1}
          aria-label={t("editor:toolbar.colorSelected")}
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={onMenuKeyDown}
        >
          <div className={styles.tbColorLabel}>{t("editor:toolbar.textColor")}</div>
          {BLOCK_SELECTION_TEXT_COLORS.map((color) => (
            <button
              key={color.token}
              type="button"
              className={styles.tbColorItem}
              role="menuitem"
              data-block-selection-menu-item
              onClick={() => colorSelection(color.token)}
            >
              <span className={styles.colorSwatch} data-color={color.token}>
                A
              </span>
              <span>{t(`editor:colors.${color.token}`)}</span>
            </button>
          ))}
          <div className={styles.tbColorLabel}>{t("editor:toolbar.backgroundColor")}</div>
          {BLOCK_SELECTION_BACKGROUND_COLORS.map((color) => (
            <button
              key={color.token}
              type="button"
              className={styles.tbColorItem}
              role="menuitem"
              data-block-selection-menu-item
              onClick={() => colorSelection(color.token)}
            >
              <span className={styles.colorSwatch} data-color={color.token}>
                A
              </span>
              <span>{t(`editor:colors.${color.token}`)}</span>
            </button>
          ))}
        </div>
      )}
      <div
        ref={toolbarRef}
        className={styles.blockSelectionToolbar}
        role="toolbar"
        aria-label={t("editor:toolbar.selectedBlocks")}
        onMouseDown={(e) => e.preventDefault()}
        onKeyDown={onToolbarKeyDown}
      >
        <span className={styles.blockSelectionCount}>{t("editor:toolbar.countSelected", { count })}</span>
        <button
          type="button"
          className={`${styles.tbBtn} ${styles.blockSelectionDanger}`}
          onClick={deleteSelection}
        >
          {t("common:actions.delete")}
          <span className={styles.tbShortcut}>Del</span>
        </button>
        <button
          type="button"
          className={styles.tbBtn}
          onClick={() => void duplicateSelection()}
        >
          {t("editor:toolbar.duplicate")}
          <span className={styles.tbShortcut}>⌘D</span>
        </button>
        <button
          type="button"
          className={`${styles.tbBtn} ${styles.tbTurn}`}
          aria-expanded={menu === "turn"}
          onClick={() =>
            setMenuState((current) =>
              current?.key === selectionKey && current.kind === "turn"
                ? null
                : { key: selectionKey, kind: "turn" }
            )
          }
        >
          {t("editor:toolbar.turnInto")}
          <span className={styles.tbTurnCaret} aria-hidden="true">
            <ChevronDown size={12} />
          </span>
        </button>
        <span className={styles.tbDivider} aria-hidden="true" />
        <button type="button" className={styles.tbBtn} onClick={copySelection}>
          {copied ? t("editor:toolbar.copied") : t("editor:toolbar.copy")}
          <span className={styles.tbShortcut}>⌘C</span>
        </button>
        <button
          type="button"
          className={`${styles.tbBtn} ${styles.tbTurn}`}
          aria-expanded={menu === "color"}
          onClick={() =>
            setMenuState((current) =>
              current?.key === selectionKey && current.kind === "color"
                ? null
                : { key: selectionKey, kind: "color" }
            )
          }
        >
          {t("editor:toolbar.color")}
          <span className={styles.tbTurnCaret} aria-hidden="true">
            <ChevronDown size={12} />
          </span>
        </button>
        {!ops.templateMode && (
          <button
            type="button"
            className={styles.tbBtn}
            onClick={() => {
              setMenuState(null);
              setMoveDialogFor(selectionKey);
            }}
          >
            {t("editor:toolbar.moveTo")}
          </button>
        )}
        {!ops.templateMode && (
          <button type="button" className={styles.tbBtn} onClick={commentSelection}>
            {t("editor:toolbar.comment")}
          </button>
        )}
        <span className={styles.tbDivider} aria-hidden="true" />
        <button
          type="button"
          className={`${styles.tbBtn} ${styles.tbBold}`}
          aria-label={t("editor:toolbar.bold")}
          disabled={!hasMarkableSelectedText}
          onClick={() => ops.toggleSelectedTextMark(anchorId, "bold")}
        >
          B
        </button>
        <button
          type="button"
          className={`${styles.tbBtn} ${styles.tbItalic}`}
          aria-label={t("editor:toolbar.italic")}
          disabled={!hasMarkableSelectedText}
          onClick={() => ops.toggleSelectedTextMark(anchorId, "italic")}
        >
          I
        </button>
        <button
          type="button"
          className={`${styles.tbBtn} ${styles.tbUnderline}`}
          aria-label={t("editor:toolbar.underline")}
          disabled={!hasMarkableSelectedText}
          onClick={() => ops.toggleSelectedTextMark(anchorId, "underline")}
        >
          U
        </button>
        <button
          type="button"
          className={`${styles.tbBtn} ${styles.tbStrike}`}
          aria-label={t("editor:toolbar.strikethrough")}
          disabled={!hasMarkableSelectedText}
          onClick={() => ops.toggleSelectedTextMark(anchorId, "strikethrough")}
        >
          S
        </button>
        <button
          type="button"
          className={styles.tbBtn}
          aria-label={t("editor:toolbar.code")}
          disabled={!hasMarkableSelectedText}
          onClick={() => ops.toggleSelectedTextMark(anchorId, "code")}
        >
          {"</>"}
        </button>
      </div>
    </>
  );
}

function currentContent(id: string) {
  const st = useStore.getState();
  for (const pid of Object.keys(st.blocksByPage)) {
    const b = st.blocksByPage[pid].find((x) => x.id === id);
    if (b) return b.content ?? {};
  }
  return {};
}

function defaultButtonTemplate(): ButtonTemplateBlock[] {
  return [{ type: "to_do", content: { rich: [{ text: "New task" }], checked: false } }];
}

function cloneContent(content: BlockContent): BlockContent {
  if (typeof structuredClone === "function") return structuredClone(content);
  return JSON.parse(JSON.stringify(content)) as BlockContent;
}
