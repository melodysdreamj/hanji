type PageUrlOptions = {
  preserveCurrentSearch?: boolean;
  omitSearchParams?: string[];
};

function normalizeSearch(search?: string | URLSearchParams | null) {
  if (!search) return new URLSearchParams();
  if (typeof search === "string") {
    return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  }
  return new URLSearchParams(search);
}

export function pageHref(pageId: string, search?: string | URLSearchParams | null) {
  const path = `/p/${encodeURIComponent(pageId)}`;
  const suffix = search
    ? String(search).startsWith("?")
      ? String(search)
      : `?${search.toString()}`
    : "";
  return `${path}${suffix}`;
}

export function currentPageHref(pageId: string, opts: PageUrlOptions = {}) {
  if (typeof window === "undefined") return pageHref(pageId);
  const currentPath = pageHref(pageId);
  if (window.location.pathname !== currentPath) return pageHref(pageId);
  const search = new URLSearchParams(window.location.search);
  for (const key of opts.omitSearchParams ?? []) search.delete(key);
  const nextSearch = search.toString();
  return pageHref(pageId, nextSearch || null);
}

export function absolutePageUrl(pageId: string, opts: PageUrlOptions = {}) {
  const href = opts.preserveCurrentSearch ? currentPageHref(pageId, opts) : pageHref(pageId);
  if (typeof window === "undefined") return href;
  return new URL(href, window.location.origin).toString();
}

export function openPageInNewTab(pageId: string, opts: PageUrlOptions = {}) {
  window.open(
    opts.preserveCurrentSearch ? currentPageHref(pageId, opts) : pageHref(pageId),
    "_blank",
    "noopener,noreferrer"
  );
}

export function sharedPageHref(
  token: string,
  pageId?: string | null,
  search?: string | URLSearchParams | null
) {
  const path = `/share/${encodeURIComponent(token)}`;
  const params = normalizeSearch(search);
  if (pageId) params.set("page", pageId);
  else params.delete("page");
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export function currentSharedPageHref(token: string, pageId?: string | null, opts: PageUrlOptions = {}) {
  if (typeof window === "undefined") return sharedPageHref(token, pageId);
  const search = new URLSearchParams(window.location.search);
  for (const key of opts.omitSearchParams ?? []) search.delete(key);
  return sharedPageHref(token, pageId, search);
}

export function absoluteSharedPageUrl(token: string, pageId?: string | null, opts: PageUrlOptions = {}) {
  const href = opts.preserveCurrentSearch
    ? currentSharedPageHref(token, pageId, opts)
    : sharedPageHref(token, pageId);
  if (typeof window === "undefined") return href;
  return new URL(href, window.location.origin).toString();
}

export function openSharedPageInNewTab(token: string, pageId?: string | null, opts: PageUrlOptions = {}) {
  window.open(
    opts.preserveCurrentSearch
      ? currentSharedPageHref(token, pageId, opts)
      : sharedPageHref(token, pageId),
    "_blank",
    "noopener,noreferrer"
  );
}
