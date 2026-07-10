"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { setDocumentChrome, TRASH_FAVICON_HREF } from "@/lib/documentChrome";
import { openPageInNewTab, pageHref } from "@/lib/navigation";
import { pagePathOrWorkspaceRoot } from "@/lib/pagePath";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { Page } from "@/lib/types";
import { useStore } from "@/lib/store";
import { activeDateLocale, pickLabels } from "@/lib/i18n";
import { Search, Trash } from "./icons";
import { PageIconGlyph } from "./PageIcon";
import { TopBar } from "./TopBar";
import styles from "./HomeView.module.css";
import trashStyles from "./TrashView.module.css";

const TRASH_LABELS = {
  en: {
    trash: "Trash",
    empty: "Pages you delete land here. Nothing in the trash.",
    searchTrash: "Search trash",
    restore: "Restore",
    deleteForever: "Delete forever",
    deletedJustNow: "Deleted just now",
    deletedOn: (date: string) => `Deleted ${date}`,
    pageCount: (count: number) => `${count} page${count === 1 ? "" : "s"}`,
    deletedPages: "Deleted pages",
    noSearchMatches: "No deleted pages match your search.",
    openFromTrash: (title: string) => `Open ${title} from trash`,
    restorePage: (title: string) => `Restore ${title}`,
    deletePageForever: (title: string) => `Delete ${title} forever`,
    confirmTitle: "Delete forever?",
    confirmBodyPrefix: "This will permanently delete ",
    confirmBodySuffix: ". You can't undo this action.",
    cancel: "Cancel",
    cancelPermanentDelete: "Cancel permanent delete",
    deletedForeverToast: "Deleted forever",
    couldntDeleteToast: "Couldn't delete page",
    restoredToast: "Restored page",
    couldntRestoreToast: "Couldn't restore page",
    emptyTrash: "Empty trash",
    emptyTrashConfirmTitle: "Empty trash?",
    emptyTrashConfirmBody: (count: number) =>
      `This will permanently delete all ${count} page${count === 1 ? "" : "s"} in the trash. You can't undo this action.`,
    cancelEmptyTrash: "Cancel emptying trash",
    emptiedToast: "Trash emptied",
    couldntEmptyToast: "Couldn't empty trash",
  },
  ko: {
    trash: "휴지통",
    empty: "삭제한 페이지가 여기에 표시됩니다. 휴지통이 비어 있습니다.",
    searchTrash: "휴지통 검색",
    restore: "복원",
    deleteForever: "영구 삭제",
    deletedJustNow: "방금 삭제됨",
    deletedOn: (date: string) => `${date}에 삭제됨`,
    pageCount: (count: number) => `페이지 ${count}개`,
    deletedPages: "삭제된 페이지",
    noSearchMatches: "검색과 일치하는 삭제된 페이지가 없습니다.",
    openFromTrash: (title: string) => `휴지통에서 ${title} 열기`,
    restorePage: (title: string) => `${title} 복원`,
    deletePageForever: (title: string) => `${title} 영구 삭제`,
    confirmTitle: "영구 삭제할까요?",
    confirmBodyPrefix: "",
    confirmBodySuffix: "을(를) 영구적으로 삭제합니다. 이 작업은 되돌릴 수 없습니다.",
    cancel: "취소",
    cancelPermanentDelete: "영구 삭제 취소",
    deletedForeverToast: "영구 삭제됨",
    couldntDeleteToast: "페이지를 삭제하지 못했습니다",
    restoredToast: "페이지를 복원했습니다",
    couldntRestoreToast: "페이지를 복원하지 못했습니다",
    emptyTrash: "휴지통 비우기",
    emptyTrashConfirmTitle: "휴지통을 비울까요?",
    emptyTrashConfirmBody: (count: number) =>
      `휴지통에 있는 페이지 ${count}개를 영구적으로 삭제합니다. 이 작업은 되돌릴 수 없습니다.`,
    cancelEmptyTrash: "휴지통 비우기 취소",
    emptiedToast: "휴지통을 비웠습니다",
    couldntEmptyToast: "휴지통을 비우지 못했습니다",
  },
} as const;

function pageTitle(page: Page) {
  return pageDisplayTitle(page);
}

function deletedLabel(value?: string | null) {
  const labels = pickLabels(TRASH_LABELS);
  if (!value) return labels.deletedJustNow;
  return labels.deletedOn(
    new Date(value).toLocaleDateString(activeDateLocale(), {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  );
}

export function TrashView() {
  const router = useRouter();
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const trashed = useStore(useShallow((s) => s.trashedPages()));
  const pagesById = useStore((s) => s.pagesById);
  const restorePage = useStore((s) => s.restorePage);
  const deletePage = useStore((s) => s.deletePage);
  const emptyTrash = useStore((s) => s.emptyTrash);
  const notify = useStore((s) => s.notify);
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<
    { mode: "delete"; page: Page } | { mode: "empty" } | null
  >(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const confirmTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setDocumentChrome({
      title: `${pickLabels(TRASH_LABELS).trash} - Hanji`,
      iconHref: TRASH_FAVICON_HREF,
    });
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return trashed;
    return trashed.filter((page) => {
      const haystack = `${pageTitle(page)} ${pagePathOrWorkspaceRoot(page, pagesById)}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [pagesById, query, trashed]);

  useEffect(() => {
    if (!confirm) return;

    const frame = window.requestAnimationFrame(() => cancelButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [confirm]);

  function closeConfirm(restoreFocus = false) {
    setConfirm(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => confirmTriggerRef.current?.focus());
    }
  }

  async function confirmAction() {
    if (!confirm) return;
    const labels = pickLabels(TRASH_LABELS);
    if (confirm.mode === "delete") {
      const page = confirm.page;
      closeConfirm(false);
      try {
        await deletePage(page.id);
        notify(labels.deletedForeverToast, "success");
        window.requestAnimationFrame(() => listRef.current?.focus());
      } catch {
        notify(labels.couldntDeleteToast, "error");
      }
      return;
    }
    closeConfirm(false);
    try {
      await emptyTrash();
      notify(labels.emptiedToast, "success");
    } catch {
      notify(labels.couldntEmptyToast, "error");
    }
  }

  async function restoreFromTrash(page: Page) {
    try {
      await restorePage(page.id);
      notify(pickLabels(TRASH_LABELS).restoredToast, "success");
      window.requestAnimationFrame(() => listRef.current?.focus());
    } catch {
      notify(pickLabels(TRASH_LABELS).couldntRestoreToast, "error");
    }
  }

  function openPage(pageId: string, e: React.MouseEvent<HTMLElement>) {
    if (e.metaKey || e.ctrlKey) openPageInNewTab(pageId);
    else router.push(pageHref(pageId));
  }

  function dialogFocusables() {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([type="hidden"]):not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function onDialogKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeConfirm(true);
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
      e.stopPropagation();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      e.stopPropagation();
      first.focus();
    }
  }

  return (
    <>
      <TopBar title={pickLabels(TRASH_LABELS).trash} />
      <div className={styles.wrap} role="region" aria-label={pickLabels(TRASH_LABELS).trash}>
        <div className={styles.inner}>
          <h1 className={styles.greeting}>{pickLabels(TRASH_LABELS).trash}</h1>
          {trashed.length === 0 ? (
            <div className={trashStyles.empty}>
              <Trash size={22} />
              <p>{pickLabels(TRASH_LABELS).empty}</p>
            </div>
          ) : (
            <div className={trashStyles.surface}>
              <div className={trashStyles.toolbar}>
                <div className={trashStyles.search}>
                  <Search size={15} aria-hidden="true" />
                  <input
                    value={query}
                    aria-label={pickLabels(TRASH_LABELS).searchTrash}
                    placeholder={pickLabels(TRASH_LABELS).searchTrash}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className={trashStyles.toolbarEnd}>
                  <span className={trashStyles.count} data-trash-count>
                    {pickLabels(TRASH_LABELS).pageCount(filtered.length)}
                  </span>
                  <button
                    type="button"
                    className={trashStyles.emptyTrash}
                    data-empty-trash
                    onClick={(e) => {
                      confirmTriggerRef.current = e.currentTarget;
                      setConfirm({ mode: "empty" });
                    }}
                  >
                    {pickLabels(TRASH_LABELS).emptyTrash}
                  </button>
                </div>
              </div>
              <div
                ref={listRef}
                className={trashStyles.list}
                role="list"
                tabIndex={-1}
                aria-label={pickLabels(TRASH_LABELS).deletedPages}
              >
                {filtered.length === 0 ? (
                  <div className={trashStyles.noResults} role="status">
                    {pickLabels(TRASH_LABELS).noSearchMatches}
                  </div>
                ) : (
                  filtered.map((p) => (
                    <div
                      key={p.id}
                      className={trashStyles.row}
                      role="listitem"
                    >
                      <button
                        type="button"
                        className={trashStyles.page}
                        aria-label={pickLabels(TRASH_LABELS).openFromTrash(pageTitle(p))}
                        onClick={(e) => openPage(p.id, e)}
                        onAuxClick={(e) => {
                          if (e.button === 1) {
                            e.preventDefault();
                            openPageInNewTab(p.id);
                          }
                        }}
                      >
                        <span className={trashStyles.icon}>
                          <PageIconGlyph page={p} size={16} />
                        </span>
                        <span className={trashStyles.pageText}>
                          <span className={trashStyles.title}>{pageTitle(p)}</span>
                          <span className={trashStyles.meta}>
                            {deletedLabel(p.trashedAt)} · {pagePathOrWorkspaceRoot(p, pagesById)}
                          </span>
                        </span>
                      </button>
                      <span className={trashStyles.actions}>
                        <button
                          type="button"
                          className={trashStyles.restore}
                          aria-label={pickLabels(TRASH_LABELS).restorePage(pageTitle(p))}
                          onClick={() => void restoreFromTrash(p)}
                        >
                          {pickLabels(TRASH_LABELS).restore}
                        </button>
                        <button
                          type="button"
                          className={trashStyles.delete}
                          aria-label={pickLabels(TRASH_LABELS).deletePageForever(pageTitle(p))}
                          onClick={(e) => {
                            confirmTriggerRef.current = e.currentTarget;
                            setConfirm({ mode: "delete", page: p });
                          }}
                        >
                          {pickLabels(TRASH_LABELS).deleteForever}
                        </button>
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {confirm && (
        <div className={trashStyles.confirmOverlay}>
          <button
            type="button"
            className={trashStyles.confirmBackdrop}
            aria-label={
              confirm.mode === "delete"
                ? pickLabels(TRASH_LABELS).cancelPermanentDelete
                : pickLabels(TRASH_LABELS).cancelEmptyTrash
            }
            onClick={() => closeConfirm(true)}
          />
          <div
            ref={dialogRef}
            className={trashStyles.confirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            aria-describedby={dialogDescriptionId}
            onKeyDown={onDialogKeyDown}
          >
            <div id={dialogTitleId} className={trashStyles.confirmTitle}>
              {confirm.mode === "delete"
                ? pickLabels(TRASH_LABELS).confirmTitle
                : pickLabels(TRASH_LABELS).emptyTrashConfirmTitle}
            </div>
            <p id={dialogDescriptionId}>
              {confirm.mode === "delete" ? (
                <>
                  {pickLabels(TRASH_LABELS).confirmBodyPrefix}
                  <strong>{pageTitle(confirm.page)}</strong>
                  {pickLabels(TRASH_LABELS).confirmBodySuffix}
                </>
              ) : (
                pickLabels(TRASH_LABELS).emptyTrashConfirmBody(trashed.length)
              )}
            </p>
            <div className={trashStyles.confirmActions}>
              <button ref={cancelButtonRef} type="button" onClick={() => closeConfirm(true)}>
                {pickLabels(TRASH_LABELS).cancel}
              </button>
              <button
                type="button"
                className={trashStyles.confirmDelete}
                onClick={() => void confirmAction()}
              >
                {confirm.mode === "delete"
                  ? pickLabels(TRASH_LABELS).deleteForever
                  : pickLabels(TRASH_LABELS).emptyTrash}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
