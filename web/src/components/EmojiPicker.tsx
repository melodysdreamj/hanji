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
import { i18next } from "@/i18n";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { uploadWorkspaceFile, type WorkspaceFileTarget } from "@/lib/storage";
import type { UploadProgress } from "@/lib/storage";
import styles from "./EmojiPicker.module.css";

const EMOJIS: string[] = (
  "😀 😃 😄 😁 😆 😅 😂 🙂 😉 😊 😍 🤩 😘 😎 🤔 🤨 😴 😇 🥳 🤯 " +
  "👍 👎 👏 🙌 🙏 💪 ✍️ 👀 🧠 ❤️ 🔥 ⭐ ✨ 🎉 🎯 💡 ✅ ❌ ⚠️ ❓ " +
  "📄 📝 📌 📎 📁 📂 🗂 📅 📆 ⏰ 🔔 🔖 🏷 💼 📊 📈 📉 🧾 📚 📖 " +
  "🚀 🛠 ⚙️ 🔧 🔨 🧪 🔬 💻 🖥 ⌨️ 🖱 📱 🌐 🔗 🔒 🔑 💰 🛒 🎁 🏆 " +
  "🌟 🌈 ☀️ 🌙 ⛅ ❄️ 🌊 🌿 🌱 🌸 🍀 🍎 🍕 ☕ 🍵 🎵 🎨 🏠 🧭 🗺"
)
  .split(/\s+/)
  .filter(Boolean);

const EMOJI_KEYWORDS: Record<string, string> = {
  "😀": "smile happy face",
  "😃": "smile happy face",
  "😄": "smile happy face",
  "😁": "smile happy face",
  "😆": "laugh smile",
  "😅": "laugh sweat",
  "😂": "laugh tears",
  "🙂": "smile",
  "😉": "wink",
  "😊": "smile blush",
  "😍": "heart love",
  "🤩": "star excited",
  "😘": "kiss",
  "😎": "cool sunglasses",
  "🤔": "think thinking",
  "🤨": "question doubt",
  "😴": "sleep",
  "😇": "angel",
  "🥳": "party celebrate",
  "🤯": "mind blown",
  "👍": "thumbs up yes approve",
  "👎": "thumbs down no",
  "👏": "clap applause",
  "🙌": "raise hands celebrate",
  "🙏": "pray thanks",
  "💪": "strong muscle",
  "✍️": "write writing",
  "👀": "eyes look",
  "🧠": "brain think",
  "❤️": "heart love",
  "🔥": "fire hot",
  "⭐": "star favorite",
  "✨": "sparkle",
  "🎉": "party celebrate",
  "🎯": "target goal",
  "💡": "idea light",
  "✅": "check done tick complete success",
  "❌": "x close no cancel error",
  "⚠️": "warning alert",
  "❓": "question help",
  "📄": "page document file",
  "📝": "note memo write",
  "📌": "pin pinned",
  "📎": "clip attachment",
  "📁": "folder",
  "📂": "open folder",
  "🗂": "archive files",
  "📅": "calendar date",
  "📆": "calendar schedule",
  "⏰": "alarm clock time",
  "🔔": "bell notification",
  "🔖": "bookmark",
  "🏷": "tag label",
  "💼": "briefcase work",
  "📊": "chart graph",
  "📈": "chart growth",
  "📉": "chart down",
  "🧾": "receipt invoice",
  "📚": "books knowledge",
  "📖": "book read",
  "🚀": "rocket launch",
  "🛠": "tools build",
  "⚙️": "gear settings config options",
  "🔧": "wrench fix",
  "🔨": "hammer build",
  "🧪": "test lab",
  "🔬": "science microscope",
  "💻": "laptop computer",
  "🖥": "desktop computer",
  "⌨️": "keyboard",
  "🖱": "mouse",
  "📱": "phone mobile",
  "🌐": "web globe",
  "🔗": "link",
  "🔒": "lock secure",
  "🔑": "key",
  "💰": "money",
  "🛒": "cart shop",
  "🎁": "gift",
  "🏆": "trophy award",
  "🌟": "star shine",
  "🌈": "rainbow",
  "☀️": "sun sunny weather bright",
  "🌙": "moon night",
  "⛅": "cloud weather",
  "❄️": "snow cold",
  "🌊": "water wave",
  "🌿": "leaf nature",
  "🌱": "sprout plant",
  "🌸": "flower",
  "🍀": "clover luck",
  "🍎": "apple food",
  "🍕": "pizza food",
  "☕": "coffee",
  "🍵": "tea",
  "🎵": "music",
  "🎨": "art palette",
  "🏠": "home house",
  "🧭": "compass",
  "🗺": "map",
};

const GRID_COLUMNS = 10;
const RECENT_KEY = "hanji:recent-icons";
const MAX_RECENT = 20;
type IconUploadProgress = UploadProgress & { fileName: string };

function iconUploadProgressLabel(progress: UploadProgress) {
  if (progress.phase === "preparing") return i18next.t("emojiPicker:uploadProgress.preparing");
  if (progress.phase === "finalizing") return i18next.t("emojiPicker:uploadProgress.finalizing");
  if (progress.phase === "complete") return i18next.t("emojiPicker:uploadProgress.complete");
  return i18next.t("emojiPicker:uploadProgress.uploading");
}

function normalizeRecent(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((item): item is string => {
    if (typeof item !== "string" || !EMOJIS.includes(item) || seen.has(item)) return false;
    seen.add(item);
    return true;
  }).slice(0, MAX_RECENT);
}

function hasLifecycleTrackedUploadTarget(target?: WorkspaceFileTarget) {
  return [target?.pageId, target?.blockId].some(
    (value) => typeof value === "string" && value.trim().length > 0
  );
}

export function EmojiPicker({
  onPick,
  onPickImage,
  onRemove,
  onClose,
  uploadTarget,
  placement = "page",
}: {
  onPick: (emoji: string) => void;
  onPickImage?: (url: string) => void;
  onRemove?: () => void;
  onClose: () => void;
  uploadTarget?: WorkspaceFileTarget;
  placement?: "page" | "inline";
}) {
  const { t } = useTranslation("emojiPicker");
  const pickerId = useId();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"emoji" | "custom">("emoji");
  const [imageUrl, setImageUrl] = useState("");
  const [uploadProgress, setUploadProgress] = useState<IconUploadProgress | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [recent, setRecent] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return normalizeRecent(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"));
    } catch {
      return [];
    }
  });
  const [activeIndex, setActiveIndex] = useState(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const imageFileRef = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle && recent.length > 0) {
      return [...recent, ...EMOJIS.filter((emoji) => !recent.includes(emoji))];
    }
    if (!needle) return EMOJIS;
    return EMOJIS.filter((emoji) =>
      emoji.includes(needle) || (EMOJI_KEYWORDS[emoji] ?? "").includes(needle)
    );
  }, [q, recent]);
  const active = list.length === 0 ? -1 : Math.min(activeIndex, list.length - 1);
  const gridId = `${pickerId}-icons`;
  const hasRecent = q.trim().length === 0 && recent.length > 0;
  const cleanImageUrl = imageUrl.trim();
  const canUploadImageFile = hasLifecycleTrackedUploadTarget(uploadTarget);

  useEffect(() => {
    gridRef.current
      ?.querySelector(`[data-active="true"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function optionId(index: number) {
    return `${pickerId}-icon-${index}`;
  }

  function pickActive() {
    const emoji = list[active];
    if (emoji) pickEmoji(emoji);
  }

  function pickEmoji(emoji: string) {
    setRecent((current) => {
      const next = normalizeRecent([emoji, ...current.filter((item) => item !== emoji)]);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // Ignore private-mode storage failures.
      }
      return next;
    });
    onPick(emoji);
  }

  function pickImage() {
    if (!cleanImageUrl || !onPickImage) return;
    onPickImage(cleanImageUrl);
  }

  async function pickImageFile(file?: File) {
    // A completed upload without a concrete page/block owner cannot be
    // discovered when its icon reference is later replaced. Keep URL icons
    // available everywhere, but fail closed for device uploads unless the
    // upload can participate in the stored-file lifecycle.
    if (
      !hasLifecycleTrackedUploadTarget(uploadTarget) ||
      !file ||
      !file.type.startsWith("image/") ||
      !onPickImage
    ) return;
    try {
      setUploadError("");
      setUploadProgress({
        phase: "preparing",
        percent: 0,
        fileName: file.name || t("emojiPicker:custom.fallbackFileName"),
      });
      const uploaded = await uploadWorkspaceFile(file, "icons", uploadTarget, {
        onProgress: (progress) =>
          setUploadProgress({
            ...progress,
            fileName: file.name || t("emojiPicker:custom.fallbackFileName"),
          }),
      });
      setUploadProgress(null);
      onPickImage(uploaded.url);
    } catch {
      setUploadProgress(null);
      setUploadError(t("emojiPicker:custom.uploadFailed"));
    }
  }

  function focusOption(index: number) {
    window.requestAnimationFrame(() => {
      gridRef.current
        ?.querySelector<HTMLButtonElement>(`[data-emoji-index="${index}"]`)
        ?.focus();
    });
  }

  function setActive(nextIndex: number, focus = false) {
    if (list.length === 0) return;
    const bounded = Math.max(0, Math.min(nextIndex, list.length - 1));
    setActiveIndex(bounded);
    if (focus) focusOption(bounded);
  }

  function moveActive(delta: number, focus = false) {
    if (list.length === 0) return;
    setActive((active + delta + list.length) % list.length, focus);
  }

  function onResultKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(GRID_COLUMNS, true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-GRID_COLUMNS, true);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      moveActive(1, true);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      moveActive(-1, true);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      moveActive(GRID_COLUMNS * 3, true);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      moveActive(-GRID_COLUMNS * 3, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0, true);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(list.length - 1, true);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pickActive();
    }
  }

  function focusTab(nextTab: "emoji" | "custom") {
    window.requestAnimationFrame(() => {
      pickerRef.current
        ?.querySelector<HTMLButtonElement>(`[data-icon-tab="${nextTab}"]`)
        ?.focus();
    });
  }

  function setTabAndFocus(nextTab: "emoji" | "custom") {
    setTab(nextTab);
    focusTab(nextTab);
  }

  function focusFirstPanelItem() {
    window.requestAnimationFrame(() => {
      pickerRef.current
        ?.querySelector<HTMLElement>(
          "[data-icon-panel] input:not([type='file']):not([disabled]), [data-icon-panel] button:not([disabled])",
        )
        ?.focus();
    });
  }

  function onTabKeyDown(
    e: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: "emoji" | "custom"
  ) {
    if (!onPickImage) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "ArrowDown") {
      focusFirstPanelItem();
      return;
    }

    const tabs: ("emoji" | "custom")[] = ["emoji", "custom"];
    const currentIndex = tabs.indexOf(currentTab);
    let nextIndex = currentIndex;
    if (e.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = tabs.length - 1;
    setTabAndFocus(tabs[nextIndex]);
  }

  function pickerFocusables() {
    return Array.from(
      pickerRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([type='file']):not([disabled]), [tabindex]:not([tabindex='-1'])",
      ) ?? [],
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function onPickerKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || isComposingKeyEvent(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = pickerFocusables();
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
  }

  return (
    <>
      <button
        type="button"
        className={styles.backdrop}
        onClick={onClose}
        tabIndex={-1}
        aria-label={t("emojiPicker:dialog.backdropLabel")}
      />
      <div
        ref={pickerRef}
        className={styles.picker}
        data-placement={placement}
        role="dialog"
        aria-label={t("emojiPicker:dialog.label")}
        onKeyDown={onPickerKeyDown}
      >
        {onPickImage && (
          <div className={styles.tabs} role="tablist" aria-label={t("emojiPicker:tabs.groupLabel")}>
            <button
              type="button"
              className={styles.tab}
              role="tab"
              aria-selected={tab === "emoji"}
              tabIndex={tab === "emoji" ? 0 : -1}
              data-icon-tab="emoji"
              onClick={() => setTab("emoji")}
              onKeyDown={(e) => onTabKeyDown(e, "emoji")}
            >
              {t("emojiPicker:tabs.emoji")}
            </button>
            <button
              type="button"
              className={styles.tab}
              role="tab"
              aria-selected={tab === "custom"}
              tabIndex={tab === "custom" ? 0 : -1}
              data-icon-tab="custom"
              onClick={() => setTab("custom")}
              onKeyDown={(e) => onTabKeyDown(e, "custom")}
            >
              {t("emojiPicker:tabs.image")}
            </button>
          </div>
        )}
        {tab === "emoji" ? (
          <div data-icon-panel>
        <div className={styles.top}>
          <input
            className={styles.search}
            placeholder={t("emojiPicker:emoji.searchPlaceholder")}
            value={q}
            aria-label={t("emojiPicker:emoji.searchLabel")}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={gridId}
            aria-expanded="true"
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            onChange={(e) => {
              setQ(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(e) => {
              if (isComposingKeyEvent(e)) return;
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                moveActive(GRID_COLUMNS);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                moveActive(-GRID_COLUMNS);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                moveActive(1);
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                moveActive(-1);
              } else if (e.key === "PageDown") {
                e.preventDefault();
                moveActive(GRID_COLUMNS * 3);
              } else if (e.key === "PageUp") {
                e.preventDefault();
                moveActive(-GRID_COLUMNS * 3);
              } else if (e.key === "Home") {
                e.preventDefault();
                setActiveIndex(0);
              } else if (e.key === "End") {
                e.preventDefault();
                setActiveIndex(Math.max(0, list.length - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pickActive();
              }
            }}
            autoFocus
          />
          <button
            type="button"
            className={styles.random}
            disabled={list.length === 0}
            onClick={() => pickEmoji(list[Math.floor(Math.random() * list.length)])}
            aria-label={t("emojiPicker:emoji.randomLabel")}
          >
            {t("emojiPicker:emoji.random")}
          </button>
          {onRemove && (
            <button
              type="button"
              className={styles.remove}
              onClick={onRemove}
              aria-label={t("emojiPicker:remove.ariaLabel")}
            >
              {t("emojiPicker:remove.label")}
            </button>
          )}
        </div>
        {hasRecent && <div className={styles.sectionLabel}>{t("emojiPicker:emoji.recentLabel")}</div>}
        {list.length > 0 ? (
          <div
            id={gridId}
            className={styles.grid}
            ref={gridRef}
            role="listbox"
            tabIndex={-1}
            aria-label={hasRecent ? t("emojiPicker:emoji.gridLabelRecent") : t("emojiPicker:emoji.gridLabel")}
            onKeyDown={onResultKeyDown}
          >
            {list.map((e, i) => (
              <button
                id={optionId(i)}
                key={`${e}-${i}`}
                type="button"
                className={styles.emoji}
                role="option"
                aria-selected={i === active}
                tabIndex={i === active ? 0 : -1}
                data-emoji-index={i}
                data-active={i === active ? "true" : undefined}
                onMouseEnter={() => setActiveIndex(i)}
                onFocus={() => setActiveIndex(i)}
                onClick={() => pickEmoji(e)}
                aria-label={t("emojiPicker:emoji.optionLabel", { emoji: e })}
              >
                {e}
              </button>
            ))}
          </div>
        ) : (
          <div className={styles.empty} role="status">
            {t("emojiPicker:emoji.noResults", { query: q.trim() })}
          </div>
        )}
          </div>
        ) : (
          <div className={styles.customPanel} data-icon-panel>
            <div className={styles.customPreview} data-empty={!cleanImageUrl ? "true" : undefined}>
              {cleanImageUrl ? <img src={cleanImageUrl} alt="" /> : t("emojiPicker:custom.previewPlaceholder")}
            </div>
            {canUploadImageFile && (
              <input
                ref={imageFileRef}
                className={styles.fileInput}
                type="file"
                accept="image/*"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  void pickImageFile(e.currentTarget.files?.[0]);
                  e.currentTarget.value = "";
                }}
              />
            )}
            <input
              className={styles.imageInput}
              value={imageUrl}
              placeholder={t("emojiPicker:custom.linkPlaceholder")}
              aria-label={t("emojiPicker:custom.linkLabel")}
              onChange={(e) => {
                setImageUrl(e.target.value);
                if (uploadError) setUploadError("");
              }}
              onKeyDown={(e) => {
                if (isComposingKeyEvent(e)) return;
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  pickImage();
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className={styles.applyImage}
              disabled={!cleanImageUrl}
              onClick={pickImage}
            >
              {t("emojiPicker:custom.apply")}
            </button>
            {canUploadImageFile && (
              <button
                type="button"
                className={styles.uploadImage}
                disabled={!!uploadProgress}
                aria-busy={!!uploadProgress}
                onClick={() => imageFileRef.current?.click()}
              >
                {uploadProgress ? t("emojiPicker:custom.uploading") : t("emojiPicker:custom.upload")}
              </button>
            )}
            {canUploadImageFile && uploadProgress && (
              <div className={styles.uploadProgress} role="status" aria-live="polite">
                <div className={styles.uploadProgressHeader}>
                  <strong>{iconUploadProgressLabel(uploadProgress)}</strong>
                  <span>{uploadProgress.percent}%</span>
                </div>
                <div className={styles.uploadProgressName}>{uploadProgress.fileName}</div>
                <div
                  className={styles.uploadProgressTrack}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={uploadProgress.percent}
                  aria-label={t("emojiPicker:custom.uploadingLabel", { fileName: uploadProgress.fileName })}
                >
                  <span style={{ width: `${uploadProgress.percent}%` }} />
                </div>
              </div>
            )}
            {canUploadImageFile && uploadError && (
              <div className={styles.uploadError} role="alert">
                {uploadError}
              </div>
            )}
            {onRemove && (
              <button
                type="button"
                className={styles.removeImage}
                aria-label={t("emojiPicker:remove.ariaLabel")}
                onClick={onRemove}
              >
                {t("emojiPicker:remove.label")}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
