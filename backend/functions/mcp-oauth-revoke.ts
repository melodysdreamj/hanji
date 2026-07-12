import { defineFunction } from '@edge-base/shared';
import {
  type DbRef,
  type McpOAuthGrant,
  type McpOAuthRefreshToken,
  corsHeaders,
  json,
  nowIso,
  optionsResponse,
  requestBody,
  sha256Base64Url,
  stringValue,
  verifyAccessToken,
} from '../lib/mcp-oauth';

interface FunctionContext {
  request: Request;
  env?: Record<string, unknown>;
  admin: {
    db(namespace: string): DbRef;
  };
}

async function findRefreshToken(db: DbRef, token: string) {
  const hash = await sha256Base64Url(token);
  const result = await db.table<McpOAuthRefreshToken>('mcp_oauth_refresh_tokens')
    .where('tokenHash', '==', hash)
    .page(1)
    .limit(1)
    .getList();
  return result.items?.[0] ?? null;
}

export const OPTIONS = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  return optionsResponse(context.request);
});

export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  const db = context.admin.db('app');
  const body = await requestBody(context.request);
  const token = stringValue(body.token);
  const headers = corsHeaders(context.request);
  if (!token) return json({}, { status: 200, headers });

  const now = nowIso();
  const refresh = await findRefreshToken(db, token);
  if (refresh) {
    await db.table<McpOAuthRefreshToken>('mcp_oauth_refresh_tokens').update(refresh.id, {
      status: 'revoked',
      revokedAt: now,
    });
    // Revocation must fail loudly: returning 200 while the grant stays
    // active would leave a token the caller believes is dead.
    await db.table<McpOAuthGrant>('mcp_oauth_grants').update(refresh.grantId, {
      status: 'revoked',
      revokedAt: now,
    });
    return json({}, { status: 200, headers });
  }

  let grantId: string | null = null;
  try {
    const access = await verifyAccessToken(token, context.env, context.request);
    grantId = access.grant_id;
  } catch {
    // RFC 7009 style: do not reveal whether a token existed.
  }
  if (grantId) {
    // Outside the verify try/catch so a storage failure surfaces instead of
    // being mistaken for an invalid token.
    await db.table<McpOAuthGrant>('mcp_oauth_grants').update(grantId, {
      status: 'revoked',
      revokedAt: now,
    });
  }
  return json({}, { status: 200, headers });
});
