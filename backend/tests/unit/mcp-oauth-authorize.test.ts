import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET, POST } from '../../functions/mcp-oauth-authorize';
import type { DbRef } from '../../lib/mcp-oauth';
import { fakeDb as makeFakeDb, type FakeDb } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

const ORIGIN = 'https://app.example.com';
const CLIENT_ID = 'client-1';
const REDIRECT_URI = 'https://client.example.com/callback';
const ENV = {
  HANJI_APP_ORIGIN: ORIGIN,
  HANJI_MCP_OAUTH_SECRET: 'unit-test-secret',
};
const AUTH = { id: 'user-1', email: 'user-1@example.com' };

function oauthDb(): FakeDb {
  return makeFakeDb({
    mcp_oauth_clients: [{
      id: 'client-row-1',
      clientId: CLIENT_ID,
      clientName: 'Test client',
      redirectUris: [REDIRECT_URI],
      status: 'active',
      lastUsedAt: new Date().toISOString(),
    }],
    workspaces: [{ id: 'workspace-1', ownerId: AUTH.id, name: 'Synthetic Workspace' }],
  });
}

function authorizeRequest(scope: string | undefined) {
  const url = new URL('/api/functions/mcp-oauth-authorize', ORIGIN);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('code_challenge', 'test-pkce-challenge');
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', `${ORIGIN}/api/functions/mcp`);
  url.searchParams.set('state', 'original-state');
  if (scope !== undefined) url.searchParams.set('scope', scope);
  return new Request(url);
}

function cimdAuthorizeRequest(clientId: string, redirectUri: string) {
  const url = new URL('/api/functions/mcp-oauth-authorize', ORIGIN);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', 'test-pkce-challenge');
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', `${ORIGIN}/api/functions/mcp`);
  url.searchParams.set('scope', 'pages:read');
  return new Request(url);
}

async function getConsent(db: FakeDb, scope: string | undefined) {
  return await handlerOf(GET)({
    request: authorizeRequest(scope),
    env: ENV,
    auth: AUTH,
    admin: { db: () => db as unknown as DbRef },
  }) as Response;
}

function consentToken(html: string) {
  const match = html.match(/name="consent_request" value="([^"]+)"/);
  if (!match) throw new Error('consent_request token missing from consent page');
  return match[1];
}

async function postConsent(
  db: FakeDb,
  fields: Record<string, string>,
  auth: { id: string; email?: string } = AUTH,
) {
  const request = new Request(`${ORIGIN}/api/functions/mcp-oauth-authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  return await handlerOf(POST)({
    request,
    env: ENV,
    auth,
    admin: { db: () => db as unknown as DbRef },
  }) as Response;
}

describe('MCP OAuth authorization consent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects explicitly empty and unsupported scope requests before rendering consent', async () => {
    for (const scope of ['', 'unsupported:scope', 'pages:read unsupported:scope']) {
      const response = await getConsent(oauthDb(), scope);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('data-mcp-consent');
    }
  });

  it('rejects empty approval and scope injection instead of falling back to broad defaults', async () => {
    const db = oauthDb();
    const get = await getConsent(db, 'pages:read pages:write');
    expect(get.status).toBe(200);
    const token = consentToken(await get.text());

    const empty = await postConsent(db, {
      consent_request: token,
      decision: 'approve',
      workspace_access: 'all_accessible',
    });
    expect(empty.status).toBe(400);
    expect(db.tables.mcp_oauth_grants ?? []).toHaveLength(0);

    const injected = await postConsent(db, {
      consent_request: token,
      decision: 'approve',
      workspace_access: 'all_accessible',
      'scope:pages:read': '1',
      'scope:files:write': '1',
    });
    expect(injected.status).toBe(400);
    expect(db.tables.mcp_oauth_grants ?? []).toHaveLength(0);
  });

  it('uses the signed original request and allows only a non-empty requested subset', async () => {
    const db = oauthDb();
    const get = await getConsent(db, 'pages:read pages:write');
    const token = consentToken(await get.text());
    const response = await postConsent(db, {
      consent_request: token,
      decision: 'approve',
      workspace_access: 'selected',
      'workspace:workspace-1': '1',
      'scope:pages:read': '1',
      // These unsigned legacy fields must not be authoritative.
      client_id: 'attacker-client',
      redirect_uri: 'https://attacker.example/callback',
      state: 'attacker-state',
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe('original-state');
    expect(location.searchParams.get('code')).toMatch(/^mcp_code_/);
    expect(db.tables.mcp_oauth_grants).toHaveLength(1);
    expect(db.tables.mcp_oauth_grants[0]).toMatchObject({
      clientId: CLIENT_ID,
      scopes: ['pages:read'],
      workspaceAccess: 'selected',
      workspaceIds: ['workspace-1'],
      readOnly: true,
    });
  });

  it('rejects a tampered signed consent request without creating a grant', async () => {
    const db = oauthDb();
    const get = await getConsent(db, 'pages:read');
    const token = consentToken(await get.text());
    const response = await postConsent(db, {
      consent_request: `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`,
      decision: 'approve',
      workspace_access: 'all_accessible',
      'scope:pages:read': '1',
    });
    expect(response.status).toBe(400);
    expect(db.tables.mcp_oauth_grants ?? []).toHaveLength(0);
  });

  it('rejects a valid consent request replayed under another signed-in account', async () => {
    const db = oauthDb();
    const get = await getConsent(db, 'pages:read');
    const token = consentToken(await get.text());
    const response = await postConsent(db, {
      consent_request: token,
      decision: 'approve',
      workspace_access: 'all_accessible',
      'scope:pages:read': '1',
    }, { id: 'user-2', email: 'user-2@example.com' });
    expect(response.status).toBe(400);
    expect(db.tables.mcp_oauth_grants ?? []).toHaveLength(0);
  });

  it('bounds and times out attacker-controlled client metadata documents', async () => {
    const clientId = 'https://93.184.216.34/client.json';
    const redirectUri = 'https://client.example.com/callback';
    let observedSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      observedSignal = init?.signal;
      return new Response(JSON.stringify({
        client_id: clientId,
        client_name: 'Oversized client',
        redirect_uris: [redirectUri],
        padding: 'x'.repeat(70 * 1024),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const response = await handlerOf(GET)({
      request: cimdAuthorizeRequest(clientId, redirectUri),
      env: ENV,
      auth: AUTH,
      admin: { db: () => oauthDb() as unknown as DbRef },
    }) as Response;

    expect(response.status).toBe(400);
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });
});
