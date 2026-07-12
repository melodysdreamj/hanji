import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST } from '../../functions/url-metadata';
import { fakeDb } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

// These tests mock fetch with fixed response sequences; the SSRF DNS
// resolve-then-check would consume those mocks with DoH lookups, so disable it
// here. The DNS behavior itself is covered by ssrf-guard.test.ts.
beforeAll(() => {
  process.env.HANJI_SSRF_DNS_CHECK = 'off';
});
afterAll(() => {
  delete process.env.HANJI_SSRF_DNS_CHECK;
});

const USER = 'user-1';

function htmlResponse(html: string, init: ResponseInit = {}) {
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
}

function redirectResponse(location?: string, status = 301) {
  return new Response(null, {
    status,
    headers: location ? { location } : {},
  });
}

async function metadataFor(res: unknown) {
  expect(res).toBeInstanceOf(Response);
  const response = res as Response;
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { metadata: Record<string, unknown> };
  return payload.metadata;
}

function call(userId: string | null, body: unknown) {
  return callFunction(POST, fakeDb(), userId, body);
}

describe('url-metadata POST', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires authentication before touching the network', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const res = await call(null, { url: 'https://example.com' });
    await expectErrorResponse(res, 401, 'Authentication required.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects missing and non-http(s) URLs without fetching', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    for (const body of [{}, { url: 'file:///etc/passwd' }, { url: 'javascript:alert(1)' }, { url: 'not a url' }]) {
      const res = await call(USER, body);
      await expectErrorResponse(res, 400, 'A public http(s) URL is required.');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces the SSRF guard on the initial URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const blocked = [
      'http://localhost:8787/admin',
      'http://127.0.0.1/secret',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/router',
      'https://[::1]/x',
    ];
    for (const url of blocked) {
      const res = await call(USER, { url });
      await expectErrorResponse(res, 400, 'A public http(s) URL is required.');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('extracts open-graph metadata and resolves the icon URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      htmlResponse(`
        <html><head>
          <meta property="og:title" content="Example &amp; Friends">
          <meta property="og:site_name" content="ExampleSite">
          <meta property="og:description" content="A description">
          <link rel="icon" href="/static/icon.png">
        </head><body></body></html>
      `),
    );
    const metadata = await metadataFor(await call(USER, { url: 'https://example.com/post#section' }));
    expect(metadata).toEqual({
      url: 'https://example.com/post',
      title: 'Example & Friends',
      siteName: 'ExampleSite',
      description: 'A description',
      iconUrl: 'https://example.com/static/icon.png',
    });
    // The fragment is stripped by the URL normalizer before fetching.
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/post');
  });

  it('falls back to the <title> tag and then the hostname', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      htmlResponse('<html><head><title> Plain  Title </title></head></html>'),
    );
    const withTitle = await metadataFor(await call(USER, { url: 'https://example.com/a' }));
    expect(withTitle.title).toBe('Plain Title');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse('<html><body>no title</body></html>'));
    const withoutTitle = await metadataFor(await call(USER, { url: 'https://www.example.com/b' }));
    expect(withoutTitle.title).toBe('example.com');
  });

  it('skips body parsing for non-HTML content types but still offers a favicon', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('binary-bytes', { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const metadata = await metadataFor(await call(USER, { url: 'https://example.com/photo.png' }));
    expect(metadata.title).toBe('example.com');
    expect(metadata.iconUrl).toBe('https://example.com/favicon.ico');
    expect(metadata.description).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows public redirects and reports the final URL', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirectResponse('https://cdn.example.org/final'))
      .mockResolvedValueOnce(htmlResponse('<title>Landed</title>'));
    const metadata = await metadataFor(await call(USER, { url: 'https://example.com/start' }));
    expect(metadata.url).toBe('https://cdn.example.org/final');
    expect(metadata.title).toBe('Landed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://cdn.example.org/final');
  });

  it('resolves relative redirect destinations against the current URL', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirectResponse('/moved', 302))
      .mockResolvedValueOnce(htmlResponse('<title>Moved</title>'));
    const metadata = await metadataFor(await call(USER, { url: 'https://example.com/old/path' }));
    expect(fetchMock.mock.calls[1][0]).toBe('https://example.com/moved');
    expect(metadata.url).toBe('https://example.com/moved');
  });

  it('enforces the SSRF guard on redirect targets', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirectResponse('http://169.254.169.254/latest/meta-data'));
    const res = await call(USER, { url: 'https://example.com/redirector' });
    await expectErrorResponse(res, 502, 'Redirect destination is not allowed.');
    // The private-host hop must never be fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirect without a location header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(redirectResponse(undefined));
    const res = await call(USER, { url: 'https://example.com/redirector' });
    await expectErrorResponse(res, 502, 'Redirect is missing a destination.');
  });

  it('stops after the redirect limit', async () => {
    let hop = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      hop += 1;
      return redirectResponse(`https://example.com/hop-${hop}`);
    });
    const res = await call(USER, { url: 'https://example.com/hop-0' });
    await expectErrorResponse(res, 502, 'Too many redirects.');
    // Initial request plus MAX_REDIRECTS follow-ups.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('truncates oversized bodies at the byte cap', async () => {
    // The <title> sits beyond the 512 KiB read limit, so it must not be parsed.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      htmlResponse(`${'x'.repeat(512 * 1024)}<title>Hidden tail</title>`),
    );
    const metadata = await metadataFor(await call(USER, { url: 'https://example.com/huge' }));
    expect(metadata.title).toBe('example.com');
  });

  it('drops icon candidates pointing at blocked hosts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      htmlResponse('<title>Icons</title><link rel="icon" href="http://127.0.0.1/icon.png">'),
    );
    const metadata = await metadataFor(await call(USER, { url: 'https://example.com/icons' }));
    expect(metadata.iconUrl).toBe('https://example.com/favicon.ico');
  });

  it('maps network failures to 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket hang up'));
    const res = await call(USER, { url: 'https://example.com/down' });
    await expectErrorResponse(res, 502, 'socket hang up');
  });
});
