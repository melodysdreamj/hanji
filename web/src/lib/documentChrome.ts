import type { Page } from "./types";
import { safeStoredFileUrl } from "./urls";

const FAVICON_MARKER = "notionlike-dynamic-favicon";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function svgDataUrl(svg: string) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function emojiFaviconHref(emoji: string) {
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text x="16" y="23" text-anchor="middle" font-size="24">${escapeXml(emoji)}</text></svg>`
  );
}

const DEFAULT_FAVICON_HREF = svgDataUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="6" y="4" width="20" height="24" rx="2.8" fill="#fff" stroke="#2f3437" stroke-width="2"/><path d="M20 4v7h6" fill="none" stroke="#2f3437" stroke-width="2" stroke-linejoin="round"/></svg>'
);

const DATABASE_FAVICON_HREF = svgDataUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="5" y="6" width="22" height="20" rx="2.5" fill="#fff" stroke="#2f3437" stroke-width="2"/><path d="M5 13h22M12 6v20M20 6v20" stroke="#2f3437" stroke-width="2"/></svg>'
);

export const TRASH_FAVICON_HREF = svgDataUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M10 11h12l-1 15H11L10 11Z" fill="#fff" stroke="#2f3437" stroke-width="2" stroke-linejoin="round"/><path d="M8 9h16M13 9V6h6v3M14 14v8M18 14v8" stroke="#2f3437" stroke-width="2" stroke-linecap="round"/></svg>'
);

export function iconFaviconHref(icon: string | undefined) {
  const cleanIcon = icon?.trim();
  if (!cleanIcon) return DEFAULT_FAVICON_HREF;
  return safeStoredFileUrl(cleanIcon, ["data:image/"]) || emojiFaviconHref(cleanIcon);
}

export function pageFaviconHref(page: Pick<Page, "icon" | "iconType" | "kind"> | undefined | null) {
  if (!page) return DEFAULT_FAVICON_HREF;
  if (page.iconType === "image") {
    return safeStoredFileUrl(page.icon, ["data:image/"]) || DEFAULT_FAVICON_HREF;
  }
  if (page.iconType === "emoji" && page.icon) return emojiFaviconHref(page.icon);
  if (page.kind === "database") return DATABASE_FAVICON_HREF;
  return DEFAULT_FAVICON_HREF;
}

export function setDocumentChrome({ title, iconHref }: { title: string; iconHref?: string }) {
  document.title = title;

  let link = document.head.querySelector<HTMLLinkElement>(`link[data-${FAVICON_MARKER}="true"]`);
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.dataset.notionlikeDynamicFavicon = "true";
    document.head.appendChild(link);
  }
  const href = iconHref || DEFAULT_FAVICON_HREF;
  link.href = href;
  link.type = href.startsWith("data:image/svg+xml") ? "image/svg+xml" : "";
}
