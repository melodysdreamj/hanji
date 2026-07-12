import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  accessibleWorkspaces,
  authorizationChallenge,
  authorizationCodeExpiresAt,
  bearerToken,
  corsHeaders,
  endpointUrls,
  envValue,
  escapeHtml,
  findClient,
  grantIsActive,
  htmlPage,
  issueAccessToken,
  issueRefreshToken,
  json,
  jsonError,
  mcpOAuthClientIsActive,
  MCP_DEFAULT_SCOPES,
  MCP_SUPPORTED_SCOPES,
  normalizeScopes,
  optionsResponse,
  originOf,
  publicGrant,
  randomToken,
  readOnlyFromScopes,
  redirectWithParams,
  refreshTokenExpired,
  requestBody,
  revokeMcpGrantFamily,
  secondsFromNow,
  sha256Base64Url,
  signConsentRequest,
  signJwt,
  stringList,
  stringValue,
  validateMcpClientMetadata,
  validateMcpScopes,
  validateRedirectUri,
  verifyAccessToken,
  verifyConsentRequest,
  verifyPkce,
  type DbRef,
  type McpOAuthClient,
  type McpOAuthGrant,
  type McpOAuthRefreshToken,
  type VerifiedMcpAccessToken,
} from '../../lib/mcp-oauth';
import { fakeDb as makeFakeDb, type Row } from './helpers/fake-db';

const ORIGIN = 'https://app.example.com';
const RESOURCE = `${ORIGIN}/api/functions/mcp`;
const ENV = { HANJI_MCP_OAUTH_SECRET: 'topsecret', HANJI_APP_ORIGIN: ORIGIN };
const ORIGIN_ENV_NAMES = ['HANJI_APP_ORIGIN', 'EDGEBASE_APP_ORIGIN', 'HANJI_MCP_PUBLIC_ORIGIN'];
const SECRET_ENV_NAMES = [
  'HANJI_MCP_OAUTH_SECRET',
  'HANJI_MCP_JWT_SECRET',
  'JWT_USER_SECRET',
  'EDGEBASE_JWT_SECRET',
];

function fakeDb(tables: Record<string, Row[]> = {}) {
  return makeFakeDb(tables) as unknown as DbRef & { tables: Record<string, Row[]> };
}

async function withEnvCleared<T>(names: string[], run: () => Promise<T> | T): Promise<T> {
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function tokenPayload(overrides: Partial<VerifiedMcpAccessToken> = {}): VerifiedMcpAccessToken {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ORIGIN,
    aud: RESOURCE,
    sub: 'user1',
    grant_id: 'grant1',
    client_id: 'client1',
    scope: 'pages:read',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

function grant(overrides: Partial<McpOAuthGrant> = {}): McpOAuthGrant {
  return { id: 'grant1', userId: 'user1', clientId: 'client1', resource: RESOURCE, ...overrides };
}

describe('time helpers', () => {
  it('secondsFromNow returns an ISO timestamp that far in the future', () => {
    const before = Date.now();
    const parsed = Date.parse(secondsFromNow(90));
    expect(parsed).toBeGreaterThanOrEqual(before + 89_000);
    expect(parsed).toBeLessThanOrEqual(Date.now() + 91_000);
  });

  it('authorizationCodeExpiresAt is roughly ten minutes out', () => {
    const delta = Date.parse(authorizationCodeExpiresAt()) - Date.now();
    expect(delta).toBeGreaterThan(9 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});

describe('response helpers', () => {
  it('json serializes the body with a JSON content type', async () => {
    const res = json({ ok: true }, { status: 201 });
    expect(res.status).toBe(201);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('jsonError defaults the description to the error code', async () => {
    const res = jsonError(400, 'invalid_request');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request', error_description: 'invalid_request' });

    const detailed = jsonError(401, 'invalid_token', 'Token expired.');
    expect(await detailed.json()).toEqual({ error: 'invalid_token', error_description: 'Token expired.' });
  });

  it('corsHeaders echoes the request origin and falls back to *', () => {
    const withOrigin = corsHeaders(new Request('https://x.test', { headers: { Origin: 'https://client.test' } }));
    expect(withOrigin.get('Access-Control-Allow-Origin')).toBe('https://client.test');
    expect(withOrigin.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate');

    expect(corsHeaders().get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('optionsResponse is an empty 204', async () => {
    const res = optionsResponse();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('redirectWithParams appends only defined params', () => {
    const res = redirectWithParams('https://client.test/cb?state=abc', {
      code: 'c0de',
      error: undefined,
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.searchParams.get('code')).toBe('c0de');
    expect(location.searchParams.get('state')).toBe('abc');
    expect(location.searchParams.has('error')).toBe(false);
  });

  it('htmlPage escapes the title and sets an HTML content type', async () => {
    const res = htmlPage('<Danger> & "quotes"', '<p>body</p>', 403);
    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('&lt;Danger&gt; &amp; &quot;quotes&quot;');
    expect(text).toContain('<p>body</p>');
  });
});

describe('environment and origin helpers', () => {
  it('envValue prefers direct env values and trims them', () => {
    expect(envValue({ KEY: '  value  ' }, 'KEY')).toBe('value');
    expect(envValue({ KEY: true }, 'KEY')).toBe('true');
    expect(envValue({ KEY: false }, 'KEY')).toBe('false');
    expect(envValue({}, 'DEFINITELY_NOT_SET_ANYWHERE')).toBeUndefined();
  });

  it('envValue falls back to process.env', () => {
    process.env.MCP_OAUTH_TEST_ENV_VALUE = '  from-process  ';
    try {
      expect(envValue(undefined, 'MCP_OAUTH_TEST_ENV_VALUE')).toBe('from-process');
      expect(envValue({ MCP_OAUTH_TEST_ENV_VALUE: 'direct' }, 'MCP_OAUTH_TEST_ENV_VALUE')).toBe('direct');
    } finally {
      delete process.env.MCP_OAUTH_TEST_ENV_VALUE;
    }
  });

  it('originOf uses the configured origin, stripping trailing slashes', () => {
    expect(originOf(undefined, { HANJI_APP_ORIGIN: 'https://a.test///' })).toBe('https://a.test');
    expect(originOf(undefined, { EDGEBASE_APP_ORIGIN: 'https://b.test/' })).toBe('https://b.test');
  });

  it('originOf falls back to the request origin, then localhost', async () => {
    await withEnvCleared(ORIGIN_ENV_NAMES, () => {
      expect(originOf(new Request('https://req.test/some/path'), undefined)).toBe('https://req.test');
      expect(originOf(undefined, undefined)).toBe('http://localhost:8787');
    });
  });

  it('endpointUrls derives all endpoints from the origin', () => {
    const urls = endpointUrls({ env: { HANJI_APP_ORIGIN: ORIGIN } });
    expect(urls.origin).toBe(ORIGIN);
    expect(urls.resource).toBe(RESOURCE);
    expect(urls.protectedResource).toBe(`${ORIGIN}/api/functions/mcp-oauth-protected-resource`);
    expect(urls.authorizationServer).toBe(`${ORIGIN}/api/functions/mcp-oauth-authorization-server`);
    expect(urls.registration).toBe(`${ORIGIN}/api/functions/mcp-oauth-register`);
    expect(urls.authorize).toBe(`${ORIGIN}/api/functions/mcp-oauth-authorize`);
    expect(urls.token).toBe(`${ORIGIN}/api/functions/mcp-oauth-token`);
    expect(urls.revoke).toBe(`${ORIGIN}/api/functions/mcp-oauth-revoke`);
    expect(urls.connections).toBe(`${ORIGIN}/api/functions/mcp-connections`);
  });
});

describe('escapeHtml', () => {
  it('escapes HTML metacharacters and stringifies nullish input', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('requestBody', () => {
  it('returns an empty object without a request', async () => {
    expect(await requestBody()).toEqual({});
  });

  it('parses JSON bodies and ignores malformed or non-object JSON', async () => {
    const make = (body: string) =>
      new Request('https://x.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(await requestBody(make(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
    expect(await requestBody(make('{ nope'))).toEqual({});
    expect(await requestBody(make('"just a string"'))).toEqual({});
    expect(await requestBody(make('null'))).toEqual({});
  });

  it('parses url-encoded bodies as key/value pairs', async () => {
    const req = new Request('https://x.test', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=abc%20def',
    });
    expect(await requestBody(req)).toEqual({ grant_type: 'authorization_code', code: 'abc def' });
  });
});

describe('string helpers', () => {
  it('stringValue trims strings and falls back otherwise', () => {
    expect(stringValue('  hi  ')).toBe('hi');
    expect(stringValue(42)).toBe('');
    expect(stringValue(undefined, 'fallback')).toBe('fallback');
  });

  it('stringList splits strings on commas and whitespace', () => {
    expect(stringList('a b,c ,, d')).toEqual(['a', 'b', 'c', 'd']);
    expect(stringList([' a ', '', 7])).toEqual(['a', '7']);
    expect(stringList(undefined)).toEqual([]);
    expect(stringList(42)).toEqual([]);
  });
});

describe('scopes', () => {
  it('normalizeScopes keeps only supported scopes and dedupes', () => {
    expect(normalizeScopes('pages:read pages:read bogus:scope databases:write')).toEqual([
      'pages:read',
      'databases:write',
    ]);
  });

  it('normalizeScopes falls back to the defaults when nothing is requested', () => {
    expect(normalizeScopes(undefined)).toEqual(MCP_DEFAULT_SCOPES);
    expect(normalizeScopes('', ['pages:read'])).toEqual(['pages:read']);
  });

  it('normalizeScopes filters unsupported entries out of the fallback too', () => {
    expect(normalizeScopes(undefined, ['pages:read', 'bogus'])).toEqual(['pages:read']);
  });

  it('every default scope is supported', () => {
    const supported = new Set<string>(MCP_SUPPORTED_SCOPES);
    expect(MCP_DEFAULT_SCOPES.every((scope) => supported.has(scope))).toBe(true);
  });

  it('strict scope validation defaults only when omitted and rejects explicit empty/unknown values', () => {
    expect(validateMcpScopes(undefined)).toEqual(MCP_DEFAULT_SCOPES);
    expect(() => validateMcpScopes('')).toThrow('at least one supported MCP scope');
    expect(() => validateMcpScopes([])).toThrow('at least one supported MCP scope');
    expect(() => validateMcpScopes('pages:read unsupported:scope')).toThrow('Unsupported MCP scope');
    expect(validateMcpScopes('pages:read pages:read databases:write')).toEqual([
      'pages:read',
      'databases:write',
    ]);
  });

  it('readOnlyFromScopes is true only when no write scope is present', () => {
    expect(readOnlyFromScopes(['pages:read', 'databases:read'])).toBe(true);
    expect(readOnlyFromScopes(['pages:read', 'pages:write'])).toBe(false);
    expect(readOnlyFromScopes([])).toBe(true);
  });
});

describe('findClient', () => {
  it('returns the active registration and skips revoked ones', async () => {
    const db = fakeDb({
      mcp_oauth_clients: [
        { id: 'row1', clientId: 'abc', status: 'revoked' } as Row,
        { id: 'row2', clientId: 'abc' } as Row,
        { id: 'row3', clientId: 'other', status: 'active' } as Row,
      ],
    });
    const client = await findClient(db, 'abc');
    expect(client?.id).toBe('row2');
  });

  it('returns null when no active client matches', async () => {
    const db = fakeDb({ mcp_oauth_clients: [{ id: 'row1', clientId: 'abc', status: 'revoked' } as Row] });
    expect(await findClient(db, 'abc')).toBeNull();
    expect(await findClient(db, 'missing')).toBeNull();
  });

  it('expires dynamically registered clients after the idle retention window', async () => {
    const stale = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString();
    expect(mcpOAuthClientIsActive({ id: 'stale', clientId: 'stale', lastUsedAt: stale })).toBe(false);
    expect(mcpOAuthClientIsActive({ id: 'recent', clientId: 'recent', lastUsedAt: recent })).toBe(true);
    const db = fakeDb({
      mcp_oauth_clients: [{ id: 'stale', clientId: 'client', status: 'active', lastUsedAt: stale } as Row],
    });
    expect(await findClient(db, 'client')).toBeNull();
  });
});

describe('accessibleWorkspaces', () => {
  it('merges owned and member workspaces, skipping unknown roles', async () => {
    const db = fakeDb({
      workspaces: [
        { id: 'w1', ownerId: 'u1', name: 'Zeta' } as Row,
        { id: 'w2', ownerId: 'someone', name: 'Alpha' } as Row,
        { id: 'w3', ownerId: 'someone', name: 'Gamma' } as Row,
      ],
      workspace_members: [
        { id: 'm1', workspaceId: 'w2', userId: 'u1', role: 'guest' } as Row,
        { id: 'm2', workspaceId: 'w3', userId: 'u1', role: 'banana' } as Row,
        { id: 'm3', workspaceId: 'w1', userId: 'u1', role: 'admin' } as Row,
      ],
    });
    const workspaces = await accessibleWorkspaces(db, 'u1');
    expect(workspaces.map((workspace) => workspace.id)).toEqual(['w2', 'w1']);
  });

  it('defaults a missing membership role to member and sorts ties by id', async () => {
    const db = fakeDb({
      workspaces: [
        { id: 'w2', ownerId: 'someone', name: 'Same' } as Row,
        { id: 'w1', ownerId: 'someone', name: 'Same' } as Row,
      ],
      workspace_members: [
        { id: 'm1', workspaceId: 'w1', userId: 'u1', role: null } as Row,
        { id: 'm2', workspaceId: 'w2', userId: 'u1', role: 'member' } as Row,
      ],
    });
    const workspaces = await accessibleWorkspaces(db, 'u1');
    expect(workspaces.map((workspace) => workspace.id)).toEqual(['w1', 'w2']);
  });

  it('does not expose organization workspaces through stale membership after deactivation', async () => {
    const db = fakeDb({
      organizations: [{ id: 'org1', ownerId: 'owner' } as Row],
      workspaces: [
        { id: 'w-active', ownerId: 'owner', organizationId: 'org1', name: 'Active' } as Row,
        { id: 'w-deactivated', ownerId: 'u1', organizationId: 'org1', name: 'Deactivated' } as Row,
        { id: 'w-personal', ownerId: 'u1', name: 'Personal' } as Row,
      ],
      workspace_members: [
        { id: 'wm1', workspaceId: 'w-active', userId: 'u2', role: 'member' } as Row,
        { id: 'wm2', workspaceId: 'w-deactivated', userId: 'u1', role: 'owner' } as Row,
      ],
      organization_members: [
        { id: 'om1', organizationId: 'org1', userId: 'u1', status: 'deactivated' } as Row,
        { id: 'om2', organizationId: 'org1', userId: 'u2', status: 'active' } as Row,
      ],
    });
    expect((await accessibleWorkspaces(db, 'u1')).map((workspace) => workspace.id)).toEqual(['w-personal']);
    expect((await accessibleWorkspaces(db, 'u2')).map((workspace) => workspace.id)).toEqual(['w-active']);
  });

  it('fails closed when an organization-backed workspace outlives its organization row', async () => {
    const db = fakeDb({
      organizations: [],
      workspaces: [
        { id: 'w-orphan', ownerId: 'u1', organizationId: 'missing-org', name: 'Orphan' } as Row,
        { id: 'w-personal', ownerId: 'u1', name: 'Personal' } as Row,
      ],
      workspace_members: [],
      organization_members: [],
    });

    expect((await accessibleWorkspaces(db, 'u1')).map((workspace) => workspace.id)).toEqual(['w-personal']);
  });
});

describe('MCP client metadata', () => {
  it('accepts the supported public authorization-code client shape', () => {
    expect(validateMcpClientMetadata({
      redirect_uris: ['https://client.test/callback', 'http://localhost:3000/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_name: 'Test client',
    })).toMatchObject({
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
      clientName: 'Test client',
    });
  });

  it('rejects unsupported grants, response types, token auth, and unsafe loopback protocols', () => {
    expect(() => validateMcpClientMetadata({ redirect_uris: ['ftp://localhost/callback'] }))
      .toThrow('must use HTTPS');
    expect(() => validateMcpClientMetadata({ redirect_uris: ['https://client.test/cb'], grant_types: ['implicit'] }))
      .toThrow('must include authorization_code');
    expect(() => validateMcpClientMetadata({ redirect_uris: ['https://client.test/cb'], response_types: ['token'] }))
      .toThrow('exactly');
    expect(() => validateMcpClientMetadata({
      redirect_uris: ['https://client.test/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
    })).toThrow('must be none');
  });
});

describe('grantIsActive', () => {
  it('rejects missing, revoked, and non-active grants', () => {
    expect(grantIsActive(null)).toBe(false);
    expect(grantIsActive(undefined)).toBe(false);
    expect(grantIsActive(grant({ status: 'revoked' }))).toBe(false);
    expect(grantIsActive(grant({ revokedAt: '2024-01-01T00:00:00.000Z' }))).toBe(false);
  });

  it('honors expiry timestamps', () => {
    expect(grantIsActive(grant({ expiresAt: new Date(Date.now() - 1000).toISOString() }))).toBe(false);
    expect(grantIsActive(grant({ expiresAt: new Date(Date.now() + 60_000).toISOString() }))).toBe(true);
  });

  it('treats a missing status as active', () => {
    expect(grantIsActive(grant())).toBe(true);
    expect(grantIsActive(grant({ status: 'active' }))).toBe(true);
  });
});

describe('revokeMcpGrantFamily', () => {
  it('revokes the grant first and drains legacy active-token overflow within transact limits', async () => {
    const refreshTokens = Array.from({ length: 510 }, (_, index) => ({
      id: `rt-${index}`,
      grantId: 'grant1',
      userId: 'user1',
      clientId: 'client1',
      tokenHash: `hash-${index}`,
      resource: RESOURCE,
      status: 'active',
    } as Row));
    const db = fakeDb({
      mcp_oauth_grants: [{ ...grant(), status: 'active' } as Row],
      mcp_oauth_refresh_tokens: refreshTokens,
    });
    await revokeMcpGrantFamily(db, 'grant1', 'system:test');
    expect(db.tables.mcp_oauth_grants[0]).toMatchObject({
      status: 'revoked',
      revokedBy: 'system:test',
    });
    expect(db.tables.mcp_oauth_refresh_tokens.filter((row) => row.status === 'active')).toHaveLength(0);
  });
});

describe('publicGrant', () => {
  it('fills defaults for a minimal grant', () => {
    const view = publicGrant(grant());
    expect(view).toMatchObject({
      id: 'grant1',
      clientId: 'client1',
      clientName: 'MCP client',
      resource: RESOURCE,
      scopes: [],
      workspaceAccess: 'all_accessible',
      workspaceIds: [],
      pageIds: [],
      databaseIds: [],
      readOnly: false,
      status: 'active',
      expiresAt: null,
      lastUsedAt: null,
    });
  });

  it('reports revoked status and passes scoping straight through', () => {
    const view = publicGrant(grant({
      clientName: 'Claude',
      scopes: ['pages:read'],
      workspaceAccess: 'selected',
      workspaceIds: ['w1'],
      readOnly: true,
      status: 'active',
      revokedAt: '2024-01-01T00:00:00.000Z',
    }));
    expect(view.status).toBe('revoked');
    expect(view.clientName).toBe('Claude');
    expect(view.scopes).toEqual(['pages:read']);
    expect(view.workspaceAccess).toBe('selected');
    expect(view.workspaceIds).toEqual(['w1']);
    expect(view.readOnly).toBe(true);
  });
});

describe('tokens and hashing', () => {
  it('randomToken uses the prefix and base64url characters only', () => {
    const token = randomToken('mcp_test');
    expect(token).toMatch(/^mcp_test_[A-Za-z0-9_-]{40,}$/);
    expect(randomToken('mcp_test')).not.toBe(token);
  });

  it('sha256Base64Url matches known SHA-256 digests', async () => {
    expect(await sha256Base64Url('test')).toBe('n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg');
    expect(await sha256Base64Url('')).toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
  });
});

describe('verifyPkce', () => {
  it('verifies S256 challenges', async () => {
    const verifier = 'some-code-verifier-value';
    const challenge = await sha256Base64Url(verifier);
    expect(await verifyPkce(verifier, challenge, 'S256')).toBe(true);
    expect(await verifyPkce(verifier, challenge, 's256')).toBe(true);
    expect(await verifyPkce('wrong-verifier', challenge, 'S256')).toBe(false);
  });

  it('defaults to S256 when no method is given', async () => {
    const verifier = 'another-verifier';
    const challenge = await sha256Base64Url(verifier);
    expect(await verifyPkce(verifier, challenge, null)).toBe(true);
    expect(await verifyPkce(verifier, challenge, undefined)).toBe(true);
  });

  it('supports plain comparison and rejects unknown methods', async () => {
    expect(await verifyPkce('same-value', 'same-value', 'plain')).toBe(true);
    expect(await verifyPkce('same-value', 'other', 'PLAIN')).toBe(false);
    expect(await verifyPkce('same-value', 'same-value', 'S512')).toBe(false);
  });

  it('rejects empty verifiers or challenges', async () => {
    expect(await verifyPkce('', 'challenge', 'plain')).toBe(false);
    expect(await verifyPkce('verifier', '', 'plain')).toBe(false);
  });
});

describe('signJwt / verifyAccessToken', () => {
  it('round-trips a signed token', async () => {
    const payload = tokenPayload();
    const token = await signJwt(payload as unknown as Record<string, unknown>, ENV);
    expect(token.split('.')).toHaveLength(3);
    const verified = await verifyAccessToken(token, ENV);
    expect(verified).toEqual(payload);
  });

  it('rejects malformed tokens', async () => {
    await expect(verifyAccessToken('not-a-jwt', ENV)).rejects.toThrow('Access token is malformed.');
    await expect(verifyAccessToken('a.b', ENV)).rejects.toThrow('Access token is malformed.');
  });

  it('rejects tampered payloads', async () => {
    const token = await signJwt(tokenPayload() as unknown as Record<string, unknown>, ENV);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify(tokenPayload({ sub: 'attacker' })))
      .toString('base64url');
    await expect(verifyAccessToken(`${header}.${forgedPayload}.${signature}`, ENV)).rejects.toThrow(
      'Access token signature is invalid.',
    );
  });

  it('rejects tokens signed with a different secret', async () => {
    const token = await signJwt(tokenPayload() as unknown as Record<string, unknown>, {
      HANJI_MCP_OAUTH_SECRET: 'other-secret',
      HANJI_APP_ORIGIN: ORIGIN,
    });
    await expect(verifyAccessToken(token, ENV)).rejects.toThrow('Access token signature is invalid.');
  });

  it('rejects unsupported algorithms even with a valid signature', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(tokenPayload())}`;
    const signature = createHmac('sha256', 'topsecret').update(input).digest('base64url');
    await expect(verifyAccessToken(`${input}.${signature}`, ENV)).rejects.toThrow(
      'Access token algorithm is unsupported.',
    );
  });

  it('rejects tokens with incomplete claims', async () => {
    const { sub: _sub, ...withoutSub } = tokenPayload();
    const token = await signJwt(withoutSub as unknown as Record<string, unknown>, ENV);
    await expect(verifyAccessToken(token, ENV)).rejects.toThrow('Access token claims are incomplete.');
  });

  it('rejects expired tokens', async () => {
    const expired = tokenPayload({ exp: Math.floor(Date.now() / 1000) - 10 });
    const token = await signJwt(expired as unknown as Record<string, unknown>, ENV);
    await expect(verifyAccessToken(token, ENV)).rejects.toThrow('Access token is expired.');
  });

  it('rejects tokens whose audience is another resource', async () => {
    const wrongAud = tokenPayload({ aud: 'https://elsewhere.test/api/functions/mcp' });
    const token = await signJwt(wrongAud as unknown as Record<string, unknown>, ENV);
    await expect(verifyAccessToken(token, ENV)).rejects.toThrow('Access token audience is invalid.');
  });

  it('uses a deterministic local development secret only when the dev flag is set', async () => {
    await withEnvCleared([...SECRET_ENV_NAMES, ...ORIGIN_ENV_NAMES], async () => {
      const devEnv = { HANJI_MCP_OAUTH_ALLOW_DEV_SECRET: 'true' };
      const payload = tokenPayload({ iss: 'http://localhost:8787', aud: 'http://localhost:8787/api/functions/mcp' });
      const token = await signJwt(payload as unknown as Record<string, unknown>, devEnv);
      const verified = await verifyAccessToken(token, devEnv);
      expect(verified.sub).toBe('user1');
    });
  });

  it('does not treat the guest-login flag as consent to the forgeable dev secret', async () => {
    // HANJI_ALLOW_DEV_GUEST_LOGIN is a product auth toggle; an operator
    // enabling it must not silently make MCP access tokens forgeable.
    await withEnvCleared([...SECRET_ENV_NAMES, ...ORIGIN_ENV_NAMES], async () => {
      const guestEnv = { HANJI_ALLOW_DEV_GUEST_LOGIN: 'true' };
      await expect(
        signJwt(tokenPayload() as unknown as Record<string, unknown>, guestEnv),
      ).rejects.toThrow('HANJI_MCP_OAUTH_SECRET is required');
    });
  });

  it('fails closed without a secret even for a localhost Host header (Host is untrusted)', async () => {
    await withEnvCleared(SECRET_ENV_NAMES, async () => {
      await expect(
        signJwt(tokenPayload() as unknown as Record<string, unknown>, {}, new Request('http://localhost:8787/api')),
      ).rejects.toThrow('HANJI_MCP_OAUTH_SECRET is required');
    });
  });

  it('requires a configured secret for non-local hosts', async () => {
    await withEnvCleared(SECRET_ENV_NAMES, async () => {
      await expect(
        signJwt(tokenPayload() as unknown as Record<string, unknown>, {}, new Request('https://prod.example.com/api')),
      ).rejects.toThrow('HANJI_MCP_OAUTH_SECRET is required');
    });
  });
});

describe('signed consent requests', () => {
  it('binds the approval payload to the user, client, redirect, resource, PKCE, and scopes', async () => {
    const request = new Request(`${ORIGIN}/api/functions/mcp-oauth-authorize`);
    const token = await signConsentRequest(ENV, request, {
      sub: 'user1',
      clientId: 'client1',
      redirectUri: 'https://client.test/callback',
      state: 'state1',
      resource: RESOURCE,
      requestedScopes: ['pages:read'],
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
    });
    const verified = await verifyConsentRequest(token, ENV, request);
    expect(verified).toMatchObject({
      typ: 'mcp_oauth_consent',
      sub: 'user1',
      clientId: 'client1',
      redirectUri: 'https://client.test/callback',
      state: 'state1',
      resource: RESOURCE,
      requestedScopes: ['pages:read'],
      codeChallenge: 'challenge',
    });
    const [header, , signature] = token.split('.');
    const tampered = `${header}.${Buffer.from(JSON.stringify({ ...verified, clientId: 'attacker' })).toString('base64url')}.${signature}`;
    await expect(verifyConsentRequest(tampered, ENV, request)).rejects.toThrow('signature is invalid');
  });
});

describe('issueAccessToken', () => {
  it('issues an hour-long token bound to the grant', async () => {
    const { accessToken, expiresIn } = await issueAccessToken(ENV, undefined, grant(), ['pages:read', 'workspace:read']);
    expect(expiresIn).toBe(3600);
    const payload = await verifyAccessToken(accessToken, ENV);
    expect(payload.iss).toBe(ORIGIN);
    expect(payload.aud).toBe(RESOURCE);
    expect(payload.sub).toBe('user1');
    expect(payload.grant_id).toBe('grant1');
    expect(payload.client_id).toBe('client1');
    expect(payload.scope).toBe('pages:read workspace:read');
    expect(payload.jti).toMatch(/^mcp_jti_/);
    expect(payload.exp).toBe((payload.iat ?? 0) + 3600);
  });

  it('falls back to the derived resource when the grant has none', async () => {
    const { accessToken } = await issueAccessToken(ENV, undefined, grant({ resource: '' }), ['pages:read']);
    const payload = await verifyAccessToken(accessToken, ENV);
    expect(payload.aud).toBe(RESOURCE);
  });
});

describe('issueRefreshToken', () => {
  it('stores a hashed active refresh token for the grant', async () => {
    const db = fakeDb();
    const { token, expiresAt } = await issueRefreshToken(db, grant(), ['pages:read']);
    expect(token).toMatch(/^mcp_refresh_/);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now() + 170 * 24 * 60 * 60 * 1000);

    const stored = db.tables.mcp_oauth_refresh_tokens;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      grantId: 'grant1',
      userId: 'user1',
      clientId: 'client1',
      scopes: ['pages:read'],
      resource: RESOURCE,
      status: 'active',
      expiresAt,
    });
    expect(stored[0].tokenHash).toBe(await sha256Base64Url(token));
    expect(stored[0].tokenHash).not.toBe(token);
  });
});

describe('bearerToken', () => {
  it('extracts bearer tokens case-insensitively', () => {
    expect(bearerToken(new Request('https://x.test', { headers: { Authorization: 'Bearer abc123' } }))).toBe('abc123');
    expect(bearerToken(new Request('https://x.test', { headers: { Authorization: 'bearer abc123' } }))).toBe('abc123');
  });

  it('returns an empty string for missing or non-bearer headers', () => {
    expect(bearerToken(undefined)).toBe('');
    expect(bearerToken(new Request('https://x.test'))).toBe('');
    expect(bearerToken(new Request('https://x.test', { headers: { Authorization: 'Basic dXNlcg==' } }))).toBe('');
  });
});

describe('authorizationChallenge', () => {
  it('points at the protected resource metadata with the default scopes', () => {
    const challenge = authorizationChallenge({ env: { HANJI_APP_ORIGIN: ORIGIN } });
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/api/functions/mcp-oauth-protected-resource"`);
    expect(challenge).toContain(`scope="${MCP_DEFAULT_SCOPES.join(' ')}"`);
    expect(challenge.startsWith('Bearer ')).toBe(true);
  });

  it('accepts a custom scope string', () => {
    const challenge = authorizationChallenge({ env: { HANJI_APP_ORIGIN: ORIGIN } }, 'pages:read');
    expect(challenge).toContain('scope="pages:read"');
  });
});

describe('validateRedirectUri', () => {
  const client = (redirectUris: string[] | null): McpOAuthClient => ({
    id: 'row1',
    clientId: 'client1',
    redirectUris,
  });

  it('requires a redirect uri', () => {
    expect(() => validateRedirectUri(null, '')).toThrow('redirect_uri is required.');
  });

  it('requires HTTPS except for loopback hosts', () => {
    expect(() => validateRedirectUri(null, 'http://evil.test/cb')).toThrow('redirect_uri must use HTTPS.');
    expect(() => validateRedirectUri(null, 'http://localhost:3000/cb')).not.toThrow();
    expect(() => validateRedirectUri(null, 'http://127.0.0.1:8080/cb')).not.toThrow();
    expect(() => validateRedirectUri(null, 'https://app.test/cb')).not.toThrow();
  });

  it('enforces the registered redirect uri list when present', () => {
    const registered = client(['https://app.test/cb']);
    expect(() => validateRedirectUri(registered, 'https://app.test/cb')).not.toThrow();
    expect(() => validateRedirectUri(registered, 'https://other.test/cb')).toThrow(
      'redirect_uri is not registered for this MCP client.',
    );
  });

  it('allows any valid uri when the client registered none', () => {
    expect(() => validateRedirectUri(client([]), 'https://anything.test/cb')).not.toThrow();
    expect(() => validateRedirectUri(client(null), 'https://anything.test/cb')).not.toThrow();
  });
});

describe('refreshTokenExpired', () => {
  const token = (expiresAt?: string | null): McpOAuthRefreshToken => ({
    id: 't1',
    tokenHash: 'hash',
    grantId: 'grant1',
    userId: 'user1',
    clientId: 'client1',
    resource: RESOURCE,
    expiresAt,
  });

  it('is true only for past expiry timestamps', () => {
    expect(refreshTokenExpired(token(new Date(Date.now() - 1000).toISOString()))).toBe(true);
    expect(refreshTokenExpired(token(new Date(Date.now() + 60_000).toISOString()))).toBe(false);
    expect(refreshTokenExpired(token(null))).toBe(false);
    expect(refreshTokenExpired(token(undefined))).toBe(false);
  });
});
