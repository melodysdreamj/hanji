"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { isolateBodyForModal, trapModalTab } from "@/lib/modalFocus";
import styles from "./ImagePreviewDialog.module.css";

export function ImagePreviewDialog({
  src,
  alt,
  label,
  closeLabel,
  onClose,
}: {
  src: string;
  alt: string;
  label: string;
  closeLabel: string;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreIsolation = isolateBodyForModal([backdropRef.current]);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());

    function onDocumentKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }

    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", onDocumentKeyDown);
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      restoreIsolation();
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restore?.isConnected) window.requestAnimationFrame(() => restore.focus());
    };
  }, [onClose]);

  const dialog = (
    // The backdrop click is a pointer shortcut; the close button and Escape
    // provide equivalent keyboard paths.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={backdropRef}
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-attachment-image-preview
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        trapModalTab(event, backdropRef.current);
      }}
    >
      <button
        ref={closeRef}
        type="button"
        className={styles.close}
        aria-label={closeLabel}
        onClick={onClose}
      >
        ×
      </button>
      <img className={styles.image} src={src} alt={alt} />
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
