"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { setDocumentChrome, TRASH_FAVICON_HREF } from "@/lib/documentChrome";
import { openPageInNewTab, pageHref } from "@/lib/navigation";
import { pagePathOrWorkspaceRoot } from "@/lib/pagePath";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { Page } from "@/lib/types";
import { useStore } from "@/lib/store";
import { activeDateLocale } from "@/lib/i18n";
import { i18next } from "@/i18n";
import { Search, Trash } from "./icons";
import { PageIconGlyph } from "./PageIcon";
import { TopBar } from "./TopBar";
import styles from "./HomeView.module.css";
import trashStyles from "./TrashView.module.css";

function pageTitle(page: Page) {
  return pageDisplayTitle(page);
}

function deletedLabel(value?: string | null) {
  if (!value) return i18next.t("trashView:deletedJustNow");
  return i18next.t("trashView:deletedOn", {
    date: new Date(value).toLocaleDateString(activeDateLocale(), {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  });
}

export function TrashView() {
  const { t } = useTranslation(["trashView", "common"]);
  const router = useRouter();
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const trashed = useStore(useShallow((s) => s.trashedPages()));
  const pagesById = useStore((s) => s.pagesById);
  const restorePage = useStore((s) => s.restorePage);
  const canPermanentlyDeletePage = useStore((s) => s.canPermanentlyDeletePage);
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
      title: `${t("trashView:trash")} - Hanji`,
      iconHref: TRASH_FAVICON_HREF,
    });
  }, [t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return trashed;
    return trashed.filter((page) => {
      const haystack = `${pageTitle(page)} ${pagePathOrWorkspaceRoot(page, pagesById)}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [pagesById, query, trashed]);
  const canEmptyTrash = useMemo(
    () => trashed.length > 0 && trashed.every((page) => canPermanentlyDeletePage(page.id)),
    [canPermanentlyDeletePage, trashed]
  );

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
    if (confirm.mode === "delete") {
      const page = confirm.page;
      closeConfirm(false);
      try {
        await deletePage(page.id);
        notify(t("trashView:toast.deletedForever"), "success");
        window.requestAnimationFrame(() => listRef.current?.focus());
      } catch {
        notify(t("trashView:toast.couldntDelete"), "error");
      }
      return;
    }
    closeConfirm(false);
    try {
      await emptyTrash();
      notify(t("trashView:toast.emptied"), "success");
    } catch {
      notify(t("trashView:toast.couldntEmpty"), "error");
    }
  }

  async function restoreFromTrash(page: Page) {
    try {
      await restorePage(page.id);
      notify(t("trashView:toast.restored"), "success");
      window.requestAnimationFrame(() => listRef.current?.focus());
    } catch {
      notify(t("trashView:toast.couldntRestore"), "error");
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
      <TopBar title={t("trashView:trash")} />
      <div className={styles.wrap} role="region" aria-label={t("trashView:trash")}>
        <div className={styles.inner}>
          <h1 className={styles.greeting}>{t("trashView:trash")}</h1>
          {trashed.length === 0 ? (
            <div className={trashStyles.empty}>
              <Trash size={22} />
              <p>{t("trashView:empty")}</p>
            </div>
          ) : (
            <div className={trashStyles.surface}>
              <div className={trashStyles.toolbar}>
                <div className={trashStyles.search}>
                  <Search size={15} aria-hidden="true" />
                  <input
                    value={query}
                    aria-label={t("trashView:searchTrash")}
                    placeholder={t("trashView:searchTrash")}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className={trashStyles.toolbarEnd}>
                  <span className={trashStyles.count} data-trash-count>
                    {t("trashView:pageCount", { count: filtered.length })}
                  </span>
                  {canEmptyTrash && (
                    <button
                      type="button"
                      className={trashStyles.emptyTrash}
                      data-empty-trash
                      onClick={(e) => {
                        confirmTriggerRef.current = e.currentTarget;
                        setConfirm({ mode: "empty" });
                      }}
                    >
                      {t("trashView:actions.emptyTrash")}
                    </button>
                  )}
                </div>
              </div>
              <div
                ref={listRef}
                className={trashStyles.list}
                role="list"
                tabIndex={-1}
                aria-label={t("trashView:deletedPages")}
              >
                {filtered.length === 0 ? (
                  <div className={trashStyles.noResults} role="status">
                    {t("trashView:noSearchMatches")}
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
                        aria-label={t("trashView:aria.openFromTrash", { title: pageTitle(p) })}
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
                          aria-label={t("trashView:aria.restorePage", { title: pageTitle(p) })}
                          onClick={() => void restoreFromTrash(p)}
                        >
                          {t("trashView:actions.restore")}
                        </button>
                        {canPermanentlyDeletePage(p.id) && (
                          <button
                            type="button"
                            className={trashStyles.delete}
                            aria-label={t("trashView:aria.deletePageForever", {
                              title: pageTitle(p),
                            })}
                            onClick={(e) => {
                              confirmTriggerRef.current = e.currentTarget;
                              setConfirm({ mode: "delete", page: p });
                            }}
                          >
                            {t("trashView:actions.deleteForever")}
                          </button>
                        )}
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
                ? t("trashView:aria.cancelPermanentDelete")
                : t("trashView:aria.cancelEmptyTrash")
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
                ? t("trashView:confirm.deleteTitle")
                : t("trashView:confirm.emptyTitle")}
            </div>
            <p id={dialogDescriptionId}>
              {confirm.mode === "delete" ? (
                <>
                  {t("trashView:confirm.deleteBodyPrefix")}
                  <strong>{pageTitle(confirm.page)}</strong>
                  {t("trashView:confirm.deleteBodySuffix")}
                </>
              ) : (
                t("trashView:confirm.emptyBody", { count: trashed.length })
              )}
            </p>
            <div className={trashStyles.confirmActions}>
              <button ref={cancelButtonRef} type="button" onClick={() => closeConfirm(true)}>
                {t("common:actions.cancel")}
              </button>
              <button
                type="button"
                className={trashStyles.confirmDelete}
                onClick={() => void confirmAction()}
              >
                {confirm.mode === "delete"
                  ? t("trashView:actions.deleteForever")
                  : t("trashView:actions.emptyTrash")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
