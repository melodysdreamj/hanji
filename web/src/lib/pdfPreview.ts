const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const PDF_HEADER_SCAN_BYTES = 1024;
const PDF_OBJECT_URL_LIFETIME_MS = 5 * 60 * 1000;

function hasPdfHeader(bytes: Uint8Array) {
  const scanLength = Math.min(bytes.length, PDF_HEADER_SCAN_BYTES);
  for (let index = 0; index <= scanLength - PDF_HEADER.length; index += 1) {
    if (PDF_HEADER.every((value, offset) => bytes[index + offset] === value)) return true;
  }
  return false;
}

function replacePreviewLocation(previewWindow: Window, url: string) {
  previewWindow.location.replace(url);
}

/**
 * Opens a PDF in a browser-owned viewer without relaxing EdgeBase's default
 * forced-download policy for active or unknown storage content.
 *
 * A blank tab is reserved synchronously so popup blockers see the user's
 * gesture. The attachment is then fetched, checked for a PDF signature, and
 * re-typed as a local PDF Blob for the browser viewer. If an external origin
 * blocks the fetch, the already-open tab falls back to that origin's URL.
 */
export async function openPdfInNewTab(
  resolveUrl: () => Promise<string> | string,
  fileName: string,
  onViewerReady?: () => void
) {
  const previewWindow = window.open("about:blank", "_blank");
  if (!previewWindow) return false;

  previewWindow.opener = null;
  try {
    previewWindow.document.title = fileName;
  } catch {
    // The initial blank page can be cross-origin in hardened browser modes.
  }

  let url = "";
  try {
    url = (await resolveUrl()).trim();
    if (!url) throw new Error("Missing PDF URL");

    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`PDF request failed with ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!hasPdfHeader(bytes)) throw new Error("Attachment is not a PDF");

    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), PDF_OBJECT_URL_LIFETIME_MS);
    onViewerReady?.();
    replacePreviewLocation(previewWindow, objectUrl);
    return true;
  } catch {
    // Cross-origin file links may not allow fetch/CORS. Keep the user's new-tab
    // intent and let that origin decide whether it can render or must download.
    if (url && !previewWindow.closed) {
      replacePreviewLocation(previewWindow, url);
      return true;
    }
    previewWindow.close();
    return false;
  }
}
