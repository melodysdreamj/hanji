import { describe, expect, it } from 'vitest';

import { GET } from '../../functions/mcp-oauth-authorize';
import type { DbRef } from '../../lib/mcp-oauth';
import { fakeDb as makeFakeDb, type Row } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

const ORIGIN = 'https://app.example.com';
const CLIENT_ID = 'client-1';
const REDIRECT_URI = 'https://client.example.com/callback';

function fakeDb(tables: Record<string, Row[]> = {}) {
  return makeFakeDb(tables) as unknown as DbRef;
}

function authorizeRequest() {
  const url = new URL('/api/functions/mcp-oauth-authorize', ORIGIN);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('code_challenge', 'test-pkce-challenge');
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', `${ORIGIN}/api/functions/mcp`);
  return new Request(url);
}

async function authorizePage(auth: { id: string; email?: string } | null) {
  const db = fakeDb({
    mcp_oauth_clients: [{
      id: CLIENT_ID,
      clientId: CLIENT_ID,
      clientName: 'Test client',
      redirectUris: [REDIRECT_URI],
      status: 'active',
    }],
  });
  const response = await handlerOf(GET)({
    request: authorizeRequest(),
    env: { NOTIONLIKE_APP_ORIGIN: ORIGIN },
    auth,
    admin: { db: () => db },
  }) as Response;
  expect(response.status).toBe(200);
  return response.text();
}

function expectCookieSessionBridge(html: string) {
  expect(html).toContain("credentials: 'include'");
  expect(html).toContain("'X-EdgeBase-Auth-Transport': 'cookie'");
  expect(html).toContain("body: '{}'");
  expect(html).not.toContain('edgebase:refresh-token');
  expect(html).not.toContain('localStorage');
  expect(html).not.toContain('sessionStorage');
  expect(html).not.toMatch(/body\s*:\s*JSON\.stringify\([^)]*refreshToken/);
}

describe('MCP OAuth browser session bridge', () => {
  it('uses only the HttpOnly refresh cookie on the signed-out login bridge', async () => {
    const html = await authorizePage(null);
    expect(html).toContain('data-mcp-login-status');
    expectCookieSessionBridge(html);
  });

  it('keeps the consent bridge access token in memory only', async () => {
    const html = await authorizePage({ id: 'user-1', email: 'user@example.com' });
    expect(html).toContain('data-mcp-consent');
    expect(html).toContain('Authorization');
    expectCookieSessionBridge(html);
  });
});
