import { normalizeLegacyHanjiUri } from "@/lib/legacyNamespace";

export function decodePathPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function pageIdFromPageHref(href: string | undefined) {
  const raw = normalizeLegacyHanjiUri(href?.trim() ?? "");
  if (!raw) return null;

  const schemeMatch = raw.match(/^hanji:\/\/page\/([^/?#]+)(?:[?#].*)?$/i);
  if (schemeMatch) return decodePathPart(schemeMatch[1]);

  let path = raw;
  try {
    const url = raw.startsWith("/") ? new URL(raw, "http://hanji.local") : new URL(raw);
    path = url.pathname;
  } catch {
    path = raw.split(/[?#]/, 1)[0];
  }

  const match = path.match(/^\/p\/([^/]+)/);
  return match ? decodePathPart(match[1]) : null;
}

export function remapPageHref(href: string | undefined, pageMap?: Map<string, string>) {
  if (!href) return href;
  const raw = normalizeLegacyHanjiUri(href.trim());
  if (!raw) return href;
  if (!pageMap || pageMap.size === 0) return raw;
  const isRelative = raw.startsWith("/");
  const schemeMatch = raw.match(/^(hanji:\/\/page\/)([^/?#]+)(.*)$/i);
  if (schemeMatch) {
    const nextPageId = pageMap.get(decodePathPart(schemeMatch[2]));
    return nextPageId ? `${schemeMatch[1]}${encodeURIComponent(nextPageId)}${schemeMatch[3]}` : raw;
  }

  try {
    const url = isRelative ? new URL(raw, "http://hanji.local") : new URL(raw);
    const pageId = pageIdFromPageHref(url.pathname);
    const nextPageId = pageId ? pageMap.get(pageId) : undefined;
    if (!nextPageId) return raw;
    url.pathname = url.pathname.replace(/^\/p\/[^/]+/, `/p/${encodeURIComponent(nextPageId)}`);
    return isRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch {
    const match = raw.match(/^(\/p\/)([^/?#]+)(.*)$/);
    if (!match) return raw;
    const nextPageId = pageMap.get(decodePathPart(match[2]));
    return nextPageId ? `${match[1]}${encodeURIComponent(nextPageId)}${match[3]}` : raw;
  }
}
