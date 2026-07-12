import { defineFunction } from '@edge-base/shared';
import { rateLimiting } from '../config/rate-limits';
import {
  type DbRef,
  type McpOAuthClient,
  endpointUrls,
  envValue,
  json,
  jsonError,
  mcpOAuthClientIsActive,
  nowIso,
  optionsResponse,
  randomToken,
  requestBody,
  validateMcpClientMetadata,
} from '../lib/mcp-oauth';

interface FunctionContext {
  request: Request;
  env?: Record<string, unknown>;
  admin: {
    db(namespace: string): DbRef;
  };
}

function parseWindowMs(window: string): number {
  const match = /^(\d+)\s*([smh]?)$/.exec(window.trim());
  if (!match) return 60_000;
  const value = Number(match[1]);
  const unit = match[2] || 's';
  const multiplier = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000;
  return value * multiplier;
}

// In-isolate fixed-window per-IP limiter for anonymous Dynamic Client
// Registration. DCR must stay unauthenticated (RFC 7591), so abuse is bounded
// by a tight window instead. Mirrors the runtime's in-isolate counter; the
// platform's per-IP functions limiter remains the cross-isolate ceiling.
const REGISTER_WINDOW_MS = parseWindowMs(rateLimiting.mcpRegister.window);
const REGISTER_MAX = rateLimiting.mcpRegister.requests;
const registerHits = new Map<string, { count: number; resetAt: number }>();

function trustsForwardedHeaders(env?: Record<string, unknown>) {
  const value = envValue(env, 'HANJI_MCP_TRUST_PROXY_HEADERS')?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function registrationRateLimitKey(request: Request, env?: Record<string, unknown>): string {
  const cloudflareRequest = request as Request & { cf?: unknown };
  const isCloudflareRequest = !!cloudflareRequest.cf && typeof cloudflareRequest.cf === 'object';
  const mayTrustHeaders = isCloudflareRequest || trustsForwardedHeaders(env);
  if (!mayTrustHeaders) return 'direct:untrusted';
  const address = (
    request.headers.get('CF-Connecting-IP')?.trim() ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  ).slice(0, 128);
  return `${isCloudflareRequest ? 'cloudflare' : 'proxy'}:${address}`;
}

function registrationRateLimited(request: Request, env?: Record<string, unknown>): boolean {
  const now = Date.now();
  // Opportunistic cleanup so the map cannot grow without bound under IP churn.
  if (registerHits.size > 5_000) {
    for (const [key, entry] of registerHits) {
      if (now >= entry.resetAt) registerHits.delete(key);
    }
  }
  const key = registrationRateLimitKey(request, env);
  const entry = registerHits.get(key);
  if (!entry || now >= entry.resetAt) {
    registerHits.set(key, { count: 1, resetAt: now + REGISTER_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > REGISTER_MAX;
}

function safeUri(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function pruneStaleDynamicClients(db: DbRef) {
  const table = db.table<McpOAuthClient>('mcp_oauth_clients');
  const result = await table.where('status', '==', 'active').page(1).limit(100).getList();
  for (const client of result.items ?? []) {
    if (mcpOAuthClientIsActive(client)) continue;
    await table.delete(client.id);
  }
}

export const OPTIONS = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  return optionsResponse(context.request);
});

export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  if (registrationRateLimited(context.request, context.env)) {
    return jsonError(429, 'too_many_requests', 'Too many client registration attempts. Please retry later.');
  }
  const db = context.admin.db('app');
  const body = await requestBody(context.request);
  let metadata: ReturnType<typeof validateMcpClientMetadata>;
  try {
    metadata = validateMcpClientMetadata(body);
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    const code = description.startsWith('redirect_uri') ? 'invalid_redirect_uri' : 'invalid_client_metadata';
    return jsonError(400, code, description);
  }

  const now = nowIso();
  const clientId = randomToken('mcp_client');
  await pruneStaleDynamicClients(db).catch((error) => {
    console.error('[mcp-oauth-register] stale client pruning failed:', error);
  });

  const client = await db.table<McpOAuthClient>('mcp_oauth_clients').insert({
    clientId,
    clientName: metadata.clientName,
    redirectUris: metadata.redirectUris,
    grantTypes: metadata.grantTypes,
    responseTypes: metadata.responseTypes,
    tokenEndpointAuthMethod: metadata.tokenEndpointAuthMethod,
    clientUri: safeUri(body.client_uri),
    logoUri: safeUri(body.logo_uri),
    status: 'active',
    lastUsedAt: now,
  });
  const urls = endpointUrls(context);

  return json(
    {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris ?? metadata.redirectUris,
      grant_types: client.grantTypes ?? ['authorization_code', 'refresh_token'],
      response_types: client.responseTypes ?? ['code'],
      token_endpoint_auth_method: client.tokenEndpointAuthMethod ?? 'none',
      client_id_issued_at: Math.floor(Date.parse(client.createdAt ?? now) / 1000),
      scope: '',
      registration_client_uri: urls.registration,
    },
    { status: 201 },
  );
});
