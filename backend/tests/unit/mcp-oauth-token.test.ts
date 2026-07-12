import { describe, expect, it } from 'vitest';

import { POST } from '../../functions/mcp-oauth-token';
import { sha256Base64Url } from '../../lib/mcp-oauth';
import { fakeDb, type FakeDb, type Row } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

const REFRESH_TOKEN = 'mcp_refresh_unit-test-token';
const AUTHORIZATION_CODE = 'mcp_code_unit-test-code';
const CODE_VERIFIER = 'unit-test-pkce-verifier-with-sufficient-entropy-1234567890';
const ENV = { HANJI_MCP_OAUTH_SECRET: 'unit-test-secret' };

function grantRow(extra: Partial<Row> = {}): Row {
  return {
    id: 'g1',
    userId: 'u1',
    clientId: 'client-1',
    clientName: 'Unit client',
    resource: 'http://localhost:8787/api/functions/mcp',
    scopes: ['pages:read'],
    status: 'active',
    ...extra,
  };
}

async function refreshTokenRow(extra: Partial<Row> = {}): Promise<Row> {
  return {
    id: 'rt1',
    tokenHash: await sha256Base64Url(REFRESH_TOKEN),
    grantId: 'g1',
    userId: 'u1',
    clientId: 'client-1',
    scopes: ['pages:read'],
    resource: 'http://localhost:8787/api/functions/mcp',
    status: 'active',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...extra,
  };
}

async function callToken(
  db: FakeDb,
  body: Record<string, unknown>,
  env: Record<string, unknown> = ENV,
) {
  const request = new Request('http://localhost:8787/api/functions/mcp-oauth-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await handlerOf(POST)({ request, env, admin: { db: () => db } });
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  return { response, payload: (await response.json()) as Record<string, unknown> };
}

function refreshBody(extra: Record<string, unknown> = {}) {
  return { grant_type: 'refresh_token', refresh_token: REFRESH_TOKEN, ...extra };
}

function activeWorkspaceRows(): Row[] {
  return [{ id: 'w1', ownerId: 'u1', name: 'Workspace' }];
}

describe('mcp-oauth-token refresh_token grant', () => {
  it('rotates the refresh token on use', async () => {
    const db = fakeDb({
      mcp_oauth_grants: [grantRow()],
      mcp_oauth_refresh_tokens: [await refreshTokenRow()],
      workspaces: activeWorkspaceRows(),
    });
    const { response, payload } = await callToken(db, refreshBody());
    expect(response.status).toBe(200);
    expect(typeof payload.access_token).toBe('string');
    // A new refresh token is issued and the presented one is retired.
    expect(typeof payload.refresh_token).toBe('string');
    expect(payload.refresh_token).not.toBe(REFRESH_TOKEN);
    const rows = db.tables.mcp_oauth_refresh_tokens;
    expect(rows).toHaveLength(2);
    const presented = rows.find((row) => row.id === 'rt1');
    expect(presented?.status).toBe('rotated');
    expect(presented?.revokedAt).toBeTruthy();
    const successor = rows.find((row) => row.id !== 'rt1');
    expect(successor?.status).toBe('active');
    expect(successor?.tokenHash).toBe(await sha256Base64Url(payload.refresh_token as string));
  });

  it('rejects a replayed rotated token and revokes the remaining family', async () => {
    const db = fakeDb({
      mcp_oauth_grants: [grantRow()],
      mcp_oauth_refresh_tokens: [await refreshTokenRow()],
      workspaces: activeWorkspaceRows(),
    });
    const first = await callToken(db, refreshBody());
    expect(first.response.status).toBe(200);

    // Replay the original (now rotated) token: must fail and kill the successor.
    const replay = await callToken(db, refreshBody());
    expect(replay.response.status).toBe(400);
    expect(replay.payload.error).toBe('invalid_grant');
    const successor = db.tables.mcp_oauth_refresh_tokens.find((row) => row.id !== 'rt1');
    expect(successor?.status).toBe('revoked');
    expect(successor?.revokedBy).toBe('system:refresh-token-reuse');
    expect(db.tables.mcp_oauth_grants[0].status).toBe('revoked');

    // The revoked successor no longer works either.
    const successorAttempt = await callToken(
      db,
      refreshBody({ refresh_token: first.payload.refresh_token }),
    );
    expect(successorAttempt.response.status).toBe(400);
  });

  it('rejects a client_id that does not match the token', async () => {
    const db = fakeDb({
      mcp_oauth_grants: [grantRow()],
      mcp_oauth_refresh_tokens: [await refreshTokenRow()],
      workspaces: activeWorkspaceRows(),
    });
    const { response, payload } = await callToken(db, refreshBody({ client_id: 'other-client' }));
    expect(response.status).toBe(400);
    expect(payload.error).toBe('invalid_grant');
    // The mismatch must not consume the token.
    expect(db.tables.mcp_oauth_refresh_tokens[0].status).toBe('active');
  });

  it('rejects revoked and expired tokens without rotating', async () => {
    const revoked = await refreshTokenRow({ revokedAt: '2026-01-01T00:00:00.000Z' });
    const dbRevoked = fakeDb({
      mcp_oauth_grants: [grantRow()],
      mcp_oauth_refresh_tokens: [revoked],
      workspaces: activeWorkspaceRows(),
    });
    expect((await callToken(dbRevoked, refreshBody())).response.status).toBe(400);

    const expired = await refreshTokenRow({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const dbExpired = fakeDb({
      mcp_oauth_grants: [grantRow()],
      mcp_oauth_refresh_tokens: [expired],
      workspaces: activeWorkspaceRows(),
    });
    expect((await callToken(dbExpired, refreshBody())).response.status).toBe(400);
    expect(dbExpired.tables.mcp_oauth_refresh_tokens).toHaveLength(1);
  });

  it('revokes the winner successor and grant when the same token is rotated concurrently', async () => {
    const db = fakeDb({
      mcp_oauth_grants: [grantRow()],
      mcp_oauth_refresh_tokens: [await refreshTokenRow()],
      workspaces: activeWorkspaceRows(),
    });
    const originalTransact = db.transact.bind(db);
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    db.transact = async (operations) => {
      const rotationAttempt = operations.some(
        (operation) => operation.op === 'expect' && operation.table === 'mcp_oauth_refresh_tokens',
      );
      if (rotationAttempt) {
        arrivals += 1;
        if (arrivals === 2) release();
        else await gate;
      }
      return originalTransact(operations);
    };

    const results = await Promise.all([
      callToken(db, refreshBody()),
      callToken(db, refreshBody()),
    ]);
    expect(results.map((result) => result.response.status).every((status) => status === 200 || status === 400)).toBe(true);
    expect(results.some((result) => result.response.status === 400)).toBe(true);
    expect(db.tables.mcp_oauth_grants[0]).toMatchObject({
      status: 'revoked',
      revokedBy: 'system:refresh-token-reuse',
    });
    expect(db.tables.mcp_oauth_refresh_tokens.filter((row) => row.status === 'active')).toHaveLength(0);
    const successor = db.tables.mcp_oauth_refresh_tokens.find((row) => row.id !== 'rt1');
    expect(successor).toMatchObject({
      status: 'revoked',
      revokedBy: 'system:refresh-token-reuse',
    });
  });

  it('revokes refresh access after organization membership is deactivated', async () => {
    const db = fakeDb({
      mcp_oauth_grants: [grantRow({ workspaceAccess: 'selected', workspaceIds: ['w1'] })],
      mcp_oauth_refresh_tokens: [await refreshTokenRow()],
      organizations: [{ id: 'org1', ownerId: 'another-owner' }],
      organization_members: [{
        id: 'om1',
        organizationId: 'org1',
        userId: 'u1',
        status: 'deactivated',
      }],
      workspaces: [{ id: 'w1', ownerId: 'u1', organizationId: 'org1' }],
      workspace_members: [{ id: 'wm1', workspaceId: 'w1', userId: 'u1', role: 'owner' }],
    });
    const result = await callToken(db, refreshBody());
    expect(result.response.status).toBe(400);
    expect(result.payload.error).toBe('invalid_grant');
    expect(db.tables.mcp_oauth_grants[0]).toMatchObject({
      status: 'revoked',
      revokedBy: 'system:workspace-access-lost',
    });
    expect(db.tables.mcp_oauth_refresh_tokens[0]).toMatchObject({
      status: 'revoked',
      revokedBy: 'system:workspace-access-lost',
    });
  });

  it('does not rotate a refresh token when access-token signing fails', async () => {
    const db = fakeDb({
      mcp_oauth_grants: [grantRow()],
      mcp_oauth_refresh_tokens: [await refreshTokenRow()],
      workspaces: activeWorkspaceRows(),
    });

    const failed = await callToken(db, refreshBody(), {});
    expect(failed.response.status).toBe(400);
    expect(failed.payload.error).toBe('invalid_request');
    expect(db.tables.mcp_oauth_refresh_tokens).toHaveLength(1);
    expect(db.tables.mcp_oauth_refresh_tokens[0].status).toBe('active');

    const retried = await callToken(db, refreshBody());
    expect(retried.response.status).toBe(200);
  });
});

describe('mcp-oauth-token authorization_code grant', () => {
  it('enforces structural redirect-URI rules even when the client row is missing', async () => {
    const db = fakeDb();
    const request = new Request('http://localhost:8787/api/functions/mcp-oauth-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: 'some-code',
        client_id: 'https://unregistered.example/client',
        redirect_uri: 'http://evil.example/callback',
        code_verifier: 'verifier',
      }),
    });
    const result = await handlerOf(POST)({ request, env: ENV, admin: { db: () => db } });
    const response = result as Response;
    expect(response.status).toBe(400);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(String(payload.error_description)).toContain('redirect_uri must use HTTPS');
  });

  it('does not consume the code when token signing fails and permits a safe retry', async () => {
    const redirectUri = 'http://localhost:4567/callback';
    const codeRow: Row = {
      id: 'code-1',
      codeHash: await sha256Base64Url(AUTHORIZATION_CODE),
      grantId: 'g1',
      userId: 'u1',
      clientId: 'client-1',
      redirectUri,
      codeChallenge: await sha256Base64Url(CODE_VERIFIER),
      codeChallengeMethod: 'S256',
      scopes: ['pages:read'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumedAt: null,
    };
    const db = fakeDb({
      mcp_oauth_authorization_codes: [codeRow],
      mcp_oauth_grants: [grantRow()],
      mcp_oauth_refresh_tokens: [],
      workspaces: activeWorkspaceRows(),
    });
    const body = {
      grant_type: 'authorization_code',
      code: AUTHORIZATION_CODE,
      client_id: 'client-1',
      redirect_uri: redirectUri,
      code_verifier: CODE_VERIFIER,
    };

    const failed = await callToken(db, body, {});
    expect(failed.response.status).toBe(400);
    expect(failed.payload.error).toBe('invalid_request');
    expect(db.tables.mcp_oauth_authorization_codes[0].consumedAt).toBeNull();
    expect(db.tables.mcp_oauth_refresh_tokens).toHaveLength(0);

    const retried = await callToken(db, body);
    expect(retried.response.status).toBe(200);
    expect(db.tables.mcp_oauth_authorization_codes[0].consumedAt).toBeTruthy();
    expect(db.tables.mcp_oauth_refresh_tokens).toHaveLength(1);
  });
});
