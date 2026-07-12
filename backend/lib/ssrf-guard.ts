// Shared SSRF host guard for product functions that fetch caller-supplied URLs.
//
// `isBlockedHostname` rejects hosts that resolve to loopback, link-local, or
// private ranges (IPv4 and IPv6, including ::ffff:-mapped addresses).
// `normalizePublicUrl` validates an untrusted value is a public http(s) URL and
// returns its canonical string, or '' when it must not be fetched. Both are used
// by URL metadata previews and Notion file import to prevent authenticated SSRF.

import { hanjiEnvValue } from './hanji-compat';

export function normalizePublicUrl(value: unknown) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw || raw.length > 2048) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (isBlockedHostname(url.hostname)) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function isBlockedIpv4Parts(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

// Expand an IPv6 literal (with `::` compression and optional embedded dotted
// IPv4 suffix) into its 8 16-bit hextets, or null when it is not a well-formed
// IPv6 address. String-prefix matching misses non-dotted encodings of the same
// address (e.g. ::ffff:7f00:1 === 127.0.0.1), so we parse and inspect instead.
function parseIpv6ToHextets(input: string): number[] | null {
  let str = input.trim().toLowerCase();
  if (!str) return null;
  const zone = str.indexOf('%');
  if (zone >= 0) str = str.slice(0, zone); // drop scope id

  // Fold a trailing dotted-IPv4 (::ffff:127.0.0.1, ::127.0.0.1) into two hextets.
  const v4 = str.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hex = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    str = str.slice(0, str.length - v4[0].length) + hex;
  }

  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  let hextets: string[];
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    hextets = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    hextets = head;
  }
  if (hextets.length !== 8) return null;
  const nums = hextets.map((part) => (/^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

function isBlockedIpv6(h: number[]): boolean {
  // ::/96 — unspecified (::), loopback (::1) and IPv4-compatible (deprecated):
  // none are public.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) return true;
  // ::ffff:0:0/96 — IPv4-mapped (both dotted and hex forms). Inspect the
  // embedded IPv4 so ::ffff:7f00:1 is blocked exactly like 127.0.0.1.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isBlockedIpv4Parts(h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff);
  }
  // 64:ff9b::/96 — NAT64 well-known prefix (a translation target, never a
  // public IPv6 host).
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return true;
  }
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (fc/fd)
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export function isBlockedHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === 'localhost.localdomain') {
    return true;
  }

  const octets = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (octets) {
    const [a, b, c, d] = octets.slice(1).map((part) => Number(part));
    return isBlockedIpv4Parts(a, b, c, d);
  }

  if (normalized.includes(':')) {
    const hextets = parseIpv6ToHextets(normalized);
    // A colon-bearing host that is not a parseable IPv6 literal is not a valid
    // hostname either — fail closed rather than fetch it.
    if (!hextets) return true;
    return isBlockedIpv6(hextets);
  }

  return false;
}

const MAX_SSRF_REDIRECTS = 5;

// DNS resolve-then-check. The literal checks above miss a public DNS name
// whose record points at a loopback/private/link-local target (an attacker
// A record for 169.254.169.254). Before fetching a non-literal host, resolve
// it over DNS-over-HTTPS and apply the same blocked-range rules to every
// returned address. This closes attacker-controlled-DNS SSRF; it does not
// fully stop fast rebinding (fetch() re-resolves independently — pinning the
// checked address needs socket-level control the workers fetch API does not
// expose), so platform egress filtering remains the outer defense.
const DEFAULT_DOH_URL = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 5000;
const DNS_VERDICT_TTL_MS = 60_000;
const DNS_VERDICT_CACHE_MAX = 500;

const dnsVerdictCache = new Map<string, { blocked: boolean; expiresAt: number }>();

// Reads process.env only (no request-scoped bindings reach this module).
// Effective in dev/self-hosted runtimes where process env is injected; on
// hosted Cloudflare the defaults apply.
function ssrfEnv(name: string): string | undefined {
  return hanjiEnvValue(undefined, name);
}

// `HANJI_SSRF_DNS_CHECK=off` skips the resolution step for air-gapped or
// DoH-unreachable self-hosted runtimes. The literal-host checks still apply.
function dnsCheckDisabled(): boolean {
  const flag = ssrfEnv('HANJI_SSRF_DNS_CHECK')?.toLowerCase();
  return flag === 'off' || flag === 'false' || flag === '0';
}

function isIpLiteral(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return normalized.includes(':') || /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(normalized);
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  const endpoint = ssrfEnv('HANJI_SSRF_DOH_URL') ?? DEFAULT_DOH_URL;
  const lookups = [
    { type: 'A', code: 1 },
    { type: 'AAAA', code: 28 },
  ].map(async ({ type, code }) => {
    const url = new URL(endpoint);
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', type);
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`DoH lookup failed with ${response.status}`);
    const body = (await response.json()) as { Answer?: Array<{ type?: number; data?: string }> };
    return (body.Answer ?? [])
      .filter((answer) => answer.type === code && typeof answer.data === 'string')
      .map((answer) => (answer.data as string).trim());
  });
  return (await Promise.all(lookups)).flat().filter(Boolean);
}

// True when the host must not be fetched: a blocked literal, a name that
// resolves to a blocked address, or a name that cannot be verified at all —
// resolution failure and empty answers fail closed, because an unverifiable
// host is indistinguishable from a hidden internal one.
export async function hostResolvesToBlockedAddress(hostname: string): Promise<boolean> {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;
  if (isBlockedHostname(normalized)) return true;
  if (isIpLiteral(normalized)) return false; // literal, fully vetted above
  if (dnsCheckDisabled()) return false;
  const cached = dnsVerdictCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.blocked;
  let blocked: boolean;
  try {
    const addresses = await resolveAddresses(normalized);
    blocked = addresses.length === 0 || addresses.some((address) => isBlockedHostname(address));
  } catch {
    blocked = true;
  }
  if (dnsVerdictCache.size >= DNS_VERDICT_CACHE_MAX) dnsVerdictCache.clear();
  dnsVerdictCache.set(normalized, { blocked, expiresAt: Date.now() + DNS_VERDICT_TTL_MS });
  return blocked;
}

// Unit-test hook: verdicts are cached module-wide, so tests that reuse a
// hostname across cases must reset between them.
export function resetSsrfDnsCacheForTests() {
  dnsVerdictCache.clear();
}

/** Read a response body without trusting Content-Length or buffering past a cap. */
export async function readResponseBytesWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('response body exceeds the allowed size');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('response body exceeds the allowed size');
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('response body exceeds the allowed size').catch(() => {});
      throw new Error('response body exceeds the allowed size');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Fetch a caller-supplied http(s) URL while re-validating the host on every
// redirect hop. A single initial-host check is insufficient: a public host can
// 3xx-redirect to a loopback/link-local/private target, so we follow redirects
// manually and reject any hop that points at a non-public host.
export async function fetchPublicResource(url: string, init: RequestInit = {}): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_SSRF_REDIRECTS; hop += 1) {
    let hostname = '';
    try {
      hostname = new URL(current).hostname;
    } catch {
      throw new Error('source host is not allowed');
    }
    if (!normalizePublicUrl(current) || (await hostResolvesToBlockedAddress(hostname))) {
      throw new Error('source host is not allowed');
    }
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error('too many redirects');
}
