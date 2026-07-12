"use client";

import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { DbProperty, PropertyType } from "@/lib/types";
import { useStore } from "@/lib/store";
import { localizedPropertyTypeLabel } from "./propertyTypes";
import styles from "./database.module.css";

// A stored cell value that would be reinterpreted (or orphaned) by a type
// change. `false` and empty containers count as empty — they carry no data a
// user would miss.
function isNonEmptyStoredValue(value: unknown): boolean {
  if (value == null || value === "" || value === false) return false;
  if (Array.isArray(value)) return value.some((item) => item != null && item !== "");
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(
      (item) => item != null && item !== ""
    );
  }
  return true;
}

function propertyHasStoredValues(prop: DbProperty): boolean {
  return useStore
    .getState()
    .dbRows(prop.databaseId)
    .some((row) => isNonEmptyStoredValue(row.properties?.[prop.id]));
}

type PendingTypeChange = {
  propName: string;
  nextType: PropertyType;
  apply: () => void;
};

/**
 * Guard for property type changes: applies immediately when the property has
 * no stored row values (or the type is unchanged), otherwise shows a
 * localized confirmation dialog — cancel is the safe default — warning that
 * existing values may display differently or be lost.
 *
 * Shared by every type-change path (table column header, row property panel,
 * view-settings property detail) so none of them silently reinterprets data.
 */
export function usePropertyTypeChangeConfirm() {
  const { t } = useTranslation(["propertyTypeChangeConfirm", "common"]);
  const [pending, setPending] = useState<PendingTypeChange | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!pending) return;
    const frame = window.requestAnimationFrame(() => cancelButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [pending]);

  function confirmPropertyTypeChange(prop: DbProperty, nextType: PropertyType, apply: () => void) {
    if (nextType === prop.type || !propertyHasStoredValues(prop)) {
      apply();
      return;
    }
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPending({ propName: prop.name, nextType, apply });
  }

  function closeDialog(restoreFocus: boolean) {
    setPending(null);
    if (restoreFocus) {
      const target = restoreFocusRef.current;
      window.requestAnimationFrame(() => {
        if (target?.isConnected) target.focus();
      });
    }
    restoreFocusRef.current = null;
  }

  function applyPending() {
    if (!pending) return;
    const { apply } = pending;
    closeDialog(false);
    apply();
  }

  function dialogFocusables() {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function onDialogKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeDialog(true);
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

  const typeChangeConfirmDialog = pending
    ? createPortal(
        <div className={styles.typeConfirmOverlay}>
          <button
            type="button"
            className={styles.typeConfirmBackdrop}
            aria-label={t("propertyTypeChangeConfirm:cancelAria")}
            tabIndex={-1}
            onClick={() => closeDialog(true)}
          />
          <div
            ref={dialogRef}
            className={styles.typeConfirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onKeyDown={onDialogKeyDown}
          >
            <div id={titleId} className={styles.typeConfirmTitle}>
              {t("propertyTypeChangeConfirm:title")}
            </div>
            <p id={descriptionId}>
              {t("propertyTypeChangeConfirm:message", {
                propName: pending.propName,
                typeLabel: localizedPropertyTypeLabel(pending.nextType),
              })}
            </p>
            <div className={styles.typeConfirmActions}>
              <button ref={cancelButtonRef} type="button" onClick={() => closeDialog(true)}>
                {t("common:actions.cancel")}
              </button>
              <button
                type="button"
                className={styles.typeConfirmApply}
                onClick={applyPending}
              >
                {t("propertyTypeChangeConfirm:confirm")}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  return { confirmPropertyTypeChange, typeChangeConfirmDialog };
}
