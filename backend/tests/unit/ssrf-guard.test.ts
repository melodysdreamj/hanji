import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchPublicResource,
  hostResolvesToBlockedAddress,
  isBlockedHostname,
  normalizePublicUrl,
  resetSsrfDnsCacheForTests,
} from '../../lib/ssrf-guard';

// Routes DoH lookups to a fake resolver table and everything else to the
// provided handler, so tests control both the DNS answers and the content
// fetches that fetchPublicResource makes.
function mockFetchWithDns(
  dns: Record<string, string[]>,
  handler: (url: string) => Response | Promise<Response> = () => new Response('ok', { status: 200 }),
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      const parsed = new URL(url);
      const name = parsed.searchParams.get('name') ?? '';
      const type = parsed.searchParams.get('type');
      const addresses = (dns[name] ?? []).filter((ip) =>
        type === 'AAAA' ? ip.includes(':') : !ip.includes(':'),
      );
      return new Response(
        JSON.stringify({
          Answer: addresses.map((data) => ({ type: type === 'AAAA' ? 28 : 1, data })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return handler(url);
  });
}

describe('isBlockedHostname', () => {
  it('blocks loopback, link-local, and private hosts', () => {
    const blocked = [
      'localhost',
      '127.0.0.1',
      '169.254.169.254',
      '10.0.0.5',
      '172.16.0.1',
      '192.168.1.1',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1',
    ];
    for (const host of blocked) {
      expect(isBlockedHostname(host), host).toBe(true);
    }
  });

  it('allows public hosts', () => {
    expect(isBlockedHostname('example.com')).toBe(false);
    expect(isBlockedHostname('8.8.8.8')).toBe(false);
    expect(isBlockedHostname('2606:4700:4700::1111')).toBe(false); // public IPv6 (Cloudflare)
  });

  it('blocks non-dotted IPv6 forms of private/loopback addresses', () => {
    const blocked = [
      '::ffff:7f00:1', // hex-form IPv4-mapped 127.0.0.1
      '[::ffff:7f00:1]', // bracketed literal
      '::ffff:a9fe:a9fe', // hex-form IPv4-mapped 169.254.169.254 (cloud metadata)
      '::', // unspecified
      '0:0:0:0:0:0:0:0',
      '64:ff9b::7f00:1', // NAT64 of 127.0.0.1
      '64:ff9b::', // NAT64 prefix
      'ff02::1', // multicast
      'fd12:3456:789a::1', // unique local
      'fe80::abcd', // link-local
      '::ffff:192.168.1.1', // dotted IPv4-mapped private
    ];
    for (const host of blocked) {
      expect(isBlockedHostname(host), host).toBe(true);
    }
  });

  it('fails closed on colon-bearing hosts that are not valid IPv6 literals', () => {
    expect(isBlockedHostname('not:an:ip')).toBe(true);
    expect(isBlockedHostname(':::1')).toBe(true);
  });
});

describe('normalizePublicUrl', () => {
  it('returns the canonical URL for public http(s) targets', () => {
    expect(normalizePublicUrl('https://example.com/file.png')).toBe('https://example.com/file.png');
    expect(normalizePublicUrl('http://8.8.8.8/x')).toBe('http://8.8.8.8/x');
  });

  it('rejects private/loopback hosts and non-http(s) schemes', () => {
    expect(normalizePublicUrl('http://127.0.0.1/secret')).toBe('');
    expect(normalizePublicUrl('http://169.254.169.254/latest/meta-data')).toBe('');
    expect(normalizePublicUrl('https://[::1]/x')).toBe('');
    expect(normalizePublicUrl('file:///etc/passwd')).toBe('');
    expect(normalizePublicUrl('not a url')).toBe('');
  });
});

describe('hostResolvesToBlockedAddress', () => {
  beforeEach(() => resetSsrfDnsCacheForTests());
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NOTIONLIKE_SSRF_DNS_CHECK;
  });

  it('blocks a public name whose A record points at a private address', async () => {
    mockFetchWithDns({ 'evil.example.com': ['10.0.0.1'] });
    expect(await hostResolvesToBlockedAddress('evil.example.com')).toBe(true);
  });

  it('blocks a public name whose AAAA record points at a loopback-mapped address', async () => {
    mockFetchWithDns({ 'evil6.example.com': ['93.184.216.34', '::ffff:7f00:1'] });
    expect(await hostResolvesToBlockedAddress('evil6.example.com')).toBe(true);
  });

  it('allows a name resolving only to public addresses', async () => {
    mockFetchWithDns({ 'good.example.com': ['93.184.216.34', '2606:4700:4700::1111'] });
    expect(await hostResolvesToBlockedAddress('good.example.com')).toBe(false);
  });

  it('fails closed when resolution errors or returns no addresses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('oops', { status: 500 }));
    expect(await hostResolvesToBlockedAddress('unresolvable.example.com')).toBe(true);
    resetSsrfDnsCacheForTests();
    vi.restoreAllMocks();
    mockFetchWithDns({}); // resolver reachable, zero answers
    expect(await hostResolvesToBlockedAddress('nxdomain.example.com')).toBe(true);
  });

  it('short-circuits blocked literals without any DNS lookup', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(await hostResolvesToBlockedAddress('127.0.0.1')).toBe(true);
    expect(await hostResolvesToBlockedAddress('8.8.8.8')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips resolution when NOTIONLIKE_SSRF_DNS_CHECK=off', async () => {
    process.env.NOTIONLIKE_SSRF_DNS_CHECK = 'off';
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(await hostResolvesToBlockedAddress('anything.example.com')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches the verdict per hostname', async () => {
    const fetchMock = mockFetchWithDns({ 'cached.example.com': ['93.184.216.34'] });
    await hostResolvesToBlockedAddress('cached.example.com');
    const callsAfterFirst = fetchMock.mock.calls.length;
    await hostResolvesToBlockedAddress('cached.example.com');
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('fetchPublicResource redirect re-validation', () => {
  const PUBLIC_DNS = {
    'example.com': ['93.184.216.34'],
    'cdn.example.org': ['93.184.216.35'],
  };

  beforeEach(() => resetSsrfDnsCacheForTests());
  afterEach(() => vi.restoreAllMocks());

  it('rejects a public URL that redirects to a private/loopback host', async () => {
    const fetched: string[] = [];
    mockFetchWithDns(PUBLIC_DNS, (url) => {
      fetched.push(url);
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    });
    await expect(fetchPublicResource('https://example.com/redirector')).rejects.toThrow('source host is not allowed');
    // The private-host hop must never be fetched.
    expect(fetched).toEqual(['https://example.com/redirector']);
  });

  it('rejects a private initial host before fetching', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    await expect(fetchPublicResource('http://127.0.0.1/x')).rejects.toThrow('source host is not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a name that passes literal checks but resolves to a private address', async () => {
    const fetched: string[] = [];
    mockFetchWithDns({ 'rebind.example.net': ['169.254.169.254'] }, (url) => {
      fetched.push(url);
      return new Response('ok', { status: 200 });
    });
    await expect(fetchPublicResource('https://rebind.example.net/x')).rejects.toThrow('source host is not allowed');
    expect(fetched).toEqual([]);
  });

  it('returns the response for an all-public redirect chain', async () => {
    const fetched: string[] = [];
    mockFetchWithDns(PUBLIC_DNS, (url) => {
      fetched.push(url);
      if (url === 'https://example.com/file') {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example.org/file.png' } });
      }
      return new Response('bytes', { status: 200 });
    });
    const res = await fetchPublicResource('https://example.com/file');
    expect(res.status).toBe(200);
    expect(fetched).toEqual(['https://example.com/file', 'https://cdn.example.org/file.png']);
  });
});
