import { defineFunction } from '@edge-base/shared';
import { rateLimiting } from '../config/rate-limits';
import {
  type DbRef,
  type McpOAuthClient,
  endpointUrls,
  json,
  jsonError,
  nowIso,
  optionsResponse,
  randomToken,
  requestBody,
  stringList,
  stringValue,
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

function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP')?.trim() ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function registrationRateLimited(request: Request): boolean {
  const now = Date.now();
  // Opportunistic cleanup so the map cannot grow without bound under IP churn.
  if (registerHits.size > 5_000) {
    for (const [key, entry] of registerHits) {
      if (now >= entry.resetAt) registerHits.delete(key);
    }
  }
  const ip = clientIp(request);
  const entry = registerHits.get(ip);
  if (!entry || now >= entry.resetAt) {
    registerHits.set(ip, { count: 1, resetAt: now + REGISTER_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > REGISTER_MAX;
}

function safeUri(value: unknown) {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export const OPTIONS = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  return optionsResponse(context.request);
});

export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  if (registrationRateLimited(context.request)) {
    return jsonError(429, 'too_many_requests', 'Too many client registration attempts. Please retry later.');
  }
  const db = context.admin.db('app');
  const body = await requestBody(context.request);
  const redirectUris = stringList(body.redirect_uris);
  if (!redirectUris.length) return jsonError(400, 'invalid_client_metadata', 'redirect_uris is required.');
  for (const redirectUri of redirectUris) {
    try {
      const parsed = new URL(redirectUri);
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        return jsonError(400, 'invalid_redirect_uri', 'redirect_uris must use HTTPS.');
      }
    } catch {
      return jsonError(400, 'invalid_redirect_uri', 'redirect_uris contains an invalid URL.');
    }
  }

  const now = nowIso();
  const clientId = randomToken('mcp_client');
  const clientName =
    stringValue(body.client_name) ||
    stringValue(body.clientName) ||
    'MCP client';
  const grantTypes = stringList(body.grant_types);
  const responseTypes = stringList(body.response_types);
  const tokenEndpointAuthMethod =
    stringValue(body.token_endpoint_auth_method) ||
    stringValue(body.tokenEndpointAuthMethod) ||
    'none';

  const client = await db.table<McpOAuthClient>('mcp_oauth_clients').insert({
    clientId,
    clientName,
    redirectUris,
    grantTypes: grantTypes.length ? grantTypes : ['authorization_code', 'refresh_token'],
    responseTypes: responseTypes.length ? responseTypes : ['code'],
    tokenEndpointAuthMethod,
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
      redirect_uris: client.redirectUris ?? redirectUris,
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
