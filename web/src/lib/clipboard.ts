import { readLegacyCompatibleClipboardData } from "@/lib/legacyNamespace";

export const HANJI_BLOCKS_MIME = "application/x-hanji-blocks";
export const HANJI_TABLE_ROWS_MIME = "application/x-hanji-table-rows";

export function readTextWithMime(data: DataTransfer, mime: string) {
  return readLegacyCompatibleClipboardData(data, mime);
}

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea path below.
    }
  }

  if (typeof document === "undefined") return false;
  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
    previousFocus?.focus({ preventScroll: true });
  }
}

function copyTextWithMimeEvent(text: string, entries: Record<string, string>) {
  if (typeof document === "undefined") return false;
  let wroteData = false;
  const onCopy = (event: ClipboardEvent) => {
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
    for (const [mime, data] of Object.entries(entries)) {
      if (data) event.clipboardData?.setData(mime, data);
    }
    wroteData = true;
  };
  document.addEventListener("copy", onCopy);
  try {
    return document.execCommand("copy") && wroteData;
  } finally {
    document.removeEventListener("copy", onCopy);
  }
}

export async function copyTextWithMime(
  text: string,
  mime: string,
  data: string,
  extraEntries: Record<string, string> = {},
): Promise<boolean> {
  const entries = { ...extraEntries, [mime]: data };
  if (!text && !Object.values(entries).some(Boolean)) return false;
  if (copyTextWithMimeEvent(text, entries)) return true;
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard?.write &&
    typeof ClipboardItem !== "undefined" &&
    typeof Blob !== "undefined"
  ) {
    try {
      const clipboardItem: Record<string, Blob> = {
        "text/plain": new Blob([text], { type: "text/plain" }),
      };
      for (const [entryMime, entryData] of Object.entries(entries)) {
        if (entryData) {
          clipboardItem[entryMime] = new Blob([entryData], {
            type: entryMime,
          });
        }
      }
      await navigator.clipboard.write([
        new ClipboardItem(clipboardItem),
      ]);
      return true;
    } catch {
      // Browser support for custom clipboard MIME types is uneven.
    }
  }
  return copyText(text);
}

export async function copyTextWithBlocks(
  text: string,
  blocksJson: string,
  html?: string,
): Promise<boolean> {
  return copyTextWithMime(
    text,
    HANJI_BLOCKS_MIME,
    blocksJson,
    html ? { "text/html": html } : {},
  );
}
