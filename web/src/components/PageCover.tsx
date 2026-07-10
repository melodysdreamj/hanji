"use client";

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { COVER_PRESETS } from "@/lib/covers";
import { useWorkspaceFileUrl } from "@/lib/fileUrls";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { uploadWorkspaceFile } from "@/lib/storage";
import type { UploadProgress } from "@/lib/storage";
import { useStore } from "@/lib/store";
import { safeStoredFileUrl } from "@/lib/urls";
import { focusEditable } from "./editor/focus";
import styles from "./PageCover.module.css";

type CoverTab = "gallery" | "upload" | "link";
type CoverUploadProgress = UploadProgress & { fileName: string };

const COVER_TABS: CoverTab[] = ["gallery", "upload", "link"];
const GALLERY_COLUMNS = 3;

function clampPosition(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function coverImage(cover: string, resolvedUrl?: string) {
  if (cover.startsWith("linear-gradient")) return cover;
  const url = resolvedUrl ?? safeStoredFileUrl(cover, ["data:image/"]);
  return url ? `url("${url.replace(/"/g, '\\"')}")` : "none";
}

function isSafeCoverUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function coverUploadProgressLabel(progress: UploadProgress) {
  if (progress.phase === "preparing") return "Preparing upload";
  if (progress.phase === "finalizing") return "Finalizing";
  if (progress.phase === "complete") return "Complete";
  return "Uploading";
}

export function PageCover({
  pageId,
  compact = false,
  readOnly = false,
}: {
  pageId: string;
  compact?: boolean;
  readOnly?: boolean;
}) {
  const page = useStore((s) => s.pagesById[pageId]);
  const updatePage = useStore((s) => s.updatePage);
  const notify = useStore((s) => s.notify);
  const [repositioning, setRepositioning] = useState(false);
  const [draftPosition, setDraftPosition] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tab, setTab] = useState<CoverTab>("gallery");
  const [linkDraft, setLinkDraft] = useState("");
  const [linkError, setLinkError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [uploadProgress, setUploadProgress] = useState<CoverUploadProgress | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | undefined>();
  const coverRef = useRef<HTMLDivElement>(null);
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startPosition: number; height: number } | null>(null);
  const coverMenuId = useId();
  const linkErrorId = useId();
  const signedCoverUrl = useWorkspaceFileUrl(page?.cover, ["data:image/"]);

  const positionCoverMenu = useCallback(() => {
    const trigger = changeButtonRef.current;
    if (!trigger || typeof window === "undefined") return;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(420, window.innerWidth - margin * 2);
    const estimatedHeight = tab === "gallery" ? 236 : 150;
    const belowTop = rect.bottom + 6;
    const aboveTop = rect.top - estimatedHeight - 6;
    const fitsBelow = belowTop + estimatedHeight <= window.innerHeight - margin;
    const top = fitsBelow || aboveTop < margin
      ? Math.min(belowTop, window.innerHeight - estimatedHeight - margin)
      : aboveTop;

    setMenuStyle({
      position: "fixed",
      top: Math.max(margin, top),
      right: "auto",
      bottom: "auto",
      left: Math.max(
        margin,
        Math.min(rect.right - width, window.innerWidth - width - margin)
      ),
      width,
    });
  }, [tab]);

  useEffect(() => {
    if (!readOnly) return;
    const frame = window.requestAnimationFrame(() => {
      setMenuOpen(false);
      setMenuStyle(undefined);
      setRepositioning(false);
      setDraftPosition(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [readOnly]);

  useEffect(() => {
    if (!menuOpen) return;
    positionCoverMenu();
    const nextTab = tab;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>(`[data-cover-tab="${nextTab}"]`)
        ?.focus();
    });
    window.addEventListener("resize", positionCoverMenu);
    window.addEventListener("scroll", positionCoverMenu, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", positionCoverMenu);
      window.removeEventListener("scroll", positionCoverMenu, true);
    };
  }, [menuOpen, positionCoverMenu, tab]);

  if (!page?.cover) return null;

  const position = draftPosition ?? page.coverPosition ?? 50;
  // Gradients fill the whole box, so vertical repositioning has no visible
  // effect — only offer Reposition for real images (url/upload/link covers).
  const canReposition = !page.cover.startsWith("linear-gradient");

  function coverTabId(value: CoverTab) {
    return `${coverMenuId}-${value}-tab`;
  }

  function coverPanelId(value: CoverTab) {
    return `${coverMenuId}-${value}-panel`;
  }

  function closeCoverMenu(restoreFocus = false) {
    setMenuOpen(false);
    setMenuStyle(undefined);
    if (restoreFocus) {
      window.requestAnimationFrame(() => changeButtonRef.current?.focus());
    }
  }

  function applyCover(cover: string) {
    if (readOnly) return;
    updatePage(pageId, { cover, coverPosition: 50 });
    setDraftPosition(null);
    setRepositioning(false);
    closeCoverMenu(true);
  }

  function removeCover() {
    if (readOnly) return;
    const previousCover = page.cover;
    const previousCoverPosition = page.coverPosition ?? 50;
    updatePage(pageId, { cover: "", coverPosition: 50 });
    setDraftPosition(null);
    setRepositioning(false);
    setMenuOpen(false);
    setMenuStyle(undefined);
    notify("Removed cover", "success", {
      label: "Undo",
      onClick: () => {
        updatePage(pageId, { cover: previousCover, coverPosition: previousCoverPosition });
        notify("Restored cover", "success");
      },
    });
    // This component unmounts once the cover is cleared, so move focus to a
    // stable target (the page title) instead of letting it fall to <body>.
    window.requestAnimationFrame(() => focusEditable(`title:${pageId}`, "end"));
  }

  function startReposition() {
    if (readOnly) return;
    setDraftPosition(page.coverPosition ?? 50);
    closeCoverMenu();
    setRepositioning(true);
    window.requestAnimationFrame(() => coverRef.current?.focus());
  }

  function savePosition() {
    if (readOnly) return;
    updatePage(pageId, { coverPosition: position });
    setDraftPosition(null);
    setRepositioning(false);
    window.requestAnimationFrame(() => changeButtonRef.current?.focus());
  }

  function cancelPosition() {
    setDraftPosition(null);
    setRepositioning(false);
    window.requestAnimationFrame(() => changeButtonRef.current?.focus());
  }

  function repositionFocusables() {
    const cover = coverRef.current;
    if (!cover) return [];
    const items: HTMLElement[] = [
      cover,
      ...Array.from(
        cover.querySelectorAll<HTMLButtonElement>("[data-reposition-action]")
      ),
    ];
    return items.filter((item) => item.getClientRects().length > 0 && item.tabIndex >= 0);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!repositioning) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    drag.current = {
      startY: e.clientY,
      startPosition: position,
      height: Math.max(1, rect.height),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const cur = drag.current;
    if (!cur) return;
    const delta = ((e.clientY - cur.startY) / cur.height) * 100;
    setDraftPosition(clampPosition(cur.startPosition + delta));
  }

  function endDrag() {
    drag.current = null;
  }

  function onCoverKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!repositioning) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelPosition();
      return;
    }

    if (e.key === "Tab") {
      const focusables = repositionFocusables();
      if (!focusables.length) return;
      e.preventDefault();
      e.stopPropagation();
      const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
      const nextIndex =
        currentIndex === -1
          ? 0
          : (currentIndex + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
      focusables[nextIndex]?.focus();
      return;
    }

    if (!["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Enter"].includes(e.key)) {
      return;
    }

    const target = e.target as HTMLElement;
    if (target.closest("[data-reposition-action]") && e.key === "Enter") {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Enter") {
      savePosition();
      return;
    }

    const step = e.shiftKey || e.key === "PageUp" || e.key === "PageDown" ? 10 : 1;
    if (e.key === "ArrowUp") {
      setDraftPosition(clampPosition(position - step));
    } else if (e.key === "ArrowDown") {
      setDraftPosition(clampPosition(position + step));
    } else if (e.key === "PageUp") {
      setDraftPosition(clampPosition(position - step));
    } else if (e.key === "PageDown") {
      setDraftPosition(clampPosition(position + step));
    } else if (e.key === "Home") {
      setDraftPosition(0);
    } else if (e.key === "End") {
      setDraftPosition(100);
    }
  }

  async function pickFile(file?: File) {
    if (readOnly) return;
    if (!file || !file.type.startsWith("image/")) return;
    try {
      setUploadError("");
      setUploadProgress({ phase: "preparing", percent: 0, fileName: file.name || "Cover image" });
      const uploaded = await uploadWorkspaceFile(file, "covers", { pageId }, {
        onProgress: (progress) =>
          setUploadProgress({ ...progress, fileName: file.name || "Cover image" }),
      });
      setUploadProgress(null);
      applyCover(uploaded.url);
    } catch {
      setUploadProgress(null);
      setUploadError("Could not upload that image.");
      setTab("upload");
    }
  }

  function applyLink() {
    if (readOnly) return;
    const value = linkDraft.trim();
    if (!isSafeCoverUrl(value)) {
      setLinkError("Paste an http or https image link.");
      return;
    }
    setLinkError("");
    applyCover(value);
  }

  function coverMenuItems() {
    return Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[data-cover-menu-item]") ??
        [],
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function focusCoverTab(nextTab: CoverTab) {
    menuRef.current
      ?.querySelector<HTMLButtonElement>(`[data-cover-tab="${nextTab}"]`)
      ?.focus();
  }

  function setTabAndFocus(nextTab: CoverTab) {
    setTab(nextTab);
    window.requestAnimationFrame(() => focusCoverTab(nextTab));
  }

  function focusFirstPanelItem() {
    menuRef.current
      ?.querySelector<HTMLElement>(
        "[data-cover-panel] [data-cover-menu-item], [data-cover-panel] input:not([type='file'])",
      )
      ?.focus();
  }

  function onTabKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, currentTab: CoverTab) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "ArrowDown"].includes(e.key)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "ArrowDown") {
      focusFirstPanelItem();
      return;
    }

    const currentIndex = COVER_TABS.indexOf(currentTab);
    let nextIndex = currentIndex;
    if (e.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % COVER_TABS.length;
    } else if (e.key === "ArrowLeft") {
      nextIndex = currentIndex > 0 ? currentIndex - 1 : COVER_TABS.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = COVER_TABS.length - 1;
    }
    setTabAndFocus(COVER_TABS[nextIndex]);
  }

  function onGalleryKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      return;
    }
    const tiles = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-cover-tile]"),
    );
    if (tiles.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const currentIndex = tiles.findIndex((tile) => tile === document.activeElement);
    let nextIndex = currentIndex >= 0 ? currentIndex : 0;

    if (e.key === "ArrowRight") {
      nextIndex = currentIndex >= 0 ? (currentIndex + 1) % tiles.length : 0;
    } else if (e.key === "ArrowLeft") {
      nextIndex = currentIndex > 0 ? currentIndex - 1 : tiles.length - 1;
    } else if (e.key === "ArrowDown") {
      nextIndex =
        currentIndex >= 0
          ? Math.min(currentIndex + GALLERY_COLUMNS, tiles.length - 1)
          : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex =
        currentIndex >= 0
          ? Math.max(currentIndex - GALLERY_COLUMNS, 0)
          : 0;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = tiles.length - 1;
    }

    tiles[nextIndex]?.focus();
  }

  function menuFocusables() {
    return Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], input:not([type='file']):not([disabled]), [tabindex]:not([tabindex='-1'])",
      ) ?? [],
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (isComposingKeyEvent(e)) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeCoverMenu(true);
      return;
    }

    // Trap Tab/Shift+Tab inside the dialog so focus can't slip behind the
    // scrim to the page underneath.
    if (e.key === "Tab") {
      const focusables = menuFocusables();
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }

    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      return;
    }
    if (target.hasAttribute("data-cover-tab") || target.hasAttribute("data-cover-tile")) {
      return;
    }

    const items = coverMenuItems();
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    let nextIndex = currentIndex >= 0 ? currentIndex : 0;

    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : 0;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }

    items[nextIndex]?.focus();
  }

  return (
    <div
      ref={coverRef}
      className={styles.cover}
      data-compact={compact ? "true" : undefined}
      data-menu-open={menuOpen ? "true" : undefined}
      data-repositioning={repositioning ? "true" : undefined}
      tabIndex={repositioning || !readOnly ? 0 : undefined}
      role={repositioning ? "slider" : !readOnly ? "group" : undefined}
      aria-label={repositioning ? "Cover vertical position" : !readOnly ? "Page cover" : undefined}
      aria-valuemin={repositioning ? 0 : undefined}
      aria-valuemax={repositioning ? 100 : undefined}
      aria-valuenow={repositioning ? position : undefined}
      aria-valuetext={repositioning ? `${position}% from top` : undefined}
      style={{
        backgroundImage: coverImage(page.cover, signedCoverUrl),
        backgroundPositionY: `${position}%`,
      }}
      onKeyDown={onCoverKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {menuOpen && (
        <button
          type="button"
          className={styles.menuScrim}
          aria-label="Close cover menu"
          tabIndex={-1}
          onClick={() => closeCoverMenu(true)}
        />
      )}
      {!readOnly && !repositioning && (
        <div className={styles.actions}>
          <button
            ref={changeButtonRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? coverMenuId : undefined}
            aria-label="Change page cover"
            onClick={() => {
              if (menuOpen) {
                closeCoverMenu(true);
                return;
              }
              positionCoverMenu();
              setMenuOpen(true);
            }}
          >
            Change cover
          </button>
          {canReposition && (
            <button type="button" aria-label="Reposition page cover" onClick={startReposition}>
              Reposition
            </button>
          )}
          <button
            type="button"
            className={styles.dangerAction}
            aria-label="Remove page cover"
            onClick={removeCover}
          >
            Remove
          </button>
          {menuOpen && (
            <div
              id={coverMenuId}
              ref={menuRef}
              className={styles.menu}
              style={menuStyle}
              role="dialog"
              aria-label="Change cover"
              onKeyDown={onMenuKeyDown}
            >
              <div className={styles.tabs} role="tablist" aria-label="Cover source">
                <button
                  id={coverTabId("gallery")}
                  type="button"
                  role="tab"
                  aria-selected={tab === "gallery"}
                  aria-controls={coverPanelId("gallery")}
                  tabIndex={tab === "gallery" ? 0 : -1}
                  data-cover-menu-item
                  data-cover-tab="gallery"
                  data-active={tab === "gallery" ? "true" : undefined}
                  onClick={() => setTab("gallery")}
                  onKeyDown={(e) => onTabKeyDown(e, "gallery")}
                >
                  Gallery
                </button>
                <button
                  id={coverTabId("upload")}
                  type="button"
                  role="tab"
                  aria-selected={tab === "upload"}
                  aria-controls={coverPanelId("upload")}
                  tabIndex={tab === "upload" ? 0 : -1}
                  data-cover-menu-item
                  data-cover-tab="upload"
                  data-active={tab === "upload" ? "true" : undefined}
                  onClick={() => setTab("upload")}
                  onKeyDown={(e) => onTabKeyDown(e, "upload")}
                >
                  Upload
                </button>
                <button
                  id={coverTabId("link")}
                  type="button"
                  role="tab"
                  aria-selected={tab === "link"}
                  aria-controls={coverPanelId("link")}
                  tabIndex={tab === "link" ? 0 : -1}
                  data-cover-menu-item
                  data-cover-tab="link"
                  data-active={tab === "link" ? "true" : undefined}
                  onClick={() => setTab("link")}
                  onKeyDown={(e) => onTabKeyDown(e, "link")}
                >
                  Link
                </button>
              </div>

              {tab === "gallery" && (
                <div
                  id={coverPanelId("gallery")}
                  className={styles.galleryGrid}
                  data-cover-panel
                  role="tabpanel"
                  aria-labelledby={coverTabId("gallery")}
                  onKeyDown={onGalleryKeyDown}
                >
                  {COVER_PRESETS.map((cover, index) => (
                    <button
                      type="button"
                      key={cover}
                      className={styles.coverTile}
                      data-cover-menu-item
                      data-cover-tile
                      data-selected={page.cover === cover ? "true" : undefined}
                      style={{ backgroundImage: coverImage(cover) }}
                      aria-label={`Select cover ${index + 1}`}
                      aria-pressed={page.cover === cover}
                      onClick={() => applyCover(cover)}
                    />
                  ))}
                </div>
              )}

              {tab === "upload" && (
                <div
                  id={coverPanelId("upload")}
                  className={styles.uploadPane}
                  data-cover-panel
                  role="tabpanel"
                  aria-labelledby={coverTabId("upload")}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    tabIndex={-1}
                    aria-hidden="true"
                    accept="image/*"
                    onChange={(e) => void pickFile(e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    data-cover-menu-item
                    aria-label="Upload cover image from this device"
                    disabled={!!uploadProgress}
                    aria-busy={!!uploadProgress}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploadProgress ? "Uploading..." : "Upload file"}
                  </button>
                  {uploadProgress && (
                    <div className={styles.uploadProgress} role="status" aria-live="polite">
                      <div className={styles.uploadProgressHeader}>
                        <strong>{coverUploadProgressLabel(uploadProgress)}</strong>
                        <span>{uploadProgress.percent}%</span>
                      </div>
                      <div className={styles.uploadProgressName}>{uploadProgress.fileName}</div>
                      <div
                        className={styles.uploadProgressTrack}
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={uploadProgress.percent}
                        aria-label={`Uploading ${uploadProgress.fileName}`}
                      >
                        <span style={{ width: `${uploadProgress.percent}%` }} />
                      </div>
                    </div>
                  )}
                  {uploadError && (
                    <div className={styles.linkError}>{uploadError}</div>
                  )}
                </div>
              )}

              {tab === "link" && (
                <div
                  id={coverPanelId("link")}
                  className={styles.linkPane}
                  data-cover-panel
                  role="tabpanel"
                  aria-labelledby={coverTabId("link")}
                >
                  <input
                    value={linkDraft}
                    aria-label="Cover image link"
                    aria-invalid={!!linkError}
                    aria-describedby={linkError ? linkErrorId : undefined}
                    onChange={(e) => {
                      setLinkDraft(e.target.value);
                      setLinkError("");
                    }}
                    placeholder="Paste image link"
                    onKeyDown={(e) => {
                      if (isComposingKeyEvent(e)) return;
                      if (e.key === "Enter") applyLink();
                    }}
                  />
                  <button type="button" data-cover-menu-item onClick={applyLink}>
                    Submit
                  </button>
                  {linkError && <div id={linkErrorId} className={styles.linkError}>{linkError}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {repositioning && (
        <div className={styles.repositionBar}>
          <span>Drag image to reposition</span>
          <button type="button" data-reposition-action onClick={cancelPosition}>
            Cancel
          </button>
          <button type="button" data-reposition-action onClick={savePosition}>
            Save position
          </button>
        </div>
      )}
    </div>
  );
}
