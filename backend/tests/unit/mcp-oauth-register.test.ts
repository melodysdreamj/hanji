import { describe, expect, it } from 'vitest';

import { POST, registrationRateLimitKey } from '../../functions/mcp-oauth-register';
import type { DbRef } from '../../lib/mcp-oauth';
import { fakeDb, type FakeDb } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

function registrationRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('https://app.example.com/api/functions/mcp-oauth-register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function register(db: FakeDb, body: Record<string, unknown>) {
  return await handlerOf(POST)({
    request: registrationRequest(body),
    env: { HANJI_APP_ORIGIN: 'https://app.example.com' },
    admin: { db: () => db as unknown as DbRef },
  }) as Response;
}

describe('MCP dynamic client registration', () => {
  it('does not trust caller-supplied proxy headers unless the deployment opts in', () => {
    const spoofed = registrationRequest(
      { redirect_uris: ['https://client.example/callback'] },
      { 'CF-Connecting-IP': '198.51.100.10', 'X-Forwarded-For': '198.51.100.11' },
    );
    expect(registrationRateLimitKey(spoofed, {})).toBe('direct:untrusted');
    expect(registrationRateLimitKey(spoofed, { HANJI_MCP_TRUST_PROXY_HEADERS: 'true' }))
      .toBe('proxy:198.51.100.10');

    const cloudflare = registrationRequest(
      { redirect_uris: ['https://client.example/callback'] },
      { 'CF-Connecting-IP': '198.51.100.12' },
    ) as Request & { cf?: unknown };
    cloudflare.cf = { colo: 'ICN' };
    expect(registrationRateLimitKey(cloudflare, {})).toBe('cloudflare:198.51.100.12');
  });

  it('rejects non-HTTP loopback protocols and redirect fragments', async () => {
    const ftp = await register(fakeDb(), { redirect_uris: ['ftp://localhost/callback'] });
    expect(ftp.status).toBe(400);
    expect(await ftp.json()).toMatchObject({ error: 'invalid_redirect_uri' });

    const fragment = await register(fakeDb(), { redirect_uris: ['https://client.example/callback#fragment'] });
    expect(fragment.status).toBe(400);
    expect(await fragment.json()).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('accepts only the supported public PKCE client shape and prunes idle registrations', async () => {
    const db = fakeDb({
      mcp_oauth_clients: [{
        id: 'stale-client',
        clientId: 'stale-client',
        status: 'active',
        lastUsedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(),
      }],
    });
    const response = await register(db, {
      redirect_uris: ['http://localhost:3456/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_name: 'Synthetic client',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      redirect_uris: ['http://localhost:3456/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(db.tables.mcp_oauth_clients.some((client) => client.id === 'stale-client')).toBe(false);
    expect(db.tables.mcp_oauth_clients).toHaveLength(1);
  });
});
