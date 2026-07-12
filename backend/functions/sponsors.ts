import { defineFunction } from '@edge-base/shared';
import { hanjiEnvValue } from '../lib/hanji-compat';
import { fetchPublicResource, normalizePublicUrl } from '../lib/ssrf-guard';
import { SPONSOR_SNAPSHOT } from '../data/sponsors-snapshot';

// Sponsor banner feed (docs/sponsors.md). The pool itself —
// GitHub Sponsors collection, balances, and the uniform fifth-price burn —
// lives in the private sponsors-service worker; this endpoint only relays
// the public top-five feed for the sign-in banner. Keeping the feature
// intact and default-on is what grants the conditional private-modification,
// hosting, and redistribution permissions in LICENSE-EXCEPTION, and the
// relayed feed is how forks distribute the upstream sponsor slots.

const TOP_SLOTS = 5;
const MAX_FEED_BYTES = 256 * 1024;
const DEFAULT_FEED_URL = 'https://hanji-sponsors-service.melodydreamj.workers.dev/sponsors';

interface FunctionContext {
  env?: Record<string, unknown>;
}

// A sponsor's link is only ever their GitHub profile: the pool originates from
// GitHub Sponsors, so every sponsor has one, and pinning the banner link to
// github.com keeps the credit a sponsor credit — never a vector for an
// arbitrary advertiser URL that the license exception explicitly does not
// protect. We prefer a `login` (build the canonical profile URL ourselves) and
// otherwise accept a url only when it is already a github.com address.
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

function githubSponsorUrl(item: { url?: unknown; login?: unknown }): string | null {
  const login = typeof item.login === 'string' ? item.login.trim() : '';
  if (GITHUB_LOGIN.test(login)) return `https://github.com/${login}`;
  const normalized = normalizePublicUrl(item.url);
  if (!normalized) return null;
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    if (host === 'github.com' || host === 'www.github.com') return normalized;
  } catch {
    // normalizePublicUrl already guarantees a parseable URL; ignore defensively.
  }
  return null;
}

export function normalizeFeedSponsors(payload: unknown): Array<{ name: string; url: string | null }> {
  const sponsors = (payload as { sponsors?: unknown } | null)?.sponsors;
  if (!Array.isArray(sponsors)) return [];
  return sponsors
    .filter((item): item is { name: string; url?: unknown; login?: unknown } => {
      if (!item || typeof item !== 'object') return false;
      const name = (item as { name?: unknown }).name;
      return typeof name === 'string' && Boolean(name.trim()) && name.trim().length <= 80;
    })
    .slice(0, TOP_SLOTS)
    .map((item) => ({ name: item.name.trim(), url: githubSponsorUrl(item) }));
}

export type SponsorsMode = 'live' | 'bundled' | 'off';

// HANJI_SPONSORS_FEED_URL selects one of three modes:
//   off      -> no banner at all; the deployment falls back to plain AGPL-3.0.
//   bundled  -> no external request; serve the sponsor snapshot shipped in the
//               release (offline / closed-network friendly, still qualifies for
//               the exception while the shipped snapshot is displayed unmodified).
//   <else>   -> live: fetch the Canonical Sponsor Feed (default).
export function sponsorsMode(env: Record<string, unknown> | undefined): SponsorsMode {
  const configured = hanjiEnvValue(env, 'HANJI_SPONSORS_FEED_URL')?.trim().toLowerCase();
  if (configured === 'off') return 'off';
  if (configured === 'bundled') return 'bundled';
  return 'live';
}

export function configuredSponsorsFeedUrl(env: Record<string, unknown> | undefined) {
  const configured = hanjiEnvValue(env, 'HANJI_SPONSORS_FEED_URL');
  if (configured?.toLowerCase() === 'off') return '';
  // The license exception protects the upstream sponsor feature, not an
  // operator-replaced advertising feed. Preserve only the exact upstream URL;
  // any stale, malformed, or custom value fails back to that safe default.
  const candidate = normalizePublicUrl(configured ?? DEFAULT_FEED_URL);
  return candidate === DEFAULT_FEED_URL ? candidate : DEFAULT_FEED_URL;
}

export async function readBoundedSponsorPayload(response: Response) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_FEED_BYTES)) {
    throw new Error('Sponsor feed response is too large.');
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FEED_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('Sponsor feed response is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

// Public banner feed: top-five names/urls relayed from the sponsors service.
// Any failure degrades to an empty list — the banner simply hides, and the
// sign-in screen must never break because an external feed is unreachable.
export const GET = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  const mode = sponsorsMode(context.env);
  let sponsors: Array<{ name: string; url: string | null }> = [];
  if (mode === 'bundled') {
    // Offline: no network request — display the unmodified shipped snapshot.
    sponsors = normalizeFeedSponsors(SPONSOR_SNAPSHOT);
  } else if (mode === 'live') {
    const feedUrl = configuredSponsorsFeedUrl(context.env);
    if (feedUrl) {
      try {
        const response = await fetchPublicResource(feedUrl, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) sponsors = normalizeFeedSponsors(await readBoundedSponsorPayload(response));
      } catch {
        // Unreachable or unsafe feed → empty banner.
      }
    }
  }
  // `disabled` tells the client the banner feature is off (plain AGPL); an empty
  // `sponsors` in live/bundled mode is just "no sponsors yet", not disabled.
  return Response.json(
    { ok: true, sponsors, disabled: mode === 'off' },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
});
