// Bundled sponsor snapshot for OFFLINE mode (HANJI_SPONSORS_FEED_URL=bundled).
//
// This is the OFFICIAL snapshot shipped with the Hanji release. The Sponsor
// Banner Exception grants its permissions to an offline deployment only while
// this snapshot is displayed UNMODIFIED — editing or replacing its contents is
// treated exactly like substituting the live Canonical Sponsor Feed and drops
// the deployment to plain AGPL-3.0 (see LICENSE-EXCEPTION §1-2, docs/sponsors.md).
//
// Maintenance: the Hanji project updates this ~monthly to mirror the live feed's
// top five after each fifth-price burn. Same shape the live feed relays — each
// entry is { name, login? , url? }; `login` builds the canonical github.com
// profile link, otherwise `url` is accepted only when it is already github.com.
// Empty is fine: offline deployments then fall back to the built-with credits.
export const SPONSOR_SNAPSHOT: {
  generatedAt: string;
  sponsors: Array<{ name: string; login?: string; url?: string | null }>;
} = {
  generatedAt: "2026-07-12",
  sponsors: [],
};
