"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";

import { positionBetween } from "@/lib/ids";
import { activeDateLocale } from "@/lib/i18n";
import { i18next } from "@/i18n";
import { useStore } from "@/lib/store";
import type { Block, Comment } from "@/lib/types";
import { spansToPlainText } from "@/lib/types";
import { nextCover } from "@/lib/covers";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { isPageVerified } from "@/lib/pageVerification";
import { EmojiPicker } from "./EmojiPicker";
import { PageIconGlyph } from "./PageIcon";
import { PageBacklinks } from "./PageBacklinks";
import {
  focusEditable,
  isCaretAtEnd,
  isEditableFullySelected,
  placeCaret,
  registerEditable,
  selectEditableContents,
} from "./editor/focus";
import { TEXT_BLOCKS } from "./editor/textBlockTypes";
import { parsePastedMarkdown, type PastedBlock } from "./editor/markdownPaste";
import { requestPageStarterDismiss } from "./editor/pageStarterDismiss";
import { CheckIcon, CommentIcon, ImageIcon, SmileIcon } from "@/icons/hanji";
import { actorLabel } from "./database/people";
import styles from "./PageHeader.module.css";

const EMPTY_COMMENTS: Comment[] = [];
const EDITOR_SELECTION_REQUEST = "hanji:editor-selection-request";
const DEFAULT_PAGE_ICONS = ["😀", "✨", "💡", "📌", "📝", "📚", "🚀", "🌿", "☕", "🎯"];

function randomPageIcon() {
  return DEFAULT_PAGE_ICONS[Math.floor(Math.random() * DEFAULT_PAGE_ICONS.length)] ?? "😀";
}

function normalizedTitleText(el: HTMLElement | null) {
  return (el?.innerText ?? "").replace(/\s*\n+\s*/g, " ");
}

// Single source of truth for the "Untitled" placeholder: a title is empty
// when it has no non-whitespace characters.
function isTitleEmpty(value: string) {
  return value.trim().length === 0;
}

function titleSelectionOffsets(el: HTMLElement) {
  const fallback = normalizedTitleText(el).length;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return { start: fallback, end: fallback };
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
    return { start: fallback, end: fallback };
  }

  const startRange = range.cloneRange();
  startRange.selectNodeContents(el);
  startRange.setEnd(range.startContainer, range.startOffset);
  const endRange = range.cloneRange();
  endRange.selectNodeContents(el);
  endRange.setEnd(range.endContainer, range.endOffset);
  return {
    start: startRange.toString().length,
    end: endRange.toString().length,
  };
}

function pastedTitleLine(line: string) {
  return line.replace(/^#{1,6}\s+/, "").trimEnd();
}

function pastedPlainText(spec: PastedBlock) {
  return spec.plainText ?? spansToPlainText(spec.content?.rich);
}

function pageCommentText(comment: Comment) {
  const rich = (comment.body as { rich?: { text?: string }[] } | undefined)?.rich;
  if (Array.isArray(rich)) return rich.map((span) => span.text ?? "").join("").trim();
  return "";
}

function pageCommentTime(value?: string) {
  if (!value) return i18next.t("pageHeader:justNow");
  return new Date(value).toLocaleString(activeDateLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PageHeader({
  pageId,
  readOnly = false,
  publicReadOnly = false,
  canComment = false,
}: {
  pageId: string;
  readOnly?: boolean;
  publicReadOnly?: boolean;
  canComment?: boolean;
}) {
  const page = useStore((s) => s.pagesById[pageId]);
  const updatePage = useStore((s) => s.updatePage);
  const notify = useStore((s) => s.notify);
  const addBlockLocal = useStore((s) => s.addBlockLocal);
  const openComments = useStore((s) => s.openComments);
  const userId = useStore((s) => s.userId);
  const pageCommentCount = useStore(
    (s) =>
      s.commentsByPage[pageId]?.filter((comment) => !comment.blockId && !comment.parentId && !comment.resolved)
        .length ?? 0
  );
  const commentsForPage = useStore((s) => s.commentsByPage[pageId] ?? EMPTY_COMMENTS);
  const pageComments = commentsForPage
    .filter((comment) => !comment.blockId && !comment.parentId && !comment.resolved)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const titleRef = useRef<HTMLElement>(null);
  const iconButtonRef = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pageKind = page?.kind;
  const { t } = useTranslation(["pageHeader", "common"]);

  const focusFirstBlock = useCallback(() => {
    if (readOnly) {
      titleRef.current?.blur();
      return;
    }
    if (pageKind !== "page") {
      titleRef.current?.blur();
      return;
    }
    const allBlocks = useStore.getState().blocksByPage[pageId] ?? [];
    const firstEditable = (parentId: string | null = null): string | undefined => {
      const children = allBlocks
        .filter((block) => (block.parentId ?? null) === parentId)
        .sort((a, b) => a.position - b.position);
      for (const block of children) {
        if (TEXT_BLOCKS.has(block.type)) return block.id;
        const childId = firstEditable(block.id);
        if (childId) return childId;
      }
      return undefined;
    };
    const firstBlockId = firstEditable();
    if (firstBlockId) {
      requestPageStarterDismiss(pageId, firstBlockId);
      focusEditable(firstBlockId, "start");
      return;
    }
    // No editable text block exists. Insert a leading paragraph before any
    // existing (non-text) top-level block so we don't collide with it.
    const topLevel = allBlocks
      .filter((block) => (block.parentId ?? null) === null)
      .sort((a, b) => a.position - b.position);
    const position = topLevel.length > 0 ? topLevel[0].position - 1 : 1;
    const block = addBlockLocal({ pageId, position });
    requestPageStarterDismiss(pageId, block.id);
    focusEditable(block.id, "start");
  }, [addBlockLocal, pageId, pageKind, readOnly]);

  // Set initial title text only when switching pages (avoid caret jumps).
  useEffect(() => {
    const el = titleRef.current;
    if (el && el.innerText !== (page?.title ?? "")) {
      el.innerText = page?.title ?? "";
    }
    if (el) el.dataset.empty = String(isTitleEmpty(normalizedTitleText(el)));
    // Auto-focus just-created pages like Notion: empty titles receive the
    // title caret, pre-titled pages can jump straight into the first body line.
    if (!readOnly && page && useStore.getState().focusPageId === pageId) {
      const target = useStore.getState().focusPageTarget ?? "title";
      useStore.getState().setFocusPageId(undefined);
      if (target === "body") focusFirstBlock();
      else focusEditable(`title:${pageId}`, "end");
    }
  }, [focusFirstBlock, page, pageId, readOnly]);

  if (!page) return null;
  const pageCommentsDisplay = page.pageCommentsDisplay ?? "default";
  const hasIcon = page.iconType !== "none" && !!page.icon;
  const pageVerified = isPageVerified(page);
  const showHeaderVerificationControl = !readOnly;
  // Offer the comment affordance only when the backend will accept a comment
  // (canComment) — but still let a view-only user open the panel to *read*
  // existing threads. When they can't comment and there are none, hide it.
  const showHeaderCommentControl =
    pageCommentsDisplay !== "off" &&
    !(page.cover && hasIcon) &&
    (canComment || pageCommentCount > 0);
  const showHeaderOptions =
    !publicReadOnly &&
    ((!hasIcon && !readOnly) ||
      (!page.cover && !readOnly) ||
      showHeaderVerificationControl ||
      showHeaderCommentControl);

  function onTitleKeyDown(e: React.KeyboardEvent) {
    if (isComposingKeyEvent(e)) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
      const el = titleRef.current;
      if (!el) return;
      e.preventDefault();
      if (isTitleEmpty(normalizedTitleText(el)) || isEditableFullySelected(el)) {
        window.getSelection()?.removeAllRanges();
        el.blur();
        document.dispatchEvent(
          new CustomEvent(EDITOR_SELECTION_REQUEST, {
            detail: { pageId, mode: "first" },
          })
        );
      } else {
        selectEditableContents(el);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      focusFirstBlock();
    } else if (
      (e.key === "ArrowDown" || e.key === "ArrowRight") &&
      !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)
    ) {
      if (!titleRef.current || !isCaretAtEnd(titleRef.current)) return;
      e.preventDefault();
      focusFirstBlock();
    }
  }

  function addCover() {
    if (readOnly) return;
    // Store gradient as a CSS value; PageView renders it as backgroundImage.
    // nextCover always advances to a different preset (vs randomCover, which
    // could re-pick the same one).
    updatePage(pageId, { cover: nextCover(page?.cover), coverPosition: 50 });
    window.requestAnimationFrame(() => focusEditable(`title:${pageId}`, "start"));
  }

  function addIcon() {
    if (readOnly) return;
    if (!hasIcon) updatePage(pageId, { icon: randomPageIcon(), iconType: "emoji" });
    setPickerOpen(true);
  }

  function removeIcon() {
    if (readOnly) return;
    const previousIcon = page.icon ?? "";
    const previousIconType = page.iconType;
    updatePage(pageId, { icon: "", iconType: "none" });
    closePicker("title");
    notify(t("pageHeader:removedIcon"), "success", {
      label: t("pageHeader:undo"),
      onClick: () => {
        updatePage(pageId, { icon: previousIcon, iconType: previousIconType });
        notify(t("pageHeader:restoredIcon"), "success");
      },
    });
  }

  function toggleVerification() {
    if (readOnly) return;
    updatePage(
      pageId,
      pageVerified
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
    notify(pageVerified ? t("pageHeader:verificationRemoved") : t("pageHeader:pageVerified"), "success");
  }

  function titleText() {
    return normalizedTitleText(titleRef.current);
  }

  function setTitleEmptyState(title: string) {
    const el = titleRef.current;
    if (!el) return;
    const empty = String(isTitleEmpty(title));
    el.dataset.empty = empty;
    el.parentElement?.setAttribute("data-title-empty", empty);
  }

  function setTitleDomText(title: string, caret?: number | "end") {
    const el = titleRef.current;
    if (!el) return;
    el.innerText = title;
    setTitleEmptyState(title);
    if (caret !== undefined) placeCaret(el, caret);
  }

  function syncTitle() {
    if (readOnly) return;
    const title = titleText();
    setTitleEmptyState(title);
    updatePage(pageId, { title }, { debounce: true });
  }

  function insertPastedBlocksAtTop(blockSpecs: PastedBlock[]) {
    if (blockSpecs.length === 0) return undefined;
    const st = useStore.getState();
    const topLevel = st.topLevelBlocks(pageId);
    const firstExisting = topLevel[0];
    const canReusePlaceholder =
      topLevel.length === 1 &&
      firstExisting?.type === "paragraph" &&
      spansToPlainText(firstExisting.content?.rich).length === 0 &&
      st.childBlocks(pageId, firstExisting.id).length === 0;

    function insertChildren(parentId: string, children?: PastedBlock[]) {
      let previousPosition: number | undefined;
      let lastInserted: Block | undefined;
      for (const child of children ?? []) {
        const position = positionBetween(previousPosition, undefined);
        const inserted = st.addBlockLocal({
          pageId,
          parentId,
          type: child.type,
          content: child.content ?? { rich: [] },
          position,
          history: false,
        });
        const plainText = pastedPlainText(child);
        if (plainText !== inserted.plainText) {
          st.updateBlock(inserted.id, { plainText }, { history: false });
        }
        lastInserted = insertChildren(inserted.id, child.children) ?? inserted;
        previousPosition = position;
      }
      return lastInserted;
    }

    let lastInserted: Block | undefined;
    st.captureBlockHistory(pageId);
    flushSync(() => {
      let specs = blockSpecs;
      let previousPosition: number | undefined;
      const nextPosition = canReusePlaceholder ? undefined : firstExisting?.position;

      if (canReusePlaceholder) {
        const [firstSpec, ...rest] = blockSpecs;
        st.updateBlock(
          firstExisting.id,
          {
            type: firstSpec.type,
            content: firstSpec.content ?? { rich: [] },
            plainText: pastedPlainText(firstSpec),
          },
          { history: false }
        );
        lastInserted = insertChildren(firstExisting.id, firstSpec.children) ?? firstExisting;
        previousPosition = firstExisting.position;
        specs = rest;
      }

      for (const spec of specs) {
        const position = positionBetween(previousPosition, nextPosition);
        const inserted = st.addBlockLocal({
          pageId,
          parentId: null,
          type: spec.type,
          content: spec.content ?? { rich: [] },
          position,
          history: false,
        });
        const plainText = pastedPlainText(spec);
        if (plainText !== inserted.plainText) {
          st.updateBlock(inserted.id, { plainText }, { history: false });
        }
        lastInserted = insertChildren(inserted.id, spec.children) ?? inserted;
        previousPosition = position;
      }
    });
    return lastInserted;
  }

  function onTitlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (readOnly) return;
    e.preventDefault();
    const rawText = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    const el = titleRef.current;
    if (!el) return;
    if (rawText.includes("\n")) {
      const lines = rawText.split("\n");
      const { start, end } = titleSelectionOffsets(el);
      const currentTitle = normalizedTitleText(el);
      const insertTitle = pastedTitleLine(lines[0] ?? "");
      const nextTitle = currentTitle.slice(0, start) + insertTitle + currentTitle.slice(end);
      setTitleDomText(nextTitle, Math.min(start + insertTitle.length, nextTitle.length));
      updatePage(pageId, { title: nextTitle });
      const blocks = parsePastedMarkdown(lines.slice(1).join("\n"));
      const lastInserted = insertPastedBlocksAtTop(blocks);
      if (lastInserted && TEXT_BLOCKS.has(lastInserted.type)) {
        window.requestAnimationFrame(() => focusEditable(lastInserted.id, "end"));
      }
      return;
    }

    const text = rawText.replace(/\s*\n+\s*/g, " ");
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    syncTitle();
  }

  function closePicker(nextFocus: "icon" | "title" = "icon") {
    setPickerOpen(false);
    window.requestAnimationFrame(() => {
      if (nextFocus === "icon") iconButtonRef.current?.focus();
      else focusEditable(`title:${pageId}`, "start");
    });
  }

  return (
    <div
      className={styles.header}
      data-has-cover={page.cover ? "true" : "false"}
      data-has-icon={hasIcon ? "true" : "false"}
      data-title-empty={isTitleEmpty(page.title) ? "true" : "false"}
      data-page-header-root
    >
      {showHeaderOptions && (
        <div
          className={styles.controls}
          role="toolbar"
          aria-label={t("pageHeader:pageOptions")}
          data-page-header-controls
        >
          {!hasIcon && !readOnly && (
            <div className={styles.addIconWrap}>
              <button
                ref={iconButtonRef}
                type="button"
                className={styles.ctrlBtn}
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                data-page-header-control
                onClick={addIcon}
              >
                <SmileIcon size={15} aria-hidden="true" />
                <span>{t("pageHeader:addIcon")}</span>
              </button>
              {pickerOpen && (
                <EmojiPicker
                  placement="inline"
                  uploadTarget={{ pageId }}
                  onPick={(emoji) => {
                    updatePage(pageId, { icon: emoji, iconType: "emoji" });
                    closePicker("icon");
                  }}
                  onPickImage={(url) => {
                    updatePage(pageId, { icon: url, iconType: "image" });
                    closePicker("icon");
                  }}
                  onClose={() => closePicker("icon")}
                />
              )}
            </div>
          )}
          {!readOnly && !page.cover && (
            <button
              type="button"
              className={styles.ctrlBtn}
              aria-label={t("pageHeader:addPageCover")}
              data-page-header-control
              onClick={addCover}
            >
              <ImageIcon size={15} aria-hidden="true" />
              <span>{t("pageHeader:addCover")}</span>
            </button>
          )}
          {showHeaderVerificationControl && (
            <button
              type="button"
              className={styles.ctrlBtn}
              aria-label={pageVerified ? t("pageHeader:removeVerification") : t("pageHeader:verifyPage")}
              data-page-header-control
              onClick={toggleVerification}
            >
              <CheckIcon size={15} aria-hidden="true" />
              <span>{pageVerified ? t("pageHeader:removeVerification") : t("pageHeader:addVerification")}</span>
            </button>
          )}
          {showHeaderCommentControl && (
            <button
              type="button"
              className={styles.ctrlBtn}
              aria-label={
                pageCommentCount
                  ? t("pageHeader:openComments", { count: pageCommentCount })
                  : t("pageHeader:addPageComment")
              }
              data-page-header-control
              onClick={() => openComments(pageId)}
            >
              <CommentIcon size={15} aria-hidden="true" />
              <span>{pageCommentCount ? t("pageHeader:commentCount", { count: pageCommentCount }) : t("pageHeader:addComment")}</span>
            </button>
          )}
        </div>
      )}

      {hasIcon && (
        <div className={styles.iconWrap}>
          {readOnly ? (
            <span className={styles.bigIcon} aria-hidden="true">
              <PageIconGlyph page={page} size={78} fallback="none" />
            </span>
          ) : (
            <button
              ref={iconButtonRef}
              type="button"
              className={styles.bigIcon}
              aria-label={t("pageHeader:changeIcon")}
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen(true)}
            >
              <PageIconGlyph page={page} size={78} fallback="none" />
            </button>
          )}
          {!readOnly && pickerOpen && (
            <EmojiPicker
              uploadTarget={{ pageId }}
              onPick={(emoji) => {
                updatePage(pageId, { icon: emoji, iconType: "emoji" });
                closePicker("icon");
              }}
              onPickImage={(url) => {
                updatePage(pageId, { icon: url, iconType: "image" });
                closePicker("icon");
              }}
              onRemove={removeIcon}
              onClose={() => closePicker("icon")}
            />
          )}
        </div>
      )}

      <h1
        className={styles.titleHeading}
        aria-label={page.title.trim() || t("pageHeader:untitled")}
      >
        <span
          ref={(el) => {
            titleRef.current = el;
            registerEditable(`title:${pageId}`, el);
          }}
          className={styles.title}
          contentEditable={!readOnly}
          role="textbox"
          tabIndex={0}
          aria-label={t("pageHeader:pageTitle")}
          aria-readonly={readOnly}
          aria-multiline="false"
          aria-placeholder={t("pageHeader:untitled")}
          suppressContentEditableWarning
          data-placeholder={t("pageHeader:untitled")}
          data-empty={isTitleEmpty(page.title) ? "true" : "false"}
          spellCheck={false}
          onInput={readOnly ? undefined : syncTitle}
          onPaste={readOnly ? undefined : onTitlePaste}
          onKeyDown={onTitleKeyDown}
        />
      </h1>
      {!publicReadOnly && <PageBacklinks pageId={pageId} display={page.backlinksDisplay ?? "default"} />}
      {!publicReadOnly && pageCommentsDisplay === "expanded" && (
        <section className={styles.pageComments} aria-label={t("pageHeader:pageComments")}>
          <div className={styles.pageCommentsHeader}>
            <span>{t("pageHeader:pageComments")}</span>
            <button type="button" onClick={() => openComments(pageId)}>
              {pageCommentCount ? t("pageHeader:openAll") : t("pageHeader:addComment")}
            </button>
          </div>
          {pageComments.length === 0 ? (
            <button type="button" className={styles.pageCommentEmpty} onClick={() => openComments(pageId)}>
              {t("pageHeader:addPlaceholderComment")}
            </button>
          ) : (
            <div className={styles.pageCommentList}>
              {pageComments.slice(0, 3).map((comment) => {
                const text = pageCommentText(comment) || t("pageHeader:emptyComment");
                const author = actorLabel(comment.authorId, userId);
                return (
                  <button
                    key={comment.id}
                    type="button"
                    className={styles.pageCommentItem}
                    onClick={() => openComments(pageId, null, { activeCommentId: comment.id })}
                  >
                    <span className={styles.pageCommentAvatar} aria-hidden="true">{author.slice(0, 1)}</span>
                    <span className={styles.pageCommentBody}>
                      <span className={styles.pageCommentMeta}>
                        <strong>{author}</strong>
                        <span>{pageCommentTime(comment.createdAt)}</span>
                      </span>
                      <span className={styles.pageCommentText}>{text}</span>
                    </span>
                  </button>
                );
              })}
              {pageComments.length > 3 && (
                <button type="button" className={styles.pageCommentMore} onClick={() => openComments(pageId)}>
                  {t("pageHeader:moreComments", { count: pageComments.length - 3 })}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
