const encoder = new TextEncoder();

async function stableWikiId(prefix: string, parts: string[]) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(parts.join('\u0000')));
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${prefix}-${hex.slice(0, 48)}`;
}

export function wikiOwnerRecordId(pageId: string, userId: string) {
  return stableWikiId('wiki-owner', [pageId, userId]);
}

export function wikiExpiryQueueId(pageId: string) {
  return stableWikiId('wiki-expiry', [pageId]);
}

export function wikiExpiryEmailDeliveryId(
  pageId: string,
  userId: string,
  expiresAt: string,
) {
  return stableWikiId('wiki-expiry-email', [pageId, userId, expiresAt]);
}
