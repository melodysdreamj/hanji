function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parse every Hanji page-link form without depending on a browser runtime. */
export function pageIdFromPageHref(href) {
  const raw = typeof href === 'string' ? href.trim() : '';
  if (!raw) return null;

  const schemeMatch = raw.match(/^hanji:\/\/page\/([^/?#]+)(?:[?#].*)?$/i);
  if (schemeMatch) return decodePathPart(schemeMatch[1]);

  let path = raw;
  try {
    const url = raw.startsWith('/') ? new URL(raw, 'http://hanji.local') : new URL(raw);
    path = url.pathname;
  } catch {
    path = raw.split(/[?#]/, 1)[0];
  }

  const match = path.match(/^\/p\/([^/]+)/);
  return match ? decodePathPart(match[1]) : null;
}

function spans(block, field) {
  const content = record(block?.content);
  const value = content?.[field];
  return Array.isArray(value) ? value.map(record).filter(Boolean) : [];
}

/**
 * Return unique reference targets in mention-first order. A block that both
 * mentions and links one page is one backlink whose kind is `mention`.
 */
export function pageReferenceTargets(block, normalizeHref = (href) => href) {
  const mentions = [];
  const links = [];
  for (const field of ['rich', 'caption']) {
    for (const span of spans(block, field)) {
      if (span.mention === 'page' && typeof span.pageId === 'string' && span.pageId) {
        mentions.push(span.pageId);
      }
    }
  }
  for (const field of ['rich', 'caption']) {
    for (const span of spans(block, field)) {
      const pageId = pageIdFromPageHref(normalizeHref(span.link));
      if (pageId) links.push(pageId);
    }
  }
  const content = record(block?.content);
  if (
    block?.type === 'link_to_page'
    && typeof content?.childPageId === 'string'
    && content.childPageId
  ) {
    links.push(content.childPageId);
  }

  const seen = new Set();
  const targets = [];
  for (const pageId of mentions) {
    if (seen.has(pageId)) continue;
    seen.add(pageId);
    targets.push({ pageId, kind: 'mention' });
  }
  for (const pageId of links) {
    if (seen.has(pageId)) continue;
    seen.add(pageId);
    targets.push({ pageId, kind: 'link' });
  }
  return targets;
}

export function blockReferenceKind(block, targetPageId, normalizeHref) {
  return pageReferenceTargets(block, normalizeHref)
    .find((target) => target.pageId === targetPageId)?.kind ?? null;
}
