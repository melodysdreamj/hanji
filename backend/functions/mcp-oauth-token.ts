import { defineFunction } from '@edge-base/shared';
import {
  type DbRef,
  type McpOAuthAuthorizationCode,
  type McpOAuthGrant,
  type McpOAuthRefreshToken,
  corsHeaders,
  findClient,
  grantAccessibleWorkspaces,
  grantIsActive,
  issueAccessToken,
  json,
  jsonError,
  nowIso,
  optionsResponse,
  prepareRefreshToken,
  refreshTokenExpired,
  requestBody,
  revokeMcpGrantFamily,
  sha256Base64Url,
  stringValue,
  validateRedirectUri,
  verifyPkce,
} from '../lib/mcp-oauth';

interface FunctionContext {
  request: Request;
  env?: Record<string, unknown>;
  admin: {
    db(namespace: string): DbRef;
  };
}

async function findByHash<T extends object>(
  db: DbRef,
  table: string,
  field: string,
  hash: string,
) {
  const result = await db.table<T>(table).where(field, '==', hash).page(1).limit(1).getList();
  return result.items?.[0] ?? null;
}

function tokenJson(request: Request, data: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  return json(data, { status, headers });
}

async function authorizationCodeGrant(context: FunctionContext, body: Record<string, unknown>) {
  const db = context.admin.db('app');
  const code = stringValue(body.code);
  const clientId = stringValue(body.client_id);
  const redirectUri = stringValue(body.redirect_uri);
  const verifier = stringValue(body.code_verifier);
  if (!code || !clientId || !redirectUri || !verifier) {
    return jsonError(400, 'invalid_request', 'code, client_id, redirect_uri, and code_verifier are required.', corsHeaders(context.request));
  }

  const client = await findClient(db, clientId);
  // Validate even when the client row is missing (a CIMD client that never
  // completed registration): the structural rules (HTTPS-or-localhost) must
  // hold regardless, and the codeRow.redirectUri equality below then pins the
  // exact value the code was issued for.
  validateRedirectUri(client, redirectUri);
  const codeRow = await findByHash<McpOAuthAuthorizationCode>(
    db,
    'mcp_oauth_authorization_codes',
    'codeHash',
    await sha256Base64Url(code),
  );
  if (!codeRow || codeRow.clientId !== clientId || codeRow.redirectUri !== redirectUri || codeRow.consumedAt) {
    return jsonError(400, 'invalid_grant', 'Authorization code is invalid.', corsHeaders(context.request));
  }
  if (Date.parse(codeRow.expiresAt) <= Date.now()) {
    return jsonError(400, 'invalid_grant', 'Authorization code has expired.', corsHeaders(context.request));
  }
  if (!(await verifyPkce(verifier, codeRow.codeChallenge, codeRow.codeChallengeMethod))) {
    return jsonError(400, 'invalid_grant', 'PKCE verifier is invalid.', corsHeaders(context.request));
  }
  const grant = await db.table<McpOAuthGrant>('mcp_oauth_grants').getOne(codeRow.grantId);
  if (!grantIsActive(grant)) {
    return jsonError(400, 'invalid_grant', 'MCP grant is no longer active.', corsHeaders(context.request));
  }
  if ((await grantAccessibleWorkspaces(db, grant!)).length === 0) {
    await revokeMcpGrantFamily(db, grant!.id, 'system:workspace-access-lost').catch((error) => {
      console.error('[mcp-oauth-token] failed to revoke inaccessible grant:', error);
    });
    return jsonError(400, 'invalid_grant', 'MCP grant no longer has workspace access.', corsHeaders(context.request));
  }
  const scopes = codeRow.scopes ?? grant?.scopes ?? [];
  const now = nowIso();
  // Prepare every response credential before consuming the one-shot code. A
  // missing signing secret or crypto failure must leave the authorization code
  // retryable rather than burning it without delivering any token.
  const access = await issueAccessToken(context.env, context.request, grant!, scopes);
  const refresh = await prepareRefreshToken(grant!, scopes);
  // Single-use enforcement is a check-then-write race: the codeRow.consumedAt
  // read above is only advisory. Consume the code, persist the prepared refresh
  // token, and touch the still-active grant in one transaction so a committed
  // redemption always has a deliverable response ready.
  try {
    await db.transact([
      {
        table: 'mcp_oauth_grants',
        op: 'expect',
        where: [
          ['id', '==', grant!.id],
          ['status', '==', 'active'],
        ],
        exists: true,
      },
      {
        table: 'mcp_oauth_authorization_codes',
        op: 'expect',
        where: [
          ['id', '==', codeRow.id],
          ['consumedAt', '==', null],
        ],
        exists: true,
      },
      {
        table: 'mcp_oauth_authorization_codes',
        op: 'update',
        id: codeRow.id,
        data: { consumedAt: now },
      },
      {
        table: 'mcp_oauth_refresh_tokens',
        op: 'insert',
        data: refresh.data as Record<string, unknown>,
      },
      {
        table: 'mcp_oauth_grants',
        op: 'update',
        id: codeRow.grantId,
        data: { lastUsedAt: now },
      },
    ]);
  } catch {
    return jsonError(400, 'invalid_grant', 'Authorization code is invalid.', corsHeaders(context.request));
  }

  return tokenJson(context.request, {
    access_token: access.accessToken,
    token_type: 'Bearer',
    expires_in: access.expiresIn,
    refresh_token: refresh.token,
    scope: scopes.join(' '),
  });
}

async function refreshTokenGrant(context: FunctionContext, body: Record<string, unknown>) {
  const db = context.admin.db('app');
  const refreshToken = stringValue(body.refresh_token);
  const clientId = stringValue(body.client_id);
  if (!refreshToken) {
    return jsonError(400, 'invalid_request', 'refresh_token is required.', corsHeaders(context.request));
  }
  const invalidGrant = () =>
    jsonError(400, 'invalid_grant', 'Refresh token is invalid.', corsHeaders(context.request));
  const tokenRow = await findByHash<McpOAuthRefreshToken>(
    db,
    'mcp_oauth_refresh_tokens',
    'tokenHash',
    await sha256Base64Url(refreshToken),
  );
  if (!tokenRow) return invalidGrant();
  // Public clients are not authenticated, but when a client_id accompanies
  // the request it must match the client the token was issued to.
  if (clientId && tokenRow.clientId !== clientId) return invalidGrant();
  const now = nowIso();
  // A rotated token presented again is a replay: either a stolen copy or a
  // client that lost the rotation response. Both mean the token family can no
  // longer be trusted, so revoke the grant's remaining refresh tokens.
  if ((tokenRow.status ?? 'active') === 'rotated') {
    await revokeMcpGrantFamily(db, tokenRow.grantId, 'system:refresh-token-reuse', now);
    return invalidGrant();
  }
  if ((tokenRow.status ?? 'active') !== 'active' || tokenRow.revokedAt || refreshTokenExpired(tokenRow)) {
    return invalidGrant();
  }
  const grant = await db.table<McpOAuthGrant>('mcp_oauth_grants').getOne(tokenRow.grantId);
  if (!grantIsActive(grant)) {
    return jsonError(400, 'invalid_grant', 'MCP grant is no longer active.', corsHeaders(context.request));
  }
  if ((await grantAccessibleWorkspaces(db, grant!)).length === 0) {
    await revokeMcpGrantFamily(db, grant!.id, 'system:workspace-access-lost', now).catch((error) => {
      console.error('[mcp-oauth-token] failed to revoke inaccessible grant:', error);
    });
    return invalidGrant();
  }
  const scopes = tokenRow.scopes ?? grant?.scopes ?? [];
  // Sign first. Rotation is irreversible and replay revokes the whole family,
  // so a transient signing/configuration error must not consume the client's
  // only live refresh credential.
  const access = await issueAccessToken(context.env, context.request, grant!, scopes);
  // Rotate on every use: atomically retire the presented token — expect it
  // still live at commit so two concurrent uses cannot both mint — then issue
  // a successor. The one-shot advisory read above is not enough on its own.
  const successor = await prepareRefreshToken(grant!, scopes);
  try {
    await db.transact([
      {
        table: 'mcp_oauth_grants',
        op: 'expect',
        where: [
          ['id', '==', grant!.id],
          ['status', '==', 'active'],
        ],
        exists: true,
      },
      {
        table: 'mcp_oauth_refresh_tokens',
        op: 'expect',
        where: [
          ['id', '==', tokenRow.id],
          // issueRefreshToken always writes status:'active'; rotation and
          // revocation both move it off 'active', so this is the liveness bit.
          ['status', '==', 'active'],
        ],
        exists: true,
      },
      {
        table: 'mcp_oauth_refresh_tokens',
        op: 'update',
        id: tokenRow.id,
        data: { status: 'rotated', revokedAt: now, lastUsedAt: now },
      },
      {
        table: 'mcp_oauth_refresh_tokens',
        op: 'insert',
        data: successor.data as Record<string, unknown>,
      },
      {
        table: 'mcp_oauth_grants',
        op: 'update',
        id: tokenRow.grantId,
        data: { lastUsedAt: now },
      },
    ]);
  } catch {
    // A failed liveness expectation means another request won the rotation.
    // That is refresh-token reuse: revoke the grant and the winner's successor
    // atomically so the race cannot leave an attacker-controlled token alive.
    await revokeMcpGrantFamily(db, tokenRow.grantId, 'system:refresh-token-reuse', now).catch((error) => {
      console.error('[mcp-oauth-token] failed to revoke raced refresh-token family:', error);
    });
    return invalidGrant();
  }
  const currentGrant = await db.table<McpOAuthGrant>('mcp_oauth_grants').getOne(tokenRow.grantId);
  if (!grantIsActive(currentGrant)) return invalidGrant();
  return tokenJson(context.request, {
    access_token: access.accessToken,
    token_type: 'Bearer',
    expires_in: access.expiresIn,
    refresh_token: successor.token,
    scope: scopes.join(' '),
  });
}

export const OPTIONS = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  return optionsResponse(context.request);
});

export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  const body = await requestBody(context.request);
  const grantType = stringValue(body.grant_type);
  try {
    if (grantType === 'authorization_code') return await authorizationCodeGrant(context, body);
    if (grantType === 'refresh_token') return await refreshTokenGrant(context, body);
    return jsonError(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.', corsHeaders(context.request));
  } catch (error) {
    return jsonError(
      400,
      'invalid_request',
      error instanceof Error ? error.message : String(error),
      corsHeaders(context.request),
    );
  }
});
