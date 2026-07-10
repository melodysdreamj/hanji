"use client";

import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "@/lib/router";
import { positionBetween } from "@/lib/ids";
import { pickLabels } from "@/lib/i18n";
import { pageHref } from "@/lib/navigation";
import { pageTemplates, type PageTemplate, type PageTemplateBlock } from "@/lib/pageTemplates";
import { spansToPlainText } from "@/lib/types";
import { useStore } from "@/lib/store";
import { CalendarIcon, CheckIcon, ClockIcon, FileText, ListIcon, Search, X } from "./icons";
import { TEXT_BLOCKS } from "./editor/blocks";
import { focusEditable } from "./editor/focus";
import styles from "./TemplatesDialog.module.css";

// Smoke tests and contracts assert the literal English strings; locale
// resolution itself lives in lib/i18n (see that file's header comment).
const TEMPLATES_DIALOG_LABELS = {
  en: {
    title: "Templates",
    close: "Close templates",
    categories: "Template categories",
    all: "All",
    searchPlaceholder: "Search templates",
    gridLabel: (category: string) => `${category} templates`,
    empty: "No templates found.",
    use: "Use",
    applying: "Applying...",
    adding: "Adding...",
    applied: "Template applied",
    added: "Template added",
    failed: "Couldn't use template.",
    pageNotFound: "Page not found.",
  },
  ko: {
    title: "템플릿",
    close: "템플릿 닫기",
    categories: "템플릿 카테고리",
    all: "전체",
    searchPlaceholder: "템플릿 검색",
    gridLabel: (category: string) => `${category} 템플릿`,
    empty: "템플릿을 찾을 수 없습니다.",
    use: "사용",
    applying: "적용 중...",
    adding: "추가 중...",
    applied: "템플릿을 적용했습니다",
    added: "템플릿을 추가했습니다",
    failed: "템플릿을 사용할 수 없습니다.",
    pageNotFound: "페이지를 찾을 수 없습니다.",
  },
};

function TemplateIcon({ icon }: { icon: PageTemplate["icon"] }) {
  if (icon === "check") return <CheckIcon size={18} aria-hidden="true" />;
  if (icon === "calendar") return <CalendarIcon size={18} aria-hidden="true" />;
  if (icon === "list") return <ListIcon size={18} aria-hidden="true" />;
  if (icon === "clock") return <ClockIcon size={18} aria-hidden="true" />;
  return <FileText size={18} aria-hidden="true" />;
}

function emptyTemplatePlaceholderId(pageId: string, preferredBlockId?: string) {
  const blocks = useStore.getState().blocksByPage[pageId] ?? [];
  const isEmptyParagraph = (block: (typeof blocks)[number] | undefined) =>
    block?.type === "paragraph" && spansToPlainText(block.content?.rich).length === 0;
  const preferred = preferredBlockId
    ? blocks.find((candidate) => candidate.id === preferredBlockId)
    : undefined;
  if (isEmptyParagraph(preferred)) return preferred!.id;

  const topLevel = blocks
    .filter((candidate) => candidate.parentId == null)
    .sort((a, b) => a.position - b.position);
  return topLevel.length === 1 && isEmptyParagraph(topLevel[0]) ? topLevel[0].id : undefined;
}

export function TemplatesDialog({
  onClose,
  targetPageId,
  placeholderBlockId,
}: {
  onClose: () => void;
  targetPageId?: string;
  placeholderBlockId?: string;
}) {
  const router = useRouter();
  const titleId = useId();
  const panelId = `${titleId}-templates`;
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const labels = pickLabels(TEMPLATES_DIALOG_LABELS);
  const templates = pageTemplates();
  const [category, setCategory] = useState(labels.all);
  const [query, setQuery] = useState("");
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const createPage = useStore((s) => s.createPage);
  const notify = useStore((s) => s.notify);
  const categories = [
    labels.all,
    ...Array.from(new Set(templates.map((template) => template.category))),
  ];
  const normalizedQuery = query.trim().toLowerCase();
  const filteredTemplates =
    (category === labels.all
      ? templates
      : templates.filter((template) => template.category === category)
    ).filter((template) => {
      if (!normalizedQuery) return true;
      return `${template.title} ${template.category} ${template.description}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  const categoryTabId = (item: string) => `${titleId}-${item.toLowerCase()}-tab`;

  const close = useCallback((restoreFocus = true) => {
    onClose();
    if (!restoreFocus) return;
    window.requestAnimationFrame(() => {
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
      restoreFocusRef.current = null;
    });
  }, [onClose]);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function dialogFocusables() {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function onDialogKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = dialogFocusables();
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

  function insertTemplateChildren(pageId: string, parentId: string, children: PageTemplateBlock[]) {
    let previous: number | undefined;
    for (const child of children) {
      const created = useStore.getState().addBlockLocal({
        pageId,
        parentId,
        type: child.type,
        content: child.content ?? { rich: [] },
        position: positionBetween(previous, undefined),
        history: false,
      });
      previous = created.position;
      if (child.children?.length) insertTemplateChildren(pageId, created.id, child.children);
    }
  }

  async function createFromTemplate(template: PageTemplate) {
    if (creatingId) return;
    setCreatingId(template.id);
    try {
      const state = useStore.getState();
      const page = targetPageId
        ? state.pagesById[targetPageId]
        : await createPage({
            parentId: null,
            parentType: "workspace",
            title: template.title,
            afterPosition: state.childPages(null).at(-1)?.position,
            focusTitle: false,
          });
      if (!page) throw new Error(labels.pageNotFound);

      const pageTitle = page.title.trim();
      const shouldAdoptTemplateTitle = !targetPageId || !pageTitle || pageTitle === "Untitled";
      const pagePatch = shouldAdoptTemplateTitle ? { title: template.title } : {};
      useStore.getState().updatePage(page.id, {
        ...pagePatch,
        icon: page.iconType !== "none" && page.icon ? page.icon : template.pageIcon,
        iconType: page.iconType !== "none" && page.icon ? page.iconType : "emoji",
      });
      if (targetPageId) useStore.getState().captureBlockHistory(page.id);
      const starterPlaceholderId = targetPageId
        ? emptyTemplatePlaceholderId(page.id, placeholderBlockId)
        : undefined;
      let blocksToInsert = template.blocks;
      let previous: number | undefined;
      let firstEditableId: string | undefined;
      if (starterPlaceholderId && template.blocks.length > 0) {
        const [firstBlock, ...remainingBlocks] = template.blocks;
        const content = firstBlock.content ?? { rich: [] };
        useStore.getState().updateBlock(starterPlaceholderId, {
          type: firstBlock.type,
          content,
          plainText: spansToPlainText(content.rich),
        }, { history: false });
        if (firstBlock.children?.length) {
          insertTemplateChildren(page.id, starterPlaceholderId, firstBlock.children);
        }
        if (TEXT_BLOCKS.has(firstBlock.type)) firstEditableId = starterPlaceholderId;
        previous = useStore
          .getState()
          .topLevelBlocks(page.id)
          .find((block) => block.id === starterPlaceholderId)?.position;
        blocksToInsert = remainingBlocks;
      } else if (starterPlaceholderId) {
        await useStore.getState().deleteBlock(starterPlaceholderId, { history: false });
      }
      if (targetPageId && previous === undefined) {
        previous = useStore.getState().topLevelBlocks(page.id).at(-1)?.position;
      }
      for (const block of blocksToInsert) {
        const created = useStore.getState().addBlockLocal({
          pageId: page.id,
          parentId: null,
          type: block.type,
          content: block.content ?? { rich: [] },
          position: positionBetween(previous, undefined),
          history: false,
        });
        if (block.children?.length) insertTemplateChildren(page.id, created.id, block.children);
        if (!firstEditableId && TEXT_BLOCKS.has(created.type)) firstEditableId = created.id;
        previous = created.position;
      }
      notify(targetPageId ? labels.applied : labels.added, "success");
      close(false);
      if (targetPageId && firstEditableId) {
        window.requestAnimationFrame(() => focusEditable(firstEditableId, "end"));
      }
      if (!targetPageId) router.push(pageHref(page.id));
    } catch (error) {
      notify(error instanceof Error ? error.message : labels.failed, "error");
    } finally {
      setCreatingId(null);
    }
  }

  function onCategoryKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const keyOffset =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    let nextIndex = index;

    if (keyOffset !== 0) {
      nextIndex = (index + keyOffset + categories.length) % categories.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = categories.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextCategory = categories[nextIndex];
    setCategory(nextCategory);
    document.getElementById(categoryTabId(nextCategory))?.focus();
  }

  return (
    <div className={styles.overlay}>
      <button
        type="button"
        className={styles.backdrop}
        onClick={() => close()}
        tabIndex={-1}
        aria-label={labels.close}
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
          <h2 id={titleId}>{labels.title}</h2>
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            onClick={() => close()}
            aria-label={labels.close}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.nav} role="tablist" aria-label={labels.categories}>
            {categories.map((item, index) => (
              <button
                id={categoryTabId(item)}
                key={item}
                type="button"
                role="tab"
                className={styles.navItem}
                aria-controls={panelId}
                aria-selected={category === item}
                data-active={category === item ? "true" : undefined}
                tabIndex={category === item ? 0 : -1}
                onKeyDown={(event) => onCategoryKeyDown(event, index)}
                onClick={() => setCategory(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <div
            id={panelId}
            className={styles.panel}
            role="tabpanel"
            aria-labelledby={categoryTabId(category)}
            aria-busy={creatingId ? "true" : undefined}
          >
            <label className={styles.searchRow}>
              <Search size={16} aria-hidden="true" />
              <input
                value={query}
                placeholder={labels.searchPlaceholder}
                aria-label={labels.searchPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {filteredTemplates.length > 0 ? (
              <ul className={styles.grid} aria-label={labels.gridLabel(category)}>
                {filteredTemplates.map((template) => (
                  <li key={template.id} className={styles.templateItem}>
                    <button
                      type="button"
                      className={styles.templateCard}
                      disabled={creatingId !== null}
                      onClick={() => void createFromTemplate(template)}
                    >
                      <span className={styles.templateIcon}>
                        <TemplateIcon icon={template.icon} />
                      </span>
                      <span className={styles.templateText}>
                        <span>{template.title}</span>
                        <span title={template.description}>{template.description}</span>
                      </span>
                      <span className={styles.useLabel}>
                        {creatingId === template.id
                          ? targetPageId
                            ? labels.applying
                            : labels.adding
                          : labels.use}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className={styles.empty} role="status">
                {labels.empty}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
