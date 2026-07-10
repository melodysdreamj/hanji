import { defineFunction } from '@edge-base/shared';
import { bestEffort } from '../lib/table-utils';
import { hostResolvesToBlockedAddress, normalizePublicUrl } from '../lib/ssrf-guard';

interface FunctionContext {
  auth?: { id: string; email?: string } | null;
  request?: Request;
}

interface UrlMetadata {
  url: string;
  title: string;
  iconUrl?: string;
  siteName?: string;
  description?: string;
}

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 7000;

function jsonError(status: number, message: string) {
  return Response.json({ code: status, message }, { status });
}

async function requestJson(request?: Request): Promise<Record<string, unknown>> {
  if (!request) return {};
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function fetchHtml(url: string, redirects = 0): Promise<{ finalUrl: string; html: string }> {
  // normalizePublicUrl (at entry and on each hop) only vets the literal host;
  // a public DNS name can still point at an internal address, so resolve and
  // re-check before every fetch.
  if (await hostResolvesToBlockedAddress(new URL(url).hostname)) {
    throw new Error('Source host is not allowed.');
  }
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (compatible; HanjiBot/1.0)',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status >= 300 && response.status < 400) {
    if (redirects >= MAX_REDIRECTS) throw new Error('Too many redirects.');
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect is missing a destination.');
    const nextUrl = normalizePublicUrl(new URL(location, url).toString());
    if (!nextUrl) throw new Error('Redirect destination is not allowed.');
    return fetchHtml(nextUrl, redirects + 1);
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType && !contentType.includes('html') && !contentType.includes('xml') && !contentType.includes('text/')) {
    return { finalUrl: response.url || url, html: '' };
  }
  return { finalUrl: response.url || url, html: await readLimitedText(response) };
}

async function readLimitedText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) {
    return (await response.text()).slice(0, MAX_HTML_BYTES);
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (bytes < MAX_HTML_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    const remaining = MAX_HTML_BYTES - bytes;
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    bytes += chunk.byteLength;
    text += decoder.decode(chunk, { stream: bytes < MAX_HTML_BYTES });
    if (value.byteLength > remaining) {
      await bestEffort('url-metadata reader.cancel', reader.cancel());
      break;
    }
  }
  text += decoder.decode();
  return text;
}

function metadataFromHtml(html: string, finalUrl: string): UrlMetadata {
  const title =
    cleanText(metaContent(html, ['og:title', 'twitter:title']) || titleContent(html)) ||
    hostnameTitle(finalUrl);
  const siteName = cleanText(metaContent(html, ['og:site_name', 'application-name']));
  const description = cleanText(metaContent(html, ['og:description', 'twitter:description', 'description']));
  const iconUrl = iconHref(html, finalUrl);
  return {
    url: finalUrl,
    title: title.slice(0, 140),
    ...(iconUrl ? { iconUrl } : {}),
    ...(siteName ? { siteName: siteName.slice(0, 80) } : {}),
    ...(description ? { description: description.slice(0, 240) } : {}),
  };
}

function metaContent(html: string, names: string[]) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(tag[0]);
    const name = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (wanted.has(name) && attrs.content) return attrs.content;
  }
  return '';
}

function titleContent(html: string) {
  return /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
}

function iconHref(html: string, finalUrl: string) {
  const candidates: string[] = [];
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(tag[0]);
    const rel = (attrs.rel || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!attrs.href) continue;
    if (rel.includes('icon') || rel.includes('apple-touch-icon') || rel.includes('shortcut')) {
      candidates.push(attrs.href);
    }
  }
  for (const href of candidates) {
    const resolved = resolvePublicUrl(href, finalUrl);
    if (resolved) return resolved;
  }
  return resolvePublicUrl('/favicon.ico', finalUrl);
}

function resolvePublicUrl(href: string, baseUrl: string) {
  try {
    return normalizePublicUrl(new URL(href, baseUrl).toString());
  } catch {
    return '';
  }
}

function attributes(tag: string) {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag))) {
    attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function cleanText(value: string | undefined) {
  return decodeHtmlEntities(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    if (normalized === 'nbsp') return ' ';
    const codePoint = normalized.startsWith('#x')
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
  });
}

function hostnameTitle(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return 'Link';
  }
}

export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  if (!context.auth?.id) return jsonError(401, 'Authentication required.');
  const body = await requestJson(context.request);
  const url = normalizePublicUrl(body.url);
  if (!url) return jsonError(400, 'A public http(s) URL is required.');

  try {
    const { finalUrl, html } = await fetchHtml(url);
    return Response.json({ metadata: metadataFromHtml(html, finalUrl) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read URL metadata.';
    return jsonError(502, message);
  }
});
