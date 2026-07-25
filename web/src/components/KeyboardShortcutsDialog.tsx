"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  detectKeyboardShortcutPlatform,
  isComposingKeyEvent,
  KEYBOARD_SHORTCUTS,
  shortcutDisplayKeys,
  type KeyboardShortcutCategory,
  type KeyboardShortcutPlatform,
} from "@/lib/keyboardShortcuts";
import { Search, X } from "@/icons/hanji";
import styles from "./KeyboardShortcutsDialog.module.css";

const CATEGORIES: readonly KeyboardShortcutCategory[] = [
  "popular",
  "createStyle",
  "editMove",
];

export function KeyboardShortcutsDialog({
  onClose,
  platform = detectKeyboardShortcutPlatform(),
  restoreFocusTo,
}: {
  onClose: () => void;
  platform?: KeyboardShortcutPlatform;
  restoreFocusTo?: HTMLElement | null;
}) {
  const { t } = useTranslation("keyboardShortcuts");
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const resultsId = useId();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<KeyboardShortcutCategory>("popular");

  useEffect(() => {
    restoreFocusRef.current = restoreFocusTo ?? (
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    );
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [restoreFocusTo]);

  const close = useCallback(() => {
    const restore = restoreFocusRef.current;
    onClose();
    window.requestAnimationFrame(() => {
      if (restore?.isConnected) restore.focus({ preventScroll: true });
    });
  }, [onClose]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleShortcuts = useMemo(() => KEYBOARD_SHORTCUTS.filter((shortcut) => {
    if (!shortcut.helpVisible) return false;
    if (!normalizedQuery) return shortcut.category === category;
    const haystack = [
      t(shortcut.labelKey),
      "searchTermsKey" in shortcut ? t(shortcut.searchTermsKey) : "",
    ].join(" ").toLowerCase();
    return haystack.includes(normalizedQuery);
  }), [category, normalizedQuery, t]);

  function dialogFocusables() {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => element.getAttribute("aria-hidden") !== "true" && element.tabIndex >= 0);
  }

  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || isComposingKeyEvent(event)) return;
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
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className={styles.overlay} data-keyboard-shortcuts-overlay>
      <button
        type="button"
        className={styles.backdrop}
        tabIndex={-1}
        aria-label={t("closeBackdrop")}
        onClick={close}
      />
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-keyboard-shortcuts-dialog
        onKeyDown={onDialogKeyDown}
      >
        <header className={styles.header}>
          <h1 id={titleId}>{t("title")}</h1>
          <button type="button" className={styles.close} aria-label={t("close")} onClick={close}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <label className={styles.search}>
          <Search size={18} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            aria-label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className={styles.body}>
          <div
            className={styles.categories}
            role="tablist"
            aria-label={t("categoriesLabel")}
            aria-orientation="vertical"
          >
            {CATEGORIES.map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={category === value}
                aria-controls={resultsId}
                data-active={category === value ? "true" : undefined}
                onClick={() => {
                  setCategory(value);
                  setQuery("");
                }}
              >
                {t(`categories.${value}`)}
              </button>
            ))}
          </div>
          <section
            id={resultsId}
            className={styles.results}
            role="tabpanel"
            aria-label={normalizedQuery ? t("searchResults") : t(`categories.${category}`)}
          >
            <h2>{normalizedQuery ? t("searchResults") : t(`categories.${category}`)}</h2>
            <div className={styles.rows}>
              {visibleShortcuts.map((shortcut) => (
                <div
                  key={shortcut.id}
                  className={styles.row}
                  data-shortcut-row
                  data-shortcut-id={shortcut.id}
                >
                  <span className={styles.label}>{t(shortcut.labelKey)}</span>
                  <span className={styles.chords} aria-label={t("keysFor", { action: t(shortcut.labelKey) })}>
                    {shortcutDisplayKeys(shortcut.id, platform).map((keys, chordIndex) => (
                      <span className={styles.chordGroup} key={`${shortcut.id}-${keys.join("-")}`}>
                        {chordIndex > 0 ? <span className={styles.or}>{t("or")}</span> : null}
                        <span className={styles.chord}>
                          {keys.map((key) => <kbd key={key}>{key}</kbd>)}
                        </span>
                      </span>
                    ))}
                  </span>
                </div>
              ))}
              {visibleShortcuts.length === 0 ? (
                <div className={styles.empty} role="status">{t("empty")}</div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
